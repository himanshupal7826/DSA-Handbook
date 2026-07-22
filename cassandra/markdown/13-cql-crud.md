# 13 · CQL: SELECT, INSERT, UPDATE & DELETE

> **In one line:** CQL looks like SQL but every statement is really a partition-scoped mutation or scan against an LSM-tree, and INSERT/UPDATE are the *same* operation — a blind, read-free upsert.

---

## 1. Overview

CQL (Cassandra Query Language) is the wire-level language every Cassandra client speaks. It arrived in Cassandra 0.8 and became the only sane way to talk to the database by 3.0, when the old Thrift interface was deprecated (removed entirely in 4.0). The design goal was deliberate and slightly subversive: give developers a language that *looks* like SQL so the learning curve is near zero, while quietly removing every construct that cannot be executed in bounded time on a masterless, shared-nothing ring. There are no joins. There are no correlated subqueries. There is no `SELECT ... FOR UPDATE`. What remains — `SELECT`, `INSERT`, `UPDATE`, `DELETE` — is a deceptively small surface area that hides a very different execution model underneath.

The problem CQL solves is *predictability at scale*. In a relational database, an unconstrained query is slow; in Cassandra, an unconstrained query is a cluster-wide outage waiting to happen. So CQL enforces a contract at parse time: you may only filter on the primary key, in the order the primary key was declared, and the partition key must be fully specified for the query to be routed to a single replica set. Everything else requires you to explicitly opt into danger with `ALLOW FILTERING`. That single restriction is what lets a 500-node Cassandra cluster serve p99 reads in single-digit milliseconds while a comparable SQL cluster is still planning the query.

The second, larger surprise is that **Cassandra never reads before it writes**. An `UPDATE users SET email = 'x' WHERE id = 7` does not fetch row 7, modify it, and write it back. It writes a new cell — column `email`, value `'x'`, timestamp `now` — into the memtable and moves on. Whether row 7 existed is irrelevant and unchecked. This is why `INSERT` and `UPDATE` are semantically identical in Cassandra (both are *upserts*), why writes are O(1) and never involve disk seeks, and why a write can be acknowledged in under a millisecond. It is also why Cassandra cannot natively express "increment this integer" without the separate counter type, and why `IF NOT EXISTS` is dramatically more expensive than a plain insert.

A concrete example: Discord stores every message ever sent in a table partitioned by `(channel_id, bucket)` and clustered by `message_id` (a Snowflake ID that sorts by time). Sending a message is a single `INSERT` — no read, no lock, no coordination beyond the replicas. Loading a channel's history is a single `SELECT ... WHERE channel_id = ? AND bucket = ? ORDER BY message_id DESC LIMIT 50` that touches exactly one partition on `RF` replicas. Editing a message is an `UPDATE` of one cell. Deleting one is a `DELETE` that writes a tombstone. Four statements. Trillions of rows. That is the entire CRUD vocabulary of one of the largest chat systems in the world.

Understanding CQL therefore means understanding not the syntax — which you can learn in twenty minutes — but the *timestamp-and-tombstone* model of conflict resolution underneath it, and the set of queries the primary key makes legal.

## 2. Core Concepts

- **Upsert** — the unified write semantics of `INSERT` and `UPDATE`: both write cells with a timestamp and neither checks for prior existence. There is no "row not found" error on update.
- **Cell** — the atomic unit of storage: `(partition key, clustering key, column name) -> (value, write timestamp, optional TTL)`. Cassandra stores and reconciles cells, not rows.
- **Write timestamp** — a microsecond-precision `long` attached to every cell, supplied by the coordinator (or by the client via `USING TIMESTAMP`). Last-write-wins conflict resolution compares these.
- **Tombstone** — a marker cell recording a deletion, with its own timestamp. Deletes are writes. A tombstone shadows any data with a *lower* timestamp and is only physically removed after `gc_grace_seconds` (default 864000 = 10 days) plus a compaction.
- **Partition key** — the first component(s) of the `PRIMARY KEY`, hashed by Murmur3 to a token that selects the replica set. Must be fully specified with `=` (or `IN`) for a routed query.
- **Clustering columns** — the remaining primary-key components, which define the on-disk sort order *within* a partition and support range predicates (`>`, `<`, `>=`, `<=`) on the last restricted column.
- **Restriction order rule** — clustering columns must be restricted left to right; you may not skip one. `WHERE pk = ? AND c2 = ?` is illegal if `c1` is unrestricted.
- **Row liveness / primary key liveness info** — a marker written by `INSERT` (but *not* by `UPDATE`) that makes a row visible even when all its non-key columns are null. This is the single observable difference between the two statements.
- **`WRITETIME` / `TTL` functions** — CQL built-ins that expose a cell's timestamp and remaining time-to-live, e.g. `SELECT WRITETIME(email), TTL(email) FROM users WHERE id = 7`.
- **Range tombstone** — a single marker covering a *slice* of clustering keys, produced by `DELETE ... WHERE pk = ? AND c1 >= ? AND c1 < ?`. Far cheaper than N cell tombstones.

