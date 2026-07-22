# 35 · Performance Tuning & Benchmarking

> **In one line:** Tune Cassandra in strict order — data model, then compaction throughput, then concurrency, then caches — and prove every change with a `cassandra-stress` run against a fixed workload, because guessing costs more than measuring.

---

## 1. Overview

Cassandra performance work splits cleanly into two activities that people constantly confuse. **Benchmarking** answers "what can this cluster do?" — a capacity question, best answered with a synthetic workload on a cluster you can abuse. **Tuning** answers "why is this cluster slower than it should be?" — a diagnosis question, best answered by finding the one saturated resource and relieving it. Running `cassandra-stress` on a production cluster to "see how fast it is" answers neither and risks both.

The problem tuning solves is that Cassandra's defaults are deliberately conservative. `compaction_throughput` at 64 MiB/s and `concurrent_compactors` at `min(cores, disks)` were chosen when spinning disks were common; on NVMe they leave 80% of your device idle while compaction falls behind. `concurrent_reads: 32` and `concurrent_writes: 32` assume moderate core counts. `file_cache_size_in_mb: 512` is tiny for a machine with 128 GB of RAM. None of these defaults are wrong — they are safe on the smallest plausible hardware, and safe means slow on modern hardware.

Historically, `cassandra-stress` shipped with Cassandra from the early days as a throughput demo and grew into a genuinely capable tool: user-defined YAML profiles let you declare your real schema, realistic column value distributions, partition-size distributions, and a mix of named queries with weights. It remains the only benchmark that exercises the actual server code path with the actual driver. Its main competitor in practice is NoSQLBench (originally from DataStax), which is more flexible and better at multi-phase scenarios but less universally available.

A concrete example. A 12-node cluster on NVMe ingesting 120k writes/s showed read p99 climbing from 6 ms to 90 ms over two weeks. `nodetool compactionstats` showed 340 pending tasks; `nodetool tablehistograms` showed p99 SSTables-per-read at 19. The disks were 12% utilised. The single change — `nodetool setcompactionthroughput 0` (unthrottled) and `concurrent_compactors: 8` — drained the backlog in nine hours and returned p99 to 7 ms. No schema change, no hardware, no JVM flags. **The default throttle was the bug.**

The mental model: **Cassandra is a pipeline of bounded resources — commit log fsync, memtable flush, compaction, read merge, network — and at any moment exactly one is your bottleneck.** Tuning is finding it and relieving it, then finding the next one. Benchmarking is what tells you which one you found. Anything else is cargo culting.

## 2. Core Concepts

- **`cassandra-stress`** — the bundled load generator; supports built-in `write`/`read`/`mixed` modes and `user profile=` YAML for your real schema and query mix.
- **Coordinated omission** — a benchmarking flaw where the load generator waits for slow responses and therefore stops issuing requests, hiding tail latency. Fixed by using a fixed rate (`-rate fixed=`) rather than `threads=`.
- **`compaction_throughput`** — cluster-wide cap in MiB/s on compaction I/O per node; `0` means unthrottled. The single highest-impact setting on modern SSDs.
- **`concurrent_compactors`** — number of simultaneous compaction tasks; each consumes CPU, I/O and heap.
- **`concurrent_reads` / `concurrent_writes`** — thread pool sizes for the ReadStage and MutationStage; queueing here shows up directly as latency.
- **Chunk cache (`file_cache_size_in_mb`)** — off-heap cache of decompressed SSTable chunks; the most effective cache in 4.0+.
- **`chunk_length_in_kb`** — compression block size (default 16 KB in 4.x, 64 KB in older releases); smaller blocks mean less read amplification for point reads.
- **Speculative retry** — per-table policy (`99p`, `MIN(99p,50ms)`, `ALWAYS`, `NEVER`) that sends a redundant request to another replica when the first is slow; trades extra load for tail-latency reduction.
- **Write amplification** — bytes written to disk per byte of logical data, driven by the compaction strategy: STCS ~ log(N), LCS much higher, TWCS ~ 1 for immutable time series.

## 3. Theory & Internals

**Where the time goes on a read.** A local read on one replica does: bloom filter check per SSTable (in memory, ~1 µs each), partition index lookup (`Summary` in memory, then `Index.db` possibly on disk), a chunk fetch per SSTable (chunk cache → page cache → device), then a merge of all row fragments plus memtable. Latency is therefore roughly `n_sstables × (bloom + index + chunk) + merge`. This is why SSTables-per-read is the dominant read metric: it multiplies almost every term. Bloom filters bound it — at the default `bloom_filter_fp_chance` of 0.01 for STCS (0.1 for LCS), a partition absent from an SSTable is skipped 99% of the time — but only for point lookups; a range scan must touch every SSTable that overlaps the token range regardless.

**The compaction throughput equation.** For SizeTieredCompactionStrategy, each byte is rewritten about `log₂(N)` times where N is the number of size tiers, typically 4–6 in steady state. So sustained compaction I/O ≈ `write_rate × 5`. A node ingesting 20 MB/s of logical writes needs roughly 100 MB/s of compaction bandwidth just to keep up. With the default `compaction_throughput: 64MiB/s`, that node falls behind permanently — pending tasks grow, SSTable count grows, read latency grows. On NVMe (2–7 GB/s), setting it to 0 is not reckless; the real limiter becomes `concurrent_compactors` and CPU. On network-attached storage with a hard IOPS budget, throttling is genuinely protective.

