# 19 · Sorted Sets: Rate Limiting, Leaderboards & Windows

> **In one line:** The sorted set is Redis's most versatile type because a single number — the score — turns "keep things in order" into an atomic, server-side operation, and the same shape powers sliding-window rate limiters (score = timestamp), leaderboards (score = points) and time-windowed caches (score = time) with none of the races you would get faking them in application code.

---

## 1. Overview

A sorted set (ZSet) is a set of unique members, each carrying a floating-point **score**, kept permanently ordered by that score. That one idea — attach a number to a member and let Redis keep everything sorted — is deceptively powerful. It means you can add, remove, count, and range-query by score or by rank, all as atomic commands running on Redis's single thread, all in O(log N) or better. Any time your caching problem has a notion of *order* or a numeric key you want to slice by, the sorted set probably does it for you, atomically, in one round trip.

This chapter focuses on the three jobs sorted sets do better than anything else. **Sliding-window rate limiting** treats each request as a member scored by its timestamp; the window is a score range, the count is a `ZCARD`, and old requests are trimmed by score — assembled atomically, it is a precise limiter with none of the burstiness of the fixed-window approach. **Leaderboards** score members by points; the top N is a single reverse-range query, and a player's exact position is a single `ZRANK`, so the ranking your application would otherwise sort by hand becomes one atomic command. **Time-windowed caches** score entries by time and fetch "everything in the last 60 seconds" with one `ZRANGEBYSCORE`, trimming the past with `ZREMRANGEBYSCORE`.

The unifying lesson is atomicity. A rate limiter faked with `GET`/`INCR`/`SET` across several keys is a race waiting to happen — two requests can both read "under the limit" and both proceed. A sorted-set limiter bundles remove-old, count, and add into one atomic unit (a Lua script or a `MULTI`), so the decision is always made against a consistent snapshot. We will also place sliding-window against its cheaper cousins — fixed-window and token-bucket — so you know which limiter to reach for and why.

## 2. Core Concepts

- **Sorted set (ZSet)** — unique members each with a floating-point score, kept ordered by score; the ordering is maintained automatically on every insert.
- **Score** — the number that orders members; a timestamp (rate limiting, windows), points (leaderboard), or priority (queue).
- **`ZADD`** — add a member with a score, or update an existing member's score; supports flags like `NX`, `XX`, `GT`, `LT`, `CH`.
- **`ZRANGE` / `ZREVRANGE`** — fetch members by *rank* (position), ascending or descending; the basis of "top N".
- **`ZRANGEBYSCORE`** — fetch members whose *score* falls in a range; the basis of "everything in this time window".
- **`ZREMRANGEBYSCORE`** — atomically remove all members in a score range; the basis of "trim everything older than the window".
- **`ZCARD` / `ZCOUNT`** — count all members, or members within a score range; the basis of "how many in the window".
- **`ZRANK` / `ZREVRANK`** — the position of a member in score order; the basis of "what rank is this user".
- **`ZSCORE` / `ZINCRBY`** — read or atomically bump a member's score; the basis of "add points".
- **Sliding window** — a limiter that counts requests in a continuously-moving time window, avoiding the boundary bursts of fixed windows.
- **Token bucket** — a limiter modelling a bucket that refills at a steady rate, allowing controlled bursts up to a capacity.

## 3. Theory & Principles

### The sliding-window rate limiter

The problem with the simplest rate limiter — a **fixed window** — is bursting at the boundary. If you allow 100 requests per minute by incrementing a counter keyed on the current minute, a client can send 100 requests in the last second of one minute and 100 more in the first second of the next: 200 requests in two seconds, twice the intended rate, because the counter reset at the boundary. Fixed windows are cheap (one `INCR` with an `EXPIRE`) but let through double the limit across a boundary.

A **sliding window** fixes this by counting requests in a window that moves continuously with time rather than snapping to fixed boundaries. The sorted-set implementation is elegant: each request is a member of a ZSet scored by its timestamp. To decide whether a new request is allowed:

1. **Trim** everything older than the window: `ZREMRANGEBYSCORE key 0 (now - window)`.
2. **Count** what remains: `ZCARD key`.
3. If the count is below the limit, **add** this request: `ZADD key now unique-id`.
4. Set a TTL on the key so idle limiters clean themselves up.

The count in step 2 is exactly "how many requests in the last `window` milliseconds", continuously accurate — there is no boundary to burst across. The catch is that these four steps **must be atomic**: if two requests interleave between the count and the add, both can see "under the limit" and both proceed, over-admitting. So the whole sequence runs as one atomic unit — a Lua script (best, one round trip) or a `MULTI`/`EXEC` transaction. This is the crux: the sorted set gives you the right data shape, and atomicity gives you correctness.

The cost of sliding-window-with-a-ZSet is memory: it stores one member per request in the window, so a client sending 10,000 requests/minute keeps 10,000 members. For very high limits, the approximation of a *sliding-window-counter* (weighting two adjacent fixed windows) or a token bucket is cheaper.

### Leaderboards: order for free

A leaderboard is the canonical sorted-set use. Score = points; the set stays ordered by points automatically. Then:

- **Add points:** `ZINCRBY leaderboard 50 ada` — atomic, one round trip, and the ordering updates itself.
- **Top N:** `ZREVRANGE leaderboard 0 9 WITHSCORES` — the ten highest scorers, descending, in one command. Your application sorts nothing.
- **A user's rank:** `ZREVRANK leaderboard ada` — the zero-based position from the top, so "you are #4,217" is a single O(log N) command.
- **A user's score:** `ZSCORE leaderboard ada`.
- **A slice around a user** ("players near you"): compute the rank, then `ZREVRANGE` a window around it.

