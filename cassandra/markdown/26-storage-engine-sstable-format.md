# 26 · Storage Engine & SSTable Format

> **In one line:** Cassandra's storage engine is a log-structured merge tree — commit log for durability, memtable for writes, and immutable SSTables on disk composed of Data, Index, Summary, Filter, CompressionInfo, Statistics, Digest and TOC components that together make a partition lookup a handful of I/Os.

---

## 1. Overview

Every performance characteristic Cassandra has — fast writes, tunable read latency, compaction pressure, tombstone pain, the demand that you model queries first — falls directly out of one design decision: **data on disk is immutable**. A write never seeks to a row and overwrites it. It appends to a log, mutates an in-memory structure, and eventually that structure is flushed as a brand-new sorted file. Nothing is ever edited in place. That is the **LSM tree** (Log-Structured Merge tree), and the on-disk unit it produces is the **SSTable** (Sorted String Table).

The problem this solves is the one B-trees have on spinning and even on flash media: **random writes are expensive**. A B-tree update dirties a leaf page somewhere in the middle of a large file, which means a seek, a read-modify-write, and eventually page splits. At Facebook's inbox-search scale in 2007 — the workload Cassandra was born for — that was untenable. The LSM answer is to make every write **sequential**: append to the commit log, sort in memory, and dump sorted runs to disk. Writes become append-only at every layer. The cost is deferred to reads (which may need to consult many files) and to **compaction** (which merges those files back down).

The lineage is explicit: the SSTable and memtable concepts come from Google's **Bigtable** paper (2006), the distribution model from Amazon's **Dynamo** paper (2007). Cassandra's original 2008 release fused the two. The format itself has been rewritten several times — the big modern break was Cassandra **3.0's** storage engine rewrite (CASSANDRA-8099), which moved from a flat "cell per column, key prefixed with clustering values" layout to a genuinely **row-oriented** format that understands CQL rows, static columns, complex types and range tombstones natively. That rewrite typically cut on-disk size by 50–80% for wide-row tables and is why `md`/`nb` generation SSTables are so much smaller than legacy `ic` ones. Cassandra 5.0 adds the **BTI** format (`nc`/`da` big-trie-indexed) as an alternative to the classic BIG format, replacing the Index+Summary pair with a trie-based index.

A concrete picture: Netflix runs Cassandra clusters where a single node holds a few terabytes across thousands of SSTables. A read for one `customer_id` partition hits, in the common case, the key cache (an in-memory map from partition key to a byte offset in `Data.db`), then a single seek into the compressed data file, then a decompression of one 16 KB–64 KB chunk. That is *one* logical disk I/O for a random-access read out of terabytes — and the machinery that makes it possible is exactly the Bloom filter + Summary + Index + CompressionInfo chain this chapter dissects.

## 2. Core Concepts

- **LSM tree** — a write-optimised structure: buffer in memory, flush sorted runs to immutable files, merge them in the background. Trades read and space amplification for near-zero write amplification at the point of the write.
- **Commit log** — an append-only durability journal. Every mutation is appended here *before* it is acknowledged (subject to `commitlog_sync`). Replayed on restart to rebuild memtables.
- **Memtable** — a per-table in-memory sorted map (a concurrent skip-list variant) holding recent writes. Flushed when thresholds are hit.
- **SSTable** — an immutable set of files representing one flush (or one compaction output). Sorted by partition token, then by clustering key within a partition.
- **`Data.db`** — the actual rows: a sequence of partitions, each with a header, static row, and clustering-ordered rows. Compressed in chunks when compression is on.
- **`Index.db`** — the partition index: every partition key in this SSTable mapped to its offset in `Data.db`, plus (for large partitions) an embedded **clustering index** of row-offset samples.
- **`Summary.db`** — an in-memory-resident sample of `Index.db` (every `min_index_interval`-th entry, default 128) that lets a lookup binary-search to a narrow slice of the index file rather than scanning it.
- **`Filter.db`** — the **Bloom filter** over partition keys. Answers "this SSTable definitely does not contain key K" in memory with no disk I/O, at a configurable false-positive rate (`bloom_filter_fp_chance`).
- **`CompressionInfo.db`** — the chunk-offset table for the compressed `Data.db`, so a byte offset can be mapped to the right compressed chunk without scanning.
- **`Statistics.db`** — per-SSTable metadata: min/max timestamps, min/max clustering values, estimated row-size and column-count histograms, `repairedAt`, tombstone-drop estimates, TTL bounds. Powers read-path pruning and compaction decisions.
- **Write amplification / read amplification / space amplification** — the three-way trade-off every compaction strategy tunes. LSM minimises the first, spends the other two.
- **Generation & format letter** — an SSTable filename like `nb-1234-big-Data.db` encodes format version (`nb` = 4.x BIG), generation, and component.

## 3. Theory & Internals

**The write path is append-only, end to end.** A mutation arrives at a replica. It is appended to the **commit log** segment (a 32 MB file by default) and applied to the **memtable**. With `commitlog_sync: periodic` (default, `commitlog_sync_period_in_ms: 10000`) the append is buffered and fsynced every 10 s — meaning up to 10 seconds of acknowledged writes can be lost on a hard power failure of that node, which is acceptable because `RF=3` means two other nodes also have it. With `commitlog_sync: batch` (`commitlog_sync_batch_window_in_ms`) the write blocks until fsync, trading throughput for per-node durability. No disk seek happens on the hot path either way: the commit log is a sequential append and the memtable is RAM.

**Flush.** The memtable flushes when `memtable_cleanup_threshold` is crossed (derived from `memtable_heap_space_in_mb` / `memtable_offheap_space_in_mb`), on `nodetool flush`, on `nodetool drain`, or when a commit log segment must be recycled. The flush writes the sorted map straight out as `Data.db` in token order, building `Index.db`, `Summary.db` and `Filter.db` in the same pass. Because the memtable is already sorted, the flush is a **sequential write with no sorting cost at flush time**. Once flushed, the corresponding commit log segments can be discarded.

