# 21 · The Write Path: Commit Log, Memtable & SSTable

> **In one line:** A Cassandra write is a sequential append to the commit log plus an in-memory sorted-map insert — no read, no seek, no in-place update — and the memtable is later flushed into an immutable SSTable, which is why writes are O(1)-ish and stay fast as the dataset grows.

---

## 1. Overview

Ask why Cassandra writes are fast and the honest answer is: because a write never reads. There is no B-tree page to locate and split, no row to fetch and modify, no unique constraint to check, no foreign key to validate. A mutation arrives, gets appended to a commit-log segment, gets merged into an in-memory sorted structure, and is acknowledged. Everything expensive — sorting, merging, deduplication, deletion — is deferred to background compaction (Chapter 23) or to read time (Chapter 22).

This is the **Log-Structured Merge tree (LSM-tree)**, published by O'Neil et al. in 1996 and adopted by Bigtable, then Cassandra, then RocksDB, then essentially every modern write-heavy store. The problem it solves is mechanical: on spinning disks a random write costs a seek (~10 ms); on SSDs a random write costs a read-modify-write of a flash page and burns endurance. Sequential appends avoid both. The LSM bargain is explicit — pay less on write, pay more on read (you may have to check several SSTables), and pay a background cost in compaction I/O to keep read amplification bounded.

The three structures are simple individually. The **commit log** is an append-only, crash-recovery journal shared by all tables on the node; nothing else reads it during normal operation. The **memtable** is a per-table in-memory map keyed by partition key then clustering key, so data is already sorted before it ever hits disk. The **SSTable** (Sorted String Table) is what a memtable becomes when flushed: a set of immutable files — `Data.db`, `Index.db`, `Filter.db`, `Summary.db`, `Statistics.db`, `CompressionInfo.db` — that are never modified again, only merged away by compaction or deleted wholesale.

Immutability is the load-bearing design choice. Because SSTables never change, they need no locking, can be safely read by many threads, can be page-cached aggressively, can be snapshotted with a hard link (`nodetool snapshot` is nearly instantaneous), and can be streamed to another node byte-for-byte during bootstrap. The cost is that an "update" is just another version of a cell with a newer timestamp, and a "delete" is a tombstone (Chapter 24) — the truth about a row only emerges when versions are merged.

Concretely: Netflix's Cassandra fleet absorbs write rates in the millions of operations per second per cluster, and Discord ingested billions of messages this way. Messages are append-only, partitioned by channel and bucketed by time, so every write lands at the end of a partition, memtables flush cleanly, and compaction has almost nothing to reconcile. That workload shape — write-heavy, immutable, time-ordered — is exactly what the LSM write path was designed to eat.

## 2. Core Concepts

- **Mutation** — the unit of write: a partition key plus a set of cell updates/deletions with client-visible timestamps, applied atomically per partition on a replica.
- **Commit log** — a shared, append-only, per-node journal (`commitlog_directory`) used only for crash recovery; segments are 32 MB by default.
- **Commit log segment** — a fixed-size file that is recycled or deleted once every memtable containing its mutations has been flushed.
- **Memtable** — a per-table in-memory structure (a concurrent skip-list-ish trie in 4.x) sorted by partition token, then clustering key.
- **Flush** — writing a memtable's contents sequentially to a new SSTable and marking the corresponding commit-log segments as clean.
- **SSTable** — an immutable, sorted set of on-disk files produced by a flush or a compaction; never updated in place.
- **`commitlog_sync`** — `periodic` (fsync every 10 s, acknowledge immediately) or `batch`/`group` (acknowledge only after fsync). This is the durability/latency dial.
- **Write timestamp** — the microsecond timestamp attached to every cell; conflict resolution is last-write-wins on this value, per cell.
- **CommitLogPosition / ReplayPosition** — the offset recorded with each memtable so replay knows exactly which segments still matter.
- **`durable_writes`** — a keyspace-level flag; setting it false skips the commit log entirely (used only for fully rebuildable keyspaces).

## 3. Theory & Internals

### What happens on a replica, in order

```
Mutation arrives
  → Keyspace.apply()
      → CommitLog.add(mutation)          sequential append, returns CommitLogPosition
      → Memtable.put(partitionKey, row)  concurrent insert into sorted in-memory map
      → return ACK to coordinator
```

Two things matter. First, the order: the commit-log append happens **before** the memtable insert, so a crash between them loses nothing that was acknowledged. Second, both operations are effectively O(log n) at worst and touch no disk seeks. The commit log is one file handle being appended to; the memtable is RAM.

### Durability: the `commitlog_sync` decision

| Mode | Behaviour | Latency | Loss window on power failure |
| --- | --- | --- | --- |
| `periodic` (default) | Append to page cache, background fsync every `commitlog_sync_period` (10 s), ACK immediately | ~0.2 ms | up to 10 s of writes on that node |
| `batch` | ACK only after the write is fsynced | ~1–5 ms (disk-bound) | none |
| `group` (4.0+) | fsync every `commitlog_sync_group_window` (e.g. 2 ms), ACK after | ~2–4 ms | up to the window |

The default looks alarming until you remember RF. With RF=3 and `LOCAL_QUORUM`, losing 10 seconds of commit log on one node loses nothing durable — two other replicas have it, and repair/hints heal the third. `batch` mode only becomes necessary when you genuinely cannot tolerate correlated power loss across a rack.