What makes this special is that the alternative — storing scores in a table and sorting to rank — is either O(N log N) per query or requires a maintained index, and is racy under concurrent score updates. The sorted set maintains the order incrementally and answers rank and range queries in logarithmic time, atomically. The one scaling caveat is that a single global leaderboard is one key — a big key on one Cluster node — so at extreme scale you shard (per-region, per-time-bucket) or accept the hotspot.

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Sliding-window rate limiter with a sorted set (score = timestamp)</text>

  <rect x="24" y="42" width="832" height="150" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">A moving window vs a fixed window: why fixed windows burst</text>

  <line x1="60" y1="120" x2="820" y2="120" stroke="#94a3b8" stroke-width="2"/>
  <text x="60" y="140" fill="#64748b" font-size="9">t=0s</text>
  <line x1="440" y1="112" x2="440" y2="128" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="140" text-anchor="middle" fill="#b91c1c" font-size="9">minute boundary</text>
  <text x="820" y="140" text-anchor="end" fill="#64748b" font-size="9">t=120s</text>

  <rect x="360" y="88" width="80" height="20" rx="3" fill="#fecaca" stroke="#dc2626"/>
  <text x="400" y="102" text-anchor="middle" fill="#b91c1c" font-size="8">100 reqs</text>
  <rect x="440" y="88" width="80" height="20" rx="3" fill="#fecaca" stroke="#dc2626"/>
  <text x="480" y="102" text-anchor="middle" fill="#b91c1c" font-size="8">100 reqs</text>
  <text x="600" y="86" fill="#b91c1c" font-size="9" font-weight="bold">Fixed window: 200 reqs in ~2s across the</text>
  <text x="600" y="100" fill="#b91c1c" font-size="9" font-weight="bold">boundary &#8212; DOUBLE the intended rate.</text>
  <text x="600" y="118" fill="#166534" font-size="9" font-weight="bold">Sliding window counts the moving 60s span &#8594;</text>
  <text x="600" y="132" fill="#166534" font-size="9" font-weight="bold">the burst is caught, rate stays true.</text>

  <rect x="24" y="204" width="832" height="264" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="226" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">The four steps &#8212; run ATOMICALLY (Lua or MULTI)</text>

  <rect x="44" y="240" width="180" height="200" rx="8" fill="#fff" stroke="#7c3aed"/>
  <text x="134" y="262" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">1. TRIM old</text>
  <text x="56" y="284" fill="#6d28d9" font-size="8" font-family="ui-monospace,monospace">ZREMRANGEBYSCORE</text>
  <text x="56" y="298" fill="#6d28d9" font-size="8" font-family="ui-monospace,monospace">key 0 (now-window)</text>
  <text x="56" y="322" fill="#6d28d9" font-size="9">drop requests older</text>
  <text x="56" y="336" fill="#6d28d9" font-size="9">than the window</text>
  <g font-family="ui-monospace,monospace" font-size="9">
    <rect x="56" y="352" width="30" height="16" rx="2" fill="#ddd6fe"/><text x="71" y="364" text-anchor="middle" fill="#5b21b6">t9</text>
    <rect x="90" y="352" width="30" height="16" rx="2" fill="#ddd6fe"/><text x="105" y="364" text-anchor="middle" fill="#5b21b6">t8</text>
    <rect x="124" y="352" width="30" height="16" rx="2" fill="#fca5a5"/><text x="139" y="364" text-anchor="middle" fill="#7f1d1d">t1</text>
    <rect x="158" y="352" width="30" height="16" rx="2" fill="#fca5a5"/><text x="173" y="364" text-anchor="middle" fill="#7f1d1d">t0</text>
  </g>
  <text x="134" y="392" text-anchor="middle" fill="#dc2626" font-size="8">red = removed (too old)</text>
  <text x="134" y="420" text-anchor="middle" fill="#6d28d9" font-size="8">O(log N + M) removed</text>

  <rect x="240" y="240" width="180" height="200" rx="8" fill="#fff" stroke="#7c3aed"/>
  <text x="330" y="262" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">2. COUNT</text>
  <text x="252" y="284" fill="#6d28d9" font-size="9" font-family="ui-monospace,monospace">ZCARD key</text>
  <text x="252" y="308" fill="#6d28d9" font-size="9">how many requests</text>
  <text x="252" y="322" fill="#6d28d9" font-size="9">remain in the window?</text>
  <rect x="252" y="340" width="156" height="60" rx="6" fill="#ede9fe"/>
  <text x="330" y="366" text-anchor="middle" fill="#5b21b6" font-size="14" font-weight="bold">count = 2</text>
  <text x="330" y="386" text-anchor="middle" fill="#6d28d9" font-size="9">limit = 5 ?</text>

  <rect x="436" y="240" width="180" height="200" rx="8" fill="#fff" stroke="#7c3aed"/>
  <text x="526" y="262" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">3. DECIDE + ADD</text>
  <text x="448" y="286" fill="#166534" font-size="9">if count &lt; limit:</text>
  <text x="460" y="302" fill="#166534" font-size="8" font-family="ui-monospace,monospace">ZADD key now id</text>
  <text x="460" y="316" fill="#166534" font-size="9">&#8594; ALLOW</text>
  <text x="448" y="340" fill="#b91c1c" font-size="9">else:</text>
  <text x="460" y="356" fill="#b91c1c" font-size="9">&#8594; REJECT (429)</text>
  <rect x="448" y="368" width="156" height="32" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="526" y="388" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">2 &lt; 5 &#8594; add, allow</text>

  <rect x="632" y="240" width="204" height="200" rx="8" fill="#fff" stroke="#7c3aed"/>
  <text x="734" y="262" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">4. EXPIRE</text>
  <text x="648" y="286" fill="#6d28d9" font-size="8" font-family="ui-monospace,monospace">PEXPIRE key window</text>
  <text x="648" y="310" fill="#6d28d9" font-size="9">idle limiters clean</text>
  <text x="648" y="324" fill="#6d28d9" font-size="9">themselves up &#8212; no</text>
  <text x="648" y="338" fill="#6d28d9" font-size="9">leaked keys per user</text>
  <rect x="648" y="356" width="172" height="60" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="734" y="380" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">All 4 steps in ONE</text>
  <text x="734" y="396" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">atomic unit &#8594; no</text>
  <text x="734" y="410" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">over-admit race</text>
