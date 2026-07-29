# 15 · Design: Cache Stampede (Thundering Herd) & Mitigations

> **In one line:** A cache stampede is what happens when a single hot key expires and every concurrent request misses at the same instant, converting your cache from a shield into an amplifier that fires the whole herd at the database at once — and the fix is always the same idea in four disguises: let *one* request do the recompute while the rest wait, serve stale, or never all miss together.

---

## 1. Overview

A cache exists to absorb read load so the origin — usually a database — sees a tiny fraction of the traffic. The unspoken assumption is that a cache miss is *rare* and *uncorrelated*: one request occasionally finds nothing, fetches from the origin, repopulates, and everyone after it is served from cache again. Cache stampede is the failure of that assumption. When a *hot* key — one served to thousands of requests per second — expires, every in-flight request misses **simultaneously**, and every one of them independently decides to recompute the value from the origin. The cache did not fail; it did exactly what you told it to. But for the few hundred milliseconds it takes to recompute, the database receives the full unfiltered read load it has never been sized for, and it can fall over. This is the **thundering herd** (also called the **dogpile** effect).

The mechanism is worth stating precisely because the fix depends on understanding it. It is not that the value is expensive to compute — it is that N requests compute it *at the same time* when one would have done. If your homepage feed takes 400 ms to build and gets 5,000 requests per second, then in the 400 ms after its cache entry expires, ~2,000 requests all miss, all start building the feed, and all hammer the database with the same expensive query at once. The database, sized to serve one such query every few minutes, now serves 2,000 in a burst. Latency spikes, connections saturate, timeouts cascade, and — the cruel part — every one of those 2,000 recomputes *then writes the same value back*, so 1,999 of them were pure waste.

This chapter is framed as a **design-round** topic because it is one of the most common senior-level system-design questions, and because the four canonical fixes — **per-key locking**, **singleflight (request coalescing)**, **probabilistic early recompute (XFetch)**, and **stale-while-revalidate** — each embody a different trade-off between latency, staleness, and complexity. Knowing all four and when to reach for each is the mark of someone who has actually run a cache in production.

## 2. Core Concepts

- **Cache stampede / thundering herd / dogpile** — the three names for the same event: many concurrent requests miss the same key at once and all hit the origin.
- **Hot key** — a key with a high enough request rate that its expiry coincides with many in-flight requests (chapter 17 goes deeper on hot keys).
- **Recompute cost** — the origin work to rebuild a value; the *duration* of this window is how long the herd has to pile up.
- **Coalescing / de-duplication** — collapsing N concurrent misses for the same key into *one* origin call whose result is shared.
- **Per-key mutex/lock** — a lock (local or distributed) that lets exactly one request recompute while the others wait or serve stale.
- **Singleflight** — Go's `golang.org/x/sync/singleflight`: in-process coalescing so duplicate concurrent calls for the same key share one execution.
- **Distributed lock** — `SET NX PX` across a Redis cluster so only one *process* (not just one goroutine) recomputes.
- **Probabilistic early recompute (XFetch)** — recompute *before* expiry, with a probability that rises as expiry approaches, so one lucky request refreshes ahead of the stampede.
- **Stale-while-revalidate (SWR)** — serve the expired value immediately while one background worker refreshes it; nobody waits, nobody stampedes.
- **Fencing / logical vs physical TTL** — separating "when the value is considered stale" from "when Redis physically deletes the key", which SWR and XFetch both rely on.

## 3. Theory & Principles

### The mechanism: correlated misses are the enemy

The whole problem reduces to one word: **correlation**. A cache is sized on the assumption that misses are independent — spread out in time so the origin sees a trickle. A stampede is what happens when misses become perfectly correlated: they all occur in the same short window because they all depend on the same key with the same expiry time. The load the origin sees is not the *average* miss rate but the *instantaneous* one, and for a hot key at expiry that instantaneous rate is the full request rate.

