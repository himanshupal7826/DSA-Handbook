# 09 · Read-Through & Write-Through Caching

> **In one line:** Read-through and write-through move the cache logic *behind* a caching layer so the application only ever talks to the cache — trading the explicit control of cache-aside for centralised, un-duplicated correctness, and paying for write-through's consistency with synchronous latency on every write.

---

## 1. Overview

Cache-aside (chapter 08) scatters the same check-load-populate logic across every read site and the same update-then-invalidate logic across every write site. That duplication is where mistakes breed: one call path forgets the TTL, another updates instead of deletes, a third skips negative caching. Read-through and write-through are the answer to that duplication. They push the cache logic *behind a caching layer* — a library, a wrapper, or a proxy — so the application asks the cache for data and the cache itself is responsible for talking to the underlying store. The application never sees the database directly.

**Read-through** handles the read path: the application calls `cache.Get(key)`, and if the key is present the cache returns it, but if it is absent the *cache* invokes a loader function you registered, fetches the value from the store, populates itself, and returns it — all transparently. The caller cannot tell a hit from a miss except by latency. **Write-through** handles the write path symmetrically: the application calls `cache.Put(key, value)`, and the cache writes the value *through* itself to the underlying store synchronously before the call returns, keeping the cache and the store in lockstep.

The defining question that separates these patterns from cache-aside is *who owns store access*. In cache-aside, the application owns it — it explicitly reads and writes both the cache and the database. In read-through/write-through, the *caching layer* owns it — the application only ever knows about the cache, and the store is reached solely through the loader and writer the cache calls. That single shift of ownership is the whole story: it centralises the logic (a win) and hides the store's failure modes behind the cache (a trade-off).

This matters because it changes where the caching contract lives. With a good read-through/write-through layer, "how do we cache users?" is answered once, in the loader and writer, and every call site inherits it correctly. The cost is that you now depend on that layer being right and being available, and write-through in particular makes every write pay the latency of writing to *both* the cache and the store synchronously — a real tax you accept in exchange for the cache never being stale relative to a completed write.

## 2. Core Concepts

- **Read-through** — the caching layer loads from the store on a miss via a registered loader; the application only calls the cache.
- **Write-through** — the caching layer writes synchronously through itself to the store on every write, keeping cache and store consistent.
- **Caching layer** — the library, wrapper, or proxy that sits between the application and the store and owns all store access.
- **Loader (cache loader)** — the function the cache calls on a miss to fetch a value from the store and populate itself.
- **Writer** — the function the cache calls on a write to persist the value to the store before returning.
- **Store ownership** — the defining difference from cache-aside: here the *cache*, not the application, talks to the store.
- **Transparency** — the application code is store-agnostic; a hit and a miss differ only in latency, not in the code that runs.
- **Synchronous write** — write-through blocks the caller until both the cache and the store are updated; the source of its consistency and its latency cost.
- **Consistency guarantee** — after a write-through `Put` returns, the cache reflects exactly what the store holds (no read-write race on the write path).
- **Caching proxy** — an out-of-process layer (a sidecar or a service) that provides read-through/write-through for many clients without a shared library.
- **Inversion of control** — the application hands the layer loader/writer callbacks and the layer, not the application, decides when to call them; the basis of the pattern's enforceable guarantees.
- **Partial-failure policy** — the defined behaviour when the store write succeeds but the cache update fails (or vice versa); typically "store is authoritative, invalidate the cache".
- **Warm-on-write** — a property of write-through: the just-written value is already in the cache, so a following read is a guaranteed hit.

## 3. Theory & Principles

### Read-through: the same read path, relocated

Read-through does exactly what cache-aside's read path does — check the cache, on a miss load from the store and populate — but it *relocates* that logic from the application into the caching layer. The application calls one method, `Get(key)`, and the layer decides internally whether to serve from cache or invoke the loader. The value is that the check-load-populate sequence, with all its subtleties (TTL, negative caching, stampede protection), is written *once* inside the layer and every caller gets it right by construction. There is no call site that can forget the TTL, because no call site sets the TTL — the layer does.

The loader is the key abstraction. You register a function `load(key) -> (value, error)` when you construct the cache, and the layer calls it on every miss. This is an inversion of control: instead of the application driving the store, the cache drives the store through a callback the application supplied. Everything hard about the read path — collapsing concurrent misses so one miss triggers one load, distinguishing "not found" from "error", applying jittered TTLs — lives inside the layer around that loader call, so it is implemented once and correctly. The application's mental model shrinks to "I ask the cache; the cache always answers."

### Write-through: consistency bought with synchronous latency

Write-through is where the patterns diverge from cache-aside most sharply. In cache-aside you update the store and then *delete* the cache. In write-through you update the cache and the store *together, synchronously*, as one logical operation that does not return until both are done. The cache is written *through* to the store — hence the name — so at the moment a `Put` returns, the cache and the store hold the same value. There is no window where a read could see a stale cache relative to a completed write, because the write did not complete until the cache was updated too.

