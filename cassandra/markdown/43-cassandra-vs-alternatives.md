# 43 · Cassandra vs ScyllaDB, DynamoDB & HBase

> **In one line:** Cassandra, ScyllaDB, DynamoDB and HBase all store enormous wide-column datasets, but they differ on who runs the cluster, how consistency is bought, and where your latency tail comes from — and that decides which one you should pick.

---

## 1. Overview

Every few years a team writes the sentence "we need something that scales past our Postgres primary" and then picks whichever distributed store their loudest engineer already knows. That is how you end up with HBase for a low-latency user-facing API, or DynamoDB for a 400 TB analytics archive. The wide-column / distributed-KV landscape looks homogeneous from the outside — all of them shard by a hash of a key, all of them replicate, all of them talk about "linear scalability" — but the engineering trade-offs are genuinely different and mostly *not* about raw throughput.

The problem this chapter solves is **selection under honest constraints**. The interesting axes are not "which is fastest on a synthetic YCSB run." They are: who is on call at 3 a.m.; whether your workload is point-lookup or range-scan; whether you need multi-region *active-active* writes; whether your cost curve is dominated by storage or by request volume; and whether a P99.9 of 300 ms is survivable. Cassandra wins some of those decisively and loses others decisively, and a senior engineer should be able to say which is which without flinching.

A one-line history explains most of the family resemblance. Google's **Bigtable** paper (2006) defined the wide-column model — sorted, sparse, multidimensional map — and **HBase** is its open-source clone on HDFS. Amazon's **Dynamo** paper (2007) defined the leaderless, hinted-handoff, eventually-consistent replication model. Facebook's **Cassandra** (2008, open-sourced to Apache in 2009) is famously the *mashup*: Bigtable's data model on Dynamo's replication. **DynamoDB** (2012) is Amazon's managed re-implementation of the Dynamo ideas with a much stricter API. **ScyllaDB** (2015) is a from-scratch C++ rewrite of Cassandra on the Seastar shard-per-core framework, wire-compatible with CQL.

**Concrete example.** Discord's message store is the canonical case study in this whole chapter. They started on MongoDB (2015), hit a wall at ~100 M messages, moved to Cassandra (2017) where they ran trillions of messages across a 177-node cluster, and then in 2022–23 moved the same data model to ScyllaDB — dropping to ~72 nodes with a far tighter latency tail. Nothing about their *data model* changed; the partition key stayed `(channel_id, bucket)`. What changed was the runtime underneath it: JVM garbage collection and a thread-pool architecture versus a shard-per-core C++ engine. That is the shape of most real "should we switch?" decisions — the model is portable, the operational envelope is not.

The durable mental model: **Cassandra and ScyllaDB are the same API with different engines. DynamoDB is the same architecture with the operations removed and the API narrowed. HBase is a different consistency model entirely (single-master-per-region, strongly consistent, range-scannable) that happens to look similar on a slide.**

## 2. Core Concepts

- **Wide-column store** — a table whose rows are keyed by a partition key and hold a sorted, sparse set of clustering rows/columns; not a relational table and not a document store.
- **Leaderless replication (Dynamo-style)** — every replica accepts writes; conflicts are resolved by last-write-wins timestamps. Cassandra, ScyllaDB and DynamoDB do this. HBase does not.
- **Region / tablet ownership (Bigtable-style)** — exactly one server owns a contiguous key range at a time, giving single-row linearizability but a failover gap. HBase regions and ScyllaDB tablets both use range ownership, for different reasons.
- **Shard-per-core (thread-per-core)** — ScyllaDB's Seastar model: one pinned OS thread and one memory arena per physical core, no shared locks, no JVM heap, its own I/O and CPU schedulers.
- **Tablets** — ScyllaDB 6.0+ dynamic range-based data distribution that replaces vnodes; tablets split, merge and migrate independently, so adding a node yields capacity in minutes rather than after a full streaming bootstrap.
- **RCU / WCU / RRU / WRU** — DynamoDB's capacity units. One WCU = one 1 KB write/second; one RCU = one 4 KB *eventually consistent* read/second (a strongly consistent read costs 2×). Your bill is literally your access pattern.
- **Adaptive capacity / partition throughput ceiling** — DynamoDB caps a single physical partition at ~3,000 RCU and ~1,000 WCU. A hot key throttles regardless of table-level capacity; Cassandra's equivalent failure is a hot partition saturating three replicas.
- **Alternator** — ScyllaDB's DynamoDB-API-compatible endpoint, letting DynamoDB SDK code run against self-hosted Scylla.
- **SAI (Storage-Attached Index)** — Cassandra 5.0's replacement for the old secondary index: one shared index structure per SSTable, much cheaper, supports numeric ranges and vector ANN search.
- **Item collection / partition size limit** — DynamoDB hard-limits an item to 400 KB and a partition-key collection to 10 GB when an LSI exists; Cassandra has *soft* guidance (< 100 MB, < 100k rows per partition) enforced only by your own pain.

## 3. Theory & Internals

All four systems are LSM-trees at heart. Writes land in a durable log plus an in-memory structure, are flushed to immutable sorted files, and are merged later. The differences that matter are **where the CPU goes**, **how ownership is decided**, and **what a read has to touch**.

