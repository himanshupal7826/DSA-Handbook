# 22 · The Read Path: Bloom Filters, Caches & Merges

> **In one line:** A read has to reconstruct one logical row from a memtable plus an unknown number of immutable SSTables, so Cassandra spends enormous effort — bloom filters, index summaries, partition indexes, key/chunk/row caches, and min/max timestamp pruning — on *not* touching SSTables it does not need.

---

## 1. Overview

The write path is simple because it defers everything (Chapter 21). The read path pays that bill. A single logical row can be spread across the memtable and any number of SSTables: the original insert in one, a column update in another, a TTL'd cell in a third, a tombstone in a fourth. There is no single place where "the row" lives. The read must find every fragment, merge them by cell timestamp, apply deletions, and return one coherent result — and it must do this in single-digit milliseconds.

The problem, then, is **read amplification**. If a table has 20 SSTables and you naively checked all of them, every read would be 20 disk seeks. Cassandra's entire read architecture is a stack of progressively more expensive filters designed to shrink 20 candidate SSTables to 1 or 2 actual reads: a bloom filter answers "definitely not here" in nanoseconds from RAM, the key cache answers "here is the exact byte offset" without touching the index, the index summary narrows a binary search to a small window of the partition index, and min/max clustering and timestamp metadata in `Statistics.db` lets whole SSTables be skipped for a range query.

Historically this is Bigtable's design refined by fifteen years of production pain. Cassandra 3.0 rewrote the storage engine around a row-level, not cell-level, on-disk layout, cutting overhead dramatically. Cassandra 4.0 added `system_views` virtual tables so you can see per-SSTable read counts without JMX. Cassandra 5.0 introduces the BTI SSTable format, replacing `Index.db` + `Summary.db` with a trie index that is smaller and much better for very wide partitions, and adds SAI (Storage-Attached Indexing) as a genuinely usable secondary index.

The consequence engineers most often miss: **read latency depends on how many SSTables a partition touches**, and that number is a function of your compaction strategy and your write pattern, not your data size. A 5 TB table with well-compacted partitions can have faster reads than a 50 GB table where every partition has been updated a thousand times across a hundred SSTables. `nodetool tablehistograms` prints exactly this distribution, and it is the first thing to look at when reads are slow.

Concretely: Netflix serves user viewing history from Cassandra at single-digit-millisecond p99 across trillions of rows. That works because the data model makes reads hit one partition in one or two SSTables, the bloom filters live in RAM, and the hot partitions sit in the OS page cache. Change any one of those — let partitions grow unbounded, disable compression's chunk cache, let SSTable count per read climb — and the same cluster serves 200 ms reads.

## 2. Core Concepts

- **Read amplification** — the number of SSTables (and hence potential disk reads) consulted to answer one read; the metric that dominates read latency.
- **Bloom filter** — a probabilistic bit-array per SSTable answering "does this SSTable *maybe* contain this partition key?" with no false negatives and a tunable false-positive rate.
- **Partition index (`Index.db`)** — the on-disk map from partition key to byte offset in `Data.db`, plus a clustering-column index for partitions larger than `column_index_size` (64 KB default).
- **Index summary (`Summary.db`)** — an in-memory sample of `Index.db` (every 128th entry by default) that bounds the binary search to a small on-disk window.
- **Key cache** — an on-heap cache mapping `(SSTable, partition key)` → exact offset in `Data.db`, skipping the summary and index lookups entirely.
- **Row cache** — an off-heap cache of *entire partitions* (or the first N rows); enormously fast when it hits, actively harmful when it does not.
- **Chunk cache / page cache** — decompressed 16–64 KB `Data.db` chunks held in Cassandra's off-heap chunk cache and, below it, the OS page cache.
- **Merge (reconciliation)** — combining fragments of the same row from memtable and multiple SSTables by picking the highest timestamp per cell and applying tombstones.
- **Digest request** — a hash of the data rather than the data itself, sent to non-primary replicas so the coordinator can detect divergence cheaply.
- **Read repair** — when replica digests disagree, the coordinator fetches full data, reconciles, and writes the merged result back to stale replicas.

## 3. Theory & Internals

### The filter cascade on one replica

For a single-partition read, the replica does:

```
1. Memtable(s)               scan the current + any flushing memtables      (RAM)
2. For each SSTable, in order of newest first:
     a. min/max clustering + timestamp check from Statistics.db   -> skip?  (RAM)
     b. Bloom filter probe on the partition key                   -> skip?  (RAM)
     c. Key cache lookup (SSTable, key) -> offset                 -> hit?   (RAM)
     d. Index summary binary search -> narrow window in Index.db  (RAM)
     e. Read Index.db window -> exact Data.db offset              (DISK)
     f. Read + decompress the Data.db chunk                       (DISK/cache)
3. Merge all fragments by cell timestamp, apply tombstones
4. Apply the query's clustering slice, LIMIT, and column selection
```

Steps a–d are pure RAM. Only c/e/f can hit disk, and the whole point of the cascade is to make (e) and (f) happen for as few SSTables as possible.

### Bloom filter math

A bloom filter with `m` bits, `n` inserted keys, and the optimal `k = (m/n)·ln2` hash functions gives false-positive probability:

