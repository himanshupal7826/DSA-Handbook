# 44 · Production Case Studies & Architectures

> **In one line:** The companies that run the largest Cassandra fleets on earth converged on the same four practices — bound every partition, put an abstraction layer in front, automate repair and replacement, and design for regional failure — and every public incident is a story about violating one of them.

---

## 1. Overview

Cassandra's documentation tells you what the system does. Production case studies tell you what it *costs*, and those are two different books. This chapter reads the public engineering record of four organisations that operate Cassandra at a scale almost nobody else reaches — Netflix, Apple, Discord and Uber, with Instagram as a supporting witness — and extracts the patterns that are repeatable at 20 nodes as well as at 200,000.

The problem being solved here is **the gap between correct and survivable**. A schema can be perfectly correct by the query-first rules in chapter 7 and still take down a service, because at scale the failure modes are emergent: one channel becomes 10,000× more active than the median; a compaction backlog quietly grows for six hours until reads touch 40 SSTables; a repair that has not run in 11 days resurrects deleted rows because `gc_grace_seconds` is 864000. None of these appear in a load test with uniform-random keys. All of them appear in the blog posts below.

The one-line history: Facebook built Cassandra for inbox search, open-sourced it in 2008, and then largely walked away — which turned out to be the making of the project, because Netflix, Apple and later Apple-scale contributors took over stewardship. Netflix's 2011 AWS benchmark (about 1.1 million writes/second across roughly 288 EC2 instances, scaling near-linearly as nodes were added) is what convinced the industry that the linear-scalability claim was real. Apple's fleet, publicly described across successive Cassandra Summits as growing from tens of thousands of nodes and petabytes of data to hundreds of thousands of nodes across thousands of clusters, is what convinced the industry it was durable.

**Concrete example.** Discord's message store is the single best-documented Cassandra story in existence, because they wrote up both the arrival and the departure. In 2017 they moved messages off MongoDB onto Cassandra with a partition key of `(channel_id, bucket)` — a static 10-day time bucket — and clustering by Snowflake `message_id`. It worked for years and trillions of messages. Then the failure modes accumulated: hot partitions from very large servers, tombstone-heavy reads from deleted messages, JVM garbage collection pauses that operators eventually monitored by *watching for GC pauses and killing the node*, and compaction that could never quite keep up. In 2022–23 they migrated the same data model to ScyllaDB, going from 177 Cassandra nodes to 72 ScyllaDB nodes, and — critically — put a Rust "data services" layer in front that coalesces concurrent identical requests so a hot channel produces one database query rather than thousands.

The durable mental model: **at scale, Cassandra is not a database you query — it is a storage tier you put a service in front of.** Netflix built data abstraction layers. Discord built data services. Uber built a control plane. Nobody at this scale lets application code talk raw CQL to the cluster, and that is the most transferable lesson in this chapter.

## 2. Core Concepts

- **Bucketing** — splitting a naturally unbounded partition (a chat channel, a device's metrics, a user's events) by a time or hash component in the partition key so that no partition exceeds ~100 MB / ~100k rows.
- **Data abstraction layer (DAL)** — a service between applications and Cassandra that owns the schema, enforces query shapes, adds pagination/chunking, and can swap the storage engine underneath. Netflix's Key-Value and TimeSeries abstractions are the canonical published examples.
- **Request coalescing** — merging concurrent identical reads for the same key into a single database round trip, so a celebrity partition sees one query instead of N. Discord's headline fix for hot partitions.
- **Sidecar** — a process co-located with each Cassandra node handling backup, token assignment, health and replacement. Netflix's **Priam** is the original; the Apache project later added `cassandra-sidecar`.
- **Hot partition (celebrity problem)** — one partition key absorbing a disproportionate share of traffic, saturating exactly `RF` nodes regardless of cluster size.
- **Repair debt** — the state of not having repaired a table within `gc_grace_seconds`, after which deleted data can resurrect because tombstones were purged before reaching every replica.
- **Zero-copy streaming** — Cassandra 4.0's ability to stream entire SSTables at the file level rather than deserialising row by row, cutting bootstrap and rebuild times dramatically (CASSANDRA-14556). The feature that made 4.0 fleets operable at Apple's scale.
- **Region evacuation** — deliberately draining all traffic out of one cloud region and serving from the others; Netflix practises this as a routine exercise, not an emergency procedure.
- **Rocksandra** — Instagram's pluggable RocksDB storage engine for Cassandra, built to attack GC-driven tail latency; roughly an order-of-magnitude P99 read improvement on their workload.
- **Super-disk** — Discord's GCP disk layout: local NVMe SSDs in RAID0 fronting a network persistent disk in a mirror, so reads hit local flash while durability stays on the network volume.

## 3. Theory & Internals

Why do these particular failure modes dominate at scale? Because three of Cassandra's core mechanisms have **superlinear** cost curves that only bend once you are large enough.

**Hot partitions do not amortise.** A cluster of `N` nodes with `RF=3` serves any single partition from exactly 3 replicas. Adding nodes increases aggregate capacity but does nothing for one key. If a channel receives `Q` reads/second, the per-replica load is:

```
load_per_replica = Q x (CL_read_replicas / RF)      # LOCAL_QUORUM: 2/3 of Q
```

At `Q = 300,000` that is 200,000 reads/sec landing on three specific machines. No amount of horizontal scaling helps. Coalescing does: if `k` concurrent requests for the same key are merged, effective load drops to `Q/k`, and for a celebrity key `k` is large precisely when you need it to be.

**Tombstones make deletes cost reads.** A read must merge every fragment of a partition, including tombstones, until they are purged — which cannot happen before `gc_grace_seconds` (default 864000 = 10 days) *and* not until compaction actually rewrites the SSTable. Scanning `T` tombstones to return `L` live rows costs roughly `O(T + L)` with the constant dominated by deserialisation. Cassandra warns at `tombstone_warn_threshold: 1000` and aborts the query at `tombstone_failure_threshold: 100000`. Discord's 2017 write-up describes exactly this: deleted messages and null writes producing partitions where the scan cost was dominated by dead data.

**Repair cost is quadratic-ish in divergence.** Merkle-tree repair builds a hash tree per token range per replica, compares them, and streams mismatched leaves. The comparison is cheap; the *streaming* is not, and the amount to stream grows with how long you waited. Repair every 7 days on a 10-day `gc_grace_seconds` and you stream deltas. Skip a month and you stream a meaningful fraction of the dataset while serving production traffic. This is why every organisation in this chapter automated repair scheduling before they automated almost anything else.

**GC is the hidden coupling.** A stop-the-world pause longer than the gossip failure-detection threshold makes healthy nodes mark the paused node down. The coordinator then routes around it, increasing load on the remaining replicas, which increases their allocation rate, which increases their GC pressure. That is a positive feedback loop, and it is the mechanism behind most "the cluster fell over all at once" postmortems.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="340" fill="#ffffff"/>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Discord: bounded partitions + request coalescing</text>

  <rect x="20" y="40" width="300" height="130" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="170" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Unbounded: PRIMARY KEY (channel_id, msg_id)</text>
  <rect x="40" y="76" width="260" height="34" rx="6" fill="#ffffff" stroke="#d97706"/>
  <text x="170" y="97" text-anchor="middle" fill="#1e293b" font-size="11">one busy channel = 40 M rows, 6 GB</text>
  <text x="170" y="130" text-anchor="middle" fill="#d97706" font-size="11" font-weight="700">3 replicas carry it all</text>
  <text x="170" y="150" text-anchor="middle" fill="#1e293b" font-size="10">compaction rewrites GBs to change one row</text>

  <rect x="340" y="40" width="400" height="130" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="540" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Bounded: PRIMARY KEY ((channel_id, bucket), msg_id)</text>
  <rect x="360" y="76" width="110" height="34" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="415" y="97" text-anchor="middle" fill="#1e293b" font-size="10">bucket 1994</text>
  <rect x="478" y="76" width="110" height="34" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="533" y="97" text-anchor="middle" fill="#1e293b" font-size="10">bucket 1995</text>
  <rect x="596" y="76" width="124" height="34" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="658" y="97" text-anchor="middle" fill="#1e293b" font-size="10">bucket 1996 (hot)</text>
  <text x="540" y="130" text-anchor="middle" fill="#16a34a" font-size="11" font-weight="700">each bucket = 10 days, spread across the ring</text>
  <text x="540" y="150" text-anchor="middle" fill="#1e293b" font-size="10">TWCS drops whole windows on TTL expiry</text>

  <rect x="20" y="190" width="720" height="134" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="212" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Data services: coalescing a celebrity key</text>
  <rect x="44" y="228" width="80" height="26" rx="5" fill="#ffffff" stroke="#4f46e5"/>
  <text x="84" y="246" text-anchor="middle" fill="#1e293b" font-size="10">client A</text>
  <rect x="44" y="262" width="80" height="26" rx="5" fill="#ffffff" stroke="#4f46e5"/>
  <text x="84" y="280" text-anchor="middle" fill="#1e293b" font-size="10">client B</text>
  <rect x="44" y="296" width="80" height="22" rx="5" fill="#ffffff" stroke="#4f46e5"/>
  <text x="84" y="312" text-anchor="middle" fill="#1e293b" font-size="10">client N</text>
  <line x1="126" y1="241" x2="216" y2="262" stroke="#4f46e5"/>
  <line x1="126" y1="275" x2="216" y2="270" stroke="#4f46e5"/>
  <line x1="126" y1="307" x2="216" y2="278" stroke="#4f46e5"/>
  <rect x="218" y="238" width="170" height="64" rx="8" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="303" y="260" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">data service (Rust)</text>
  <text x="303" y="277" text-anchor="middle" fill="#1e293b" font-size="10">per-key request queue</text>
  <text x="303" y="293" text-anchor="middle" fill="#1e293b" font-size="10">N requests &#8594; 1 query</text>
  <line x1="390" y1="270" x2="470" y2="270" stroke="#0ea5e9" stroke-width="2"/>
  <text x="430" y="262" text-anchor="middle" fill="#16a34a" font-size="10" font-weight="700">1 read</text>
  <circle cx="520" cy="248" r="22" fill="#ffffff" stroke="#16a34a"/>
  <text x="520" y="252" text-anchor="middle" fill="#1e293b" font-size="10">R1</text>
  <circle cx="580" cy="288" r="22" fill="#ffffff" stroke="#16a34a"/>
  <text x="580" y="292" text-anchor="middle" fill="#1e293b" font-size="10">R2</text>
  <circle cx="640" cy="248" r="22" fill="#ffffff" stroke="#16a34a"/>
  <text x="640" y="252" text-anchor="middle" fill="#1e293b" font-size="10">R3</text>
  <text x="690" y="300" text-anchor="middle" fill="#1e293b" font-size="10">RF = 3</text>