Concretely, if a key receives `R` requests per second and the recompute takes `T` seconds, then at the moment of expiry roughly `R × T` requests will miss before the first recompute finishes and repopulates the cache. With `R = 5000` and `T = 0.4s`, that is 2,000 simultaneous origin calls for a value that needed to be computed *once*. Every fix below attacks one of the two multiplicands: reduce `R` (the number of requests that reach the origin — locking, singleflight coalesce N down to 1) or reduce `T`'s relevance (SWR and XFetch make sure the recompute happens *before* anyone is waiting on a miss, so `T` never overlaps live traffic).

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="s1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="s2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The stampede: a hot key expires and N misses become 1 origin call &#8594; N</text>

  <rect x="24" y="42" width="410" height="400" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">WITHOUT protection: the herd</text>
  <text x="229" y="82" text-anchor="middle" fill="#991b1b" font-size="9">hot key TTL expires at t=0</text>

  <g font-size="9">
    <rect x="42" y="96" width="120" height="20" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="102" y="110" text-anchor="middle" fill="#b91c1c">req 1: MISS</text>
    <rect x="42" y="120" width="120" height="20" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="102" y="134" text-anchor="middle" fill="#b91c1c">req 2: MISS</text>
    <rect x="42" y="144" width="120" height="20" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="102" y="158" text-anchor="middle" fill="#b91c1c">req 3: MISS</text>
    <rect x="42" y="168" width="120" height="20" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="102" y="182" text-anchor="middle" fill="#b91c1c">... req N: MISS</text>
  </g>
  <path d="M164,106 L232,150" stroke="#dc2626" stroke-width="1.5" marker-end="url(#s1)"/>
  <path d="M164,130 L232,158" stroke="#dc2626" stroke-width="1.5" marker-end="url(#s1)"/>
  <path d="M164,154 L232,166" stroke="#dc2626" stroke-width="1.5" marker-end="url(#s1)"/>
  <path d="M164,178 L232,174" stroke="#dc2626" stroke-width="1.5" marker-end="url(#s1)"/>

  <rect x="236" y="150" width="176" height="80" rx="8" fill="#fecaca" stroke="#dc2626" stroke-width="2"/>
  <text x="324" y="176" text-anchor="middle" fill="#7f1d1d" font-size="11" font-weight="bold">DATABASE</text>
  <text x="324" y="196" text-anchor="middle" fill="#991b1b" font-size="9">N identical expensive</text>
  <text x="324" y="210" text-anchor="middle" fill="#991b1b" font-size="9">queries AT ONCE</text>

  <rect x="42" y="256" width="370" height="170" rx="8" fill="#fff" stroke="#fca5a5"/>
  <text x="227" y="278" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">R req/s &#215; T recompute seconds = R&#215;T misses</text>
  <text x="58" y="300" fill="#991b1b" font-size="9">R = 5000 req/s, T = 0.4s &#8594; ~2000 simultaneous queries</text>
  <text x="58" y="320" fill="#991b1b" font-size="9">for a value that needed computing ONCE.</text>
  <text x="58" y="344" fill="#7f1d1d" font-size="9" font-weight="bold">Consequences:</text>
  <text x="58" y="362" fill="#991b1b" font-size="9">&#8226; DB connection pool saturates, latency spikes</text>
  <text x="58" y="380" fill="#991b1b" font-size="9">&#8226; timeouts cascade to upstream services</text>
  <text x="58" y="398" fill="#991b1b" font-size="9">&#8226; 1999 of 2000 recomputes are pure waste</text>
  <text x="58" y="416" fill="#991b1b" font-size="9">&#8226; can take the origin fully down (outage)</text>

  <rect x="446" y="42" width="410" height="400" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">WITH coalescing: one recompute</text>
  <text x="651" y="82" text-anchor="middle" fill="#166534" font-size="9">one leader recomputes; followers wait/serve stale</text>

  <g font-size="9">
    <rect x="464" y="96" width="120" height="20" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="524" y="110" text-anchor="middle" fill="#166534">req 1: leader</text>
    <rect x="464" y="120" width="120" height="20" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="524" y="134" text-anchor="middle" fill="#166534">req 2: follower</text>
    <rect x="464" y="144" width="120" height="20" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="524" y="158" text-anchor="middle" fill="#166534">req 3: follower</text>
    <rect x="464" y="168" width="120" height="20" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="524" y="182" text-anchor="middle" fill="#166534">... req N: follower</text>
  </g>
  <path d="M586,106 L654,150" stroke="#16a34a" stroke-width="2" marker-end="url(#s2)"/>
  <path d="M586,130 L648,158" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3"/>
  <path d="M586,154 L648,166" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3"/>
  <path d="M586,178 L648,174" stroke="#94a3b8" stroke-width="1" stroke-dasharray="3,3"/>

  <rect x="658" y="150" width="176" height="80" rx="8" fill="#bbf7d0" stroke="#16a34a" stroke-width="2"/>
  <text x="746" y="176" text-anchor="middle" fill="#14532d" font-size="11" font-weight="bold">DATABASE</text>
  <text x="746" y="196" text-anchor="middle" fill="#166534" font-size="9">exactly ONE query</text>
  <text x="746" y="210" text-anchor="middle" fill="#166534" font-size="9">followers share result</text>

  <rect x="464" y="256" width="370" height="170" rx="8" fill="#fff" stroke="#86efac"/>
  <text x="649" y="278" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">N misses collapse to 1 origin call</text>
  <text x="480" y="300" fill="#166534" font-size="9">The four fixes, each attacking R&#215;T:</text>
  <text x="480" y="320" fill="#166534" font-size="9">1. per-key lock &#8594; one recomputes, rest wait/stale</text>
  <text x="480" y="340" fill="#166534" font-size="9">2. singleflight &#8594; in-process coalescing to 1 call</text>
  <text x="480" y="360" fill="#166534" font-size="9">3. XFetch &#8594; refresh BEFORE expiry (T never overlaps)</text>
  <text x="480" y="380" fill="#166534" font-size="9">4. stale-while-revalidate &#8594; serve stale, refresh in bg</text>
  <text x="480" y="404" fill="#15803d" font-size="9" font-weight="bold">Origin load: from R&#215;T down to ~1 per TTL period.</text>
