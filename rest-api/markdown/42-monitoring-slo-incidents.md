# 42 · Monitoring, SLOs & Incident Response

> **In one line:** Pick a small number of user-facing indicators, set a target you are willing to be held to, spend the resulting error budget deliberately, alert only when that budget is burning fast enough to matter — and when it does, run the incident with a named commander and write a blameless postmortem.

---

## 1. Overview

Most API monitoring fails in one of two directions. Either there is almost nothing — a CPU graph and a ping check — so outages are discovered by customers on social media. Or there is far too much: 400 alerts wired to a pager, most of them symptoms of symptoms, so the on-call engineer learns to ignore the pager and the one alert that mattered is lost in the noise. **Alert fatigue is not a minor annoyance; it is the mechanism by which a well-instrumented system becomes an unmonitored one.**

Service Level Objectives fix this by inverting the question. Instead of "what can we measure?", ask "**what does the user need, and how often are we allowed to fail them?**" A **Service Level Indicator (SLI)** is a measurement of user-visible behaviour — the proportion of requests that succeed within 300 ms. A **Service Level Objective (SLO)** is a target for that indicator over a window — 99.9% over 28 days. The **error budget** is the leftover: 0.1% of requests, which over 28 days at 10,000 rps is about 24 million requests you are permitted to fail. That budget is not a shameful allowance; it is a *resource*. Having spare budget is permission to ship risky changes fast. Having exhausted it is a signal to stop shipping features and fix reliability. It converts an argument about feelings into an arithmetic one.

This framing came out of Google SRE practice and was popularised by the 2016 *Site Reliability Engineering* book and its 2018 workbook, then refined by the industry into **multiwindow, multi-burn-rate alerting** — the current best practice for turning an SLO into pages that are both fast and rare. Alongside it, the incident-response discipline (Incident Command System, borrowed from emergency services) supplies the human protocol: a single **Incident Commander** who coordinates but does not debug, explicit roles, a running timeline, regular stakeholder communication, and a blameless postmortem afterwards whose purpose is to change the system, not to find the person.

The critical judgement call is **choosing the right target**. 100% is always the wrong SLO — it is unachievable, and pursuing it costs exponentially more for each additional nine while the user often cannot perceive the difference. If a customer reaches your API over a mobile network with 99.5% reliability, the difference between your 99.99% and your 99.999% is invisible to them and enormously expensive to you. The right target is slightly better than the point at which users start to complain or leave, and it is a business decision that product and engineering make together.

A concrete example: a payments API sets `availability = proportion of POST /v1/charges returning non-5xx` with a 99.95% target over 28 days, and `latency = proportion of those served in under 500 ms` at 99%. In week two, a bad deploy burns 40% of the monthly availability budget in twenty minutes. A fast-burn alert pages within two minutes, the rollout is aborted, and the postmortem produces a canary analysis rule that would have caught it. Because the budget is tracked, the team can see they still have 60% left and keep shipping — no panic, no freeze, no meeting. That is the whole point: SLOs make reliability decisions boring and quantitative.

---

## 2. Core Concepts

- **SLI (Service Level Indicator)** — a measured proportion of good events over valid events, expressed from the user's perspective; e.g. successful requests ÷ total requests.
- **SLO (Service Level Objective)** — an internal target for an SLI over a rolling window, e.g. 99.9% over 28 days.
- **SLA (Service Level Agreement)** — a contractual promise to customers with financial consequences; always set looser than the internal SLO so you have room to react.
- **Error budget** — `(1 − SLO) × total events`; the quantity of failure you are permitted before the objective is missed.
- **Burn rate** — how fast the budget is being consumed relative to a steady spend of exactly 1× over the window; burn rate 14.4 exhausts a 30-day budget in about 50 hours.
- **Availability SLI** — proportion of requests that did not fail; usually excludes `4xx` because those are client errors.
- **Latency SLI** — proportion of requests faster than a threshold, which is more robust and more meaningful than tracking a raw percentile.
- **Symptom vs cause alerting** — page on what the user experiences (errors, latency), not on the internal condition that caused it (CPU, disk, pod restarts).
- **Multiwindow multi-burn-rate alerting** — pairing a long and a short window per burn-rate threshold so alerts fire fast on severe burns, slowly on mild ones, and reset promptly.
- **Toil** — manual, repetitive, automatable operational work that scales with traffic; the thing SRE practice exists to reduce.
- **Incident Commander (IC)** — the single person who owns coordination, decisions, and communication during an incident, and who does not debug.
- **MTTD / MTTA / MTTR** — mean time to detect, acknowledge, and restore; restoration is the metric that matters to users, not root-cause identification.
- **Blameless postmortem** — a written analysis focused on systemic contributing factors and concrete action items, written on the assumption that everyone acted reasonably given what they knew.

---

## 3. Theory & Principles

**The error budget as a control system.** Define the SLI as a ratio of good events to valid events:

```
SLI = good_events / valid_events
error_budget_fraction = 1 - SLO
budget_consumed(t) = (bad_events in window) / (valid_events in window × (1 - SLO))
```

At 99.9% over 28 days, allowed downtime is `28 × 24 × 60 × 0.001 ≈ 40.3` minutes, or 0.1% of requests. The nines table worth memorising:

| SLO | Allowed bad time per 28 days | Per day |
|---|---|---|
| 99% | 6 h 43 m | 14 m 24 s |
| 99.5% | 3 h 22 m | 7 m 12 s |
| 99.9% | 40 m 19 s | 1 m 26 s |
| 99.95% | 20 m 10 s | 43 s |
| 99.99% | 4 m 2 s | 8.6 s |
| 99.999% | 24 s | 0.86 s |

The control loop: budget remaining is healthy → ship features aggressively, run chaos experiments, take deploy risk. Budget exhausted → feature work pauses, reliability work takes priority, until the rolling window recovers. The policy must be agreed **in advance**, in writing, with product — negotiating it mid-incident is how SLOs become decoration.