## 3. Theory & Internals

Every CQL mutation is compiled into a `Mutation` object: a keyspace, a partition key, and a set of `PartitionUpdate`s containing cells. The coordinator computes `token = murmur3(partition_key)`, looks up the replica set from the token map, and dispatches the mutation to all replicas in the local DC (plus one forwarder per remote DC). Each replica appends to its commit log, applies to the memtable, and acks. The coordinator returns success once `CL` acks arrive. **No replica read the existing data.** This is the read-free write path, and it is why Cassandra's write throughput scales almost linearly with node count.

Reads are the expensive direction. A `SELECT` on a single partition must merge:
1. the memtable (in-memory, sorted),
2. every SSTable whose bloom filter says "maybe" for this partition key,
3. row-level tombstones and range tombstones from all of the above.

For each cell name, the merge keeps the value with the **highest write timestamp**; ties are broken by comparing the value bytes lexicographically (a deterministic but arbitrary rule — never rely on it). A tombstone with a higher timestamp than a value wins, and the value disappears.

The critical consequence: **conflict resolution is per-cell, not per-row**. If client A writes `{name: 'Ada', email: 'a@x'}` at t=100 and client B writes `{name: 'Grace'}` at t=101, the resulting row is `{name: 'Grace', email: 'a@x'}` — a row that neither client ever wrote. This is last-write-wins at cell granularity and it is the source of most "impossible" data states in production.

Timestamp math matters. The default timestamp is the coordinator's `System.currentTimeMillis() * 1000` plus a monotonic counter, so clock skew between coordinators directly translates into lost writes. A node 300 ms ahead can write a value that shadows every subsequent write from correct nodes for 300 ms. This is why NTP discipline is not optional and why `USING TIMESTAMP` should be reserved for repair/backfill jobs where you deliberately want to write "in the past".

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="300" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">Cell-level last-write-wins reconciliation</text>
  <rect x="20" y="50" width="200" height="90" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="120" y="72" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Memtable</text>
  <text x="120" y="94" text-anchor="middle" font-size="11" fill="#1e293b">name = 'Grace'  t=101</text>
  <text x="120" y="114" text-anchor="middle" font-size="11" fill="#1e293b">phone = TOMBSTONE t=99</text>
  <rect x="20" y="160" width="200" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="120" y="182" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">SSTable-2</text>
  <text x="120" y="204" text-anchor="middle" font-size="11" fill="#1e293b">email = 'a@x'  t=100</text>
  <rect x="20" y="242" width="200" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="120" y="270" text-anchor="middle" font-size="11" fill="#1e293b">SSTable-1: name='Ada' t=100</text>
  <path d="M228 95 L320 150" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <path d="M228 195 L320 160" stroke="#0ea5e9" stroke-width="1.5" fill="none"/>
  <path d="M228 265 L320 172" stroke="#d97706" stroke-width="1.5" fill="none"/>
  <rect x="325" y="120" width="120" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="385" y="148" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Merge</text>
  <text x="385" y="168" text-anchor="middle" font-size="11" fill="#1e293b">max(timestamp)</text>
  <path d="M450 155 L505 155" stroke="#16a34a" stroke-width="2" fill="none"/>
  <path d="M505 155 l-9 -5 v10 z" fill="#16a34a"/>
  <rect x="510" y="105" width="190" height="100" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="605" y="128" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Result row</text>
  <text x="605" y="150" text-anchor="middle" font-size="11" fill="#1e293b">name  = 'Grace'  (t=101)</text>
  <text x="605" y="170" text-anchor="middle" font-size="11" fill="#1e293b">email = 'a@x'    (t=100)</text>
  <text x="605" y="190" text-anchor="middle" font-size="11" fill="#1e293b">phone = null (tombstoned)</text>
  <text x="360" y="290" text-anchor="middle" font-size="11" fill="#1e293b">No client ever wrote this exact row &#8212; reconciliation is per cell, not per row.</text>
