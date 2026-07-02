# 15 · Indexes, B-Trees & LSM-Trees

> **In one line:** An index trades write and storage cost for read speed — and the two dominant designs, B-trees and LSM-trees, sit at opposite ends of that trade.

---

## 1. Overview

A database has two fundamental jobs: store data durably, and find it fast. Storing it is easy — append to a file. *Finding* a specific row among a billion without reading them all is the hard part, and that is what an **index** solves. An index is an auxiliary data structure that maps a search key to the location of the data, turning an O(n) full scan into an O(log n) lookup (or O(1) for a hash index).

Nothing is free. Every index you add must be **kept up to date on every write** — insert, update, delete all touch the table *and* each index. So indexes are a deliberate trade: you pay write throughput and disk space to buy read speed. The engineering question is never "should I index?" but "which reads are hot enough to justify the write tax?"

Under the hood, two storage-engine designs dominate, and they optimize opposite sides of that trade. The **B-tree** (Postgres, MySQL/InnoDB, most relational stores) updates data *in place* in a balanced tree — excellent for reads and range scans, the classic read-optimized structure. The **LSM-tree** (Cassandra, RocksDB, LevelDB, ScyllaDB, HBase) never updates in place; it batches writes in memory and flushes sorted files to disk, turning random writes into sequential ones — the classic write-optimized structure.

Real example: a transactional order database that reads far more than it writes leans B-tree; a metrics/event pipeline ingesting millions of writes per second leans LSM. Same abstraction (a sorted key→value map), two physical realizations tuned for opposite workloads.

## 2. Core Concepts