</svg>
```

### Fixed vs sliding vs token bucket

Three limiter shapes, three trade-offs:

- **Fixed window** — one counter per time bucket (`INCR` + `EXPIRE`). Cheapest (one integer, one command), but allows up to 2× the limit across a boundary. Fine when approximate limiting is acceptable.
- **Sliding window (log)** — the sorted-set approach above. Precise — no boundary burst — but stores one member per request, so memory scales with the limit. Best when accuracy matters and per-key request volume is bounded.
- **Token bucket** — a bucket of capacity C refilling at R tokens/second; each request costs a token, and a request is allowed if a token is available. Allows *controlled* bursts (up to C) while enforcing the long-run rate R. Cheap (two numbers: token count and last-refill time), and the model most APIs actually want. Implemented atomically as a small Lua script or with Redis's `CL.THROTTLE` (RedisBloom/redis-cell).

The rule of thumb: token bucket for most public APIs (bursts are desirable and it is memory-cheap), sliding-window-log when you need exact "N per rolling window" semantics and the volume is modest, fixed window when you just need a coarse throttle and want the absolute minimum cost.

## 4. Architecture & Workflow

### Assembling the atomic limiter

The rate-limiter workflow, step by step, and where atomicity enters:

1. **Key per subject.** One ZSet per limited entity — `rl:{user:42}` or `rl:{ip:1.2.3.4}`. The hash tag `{...}` keeps it on one Cluster slot (irrelevant for a single key, but a habit for multi-key scripts).
2. **Score = timestamp.** Use millisecond (or microsecond) precision so distinct requests get distinct scores; the *member* is a unique request id (to avoid two same-millisecond requests colliding as one member).
3. **The atomic block.** Trim old, count, decide, conditionally add, set TTL — as a single Lua script evaluated with `EVALSHA`. Lua on Redis runs atomically (nothing else executes during the script) and in one round trip, which is both correct and fast.
4. **Return the decision.** The script returns allowed/denied plus, ideally, the remaining quota and a retry-after, so the caller can set `X-RateLimit-*` headers.

Using `MULTI`/`EXEC` instead of Lua also gives atomicity, but you cannot branch inside a transaction (the decision "add only if under limit" needs the count first), so you either optimistically add-then-check-then-maybe-remove or use `WATCH` with a retry loop. Lua is cleaner because it can read the count and branch in the same atomic execution. This is why the canonical sliding-window limiter is a Lua script.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="lb" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Leaderboard: the sorted set maintains order, so queries never sort</text>

  <rect x="24" y="42" width="330" height="330" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="189" y="64" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">ZSet: member = player, score = points</text>
  <text x="189" y="82" text-anchor="middle" fill="#6d28d9" font-size="9">kept ordered on every ZADD/ZINCRBY</text>
  <g font-family="ui-monospace,monospace" font-size="10">
    <rect x="44" y="94" width="290" height="26" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="54" y="111" fill="#5b21b6">2200  grace   &#8592; rank 1 (top)</text>
    <rect x="44" y="124" width="290" height="26" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="54" y="141" fill="#5b21b6">1600  ada     &#8592; rank 2</text>
    <rect x="44" y="154" width="290" height="26" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="54" y="171" fill="#5b21b6">1450  omar    &#8592; rank 3</text>
    <rect x="44" y="184" width="290" height="26" rx="3" fill="#fef3c7" stroke="#d97706"/><text x="54" y="201" fill="#92400e">1200  you     &#8592; rank 4</text>
    <rect x="44" y="214" width="290" height="26" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="54" y="231" fill="#5b21b6">1100  lee     &#8592; rank 5</text>
    <rect x="44" y="244" width="290" height="26" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="54" y="261" fill="#5b21b6"> 900  nina    &#8592; rank 6</text>
  </g>
  <text x="44" y="294" fill="#5b21b6" font-size="9" font-weight="bold">ZINCRBY board 100 ada &#8594; re-sorts itself atomically</text>
  <text x="44" y="312" fill="#6d28d9" font-size="9">no table scan, no client-side sort, O(log N) insert</text>
  <text x="44" y="336" fill="#6d28d9" font-size="9">score = points; the number does all the ordering work</text>
  <text x="44" y="356" fill="#6d28d9" font-size="9">reset per season: new key board:2026Q3 + TTL</text>

  <rect x="370" y="42" width="486" height="330" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="613" y="64" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Each query is one atomic command</text>

  <rect x="388" y="80" width="450" height="60" rx="6" fill="#fff" stroke="#7c3aed"/>
  <text x="398" y="100" fill="#5b21b6" font-size="10" font-weight="bold">Top N</text>
  <text x="398" y="118" fill="#6d28d9" font-size="9" font-family="ui-monospace,monospace">ZREVRANGE board 0 9 WITHSCORES</text>
  <text x="398" y="134" fill="#64748b" font-size="9">&#8594; the 10 highest, descending &#8212; O(log N + M)</text>

  <rect x="388" y="150" width="450" height="60" rx="6" fill="#fff" stroke="#7c3aed"/>
  <text x="398" y="170" fill="#5b21b6" font-size="10" font-weight="bold">A user's exact rank</text>
  <text x="398" y="188" fill="#6d28d9" font-size="9" font-family="ui-monospace,monospace">ZREVRANK board you   &#8594; 3  (0-based) &#8594; "#4"</text>
  <text x="398" y="204" fill="#64748b" font-size="9">&#8594; exact position, O(log N), no scan of the board</text>

  <rect x="388" y="220" width="450" height="70" rx="6" fill="#fff" stroke="#d97706"/>
  <text x="398" y="240" fill="#92400e" font-size="10" font-weight="bold">"Players near you"</text>
  <text x="398" y="258" fill="#b45309" font-size="9" font-family="ui-monospace,monospace">rank = ZREVRANK board you</text>
  <text x="398" y="274" fill="#b45309" font-size="9" font-family="ui-monospace,monospace">ZREVRANGE board rank-2 rank+2 WITHSCORES</text>
  <text x="398" y="288" fill="#64748b" font-size="8">&#8594; a bounded window &#8212; NEVER ZRANGE 0 -1 (O(N) stall)</text>

  <rect x="388" y="300" width="450" height="58" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="613" y="320" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">Scaling caveat: one global board = one big key</text>
  <text x="398" y="338" fill="#991b1b" font-size="9">all members on one Cluster slot &#8594; hotspot; shard by</text>
  <text x="398" y="352" fill="#991b1b" font-size="9">region/period and merge tops, or cache the hot top-N view.</text>
</svg>
```

