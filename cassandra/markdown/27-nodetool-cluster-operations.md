# 27 · nodetool & Everyday Cluster Operations

> **In one line:** `nodetool` is the JMX-backed command line that every Cassandra operator lives in — and knowing what `status`, `info`, `tpstats`, `tablestats`, `flush`, `drain` and `cleanup` actually tell you is the difference between running a cluster and guessing at one.

---

## 1. Overview

Cassandra ships no admin GUI. The entire operational surface — cluster membership, per-node health, thread-pool pressure, compaction state, streaming progress, cache hit rates, repair control, snapshot management — is exposed as **JMX MBeans**, and `nodetool` is the thin CLI wrapper over them. When something is wrong at 3 a.m., `nodetool` is what you have. It is not a convenience; it is the operational API.

The problem it solves is observability into a shared-nothing, masterless system. There is no coordinator node you can ask "how is the cluster?" — every node has its own view built from gossip, and each node's local state (its SSTables, its thread pools, its heap) is only visible from that node. So `nodetool` is deliberately **node-local by default**: `nodetool status` shows *this node's gossip view* of the ring, `nodetool tablestats` shows *this node's* SSTables. Two nodes disagreeing about `nodetool status` is itself a diagnosis — it means gossip has not converged, which is a genuine problem.

Historically `nodetool` predates the CQL era; it grew organically, which is why the command set is uneven (some commands take a keyspace, some take `keyspace.table`, some take `keyspace table` space-separated). Cassandra 4.0 added a parallel path: **virtual tables** in the `system_views` and `system_virtual_schema` keyspaces let you query much of the same JMX data over CQL from `cqlsh` — `SELECT * FROM system_views.sstable_tasks;` is `nodetool compactionstats` in CQL form. That matters because it works over the native protocol, so it traverses the same auth and TLS path your applications do, and it can be scraped without opening JMX.

Concretely, the everyday shape of the job: at Uber-scale, a fleet of hundreds of Cassandra nodes, an SRE's morning check is `nodetool status` on one node per DC (are all nodes `UN`? is ownership balanced?), `nodetool tpstats` for dropped messages and blocked flush writers, `nodetool compactionstats` for a compaction backlog, and `nodetool tablestats` on the top few tables for partition-size and SSTables-per-read regressions. Before any restart, `nodetool drain`. After any topology change, `nodetool cleanup`. Those seven commands cover 90% of operational days.

## 2. Core Concepts

- **JMX** — Java Management Extensions; Cassandra exposes MBeans on port **7199** by default. `nodetool` connects to it. `jmx_port`, and in 4.x `LOCAL_JMX=yes` in `cassandra-env.sh`, binds it to localhost only.
- **Node state (`UN`, `DN`, `UJ`, `UL`, `UM`)** — first letter is Up/Down (gossip liveness), second is the operational state: **N**ormal, **J**oining (bootstrapping), **L**eaving (decommissioning), **M**oving (token move).
- **Owns %** — the fraction of the token ring this node is responsible for. With `NetworkTopologyStrategy` and a keyspace argument it becomes *effective* ownership including replication (so with `RF=3`, three nodes each "own" the same data).
- **Load** — bytes of live data on this node (`Space used (live)`), not including snapshots. Growing much faster than peers means an imbalanced token distribution or a hot partition.
- **Thread pool (stage)** — Cassandra's SEDA-style executors: `MutationStage`, `ReadStage`, `CompactionExecutor`, `MemtableFlushWriter`, `GossipStage`, etc. `nodetool tpstats` shows active/pending/blocked/dropped per stage.
- **Dropped messages** — mutations or reads that exceeded their timeout while queued and were discarded. Non-zero dropped `MUTATION` means writes were silently lost on that node (repair will fix them; hints may not).
- **Flush** — force memtables to disk as SSTables. **Drain** — flush *and* stop accepting writes; the correct pre-shutdown step.
- **Cleanup** — remove data this node no longer owns after a topology change. Never automatic; always operator-initiated.
- **Snapshot** — a set of hard links to the current SSTables under `snapshots/<tag>/`. Instant and space-free at creation; consumes real space as the originals get compacted away.
- **Virtual tables (4.0+)** — read-only CQL views of internal state: `system_views.clients`, `system_views.sstable_tasks`, `system_views.thread_pools`, `system_views.disk_usage`, `system_views.settings`.

## 3. Theory & Internals

**How `nodetool` actually works.** It is a Java process that opens an RMI/JMX connection to `service:jmx:rmi:///jndi/rmi://<host>:7199/jmxrmi`, looks up an MBean such as `org.apache.cassandra.db:type=StorageService`, and invokes a method. `nodetool status` calls `StorageServiceMBean.getLiveNodes()`, `getUnreachableNodes()`, `getLoadMap()`, `getTokens()` and `effectiveOwnership()`. This has two consequences you must internalise: (1) every `nodetool` invocation pays JVM startup (~1 s) plus a JMX handshake, so tight polling loops are expensive; (2) **the data is that node's local view**, assembled from gossip for cluster-wide facts and from local state for everything else.

**Why gossip means `status` can lie.** Gossip converges in `O(log N)` rounds at one round per second, so a node that just died can show `UN` for up to ~10 s, and a node with a broken gossip generation can show `DN` on one peer and `UN` on another. The failure detector is a **Phi Accrual** detector: it tracks the inter-arrival distribution of gossip heartbeats and computes a suspicion level φ; when φ exceeds `phi_convict_threshold` (default 8) the node is marked DOWN. On cloud networks with jittery latency, φ crosses 8 spuriously — which is why the standard advice for AWS is to leave it at 8 unless you see flapping, then raise to 10–12 (never higher; you delay real failure detection).

