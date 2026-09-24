# 21 · Database Scaling: The Progression, Not the Jump

> **In one line:** Scaling a database is a ladder you climb one rung at a time — optimize, cache, add replicas, buy a bigger box, partition, shard, go multi-region — and each rung solves one specific bottleneck while creating new problems, so you climb only when the numbers force you to and never skip straight to sharding.

---

## 1. Overview

A product team notices the database at 85% CPU during the evening peak. Someone says "we need to shard." It sounds like the senior answer. It is usually the wrong one. Sharding splits your data across independent databases, which means every cross-entity query, every foreign key, every unique constraint, every multi-row transaction and every schema migration becomes a distributed-systems problem — forever. In most real incidents that start with "the database is at 85% CPU", the actual cause is three queries missing an index, an ORM issuing 40 queries per page, or a reporting job running on the primary. Fixing those costs a day. Sharding costs a quarter of engineering time up front and a permanent tax afterwards.

The naive approach fails because it treats "scale" as one problem. It is not. A database runs out of **distinct resources** — CPU for query execution, RAM for the working set, IOPS and throughput on disk, write capacity on the single primary, connection slots, storage capacity, and, for global users, the speed of light. Each rung of the scaling ladder relieves a *specific* resource. A read replica does nothing for a write bottleneck. Sharding does nothing for a badly written query (it just runs the bad query on N machines). A bigger instance does nothing for users in Sydney waiting 200 ms for a round trip to Virginia. If you do not know which resource is exhausted, you will climb the wrong rung, pay the cost, and still be slow.

So this chapter teaches scaling as an **ordered progression**:

1. **Single database** — the correct starting point for almost everything.
2. **Query optimization** — indexes, rewrites, fewer queries per request.
3. **Caching** — take repeated reads off the database entirely.
4. **Read replicas** — spread the remaining reads across copies.
5. **Vertical scaling** — a bigger primary for CPU, RAM and write headroom.
6. **Partitioning** — split big tables inside one database so maintenance and hot data stay manageable.
7. **Sharding** — split the data across databases when one primary cannot absorb the writes or hold the data.
8. **Multi-region** — put data near users or survive a region loss.

The order is not arbitrary. Rungs are sorted by the ratio of *benefit to permanent complexity*. The early rungs are cheap, reversible and local; the late rungs are expensive, mostly irreversible and distributed. You climb only when the rung below is exhausted for the resource that is actually saturated.

> **Builds on:** [SQL Handbook · Query Optimization & EXPLAIN](../sql/topic.html?p=21-query-optimization) (how to read and fix a plan — not re-taught here) · [SQL Handbook · Partitioning](../sql/topic.html?p=23-partitioning) (declarative partitioning syntax) · [Ch 09 · Replication](topic.html?p=09-replication) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 12 · Sharding](topic.html?p=12-sharding). The System Design Handbook's [Replication & Sharding](../system-design/topic.html?p=16-database-scaling) and [Vertical vs Horizontal Scaling](../system-design/topic.html?p=13-scaling-approaches) give the interview-level overview; this chapter is the operator's view — the signals, costs and consistency consequences of each rung, and how to decide.

> **Why this matters:** In interviews, "just shard it" is a red flag, and "here is the bottleneck, here is the cheapest rung that relieves it, here is what it breaks" is the senior answer. In production, skipping rungs is how teams end up operating 16 shards for a workload a single well-indexed instance could serve.

## 2. Core Concepts

- **Bottleneck resource** — the one resource (CPU, RAM/working set, IOPS, write throughput, connections, storage, network latency) that saturates first. *Why it matters:* every rung relieves a specific resource; diagnosing it first is what makes the choice correct ([Ch 23 · Bottleneck Diagnosis](topic.html?p=23-bottleneck-diagnosis)).
- **Scaling rung** — one step on the ladder with its own entry signals, benefit and cost. *Why it matters:* you should be able to name the signal that justified each rung you have climbed.
- **Headroom** — the gap between current peak utilization and the level where latency degrades (often around 60–70% sustained CPU for OLTP). *Why it matters:* you climb a rung *before* headroom is gone, because every rung takes weeks to land safely.
- **Read scaling vs write scaling** — reads can be multiplied by copies (caches, replicas); writes to a single-primary database cannot, because every copy must apply every write. *Why it matters:* this asymmetry is why write-heavy systems reach sharding sooner.
- **Working set** — the pages touched by the hot queries in a time window. *Why it matters:* once it exceeds RAM, latency jumps from memory speed to disk speed; more RAM (vertical) or less data per node (partition/shard) is the fix.
- **Replication lag** — the delay before a primary's write is visible on a replica. *Why it matters:* the moment you read from replicas, your consistency model silently changes from "read your writes" to "eventually".
- **Partitioning** — splitting one table into child tables *inside one database* (range, list, hash). *Why it matters:* improves pruning, index size and data lifecycle, but does not add CPU, RAM or write capacity.
- **Sharding** — splitting data across *separate database servers* by a shard key. *Why it matters:* the only rung that multiplies write capacity and storage for a relational database — and the one that breaks joins, transactions and constraints across shards.
- **Shard key / distribution column** — the column deciding which shard owns a row. *Why it matters:* it decides which queries stay single-shard; changing it later means moving all the data.
- **Multi-region** — running database nodes in more than one geographic region. *Why it matters:* the only fix for speed-of-light latency and region-level disasters, and the most expensive rung in both money and consistency.
- **One-way door** — a decision that is expensive to reverse. *Why it matters:* optimization, caching and replicas are two-way doors; sharding and multi-region writes are one-way doors and deserve proportionally more evidence.

## 3. Theory & Principles

### Why a single database is the right starting point

A single PostgreSQL instance on modern hardware is far more capable than most people assume. A 16–32 vCPU instance with NVMe or well-provisioned network storage and a working set that fits in RAM can typically serve **tens of thousands of simple indexed point queries per second** and **thousands to low tens of thousands of small write transactions per second**, with single-digit millisecond latency. Treat those as orders of magnitude, not promises — the real number depends on row width, index count, query shape and durability settings — but they mean that a product with a few million users and a sane schema frequently never needs to leave one primary plus a standby.

A single database gives you things that are extraordinarily expensive to rebuild later: **ACID transactions across any rows**, **foreign keys and unique constraints enforced by the engine**, **ad-hoc joins**, **one backup**, **one schema migration**, and **one consistent snapshot** of everything. Each rung you climb gives some of that away.

### The two asymmetries that shape the ladder

**Asymmetry 1: reads multiply, writes do not.** A cache or a replica can serve a read without touching the primary, so read capacity grows roughly linearly with copies. A write, by contrast, must be applied on the primary *and replayed on every replica*. Adding replicas adds read capacity but also adds replay work and WAL shipping; it never adds write capacity. With a single-primary architecture, write throughput is bounded by what one machine can do: WAL generation and fsync, index maintenance, lock contention, and vacuum. The only ways to raise that ceiling are to make each write cheaper (optimization, fewer indexes, batching), buy a bigger primary (vertical), or split the writes across several primaries (sharding).

