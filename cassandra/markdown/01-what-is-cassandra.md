# 01 · What Is Apache Cassandra?

> **In one line:** Apache Cassandra is a distributed, masterless, wide-column NoSQL database that trades joins and strong-by-default consistency for linear horizontal scale, multi-datacenter replication, and no single point of failure.

---

## 1. Overview

Apache Cassandra is an open-source, distributed **wide-column store**. Every node in a Cassandra cluster is identical — there is no primary, no secondary, no config server, no shard router. Any node can accept any read or any write, and the cluster coordinates internally to place and retrieve the data. That single architectural decision — **masterlessness** — is what makes Cassandra behave the way it does: writes never block on a leader election, a node dying does not stop traffic, and adding hardware adds throughput almost linearly.

The problem Cassandra exists to solve is *availability and write throughput at a scale where a single machine, or a single leader, is no longer a sane assumption*. A traditional RDBMS scales up: bigger box, faster disk, then read replicas, then manual sharding — and every step adds operational fragility. When your write volume is a million operations per second, your data is petabytes, and your users span three continents who all expect sub-10 ms latency and 99.99% uptime, the leader-based model becomes the bottleneck and the outage. Cassandra flips the model: partition the data across a hash ring, replicate each partition to N nodes (possibly in different datacenters), and let the client choose per-query how many replicas must acknowledge.

