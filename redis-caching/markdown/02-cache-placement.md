# 02 · Where Caches Live: Client, CDN, Application & Database

> **In one line:** A request passes through a stack of caches — browser, CDN, in-process, distributed, database buffer pool — and each tier is a different trade between how close it sits to the user, how much it holds, and how hard it is to keep coherent; Redis is the *distributed application* tier, and knowing why tells you what it is and is not for.

---

## 1. Overview

There is no such thing as "the cache". A single request to a modern web application can be served — or accelerated — by five or six distinct caches stacked between the user's screen and the authoritative database, and each one is a different technology solving a different slice of the same problem. Understanding this stack is what stops you from putting data in the wrong tier: caching a per-user session in a CDN, or a static logo in Redis, are both mistakes that come from not knowing where each cache belongs.

The organising principle is a trade-off between three properties that pull against each other:

- **Proximity** — how close the cache sits to the consumer. Closer means lower latency (a browser cache is 0 ms of network) but a smaller, more fragmented population (one browser holds only one user's data).
- **Capacity and sharing** — how much the cache holds and how many consumers share it. A shared distributed cache holds the whole working set once for everyone; a per-instance in-process cache holds a fraction, duplicated across instances.
- **Coherence cost** — how hard it is to keep the cache consistent with the origin. A cache you cannot reach to invalidate (a browser, a CDN edge) can only expire; a cache you control (Redis) can be invalidated precisely.

Redis sits at a specific, deliberate point on these axes: it is a **shared, distributed, application-tier cache** — far enough from the user to be invalidated on demand, close enough and fast enough to serve hot reads in under a millisecond, and shared so the working set is held once across all application instances. This chapter maps the whole stack so that placement is a decision, not an accident.

## 2. Core Concepts

- **Cache tier** — a distinct cache at one layer of the request path, with its own technology, scope and coherence mechanism.
- **Client-side cache** — the browser's HTTP cache and app-local storage; per-user, closest to the consumer, un-invalidatable.
- **CDN (edge cache)** — geographically distributed caches near users, serving static and cacheable dynamic content from points of presence.
- **Reverse proxy cache** — a shared cache in front of the application (Varnish, NGINX), caching whole HTTP responses.
- **In-process (local) cache** — a cache inside the application process's own memory; nanosecond access, per-instance, duplicated.
- **Distributed cache** — a shared, out-of-process cache (Redis, Memcached) reachable over the network by all application instances.
- **Database buffer pool** — the database's own in-memory cache of pages; the cache you get "for free" from the origin.
- **HTTP caching** — the protocol-level mechanism (`Cache-Control`, `ETag`, `max-age`) that governs the client and CDN tiers.
- **Cache coherence** — keeping copies across tiers consistent; harder the further the cache is from your control.
- **Near cache** — an in-process cache in front of a distributed cache, combining nanosecond hits with shared capacity.
- **Multi-tier caching** — deliberately layering caches so each absorbs what the tier behind it should not have to serve.

## 3. Theory & Principles

### The stack, from user to truth

A request descends through the tiers, and each one it hits is a request the next tier never sees. Reading the stack top to bottom:

| Tier | Technology | Scope | Access latency | Coherence |
|---|---|---|---|---|
| **Browser cache** | HTTP cache, localStorage | One user | ~0 (in memory) | Expire only (unreachable) |
| **CDN / edge** | CloudFront, Fastly, Cloudflare | All users, per-region | 1–20 ms | Expire + purge (slow, coarse) |
| **Reverse proxy** | Varnish, NGINX | All users | ~1 ms | Purge (you control it) |
| **In-process** | Caffeine, Guava, `sync.Map` | One instance | ~10–100 ns | Hard (per-instance, no shared signal) |
| **Distributed** | **Redis, Memcached** | All instances | ~0.2–1 ms | Precise (delete/update on demand) |
| **DB buffer pool** | Postgres/MySQL memory | The database | ~microseconds | Automatic (it *is* the origin) |
| **Origin** | Disk, computation, API | Truth | ~ms–seconds | N/A |

Two patterns fall out of this table. First, **proximity trades against coherence**: the closer a cache is to the user, the harder it is to invalidate, because you cannot reach into a browser or an edge node to delete a key — you can only wait for its TTL or issue a coarse, slow purge. Second, **the tiers are complementary, not competing**: a CDN caches the static shell of a page, Redis caches the per-user data that fills it, and the buffer pool caches the pages Redis missed. Each absorbs what the tier behind it should not have to serve.

### Where each kind of data belongs

The placement decision is driven by two questions: *who shares this data* and *how often does it change*.

- **Static, public, rarely-changing** (images, CSS, JS bundles, public product pages) → **CDN and browser**. It is the same for everyone, so cache it once per region as close to the user as possible, and version the URL so a change is a new URL rather than an invalidation.
- **Shared, dynamic, changes moderately** (a product's price, a user's profile, a computed feed) → **Redis**. It is the same across your instances, changes on a timescale you must invalidate for, and benefits from being held once and shared.
- **Per-instance, hot, tiny** (a config flag read on every request, a compiled regex) → **in-process**. It is so hot that even a 0.5 ms Redis hop is too much, and it is small enough to duplicate harmlessly across instances.
- **Per-user, private, session-scoped** (a shopping cart, a session token) → **Redis** if it must survive across instances (which it usually must, behind a load balancer), the browser only if it can be lost.
- **The database's own working set** → **buffer pool**. You do not manage this; you get it by keeping the database's memory sized for its hot pages.

The classic mistakes are placing data in a tier whose coherence model it cannot tolerate. A per-user cart in a CDN gets served to the wrong user. A frequently-changing price with a long browser `max-age` shows a stale price you cannot recall. A large object in an in-process cache duplicated across 50 instances wastes 50× the memory. Each is a placement error, not a technology failure.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="p1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The cache stack: each tier absorbs what the next should not serve</text>

  <rect x="30" y="44" width="120" height="410" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="90" y="70" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">USER</text>
  <text x="90" y="250" text-anchor="middle" fill="#7f1d1d" font-size="9" transform="rotate(-90 90 250)">closer &#183; faster &#183; smaller &#183; harder to invalidate</text>

  <g>
    <rect x="170" y="44" width="620" height="52" rx="6" fill="#dbeafe" stroke="#2563eb"/>
    <text x="186" y="66" fill="#1e40af" font-size="11" font-weight="bold">Browser cache &#183; localStorage</text>
    <text x="186" y="84" fill="#1d4ed8" font-size="9">one user &#183; ~0 ms &#183; EXPIRE ONLY (unreachable) &#8594; static assets, versioned URLs</text>
    <rect x="800" y="44" width="50" height="52" rx="6" fill="#dbeafe" stroke="#2563eb"/>
    <text x="825" y="76" text-anchor="middle" fill="#1e40af" font-size="9" font-weight="bold">HTTP</text>

    <rect x="170" y="102" width="620" height="52" rx="6" fill="#dbeafe" stroke="#2563eb"/>
    <text x="186" y="124" fill="#1e40af" font-size="11" font-weight="bold">CDN / edge</text>
    <text x="186" y="142" fill="#1d4ed8" font-size="9">all users per region &#183; 1&#8211;20 ms &#183; purge is slow + coarse &#8594; static + cacheable dynamic</text>
    <rect x="800" y="102" width="50" height="52" rx="6" fill="#dbeafe" stroke="#2563eb"/>
    <text x="825" y="134" text-anchor="middle" fill="#1e40af" font-size="9" font-weight="bold">edge</text>

    <rect x="170" y="160" width="620" height="52" rx="6" fill="#e0e7ff" stroke="#4f46e5"/>
    <text x="186" y="182" fill="#3730a3" font-size="11" font-weight="bold">Reverse proxy (Varnish / NGINX)</text>
    <text x="186" y="200" fill="#4338ca" font-size="9">all users &#183; ~1 ms &#183; purge (you control it) &#8594; whole HTTP responses</text>

    <rect x="170" y="218" width="620" height="52" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
    <text x="186" y="240" fill="#5b21b6" font-size="11" font-weight="bold">In-process (Caffeine / sync.Map)</text>
    <text x="186" y="258" fill="#6d28d9" font-size="9">ONE instance &#183; ~10&#8211;100 ns &#183; per-instance, no shared invalidation &#8594; tiny hot config</text>

    <rect x="170" y="276" width="620" height="52" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="3"/>
    <text x="186" y="298" fill="#15803d" font-size="11" font-weight="bold">Distributed &#8212; REDIS / Memcached  &#8592; this handbook</text>
    <text x="186" y="316" fill="#166534" font-size="9">ALL instances &#183; 0.2&#8211;1 ms &#183; PRECISE invalidation &#8594; shared dynamic + session data</text>

    <rect x="170" y="334" width="620" height="52" rx="6" fill="#fef3c7" stroke="#d97706"/>
    <text x="186" y="356" fill="#92400e" font-size="11" font-weight="bold">DB buffer pool</text>
    <text x="186" y="374" fill="#b45309" font-size="9">the database &#183; ~&#181;s &#183; automatic (it IS the origin) &#8594; the DB's own hot pages</text>

    <rect x="170" y="392" width="620" height="52" rx="6" fill="#f1f5f9" stroke="#64748b"/>
    <text x="186" y="414" fill="#334155" font-size="11" font-weight="bold">ORIGIN &#8212; disk / computation / API</text>
    <text x="186" y="432" fill="#64748b" font-size="9">the source of truth &#183; ms&#8211;seconds &#183; the cost every tier above exists to avoid</text>
  </g>
</svg>
```

### Multi-tier caching: the near cache

The tiers are not mutually exclusive; the most demanding systems layer them deliberately. The **near cache** pattern puts a small in-process cache in front of Redis: the hottest keys are served from local memory in nanoseconds, and only local misses go to Redis. This combines the in-process tier's speed with the distributed tier's shared capacity.

The catch is coherence: the local caches are per-instance and have no shared invalidation signal, so a write that invalidates the Redis entry does not automatically evict the stale copies in every instance's local cache. The near cache therefore needs either a very short local TTL (accepting brief staleness) or a broadcast invalidation channel (Redis Pub/Sub, or Redis 6+ client-side caching with tracking, chapter 27). This is the general lesson of multi-tier caching: **every tier you add multiplies the invalidation problem**, and the benefit has to be worth that.

## 4. Architecture & Workflow

The decision procedure for placing a piece of data:

1. **Who shares it?** One user → client or per-user Redis. All users → CDN (if static) or Redis (if dynamic). One instance → in-process. The database's own data → buffer pool.
2. **How static is it?** Immutable/versioned → push it as far toward the user as possible (CDN, browser). Frequently changing → keep it where you can invalidate (Redis, reverse proxy).
3. **How large is it?** Tiny and hot → in-process is fine even duplicated. Large → distributed, so it is held once, not once per instance.
4. **What staleness can it tolerate?** Zero → maybe do not cache it at the edge at all; read from origin. Seconds to minutes → the TTL sets the tier's suitability.
5. **Can you reach it to invalidate?** If not (browser, CDN), you are committing to expire-only and versioned URLs. If yes (Redis, proxy), precise invalidation is available.

The end state most systems reach is a layered one: a CDN for the static shell, Redis for the shared dynamic data, an optional near cache for the very hottest keys, and a well-sized buffer pool underneath. Each tier is configured for the data that belongs in it, and no tier holds data whose coherence model it cannot honour.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Placement by two questions: who shares it, how often it changes</text>

  <line x1="120" y1="60" x2="120" y2="330" stroke="#94a3b8" stroke-width="1.5"/>
  <line x1="120" y1="330" x2="840" y2="330" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="110" y="66" text-anchor="end" fill="#64748b" font-size="9">rarely</text>
  <text x="110" y="326" text-anchor="end" fill="#64748b" font-size="9">often</text>
  <text x="70" y="200" text-anchor="middle" fill="#64748b" font-size="10" transform="rotate(-90 70 200)">how often it changes</text>
  <text x="200" y="352" fill="#64748b" font-size="9">one user</text>
  <text x="480" y="352" fill="#64748b" font-size="9">all instances (shared)</text>
  <text x="760" y="352" fill="#64748b" font-size="9">the whole world</text>

  <rect x="620" y="70" width="200" height="70" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="720" y="94" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">CDN + browser</text>
  <text x="720" y="112" text-anchor="middle" fill="#1d4ed8" font-size="9">static, public, versioned URLs</text>
  <text x="720" y="128" text-anchor="middle" fill="#1d4ed8" font-size="9">images, CSS, JS, public pages</text>

  <rect x="360" y="150" width="220" height="80" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="3"/>
  <text x="470" y="176" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">REDIS</text>
  <text x="470" y="196" text-anchor="middle" fill="#166534" font-size="9">shared, dynamic, invalidate-on-write</text>
  <text x="470" y="212" text-anchor="middle" fill="#166534" font-size="9">prices, profiles, feeds, sessions</text>

  <rect x="150" y="70" width="180" height="70" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="240" y="94" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">in-process</text>
  <text x="240" y="112" text-anchor="middle" fill="#6d28d9" font-size="9">tiny, ultra-hot, per-instance</text>
  <text x="240" y="128" text-anchor="middle" fill="#6d28d9" font-size="9">config flags, compiled regex</text>

  <rect x="150" y="250" width="180" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="240" y="274" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">per-user Redis</text>
  <text x="240" y="292" text-anchor="middle" fill="#b45309" font-size="9">carts, sessions that must</text>
  <text x="240" y="308" text-anchor="middle" fill="#b45309" font-size="9">survive across instances</text>

  <rect x="600" y="250" width="240" height="70" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="720" y="274" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">the placement error zone</text>
  <text x="720" y="292" text-anchor="middle" fill="#991b1b" font-size="9">fast-changing shared data pushed</text>
  <text x="720" y="308" text-anchor="middle" fill="#991b1b" font-size="9">to a tier you cannot invalidate &#8594; stale</text>
</svg>
```

## 5. Implementation

A near cache — an in-process layer in front of Redis — makes the multi-tier idea concrete. This implementation shows the pattern *and* the coherence problem it creates, plus the Pub/Sub invalidation that fixes it.

```go
package nearcache

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

// NearCache is an in-process cache (nanosecond hits) in front of Redis
// (shared, sub-millisecond, invalidatable). It gives the hottest keys local
// speed while keeping the shared working set in Redis.
//
// The hard part is coherence: local copies in OTHER instances do not see a
// Redis invalidation, so we subscribe to a Pub/Sub channel to evict them.
type NearCache struct {
	rdb   *redis.Client
	local sync.Map // key -> entry; per-instance, nanosecond access
	ttl   time.Duration
}

type entry struct {
	value   []byte
	expires time.Time
}

const invalidationChannel = "cache:invalidate"

func New(rdb *redis.Client, localTTL time.Duration) *NearCache {
	nc := &NearCache{rdb: rdb, ttl: localTTL}
	// Subscribe so that an invalidation on ANY instance evicts the stale local
	// copy here. Without this, the local cache serves stale data for up to
	// localTTL after a write elsewhere — the near-cache coherence problem.
	go nc.listenForInvalidations(context.Background())
	return nc
}

func (nc *NearCache) Get(ctx context.Context, key string, load func() ([]byte, error)) ([]byte, error) {
	// --- Tier 1: local memory (nanoseconds) --------------------------------
	if v, ok := nc.local.Load(key); ok {
		e := v.(entry)
		if time.Now().Before(e.expires) {
			return e.value, nil // local hit — the fastest possible path
		}
		nc.local.Delete(key) // locally expired; fall through to Redis
	}

	// --- Tier 2: Redis (shared, sub-millisecond) ---------------------------
	val, err := nc.rdb.Get(ctx, key).Bytes()
	if err == nil {
		nc.storeLocal(key, val) // promote into local cache for next time
		return val, nil
	}
	if err != redis.Nil {
		return nil, err
	}

	// --- Tier 3: origin ----------------------------------------------------
	loaded, err := load()
	if err != nil {
		return nil, err
	}
	// Populate BOTH tiers. Redis with a longer TTL (the shared source of
	// cached truth), local with a short one (bounded staleness if the
	// invalidation broadcast is ever missed).
	nc.rdb.Set(ctx, key, loaded, 10*time.Minute)
	nc.storeLocal(key, loaded)
	return loaded, nil
}

// Invalidate deletes the shared entry AND broadcasts so every instance evicts
// its local copy. Deleting only Redis would leave stale local copies alive for
// up to localTTL everywhere — the bug the broadcast prevents.
func (nc *NearCache) Invalidate(ctx context.Context, key string) error {
	if err := nc.rdb.Del(ctx, key).Err(); err != nil {
		return err
	}
	nc.local.Delete(key) // evict our own copy immediately
	// Tell every other instance to evict theirs.
	return nc.rdb.Publish(ctx, invalidationChannel, key).Err()
}

func (nc *NearCache) listenForInvalidations(ctx context.Context) {
	sub := nc.rdb.Subscribe(ctx, invalidationChannel)
	for msg := range sub.Channel() {
		nc.local.Delete(msg.Payload) // a write happened elsewhere; drop our copy
	}
}

func (nc *NearCache) storeLocal(key string, value []byte) {
	nc.local.Store(key, entry{value: value, expires: time.Now().Add(nc.ttl)})
}

// MarshalJSON/typed helpers omitted for brevity — the point here is the tiering
// and the coherence broadcast, not the serialization.
var _ = json.Marshal
```

The lesson embedded in this code: the near cache is easy; keeping it coherent is the work. The Pub/Sub broadcast is best-effort (Pub/Sub does not survive a subscriber being disconnected, chapter 21), which is exactly why the local TTL is kept short as a safety net — the same "TTL backs invalidation" principle from chapter 1, applied to a second tier.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of a layered cache stack**
- **Each tier absorbs load for the next.** The CDN takes static traffic off Redis; Redis takes read traffic off the database; the buffer pool takes disk I/O off the query planner.
- **Latency is minimised per data type.** Static assets are served from the edge in milliseconds; the hottest config is served from process memory in nanoseconds; shared dynamic data is served from Redis in sub-milliseconds.
- **Blast radius is contained.** A Redis outage still leaves the CDN serving static content and the buffer pool serving hot pages, degrading rather than collapsing.

**Disadvantages**
- **Coherence multiplies.** Every tier is another copy that can go stale, and the tiers you cannot reach (browser, CDN) can only expire, not invalidate.
- **Debugging spans layers.** "Why is this stale?" now has five candidate answers, and the browser and edge caches are the hardest to inspect.
- **Operational surface grows.** Each tier is a system to configure, monitor and reason about.

**Trade-offs**
- *Proximity vs coherence:* pushing data toward the user cuts latency but forfeits precise invalidation. Versioned URLs are the escape hatch for the un-invalidatable tiers — a change becomes a new URL rather than an invalidation.
- *In-process vs distributed:* local caches are faster and need no network, but are per-instance (duplicated memory) and hard to invalidate coherently. Distributed caches are slower but shared and precisely invalidatable.
- *Near cache vs single-tier:* a near cache adds nanosecond hits at the cost of a coherence broadcast and bounded local staleness. Only worth it for genuinely ultra-hot keys.

## 7. Common Mistakes & Best Practices

- **Caching per-user data in a shared tier.** A cart or session in a CDN gets served to the wrong user. Per-user data belongs in the browser or in per-user-keyed Redis.
- **Long browser `max-age` on changing data.** You cannot recall it; the user sees stale data until the TTL expires. Use short TTLs plus `ETag` revalidation for changing content, and versioned URLs for static.
- **Large objects in an in-process cache across many instances.** Fifty instances holding the same 10 MB object waste 500 MB. Large shared data belongs in Redis, held once.
- **Putting the wrong staleness tolerance at the wrong tier.** Zero-tolerance data at the edge is unrecallable staleness. Read it from origin or keep it in an invalidatable tier.
- **Forgetting the buffer pool.** Under-sizing the database's memory so it hits disk on reads that Redis missed. The cheapest cache is often more RAM on the database.
- **A near cache with no invalidation.** Local copies that go stale silently after a write elsewhere. Either a short local TTL or a broadcast channel, never nothing.
- **Best practice: place by who-shares-it and how-often-it-changes.** These two questions resolve most placement decisions, and reviewing them turns placement from an accident into a design choice.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** A staleness bug requires identifying *which tier* is serving the old copy. The technique: bypass tiers one at a time — a cache-busting query string skips CDN and browser, a direct Redis `GET` checks the distributed tier, a direct origin read checks the truth. Whichever tier's value diverges is the culprit.
- **Monitoring.** Each tier has its own hit ratio and they must be tracked separately — a CDN hit ratio, a Redis hit ratio, a buffer-pool hit ratio. A drop in one tier's hit ratio shows up as increased load on the tier below, so watching the *cascade* is often more diagnostic than any single number.
- **Security.** Data replicated across tiers replicates its sensitivity. A common leak is caching a personalised response in a shared CDN cache because a `Cache-Control` header was wrong, serving one user's data to everyone in a region. Private data must carry `Cache-Control: private` (or `no-store`) so shared tiers refuse to cache it.
- **Scaling.** As traffic grows, the job of the stack is to keep the *origin* load flat by pushing the incremental load into the tiers. The CDN scales horizontally almost infinitely; Redis scales with clustering (chapter 26); the buffer pool scales with database memory. The tier that scales worst is usually the one you should push least load into.

## 9. Interview Questions

**Q: Name the cache tiers between a user and the database, from closest to furthest.**
A: The browser cache and local storage, closest and per-user; the CDN or edge cache, per-region and shared; a reverse-proxy cache like Varnish in front of the application; an in-process cache inside each application instance; a distributed cache like Redis shared across all instances; and the database's own buffer pool. Each tier a request hits is a request the next tier down never sees, and the further a cache is from the user, the easier it is to invalidate precisely.

**Q: Where does Redis sit in that stack, and why?**
A: Redis is the shared, distributed, application-tier cache. It sits far enough from the user that you can reach into it to invalidate on demand, unlike a browser or CDN which can only expire; close enough and fast enough to serve hot reads in under a millisecond; and shared across all application instances, so the working set is held once rather than duplicated per instance. That combination — precise invalidation plus shared capacity plus sub-millisecond reads — is exactly the niche for shared dynamic data like prices, profiles, feeds and sessions.

**Q: Why is a cache closer to the user harder to keep consistent?**
A: Because you lose the ability to reach into it and invalidate. You cannot delete a key from a user's browser cache or from a CDN edge node on demand — the browser is not yours to command, and purging a CDN is a slow, coarse, global operation. So the closer tiers can generally only *expire* by TTL, which means a change to the data is not visible until the TTL runs out. The workaround is versioned URLs: instead of invalidating, you make a change produce a new URL, so old copies simply stop being requested.

**Q: What is a near cache and what problem does it introduce?**
A: A near cache is a small in-process cache in front of a distributed cache like Redis, so the hottest keys are served from local memory in nanoseconds and only local misses hit Redis. The problem it introduces is coherence: the local caches are per-instance with no shared invalidation signal, so when a write invalidates the Redis entry, the stale copies in every other instance's local cache are not evicted. You fix it with a very short local TTL, a broadcast invalidation channel like Redis Pub/Sub, or Redis client-side caching with tracking — and usually the short TTL as a safety net regardless.

**Q: What data belongs in a CDN versus Redis?**
A: The distinguishing questions are who shares it and how static it is. Static, public, rarely-changing data that is identical for everyone — images, CSS and JS bundles, public product pages — belongs in the CDN and browser, cached as close to the user as possible and versioned so a change is a new URL. Shared, dynamic data that changes on a timescale you must invalidate for — a price, a user profile, a computed feed — belongs in Redis, where it is held once across all instances and can be invalidated precisely on a write. Putting fast-changing data at the edge means unrecallable staleness; putting per-user data in a shared CDN means serving it to the wrong user.

**Q: (Senior) Design the caching stack for a product-detail page.**
A: I would decompose the page by who-shares-it and how-static-it-is, and place each part in its tier. The static shell — layout, CSS, JS, the site chrome — goes to the CDN and browser with long TTLs and versioned URLs, so it is served from the edge and a deploy invalidates by changing the URL, not by purging. The product's shared dynamic data — description, images, base price — goes to Redis with a TTL matched to how often it changes and explicit invalidation on a catalogue update, because it is identical across instances and must be recallable. Genuinely per-user parts — "your recently viewed", cart count — either come from per-user-keyed Redis or are hydrated client-side after the shell loads, so they are never baked into a shared cache. Anything with zero staleness tolerance near purchase, like live inventory at checkout, I would read from the origin rather than cache. Underneath, I would make sure the database buffer pool is sized for the catalogue's hot pages, because that absorbs the reads Redis misses. The result is a layered stack where each tier holds only data whose coherence model it can honour.

**Q: (Senior) A user reports seeing another user's data. Walk through the diagnosis.**
A: This is almost always a placement or header error at a shared tier, and the sensitive one is the CDN. The mechanism is usually a personalised response cached in a shared cache because it lacked `Cache-Control: private` or `no-store`, so the first user's response was stored at the edge and served to everyone in that region until it expired. I would confirm by checking the response headers for the affected endpoint — a personalised response with a shared-cacheable directive is the smoking gun — and by checking the CDN's cache key, because if it does not include the user or session identity, personalised responses collide. The immediate fix is to mark personalised responses private or non-cacheable and purge the poisoned entries; the systemic fix is a policy that any endpoint returning per-user data must set the correct cache directives, enforced in code review or a middleware. I would also audit Redis key construction for the same class of bug — a per-user cache keyed without the user id serves cross-user data the same way.

**Q: (Senior) When would you deliberately not use a distributed cache and use in-process instead?**
A: When the data is tiny, extremely hot, and can tolerate either being duplicated across instances or brief per-instance staleness — and when even a sub-millisecond network hop to Redis is too much relative to how often it is read. A feature flag or a config value read on every single request is the canonical case: it is a few bytes, read millions of times, and the cost of a Redis round trip on every read dwarfs the cost of holding a duplicated copy in each instance's memory. The trade I accept is coherence — the local copies have no shared invalidation, so I bound staleness with a short refresh interval or a broadcast, and I only accept that for data where a few seconds of staleness is harmless. For anything large, per-user, or requiring precise invalidation, the shared distributed cache is correct, because duplicating large data across dozens of instances wastes memory and losing precise invalidation is unacceptable.

## 10. Quick Revision & Cheat Sheet

| Tier | Scope | Latency | Coherence | Cache what |
|---|---|---|---|---|
| Browser | 1 user | ~0 | Expire only | Static, versioned |
| CDN | Region | 1–20 ms | Purge (coarse) | Static + cacheable dynamic |
| Reverse proxy | All users | ~1 ms | Purge (yours) | Whole HTTP responses |
| In-process | 1 instance | ns | Hard | Tiny ultra-hot |
| **Redis** | All instances | 0.2–1 ms | **Precise** | **Shared dynamic + sessions** |
| Buffer pool | The DB | µs | Automatic | The DB's hot pages |

**Placement by two questions**
- **Who shares it?** One user → client/per-user Redis · all instances → Redis · one instance → in-process · the world → CDN.
- **How often does it change?** Rarely → push toward the user (CDN/browser) · often → keep where you can invalidate (Redis/proxy).

**Flash cards**
- **Where does Redis sit?** → Shared, distributed, application tier: precise invalidation + shared capacity + sub-ms reads.
- **Why is a browser cache hard to keep consistent?** → You cannot reach it to invalidate; it can only expire. Use versioned URLs.
- **Near cache trade?** → Nanosecond local hits, at the cost of a coherence broadcast and bounded local staleness.
- **CDN vs Redis?** → Static/public/versioned → CDN; shared/dynamic/invalidatable → Redis.
- **Cross-user leak cause?** → Personalised response cached in a shared tier without `Cache-Control: private`, or a key missing the user id.
- **Every added tier?** → Multiplies the invalidation problem. Add one only if the benefit is worth that.

## 11. Hands-On Exercises & Mini Project

- [ ] For a page you know, list every part and place each in a tier using the who-shares-it / how-static-it-is questions. Note any part that is currently in the wrong tier.
- [ ] Set a long browser `max-age` on a changing resource, change it, and observe that you cannot recall the stale copy. Then switch to versioned URLs and observe the change take effect immediately.
- [ ] Build the near cache from §5, run two instances, invalidate on one, and confirm the other still serves stale data *until* you enable the Pub/Sub broadcast.
- [ ] Cause a cross-tier staleness bug and diagnose it by bypassing tiers one at a time (cache-buster, direct Redis `GET`, direct origin read).
- [ ] Measure the hit ratio at two tiers simultaneously and watch a drop in one become load on the tier below.
- [ ] Find one personalised endpoint and verify its cache headers refuse shared caching.

### Mini Project — "Multi-Tier Cache for a Page"

**Goal.** Build and instrument a genuine multi-tier cache for one real page, and demonstrate each tier absorbing load for the next.

**Requirements.**
1. Serve a page whose static shell is CDN-cached (versioned URLs), whose shared dynamic data is Redis-cached with explicit invalidation, and whose ultra-hot config is in an in-process near cache with a short TTL.
2. Instrument the hit ratio at each tier separately and show the cascade: a CDN miss becomes a Redis request, a Redis miss becomes an origin read.
3. Implement the near-cache coherence broadcast and prove that a write invalidates the local copies across two instances.
4. Deliberately misplace one piece of data (per-user data in a shared tier) and demonstrate the resulting cross-user leak, then fix it.
5. Load-test and show that as request volume climbs, origin reads per second stay roughly flat because the tiers absorb the increase.

**Extensions.**
- Add a reverse-proxy tier and measure how much Redis load it removes for a whole-response cache.
- Simulate a Redis outage and show the CDN and buffer pool degrading gracefully rather than the whole page failing.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is Caching?* (the cost model these tiers all serve), *Redis as a Cache* (the distributed tier in depth), *Client-Side Caching, Pooling & Performance* (the near cache and Redis tracking), *Pub/Sub & Streams for Cache Invalidation* (the coherence broadcast), *Cache Invalidation Strategies* (how each tier's invalidation differs).

- **MDN — HTTP caching** — Mozilla · *Beginner* · the definitive reference for the browser and CDN tiers: `Cache-Control`, `ETag`, `max-age`, `private`, and revalidation. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching>
- **Redis — Use cases & Client-side caching** — Redis · *Intermediate* · where the distributed tier fits and how Redis 6+ supports an invalidatable near cache. <https://redis.io/docs/latest/develop/reference/client-side-caching/>
- **Fastly / Cloudflare — Caching concepts** — Fastly, Cloudflare · *Intermediate* · how the edge tier works, purge mechanics, and why versioned URLs beat invalidation at the edge. <https://developer.fastly.com/learning/concepts/>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · the systems view of layered caches and where each belongs. <https://dataintensive.net/>
- **Caffeine — a high-performance in-process cache for the JVM** — Ben Manes · *Intermediate* · the reference in-process tier, useful for understanding what the local layer of a near cache offers. <https://github.com/ben-manes/caffeine>
- **Varnish — HTTP Cache** — Varnish Software · *Intermediate* · the reverse-proxy tier and whole-response caching, with the purge model. <https://varnish-cache.org/docs/>
- **PostgreSQL — shared_buffers and the buffer pool** — PostgreSQL · *Intermediate* · the database tier you get for free, and how to size it. <https://www.postgresql.org/docs/current/runtime-config-resource.html>
- **Facebook — Scaling Memcache at Facebook** — Nishtala et al., NSDI 2013 · *Advanced* · multi-tier caching at scale, including the near-cache and invalidation reasoning. <https://www.usenix.org/system/files/conference/nsdi13/nsdi13-final170_update.pdf>

---

*Caching with Redis Handbook — chapter 02.*
