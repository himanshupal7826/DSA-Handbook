# 34 · JVM & Garbage Collection Tuning

> **In one line:** Most Cassandra latency incidents are GC pauses wearing a disguise — size the heap small enough that collection stays cheap, push everything you can off-heap, and pick the collector that matches your pause target.

---

## 1. Overview

Cassandra is a Java application whose performance profile is dominated by allocation. Every read materialises rows, every write allocates a mutation and a memtable entry, every compaction streams objects through the young generation, and every internode message allocates buffers. That means the JVM's garbage collector is not a background detail — it is the component that decides your p99. A node with perfect disks, an ideal data model, and zero compaction backlog will still show a 400 ms p99 if it pauses for 400 ms every few seconds.

The problem GC tuning solves is **pause predictability**. A stop-the-world collection freezes every application thread, including the gossip and failure-detection threads. If a pause exceeds `phi_convict_threshold`'s effective window, other nodes mark this node DOWN and route around it — then it wakes up, gossips back UP, and clients reconnect. That flap is worse than the pause. Cassandra even instruments this: `GCInspector` logs any pause over 200 ms, and `FailureDetector` logs "Not marking nodes down due to local pause of Nms" when the *local* JVM was the one that stopped, which is the single most diagnostic log line in the whole system.

Historically, Cassandra shipped with CMS (Concurrent Mark Sweep) and a carefully hand-tuned young generation, because CMS's concurrent old-gen collection avoided long full GCs — at the price of fragmentation and the dreaded concurrent-mode failure that degenerates into a multi-second serial full GC. Cassandra 3.x made G1GC a well-supported alternative, and Cassandra 4.0 shipped `jvm11-server.options` with **G1 as the default** for heaps of 8 GB and up. CMS was removed from the JDK entirely in Java 14. Cassandra 4.1+ on JDK 11/17 also supports ZGC and Shenandoah, which trade throughput for sub-millisecond pauses and are increasingly the right answer for very large heaps.

A concrete example: a 24-node cluster on 64 GB machines was configured with a 31 GB heap "because we have the RAM". Read p99 was 180 ms with a floor around 3 ms. `GCInspector` showed G1 Young pauses of 120–400 ms every 8 seconds — the young gen was enormous, so each collection had to scan and evacuate a huge live set. Dropping the heap to 16 GB with `-XX:MaxGCPauseMillis=300`, moving memtables off-heap, and letting the freed 15 GB become page cache took p99 to 9 ms. Nothing about the data model, disks, or workload changed. **More heap made it slower.**

The mental model: **Cassandra wants a small, fast heap and a large page cache.** The heap holds short-lived request objects and a modest amount of long-lived structure; the OS page cache holds SSTable data, which is where your read throughput actually comes from. Every gigabyte you give the heap is a gigabyte the kernel cannot use to avoid a disk read, plus a gigabyte the collector must scan.

## 2. Core Concepts

- **Stop-the-world (STW) pause** — an interval where all application threads are halted for GC. Only the duration and frequency matter; total GC CPU is secondary.
- **Young / old generation** — new objects are allocated in young (eden), survive a few collections in survivor spaces, then get promoted to old. Cassandra's request objects should die young.
- **Premature promotion** — objects promoted to old gen before dying, because young gen is too small or survivor spaces overflow. It fills old gen and forces expensive mixed/full collections.
- **G1GC** — region-based collector, default in Cassandra 4.0+; targets a pause goal (`MaxGCPauseMillis`) by choosing how many regions to collect. Predictable, low tuning burden.
- **CMS** — legacy concurrent collector, removed in JDK 14; can beat G1 on small heaps (≤ 8 GB) when hand-tuned, at the cost of fragmentation and concurrent-mode failures.
- **ZGC / Shenandoah** — concurrent compacting collectors with sub-millisecond pauses independent of heap size; cost is ~10–15% throughput and higher memory overhead.
- **Off-heap memory** — memtables (`memtable_allocation_type: offheap_objects`), bloom filters, compression metadata, key/chunk caches, and Netty buffers live outside the heap and are not collected.
- **Chunk cache (`file_cache_size_in_mb`)** — off-heap buffer pool for decompressed SSTable chunks; 4.0's biggest lever for read performance after the OS page cache.
- **`GCInspector`** — Cassandra's own GC listener; logs pauses over 200 ms and feeds the `JVM GC` metrics.
- **`phi_convict_threshold`** — the accrual failure detector's sensitivity (default 8); a long GC pause makes peers convict a healthy node, so pause control is also availability control.

## 3. Theory & Internals

Start from allocation. A Cassandra read at `LOCAL_QUORUM` allocates: the `ReadCommand`, per-SSTable iterators, decompressed chunk buffers (off-heap if the chunk cache serves them), row and cell objects for every row merged, the digest, and the response serialisation buffers. Almost all of it is garbage within milliseconds. That is the ideal shape for a generational collector: a high allocation rate with a tiny live set. The failure mode is when the live set grows — large partitions, big result pages, high concurrency, or an oversized memtable — so objects survive long enough to be promoted.