**Asymmetry 2: complexity is paid forever, capacity is paid once.** A bigger instance costs more money every month, but the operational model is unchanged. A shard map, a routing layer, cross-shard reporting, rebalancing tooling and per-shard migrations cost engineering attention *every week for the life of the system*. That is why the ladder is sorted by permanent complexity, not by capacity gained.

### Which rung relieves which resource

| Saturated resource | Rungs that help | Rungs that do NOT help |
|---|---|---|
| CPU from inefficient queries | Optimization (first!), caching | Sharding (just multiplies the inefficiency) |
| CPU from legitimate read volume | Caching, read replicas, vertical | Partitioning |
| Write throughput (WAL, fsync, index maintenance) | Optimization (fewer indexes, batching), vertical, sharding | Replicas, caching |
| RAM / working set | Vertical (more RAM), partitioning (hot partitions), sharding | Replicas (each has the same working set) |
| Storage capacity | Partitioning + archiving, vertical (bigger volume), sharding | Caching, replicas |
| Connections | Pooling ([Ch 20](topic.html?p=20-database-application-architecture)), replicas | Vertical (process-per-connection still costs RAM) |
| Latency for distant users | Multi-region (replicas or writes), edge caching | Everything else |
| Maintenance on huge tables (vacuum, index builds) | Partitioning | Replicas, caching |

### The progression diagram

```svg
<svg viewBox="0 0 900 620" width="100%" height="620" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c21a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="450" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The database scaling ladder: climb only when the rung below is exhausted</text>
  <text x="450" y="40" text-anchor="middle" fill="#334155" font-size="10">Bottom = cheap, reversible, local. Top = expensive, one-way door, distributed.</text>

  <rect x="20" y="540" width="560" height="54" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="34" y="560" fill="#1e293b" font-size="12" font-weight="bold">1. Single database (+ standby for HA)</text>
  <text x="34" y="578" fill="#334155" font-size="10">Solves: everything, simply. Full ACID, joins, constraints, one backup.</text>
  <text x="34" y="590" fill="#334155" font-size="9">Signal to move up: sustained CPU &gt; ~60-70% at peak, p99 rising</text>

  <rect x="50" y="476" width="560" height="54" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="64" y="496" fill="#1e293b" font-size="12" font-weight="bold">2. Query optimization</text>
  <text x="64" y="514" fill="#334155" font-size="10">Solves: wasted CPU/IO. Indexes, sargable rewrites, kill N+1, fewer queries/request.</text>
  <text x="64" y="526" fill="#334155" font-size="9">Creates: extra indexes slow writes. Cost: engineer-days. Consistency: unchanged.</text>

  <rect x="80" y="412" width="560" height="54" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="94" y="432" fill="#1e293b" font-size="12" font-weight="bold">3. Caching (Redis / app cache)</text>
  <text x="94" y="450" fill="#334155" font-size="10">Solves: repeated hot reads. Can remove 80-99% of reads for skewed access.</text>
  <text x="94" y="462" fill="#334155" font-size="9">Creates: stale data, invalidation bugs, stampedes. Consistency: eventual per TTL.</text>

  <rect x="110" y="348" width="560" height="54" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="124" y="368" fill="#1e293b" font-size="12" font-weight="bold">4. Read replicas</text>
  <text x="124" y="386" fill="#334155" font-size="10">Solves: read volume the cache cannot absorb; isolates analytics/reporting.</text>
  <text x="124" y="398" fill="#334155" font-size="9">Creates: replication lag, read-your-writes bugs, routing logic. No write relief.</text>

  <rect x="140" y="284" width="560" height="54" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="154" y="304" fill="#1e293b" font-size="12" font-weight="bold">5. Vertical scaling (bigger primary)</text>
  <text x="154" y="322" fill="#334155" font-size="10">Solves: write headroom, CPU, working set &gt; RAM. Zero code change.</text>
  <text x="154" y="334" fill="#334155" font-size="9">Creates: cost grows faster than capacity; a hard ceiling; a failover to resize.</text>

  <rect x="170" y="220" width="560" height="54" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="184" y="240" fill="#1e293b" font-size="12" font-weight="bold">6. Partitioning (inside one database)</text>
  <text x="184" y="258" fill="#334155" font-size="10">Solves: huge tables, slow vacuum/index builds, retention via DROP PARTITION.</text>
  <text x="184" y="270" fill="#334155" font-size="9">Creates: key must be in PK/unique; queries without the key scan all partitions.</text>

  <rect x="200" y="156" width="560" height="54" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="214" y="176" fill="#1e293b" font-size="12" font-weight="bold">7. Sharding (across databases)</text>
  <text x="214" y="194" fill="#334155" font-size="10">Solves: write throughput and storage beyond one primary. The only write multiplier.</text>
  <text x="214" y="206" fill="#334155" font-size="9">Creates: cross-shard joins/txns, hot shards, rebalancing, N-way ops. One-way door.</text>

  <rect x="230" y="92" width="560" height="54" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="244" y="112" fill="#1e293b" font-size="12" font-weight="bold">8. Multi-region</text>
  <text x="244" y="130" fill="#334155" font-size="10">Solves: speed-of-light latency for distant users; surviving a region loss.</text>
  <text x="244" y="142" fill="#334155" font-size="9">Creates: 60-200 ms cross-region commits or conflict resolution; highest cost.</text>

  <path d="M800,590 L800,100" stroke="#334155" stroke-width="2" marker-end="url(#c21a1)"/>
  <text x="815" y="350" fill="#334155" font-size="10" transform="rotate(-90 815 350)">permanent complexity and cost</text>
  <path d="M600,567 L640,500" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#c21a1)"/>
  <path d="M630,503 L670,436" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#c21a1)"/>
  <path d="M660,439 L700,372" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#c21a1)"/>
  <path d="M690,375 L730,308" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#c21a1)"/>
  <path d="M720,311 L750,244" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#c21a1)"/>
  <path d="M750,247 L775,180" stroke="#94a3b8" stroke-width="1.5" marker-end="url(#c21a1)"/>
  <text x="20" y="80" fill="#dc2626" font-size="11" font-weight="bold">Anti-pattern: jumping 1 -&gt; 7.</text>
  <text x="20" y="96" fill="#334155" font-size="10">You inherit every cost of rung 7</text>
  <text x="20" y="110" fill="#334155" font-size="10">while the real bottleneck (often a</text>
  <text x="20" y="124" fill="#334155" font-size="10">missing index) is still there, xN.</text>
</svg>
```

### What "exhausted" means for each rung

A rung is exhausted when the remaining load on the saturated resource cannot be reduced further by that technique at acceptable cost. Concretely:

