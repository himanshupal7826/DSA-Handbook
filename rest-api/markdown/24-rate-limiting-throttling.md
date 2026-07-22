# 24 · Rate Limiting, Quotas & Throttling

> **In one line:** Rate limiting is admission control for your API — a token bucket or sliding window decides who gets served now, a quota decides who gets served this month, and a correct `429` with `Retry-After` is the difference between a client that backs off and a client that melts your service down.

---

## 1. Overview

Every API has a finite capacity, and demand is not politely distributed. One customer's runaway retry loop, one scraper, one credential-stuffing bot, or one enthusiastic integration deployed to 10,000 devices can consume the capacity of all the others. Rate limiting is the mechanism that converts "first come, first served until we fall over" into an explicit, fair, predictable allocation. It is simultaneously a *reliability* control (protect the service), a *security* control (slow enumeration and brute force), a *fairness* control (one tenant cannot starve another), and a *commercial* control (tiers, plans, overage).

The problem it solves is most visible in its absence. Without limits, a single client's `while True: requests.get(...)` saturates your connection pool; the queue grows; latency rises; healthy clients time out and *retry*, adding load; the system enters congestion collapse. This is the retry storm, and it is why every mature API — Stripe, GitHub, Twilio, Slack, Shopify — publishes explicit limits and returns structured headers telling clients exactly where they stand.

The lineage is worth knowing. Token bucket and leaky bucket came from 1980s telecom traffic shaping (ATM networks) and were formalised for packet networks before anyone applied them to HTTP. The `429 Too Many Requests` status code was added by **RFC 6585 (2012)** — it is not in the original HTTP spec, which is why some ancient clients mishandle it. `Retry-After` is defined in **RFC 9110 §10.2.3** and accepts either delta-seconds or an HTTP-date. The header story was messy for a decade (`X-RateLimit-*` vs `X-Rate-Limit-*` vs vendor-specific), and the IETF's **`RateLimit` header fields** draft finally standardises `RateLimit` and `RateLimit-Policy` — GitHub, Stripe and others still ship the legacy `X-RateLimit-*` triple, so emit both during transition.

A concrete example: **GitHub's REST API** allows 5,000 requests/hour for authenticated users, 60/hour for unauthenticated IPs, and separately meters "secondary rate limits" for expensive operations like content creation. Every response carries `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset` and `x-ratelimit-used`, so a well-behaved client can pace itself and never see a `429` at all. **Stripe** publishes ~100 read requests/second in live mode and returns `429` with a documented exponential-backoff recommendation. **Twilio** meters concurrency rather than just rate for expensive resources. The pattern across all of them: *make the limit observable so clients can self-regulate*, then enforce it when they do not.

The mental model: **rate limiting is a queueing-theory problem with a business-rules skin.** The algorithm choice determines burst behaviour and memory cost; the key choice (IP? user? tenant? API key? endpoint?) determines fairness; the response semantics determine whether clients recover gracefully or amplify the incident.

---

## 2. Core Concepts

- **Rate limit** — a cap on requests per unit time for a given key (e.g. 1,000 req/min per API key). Enforced at short timescales.
- **Quota** — a cap over a long window tied to billing or policy (e.g. 1 M requests/month, 50,000 SMS/month). Enforced at business timescales.
- **Throttling** — deliberately slowing rather than rejecting: queueing, delaying, or degrading. Preserves work at the cost of latency.
- **Token bucket** — a bucket of capacity `B` refilled at rate `r` tokens/sec; each request consumes a token. Allows bursts up to `B`, sustains `r`.
- **Leaky bucket** — a queue drained at a constant rate. Smooths output completely; no bursts pass through.
- **Fixed window** — count requests per calendar window (e.g. per minute). Trivial and cheap, but permits a 2× burst at the boundary.
- **Sliding window log** — store a timestamp per request and count those within the window. Exact, but `O(n)` memory per key.
- **Sliding window counter** — weighted interpolation between the previous and current fixed windows. ~99% accurate at `O(1)` memory; the usual production choice.
- **`429 Too Many Requests`** — the correct status for exceeding a limit (RFC 6585). `503` is for overload/unavailability; `403` is wrong and misleads clients into not retrying.
- **`Retry-After`** — how long to wait, as delta-seconds or an HTTP-date (RFC 9110 §10.2.3). Also valid on `503` and `301`.
- **Backpressure** — signalling upstream to slow down (429s, load shedding, concurrency limits) rather than silently queueing until collapse; **jitter** is the randomisation added to client backoff so retries do not resynchronise into a thundering herd.

---

## 3. Theory & Principles

**Token bucket, precisely.** State is `(tokens, last_refill_ts)`. On each request at time `t`:

```
elapsed = t - last_refill
tokens  = min(B, tokens + elapsed * r)
if tokens >= 1: tokens -= 1; allow
else:           deny; retry_after = ceil((1 - tokens) / r)
```

Two parameters with clear meanings: `r` is the **sustained** rate and `B` is the **burst** capacity. A client idle for `B/r` seconds accumulates a full bucket and can fire `B` requests instantly. Choosing `B = r` allows a one-second burst; `B = 10r` allows ten seconds of accumulated credit, which is friendlier to bursty batch clients but permits a bigger instantaneous spike. The refill is computed lazily on access, so memory is two numbers per key regardless of traffic — this is why token bucket is the default choice.