**Heap sizing math.** The default `cassandra-env.sh` heuristic is `MAX_HEAP_SIZE = min(1/2 of RAM, 1/4 of RAM if RAM > 4 GB)` capped around 8 GB, and `HEAP_NEWSIZE = min(100 MB × cores, 1/4 of heap)` for CMS. In practice the production guidance is:

| Collector | Recommended heap | Young gen | Notes |
|---|---|---|---|
| CMS (legacy, JDK 8) | 8 GB | 40–50% of heap (e.g. 4 GB) | Beyond 8 GB, full GCs are multi-second |
| G1GC (default 4.0+) | 16–31 GB | Let G1 size it — do **not** set `-Xmn` | Must stay under the ~32 GB compressed-oops boundary |
| ZGC / Shenandoah | 32 GB+ | N/A (region-based, concurrent) | Pause independent of heap; ~10% throughput cost |

The 32 GB boundary is real and often misunderstood. Below roughly 32 GB, HotSpot uses **compressed ordinary object pointers** — 32-bit references scaled by 8 — so every object header and reference is half the size. Cross that boundary and pointers become 64-bit, so your *effective* capacity can drop: a 33 GB heap may hold less live data than a 31 GB heap while costing more to scan. Always keep `-Xmx` at 31 GB or below unless you have measured a genuine need and are using ZGC.

**Why setting `-Xmn` with G1 is a bug.** G1 dynamically resizes the young generation to hit `MaxGCPauseMillis`. Pinning `-Xmn` (or `G1NewSizePercent`/`G1MaxNewSizePercent` too tightly) removes that adaptivity, and G1 will overshoot the pause goal because it can no longer collect a smaller young gen. Cassandra's `jvm11-server.options` therefore comments out `-Xmn` and sets `-XX:MaxGCPauseMillis=300` (some deployments tune to 200) with `-XX:InitiatingHeapOccupancyPercent=70`.

**The pause budget.** If your read SLO is a 20 ms p99 and GC pauses are 300 ms occurring every 10 seconds, then 3% of requests hit a pause and your p99 is bounded below by the pause. Rough rule: **your GC pause target must be below your latency SLO, and GC time must be under ~5% of wall clock.** Compute the latter from `java.lang:type=GarbageCollector` `CollectionTime` deltas: `rate(CollectionTime)/1000` is seconds of GC per second.

**Failure detection interaction.** The accrual failure detector computes φ from the distribution of gossip inter-arrival times. A 5 s pause makes peers' φ exceed `phi_convict_threshold` (8) and the node is marked DOWN — coordinators stop sending it requests, hints start accumulating, and when it returns everything reconnects at once. Cassandra mitigates this with `FailureDetector.isAlive` checks against the local pause: after a long local GC, a node refuses to convict its peers (the "Not marking nodes down due to local pause" message), because it knows *it* was the one that stopped.

```svg
<svg viewBox="0 0 780 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="350" fill="#ffffff"/>
  <defs><marker id="a34" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 z" fill="#1e293b"/></marker></defs>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">64 GB node: where the memory should actually go</text>
  <text x="20" y="52" font-size="12" font-weight="700" fill="#1e293b">Wrong: 31 GB heap, starved page cache</text>
  <rect x="20" y="62" width="440" height="44" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="240" y="89" font-size="12" fill="#1e293b" text-anchor="middle">JVM heap 31 GB (long young-gen scans, 120-400 ms pauses)</text>
  <rect x="464" y="62" width="120" height="44" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="524" y="89" font-size="11" fill="#1e293b" text-anchor="middle">off-heap 8 GB</text>
  <rect x="588" y="62" width="172" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="674" y="89" font-size="11" fill="#1e293b" text-anchor="middle">page cache 20 GB</text>
  <text x="20" y="132" font-size="12" font-weight="700" fill="#1e293b">Right: 16 GB heap, large page cache, read p99 9 ms</text>
  <rect x="20" y="142" width="230" height="44" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="135" y="169" font-size="12" fill="#1e293b" text-anchor="middle">JVM heap 16 GB</text>
  <rect x="254" y="142" width="150" height="44" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="329" y="163" font-size="11" fill="#1e293b" text-anchor="middle">off-heap 10 GB</text>
  <text x="329" y="179" font-size="10" fill="#1e293b" text-anchor="middle">memtables, bloom, chunk cache</text>
  <rect x="408" y="142" width="352" height="44" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="584" y="163" font-size="12" fill="#1e293b" text-anchor="middle">OS page cache 36 GB</text>
  <text x="584" y="179" font-size="10" fill="#1e293b" text-anchor="middle">SSTable data served without a disk seek</text>
  <text x="20" y="216" font-size="13" font-weight="700" fill="#1e293b">Object lifecycle inside the heap</text>
  <rect x="20" y="230" width="180" height="70" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="110" y="252" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Eden</text>
  <text x="110" y="271" font-size="10" fill="#1e293b" text-anchor="middle">read/write request objects</text>
  <text x="110" y="288" font-size="10" fill="#1e293b" text-anchor="middle">should die here</text>
  <rect x="230" y="230" width="180" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="320" y="252" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Survivor</text>
  <text x="320" y="271" font-size="10" fill="#1e293b" text-anchor="middle">in-flight requests, buffers</text>
  <text x="320" y="288" font-size="10" fill="#1e293b" text-anchor="middle">overflow = premature promotion</text>
  <rect x="440" y="230" width="180" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="530" y="252" font-size="12" font-weight="700" fill="#1e293b" text-anchor="middle">Old generation</text>
  <text x="530" y="271" font-size="10" fill="#1e293b" text-anchor="middle">on-heap memtables, caches</text>
  <text x="530" y="288" font-size="10" fill="#1e293b" text-anchor="middle">mixed GC, expensive</text>
  <rect x="650" y="230" width="110" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="705" y="256" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Off-heap</text>
  <text x="705" y="275" font-size="10" fill="#1e293b" text-anchor="middle">never collected</text>
  <path d="M202 265 L226 265" stroke="#1e293b" stroke-width="2" marker-end="url(#a34)"/>
  <path d="M412 265 L436 265" stroke="#1e293b" stroke-width="2" marker-end="url(#a34)"/>
  <path d="M622 265 L646 265" stroke="#1e293b" stroke-width="2" marker-end="url(#a34)"/>
  <text x="20" y="330" font-size="12" fill="#1e293b">Goal: maximise the fraction of allocation that dies in Eden. Wide partitions and huge page sizes break this.</text>
  <text x="20" y="346" font-size="12" fill="#1e293b">Keep -Xmx at or below 31 GB so compressed oops stay enabled; above that, references double in size.</text>
</svg>
```

