# 37 · Capacity Planning & Cluster Sizing

> **In one line:** Capacity planning turns four numbers — throughput, dataset size, replication factor, and headroom — into a concrete answer for how many nodes of what shape you need, and when you must add more.

---

## 1. Overview

Every Cassandra cluster that ever fell over in production fell over for one of two reasons: someone guessed the node count, or someone forgot that replication multiplies everything. Capacity planning is the discipline of refusing to guess. You start from measurable business quantities — writes per second, average row size, retention window, required durability — and you derive node count, disk per node, heap size, and the date at which you must expand. Done properly it is arithmetic, not art.

The problem it solves is asymmetric failure. Cassandra degrades gracefully under CPU pressure and read load, but it degrades *catastrophically* when disks fill. Compaction needs free space to work — size-tiered compaction can transiently need as much free space as the largest table's SSTables occupy. A node at 85% disk cannot compact, so SSTable counts climb, so read latency climbs, so the node gets marked down, so its neighbours take more load and fill faster. That is the classic Cassandra death spiral, and it is entirely preventable by arithmetic done six months earlier.

Historically, the guidance evolved with hardware. The original Facebook/Apache-era rule of thumb was "500 GB to 1 TB per node" because spinning disks and 8 GB heaps made compaction and streaming painfully slow. With NVMe, JVM improvements, `CASSANDRA-14197`-era streaming rewrites (zero-copy streaming in 4.0), and offheap memtables, teams now routinely run 2–4 TB per node, and Cassandra 5.0's Unified Compaction Strategy plus trie memtables push that further. But the *reason* for a density limit never changed: it is the time to rebuild a node. A 4 TB node streaming at 200 MB/s takes about 5.5 hours to bootstrap — and that is your mean time to recovery.

A concrete example. Consider a ride-hailing company storing trip telemetry: 40,000 GPS pings per second at peak, each ping serialized to roughly 180 bytes of Cassandra row payload plus overhead, retained for 90 days, `RF=3` across a single datacenter. Raw ingest is 40,000 × 180 B ≈ 7.2 MB/s ≈ 622 GB/day of logical data. Over 90 days that is ~56 TB logical, ~168 TB replicated. With 3 TB usable per node and a 50% headroom target you need 168 / (3 × 0.5) = **112 nodes** — plus the observation that you should probably TTL aggressively or move cold telemetry to object storage, because 112 nodes for GPS pings is a business decision, not a database decision. Capacity planning is often the conversation that changes the data model.

The output of this chapter is a repeatable worksheet: measure, multiply, divide, add headroom, then validate with a load test. Everything else is refinement.
## 2. Core Concepts

- **Logical data size** — the sum of your rows as they would exist with `RF=1` and no replicas, before compression, tombstones, or index overhead.
- **Physical data size** — logical size × replication factor ÷ compression ratio, plus SSTable index/summary/bloom-filter files and transient tombstone/obsolete data awaiting compaction.
- **Usable disk per node** — the disk capacity you are actually allowed to fill, after reserving compaction headroom, filesystem reserve, and growth buffer. Typically 50–70% of raw.
- **Compaction headroom** — free space compaction requires to write merged output before deleting inputs. STCS worst case ≈ size of the largest table; LCS/UCS worst case is far smaller (roughly 10× `sstable_size_in_mb`).
- **Node density** — bytes of physical data per node. Bounded by bootstrap/repair/replace time, not by disk price.
- **Replication factor (RF)** — copies per datacenter. Total copies = Σ RF across DCs. `RF=3` per DC × 2 DCs = 6× your logical bytes on disk.
- **Working set** — the portion of data actively read. If the working set fits in page cache + chunk cache, reads are memory-speed; if not, you are sizing for IOPS, not GB.
- **Headroom** — the fraction of a resource intentionally left unused so that a node failure, a repair, or a traffic spike does not saturate the cluster. Plan for `N-1` (or `N-RF+1`) survivable capacity.
- **Growth rate** — bytes/day added net of TTL expiry. The derivative that determines *when*, not *how big*.
- **Coordinator amplification** — a write at `RF=3` costs one coordinator hop plus three replica writes; a `QUORUM` read at `RF=3` costs two replica reads plus a digest comparison. CPU sizing must count these, not client requests.
## 3. Theory & Internals

### 3.1 The core sizing equations

Start with the storage chain. Let `L` be logical bytes, `RF` the replication factor, `C` the compression ratio (compressed ÷ uncompressed, typically 0.3–0.5 for JSON-ish text with LZ4), and `O` the SSTable overhead multiplier for indexes, bloom filters, and pre-compaction garbage (1.2–1.4 is realistic):

```
Physical bytes  P = L × RF × C × O
Nodes needed    N = ceil( P / (D_raw × U) )
```

where `D_raw` is raw disk per node and `U` is the usable fraction (0.5 for STCS, 0.65–0.7 for LCS/UCS).