**Ownership math.** With `num_tokens: 16` (the 4.x default; 4.0+ also ships `allocate_tokens_for_local_replication_factor` to make token allocation replication-aware), each node holds 16 vnodes scattered around the 2^64 Murmur3 token range. Ownership variance with random token assignment is roughly `1/sqrt(num_tokens)` — 16 vnodes gives about ±25% spread, which is why 4.x pairs 16 tokens with the allocation algorithm rather than the old 256-token random scheme. `nodetool status <keyspace>` gives **effective** ownership: `sum(owns) = RF × 100%`.

**`tpstats` semantics.** Each stage has a bounded queue. `Active` = threads currently executing, `Pending` = queued, `Blocked` = submissions that hit the queue limit and blocked the caller, `All time blocked` = cumulative. The two you page on: **`MutationStage` pending climbing** (the node cannot absorb writes — usually disk or GC), and **`MemtableFlushWriter` all-time-blocked non-zero** (flushes cannot keep up, which back-pressures writes). Dropped counts are separate and worse: a dropped `MUTATION` is an acknowledged-at-the-coordinator write that this replica never applied.

```svg
<svg viewBox="0 0 820 390" width="100%" height="390" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a27a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="410" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">nodetool over JMX: local state plus gossip view</text>

  <rect x="30" y="45" width="150" height="52" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="105" y="68" text-anchor="middle" fill="#1e293b" font-weight="700">nodetool CLI</text>
  <text x="105" y="85" text-anchor="middle" fill="#64748b" font-size="10">JVM + RMI client</text>

  <rect x="245" y="45" width="170" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="330" y="68" text-anchor="middle" fill="#1e293b" font-weight="700">JMX port 7199</text>
  <text x="330" y="85" text-anchor="middle" fill="#64748b" font-size="10">LOCAL_JMX=yes by default</text>

  <line x1="180" y1="70" x2="240" y2="70" stroke="#475569" marker-end="url(#a27a)"/>
  <line x1="415" y1="70" x2="470" y2="70" stroke="#475569" marker-end="url(#a27a)"/>

  <rect x="475" y="35" width="315" height="230" rx="10" fill="#f8fafc" stroke="#475569"/>
  <text x="632" y="57" text-anchor="middle" fill="#1e293b" font-weight="700">Cassandra node MBeans</text>

  <rect x="495" y="70" width="275" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="632" y="92" text-anchor="middle" fill="#1e293b" font-size="11">StorageService: status, info, drain, cleanup</text>
  <rect x="495" y="112" width="275" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="632" y="134" text-anchor="middle" fill="#1e293b" font-size="11">ColumnFamilyStore: tablestats, flush</text>
  <rect x="495" y="154" width="275" height="34" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="632" y="176" text-anchor="middle" fill="#1e293b" font-size="11">CompactionManager: compactionstats</text>
  <rect x="495" y="196" width="275" height="34" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="632" y="218" text-anchor="middle" fill="#1e293b" font-size="11">Metrics: tpstats, proxyhistograms</text>
  <rect x="495" y="234" width="275" height="24" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="632" y="251" text-anchor="middle" fill="#1e293b" font-size="11">FailureDetector, Gossiper, StreamManager</text>

  <rect x="30" y="290" width="360" height="85" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="210" y="312" text-anchor="middle" fill="#1e293b" font-weight="700">Local truth</text>
  <text x="210" y="331" text-anchor="middle" fill="#1e293b" font-size="11">SSTables, thread pools, heap, caches</text>
  <text x="210" y="349" text-anchor="middle" fill="#1e293b" font-size="11">compaction and streaming progress</text>
  <text x="210" y="367" text-anchor="middle" fill="#64748b" font-size="10">exact for this node only</text>

  <rect x="420" y="290" width="370" height="85" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="605" y="312" text-anchor="middle" fill="#1e293b" font-weight="700">Gossip derived truth</text>
  <text x="605" y="331" text-anchor="middle" fill="#1e293b" font-size="11">UN / DN / UJ / UL, tokens, schema version</text>
  <text x="605" y="349" text-anchor="middle" fill="#1e293b" font-size="11">converges in O(log N) rounds, 1 per second</text>
  <text x="605" y="367" text-anchor="middle" fill="#b45309" font-size="10">two nodes may disagree briefly</text>
</svg>
```

## 4. Architecture & Workflow

**The daily health sweep, in order.**

1. `nodetool status` on one node per DC. Confirm every node is `UN`, no `DN`/`UJ`/`UL` surprises, and `Owns` is within a few percent across same-sized nodes.
2. `nodetool describecluster`. Confirm a **single schema version**. Multiple versions means a schema disagreement — resolve before doing anything else.
3. `nodetool info` on suspicious nodes. Check heap used vs max, off-heap memory, key cache hit rate, uptime (an unexpectedly low uptime is a crash you missed).
4. `nodetool tpstats`. Look for non-zero `Blocked`/`All time blocked` on `MemtableFlushWriter` and `MutationStage`, and any non-zero **dropped** counts at the bottom.
5. `nodetool compactionstats`. Pending compactions sustained above ~20 means compaction is losing to ingest.
6. `nodetool tablestats <ks>` (or `<ks>.<tbl>`). Watch SSTable count, compression ratio, bloom filter false ratio, and **max partition size**.
7. `nodetool tablehistograms <ks> <tbl>` on the hot tables. SSTables-per-read p99 and partition-size p99 are your data-model regression alarms.
8. `nodetool proxyhistograms` for coordinator-side client latency percentiles — this is what your application sees, unlike `tablehistograms` which is local storage latency.

**Safe restart of a single node.**

1. Announce/disable traffic if you have an application-level drain. Otherwise the driver's load balancing will route around a down node automatically.
2. `nodetool disablebinary` — stop accepting new CQL client connections on port 9042.
3. `nodetool disablegossip` *only if* you intend the cluster to see it as down promptly (this also stops it acting as a replica; skip if you want minimum disruption).
4. `nodetool drain` — flushes all memtables, stops accepting writes, and makes commit-log replay on restart a no-op.
5. `systemctl stop cassandra`. Do the maintenance.
6. `systemctl start cassandra`; tail `system.log` for `Starting listening for CQL clients`.
7. `nodetool status` from a *peer* node to confirm it shows `UN` there, not just locally.