</svg>
```

Deletes deserve their own paragraph. `DELETE FROM t WHERE pk = 1` writes a **partition tombstone**: one small marker that shadows the entire partition. `DELETE col FROM t WHERE pk = 1 AND ck = 5` writes a **cell tombstone**. `DELETE FROM t WHERE pk = 1 AND ck >= 5 AND ck < 9` writes a **range tombstone** — two boundary markers. The cost profile is wildly different: one partition tombstone costs one cell of storage; deleting a million individual clustering rows one-by-one costs a million tombstones that every subsequent read of that partition must scan and discard. `tombstone_warn_threshold` (1000) logs a WARN; `tombstone_failure_threshold` (100000) aborts the query with a `TombstoneOverwhelmingException`.

## 4. Architecture & Workflow

Walk a single `UPDATE` and a single `SELECT` through the cluster with `RF=3`, `CL=LOCAL_QUORUM` (=2):

1. **Parse & prepare.** The driver sends a `PREPARE` for `UPDATE orders SET status=? WHERE order_id=? AND item_id=?`. The coordinator returns a query ID plus metadata identifying which bind marker is the partition key.
2. **Token-aware routing.** The driver hashes the bound `order_id` with Murmur3 and picks a *replica* as coordinator (avoiding an extra network hop). This is `TokenAwarePolicy` wrapping `DCAwareRoundRobinPolicy` — always enable it.
3. **Coordinator fan-out.** The coordinator identifies the 3 local replicas from the token map and sends the mutation to all 3 in parallel. It does **not** read anything.
4. **Replica apply.** Each replica: appends the mutation to the commit log (fsync per `commitlog_sync` policy, default `periodic` / 10 s), applies cells to the memtable's sorted map, and returns an ack.
5. **CL satisfied.** After 2 acks the coordinator returns success to the client. The third replica's write continues asynchronously; if it times out, a **hint** is stored on the coordinator for up to `max_hint_window` (3 h default).
6. **Read request.** A `SELECT * FROM orders WHERE order_id = ?` is routed the same way. The coordinator picks the fastest replica (by dynamic snitch score) for a full data read and asks the other `CL-1` replicas for a **digest** (an MD5 of the result).
7. **Digest comparison.** If digests match, the data response is returned immediately. If they mismatch, the coordinator issues a **read repair**: it fetches full data from all responders, reconciles by timestamp, returns the merged answer to the client, and writes the reconciled result back to the stale replicas.
8. **Local read on the replica.** Each replica merges memtable + candidate SSTables (filtered by bloom filter, then partition index, then row index), applies tombstones, applies the clustering-column slice, and streams rows back up to `LIMIT` / page size.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="340" fill="#ffffff"/>
  <text x="360" y="24" text-anchor="middle" font-size="15" font-weight="600" fill="#1e293b">Write path (no read) vs read path (merge + digest)</text>
  <rect x="20" y="50" width="110" height="50" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="75" y="72" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Client</text>
  <text x="75" y="90" text-anchor="middle" font-size="11" fill="#1e293b">UPDATE</text>
  <rect x="175" y="50" width="130" height="50" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="240" y="72" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Coordinator</text>
  <text x="240" y="90" text-anchor="middle" font-size="11" fill="#1e293b">murmur3 token</text>
  <path d="M132 75 L172 75" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <path d="M172 75 l-9 -5 v10 z" fill="#4f46e5"/>
  <rect x="360" y="40" width="130" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="425" y="62" text-anchor="middle" font-size="11" fill="#1e293b">Replica A: ack</text>
  <rect x="360" y="82" width="130" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="425" y="104" text-anchor="middle" font-size="11" fill="#1e293b">Replica B: ack</text>
  <rect x="360" y="124" width="130" height="34" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="425" y="146" text-anchor="middle" font-size="11" fill="#1e293b">Replica C: hint</text>
  <path d="M307 70 L356 57" stroke="#0ea5e9" stroke-width="1.5" fill="none"/>
  <path d="M307 78 L356 99" stroke="#0ea5e9" stroke-width="1.5" fill="none"/>
  <path d="M307 86 L356 141" stroke="#0ea5e9" stroke-width="1.5" fill="none"/>
  <rect x="530" y="55" width="170" height="105" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="615" y="78" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">On each replica</text>
  <text x="615" y="99" text-anchor="middle" font-size="11" fill="#1e293b">1. commitlog append</text>
  <text x="615" y="118" text-anchor="middle" font-size="11" fill="#1e293b">2. memtable put</text>
  <text x="615" y="137" text-anchor="middle" font-size="11" fill="#1e293b">3. ack (LOCAL_QUORUM=2)</text>
  <path d="M494 100 L526 100" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <line x1="20" y1="185" x2="700" y2="185" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 4"/>
  <rect x="20" y="205" width="110" height="50" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="75" y="227" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Client</text>
  <text x="75" y="245" text-anchor="middle" font-size="11" fill="#1e293b">SELECT</text>
  <rect x="175" y="205" width="130" height="50" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="240" y="227" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Coordinator</text>
  <text x="240" y="245" text-anchor="middle" font-size="11" fill="#1e293b">data + digest</text>
  <path d="M132 230 L172 230" stroke="#4f46e5" stroke-width="2" fill="none"/>
  <path d="M172 230 l-9 -5 v10 z" fill="#4f46e5"/>
  <rect x="360" y="196" width="130" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="425" y="218" text-anchor="middle" font-size="11" fill="#1e293b">A: full data</text>
  <rect x="360" y="238" width="130" height="34" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="425" y="260" text-anchor="middle" font-size="11" fill="#1e293b">B: MD5 digest</text>
  <path d="M307 222 L356 213" stroke="#0ea5e9" stroke-width="1.5" fill="none"/>
  <path d="M307 240 L356 255" stroke="#0ea5e9" stroke-width="1.5" fill="none"/>
  <rect x="530" y="196" width="170" height="90" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="615" y="218" text-anchor="middle" font-size="12" font-weight="600" fill="#1e293b">Digest mismatch?</text>
  <text x="615" y="238" text-anchor="middle" font-size="11" fill="#1e293b">fetch full from all</text>
  <text x="615" y="257" text-anchor="middle" font-size="11" fill="#1e293b">reconcile by timestamp</text>
  <text x="615" y="276" text-anchor="middle" font-size="11" fill="#1e293b">write back = read repair</text>
  <path d="M494 240 L526 240" stroke="#d97706" stroke-width="1.5" fill="none"/>
  <text x="360" y="315" text-anchor="middle" font-size="11" fill="#1e293b">Writes touch zero SSTables. Reads may touch many &#8212; that asymmetry defines Cassandra.</text>
  <text x="360" y="332" text-anchor="middle" font-size="11" fill="#1e293b">R + W &#62; RF gives strong consistency: 2 + 2 &#62; 3.</text>
</svg>
```