**Concurrency and Little's Law.** `concurrent_reads` is the ReadStage thread count. If mean service time is `S` and arrival rate is `λ`, you need at least `λ × S` threads to avoid queueing. At 20k reads/s per node and 1 ms service time that is 20 threads — the default 32 is fine. At 20k reads/s and 4 ms service time (cold cache, many SSTables) you need 80, and the default queues, adding `(λ×S - T)/λ` seconds of wait to every request. The guidance `concurrent_reads = 16 × number_of_drives` comes from the spinning-disk era; on NVMe, size it from measured service time instead, and remember that more threads than cores just moves the queue into the CPU scheduler.

**Caches, ranked by value.** OS page cache (free, huge, caches compressed SSTable blocks) > chunk cache (off-heap, caches *decompressed* chunks, so it saves CPU too) > key cache (on-heap, small, saves one index seek per read, target hit rate > 90%) > row cache (on-heap, invalidated by any write to the partition, almost always a net loss). Counter cache matters only for counter tables. The correct default posture is: large page cache (small heap), `file_cache_size_in_mb` of a few GB, `key_cache_size_in_mb` around 512, `row_cache_size_in_mb: 0`.

**Coordinated omission, concretely.** A stress run with `threads=200` issues at most 200 concurrent requests; when the server pauses for 500 ms, those threads block and issue *nothing*, so the pause is recorded as 200 slow samples instead of the ~10,000 requests that would have arrived in that window. Reported p99 looks fine. Running with `-rate fixed=50000/s` keeps issuing at the target rate and records the true queueing delay, which is what your users experience. Always benchmark at a fixed rate below saturation, and separately find saturation with a throughput ramp.

```svg
<svg viewBox="0 0 780 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="350" fill="#ffffff"/>
  <defs><marker id="a35" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 z" fill="#1e293b"/></marker></defs>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">The tuning pipeline: find the one saturated resource, relieve it, repeat</text>
  <rect x="20" y="48" width="140" height="76" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="90" y="70" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Client + driver</text>
  <text x="90" y="88" font-size="10" fill="#1e293b" text-anchor="middle">fetch_size, pool size</text>
  <text x="90" y="104" font-size="10" fill="#1e293b" text-anchor="middle">in-flight per conn</text>
  <rect x="180" y="48" width="140" height="76" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="250" y="70" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Coordinator</text>
  <text x="250" y="88" font-size="10" fill="#1e293b" text-anchor="middle">native_transport_</text>
  <text x="250" y="104" font-size="10" fill="#1e293b" text-anchor="middle">max_threads, spec retry</text>
  <rect x="340" y="48" width="140" height="76" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="410" y="70" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">ReadStage</text>
  <text x="410" y="88" font-size="10" fill="#1e293b" text-anchor="middle">concurrent_reads 32</text>
  <text x="410" y="104" font-size="10" fill="#1e293b" text-anchor="middle">pending = queueing</text>
  <rect x="500" y="48" width="140" height="76" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="570" y="70" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Caches</text>
  <text x="570" y="88" font-size="10" fill="#1e293b" text-anchor="middle">chunk, key, page</text>
  <text x="570" y="104" font-size="10" fill="#1e293b" text-anchor="middle">hit rate &gt; 0.9</text>
  <rect x="660" y="48" width="100" height="76" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="710" y="70" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Device</text>
  <text x="710" y="88" font-size="10" fill="#1e293b" text-anchor="middle">iostat %util</text>
  <text x="710" y="104" font-size="10" fill="#1e293b" text-anchor="middle">await, queue depth</text>
  <path d="M162 86 L176 86" stroke="#1e293b" stroke-width="2" marker-end="url(#a35)"/>
  <path d="M322 86 L336 86" stroke="#1e293b" stroke-width="2" marker-end="url(#a35)"/>
  <path d="M482 86 L496 86" stroke="#1e293b" stroke-width="2" marker-end="url(#a35)"/>
  <path d="M642 86 L656 86" stroke="#1e293b" stroke-width="2" marker-end="url(#a35)"/>
  <text x="20" y="156" font-size="13" font-weight="700" fill="#1e293b">Write path bottlenecks, in the order they bite</text>
  <rect x="20" y="170" width="175" height="66" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="107" y="192" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">1. Commit log</text>
  <text x="107" y="210" font-size="10" fill="#1e293b" text-anchor="middle">periodic fsync 10 s</text>
  <text x="107" y="226" font-size="10" fill="#1e293b" text-anchor="middle">own device if possible</text>
  <rect x="207" y="170" width="175" height="66" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="294" y="192" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">2. Memtable flush</text>
  <text x="294" y="210" font-size="10" fill="#1e293b" text-anchor="middle">memtable_flush_writers</text>
  <text x="294" y="226" font-size="10" fill="#1e293b" text-anchor="middle">blocked = backpressure</text>
  <rect x="394" y="170" width="175" height="66" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="481" y="192" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">3. Compaction</text>
  <text x="481" y="210" font-size="10" fill="#1e293b" text-anchor="middle">throughput x5 write rate</text>
  <text x="481" y="226" font-size="10" fill="#1e293b" text-anchor="middle">pending grows = losing</text>
  <rect x="581" y="170" width="179" height="66" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="670" y="192" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">4. Read merge</text>
  <text x="670" y="210" font-size="10" fill="#1e293b" text-anchor="middle">SSTables per read</text>
  <text x="670" y="226" font-size="10" fill="#1e293b" text-anchor="middle">p99 should be under 4</text>
  <path d="M197 203 L203 203" stroke="#1e293b" stroke-width="2" marker-end="url(#a35)"/>
  <path d="M384 203 L390 203" stroke="#1e293b" stroke-width="2" marker-end="url(#a35)"/>
  <path d="M571 203 L577 203" stroke="#1e293b" stroke-width="2" marker-end="url(#a35)"/>
  <rect x="20" y="256" width="740" height="34" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="390" y="278" font-size="12" fill="#1e293b" text-anchor="middle">Compaction bandwidth needed = write rate x log2(tiers), about 5x for STCS. Default 64 MiB/s is often the real limit.</text>
  <text x="20" y="312" font-size="12" fill="#1e293b">Tuning order: data model, then compaction throughput, then concurrency, then caches, then JVM. Never the reverse.</text>
  <text x="20" y="332" font-size="12" fill="#1e293b">Benchmark at a fixed rate (-rate fixed=N/s) to avoid coordinated omission; ramp separately to find saturation.</text>
</svg>
```