**Fixed window's boundary flaw is not theoretical.** With a limit of 100/min, a client can send 100 requests at 12:00:59 and 100 more at 12:01:00 — **200 requests in one second**, twice the intended rate, indefinitely at every boundary. If your capacity planning assumed 100/min, you are provisioned for half the real peak.

**Sliding window counter fixes this cheaply.** Let `c_prev` and `c_cur` be counts in the previous and current fixed windows and `f` the fraction of the current window elapsed. Estimate:

```
count ≈ c_prev * (1 - f) + c_cur
```

At 12:01:15 with a 60 s window (`f = 0.25`), if `c_prev = 100` and `c_cur = 20`, the estimate is `100*0.75 + 20 = 95` — the boundary burst is caught. The approximation assumes uniform distribution within the previous window; Cloudflare reported error rates well under 1% at production scale, for two counters per key instead of a full log.

**Sliding window log is exact and expensive.** Storing a timestamp per request costs `O(limit)` memory per key. At 1,000 req/min across 100,000 keys that is 100 M timestamps — usually unjustifiable, though it is the right choice for small, high-value limits (5 password resets/hour).

**Distributed counting and the consistency trade-off.** With `N` gateway nodes, a shared Redis counter is exact but adds a round trip; per-node local counters with limit `L/N` need no coordination but over-restrict when traffic is unbalanced and under-restrict when it is skewed. The middle path is *approximate local counting with periodic reconciliation*: nodes count locally, push deltas to a shared store every 100–500 ms, and pull the global view. You accept bounded overshoot (bounded by `N × sync_interval × per_node_rate`) in exchange for zero hot-path latency. This is a direct CAP-style trade: exact limits require coordination; available limits require accepting slop.

**Why the algorithm must be atomic.** `GET count; if count < limit: SET count+1` is a race — under concurrency, many requests read the same value and all pass. In Redis, use a Lua script (atomic on the server) or `INCR` with `EXPIRE` set only on first increment. In-process, use a mutex or an atomic compare-and-swap.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="360" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">Four algorithms: burst behaviour, accuracy, memory</text>
  <rect x="18" y="42" width="360" height="140" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="34" y="64" font-size="13" font-weight="700" fill="#1e293b">TOKEN BUCKET</text>
  <rect x="34" y="76" width="70" height="60" rx="6" fill="#ffffff" stroke="#4f46e5" stroke-width="2"/>
  <rect x="36" y="106" width="66" height="28" fill="#c7d2fe"/>
  <text x="40" y="150" font-size="10" fill="#1e293b">capacity B</text>
  <text x="120" y="96" font-size="11" fill="#1e293b">refill r tokens/sec, lazily computed</text>
  <text x="120" y="114" font-size="11" fill="#1e293b">allows a burst of B, sustains r</text>
  <text x="120" y="132" font-size="11" fill="#1e293b">state: 2 numbers per key</text>
  <text x="120" y="150" font-size="11" font-weight="700" fill="#4f46e5">default choice for APIs</text>
  <text x="34" y="172" font-size="11" fill="#1e293b">tokens = min(B, tokens + elapsed * r); deny when tokens &lt; 1</text>
  <rect x="396" y="42" width="366" height="140" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="412" y="64" font-size="13" font-weight="700" fill="#1e293b">FIXED WINDOW: the boundary flaw</text>
  <line x1="412" y1="112" x2="746" y2="112" stroke="#1e293b" stroke-width="1.5"/>
  <line x1="579" y1="98" x2="579" y2="126" stroke="#d97706" stroke-width="3"/>
  <text x="540" y="140" font-size="10" fill="#1e293b">window boundary</text>
  <rect x="540" y="86" width="38" height="22" fill="#fcd34d" stroke="#d97706"/>
  <rect x="580" y="86" width="38" height="22" fill="#fcd34d" stroke="#d97706"/>
  <text x="412" y="82" font-size="11" fill="#1e293b">100 req at 12:00:59 + 100 req at 12:01:00</text>
  <text x="412" y="160" font-size="11" font-weight="700" fill="#d97706">= 200 req in one second, forever, at every boundary</text>
  <text x="412" y="176" font-size="11" fill="#1e293b">cheap (1 counter) but plan capacity for 2x the limit</text>
  <rect x="18" y="196" width="360" height="152" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="34" y="218" font-size="13" font-weight="700" fill="#1e293b">SLIDING WINDOW COUNTER</text>
  <text x="34" y="240" font-size="11" fill="#1e293b">count = c_prev * (1 - f) + c_cur</text>
  <text x="34" y="260" font-size="11" fill="#1e293b">f = fraction of current window elapsed</text>
  <text x="34" y="284" font-size="11" fill="#1e293b">example: c_prev=100, c_cur=20, f=0.25</text>
  <text x="34" y="302" font-size="11" fill="#1e293b">estimate = 75 + 20 = 95, boundary burst caught</text>
  <text x="34" y="326" font-size="11" font-weight="700" fill="#16a34a">O(1) memory, under 1% error at scale</text>
  <rect x="396" y="196" width="366" height="152" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="412" y="218" font-size="13" font-weight="700" fill="#1e293b">SLIDING WINDOW LOG</text>
  <text x="412" y="240" font-size="11" fill="#1e293b">store a timestamp per request; count those</text>
  <text x="412" y="258" font-size="11" fill="#1e293b">inside [now - W, now]</text>
  <text x="412" y="282" font-size="11" fill="#1e293b">exact, no boundary artefact at all</text>
  <text x="412" y="300" font-size="11" fill="#1e293b">O(limit) memory per key &#8212; expensive</text>
  <text x="412" y="326" font-size="11" font-weight="700" fill="#0ea5e9">use for small high-value limits (5 resets/hour)</text>
