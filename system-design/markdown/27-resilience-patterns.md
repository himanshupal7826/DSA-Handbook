# 27 · Circuit Breaker, Retry, Backoff & Bulkhead

> **In one line:** In a distributed system, dependencies *will* fail — resilience patterns stop one slow or broken dependency from taking down everything that touches it.

---

## 1. Overview

In a monolith, a failing function throws an exception and you move on. In a distributed system, a "failing" dependency is far nastier: it might be *slow* rather than down, and slowness is contagious. A downstream that goes from 20 ms to 5 s doesn't just make one call slow — it holds a thread, a connection, and memory for 250× longer, and under load those resources exhaust. Now the caller is unhealthy too, and its callers, and so on. This is a **cascading failure**, and it's how a single degraded service takes down an entire platform.

**Resilience patterns** are the countermeasures. **Timeouts** cap how long you wait. **Retries with backoff and jitter** recover from transient blips without amplifying load. **Circuit breakers** stop hammering a dead dependency and give it room to recover. **Bulkheads** isolate resources so one sick dependency can't drain the pool everyone shares. **Load shedding** and **graceful degradation** decide what to drop and what to fake when you're over capacity. Together they turn "hard failures cascade" into "partial failures stay contained."

The canonical text is Michael Nygard's *Release It!*, which named the circuit breaker and bulkhead patterns for software; AWS's *"Timeouts, retries, and backoff with jitter"* is the definitive practical guide. Netflix's Hystrix (and its successor resilience4j, Envoy's outlier detection, Istio) productized these ideas at scale.

The unifying principle: **fail fast, fail isolated, and degrade gracefully** — a slow failure that spreads is worse than a fast failure that's contained.

## 2. Core Concepts

- **Timeout** — the maximum time you'll wait for a response before giving up. The single most important and most-forgotten setting; without it, a hung dependency hangs you forever.
- **Retry** — re-attempt a failed call, betting the failure was transient (a dropped packet, a brief GC pause, a rolling deploy). Only safe for **idempotent** operations.
- **Idempotency** — an operation that can be applied multiple times with the same effect (GET, PUT, DELETE; POST usually is not). The prerequisite for safe retries.
- **Exponential backoff** — wait longer between each retry (100 ms, 200 ms, 400 ms…) to give the dependency time to recover instead of piling on.
- **Jitter** — randomize the backoff so a fleet of clients doesn't retry in lockstep and create a synchronized spike.
- **Retry storm / amplification** — retries multiply load exactly when a system is already struggling, turning a brownout into an outage.
- **Circuit breaker** — a stateful gate (closed/open/half-open) that stops calling a failing dependency after a threshold, failing fast until it looks healthy again.
- **Bulkhead** — resource isolation (separate thread/connection pools per dependency) so one saturated dependency can't consume the shared pool.
- **Load shedding** — proactively rejecting excess work (with 429/503) to protect the system's core from collapsing under overload.
- **Graceful degradation / fallback** — serving a reduced-but-useful response (cached, default, partial) when a dependency is unavailable, instead of erroring.

## 3. Architecture