**Why "proportion faster than a threshold" beats "the p99".** A latency SLI of "99% of requests under 300 ms" is superior to "p99 < 300 ms" for three reasons. It composes arithmetically across services and time windows (percentiles do not). It is directly interpretable as a count of unhappy users. And it degrades gracefully — a brief spike moves the ratio slightly rather than making the percentile jump discontinuously. Critically, always compute request-based ratios from **summed histogram buckets**, never by averaging per-pod percentiles, which is mathematically meaningless.

**Burn-rate alerting arithmetic.** A naive alert — "error rate above 1% for 5 minutes" — is either too sensitive (pages on a blip) or too slow (misses a slow bleed that exhausts the month). Burn rate solves both. Burn rate is the multiple of the *steady* consumption rate:

```
burn_rate = observed_error_ratio / (1 - SLO)
time_to_exhaustion = window_length / burn_rate
```

With a 99.9% SLO over 30 days: a 14.4× burn exhausts the whole budget in `30 days / 14.4 ≈ 50 hours`, and consumes 2% of the budget in **1 hour**. The canonical Google SRE configuration is three tiers:

| Burn rate | Long window | Short window | Budget consumed before firing | Action |
|---|---|---|---|---|
| 14.4× | 1 h | 5 m | 2% | **Page** immediately |
| 6× | 6 h | 30 m | 5% | **Page** |
| 1× | 3 d | 6 h | 10% | **Ticket**, not a page |

The **short window** is what makes these usable: the alert fires only if *both* the long and short windows exceed the threshold, so a burn that has already stopped does not keep paging, and recovery is detected within minutes rather than hours. Without the short window, a 1-hour-window alert stays firing for an hour after the incident is over.

**Symptom-based alerting.** The rule from the SRE book: **page a human only for symptoms that are user-visible, urgent, actionable, and not already being handled automatically.** High CPU is not user-visible. A pod restart is not user-visible. A replica lag of 4 seconds may or may not be. "3% of `POST /v1/charges` are failing" is unambiguously user-visible. Cause-based signals still belong on dashboards and in tickets — they are how you *diagnose* — but they must not page, because each cause-based page is a false positive waiting to happen and the aggregate is alert fatigue.

**What to exclude from the SLI.** Getting the denominator right is most of the work. Exclude `4xx` responses that reflect client error (a `404` or `422` means your API worked). Exclude health-check and synthetic traffic, which dilutes the ratio. Decide explicitly about `429` — if you are rate-limiting a legitimate customer because *you* are overloaded, that is your failure; if it is quota enforcement working as designed, it is not. And be careful with `499`/client-cancelled requests, which often indicate *your* slowness manifesting as user abandonment.

```svg
<svg viewBox="0 0 760 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="380" fill="#f8fafc"/>
  <text x="380" y="26" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">Error budget burn: same SLO, three very different alert responses</text>
  <line x1="70" y1="230" x2="710" y2="230" stroke="#1e293b" stroke-width="2"/>
  <line x1="70" y1="230" x2="70" y2="56" stroke="#1e293b" stroke-width="2"/>
  <text x="390" y="256" text-anchor="middle" font-size="12" fill="#1e293b">time across the 30-day window</text>
  <text x="34" y="150" font-size="12" fill="#1e293b" transform="rotate(-90 34 150)">budget left</text>
  <text x="76" y="52" font-size="10" fill="#1e293b">100%</text>
  <text x="80" y="226" font-size="10" fill="#1e293b">0%</text>
  <line x1="70" y1="60" x2="710" y2="230" stroke="#16a34a" stroke-width="2.5"/>
  <text x="560" y="176" font-size="11" fill="#16a34a">1&#215; burn: exactly on budget, no alert</text>
  <line x1="70" y1="60" x2="180" y2="230" stroke="#d97706" stroke-width="2.5"/>
  <text x="188" y="140" font-size="11" fill="#d97706">6&#215; burn &#8594; page (6 h / 30 m windows)</text>
  <line x1="70" y1="60" x2="116" y2="230" stroke="#dc2626" stroke-width="3"/>
  <text x="124" y="88" font-size="11" fill="#dc2626">14.4&#215; burn &#8594; page in minutes (1 h / 5 m windows)</text>
  <line x1="70" y1="60" x2="710" y2="128" stroke="#4f46e5" stroke-width="2" stroke-dasharray="5"/>
  <text x="470" y="118" font-size="11" fill="#4f46e5">0.4&#215; slow bleed &#8594; ticket, never a page</text>
  <rect x="70" y="278" width="640" height="90" rx="8" fill="#ffffff" stroke="#94a3b8" stroke-width="2"/>
  <text x="84" y="300" font-size="12" font-weight="bold" fill="#1e293b">burn_rate = observed_error_ratio / (1 &#8722; SLO)      time_to_exhaustion = window / burn_rate</text>
  <text x="84" y="322" font-size="11" fill="#1e293b">SLO 99.9% &#8594; budget 0.1%.  Observed 1.44% errors &#8594; burn 14.4&#215; &#8594; 30-day budget gone in ~50 h, 2% gone in 1 h.</text>
  <text x="84" y="342" font-size="11" fill="#1e293b">Pair every long window with a SHORT one (1 h + 5 m): fires fast, and stops firing fast once the burn ends.</text>
  <text x="84" y="362" font-size="11" fill="#dc2626">Page only on user-visible symptoms. CPU, pod restarts, and queue depth are diagnosis, not pages.</text>
</svg>
```

---

## 4. Architecture & Workflow

The lifecycle of one incident, from the SLI definition that detects it to the postmortem action item that prevents it.