```
p ≈ (1 - e^(-kn/m))^k
bits per key  m/n  ≈  -1.44 · log2(p)
```

Cassandra exposes this as `bloom_filter_fp_chance` per table:

| `bloom_filter_fp_chance` | Bits per key | Memory for 1 B keys |
| --- | --- | --- |
| 0.01 (LCS default) | ~9.6 | ~1.2 GB |
| 0.1 (STCS/TWCS default in 4.x) | ~4.8 | ~0.6 GB |
| 0.001 | ~14.4 | ~1.8 GB |

A false positive costs one wasted index+data lookup; it never returns wrong data. Lowering `bloom_filter_fp_chance` to 0.001 on a read-heavy table with plenty of RAM is a cheap win; raising it to 0.1 on a write-heavy TWCS table saves memory you would rather give to the page cache. **False negatives are impossible** — a bloom filter never hides data that is present.

Changing the setting requires rewriting SSTables: `ALTER TABLE … WITH bloom_filter_fp_chance = 0.001;` then `nodetool upgradesstables -a <ks> <tbl>`.

```svg
<svg viewBox="0 0 660 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="330" fill="#eef2ff"/>
  <text x="18" y="26" font-size="15" fill="#1e293b" font-weight="bold">The read filter cascade: RAM first, disk last</text>
  <rect x="20" y="48" width="130" height="40" rx="6" fill="#ffffff" stroke="#4f46e5" stroke-width="1.7"/>
  <text x="32" y="73" font-size="12" fill="#1e293b">read(pk, ck range)</text>
  <rect x="20" y="106" width="600" height="40" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.7"/>
  <text x="34" y="131" font-size="12" fill="#1e293b">1. memtables (RAM) — always checked, holds the newest data</text>
  <rect x="20" y="156" width="600" height="34" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="34" y="178" font-size="12" fill="#1e293b">2. Statistics.db min/max clustering + timestamp — skip whole SSTables (RAM)</text>
  <rect x="20" y="198" width="600" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.7"/>
  <text x="34" y="220" font-size="12" fill="#1e293b">3. bloom filter probe — &quot;definitely not here&quot; in ~100 ns (RAM)</text>
  <rect x="20" y="240" width="290" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="34" y="262" font-size="12" fill="#1e293b">4a. key cache hit → exact offset (RAM)</text>
  <rect x="330" y="240" width="290" height="34" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="344" y="262" font-size="12" fill="#1e293b">4b. summary → Index.db window (DISK)</text>
  <rect x="20" y="282" width="600" height="34" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.9"/>
  <text x="34" y="304" font-size="12" fill="#1e293b">5. Data.db chunk read + LZ4 decompress → merge fragments by cell timestamp</text>
  <line x1="85" y1="88" x2="85" y2="106" stroke="#4f46e5" stroke-width="1.6" marker-end="url(#r22)"/>
  <defs>
    <marker id="r22" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#4f46e5"/></marker>
  </defs>
</svg>
```

### The merge

Once fragments are gathered, `UnfilteredRowIterators.merge` performs a k-way merge over iterators that are each already sorted by clustering key. For every cell:

- Highest **write timestamp** wins.
- If timestamps tie, the larger value wins (deterministic tiebreak).
- A **tombstone** with a timestamp ≥ the cell's timestamp deletes it.
- Range tombstones and partition-level tombstones shadow everything below their timestamp in their range.
- TTL'd cells past expiry become tombstones for the purposes of the merge.

This is why deletes cost reads: a partition with 50,000 tombstones forces the merge to walk 50,000 entries to return zero rows. `tombstone_warn_threshold: 1000` logs a warning; `tombstone_failure_threshold: 100000` aborts the query with `TombstoneOverwhelmingException` (Chapter 24).

### Caches, and when they help

| Cache | Scope | Default | Use it when |
| --- | --- | --- | --- |
| Key cache | `(SSTable, partition key)` → offset, on-heap | `key_cache_size` auto (min 5% heap / 100 MB) | Always. Cheap and effective. |
| Row cache | Whole partition (or first N rows), off-heap | **Disabled** (`row_cache_size: 0`) | Tiny, hot, read-mostly partitions only |
| Chunk cache | Decompressed `Data.db` chunks, off-heap | `file_cache_size` auto | Always; raise it if compression ratio is good |
| OS page cache | Raw file blocks | All free RAM | Always — leave RAM unallocated for it |
| Counter cache | Counter values | auto | Only if you use counters |

The row cache is the trap. It caches the *entire partition*, so a single write to that partition invalidates the whole entry, and a 200 MB partition consumes 200 MB of cache for one key. On a write-heavy or wide-partition table it is strictly worse than no cache. Enable it only per table (`caching = {'rows_per_partition': '100'}`) on small, hot, rarely-written partitions.

## 4. Architecture & Workflow

A `SELECT` at `LOCAL_QUORUM`, RF=3, end to end:

1. **Driver routes token-aware.** The partition key is hashed client-side and the request goes to a natural replica in the local DC, so the coordinator is usually also a replica.
2. **Coordinator picks replicas.** It orders the natural replicas using the snitch's proximity plus the dynamic snitch's latency scores (Chapter 19), then selects `LOCAL_QUORUM = 2`.
3. **One full data read, N-1 digest reads.** The closest replica gets a full data request; the others get **digest** requests that return only a hash of the reconciled result. This saves bandwidth — digests are 16 bytes regardless of row size.
4. **Speculative retry.** If the chosen replica has not answered within the table's `speculative_retry` budget (default `99p` — the 99th percentile of recent latency), the coordinator fires an extra request at another replica and takes whichever returns first.
5. **Each replica runs the local read path** described in §3: memtables, then the surviving SSTables after min/max, bloom, key-cache, summary, and index filtering, then the merge.
6. **Coordinator compares digests.** If all match, it returns the data immediately.
7. **If digests differ, blocking read repair runs.** The coordinator requests full data from the disagreeing replicas, merges, returns the correct answer to the client, and writes the reconciled result back to the stale replicas before responding (at QUORUM levels this is synchronous, which is what makes `R + W > RF` monotonic).
8. **Post-read filtering.** `LIMIT`, clustering slice bounds, and column selection are applied; note that `LIMIT` is applied *after* tombstones are walked, which is why a limited query can still trip the tombstone threshold.
9. **Result frame returned.** Paging (`fetch_size`, default 5000) may split it into multiple frames with a paging state cursor.

```svg
<svg viewBox="0 0 660 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="340" fill="#e0f2fe"/>
  <text x="18" y="26" font-size="15" fill="#1e293b" font-weight="bold">Coordinator read: 1 data + N-1 digests, then merge and repair</text>
  <rect x="20" y="120" width="80" height="42" rx="6" fill="#ffffff" stroke="#4f46e5" stroke-width="1.6"/>
  <text x="38" y="146" font-size="12" fill="#1e293b">client</text>
  <rect x="130" y="120" width="110" height="42" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.9"/>
  <text x="142" y="146" font-size="11" fill="#1e293b">coordinator</text>
  <line x1="100" y1="141" x2="130" y2="141" stroke="#4f46e5" stroke-width="1.7" marker-end="url(#q22)"/>
  <rect x="300" y="58" width="140" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="312" y="78" font-size="11" fill="#1e293b">replica A (closest)</text>
  <text x="312" y="95" font-size="10" fill="#1e293b">FULL DATA read</text>
  <rect x="300" y="120" width="140" height="46" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.6"/>
  <text x="312" y="140" font-size="11" fill="#1e293b">replica B</text>
  <text x="312" y="157" font-size="10" fill="#1e293b">DIGEST (16 bytes)</text>
  <rect x="300" y="182" width="140" height="46" rx="6" fill="#ffffff" stroke="#94a3b8" stroke-width="1.4"/>
  <text x="312" y="202" font-size="11" fill="#1e293b">replica C</text>
  <text x="312" y="219" font-size="10" fill="#1e293b">not contacted at LQ=2</text>
  <line x1="240" y1="132" x2="300" y2="86" stroke="#16a34a" stroke-width="1.7" marker-end="url(#q22b)"/>
  <line x1="240" y1="145" x2="300" y2="145" stroke="#d97706" stroke-width="1.7" marker-end="url(#q22c)"/>
  <line x1="240" y1="158" x2="300" y2="200" stroke="#94a3b8" stroke-width="1.3" stroke-dasharray="4 4"/>
  <rect x="480" y="58" width="160" height="108" rx="7" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.6"/>
  <text x="492" y="80" font-size="11" fill="#1e293b" font-weight="bold">digest compare</text>
  <text x="492" y="100" font-size="10" fill="#1e293b">match -&gt; return data</text>
  <text x="492" y="118" font-size="10" fill="#1e293b">mismatch -&gt; fetch full</text>
  <text x="492" y="136" font-size="10" fill="#1e293b">from all, merge,</text>
  <text x="492" y="154" font-size="10" fill="#1e293b">write back to stale</text>
  <line x1="440" y1="112" x2="480" y2="112" stroke="#4f46e5" stroke-width="1.6" marker-end="url(#q22)"/>
  <text x="20" y="262" font-size="12" fill="#1e293b" font-weight="bold">Inside replica A: merge fragments of one row</text>
  <rect x="20" y="274" width="96" height="30" rx="5" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="30" y="294" font-size="10" fill="#1e293b">memtable t=90</text>
  <rect x="126" y="274" width="96" height="30" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.4"/>
  <text x="136" y="294" font-size="10" fill="#1e293b">sst-9 t=70</text>
  <rect x="232" y="274" width="96" height="30" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.4"/>
  <text x="242" y="294" font-size="10" fill="#1e293b">sst-4 tombstone</text>
  <rect x="338" y="274" width="96" height="30" rx="5" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.4"/>
  <text x="348" y="294" font-size="10" fill="#1e293b">sst-1 t=20</text>
  <rect x="460" y="268" width="180" height="42" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="1.8"/>
  <text x="472" y="286" font-size="10" fill="#1e293b">highest timestamp per cell</text>
  <text x="472" y="302" font-size="10" fill="#1e293b">wins; tombstones shadow</text>
  <line x1="434" y1="289" x2="460" y2="289" stroke="#d97706" stroke-width="1.7" marker-end="url(#q22c)"/>
  <defs>
    <marker id="q22" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#4f46e5"/></marker>
    <marker id="q22b" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#16a34a"/></marker>
    <marker id="q22c" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#d97706"/></marker>
  </defs>
</svg>
```

