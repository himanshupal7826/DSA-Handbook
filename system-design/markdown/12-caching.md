# 12 · Caching Strategies

> **In one line:** Put a copy of hot, expensive-to-produce data on a faster, closer tier — and pay for it with the hardest problem in computing: invalidation.

---

## 1. Overview

A **cache** is a small, fast store that holds a subset of data from a larger, slower source of truth so that repeat reads avoid the expensive path. The economics are brutal in your favor: an in-process read is ~100 ns, a Redis round-trip over the network is ~0.5–1 ms, a Postgres index lookup is ~1–10 ms, and a cold query that scans or joins can be 50–500 ms. Caching turns a 200 ms page into a 2 ms page and lets one database instance serve 100× the read traffic.

Caching exists because of two universal facts: access is **skewed** (a Zipfian 20% of keys serve 80% of traffic) and most workloads are **read-heavy** (often 10:1 to 1000:1 read:write). If every read hit the database, you would shard prematurely and burn money on IOPS to re-derive answers that have not changed.

The catch is Phil Karlton's law: *"There are only two hard things in computer science: cache invalidation and naming things."* A cache is a **second copy of the truth**, and every copy can drift. The entire discipline of caching is managing that drift — deciding how stale is acceptable, how to refresh, and how to avoid a stampede when a hot entry expires.

Real example: Facebook's **memcache** tier fronts MySQL for the social graph. It serves billions of reads per second at single-digit-millisecond latency, and their published architecture is essentially a catalog of solutions to the drift and stampede problems (leases, cold-cluster warmup, regional invalidation).

## 2. Core Concepts

- **Cache hit / miss / hit ratio** — the fraction of reads served from cache. Hit ratio is *the* number that governs everything; going from 90% to 99% cuts origin load by 10×. Below ~80% a cache often costs more (extra hop + memory) than it saves.
- **Source of truth vs. copy** — the database is authoritative; the cache is a disposable, reconstructible copy. Never let application correctness depend on a value being present.
- **TTL (time-to-live)** — an expiry stamp that bounds staleness. TTL is your primary invalidation mechanism because it is self-healing: even if an explicit delete is lost, the entry is wrong for at most TTL seconds.
- **Eviction** — when memory is full, choose a victim: **LRU** (least recently used), **LFU** (least frequently used), or pure **TTL/random**. Eviction is about *space*; TTL is about *freshness* — different problems.
- **Read pattern** — where the miss-handling logic lives: **cache-aside** (app orchestrates) vs. **read-through** (cache library fetches for you).
- **Write pattern** — how writes propagate: **write-through**, **write-back**, **write-around**. This decides your consistency and durability profile.
- **Invalidation** — actively evicting or updating stale entries on writes. The hardest part; delete-on-write is safer than update-on-write.
- **Cache stampede / thundering herd** — many concurrent misses on the same hot key slam the origin at once. Solved with locks, request coalescing, and stale-while-revalidate.
- **Hot key** — a single key so popular it saturates one shard or one Redis node's CPU/NIC. A distribution problem, not a capacity problem.
- **Negative caching** — caching "not found" to stop repeated lookups for absent keys (and to blunt certain DoS patterns).

## 3. Architecture