### When does a memtable flush?

Flush is triggered by whichever fires first:

- **Heap/offheap pressure** — `memtable_heap_space` / `memtable_offheap_space` default to 1/4 of heap; when total memtable usage crosses `memtable_cleanup_threshold` (default `1/(memtable_flush_writers + 1)`), the *largest* memtable is flushed.
- **Commit log size** — `commitlog_total_space` (default min(8 GB, 1/4 of the commit-log volume)). When exceeded, Cassandra flushes whichever memtables hold the oldest un-flushed mutations so segments can be recycled.
- **Time** — `memtable_flush_period_in_ms` per table (default 0 = disabled).
- **Explicit** — `nodetool flush`, `nodetool drain`, snapshot, or a schema change.

### Write amplification math

A row written once is physically written: 1× to the commit log, 1× on flush, then once per compaction that touches it. With SizeTieredCompactionStrategy a row is rewritten roughly `log_4(N)` times as it ages through tiers; with LeveledCompactionStrategy the constant is much higher (~10× typical) but read amplification is far lower. This is the core LSM trade: **write amplification buys read amplification back**.

```
STCS write amp  ≈  1 (commit log) + 1 (flush) + ~log4(dataset/memtable) rewrites
LCS  write amp  ≈  1 + 1 + ~10x   (but ≤ 1 SSTable per level per read, ~90% of reads hit 1 SSTable)
```

```svg
<svg viewBox="0 0 660 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="320" fill="#eef2ff"/>
  <text x="18" y="26" font-size="15" fill="#1e293b" font-weight="bold">The write path on a single replica</text>
  <rect x="20" y="120" width="86" height="46" rx="7" fill="#ffffff" stroke="#4f46e5" stroke-width="1.7"/>
  <text x="36" y="148" font-size="12" fill="#1e293b">mutation</text>
  <rect x="140" y="60" width="150" height="60" rx="7" fill="#fef3c7" stroke="#d97706" stroke-width="1.9"/>
  <text x="153" y="82" font-size="12" fill="#1e293b" font-weight="bold">commit log</text>
  <text x="153" y="100" font-size="10" fill="#1e293b">append only, 32 MB segs</text>
  <text x="153" y="114" font-size="10" fill="#1e293b">crash recovery only</text>
  <rect x="140" y="150" width="150" height="72" rx="7" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.9"/>
  <text x="153" y="172" font-size="12" fill="#1e293b" font-weight="bold">memtable (RAM)</text>
  <text x="153" y="190" font-size="10" fill="#1e293b">sorted by token,</text>
  <text x="153" y="204" font-size="10" fill="#1e293b">then clustering key</text>
  <text x="153" y="218" font-size="10" fill="#1e293b">per table</text>
  <line x1="106" y1="136" x2="140" y2="98" stroke="#d97706" stroke-width="1.8" marker-end="url(#w21a)"/>
  <text x="94" y="70" font-size="10" fill="#d97706">1. append</text>
  <line x1="106" y1="150" x2="140" y2="178" stroke="#0ea5e9" stroke-width="1.8" marker-end="url(#w21b)"/>
  <text x="70" y="200" font-size="10" fill="#0ea5e9">2. insert</text>
  <text x="70" y="216" font-size="10" fill="#16a34a">3. ACK</text>
  <rect x="360" y="150" width="130" height="72" rx="7" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.9"/>
  <text x="373" y="172" font-size="12" fill="#1e293b" font-weight="bold">SSTable</text>
  <text x="373" y="190" font-size="10" fill="#1e293b">immutable, sorted</text>
  <text x="373" y="204" font-size="10" fill="#1e293b">sequential write</text>
  <line x1="290" y1="186" x2="360" y2="186" stroke="#16a34a" stroke-width="2.2" marker-end="url(#w21c)"/>
  <text x="292" y="178" font-size="10" fill="#16a34a">flush</text>
  <line x1="290" y1="90" x2="420" y2="90" stroke="#d97706" stroke-width="1.6" stroke-dasharray="5 4" marker-end="url(#w21a)"/>
  <text x="300" y="82" font-size="10" fill="#d97706">segment marked clean after flush</text>
  <rect x="520" y="150" width="120" height="72" rx="7" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.3"/>
  <text x="532" y="172" font-size="11" fill="#1e293b">more SSTables</text>
  <text x="532" y="190" font-size="10" fill="#1e293b">merged later by</text>
  <text x="532" y="204" font-size="10" fill="#1e293b">compaction</text>
  <line x1="490" y1="186" x2="520" y2="186" stroke="#16a34a" stroke-width="1.6" marker-end="url(#w21c)"/>
  <text x="20" y="262" font-size="11" fill="#1e293b">No read, no seek, no in-place update. Both hot-path steps are RAM or a sequential append.</text>
  <text x="20" y="282" font-size="11" fill="#1e293b">Crash before flush: replay the dirty commit-log segments to rebuild the memtable exactly.</text>
  <text x="20" y="302" font-size="11" fill="#1e293b">durable_writes=false skips step 1 entirely and forfeits crash recovery.</text>
  <defs>
    <marker id="w21a" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#d97706"/></marker>
    <marker id="w21b" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#0ea5e9"/></marker>
    <marker id="w21c" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#16a34a"/></marker>
  </defs>
</svg>
```