That is a stronger consistency property than cache-aside offers, and it is bought with a specific, unavoidable cost: **every write now pays the latency of writing to both the cache and the store, in series.** A cache-aside write pays one store write plus a fast cache delete; a write-through write pays a store write plus a cache write and cannot return until both succeed. Under load, that added latency is real, and it sits on the critical path of every write. You also inherit a harder failure question: if the store write succeeds but the cache write fails (or vice versa), the two can diverge, so a correct write-through layer must define what happens on partial failure — typically it fails the whole operation and lets the caller retry, or it treats the store as authoritative and invalidates the cache on cache-write failure so the next read reloads.

Note the important subtlety: write-through does *not* by itself make writes durable faster or reduce store load — every write still hits the store. Its benefit is purely consistency and cache-warmth: the just-written value is already cached, so a subsequent read is a guaranteed hit. If your workload writes data that is rarely read back, write-through wastes effort caching values nobody will fetch — which is exactly when write-around (chapter 10) is the better choice.

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="rt1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="rt2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Where the store access lives: cache-aside vs read-/write-through</text>

  <rect x="24" y="40" width="410" height="180" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Cache-aside: APP owns the store</text>
  <rect x="44" y="80" width="100" height="34" rx="6" fill="#fde68a" stroke="#d97706"/><text x="94" y="102" text-anchor="middle" fill="#92400e">App</text>
  <rect x="200" y="80" width="100" height="34" rx="6" fill="#fde68a" stroke="#d97706"/><text x="250" y="102" text-anchor="middle" fill="#92400e">Cache</text>
  <rect x="200" y="150" width="100" height="34" rx="6" fill="#fde68a" stroke="#d97706"/><text x="250" y="172" text-anchor="middle" fill="#92400e">Store</text>
  <path d="M144,97 L196,97" stroke="#d97706" stroke-width="1.5" marker-end="url(#rt1)"/>
  <path d="M94,114 L94,167 L196,167" stroke="#d97706" stroke-width="1.5" fill="none" marker-end="url(#rt1)"/>
  <text x="120" y="205" fill="#92400e" font-size="9">App talks to BOTH cache and store directly.</text>

  <rect x="446" y="40" width="410" height="180" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Read-/write-through: CACHE owns the store</text>
  <rect x="466" y="80" width="100" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="516" y="102" text-anchor="middle" fill="#1e40af">App</text>
  <rect x="622" y="80" width="120" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="682" y="102" text-anchor="middle" fill="#1e40af">Caching layer</text>
  <rect x="622" y="150" width="120" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="682" y="172" text-anchor="middle" fill="#1e40af">Store</text>
  <path d="M566,97 L618,97" stroke="#2563eb" stroke-width="1.5" marker-end="url(#rt1)"/>
  <path d="M682,114 L682,146" stroke="#2563eb" stroke-width="1.5" marker-end="url(#rt1)"/>
  <text x="486" y="205" fill="#1e40af" font-size="9">App talks ONLY to the cache; the cache reaches the store.</text>

  <rect x="24" y="236" width="410" height="210" rx="10" fill="#f5f3ff" stroke="#7c3aed" stroke-width="2"/>
  <text x="229" y="258" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">READ-THROUGH (miss triggers the loader)</text>
  <text x="44" y="282" fill="#6d28d9" font-size="10">1. App: cache.Get(key)</text>
  <text x="44" y="302" fill="#6d28d9" font-size="10">2. Cache: present? return it (HIT)</text>
  <text x="44" y="322" fill="#6d28d9" font-size="10">3. Absent? cache calls loader(key)</text>
  <text x="44" y="342" fill="#6d28d9" font-size="10">4. loader reads STORE, cache populates</text>
  <text x="44" y="362" fill="#6d28d9" font-size="10">5. Cache returns value to App</text>
  <rect x="44" y="378" width="366" height="52" rx="6" fill="#fff" stroke="#c4b5fd"/>
  <text x="60" y="399" fill="#5b21b6" font-size="9" font-weight="bold">App never sees the store; TTL &amp; stampede</text>
  <text x="60" y="416" fill="#5b21b6" font-size="9" font-weight="bold">protection live inside the layer, written once.</text>

  <rect x="446" y="236" width="410" height="210" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="258" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">WRITE-THROUGH (synchronous, both updated)</text>
  <text x="466" y="282" fill="#166534" font-size="10">1. App: cache.Put(key, value)</text>
  <text x="466" y="302" fill="#166534" font-size="10">2. Cache writes STORE synchronously</text>
  <text x="466" y="322" fill="#166534" font-size="10">3. Cache updates ITSELF</text>
  <text x="466" y="342" fill="#166534" font-size="10">4. Only THEN does Put return</text>
  <text x="466" y="362" fill="#b91c1c" font-size="10" font-weight="bold">Cost: every write pays store + cache latency</text>
  <rect x="466" y="378" width="366" height="52" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="482" y="399" fill="#15803d" font-size="9" font-weight="bold">Guarantee: when Put returns, cache == store.</text>
  <text x="482" y="416" fill="#15803d" font-size="9" font-weight="bold">No write-path read-write race; just-written = hit.</text>