- **Optimization is exhausted** when `pg_stat_statements` shows the top queries by total time are all index-served, return small row counts, have sane `shared_blks_read`, and the application issues close to the minimum number of queries per request. There is no single "N ms" rule, but if the top 10 statements by `total_exec_time` each average well under a millisecond and still sum to most of your CPU, you are paying for legitimate volume, not waste.
- **Caching is exhausted** when the cache hit rate plateaus because the remaining reads are either long-tail (each key read rarely), must be strongly consistent (balances, inventory at checkout), or are complex queries whose result sets are too varied to cache.
- **Replicas are exhausted** when the primary is saturated by *writes* (replicas do not help), when replica lag under load becomes unacceptable, or when every replica is itself saturated and the working set does not fit replica RAM either.
- **Vertical is exhausted** when you are on the largest instance class that makes economic sense, or when the next size up costs disproportionately more than the capacity it adds, or when a single-node failure domain is itself unacceptable at that size (restoring a 20 TB database takes a long time).
- **Partitioning is exhausted** when tables are already partitioned sensibly and the *total* write rate or storage, not per-table maintenance, is the problem.

## 4. Architecture & Workflow

This section walks every rung with the same six questions: **when is it appropriate (signals and numbers)**, **what problem it solves**, **what new problem it creates**, **operational complexity**, **cost**, and **consistency implications**.

### Rung 1 — Single database

**When appropriate:** at the start, and for far longer than people expect. A single primary with one synchronous or asynchronous standby for HA ([Ch 18 · High Availability](topic.html?p=18-high-availability)) is the default until you have evidence otherwise. Typical healthy signals: peak CPU under ~50–60%, working set fits in RAM (buffer cache hit ratio in the high 90s for OLTP), p99 latency stable as traffic grows.

**Solves:** everything, with the strongest guarantees available. **Creates:** a single failure domain (mitigated by the standby) and a single capacity ceiling. **Ops complexity:** lowest. **Cost:** one instance plus standby plus backups. **Consistency:** linearizable reads and writes on the primary; every query sees the latest commit.

### Rung 2 — Query optimization

**When appropriate:** always, first, and continuously. Signals: CPU climbing faster than traffic; a handful of statements dominating `pg_stat_statements` by `total_exec_time`; high `shared_blks_read` (disk reads) on hot queries; sequential scans on large tables in hot paths; the application issuing dozens of queries per request (N+1). The mechanics — reading `EXPLAIN (ANALYZE, BUFFERS)`, sargable rewrites, covering indexes, fixing estimates — are taught in [SQL Handbook · Query Optimization](../sql/topic.html?p=21-query-optimization) and [SQL Handbook · Execution Plans](../sql/topic.html?p=22-execution-plans). Here the point is *where it sits on the ladder*: it is almost always the biggest, cheapest win.

**Solves:** wasted work. It is common for the top few statements to account for most of the database's time, and for a single missing index to be the difference between 40% and 90% CPU. **Creates:** each added index costs write amplification (every INSERT and non-HOT UPDATE must maintain it) and storage; a covering index that doubles the size of a hot table can push the working set out of RAM. **Ops complexity:** low — `CREATE INDEX CONCURRENTLY` and a code review. **Cost:** engineer-hours. **Consistency:** unchanged.

### Rung 3 — Caching

**When appropriate:** when reads dominate (read/write ratio of 10:1 and up), access is skewed (a small set of keys takes most of the traffic), and the data tolerates bounded staleness. Classic candidates: product pages, user profiles, configuration, feature flags, rendered fragments, computed aggregates.

**Solves:** repeated reads of the same hot keys never reach the database. With Zipf-like access, a cache holding a few percent of keys can absorb the large majority of reads. **Creates:** a second source of truth. You now own invalidation bugs, stale reads after writes, **cache stampedes** when a hot key expires, cold-start storms after a cache flush, and a dependency whose failure dumps full load on a database that was sized assuming the cache ([Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture), [Caching with Redis · Cache Stampede](../redis-caching/topic.html?p=15-cache-stampede)). **Ops complexity:** medium — another cluster to run, and correctness logic in application code. **Cost:** RAM-priced but small compared to DB instances. **Consistency:** eventual, bounded by TTL and invalidation latency; read-your-writes breaks unless you invalidate or write-through on the write path.

> **Production story:** A team cached product listings with a 10-minute TTL and scaled the database *down* to save money. A Redis failover emptied the cache; the database, now sized for 10% of reads, received 100% and fell over. Rule: size the database to survive at least a *partial* cache loss, or protect it with request coalescing and load shedding.

### Rung 4 — Read replicas

**When appropriate:** reads still saturate the primary after caching; or you need to isolate heavy read workloads (reporting, exports, search indexing) from OLTP. Signals: primary CPU dominated by SELECTs, and reads that can tolerate lag of at least hundreds of milliseconds.

