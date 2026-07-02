# 28 · Observability: Logs, Metrics, Traces & SLOs

> **In one line:** Instrument systems so you can answer *new* questions about *why* they're misbehaving — without shipping new code — and define, in numbers, what "healthy enough" means.

---

## 1. Overview

**Monitoring** tells you *whether* a system is healthy against pre-defined checks ("is CPU > 90%?"). **Observability** is the stronger property: can you understand the *internal state* of a system from its external outputs well enough to answer questions you didn't anticipate when you built it? In a monolith you attach a debugger. In a distributed system of 200 microservices, a single user request touches 30 of them, and the failure is some emergent interaction you never imagined — you can't debug it, you can only *observe* it through the telemetry you emitted.

Observability rests on three pillars: **logs** (discrete events — what happened), **metrics** (aggregated numbers over time — how much/how fast), and **traces** (the causal path of one request across services — where the time went). Each answers a different question; you need all three. On top of them sit **SLIs/SLOs/error budgets** — the language for defining and negotiating reliability, and **alerting** — turning telemetry into human action.

Why it exists: distributed systems fail in ways no single machine's view can explain. A 500 ms p99 regression might be one slow database shard, a retry storm, a GC pause on one pod, or a bad deploy in a dependency three hops away. Without correlated telemetry, you're guessing; with it, you follow the evidence.

The foundational texts are Google's *SRE Book* (SLIs/SLOs/error budgets, alerting philosophy) and the *OpenTelemetry* project, which standardized how telemetry is generated and shipped so you're not locked to one vendor. The goal isn't dashboards — it's **reducing time-to-detect and time-to-diagnose** when things break.

## 2. Core Concepts

- **The three pillars** — **logs** (events), **metrics** (aggregates), **traces** (request paths). Complementary, not redundant: metrics tell you *something* is wrong, traces tell you *where*, logs tell you *why*.
- **Structured logging** — logs as key-value JSON (not free text) so they're queryable and correlatable, carrying `trace_id`, `user_id`, `request_id`.
- **Metrics & cardinality** — numeric time series with labels. **Cardinality** (the number of unique label combinations) is the cost driver and the #1 way to blow up a metrics system.
- **RED & USE methods** — what to measure: **RED** (Rate, Errors, Duration) for request-driven services; **USE** (Utilization, Saturation, Errors) for resources.
- **Distributed tracing** — a **trace** is a tree of **spans**; each span is one unit of work with a start/end and attributes. **Context propagation** carries the trace ID across service hops.
- **Sampling** — keeping only a fraction of traces/logs to control cost; **head** (decide at start) vs. **tail** (decide after seeing the whole trace, e.g., keep all errors).
- **OpenTelemetry (OTel)** — the vendor-neutral standard for generating and exporting all three signals; decouples instrumentation from backend.
- **SLI / SLO / SLA** — a **Service Level Indicator** (a measured ratio, e.g., % of requests < 300 ms), a **Service Level Objective** (the target, e.g., 99.9%), a **Service Level Agreement** (the contract with penalties).
- **Error budget** — `1 − SLO`. The permissible amount of unreliability; spend it on feature velocity, run out and you freeze changes.
- **Symptom-based alerting** — alert on user-visible symptoms (latency, error rate) not internal causes (CPU high), to reduce noise and false pages.

## 3. Architecture

Telemetry flows from instrumented services through a **collection/agent layer** into specialized backends (one per signal type), all correlated by a shared **trace/request ID**. OpenTelemetry standardizes the emit-and-export half so backends are swappable.

