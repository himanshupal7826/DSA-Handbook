# 06 · Primary Key: Partition & Clustering Columns

> **In one line:** One line of DDL — `PRIMARY KEY ((partition columns), clustering columns)` — decides which machines hold your data, how it is sorted on disk, and which queries will ever be legal; everything else in Cassandra is a consequence of it.

---

## 1. Overview

In a relational database the primary key is a uniqueness constraint. You can change your mind later: add an index, cluster the table differently, let the planner pick a new path. In Cassandra the primary key is the **physical storage layout**, chosen at `CREATE TABLE` time and immutable for the life of the table. It answers two completely different questions with one syntax: *which nodes own this row* (the partition key) and *where inside that node's file does the row sit* (the clustering columns). Confusing the two is the single most expensive mistake in Cassandra, because the fix is never a tuning flag — it is a new table, a dual-write, and a backfill.

The reason for this design is the absence of a coordinator with global knowledge. There is no master, no shard map service, no catalog that says "user 42 lives on node 17". Every client and every node computes ownership from first principles: hash the partition key with Murmur3, get a 64-bit token, walk the ring clockwise to find the token's owner, then pick `RF-1` more replicas honouring rack and datacenter rules. That computation is deterministic, requires zero network calls, and works identically on a 3-node cluster and a 1,500-node one. The price is that the hash destroys ordering — you can never ask "give me partitions between X and Y" — which is exactly why clustering columns exist as a second, *ordered* level of the key.

The split dates back to the Thrift era: a Thrift "row" was a row key plus an arbitrarily wide, sorted set of columns, and CQL simply gave that shape a schema — the row key became the partition key, the sorted column names became clustering values, and a CQL row became the cells sharing a clustering prefix. Cassandra 3.0's storage-engine rewrite (CASSANDRA-8099) made rows first-class rather than a naming convention over cells, but the two-level shape survived unchanged, which is why "a partition is a sorted map of clustering keys to rows" is still exactly right in 5.0.

Chapter 05 introduced this line as part of `CREATE TABLE`; this chapter takes it apart, and chapter 07 makes it the atom of query-first design. A concrete example: Discord's message store keys on `((channel_id, bucket), message_id)` with `message_id` descending. `channel_id` and `bucket` hash together into one token, so every message in a channel-month lands on the same three replicas; `message_id` sorts the messages newest-first inside that partition, contiguous on disk. "Last 50 messages in this channel" is one token computation, one replica, one seek, fifty rows read sequentially, `LIMIT` stopping the scan — and it costs the same whether the channel has 500 messages or 50 million, because the bucket bounds the partition. Had they written `PRIMARY KEY (channel_id, message_id)` with no bucket, the busiest channel would eventually own a multi-gigabyte partition that no compaction, repair, or read path can handle gracefully.

---

## 2. Core Concepts

- **Primary key** — the full `PRIMARY KEY (...)` declaration: partition key plus clustering columns. It uniquely identifies a CQL row and is **immutable** — you cannot `ALTER` it, and you cannot `UPDATE` a value inside it.
- **Partition key** — the first element of the primary key. Hashed by Murmur3 into a token; that token alone determines replica placement. Must be supplied in full, with `=` or `IN`, on any efficient query.
- **Composite (compound) partition key** — two or more columns wrapped in an extra pair of parentheses: `PRIMARY KEY ((a, b), c)`. All of them are hashed *together* into one token — they are not independent lookup dimensions.
- **Clustering column** — every primary-key column after the partition key. Not hashed; used to sort rows **within** a partition and to slice ranges of them cheaply.
- **Token** — a 64-bit signed integer in `[-2^63, 2^63-1]` produced by `Murmur3Partitioner`. The ring is the space of all tokens; each node owns `num_tokens` (default **16** in 4.x) ranges of it.
- **Partition** — all rows sharing a partition key value; the unit of placement, replication, repair streaming, and row cache. It never spans nodes and never splits.
- **`CLUSTERING ORDER BY`** — the table option fixing on-disk sort direction per clustering column (`ASC` default). A physical layout choice, not a query hint.
- **Clustering prefix** — the left-to-right sequence of clustering columns you have restricted. Legal slices require a gapless prefix; the storage engine can only seek to a prefix.
- **Bucketing** — appending a synthetic component (`day`, `hour`, `hash(id) % N`) to the partition key to bound an otherwise unbounded partition. The practical ceiling it enforces: **< 100 MB** and **< 100,000 rows** per partition.
- **`token()`** — the CQL function exposing the partitioner: `SELECT token(k) FROM t`, and `WHERE token(k) > ? AND token(k) <= ?` for token-range scans (how Spark and `dsbulk` parallelise full reads).

---

## 3. Theory & Internals

### The syntax, precisely

```
PRIMARY KEY (a)                  -- a is the partition key. No clustering columns.
PRIMARY KEY (a, b, c)            -- a is the partition key; b, c are clustering columns.
PRIMARY KEY ((a, b), c, d)       -- (a, b) is a COMPOSITE partition key; c, d cluster.
PRIMARY KEY ((a))                -- identical to PRIMARY KEY (a).
```

The double parentheses are the whole game. `PRIMARY KEY (tenant_id, day)` and `PRIMARY KEY ((tenant_id, day))` are two entirely different tables: the first makes one partition per tenant containing one row per day; the second makes one partition per tenant-day containing exactly one row. Same columns, same uniqueness, opposite physics.

### From key to token to replicas

The partition key columns are serialised in declaration order and concatenated. For a single-column key the raw bytes are hashed directly; for a composite key each component is wrapped as `[2-byte length][value][0x00]` and the whole buffer is hashed once. Murmur3 (128-bit variant, first 64 bits taken) produces the token:

```
token = murmur3_128(serialized_partition_key)[0:64]      range: -2^63 .. 2^63-1
primary replica = first node whose token range contains `token` (walking clockwise)
further replicas = next distinct racks/DCs per NetworkTopologyStrategy
```

Two consequences that people fight against and always lose:

1. **Adjacent keys are not adjacent tokens.** `tenant=1` and `tenant=2` land in unrelated parts of the ring. Range scans on the partition key are therefore impossible — only `token()` ranges are, and those return data in token order, which is meaningless to your application.
2. **A composite partition key is one atomic value.** `((tenant_id, day))` does *not* let you query by `tenant_id` alone. You need both components to compute the hash.

### Clustering: the sorted map inside a partition

Within one partition the storage engine keeps rows in a sorted structure keyed by the clustering values, in the declared order and direction. On disk, an SSTable stores the partition's rows contiguously and, for partitions above `column_index_size` (default **64 KiB**), builds a row index of offsets so a slice can binary-search instead of scanning (CASSANDRA-11206 replaced the flat index with a birch tree so huge partitions stop blowing the heap).

That structure explains every `WHERE` rule. A seek needs a **prefix**: `(c1=?, c2=?, c3>?)` maps to "position at the first entry with this prefix, then read forward until c3 leaves the range". A gap — `(c1=?, c3=?)` — has no such position, because entries are ordered by `c1` then `c2` then `c3`, and every `c2` value interleaves. The engine would have to read the whole partition and filter.

```
PRIMARY KEY ((a, b), c, d, e)

WHERE a=? AND b=?                          one whole partition                    OK
WHERE a=? AND b=? AND c=? AND d>=? AND d<? contiguous range on the last column    OK
WHERE a=? AND b=? AND c IN (?,?) AND d=?   IN on a prefix, equality after         OK
WHERE a=? AND b=? AND (c,d) > (?,?)        multi-column slice (keyset paging)     OK
WHERE a=? AND b=? AND d=?                  gap: c unrestricted                    NO
WHERE a=? AND c=?                          partition key incomplete               NO
WHERE a=? AND b=? AND c>? AND d=?          equality after a range                 NO
WHERE a=? AND b=? AND e='x' ALLOW FILTERING   filtering inside ONE partition      OK-ish
WHERE e='x' ALLOW FILTERING                cluster-wide scan                      NEVER
```

The last two matter: `ALLOW FILTERING` **with a full partition key** filters within a single partition and is bounded and usually fine. `ALLOW FILTERING` **without** one is a scan of every token range on every node, with latency proportional to total data size.

### Sizing arithmetic you do before writing DDL

`rows_per_partition ≈ product of the distinct values of every clustering column`, and `partition_bytes ≈ rows_per_partition × (sum of value sizes + ~8–20 B/row overhead)`. A sensor at 1 Hz with `PRIMARY KEY ((sensor_id, day), ts)` gives 86,400 rows/day × ~120 B ≈ **10 MB** — healthy. Switch the bucket to `month` and it is 2.6 M rows and ~310 MB — over budget on both axes. The bucket granularity *is* the sizing knob, and it should be chosen from the **peak** rate, not the average.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="k6a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <rect x="0" y="0" width="780" height="360" fill="#ffffff"/>
  <text x="390" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Anatomy of PRIMARY KEY ((tenant_id, day), event_time, event_id)</text>
  <rect x="30" y="38" width="330" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="45" y="60" fill="#1e293b" font-weight="bold">PARTITION KEY (tenant_id, day)</text>
  <text x="45" y="78" fill="#1e293b" font-size="11">hashed together as ONE value &#8212; never queryable apart</text>
  <text x="45" y="92" fill="#1e293b" font-size="11">must be fully supplied with = or IN</text>
  <rect x="400" y="38" width="350" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="415" y="60" fill="#1e293b" font-weight="bold">CLUSTERING (event_time DESC, event_id ASC)</text>
  <text x="415" y="78" fill="#1e293b" font-size="11">NOT hashed &#8212; sorts rows inside the partition</text>
  <text x="415" y="92" fill="#1e293b" font-size="11">gapless left-to-right prefix, range only on the last</text>
  <line x1="195" y1="100" x2="195" y2="122" stroke="#4f46e5" stroke-width="2" marker-end="url(#k6a)"/>
  <line x1="575" y1="100" x2="575" y2="226" stroke="#16a34a" stroke-width="2" marker-end="url(#k6a)"/>
  <rect x="30" y="126" width="330" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="45" y="147" fill="#1e293b" font-size="11">serialize: [len]t-42[00][len]2026-07-22[00]</text>
  <text x="45" y="166" fill="#1e293b" font-size="11">murmur3_128(...)[0:64] &#8594; token 3 812 447 118 902</text>
  <circle cx="195" cy="272" r="72" fill="none" stroke="#0ea5e9" stroke-width="2"/>
  <text x="195" y="200" text-anchor="middle" fill="#1e293b" font-size="11">token ring &#8722;2^63 .. 2^63&#8722;1</text>
  <circle cx="123" cy="272" r="6" fill="#0ea5e9"/>
  <circle cx="246" cy="221" r="7" fill="#d97706"/>
  <text x="258" y="216" fill="#1e293b" font-size="11">N4 owns it</text>
  <text x="195" y="276" text-anchor="middle" fill="#1e293b" font-size="11">RF=3 &#8594; N4, N7, N2</text>
  <rect x="400" y="230" width="350" height="112" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="415" y="250" fill="#1e293b" font-weight="bold">partition (t-42, 2026-07-22) on N4 disk</text>
  <rect x="415" y="258" width="320" height="20" rx="3" fill="#ffffff" stroke="#d97706"/>
  <text x="423" y="272" fill="#1e293b" font-size="11">18:42:11 &#183; evt-a   &#8592; first row, newest</text>
  <rect x="415" y="284" width="320" height="20" rx="3" fill="#ffffff" stroke="#d97706"/>
  <text x="423" y="298" fill="#1e293b" font-size="11">18:41:57 &#183; evt-b</text>
  <text x="415" y="326" fill="#1e293b" font-size="11">contiguous bytes &#8594; one seek, LIMIT stops early</text>