## 5. Implementation

Schema first — model the queries, not the entities.

```cql
CREATE KEYSPACE shop WITH replication = {
  'class': 'NetworkTopologyStrategy', 'us_east': 3, 'eu_west': 3
};

USE shop;

CREATE TABLE orders_by_customer (
  customer_id  uuid,
  order_month  text,          -- bucket: '2026-07', keeps partitions bounded
  order_id     timeuuid,
  status       text,
  total_cents  bigint,
  items        map<text, int>,
  PRIMARY KEY ((customer_id, order_month), order_id)
) WITH CLUSTERING ORDER BY (order_id DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'DAYS',
                    'compaction_window_size': 7}
  AND gc_grace_seconds = 864000;
```

The four statements:

```cql
-- INSERT: writes cells + row liveness marker
INSERT INTO orders_by_customer (customer_id, order_month, order_id, status, total_cents)
VALUES (11111111-1111-1111-1111-111111111111, '2026-07', now(), 'PENDING', 4999);

-- UPDATE: identical upsert, but NO liveness marker
UPDATE orders_by_customer
   SET status = 'SHIPPED'
 WHERE customer_id = 11111111-1111-1111-1111-111111111111
   AND order_month = '2026-07'
   AND order_id    = 5c0e1b40-6a1c-11f0-9c3d-0242ac120002;

-- Collection updates are also upserts; += appends without reading
UPDATE orders_by_customer
   SET items = items + {'sku-42': 2}
 WHERE customer_id = 11111111-1111-1111-1111-111111111111
   AND order_month = '2026-07'
   AND order_id    = 5c0e1b40-6a1c-11f0-9c3d-0242ac120002;

-- SELECT: partition key fully specified, clustering range on the last column
SELECT order_id, status, total_cents
  FROM orders_by_customer
 WHERE customer_id = 11111111-1111-1111-1111-111111111111
   AND order_month = '2026-07'
   AND order_id > maxTimeuuid('2026-07-01 00:00+0000')
 LIMIT 50;

-- DELETE one cell (leaves the row), one row, and a range
DELETE status FROM orders_by_customer WHERE customer_id = ? AND order_month = ? AND order_id = ?;
DELETE        FROM orders_by_customer WHERE customer_id = ? AND order_month = ? AND order_id = ?;
DELETE        FROM orders_by_customer WHERE customer_id = ? AND order_month = ? AND order_id < ?;  -- range tombstone
```

Prove the INSERT/UPDATE liveness difference — this trips up nearly everyone:

```cql
UPDATE t SET v = null WHERE k = 1;      -- writes a tombstone for v, no row marker
SELECT * FROM t WHERE k = 1;            -- 0 rows: the row is not "live"

INSERT INTO t (k) VALUES (2);           -- writes only the liveness marker
SELECT * FROM t WHERE k = 2;            -- 1 row: k=2, v=null
```

Inspect timestamps and TTLs directly:

```cql
SELECT status, WRITETIME(status), TTL(status)
  FROM orders_by_customer
 WHERE customer_id = ? AND order_month = ? AND order_id = ?;

--  status  | writetime(status) | ttl(status)
-- ---------+-------------------+-------------
--  SHIPPED |  1785000123456789 |        null
```

Python driver with token-aware routing and prepared statements:

```python
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.policies import DCAwareRoundRobinPolicy, TokenAwarePolicy
from cassandra.query import ConsistencyLevel
import uuid, datetime

profile = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc="us_east")),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM,
    request_timeout=5.0,
)
cluster = Cluster(["10.0.1.11", "10.0.1.12"],
                  execution_profiles={EXEC_PROFILE_DEFAULT: profile})
session = cluster.connect("shop")

insert = session.prepare("""
    INSERT INTO orders_by_customer (customer_id, order_month, order_id, status, total_cents)
    VALUES (?, ?, ?, ?, ?)
""")
select = session.prepare("""
    SELECT order_id, status, total_cents FROM orders_by_customer
     WHERE customer_id = ? AND order_month = ? LIMIT ?
""")

cid = uuid.UUID("11111111-1111-1111-1111-111111111111")
month = datetime.date.today().strftime("%Y-%m")
session.execute(insert, (cid, month, uuid.uuid1(), "PENDING", 4999))

for row in session.execute(select, (cid, month, 50)):
    print(row.order_id, row.status, row.total_cents)
# 5c0e1b40-6a1c-11f0-9c3d-0242ac120002 PENDING 4999
```

