# 19 · Database Caching Architecture: Cache + DB as One System

> **In one line:** A cache in front of a database is not a speed-up you bolt on — it is a second copy of your data with its own consistency rules and a load-bearing role in your capacity plan, so you must design when it is allowed to be wrong (and for how long), and what the database does on the day the cache is empty.

---

## 1. Overview

Caches get added for a good reason: the database is the most expensive, least horizontally scalable component in most stacks, and a large share of its reads are repeats. Serving a product page from Redis in 0.3 ms instead of running a five-table join in 8 ms is a real win, and at 50,000 reads/s it is the difference between one database and a fleet of them.

The trouble is that the moment a cache holds data the database also holds, you have a **distributed system with two copies and no transaction spanning them**. Every write to the database now has an implicit second step — make the cache stop serving the old value — and that step can happen too early, too late, out of order, or not at all. The naive approach ("read from cache, on miss read DB and set cache; on write, update DB and delete the key") works in a demo and fails in production in at least four distinct ways, each of which leaves the cache serving stale data until a TTL rescues it — if there is a TTL.

There is a second, less discussed failure: **the database stops being able to survive without the cache.** Once a 95% hit ratio lets you run a database sized for 5% of reads, the cache is no longer an optimisation; it is part of your capacity. A cache flush, a Redis failover, a deploy that changes the key format, or a hot key expiring can send 20× the normal load to the database, which then slows, which makes cache fills slower, which keeps the hit ratio low — a feedback loop that turns a cache blip into a database outage.

This chapter keeps its angle on the **seam**: how the cache and the database interact, where consistency breaks, and how to protect the database. The Redis-level mechanics of each pattern are covered in depth in the [Caching with Redis](../redis-caching/topic.html?p=08-cache-aside) handbook; this chapter links to them rather than repeating them.

> **Builds on:** [Ch 01 · Database Architecture](topic.html?p=01-database-architecture) (the buffer manager and shared_buffers) · [Ch 09 · Database Replication](topic.html?p=09-replication) (lag — which leaks into caches) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) (bounded staleness, read-your-writes). For the Redis side: [Caching with Redis · Cache-Aside](../redis-caching/topic.html?p=08-cache-aside) and [Caching with Redis · Cache Invalidation](../redis-caching/topic.html?p=12-cache-invalidation). This chapter assumes those and focuses on correctness and load at the cache/database boundary.

> **Why this matters:** Interviewers love "add a cache" because the follow-ups separate levels: *How do you keep it consistent? What's the staleness bound? What happens to the DB when Redis restarts?* A senior answer has a number for each.

## 2. Core Concepts

- **Buffer cache (shared_buffers + OS page cache)** — the database's own cache of 8 KB pages. *Why it matters:* always consistent (it *is* the database), but a hit still costs a connection, parsing, planning, executing, locking and serialisation.
- **External cache** — Redis/Memcached holding *computed* results (a serialized object, a rendered fragment, a query result). *Why it matters:* saves the whole query path, but is a separate copy that can be stale.
- **Hit ratio / miss ratio** — fraction of reads served by the cache / sent to the database. *Why it matters:* the **miss ratio** is what the database feels; going from 99% to 95% hits is a 5× increase in DB reads.
- **Cache-aside** — the application reads the cache, on miss reads the DB and populates. *Why it matters:* the default; the app owns consistency.
- **Read-through / write-through** — a cache layer loads from / writes to the DB on the app's behalf. *Why it matters:* centralises logic, same races underneath.
- **Write-behind (write-back)** — writes go to the cache and are flushed to the DB asynchronously. *Why it matters:* the cache becomes the temporary system of record; a cache loss loses writes.
- **Invalidation** — making the cache stop serving a value that the DB has changed. *Why it matters:* where almost all cache bugs live.
- **Stale-set race** — a slow reader populates the cache with a value read *before* a concurrent write committed. *Why it matters:* the canonical cache-aside bug; delete-on-write alone does not prevent it.
- **TTL as a consistency bound** — the maximum time an unnoticed stale entry can survive. *Why it matters:* it turns "eventually consistent" into "at most N seconds stale".
- **Stampede (dogpile)** — many concurrent misses on the same key all hitting the DB. **Penetration** — reads for keys that don't exist, which never get cached. **Hot key** — one key taking a disproportionate share of traffic. **Avalanche** — many keys expiring together. *Why they matter:* each is a way the cache fails to shield the database.
- **Cold-cache capacity** — the load the database can sustain with an empty (or partially empty) cache. *Why it matters:* the real requirement for surviving cache failures.
- **CDC-driven invalidation** — deriving invalidations from the database's commit log (WAL/binlog). *Why it matters:* invalidation that cannot be skipped by an application bug and arrives in commit order.

## 3. Theory & Principles

### The database's buffer cache vs an external cache

PostgreSQL already caches: `shared_buffers` (default 128 MB; commonly set to ~25% of RAM) plus the operating system's page cache. When the working set fits, most reads never touch disk. So why add Redis?

Because a buffer hit only removes the **I/O**. A query still needs a backend process and a connection slot (Ch 20), parsing and planning (or a prepared plan), executor work across several indexes and tables, snapshot and visibility checks, and serialisation of rows to the wire. A five-way join that hits entirely in shared_buffers can still burn milliseconds of CPU. An external cache stores the **finished answer** keyed by what the app asks for, and serves it in sub-millisecond time from a system that scales horizontally and cheaply.

The trade: the buffer cache is **always correct** and invalidates itself (the page *is* the data). The external cache is **a copy** and is correct only as long as your invalidation design is. Two practical consequences:

1. Before adding an external cache, check whether the database is actually I/O-bound or CPU/connection-bound. If `blks_hit / (blks_hit + blks_read)` in `pg_stat_database` is already 99%+ and the problem is CPU on a few expensive queries, fix the queries or cache *their results* — not rows the DB already serves from memory.
2. External caches are best at **expensive-to-compute, read-many, change-rarely** data: product detail aggregates, permission sets, feed pages, config. They are worst at **cheap point lookups on hot, frequently changing rows**, where the buffer cache is already doing the job and the external copy mostly adds staleness.

> **MySQL difference:** InnoDB's equivalent is the **buffer pool** (`innodb_buffer_pool_size`, commonly 50–75% of RAM on a dedicated server, because InnoDB typically uses O_DIRECT and does not rely on the OS page cache the way PostgreSQL does). MySQL used to have a built-in **query cache** that cached result sets and invalidated them on any write to the table; it scaled so poorly under concurrent writes (a global mutex, table-level invalidation) that it was deprecated in 5.7 and **removed in MySQL 8.0** — a useful lesson in why result caching belongs outside the database with finer-grained invalidation.

