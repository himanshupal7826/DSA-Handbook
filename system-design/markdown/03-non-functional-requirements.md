# 03 · Latency, Throughput, Availability & SLAs

> **In one line:** The non-functional metrics — tail latency, throughput, availability nines, and error budgets — that shape every architecture more than features do.

---

## 1. Overview

Features tell you *what* a system does; **non-functional requirements** tell you *how well* it must do it — and that's what actually decides the architecture. "Load the feed" is a feature. "Load the feed in under 200 ms at the 99th percentile, 99.99% of the time, for 1 M concurrent users" is an engineering problem that dictates caching, replication, and redundancy.

These metrics cluster into four ideas. **Latency** is how long one request takes; **throughput** is how many requests you handle per second — related but independent (a system can be high-throughput and high-latency, like a batch pipeline). **Availability** is the fraction of time the system is up, measured in "nines." And the **SLI/SLO/SLA** hierarchy plus **error budgets** turn those targets into an operational contract with real consequences.

The single most important insight is that **averages lie**. If your average latency is 50 ms but your p99 is 2 seconds, one in every hundred requests is a disaster — and on a page that makes 100 backend calls, nearly *every* page hit touches that tail. Senior engineers reason in **percentiles** (p50, p95, p99, p999), never means.

The second key insight is that **availability is math**. Two components in series multiply their failure probabilities (reliability drops); redundant components multiply their *unavailability* (reliability climbs). Knowing this lets you compute a system's availability from its parts — and see why adding a synchronous dependency quietly downgrades your whole SLA.

## 2. Core Concepts

- **Latency** — time to service a single request (ms/µs). Always a distribution, quoted as a percentile. See tail latency below.
- **Throughput** — requests (or bytes) processed per unit time (QPS, MB/s). Bounded by the slowest resource (CPU, disk, network, locks).
- **Latency vs throughput** — independent axes. Little's Law ties them: **concurrency = throughput × latency**. Reducing latency frees capacity; batching raises throughput but can hurt latency.
- **Percentiles (p50/p95/p99/p999)** — the value below which that % of requests fall. **p99 = 2 s** means 1% of requests take ≥ 2 s. Tail percentiles capture the pain users actually feel.
- **Tail latency amplification** — a request that fans out to N services waits on the slowest; with 100 calls, p99 per-call becomes near-certain per-request. Fan-out multiplies tail exposure.
- **Availability (nines)** — uptime fraction. 99.9% ("three nines") = 8.77 h/yr down; each extra nine cuts downtime ~10×.
- **SLI / SLO / SLA** — SLI is the *measured* metric (e.g. % of requests < 300 ms); SLO is the *internal target* (99.9%); SLA is the *external contract* with penalties. SLO < SLA (buffer).
- **Error budget** — 1 − SLO. At 99.9%, you get 0.1% failures ≈ 43 min/month to "spend" on risk, deploys, and experiments before you must freeze and stabilize.
- **Availability math** — serial dependencies multiply availabilities (worse); redundant replicas multiply unavailabilities (better).
- **Durability vs availability** — durability = data isn't lost (11 nines for S3); availability = you can reach it now. Different guarantees, often confused.

## 3. Architecture