</svg>
```

### The loader/writer abstraction as inversion of control

It is worth dwelling on *why* the loader and writer are the whole design, because it reframes what a cache is. In cache-aside the application is in charge: it decides when to read the store, when to write it, when to populate, when to invalidate — the cache is a passive box of `GET`/`SET`. In read-through/write-through that control is *inverted*: the application hands the layer two callbacks and thereafter only ever says "give me this key" or "store this key", and the *layer* decides when to invoke the callbacks. This is the same inversion that distinguishes a library you call from a framework that calls you, and it has the same consequence — the framework (here, the caching layer) can enforce policy uniformly because it, not you, drives the interaction.

That inversion is what makes the correctness guarantees enforceable rather than hoped-for. Because the layer owns the moment of population, it can wrap that moment in a lock; because it owns the moment of write, it can serialise it against reads; because it owns both, it can guarantee they do not interleave badly. In cache-aside those same guarantees would require every call site to cooperate on a locking convention, which no codebase reliably does. The loader/writer pair is not merely a convenience to remove boilerplate — it is the mechanism by which the hard concurrency control gets a single owner. The cost of that inversion is the cost of all inversions of control: you give up the ability to do something bespoke at a particular call site, because the layer, not the call site, is now in charge.

### Consistency guarantees, and where they stop

Be precise about what write-through does and does not guarantee. It guarantees that *after a `Put` returns*, the cache and the store agree — the write-path staleness of cache-aside is gone. It does **not** eliminate the read-through population race on the read side: if you also read-through, a concurrent read that misses and is mid-load can still, in principle, populate around a write unless the layer serialises them. Well-built layers close this by taking a per-key lock that covers both the loader populate and the write-through update, so a populate cannot overwrite a newer write. It also does not make writes atomic across cache and store — that is a distributed-transaction problem, and the pragmatic answer is "store is authoritative; on cache-write failure, invalidate rather than leave a divergent cache." So the guarantee is strong on the write path and only as strong as the layer's locking on the read path — which is precisely the value of centralising the logic: the hard locking is written once, inside the layer, rather than hoped-for at every call site.

## 4. Architecture & Workflow

The workflow for a combined read-through/write-through layer:

1. **Construct the layer** with a `loader(key) -> (value, found, error)` and a `writer(key, value) -> error`. These are the *only* places store access lives.
2. **Read — `Get(key)`.** The layer checks Redis. On a hit it returns immediately. On a miss it acquires a per-key lock (to collapse stampedes), calls `loader`, populates Redis with a jittered TTL (or a negative marker if not found), releases the lock, and returns.
3. **Write — `Put(key, value)`.** The layer, under the same per-key lock, calls `writer` to persist to the store synchronously; on success it updates Redis with the new value (write-through); on cache-write failure it *invalidates* the key so the next read reloads. Only then does `Put` return.
4. **Partial-failure policy.** If `writer` fails, the whole `Put` fails and nothing is cached — the store is unchanged, the cache is untouched, the caller retries. If `writer` succeeds but the cache update fails, the store is authoritative and the cache is invalidated, so correctness is preserved at the cost of a future miss.
5. **Proxy variant.** Instead of an in-process library, the same behaviour can live in an out-of-process *caching proxy* (a sidecar or a service) that many application instances share, so the loader/writer are configured once for the whole fleet rather than linked into each service.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="wf1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Combined read-through / write-through layer (locking makes it correct)</text>

  <rect x="40" y="44" width="150" height="34" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="115" y="66" text-anchor="middle" fill="#1e40af" font-weight="bold">Application</text>

  <rect x="300" y="44" width="280" height="240" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="66" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Caching layer</text>
  <text x="316" y="88" fill="#1e3a8a" font-size="10" font-weight="bold">Get(key):</text>
  <text x="326" y="106" fill="#1e40af" font-size="9">check Redis; HIT &#8594; return</text>
  <text x="326" y="122" fill="#1e40af" font-size="9">MISS &#8594; lock, loader(), populate EX ttl</text>
  <text x="316" y="150" fill="#1e3a8a" font-size="10" font-weight="bold">Put(key, val):</text>
  <text x="326" y="168" fill="#166534" font-size="9">lock, writer() &#8594; store (synchronous)</text>
  <text x="326" y="184" fill="#166534" font-size="9">on OK: update Redis with val</text>
  <text x="326" y="200" fill="#b91c1c" font-size="9">on cache-fail: invalidate (store wins)</text>
  <rect x="316" y="214" width="248" height="58" rx="6" fill="#fff" stroke="#93c5fd"/>
  <text x="332" y="234" fill="#1e40af" font-size="9" font-weight="bold">per-key lock covers BOTH populate</text>
  <text x="332" y="250" fill="#1e40af" font-size="9" font-weight="bold">and write-through, so a slow loader</text>
  <text x="332" y="266" fill="#1e40af" font-size="9" font-weight="bold">cannot overwrite a newer write.</text>

  <rect x="690" y="60" width="150" height="34" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="765" y="82" text-anchor="middle" fill="#92400e" font-weight="bold">Redis</text>
  <rect x="690" y="220" width="150" height="34" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="765" y="242" text-anchor="middle" fill="#166534" font-weight="bold">Store (DB)</text>

  <path d="M190,61 L296,61" stroke="#64748b" stroke-width="1.5" marker-end="url(#wf1)"/>
  <text x="243" y="54" text-anchor="middle" fill="#334155" font-size="9">Get / Put</text>
  <path d="M580,80 L686,80" stroke="#64748b" stroke-width="1.5" marker-end="url(#wf1)"/>
  <text x="633" y="72" text-anchor="middle" fill="#334155" font-size="9">cache ops</text>
  <path d="M580,200 L686,232" stroke="#64748b" stroke-width="1.5" marker-end="url(#wf1)"/>
  <text x="628" y="228" text-anchor="middle" fill="#334155" font-size="9">loader / writer</text>

  <rect x="40" y="300" width="800" height="80" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="322" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Partial-failure policy (the part people forget)</text>
  <text x="56" y="344" fill="#166534" font-size="10">writer fails &#8594; whole Put fails, store unchanged, cache untouched, caller retries.</text>
  <text x="56" y="362" fill="#166534" font-size="10">writer OK but cache update fails &#8594; store is authoritative, INVALIDATE the key, next read reloads. Never leave cache &gt; store.</text>
</svg>
```