**The read path is a merge across sources.** A read for partition `K` must consider: the memtable, and every SSTable that *might* contain `K`. The engine prunes aggressively:

1. **Bloom filter** (`Filter.db`, held in memory off-heap). If it says "no", skip this SSTable with zero I/O. With the default `bloom_filter_fp_chance = 0.01` (LCS default is `0.1`), roughly 1 in 100 negative lookups still costs a disk probe. Memory cost is about `−n·ln(p) / (ln 2)²` bits ⇒ ~9.6 bits/key at p=0.01, ~4.8 bits/key at p=0.1. Ten billion keys at 0.01 is ~12 GB of filter — which is why very high row counts per node force you to relax `bloom_filter_fp_chance`.
2. **Min/max clustering and timestamp bounds** from `Statistics.db`. If the query's clustering slice cannot intersect this SSTable's range, skip it.
3. **Key cache** — a JVM-heap map from `(sstable, partition key)` to `Data.db` offset. A hit skips both Summary and Index entirely.
4. **`Summary.db`** — binary search the in-memory sample to find the byte range of `Index.db` to scan.
5. **`Index.db`** — scan that small range to find the exact `Data.db` offset. For partitions above `column_index_size_in_kb` (default 64 KB) the index entry also carries **IndexInfo** samples of clustering positions, so a slice query inside a huge partition can seek within it.
6. **`CompressionInfo.db`** — map the data offset to a compressed chunk (`chunk_length_in_kb`, default 16 in 4.x), read and decompress exactly that chunk.
7. **Merge** — reconcile rows across memtable + all matching SSTables by write timestamp, apply tombstones, return.

**Read amplification is the price.** With SizeTieredCompactionStrategy an overwritten-heavy partition can live in many SSTables at once; `nodetool tablehistograms` shows the distribution as "SSTables per read". LeveledCompactionStrategy guarantees (after L0) at most one SSTable per level per key, so reads touch ~1 + number-of-levels SSTables — better read amplification, more write amplification.

**Space amplification** comes from the same immutability: an overwritten or deleted row occupies space in every SSTable that ever held a version of it, until compaction merges them and `gc_grace_seconds` allows the tombstone to be dropped. STCS can transiently need up to 50% free disk during a major compaction; LCS needs ~10%.

```svg
<svg viewBox="0 0 820 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a26a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="410" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">SSTable Components and the Read Lookup Chain</text>

  <rect x="20" y="45" width="160" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="100" y="68" text-anchor="middle" fill="#1e293b" font-weight="700">Filter.db</text>
  <text x="100" y="85" text-anchor="middle" fill="#64748b" font-size="10">Bloom, off heap</text>
  <text x="100" y="99" text-anchor="middle" fill="#64748b" font-size="10">fp_chance 0.01</text>

  <rect x="215" y="45" width="160" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="295" y="68" text-anchor="middle" fill="#1e293b" font-weight="700">Summary.db</text>
  <text x="295" y="85" text-anchor="middle" fill="#64748b" font-size="10">in memory sample</text>
  <text x="295" y="99" text-anchor="middle" fill="#64748b" font-size="10">every 128th key</text>

  <rect x="410" y="45" width="160" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="490" y="68" text-anchor="middle" fill="#1e293b" font-weight="700">Index.db</text>
  <text x="490" y="85" text-anchor="middle" fill="#64748b" font-size="10">key to data offset</text>
  <text x="490" y="99" text-anchor="middle" fill="#64748b" font-size="10">+ IndexInfo samples</text>

  <rect x="605" y="45" width="185" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="697" y="68" text-anchor="middle" fill="#1e293b" font-weight="700">CompressionInfo.db</text>
  <text x="697" y="85" text-anchor="middle" fill="#64748b" font-size="10">offset to chunk map</text>
  <text x="697" y="99" text-anchor="middle" fill="#64748b" font-size="10">chunk 16 KB</text>

  <line x1="180" y1="75" x2="210" y2="75" stroke="#475569" marker-end="url(#a26a)"/>
  <line x1="375" y1="75" x2="405" y2="75" stroke="#475569" marker-end="url(#a26a)"/>
  <line x1="570" y1="75" x2="600" y2="75" stroke="#475569" marker-end="url(#a26a)"/>

  <rect x="120" y="160" width="580" height="90" rx="10" fill="#f8fafc" stroke="#475569"/>
  <text x="410" y="182" text-anchor="middle" fill="#1e293b" font-weight="700">Data.db  (partitions in token order, rows in clustering order)</text>
  <rect x="140" y="195" width="120" height="42" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="200" y="213" text-anchor="middle" fill="#1e293b" font-size="11">partition p1</text>
  <text x="200" y="229" text-anchor="middle" fill="#64748b" font-size="10">chunk 0</text>
  <rect x="272" y="195" width="120" height="42" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="332" y="213" text-anchor="middle" fill="#1e293b" font-size="11">partition p2</text>
  <text x="332" y="229" text-anchor="middle" fill="#64748b" font-size="10">chunk 1</text>
  <rect x="404" y="195" width="120" height="42" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="464" y="213" text-anchor="middle" fill="#1e293b" font-size="11">partition p3</text>
  <text x="464" y="229" text-anchor="middle" fill="#64748b" font-size="10">chunks 2 to 9</text>
  <rect x="536" y="195" width="140" height="42" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="606" y="213" text-anchor="middle" fill="#1e293b" font-size="11">partition p4</text>
  <text x="606" y="229" text-anchor="middle" fill="#64748b" font-size="10">chunk 10</text>

  <line x1="697" y1="105" x2="620" y2="190" stroke="#d97706" marker-end="url(#a26a)"/>
  <line x1="490" y1="105" x2="470" y2="190" stroke="#16a34a" marker-end="url(#a26a)"/>

  <rect x="20" y="285" width="380" height="95" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="210" y="307" text-anchor="middle" fill="#1e293b" font-weight="700">Statistics.db</text>
  <text x="210" y="326" text-anchor="middle" fill="#1e293b" font-size="11">min/max timestamp, min/max clustering</text>
  <text x="210" y="344" text-anchor="middle" fill="#1e293b" font-size="11">row size and column count histograms</text>
  <text x="210" y="362" text-anchor="middle" fill="#1e293b" font-size="11">repairedAt, estimated droppable tombstones</text>

  <rect x="425" y="285" width="365" height="95" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="607" y="307" text-anchor="middle" fill="#1e293b" font-weight="700">Also on disk</text>
  <text x="607" y="326" text-anchor="middle" fill="#1e293b" font-size="11">Digest.crc32  integrity of Data.db</text>
  <text x="607" y="344" text-anchor="middle" fill="#1e293b" font-size="11">TOC.txt  list of components</text>
  <text x="607" y="362" text-anchor="middle" fill="#1e293b" font-size="11">CRC.db  per chunk checksums</text>
</svg>
```