Java equivalent with the 4.x DataStax driver:

```java
try (CqlSession session = CqlSession.builder()
        .withLocalDatacenter("us_east")
        .withKeyspace("shop")
        .build()) {

    PreparedStatement ps = session.prepare(
        "UPDATE orders_by_customer SET status = ? " +
        "WHERE customer_id = ? AND order_month = ? AND order_id = ?");

    session.execute(ps.bind("SHIPPED", cid, "2026-07", orderId)
        .setConsistencyLevel(DefaultConsistencyLevel.LOCAL_QUORUM)
        .setIdempotent(true));   // safe to retry: blind upserts are idempotent
}
```

> **Optimization:** mark every blind upsert `setIdempotent(true)` (Java) / `is_idempotent = True` (Python). The driver will only retry non-idempotent statements on a *write timeout* if you say so, and blind upserts are idempotent by construction — retrying them costs nothing and dramatically improves availability during rolling restarts. The exception: `UPDATE ... SET c = c + 1` on counters and any LWT are **not** idempotent.

Verify what a query actually touched:

```bash
cqlsh> TRACING ON;
cqlsh> SELECT * FROM orders_by_customer WHERE customer_id = ... AND order_month = '2026-07';
# activity                                        | source     | source_elapsed
# Executing single-partition query on orders...   | 10.0.1.11  |            312
# Bloom filter allows skipping sstable 41         | 10.0.1.11  |            389
# Merged data from memtables and 2 sstables       | 10.0.1.11  |            871
# Read 50 live rows and 0 tombstone cells         | 10.0.1.11  |            904
```

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Read-free writes | O(1) writes, no disk seek, no lock, linear write scaling | Cannot express read-modify-write; no uniqueness constraints without LWT |
| Upsert semantics | Idempotent, safely retryable, simplifies retry logic | Typos in the primary key silently create new rows instead of erroring |
| SQL-like syntax | Near-zero onboarding cost for SQL developers | Familiarity breeds wrong assumptions — no joins, no transactions, no rollback |
| Primary-key-only filtering | Every legal query is bounded and routable to one replica set | Every access pattern needs its own denormalized table |
| Cell-level LWW | Concurrent writers to different columns both survive | Produces "franken-rows" no client ever wrote; requires clock discipline |
| Deletes as tombstones | Deletes are as fast as writes, work in a masterless ring | Read amplification, `gc_grace_seconds` window, zombie-data risk if repair lapses |
| `WRITETIME` / `TTL` introspection | Powerful debugging of "who wrote this and when" | Not available for collections or the primary key columns |
| Client-supplied `USING TIMESTAMP` | Enables correct backfills and migrations | A single wrong timestamp can permanently shadow all future writes |

## 7. Common Mistakes & Best Practices

1. ⚠️ Treating `UPDATE` as "modify existing row" and expecting an error when the row is missing. → ✅ Accept upsert semantics. If you truly need existence checking, use `IF NOT EXISTS` / `IF EXISTS` (LWT) and pay the Paxos cost consciously.
2. ⚠️ Read-modify-write from the application: `SELECT balance` → compute → `UPDATE balance`. → ✅ This is a lost-update race. Use a counter column, an LWT with `IF balance = ?`, or restructure so the write is an append.
3. ⚠️ Unbounded partitions — `PRIMARY KEY (user_id, event_time)` on a firehose table. → ✅ Add a time bucket to the partition key: `PRIMARY KEY ((user_id, day), event_time)`. Target < 100 MB and < 100k rows per partition.
4. ⚠️ Reaching for `ALLOW FILTERING` when a `WHERE` clause is rejected. → ✅ The rejection is the database protecting you. Create a second table keyed by the new access pattern, or a SAI index (5.0) if cardinality suits.
5. ⚠️ Deleting rows one at a time in a loop to clear a partition. → ✅ Issue one partition-level `DELETE FROM t WHERE pk = ?` (a single tombstone) or a range delete, not N row deletes.
6. ⚠️ Using `SELECT *` in application code. → ✅ Name your columns. `SELECT *` breaks when a column is added, transfers unneeded bytes, and defeats the driver's result-metadata caching.
7. ⚠️ Non-prepared statements with string-interpolated values. → ✅ Always `prepare()` + bind. You get token-aware routing, server-side statement caching, and immunity to CQL injection.
8. ⚠️ Assuming `IN` on the partition key is efficient. → ✅ `WHERE pk IN (a,b,...,z)` makes one coordinator fan out to up to 26 replica sets and hold all results in memory. Issue N parallel single-partition queries with `execute_concurrent` instead.
9. ⚠️ Ignoring clock skew and writing with `USING TIMESTAMP` from application clocks. → ✅ Let the coordinator assign timestamps; run chrony/NTP with sub-10 ms skew; reserve explicit timestamps for migrations.
10. ⚠️ Writing `null` to a column as a way of saying "no change". → ✅ A `null` bind value writes a **tombstone**. Use unset values (`session.execute(stmt, [UNSET_VALUE])` / `bind` skipping the parameter) to omit a column from the mutation entirely.
11. ⚠️ `SELECT COUNT(*) FROM big_table` in a dashboard. → ✅ That is a full cluster scan. Maintain a counter table, or use `nodetool tablestats` / Spark for approximate counts.
12. ⚠️ Running deletes but never repairing, then bringing a down node back after `gc_grace_seconds`. → ✅ Deleted data resurrects. Run a full repair on every table at least once per `gc_grace_seconds`, or use incremental repair with `nodetool repair -pr` on a schedule.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** `TRACING ON` in cqlsh is the fastest path to truth: it shows SSTables touched, tombstones scanned, live rows returned, and per-hop latency. For a query you cannot reproduce interactively, enable the slow-query log (`slow_query_log_timeout_in_ms`, default 500 ms) and read `DEBUG` entries in `system.log`. Cassandra 4.0+ exposes virtual tables — `SELECT * FROM system_views.clients`, `system_views.sstable_tasks`, and `system_views.settings` — queryable straight from cqlsh with no JMX. To diagnose a suspect row, `SELECT WRITETIME(col)` tells you exactly which writer won, and `nodetool getendpoints shop orders_by_customer <pk>` tells you which nodes to inspect with `sstabledump`.