</svg>
```

---

## 4. Architecture & Workflow

Where limiting happens matters as much as how. A layered design:

1. **Network edge.** The CDN or DDoS layer absorbs volumetric floods per IP before they reach your infrastructure. Coarse, stateless, cheap — and blind to identity, so it cannot express "this customer's plan allows 10k/min".
2. **Gateway.** The primary enforcement point. It authenticates first (so it can key by principal, not IP), then evaluates limits, then forwards or rejects. Rejecting here means the request never touches your services.
3. **Key selection.** The single most important design decision. Order of preference: `api_key`/`client_id` → `tenant_id` → `user_id` → IP. IP is the last resort — NAT and mobile carriers put thousands of users behind one address, and IPv6 makes rotation free. Real systems apply *multiple* limits simultaneously: per-key, per-tenant, per-endpoint-class, and a global circuit breaker.
4. **Cost weighting.** Not all requests are equal. A `GET /v1/health` and a `POST /v1/reports/generate` should not consume the same token. Assign each endpoint a cost and deduct that many tokens — GitHub's GraphQL API does exactly this with a published point formula.
5. **Atomic decision.** A Redis Lua script performs refill, check and decrement in one round trip. Return `(allowed, remaining, reset_after, retry_after)` in a single call.
6. **Response.** On allow: forward, and attach `RateLimit` headers so the client can pace itself. On deny: `429` with `Retry-After`, a `problem+json` body, and the same headers.
7. **Client backoff.** A correct client reads `Retry-After`, sleeps that long, and applies **exponential backoff with full jitter** for repeated failures: `sleep = random(0, min(cap, base * 2^attempt))`. Without jitter, every throttled client retries at the same instant and recreates the spike.
8. **Quota accounting.** Separately from the short-window limiter, a durable counter tracks monthly usage per tenant, resets on the billing boundary, and drives soft warnings (80%, 95%) before hard rejection.
9. **Load shedding.** When the *service* is in trouble rather than one client, shed by priority: drop background and analytics traffic first, keep interactive and payment paths. This is `503 Retry-After`, not `429` — a different signal for a different cause.
10. **Observability.** Emit limit decisions with key, policy, remaining and outcome so you can distinguish "one abusive client" from "our capacity is genuinely too small".

```svg
<svg viewBox="0 0 780 380" width="100%" height="380" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="380" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">Enforcement path and the client backoff loop</text>
  <rect x="18" y="42" width="128" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="46" y="66" font-size="12" font-weight="700" fill="#1e293b">Client</text>
  <text x="28" y="84" font-size="10" fill="#1e293b">reads RateLimit hdrs</text>
  <rect x="176" y="42" width="122" height="52" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="200" y="66" font-size="12" font-weight="700" fill="#1e293b">CDN edge</text>
  <text x="186" y="84" font-size="10" fill="#1e293b">per-IP volumetric</text>
  <rect x="328" y="42" width="140" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="352" y="66" font-size="12" font-weight="700" fill="#1e293b">Gateway</text>
  <text x="338" y="84" font-size="10" fill="#1e293b">authn then limit by key</text>
  <rect x="498" y="42" width="128" height="52" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="524" y="66" font-size="12" font-weight="700" fill="#1e293b">Redis</text>
  <text x="508" y="84" font-size="10" fill="#1e293b">Lua: atomic decide</text>
  <rect x="656" y="42" width="106" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="680" y="66" font-size="12" font-weight="700" fill="#1e293b">Service</text>
  <text x="666" y="84" font-size="10" fill="#1e293b">only if allowed</text>
  <line x1="146" y1="68" x2="172" y2="68" stroke="#0ea5e9" stroke-width="2"/>
  <polygon points="176,68 168,64 168,72" fill="#0ea5e9"/>
  <line x1="298" y1="68" x2="324" y2="68" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="328,68 320,64 320,72" fill="#4f46e5"/>
  <line x1="468" y1="68" x2="494" y2="68" stroke="#16a34a" stroke-width="2"/>
  <polygon points="498,68 490,64 490,72" fill="#16a34a"/>
  <line x1="626" y1="68" x2="652" y2="68" stroke="#d97706" stroke-width="2"/>
  <polygon points="656,68 648,64 648,72" fill="#d97706"/>
  <rect x="18" y="110" width="744" height="96" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="34" y="132" font-size="13" font-weight="700" fill="#1e293b">Key selection: fairness lives here</text>
  <text x="34" y="154" font-size="11" fill="#1e293b">api_key  &#8594;  tenant_id  &#8594;  user_id  &#8594;  ip (last resort: NAT and mobile share addresses)</text>
  <text x="34" y="174" font-size="11" fill="#1e293b">apply several at once: per-key 1000/min, per-tenant 10000/min, per-endpoint-class, global breaker</text>
  <text x="34" y="194" font-size="11" font-weight="700" fill="#4f46e5">weight by cost: report generation deducts 50 tokens, a health check deducts 1</text>
  <rect x="18" y="220" width="360" height="150" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="34" y="242" font-size="13" font-weight="700" fill="#1e293b">The 429 response</text>
  <text x="34" y="264" font-size="11" fill="#1e293b">HTTP/1.1 429 Too Many Requests</text>
  <text x="34" y="282" font-size="11" fill="#1e293b">Retry-After: 12</text>
  <text x="34" y="300" font-size="11" fill="#1e293b">RateLimit: limit=1000, remaining=0, reset=12</text>
  <text x="34" y="318" font-size="11" fill="#1e293b">RateLimit-Policy: 1000;w=60</text>
  <text x="34" y="336" font-size="11" fill="#1e293b">Content-Type: application/problem+json</text>
  <text x="34" y="358" font-size="10" font-weight="700" fill="#d97706">429 = you are too fast. 503 = we are unwell.</text>
  <rect x="396" y="220" width="366" height="150" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="412" y="242" font-size="13" font-weight="700" fill="#1e293b">Client loop: full jitter is mandatory</text>
  <text x="412" y="264" font-size="11" fill="#1e293b">1. honour Retry-After if present</text>
  <text x="412" y="282" font-size="11" fill="#1e293b">2. else sleep = random(0, min(cap, base * 2^attempt))</text>
  <text x="412" y="300" font-size="11" fill="#1e293b">3. cap attempts, then surface the error</text>
  <text x="412" y="318" font-size="11" fill="#1e293b">4. retry writes only with an Idempotency-Key</text>
  <text x="412" y="340" font-size="11" font-weight="700" fill="#16a34a">no jitter &#8594; every client retries at the same instant: the thundering herd</text>
