# 15 · TTL, Counters & Static Columns

> **In one line:** Three CQL features that each bend the pure upsert model — TTL turns time into tombstones, counters trade idempotence for distributed addition, and static columns give every partition a shared header row.

---

## 1. Overview

Chapter 13 established the core rule: every Cassandra write is a blind, idempotent, timestamped upsert. This chapter covers the three features that deliberately break that rule, each for a good reason, and each with a sharp edge that shows up in production six months later.

**TTL (time to live)** attaches an expiry to a cell. When wall-clock time passes the expiry, the cell stops being returned by reads and, at the next compaction after `gc_grace_seconds`, is physically dropped. This is how you build session stores, rate limiters, OTP tables, and any workload where data has a natural lifetime. The problem it solves is real: without TTL you would have to run a delete job over billions of rows, which in Cassandra means writing billions of tombstones. TTL lets the storage engine do the deletion for free — but expired cells *become tombstones*, so a table with a bad TTL/compaction pairing produces exactly the tombstone storm you were trying to avoid.

**Counters** solve the problem that read-modify-write cannot. "Increment the view count of this video" is impossible with plain upserts, because two clients would both read 100 and both write 101. Cassandra's counter type implements a distributed accumulator: each replica keeps a per-node shard of the total and increments are merged by summing shards rather than by last-write-wins. This makes counters the *only* CQL type whose writes are not idempotent — a retried increment double-counts — and forces a genuine read-before-write on the replica, which is why counter writes are several times more expensive than normal ones.

**Static columns** solve a modelling problem. In a wide-row table like `orders_by_customer((customer_id), order_id)`, the customer's name is the same for every clustering row. Repeating it per row wastes space and creates update anomalies. A `STATIC` column is stored once per partition, outside the clustering rows, and is visible from every row in that partition — effectively a per-partition header. It is also the only way to read a partition-level attribute without a second table, and the only place LWTs can express "check the partition header, then write a row".

The historical arc matters: counters shipped in 0.8 with a fundamentally broken replication design and were rewritten in 2.1 (CASSANDRA-6504) to fix the "counters drift after repair" class of bugs; TTL got its 20-year overflow bug fixed in 3.0.14/3.11.0 (CASSANDRA-14092, `max_ttl` capped at 20 years); static columns arrived with CQL3's storage-engine unification in 1.2.

A concrete example: a video platform keeps `video_stats((video_id))` with a `title text STATIC`, per-day clustering rows holding `views counter`, and a separate `watch_sessions` table where every row carries `TTL 86400` so the raw session data self-destructs after a day while the aggregated counters persist forever. Three features, three different jobs, one data model.

## 2. Core Concepts

- **TTL** — a per-cell expiry in seconds, set via `USING TTL n` on a write or as a table `default_time_to_live`. Applies to *cells*, not rows, so different columns of one row can expire at different times.
- **`localDeletionTime`** — the epoch second at which a cell becomes an expiring tombstone; stored alongside the cell so every replica agrees on expiry without coordination.
- **Expired cell → tombstone** — an expired cell is not immediately removed; it converts to a tombstone that must survive `gc_grace_seconds` before compaction can drop it, exactly like a `DELETE`.
- **`default_time_to_live`** — a table property applying a TTL to every write that does not specify one. Setting it to `0` (default) means no expiry.
- **Counter column** — a 64-bit signed value supporting only `+=` / `-=`, stored as a set of per-node shards `(node_id, clock, count)`; the logical value is the sum of shards.
- **Counter table restriction** — a table may contain counter columns *only* if all non-primary-key columns are counters; you cannot mix counters and regular columns.
- **Non-idempotence** — a counter update replayed after a timeout applies twice. There is no way to make a counter increment safely retryable.
- **Static column** — a column declared `STATIC`, stored once per partition and shared by every clustering row. Requires the table to have at least one clustering column.
- **Static-only read** — `SELECT static_col FROM t WHERE pk = ?` returns exactly one row even for a partition with a million clustering rows, because static data lives outside them.
- **`counter_write_request_timeout`** — a separate, longer timeout (5 s default) reflecting that counter writes do a local read first.

## 3. Theory & Internals

**TTL internals.** When you write `USING TTL 3600`, the cell is stored with three fields instead of one: `value`, `timestamp` (microseconds, for LWW), and `localDeletionTime = now_seconds + 3600`. Every replica computes `localDeletionTime` from the *coordinator's* clock at write time and stores the absolute value, so expiry is deterministic and needs no further coordination — a replica that is down for two hours brings back cells that are already expired.