## 5. Implementation

A read-through/write-through wrapper in Go over `github.com/redis/go-redis/v9`. It centralises the read and write paths behind `Get`/`Put`, uses a per-key lock via singleflight for the read path, writes through synchronously on the write path, and defines the partial-failure policy explicitly.

```go
package throughcache

import (
	"context"
	"encoding/json"
	"errors"
	"math/rand"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

var ErrNotFound = errors.New("not found")

// Loader fetches a value from the underlying store on a cache miss. found=false
// means "the store has no such key" (so we negative-cache it).
type Loader[V any] func(ctx context.Context, key string) (value V, found bool, err error)

// Writer persists a value to the underlying store. Write-through calls this
// SYNCHRONOUSLY before updating the cache and returning.
type Writer[V any] func(ctx context.Context, key string, value V) error

// Cache is a read-through / write-through layer. The application calls Get/Put
// and NEVER touches the store directly — the layer owns all store access via the
// loader and writer. That single ownership shift is what distinguishes this from
// cache-aside.
type Cache[V any] struct {
	rdb    *redis.Client
	loader Loader[V]
	writer Writer[V]
	ttl    time.Duration
	negTTL time.Duration
	group  singleflight.Group // collapses concurrent misses into one loader call
}

func New[V any](rdb *redis.Client, l Loader[V], w Writer[V], ttl time.Duration) *Cache[V] {
	return &Cache[V]{rdb: rdb, loader: l, writer: w, ttl: ttl, negTTL: 30 * time.Second}
}

const negMarker = "\x00__NULL__"

func (c *Cache[V]) jitter(base time.Duration) time.Duration {
	// +/-10% jitter so keys populated together do not expire in lockstep.
	return base - base/10 + time.Duration(rand.Int63n(int64(base)/5))
}

// Get is READ-THROUGH. The caller asks the cache; the cache transparently loads
// from the store on a miss. A hit and a miss differ only in latency — the caller
// writes no store code at all.
func (c *Cache[V]) Get(ctx context.Context, key string) (V, error) {
	var zero V

	// 1. Check the cache.
	raw, err := c.rdb.Get(ctx, key).Result()
	if err == nil {
		if raw == negMarker {
			return zero, ErrNotFound // honoured negative cache: no store access.
		}
		var v V
		if json.Unmarshal([]byte(raw), &v) == nil {
			return v, nil // HIT.
		}
		// corrupt entry: fall through and reload.
	} else if err != redis.Nil {
		return zero, err // real Redis error; caller decides whether to degrade.
	}

	// 2. MISS. Collapse concurrent misses on this key into ONE loader call. This is
	// the stampede protection that, in cache-aside, every call site had to add
	// itself — here it is written once, inside the layer.
	v, err, _ := c.group.Do(key, func() (any, error) {
		value, found, lErr := c.loader(ctx, key)
		if lErr != nil {
			return zero, lErr
		}
		if !found {
			c.rdb.Set(ctx, key, negMarker, c.jitter(c.negTTL)) // negative cache.
			return zero, ErrNotFound
		}
		if data, mErr := json.Marshal(value); mErr == nil {
			c.rdb.Set(ctx, key, data, c.jitter(c.ttl)) // populate on behalf of caller.
		}
		return value, nil
	})
	if err != nil {
		return zero, err
	}
	return v.(V), nil
}

// Put is WRITE-THROUGH. The value is written SYNCHRONOUSLY to the store first,
// then into the cache, and only then does Put return. When it returns, the cache
// and the store agree: there is no write-path read-write race. The cost is that
// every write pays store latency PLUS cache latency, in series.
func (c *Cache[V]) Put(ctx context.Context, key string, value V) error {
	// 1. Write through to the store synchronously. The store is the source of
	// truth, so it goes first: if this fails, we cache nothing and the caller
	// retries against an unchanged store.
	if err := c.writer(ctx, key, value); err != nil {
		return err
	}

	// 2. Update the cache with the just-written value so a following read is a
	// guaranteed hit. NOTE: unlike cache-aside we CAN safely SET here rather than
	// DEL, because write-through is the single serialised writer for this key — we
	// are not racing two independent cache updates. (If reads can populate
	// concurrently, wrap steps 1-2 in a per-key distributed lock; see chapter 14.)
	data, err := json.Marshal(value)
	if err != nil {
		// We cannot cache it, but the store IS updated. Invalidate so the next read
		// reloads the fresh value rather than serving a stale one. Store wins.
		return c.rdb.Del(ctx, key).Err()
	}
	if err := c.rdb.Set(ctx, key, data, c.jitter(c.ttl)).Err(); err != nil {
		// Cache write failed but the store succeeded: invalidate rather than leave a
		// divergent cache. Never let the cache hold something the store does not.
		c.rdb.Del(ctx, key)
		return nil // the write itself succeeded; the cache will repopulate on read.
	}
	return nil
}
```