```svg
<svg viewBox="0 0 770 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a5" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="385" y="20" text-anchor="middle" fill="#64748b">Telemetry pipeline — three signals, one correlation id</text>

  <rect x="30" y="120" width="140" height="100" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="100" y="150" text-anchor="middle" fill="#1e293b">Services</text>
  <text x="100" y="170" text-anchor="middle" fill="#64748b">OTel SDK</text>
  <text x="100" y="188" text-anchor="middle" fill="#64748b">logs·metrics</text>
  <text x="100" y="204" text-anchor="middle" fill="#64748b">·traces</text>

  <rect x="240" y="120" width="150" height="100" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="315" y="160" text-anchor="middle" fill="#1e293b">OTel Collector</text>
  <text x="315" y="180" text-anchor="middle" fill="#64748b">batch · sample</text>
  <text x="315" y="198" text-anchor="middle" fill="#64748b">· enrich</text>

  <rect x="470" y="55" width="270" height="55" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="605" y="80" text-anchor="middle" fill="#1e293b">Metrics TSDB (Prometheus)</text>
  <text x="605" y="98" text-anchor="middle" fill="#64748b">dashboards · RED/USE</text>

  <rect x="470" y="140" width="270" height="55" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="605" y="165" text-anchor="middle" fill="#1e293b">Trace store (Jaeger/Tempo)</text>
  <text x="605" y="183" text-anchor="middle" fill="#64748b">waterfall · span tree</text>

  <rect x="470" y="225" width="270" height="55" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="605" y="250" text-anchor="middle" fill="#1e293b">Log store (Loki/ELK)</text>
  <text x="605" y="268" text-anchor="middle" fill="#64748b">search · correlate by trace_id</text>

  <line x1="170" y1="170" x2="238" y2="170" stroke="#475569" marker-end="url(#a5)"/>
  <line x1="390" y1="150" x2="468" y2="90" stroke="#475569" marker-end="url(#a5)"/>
  <line x1="390" y1="170" x2="468" y2="168" stroke="#475569" marker-end="url(#a5)"/>
  <line x1="390" y1="190" x2="468" y2="250" stroke="#475569" marker-end="url(#a5)"/>

  <rect x="240" y="285" width="500" height="40" rx="8" fill="#fff" stroke="#cbd5e1"/>
  <text x="490" y="310" text-anchor="middle" fill="#1e293b">trace_id ties a log line ↔ a span ↔ a metric exemplar → jump between signals</text>
</svg>
```

The power is **correlation**: a metric alert fires (error rate up) → you pivot to the traces for those errors → one span shows a slow DB call → you jump to the logs for that `trace_id` and see the exact query and error. The shared `trace_id` stitched through all three is what turns three separate tools into one investigative flow. OTel's job is to make instrumentation uniform so this works across polyglot services.

## 4. How It Works

Trace a request through the system to see how a trace is assembled and how the signals interlock.

```text
1. Request hits the edge → gateway generates a TRACE ID (or accepts an inbound one).
   trace_id = 4bf92f...   span_id = a1  (root span "GET /checkout")

2. Gateway calls service A, PROPAGATING context in headers:
   traceparent: 00-4bf92f...-a1-01     (W3C Trace Context standard)
   → A creates a CHILD span (parent=a1, span_id=b2)

3. A calls B and the DB, each a child span (c3, d4) under b2.
   Each span records: start, end (⇒ duration), status, attributes
   (http.status, db.statement, error=true), and events.

4. Every service also:
   - increments METRICS: request_count{route,status}, latency histogram (RED)
   - writes STRUCTURED LOGS carrying trace_id + span_id for correlation

5. Spans are exported (async, batched) to the Collector → trace backend,
   which reassembles the tree by parent/child ids into a waterfall.

6. Sampling decides what to keep: head (coin-flip at root) or
   tail (keep the trace if ANY span errored or was slow).

7. SLI is computed from the metrics: good_requests / total_requests.
   Error budget burn is tracked; alerts fire on symptom SLOs.
```

The linchpin is **context propagation** (step 2). Each service must extract the incoming trace context, create its child span, and inject the context into every outbound call — otherwise the trace breaks into disconnected fragments and you lose the causal chain. The **W3C Trace Context** (`traceparent`/`tracestate` headers) standardizes this so a Java service and a Go service participate in the same trace. Auto-instrumentation libraries (OTel) do this propagation for you at the HTTP/gRPC/DB client layer.

## 5. Key Components / Deep Dive

### Pillar 1 — Structured logs
Logs are the highest-fidelity, highest-cost signal: one entry per event, with full context. Emit them as **structured JSON** (`{"level":"error","trace_id":"...","user_id":123,"latency_ms":812,"msg":"db timeout"}`) so they're queryable and joinable, not grep-only free text. Always include correlation IDs (`trace_id`, `request_id`). Use **levels** deliberately (DEBUG/INFO/WARN/ERROR) and **sample** high-volume logs (you don't need every 200-OK access log at 1 M QPS). Logs answer *"what exactly happened to this one request?"* — but at scale they're the most expensive pillar to store and search, so metrics/traces should carry the routine load and logs the deep detail.