At read time, the merge step compares `localDeletionTime` against the current second; expired cells are filtered out and counted as tombstones in `TombstoneScannedHistogram`. At compaction time, an expired cell can only be *dropped* if `localDeletionTime + gc_grace_seconds < now` **and** the compaction includes every SSTable that could hold older data for that key (otherwise dropping it could resurrect shadowed data). This is why a table with `TTL 3600` and `gc_grace_seconds = 864000` keeps expired data on disk for ten days. For pure-TTL tables with no explicit deletes, setting `gc_grace_seconds = 0` and using `TimeWindowCompactionStrategy` lets whole SSTables be dropped at once — the single most effective TTL optimisation there is.

TTL arithmetic to remember: `TTL` is capped at `max_ttl` = 630720000 seconds (20 years). A cell's remaining TTL is queryable with `TTL(col)`; the primary key columns have no TTL of their own, so if every non-key cell of a row expires, the row disappears — unless the row was created by `INSERT` with a TTL, in which case the liveness marker carries the same TTL and expires with it.

**Counter internals.** A counter column's on-disk representation is a list of shards: `(counter_id, clock, count)` where `counter_id` identifies the node that owned the increment and `clock` is a per-node logical counter. Merging two counter cells takes, for each `counter_id`, the shard with the higher `clock` — and then sums across ids. This makes merging associative, commutative, and idempotent *per shard*, which is what makes repair safe.

The write path is genuinely different. The coordinator picks one replica as the *leader* for that counter update. The leader performs a **local read** of the current shard, computes the new shard value, writes it locally, and then replicates the resulting *shard state* (not the delta) to the other replicas. That is why counter writes require a read, take longer, and have their own timeout. It is also why a client-side retry after a timeout is unsafe: if the leader applied the increment before the ack was lost, the retry adds the delta a second time.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="320" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">Counter shards: merge takes max clock per node, then sums</text>
  <rect x="20" y="50" width="200" height="110" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="120" y="72" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Replica A copy</text>
  <text x="120" y="96" text-anchor="middle" font-size="11" fill="#1e293b">(nodeA, clock=7, +40)</text>
  <text x="120" y="116" text-anchor="middle" font-size="11" fill="#1e293b">(nodeB, clock=3, +10)</text>
  <text x="120" y="140" text-anchor="middle" font-size="11" fill="#1e293b">local value = 50</text>
  <rect x="20" y="176" width="200" height="110" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="120" y="198" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Replica B copy</text>
  <text x="120" y="222" text-anchor="middle" font-size="11" fill="#1e293b">(nodeA, clock=5, +25)</text>
  <text x="120" y="242" text-anchor="middle" font-size="11" fill="#1e293b">(nodeB, clock=6, +18)</text>
  <text x="120" y="266" text-anchor="middle" font-size="11" fill="#1e293b">local value = 43</text>
  <path d="M228 105 L300 155" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <path d="M228 231 L300 175" stroke="#0ea5e9" stroke-width="1.5" fill="none"/>
  <rect x="305" y="130" width="150" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="380" y="155" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Reconcile</text>
  <text x="380" y="176" text-anchor="middle" font-size="11" fill="#1e293b">max(clock) per nodeId</text>
  <path d="M460 165 L505 165" stroke="#16a34a" stroke-width="2" fill="none"/>
  <path d="M505 165 l-9 -5 v10 z" fill="#16a34a"/>
  <rect x="510" y="110" width="190" height="110" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="605" y="134" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Merged</text>
  <text x="605" y="158" text-anchor="middle" font-size="11" fill="#1e293b">(nodeA, clock=7, +40)</text>
  <text x="605" y="178" text-anchor="middle" font-size="11" fill="#1e293b">(nodeB, clock=6, +18)</text>
  <text x="605" y="202" text-anchor="middle" font-size="11" font-weight="600" fill="#1e293b">value = 58</text>
  <text x="360" y="305" text-anchor="middle" font-size="11" fill="#1e293b">Merging is idempotent per shard, so repair is safe &#8212; but a client retry creates a NEW clock, so it double-counts.</text>