</svg>
```

### The four fixes and the axis they trade on

Every mitigation lives on a spectrum between two extremes: **make callers wait** (correct, fresh, but adds latency) versus **serve stale** (fast, never blocks, but returns an out-of-date value). The four techniques place themselves differently:

- **Per-key mutex/lock** — one request acquires the lock and recomputes; the others *block* on the lock, then read the freshly-populated cache. Freshest possible for the waiters, at the cost of added latency and the risk of a lock convoy. A local mutex handles many goroutines in one process; a *distributed* lock (`SET NX PX`) handles many processes.
- **Singleflight** — the in-process, Go-idiomatic form of per-key coalescing. Concurrent goroutines calling for the same key share a single execution and all receive its result. Zero staleness, minimal latency, but only coalesces *within one process*, so a fleet of 50 pods can still send up to 50 concurrent origin calls (one per pod) — pair it with a distributed lock or SWR for cross-process protection.
- **Probabilistic early recompute (XFetch)** — recompute *ahead* of expiry. Each read draws a random number; the closer the key is to expiry (and the more expensive it is to recompute), the higher the chance this particular read is chosen to refresh early. One lucky request rebuilds the value before it ever hard-expires, so the stampede window never opens. Elegant and low-latency; the classic result is from the paper *"Optimal Probabilistic Cache Stampede Prevention"* (Vattani, Chierichetti, Lowenstein).
- **Stale-while-revalidate** — the value carries a *logical* freshness deadline shorter than its *physical* TTL. When a read finds the value logically stale but physically present, it returns the stale value immediately and kicks off exactly one background refresh. Nobody ever waits on a recompute; the trade is that some callers see a slightly stale value during the refresh.

The reason to know all four is that they compose and they suit different SLAs. A read-your-writes profile that cannot tolerate staleness wants singleflight + a short blocking wait; a public feed that tolerates seconds of staleness wants SWR; a globally hot key that must never stampede across a fleet wants XFetch or a distributed lock underneath the local coalescing.

## 4. Architecture & Workflow

The production-grade pattern layers the fixes rather than picking one. A well-defended read path looks like this:

1. **Read the cache.** If present *and* logically fresh, return it — the common case, ~99% of reads.
2. **Present but logically stale (SWR).** Return the stale value immediately, and *attempt* to become the single background refresher (via singleflight or a short-TTL lock). Only one refresher wins; the rest return stale and move on.
3. **Absent (a real miss).** Now you must recompute and someone will wait. Coalesce: use singleflight so only one goroutine per process recomputes, and optionally a distributed `SET NX PX` lock so only one *process* across the fleet recomputes. Losers of the lock either wait briefly and re-read, or serve a stale/placeholder value if one exists.
4. **Repopulate** with a fresh value, a *jittered* physical TTL (chapter 17 — jitter avoids re-synchronising the herd), and a logical freshness stamp shorter than the physical TTL so SWR has a window to work in.
5. **XFetch overlay (optional).** On every read, run the probabilistic early-recompute check so hot keys are refreshed *before* they hard-expire, meaning step 3 (the real miss) almost never fires for hot keys at all.

The subtle design point: steps 2 and 5 mean the *expensive, blocking* path in step 3 is reserved for genuinely cold keys, where the herd is small by definition. The hot keys — the only ones that can stampede — are kept warm by background refresh and never reach the blocking recompute at all.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="f1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">A layered read path: reserve the blocking recompute for cold keys only</text>

  <rect x="360" y="40" width="160" height="40" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="60" text-anchor="middle" fill="#1e40af" font-weight="bold" font-size="11">read cache key</text>
  <text x="440" y="74" text-anchor="middle" fill="#1d4ed8" font-size="9">GET value + freshness stamp</text>

  <path d="M400,80 L200,120" stroke="#475569" stroke-width="1.5" fill="none" marker-end="url(#f1)"/>
  <path d="M440,80 L440,120" stroke="#475569" stroke-width="1.5" marker-end="url(#f1)"/>
  <path d="M480,80 L690,120" stroke="#475569" stroke-width="1.5" fill="none" marker-end="url(#f1)"/>

  <rect x="60" y="122" width="270" height="70" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="195" y="144" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">HIT &amp; fresh (~99%)</text>
  <text x="195" y="164" text-anchor="middle" fill="#166534" font-size="9">return immediately &#8212; no origin call</text>
  <text x="195" y="180" text-anchor="middle" fill="#166534" font-size="9">the common, cheap path</text>

  <rect x="345" y="122" width="190" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="144" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">HIT but stale (SWR)</text>
  <text x="440" y="162" text-anchor="middle" fill="#b45309" font-size="9">return STALE now +</text>
  <text x="440" y="178" text-anchor="middle" fill="#b45309" font-size="9">ONE bg refresh (coalesced)</text>

  <rect x="550" y="122" width="270" height="70" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="685" y="144" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">MISS (cold key)</text>
  <text x="685" y="162" text-anchor="middle" fill="#991b1b" font-size="9">someone MUST wait; coalesce hard:</text>
  <text x="685" y="178" text-anchor="middle" fill="#991b1b" font-size="9">singleflight + distributed SET NX PX</text>

  <rect x="345" y="222" width="190" height="66" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="244" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">XFetch overlay</text>
  <text x="440" y="262" text-anchor="middle" fill="#6d28d9" font-size="9">on every read, roll dice to</text>
  <text x="440" y="278" text-anchor="middle" fill="#6d28d9" font-size="9">refresh BEFORE hard expiry</text>
  <path d="M440,192 L440,222" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#f1)"/>

  <rect x="550" y="222" width="270" height="66" rx="8" fill="#fff" stroke="#dc2626"/>
  <text x="685" y="244" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">only ONE recomputes</text>
  <text x="685" y="262" text-anchor="middle" fill="#991b1b" font-size="9">losers wait &amp; re-read, or serve</text>
  <text x="685" y="278" text-anchor="middle" fill="#991b1b" font-size="9">a placeholder if one exists</text>
  <path d="M685,192 L685,222" stroke="#dc2626" stroke-width="1.5" marker-end="url(#f1)"/>

  <rect x="200" y="322" width="480" height="86" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="344" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">repopulate: fresh value + JITTERED physical TTL</text>
  <text x="440" y="364" text-anchor="middle" fill="#166534" font-size="9">logical freshness stamp &lt; physical TTL (gives SWR its window)</text>
  <text x="440" y="382" text-anchor="middle" fill="#166534" font-size="9">jitter avoids re-synchronising the herd (chapter 17)</text>
  <text x="440" y="400" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">Hot keys stay warm via XFetch/SWR &#8594; never reach the blocking path</text>
  <path d="M440,288 L440,322" stroke="#16a34a" stroke-width="1.5" marker-end="url(#f1)"/>
  <path d="M685,288 L560,322" stroke="#16a34a" stroke-width="1.5" fill="none" marker-end="url(#f1)"/>
</svg>
```

## 5. Implementation

Two production implementations in Go with `github.com/redis/go-redis/v9`: first **singleflight** (in-process coalescing), then a **distributed lock** with `SET NX PX` for cross-process protection, plus a **stale-while-revalidate** wrapper. Comments explain *why*.