### Pillar 2 — Metrics, RED & USE
Metrics are cheap, aggregated numeric time series — pre-aggregated at write, so they answer "how many/how fast?" over millions of events for near-zero query cost. Two prescriptive frameworks:
- **RED** (for every request-serving service): **Rate** (requests/s), **Errors** (failed/s or %), **Duration** (latency distribution). These three tell you the user-visible health of any service.
- **USE** (for every resource — CPU, disk, pool, queue): **Utilization** (% busy), **Saturation** (queued/waiting work), **Errors**. USE finds the *bottleneck*; RED finds the *symptom*.
Record **latency as histograms**, not averages — the mean hides the tail, and users feel p99/p999. Metric types: counters (monotonic), gauges (point-in-time), histograms/summaries (distributions).

### Cardinality — the metrics landmine
A metric's cost is roughly `series = ∏(unique values of each label)`. Adding a high-cardinality label — `user_id`, `request_id`, raw URL with IDs, `email` — can explode one metric into millions of time series and OOM your TSDB. Rule: **labels must be bounded and low-cardinality** (route template `/user/{id}` not `/user/12345`, status class `2xx` not every code). Put high-cardinality context in **traces/logs** (which are keyed by trace_id, not aggregated), never in metric labels. Cardinality is the single most common way teams break their observability bill and their Prometheus.

### Pillar 3 — Distributed tracing
A **trace** is the DAG of **spans** for one request; each span is `{trace_id, span_id, parent_id, name, start, duration, attributes, status}`. Rendered as a **waterfall**, a trace shows exactly where the time and errors went across service hops — the only signal that reveals *cross-service causality*. Requires **context propagation** (W3C Trace Context) at every hop. The killer use cases: finding the slow hop in a 30-service request, spotting an N+1 fan-out, and seeing that a "slow service" is actually slow because *its* dependency is slow.

### Sampling — head vs. tail
You can't afford to store every trace at high QPS. **Head-based sampling** decides at the root (e.g., keep 1%): cheap and simple, but you'll usually miss the rare error trace you most wanted. **Tail-based sampling** buffers all spans of a trace and decides after it completes — keep 100% of traces that errored or exceeded a latency threshold, sample the boring successful ones. Tail sampling gives you the traces that matter but needs a stateful collector that holds spans until the trace finishes. A common policy: keep all errors + all slow traces + 1% of the rest.

### OpenTelemetry
**OTel** is the CNCF standard that decouples *instrumentation* from *backend*: one set of SDKs/auto-instrumentation and a wire protocol (OTLP), so you emit once and ship to any backend (Prometheus, Jaeger, Datadog, Grafana) without re-instrumenting. It unifies all three signals under shared context and semantic conventions (standard attribute names like `http.method`). The **OTel Collector** is a pipeline you run to receive, batch, sample, enrich, and export telemetry — the seam that keeps you vendor-neutral.

### SLI / SLO / error budgets
- **SLI** — a measured quality ratio: `good events / valid events` (e.g., proportion of requests served < 300 ms, or non-5xx). Define "good" precisely.
- **SLO** — the target for an SLI over a window (e.g., 99.9% over 28 days). Set it from *user needs*, not "as high as possible" — every nine costs exponentially more.
- **Error budget** = `1 − SLO`. 99.9% ⇒ 0.1% ⇒ ~43 min/month of allowed badness. It's a *budget to spend*: while budget remains, ship features fast; when it's exhausted, freeze risky changes and focus on reliability. This aligns dev velocity and reliability with a shared number instead of politics.
- **Burn rate** — how fast you're consuming the budget. Alert on *fast burn* (e.g., 2% of monthly budget in 1 hour) — actionable and urgent — rather than on every threshold blip.

## 6. Trade-offs