- **Index** — a secondary structure mapping search keys to row locations, so a query finds rows without scanning the whole table. Speeds reads, taxes writes and storage.
- **Clustered index** — the table *is* the index: rows are stored physically in primary-key order (InnoDB's primary key). One per table; range scans on it are sequential and cheap.
- **Secondary (non-clustered) index** — a separate structure keyed by some other column, whose leaves point back to the row (by primary key or physical address). Multiple allowed; each adds write cost.
- **Covering index** — an index that contains every column a query needs, so the query is answered from the index alone without touching the table (no "back-fill"/heap fetch).
- **B-tree** — a balanced, high-fan-out tree of fixed-size pages; keys sorted within pages; updates happen **in place**. Logarithmic reads, great range scans, the default relational engine.
- **LSM-tree (Log-Structured Merge-tree)** — writes buffered in an in-memory **memtable**, flushed as immutable sorted **SSTables**, later merged by **compaction**. Turns random writes into sequential I/O.
- **WAL (Write-Ahead Log)** — an append-only durability log written *before* the change is applied, so an in-memory memtable (or an in-flight B-tree page write) survives a crash.
- **Write amplification** — bytes actually written to disk per logical byte written by the app. High in LSM (compaction rewrites data repeatedly) and in B-trees (full-page writes).
- **Read amplification** — disk reads needed to answer one logical read. High in LSM (a key may live in several SSTables); low in B-trees (one root-to-leaf path).
- **Bloom filter** — a compact probabilistic set that answers "key definitely absent / possibly present", letting an LSM skip SSTables that can't contain the key — the fix for read amplification.

## 3. Architecture

A B-tree keeps a single balanced tree updated in place; a read walks root→branch→leaf. An LSM-tree is a *pipeline*: writes hit the WAL and memtable, spill to sorted SSTables, and merge downward via compaction; a read checks the memtable, then SSTables newest→oldest, using Bloom filters to skip most of them.

```svg
<svg viewBox="0 0 770 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>

  <!-- B-TREE side -->
  <text x="195" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="700">B-Tree — read-optimized, in-place</text>
  <rect x="150" y="40" width="90" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="195" y="60" text-anchor="middle" fill="#1e293b">root</text>
  <rect x="70" y="110" width="90" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="115" y="130" text-anchor="middle" fill="#1e293b">branch</text>
  <rect x="230" y="110" width="90" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="275" y="130" text-anchor="middle" fill="#1e293b">branch</text>
  <rect x="30" y="180" width="70" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="65" y="200" text-anchor="middle" fill="#1e293b" font-size="11">leaf</text>
  <rect x="110" y="180" width="70" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="145" y="200" text-anchor="middle" fill="#1e293b" font-size="11">leaf</text>
  <rect x="230" y="180" width="70" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="265" y="200" text-anchor="middle" fill="#1e293b" font-size="11">leaf</text>
  <rect x="310" y="180" width="70" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="345" y="200" text-anchor="middle" fill="#1e293b" font-size="11">leaf</text>
  <line x1="180" y1="70" x2="130" y2="108" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="210" y1="70" x2="260" y2="108" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="100" y1="140" x2="70" y2="178" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="130" y1="140" x2="150" y2="178" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="260" y1="140" x2="270" y2="178" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="290" y1="140" x2="340" y2="178" stroke="#475569" marker-end="url(#a2)"/>
  <text x="205" y="238" text-anchor="middle" fill="#64748b" font-size="11">leaves linked → sorted range scan</text>
  <line x1="65" y1="216" x2="345" y2="216" stroke="#059669" stroke-dasharray="4 3"/>

  <line x1="400" y1="40" x2="400" y2="300" stroke="#cbd5e1"/>

  <!-- LSM side -->
  <text x="590" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="700">LSM-Tree — write-optimized, append</text>
  <rect x="430" y="45" width="120" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="490" y="66" text-anchor="middle" fill="#1e293b">WAL (durability)</text>
  <rect x="600" y="45" width="130" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="665" y="61" text-anchor="middle" fill="#1e293b">Memtable</text>
  <text x="665" y="75" text-anchor="middle" fill="#64748b" font-size="10">sorted, in RAM</text>
  <text x="560" y="66" text-anchor="middle" fill="#64748b" font-size="16">+</text>

  <text x="590" y="104" text-anchor="middle" fill="#64748b" font-size="11">flush when full ↓</text>
  <rect x="600" y="112" width="130" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="665" y="129" text-anchor="middle" fill="#1e293b" font-size="11">SSTable L0 (newest)</text>
  <rect x="600" y="146" width="130" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="665" y="163" text-anchor="middle" fill="#1e293b" font-size="11">SSTable L1</text>
  <rect x="600" y="180" width="130" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="665" y="197" text-anchor="middle" fill="#1e293b" font-size="11">SSTable L2 (oldest)</text>
  <line x1="665" y1="138" x2="665" y2="146" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="665" y1="172" x2="665" y2="180" stroke="#475569" marker-end="url(#a2)"/>
  <text x="748" y="163" text-anchor="middle" fill="#64748b" font-size="10" transform="rotate(90 748 163)">compaction</text>

  <rect x="430" y="150" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="490" y="169" text-anchor="middle" fill="#1e293b" font-size="11">Bloom filter</text>
  <text x="490" y="185" text-anchor="middle" fill="#64748b" font-size="10">skip SSTables</text>
  <line x1="550" y1="150" x2="598" y2="128" stroke="#475569" stroke-dasharray="3 3" marker-end="url(#a2)"/>

  <text x="585" y="238" text-anchor="middle" fill="#64748b" font-size="11">read: memtable → SSTables newest→oldest (Bloom-gated)</text>
</svg>
```

## 4. How It Works

**LSM write path** (the interesting one) and read path:

1. **Append to the WAL.** The write is first appended to the write-ahead log on disk — one sequential append — so durability is guaranteed even though the data is still only in memory.
2. **Insert into the memtable.** The row goes into an in-memory sorted structure (a skip list or balanced tree). Writes are now RAM-fast; this is why LSM ingests millions of writes/sec.
3. **Flush to an SSTable.** When the memtable exceeds a threshold (e.g. tens of MB), it is written to disk as an immutable, sorted **SSTable** — one big sequential write — and a fresh memtable takes over. The WAL for that segment can now be discarded.
4. **Compaction merges SSTables.** A background process merge-sorts multiple SSTables into fewer, larger ones, dropping overwritten values and **tombstones** (delete markers). This reclaims space and bounds read amplification.
5. **Read path.** Check the memtable first (newest data). Miss → check SSTables newest to oldest. Before touching an SSTable's disk blocks, consult its **Bloom filter**: if it says "absent", skip the file entirely. This is what keeps LSM reads acceptable despite data being spread across many files.
6. **Deletes are writes.** An LSM never erases in place — a delete appends a tombstone that shadows older values until compaction physically removes them.

By contrast a **B-tree write** finds the target leaf page via a root-to-leaf walk, modifies it **in place**, splitting the page (and propagating up) if it's full — logging to the WAL first for crash safety. Reads are a single logarithmic path; range scans follow linked leaves in sorted order.

## 5. Key Components / Deep Dive

### Clustered vs secondary indexes
A **clustered index** stores the rows themselves in key order — the leaf *is* the data (InnoDB primary key, or a table sorted by primary key). Only one is possible, and it makes primary-key range scans sequential and fast. A **secondary index** is a separate B-tree keyed on another column; its leaves hold a pointer back to the row (the primary key in InnoDB, or a physical row-id/heap tuple in Postgres). A secondary-index lookup therefore often costs two traversals — the index, then the back-fill to fetch the row — unless the index is **covering** (contains all needed columns), which skips the second step.

### Why B-trees suit reads
A B-tree's high fan-out (hundreds of keys per page) keeps it shallow — a billion keys fit in ~4 levels, so any read is ~4 page reads, with the upper levels cached in RAM. Data lives in exactly one place (no scanning multiple files), and sorted linked leaves make range scans and ORDER BY nearly free. The write cost is the price: in-place updates mean random I/O and page splits, and to be crash-safe every page change is first written to the WAL, then the page itself — write amplification of a full page even for a one-byte change.

### Why LSM-trees suit writes
LSM converts many random writes into a few large sequential writes (memtable flush), which is dramatically faster on both SSD and disk and causes less write-amplification *per write* at ingest time — though compaction later rewrites data, so total write amplification is a tuning parameter. There's no in-place update and no page splitting; you simply append. The cost is deferred to reads (a key may be in several SSTables) and to background compaction (CPU + I/O that competes with foreground traffic).

### Compaction strategies
- **Size-tiered** (Cassandra default) — merge SSTables of similar size; fewer merges, lower write amplification, but higher read/space amplification (many overlapping files).
- **Leveled** (RocksDB/LevelDB) — keep non-overlapping SSTables per level; each key is in ≤1 file per level, so reads are bounded and predictable, at the cost of more compaction I/O (higher write amplification).
The choice *is* the read-vs-write-vs-space amplification dial.

### Bloom filters — the read-amplification fix
Each SSTable ships a Bloom filter: a bit array where a key's hash sets several bits. Query hashes the key; if any bit is unset the key is **definitely not** in that SSTable and the file is skipped without a disk read. False positives (occasionally reading a file that lacks the key) are tunable via bits-per-key (e.g. ~10 bits → ~1% false positive). Without Bloom filters, a point lookup for a non-existent key would have to touch *every* SSTable — Bloom filters turn that into near-O(1).

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **B-tree** | Fast, predictable reads; excellent range scans/ORDER BY; strong for read-heavy OLTP; mature | In-place updates → random write I/O + full-page writes; write throughput ceiling; fragmentation |
| **LSM-tree** | Very high write throughput (sequential I/O); good compression; cheap deletes | Read/space amplification; compaction competes with live traffic; unpredictable tail latency |
| **Hash index** | O(1) point lookups; tiny | No range queries; must fit in memory (or careful on-disk design); poor for scans |
| **More secondary indexes** | Accelerate more query shapes; enable covering reads | Every index taxes every write; more storage; slower inserts/updates |

Pick a B-tree for read-dominated, latency-sensitive, range-scan workloads (transactional systems, most OLTP). Pick an LSM for write-dominated, high-ingest workloads (metrics, logs, event streams, time-series) where you can tolerate compaction-driven tail latency. It's the same read-vs-write trade the index itself embodies, one level down.

## 7. When to Use / When to Avoid

**Add an index when:**
- A query filters/sorts on a column and runs often enough to matter (hot read path).
- You can make it **covering** to eliminate heap fetches for a critical query.
- The table is large enough that a full scan misses your latency budget.

**Prefer an LSM engine when:**
- Write throughput dominates (ingest of events, metrics, time-series, IoT).
- Data is append-mostly and reads are recent-skewed or scan-by-range within a partition.

**Avoid / be careful when:**
- **Over-indexing** a write-heavy table — each index multiplies write cost; drop unused ones.
- Indexing a **low-cardinality** column (e.g. boolean) — the planner will often scan anyway.
- Using an LSM for a read-latency-critical, low-write workload — you inherit read/compaction overhead for no ingest benefit; a B-tree is simpler and faster.

## 8. Scaling & Production Best Practices

- **Index the queries you actually run.** Read the query plan (`EXPLAIN`); add composite indexes ordered by equality-then-range columns; make hot queries covering.
- **Prune ruthlessly.** Unused indexes are pure write tax and disk — monitor index usage and drop the dead ones.
- **Keep working set in RAM.** B-tree upper levels and LSM Bloom filters + memtable should be memory-resident; a cache miss to disk is 100–1000× slower.
- **Tune LSM compaction to the workload:** leveled for read-heavy/predictable latency, size-tiered for write-heavy/lower write-amp. Watch tombstone accumulation (deletes + TTL) — it silently amplifies reads.
- **Size Bloom filters** for your point-lookup-miss rate; ~10 bits/key ≈ 1% false positives is a common sweet spot.
- **Batch and order writes** to align with the storage engine (sequential keys reduce B-tree page splits; but monotonically increasing keys create hot pages/partitions — a known tension).
- **Rebuild/vacuum** periodically: B-trees fragment; Postgres bloat needs `VACUUM`; SSTables need compaction headroom (leave ~50% disk free).

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Compaction backlog (LSM) | Read amplification climbs, tail latency spikes, disk fills | Throttle ingest, add compaction throughput, alert on pending compactions & SSTable count |
| Tombstone flood (LSM) | Reads scan piles of delete markers; latency degrades | Bound TTLs, tune gc_grace, force compaction; avoid delete-heavy patterns |
| Write-amplification wears SSD | Premature disk wear, cost | Choose size-tiered where acceptable; provision endurance; monitor bytes-written |
| B-tree/index bloat & fragmentation | Slower reads, wasted space | Scheduled VACUUM/REINDEX; monitor bloat ratio |
| Missing index on hot query | Full table scans, CPU + latency blow-up | EXPLAIN in CI, alert on seq-scan-heavy queries, add covering index |
| WAL disk fills / fsync stalls | Writes block, crash-recovery grows long | Separate WAL disk, monitor WAL size & fsync latency, cap checkpoint interval |
| Bloom filter too small | Point-lookup misses read many SSTables | Increase bits/key; verify false-positive rate against target |

## 10. Monitoring & Metrics

- **Query latency p99 + rows-scanned vs rows-returned** — a high ratio means a missing/poor index.
- **Index hit ratio & buffer-cache hit ratio** — reads served from memory vs disk.
- **Write amplification** (bytes written to disk / bytes written by app) — LSM compaction health.
- **Read amplification** (SSTables/blocks read per lookup) and **Bloom-filter false-positive rate**.
- **Pending compactions / SSTable count per level** (LSM) — backlog early warning.
- **Tombstone ratio & TTL expiry backlog** (LSM).
- **Index bloat / fragmentation %** and **VACUUM lag** (B-tree/Postgres).
- **WAL size, fsync latency, checkpoint duration** — durability path health.

## 11. Common Mistakes

1. ⚠️ Adding indexes for every column "just in case" — each one taxes every write and bloats storage.
2. ⚠️ Forgetting the write cost of indexes entirely, then wondering why inserts slowed down.
3. ⚠️ Indexing low-cardinality columns where the planner scans anyway.
4. ⚠️ Not making a hot query **covering**, paying a heap back-fill on every read.
5. ⚠️ Using an LSM engine for a read-latency-critical, low-write workload and inheriting compaction overhead for nothing.
6. ⚠️ Delete-heavy or short-TTL patterns on an LSM, drowning reads in tombstones.
7. ⚠️ Ignoring compaction tuning and letting SSTable count (and read amplification) grow unbounded.
8. ⚠️ Monotonically increasing keys creating a single hot B-tree leaf / LSM partition (write hotspot).

## 12. Interview Questions

**Q: What is a database index and what does it cost?**
A: An auxiliary structure mapping a search key to row locations, turning an O(n) scan into O(log n) (or O(1) for a hash index). The cost is that every write must update the table *and* every index on it, plus the storage the index consumes. So indexing is a read-vs-write trade — you add one only for reads hot enough to justify the write tax.

**Q: Clustered vs secondary index — what's the difference?**
A: A clustered index stores the rows themselves in key order (the leaf is the data) — one per table, great for primary-key range scans. A secondary index is a separate structure keyed on another column whose leaves point back to the row, so a lookup often costs two traversals (index then heap fetch) unless it's a covering index that already holds every column the query needs.

**Q: Why is a B-tree good for reads?**
A: High fan-out keeps it shallow — a billion keys in ~4 levels — so any read is a handful of page fetches with upper levels cached in RAM. Data lives in exactly one place, and sorted, linked leaves make range scans and ORDER BY nearly free. The tradeoff is in-place updates causing random write I/O and page splits.

**Q: Walk me through an LSM-tree write.**
A: Append to the WAL for durability, insert into the in-memory sorted memtable (write is now RAM-fast). When the memtable fills, flush it to disk as one immutable sorted SSTable — a single sequential write — and start a fresh memtable. Background compaction later merge-sorts SSTables, dropping overwritten values and tombstones. Random writes become sequential I/O, which is why LSMs ingest so fast.

**Q: Why is an LSM good for writes but potentially bad for reads?**
A: Writes are sequential appends (memtable flush) instead of random in-place updates, so throughput is huge. But a key can live in the memtable and several SSTables, so a read may check many files — read amplification — and deletes are tombstones that pile up until compaction. Bloom filters and compaction mitigate this, but reads are inherently more work than a B-tree's single path.

**Q: What is a Bloom filter and why is it essential in an LSM?**
A: A compact probabilistic set that answers "definitely not present" or "possibly present" with no false negatives. Each SSTable has one; on a point lookup, if the filter says the key is absent, the engine skips that SSTable's disk reads entirely. Without it, looking up a non-existent key would touch every SSTable. Tunable via bits-per-key (~10 bits ≈ 1% false positives).

**Q: Explain read vs write amplification.**
A: Write amplification is bytes written to disk per logical byte the app writes — high in LSM because compaction rewrites data repeatedly, and in B-trees because a one-byte change writes a whole page (plus WAL). Read amplification is disk reads per logical read — high in LSM (multiple SSTables), low in B-trees (one path). Compaction strategy is the dial that trades write vs read vs space amplification.

**Q (senior): You run Cassandra and reads have gotten slow over weeks though writes are fine. Diagnose.**
A: Classic LSM read-amplification drift. Likely causes: compaction can't keep up (SSTable count and pending compactions climbing), or a delete/TTL-heavy pattern has produced a tombstone flood that reads must scan through. I'd check SSTables-per-read, pending compactions, and tombstone ratio; fixes are giving compaction more throughput, switching to leveled compaction for bounded reads, tuning gc_grace, and eliminating the delete-heavy access pattern. Also verify Bloom filters are sized right for point-lookup misses.

**Q (senior): Size-tiered vs leveled compaction — how do you choose?**
A: It's a read/write/space amplification choice. Size-tiered merges similar-sized SSTables — low write amplification, good for write-heavy ingest, but high read and space amplification (many overlapping files, needs ~50% free disk). Leveled keeps non-overlapping files per level so a key is in ≤1 file per level — bounded, predictable read latency and less space, but much higher compaction (write) amplification. Write-heavy time-series → size-tiered; read-latency-sensitive → leveled.

**Q (senior): Monotonically increasing primary keys (e.g. autoincrement, timestamp) — what's the hidden problem?**
A: All new writes hit the same "end" — one hot B-tree leaf page (contention, poor cache use) or, in a distributed LSM/wide-column store, one hot partition/node while others idle. It defeats horizontal write scaling. Mitigations: hash or salt the key, use a composite key that spreads the prefix, or a scheme like a bucketed key — trading the natural sort order for even write distribution.

**Q (senior): You have a read-heavy query that's still slow despite an index on the filter column. What next?**
A: Check `EXPLAIN`: it's probably doing an index lookup then a heap/back-fill fetch per row (the index isn't covering) or the planner chose a scan due to low selectivity. I'd build a **covering** composite index containing the filter columns plus the selected columns in the right order (equality columns first, then range/sort), so the query is answered from the index alone with no table access. If cardinality is the issue, reconsider whether an index helps at all.