```go
package stampede

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	mrand "math/rand"
	"time"

	"github.com/redis/go-redis/v9"
	"golang.org/x/sync/singleflight"
)

// ---------------------------------------------------------------------------
// 1. SINGLEFLIGHT: in-process coalescing.
//    Many goroutines asking for the same key share ONE origin call. This is
//    the cheapest, freshest fix and should be the default inner layer. Its
//    limit: it only coalesces WITHIN this process, so a 50-pod fleet can still
//    make up to 50 concurrent origin calls (one per pod). Combine with a
//    distributed lock (below) when a single key is hot across the whole fleet.
// ---------------------------------------------------------------------------

type Cache struct {
	rdb    *redis.Client
	group  singleflight.Group // coalesces concurrent calls by key
	loader func(ctx context.Context, key string) (string, error)
	ttl    time.Duration
}

func NewCache(rdb *redis.Client, ttl time.Duration,
	loader func(context.Context, string) (string, error)) *Cache {
	return &Cache{rdb: rdb, loader: loader, ttl: ttl}
}

// Get reads through the cache with stampede protection. On a miss, singleflight
// guarantees that of N concurrent goroutines for the same key, exactly ONE runs
// the loader; the other N-1 block and receive that one result.
func (c *Cache) Get(ctx context.Context, key string) (string, error) {
	// Fast path: a normal cache hit, no coalescing needed.
	if v, err := c.rdb.Get(ctx, key).Result(); err == nil {
		return v, nil
	} else if !errors.Is(err, redis.Nil) {
		return "", err // a real Redis error, not just a miss
	}

	// Slow path: MISS. singleflight.Do collapses the herd. The string key here
	// is the coalescing key — identical keys share one in-flight execution.
	v, err, _ := c.group.Do(key, func() (any, error) {
		// Double-check the cache inside the singleflight callback: while we were
		// queued, the leader for a PREVIOUS herd may already have populated it.
		if v, err := c.rdb.Get(ctx, key).Result(); err == nil {
			return v, nil
		}
		// We are the single leader for this herd. Do the expensive origin call
		// exactly once on behalf of everyone waiting.
		val, err := c.loader(ctx, key)
		if err != nil {
			return "", err
		}
		// Repopulate with a JITTERED TTL so keys populated together do not all
		// expire together next time (avalanche prevention, chapter 17).
		_ = c.rdb.Set(ctx, key, val, jitter(c.ttl)).Err()
		return val, nil
	})
	if err != nil {
		return "", err
	}
	return v.(string), nil
}

// jitter spreads a base TTL by +/-10% so a batch of keys written together do
// not re-synchronise and expire in the same instant.
func jitter(base time.Duration) time.Duration {
	delta := (mrand.Float64()*0.2 - 0.1) * float64(base) // range [-10%, +10%]
	return base + time.Duration(delta)
}

// ---------------------------------------------------------------------------
// 2. DISTRIBUTED LOCK: SET NX PX. Only one PROCESS across the fleet recomputes.
//    This is what singleflight cannot do alone. The lock value is a random
//    token so we only ever release OUR lock (fencing against releasing a lock
//    that has already expired and been re-acquired by someone else).
// ---------------------------------------------------------------------------

// releaseScript deletes the lock only if we still own it (value matches our
// token). Doing GET-then-DEL in the client is racy; this Lua runs atomically
// on Redis's single thread.
var releaseScript = redis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
else
    return 0
end`)

// GetWithLock recomputes under a distributed lock so exactly one process in the
// fleet hits the origin. Losers wait briefly and re-read the cache, which the
// winner will have populated. This trades a little latency for hard cross-fleet
// coalescing on a globally hot key.
func (c *Cache) GetWithLock(ctx context.Context, key string) (string, error) {
	if v, err := c.rdb.Get(ctx, key).Result(); err == nil {
		return v, nil
	} else if !errors.Is(err, redis.Nil) {
		return "", err
	}

	lockKey := "lock:" + key
	token := randToken() // unique per acquirer, so we only release our own lock

	// SET NX PX: acquire the lock IF-NOT-EXISTS with a physical timeout so a
	// crashed holder cannot deadlock everyone forever. The PX must exceed the
	// worst-case recompute time, or the lock expires mid-recompute and a second
	// process joins in (a small stampede, but bounded).
	ok, err := c.rdb.SetNX(ctx, lockKey, token, 5*time.Second).Result()
	if err != nil {
		return "", err
	}

	if !ok {
		// We LOST the lock. Someone else is recomputing. Poll the cache briefly
		// rather than joining the origin stampede — this is the whole point.
		return c.waitForValue(ctx, key, 5*time.Second)
	}

	// We WON the lock — recompute exactly once, then always release.
	defer releaseScript.Run(ctx, c.rdb, []string{lockKey}, token)

	val, err := c.loader(ctx, key)
	if err != nil {
		return "", err
	}
	if err := c.rdb.Set(ctx, key, val, jitter(c.ttl)).Err(); err != nil {
		return "", err
	}
	return val, nil
}

// waitForValue polls the cache for a value the lock winner is expected to
// populate. Short sleeps with a deadline; if it never appears (winner crashed),
// we give up and the caller can retry — better than hammering the origin.
func (c *Cache) waitForValue(ctx context.Context, key string, deadline time.Duration) (string, error) {
	end := time.Now().Add(deadline)
	for time.Now().Before(end) {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
		if v, err := c.rdb.Get(ctx, key).Result(); err == nil {
			return v, nil // the winner populated it — we served zero origin load
		} else if !errors.Is(err, redis.Nil) {
			return "", err
		}
	}
	return "", errors.New("stampede: timed out waiting for lock holder to populate cache")
}

func randToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ---------------------------------------------------------------------------
// 3. STALE-WHILE-REVALIDATE: never block on a recompute for a hot key.
//    We store the value together with a LOGICAL freshness deadline, under a
//    PHYSICAL TTL that is longer. A read that finds the value logically stale
//    returns it immediately and triggers ONE background refresh (coalesced by
//    singleflight). Nobody waits, so nobody stampedes.
// ---------------------------------------------------------------------------