</svg>
```

---

## 4. Architecture & Workflow

Follow one `SELECT` from the client to the bytes, and one `CREATE TABLE` decision to its consequences.

1. **Prepare.** The driver sends the CQL text once; the server returns metadata that includes *which bind markers are partition-key components*. This is what makes token-aware routing possible — an unprepared, string-formatted statement cannot be routed.
2. **Client-side token computation.** On execute, the driver serialises the bound partition-key values, applies Murmur3 itself, and looks up the replica set from the gossip-derived ring it already holds. It picks a **local-DC replica** as coordinator. Zero extra hops.
3. **Coordinator validation.** The coordinator re-checks the restrictions against the primary key: full partition key with `=`/`IN`, gapless clustering prefix, range only on the last restricted clustering column, `ORDER BY` matching the declared clustering order or its exact reverse. Failures return `InvalidRequest` before any disk is touched.
4. **Replica selection and consistency.** With `NetworkTopologyStrategy {dc_east: 3, dc_west: 3}` and `LOCAL_QUORUM`, the coordinator needs `floor(3/2)+1 = 2` acks from `dc_east` only. It sends a full data read to the fastest replica (chosen by the dynamic snitch) and digest reads to the others.
5. **Per-replica bloom filter check.** Each SSTable's bloom filter is asked "might you contain this *partition*?" — bloom filters are keyed on the partition key, never on clustering values. Negative answers skip the file entirely.
6. **Partition index seek.** For surviving SSTables, `Summary.db` narrows the region and `Index.db` gives the byte offset of the partition inside `Data.db`. For large partitions the in-partition row index is then binary-searched for the clustering prefix.
7. **Slice read and merge.** The clustering slice is read as a contiguous run from each SSTable and the memtable, then merged: rows in clustering order, cells resolved by highest timestamp, tombstones applied, `LIMIT` and `PER PARTITION LIMIT` applied at the end.
8. **The DDL-time consequences.** Nothing in steps 2–7 is tunable at query time. A missing bucket means one hot replica set forever; a wrong `CLUSTERING ORDER BY` means every read walks the partition backwards; a clustering column in the wrong position makes a whole class of queries illegal. And you cannot `ALTER TABLE ... PRIMARY KEY` — the only fix is a new table, dual writes, a token-range-parallel backfill, and a read cutover.

```svg
<svg viewBox="0 0 780 356" width="100%" height="356" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="k6b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <rect x="0" y="0" width="780" height="356" fill="#ffffff"/>
  <text x="390" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Read path: how the key rules become disk seeks</text>
  <rect x="25" y="38" width="175" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="112" y="59" text-anchor="middle" fill="#1e293b" font-weight="bold">1. Driver</text>
  <text x="112" y="77" text-anchor="middle" fill="#1e293b" font-size="10">murmur3(pk) &#8594; replica set</text>
  <rect x="215" y="38" width="175" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="302" y="59" text-anchor="middle" fill="#1e293b" font-weight="bold">2. Coordinator</text>
  <text x="302" y="77" text-anchor="middle" fill="#1e293b" font-size="10">validate WHERE vs key</text>
  <rect x="405" y="38" width="175" height="56" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="492" y="59" text-anchor="middle" fill="#1e293b" font-weight="bold">3. LOCAL_QUORUM</text>
  <text x="492" y="77" text-anchor="middle" fill="#1e293b" font-size="10">2 of 3 in local DC</text>
  <rect x="595" y="38" width="160" height="56" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="675" y="59" text-anchor="middle" fill="#1e293b" font-weight="bold">4. Replica</text>
  <text x="675" y="77" text-anchor="middle" fill="#1e293b" font-size="10">memtable + SSTables</text>
  <line x1="202" y1="66" x2="211" y2="66" stroke="#0ea5e9" stroke-width="2" marker-end="url(#k6b)"/>
  <line x1="392" y1="66" x2="401" y2="66" stroke="#0ea5e9" stroke-width="2" marker-end="url(#k6b)"/>
  <line x1="582" y1="66" x2="591" y2="66" stroke="#0ea5e9" stroke-width="2" marker-end="url(#k6b)"/>
  <rect x="25" y="114" width="360" height="122" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="40" y="135" fill="#1e293b" font-weight="bold">Inside one replica: partition key work</text>
  <text x="40" y="156" fill="#1e293b" font-size="11">Filter.db bloom filter &#8594; skip SSTables entirely</text>
  <text x="40" y="174" fill="#1e293b" font-size="11">Summary.db &#8594; narrow the index region</text>
  <text x="40" y="192" fill="#1e293b" font-size="11">Index.db &#8594; byte offset of the partition</text>
  <text x="40" y="216" fill="#1e293b" font-size="11">bloom filters know PARTITIONS only</text>
  <rect x="405" y="114" width="350" height="122" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="420" y="135" fill="#1e293b" font-weight="bold">Inside one partition: clustering work</text>
  <text x="420" y="156" fill="#1e293b" font-size="11">row index every column_index_size (64 KiB)</text>
  <text x="420" y="174" fill="#1e293b" font-size="11">binary-search the clustering PREFIX</text>
  <text x="420" y="192" fill="#1e293b" font-size="11">read forward until the range ends</text>
  <text x="420" y="216" fill="#1e293b" font-size="11">merge by timestamp, then LIMIT</text>
  <rect x="25" y="256" width="360" height="84" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="40" y="277" fill="#1e293b" font-weight="bold">Bounded: ((sensor, day), ts)</text>
  <text x="40" y="297" fill="#1e293b" font-size="11">86 400 rows/day &#215; 120 B &#8776; 10 MB</text>
  <text x="40" y="315" fill="#1e293b" font-size="11">spread over the whole ring; cheap repair</text>
  <text x="40" y="333" fill="#1e293b" font-size="11">read p99 stays flat as data grows</text>
  <rect x="405" y="256" width="350" height="84" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="420" y="277" fill="#1e293b" font-weight="bold">Unbounded: ((sensor), ts)</text>
  <text x="420" y="297" fill="#1e293b" font-size="11">grows forever &#8594; GB-scale single partition</text>
  <text x="420" y="315" fill="#1e293b" font-size="11">one replica set carries it all &#8594; hotspot</text>
  <text x="420" y="333" fill="#1e293b" font-size="11">warn at 100 MiB, then heap pressure, timeouts</text>