## 4. Architecture & Workflow

How a tuning cycle actually runs:

1. **Establish the baseline.** Enable GC logging and collect 24 hours covering peak. Record: pause count, p99 pause duration, GC time as a fraction of wall clock, and old-gen occupancy after each mixed collection.
2. **Correlate with client latency.** Overlay `ClientRequest.Read.Latency` p99 against GC pause timestamps. If the spikes line up, GC is your problem; if they do not, stop tuning the JVM and go look at compaction or the data model.
3. **Fix allocation before fixing the collector.** Move memtables off-heap (`memtable_allocation_type: offheap_objects`), cap the driver's `fetch_size`, eliminate multi-megabyte partitions, and turn off row cache. Reducing allocation rate beats every collector flag.
4. **Size the heap.** Set `-Xms` = `-Xmx` (never let the heap resize; it causes full GCs) at 16–31 GB for G1, 8 GB for CMS. Leave at least half of RAM to the page cache.
5. **Choose and configure the collector.** G1 with `-XX:MaxGCPauseMillis` at or below your SLO, `-XX:InitiatingHeapOccupancyPercent=70`, and `-XX:G1RSetUpdatingPauseTimePercent=5`. Do not set `-Xmn`.
6. **Roll out to one canary node** and compare its latency percentiles and GC profile against untouched peers under identical traffic for at least an hour of peak.
7. **Verify no regression in throughput.** Concurrent collectors buy pause reduction with CPU; check that compaction throughput and write throughput held.
8. **Roll cluster-wide** as a rolling restart, then keep GC logging enabled permanently — it is cheap (a few MB/day with rotation) and it is the evidence you will need at 3 a.m.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="340" fill="#ffffff"/>
  <defs><marker id="b34" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0 0 L9 4 L0 8 z" fill="#1e293b"/></marker></defs>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">A GC pause becomes an availability event</text>
  <rect x="20" y="46" width="150" height="58" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="95" y="68" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Allocation spike</text>
  <text x="95" y="86" font-size="10" fill="#1e293b" text-anchor="middle">wide partition read</text>
  <rect x="200" y="46" width="150" height="58" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="275" y="68" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Survivor overflow</text>
  <text x="275" y="86" font-size="10" fill="#1e293b" text-anchor="middle">premature promotion</text>
  <rect x="380" y="46" width="160" height="58" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="460" y="68" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Old gen fills, mixed GC</text>
  <text x="460" y="86" font-size="10" fill="#1e293b" text-anchor="middle">STW 1200 ms</text>
  <rect x="570" y="46" width="190" height="58" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="665" y="68" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">All threads frozen</text>
  <text x="665" y="86" font-size="10" fill="#1e293b" text-anchor="middle">gossip stops too</text>
  <path d="M172 75 L196 75" stroke="#1e293b" stroke-width="2" marker-end="url(#b34)"/>
  <path d="M352 75 L376 75" stroke="#1e293b" stroke-width="2" marker-end="url(#b34)"/>
  <path d="M542 75 L566 75" stroke="#1e293b" stroke-width="2" marker-end="url(#b34)"/>
  <rect x="120" y="132" width="180" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="210" y="154" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Peers compute phi &gt; 8</text>
  <text x="210" y="174" font-size="10" fill="#1e293b" text-anchor="middle">node marked DOWN</text>
  <rect x="330" y="132" width="180" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="420" y="154" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Requests reroute</text>
  <text x="420" y="174" font-size="10" fill="#1e293b" text-anchor="middle">hints accumulate</text>
  <rect x="540" y="132" width="200" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="640" y="154" font-size="11" font-weight="700" fill="#1e293b" text-anchor="middle">Node wakes, gossips UP</text>
  <text x="640" y="174" font-size="10" fill="#1e293b" text-anchor="middle">reconnect storm, flap</text>
  <path d="M665 106 L400 128" stroke="#1e293b" stroke-width="2" marker-end="url(#b34)"/>
  <path d="M302 162 L326 162" stroke="#1e293b" stroke-width="2" marker-end="url(#b34)"/>
  <path d="M512 162 L536 162" stroke="#1e293b" stroke-width="2" marker-end="url(#b34)"/>
  <text x="20" y="222" font-size="13" font-weight="700" fill="#1e293b">The three log lines that prove it</text>
  <rect x="20" y="236" width="740" height="30" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="34" y="256" font-size="11" fill="#1e293b">GCInspector.java:284 - G1 Old Generation GC in 1243ms. G1 Eden Space: 5771362304 -&gt; 0; G1 Old Gen: 8123400192 -&gt; 7981239296</text>
  <rect x="20" y="272" width="740" height="30" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="34" y="292" font-size="11" fill="#1e293b">FailureDetector.java:278 - Not marking nodes down due to local pause of 1298000000ns &gt; 5000000000ns</text>
  <rect x="20" y="308" width="740" height="28" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="34" y="327" font-size="11" fill="#1e293b">Fix order: cut allocation first, then heap size, then collector flags. Never the reverse.</text>