**Monitoring.** Watch these JMX beans: `org.apache.cassandra.metrics:type=ClientRequest,scope=Read,name=Latency` and `...scope=Write,name=Latency` (p99 is the SLA number), `type=Table,keyspace=shop,scope=orders_by_customer,name=TombstoneScannedHistogram` (p99 > 100 means trouble), `name=SSTablesPerReadHistogram` (p99 > 10 means compaction is behind), `type=ClientRequest,name=Unavailables` and `name=Timeouts`, and `type=Storage,name=TotalHints`. Rising `TotalHints` means replicas are dropping writes. Export via the Prometheus JMX exporter or `cassandra-exporter`.

**Security.** Enable `authenticator: PasswordAuthenticator` and `authorizer: CassandraAuthorizer` in `cassandra.yaml`, then bump `system_auth` replication to `NetworkTopologyStrategy` with RF = number of nodes per DC (3 minimum) or authentication fails when a node is down. Grant per-table: `GRANT SELECT, MODIFY ON shop.orders_by_customer TO app_reader;` — never `GRANT ALL ON ALL KEYSPACES`. Enable client-to-node and node-to-node TLS (`client_encryption_options`, `server_encryption_options`). Prepared statements are your CQL-injection defence. In 4.0+, turn on the audit log (`audit_logging_options.enabled: true`) with `included_categories: DML,DDL,AUTH` to capture who ran which mutation.

**Performance & scaling.** Keep the number of SSTables touched per read low — that is the single biggest lever. Use `LeveledCompactionStrategy` for read-heavy update workloads (guarantees ~1 SSTable per read at L1+), `TimeWindowCompactionStrategy` for time series with TTLs, `SizeTieredCompactionStrategy` for write-heavy append-only. Cap concurrency at the driver, not the server: `concurrent_writes` defaults to 32 per node; flooding beyond it fills the mutation queue and triggers dropped mutations (`nodetool tpstats` → `MutationStage` dropped count). Scale reads by adding replicas/DCs; scale writes by adding nodes. Never scale by making partitions bigger.

## 9. Interview Questions

**Q: What is the difference between INSERT and UPDATE in Cassandra?**
A: Semantically almost nothing — both are upserts that write timestamped cells without reading existing data. The one observable difference is that `INSERT` writes a primary-key liveness marker, so a row inserted with only key columns is visible in a `SELECT`, whereas the same row created by an `UPDATE` that sets all non-key columns to null is not returned. Neither errors if the row does or does not already exist.

**Q: Why does Cassandra not read before writing?**
A: Because a read would require contacting replicas and merging SSTables, turning an O(1) memtable append into a multi-millisecond distributed operation and destroying write throughput. The LSM design deliberately makes writes append-only and defers all reconciliation to read time and compaction. The cost is that Cassandra cannot natively express read-modify-write without counters or Paxos.

**Q: What happens if I bind `null` to a column in a prepared statement?**
A: Cassandra writes a tombstone for that column. In a bulk-insert loop with mostly-null wide rows this can generate millions of unnecessary tombstones. Use the driver's `UNSET` sentinel instead, which omits the column from the mutation entirely — available since native protocol v4 / Cassandra 2.2.

**Q: Why can't I write `WHERE order_month = '2026-07' AND order_id > ?` without the customer_id?**
A: Because `customer_id` is part of the composite partition key and without it the coordinator cannot compute a token, so the query would have to scan every partition on every node. Cassandra rejects it at parse time unless you add `ALLOW FILTERING`, which turns it into a cluster-wide scan.

**Q: How does Cassandra resolve two concurrent writes to the same row?**
A: Per cell, by highest write timestamp; ties break on the value bytes. If the two writes touched different columns, both survive and the resulting row is a merge of the two. This is last-write-wins and it means clock skew between coordinators can cause silent write loss.