**Cassandra's cost model.** A write is `commitlog append (sequential) + memtable insert`, then the coordinator waits for `CL` acknowledgements out of `RF` replicas. Consistency is the classic inequality:

```
QUORUM = floor(RF/2) + 1          # RF=3 → 2,  RF=5 → 3
strong (read-your-write) when  R + W > RF
LOCAL_QUORUM in each DC of a 2-DC RF=3/3 cluster:
  R=2, W=2, RF_local=3  →  2+2 > 3  ✓ strong within the DC
```

The JVM is the hidden term. Cassandra's memtables, the row cache and the object churn of the read path all live on a garbage-collected heap. With G1 at a 16–31 GB heap you buy a P99.9 pause measured in tens of milliseconds; ZGC (well supported on JDK 17 in 5.0) trades throughput for sub-millisecond pauses. Cassandra also uses a *staged event-driven* thread-pool architecture (SEDA heritage), so a request hops between thread pools and cores, paying cache-line and context-switch costs.

**ScyllaDB's cost model.** Same LSM, same CQL, same replication math — but each core owns a disjoint slice of the node's token range and its own memtables, cache and SSTable set. There are no cross-core locks and no shared heap, so throughput scales close to linearly with cores and the tail is bounded by the scheduler rather than by GC. Scylla replaces the OS page cache with a unified row-based cache it controls, which removes double-caching and lets it evict at row granularity. Scylla's internal schedulers actively *deprioritize* compaction and repair against user traffic — the single biggest practical difference from Cassandra, where a runaway compaction is a latency incident.

**DynamoDB's cost model.** You do not see nodes. You see partitions, and the pricing is the API. Two rules dominate design: (1) the ~3,000 RCU / 1,000 WCU per-physical-partition ceiling means key design is still your job even though sharding is not; (2) every access pattern must be expressible as `PK` or `PK + SK range`, or you pay for a GSI (a second full copy of the projected attributes, asynchronously maintained and therefore eventually consistent even for a strongly consistent base-table write).

**HBase's cost model.** Exactly one RegionServer serves a region, so reads and writes to a row are linearizable with no quorum at all. The price is availability: when a RegionServer dies, its regions are unavailable until the WAL is split and they are reassigned — historically seconds to minutes. HBase also inherits HDFS's NameNode and its own ZooKeeper dependency, so you are operating three distributed systems, not one.

```svg
<svg viewBox="0 0 760 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="330" fill="#ffffff"/>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Where the CPU goes: node-internal architecture</text>

  <rect x="20" y="45" width="220" height="255" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="130" y="68" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Cassandra (JVM)</text>
  <rect x="40" y="82" width="180" height="34" rx="6" fill="#ffffff" stroke="#4f46e5"/>
  <text x="130" y="103" text-anchor="middle" fill="#1e293b" font-size="11">shared heap + GC</text>
  <rect x="40" y="124" width="180" height="34" rx="6" fill="#ffffff" stroke="#4f46e5"/>
  <text x="130" y="145" text-anchor="middle" fill="#1e293b" font-size="11">thread pools (SEDA)</text>
  <rect x="40" y="166" width="84" height="60" rx="6" fill="#ffffff" stroke="#4f46e5"/>
  <text x="82" y="192" text-anchor="middle" fill="#1e293b" font-size="10">memtables</text>
  <text x="82" y="208" text-anchor="middle" fill="#1e293b" font-size="10">(shared)</text>
  <rect x="136" y="166" width="84" height="60" rx="6" fill="#ffffff" stroke="#4f46e5"/>
  <text x="178" y="192" text-anchor="middle" fill="#1e293b" font-size="10">OS page</text>
  <text x="178" y="208" text-anchor="middle" fill="#1e293b" font-size="10">cache</text>
  <text x="130" y="252" text-anchor="middle" fill="#1e293b" font-size="10">cores share state</text>
  <text x="130" y="270" text-anchor="middle" fill="#d97706" font-size="10" font-weight="700">tail risk: GC + compaction</text>
  <text x="130" y="288" text-anchor="middle" fill="#1e293b" font-size="10">tuning knobs: many</text>

  <rect x="260" y="45" width="220" height="255" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="370" y="68" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">ScyllaDB (C++ / Seastar)</text>
  <rect x="278" y="82" width="60" height="144" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="308" y="106" text-anchor="middle" fill="#1e293b" font-size="10">core 0</text>
  <text x="308" y="124" text-anchor="middle" fill="#1e293b" font-size="9">memtable</text>
  <text x="308" y="140" text-anchor="middle" fill="#1e293b" font-size="9">cache</text>
  <text x="308" y="156" text-anchor="middle" fill="#1e293b" font-size="9">sstables</text>
  <text x="308" y="180" text-anchor="middle" fill="#1e293b" font-size="9">sched</text>
  <rect x="344" y="82" width="60" height="144" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="374" y="106" text-anchor="middle" fill="#1e293b" font-size="10">core 1</text>
  <text x="374" y="124" text-anchor="middle" fill="#1e293b" font-size="9">memtable</text>
  <text x="374" y="140" text-anchor="middle" fill="#1e293b" font-size="9">cache</text>
  <text x="374" y="156" text-anchor="middle" fill="#1e293b" font-size="9">sstables</text>
  <text x="374" y="180" text-anchor="middle" fill="#1e293b" font-size="9">sched</text>
  <rect x="410" y="82" width="60" height="144" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="440" y="106" text-anchor="middle" fill="#1e293b" font-size="10">core N</text>
  <text x="440" y="124" text-anchor="middle" fill="#1e293b" font-size="9">memtable</text>
  <text x="440" y="140" text-anchor="middle" fill="#1e293b" font-size="9">cache</text>
  <text x="440" y="156" text-anchor="middle" fill="#1e293b" font-size="9">sstables</text>
  <text x="440" y="180" text-anchor="middle" fill="#1e293b" font-size="9">sched</text>
  <text x="370" y="252" text-anchor="middle" fill="#1e293b" font-size="10">shared nothing per core</text>
  <text x="370" y="270" text-anchor="middle" fill="#16a34a" font-size="10" font-weight="700">tail risk: low, scheduled</text>
  <text x="370" y="288" text-anchor="middle" fill="#1e293b" font-size="10">tuning knobs: few</text>

  <rect x="500" y="45" width="240" height="255" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="620" y="68" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">HBase (JVM on HDFS)</text>
  <rect x="518" y="82" width="204" height="34" rx="6" fill="#ffffff" stroke="#d97706"/>
  <text x="620" y="103" text-anchor="middle" fill="#1e293b" font-size="11">ZooKeeper + HMaster</text>
  <rect x="518" y="124" width="204" height="46" rx="6" fill="#ffffff" stroke="#d97706"/>
  <text x="620" y="143" text-anchor="middle" fill="#1e293b" font-size="11">RegionServer owns range</text>
  <text x="620" y="161" text-anchor="middle" fill="#1e293b" font-size="10">WAL + MemStore</text>
  <rect x="518" y="178" width="204" height="48" rx="6" fill="#ffffff" stroke="#d97706"/>
  <text x="620" y="198" text-anchor="middle" fill="#1e293b" font-size="11">HDFS (HFiles, 3x blocks)</text>
  <text x="620" y="216" text-anchor="middle" fill="#1e293b" font-size="10">replication lives here</text>
  <text x="620" y="252" text-anchor="middle" fill="#1e293b" font-size="10">single writer per region</text>
  <text x="620" y="270" text-anchor="middle" fill="#d97706" font-size="10" font-weight="700">tail risk: failover gap</text>
  <text x="620" y="288" text-anchor="middle" fill="#1e293b" font-size="10">strongly consistent rows</text>
</svg>
```