</svg>
```

---

## 5. Implementation

**Atomic token bucket in Redis (Lua — one round trip, no race):**

```lua
-- KEYS[1] = bucket key   ARGV = capacity, refill_rate, now_ms, cost
local cap, rate, now, cost = tonumber(ARGV[1]), tonumber(ARGV[2]), tonumber(ARGV[3]), tonumber(ARGV[4])
local b = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or cap
local ts     = tonumber(b[2]) or now
tokens = math.min(cap, tokens + (now - ts) / 1000 * rate)
local allowed = tokens >= cost
if allowed then tokens = tokens - cost end
redis.call('HMSET', KEYS[1], 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) + 1000)
local retry = 0
if not allowed then retry = math.ceil((cost - tokens) / rate) end
return { allowed and 1 or 0, math.floor(tokens), retry }
```

**Wiring it into FastAPI with correct headers:**

```python
POLICIES = {                      # (capacity, refill/sec, window_for_policy_header)
    "default":  (1000, 1000/60, 60),
    "search":   (60,   60/60,   60),
    "reports":  (10,   10/3600, 3600),
}
COST = {"/v1/reports/generate": 50, "/v1/search": 5}

@app.middleware("http")
async def rate_limit(request: Request, call_next):
    principal = request.state.api_key or f"ip:{request.client.host}"
    policy = POLICIES[classify(request.url.path)]
    cap, rate, window = policy
    allowed, remaining, retry = await redis.evalsha(
        SHA, 1, f"rl:{principal}:{classify(request.url.path)}",
        cap, rate, int(time.time() * 1000), COST.get(request.url.path, 1))
    headers = {
        "RateLimit": f"limit={cap}, remaining={remaining}, reset={retry or 0}",
        "RateLimit-Policy": f'{cap};w={window}',
        "X-RateLimit-Limit": str(cap),                 # legacy, for existing clients
        "X-RateLimit-Remaining": str(remaining),
        "X-RateLimit-Reset": str(int(time.time()) + (retry or 0)),
    }
    if not allowed:
        return JSONResponse(
            status_code=429, headers={**headers, "Retry-After": str(retry)},
            media_type="application/problem+json",
            content={"type": "https://api.acme.io/problems/rate-limit-exceeded",
                     "title": "Too Many Requests", "status": 429,
                     "detail": f"Limit of {cap} requests per {window}s exceeded",
                     "retry_after_seconds": retry})
    response = await call_next(request)
    for k, v in headers.items():
        response.headers[k] = v
    return response
```

**The wire exchange:**

```http
GET /v1/search?q=invoice HTTP/1.1
Host: api.acme.io
Authorization: Bearer eyJhbGciOiJFUzI1NiJ9...
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
RateLimit: limit=60, remaining=41, reset=37
RateLimit-Policy: 60;w=60
Access-Control-Expose-Headers: RateLimit, RateLimit-Policy, Retry-After
```

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
Retry-After: 12
RateLimit: limit=60, remaining=0, reset=12
RateLimit-Policy: 60;w=60

{
  "type": "https://api.acme.io/problems/rate-limit-exceeded",
  "title": "Too Many Requests",
  "status": 429,
  "detail": "Limit of 60 requests per 60s exceeded for key ak_live_7f2",
  "retry_after_seconds": 12,
  "docs": "https://docs.acme.io/rate-limits"
}
```