type envelope struct {
	Value     string `json:"v"`
	FreshTill int64  `json:"f"` // unix millis: logically fresh until this time
}

// GetSWR returns a value, serving stale-while-revalidating. logicalTTL is how
// long the value is considered fresh; the physical Redis TTL is set longer so
// the stale value survives to be served during the refresh window.
func (c *Cache) GetSWR(ctx context.Context, key string, logicalTTL time.Duration) (string, error) {
	raw, err := c.rdb.Get(ctx, key).Result()
	if errors.Is(err, redis.Nil) {
		// Cold miss: must recompute now, coalesced by singleflight.
		return c.refresh(ctx, key, logicalTTL)
	} else if err != nil {
		return "", err
	}

	var env envelope
	if err := json.Unmarshal([]byte(raw), &env); err != nil {
		return c.refresh(ctx, key, logicalTTL) // corrupt entry, rebuild
	}

	if time.Now().UnixMilli() < env.FreshTill {
		return env.Value, nil // fresh: the overwhelming common case
	}

	// STALE but present: return it immediately, refresh in the background. The
	// singleflight key ensures only ONE background refresh runs no matter how
	// many concurrent readers see the value as stale.
	go func() {
		bg, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_, _, _ = c.group.Do("swr:"+key, func() (any, error) {
			return c.refresh(bg, key, logicalTTL)
		})
	}()
	return env.Value, nil // served instantly, zero added latency, no stampede
}

// refresh recomputes and stores the envelope with a physical TTL comfortably
// longer than the logical one, so a stale value is available to serve during
// the next refresh instead of hard-missing.
func (c *Cache) refresh(ctx context.Context, key string, logicalTTL time.Duration) (string, error) {
	val, err := c.loader(ctx, key)
	if err != nil {
		return "", err
	}
	env := envelope{Value: val, FreshTill: time.Now().Add(logicalTTL).UnixMilli()}
	buf, _ := json.Marshal(env)
	physical := jitter(logicalTTL * 3) // survive well past logical staleness
	_ = c.rdb.Set(ctx, key, buf, physical).Err()
	return val, nil
}

// ---------------------------------------------------------------------------
// 4. XFETCH: probabilistic early recompute.
//    From "Optimal Probabilistic Cache Stampede Prevention". On each read we
//    compute a probabilistic early-expiry: gap = delta * beta * ln(rand()).
//    delta is the measured recompute cost; as we approach expiry, the chance of
//    a read deciding "I'll recompute now, early" rises. One lucky read refreshes
//    ahead of the hard expiry, so the stampede window never opens.
// ---------------------------------------------------------------------------

type xfetchEnvelope struct {
	Value   string  `json:"v"`
	Delta   float64 `json:"d"` // recompute duration in seconds (measured)
	Expiry  int64   `json:"e"` // unix millis of hard expiry
}