### Anatomy of an SSTable (BIG format, 4.x)

```
nb-1247-big-Data.db             rows, partition-ordered, block-compressed
nb-1247-big-Index.db            partition key -> offset in Data.db (+ clustering index)
nb-1247-big-Summary.db          in-memory sample of Index.db (every 128th entry)
nb-1247-big-Filter.db           bloom filter over partition keys
nb-1247-big-CompressionInfo.db  chunk offsets for the LZ4/Zstd compressed Data.db
nb-1247-big-Statistics.db       min/max clustering, timestamps, TTLs, droppable tombstone estimate
nb-1247-big-TOC.txt             component list        nb-1247-big-Digest.crc32   checksum
```

Cassandra 5.0 adds the **BTI** (big trie-indexed) format, replacing `Index.db`+`Summary.db` with a trie-based index that is smaller in memory and faster for very wide partitions.

## 4. Architecture & Workflow

The full journey of one `INSERT` at `LOCAL_QUORUM`, RF=3:

1. **Client → coordinator.** A token-aware driver hashes the partition key and sends the statement straight to a natural replica in the local DC.
2. **Coordinator computes replicas.** `Murmur3Partitioner` → token → `NetworkTopologyStrategy.getNaturalReplicas()` → three endpoints (Chapter 19).
3. **Coordinator dispatches mutations** to all three replicas in parallel over `MessagingService`, and starts a `write_request_timeout` (2 s) clock.
4. **Each replica appends to the commit log.** The mutation is serialized into the active 32 MB segment. In `periodic` mode it lands in the page cache and returns immediately; in `batch`/`group` mode the thread waits for fsync.
5. **Each replica inserts into the memtable.** The row is merged into the per-table sorted map. If a cell for that column already exists, the higher client timestamp wins — resolution happens per cell, right here.
6. **Replica ACKs.** The coordinator counts responses; at `LOCAL_QUORUM` it returns success after 2.
7. **Unreachable replicas become hints.** Any replica that timed out or was DOWN gets a hint on the coordinator, replayed for up to `max_hint_window` (3 h).
8. **Flush, eventually.** When memtable/commit-log thresholds trip, the memtable is switched out (writes continue into a fresh one) and the frozen copy is written sequentially to a new SSTable by a `MemtableFlushWriter` thread.
9. **Commit log segments recycle.** Once every memtable referencing a segment has flushed, the segment is marked clean and deleted or reused. This is why commit-log disk usage stays bounded.
10. **Compaction merges SSTables** in the background, discarding superseded cells and (after `gc_grace_seconds`) purgeable tombstones.
11. **On crash and restart**, `CommitLogReplayer` reads all dirty segments, filters mutations by each table's persisted `CommitLogPosition`, and rebuilds the memtables exactly as they were.

```svg
<svg viewBox="0 0 660 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="340" fill="#e0f2fe"/>
  <text x="18" y="26" font-size="15" fill="#1e293b" font-weight="bold">Coordinator fan-out and the LSM staircase</text>
  <rect x="20" y="60" width="90" height="42" rx="6" fill="#ffffff" stroke="#4f46e5" stroke-width="1.6"/>
  <text x="38" y="86" font-size="12" fill="#1e293b">client</text>
  <rect x="145" y="60" width="110" height="42" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.9"/>
  <text x="157" y="86" font-size="11" fill="#1e293b">coordinator</text>
  <line x1="110" y1="81" x2="145" y2="81" stroke="#4f46e5" stroke-width="1.7" marker-end="url(#x21)"/>
  <rect x="300" y="40" width="100" height="32" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="312" y="61" font-size="11" fill="#1e293b">replica 1</text>
  <rect x="300" y="80" width="100" height="32" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="312" y="101" font-size="11" fill="#1e293b">replica 2</text>
  <rect x="300" y="120" width="100" height="32" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="312" y="141" font-size="11" fill="#1e293b">replica 3</text>
  <line x1="255" y1="76" x2="300" y2="56" stroke="#16a34a" stroke-width="1.5" marker-end="url(#x21b)"/>
  <line x1="255" y1="81" x2="300" y2="96" stroke="#16a34a" stroke-width="1.5" marker-end="url(#x21b)"/>
  <line x1="255" y1="88" x2="300" y2="136" stroke="#16a34a" stroke-width="1.5" marker-end="url(#x21b)"/>
  <text x="415" y="62" font-size="10" fill="#1e293b">ACK</text>
  <text x="415" y="102" font-size="10" fill="#1e293b">ACK  -&gt; LOCAL_QUORUM satisfied at 2</text>
  <text x="415" y="142" font-size="10" fill="#1e293b">slow -&gt; hint stored, replayed later</text>
  <text x="20" y="190" font-size="13" fill="#1e293b" font-weight="bold">Inside one replica over time</text>
  <rect x="20" y="205" width="120" height="30" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.7"/>
  <text x="32" y="225" font-size="11" fill="#1e293b">memtable (RAM)</text>
  <rect x="180" y="205" width="90" height="30" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="192" y="225" font-size="11" fill="#1e293b">sst L0 a</text>
  <rect x="280" y="205" width="90" height="30" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="292" y="225" font-size="11" fill="#1e293b">sst L0 b</text>
  <rect x="380" y="205" width="90" height="30" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="392" y="225" font-size="11" fill="#1e293b">sst L0 c</text>
  <line x1="140" y1="220" x2="180" y2="220" stroke="#16a34a" stroke-width="1.8" marker-end="url(#x21b)"/>
  <text x="140" y="212" font-size="9" fill="#16a34a">flush</text>
  <rect x="180" y="262" width="290" height="34" rx="5" fill="#fef3c7" stroke="#d97706" stroke-width="1.8"/>
  <text x="196" y="284" font-size="11" fill="#1e293b">one merged SSTable: superseded cells dropped</text>
  <line x1="225" y1="235" x2="255" y2="262" stroke="#d97706" stroke-width="1.5" marker-end="url(#x21c)"/>
  <line x1="325" y1="235" x2="325" y2="262" stroke="#d97706" stroke-width="1.5" marker-end="url(#x21c)"/>
  <line x1="425" y1="235" x2="395" y2="262" stroke="#d97706" stroke-width="1.5" marker-end="url(#x21c)"/>
  <text x="490" y="284" font-size="10" fill="#d97706">compaction</text>
  <text x="20" y="322" font-size="11" fill="#1e293b">Each SSTable is written once, sequentially, and never modified again.</text>
  <defs>
    <marker id="x21" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#4f46e5"/></marker>
    <marker id="x21b" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#16a34a"/></marker>
    <marker id="x21c" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#d97706"/></marker>
  </defs>
</svg>
```