### Leaderboard workflow

For a leaderboard the workflow is simpler because each operation is already a single atomic command:

1. **Score update** on an event: `ZINCRBY leaderboard delta member`.
2. **Read top N** for the page: `ZREVRANGE leaderboard 0 N-1 WITHSCORES`.
3. **Read a user's standing:** `ZREVRANK` (position) + `ZSCORE` (points), optionally a window around their rank for a "near you" view.
4. **Reset per season:** either a new key per season (`leaderboard:2026Q3`) with a TTL, or `DEL`/`UNLINK` of the old key. A fresh key per period is cleaner and lets you keep history.

The only place you need a transaction is when a single logical event must update several sorted sets consistently (a global and a regional leaderboard) — then a `MULTI` or a Lua script keeps them in step.

## 5. Implementation

A complete sliding-window rate limiter (Lua + go-redis) and a leaderboard, both real and runnable.

```go
package sortedsets

import (
	"context"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

// ---------- SLIDING-WINDOW RATE LIMITER ----------

// slidingWindowLua implements the four steps ATOMICALLY. Because a Lua script
// runs to completion with nothing else interleaving, the trim/count/decide/add
// sequence cannot be split by a concurrent request — no over-admit race.
//
// KEYS[1] = the limiter key (one ZSet per subject)
// ARGV[1] = now in milliseconds
// ARGV[2] = window length in milliseconds
// ARGV[3] = max requests allowed in the window
// ARGV[4] = a unique member id for THIS request (so same-ms requests don't
//           collapse into one member)
// Returns: {allowed(1/0), remaining, retry_after_ms}
var slidingWindowLua = redis.NewScript(`
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

-- 1. TRIM: drop everything older than (now - window). Scores are timestamps.
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

-- 2. COUNT what remains in the window.
local count = redis.call('ZCARD', key)

if count < limit then
  -- 3a. ALLOW: record this request scored by its timestamp.
  redis.call('ZADD', key, now, member)
  -- 4. EXPIRE so an idle limiter cleans itself up (window + slack).
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
else
  -- 3b. REJECT. Compute retry-after from the OLDEST in-window request: once it
  -- falls out of the window, a slot frees up.
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  local retry = window
  if oldest[2] then
    retry = (tonumber(oldest[2]) + window) - now
    if retry < 0 then retry = 0 end
  end
  redis.call('PEXPIRE', key, window)
  return {0, 0, retry}
