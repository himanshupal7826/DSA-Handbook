# 32 · Design: URL Shortener (TinyURL)

> **In one line:** Turn a long URL into a 7-character key and redirect billions of clicks a day — a read-heavy KV problem where key generation and caching are the whole game.

---

## 1. Problem & Requirements

A URL shortener maps a long URL to a short, unique key (`https://tinyurl.com/aZ3xK9`) and redirects any request for that key back to the original. It is the canonical "small surface, deep internals" interview problem: the API is two endpoints, but the design forces you to reason about key generation, collision handling, read scaling, and analytics.

**Functional**
- **Shorten**: given a long URL, return a short URL. Optionally accept a **custom alias** and an **expiration** time.
- **Redirect**: given a short key, redirect (HTTP 301/302) to the long URL.
- **Analytics**: report click counts, geography, referrer per link (not on the hot path).
- Keys are non-guessable *enough* to discourage enumeration but need not be cryptographically secret.

**Non-functional**
- **Scale**: ~100M new URLs/day; **read:write ≈ 100:1** (links are created once, resolved many times).
- **Latency**: redirect p99 < **50 ms** — it sits in front of a human click. Creation can be slower (< 200 ms).
- **Availability**: 99.99% on the redirect path. A dead redirector breaks every short link in existence — this is the tier-0 path.
- **Durability**: a mapping must never be lost or silently remapped. Losing a key→URL row breaks a link forever.
- **Consistency**: read-your-writes on create is nice but not required; eventual consistency on redirect is fine (a link resolving 1s after creation is acceptable).

## 2. Capacity Estimation

```text
WRITES
  New URLs/day        = 100,000,000
  Write QPS (avg)     = 100M / 86,400s      ≈ 1,160  writes/s
  Write QPS (peak 3×) ≈ 3,500  writes/s

READS (redirects), 100:1 ratio
  Redirects/day       = 10,000,000,000  (10B)
  Read QPS (avg)      = 10B / 86,400s        ≈ 115,000 reads/s
  Read QPS (peak 3×)  ≈ 350,000 reads/s      <-- this number dictates the design

KEY SPACE
  base62 (a–z A–Z 0–9), length 7 = 62^7      ≈ 3.5 trillion keys
  At 100M/day that is 3.5e12 / 1e8 = 35,000 days ≈ 95 years  -> 7 chars is plenty
  (length 6 = 56B keys, ~1.9 years of runway — too short.)

STORAGE (per row: key 7B, long URL ~500B, metadata ~100B ≈ 620B, round to ~1KB w/ overhead)
  Per day   = 100M * 1KB   = 100 GB/day
  Per year  = 100 GB * 365 ≈ 36.5 TB/year
  5-year    ≈ 180 TB          -> sharded KV store, not a single node

BANDWIDTH
  Redirect response is a tiny 3xx (~500B headers). 115K rps * 500B ≈ 57 MB/s egress — trivial.
  The cost is request rate (CPU/lookups), not bytes.

CACHE (80/20: 20% of links drive ~80% of reads)
  Hot set ≈ 20% of one day's reads ~ working set of a few hundred GB of keys.
  Cache the top-N hottest keys: e.g. 100M hot mappings * ~120B ≈ 12 GB -> fits in Redis cluster.
```

**Takeaways:** the system is overwhelmingly read-dominated (~350K peak read QPS). That single fact means: cache-first reads, read replicas, a CDN/edge tier, and *never* put writes (analytics) on the redirect path.

## 3. API Design

```http
POST /api/v1/shorten
  Body: { "longUrl": "https://example.com/very/long/path?x=1",
          "customAlias": "my-sale",     // optional
          "expiresAt": "2027-01-01T00:00:00Z" }  // optional
  201 Created
  { "shortUrl": "https://tiny.url/aZ3xK9", "key": "aZ3xK9", "expiresAt": null }
  409 Conflict   -> customAlias already taken

GET /{key}
  302 Found
  Location: https://example.com/very/long/path?x=1
  Cache-Control: private, max-age=0    // 302 path (trackable)
  404 Not Found  -> unknown/expired key
  410 Gone       -> key existed but expired

GET /api/v1/analytics/{key}?from=..&to=..
  200 OK
  { "key": "aZ3xK9", "clicks": 48213, "byCountry": {...}, "byReferrer": {...} }

DELETE /api/v1/links/{key}    // owner-authenticated
  204 No Content
```