> **Note:** If browsers consume your API cross-origin, you *must* list `RateLimit`, `RateLimit-Policy` and `Retry-After` in `Access-Control-Expose-Headers` — otherwise client JavaScript cannot read them and self-pacing is impossible.

**A correct client: honour `Retry-After`, then exponential backoff with full jitter:**

```javascript
async function call(url, init = {}, { maxAttempts = 5, base = 250, cap = 20_000 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status !== 503) return res;
    if (attempt >= maxAttempts - 1) throw new Error(`gave up after ${res.status}`);
    const ra = res.headers.get('retry-after');
    const serverWait = ra ? (/^\d+$/.test(ra) ? +ra * 1000 : Date.parse(ra) - Date.now()) : null;
    // full jitter: random(0, min(cap, base * 2^attempt)) -- prevents synchronised retries
    const backoff = Math.random() * Math.min(cap, base * 2 ** attempt);
    await new Promise(r => setTimeout(r, Math.max(serverWait ?? 0, backoff)));
  }
}
```

**Monthly quota, separate from the rate limit:**

```python
async def consume_quota(tenant: str, units: int = 1) -> None:
    key = f"quota:{tenant}:{date.today():%Y-%m}"
    used = await redis.incrby(key, units)
    if used == units:
        await redis.expireat(key, int(first_of_next_month().timestamp()) + 86400)
    limit = await plans.quota_for(tenant)
    if used > limit:
        await redis.decrby(key, units)          # do not bill for the rejected call
        raise HTTPException(429, "monthly quota exhausted", headers={
            "Retry-After": str(seconds_until_next_month()),
            "RateLimit-Policy": f"{limit};w={seconds_in_month()}"})
    if used / limit >= 0.8:
        await notify_once(tenant, "quota_80")   # warn before you reject
```

**Optimization note.** The limiter is on every request, so its cost is your floor. Three techniques: (1) **one round trip, always** — a Lua script that refills, checks and decrements atomically beats three Redis calls and eliminates the race; (2) **local pre-filtering** — keep a per-process token bucket sized at `L/N × safety` so obviously-over-limit clients are rejected without touching Redis, reconciling with the shared store every few hundred milliseconds and accepting bounded overshoot; (3) **shard hot keys** — one enormous tenant on a single Redis key is a hotspot, so split into `k` sub-buckets of `L/k` chosen by request hash. Set key TTLs to slightly more than the window so idle keys evict themselves; without TTLs, an IP-keyed limiter accumulates unbounded keys and eventually OOMs Redis. Finally, fail *open* on limiter infrastructure failure for read paths (availability) and *closed* for expensive or paid operations (cost control) — and make that choice explicit per endpoint rather than accidental.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Token bucket | Burst-friendly, `O(1)` state, two intuitive parameters | Burst allowance can still spike a fragile downstream; needs careful `B` sizing |
| Fixed window | Simplest possible implementation, one counter | 2× burst at boundaries; must provision for double the nominal limit |
| Sliding window counter | Near-exact with `O(1)` memory; the production sweet spot | Approximate — assumes uniform distribution in the previous window |
| Sliding window log | Exactly correct, no boundary artefacts | `O(limit)` memory per key; only viable for small, high-value limits |
| Centralised (Redis) | Globally accurate across all nodes; one place to tune | Network hop on every request; a new hard dependency and failure domain |
| Local per-node | Zero added latency, no shared dependency | Over- or under-restricts as traffic distribution shifts across nodes |
| Rejecting (`429`) | Sheds load instantly; clear signal to the client | Real users see errors; bad clients may hammer harder without jitter |
| Throttling / queueing | Preserves work, smooths spikes | Latency grows, queues consume memory, and unbounded queues become the outage |
| Per-IP keying | Works for unauthenticated traffic | NAT and mobile carriers share addresses; IPv6 rotation is free for attackers |
| Per-key/tenant keying | Fair, aligns with plans and billing | Requires authentication first, so it cannot protect the auth endpoint itself |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Returning `403`, `500` or `503` when a client exceeds a limit.** → ✅ `429 Too Many Requests` (RFC 6585). `403` tells clients not to retry; `503` means *you* are unwell, which is a different signal and a different runbook.
2. ⚠️ **`429` with no `Retry-After`.** → ✅ Always include it (delta-seconds is simplest). Without it, clients guess — and their guess is usually "immediately".
3. ⚠️ **Rate limiting only by IP.** → ✅ Key by API key, then tenant, then user; IP is a fallback for unauthenticated traffic. A corporate NAT is thousands of users on one address, and IPv6 gives attackers unlimited addresses.
4. ⚠️ **Fixed windows without accounting for the boundary burst.** → ✅ Use a sliding window counter, or provision for 2× and document the real peak.
5. ⚠️ **Non-atomic read-then-write counters.** → ✅ Redis Lua or `INCR` with conditional `EXPIRE`. A check-then-set race lets a concurrent burst sail straight through.
6. ⚠️ **Retrying without jitter.** → ✅ Full jitter: `random(0, min(cap, base * 2^attempt))`. Fixed or purely exponential backoff resynchronises every throttled client into one spike.
7. ⚠️ **Retrying non-idempotent writes after a `429` or timeout.** → ✅ Pair retries with an `Idempotency-Key` so a duplicated `POST` cannot double-charge a customer.
8. ⚠️ **Hiding the limit from clients.** → ✅ Emit `RateLimit`/`RateLimit-Policy` (plus legacy `X-RateLimit-*`) on *every* response, and expose them via CORS. Clients that can see their budget pace themselves and never hit `429`.
9. ⚠️ **One global limit for every endpoint.** → ✅ Weight by cost — a report generation is not a health check. Assign per-endpoint costs or separate policy classes.
10. ⚠️ **No limit on the authentication endpoints.** → ✅ Login, password reset, OTP verification and token issuance need the *tightest* limits, keyed by both account and IP, or you have a credential-stuffing platform.
11. ⚠️ **Unbounded queueing instead of shedding, or limiter keys with no TTL.** → ✅ Bound every queue and shed by priority when it fills — infinite queues convert a load spike into a latency collapse where every request times out after being processed. Likewise expire limiter keys just after their window, or an IP-keyed limiter accumulates keys forever and the limiter itself becomes the outage.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The first question is always "is this one client or is this us?" Log every limit decision with the key, policy name, cost, remaining and outcome, and make the `429` body carry a `request_id` plus a docs link so support can resolve a complaint in one query. Provide an internal endpoint that dumps the current bucket state for a given key — customers reporting "we get 429s but we only send 10 req/s" are usually hitting a *different* policy (per-endpoint, per-tenant, or a secondary limit) than the one they are watching. Watch for clock skew across gateway nodes: token-bucket refill is time-based, and a node whose clock runs fast grants extra tokens.