end
`)

// RateLimiter wraps the script with sensible parameters.
type RateLimiter struct {
	rdb    *redis.Client
	limit  int64         // max requests per window
	window time.Duration // window length
}

func NewRateLimiter(rdb *redis.Client, limit int64, window time.Duration) *RateLimiter {
	return &RateLimiter{rdb: rdb, limit: limit, window: window}
}

// Decision is the limiter's answer, suitable for X-RateLimit-* headers.
type Decision struct {
	Allowed    bool
	Remaining  int64
	RetryAfter time.Duration
}

// Allow runs the atomic limiter for one subject (user id, IP, api key).
func (rl *RateLimiter) Allow(ctx context.Context, subject string) (Decision, error) {
	now := time.Now()
	key := "rl:{" + subject + "}" // hash tag keeps it on one Cluster slot
	// A unique member per request: timestamp + a monotonically-unique suffix.
	member := fmt.Sprintf("%d-%d", now.UnixNano(), time.Now().UnixNano()%1e6)

	res, err := slidingWindowLua.Run(ctx, rl.rdb,
		[]string{key},
		now.UnixMilli(),
		rl.window.Milliseconds(),
		rl.limit,
		member,
	).Int64Slice()
	if err != nil {
		return Decision{}, err
	}
	return Decision{
		Allowed:    res[0] == 1,
		Remaining:  res[1],
		RetryAfter: time.Duration(res[2]) * time.Millisecond,
	}, nil
}

// ---------- LEADERBOARD ----------

// Leaderboard is a thin wrapper over a single sorted set: member = player,
// score = points. Ordering is maintained by Redis on every update.
type Leaderboard struct {
	rdb *redis.Client
	key string
}

func NewLeaderboard(rdb *redis.Client, key string) *Leaderboard {
	return &Leaderboard{rdb: rdb, key: key}
}

// AddPoints atomically bumps a player's score. One round trip; the ordering
// updates itself — the application never sorts anything.
func (lb *Leaderboard) AddPoints(ctx context.Context, player string, delta float64) (float64, error) {
	return lb.rdb.ZIncrBy(ctx, lb.key, delta, player).Result()
}

// TopN returns the highest-scoring N players, descending, in one command.
func (lb *Leaderboard) TopN(ctx context.Context, n int64) ([]redis.Z, error) {
	// ZREVRANGE 0..n-1 with scores: the top slice, no client-side sort.
	return lb.rdb.ZRevRangeWithScores(ctx, lb.key, 0, n-1).Result()
}

// Standing returns a player's rank (1-based from the top) and score. ZRevRank is
// O(log N) — an exact position without scanning.
func (lb *Leaderboard) Standing(ctx context.Context, player string) (rank int64, score float64, err error) {
	// ZRevRank is 0-based; add 1 for a human "you are #N".
	r, err := lb.rdb.ZRevRank(ctx, lb.key, player).Result()
	if err != nil {
		return 0, 0, err
	}
	s, err := lb.rdb.ZScore(ctx, lb.key, player).Result()
	if err != nil {
		return 0, 0, err
	}
	return r + 1, s, nil
}

// Around returns a window of players centred on the given player — the
// "players near you" view. Two round trips: find the rank, then range around it.
func (lb *Leaderboard) Around(ctx context.Context, player string, radius int64) ([]redis.Z, error) {
	rank, err := lb.rdb.ZRevRank(ctx, lb.key, player).Result()
	if err != nil {
		return nil, err
	}
	start := rank - radius
	if start < 0 {
		start = 0
	}
	return lb.rdb.ZRevRangeWithScores(ctx, lb.key, start, rank+radius).Result()
}

// ---------- TIME-WINDOWED CACHE ----------

// RecordEvent stores an event scored by its timestamp, and trims anything older
// than the retention window in the same call path. This is the same shape as the
// rate limiter, used as a rolling cache of recent events.
func RecordEvent(ctx context.Context, rdb *redis.Client, key, payload string, retain time.Duration) error {
	now := time.Now()
	if err := rdb.ZAdd(ctx, key, redis.Z{
		Score:  float64(now.UnixMilli()),
		Member: fmt.Sprintf("%d:%s", now.UnixNano(), payload),
	}).Err(); err != nil {
		return err
	}
	cutoff := now.Add(-retain).UnixMilli()
	return rdb.ZRemRangeByScore(ctx, key, "0", fmt.Sprintf("%d", cutoff)).Err()
}

// RecentEvents fetches everything within the window in one range query.
func RecentEvents(ctx context.Context, rdb *redis.Client, key string, within time.Duration) ([]string, error) {
	min := fmt.Sprintf("%d", time.Now().Add(-within).UnixMilli())
	return rdb.ZRangeByScore(ctx, key, &redis.ZRangeBy{Min: min, Max: "+inf"}).Result()
}
```

The rate limiter's correctness lives entirely in the Lua script's atomicity; the leaderboard's power lives in the sorted set maintaining order so `ZREVRANGE` and `ZREVRANK` answer top-N and position without the application ever sorting. Both replace application logic with one atomic server-side operation.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Atomic ordered operations.** Add, remove, count, and range-by-score/rank are single atomic commands in O(log N) — no client-side sorting, no races.
- **One shape, many jobs.** Rate limiters, leaderboards, priority queues and time windows all fall out of "member + score", so one well-understood type covers a lot of ground.
- **Precise sliding windows.** The ZSet limiter counts a continuously-moving window, eliminating the boundary burst that fixed windows allow.
- **Exact rank and range.** `ZRANK`/`ZREVRANGE` give a user's exact position and any slice of the ranking cheaply, which relational sorting cannot match under concurrency.

**Disadvantages**
- **Memory scales with members.** A sliding-window-log limiter stores one member per in-window request, so high per-subject volume is expensive; leaderboards store one member per participant.
- **Big-key hazard.** A single global leaderboard or a busy limiter is one key on one Cluster node — a hotspot, and an O(N) command over it blocks that node's thread.
- **Higher per-element cost than a plain set.** The skiplist/listpack overhead makes sorted sets pricier per member than unordered sets.
- **Score precision limits.** Scores are IEEE-754 doubles; very large integer timestamps in nanoseconds can exceed exact integer representation (use milliseconds, or store the id in the member).

**Trade-offs**
- *Fixed vs sliding vs token bucket:* fixed is cheapest but bursts at boundaries; sliding-window-log is precise but memory grows with the limit; token bucket allows controlled bursts and is memory-cheap — pick by whether you need exactness, burst tolerance, or minimum cost.
- *Lua vs MULTI for the limiter:* Lua can branch on the count inside one atomic execution (cleaner); `MULTI` cannot branch, so it needs optimistic add-then-maybe-remove or `WATCH` retries. Prefer Lua.
- *One global leaderboard vs sharded:* one key is simplest and gives a true global rank, but is a big-key hotspot; sharding (per-region, per-period) distributes load at the cost of harder global ranking.
- *Member granularity:* millisecond scores collapse same-ms requests unless the member is unique — trade a slightly larger member for correctness.