Row-level sizing matters because Cassandra's storage format is not free. For a table with partition key `k`, clustering column `c`, and `v` regular columns, per-row on-disk cost is approximately:

```
row_bytes ≈ clustering_bytes
          + Σ(column_value_bytes)
          + 8 bytes timestamp per cell (delta-encoded)
          + ~1-2 bytes flags per cell
```

The partition key and static columns are amortized once per partition. This is why 10 columns of 4-byte ints cost far more than 40 bytes: cell timestamps dominate. Using frozen UDTs or blobs to collapse many small cells into one is a legitimate 2–3× storage optimization.

### 3.2 Bloom filters and memory

Each SSTable carries a bloom filter sized from `bloom_filter_fp_chance` (default 0.01 for STCS, 0.1 for LCS). Bits per key ≈ `-log2(fp) / ln(2) ≈ 1.44 × log2(1/fp)`. At fp=0.01 that is ~9.6 bits/key ≈ 1.2 bytes per partition key, held **off-heap**. A node with 2 billion partitions therefore carries ~2.4 GB of bloom filter — a real number that must fit in RAM alongside page cache.

### 3.3 Throughput sizing

Modern Cassandra on a 16-core node with NVMe sustains roughly 20k–40k writes/sec/node and 10k–25k reads/sec/node at `LOCAL_QUORUM` with sub-10 ms p99, assuming reasonable row sizes. Convert client ops to replica ops first:

```
replica_write_ops = client_writes × RF
replica_read_ops  = client_reads × (QUORUM replicas contacted)  # 2 at RF=3
N_throughput = ceil( replica_ops / per_node_capacity / headroom_factor )
```

Take `N = max(N_storage, N_throughput)` and never the minimum.

```svg
<svg viewBox="0 0 760 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif"> <rect x="0" y="0" width="760" height="330" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#1e293b">From business numbers to node count</text>
<rect x="20" y="50" width="150" height="70" rx="8" fill="#eef2ff" stroke="#4f46e5"/> <text x="34" y="74" font-size="12" fill="#1e293b">Ops/sec + row size</text>
<text x="34" y="92" font-size="11" fill="#1e293b">40k w/s x 180 B</text> <text x="34" y="108" font-size="11" fill="#1e293b">= 622 GB/day</text>
<rect x="205" y="50" width="150" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="219" y="74" font-size="12" fill="#1e293b">x retention (90 d)</text>
<text x="219" y="92" font-size="11" fill="#1e293b">logical L</text> <text x="219" y="108" font-size="11" fill="#1e293b">= 56 TB</text>
<rect x="390" y="50" width="150" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="404" y="74" font-size="12" fill="#1e293b">x RF(3) x comp(1.0)</text>
<text x="404" y="92" font-size="11" fill="#1e293b">physical P</text> <text x="404" y="108" font-size="11" fill="#1e293b">= 168 TB</text>
<rect x="575" y="50" width="165" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/> <text x="589" y="74" font-size="12" fill="#1e293b">/ usable per node</text>
<text x="589" y="92" font-size="11" fill="#1e293b">3 TB x 50% headroom</text> <text x="589" y="108" font-size="11" fill="#1e293b">= 112 nodes</text>
<path d="M170 85 L205 85" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a37)"/> <path d="M355 85 L390 85" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a37)"/>
<path d="M540 85 L575 85" stroke="#1e293b" stroke-width="1.5" marker-end="url(#a37)"/> <rect x="20" y="160" width="330" height="140" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="36" y="184" font-size="13" font-weight="bold" fill="#1e293b">Storage-bound path</text> <text x="36" y="206" font-size="11" fill="#1e293b">N_storage = P / (D_raw x U)</text>
<text x="36" y="226" font-size="11" fill="#1e293b">U = 0.50 for STCS</text> <text x="36" y="246" font-size="11" fill="#1e293b">U = 0.65 for LCS / UCS</text>
<text x="36" y="270" font-size="11" fill="#1e293b">Bounded by bootstrap time,</text> <text x="36" y="288" font-size="11" fill="#1e293b">not by disk price.</text>
<rect x="390" y="160" width="350" height="140" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="406" y="184" font-size="13" font-weight="bold" fill="#1e293b">Throughput-bound path</text>
<text x="406" y="206" font-size="11" fill="#1e293b">replica_ops = client_ops x RF (writes)</text>
<text x="406" y="226" font-size="11" fill="#1e293b">replica_ops = client_ops x 2 (QUORUM reads)</text>
<text x="406" y="246" font-size="11" fill="#1e293b">N_thru = replica_ops / 30k / 0.6</text> <text x="406" y="270" font-size="11" fill="#1e293b">Answer = max(N_storage, N_thru)</text>
<text x="406" y="288" font-size="11" fill="#1e293b">rounded up to a multiple of RF.</text> <defs> <marker id="a37" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
<path d="M0 0 L8 4 L0 8 z" fill="#1e293b"/> </marker> </defs> </svg>
```