**After a topology change (added or removed a node).**

1. Wait for the bootstrap/decommission to fully finish (`nodetool netstats` shows no active streams; `nodetool status` shows all `UN`).
2. Run `nodetool cleanup <keyspace>` on **every node that was not itself added**, one at a time. Cleanup rewrites SSTables dropping rows this node no longer owns — it is a full compaction-cost operation, so serialise it.
3. Verify with `nodetool status` that `Load` has dropped on the nodes that gave up ranges.
4. Re-check `nodetool tablestats` disk usage against your headroom.

```svg
<svg viewBox="0 0 820 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a27b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="410" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Safe Node Restart and Post Topology Cleanup</text>

  <rect x="25" y="45" width="130" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="90" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">disablebinary</text>
  <text x="90" y="82" text-anchor="middle" fill="#64748b" font-size="10">no new CQL clients</text>

  <rect x="185" y="45" width="130" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="250" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">disablegossip</text>
  <text x="250" y="82" text-anchor="middle" fill="#64748b" font-size="10">optional, marks DOWN</text>

  <rect x="345" y="45" width="130" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="410" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">drain</text>
  <text x="410" y="82" text-anchor="middle" fill="#64748b" font-size="10">flush + refuse writes</text>

  <rect x="505" y="45" width="130" height="46" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="570" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">stop service</text>
  <text x="570" y="82" text-anchor="middle" fill="#64748b" font-size="10">never kill -9</text>

  <rect x="665" y="45" width="130" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="730" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">start + verify</text>
  <text x="730" y="82" text-anchor="middle" fill="#64748b" font-size="10">UN on a peer</text>

  <line x1="155" y1="68" x2="182" y2="68" stroke="#475569" marker-end="url(#a27b)"/>
  <line x1="315" y1="68" x2="342" y2="68" stroke="#475569" marker-end="url(#a27b)"/>
  <line x1="475" y1="68" x2="502" y2="68" stroke="#475569" marker-end="url(#a27b)"/>
  <line x1="635" y1="68" x2="662" y2="68" stroke="#475569" marker-end="url(#a27b)"/>

  <line x1="25" y1="115" x2="795" y2="115" stroke="#cbd5e1"/>

  <text x="410" y="142" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="700">Ring before and after adding node 4</text>

  <circle cx="200" cy="255" r="80" fill="none" stroke="#4f46e5" stroke-width="2"/>
  <circle cx="200" cy="175" r="12" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="200" y="160" text-anchor="middle" fill="#1e293b" font-size="10">n1</text>
  <circle cx="269" cy="295" r="12" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="295" y="300" text-anchor="middle" fill="#1e293b" font-size="10">n2</text>
  <circle cx="131" cy="295" r="12" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="105" y="300" text-anchor="middle" fill="#1e293b" font-size="10">n3</text>
  <text x="200" y="260" text-anchor="middle" fill="#1e293b" font-size="11">3 nodes</text>
  <text x="200" y="277" text-anchor="middle" fill="#64748b" font-size="10">33% each</text>
  <text x="200" y="360" text-anchor="middle" fill="#1e293b" font-weight="700">before</text>

  <line x1="310" y1="255" x2="380" y2="255" stroke="#16a34a" stroke-width="2" marker-end="url(#a27b)"/>
  <text x="345" y="245" text-anchor="middle" fill="#15803d" font-size="10">bootstrap</text>

  <circle cx="500" cy="255" r="80" fill="none" stroke="#4f46e5" stroke-width="2"/>
  <circle cx="500" cy="175" r="12" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="500" y="160" text-anchor="middle" fill="#1e293b" font-size="10">n1</text>
  <circle cx="580" cy="255" r="12" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="606" y="259" text-anchor="middle" fill="#1e293b" font-size="10">n2</text>
  <circle cx="500" cy="335" r="12" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="500" y="356" text-anchor="middle" fill="#1e293b" font-size="10">n3</text>
  <circle cx="420" cy="255" r="12" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="392" y="259" text-anchor="middle" fill="#1e293b" font-size="10">n4</text>
  <text x="500" y="260" text-anchor="middle" fill="#1e293b" font-size="11">4 nodes</text>
  <text x="500" y="277" text-anchor="middle" fill="#64748b" font-size="10">25% each</text>

  <rect x="620" y="200" width="175" height="110" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="707" y="222" text-anchor="middle" fill="#1e293b" font-weight="700">then on n1, n2, n3</text>
  <text x="707" y="243" text-anchor="middle" fill="#1e293b" font-size="11">nodetool cleanup ks</text>
  <text x="707" y="263" text-anchor="middle" fill="#64748b" font-size="10">one node at a time</text>
  <text x="707" y="281" text-anchor="middle" fill="#64748b" font-size="10">rewrites SSTables,</text>
  <text x="707" y="297" text-anchor="middle" fill="#64748b" font-size="10">drops unowned ranges</text>
</svg>
```

## 5. Implementation

The commands, with realistic output.