## 4. Architecture & Workflow

Trace the *same logical operation* — "write a message, then read the last 50 messages in a channel" — through each system.

1. **Cassandra.** The driver hashes `channel_id` with Murmur3, consults the token map it learned from `system.peers`, and sends the write directly to a replica (token-aware routing, zero extra hops). That coordinator forwards to `RF` replicas in the local DC, waits for `LOCAL_QUORUM` = 2 acks, returns. The read fans out to 2 replicas, merges memtable + SSTable fragments by timestamp, and — because the clustering key is `message_id DESC` — the 50 rows are already contiguous and sorted on disk.
2. **ScyllaDB.** Identical CQL, identical replication math, but the driver is *shard-aware*: it computes not only which node but which **core** owns the key, and opens a connection per shard so the request lands on the right core with no intra-node hop. Compaction and repair run under a scheduler that yields to user traffic.
3. **DynamoDB.** The SDK signs an HTTPS `PutItem`; the request router hashes the partition key, writes to the leader of that partition's replication group across three AZs, and acks. The read is a `Query` with `ScanIndexForward=false, Limit=50`. There is no cluster to see, no repair to run, and no compaction to tune — and no way to express a query you did not plan a key or index for.
4. **HBase.** The client asks ZooKeeper for `hbase:meta`, finds the RegionServer that owns the row-key range, and writes to that single server (WAL then MemStore). There is no quorum because there is no second writer. Reads scan the MemStore plus HFiles, and because row keys are *globally lexicographically ordered*, a scan across many `channel_id`s is natural — the thing Cassandra is worst at.

