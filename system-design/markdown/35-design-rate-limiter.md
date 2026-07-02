# 35 · Design: Distributed Rate Limiter

> **In one line:** Decide, in under a millisecond and across a fleet of servers, whether to allow or 429 a request — where the whole design is about the algorithm, atomic counting in Redis, and what to do when Redis itself is down.

---

## 1. Problem & Requirements

A rate limiter caps how many requests a client (user, API key, IP) may make in a time window, protecting a service from abuse, accidental floods, and noisy neighbors. It sits on the hot path of *every* request, so it must be fast and correct under concurrency. The interview crux: pick the **algorithm** (sliding window vs token bucket), make the counter **atomic** across a distributed fleet, and decide **fail-open vs fail-closed** when the counting store fails.

**Functional**
- Enforce limits like "100 requests / minute / API key", "5 login attempts / minute / IP".
- Support multiple, layered rules (per-user, per-endpoint, global) and different limits per tier (free vs paid).
- On limit exceeded, return **HTTP 429 Too Many Requests** with a `Retry-After` header.
- Limits must hold **across all app servers** (a distributed counter), not per-instance.

**Non-functional**
- **Latency**: the limiter adds < **1–2 ms** to every request. It must be effectively free.
- **Accuracy**: correct under high concurrency — no double-count or lost-count races. Small over/under-count at window edges may be tolerable depending on algorithm.
- **Availability**: the limiter must not take down the service it protects. If the counting store is unavailable, you choose **fail-open** (allow) or **fail-closed** (block).
- **Scale**: 1M+ QPS across the fleet; millions of distinct keys.

## 2. Capacity Estimation

```text
TRAFFIC
  Fleet QPS (peak)     = 1,000,000 req/s
  Every request => 1 rate-limit check   -> 1,000,000 limiter ops/s
  If central Redis: 1M ops/s -> shard across ~10 nodes (each ~100K ops/s, well within Redis)

STATE PER KEY
  Token bucket:  {tokens:int, last_refill:ts}  ~ 40 bytes
  Sliding log:   a sorted set of timestamps, up to LIMIT entries per key
                 e.g. 100 req/min limit -> up to 100 * 16B ≈ 1.6 KB/key (heavier)
  Sliding-window-counter: 2 counters/key ~ 32 bytes (cheap, approximate)

MEMORY (10M active keys)
  Token bucket:  10M * 40B   = 400 MB      -> trivial for Redis
  Sliding log:   10M * 1.6KB = 16 GB       -> pricey; prefer counter or bucket at scale

LATENCY BUDGET
  Redis round trip in-DC ~0.2–0.5 ms; a Lua script = 1 RTT -> fits the <1–2ms budget.
  Cross-region Redis would blow the budget -> keep the limiter store LOCAL to the region.
```

**Takeaway:** the check itself is cheap; the hard parts are keeping it **atomic** (one Redis round trip, not read-modify-write) and choosing state that doesn't blow up memory (token bucket / sliding-window-counter over a full sliding log).

## 3. API Design

The limiter is usually middleware, not a public API, but conceptually:

```text
allow(key, rule) -> Decision
  key   = "user:42:POST:/login"   (dimension you're limiting on)
  rule  = { limit: 100, window: 60s, algorithm: token_bucket, burst: 20 }
  returns { allowed: bool, remaining: int, retryAfter: seconds, resetAt: ts }
```

Response contract to the client on a block:

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 30
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1719950400
```

Always return `Retry-After` and the `X-RateLimit-*` headers so well-behaved clients back off instead of hammering.

## 4. Data Model

State lives in **Redis** (in-memory, atomic ops, TTL) — a disk DB can't meet the latency or op rate. Key design encodes the limiting dimension:

```text
Token bucket   (Redis hash + Lua)
  key   = "rl:{tenant}:{userId}:{route}"
  value = { tokens: float, last_refill_ms: int }
  TTL   = window * 2   (auto-expire idle keys -> caps memory)

Sliding window counter  (two fixed buckets)
  key_curr = "rl:{key}:{window_epoch}"     -> INCR, count in current window
  key_prev = "rl:{key}:{window_epoch-1}"   -> previous window's count
  estimate = prev * overlap_fraction + curr

Sliding window log  (exact, heavier)
  key = "rl:{key}" -> ZSET of request timestamps; ZREMRANGEBYSCORE to drop old, ZCARD to count