## 7. Common Mistakes & Best Practices

- **Faking a rate limiter with `GET`/`INCR`/`SET` across steps.** Non-atomic: two requests both read "under the limit" and both proceed, over-admitting. **Best practice:** bundle the whole decision into one Lua script (or `MULTI`) so it is atomic.
- **Using a fixed window and being surprised by 2× bursts.** A client sends the full quota either side of a boundary. **Best practice:** use a sliding window or token bucket when boundary bursts matter.
- **Same-timestamp members colliding.** Two requests in the same millisecond scored identically with the same member become one member, under-counting. **Best practice:** make the member unique (id/counter), not just the timestamp.
- **Never expiring limiter keys.** Per-user limiter ZSets accumulate forever for one-shot visitors. **Best practice:** `PEXPIRE` the key to the window length so idle limiters self-clean.
- **`ZRANGE key 0 -1` (fetching the whole sorted set).** O(N) and transfers everything — a stall on a large leaderboard. **Best practice:** fetch only the page you need (`ZREVRANGE 0 N-1`) or iterate with `ZSCAN`.
- **A single giant global leaderboard as a Cluster hotspot.** All members on one slot concentrate memory and latency. **Best practice:** shard by region/time when scale demands, or accept and monitor the hotspot.
- **Nanosecond timestamps as scores.** Doubles cannot represent very large integers exactly, corrupting ordering. **Best practice:** use millisecond scores and keep fine detail in the member.
- **Best practice overall: let the sorted set do the ordering, and make the multi-step decision atomic.** The type gives you order for free; atomicity (Lua) gives you correctness under concurrency.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `ZCARD key` shows how many members a limiter or leaderboard holds — a runaway count signals a missing trim or expiry. `ZRANGE key 0 5 WITHSCORES` (a *bounded* slice) inspects the newest/oldest entries and their scores to verify timestamps look right. `OBJECT ENCODING` shows `listpack` vs `skiplist` — a small sorted set stays a compact listpack. For a misbehaving limiter, log the script's returned `{allowed, remaining, retry}` to see the decision.
- **Monitoring.** Track limiter rejection rates (a spike means either an attack or a mis-tuned limit), the memory of hot leaderboard/limiter keys (`MEMORY USAGE`), and any O(N) sorted-set command in the `SLOWLOG`. For leaderboards, watch member counts and per-key memory since they grow with participants.
- **Security.** Rate limiting *is* a security control — it is the front-line defence against brute-force, credential-stuffing and scraping — so the limiter must be atomic (a race is an exploitable bypass) and keyed on something the attacker cannot cheaply rotate (per-account plus per-IP, not per-IP alone). Ensure the limiter fails *closed* or *open* deliberately: if Redis is unavailable, decide in advance whether to reject (fail closed, safer) or allow (fail open, more available). Leaderboards holding user handles inherit that data's sensitivity.
- **Scaling.** A limiter shards naturally — each subject's key hashes to some Cluster slot, spreading load across nodes. A single global leaderboard does not; it is one big key on one node, so at extreme scale you shard it (regional leaderboards merged for a global view, or per-period keys) or replicate reads. For very high-volume limiting where the sliding-window-log's per-request memory hurts, switch to a token bucket (two numbers per subject) implemented as a Lua script or via `redis-cell`/`CL.THROTTLE`.

## 9. Interview Questions

**Q: What is a sorted set and why is it so useful for caching?**
A: A sorted set is a collection of unique members, each with a floating-point score, kept permanently ordered by that score. It is useful because a huge number of caching problems reduce to "keep things in order by a number": leaderboards (score = points), sliding-window rate limiters (score = timestamp), priority queues (score = priority), and time-windowed caches (score = time). For each, the sorted set replaces application-side sorting and windowing — which are chatty and racy under concurrency — with atomic O(log N) server-side commands: `ZADD` to insert, `ZRANGEBYSCORE` for a range, `ZREVRANGE` for top-N, `ZRANK` for position, `ZREMRANGEBYSCORE` to trim. Any time you find yourself sorting or slicing by a numeric key in the application, a sorted set probably does it atomically for you.

**Q: How do you build a sliding-window rate limiter with a sorted set?**
A: Each request is a member scored by its timestamp. To decide a new request: trim everything older than the window with `ZREMRANGEBYSCORE key 0 (now-window)`; count the remainder with `ZCARD`; if under the limit, add the request with `ZADD key now unique-id` and set a TTL; otherwise reject. The count is exactly "requests in the last `window` milliseconds", continuously accurate with no boundary to burst across. The essential detail is that these steps must run atomically — as a Lua script or a `MULTI` — because if two requests interleave between the count and the add, both can see "under the limit" and both proceed, over-admitting.

**Q: Why is a fixed-window limiter worse than a sliding window?**
A: Because it bursts at the boundary. A fixed window increments a counter keyed on the current time bucket (say the minute) and resets when the bucket rolls over, so a client can send the full quota in the last moment of one window and the full quota again in the first moment of the next — up to twice the intended rate in a short span straddling the boundary. A sliding window counts requests in a window that moves continuously with time, so there is no boundary to exploit and the rate stays true. The trade is cost: the fixed window is one integer and one `INCR`, while the sliding-window-log stores one member per request. When exactness matters, pay for the sliding window; when a coarse throttle suffices, the fixed window is cheaper.