## 4. Architecture & Workflow

**Write, flush, compact — the full lifecycle.**

1. Coordinator routes the mutation to the replica owning the token. On the replica, `Mutation.apply()` appends the serialized mutation to the active **commit log segment**.
2. The same mutation is applied to the table's **memtable** (a `ConcurrentSkipListMap` keyed by `DecoratedKey`, values holding clustering-ordered rows). Off-heap memtables (`memtable_allocation_type: offheap_objects`) keep row data outside the JVM heap.
3. When memtable pressure crosses the cleanup threshold, the memtable is swapped for a fresh one and the old one is handed to the flush executor.
4. The flush writer iterates the sorted memtable once, writing `Data.db` sequentially. In the same pass it emits an `Index.db` entry per partition, samples every `min_index_interval`-th entry into `Summary.db`, inserts every key into the Bloom filter for `Filter.db`, records chunk offsets into `CompressionInfo.db`, and accumulates histograms into `Statistics.db`. Finally `Digest.crc32` and `TOC.txt` are written and the set is atomically made visible.
5. Commit log segments whose mutations are all now in SSTables are recycled. `nodetool flush` forces this; `nodetool drain` flushes and stops accepting writes — the correct pre-shutdown step.
6. **Compaction** picks a set of SSTables per the table's strategy (STCS buckets by similar size, LCS maintains size-tiered levels with non-overlapping ranges within a level, TWCS buckets by time window), merge-sorts them, drops shadowed cells and expired tombstones (those older than `gc_grace_seconds` whose partition is fully contained in the compacting set), and writes new SSTables.
7. Old SSTables are unreferenced and deleted once no read is still using them.

**Read, step by step.**

1. Coordinator sends the read to replicas; on the replica, `SinglePartitionReadCommand` builds the list of candidate sources.
2. Memtable is consulted directly (it is a sorted map — cheap).
3. For each SSTable: check Bloom filter → check `Statistics.db` min/max bounds → check key cache → binary search `Summary.db` → scan the bounded slice of `Index.db` → resolve offset.
4. Map the offset through `CompressionInfo.db`, read the compressed chunk (possibly served from the **chunk cache**, `file_cache_size_in_mb`, off-heap), decompress, deserialize the partition header.
5. For a wide partition, use `IndexInfo` entries inside the index entry to seek directly to the clustering slice requested, avoiding a scan of the whole partition.
6. Feed all sources into a merge iterator: highest write timestamp per cell wins; range tombstones and row deletions suppress older data; expired TTL cells become tombstones.
7. Apply the query's limits and return. Update the row cache only if enabled (it caches whole partitions — usually a bad idea for wide partitions).

```svg
<svg viewBox="0 0 820 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a26b" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="410" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">LSM Write Path and Compaction Levels</text>

  <rect x="30" y="45" width="130" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="95" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">Mutation</text>
  <text x="95" y="82" text-anchor="middle" fill="#64748b" font-size="10">INSERT / UPDATE</text>

  <rect x="205" y="45" width="150" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="280" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">Commit Log</text>
  <text x="280" y="82" text-anchor="middle" fill="#64748b" font-size="10">sequential append</text>

  <rect x="400" y="45" width="150" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="475" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">Memtable</text>
  <text x="475" y="82" text-anchor="middle" fill="#64748b" font-size="10">sorted, in memory</text>

  <rect x="600" y="45" width="180" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="690" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">ack to coordinator</text>
  <text x="690" y="82" text-anchor="middle" fill="#64748b" font-size="10">no disk seek</text>

  <line x1="160" y1="68" x2="200" y2="68" stroke="#475569" marker-end="url(#a26b)"/>
  <line x1="355" y1="68" x2="395" y2="68" stroke="#475569" marker-end="url(#a26b)"/>
  <line x1="550" y1="68" x2="595" y2="68" stroke="#475569" marker-end="url(#a26b)"/>

  <line x1="475" y1="91" x2="475" y2="130" stroke="#0ea5e9" stroke-width="2" marker-end="url(#a26b)"/>
  <text x="530" y="115" fill="#0369a1" font-size="11">flush when full</text>

  <text x="60" y="160" fill="#1e293b" font-weight="700" font-size="13">L0</text>
  <rect x="95" y="142" width="80" height="28" rx="5" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="135" y="161" text-anchor="middle" fill="#1e293b" font-size="10">sstable</text>
  <rect x="185" y="142" width="80" height="28" rx="5" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="225" y="161" text-anchor="middle" fill="#1e293b" font-size="10">sstable</text>
  <rect x="275" y="142" width="80" height="28" rx="5" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="315" y="161" text-anchor="middle" fill="#1e293b" font-size="10">sstable</text>
  <rect x="365" y="142" width="80" height="28" rx="5" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="405" y="161" text-anchor="middle" fill="#1e293b" font-size="10">sstable</text>
  <text x="480" y="161" fill="#64748b" font-size="11">overlapping ranges</text>

  <line x1="270" y1="176" x2="270" y2="205" stroke="#16a34a" stroke-width="2" marker-end="url(#a26b)"/>
  <text x="330" y="196" fill="#15803d" font-size="11">compaction merges and drops shadowed cells</text>

  <text x="60" y="235" fill="#1e293b" font-weight="700" font-size="13">L1</text>
  <rect x="95" y="217" width="150" height="28" rx="5" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="170" y="236" text-anchor="middle" fill="#1e293b" font-size="10">token a to h</text>
  <rect x="255" y="217" width="150" height="28" rx="5" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="330" y="236" text-anchor="middle" fill="#1e293b" font-size="10">token h to p</text>
  <rect x="415" y="217" width="150" height="28" rx="5" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="490" y="236" text-anchor="middle" fill="#1e293b" font-size="10">token p to z</text>
  <text x="590" y="236" fill="#64748b" font-size="11">non overlapping</text>

  <line x1="270" y1="251" x2="270" y2="280" stroke="#16a34a" stroke-width="2" marker-end="url(#a26b)"/>

  <text x="60" y="310" fill="#1e293b" font-weight="700" font-size="13">L2</text>
  <rect x="95" y="292" width="670" height="28" rx="5" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="430" y="311" text-anchor="middle" fill="#1e293b" font-size="10">10x the size of L1, still non overlapping within the level</text>

  <rect x="95" y="340" width="670" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="430" y="360" text-anchor="middle" fill="#1e293b" font-weight="700">Read merges memtable plus one SSTable per level</text>
  <text x="430" y="378" text-anchor="middle" fill="#64748b" font-size="11">Bloom filter and min/max bounds prune most candidates before any I/O</text>
</svg>
```