### The four ways cache-aside goes stale

Assume the textbook pattern: **read** = GET; on miss, SELECT from DB and SET with TTL. **Write** = UPDATE the DB, then DEL the key. ([Caching with Redis · Cache-Aside](../redis-caching/topic.html?p=08-cache-aside) explains why delete beats update.) Here is how it still goes wrong:

**1. The stale-set race (read/write interleaving).** Reader R misses, reads v16 from the DB, pauses (GC, slow network). Writer W commits v17 and deletes the key. R resumes and SETs v16. The cache now holds v16 until TTL, and no further write is coming to invalidate it.

**2. Invalidate-before-commit.** The writer deletes the key *inside* the transaction, before `COMMIT`. A reader misses between the DEL and the COMMIT, and under READ COMMITTED it sees the old committed row and caches it. The delete accomplished nothing. **Rule: invalidate after the transaction commits**, never inside it.

**3. Replica-lag fill.** Reads on miss go to a read replica (sensible for load). The writer commits on the primary and deletes the key; the next reader misses and reads from a replica that hasn't replayed the write yet — and caches the old value for a full TTL. Replica lag of 200 ms has become staleness of 10 minutes. **Rule: fills after a recent write for that key must read the primary**, or the invalidation must be delayed past the lag (delayed double delete), or fills must carry a version that can be compared.

**4. Lost invalidation.** The process crashes (or the Redis call times out) between `COMMIT` and `DEL`. Nothing retries it. This is the dual-write problem ([Caching with Redis · Dual Write & CDC](../redis-caching/topic.html?p=14-dual-write-and-cdc)): two systems, no shared transaction.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The stale-set race, and how a DB row version plus a tombstone closes it</text>
  <text x="20" y="62" fill="#1e40af" font-weight="bold">Reader R</text>
  <text x="20" y="122" fill="#92400e" font-weight="bold">Database</text>
  <text x="20" y="182" fill="#5b21b6" font-weight="bold">Writer W</text>
  <text x="20" y="242" fill="#dc2626" font-weight="bold">Cache</text>
  <line x1="110" y1="58" x2="860" y2="58" stroke="#93c5fd" stroke-width="2"/>
  <line x1="110" y1="118" x2="860" y2="118" stroke="#fcd34d" stroke-width="2"/>
  <line x1="110" y1="178" x2="860" y2="178" stroke="#c4b5fd" stroke-width="2"/>
  <line x1="110" y1="238" x2="860" y2="238" stroke="#fca5a5" stroke-width="2"/>
  <rect x="120" y="44" width="110" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="175" y="61" text-anchor="middle" fill="#1e40af" font-size="9">1. GET &#8594; miss</text>
  <rect x="240" y="44" width="130" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="305" y="61" text-anchor="middle" fill="#1e40af" font-size="9">2. SELECT &#8594; v16</text>
  <rect x="380" y="44" width="200" height="26" rx="4" fill="#f1f5f9" stroke="#94a3b8"/><text x="480" y="61" text-anchor="middle" fill="#334155" font-size="9">3. paused (GC / slow network)</text>
  <rect x="600" y="44" width="150" height="26" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="675" y="61" text-anchor="middle" fill="#991b1b" font-size="9">6. SET key = v16</text>
  <rect x="240" y="104" width="130" height="26" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="305" y="121" text-anchor="middle" fill="#92400e" font-size="9">row version = 16</text>
  <rect x="400" y="104" width="140" height="26" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="470" y="121" text-anchor="middle" fill="#92400e" font-size="9">row version = 17</text>
  <rect x="390" y="164" width="150" height="26" rx="4" fill="#ede9fe" stroke="#7c3aed"/><text x="465" y="181" text-anchor="middle" fill="#5b21b6" font-size="9">4. UPDATE ... COMMIT (v17)</text>
  <rect x="550" y="164" width="120" height="26" rx="4" fill="#ede9fe" stroke="#7c3aed"/><text x="610" y="181" text-anchor="middle" fill="#5b21b6" font-size="9">5. DEL key</text>
  <rect x="560" y="224" width="80" height="26" rx="4" fill="#fff" stroke="#94a3b8"/><text x="600" y="241" text-anchor="middle" fill="#334155" font-size="9">(empty)</text>
  <rect x="660" y="224" width="190" height="26" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="755" y="241" text-anchor="middle" fill="#991b1b" font-size="9">v16 cached until TTL: STALE</text>
  <rect x="20" y="276" width="410" height="210" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="225" y="298" text-anchor="middle" fill="#991b1b" font-size="12" font-weight="bold">Why plain DEL does not help</text>
  <text x="36" y="322" fill="#991b1b" font-size="10">The delete ran before the stale SET, so it deleted nothing.</text>
  <text x="36" y="342" fill="#991b1b" font-size="10">After the DEL the key is simply absent &#8212; a later SET of</text>
  <text x="36" y="358" fill="#991b1b" font-size="10">any value, old or new, is accepted.</text>
  <text x="36" y="384" fill="#991b1b" font-size="10">Same shape: invalidate-before-COMMIT, fill from a lagging</text>
  <text x="36" y="400" fill="#991b1b" font-size="10">replica, a second writer's late cache update.</text>
  <text x="36" y="432" fill="#7f1d1d" font-size="10" font-weight="bold">Bound: staleness &#8804; TTL. Without a TTL: unbounded.</text>
  <text x="36" y="452" fill="#7f1d1d" font-size="10">Frequency: rare per key, certain across millions of keys.</text>
  <rect x="450" y="276" width="410" height="210" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="655" y="298" text-anchor="middle" fill="#166534" font-size="12" font-weight="bold">Fix: versions from the DB, cache never goes back</text>
  <text x="466" y="322" fill="#166534" font-size="10">Row has a version column (bumped by every UPDATE).</text>
  <text x="466" y="342" fill="#166534" font-size="10">Step 5 writes a TOMBSTONE {ver:17} (short TTL), not DEL.</text>
  <text x="466" y="362" fill="#166534" font-size="10">Step 6 is a conditional set (Lua): write only if</text>
  <text x="466" y="378" fill="#166534" font-size="10">incoming ver &gt; stored ver &#8594; v16 &lt; 17 &#8594; REJECTED.</text>
  <text x="466" y="402" fill="#166534" font-size="10">Next reader misses the tombstone, reads v17, sets it.</text>
  <text x="466" y="428" fill="#14532d" font-size="10" font-weight="bold">Alternatives with the same idea: memcache leases</text>
  <text x="466" y="444" fill="#14532d" font-size="10">(fill needs a token that a DEL revokes), CDC applying</text>
  <text x="466" y="460" fill="#14532d" font-size="10">invalidations in commit (LSN) order.</text>