</svg>
```

---

## 5. Implementation

```cql
CREATE KEYSPACE IF NOT EXISTS iot
WITH replication = {'class': 'NetworkTopologyStrategy', 'dc_east': 3, 'dc_west': 3};

USE iot;

-- The two shapes people confuse, same columns, opposite physics.
CREATE TABLE k2 (a text, b text, c text, PRIMARY KEY (a, b));      -- a partitions, b clusters
CREATE TABLE k3 (a text, b text, c text, PRIMARY KEY ((a, b), c)); -- (a,b) partitions, c clusters

-- The production table: bucketed time series, newest first.
CREATE TABLE IF NOT EXISTS readings_by_sensor_day (
    sensor_id   uuid,
    day         date,                     -- bucket: bounds the partition
    ts          timestamp,
    seq         int,
    sensor_name text STATIC,              -- once per partition, not per row
    celsius     float,
    humidity    float,
    PRIMARY KEY ((sensor_id, day), ts, seq)
) WITH CLUSTERING ORDER BY (ts DESC, seq ASC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'DAYS', 'compaction_window_size': 1}
  AND default_time_to_live = 7776000       -- 90 days
  AND comment = '1 Hz x 86400 rows x ~120 B = ~10 MB/partition; peak 4 Hz = ~40 MB';
```

```cql
-- Queries the engine accepts
SELECT ts, celsius FROM readings_by_sensor_day
WHERE sensor_id = 3f2a... AND day = '2026-07-22' LIMIT 100;             -- newest 100

SELECT ts, celsius FROM readings_by_sensor_day
WHERE sensor_id = 3f2a... AND day = '2026-07-22'
  AND ts >= '2026-07-22 06:00:00+0000' AND ts < '2026-07-22 07:00:00+0000';

SELECT * FROM readings_by_sensor_day
WHERE sensor_id = 3f2a... AND day IN ('2026-07-21','2026-07-22')
PER PARTITION LIMIT 10;                       -- 2 partitions, 10 rows each

SELECT * FROM readings_by_sensor_day
WHERE sensor_id = 3f2a... AND day = '2026-07-22' AND (ts, seq) < ('2026-07-22 06:00:00+0000', 4)
LIMIT 20;                                     -- multi-column slice = keyset pagination

-- Queries the engine refuses, with the exact errors
SELECT * FROM readings_by_sensor_day WHERE sensor_id = 3f2a...;
-- InvalidRequest: Cannot execute this query as it might involve data filtering ...
--   (composite partition key incomplete: `day` missing)

SELECT * FROM readings_by_sensor_day WHERE sensor_id=3f2a... AND day='2026-07-22' AND seq=3;
-- InvalidRequest: PRIMARY KEY column "seq" cannot be restricted as preceding
--   column "ts" is not restricted

SELECT * FROM readings_by_sensor_day
WHERE sensor_id=3f2a... AND day='2026-07-22' ORDER BY seq DESC;
-- InvalidRequest: Order by currently only supports the ordering of columns
--   following their declared order in the PRIMARY KEY

UPDATE readings_by_sensor_day SET day='2026-07-23' WHERE sensor_id=3f2a... AND ...;
-- InvalidRequest: PRIMARY KEY part day found in SET part

-- token(): the partitioner, exposed
SELECT sensor_id, day, token(sensor_id, day) AS tk FROM readings_by_sensor_day LIMIT 2;
--  sensor_id | day        | tk
--  3f2a...   | 2026-07-22 |  3812447118902334721
--  9b71...   | 2026-07-22 | -6640220102918733004

-- Parallel full-table export: split the ring into N ranges, one worker each.
SELECT sensor_id, day, ts, celsius FROM readings_by_sensor_day
WHERE token(sensor_id, day) > -9223372036854775808
  AND token(sensor_id, day) <= -4611686018427387904;
```

```bash
# Which nodes own a given partition? Composite components are colon-separated.
nodetool getendpoints iot readings_by_sensor_day "3f2a1c88-...:2026-07-22"
# 10.0.1.14   10.0.1.17   10.0.1.12

# Are partitions actually bounded?
nodetool tablehistograms iot readings_by_sensor_day
# Percentile  SSTables  Write(us)  Read(us)  Partition Size  Cell Count
# 50%             1.00      31.2      118.5           10240         512
# 99%             2.00     105.8      598.1        11259882      131072
# Max             3.00     215.6     1847.3        14680064      172032   <- 14 MB, healthy

nodetool toppartitions iot readings_by_sensor_day 10000   # hottest keys, sampled live
```

```python
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.policies import DCAwareRoundRobinPolicy, TokenAwarePolicy
from cassandra import ConsistencyLevel
import datetime, uuid

profile = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc="dc_east")),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM)
cluster = Cluster(["10.0.1.11"], execution_profiles={EXEC_PROFILE_DEFAULT: profile})
session = cluster.connect("iot")