## 5. Implementation

Create a table and control the storage-engine knobs explicitly.

```cql
CREATE KEYSPACE IF NOT EXISTS metrics
  WITH replication = {'class':'NetworkTopologyStrategy','dc1':3};

CREATE TABLE metrics.sensor_readings (
  sensor_id   uuid,
  bucket      date,
  reading_ts  timestamp,
  value       double,
  PRIMARY KEY ((sensor_id, bucket), reading_ts)
) WITH CLUSTERING ORDER BY (reading_ts DESC)
  AND compaction = {
        'class':'TimeWindowCompactionStrategy',
        'compaction_window_unit':'DAYS',
        'compaction_window_size':1
      }
  AND compression = {
        'class':'org.apache.cassandra.io.compress.ZstdCompressor',
        'chunk_length_in_kb':16,
        'compression_level':3
      }
  AND bloom_filter_fp_chance = 0.01
  AND min_index_interval = 128
  AND max_index_interval = 2048
  AND caching = {'keys':'ALL','rows_per_partition':'NONE'}
  AND default_time_to_live = 2592000;   -- 30 days
```

Look at what is actually on disk:

```bash
ls -1 /var/lib/cassandra/data/metrics/sensor_readings-3f2a.../
# nb-17-big-CompressionInfo.db
# nb-17-big-Data.db
# nb-17-big-Digest.crc32
# nb-17-big-Filter.db
# nb-17-big-Index.db
# nb-17-big-Statistics.db
# nb-17-big-Summary.db
# nb-17-big-TOC.txt

# Human-readable SSTable metadata
sstablemetadata /var/lib/cassandra/data/metrics/sensor_readings-3f2a.../nb-17-big-Data.db
# SSTable: .../nb-17-big
# Partitioner: org.apache.cassandra.dht.Murmur3Partitioner
# Bloom Filter FP chance: 0.01
# Minimum timestamp: 1753142400000000
# Maximum timestamp: 1753228799000000
# SSTable min local deletion time: 2147483647
# Estimated droppable tombstones: 0.0
# SSTable Level: 0
# Repaired at: 0
# Estimated tombstone drop times: ...
# Partition Size (bytes): 50% 1109 | 95% 8239 | 99% 24601 | Max 88148

# Dump rows as JSON (careful: full scan of the file)
sstabledump nb-17-big-Data.db | head -40

# Which SSTables hold a given partition key?
nodetool getsstables metrics sensor_readings 8f1c...-b2

# Per-table read/write shape
nodetool tablehistograms metrics sensor_readings
# Percentile  SSTables  Write Latency  Read Latency  Partition Size  Cell Count
#                          (micros)      (micros)        (bytes)
# 50%             1.00        20.50         98.00            1109          24
# 95%             2.00        61.21        454.83            8239         179
# 99%             3.00       105.78       1131.75           24601         535
# Max             4.00       943.13       9887.00           88148        1916

nodetool tablestats metrics.sensor_readings | egrep 'Bloom|SSTable|Compression|Space'
# SSTable count: 14
# Space used (live): 41283911702
# Compression ratio: 0.246
# Bloom filter false positives: 118
# Bloom filter false ratio: 0.00012
# Bloom filter space used: 61129528
```

Storage-engine settings in `cassandra.yaml`:

```yaml
commitlog_sync: periodic
commitlog_sync_period_in_ms: 10000
commitlog_segment_size_in_mb: 32
commitlog_total_space_in_mb: 8192
commitlog_compression:
  - class_name: LZ4Compressor

memtable_allocation_type: offheap_objects
memtable_heap_space_in_mb: 2048
memtable_offheap_space_in_mb: 2048
memtable_flush_writers: 2

column_index_size_in_kb: 64        # IndexInfo sampling granularity inside big partitions
file_cache_size_in_mb: 2048        # off-heap chunk cache
key_cache_size_in_mb: 512
row_cache_size_in_mb: 0            # keep this 0 unless you have proven small, hot partitions
concurrent_compactors: 4
compaction_throughput_mb_per_sec: 64
sstable_preemptive_open_interval_in_mb: 50
```

Driver-side: nothing about the storage engine is client-visible, but paging keeps a wide-partition read from materialising a whole partition.