```bash
nodetool status shop
# Datacenter: dc1
# ===============
# Status=Up/Down
# |/ State=Normal/Leaving/Joining/Moving
# --  Address     Load       Tokens  Owns (effective)  Host ID                               Rack
# UN  10.0.1.11   612.4 GiB  16      75.2%             3f2a9c1e-4b21-4f0a-9c33-1a2b3c4d5e6f  rack1
# UN  10.0.1.12   598.1 GiB  16      74.1%             8e7d6c5b-4a39-4218-8f77-9a8b7c6d5e4f  rack2
# UN  10.0.1.13   631.9 GiB  16      76.4%             c1b2a3d4-5e6f-4708-9a1b-2c3d4e5f6a7b  rack3
# UN  10.0.1.14   604.7 GiB  16      74.3%             d4c3b2a1-6f5e-4817-8b9a-3d2c1e0f9a8b  rack1
# (effective ownership sums to RF x 100% = 300%)

nodetool describecluster
# Cluster Information:
#   Name: prod-eu
#   Snitch: org.apache.cassandra.locator.GossipingPropertyFileSnitch
#   Partitioner: org.apache.cassandra.dht.Murmur3Partitioner
#   Schema versions:
#     4e2a5b17-9c3d-3f21-8a4e-1b2c3d4e5f60: [10.0.1.11, 10.0.1.12, 10.0.1.13, 10.0.1.14]
# One version listed = healthy. Two or more = schema disagreement, fix before proceeding.

nodetool info
# ID                     : 3f2a9c1e-4b21-4f0a-9c33-1a2b3c4d5e6f
# Gossip active          : true
# Native Transport active: true
# Load                   : 612.4 GiB
# Uptime (seconds)       : 1843922
# Heap Memory (MB)       : 14203.11 / 31744.00
# Off Heap Memory (MB)   : 4218.66
# Key Cache              : entries 1042118, size 512 MiB, capacity 512 MiB,
#                          9812331 hits, 10440021 requests, 0.940 recent hit rate
# Chunk Cache            : entries 131072, size 2 GiB, capacity 2 GiB, 0.881 recent hit rate
# Percent Repaired       : 91.4%
# Token                  : (invoke with -T/--tokens to see all 16 tokens)
```

```bash
nodetool tpstats
# Pool Name                         Active   Pending   Completed   Blocked  All time blocked
# ReadStage                              4         0  8812340221         0                 0
# CompactionExecutor                     2        14      412093         0                 0
# MutationStage                         12       118  4410238877         0                 0
# MemtableFlushWriter                    1         0       88121         0               412
# GossipStage                            0         0    19203344         0                 0
#
# Message type           Dropped
# MUTATION                  1183      <-- writes this replica never applied; repair needed
# READ_REPAIR                  0
# READ                        41
# RANGE_SLICE                  0
# HINT                         0

nodetool compactionstats
# pending tasks: 14
# - shop.orders: 9
# - shop.events: 5
# id                                   compaction type  keyspace  table   completed  total    unit  progress
# a1b2c3d4-...                         Compaction       shop      orders  4.11 GiB   9.82 GiB bytes 41.85%
# Active compaction remaining time :   0h12m41s

nodetool tablestats shop.orders
# Keyspace : shop
#   Table: orders
#   SSTable count: 18
#   Space used (live): 214748364800
#   Space used (total): 214748364800
#   Space used by snapshots (total): 41231908864
#   Compression ratio: 0.312
#   Number of partitions (estimate): 88213441
#   Local read count: 4412093881
#   Local read latency: 0.412 ms
#   Local write count: 8812340221
#   Local write latency: 0.021 ms
#   Bloom filter false positives: 4118
#   Bloom filter false ratio: 0.00009
#   Compacted partition maximum bytes: 88148
#   Average tombstones per slice (last five minutes): 1.0
#   Maximum tombstones per slice (last five minutes): 12

nodetool tablehistograms shop orders
# Percentile  SSTables  Write Latency  Read Latency  Partition Size  Cell Count
# 50%             2.00         20.50         98.00            1109          24
# 99%             4.00        105.78       1131.75           24601         535
# Max             8.00        943.13       9887.00           88148        1916

nodetool proxyhistograms
# Percentile   Read Latency   Write Latency   Range Latency  (micros)
# 50%                354.00           35.00          943.00
# 95%               1358.00          124.00         4768.00
# 99%               4768.00          310.00        14237.00
```

Maintenance commands:

```bash
nodetool flush shop orders            # memtables -> SSTables for one table
nodetool flush                        # all keyspaces
nodetool drain                        # flush + stop accepting writes (pre-shutdown)
nodetool cleanup shop                 # drop no-longer-owned ranges after topology change
nodetool garbagecollect shop orders   # single-SSTable compaction to purge tombstones (4.0+)
nodetool snapshot -t before-migration shop
nodetool listsnapshots
nodetool clearsnapshot -t before-migration shop

nodetool disablebinary && nodetool disablegossip     # take out of rotation
nodetool enablebinary && nodetool enablegossip       # put back

nodetool setcompactionthroughput 128   # MB/s, live change, no restart
nodetool getcompactionthroughput
nodetool setstreamthroughput 200       # Mbit/s
nodetool setlogginglevel org.apache.cassandra.db.ConsistencyLevel DEBUG

nodetool gcstats
#     Interval (ms) Max GC Elapsed (ms) Total GC Elapsed (ms) Stdev GC Elapsed (ms)  GC Reclaimed (MB)  Collections
#            301122                 214                  8821                  31.4       412093881221          1841

nodetool netstats -H
# Mode: NORMAL
# Not sending any streams.
# Read Repair Statistics:
# Attempted: 41209
# Mismatch (Blocking): 118
# Pool Name                    Active   Pending      Completed   Dropped
# Large messages                    0         0            412         0
# Small messages                    0         2     8812340221      1183
```

Virtual tables — the 4.0+ CQL alternative (works through the native protocol, respects auth/TLS):

```cql
SELECT keyspace_name, table_name, kind, progress, total, unit
  FROM system_views.sstable_tasks;

SELECT name, active_tasks, pending_tasks, blocked_tasks, total_blocked_tasks
  FROM system_views.thread_pools WHERE name = 'MutationStage';

SELECT * FROM system_views.disk_usage;
SELECT * FROM system_views.clients;
SELECT name, value FROM system_views.settings
  WHERE name IN ('compaction_throughput_mb_per_sec','concurrent_compactors');
```

Programmatic access from Python (avoid JVM startup per poll):

```python
from cassandra.cluster import Cluster

session = Cluster(["10.0.1.11"]).connect()

# Compaction backlog across the cluster, without shelling out to nodetool
rows = session.execute("SELECT keyspace_name, table_name, kind, progress, total "
                       "FROM system_views.sstable_tasks")
for r in rows:
    pct = 100.0 * r.progress / r.total if r.total else 0.0
    print(f"{r.keyspace_name}.{r.table_name} {r.kind} {pct:.1f}%")
# shop.orders compaction 41.9%
# shop.events compaction 8.2%
```