Redirect is a bare `GET /{key}` (no `/api` prefix) so it can be served straight from the edge with the minimum of routing.

## 4. Data Model

The access pattern is a pure point lookup by primary key (`key → longUrl`). That is textbook **KV / wide-column** territory — DynamoDB, Cassandra, or a Redis-fronted sharded store. A relational DB works but you gain nothing from joins here and pay for it at 350K QPS.

```text
Table: urls   (partition key = short_key)   -- read-optimized KV
  short_key     STRING  (PK)   -- 'aZ3xK9'
  long_url      STRING         -- up to ~2KB
  owner_id      STRING         -- nullable (anonymous links)
  created_at    TIMESTAMP
  expires_at    TIMESTAMP      -- nullable; TTL index drives auto-purge
  is_custom     BOOL

Table: click_events   (append-only, time-series; e.g. Cassandra / ClickHouse)
  short_key     STRING
  ts            TIMESTAMP
  country       STRING
  referrer      STRING
  -- rolled up asynchronously into counters
```

**Datastore choice:** DynamoDB/Cassandra shard by `short_key` (hash partitioning), giving even key distribution and single-digit-ms point reads. Use the store's native **TTL** to expire rows automatically instead of a cleanup cron.

## 5. High-Level Design

Two independent paths meet at the datastore: a low-QPS **write path** (create) and a very-high-QPS **read path** (redirect). The read path is fronted by a CDN and a Redis cache so the vast majority of redirects never touch the database. A **Key Generation Service (KGS)** hands out unique keys so the write path never has to retry on collision.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="390" y="20" text-anchor="middle" fill="#64748b">Redirect path (350K QPS) is cache-first; write path (3.5K QPS) uses a KGS</text>

  <!-- client -->
  <rect x="20" y="150" width="90" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="65" y="178" text-anchor="middle" fill="#1e293b">Client</text>

  <!-- CDN / edge -->
  <rect x="150" y="150" width="90" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="195" y="172" text-anchor="middle" fill="#1e293b">CDN /</text>
  <text x="195" y="188" text-anchor="middle" fill="#1e293b">Edge</text>

  <!-- LB -->
  <rect x="280" y="150" width="90" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="325" y="178" text-anchor="middle" fill="#1e293b">Load Bal.</text>

  <!-- Redirect service -->
  <rect x="410" y="90" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="470" y="112" text-anchor="middle" fill="#1e293b">Redirect</text>
  <text x="470" y="128" text-anchor="middle" fill="#1e293b">Service</text>

  <!-- Write service -->
  <rect x="410" y="210" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="470" y="232" text-anchor="middle" fill="#1e293b">Shorten</text>
  <text x="470" y="248" text-anchor="middle" fill="#1e293b">Service</text>

  <!-- KGS -->
  <rect x="410" y="290" width="120" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="470" y="312" text-anchor="middle" fill="#1e293b">Key Gen</text>
  <text x="470" y="328" text-anchor="middle" fill="#1e293b">Service (KGS)</text>

  <!-- cache -->
  <rect x="590" y="80" width="110" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="645" y="102" text-anchor="middle" fill="#1e293b">Redis Cache</text>
  <text x="645" y="118" text-anchor="middle" fill="#64748b">hot keys</text>

  <!-- DB -->
  <rect x="590" y="180" width="110" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="645" y="204" text-anchor="middle" fill="#1e293b">Sharded KV</text>
  <text x="645" y="220" text-anchor="middle" fill="#64748b">Dynamo/Cassandra</text>

  <!-- queue + analytics -->
  <rect x="590" y="290" width="110" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="645" y="312" text-anchor="middle" fill="#1e293b">Kafka →</text>
  <text x="645" y="328" text-anchor="middle" fill="#1e293b">Analytics</text>

  <line x1="110" y1="173" x2="148" y2="173" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="240" y1="173" x2="278" y2="173" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="370" y1="165" x2="408" y2="120" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="370" y1="182" x2="408" y2="228" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="530" y1="105" x2="588" y2="103" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="645" y1="126" x2="645" y2="178" stroke="#475569" marker-end="url(#ar)" stroke-dasharray="4 3"/>
  <text x="700" y="150" fill="#64748b" font-size="11">miss</text>
  <line x1="530" y1="228" x2="588" y2="210" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="530" y1="315" x2="588" y2="313" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="470" y1="136" x2="470" y2="208" stroke="#475569" marker-end="url(#ar)" stroke-dasharray="4 3"/>
  <text x="486" y="175" fill="#64748b" font-size="11">click event</text>