## 5. Implementation

### Table-level read tuning

```cql
CREATE TABLE catalog.products (
  tenant_id  text,
  sku        text,
  name       text,
  price      decimal,
  updated_at timestamp,
  PRIMARY KEY ((tenant_id), sku)
) WITH compaction = {'class':'LeveledCompactionStrategy'}   -- ~1 SSTable per read
  AND bloom_filter_fp_chance = 0.001                        -- read-heavy: spend RAM
  AND caching = {'keys':'ALL', 'rows_per_partition':'NONE'} -- row cache OFF by default
  AND compression = {'class':'LZ4Compressor','chunk_length_in_kb':4}
  AND speculative_retry = '99p'
  AND read_repair = 'BLOCKING';

-- Small, hot, rarely-written lookup table: row cache genuinely pays here.
ALTER TABLE catalog.currency_rates
  WITH caching = {'keys':'ALL', 'rows_per_partition':'ALL'};

-- Changing bloom_filter_fp_chance only affects NEW SSTables until you rewrite:
ALTER TABLE catalog.products WITH bloom_filter_fp_chance = 0.001;
```

```yaml
# cassandra.yaml
key_cache_size:            # blank = auto (min(5% heap, 100MB))
key_cache_save_period: 14400s
row_cache_size: 0MiB       # keep OFF globally; enable per table if ever
file_cache_size: 2048MiB   # off-heap chunk cache for decompressed Data.db chunks
buffer_pool_use_heap_if_exhausted: false
concurrent_reads: 32       # ~16 * number of data disks
read_request_timeout: 5000ms
range_request_timeout: 10000ms
```

### Diagnosing read amplification

```bash
# THE diagnostic. SSTables-per-read is the number that predicts read latency.
nodetool tablehistograms catalog products
# catalog/products histograms
# Percentile  SSTables  Write Latency  Read Latency  Partition Size  Cell Count
#                           (micros)      (micros)         (bytes)
# 50%             1.00          20.50         89.10            1109          12
# 95%             2.00          35.43        215.00            4768          50
# 99%             3.00          51.01        943.13           17084         149
# Max            11.00         126.93      12108.97          943127        3311
#                 ^^^^^ p99 of 3 is healthy. A p99 of 15+ means compaction is behind.

nodetool tablestats catalog.products
# Bloom filter false positives: 4412
# Bloom filter false ratio: 0.00043       <- want < 0.01
# Bloom filter space used: 118.4 MiB
# Key cache hit rate: 0.938
# Compression ratio: 0.31
# Average live cells per slice (last five minutes): 12.4
# Average tombstones per slice (last five minutes): 0.0    <- want ~0

nodetool info | grep -A2 'Key Cache'
# Key Cache : entries 891244, size 96.4 MiB, capacity 100 MiB,
#             8123441 hits, 8661209 requests, 0.938 recent hit rate

# Which SSTables hold a given key? Proves read amplification for one partition.
nodetool getsstables catalog products 'tenant-88'
# /var/lib/cassandra/data/catalog/products-8a1f.../nb-2291-big-Data.db
# /var/lib/cassandra/data/catalog/products-8a1f.../nb-2317-big-Data.db
```

```cql
-- Cassandra 4.0+ virtual tables: per-SSTable and cache stats without JMX
SELECT keyspace_name, table_name, sstable_count, memtable_live_data_bytes
FROM system_views.local_read_latency LIMIT 5;

SELECT * FROM system_views.caches;
--  name        | capacity_bytes | entry_count | hit_ratio | recent_hit_rate_per_second
--  ChunkCache  |     2147483648 |      131072 |     0.972 | 48211
--  KeyCache    |      104857600 |      891244 |     0.938 | 12904

-- Trace a slow read to see exactly which SSTables were touched
TRACING ON;
SELECT * FROM catalog.products WHERE tenant_id='tenant-88' AND sku='SKU-1';
--  Bloom filter allows skipping sstable 2211  [ReadStage-3] | 12us
--  Key cache hit for sstable 2291             [ReadStage-3] | 19us
--  Merging data from memtables and 2 sstables [ReadStage-3] | 44us
--  Read 1 live rows and 0 tombstone cells     [ReadStage-3] | 71us
```

### Driver: paging and per-query consistency

```python
from cassandra.cluster import Cluster
from cassandra import ConsistencyLevel
from cassandra.query import SimpleStatement

session = Cluster(["10.0.1.14"]).connect("catalog")

sel = session.prepare("SELECT sku, name, price FROM products WHERE tenant_id = ?")
sel.consistency_level = ConsistencyLevel.LOCAL_QUORUM
sel.fetch_size = 500          # page size; default 5000

# Automatic paging - the driver fetches the next page lazily as you iterate.
for row in session.execute(sel, ("tenant-88",)):
    process(row)

# Manual paging for stateless HTTP APIs: hand the cursor back to the client.
stmt = SimpleStatement(
    "SELECT sku, name FROM products WHERE tenant_id=%s", fetch_size=100)
rs = session.execute(stmt, ("tenant-88",))
page_state = rs.paging_state              # opaque bytes, safe to base64 and return
next_rs = session.execute(stmt, ("tenant-88",), paging_state=page_state)

# Confirm the read touched few SSTables
rs = session.execute(sel, ("tenant-88",), trace=True)
for e in rs.get_query_trace().events:
    if "sstable" in e.description.lower():
        print(e.description, e.source_elapsed)
```