Non-functional requirements aren't a component — they're constraints layered onto every hop of the request path. This diagram shows how a latency budget is *spent* across the path and how the SLI/SLO/SLA hierarchy wraps the whole thing.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah3" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">Latency Budget Across the Request Path (target p99 &lt; 200 ms)</text>

  <rect x="20"  y="55" width="120" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80"  y="77" text-anchor="middle" fill="#1e293b" font-weight="700">Client / CDN</text>
  <text x="80"  y="95" text-anchor="middle" fill="#64748b" font-size="11">~20 ms</text>

  <rect x="180" y="55" width="120" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="240" y="77" text-anchor="middle" fill="#1e293b" font-weight="700">Load Balancer</text>
  <text x="240" y="95" text-anchor="middle" fill="#64748b" font-size="11">~5 ms</text>

  <rect x="340" y="55" width="120" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="400" y="77" text-anchor="middle" fill="#1e293b" font-weight="700">Service</text>
  <text x="400" y="95" text-anchor="middle" fill="#64748b" font-size="11">~30 ms</text>

  <rect x="500" y="55" width="120" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="560" y="77" text-anchor="middle" fill="#1e293b" font-weight="700">Cache (RAM)</text>
  <text x="560" y="95" text-anchor="middle" fill="#64748b" font-size="11">~1 ms hit</text>

  <rect x="640" y="55" width="110" height="52" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="695" y="77" text-anchor="middle" fill="#1e293b" font-weight="700">DB (miss)</text>
  <text x="695" y="95" text-anchor="middle" fill="#64748b" font-size="11">~10 ms</text>

  <line x1="140" y1="81" x2="176" y2="81" stroke="#475569" marker-end="url(#ah3)"/>
  <line x1="300" y1="81" x2="336" y2="81" stroke="#475569" marker-end="url(#ah3)"/>
  <line x1="460" y1="81" x2="496" y2="81" stroke="#475569" marker-end="url(#ah3)"/>
  <line x1="620" y1="81" x2="636" y2="81" stroke="#475569" marker-end="url(#ah3)"/>

  <text x="380" y="140" text-anchor="middle" fill="#64748b" font-size="11">Sum the budget along the path; the tail (p99) is dominated by the slowest hop + cache misses.</text>

  <rect x="120" y="165" width="520" height="115" rx="10" fill="none" stroke="#475569" stroke-dasharray="5 4"/>
  <text x="380" y="185" text-anchor="middle" fill="#1e293b" font-weight="700">SLI → SLO → SLA</text>

  <rect x="150" y="200" width="140" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="220" y="222" text-anchor="middle" fill="#1e293b" font-weight="700">SLI (measured)</text>
  <text x="220" y="240" text-anchor="middle" fill="#64748b" font-size="11">% req &lt; 200 ms</text>
  <text x="220" y="253" text-anchor="middle" fill="#64748b" font-size="11">= 99.95%</text>

  <rect x="310" y="200" width="140" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="380" y="222" text-anchor="middle" fill="#1e293b" font-weight="700">SLO (target)</text>
  <text x="380" y="240" text-anchor="middle" fill="#64748b" font-size="11">99.9% internal</text>
  <text x="380" y="253" text-anchor="middle" fill="#64748b" font-size="11">budget = 0.1%</text>

  <rect x="470" y="200" width="140" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="540" y="222" text-anchor="middle" fill="#1e293b" font-weight="700">SLA (contract)</text>
  <text x="540" y="240" text-anchor="middle" fill="#64748b" font-size="11">99.5% + penalty</text>
  <text x="540" y="253" text-anchor="middle" fill="#64748b" font-size="11">SLA &lt; SLO buffer</text>

  <line x1="290" y1="230" x2="306" y2="230" stroke="#475569" marker-end="url(#ah3)"/>
  <line x1="450" y1="230" x2="466" y2="230" stroke="#475569" marker-end="url(#ah3)"/>
  <text x="380" y="305" text-anchor="middle" fill="#64748b" font-size="11">SLA is looser than SLO on purpose — the gap is your safety margin before you owe money.</text>