The wrapper is the whole point: every read and every write in the application becomes `cache.Get`/`cache.Put`, and the correctness — stampede collapse, negative caching, jittered TTL, synchronous write-through, partial-failure invalidation — lives in exactly one place. Note the one line where write-through legitimately uses `SET` rather than the cache-aside `DEL`: because the layer is the single serialised writer for the key, there is no second independent updater to race with, so overwriting is safe *here* in a way it is not in cache-aside.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Centralised, un-duplicated logic.** Check-load-populate and write-through are written once inside the layer; no call site can forget the TTL or update-instead-of-delete.
- **Transparent to the application.** Callers write store-agnostic code — `Get`/`Put` — and a hit versus a miss differs only in latency.
- **Strong write-path consistency (write-through).** When a `Put` returns, the cache and the store agree; there is no write-path read-write race.
- **Warm-on-write.** The just-written value is already cached, so a following read is a guaranteed hit — good for write-then-read workloads.
- **A natural home for hard correctness.** Per-key locking, stampede collapse, and partial-failure policy live in one audited place.

**Disadvantages**
- **The layer is a dependency.** Correctness and availability now depend on the caching layer being right and up; a bug there affects every call site.
- **Write-through latency tax.** Every write pays store *and* cache latency synchronously, on the critical path.
- **Wasted caching of write-rarely-read data.** Write-through caches everything written, even values nobody reads back — pure overhead for such workloads.
- **Hidden store failures.** Because the store is behind the layer, its failures surface as cache errors, which can obscure what actually broke.
- **Less per-site flexibility.** Different call sites that want to cache the same data differently are harder to accommodate than in explicit cache-aside.

**Trade-offs**
- *Centralisation vs control:* read-/write-through remove duplication and mistakes but take away the per-site explicit control that cache-aside gives; choose by whether uniformity or flexibility matters more.
- *Write-through consistency vs write latency:* the synchronous double write buys a strong post-write consistency guarantee at the cost of latency on every write; if writes are latency-sensitive and rarely read back, prefer write-behind or write-around (chapter 10).
- *Library vs proxy:* an in-process library is simplest but must be linked into every service and language; a caching proxy centralises the loader/writer for the whole fleet at the cost of an extra network hop and an operational component.
- *SET vs DEL on write:* write-through can safely `SET` because it is the serialised writer, whereas cache-aside must `DEL`; that difference only holds while the layer truly serialises writes and reads for the key.

## 7. Common Mistakes & Best Practices

- **Assuming write-through reduces store load.** It does not — every write still hits the store synchronously. *Best practice:* use write-through for consistency and warm-on-write, and reach for write-behind (chapter 10) when you actually need to reduce or batch store writes.
- **No partial-failure policy.** If the store write succeeds but the cache write fails and you do nothing, the cache diverges. *Best practice:* on cache-write failure after a successful store write, invalidate the key so the store stays authoritative.
- **Caching write-rarely-read data through the cache.** Write-through pollutes the cache with values nobody reads back. *Best practice:* use write-around for write-once-read-rarely data.
- **Letting a read-through populate race a write-through update.** Without a lock covering both, a slow loader can overwrite a newer write. *Best practice:* take a per-key lock (local singleflight and, across processes, a distributed lock) that spans populate and write-through.
- **Treating the loader as infallible.** A loader that cannot distinguish "not found" from "store error" will negative-cache real errors. *Best practice:* return an explicit `found bool` separate from `error`, and never cache on error.
- **Leaking store failures as opaque cache errors.** Callers cannot tell a Redis outage from a database outage. *Best practice:* wrap and classify errors so operators can see which tier failed.
- **A single giant shared layer with no per-key TTL control.** One global TTL rarely fits every keyspace. *Best practice:* make TTL (and negative TTL) configurable per keyspace or per loader.
- **Best practice overall:** register loader and writer once, lock per key across read and write paths, define the partial-failure policy, and keep TTL configurable — then every call site is correct for free.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Because store access is hidden behind the layer, instrument the loader and writer with their own latency and error metrics — otherwise a database slowdown looks like "the cache is slow." Log every partial-failure invalidation (store-ok, cache-fail) because a burst of them signals Redis trouble that is silently degrading your consistency guarantee. When a value looks stale, confirm whether the write path's `SET` or the invalidation actually ran, since the whole promise of write-through is that it did.
- **Monitoring.** Track hit ratio (read-through effectiveness), write-through write latency split into store-time and cache-time (to attribute the tax), and loader error rate. A rising write latency dominated by store-time is a database problem surfacing through the layer; dominated by cache-time is a Redis problem. Alert on partial-failure invalidations per minute.
- **Security.** The layer is now the single choke point for store access, which is a security *advantage* — you can enforce authorization, field-level redaction, and audit logging in one place rather than at every call site. It also means the layer's credentials reach both Redis and the store, so protect them accordingly (TLS to both, least-privilege store credentials, `requirepass`/ACLs on Redis — chapter 29). A caching proxy shared across services must authenticate its clients so one tenant cannot read another's keys.
- **Scaling.** Read-through scales like cache-aside — shard keys across a Redis Cluster. Write-through's synchronous double write means write throughput is bounded by the *slower* of the store and the cache, so a slow store caps write throughput even though the cache is fast; if that becomes the bottleneck and you can relax consistency, write-behind (chapter 10) decouples them. A caching proxy adds a network hop but lets you scale the caching tier independently of the application tier and share a warm cache across many stateless app instances.

