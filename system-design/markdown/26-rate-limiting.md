# 26 · Rate Limiting Algorithms

> **In one line:** Cap how fast a client may act — to protect capacity, ensure fairness, and enforce quotas — using a counter algorithm whose burst tolerance and memory cost you deliberately choose.

---

## 1. Overview

A **rate limiter** restricts how many operations a client may perform in a time window — e.g., *100 requests per minute per API key*. When the client exceeds the limit, the server rejects excess work, typically with HTTP **429 Too Many Requests**, instead of degrading or falling over.

Rate limiting exists to solve three distinct problems that happen to share a mechanism. **Protection:** shield finite backend capacity from overload, whether accidental (a retry storm, a buggy client) or malicious (credential stuffing, scraping, layer-7 DoS). **Fairness:** stop one noisy tenant from starving everyone else on shared infrastructure — the "noisy neighbor" problem. **Monetization:** enforce plan quotas (free = 60 req/min, pro = 6000 req/min) as a product feature.

It is one of the highest-leverage reliability primitives: a few lines at the edge can be the difference between shedding 5% of traffic gracefully and a full cascading outage. Every serious API — Stripe, GitHub, Twitter, AWS — publishes rate limits and returns `429` with a `Retry-After` hint so well-behaved clients can back off.

The engineering is a series of trade-offs: *which algorithm* (burst tolerance vs. smoothness vs. memory), *where to enforce* (edge vs. gateway vs. service), *what to key on* (user vs. IP vs. API key), and *how to make it correct across many servers* (distributed state, usually in Redis) without the limiter itself becoming a bottleneck or a single point of failure.

## 2. Core Concepts

- **Limit & window** — the quota (`N`) over a duration (`W`), e.g., 100 req / 60 s. The window model (fixed, sliding, or continuous refill) is what distinguishes the algorithms.
- **Burst vs. sustained rate** — a limiter may allow short bursts above the average rate (token bucket) or enforce a strictly smooth rate (leaky bucket). Real clients are bursty; strictly smooth is often too harsh.
- **Throttling vs. shaping** — *reject* excess (429) vs. *delay/queue* excess to smooth it (leaky bucket as a shaper). Rejecting preserves latency; shaping preserves work.
- **Key / identity** — the dimension you count against: API key, user ID, IP, tenant, or a tuple. Choosing the key is choosing who shares a bucket.
- **Enforcement point** — edge/CDN, API gateway, or in-service. Earlier = cheaper to reject, later = more context.
- **Distributed limiting** — one logical limit across N servers requires shared, atomic counter state (Redis), not per-node counters.
- **Soft vs. hard limit** — soft warns/logs/degrades; hard rejects. Often you run both (alert at 80%, block at 100%).
- **Fail-open vs. fail-closed** — if the limiter's datastore is down, do you allow all traffic (protect availability) or block it (protect the backend)? Usually fail-open for user traffic.
- **`Retry-After` / rate-limit headers** — tell honest clients exactly when and how much to back off, turning rejection into cooperation.

## 3. Architecture

Rate limiting is a **decision at a choke point**: for each request, extract an identity key, atomically consult a counter store, and allow or reject. The choke point sits as early in the request path as practical so rejected work costs the least.

```svg
<svg viewBox="0 0 760 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" fill="#64748b">Rate limiting at the gateway, backed by a shared counter store</text>

  <rect x="20" y="60" width="110" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="75" y="95" text-anchor="middle" fill="#1e293b">Clients</text>

  <rect x="180" y="60" width="140" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="250" y="88" text-anchor="middle" fill="#1e293b">API Gateway</text>
  <text x="250" y="106" text-anchor="middle" fill="#64748b">limiter middleware</text>

  <rect x="180" y="200" width="140" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="250" y="228" text-anchor="middle" fill="#1e293b">Redis</text>
  <text x="250" y="246" text-anchor="middle" fill="#64748b">counters (atomic)</text>

  <rect x="420" y="60" width="140" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="490" y="95" text-anchor="middle" fill="#1e293b">Service A</text>

  <rect x="600" y="60" width="140" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="670" y="95" text-anchor="middle" fill="#1e293b">Service B</text>

  <line x1="130" y1="90" x2="178" y2="90" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="250" y1="120" x2="250" y2="198" stroke="#475569" marker-end="url(#a2)"/>
  <text x="330" y="165" text-anchor="middle" fill="#64748b">INCR + EXPIRE (Lua, atomic)</text>
  <line x1="320" y1="90" x2="418" y2="90" stroke="#475569" marker-end="url(#a2)"/>
  <text x="370" y="80" text-anchor="middle" fill="#64748b">allow</text>
  <line x1="560" y1="90" x2="598" y2="90" stroke="#475569" marker-end="url(#a2)"/>

  <path d="M250 60 C 200 20, 120 20, 90 58" fill="none" stroke="#b91c1c" stroke-dasharray="4 3" marker-end="url(#a2)"/>
  <text x="150" y="30" text-anchor="middle" fill="#b91c1c">429 + Retry-After</text>

  <rect x="420" y="200" width="320" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="580" y="226" text-anchor="middle" fill="#1e293b">Layered limits: edge (coarse, per-IP) →</text>
  <text x="580" y="246" text-anchor="middle" fill="#64748b">gateway (per-key) → service (per-endpoint cost)</text>
</svg>
```