```python
from cassandra.cluster import Cluster
from cassandra.query import SimpleStatement
from cassandra import ConsistencyLevel

session = Cluster(["10.0.1.10"]).connect("metrics")

stmt = SimpleStatement(
    "SELECT reading_ts, value FROM sensor_readings "
    "WHERE sensor_id = %s AND bucket = %s AND reading_ts > %s",
    fetch_size=500,                      # one page = one bounded seek set per SSTable
    consistency_level=ConsistencyLevel.LOCAL_QUORUM,
)
for row in session.execute(stmt, (sensor_id, bucket, since)):
    process(row)
# The clustering restriction lets the read use IndexInfo entries to seek inside
# the partition instead of scanning it from the first row.
```

```java
// Java driver 4.x: bounded page size + idempotent so speculative execution is safe
PreparedStatement ps = session.prepare(
    "SELECT reading_ts, value FROM sensor_readings "
    + "WHERE sensor_id = ? AND bucket = ? AND reading_ts > ?");
BoundStatement bs = ps.bind(sensorId, bucket, since)
    .setPageSize(500)
    .setIdempotent(true)
    .setConsistencyLevel(DefaultConsistencyLevel.LOCAL_QUORUM);
for (Row r : session.execute(bs)) { process(r); }
```

> **Optimization:** the two highest-leverage storage-engine levers are **compression chunk size** and **`bloom_filter_fp_chance`**. For a point-read-heavy table, drop `chunk_length_in_kb` from 64 to 16 (or 8): you decompress 4–8× less data per read, at the cost of a slightly worse compression ratio and a bigger `CompressionInfo.db`. For analytics-style range scans, raise it to 64 and switch to `ZstdCompressor` for a better ratio. Separately, on tables with billions of rows per node, `Filter.db` memory becomes the constraint — relaxing `bloom_filter_fp_chance` from 0.01 to 0.1 halves filter memory (9.6 → 4.8 bits/key) in exchange for 10× more false positives, which is a good trade only if reads are mostly *hits* rather than existence checks.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Immutable SSTables | No read-modify-write, no locking, trivially safe concurrent reads, easy snapshots via hard links | Updates and deletes create new versions; space is reclaimed only by compaction |
| Append-only write path | Writes are sequential I/O; ~sub-millisecond local write latency even on spinning disks | Durability window of `commitlog_sync_period_in_ms` under `periodic` sync |
| Bloom filters | Skip most SSTables with zero disk I/O | Memory grows linearly with row count per node; false positives cost a wasted seek |
| Summary + Index | O(log n) in-memory search narrows to a tiny index scan; one seek per partition | Summary lives on heap; `min_index_interval` too low bloats it, too high slows lookups |
| Chunked compression | 2–5× space savings and less I/O per row | Every read decompresses at least one full chunk — oversized chunks waste CPU and bandwidth |
| `Statistics.db` metadata | Enables min/max pruning, tombstone estimates, compaction decisions without reading data | Stale after heavy overwrite; estimates, not guarantees |
| LCS | Low read amplification, predictable ~10% space overhead | Very high write amplification; unsuitable for write-heavy or wide time-series tables |
| STCS | Lowest write amplification, good for write-heavy | High read amplification; needs up to 50% free disk for major compaction |
| TWCS | Whole SSTables expire and are dropped without compaction — near-free deletes for TTL data | Only correct for time-ordered, TTL'd, never-updated data; out-of-order writes break the model |
| Row cache | Can serve entire partitions from memory | Caches whole partitions — catastrophic on wide partitions; almost always leave at 0 |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Building unbounded partitions and blaming "Cassandra reads are slow".** → ✅ A read into a 5 GB partition must walk `IndexInfo` entries and decompress many chunks. Keep partitions **under 100 MB and under 100k rows**; verify with `nodetool tablehistograms` partition-size percentiles, not with hope.
2. ⚠️ **Enabling the row cache to "speed up reads".** → ✅ The row cache stores **entire partitions**; on a wide-row table it thrashes and inflates GC. Leave `row_cache_size_in_mb: 0` and rely on the key cache and OS page cache. Only consider it for tiny, hot, read-mostly lookup tables.
3. ⚠️ **Leaving `chunk_length_in_kb` at 64 for a point-lookup table.** → ✅ Every 200-byte row read decompresses 64 KB. Set 16 KB (or 8 KB on NVMe with small rows) for OLTP-shaped access.
4. ⚠️ **Running `nodetool compact` (major compaction) on an STCS table in production.** → ✅ It produces one enormous SSTable that will never compact again with its peers, so subsequent tombstones in it are never dropped. Prefer `nodetool garbagecollect`, or switch strategy, or use `sstablesplit` afterwards.
5. ⚠️ **Using `kill -9` or `systemctl stop` without draining.** → ✅ Always `nodetool drain` first: it flushes memtables and stops accepting writes, so startup does not have to replay gigabytes of commit log (which can take many minutes and delays the node rejoining).
6. ⚠️ **Putting commit log and data on the same device on spinning disks.** → ✅ The commit log wants pure sequential throughput; competing seeks from compaction destroy it. Separate `commitlog_directory`. On NVMe this matters far less, but keep them on different filesystems for failure isolation.
7. ⚠️ **Choosing LCS for a write-heavy time-series table.** → ✅ LCS rewrites data many times over as it promotes through levels — write amplification of roughly 10× the data volume. Use TWCS for time series with TTLs, STCS for write-heavy with few reads.
8. ⚠️ **Ignoring "Estimated droppable tombstones" from `sstablemetadata`.** → ✅ A value above ~0.2 on a large SSTable means a fifth of the file is garbage that compaction is not reclaiming — usually because the partition also lives in other SSTables. Investigate `unchecked_tombstone_compaction` / `tombstone_threshold` sub-properties.
9. ⚠️ **Assuming a `DELETE` frees disk immediately.** → ✅ It writes a **tombstone** — more data, not less. Space is reclaimed only after compaction merges every SSTable holding the row *and* `gc_grace_seconds` (864000 default) has elapsed.
10. ⚠️ **Setting `bloom_filter_fp_chance = 0.001` "to be safe".** → ✅ Filter memory scales as `−ln(p)`; going from 0.01 to 0.001 raises it from ~9.6 to ~14.4 bits/key for a marginal hit-rate gain. On a node with billions of rows this is gigabytes of heap-adjacent memory for nothing.
11. ⚠️ **Copying SSTable files between nodes by hand to "restore" data.** → ✅ SSTables are token-range-specific and reference host metadata. Use `sstableloader` (which routes rows to the right owners) or `nodetool refresh` for same-token restores.
12. ⚠️ **Setting `concurrent_compactors` equal to core count.** → ✅ Compaction competes with reads for disk and page cache. Start at `min(cores, disks) / 2`, typically 2–4, and raise only if `nodetool compactionstats` shows a persistent backlog.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When a read is slow, the diagnosis order is: `nodetool tablehistograms` (how many SSTables per read? what is the p99 partition size?), then `nodetool tablestats` (bloom filter false ratio, compression ratio, SSTable count), then `nodetool getsstables <ks> <tbl> <key>` on a specific slow key, then `sstablemetadata` on those files to see timestamps and droppable-tombstone estimates. A `TombstoneOverwhelmingException` or a `Read 1200 live rows and 45000 tombstone cells` WARN in `system.log` points straight at delete patterns, not the storage engine. Long GC pauses correlated with flushes usually mean on-heap memtables — switch to `offheap_objects`.