## 5. Implementation

### Config that governs the write path

```yaml
# cassandra.yaml (4.1 syntax with units)
commitlog_directory: /var/lib/cassandra/commitlog   # SEPARATE physical device from data
data_file_directories:
  - /var/lib/cassandra/data
commitlog_sync: periodic
commitlog_sync_period: 10000ms
commitlog_segment_size: 32MiB
commitlog_total_space: 8192MiB
commitlog_compression:
  - class_name: LZ4Compressor

memtable_allocation_type: offheap_objects   # keeps memtables out of the GC heap
memtable_heap_space: 2048MiB
memtable_offheap_space: 2048MiB
memtable_flush_writers: 4                   # ~= number of data disks
concurrent_writes: 128                      # ~8 * number of cores
write_request_timeout: 2000ms
```

> **Note:** Putting the commit log on the same device as data is the single most common write-path misconfiguration. The commit log is pure sequential I/O; SSTable flush and compaction are heavy sequential I/O. Sharing a device makes them contend and turns 0.2 ms appends into 20 ms appends.

### CQL: writes, timestamps, and TTL

```cql
CREATE KEYSPACE telemetry WITH replication =
  {'class':'NetworkTopologyStrategy','dc_east':3};

CREATE TABLE telemetry.readings (
  sensor_id   text,
  bucket      text,          -- e.g. '2026-07-22' : bounds the partition
  ts          timestamp,
  value       double,
  PRIMARY KEY ((sensor_id, bucket), ts)
) WITH CLUSTERING ORDER BY (ts DESC)
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS',
                    'compaction_window_size':1}
  AND compression = {'class':'LZ4Compressor', 'chunk_length_in_kb':16}
  AND default_time_to_live = 2592000;   -- 30 days

-- An INSERT and an UPDATE are the same operation: an upsert of cells.
INSERT INTO telemetry.readings (sensor_id, bucket, ts, value)
VALUES ('sen-4471', '2026-07-22', '2026-07-22T09:14:02Z', 21.7);

-- Explicit timestamp: last-write-wins is decided per CELL on this value.
UPDATE telemetry.readings USING TIMESTAMP 1753168442000000
SET value = 21.9
WHERE sensor_id='sen-4471' AND bucket='2026-07-22' AND ts='2026-07-22T09:14:02Z';

-- Inspect what the server recorded
SELECT ts, value, WRITETIME(value), TTL(value)
FROM telemetry.readings WHERE sensor_id='sen-4471' AND bucket='2026-07-22' LIMIT 1;
--  ts                        | value | writetime(value) | ttl(value)
--  2026-07-22 09:14:02+0000  | 21.9  | 1753168442000000 |    2591988
```

### Observing flush and commit log

```bash
# Force a flush and watch the SSTable appear
nodetool flush telemetry readings
ls -1 /var/lib/cassandra/data/telemetry/readings-*/
# nb-1-big-Data.db  nb-1-big-Index.db  nb-1-big-Filter.db  nb-1-big-Summary.db
# nb-1-big-Statistics.db  nb-1-big-CompressionInfo.db  nb-1-big-TOC.txt

nodetool tablestats telemetry.readings
# Table: readings
#   Memtable cell count: 184291
#   Memtable data size: 12849104
#   Memtable switch count: 47
#   Local write count: 9128441
#   Local write latency: 0.031 ms
#   SSTable count: 6
#   Space used (live): 4183925712
#   Compression ratio: 0.212

# Per-thread-pool view: FlushWriter Pending > 0 sustained means flush is the bottleneck
nodetool tpstats | grep -E 'MemtableFlushWriter|MutationStage|Native-Transport'
# MutationStage            0    0    9128441   0    0
# MemtableFlushWriter      1    3         47   0    0    <- 3 pending: disk cannot keep up

# Commit log health
nodetool getcommitlogsize   # not a real command; use the filesystem + JMX instead
du -sh /var/lib/cassandra/commitlog
# 4.1G   /var/lib/cassandra/commitlog     (bounded by commitlog_total_space)

# Clean shutdown: flush everything and stop accepting writes
nodetool drain
```