In practice you run **layered limits**: a coarse per-IP limit at the CDN/edge absorbs volumetric abuse before it reaches your infrastructure; a per-API-key limit at the gateway enforces plan quotas; and a fine-grained per-endpoint limit inside a service protects an expensive downstream (a report generator, a payment call). Each layer catches what the previous one couldn't see.

## 4. How It Works

The hot path is identical regardless of algorithm; only the counter math differs. For a distributed limiter the whole check-and-update **must be atomic** — otherwise two servers read the same count and both allow, overshooting the limit (a check-then-set race). In Redis this means a single `INCR`, a `MULTI/EXEC`, or a **Lua script** (which runs atomically on the server).

```text
On each request:
  1. key   = identity(request)          # e.g. "rl:apikey:AK123:endpoint:/charge"
  2. now   = current_time()
  3. allowed, remaining, reset = LIMITER.check(key, now)   # ATOMIC in the store
  4. set headers:
        RateLimit-Limit: N
        RateLimit-Remaining: remaining
        RateLimit-Reset: reset_seconds
  5. if allowed:
        forward to backend
     else:
        return 429 Too Many Requests
                Retry-After: reset_seconds
```

Token-bucket check (the most common), expressed as the atomic step:
```text
bucket = {tokens, last_refill}         # stored per key
elapsed   = now - last_refill
tokens    = min(capacity, tokens + elapsed * refill_rate)   # lazy refill
last_refill = now
if tokens >= 1:
    tokens -= 1;  ALLOW
else:
    ALLOW = false;  Retry-After = (1 - tokens) / refill_rate
```

The key subtlety is **lazy refill**: you don't run a timer adding tokens every tick. You store `last_refill` and compute how many tokens *would* have accrued since then, on demand. This makes the limiter O(1) memory per key and O(1) per request, with no background job — the reason token bucket scales to millions of keys.

## 5. Key Components / Deep Dive

### Fixed window counter
Count requests per fixed clock window (e.g., the current minute `12:03:00–12:03:59`). One integer per key; increment and compare, reset at window boundary (`INCR` + `EXPIRE`). Dead simple and cheap. **Flaw: the boundary burst.** A client can send `N` at `12:03:59` and `N` more at `12:04:00` — `2N` requests in one second, straddling two windows. Fine for coarse quotas, wrong for strict protection.

### Sliding window log
Store a timestamp for every request (a sorted set / list). On each request, drop timestamps older than `now - W`, then count what remains; allow if `< N`. **Perfectly accurate** — no boundary artifact, exact rolling window. **Cost: O(N) memory per key** (a timestamp per request in-window) and more expensive operations. Use when precision matters and per-key volume is modest (e.g., login attempts).

### Sliding window counter
The pragmatic middle ground. Keep two fixed-window counters (current and previous) and estimate the rolling count by weighting the previous window by how far the current window has elapsed:
```text
count = current_count + previous_count * (1 - elapsed_fraction_of_current_window)
```
~2 integers per key, no boundary burst, tiny bounded error. This is what most production limiters (including CDNs) use — it captures ~99% of sliding-log accuracy at fixed-window cost.

### Token bucket
A bucket of capacity `C` refills at `R` tokens/sec; each request spends one token; empty bucket ⇒ reject. **Allows bursts** up to `C` while enforcing average rate `R` — matching real bursty clients. O(1) memory (two numbers), O(1) per request via lazy refill. The default choice for API rate limiting; used by AWS API Gateway, Stripe, and NGINX (`limit_req` is a leaky-bucket variant).