</svg>
```

### TTL is a consistency contract

Every invalidation scheme has holes — races, lost messages, bugs. The TTL is the backstop that bounds the damage: **if a stale entry can only be created by a race, it lives at most TTL**. That makes TTL a product decision, not a performance knob. "Prices may be up to 60 s stale in listings" is a consistency requirement you can write down and defend; "prices are cached" is not.

Choose TTL per data class:

| Data | Typical staleness tolerance | TTL + invalidation |
| --- | --- | --- |
| Account balance, stock for checkout, permissions revocation | none | don't cache on the decision path — read the DB (or cache with explicit invalidation *and* re-check in the transaction) |
| Product details, user profile | seconds to minutes | explicit invalidation + TTL 5–60 min |
| Listings, search facets, counters shown to users | tens of seconds | TTL 10–60 s, maybe no explicit invalidation |
| Reference data (countries, plans) | minutes to hours | long TTL + versioned namespace on deploy |

The iron rule: **a cached value may inform a display, never authorise a write.** If checkout reads stock from cache to decide whether to sell, you will oversell. The authoritative check belongs in the database transaction (`UPDATE inventory SET qty = qty - 1 WHERE sku = $1 AND qty > 0`) — see [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control).

### Write patterns and what they do to the database

- **Cache-aside + delete-after-commit** — DB is the only source of truth; cache is disposable. Safest. Default. ([Redis · Cache-Aside](../redis-caching/topic.html?p=08-cache-aside))
- **Write-through** — the write path updates DB then cache synchronously. Keeps hot keys warm after writes but has the concurrent-writer ordering race unless the cache set is version-conditional. ([Redis · Read-Through & Write-Through](../redis-caching/topic.html?p=09-read-through-write-through))
- **Write-behind** — writes land in the cache and are flushed to the DB in batches. Absorbs write spikes (e.g. view counters: 10,000 increments become one `UPDATE ... SET views = views + 10000` per interval). The cost: the cache is the system of record for the flush interval, so a cache node loss loses those writes, and DB constraints are checked *after* the user was told "success". Use for data where loss is tolerable and aggregation is valuable; never for orders or money. ([Redis · Write-Behind & Write-Around](../redis-caching/topic.html?p=10-write-behind-write-around))
- **Write-around** — writes go to the DB only; cache is populated only on read. Right for write-once, rarely-read data (logs, audit rows).

## 4. Architecture & Workflow

### Capacity: the cache is part of the database's load plan

Suppose peak read traffic is 60,000 reads/s and the database comfortably handles 6,000 queries/s of this read mix (plus its writes).

```text
hit ratio   DB reads/s   DB utilisation (vs 6,000 capacity)
  99%          600          10%
  95%        3,000          50%
  90%        6,000         100%   <- at the edge
  80%       12,000         200%   <- overload: queueing, timeouts
   0%       60,000        1000%   <- cache flush / Redis failover with cold replica
```

Two lessons fall out of the table. First, **the database feels the miss ratio, which is non-linear in the hit ratio**: 99% → 95% is a 5× load increase. A deploy that changes a key prefix, a Redis eviction storm, or a TTL shortened "to be safe" can each push the database over the edge without anything "failing". Second, **you need a plan for cold-cache capacity**: the database must either survive a meaningful fraction of the cold load, or the system must shed and coalesce load until the cache refills.

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c19a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">When the cache dies: the refill death spiral and its brakes</text>
  <rect x="40" y="48" width="170" height="54" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="125" y="70" text-anchor="middle" fill="#991b1b" font-weight="bold">Cache empty</text>
  <text x="125" y="88" text-anchor="middle" fill="#991b1b" font-size="10">flush / failover / new keys</text>
  <rect x="270" y="48" width="170" height="54" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="355" y="70" text-anchor="middle" fill="#991b1b" font-weight="bold">Miss ratio 100%</text>
  <text x="355" y="88" text-anchor="middle" fill="#991b1b" font-size="10">DB load x10&#8211;x20</text>
  <rect x="500" y="48" width="170" height="54" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="585" y="70" text-anchor="middle" fill="#991b1b" font-weight="bold">DB saturates</text>
  <text x="585" y="88" text-anchor="middle" fill="#991b1b" font-size="10">queues, p99 &#8593;, pools full</text>
  <rect x="500" y="150" width="170" height="54" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="585" y="172" text-anchor="middle" fill="#991b1b" font-weight="bold">Fills slow / time out</text>
  <text x="585" y="190" text-anchor="middle" fill="#991b1b" font-size="10">cache stays cold</text>
  <rect x="270" y="150" width="170" height="54" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="355" y="172" text-anchor="middle" fill="#991b1b" font-weight="bold">Clients retry</text>
  <text x="355" y="190" text-anchor="middle" fill="#991b1b" font-size="10">load x2&#8211;x3 more</text>
  <path d="M212,75 L266,75" stroke="#dc2626" stroke-width="2" marker-end="url(#c19a1)"/>
  <path d="M442,75 L496,75" stroke="#dc2626" stroke-width="2" marker-end="url(#c19a1)"/>
  <path d="M585,104 L585,146" stroke="#dc2626" stroke-width="2" marker-end="url(#c19a1)"/>
  <path d="M498,177 L444,177" stroke="#dc2626" stroke-width="2" marker-end="url(#c19a1)"/>
  <path d="M355,148 L355,106" stroke="#dc2626" stroke-width="2" marker-end="url(#c19a1)"/>
  <text x="720" y="120" fill="#991b1b" font-size="11" font-weight="bold">A positive feedback loop:</text>
  <text x="720" y="138" fill="#991b1b" font-size="10">the cache can only refill</text>
  <text x="720" y="154" fill="#991b1b" font-size="10">through the database it</text>
  <text x="720" y="170" fill="#991b1b" font-size="10">was protecting.</text>
  <rect x="20" y="230" width="840" height="216" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="252" text-anchor="middle" fill="#166534" font-size="12" font-weight="bold">Brakes, in the order they act</text>
  <rect x="40" y="266" width="190" height="80" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="135" y="286" text-anchor="middle" fill="#166534" font-weight="bold">1. Coalesce</text>
  <text x="135" y="304" text-anchor="middle" fill="#166534" font-size="10">single-flight per key:</text>
  <text x="135" y="320" text-anchor="middle" fill="#166534" font-size="10">N misses &#8594; 1 DB query</text>
  <text x="135" y="336" text-anchor="middle" fill="#166534" font-size="10">(in-process + lock key)</text>
  <rect x="245" y="266" width="190" height="80" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="340" y="286" text-anchor="middle" fill="#166534" font-weight="bold">2. Bound DB concurrency</text>
  <text x="340" y="304" text-anchor="middle" fill="#166534" font-size="10">small pool + queue timeout</text>
  <text x="340" y="320" text-anchor="middle" fill="#166534" font-size="10">DB runs at capacity, not</text>
  <text x="340" y="336" text-anchor="middle" fill="#166534" font-size="10">beyond it (Ch 20)</text>
  <rect x="450" y="266" width="190" height="80" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="545" y="286" text-anchor="middle" fill="#166534" font-weight="bold">3. Serve stale / degrade</text>
  <text x="545" y="304" text-anchor="middle" fill="#166534" font-size="10">stale-while-revalidate,</text>
  <text x="545" y="320" text-anchor="middle" fill="#166534" font-size="10">L1 in-process copy,</text>
  <text x="545" y="336" text-anchor="middle" fill="#166534" font-size="10">hide non-critical widgets</text>
  <rect x="655" y="266" width="190" height="80" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="750" y="286" text-anchor="middle" fill="#166534" font-weight="bold">4. Shed + warm</text>
  <text x="750" y="304" text-anchor="middle" fill="#166534" font-size="10">reject low-priority reads,</text>
  <text x="750" y="320" text-anchor="middle" fill="#166534" font-size="10">no retries on 503,</text>
  <text x="750" y="336" text-anchor="middle" fill="#166534" font-size="10">prewarm top keys</text>
  <text x="40" y="374" fill="#166534" font-size="10">Structural fixes: Redis replicas (failover keeps data warm) &#183; key-format changes rolled out gradually &#183; TTL jitter (no avalanche)</text>
  <text x="40" y="394" fill="#166534" font-size="10">Capacity rule: size the DB for the load at a realistic worst hit ratio (e.g. losing 1 of N cache shards), not the steady state.</text>
  <text x="40" y="414" fill="#166534" font-size="10">Test it: flush a cache shard in staging under production-like load and watch DB CPU, p99 and pool wait.</text>
  <text x="40" y="434" fill="#14532d" font-size="10" font-weight="bold">The goal is not "the DB handles 100% misses"; it is "the system degrades gracefully while the cache refills".</text>
</svg>
```