| Signal / choice | Pros | Cons |
|---|---|---|
| **Logs** | Highest detail, full context, flexible | Most expensive to store/search; noisy; hard to aggregate |
| **Metrics** | Cheap, fast queries, great for alerts/dashboards | No per-request detail; cardinality limits labels |
| **Traces** | Cross-service causality, finds the slow hop | Needs propagation everywhere; sampling loses data; storage cost |
| **Head sampling** | Simple, cheap, low overhead | Misses rare errors — the traces you most need |
| **Tail sampling** | Keeps errors/slow traces | Stateful, complex collector, buffers all spans |
| **High SLO (99.99%)** | Great UX, strong guarantee | Exponentially costly; slows feature velocity |
| **Symptom alerts** | Low noise, user-focused, actionable | May miss slow-burn internal causes |
| **Cause alerts** | Early warning of resource issues | Noisy, many false pages, alert fatigue |

The master trade-off is **fidelity vs. cost**: you cannot store everything about everything. Metrics give cheap breadth (always-on, aggregated), traces give sampled depth (causality when you need it), logs give expensive detail (the last mile of *why*). A mature setup uses each for what it's cheapest at and correlates them by trace_id — not three copies of the same data.

## 7. When to Use / When to Avoid

**Invest heavily in observability when:**
- You run distributed/microservice systems where failures are emergent and cross-service.
- You have SLA/SLO obligations and need to measure and defend them.
- Incident MTTR matters (revenue-critical, user-facing systems).
- You deploy frequently and need fast feedback on regressions.

**Scale back / be selective when:**
- A simple monolith or low-traffic internal tool — basic logs + a few metrics may suffice; full tracing is overkill.
- Cost is dominated by telemetry you never query — prune unused metrics/logs and sample aggressively.
- You're tempted to trace/log *everything* — that's a cost and cardinality disaster; instrument deliberately.
- Early-stage prototypes where the system changes faster than you can instrument it meaningfully.

## 8. Scaling & Production Best Practices

- **Standardize on OpenTelemetry** so instrumentation is uniform and vendor-neutral; run an OTel Collector as the central pipeline for batching, sampling, and enrichment.
- **Propagate trace context everywhere** (W3C Trace Context) — including across queues (put trace_id in message headers) so async flows stay traceable.
- **Guard cardinality ruthlessly.** Bound label values; never put IDs/emails/raw URLs in metric labels. Put high-cardinality context in traces/logs. Alert on time-series growth.
- **Latency as histograms, alert on percentiles** (p99/p999), never averages — the mean lies about tail experience.
- **Structured JSON logs with trace_id**; sample high-volume logs; keep errors at 100%.
- **Tail-sample traces:** keep all errors + slow traces + a small % baseline. Head sampling for cost, tail for signal.
- **Define SLOs from user needs** and track error-budget burn; use **multi-window multi-burn-rate** alerts (fast-burn = page, slow-burn = ticket) per the SRE workbook.
- **Alert on symptoms, page on actionable ones.** Every page should be urgent, actionable, and about user impact; route cause-signals to dashboards/tickets, not pagers.
- **Keep telemetry off the critical path** — export async and batched; a slow telemetry backend must never slow user requests.
- **Retention tiers:** short hot retention for detail, downsampled/rolled-up long-term metrics for trends.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| **Cardinality explosion** | TSDB OOM, query slowness, huge bill | Bound labels; move IDs to traces/logs; enforce limits in Collector |
| **Broken trace context** | Fragmented traces, lost causality | Standard propagation (W3C); auto-instrumentation; propagate over queues |
| **Alert fatigue** | Real pages ignored, slow response | Symptom/SLO-based alerts; multi-burn-rate; delete noisy alerts |
| **Head sampling drops errors** | Can't debug the incident you care about | Tail sampling: keep all errors + slow traces |
| **Telemetry on critical path** | Observability outage slows/kills the app | Async, batched export; local buffering; fail-open |
| **Averages hide the tail** | p99 pain invisible; false "healthy" | Histograms + percentile alerts |
| **Unstructured logs** | Can't query/correlate during incident | Structured JSON + trace_id; enforce a schema |
| **Telemetry backend overload** | Blind during the very incident it caused | Rate-limit/sample at Collector; capacity headroom; separate from prod |

## 10. Monitoring & Metrics