### Leaky bucket
Requests enter a fixed-size queue that drains ("leaks") at a constant rate; a full queue drops requests. Enforces a **strictly smooth output rate** regardless of input burstiness — it's a traffic *shaper*, not just a limiter. Good for protecting a downstream that needs even load (a serial device, a payment processor with its own limits). Downside: queued requests add latency, and it rejects bursts that token bucket would happily allow. Token bucket allows bursts; leaky bucket forbids them — that's the core distinction.

### Distributed rate limiting with Redis
Per-node counters don't work: with 10 servers each allowing 100/min, a client gets 1000/min. Centralize the counter in **Redis** and make the check atomic with a **Lua script** (read + compute + write in one server-side operation, no round-trip race). Add per-key `EXPIRE` so idle keys self-clean. Beware Redis becoming a SPOF/bottleneck: replicate it, shard by key, and decide fail-open vs. fail-closed. For extreme scale, use **local token buckets synced to a global budget** (each node holds a slice of the quota, periodically reconciled) to avoid a Redis hit on every request.

### Keying strategy
- **API key / user ID** — the fairest and most common for authenticated APIs; ties the limit to identity, survives IP changes.
- **IP address** — the only option pre-auth (login, signup); but NAT/corporate proxies share an IP (false positives) and IPs are cheap to rotate (evasion). Combine with device fingerprints.
- **Tenant / org** — for B2B multi-tenant fairness.
- **Composite** — `apikey + endpoint` so an expensive endpoint has its own tighter budget, weighted by request **cost** (a search costs 10 tokens, a health check costs 1).

## 6. Trade-offs

| Algorithm | Pros | Cons |
|---|---|---|
| **Fixed window** | Trivial, 1 int/key, cheapest | 2× burst at window boundary; jagged |
| **Sliding window log** | Exact, no boundary artifact | O(N) memory/key; costly at high volume |
| **Sliding window counter** | ~Exact, ~2 ints/key, cheap | Small approximation error; slightly more logic |
| **Token bucket** | Allows natural bursts; O(1); average-rate control | Burst can briefly overload a fragile downstream |
| **Leaky bucket** | Strictly smooth output; protects fragile downstreams | Adds queuing latency; rejects legitimate bursts |

The decisive axes are **burst tolerance** and **memory per key**. If clients are bursty and the backend can absorb short spikes, token bucket wins. If a downstream needs perfectly even load, leaky bucket. If you need exactness at low volume (auth), sliding log. For general-purpose API quotas at scale, **sliding window counter or token bucket** are the safe defaults.

## 7. When to Use / When to Avoid

**Use rate limiting when:**
- You expose a public or multi-tenant API and must protect shared capacity.
- You enforce plan quotas or bill by usage.
- You need to blunt abuse: brute-force logins, scraping, credential stuffing, L7 DoS.
- A downstream (DB, third-party API, payment gateway) has its own hard limits you must respect.

**Avoid / reconsider when:**
- Internal, trusted, low-volume traffic where a limiter adds latency and ops burden for no threat.
- The real problem is capacity — rate limiting sheds load, it doesn't create it; don't use it to paper over an undersized system.
- You'd block legitimate bursty usage (batch jobs, webhooks) — prefer token bucket with headroom or per-endpoint tuning.
- Rate limiting is the wrong tool for *authorization* (use authz) or *DDoS at L3/L4* (use network/scrubbing defenses).

## 8. Scaling & Production Best Practices

