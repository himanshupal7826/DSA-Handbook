# 05 · Keyspaces, Tables & CQL Basics

> **In one line:** A keyspace declares *how many copies and where*, a table declares *how rows are partitioned and sorted*, and CQL is a deliberately restricted SQL-lookalike that only lets you ask questions the storage layout can answer cheaply.

---

## 1. Overview

CQL — the Cassandra Query Language — was introduced in 0.8 and became the only supported interface when Thrift was removed in 4.0. It looks like SQL on purpose: `CREATE TABLE`, `INSERT`, `SELECT ... WHERE`, `UPDATE`, `DELETE`. That familiarity is a gift and a trap. The syntax is borrowed; the semantics are not. There are no joins, no subqueries, no foreign keys, no `GROUP BY` across partitions, and a `WHERE` clause that will simply refuse most predicates you write. Every restriction exists for the same reason: CQL will only compile to an operation that a coordinator can satisfy by touching a bounded, known set of replicas.

The **keyspace** is the outermost container — roughly a "database" in SQL terms — but its real job is replication. `CREATE KEYSPACE ... WITH replication = {'class': 'NetworkTopologyStrategy', 'dc_east': 3}` says: every partition in this keyspace gets three copies in `dc_east`, placed on nodes in three different racks. That one statement determines your durability, your availability during failures, your quorum arithmetic, and your storage bill. Tables inherit it; you cannot set replication per table.

The **table** is where the storage layout is decided. `PRIMARY KEY ((tenant_id, day), event_time, event_id)` says: hash `(tenant_id, day)` to choose nodes, then store rows on disk sorted by `event_time` then `event_id` within that partition. Everything about which queries are fast follows from that line. This is the inversion that trips up newcomers: in SQL you design a normalized schema and then add indexes to serve queries; in Cassandra you enumerate your queries and then design a table per query shape.

The problem this solves is predictability. In a relational database a badly written query is slow. In a distributed database a badly written query is a *cluster-wide outage* — it scatters to every node, holds coordinator heap, and blocks the request pool for everyone. CQL's restrictions are guardrails: if the query planner cannot prove your `WHERE` clause resolves to specific partitions, it refuses (`InvalidRequest: ... use ALLOW FILTERING`) rather than quietly doing something catastrophic.

A concrete example: a multi-tenant SaaS analytics product needs "show me this tenant's events for today, newest first". In PostgreSQL you'd write one `events` table with indexes on `(tenant_id, created_at)`. In Cassandra you write `CREATE TABLE events_by_tenant_day (tenant_id uuid, day date, event_time timestamp, event_id timeuuid, payload text, PRIMARY KEY ((tenant_id, day), event_time, event_id)) WITH CLUSTERING ORDER BY (event_time DESC, event_id ASC)` — and that single query is now a one-partition, one-seek, pre-sorted read that costs the same whether the cluster has 6 nodes or 600. If the product also needs "all events of type X across tenants", that is a *second table*, written to at the same time.

## 2. Core Concepts

