# 10 · Materialized Views

> **In one line:** Materialized views let the server maintain a second, differently-keyed copy of a table for you — and they have been officially flagged experimental since 3.11 because that maintenance can silently drift out of sync with the base table.

---

## 1. Overview

Query-first modeling tells you to build one table per access pattern and to write to all of them yourself. That is correct, but it is tedious and it puts correctness in application code that every team writes slightly differently. Materialized views (MVs), introduced in **Cassandra 3.0** via CASSANDRA-6477, were the project's attempt to move that work into the database: you declare `CREATE MATERIALIZED VIEW orders_by_status AS SELECT ... FROM orders_by_user PRIMARY KEY ((status), user_id, created_at)`, and from then on every write to the base table automatically produces the corresponding write to the view. One statement replaces a fan-out write path.

The appeal is obvious and the mechanism is genuinely clever. Cassandra guarantees that a view row is derived from exactly one base row, and it enforces that by requiring the view's primary key to contain **all** of the base table's primary key columns plus **at most one** additional non-key column. That restriction is not arbitrary — it is what makes the view row uniquely identifiable and therefore repairable. It also means MVs can only re-key a table, never aggregate, join, or filter arbitrarily.

The problem is what happens on the write path. To update a view correctly, a replica must know what the base row looked like *before* the write, because changing an indexed column means deleting the old view row and inserting a new one. So every base write becomes a **local read-before-write**, and the resulting view update is sent to the view replica with a **batchlog entry** and a per-view **lock on the base partition key** to serialize concurrent updates. This is why MV writes are typically 2–10× more expensive than plain writes, why they add a second failure domain, and — crucially — why a dropped view mutation after a replica failure can leave the view permanently inconsistent with no automatic repair that fixes it. `nodetool repair` on the base table does not reconcile the view.

That is the reason the project added an explicit warning in **3.11** (CASSANDRA-13959): MVs are marked experimental, and since **4.0** they are disabled by default behind `materialized_views_enabled: false` in `cassandra.yaml`. They still ship, they still work, and several large deployments use them successfully — but the project will not promise eventual consistency between base and view under all failure scenarios, and there is a long tail of open JIRAs (CASSANDRA-13810, CASSANDRA-10346 and others) documenting divergence.

The honest production posture: use an MV when the view is *derivable, low-cardinality-safe, and non-critical* — a convenience index over reference data, an ops-facing lookup where a rare missing row is tolerable, or a system small enough that you can rebuild the view from scratch cheaply. For anything user-facing or financially relevant, write the second table yourself. Discord, Netflix and Uber-scale systems overwhelmingly do the latter: application-managed denormalization is more code but it is code you can reason about, retry, and reconcile.

---

## 2. Core Concepts

- **Base table** — the source of truth. Every view row is derived from exactly one base row; views cannot be written to directly.
- **Materialized view** — a server-maintained table defined by `CREATE MATERIALIZED VIEW ... AS SELECT ... FROM base ... PRIMARY KEY (...)`, automatically updated on every base write.
- **View primary key rule** — the view's primary key must contain every base primary key column, plus **at most one** non-primary-key base column, and no column in the view key may be `null`.
- **`WHERE ... IS NOT NULL`** — the mandatory clause asserting that every column in the view's key is non-null in the base row; rows failing it simply do not appear in the view.
- **Read-before-write** — the local read a replica performs to discover the previous base row state so it can issue the correct view deletion plus insertion.
- **View update batchlog** — the batchlog entry written before dispatching view mutations, so a coordinator crash does not lose them. Adds a durable write to the path.
- **Base-partition lock** — a per-replica lock on the base partition key held while computing view updates, serializing concurrent writes to the same partition.
- **View tombstone (shadowable deletion)** — the special deletion written to the view when the value that keys the view row changes, removing the stale view row.
- **`materialized_views_enabled`** — the `cassandra.yaml` flag, **`false` by default since 4.0**, that must be set to `true` before `CREATE MATERIALIZED VIEW` is accepted.
- **View build** — the asynchronous background task that populates a new view from existing base data, tracked in `system.view_builds_in_progress` / `system.built_views`.

---

## 3. Theory & Internals

### Why the primary key rule exists

A view row must map back to exactly one base row, otherwise a base deletion could not know which view rows to remove. Formally, if the base primary key is `PK_b` and the view primary key is `PK_v`, Cassandra requires `PK_b ⊆ PK_v` and `|PK_v \ PK_b| ≤ 1`. Including all base key columns guarantees uniqueness; allowing at most one extra column bounds the work of a base update to *one* stale view row to delete plus *one* new row to insert. If two non-key columns were allowed, a single base write could invalidate an unbounded set of view rows and the delete could not be computed from local state alone.

### The write path cost

For a plain table write, a replica appends to the commit log and inserts into the memtable — no reads at all. With one MV attached, the replica must:

1. Acquire a lock on the base partition key (`ViewManager` keeps a striped lock array).
2. **Read** the affected base row(s) from memtable + SSTables to learn the current value of the view-key column.
3. Compute the view mutations: if the view-key column changed, a shadowable tombstone for the old view row plus an insert for the new one; otherwise a plain update.
4. Write a **batchlog** entry containing those view mutations.
5. Dispatch the view mutations to the *paired view replica* — the replica of the view partition that occupies the same ring position, so pairing is deterministic.
6. Wait for acknowledgement according to the base write's consistency level, then remove the batchlog entry.

Steps 1–2 alone typically triple write latency; the batchlog adds a durable write and the pairing adds a network hop. Empirically, `LOCAL_QUORUM` write p99 on a table with one MV runs **2–5×** the same table without it, and each additional view compounds.

### Where consistency can break

The guarantee Cassandra offers is: *if the base write succeeds and the view mutation is eventually delivered, the view converges*. The failure modes are the gaps in that sentence.

- **Lost view mutation.** If the paired view replica is down beyond the hint window (`max_hint_window`, default 3 h) and the batchlog replay also fails or expires, the view row is simply never written. Base repair will not fix it, because base repair compares base data only.
- **Concurrent updates to different columns.** Two writers updating different columns of the same base row can, under specific interleavings and timestamp ties, produce a view row that reflects neither writer's complete state (CASSANDRA-13810).
- **Base data written with client timestamps out of order.** MV update computation uses the read state at apply time; an out-of-order timestamp can cause the shadowable tombstone and the insert to be ordered incorrectly, leaving an orphan view row.
- **Unrepairable divergence.** The only reliable remedy is `nodetool rebuild_view` (or dropping and recreating the view), which re-derives the entire view from base data — an expensive, cluster-wide operation.

### Cardinality is still your problem

The MV's partition key is chosen by you, so all the usual rules apply. `PRIMARY KEY ((status), user_id, created_at)` over a table with five statuses creates **five partitions** holding the entire dataset — a textbook unbounded-partition hotspot, now maintained automatically and invisibly. MVs do not protect you from bad key design; they make it easier to commit.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="340" fill="#ffffff"/>
  <text x="20" y="24" font-size="15" font-weight="700" fill="#1e293b">MV write path: the read-before-write and the paired view replica</text>
  <rect x="20" y="40" width="150" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="32" y="60" font-size="12" font-weight="700" fill="#1e293b">client write</text>
  <text x="32" y="78" font-size="11" fill="#1e293b">UPDATE orders</text>
  <text x="32" y="94" font-size="11" fill="#1e293b">SET status='PAID'</text>
  <path d="M172 70 L 196 70" stroke="#4f46e5" stroke-width="2"/>
  <rect x="200" y="40" width="170" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="212" y="60" font-size="12" font-weight="700" fill="#1e293b">base replica</text>
  <text x="212" y="78" font-size="11" fill="#1e293b">1. lock base partition</text>
  <text x="212" y="94" font-size="11" fill="#1e293b">2. READ current row</text>
  <path d="M372 70 L 396 70" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="400" y="40" width="170" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="412" y="60" font-size="12" font-weight="700" fill="#1e293b">3. compute view diff</text>
  <text x="412" y="78" font-size="11" fill="#1e293b">tombstone old view row</text>
  <text x="412" y="94" font-size="11" fill="#1e293b">+ insert new view row</text>
  <path d="M572 70 L 596 70" stroke="#d97706" stroke-width="2"/>
  <rect x="600" y="40" width="140" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="612" y="60" font-size="12" font-weight="700" fill="#1e293b">4. batchlog</text>
  <text x="612" y="78" font-size="11" fill="#1e293b">durable, local</text>
  <text x="612" y="94" font-size="11" fill="#1e293b">replayed on crash</text>
  <path d="M670 102 L 670 122 L 300 122 L 300 142" stroke="#d97706" stroke-width="1.5" fill="none"/>
  <rect x="200" y="146" width="220" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="212" y="166" font-size="12" font-weight="700" fill="#1e293b">5. paired view replica</text>
  <text x="212" y="184" font-size="11" fill="#1e293b">same ring position as base</text>
  <text x="212" y="200" font-size="11" fill="#1e293b">applies mutation, acks</text>
  <path d="M422 176 L 446 176" stroke="#16a34a" stroke-width="2"/>
  <rect x="450" y="146" width="290" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="462" y="166" font-size="12" font-weight="700" fill="#1e293b">6. ack per base CL, clear batchlog</text>
  <text x="462" y="184" font-size="11" fill="#1e293b">total: 1 lock + 1 read + 1 batchlog + 1 hop</text>
  <text x="462" y="200" font-size="11" fill="#1e293b">p99 write latency ~ 2-5x the same table with no MV</text>
  <rect x="20" y="222" width="720" height="100" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="34" y="244" font-size="13" font-weight="700" fill="#1e293b">Where it breaks (why MVs are still experimental)</text>
  <text x="34" y="266" font-size="11" fill="#1e293b">View replica down past max_hint_window (3 h) AND batchlog replay fails → view row never written.</text>
  <text x="34" y="284" font-size="11" fill="#1e293b">nodetool repair on the base table does NOT reconcile the view — it compares base data only.</text>
  <text x="34" y="302" font-size="11" fill="#1e293b">Only remedy: nodetool rebuild_view, or DROP and CREATE — a full re-derivation of the view.</text>
  <text x="34" y="318" font-size="11" fill="#1e293b">Hence materialized_views_enabled defaults to false since Cassandra 4.0.</text>