```

TTL on every key is essential — it's what keeps memory bounded as clients churn.

## 5. High-Level Design

Each app server (or an API gateway / Envoy sidecar) runs limiter middleware. On each request it computes the key and executes a single **atomic Lua script** against a sharded Redis cluster. Redis returns allow/deny; the middleware either forwards the request or returns 429. A control plane pushes rule config to the gateways.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a3" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="390" y="18" text-anchor="middle" fill="#64748b">Every request hits limiter middleware → one atomic Lua call to sharded Redis</text>

  <rect x="20" y="140" width="90" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="65" y="168" text-anchor="middle" fill="#1e293b">Client</text>

  <rect x="150" y="140" width="110" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="205" y="160" text-anchor="middle" fill="#1e293b">API Gateway</text>
  <text x="205" y="176" text-anchor="middle" fill="#64748b">+ limiter mw</text>

  <rect x="300" y="90" width="120" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="110" text-anchor="middle" fill="#1e293b">Local cache</text>
  <text x="360" y="126" text-anchor="middle" fill="#64748b">short-circuit</text>

  <rect x="300" y="190" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="210" text-anchor="middle" fill="#1e293b">Upstream</text>
  <text x="360" y="226" text-anchor="middle" fill="#1e293b">Service</text>

  <rect x="470" y="120" width="130" height="80" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="535" y="150" text-anchor="middle" fill="#1e293b">Redis Cluster</text>
  <text x="535" y="168" text-anchor="middle" fill="#64748b">sharded, atomic</text>
  <text x="535" y="184" text-anchor="middle" fill="#64748b">Lua scripts</text>

  <rect x="640" y="30" width="120" height="46" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="700" y="50" text-anchor="middle" fill="#1e293b">Control plane</text>
  <text x="700" y="66" text-anchor="middle" fill="#64748b">rule config</text>

  <line x1="110" y1="163" x2="148" y2="163" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="260" y1="150" x2="298" y2="115" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="420" y1="113" x2="468" y2="140" stroke="#475569" marker-end="url(#a3)"/>
  <text x="445" y="120" fill="#64748b" font-size="11">check</text>
  <line x1="260" y1="176" x2="298" y2="210" stroke="#475569" marker-end="url(#a3)"/>
  <text x="250" y="205" fill="#059669" font-size="11">allow</text>
  <line x1="205" y1="140" x2="205" y2="120" stroke="#b91c1c" marker-end="url(#a3)"/>
  <text x="120" y="118" fill="#b91c1c" font-size="11">429 on deny</text>
  <line x1="700" y1="76" x2="700" y2="120" stroke="#475569" marker-end="url(#a3)" stroke-dasharray="4 3"/>
  <line x1="640" y1="60" x2="262" y2="150" stroke="#475569" marker-end="url(#a3)" stroke-dasharray="4 3"/>
</svg>
```

## 6. Deep Dive

### 6.1 Algorithm choice

| Algorithm | Idea | Pros | Cons |
|---|---|---|---|
| **Fixed window** | Count per calendar window (per minute) | Trivial, 1 counter | **Edge burst**: 2× limit across a boundary (100 at 0:59, 100 at 1:00) |
| **Sliding window log** | Store every request timestamp; count those in the trailing window | **Exact**, no edge burst | Memory = O(limit) per key; expensive at scale |
| **Sliding window counter** | Weight previous + current fixed window by overlap | Cheap (2 counters), smooth, no hard edge | Slightly **approximate** (assumes uniform distribution) |
| **Token bucket** | Bucket of N tokens refills at rate r; each request takes 1 | Allows controlled **bursts** up to bucket size; smooth steady rate; tiny state | Two params to tune (rate, burst); not a strict "N per window" semantic |
| **Leaky bucket** | Queue drains at fixed rate | Smooths output to a constant rate | Adds queueing latency; less common for APIs |

**Recommended defaults:** **token bucket** when you want to allow bursts (most API limits — a client can spend saved capacity), and **sliding window counter** when you want a strict "N per window" with cheap, smooth enforcement. Avoid fixed window (edge burst) and sliding log at scale (memory). Stripe uses token bucket; Cloudflare popularized the sliding-window-counter approximation.

### 6.2 Atomicity — why you need Lua

A naive `GET count; if < limit: INCR` is a **read-modify-write race**: under concurrency two servers both read 99, both allow, both write 100 — the limit is breached. The check and the mutation must be **one atomic operation**. Redis executes a **Lua script** atomically (single-threaded, no interleaving), so the entire "refill, check, decrement" runs indivisibly:

