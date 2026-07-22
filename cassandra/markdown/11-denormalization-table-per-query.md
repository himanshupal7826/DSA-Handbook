# 11 · Denormalization & Table-per-Query

> **In one line:** Cassandra has no joins, so you duplicate the same fact into one table per query and make the *write path* — not the read path — responsible for keeping those copies in agreement.

---

## 1. Overview

In a relational database, duplication is a bug. Codd's normal forms exist precisely to eliminate it, because a single copy of a fact means a single place to update it, and the join engine reassembles whatever shape a query needs at read time. Cassandra removes the join engine. There is no operator that can combine rows living on different nodes, and no query planner that would know how. So the reassembly has to happen somewhere else, and Cassandra's answer is: it happens *before* the read, at write time, by storing the fact once per shape the application will ask for.

That is denormalization as a design discipline rather than as a last-resort optimization. Each access pattern gets its own table — `orders_by_user`, `orders_by_id`, `orders_by_region_day` — and a single domain event (`place_order`) writes all of them. A read then touches exactly one partition on one replica set, which is the only shape whose latency stays flat as the cluster grows from three nodes to three hundred. You pay in storage (3–6× a normalized footprint is typical and entirely normal) and in write amplification (N physical writes per logical event), and you buy predictable p99 reads. On modern hardware that trade is heavily in your favour: a terabyte of SSD costs less than a millisecond of tail latency in a checkout flow.

The hard part is not creating the tables. It is the question the relational world never made you answer: **what happens when write 3 of 5 fails?** There is no transaction to roll back, no foreign key to enforce, no cascade. Cassandra offers three tools — logged batches for all-or-nothing across tables, idempotent writes plus retries for convergence, and periodic reconciliation for the residue — and choosing correctly among them per fact is the actual engineering work of this chapter.

Historically the pattern predates Cassandra: Dynamo-style stores and the wide-column lineage from Bigtable all assumed the application owned its own indexing. What Cassandra added was a schema language expressive enough to make each denormalized copy a first-class, typed, queryable table rather than a hand-rolled blob key — which is why CQL looks like SQL while forbidding nearly everything SQL does at read time. A concrete example: Netflix's viewing-history service stores each viewing event in a table keyed by `(customer_id, bucket)` for the "continue watching" row, and separately in a compact summary table for the recommendation pipeline, and again in an archival table with a coarser bucket for full history. Same event, three shapes, three write targets, one write path in the service. When a shape is no longer needed, the table is dropped; when a new shape is needed, a new table plus a Spark backfill appears. Nobody joins anything.

---

## 2. Core Concepts

- **Denormalization** — deliberately storing the same fact in multiple tables so each query reads one partition. In Cassandra this is the default design, not an optimization.
- **Table-per-query** — the rule that each access pattern gets its own table whose partition key is the query's equality filter and whose clustering columns are its sort order.
- **Fan-out write** — the set of physical writes produced by one logical domain event, one per query table that contains the affected fact.
- **Source of truth table** — the one table designated as authoritative, from which all other copies can be re-derived. Essential for reconciliation and backfill.
- **Idempotent write** — a statement that produces the same final state however many times it is applied: deterministic keys, no counters, no read-modify-write, ideally an explicit client timestamp.
- **Logged batch** — `BEGIN BATCH ... APPLY BATCH`, which writes the mutations to a batchlog on two replicas first so that all of them will *eventually* be applied, atomically per partition but not isolated.
- **Unlogged batch** — a batch with no batchlog. Only sensible when every statement targets the *same partition*, where it is a genuine single-mutation optimization.
- **Reconciliation job** — a scheduled process that re-derives derived tables from the source of truth (by token range) and repairs drift.
- **Write amplification** — the ratio of physical writes to logical events; the direct cost of denormalization and the number you capacity-plan against.
- **Client-side timestamp (`USING TIMESTAMP`)** — an explicit mutation timestamp that makes retries and out-of-order delivery converge to the same state.

---

## 3. Theory & Internals

### Why the write path is cheap enough to make this work

A Cassandra write is an append: commit-log record plus a memtable insert. There is no read, no index update (absent `2i`), no page split, no undo log. Cost is roughly constant regardless of table size, so `N` writes cost `N ×` a very small number. Reads are the expensive operation because they must merge memtable and multiple SSTables. Denormalization is therefore a straight transfer of work from the expensive side to the cheap side — the same reasoning behind LSM-trees generally.

Concretely, on a modest node a single-partition write at `LOCAL_QUORUM` costs ~0.1–0.5 ms local latency. Five of them issued **in parallel** cost approximately `max()`, not `sum()` — so the fan-out latency is roughly one write, not five, provided your driver issues them asynchronously. What scales linearly is *throughput consumption*: five writes consume five slots of cluster write capacity, so a 10k-events/s service with a 5-way fan-out needs 50k writes/s of capacity.

### What a logged batch actually guarantees

`BEGIN BATCH` gives **atomicity**, not isolation, and not a transaction. The coordinator writes the full set of mutations to the `system.batches` table on **two** replicas in the local DC, applies the individual mutations to their normal replicas at the batch's consistency level, and on success deletes the batchlog entry. If the coordinator dies first, another node replays the batchlog, so every mutation eventually lands.