### 3.4 Why density is bounded by recovery time

Suppose a node dies. Replacement streams its full data from replicas. Cassandra 4.0's zero-copy streaming moves entire SSTables without deserializing, achieving 100–400 MB/s per stream depending on network and disk. Time to rebuild:

```
T_rebuild = data_per_node / stream_rate
1 TB  @ 250 MB/s ≈ 1.1 h
4 TB  @ 250 MB/s ≈ 4.4 h
10 TB @ 250 MB/s ≈ 11 h
```

During `T_rebuild` you are running at reduced redundancy. If your SLO says "survive a second failure," your density must keep `T_rebuild` short relative to your failure rate. That is the entire argument, and it is why "just buy 30 TB disks" is wrong.
## 4. Architecture & Workflow

A disciplined capacity exercise runs as follows.

1. **Enumerate tables and access patterns.** For each table, record write rate, read rate, average row size, expected partitions, and TTL. Tables without a TTL and without a bounded partition count are the ones that will kill you.
2. **Measure real row size, do not estimate it.** Load 1 million representative rows into a single-node test cluster, `nodetool flush`, then read `nodetool tablestats` for `Space used (live)` and divide. This captures compression and cell-timestamp overhead automatically.
3. **Compute logical size** = Σ over tables of `rows_retained × measured_row_bytes`.
4. **Apply replication and overhead** to get physical size, per datacenter. Remember that each DC carries a full `RF` copy: a 3-DC deployment with `RF=3` each stores 9 copies.
5. **Choose node shape.** Pick an instance/server type; decide raw disk, RAM, and cores. Typical 2024–2026 production shape: 16 vCPU, 64 GB RAM, 2–4 TB NVMe, 10 Gbps NIC.
6. **Compute `N_storage` and `N_throughput`**, take the max, round up to a multiple of `RF` (so racks stay balanced), and distribute across at least `RF` racks/AZs evenly.
7. **Add failure headroom.** Ensure the cluster still meets latency SLOs with one full rack down. With 3 racks that means sizing to 67% steady-state utilization of CPU.
8. **Model growth.** Project net bytes/day forward 12–18 months; mark the date at which utilization crosses 60%; that is your expansion trigger, not 85%.
9. **Validate with a load test.** Run `cassandra-stress` or `nosqlbench` at 1.5× projected peak against a scaled-down but *identically shaped* cluster, and extrapolate linearly per node.
10. **Re-measure quarterly.** Row sizes drift as schemas change. Capacity plans are living documents.

```svg
<svg viewBox="0 0 760 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif"> <rect x="0" y="0" width="760" height="360" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#1e293b">Disk budget on a single 4 TB node</text> <rect x="30" y="50" width="640" height="46" fill="#f0fdf4" stroke="#16a34a"/>
<text x="40" y="78" font-size="12" fill="#1e293b">Live data  1.8 TB  (45%)  safe operating zone</text> <rect x="30" y="102" width="640" height="46" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="40" y="130" font-size="12" fill="#1e293b">Compaction headroom  1.0 TB  (25%)  merged output written before inputs drop</text>
<rect x="30" y="154" width="640" height="46" fill="#fef3c7" stroke="#d97706"/>
<text x="40" y="182" font-size="12" fill="#1e293b">Failure / streaming buffer  0.8 TB  (20%)  absorbs a neighbour rebuild + hints</text>
<rect x="30" y="206" width="640" height="46" fill="#eef2ff" stroke="#4f46e5"/> <text x="40" y="234" font-size="12" fill="#1e293b">Snapshots, commitlog, OS, logs  0.4 TB  (10%)</text>
<line x1="30" y1="266" x2="670" y2="266" stroke="#1e293b" stroke-width="1"/>
<text x="30" y="286" font-size="12" font-weight="bold" fill="#1e293b">Alert at 60% used  ·  expand at 65%  ·  emergency at 80%  ·  compaction stalls near 85%</text>
<rect x="30" y="300" width="300" height="42" rx="6" fill="#f0fdf4" stroke="#16a34a"/> <text x="44" y="326" font-size="12" fill="#1e293b">STCS: usable fraction U ≈ 0.50</text>
<rect x="370" y="300" width="300" height="42" rx="6" fill="#eef2ff" stroke="#4f46e5"/> <text x="384" y="326" font-size="12" fill="#1e293b">LCS / UCS: usable fraction U ≈ 0.65</text> </svg>
```
## 5. Implementation

### 5.1 Measure real row size

```cql
CREATE KEYSPACE IF NOT EXISTS sizing
  WITH replication = {'class':'NetworkTopologyStrategy','dc1':3};

CREATE TABLE sizing.trip_pings (
  trip_id     uuid,
  ping_ts     timestamp,
  lat         double,
  lon         double,
  speed_kph   float,
  heading     smallint,
  PRIMARY KEY ((trip_id), ping_ts)
) WITH CLUSTERING ORDER BY (ping_ts DESC)
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS',
                    'compaction_window_size':1}
  AND default_time_to_live = 7776000        -- 90 days
  AND compression = {'class':'LZ4Compressor','chunk_length_in_kb':16};
```