**Monitoring.** The metrics that matter: `ratelimit_decisions_total{policy,outcome}`, the 429 rate as a fraction of total requests (per client *and* globally), the distribution of `remaining` at response time (if most clients sit near zero, your limit is too tight), the number of distinct keys being tracked (memory forecasting), limiter latency p99 (Redis round trips leaking into your budget), and per-tenant quota consumption versus plan. Alert on: a single key exceeding N% of global 429s (abuse or a broken integration); the global 429 rate crossing a threshold (capacity problem, not a client problem); limiter backend errors (you are now failing open or closed — know which); and quota at 80%/95% per tenant so customers hear from you before they get rejected.

**Security.** Rate limiting is a security control in its own right: it is what makes credential stuffing, token brute-forcing, OTP guessing and BOLA enumeration expensive. Apply the tightest limits to `/token`, `/login`, `/password-reset` and `/verify-otp`, keyed on both the target account and the source IP so neither dimension alone can be evaded. Never let the limiter itself leak information — a `429` on a login attempt must not reveal whether the account exists. Watch for distributed low-and-slow attacks that stay under every per-key limit; those need aggregate behavioural detection (distinct object IDs touched, failure ratios) rather than counters. And remember an attacker can weaponise your limiter: if limits are keyed on a value the attacker controls for *another* user (a spoofable `X-Forwarded-For`, or a username), they can lock legitimate users out — so derive keys from authenticated identity and only trust `X-Forwarded-For` hops you control.

**Performance & scaling.** Keep the hot path to one Redis round trip via Lua, and co-locate the limiter with the gateway to keep that hop sub-millisecond. Shard hot keys for very large tenants. For extreme scale, move to approximate local counting with periodic reconciliation and accept bounded overshoot — Google's SRE book and Cloudflare's engineering posts both land here for the same reason: exact global counting cannot be free. Decide fail-open versus fail-closed per endpoint class and test it: fail open on cheap reads so a Redis blip does not take the product down, fail closed on paid or destructive operations so a blip does not cost money. Finally, treat limits as configuration, not code — you will need to raise a customer's limit at 2 a.m. without a deploy.

---

## 9. Interview Questions

**Q: What status code do you return when a client exceeds a rate limit, and what must accompany it?**
A: `429 Too Many Requests` (RFC 6585), with `Retry-After` giving delta-seconds or an HTTP-date, plus `RateLimit`/`RateLimit-Policy` headers and a `problem+json` body. `403` is wrong because it signals "do not retry", and `503` means the *server* is unhealthy rather than the client being too fast.

**Q: Compare token bucket and leaky bucket.**
A: Token bucket accumulates credit while idle, so it permits a burst up to the bucket capacity and then sustains the refill rate — friendly to bursty API clients. Leaky bucket drains a queue at a constant rate, producing perfectly smooth output with no bursts, which suits protecting a fragile downstream but adds queueing latency.

**Q: What is wrong with fixed-window counters?**
A: The boundary problem: with 100/min, a client can send 100 requests at 12:00:59 and 100 more at 12:01:00, achieving 200 in one second and doubling the intended rate at every boundary. A sliding window counter fixes it with two counters and a weighted estimate.

**Q: How does a sliding window counter work?**
A: It keeps counts for the previous and current fixed windows and estimates `count ≈ c_prev × (1 − f) + c_cur`, where `f` is the fraction of the current window elapsed. That is `O(1)` memory with well under 1% error in practice, versus `O(limit)` memory for an exact log.