**Solves:** read throughput scales roughly with replica count; analytics stop competing with checkout. Replicas double as HA standbys. **Creates:** **replication lag** and every anomaly that follows from it — a user updates their profile, the next page reads from a replica and shows the old value; a background job reads a row the primary just inserted and gets nothing ([Ch 09 · Replication](topic.html?p=09-replication), [Ch 10 · Consistency Models](topic.html?p=10-consistency-models)). Long queries on a hot standby can conflict with WAL replay (canceled with "canceling statement due to conflict with recovery"), or, with `hot_standby_feedback = on`, hold back vacuum on the primary and cause bloat. You also need routing: which queries go where. **Ops complexity:** medium. **Cost:** each replica is a full-size instance with full storage — replicas are *not* cheap. **Consistency:** replicas give eventually consistent reads; you must add read-your-writes (route to primary for a short window after a write, or wait until the replica has replayed the write's LSN) where users would notice.

> **MySQL difference:** MySQL replicas apply the row-based binlog, can use multi-threaded appliers (`replica_parallel_workers`), and report lag via `Seconds_Behind_Source` in `SHOW REPLICA STATUS` — a metric that can read 0 while the replica's I/O thread is disconnected. GTIDs let you implement read-your-writes with `WAIT_FOR_EXECUTED_GTID_SET()`, the analogue of waiting for an LSN in PostgreSQL.

### Rung 5 — Vertical scaling

**When appropriate:** the primary is saturated on CPU, RAM or I/O by *legitimate* work, especially write work that replicas cannot absorb. Signals: working set larger than RAM (cache hit ratio falling, read IOPS climbing), CPU high from writes, I/O queue depth rising on the primary.

**Solves:** everything a single node does, more of it, with zero code change. Doubling RAM so the working set fits can cut latency by an order of magnitude; that is often the highest-leverage purchase you can make. **Creates:** cost that grows faster than capacity at the top end, a hard ceiling (the largest instance), and a larger blast radius — a bigger database takes longer to back up, restore, and rebuild a replica for. Resizing a managed instance usually means a failover (seconds to a minute or two of disruption); on self-managed setups you resize the standby, switch over, then resize the old primary. **Ops complexity:** low. **Cost:** money only. **Consistency:** unchanged.

> **Interview tip:** Vertical scaling is not "the lazy option". Moving to a larger instance is often the fastest, safest way to buy 12–24 months of headroom while the team does the harder work properly. Say that out loud; it signals maturity.

### Rung 6 — Partitioning

**When appropriate:** a few tables are very large (hundreds of GB to TB) and either queries naturally filter on a key (time, tenant), maintenance is suffering (autovacuum on a 2 TB table takes hours, index builds take all day), or you need cheap retention (drop last year's partition instead of `DELETE`-ing a billion rows). Syntax is in [SQL Handbook · Partitioning](../sql/topic.html?p=23-partitioning); the design depth is in [Ch 11 · Partitioning](topic.html?p=11-partitioning).

**Solves:** partition pruning keeps hot queries on small, recent partitions whose indexes fit in RAM; vacuum and index work happens per partition; retention becomes `DETACH`/`DROP`. **Creates:** the partition key must be part of every primary key and unique constraint; queries without the key scan every partition; too many partitions increases planning time and lock overhead. **Ops complexity:** medium — partition creation must be automated (pg_partman or a cron job), and a missing future partition means inserts fail (or land in a default partition). **Cost:** none beyond engineering. **Consistency:** unchanged — still one database, one transaction manager. Partitioning does **not** add CPU, RAM or write throughput; it makes one machine use them better.

### Rung 7 — Sharding

**When appropriate:** the *write* rate or *total data size* genuinely exceeds what the largest sensible single primary can handle, after optimization, and after vertical scaling. Signals: WAL generation, fsync and index maintenance saturate the biggest instance; storage heading beyond what you can back up and restore within your RTO; per-tenant isolation requirements. This usually shows up at write rates in the tens of thousands of transactions per second sustained, or datasets in the many-terabyte range — but the signal is *your* measured saturation, not a number from a blog.

**Solves:** writes, storage and working set scale with the number of shards. **Creates:** the most painful set of problems on the ladder ([Ch 12 · Sharding](topic.html?p=12-sharding)): cross-shard queries become scatter-gather, cross-shard transactions need 2PC or sagas ([Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions)), global unique constraints and foreign keys disappear, hot shards appear when the key is skewed, rebalancing requires moving live data, and every migration, backup and upgrade happens N times. **Ops complexity:** high. **Cost:** N primaries plus N standbys plus routing plus people. **Consistency:** strong within a shard, weak or explicitly coordinated across shards. Options that absorb some of the pain: Citus for PostgreSQL, Vitess for MySQL, or a distributed SQL database ([Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture)).

### Rung 8 — Multi-region

**When appropriate:** users on several continents need low write or read latency (a round trip across an ocean is on the order of 70–200 ms, and a request that makes several DB calls multiplies that), or the business requires surviving the loss of a whole region with a small RPO/RTO. See [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases).

**Solves:** local reads (cross-region read replicas), local writes (geo-partitioned data or multi-leader), regional disaster survival. **Creates:** either cross-region commit latency (synchronous consensus across regions) or conflict resolution (asynchronous multi-leader), data-residency rules, and a doubling or tripling of everything. **Ops complexity:** highest. **Cost:** highest, including cross-region data transfer charges. **Consistency:** the sharpest trade-off on the ladder — pick between latency and consistency explicitly (PACELC, [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem)).

### Decision flow: which rung next?

```svg
<svg viewBox="0 0 900 540" width="100%" height="540" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c21b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="450" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Which rung next? Diagnose the saturated resource first</text>

  <rect x="340" y="40" width="220" height="40" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="450" y="58" text-anchor="middle" fill="#1e293b" font-weight="bold">DB is near its limit at peak</text>
  <text x="450" y="72" text-anchor="middle" fill="#334155" font-size="9">p99 rising, CPU/IO high, headroom &lt; 30%</text>

  <rect x="320" y="104" width="260" height="42" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="450" y="122" text-anchor="middle" fill="#1e293b" font-weight="bold">Top queries wasteful? (pg_stat_statements)</text>
  <text x="450" y="138" text-anchor="middle" fill="#334155" font-size="9">seq scans, N+1, bad estimates, huge row counts</text>
  <path d="M450,80 L450,102" stroke="#334155" stroke-width="1.5" marker-end="url(#c21b1)"/>
  <path d="M580,125 L660,125" stroke="#16a34a" stroke-width="1.5" marker-end="url(#c21b1)"/>
  <rect x="662" y="108" width="220" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="772" y="129" text-anchor="middle" fill="#1e293b">yes: OPTIMIZE (rung 2), re-measure</text>

  <rect x="320" y="172" width="260" height="42" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="450" y="190" text-anchor="middle" fill="#1e293b" font-weight="bold">Load mostly reads?</text>
  <text x="450" y="206" text-anchor="middle" fill="#334155" font-size="9">SELECT share of total_exec_time</text>
  <path d="M450,146 L450,170" stroke="#334155" stroke-width="1.5" marker-end="url(#c21b1)"/>
  <text x="458" y="162" fill="#334155" font-size="9">no</text>

  <rect x="40" y="240" width="250" height="42" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="165" y="258" text-anchor="middle" fill="#1e293b" font-weight="bold">Hot, skewed, staleness-tolerant?</text>
  <text x="165" y="274" text-anchor="middle" fill="#334155" font-size="9">yes: CACHE (3). no/remaining: REPLICAS (4)</text>
  <path d="M320,200 L200,238" stroke="#2563eb" stroke-width="1.5" marker-end="url(#c21b1)"/>
  <text x="240" y="212" fill="#2563eb" font-size="9">reads</text>

  <rect x="560" y="240" width="300" height="42" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="710" y="258" text-anchor="middle" fill="#1e293b" font-weight="bold">Writes / working set / single-node limits</text>
  <text x="710" y="274" text-anchor="middle" fill="#334155" font-size="9">replicas and caches cannot help here</text>
  <path d="M580,200 L700,238" stroke="#d97706" stroke-width="1.5" marker-end="url(#c21b1)"/>
  <text x="650" y="212" fill="#d97706" font-size="9">writes</text>

  <rect x="560" y="306" width="300" height="42" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="710" y="324" text-anchor="middle" fill="#1e293b" font-weight="bold">Larger instance available and affordable?</text>
  <text x="710" y="340" text-anchor="middle" fill="#334155" font-size="9">yes: VERTICAL (5), buys 12-24 months</text>
  <path d="M710,282 L710,304" stroke="#334155" stroke-width="1.5" marker-end="url(#c21b1)"/>

  <rect x="560" y="372" width="300" height="42" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="710" y="390" text-anchor="middle" fill="#1e293b" font-weight="bold">Pain is per-table size / maintenance / retention?</text>
  <text x="710" y="406" text-anchor="middle" fill="#334155" font-size="9">yes: PARTITION (6)</text>
  <path d="M710,348 L710,370" stroke="#334155" stroke-width="1.5" marker-end="url(#c21b1)"/>
  <text x="718" y="362" fill="#334155" font-size="9">no / at ceiling</text>

  <rect x="560" y="438" width="300" height="42" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="710" y="456" text-anchor="middle" fill="#1e293b" font-weight="bold">Total write rate / data &gt; one primary</text>
  <text x="710" y="472" text-anchor="middle" fill="#334155" font-size="9">SHARD (7): Citus, Vitess, app-level, or distributed SQL</text>
  <path d="M710,414 L710,436" stroke="#334155" stroke-width="1.5" marker-end="url(#c21b1)"/>
  <text x="718" y="428" fill="#334155" font-size="9">no</text>

  <rect x="40" y="372" width="400" height="108" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="240" y="394" text-anchor="middle" fill="#1e293b" font-weight="bold">Separate axis: latency for distant users / region loss</text>
  <text x="56" y="416" fill="#334155" font-size="10">Reads far away: cross-region read replicas + edge cache</text>
  <text x="56" y="434" fill="#334155" font-size="10">Writes far away: geo-partition by home region, or</text>
  <text x="56" y="450" fill="#334155" font-size="10">distributed SQL with regional leaders (MULTI-REGION, 8)</text>
  <text x="56" y="470" fill="#7c3aed" font-size="10" font-weight="bold">Driven by geography, not by CPU.</text>
  <text x="450" y="515" text-anchor="middle" fill="#dc2626" font-size="11" font-weight="bold">After every rung: re-measure. The bottleneck moves.</text>
</svg>
```

### The decision table

| Rung | Enter when (signals) | Solves | Creates | Ops complexity | Cost | Consistency impact | Reversible? |
|---|---|---|---|---|---|---|---|
| 1. Single DB | Default | Everything, simply | Single ceiling | Low | $ | Linearizable | n/a |
| 2. Optimize | Top statements wasteful, N+1, seq scans | Wasted CPU/IO | Write amplification from indexes | Low | Engineer-days | None | Yes |
| 3. Cache | Read-heavy, skewed, staleness OK | Hot repeated reads | Invalidation, stampedes, cold start | Medium | $ | Eventual (TTL) | Yes |
| 4. Replicas | Reads saturate primary after cache; isolate analytics | Read volume | Lag, read-your-writes, routing, recovery conflicts | Medium | $$ per replica | Eventual on replicas | Yes |
| 5. Vertical | Legit write/CPU/RAM pressure | Headroom, working set | Ceiling, super-linear cost, bigger blast radius | Low | $$-$$$ | None | Yes |
| 6. Partition | Huge tables, time/tenant access, retention | Maintenance, pruning, lifecycle | Key in PK, cross-partition scans | Medium | Engineering | None | Hard-ish |
| 7. Shard | Writes/data exceed biggest primary | Write and storage scale-out | Cross-shard joins/txns, hot shards, rebalancing | High | $$$ + people | Strong per shard only | Very hard |
| 8. Multi-region | Global latency, region DR | Locality, region survival | Cross-region latency or conflicts, residency | Highest | $$$$ | Latency vs consistency choice | Very hard |

## 5. Implementation

### Simple example: proving you are on rung 2, not rung 7

Before any architecture change, find out what the database is actually spending its time on. With `pg_stat_statements` enabled (`shared_preload_libraries = 'pg_stat_statements'`):

```sql
SELECT
  round(total_exec_time::numeric / 1000, 1)                         AS total_s,
  round(100 * total_exec_time / sum(total_exec_time) OVER (), 1)    AS pct,
  calls,
  round(mean_exec_time::numeric, 2)                                 AS mean_ms,
  rows / NULLIF(calls, 0)                                           AS rows_per_call,
  shared_blks_read                                                  AS disk_blocks,
  left(query, 70)                                                   AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

```text
 total_s | pct  |  calls   | mean_ms | rows_per_call | disk_blocks | query
---------+------+----------+---------+---------------+-------------+----------------------------------------
 48211.3 | 41.2 |   912044 |   52.86 |             1 |   381220112 | SELECT * FROM orders WHERE lower(email) = $1
 22310.9 | 19.1 | 41220331 |    0.54 |             1 |       10233 | SELECT * FROM users WHERE id = $1
 11804.0 | 10.1 |    30211 |  390.71 |         18000 |    98221003 | SELECT ... FROM order_items oi JOIN ...
  ...
```

Read it like an operator: one statement is 41% of all database time, averaging 53 ms to return one row, reading hundreds of millions of blocks from disk. That is a non-sargable predicate (`lower(email)`) doing a sequential scan — a textbook case from the SQL Handbook. An expression index fixes it:

```sql
CREATE INDEX CONCURRENTLY orders_lower_email_idx ON orders (lower(email));
```

The second line is 41 million calls of a primary-key lookup — cheap individually, but the call count suggests an N+1 loop or a perfect cache candidate. The third is a report returning 18,000 rows per call — move it to a replica. Three fixes, zero new infrastructure, and CPU typically drops by half. That is rung 2 doing its job.

### Real-world example: an e-commerce database climbing the ladder

A marketplace grows from 50K to 5M monthly users over three years. Here is a realistic path, with the evidence at each step.

**Year 0 — rung 1.** One PostgreSQL primary (8 vCPU, 64 GB RAM), one standby, PgBouncer in transaction mode. 1,500 peak QPS. Nothing to do.

**Year 1 — rung 2, then rung 3.** Peak CPU hits 75%. `pg_stat_statements` shows a missing index and an N+1 on the order history page (1 query for orders + 1 per order for items). Fixing both drops CPU to 40%. Six months later, CPU is back at 70%, but now the top statements are all efficient product and category reads, 92% of the query volume, heavily skewed toward a few thousand popular products. Cache-aside in Redis with a 5-minute TTL plus explicit invalidation on product update removes about 85% of those reads.

**Year 2 — rung 4.** Merchant dashboards and nightly exports start causing p99 spikes on checkout. Add one async replica for reporting and one for general reads, with read-your-writes for the user's own orders:

```go
// Route reads to a replica only when it has replayed the caller's last write.
// lastWriteLSN is stored in the user's session after any write transaction:
//   SELECT pg_current_wal_lsn()  (captured on the primary right after COMMIT)
func (r *Router) ReadDB(ctx context.Context, lastWriteLSN string) *sql.DB {
	if lastWriteLSN == "" {
		return r.replica // no recent write: any replica is fine
	}
	var caughtUp bool
	err := r.replica.QueryRowContext(ctx,
		`SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn`, lastWriteLSN,
	).Scan(&caughtUp)
	if err != nil || !caughtUp {
		return r.primary // replica behind (or unknown): read your write from the primary
	}
	return r.replica
}
```

A simpler, cruder alternative many teams ship first: after a user writes, pin that user's reads to the primary for N seconds (N a bit above observed p99 lag). It is less precise but has no extra round trip.

**Year 2.5 — rung 5.** Writes grow with order volume; the primary's working set (orders, order_items, inventory, and their indexes) reaches ~110 GB and the buffer cache hit ratio drops from 99.6% to 97%, which roughly means several times more disk reads. Move the primary to 32 vCPU / 256 GB. Hit ratio returns to 99.5%, p99 halves. Total engineering cost: a planned switchover.

**Year 3 — rung 6.** The `order_events` table is 3 TB and autovacuum on it runs for most of a day. Queries always filter by `created_at` in the last 30 days, and legal retention is 2 years. Convert to monthly range partitions (via a new partitioned table and a backfill, see [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution)):

```sql
CREATE TABLE order_events (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  order_id    bigint      NOT NULL,
  created_at  timestamptz NOT NULL,
  kind        text        NOT NULL,
  payload     jsonb,
  PRIMARY KEY (id, created_at)          -- partition key must be part of the PK
) PARTITION BY RANGE (created_at);

CREATE TABLE order_events_2026_09 PARTITION OF order_events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');

-- Retention becomes metadata, not a billion-row DELETE:
ALTER TABLE order_events DETACH PARTITION order_events_2024_08 CONCURRENTLY;
DROP TABLE order_events_2024_08;
```

**Not yet — rung 7.** At 5M users, the write rate peaks around 3,000 transactions per second and the primary sits at 45% CPU on the large instance. There is no case for sharding. The team writes down the *trigger* instead: "revisit sharding when sustained peak write TPS exceeds 60% of the measured ceiling of the largest instance, or when the database exceeds the size we can restore within our 1-hour RTO." They also choose the eventual shard key now (`merchant_id`) and make sure new tables carry it, which makes a future move to Citus far less painful:

```sql
-- If/when the trigger fires (Citus): co-locate by merchant so joins stay local.
SELECT create_distributed_table('orders',      'merchant_id');
SELECT create_distributed_table('order_items', 'merchant_id', colocate_with => 'orders');
SELECT create_reference_table('currencies');   -- small table copied to every node
```

> **MySQL difference:** The ladder is identical, but the tools differ: ProxySQL or MySQL Router for read/write splitting, `ALGORITHM=INSTANT`/gh-ost for the schema changes along the way, and Vitess (keyspaces, vindexes, VTGate) as the standard sharding layer. InnoDB tables are clustered on the primary key, so partitioning and sharding keys interact with PK choice even more directly than in PostgreSQL.

## 6. Advantages, Disadvantages & Trade-offs

| Approach | Advantage | Disadvantage | Typical capacity gain | Complexity added |
|---|---|---|---|---|
| Optimize queries | Biggest win per hour spent | Needs skill and measurement; indexes cost writes | 2-10x for wasteful workloads | ~0 |
| Cache | Removes most hot reads | Staleness, invalidation, stampedes | Large for skewed reads, zero for writes | Medium |
| Read replicas | Linear-ish read scale, workload isolation | Lag, routing, full-size cost each | ~Nx reads | Medium |
| Vertical | No code change, fast | Ceiling, super-linear price | 2-4x per step until the top | Low |
| Partitioning | Maintenance, pruning, retention | Key constraints, cross-partition scans | Indirect (better RAM/IO use) | Medium |
| Sharding | Writes and storage scale out | Cross-shard everything | ~Nx writes if key distributes well | High, permanent |
| Multi-region | Locality, region survival | Latency or conflicts, cost | Latency, not throughput | Highest |

### When to use the ladder strictly

- Almost always for OLTP systems backed by a relational database. Climb in order, re-measure after each rung, and write down the trigger for the next rung before you need it.
- When the team is small. Every rung past 5 needs dedicated operational ownership.

### When NOT to climb in order (skip rungs deliberately)

- **You know the write volume on day one.** An IoT ingestion or event-logging system at 200K writes/s is past one primary from the start; choose a horizontally scalable store (Cassandra, a distributed SQL database, or a sharded design) up front.
- **Multi-tenant SaaS with strong tenant isolation needs.** Designing for tenant-per-shard or tenant-per-database early is cheaper than retrofitting ([Ch 40 · Multi-Tenant SaaS](topic.html?p=40-case-multi-tenant-saas)).
- **Regulatory data residency.** EU data must stay in the EU: multi-region is a requirement, not a scaling rung.
- **Analytics.** Don't scale OLTP to serve analytics; move analytics to a warehouse or columnar store fed by CDC.

## 7. Common Mistakes & Best Practices

**1. Sharding before optimizing.** *What people do:* shard because the database is "slow". *Why it hurts:* the slow queries still run, now on every shard, and you pay for cross-shard complexity forever. *Instead:* spend a week on `pg_stat_statements` and the application's queries-per-request before any architecture change.

**2. Adding replicas for a write bottleneck.** *What people do:* add three replicas when the primary is saturated by writes. *Why it hurts:* replicas replay every write; the primary is unchanged and now also ships WAL to three more consumers. *Instead:* measure the read/write split of `total_exec_time` first.

**3. Treating replicas as consistent.** *What people do:* route all SELECTs to replicas globally. *Why it hurts:* users see their own writes disappear; jobs read stale state and make wrong decisions (double-sending emails, missing just-created rows). *Instead:* route by consistency requirement — critical read-after-write paths to the primary or LSN-gated replicas.

**4. Sizing the database assuming the cache is always there.** *Why it hurts:* a cache flush or failover becomes a database outage. *Instead:* keep enough headroom for a partial cache miss storm, add request coalescing, and warm caches before cutover.

**5. Ignoring vertical scaling out of pride.** *Why it hurts:* months of risky engineering to avoid a bill that is smaller than one engineer's salary. *Instead:* price the larger instance against the engineering time of the alternative.

**6. Partitioning expecting more throughput.** *Why it hurts:* partitions share the same CPU, RAM and WAL; a query without the partition key now scans N indexes instead of one. *Instead:* partition for pruning, maintenance and retention, and verify pruning in `EXPLAIN`.

**7. Choosing a shard key from the data model instead of the access pattern.** *Why it hurts:* a key that looks natural (country, created date) produces hot shards and scatter-gather for the dominant query. *Instead:* pick the key that the most frequent, latency-critical queries filter by, with high cardinality and even load ([Ch 12](topic.html?p=12-sharding)).

**8. No written trigger for the next rung.** *Why it hurts:* the next rung is started during an incident. *Instead:* capacity reviews ([Ch 22](topic.html?p=22-capacity-planning), [Ch 25](topic.html?p=25-database-reliability-engineering)) that project when headroom runs out and schedule the work a quarter ahead.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**The replica that became the primary's problem.** At 2 am, the primary's disk usage climbs steadily and autovacuum stops making progress on the busiest table. Root cause: a reporting query on a replica running for 9 hours, with `hot_standby_feedback = on`, holds back the primary's xmin horizon, so dead tuples cannot be removed and the table bloats. Fix: cancel the query, set `max_standby_streaming_delay` / statement timeouts on the reporting replica, or move reporting to a replica without feedback (accepting cancellations) or to a warehouse.

**The cache flush that took down checkout.** A deploy changes the cache key format; every key misses at once. Reads on the primary jump 8x, connections max out, checkout times out. Root cause: database sized for post-cache load, no coalescing. Fix: version keys gradually, warm the new keyspace, add single-flight per key, and keep enough DB headroom for a cold cache.

**Stale reads after a write.** Support tickets: "I changed my address but the order shipped to the old one." Root cause: the order service read the address from a replica 2 seconds behind during a WAL burst from a bulk import. Fix: read-your-writes on critical paths; throttle bulk imports; alert on replay lag.

**The vertical resize that failed over at the wrong time.** A managed-instance resize triggers a failover during peak; the application's connection pool does not recover because DNS was cached. Fix: resize in low traffic, set short DNS TTLs and pool max-lifetime, and rehearse failover ([Ch 25](topic.html?p=25-database-reliability-engineering)).

**The hot shard.** After sharding by `merchant_id`, one merchant runs a flash sale and its shard saturates while 15 others idle. Fix: detect skew (per-shard QPS and CPU), isolate large tenants to dedicated shards, or use a finer-grained key for that table.

### What to monitor to know which rung you are near

| Signal | Source | Suggests |
|---|---|---|
| Top statements' share of `total_exec_time` | pg_stat_statements | Rung 2 still has juice |
| Read vs write share of DB time | pg_stat_statements by statement type | Reads: rungs 3-4. Writes: 5, 7 |
| Buffer cache hit ratio trending down | pg_stat_database | Working set outgrowing RAM: rung 5 or 6 |
| Replica replay lag p99 | pg_stat_replication `replay_lag` | Replicas saturating, or WAL bursts |
| WAL bytes/s | pg_stat_wal `wal_bytes` | Write volume approaching single-primary limits |
| Largest tables' size and vacuum duration | pg_stat_user_tables, pg_stat_progress_vacuum | Rung 6 |
| Peak CPU vs projected growth | Host metrics | Months of headroom left |

See [Ch 24 · Database Monitoring](topic.html?p=24-database-monitoring) for thresholds and dashboards.

### Scaling notes

Always re-measure after climbing a rung — the bottleneck moves. After caching, the remaining load is dominated by writes and long-tail reads; after vertical scaling, the connection count or a single hot lock may become the limit; after sharding, the router, the busiest shard and cross-shard jobs become the constraint. The ladder is not climbed once; it is revisited at every capacity review.

## 9. Interview Questions

**Q: Your database is at 85% CPU at peak. Walk me through what you do before considering sharding?**
A: I first find out what the CPU is being spent on, because sharding only helps if the work is legitimate and write-bound. I look at `pg_stat_statements` ordered by `total_exec_time` to see whether a few statements dominate, and at their mean time, rows per call and disk blocks read. Wasteful statements — sequential scans, non-sargable predicates, N+1 loops — get fixed first, which frequently halves CPU. Then I check the read/write split: if reads dominate, caching and replicas are the next rungs; if writes dominate, a bigger primary buys time. Only if the write rate or data size exceeds what the largest sensible instance can handle do I design sharding, and I'd choose the key from the dominant access pattern.

**Q: Why don't read replicas help with a write bottleneck?**
A: Because every replica must apply every write the primary makes. Physical streaming replicas replay the same WAL, so the primary still generates the full WAL, does all the fsyncs and maintains all indexes. Adding replicas adds read capacity and even adds a little work to the primary (WAL senders). The only ways to raise the write ceiling of a single-primary system are to make writes cheaper, move to a bigger primary, or split writes across multiple primaries.

**Q: What consistency problems do read replicas introduce, and how do you handle them?**
A: Replicas serve data that is behind the primary by the replication lag, so a user can write and then not see their write, or a job can read a row that does not yet exist on the replica. The common fixes are routing reads that follow a user's own write to the primary for a short window, or recording the primary's WAL LSN after the write and only using a replica that has replayed past it (`pg_last_wal_replay_lsn()`). Critical invariants — balances, inventory at checkout — should read from the primary. You also monitor replay lag and route away from lagging replicas.

**Q: When is vertical scaling the right answer?**
A: When the load is legitimate, the bottleneck is on the primary (especially writes or working set larger than RAM), and a larger instance is available at an acceptable price. It needs no code change and keeps full ACID semantics, so it often buys 12–24 months of headroom for the cost of a planned switchover. It stops being right when you are near the largest instance, when price grows faster than capacity, or when the database is so large that backup, restore and replica rebuild times exceed your recovery objectives.

**Q: What does partitioning give you, and what does it not give you?**
A: It gives partition pruning so queries touch only relevant partitions, smaller per-partition indexes that fit in memory, per-partition vacuum and index maintenance, and cheap retention by detaching and dropping old partitions. It does not add CPU, RAM, IOPS or write capacity, because all partitions still live on one server with one WAL. It also constrains design: the partition key must be in every primary key and unique constraint, and queries without it scan every partition.

**Q: What does caching break, and how do you size the database around a cache?**
A: Caching creates a second copy of data that can be stale, so you own invalidation, read-after-write anomalies, stampedes on hot-key expiry and cold-start storms after a flush. If the database is sized only for the post-cache load, a cache failure becomes a database outage. I size the database to survive at least a partial loss of the cache, add request coalescing so one miss per key reaches the database, and warm caches before switching key formats.

**Q: How do you decide the shard key?**
A: From the access patterns, not the entity diagram. The key should appear in the most frequent and latency-critical queries so they stay single-shard, have high cardinality so data spreads, and distribute load evenly so no shard is hot. Related tables should share the key so joins and transactions for one entity are co-located. I also check the worst-case tenant or user: if one key can be much larger than the others, I need a plan to isolate it.

**Q: A team proposes moving to a distributed SQL database instead of sharding PostgreSQL themselves. How do you evaluate that? (Senior)**
A: I compare what problems each actually removes. Distributed SQL (CockroachDB, YugabyteDB, Spanner) gives automatic range splitting, rebalancing and cross-shard transactions, which removes most of the hand-built routing and 2PC work. The cost is higher per-transaction latency from consensus replication, different performance characteristics (contention and cross-range transactions are expensive), PostgreSQL compatibility gaps, and a new operational skill set. Citus keeps PostgreSQL semantics and tooling but still requires a distribution column and co-location design. I'd benchmark the dominant transactions on each, measure p99 not just throughput, and weigh the team's operational experience, because the database you can operate at 3am matters more than the one with the best benchmark.

**Q: You're asked to design the data layer for a product with 500 users today that "might grow to 100 million". What do you build? (Senior)**
A: A single PostgreSQL primary with a standby, a connection pooler, backups and monitoring — and a few cheap decisions that keep later rungs open. I'd pick a likely future shard key (tenant or user id) and include it in tables and primary keys where natural, avoid cross-entity transactions that would be hard to split, use IDs that don't depend on a single sequence if distribution seems likely, and keep analytics off the OLTP database. I would not shard, because the complexity would slow the product for years of zero benefit and the right key is often only clear once real access patterns exist. I'd also write down the triggers — CPU, write TPS, data size relative to restore time — that would move us up the ladder.

**Q: Your company expands to Europe and Asia; EU users complain of slow pages. What are the options and their consistency costs? (Senior)**
A: First I'd confirm the latency is data-layer latency and not static assets or chatty APIs. For reads, cross-region read replicas plus edge caching give local reads at the cost of replica lag, with writes still going to the home region. For writes, the options are geo-partitioning (each user's data lives and is written in their home region, so most transactions stay local and only cross-region interactions pay the round trip), a distributed SQL database with regional leaders or locality settings, or multi-leader replication with conflict resolution, which I'd avoid for anything with invariants like balances. Data-residency rules may force geo-partitioning anyway. The key trade-off is PACELC: synchronous cross-region commits give consistency at 70–200 ms per commit; asynchronous gives speed with possible conflicts or loss on region failure.

**Q: After adding two read replicas, primary CPU barely changed. What happened? (Senior)**
A: Most likely the load was not read-dominated, or the reads were not actually routed to the replicas. I'd check whether the application uses the replica connection for the heavy queries — ORMs often route everything to the default connection — and look at `pg_stat_statements` on each node to see where the statements run. If routing is correct, the primary may be bound by writes, vacuum, or a few read-after-write paths that must stay on the primary. It is also possible the replicas are rejecting queries due to recovery conflicts and the application retries on the primary. The lesson is to measure the read/write split before choosing a rung and to verify that the rung is carrying traffic after rollout.

**Q: How do you know when you have exhausted query optimization?**
A: When the top statements by total time are all efficient — index-served, small row counts, low disk reads, reasonable estimates — and the application issues close to the minimum number of queries per request. At that point the remaining CPU is paying for legitimate volume. I'd also check that the hot tables are not bloated and that stats are fresh, since those can masquerade as legitimate load. If the remaining load is still too high, the next rung depends on whether it is read or write.

**Q: What is the cost of a read replica that people forget?**
A: A replica is a full copy: full storage, typically the same instance size (so it can keep up with replay and serve as a failover target), and its own backups and monitoring. It adds WAL-sender work on the primary and, with `hot_standby_feedback`, can cause bloat on the primary through long queries. It also adds application complexity for routing and read-your-writes. For a heavy read workload that is worth it; for a small workload, fixing queries is far cheaper.

## 10. Quick Revision & Cheat Sheet

| Rung | Relieves | Does NOT relieve | Main new problem |
|---|---|---|---|
| Optimize | Wasted CPU/IO | Legit volume | Index write cost |
| Cache | Hot reads | Writes, long-tail reads | Staleness, stampedes |
| Replicas | Read volume | Writes, working set | Lag, routing |
| Vertical | CPU, RAM, write headroom | Geography | Ceiling, cost |
| Partition | Table size, maintenance, retention | Total throughput | Key in PK, scans without key |
| Shard | Writes, storage | Bad queries | Cross-shard everything |
| Multi-region | Distance, region loss | Throughput | Latency vs consistency |

- Diagnose the saturated resource first; each rung relieves a specific one.
- Reads multiply with copies; writes on a single primary do not.
- Optimization is the cheapest, biggest win and never stops being relevant.
- Caches and replicas change your consistency model — decide which reads may be stale.
- Vertical scaling is a legitimate, mature choice that buys time for harder work.
- Partitioning organizes one machine better; sharding adds machines.
- Sharding and multi-region are one-way doors: demand hard evidence.
- Write down the trigger for the next rung; re-measure after every rung.

## 11. Hands-On Exercises

Lab: `docker run -d --name pg -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:17 -c shared_preload_libraries=pg_stat_statements`, then `CREATE EXTENSION pg_stat_statements;`.

1. **Find the rung-2 win.** Create a 5M-row `orders` table with an `email` column, run a load of `WHERE lower(email) = ...` lookups with `pgbench -f`, and inspect `pg_stat_statements`. Add an expression index concurrently and compare `total_exec_time` and `shared_blks_read` before and after.
2. **Measure read/write split.** Run a mixed pgbench workload and write a query that classifies `pg_stat_statements` rows into SELECT vs INSERT/UPDATE/DELETE and reports each class's share of total time.
3. **Build a replica and observe lag.** Start a second `postgres:17` container as a streaming replica (`pg_basebackup -R`). Run a bulk `INSERT` of 10M rows on the primary and watch `replay_lag` in `pg_stat_replication` and `pg_last_xact_replay_timestamp()` on the replica.
4. **Read-your-writes gate.** Capture `pg_current_wal_lsn()` after a write on the primary and poll `pg_last_wal_replay_lsn() >= <lsn>` on the replica until true; measure how long it takes under idle and under the bulk load.
5. **Partition for retention.** Convert an `events` table to monthly range partitions, load 12 months, and compare `DELETE FROM events WHERE created_at < ...` against `DETACH PARTITION ... CONCURRENTLY` + `DROP` (time, WAL generated via `pg_stat_wal`, bloat left behind).

**Mini project:** Write a one-page "scaling plan" for a hypothetical service at 5,000 peak QPS, 90% reads, 400 GB data growing 30 GB/month. Identify the current rung, the saturated resource you expect next, the trigger metric and threshold for each of the next three rungs, and the consistency decisions each one forces.

## 12. Related Topics & Free Learning Resources

**This handbook:** [Ch 09 · Replication](topic.html?p=09-replication) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture) · [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases) · [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) · [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) · [Ch 23 · Bottleneck Diagnosis](topic.html?p=23-bottleneck-diagnosis)

**SQL Handbook:** [Query Optimization & EXPLAIN](../sql/topic.html?p=21-query-optimization) · [Execution Plans](../sql/topic.html?p=22-execution-plans) · [Partitioning](../sql/topic.html?p=23-partitioning) · [Index Design](../sql/topic.html?p=20-index-design)

**Other handbooks:** [System Design · Replication & Sharding](../system-design/topic.html?p=16-database-scaling) · [System Design · Vertical vs Horizontal Scaling](../system-design/topic.html?p=13-scaling-approaches) · [System Design · Caching](../system-design/topic.html?p=12-caching) · [Caching with Redis · Cache-Aside](../redis-caching/topic.html?p=08-cache-aside) · [Caching with Redis · Cache Stampede](../redis-caching/topic.html?p=15-cache-stampede)

- **PostgreSQL Documentation — High Availability, Load Balancing, and Replication** — PostgreSQL · *Intermediate* · the official comparison of replication and scaling approaches, including hot standby conflicts. <https://www.postgresql.org/docs/current/high-availability.html>
- **PostgreSQL Documentation — pg_stat_statements** — PostgreSQL · *Intermediate* · the tool that tells you whether you are on rung 2. <https://www.postgresql.org/docs/current/pgstatstatements.html>
- **Designing Data-Intensive Applications, ch. 5 & 6** — Martin Kleppmann · *Advanced* · replication and partitioning trade-offs, the theory under rungs 4, 6 and 7. <https://dataintensive.net/>
- **Citus Documentation — Choosing a Distribution Column** — Citus Data · *Advanced* · concrete guidance on shard keys and co-location for PostgreSQL. <https://docs.citusdata.com/en/stable/sharding/data_modeling.html>
- **Vitess Documentation — Overview** — Vitess · *Advanced* · how MySQL sharding is done at scale with keyspaces and vindexes. <https://vitess.io/docs/overview/>
- **Use The Index, Luke!** — Markus Winand · *Intermediate* · the best free resource for rung 2, which is where most scaling problems are actually solved. <https://use-the-index-luke.com/>
- **Figma — How Figma's databases team lived to tell the scale** — Figma Engineering · *Advanced* · a real progression through vertical scaling and vertical partitioning before horizontal sharding. <https://www.figma.com/blog/how-figmas-databases-team-lived-to-tell-the-scale/>

---

*Database Design Handbook — chapter 21.*