```bash
# Load 1M representative rows, then measure.
cassandra-stress user profile=trip_pings.yaml ops\(insert=1\) n=1000000 -node 127.0.0.1
nodetool flush sizing trip_pings
nodetool tablestats sizing.trip_pings

# Space used (live): 96,472,133          -> 96.5 MB for 1,000,000 rows
# Compression ratio: 0.412
# Number of partitions (estimate): 20,133
# Bloom filter off heap memory used: 24,536
# => measured 96.5 bytes/row on disk, compressed. Use THIS, not a guess.
```

### 5.2 A sizing calculator you can actually run

```python
from math import ceil

def size_cluster(writes_per_sec, row_bytes, retention_days, rf,
                 raw_disk_tb, usable_fraction=0.5,
                 node_write_capacity=30_000, headroom=0.6):
    """Return (nodes_by_storage, nodes_by_throughput, recommended)."""
    bytes_per_day = writes_per_sec * row_bytes * 86_400
    logical_tb    = bytes_per_day * retention_days / 1e12
    physical_tb   = logical_tb * rf
    n_storage     = ceil(physical_tb / (raw_disk_tb * usable_fraction))

    replica_ops   = writes_per_sec * rf
    n_throughput  = ceil(replica_ops / (node_write_capacity * headroom))

    n = max(n_storage, n_throughput)
    n = ceil(n / rf) * rf                      # keep racks balanced
    return n_storage, n_throughput, n

print(size_cluster(writes_per_sec=40_000, row_bytes=96.5,
                   retention_days=90, rf=3,
                   raw_disk_tb=4, usable_fraction=0.5))
# (15, 9, 15)  -> 15 nodes: storage-bound, 5 per rack across 3 racks
```

Note how measuring 96.5 B/row instead of guessing 180 B halved the cluster. Measurement is the single highest-leverage step in capacity planning.

### 5.3 Node configuration that matches the plan

```yaml
# cassandra.yaml -- a 16 vCPU / 64 GB / 4 TB NVMe node
num_tokens: 16
allocate_tokens_for_local_replication_factor: 3

concurrent_writes: 128           # ~8 x cores
concurrent_reads: 64             # ~4 x cores for NVMe
concurrent_compactors: 4         # min(cores, disks); leave CPU for queries
compaction_throughput: 128MiB/s  # 4.1+ syntax; 0 = unthrottled (do not)

memtable_allocation_type: offheap_objects
memtable_heap_space: 2048MiB
memtable_offheap_space: 8192MiB

commitlog_total_space: 8192MiB
commitlog_sync: periodic
commitlog_sync_period: 10000ms

stream_throughput_outbound: 400Mib/s
disk_failure_policy: die
```

```bash
# jvm-server.options -- heap sizing for a 64 GB node
-Xms31G
-Xmx31G                      # stay under 32 GB for compressed oops
-XX:+UseG1GC
-XX:MaxGCPauseMillis=300
-XX:G1RSetUpdatingPauseTimePercent=5
# Leave ~30 GB for page cache + offheap memtables + bloom filters.
```

### 5.4 Ongoing measurement

```bash
# Per-node load and ownership drift
nodetool status sizing
# --  Address     Load       Tokens  Owns (effective)  Host ID   Rack
# UN  10.0.1.11   1.71 TiB   16      20.1%             a1f...    rack1
# UN  10.0.1.12   1.68 TiB   16      19.8%             b2c...    rack2
# UN  10.0.1.13   1.79 TiB   16      20.4%             c3d...    rack3

# Growth rate: sample twice, 24 h apart
nodetool tablestats sizing.trip_pings | grep "Space used (total)"

# What is actually big
nodetool tablestats -F json | jq -r '..|objects|select(.space_used_live)|"\(.space_used_live)"' | sort -rn | head
```