## 9. Interview Questions

**Q: What is read-through caching and how does it differ from cache-aside's read path?**
A: Read-through is cache-aside's read path relocated into a caching layer. The behaviour is the same — check the cache, and on a miss load from the store and populate — but instead of the application performing those steps, the application calls a single `Get(key)` on the cache and the cache internally invokes a loader you registered to fetch from the store on a miss. The difference is *who owns the store access*: in cache-aside the application does, explicitly and at every read site; in read-through the caching layer does, once, behind the loader. The practical effect is that the check-load-populate logic, with its TTL and stampede handling, is written once and every caller inherits it correctly, at the cost of depending on the layer and hiding the store behind it.

**Q: What is write-through and what consistency does it give you?**
A: Write-through writes the value synchronously through the caching layer to the underlying store: on a `Put`, the layer writes the store and updates the cache as one operation and does not return until both are done. The consistency guarantee is that *after the `Put` returns, the cache and the store agree* — there is no window where a read sees a stale cache relative to a completed write, which is the write-path read-write race that plagues cache-aside. It also warms the cache with the just-written value, so a subsequent read is a guaranteed hit. That guarantee is bought with latency: every write pays the store write plus the cache write, synchronously, on the critical path.

**Q: Does write-through reduce load on the database?**
A: No. Every write still hits the store synchronously — write-through does not batch, coalesce, or defer anything. Its benefits are consistency (cache and store agree after the write) and warm-on-write (the value is cached immediately), not reduced store load. If your goal is to reduce or batch store writes, that is write-behind (write-back), which acknowledges the write after updating only the cache and flushes to the store asynchronously in batches — a different pattern with a durability trade-off. Confusing the two is a common mistake.

**Q: Who owns access to the store in each pattern, and why does it matter?**
A: In cache-aside the application owns store access — it reads and writes both the cache and the database explicitly. In read-through/write-through the caching layer owns it — the application only ever talks to the cache, and the store is reached solely through the loader and writer callbacks. It matters because ownership decides where the caching logic and its correctness live. Application ownership means explicit control but duplicated, error-prone logic at every call site; layer ownership means centralised, uniform, harder-to-get-wrong logic but a dependency on the layer and hidden store failure modes. Almost every design decision between the patterns flows from this one question.

**Q: When is write-through the wrong choice?**
A: When data is written far more often than it is read back, because write-through caches every written value synchronously and you pay the cache-write latency and memory for values nobody fetches — write-around, which writes straight to the store and bypasses the cache, fits that write-once-read-rarely profile. It is also wrong when write latency is critical and you can tolerate a small durability risk, in which case write-behind's asynchronous, batched flush is better. And it is wrong when you need cross-cache-and-store atomicity that a synchronous double write cannot truly provide — then you must design an explicit partial-failure policy or a different consistency mechanism.

**Q: Why can write-through safely SET the cache when cache-aside must DEL?**
A: Because write-through is the single serialised writer for the key. In cache-aside, two independent writers can each update the cache after committing, and their cache updates can reorder relative to their database commits, leaving the cache holding the losing write's value — so deleting is the only race-safe choice. In write-through, all writes for a key go through the one layer, which (with a per-key lock covering the store write and the cache update) serialises them, so overwriting the cache with the just-written value is safe: there is no second independent updater to disagree with. That safety holds only as long as the layer genuinely serialises writes for the key; if reads can populate concurrently, the lock must span the read-through populate too.