Historically, Cassandra was built at **Facebook in 2007** by Avinash Lakshman (a co-author of Amazon's Dynamo paper) and Prashant Malik, to power Inbox Search. It was open-sourced in 2008 and became a top-level Apache project in 2010. Its design is explicitly a **hybrid**: Amazon Dynamo's replication and membership model (consistent hashing, gossip, hinted handoff, tunable quorums) bolted onto Google BigTable's on-disk storage model (log-structured merge trees, SSTables, column families). Chapter 02 unpacks that lineage in detail.

The canonical real-world example is **Discord**. Discord stored trillions of chat messages in Cassandra (and later migrated to ScyllaDB, a C++ reimplementation of the same architecture) because the workload is a near-perfect fit: writes are append-heavy, reads are almost always "give me the last N messages in channel X", and the data partitions naturally by channel. A message table keyed by `(channel_id, bucket)` with `message_id` as a clustering column gives you an ordered, bounded partition that a single node can serve from one disk seek. **Netflix** runs thousands of Cassandra nodes across AWS regions for viewing history and playback state; **Apple** runs one of the largest deployments on record — over 100,000 nodes and multiple petabytes. **Uber**, **Instagram**, and **Spotify** all run Cassandra for time-series and per-user activity data.

The trade Cassandra asks you to accept is real and non-negotiable: **you model your tables around your queries, not around your entities.** There are no joins, no efficient ad-hoc filtering, no foreign keys, and no cross-partition transactions (until Accord/ACID transactions land fully). If you can express your access patterns up front, Cassandra will serve them at any scale. If you cannot, you will fight it every day.

## 2. Core Concepts

- **Node** — a single Cassandra process (usually one per machine/VM) owning a slice of the token ring and storing replicas of data.
- **Cluster (ring)** — the full set of nodes sharing a `cluster_name` and a token space. The token range is `-2^63 … 2^63-1` under the default Murmur3Partitioner.
- **Datacenter / Rack** — logical grouping used by replication and snitches. A "datacenter" may be an AWS region; a "rack" an availability zone. Replicas are spread across racks first.
- **Keyspace** — the top-level namespace (roughly a "database") that carries the **replication strategy** and **replication factor**. Use `NetworkTopologyStrategy` in production.
- **Table (column family)** — a named collection of rows sharing a schema and a primary key definition.
- **Partition key** — the part of the primary key hashed into a token; it determines *which nodes* hold the row. All rows with the same partition key live together, sorted, on the same replicas.
- **Clustering columns** — the remainder of the primary key; they define the **sort order of rows within a partition** and enable efficient range scans.
- **Replication Factor (RF)** — how many copies of each partition exist per datacenter. `RF=3` is the production default.
- **Consistency Level (CL)** — a *per-query* setting for how many replicas must respond: `ONE`, `QUORUM`, `LOCAL_QUORUM`, `ALL`, etc. This is the tunable dial between latency and correctness.
- **Coordinator** — whichever node the client connected to for a given request. It fans the request out to replicas and assembles the answer; the role is per-request, not a fixed identity.
- **Gossip** — the peer-to-peer protocol nodes use to exchange state (up/down, load, schema version, tokens) once per second with a few random peers.
- **CQL** — Cassandra Query Language, a SQL-*looking* language with deliberately restricted semantics (no joins, no arbitrary `WHERE`).

## 3. Theory & Internals

### Consistent hashing and the token ring

Cassandra places data using **consistent hashing**. The partition key of every row is hashed with **MurmurHash3** into a 64-bit signed token:

```
token = murmur3_128(partition_key) truncated to signed 64-bit
range  = [-9223372036854775808, 9223372036854775807]
```

The ring is that range wrapped into a circle. Each node owns one or more **token ranges**. A row belongs to the first node clockwise from its token; the next `RF-1` distinct nodes (skipping racks already used) hold the replicas.

Modern Cassandra uses **virtual nodes (vnodes)** — each physical node claims many small ranges instead of one big one. The default in Cassandra 4.x is `num_tokens: 16` (down from 256 in 3.x, because fewer tokens dramatically improves availability math and repair cost). With vnodes, adding a node steals a little range from many peers in parallel rather than splitting one neighbour's range, so streaming is faster and load stays even.

### Why masterless changes the failure math

In a leader-based system, availability of a shard = availability of its leader (plus failover time, typically seconds). In Cassandra, a partition is available for a `CL=QUORUM` write as long as `floor(RF/2)+1` replicas are alive. With `RF=3`, that means **any one node can die with zero impact** — no election, no promotion, no client reconfiguration. With `RF=3` and `CL=ONE`, two of the three can die.

### Quorum arithmetic

```
QUORUM      = floor(RF / 2) + 1
RF=3 → 2    RF=5 → 3    RF=1 → 1

Strong (linearizable-ish read-your-writes) when:
    R + W > RF
e.g. RF=3, W=QUORUM(2), R=QUORUM(2) → 4 > 3  ✅ overlapping replica sets
     RF=3, W=ONE(1),    R=ONE(1)    → 2 > 3? ❌ eventually consistent
```

The overlap guarantee is set-theoretic: if the write set and the read set both exceed half the replicas, they must share at least one node, and that node holds the newest value. Cassandra resolves conflicts by **last-write-wins on a per-cell timestamp** (microsecond precision, client- or coordinator-supplied).

### LSM-tree storage

Writes are never in-place. A write appends to the **commit log** (durability) and updates an in-memory **memtable** (sorted). When the memtable fills, it is flushed to an immutable **SSTable** on disk. Reads may need to merge several SSTables plus the memtable. **Compaction** periodically merges SSTables, discarding superseded cells and expired tombstones. This makes writes O(1) sequential appends — the reason Cassandra's write path is so fast — and makes reads a merge problem, mitigated by bloom filters, partition indexes, and the row cache.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="c1a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="390" y="20" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Token ring: RF=3, key hashed to token 42</text>
  <circle cx="250" cy="185" r="115" fill="none" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 4"/>
  <circle cx="250" cy="70" r="26" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="250" y="68" text-anchor="middle" fill="#1e293b" font-size="11">N1</text>
  <text x="250" y="80" text-anchor="middle" fill="#1e293b" font-size="10">rack A</text>
  <circle cx="352" cy="130" r="26" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="352" y="128" text-anchor="middle" fill="#1e293b" font-size="11">N2</text>
  <text x="352" y="140" text-anchor="middle" fill="#1e293b" font-size="10">rack B</text>
  <circle cx="352" cy="245" r="26" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="352" y="243" text-anchor="middle" fill="#1e293b" font-size="11">N3</text>
  <text x="352" y="255" text-anchor="middle" fill="#1e293b" font-size="10">rack C</text>
  <circle cx="250" cy="300" r="26" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="250" y="304" text-anchor="middle" fill="#1e293b" font-size="11">N4</text>
  <circle cx="148" cy="245" r="26" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="148" y="249" text-anchor="middle" fill="#1e293b" font-size="11">N5</text>
  <circle cx="148" cy="130" r="26" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="148" y="134" text-anchor="middle" fill="#1e293b" font-size="11">N6</text>
  <text x="250" y="180" text-anchor="middle" fill="#1e293b" font-size="12">token space</text>
  <text x="250" y="198" text-anchor="middle" fill="#1e293b" font-size="11">-2^63 .. 2^63-1</text>
  <rect x="500" y="60" width="255" height="98" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="512" y="82" fill="#1e293b" font-size="12">INSERT INTO msgs (channel_id, ...)</text>
  <text x="512" y="102" fill="#1e293b" font-size="12">murmur3('chan-9') = token 42</text>
  <text x="512" y="122" fill="#1e293b" font-size="12">owner = N1 (first clockwise)</text>
  <text x="512" y="142" fill="#1e293b" font-size="12">replicas = N1, N2, N3 (distinct racks)</text>
  <rect x="500" y="185" width="255" height="120" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="512" y="207" fill="#1e293b" font-size="12" font-weight="bold">Availability math (RF=3)</text>
  <text x="512" y="228" fill="#1e293b" font-size="12">QUORUM = floor(3/2)+1 = 2</text>
  <text x="512" y="248" fill="#1e293b" font-size="12">1 node down &#8594; writes still succeed</text>
  <text x="512" y="268" fill="#1e293b" font-size="12">R + W &gt; RF &#8594; 2 + 2 &gt; 3 &#8594; strong</text>
  <text x="512" y="288" fill="#1e293b" font-size="12">no leader election, no failover pause</text>
  <line x1="497" y1="110" x2="285" y2="82" stroke="#4f46e5" stroke-width="2" marker-end="url(#c1a)"/>
</svg>
```

## 4. Architecture & Workflow

A single write travelling through a 6-node, `RF=3`, `CL=LOCAL_QUORUM` cluster:

1. **Driver picks a coordinator.** The DataStax driver hashes the partition key locally (token-aware policy) and sends the request straight to a *replica* for that token, ideally in the local datacenter. This saves one network hop versus a random coordinator.
2. **Coordinator computes the replica set.** It applies the partitioner and the keyspace's replication strategy to derive the 3 endpoints, then filters/orders them by snitch-reported proximity.
3. **Fan-out.** The coordinator sends the mutation to all 3 replicas in parallel (not just the quorum — all of them; the CL only controls how many *acks* it waits for).
4. **Each replica durably writes.** Append to `commitlog`, then apply to the memtable. `commitlog_sync: periodic` (default, fsync every 10 s) or `batch` (fsync per write, slower, safer). The ack is returned as soon as both steps are in place.
5. **Coordinator counts acks.** With `LOCAL_QUORUM` on `RF=3`, it returns success to the client after **2** acks. The third replica keeps going in the background.
6. **Hinted handoff on failure.** If a replica is down, the coordinator stores a **hint** (default up to `max_hint_window: 3h`) and replays it when the node returns.
7. **Flush and compaction.** When the memtable crosses `memtable_cleanup_threshold`, it is flushed to an immutable SSTable and the corresponding commit log segments are recycled. Compaction later merges SSTables.
8. **Read path.** A read at `LOCAL_QUORUM` asks the closest replica for full data and the others for a digest (hash). If digests disagree, the coordinator issues a **read repair** — fetching full data, reconciling by timestamp, writing the newest version back to stale replicas — before answering the client.
9. **Anti-entropy repair.** Periodically (`nodetool repair`, or Reaper), replicas exchange **Merkle trees** to find and stream missing data. This must run at least once every `gc_grace_seconds` (default **864000** = 10 days) to prevent deleted data resurrecting.

```svg
<svg viewBox="0 0 790 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="c1b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#0ea5e9"/></marker>
    <marker id="c1c" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="395" y="20" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Write path: client &#8594; coordinator &#8594; 3 replicas &#8594; LSM storage</text>
  <rect x="20" y="140" width="105" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="72" y="165" text-anchor="middle" fill="#1e293b">App + driver</text>
  <text x="72" y="183" text-anchor="middle" fill="#1e293b" font-size="10">token-aware</text>
  <rect x="165" y="140" width="115" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="222" y="165" text-anchor="middle" fill="#1e293b">Coordinator</text>
  <text x="222" y="183" text-anchor="middle" fill="#1e293b" font-size="10">any node, per request</text>
  <rect x="330" y="55" width="105" height="48" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="382" y="76" text-anchor="middle" fill="#1e293b">Replica 1</text>
  <text x="382" y="92" text-anchor="middle" fill="#1e293b" font-size="10">ack in 1.2 ms</text>
  <rect x="330" y="145" width="105" height="48" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="382" y="166" text-anchor="middle" fill="#1e293b">Replica 2</text>
  <text x="382" y="182" text-anchor="middle" fill="#1e293b" font-size="10">ack in 1.8 ms</text>
  <rect x="330" y="235" width="105" height="48" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="382" y="256" text-anchor="middle" fill="#1e293b">Replica 3</text>
  <text x="382" y="272" text-anchor="middle" fill="#1e293b" font-size="10">slow / down &#8594; hint</text>
  <line x1="127" y1="170" x2="161" y2="170" stroke="#0ea5e9" stroke-width="2" marker-end="url(#c1b)"/>
  <line x1="282" y1="160" x2="326" y2="82" stroke="#16a34a" stroke-width="2" marker-end="url(#c1c)"/>
  <line x1="282" y1="170" x2="326" y2="170" stroke="#16a34a" stroke-width="2" marker-end="url(#c1c)"/>
  <line x1="282" y1="182" x2="326" y2="258" stroke="#d97706" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#c1b)"/>
  <text x="222" y="228" text-anchor="middle" fill="#1e293b" font-size="11">CL=LOCAL_QUORUM</text>
  <text x="222" y="245" text-anchor="middle" fill="#1e293b" font-size="11">waits for 2 of 3</text>
  <rect x="490" y="55" width="285" height="70" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="502" y="77" fill="#1e293b" font-weight="bold">1. Commit log (append-only, fsync)</text>
  <text x="502" y="97" fill="#1e293b">sequential disk write, crash recovery</text>
  <text x="502" y="115" fill="#1e293b" font-size="11">commitlog_sync: periodic / 10000 ms</text>
  <rect x="490" y="140" width="285" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="502" y="162" fill="#1e293b" font-weight="bold">2. Memtable (sorted, in heap/offheap)</text>
  <text x="502" y="182" fill="#1e293b">per table; ack sent once written here</text>
  <text x="502" y="200" fill="#1e293b" font-size="11">flush on size / commitlog pressure</text>
  <rect x="490" y="225" width="285" height="85" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="502" y="247" fill="#1e293b" font-weight="bold">3. SSTable (immutable, on disk)</text>
  <text x="502" y="267" fill="#1e293b">Data.db + Index + Bloom filter + Summary</text>
  <text x="502" y="285" fill="#1e293b" font-size="11">compaction merges, drops tombstones</text>
  <text x="502" y="302" fill="#1e293b" font-size="11">after gc_grace_seconds = 864000</text>
  <line x1="632" y1="127" x2="632" y2="136" stroke="#4f46e5" stroke-width="2" marker-end="url(#c1b)"/>
  <line x1="632" y1="212" x2="632" y2="221" stroke="#4f46e5" stroke-width="2" marker-end="url(#c1b)"/>
  <line x1="437" y1="80" x2="486" y2="80" stroke="#16a34a" stroke-width="2" marker-end="url(#c1c)"/>
</svg>
```

## 5. Implementation

Spin up a single-node cluster and run the classic message-store model.

```bash
# Fastest possible local Cassandra 5.0
docker run -d --name cass1 -p 9042:9042 \
  -e CASSANDRA_CLUSTER_NAME=zariya-demo \
  cassandra:5.0

# Wait for it to come up (~40s), then check the ring
docker exec cass1 nodetool status
# Datacenter: datacenter1
# =======================
# Status=Up/Down |/ State=Normal/Leaving/Joining/Moving
# --  Address     Load       Tokens  Owns (effective)  Host ID   Rack
# UN  172.17.0.2  110.4 KiB  16      100.0%            8f2c...   rack1

docker exec -it cass1 cqlsh
```

```cql
-- Production-shaped keyspace. NEVER SimpleStrategy in prod.
CREATE KEYSPACE IF NOT EXISTS chat
WITH replication = {
  'class': 'NetworkTopologyStrategy',
  'datacenter1': 3
} AND durable_writes = true;

USE chat;

-- Query-first modelling: "give me the newest messages in a channel"
CREATE TABLE messages (
    channel_id   text,
    bucket       int,          -- time bucket keeps partitions bounded
    message_id   timeuuid,
    author_id    uuid,
    body         text,
    PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'DAYS',
                    'compaction_window_size': 1}
  AND default_time_to_live = 0
  AND gc_grace_seconds = 864000;

INSERT INTO messages (channel_id, bucket, message_id, author_id, body)
VALUES ('chan-9', 20260722, now(), uuid(), 'ship it')
USING TTL 0;

-- Efficient: single partition, ordered by clustering column
SELECT message_id, body FROM messages
WHERE channel_id = 'chan-9' AND bucket = 20260722
LIMIT 50;

-- Where the token actually landed
SELECT token(channel_id, bucket) FROM messages
WHERE channel_id = 'chan-9' AND bucket = 20260722 LIMIT 1;
-- system.token(channel_id, bucket)
-- --------------------------------
--            -3074457345618258602
```

```python
# pip install cassandra-driver
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.policies import DCAwareRoundRobinPolicy, TokenAwarePolicy
from cassandra import ConsistencyLevel
import uuid, datetime

profile = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(
        DCAwareRoundRobinPolicy(local_dc="datacenter1")),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM,
    request_timeout=10,
)
cluster = Cluster(["127.0.0.1"], port=9042,
                  execution_profiles={EXEC_PROFILE_DEFAULT: profile})