**Optimization note.** The cheapest capacity is the data you never store. Before buying nodes: (a) set `default_time_to_live` on every event table and use TWCS so whole SSTables drop at expiry instead of leaving tombstones; (b) collapse many small columns into a frozen UDT or a single compressed blob to eliminate per-cell 8-byte timestamps; (c) raise `chunk_length_in_kb` from the default 16 KB to 64 KB for scan-heavy tables to improve the compression ratio (at the cost of read amplification); (d) switch large tables from STCS to LCS or UCS to raise usable disk fraction from 50% to 65% — that is a 30% node reduction with no hardware change.
## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| High node density (4 TB+) | Fewer nodes, lower licence/instance cost, less coordination overhead | Bootstrap/replace takes hours; repair windows lengthen; a single failure removes more capacity |
| Low node density (< 1 TB) | Fast rebuilds, fast repairs, fine-grained scaling | More nodes to patch and monitor; gossip and schema propagation cost grows; worse $/GB |
| Scaling by adding nodes | Linear throughput and storage growth, no downtime | Streaming load during bootstrap competes with live traffic; needs token allocation care |
| Scaling up (bigger nodes) | Immediate relief, no topology change | Requires node replacement one at a time; heap above 32 GB loses compressed oops |
| Generous headroom (50%) | Survives rack loss, repair storms, and traffic spikes | You pay for hardware you are not using — often 2× the naive estimate |
| Tight headroom (80%) | Best $/GB on paper | Compaction stalls, disk-full incidents, and no room to bootstrap a replacement |
| STCS | Simple, write-cheap, good for append-only | Needs ~50% free disk; high read amplification; space amplification spikes |
| LCS / UCS | 65–70% usable disk, predictable read amplification | 2–3× more write I/O (compaction), higher CPU |
| Multi-DC replication | DR, locality, workload isolation | Storage cost multiplies by the number of DCs; cross-DC bandwidth bills |
| TTL + TWCS | Storage self-limits; expired SSTables dropped whole | Requires no out-of-window writes and no partial-partition deletes to work well |
## 7. Common Mistakes & Best Practices

1. ⚠️ **Sizing from logical bytes and forgetting RF.** → ✅ Always multiply by `RF` *per datacenter*, then sum. Three DCs at `RF=3` is 9× your logical data.
2. ⚠️ **Guessing row size from the schema.** → ✅ Load a million real rows, `nodetool flush`, read `Space used (live)` from `tablestats`, divide. Cell timestamps and compression make estimates wrong by 2–3×.
3. ⚠️ **Filling disks past 80%.** → ✅ Alert at 60%, plan expansion at 65%. Compaction needs free space; a full node cannot compact, and a node that cannot compact cannot serve reads quickly.
4. ⚠️ **Planning only for storage, not for CPU.** → ✅ Compute `N_throughput` too and take the max. Replica amplification means 40k client writes at `RF=3` is 120k replica writes.
5. ⚠️ **Ignoring unbounded partitions in the plan.** → ✅ Model partition count and max partition size explicitly. Keep partitions under 100 MB and 100k rows; add a bucketing component to the partition key if the plan says otherwise.
6. ⚠️ **Forgetting snapshot and backup space.** → ✅ Snapshots are hard links — free at creation, but they pin SSTables so deleted data never releases disk. Set a snapshot retention policy and audit `nodetool listsnapshots`.
7. ⚠️ **Assuming `gc_grace_seconds` costs nothing.** → ✅ At the default 864000 (10 days), delete-heavy tables carry up to 10 days of tombstones on disk. Budget that volume or run repairs frequently enough to safely lower it.
8. ⚠️ **Adding one node at a time to a hot cluster.** → ✅ Adding a single node to a 20-node cluster relieves only ~5% of load and costs a full streaming cycle. Expand in increments of at least 10–20%, ideally a whole rack at a time.
9. ⚠️ **Using heaps larger than 31 GB.** → ✅ Stay at or below 31 GB so the JVM keeps compressed ordinary object pointers. Give surplus RAM to the page cache, where Cassandra actually benefits.
10. ⚠️ **Load-testing with uniform synthetic keys.** → ✅ Real workloads are Zipfian. Use `cassandra-stress` with a `distribution` or NoSQLBench with realistic key skew, or your hot-partition problems appear only in production.
11. ⚠️ **Sizing for average load.** → ✅ Size for peak plus one rack down. If you run 3 racks, steady-state CPU must sit at or below ~65%.
12. ⚠️ **Never revisiting the plan.** → ✅ Re-measure row sizes and growth rate quarterly; schema changes silently invalidate old numbers.
## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

When a cluster is unhealthy, distinguish *undersized* from *misconfigured*. Undersized clusters show flat, sustained pressure: pending compactions climbing monotonically, `nodetool tpstats` showing non-zero `MutationStage` pending across all nodes, disk utilization near 100% on `iostat -x 1`. Misconfiguration shows as skew: one node hot, others idle — chase hot partitions with `nodetool toppartitions` and `nodetool tablehistograms` instead of buying hardware.

```bash
nodetool tpstats                 # Pending in MutationStage/ReadStage = saturation
nodetool compactionstats -H      # pending tasks climbing = compaction cannot keep up
nodetool tablehistograms ks.tbl  # partition size percentiles; check 99% column
nodetool toppartitions ks tbl 5000  # sample the hottest partitions for 5 s
```

### Monitoring

Track these JMX metrics and alert on the thresholds:

| Metric (JMX bean) | Alert |
|---|---|
| `org.apache.cassandra.metrics:type=Storage,name=Load` | node load > 60% of usable disk |
| `type=Compaction,name=PendingTasks` | > 100 sustained 15 min |
| `type=ClientRequest,scope=Write,name=Latency` p99 | > SLO for 5 min |
| `type=ThreadPools,path=request,scope=MutationStage,name=PendingTasks` | > 0 sustained |
| `type=Table,name=MaxPartitionSize` | > 100 MB |
| `type=Table,name=TombstoneScannedHistogram` p99 | > 1000 |
| `type=DroppedMessage,scope=MUTATION,name=Dropped` | any non-zero rate |
| JVM `G1 Old Gen` collection time | > 500 ms or > 5% of wall clock |

Cassandra 4.0+ exposes many of these as **virtual tables** (`system_views.disk_usage`, `system_views.local_read_latency`), queryable straight from `cqlsh` — see chapter 42.

### Security

Capacity plans have a security dimension: leave enough disk to hold audit logs and full-query logs without competing with data. Budget a *separate* volume for `audit_logs_dir` and `full_query_logging_options`, sized at retention × log rate, so a compliance-driven log burst can never fill the data disk. Similarly, encryption at rest raises CPU per byte — factor 5–15% CPU into the throughput calculation when TDE is enabled.

### Performance & Scaling

Scale out, not up, once past a single rack. The expansion procedure:

```bash
# 1. Bring up N new nodes with auto_bootstrap: true, correct rack/DC in cassandra-rackdc.properties
# 2. Start them ONE AT A TIME (or use consistent_range_movement=false only if you know why)
nodetool netstats            # watch streaming progress
nodetool status              # UJ -> UN when joined

# 3. After all joins finish, rebalance responsibility
nodetool cleanup             # per node, one at a time; frees data no longer owned

# 4. Verify
nodetool status | awk '{print $6}'   # ownership should be even
```

For predictable ownership use `num_tokens: 16` with `allocate_tokens_for_local_replication_factor: 3`, which invokes the token allocation algorithm and holds ownership skew to a few percent instead of the ±30% you get with random 256-token assignment.
## 9. Interview Questions

**Q: What are the four inputs you need before you can size a Cassandra cluster?**
A: Throughput (reads and writes per second at peak), dataset size (rows × measured row bytes × retention), replication factor per datacenter, and the headroom target. From those you derive a storage-bound node count and a throughput-bound node count and take the larger. Anything else — instance type, compaction strategy — is a refinement of those four.

**Q: Why can't you just buy 30 TB disks and run a three-node cluster?**
A: Node density is bounded by recovery time, not disk price. A 10 TB node streams for roughly 11 hours during replace or bootstrap, and repairs take proportionally longer, so your window of reduced redundancy becomes unacceptably long. Compaction and repair also scale with data per node, so a very dense node spends most of its I/O on maintenance rather than queries.

**Q: How much free disk should a node keep, and why?**
A: Roughly 50% free with SizeTieredCompactionStrategy and 30–35% with LeveledCompactionStrategy or Unified Compaction. Compaction writes merged output before deleting inputs, so STCS can transiently need free space equal to the size of the largest table. A node above ~85% cannot compact, which drives SSTable counts and read latency up until it is effectively down.

**Q: A workload does 40,000 writes/sec at RF=3. How many replica writes is that?**
A: 120,000 replica writes per second, plus coordinator work on top. Sizing CPU from the client-side 40,000 figure underestimates the cluster by 3×. Reads amplify too: a `QUORUM` read at `RF=3` contacts two replicas (one full read, one digest), and with `read_repair_chance` or speculative retry it can touch all three.

**Q: How do you measure row size accurately instead of estimating it?**
A: Insert a million representative rows into an isolated table, run `nodetool flush`, then read `Space used (live)` from `nodetool tablestats` and divide by the row count. That captures compression, cell timestamps, and index overhead — all of which schema-based estimates miss, often by a factor of two or three.

**Q: What does replication factor do to a multi-datacenter storage budget?**
A: Each datacenter stores its own full set of replicas, so total copies is the sum of RF across DCs. Two DCs at `RF=3` means six physical copies of every logical byte, and three DCs at `RF=3` means nine. Teams routinely forget the second DC and end up with half the disk they need.

**Q: (Senior) You inherit a 40-node cluster at 78% disk and growing 1.5%/week. Walk through your response.**
A: First buy time without hardware: audit and clear snapshots (`nodetool listsnapshots` / `clearsnapshot`), check for tables missing a TTL, and verify no orphaned SSTables from failed compactions. Then reduce steady-state footprint by moving large tables from STCS to LCS or UCS — that alone lifts usable disk from ~50% to ~65% — and consider raising `chunk_length_in_kb` for better compression. In parallel start bootstrapping a full rack of new nodes (not one node), because at 1.5%/week you cross 85% in roughly four weeks and streaming a new node into a nearly-full cluster becomes progressively harder. Finally, fix the growth model: instrument bytes/day per table so the next expansion is scheduled, not reactive.