**Q: Should you rate limit by IP?**
A: Only as a fallback for unauthenticated traffic. NAT and mobile carriers put thousands of users behind one address so you punish innocents, while IPv6 gives an attacker effectively unlimited addresses. Prefer API key, then tenant, then user, and apply several keys simultaneously.

**Q: Why does retry backoff need jitter?**
A: Because throttled clients otherwise retry at identical intervals and resynchronise into a thundering herd, recreating the spike that caused the throttling. Full jitter — `random(0, min(cap, base × 2^attempt))` — spreads retries across the interval and lets the system drain.

**Q: How do you make retries safe for writes?**
A: Pair them with an `Idempotency-Key`: the server stores the key with the response for a retention window and returns the original result on replay. Without it, a `429` or timeout followed by a retry can double-charge a customer, because the client cannot tell whether the first request took effect.

**Q: (Senior) Design rate limiting for a multi-region API with 50 gateway nodes and a 10,000 req/min per-tenant limit.**
A: I would use approximate local counting with periodic reconciliation: each node runs a local token bucket sized at roughly `limit/N` plus a safety margin, pushes deltas to a regional store every 100–500 ms, and pulls the aggregate view, giving zero added latency on the hot path with overshoot bounded by `N × sync_interval × per_node_rate`. Exact global counting would need a coordinated round trip per request, which is unacceptable cross-region. For customers whose contracts require hard limits I would fall back to a single authoritative region for their keys and accept the latency, and I would document the tolerance explicitly rather than pretending the limit is exact.

**Q: (Senior) Your limiter's Redis cluster fails. Fail open or fail closed?**
A: Per endpoint class, decided in advance. Cheap idempotent reads fail open so a limiter blip does not take the product down — the worst case is temporary overload you can shed elsewhere. Expensive, paid or destructive operations fail closed, because the worst case there is unbounded cost or data damage. In both cases the process falls back to a conservative local bucket so there is still *some* protection, and the mode change fires an alert since you are now operating outside your normal safety envelope.

**Q: (Senior) A large customer complains of 429s while insisting they stay under the documented rate. How do you investigate?**
A: First determine which policy actually rejected them — production APIs run several concurrent limits (per key, per tenant, per endpoint class, per-endpoint cost weighting, plus secondary limits on expensive operations), and customers typically monitor only the headline one. Then check their concurrency rather than their rate: 60 requests fired simultaneously each second is very different from one every 16 ms against a token bucket, and burst capacity may be the real constraint. Finally check for key fragmentation or aggregation surprises — retries counting against the limit, a shared key across their fleet, or clock skew on one gateway node — and give them the bucket-state dump so the conversation is about data rather than assertions.

**Q: When do you throttle instead of reject?**
A: Throttle when the work is valuable and latency-tolerant — batch jobs, webhooks, background sync — by queueing with a bounded depth and draining at a safe rate. Reject when the caller is interactive and waiting, or when the queue would grow unbounded, because a queue that never drains converts a load spike into a total latency collapse.

**Q: What is the difference between a rate limit and a quota?**
A: A rate limit protects capacity over short windows (seconds to minutes) and resets continuously; a quota expresses a commercial or policy ceiling over a long window (usually a billing month) and resets on the boundary. They are enforced by different mechanisms, and exceeding a quota should warn the customer at 80% and 95% before it ever rejects.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Pick **token bucket** by default: `tokens = min(B, tokens + elapsed × r)`, where `r` is the sustained rate and `B` the burst. Avoid plain fixed windows — they permit a 2× burst at every boundary; use a **sliding window counter** (`c_prev × (1 − f) + c_cur`) for near-exact accounting at `O(1)` memory, and reserve an exact **sliding window log** for small high-value limits. Make the decision **atomic** (Redis Lua, one round trip) or concurrency races defeat you. Key by API key → tenant → user → IP, apply several policies at once, and weight requests by cost. Reject with **`429` + `Retry-After`** plus `RateLimit`/`RateLimit-Policy` headers on *every* response (and expose them via CORS) so clients self-pace. Clients must use **full jitter** backoff and an `Idempotency-Key` for retried writes. `429` means the client is too fast; `503` means the server is unwell. Give every limiter key a TTL, decide fail-open versus fail-closed per endpoint class, and put the tightest limits on login, token and OTP endpoints.

| Item | Value |
|---|---|
| Limit exceeded | `429 Too Many Requests` + `Retry-After: <seconds>` |
| Server overloaded | `503 Service Unavailable` + `Retry-After` |
| Standard headers | `RateLimit: limit=1000, remaining=41, reset=37` · `RateLimit-Policy: 1000;w=60` |
| Legacy headers | `X-RateLimit-Limit` / `-Remaining` / `-Reset` (still ship these) |
| CORS | List `RateLimit`, `RateLimit-Policy`, `Retry-After` in `Access-Control-Expose-Headers` |
| Token bucket | `tokens = min(B, tokens + elapsed × r)`; deny when `tokens < cost` |
| Sliding counter | `count ≈ c_prev × (1 − f) + c_cur` |
| Client backoff | `sleep = random(0, min(cap, base × 2^attempt))` |
| Safe write retry | `Idempotency-Key: <uuid>` |
| Key preference | `api_key` → `tenant_id` → `user_id` → `ip`; TTL = window + margin |
| Tightest limits | `/token`, `/login`, `/password-reset`, `/verify-otp` |