</svg>
```

**Static column internals.** Static cells are stored in the partition's static row, physically written before the first clustering row in the SSTable and indexed separately. Reading them costs nothing extra when you already touch the partition; reading *only* statics (`SELECT name FROM t WHERE pk = ?` where `name` is static) lets Cassandra skip the clustering rows entirely — a genuinely cheap "partition header" read. Writing a static column requires only the partition key: `UPDATE t SET name = 'Ada' WHERE pk = ?` is legal even with clustering columns declared, and it does *not* create a clustering row. Static columns participate in LWT conditions, which enables the one cross-row-ish conditional Cassandra supports: `INSERT INTO t (pk, ck, v) VALUES (?,?,?) IF static_col = ?`.

## 4. Architecture & Workflow

Trace a TTL write, a counter increment, and a static update through the cluster:

1. **TTL write arrives.** `INSERT INTO sessions (...) VALUES (...) USING TTL 86400`. The coordinator stamps `timestamp = now_micros` and each cell gets `localDeletionTime = now_secs + 86400`.
2. **Replicas apply blindly.** Commitlog + memtable, exactly like any write. No read, no coordination — expiry is already encoded in the cell.
3. **Flush and compaction.** The memtable flushes to an SSTable whose metadata records `minLocalDeletionTime` / `maxLocalDeletionTime`. With `TimeWindowCompactionStrategy`, cells written in the same window land in the same SSTable.
4. **Whole-SSTable drop.** Once every cell in an SSTable is expired past `gc_grace_seconds`, compaction drops the *entire file* without rewriting anything — near-zero-cost deletion. This only works if TTLs are uniform and the table has no out-of-order writes.
5. **Counter increment arrives.** `UPDATE video_stats SET views = views + 1 WHERE video_id = ?`. The coordinator selects a **leader replica** (the first live replica in the natural order).
6. **Leader local read.** The leader reads its own current shard for that counter from memtable + SSTables — a genuine read-before-write, charged to `counter_write_request_timeout` (5 s).
7. **Leader applies and replicates state.** The leader writes the new shard `(nodeId, clock+1, count+1)` locally, then sends the *resulting shard*, not the delta, to the other replicas, which apply it idempotently.
8. **Read merges shards.** A `SELECT views` merges all shards from all SSTables and replicas: for each `nodeId` take the highest `clock`, then sum.
9. **Static write arrives.** `UPDATE video_stats SET title = 'Ring theory' WHERE video_id = ?` — no clustering key needed. It writes one cell into the partition's static row.
10. **Read fan-in.** `SELECT title, day, views FROM video_stats WHERE video_id = ?` returns the static `title` repeated on every clustering row in the result set; `SELECT title FROM video_stats WHERE video_id = ?` returns a single row and skips clustering rows entirely.

```svg
<svg viewBox="0 0 720 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="330" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">Partition layout: static row, clustering rows, TTL expiry</text>
  <rect x="30" y="50" width="640" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="60" y="70" font-size="12" font-weight="600" fill="#1e293b">STATIC ROW</text>
  <text x="60" y="88" font-size="11" fill="#1e293b">title = 'Ring theory'   owner = 'ada'   (one copy per partition, no clustering key)</text>
  <rect x="30" y="106" width="640" height="42" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="60" y="124" font-size="12" font-weight="600" fill="#1e293b">day = 2026-07-20</text>
  <text x="300" y="124" font-size="11" fill="#1e293b">views(counter) = 4102</text>
  <text x="500" y="124" font-size="11" fill="#1e293b">no TTL</text>
  <text x="60" y="141" font-size="10" fill="#1e293b">clustering row</text>
  <rect x="30" y="156" width="640" height="42" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="60" y="174" font-size="12" font-weight="600" fill="#1e293b">day = 2026-07-21</text>
  <text x="300" y="174" font-size="11" fill="#1e293b">views(counter) = 918</text>
  <text x="500" y="174" font-size="11" fill="#1e293b">no TTL</text>
  <text x="60" y="191" font-size="10" fill="#1e293b">clustering row</text>
  <rect x="30" y="206" width="640" height="42" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="60" y="224" font-size="12" font-weight="600" fill="#1e293b">session = a91f...</text>
  <text x="300" y="224" font-size="11" fill="#1e293b">payload (TTL 86400)</text>
  <text x="500" y="224" font-size="11" fill="#1e293b">localDeletionTime set</text>
  <text x="60" y="241" font-size="10" fill="#1e293b">separate table, same idea</text>
  <rect x="30" y="256" width="640" height="42" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="60" y="274" font-size="12" font-weight="600" fill="#1e293b">after expiry</text>
  <text x="300" y="274" font-size="11" fill="#1e293b">cell &#8594; tombstone</text>
  <text x="500" y="274" font-size="11" fill="#1e293b">dropped after gc_grace</text>
  <text x="360" y="318" text-anchor="middle" font-size="11" fill="#1e293b">SELECT static_col WHERE pk=? reads only the yellow row. SELECT * fans the static value onto every row.</text>
</svg>
```

## 5. Implementation

```cql
CREATE KEYSPACE media WITH replication = {
  'class': 'NetworkTopologyStrategy', 'us_east': 3, 'eu_west': 3
};