</svg>
```

## 4. How It Works

1. **Define the SLI** — pick a precise, measurable metric: "proportion of `GET /feed` requests served in < 200 ms" or "proportion of requests returning non-5xx." Ambiguous SLIs are useless.
2. **Set the SLO** — the internal target the team commits to, e.g. 99.9% of requests meet the SLI over a 28-day window. This is aspirational-but-real; teams are held to it.
3. **Derive the error budget** — 1 − SLO = 0.1% ≈ 43 min/month of allowed failure. This is a *resource you spend* on deploys, risky changes, and experiments.
4. **Set the SLA** — the external, contractual promise, deliberately looser than the SLO (e.g. SLA 99.5%, SLO 99.9%) so you breach your internal target long before you owe a customer a refund.
5. **Measure continuously** — instrument latency histograms and success rates; compute percentiles and availability over rolling windows.
6. **Burn or bank the budget** — if error budget is healthy, ship fast and take risks. If it's exhausted, **freeze features and stabilize** until it recovers. This is the mechanism that aligns velocity and reliability.
7. **Attribute tail latency** — when p99 breaches, trace the fan-out: which downstream, which cache-miss path, which GC pause, which lock contention is producing the slow tail.

## 5. Key Components / Deep Dive

### Why Averages Lie — Percentiles and Tail Latency

An average is dominated by the common case and hides the tail — exactly the requests that hurt. Consider 100 requests at 10 ms and 1 request at 2,000 ms: the mean is ~30 ms (looks fine), but the p99 is 2,000 ms. Users experience the tail, not the mean.

Worse, tails **amplify under fan-out**. If a single service call has a p99 of 100 ms (1% chance of being slow), a request that makes 100 parallel downstream calls and waits for all of them has a ~1 − 0.99¹⁰⁰ ≈ **63% chance** of hitting at least one slow call. This is **tail latency amplification** — the reason Google engineers optimize p99/p999, use hedged requests (send a duplicate to a second replica after a delay, take the first response), and set tight per-call timeouts. Mitigations: hedging, request cancellation, tighter timeouts, and reducing fan-out width.

### The Nines Table

| Availability | Downtime / year | Downtime / month | Downtime / day | Typical use |
|---|---|---|---|---|
| 99% (two nines) | 3.65 days | 7.3 h | 14.4 min | Internal / batch |
| 99.9% (three nines) | 8.77 h | 43.8 min | 1.44 min | Standard web service |
| 99.95% | 4.38 h | 21.9 min | 43 s | Paid SaaS tier |
| 99.99% (four nines) | 52.6 min | 4.38 min | 8.6 s | Critical services |
| 99.999% (five nines) | 5.26 min | 26.3 s | 0.86 s | Telecom / core infra |

Each additional nine cuts downtime ~10× and costs disproportionately more — it demands multi-region redundancy, automated failover, and rigorous operational discipline. Chasing five nines when the business needs three is expensive theater.

### SLI, SLO, SLA and Error Budgets

- **SLI (Indicator)** — what you *measure*. Good SLIs are ratios of good events to total events (e.g. fast requests / all requests).
- **SLO (Objective)** — the *target* for the SLI over a window; the team's internal promise. Should be *achievable and meaningful*, not 100% (100% is the wrong target — it's infinitely expensive and leaves no room to ship).
- **SLA (Agreement)** — the *contract* with customers, with financial penalties, set looser than the SLO.
- **Error budget** = 1 − SLO. It reframes reliability from "never fail" to "fail no more than X," turning reliability into a currency: teams spend it on innovation and pay it back with stabilization. When the budget is gone, the policy is a change freeze.

### Availability Math: Serial vs Redundant

**Serial (dependency chain):** availabilities multiply. A service depending synchronously on three components each at 99.9% has 0.999³ ≈ **99.7%** — worse than any single part. Every synchronous dependency you add *lowers* your ceiling.

**Redundant (parallel):** unavailabilities multiply. Two replicas each at 99% (1% down) give a combined unavailability of 0.01 × 0.01 = 0.0001 → **99.99%** available. Redundancy is how you *add* nines. This is the core reason for replication, multi-AZ, and multi-region: convert independent 99% parts into a 99.99% whole. The catch is **independence** — correlated failures (shared power, shared dependency, a bad deploy hitting all replicas) break the math.

## 6. Trade-offs

| Decision | Pros | Cons |
|---|---|---|
| **Optimize p99/p999** | Real user experience improves; predictable | Costs more (hedging, over-provisioning, redundancy) than chasing the mean |
| **Higher availability (more nines)** | Fewer outages, better SLA tier | Cost/complexity rise ~10× per nine (multi-region, failover automation) |
| **Strong consistency** | Correct reads always | Higher latency, lower availability under partition (CAP) |
| **Tight SLO (99.99%)** | Strong guarantee | Tiny error budget → slow release cadence, freezes |
| **Loose SLO (99.5%)** | Big budget → ship fast | More user-visible failures; may miss market expectations |
| **Redundancy for availability** | Adds nines cheaply *if* failures independent | Correlated failures negate it; adds sync/coordination cost |

The overarching tension is **reliability vs velocity**: every nine you promise shrinks the error budget and slows how fast you can safely ship. The art is choosing the *lowest* SLO the business can tolerate, so you keep budget to innovate.

## 7. When to Use / When to Avoid

**Invest in strict NFRs (high nines, tight tail) when:**
- User-facing, revenue-critical paths (checkout, payments, auth).
- Contractual SLAs with penalties, or regulated systems.
- Fan-out-heavy request paths where tail amplification bites.

**Relax them when:**
- Internal tools, batch/async jobs, or best-effort features.
- Early-stage products where velocity matters more than a fourth nine.
- Cost of the extra nine exceeds the business value of the downtime it prevents — reliability past what users notice is waste.

## 8. Scaling & Production Best Practices

- **Always specify latency as a percentile** (p99/p999), a target value, and a window — never a bare average.
- **Budget latency across the path** — assign each hop (LB, service, cache, DB) a slice and hold each to it; the sum must fit the SLO.
- **Set the SLO below the SLA** so you get an internal early warning long before a contractual breach.
- **Enforce timeouts and retries with backoff + jitter**, and cap retries — unbounded retries convert a slow dependency into a retry storm (metastable failure).
- **Use hedged requests / request cancellation** to tame tail latency on fan-out paths, but bound the extra load (e.g. hedge only after p95).
- **Ensure failure independence for redundancy math** — spread replicas across AZs/regions, avoid shared dependencies, and stagger deploys so one bad release can't take all replicas.
- **Track the error budget and enforce the freeze policy** — reliability work must win when the budget is spent.
- **Measure availability from the user's edge**, not just server-side, to capture DNS, CDN, and network failures the server never sees.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Tail latency amplification (fan-out) | p99 per call → near-certain slow request | Hedged requests, tight timeouts, reduce fan-out, request cancellation |
| Cascading failure / retry storm | One slow dep saturates callers → outage | Timeouts, circuit breakers, backoff+jitter, bulkheads, load shedding |
| Correlated redundancy failure | "Independent" replicas fail together | Multi-AZ/region, no shared deps, staggered deploys, chaos testing |
| Synchronous dependency creep | Each added sync dep lowers availability ceiling | Make non-critical deps async; degrade gracefully; cache/fallback |
| Averages hide tail regression | Users suffer while dashboards look green | Alert on p99/p999, not mean; histogram-based SLIs |
| Error budget ignored | Overshipping erodes reliability, breaches SLA | Enforce budget freeze; make it a hard policy |
| SLA == SLO (no buffer) | Internal miss = instant contract breach | Set SLO stricter than SLA by a margin |

## 10. Monitoring & Metrics

- **Latency histograms** → p50/p95/p99/p999 per endpoint and per downstream; alert on p99 breaching the SLO, not the mean.
- **Availability / success ratio** — good events ÷ total, over rolling 28-day and monthly windows, measured at the edge.
- **Error-budget burn rate** — how fast you're consuming the budget; fast-burn alerts (e.g. burning a month's budget in an hour) page immediately.
- **Throughput (QPS) and saturation** — CPU, memory, connection pool, queue depth, GC pauses — the leading indicators of the next latency cliff.
- **Timeout / retry / circuit-breaker rates** — early warning of cascading failure.
- **Apdex or SLI compliance %** — a single rolled-up "are we meeting the SLO" signal for stakeholders.
- **Per-dependency latency and error rate** — to attribute tail breaches to the offending downstream.

## 11. Common Mistakes

1. ⚠️ **Quoting averages instead of percentiles** — the mean hides the tail that users actually feel.
2. ⚠️ **Targeting 100% availability** — infinitely expensive and leaves zero error budget to ship.
3. ⚠️ **Confusing SLO and SLA** — the SLA is the looser external contract; the SLO is the stricter internal target.
4. ⚠️ **Ignoring tail amplification on fan-out** — a "fine" per-call p99 becomes a per-request disaster across 100 calls.
5. ⚠️ **Adding synchronous dependencies freely** — each one multiplies down your availability ceiling.
6. ⚠️ **Assuming redundancy = independence** — correlated failures (shared AZ, shared dep, bad deploy) void the nines math.
7. ⚠️ **Confusing durability with availability** — S3 is 11 nines durable but not always reachable; different guarantees.
8. ⚠️ **Unbounded retries** — turn a transient slowdown into a self-inflicted retry storm.

## 12. Interview Questions

**Q: What's the difference between latency and throughput?**
A: Latency is time per request (ms); throughput is requests per second. They're independent — a batch pipeline is high-throughput and high-latency. Little's Law links them: concurrency = throughput × latency, so at fixed concurrency, cutting latency raises throughput.

**Q: Why do we care about p99 instead of the average latency?**
A: The average is dominated by the common case and hides the slow tail. If p50 is 20 ms but p99 is 2 s, 1% of requests are terrible — and on a page making many backend calls, nearly every page hit touches that tail. Percentiles capture the experience users actually have.

**Q: How much downtime per year is 99.9% vs 99.99%?**
A: 99.9% ≈ 8.77 h/year; 99.99% ≈ 52.6 min/year. Each additional nine cuts downtime ~10× and costs disproportionately more.

**Q: Define SLI, SLO, and SLA.**
A: SLI is the measured metric (e.g. % of requests < 300 ms). SLO is the internal target for that SLI (99.9%). SLA is the external contract with penalties, set looser than the SLO so you breach internally first. Error budget = 1 − SLO.

**Q: What is an error budget and how is it used?**
A: 1 − SLO — the allowed amount of failure (0.1% ≈ 43 min/month at 99.9%). It's a currency: spend it on risky deploys and experiments when healthy; freeze features and stabilize when exhausted. It aligns velocity with reliability.

**Q (senior): A request fans out to 50 services, each with p99 = 50 ms. What's the request-level tail, and how do you fix it?**
A: Waiting on all 50, P(at least one slow) ≈ 1 − 0.99⁵⁰ ≈ 39% — so ~2 in 5 requests hit a slow call. That's tail amplification. Fixes: hedged requests (duplicate to another replica after p95, take the first), tight per-call timeouts with cancellation, reducing fan-out width, and optimizing the downstream p99 itself. Optimizing the mean does nothing here.

**Q (senior): Service A synchronously depends on B, C, D, each 99.9% available. What's A's availability, and how do you improve it?**
A: Serial dependencies multiply: 0.999³ ≈ 99.7% — worse than any single one, ~26 h/year down. To improve: make non-critical deps asynchronous or add fallbacks/caches so A degrades gracefully instead of failing; and add redundancy to each dependency (two 99.9% replicas → ~99.9999%). Every synchronous dependency lowers the ceiling; independence and graceful degradation raise it.

**Q (senior): Why is 100% availability the wrong target?**
A: It's infinitely expensive, physically unattainable (dependencies, deploys, hardware all fail), and leaves zero error budget — meaning you can never safely ship a change. The right target is the lowest SLO the business and users tolerate, which preserves budget to innovate. Reliability beyond what users perceive is wasted spend.

**Q (senior): How does redundancy add nines, and when does the math break?**
A: Parallel redundancy multiplies *unavailabilities*: two 99% replicas → 1 − (0.01×0.01) = 99.99%. It breaks when failures are **correlated** — shared power/AZ, a shared downstream dependency, or a bad deploy hitting all replicas at once. Real independence requires spreading across failure domains and staggering rollouts; otherwise you're paying for redundancy that fails together.

**Q: What's the difference between durability and availability?**
A: Durability means data isn't lost once written (S3 targets ~11 nines of durability); availability means you can access it right now (S3 targets ~4 nines of availability). A system can be highly durable but temporarily unavailable, or vice versa — they're separate guarantees.

**Q (senior): How do you set an SLO for a brand-new service with no history?**
A: Start from user expectations and dependency limits: measure current p99 and success rate for a few weeks to establish a baseline, set the SLO slightly tighter than observed but achievable, keep the SLA looser still, then tune. Setting an aggressive SLO with no data guarantees either constant false breaches or an unattainable target.

## 13. Alternatives & Related

- **The System Design Interview Framework** — where you extract these NFRs (step 1).
- **Back-of-the-Envelope Estimation** — latency-numbers hierarchy and QPS that feed latency budgets.
- **CAP & Consistency** — the availability-vs-consistency trade-off under partitions.
- **Load Balancing**, **Caching**, **Database Scaling** — the mechanisms you use to *hit* these targets (redundancy, tail reduction, replication).
- **Rate Limiting** — protects the SLO by shedding load before saturation.

## 14. Cheat Sheet

> [!TIP]
> **Latency ≠ throughput.** Little's Law: concurrency = throughput × latency.
> **Always quote percentiles** (p50/p95/p99/p999) + target + window. Averages hide the tail.
> **Tail amplifies on fan-out:** P(slow) ≈ 1 − (1 − p99frac)^N → hedge, timeout, cancel, shrink fan-out.
> **Nines:** 99% = 3.65 d/yr · 99.9% = 8.77 h · 99.99% = 52.6 min · 99.999% = 5.26 min. Each nine ≈ 10× less downtime, ~10× more cost.
> **SLI (measured) → SLO (internal target) → SLA (external contract, looser).** Error budget = 1 − SLO.
> **Availability math:** serial deps multiply availabilities (worse); redundant replicas multiply unavailabilities (better) — *if* failures are independent.
> **Durability ≠ availability.** Never target 100% — spend the error budget.

**References:** Google SRE Book (chapters on SLOs & Error Budgets), Google SRE Workbook, The Tail at Scale (Dean & Barroso), Designing Data-Intensive Applications (ch.1)

---
*System Design Handbook — topic 03.*