So: all statements will eventually be applied, or none were durably recorded. But other readers can observe a partially-applied batch, there is no rollback, and there is no conflict detection. The cost is one extra durable write to two nodes plus the coordination — commonly **2–3×** the latency of the same statements issued in parallel. The exception worth knowing: a batch whose statements **all target the same partition** is compiled into a single mutation — genuinely atomic *and* isolated for that partition, with no batchlog needed if it is `UNLOGGED`. That is the only batch that is a performance optimization.

### Convergence without atomicity

For most denormalized fan-outs you do not need atomicity; you need **convergence**. Three properties make retries safe:

- **Deterministic keys.** The order id, event id and bucket must be computed once at the edge, not per statement, so a retry writes the same row.
- **No read-modify-write.** `SET total = total + 1` (counter) or "read then write" breaks idempotence. Write absolute values.
- **Explicit timestamps.** `USING TIMESTAMP :ts` derived once from the logical event means a late-arriving retry cannot overwrite newer state — last-write-wins resolves deterministically rather than by arrival order.

With those, the algorithm is simply: issue all writes async, retry failures with jittered backoff, and let a reconciliation job catch anything that never succeeded.

### Reconciliation math

Reconciliation compares the source of truth against each derived table. Never `SELECT COUNT(*)` globally — that is a full cluster scan under a single timeout budget. Instead iterate roughly `num_nodes × 4` token ranges: for each range read the source rows with `WHERE token(pk) > lo AND token(pk) <= hi`, probe the derived table for the same logical keys, and repair the difference. Each sub-scan routes to one replica set, is retried independently, and can run at `LOCAL_ONE` off-peak. This is exactly the strategy the Spark Cassandra Connector implements, which is why Spark is the usual vehicle.

```svg
<svg viewBox="0 0 760 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="330" fill="#ffffff"/>
  <text x="20" y="24" font-size="15" font-weight="700" fill="#1e293b">Denormalization moves work from read time to write time</text>
  <rect x="20" y="42" width="340" height="128" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="34" y="62" font-size="12" font-weight="700" fill="#1e293b">Relational: one copy, join at read</text>
  <rect x="34" y="72" width="90" height="26" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="44" y="89" font-size="10" fill="#1e293b">users</text>
  <rect x="132" y="72" width="90" height="26" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="142" y="89" font-size="10" fill="#1e293b">orders</text>
  <rect x="230" y="72" width="110" height="26" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="240" y="89" font-size="10" fill="#1e293b">order_lines</text>
  <path d="M124 85 L 130 85" stroke="#d97706" stroke-width="2"/>
  <path d="M222 85 L 228 85" stroke="#d97706" stroke-width="2"/>
  <text x="34" y="120" font-size="11" fill="#1e293b">write: 1 row   read: JOIN across 3 tables</text>
  <text x="34" y="138" font-size="11" fill="#1e293b">in Cassandra this is N network round trips</text>
  <text x="34" y="158" font-size="11" fill="#1e293b">latency = sum of worst cases, availability compounds down</text>
  <rect x="400" y="42" width="340" height="128" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="414" y="62" font-size="12" font-weight="700" fill="#1e293b">Cassandra: one table per query</text>
  <rect x="414" y="72" width="150" height="26" rx="4" fill="#ffffff" stroke="#16a34a"/>
  <text x="424" y="89" font-size="10" fill="#1e293b">orders_by_user  K=user</text>
  <rect x="572" y="72" width="152" height="26" rx="4" fill="#ffffff" stroke="#16a34a"/>
  <text x="582" y="89" font-size="10" fill="#1e293b">order_by_id  K=order</text>
  <rect x="414" y="102" width="310" height="26" rx="4" fill="#ffffff" stroke="#16a34a"/>
  <text x="424" y="119" font-size="10" fill="#1e293b">orders_by_region_day  K=(region, day)</text>
  <text x="414" y="146" font-size="11" fill="#1e293b">write: 3 appends in parallel   read: 1 partition</text>
  <text x="414" y="162" font-size="11" fill="#1e293b">latency = max(3 writes) ~ 1 write; read p99 stays flat</text>
  <text x="20" y="198" font-size="13" font-weight="700" fill="#1e293b">Cost accounting</text>
  <rect x="20" y="210" width="720" height="104" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="34" y="232" font-size="11" fill="#1e293b">A write is an append: commitlog + memtable. No read, no index page split, no undo log.</text>
  <text x="34" y="252" font-size="11" fill="#1e293b">fan_out_latency  ~ max(writes)      because the driver issues them asynchronously</text>
  <text x="34" y="272" font-size="11" fill="#1e293b">fan_out_capacity ~ sum(writes)      10k events/s with 5 tables needs 50k writes/s of cluster capacity</text>
  <text x="34" y="292" font-size="11" fill="#1e293b">storage          ~ 3-6x normalized  deliberate purchase of bounded read latency</text>
  <text x="34" y="308" font-size="11" fill="#1e293b">read             ~ 1 partition      constant as the cluster grows</text>
</svg>
```

---

## 4. Architecture & Workflow

The lifecycle of one denormalized fact, from a domain event to eventual reconciliation:

1. **Compute identity at the edge.** The service generates the order id, the event timestamp and every bucket value **once**, before any statement is issued. Every retry, every table, and every backfill uses those same values — this is what makes the whole scheme idempotent.
2. **Classify the fact.** Does this write need atomicity with its siblings, or only convergence? Money movement and "the row must exist in both places or neither" need a logged batch. Derived read models — feeds, dashboards, search shapes — need convergence.
3. **Issue the fan-out.** Prepared, token-aware statements at `LOCAL_QUORUM`, all fired asynchronously, one per query table. Same-partition groups may be combined into an `UNLOGGED BATCH`; cross-partition groups that need atomicity go into a `LOGGED BATCH`.
4. **Coordinator work.** For each statement the coordinator resolves the token, dispatches to `RF` replicas in the local DC, and returns when `LOCAL_QUORUM` (`floor(RF/2)+1`) have acked. Down replicas receive hints, retained for `max_hint_window` (default 3 h).
5. **Handle partial failure.** Any statement that times out is retried with jittered exponential backoff using the *identical* bound values. Because writes are idempotent, a duplicate application is a no-op. A write that exhausts retries is enqueued to a durable outbox (Kafka topic or a `pending_repairs` table) rather than dropped.
6. **Converge.** Hinted handoff and `nodetool repair` bring each individual table's replicas into agreement. Note carefully: repair fixes *within* a table, never *across* tables.
7. **Reconcile across tables.** A scheduled job iterates token ranges of the source-of-truth table, re-derives what each query table should contain, and writes the missing or stale rows. Run it nightly at first; the drift rate it reports tells you whether you can reduce the frequency.
8. **Evolve.** A new access pattern means a new table, a dual-write deploy, a token-range backfill from the source of truth, verification, and a read cutover. No `ALTER` can change a primary key, so this is the only migration path.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="340" fill="#ffffff"/>
  <text x="20" y="24" font-size="15" font-weight="700" fill="#1e293b">One event, many tables: fan-out, failure handling, reconciliation</text>
  <rect x="20" y="44" width="140" height="66" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="32" y="64" font-size="12" font-weight="700" fill="#1e293b">1. domain event</text>
  <text x="32" y="82" font-size="11" fill="#1e293b">ids + ts computed</text>
  <text x="32" y="98" font-size="11" fill="#1e293b">ONCE at the edge</text>
  <path d="M162 77 L 186 77" stroke="#4f46e5" stroke-width="2"/>
  <rect x="190" y="44" width="160" height="66" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="202" y="64" font-size="12" font-weight="700" fill="#1e293b">2. atomicity needed?</text>
  <text x="202" y="82" font-size="11" fill="#1e293b">yes → LOGGED BATCH</text>
  <text x="202" y="98" font-size="11" fill="#1e293b">no  → async parallel</text>
  <path d="M352 77 L 376 77" stroke="#d97706" stroke-width="2"/>
  <rect x="380" y="30" width="180" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="392" y="50" font-size="11" fill="#1e293b">orders_by_user   K=user_id</text>
  <rect x="380" y="66" width="180" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="392" y="86" font-size="11" fill="#1e293b">order_by_id      K=order_id</text>
  <rect x="380" y="102" width="180" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="392" y="122" font-size="11" fill="#1e293b">orders_by_region_day</text>
  <rect x="590" y="44" width="150" height="66" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="602" y="64" font-size="12" font-weight="700" fill="#1e293b">3. coordinator</text>
  <text x="602" y="82" font-size="11" fill="#1e293b">LOCAL_QUORUM acks</text>
  <text x="602" y="98" font-size="11" fill="#1e293b">hints for down nodes</text>
  <path d="M562 45 L 588 62" stroke="#0ea5e9" stroke-width="1.5"/>
  <path d="M562 81 L 588 81" stroke="#0ea5e9" stroke-width="1.5"/>
  <path d="M562 117 L 588 100" stroke="#0ea5e9" stroke-width="1.5"/>
  <path d="M665 112 L 665 136 L 100 136 L 100 156" stroke="#0ea5e9" stroke-width="1.5" fill="none" stroke-dasharray="5 4"/>
  <rect x="20" y="160" width="200" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="32" y="180" font-size="12" font-weight="700" fill="#1e293b">4. partial failure</text>
  <text x="32" y="198" font-size="11" fill="#1e293b">retry, same bound values</text>
  <text x="32" y="214" font-size="11" fill="#1e293b">exhausted → durable outbox</text>
  <path d="M222 195 L 246 195" stroke="#d97706" stroke-width="2"/>
  <rect x="250" y="160" width="220" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="262" y="180" font-size="12" font-weight="700" fill="#1e293b">5. converge per table</text>
  <text x="262" y="198" font-size="11" fill="#1e293b">hinted handoff (3 h window)</text>
  <text x="262" y="214" font-size="11" fill="#1e293b">nodetool repair — WITHIN a table</text>
  <path d="M472 195 L 496 195" stroke="#16a34a" stroke-width="2"/>
  <rect x="500" y="160" width="240" height="70" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="512" y="180" font-size="12" font-weight="700" fill="#1e293b">6. reconcile ACROSS tables</text>
  <text x="512" y="198" font-size="11" fill="#1e293b">token-range scan of source of truth</text>
  <text x="512" y="214" font-size="11" fill="#1e293b">re-derive and repair each copy</text>
  <rect x="20" y="248" width="720" height="80" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="34" y="270" font-size="13" font-weight="700" fill="#1e293b">The rule that catches everyone</text>
  <text x="34" y="292" font-size="12" fill="#1e293b">nodetool repair reconciles replicas OF ONE TABLE. It knows nothing about your other five copies.</text>
  <text x="34" y="312" font-size="12" fill="#1e293b">Cross-table consistency is application-owned: idempotent writes + retries + a reconciliation job.</text>