```text
-- token_bucket.lua (atomic on Redis)
local key      = KEYS[1]
local rate     = tonumber(ARGV[1])   -- tokens/sec
local burst    = tonumber(ARGV[2])   -- bucket capacity
local now      = tonumber(ARGV[3])   -- ms
local bucket   = redis.call('HMGET', key, 'tokens', 'ts')
local tokens   = tonumber(bucket[1]) or burst
local last     = tonumber(bucket[2]) or now
tokens = math.min(burst, tokens + (now - last)/1000 * rate)   -- refill
local allowed  = tokens >= 1
if allowed then tokens = tokens - 1 end
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(burst/rate*1000)*2)      -- TTL bounds memory
return { allowed and 1 or 0, tokens }
```

`INCR` alone is atomic too (good enough for a simple counter window), but token bucket / sliding logic needs multiple ops → Lua. Redis Cluster requires all `KEYS` in a script to hash to the same slot — one key per script, so that's fine.

### 6.3 Central Redis vs local + sync

| Approach | How | Pros | Cons |
|---|---|---|---|
| **Central Redis** | All nodes check one (sharded) Redis | **Globally accurate**; simple mental model | Network hop per request (~0.5ms); Redis is a dependency & potential hot shard |
| **Local (in-memory) counters** | Each node limits independently | Zero network latency; no shared dep | Effective limit = N nodes × limit (way over); inaccurate |
| **Local + async sync** | Local counters, periodically gossip/aggregate to a central view | Low latency, bounded inaccuracy | Eventual — brief over-admission; more complex |

**Choose central sharded Redis** for correctness when the ~0.5ms hop is acceptable (it usually is in-DC). Use **local token buckets with async sync** only when you need sub-100µs decisions or must survive Redis outages — accepting that each node may briefly allow up to its local share. A common hybrid: coarse local pre-filter (cheap reject of obvious floods) backed by authoritative central Redis.

### 6.4 Clock, precision & window edges

- **Clock skew:** token bucket uses elapsed time for refill; if nodes disagree on `now`, refill drifts. Prefer using **Redis server time** (`redis.call('TIME')`) inside the Lua script as the single clock, rather than each app server's wall clock.
- **Precision:** use millisecond timestamps; integer seconds cause coarse, bursty refills.
- **Window edges:** fixed window's 2× burst is why we prefer sliding-window-counter or token bucket. The counter's approximation error is bounded and smooth.

### 6.5 Fail-open vs fail-closed

When Redis is unreachable, the limiter must decide:

- **Fail-open (allow):** if the store is down, let requests through unlimited. Protects **availability** — the limiter never becomes the cause of an outage. Risk: during the outage you have no protection (abuse/floods get through). Default for most user-facing APIs.
- **Fail-closed (block):** if the store is down, reject. Protects the **backend** (e.g. a fragile payment system that must never be overrun) at the cost of rejecting legitimate traffic. Default for limits guarding a hard capacity ceiling or security controls (login/OTP).

Best practice: **fail-open by default**, with a **local fallback limiter** (approximate in-memory bucket) so you degrade to coarse protection rather than none, and a circuit breaker + timeout (e.g. 5ms) so a slow Redis doesn't add latency to every request.

## 7. Bottlenecks & Scaling

- **Redis hot shard (one hot key):** a single very high-traffic API key can overload one shard. Mitigate by sharding the key itself (`key:{bucket 0..15}`, sum shards) or a local pre-filter for that key.
- **Op rate:** 1M ops/s → shard Redis across nodes by key; each node handles ~100K ops/s comfortably.
- **Network latency:** keep the limiter store **in-region**; never make the hot path cross a WAN.
- **Memory growth:** TTL every key; prefer token bucket / counter over sliding log.
- **Config propagation:** rules change (raise a limit) must propagate fast; push via control plane with versioning, cache locally.
- **Thundering 429s:** when many clients hit the limit simultaneously they may retry in sync; return jittered `Retry-After` to spread retries.

## 8. Failure Scenarios

| Failure | Blast radius | Mitigation |
|---|---|---|
| Redis cluster down | No central counting | **Fail-open** + local approximate fallback; circuit breaker with short timeout |
| Redis slow (not down) | Latency added to every request | Hard timeout (~5ms) on the limiter call → treat as fail-open; alert |
| Hot key overloads a shard | That key's limiting degraded | Sub-shard the key; local pre-filter; dedicated shard for whales |
| Clock skew across nodes | Refill drift, over/under limiting | Use Redis `TIME` as the single clock inside Lua |
| Race / double count | Limit breached under load | Atomic Lua script (never read-modify-write in app code) |
| Config push lag | Stale limits enforced | Versioned rules, bounded cache TTL, fast propagation |
| Retry storm after 429 | Backend re-flooded | Jittered `Retry-After`; exponential backoff guidance to clients |

## 9. Trade-offs & Alternatives