The topology difference is what shows up in an outage:

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="340" fill="#ffffff"/>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Write path and failure behaviour</text>

  <rect x="16" y="40" width="360" height="140" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="196" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Leaderless quorum (Cassandra / ScyllaDB / DynamoDB)</text>
  <circle cx="70" cy="115" r="24" fill="#ffffff" stroke="#4f46e5"/>
  <text x="70" y="119" text-anchor="middle" fill="#1e293b" font-size="10">client</text>
  <circle cx="180" cy="90" r="22" fill="#ffffff" stroke="#16a34a"/>
  <text x="180" y="94" text-anchor="middle" fill="#1e293b" font-size="10">R1 ok</text>
  <circle cx="180" cy="145" r="22" fill="#ffffff" stroke="#16a34a"/>
  <text x="180" y="149" text-anchor="middle" fill="#1e293b" font-size="10">R2 ok</text>
  <circle cx="270" cy="118" r="22" fill="#ffffff" stroke="#d97706" stroke-dasharray="4 3"/>
  <text x="270" y="115" text-anchor="middle" fill="#1e293b" font-size="10">R3</text>
  <text x="270" y="129" text-anchor="middle" fill="#d97706" font-size="9">down</text>
  <line x1="94" y1="108" x2="158" y2="93" stroke="#4f46e5"/>
  <line x1="94" y1="122" x2="158" y2="142" stroke="#4f46e5"/>
  <line x1="200" y1="105" x2="250" y2="114" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="320" y="105" fill="#16a34a" font-size="11" font-weight="700">ack at</text>
  <text x="320" y="120" fill="#16a34a" font-size="11" font-weight="700">QUORUM</text>
  <text x="320" y="136" fill="#1e293b" font-size="9">hint stored</text>
  <text x="196" y="172" text-anchor="middle" fill="#1e293b" font-size="10">availability preserved; R3 catches up via hints and repair</text>

  <rect x="392" y="40" width="352" height="140" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="568" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Single owner per range (HBase)</text>
  <circle cx="440" cy="115" r="24" fill="#ffffff" stroke="#d97706"/>
  <text x="440" y="119" text-anchor="middle" fill="#1e293b" font-size="10">client</text>
  <rect x="500" y="92" width="110" height="46" rx="8" fill="#ffffff" stroke="#d97706" stroke-dasharray="4 3"/>
  <text x="555" y="112" text-anchor="middle" fill="#1e293b" font-size="10">RegionServer</text>
  <text x="555" y="128" text-anchor="middle" fill="#d97706" font-size="10" font-weight="700">crashed</text>
  <line x1="464" y1="115" x2="498" y2="115" stroke="#d97706"/>
  <rect x="632" y="92" width="98" height="46" rx="8" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="681" y="112" text-anchor="middle" fill="#1e293b" font-size="10">WAL split +</text>
  <text x="681" y="128" text-anchor="middle" fill="#1e293b" font-size="10">reassign</text>
  <line x1="612" y1="115" x2="630" y2="115" stroke="#0ea5e9"/>
  <text x="568" y="172" text-anchor="middle" fill="#1e293b" font-size="10">range unavailable until recovery; rows stay linearizable</text>

  <rect x="16" y="196" width="728" height="128" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="380" y="218" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Multi-region writes</text>
  <rect x="46" y="234" width="150" height="66" rx="8" fill="#ffffff" stroke="#4f46e5"/>
  <text x="121" y="256" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Cassandra</text>
  <text x="121" y="273" text-anchor="middle" fill="#1e293b" font-size="9">NetworkTopologyStrategy</text>
  <text x="121" y="288" text-anchor="middle" fill="#1e293b" font-size="9">LOCAL_QUORUM per DC</text>
  <rect x="212" y="234" width="150" height="66" rx="8" fill="#ffffff" stroke="#16a34a"/>
  <text x="287" y="256" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">ScyllaDB</text>
  <text x="287" y="273" text-anchor="middle" fill="#1e293b" font-size="9">same model</text>
  <text x="287" y="288" text-anchor="middle" fill="#1e293b" font-size="9">tablets rebalance faster</text>
  <rect x="378" y="234" width="160" height="66" rx="8" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="458" y="256" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">DynamoDB</text>
  <text x="458" y="273" text-anchor="middle" fill="#1e293b" font-size="9">Global Tables, LWW</text>
  <text x="458" y="288" text-anchor="middle" fill="#1e293b" font-size="9">no cross-region strong read</text>
  <rect x="554" y="234" width="160" height="66" rx="8" fill="#ffffff" stroke="#d97706"/>
  <text x="634" y="256" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">HBase</text>
  <text x="634" y="273" text-anchor="middle" fill="#1e293b" font-size="9">async cluster replication</text>
  <text x="634" y="288" text-anchor="middle" fill="#1e293b" font-size="9">effectively one writer DC</text>
</svg>
```

## 5. Implementation

The same logical table, expressed four ways. Start with Cassandra 5.0.

```cql
-- Cassandra / ScyllaDB: identical CQL. Production keyspace, never SimpleStrategy.
CREATE KEYSPACE chat WITH replication = {
  'class': 'NetworkTopologyStrategy', 'us_east': 3, 'eu_west': 3
} AND durable_writes = true;

CREATE TABLE chat.messages (
  channel_id   bigint,
  bucket       int,            -- 10-day time bucket keeps partitions bounded
  message_id   bigint,         -- Snowflake id: time-ordered
  author_id    bigint,
  body         text,
  PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'DAYS',
                    'compaction_window_size': 10}
  AND gc_grace_seconds = 864000;   -- 10 days, the default; must exceed repair cadence

SELECT message_id, author_id, body
FROM chat.messages
WHERE channel_id = 42 AND bucket = 1996 LIMIT 50;
```

The DynamoDB equivalent forces the bucket into a composite string key, because there is no notion of a compound partition key:

```python
# DynamoDB: boto3. Note the composite PK string and the explicit capacity accounting.
import boto3
ddb = boto3.resource("dynamodb", region_name="us-east-1")
t = ddb.Table("messages")

t.put_item(Item={
    "pk": "chan#42#b#1996",     # partition key: channel + bucket
    "sk": 987654321012345678,   # sort key: snowflake id
    "author_id": 7, "body": "ship it",
})