Caches form a **layered hierarchy** — each layer is faster, smaller, and closer to the user than the one behind it. A request falls through the layers until something answers; the goal is to answer as early (as far left) as possible.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#64748b">Cache layers — answer as far left as possible</text>

  <rect x="20" y="60" width="120" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="90" text-anchor="middle" fill="#1e293b">Browser</text>
  <text x="80" y="108" text-anchor="middle" fill="#64748b">HTTP cache</text>

  <rect x="180" y="60" width="120" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="240" y="90" text-anchor="middle" fill="#1e293b">CDN / Edge</text>
  <text x="240" y="108" text-anchor="middle" fill="#64748b">static + micro</text>

  <rect x="340" y="60" width="120" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="400" y="86" text-anchor="middle" fill="#1e293b">App tier</text>
  <text x="400" y="103" text-anchor="middle" fill="#64748b">local (LRU)</text>
  <text x="400" y="120" text-anchor="middle" fill="#64748b">+ Redis</text>

  <rect x="500" y="60" width="120" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="560" y="90" text-anchor="middle" fill="#1e293b">DB cache</text>
  <text x="560" y="108" text-anchor="middle" fill="#64748b">buffer pool</text>

  <rect x="660" y="60" width="80" height="70" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="700" y="90" text-anchor="middle" fill="#1e293b">Origin</text>
  <text x="700" y="108" text-anchor="middle" fill="#64748b">DB/SoT</text>

  <line x1="140" y1="95" x2="178" y2="95" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="300" y1="95" x2="338" y2="95" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="460" y1="95" x2="498" y2="95" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="620" y1="95" x2="658" y2="95" stroke="#475569" marker-end="url(#ar)"/>

  <text x="80" y="165" text-anchor="middle" fill="#64748b">~0 ms</text>
  <text x="240" y="165" text-anchor="middle" fill="#64748b">~10–30 ms</text>
  <text x="400" y="165" text-anchor="middle" fill="#64748b">local ~100 ns</text>
  <text x="400" y="182" text-anchor="middle" fill="#64748b">Redis ~0.5 ms</text>
  <text x="560" y="165" text-anchor="middle" fill="#64748b">~1 ms</text>
  <text x="700" y="165" text-anchor="middle" fill="#64748b">10–500 ms</text>

  <rect x="20" y="215" width="720" height="60" rx="8" fill="#fff" stroke="#cbd5e1"/>
  <text x="380" y="240" text-anchor="middle" fill="#1e293b">Hit ratio compounds: each layer only sees the misses of the layer to its left.</text>
  <text x="380" y="260" text-anchor="middle" fill="#64748b">90% browser × 90% CDN × 95% app cache ⇒ origin sees ~0.5% of raw reads.</text>
</svg>
```

Two orthogonal choices define a cache tier: **topology** and **strategy**. Topology is *local* (in-process, per-node, zero network hop, but N copies to invalidate and cold on deploy) vs. *distributed/remote* (Redis/memcached — one shared copy, survives deploys, but adds a network hop and a new failure domain). The strong default at scale is a **two-level cache**: a tiny local LRU (near-instant, absorbs the hottest keys) backed by a shared Redis (large, coherent). Strategy is the read/write pattern covered next.

## 4. How It Works

The canonical flow is **cache-aside** (a.k.a. lazy loading) — the pattern behind ~90% of production caches. The application, not the cache, owns the orchestration.

```text
READ (cache-aside):
  1. v = cache.get(key)
  2. if v != null:            # HIT
        return v
  3. v = db.query(key)        # MISS → go to source of truth
  4. if v == null:
        cache.set(key, TOMBSTONE, short_ttl)   # negative cache
        return null
  5. cache.set(key, v, ttl + jitter)           # populate
  6. return v

WRITE (with delete-on-write invalidation):
  1. db.update(key, newValue)  # write source of truth FIRST
  2. cache.delete(key)         # evict, do NOT update — let next read re-fill