> **Optimization:** stop polling `nodetool` in monitoring loops. Each invocation costs ~1 s of JVM startup plus a JMX handshake, and a 60-node fleet polled every 10 s means a permanent JVM-launch tax. Use **Jolokia** or the **Cassandra Prometheus JMX exporter** as an agent inside the Cassandra JVM (`-javaagent:jmx_prometheus_javaagent.jar`) to scrape MBeans directly, and use **virtual tables** over CQL for anything a driver connection can reach. Reserve `nodetool` for interactive diagnosis and for the mutating commands (`flush`, `drain`, `cleanup`, `repair`) where a one-second startup is irrelevant.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| JMX-backed CLI | Complete access to internal state; no extra service to run | JVM startup per call (~1 s); JMX is awkward to secure and firewall |
| Node-local view | Precise, unaggregated truth about *this* node | You must run it per node and reconcile yourself; no cluster-wide command |
| `status` from gossip | Instantly shows membership and ownership | Can lag reality by seconds; nodes can disagree during partitions |
| `tpstats` | Direct visibility into every internal stage and dropped messages | Counters are since-startup; you need deltas, not absolutes, to reason |
| `flush` / `drain` | Deterministic control over memtable durability and shutdown safety | `drain` makes the node unavailable for writes — never run it casually |
| `cleanup` | Reclaims disk after topology changes | Full-cost rewrite of every SSTable; must be serialised across nodes |
| `compact` (major) | Collapses everything into one SSTable, purging all tombstones now | With STCS the giant output never compacts again; prefer `garbagecollect` |
| Virtual tables (4.0+) | CQL access, driver-native, auth and TLS for free | Read-only; does not cover mutating operations; a subset of JMX surface |
| `setcompactionthroughput` etc. | Live tuning with no restart | Not persisted — reverts to `cassandra.yaml` on restart; easy to forget |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Stopping Cassandra without `nodetool drain`.** → ✅ Undrained shutdown means the node replays its commit log on startup, which can take many minutes on a busy node and delays rejoining the ring. Always `drain` last, then stop.
2. ⚠️ **Running `nodetool compact` to "clean up disk".** → ✅ On STCS it produces a single huge SSTable that can never bucket with new files, so tombstones inside it are never dropped again. Use `nodetool garbagecollect` (4.0+) or fix the compaction strategy.
3. ⚠️ **Forgetting `nodetool cleanup` after adding a node.** → ✅ Existing nodes keep serving and storing data they no longer own until cleanup runs. Disk never drops, and the ring looks permanently imbalanced in `nodetool status`.
4. ⚠️ **Running `cleanup` on many nodes at once.** → ✅ Cleanup is a full SSTable rewrite — it costs as much as a major compaction in I/O. Run it on one node at a time, and never during a repair.
5. ⚠️ **Trusting a single node's `nodetool status`.** → ✅ It is that node's gossip view. Confirm from at least one other node, and always run `nodetool describecluster` to rule out schema disagreement.
6. ⚠️ **Ignoring non-zero dropped `MUTATION` in `tpstats`.** → ✅ Those are writes the coordinator counted (if `CL` was met by other replicas) that this replica never applied. Hints may not cover them. Schedule repair and find the root cause (disk saturation, long GC).
7. ⚠️ **Reading `tpstats` absolute counters as a health signal.** → ✅ They are cumulative since JVM start. Only the **delta** matters. A node up for 200 days will show large numbers that mean nothing.
8. ⚠️ **Opening JMX on 0.0.0.0 to make remote nodetool convenient.** → ✅ Unauthenticated JMX is remote code execution. Keep `LOCAL_JMX=yes`, run `nodetool` over SSH, or bind JMX to a private interface with `com.sun.management.jmxremote.authenticate=true` plus TLS.
9. ⚠️ **Using `nodetool tablehistograms` to explain client-visible latency.** → ✅ That is *local storage* latency. Client-visible latency is `nodetool proxyhistograms` (coordinator-side, includes network and replica wait). They routinely differ by an order of magnitude.
10. ⚠️ **Leaving snapshots around after a migration.** → ✅ Snapshots are hard links; they cost nothing at creation but pin SSTables forever as compaction replaces the originals. `nodetool listsnapshots` regularly and `clearsnapshot` what you no longer need — this is a top cause of "disk full" incidents.
11. ⚠️ **Changing `setcompactionthroughput` during an incident and assuming it stuck.** → ✅ Live nodetool setters are not persisted. Mirror the change in `cassandra.yaml` if you want it to survive a restart.
12. ⚠️ **Running `nodetool repair` with no arguments as a routine cron job.** → ✅ Without `-pr` every range is repaired `RF` times, and without `-local` you stream across DCs. See chapter 29; use Reaper or `-pr -local` on every node.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** A disciplined triage order saves hours. Start with `nodetool status` + `describecluster` (membership and schema), then `nodetool info` (heap, uptime, cache hit rates), then `nodetool tpstats` deltas (where is the pressure and what is being dropped), then `nodetool compactionstats` and `netstats` (is background work saturating the node), then `nodetool proxyhistograms` vs `tablehistograms` (is the latency in the storage layer or in coordination/network). For a specific slow query, `nodetool getendpoints <ks> <tbl> <key>` tells you which replicas to inspect, and `nodetool settraceprobability 0.001` plus `SELECT * FROM system_traces.events` gives you per-request breakdowns — remember to set it back to 0, tracing is expensive.

For GC: `nodetool gcstats` gives a quick view, but real analysis needs the GC log (`-Xlog:gc*` on JDK 11+). A `MemtableFlushWriter` all-time-blocked climbing alongside long GC pauses almost always means on-heap memtables on an undersized heap; switch to `memtable_allocation_type: offheap_objects`.