**Optimization:** the highest-leverage read tuning is not a cache setting — it is reducing SSTables-per-read. In order: (1) pick the right compaction strategy for the workload (LCS for read-heavy update-in-place, TWCS for time series) so `tablehistograms` p99 SSTables drops to 1–2; (2) lower `bloom_filter_fp_chance` to 0.001 on read-heavy tables and run `upgradesstables -a`; (3) reduce `chunk_length_in_kb` from 64 to 4–16 for small-row point lookups, because a 64 KB chunk must be fully decompressed to return a 200-byte row; (4) leave 40–50% of RAM unallocated for the OS page cache. Enabling the row cache is almost never the right answer.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
| --- | --- | --- |
| Bloom filters | Eliminate most SSTable lookups in ~100 ns from RAM | Consume heap proportional to key count; false positives waste one lookup each |
| Key cache | Turns a 2-step index lookup into a direct offset read | On-heap, so a huge key cache lengthens GC pauses |
| Row cache | Sub-100 µs reads on a hit | Invalidated by any write to the partition; caches whole partitions — usually a net loss |
| Chunk / page cache | Absorbs the real disk I/O; free performance | Requires leaving RAM unallocated; competes with heap |
| Digest reads | Quorum reads cost bandwidth of one row, not RF rows | An extra round trip when digests mismatch |
| Speculative retry | Hides one slow replica from p99 | Extra load on the cluster; can amplify an overload spiral |
| Immutable SSTables | Lock-free, page-cache-friendly reads | Read amplification: fragments spread across many files |
| Compression | 3–5× less disk I/O and better cache density | CPU to decompress; a large `chunk_length_in_kb` wastes work on small rows |

## 7. Common Mistakes & Best Practices

1. ⚠️ Enabling the row cache globally to "make reads faster" → ✅ Leave `row_cache_size: 0` and enable it per table only for small, hot, rarely-written partitions. On a write-heavy or wide-partition table it is invalidated constantly and simply burns memory.
2. ⚠️ `ALLOW FILTERING` to make a query "work" → ✅ It converts a targeted read into a scan of every partition on every replica. Model a second table with the right partition key (query-first modeling), or use SAI in 5.0 for genuinely low-cardinality filters.
3. ⚠️ Ignoring `nodetool tablehistograms` SSTables-per-read → ✅ It is the single best predictor of read latency. A p99 above ~10 means compaction is behind or your compaction strategy is wrong for the workload.
4. ⚠️ Unbounded partitions → ✅ A 2 GB partition means the partition index for it is huge, the row cache is useless, and any full-partition read is a disaster. Bucket the partition key; keep partitions under 100 MB and 100k rows.
5. ⚠️ Reading with `SELECT *` when you need three columns → ✅ Cassandra still reads and decompresses the containing chunks, but returning fewer columns cuts serialization and network cost meaningfully on wide rows. Select what you need.
6. ⚠️ Setting `bloom_filter_fp_chance` and expecting immediate effect → ✅ Bloom filters are baked into each SSTable at write time. You must run `nodetool upgradesstables -a <ks> <tbl>` (or wait for full compaction) for the change to apply to existing data.
7. ⚠️ Giving Cassandra 80% of RAM as heap → ✅ The read path depends on the OS page cache far more than on the heap. Keep the heap at 8–16 GB and leave the rest of RAM free so `Data.db` chunks stay cached.
8. ⚠️ Secondary index on a high-cardinality column (email, user_id, UUID) → ✅ A local secondary index is stored per node, so a lookup fans out to *every* node in the DC and each returns almost nothing. Use a denormalized lookup table, or SAI (5.0) which is much better but still not free.
9. ⚠️ Large `IN` clauses on partition keys → ✅ `IN (k1…k100)` makes one coordinator serially gather 100 partitions and blocks on the slowest. Issue 100 parallel async single-key reads with bounded concurrency instead.
10. ⚠️ Blaming the read path when tombstones are the problem → ✅ Check `Average tombstones per slice` in `tablestats`. If it is in the hundreds, no cache or bloom filter will save you; fix the delete pattern (Chapter 24).
11. ⚠️ Leaving `chunk_length_in_kb` at 64 for a point-lookup table → ✅ Every 200-byte row read decompresses 64 KB. Drop to 4–16 KB for small-row random-access tables; keep 64 KB for large sequential scans.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging
- `nodetool tablehistograms <ks> <tbl>` first, every time. SSTables p99, read latency p99, and partition size max tell you most of the story in one screen.
- `TRACING ON` in cqlsh for a single slow query shows bloom-filter skips, key-cache hits, how many SSTables were merged, and live-vs-tombstone cell counts.
- `nodetool getsstables <ks> <tbl> <key>` proves how fragmented one specific partition is.
- `nodetool tpstats`: `ReadStage` pending means you are CPU/disk bound; `Dropped READ` means requests exceeded `read_request_timeout` and were discarded.
- `nodetool proxyhistograms` gives coordinator-level latency including network; compare with `tablehistograms` (local) to separate network problems from storage problems.