</svg>
```

---

## 5. Implementation

```cql
CREATE KEYSPACE shop WITH replication =
  {'class':'NetworkTopologyStrategy','us_east':3,'eu_west':3};

-- SOURCE OF TRUTH: everything else is re-derivable from this table
CREATE TABLE shop.order_by_id (
  order_id    uuid,
  line_no     int,
  user_id     uuid      STATIC,
  region      text      STATIC,
  status      text      STATIC,
  created_at  timestamp STATIC,
  total_cents bigint    STATIC,
  sku         text,
  qty         int,
  price_cents bigint,
  PRIMARY KEY ((order_id), line_no)
) WITH compaction = {'class':'LeveledCompactionStrategy'};

-- DERIVED: "a user's orders, newest first"
CREATE TABLE shop.orders_by_user (
  user_id     uuid,
  created_at  timestamp,
  order_id    uuid,
  status      text,
  total_cents bigint,
  PRIMARY KEY ((user_id), created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id DESC);

-- DERIVED: "orders in a region today" — bucketed so partitions stay bounded
CREATE TABLE shop.orders_by_region_day (
  region      text,
  day         date,
  created_at  timestamp,
  order_id    uuid,
  user_id     uuid,
  total_cents bigint,
  PRIMARY KEY ((region, day), created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id DESC)
  AND default_time_to_live = 7776000
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS','compaction_window_size':1};
```

Convergent fan-out — the default choice:

```python
import uuid, datetime, random, time
from cassandra import ConsistencyLevel, WriteTimeout, OperationTimedOut

ins_src  = session.prepare("INSERT INTO order_by_id (order_id,line_no,user_id,region,"
                           "status,created_at,total_cents,sku,qty,price_cents) "
                           "VALUES (?,?,?,?,?,?,?,?,?,?) USING TIMESTAMP ?")
ins_user = session.prepare("INSERT INTO orders_by_user (user_id,created_at,order_id,"
                           "status,total_cents) VALUES (?,?,?,?,?) USING TIMESTAMP ?")
ins_reg  = session.prepare("INSERT INTO orders_by_region_day (region,day,created_at,"
                           "order_id,user_id,total_cents) VALUES (?,?,?,?,?,?) "
                           "USING TIMESTAMP ?")
for s in (ins_src, ins_user, ins_reg):
    s.consistency_level = ConsistencyLevel.LOCAL_QUORUM
    s.is_idempotent = True          # lets the driver retry safely on timeout

def place_order(user_id, region, lines):
    # identity computed ONCE — every retry and every backfill reuses these
    oid = uuid.uuid4()
    now = datetime.datetime.utcnow()
    ts  = int(now.timestamp() * 1_000_000)      # microseconds, the CQL unit
    total = sum(l["qty"] * l["price"] for l in lines)

    stmts = [(ins_user, (user_id, now, oid, "PENDING", total, ts)),
             (ins_reg,  (region, now.date(), now, oid, user_id, total, ts))]
    for i, l in enumerate(lines):
        stmts.append((ins_src, (oid, i, user_id, region, "PENDING", now, total,
                                l["sku"], l["qty"], l["price"], ts)))

    futures = [(s, p, session.execute_async(s, p)) for s, p in stmts]
    failed = []
    for s, p, f in futures:
        try:
            f.result()
        except (WriteTimeout, OperationTimedOut):
            failed.append((s, p))

    for attempt in range(3):                    # jittered retry, identical params
        if not failed:
            break
        time.sleep((2 ** attempt) * 0.05 + random.random() * 0.05)
        retry, failed = failed, []
        for s, p in retry:
            try:
                session.execute(s, p)
            except Exception:
                failed.append((s, p))
    if failed:
        outbox_publish(oid, failed)             # durable; reconciler finishes the job
    return oid
```

When you genuinely need atomicity — use a logged batch, and know what it costs:

```cql
-- Money movement: both rows must eventually exist, or neither was recorded.
BEGIN BATCH USING TIMESTAMP 1785072000000000
  INSERT INTO shop.ledger_by_account (account_id, entry_id, delta_cents, ref)
    VALUES (11111111-1111-1111-1111-111111111111, 7a3e..., -4999, 'ord:41c9');
  INSERT INTO shop.ledger_by_account (account_id, entry_id, delta_cents, ref)
    VALUES (22222222-2222-2222-2222-222222222222, 7a3e...,  4999, 'ord:41c9');
APPLY BATCH;
-- cost: one durable write to system.batches on 2 replicas, then the mutations —
-- roughly 2-3x the latency of the same statements in parallel. Not isolated.

-- Same-partition grouping: the only batch that IS a genuine optimization
BEGIN UNLOGGED BATCH
  INSERT INTO shop.order_by_id (order_id,line_no,sku,qty,price_cents)
    VALUES (41c9..., 0, 'SKU-1', 2, 1999);
  INSERT INTO shop.order_by_id (order_id,line_no,sku,qty,price_cents)
    VALUES (41c9..., 1, 'SKU-9', 1, 1001);
APPLY BATCH;    -- one partition → single mutation, atomic and isolated, no batchlog
```

Reconciliation by token range:

```python
RANGES = 4 * len(cluster.metadata.all_hosts())
MIN, MAX = -(2**63), 2**63 - 1
step = (MAX - MIN) // RANGES
src_scan = session.prepare("SELECT order_id, user_id, region, status, created_at, "
                           "total_cents FROM order_by_id "
                           "WHERE token(order_id) > ? AND token(order_id) <= ?")
src_scan.consistency_level = ConsistencyLevel.LOCAL_ONE
src_scan.fetch_size = 500

def reconcile():
    drift = 0
    for i in range(RANGES):
        lo, hi = MIN + i * step, (MIN + (i + 1) * step) if i < RANGES - 1 else MAX
        for r in session.execute(src_scan, (lo, hi)):     # one replica set per range
            probe = session.execute("SELECT order_id FROM orders_by_user WHERE "
                                    "user_id=%s AND created_at=%s AND order_id=%s",
                                    (r.user_id, r.created_at, r.order_id)).one()
            if probe is None:
                drift += 1
                session.execute(ins_user, (r.user_id, r.created_at, r.order_id,
                                           r.status, r.total_cents,
                                           int(r.created_at.timestamp() * 1_000_000)))
    return drift          # emit as a gauge; a rising trend is a write-path bug
```

```bash
nodetool tablestats shop | grep -E "Table:|Local write count|Space used \(live\)"
# Table: order_by_id            Local write count: 128441902   Space used: 412.7 GiB
# Table: orders_by_user         Local write count:  41827733   Space used:  61.2 GiB
# Table: orders_by_region_day   Local write count:  41827733   Space used:  38.9 GiB
# ratios must match the intended fan-out; a mismatch is a write-path bug

grep "Batch for" /var/log/cassandra/system.log | tail -1
# WARN  Batch for [shop.orders_by_user] is of size 31.402KiB, exceeding specified
#       threshold of 5.000KiB by 26.402KiB.
```

```yaml
# cassandra.yaml — guardrails that keep denormalized write paths honest
batch_size_warn_threshold: 5KiB
batch_size_fail_threshold: 50KiB
unlogged_batch_across_partitions_warn_threshold: 10
max_hint_window: 3h
```

> **Optimization:** the single biggest win in a fan-out write path is **parallel async execution with prepared, token-aware statements**. Issuing five writes sequentially costs `5 × RTT`; issuing them with `execute_async` and collecting the futures costs `max(RTT)` — typically a 4–5× reduction in end-to-end write latency for a 5-table fan-out. The second biggest is refusing to use a logged batch where convergence suffices: replacing a 5-statement logged batch with 5 async writes typically cuts write p99 by 50–70 % because the batchlog write to two replicas disappears from the critical path.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| Read latency | Every query is one partition on one replica set; p99 flat from 3 to 300 nodes | Only modelled queries are servable; a new shape needs a new table plus backfill |
| Write cost | Writes are appends; parallel fan-out latency ≈ one write | Throughput consumption is the *sum*: a 5-way fan-out needs 5× write capacity |
| Storage | Linear, cheap, and predictable | 3–6× the normalized footprint; disk and compaction budgets must reflect it |
| Consistency | Each table is independently repairable and independently correct | Cross-table consistency is application-owned; `nodetool repair` will not help |
| Failure handling | Idempotent writes make retries free and reconciliation straightforward | You must actually build the outbox and the reconciler — they are not optional |
| Atomicity | Logged batches give all-or-nothing across partitions when you need it | 2–3× latency, batchlog load, no isolation and no rollback |
| Schema evolution | Adding a table is non-breaking and zero-downtime | Changing a primary key is impossible in place; every change is a dual-write migration |
| Operational clarity | No hidden server-side machinery; every write is visible in your code | More application code than a materialized view, and every service must use the same write path |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Using a logged batch as a performance optimization.** Cross-partition batches are *slower* than parallel writes because of the batchlog. ✅ Use logged batches only for genuine atomicity; use `UNLOGGED` only when every statement hits the same partition.
2. ⚠️ **Sequential fan-out writes.** `for stmt in stmts: session.execute(stmt)` costs `N × RTT`. ✅ `execute_async` everything, then collect futures — latency becomes `max()` instead of `sum()`.
3. ⚠️ **Non-idempotent writes in the fan-out** (counters, read-modify-write, ids generated per statement). Retries then corrupt state. ✅ Compute all identity at the edge, write absolute values, set `is_idempotent = True`, and use `USING TIMESTAMP` from the logical event.
4. ⚠️ **Assuming `nodetool repair` fixes cross-table drift.** It reconciles replicas *of one table* and has no concept of derivation. ✅ Build an explicit reconciliation job over token ranges from a designated source of truth.
5. ⚠️ **Not designating a source of truth.** Without one there is nothing to reconcile *to*, and a divergence has no correct answer. ✅ Pick the table with the most complete row (usually the by-id table), document it, and make every other table re-derivable from it.
6. ⚠️ **Swallowing a failed write.** A dropped fan-out write becomes silent, permanent drift. ✅ Retry with backoff, then publish to a durable outbox (Kafka, or a `pending_writes` table) that the reconciler drains.
7. ⚠️ **Letting each service write the tables its own way.** Five services, five subtly different fan-outs, guaranteed drift. ✅ One library or one service owns the write path; everyone else calls it.
8. ⚠️ **Forgetting to bucket a derived table.** `orders_by_region` without a `day` grows unbounded even though `orders_by_user` is fine. ✅ Size every derived table independently against the **< 100 MB / < 100k rows** budget.
9. ⚠️ **Denormalizing mutable attributes into many tables.** A user renaming themselves then requires updating every copy. ✅ Duplicate immutable facts freely; for mutable attributes, either store an id and look it up, or accept a bounded staleness window and update asynchronously.
10. ⚠️ **Deleting and re-inserting to "update" a derived row whose clustering values changed.** That leaves a tombstone per update. ✅ Model state transitions as new rows with a TTL, or key the derived table so the changing attribute is not part of the key.
11. ⚠️ **Skipping the capacity math.** A 5-way fan-out at 10k events/s is 50k writes/s, not 10k. ✅ Multiply event rate by fan-out width when sizing the cluster, and track `Local write count` per table to verify.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Drift is the characteristic failure, and it is silent. The tool is the reconciler itself: run it in report-only mode and emit the per-table drift count as a metric — a step change in that gauge points straight at a deploy. When a specific order is "missing from my orders list", read the source-of-truth row and the derived row directly and compare their write timestamps with `SELECT WRITETIME(col)`; a missing derived row means a dropped write, while an older timestamp means an out-of-order retry that a client-side timestamp would have prevented. For latency problems, `TRACING ON` a fan-out write shows whether statements were serialized or parallel, and the client-side span breakdown usually reveals a driver misconfiguration (unprepared statements losing token awareness) rather than a server issue. Batch misuse announces itself in `system.log` as `Batch for [table] is of size X, exceeding specified threshold`.

**Monitoring.** Track per-table `org.apache.cassandra.metrics:type=Table,keyspace=<ks>,scope=<table>,name=WriteLatency` and `...name=CoordinatorWriteLatency`, plus `...type=ClientRequest,scope=Write,name=Timeouts` and `...name=Unavailables`. Batch health lives in `...type=Table,keyspace=system,scope=batches,name=...` — a growing `system.batches` size means batchlog replay is falling behind and cross-table atomicity is being deferred. Hinted handoff is your early warning for silent divergence: `...type=Storage,name=TotalHints` and `...name=TotalHintsInProgress` climbing means writes are being buffered rather than applied. Finally, export the reconciler's drift counter and alert on any non-zero sustained value; it is the only metric that observes the property you actually care about.

**Security.** Duplication multiplies your exposure surface: a PII column now exists in three tables and three sets of SSTables, three backups, and three grant statements. Enumerate every table containing each sensitive attribute and keep that list in the same place as your `GRANT` policy — per-table grants are the right granularity here, and denormalization is what makes them workable (a support role can be granted `orders_by_user` without `order_by_id`). If you encrypt fields client-side, encrypt them identically in every copy or reconciliation will report permanent false drift. Enable 4.0 audit logging on the source-of-truth table at minimum, and remember that a right-to-erasure request must delete from *every* copy plus honour `gc_grace_seconds` before the data is truly gone.

**Performance & scaling.** Denormalization scales beautifully on reads and linearly on writes, so capacity planning is arithmetic: `required_write_capacity = event_rate × fan_out_width × RF`. Watch the ratio of `Local write count` across tables — it should match your expected fan-out exactly, and a mismatch is a bug. Compaction load also scales with fan-out, so choose strategies per table (`TimeWindowCompactionStrategy` for TTL'd bucketed tables, `LeveledCompactionStrategy` for read-heavy update tables) rather than leaving everything on the default. When a single derived table becomes the write bottleneck, shard its partition key wider rather than adding nodes. And when a derived table stops being read, *drop it* — every table you retire returns write capacity, storage and compaction headroom immediately.

---

## 9. Interview Questions

**Q: Why does Cassandra require denormalization?**
A: Because there is no join operator and no cross-partition query planner, so data needed by one query must already be co-located in one partition. The only way to serve several differently-shaped queries is to store the fact once per shape, which makes each read a single-partition seek.

**Q: What does a logged batch actually guarantee?**
A: Atomicity — every mutation will eventually be applied, or none was durably recorded — implemented by writing the mutations to `system.batches` on two replicas before applying them. It does not provide isolation, rollback, or conflict detection, and other readers can observe a partially applied batch.

**Q: When is an unlogged batch appropriate?**
A: When every statement targets the same partition. Cassandra then compiles them into a single mutation, which is genuinely atomic and isolated for that partition and costs no more than one write. Across partitions, an unlogged batch is simply a slower, riskier way to issue parallel writes.

**Q: How do you keep multiple query tables consistent without transactions?**
A: Make every write idempotent (identity computed once, absolute values, explicit `USING TIMESTAMP`), issue them in parallel with retries and a durable outbox for exhausted failures, and run a reconciliation job that re-derives derived tables from a designated source-of-truth table by token range.

**Q: Does `nodetool repair` help with cross-table drift?**
A: No. Repair compares replicas of a single table and streams the differences; it has no notion that one table is derived from another. Cross-table consistency is entirely application-owned.

**Q: What is a source-of-truth table and why do you need one?**
A: It is the one table designated as authoritative, from which every other copy can be re-derived — usually the by-id table with the most complete row. Without it, a divergence between two copies has no defined correct answer, and there is nothing to backfill or reconcile from.

**Q: How much storage should you budget for denormalization?**
A: Typically 3–6× a normalized footprint, depending on how many query shapes you serve and how much of each row they carry. That is a deliberate purchase of bounded read latency; disk, compaction throughput and backup windows all need to be sized for it.

**Q: (Senior) Three of five fan-out writes succeed and the process crashes. What is the state, and how does it heal?**
A: Two derived tables are missing the row; the three that succeeded are durable and will converge internally via hinted handoff and repair. Nothing rolls back. Healing depends on the design: if identity was computed at the edge and persisted to an outbox before the fan-out, a consumer replays the missing writes idempotently; otherwise the reconciliation job detects the missing rows on its next pass over that token range and re-derives them from the source of truth. If atomicity across those specific tables was a business requirement, they should have been in a logged batch, whose batchlog would have replayed them automatically.

**Q: (Senior) When would you choose a logged batch over parallel idempotent writes?**
A: When a partial outcome is *semantically invalid* rather than merely stale — double-entry ledger rows, a reservation plus its inventory decrement, a "both rows or neither" invariant. In those cases the 2–3× latency and the batchlog load are worth it. For read models — feeds, dashboards, search shapes, denormalized lists — a partial outcome is temporary staleness that reconciliation fixes, so parallel writes are strictly better on latency, throughput and blast radius.

**Q: (Senior) How do you add a sixth query table to a live system with 2 TB per node?**
A: Create the table, deploy the dual write behind a feature flag so all new events populate it, then backfill history with a token-range job (Spark Cassandra Connector or a paged reader) throttled to leave headroom for live traffic, using the original event timestamps via `USING TIMESTAMP` so backfilled rows never overwrite newer live writes. Verify with per-range count comparisons against the source of truth, run the reconciler until drift is zero, then cut reads over behind the flag and monitor for a full traffic cycle before removing the flag.

**Q: How do you handle updating a mutable attribute that has been denormalized into six tables?**
A: Prefer not to denormalize mutable attributes — store an immutable id and resolve the current value from a small, cached lookup table. Where the attribute must be embedded for read performance, accept a bounded staleness window and propagate the change asynchronously through the same fan-out write path, driven by the source-of-truth update, with the reconciler as the backstop.

**Q: What is write amplification here and how do you plan for it?**
A: It is the ratio of physical writes to logical events — a 5-table fan-out has an amplification of 5, multiplied again by replication factor at the storage layer. Cluster capacity must be sized as `event_rate × fan_out_width × RF`, and you verify the model in production by comparing `Local write count` across the tables, which should sit in exactly the expected ratio.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** No joins means the reassembly happens at write time: one table per query, the same fact stored in each, every read a single partition. Writes are appends so the fan-out is cheap in latency (issue them async, cost is `max` not `sum`) but expensive in capacity (`event_rate × fan_out × RF`). Cross-table consistency is yours: compute identity once at the edge, make every write idempotent with `USING TIMESTAMP`, retry with backoff, push exhausted failures to a durable outbox, and run a token-range reconciler against a designated source-of-truth table. `nodetool repair` fixes replicas of one table and nothing across tables. Use a logged batch only when a partial outcome is semantically invalid — it costs 2–3× and gives atomicity without isolation. An unlogged same-partition batch is the only batch that is genuinely faster.

| Item | Value / Command |
| --- | --- |
| Fan-out latency | ≈ `max(writes)` with async execution |
| Fan-out capacity | `event_rate × fan_out_width × RF` |
| Storage multiplier | typically 3–6× normalized |
| Logged batch cost | +1 durable write to 2 replicas; ≈ 2–3× latency |
| Same-partition batch | `BEGIN UNLOGGED BATCH` — one mutation, atomic and isolated |
| Idempotence toolkit | edge-computed ids · absolute values · `USING TIMESTAMP` · `is_idempotent=True` |
| Batch guardrails | `batch_size_warn_threshold: 5KiB`, `fail: 50KiB` |
| Cross-partition guard | `unlogged_batch_across_partitions_warn_threshold: 10` |
| Hint window | `max_hint_window: 3h` |
| Reconcile pattern | iterate `token(pk)` over `num_nodes × 4` ranges at `LOCAL_ONE` |
| Diagnose staleness | `SELECT WRITETIME(col) FROM ...` |
| Repair scope | within one table only — never across tables |

**Flash cards**

- **Why denormalize in Cassandra?** → No joins; the read must find everything already in one partition.
- **What does a logged batch give you?** → Atomicity via the batchlog — not isolation, not rollback.
- **Which batch is actually faster?** → `UNLOGGED` with every statement in the same partition.
- **What makes a fan-out write safe to retry?** → Edge-computed identity, absolute values, and an explicit `USING TIMESTAMP`.
- **What fixes cross-table drift?** → A reconciliation job over token ranges from the source of truth — never `nodetool repair`.

---

## 11. Hands-On Exercises & Mini Project

- [ ] On a 3-node cluster (`ccm` or Docker), build `order_by_id`, `orders_by_user` and `orders_by_region_day`, then implement `place_order` twice — sequentially and with `execute_async` — and measure the p99 latency difference over 10k orders.
- [ ] Implement the same fan-out as a cross-partition `LOGGED BATCH` and compare write p50/p99 and `system.batches` growth against the parallel version. Record the multiplier.
- [ ] Break one write deliberately (point one prepared statement at a dropped table), run 50k orders, then write and run the token-range reconciler and confirm it repairs exactly the missing rows.
- [ ] Write the same row twice with the *same* `USING TIMESTAMP` and once with a later one, then use `SELECT WRITETIME(status)` to demonstrate why edge-computed timestamps make retries deterministic.
- [ ] Load 5 M orders and use `nodetool tablestats` to compare `Local write count` and `Space used (live)` across the three tables; verify the ratios match your intended fan-out and compute the storage multiplier.

### Mini Project — "A denormalized order service with a reconciler"

**Goal.** Build a small service that owns one write path, serves four access patterns from four tables, and proves it can detect and repair drift.

**Requirements.**
1. Model four access patterns (order by id, orders by user, orders by region and day, orders by status and day) as four tables, each sized against the < 100 MB / < 100k-row budget with explicit bucketing where needed.
2. Implement a single `OrderWriter` class that owns the entire fan-out: prepared token-aware statements, `LOCAL_QUORUM`, edge-computed identity, `USING TIMESTAMP`, async execution, jittered retries, and a durable outbox table for exhausted failures.
3. Justify in code comments, per table, whether its write belongs in a logged batch or in the convergent path.
4. Implement a token-range reconciler that runs in report-only and repair modes, emits a drift gauge, and drains the outbox.
5. Run a chaos test: kill a node mid-load, drop 1 % of writes at the client, then show the reconciler bringing drift back to zero and report the time to converge.

**Extensions.** Add a fifth access pattern to the live system using the dual-write plus token-range-backfill procedure and measure the impact on live traffic. Replace the outbox with a Kafka topic and a consumer. Compare the whole design against a materialized view for one of the four tables, measuring write latency, recovery time after a node failure, and lines of code.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Query-First Data Modeling* produces the table set this chapter maintains. *Materialized Views* is the server-side alternative to the fan-out write, with a very different failure profile. *Secondary Indexes, SAI & SASI* is the other shortcut people take instead of duplicating. *Batches & Lightweight Transactions* goes deeper on the batchlog and Paxos. *Data Modeling Anti-Patterns* catalogues what unbucketed and unreconciled denormalization looks like when it fails, and *Repair, Hinted Handoff & Anti-Entropy* explains the per-table convergence machinery.

- **Data Modeling: Denormalization and Duplication** — Apache Cassandra Documentation · *Beginner–Intermediate* · The official statement of why duplication is the intended design and how table-per-query follows from it. <https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/data-modeling_queries.html>
- **CQL BATCH Reference** — Apache Cassandra Documentation · *Intermediate* · Exact semantics of logged vs unlogged batches, atomicity without isolation, and the size guardrails. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/dml.html#batch>
- **Cassandra Anti-Patterns: Misusing Batches** — DataStax · *Intermediate* · The definitive explanation of why cross-partition batches are slower than parallel writes, with measurements. <https://www.datastax.com/blog/cassandra-anti-patterns-logged-batches-and-unlogged-batches>
- **Spark Cassandra Connector** — DataStax (GitHub) · *Advanced* · The reference implementation of token-range parallel scanning used by every serious backfill and reconciliation job. <https://github.com/datastax/spark-cassandra-connector>
- **The Last Pickle — Batches, Repair and Consistency posts** — The Last Pickle / DataStax · *Intermediate–Advanced* · Practitioner deep dives on batchlog behaviour, hinted handoff limits and what repair does and does not cover. <https://thelastpickle.com/blog/>
- **Netflix Technology Blog — Cassandra at scale** — Netflix Engineering · *Intermediate* · Real accounts of denormalized data models, multi-region write paths and reconciliation at very large scale. <https://netflixtechblog.com/tagged/cassandra>
- **How Discord Stores Trillions of Messages** — Discord Engineering · *Intermediate* · A concrete denormalized, bucketed design and the operational realities of maintaining it. <https://discord.com/blog/how-discord-stores-trillions-of-messages>
- **ScyllaDB University — Data Modeling and Consistency** — ScyllaDB · *Intermediate* · Free lessons on denormalization trade-offs and consistency levels in a compatible implementation. <https://university.scylladb.com/courses/data-modeling/>

---

*Apache Cassandra Handbook — chapter 11.*
