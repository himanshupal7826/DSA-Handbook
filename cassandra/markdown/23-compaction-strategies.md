# 23 · Compaction Strategies: STCS, LCS & TWCS

> **In one line:** Compaction is the background process that merges immutable SSTables to reclaim space and bound read amplification, and choosing between SizeTiered, Leveled, and TimeWindow is the single highest-leverage tuning decision in a Cassandra cluster.

---

## 1. Overview

The LSM write path (Chapter 21) makes writing cheap by never modifying anything: every flush produces a new immutable SSTable, every update is a new version of a cell, every delete is a tombstone. Left alone, a table would accumulate thousands of SSTables, reads would touch dozens of files each (Chapter 22), and deleted data would never actually leave the disk. **Compaction** is the garbage collector that makes the whole design viable — it reads several SSTables, merges their rows, keeps only the winning version of each cell, drops purgeable tombstones, and writes out fewer, larger SSTables.

The problem it solves is the LSM triangle: you can optimize for **write amplification** (how many times a byte is rewritten), **read amplification** (how many files a read touches), or **space amplification** (how much dead data sits on disk), but you cannot minimize all three. Every compaction strategy is a fixed choice of where to sit on that triangle. SizeTieredCompactionStrategy minimizes write amplification and accepts high read and space amplification. LeveledCompactionStrategy minimizes read and space amplification and pays roughly 10× write amplification. TimeWindowCompactionStrategy sidesteps the triangle entirely for time-series data by grouping SSTables by time window and mostly never merging across windows.