**Q: How does read-through handle a "not found", and why keep it separate from an error?**
A: The loader the caching layer calls should return an explicit "found" signal distinct from its error channel — for example `(value, found bool, err error)`. On `found == false` the layer negative-caches the absence with a short TTL and reports a miss to the caller, so repeated requests for a genuinely non-existent key are absorbed by the cache rather than falling through to the store every time. On a real `err`, the layer caches nothing and propagates the error, because caching an error would poison the key. Collapsing "not found" and "error" into one channel is a classic bug: it either negative-caches transient store errors (serving false "not found" until the short TTL clears) or treats a legitimately missing row as an error and never negative-caches it, reopening the penetration hole. Keeping them separate lets the layer do the right thing for each.

**Q: (Senior) How do you keep a combined read-through/write-through layer correct under concurrency, and where exactly are the races?**
A: There are two races and both are closed by a per-key lock that spans the right operations. The first is the read-side populate race: a read-through `Get` misses, calls the loader, and while the load is in flight a write-through `Put` updates the store and cache — if the slow loader then populates, it can overwrite the newer written value with the stale loaded one. The fix is to take a per-key lock that covers the loader call *and* its populate, the same lock the write path takes, so a populate and a write cannot interleave; the loader must also re-check the cache after acquiring the lock in case a write populated it while waiting. The second is the write-side partial-failure divergence: the store write succeeds but the cache update fails, leaving the cache stale — closed not by locking but by policy, invalidating the key so the store stays authoritative. Within a single process a `singleflight` group gives the read-side collapse cheaply; across processes you need a distributed lock (`SET key NX PX` with a fencing token, chapter 14) because singleflight is per-process. The senior insight is that centralising into a layer does not remove these races — it *localises* them to one place where you can afford to implement the locking correctly, which is the entire value proposition over cache-aside's scattered logic.