</svg>
```

---

## 4. Architecture & Workflow

End to end, from `CREATE` to steady state:

1. **Enable the feature.** On 4.0+ `CREATE MATERIALIZED VIEW` is rejected unless `materialized_views_enabled: true` is set in `cassandra.yaml` on every node. This is deliberate friction.
2. **Validate the definition.** Cassandra checks the primary key rule (all base key columns present, at most one extra), rejects views over tables with counters or static columns in the view key, and requires `IS NOT NULL` on every view key column.
3. **Create schema and start the build.** The view is registered in `system_schema.views` and each node begins an asynchronous **view build**, scanning its local base SSTables token range by token range and emitting view mutations. Progress lives in `system.view_builds_in_progress`; completion is recorded in `system.built_views`. Queries against a partially built view return partial results with no warning.
4. **Steady-state writes.** Each base write triggers the lock → read → diff → batchlog → paired-replica dispatch sequence described above, on every replica of the base row.
5. **Steady-state reads.** A view is queried exactly like a table: `SELECT * FROM ks.view_name WHERE ...`, honouring its own partition key and clustering order. Reads never consult the base table.
6. **Deletion propagation.** Deleting a base row or a base partition generates the corresponding view deletions through the same path. A base partition delete is expensive here because it must produce a view mutation per affected view row.
7. **Repair and divergence handling.** `nodetool repair ks base_table` repairs the base only. Repairing the view table itself (`nodetool repair ks view_name`) reconciles the view's own replicas but cannot detect a row that was never written. Detection means comparing counts or checksums between base and view; correction means `nodetool rebuild_view ks view_name` or a drop-and-recreate.
8. **Dropping.** `DROP MATERIALIZED VIEW` removes the view and its SSTables. Dropping the base table requires dropping all its views first.

```svg
<svg viewBox="0 0 760 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="320" fill="#ffffff"/>
  <text x="20" y="24" font-size="15" font-weight="700" fill="#1e293b">Base table to view: key rule, build, and the re-keying that happens</text>
  <rect x="20" y="42" width="330" height="120" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="34" y="62" font-size="12" font-weight="700" fill="#1e293b">BASE  orders_by_user</text>
  <text x="34" y="82" font-size="11" fill="#1e293b">PRIMARY KEY ((user_id), created_at, order_id)</text>
  <rect x="34" y="92" width="300" height="24" rx="4" fill="#ffffff" stroke="#4f46e5"/>
  <text x="44" y="108" font-size="10" fill="#1e293b">user=A  ts=10:00  ord=1  status=PENDING</text>
  <rect x="34" y="120" width="300" height="24" rx="4" fill="#ffffff" stroke="#4f46e5"/>
  <text x="44" y="136" font-size="10" fill="#1e293b">user=A  ts=10:05  ord=2  status=PAID</text>
  <text x="34" y="158" font-size="11" fill="#1e293b">1 partition per user — bounded and healthy</text>
  <path d="M354 100 L 396 100" stroke="#0ea5e9" stroke-width="2"/>
  <text x="352" y="90" font-size="10" fill="#0ea5e9">re-key</text>
  <rect x="400" y="42" width="340" height="120" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="414" y="62" font-size="12" font-weight="700" fill="#1e293b">VIEW  orders_by_status</text>
  <text x="414" y="82" font-size="11" fill="#1e293b">PRIMARY KEY ((status), user_id, created_at, order_id)</text>
  <rect x="414" y="92" width="310" height="24" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="424" y="108" font-size="10" fill="#1e293b">status=PENDING  → every pending order, cluster-wide</text>
  <rect x="414" y="120" width="310" height="24" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="424" y="136" font-size="10" fill="#1e293b">status=PAID     → every paid order, ever</text>
  <text x="414" y="158" font-size="11" fill="#1e293b">5 statuses = 5 giant partitions — a hotspot you built by accident</text>
  <text x="20" y="192" font-size="13" font-weight="700" fill="#1e293b">The primary key rule</text>
  <rect x="20" y="204" width="720" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="34" y="224" font-size="12" fill="#1e293b">PK(view) must contain ALL of PK(base), plus AT MOST ONE extra non-key column.</text>
  <text x="34" y="242" font-size="12" fill="#1e293b">Guarantees one view row per base row → deletions are computable → the view is repairable at all.</text>
  <text x="20" y="274" font-size="13" font-weight="700" fill="#1e293b">Lifecycle</text>
  <rect x="20" y="284" width="130" height="26" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="30" y="302" font-size="10" fill="#1e293b">enable flag (4.0+)</text>
  <path d="M152 297 L 166 297" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="170" y="284" width="120" height="26" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="180" y="302" font-size="10" fill="#1e293b">validate PK rule</text>
  <path d="M292 297 L 306 297" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="310" y="284" width="150" height="26" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="320" y="302" font-size="10" fill="#1e293b">async build (partial reads!)</text>
  <path d="M462 297 L 476 297" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="480" y="284" width="120" height="26" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="490" y="302" font-size="10" fill="#1e293b">steady state</text>
  <path d="M602 297 L 616 297" stroke="#16a34a" stroke-width="2"/>
  <rect x="620" y="284" width="120" height="26" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="630" y="302" font-size="10" fill="#1e293b">rebuild_view to fix</text>