- **Keyspace** — the replication container. Holds tables, types, functions, and indexes. Carries `replication` (strategy + per-DC RF) and `durable_writes` (leave it `true`).
- **`NetworkTopologyStrategy`** — the only strategy for production: takes an explicit RF per datacenter and places replicas on distinct racks. `SimpleStrategy` ignores topology and must never be used in production.
- **Table** — a set of rows sharing a schema and a primary key. Physically, a set of SSTables plus a memtable.
- **Primary key** — `PRIMARY KEY ((partition columns), clustering columns...)`. The parenthesised first element is the partition key; the rest are clustering columns.
- **Static column** — a column declared `STATIC`, stored once per *partition* rather than per row. Useful for partition-level metadata (e.g. a channel's name alongside its messages).
- **Collections** — `set<t>`, `list<t>`, `map<k,v>`; stored as individual cells inside the row. Keep them small (< ~100 elements) — they are read and written whole in many operations.
- **UDT (user-defined type)** — a named struct (`CREATE TYPE address (street text, city text)`) usable as a column type; use `frozen<>` to store it as a single opaque cell.
- **TTL** — per-cell expiry in seconds, set with `USING TTL` or the table's `default_time_to_live`. An expired cell becomes a tombstone.
- **Writetime / TTL functions** — `WRITETIME(col)` and `TTL(col)` expose the per-cell metadata that drives last-write-wins.
- **Upsert semantics** — `INSERT` and `UPDATE` are the same operation. There is no "row does not exist" error, no "row already exists" error, and no read before write.
- **`ALLOW FILTERING`** — an explicit opt-in to a scan. It is a warning label, not a feature.
- **`IF NOT EXISTS` / `IF <cond>`** — lightweight transactions (Paxos). The only statements that actually check existing state.

## 3. Theory & Internals

### What a `CREATE TABLE` really declares

```
PRIMARY KEY ((tenant_id, day), event_time, event_id)
              └── partition key ──┘  └── clustering ──┘
                        │                    │
       murmur3 hash → token → replicas       sort order of rows on disk
```

The partition key is hashed; the clustering columns are **not** hashed — they are stored in sorted order inside the partition. This is why range queries on clustering columns (`AND event_time > ?`) are cheap (a contiguous disk read) while range queries on the partition key are impossible (tokens destroy ordering).

### The `WHERE` clause rules, precisely

CQL will accept a `SELECT` only if it can identify the partitions to read:

1. **All** partition key columns must be restricted with `=` (or `IN`).
2. Clustering columns may then be restricted **left to right, without gaps**; the last restricted one may use a range operator (`>`, `>=`, `<`, `<=`), all earlier ones must use `=`.
3. Non-primary-key columns may only be restricted if they have an index (2i or SAI) — or if you add `ALLOW FILTERING`.
4. `ORDER BY` may only reorder by clustering columns, and only in the declared order or its exact reverse.

```
PRIMARY KEY ((a, b), c, d, e)

WHERE a=? AND b=?                        ✅ whole partition
WHERE a=? AND b=? AND c=?                ✅ slice
WHERE a=? AND b=? AND c=? AND d>?        ✅ range on the last restricted column
WHERE a=? AND b=? AND d=?                ❌ gap: c is unrestricted
WHERE a=?                                ❌ incomplete partition key
WHERE a=? AND b=? AND c>? AND d=?        ❌ equality after a range
WHERE payload='x'                        ❌ not in the key → needs an index or ALLOW FILTERING
```

### Everything is an upsert

There is no read-before-write. `INSERT INTO t (k, v) VALUES (1, 'a')` and `UPDATE t SET v='a' WHERE k=1` produce the *identical* mutation: a cell `v='a'` with a timestamp. Consequences:

- Writing the same row twice is free and idempotent — perfect for retries.
- You cannot detect "did this row already exist?" without an LWT (`IF NOT EXISTS`), which costs Paxos.
- `INSERT` writes a **row marker** (a primary-key liveness marker) while a bare `UPDATE` does not; this matters when every non-key column is later deleted or expires — the row disappears entirely for `UPDATE`-created rows.
- Writing `NULL` is a **delete**: it creates a tombstone. Never bind unset columns to `NULL` — use `UNSET` (drivers do this automatically for prepared statements with unset values).

### RF, quorum, and cost

With `{'class': 'NetworkTopologyStrategy', 'dc_east': 3, 'dc_west': 3}`: **6 total copies**, so a 6× storage multiplier; `LOCAL_QUORUM` = `floor(3/2)+1` = **2** acks inside the local DC; `QUORUM` = `floor(6/2)+1` = **4** acks, which always crosses the WAN. You tolerate one node down per DC at `LOCAL_QUORUM`, and a whole datacenter down without data loss.

```svg
<svg viewBox="0 0 790 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="c5a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="395" y="20" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Keyspace &#8594; table &#8594; partition &#8594; sorted rows on disk</text>
  <rect x="25" y="36" width="740" height="52" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="40" y="58" fill="#1e293b" font-weight="bold">KEYSPACE app &#8212; NetworkTopologyStrategy {dc_east: 3, dc_west: 3}</text>
  <text x="40" y="78" fill="#1e293b" font-size="11">decides HOW MANY copies and WHERE. Tables inherit it; it cannot be set per table.</text>
  <rect x="25" y="100" width="740" height="66" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="40" y="122" fill="#1e293b" font-weight="bold">TABLE events_by_tenant_day</text>
  <text x="40" y="142" fill="#1e293b" font-size="12">PRIMARY KEY ((tenant_id, day), event_time, event_id)</text>
  <text x="40" y="158" fill="#1e293b" font-size="11">partition key hashed &#8594; token &#8594; 3 replicas per DC &#160;&#160;|&#160;&#160; clustering cols &#8594; on-disk sort order</text>
  <rect x="25" y="180" width="355" height="145" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="40" y="202" fill="#1e293b" font-weight="bold">Partition ('t-42', 2026-07-22)</text>
  <text x="40" y="219" fill="#1e293b" font-size="11">murmur3 &#8594; token 8123... &#8594; nodes N4, N7, N2</text>
  <rect x="42" y="230" width="320" height="21" rx="3" fill="#ffffff" stroke="#16a34a"/>
  <text x="50" y="245" fill="#1e293b" font-size="11">18:42:11 &#183; evt-a &#183; payload...</text>
  <rect x="42" y="254" width="320" height="21" rx="3" fill="#ffffff" stroke="#16a34a"/>
  <text x="50" y="269" fill="#1e293b" font-size="11">18:41:57 &#183; evt-b &#183; payload...</text>
  <rect x="42" y="278" width="320" height="21" rx="3" fill="#ffffff" stroke="#16a34a"/>
  <text x="50" y="293" fill="#1e293b" font-size="11">18:40:03 &#183; evt-c &#183; payload...</text>
  <text x="50" y="316" fill="#1e293b" font-size="11">CLUSTERING ORDER BY (event_time DESC)</text>
  <rect x="405" y="180" width="360" height="145" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="420" y="202" fill="#1e293b" font-weight="bold">WHERE clause legality</text>
  <text x="420" y="223" fill="#1e293b" font-size="11">tenant_id=? AND day=? &#8594; whole partition &#160;OK</text>
  <text x="420" y="242" fill="#1e293b" font-size="11">... AND event_time &gt; ? &#8594; contiguous slice &#160;OK</text>
  <text x="420" y="261" fill="#1e293b" font-size="11">... AND event_id=? only &#8594; gap in clustering &#160;NO</text>
  <text x="420" y="280" fill="#1e293b" font-size="11">tenant_id=? alone &#8594; partition key incomplete &#160;NO</text>
  <text x="420" y="299" fill="#1e293b" font-size="11">payload='x' &#8594; needs index or ALLOW FILTERING &#160;NO</text>
  <text x="420" y="318" fill="#1e293b" font-size="11">rule: full partition key, then clustering left to right</text>
  <line x1="395" y1="90" x2="395" y2="96" stroke="#4f46e5" stroke-width="2" marker-end="url(#c5a)"/>
  <line x1="200" y1="168" x2="200" y2="176" stroke="#4f46e5" stroke-width="2" marker-end="url(#c5a)"/>
  <line x1="585" y1="168" x2="585" y2="176" stroke="#4f46e5" stroke-width="2" marker-end="url(#c5a)"/>
</svg>
```

## 4. Architecture & Workflow

What happens between typing a CQL statement and data landing on disk:

1. **Parse.** The native protocol frame arrives on 9042. If it is a prepared statement, the coordinator looks up the cached `PreparedStatement` by MD5 id — no parsing at all. Otherwise ANTLR parses the CQL text every time.
2. **Validate against schema.** Column names and types are checked against `system_schema.columns`; the `WHERE` restrictions are validated against the primary key rules. Illegal predicates fail here with `InvalidRequest`, before any node is contacted.
3. **Bind and serialise.** Values are encoded to their CQL binary representations. An unbound parameter becomes `UNSET` (no cell written), whereas an explicit `NULL` becomes a **tombstone**.
4. **Compute the token.** The serialised partition key components are concatenated (length-prefixed for composite keys) and hashed with Murmur3. That token selects the replicas via the keyspace's replication strategy.
5. **Timestamp assignment.** Unless `USING TIMESTAMP` is supplied, the coordinator (or, with most drivers, the *client*) stamps the mutation with microseconds since epoch. This timestamp is the entire conflict-resolution mechanism.
6. **Dispatch and apply.** The mutation goes to all replicas; each appends to the commit log and inserts into the memtable — a sorted structure keyed by partition, then clustering values.
7. **Flush.** The memtable becomes an SSTable: a `Data.db` file with partitions in token order and rows in clustering order, plus `Index.db`, `Filter.db` (bloom filter), `Summary.db`, and `Statistics.db`.
8. **Read.** A `SELECT` with a full partition key hashes to the same token, asks each SSTable's bloom filter "might you contain this partition?", uses the partition index to seek, reads the requested clustering slice, and merges by cell timestamp across SSTables and the memtable.
9. **DDL is different.** `CREATE`/`ALTER`/`DROP` writes to `system_schema.*` and gossips a new `schema_version` UUID that all nodes must converge on. Concurrent conflicting DDL is the classic way to create a schema disagreement.

```svg
<svg viewBox="0 0 790 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="c5b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="395" y="20" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">CQL statement lifecycle</text>
  <rect x="25" y="38" width="170" height="58" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="110" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">1. Parse / lookup</text>
  <text x="110" y="78" text-anchor="middle" fill="#1e293b" font-size="10">prepared &#8594; cache hit by MD5</text>
  <rect x="215" y="38" width="170" height="58" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="300" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">2. Validate</text>
  <text x="300" y="78" text-anchor="middle" fill="#1e293b" font-size="10">WHERE rules, types, schema</text>
  <rect x="405" y="38" width="170" height="58" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="490" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">3. Token</text>
  <text x="490" y="78" text-anchor="middle" fill="#1e293b" font-size="10">murmur3(partition key)</text>
  <rect x="595" y="38" width="170" height="58" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="680" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">4. Timestamp</text>
  <text x="680" y="78" text-anchor="middle" fill="#1e293b" font-size="10">micros since epoch, per cell</text>
  <line x1="197" y1="67" x2="211" y2="67" stroke="#0ea5e9" stroke-width="2" marker-end="url(#c5b)"/>
  <line x1="387" y1="67" x2="401" y2="67" stroke="#0ea5e9" stroke-width="2" marker-end="url(#c5b)"/>
  <line x1="577" y1="67" x2="591" y2="67" stroke="#0ea5e9" stroke-width="2" marker-end="url(#c5b)"/>
  <rect x="25" y="118" width="740" height="54" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="40" y="140" fill="#1e293b" font-weight="bold">5. Replicas apply: commit log append &#8594; memtable insert (sorted by clustering key) &#8594; ack</text>
  <text x="40" y="160" fill="#1e293b" font-size="11">INSERT and UPDATE emit the SAME mutation. Binding NULL writes a tombstone; UNSET writes nothing.</text>
  <line x1="395" y1="98" x2="395" y2="114" stroke="#0ea5e9" stroke-width="2" marker-end="url(#c5b)"/>
  <rect x="25" y="192" width="360" height="100" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="40" y="214" fill="#1e293b" font-weight="bold">6. Flush &#8594; SSTable files</text>
  <text x="40" y="234" fill="#1e293b" font-size="11">Data.db &#160; partitions in token order</text>
  <text x="40" y="251" fill="#1e293b" font-size="11">Index.db + Summary.db &#160; partition offsets</text>
  <text x="40" y="268" fill="#1e293b" font-size="11">Filter.db &#160; bloom filter (fp ratio 0.01)</text>
  <text x="40" y="285" fill="#1e293b" font-size="11">Statistics.db &#160; min/max ts, tombstone ratio</text>
  <rect x="405" y="192" width="360" height="100" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="420" y="214" fill="#1e293b" font-weight="bold">7. SELECT with full partition key</text>
  <text x="420" y="234" fill="#1e293b" font-size="11">bloom filter per SSTable &#8594; skip or seek</text>
  <text x="420" y="251" fill="#1e293b" font-size="11">partition index &#8594; byte offset</text>
  <text x="420" y="268" fill="#1e293b" font-size="11">read the clustering slice, contiguous</text>
  <text x="420" y="285" fill="#1e293b" font-size="11">merge cells by highest timestamp</text>
  <rect x="25" y="308" width="740" height="44" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="40" y="330" fill="#1e293b" font-weight="bold">DDL path: writes system_schema.* &#8594; gossips a new schema_version UUID</text>
  <text x="40" y="346" fill="#1e293b" font-size="11">All nodes must converge on one UUID. Never run concurrent DDL from multiple clients.</text>
</svg>
```

## 5. Implementation

```cql
-- 1. Keyspace: replication is the whole point
CREATE KEYSPACE IF NOT EXISTS app
WITH replication = {'class': 'NetworkTopologyStrategy', 'dc_east': 3, 'dc_west': 3}
AND durable_writes = true;

SELECT keyspace_name, replication FROM system_schema.keyspaces WHERE keyspace_name='app';
--  app | {'class': 'NetworkTopologyStrategy', 'dc_east': '3', 'dc_west': '3'}

USE app;

-- 2. A UDT and a table shaped by its query
CREATE TYPE IF NOT EXISTS geo (lat double, lon double);

CREATE TABLE IF NOT EXISTS events_by_tenant_day (
    tenant_id   uuid,
    day         date,
    event_time  timestamp,
    event_id    timeuuid,
    tenant_name text STATIC,        -- stored once per partition
    kind        text,
    payload     text,
    tags        set<text>,
    where_at    frozen<geo>,
    PRIMARY KEY ((tenant_id, day), event_time, event_id)
) WITH CLUSTERING ORDER BY (event_time DESC, event_id ASC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'DAYS', 'compaction_window_size': 1}
  AND default_time_to_live = 2592000      -- 30 days
  AND gc_grace_seconds = 864000           -- 10 days (the default; repair within this)
  AND comment = 'one partition per tenant per day';
```

```cql
-- 3. Writes: INSERT and UPDATE are the same upsert
INSERT INTO events_by_tenant_day
  (tenant_id, day, event_time, event_id, tenant_name, kind, payload, tags)
VALUES (11111111-1111-1111-1111-111111111111, '2026-07-22',
        '2026-07-22 18:42:11+0000', now(), 'Acme Ltd', 'login', '{"ip":"1.2.3.4"}',
        {'auth','web'})
USING TTL 604800;                          -- overrides default_time_to_live

-- 4. Reads that the engine will accept
SELECT event_time, kind, payload FROM events_by_tenant_day
WHERE tenant_id = 11111111-1111-1111-1111-111111111111 AND day = '2026-07-22'
LIMIT 50;                                   -- whole partition, newest first

SELECT * FROM events_by_tenant_day
WHERE tenant_id = 11111111-1111-1111-1111-111111111111 AND day = '2026-07-22'
  AND event_time >= '2026-07-22 18:00:00+0000'
  AND event_time <  '2026-07-22 19:00:00+0000';   -- contiguous clustering slice

-- 5. Reads it will refuse
SELECT * FROM events_by_tenant_day WHERE tenant_id = 11111111-...;
-- InvalidRequest: Cannot execute this query as it might involve data filtering...
-- (the partition key is incomplete: `day` is missing)

SELECT * FROM events_by_tenant_day WHERE kind = 'login';
-- InvalidRequest: ... If you want to execute this query despite the performance
-- unpredictability, use ALLOW FILTERING     <- do NOT do this in application code

-- 6. Inspect the metadata that drives last-write-wins
SELECT kind, WRITETIME(kind), TTL(kind) FROM events_by_tenant_day
WHERE tenant_id = 11111111-1111-1111-1111-111111111111 AND day = '2026-07-22' LIMIT 1;
--  kind  | writetime(kind)  | ttl(kind)
-- -------+------------------+-----------
--  login | 1784918531004221 |    603127

-- 7. Schema evolution: cheap, but ADD only
ALTER TABLE events_by_tenant_day ADD source_ip inet;
ALTER TABLE events_by_tenant_day WITH gc_grace_seconds = 259200;
-- DROP COLUMN is allowed but the data lingers in SSTables until compaction,
-- and re-adding a dropped column name with a different type is rejected.
```

```python
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.policies import DCAwareRoundRobinPolicy, TokenAwarePolicy
from cassandra import ConsistencyLevel
from cassandra.query import BatchStatement, BatchType
import uuid, datetime

profile = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy("dc_east")),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM)
session = Cluster(["10.0.1.11"],
                  execution_profiles={EXEC_PROFILE_DEFAULT: profile}).connect("app")

ins = session.prepare("""INSERT INTO events_by_tenant_day
    (tenant_id, day, event_time, event_id, kind, payload) VALUES (?,?,?,?,?,?)""")

# Unbound columns are skipped entirely — binding None would write a tombstone.
tenant, today = uuid.UUID(int=1), datetime.date.today()
session.execute(ins, (tenant, today, datetime.datetime.utcnow(),
                      uuid.uuid1(), "login", '{"ip":"1.2.3.4"}'))

# Same-partition UNLOGGED batch: the one batch shape that is genuinely cheap,
# because every row lands on the same replica set as a single mutation.
b = BatchStatement(batch_type=BatchType.UNLOGGED,
                   consistency_level=ConsistencyLevel.LOCAL_QUORUM)
for i in range(20):
    b.add(ins, (tenant, today, datetime.datetime.utcnow(), uuid.uuid1(),
                "page_view", f'{{"n":{i}}}'))
session.execute(b)

# Paging: never materialise a whole partition in memory
sel = session.prepare(
    "SELECT event_time, kind FROM events_by_tenant_day WHERE tenant_id=? AND day=?")
stmt = sel.bind((tenant, today)); stmt.fetch_size = 500
for row in session.execute(stmt):      # driver pages transparently
    pass
```

```bash
cqlsh -e "DESCRIBE TABLE app.events_by_tenant_day;"   # the live schema, always
cqlsh -e "COPY app.events_by_tenant_day TO 'events.csv' WITH HEADER=true;"  # small exports only

# Verify partitions actually stayed bounded — the #1 modelling regression
nodetool tablestats app.events_by_tenant_day | grep -E "partition (minimum|maximum|mean) bytes"
# Compacted partition minimum bytes: 259
# Compacted partition maximum bytes: 4866323      4.6 MB, well under the 100 MB limit
# Compacted partition mean bytes: 88211
```

> **Optimization:** always use **prepared statements**. The server parses once and caches by MD5, and — more importantly — the driver learns which bind markers are the partition key, so `TokenAwarePolicy` can route the request straight to a replica instead of a random coordinator. On a 30-node cluster that removes one network hop from every request and typically cuts p99 latency by 30–50%. String-concatenated CQL forfeits both, and re-preparing the same statement in a loop fills the server's prepared-statement cache, evicting hot entries.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| CQL's SQL-like syntax | Immediately familiar; huge driver and tooling ecosystem | Familiarity invites relational assumptions that silently fail at scale |
| Restricted `WHERE` | The engine refuses queries it cannot serve efficiently — errors at dev time, not 3 a.m. | You must design tables per query; new access patterns need new tables and backfills |
| Keyspace-level replication | One statement sets durability and placement for everything inside | Cannot vary RF per table; changing RF requires a full repair afterwards |
| Upsert semantics | Idempotent writes, safe retries, no read-before-write | No "already exists" detection without LWT; `NULL` binds create tombstones |
| Schema evolution | `ADD COLUMN` is metadata-only and instant, even on petabytes | Cannot change a column's type or rename primary-key columns; `DROP` leaves data until compaction |
| Collections & UDTs | Model nested data without extra tables | Read/written whole in many paths; large collections cause heap pressure and tombstones |
| TTL | Automatic expiry, ideal for time-series with TWCS | Every expired cell becomes a tombstone that must survive `gc_grace_seconds` |
| `ALLOW FILTERING` escape hatch | Lets you explore data ad hoc in cqlsh | In application code it turns a targeted read into a cluster-wide scan |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Designing a normalized schema first, then trying to query it.** → ✅ Write the query list first; create one table per query shape and duplicate the data. Denormalization is the design, not a compromise.
2. ⚠️ **Adding `ALLOW FILTERING` to make an error go away.** → ✅ It converts a partition lookup into a scan of every partition on every node. Never in application code — model a new table, or use SAI (5.0) with a bounded predicate.
3. ⚠️ **Using `SimpleStrategy` or omitting a DC name in `NetworkTopologyStrategy`.** → ✅ Always name every datacenter explicitly with RF=3. A DC missing from the map gets **zero** replicas, and `LOCAL_QUORUM` there will fail outright.
4. ⚠️ **Binding `NULL` for optional columns in prepared statements.** → ✅ A `NULL` bind writes a tombstone for that cell on every insert. Leave the parameter `UNSET` (drivers do this by default when you don't bind it) or use separate statements.
5. ⚠️ **`SELECT COUNT(*)` on a table.** → ✅ Without a full partition key this is a cluster-wide scan that will time out at scale. Maintain counters, or use Spark/`dsbulk count` for offline counting.
6. ⚠️ **Unbounded partitions** (`PRIMARY KEY (tenant_id, event_time)` for a firehose tenant). → ✅ Bucket the partition key by time or hash. Keep partitions **< 100 MB and < 100,000 rows**; verify with `nodetool tablestats`.
7. ⚠️ **Multi-partition logged batches used as transactions.** → ✅ A logged batch gives atomicity (all-or-nothing) but **not isolation**, and it forces the coordinator to write a batchlog and fan out to every partition's replicas. Use `UNLOGGED` batches only within one partition; otherwise send independent async writes.
8. ⚠️ **Secondary indexes on high-cardinality columns** (`email`, `uuid`) or booleans. → ✅ Legacy 2i is local per node, so a lookup scatters to all nodes. Build a lookup table, or in 5.0 use `StorageAttachedIndex` — still keeping the predicate selective.
9. ⚠️ **`ORDER BY` a non-clustering column.** → ✅ Sort order is fixed at table creation by `CLUSTERING ORDER BY`. If you need both directions, that is free (`ORDER BY x DESC` on an `ASC` table works); any other order needs a different table.
10. ⚠️ **Running DDL from application startup code, concurrently across pods.** → ✅ Concurrent DDL causes permanent schema disagreement. Apply migrations from a single process, then poll `nodetool describecluster` until there is one schema version.
11. ⚠️ **Storing large blobs or huge collections in a cell.** → ✅ Keep cell values under ~1 MB and collections under ~100 elements; large values inflate the coordinator heap and are re-read on every access.
12. ⚠️ **Assuming `IF NOT EXISTS` on `INSERT` is free.** → ✅ It triggers Paxos (~4 round trips, 10–20× latency) and every other write to that row must also be an LWT or it can clobber the guarded value.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** `DESCRIBE TABLE ks.tbl` in cqlsh gives you the exact live schema including every WITH option — always check it before believing your migration files. `TRACING ON` shows which partitions were read, how many SSTables were touched, and how many tombstones were scanned; the line "Read N live rows and M tombstone cells" is the single most useful diagnostic in Cassandra. `nodetool tablestats ks.tbl` gives partition min/mean/max bytes (your unbounded-partition alarm), SSTable count, and bloom filter false-positive ratio. For schema problems, `SELECT * FROM system_schema.tables WHERE keyspace_name='app'` and `nodetool describecluster` for version convergence. `nodetool tablehistograms` breaks down per-table read/write latency, SSTables per read, and cells per read at each percentile.

**Monitoring.** Table-level beans matter here: `org.apache.cassandra.metrics:type=Table,keyspace=app,scope=events_by_tenant_day,name=` with `EstimatedPartitionSizeHistogram` (alert if p99 > 100 MB), `TombstoneScannedHistogram` (alert if p99 > 1000), `SSTablesPerReadHistogram`, `LiveScannedHistogram`, `ReadLatency`/`WriteLatency`, and `BloomFilterFalseRatio`. Also watch `type=ClientRequest,name=Failures` for `TombstoneOverwhelmingException` cascades. Cassandra logs a warning for any partition exceeding `compaction_large_partition_warning_threshold` (default 100 MiB) and for any query scanning more than `tombstone_warn_threshold` (1000) tombstones — ship those log lines to your alerting pipeline; they are free early warnings.

**Security.** Grants are per keyspace, per table, and per role: `GRANT SELECT ON KEYSPACE app TO reader;` `GRANT MODIFY ON app.events_by_tenant_day TO writer;`. Never give the application role `ALTER`, `DROP`, or `CREATE` — schema changes belong to a migration identity. `system_auth` must use `NetworkTopologyStrategy` with RF matching your data keyspaces, or logins fail during a node outage. Cassandra 4.0+ audit logging can record DDL and DCL separately (`included_categories: DDL,DCL,AUTH`), which is how you prove who altered a table. Note that `DESCRIBE` requires only `SELECT` on `system_schema`, so schema is effectively readable by any authenticated role.

**Performance & scaling.** Pick compaction by access pattern: `SizeTieredCompactionStrategy` (default, write-heavy), `LeveledCompactionStrategy` (read-heavy or overwrite-heavy — costs roughly 2× write I/O but bounds SSTables-per-read), `TimeWindowCompactionStrategy` (time-series with TTLs — lets whole SSTables be dropped when fully expired), and in 5.0 `UnifiedCompactionStrategy` which subsumes STCS/LCS behaviour under one tunable. Set `default_time_to_live` on time-series tables so data expires without explicit deletes. Always page (`fetch_size`, default 5000) rather than pulling whole partitions, and size `chunk_length_in_kb` down to 4 KB for small-row random-read tables to reduce read amplification.

## 9. Interview Questions

**Q: What is a keyspace and what does it control?**
A: A keyspace is the top-level container for tables, holding the replication strategy and replication factor plus `durable_writes`. It decides how many copies of every partition exist and in which datacenters, which in turn determines your quorum arithmetic and fault tolerance. Replication cannot be set per table — all tables in a keyspace share it.

**Q: What is the difference between `SimpleStrategy` and `NetworkTopologyStrategy`?**
A: `SimpleStrategy` places replicas on the next nodes clockwise on the ring with no awareness of racks or datacenters, so all copies can land in one AZ. `NetworkTopologyStrategy` takes an explicit RF per datacenter and skips racks already used, giving real fault isolation. Always use `NetworkTopologyStrategy` in production, even for a single datacenter.

**Q: What is the difference between `INSERT` and `UPDATE` in CQL?**
A: Functionally almost nothing — both are upserts that write cells with timestamps, with no read-before-write and no existence check. The one difference is that `INSERT` writes a primary-key liveness marker (row marker) while a bare `UPDATE` does not, so a row created by `UPDATE` disappears once all its non-key columns are deleted or expire.

**Q: Why does `SELECT * FROM t WHERE some_column = 'x'` fail?**
A: Because `some_column` is not part of the primary key and has no index, Cassandra cannot determine which partitions hold matching rows — it would have to scan every partition on every node. It refuses and suggests `ALLOW FILTERING`, which you should treat as a warning label rather than a fix.

**Q: What does `ALLOW FILTERING` actually do?**
A: It permits the coordinator to read rows the predicate cannot target and discard non-matching ones, which in practice means a range scan across all token ranges and all replicas. Latency becomes proportional to total data volume, not result size, and it competes with production traffic for the read thread pool. It is acceptable for one-off exploration in cqlsh and essentially never in application code.

**Q: What is a static column and when would you use it?**
A: A column declared `STATIC` is stored once per partition rather than once per row, shared by every row in that partition. It's useful for partition-level metadata — a channel's display name alongside its messages, or a tenant's plan alongside their events — avoiding both duplication and a second table lookup. Static columns require a table that has clustering columns.

**Q: What happens when you write `NULL` to a column?**
A: It is a delete: Cassandra writes a tombstone for that cell, which then has to be retained for `gc_grace_seconds` and skipped on every read of the partition. This is why binding `None`/`null` for unused parameters in a hot insert path silently generates millions of tombstones — leave the parameter `UNSET` instead.

**Q: (Senior) Explain the exact rules for a legal `WHERE` clause.**
A: Every partition key column must be restricted with `=` or `IN`. Clustering columns may then be restricted left to right with no gaps: all but the last restricted one must use equality, and the last may use a range operator. Non-key columns require a secondary index or SAI, and `ORDER BY` may only use clustering columns in the declared order or its exact reverse. Anything else requires `ALLOW FILTERING`.

**Q: (Senior) When is a `BATCH` a good idea, and when is it harmful?**
A: An `UNLOGGED` batch confined to a single partition is genuinely good — it becomes one mutation to one replica set, saving round trips. A multi-partition `LOGGED` batch is usually harmful: the coordinator first writes the batch to a batchlog on two other nodes, then fans out to every partition's replicas, so it is slower than independent async writes and makes one node a bottleneck. Logged batches provide atomicity but not isolation, so they are not transactions; their legitimate use is keeping denormalized tables in sync where partial application is unacceptable.

**Q: (Senior) You need to add a column and change a column's type. What can Cassandra do?**
A: `ALTER TABLE ... ADD col type` is metadata-only and effectively instant, even on petabytes, because old SSTables simply have no cell for it and reads return null. Changing a column's type is not supported (it was removed entirely in 3.x for anything but trivially compatible cases), and neither is renaming a non-primary-key column. The real procedure is: add a new column, dual-write, backfill, migrate readers, then drop the old column — and remember `DROP COLUMN` leaves the data in SSTables until compaction rewrites them, and you cannot re-add that name with a different type.

**Q: (Senior) How do collections behave on disk, and when do they hurt?**
A: A `set`/`list`/`map` is stored as individual cells inside the row, each with its own timestamp, plus (for non-frozen collections) a range tombstone whenever you overwrite the whole collection. So `UPDATE t SET tags = {...}` writes a tombstone covering the old collection plus new cells — repeated wholesale overwrites are a tombstone generator. `frozen<>` collections are stored as one opaque blob, which avoids that but means any change rewrites the entire value. Keep collections small (tens of elements) and prefer appending to a non-frozen collection over replacing it.

**Q: What does `WRITETIME()` tell you and why does it matter?**
A: It returns the microsecond timestamp attached to a cell, which is the value Cassandra compares to resolve conflicts under last-write-wins. It is invaluable for debugging "why did my update not take effect?" — usually the answer is that another write, or a client with a skewed clock, carries a higher timestamp. It cannot be called on primary-key columns or on collections as a whole.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A **keyspace** sets replication: always `NetworkTopologyStrategy` with an explicit RF per datacenter (usually 3); it cannot vary per table. A **table** sets storage layout via `PRIMARY KEY ((partition cols), clustering cols)` — the partition key is hashed to pick nodes, the clustering columns define on-disk sort order. Legal `WHERE`: full partition key with `=`/`IN`, then clustering columns left to right with no gaps, only the last using a range. Everything else needs an index or `ALLOW FILTERING` — which means a cluster-wide scan and does not belong in application code. `INSERT` and `UPDATE` are the same idempotent upsert with no read-before-write; binding `NULL` writes a tombstone, so leave parameters `UNSET`. TTLs and deletes create tombstones that must survive `gc_grace_seconds` (864000). Keep partitions under 100 MB and 100k rows. Use prepared statements with a token-aware policy, page results with `fetch_size`, and use batches only within a single partition.

| Task | CQL / command |
|---|---|
| Create keyspace | `CREATE KEYSPACE app WITH replication = {'class':'NetworkTopologyStrategy','dc1':3};` |
| Change RF | `ALTER KEYSPACE app WITH replication = {...};` then **full repair** |
| Composite primary key | `PRIMARY KEY ((a, b), c, d)` — `(a,b)` partition, `c,d` clustering |
| Sort order | `WITH CLUSTERING ORDER BY (c DESC, d ASC)` |
| Row TTL | `INSERT ... USING TTL 604800` or `default_time_to_live` |
| Add column | `ALTER TABLE t ADD col text;` (instant, metadata only) |
| See live schema | `DESCRIBE TABLE ks.t;` |
| Cell metadata | `SELECT WRITETIME(col), TTL(col) FROM ...` |
| Set CL in cqlsh | `CONSISTENCY LOCAL_QUORUM;` |
| Explain a query | `TRACING ON;` then run it |
| Partition sizes | `nodetool tablestats ks.t` |
| Tombstone thresholds | warn `1000`, fail `100000` |
| Partition guidance | `< 100 MB`, `< 100,000 rows` |

**Flash cards**
- **What does a keyspace control?** → Replication strategy and RF per datacenter (plus `durable_writes`) for every table it contains.
- **Legal `WHERE` rule** → Full partition key with `=`/`IN`, then clustering columns left to right, no gaps, range only on the last.
- **`INSERT` vs `UPDATE`** → Same upsert; only `INSERT` writes a row liveness marker. Neither reads first.
- **What does binding `NULL` do?** → Writes a tombstone. Use `UNSET` for parameters you don't want to write.
- **When is a batch good?** → Only when all statements target the same partition (`UNLOGGED`); multi-partition logged batches are slower than independent async writes.

## 11. Hands-On Exercises & Mini Project

- [ ] Create a keyspace with `NetworkTopologyStrategy` RF=3, then create the same table twice with `PRIMARY KEY (a, b)` and `PRIMARY KEY ((a, b))` and use `nodetool getendpoints` to show the second spreads data across many more partitions.
- [ ] Write ten rows, then run five queries that the engine *rejects* and record the exact `InvalidRequest` message for each: incomplete partition key, gap in clustering columns, equality after a range, non-key predicate, and illegal `ORDER BY`.
- [ ] Insert 1,000 rows binding `None` for one optional column, then `TRACING ON` a read of that partition and record the "tombstone cells" count. Repeat with the parameter left `UNSET` and compare.
- [ ] Insert a row with `USING TTL 60`, then query `TTL(col)` and `WRITETIME(col)` every 10 seconds until the row disappears; confirm with `sstablemetadata` that a tombstone was created.
- [ ] Build two versions of an events table — one with `PRIMARY KEY (tenant_id, event_time)` and one bucketed by day — load 500,000 rows into each, and compare `Compacted partition maximum bytes` from `nodetool tablestats`.

### Mini Project — "Query-First Schema for a SaaS Audit Log"

**Goal.** Design and implement the complete CQL layer for a multi-tenant audit log, driven entirely by a written query list.

**Requirements.**
1. Write down five access patterns first: (a) a tenant's events for a given day, newest first; (b) a single event by id; (c) a tenant's events of one `kind` for a day; (d) a tenant's most recent 20 events regardless of day; (e) count of events per tenant per day.
2. Create one table per pattern in a single keyspace with `NetworkTopologyStrategy` RF=3, choosing partition keys that stay under 100 MB, using `CLUSTERING ORDER BY` for (a) and (d), a counter table for (e), and `default_time_to_live` plus TWCS on the time-series tables.
3. Implement a Python writer that fans a single logical event into all the tables with prepared statements at `LOCAL_QUORUM`, using `UNSET` for optional fields and an `UNLOGGED` batch only where all rows share a partition.
4. Implement a reader for each pattern with paging, and prove with `TRACING ON` that every query touches exactly one partition.

**Extensions.**
- Add a `frozen<geo>` UDT and a `set<text>` of tags; measure the SSTable size difference between updating the tag set wholesale versus appending with `tags = tags + {'x'}`.
- Add a Cassandra 5.0 `StorageAttachedIndex` on `kind` and compare its trace against the dedicated table for pattern (c).
- Write a schema migration script that adds a column, dual-writes, backfills with `dsbulk`, and flips readers — then verify `nodetool describecluster` shows a single schema version at every step.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is Apache Cassandra?* (why the query-first model exists), *History & Architecture Overview* (CQL replacing Thrift, and the row-aware storage engine behind these tables), *CAP Theorem & Tunable Consistency* (the RF you just declared drives quorum math), *Installation & Cluster Setup* (the datacenter names your keyspace must match), *Primary Key: Partition & Clustering Columns* (the deep dive into the single line that decides everything here).

- **Apache Cassandra — The Cassandra Query Language (CQL)** — Apache Software Foundation · *Beginner* · the normative CQL reference: every statement, every `WITH` option, every restriction rule. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/>
- **Apache Cassandra — Data Modeling** — Apache Software Foundation · *Intermediate* · the official conceptual → logical → physical modelling methodology, with worked examples and sizing formulas. <https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/>
- **Basic Rules of Cassandra Data Modeling** — DataStax Engineering · *Beginner* · the classic "spread data evenly, minimise partitions read" article that every Cassandra modeller should read once. <https://www.datastax.com/blog/basic-rules-cassandra-data-modeling>
- **DataStax Academy — Cassandra Data Modeling** — DataStax · *Beginner* · free hands-on course covering keyspaces, tables, collections, and query-first design with browser labs. <https://www.datastax.com/learn/cassandra-data-modeling>
- **Cassandra Query Language: Everything You Need To Know About Tombstones** — The Last Pickle · *Advanced* · how `NULL` binds, TTLs, collection overwrites, and range deletes all produce tombstones, with real diagnostics. <https://thelastpickle.com/blog/2016/07/27/about-deletes-and-tombstones.html>
- **CASSANDRA-8099: Storage engine refactor** — Apache JIRA · *Advanced* · explains how CQL rows actually map onto cells and clustering prefixes on disk — the best answer to "what does my primary key become?". <https://issues.apache.org/jira/browse/CASSANDRA-8099>
- **Storage-Attached Indexes (CEP-7)** — Apache Cassandra · *Advanced* · the design and limits of SAI in 5.0, the modern answer to "can I query a non-key column?". <https://cwiki.apache.org/confluence/display/CASSANDRA/CEP-7%3A+Storage+Attached+Index>
- **DataStax Bulk Loader (dsbulk)** — DataStax · *Intermediate* · free tool for loading, unloading, and counting rows far faster and more safely than `COPY`. <https://docs.datastax.com/en/dsbulk/docs/>

---

*Apache Cassandra Handbook — chapter 05.*