</svg>
```

## 4. Architecture & Workflow

Netflix's architecture is the reference implementation of "Cassandra as a regional, self-healing tier." Walk a write through it.

1. **Client calls a service, not a database.** An application calls Netflix's Key-Value or TimeSeries abstraction over gRPC. The abstraction owns the CQL, the pagination, the chunking of oversized values into multiple rows, and the idempotency semantics. Applications cannot write an unbounded partition because the API does not expose one.
2. **The abstraction picks a namespace.** Namespaces map to a keyspace/table with a policy: consistency level, TTL, chunk size, retention. Changing storage engines or physical layout for a namespace is an operations task, not an application rewrite.
3. **The driver writes to the local region at `LOCAL_QUORUM`.** With `NetworkTopologyStrategy` and `RF=3` per region, two local acks satisfy the write. Cross-region replication happens asynchronously — the write never waits on a transatlantic round trip.
4. **Priam handles everything a human would otherwise do.** Token assignment on bootstrap, node replacement when an instance dies, incremental and full snapshot backups pushed to S3, and restore. A dead node is replaced by a fresh instance that claims the same token range and streams from its peers.
5. **Repair runs on a schedule, not on an incident.** Full or incremental repair cycles complete within `gc_grace_seconds` for every table, tracked as an SLO with alerting on repair age.
6. **Regional evacuation is rehearsed.** Traffic is steered away from a region at the edge; the remaining regions absorb it because they were provisioned for it. Cassandra keeps accepting `LOCAL_QUORUM` writes in the surviving regions and reconciles the drained one afterwards via hints and repair.

Uber's architecture answers a different question — not "how do we survive a region" but "how do we run *hundreds of clusters* with a small team." Their published approach is a **control plane over a stateful container platform**: cluster provisioning, node replacement, repair scheduling and remediation are declarative and automated, with the platform reconciling actual state toward desired state. The lesson is the same one Kubernetes operators encode: past roughly ten clusters, human runbooks stop scaling and you must express operations as code.

```svg
<svg viewBox="0 0 760 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="350" fill="#ffffff"/>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Netflix-style multi-region topology</text>

  <rect x="20" y="38" width="720" height="46" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="58" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Applications &#8594; Data Abstraction Layer (gRPC): KV / TimeSeries namespaces</text>
  <text x="380" y="75" text-anchor="middle" fill="#1e293b" font-size="10">owns schema, chunking, pagination, idempotency, consistency policy</text>

  <rect x="20" y="98" width="230" height="150" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="135" y="119" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">us-east-1  RF=3</text>
  <circle cx="70" cy="155" r="19" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="70" y="159" text-anchor="middle" fill="#1e293b" font-size="9">az-a</text>
  <circle cx="135" cy="155" r="19" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="135" y="159" text-anchor="middle" fill="#1e293b" font-size="9">az-b</text>
  <circle cx="200" cy="155" r="19" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="200" y="159" text-anchor="middle" fill="#1e293b" font-size="9">az-c</text>
  <text x="135" y="196" text-anchor="middle" fill="#16a34a" font-size="10" font-weight="700">LOCAL_QUORUM = 2</text>
  <rect x="46" y="206" width="178" height="28" rx="6" fill="#ffffff" stroke="#4f46e5"/>
  <text x="135" y="224" text-anchor="middle" fill="#1e293b" font-size="10">Priam sidecar per node</text>

  <rect x="265" y="98" width="230" height="150" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="380" y="119" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">eu-west-1  RF=3</text>
  <circle cx="315" cy="155" r="19" fill="#ffffff" stroke="#16a34a"/>
  <text x="315" y="159" text-anchor="middle" fill="#1e293b" font-size="9">az-a</text>
  <circle cx="380" cy="155" r="19" fill="#ffffff" stroke="#16a34a"/>
  <text x="380" y="159" text-anchor="middle" fill="#1e293b" font-size="9">az-b</text>
  <circle cx="445" cy="155" r="19" fill="#ffffff" stroke="#16a34a"/>
  <text x="445" y="159" text-anchor="middle" fill="#1e293b" font-size="9">az-c</text>
  <text x="380" y="196" text-anchor="middle" fill="#16a34a" font-size="10" font-weight="700">LOCAL_QUORUM = 2</text>
  <rect x="291" y="206" width="178" height="28" rx="6" fill="#ffffff" stroke="#4f46e5"/>
  <text x="380" y="224" text-anchor="middle" fill="#1e293b" font-size="10">Priam sidecar per node</text>

  <rect x="510" y="98" width="230" height="150" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="625" y="119" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">us-west-2  RF=3</text>
  <circle cx="560" cy="155" r="19" fill="#ffffff" stroke="#d97706"/>
  <text x="560" y="159" text-anchor="middle" fill="#1e293b" font-size="9">az-a</text>
  <circle cx="625" cy="155" r="19" fill="#ffffff" stroke="#d97706"/>
  <text x="625" y="159" text-anchor="middle" fill="#1e293b" font-size="9">az-b</text>
  <circle cx="690" cy="155" r="19" fill="#ffffff" stroke="#d97706"/>
  <text x="690" y="159" text-anchor="middle" fill="#1e293b" font-size="9">az-c</text>
  <text x="625" y="196" text-anchor="middle" fill="#16a34a" font-size="10" font-weight="700">LOCAL_QUORUM = 2</text>
  <rect x="536" y="206" width="178" height="28" rx="6" fill="#ffffff" stroke="#4f46e5"/>
  <text x="625" y="224" text-anchor="middle" fill="#1e293b" font-size="10">Priam sidecar per node</text>

  <line x1="250" y1="160" x2="264" y2="160" stroke="#94a3b8" stroke-width="2" stroke-dasharray="5 3"/>
  <line x1="495" y1="160" x2="509" y2="160" stroke="#94a3b8" stroke-width="2" stroke-dasharray="5 3"/>
  <text x="380" y="268" text-anchor="middle" fill="#1e293b" font-size="10">async cross-region replication: writes never block on WAN latency</text>

  <rect x="180" y="282" width="180" height="46" rx="8" fill="#ffffff" stroke="#4f46e5"/>
  <text x="270" y="302" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">S3 snapshots + incrementals</text>
  <text x="270" y="318" text-anchor="middle" fill="#1e293b" font-size="10">restore tested, not assumed</text>
  <rect x="400" y="282" width="180" height="46" rx="8" fill="#ffffff" stroke="#16a34a"/>
  <text x="490" y="302" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">scheduled repair</text>
  <text x="490" y="318" text-anchor="middle" fill="#1e293b" font-size="10">cycle &lt; gc_grace_seconds</text>