// GetXFetch returns a value, probabilistically recomputing BEFORE expiry.
func (c *Cache) GetXFetch(ctx context.Context, key string, ttl time.Duration, beta float64) (string, error) {
	raw, err := c.rdb.Get(ctx, key).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return "", err
	}
	if err == nil {
		var env xfetchEnvelope
		if json.Unmarshal([]byte(raw), &env) == nil {
			now := float64(time.Now().UnixMilli())
			// The XFetch formula: recompute early if
			//   now - delta*beta*ln(rand) >= expiry
			// beta>1 recomputes more eagerly; the delta term means EXPENSIVE
			// values (large delta) refresh earlier, since they hurt more if they
			// stampede.
			early := env.Delta * 1000 * beta * -math.Log(mrand.Float64())
			if now-early < float64(env.Expiry) {
				return env.Value, nil // still fresh enough, no recompute
			}
			// fall through: we were chosen to recompute early
		}
	}

	// Recompute (coalesced so only one goroutine does it), timing delta.
	v, err, _ := c.group.Do("xf:"+key, func() (any, error) {
		start := time.Now()
		val, err := c.loader(ctx, key)
		if err != nil {
			return "", err
		}
		delta := time.Since(start).Seconds()
		env := xfetchEnvelope{
			Value:  val,
			Delta:  delta,
			Expiry: time.Now().Add(ttl).UnixMilli(),
		}
		buf, _ := json.Marshal(env)
		_ = c.rdb.Set(ctx, key, buf, jitter(ttl)).Err()
		return val, nil
	})
	if err != nil {
		return "", err
	}
	return v.(string), nil
}
```

The through-line: `singleflight` is your default inner layer (cheap, fresh, in-process); the `SET NX PX` lock extends coalescing across the fleet; SWR removes the wait entirely for staleness-tolerant reads; and XFetch keeps hot keys warm so the blocking recompute never fires for them.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Protects the origin.** Any of the four collapses N simultaneous origin calls down to one, which is the difference between a smooth refresh and a database outage.
- **Cheap to add.** Singleflight is a few lines around an existing read-through cache; SWR is an envelope and a background goroutine.
- **Composable.** They layer: singleflight inside a distributed lock inside SWR, with XFetch as an overlay, each covering a gap the others leave.
- **Predictable tail latency.** SWR and XFetch mean hot-key reads never wait on a recompute, flattening p99.

**Disadvantages**
- **Locking adds latency and failure modes.** Waiters block; a crashed lock holder needs a timeout; a too-short lock TTL lets a second recomputer in.
- **Singleflight is per-process only.** On its own it does nothing for a key that is hot across a large fleet — you still get one origin call per pod.
- **SWR serves stale data.** For a brief window, readers get an out-of-date value; unacceptable for read-your-writes or strongly-consistent reads.
- **XFetch adds complexity and randomness.** It needs the recompute cost stored with the value and is probabilistic, so it is harder to reason about and test than a lock.

**Trade-offs**
- *Wait vs serve-stale:* locking/singleflight keep freshness but add latency for waiters; SWR/XFetch keep latency flat but return a stale value during refresh. Choose by your staleness SLA.
- *In-process vs cross-fleet:* singleflight is free and covers goroutines; a distributed lock covers processes but adds a Redis round trip and a whole class of lock-lifetime bugs. Add the distributed layer only for keys hot across the fleet.
- *Simplicity vs elegance:* a per-key lock is the easiest to explain and reason about; XFetch is the most elegant (no thundering herd window at all) but the hardest to operate. Reach for the lock first, XFetch when a single key is so hot that even one recompute per TTL matters.
- *Lock TTL:* too short and it expires mid-recompute (a second recomputer joins); too long and a crashed holder blocks the key for that whole duration. Size it to the worst-case recompute time plus margin.

## 7. Common Mistakes & Best Practices

- **No protection at all on a read-through cache.** The default naive cache-aside code has this exact bug; it works fine until a key gets hot, then takes the database down. **Best practice:** wrap every expensive read-through in at least singleflight.
- **Relying on singleflight alone across a fleet.** It coalesces goroutines, not processes, so 50 pods still make 50 origin calls. **Best practice:** add a `SET NX PX` distributed lock (or SWR) for keys hot across the fleet.
- **A distributed lock without a token check on release.** A plain `DEL` can delete a lock that already expired and was re-acquired by someone else. **Best practice:** release with the compare-and-delete Lua script keyed on your unique token.
- **Lock TTL shorter than the recompute.** The lock expires mid-work, a second process acquires it, and you get a (bounded) stampede anyway. **Best practice:** set the lock PX above the worst-case recompute time, and consider extending it (a watchdog) for long recomputes.
- **Serving stale where correctness forbids it.** Using SWR on a value that must reflect the user's last write breaks read-your-writes. **Best practice:** reserve SWR for staleness-tolerant reads (feeds, aggregates), not for the user's own mutable state.
- **Repopulating with a fixed TTL.** Fixing the stampede but writing the same TTL re-synchronises the herd for next time. **Best practice:** always jitter the repopulation TTL (chapter 17).
- **Blocking waiters forever.** A lock loser that polls with no deadline hangs if the winner crashes. **Best practice:** bound the wait and fall back to serving stale or erroring, never an unbounded spin.
- **Best practice overall: layer defences and keep hot keys warm.** The blocking recompute path should only ever run for cold keys, where the herd is small by definition.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The signature of a stampede is a *synchronised* spike: a cliff in cache hit-rate for one key, a simultaneous burst of identical origin queries, and a latency spike across everything that shares the origin — all aligned to a TTL boundary. Correlate your cache-miss counter with database query-rate; a stampede shows a sawtooth (miss-rate spikes at each expiry). Redis `OBJECT IDLETIME` and slowlog help identify which key is hot; the database slow-query log shows the duplicated expensive query.
- **Monitoring.** Track per-key (or per-key-prefix) miss rate, origin call rate, and the ratio of origin calls to misses — with coalescing that ratio should be far below 1. Alert on origin query bursts that align with cache expiries. Instrument the singleflight/lock path with a counter for "recomputes suppressed" so you can *see* the herd being collapsed.
- **Security.** A stampede is a denial-of-service amplifier: an attacker who can force a hot key to expire (or who requests an uncacheable variant) can weaponise the herd against your database. Rate-limit cache-busting query parameters, and combine stampede protection with penetration defences (chapter 16) so that requests for absent keys cannot repeatedly bypass the cache. The distributed lock key is itself a resource — ensure it inherits the same ACL/auth as the rest of the keyspace.
- **Scaling.** As the fleet grows, in-process singleflight becomes weaker (one origin call per pod × more pods), so the crossover point where you *need* a distributed lock or SWR arrives sooner. On Redis Cluster the lock key and the value key should share a slot (hash tag) if you ever operate on them atomically, though `SET NX` on one key and `SET` on another do not require it. The deepest scaling fix is to keep hot keys warm proactively (XFetch/SWR) so the origin never sees the herd regardless of fleet size.

## 9. Interview Questions

**Q: What is a cache stampede, in one paragraph?**
A: When a hot cache key — one served to many concurrent requests — expires, every in-flight request misses at the same instant and each independently recomputes the value from the origin. The cache momentarily provides zero protection, so the database receives the full unfiltered read load it was never sized for. Because the value only needed computing once but is computed N times simultaneously, most of that work is wasted, and the burst can saturate the database's connections and take it down. It is also called the thundering herd or dogpile effect. The core problem is *correlated misses*: many requests depending on one key with one expiry time all fail together.

**Q: Why does jittering TTLs help, and is it enough on its own?**
A: Jitter spreads expiry times so a batch of keys written together do not all expire in the same instant, which prevents the *avalanche* variant where many keys stampede simultaneously (chapter 17). But jitter alone does not fix the *single-hot-key* stampede: one very hot key still has thousands of requests in flight when it expires, no matter how you jitter its single expiry time. Jitter reduces the probability of synchronised expiry across many keys; it does not coalesce the herd on one key. You need coalescing (locking/singleflight) or background refresh (SWR/XFetch) for that, and you use jitter *in addition* when you repopulate.

**Q: What does Go's singleflight give you and what is its main limitation?**
A: `golang.org/x/sync/singleflight` coalesces concurrent calls with the same key so that of N goroutines asking for the same value at once, exactly one runs the expensive function and all N receive its result. It is the cheapest, freshest stampede fix and the right default inner layer for any read-through cache. Its main limitation is that it is *in-process* only: it coalesces goroutines within a single Go process, so a fleet of 50 pods can still make up to 50 concurrent origin calls (one per pod). For a key that is hot across the whole fleet you must add a cross-process mechanism — a distributed `SET NX PX` lock, or stale-while-revalidate so nobody blocks on the recompute at all.

**Q: How would you build a distributed lock for stampede protection with Redis?**
A: `SET lockKey token NX PX <ttl>` — set the lock key only if it does not exist, with a physical expiry so a crashed holder cannot deadlock the key forever. The value is a unique random token per acquirer. The winner recomputes the value once, repopulates the cache, and releases the lock; the losers poll the cache briefly (with a deadline) for the value the winner will populate, rather than joining the origin stampede. Release must be a compare-and-delete — a Lua script that deletes the lock only if its value still equals your token — because a plain `DEL` could delete a lock that already expired and was re-acquired by another process. The lock TTL must exceed the worst-case recompute time, or it expires mid-work and a second recomputer joins.

**Q: What is stale-while-revalidate and when is it the right choice?**
A: Store the value with a *logical* freshness deadline that is shorter than its *physical* Redis TTL. A read that finds the value logically stale but still physically present returns it immediately and triggers exactly one background refresh (coalesced by singleflight or a lock). Nobody ever waits on a recompute, so there is no stampede window and p99 stays flat. It is the right choice when the read tolerates brief staleness — public feeds, aggregates, rendered fragments, trending lists — where returning a few-seconds-old value is fine. It is the wrong choice for read-your-writes or strongly-consistent reads, because during the refresh window callers get an out-of-date value.

**Q: Explain probabilistic early recompute (XFetch).**
A: Instead of waiting for a hard expiry, each read draws a random number and probabilistically decides whether to recompute the value *early*. The probability rises as the key approaches expiry and scales with how expensive the value is to recompute (its measured delta): `now - delta·beta·ln(rand) ≥ expiry` triggers an early recompute. One lucky read rebuilds the value before it ever hard-expires, so the stampede window never opens for a hot key — while cold keys, read rarely, almost never trigger the early path and just expire normally. It comes from the paper *Optimal Probabilistic Cache Stampede Prevention*. The elegance is that it needs no lock and no explicit background job; the cost is storing the recompute cost with the value and the general difficulty of reasoning about randomised behaviour.

**Q: (Senior) You have a globally hot key read by a 100-pod fleet. Design the full defence.**
A: I would layer. Innermost, `singleflight` around the read-through so within each pod the herd of goroutines collapses to one call — free and always correct. That alone leaves up to 100 origin calls per expiry (one per pod), which for a globally hot key is still a stampede, so I add stale-while-revalidate as the primary strategy: store the value with a logical freshness shorter than its physical TTL, serve stale instantly, and let one background refresher per pod attempt the recompute — coalesced further by a distributed `SET NX PX` lock so that across all 100 pods only *one* process actually hits the origin, the rest seeing the lock held and simply continuing to serve stale. On top I would run XFetch so the value is refreshed *ahead* of hard expiry, meaning the physical key effectively never disappears under live traffic. The result: readers never block (SWR), only one origin call happens per refresh across the whole fleet (distributed lock), and the refresh happens before anyone is waiting (XFetch). I would jitter every repopulation TTL, bound every wait with a deadline, and instrument a "recomputes suppressed" counter so I can watch the herd being collapsed. If the value genuinely cannot be stale, I drop SWR and accept that waiters block on the lock winner, sizing the lock TTL to the worst-case recompute.

**Q: (Senior) What are the failure modes of the distributed-lock approach, and how do you mitigate each?**
A: First, the lock holder crashes mid-recompute: mitigated by the physical `PX` timeout, which releases the lock automatically, plus bounding the losers' wait so they do not spin forever if the value never appears. Second, the lock expires *before* the recompute finishes (recompute slower than expected): a second process acquires the lock and joins in — a bounded mini-stampede — mitigated by sizing the TTL above the worst-case recompute and optionally running a watchdog that extends the lock while work continues. Third, releasing someone else's lock: if you `DEL` after your lock already expired and was re-acquired, you free a lock you no longer own; mitigated by the compare-and-delete Lua script keyed on your unique token. Fourth, clock and replication issues on Redis failover: if the master fails over after granting the lock but before replicating it, two holders can exist — this is the Redlock debate (Kleppmann vs antirez); for a *cache* stampede this is acceptable because the worst case is two recomputes, not a correctness violation, so I deliberately do not reach for Redlock here — a single-instance `SET NX PX` with a fencing token is enough. Fifth, the lock itself becoming a hot key / point of contention: mitigated by keeping the critical section tiny (just the recompute) and by preferring SWR so most reads never touch the lock at all.

**Q: (Senior) When is doing nothing about stampedes the right call?**
A: When the recompute is cheap and the key is not hot, the herd is small and the origin absorbs it trivially — adding singleflight there is harmless but adding a distributed lock is over-engineering. More interestingly, when the value is *uncacheable-per-request* (personalised, unique per user) there is no single hot key to stampede in the first place, so classic stampede protection does not apply; the risk shifts to origin capacity and rate-limiting instead. And when strict freshness is required and the recompute is fast, a simple per-key mutex with a short wait is enough and the elaborate SWR/XFetch machinery buys nothing. The senior instinct is to size the defence to the actual `R × T`: measure the request rate and the recompute duration for each expensive key, and only escalate from "nothing" to singleflight to distributed lock to full SWR/XFetch as that product grows. Reaching straight for Redlock-style machinery on a low-traffic key is a common over-reaction.

**Q: (Senior) How does stampede protection interact with cache penetration and avalanche?**
A: They are three faces of "the cache stopped absorbing load", and a complete design addresses all three together. Stampede is *one hot key* expiring under concurrency; avalanche is *many keys* expiring at the same instant (fix: TTL jitter, chapter 17); penetration is requests for keys that *never* exist and so always miss (fix: null-caching and Bloom filters, chapter 16). They interact: a penetration attack can *create* a stampede by driving repeated misses on a key that cannot be cached, and avalanche is essentially many simultaneous stampedes. So the layered read path from §4 folds in all three — coalescing and SWR for the single-key stampede, jittered TTLs on repopulation for avalanche, and a null-cache/Bloom guard before the origin call for penetration — because in production these failures arrive together, not one at a time.

## 10. Quick Revision & Cheat Sheet

| Fix | Mechanism | Staleness | Scope | When |
|---|---|---|---|---|
| Per-key mutex | one recomputes, rest wait | none | in-process (local) | fresh reads, few goroutines |
| Distributed lock | `SET NX PX`, one process recomputes | none | cross-fleet | globally hot key, fresh reads |
| Singleflight | in-process call coalescing | none | in-process | default inner layer |
| Stale-while-revalidate | serve stale, refresh in background | brief | any | staleness-tolerant hot reads |
| XFetch | probabilistic early recompute | none | any | keep hot keys warm before expiry |

| Symptom | Likely cause | First move |
|---|---|---|
| Origin query burst aligned to TTL | stampede on a hot key | add singleflight, then SWR/lock |
| Many keys spike together | avalanche | jitter TTLs (ch.17) |
| Lock held after crash | no PX timeout | set `SET NX PX`, bound waits |
| Lock deleted by wrong owner | plain DEL on release | compare-and-delete Lua |

**Flash cards**
- **Stampede in one line?** → Hot key expires; N concurrent misses become N origin calls instead of one.
- **The formula?** → ~`R × T` misses at expiry (request rate × recompute seconds).
- **Cheapest fix?** → singleflight — coalesce goroutines to one origin call.
- **Singleflight's limit?** → in-process only; one call *per pod* across a fleet.
- **Never-wait fix?** → stale-while-revalidate (serve stale, refresh in background).
- **No-window fix?** → XFetch — recompute probabilistically *before* hard expiry.
- **Safe lock release?** → compare-and-delete Lua keyed on a unique token.

## 11. Hands-On Exercises & Mini Project

- [ ] Build a naive read-through cache with an expensive loader, fire 1,000 concurrent requests at one key, and count how many hit the origin. Confirm the stampede.
- [ ] Wrap the same loader in `singleflight` and re-run; confirm exactly one origin call.
- [ ] Add a `SET NX PX` distributed lock and simulate two processes; confirm only one recomputes and the other serves the populated value.
- [ ] Implement the compare-and-delete release script and demonstrate the bug it prevents (a plain `DEL` freeing a re-acquired lock).
- [ ] Implement stale-while-revalidate with a logical/physical TTL split and measure p99 latency versus the blocking-lock approach under load.
- [ ] Implement XFetch, log which read is chosen to recompute early, and verify the key never hard-expires under sustained traffic.

### Mini Project — "Stampede Simulator"

**Goal.** Make the herd visible and measurable, then demonstrate each fix collapsing it, so the trade-offs become intuition.

**Requirements.**
1. A loader that sleeps a configurable `T` and increments a global "origin calls" counter, fronted by a Redis cache with a configurable TTL.
2. A load generator that fires `R` requests/second at a single hot key and records, per second: cache hit-rate, origin call count, and request latency distribution.
3. Implement all four fixes behind a common interface: per-key/distributed lock, singleflight, stale-while-revalidate, XFetch.
4. Run each fix under identical load and chart origin-call count over time (expect a spike at each TTL boundary for "none", flat-near-one for the fixes).
5. Chart the latency distribution for each fix, showing the wait-vs-stale trade: locking raises waiter latency, SWR/XFetch keep it flat.

**Extensions.**
- Simulate a multi-process fleet (N processes) and show singleflight alone leaving N origin calls per expiry while the distributed lock holds it at one.
- Inject a crash of the lock holder and verify the PX timeout and bounded wait recover without a deadlock.
- Combine all four into the layered read path from §4 and show the origin call rate staying flat even as `R` and the fleet size grow.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Cache Penetration, Null Caching & Bloom Filters* (requests for keys that never exist), *Hot Keys, Cache Avalanche & Sharding the Hot Key* (many-key expiry and single-node hotspots), *Cache-Aside, Read-Through & Write Patterns* (the read path stampede protection wraps), *Distributed Locks with Redis* (the `SET NX PX` primitive in depth), *TTL, Expiration & Eviction* (logical vs physical expiry).

- **Redis — Distributed Locks with Redis (Redlock)** — Redis · *Advanced* · the canonical `SET NX PX` lock and the Redlock algorithm, including its limitations. <https://redis.io/docs/latest/develop/use/patterns/distributed-locks/>
- **Optimal Probabilistic Cache Stampede Prevention** — Vattani, Chierichetti, Lowenstein (VLDB) · *Advanced* · the paper behind XFetch, with the exact formula and its analysis. <https://www.vldb.org/pvldb/vol8/p886-vattani.pdf>
- **How to do distributed locking** — Martin Kleppmann · *Advanced* · the critique of Redlock and the fencing-token argument; essential for reasoning about lock safety. <https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html>
- **Is Redlock safe?** — Salvatore Sanfilippo (antirez) · *Advanced* · the rebuttal; read alongside Kleppmann for the full debate. <http://antirez.com/news/101>
- **golang.org/x/sync/singleflight** — Go team · *Intermediate* · the reference implementation and docs for in-process call coalescing. <https://pkg.go.dev/golang.org/x/sync/singleflight>
- **stale-while-revalidate (RFC 5861)** — IETF · *Intermediate* · the HTTP caching directive that names the pattern; the same idea applied to application caches. <https://datatracker.ietf.org/doc/html/rfc5861>
- **Designing Data-Intensive Applications, ch. 5–9** — Martin Kleppmann · *Advanced* · the broader context of replication, consistency, and the failure modes locks must survive. <https://dataintensive.net/>
- **Redis University — RU101 & RU330 (security/operations)** — Redis · *Intermediate* · free courses grounding the caching patterns and the operational discipline behind them. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 15.*