### Monitoring
- `org.apache.cassandra.metrics:type=Table,keyspace=*,scope=*,name=SSTablesPerReadHistogram` — the leading indicator for read regression.
- `type=Table,name=ReadLatency` (local) vs `type=ClientRequest,scope=Read,name=Latency` (coordinator).
- `type=Table,name=BloomFilterFalseRatio` — alert above 0.05; `name=BloomFilterDiskSpaceUsed` for capacity planning.
- `type=Cache,scope=KeyCache,name=HitRate` — below ~0.85 means the cache is too small or the working set is too large.
- `type=Table,name=TombstoneScannedHistogram` and `name=LiveScannedHistogram` — the ratio between them is your tombstone health.
- `type=ClientRequest,scope=Read,name=Unavailables` and `name=Timeouts`.
- `type=Table,name=SpeculativeRetries` — a sudden rise means one replica is degrading.

### Security
- Reads are subject to RBAC: `GRANT SELECT ON KEYSPACE catalog TO analyst;`. Permissions are cached (`permissions_validity`, 2 s default), so a revoke is not instant.
- Cassandra has no row-level security. If tenants must be isolated, isolate them by partition key and enforce it in the application layer, or by keyspace with per-keyspace grants.
- Enable `client_encryption_options` — query results travel over the native protocol on port 9042 in plaintext otherwise.
- The 4.0 audit log (`audit_logging_options` with `included_categories: QUERY,DML`) can record reads, but at high QPS it is expensive; scope it to sensitive keyspaces.

### Performance & Scaling
- Read throughput scales with node count only if the workload is well distributed. A hot partition pins all its reads to RF nodes no matter how large the cluster is — the fix is data modeling, not more hardware.
- The dynamic snitch plus `speculative_retry = '99p'` is what keeps p99 stable when one node is compacting or GC-ing.
- On NVMe, reduce `chunk_length_in_kb` and raise `concurrent_reads`; on network-attached storage (EBS gp3), the OS page cache matters far more and larger chunks amortize IOPS.
- For analytics scans, use a separate `analytics` datacenter at RF=1 read at `LOCAL_ONE` so full scans never pollute the OLTP page cache (Chapter 19).

## 9. Interview Questions

**Q: Why is a Cassandra read more expensive than a write?**
A: A write is a sequential commit-log append plus a memtable insert with no lookup. A read must locate every fragment of the row — in the memtable and in any SSTable that might contain it — and merge them by cell timestamp while applying tombstones. The number of SSTables consulted, not the data volume, dominates read latency.

**Q: What is a bloom filter and what guarantees does it give?**
A: It is a per-SSTable bit array probed with `k` hash functions to answer "might this SSTable contain this partition key?" It has **no false negatives** — if it says no, the key is definitely absent, so the SSTable can be skipped without any disk I/O. It does have false positives at rate `bloom_filter_fp_chance`, each costing one wasted index and data lookup but never returning wrong data.

**Q: What is the difference between the key cache and the row cache?**
A: The key cache maps `(SSTable, partition key)` to a byte offset in `Data.db`, so a hit skips the index summary and partition index but still reads the data. The row cache stores whole partitions (or the first N rows) off-heap, so a hit avoids disk entirely — but any write to that partition invalidates the whole entry, which makes it a net loss on write-heavy or wide-partition tables. Key cache on by default, row cache off by default, for good reason.

**Q: What is the index summary for?**
A: `Index.db` maps every partition key to its offset in `Data.db`, but it is too large to keep in memory. `Summary.db` holds every 128th entry in RAM, so a binary search over the summary narrows the on-disk search to a small window of the index, turning what would be a large scan into one short sequential read.

**Q: What is a digest read?**
A: At consistency levels above ONE, the coordinator asks the closest replica for the full data and the other required replicas only for a digest — a hash of their reconciled result. If the digests all match, the data is returned immediately; if they differ, the coordinator fetches full data from the disagreeing replicas, merges, and repairs them. This makes quorum reads cost roughly the bandwidth of a single row.

**Q: How does Cassandra decide which version of a cell wins during a merge?**
A: The highest client-visible write timestamp wins, per cell, with the larger value as a deterministic tiebreaker on exact ties. Tombstones participate in the same comparison — a tombstone with a timestamp at or above the cell's timestamp deletes it. This is why clock skew across writers is a correctness problem.

**Q: What does `speculative_retry = '99p'` do?**
A: If a replica has not responded within the recent 99th-percentile latency for that table, the coordinator sends a duplicate request to another replica and uses whichever answers first. It hides a single slow or GC-ing replica from client p99, at the cost of extra cluster load — which is why an alternative setting is `ALWAYS` (aggressive) or `NONE` (when the cluster is already saturated).

