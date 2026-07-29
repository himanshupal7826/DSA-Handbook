# 11 · TTL Strategy, Refresh-Ahead & Adaptive Expiry

> **In one line:** A TTL is not one number you sprinkle on every key — it is a policy, and the good ones add jitter so keys never expire in lockstep, refresh hot entries *before* they expire so reads never pay the miss, and recompute probabilistically as expiry nears so exactly one request rebuilds a hot key instead of a thousand.

---

## 1. Overview

Every entry in a cache-aside system carries a TTL (chapter 08), and the lazy answer is to pick one number — "cache everything for five minutes" — and move on. That number quietly decides your hit ratio, your staleness bound, and whether a hot key's expiry triggers a stampede that topples your database. TTL is a *strategy*, and this chapter is about the handful of techniques that separate a naive TTL from one that behaves well under load.

Four ideas do most of the work. **Absolute versus sliding TTL** is the base choice: does an entry expire a fixed time after it was written, or does every access push its expiry further out so frequently-used entries live longer? **Jitter** is the small randomisation you add so that a batch of keys populated together — at deploy, at cache warm-up, on the same request — does not all expire in the same instant, which would send a synchronised wave of misses at the database (a cache *avalanche*). **Refresh-ahead** proactively rebuilds an entry *before* it expires, so a hot key is always warm and reads never pay the miss latency of a cold rebuild. And **probabilistic early recompute** — the XFetch algorithm — is the elegant, near-stateless way to make refresh-ahead work under concurrency: as an entry approaches expiry, each reader recomputes it with a probability that rises toward the deadline, so statistically exactly one reader rebuilds it slightly early while everyone else keeps serving the still-valid cached value.

The thread connecting all four is *miss avoidance under concurrency*. A cache miss is expensive — it costs a database query and a repopulate — and the worst misses are the correlated ones: many keys expiring together, or one hot key expiring while a thousand requests want it. TTL jitter decorrelates the first; refresh-ahead and probabilistic recompute eliminate the second by making sure the rebuild happens *before* the miss, by *one* worker, ahead of demand. This chapter builds each technique, shows the XFetch formula and why it works, and gives you jittered-TTL and refresh-ahead implementations in Go.

## 2. Core Concepts

- **TTL (time to live)** — how long a cached entry remains valid before Redis expires it; set via `SET key val EX seconds`, `EXPIRE`, or `PEXPIRE`.
- **Absolute TTL** — the entry expires a fixed duration after it was written, regardless of access.
- **Sliding TTL (sliding expiration)** — every access resets the TTL, so frequently-used entries live longer; implemented with `GETEX ... EX` or `EXPIRE` on read.
- **TTL jitter** — randomising each entry's TTL by a small percentage so keys populated together do not expire simultaneously.
- **Cache avalanche** — a mass of keys expiring at the same instant, sending a synchronised flood of misses at the database; jitter is the precursor defence.
- **Refresh-ahead (refresh-before-expiry)** — proactively recomputing an entry before its TTL fires so reads never encounter a miss on a hot key.
- **Probabilistic early recompute (XFetch)** — recomputing an entry with a probability that increases as expiry approaches, so one reader rebuilds it early and the rest serve the cached value.
- **Delta (recompute cost)** — the measured time it takes to recompute a value, used by XFetch to decide how early to recompute.
- **Adaptive TTL** — varying an entry's TTL by how often or how recently it is accessed, so hot data stays cached longer than cold data.
- **`GETEX`** — read a value and reset (or clear) its TTL in one atomic command; the primitive behind sliding expiration.

## 3. Theory & Principles

### Absolute vs sliding TTL

An **absolute** TTL expires an entry a fixed time after it was written. It is simple, predictable, and gives a hard staleness bound: nothing is ever older than the TTL, full stop. A **sliding** TTL resets the clock on every access, so an entry that keeps being read keeps living, and only falls out once it goes untouched for the TTL duration. Sliding expiration matches the intuition of "keep what is being used" and is excellent for session-like data — a user session should live as long as the user is active and expire after a period of inactivity, which is exactly sliding semantics.

The trade is between hit ratio and staleness bound. Sliding TTL raises the hit ratio for hot keys (they never expire while in use) but *removes the hard staleness bound* — a constantly-accessed entry with a sliding TTL can be arbitrarily old, because it never expires as long as it is read, so a missed invalidation on that key never self-heals. Absolute TTL keeps the hard bound (the safety-net property from chapter 08) at the cost of periodically re-missing hot keys. In Redis, sliding is implemented with `GETEX key EX ttl`, which atomically reads the value *and* resets its TTL in one command — before `GETEX` (Redis 6.2), you needed a `GET` plus a separate `EXPIRE`, which was two round trips and a race. The rule of thumb: use absolute TTL for cached copies of authoritative data (you want the self-healing bound), and sliding TTL for data whose lifetime genuinely *should* track access, like sessions.

### Jitter: never let keys expire in lockstep

Here is a failure mode that surprises people. You warm your cache at deploy by loading ten thousand keys, each with a clean 300-second TTL. Five minutes later, all ten thousand expire *in the same second*, ten thousand reads miss simultaneously, and ten thousand database queries land at once — a **cache avalanche**. The keys were correlated at birth (populated together) so they are correlated at death (expire together), and the correlation is the disaster.