*(What to actually watch — the meta-metrics of a healthy service.)*
- **RED per service:** request Rate, Error rate (and 5xx %), Duration histogram (p50/p90/p99/p999).
- **USE per resource:** Utilization, Saturation (queue depth, pool waits), Errors for CPU, memory, disk, connection pools, thread pools.
- **SLI compliance & error-budget burn rate** — the top-line reliability number and how fast you're spending headroom.
- **Latency percentiles**, always — the tail (p99/p999) is the user experience that mean/median hide.
- **Saturation leading indicators** — queue depth, GC pause time, connection-pool wait — they rise *before* errors do.
- **Dependency health** — downstream latency/error rates surfaced via traces (a service is often "slow" because its dependency is).
- **Telemetry pipeline health** — dropped spans/metrics, Collector queue, export latency; cardinality/series count growth.
- **Alert quality metrics** — page volume, false-positive rate, MTTA/MTTR — observe your observability.

## 11. Common Mistakes

1. ⚠️ **High-cardinality metric labels** (`user_id`, request_id, raw URLs) — explodes series count and OOMs the TSDB.
2. ⚠️ **Alerting on averages** instead of percentiles — the mean hides the p99 tail users actually feel.
3. ⚠️ **Alerting on causes, not symptoms** — "CPU 90%" pages that don't correlate with user pain cause alert fatigue.
4. ⚠️ **Unstructured, free-text logs** — impossible to query or correlate at 3 a.m. during an incident.
5. ⚠️ **Missing trace-context propagation** (especially across queues) — traces fragment and causality is lost.
6. ⚠️ **Head sampling only** — you throw away the rare error trace you most needed to debug.
7. ⚠️ **No trace_id in logs** — the three pillars can't be correlated; you investigate blind.
8. ⚠️ **Setting SLOs at 100% / "as high as possible"** — leaves no error budget, makes every blip a crisis, and costs exponentially.

## 12. Interview Questions

**Q: What's the difference between monitoring and observability?**
A: Monitoring checks known conditions you defined in advance ("is error rate > 1%?"). Observability is the property that you can answer *new, unanticipated* questions about internal state from external outputs — crucial in distributed systems where failures are emergent and you couldn't have pre-defined the check. Monitoring is a subset; observability is what lets you debug the unknown-unknown.

**Q: Explain the three pillars and why you need all three.**
A: Metrics (cheap aggregates) tell you *something* is wrong and are great for alerts/dashboards but have no per-request detail. Traces show *where* across services the time/error went via the span tree and context propagation. Logs give the full *why* of a single event at highest cost. They're complementary — metrics detect, traces localize, logs explain — and correlated by a shared trace_id.

**Q: What is cardinality and why is it dangerous?**
A: Cardinality is the number of unique label-value combinations for a metric; storage cost scales with the product of label cardinalities. A high-cardinality label like user_id or request_id can turn one metric into millions of time series and OOM the TSDB or explode the bill. Keep metric labels bounded/low-cardinality; push high-cardinality context into traces and logs.

**Q: RED vs. USE — when do you use each?**
A: RED (Rate, Errors, Duration) measures request-serving services from the user's perspective — the symptom. USE (Utilization, Saturation, Errors) measures resources (CPU, disk, pools) to find the bottleneck — the cause. RED tells you the service is slow; USE tells you it's slow because the connection pool is saturated.

**Q: How does a distributed trace get assembled across services?**
A: The entry point creates a root span with a trace_id; each service extracts the incoming trace context from request headers (W3C Trace Context `traceparent`), creates a child span with a parent pointer, and injects the context into outbound calls. Spans export asynchronously to a backend that reassembles the tree by parent/child IDs into a waterfall. Propagation at every hop is the requirement.

**Q (senior): Head vs. tail sampling — trade-offs, and what policy would you run?**
A: Head sampling decides at the root (e.g., keep 1%) — cheap and stateless but statistically drops the rare error/slow traces you most want. Tail sampling buffers all spans and decides after the trace completes, so you can keep 100% of errored/slow traces plus a small baseline — at the cost of a stateful collector holding spans in memory. I'd run tail sampling: keep all errors, all traces over a latency threshold, and ~1% of the rest.