**Q: (Senior) `tablehistograms` shows p99 SSTables-per-read of 24. What is happening and how do you fix it?**
A: Reads are touching 24 files, meaning the partition has fragments spread across many SSTables and compaction is not consolidating them. Typical causes: SizeTieredCompactionStrategy on an update-heavy table (each update lands in a new tier and stays there), compaction throughput throttled below the ingest rate so pending compactions are climbing, or too many small flushes from an undersized memtable. The fix is workload-matched: switch to LeveledCompactionStrategy for read-heavy update-in-place data (guarantees ~1 SSTable per level, ~90% of reads from one file), raise `compaction_throughput` and `concurrent_compactors`, or increase memtable size so flushes produce fewer, larger SSTables. Check `nodetool compactionstats` pending tasks before changing strategy — if it is just backlog, the strategy may be fine.

**Q: (Senior) A read at LOCAL_QUORUM returned stale data. How is that possible and how do you prove it?**
A: `R + W > RF` only guarantees overlap if *both* the write and the read used quorum levels on the same replica set. Common causes: the write actually went out at `ONE` or `ANY` (hint-only), the read used `LOCAL_QUORUM` in a DC that has not yet received the write and the write was `LOCAL_QUORUM` in another DC, clock skew made an older write carry a newer timestamp so it won the merge, or a bug in `USING TIMESTAMP` from application clocks. Prove it by reading at `ALL` with tracing on and comparing `WRITETIME()` per column across replicas — inspect the SSTables directly with `sstabledump` if needed. Fix clock sync first; multi-DC read-after-write requires reading in the same DC you wrote to.

**Q: (Senior) When would you deliberately raise `bloom_filter_fp_chance` instead of lowering it?**
A: On very large write-heavy tables where the bloom filters themselves have become a heap/memory problem and reads are rare or almost always hit recent data. TWCS time-series tables are the canonical case: reads target recent time windows that min/max timestamp pruning already isolates, so the bloom filter adds little, and at a billion keys per node the difference between 0.01 and 0.1 is roughly 600 MB of RAM you would rather give to the page cache. Cassandra 4.x already defaults TWCS/STCS tables to 0.1 for this reason.

**Q: Why can a `SELECT … LIMIT 1` still time out?**
A: `LIMIT` is applied after the storage engine has produced rows, so the merge must still walk everything that shadows the result — in particular tombstones. If the first 100,000 entries in the partition are tombstones, the read scans all of them, trips `tombstone_failure_threshold`, and throws `TombstoneOverwhelmingException` before ever returning one live row.

**Q: How does compression interact with the read path?**
A: `Data.db` is stored as independently compressed chunks of `chunk_length_in_kb` (64 KB default), with offsets in `CompressionInfo.db`. Reading a single 200-byte row requires reading and decompressing the entire containing chunk, so a large chunk size wastes CPU and I/O on point lookups while helping sequential scans. Small-row random-access tables should use 4–16 KB chunks.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A read rebuilds one logical row from the memtable plus every SSTable that might hold a fragment, so the metric that matters is SSTables-per-read. Cassandra minimizes it with a RAM-first cascade: `Statistics.db` min/max clustering and timestamp pruning, then a bloom filter probe (no false negatives, `bloom_filter_fp_chance` default 0.1 for STCS/TWCS and 0.01 for LCS), then the key cache for a direct offset, else the index summary → `Index.db` → `Data.db` chunk. Fragments are merged by highest cell timestamp with tombstones shadowing. At the coordinator, one replica gets a full data request and the rest get 16-byte digests; a mismatch triggers blocking read repair, `speculative_retry = '99p'` hides a slow replica. Key cache and chunk/page cache are always worth it; the row cache is off by default and usually should stay off. `nodetool tablehistograms` is the first command to run when reads are slow.

| Item | Value / Command |
| --- | --- |
| Primary diagnostic | `nodetool tablehistograms <ks> <tbl>` |
| Bloom guarantee | No false negatives; false positives at `bloom_filter_fp_chance` |
| Default fp chance | 0.1 (STCS/TWCS), 0.01 (LCS) |
| Bits per key | `≈ -1.44 · log2(p)` → 4.8 @ 0.1, 9.6 @ 0.01 |
| Index summary sampling | every 128th index entry (`min_index_interval`) |
| Key cache | `key_cache_size` auto = min(5% heap, 100 MB); ON |
| Row cache | `row_cache_size: 0` — OFF by default; enable per table only |
| Chunk cache | `file_cache_size`, off-heap, decompressed chunks |
| Compression chunk | `chunk_length_in_kb` 64 default; use 4–16 for point lookups |
| Tombstone thresholds | warn 1000, fail 100000 |
| Speculative retry | `'99p'` default |
| `read_request_timeout` | 5000 ms |
| Apply new bloom setting | `nodetool upgradesstables -a <ks> <tbl>` |
| Which files hold a key | `nodetool getsstables <ks> <tbl> <key>` |