-- Static column: one title per video, shared by every daily row
CREATE TABLE media.video_daily (
  video_id  uuid,
  day       date,
  title     text STATIC,
  owner_id  uuid STATIC,
  bytes_out bigint,
  PRIMARY KEY (video_id, day)
) WITH CLUSTERING ORDER BY (day DESC);

-- Counters must live alone: every non-key column is a counter
CREATE TABLE media.video_counters (
  video_id uuid,
  day      date,
  views    counter,
  likes    counter,
  PRIMARY KEY (video_id, day)
);

-- TTL table: TWCS + gc_grace_seconds = 0 so whole SSTables drop
CREATE TABLE media.watch_sessions (
  user_id    uuid,
  session_id timeuuid,
  video_id   uuid,
  position_s int,
  PRIMARY KEY (user_id, session_id)
) WITH default_time_to_live = 86400
  AND gc_grace_seconds = 0
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'HOURS',
                    'compaction_window_size': 6};
```

TTL in practice:

```cql
INSERT INTO media.watch_sessions (user_id, session_id, video_id, position_s)
VALUES (?, now(), ?, 0);                       -- inherits default_time_to_live = 86400

UPDATE media.watch_sessions USING TTL 3600
   SET position_s = 415 WHERE user_id = ? AND session_id = ?;   -- resets TTL on this cell only

SELECT position_s, TTL(position_s), TTL(video_id) FROM media.watch_sessions
 WHERE user_id = ? AND session_id = ?;
--  position_s | ttl(position_s) | ttl(video_id)
-- ------------+-----------------+---------------
--         415 |            3597 |         82940      <-- different expiry per cell!

UPDATE media.watch_sessions USING TTL 0
   SET position_s = 415 WHERE user_id = ? AND session_id = ?;   -- TTL 0 = never expire
```

> **The TTL trap above is the most common one in the wild:** updating one column with a fresh TTL does not extend the others. When the un-refreshed columns expire, you are left with a partially-null row that still exists. Always rewrite the *whole row* with a uniform TTL.

Counters:

```cql
UPDATE media.video_counters SET views = views + 1
 WHERE video_id = 6f1c2d10-6a1c-11f0-9c3d-0242ac120002 AND day = '2026-07-22';

UPDATE media.video_counters SET views = views + 250, likes = likes + 3
 WHERE video_id = ? AND day = ?;

SELECT day, views, likes FROM media.video_counters WHERE video_id = ? AND day = '2026-07-22';
--  day        | views | likes
-- ------------+-------+-------
--  2026-07-22 |  41203|   987

-- Legal but destructive: the only way to "set" a counter
DELETE views FROM media.video_counters WHERE video_id = ? AND day = ?;
-- WARNING: the deleted counter can NEVER be safely re-incremented on this key.
```

Static columns, including the one conditional trick they enable:

```cql
UPDATE media.video_daily SET title = 'Ring theory' WHERE video_id = ?;   -- no clustering key
SELECT title FROM media.video_daily WHERE video_id = ?;                  -- 1 row, skips clustering rows

INSERT INTO media.video_daily (video_id, day, bytes_out) VALUES (?, '2026-07-22', 91234)
  IF owner_id = 11111111-1111-1111-1111-111111111111;   -- LWT condition on a STATIC column
```

Python driver — note the idempotence flags:

```python
from cassandra.cluster import Cluster
from cassandra.query import ConsistencyLevel

session = Cluster(["10.0.1.11"]).connect("media")

bump = session.prepare(
    "UPDATE video_counters SET views = views + ? WHERE video_id = ? AND day = ?")
bump.consistency_level = ConsistencyLevel.LOCAL_QUORUM
bump.is_idempotent = False          # CRITICAL: a retried increment double-counts

touch = session.prepare(
    "INSERT INTO watch_sessions (user_id, session_id, video_id, position_s) "
    "VALUES (?, ?, ?, ?) USING TTL ?")
touch.is_idempotent = True          # plain TTL upsert: safe to retry

session.execute(bump, (1, video_id, day))
session.execute(touch, (user_id, session_uuid, video_id, 415, 86400))

# Batch many increments locally, flush one aggregate write per second per key:
# 1000 x (+1) becomes 1 x (+1000) -> 1000x fewer leader reads.
```

Verify TTL drop behaviour on disk:

```bash
nodetool flush media watch_sessions
sstablemetadata /var/lib/cassandra/data/media/watch_sessions-*/nb-1-big-Data.db | \
  grep -E "Minimum local deletion|Maximum local deletion|Estimated droppable tombstones"
# Minimum local deletion time: 1785000123
# Maximum local deletion time: 1785086523
# Estimated droppable tombstones: 0.97      <-- 97% droppable, TWCS will drop the whole file