- **Token bucket vs sliding-window-counter:** bucket allows bursts (client-friendly, good for general APIs); counter gives strict "N per window" cheaply. Pick per rule — you'll run both.
- **Central vs local:** central for accuracy, local for latency/resilience. The hybrid (local pre-filter + central authority) is what large gateways actually run.
- **Fail-open vs fail-closed:** open protects your uptime, closed protects a fragile backend. Choose per limit, not globally — login OTP fails closed, a generic read API fails open.
- **At 10×:** move counting into the gateway/sidecar (Envoy's global rate limiting), shard Redis further, and lean on local token buckets with periodic sync to cut the per-request hop. The algorithm choices don't change.

## 10. Interview Follow-ups

**Q: Which algorithm and why?**
A: Token bucket when bursts are acceptable (most APIs — cheap state, smooth rate, controlled burst); sliding-window-counter when I need a strict "N per window" without the memory of a full log. I avoid fixed window (2× edge burst) and sliding log (O(limit) memory per key) at scale.

**Q: How do you make the counter atomic across many servers?**
A: A single Redis **Lua script** that does refill+check+decrement indivisibly. Never `GET`-then-`INCR` in app code — that's a read-modify-write race where two servers both read under the limit and both allow.

**Q: Central Redis or local counters?**
A: Central sharded Redis for global accuracy when the ~0.5ms in-DC hop is fine. Local (in-memory) is faster but limits become N× too loose. The production answer is a hybrid: local pre-filter for obvious floods, authoritative central Redis for correctness, with async sync if I need to survive Redis outages.

**Q: Redis just went down — allow or block?**
A: Depends on the limit. Fail-**open** by default for user-facing APIs so the limiter never causes an outage, backed by a local approximate fallback + a 5ms circuit breaker. Fail-**closed** for limits guarding a fragile/finite backend or security flows (login, OTP), where over-admission is worse than rejecting.

**Q: Two requests arrive at the same instant when 1 token remains — what happens?**
A: The Lua script serializes them (Redis is single-threaded per shard): the first decrements to 0 and is allowed, the second sees 0 and is denied. No race because check and decrement are one atomic op.

**Q: How do you handle clock skew?**
A: Use Redis server time (`redis.call('TIME')`) as the single clock inside the script for refill math, instead of each app server's wall clock, and use millisecond precision.

**Q: How do you keep memory bounded with millions of keys?**
A: TTL every key (≈ 2× the window) so idle clients' state auto-expires, and prefer token bucket / two-counter state over a full timestamp log.

**Q: A single API key sends 500K QPS and overloads one Redis shard — fix?**
A: Sub-shard that key across N logical buckets (`key:{0..N}`) and sum, or give whales a dedicated shard, or add a local pre-filter that rejects once the node-local estimate is clearly over.

**Q: What do you return to the client on a limit hit?**
A: HTTP 429 with `Retry-After` (jittered to avoid synchronized retries) and `X-RateLimit-Limit/Remaining/Reset` headers so well-behaved clients back off.

**Q: How do you support different limits for free vs paid tiers and multiple layered rules?**
A: Encode the dimension in the key (`tenant:user:route`) and resolve the rule from a control-plane config keyed by tier; evaluate layered rules (per-user AND per-endpoint AND global) — deny if any layer denies.

**Q: How do you prevent the limiter from adding latency when Redis is slow?**
A: A hard per-call timeout (~5ms) plus a circuit breaker; on timeout, treat as fail-open (or fall back to the local limiter) so a degraded Redis never slows every request.

## 11. Cheat Sheet

> [!TIP]
> **Distributed Rate Limiter in one screen**
> - **Where:** middleware/gateway on every request; adds < 1–2 ms.
> - **Algorithm:** **token bucket** (allow bursts, tiny state) or **sliding-window-counter** (strict N/window, cheap). Avoid fixed window (edge burst) and sliding log (memory).
> - **Atomicity:** one **Redis Lua** script does refill+check+decrement — never read-modify-write in app code.
> - **Topology:** central **sharded Redis** for accuracy; local pre-filter for latency/resilience (hybrid).
> - **Clock:** use Redis `TIME`, millisecond precision. **TTL** every key to bound memory.
> - **On store failure:** **fail-open** by default (+ local fallback, 5ms circuit breaker); **fail-closed** for fragile/finite backends & security flows.
> - **Response:** 429 + jittered `Retry-After` + `X-RateLimit-*` headers.

**References:** Stripe Engineering "Scaling your API with rate limiters", Cloudflare "How we built rate limiting" (sliding window counter), Redis docs (Lua scripting, EVAL), Envoy global rate limiting docs

---
*System Design Handbook — topic 35.*