**Q: What is a range tombstone and when is it created?**
A: A single marker covering a contiguous slice of clustering keys within a partition, created by a `DELETE` with an inequality on a clustering column (e.g. `AND event_time < '2026-01-01'`). It is vastly cheaper than one tombstone per deleted row — one marker shadows the whole range during read merges.

**Q: (Senior) You see `TombstoneOverwhelmingException` on a read path that never issues DELETEs. What are the likely causes?**
A: Three common ones: (1) the application binds `null` values in inserts, creating a tombstone per null column; (2) rows have TTLs and expired cells become tombstones until compacted; (3) collections are being overwritten wholesale (`SET items = {...}` writes a collection-wide range tombstone before the new elements, whereas `items = items + {...}` does not). Fix the write pattern first, then tune compaction to reclaim faster; raising `tombstone_failure_threshold` only hides the problem.

**Q: (Senior) Explain exactly why `R + W > RF` gives strong consistency, and where that guarantee breaks.**
A: With `W` replicas acknowledging a write and `R` replicas consulted on read, `R + W > RF` forces the read and write quorums to overlap on at least one replica, so any successful read sees at least one copy of the latest acknowledged write and timestamp reconciliation surfaces it. It breaks under three conditions: a write that timed out but partially applied (Cassandra has no rollback, so the value may later appear), clock skew that makes an older write carry a higher timestamp, and cross-DC reads at `LOCAL_QUORUM` where the "latest" write was acknowledged only in another DC.

**Q: (Senior) A migration job backfills historical rows with `USING TIMESTAMP` set to the original event time. What can go wrong?**
A: If any live traffic already wrote to those same cells with the current (higher) timestamp, the backfill is silently a no-op — which is often desired. The dangerous inverse is writing a *future* timestamp: any subsequent legitimate write with a normal timestamp is silently shadowed until wall-clock catches up, and a `DELETE` at a lower timestamp cannot remove it either. The recovery is to delete with an even higher timestamp, which permanently poisons that cell. Always clamp explicit timestamps to `<= now`.

**Q: How do I delete a single column without deleting the row?**
A: `DELETE column_name FROM t WHERE <full primary key>` writes a cell tombstone for just that column. The row remains live if it has a liveness marker or any other live cell. Setting the column to `null` via `UPDATE` produces exactly the same tombstone.

**Q: Is `SELECT ... WHERE pk IN (?, ?, ?)` a good idea?**
A: Rarely. The coordinator becomes a fan-out point holding all sub-results in memory, and one slow replica stalls the whole query; the tail latency is the max of N queries rather than the average. Prefer N concurrent single-partition prepared statements so the driver routes each one token-aware and you control per-query timeouts.

**Q: Why must every blind upsert be marked idempotent in the driver?**
A: Because on a write timeout the driver does not know whether the mutation applied, and it will only retry statements explicitly declared idempotent. Blind upserts are idempotent by construction — replaying them yields the same cells — so declaring them turns a user-visible timeout into a transparent retry. Counter updates and LWTs must never be marked idempotent.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** CQL exposes four verbs, but only two behaviours: mutate and scan. `INSERT` and `UPDATE` are the same read-free upsert that writes timestamped cells; `DELETE` is a write that produces a tombstone. Reads merge the memtable with every SSTable whose bloom filter matches, resolving each cell by highest write timestamp, then discard tombstoned values. The `WHERE` clause is constrained to the primary key in declaration order — partition key with `=`, clustering columns left-to-right with a final optional range — because that is the only shape that can be routed to a single replica set and served in bounded time. Everything else is either a second table or a mistake.

| Item | Value / Command |
|---|---|
| Upsert equivalence | `INSERT` ≡ `UPDATE` except for the row liveness marker |
| Conflict resolution | per-cell last-write-wins on microsecond timestamp |
| Default write timestamp | coordinator `currentTimeMillis()*1000` + counter |
| Inspect timestamp | `SELECT WRITETIME(col) FROM t WHERE ...` |
| Omit a column from a write | bind `UNSET` (protocol v4+), never `null` |
| Tombstone WARN / FAIL | `tombstone_warn_threshold: 1000` / `tombstone_failure_threshold: 100000` |
| Tombstone GC delay | `gc_grace_seconds = 864000` (10 days) |
| Partition size targets | < 100 MB, < 100k rows, < 2 B cells hard limit |
| Trace a query | `TRACING ON;` then run it; or `nodetool settraceprobability 0.001` |
| Find replicas for a key | `nodetool getendpoints <ks> <table> <pk>` |
| Production CL | `LOCAL_QUORUM` read + write with `NetworkTopologyStrategy` |

**Flash cards**
- **Does UPDATE fail if the row is absent?** → No. It creates it. Upsert semantics, no read-before-write.
- **What does binding `null` write?** → A tombstone. Use `UNSET` to skip the column.
- **How are two concurrent writes reconciled?** → Per cell, highest write timestamp wins; ties break on value bytes.
- **Cheapest way to clear a partition?** → One partition-level `DELETE FROM t WHERE pk = ?` — a single tombstone.
- **Why is `WHERE` restricted to the primary key?** → Only primary-key predicates can be routed to one replica set and answered in bounded time.