## 4. Architecture & Workflow

A disciplined benchmark-and-tune loop:

1. **Define the workload.** Write a `cassandra-stress` user profile with your real schema, realistic partition-size and value distributions, and your actual query mix with weights. A benchmark on `keyspace1.standard1` tells you about `standard1`, not about your application.
2. **Build a clean cluster** that mirrors production shape: same instance type, same disk type, same RF, same number of racks. Three nodes minimum so replication and coordination are exercised.
3. **Load a realistic dataset** — at least large enough that the working set exceeds RAM, otherwise you are benchmarking the page cache. Then run compaction to steady state (`nodetool compactionstats` shows 0 pending) before measuring anything.
4. **Find saturation** with a throughput ramp: run fixed-rate tests at increasing rates until p99 knees upward. That knee is your capacity number.
5. **Measure at 60–70% of saturation** with `-rate fixed=`, for at least 15 minutes, discarding the first few minutes. This is your comparable baseline.
6. **Change exactly one thing.** Re-run the identical workload. Compare p50/p99/p999, throughput, and the server-side story (`nodetool tpstats`, `compactionstats`, `tablehistograms`, `gcstats`).
7. **Verify the change under stress**, not just at steady state: does it still hold when a node is down, when compaction backlog exists, when the cache is cold after a restart?
8. **Promote to a canary node** in production, compare against untouched peers for a full peak period, then roll out.

```svg
<svg viewBox="0 0 780 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="330" fill="#ffffff"/>
  <defs><marker id="b35" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 z" fill="#1e293b"/></marker></defs>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">Throughput ramp: finding the knee, and why fixed-rate matters</text>
  <line x1="70" y1="230" x2="70" y2="56" stroke="#1e293b" stroke-width="2"/>
  <line x1="70" y1="230" x2="530" y2="230" stroke="#1e293b" stroke-width="2"/>
  <text x="40" y="62" font-size="11" fill="#1e293b" text-anchor="middle">p99</text>
  <text x="300" y="252" font-size="11" fill="#1e293b" text-anchor="middle">offered load (ops/s)</text>
  <path d="M70 216 L160 212 L250 206 L330 196 L390 178 L430 140 L470 88 L510 62" stroke="#4f46e5" stroke-width="3" fill="none"/>
  <circle cx="390" cy="178" r="6" fill="#d97706" stroke="#1e293b" stroke-width="2"/>
  <text x="390" y="164" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">knee</text>
  <line x1="70" y1="196" x2="530" y2="196" stroke="#16a34a" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="560" y="200" font-size="11" fill="#1e293b">SLO p99</text>
  <line x1="330" y1="230" x2="330" y2="56" stroke="#16a34a" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="330" y="272" font-size="11" fill="#1e293b" text-anchor="middle">run steady tests here</text>
  <text x="330" y="288" font-size="11" fill="#1e293b" text-anchor="middle">(60-70% of knee)</text>
  <rect x="560" y="60" width="200" height="110" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="660" y="82" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">threads=N mode</text>
  <text x="660" y="102" font-size="10" fill="#1e293b" text-anchor="middle">blocked threads issue</text>
  <text x="660" y="118" font-size="10" fill="#1e293b" text-anchor="middle">nothing during a stall</text>
  <text x="660" y="138" font-size="10" fill="#1e293b" text-anchor="middle">reported p99 looks great</text>
  <text x="660" y="156" font-size="10" font-weight="700" fill="#1e293b" text-anchor="middle">coordinated omission</text>
  <rect x="560" y="182" width="200" height="106" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="660" y="204" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">-rate fixed=N/s</text>
  <text x="660" y="224" font-size="10" fill="#1e293b" text-anchor="middle">keeps offering load</text>
  <text x="660" y="240" font-size="10" fill="#1e293b" text-anchor="middle">during a stall</text>
  <text x="660" y="260" font-size="10" fill="#1e293b" text-anchor="middle">records true queueing</text>
  <text x="660" y="278" font-size="10" font-weight="700" fill="#1e293b" text-anchor="middle">use this for comparisons</text>
  <text x="20" y="312" font-size="12" fill="#1e293b">Report p50, p99, p999 and throughput together. A throughput number without a latency distribution is meaningless.</text>
</svg>
```