1. **Define the SLI.** For `POST /v1/charges`: good = response status not in `5xx` **and** served in under 500 ms; valid = all authenticated, non-synthetic requests to that route. Written down, with the exclusions explicit, in a version-controlled SLO document.
2. **Set the SLO and budget policy.** 99.95% availability over 28 days. Budget = 0.05% of requests ≈ 20 minutes of total failure. Policy, agreed with product in advance: below 25% budget remaining, no non-reliability deploys without director approval; below 0% remaining, a full feature freeze until the window recovers.
3. **Instrument.** The service emits `http_server_requests_total{route,status}` and `http_server_request_duration_seconds_bucket{route,le}`, both with a `version` label so canary and stable are separable. Recording rules precompute the good/valid ratios at 5 m, 30 m, 1 h, 6 h, 1 d, and 3 d, because computing them at alert time is slow and fragile.
4. **Configure burn-rate alerts.** Three tiers as above: 14.4× (1 h / 5 m) → page, 6× (6 h / 30 m) → page, 1× (3 d / 6 h) → ticket. Each alert's annotation contains the SLO name, the current budget remaining, a dashboard link, and a runbook link. An alert without a runbook link is an incomplete alert.
5. **Detection.** At 14:03 a deploy ships a bad query plan. Latency on `POST /v1/charges` jumps; the latency SLI collapses to 91%. Burn rate hits 60×. The 14.4× alert fires at 14:05 — MTTD of two minutes.
6. **Page and acknowledge.** PagerDuty routes to the primary on-call. Acknowledged at 14:06. The engineer opens the alert, which links to the SLO dashboard already scoped to the right route and time window.
7. **Declare and staff.** The engineer declares a **SEV-2** in a dedicated incident channel, which auto-creates a video bridge and a timeline document. They take the role of **Incident Commander**, then hand it off as more people join so they can go back to debugging. Roles: IC (coordinates, decides, does not debug), Ops lead (hands on keyboard), Communications lead (stakeholders and status page), Scribe (timeline).
8. **Mitigate before diagnosing.** The first question is never "why?" but "what recent change can we undo?" A deploy at 14:01 is the obvious suspect; the rollout is aborted and traffic returns to the previous version at 14:11. The latency SLI recovers by 14:13. **Time to restore: 10 minutes.** Root cause is still unknown, and that is correct — restoration first, diagnosis second.
9. **Communicate on a cadence.** The status page is updated within 10 minutes of declaring, then every 30 minutes, in customer language: what is affected, what the impact is, what is being done, when the next update comes. Silence is what turns an incident into a reputational event.
10. **Verify and close.** The SLI is confirmed recovered over a sustained window, the alert resolves (the short window makes this quick), and the incident is downgraded then closed. Total budget consumed: 38% of the 28-day availability budget.
11. **Postmortem within 48 hours.** Blameless, with a timeline, an impact quantification (requests failed, customers affected, budget consumed), contributing factors (not "a root cause" — there are always several), what went well, and where luck was involved. Action items are specific, assigned, and dated; a postmortem whose actions are "be more careful" has failed.
12. **Feed it back.** The action items in this case: add p99 latency to the canary analysis template (it would have aborted the rollout automatically at 5% traffic), add a query-plan regression test, and reduce the deploy's bake time exposure. Each becomes a ticket, tracked to completion — the loop is only closed when the change ships.

```svg
<svg viewBox="0 0 800 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="800" height="400" fill="#ffffff"/>
  <text x="400" y="24" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">Incident timeline and roles: restore first, diagnose second</text>
  <line x1="40" y1="76" x2="760" y2="76" stroke="#1e293b" stroke-width="2"/>
  <circle cx="80" cy="76" r="6" fill="#4f46e5"/>
  <text x="80" y="60" text-anchor="middle" font-size="10" fill="#1e293b">14:01</text>
  <text x="80" y="98" text-anchor="middle" font-size="10" fill="#1e293b">deploy</text>
  <circle cx="200" cy="76" r="6" fill="#dc2626"/>
  <text x="200" y="60" text-anchor="middle" font-size="10" fill="#1e293b">14:03</text>
  <text x="200" y="98" text-anchor="middle" font-size="10" fill="#1e293b">SLI drops</text>
  <circle cx="320" cy="76" r="6" fill="#dc2626"/>
  <text x="320" y="60" text-anchor="middle" font-size="10" fill="#1e293b">14:05</text>
  <text x="320" y="98" text-anchor="middle" font-size="10" fill="#1e293b">page (MTTD 2m)</text>
  <circle cx="420" cy="76" r="6" fill="#d97706"/>
  <text x="420" y="60" text-anchor="middle" font-size="10" fill="#1e293b">14:06</text>
  <text x="420" y="98" text-anchor="middle" font-size="10" fill="#1e293b">ack, declare SEV-2</text>
  <circle cx="530" cy="76" r="6" fill="#d97706"/>
  <text x="530" y="60" text-anchor="middle" font-size="10" fill="#1e293b">14:09</text>
  <text x="530" y="98" text-anchor="middle" font-size="10" fill="#1e293b">status page</text>
  <circle cx="640" cy="76" r="6" fill="#16a34a"/>
  <text x="640" y="60" text-anchor="middle" font-size="10" fill="#1e293b">14:11</text>
  <text x="640" y="98" text-anchor="middle" font-size="10" fill="#1e293b">rollback</text>
  <circle cx="740" cy="76" r="6" fill="#16a34a"/>
  <text x="740" y="60" text-anchor="middle" font-size="10" fill="#1e293b">14:13</text>
  <text x="740" y="98" text-anchor="middle" font-size="10" fill="#1e293b">recovered</text>
  <text x="400" y="126" text-anchor="middle" font-size="12" font-weight="bold" fill="#16a34a">Time to restore: 10 minutes. Root cause identified the next day.</text>
  <rect x="30" y="148" width="180" height="106" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="120" y="172" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">Incident Commander</text>
  <text x="42" y="194" font-size="10" fill="#1e293b">owns decisions + priorities</text>
  <text x="42" y="212" font-size="10" fill="#1e293b">assigns roles, tracks state</text>
  <text x="42" y="230" font-size="10" fill="#1e293b">runs the bridge</text>
  <text x="42" y="248" font-size="10" fill="#dc2626">does NOT debug</text>
  <rect x="222" y="148" width="180" height="106" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="312" y="172" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">Ops lead</text>
  <text x="234" y="194" font-size="10" fill="#1e293b">hands on keyboard</text>
  <text x="234" y="212" font-size="10" fill="#1e293b">proposes mitigations</text>
  <text x="234" y="230" font-size="10" fill="#1e293b">executes after IC approval</text>
  <text x="234" y="248" font-size="10" fill="#1e293b">announces every change</text>
  <rect x="414" y="148" width="180" height="106" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="504" y="172" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">Comms lead</text>
  <text x="426" y="194" font-size="10" fill="#1e293b">status page in 10 min</text>
  <text x="426" y="212" font-size="10" fill="#1e293b">updates every 30 min</text>
  <text x="426" y="230" font-size="10" fill="#1e293b">customer language only</text>
  <text x="426" y="248" font-size="10" fill="#1e293b">shields responders</text>
  <rect x="606" y="148" width="164" height="106" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="688" y="172" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">Scribe</text>
  <text x="618" y="194" font-size="10" fill="#1e293b">timestamped timeline</text>
  <text x="618" y="212" font-size="10" fill="#1e293b">decisions + who made them</text>
  <text x="618" y="230" font-size="10" fill="#1e293b">graphs and evidence</text>
  <text x="618" y="248" font-size="10" fill="#1e293b">seeds the postmortem</text>
  <rect x="30" y="272" width="740" height="112" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="44" y="296" font-size="12" font-weight="bold" fill="#1e293b">Mitigation order of operations</text>
  <text x="44" y="318" font-size="11" fill="#1e293b">1. What changed in the last hour?  Roll back or disable the flag &#8212; do not wait for a root cause.</text>
  <text x="44" y="337" font-size="11" fill="#1e293b">2. Shed load or fail over if rollback is not available; degrade the feature rather than the whole API.</text>
  <text x="44" y="356" font-size="11" fill="#1e293b">3. Only once the SLI is recovering, start diagnosing. Restoration and understanding are different jobs.</text>
  <text x="44" y="376" font-size="11" fill="#dc2626">Anti-pattern: an hour of collaborative debugging while users keep failing and nobody has tried the rollback.</text>
</svg>
```