The fix is trivial and mandatory: **jitter the TTL**. Instead of exactly 300 seconds, use 300 seconds plus or minus a random 10%, so the expirations spread across a 60-second window instead of a single instant, and the miss load is smeared out to a level the database can absorb. Jitter costs nothing — one random number at populate time — and it is the single highest-leverage TTL habit. The amount of jitter should scale with how correlated your populates are and how much miss load you can tolerate: a 5–10% spread suffices for most, but a mass warm-up of a huge keyspace might want more. The mental model is that a TTL without jitter is a scheduled synchronised outage waiting for the population that triggers it.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="j1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="j2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">TTL jitter: decorrelate expiry to prevent an avalanche</text>

  <rect x="24" y="40" width="832" height="180" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">No jitter: 10,000 keys populated together, all TTL = 300s</text>
  <line x1="60" y1="150" x2="820" y2="150" stroke="#991b1b" stroke-width="2"/>
  <text x="60" y="170" fill="#991b1b" font-size="9">t=0 populate</text>
  <text x="770" y="170" fill="#991b1b" font-size="9">t=300s</text>
  <g stroke="#dc2626" stroke-width="1">
    <line x1="600" y1="90" x2="600" y2="150"/><line x1="602" y1="90" x2="602" y2="150"/><line x1="604" y1="90" x2="604" y2="150"/>
    <line x1="598" y1="90" x2="598" y2="150"/><line x1="606" y1="90" x2="606" y2="150"/><line x1="596" y1="90" x2="596" y2="150"/>
  </g>
  <path d="M602,150 L602,196" stroke="#dc2626" stroke-width="3" marker-end="url(#j1)"/>
  <text x="602" y="84" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">ALL expire at once</text>
  <rect x="540" y="196" width="130" height="18" rx="4" fill="#fecaca" stroke="#dc2626"/>
  <text x="605" y="209" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">10,000 misses / spike</text>

  <rect x="24" y="236" width="832" height="180" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="258" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">With jitter: TTL = 300s +/- 10%, expiries spread over 60s</text>
  <line x1="60" y1="346" x2="820" y2="346" stroke="#166534" stroke-width="2"/>
  <text x="60" y="366" fill="#166534" font-size="9">t=0 populate</text>
  <text x="740" y="366" fill="#166534" font-size="9">t=270..330s</text>
  <g stroke="#16a34a" stroke-width="1">
    <line x1="520" y1="300" x2="520" y2="346"/><line x1="545" y1="290" x2="545" y2="346"/><line x1="575" y1="305" x2="575" y2="346"/>
    <line x1="605" y1="295" x2="605" y2="346"/><line x1="635" y1="308" x2="635" y2="346"/><line x1="665" y1="298" x2="665" y2="346"/>
    <line x1="695" y1="303" x2="695" y2="346"/>
  </g>
  <path d="M520,346 L520,392" stroke="#16a34a" stroke-width="1.5" marker-end="url(#j2)"/>
  <path d="M605,346 L605,392" stroke="#16a34a" stroke-width="1.5" marker-end="url(#j2)"/>
  <path d="M695,346 L695,392" stroke="#16a34a" stroke-width="1.5" marker-end="url(#j2)"/>
  <text x="605" y="284" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">expiries smeared across a window</text>
  <rect x="470" y="392" width="270" height="18" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="605" y="405" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">miss load smoothed to an absorbable trickle</text>