**Q (senior): How do you set an SLO, and what does the error budget buy you?**
A: Derive the SLI from what users actually need (e.g., % of requests < 300 ms and non-5xx), then set the SLO target from acceptable user experience, not "as high as possible" — each nine costs exponentially more. The error budget (1 − SLO) is a currency: while it's unspent you ship features aggressively; when it's exhausted you freeze risky changes and invest in reliability. It replaces reliability-vs-velocity politics with a shared number.

**Q (senior): Why alert on symptoms rather than causes, and how do you avoid both alert fatigue and missed incidents?**
A: Cause alerts (CPU high, memory 80%) fire constantly without correlating to user pain — fatigue that gets real pages ignored. Symptom alerts (SLO burn, error rate, latency) are user-focused and actionable. To avoid missing slow-burn issues, use multi-window multi-burn-rate alerting: a fast-burn (2% budget in 1 h) pages urgently, a slow-burn (10% in 3 days) opens a ticket. Every page should be urgent, actionable, and about user impact.

**Q (senior): A user reports checkout is slow but every service's dashboard looks green. How do you find the problem?**
A: Dashboards show aggregates and per-service health; a cross-service or tail issue hides in them. Pull the actual slow *traces* for checkout (tail-sampled, filtered by high latency) and read the waterfall to find the slow hop — often a dependency N hops deep, an N+1 fan-out, or a single slow shard. Then jump to that span's logs via trace_id for the exact query/error. This is precisely why traces exist: aggregates say "healthy," the trace shows the outlier path.

**Q (senior): Your Prometheus just OOM'd. Most likely cause and fix?**
A: Cardinality explosion — someone added a high-cardinality label (user_id, request path with IDs, email) that multiplied series into the millions. Fix by identifying the offending metric (series count by name), removing/bounding the label (use route templates and status classes), enforcing cardinality limits at the Collector/relabel stage, and moving that high-cardinality context to traces/logs where it belongs.

**Q (senior): How do you keep telemetry from becoming a reliability risk itself?**
A: Keep it off the critical path — export asynchronously and batched, buffer locally, and fail-open so a slow/down telemetry backend never blocks user requests. Rate-limit and sample at the Collector so a traffic spike doesn't overwhelm the pipeline (and blind you during the very incident it caused). Run the observability stack with its own capacity headroom, separate from production, and monitor the monitors (dropped spans, export latency).

## 13. Alternatives & Related

- **Resilience Patterns** — you tune timeouts, retries, and circuit breakers from the latency/error telemetry observability provides.
- **Rate Limiting** — 429/throttle rates are core reliability SLIs surfaced through metrics.
- **Capacity Estimation** — USE-method saturation metrics drive capacity planning.
- **Load Balancing** — health checks and outlier detection consume the same signals.
- **Message Queues** — trace context must ride in message headers to trace async flows.
- **Chaos Engineering / SRE practice** — observability is the prerequisite for safely injecting and learning from failure.

## 14. Cheat Sheet

> [!TIP]
> **Observability in one screen.**
> - **Three pillars:** metrics (detect, cheap) → traces (localize, causality) → logs (explain, costly). Correlate by **trace_id**.
> - **Measure:** **RED** (Rate/Errors/Duration) for services · **USE** (Utilization/Saturation/Errors) for resources.
> - **Latency = histograms, alert on p99/p999.** Never averages.
> - **Cardinality:** metric labels must be bounded/low-cardinality. IDs/emails/URLs go in traces & logs, never labels.
> - **Tracing:** trace = tree of spans; needs **W3C context propagation** at every hop, incl. queues. **Tail-sample** (keep all errors + slow).
> - **Standard:** OpenTelemetry (OTLP + Collector) = emit once, ship anywhere.
> - **SLO:** SLI = good/valid; SLO = target from user needs; **error budget = 1 − SLO** to spend on velocity. Alert on **burn rate**.
> - **Alert on symptoms, page only on actionable user impact.** Keep telemetry off the critical path.

**References:** Google SRE Book & SRE Workbook (SLOs, error budgets, alerting on burn rate) · OpenTelemetry documentation · Prometheus docs (metrics & cardinality) · "Distributed Systems Observability" (Cindy Sridharan) · Brendan Gregg — USE Method

---
*System Design Handbook — topic 28.*