</svg>
```

**Create flow:** client → LB → Shorten Service → grab a pre-generated key from KGS → write `key→url` row → return short URL. **Redirect flow:** client → CDN (edge cache) → LB → Redirect Service → Redis (hit ≈ 90%+) → on miss, KV store → issue 302 → asynchronously emit a click event to Kafka.

## 6. Deep Dive

### 6.1 Key generation: counter+base62 vs hash vs KGS

This is the crux. Three approaches:

| Approach | How | Pros | Cons |
|---|---|---|---|
| **Hash(url)[:7]** | MD5/SHA the URL, take first 7 base62 chars | Stateless; same URL → same key (dedup) | **Collisions** need a read-before-write check + retry; extra DB round trip on every create |
| **Counter → base62** | Global auto-increment ID, base62-encode it | Zero collisions, compact, no lookup | Keys are **sequential/guessable** (enumeration); needs a distributed counter |
| **Key Generation Service (KGS)** | Pre-generate a table of unused keys offline; hand them out in blocks | No collision check at write time; keys can be randomized; write path is a single INSERT | Extra service + must dedup its own generation; key exhaustion tracking |

**Recommended: KGS.** A background job base62-encodes a counter *and* stores keys in an `unused_keys` table. Each Shorten Service instance leases a **block** (e.g. 1,000 keys) into memory and hands them out with zero coordination. This removes the collision check from the hot write path entirely and lets you inject randomness so keys aren't trivially enumerable.

```text
KGS lease protocol (per app instance):
  1. Instance A: UPDATE unused_keys SET status='leased', owner='A' WHERE status='free' LIMIT 1000
  2. Keys held in A's memory; served one per create, O(1), no network hop
  3. On restart, unflushed leased keys are "lost" — fine, keyspace is 3.5T, we can waste some
  4. KGS refills 'free' pool when it drops below a watermark