**Q: How do you get a user's exact rank on a leaderboard?**
A: `ZREVRANK leaderboard user` returns the zero-based position from the top (highest score first), so "you are #4,217" is a single O(log N) command — add one to make it human-friendly. `ZSCORE` gives their points, and a window around their rank (compute the rank, then `ZREVRANGE start end`) gives the "players near you" view. This is the sorted set's headline advantage: the alternative — storing scores in a table and sorting to compute a rank — is O(N log N) per query or needs a maintained index, and is racy under concurrent score updates, whereas the sorted set maintains order incrementally and answers rank in logarithmic time atomically.

**Q: When would you use a token bucket instead of a sliding window?**
A: When you want to allow controlled bursts while enforcing a long-run rate, and when memory matters. A token bucket models a bucket of capacity C that refills at R tokens per second; each request consumes a token and is allowed if one is available. That lets a client burst up to C requests instantly (good for real APIs, where clients batch) while the refill rate caps the sustained throughput at R. It is also memory-cheap — two numbers per subject (token count and last-refill time) versus one member per request for the sliding-window-log. Most public APIs actually want token-bucket semantics. Reach for the sliding-window-log instead when you need exact "no more than N in any rolling window" semantics and per-subject volume is bounded.

**Q: (Senior) Why must the sliding-window limiter be atomic, and what are your options for making it so?**
A: Because the decision spans multiple steps — trim, count, and conditionally add — and if another request interleaves between the count and the add, both requests can observe a count under the limit and both proceed, admitting more than the limit allows. That is a correctness bug and, since rate limiting is a security control, an exploitable bypass. The options are Lua and `MULTI`. Lua is the right tool: a script runs to completion on Redis's single thread with nothing interleaving, and — crucially — it can read the count and *branch* on it (add only if under the limit) within that one atomic execution, all in a single round trip. `MULTI`/`EXEC` also gives atomicity but cannot branch mid-transaction, because the commands are queued before any results are known; so with `MULTI` you either optimistically add-then-check-then-maybe-remove, or use `WATCH` on the key with an optimistic-retry loop, both clumsier than Lua. There is also a subtle detail: use `EVALSHA` with the cached script hash to avoid shipping the script body each call, and keep the script short and O(log N + M) so it does not itself become a blocking command on the single thread.

**Q: (Senior) A global leaderboard is becoming a hotspot. How do you scale it?**
A: The root problem is that a sorted set is one key, and in Cluster all of a key's members live on one slot, so a single global leaderboard concentrates all its memory and every read/write on one node — and any O(N) command over it (a full `ZRANGE`, a big `ZREMRANGEBYSCORE`) blocks that node's single thread for everyone on the shard. The scaling options, roughly in order: first, make sure you are never doing O(N) operations — page with `ZREVRANGE 0 N-1`, never fetch the whole set. Second, offload reads with replicas, since top-N and rank queries are read-heavy and can be served from a replica with slight staleness. Third, shard the leaderboard itself — for example per region or per time period — so each shard is a smaller key on a different node; a global top-N then merges the per-shard tops (correct because the global top-N is a subset of the union of per-shard tops), and a true global rank becomes approximate or requires a merge step. Fourth, for extreme scale, precompute and cache the hot views (the top 100 rarely changes minute to minute) as a plain string, refreshing periodically, so the expensive sorted set is queried rarely. The trade is always the same: sharding and caching buy throughput and distribution at the cost of exact, up-to-the-moment global ranking.

**Q: (Senior) What are the failure modes and edge cases of the sorted-set rate limiter?**
A: Several. First, member collisions: if you score by millisecond and use the timestamp as the member, two requests in the same millisecond become one member and you undercount — the member must be unique (append a counter or request id). Second, score precision: scores are doubles, so nanosecond timestamps can exceed exact integer representation and corrupt ordering; use milliseconds and keep detail in the member. Third, unbounded memory: the log stores one member per in-window request, so a client hammering at high volume grows the key large — for high limits switch to a token bucket. Fourth, key leakage: without a TTL, a limiter key persists forever for one-shot visitors; always `PEXPIRE` to the window. Fifth, clock issues: the limiter trusts `now`; in a distributed setting passing each app server's clock as `now` risks skew, so either pass a single authoritative time or use Redis's `TIME` inside the script. Sixth, the fail-open/fail-closed decision: if Redis is unreachable the limiter cannot decide, and you must choose deliberately whether to reject (fail closed, safer against abuse) or allow (fail open, better availability) — and that choice is itself a security posture. Finally, at Cluster scale, ensure the limiter key's slot is stable (a hash tag) and that the Lua script touches only that one key, or cross-slot errors will break it.

**Q: How would you implement "players near you" efficiently?**
A: Compute the player's rank with `ZREVRANK` (O(log N)), then fetch a window around it with `ZREVRANGE rank-radius rank+radius WITHSCORES` (O(log N + M) for the small M-sized window). That is two round trips and no full scan, giving the slice of the ranking centred on the user. The key point is never to fetch the whole sorted set to find neighbours — the rank plus a bounded range does it cheaply, whereas `ZRANGE 0 -1` would be O(N) and stall the thread on a large board.

**Q: What is the memory cost of the sliding-window-log limiter, and how do you bound it?**
A: It stores one member per request currently inside the window, so the memory per subject is proportional to that subject's request rate times the window length — a client allowed 10,000 requests per minute keeps up to ~10,000 members. Across many subjects this adds up. You bound it by: setting a TTL so idle limiters disappear; capping the limit (the count cannot exceed the limit plus a little, since you stop adding once at the limit — though rejected requests are not added, so the set is bounded by the limit); and, when limits are large enough that even the bounded set is expensive, switching to a token bucket, which stores just two numbers per subject regardless of rate. The sliding-window-log is precise but pays memory for that precision; the token bucket trades a little precision for constant memory.