```

Step order matters. On write you update the DB **first**, then invalidate the cache. If you invalidate first, a concurrent read can miss, load the *old* DB value, and repopulate the cache with stale data right after your write — a classic race. Even the DB-first order has a narrow race window; **delete (not update)** the cache entry and add a short TTL so any lost delete self-heals.

Key design decisions embedded in this flow:
1. **Delete, don't update, on write.** Updating requires you to reproduce the exact serialized value the read path expects (including derived/joined fields) and invites two concurrent writers leaving the cache inconsistent with the DB. Deleting is idempotent and always correct.
2. **Add jitter to every TTL.** `ttl + rand(0, 0.1*ttl)` desynchronizes expirations so a batch of keys written together does not all expire in the same second and stampede.
3. **Cache negatives briefly.** Without it, a flood of requests for non-existent keys (typos, scanners) all fall through to the DB every time.

## 5. Key Components / Deep Dive

### Read patterns: cache-aside vs. read-through
**Cache-aside** keeps caching logic in the application: flexible, cache-agnostic, resilient (a cache outage just means more DB load, not errors). **Read-through** hides the miss behind the cache client — the app calls `cache.get`, and the cache library synchronously loads from the DB on a miss and stores it. Read-through centralizes logic and pairs naturally with request coalescing, but couples you to a cache that understands your data source. Cache-aside is the pragmatic default; read-through shines in library/framework caches (e.g., a loading cache like Caffeine).

### Write patterns
- **Write-through** — write to cache and DB synchronously in one operation. Cache is always consistent with the DB; write latency is the sum of both. Good when you read what you just wrote.
- **Write-back (write-behind)** — write to cache immediately, flush to DB asynchronously (batched). Lowest write latency and coalesces bursts, but **risks data loss** if the cache dies before flushing. Used for high-write, loss-tolerant data (view counts, metrics).
- **Write-around** — write straight to the DB, bypassing the cache; the entry is only cached on a later read. Avoids polluting the cache with write-once/read-never data, at the cost of a guaranteed miss on the first read after a write.

### Eviction policies
- **LRU** — evict the least-recently-touched. Great for temporal locality; cheap to approximate (Redis uses sampled/approximate LRU, not a true linked list, to save memory). Vulnerable to a scan that touches everything once and flushes the working set.
- **LFU** — evict the least-*frequently* used. Keeps genuinely hot keys through scans, but needs decay so yesterday's hot key eventually ages out (Redis `LFU` uses a probabilistic counter with time decay).
- **TTL / expiry** — orthogonal to LRU/LFU; bounds freshness, not memory. **Random** eviction is surprisingly competitive and O(1).
- Redis `maxmemory-policy`: `allkeys-lru`, `allkeys-lfu`, `volatile-ttl`, `noeviction` (errors on write when full — dangerous for a pure cache).

### Cache stampede / thundering herd
When a hot key expires, thousands of concurrent readers all miss and hit the origin simultaneously, which can topple the DB and cause a cascading outage. Three defenses, often combined:
- **Locking / mutex** — the first misser acquires a per-key lock (`SET key val NX EX`), recomputes, and populates; others briefly wait or serve stale. Facebook's **leases** are this idea: memcache hands one client a token to fill the key and tells the rest to back off.
- **Request coalescing (single-flight)** — within one process, collapse N concurrent misses for the same key into a single origin call and fan the result back out.
- **Stale-while-revalidate** — serve the slightly-expired value immediately while one background task refreshes it. Users never wait; the origin sees exactly one refresh. This is the best UX default for content that tolerates seconds of staleness.

### Hot keys
A single key (a celebrity's profile, a flash-sale item) can exceed one Redis node's ~100k–200k ops/s or its NIC bandwidth. Distribute it: **replicate** the key across N nodes and read a random replica; append a random suffix (`key:0..N`) client-side; or promote it to a **local in-process cache** so it never touches the network. Detection: `redis-cli --hotkeys` or per-key monitoring.

### Consistency
A cache trades strong consistency for latency. You choose the tolerable window: TTL bounds worst-case staleness; delete-on-write shrinks the common case to milliseconds; write-through gives read-your-writes at write-latency cost. For cross-region caches, invalidate globally on write (Facebook broadcasts deletes to remote regions). Accept that a cache is **eventually consistent** — design features (and product copy) around that, don't fight it.

## 6. Trade-offs

| Pattern | Pros | Cons |
|---|---|---|
| **Cache-aside** | Simple, cache-agnostic, resilient to cache outage, only caches what's read | App owns logic; first read always misses; write/read race window |
| **Read-through** | Centralized load logic, clean app code, easy coalescing | Couples cache to data source; cold-start latency on miss |
| **Write-through** | Cache always fresh; read-your-writes | Higher write latency; caches data that may never be read |
| **Write-back** | Lowest write latency; batches/coalesces writes | Data loss on cache failure; complex; harder to reason about |
| **Write-around** | No cache pollution from write-heavy data | Guaranteed miss on first post-write read |
| **Local cache** | ~100 ns, no network, no extra infra | N copies to invalidate; cold on deploy; per-node memory |
| **Distributed (Redis)** | One coherent copy, large, survives deploys | Network hop; new failure domain; hot-key risk |

The meta-trade-off is **freshness vs. load vs. latency**: a longer TTL cuts origin load and tail latency but widens the staleness window. Write-back buys write throughput by risking durability. Local caching buys nanoseconds by giving up coherence. There is no free lunch — pick the axis your product can least afford to lose and optimize the others.

## 7. When to Use / When to Avoid

**Use caching when:**
- Reads dominate writes (≥5:1) and access is skewed toward a hot set.
- The data is expensive to compute/fetch (joins, aggregations, fan-out, external APIs).
- Bounded staleness is acceptable (seconds to minutes of "wrong" is fine).
- You need to protect a fragile origin from read spikes.

**Avoid / be cautious when:**
- Data is written far more than read (cache churn, near-zero hit ratio) — write-around or no cache.
- Strong consistency / read-your-writes is mandatory and unbudgeted (financial ledgers, auth token revocation) — or use write-through with care.
- The dataset is tiny and already in the DB buffer pool (you'd add a hop for nothing).
- Per-request unique data (no reuse) — hit ratio ≈ 0.
- You cannot define a correct invalidation story — a wrong cache is worse than a slow DB.

## 8. Scaling & Production Best Practices

- **Target and monitor hit ratio.** Aim ≥90% for a value-add cache; below ~80%, question whether it earns its hop. Alert on hit-ratio drops (they precede origin overload).
- **Right-size memory to the working set.** If eviction rate is high and hit ratio low, your cache is smaller than the hot set — scale memory before adding nodes.
- **Always set a `maxmemory` + eviction policy.** An unbounded cache OOM-kills the process; `noeviction` turns a full cache into a write-outage.
- **TTL everything, with jitter.** No key lives forever; jitter prevents synchronized expiry.
- **Two-level cache at scale:** small local LRU (Caffeine/Guava) in front of shared Redis absorbs the hottest keys and survives brief Redis blips.
- **Shard/cluster Redis** with consistent hashing (Redis Cluster's 16384 hash slots) so adding a node reshuffles minimal keys — see **Consistent Hashing**.
- **Version your cache keys** (`user:v3:123`) so a schema change is a global invalidation by prefix bump, not a flush.
- **Warm the cache** after deploys/failovers; a cold cache directs 100% of reads to the origin and can cause a "cold cluster" outage (Facebook explicitly warms new clusters).
- **Compress large values** and cap value size; a few MB values wreck Redis latency for everyone on the node.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| **Cache stampede** on hot-key expiry | Origin overload, cascading outage | Per-key lock/lease, single-flight, stale-while-revalidate, TTL jitter |
| **Cold cache** (deploy/failover/flush) | 100% miss → origin melts | Gradual rollout, cache warming, request coalescing, rate-limit origin |
| **Hot key** saturates one node | One shard at 100% CPU/NIC, tail latency | Replicate key across nodes, local cache, key suffix fan-out |
| **Stale data** from lost/missed invalidation | Users see wrong data | Short TTL as backstop, delete-on-write, key versioning |
| **Cache-penetration** (floods for absent keys) | Every request hits DB | Negative caching, Bloom filter of existing keys |
| **Cache avalanche** (mass simultaneous expiry) | Origin spike | TTL jitter, staggered warmup, layered TTLs |
| **Redis node down** | Miss storm / errors | Cache-aside degrades to DB reads; replicas + failover; circuit-break the origin |
| **Write-back data loss** | Recent writes gone on crash | AOF/persistence, replicate before ack, or don't use write-back for durable data |

## 10. Monitoring & Metrics

- **Hit ratio** (per cache tier and per key-prefix) — the north-star metric; alert on sustained drops.
- **Eviction rate & memory usage / fragmentation ratio** — rising evictions ⇒ undersized cache.
- **p50 / p99 / p999 GET/SET latency** — tail latency reveals hot keys and big values.
- **Origin QPS and DB load** — the number the cache is supposed to suppress; watch for miss-driven spikes.
- **Key-space stats** — hot-key detection (`--hotkeys`), key count, expiry rate, TTL distribution.
- **Connection count & command errors / timeouts** — connection storms and `OOM command not allowed` are early warnings.
- **Stampede signals** — origin request bursts correlated with cache misses on a single key.
- **Replication lag** (if using replicas for reads) — stale reads from lagging replicas.

## 11. Common Mistakes

1. ⚠️ **No TTL** — entries live forever, silently stale, and memory grows unbounded.
2. ⚠️ **Update-on-write instead of delete-on-write** — invites write/write and read/write races that corrupt the cache.
3. ⚠️ **Invalidate-then-write ordering** — a concurrent read repopulates the old value; always write DB first, then delete cache.
4. ⚠️ **Synchronized TTLs** — a batch of keys expiring in the same second causes an avalanche; forgetting jitter.
5. ⚠️ **Treating the cache as the source of truth** — building correctness on data that can vanish on eviction or restart.
6. ⚠️ **Caching per-user data under a shared key** — leaking one user's data to another (a security bug, not just a cache bug).
7. ⚠️ **No stampede protection on hot keys** — the first expiry becomes a self-inflicted DDoS on the DB.
8. ⚠️ **`noeviction` on a pure cache** — turns a full cache into a hard write-failure instead of dropping cold keys.

## 12. Interview Questions

**Q: Walk me through cache-aside on a read and a write. Why that order on writes?**
A: Read: check cache; on miss, load from DB, populate cache with a jittered TTL, return. Write: update the DB **first**, then **delete** (not update) the cache key. DB-first-then-delete minimizes the window where a concurrent read can repopulate stale data; delete (vs. update) is idempotent and avoids reproducing derived fields or racing two writers.

**Q: Cache-aside vs. read-through vs. write-through vs. write-back — when each?**
A: Cache-aside is the resilient default (app-owned, survives cache outages). Read-through centralizes load logic in the cache library. Write-through keeps the cache consistent at the cost of write latency (read-your-writes). Write-back gives the lowest write latency and batches writes but risks data loss — reserve it for high-volume, loss-tolerant data like counters.

**Q: What's a cache stampede and how do you prevent it?**
A: Many concurrent readers miss the same expired hot key and all hit the origin at once, potentially toppling it. Prevent with a per-key lock/lease (one filler, others back off), request coalescing/single-flight, stale-while-revalidate (serve stale + async refresh), and TTL jitter to avoid synchronized expiry.

**Q: LRU vs. LFU — when does LRU fail?**
A: LRU fails on scans: a one-time sweep touches every key once and evicts the true working set. LFU keeps genuinely frequent keys through scans but needs time decay so a formerly-hot key eventually ages out. Redis approximates both to save the memory a true LRU list would cost.

**Q: How do you keep a cache consistent with the database?**
A: You don't get strong consistency for free; you bound staleness. TTL caps the worst case, delete-on-write shrinks the common case to milliseconds, write-through gives read-your-writes. Accept eventual consistency and design the product around the window; for cross-region, broadcast invalidations.

**Q (senior): You have a single hot key doing 500k reads/s that no Redis node can serve. What do you do?**
A: It's a distribution problem. Replicate the key across N nodes and read a random replica (or client-side key suffixing `key:0..N`), and/or promote it to an in-process local cache so it never crosses the network. Detect with `--hotkeys`/per-key metrics. Also question whether a longer TTL + stale-while-revalidate collapses the origin refresh to ~1/s.

**Q (senior): A deploy flushed your cache and the database is now falling over. Root cause and prevention?**
A: Cold-cache thundering herd — 100% miss ratio directs all reads to the origin. Prevent with gradual rollout, cache warming before cutover, request coalescing/single-flight to collapse duplicate misses, and an origin rate-limiter/circuit breaker so the DB sheds load instead of dying. This is exactly why Facebook warms cold clusters.

**Q (senior): Under what write pattern can you lose acknowledged data, and how do you bound the risk?**
A: Write-back — the cache acks the write before the async DB flush; a crash loses in-flight writes. Bound it with persistence (Redis AOF), replicating to a follower before ack, capping the flush interval/queue depth, and only using write-back for data whose loss is tolerable. If durability matters, use write-through.

**Q (senior): Redis is down. What happens to your service, and what should happen?**
A: With cache-aside, reads fall through to the DB — correctness is preserved but the DB sees full load and may buckle. The right behavior: local L1 cache absorbs the hottest keys, a circuit breaker/load shedder protects the DB, and you degrade gracefully (serve stale/partial). The failure should be a latency event, not an outage.

**Q (senior): How do you invalidate a value derived from many source rows (e.g., a computed feed or aggregate)?**
A: You can't cheaply pinpoint it, so use one of: short TTL + stale-while-revalidate (accept bounded staleness), event-driven invalidation (a change stream/CDC publishes affected keys), or key versioning where any contributing write bumps a version namespace. Choose based on how fresh the aggregate must be vs. recompute cost.

**Q (senior): How would you detect that a cache is hurting rather than helping?**
A: Low hit ratio (<~80%) with high eviction rate means the working set exceeds memory or has no reuse — you're paying an extra hop plus memory for little benefit. Also watch for added p99 from the network hop exceeding the origin time saved. Fix by resizing, changing what you cache (write-around), or removing the tier.

## 13. Alternatives & Related

- **Consistent Hashing** — how a distributed cache spreads keys and minimizes reshuffling when nodes change.
- **Load Balancing** — CDNs and edge caches are load-shedding caches at the network edge.
- **CAP & Consistency** — a cache is an availability/latency-for-consistency trade; the same theory applies.
- **Rate Limiting** — often implemented on the same Redis; protects the origin the cache is shielding.
- **Database Scaling** — read replicas are a form of caching; caching often defers or replaces sharding.
- **Message Queues / CDC** — event-driven invalidation streams cache-delete events on writes.

## 14. Cheat Sheet

> [!TIP]
> **Caching in one screen.**
> - **Default:** cache-aside + delete-on-write + jittered TTL. On write: **DB first, then delete key.**
> - **Read patterns:** cache-aside (app-owned, resilient) · read-through (cache-owned).
> - **Write patterns:** write-through (consistent, slow) · write-back (fast, lossy) · write-around (no pollution).
> - **Eviction (space):** LRU (locality) · LFU (frequency + decay) · random. **TTL (freshness)** is separate.
> - **Stampede fixes:** per-key lock/lease · single-flight · stale-while-revalidate · TTL jitter.
> - **Hot key:** replicate across nodes / local L1 cache — it's distribution, not capacity.
> - **North star:** hit ratio (≥90%). Below ~80%, the cache may cost more than it saves.
> - **Never:** treat cache as source of truth · cache per-user data under shared keys · skip TTL.

**References:** Redis documentation (eviction, cluster, keyspace) · "Scaling Memcache at Facebook" (Nishtala et al., NSDI 2013) · AWS ElastiCache best practices · DDIA ch. 1 & 5

---
*System Design Handbook — topic 12.*