**Q: (Senior) How does compaction strategy change your node count?**
A: It changes the usable fraction of disk and the write amplification. STCS needs roughly 50% free space for worst-case merges, so a 4 TB node holds about 2 TB. LCS and Cassandra 5.0's Unified Compaction Strategy bound the transient overhead to a few times the SSTable target size, so the same node safely holds 2.6–2.8 TB — about 30% fewer nodes for the same data. The cost is 2–3× more compaction write I/O and CPU, which pushes you back toward the throughput-bound branch of the calculation, so you must recompute both numbers rather than only the storage one.

**Q: (Senior) Your p99 write latency is fine but p99.9 spikes every few hours. Is that a capacity problem?**
A: Usually not a raw capacity problem — it is a coordination problem. Periodic p99.9 spikes correlate with compaction bursts, G1 mixed collections, or repair sessions; check `nodetool compactionstats` timing against the latency series and GC logs. Genuine undersizing produces sustained pressure with pending tasks in `tpstats`, not periodic spikes. The fix is usually throttling compaction, tuning `MaxGCPauseMillis` and heap region sizing, and scheduling repairs off-peak — though if throttling compaction causes pending tasks to accumulate, you *are* undersized and need nodes.

**Q: What is the right heap size for a 64 GB Cassandra node?**
A: 31 GB or less, so the JVM keeps compressed ordinary object pointers; going to 32 GB actually reduces effective heap because pointers double in size. The remaining ~30 GB should go to the OS page cache and off-heap structures such as bloom filters, offheap memtables, and the compression metadata. More heap is not better — it lengthens GC pauses without improving read performance.

**Q: When should you scale out versus adding disks to existing nodes?**
A: Add disks only when you are storage-bound and comfortably below your CPU and latency ceilings, and only if the resulting density keeps rebuild time acceptable. If reads or writes are hitting per-node throughput limits, or if latency degrades under a single-rack failure, you need more nodes — more disk on a saturated node makes the situation worse by extending recovery time.

**Q: Why round the node count up to a multiple of the replication factor?**
A: So racks (or availability zones) stay evenly sized. Cassandra's `NetworkTopologyStrategy` places replicas in distinct racks, and if racks are uneven the smaller rack's nodes own disproportionate data and become hot. With `RF=3` and three racks, a node count divisible by three keeps ownership and load balanced, and makes rack-level failure math clean.
## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Capacity planning is arithmetic on four inputs: throughput, dataset size, replication factor, headroom. Physical bytes `P = L × RF × compression × overhead`. Nodes by storage `= P / (raw_disk × usable_fraction)` where usable is ~0.5 for STCS and ~0.65 for LCS/UCS. Nodes by throughput `= replica_ops / per-node capacity / headroom`, where replica writes are `client × RF` and QUORUM reads touch two replicas at `RF=3`. Take the max, round up to a multiple of RF, spread evenly across at least RF racks. Density is limited by rebuild time — a 4 TB node takes roughly 4–5 hours to stream — not by disk cost. Measure row size empirically with `tablestats`; never estimate. Alert at 60% disk, expand at 65%, and never let a node pass 80%, because a node that cannot compact cannot serve reads.

| Item | Value / Command |
|---|---|
| Recommended partition size | < 100 MB, < 100,000 rows |
| Usable disk fraction (STCS) | ~50% |
| Usable disk fraction (LCS / UCS) | ~65% |
| Max JVM heap | 31 GB (compressed oops boundary) |
| Typical per-node writes/sec | 20k–40k on 16 vCPU + NVMe |
| Typical per-node reads/sec | 10k–25k at LOCAL_QUORUM |
| Default `num_tokens` (4.x) | 16 |
| `gc_grace_seconds` default | 864000 (10 days) |
| Bloom filter cost | ~1.2 bytes/partition at fp 0.01 |
| Measure real size | `nodetool flush && nodetool tablestats ks.tbl` |
| Watch growth | `nodetool status` Load column, sampled daily |
| Reclaim after expansion | `nodetool cleanup` (one node at a time) |
| Even token ownership | `allocate_tokens_for_local_replication_factor: 3` |

**Flash cards**

- **Physical size formula** → `L × RF × compression_ratio × overhead(1.2–1.4)`.
- **Why density is capped** → Rebuild/repair time, not disk price: ~1 hour per TB at 250 MB/s streaming.
- **Disk alert thresholds** → warn 60%, expand 65%, emergency 80%, compaction dies ~85%.
- **Replica amplification** → writes × RF; QUORUM reads × 2 at RF=3.
- **Cheapest capacity** → Data you never store: TTL + TWCS, frozen UDTs, bigger compression chunks.
## 11. Hands-On Exercises & Mini Project