# The driver learns the key layout from server-side schema metadata; that is what
# lets TokenAwarePolicy hash the right bind markers and route to a replica.
t = cluster.metadata.keyspaces["iot"].tables["readings_by_sensor_day"]
print([c.name for c in t.partition_key])   # ['sensor_id', 'day']
print([c.name for c in t.clustering_key])  # ['ts', 'seq']

# Keyset pagination on the clustering columns — never OFFSET, Cassandra has none.
sensor, day = uuid.UUID("3f2a1c88-0000-0000-0000-000000000000"), datetime.date(2026, 7, 22)
page = session.prepare("""SELECT ts, seq, celsius FROM readings_by_sensor_day
    WHERE sensor_id=? AND day=? AND (ts, seq) < (?, ?) LIMIT 500""")
cursor = (datetime.datetime(2026, 7, 23), 0)
while True:
    rows = list(session.execute(page, (sensor, day, cursor[0], cursor[1])))
    if not rows:
        break
    cursor = (rows[-1].ts, rows[-1].seq)
```

> **Optimization:** when a partition is *large but bounded* and you always read the newest rows, `CLUSTERING ORDER BY (ts DESC)` is not cosmetic — it physically stores the newest rows first, so `LIMIT 50` reads the first 64 KiB block and stops. With `ASC` storage, the same query is a reverse iteration that must locate the *end* of the partition and walk backwards, allocating more heap and touching more index blocks. On a 40 MB partition the measured difference is routinely 3–10× on p99. Declare the order the dominant query wants, and pay the reverse cost on the rare query instead.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| Hash-partitioned placement | Ownership is computed locally with zero lookups; scales identically at 3 and 3,000 nodes | Ordering is destroyed — no range scans, no `BETWEEN`, no global sort on the partition key |
| Composite partition key | Lets you widen a coarse key (`(country, day)`) to spread load evenly | The components are welded together: you can never query one without the others |
| Clustering columns | Free sorting, free range slices, contiguous sequential I/O, cheap `LIMIT` | Order is fixed at DDL time; a second sort order means a second table |
| Gapless prefix rule | Errors surface at development time, not as a 3 a.m. cluster-wide scan | Column *position* in the key is a hard API contract; reordering means a migration |
| Wide partitions | Related rows co-located → one seek answers a whole screen | Above ~100 MB: compaction rewrites, repair over-streams, heap pressure, timeouts |
| Immutable primary key | Placement is stable; no row ever moves, no rebalancing on update | Changing status/tenant/owner means delete-then-insert across partitions, plus tombstones |
| `token()` escape hatch | Enables parallel full scans for Spark, `dsbulk`, and backfills | Returns rows in token order, which is meaningless to application logic |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Writing `PRIMARY KEY (a, b)` when you meant `PRIMARY KEY ((a, b))`.** → ✅ The single-paren form makes `a` alone the partition key — one partition per `a`, growing forever. Read every `PRIMARY KEY` line out loud: "partition by X, sorted by Y". Add the sizing arithmetic to the table `comment`.
2. ⚠️ **Unbounded partitions** — `((channel_id), message_id)`, `((sensor_id), ts)`, `((user_id), event_time)`. → ✅ Always add a bucket sized from *peak* rate: `((channel_id, month), message_id)`. Keep partitions **< 100 MB and < 100,000 rows**; verify with `nodetool tablehistograms`, not by hope.
3. ⚠️ **Low-cardinality partition keys** — `((country))`, `((status))`, `((true/false))`. → ✅ With 200 distinct values you get 200 partitions on a 60-node cluster: most nodes idle, `US` on fire. Add a discriminator: `((country, day))` or `((status, day, shard))` with `shard = hash(id) % 16`.
4. ⚠️ **Expecting a composite partition key to work as two lookup dimensions.** → ✅ `((tenant_id, day))` cannot answer "all days for a tenant". The hash needs every component. If you need both access patterns, that is two tables — or make `day` a clustering column and bucket differently.
5. ⚠️ **Skipping a clustering column in `WHERE`.** → ✅ `AND c1=? AND c3=?` is illegal because the prefix has a gap. Either restrict `c2` too, reorder the clustering columns so the queried ones come first, or build a table whose clustering order matches this query.
6. ⚠️ **Putting a mutable attribute in the primary key.** → ✅ `((order_id), status)` means changing status is a delete plus an insert, leaving a tombstone in the old position and breaking read-your-write assumptions. Partition on immutable identity; model transitions as new rows with a TTL.
7. ⚠️ **`ALLOW FILTERING` as an error suppressor.** → ✅ Without a full partition key it scans every token range on every node and its latency tracks total data volume. Treat it as a compile error in application code; *with* a full partition key it is bounded and often acceptable — know which case you are in.
8. ⚠️ **A high-cardinality secondary index instead of a key change.** → ✅ Legacy `2i` is a local index per node, so a lookup scatters to all nodes and gathers. Build the query table. In 5.0, `StorageAttachedIndex` is far better but is still best used to narrow *within* an already-restricted partition set.
9. ⚠️ **Huge `IN` lists on the partition key.** → ✅ `IN` with 500 values is a 500-partition scatter-gather whose p99 is the max of 500 reads and which pins coordinator heap. Keep `IN` under ~10 values, or fire concurrent single-partition async queries and merge client-side.
10. ⚠️ **`ORDER BY` a column that is not a clustering column** (or a partial reverse of the declared order). → ✅ Only the declared order or its *exact* full reverse is legal: `CLUSTERING ORDER BY (a ASC, b DESC)` supports `ORDER BY (a ASC, b DESC)` and `ORDER BY (a DESC, b ASC)` — nothing else. And `ALTER TABLE` cannot fix it: primary-key columns cannot be added, removed, reordered, or retyped.
11. ⚠️ **Bucketing on a granularity chosen from the average day.** → ✅ Black Friday is 40× a Tuesday. Size buckets from peak QPS × bucket duration × row size, and prefer a finer bucket plus a scatter over a coarse bucket plus a 900 MB partition.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** `DESCRIBE TABLE ks.t` shows the live primary key and `CLUSTERING ORDER BY` — check it before trusting your migration files. `TRACING ON` in cqlsh prints partitions touched, replicas queried, SSTables read, and the crucial "Read N live rows and M tombstone cells" line; any application query touching more than one partition is a modelling bug. `nodetool tablehistograms ks t` gives the partition-size and cell-count distributions that prove or disprove your sizing arithmetic. `nodetool toppartitions ks t 10000` samples live traffic and names the hottest partition keys — the fastest way to identify a skewed key. `nodetool getendpoints ks t <key>` confirms which replicas own a specific partition (colon-separated components for composite keys), and `sstabledump` shows the actual clustering prefixes on disk when you need to prove sort order.

**Monitoring.** Per-table beans under `org.apache.cassandra.metrics:type=Table,keyspace=<ks>,scope=<tbl>`: `EstimatedPartitionSizeHistogram` (alert on max > 100 MB), `EstimatedPartitionCount`, `SSTablesPerReadHistogram` (p99 > 4 means compaction is behind or the model fans a logical row across too many writes), `TombstoneScannedHistogram` (p99 approaching `tombstone_warn_threshold` = 1000), `LiveScannedHistogram`, and `ReadLatency`/`WriteLatency`. Also watch `type=ClientRequest,scope=RangeSlice` — a rising rate there usually means someone shipped an `ALLOW FILTERING` query. In 4.0+ the same data is queryable over CQL: `SELECT * FROM system_views.max_partition_size;` and `system_views.tombstones_per_read`. Ship the log warnings for `Writing large partition` and `Scanned over N tombstones` to alerting — they are free early warnings that a key choice is failing.

**Security.** Because the partition key is the unit of authorization granularity that Cassandra *does not* have, tenant isolation must be enforced above the database: never let a client supply a raw partition key without validating tenancy, and prefer keys whose first component is the tenant so a leaked query cannot cross tenants by accident. Row-level security does not exist; per-table `GRANT SELECT ON iot.readings_by_sensor_day TO analyst` is the finest grain available, which is another argument for one table per access pattern. If partition keys are user-supplied strings, cap their length — a multi-megabyte partition key is accepted (limit 65535 bytes) and will wreck the index.

**Performance & scaling.** Throughput scales linearly with nodes only if token distribution *and* partition-key cardinality are both uniform. Check ownership with `nodetool status` (each node within a few percent of `100/N × RF`) and skew with `toppartitions`. `num_tokens: 16` with `allocate_tokens_for_local_replication_factor: 3` gives balanced ranges in 4.x. The scaling failure mode is never "too much data" — it is always "one partition too big" or "one partition too hot", and neither is fixable by adding nodes, because a partition cannot be split. When a single partition's write rate saturates a replica, widen the key with a shard component and read the shards concurrently; when a partition grows past budget, cut the bucket finer. Both are schema changes, so design the escape hatch (`shard int` defaulting to 0) into the key on day one if you expect skew.

---

## 9. Interview Questions

**Q: What is the difference between a partition key and a clustering column?**
A: The partition key is hashed by Murmur3 into a token that decides which nodes store the row; it must be supplied in full with `=` or `IN` on every efficient query and gives you nothing but placement. Clustering columns are not hashed — they define the sort order of rows within a partition on disk, giving free ordering, cheap range slices, and early-terminating `LIMIT`s.

**Q: What do the double parentheses in `PRIMARY KEY ((a, b), c)` mean?**
A: They group `a` and `b` into a composite partition key that is serialised and hashed as a single value, with `c` as the clustering column. Without them, `PRIMARY KEY (a, b, c)` makes `a` alone the partition key and both `b` and `c` clustering columns — a completely different physical layout with the same columns.

**Q: Can you query `((tenant_id, day))` by `tenant_id` alone?**
A: No. The token is computed from all partition-key components concatenated, so a missing component means the token cannot be computed and the coordinator would have to scan every partition. The query fails with `InvalidRequest`, and `ALLOW FILTERING` would turn it into a cluster-wide scan.

**Q: State the `WHERE` clause rules exactly.**
A: All partition-key columns restricted with `=` or `IN`; then clustering columns restricted left to right with no gaps, where every column but the last restricted one uses equality and the last may use a range operator or a multi-column tuple slice. Non-key columns require a secondary index or SAI, and `ORDER BY` may only use clustering columns in the declared order or its exact full reverse.

**Q: Why is a 2 GB partition a problem when the node has 2 TB of disk?**
A: Because the partition is the unit of compaction, repair streaming, and read indexing — compaction must rewrite the whole thing, repair streams it wholesale, and reads pull large row-index structures onto the heap. It also cannot be split across nodes, so one replica set carries all of its traffic forever, and no amount of adding nodes rebalances it.

**Q: What does `CLUSTERING ORDER BY (ts DESC)` actually change?**
A: It reverses the physical on-disk order so the newest rows are stored first in the partition. A `LIMIT 50` newest-first query then reads the first index block and stops, instead of seeking to the end of the partition and iterating backwards. It also flips which direction `ORDER BY` treats as the cheap default.

**Q: How do you paginate through a large partition?**
A: Use a keyset cursor on the clustering columns — `WHERE pk = ? AND (ts, seq) < (?, ?) LIMIT 500` — or hand the driver's opaque `paging_state` back on the next request. CQL has no `OFFSET`, and emulating it by fetching and discarding costs linearly more with each page.

**Q: What is `token()` for?**
A: It exposes the partitioner so you can see a row's token (`SELECT token(k) FROM t`) and, more usefully, scan the ring in parallel with `WHERE token(k) > ? AND token(k) <= ?`. That is exactly how Spark's Cassandra connector and `dsbulk` split a full-table read into one task per token range, each hitting a replica locally.

**Q: (Senior) Walk through what happens between binding parameters and the first byte read from disk.**
A: The driver serialises the partition-key components (length-prefixed and null-terminated for composites), hashes them with Murmur3 to a token, looks up the replica set in its local ring copy, and sends the request to a local-DC replica so the coordinator is itself a replica. The coordinator validates the restrictions against the key, issues a data read plus digest reads to satisfy `LOCAL_QUORUM`, and each replica consults every SSTable's bloom filter for the *partition*, uses `Summary.db` and `Index.db` to seek to it, then binary-searches the in-partition row index for the clustering prefix and reads a contiguous slice. Results are merged across SSTables and the memtable by cell timestamp before `LIMIT` is applied.

**Q: (Senior) When is `ALLOW FILTERING` acceptable?**
A: When the partition key is fully restricted, so the filtering happens inside one partition whose size you have bounded — the cost is then proportional to that partition, not to the cluster. It is also fine for one-off exploration in cqlsh and for analytics jobs that already scan by token range. It is never acceptable in an application query path without a full partition key, because latency becomes a function of total data volume and the read thread pool is shared with production traffic.

**Q: (Senior) Your `messages_by_channel` partition for the busiest channel is 1.2 GB and reads are timing out. What now, and what should you have done?**
A: Immediately: stop the bleeding by capping the query with `PER PARTITION LIMIT` and paging, raise no thresholds, and start a migration to a bucketed key — `((channel_id, month), message_id)` — with dual writes and a token-range backfill; you cannot split an existing partition in place. Structurally the mistake was choosing a key with no bound on rows per partition; the fix from day one is a bucket sized from peak message rate, plus an optional `shard` component so a single hot channel can be widened without another migration. Verify with `tablehistograms` after the cutover and drop the old table only once read traffic is zero.

**Q: (Senior) Why can't Cassandra support `ORDER BY` on an arbitrary column, and what changed in 5.0?**
A: Sorting requires either a pre-sorted layout or a full materialisation of the result set, and Cassandra only has the former — rows are physically ordered by clustering columns within a partition and by token across partitions, so any other order would need a cluster-wide sort in coordinator heap. Cassandra 5.0's Storage-Attached Indexes add one genuine exception: `ORDER BY <vector_col> ANN OF ?` for approximate nearest-neighbour search on vector columns, which is served by the index's own ordered structure rather than by clustering order. The general rule is unchanged: a new sort order means a new table.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** `PRIMARY KEY ((partition cols), clustering cols)`. The partition key is serialised and hashed by Murmur3 into a 64-bit token that selects replicas — it gives placement and nothing else, and every component must be supplied with `=`/`IN`. Clustering columns are not hashed; they sort rows on disk inside the partition, which is what makes range slices, `ORDER BY`, and early-terminating `LIMIT` cheap. Legal `WHERE`: full partition key, then a gapless left-to-right clustering prefix with equality, with a range or tuple slice allowed only on the last restricted column. `ORDER BY` accepts the declared clustering order or its exact reverse, nothing else. Non-key predicates need an index or `ALLOW FILTERING` — bounded and fine inside one partition, catastrophic without one. Keep partitions **< 100 MB and < 100k rows** by bucketing on time or `hash(id) % N`, sized from peak load. The primary key is immutable: changing it is new table + dual write + token-range backfill + read cutover.

| Item | Value / Command |
| --- | --- |
| Partition key only | `PRIMARY KEY (a)` or `PRIMARY KEY ((a))` |
| Partition + clustering | `PRIMARY KEY (a, b, c)` — `a` partitions, `b,c` cluster |
| Composite partition key | `PRIMARY KEY ((a, b), c)` — `(a,b)` hashed together |
| Sort order | `WITH CLUSTERING ORDER BY (ts DESC, seq ASC)` |
| Legal `WHERE` | full PK with `=`/`IN`, gapless clustering prefix, range on the last only; slice `(ts, seq) < (?, ?)`, cap `PER PARTITION LIMIT 10` |
| See the token · parallel scan | `SELECT token(a,b) FROM t;` · `WHERE token(a,b) > ? AND token(a,b) <= ?` |
| Who owns a partition | `nodetool getendpoints ks tbl "v1:v2"` |
| Partition sizes · hot keys | `nodetool tablehistograms ks tbl` · `nodetool toppartitions ks tbl 10000` |
| Token range · vnodes | `-2^63 .. 2^63-1` (Murmur3) · `num_tokens: 16` |
| Thresholds | `compaction_large_partition_warning_threshold: 100MiB` · `column_index_size: 64KiB` |
| Budget | `< 100 MB`, `< 100,000 rows` |

**Flash cards**

- **What does the partition key give you?** → Placement only: Murmur3 → token → replica set. No ordering, no range scans, no partial lookups.
- **What do the extra parentheses do?** → `((a, b))` hashes `a` and `b` together into one composite partition key; `(a, b)` makes `b` a clustering column.
- **The clustering prefix rule** → Restrict left to right with no gaps; equality on all but the last restricted column, range or tuple slice on that one.
- **Which `ORDER BY` clauses are legal?** → The declared clustering order, or its exact complete reverse. Nothing else (except 5.0 SAI `ANN OF` on vectors).
- **How do you fix an oversized partition?** → Bucket or shard the partition key, dual-write, backfill by token range, cut reads over. You cannot `ALTER` a primary key.

---

## 11. Hands-On Exercises & Mini Project

- [ ] On a local cluster (`ccm create demo -v 4.1.5 -n 3 -s`, or three `cassandra:5.0` containers), create `k2 (a,b,c, PRIMARY KEY (a, b))` and `k3 (a,b,c, PRIMARY KEY ((a, b)))`, insert the same 1,000 rows into both, then compare `SELECT token(a) FROM k2` with `SELECT token(a,b) FROM k3` and use `nodetool getendpoints` to show how differently the rows spread.
- [ ] Write out every illegal query from section 3 against a `PRIMARY KEY ((a,b), c, d, e)` table and record the exact `InvalidRequest` text for each — recognising these messages instantly is worth an interview question.
- [ ] Build the anti-pattern deliberately: `PRIMARY KEY ((sensor_id), ts)` with 3 sensors and 5 M readings. Record `Compacted partition maximum bytes`, then rebuild as `((sensor_id, day), ts)` and compare partition size, `SSTablesPerReadHistogram`, and read p99 side by side.
- [ ] Create the same table twice with `CLUSTERING ORDER BY (ts ASC)` and `(ts DESC)`, load a 40 MB partition into each, then run `SELECT ... LIMIT 50` newest-first against both under `TRACING ON` and compare latency and index-block counts.
- [ ] Write a Python script that splits the Murmur3 range into 32 contiguous token ranges and reads a whole table in parallel with `WHERE token(pk) > ? AND token(pk) <= ?`, verifying the row count matches a `dsbulk count`.

### Mini Project — "Key Surgery: migrating an unbounded partition"

**Goal.** Take a table with a fatally bad primary key to a healthy bucketed one, with zero downtime and provable correctness — the exact operation you will one day do at 2 a.m.

**Requirements.**
1. Create `chat.messages_bad (channel_id uuid, message_id timeuuid, author uuid, body text, PRIMARY KEY ((channel_id), message_id)) WITH CLUSTERING ORDER BY (message_id DESC)` on an RF=3 `NetworkTopologyStrategy` keyspace, and load 5 M messages across 20 channels with heavy skew (one channel holding 60% of traffic).
2. Measure the damage: `nodetool tablehistograms`, `toppartitions`, and the read p99 for "last 50 messages" on the hot channel versus a cold one. Record the "Writing large partition" warnings from `system.log`.
3. Design the replacement `messages_by_channel (channel_id, bucket, message_id, ...)` with `PRIMARY KEY ((channel_id, bucket), message_id)`, justifying the bucket granularity with arithmetic in the table `comment`, sized from the *peak* channel rate.
4. Implement dual writes from one `send_message()` function using prepared, token-aware, `LOCAL_QUORUM` statements, then backfill history with a token-range-parallel reader (32 workers) that derives `bucket` from `message_id`'s embedded timestamp.
5. Verify: counts per channel match, spot-check 100 random messages, and prove with `TRACING ON` that the new "last 50" query reads one partition and zero tombstones. Then cut reads over and re-measure p99.

**Extensions.** Add a `shard` component (`hash(message_id) % 4`) to the key and implement a 4-way concurrent read that merges client-side — measure whether the scatter costs less than the hot-partition it removes. Add a `STATIC` `channel_name` and show it costs one cell per partition, not per row. Finally, model "messages by author" as a second table and explain why a secondary index on `author` would have been the wrong answer.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Keyspaces, Tables & CQL Basics* (chapter 05) introduces the `CREATE TABLE` statement this chapter dissects and the replication settings the token feeds into. *Query-First Data Modeling* (chapter 07) turns these mechanics into a design methodology — one table per question, with the partition key taken straight from the query's equality filter. *Partitioners, Tokens & the Ring* covers Murmur3 and vnode allocation in depth. *Data Modeling Anti-Patterns* catalogues the key mistakes here as production failures. *Secondary Indexes, SAI & SASI* explains the only legitimate ways to query a non-key column.

- **The Cassandra Query Language — Data Definition** — Apache Software Foundation · *Beginner–Intermediate* · the normative reference for `PRIMARY KEY` syntax, `CLUSTERING ORDER BY`, and every table option, with the exact restriction grammar. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/ddl.html>
- **The Cassandra Query Language — Data Manipulation (SELECT)** — Apache Software Foundation · *Intermediate* · the definitive statement of the `WHERE` restriction rules, `PER PARTITION LIMIT`, tuple slices, `token()`, and `ALLOW FILTERING`. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/dml.html>
- **Apache Cassandra — Data Modeling** — Apache Software Foundation · *Intermediate* · official conceptual → logical → physical methodology including the partition-size sizing formulas used above. <https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/>
- **How Discord Stores Trillions of Messages** — Discord Engineering · *Intermediate* · the canonical real-world account of bucketed partition keys, hot partitions, and what a badly bounded partition costs at scale. <https://discord.com/blog/how-discord-stores-trillions-of-messages>
- **CASSANDRA-11206: Support large partitions on the 3.0 sstable format** — Apache JIRA · *Advanced* · why big partitions hurt, and the birch-tree row index that made them survivable — the best primary source on in-partition indexing. <https://issues.apache.org/jira/browse/CASSANDRA-11206>
- **CASSANDRA-8099: Refactor and modernize the storage engine** — Apache JIRA · *Advanced* · how CQL rows, clustering prefixes, and cells actually map onto SSTable bytes; the definitive answer to "what does my primary key become on disk?". <https://issues.apache.org/jira/browse/CASSANDRA-8099>
- **Wide Partitions in Apache Cassandra 3.11** — The Last Pickle · *Advanced* · measured behaviour of partitions from 100 MB to multiple GB, with heap, latency, and compaction numbers you can quote. <https://thelastpickle.com/blog/2019/01/11/wide-partitions-cassandra-3-11.html>
- **ScyllaDB University — Data Modeling: Partition & Clustering Keys** — ScyllaDB · *Beginner–Intermediate* · free lessons on the same CQL key model from a second implementation, useful for separating physics from Cassandra-specific choices. <https://university.scylladb.com/courses/data-modeling/>

---

*Apache Cassandra Handbook — chapter 06.*