</svg>
```

## 5. Implementation

Discord's schema, reconstructed from their published design, is the most instructive artefact in this chapter.

```cql
-- The bucket is the whole trick: a deterministic 10-day window derived from the
-- Snowflake id, so the client can compute which buckets to query without a lookup.
CREATE TABLE messages (
  channel_id  bigint,
  bucket      int,
  message_id  bigint,      -- Snowflake: (ms since epoch << 22) | worker | seq
  author_id   bigint,
  content     text,
  PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC)
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS','compaction_window_size':10};
```

```python
# Deriving the bucket from a Snowflake id. Paging back through history means
# walking buckets backwards - a bounded number of small partition reads instead
# of one enormous scan.
DISCORD_EPOCH = 1420070400000          # 2015-01-01 UTC in ms
BUCKET_SIZE_MS = 10 * 24 * 60 * 60 * 1000   # 10 days

def make_bucket(snowflake_id: int) -> int:
    ts_ms = (snowflake_id >> 22) + DISCORD_EPOCH
    return ts_ms // BUCKET_SIZE_MS

def buckets_between(start_id: int, end_id: int):
    return range(make_bucket(end_id), make_bucket(start_id) - 1, -1)

# Newest 50 messages: try the current bucket, fall back only if it is short.
rows = session.execute(
    "SELECT message_id, author_id, content FROM messages "
    "WHERE channel_id=%s AND bucket=%s LIMIT 50",
    (channel_id, make_bucket(now_snowflake())))
```

Netflix-style chunking, which is what lets a key-value abstraction store items far larger than a comfortable row:

```cql
CREATE TABLE kv.blobs (
  namespace   text,
  key         text,
  chunk_no    int,
  total_chunks int static,
  payload     blob,
  PRIMARY KEY ((namespace, key), chunk_no)
);
-- Writes are idempotent per chunk; a reader assembles chunk_no 0..total_chunks-1.
-- Bounded rows mean compaction and read latency stay predictable regardless of item size.
```

Request coalescing, the pattern Discord credits for taming hot partitions — here in Python with a single-flight map:

```python
import asyncio
_inflight: dict[tuple, asyncio.Future] = {}

async def get_messages(channel_id: int, bucket: int):
    key = (channel_id, bucket)
    fut = _inflight.get(key)
    if fut is not None:
        return await fut                      # join the existing query
    fut = asyncio.get_running_loop().create_future()
    _inflight[key] = fut
    try:
        rows = await session.execute_async(SELECT_STMT, key)
        fut.set_result(rows)
        return rows
    finally:
        _inflight.pop(key, None)