</svg>
```

## 5. Implementation

Cassandra 4.x keeps JVM settings in `conf/jvm-server.options` (common) plus `jvm11-server.options` / `jvm17-server.options` (version-specific). A production G1 configuration:

```bash
# conf/jvm-server.options — heap sizing (Xms == Xmx, always)
-Xms16G
-Xmx16G
# Do NOT set -Xmn with G1: it defeats adaptive young sizing.
-XX:+AlwaysPreTouch          # touch all heap pages at start: avoids first-hour page faults
-XX:+UseTLAB
-XX:+ResizeTLAB
-XX:-UseBiasedLocking        # biased locking hurts Cassandra's contended paths
-XX:+PerfDisableSharedMem    # avoids a stat() on /tmp stalling safepoints
-XX:StringTableSize=1000003
-Djava.net.preferIPv4Stack=true
```

```bash
# conf/jvm11-server.options — G1 (Cassandra 4.0+ default)
-XX:+UseG1GC
-XX:MaxGCPauseMillis=300               # tune to 200 if your SLO demands it
-XX:InitiatingHeapOccupancyPercent=70  # start concurrent marking early enough
-XX:G1RSetUpdatingPauseTimePercent=5
-XX:ParallelGCThreads=16               # ~= physical cores, cap around 16
-XX:ConcGCThreads=4                    # ~1/4 of ParallelGCThreads
# Unified GC logging (JDK 9+): rotating, cheap, keep it on permanently
-Xlog:gc*,gc+age=trace,safepoint:file=/var/log/cassandra/gc.log:time,uptime,level,tags:filecount=10,filesize=50M
```

```bash
# conf/jvm17-server.options — ZGC alternative for very large heaps / strict SLOs
-XX:+UseZGC
-XX:+ZGenerational          # JDK 21+: generational ZGC, big throughput win
-Xms40G
-Xmx40G
-XX:ConcGCThreads=8
# Expect ~10% lower throughput than G1 but pauses under 1 ms regardless of heap size.
```

Push memory off the heap in `cassandra.yaml` — this is usually worth more than any collector flag:

```yaml
memtable_allocation_type: offheap_objects   # heap holds only references
memtable_heap_space_in_mb: 2048             # bound on-heap memtable portion
memtable_offheap_space_in_mb: 8192
file_cache_size_in_mb: 4096                 # off-heap chunk cache for decompressed data
buffer_pool_use_heap_if_exhausted: false    # fail rather than silently move to heap
row_cache_size_in_mb: 0                     # off unless the table is small, hot, immutable
key_cache_size_in_mb: 512                   # on-heap but small and high value
concurrent_reads: 32
concurrent_writes: 32
concurrent_compactors: 4                    # each compactor allocates heavily
```

Measuring, at runtime:

```bash
# 1. GC time as a fraction of wall clock — the number that matters
jcmd $(pgrep -f CassandraDaemon) GC.heap_info
# garbage-first heap total 16777216K, used 6112493K [0x00000005c0000000, ...)
#  region size 8192K, 231 young (1892352K), 12 survivors (98304K)

# 2. Cassandra's own view
nodetool gcstats
# Interval(ms) Max GC(ms) Total GC(ms) StdDev GC(ms) GC Reclaimed(MB) Collections
#      301422      248         41930         38.14       1183429120         1874
#   ^ 41.9 s of GC in 301 s of wall clock = 13.9% -- far too high, retune

# 3. Pauses over 200 ms, from Cassandra's own logger
grep GCInspector /var/log/cassandra/system.log | tail -5
# WARN  GCInspector.java:284 - G1 Young Generation GC in 431ms.
#   G1 Eden Space: 6039797760 -> 0; G1 Old Gen: 3221225472 -> 3489660928