### Driver: prepared statements and async batching of *independent* writes

```python
from cassandra.cluster import Cluster
from cassandra import ConsistencyLevel
from cassandra.query import BatchStatement, BatchType
import itertools

session = Cluster(["10.0.1.14"]).connect("telemetry")

# Prepare once. Prepared statements skip parsing AND let the driver route
# token-aware, saving a coordinator hop on every write.
ins = session.prepare(
    "INSERT INTO readings (sensor_id, bucket, ts, value) VALUES (?, ?, ?, ?)"
)
ins.consistency_level = ConsistencyLevel.LOCAL_QUORUM

# CORRECT high-throughput pattern: many independent async writes, bounded concurrency.
futures = []
for sensor, ts, val in rows:                       # rows: your data source
    futures.append(session.execute_async(ins, (sensor, ts.date().isoformat(), ts, val)))
    if len(futures) >= 512:                        # bound in-flight requests
        for f in futures: f.result()
        futures.clear()
for f in futures: f.result()

# WRONG: a logged batch across many partitions. It does NOT make writes faster -
# it forces one coordinator to fan out everything and writes a batchlog entry
# to two other nodes first. Use UNLOGGED + same-partition only, if at all.
bad = BatchStatement(batch_type=BatchType.LOGGED)
```

```java
PreparedStatement ins = session.prepare(
    "INSERT INTO readings (sensor_id, bucket, ts, value) VALUES (?,?,?,?)");
BoundStatement bs = ins.bind("sen-4471", "2026-07-22", Instant.now(), 21.7)
        .setConsistencyLevel(DefaultConsistencyLevel.LOCAL_QUORUM);
session.executeAsync(bs);
```

**Optimization:** three levers, in order of impact. (1) Put `commitlog_directory` on its own device — often a 5–10× improvement in write p99 on spinning disks and a meaningful one on shared cloud volumes. (2) Set `memtable_allocation_type: offheap_objects`, which moves memtable data out of the Java heap, letting you run larger memtables (fewer, bigger flushes → fewer SSTables → less compaction) without lengthening GC pauses. (3) Use prepared statements with a token-aware policy so the coordinator *is* a replica, removing one network hop from every write.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
| --- | --- | --- |
| No read-before-write | O(1) writes, uniform latency, no hot-row locking | No unique constraints, no read-modify-write, no server-side increments (except counters) |
| Sequential commit log | ~0.1–0.3 ms appends, no seeks, SSD-friendly | Must live on a dedicated device or it contends with flush/compaction |
| Immutable SSTables | Lock-free reads, hard-link snapshots, byte-level streaming | Updates and deletes accumulate as extra versions until compaction |
| `commitlog_sync: periodic` | Sub-millisecond ACKs | Up to 10 s of writes lost on that node in a power failure (mitigated by RF) |
| Memtable in RAM | Recent data served without disk I/O | Bounded by heap/offheap; larger memtables mean longer crash replay |
| LSM structure | Write throughput scales linearly with nodes | Read amplification: a read may consult many SSTables (Chapter 22) |
| Per-cell timestamps | Conflict-free concurrent updates to different columns of a row | Clock skew directly corrupts last-write-wins; NTP is mandatory |
| `durable_writes: false` | Removes commit-log I/O entirely | A node restart loses everything not yet flushed — only for rebuildable data |

## 7. Common Mistakes & Best Practices

1. ⚠️ Commit log and data directories on the same device → ✅ Give the commit log its own disk/volume. Sequential append contending with compaction I/O is the classic cause of write p99 cliffs.
2. ⚠️ Using logged batches to "speed up" bulk loading → ✅ A logged batch writes a batchlog entry to two other nodes *before* the mutations, then makes one coordinator fan out to every partition's replicas. Use many async single-partition writes with bounded concurrency instead; only use `UNLOGGED` batches for rows sharing a partition key.
3. ⚠️ Read-modify-write loops (`SELECT`, mutate in the app, `UPDATE`) → ✅ This reintroduces the read cost the write path was designed to avoid, and it races. Model so writes are blind upserts, or use an LWT (`IF` clause) when you genuinely need compare-and-set — and accept its 4-round-trip Paxos cost.
4. ⚠️ Unbounded partitions ("all events for a sensor forever") → ✅ Add a time or hash bucket to the partition key. The write path does not care, but the memtable grows, flushes produce enormous partitions, and reads and compaction eventually collapse. Keep partitions under ~100 MB and ~100k rows.
5. ⚠️ Setting client-supplied `USING TIMESTAMP` from application wall clocks across many machines → ✅ Skewed clocks silently lose writes, because last-write-wins compares timestamps, not arrival order. Let the coordinator assign timestamps unless you have a specific reason, and run NTP everywhere regardless.
6. ⚠️ Turning `durable_writes: false` on a real keyspace to gain throughput → ✅ The gain is small (the commit log is sequential) and the risk is total: an unclean restart loses every unflushed mutation on that node. Only acceptable for keyspaces you can fully regenerate.
7. ⚠️ Giving Cassandra a 48 GB heap so memtables can be huge → ✅ Use 8–16 GB heap with `memtable_allocation_type: offheap_objects`. Large heaps produce long GC pauses that trigger gossip convictions (Chapter 20), which is a far worse outcome than an extra flush.
8. ⚠️ Ignoring `MemtableFlushWriter` pending in `nodetool tpstats` → ✅ Sustained pending flushes mean disk cannot absorb the write rate; commit-log space will hit its cap and writes will start blocking. Add `memtable_flush_writers`, faster disks, or reduce ingest.
9. ⚠️ Assuming an ACK at `ONE` means the data is safe → ✅ At `CL=ONE` with `commitlog_sync: periodic` you can lose an acknowledged write if that single node loses power within 10 s. Use `LOCAL_QUORUM` for anything that matters.
10. ⚠️ Running `nodetool flush` on a schedule to "keep memtables small" → ✅ This produces many tiny SSTables and multiplies compaction work. Let the thresholds do their job; only flush explicitly before a snapshot or a planned shutdown (`nodetool drain`).

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging
- `nodetool tablestats <ks>.<tbl>` gives local write latency, memtable size, switch count, and SSTable count — the first four numbers to look at.
- `nodetool tpstats`: `MutationStage` pending/blocked means the node cannot apply writes fast enough; `MemtableFlushWriter` pending means the disk cannot absorb flushes; `Dropped MUTATION` means writes were silently discarded after `write_request_timeout` (they will be repaired later, but the client may have seen success at a lower CL).
- `sstablemetadata nb-1247-big-Data.db` shows min/max timestamps, estimated droppable tombstones, and level — invaluable when reasoning about what a flush produced.
- Long startup times are almost always commit-log replay. Check `CommitLogReplayer` lines in `system.log`; the fix is smaller `commitlog_total_space` or more frequent flushes, not faster disks.