---

## 5. Implementation

### SLI recording rules and burn-rate alerts (Prometheus)

```yaml
groups:
  - name: charges-sli
    interval: 30s
    rules:
      # Availability SLI: non-5xx over all valid requests. 4xx and probes excluded.
      - record: sli:charges_availability:ratio_rate5m
        expr: |
          sum(rate(http_server_requests_total{route="/v1/charges",status!~"5..",synthetic="false"}[5m]))
            /
          sum(rate(http_server_requests_total{route="/v1/charges",synthetic="false"}[5m]))

      # Latency SLI: proportion served under 500 ms — a ratio, not a percentile.
      - record: sli:charges_latency:ratio_rate5m
        expr: |
          sum(rate(http_server_request_duration_seconds_bucket{route="/v1/charges",le="0.5"}[5m]))
            /
          sum(rate(http_server_request_duration_seconds_count{route="/v1/charges"}[5m]))

      - record: sli:charges_availability:ratio_rate1h
        expr: |
          sum(rate(http_server_requests_total{route="/v1/charges",status!~"5..",synthetic="false"}[1h]))
            /
          sum(rate(http_server_requests_total{route="/v1/charges",synthetic="false"}[1h]))
      - record: sli:charges_availability:ratio_rate6h
        expr: |
          sum(rate(http_server_requests_total{route="/v1/charges",status!~"5..",synthetic="false"}[6h]))
            /
          sum(rate(http_server_requests_total{route="/v1/charges",synthetic="false"}[6h]))

  - name: charges-burn
    rules:
      - alert: ChargesErrorBudgetFastBurn
        # 14.4x burn against a 99.95% SLO: 2% of the 28-day budget in one hour.
        expr: |
          (1 - sli:charges_availability:ratio_rate1h) > (14.4 * 0.0005)
          and
          (1 - sli:charges_availability:ratio_rate5m) > (14.4 * 0.0005)
        for: 2m
        labels: { severity: page, slo: charges-availability }
        annotations:
          summary: "POST /v1/charges burning error budget at {{ $value | humanizePercentage }} (14.4x)"
          budget_remaining: "https://grafana.example.com/d/slo/charges?var-window=28d"
          runbook: "https://runbooks.example.com/charges-availability"

      - alert: ChargesErrorBudgetSlowBurn
        expr: |
          (1 - sli:charges_availability:ratio_rate6h) > (6 * 0.0005)
          and
          (1 - sli:charges_availability:ratio_rate30m) > (6 * 0.0005)
        for: 15m
        labels: { severity: page, slo: charges-availability }
        annotations:
          runbook: "https://runbooks.example.com/charges-availability"

      - alert: ChargesErrorBudgetTrickle
        expr: |
          (1 - sli:charges_availability:ratio_rate3d) > (1 * 0.0005)
          and
          (1 - sli:charges_availability:ratio_rate6h) > (1 * 0.0005)
        for: 1h
        labels: { severity: ticket, slo: charges-availability }   # NOT a page
```

Budget remaining, as a single number for the dashboard and the deploy policy:

```promql
1 - (
  (1 - sli:charges_availability:ratio_rate28d) / 0.0005
)
```

### Health and degradation surfaces the API itself exposes

```python
from fastapi import FastAPI, Response
import os, time

app = FastAPI()
START = time.time()

@app.get("/livez")
async def livez():
    return {"status": "ok"}

@app.get("/readyz")
async def readyz(response: Response):
    checks = {
        "db":       await ping(db, timeout=0.2),
        "cache":    await ping(cache, timeout=0.1),
        "payments": breaker_state("payments") != "open",
    }
    # Cache being down is degraded, not unready. DB being down is unready.
    ready = checks["db"]
    response.status_code = 200 if ready else 503
    return {"status": "ok" if all(checks.values()) else "degraded",
            "checks": checks,
            "version": os.environ["APP_VERSION"],
            "commit": os.environ["GIT_SHA"],
            "uptime_s": round(time.time() - START)}
```

When you must shed load, be honest about it and tell the client when to come back — this is what keeps a degradation from becoming a retry storm:

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/problem+json
Retry-After: 30
X-Request-Id: 01J8Z2K7QF3MB4X9VN7A0S2C6D