```

The **counter itself** (for KGS generation) must be distributed-safe: a single auto-increment is a SPOF and a bottleneck. Use ranged allocation — a Zookeeper/etcd or a DB `counters` row that hands out ranges of 1M ("give me 60,000,000–61,000,000"), so each generator works its own range lock-free. (See **Distributed ID Generation / Snowflake** as a sibling technique.)

### 6.2 Collision handling

With KGS, the only place collisions can occur is **custom aliases** and KGS's own generation. For custom aliases, do a conditional write: `INSERT ... IF NOT EXISTS` (DynamoDB condition expression / Cassandra LWT). If it fails → 409. Never do "SELECT then INSERT" — that is a race under concurrency; two users can both pass the SELECT. Push atomicity into the store.

### 6.3 Redirect path: 301 vs 302

| Code | Meaning | Effect | Use when |
|---|---|---|---|
| **301 Moved Permanently** | Browser + proxies **cache** the redirect | Fewer requests hit your service (great for load); **you lose click tracking** for cached hits | Max scale, no per-click analytics needed |
| **302 Found** | Temporary; **not cached** by default | Every click hits you → accurate analytics, ability to change/expire the target | You need analytics, expiry, or dynamic targets |

Most commercial shorteners use **302** precisely because analytics is the product. You trade some load (fully mitigated by Redis + CDN) for the ability to count every click and to expire/rotate links. If a link is truly immutable and you don't care about clicks, 301 is cheaper.

### 6.4 Read scaling & caching

At 350K peak read QPS, the DB cannot be the front line. Layers:
1. **CDN/edge** — for the hottest links, cache the 302 at the edge for a few seconds (bounded staleness). Kills a huge fraction of origin traffic.
2. **Redis cluster** — LRU cache of `key→url`, ~90%+ hit rate given the 80/20 skew. A hit is a single ~1ms in-memory lookup.
3. **KV store** — only cache misses land here; replicas absorb the residual.

Cache warming isn't needed — links get hot organically. Set a modest TTL (e.g. 24h) so expired/deleted links flush out. On delete/expire, **explicitly invalidate** the Redis key to avoid serving a dead link.

### 6.5 Analytics off the hot path

The redirect must **never** block on a write. On each 302, the Redirect Service fires a fire-and-forget event (`key, ts, ip→country, referrer`) to **Kafka**. A stream processor rolls these into counters (per-key, per-day) in a time-series store (ClickHouse/Cassandra). If Kafka is down, the redirect still succeeds — analytics is best-effort, redirects are tier-0.

## 7. Bottlenecks & Scaling

- **Hot key (viral link):** one key can spike to 100K+ QPS alone. The Redis shard holding it becomes hot. Mitigate with **CDN edge caching** of that 302 and/or client-side replication of the hot key across cache nodes. This is the classic celebrity/hot-key problem.
- **KV store hotspots:** hashing by `short_key` gives uniform distribution, so no natural hotspots — the only heat is at the cache layer, which is easier to spread.
- **Global counter:** avoid a single counter. Ranged allocation (1M-sized blocks per generator) removes contention.
- **Write amplification from analytics:** decouple with Kafka; batch rollups.
- **Storage growth:** 36 TB/yr. Use TTL to auto-purge expired links; tier cold links to cheaper storage.
- **Geo-latency:** a single-region redirector adds cross-ocean RTT. Deploy the read path (cache + read replicas) **multi-region** with the KV store replicated; writes can stay in a home region.

## 8. Failure Scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Redis cache down | Read QPS slams the KV store | Multi-node cluster; DB has read replicas sized for miss storm; request coalescing (single-flight) so one miss populates cache for all |
| KV store shard down | Links on that shard unresolvable | Replication factor ≥ 3, automatic failover; keys hashed so blast radius is 1/N of links |
| KGS pool exhausted | Cannot create new links | Alert on `free` watermark; auto-refill job; large pre-generated buffer |
| Hot/viral key | One cache shard saturated | CDN edge caching of the 302; hot-key replication across cache nodes |
| Kafka (analytics) down | Click counts lost | Redirect still succeeds (best-effort analytics); buffer events locally, replay |
| Duplicate custom alias race | Two users grab same alias | Conditional `IF NOT EXISTS` write pushes atomicity to the store → one gets 409 |
| Region outage | Redirects fail for that region | Multi-region read path with health-based DNS/anycast failover |

## 9. Trade-offs & Alternatives

- **301 vs 302:** we chose 302 to keep analytics and expiry; 301 would cut load further but blind us to clicks. At 10× scale, still 302 + heavier CDN caching (short TTL) rather than switching to 301.
- **KGS vs hash:** KGS avoids the read-before-write collision check that hashing imposes on *every* create — worth the extra service. Hashing's only real advantage (dedup identical URLs) is a minor storage win we don't need.
- **KV vs SQL:** pure point-lookup workload → KV. SQL buys nothing and caps out earlier at this QPS.
- **At 10×** (3.5M read QPS): push more aggressively to the edge (edge KV like Cloudflare Workers KV holding the whole mapping), regionalize everything, and shard analytics ingestion. The core key-gen and 302 logic don't change — that's the sign of a healthy design.

## 10. Interview Follow-ups

**Q: Why 7 characters and not 6 or 8?**
A: 62^7 ≈ 3.5T keys ≈ 95 years of runway at 100M/day; 62^6 ≈ 56B is only ~1.9 years — too short. 7 is the sweet spot of short-but-durable.

**Q: How do you avoid collisions without checking the DB on every write?**
A: Use a KGS that pre-generates unique keys offline into an `unused_keys` pool; each app server leases a block and hands them out. The write becomes a single INSERT with no collision check. Custom aliases use a conditional `IF NOT EXISTS` write.

**Q: Counter-based keys are sequential and guessable — is that a problem?**
A: It enables enumeration/scraping. Fix by base62-encoding with a per-key permutation/scramble, or by having KGS shuffle generated keys, so keys aren't monotonic even though the underlying counter is.

**Q: 301 vs 302 — which and why?**
A: 302. It's not cached by clients, so every click reaches us for analytics and lets us expire or change targets. 301 caches at the browser and cuts load but blinds analytics; we recover the load with Redis + CDN instead.

**Q: How do you make the redirect p99 < 50ms?**
A: Cache-first: CDN edge → Redis (90%+ hit, ~1ms) → KV miss (single-digit ms). Analytics is fire-and-forget to Kafka so it never adds latency.

**Q: A link goes viral — 200K QPS on one key. What breaks and how do you fix it?**
A: The single cache shard holding that key overheats. Mitigate by caching that specific 302 at the CDN edge (short TTL) and/or replicating the hot key across multiple cache nodes so load spreads.

**Q: How do you expire and delete links?**
A: Store `expires_at` and use the datastore's native TTL to auto-purge rows; on delete/expire, explicitly invalidate the Redis entry so we don't serve a dead link (return 410 Gone vs 404).

**Q: How does the global counter not become a bottleneck/SPOF?**
A: Don't use one live counter. Allocate ranges (blocks of 1M IDs) to each generator via etcd/Zookeeper or an atomic DB range grab; each generator then works its block lock-free. See **Distributed ID Generation**.

**Q: How do you dedup identical long URLs?**
A: Optional: keep a `hash(long_url) → key` index; on create, look it up and return the existing key. Costs an extra read/index — only worth it if dedup saves meaningful storage; often skipped.

**Q: How do you make analytics resilient without slowing redirects?**
A: Emit click events asynchronously to Kafka; a stream job rolls them into counters. If Kafka is down, redirects still succeed and events are buffered/replayed — analytics is best-effort, redirects are tier-0.

**Q: How would you go multi-region?**
A: Replicate the read path (Redis + KV read replicas) to each region and route via anycast/geo-DNS; keep writes in a home region (or use a globally-replicated KV like DynamoDB Global Tables) since write QPS is low and read latency is what matters.

## 11. Cheat Sheet

> [!TIP]
> **URL Shortener in one screen**
> - **Workload:** read-heavy (100:1), ~350K peak read QPS, ~3.5K write QPS. Design for reads.
> - **Keys:** 7-char base62 (62^7 ≈ 3.5T). Use a **KGS** (pre-generated pool) → no collision check on the hot path; scramble to avoid enumeration.
> - **Store:** sharded KV (Dynamo/Cassandra) partitioned by `short_key`; native TTL for expiry.
> - **Redirect:** **302** (keeps analytics + expiry) served cache-first: CDN → Redis (90%+ hit) → KV.
> - **Analytics:** fire-and-forget to **Kafka**, rolled up offline. Never on the redirect path.
> - **Collisions:** conditional `IF NOT EXISTS` for custom aliases → 409.
> - **Failure stance:** redirect is tier-0; analytics is best-effort. Hot key → push to CDN edge.

**References:** System Design Primer (TinyURL), "Designing Data-Intensive Applications" (partitioning), Bitly Engineering blog, AWS DynamoDB docs (conditional writes & TTL)

---
*System Design Handbook — topic 32.*