### Monitoring
- `org.apache.cassandra.metrics:type=ClientRequest,scope=Write,name=Latency` — p50/p99/p999 write latency at the coordinator.
- `type=Table,keyspace=*,scope=*,name=WriteLatency` — local (replica-side) write latency; if coordinator latency is high but local is low, the problem is the network or a slow peer.
- `type=CommitLog,name=PendingTasks` and `name=TotalCommitLogSize` — the latter approaching `commitlog_total_space` means forced flushes are imminent.
- `type=Table,name=MemtableOnHeapSize` / `MemtableOffHeapSize` / `MemtableSwitchCount`.
- `type=DroppedMessage,scope=MUTATION,name=Dropped` — any sustained non-zero value is a real availability problem.
- `type=ThreadPools,path=request,scope=MutationStage,name=PendingTasks`.

### Security
- The commit log contains plaintext mutations, including anything you consider sensitive. Cassandra's Transparent Data Encryption is a DataStax-Enterprise feature; on open-source Cassandra use full-disk encryption (LUKS, EBS encryption) for both `commitlog_directory` and `data_file_directories`.
- Snapshots are hard links to live SSTables — they inherit the same exposure, and `nodetool snapshot` output shipped to object storage must be encrypted in transit and at rest.
- Restrict filesystem permissions on the data and commit-log directories to the `cassandra` user; anyone who can read `Data.db` can read every row without authenticating.

### Performance & Scaling
- Write throughput scales close to linearly with node count because there is no coordination between partitions. Doubling nodes roughly doubles sustainable write rate, provided your partition keys are well distributed.
- The real ceiling is usually compaction, not the write path: if ingest outpaces `compaction_throughput` (default 64 MiB/s in 4.x), SSTable count climbs, reads degrade, and eventually you hit disk. Watch `nodetool compactionstats` pending tasks during load tests.
- NVMe changes the calculus: `commitlog_sync: batch` becomes affordable (fsync in tens of microseconds), and you can raise `concurrent_writes` and `memtable_flush_writers`.
- For bulk ingest, prefer `sstableloader` or CQLSSTableWriter to generate SSTables offline and stream them in — it bypasses the commit log and memtable entirely.

## 9. Interview Questions

**Q: Walk me through what happens on a replica when a write arrives.**
A: The mutation is appended to the commit log (a sequential write to the active 32 MB segment), then inserted into the table's in-memory memtable, which is sorted by partition token and clustering key, and then the replica acknowledges. No existing data is read and nothing is modified in place. Later, memtable pressure or commit-log size triggers a flush that writes the memtable sequentially into a new immutable SSTable.

**Q: Why are Cassandra writes fast?**
A: Because a write performs no read and no random I/O — it is one sequential append plus an in-memory insert. There is no B-tree page to find and split, no uniqueness check, no referential integrity, and no in-place update, so latency is roughly constant regardless of how much data the table already holds.

**Q: What is the commit log actually for, and when is it read?**
A: It is purely a crash-recovery journal. During normal operation nothing reads it; reads are served from the memtable and SSTables. It is read only at startup, when `CommitLogReplayer` replays segments that contain mutations not yet captured in a flushed SSTable, reconstructing the memtables that were lost.

**Q: What is the difference between `commitlog_sync: periodic` and `batch`?**
A: `periodic` writes into the page cache and fsyncs every 10 seconds while acknowledging immediately, giving sub-millisecond writes with up to a 10-second loss window per node on power failure. `batch` acknowledges only after the fsync completes, eliminating the loss window at the cost of disk-bound latency. With RF=3 and `LOCAL_QUORUM`, `periodic` is normally safe because two other replicas hold the data.