- **Enforce at the edge first.** Reject volumetric abuse at the CDN/gateway so it never touches origin — the cheapest rejection is the earliest one.
- **Make the check atomic.** Use a Redis Lua script (or `INCR`+`EXPIRE`) — never read-then-write from the app, or concurrent nodes overshoot.
- **Fail open for user traffic.** If the counter store is unreachable, allow requests (log loudly) rather than 429-ing everyone — availability usually beats perfect enforcement. Fail closed only when the downstream is more fragile than the frontend.
- **Return standard headers:** `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`, and `Retry-After` on 429. Honest clients will back off; you convert rejection into cooperation. Stripe returns 429 with backoff guidance for exactly this.
- **Add jitter to `Retry-After`** so all throttled clients don't retry in the same instant (a synchronized retry storm).
- **Local budget + global reconcile** for very high QPS: hand each node a slice of the quota and reconcile periodically, avoiding a Redis call per request.
- **Weight by cost**, not just count — expensive endpoints spend more tokens.
- **Separate limits per dimension** (per-IP, per-key, per-endpoint) and take the strictest that trips.
- **Make limits configurable at runtime** (config service/feature flag) so you can tighten during an incident without a deploy.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| **Redis (counter store) down** | Limiter can't decide | Fail-open with local fallback bucket; replicate/shard Redis; alert |
| **Check-then-set race** across nodes | Limit overshoot (2×+) | Atomic Lua/`INCR`; never non-atomic read-modify-write |
| **Fixed-window boundary burst** | 2N in a second | Sliding window counter/log; token bucket |
| **Synchronized client retries** on `Retry-After` | Retry storm at reset instant | Jitter `Retry-After`; recommend exponential backoff |
| **Hot key** (one giant tenant) | One Redis shard saturated | Shard by key; local budget for whales; dedicated bucket |
| **Shared-IP false positives** (NAT/proxy) | Legit users blocked together | Key on user/API key when authenticated; higher IP limits |
| **Limiter added latency** | p99 regression on hot path | Local cache of buckets; pipeline Redis; keep script tiny |
| **Legit burst blocked** (webhooks/batch) | Dropped valid work | Token bucket with burst capacity; per-client overrides |

## 10. Monitoring & Metrics

- **429 rate** overall and per key/endpoint — a sudden spike means abuse *or* an over-tight limit hurting real users.
- **Throttle ratio** (rejected / total) per tenant — find who's constantly at the ceiling (upsell signal or abuser).
- **Top talkers** — highest-volume keys/IPs; feeds abuse detection and hot-key mitigation.
- **Limiter decision latency (p50/p99)** — the limiter must not become the bottleneck it protects against.
- **Counter-store health** — Redis CPU, memory, hit latency, and whether the limiter is in fail-open mode.
- **Backend load vs. throttle correlation** — confirm the limiter is actually protecting capacity.
- **`Retry-After` compliance** — are clients honoring backoff, or hammering through 429s?

## 11. Common Mistakes

1. ⚠️ **Per-node counters** instead of shared state — N servers multiply the effective limit by N.
2. ⚠️ **Non-atomic check-then-increment** — concurrent requests race and overshoot the limit.
3. ⚠️ **Fixed window for strict protection** — the boundary burst allows ~2× the intended rate.
4. ⚠️ **Fail-closed by default** — a Redis blip 429s all users and turns a limiter into an outage.
5. ⚠️ **No `Retry-After` / headers** — clients can't back off intelligently and hammer you.
6. ⚠️ **No jitter on retry guidance** — every throttled client retries at the same instant, re-spiking load.
7. ⚠️ **Keying only on IP** for authenticated APIs — punishes shared-NAT users and is trivially evaded.
8. ⚠️ **One global limit ignoring endpoint cost** — a cheap health check and an expensive report share a budget unfairly.

## 12. Interview Questions

**Q: Compare fixed window, sliding window log, sliding window counter, token bucket, and leaky bucket.**
A: Fixed window: one counter per window, cheapest, but 2× burst at boundaries. Sliding log: a timestamp per request, exact, O(N) memory. Sliding counter: two windows weighted by elapsed fraction — near-exact, ~2 ints, cheap. Token bucket: refilling tokens, allows bursts up to capacity at average rate R, O(1). Leaky bucket: fixed-rate drain queue, strictly smooth output, shapes rather than just limits.

**Q: Token bucket vs. leaky bucket — the essential difference?**
A: Token bucket **allows bursts** (up to capacity) while capping the average rate — good for real bursty clients. Leaky bucket enforces a **strictly smooth** output rate and queues/drops bursts — good for protecting a downstream that needs even load. Token bucket rejects; leaky bucket shapes (adds latency).

**Q: Why does the fixed-window algorithm allow twice the limit, and how do you fix it?**
A: A client sends N at the very end of window 1 and N at the very start of window 2 — 2N within a rolling second straddling the boundary. Fix with a sliding window (log or counter) or token bucket, which measure a rolling window instead of resetting on a hard clock boundary.

**Q: How do you rate limit correctly across many servers?**
A: Centralize the counter in a shared store (Redis) and make the read-compute-write atomic via a Lua script or `INCR`+`EXPIRE` — per-node counters multiply the limit by node count, and non-atomic updates race and overshoot. Add `EXPIRE` for cleanup and plan for the store's availability.