### How the classic cache failures land on the database

These are covered in Redis depth in their own chapters; here is what each does to the **database** and the database-side defence:

| Failure | What the DB sees | DB-side defence | Redis-depth chapter |
| --- | --- | --- | --- |
| **Stampede** — hot key expires, 2,000 concurrent misses | 2,000 identical expensive queries at once; CPU spike, connection pool exhaustion | single-flight/locks on fill, early probabilistic refresh, stale-while-revalidate; bounded pool so excess waits instead of piling onto the DB | [Cache Stampede](../redis-caching/topic.html?p=15-cache-stampede) |
| **Penetration** — requests for ids that don't exist (bugs, scrapers, attacks) | a steady stream of index lookups that return nothing and are never cached | negative caching with short TTL, Bloom filter of valid ids, input validation, rate limits | [Cache Penetration & Bloom Filters](../redis-caching/topic.html?p=16-cache-penetration-bloom) |
| **Hot key** — one celebrity/product key gets 30% of traffic | little, while the cache holds; a thundering herd whenever it's invalidated | local L1 cache with short TTL, update-in-place (version-guarded) for that key instead of delete, key replication | [Hot Keys & Avalanche](../redis-caching/topic.html?p=17-hot-keys-avalanche) |
| **Avalanche** — many keys share a TTL (bulk loaded at deploy) | a synchronized miss wave every TTL period | TTL jitter (±10–20%), staggered warm-up | [Hot Keys & Avalanche](../redis-caching/topic.html?p=17-hot-keys-avalanche) |
| **Cache node loss** | 1/N of keys go cold at once | replicas/failover in the cache tier, consistent hashing so only that shard's keys move | [Redis Cluster](../redis-caching/topic.html?p=26-redis-cluster) |

### CDC-driven invalidation: let the database's log drive the cache

The most robust fix for lost and out-of-order invalidations is to **stop invalidating from application code** and derive invalidations from the database's commit log. PostgreSQL's logical decoding (or Debezium reading it) emits every committed row change in **commit order**, with its LSN. A small invalidator service consumes that stream and deletes or tombstones the affected keys.