## 11. Hands-On Exercises & Mini Project

- [ ] Start a 3-node cluster (`ccm create crud -v 4.1.5 -n 3 -s` or `docker compose` with three `cassandra:4.1` nodes). Create the `shop` keyspace with `NetworkTopologyStrategy` and RF 3, and confirm placement with `nodetool status`.
- [ ] Demonstrate the liveness-marker difference: `UPDATE t SET v = null WHERE k = 1` then `INSERT INTO t (k) VALUES (2)`, and show that only `k=2` is returned by `SELECT *`.
- [ ] Write the same cell from two sessions using explicit `USING TIMESTAMP 1000` and `USING TIMESTAMP 999`, then read it back and explain the winner via `WRITETIME`.
- [ ] Insert 5,000 rows into one partition, delete 4,000 of them row-by-row, then run `TRACING ON` on a `SELECT` and record the "tombstone cells" count. Repeat with a single range delete and compare.
- [ ] Trigger `TombstoneOverwhelmingException` deliberately by lowering `tombstone_failure_threshold` to 100 and re-running the previous query. Then raise it back and fix the *write* pattern instead.

**Mini Project — a message store with correct CRUD**

*Goal:* build a Discord-style message store in Python that supports posting, editing, deleting, and paging channel history, using only single-partition queries.

*Requirements:*
- Table `messages_by_channel` with `PRIMARY KEY ((channel_id, day_bucket), message_id)` and `CLUSTERING ORDER BY (message_id DESC)`; `message_id` is a `timeuuid`.
- A `post(channel, text)` that is a single prepared `INSERT` at `LOCAL_QUORUM`, marked idempotent.
- An `edit(channel, message_id, text)` that is a single-cell `UPDATE` and preserves the original `posted_at`.
- A `delete(channel, message_id)` that writes a row tombstone, plus a `purge_before(channel, ts)` that uses one **range** delete per bucket.
- A `history(channel, before_id, n)` that pages backwards across day buckets, never issuing `ALLOW FILTERING`.
- A verification script printing `WRITETIME` for every cell of an edited message to prove per-cell reconciliation.

*Extensions:* add an `UNSET`-aware bulk importer that never writes null tombstones; add a `reactions map<text,int>` updated with `+=` and show via `sstabledump` that a full-collection `SET` writes a range tombstone while `+=` does not; measure p99 read latency with and without `TokenAwarePolicy` under `cassandra-stress`.

## 12. Related Topics & Free Learning Resources

Continue with **14 · Batches & Lightweight Transactions** for the coordination primitives CRUD deliberately omits, **15 · TTL, Counters & Static Columns** for the write types that break the pure-upsert model, **16 · Paging, ALLOW FILTERING & Query Limits** for keeping `SELECT` bounded, and **18 · The Ring, Tokens & Consistent Hashing** for why the partition key rules exist at all. Data-modelling chapters on primary keys and denormalization are the natural prerequisite.

- **Apache Cassandra CQL Reference** — Apache Software Foundation · *Beginner–Advanced* · the normative grammar for every DML statement, including `USING TIMESTAMP`, `UNSET`, and restriction rules. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/dml.html>
- **Cassandra Storage Engine Deep Dive** — Apache Cassandra Documentation · *Advanced* · how cells, liveness info, and tombstones are actually laid out on disk. <https://cassandra.apache.org/doc/latest/cassandra/architecture/storage-engine.html>
- **Understanding Deletes and Tombstones** — The Last Pickle · *Intermediate* · the definitive practitioner writeup on tombstone types, `gc_grace_seconds`, and zombie data. <https://thelastpickle.com/blog/2016/07/27/about-deletes-and-tombstones.html>
- **DataStax CQL Data Manipulation Docs** — DataStax · *Beginner* · clear, example-heavy coverage of INSERT/UPDATE/DELETE semantics and collection updates. <https://docs.datastax.com/en/cql-oss/3.3/cql/cql_reference/cqlCommandsTOC.html>
- **How Discord Stores Billions of Messages** — Discord Engineering · *Intermediate* · the canonical real-world case study of bucketed partitions and single-partition CRUD at scale. <https://discord.com/blog/how-discord-stores-billions-of-messages>
- **Cassandra: A Decentralized Structured Storage System** — Lakshman & Malik (Facebook) · *Advanced* · the original paper; section 5 explains why the write path avoids reads. <https://www.cs.cornell.edu/projects/ladis2009/papers/lakshman-ladis2009.pdf>
- **DataStax Python Driver Documentation** — DataStax · *Intermediate* · prepared statements, `UNSET`, execution profiles, idempotence, and concurrent execution helpers. <https://docs.datastax.com/en/developer/python-driver/latest/>
- **Data Modeling in Apache Cassandra (white paper + talks)** — DataStax Academy · *Intermediate* · query-first modelling, the discipline that makes CQL's `WHERE` restrictions feel natural. <https://www.datastax.com/learn/data-modeling-by-example>

---

*Apache Cassandra Handbook — chapter 13.*