## 5. Implementation

A realistic `cassandra-stress` user profile:

```yaml
# stress-ledger.yaml
keyspace: bench
keyspace_definition: |
  CREATE KEYSPACE IF NOT EXISTS bench WITH replication =
    {'class':'NetworkTopologyStrategy','dc1':3};
table: ledger
table_definition: |
  CREATE TABLE IF NOT EXISTS ledger (
    account_id uuid, bucket text, txn_id timeuuid, amount decimal, memo text,
    PRIMARY KEY ((account_id, bucket), txn_id)
  ) WITH CLUSTERING ORDER BY (txn_id DESC)
    AND compaction = {'class':'TimeWindowCompactionStrategy',
                      'compaction_window_unit':'HOURS','compaction_window_size':6}
    AND compression = {'class':'LZ4Compressor','chunk_length_in_kb':16}
    AND speculative_retry = 'MIN(99p,50ms)';
columnspec:
  - name: account_id
    population: uniform(1..50000000)      # 50M accounts: working set exceeds RAM
  - name: bucket
    size: fixed(7)
    population: uniform(1..12)
  - name: txn_id
    cluster: gaussian(20..400)            # p99 partition ~400 rows, not unbounded
  - name: memo
    size: gaussian(40..200)
insert:
  partitions: fixed(1)
  batchtype: UNLOGGED
  select: fixed(1)/1
queries:
  recent:
    cql: SELECT * FROM ledger WHERE account_id = ? AND bucket = ? LIMIT 20
    fields: samerow
```

```bash
# 1. Load a dataset large enough to exceed page cache
cassandra-stress user profile=stress-ledger.yaml ops\(insert=1\) n=200000000 \
  cl=LOCAL_QUORUM -rate threads=300 -node 10.1.0.31,10.1.0.32,10.1.0.33 \
  -mode native cql3 protocolVersion=5 -graph file=load.html

# 2. Reach steady state BEFORE measuring: nodetool compactionstats -> pending tasks: 0
# 3. Ramp to find the knee (fixed rate, not threads)
for R in 20000 40000 60000 80000 100000; do
  cassandra-stress user profile=stress-ledger.yaml \
    ops\(recent=9,insert=1\) duration=10m cl=LOCAL_QUORUM \
    -rate fixed=${R}/s -node 10.1.0.31 -log file=ramp-${R}.log
done
# Results:  Op rate 79,412 op/s | mean 2.4 ms | p99 28.9 ms | p999 121.4 ms | GC 18.2 s
```

Server-side settings worth changing on modern hardware:

```yaml
# cassandra.yaml — NVMe, 32 cores, 128 GB RAM
compaction_throughput: 0MiB/s          # unthrottled; the device is not the limit
concurrent_compactors: 8               # ~ cores/4; each one is CPU + IO heavy
concurrent_reads: 64                   # size from measured service time, not folklore
concurrent_writes: 128                 # writes are cheap; queueing here is pure loss
memtable_flush_writers: 4              # >= number of data directories
memtable_allocation_type: offheap_objects
file_cache_size_in_mb: 8192            # off-heap chunk cache — biggest read win
key_cache_size_in_mb: 512
row_cache_size_in_mb: 0
commitlog_sync: periodic               # 10 s window; batch mode fsyncs per write
native_transport_max_threads: 256
trickle_fsync: true                    # avoid large dirty-page flush stalls
```

Per-table settings often matter more than global ones:

```cql
-- Point-read heavy: small chunks cut read amplification
ALTER TABLE bench.ledger WITH compression =
  {'class':'LZ4Compressor','chunk_length_in_kb':4};

-- Tail-latency insurance: retry on a second replica past the 99th percentile
ALTER TABLE bench.ledger WITH speculative_retry = 'MIN(99p,50ms)';

-- Read-mostly bounded table: LCS gives ~1 SSTable per read at 2-3x write cost
ALTER TABLE bench.accounts WITH compaction =
  {'class':'LeveledCompactionStrategy','sstable_size_in_mb':160}
  AND bloom_filter_fp_chance = 0.01;
```

Live tuning without a restart, plus verification:

```bash
nodetool setcompactionthroughput 0        # takes effect immediately, no restart
nodetool setconcurrentcompactors 8
nodetool tablehistograms bench.ledger
# Percentile  SSTables  Write(us)  Read(us)  Partition Size  Cell Count
# 50%             1.00      28.09    310.00            2299          35
# 99%             3.00      88.15   1955.67           43388         310
#   ^ 3 SSTables/read and a 43 KB p99 partition: healthy

nodetool info | grep -E 'Key Cache|Chunk Cache|Row Cache'
# Key Cache   : entries 218331, size 24.1 MiB, capacity 512 MiB, hit rate 0.964
# Chunk Cache : entries 512000, size 8 GiB,    capacity 8 GiB,   hit rate 0.887
```

Driver-side tuning is half the battle:

```python
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.policies import TokenAwarePolicy, DCAwareRoundRobinPolicy
from cassandra import ConsistencyLevel
profile = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(          # send to a replica, not a random node
        DCAwareRoundRobinPolicy(local_dc="dc1", used_hosts_per_remote_dc=0)),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM,
    request_timeout=5.0,
)
cluster = Cluster(["10.1.0.31"], execution_profiles={EXEC_PROFILE_DEFAULT: profile},
                  protocol_version=5, compression=True)
session = cluster.connect("bench")
session.default_fetch_size = 500      # default 5000 rows can be tens of MB per page
stmt = session.prepare("SELECT * FROM ledger WHERE account_id=? AND bucket=? LIMIT 20")
stmt.is_idempotent = True             # lets the driver retry safely and speculate
```