**Q: What triggers a memtable flush?**
A: Memtable heap/offheap usage crossing `memtable_cleanup_threshold`, total commit-log size exceeding `commitlog_total_space` (forcing the oldest dirty memtables out so segments can be recycled), a per-table `memtable_flush_period_in_ms`, or an explicit `nodetool flush`, `nodetool drain`, snapshot, or schema change.

**Q: Why are SSTables immutable, and what does that buy you?**
A: Immutability means no locking or coordination between readers and writers, safe aggressive page caching, snapshots as instant hard links, and byte-for-byte streaming during bootstrap and repair. The cost is that updates and deletes append new versions rather than modifying existing ones, so reads must merge and compaction must reclaim.

**Q: How does Cassandra resolve two concurrent updates to the same row?**
A: Per cell, by the microsecond write timestamp — the highest timestamp wins, with the cell value used as a deterministic tiebreaker. Because resolution is per column, two clients updating different columns of the same row both survive. This makes clock synchronization a correctness requirement, not just hygiene.

**Q: (Senior) Your write p99 jumped from 3 ms to 90 ms with no change in request rate. How do you diagnose it?**
A: Split coordinator latency from replica latency first: compare `ClientRequest.Write.Latency` with per-table `WriteLatency`. If local latency is fine, the problem is a slow peer or network — check `nodetool tpstats` for dropped MUTATIONs and gossip for flapping. If local latency is high, look at `MemtableFlushWriter` pending and `TotalCommitLogSize`; a full commit log forces synchronous flushes that block writes. Then check `nodetool compactionstats` (compaction starving the disk) and GC logs (a pause bubbling into write latency). The most common root cause in practice is compaction I/O contending with the commit log on a shared device.

**Q: (Senior) A node was killed with `kill -9`. Explain precisely what is and is not lost.**
A: Everything acknowledged and fsynced to the commit log survives; in `periodic` mode, up to `commitlog_sync_period` (10 s) of writes that only reached the page cache are lost on that node. On restart, `CommitLogReplayer` reads every segment not yet marked clean, discards mutations whose `CommitLogPosition` is already covered by a flushed SSTable, and replays the rest into fresh memtables. Cluster-wide, nothing is lost if RF ≥ 3 and the write met `LOCAL_QUORUM`, because at least one other replica has it; hints and repair converge the recovered node.

**Q: (Senior) When would you set `durable_writes: false`, and what breaks?**
A: Only for a keyspace whose contents can be fully regenerated from another source — a cache-like table, a derived analytics keyspace fed by a nightly Spark job, or a scratch keyspace. It skips the commit log, so a node that restarts uncleanly loses every mutation still sitting in a memtable, and there is no replay to recover it. The throughput gain is modest because the commit log is sequential anyway, so the risk rarely pays; the one place it genuinely helps is when the commit log has been forced onto the same device as data.

**Q: What is write amplification in Cassandra?**
A: The ratio of physical bytes written to logical bytes the client sent. Every row is written once to the commit log, once at flush, and again on every compaction that touches it — so with SizeTieredCompactionStrategy roughly `log₄(N)` extra rewrites as it ages, and with LeveledCompactionStrategy about 10× total. It is the price paid for sequential writes and low read amplification.