## 13. Alternatives & Related

- **SQL vs NoSQL & Data Modeling** — which engine family (B-tree-backed relational vs LSM-backed wide-column) fits your access patterns.
- **Replication & Sharding** — how these engines are distributed and kept available across nodes.
- **Caching** — the layer above the storage engine that absorbs hot reads before they hit the index.
- **Hash indexes / inverted indexes** — point-lookup and full-text alternatives to the ordered index.
- **Fractal / B-ε trees** (TokuDB) and **column stores** (Parquet, ClickHouse) — engines tuned for other points on the read/write/analytics trade.

## 14. Cheat Sheet

> [!TIP]
> - **Index = read speed bought with write + storage cost.** Index only hot reads; drop unused indexes.
> - **B-tree = read-optimized, in-place.** Shallow high-fan-out tree, one read path, great range scans. Cost: random write I/O, page splits.
> - **LSM = write-optimized, append.** WAL → memtable → flush to immutable SSTable → compaction. Random writes become sequential; cost is read/space amplification.
> - **Deletes in LSM are tombstones**, removed only at compaction — beware delete/TTL floods.
> - **Bloom filters** let LSM reads skip SSTables that can't hold the key — the read-amplification fix.
> - **Compaction strategy is the dial:** leveled → bounded reads, more write-amp; size-tiered → cheap writes, more read/space-amp.
> - **Clustered index = rows in key order (one per table); secondary = pointer back to row.** Make hot queries **covering** to skip the heap fetch.
> - **Choose engine by workload:** read-heavy OLTP → B-tree; write-heavy ingest/time-series → LSM.

**References:** DDIA ch.3 (Storage & Retrieval), "The Log-Structured Merge-Tree" (O'Neil et al., 1996), Bigtable paper (Google, 2006), RocksDB & Cassandra compaction docs

---
*System Design Handbook — topic 15.*