**Monitoring.** The beans that matter:
- `org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=SSTablesPerReadHistogram` — the single best read-amplification signal.
- `name=BloomFilterFalseRatio` and `name=BloomFilterDiskSpaceUsed` / `BloomFilterOffHeapMemoryUsed`.
- `name=CompressionRatio`, `name=LiveDiskSpaceUsed`, `name=TotalDiskSpaceUsed` (the gap is un-reclaimed garbage).
- `name=PendingCompactions` — sustained above ~20 means compaction is losing.
- `org.apache.cassandra.metrics:type=CommitLog,name=PendingTasks|TotalCommitLogSize` — a growing commit log means flushes are not keeping up.
- `type=Cache,scope=KeyCache,name=HitRate` (aim >0.9) and `scope=ChunkCache,name=HitRate`.
- `type=ColumnFamily,name=MaxPartitionSize` / `MeanPartitionSize` — your unbounded-partition early warning.
- Virtual tables (4.0+): `SELECT * FROM system_views.sstable_tasks;` and `system_views.disk_usage` give the same data over CQL without JMX.

**Security.** SSTables are **plaintext on disk** in open-source Cassandra — there is no built-in transparent data encryption (TDE is a DataStax Enterprise feature). Use filesystem or block-level encryption (LUKS, dm-crypt, EBS encryption) for data at rest, and remember that `commitlog_directory`, `hints_directory` and `saved_caches_directory` also contain row data and must be covered by the same encryption. Snapshots are hard links into the same filesystem, so they inherit its protection — but once you copy a snapshot to object storage, you own that encryption. File permissions should restrict the data directory to the `cassandra` user (0700).

**Performance & Scaling.** Data per node is bounded in practice by **compaction and repair throughput, not disk capacity** — 1–2 TB per node for clusters with regular repairs, up to 3–4 TB for append-only TTL workloads on TWCS with NVMe. The key scaling levers: `compaction_throughput_mb_per_sec` (64 on NVMe; unthrottled only during maintenance windows), `concurrent_compactors` (2–4), `file_cache_size_in_mb` sized so the chunk cache holds your hot working set, and — most importantly — **partition sizing at the data-model level**, because no amount of storage tuning fixes a 10 GB partition. On the JVM side, `offheap_objects` memtables plus G1GC with a 16–31 GB heap is the standard 4.x configuration; Cassandra 5.0 users on JDK 17 should evaluate ZGC for lower pause variance.

## 9. Interview Questions

**Q: What is an SSTable and why is it immutable?**
A: An SSTable is a Sorted String Table — the on-disk output of a memtable flush or a compaction, holding partitions in token order and rows in clustering order. Immutability means writes never seek to modify existing data, so all writes are sequential appends, concurrent reads need no locking, and snapshots are just hard links. The cost is that updates and deletes create new versions that only compaction reclaims.

**Q: Name the SSTable components and what each does.**
A: `Data.db` holds the actual rows; `Index.db` maps partition keys to `Data.db` offsets (plus IndexInfo samples inside big partitions); `Summary.db` is an in-memory sample of the index for binary search; `Filter.db` is the Bloom filter over partition keys; `CompressionInfo.db` maps offsets to compressed chunks; `Statistics.db` holds min/max timestamps and clustering bounds plus histograms; `Digest.crc32` and `CRC.db` are integrity checks; `TOC.txt` lists the components.

**Q: Walk through what happens on a write.**
A: The mutation is appended to the commit log (sequential I/O) and applied to the in-memory memtable, then acknowledged — no disk seek. When memtable pressure crosses the cleanup threshold the memtable is flushed as a new immutable SSTable, writing Data, Index, Summary, Filter, CompressionInfo and Statistics in one pass. Commit log segments are recycled once their mutations are all in SSTables.

**Q: Why can a read touch multiple SSTables, and how does Cassandra limit that?**
A: Because a partition's rows can be spread across every SSTable ever flushed that contains a version of them. Cassandra prunes with the Bloom filter (zero-I/O negative answer), min/max clustering and timestamp bounds from `Statistics.db`, and the key cache. `nodetool tablehistograms` reports the actual "SSTables per read" distribution; if p99 is high, your compaction strategy or data model is wrong.

**Q: What does `bloom_filter_fp_chance` control and what does changing it cost?**
A: The target false-positive rate of the per-SSTable partition-key Bloom filter — 0.01 by default (0.1 for LCS). Memory is roughly `−n·ln(p)/(ln 2)²` bits per key: ~9.6 bits at 0.01, ~4.8 at 0.1, ~14.4 at 0.001. Tightening it costs memory that scales with row count per node; loosening it costs extra disk probes on lookups for keys not present.