**Q: Why should the commit log be on its own device?**
A: The commit log is pure small sequential appends on the latency-critical path, while flushes and compaction are large sequential reads and writes. Sharing a device makes the disk head (or the volume's IOPS budget) alternate between them, turning sub-millisecond appends into tens of milliseconds and directly inflating write p99.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A write on a replica is: append to the commit log, insert into the memtable, ACK. That is it — no read, no seek, no in-place mutation, which is why latency is flat as data grows. The commit log is a shared per-node crash-recovery journal in 32 MB segments, read only at startup; `commitlog_sync: periodic` acknowledges before fsync (10 s loss window per node, covered by RF=3 + `LOCAL_QUORUM`), `batch` acknowledges after. The memtable is a per-table sorted map that flushes on heap/offheap pressure, commit-log space limits, or explicit `nodetool flush`, producing an immutable SSTable (`Data.db`, `Index.db`, `Filter.db`, `Summary.db`, `Statistics.db`). Immutability gives lock-free reads, instant hard-link snapshots, and byte-level streaming, at the cost of read amplification and background compaction. Conflicts resolve per cell by microsecond timestamp, so NTP is a correctness requirement.

| Item | Value / Command |
| --- | --- |
| Hot-path steps | commit-log append → memtable insert → ACK |
| `commitlog_segment_size` | 32 MiB |
| `commitlog_sync` | `periodic` / 10000 ms (default), or `batch`, or `group` |
| `commitlog_total_space` | min(8 GiB, ¼ of commit-log volume) |
| Memtable space | `memtable_heap_space` / `memtable_offheap_space`, ~¼ heap |
| Recommended allocation | `memtable_allocation_type: offheap_objects` |
| SSTable components | Data, Index, Summary, Filter, Statistics, CompressionInfo, TOC, Digest |
| Force a flush | `nodetool flush <ks> <tbl>` |
| Clean shutdown | `nodetool drain` |
| Key stats | `nodetool tablestats`, `nodetool tpstats` |
| Per-cell metadata | `SELECT WRITETIME(col), TTL(col) FROM …` |
| `write_request_timeout` | 2000 ms |

Flash cards:
- **Two hot-path operations of a write?** → Sequential commit-log append, then in-memory memtable insert. Then ACK.
- **When is the commit log read?** → Only at startup, by `CommitLogReplayer`, for segments not yet covered by a flushed SSTable.
- **What makes an SSTable immutable useful?** → Lock-free concurrent reads, instant hard-link snapshots, and byte-for-byte streaming for bootstrap and repair.
- **How is a conflicting update resolved?** → Per cell, highest microsecond write timestamp wins (value as tiebreaker) — so clock skew is data loss.
- **Biggest write-path misconfiguration?** → Commit log sharing a device with data, making flush/compaction I/O contend with latency-critical appends.

## 11. Hands-On Exercises & Mini Project

- [ ] Create a table, insert 10 rows, and run `ls` on its data directory — confirm no SSTable exists yet. Then run `nodetool flush` and list the 7–8 component files that appear.
- [ ] Insert a row, `kill -9` the node before flushing, restart it, and confirm the row is still readable. Then repeat with `durable_writes = false` and observe the row disappear.
- [ ] Run `cassandra-stress write n=2000000 -rate threads=64` while polling `nodetool tpstats` every second; capture the point at which `MemtableFlushWriter` pending becomes non-zero.
- [ ] Set `commitlog_sync: batch`, rerun the same stress test, and quantify the p99 write-latency difference on your hardware.
- [ ] Use `sstablemetadata` on two SSTables produced by consecutive flushes and compare their min/max timestamps to prove flushes partition data by time.

### Mini Project — An IoT ingestion pipeline that stays fast at 100 M rows

**Goal.** Build and instrument a write-optimized time-series table, then prove the write path stays flat as the dataset grows 100×.

**Requirements.**
1. Model `readings((sensor_id, day), ts)` with TWCS, `default_time_to_live` of 30 days, and `LZ4` compression at 16 KB chunks.
2. Write a Python producer using prepared statements, `TokenAwarePolicy`, `LOCAL_QUORUM`, and bounded async concurrency (512 in flight).
3. Load 1 M, 10 M, and 100 M rows; after each stage record p50/p99 write latency, SSTable count, `nodetool tablestats` memtable switch count, and total commit-log size.
4. Plot write latency against dataset size and show it is essentially flat — that is the LSM property, demonstrated.
5. Deliberately break it: remove the bucket from the partition key so one sensor becomes one unbounded partition, reload, and document exactly where it falls over.

**Extensions.**
- Move `commitlog_directory` onto the data volume and re-measure p99 to quantify the contention cost.
- Compare `memtable_allocation_type: heap_buffers` vs `offheap_objects` on GC pause distribution.
- Generate SSTables offline with `CQLSSTableWriter` and load them with `sstableloader`; compare total ingest wall time against the CQL path.

## 12. Related Topics & Free Learning Resources

Continue with **The Read Path** (how those SSTables are searched and merged), **Compaction Strategies** (what happens to SSTables afterwards), **Tombstones & Deletes** (why a delete is a write), and **Replication Strategies & Snitches** (how the coordinator chose these replicas).

- **Storage Engine — Apache Cassandra Documentation** — Apache Software Foundation · *Intermediate* · Definitive description of commit log, memtable, SSTable components and their on-disk format. <https://cassandra.apache.org/doc/latest/cassandra/architecture/storage-engine.html>
- **The Log-Structured Merge-Tree (LSM-Tree)** — O'Neil, Cheng, Gawlick, O'Neil · *Advanced* · The 1996 paper that defines the write-amplification/read-amplification trade Cassandra makes. <https://www.cs.umb.edu/~poneil/lsmtree.pdf>
- **Bigtable: A Distributed Storage System for Structured Data** — Chang et al. (Google) · *Advanced* · Where the SSTable, memtable, and commit-log vocabulary comes from; section 5.3 is the write path. <https://static.googleusercontent.com/media/research.google.com/en//archive/bigtable-osdi06.pdf>
- **Cassandra Configuration Reference (cassandra.yaml)** — Apache Software Foundation · *Intermediate* · Every commit-log and memtable knob with its real default and unit syntax. <https://cassandra.apache.org/doc/latest/cassandra/configuration/cass_yaml_file.html>
- **Understanding the Cassandra Write Path** — The Last Pickle · *Intermediate* · Practical walkthrough with real `tpstats` output and flush-tuning guidance. <https://thelastpickle.com/blog/2016/09/15/Cassandra-Write-Path.html>
- **How Discord Stores Billions of Messages** — Discord Engineering · *Intermediate* · A production write-heavy workload, bucketing strategy, and what actually hurt at scale. <https://discord.com/blog/how-discord-stores-billions-of-messages>
- **CASSANDRA-16404 / Trie Memtables and BTI SSTable format** — Apache JIRA · *Advanced* · The 5.0 storage-engine work replacing skip-list memtables and the BIG index format. <https://issues.apache.org/jira/browse/CASSANDRA-16404>
- **Scylla University: The Write Path and LSM Trees** — ScyllaDB · *Beginner* · Free animated course covering the same LSM mechanics, good for cementing the mental model. <https://university.scylladb.com/courses/scylla-essentials-overview/lessons/architecture/>

---

*Apache Cassandra Handbook — chapter 21.*