</svg>
```

### Refresh-ahead and probabilistic early recompute (XFetch)

Jitter decorrelates *many* keys. Refresh-ahead solves the *single hot key* problem: a very popular key expires, and in the instant after, every request for it misses and stampedes the rebuild. Refresh-ahead's insight is to rebuild the entry *before* it expires, ahead of demand, so the miss never happens — the key is refreshed while the old value is still valid and being served, and the new value slots in seamlessly.

The hard part is deciding *who* refreshes and *when*, under concurrency, without either every reader refreshing (wasteful) or none refreshing (back to a miss). The elegant answer is **probabilistic early recompute**, popularised as the **XFetch** algorithm from the paper *Optimal Probabilistic Cache Stampede Prevention*. The idea: store, alongside the value, the time it took to recompute it (call it `delta`). On each read, compute a small random "early expiry" using the formula

`shouldRecompute = (now - delta * beta * ln(random)) >= expiry`

where `random` is a uniform (0,1), `beta` is a tuning knob (typically 1.0), and `ln(random)` is negative so the term `- delta * beta * ln(random)` is a positive amount of time that grows with the recompute cost. Far from expiry the probability of triggering is negligible; as `now` approaches `expiry` the probability rises smoothly, and it rises *sooner* for values that are expensive to recompute (large `delta`), because those deserve more lead time. Statistically, exactly one reader among the many hitting a hot key crosses the threshold slightly before expiry, recomputes it, and refreshes the cache while everyone else keeps serving the still-valid cached value. No locks, almost no coordination, no stampede, and no cold miss. It is the most elegant stampede-prevention technique in the field, and it degrades gracefully: even if two readers recompute, that is two database queries, not a thousand.

Complementary to XFetch is **stale-while-revalidate**: on a read of a near-expired (or just-expired-within-grace) entry, serve the stale value immediately and trigger an asynchronous refresh, so the reader never waits for the rebuild. And **adaptive TTL** varies the TTL by access frequency — hot keys get longer TTLs (they will be re-read, so caching them longer pays off) while cold keys get short ones (so the cache does not hold rarely-read data) — which is a coarser, cheaper cousin of these techniques for shaping the cache's memory toward what is actually hot.

## 4. Architecture & Workflow

The read path with refresh-ahead and probabilistic recompute layered on:

1. **Read.** `GET key` (or, to get the value and its remaining TTL together for the XFetch check, read the value plus a stored `expiry`/`delta`, or `PTTL`).
2. **Hit, comfortably fresh.** Return the cached value. No refresh needed — the overwhelming majority of reads.
3. **Hit, near expiry — XFetch roll.** Compute the probabilistic early-recompute test. If it triggers (one reader statistically will), recompute the value from the source, write it back with a fresh jittered TTL and an updated `delta`, and return either the new value or the still-valid old one. If it does not trigger, return the cached value unchanged.
4. **Sliding refresh (if configured).** For sliding-TTL data, `GETEX key EX ttl` on the read resets the expiry atomically so active data lives on.
5. **Miss.** Fall through to a normal cache-aside load (with singleflight/lock stampede protection, chapter 12), populate with a jittered TTL, and record the recompute `delta` for future XFetch decisions.
6. **Background refresh-ahead (optional).** A scheduler or the read path itself can, for a curated set of known-hot keys, refresh them on a fixed cadence well before expiry, guaranteeing they are never cold — used for a small number of critical keys where you do not want to rely on probability at all.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="rf1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Read path with probabilistic early recompute (XFetch)</text>

  <rect x="350" y="40" width="180" height="36" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="63" text-anchor="middle" fill="#1e40af" font-weight="bold">GET value + delta</text>

  <path d="M440,76 L440,100" stroke="#64748b" stroke-width="1.5" marker-end="url(#rf1)"/>
  <rect x="370" y="102" width="140" height="32" rx="8" fill="#f1f5f9" stroke="#64748b"/>
  <text x="440" y="123" text-anchor="middle" fill="#334155" font-weight="bold">hit?</text>

  <path d="M370,118 L230,118" stroke="#dc2626" stroke-width="1.5" marker-end="url(#rf1)"/>
  <text x="300" y="111" text-anchor="middle" fill="#b91c1c" font-size="9">MISS</text>
  <rect x="40" y="100" width="190" height="36" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="135" y="118" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">cache-aside load (locked)</text>
  <text x="135" y="131" text-anchor="middle" fill="#991b1b" font-size="8">populate, jittered TTL, record delta</text>

  <path d="M440,134 L440,160" stroke="#16a34a" stroke-width="1.5" marker-end="url(#rf1)"/>
  <text x="470" y="150" fill="#166534" font-size="9">HIT</text>
  <rect x="330" y="162" width="220" height="44" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="440" y="182" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">XFetch roll:</text>
  <text x="440" y="198" text-anchor="middle" fill="#92400e" font-size="8">now - delta*beta*ln(rand) &gt;= expiry ?</text>

  <path d="M330,184 L200,184" stroke="#16a34a" stroke-width="1.5" marker-end="url(#rf1)"/>
  <text x="265" y="177" text-anchor="middle" fill="#166534" font-size="9">NO</text>
  <rect x="40" y="166" width="160" height="36" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="120" y="188" text-anchor="middle" fill="#166534" font-size="10" font-weight="bold">return cached value</text>

  <path d="M550,184 L680,184" stroke="#d97706" stroke-width="1.5" marker-end="url(#rf1)"/>
  <text x="615" y="177" text-anchor="middle" fill="#b45309" font-size="9">YES (rare)</text>
  <rect x="682" y="160" width="170" height="48" rx="8" fill="#fed7aa" stroke="#d97706"/>
  <text x="767" y="180" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">recompute early,</text>
  <text x="767" y="196" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">SET fresh jittered TTL</text>

  <rect x="40" y="250" width="812" height="150" rx="10" fill="#f5f3ff" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="272" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Why exactly ~one reader recomputes (and never a stampede)</text>
  <line x1="80" y1="350" x2="800" y2="350" stroke="#6d28d9" stroke-width="2"/>
  <text x="80" y="370" fill="#6d28d9" font-size="9">populate</text>
  <text x="760" y="370" fill="#6d28d9" font-size="9">expiry</text>
  <rect x="600" y="330" width="160" height="16" fill="#ddd6fe" opacity="0.7"/>
  <text x="680" y="326" text-anchor="middle" fill="#5b21b6" font-size="9">recompute probability rises</text>
  <text x="96" y="300" fill="#5b21b6" font-size="10">Far from expiry: P(recompute) &#8776; 0 &#8594; everyone serves the cached value.</text>
  <text x="96" y="318" fill="#5b21b6" font-size="10">Approaching expiry: P rises smoothly; ONE reader crosses the threshold first, refreshes ahead of the miss.</text>
  <text x="96" y="392" fill="#5b21b6" font-size="10">Expensive values (large delta) recompute EARLIER &#8594; more lead time. No locks; even a double recompute is 2 queries, not 1000.</text>
</svg>
```

## 5. Implementation

Jittered TTL, sliding expiration with `GETEX`, and probabilistic early recompute (XFetch) in Go with `github.com/redis/go-redis/v9`. The XFetch cache stores the value, its recompute cost `delta`, and an absolute `expiry` in a hash so the read path can make the probabilistic decision.