</svg>
```

---

## 5. Implementation

```yaml
# cassandra.yaml — required on every node from 4.0 onward
materialized_views_enabled: true
# related guardrails worth setting explicitly
materialized_views_per_table_warn_threshold: 1
materialized_views_per_table_fail_threshold: 2
```

```cql
CREATE KEYSPACE shop WITH replication =
  {'class':'NetworkTopologyStrategy','us_east':3,'eu_west':3};

CREATE TABLE shop.orders_by_user (
  user_id     uuid,
  created_at  timestamp,
  order_id    uuid,
  status      text,
  region      text,
  total_cents bigint,
  PRIMARY KEY ((user_id), created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id DESC);
```

A **defensible** view — the extra key column (`region`) has thousands of distinct values, so partitions stay bounded, and it is bucketed nowhere because region cardinality is high enough:

```cql
CREATE MATERIALIZED VIEW shop.orders_by_region AS
  SELECT user_id, created_at, order_id, region, status, total_cents
  FROM shop.orders_by_user
  WHERE region     IS NOT NULL
    AND user_id    IS NOT NULL
    AND created_at IS NOT NULL
    AND order_id   IS NOT NULL
  PRIMARY KEY ((region), created_at, user_id, order_id)
  WITH CLUSTERING ORDER BY (created_at DESC, user_id ASC, order_id ASC);

SELECT order_id, total_cents FROM shop.orders_by_region
WHERE region = 'eu-de' AND created_at > '2026-07-01' LIMIT 100;
```

An **indefensible** view — five statuses means five partitions holding the entire table:

```cql
-- ❌ do not do this: unbounded, hot partitions maintained automatically
CREATE MATERIALIZED VIEW shop.orders_by_status AS
  SELECT * FROM shop.orders_by_user
  WHERE status IS NOT NULL AND user_id IS NOT NULL
    AND created_at IS NOT NULL AND order_id IS NOT NULL
  PRIMARY KEY ((status), user_id, created_at, order_id);
```

Statements Cassandra will **reject**, and why:

```cql
-- ✗ two extra non-key columns
CREATE MATERIALIZED VIEW v AS SELECT * FROM shop.orders_by_user
  WHERE ... PRIMARY KEY ((status, region), user_id, created_at, order_id);
-- InvalidRequest: Cannot include more than one non-primary key column in
--                 materialized view primary key

-- ✗ dropping a base column used by a view
ALTER TABLE shop.orders_by_user DROP region;
-- InvalidRequest: Cannot drop column region, depended on by materialized views

-- ✗ writing to a view
INSERT INTO shop.orders_by_region (region, order_id) VALUES ('eu-de', now());
-- InvalidRequest: Cannot directly modify a materialized view
```

The **application-managed alternative** you should reach for by default:

```cql
CREATE TABLE shop.orders_by_region (
  region text, day date, created_at timestamp, order_id uuid,
  user_id uuid, status text, total_cents bigint,
  PRIMARY KEY ((region, day), created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id DESC);
```

```python
# one write path owns the fan-out; idempotent, retryable, reconcilable
ins_user   = session.prepare("INSERT INTO orders_by_user (user_id,created_at,order_id,"
                             "status,region,total_cents) VALUES (?,?,?,?,?,?)")
ins_region = session.prepare("INSERT INTO orders_by_region (region,day,created_at,"
                             "order_id,user_id,status,total_cents) VALUES (?,?,?,?,?,?,?)")

def place_order(o):
    fs = [session.execute_async(ins_user, (o.user_id, o.ts, o.id, o.status,
                                           o.region, o.total)),
          session.execute_async(ins_region, (o.region, o.ts.date(), o.ts, o.id,
                                             o.user_id, o.status, o.total))]
    for f in fs:
        f.result()
```

Operating a view:

```bash
# Is the build finished? (empty result = done on this node)
cqlsh -e "SELECT keyspace_name, view_name, generation_number
          FROM system.view_builds_in_progress;"
cqlsh -e "SELECT * FROM system.built_views;"

# Force a full re-derivation from base data — expensive, run node by node
nodetool rebuild_view shop orders_by_user orders_by_region

# Detect drift: compare counts per token range (never a bare COUNT(*) on a big table)
cqlsh -e "SELECT COUNT(*) FROM shop.orders_by_user
          WHERE token(user_id) > -9223372036854775808 AND token(user_id) <= -8000000000000000000;"

# View-specific write cost shows up here
nodetool tablestats shop.orders_by_user | grep -iE "local write|write latency"
# Local write count: 41827733
# Local write latency: 0.412 ms      <-- vs 0.089 ms on an MV-free table

nodetool tpstats | grep -i View
# ViewMutationStage       0        0        18274451      0        0
```

> **Optimization:** if you keep a view, keep exactly one, and choose its extra key column so that the resulting partitions are bounded — high enough cardinality to spread, and combined with a bucket if the row rate is high. Additionally, since every base write pays a read-before-write, put the base table on `LeveledCompactionStrategy` so that read is a 1–2 SSTable lookup rather than a size-tiered scan; this alone commonly halves the MV write penalty. And never place an MV on a table with a high update rate on the view-key column — each change costs a shadowable tombstone plus an insert.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| Developer effort | One DDL statement replaces an entire fan-out write path and its backfill | You lose the ability to reconcile, retry or backfill selectively — it is all or nothing |
| Correctness surface | Server enforces one view row per base row; no application bug can desync half the rows | The server can still lose view mutations, and base repair will not fix it |
| Write latency | Automatic and consistent across all clients and languages | 2–5× write latency: lock + read-before-write + batchlog + extra hop, per view |
| Read behaviour | A view is queried exactly like a table, with its own clustering order | Reads during the async build silently return partial results |
| Schema coupling | Base and view stay in lockstep by construction | You cannot `DROP` a base column a view uses, and you cannot write to a view directly |
| Operational recovery | `nodetool rebuild_view` exists | It re-derives the whole view: hours of I/O, and the view is incomplete while it runs |
| Expressiveness | Re-keying, reordering, column projection | No aggregation, no joins, no arbitrary `WHERE` filters, at most one extra key column |
| Project status | Ships in every release since 3.0; some large users run them successfully | Marked experimental since 3.11; disabled by default since 4.0; known open divergence JIRAs |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Choosing a low-cardinality column as the view's extra key** (`status`, `country`, `is_active`). The view becomes a handful of enormous, hot partitions. ✅ Pick a high-cardinality column, or accept that you need a bucketed application-managed table instead — MVs cannot express a synthetic bucket.
2. ⚠️ **Putting an MV on a table whose view-key column changes often.** Every change writes a shadowable tombstone plus an insert into the view. ✅ Only view columns that are effectively immutable after write.
3. ⚠️ **Creating several views on one table.** Each multiplies the write cost, and the read-before-write is per view. ✅ Set `materialized_views_per_table_fail_threshold: 2` and treat two views as a strong smell.
4. ⚠️ **Assuming `nodetool repair` keeps base and view in sync.** It does not — it repairs each table's own replicas independently and cannot detect a view row that was never created. ✅ Build a periodic reconciliation job (token-range counts or checksums) and know your `rebuild_view` runbook.
5. ⚠️ **Reading a view immediately after `CREATE MATERIALIZED VIEW`.** The build is asynchronous and partial results are returned with no warning. ✅ Poll `system.view_builds_in_progress` on every node until empty and `system.built_views` contains the view before routing traffic.
6. ⚠️ **Using an MV for anything financial or user-visible-critical.** A silently missing row is the documented failure mode. ✅ Reserve MVs for convenience lookups where a rare miss is tolerable; write the table yourself otherwise.
7. ⚠️ **Forgetting `materialized_views_enabled: true` on some nodes.** Schema propagates but the setting does not, producing confusing partial behaviour. ✅ Manage it in configuration management and verify on every node.
8. ⚠️ **Expecting to filter with `WHERE`.** The only permitted predicates are `IS NOT NULL` on key columns (plus, in later versions, restrictions on the base key). ✅ You cannot build a "view of active users only"; that needs an application-managed table.
9. ⚠️ **Dropping or altering base columns a view depends on.** Cassandra rejects it, which can block an urgent schema change. ✅ Drop the view first, make the change, recreate and rebuild — budget the rebuild time before you need it.
10. ⚠️ **Leaving the base table on `SizeTieredCompactionStrategy` under MV load.** The mandatory read-before-write then touches many SSTables. ✅ Use `LeveledCompactionStrategy` (or `UnifiedCompactionStrategy` on 5.0) on MV base tables.
11. ⚠️ **Enabling MVs in a new 4.x/5.x cluster because "they're in the docs".** The default is `false` for a reason. ✅ Treat enabling it as an architectural decision with a written justification and a rollback plan.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The first question is always "is the build finished?" — check `system.view_builds_in_progress` on **every** node, not just one, and `system.built_views`. The second is "how far apart are base and view?" — never run a bare `SELECT COUNT(*)`; iterate token ranges and compare counts range by range, which also localizes the divergence to specific nodes. `TRACING ON` on a base write shows the `ViewMutationStage` work and the paired-replica dispatch. If you find missing view rows, `nodetool rebuild_view <ks> <base_table> <view>` re-derives them; run it one node at a time and expect it to behave like a major compaction. For latency regressions, compare `nodetool tablestats` local write latency on the base table before and after the view existed — the delta is the MV tax, and it is real.

**Monitoring.** The MV-specific beans are `org.apache.cassandra.metrics:type=ThreadPools,path=request,scope=ViewMutationStage,name=PendingTasks` and `...name=TotalBlockedTasks` — a growing pending count means view dispatch is falling behind the write rate and mutations will start expiring. Watch `org.apache.cassandra.metrics:type=Table,keyspace=<ks>,scope=<base>,name=ViewLockAcquireTime` and `...name=ViewReadTime`, which measure exactly the two costs the view adds. Alert on batchlog health via `...type=Table,keyspace=system,scope=batches,name=...` size growth and on `HintsService` metrics, since a down view replica manifests as hint accumulation. Also track per-table `WriteLatency` on the base and per-partition size on the view (`EstimatedPartitionSizeHistogram`) — the latter is how you catch a low-cardinality view key before it becomes an incident.

**Security.** A view exposes base data under a different table name with its own permissions surface: `GRANT SELECT ON shop.orders_by_region TO role` is independent of the base table grant, so a view can accidentally widen access to columns a role was not meant to read. Audit `system_schema.views` alongside your table grants. Views cannot be written to directly, which is a useful property — the view is read-only by construction — but it also means row-level redaction is impossible; if the base column is sensitive, the view carries it. Cassandra 4.0 audit logging records base-table mutations, not the derived view mutations, so an audit trail of "who changed this view row" must be reconstructed from the base table.

**Performance & scaling.** MV write cost is per view, per replica, and includes a synchronous local read — so a cluster's write ceiling with one view is typically 30–50 % of its MV-free ceiling, and with three views it can be under 20 %. Capacity-plan for that explicitly rather than discovering it. Scaling out helps the *base* write path but does not remove the read-before-write, so the penalty does not amortize away with more nodes. Bootstrap and decommission are slower because view SSTables stream too. Before enabling MVs, benchmark the exact table with and without the view at your target write rate; the number you get is the number you live with.

---

## 9. Interview Questions

**Q: What is a materialized view in Cassandra?**
A: It is a server-maintained table derived from a base table with a different primary key, declared with `CREATE MATERIALIZED VIEW ... AS SELECT ... PRIMARY KEY (...)`. Every write to the base table automatically produces the corresponding view mutation, so the application does not write the view itself; views are read-only.

**Q: What are the rules for a materialized view's primary key?**
A: The view's primary key must include every column of the base table's primary key, plus at most one additional non-key column, and every column in the view key must be asserted `IS NOT NULL`. This guarantees exactly one view row per base row, which is what makes deletions computable.

**Q: Why does a base write become more expensive when a view exists?**
A: The replica must lock the base partition key, read the current base row to learn the previous value of the view-key column, compute a shadowable tombstone plus an insert if that value changed, write a batchlog entry, and dispatch the mutation to the paired view replica. That turns a pure append into a read-modify-write with an extra durable write and a network hop.

**Q: Why are materialized views marked experimental?**
A: Because the project cannot guarantee that base and view converge under all failure scenarios. If a view mutation is lost — view replica down past the hint window with a failed batchlog replay, or specific concurrent-update interleavings — the view row is simply never written, and `nodetool repair` on the base table does not detect or fix it.

**Q: Does repairing the base table fix an inconsistent view?**
A: No. Repair compares replicas of a single table; it has no notion of the base-to-view derivation. Repairing the view reconciles the view's own replicas but cannot invent a row that was never generated. The only reliable correction is `nodetool rebuild_view` or dropping and recreating the view.

**Q: Can you filter rows in a materialized view?**
A: Not meaningfully. The `WHERE` clause is limited to `IS NOT NULL` assertions on the view key columns (plus restrictions on base primary key columns in newer versions), so you cannot express "only active users". Rows whose view key columns are null simply do not appear — that is the only implicit filtering you get.

**Q: What happens if you query a view right after creating it?**
A: You get partial results with no warning, because the view build is asynchronous and scans base SSTables in the background. You must poll `system.view_builds_in_progress` on every node and confirm the view appears in `system.built_views` before routing traffic to it.

**Q: How is a materialized view different from a secondary index?**
A: A secondary index is local to each node, so an unrestricted indexed query scatters across the ring; a materialized view is a real, differently-partitioned table, so a view query is a normal single-partition read. The cost moves from read time (index) to write time (view), and views can reorder and project columns while indexes cannot.

**Q: (Senior) You must serve "orders by region, newest first" at 20k QPS. MV or application-managed table?**
A: Application-managed table, keyed `((region, day), created_at, order_id)`. The MV cannot express the `day` bucket, so its partitions grow without bound; it would also add a read-before-write to a high-throughput write path and provide no reconciliation story. The manual table costs one extra async insert per order, is idempotent and retryable, can be backfilled and audited, and its partitions are bounded by construction.

**Q: (Senior) An MV has drifted from its base table in production. Walk through detection and recovery with minimal impact.**
A: Detect by iterating token ranges and comparing per-range counts (and, where feasible, per-row checksums) between base and view rather than a global count, which localizes divergence to specific nodes. Stop the bleeding first: confirm all view replicas are up, hints are draining, and `ViewMutationStage` pending is zero; check `system.batches` for stuck entries. Then run `nodetool rebuild_view` node by node during low traffic, accepting that the view is incomplete while it runs — so either route reads to the base-derived path temporarily or accept degraded results. Post-incident, either add a scheduled reconciliation job or migrate the view to an application-managed table.

**Q: (Senior) What is the paired view replica, and why does the pairing matter?**
A: For each base replica, Cassandra deterministically pairs it with one replica of the view partition occupying the corresponding ring position, and sends view mutations only to that pair. Pairing means each base replica is responsible for exactly one view replica, so `RF` base replicas produce `RF` view replicas without duplicating work or requiring cross-replica coordination. It also means a topology change — bootstrap, decommission, RF change — perturbs the pairing, which is one of the situations in which view mutations have historically been lost.

**Q: How do you disable or remove materialized views safely?**
A: Stop reads against the view first, then `DROP MATERIALIZED VIEW ks.view_name`, which removes its schema and SSTables; the base table is unaffected. If you are migrating to an application-managed table, deploy dual writes to the new table, backfill it from the base table by token range, verify counts, cut reads over, and only then drop the view. Setting `materialized_views_enabled: false` afterwards prevents anyone recreating one.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A materialized view is a server-maintained, differently-keyed copy of a base table. Its primary key must contain all base key columns plus at most one extra non-key column, each asserted `IS NOT NULL`, which guarantees one view row per base row. Every base write pays a partition lock, a local read-before-write, a batchlog entry and a dispatch to the paired view replica — typically 2–5× the write latency, per view. Views are read-only, cannot filter or aggregate, cannot express a bucket, and block dropping base columns they use. They are marked experimental since 3.11 and disabled by default since 4.0 because a lost view mutation is unrecoverable by repair; the only fix is `nodetool rebuild_view`. Use them for convenience lookups over high-cardinality, immutable columns; write the second table yourself for anything critical.

| Item | Value / Command |
| --- | --- |
| Enable (4.0+) | `materialized_views_enabled: true` in `cassandra.yaml` |
| Create | `CREATE MATERIALIZED VIEW ks.v AS SELECT ... PRIMARY KEY (...)` |
| Key rule | all base PK columns + at most **one** extra non-key column |
| Mandatory clause | `WHERE <every view key col> IS NOT NULL` |
| Build progress | `system.view_builds_in_progress`, `system.built_views` |
| Re-derive | `nodetool rebuild_view <ks> <base> <view>` |
| Drop | `DROP MATERIALIZED VIEW ks.v;` |
| Write cost | lock + read-before-write + batchlog + 1 hop ≈ 2–5× |
| Key metrics | `ViewLockAcquireTime`, `ViewReadTime`, `ViewMutationStage` pending |
| Guardrails | `materialized_views_per_table_fail_threshold: 2` |
| Status | experimental since 3.11 (CASSANDRA-13959), off by default since 4.0 |
| Not supported | writes to views, aggregation, joins, arbitrary `WHERE`, bucketed keys |

**Flash cards**

- **How many non-key base columns may a view's primary key add?** → Exactly one, at most.
- **What makes an MV write 2–5× more expensive?** → A partition lock plus a local read-before-write, a batchlog entry and a paired-replica hop.
- **Does `nodetool repair` on the base fix a missing view row?** → No. Only `rebuild_view` or drop-and-recreate does.
- **Why is `materialized_views_enabled` false by default since 4.0?** → Because base-to-view divergence under failure is a known, unrepaired condition.
- **When is an MV defensible?** → High-cardinality, immutable view key, non-critical reads, and a rebuild you can afford.

---

## 11. Hands-On Exercises & Mini Project

- [ ] On a 3-node cluster (`ccm` or Docker, Cassandra 4.1), set `materialized_views_enabled: true`, create `orders_by_user` with 1 M rows, then create a view keyed by `region`. Time the build by polling `system.view_builds_in_progress`, and query the view during the build to observe partial results.
- [ ] Benchmark write latency on `orders_by_user` with 0, 1 and 2 views attached, at fixed concurrency. Record p50/p99 from `nodetool tablestats` and from client-side timing, and compute the MV tax as a percentage.
- [ ] Create a deliberately bad view keyed by `status` (5 distinct values), load 5 M rows, then run `nodetool tablehistograms` on the view and report max partition size. Explain why no amount of tuning fixes it.
- [ ] Simulate divergence: stop one node, write 50k rows, wait past `max_hint_window` (temporarily lower it to a few minutes), restart, run `nodetool repair` on the base, then compare base and view counts per token range. Recover with `nodetool rebuild_view` and measure how long it takes.
- [ ] Try each rejected statement from section 5 (two extra key columns, dropping a used base column, writing to the view) and record the exact error text for your team runbook.

### Mini Project — "MV versus manual denormalization, decided by data"

**Goal.** Produce a defensible, measured recommendation for your organization on when materialized views are acceptable.

**Requirements.**
1. Build the same access pattern three ways over one base table: a materialized view, an application-managed query table with async fan-out writes, and an application-managed table written in a logged batch.
2. Load 10 M rows and measure, for each: write p50/p99, read p50/p99, disk usage, and node CPU during steady state.
3. Inject failure — kill a replica for longer than the hint window during a 500k-row write burst — then measure divergence for each approach and time the recovery (`rebuild_view` versus a targeted backfill).
4. Write a reconciliation job that compares base and derived data by token range and reports drift, and run it against all three.
5. Publish a one-page decision guide: when an MV is acceptable, what monitoring must exist before enabling one, and the exact runbook for recovery.

**Extensions.** Repeat the divergence test during a bootstrap of a new node to exercise view-replica pairing changes. Compare against a Cassandra 5.0 SAI index on the same column as a third alternative. Model the capacity cost: how many extra nodes would the MV write tax require at your production write rate?

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Denormalization & Table-per-Query* is the application-managed alternative and should be read alongside this one. *Secondary Indexes, SAI & SASI* is the other server-side shortcut, with a different cost profile. *Query-First Data Modeling* explains why the second table exists at all. *Batches & Lightweight Transactions* covers the batchlog machinery the MV write path reuses, and *Data Modeling Anti-Patterns* covers the low-cardinality-key trap that MVs make easy to fall into.

- **Materialized Views — Apache Cassandra Documentation** — Apache Software Foundation · *Intermediate* · Official syntax, the primary key restrictions, and the explicit experimental warning. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/mvs.html>
- **CASSANDRA-6477: Materialized Views** — Apache JIRA · *Advanced* · The original design ticket, including the paired-replica scheme and the reasoning behind the one-extra-column rule. <https://issues.apache.org/jira/browse/CASSANDRA-6477>
- **CASSANDRA-13959: Mark Materialized Views experimental** — Apache JIRA · *Intermediate* · The ticket that added the warning and later the default-off flag; the discussion is the clearest statement of the known risks. <https://issues.apache.org/jira/browse/CASSANDRA-13959>
- **CASSANDRA-13810: MV updates can be lost under concurrent writes** — Apache JIRA · *Advanced* · A concrete, reproducible divergence scenario worth reading before you enable views. <https://issues.apache.org/jira/browse/CASSANDRA-13810>
- **Materialized Views: The Good, the Bad and the Ugly** — The Last Pickle · *Intermediate–Advanced* · Practitioner analysis of MV write amplification and real-world consistency incidents. <https://thelastpickle.com/blog/>
- **DataStax Docs — Materialized Views** — DataStax · *Beginner–Intermediate* · Clear worked examples of view creation, restrictions and operational commands. <https://docs.datastax.com/en/cql-oss/3.3/cql/cql_using/useCreateMV.html>
- **ScyllaDB University — Materialized Views and Secondary Indexes** — ScyllaDB · *Intermediate* · Free lessons on a compatible MV implementation, useful for contrasting design choices around view consistency. <https://university.scylladb.com/courses/data-modeling/lessons/materialized-views/>
- **Cassandra Summit talks on Materialized Views** — Planet Cassandra / Apache Cassandra on YouTube · *Intermediate* · Conference sessions covering MV internals and production experience reports. <https://www.youtube.com/@PlanetCassandra>

---

*Apache Cassandra Handbook — chapter 10.*