## 10. Quick Revision & Cheat Sheet

| Job | Score is | Key commands |
|---|---|---|
| Sliding-window rate limit | timestamp | `ZREMRANGEBYSCORE` + `ZCARD` + `ZADD` (atomic) |
| Leaderboard | points | `ZINCRBY`, `ZREVRANGE`, `ZREVRANK`, `ZSCORE` |
| Time-windowed cache | time | `ZADD`, `ZRANGEBYSCORE`, `ZREMRANGEBYSCORE` |
| Priority queue | priority | `ZADD`, `ZPOPMIN` |

| Limiter | Cost | Boundary burst? | Bursts allowed? |
|---|---|---|---|
| Fixed window | 1 integer | Yes (up to 2×) | No |
| Sliding window (log) | 1 member/request | No | No |
| Token bucket | 2 numbers | No | Yes (up to capacity) |

**Flash cards**
- **Sorted set superpower?** → Atomic order by score; `ZRANGE`/`ZRANK`/`ZREMRANGEBYSCORE` in O(log N).
- **Sliding-window steps?** → Trim old → count → decide → add → expire, all atomic (Lua).
- **Why atomic?** → Between count and add, two requests both see "under limit" → over-admit.
- **Fixed-window flaw?** → Up to 2× the limit across the boundary.
- **Token bucket?** → Two numbers; controlled bursts up to capacity; long-run rate R.
- **User's rank?** → `ZREVRANK` (O(log N)); "near you" = rank ± radius via `ZREVRANGE`.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement the sliding-window limiter as a Lua script and prove atomicity: fire concurrent requests at the limit and confirm never more than the limit are admitted.
- [ ] Build a fixed-window limiter and demonstrate the boundary burst (2× the rate across a boundary), then show the sliding window catching it.
- [ ] Build a leaderboard, add scores for 100k players, and fetch the top 10, a user's rank, and a "near you" window — timing each.
- [ ] Implement a token-bucket limiter in Lua and compare its memory per subject to the sliding-window-log.
- [ ] Store events in a time-windowed sorted set and fetch "the last 60 seconds" with one `ZRANGEBYSCORE`; verify old entries are trimmed.
- [ ] Measure the memory of a limiter under a high request rate and confirm the TTL cleans up idle subjects.

### Mini Project — "Rate Limiter & Leaderboard Service"

**Goal.** Build a small HTTP service backed by sorted sets that both rate-limits its callers and maintains a leaderboard, with correctness demonstrated under concurrency.

**Requirements.**
1. Implement the sliding-window limiter as an `EVALSHA` Lua script returning allowed/remaining/retry-after, and set `X-RateLimit-*` headers from it.
2. Key limiters per (account, IP) with a hash tag for Cluster safety and a TTL for self-cleanup.
3. Implement a leaderboard endpoint: submit points (`ZINCRBY`), read top-N (`ZREVRANGE`), read a user's standing (`ZREVRANK`+`ZSCORE`), and a "near you" window.
4. Load-test the limiter with concurrent clients and assert the admitted count never exceeds the limit (the atomicity proof).
5. Add a token-bucket alternative behind a flag and compare memory and burst behaviour against the sliding-window-log.

**Extensions.**
- Shard the leaderboard by region and implement a merged global top-N.
- Make the fail-mode configurable (fail-open vs fail-closed when Redis is unreachable) and test both.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Redis Data Types & Which to Cache With* (where the sorted set sits), *Redis as a Cache* (why atomic server-side ops exist), *Strings, Hashes & Object Caching* (the other object containers), *Build: Pipelining, Transactions & Lua* (the atomicity mechanisms this chapter relies on), *HyperLogLog, Bitmaps & Probabilistic Caching* (approximate counting for windows).

- **Redis — Sorted sets data type** — Redis · *Beginner* · the authoritative reference for `ZADD`/`ZRANGE`/`ZRANK` and their complexity, the type this chapter is built on. <https://redis.io/docs/latest/develop/data-types/sorted-sets/>
- **Redis — Rate limiting patterns** — Redis · *Intermediate* · the official patterns for fixed and sliding-window limiting, with Lua examples. <https://redis.io/docs/latest/develop/use/patterns/>
- **Stripe — Scaling your API with rate limiters** — Stripe Engineering · *Advanced* · a production account of token-bucket and concurrency limiters, why bursts are desirable, and how to layer limiters. <https://stripe.com/blog/rate-limiters>
- **Cloudflare — How we built rate limiting capable of scaling to millions of domains** — Cloudflare · *Advanced* · the sliding-window-counter approximation and the memory/accuracy trade at scale. <https://blog.cloudflare.com/counting-things-a-lot-of-different-things/>
- **Redis — EVAL / Lua scripting** — Redis · *Advanced* · how scripts run atomically on the single thread, the basis of the correct limiter. <https://redis.io/docs/latest/develop/interact/programmability/eval-intro/>
- **redis-cell (CL.THROTTLE) — token bucket as a Redis module** — brandur/redis-cell · *Advanced* · a ready-made atomic token-bucket command, the memory-cheap limiter. <https://github.com/brandur/redis-cell>
- **System Design — Designing a rate limiter** — ByteByteGo · *Intermediate* · a design-interview walkthrough of the limiter algorithms and their trade-offs. <https://bytebytego.com/>
- **Redis University — RU101** — Redis · *Beginner* · free course grounding sorted sets and their operations in hands-on exercises. <https://university.redis.com/>

---

*Caching with Redis Handbook — chapter 19.*