**Flash cards**

- **Which status code, and what header must accompany it?** → `429 Too Many Requests` with `Retry-After` (delta-seconds or HTTP-date).
- **Why not fixed windows?** → 2× burst at the boundary: 100 at 12:00:59 plus 100 at 12:01:00 is 200 in one second.
- **Token bucket's two parameters?** → Refill rate `r` (sustained throughput) and capacity `B` (maximum burst).
- **Why jitter the backoff?** → Without it every throttled client retries simultaneously and recreates the spike — the thundering herd.
- **429 vs 503?** → `429` = you are sending too fast; `503` = we are unhealthy. Different cause, different runbook, both take `Retry-After`.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Implement all four algorithms (fixed window, sliding log, sliding counter, token bucket) against the same traffic trace and chart allowed-versus-denied over time; measure the boundary burst that fixed windows let through.
- [ ] Write the Redis Lua token bucket, then hammer it with 500 concurrent requests and prove the count is exact — then replace it with non-atomic `GET`/`SET` and measure how many requests leak through.
- [ ] Build a client with full-jitter backoff and one with fixed backoff; throttle both from 100 simulated instances and plot the retry arrival distribution.
- [ ] Add `RateLimit`/`RateLimit-Policy` headers plus CORS exposure, then write a browser client that self-paces from the headers and never triggers a `429`.
- [ ] Simulate a Redis outage and verify fail-open/fail-closed behaviour differs correctly between a cheap `GET` and a paid `POST /sms`.

**Mini Project — a tiered API rate limiter**

*Goal:* build a production-shaped limiter with plans, quotas, correct semantics and full observability.

*Requirements:*
1. Three plans (free 60/min, pro 1,000/min, enterprise 10,000/min) with per-endpoint cost weighting so expensive operations deduct more tokens.
2. Atomic Redis token bucket via Lua, keyed by API key with a secondary per-tenant limit and a per-IP fallback for unauthenticated routes.
3. Correct responses everywhere: `RateLimit` and `RateLimit-Policy` headers on 2xx and 429 alike, `Retry-After` on 429, RFC 9457 problem details, and CORS exposure of all three.
4. A separate monthly quota with 80%/95% warning notifications, billing-boundary reset, and no charge for rejected calls.
5. Prometheus metrics for decisions, per-key 429 share, `remaining` distribution and limiter latency, plus a Grafana dashboard and alerts for single-key abuse versus global saturation.

*Extensions:* add local pre-filtering with periodic reconciliation and measure the overshoot; add priority-based load shedding that drops analytics traffic before checkout traffic; add a concurrency limiter (in-flight requests, not just rate) for long-running endpoints; add a self-service endpoint where a customer can view their bucket state and usage.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *OWASP API Security Top 10* (chapter 23) covers API4 Unrestricted Resource Consumption and API6 business-flow abuse, which this chapter's controls implement; *OAuth 2.0 & OpenID Connect* (chapter 19) covers the `/token` endpoint that needs the tightest limits; *TLS, CORS & Security Headers* (chapter 22) explains why `RateLimit` headers need `Access-Control-Expose-Headers`; *Authorization: RBAC, ABAC & Scopes* (chapter 21) covers the per-tenant identity your keys should be derived from.

- **RFC 6585 — Additional HTTP Status Codes** — IETF · *Beginner* · defines `429 Too Many Requests` and its intended semantics in two short paragraphs. <https://www.rfc-editor.org/rfc/rfc6585>
- **RFC 9110 §10.2.3 — Retry-After** — IETF · *Intermediate* · the normative definition of both the delta-seconds and HTTP-date forms, and where the header is valid. <https://www.rfc-editor.org/rfc/rfc9110#field.retry-after>
- **RateLimit header fields for HTTP** — IETF HTTPAPI WG · *Intermediate* · the standardisation effort behind `RateLimit` and `RateLimit-Policy`; read it before inventing your own header. <https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/>
- **Google SRE Book — Handling Overload & Addressing Cascading Failures** — Google · *Advanced* · the definitive free treatment of load shedding, graceful degradation and retry amplification. <https://sre.google/sre-book/handling-overload/>
- **Exponential Backoff and Jitter** — AWS Architecture Blog (Marc Brooker) · *Intermediate* · the paper-quality post with simulations showing why full jitter beats every other backoff strategy. <https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/>
- **How we built rate limiting capable of scaling to millions of domains** — Cloudflare · *Advanced* · the sliding-window-counter approach with real accuracy measurements at internet scale. <https://blog.cloudflare.com/counting-things-a-lot-of-different-things/>
- **Stripe API — Rate limits** — Stripe · *Beginner* · a model of how to document limits, error responses and recommended client behaviour. <https://docs.stripe.com/rate-limits>
- **GitHub REST API — Rate limits** — GitHub · *Intermediate* · primary versus secondary limits, header semantics, and best practices for high-volume clients. <https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api>

---

*REST API Handbook — chapter 24.*