nodetool compactionstats
nodetool tablestats media.video_counters | grep -i "local write latency"
# Local write latency: 1.243 ms      (vs ~0.05 ms for a non-counter table)
```

> **Optimization:** pre-aggregate counters at the application edge. A counter write costs a leader-side read, so 50,000 `+1` operations per second on one key will saturate a replica. Buffer in-process for 1 second and issue one `+50000`. Combine with `TimeWindowCompactionStrategy` on TTL tables and `gc_grace_seconds = 0` (safe *only* if you never issue explicit `DELETE`s on that table and rely on TTL alone) to convert deletion from a rewrite into a file unlink.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| TTL | Automatic expiry with zero delete traffic; perfect for sessions/OTP/rate limits | Expired cells become tombstones; wrong compaction strategy turns this into read amplification |
| `default_time_to_live` | Uniform expiry, enables whole-SSTable drops under TWCS | Silently applies to every write; a forgotten `USING TTL 0` is impossible to distinguish later |
| Per-cell TTL granularity | Different columns can expire independently | Produces partially-expired rows that "exist" with null columns — a frequent bug source |
| Counters | The only way to do distributed accumulation without CAS | Non-idempotent, leader-side read on every write, ~10–25× the latency of a normal write |
| Counter merge by shard | Repair-safe, no LWW conflicts, correct under concurrency | Deleting a counter permanently poisons the key; no way to "set" a value |
| Counter table isolation | Simple, correct storage layout | Cannot mix counters with regular columns — forces a second table and a second write |
| Static columns | One copy per partition; cheap partition-header reads; usable in LWT conditions | Requires clustering columns; a hot static column is a hot partition; not available in `WHERE` |
| Static + LWT | The only conditional that reads partition-level state | Full Paxos cost, and only within a single partition |

## 7. Common Mistakes & Best Practices

1. ⚠️ Updating one column with a fresh TTL and assuming the whole row is extended. → ✅ TTL is per cell. Rewrite every non-key column with the same `USING TTL` on each refresh, or use `default_time_to_live` and always do full-row inserts.
2. ⚠️ Using TTL with the default `SizeTieredCompactionStrategy` on a time-series table. → ✅ Use `TimeWindowCompactionStrategy` so expired data clusters into droppable SSTables; STCS scatters expiry across files and rewrites data forever.
3. ⚠️ Leaving `gc_grace_seconds = 864000` on a pure-TTL table. → ✅ If the table never receives explicit `DELETE`s, drop it to a small value (or 0 with TWCS) so expired SSTables are removed promptly. Keep the default whenever real deletes exist.
4. ⚠️ Retrying counter updates on timeout. → ✅ Counter writes are not idempotent; a retry double-counts. Set `is_idempotent = False`, and accept undercounting rather than overcounting, or reconcile from an event log.
5. ⚠️ Using counters for anything requiring exactness (money, inventory, billing). → ✅ Counters are approximate under failure. Use an append-only event table plus periodic aggregation, or LWT-guarded values, for anything auditable.
6. ⚠️ `DELETE`ing a counter column and then incrementing the same key again. → ✅ Documented as unsafe: the delete's shard state can resurrect and produce wrong values. Treat counter deletion as permanent retirement of that key.
7. ⚠️ A single hot counter key (`views` on the front-page video). → ✅ Shard it: `PRIMARY KEY ((video_id, bucket), day)` with `bucket = random(0..15)`, and sum the buckets on read. Or pre-aggregate in the application.
8. ⚠️ Expecting `WHERE static_col = ?` to work. → ✅ Static columns cannot be part of the primary key or used to filter without `ALLOW FILTERING`. If you need to query by it, denormalize into a table keyed by that value.
9. ⚠️ Storing large blobs in a static column. → ✅ The static row is read on nearly every partition access; a 1 MB static blob multiplies read bandwidth by every query touching that partition.
10. ⚠️ Setting a TTL longer than `max_ttl` (20 years) or computing an expiry that overflows. → ✅ Cassandra rejects TTLs above 630720000; pre-3.0.14 clusters had the CASSANDRA-14092 overflow bug that silently produced already-expired data.
11. ⚠️ Mixing TTL'd and non-TTL'd writes in the same partition and expecting clean expiry. → ✅ A partition where 99% of cells expire and 1% do not can never be dropped wholesale; it forces per-row compaction forever. Separate the lifetimes into separate tables.
12. ⚠️ Reading a counter at `ONE` and treating the number as authoritative. → ✅ Use `LOCAL_QUORUM` for counter reads; a single replica may be missing shards from a node that was recently down.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** For TTL problems, `sstablemetadata` is the tool: it prints `Minimum/Maximum local deletion time` and `Estimated droppable tombstones` per SSTable, which tells you immediately whether compaction *can* reclaim space or is blocked by mixed lifetimes. A droppable ratio above 0.2 with no compaction happening usually means `unchecked_tombstone_compaction` is off and STCS is waiting for four similarly-sized files. For counters, compare `nodetool tablestats` local write latency against a non-counter table — a 20× gap is normal, a 200× gap means the leader read is hitting many SSTables. Use `TRACING ON` on a counter update to see the leader-side read explicitly.

**Monitoring.** Key beans: `org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=TombstoneScannedHistogram` (TTL tables live or die by this), `name=DroppableTombstoneRatio`, `name=CoordinatorWriteLatency` split by table, `type=ClientRequest,scope=CASWrite` if you use static-column LWTs, and `type=ThreadPools,path=request,scope=CounterMutationStage,name=PendingTasks` — counter mutations have their own stage, and a growing queue there is the earliest signal of counter overload. Watch `Timeouts` with `writeType=COUNTER` separately from normal write timeouts. Track `EstimatedPartitionSizeHistogram` on tables with static columns to catch a header-plus-millions-of-rows anti-pattern.

**Security.** TTL is a compliance tool: for GDPR/CCPA "retain no longer than N days" requirements, `default_time_to_live` on the table gives a provable, database-enforced ceiling that no application bug can bypass — far stronger than a cron job. Document the value in your data-retention policy and alert on schema changes to it (`system_schema.tables.default_time_to_live`). Counters carry no special auth semantics, but note that `DELETE` on a counter column is effectively irreversible corruption, so restrict `MODIFY` on counter tables tightly. Audit logging (4.0+) captures counter updates under `DML`.

**Performance & scaling.** TTL scaling is a compaction question: pair uniform TTLs with `TimeWindowCompactionStrategy` sized so each window holds roughly one TTL period's worth of data, and you get O(1) deletion via file unlink. Counter scaling is a fan-out question: one counter key is served by `RF` replicas with one leader per update, so per-key throughput is bounded by a single node's read+write path — plan for a few thousand updates/second per key at best, and shard beyond that. Static-column scaling is a partition-size question: statics are read on every partition access, so keep them small and keep partitions under 100 MB / 100k rows as always.

## 9. Interview Questions

**Q: What exactly happens when a cell's TTL expires?**
A: The cell stops being returned by reads immediately (the read path compares `localDeletionTime` to the current second) and becomes an expiring tombstone. It is only physically removed by a compaction that runs after `localDeletionTime + gc_grace_seconds` and that includes all SSTables which could hold shadowed older data for that key.

**Q: If I `UPDATE` one column with `USING TTL 60`, do the other columns expire too?**
A: No. TTL is a per-cell property, so only the cells written by that statement get the new expiry. This routinely produces rows where some columns have vanished and others remain — always rewrite the full row with a uniform TTL if you intend to refresh it.

**Q: Why can't a table mix counter columns and regular columns?**
A: Because counters use a completely different storage and reconciliation model — per-node shards merged by max-clock-then-sum, with a leader-side read on write — while regular columns use timestamped last-write-wins. Supporting both in one mutation path would require two write paths per statement, so Cassandra forbids it at schema-creation time.

**Q: Why are counter writes not idempotent?**
A: Because each increment allocates a new logical clock on the leader replica and adds the delta to that node's shard. A client retry after a lost acknowledgement produces a second shard update with a higher clock, so the delta is applied twice. There is no de-duplication token in the protocol.

**Q: What is a static column and when do you use it?**
A: A column stored once per partition and shared by all clustering rows, declared with the `STATIC` keyword on a table that has clustering columns. Use it for partition-level attributes — a customer name on an orders-by-customer table, a video title on a per-day stats table — to avoid repeating and independently updating the value on every row.

**Q: How do you read only the static columns of a huge partition cheaply?**
A: `SELECT static_col FROM t WHERE pk = ?` with no clustering restriction returns exactly one row and lets Cassandra read the partition's static row without scanning clustering rows. It is a genuine partition-header read, independent of partition size.

**Q: (Senior) A pure-TTL table is not reclaiming disk space despite everything being expired. Diagnose it.**
A: Check `sstablemetadata` for `Estimated droppable tombstones` — if it is high but nothing compacts, the strategy is the problem. Under STCS, an SSTable is only compacted when three similarly-sized peers exist, so old large files sit forever; `unchecked_tombstone_compaction: true` and `tombstone_threshold` help, but the real fix is `TimeWindowCompactionStrategy` with a window sized to the TTL, plus a `gc_grace_seconds` that is not ten days on a table with no explicit deletes. Also verify no writes are landing out-of-order into old windows, which blocks whole-file drops.

**Q: (Senior) Your view counter is 3% lower than the event log says. Explain the mechanisms that could cause it.**
A: Most likely dropped counter mutations under load — the `CounterMutationStage` queue overflows and mutations are dropped silently, visible in `nodetool tpstats`. Second, application-side retry suppression: because increments are non-idempotent, a correct client does *not* retry on timeout, so every timeout is a lost increment. Third, a replica that was down past the hint window and never repaired can leave shards missing until repair runs. Undercounting is the expected failure mode of a correctly-written counter client; overcounting means someone enabled retries.

**Q: (Senior) When would you deliberately set `gc_grace_seconds = 0`, and what is the risk?**
A: Only on a table whose sole deletion mechanism is TTL, never explicit `DELETE`, and typically paired with TWCS so entire SSTables drop. The risk is that `gc_grace_seconds` is also the window in which hinted handoff and repair must propagate deletions; with zero grace, a replica that misses an expiry-adjacent write and comes back later can resurrect data. Because TTL expiry is computed identically on every replica from the stored `localDeletionTime`, that risk is far smaller than with explicit deletes — but it is not zero if the table ever receives a `DELETE`.

**Q: Can a static column be part of the primary key or used in a WHERE clause?**
A: No to the primary key — statics are by definition not part of the key. In a `WHERE` clause they can only be used with `ALLOW FILTERING`, which means a scan. They can, however, be referenced in LWT `IF` conditions, which is their most useful advanced role.

**Q: How do you handle a counter key that is too hot?**
A: Shard it by adding a random bucket to the partition key and summing the buckets at read time, and pre-aggregate in the application so you issue one `+N` per second per key instead of N `+1` operations. Both reduce the leader-side read rate, which is the actual bottleneck.

**Q: What is the maximum TTL and why does it exist?**
A: 630720000 seconds — 20 years — enforced as `max_ttl`. The bound exists because `localDeletionTime` is a 32-bit epoch-seconds field; CASSANDRA-14092 documented an overflow bug where TTLs pushing past 2038 wrapped and produced instantly-expired data, and the cap was introduced in 3.0.14/3.11.0 to make the failure explicit rather than silent.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** TTL stores an absolute `localDeletionTime` per cell, so expiry needs no coordination — but expired cells become tombstones and are only reclaimed after `gc_grace_seconds` by a compaction that sees all relevant SSTables; pair uniform TTLs with TWCS (and a small `gc_grace_seconds` on delete-free tables) to get whole-file drops. Counters store per-node shards merged by max-clock-then-sum, which makes repair safe but writes non-idempotent and leader-read-bound; never retry them, never delete-then-reuse a key, and shard or pre-aggregate hot keys. Static columns live once per partition, are writable with only the partition key, are readable without touching clustering rows, and are the only partition-level state an LWT condition can inspect.

| Item | Value / Command |
|---|---|
| Set TTL per write | `INSERT ... USING TTL 86400` / `UPDATE ... USING TTL 3600 SET ...` |
| Table-wide TTL | `WITH default_time_to_live = 86400` |
| Disable TTL on a write | `USING TTL 0` |
| Max TTL | 630720000 s (20 years), `max_ttl` |
| Inspect remaining TTL | `SELECT TTL(col) FROM t WHERE ...` |
| TTL best-fit compaction | `TimeWindowCompactionStrategy`, window ≈ TTL / 10–30 |
| Counter update | `UPDATE t SET c = c + 1 WHERE pk = ?` (no `INSERT` allowed) |
| Counter table rule | all non-key columns must be counters |
| Counter idempotence | **never** retry; `is_idempotent = False` |
| Counter timeout knob | `counter_write_request_timeout: 5000ms` |
| Counter thread pool | `CounterMutationStage` in `nodetool tpstats` |
| Static declaration | `col type STATIC` — requires ≥1 clustering column |
| Static write | `UPDATE t SET s = ? WHERE pk = ?` (no clustering key) |
| Droppable-tombstone check | `sstablemetadata *-Data.db \| grep droppable` |

**Flash cards**
- **Is TTL per row or per cell?** → Per cell. Refreshing one column leaves the others on their original expiry.
- **What does an expired cell become?** → A tombstone, reclaimable only after `gc_grace_seconds` plus a compaction.
- **Why can't you retry a counter increment?** → It is not idempotent; the retry allocates a new clock and adds the delta twice.
- **Can a table mix counters and normal columns?** → No. Counter tables may contain only counters outside the primary key.
- **What does `SELECT static_col WHERE pk = ?` cost?** → One partition-header read, independent of how many clustering rows exist.

## 11. Hands-On Exercises & Mini Project

- [ ] Create a table with `default_time_to_live = 60`, insert rows, then `SELECT TTL(col)` every 10 seconds and watch it decrease; after expiry, run `TRACING ON` on a read and record the tombstone count.
- [ ] Update a single column of a TTL'd row with a longer `USING TTL` and prove with `SELECT TTL(a), TTL(b), TTL(c)` that the other columns keep their original expiry — then observe the partially-null row after they expire.
- [ ] Build the same table twice, once with STCS and once with TWCS (`compaction_window_unit: MINUTES, size: 2`), load 1M TTL'd rows, and compare disk usage and `sstablemetadata` droppable ratios after expiry.
- [ ] Increment a counter 100,000 times from a single-threaded client, then from 32 threads, and compare throughput and `nodetool tpstats` `CounterMutationStage` pending counts against a plain-upsert table.
- [ ] Create a table with a `STATIC` column and 50,000 clustering rows; time `SELECT static_col WHERE pk = ?` versus `SELECT *  WHERE pk = ?` and explain the difference with `TRACING ON`.

**Mini Project — a video analytics store**

*Goal:* build a stats service that keeps exact-ish daily counters, self-expiring raw sessions, and per-video metadata without duplicating it per row.

*Requirements:*
- `video_daily((video_id), day)` with `title text STATIC` and `owner_id uuid STATIC`; `video_counters((video_id), day)` with `views` and `likes` counters; `watch_sessions((user_id), session_id)` with `default_time_to_live = 86400`, TWCS, and `gc_grace_seconds = 0`.
- An ingest path that writes a session row per playback (idempotent, retryable) and buffers view increments in-process, flushing one aggregated `+N` per video per second (non-idempotent, never retried).
- A read API returning `{title, owner, views_last_7d}` using exactly two queries: one static-only read and one clustering-range read on the counter table.
- A reconciliation job that recomputes daily views from the session table before it expires and reports the drift versus the counter — quantify your undercount.
- A hot-key mode: shard the counter partition into 16 buckets and show the throughput improvement under `cassandra-stress`.

*Extensions:* add an LWT that only records a session `IF owner_id = ?` (static-column condition); measure the disk reclaimed by TWCS with `nodetool tablestats` before and after expiry; add a `retention_days` static column and enforce it with a per-write `USING TTL` computed from it.

## 12. Related Topics & Free Learning Resources

Read alongside **13 · CQL: SELECT, INSERT, UPDATE & DELETE** for the upsert and tombstone model all three features build on, **14 · Batches & Lightweight Transactions** for why counters exist instead of CAS-based increments, and **16 · Paging, ALLOW FILTERING & Query Limits** for keeping static-column and wide-partition reads bounded. Compaction-strategy and repair chapters are the natural next step for TTL operations.

- **Expiring Data with TTL** — Apache Cassandra Documentation · *Beginner* · normative TTL syntax, `default_time_to_live`, and `max_ttl` behaviour. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/dml.html#insert>
- **Counters in CQL** — Apache Cassandra Documentation · *Intermediate* · the official statement of counter restrictions, including why delete-then-reuse is unsafe. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/types.html#counters>
- **CASSANDRA-6504: Counters++ rewrite** — Apache JIRA · *Advanced* · the 2.1 redesign that made counter replication shard-based and repair-safe. <https://issues.apache.org/jira/browse/CASSANDRA-6504>
- **CASSANDRA-14092: Max TTL overflow** — Apache JIRA · *Intermediate* · the 20-year cap and the silent-data-loss bug that motivated it. <https://issues.apache.org/jira/browse/CASSANDRA-14092>
- **TWCS: TimeWindowCompactionStrategy** — The Last Pickle · *Advanced* · why TWCS is the correct pairing for TTL data and how to size windows. <https://thelastpickle.com/blog/2016/12/08/TWCS-part1.html>
- **About Deletes and Tombstones in Cassandra** — The Last Pickle · *Intermediate* · covers expiring cells as a tombstone class and the compaction rules for dropping them. <https://thelastpickle.com/blog/2016/07/27/about-deletes-and-tombstones.html>
- **Static Columns in CQL** — DataStax Documentation · *Intermediate* · storage layout, read semantics, and LWT conditions on static columns. <https://docs.datastax.com/en/cql-oss/3.3/cql/cql_reference/refStaticCol.html>
- **Cassandra Data Modeling Best Practices** — DataStax Academy · *Intermediate* · shows where statics and counters fit into query-first modelling and where they should be avoided. <https://www.datastax.com/learn/data-modeling-by-example>

---

*Apache Cassandra Handbook — chapter 15.*