**Optimization note:** token-aware routing is the cheapest large win available. Without it, every request goes to an arbitrary coordinator that must forward to a replica, adding a network hop and doubling internode message volume. With it, the coordinator *is* a replica for the vast majority of requests. Combine it with prepared statements (so the driver knows the partition key's position and can compute the token) — an unprepared `SimpleStatement` cannot be routed token-aware at all, which is why "we enabled token awareness and nothing changed" almost always means someone is still building query strings.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Unthrottled compaction (`0`) | Drains backlog fast; keeps SSTables-per-read low on NVMe | Can saturate slower or network-attached storage and spike read latency |
| More `concurrent_compactors` | Parallel compaction keeps up with high ingest | CPU and heap pressure; evicts page cache; can worsen p99 |
| Larger chunk cache | Big read win, off-heap so no GC cost | Native memory outside `-Xmx`; OOM killer risk if over-provisioned |
| Smaller `chunk_length_in_kb` | Less read amplification for point reads | Worse compression ratio, more metadata, more CPU per range scan |
| Speculative retry | Cuts p99/p999 by routing around a slow replica | Extra load on the cluster — dangerous under overall saturation |
| LCS | ~1 SSTable per read, excellent read latency | 2–3× write amplification; unsuitable for write-heavy or huge tables |
| `cassandra-stress` | Exercises real server and driver code paths; user profiles model real schemas | Easy to misuse (coordinated omission, cache-resident datasets, tiny clusters) |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Benchmarking with `threads=N` and reporting p99.** Coordinated omission hides the tail entirely. → ✅ Compare using `-rate fixed=N/s` below saturation; use a ramp separately to find the knee.
2. ⚠️ **Benchmarking a dataset that fits in RAM.** You measured the page cache. → ✅ Load enough data that the working set exceeds RAM, and reach compaction steady state before measuring.
3. ⚠️ **Leaving `compaction_throughput` at 64 MiB/s on NVMe.** Compaction falls behind, SSTables-per-read climbs, reads degrade. → ✅ Measure device utilisation; if it is under 30%, raise the throttle or set it to 0 and watch p99.
4. ⚠️ **Tuning the JVM before fixing the data model.** → ✅ Order is data model → compaction → concurrency → caches → JVM. A 200 MB partition cannot be tuned away.
5. ⚠️ **Enabling row cache to "make reads faster".** Any write to the partition invalidates the whole entry and it is on-heap. → ✅ `row_cache_size_in_mb: 0`; invest in chunk cache and page cache instead.
6. ⚠️ **Using `SimpleStatement` with string interpolation.** No prepared metadata means no token-aware routing and a re-parse per query. → ✅ Always prepare, always bind, always mark idempotent statements as such.
7. ⚠️ **Leaving `fetch_size` at the default 5000.** A page of 5000 wide rows can be tens of megabytes, causing a GC spike and a timeout. → ✅ Set it to a few hundred for wide rows and page explicitly.
8. ⚠️ **Changing several settings at once.** You learn nothing and cannot roll back precisely. → ✅ One variable per run, identical workload, and keep a results table.
9. ⚠️ **Benchmarking a single node or a one-node RF=1 keyspace.** No coordination, no replication, no read repair — the numbers do not transfer. → ✅ Minimum three nodes, RF 3, `LOCAL_QUORUM`, and the same instance and disk type as production.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Establish which of the four bottlenecks you have. If `nodetool tpstats` shows ReadStage pending, you are CPU- or disk-bound on reads — check `nodetool tablehistograms` SSTables-per-read and cache hit rates. If `MemtableFlushWriter` shows "All time blocked" greater than zero, flush cannot keep up and writes are being backpressured — raise `memtable_flush_writers` and check the data device. If `nodetool compactionstats` pending is growing, compaction is losing — raise throughput and compactors, and check `iostat -x 1` to see whether the device is actually saturated (`%util` near 100 with high `await`) or idle (in which case the throttle is the limit). If everything on the server looks clean but client latency is bad, the problem is the driver: check token awareness, prepared statements, `fetch_size`, connection-pool saturation and whether requests are crossing datacenters. `nodetool proxyhistograms` versus `nodetool tablehistograms` is the fastest way to separate coordination cost from storage cost.

**Monitoring.** For tuning work specifically: `Table.SSTablesPerReadHistogram` p99 (target ≤ 4), `Table.{Read,Write}Latency` p99 per table, `Compaction.PendingTasks` and `BytesCompacted` rate, `ThreadPools.*.PendingTasks` and `CurrentlyBlockedTasks`, `Cache.{KeyCache,ChunkCache}.HitRate`, `CommitLog.WaitingOnCommit`, `Storage.Load` growth rate, and OS-level `%util`, `await`, and page-cache hit ratio. Keep a "before/after" dashboard snapshot for every tuning change — the single most useful artefact when someone asks six months later why `concurrent_compactors` is 8.

**Security.** Benchmarking has real security implications people forget. Never point `cassandra-stress` at production: it creates keyspaces, writes data, and can trivially saturate a cluster. Give benchmark clusters their own credentials and network segment. If your stress profile embeds realistic data, treat the profile and the generated dataset as sensitive — synthetic data derived from production distributions is fine, but copying production rows into a benchmark cluster with weaker controls is a breach waiting to happen. Also note that raising `native_transport_max_threads` and connection limits increases your exposure to a client-side connection storm; pair throughput tuning with `native_transport_max_concurrent_connections` limits.

**Performance & scaling.** Tuning has a ceiling; capacity does not. The honest signals that you should scale out rather than tune are: CPU steady above 70% at peak across all nodes, device `%util` above 80% with compaction already unthrottled, per-node data density above roughly 1–2 TB (which makes repair, bootstrap and compaction painfully slow regardless of settings), or a working set that no longer fits in page cache on any affordable machine. When you do scale, prefer more moderate nodes over fewer huge ones: bootstrap time, repair time and GC pause all scale with per-node density. Finally, re-benchmark after scaling — the bottleneck moves, and a setting that was optimal at 12 nodes (say, aggressive compaction concurrency) may be wrong at 40.

## 9. Interview Questions

**Q: What is coordinated omission and how do you avoid it in a Cassandra benchmark?**
A: It is the measurement error where a closed-loop load generator stops issuing requests while blocked on a slow response, so the requests that *would* have arrived during a stall are never recorded and the tail latency disappears from the results. Avoid it by running `cassandra-stress` with `-rate fixed=N/s` instead of `threads=N`, at a rate below saturation, so the generator keeps offering load and records the real queueing delay.

**Q: Your reads are slow and `SSTablesPerRead` p99 is 15. What is happening and what do you do?**
A: Compaction is not keeping up, so each read must merge fragments from many SSTables — checking a bloom filter, an index and a chunk for each. Check `nodetool compactionstats` for a growing backlog, then check whether the disk is actually saturated with `iostat`. If it is idle, the `compaction_throughput` throttle is the limit — raise it or set it to 0 and raise `concurrent_compactors`. If the disk is saturated, you need either a better compaction strategy for the access pattern or more nodes.

**Q: Why is `compaction_throughput: 64MiB/s` often wrong on NVMe?**
A: STCS rewrites each byte roughly `log₂(tiers)` times, about 5×, so a node ingesting 20 MB/s of logical writes needs about 100 MB/s of compaction bandwidth just to break even. NVMe devices deliver gigabytes per second, so the throttle — not the hardware — becomes the bottleneck and pending compactions grow without bound. Setting it to 0 lets compaction use what the device can give.

**Q: Rank Cassandra's caches by value and explain why.**
A: OS page cache first — free, huge, and it caches SSTable blocks so reads avoid the device entirely. Then the chunk cache, which holds *decompressed* chunks off-heap, saving both I/O and decompression CPU. Then key cache, small and on-heap, which saves an index lookup per read; aim for a hit rate above 90%. Row cache last and usually zero: it is on-heap, and any write to a partition invalidates the entire cached partition, so it only pays off for small, hot, effectively immutable tables.

**Q: What does token-aware routing buy you, and why might enabling it change nothing?**
A: It lets the driver send each request directly to a replica for that partition, eliminating a coordinator-to-replica hop and roughly halving internode traffic. It changes nothing if the application uses `SimpleStatement` with interpolated values, because the driver cannot know where the partition key is in the string and therefore cannot compute the token. Prepared statements carry that metadata, so preparing is a prerequisite.

**Q: When is `speculative_retry` a good idea and when is it dangerous?**
A: It is good when a small number of replicas are occasionally slow — a GC pause, a compaction, a noisy neighbour — because sending a redundant request past the 99th percentile latency lets the fast replica answer and cuts p99 and p999 substantially. It is dangerous when the whole cluster is near saturation, because every speculative request adds load, and `ALWAYS` doubles read traffic outright. `MIN(99p,50ms)` is the safe default.

**Q: (Senior) Design a benchmark that would convince you a proposed change is safe for production.**
A: Mirror production shape — same instance and disk type, RF 3, three racks, at least three nodes — and use a `cassandra-stress` user profile with your real schema, realistic partition-size distribution and the actual query mix by weight. Load enough data that the working set exceeds RAM, then reach compaction steady state. Ramp with fixed-rate runs to find the p99 knee, then run 15-minute comparisons at 60–70% of the knee, changing exactly one variable, discarding warm-up, and recording p50/p99/p999, throughput, and server-side counters (tpstats, compactionstats, gcstats, cache hit rates). Then re-run the winner under degraded conditions: one node down, cold cache after restart, and with an artificial compaction backlog. Finally canary on one production node against untouched peers for a full peak period. A change that only wins at steady state on a healthy cluster is not proven.

**Q: (Senior) A cluster does 80k ops/s at p99 = 8 ms. The team wants 160k ops/s. Tune or scale?**
A: First find the current bottleneck rather than assuming. If CPU is at 30%, disks at 20%, GC under 2%, and pending queues are empty, there is headroom and the limit is likely client-side or coordination — check token awareness, connection pools, `fetch_size`, and whether requests cross DCs. If any server resource is above roughly 60–70% at 80k, doubling will not come from tuning; the honest answer is to scale out, because per-node density also affects repair, bootstrap and GC. In practice the sequence is: measure the ramp to find the actual knee (it may already be 140k), remove the top one or two bottlenecks, re-measure, and scale for whatever remains. Also validate that 160k at p99 8 ms is achievable at all with the current data model — if p99 partition size is 40 MB, no amount of tuning or hardware fixes it.

**Q: (Senior) How do you tune for a mixed workload where a nightly batch job competes with OLTP?**
A: Separation beats tuning. The right architecture is a dedicated analytics datacenter replicating the same keyspace, so the batch job's coordinators, page cache and compaction budget are physically distinct from OLTP. If that is not possible, reduce the batch job's blast radius: run it at `LOCAL_ONE` with a small `fetch_size` and explicit rate limiting on the client, schedule it outside peak, and use `nodetool setcompactionthroughput` on a schedule so compaction is aggressive at night and throttled during the day. Per-table settings help too — the batch-scanned table can use different compression chunk size and speculative retry from the OLTP tables. Finally, monitor the OLTP p99 during the batch window as an explicit SLO, because that is the number that will regress first.

**Q: What server-side signal tells you flush, not compaction, is the write bottleneck?**
A: `nodetool tpstats` showing nonzero "All time blocked" on `MemtableFlushWriter`, together with `CurrentlyBlockedTasks`. That means the memtable pool was exhausted and writer threads blocked the callers — backpressure reached the client. The fixes are raising `memtable_flush_writers` (at least one per data directory), giving the commit log its own device, and checking whether the data device is saturated.

**Q: How does `chunk_length_in_kb` affect performance?**
A: It is the compression block size. A point read must fetch and decompress at least one whole chunk, so a 64 KB chunk to return a 200-byte row is 300× read amplification, while a 4 KB chunk is only 20×. Smaller chunks therefore help point-read-heavy workloads at the cost of a worse compression ratio and more compression metadata in memory. Range-scan-heavy tables prefer larger chunks. The 4.x default of 16 KB is a reasonable middle.

**Q: What are the honest signs you should scale out instead of tuning?**
A: Sustained CPU above 70% at peak on all nodes; device `%util` above 80% with compaction already unthrottled; per-node density above roughly 1–2 TB, which makes bootstrap, repair and compaction unmanageable; a working set that no longer fits in page cache; or pending compactions that never drain even at full throughput. At that point additional settings changes trade one bottleneck for another rather than removing it.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Tune in order: data model, compaction throughput, concurrency, caches, JVM. The default `compaction_throughput` of 64 MiB/s is often the real bottleneck on SSD/NVMe because STCS needs roughly 5× your write rate in compaction bandwidth; if pending compactions grow and the device is idle, unthrottle. Size `concurrent_reads`/`concurrent_writes` from measured service time, not folklore, and watch `tpstats` pending as the signal. Caches ranked: page cache > chunk cache (off-heap, decompressed) > key cache (target > 90% hit) > row cache (usually zero). Per-table levers — `chunk_length_in_kb`, `speculative_retry`, compaction strategy, `bloom_filter_fp_chance` — often beat global ones. Benchmark with a `cassandra-stress` user profile using your real schema and query mix, on a production-shaped cluster, with a working set larger than RAM, at compaction steady state, at a fixed rate to avoid coordinated omission, changing one variable at a time. On the client, always prepare statements (token awareness depends on it), set `local_dc`, cap `fetch_size`, and mark idempotent statements.

| Setting / command | Purpose | Default → typical NVMe value |
|---|---|---|
| `compaction_throughput` | Compaction I/O cap | 64MiB/s → 0 (unthrottled) |
| `concurrent_compactors` | Parallel compaction tasks | min(cores,disks) → cores/4 |
| `concurrent_reads` | ReadStage threads | 32 → 64 |
| `file_cache_size_in_mb` | Off-heap chunk cache | 512 → 4096–8192 |
| `row_cache_size_in_mb` | Row cache | 0 → keep 0 |
| `chunk_length_in_kb` | Compression block size | 16 → 4 for point reads |
| `speculative_retry` | Tail-latency insurance | 99p → `MIN(99p,50ms)` |
| `cassandra-stress -rate fixed=N/s` | Open-loop benchmark | Avoids coordinated omission |

**Flash cards**
- **Compaction bandwidth needed** → About 5× your write rate for STCS (`log₂(tiers)` rewrites per byte).
- **Coordinated omission fix** → `-rate fixed=N/s`, not `threads=N`; measure at 60–70% of the knee.
- **Cache ranking** → page cache > chunk cache > key cache > row cache (which should be 0).
- **Why token awareness needs prepared statements** → The driver needs partition-key metadata to compute the token; a string `SimpleStatement` has none.
- **Healthy SSTables-per-read p99** → ≤ 4. Above 8, compaction is losing and reads degrade super-linearly.

## 11. Hands-On Exercises & Mini Project

- [ ] Write a `cassandra-stress` user profile for a schema you actually use, with a `gaussian` clustering distribution, and load enough rows that the dataset is at least 3× RAM. Confirm `nodetool compactionstats` reaches zero pending before measuring anything.
- [ ] Run the same workload twice — once with `-rate threads=200`, once with `-rate fixed=` at the throughput the first run achieved — and compare reported p99 and p999. Quantify the coordinated-omission error.
- [ ] Set `nodetool setcompactionthroughput 8`, run a write-heavy load for 20 minutes, and chart pending compactions and `tablehistograms` SSTables-per-read. Then set it to 0 and chart the recovery.
- [ ] Run a read workload with `speculative_retry = NEVER`, `99p`, and `ALWAYS` while a background compaction runs on one node; record p99, p999 and total cluster read throughput for each.

**Mini Project — "Tuning Ledger"**

*Goal:* produce a defensible, reproducible tuning report for one real table, of the kind you could take to a capacity review.

*Requirements:*
1. A 3-node cluster (ccm or Docker) matching your production disk type, RF 3, `LOCAL_QUORUM`, with a `cassandra-stress` user profile modelling your real schema and query mix by weight.
2. A ramp script that finds the p99 knee, and a comparison harness that runs 15-minute fixed-rate tests at 65% of the knee, discarding warm-up.
3. At least eight one-variable experiments across: `compaction_throughput`, `concurrent_compactors`, `concurrent_reads`, `file_cache_size_in_mb`, `chunk_length_in_kb`, compaction strategy, `speculative_retry`, and client `fetch_size`.
4. Per run, capture client p50/p99/p999 and throughput plus server-side `tpstats`, `compactionstats`, `tablehistograms`, `gcstats` and cache hit rates into a single results table.
5. A written recommendation with the winning configuration, the metric that decided each choice, and an explicit statement of what you did *not* test.

*Extensions:* re-run the winning configuration with one node down and with a cold cache to check robustness; add a degraded-mode test with an artificial compaction backlog; automate the whole harness in CI so a config change proposal must attach a benchmark diff.

## 12. Related Topics & Free Learning Resources

Read with **34 · JVM & Garbage Collection Tuning** (allocation rate is driven by the concurrency settings here), **36 · Troubleshooting Latency & Hotspots** (the diagnostic counterpart to this chapter), **31 · Monitoring, Metrics & Observability** (the metrics every experiment must capture), and the compaction-strategy and data-modelling chapters, which dominate everything below them.

- **cassandra-stress documentation** — Apache Cassandra · *Intermediate* · full syntax for user profiles, `columnspec` distributions, `-rate` modes and graphing. <https://cassandra.apache.org/doc/latest/cassandra/managing/tools/cassandra_stress.html>
- **Cassandra configuration reference (cassandra.yaml)** — Apache Cassandra · *Intermediate* · every setting with its default and effect; the source of truth for tuning decisions. <https://cassandra.apache.org/doc/latest/cassandra/managing/configuration/cass_yaml_file.html>
- **Compaction strategies** — Apache Cassandra · *Advanced* · how STCS, LCS and TWCS differ in write amplification and SSTables-per-read, which drives most tuning. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/compaction/index.html>
- **How NOT to Measure Latency** — Gil Tene · *Advanced* · the definitive talk on coordinated omission; watch before you trust any benchmark number, including your own. <https://www.youtube.com/watch?v=lJ8ydIuPFeU>
- **NoSQLBench** — nosqlbench.io · *Advanced* · a more flexible benchmarking harness with multi-phase scenarios and better statistics than `cassandra-stress`. <https://docs.nosqlbench.io/>
- **Discord: How we scaled to trillions of messages** — Discord Engineering · *Intermediate* · a concrete account of hitting compaction and hot-partition limits at scale and what actually fixed them. <https://discord.com/blog/how-discord-stores-trillions-of-messages>

---

*Apache Cassandra Handbook — chapter 35.*