resp = t.query(
    KeyConditionExpression=boto3.dynamodb.conditions.Key("pk").eq("chan#42#b#1996"),
    ScanIndexForward=False, Limit=50,
    ConsistentRead=False,       # eventually consistent read = half the RCU cost
)
# resp["ConsumedCapacity"] is the number you actually design against.
```

HBase makes the ordering explicit in the row key, and that ordering is *global*, which is both its superpower and its hotspot generator:

```java
// HBase: row key is a byte array; sort order is lexicographic across the whole table.
// Reverse the timestamp so newest sorts first, and salt the prefix to avoid a hot region.
byte[] rowKey = Bytes.add(
    Bytes.toBytes((byte)(channelId % 16)),          // salt: spread across regions
    Bytes.toBytes(channelId),
    Bytes.toBytes(Long.MAX_VALUE - messageId));     // descending time

Put put = new Put(rowKey);
put.addColumn(Bytes.toBytes("d"), Bytes.toBytes("body"), Bytes.toBytes(body));
table.put(put);

Scan scan = new Scan()
    .withStartRow(prefix).setLimit(50).setCaching(50);
// Salting means you now issue 16 scans and merge - the cost of avoiding hotspots.
```

Verify what you are actually paying for. On Cassandra, always trace before you tune:

```bash
# Is the read hitting one partition or fanning out?
cqlsh> TRACING ON;
cqlsh> SELECT * FROM chat.messages WHERE channel_id=42 AND bucket=1996 LIMIT 50;
#  Read 50 live rows and 0 tombstone cells   [ReadStage-2] | 3 ms

# Per-table latency and SSTables touched per read - the number that predicts your P99.
nodetool tablehistograms chat messages
# Percentile  SSTables   Write Latency   Read Latency   Partition Size   Cell Count
# 50%             1.00        14.24 us       62.10 us            17084          124
# 99%             2.00        61.21 us       943.13 us          454826         2299
# Max             3.00       126.93 us      4055.27 us         3379391        17084