Resilience patterns compose as **layers of defense around every remote call**. A request flows through a bulkhead (isolated resource pool) into a circuit breaker (fast-fail gate) that wraps a timed, retried call — and if all else fails, a fallback catches it so the user gets *something*.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a3" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" fill="#64748b">Layers of defense around one remote call</text>

  <rect x="20" y="45" width="720" height="180" rx="10" fill="none" stroke="#94a3b8" stroke-dasharray="5 4"/>
  <text x="90" y="63" fill="#64748b">Bulkhead: isolated pool</text>

  <rect x="40" y="80" width="150" height="120" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="115" y="120" text-anchor="middle" fill="#1e293b">Caller</text>
  <text x="115" y="140" text-anchor="middle" fill="#64748b">thread/conn</text>
  <text x="115" y="156" text-anchor="middle" fill="#64748b">pool (bounded)</text>

  <rect x="250" y="80" width="180" height="120" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="340" y="112" text-anchor="middle" fill="#1e293b">Circuit Breaker</text>
  <text x="340" y="134" text-anchor="middle" fill="#64748b">closed / open /</text>
  <text x="340" y="150" text-anchor="middle" fill="#64748b">half-open</text>
  <text x="340" y="176" text-anchor="middle" fill="#64748b">+ timeout + retry(jitter)</text>

  <rect x="490" y="80" width="150" height="120" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="565" y="130" text-anchor="middle" fill="#1e293b">Dependency</text>
  <text x="565" y="150" text-anchor="middle" fill="#64748b">(may be slow/down)</text>

  <line x1="190" y1="140" x2="248" y2="140" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="430" y1="140" x2="488" y2="140" stroke="#475569" marker-end="url(#a3)"/>

  <rect x="250" y="255" width="180" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="340" y="282" text-anchor="middle" fill="#1e293b">Fallback</text>
  <text x="340" y="300" text-anchor="middle" fill="#64748b">cache / default / partial</text>

  <path d="M340 200 L340 253" stroke="#b91c1c" stroke-dasharray="4 3" marker-end="url(#a3)"/>
  <text x="470" y="235" text-anchor="middle" fill="#b91c1c">on open / timeout → degrade</text>
</svg>
```

Read the diagram inside-out: the timeout bounds each attempt; retries handle transient failures within the budget; the circuit breaker watches the aggregate failure rate and trips to fail-fast when the dependency is clearly broken; the bulkhead ensures that even a fully hung dependency only exhausts *its own* bounded pool, not the whole process; and the fallback provides a degraded answer so the user experience survives.

## 4. How It Works

The circuit breaker is the stateful core, so trace its state machine — a classic three-state design (Nygard / Hystrix / resilience4j).

```svg
<svg viewBox="0 0 720 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a4" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <rect x="40" y="90" width="150" height="80" rx="10" fill="#ecfdf5" stroke="#059669"/>
  <text x="115" y="125" text-anchor="middle" fill="#1e293b">CLOSED</text>
  <text x="115" y="145" text-anchor="middle" fill="#64748b">calls pass; count fails</text>

  <rect x="285" y="90" width="150" height="80" rx="10" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="125" text-anchor="middle" fill="#1e293b">OPEN</text>
  <text x="360" y="145" text-anchor="middle" fill="#64748b">fail fast; no calls</text>

  <rect x="530" y="90" width="150" height="80" rx="10" fill="#eff6ff" stroke="#2563eb"/>
  <text x="605" y="120" text-anchor="middle" fill="#1e293b">HALF-OPEN</text>
  <text x="605" y="140" text-anchor="middle" fill="#64748b">let a few probes</text>
  <text x="605" y="156" text-anchor="middle" fill="#64748b">through</text>

  <line x1="190" y1="115" x2="283" y2="115" stroke="#475569" marker-end="url(#a4)"/>
  <text x="237" y="105" text-anchor="middle" fill="#b91c1c">fail rate &gt; threshold</text>

  <line x1="435" y1="130" x2="528" y2="130" stroke="#475569" marker-end="url(#a4)"/>
  <text x="482" y="152" text-anchor="middle" fill="#64748b">after cool-down</text>

  <path d="M605 90 C 560 30, 200 30, 130 88" fill="none" stroke="#059669" marker-end="url(#a4)"/>
  <text x="370" y="40" text-anchor="middle" fill="#059669">probes succeed → CLOSED (reset)</text>

  <path d="M605 170 C 560 220, 420 220, 375 172" fill="none" stroke="#b91c1c" marker-end="url(#a4)"/>
  <text x="490" y="232" text-anchor="middle" fill="#b91c1c">probe fails → OPEN</text>