# 4. Did GC cause a false DOWN?
grep -c 'Not marking nodes down due to local pause' /var/log/cassandra/system.log
```

```python
# Correlate GC pauses with client latency from the driver side
from cassandra.cluster import Cluster
cluster = Cluster(["10.1.0.31"], metrics_enabled=True, protocol_version=5)
session = cluster.connect("payments")
# JMX heap + GC gauges are also exposed as Prometheus series by jmx_exporter:
#   jvm_gc_collection_seconds_sum{gc="G1 Young Generation"}
#   jvm_memory_bytes_used{area="heap"}
# PromQL: rate(jvm_gc_collection_seconds_sum[5m]) > 0.05  -> more than 5% of wall clock in GC
```

**Optimization note:** `-XX:+AlwaysPreTouch` with `-Xms == -Xmx` is one of the highest-value, least-known flags. Without it, the JVM commits heap pages lazily, so the first hour after a restart is peppered with page faults inside GC pauses and inside request handling — exactly when you are watching the node to decide whether the restart succeeded. Pre-touching adds 10–60 seconds to start-up and removes that entire class of noise. Pair it with transparent huge pages set to `madvise` (not `always`), and disable swap entirely (`vm.swappiness=0` plus no swap device) — a swapped-out heap page inside a GC pause turns a 50 ms pause into a 5 second one.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Small heap (8–16 GB) | Short young-gen scans, predictable pauses, more page cache | Less room for on-heap caches; higher GC frequency (but cheap ones) |
| Large heap (24–31 GB) | Fits bigger working sets, fewer collections | Each pause is longer; page cache starved; must stay under 32 GB for compressed oops |
| G1GC | Adaptive, pause-goal driven, low tuning burden, Cassandra default | Higher CPU overhead than tuned CMS on small heaps; humongous allocations can surprise |
| CMS (legacy) | Excellent on ≤ 8 GB heaps when hand-tuned | Fragmentation and concurrent-mode failure produce multi-second full GCs; removed in JDK 14 |
| ZGC / Shenandoah | Sub-millisecond pauses regardless of heap size | ~10–15% throughput loss, more memory overhead, less field experience in Cassandra |
| Off-heap memtables | Removes the largest long-lived on-heap consumer | Native memory is not bounded by `-Xmx`; an OOM-killer event instead of a heap dump |
| `AlwaysPreTouch` | Eliminates post-restart page-fault noise | Adds tens of seconds to start-up; commits full heap immediately |
| Row cache | Can eliminate reads entirely for hot static rows | Invalidated by any write to the partition; usually a net loss and a GC burden |

## 7. Common Mistakes & Best Practices

1. ⚠️ **"We have 128 GB of RAM so we set a 64 GB heap."** Pauses scale with live-set size and you lose compressed oops above 32 GB. → ✅ 16–31 GB max for G1; give the rest to the page cache. Only ZGC justifies larger.
2. ⚠️ **Setting `-Xmn` with G1GC.** It disables adaptive young sizing and makes G1 miss its pause target. → ✅ Set only `-Xmx`/`-Xms` and `MaxGCPauseMillis`; let G1 size generations.
3. ⚠️ **`-Xms` different from `-Xmx`.** Heap resizing triggers full GCs and hides your real steady state. → ✅ Always equal, plus `-XX:+AlwaysPreTouch`.
4. ⚠️ **Tuning the collector before reducing allocation.** → ✅ Fix wide partitions, cap driver `fetch_size` (default 5000 rows can be tens of MB), disable row cache, and move memtables off-heap first.
5. ⚠️ **Leaving swap enabled.** A swapped heap page inside a pause multiplies it by 100. → ✅ No swap device, `vm.swappiness=0`, and `disk_access_mode` left at the default mmap behaviour.
6. ⚠️ **Reading only average GC time.** Averages hide the 2-second outlier that convicted the node. → ✅ Track max pause and the count of pauses over 200 ms; alert on `GCInspector` WARN frequency.
7. ⚠️ **Enabling row cache "to speed up reads".** Every write to a cached partition invalidates the whole entry, and the cache is a long-lived on-heap structure that ages into old gen. → ✅ `row_cache_size_in_mb: 0` unless the table is small, hot and effectively immutable.
8. ⚠️ **Ignoring the "local pause" log line.** It literally says your JVM stopped for seconds. → ✅ Alert on it; it is the highest-signal GC message Cassandra produces.
9. ⚠️ **Raising `phi_convict_threshold` to stop flapping.** That treats the symptom and slows real failure detection. → ✅ Fix the pauses; raise φ only for genuinely noisy networks (e.g. 10–12 across a WAN).
10. ⚠️ **Copying JVM flags from a blog without measuring.** Workloads differ enormously. → ✅ Canary one node, compare against untouched peers under identical live traffic for at least a peak hour, and change one variable at a time.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Work from three sources in order. First `nodetool gcstats`, which gives max pause, total GC time and collections over an interval — divide total by interval to get the GC fraction. Second the `GCInspector` WARN lines in `system.log`, which show the before/after size of each generation; a young collection that leaves old gen substantially larger than before is premature promotion, and repeated mixed collections that fail to shrink old gen mean the live set genuinely does not fit. Third the unified GC log, which is where you find safepoint time (`-Xlog:safepoint`) — occasionally the "GC pause" is actually a time-to-safepoint problem caused by a long-running counted loop or, classically, `PerfDisableSharedMem` not being set so a `stat()` on a busy `/tmp` stalls every safepoint. If you need to see what is *in* the heap, `jcmd <pid> GC.class_histogram` is cheap; a full `jmap -dump` will stop the node for the duration and should be a last resort on a drained node.

**Monitoring.** The JMX beans: `java.lang:type=GarbageCollector,name=G1 Young Generation` and `…,name=G1 Old Generation` exposing `CollectionCount` and `CollectionTime`; `java.lang:type=Memory` `HeapMemoryUsage`/`NonHeapMemoryUsage`; `java.lang:type=MemoryPool,name=G1 Old Gen` for occupancy after collection (the honest measure of live-set growth); `org.apache.cassandra.metrics:type=Storage,name=Load` for context. Alert rules that earn their keep: `rate(jvm_gc_collection_seconds_sum[5m]) > 0.05` (5% of wall clock in GC), max pause over 1 s in a 5-minute window, old-gen occupancy after mixed GC trending up over hours (a real leak or a growing live set), and any occurrence of the local-pause log line. Also monitor **native** memory: off-heap memtables and the chunk cache are outside `-Xmx`, so RSS can exceed heap by tens of gigabytes and the OOM killer, not the JVM, is what will end the process.

**Security.** JVM tuning intersects security in two places. Heap dumps contain live customer data — `-XX:+HeapDumpOnOutOfMemoryError` is valuable but the dump path must be on an encrypted volume with restricted permissions, and dumps must be treated as production data under your retention policy. Second, JMX and any diagnostic port (JFR, remote debugging) are code-execution surfaces: keep `LOCAL_JMX=yes`, never enable `-agentlib:jdwp` in production, and if you run Java Flight Recorder, start it via `jcmd` locally rather than opening a remote management port.

**Performance & scaling.** GC tuning has a ceiling: once pauses are under your SLO and GC time is under 5%, further flag tuning returns nothing and you should be scaling out or fixing the data model. Scaling out helps directly because it lowers per-node allocation rate and live-set size. Machine shape matters: prefer more moderate nodes (16–32 cores, 64–128 GB, NVMe) over a few huge ones, because a 1 TB-RAM node forces either an oversized heap or a large amount of idle memory. If you must run very large heaps — for example a node holding many thousands of tables, where schema and metadata structures alone are tens of gigabytes — that is the genuine ZGC use case. Finally, remember `concurrent_compactors` is an allocation multiplier: each compactor streams objects through the young gen, so raising it to chase compaction backlog can push you into pause trouble; raise `compaction_throughput` first.

## 9. Interview Questions

**Q: Why does a bigger heap often make Cassandra slower?**
A: Pause duration scales with the live set the collector must scan and evacuate, so a larger young generation means longer stop-the-world pauses. A bigger heap also takes memory away from the OS page cache, which is what actually serves SSTable reads without a disk seek. And above roughly 32 GB the JVM loses compressed oops, so every reference doubles in size and effective capacity can drop.

**Q: What is the 32 GB heap boundary?**
A: Below about 32 GB, HotSpot uses compressed ordinary object pointers — 32-bit references scaled by 8 — halving the size of references and object headers. Cross it and pointers become 64-bit, increasing memory consumption and GC scan cost. Keep `-Xmx` at 31 GB or below unless you are on ZGC and have measured a real need.

**Q: Why should you not set `-Xmn` when using G1GC?**
A: G1 resizes the young generation dynamically to meet `MaxGCPauseMillis`. Fixing the young size removes that adaptivity, so when a pause would exceed the goal G1 has no smaller collection set to fall back to and simply overshoots. With G1 you set the heap size and the pause goal, nothing else about generations.

**Q: What does the log line "Not marking nodes down due to local pause of 1298000000ns" mean?**
A: The local JVM was stopped for 1.3 seconds, so from its point of view every peer went silent. Cassandra recognises this and refuses to convict peers based on observations made across its own pause. It is the clearest possible evidence that GC, not the network or the peers, is the problem.

**Q: Which memory should be off-heap and why?**
A: Memtables (`memtable_allocation_type: offheap_objects`), the chunk cache (`file_cache_size_in_mb`), bloom filters, compression offsets, and Netty buffers. All of these are long-lived and large — exactly the objects that would otherwise fill the old generation and force expensive mixed collections. Moving them off-heap lets the heap hold almost nothing but short-lived request objects.

**Q: How do you decide between G1 and ZGC?**
A: G1 is the default and the right answer for heaps up to about 31 GB with pause goals of 100–300 ms; it costs less throughput and has vastly more field experience in Cassandra. ZGC (generational, on JDK 21+) is the answer when you need sub-millisecond pauses or genuinely need a heap far beyond 32 GB, and you can afford roughly 10–15% throughput. Measure on a canary — the throughput cost shows up as reduced compaction and write capacity, not as latency.

**Q: (Senior) Read p99 is 200 ms. Prove whether GC is the cause, and fix it.**
A: Overlay `ClientRequest.Read.Latency` p99 with `GCInspector` pause timestamps and `nodetool gcstats`; if the spikes coincide and GC time exceeds ~5% of wall clock, GC is the cause. Then find *why* the live set is large rather than reaching for flags: check `nodetool tablehistograms` for p99 partition size and cell count (a 100 MB partition materialised on-heap is an instant promotion event), check the driver's `fetch_size`, check whether row cache is on, and check `memtable_allocation_type`. Fix allocation first, then set `-Xms=-Xmx` at 16 GB with `AlwaysPreTouch` and `MaxGCPauseMillis=200`, canary one node, and compare. If pauses are already small and latency is not, the answer is elsewhere — compaction backlog, disk saturation or cross-DC routing.

**Q: (Senior) Explain how GC pauses turn into a cluster-wide availability event.**
A: A pause freezes all threads, including gossip. Peers' accrual failure detector sees no heartbeats, φ crosses `phi_convict_threshold`, and the node is marked DOWN. Coordinators stop routing to it and begin storing hints; if RF is 3 and another node is also down, `LOCAL_QUORUM` starts failing. When the pause ends, the node gossips UP, drivers reconnect en masse, hint delivery starts, and the resulting load can trigger another pause — a flap loop. Speculative retry masks some of this at the cost of extra load on the remaining replicas. The correct fix is the pause; raising φ only delays detection of real failures.

**Q: (Senior) A node's RSS is 48 GB but `-Xmx` is 16 GB and the JVM never OOMs. Explain.**
A: The remainder is native memory that is not governed by `-Xmx`: off-heap memtables (`memtable_offheap_space_in_mb`), the chunk cache (`file_cache_size_in_mb`), bloom filters and compression metadata (roughly 1–2 GB per TB of data), Netty direct buffers, thread stacks (hundreds of threads × 256 KB–1 MB), JVM metaspace and code cache, and mmap'd SSTable pages counted in RSS. This is normal, but it means the OOM killer is your real memory limit, not the JVM. Budget explicitly: heap + off-heap configured limits + ~2 GB JVM overhead should leave meaningful headroom, and you should alert on RSS approaching total RAM rather than on heap usage.

**Q: What is premature promotion and how do you spot it?**
A: Objects that should have died in eden get copied into the old generation because survivor space is too small or the object lives across too many collections. You spot it in `GCInspector` output as young collections that leave old-gen occupancy noticeably higher than before, and in the GC log's `gc+age` output as a tenuring distribution where objects reach max age. In Cassandra it is usually caused by large result pages, wide partitions, or high concurrency holding many in-flight requests alive.

**Q: Should you disable swap on a Cassandra node?**
A: Yes, entirely. Cassandra relies on the OS page cache for SSTable reads and on predictable memory access for GC; if a heap page is swapped out, touching it during a pause turns milliseconds into seconds. Remove the swap device or set `vm.swappiness=0`, and ensure `memlock` limits allow the JVM to lock memory if you use `-XX:+AlwaysPreTouch` with huge pages.

**Q: Which JVM flags do you consider non-negotiable in production?**
A: `-Xms` equal to `-Xmx`; `-XX:+AlwaysPreTouch`; `-XX:+HeapDumpOnOutOfMemoryError` with a secured dump path; `-XX:+PerfDisableSharedMem` to avoid `/tmp` stalling safepoints; unified GC logging with rotation kept on permanently; `-XX:+UseG1GC` with an explicit `MaxGCPauseMillis`; and `-XX:-UseBiasedLocking` on JDK 11 (it is deprecated and disabled by default in newer JDKs anyway). Everything else should be justified by a measurement on your workload.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Cassandra's p99 is usually a GC pause. Keep the heap small (16–31 GB with G1, 8 GB with legacy CMS) and never cross 32 GB or you lose compressed oops; set `-Xms` equal to `-Xmx` and add `-XX:+AlwaysPreTouch`. With G1, set only the heap and `MaxGCPauseMillis` — setting `-Xmn` breaks adaptive young sizing. Push the big, long-lived allocations off-heap: `memtable_allocation_type: offheap_objects`, a generous `file_cache_size_in_mb`, and `row_cache_size_in_mb: 0`. Give everything else to the OS page cache; it, not the heap, is what serves your reads. Diagnose with `nodetool gcstats` (GC time / wall clock should be under 5%), `GCInspector` WARN lines, and above all the "Not marking nodes down due to local pause" message, which proves a multi-second freeze. Pauses cause peers to convict the node via the φ accrual detector, so pause control is availability control. Fix allocation before flags, canary before rolling, and remember RSS legitimately exceeds `-Xmx` because off-heap memory is not bounded by it.

| Setting | Purpose | Recommended |
|---|---|---|
| `-Xms` / `-Xmx` | Heap size, fixed | Equal; 16–31 GB (G1), 8 GB (CMS) |
| `-XX:+UseG1GC` | Collector | Default in Cassandra 4.0+ |
| `-XX:MaxGCPauseMillis` | G1 pause goal | 200–300 ms, below your SLO |
| `-XX:InitiatingHeapOccupancyPercent` | Start concurrent marking | 70 |
| `-XX:+AlwaysPreTouch` | Commit heap pages at start | Always on |
| `memtable_allocation_type` | Where memtables live | `offheap_objects` |
| `file_cache_size_in_mb` | Off-heap chunk cache | 2048–8192 |
| `row_cache_size_in_mb` | Row cache | 0 unless small/hot/immutable |
| `nodetool gcstats` | GC time and max pause | GC < 5% of wall clock |
| `phi_convict_threshold` | Failure detector sensitivity | 8 (10–12 only across a WAN) |

**Flash cards**
- **Why 31 GB and not 33 GB?** → Compressed oops turn off above ~32 GB, doubling reference size and GC scan cost.
- **The one flag you must never set with G1** → `-Xmn`; it disables adaptive young sizing and breaks the pause goal.
- **Highest-signal GC log line** → "Not marking nodes down due to local pause of Nns" — your JVM froze for N nanoseconds.
- **Fix order for GC latency** → Reduce allocation (partitions, fetch_size, row cache, off-heap memtables) → heap size → collector flags.
- **Why RSS ≫ `-Xmx`** → Off-heap memtables, chunk cache, bloom filters, Netty buffers, metaspace and mmap'd pages are outside the heap.

## 11. Hands-On Exercises & Mini Project

- [ ] Start a single node with `-Xms2G -Xmx2G` and run `cassandra-stress write n=5000000` — capture `nodetool gcstats` and count `GCInspector` WARN lines. Repeat with `-Xms8G -Xmx8G` and compare max pause, GC fraction, and stress-reported p99.
- [ ] Enable `-Xlog:gc*,gc+age=trace:file=gc.log` and identify the tenuring distribution; then create a table with 50 MB partitions, read them, and show objects reaching max tenuring age (premature promotion) in the log.
- [ ] Flip `memtable_allocation_type` between `heap_buffers` and `offheap_objects` under identical write load and compare old-gen occupancy after mixed collections.
- [ ] Set `MaxGCPauseMillis` to 50 and then 500 on the same workload; record the trade-off between pause length and GC CPU (total `CollectionTime` per minute).
- [ ] Simulate a long pause with `jcmd <pid> GC.run` in a tight loop (or `kill -STOP` for 10 s) and observe peers marking the node DOWN in their logs plus hints accumulating.

**Mini Project — "GC Regression Harness"**

*Goal:* build a repeatable harness that scores a JVM configuration against a fixed Cassandra workload so tuning becomes evidence-based rather than folklore.

*Requirements:*
1. A Docker Compose or ccm 3-node cluster where each node's JVM options come from a mounted, parameterised file.
2. A fixed workload driven by `cassandra-stress` with a realistic mix: 70% reads from a table with a p99 partition size around 1 MB, 30% writes, plus a background compaction load.
3. A collector that, per run, records: client p50/p99/p999 from stress, `nodetool gcstats` deltas, count of pauses over 200 ms, GC time as a fraction of wall clock, old-gen occupancy after mixed GC, and node RSS.
4. A matrix of at least six configurations: G1 at 8/16/31 GB, `MaxGCPauseMillis` 100/300, heap vs off-heap memtables, and one ZGC run if you have JDK 17+.
5. A results table and a written recommendation naming the winning configuration and the specific metric that decided it.

*Extensions:* add a "wide partition" workload variant to show how data model beats JVM tuning; graph pause duration against live-set size to derive your own scaling curve; add an automated regression gate that fails CI if a config change increases p99 pause by more than 20%.

## 12. Related Topics & Free Learning Resources

Read with **31 · Monitoring, Metrics & Observability** (the GC metrics and alerts), **36 · Troubleshooting Latency & Hotspots** (GC is the first hypothesis to eliminate), **35 · Performance Tuning & Benchmarking** (allocation rate is driven by compaction and concurrency settings), and the memtable/compaction chapters for what actually occupies the heap.

- **Cassandra JVM and heap tuning** — Apache Cassandra · *Intermediate* · official guidance on heap sizing, `jvm-server.options` layout and collector selection. <https://cassandra.apache.org/doc/latest/cassandra/managing/configuration/cass_jvm_options_file.html>
- **conf/jvm11-server.options in the source tree** — Apache Cassandra · *Advanced* · the actual shipped defaults with inline comments explaining every flag; the best single reference. <https://github.com/apache/cassandra/blob/trunk/conf/jvm11-server.options>
- **Garbage-First Garbage Collector Tuning** — Oracle · *Advanced* · authoritative G1 internals: regions, humongous allocations, IHOP and pause prediction. <https://docs.oracle.com/en/java/javase/17/gctuning/garbage-first-garbage-collector-tuning.html>
- **Z Garbage Collector** — OpenJDK · *Advanced* · ZGC design, generational mode, and when its throughput cost is worth paying. <https://wiki.openjdk.org/display/zgc/Main>
- **Cassandra and GC tuning in the field** — The Last Pickle · *Advanced* · practitioner walkthroughs of real GC incidents and the metrics that identified them. <https://thelastpickle.com/blog/2018/04/11/gc-tuning.html>
- **CASSANDRA-7486: Compare CMS and G1 pause times** — Apache JIRA · *Advanced* · the long-running ticket with real benchmark data that led to G1 becoming the default. <https://issues.apache.org/jira/browse/CASSANDRA-7486>
- **Netflix: Java GC and the tail latency problem** — Netflix TechBlog · *Advanced* · large-scale evidence that pause control, not throughput, drives user-visible latency. <https://netflixtechblog.com/java-in-flames-e763b3d32166>

---

*Apache Cassandra Handbook — chapter 34.*