{
  "type": "https://errors.example.com/overloaded",
  "title": "Service temporarily overloaded",
  "status": 503,
  "detail": "We are shedding load to protect the payments pipeline. Retry after 30 seconds with exponential backoff.",
  "instance": "/v1/charges"
}
```

### An SLO defined as code, reviewable in a pull request

```yaml
apiVersion: openslo/v1
kind: SLO
metadata:
  name: charges-availability
  displayName: POST /v1/charges availability
spec:
  service: payments-api
  description: >
    Proportion of authenticated, non-synthetic POST /v1/charges requests that do not
    return 5xx. 4xx are excluded: they indicate client error, not service failure.
    429 is INCLUDED as bad when caused by our own capacity, excluded when quota enforcement.
  indicator:
    metadata: { name: charges-availability-ratio }
    spec:
      ratioMetric:
        good:  { metricSource: { type: Prometheus, spec: { query: 'sum(rate(http_server_requests_total{route="/v1/charges",status!~"5..",synthetic="false"}[5m]))' } } }
        total: { metricSource: { type: Prometheus, spec: { query: 'sum(rate(http_server_requests_total{route="/v1/charges",synthetic="false"}[5m]))' } } }
  timeWindow:
    - duration: 28d
      isRolling: true
  budgetingMethod: Occurrences
  objectives:
    - displayName: 99.95% availability
      target: 0.9995
  alertPolicies: [charges-fast-burn, charges-slow-burn]
```

### A runbook that is actually usable at 3 a.m.

```markdown
# Runbook: charges-availability budget burn

## Is this real?
1. Open the SLO dashboard (link in the alert). Confirm the drop is on `POST /v1/charges`, not all routes.
2. Slice by `version` — if only the canary is affected, abort the rollout: `kubectl argo rollouts abort payments-api`.
3. Slice by `region` and `client_id` — a single large client can move the ratio without a real outage.

## Mitigations, in order
1. **Recent deploy?** `kubectl argo rollouts undo payments-api` (restores in ~40 s). Do this before diagnosing.
2. **Recent flag change?** Disable in the flag console; effect within 10 s.
3. **Upstream PSP failing?** Check the `payments` circuit-breaker state; if open, enable queued-capture mode
   (`FEATURE_QUEUE_CAPTURES=true`) so charges are accepted with `202` and settled asynchronously.
4. **Database saturation?** Check pool wait time and active connections; shed with `MAX_CONCURRENCY=200`
   which returns `503` + `Retry-After` rather than queueing.

## Escalate
- Page the payments-platform secondary if not mitigated in 15 minutes.
- Page the PSP vendor contact (see contacts doc) if their status page is green but our success rate is not.