**Q: What is the difference between the key cache, row cache and chunk cache?**
A: The key cache maps `(sstable, partition key)` to a `Data.db` offset, skipping Summary and Index lookups — cheap and almost always worth enabling. The row cache stores whole materialised partitions and is dangerous on wide partitions; default and usual production value is 0. The chunk cache (`file_cache_size_in_mb`) is an off-heap cache of decompressed data chunks, effectively Cassandra's own page cache.

**Q: What is `column_index_size_in_kb` for?**
A: It controls how often Cassandra records an `IndexInfo` entry — a clustering-key checkpoint — inside a large partition's index entry, defaulting to 64 KB of data per entry. It lets a slice query inside a huge partition seek near the requested clustering range instead of scanning from the partition's first row. Very large partitions inflate the index entry itself, which is one reason huge partitions hurt.

**Q: (Senior) Explain the write/read/space amplification trade-off across STCS, LCS and TWCS, and how you would choose.**
A: STCS merges similarly-sized SSTables, so it has the lowest write amplification but the highest read amplification (a key can live in many buckets) and needs up to 50% free disk for a major compaction — right for write-heavy, read-light tables. LCS keeps non-overlapping SSTables within each level, so reads touch roughly one SSTable per level and space overhead is ~10%, but promoting data through levels rewrites it many times — right for read-heavy tables with updates, wrong for high-ingest ones. TWCS buckets by time window and simply *drops* whole expired SSTables, giving near-zero amplification for TTL'd time series, but it is only correct if data arrives roughly in time order and is never updated or individually deleted.

**Q: (Senior) The 3.0 storage engine rewrite (CASSANDRA-8099) changed the on-disk format substantially. What changed and why did it matter?**
A: Pre-3.0, the engine was cell-oriented: every column value was an independent cell whose name embedded the full clustering prefix, so a wide row repeated its clustering values once per column and had no first-class notion of a CQL row. The rewrite made the format row-oriented with a shared per-row header, encoded clustering values once, and gave the engine native understanding of static columns, complex types, and range tombstones. Practically, it cut on-disk size 50–80% for wide tables, made range tombstones far cheaper, and enabled later features (like proper row-level metadata) that the cell model could not express.

**Q: (Senior) Why does a `DELETE` sometimes make reads slower rather than faster, and what is the storage-engine mechanism?**
A: A delete writes a tombstone — a marker with a timestamp — into a new SSTable. Until compaction merges every SSTable holding the deleted data *and* `gc_grace_seconds` has elapsed, reads must scan and merge those tombstones to know the data is gone. A range or partition delete over many rows produces range tombstones that the merge iterator must carry across all sources. So a read of a heavily-deleted clustering range can scan tens of thousands of tombstone markers to return zero live rows, hitting `tombstone_warn_threshold` (1000) and eventually `tombstone_failure_threshold` (100000). The structural fix is TTL + TWCS so whole SSTables expire, not per-row deletes.

**Q: (Senior) A node has 3000 SSTables for one table and pending compactions are climbing. Diagnose.**
A: Three usual causes. First, compaction is throttled below ingest: check `compaction_throughput_mb_per_sec` and `concurrent_compactors` against actual write throughput, and check whether `nodetool compactionstats` shows work in progress or a stalled queue. Second, repair streaming is dumping SSTables into L0 faster than LCS can promote them — visible as a huge L0 in `nodetool tablestats` SSTables-in-each-level; throttle streaming and let it drain. Third, a prior `nodetool compact` created a giant SSTable that new files can never bucket with under STCS, so small files pile up forever. Also verify disk is not full — compaction needs headroom and will stop rather than corrupt.

**Q: What does `nodetool drain` do that `nodetool flush` does not?**
A: `flush` writes memtables to SSTables but the node keeps serving writes. `drain` flushes *and* stops accepting new writes and marks the node as unavailable for the cluster, so it is the correct final step before a shutdown or upgrade — it guarantees the commit log is empty and startup will not need a long replay.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Cassandra is an LSM tree. A write appends to the **commit log** and lands in the sorted in-memory **memtable**, then acks — no seek. The memtable flushes to an immutable **SSTable**: `Data.db` (rows, token then clustering order), `Index.db` (key → offset), `Summary.db` (in-memory index sample, every 128th key), `Filter.db` (Bloom filter, `fp_chance` 0.01), `CompressionInfo.db` (offset → 16 KB chunk), `Statistics.db` (min/max timestamps and clustering, histograms, `repairedAt`), plus `Digest.crc32` and `TOC.txt`. A read prunes with the Bloom filter and min/max bounds, hits the key cache or binary-searches Summary → Index, decompresses one chunk, and merges across memtable + surviving SSTables by write timestamp. Immutability means updates and deletes are new versions reclaimed only by **compaction** — which is where write, read and space amplification are traded (STCS, LCS, TWCS). Keep partitions under 100 MB / 100k rows; everything else is tuning.

| Item | Default / Command | Note |
|---|---|---|
| `commitlog_sync` | `periodic`, 10000 ms | `batch` for per-node durability at throughput cost |
| `commitlog_segment_size_in_mb` | `32` | |
| `bloom_filter_fp_chance` | `0.01` (LCS `0.1`) | ~9.6 bits/key at 0.01 |
| `min_index_interval` | `128` | Summary sampling rate |
| `column_index_size_in_kb` | `64` | IndexInfo granularity inside partitions |
| `chunk_length_in_kb` | `16` (4.x) | Lower for point reads, higher for scans |
| `compaction_throughput_mb_per_sec` | `64` | |
| `concurrent_compactors` | 2–4 | Not core count |
| `row_cache_size_in_mb` | `0` | Leave it at 0 |
| Partition ceiling | < 100 MB, < 100k rows | Hard design rule |
| Inspect one SSTable | `sstablemetadata <Data.db>` | Timestamps, droppable tombstones, level |
| Dump rows | `sstabledump <Data.db>` | JSON, full file scan |
| Which files hold a key | `nodetool getsstables ks tbl key` | |
| Read shape | `nodetool tablehistograms ks tbl` | SSTables-per-read is the key column |
| Format letters | `nb` (4.x BIG), `da`/BTI (5.0) | Filename prefix |