session = cluster.connect("chat")

# ALWAYS prepare: server parses once, and the driver learns the partition key
# so it can route directly to a replica (saves a hop).
insert = session.prepare("""
  INSERT INTO messages (channel_id, bucket, message_id, author_id, body)
  VALUES (?, ?, now(), ?, ?)
""")
select = session.prepare("""
  SELECT message_id, body FROM messages
  WHERE channel_id = ? AND bucket = ? LIMIT ?
""")

bucket = int(datetime.date.today().strftime("%Y%m%d"))
session.execute(insert, ("chan-9", bucket, uuid.uuid4(), "hello cassandra"))

for row in session.execute(select, ("chan-9", bucket, 50)):
    print(row.message_id, row.body)

cluster.shutdown()
```

```java
// DataStax Java driver 4.x — same model, same routing guarantees
try (CqlSession session = CqlSession.builder()
        .addContactPoint(new InetSocketAddress("127.0.0.1", 9042))
        .withLocalDatacenter("datacenter1").withKeyspace("chat").build()) {
    PreparedStatement ps = session.prepare(
        "SELECT message_id, body FROM messages WHERE channel_id=? AND bucket=? LIMIT ?");
    ResultSet rs = session.execute(ps.bind("chan-9", 20260722, 50)
          .setConsistencyLevel(DefaultConsistencyLevel.LOCAL_QUORUM));
    rs.forEach(r -> System.out.println(r.getUuid("message_id") + " " + r.getString("body")));
}
```

> **Optimization:** the single highest-leverage change in most Cassandra apps is switching from `session.execute("SELECT ... WHERE id = '" + x + "'")` to **prepared statements with a token-aware policy**. Unprepared strings force a full parse per request *and* leave the driver unable to compute the token, so every request hits a random coordinator and pays an extra network hop plus a full fan-out. On a 30-node cluster this alone routinely cuts p99 read latency by 30–50%.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Availability | No single point of failure; any node serves any request; survives whole-DC loss with multi-DC RF | You must reason about consistency yourself; stale reads are possible at low CL |
| Write throughput | Append-only LSM path — no read-before-write, no lock; scales near-linearly with nodes | Read amplification grows with SSTable count; compaction consumes CPU and I/O continuously |
| Horizontal scale | Add a node, `nodetool` streams ranges, throughput rises; proven to 1000s of nodes | Rebalancing streams terabytes; capacity planning and repair cost grow with the cluster |
| Multi-datacenter | Native async DC replication; `LOCAL_QUORUM` keeps latency local while data spans regions | Cross-DC lag means a region failover can lose recent writes unless you use `EACH_QUORUM` |
| Data model | Predictable O(1)-ish partition lookups; queries are fast *by construction* | No joins, no ad-hoc queries; denormalization means writing the same fact to 3–5 tables |
| Tunable consistency | Per-query dial from `ONE` to `ALL`, including `LOCAL_*` variants | Easy to misconfigure; `R+W>RF` must hold or you silently get eventual consistency |
| Operations | Symmetric nodes, no special roles, rolling upgrades | Repair, compaction tuning, and tombstone management are real ongoing work |
| Deletes | Cheap at write time (just a tombstone) | Tombstones are the #1 production pathology; deletes are expensive at *read* time |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Modelling entities like an RDBMS, then bolting on indexes.** → ✅ Start from the list of queries. One table per query shape. Denormalize without guilt — disk is cheap, a coordinator scatter-gather is not.
2. ⚠️ **Unbounded partitions** (`PRIMARY KEY (user_id, event_time)` for a firehose user). → ✅ Add a **bucket** to the partition key (`(user_id, yyyymm)`). Target **< 100 MB and < 100,000 rows** per partition; alarm at 200 MB.
3. ⚠️ **`ALLOW FILTERING` to "make the query work".** → ✅ It converts a targeted lookup into a full-cluster scan. Never in application code. If you need it, you need another table, a SAI index (5.0), or an analytics engine.
4. ⚠️ **Treating `BATCH` as a transaction.** → ✅ A logged batch gives **atomicity, not isolation**, and a multi-partition batch makes the coordinator a bottleneck. Use batches only for multiple rows in the *same partition*, or for keeping denormalized tables in sync — and accept the cost.
5. ⚠️ **Queue / mailbox tables** (insert, read, delete, repeat over the same partition). → ✅ This is the classic tombstone antipattern; reads scan thousands of tombstones. Use TTLs plus `TimeWindowCompactionStrategy`, or don't use Cassandra as a queue.
6. ⚠️ **Lowering `gc_grace_seconds` to fight tombstones without repairing.** → ✅ `gc_grace_seconds` (default **864000**, 10 days) is the window in which repair must propagate a delete. Lower it *only* if you repair more often than the new value; otherwise deleted data resurrects.
7. ⚠️ **Secondary indexes on high-cardinality columns** (email, UUID) or very low cardinality (boolean). → ✅ Native 2i is local-per-node, so a lookup scatters to every node. Prefer a denormalized lookup table; in 5.0, prefer **SAI** (`CREATE CUSTOM INDEX ... USING 'StorageAttachedIndex'`).
8. ⚠️ **Read-modify-write loops** (`SELECT` then `UPDATE`). → ✅ Racy under concurrency and doubles latency. Use counters, collections, or `IF` (LWT/Paxos) — knowing LWT costs ~4 round trips and is 10–20× slower.
9. ⚠️ **`SimpleStrategy` in production** or `RF=1`. → ✅ Always `NetworkTopologyStrategy` with per-DC RF (usually 3) — it is the only strategy that respects racks and datacenters.
10. ⚠️ **Never running repair.** → ✅ Run incremental or subrange repair on a schedule (Cassandra Reaper is the standard tool) so every range is repaired within `gc_grace_seconds`.
11. ⚠️ **Client-side timestamps from unsynced clocks.** → ✅ Last-write-wins means a node with a skewed clock can "win" forever. Run NTP/chrony everywhere, and prefer `SELECT *`-free projections since a wide-partition read pulls every column into the coordinator's heap and triggers GC pauses.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** `nodetool status` (up/down, load, ownership), `nodetool tpstats` (dropped mutations and blocked thread pools — the earliest overload signal), `nodetool tablestats <ks>.<tbl>` (partition sizes, SSTable count, bloom filter false-positive ratio), `nodetool cfhistograms` / `tablehistograms` (per-table p50/p95/p99 latency and cells-per-read). Turn on tracing for a single slow query with `TRACING ON;` in cqlsh — it prints every hop, replica, and merge step with microsecond timings. Cassandra 4.0+ ships **virtual tables** (`SELECT * FROM system_views.clients;`, `system_views.sstable_tasks`) so you can introspect from CQL without JMX.

**Monitoring.** Export JMX with the Prometheus JMX exporter or the DataStax Metric Collector. The beans that matter:
`org.apache.cassandra.metrics:type=ClientRequest,scope=Read|Write,name=Latency` (p99!),
`...ClientRequest,name=Timeouts|Unavailables|Failures`,
`...type=Table,keyspace=*,scope=*,name=TombstoneScannedHistogram` and `SSTablesPerReadHistogram`,
`...type=Compaction,name=PendingTasks` (should trend to 0; a rising number means you're losing the compaction race),
`...type=ThreadPools,path=request,scope=MutationStage,name=PendingTasks`,
plus JVM GC pause time. Alert on: dropped mutations > 0, pending compactions > 100 sustained, p99 read > SLO, hints piling up, and any node not `UN`.

**Security.** Turn on `authenticator: PasswordAuthenticator` and `authorizer: CassandraAuthorizer` — the defaults are `AllowAllAuthenticator`, i.e. wide open. Immediately change the `cassandra/cassandra` superuser and raise `system_auth` RF to match your DCs (an RF=1 `system_auth` means login fails when one node dies). Enable `client_encryption_options` and `server_encryption_options` (internode TLS). Bind `rpc_address`/`listen_address` to private interfaces and never expose 9042/7000/7199 to the internet. Cassandra 4.0 added **audit logging** (`audit_logging_options`) and full query logging (`nodetool enablefullquerylog`). Use role-based access control with per-keyspace grants.

**Performance & scaling.** Scale by adding nodes one at a time (`auto_bootstrap: true`), then `nodetool cleanup` on the existing nodes to drop ranges they no longer own. Keep heap at 8–16 GB with G1GC (or 31 GB max to stay under compressed-oops); leave the rest of RAM to the page cache. Use local NVMe/SSD — never network storage with high latency variance for the commit log. Pick compaction by workload: `SizeTieredCompactionStrategy` (write-heavy, default), `LeveledCompactionStrategy` (read-heavy, overwrite-heavy, costs 2× write I/O), `TimeWindowCompactionStrategy` (time series with TTLs). Keep each node's data under ~1–2 TB so bootstrap and repair complete in reasonable time.

## 9. Interview Questions

**Q: What kind of database is Cassandra, and what does "masterless" actually mean?**
A: Cassandra is a distributed wide-column NoSQL store using a partitioned row model on a consistent-hashing ring. Masterless means every node runs identical code and holds an identical role — there is no primary that must accept writes and no config/router tier. Any node can act as coordinator for any request, so there is no election, no failover pause, and no single point of failure.

**Q: When would you choose Cassandra over PostgreSQL?**
A: When you need very high write throughput, always-on availability across datacenters, and linear horizontal scale, and your access patterns are known and partition-friendly (time series, event logs, per-user feeds, IoT, messaging). Choose PostgreSQL when you need joins, ad-hoc queries, multi-row ACID transactions, or your dataset comfortably fits one machine.

**Q: What is a partition key and why does it matter so much?**
A: The partition key is the part of the primary key that is hashed into a token, and the token determines which nodes store the row. It controls data distribution, hot-spotting, and which queries are efficient — every fast query in Cassandra supplies the full partition key. Get it wrong and you get either unbounded partitions or a hot node.

**Q: Explain replication factor versus consistency level.**
A: RF is a per-keyspace, per-datacenter property that fixes how many copies of the data exist; it is durability and placement. CL is a per-query knob that controls how many of those replicas must acknowledge before the operation returns. RF is structural and expensive to change; CL is a runtime latency/consistency trade-off.

**Q: What does `R + W > RF` guarantee?**
A: That the set of replicas acknowledging the write and the set answering the read overlap by at least one node, so a read is guaranteed to see the latest acknowledged write. With RF=3, QUORUM writes (2) plus QUORUM reads (2) satisfy it. It does not give you linearizability for read-modify-write — that needs lightweight transactions.

**Q: Why doesn't Cassandra support joins?**
A: A join would require reading rows that live on arbitrary, unrelated nodes, turning one request into a cluster-wide scatter-gather with unbounded latency and no way to bound the blast radius of a slow node. Cassandra pushes that cost to write time instead: you denormalize and maintain one table per query shape.

**Q: What happens to a write if one of the three replicas is down?**
A: The coordinator still sends the mutation to all three; the two live ones ack, and at `QUORUM`/`LOCAL_QUORUM` the client gets success. For the dead replica the coordinator stores a **hint** (up to `max_hint_window_in_ms`, default 3 hours) and replays it on recovery. If the node stays down past that window, anti-entropy repair is what restores the missing data.

**Q: (Senior) Why did the default `num_tokens` drop from 256 to 16 in Cassandra 4.0?**
A: With many vnodes per node, every node shares token ranges with almost every other node, so the probability that *some* quorum is lost when any RF nodes fail approaches 1 — availability actually degrades as the cluster grows. Fewer tokens (16) plus the new allocation algorithm (`allocate_tokens_for_local_replication_factor`) keeps ranges balanced while sharply reducing the number of overlapping replica sets, which also makes repair and streaming far cheaper.

**Q: (Senior) Cassandra is called "AP" — is that the whole story?**
A: No. CAP only describes behaviour during a network partition, and it is a per-operation property in Cassandra, not a system-wide one. At `CL=ONE` you are firmly AP; at `QUORUM`/`QUORUM` you sacrifice availability of the minority side to get consistency, so you are behaving CP for that query. PACELC is the better frame: *else* (no partition) Cassandra trades latency for consistency, which is exactly what the CL dial exposes.

**Q: (Senior) Walk me through why tombstones cause outages and how you'd diagnose one.**
A: A delete writes a tombstone that must be retained for `gc_grace_seconds` (864000) so repair can propagate it; until compaction drops it, every read of that partition materialises and skips the tombstones. A read scanning > `tombstone_warn_threshold` (1000) logs a warning and > `tombstone_failure_threshold` (100000) throws `TombstoneOverwhelmingException`, which then cascades as coordinator timeouts and GC pressure. Diagnose with `nodetool tablehistograms` and the `TombstoneScannedHistogram` metric, confirm the offending partition with `sstablemetadata`/tracing, and fix at the model level (TTL + TWCS, avoid queue patterns, avoid inserting nulls which also create tombstones).

**Q: (Senior) How does Cassandra resolve two concurrent writes to the same cell?**
A: Last-write-wins on a per-cell microsecond timestamp, with the cell value's byte ordering as the tiebreaker for identical timestamps. There is no vector clock (that was removed after 0.7) and no conflict surface exposed to the application — the loser is silently discarded. This makes clock synchronisation a correctness concern, and it means read-modify-write is unsafe without LWT.

**Q: What is a coordinator node, and how does the driver choose it?**
A: The coordinator is simply whichever node the client sends a request to; the role is per-request and every node can play it. A token-aware driver hashes the partition key client-side and picks a node that is itself a replica in the local DC, eliminating one hop and spreading coordination load evenly.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Cassandra is a masterless, wide-column, distributed database. Data is partitioned by a Murmur3 hash of the **partition key** onto a token ring; each partition is replicated to **RF** nodes chosen by `NetworkTopologyStrategy` across racks and datacenters. Writes append to a **commit log** and a **memtable**, flush to immutable **SSTables**, and are merged by **compaction** — an LSM tree, so writes are fast and never read-before-write. Any node can coordinate; the client picks a **consistency level** per query, and `R + W > RF` yields strong consistency. Conflicts resolve by last-write-wins on cell timestamps. Failures are patched by hinted handoff, read repair, and Merkle-tree anti-entropy repair, which must run within `gc_grace_seconds` (10 days). You model tables per query, keep partitions under 100 MB / 100k rows, and never use `ALLOW FILTERING` in application code.

| Item | Value / Command |
|---|---|
| Default partitioner | `Murmur3Partitioner` (64-bit token) |
| Default `num_tokens` (4.x/5.0) | `16` |
| Production replication | `NetworkTopologyStrategy`, RF=3 per DC |
| Production CL | `LOCAL_QUORUM` read + write |
| `QUORUM` formula | `floor(RF/2) + 1` |
| `gc_grace_seconds` | `864000` (10 days) |
| Tombstone warn / fail | `1000` / `100000` |
| Max partition guidance | `< 100 MB`, `< 100,000 rows` |
| Client port / internode / JMX | `9042` / `7000` (7001 TLS) / `7199` |
| Cluster health | `nodetool status` |
| Per-table latency | `nodetool tablehistograms ks.tbl` |
| Overload signal | `nodetool tpstats` (dropped mutations) |

**Flash cards**
- **What determines which nodes store a row?** → `murmur3(partition key)` → token → first replica clockwise on the ring, plus `RF-1` more across distinct racks.
- **Formula for strong consistency** → `R + W > RF`; with RF=3, `LOCAL_QUORUM`+`LOCAL_QUORUM` = 2+2 > 3.
- **Why are Cassandra writes so fast?** → Append to commit log + in-memory memtable; no read, no seek, no lock, no leader.
- **What is a tombstone?** → A marker for a deleted cell/row, retained for `gc_grace_seconds` (864000) so repair can propagate the delete before compaction drops it.
- **What is the #1 data-modelling rule?** → Model tables around queries, one table per access pattern; every fast query supplies the full partition key.

## 11. Hands-On Exercises & Mini Project

- [ ] Start a 3-node cluster with `docker compose` (one seed, two joiners), confirm `nodetool status` shows three `UN` nodes with roughly 33% ownership each.
- [ ] Create a keyspace with `NetworkTopologyStrategy` RF=3, insert 10 rows, then run `nodetool getendpoints chat messages 'chan-9'` to see exactly which three nodes hold a given partition.
- [ ] Kill one container (`docker stop cass2`). Verify writes at `LOCAL_QUORUM` still succeed and writes at `ALL` now fail with `UnavailableException`. Restart the node and watch hints replay in the log.
- [ ] Turn on `TRACING ON` in cqlsh and compare the trace of a single-partition `SELECT` against the same query with `ALLOW FILTERING` across many partitions — record the difference in "Read N live rows and M tombstone cells".
- [ ] Insert 200,000 rows into one partition, run `nodetool tablestats` and record the max partition size; then re-model with a bucket in the partition key and compare.

### Mini Project — "Channel Timeline Service"

**Goal.** Build a small chat-timeline API on a local 3-node Cassandra cluster that stays fast and available while a node is down.

**Requirements.**
1. Model `messages` with `PRIMARY KEY ((channel_id, day_bucket), message_id)`, `CLUSTERING ORDER BY (message_id DESC)`, TWCS with a 1-day window, and a 30-day `default_time_to_live`.
2. Add a second table `channels_by_user` so "which channels does user X belong to?" is a single-partition read — write to both tables from the app.
3. Expose two endpoints (FastAPI or Spring Boot): `POST /channels/{id}/messages` and `GET /channels/{id}/messages?limit=50&before=<timeuuid>`, using prepared statements, a token-aware policy, and `LOCAL_QUORUM`.
4. Load-test with 5,000 writes/sec while stopping one node; record p99 latency and error rate before, during, and after.

**Extensions.**
- Add a `reactions` counter table using Cassandra counters and observe why counters cannot be part of a normal table.
- Implement idempotent "edit message" using LWT (`UPDATE ... IF version = ?`) and measure the latency penalty versus a plain update.
- Add a second datacenter (`ALTER KEYSPACE ... {'dc1': 3, 'dc2': 3}`), run `nodetool rebuild -- dc1` on the new DC, and compare `LOCAL_QUORUM` versus `EACH_QUORUM` write latency.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *History & Architecture Overview* (where the Dynamo and BigTable halves come from), *CAP Theorem & Tunable Consistency* (the consistency-level dial in depth), *Installation & Cluster Setup* (getting a real multi-node ring running), *Keyspaces, Tables & CQL Basics* (schema mechanics), *Primary Key: Partition & Clustering Columns* (the single most important modelling concept).

- **Apache Cassandra Documentation — Getting Started** — Apache Software Foundation · *Beginner* · the authoritative, version-tracked reference; start with "Architecture" and "Data Modeling". <https://cassandra.apache.org/doc/latest/>
- **Cassandra: A Decentralized Structured Storage System** — Lakshman & Malik (Facebook), 2009 · *Intermediate* · the original 6-page paper; short, readable, and shows exactly which ideas came from Dynamo and which from BigTable. <https://www.cs.cornell.edu/projects/ladis2009/papers/lakshman-ladis2009.pdf>
- **DataStax Academy — Cassandra Fundamentals** — DataStax · *Beginner* · free structured course with browser labs covering the ring, replication, and CQL. <https://www.datastax.com/learn/cassandra-fundamentals>
- **The Last Pickle Blog** — TLP / DataStax · *Advanced* · the best operational writing on Cassandra anywhere: repair, compaction, tombstones, JVM tuning. <https://thelastpickle.com/blog/>
- **How Discord Stores Billions of Messages** — Discord Engineering · *Intermediate* · the definitive real-world case study on partition bucketing and what went wrong at scale. <https://discord.com/blog/how-discord-stores-billions-of-messages>
- **Cassandra Data Modeling Best Practices** — Netflix Technology Blog / DataStax · *Intermediate* · practical rules for query-first modelling from teams running thousands of nodes. <https://netflixtechblog.com/tagged/cassandra>
- **Apache Cassandra 4.0 Overview (ApacheCon talk)** — Apache Cassandra PMC · *Intermediate* · covers virtual tables, audit logging, the new num_tokens default, and 4.0 stability work. <https://www.youtube.com/@PlanetCassandra>
- **ScyllaDB University — NoSQL Essentials** — ScyllaDB · *Beginner* · free courses on the same Dynamo/BigTable architecture; excellent for understanding the design independently of one implementation. <https://university.scylladb.com/>

---

*Apache Cassandra Handbook — chapter 01.*