## Do not
- Do not restart the fleet "to see if it helps" — it destroys the evidence and drops in-flight charges.
- Do not raise the rate limit to "let traffic through" during a saturation incident.
```

**Optimization note.** Alerting infrastructure has its own performance characteristics that bite at exactly the wrong moment. Precompute SLIs with **recording rules** — evaluating a six-hour `rate()` over high-cardinality series at alert time is slow and can time out precisely when the system is under stress, silently disabling your alerting. Keep the alerting path independent of the system it watches (do not run Prometheus on the cluster it is the only monitor for, and have an external synthetic prober as a dead-man's switch). Add a **heartbeat alert** that fires if a canary alert *stops* being evaluated, because a silent monitoring failure is worse than a noisy one. And measure your alerts like code: track pages per on-call shift (a healthy target is fewer than two per shift, with a hard ceiling around five), actionability rate, and the fraction of incidents detected by monitoring rather than by customers — that last number is the honest score for your entire observability investment.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| SLO-based alerting | Pages only when users are measurably affected; drastically fewer alerts | Requires good SLIs and clean metrics; a poorly chosen SLI hides real pain |
| Error budgets | Turns "should we ship?" into arithmetic; aligns product and engineering | Needs an agreed, enforced policy — an unenforced budget is decoration |
| Multiwindow burn-rate alerts | Fast on severe burns, quiet on trivia, resets promptly | More complex to configure and explain; needs recording rules to be efficient |
| Symptom-based alerting | High signal, low fatigue, survives architecture changes | Slightly slower detection than a leading cause indicator; needs good runbooks to diagnose |
| Ratio-based latency SLI | Composes across services and windows; directly interpretable | Loses distribution shape — keep percentile dashboards alongside for diagnosis |
| Named IC and roles | Removes coordination chaos; one decision-maker; clear communication | Overhead for small incidents; requires training and rehearsal to work under stress |
| Blameless postmortems | Surfaces real systemic causes; people report near-misses instead of hiding them | Time-consuming; degenerates into ritual if action items are never completed |
| Status page transparency | Builds trust; reduces support load enormously during an incident | Public admission of failure; requires discipline and pre-approved language |
| Tight SLOs (more nines) | Better experience for latency-sensitive customers | Cost grows roughly exponentially per nine; slows delivery; often imperceptible to users |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Setting the SLO to 100%, or to whatever the current measurement happens to be.** Both are meaningless — one is unachievable, the other is circular. → ✅ Set it slightly above the level at which users complain or churn, decide it jointly with product, and revisit quarterly with data.
2. ⚠️ **Alerting on causes instead of symptoms.** CPU, memory, pod restarts, and queue depth page at 3 a.m. for conditions the user never noticed. → ✅ Page on user-visible SLI burn; keep cause metrics on dashboards and in tickets for diagnosis.
3. ⚠️ **Counting `4xx` as SLI failures.** One client with a bad integration loop tanks your availability number and pages you for their bug. → ✅ Exclude client errors from the numerator's failures; track `4xx` separately as a client-health signal, broken out by API key.
4. ⚠️ **A single long alert window.** A 1-hour-window alert takes an hour to fire and an hour to clear, so you get paged late and stay paged after recovery. → ✅ Multiwindow: pair each long window with a short one so the alert both fires and resolves quickly.
5. ⚠️ **Alerts with no runbook.** The on-call receives "HighErrorRate" at 3 a.m. and starts from zero. → ✅ Every paging alert links to a runbook containing "is this real", mitigations in order, escalation, and explicit do-nots. Make the link a required field.
6. ⚠️ **Debugging before mitigating.** An hour of collaborative root-cause analysis while users keep failing and nobody tried the rollback. → ✅ Restore first: undo the recent change, flip the flag, shed load. Diagnosis is a separate job that happens after the SLI recovers.
7. ⚠️ **No Incident Commander, or an IC who is also debugging.** Five people investigate the same thing, nobody talks to customers, and two conflicting mitigations are applied simultaneously. → ✅ Declare an IC immediately; the IC coordinates and decides and does not touch a keyboard. Hand off explicitly when tired.
8. ⚠️ **Silence towards customers.** Support is overwhelmed, trust evaporates, and the incident becomes a reputational event larger than the technical one. → ✅ Status page within 10 minutes, updates every 30 minutes even when the update is "still investigating", written in customer impact terms, not internal jargon.
9. ⚠️ **Postmortems that name a person, or produce "be more careful".** People hide near-misses and nothing changes. → ✅ Blameless framing, multiple contributing factors, and specific, assigned, dated action items tracked to completion — with a review of completion rate each quarter.
10. ⚠️ **An error budget policy nobody enforces.** The budget is exhausted, everyone shrugs, and feature work continues. → ✅ Agree the policy in advance with product leadership, automate the check in the deploy pipeline, and make exceptions visible and approved rather than silent.
11. ⚠️ **Measuring MTTR as time to root cause.** You optimise for understanding rather than for the user's experience. → ✅ Measure time to *restore* service; root cause can and often should come later.
12. ⚠️ **Monitoring that depends on the monitored system.** The cluster goes down and takes your alerting with it. → ✅ Run monitoring out-of-band, add an external synthetic prober, and use a dead-man's-switch heartbeat so an absence of signal pages you.
13. ⚠️ **Too many SLOs.** Forty SLOs across twelve services means nobody knows which one matters. → ✅ Two or three per user-facing journey — typically availability and latency — plus a freshness or correctness SLI only where it genuinely applies.
14. ⚠️ **Ignoring "no data" as a state.** A total outage that stops all traffic makes the error *ratio* undefined, and the alert never fires. → ✅ Alert on absence of traffic too (`absent()` or a minimum-rate condition), and keep a synthetic prober generating a floor of requests.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** During an incident, the fastest path is a fixed sequence: confirm the symptom on the SLI dashboard, then **slice** — by version (is it only the canary?), by route (is it one endpoint or all?), by region and availability zone (is one zone bad?), by client or tenant (is one customer's traffic responsible?), and by dependency. Each slice either implicates or exonerates a whole class of cause in seconds. Then pivot from the metric spike to an **exemplar trace** and from the trace to that request's logs, which is why chapter 38's correlation work is a prerequisite for effective incident response. Keep a deploy/config-change annotation stream overlaid on every SLI chart; "what changed" answers a large majority of incidents, and having it on the same graph removes a ten-minute detour. Finally, invest in **synthetic probes** from outside your network for the top three user journeys — they detect DNS, certificate, CDN, and edge failures that internal metrics cannot see, and they keep producing signal when real traffic drops to zero.

**Monitoring.** Beyond SLIs, the dashboard that matters during an incident has four rows: RED per route, saturation (in-flight requests, connection-pool utilisation, queue depth, CPU throttling), dependency health (per-upstream error and latency, circuit-breaker state, retry rate), and change events (deploys, flag flips, config pushes, infrastructure changes). Saturation deserves special attention because it *leads* latency — pool wait time rising is minutes of warning before the SLI moves. Monitor the monitoring: alert-rule evaluation failures, scrape failures, notification-delivery failures to the pager, and a heartbeat that fires on silence. And track the meta-metrics of on-call health — pages per shift, after-hours pages, actionability, and the percentage of incidents detected by monitoring versus by customers. A team that is paged nine times a night is not more reliable than one paged twice; it is closer to burnout and to missing the real page.

**Security.** Security incidents run on the same incident framework but with different reflexes: preserve evidence before mitigating where possible (snapshot rather than restart, because restarting destroys memory forensics), restrict the incident channel because the details are sensitive, involve legal and privacy early because disclosure obligations have statutory clocks (GDPR's 72-hour notification, for example), and be careful that status-page language does not disclose an exploitable detail before a fix is deployed. On the monitoring side, alert on authentication anomalies — spikes in `401`/`403`, credential-stuffing patterns, sudden changes in per-key traffic shape, access from new geographies for privileged tokens — and treat an unexplained drop in traffic as suspicious rather than good news. Protect the alerting and runbook systems themselves: runbooks contain operational detail an attacker would value, and a pager integration with a webhook that anyone can post to is a social-engineering vector.

**Performance & scaling.** SLO practice scales through **hierarchy and ownership**: each service team owns its own SLOs, and user-journey SLOs are composed from them, with the recognition that a journey depending on five services at 99.9% is roughly 99.5% end to end unless there is redundancy or graceful degradation. Use the same arithmetic to decide where reliability investment should go — the weakest dependency dominates. As alert volume grows, invest in routing and grouping (by service and by SLO, with inhibition rules so a dependency's page suppresses its dependents' pages) rather than in more alerts. Automate the toil that repeat incidents create: if the runbook says "run these three commands", that is a script; if it says "scale up when queue depth exceeds X", that is an autoscaler. And rehearse — **game days** and chaos experiments run against staging or a small production slice are the only reliable way to discover that your rollback needs a credential nobody has, or that the runbook references a dashboard deleted six months ago.

---

## 9. Interview Questions

**Q: What is the difference between an SLI, an SLO, and an SLA?**
A: An SLI is a measurement of user-visible behaviour, usually a ratio of good events to valid events, such as the proportion of requests served without a `5xx`. An SLO is an internal target for that indicator over a window, such as 99.9% over 28 days. An SLA is a contractual commitment to customers with financial penalties, and it should always be looser than the internal SLO so you have room to notice and react before you owe anyone money.

**Q: What is an error budget and why is it useful?**
A: It is the amount of failure the SLO permits: `(1 − SLO) × total events`. It is useful because it converts reliability from a matter of opinion into a shared quantity that product and engineering can both reason about — spare budget is permission to ship risky changes fast, and an exhausted budget is an agreed trigger to pause feature work and invest in reliability. The value comes entirely from the policy being agreed in advance and actually enforced.

**Q: Why alert on burn rate rather than on a raw error-rate threshold?**
A: A fixed threshold is simultaneously too sensitive to short spikes and too insensitive to slow bleeds that quietly exhaust the month. Burn rate normalises the observed error ratio by the budget, so the alert directly answers "how quickly are we heading for an SLO miss". Multiple burn-rate tiers then let a severe burn page in minutes while a mild one only opens a ticket.

**Q: What does a multiwindow, multi-burn-rate alert look like in practice?**
A: Three tiers against a 30-day window: 14.4× burn evaluated over 1 hour and 5 minutes (fires after 2% of budget is consumed, pages), 6× over 6 hours and 30 minutes (5% consumed, pages), and 1× over 3 days and 6 hours (10% consumed, opens a ticket rather than paging). The short window in each pair is required for both fast firing and prompt resolution — without it the alert lingers long after recovery.

**Q: Should a latency SLI be "p99 under 300 ms" or "99% of requests under 300 ms"?**
A: The ratio form — 99% of requests under 300 ms. It composes correctly across services and time windows, it is directly interpretable as a count of unhappy users, and it degrades smoothly rather than jumping discontinuously. Percentiles remain valuable on dashboards for diagnosis, but they do not average or add, which makes them a poor basis for an objective.

**Q: What should never page a human?**
A: Anything that is not simultaneously user-visible, urgent, actionable, and not already being handled automatically. High CPU, a single pod restart, a transient queue spike, and disk at 70% all fail that test. They belong on dashboards and in tickets; paging on them trains the on-call to ignore the pager, which is how the one alert that mattered gets missed.

**Q: Walk me through the first ten minutes of an API incident.**
A: Acknowledge the page and confirm the symptom on the SLI dashboard. Declare an incident with a severity and open a dedicated channel. Take or assign the Incident Commander role, and assign an ops lead and a comms lead. Ask "what changed in the last hour" and mitigate — roll back the deploy, flip the flag, shed load — before attempting to understand the root cause. Post to the status page within ten minutes, and keep the scribe's timeline running from the start.

**Q: (Senior) Your API has a 99.9% SLO, has consumed 90% of its budget in week two, and product wants to launch a major feature on Friday. What do you do?**
A: Present the arithmetic rather than an opinion: 90% consumed with two weeks to go means one more moderate incident misses the objective, and the pre-agreed policy says feature deploys pause below the threshold. Then look for options rather than just saying no — is the remaining risk reducible by shipping behind a flag at 1%, is the launch separable into a dark deploy now and a release after the window rolls, is the budget consumption itself caused by a known and fixable issue that could be fixed first? Escalate the exception explicitly to whoever owns the policy if the business genuinely wants to spend the budget; the point of the framework is that spending it is a *decision*, made visibly, not an accident.

**Q: (Senior) Design the SLOs for a payments API used by both a mobile app and batch partner integrations.**
A: Separate the SLIs by journey because the two user populations have different needs. For the interactive path, availability on `POST /v1/charges` (non-`5xx`, excluding client `4xx`) at 99.95% over 28 days, plus latency as "99% under 500 ms" — mobile users abandon quickly. For the batch path, availability at the same level but latency measured as a freshness or throughput SLI (batches settle within 15 minutes) because a partner's cron job does not care about 500 ms. Add a correctness SLI for money movement — reconciliation mismatches per million transactions — since a `200` with the wrong amount is far worse than a `500`, and no availability metric catches it. Define exclusions precisely (synthetics, quota `429`s), version-control the definitions, and set the SLA looser than every SLO.

**Q: (Senior) How do you compose SLOs across a dependency chain?**
A: Multiplicatively, unless there is redundancy or graceful degradation. A journey that synchronously depends on five services each at 99.9% is about 99.5% end to end, which is over three hours a month — so the journey's SLO cannot be tighter than what its dependencies mathematically permit. The practical uses are to identify the weakest link (which dominates and is where investment pays), to justify removing synchronous hops or making them optional with fallbacks, and to negotiate explicit internal objectives with dependency owners rather than assuming their reliability. Where a dependency is optional and the journey degrades gracefully, it drops out of the multiplication entirely, which is usually the cheapest way to raise a journey's SLO.

**Q: What makes a postmortem blameless, and why does it matter?**
A: Blameless means it assumes everyone acted reasonably given the information and incentives they had, and it therefore asks what about the *system* — tooling, alerting, defaults, documentation, review process — allowed a reasonable action to cause harm. It matters because the alternative produces silence: people stop reporting near-misses, stop volunteering that they were the one who ran the command, and the organisation loses exactly the information it needs. The output that proves it worked is a set of specific, assigned, dated action items that actually get completed.

**Q: What is toil, and why does SRE practice care about it?**
A: Toil is manual, repetitive, automatable operational work that scales linearly with traffic and produces no lasting value — restarting a service on a schedule, hand-editing configs, running the same three commands from a runbook. It matters because it consumes the capacity that would otherwise go into making the system more reliable, and because it grows with the system, so an unmanaged toil load eventually consumes the whole team. The standard guardrail is a cap (often 50% of time) with the remainder protected for engineering work, and a rule that any runbook step performed more than a few times becomes a script or an automated response.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** An **SLI** is good events ÷ valid events measured from the user's side; an **SLO** is a target for it over a rolling window; the **error budget** is `1 − SLO`, and it is a resource to spend deliberately, governed by a policy agreed in advance. Exclude `4xx` and synthetic traffic from the SLI. Prefer a **ratio** latency SLI ("99% under 300 ms") over a raw percentile, and compute it from summed histogram buckets. Alert on **burn rate** with **multiwindow** pairs: 14.4× (1 h/5 m) page, 6× (6 h/30 m) page, 1× (3 d/6 h) ticket. Page only on user-visible symptoms, and never without a runbook link. In an incident: acknowledge, declare, name an **Incident Commander** who does not debug, assign ops and comms leads, **mitigate before diagnosing** (roll back, flip the flag, shed load), status page in 10 minutes and every 30 after, then a **blameless postmortem** within 48 hours with specific, assigned, dated actions. Measure time to **restore**, not time to root cause, and watch pages per shift as the health metric for your alerting.

| SLO | Bad time / 28 d | Bad time / day |
|---|---|---|
| 99% | 6 h 43 m | 14 m 24 s |
| 99.9% | 40 m 19 s | 1 m 26 s |
| 99.95% | 20 m 10 s | 43 s |
| 99.99% | 4 m 2 s | 8.6 s |

| Burn rate | Windows | Budget spent | Action |
|---|---|---|---|
| 14.4× | 1 h + 5 m | 2% | Page |
| 6× | 6 h + 30 m | 5% | Page |
| 1× | 3 d + 6 h | 10% | Ticket |

| Incident role | Owns | Must not |
|---|---|---|
| Incident Commander | Decisions, priorities, roles | Debug |
| Ops lead | Executing mitigations | Act without announcing |
| Comms lead | Status page, stakeholders | Use internal jargon |
| Scribe | Timeline, decisions | Editorialise |

Flash cards:
- **What is the error budget?** → `(1 − SLO) × total events` — the failure you are permitted, and a resource to spend on shipping risk.
- **Why multiwindow burn-rate alerts?** → The long window gives significance, the short window gives fast firing *and* fast resolution.
- **What should page a human?** → Only user-visible, urgent, actionable symptoms that are not already handled automatically.
- **First move in an incident?** → Mitigate — roll back or flip the flag. Diagnosis comes after the SLI recovers.
- **Which metric actually matters, MTTR or time-to-root-cause?** → Time to restore service; users do not care why, they care that it works.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Define an availability and a latency SLI for one endpoint as Prometheus recording rules, being explicit about which statuses and traffic you exclude and why.
- [ ] Implement the three-tier multiwindow burn-rate alerts, then inject a 5% error rate with a load generator and verify the 14.4× alert fires within minutes and clears within minutes of the injection stopping.
- [ ] Compute your service's current 28-day budget consumption, then work out how many minutes of total outage you have left this window.
- [ ] Write a runbook for your noisiest alert with "is this real", ordered mitigations, escalation, and do-nots — then have a colleague who has never seen the service follow it.
- [ ] Run a game day: inject a failure in staging, run a full incident with IC, ops, comms, and scribe roles, and time your MTTD and time-to-restore.

**Mini Project — Reliability practice for "Halcyon Payments".**
*Goal:* Take a service from "we have some dashboards" to a working SLO-and-incident practice.
*Requirements:* Two SLIs (availability and latency-ratio) defined as code with explicit exclusions and reviewed in a PR; recording rules at 5 m, 30 m, 1 h, 6 h, and 3 d; three-tier multiwindow burn-rate alerts with runbook links; a Grafana SLO dashboard showing budget remaining, burn rate, and slices by version, route, region, and client; an external synthetic prober plus a dead-man's-switch heartbeat alert; `/livez` and `/readyz` with a documented distinction between degraded and unready; a load-shedding path returning `503` + `Retry-After` with a problem document; a written error-budget policy and an automated pipeline check that blocks non-reliability deploys when the budget is exhausted; an incident-response doc defining severities, roles, and the communication cadence; a runbook per paging alert.
*Extension ideas:* Run a game day and publish a real blameless postmortem with dated action items, then track completion; compose a user-journey SLO from three service SLOs and show which dependency dominates; add a correctness SLI (reconciliation mismatches per million) and demonstrate it catching a `200`-but-wrong regression; instrument and chart pages-per-shift and incidents-detected-by-monitoring over a quarter.

---

## 12. Related Topics & Free Learning Resources

Sibling chapters: **API Observability: Logs, Metrics & Tracing** (the telemetry every SLI is computed from), **Deploying APIs: CI/CD, Blue-Green & Canary** (error budgets gating deploys, canary analysis aborting bad rollouts), **APIs in Microservices Architectures** (composing SLOs across dependencies and surviving partial failure), **API Gateways & the BFF Pattern** (edge SLIs and load shedding), and **Rate Limiting & Throttling** (`429` semantics and whether they count against your budget).

**Free Learning Resources**
- **Google SRE Book — Service Level Objectives** — Google · *Intermediate* · the foundational chapter on SLIs, SLOs, and error budgets, including how to choose targets. <https://sre.google/sre-book/service-level-objectives/>
- **Google SRE Workbook — Alerting on SLOs** — Google · *Advanced* · the definitive treatment of multiwindow, multi-burn-rate alerting with worked numbers. <https://sre.google/workbook/alerting-on-slos/>
- **Google SRE Book — Managing Incidents & Postmortem Culture** — Google · *Intermediate* · incident command roles, the blameless postmortem, and why the culture part is load-bearing. <https://sre.google/sre-book/managing-incidents/>
- **Google SRE Book — Being On-Call** — Google · *Intermediate* · sustainable rotations, page-load targets, and the operational-versus-engineering-time balance. <https://sre.google/sre-book/being-on-call/>
- **OpenSLO Specification** — OpenSLO · *Intermediate* · a vendor-neutral YAML format for defining SLOs as reviewable, version-controlled code. <https://github.com/OpenSLO/OpenSLO>
- **Prometheus — Alerting Rules & Best Practices** — Prometheus · *Intermediate* · recording rules, alert semantics, and the official guidance on what should and should not page. <https://prometheus.io/docs/practices/alerting/>
- **PagerDuty Incident Response Documentation** — PagerDuty · *Beginner→Intermediate* · a free, complete, battle-tested playbook covering roles, severities, comms, and postmortems. <https://response.pagerduty.com/>
- **Implementing Health Checks** — Amazon Builders' Library · *Intermediate* · why naive health checks cause outages, and how deep versus shallow checks should differ. <https://aws.amazon.com/builders-library/implementing-health-checks/>

---

*REST API Handbook — chapter 42.*