</svg>
```

The end-to-end call flow, combining all patterns:
1. **Acquire from bulkhead.** Take a slot from this dependency's bounded pool. If the pool is exhausted (dependency is slow), reject *immediately* — don't queue unboundedly. This is where a hung dependency stops spreading.
2. **Check the breaker.** If **OPEN**, short-circuit instantly to the fallback — no network call. If **HALF-OPEN**, allow only a limited number of probe calls. If **CLOSED**, proceed.
3. **Make the call with a timeout.** Enforce a hard deadline (e.g., 500 ms). A timeout counts as a failure toward the breaker.
4. **On transient failure, retry with backoff + jitter** — but only if the operation is idempotent and you're within the retry budget (typically 2–3 attempts max), and only while the breaker is CLOSED.
5. **Record the outcome.** Success/failure updates the breaker's rolling window; crossing the failure-rate threshold trips it to OPEN.
6. **On exhaustion, fall back.** Return cached data, a default, or a partial response — degrade gracefully rather than erroring.

## 5. Key Components / Deep Dive

### Timeouts
The foundation — without a timeout, every other pattern is moot because a hung call holds resources forever. Set timeouts from the **downstream's latency distribution**, not a guess: a good rule is timeout ≈ p99.9 of the dependency, plus a margin. Two flavors matter: **connection timeout** (fast, ~hundreds of ms) and **request/read timeout** (based on the operation). Budget them across a call chain — if the user-facing SLA is 1 s and you make three sequential calls, each can't have a 1 s timeout. Propagate a **deadline** down the chain so downstreams know how much time is left.

### Retries — and when *not* to
Retries recover from transient faults (packet loss, brief GC, a pod rolling). But retry only when:
- The operation is **idempotent** (GET/PUT/DELETE; POST only with an idempotency key). Retrying a non-idempotent charge can double-bill.
- The error is **retryable** (timeout, 503, connection reset) — never retry a 400/401/422; the input is wrong and will fail again.
- You're within a **budget** (2–3 attempts) — unbounded retries are an attack on your own backend.
Crucially, **do not retry at every layer** of a call stack. If each of 4 layers retries 3×, a single logical request becomes 3⁴ = 81 calls — retry amplification. Retry at **one** layer (usually the outermost that has context), and let inner layers fail fast.

### Exponential backoff + jitter
Fixed-interval retries from a fleet create synchronized waves that keep the dependency down. **Exponential backoff** (`base * 2^attempt`) spaces attempts out. **Jitter** randomizes each client's wait so they don't all fire at the same instant. AWS's recommended form is **full jitter**: `sleep = random(0, min(cap, base * 2^attempt))`. The AWS analysis shows full jitter dramatically reduces contention and total work versus plain exponential backoff. Without jitter, backoff alone still produces thundering herds at each retry boundary.

### Circuit breaker states
- **Closed** (normal): calls flow; the breaker tracks failures in a rolling window (count or %). Crossing the threshold (e.g., >50% failures over the last 20 calls) trips it.
- **Open** (tripped): all calls fail fast (or go straight to fallback) for a cool-down period. This stops hammering a dead dependency and lets it recover — and stops the caller from burning threads on doomed calls.
- **Half-open** (probing): after cool-down, let a small number of trial calls through. If they succeed, close (reset); if they fail, re-open. This prevents flapping back to full traffic before the dependency is truly healthy.
The breaker converts slow, resource-draining failures into fast, cheap ones — the essence of stopping a cascade.

### Bulkhead isolation
Named after ship compartments: a hull breach floods one compartment, not the whole ship. In software, give each downstream its **own bounded resource pool** (thread pool or semaphore, connection pool). If dependency X hangs, only X's pool exhausts; calls to healthy dependency Y still get threads. Without bulkheads, one slow dependency consumes the *shared* thread pool and the whole service goes down — the exact failure Hystrix was built to prevent. Sizing is a trade-off: too small throttles healthy traffic, too large defeats isolation.

### Load shedding & backpressure
When you're over capacity, doing *some* work well beats doing *all* work badly. **Load shedding** rejects excess requests early (return 503/429) before they consume resources, keeping the accepted requests fast — prioritize by importance (drop health-check retries before checkouts). **Backpressure** propagates "slow down" upstream (bounded queues that reject when full) rather than buffering unboundedly until OOM. This is rate limiting's server-side twin — see **Rate Limiting**.

### Graceful degradation & fallback
Design each feature to have a *degraded mode*. If recommendations are down, show popular items. If the live price service times out, show a cached price with a "as of" timestamp. If the avatar service fails, show initials. The fallback should be **cheap and local** (cache, default, static) — never another remote call that can also fail. Amazon's product pages famously degrade section-by-section rather than erroring the whole page.

## 6. Trade-offs

| Pattern | Pros | Cons |
|---|---|---|
| **Timeout** | Bounds resource hold time; prevents hangs | Too tight → false failures; too loose → slow cascades |
| **Retry (backoff+jitter)** | Recovers transient faults transparently | Amplifies load; unsafe for non-idempotent ops; adds latency |
| **Circuit breaker** | Fails fast, lets dependency recover, stops cascade | Tuning thresholds is hard; can mask real issues; adds state |
| **Bulkhead** | One dependency can't sink the ship | Pool sizing trade-off; under-utilization; more config |
| **Load shedding** | Protects core under overload | Rejects real work; needs prioritization logic |
| **Graceful degradation** | User gets *something*; higher effective availability | Extra code paths; stale/partial data; testing burden |

The central tension is **latency/availability vs. correctness/completeness**. Aggressive timeouts and shedding keep the system fast and up but reject or fake some requests. Retries improve success rates but risk amplification. Every pattern here spends completeness to buy stability — the art is choosing *where* your product can tolerate a degraded answer.

## 7. When to Use / When to Avoid

**Use these patterns when:**
- Any call crosses a network boundary (service-to-service, DB, cache, third-party API).
- A dependency's failure would otherwise cascade to your service or users.
- You have SLA obligations and must bound tail latency.
- You integrate with flaky or rate-limited third parties.

**Avoid / be careful when:**
- **Retries on non-idempotent operations** without an idempotency key — you risk duplicate side effects (double charges).
- **Retrying deterministic errors** (4xx validation) — it will fail identically and wastes capacity.
- **Circuit breakers on a single instance** where a global one is needed, or with untuned thresholds that flap.
- **In-process/local calls** — timeouts and breakers add overhead for a call that can't have network faults.
- **Over-engineering** — a low-traffic internal tool may only need a timeout, not the full stack.

## 8. Scaling & Production Best Practices

- **Every remote call gets a timeout.** No exceptions. A missing timeout is a latent outage. Default libraries often ship with *infinite* timeouts — override them.
- **Budget deadlines across the chain.** Propagate a remaining-time deadline; downstreams shouldn't start work that can't finish within the caller's SLA.
- **Retry at one layer, with a budget.** Cap at 2–3 attempts, exponential backoff, **full jitter**. Never nest retries across layers.
- **Make writes idempotent** with idempotency keys so retries are safe end-to-end.
- **Tune breakers from data.** Set thresholds off observed failure rates; start conservative and adjust. Envoy/Istio outlier detection and resilience4j give you these knobs.
- **Bulkhead by dependency**, sized to that dependency's normal concurrency plus headroom; monitor pool saturation.
- **Shed load early and by priority.** Reject at the edge; drop the least important traffic first; keep a small reserve for health checks and critical paths.
- **Design and test fallbacks.** A fallback you've never exercised will fail when you need it — game-day it. Use **chaos engineering** (fault injection) to verify the whole stack under real failure.
- **Add jitter everywhere** timers synchronize: retries, TTLs, breaker probes, reconnect loops.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| **Missing/infinite timeout** | Threads pile up, service hangs, cascade | Mandatory per-call timeouts from p99.9; deadline propagation |
| **Retry storm / amplification** | Retries multiply load, DoS your own backend | Budget (2–3), backoff+jitter, retry at one layer only, breaker |
| **Non-idempotent retry** | Duplicate side effects (double charge) | Idempotency keys; retry only safe methods |
| **Slow dependency (not down)** | Resource exhaustion, gray failure | Timeout + bulkhead + breaker on latency, not just errors |
| **Thread-pool exhaustion** | One dependency sinks the whole service | Bulkhead: per-dependency bounded pools |
| **Breaker flapping** | Traffic oscillates on/off | Half-open probes; hysteresis; tuned windows |
| **Synchronized recovery** | Herd hits dependency when breaker closes | Jittered half-open, gradual traffic ramp |
| **Fallback also fails** | Degraded path errors too | Keep fallbacks local/cheap (cache/default), never remote |
| **Overload collapse** | Everything slow, nothing completes | Load shed early by priority; backpressure with bounded queues |

## 10. Monitoring & Metrics

- **Timeout rate** per dependency — rising timeouts signal a degrading downstream before it fully fails.
- **Retry rate & retry success ratio** — high retries with low success means retries aren't helping (and may be amplifying).
- **Circuit breaker state & trip count** — how often and how long breakers are open per dependency; a constantly-open breaker is an unhealthy dependency.
- **Bulkhead / pool saturation** — pool utilization and rejections; saturation means a slow dependency or an undersized pool.
- **Load-shed / 503 rate** — how much work you're rejecting; spikes indicate overload.
- **Fallback invocation rate** — how often users get degraded responses (a stealth-availability metric).
- **Downstream latency distribution (p50/p99/p999)** — tail latency is where cascades start; watch the tail, not the mean.
- **End-to-end success rate & error budget burn** — the user-facing outcome the whole stack protects — see **Observability**.

## 11. Common Mistakes

1. ⚠️ **No timeout (or an infinite default)** — the number-one cause of cascading failures; a hung call holds resources forever.
2. ⚠️ **Retrying at every layer** — 3 retries × 4 layers = 81× amplification that turns a brownout into an outage.
3. ⚠️ **Retrying non-idempotent operations** — duplicate charges, duplicate emails, corrupted state.
4. ⚠️ **Backoff without jitter** — synchronized retry waves keep the dependency down and re-spike at each boundary.
5. ⚠️ **Retrying 4xx errors** — deterministic failures retried are pure wasted load.
6. ⚠️ **No bulkhead** — one slow dependency drains the shared thread pool and sinks unrelated features.
7. ⚠️ **Untested fallbacks** — the degraded path is dead code until an incident, when it also fails.
8. ⚠️ **Breaker tripping only on errors, not latency** — a dependency that's slow-but-200 evades the breaker and still exhausts you.

## 12. Interview Questions

**Q: Why are timeouts the most important resilience setting?**
A: Without a timeout, a hung or slow dependency holds a thread, connection, and memory indefinitely; under load those resources exhaust and the caller fails too — a cascade. A timeout bounds the resource hold and converts an unbounded hang into a fast, recoverable failure. Every other pattern assumes calls eventually return; the timeout guarantees it.

**Q: When is it safe to retry, and when is it dangerous?**
A: Safe when the operation is idempotent (GET/PUT/DELETE or POST with an idempotency key), the error is transient/retryable (timeout, 503, connection reset), and you're within a small budget with backoff+jitter. Dangerous for non-idempotent writes (double side effects), for deterministic 4xx errors (will fail again), and when retrying at multiple layers (exponential amplification).

**Q: What is a retry storm and how do you prevent it?**
A: Retries multiply load exactly when a system is already struggling, turning a brownout into an outage — worsened if every layer retries (3⁴ = 81×). Prevent with a retry budget (2–3), exponential backoff with jitter, retrying at only one layer, and a circuit breaker that stops retries entirely once the dependency is clearly down.

**Q: Explain the circuit breaker's three states.**
A: Closed — calls flow, failures are counted; crossing a threshold trips it. Open — calls fail fast for a cool-down, sparing the dead dependency and the caller's resources. Half-open — a few probe calls test recovery; success closes the breaker, failure re-opens it. It converts slow, resource-draining failures into fast, cheap ones.

**Q: What problem does a bulkhead solve that a circuit breaker doesn't?**
A: A bulkhead provides *resource isolation*: each dependency gets its own bounded pool, so a slow dependency can only exhaust its own compartment, not the shared thread pool that healthy dependencies also need. A breaker stops calling a *known-bad* dependency; a bulkhead contains the damage of a *slow* one before the breaker even trips.

**Q (senior): Why is jitter necessary on top of exponential backoff, and what does "full jitter" mean?**
A: Plain exponential backoff still synchronizes a fleet — every client waits the same interval and fires together at each boundary, re-spiking the dependency. Jitter randomizes each client's wait to spread the load. Full jitter (`random(0, min(cap, base·2^n))`) is AWS's recommended form; their analysis shows it minimizes contention and total retry work versus fixed or "equal" jitter.

**Q (senior): A downstream is slow (p99 = 8 s) but returns 200s. Your breaker never trips and your service is degrading. What's wrong?**
A: The breaker only counts errors, not latency, so slow-but-successful calls evade it while still exhausting threads. Fix by treating timeouts as failures (set a timeout well below 8 s so slow calls become errors the breaker counts) and by tripping the breaker on latency/pool-saturation signals, plus a bulkhead so the slow dependency can't drain the shared pool. This is "gray failure."

**Q (senior): How do you make retries safe for a payment API?**
A: Make the write idempotent with a client-generated idempotency key: the server records the key's result and, on a retry with the same key, returns the original result instead of charging again. Combine with a bounded retry budget and backoff+jitter. Now a network timeout after the charge succeeded is safe to retry — the server dedupes it.

**Q (senior): Under overload, would you rather shed load or queue requests? Why?**
A: Shed. Unbounded queuing just defers collapse — latency climbs until requests time out anyway and you've spent memory buffering doomed work (bufferbloat). Shedding early (reject with 503, prioritizing critical traffic) keeps accepted requests fast and the core healthy. Backpressure with *bounded* queues that reject when full is the disciplined version of the same idea.

**Q (senior): How do you set a timeout for a service that makes three sequential downstream calls under a 1 s SLA?**
A: You budget the deadline across the chain — you can't give each call 1 s. Allocate based on each downstream's latency profile within the total, propagate a *remaining-time* deadline so each call knows how long it has, and cancel work that can't finish in time. Parallelize independent calls to spend the budget concurrently instead of serially.

**Q (senior): Your circuit breaker keeps flapping between open and closed. Diagnose and fix.**
A: Flapping means the half-open probe closes the breaker, full traffic immediately re-overloads the (still-recovering) dependency, and it re-opens. Fix with hysteresis: require several consecutive probe successes before closing, ramp traffic gradually rather than 0→100%, jitter probe timing, and widen the rolling window so a couple of successes don't prematurely declare health.

## 13. Alternatives & Related

- **Rate Limiting** — the client/inbound twin of load shedding; both control how much work enters the system.
- **Caching** — a cache serving stale data is a primary graceful-degradation fallback.
- **Observability** — you can't tune timeouts, breakers, or budgets without latency distributions and failure metrics.
- **Message Queues** — async/queue-based decoupling absorbs bursts and provides backpressure by design.
- **CAP & Consistency** — degradation often means trading consistency for availability during a partition.
- **Load Balancing** — health checks and outlier detection (Envoy) are breaker-like patterns at the LB layer.

## 14. Cheat Sheet

> [!TIP]
> **Resilience in one screen.**
> - **Timeout first.** Every remote call, always. Set from p99.9 + margin; propagate a deadline across the chain.
> - **Retry:** only idempotent ops, only retryable errors, budget 2–3, **exponential backoff + full jitter**, at **one** layer.
> - **Circuit breaker:** closed → (fail rate > threshold) → open → (cool-down) → half-open → (probes pass) → closed. Trip on latency, not just errors.
> - **Bulkhead:** per-dependency bounded pools so one slow dep can't drain the shared pool.
> - **Overload:** shed load early by priority (503/429); bounded queues for backpressure — never buffer unboundedly.
> - **Degrade gracefully:** cheap, local fallbacks (cache/default/partial). Test them — a fallback you've never run will fail.
> - **Golden rule:** fail fast, fail isolated, degrade gracefully. A slow failure that spreads is the worst outcome.

**References:** Michael Nygard — *Release It!* (2nd ed.) · AWS Builders' Library — "Timeouts, retries, and backoff with jitter" · Netflix Hystrix / resilience4j docs · Google SRE Book — "Handling Overload" & "Addressing Cascading Failures"

---
*System Design Handbook — topic 27.*