```go
package ttlstrategy

import (
	"context"
	"encoding/json"
	"math"
	"math/rand"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"
)

// JitteredTTL returns base +/- (spread * base), so keys populated together do not
// expire in lockstep. Jitter is the single highest-leverage TTL habit: it turns a
// synchronized avalanche of misses into an absorbable trickle, for the cost of one
// random number.
func JitteredTTL(base time.Duration, spread float64) time.Duration {
	// spread=0.10 gives base +/- 10%.
	delta := (rand.Float64()*2 - 1) * spread * float64(base)
	return time.Duration(float64(base) + delta)
}

// SlidingGet reads a value and RESETS its TTL atomically with GETEX, so an entry
// that keeps being accessed keeps living (sliding expiration). One command, no
// race — before GETEX this needed GET + EXPIRE, two round trips. Use this for
// data whose lifetime SHOULD track access, like sessions; note it removes the
// hard staleness bound, so do not use it where you rely on TTL as a safety net.
func SlidingGet(ctx context.Context, rdb *redis.Client, key string, ttl time.Duration) (string, error) {
	return rdb.GetEx(ctx, key, ttl).Result()
}

// xfetchEntry is what we store: the value plus the metadata the probabilistic
// recompute decision needs — the recompute cost (delta) and the absolute expiry.
type xfetchEntry struct {
	Value    string  `json:"v"`
	DeltaMS  float64 `json:"d"` // measured recompute time, milliseconds
	ExpiryMS int64   `json:"e"` // absolute expiry, unix milliseconds
}

// Recomputer produces a fresh value from the source of truth (DB, API, ...).
type Recomputer func(ctx context.Context) (string, error)

// XFetchCache implements probabilistic early recompute (Vattani, Chierichetti &
// Lowenstein, "Optimal Probabilistic Cache Stampede Prevention"). As an entry
// nears expiry, each reader recomputes it with a probability that rises toward the
// deadline, so statistically ONE reader rebuilds it slightly early while the rest
// keep serving the still-valid cached value. No lock, no stampede, no cold miss.
type XFetchCache struct {
	rdb  *redis.Client
	ttl  time.Duration
	beta float64 // >1 recomputes earlier (more eager); 1.0 is the standard default.
}

func NewXFetchCache(rdb *redis.Client, ttl time.Duration) *XFetchCache {
	return &XFetchCache{rdb: rdb, ttl: ttl, beta: 1.0}
}

// Get returns the cached value, transparently triggering an early recompute for
// (statistically) one reader as expiry approaches.
func (c *XFetchCache) Get(ctx context.Context, key string, recompute Recomputer) (string, error) {
	raw, err := c.rdb.Get(ctx, key).Result()
	if err == redis.Nil {
		// Cold miss: recompute now and populate. (In production, wrap this in a
		// per-key lock/singleflight so a cold key is not stampeded — chapter 12.)
		return c.recomputeAndStore(ctx, key, recompute)
	}
	if err != nil {
		return "", err
	}

	var e xfetchEntry
	if json.Unmarshal([]byte(raw), &e) != nil {
		// Corrupt entry: rebuild.
		return c.recomputeAndStore(ctx, key, recompute)
	}

	// The XFetch decision. delta is the recompute cost; ln(rand) is negative, so
	// `-delta*beta*ln(rand)` is a positive lead time that grows with cost and with
	// a random draw. When `now + lead >= expiry`, we recompute early. The closer to
	// expiry, the more likely the inequality holds — so P(recompute) rises smoothly
	// toward the deadline, and expensive values (large delta) recompute sooner.
	now := float64(time.Now().UnixMilli())
	lead := e.DeltaMS * c.beta * -math.Log(rand.Float64())
	if now-lead >= float64(e.ExpiryMS) {
		// This reader "won" the early-recompute roll. Rebuild ahead of the miss.
		// On failure we fall back to serving the still-valid cached value, so a
		// transient source error never turns into a miss.
		if fresh, rErr := c.recomputeAndStore(ctx, key, recompute); rErr == nil {
			return fresh, nil
		}
	}
	return e.Value, nil // the common path: serve the cached value, no recompute.
}

// recomputeAndStore rebuilds the value, MEASURES how long it took (that is the
// delta future XFetch decisions depend on), and stores value+delta+expiry with a
// jittered TTL so recomputes across keys also do not synchronise.
func (c *XFetchCache) recomputeAndStore(ctx context.Context, key string, recompute Recomputer) (string, error) {
	start := time.Now()
	value, err := recompute(ctx)
	if err != nil {
		return "", err
	}
	deltaMS := float64(time.Since(start).Milliseconds())
	if deltaMS < 1 {
		deltaMS = 1 // floor so even cheap values get a little lead time.
	}

	ttl := JitteredTTL(c.ttl, 0.10)
	entry := xfetchEntry{
		Value:    value,
		DeltaMS:  deltaMS,
		ExpiryMS: time.Now().Add(ttl).UnixMilli(),
	}
	data, _ := json.Marshal(entry)
	// The Redis TTL is a hair longer than our logical expiry so the key never
	// vanishes from under an in-flight XFetch decision; the logical expiry (and
	// jitter) drives the probabilistic refresh, Redis's TTL is just the backstop.
	if err := c.rdb.Set(ctx, key, data, ttl+5*time.Second).Err(); err != nil {
		return value, err // value is valid even if caching it failed.
	}
	return value, nil
}

// AdaptiveTTL scales a base TTL by observed access frequency: hot keys (many hits)
// get a longer TTL because they will be re-read, so caching them longer pays off;
// cold keys get a short TTL so the cache is not held hostage by rarely-read data.
// hits is a recent access count for the key (e.g. from an INCR with its own TTL).
func AdaptiveTTL(base time.Duration, hits int64) time.Duration {
	switch {
	case hits >= 100:
		return JitteredTTL(base*4, 0.10) // very hot: cache long
	case hits >= 10:
		return JitteredTTL(base*2, 0.10) // warm
	default:
		return JitteredTTL(base, 0.10) // cold: base
	}
}
```