**Q: (Senior) Compare the failure and latency profiles of write-through versus cache-aside for a write-heavy service, and how you would decide.**
A: Cache-aside's write is a store write plus a fast cache delete; the delete is best-effort and the TTL backstops a missed one, so write latency is essentially store latency and a cache outage does not fail writes. Write-through's write is a store write plus a synchronous cache write that must succeed or be compensated by an invalidation, so write latency is store-plus-cache and write throughput is bounded by the slower tier; a cache outage forces you into the partial-failure path on every write. For a write-heavy service the questions I would ask are: how often is written data read back soon (favouring write-through's warm-on-write), how sensitive is write latency (favouring cache-aside or write-behind), and how strong must post-write read consistency be (favouring write-through). If writes are frequent and rarely read back, I would not cache them on write at all — write-around. If writes are frequent, latency-sensitive, and I can accept a bounded durability risk, write-behind with batched flush. If I need the post-write consistency and the data is read back soon, write-through, accepting the latency tax and building the partial-failure invalidation carefully. The decision is a three-way trade among write latency, store load, and post-write consistency, and naming which of those the service actually cares about is what settles it.

**Q: (Senior) What does a caching proxy give you over an in-process read-through library, and what does it cost?**
A: A caching proxy moves the read-through/write-through layer out of the application process into a shared out-of-process component — a sidecar or a service — that many application instances, possibly in different languages, all talk to. The gains are that the loader and writer are configured once for the whole fleet rather than linked into every service, the caching tier can be scaled and operated independently of the application tier, a warm cache is shared across stateless app instances so a deploy or restart does not cold-start each one's cache, and cross-cutting concerns like authorization and audit sit in one enforced choke point. The costs are a real one: an extra network hop on every cache operation (latency and a new failure domain), an operational component you must run and make highly available, and the need to authenticate and isolate clients so one tenant cannot read another's keys. You would choose the proxy when you have many services or languages that must share caching behaviour and a warm cache, and stick with the in-process library when a single service or a single language dominates and the extra hop is not worth it.

**Q: What should the layer do if the store write succeeds but the cache update fails?**
A: Invalidate the key rather than leave the cache divergent. The store is the source of truth and it is already correct, so the danger is a cache that now holds an older value than the store; deleting the key forces the next read to reload the fresh value through the loader. The alternative outcomes are worse: doing nothing leaves a stale cache until the TTL expires, and failing the whole write is wrong because the write genuinely succeeded in the store and reporting failure would invite an incorrect retry. So the partial-failure policy is "store wins, invalidate the cache, report success" — the write happened, and correctness is preserved at the cost of one future miss. Every write-through implementation needs this policy defined explicitly, because partial failures between two systems are not an edge case, they are a certainty at scale.

## 10. Quick Revision & Cheat Sheet

| Aspect | Read-through | Write-through |
|---|---|---|
| Path | Read | Write |
| Who reaches the store | The cache, via loader | The cache, via writer |
| On miss / write | Loader loads &amp; populates | Writer persists, then cache updates |
| Synchronous? | Load is; hits are instant | Yes — store + cache before return |
| App sees the store? | No | No |
| Main benefit | Centralised read logic | Post-write consistency + warm cache |
| Main cost | Layer dependency | Latency tax per write |

| vs cache-aside | Difference |
|---|---|
| Store ownership | Layer owns it, not the app |
| Write op on cache | Can `SET` (serialised writer) vs must `DEL` |
| Logic location | Once in the layer vs at every call site |
| Failure surface | Store errors appear as cache errors |

**Flash cards**
- **Read-through?** &#8594; cache loads from store on miss via a registered loader; app calls only the cache.
- **Write-through?** &#8594; write synchronously through the cache to the store; cache == store when it returns.
- **Defining difference from cache-aside?** &#8594; the cache, not the app, owns store access.
- **Does write-through cut store load?** &#8594; no; every write still hits the store (that's write-behind).
- **Write-through's cost?** &#8594; synchronous store + cache latency on every write.
- **Why can write-through SET not DEL?** &#8594; it's the single serialised writer; no racing updater.
- **Partial-failure policy?** &#8594; store-ok/cache-fail &#8594; invalidate; never leave the cache holding what the store does not.
- **Library vs proxy?** &#8594; library is simplest per-service; proxy shares a warm cache and one config across a fleet at an extra hop.

## 11. Hands-On Exercises & Mini Project

- [ ] Build a read-through `Get` with a registered loader and confirm the application code contains no store access at all.
- [ ] Add a write-through `Put` and measure the added latency versus a cache-aside write on the same store.
- [ ] Force a cache-write failure after a successful store write and confirm your partial-failure policy invalidates rather than diverges.
- [ ] Add a per-key lock spanning the loader populate and the write-through update, then write a concurrency test that would otherwise let a slow loader overwrite a newer write.
- [ ] Swap the loader for one that distinguishes "not found" from "error" and confirm errors are never negative-cached.
- [ ] Split write latency into store-time and cache-time metrics and show which tier dominates under load.
- [ ] Add a per-keyspace TTL/loader config and route two different data types through one shared layer with different policies.
- [ ] Measure the read hit ratio before and after wrapping a cache-aside codebase in a read-through layer, and confirm the logic is now in exactly one place.

### Mini Project — "Through-Cache Library with a Proxy Mode"

**Goal.** Build a read-through/write-through library, prove its consistency and partial-failure behaviour, then expose the same behaviour as an out-of-process proxy to feel the library-vs-proxy trade-off.

**Requirements.**
1. Implement a generic `Cache[V]` with registered loader and writer, per-key TTL/negative TTL, singleflight stampede collapse, and jittered TTLs.
2. Implement write-through with an explicit partial-failure policy (store-ok/cache-fail invalidates) and prove it with a fault-injecting Redis stub.
3. Add a per-key lock spanning read-through populate and write-through update, and a concurrency harness that demonstrates the populate-vs-write race is closed.
4. Instrument loader/writer latency and error rates separately from cache latency.
5. Wrap the library in a tiny HTTP/gRPC proxy so multiple client processes share it, and measure the extra hop's latency against the in-process version.

**Extensions.**
- Add a distributed lock (`SET NX PX` with a fencing token) so the populate/write serialisation holds across processes, not just within one (chapter 14).
- Add per-keyspace configuration (TTL, negative TTL, loader) so one shared layer serves several data types with different policies.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Design: Cache-Aside (Lazy Loading)* (the explicit alternative), *Write-Behind & Write-Around* (async and bypass writes), *TTL Strategy, Refresh-Ahead & Adaptive Expiry* (freshness inside the layer), *Distributed Locks with Redis* (serialising populate and write across processes), *Cache Consistency & Invalidation Strategies* (the guarantees this layer provides).

- **AWS — Caching strategies: Write-Through** — AWS ElastiCache · *Intermediate* · the canonical vendor-neutral description of write-through and its latency and staleness trade-offs versus lazy loading. <https://docs.aws.amazon.com/AmazonElastiCache/latest/red-ug/Strategies.html>
- **Redis — Client-side caching (RESP3 invalidation)** — Redis · *Advanced* · how a caching layer can be kept consistent with server-assisted invalidation, relevant to keeping a through-cache fresh. <https://redis.io/docs/latest/develop/use/client-side-caching/>
- **Caffeine — LoadingCache & CacheLoader** — Ben Manes · *Intermediate* · the reference design for a read-through loader and write-through writer in a mature caching library, worth studying even from Go. <https://github.com/ben-manes/caffeine/wiki/Population>
- **Designing Data-Intensive Applications, ch. 5 & 9** — Martin Kleppmann · *Advanced* · the consistency vocabulary for reasoning about what "cache == store after the write" actually guarantees. <https://dataintensive.net/>
- **golang.org/x/sync/singleflight** — Go team · *Intermediate* · the per-process miss-collapse primitive used in the read-through path. <https://pkg.go.dev/golang.org/x/sync/singleflight>
- **Ehcache — Cache-through patterns (CacheLoaderWriter)** — Terracotta/Ehcache · *Intermediate* · a clear articulation of the combined read-through/write-through "cache-through" contract and its loader/writer abstraction. <https://www.ehcache.org/documentation/3.10/caching-patterns.html>
- **Redis — SET and key expiration options** — Redis · *Beginner* · the `SET ... EX`, `NX`, and `GET` options the layer uses to populate and to lock. <https://redis.io/docs/latest/commands/set/>
- **Redis University — RU101: Introduction to Redis** — Redis · *Beginner* · free course whose caching section contrasts cache-aside with read-/write-through in practice. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 09.*