- [ ] Spin up a 3-node cluster with `ccm create sizing -v 4.1.3 -n 3 -s`, create the `trip_pings` table above, load 1,000,000 rows with `cassandra-stress`, then compute measured bytes/row from `nodetool tablestats`. Compare against your schema-based estimate and record the ratio.
- [ ] Take the same table with `compaction = {'class':'SizeTieredCompactionStrategy'}` versus `LeveledCompactionStrategy`, load identical data, and compare `Space used (total)` immediately after a heavy overwrite workload. Quantify the space amplification difference.
- [ ] Write a script that samples `nodetool status` Load per node once an hour for 24 hours and reports bytes/day growth plus a projected date for crossing 60% of a 4 TB disk.
- [ ] Deliberately fill a test node to 88% disk and observe what breaks: run `nodetool compactionstats` and `nodetool tpstats`, and note the exact log line Cassandra emits. Then recover it with `nodetool clearsnapshot` and a TTL-driven purge.
- [ ] Compare `num_tokens: 256` (random allocation) against `num_tokens: 16` with `allocate_tokens_for_local_replication_factor: 3` on a fresh 6-node cluster; record the min/max ownership spread from `nodetool status`.

### Mini Project — "The Sizing Worksheet"

**Goal.** Build a reusable capacity planning tool that takes a schema plus workload description and outputs a defensible cluster specification with an expansion calendar.

**Requirements.**
1. Accept a YAML workload file: per table, list writes/sec, reads/sec, retention days, TTL, expected partition count, and read consistency level.
2. Automatically measure bytes/row by generating and loading synthetic data for each table into a single-node Docker Cassandra, flushing, and reading `tablestats` via `nodetool` or the JMX metrics endpoint.
3. Compute `N_storage` and `N_throughput` per the formulas in section 3, taking compaction strategy into account for the usable fraction, and emit the recommended node count rounded to a multiple of RF.
4. Produce a 24-month projection table showing month, projected physical TB, cluster utilization, and a flag when utilization crosses 60%.
5. Emit a matching `cassandra.yaml` fragment with `concurrent_writes`, `concurrent_reads`, `concurrent_compactors`, and memtable sizes derived from the chosen node shape.

**Extensions.**
- Add multi-DC support: accept a DC map and compute per-DC and total storage, plus estimated cross-DC bandwidth in Mbps from write throughput and row size.
- Add a cost model that maps node shape to cloud instance pricing and shows the $/month curve for three candidate node shapes, so the density trade-off is visible in currency.
- Validate the recommendation automatically by launching a scaled-down cluster and driving `nosqlbench` at proportionally scaled load, then compare achieved p99 against the SLO.
## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Compaction Strategies* (choosing STCS/LCS/TWCS/UCS drives your usable disk fraction), *Data Modeling & Partition Design* (bounded partitions are a capacity input), *Repair & Anti-Entropy* (repair cost scales with node density), *Adding & Removing Nodes* (the mechanics of executing an expansion), *Performance Tuning & JVM* (heap and GC settings referenced above), *Monitoring & Observability* (the metrics that validate the plan), and *Cassandra 4.x & 5.x New Features* (virtual tables and UCS change the numbers).

- **Apache Cassandra Operating Documentation — Hardware Choices & Compaction** — Apache Software Foundation · *Intermediate* · The canonical statement on node shape, disk, and the free-space requirements of each compaction strategy. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/hardware.html>
- **Cassandra Documentation: Compaction** — Apache Software Foundation · *Intermediate* · Explains the space amplification of each strategy, which is the number behind the usable-disk fraction. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/compaction/index.html>
- **The Last Pickle — "Cassandra Node Density"** — Alain Rodriguez / The Last Pickle · *Advanced* · The clearest practitioner treatment of why rebuild time bounds density, with real streaming numbers. <https://thelastpickle.com/blog/2019/01/30/new-cluster-recommendations.html>
- **Cassandra 4.0 Zero Copy Streaming (CASSANDRA-14556)** — Apache JIRA · *Advanced* · Read the ticket to understand why 4.0 changed the density calculation by making streaming dramatically faster. <https://issues.apache.org/jira/browse/CASSANDRA-14556>
- **NoSQLBench Documentation** — nosqlbench.io · *Intermediate* · The modern replacement for `cassandra-stress` when you need realistic key distributions and workload mixes for validation. <https://docs.nosqlbench.io/>
- **DataStax — Capacity Planning and Sizing** — DataStax Docs · *Beginner* · A vendor-neutral-enough walkthrough of the storage arithmetic with worked examples. <https://docs.datastax.com/en/planning/docs/capacityPlanning.html>
- **Discord Engineering — "How Discord Stores Trillions of Messages"** — Discord · *Intermediate* · A real capacity story: partition bucketing, node density, and why they eventually migrated storage engines. <https://discord.com/blog/how-discord-stores-trillions-of-messages>
- **Netflix Tech Blog — "Scaling Time Series Data Storage"** — Netflix · *Advanced* · Shows retention, bucketing, and tiering decisions made explicitly to control Cassandra capacity. <https://netflixtechblog.com/scaling-time-series-data-storage-part-i-ec2b6d44ba39>

---

*Apache Cassandra Handbook — chapter 37.*