# 10,000 concurrent viewers of one channel produce ONE coordinator read.
```

Operational checks that every one of these teams runs continuously:

```bash
# Find the partitions that will hurt you, before they do.
nodetool tablehistograms discord messages | tail -4
# 95%     2.00     35.43 us    1131.75 us      1131752       2299
# 99%     3.00     51.01 us    2346.80 us     14237160      17084     <-- 14 MB partition
# Max     5.00    943.13 us   20924.30 us    386857368     943127     <-- 386 MB: fix this

# Repair age is an SLO. If this is close to gc_grace_seconds you are in danger.
nodetool repair_admin list
nodetool tablestats discord.messages | grep -E "Space used|SSTable count|Bloom filter false"

# Tombstone pressure per read
nodetool tablestats discord.messages | grep -i tombstone
# Average tombstones per slice (last five minutes): 1.0
# Maximum tombstones per slice (last five minutes): 12457     <-- warn threshold is 1000
```

**Optimization note.** The highest-leverage change any of these teams made was *not* a Cassandra tuning parameter. Netflix's leverage came from the abstraction layer (applications physically cannot write a pathological partition); Discord's came from coalescing plus bucketing (the database sees a fraction of the offered load); Uber's came from automation (operations that used to be a human incident became a reconciliation loop). Tune the JVM after you have done those, not before.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| **Data abstraction layer** (Netflix) | Applications cannot create bad partitions; storage engine becomes swappable; consistency policy is centrally enforced | A service to build, staff and keep off the critical path; adds a network hop and its own failure domain |
| **Request coalescing** (Discord) | Turns celebrity keys from an outage into a non-event; huge read amplification savings | Only helps reads of the *same* key; adds latency for the joiners; needs careful cancellation and timeout semantics |
| **Time bucketing** | Bounded partitions, TWCS can drop whole windows, predictable compaction | Range queries may span buckets; picking the window size wrong means either giant or too many partitions |
| **Sidecar automation** (Priam) | Node replacement, backup and token management stop being human work | Another component to upgrade in lockstep with Cassandra; cloud-specific assumptions leak in |
| **Multi-region active-active** (Netflix) | Survives a full region loss; users served locally; evacuation is routine | 2–3× infrastructure cost; cross-region bandwidth bill; every consistency decision becomes a `LOCAL_*` decision |
| **Control plane over many clusters** (Uber) | Hundreds of clusters run by a small team; consistent policy; automated remediation | Significant platform investment before payoff; automation bugs now have blast radius across the fleet |
| **Custom storage engine** (Instagram's Rocksandra) | Order-of-magnitude tail-latency win on their workload | You now maintain a fork against upstream; almost never the right call unless you employ committers |
| **Staying on Cassandra vs switching** (Discord) | Cassandra is Apache-licensed, portable, and multi-DC native | If your pain is GC and compaction interference rather than modelling, another engine may genuinely be 3–5× better on P99 |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Letting applications write raw CQL at scale.** → ✅ Put an abstraction layer or at minimum a shared client library in front, owning schema, consistency level, page size and retry policy. Every organisation in this chapter converged on this independently.
2. ⚠️ **Designing a partition key with no natural bound** (`channel_id`, `user_id`, `device_id` alone). → ✅ Add a time or hash bucket up front. Retrofitting a bucket after you have trillions of rows is a full migration, as chapter 46 describes.
3. ⚠️ **Treating repair as something you do when there is a problem.** → ✅ Schedule it, alert on *repair age* per table, and keep the full cycle comfortably under `gc_grace_seconds` (864000s default). Repair debt is how deleted data comes back.
4. ⚠️ **Load testing with uniform random keys.** → ✅ Replay a real Zipfian distribution. Hot partitions are invisible under uniform load and are the number-one production surprise.
5. ⚠️ **Using `QUORUM` instead of `LOCAL_QUORUM` in a multi-region cluster.** → ✅ `QUORUM` across two 3-replica DCs needs 4 acks and will cross the WAN on every write. Use `LOCAL_QUORUM` and let asynchronous replication do the rest.
6. ⚠️ **Backups that have never been restored.** → ✅ Restore into a scratch cluster on a schedule and verify row counts. Netflix's Priam-to-S3 pipeline is only valuable because the restore path is exercised.
7. ⚠️ **Bootstrapping or decommissioning nodes during peak traffic.** → ✅ Streaming competes with user traffic for disk and network. Schedule capacity changes off-peak and throttle with `nodetool setstreamthroughput`.
8. ⚠️ **Modelling a queue or a work log in Cassandra.** → ✅ Read-then-delete-then-read is the tombstone anti-pattern in its purest form. Use Kafka or a real queue; Cassandra can hold the results, not the queue.
9. ⚠️ **Ignoring GC pause distribution because average latency looks fine.** → ✅ Alert on pause duration, not just frequency; a pause longer than the failure detector's threshold triggers false node-down and cascading load.
10. ⚠️ **Assuming the published node counts mean you need that scale of practice.** → ✅ The *practices* transfer down; the *numbers* do not. A 12-node cluster still needs bounded partitions, scheduled repair and a tested restore.
11. ⚠️ **Fixing tail latency by adding nodes.** → ✅ Adding nodes fixes throughput and storage, not a hot key or a bad compaction strategy. Diagnose `SSTablesPerReadHistogram` and `TombstoneScannedHistogram` first.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The three commands that resolve most incidents in these environments, in order: `nodetool tablehistograms <ks> <tbl>` (partition size max and SSTables-per-read at P99 — this finds hot and oversized partitions), `nodetool compactionstats` (a pending-task count that grows monotonically for hours is your latency), and `nodetool tpstats` (dropped `MUTATION` messages and blocked `Native-Transport-Requests` mean the node is beyond capacity). Cassandra 4.0's virtual tables make this queryable from `cqlsh`: `SELECT * FROM system_views.local_read_latency;` and `system_views.tombstones_scanned`. Full Query Logging (`nodetool enablefullquerylog`) captures the exact statements behind an incident.

**Monitoring.** The JMX beans that constitute a real Cassandra SLO dashboard: `org.apache.cassandra.metrics:type=ClientRequest,scope=Read|Write,name=Latency` (P99/P999 per DC), `type=ClientRequest,name=Unavailables` and `name=Timeouts`, `type=Table,name=SSTablesPerReadHistogram`, `type=Table,name=TombstoneScannedHistogram`, `type=Table,name=MaxPartitionSize`, `type=Compaction,name=PendingTasks`, `type=DroppedMessage,scope=MUTATION,name=Dropped`, `type=Storage,name=Load`, plus JVM `GarbageCollector` pause metrics and `type=HintsService`. Alert on *repair age per table* — it is not a built-in metric, so emit it from your repair scheduler.

**Security.** At this scale, security is mostly about blast radius. Use internode and client TLS everywhere (`server_encryption_options` / `client_encryption_options`), role-based auth with per-keyspace grants so one compromised service cannot read another's data, `audit_logging_options` (Cassandra 4.0+) shipped off-box, and network isolation so only the abstraction layer can reach port 9042. Cassandra 5.0's dynamic data masking helps for support tooling. Encryption at rest in open-source Cassandra means disk-level encryption (LUKS or cloud-managed volume keys) — plan it, because the SSTables are plain files.

**Performance & Scaling.** Netflix's numbers demonstrated linear scale-out; the caveat is that linearity applies to *throughput across many partitions*, never to one hot key. Practical scaling rules from these fleets: keep nodes in the 1–4 TB range so bootstrap and repair stay tractable (Cassandra 4.0's zero-copy streaming raised that ceiling substantially); provision each region to absorb the traffic of a failed peer region if you claim regional resilience; keep `num_tokens` at the 4.x default of 16 rather than the legacy 256 to reduce repair and streaming overhead; and add capacity *before* disk utilisation passes roughly 50–60%, because size-tiered compaction can transiently need space equal to the table it is compacting.

## 9. Interview Questions

**Q: Why did Discord bucket their messages table, and how did they choose the bucket size?**
A: A channel is unbounded — a busy one accumulates tens of millions of messages — and Cassandra partitions should stay under about 100 MB and 100k rows. They added a static 10-day time bucket to the partition key, derived deterministically from the Snowflake message id so clients compute it without a lookup. Ten days balanced partition size against how many buckets a scroll-back has to touch.

**Q: What is request coalescing and why does it matter for Cassandra specifically?**
A: It merges concurrent identical reads for the same key into a single database query, then fans the result back out. It matters because a Cassandra partition is served by exactly `RF` replicas, so a celebrity key saturates three machines no matter how large the cluster is. Coalescing is one of the very few techniques that reduces load on a hot partition without changing the data model.

**Q: What does Netflix's Priam do, and why would you want a sidecar at all?**
A: Priam automates token assignment, node replacement, and full plus incremental backups to S3, and exposes health and metrics endpoints. You want a sidecar because at fleet scale the manual procedures — replace a dead node, restore a snapshot, rotate a cluster — are exactly the operations that are error-prone under stress, and they need to be code.

**Q: Why is a data abstraction layer the pattern every large Cassandra shop converges on?**
A: Because it moves the modelling constraints from documentation into the API. Applications get a key-value or time-series interface that cannot express an unbounded partition, an unpaginated scan or a wrong consistency level, and the platform team gains the freedom to change schema, chunking or even the storage engine without touching application code.

**Q: What caused Discord's Cassandra pain, and did migrating fix the data model?**
A: The pain was hot partitions, tombstone-heavy reads from deletions, JVM garbage-collection pauses and compaction that struggled to keep up — engine and workload interaction, not schema error. Migrating to ScyllaDB kept the identical data model and partition key; what changed was the runtime. That is the key nuance: the migration fixed engine problems, and the coalescing layer fixed the workload problem.

**Q: How do these companies avoid resurrected deletes?**
A: By treating repair as a scheduled SLO rather than an incident response. Every table must complete a repair cycle within `gc_grace_seconds` (default 864000 seconds, ten days), because tombstones are purged after that window and any replica that missed the delete will otherwise re-propagate the old value. They alert on repair *age* per table, not just repair failures.

**Q: What was Rocksandra and what should you learn from it?**
A: Instagram replaced Cassandra's storage engine with RocksDB through the pluggable storage-engine interface, attacking garbage-collection-driven tail latency and achieving roughly an order-of-magnitude P99 read improvement on their workload. The lesson is not "fork Cassandra" — it is that at extreme scale the JVM heap is often the binding constraint on the tail, which is exactly why shard-per-core alternatives became attractive.

**Q: (Senior) You inherit a 200-node cluster with no repair automation and 400 MB partitions. Sequence your first 90 days.**
A: Week 1: stop the bleeding — add coalescing/caching in front of the hottest keys, raise timeouts, and get `tablehistograms`, GC pause and compaction backlog on a dashboard. Weeks 2–4: get repair running incrementally per table with age alerting, and verify a restore from backup into a scratch cluster. Weeks 5–8: design the bucketed schema for the offending tables and stand up dual writes. Weeks 9–12: backfill with `USING TIMESTAMP` from the source events, shadow-read to validate, then cut over. Do not touch JVM flags until repair and partition bounds are fixed — they are almost never the root cause.

**Q: (Senior) Netflix serves multiple regions active-active. What breaks if you use `QUORUM` rather than `LOCAL_QUORUM`?**
A: With `RF=3` in each of two DCs, global `RF` is 6 and `QUORUM` is 4, so every write must be acknowledged across the WAN — you have converted a 2 ms operation into a 70 ms one and made a regional partition fatal to writes. `LOCAL_QUORUM` keeps `R + W > RF` *within* the local DC, giving read-your-writes locally while cross-region convergence happens asynchronously via replication, hints and repair.

**Q: (Senior) How would you design capacity so that "we survive a region failure" is actually true?**
A: Provision each region to carry its own steady-state traffic plus the redistributed share of the largest peer region at peak, not at average — meaning roughly 1.5× headroom in a three-region setup. Then verify it: run scheduled evacuation exercises that drain a region for real, watch P99 and `Unavailables` in the survivors, and confirm the drained region reconciles via hints and repair within `gc_grace_seconds`. Claimed resilience that has never been exercised is not resilience.

**Q: (Senior) Uber runs hundreds of Cassandra clusters. What changes at that number of clusters versus one big one?**
A: Per-cluster human effort must go to approximately zero, so everything becomes declarative: provisioning, version upgrades, repair scheduling, node replacement and remediation run as reconciliation loops over desired state. You also gain isolation benefits — a bad tenant cannot destroy an unrelated service — but you pay in fleet-wide automation risk, since a bug in the control plane now has blast radius across every cluster. Canary the automation the way you canary code.

**Q: What is the single most transferable lesson from these case studies for a 15-node cluster?**
A: Bound your partitions and schedule your repair. Every dramatic incident in the public record traces back to one of those two, and both are free at small scale and enormously expensive to retrofit later. The abstraction layers and control planes are scale-dependent; those two are not.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Netflix proved linear scale (about 1.1 M writes/sec on ~288 EC2 nodes in 2011) and built the reference operational stack: Priam sidecar for tokens/backups/replacement, multi-region `NetworkTopologyStrategy` with `LOCAL_QUORUM`, rehearsed regional evacuation, and data abstraction layers so applications never touch raw CQL. Apple runs the largest known fleet — publicly described as hundreds of thousands of nodes across thousands of clusters — and drove much of Cassandra 4.0's correctness and zero-copy streaming work. Discord bucketed messages by `(channel_id, 10-day bucket)` with Snowflake clustering, hit hot partitions, tombstones and GC pauses, added a Rust data-services layer that coalesces duplicate reads, and eventually moved the same model from 177 Cassandra nodes to 72 ScyllaDB nodes. Uber's lesson is automation: hundreds of clusters demand a declarative control plane. Instagram's Rocksandra shows the JVM heap is often the tail-latency ceiling. Universal rules: bound partitions, schedule repair within `gc_grace_seconds`, test restores, load-test with Zipfian keys, and put a service in front of the database.

| Organisation | Public scale signal | Signature technique | Transferable lesson |
|---|---|---|---|
| Netflix | ~1.1 M writes/sec benchmark; multi-region AWS | Priam sidecar + data abstraction layers | Automate backup/replacement; hide CQL behind an API |
| Apple | Hundreds of thousands of nodes, thousands of clusters | Upstream investment: 4.0 testing, zero-copy streaming | Fleet scale demands correctness engineering |
| Discord | Trillions of messages; 177 C* → 72 Scylla nodes | 10-day bucketing + Rust request coalescing | Bound partitions; coalesce celebrity keys |
| Uber | Thousands of nodes, hundreds of clusters | Declarative control plane over stateful platform | Past ~10 clusters, runbooks must become code |
| Instagram | Order-of-magnitude P99 read improvement | Rocksandra (RocksDB storage engine) | The JVM heap is often the tail-latency ceiling |

**Flash cards**
- **Discord's partition key** → `((channel_id, bucket), message_id DESC)` with a 10-day bucket derived from the Snowflake id.
- **Why coalescing works** → a partition is served by exactly `RF` replicas, so N duplicate reads become one query and the hot key stops saturating three nodes.
- **Repair SLO** → every table must finish a repair cycle inside `gc_grace_seconds` (864000s) or deletes can resurrect.
- **Multi-region rule** → always `LOCAL_QUORUM`; `QUORUM` across DCs puts the WAN on your write path.
- **The universal first fix** → bound the partition. Node counts, JVM flags and engine swaps come after.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement Discord's `make_bucket` from Snowflake ids and prove that a 10-day bucket keeps a 500 msg/day channel under 100k rows for years, while a 5,000 msg/second channel does not — then compute the bucket size that would.
- [ ] Build the single-flight coalescing wrapper above, point 5,000 concurrent readers at one partition, and measure coordinator read count with and without it via `nodetool tablestats`.
- [ ] Create a table, insert 200k rows, delete 150k, and watch `TombstoneScannedHistogram` and query latency; then run `nodetool garbagecollect` after lowering `gc_grace_seconds` and re-measure.
- [ ] Stand up a two-DC cluster with ccm or Docker, run a write loop at `QUORUM`, then switch to `LOCAL_QUORUM` and compare P99 with one DC's network artificially delayed by 70 ms (`tc qdisc`).
- [ ] Take a Priam-style snapshot (`nodetool snapshot`), destroy a node, and restore it — timing the whole procedure and writing the runbook you would want at 3 a.m.

**Mini Project — A Production-Grade Message Store**
*Goal:* build a small but genuinely operable messaging backend that embodies the practices in this chapter.
*Requirements:* (1) implement the bucketed `messages` schema with TWCS and Snowflake ids; (2) put a service layer in front that exposes only `append(channel, msg)` and `page(channel, before_id, limit)` — no raw CQL escapes; (3) add single-flight coalescing and a per-key rate limiter; (4) emit `SSTablesPerRead`, `TombstoneScanned`, `MaxPartitionSize`, compaction backlog and repair age to Prometheus with alert rules; (5) write and *execute* a runbook for node replacement and snapshot restore.
*Extensions:* add a second DC and demonstrate `LOCAL_QUORUM` read-your-writes plus asynchronous convergence; introduce a synthetic celebrity channel at 50k reads/sec and show coalescing flattening the replica load; add message deletion and prove your repair schedule prevents resurrection by deliberately delaying repair past `gc_grace_seconds` in a scratch cluster.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Query-First Data Modelling* (why bucketing exists), *Compaction Strategies* (TWCS and the window-drop optimisation Discord relies on), *Repair, Hinted Handoff & Anti-Entropy* (the `gc_grace_seconds` contract), *Multi-DC Replication & Snitches* (`LOCAL_QUORUM` and region evacuation), *Cassandra vs ScyllaDB, DynamoDB & HBase* (the engine comparison behind Discord's move), *Cassandra System Design (Interview)*, and *Migration & Real-World Challenges*.

**Free Learning Resources**
- **How Discord Stores Billions of Messages** — Discord Engineering · *Intermediate* · the original MongoDB-to-Cassandra write-up with the bucketing scheme and the tombstone problems in their own words. <https://discord.com/blog/how-discord-stores-billions-of-messages>
- **How Discord Stores Trillions of Messages** — Discord Engineering · *Intermediate–Advanced* · node counts, latency numbers, the Rust data-services coalescing layer and the super-disk design. <https://discord.com/blog/how-discord-stores-trillions-of-messages>
- **Introducing Netflix's Key-Value Data Abstraction Layer** — Netflix Technology Blog · *Advanced* · exactly how a data abstraction layer over Cassandra is designed, including chunking and idempotency. <https://netflixtechblog.com/introducing-netflixs-key-value-data-abstraction-layer-1ea8a0a11b30>
- **Introducing Netflix's TimeSeries Data Abstraction Layer** — Netflix Technology Blog · *Advanced* · time-series bucketing, retention and fan-out patterns at Netflix scale. <https://netflixtechblog.com/introducing-netflix-timeseries-data-abstraction-layer-31552f6326f8>
- **Netflix Priam** — Netflix OSS (GitHub) · *Intermediate* · the sidecar itself: token management, S3 backup/restore, automated node replacement. <https://github.com/Netflix/Priam>
- **Open-sourcing a 10x reduction in Apache Cassandra tail latency** — Instagram Engineering · *Advanced* · the Rocksandra story and a clear explanation of why GC dominates the tail. <https://instagram-engineering.com/open-sourcing-a-10x-reduction-in-apache-cassandra-tail-latency-d64f86b43589>
- **Uber Engineering Blog — data infrastructure** — Uber · *Intermediate–Advanced* · how Uber automates operation of very large numbers of stateful clusters. <https://www.uber.com/en-US/blog/engineering/data/>
- **Apache Cassandra — Operating documentation** — Apache Software Foundation · *Intermediate* · repair, compaction, backup and hardware guidance that all of the above are applications of. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/index.html>
- **Cassandra Summit / ApacheCon talks** — Apache Cassandra (YouTube) · *All levels* · Apple, Netflix and Bloomberg engineers presenting fleet numbers and incident postmortems directly. <https://www.youtube.com/@PlanetCassandra>

---

*Apache Cassandra Handbook — chapter 44.*