**Monitoring.** Scrape these MBeans rather than shelling out:
- `org.apache.cassandra.metrics:type=ClientRequest,scope=Read|Write,name=Latency` (and `name=Timeouts`, `name=Unavailables`, `name=Failures`) — the SLO metrics.
- `org.apache.cassandra.metrics:type=ThreadPools,path=request,scope=MutationStage,name=PendingTasks` and `...,name=CurrentlyBlockedTasks`.
- `org.apache.cassandra.metrics:type=DroppedMessage,scope=MUTATION,name=Dropped`.
- `org.apache.cassandra.metrics:type=Compaction,name=PendingTasks|CompletedTasks|BytesCompacted`.
- `org.apache.cassandra.metrics:type=Storage,name=Load|Exceptions|TotalHints`.
- `org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=SSTablesPerReadHistogram|MaxPartitionSize|TombstoneScannedHistogram`.
- `java.lang:type=GarbageCollector,name=G1 Young Generation|G1 Old Generation` — pause time is the single best node-health proxy.
- `org.apache.cassandra.metrics:type=CQL,name=RegularStatementsExecuted|PreparedStatementsRatio` — a falling prepared-statement ratio means an application is building CQL strings, which will eventually blow up the prepared-statement cache.

**Security.** JMX is the biggest operational foot-gun in Cassandra. Since 3.6 the default is `LOCAL_JMX=yes` in `cassandra-env.sh`, binding 7199 to localhost — **keep it**. If you must expose it, enable JMX authentication (`jmxremote.password`, `jmxremote.access`) *and* TLS (`com.sun.management.jmxremote.ssl=true`), and firewall 7199 to a bastion. Better: use virtual tables over the authenticated, TLS-protected native protocol for read-only monitoring, and run mutating `nodetool` commands over SSH with a per-operator account. Note that `nodetool` commands are **not** covered by Cassandra's role-based auth — JMX access is all-or-nothing, so anyone who can reach JMX can `drain`, `decommission` or `truncate`. Enable the 4.0 **audit log** (`audit_logging_options`) to record CQL-level activity, and use `nodetool` wrappers with logging for the operational path.

**Performance & Scaling.** Operationally, the things that scale badly are the ones that touch every SSTable: `cleanup`, major `compact`, and `repair`. Budget them explicitly. Use `nodetool setcompactionthroughput` to raise throughput during a maintenance window and lower it before peak. On large fleets, wrap everything in an orchestrator that enforces "one node at a time per rack" so you never lose quorum for a token range. Track `Percent Repaired` from `nodetool info` per node as a fleet-wide health metric — a node stuck below the fleet median is a node whose repairs are failing silently.

## 9. Interview Questions

**Q: What do the two letters in `nodetool status` (e.g. `UN`, `DN`, `UJ`) mean?**
A: The first is gossip liveness — `U`p or `D`own. The second is operational state — `N`ormal, `J`oining (bootstrapping), `L`eaving (decommissioning), or `M`oving (token move). `UN` is the only steady state; `UJ` or `UL` persisting for hours means a stuck bootstrap or decommission.

**Q: What is the difference between `nodetool flush` and `nodetool drain`?**
A: `flush` writes memtables to SSTables but the node keeps serving reads and writes. `drain` flushes *and* stops accepting writes, marking the node as unavailable — it is the last step before a planned shutdown so the commit log is empty and restart needs no replay. Draining a live node removes it from write availability, so never do it casually.

**Q: Why must you run `nodetool cleanup` after adding a node, and where do you run it?**
A: Bootstrapping a new node reassigns token ranges, so existing nodes still hold data they no longer own — they keep it on disk and it still counts against their load. `cleanup` rewrites their SSTables dropping unowned rows. Run it on every node **except** the newly added one, one node at a time, since it costs as much I/O as a major compaction.

**Q: What does `nodetool describecluster` tell you that `status` does not?**
A: The snitch, partitioner, and — most importantly — the **schema version per node**. More than one schema version listed means a schema disagreement, which will cause query failures and must be resolved (usually by restarting the odd node out) before any other operation.

**Q: You see non-zero dropped `MUTATION` in `nodetool tpstats`. What does that mean?**
A: This replica received write mutations but they timed out in the queue and were discarded — so this node is missing data other replicas have. If the coordinator still met the consistency level, the client saw success. Hints may not cover it. It signals node overload (disk, GC, or CPU) and requires both a root-cause fix and a repair.

**Q: How does `nodetool tablehistograms` differ from `nodetool proxyhistograms`?**
A: `tablehistograms` shows local storage-engine latency on that node for one table, plus SSTables-per-read and partition-size percentiles. `proxyhistograms` shows coordinator-side latency for the whole request including network hops and waiting for replicas — that is what the client actually experiences. A big gap between them points at network or a slow replica, not the storage engine.

**Q: What port does `nodetool` use and why is it usually restricted to localhost?**
A: JMX on port 7199. Cassandra defaults to `LOCAL_JMX=yes` because unauthenticated JMX is effectively remote code execution and is not covered by Cassandra's role-based access control — anyone reaching it can drain, decommission or truncate. Run `nodetool` over SSH, or enable JMX auth plus TLS and firewall the port to a bastion.

**Q: (Senior) Two nodes report different `nodetool status` output. How do you diagnose and resolve it?**
A: This is a gossip convergence or partition problem. First confirm it is not transient — gossip needs `O(log N)` seconds. Then check `nodetool gossipinfo` on both to compare generation and heartbeat for the disputed node; a stale generation means the node restarted and peers still hold the old state. Check network reachability on port 7000 between the disagreeing pair specifically (a one-way firewall rule is a classic cause), and check for clock skew, which breaks gossip generation ordering. `nodetool describecluster` will also show whether the disagreement extends to schema. Resolution is usually restarting the node with the stale view, or in a genuine split, fixing the network and letting gossip reconverge; `nodetool assassinate` is a last resort for a ghost entry and should never be used on a live node.