nodetool tpstats | head -12     # look for pending ReadStage / MutationStage and blocked NTR
```

**Optimization note.** The single most valuable comparison metric is *SSTables touched per read* (99th percentile from `tablehistograms`). If it is >4 you have a compaction problem, not an engine problem — and migrating to ScyllaDB will not fix a bad compaction strategy, it will only make the same bad reads faster. Fix the data model first, then evaluate the engine. Conversely, if SSTables/read is 1–2, your latency tail is dominated by GC and thread-pool queueing, and *that* is the case where a shard-per-core engine genuinely buys you 3–5× on P99.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| **Cassandra** | Apache-licensed, no vendor, huge operator community; true multi-DC active-active; runs anywhere; 5.0 adds SAI + vector search | You operate it: repair, compaction, GC tuning, upgrades; JVM tail latency; no joins/aggregates at scale |
| **ScyllaDB** | Same CQL and data model; 2–5× throughput per node, far tighter P99; tablets make scaling elastic; self-tuning schedulers | Source-available licensing (not Apache 2.0) with a smaller free tier; smaller community; feature lag on newest CQL surface; still self-operated unless you buy Cloud |
| **DynamoDB** | Zero operations, real single-digit-ms P99, IAM-native security, Streams + Global Tables + PITR out of the box | AWS lock-in; cost scales with *requests*, brutal for write-heavy or scan-heavy work; 400 KB item cap; rigid query surface; no cross-region strong reads |
| **HBase** | Strong single-row consistency, cheap global range scans, first-class Spark/MapReduce integration, coprocessors | Operates HDFS + ZooKeeper + HBase; region failover means seconds of unavailability; not a good fit for low-latency user-facing APIs; hotspot-prone key design |
| **MongoDB** | Rich secondary indexes, aggregation pipeline, multi-document ACID transactions, flexible schema | Single primary per shard limits write scale-out per key range; multi-region active-active is not the native model; large working sets punish it |
| **Consistency** | Cassandra/Scylla let you *choose* per query (ONE → LOCAL_QUORUM → ALL) plus LWT for compare-and-set | Tunability is a footgun; LWT (Paxos) is ~4× round trips and does not compose across partitions |
| **Cost shape** | Self-hosted C*/Scylla cost is roughly linear in *storage and cores*, so heavy writes are nearly free | DynamoDB cost is linear in *requests*; a 500k writes/sec firehose is orders of magnitude cheaper on Cassandra hardware |
| **Time to first query** | DynamoDB: minutes. Astra DB / Scylla Cloud: minutes | Self-hosted Cassandra: weeks to a production-grade cluster with repair, backup, monitoring and runbooks |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Benchmarking with YCSB uniform-random keys and declaring a winner.** → ✅ Replay *your* key distribution. Real workloads are Zipfian; hot-partition behaviour, not average throughput, is what differentiates these systems.
2. ⚠️ **Choosing DynamoDB for a write-heavy firehose because "it's serverless."** → ✅ Do the WCU arithmetic first. 200k writes/sec of 1 KB items is 200k WCU sustained; price that against ~20 i4i instances running Cassandra before committing.
3. ⚠️ **Choosing Cassandra for range scans across keys** ("give me all orders between two dates, any customer"). → ✅ That is an HBase/Bigtable or an analytics-warehouse query. In Cassandra it becomes `ALLOW FILTERING` and a full-cluster scan.
4. ⚠️ **Assuming a migration to ScyllaDB fixes a bad data model.** → ✅ Unbounded partitions, tombstone storms and `ALLOW FILTERING` hurt identically on both. Scylla fixes *engine* problems (GC, compaction interference, per-node throughput), not *modelling* problems.
5. ⚠️ **Treating DynamoDB GSIs as free indexes.** → ✅ Each GSI is a full asynchronous copy with its own capacity; a throttled GSI back-pressures the base table's writes. Budget them like extra tables, because they are.
6. ⚠️ **Running HBase for a user-facing p99 SLA.** → ✅ Accept that RegionServer failover makes a key range unavailable. If you need availability over consistency, that is literally the Dynamo lineage's job.
7. ⚠️ **Ignoring licensing until procurement.** → ✅ Confirm current terms directly with the vendor before you standardise. Apache Cassandra is Apache 2.0; ScyllaDB's open-source and enterprise editions have been restructured toward source-available terms, and that surprises legal teams late.
8. ⚠️ **Comparing "managed Cassandra" to self-hosted as if the operations vanish.** → ✅ Astra DB and Amazon Keyspaces remove node ops but retain data-model responsibility, and Keyspaces in particular has real behavioural differences (no `ALLOW FILTERING` on some paths, its own capacity model, partial CQL surface).
9. ⚠️ **Picking on peak throughput when your real constraint is team size.** → ✅ A three-person team should almost always take the managed option; a fifty-person platform org can extract far more value per dollar from self-hosted Cassandra or Scylla.
10. ⚠️ **Forgetting that only Cassandra/Scylla give symmetric multi-region writes.** → ✅ DynamoDB Global Tables are last-write-wins with no cross-region strong read; HBase replication is effectively one-writer. If you need EU and US writing the same row, the leaderless family is the answer.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When comparing candidates, instrument identically. On Cassandra, `nodetool tablehistograms` (SSTables/read, partition size), `nodetool tpstats` (dropped mutations, blocked native transport requests), `nodetool proxyhistograms` (coordinator-level latency), and `nodetool compactionstats` (pending tasks — a persistent backlog >20 is your latency). On ScyllaDB the same data is in `nodetool` plus the Grafana stack that ships with Scylla Monitoring. On DynamoDB you get CloudWatch `ThrottledRequests`, `ConsumedReadCapacityUnits` and `SuccessfulRequestLatency`, plus Contributor Insights to find the hot key. On HBase, watch `RegionServer.Server.slowAppendCount`, region count per server, and compaction queue length.

**Monitoring.** For Cassandra, the JMX beans that matter: `org.apache.cassandra.metrics:type=ClientRequest,scope=Read,name=Latency` (and `Write`), `type=Table,name=TombstoneScannedHistogram`, `type=Table,name=SSTablesPerReadHistogram`, `type=Compaction,name=PendingTasks`, `type=DroppedMessage,scope=MUTATION`, and the JVM `GarbageCollector` beans. If you are evaluating a migration, capture 30 days of these *before* the bake-off so you can compare apples to apples.

**Security.** Cassandra 4.0+ gives you internal auth with roles, client and internode TLS, and audit logging (`audit_logging_options` in `cassandra.yaml`); 5.0 adds dynamic data masking. Encryption at rest is an enterprise/DSE or disk-level concern in open-source Cassandra — plan LUKS or cloud disk encryption. DynamoDB is the clear winner here: IAM policies down to item level via condition keys, KMS encryption at rest by default, VPC endpoints, no ports to firewall. That security-posture delta is a legitimate selection criterion in regulated environments and is routinely undervalued.

**Performance & Scaling.** Cassandra scales by adding nodes and streaming vnode ranges — hours for a large node, with real bandwidth cost. ScyllaDB tablets change that materially: capacity becomes usable while migration proceeds. DynamoDB scales instantly for reads but has a documented ramp for sustained provisioned-capacity increases and still throttles on a single hot key. HBase scales by splitting regions, which is fast, but rebalancing across RegionServers is a background process you must watch. The rule of thumb that survives all four: **the ceiling is your key design, not the engine.** A single logical key that receives 50k writes/sec will hurt on every system in this chapter.

## 9. Interview Questions

**Q: Cassandra and ScyllaDB speak the same CQL — so what actually differs?**
A: The storage engine and the process architecture. ScyllaDB is C++ on the Seastar framework with one shard per physical core, each owning its own memtables, cache and SSTables, so there is no shared heap and no garbage collector. It also runs internal schedulers that prioritise user traffic over compaction and repair. The data model, replication and consistency levels are the same; the throughput per node and the P99 tail are not.

**Q: When is DynamoDB the right choice over self-hosted Cassandra?**
A: When your team is small, you are already all-in on AWS, your access patterns are stable and expressible as key or key-range lookups, and your request volume is moderate relative to your storage. You trade query flexibility and cost-at-scale for zero operations, IAM-native security and genuinely good single-digit-millisecond latency.

**Q: Why would you choose HBase in 2026?**
A: When you need strongly consistent single-row reads *and* efficient ordered range scans across the whole key space, and you are already running a Hadoop/Spark platform. HBase's global lexicographic row ordering makes "scan everything between these two keys" natural, which is precisely the query Cassandra cannot serve efficiently.

**Q: Where does Cassandra sit in CAP, and where does HBase?**
A: Cassandra is AP with tunable consistency — during a partition it keeps accepting reads and writes at low consistency levels, and you buy consistency back with `R + W > RF`. HBase is CP: exactly one RegionServer owns a region, so a row is linearizable, but if that server is lost the range is unavailable until reassignment. Both statements are about the *default* behaviour; CAP is a spectrum you configure, not a badge.

**Q: What is the DynamoDB per-partition throughput limit and why does it matter?**
A: Roughly 3,000 RCU and 1,000 WCU per physical partition. It matters because it means key design is still your responsibility even in a "serverless" store — a celebrity partition key will throttle no matter how much table-level capacity you provision, exactly like a hot partition saturating three Cassandra replicas.

**Q: Can you move data between Cassandra and ScyllaDB, and how hard is it?**
A: It is one of the easier migrations in this space because the CQL surface, drivers and SSTable formats overlap. Options include ScyllaDB's migrator (Spark-based), `sstableloader`, or a dual-write plus backfill. The real work is validating behavioural differences in compaction strategies, driver shard-awareness and any Cassandra-5.0-only features such as SAI or vector search.

**Q: What does MongoDB do better than Cassandra, honestly?**
A: Rich secondary indexing and ad-hoc query flexibility, the aggregation pipeline, and multi-document ACID transactions. If your access patterns are still moving or you genuinely need query-time flexibility, Mongo is a much friendlier place to be. Cassandra's bet is the opposite: fix the queries up front, and get write throughput and multi-region availability in return.

**Q: (Senior) A team says "our Cassandra P99 is 300 ms, let's migrate to ScyllaDB." How do you evaluate that?**
A: First determine whether the tail is engine-caused or model-caused. Pull `SSTablesPerReadHistogram`, `TombstoneScannedHistogram`, partition-size histograms and GC pause distributions. If reads touch 6+ SSTables or scan thousands of tombstones, the model or compaction strategy is at fault and Scylla will inherit the problem. If reads touch 1–2 SSTables and the tail correlates with GC pauses and compaction windows, a shard-per-core engine is a legitimate 3–5× improvement on P99 — and that is when Discord's result generalises.

**Q: (Senior) Design a decision procedure a platform team can apply in an hour.**
A: Four gates in order. (1) *Access patterns*: any global range scan or ad-hoc query → not Cassandra. (2) *Write:read shape and volume*: sustained high-write firehose → self-hosted C*/Scylla on cost grounds; moderate and bursty → DynamoDB. (3) *Geography*: symmetric multi-region writes → Cassandra/Scylla; single-region or read-replica geography → DynamoDB fine. (4) *Team*: fewer than roughly five engineers who can own a stateful system → managed, always. Only after those four does per-node benchmarking earn any time.

**Q: (Senior) How do you compare total cost of ownership across these fairly?**
A: Model three components separately: infrastructure (instances, EBS/NVMe, cross-AZ and cross-region network — cross-AZ replication traffic is a real and commonly forgotten DynamoDB-vs-self-hosted differentiator), request/capacity charges (only DynamoDB and managed offerings), and human cost (on-call rotation, upgrades, repair tooling, backup verification). Then run sensitivity analysis on 3× growth in requests versus 3× growth in storage — those two curves diverge sharply between DynamoDB and self-hosted Cassandra and usually decide the answer.

**Q: (Senior) What does ScyllaDB's tablets architecture change operationally?**
A: Vnodes bind data placement to a static token assignment, so bootstrapping a node means streaming whole ranges before it serves traffic, and the cluster is imbalanced during that window. Tablets are small, independently migratable range units placed by a Raft-backed control plane, so data moves incrementally, new nodes begin absorbing load almost immediately, and shrinking a cluster is symmetric. It turns capacity changes from a scheduled operation into a routine one.

**Q: Is Amazon Keyspaces just managed Cassandra?**
A: No. It is a CQL-compatible service built on Amazon's own storage, so it accepts much of the CQL surface and the DataStax drivers, but the internals, capacity model and consistency guarantees are AWS's, not Cassandra's. Treat it as a distinct product with its own limits — feature gaps, per-request pricing and different behaviour around lightweight transactions and multi-partition operations — and validate your workload against it rather than assuming parity.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** All four are LSM-based and hash-shard by key. **Cassandra** and **ScyllaDB** share CQL, leaderless replication and tunable consistency (`QUORUM = floor(RF/2)+1`, strong when `R + W > RF`); Scylla swaps the JVM for a C++ shard-per-core engine, so it wins on P99 and per-node throughput but is source-available with a smaller community. **DynamoDB** is the same architectural lineage with the operations deleted and the API narrowed: brilliant for stable key-based access at moderate request volume, expensive for write firehoses, rigid for new queries, AWS-only. **HBase** is Bigtable's model — one RegionServer owns a range, so rows are strongly consistent and global range scans are cheap, at the cost of failover unavailability and a three-system operational footprint. Choose on access patterns, geography, cost shape and team size — in that order — and remember that hot keys hurt everywhere.

| Question | Cassandra | ScyllaDB | DynamoDB | HBase |
|---|---|---|---|---|
| License / model | Apache 2.0, self-hosted | Source-available, self-hosted or Cloud | AWS managed only | Apache 2.0, self-hosted |
| Consistency default | tunable, AP | tunable, AP | eventual (strong read opt-in) | strong per row, CP |
| Multi-region writes | active-active | active-active | Global Tables (LWW) | async, one writer |
| Range scan across keys | poor | poor | poor | excellent |
| P99 tail driver | GC + compaction | scheduler | throttling | failover + GC |
| Cost scales with | cores + storage | cores + storage | requests | cores + HDFS |
| Ops burden | high | medium | near zero | highest |
| Sweet spot | multi-DC, write-heavy, OSS | same, latency-critical | AWS, stable patterns | scans + Hadoop |

**Flash cards**
- **Cassandra vs ScyllaDB in one sentence** → same CQL and replication, different engine: JVM thread pools versus C++ shard-per-core.
- **DynamoDB's real constraint** → ~3,000 RCU / 1,000 WCU per physical partition, plus a bill that tracks requests, not bytes.
- **HBase's superpower** → globally ordered row keys, so cross-key range scans are cheap; its cost is region-failover unavailability.
- **The migration reality check** → SSTables-per-read >4 means fix the model, not the engine.
- **Selection order** → access patterns → volume/cost shape → geography → team size. Benchmarks come last.

## 11. Hands-On Exercises & Mini Project

- [ ] Run single-node Cassandra 5.0 and ScyllaDB in Docker, create the identical `chat.messages` schema on both, load 5 M rows with `cassandra-stress`, and compare P99 from `nodetool proxyhistograms`.
- [ ] Deliberately build an unbounded partition (drop the `bucket` column) on both engines, load 2 M rows into one `channel_id`, and record where each one degrades — proving that modelling errors do not migrate away.
- [ ] Model the same table in DynamoDB Local, issue 10k writes, and reconcile `ConsumedCapacity` against the WCU formula by hand.
- [ ] Take a real query from your system that needs a range scan across keys, write it for Cassandra, and document exactly why it requires `ALLOW FILTERING` — then sketch the HBase row key that would serve it natively.
- [ ] Kill one node during a `LOCAL_QUORUM` write loop on Cassandra and record client-visible errors; repeat against a single-node HBase and compare the failure signature.

**Mini Project — A Defensible Datastore Bake-Off**
*Goal:* produce a decision memo your CTO could sign, not a benchmark chart.
*Requirements:* (1) capture your real key distribution and read/write ratio from production logs and build a replay harness; (2) run it against Cassandra 5.0, ScyllaDB and DynamoDB Local (or a small provisioned table) with identical schemas; (3) record P50/P99/P99.9, cost per million operations, and time-to-recover from a single-node failure; (4) model 12-month TCO at 1×, 3× and 10× growth for both storage-led and request-led growth; (5) write a one-page recommendation with the conditions that would reverse it.
*Extensions:* add a hot-key scenario where 1% of keys take 50% of traffic and report which system degrades most gracefully; add ScyllaDB's Alternator endpoint and run the DynamoDB SDK path against it unchanged; measure the operational cost of a rolling version upgrade on each.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Data Modelling & Query-First Design* (why the model matters more than the engine), *Consistency Levels & Tunable Consistency* (the `R + W > RF` machinery), *Compaction Strategies* (STCS/LCS/TWCS/UCS and the SSTables-per-read metric), *Production Case Studies & Architectures* (Discord's Cassandra→ScyllaDB move in detail), *Cassandra System Design (Interview)*, and *Migration & Real-World Challenges*.

**Free Learning Resources**
- **Apache Cassandra Documentation (5.0)** — Apache Software Foundation · *All levels* · authoritative reference for architecture, CQL, SAI and operations; the baseline every comparison should be measured against. <https://cassandra.apache.org/doc/latest/>
- **Cassandra: A Decentralized Structured Storage System** — Lakshman & Malik (Facebook) · *Advanced* · the original paper that explains the Bigtable-model-on-Dynamo-replication design decision. <https://www.cs.cornell.edu/projects/ladis2009/papers/lakshman-ladis2009.pdf>
- **Dynamo: Amazon's Highly Available Key-value Store** — DeCandia et al. (Amazon) · *Advanced* · quorums, hinted handoff, vector clocks and the availability philosophy DynamoDB and Cassandra both inherit. <https://www.allthingsdistributed.com/files/amazon-dynamo-sosp2007.pdf>
- **Bigtable: A Distributed Storage System for Structured Data** — Chang et al. (Google) · *Advanced* · the wide-column data model and the tablet/range-ownership design HBase copies. <https://research.google/pubs/pub27898/>
- **How Discord Stores Trillions of Messages** — Discord Engineering · *Intermediate* · the honest Cassandra-to-ScyllaDB write-up, including node counts, latency numbers and the Rust coalescing layer. <https://discord.com/blog/how-discord-stores-trillions-of-messages>
- **Amazon DynamoDB Developer Guide — Best Practices for Design** — AWS · *Intermediate* · partition-key design, GSI cost, adaptive capacity and the single-table pattern, straight from the source. <https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html>
- **Apache HBase Reference Guide** — Apache Software Foundation · *Intermediate–Advanced* · row-key design, region splitting and the operational realities of running on HDFS. <https://hbase.apache.org/book.html>
- **ScyllaDB University** — ScyllaDB · *Beginner–Advanced* · free courses on shard-per-core architecture, tablets and migrating from Cassandra; useful even if you never adopt Scylla. <https://university.scylladb.com/>

---

*Apache Cassandra Handbook — chapter 43.*