The XFetch `Get` is the centre of gravity: the common case is one `GET`, a cheap arithmetic check that almost always says "no", and a return of the cached value; only as a hot key nears expiry does one lucky reader's roll cross the threshold and rebuild it early, entirely transparently. The `redis-cli` sketch of jitter and sliding TTL:

```bash
# Jittered absolute TTL (compute 300 +/- 10% in the app, then):
SET homepage:config "{...}" EX 317      # a neighbour key gets EX 289, etc.

# Sliding expiration: read and push the expiry out in one atomic command:
GETEX session:abc EX 1800               # active session lives another 30 min
GETEX session:abc PERSIST               # or clear the TTL entirely on read
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Jitter prevents avalanches for free.** One random number at populate time smears correlated expiries into an absorbable trickle of misses.
- **Refresh-ahead eliminates the hot-key miss.** A popular key is rebuilt before it expires, so reads never pay the cold-rebuild latency.
- **XFetch is near-stateless stampede prevention.** No locks, minimal coordination, and it self-tunes to recompute cost via `delta` — one reader refreshes, the rest serve cached.
- **Sliding TTL matches access-driven lifetimes.** `GETEX` keeps active data (sessions) alive and expires it after genuine inactivity, in one atomic command.
- **Adaptive TTL shapes memory toward hot data.** Hot keys live longer, cold keys expire fast, so the cache's memory tracks what is actually used.

**Disadvantages**
- **Sliding TTL removes the hard staleness bound.** A constantly-read entry never expires, so a missed invalidation on it never self-heals.
- **XFetch adds per-entry metadata and complexity.** You must store and maintain `delta` and an expiry, and the probabilistic reasoning is subtler than a plain TTL.
- **Refresh-ahead can waste recomputes.** Refreshing a key that then goes cold before its next read is wasted work; probability and adaptivity mitigate but do not eliminate this.
- **Adaptive/refresh logic needs access tracking.** Counting hits per key to drive adaptivity is itself cache load and state to manage.

**Trade-offs**
- *Absolute vs sliding:* absolute keeps the self-healing staleness bound at the cost of periodic hot-key misses; sliding maximises hit ratio for active data at the cost of the bound. Use absolute for cached authoritative data, sliding for session-like lifetimes.
- *Jitter amount:* more jitter spreads misses wider (safer against avalanche) but weakens the staleness bound's precision slightly; 5–10% is the usual sweet spot, more for mass warm-ups.
- *XFetch `beta`:* a higher `beta` recomputes earlier (fresher, but more recomputes and more source load); a lower `beta` recomputes closer to expiry (fewer recomputes, but a thinner safety margin before a real miss).
- *Refresh-ahead scope:* refreshing all keys ahead is wasteful; refreshing only known-hot keys (or letting XFetch's probability self-select them) targets the effort but needs either a curated hot-set or the probabilistic machinery.

## 7. Common Mistakes & Best Practices

- **One TTL for everything, no jitter.** Correlated populates become a correlated avalanche of misses. *Best practice:* jitter every TTL by 5–10%; never populate a batch of keys with an identical TTL.
- **Sliding TTL on data that needs a staleness bound.** A constantly-read key with sliding expiry never refreshes, so a missed invalidation persists forever. *Best practice:* use sliding only for access-driven lifetimes (sessions); use absolute where the TTL is a safety net.
- **Rebuilding a hot key only on expiry.** The expiry-triggered miss stampedes the source. *Best practice:* refresh ahead of expiry — XFetch probabilistically, or a scheduled refresh for a curated hot-set.
- **`GET` + `EXPIRE` instead of `GETEX`.** Two round trips and a race window for sliding expiration. *Best practice:* use `GETEX key EX ttl` to read and reset atomically.
- **A TTL shorter than the recompute time in refresh-ahead.** The value can expire during its own rebuild, defeating the purpose. *Best practice:* ensure the effective TTL comfortably exceeds `delta`; XFetch's `delta` term does this automatically.
- **Ignoring recompute cost.** Refreshing a cheap key and an expensive key with the same lead time under-protects the expensive one. *Best practice:* scale the refresh lead by recompute cost — exactly what XFetch's `delta * beta` term does.
- **Adaptive TTL with unbounded growth.** Letting hot keys extend TTL without limit can pin stale data. *Best practice:* cap the adaptive multiplier and keep an absolute ceiling so even hot data re-validates periodically.
- **Best practice overall:** jitter always, absolute-by-default with sliding only for sessions, refresh hot keys ahead of expiry (XFetch), and scale lead time by recompute cost.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** A synchronised dip in hit ratio with a matching spike in database queries every N seconds is the fingerprint of an avalanche — correlated TTLs expiring together — and the fix is jitter. A single hot key causing periodic source spikes is an expiry-triggered stampede, addressed by XFetch or scheduled refresh; confirm with `PTTL key` and by correlating source-query spikes with the key's expiry cadence. For sliding TTLs behaving unexpectedly, check that reads use `GETEX` (resetting) rather than `GET` (not resetting).
- **Monitoring.** Track hit ratio over time (dips reveal expiry patterns), the distribution of `PTTL` across a keyspace (a spike at one value means missing jitter), recompute rate and recompute latency (XFetch should show a low, steady recompute rate, not bursts), and source-query rate correlated with cache expiries. Alert on synchronised expiry (many keys with near-identical remaining TTL) as an avalanche early-warning.
- **Security.** TTLs are also a security control: short TTLs bound how long stale-but-sensitive data (a revoked token's cached authorization, a since-deleted record) can be served after the source changes, so security-relevant caches should favour shorter, absolute TTLs and explicit invalidation over long sliding ones. Do not let a sliding TTL keep a sensitive entry alive indefinitely past a revocation. The recompute path in refresh-ahead reaches the source of truth, so it inherits the source's authorization — a refresh must not bypass access checks.
- **Scaling.** Jitter is essential at scale precisely because large keyspaces populated together (a cluster-wide warm-up, a mass deploy) create the biggest avalanches; the more keys, the more jitter matters. XFetch scales beautifully because it needs no central coordination — each reader decides locally — so it works across a Redis Cluster without cross-node locking. For a huge fleet, a curated refresh-ahead scheduler for the top-N hottest keys complements XFetch by guaranteeing the truly critical keys are never cold, while probability handles the long tail. Adaptive TTL helps scaling by keeping cold data out of a memory-bound cache, improving the hit ratio per byte.

## 9. Interview Questions

**Q: What is the difference between absolute and sliding TTL?**
A: An absolute TTL expires an entry a fixed time after it was written, regardless of access — it gives a hard staleness bound (nothing is ever older than the TTL) and periodically re-misses even hot keys. A sliding TTL resets the expiry on every access, so a frequently-used entry keeps living and only expires after a period of no access — it maximises the hit ratio for active data but removes the hard staleness bound, because a constantly-read entry never expires. In Redis, sliding is implemented atomically with `GETEX key EX ttl`. The rule of thumb is absolute for cached copies of authoritative data (you want the self-healing bound), sliding for data whose lifetime genuinely should track access, like sessions.

**Q: What is TTL jitter and why is it necessary?**
A: Jitter is randomising each entry's TTL by a small percentage — say plus or minus 10% — so that keys populated together do not all expire in the same instant. Without it, a batch of keys warmed together (at deploy, on the same request) expires simultaneously, sending a synchronised flood of misses at the database — a cache avalanche. Jitter smears those expiries across a window so the miss load becomes an absorbable trickle. It costs one random number at populate time and is the single highest-leverage TTL habit; a TTL without jitter is a scheduled synchronised outage waiting for the population that triggers it.

**Q: What is refresh-ahead and what problem does it solve?**
A: Refresh-ahead proactively rebuilds a cached entry *before* its TTL fires, so a hot key is refreshed while its old value is still valid and being served, and reads never encounter the miss. It solves the single-hot-key stampede: without it, a very popular key expires and every concurrent request misses at once and hammers the source to rebuild. By refreshing ahead of demand, by one worker, the rebuild happens before the miss can occur. The design challenge is deciding who refreshes and when under concurrency, which is exactly what probabilistic early recompute (XFetch) answers.

**Q: Explain the XFetch / probabilistic early recompute algorithm.**
A: XFetch stores, alongside each value, the time it took to recompute it (`delta`) and its expiry. On each read it computes `now - delta * beta * ln(random)` and recomputes early if that exceeds the expiry, where `random` is uniform in (0,1) so `ln(random)` is negative and the term is a positive lead time. Far from expiry the probability of triggering is negligible; as the entry approaches expiry the probability rises smoothly, and it rises sooner for values that are expensive to recompute (large `delta`). Statistically, exactly one reader among many hitting a hot key crosses the threshold slightly before expiry, recomputes it, and refreshes the cache while everyone else serves the still-valid value. It prevents the stampede with no locks and almost no coordination, and it degrades gracefully — even if two readers recompute, that is two queries, not a thousand.

**Q: How does `GETEX` implement sliding expiration, and what came before it?**
A: `GETEX key EX ttl` reads the value and resets its TTL to `ttl` in one atomic command, which is exactly sliding expiration — every access pushes the expiry further out. Before `GETEX` (added in Redis 6.2) you had to issue a `GET` followed by a separate `EXPIRE`, which was two round trips and left a race window where the key could expire between the read and the `EXPIRE`, and where a concurrent operation could interleave. `GETEX` collapses it into one atomic operation, and it can also clear the TTL with `PERSIST` or set it in various units, making it the right primitive for session-like sliding lifetimes.

**Q: What is adaptive TTL?**
A: Adaptive TTL varies an entry's TTL by how hot it is: keys accessed frequently get a longer TTL because they will be re-read, so caching them longer raises the hit ratio, while rarely-accessed keys get a short TTL so the cache is not filled with cold data. It is a coarser, cheaper cousin of refresh-ahead that shapes the cache's memory toward what is actually used, which matters most in a memory-bound cache where every byte spent on cold data is a byte not spent on hot data. It needs some access tracking (a per-key hit counter) and should be capped so hot keys do not extend their TTL without bound and pin stale data.

**Q: What is stale-while-revalidate and how does it relate to refresh-ahead?**
A: Stale-while-revalidate serves the existing cached value immediately — even if it is near or just past its logical expiry within a grace window — while kicking off an asynchronous refresh in the background, so the reader never waits for the rebuild. It is about hiding rebuild *latency*: instead of a reader blocking on a miss to recompute, it gets a slightly stale answer now and the cache is freshened for the next reader. It relates to refresh-ahead as a complement rather than an alternative: refresh-ahead (and its probabilistic form, XFetch) tries to rebuild *before* expiry so there is no miss at all, while stale-while-revalidate ensures that even when a rebuild does happen on the read path, no user pays its latency. In practice you pair them — XFetch to avoid the miss proactively, stale-while-revalidate so any rebuild that still occurs is invisible to the reader.

**Q: (Senior) Walk through diagnosing and fixing a database that spikes every five minutes exactly.**
A: A source spike on a precise period is almost always a cache avalanche from correlated TTLs: a set of keys was populated together — a warm-up job, a deploy, a batch request — each with an identical TTL, so they all expire in the same instant every cycle, and the wave of simultaneous misses hits the database together. I would confirm by sampling `PTTL` across the suspect keyspace and looking for a spike of keys sharing nearly the same remaining TTL, and by correlating the database spike timing with a known populate event's time plus the TTL. The fix is jitter: populate with a randomised TTL (base plus or minus 5–10%) so the expiries spread across a window and the miss load smooths out. If the spike is actually one very hot key rather than many, it is an expiry-triggered stampede instead, and the fix is refresh-ahead — probabilistic early recompute so one reader rebuilds it before expiry — plus possibly a per-key lock on the cold-load path. I would also check whether the warm-up job itself could stagger its populates, and add monitoring that alerts on synchronised expiry (many keys with near-identical `PTTL`) so the next avalanche is caught before it becomes an incident. The general principle is that correlated births cause correlated deaths, and the cure is to decorrelate at populate time.

**Q: (Senior) How would you choose between XFetch, a per-key lock, and stale-while-revalidate for stampede prevention, and can they combine?**
A: They address the same problem — many misses on one hot key — at different points and with different trade-offs, and they compose. A per-key lock (local singleflight, or a distributed `SET NX PX` lock across processes) is reactive: it fires *after* the miss and serialises the rebuild so only one request loads while the others wait or briefly serve stale; it is simple and gives a hard guarantee of one rebuild, but the waiters still pay latency and it needs correct lock handling (timeouts, fencing). XFetch is proactive: it rebuilds *before* the miss so there is no miss to serialise, needs no lock, self-tunes to recompute cost, and scales across a cluster without coordination, at the cost of per-entry metadata and probabilistic (not guaranteed-single) rebuilds. Stale-while-revalidate is about latency during the rebuild: serve the stale value immediately and refresh asynchronously so no reader ever waits, which pairs naturally with either of the others. In practice I combine them: XFetch (or a scheduled refresh for the very hottest keys) to avoid the miss proactively, a per-key lock on the cold-load path as the hard backstop for a key that genuinely does miss (a first-ever load or an evicted key), and stale-while-revalidate so that even a rebuild that does happen on the read path never makes a user wait. The judgement is that XFetch handles the steady-state hot key elegantly, the lock handles the correctness edge of a true cold miss, and stale-while-revalidate handles the tail latency — each covers a case the others do not.

**Q: (Senior) What are the risks of sliding TTLs and adaptive TTLs, and how do you bound them?**
A: Both trade the hard staleness bound for a better hit ratio, and the risk in each is that data can be pinned in the cache indefinitely and drift arbitrarily far from the source. A sliding TTL on a constantly-read key never expires, so if an invalidation on that key is ever missed — a delete that did not fire, a race that repopulated it — the stale value is served forever, because the only mechanism that would have healed it (expiry) never triggers. Adaptive TTL has the same failure if hot keys are allowed to extend their TTL without limit: the hottest, most-served keys become the ones most likely to be stale, which is exactly backwards. I bound both by refusing to remove the safety net entirely. For sliding TTLs I cap the total lifetime with an absolute ceiling — an entry can slide, but not past, say, an hour since it was written — so even a constantly-accessed key re-validates periodically; this is a two-tier TTL, sliding within an absolute cap. For adaptive TTLs I cap the multiplier and enforce an absolute maximum, so hot keys live longer but still expire and reload on a bounded schedule. And for anything security-relevant (cached authorization, tokens) I lean toward short absolute TTLs and explicit invalidation rather than sliding at all, because there the cost of serving stale is a security bug, not just a correctness one. The principle is that a hit-ratio optimisation must never fully defeat the TTL's role as the self-healing backstop; keep an absolute ceiling under every sliding or adaptive scheme.

## 10. Quick Revision & Cheat Sheet

| Technique | What it does | Primitive |
|---|---|---|
| Absolute TTL | Fixed lifetime, hard staleness bound | `SET key v EX n` |
| Sliding TTL | Access resets expiry (sessions) | `GETEX key EX n` |
| Jitter | Decorrelate expiries, prevent avalanche | base +/- 5–10% |
| Refresh-ahead | Rebuild before expiry, no hot-key miss | scheduled / XFetch |
| XFetch | Probabilistic early recompute, one rebuilds | `now - delta*beta*ln(rand) >= expiry` |
| Adaptive TTL | Hot keys live longer, cold expire fast | TTL scaled by hit count |

| Symptom | Likely cause | Fix |
|---|---|---|
| Source spikes every N seconds | Correlated TTLs (avalanche) | Jitter |
| One hot key spikes source on expiry | Expiry-triggered stampede | XFetch / refresh-ahead |
| Sliding TTL never refreshing | `GET` not resetting expiry | Use `GETEX` |
| Hot key perpetually stale | No absolute ceiling on sliding | Two-tier TTL (sliding + cap) |

**Flash cards**
- **Absolute vs sliding?** &#8594; fixed lifetime + hard bound vs access-reset lifetime, no bound.
- **Why jitter?** &#8594; correlated births cause correlated deaths; jitter decorrelates expiry to stop avalanches.
- **Refresh-ahead?** &#8594; rebuild before expiry so reads never hit the miss.
- **XFetch formula?** &#8594; recompute if `now - delta*beta*ln(rand) >= expiry`; P rises toward expiry, sooner for costly values.
- **GETEX?** &#8594; atomic read + reset TTL; the sliding-expiration primitive.
- **Adaptive TTL?** &#8594; hot keys longer, cold shorter; cap it so nothing pins forever.

## 11. Hands-On Exercises & Mini Project

- [ ] Populate 10,000 keys with an identical TTL and chart the miss/query spike at expiry; add 10% jitter and show the spike flatten into a trickle.
- [ ] Implement sliding expiration with `GETEX` for a session and confirm it survives while accessed and expires after inactivity; contrast with `GET`+`EXPIRE`.
- [ ] Implement XFetch, drive a hot key with many concurrent readers as it nears expiry, and confirm (statistically) one reader recomputes while the rest serve cached.
- [ ] Vary XFetch `beta` and measure the trade between recompute frequency (source load) and freshness/margin before a real miss.
- [ ] Add adaptive TTL driven by a per-key hit counter and show hot keys living longer and cold keys expiring quickly, with an absolute ceiling enforced.
- [ ] Add stale-while-revalidate to the read path and show readers never blocking on a rebuild.

### Mini Project — "Expiry Lab: Avalanche, Stampede, and Refresh"

**Goal.** Make the three miss-avoidance techniques — jitter, XFetch, adaptive TTL — measurable against synthetic load, so TTL tuning becomes evidence-based.

**Requirements.**
1. Build a cache with pluggable TTL policy (absolute, sliding via `GETEX`, jittered) and a synthetic source with a controllable recompute cost.
2. Reproduce a cache avalanche with correlated TTLs, then fix it with jitter and quantify the reduction in peak source QPS.
3. Implement XFetch (store value + delta + expiry) and reproduce a single-hot-key stampede, then show XFetch eliminating it; report the number of recomputes per expiry cycle.
4. Add adaptive TTL from a per-key hit counter with an absolute ceiling, and measure hit-ratio-per-byte versus a flat TTL under a skewed (Zipfian) access pattern.
5. Instrument hit ratio, recompute rate, recompute latency, and source QPS over time and present them on a small dashboard.

**Extensions.**
- Add a curated refresh-ahead scheduler for the top-N hottest keys and compare its source load and freshness against pure XFetch.
- Add a two-tier TTL (sliding within an absolute cap) and demonstrate a constantly-read key still re-validating at the ceiling.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Design: Cache-Aside (Lazy Loading)* (TTL as the safety net), *Cache Stampede & the Thundering Herd* (locks and singleflight, the reactive complement to XFetch), *Memory, maxmemory & Eviction* (how TTL and eviction interact), *Cache Avalanche & Penetration* (the failure modes jitter and negative caching prevent), *Read-Through & Write-Through Caching* (where refresh logic lives in a layer).

- **Vattani, Chierichetti & Lowenstein — Optimal Probabilistic Cache Stampede Prevention** — VLDB 2015 · *Advanced* · the XFetch paper; the derivation of the `delta * beta * ln(rand)` early-recompute rule this chapter implements. <https://www.vldb.org/pvldb/vol8/p886-vattani.pdf>
- **Redis — EXPIRE, PEXPIRE, TTL, PTTL & key expiration** — Redis · *Beginner* · the expiration commands and the lazy-plus-active expiration model behind every TTL. <https://redis.io/docs/latest/commands/expire/>
- **Redis — GETEX** — Redis · *Intermediate* · the atomic read-and-reset-TTL command that implements sliding expiration correctly. <https://redis.io/docs/latest/commands/getex/>
- **Redis — Key eviction & expiration internals** — Redis · *Advanced* · how active and lazy expiration actually reclaim expired keys, which shapes how "expired" behaves under load. <https://redis.io/docs/latest/develop/reference/eviction/>
- **MDN — HTTP Cache-Control: stale-while-revalidate** — Mozilla · *Intermediate* · the serve-stale-and-refresh pattern that pairs with XFetch to hide rebuild latency. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/Cache-Control>
- **Designing Data-Intensive Applications, ch. 1 & 11** — Martin Kleppmann · *Advanced* · reasoning about freshness, correlated load, and the latency-vs-staleness trade that TTL strategy embodies. <https://dataintensive.net/>
- **Cloudflare — Cache stampede & the thundering herd** — Cloudflare blog · *Intermediate* · a practical engineering account of stampede prevention including early expiry and request coalescing. <https://blog.cloudflare.com/>
- **Redis University — RU101: Introduction to Redis** — Redis · *Beginner* · free course whose expiration and caching modules ground TTL behaviour in hands-on practice. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 11.*