**Q: (Senior) Why is `nodetool compact` considered harmful in production, and what should you do instead?**
A: With SizeTieredCompactionStrategy it merges all SSTables for a table into one enormous file. STCS buckets by similar size, so that file will never have peers of comparable size again — it becomes permanently un-compactable, meaning tombstones written into it are never purged and the table's read path carries a giant file forever. Instead: use `nodetool garbagecollect` (4.0+), which does single-SSTable compaction to purge droppable tombstones without merging everything; or use `unchecked_tombstone_compaction` / lower `tombstone_threshold` sub-properties to let normal compaction do it; or, if the strategy is genuinely wrong, change it (LCS or TWCS) and let normal compaction rewrite the table. If you already ran it, `sstablesplit` (offline) can break the giant file back up.

**Q: (Senior) Design a monitoring approach for a 200-node Cassandra fleet. What do you scrape and how?**
A: Do not poll `nodetool` — 200 nodes × a JVM launch per metric is untenable. Run the Prometheus JMX exporter as a `-javaagent` inside each Cassandra JVM with a curated whitelist (unfiltered scraping of Cassandra's MBean tree produces tens of thousands of series and will kill your TSDB). Whitelist `ClientRequest` latency/timeouts/unavailables, `ThreadPools` pending and blocked, `DroppedMessage`, `Compaction` pending, `Storage` load and hints, per-table `SSTablesPerReadHistogram`, `MaxPartitionSize` and `TombstoneScannedHistogram` for your top ~20 tables only, and JVM GC pause metrics. Add virtual-table scrapes over CQL for `sstable_tasks` and `disk_usage`. Alert on SLO metrics (client p99 latency, timeout rate, unavailable rate) as pages, and on capacity/health metrics (pending compactions, disk headroom, repair age, hints growth) as tickets. Finally, track `Percent Repaired` and repair age per table — that is the metric nobody collects and everybody regrets.

**Q: (Senior) A node shows steadily climbing `Load` in `nodetool status` while its peers stay flat. Walk through the diagnosis.**
A: Three families of cause. **Ownership**: check `nodetool status <keyspace>` for effective ownership skew — with `num_tokens: 16` and random allocation, ±25% variance is normal, and worse if the node was added without `allocate_tokens_for_local_replication_factor`. **Un-reclaimed space**: compare `Space used (live)` vs `(total)` and `Space used by snapshots` in `nodetool tablestats` — forgotten snapshots pinning old SSTables are the single most common cause, followed by a compaction backlog (`nodetool compactionstats`) or a stuck major-compaction output. **Missing cleanup**: if a node was recently added, this node may still hold ranges it no longer owns; run `nodetool cleanup`. Also check for a hot partition via `nodetool tablehistograms` max partition size, and for accumulating hints in `hints_directory` if a peer has been flapping.

**Q: What are Cassandra virtual tables and when would you use them over `nodetool`?**
A: Introduced in 4.0, they are read-only CQL views over internal state in the `system_views` keyspace — `sstable_tasks`, `thread_pools`, `clients`, `disk_usage`, `settings`, `caches`. Use them for programmatic monitoring, because they go over the native protocol on 9042 with normal authentication and TLS instead of requiring JMX access, and they cost no JVM startup. They do not replace `nodetool` for mutating operations like `flush`, `drain`, `cleanup` or `repair`.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** `nodetool` is a JMX client on port 7199 exposing each node's *local* view. `status` (gossip: `UN`/`DN`/`UJ`/`UL`, load, effective ownership summing to `RF×100%`), `describecluster` (one schema version = healthy), and `info` (heap, cache hit rate, percent repaired) are the health triangle. `tpstats` shows stage pressure and — critically — **dropped messages**, where non-zero `MUTATION` means this replica silently missed writes. `compactionstats` and `netstats` show background work; `tablestats`/`tablehistograms` show local storage behaviour (SSTables per read, max partition size) while `proxyhistograms` shows what clients actually see. For maintenance: `flush` writes memtables, `drain` flushes *and* stops writes (always before shutdown), `cleanup` drops no-longer-owned ranges after a topology change (every node except the new one, one at a time), `snapshot`/`clearsnapshot` manage hard-link backups. Never `nodetool compact` on STCS in production. For monitoring at scale, use the Prometheus JMX exporter and 4.0 virtual tables instead of polling the CLI.

| Command | What it tells / does | Watch for |
|---|---|---|
| `nodetool status [ks]` | Ring membership, load, effective ownership | Any non-`UN`; ownership skew |
| `nodetool describecluster` | Snitch, partitioner, schema versions | More than one schema version |
| `nodetool info` | Heap, off-heap, caches, uptime, percent repaired | Heap > 75%, key cache hit < 0.9 |
| `nodetool tpstats` | Per-stage active/pending/blocked + dropped | Dropped MUTATION; blocked flush writers |
| `nodetool compactionstats` | Running + pending compactions | Pending sustained > 20 |
| `nodetool netstats` | Streaming and read-repair stats | Stuck streams during bootstrap |
| `nodetool tablestats ks.tbl` | SSTable count, space, bloom ratio, snapshots | Snapshot space; max partition bytes |
| `nodetool tablehistograms ks tbl` | SSTables/read, partition size percentiles | p99 SSTables/read > 4 |
| `nodetool proxyhistograms` | Client-visible coordinator latency | p99 vs your SLO |
| `nodetool flush [ks tbl]` | Memtables → SSTables | Safe anytime |
| `nodetool drain` | Flush + refuse writes | Only before shutdown |
| `nodetool cleanup [ks]` | Drop unowned ranges | One node at a time, post-topology |
| `nodetool garbagecollect ks tbl` | Purge droppable tombstones (4.0+) | Prefer over `compact` |
| `nodetool snapshot -t TAG ks` | Hard-link backup | `clearsnapshot` afterwards |
| `nodetool setcompactionthroughput N` | Live MB/s change | Not persisted across restart |
| `nodetool getendpoints ks tbl key` | Which replicas hold a key | For targeted debugging |
| JMX port | `7199` | Keep `LOCAL_JMX=yes` |

**Flash cards**
- **What does `UJ` mean in `nodetool status`?** → Up and Joining: the node is bootstrapping and streaming data; it is not yet serving reads for its ranges.
- **Which command must always precede a node shutdown?** → `nodetool drain` — flushes memtables and stops accepting writes so restart needs no commit-log replay.
- **After adding a node, what must you run and where?** → `nodetool cleanup` on every pre-existing node, one at a time, to drop ranges they no longer own.
- **`tablehistograms` vs `proxyhistograms`?** → Local storage latency for one table vs coordinator-side latency the client actually experiences.
- **Why avoid `nodetool compact` under STCS?** → It creates one giant SSTable that can never bucket with new files, so its tombstones are never purged.

## 11. Hands-On Exercises & Mini Project

- [ ] Bring up a 3-node cluster (`ccm create ops -v 4.1.5 -n 3 -s`). Run `nodetool status`, `describecluster` and `info` on each node; record ownership per node and confirm effective ownership sums to `RF × 100%` after creating an `RF=3` keyspace.
- [ ] Write 5 M rows with `cassandra-stress`, then capture `nodetool tpstats` before and after and compute the **deltas**. Identify which stage saw the most completions and whether anything was dropped or blocked.
- [ ] Compare `nodetool tablehistograms` against `nodetool proxyhistograms` under load. Explain the gap. Then throttle the disk (`cgroup` I/O limit or a `dd` competing writer) and watch which one degrades first.
- [ ] Add a 4th node, wait for `UN`, then observe that `Load` on the original three does not drop. Run `nodetool cleanup` on each in turn and record the disk reclaimed per node.
- [ ] Take a snapshot, run heavy writes plus `nodetool compact`, and watch `Space used by snapshots` in `nodetool tablestats` grow as the hard-linked originals are replaced. Then `clearsnapshot` and confirm the space returns.
- [ ] Query the same information via virtual tables: `system_views.thread_pools`, `system_views.sstable_tasks`, `system_views.disk_usage`. Compare against the corresponding `nodetool` output.

### Mini Project — Fleet Health Snapshot Tool

**Goal.** A single command that produces a one-page health report for an entire cluster without polling `nodetool` per metric.

**Requirements.**
1. Connect once with the Python driver and read `system_views.thread_pools`, `sstable_tasks`, `disk_usage`, `clients` and `settings` — plus `system.peers_v2` and `system.local` for topology.
2. For each node, report: state, load, effective ownership, pending compactions, top-3 largest tables by disk, and connected client count.
3. Flag anomalies: ownership deviating more than 20% from the mean, pending compactions > 20, disk usage > 70%, any node whose schema version differs.
4. Emit both a human-readable table and a JSON blob suitable for feeding into an alerting system.
5. Add a `--verbose` mode that shells out to `nodetool tpstats` over SSH for the dropped-message counters that virtual tables do not expose.

**Extensions.**
- Take two snapshots N seconds apart and report **deltas** for all cumulative counters — this is the only correct way to read `tpstats`-style numbers.
- Add a pre-flight `--restart-check <node>` mode that verifies it is safe to take a specific node down: no other node in the same rack is down, no repair or bootstrap in progress, and quorum would survive.
- Wire it into a `--drain-and-restart` runbook mode that executes `disablebinary` → `drain` → stop → start → verify `UN` from a peer, with confirmation prompts.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Adding, Removing & Replacing Nodes* (ch. 28) uses `status`, `netstats` and `cleanup` throughout; *Repair: Full, Incremental & Subrange* (ch. 29) covers `nodetool repair` in depth; *Backup, Snapshots & Restore* (ch. 30) builds on `snapshot`/`clearsnapshot`; *Monitoring & Metrics* (ch. 31) covers the JMX/Prometheus pipeline this chapter recommends; *Gossip & Failure Detection* explains why `status` is eventually consistent; *Storage Engine & SSTable Format* (ch. 26) explains what `tablestats` numbers mean.

- **Apache Cassandra Docs — nodetool reference** — Apache Software Foundation · *Intermediate* · the complete command reference with every flag; bookmark it, you will use it weekly. <https://cassandra.apache.org/doc/latest/cassandra/managing/tools/nodetool/nodetool.html>
- **Apache Cassandra Docs — Virtual Tables** — Apache Software Foundation · *Intermediate* · the 4.0 `system_views` catalogue and what each table exposes. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/virtualtables.html>
- **Apache Cassandra Docs — Monitoring** — Apache Software Foundation · *Advanced* · the authoritative list of metric MBeans and their meanings. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/metrics.html>
- **The Last Pickle — Cassandra Nodetool Cheat Sheet & Operations posts** — TLP · *Intermediate* · practitioner-grade guidance on which commands to trust and which to avoid in production. <https://thelastpickle.com/blog/>
- **Prometheus JMX Exporter — Cassandra config** — Prometheus / criteo · *Advanced* · a working whitelist so you scrape useful series instead of 40,000 useless ones. <https://github.com/prometheus/jmx_exporter>
- **CASSANDRA-7622 — Implement virtual tables** — Apache JIRA · *Advanced* · the design discussion behind virtual tables and why they exist alongside JMX. <https://issues.apache.org/jira/browse/CASSANDRA-7622>
- **DataStax Docs — Cassandra Operations & Troubleshooting** — DataStax · *Intermediate* · practical runbooks for common operational failures, mapped to nodetool output. <https://docs.datastax.com/en/cassandra-oss/3.x/cassandra/operations/opsTOC.html>
- **Cassandra Summit / ApacheCon talks on Cassandra operations** — Apache Software Foundation (YouTube) · *Advanced* · real operators walking through incidents and the nodetool output that diagnosed them. <https://www.youtube.com/@PlanetCassandra>

---

*Apache Cassandra Handbook — chapter 27.*