Historically, Cassandra shipped only STCS (inherited from Bigtable's merging compaction). LCS arrived in 1.0, ported from LevelDB, for read-heavy workloads. DateTieredCompactionStrategy (DTCS) was added in 2.0 for time series, proved fragile, and was replaced by TWCS — written by Jeff Jirsa at Spotify, added in 3.0.8, and now the default recommendation for anything time-partitioned with a TTL. Cassandra 5.0 adds **Unified Compaction Strategy (UCS)**, which parameterizes the STCS↔LCS spectrum with a single scaling parameter and is likely to become the default.

The practical consequence: picking the wrong strategy does not produce a subtle regression, it produces an outage-shaped one. STCS on a TTL'd time-series table means expired data sits on disk for months because the tombstone and the data end up in different size tiers and never meet. LCS on a write-heavy table means compaction can never keep up and pending compactions climb until the disk fills. TWCS on a table where you delete arbitrary old rows means windows never drop cleanly. The strategy must match the *shape* of the workload, not the size of the data.

Concretely: a Discord-style message store, or any metrics/telemetry pipeline, partitions by `(entity, day)` with `default_time_to_live` set. With TWCS and one-day windows, a day's data lands in one SSTable, and 30 days later the entire file is past its TTL and is deleted whole — no merge, no tombstone scanning, no read impact. The same table under STCS would require reading and rewriting terabytes to reclaim the same space.

## 2. Core Concepts

- **Compaction** — merging N SSTables into fewer, keeping only the highest-timestamp version of each cell and dropping purgeable tombstones.
- **Write amplification** — bytes physically written divided by bytes the client sent; STCS ≈ 2 + log₄(N) rewrites, LCS ≈ 10×.
- **Read amplification** — SSTables consulted per read; LCS guarantees ~1 per level, STCS is unbounded in practice.
- **Space amplification** — disk used divided by live logical data; STCS can transiently need 50–100% headroom, LCS ~10%.
- **SizeTieredCompactionStrategy (STCS)** — buckets SSTables of similar size; compacts a bucket when it holds `min_threshold` (4) similar-sized files.
- **LeveledCompactionStrategy (LCS)** — maintains levels L0…Ln where each level is 10× the previous and, crucially, **SSTables within a level do not overlap** in key range.
- **TimeWindowCompactionStrategy (TWCS)** — groups SSTables by the time window their data falls into; compacts within a window with STCS and then leaves the window alone.
- **`gc_grace_seconds`** — 864000 (10 days) by default; a tombstone cannot be dropped by compaction before this elapses (Chapter 24).
- **Overlapping SSTables** — files whose partition-key ranges intersect; a tombstone can only be dropped if no overlapping SSTable holds older data for that key.
- **Major compaction** — `nodetool compact`, which merges everything into one huge SSTable; almost always a mistake under STCS.
- **Unified Compaction Strategy (UCS)** — Cassandra 5.0's parameterized strategy that spans the STCS–LCS spectrum via a scaling parameter `W`.

## 3. Theory & Internals

### SizeTieredCompactionStrategy

STCS groups SSTables into buckets of "similar" size, where similar means within `[avg × bucket_low, avg × bucket_high]` (defaults 0.5 and 1.5). When a bucket contains at least `min_threshold` (4) SSTables, they are merged into one. The output is roughly 4× larger, so it falls into the next bucket up, and the cycle repeats.

```
4 x 100 MB  ->  1 x ~400 MB
4 x 400 MB  ->  1 x ~1.6 GB
4 x 1.6 GB  ->  1 x ~6.4 GB
```

Write amplification: a row is rewritten once per tier promotion, so about `log₄(dataset / memtable_size)` times — for a 1 TB table with 512 MB flushes, roughly 5–6 rewrites. That is why STCS has the lowest write cost.

The two failure modes:
- **Space amplification.** Compacting four 1.6 GB files needs 6.4 GB of free space *before* it can delete the inputs. A large STCS table needs up to 50% free disk, and a major compaction needs 100%.
- **Old data never meets new data.** A row inserted a year ago sits in a 200 GB SSTable; a tombstone written today sits in a 100 MB one. They are in different buckets and will not be merged until the small ones grow big enough — which may be never. This is why STCS + TTL is a disaster.

### LeveledCompactionStrategy

LCS maintains a staircase of levels. L0 is a landing zone for flushed SSTables (they may overlap). L1 holds at most `10 × sstable_size_in_mb` of data, L2 at most 10× L1, and so on:

```
L0: flushed SSTables, overlapping, compacted into L1 aggressively
L1:   10 x 160 MB =   1.6 GB    non-overlapping
L2:  100 x 160 MB =    16 GB    non-overlapping
L3: 1000 x 160 MB =   160 GB    non-overlapping
```

The invariant that matters: **within L1 and above, SSTables have disjoint key ranges**. Therefore a partition key can appear in at most one SSTable per level. With a 3-level table, a read touches at most 3 SSTables plus whatever is in L0 — and because 90% of data lives in the deepest level, roughly 90% of reads are satisfied from a single SSTable.

The cost: promoting one SSTable from Ln to Ln+1 requires rewriting it plus all ~10 overlapping SSTables in Ln+1. Amortized write amplification is about 10× the data size, plus the L0→L1 work. On a write-heavy table this means compaction cannot keep up: L0 backs up, `nodetool compactionstats` pending climbs, reads degrade to L0 scans, and the disk fills.

```
LCS read amp   ≈ number of levels ≈ log10(dataset / (10 * sstable_size_in_mb))
LCS write amp  ≈ 10 per level transition
STCS read amp  ≈ number of buckets, unbounded under update-heavy load
STCS write amp ≈ log4(dataset / memtable_size)
```

```svg
<svg viewBox="0 0 660 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="340" fill="#eef2ff"/>
  <text x="18" y="26" font-size="15" fill="#1e293b" font-weight="bold">STCS buckets vs LCS levels</text>
  <text x="20" y="52" font-size="13" fill="#1e293b" font-weight="bold">STCS: merge 4 similar-sized files into 1</text>
  <g>
    <rect x="20" y="64" width="40" height="24" rx="3" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.3"/>
    <rect x="66" y="64" width="40" height="24" rx="3" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.3"/>
    <rect x="112" y="64" width="40" height="24" rx="3" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.3"/>
    <rect x="158" y="64" width="40" height="24" rx="3" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.3"/>
    <text x="206" y="81" font-size="11" fill="#1e293b">4 x 100 MB</text>
  </g>
  <line x1="290" y1="76" x2="320" y2="76" stroke="#0ea5e9" stroke-width="1.8" marker-end="url(#c23)"/>
  <rect x="326" y="60" width="120" height="32" rx="4" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.8"/>
  <text x="340" y="81" font-size="11" fill="#1e293b">1 x 400 MB</text>
  <text x="460" y="81" font-size="11" fill="#1e293b">needs 400 MB free first</text>
  <g>
    <rect x="20" y="104" width="70" height="24" rx="3" fill="#fef3c7" stroke="#d97706" stroke-width="1.3"/>
    <rect x="96" y="104" width="70" height="24" rx="3" fill="#fef3c7" stroke="#d97706" stroke-width="1.3"/>
    <text x="176" y="121" font-size="11" fill="#1e293b">bigger bucket: rarely meets the small one</text>
  </g>
  <text x="20" y="152" font-size="11" fill="#d97706">Old data and new tombstones live in different buckets, so deletes linger.</text>
  <line x1="20" y1="164" x2="640" y2="164" stroke="#94a3b8" stroke-width="1"/>
  <text x="20" y="188" font-size="13" fill="#1e293b" font-weight="bold">LCS: non-overlapping levels, each 10x the last</text>
  <rect x="20" y="200" width="52" height="24" rx="3" fill="#fef3c7" stroke="#d97706" stroke-width="1.4"/>
  <rect x="78" y="200" width="52" height="24" rx="3" fill="#fef3c7" stroke="#d97706" stroke-width="1.4"/>
  <rect x="136" y="200" width="52" height="24" rx="3" fill="#fef3c7" stroke="#d97706" stroke-width="1.4"/>
  <text x="200" y="217" font-size="11" fill="#1e293b">L0: overlapping landing zone</text>
  <g fill="#f0fdf4" stroke="#16a34a" stroke-width="1.3">
    <rect x="20" y="238" width="60" height="22" rx="3"/><rect x="84" y="238" width="60" height="22" rx="3"/>
    <rect x="148" y="238" width="60" height="22" rx="3"/><rect x="212" y="238" width="60" height="22" rx="3"/>
  </g>
  <text x="284" y="254" font-size="11" fill="#1e293b">L1: 1.6 GB, disjoint key ranges</text>
  <g fill="#f0fdf4" stroke="#16a34a" stroke-width="1.1">
    <rect x="20" y="272" width="28" height="20" rx="3"/><rect x="52" y="272" width="28" height="20" rx="3"/>
    <rect x="84" y="272" width="28" height="20" rx="3"/><rect x="116" y="272" width="28" height="20" rx="3"/>
    <rect x="148" y="272" width="28" height="20" rx="3"/><rect x="180" y="272" width="28" height="20" rx="3"/>
    <rect x="212" y="272" width="28" height="20" rx="3"/><rect x="244" y="272" width="28" height="20" rx="3"/>
  </g>
  <text x="284" y="287" font-size="11" fill="#1e293b">L2: 16 GB, disjoint — holds most of the data</text>
  <line x1="90" y1="224" x2="90" y2="238" stroke="#16a34a" stroke-width="1.5" marker-end="url(#c23b)"/>
  <line x1="150" y1="260" x2="150" y2="272" stroke="#16a34a" stroke-width="1.5" marker-end="url(#c23b)"/>
  <text x="20" y="316" font-size="11" fill="#16a34a">A key appears in at most 1 SSTable per level, so ~90% of reads touch exactly 1 file.</text>
  <text x="20" y="332" font-size="11" fill="#d97706">Price: ~10x write amplification. On write-heavy tables L0 backs up and never drains.</text>
  <defs>
    <marker id="c23" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#0ea5e9"/></marker>
    <marker id="c23b" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#16a34a"/></marker>
  </defs>
</svg>
```

### TimeWindowCompactionStrategy

TWCS partitions SSTables by the time window their **maximum write timestamp** falls into, defined by `compaction_window_unit` × `compaction_window_size`.

- The **current** window is compacted with STCS as new flushes arrive.
- Once a window closes (its window is entirely in the past), its SSTables are compacted **once** into a single SSTable and then left alone forever.
- SSTables from different windows are **never** merged together.

That last rule is the magic. With `default_time_to_live` set, an entire window's SSTable eventually consists exclusively of expired data. `Statistics.db` records the max local deletion time, so Cassandra can check `maxLocalDeletionTime < now - gc_grace_seconds` and **drop the whole file** without reading a byte of it. Reclaiming 30 days of expired telemetry becomes an `unlink()`, not a terabyte-scale merge.

Sizing the window: aim for **20–40 windows alive at once**. If your TTL is 30 days, one-day windows give 30 files — good. One-hour windows would give 720 SSTables per table, which destroys read performance and bloats bloom-filter memory. One-month windows give 1 file, so you reclaim space only once a month and reads scan huge files.

```
target_windows ≈ TTL / (compaction_window_size × unit)     # want 20-40
```

TWCS breaks if you write out-of-order data (backfilling last month's rows lands them in the current window), issue explicit deletes of old rows (creates tombstones in the current window that shadow data in old windows and prevent dropping them), or read across many windows.

### Choosing

| Workload | Strategy | Why |
| --- | --- | --- |
| Write-heavy, few updates, rarely read | STCS | Lowest write amplification; read amp is acceptable |
| Read-heavy, rows updated in place | LCS | ~1 SSTable per read; worth the 10× write cost |
| Time series with TTL, append-only | TWCS | Whole-SSTable expiry; near-zero reclaim cost |
| Very large, write-heavy, spinning disks | STCS | LCS compaction will never catch up |
| Mixed / unsure, Cassandra 5.0 | UCS | Tune `scaling_parameters` toward STCS or LCS without a rewrite |

## 4. Architecture & Workflow

How a compaction actually runs:

1. **A strategy proposes work.** Each table's `CompactionStrategyManager` is asked for the next task after every flush and periodically. STCS returns a bucket with ≥ `min_threshold` files; LCS returns the level with the highest "score" (bytes over target); TWCS returns the current window's bucket or a newly-closed window.
2. **`CompactionExecutor` picks it up.** `concurrent_compactors` (default: min(#disks, #cores), capped at 8) threads run tasks in parallel, throttled collectively by `compaction_throughput` (64 MiB/s default in 4.x).
3. **Scanners open.** One `SSTableScanner` per input file, each producing partitions in token order.
4. **k-way merge.** `CompactionIterator` merges the scanners. For each partition, rows are merged by clustering key; for each cell, the highest write timestamp wins (identical logic to the read path).
5. **Purge decisions.** A tombstone is dropped only if `localDeletionTime < now - gc_grace_seconds` **and** no SSTable *outside this compaction* overlaps that key with older data. This overlap check is why tombstones survive far longer than `gc_grace_seconds` under STCS.
6. **Write output.** New SSTables are written sequentially with fresh bloom filters, indexes, and statistics. Under LCS the output is split into `sstable_size_in_mb` (160 MB) chunks so the level stays non-overlapping.
7. **Atomic swap.** The new SSTables are added to the live set and the inputs are marked obsolete in a single transaction (`LogTransaction`, recorded in a `.log` file so a crash mid-compaction is recoverable).
8. **Old files deleted.** Once no read is still referencing them, the input files are unlinked. Snapshots and incremental-backup hard links keep them alive if present — a common cause of "compaction ran but disk did not shrink."
9. **TWCS fast path.** If an entire SSTable's `maxLocalDeletionTime` is past, `unchecked_tombstone_compaction`/expiry logic drops the whole file without a merge at all.

```svg
<svg viewBox="0 0 660 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="660" height="330" fill="#e0f2fe"/>
  <text x="18" y="26" font-size="15" fill="#1e293b" font-weight="bold">TWCS: windows close, then whole SSTables expire</text>
  <text x="20" y="52" font-size="12" fill="#1e293b">compaction_window_unit = DAYS, size = 1, default_time_to_live = 30 days</text>
  <rect x="20" y="70" width="86" height="56" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.6"/>
  <text x="32" y="92" font-size="11" fill="#1e293b">day -30</text>
  <text x="32" y="110" font-size="10" fill="#1e293b">1 sstable</text>
  <rect x="116" y="70" width="86" height="56" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.6"/>
  <text x="128" y="92" font-size="11" fill="#1e293b">day -29</text>
  <text x="128" y="110" font-size="10" fill="#1e293b">1 sstable</text>
  <rect x="212" y="70" width="86" height="56" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.6"/>
  <text x="224" y="92" font-size="11" fill="#1e293b">day -2</text>
  <text x="224" y="110" font-size="10" fill="#1e293b">1 sstable</text>
  <rect x="308" y="70" width="86" height="56" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.6"/>
  <text x="320" y="92" font-size="11" fill="#1e293b">day -1</text>
  <text x="320" y="110" font-size="10" fill="#1e293b">1 sstable</text>
  <rect x="404" y="70" width="130" height="56" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="416" y="90" font-size="11" fill="#1e293b" font-weight="bold">today (open)</text>
  <text x="416" y="107" font-size="10" fill="#1e293b">STCS within window</text>
  <text x="416" y="121" font-size="10" fill="#1e293b">4-8 sstables</text>
  <text x="546" y="100" font-size="11" fill="#1e293b">flushes land here</text>
  <line x1="534" y1="98" x2="544" y2="98" stroke="#d97706" stroke-width="1.6"/>
  <text x="20" y="160" font-size="12" fill="#1e293b" font-weight="bold">Window closes → compact once → never merged across windows again</text>
  <rect x="20" y="180" width="150" height="46" rx="6" fill="#ffffff" stroke="#94a3b8" stroke-width="1.6" stroke-dasharray="5 4"/>
  <text x="32" y="200" font-size="11" fill="#1e293b">day -31 sstable</text>
  <text x="32" y="217" font-size="10" fill="#1e293b">all cells past TTL</text>
  <line x1="170" y1="203" x2="230" y2="203" stroke="#16a34a" stroke-width="2" marker-end="url(#t23)"/>
  <rect x="236" y="180" width="240" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.8"/>
  <text x="248" y="200" font-size="11" fill="#1e293b">maxLocalDeletionTime &lt; now - gc_grace</text>
  <text x="248" y="217" font-size="11" fill="#1e293b">→ delete the whole file, zero merge I/O</text>
  <text x="20" y="256" font-size="12" fill="#1e293b" font-weight="bold">Under STCS the same table would need a terabyte-scale merge to reclaim it.</text>
  <text x="20" y="282" font-size="11" fill="#d97706">Breaks TWCS: backfilling old data into today&apos;s window, explicit DELETEs of old rows,</text>
  <text x="20" y="300" font-size="11" fill="#d97706">reads spanning many windows, or windows sized so you keep 500+ SSTables alive.</text>
  <text x="20" y="322" font-size="11" fill="#16a34a">Target 20-40 live windows: TTL 30 days with 1-day windows = 30 SSTables. Correct.</text>
  <defs>
    <marker id="t23" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0 0 L6 3 L0 6 Z" fill="#16a34a"/></marker>
  </defs>
</svg>
```

## 5. Implementation

### DDL for each strategy

```cql
-- STCS: write-heavy, low update rate, rarely read (audit logs, raw event landing)
CREATE TABLE ops.raw_events (
  source text, day text, id timeuuid, payload blob,
  PRIMARY KEY ((source, day), id)
) WITH compaction = {
  'class': 'SizeTieredCompactionStrategy',
  'min_threshold': 4,
  'max_threshold': 32,
  'bucket_low': 0.5,
  'bucket_high': 1.5,
  'tombstone_threshold': 0.2,           -- single-SSTable compaction if >20% droppable
  'tombstone_compaction_interval': 86400
};

-- LCS: read-heavy, rows updated in place (user profiles, product catalog)
CREATE TABLE catalog.products (
  tenant_id text, sku text, name text, price decimal,
  PRIMARY KEY ((tenant_id), sku)
) WITH compaction = {
  'class': 'LeveledCompactionStrategy',
  'sstable_size_in_mb': 160,
  'fanout_size': 10
} AND bloom_filter_fp_chance = 0.01;

-- TWCS: time series with a TTL (metrics, IoT, message history)
CREATE TABLE telemetry.readings (
  sensor_id text, day text, ts timestamp, value double,
  PRIMARY KEY ((sensor_id, day), ts)
) WITH CLUSTERING ORDER BY (ts DESC)
  AND default_time_to_live = 2592000          -- 30 days
  AND gc_grace_seconds = 43200                -- 12 h: safe here, see note below
  AND compaction = {
    'class': 'TimeWindowCompactionStrategy',
    'compaction_window_unit': 'DAYS',
    'compaction_window_size': 1,
    'unsafe_aggressive_sstable_expiration': false
  };

-- Cassandra 5.0: Unified Compaction Strategy
CREATE TABLE app.events (...) WITH compaction = {
  'class': 'UnifiedCompactionStrategy',
  'scaling_parameters': 'T4',      -- T = tiered (STCS-like); L = leveled; N = middle
  'target_sstable_size': '1GiB'
};
```

> **Note:** lowering `gc_grace_seconds` is only safe on a table where you never issue explicit `DELETE`s and rely purely on TTL — expired TTL cells become tombstones with a known local deletion time, so a shorter grace does not risk zombie data the way it does with real deletes. If you also delete rows, keep 864000 and run repair within that window (Chapter 24).

### Changing strategy safely

```bash
# 1. Test on ONE node first via JMX (setCompactionParametersJson on
#    org.apache.cassandra.db:type=Tables,keyspace=ks,table=tbl), not the schema.
nodetool setcompactionthroughput 128       # give it headroom

# 2. Once validated, ALTER the schema. This rewrites everything.
cqlsh -e "ALTER TABLE telemetry.readings WITH compaction =
          {'class':'TimeWindowCompactionStrategy',
           'compaction_window_unit':'DAYS','compaction_window_size':1};"

# 3. Watch it drain. This can take hours or days on a large table.
watch -n5 nodetool compactionstats
# pending tasks: 187
# - telemetry.readings: 2 compactions
# id        compaction type  keyspace   table     completed    total     unit  progress
# 6a1f...   Compaction       telemetry  readings  4.11 GiB     12.7 GiB  bytes   32.36%
# concurrent compactors: 4 / throughput: 64 MiB/s

# 4. Verify the result
nodetool tablehistograms telemetry readings   # SSTables p99 should drop
nodetool tablestats telemetry.readings | grep -E 'SSTable count|Space used'
```

### Operating compaction

```yaml
# cassandra.yaml
concurrent_compactors: 4          # min(#data disks, #cores); more = more parallel, more CPU
compaction_throughput: 64MiB/s    # 0 = unthrottled; raise to 128-256 on NVMe
sstable_preemptive_open_interval: 50MiB
snapshot_before_compaction: false
```

```bash
# Live throughput changes, no restart needed
nodetool getcompactionthroughput      # Current compaction throughput: 64 MB/s
nodetool setcompactionthroughput 256  # temporarily, e.g. to catch up a backlog
nodetool setconcurrentcompactors 8

# Stop a runaway compaction (it will be re-proposed later)
nodetool stop COMPACTION

# Force compaction of a single table. Under STCS this creates ONE giant SSTable
# that will never compact again - use --split-output.
nodetool compact --split-output telemetry readings

# Under LCS, a "major" compaction is level-aware and much safer:
nodetool compact catalog products

# Inspect what a specific SSTable holds
sstablemetadata /var/lib/cassandra/data/telemetry/readings-*/nb-2291-big-Data.db
# SSTable: .../nb-2291-big
# Minimum timestamp: 1753000000000000
# Maximum timestamp: 1753086399000000
# SSTable level: 0
# Estimated droppable tombstones: 0.0412
# TTL min: 2592000  TTL max: 2592000
# maxLocalDeletionTime: 1755678399     <- when this whole file becomes droppable
```

```python
# Monitor pending compactions as a health signal from Python
from cassandra.cluster import Cluster
s = Cluster(["10.0.1.14"]).connect()

# Cassandra 4.0+ virtual table: no JMX required
for r in s.execute("SELECT keyspace_name, table_name, compaction_id, progress, total "
                   "FROM system_views.sstable_tasks"):
    pct = 100.0 * r.progress / r.total if r.total else 0
    print(f"{r.keyspace_name}.{r.table_name}: {pct:.1f}%")
# telemetry.readings: 32.4%
# catalog.products: 91.8%
```

**Optimization:** the most common real-world win is not switching strategy but *unblocking* the strategy you have. If `nodetool compactionstats` shows pending tasks steadily climbing, compaction is throughput-starved: raise `compaction_throughput` from 64 to 128–256 MiB/s and `concurrent_compactors` to match your core count on NVMe. Second win: on TWCS tables verify your window count with `ls -1 …/*Data.db | wc -l` — if you have 400 SSTables instead of 30, your window is too small and every read pays for it. Third: never run `nodetool compact` on an STCS table without `--split-output`; a single 900 GB SSTable can never be compacted again (it has no same-size peers), so its tombstones become immortal.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
| --- | --- | --- |
| STCS | Lowest write amplification (~log₄N rewrites); simple and predictable | High read amp; up to 50% space overhead; old data and new tombstones never meet |
| LCS | ~90% of reads hit 1 SSTable; ~10% space overhead; predictable latency | ~10× write amplification; compaction cannot keep up on write-heavy tables |
| TWCS | Whole-SSTable expiry makes TTL reclaim nearly free; bounded SSTable count | Only correct for append-only, time-ordered, TTL'd data; out-of-order writes break it |
| UCS (5.0) | One knob spans the STCS–LCS spectrum; retunable without changing strategy | New in 5.0; less operational field experience than the older three |
| Higher `compaction_throughput` | Drains backlogs, keeps read amp low | Competes with client I/O; can inflate read p99 while running |
| More `concurrent_compactors` | Parallel progress across tables | More CPU and heap; can starve `ReadStage` |
| Major compaction | Reclaims everything immediately | Under STCS produces one un-compactable giant file; needs 100% free disk |
| `tombstone_threshold` single-SSTable compaction | Reclaims tombstones without waiting for a full bucket | Rewrites files repeatedly; can churn on tables with steady deletes |

## 7. Common Mistakes & Best Practices

1. ⚠️ Leaving STCS on a TTL'd time-series table → ✅ Use TWCS. Under STCS, expired data lands in large old SSTables while tombstones land in small new ones; they are in different buckets and never merge, so disk usage grows without bound despite the TTL.
2. ⚠️ Running `nodetool compact` on a large STCS table → ✅ It produces one enormous SSTable with no same-size peers, so it will never be compacted again and its tombstones and overwritten data are stuck forever. If you must, use `--split-output`.
3. ⚠️ Choosing LCS because "it's better for reads" on a write-heavy table → ✅ Check the write rate first. If ingest exceeds what compaction can rewrite ~10×, L0 backlogs permanently, reads degrade to scanning L0, and pending compactions climb until the disk fills. STCS or UCS is correct there.
4. ⚠️ Setting TWCS windows so small you keep hundreds of SSTables → ✅ Target 20–40 live windows: `TTL / window_size ≈ 20–40`. One-hour windows with a 30-day TTL means 720 SSTables per table, wrecking read amplification and bloom-filter memory.
5. ⚠️ Issuing explicit `DELETE`s on a TWCS table → ✅ The tombstone lands in the *current* window and shadows data in old windows, which blocks those windows' SSTables from being dropped whole. Rely on TTL only; if you must delete, expect TWCS to lose its main advantage.
6. ⚠️ Backfilling historical data into a TWCS table → ✅ TWCS buckets by max write timestamp, so backfilled rows land in today's window regardless of their logical time. Load historical data with `USING TIMESTAMP` set to the correct time, or via `sstableloader` from correctly-windowed SSTables.
7. ⚠️ Ignoring `nodetool compactionstats` pending tasks → ✅ A steadily rising number is the earliest warning of a compaction crisis. Alert on pending > 100 sustained for 30 minutes and act before SSTable count and read latency blow up.
8. ⚠️ Running a cluster with less than 50% free disk on STCS tables → ✅ A compaction needs room for its output before it can delete its inputs. At 80% full, compactions start failing, SSTables accumulate, and the situation compounds into an outage.
9. ⚠️ Assuming compaction freed disk when it did not → ✅ Check for snapshots (`nodetool listsnapshots`) and incremental backups. Both are hard links that keep obsolete SSTables on disk; `nodetool clearsnapshot` is often the actual fix.
10. ⚠️ Throttling compaction to zero to protect client latency → ✅ `compaction_throughput: 0` means *unthrottled*, not disabled — a common misreading. And genuinely starving compaction trades a small latency win now for a guaranteed outage later.
11. ⚠️ Changing compaction strategy on a huge table during peak traffic → ✅ An `ALTER` rewrites every SSTable. Do it during a low-traffic window, one datacenter at a time, with `compaction_throughput` raised, and expect hours to days.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging
- `nodetool compactionstats -H` shows in-flight compactions, bytes done/total, and pending task count — the primary health view.
- `nodetool tablestats <ks>.<tbl>` → `SSTable count`, `Space used (live)` vs `(total)`. A large gap between live and total means obsolete files are pinned by snapshots.
- `sstablemetadata <file>` gives `SSTable level`, `Estimated droppable tombstones`, min/max timestamp and `maxLocalDeletionTime` — everything you need to reason about why a file has not been dropped.
- `nodetool tablehistograms` SSTables p99 is the outcome metric; if it is climbing, compaction is losing.
- For LCS, `nodetool tablestats` prints `SSTables in each level: [3, 10/10, 97/100, 412, 0, 0, 0, 0, 0]` — a large L0 count (first number) means compaction is behind.
- `grep -i 'compaction' /var/log/cassandra/system.log` for `CompactionInterruptedException` or "insufficient space to compact".

### Monitoring
- `org.apache.cassandra.metrics:type=Compaction,name=PendingTasks` — alert above 100 sustained.
- `type=Compaction,name=CompletedTasks`, `name=BytesCompacted`, `name=TotalCompactionsCompleted`.
- `type=Table,keyspace=*,scope=*,name=LiveSSTableCount` and `name=SSTablesPerReadHistogram`.
- `type=Table,name=EstimatedPartitionCount`, `name=CompressionRatio`, `name=TotalDiskSpaceUsed`.
- OS-level: disk utilization percent, and free space — alert at 60% used on STCS tables, not 90%.
- `system_views.sstable_tasks` (4.0+) gives the same data as `compactionstats` over CQL, easy to scrape.

### Security
- Compaction rewrites data into new files with default permissions from `umask`; verify the `cassandra` user's umask so new SSTables are not world-readable.
- Compaction is the mechanism by which deleted data is *actually* removed from disk. For GDPR/right-to-erasure, a `DELETE` is not sufficient — the data physically persists until compaction merges past `gc_grace_seconds` and the containing SSTables are rewritten. Plan (and be able to prove) the reclaim path; `nodetool garbagecollect` can force it per table.
- Snapshots taken before compaction (`snapshot_before_compaction: true`) preserve pre-deletion data indefinitely; leave it false unless you have a specific recovery requirement, and audit `snapshots/` directories for stale copies of erased data.

### Performance & Scaling
- Compaction I/O competes directly with client I/O. On shared cloud volumes (EBS gp3) budget IOPS for it explicitly; on NVMe raise `compaction_throughput` to 128–256 MiB/s and `concurrent_compactors` toward core count.
- Compaction is CPU-bound on decompression and comparison as well as I/O-bound. Under-provisioned cores show up as low disk utilization with high pending tasks.
- Plan disk capacity as `live data × 1.5` for STCS, `× 1.1–1.2` for LCS, `× 1.2` for TWCS. Never run a production node above 70% full.
- During bootstrap or rebuild, streamed SSTables land in L0 for LCS tables and produce a large compaction backlog; expect a period of elevated read latency and raise throughput temporarily.

## 9. Interview Questions

**Q: What does compaction do and why is it necessary?**
A: It merges multiple immutable SSTables into fewer, keeping only the highest-timestamp version of each cell and discarding purgeable tombstones and expired TTL cells. Without it, the LSM design would accumulate unbounded SSTables, reads would touch dozens of files each, and deleted or overwritten data would never leave the disk.

**Q: How does SizeTieredCompactionStrategy decide what to compact?**
A: It groups SSTables into buckets of similar size (within `bucket_low` × avg to `bucket_high` × avg) and compacts a bucket once it holds at least `min_threshold` (default 4) files, producing one roughly 4× larger SSTable that joins the next bucket up. This gives the lowest write amplification but leaves old large SSTables isolated from new small ones.

**Q: What invariant does LeveledCompactionStrategy maintain, and why does it matter?**
A: Within L1 and above, SSTables have disjoint partition-key ranges, so any given key appears in at most one SSTable per level. Since roughly 90% of data lives in the deepest level, roughly 90% of reads are answered from a single SSTable, giving predictable low read amplification and only ~10% space overhead.

**Q: When is TWCS the right choice?**
A: When data is append-only, written roughly in time order, partitioned so that a partition's rows fall inside one or a few time windows, and expired via TTL rather than explicit deletes. TWCS never merges across windows, so once every cell in a window's SSTable is past its TTL and `gc_grace_seconds`, the whole file is deleted without any merge I/O.

**Q: Why is `nodetool compact` on an STCS table usually a bad idea?**
A: It merges everything into one enormous SSTable. Because STCS only compacts files of similar size and that file now has no peers, it will never be compacted again — so overwritten data and tombstones inside it are effectively permanent, and the table's space and read characteristics degrade indefinitely. Use `--split-output` if you must.

**Q: Explain the three amplifications and how each strategy trades them.**
A: Write amplification is bytes rewritten per byte ingested, read amplification is SSTables touched per read, and space amplification is disk used per byte of live data. STCS minimizes write amp (~log₄N) at the cost of read and space amp. LCS minimizes read amp (~1 file) and space amp (~10%) at ~10× write amp. TWCS avoids the trade for time-series by scoping compaction to a window and reclaiming whole files.

**Q: How do you size a TWCS window?**
A: Divide the TTL (or retention period) by the window size and aim for 20–40 live windows. A 30-day TTL wants one-day windows (30 SSTables); a 90-day retention wants ~3-day windows. Too many windows means hundreds of SSTables and terrible read amplification; too few means you reclaim space rarely and read enormous files.

**Q: (Senior) Disk usage keeps growing on a TWCS table despite a 30-day TTL. Diagnose it.**
A: Check, in order: (1) `sstablemetadata` on old files for `maxLocalDeletionTime` — if it is in the future, some cells were written without the TTL or with a longer one; (2) whether the application issues explicit `DELETE`s, which put tombstones in the current window that shadow older windows and block whole-file drops; (3) whether backfill or replayed data is landing in the wrong window because TWCS buckets by write timestamp, not by the clustering timestamp; (4) `nodetool listsnapshots` — a forgotten snapshot hard-links obsolete SSTables; (5) whether repair created overlapping SSTables spanning windows (`-pr` incremental repair with TWCS is a known interaction to check). The most frequent real cause is explicit deletes on a TWCS table.

**Q: (Senior) You inherit an LCS table where `nodetool tablestats` shows `SSTables in each level: [847, 10/10, 98/100, 41, 0, …]`. What is wrong and what do you do?**
A: 847 SSTables in L0 means compaction is nowhere near keeping up — L0 is the unsorted landing zone, so every read now scans hundreds of overlapping files and read latency is catastrophic. Causes are ingest rate exceeding LCS's ~10× rewrite budget, `compaction_throughput` throttled too low, too few `concurrent_compactors`, or a recent bootstrap/repair that streamed a large amount into L0. Immediate action: raise `compaction_throughput` (to 256 or 0) and `concurrent_compactors` via `nodetool` to drain L0. Strategic action: if the ingest rate is structurally too high for LCS, move to STCS or UCS with a tiered scaling parameter — LCS is simply the wrong choice for that write rate.

**Q: (Senior) How does compaction decide whether it may drop a tombstone?**
A: Two conditions must both hold. First, the tombstone's `localDeletionTime` must be older than `gc_grace_seconds`, so every replica has had time to learn about the delete via repair or hints. Second, no SSTable *outside the set being compacted* may overlap that partition key with data older than the tombstone — otherwise dropping the tombstone would resurrect that older data as a zombie. This overlap check is why tombstones often survive far longer than `gc_grace_seconds` under STCS, where old data sits in large isolated SSTables, and it is one of the strongest arguments for LCS or TWCS on delete-heavy tables.

**Q: What is Unified Compaction Strategy in Cassandra 5.0?**
A: UCS replaces the discrete STCS/LCS choice with a single parameterized family: `scaling_parameters` of `T<n>` behaves tiered like STCS, `L<n>` behaves leveled like LCS, and values in between interpolate. Because the parameter can be changed per level and retuned without switching strategy, it lets operators move along the write-amp/read-amp curve as a workload evolves instead of committing up front.

**Q: Compaction completed but disk space did not drop. Why?**
A: Almost always because the obsolete SSTables are still hard-linked. `nodetool snapshot` (including automatic snapshots from `auto_snapshot` on TRUNCATE/DROP) and incremental backups create hard links that keep the inode alive after compaction unlinks the original. Run `nodetool listsnapshots` and `nodetool clearsnapshot`, and check the `backups/` directory. A second possibility is that the data was not actually purgeable yet — tombstones inside `gc_grace_seconds`, or overlapping SSTables blocking the purge.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Compaction merges immutable SSTables to bound read amplification and reclaim space, and every strategy is a fixed point on the write-amp / read-amp / space-amp triangle. **STCS** merges 4 similar-sized files into 1, giving the lowest write amplification (~log₄N rewrites) but unbounded read amplification, up to 50% space overhead, and the fatal property that old data and new tombstones sit in different buckets and never meet — never use it with TTLs. **LCS** keeps non-overlapping levels each 10× the last, so a key appears at most once per level and ~90% of reads touch one file, at ~10× write amplification that write-heavy tables cannot afford. **TWCS** buckets SSTables by write-timestamp window, compacts within a window and never across, so a fully-expired window's SSTable is deleted whole with zero merge I/O — correct for append-only TTL'd time series, broken by explicit deletes and backfills. Target 20–40 TWCS windows. `nodetool compactionstats` pending is the early warning; `nodetool compact` on STCS creates an immortal giant SSTable. Cassandra 5.0's UCS parameterizes the whole STCS↔LCS spectrum.

| Item | Value / Command |
| --- | --- |
| STCS `min_threshold` / `max_threshold` | 4 / 32 |
| STCS bucket window | `bucket_low` 0.5, `bucket_high` 1.5 |
| LCS `sstable_size_in_mb` / `fanout_size` | 160 / 10 |
| LCS level sizes | L1 = 10×160 MB, L2 = 100×160 MB, L3 = 1000×160 MB |
| TWCS window | `compaction_window_unit` + `compaction_window_size`; want 20–40 live |
| `gc_grace_seconds` | 864000 (10 days) default |
| `compaction_throughput` | 64 MiB/s default (0 = unthrottled) |
| `concurrent_compactors` | min(#disks, #cores), capped at 8 |
| Live view | `nodetool compactionstats -H` / `system_views.sstable_tasks` |
| Change throughput live | `nodetool setcompactionthroughput 256` |
| Per-file forensics | `sstablemetadata <Data.db>` |
| LCS level distribution | `nodetool tablestats` → `SSTables in each level` |
| Safe major compaction (STCS) | `nodetool compact --split-output` |
| Disk headroom | STCS 50%, LCS 10–20%, TWCS ~20% |

Flash cards:
- **STCS in one sentence?** → Merge 4 similarly-sized SSTables into 1; lowest write amp, worst read/space amp, and old data never meets new tombstones.
- **LCS invariant?** → SSTables within L1+ have disjoint key ranges, so a key is in at most one SSTable per level and ~90% of reads hit one file.
- **Why is TWCS cheap for TTL data?** → A fully-expired window's SSTable is dropped whole via `maxLocalDeletionTime`, with no merge I/O at all.
- **Two things that break TWCS?** → Explicit `DELETE`s (tombstones in the current window shadow old ones) and backfilled data landing in the wrong window.
- **Why is `nodetool compact` dangerous under STCS?** → It creates one giant SSTable with no same-size peers, so it never compacts again and its tombstones become permanent.

## 11. Hands-On Exercises & Mini Project

- [ ] Create the same table three times with STCS, LCS, and TWCS. Load 5 M rows with `cassandra-stress`, then compare `nodetool tablehistograms` SSTables p99 and total disk usage for each.
- [ ] On the STCS table, run `nodetool compact` (no `--split-output`), then `ls -lh` the data directory and explain why that single file is now a permanent problem.
- [ ] On the TWCS table, set a 60-second TTL and 1-minute windows, write for 10 minutes, and use `sstablemetadata` to watch `maxLocalDeletionTime` pass and whole SSTables disappear from `ls`.
- [ ] Deliberately starve compaction: `nodetool setcompactionthroughput 1`, run a heavy write load, and chart pending tasks and SSTable count climbing until reads degrade. Then recover with `setcompactionthroughput 256`.
- [ ] Take a snapshot, run a full compaction, and show with `du` that disk did not shrink — then `nodetool clearsnapshot` and show that it does.

### Mini Project — A compaction strategy advisor

**Goal.** Build a tool that recommends a compaction strategy per table from observed workload characteristics, and proves the recommendation with a benchmark.

**Requirements.**
1. For each table, collect: read/write ratio (from `type=Table,name=ReadLatency` and `WriteLatency` counts), whether `default_time_to_live` is set, whether the app issues `DELETE`s, current SSTables-per-read p99, disk usage, and pending compactions.
2. Encode the decision rules: TTL + append-only + time-ordered → TWCS with `window = TTL/30`; read-heavy + in-place updates + write rate within compaction budget → LCS; otherwise STCS (or UCS `T4` on 5.0).
3. Estimate the write-amplification cost of the recommendation and check it against the node's measured disk write throughput headroom — refuse to recommend LCS if ingest × 10 exceeds available I/O.
4. Emit the exact `ALTER TABLE` statement plus an estimated rewrite duration from table size and `compaction_throughput`.
5. Validate on three synthetic workloads (append-only TTL, read-heavy update, write-heavy log) and show the tool picks TWCS, LCS, and STCS respectively.

**Extensions.**
- Add a live "compaction debt" metric: pending tasks × average task size, tracked over time, to predict when the disk will fill.
- Benchmark UCS on Cassandra 5.0 with `T4`, `N`, and `L10` scaling parameters against the classic three and chart the read/write amp curves.
- Add a safety pre-check that refuses an `ALTER` if free disk is below the strategy's required headroom.

## 12. Related Topics & Free Learning Resources

Study with **The Write Path** (where SSTables come from), **The Read Path** (why SSTables-per-read is the metric compaction optimizes), **Tombstones & Deletes** (the purge rules compaction enforces), and **Repair & Anti-Entropy** (which interacts with compaction via incremental repair's repaired/unrepaired split).

- **Compaction — Apache Cassandra Documentation** — Apache Software Foundation · *Intermediate* · Canonical reference for all strategies with every subproperty and its default. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/compaction/index.html>
- **Time Window Compaction Strategy** — Jeff Jirsa / The Last Pickle · *Advanced* · From the author of TWCS: why DTCS failed, how windows are chosen, and exactly what breaks it. <https://thelastpickle.com/blog/2016/12/08/TWCS-part1.html>
- **Leveled Compaction in Apache Cassandra** — DataStax Engineering · *Intermediate* · The original explanation of the LevelDB-derived level invariant and its read/write trade. <https://www.datastax.com/blog/leveled-compaction-apache-cassandra>
- **The Log-Structured Merge-Tree (LSM-Tree)** — O'Neil, Cheng, Gawlick, O'Neil · *Advanced* · The formal treatment of the write/read amplification trade every strategy navigates. <https://www.cs.umb.edu/~poneil/lsmtree.pdf>
- **CASSANDRA-18397: Unified Compaction Strategy** — Apache JIRA · *Advanced* · Design docs and discussion for the 5.0 strategy that parameterizes STCS↔LCS. <https://issues.apache.org/jira/browse/CASSANDRA-18397>
- **How Not to Use Cassandra Compaction** — The Last Pickle · *Advanced* · Field war stories: major compactions, tombstone blocking, and STCS space blowups. <https://thelastpickle.com/blog/2017/03/16/compaction-nuance.html>
- **Compaction Strategies — Scylla University** — ScyllaDB · *Beginner* · Free, well-illustrated comparison of size-tiered, leveled, and time-window compaction. <https://university.scylladb.com/courses/scylla-operations/lessons/compaction-strategies/>
- **Apache Cassandra 5.0 Release Notes** — Apache Software Foundation · *Intermediate* · What changed in compaction, storage format (BTI), and indexing in 5.0. <https://cassandra.apache.org/doc/latest/cassandra/new/index.html>

---

*Apache Cassandra Handbook — chapter 23.*