What this buys:
- **No lost invalidation:** if the invalidator crashes, it resumes from its replication slot's confirmed position. Every committed change is eventually processed.
- **After-commit by construction:** decoding only emits committed transactions, so invalidate-before-commit can't happen.
- **Covers every writer:** batch jobs, admin SQL, migrations and other services writing the same table all produce WAL.
- **Ordering:** events carry LSNs, so the invalidator can tombstone with a version (the LSN or the row's version column) and the conditional-set trick rejects stale fills.

What it costs: an extra pipeline (slot, consumer, maybe Kafka), invalidation lag equal to pipeline lag (typically tens to hundreds of ms), a replication slot that retains WAL if the consumer stalls (set `max_slot_wal_keep_size`), and a mapping from row changes to cache keys (a row change may affect several cached aggregates). Mechanics of the outbox vs CDC choice: [Caching with Redis · Dual Write & CDC](../redis-caching/topic.html?p=14-dual-write-and-cdc) and [Kafka & RabbitMQ · Kafka Connect & CDC](../messaging/topic.html?p=25-kafka-connect-cdc).

```text
 app ──UPDATE products──▶ PostgreSQL ──WAL──▶ logical slot "cache_inval"
                                                   │ (pgoutput / Debezium)
                                                   ▼
                                     invalidator: for each committed change
                                       key = "product:{id}"
                                       SET key TOMBSTONE{ver=row.version} EX 30   (or DEL)
                                                   │
 app ──GET product:{id}──▶ Redis ◀─────────────────┘
      miss/tombstone ──▶ SELECT ... ──▶ conditional SET (only if ver > stored)
```

### Distributed caching and Redis at a high level

A single Redis node executes commands on one main thread, entirely in memory, typically at 100k+ simple ops/s; beyond that you shard. **Redis Cluster** splits the key space into 16,384 hash slots spread over primaries, each with replicas; clients route by slot. For the database, the relevant properties are: losing a primary without a replica makes 1/N of keys cold at once; a failover to a replica keeps them warm; `maxmemory` with an eviction policy (`allkeys-lru` / `allkeys-lfu` for pure caches) decides *which* entries fall back to the database under memory pressure — an eviction storm looks exactly like a hit-ratio drop. Persistence (RDB/AOF) is usually off or relaxed for pure caches; if you rely on it to avoid a cold start, that is a capacity decision, not a durability one. Details: [Caching with Redis · Memory & Eviction](../redis-caching/topic.html?p=07-memory-and-eviction) and [Redis Cluster](../redis-caching/topic.html?p=26-redis-cluster).

## 5. Implementation

### Simple example: measure whether you need an external cache

```sql
-- Buffer cache hit ratio per database (cumulative since stats reset)
SELECT datname,
       blks_hit, blks_read,
       round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS hit_pct
FROM pg_stat_database WHERE datname = current_database();

-- Which queries are called most and cost the most in total? (cache candidates)
SELECT calls, round(total_exec_time) AS total_ms, round(mean_exec_time, 2) AS mean_ms,
       rows / nullif(calls, 0) AS rows_per_call,
       shared_blks_hit, shared_blks_read,
       left(query, 80) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 10;
```

```text
 calls    | total_ms | mean_ms | rows_per_call | shared_blks_hit | shared_blks_read | query
----------+----------+---------+---------------+-----------------+------------------+-------------------------------
 9120331  |  7412210 |    0.81 |             1 |       182406620 |             1022 | SELECT p.*, b.name, (SELECT avg(r.rating) ...
  211002  |  3120450 |   14.79 |            20 |        98112003 |           402113 | SELECT ... FROM feed_items WHERE user_id = $1 ...
```

The first query runs 9 M times, entirely from buffers, 0.8 ms each — CPU-bound on repetition, a perfect external cache candidate (product detail page). The second reads from disk and is per-user — caching it helps less (low reuse per key) than an index or a better query plan.

### The invalidation-safe cache-aside, in Python

Row versions come from the database; the cache refuses to go backwards; invalidation happens after commit and leaves a tombstone.

```sql
ALTER TABLE products ADD COLUMN version bigint NOT NULL DEFAULT 1;

-- every update bumps the version and returns it
UPDATE products
SET price_cents = $2, version = version + 1, updated_at = now()
WHERE id = $1
RETURNING version;
```

```python
import json, redis, psycopg

r = redis.Redis()

# Refuse to go backwards. A tombstone {v:17} rejects fills older than 17 (a fill OF 17 is
# the fresh value and is accepted); a real value {v:17} rejects fills of 17 or older.
SET_IF_NEWER = r.register_script("""
local cur = redis.call('GET', KEYS[1])
if cur then
  local obj = cjson.decode(cur)
  local incoming = tonumber(ARGV[1])
  if obj.tombstone then
    if obj.v > incoming then return 0 end
  elseif obj.v >= incoming then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
""")

TTL = 600          # 10 min: the staleness bound if every other mechanism fails
TOMBSTONE_TTL = 30 # longer than the slowest plausible fill (query timeout + pause)

def get_product(pool, pid: int):
    key = f"product:{pid}"
    raw = r.get(key)
    if raw:
        obj = json.loads(raw)
        if obj.get("missing"):
            return None                          # negative-cache hit
        if not obj.get("tombstone"):
            return obj
    # miss or tombstone -> read the PRIMARY (a lagging replica would reintroduce staleness)
    with pool.connection() as conn:
        row = conn.execute(
            "SELECT id, name, price_cents, version FROM products WHERE id = %s", (pid,)
        ).fetchone()
    if row is None:
        r.set(key, json.dumps({"v": 0, "missing": True}), ex=60)   # negative cache
        return None
    obj = {"id": row[0], "name": row[1], "price_cents": row[2], "v": row[3]}
    SET_IF_NEWER(keys=[key], args=[row[3], json.dumps(obj), TTL])
    return obj

def update_price(pool, pid: int, price: int):
    with pool.connection() as conn:
        with conn.transaction():                 # COMMIT happens when this block exits
            (ver,) = conn.execute(
                "UPDATE products SET price_cents=%s, version=version+1 WHERE id=%s RETURNING version",
                (price, pid)).fetchone()
    # AFTER commit: tombstone with the new version so any in-flight stale fill is rejected
    r.set(f"product:{pid}", json.dumps({"v": ver, "tombstone": True}), ex=TOMBSTONE_TTL)
```

What each line defends against: the post-commit tombstone handles invalidate-before-commit and the stale-set race (the slow reader's v16 is rejected by the Lua check because the tombstone holds v17); reading the primary on fill handles replica lag; the TTL bounds anything else; negative caching blunts penetration. The one hole left — the process dies between COMMIT and the tombstone — is closed by CDC-driven invalidation, or bounded by TTL.

### Real-world example: a product catalogue at 60k reads/s

An e-commerce catalogue: 2 M products, 60,000 product-page reads/s at peak, ~50 price/stock updates/s, plus nightly bulk imports of 200,000 updates.

- **Data classes.** Product detail (name, images, description, specs): cache 30 min, invalidated via CDC. Price: cached in the same object but with a separate short TTL field (60 s) because pricing jobs update it frequently. Stock for display: cached 10 s with no invalidation ("In stock" badge may lag ten seconds). Stock for checkout: **never from cache** — the order transaction does a conditional decrement in PostgreSQL.
- **Invalidation.** A Debezium connector on `products` and `prices` writes change events to Kafka; an invalidator consumer tombstones `product:{id}` with the row version. The nightly import produces 200,000 invalidations in a burst; the invalidator rate-limits so the refill wave stays under the DB's headroom, and it skips keys that aren't in the cache (no point tombstoning cold keys — check `EXISTS` in a pipeline).
- **Protection.** Fills use single-flight per key (a short `SET lock:product:{id} NX PX 3000`); other callers serve the stale value if present or wait briefly. The DB pool for fills is capped at 40 connections with a 200 ms queue timeout; on timeout, the page renders without the "similar products" widget.
- **Capacity.** Steady hit ratio 98.5% → ~900 DB reads/s. The DB is sized to handle ~8,000 of these reads/s, so losing one of six Redis shards (hit ratio drops to ~82% for that shard's keys, ~95% overall) is survivable without shedding. A full flush is not; the runbook for that is: enable shedding of anonymous traffic, prewarm top 50,000 products from `pg_stat_statements`-informed lists, then ramp.

> **MySQL difference:** The same design works on MySQL with the binlog as the CDC source (Debezium MySQL connector, or Alibaba Canal / Maxwell). InnoDB's default REPEATABLE READ means a fill query inside a long transaction can read an old snapshot and cache it even *after* the invalidation — run fill reads in their own short autocommit statement.

## 6. Advantages, Disadvantages & Trade-offs

| Approach | Consistency | DB protection | Complexity | Use for |
| --- | --- | --- | --- | --- |
| No external cache, rely on buffer cache | always consistent | none beyond DB capacity | lowest | cheap lookups, write-heavy rows |
| Cache-aside, TTL only | stale ≤ TTL | good while warm | low | listings, counters, tolerant reads |
| Cache-aside + delete after commit + TTL | race window ≤ TTL | good | low-medium | most entities |
| + versioned conditional set + tombstones | stale fills rejected; only lost-invalidation window remains (≤ TTL) | good | medium | entities where staleness matters |
| + CDC-driven invalidation | invalidation lag (ms); nothing lost | good | high (pipeline) | multi-writer tables, strict freshness |
| Write-through | fresh after write (ordering race unless versioned) | keeps hot keys warm | medium | read-after-write heavy keys |
| Write-behind | cache is truth for flush window; loss on cache failure | offloads writes | high | counters, telemetry, aggregatable writes |

### When to use an external cache

- Expensive, repeatable reads (joins, aggregates, rendered objects) with high reuse per key.
- Read-heavy traffic where the DB is CPU- or connection-bound on repeats.
- Data with a clearly stated staleness tolerance.
- To absorb spikes (write-behind for counters) where losing a few seconds of increments is acceptable.

### When NOT to use

- On the **decision path of a write** (stock, balance, permissions for a mutation) — authorise in the database.
- For low-reuse, per-request-unique queries — you pay the round trip and memory for a hit ratio near zero.
- To hide a bad query or missing index — fix the database; the cache will expire at the worst time.
- When you cannot state the staleness bound — you haven't designed the cache yet.

## 7. Common Mistakes & Best Practices

- **Invalidating inside the transaction.** *Why it hurts:* a reader refills with the pre-commit value between DEL and COMMIT. *Instead:* invalidate after commit (or via CDC).
- **Filling from a read replica after a write.** *Why it hurts:* lag becomes TTL-long staleness. *Instead:* fill from the primary for recently written keys, or use version-guarded fills.
- **No TTL "because we invalidate".** *Why it hurts:* every race and lost invalidation becomes permanent staleness. *Instead:* every entry has a TTL that matches the data's staleness tolerance.
- **Updating the cache on write without versions.** *Why it hurts:* two concurrent writers can leave the older value in the cache. *Instead:* delete/tombstone, or conditional set by version.
- **Sizing the DB for the steady-state hit ratio.** *Why it hurts:* any cache blip becomes a DB outage. *Instead:* size for a realistic degraded hit ratio, and build coalescing + shedding for the rest.
- **Changing key formats in one deploy.** *Why it hurts:* 100% miss ratio instantly. *Instead:* roll out key changes gradually (canary percentage), or read-old-write-both during migration.
- **Unbounded fill concurrency.** *Why it hurts:* stampedes exhaust DB connections. *Instead:* single-flight per key and a small, bounded fill pool with queue timeouts (Ch 20).
- **Caching authorization decisions for long TTLs.** *Why it hurts:* revoked access keeps working. *Instead:* short TTL + explicit invalidation on revoke, and re-check on sensitive actions.
- **Best practice:** document, per cached entity: key format, TTL, invalidation source, fill source (primary/replica), staleness bound, and what the DB does if the key is cold.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**The deploy that took down the database.** At 14:05 a release changes the cache key from `product:{id}` to `product:v2:{id}` to add a field. Hit ratio drops from 98% to 0% instantly; DB CPU goes to 100%, p99 page latency to 12 s, and the fill queries time out so the cache never warms. Root cause: key-format change deployed to 100% of instances. Fix: rollback, then reintroduce with a versioned *value* (readers tolerate missing fields) or a 5% → 25% → 100% rollout, and add a hit-ratio canary check to the deploy pipeline.

**Prices that wouldn't update.** Support reports a product showing the old price for ~10 minutes after a price change, a few times a day. Root cause: fills read from a replica that was 300–800 ms behind during the pricing job; the invalidation happened, the next fill re-cached the old price for the full 10-minute TTL. Fix: fills for `product:*` read the primary; version-guarded sets; TTL on price reduced to 60 s.

**Redis failover, cold replica.** A Redis primary crashes; its replica had been restarted an hour earlier and its replication was broken (full resync failing due to `client-output-buffer-limit`). Failover promotes an empty replica; 1/6 of keys go cold; the DB absorbs it — barely. Fix: alert on replica link status and `master_link_status`, and include cache-tier health in DB capacity reviews.

**The midnight stampede.** Every night at 00:00 the DB CPU spikes for 90 s. Root cause: a bulk warm job sets 500,000 keys with the same 24 h TTL at midnight; they all expire together (avalanche) the next midnight. Fix: TTL jitter ±15%.

**Penetration by a buggy client.** A mobile client bug requests `product:undefined` 3,000 times/s. Every request misses and runs a query returning nothing. Fix: input validation, negative caching, and a per-client rate limit.

### What to monitor

| Metric | Why |
| --- | --- |
| Cache hit ratio (overall and per key prefix) | per-prefix drops reveal deploys, bad TTLs, evictions |
| DB QPS from cache fills (tag fill queries via `application_name` or query comments) | the load the cache is *not* absorbing |
| Evictions/s, used memory vs maxmemory | eviction storms look like hit-ratio drops |
| Fill latency and fill errors/timeouts | early signal of DB saturation |
| Stale-read audits (sample keys, compare version with DB) | measures actual staleness, not assumed |
| CDC/invalidator lag and replication slot retained WAL | invalidation freshness; slot disk risk |
| DB pool wait time for fill pools | stampede and cold-cache pressure |
| `pg_stat_database` blks_hit ratio | DB's own cache health |

### Scaling notes

Scale the cache horizontally (more shards) for memory and throughput, and add replicas to make node loss a non-event for the database. Scale the *database's resilience to the cache* by bounding fill concurrency, coalescing, and keeping enough headroom for one cache shard to go cold. For very hot keys, a small in-process L1 cache (seconds of TTL) removes network hops entirely — and multiplies the invalidation problem by the number of app instances, so pair it with short TTLs or pub/sub invalidation ([Caching with Redis · Client-Side Caching](../redis-caching/topic.html?p=27-client-side-caching-pooling)).

## 9. Interview Questions

**Q: PostgreSQL already has a buffer cache. Why add Redis?**
A: The buffer cache removes disk I/O but not the rest of the query path: a connection and backend process, parsing and planning, executing joins and aggregates, visibility checks, and serialising rows. For expensive repeated reads that are already served from memory, the database is CPU- or connection-bound, and an external cache that stores the finished result saves all of that. An external cache also scales horizontally and cheaply. The trade is that the external cache is a separate copy that can be stale, while the buffer cache is always consistent. So I would check the buffer hit ratio and pg_stat_statements first, and cache expensive, high-reuse results rather than cheap lookups.

**Q: Explain the stale-set race in cache-aside?**
A: A reader misses the cache and reads the current row from the database, say version 16, and then is delayed before it writes to the cache. Meanwhile a writer commits version 17 and deletes the cache key. The delayed reader then sets version 16 into the cache. The delete already happened, so nothing removes the stale value, and it is served until the TTL expires. Delete-on-write alone doesn't prevent it; you bound it with a TTL and close it with version-conditional sets and tombstones or leases.

**Q: Why must cache invalidation happen after the transaction commits?**
A: If you delete the key inside the transaction, there is a window between the delete and the commit. A reader that misses in that window reads the database and, because the write hasn't committed, sees the old committed value and caches it. The delete then achieved nothing and the stale value lives for the TTL. Invalidating after commit, or deriving invalidations from the commit log via CDC, ensures any subsequent fill sees the new value.

**Q: What does TTL guarantee in a cache design?**
A: TTL bounds how long any entry can live, so it bounds the lifetime of staleness caused by anything your invalidation misses: races, lost deletes, bugs. That makes it a consistency contract, "this data may be at most N seconds stale", not just a memory-management setting. It only holds if nothing extends the TTL on stale data. Choose it per data class from the business's staleness tolerance, and use explicit invalidation to make the common case fresher than the bound.

**Q: Compare write-through and write-behind from the database's perspective?**
A: Write-through writes to the database synchronously and then updates the cache, so the database remains the system of record and every write pays full database latency; the cache just stays warm after writes. Write-behind acknowledges the write once it's in the cache and flushes to the database later, often batched, which absorbs write spikes and reduces database load. But the cache is temporarily the only copy, so a cache failure loses the unflushed writes, and database constraints are checked after the user was told success. Write-behind suits aggregatable, loss-tolerant data such as counters, not orders or payments.

**Q: What is a cache stampede and how do you protect the database from it?**
A: A stampede happens when a popular key expires or is invalidated and many concurrent requests miss at once, each issuing the same expensive query to the database. The database sees a burst of identical work that can exhaust connections and CPU. Protections are request coalescing so only one fill runs per key, probabilistic early refresh before expiry, serving the stale value while one request refreshes, and bounding database concurrency so excess requests wait or degrade rather than pile onto the database. TTL jitter prevents many keys expiring together.

**Q: How does reading from a replica on a cache miss cause long-lived staleness?**
A: After a write commits on the primary and the cache key is deleted, the next reader misses and reads from a replica. If the replica hasn't replayed the write yet, it returns the old value, which is then cached for the full TTL. So a replica lag of a few hundred milliseconds turns into minutes of staleness. Fixes include filling from the primary for recently written keys, version-guarded sets with tombstones that reject older versions, or delaying a second invalidation past typical lag.

**Q: Your cache hit ratio drops from 99% to 95%. Why might the database fall over? (Senior)**
A: The database sees the miss ratio, not the hit ratio, and that went from 1% to 5% — a fivefold increase in reads reaching the database. If the database was sized for the steady state with modest headroom, it saturates, fills get slower and start timing out, the cache can't refill, and client retries add even more load. It's a positive feedback loop. I'd size the database for a realistic degraded hit ratio, bound fill concurrency with coalescing and queue timeouts, serve stale values where acceptable, and shed low-priority traffic until the cache recovers.

**Q: Design cache invalidation for a table written by five services and a nightly batch job. (Senior)**
A: Application-level invalidation won't work reliably because every writer must remember to do it after commit and some, like ad-hoc SQL and batch jobs, won't. I'd derive invalidations from the database's commit log using logical decoding or Debezium, which emits only committed changes, in commit order, from every writer. An invalidator service maps row changes to cache keys and writes tombstones carrying the row version, and fills use a version-conditional set so stale fills are rejected. I'd rate-limit invalidations during the batch so the refill wave doesn't overload the database, monitor slot lag and cap retained WAL with max_slot_wal_keep_size, and keep TTLs as the backstop.

**Q: The Redis cluster is completely flushed at peak traffic. Walk through what happens and what should have been in place. (Senior)**
A: Every read misses, so database read load jumps by the inverse of the old miss ratio, easily 20 to 100 times. Without protection, the database saturates, fills time out, retries pile on, and the site goes down while the cache stays cold. What should be in place: single-flight fills so each key is loaded once, a small bounded pool for fills with short queue timeouts so the database runs at capacity rather than beyond it, stale or degraded responses for non-critical content, load shedding of low-priority traffic, and no automatic client retries on overload errors. Then warm the hottest keys first and ramp traffic back. Structurally, cache replicas and persistence reduce the chance of a total cold start, and game days verify the database's degraded capacity.

**Q: How do you handle a hot key that is also frequently updated? (Senior)**
A: Delete-on-write is dangerous for a hot key because every invalidation triggers a thundering herd of fills. I'd switch that key to update-in-place with a version-conditional set, so writers push the new value directly and older values can't overwrite newer ones. Reads go through a short-TTL in-process L1 cache to spread load across app instances rather than one cache shard, possibly with the key replicated under several suffixes. If the update rate is very high, I'd consider whether the displayed value can be slightly stale and refresh on a timer instead of on every write. The authoritative value for decisions still comes from the database.

**Q: Why was MySQL's query cache removed, and what does that teach about result caching?**
A: MySQL's query cache stored result sets keyed by exact query text and invalidated every cached result for a table on any write to that table. Under concurrent writes, invalidation was constant and serialised on a global lock, so it hurt throughput on busy servers and was deprecated in 5.7 and removed in 8.0. The lesson is that coarse invalidation inside the database doesn't scale; result caching works better outside the database, keyed by application concepts, with finer-grained invalidation and explicit staleness bounds.

## 10. Quick Revision & Cheat Sheet

| Topic | One-line rule |
| --- | --- |
| Buffer vs external cache | buffer = consistent, saves I/O; external = copy, saves the whole query |
| Miss ratio | the DB feels misses: 99% → 95% hits = 5× DB reads |
| Cache-aside | default; invalidate after commit; fill from primary after writes |
| Stale-set race | fix with row version + tombstone + conditional set (or leases) |
| TTL | the staleness contract; always set it |
| Write-behind | cache is truth for the flush window; counters only |
| Stampede | single-flight, early refresh, stale-while-revalidate, bounded fill pool |
| Penetration | negative cache, Bloom filter, validation |
| Hot key | L1 cache, versioned update-in-place, key replication |
| Avalanche | TTL jitter |
| Cache dies | coalesce → bound → serve stale → shed → warm |
| CDC invalidation | commit-ordered, never lost, covers all writers; costs a pipeline and a slot |

- A cached value may inform a display, never authorise a write.
- Invalidate after COMMIT, never inside the transaction.
- Every entry has a TTL that matches a stated staleness tolerance.
- The cache is part of the database's capacity plan; size for degraded hit ratios.
- Key-format changes are deploys that can take down the database.
- Replica lag leaks into caches as TTL-long staleness.
- Measure staleness by sampling, don't assume it.

## 11. Hands-On Exercises

1. **Buffer vs external.** Run `postgres:17` and `redis:7`. Create a `products` table with 1M rows and a 3-table join for the product page. Measure p50 latency of the join (warm buffers) vs a Redis GET of the serialized result, and look at `pg_stat_statements` for the join's CPU cost.
2. **Reproduce the stale-set race.** Write a script with a reader that misses, reads, sleeps 500 ms, then SETs; a writer that updates and DELs during the sleep. Confirm the stale value persists. Then add the version column, tombstone and Lua conditional set from §5 and confirm the stale SET is rejected.
3. **Invalidate-before-commit.** Move the DEL inside the transaction, add `pg_sleep(1)` before COMMIT, and show a concurrent reader caches the old value.
4. **Stampede.** Use `pgbench` or a small Go/Python load tool to send 500 concurrent requests for one key right after deleting it; count DB queries in `pg_stat_statements` with and without a `SET lock NX PX` single-flight.
5. **CDC invalidation.** Enable `wal_level = logical`, create a slot with `pg_create_logical_replication_slot('inval', 'test_decoding')`, update products, and read changes with `pg_logical_slot_get_changes`. Write a tiny consumer that turns each change into a Redis tombstone.

**Mini project — "Cache consistency harness".** Build a service with cache-aside over PostgreSQL and a harness that runs concurrent readers and writers for 10 minutes while randomly injecting pauses in fills, replica-lag fills, and dropped invalidations. Every second, sample 1,000 keys and compare cache version to DB version; report max and p99 staleness. Run it for: (a) DEL after commit + TTL, (b) versioned tombstones, (c) CDC invalidation. Then flush Redis mid-run and chart DB CPU and page latency with and without single-flight and a bounded fill pool.

## 12. Related Topics & Free Learning Resources

**This handbook:** [Ch 01 · Database Architecture](topic.html?p=01-database-architecture) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) · [Ch 09 · Database Replication](topic.html?p=09-replication) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) · [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns)

**SQL Handbook:** [Query Optimization](../sql/topic.html?p=21-query-optimization) · [Views](../sql/topic.html?p=31-views) (materialized views as an in-database cache)

**Caching with Redis (the Redis-depth companions):** [Cache-Aside](../redis-caching/topic.html?p=08-cache-aside) · [Read-Through & Write-Through](../redis-caching/topic.html?p=09-read-through-write-through) · [Write-Behind & Write-Around](../redis-caching/topic.html?p=10-write-behind-write-around) · [Cache Invalidation](../redis-caching/topic.html?p=12-cache-invalidation) · [Dual Write & CDC](../redis-caching/topic.html?p=14-dual-write-and-cdc) · [Cache Stampede](../redis-caching/topic.html?p=15-cache-stampede) · [Cache Penetration & Bloom Filters](../redis-caching/topic.html?p=16-cache-penetration-bloom) · [Hot Keys & Avalanche](../redis-caching/topic.html?p=17-hot-keys-avalanche)

**Other handbooks:** [System Design · Caching](../system-design/topic.html?p=12-caching) · [Kafka & RabbitMQ · Kafka Connect & CDC](../messaging/topic.html?p=25-kafka-connect-cdc)

- **Scaling Memcache at Facebook** — Nishtala et al., NSDI 2013 · *Advanced* · leases for stale sets and thundering herds, and invalidation driven from the database's commit log (mcsqueal). <https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf>
- **Caching Best Practices** — AWS · *Beginner* · cache-aside, write-through and TTL choices in a database context. <https://aws.amazon.com/caching/best-practices/>
- **PostgreSQL: The Cumulative Statistics System** — PostgreSQL docs · *Intermediate* · `pg_stat_database` and `pg_statio_*` for buffer hit ratios. <https://www.postgresql.org/docs/current/monitoring-stats.html>
- **PostgreSQL: Logical Decoding** — PostgreSQL docs · *Advanced* · the commit-ordered change stream behind CDC-driven invalidation. <https://www.postgresql.org/docs/current/logicaldecoding.html>
- **Optimal Probabilistic Cache Stampede Prevention** — Vattani, Chierichetti, Lowenstein (VLDB 2015) · *Advanced* · the XFetch early-refresh algorithm. <https://www.vldb.org/pvldb/vol8/p886-vattani.pdf>
- **MySQL 8.0: Retiring Support for the Query Cache** — MySQL Server Blog · *Intermediate* · why in-database result caching was removed. <https://dev.mysql.com/blog-archive/mysql-8-0-retiring-support-for-the-query-cache/>
- **Debezium PostgreSQL Connector** — Debezium docs · *Intermediate* · production CDC from PostgreSQL's WAL. <https://debezium.io/documentation/reference/stable/connectors/postgresql.html>

---

*Database Design Handbook — chapter 19.*