Flash cards:
- **Number that predicts read latency?** → SSTables-per-read p99 from `nodetool tablehistograms`.
- **What can a bloom filter never do?** → Return a false negative — if it says the key is absent, the SSTable is safely skipped.
- **Why is the row cache usually harmful?** → It caches whole partitions and is invalidated by any write to them, so it thrashes on write-heavy or wide-partition tables.
- **What is a digest read?** → A 16-byte hash requested from non-primary replicas so quorum reads cost one row's bandwidth; a mismatch triggers read repair.
- **Changed `bloom_filter_fp_chance` — why no effect?** → Bloom filters are written into SSTables; existing files need `nodetool upgradesstables -a`.

## 11. Hands-On Exercises & Mini Project

- [ ] Insert one row, `nodetool flush`, update a different column, flush again, then run `nodetool getsstables` for that key — confirm two SSTables hold fragments of one logical row.
- [ ] Turn on `TRACING` and read that row; find the trace lines for bloom-filter skips, key-cache hits, and "Merging data from memtables and N sstables".
- [ ] Run `cassandra-stress` read against a table with STCS, record `tablehistograms` SSTables p99, then `ALTER` to LCS, run `nodetool compact`, and re-measure.
- [ ] Set `bloom_filter_fp_chance = 0.5` on a test table, run `upgradesstables -a`, and observe `Bloom filter false ratio` in `tablestats` climb — then explain the latency change.
- [ ] Enable the row cache on a wide, write-heavy table, run a mixed workload, and measure the hit rate to demonstrate why it is disabled by default.

### Mini Project — A read-latency forensics toolkit

**Goal.** Build a script that, given a keyspace and table, produces a ranked diagnosis of why reads are slow.

**Requirements.**
1. Collect `tablehistograms` (SSTables p50/p95/p99, read latency, partition size), `tablestats` (bloom false ratio, key cache hit rate, tombstones-per-slice, compression ratio), and `compactionstats` pending tasks.
2. Apply a rule set: SSTables p99 > 10 → compaction problem; bloom false ratio > 0.05 → raise bloom filter memory; key cache hit rate < 0.85 → cache too small; tombstones-per-slice > 100 → delete-pattern problem; max partition size > 100 MB → data-model problem.
3. Emit a ranked list of causes with the specific `ALTER TABLE` or `cassandra.yaml` change for each.
4. Run against a deliberately-broken table (STCS + heavy updates + wide partitions) and verify the toolkit identifies all three problems.
5. Add a `--trace` mode that executes a sample query with tracing and reports how many SSTables were actually merged.

**Extensions.**
- Extend it to compare `proxyhistograms` (coordinator) against `tablehistograms` (local) and flag network-dominated latency.
- Export the rule outcomes as Prometheus metrics so the diagnosis runs continuously.
- Add a "what-if" mode estimating the memory cost of dropping `bloom_filter_fp_chance` by an order of magnitude, using the `-1.44·log2(p)` bits-per-key formula and the table's estimated key count.

## 12. Related Topics & Free Learning Resources

Read with **The Write Path** (where these SSTables came from), **Compaction Strategies** (the single biggest lever on SSTables-per-read), **Tombstones & Deletes** (the most common cause of pathological reads), and **Hinted Handoff & Read Repair** (what a digest mismatch triggers).

- **Storage Engine and Read Path — Apache Cassandra Documentation** — Apache Software Foundation · *Intermediate* · The authoritative description of bloom filters, index summaries, and the merge. <https://cassandra.apache.org/doc/latest/cassandra/architecture/storage-engine.html>
- **Bigtable: A Distributed Storage System for Structured Data** — Chang et al. (Google) · *Advanced* · Section 6 on bloom filters and caching is the direct ancestor of Cassandra's read path. <https://static.googleusercontent.com/media/research.google.com/en//archive/bigtable-osdi06.pdf>
- **Space/Time Trade-offs in Hash Coding with Allowable Errors** — Burton Bloom (1970) · *Advanced* · The original bloom-filter paper; the false-positive derivation Cassandra's `bloom_filter_fp_chance` implements. <https://dl.acm.org/doi/10.1145/362686.362692>
- **Cassandra Caching Explained** — The Last Pickle · *Intermediate* · Honest, measurement-driven guidance on key cache, row cache, and chunk cache with real numbers. <https://thelastpickle.com/blog/2018/08/08/compression_performance.html>
- **Apache Cassandra 4.0 Virtual Tables** — DataStax / Apache · *Intermediate* · How to read cache, SSTable, and latency stats from `system_views` without JMX. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/virtualtables.html>
- **CASSANDRA-18058: Trie-indexed (BTI) SSTable format** — Apache JIRA · *Advanced* · The Cassandra 5.0 replacement for `Index.db` + `Summary.db` and why it helps wide partitions. <https://issues.apache.org/jira/browse/CASSANDRA-18058>
- **Storage Attached Indexing (SAI) in Cassandra 5.0** — Apache Software Foundation · *Advanced* · The modern secondary index, and precisely which read patterns it does and does not fix. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/indexing/sai/sai-concepts.html>
- **Scylla University: The Read Path** — ScyllaDB · *Beginner* · Free animated walkthrough of the same bloom-filter/cache/merge cascade, useful as a second explanation. <https://university.scylladb.com/courses/scylla-essentials-overview/lessons/architecture/>

---

*Apache Cassandra Handbook — chapter 22.*