**Flash cards**
- **Why are SSTables immutable?** → So every write is a sequential append with no read-modify-write; the cost is that reclaiming space requires compaction.
- **Which component answers "is this key here?" with zero disk I/O?** → `Filter.db`, the Bloom filter, at `bloom_filter_fp_chance` (0.01 default).
- **What does `Summary.db` save you?** → Scanning `Index.db`; it is an in-memory sample (every `min_index_interval`-th key) that narrows the index read to a small range.
- **What is the practical partition size ceiling?** → Under 100 MB and under 100k rows; verify with `nodetool tablehistograms`.
- **What does `nodetool drain` guarantee before shutdown?** → Memtables are flushed and writes are refused, so restart needs no long commit-log replay.

## 11. Hands-On Exercises & Mini Project

- [ ] Create `metrics.sensor_readings` on a local 1-node cluster, insert 100k rows, then `nodetool flush` and list the data directory. Identify each of the 8 component files and record their sizes; compute the ratio of `Filter.db` to `Data.db`.
- [ ] Run `sstablemetadata` on the flushed file. Record min/max timestamp, partition-size percentiles, and "Estimated droppable tombstones". Then delete 20% of the rows, flush again, and compare the two files' droppable-tombstone estimates.
- [ ] Vary `chunk_length_in_kb` across 4, 16 and 64 on three copies of the same table with identical data. Measure `nodetool tablestats` compression ratio and p99 read latency for single-row lookups. Plot the trade-off.
- [ ] Deliberately build a 500 MB partition (one `sensor_id`/`bucket` with millions of rows). Compare `nodetool tablehistograms` partition-size max, single-row read latency, and heap behaviour against a properly bucketed table. Then fix it by adding a time bucket to the partition key.
- [ ] Compare STCS vs LCS on the same 5 GB dataset: measure total bytes written by compaction (`nodetool tablestats` + `compactionstats` over time), final SSTable count, and SSTables-per-read p99.

### Mini Project — SSTable Anatomy Explorer

**Goal.** Build a CLI that, given a keyspace, table and partition key, explains exactly which files a read would touch and why.

**Requirements.**
1. Shell out to `nodetool getsstables` to find candidate SSTables for the key.
2. For each candidate, run `sstablemetadata` and parse min/max timestamps, min/max clustering, level, and droppable-tombstone estimate.
3. Report, per SSTable: would the Bloom filter have excluded it? do the min/max bounds intersect the query's clustering slice? what is its size and level?
4. Print a summary line: "read amplification for this key = N SSTables, M of which are prunable by bounds".
5. Cross-check against `nodetool tablehistograms` SSTables-per-read percentiles.

**Extensions.**
- Parse `sstabledump` output to show, per SSTable, how many versions of the same row exist and their write timestamps — a direct visualisation of overwrite amplification.
- Add a mode that reads `system_views.sstable_tasks` and `system_views.disk_usage` virtual tables (4.0+) over CQL instead of shelling out to nodetool.
- Add a "what if" mode that recomputes filter memory for a different `bloom_filter_fp_chance` and estimated decompression volume for a different `chunk_length_in_kb`.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Compaction Strategies (STCS, LCS, TWCS, UCS)* goes deep on the merge policies referenced here; *Write Path & Read Path* covers the coordinator-side flow into this engine; *Tombstones & Deletes* explains why immutability makes deletes expensive; *Partition Keys & Clustering Keys* explains the sort order `Data.db` materialises; *Repair: Full, Incremental & Subrange* (ch. 29) covers what actually gets streamed; *Backup, Snapshots & Restore* (ch. 30) depends on SSTable immutability and hard links.

- **Apache Cassandra Docs — Storage Engine** — Apache Software Foundation · *Advanced* · the canonical description of commit log, memtable, SSTable and their components. <https://cassandra.apache.org/doc/latest/cassandra/architecture/storage-engine.html>
- **Bigtable: A Distributed Storage System for Structured Data** — Chang et al., OSDI 2006 · *Advanced* · the origin of the SSTable and memtable design Cassandra adopted wholesale. <https://research.google/pubs/pub27898/>
- **CASSANDRA-8099 — Refactor and modernize the storage engine** — Apache JIRA · *Expert* · the 3.0 rewrite ticket; read the description for the row-oriented format rationale and size wins. <https://issues.apache.org/jira/browse/CASSANDRA-8099>
- **The Last Pickle — Cassandra Compression and Chunk Length** — TLP · *Advanced* · practical measurement of `chunk_length_in_kb` against read latency; the best treatment of this specific knob. <https://thelastpickle.com/blog/2018/08/08/compression_performance.html>
- **The Log-Structured Merge-Tree (LSM-Tree)** — O'Neil, Cheng, Gawlick, O'Neil, 1996 · *Expert* · the original paper; section 3's amplification analysis is still the clearest framing of the trade-off. <https://www.cs.umb.edu/~poneil/lsmtree.pdf>
- **DataStax Docs — How data is written / How data is read** — DataStax · *Intermediate* · well-illustrated walkthroughs of the flush and read-merge paths. <https://docs.datastax.com/en/cassandra-oss/3.x/cassandra/dml/dmlHowDataWritten.html>
- **Apache Cassandra Docs — SSTable tooling (sstabledump, sstablemetadata)** — Apache Software Foundation · *Intermediate* · reference for every offline SSTable tool used in this chapter. <https://cassandra.apache.org/doc/latest/cassandra/managing/tools/sstable/index.html>
- **ScyllaDB University — SSTable Format Deep Dive** — ScyllaDB · *Advanced* · a competing implementation explaining the same format; excellent for cross-checking your mental model. <https://university.scylladb.com/courses/scylla-operations/lessons/sstables/>

---

*Apache Cassandra Handbook — chapter 26.*