**Q: What do you return when a client is throttled?**
A: HTTP `429 Too Many Requests` with a `Retry-After` header (seconds or a date) and `RateLimit-Limit/Remaining/Reset` headers so clients know their budget and when to retry. This turns rejection into cooperation with well-behaved clients.

**Q (senior): Redis (your limiter store) goes down. Fail open or fail closed?**
A: For user-facing traffic, fail **open** — allowing requests preserves availability, and losing the limit briefly is better than 429-ing everyone. Mitigate the exposure with a local in-memory fallback bucket per node so you still cap the worst case. Fail **closed** only when the protected downstream is more fragile than the risk of blocking users (e.g., a payment provider with a hard cap you must not exceed).

**Q (senior): How do you rate limit a single enormous tenant without that tenant's traffic overwhelming your Redis?**
A: Give whales a **local token-bucket budget** synced periodically to a global quota, so most requests decide locally without a Redis round-trip; and shard the counter key (or give the tenant a dedicated shard) to avoid a hot key. Reconcile drift on an interval; accept small over/undershoot for the throughput win.

**Q (senior): You added a limiter and p99 latency regressed. Why, and how do you fix it?**
A: Every request now makes a synchronous Redis round-trip on the hot path. Fix with local caching of buckets, pipelining, a minimal Lua script (compute server-side, one RTT), co-locating Redis, and for extreme QPS a local-budget model so most requests never touch Redis. The limiter must not become the bottleneck it was meant to prevent.

**Q (senior): Clients all retry the instant `Retry-After` expires and re-spike your backend. What went wrong?**
A: Synchronized retries — everyone was told to come back at the same time, creating a thundering herd at the reset boundary. Jitter the `Retry-After` value per client and instruct clients to use exponential backoff **with jitter**. This is the same failure class as cache-avalanche and retry storms — see **Resilience Patterns**.

**Q (senior): How would you enforce different limits per endpoint by cost rather than a flat request count?**
A: Assign each endpoint a token cost (search = 10, health = 1) and deduct that many tokens from the client's bucket per call — a weighted token bucket. This bills clients for the actual load they impose, so a burst of cheap calls and a few expensive calls are fairly constrained under one budget. Keep the weights in runtime config.

**Q (senior): Where should rate limiting live — edge, gateway, or service — and why not just one place?**
A: Layer it. The edge/CDN sheds volumetric and per-IP abuse before it costs you anything; the gateway enforces per-API-key plan quotas with auth context; the service enforces per-endpoint limits protecting a specific fragile downstream. Each layer sees information the others can't, and defense-in-depth means one misconfiguration doesn't remove all protection.

## 13. Alternatives & Related

- **Resilience Patterns (Circuit Breaker, Backoff)** — load shedding and backpressure are rate limiting's siblings; clients should back off on 429.
- **Caching** — often shares the same Redis; a cache reduces the load a limiter must cap.
- **Load Balancing** — where edge/gateway enforcement physically lives.
- **API Gateway / Envoy** — common enforcement point with built-in limiters.
- **Consistent Hashing** — how you shard the counter store to avoid hot keys.
- **Observability** — 429 rates and throttle ratios are core reliability SLIs.

## 14. Cheat Sheet

> [!TIP]
> **Rate limiting in one screen.**
> - **Algorithms:** fixed window (cheap, 2× burst) · sliding log (exact, O(N)) · **sliding counter** (near-exact, cheap) · **token bucket** (allows bursts, O(1)) · leaky bucket (smooth/shaping, adds latency).
> - **Default:** token bucket or sliding-window counter for API quotas.
> - **Distributed:** shared Redis + **atomic Lua** (`INCR`+`EXPIRE`). Never per-node counters.
> - **Availability:** fail **open** for user traffic (with local fallback). Fail closed only to protect a fragile downstream.
> - **Response:** `429` + `Retry-After` + `RateLimit-*` headers. **Jitter** the retry guidance.
> - **Key on:** API key/user (authed) · IP (pre-auth) · composite key+endpoint, weighted by cost.
> - **Layer it:** edge (per-IP) → gateway (per-key) → service (per-endpoint).

**References:** Stripe Engineering — "Scaling your API with rate limiters" · Redis rate-limiting patterns (Redis docs) · Cloudflare rate-limiting docs · IETF `RateLimit` header fields draft

---
*System Design Handbook — topic 26.*
