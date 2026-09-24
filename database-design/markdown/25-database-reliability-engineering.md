# 25 · Database Reliability Engineering: SLOs, Chaos & Runbooks

> **In one line:** Database reliability engineering applies SRE to the data layer — define what "reliable" means for the database with SLIs and SLOs (latency, availability, freshness, durability), spend an error budget to decide when risky database changes may ship, prove failover and recovery by deliberately breaking things, and turn every incident into runbooks, automation and less toil.

---

## 1. Overview

Ask a team how reliable their database is and you'll typically hear "it's on RDS Multi-AZ" or "we have Patroni with two replicas". Those are *mechanisms*, not outcomes. Nobody has measured how long a failover actually takes end to end, including the minute the application spends reconnecting to a stale DNS entry. Nobody knows whether last night's backup restores. Nobody decided how much replica staleness users will tolerate. And when someone wants to run a migration that rewrites a 400 GB table during business hours, there is no principled way to say yes or no — it becomes a debate between the person who wants to ship and the person who remembers the last outage.

The naive approach — buy HA features and hope — fails because databases fail in ways HA features don't cover. Automatic failover protects against a dead primary, not against a migration that locks a hot table, a replication slot that fills the disk, a bad parameter change, a runaway query, or a restore that turns out to be missing WAL segments. Most database downtime in practice comes from **changes** (migrations, upgrades, config, deploys) and **slow-burn neglect** (bloat, wraparound, disk growth), not hardware death. Reliability therefore has to be engineered into how you measure, change and operate the database, not just how you deploy it.

**Database Reliability Engineering (DBRE)** is that discipline. It takes the core SRE toolkit — service level indicators and objectives, error budgets, blameless postmortems, toil reduction — and specializes it for stateful systems, where the stakes are different: a stateless service that fails can be restarted; a database that loses committed data cannot be un-lost. This chapter covers SLIs/SLOs/SLAs for databases, error budgets as a gate on risky changes, availability math, failover and chaos testing, game days, capacity reviews, runbooks (with a complete sample), change management, postmortems, and toil.

> **Builds on:** [System Design · Observability](../system-design/topic.html?p=28-observability) (general SLI/SLO/error-budget concepts and burn-rate alerting — not repeated) · [Ch 18 · High Availability](topic.html?p=18-high-availability) (failover mechanics, fencing, RPO/RTO) · [Ch 24 · Database Monitoring](topic.html?p=24-database-monitoring) (the metrics SLIs are built from) · [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery) (restore testing) · [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution) (lock-safe migrations). This chapter is the operating model that ties them together.

> **Why this matters:** Senior interviews increasingly ask "how would you run this in production?" A candidate who can define a freshness SLO for a replica, explain how an error budget gates a major-version upgrade, and describe a failover drill with measured RTO is demonstrating exactly the judgment the role needs.

## 2. Core Concepts

- **SLI (service level indicator)** — a measured ratio of good events to valid events, e.g. "fraction of DB queries from the checkout service completing in < 50 ms". *Why it matters:* reliability must be measured the way users experience it, not as "the instance is up".
- **SLO (service level objective)** — a target for an SLI over a window, e.g. 99.9% over 28 days. *Why it matters:* it's the explicit line between "reliable enough" and "needs work".
- **SLA (service level agreement)** — a contractual promise, usually with financial penalties. *Why it matters:* SLAs should be looser than internal SLOs so you get warning before a breach costs money.
- **Error budget** — `1 − SLO`, the allowed unreliability in the window. *Why it matters:* turns "is this risky change OK?" into a quantitative decision.
- **Freshness SLI** — the fraction of time (or of reads) where a replica or derived store is within a staleness bound. *Why it matters:* replicas can be "up" while serving data too old to be correct.
- **Durability SLI** — evidence that committed data is recoverable: WAL archived within X seconds, backups restorable, verified restores within the target time. *Why it matters:* durability failures are silent until you need a restore.
- **RPO / RTO** — maximum acceptable data loss and time to restore service. *Why it matters:* they're the SLOs of disaster scenarios, and they must be tested, not assumed ([Ch 18](topic.html?p=18-high-availability)).
- **Failover drill** — a planned, controlled switchover or failover to verify RTO, RPO and client behaviour. *Why it matters:* an untested failover path is a hypothesis.
- **Chaos experiment** — deliberately injecting a failure (kill, partition, full disk, slow I/O) with a hypothesis and abort criteria. *Why it matters:* finds weaknesses on your schedule instead of the incident's.
- **Game day** — a scheduled, team-wide exercise running one or more experiments with defined roles. *Why it matters:* tests people, runbooks and tools, not just software.
- **Runbook** — a step-by-step procedure for a specific alert or operation. *Why it matters:* reduces diagnosis time and errors at 3 a.m.
- **Toil** — manual, repetitive, automatable operational work that scales with the system. *Why it matters:* DB teams drown in it (vacuum babysitting, user grants, slot cleanup) unless they deliberately automate.
- **Blameless postmortem** — a written analysis of an incident focused on system causes and fixes. *Why it matters:* people hide information when blamed; systems improve only when causes are visible.

## 3. Theory & Principles

### SLIs for a database

A database serves several kinds of promise, and each needs its own indicator. Measure SLIs from the **client's perspective** where possible (the application's DB client), because server-side metrics miss pool waits, network and failover reconnect time.

| SLI | Good event | Measured from | Example SLO |
|---|---|---|---|
| **Availability** | Query/transaction succeeded (excluding client errors like constraint violations) | App DB client error counters by SQLSTATE; synthetic probe (write + read every 10 s) | 99.95% of transactions succeed, 28 days |
| **Latency** | Query completed under threshold | App DB client histograms | 99% of checkout DB calls < 50 ms; 99.9% < 250 ms |
| **Freshness** | Replica lag under bound | `pg_stat_replication` replay lag sampled every 10 s | Replica lag < 5 s for 99.9% of samples |
| **Durability** | WAL segment archived within bound; daily restore test passed | `pg_stat_archiver`, archive lag, restore job results | WAL archived within 60 s 99.99% of time; 100% of weekly restore tests pass |
| **Correctness (optional)** | Consistency checks pass | Reconciliation jobs (e.g. ledger sums) | 0 unreconciled differences |

Two design notes. First, **choose the valid-event denominator carefully**: a unique-violation error is the application's fault, not the database's, and a request cancelled by the client shouldn't count against the DB. Second, **probes complement real traffic**: at 3 a.m. there may be too little traffic to detect an outage from ratios, so a synthetic probe that writes a heartbeat row on the primary and reads it on each replica measures availability and freshness continuously. The heartbeat write also gives replicas something to replay, making timestamp-based lag meaningful even when the application is idle.

### Availability math

Nines translate into time, and the numbers are sobering:

| SLO | Allowed downtime per 30 days | Per year |
|---|---|---|
| 99% | ~7.2 hours | ~3.65 days |
| 99.9% | ~43 minutes | ~8.8 hours |
| 99.95% | ~22 minutes | ~4.4 hours |
| 99.99% | ~4.3 minutes | ~53 minutes |
| 99.999% | ~26 seconds | ~5.3 minutes |

**Serial dependencies multiply.** If a request needs the app (99.95%), PgBouncer (99.99%) and the database (99.95%), end-to-end availability is at best `0.9995 × 0.9999 × 0.9995 ≈ 99.89%`. A database SLO must be tighter than the product's SLO, because the product composes it with everything else.

**Redundancy helps less than the formula says.** Two independent replicas at 99.9% each give `1 − 0.001² = 99.9999%` in theory — but failures are correlated (same AZ, same bad config, same bug, same migration), and the switch between them isn't instant. For a primary with automatic failover, a better model is: downtime ≈ (number of failovers per period) × (end-to-end failover time) + (downtime from changes and incidents that failover doesn't cover). Twelve failovers a year at 60 seconds each is 12 minutes — within 99.99% — but one bad migration that locks the orders table for 25 minutes blows the entire annual 99.99% budget on its own. That's why DBRE focuses so heavily on change safety.

### Error budgets as a gate on risky database changes

```svg
<svg viewBox="0 0 900 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="450" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Error budget remaining decides which database changes may ship</text>

  <line x1="70" y1="60" x2="70" y2="300" stroke="#94a3b8" stroke-width="1.5"/>
  <line x1="70" y1="300" x2="560" y2="300" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="30" y="66" fill="#334155" font-size="10">100%</text>
  <text x="36" y="186" fill="#334155" font-size="10">50%</text>
  <text x="40" y="303" fill="#334155" font-size="10">0%</text>
  <text x="315" y="322" text-anchor="middle" fill="#334155" font-size="10">days in the 28-day window</text>

  <rect x="70" y="60" width="490" height="72" fill="#dcfce7" opacity="0.6"/>
  <rect x="70" y="132" width="490" height="96" fill="#fef3c7" opacity="0.6"/>
  <rect x="70" y="228" width="490" height="72" fill="#fee2e2" opacity="0.7"/>
  <text x="552" y="80" text-anchor="end" fill="#16a34a" font-size="10" font-weight="bold">&gt; 70% left: GREEN</text>
  <text x="552" y="150" text-anchor="end" fill="#d97706" font-size="10" font-weight="bold">30-70% left: AMBER</text>
  <text x="552" y="246" text-anchor="end" fill="#dc2626" font-size="10" font-weight="bold">&lt; 30% left: RED</text>

  <polyline points="70,60 130,64 190,70 220,72 240,150 300,156 360,160 380,236 440,240 500,244 560,248" fill="none" stroke="#2563eb" stroke-width="2.5"/>
  <circle cx="240" cy="150" r="5" fill="#dc2626"/>
  <text x="248" y="118" fill="#1e293b" font-size="10">day 8: migration locks</text>
  <text x="248" y="131" fill="#1e293b" font-size="10">orders 9 min</text>
  <circle cx="380" cy="236" r="5" fill="#dc2626"/>
  <text x="388" y="214" fill="#1e293b" font-size="10">day 15: replica lag,</text>
  <text x="388" y="226" fill="#1e293b" font-size="10">stale reads 40 min</text>

  <rect x="590" y="50" width="290" height="92" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="606" y="70" fill="#1e293b" font-weight="bold">GREEN: normal change velocity</text>
  <text x="606" y="90" fill="#334155" font-size="10">standard migrations via pipeline</text>
  <text x="606" y="106" fill="#334155" font-size="10">parameter changes with review</text>
  <text x="606" y="122" fill="#334155" font-size="10">major upgrades, chaos tests allowed</text>

  <rect x="590" y="152" width="290" height="92" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="606" y="172" fill="#1e293b" font-weight="bold">AMBER: risk-weighted</text>
  <text x="606" y="192" fill="#334155" font-size="10">only low-risk, reversible changes</text>
  <text x="606" y="208" fill="#334155" font-size="10">table rewrites / upgrades need sign-off</text>
  <text x="606" y="224" fill="#334155" font-size="10">off-peak windows, extra canarying</text>

  <rect x="590" y="254" width="290" height="92" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="606" y="274" fill="#1e293b" font-weight="bold">RED / exhausted: reliability first</text>
  <text x="606" y="294" fill="#334155" font-size="10">freeze risky DB changes</text>
  <text x="606" y="310" fill="#334155" font-size="10">only fixes that improve reliability</text>
  <text x="606" y="326" fill="#334155" font-size="10">postmortem actions jump the queue</text>

  <text x="70" y="360" fill="#1e293b" font-size="11" font-weight="bold">Example: 99.95% availability over 28 days = ~20 minutes of budget.</text>
  <text x="70" y="380" fill="#334155" font-size="10">A 9-minute lock incident spends ~45% of it. The policy, agreed in advance, decides what happens next,</text>
  <text x="70" y="398" fill="#334155" font-size="10">so "can we run the 400 GB table rewrite on Thursday?" is answered by the budget, not by whoever argues loudest.</text>
  <text x="70" y="418" fill="#334155" font-size="10">Budgets are per SLI: a freshness-budget burn gates replica/WAL-heavy changes; a latency burn gates index or query changes.</text>
</svg>
```

An error budget policy should be written and agreed **before** it is needed, and it should be specific to database change classes:

| Change class | Examples | Risk | Budget gate |
|---|---|---|---|
| Standard | Add nullable column, `CREATE INDEX CONCURRENTLY`, new table | Low, reversible | Allowed unless budget exhausted |
| Normal | Backfill of a large table, constraint validation, parameter change needing reload | Medium | Allowed in GREEN/AMBER with review and off-peak |
| High-risk | Table rewrite, column type change, major version upgrade, failover topology change, parameter needing restart | High, hard to reverse | GREEN only, with rehearsal on a prod-sized copy and a rollback plan |
| Emergency | Fix for an ongoing incident | — | Always allowed; documented after |

### Latency SLOs for databases

Two forms are common. A **threshold ratio** ("99% of calls under 50 ms") is easy to compute from histogram buckets and composes naturally with error budgets. A **percentile target** ("p99 < 50 ms") is intuitive but harder to budget. Prefer threshold ratios, set per operation class — a checkout point query and a monthly report shouldn't share a threshold. Set thresholds from user need and measured baseline; don't set p99 targets tighter than the database can deliver during a normal checkpoint or failover, or the SLO will burn on healthy behaviour.

## 4. Architecture & Workflow

### Failover testing: measuring the real RTO

A failover has several phases, and only one of them is "promotion". End-to-end RTO is what the client sees:

```svg
<svg viewBox="0 0 900 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="450" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Chaos test "kill the primary": where the seconds of RTO actually go</text>

  <line x1="40" y1="90" x2="860" y2="90" stroke="#94a3b8" stroke-width="2"/>
  <text x="40" y="112" fill="#334155" font-size="10">T0 kill</text>
  <text x="840" y="112" fill="#334155" font-size="10">T+?</text>

  <rect x="40" y="50" width="220" height="30" fill="#fee2e2" stroke="#dc2626"/>
  <text x="150" y="70" text-anchor="middle" fill="#1e293b" font-size="10">1. Detection (leader key TTL / health checks)</text>
  <rect x="260" y="50" width="120" height="30" fill="#fef3c7" stroke="#d97706"/>
  <text x="320" y="70" text-anchor="middle" fill="#1e293b" font-size="10">2. Election + fencing</text>
  <rect x="380" y="50" width="110" height="30" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="435" y="70" text-anchor="middle" fill="#1e293b" font-size="10">3. Promote</text>
  <rect x="490" y="50" width="200" height="30" fill="#dbeafe" stroke="#2563eb"/>
  <text x="590" y="70" text-anchor="middle" fill="#1e293b" font-size="10">4. Routing: DNS / VIP / proxy update</text>
  <rect x="690" y="50" width="170" height="30" fill="#dcfce7" stroke="#16a34a"/>
  <text x="775" y="70" text-anchor="middle" fill="#1e293b" font-size="10">5. Clients reconnect, warm</text>

  <text x="40" y="150" fill="#1e293b" font-size="12" font-weight="bold">What to measure in the drill</text>
  <text x="40" y="172" fill="#334155" font-size="10">Detection: Patroni defaults (ttl 30 s, loop_wait 10 s) mean up to ~30 s before the leader key expires.</text>
  <text x="40" y="190" fill="#334155" font-size="10">Promotion: usually seconds, longer if the replica must replay a WAL backlog first (lag = extra RTO).</text>
  <text x="40" y="208" fill="#334155" font-size="10">Routing: DNS TTL and client DNS caching; JVMs and some drivers cache DNS far longer than the TTL.</text>
  <text x="40" y="226" fill="#334155" font-size="10">Clients: pools must detect dead connections (TCP keepalives, validation), then reconnect with backoff.</text>
  <text x="40" y="244" fill="#334155" font-size="10">Data: with async replication, commits acknowledged but not shipped are lost. Measure it (RPO).</text>

  <rect x="40" y="264" width="400" height="80" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="56" y="286" fill="#1e293b" font-weight="bold">Pass criteria (example)</text>
  <text x="56" y="306" fill="#334155" font-size="10">client-observed write outage &lt; 60 s at p100</text>
  <text x="56" y="322" fill="#334155" font-size="10">zero lost commits with quorum sync replication</text>
  <text x="56" y="338" fill="#334155" font-size="10">no manual step needed; alerts fired and linked runbook</text>

  <rect x="460" y="264" width="400" height="80" rx="8" fill="#fef2f2" stroke="#dc2626"/>
  <text x="476" y="286" fill="#1e293b" font-weight="bold">Common findings</text>
  <text x="476" y="306" fill="#334155" font-size="10">app stuck 5+ min on cached DNS / half-open TCP connections</text>
  <text x="476" y="322" fill="#334155" font-size="10">old primary comes back writable (no fencing): split brain</text>
  <text x="476" y="338" fill="#334155" font-size="10">new primary has cold cache: p99 x10 for 10-20 min</text>
</svg>
```

A failover drill runs on a schedule (monthly or quarterly per cluster tier) and records each phase's duration. Start with a **planned switchover** (graceful, zero data loss — `patronictl switchover`, or an RDS reboot with failover), then graduate to **unplanned failover** (kill the primary process or instance). Each drill answers: what was the client-observed outage? Was any committed data lost? Did anything need a human? Did the old primary rejoin correctly (with `pg_rewind` or rebuild)?

### Chaos testing for databases

Each experiment has a **hypothesis** ("if X happens, the system does Y and users see at most Z"), a **blast radius** (staging first, then a low-tier production cluster, then critical ones), **abort criteria** (SLO burn rate, specific alerts), and an **observer** who isn't running the commands.

| Experiment | How (lab or staging) | Hypothesis to verify | Typical findings |
|---|---|---|---|
| Kill primary | `kill -9` the postmaster, stop the instance, or cloud "reboot with failover" | Automatic failover within RTO, no split brain, clients recover | DNS caching, pools holding dead connections, missing fencing |
| Partition a replica | `iptables -A INPUT -s <primary> -j DROP` on the replica, or security group change | Lag alert fires; lag-aware routing stops sending reads; slot retains WAL but within `max_slot_wal_keep_size` | Reads keep going to stale replica; slot fills primary's disk |
| Partition the primary from the DCS | Block the primary's access to etcd/Consul | Primary demotes itself (Patroni) before a new leader is elected | Timing assumptions; watchdog not configured |
| Fill the disk | `fallocate -l <size> /pgdata/filler` on staging | Disk alerts fire early; runbook frees space; DB doesn't corrupt (it will stop writes) | No forecast alert; logs on data volume; no reserved space |
| Throttle I/O | cgroup v2 `io.max` on the Postgres cgroup, or a smaller provisioned IOPS in staging | Latency SLO burns, alerts point at I/O; app sheds load rather than storming | Retry storms; pools too big |
| Slow network | `tc qdisc add dev eth0 root netem delay 50ms` between app and DB | Chatty endpoints degrade predictably; timeouts fire | N+1 endpoints collapse; timeouts too long |
| Kill the pooler | Stop PgBouncer | App fails fast and reconnects; second pooler instance takes over | Single pooler as a hidden SPOF |
| Long transaction | Open `BEGIN; SELECT 1;` and leave it | Long-txn alert fires; `idle_in_transaction_session_timeout` kills it | Timeout not set; bloat grows silently |

### Game days

A game day is a scheduled exercise, typically half a day, that runs one scenario end to end with real people, dashboards and runbooks:

1. **Plan (a week before):** scenario, hypothesis, target environment, roles (incident commander, operator, observer/scribe, communications), abort criteria, rollback steps, stakeholders notified.
2. **Brief (15 min):** everyone knows the scenario is simulated and how to abort.
3. **Execute:** inject the failure; responders work *only* from alerts, dashboards and runbooks, as they would in a real incident. The scribe timestamps everything.
4. **Restore** the system to normal and verify.
5. **Debrief (same day):** what worked, what surprised us, runbook gaps, missing alerts, tooling friction.
6. **Follow-ups:** tracked action items with owners, like any postmortem.

The most valuable findings are usually about people and process: the runbook referenced a dashboard that no longer exists, the on-call engineer lacked permissions to promote a replica, nobody knew where the restore scripts lived.

### Capacity reviews

A quarterly capacity review per critical cluster uses the model from [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning): current peak utilization of each resource, growth trend, projected date each resource crosses its headroom threshold, the next rung ([Ch 21](topic.html?p=21-database-scaling)) and its lead time, and upcoming product events. The output is a short, dated list of actions — "resize primary before Nov 1", "partition `events` in Q3", "raise provisioned IOPS before the sale" — and it's the main defence against capacity incidents.

### Change management for database changes

Database changes need more care than stateless deploys because they're often irreversible (dropped columns, rewritten tables) and can lock shared resources. A practical process:

- **Everything is code:** migrations, parameter changes (in Terraform/Ansible/Patroni config), roles and grants — all reviewed in pull requests.
- **Review checklist for migrations:** Which lock level does each statement take? Does it rewrite the table? Is `lock_timeout` set with retries? Is the backfill batched and throttled? Is there an expand/contract plan so code and schema can roll back independently? Was it tested on a production-sized copy with timing? ([Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution))
- **Parameter changes:** know which need a reload vs a restart (`pg_settings.context`), apply to a replica first when possible, change one thing at a time, and record before/after.
- **Upgrades:** minor versions via rolling restart (replicas, then switchover); major versions via `pg_upgrade` on a rehearsed copy or logical replication to a new cluster with a planned cutover.
- **Timing:** risky changes in low-traffic windows, never right before weekends or big events, and only when the error budget allows.
- **Observability during change:** watch the SLO dashboard live; abort criteria defined up front.

### Postmortems

For every significant database incident, write a blameless postmortem within a few days: summary, impact (duration, users affected, data lost if any, SLO budget consumed), timeline, root cause *and* contributing factors, what went well, what went poorly, and action items with owners and dates. Database postmortems tend to converge on a handful of systemic fixes: missing timeouts, missing guardrails in migration tooling, alerts on causes that should have been on symptoms (or vice versa), capacity not reviewed, runbooks absent. Track action-item completion; an unfinished action item is the next incident.

### Toil reduction

Toil in database teams is easy to recognize: manual vacuum/analyze of problem tables, ad-hoc user and grant requests, hand-run failovers, rebuilding replicas by hand, checking backups by eye, cleaning up replication slots, answering "why is my query slow?" tickets. Measure it (hours per week per category), then automate the top items: self-service role provisioning, automated replica rebuilds, scheduled restore tests with pass/fail reporting, per-table autovacuum settings from templates, slot lifecycle tied to consumer lifecycle, and dashboards that let developers answer their own slow-query questions. A common SRE guideline is to keep toil below about half of an engineer's time; the rest goes to engineering that removes future toil.

## 5. Implementation

### Simple example: a heartbeat probe that measures availability and freshness

```sql
-- On the primary: a tiny heartbeat table.
CREATE TABLE IF NOT EXISTS dbre_heartbeat (
  id  int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  ts  timestamptz NOT NULL
);
INSERT INTO dbre_heartbeat VALUES (1, now()) ON CONFLICT (id) DO UPDATE SET ts = excluded.ts;
```

```python
# probe.py: every 10 s, write on the primary and read on each replica; export SLI counters.
import time, psycopg
from prometheus_client import Counter, Gauge, start_http_server

WRITE_OK   = Counter("db_probe_write_total", "probe writes", ["result"])
FRESHNESS  = Gauge("db_probe_replica_staleness_seconds", "replica staleness", ["replica"])

PRIMARY  = "host=primary dbname=app user=probe connect_timeout=3"
REPLICAS = {"r1": "host=replica1 dbname=app user=probe connect_timeout=3",
            "r2": "host=replica2 dbname=app user=probe connect_timeout=3"}

def probe():
    try:
        with psycopg.connect(PRIMARY, autocommit=True) as c:
            c.execute("SET statement_timeout = '2s'")
            c.execute("INSERT INTO dbre_heartbeat VALUES (1, now()) "
                      "ON CONFLICT (id) DO UPDATE SET ts = excluded.ts")
        WRITE_OK.labels("ok").inc()
    except Exception:
        WRITE_OK.labels("error").inc()          # availability SLI: bad event
    for name, dsn in REPLICAS.items():
        try:
            with psycopg.connect(dsn, autocommit=True) as c:
                (lag,) = c.execute(
                    "SELECT extract(epoch FROM now() - ts) FROM dbre_heartbeat").fetchone()
            FRESHNESS.labels(name).set(lag)      # freshness SLI: compare to 5 s bound
        except Exception:
            FRESHNESS.labels(name).set(float("inf"))

if __name__ == "__main__":
    start_http_server(9187)
    while True:
        probe(); time.sleep(10)
```

The availability SLI is `ok / (ok + error)` over the window; the freshness SLI is the fraction of samples where staleness is under the bound. Because the heartbeat is written every 10 seconds, replica staleness is meaningful even when the application is idle (with ~10 s granularity).

### Real-world example: SLO definitions, a failover drill, and a complete runbook

**SLO document (excerpt) for the `payments-db` cluster:**

```yaml
service: payments-db
owner: data-platform
window: 28d
slis:
  availability:
    good: "payments-svc DB transactions without SQLSTATE class 08, 53, 57P, XX"
    valid: "all payments-svc DB transactions (excluding 23xxx client errors)"
    objective: 99.95%
  latency:
    good: "payments-svc DB calls < 50 ms"
    objective: 99.0%
    secondary: "< 250 ms at 99.9%"
  freshness:
    good: "10 s heartbeat samples with replica staleness < 5 s"
    objective: 99.9%
  durability:
    good: "WAL segments archived within 60 s; weekly PITR restore test succeeds within 2 h"
    objective: "99.99% archive timeliness; 100% restore success"
rpo: "0 for single-node loss (quorum sync, ANY 1); <= 5 min for region loss"
rto: "< 60 s single-node; < 1 h region"
error_budget_policy: "docs/dbre/error-budget-policy.md"
```

**Failover drill script (staging, Patroni):**

```bash
#!/usr/bin/env bash
set -euo pipefail
CLUSTER=payments-staging
echo "T0 $(date -Is) starting write load"
pgbench -h haproxy -p 5000 -U app -n -c 16 -T 300 -P 1 app > pgbench.log 2>&1 &
sleep 60
LEADER=$(patronictl -c /etc/patroni.yml list -f json | jq -r '.[] | select(.Role=="Leader") | .Member')
echo "T1 $(date -Is) killing leader $LEADER"
ssh "$LEADER" 'sudo pkill -9 -f "postgres -D"'
patronictl -c /etc/patroni.yml list                         # watch election
sleep 240; wait
echo "== client-observed gap (seconds with 0 tps) =="
grep -c ', 0.0 tps' pgbench.log || true
echo "== history =="; patronictl -c /etc/patroni.yml history
```

Record detection, promotion and client-gap durations; compare the last committed transaction ids acknowledged to the client with what exists on the new primary to measure data loss (zero expected with quorum synchronous replication).

**Sample runbook (complete):**

```text
RUNBOOK: PostgreSQL WAL volume filling up
Alert:     DBDiskFullSoon (mountpoint=/pgwal) or DBInactiveSlotRetainingWAL
Severity:  PAGE if projected full < 4 h; otherwise TICKET
Owner:     data-platform on-call      Last tested: game day 2026-08-14
Impact if ignored: when pg_wal is full, the primary cannot write WAL -> all writes
                   fail (PANIC possible); replicas fall behind.

1. CONFIRM (2 min)
   - Dashboard "payments-db / Replication and WAL": WAL dir size, slot retained, archiver.
   - psql on primary:
       SELECT pg_size_pretty(sum(size)) FROM pg_ls_waldir();
       SELECT slot_name, slot_type, active, wal_status,
              pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
       FROM pg_replication_slots ORDER BY 5 DESC;
       SELECT archived_count, failed_count, last_failed_wal, last_failed_time
       FROM pg_stat_archiver;
   - df -h /pgwal   (or CloudWatch FreeStorageSpace / TransactionLogsDiskUsage)

2. BUY TIME if < 1 h to full (reversible first)
   - Grow the volume (cloud: modify volume / allocated storage; online).
   - Pause bulk jobs and backfills generating WAL (feature flag: jobs.bulk_enabled=false).
   - Do NOT delete files in pg_wal by hand. Ever.

3. IDENTIFY THE CAUSE (decision tree)
   a) Slot with active = false and large retained:
      - Find owner: slot name convention <team>_<consumer>; check consumer status.
      - If consumer is a replica that is down: can it return within the WAL budget?
          yes -> fix replica; monitor retained.
          no  -> drop the slot (replica will need re-seeding):
                 SELECT pg_drop_replication_slot('<slot>');
      - If consumer is CDC (Debezium etc.): page owning team; if unreachable and
        < 30 min to full, IC may approve drop (CDC will need a re-snapshot).
   b) Archiver failing (failed_count rising):
      - Check last_failed_wal and server log for archive_command errors
        (credentials, bucket permissions, network).
      - Fix destination; archiving resumes automatically and WAL is recycled.
   c) Active slot but lagging (replica slow):
      - Check replica replay_lag and its I/O; reduce WAL generation (pause jobs).
   d) None of the above: WAL rate spike.
      - SELECT * FROM pg_stat_wal;  pg_stat_statements ORDER BY wal_bytes DESC;
      - Pause the generator; consider temporarily raising volume size.

4. RECOVER
   - After fixing the cause: CHECKPOINT;  then confirm pg_wal shrinks over the next
     checkpoints and df shows free space returning.

5. VERIFY
   - Writes succeed (probe dashboard green); replicas streaming (pg_stat_replication);
     archiver failed_count stable; alert resolved.

6. ESCALATE
   - No progress in 20 min or data-loss decision needed -> incident commander +
     data-platform lead. Slot drops affecting another team -> notify that team.

7. FOLLOW-UP
   - Ensure max_slot_wal_keep_size is set for this cluster.
   - Add slot to consumer decommission checklist if it was orphaned.
   - Postmortem if PAGE severity.
```

> **MySQL difference:** The same DBRE model applies with different mechanics: failover via Orchestrator, MySQL InnoDB Cluster (Group Replication), or managed services; semi-synchronous replication for lower RPO; binlog retention (`binlog_expire_logs_seconds`) plays the role of WAL retention; chaos tests should include Group Replication member expulsion and replica SQL thread errors; schema changes go through `ALGORITHM=INSTANT`/INPLACE or gh-ost/pt-online-schema-change with throttling on replica lag.

## 6. Advantages, Disadvantages & Trade-offs

| Practice | Benefit | Cost / risk |
|---|---|---|
| Client-side SLIs | Measure what users feel, including failover reconnects | Instrumentation in every service |
| Synthetic heartbeat probe | Continuous availability and freshness, even with no traffic | Another component; must not become load |
| Error budget policy | Objective gate for risky changes; aligns dev and ops | Needs leadership buy-in; can feel bureaucratic |
| Scheduled failover drills | Proven RTO/RPO; confidence | Brief real disruption; cold cache afterward |
| Chaos experiments in production | Finds real weaknesses | Real risk; needs mature observability and abort criteria |
| Game days | Tests people, runbooks, permissions | Team time |
| Detailed runbooks | Fast, consistent response | Rot unless tested and owned |
| Strict change management | Fewer change-caused outages | Slower delivery if over-applied to low-risk changes |

### When to use

- Any database whose outage or data loss directly harms users or revenue.
- Teams with repeated change-caused incidents — change management and error budgets pay back fastest there.
- Before relying on HA features: drills prove they work.

### When NOT to over-engineer

- Internal tools and prototypes: a managed database with default backups and a simple availability alert is enough.
- Chaos in production before basics exist: without SLO dashboards, abort criteria and tested runbooks, chaos testing is just causing outages. Start in staging.
- Five-nines targets for a system whose dependencies can't support them — the math won't allow it and the cost is enormous.

## 7. Common Mistakes & Best Practices

**1. Measuring availability as "instance up".** *Why it hurts:* the instance can be up while every query waits on a lock. *Instead:* SLIs from client success and latency, plus probes.

**2. No freshness SLO for replicas.** *Why it hurts:* lag causes correctness bugs that look like application bugs. *Instead:* define a staleness bound and measure it.

**3. Assuming failover works.** *Why it hurts:* DNS caching, pool behaviour and fencing gaps turn a 30-second failover into a 10-minute outage or split brain. *Instead:* scheduled drills with measured phases.

**4. Backups without restore tests.** *Instead:* automated periodic restores with pass/fail and duration recorded — the durability SLI ([Ch 26](topic.html?p=26-backup-disaster-recovery)).

**5. Error budgets that don't gate anything.** *Why it hurts:* a number on a dashboard with no consequence changes no behaviour. *Instead:* a written policy tied to change classes.

**6. Runbooks that are never executed.** *Instead:* exercise them in game days; record "last tested"; owners per runbook.

**7. Chaos without abort criteria.** *Instead:* hypothesis, blast radius, abort thresholds, observer, rollback — every time.

**8. Blameful postmortems.** *Why it hurts:* people hide the key detail ("I ran it on the wrong host") and the system fix is never found. *Instead:* focus on why the system allowed it: missing guardrails, confusing tooling, no confirmation step.

**9. Treating toil as the job.** *Instead:* measure it and automate the top sources each quarter.

## 8. Production: Failure Scenarios, Monitoring & Scaling

**The failover that took 11 minutes.** Patroni promoted a replica in 25 seconds. The Java services kept trying the old IP for 10 more minutes because the JVM cached DNS and pools held half-open TCP connections. Found in a game day, not an incident. Fix: short JVM DNS cache TTL, TCP keepalives, pool connection max-lifetime and validation, HAProxy/pooler endpoints instead of DNS for routing.

**Split brain after a network partition.** An old primary, isolated from the DCS but still reachable by some app servers, kept accepting writes. Fix: Patroni watchdog and demotion on DCS loss, fencing (STONITH or cloud API isolation), and routing only through components that follow the DCS leader ([Ch 18 · High Availability](topic.html?p=18-high-availability)).

**The restore that couldn't.** A quarterly restore test discovered two weeks of WAL missing from the archive because an IAM permission changed; PITR within that range was impossible. Nothing had alerted because `archive_command` retried silently and eventually a later segment succeeded. Fix: alert on `pg_stat_archiver.failed_count` rate and archive lag; weekly automated PITR test to a random point in time.

**Error budget exhausted by migrations.** Three migrations in a month each locked a hot table for minutes. With the budget exhausted, the policy froze high-risk changes; the team built a migration linter (flags rewrites and missing `lock_timeout`) and a prod-sized rehearsal step. Change-caused incidents dropped sharply the following quarter.

**What DBRE monitors on top of Ch 24:** SLO attainment and burn rates per SLI, error budget remaining, drill results (last success date and measured RTO/RPO per cluster), restore test results, runbook "last tested" dates, action-item completion from postmortems, toil hours.

**Scaling the practice:** tier clusters (tier 1: payments/auth; tier 2: core product; tier 3: internal) and scale rigor with tier — tier 1 gets quorum sync replication, monthly drills and chaos; tier 3 gets defaults. Encode the tier's requirements as a checklist that platform tooling verifies automatically.

## 9. Interview Questions

**Q: What SLIs would you define for a production database?**
A: Availability (fraction of transactions that succeed, excluding client errors like constraint violations), latency (fraction of calls under a threshold per operation class), freshness for replicas (fraction of time or reads within a staleness bound), and durability (WAL archived within a bound and restore tests passing). I'd measure them from the client side where possible, because server metrics miss pool waits, network and failover reconnect time, and add a synthetic heartbeat probe so availability and freshness are measured even when traffic is low.

**Q: What's the difference between an SLO and an SLA, and how should they relate?**
A: An SLO is an internal target used to make engineering decisions; an SLA is a contractual commitment with consequences, usually financial. The SLA should be looser than the SLO, so that when you start burning the SLO you have time to react before breaching the contract. If they're the same number, every SLO miss is a contract breach and you have no buffer.

**Q: How does an error budget gate risky database changes?**
A: The budget is `1 − SLO` over the window — for 99.95% over 28 days, about 20 minutes. A written policy maps budget remaining to what's allowed: with plenty left, normal velocity including major upgrades and table rewrites; with the budget partly spent, only low-risk reversible changes; when exhausted, only reliability fixes. Because database downtime is dominated by changes, this directly controls the main risk, and it replaces arguments with an agreed rule.

**Q: Walk through the availability math for a service depending on an app tier, a pooler and a database.**
A: Serial dependencies multiply: 99.95% × 99.99% × 99.95% ≈ 99.89%. So the database's SLO must be tighter than the product's, or the product can't meet its target. Redundancy improves things, but less than independent-failure math suggests, because failures are correlated and failover takes time. A practical estimate is failover count times end-to-end failover duration, plus downtime from changes and incidents that failover doesn't help with.

**Q: How do you test failover properly?**
A: With scheduled drills that measure the end-to-end, client-observed outage, not just promotion time. I'd start with planned switchovers, then unplanned failovers (killing the primary) under realistic load, recording detection, election, promotion, routing and client reconnect durations, and checking data loss by comparing acknowledged commits with what's on the new primary. I'd also verify fencing — the old primary must not accept writes — and that it rejoins cleanly with `pg_rewind` or a rebuild.

**Q: Name some chaos experiments for a PostgreSQL cluster and what each verifies.**
A: Killing the primary verifies automatic failover, fencing and client recovery. Partitioning a replica verifies lag alerts, lag-aware routing and that slot WAL retention is capped. Filling the disk verifies forecast alerts and the runbook. Throttling I/O verifies that alerts point at the right cause and that the application sheds load instead of retry-storming. Adding network latency exposes chatty endpoints and bad timeouts. Each needs a hypothesis, a limited blast radius and abort criteria.

**Q: What makes a good runbook?**
A: It's tied to a specific alert, states severity and impact, and gives exact, copy-pasteable commands to confirm the problem, safe reversible mitigations to buy time, a decision tree for the cause, recovery and verification steps, escalation criteria and follow-ups. It says what *not* to do, like deleting files from `pg_wal`. It has an owner and a "last tested" date, and it's exercised in game days so it doesn't rot.

**Q: What belongs in a database postmortem?**
A: Impact (duration, affected users, data loss, budget consumed), a precise timeline, root cause and contributing factors, what went well and poorly, and action items with owners and dates. It's blameless: the question is why the system allowed the mistake — no `lock_timeout` in migration tooling, no guardrail on dropping slots — not who typed the command. Then action-item completion is tracked, because unfinished items are the next incident.

**Q: Design the reliability program for a new payments database. (Senior)**
A: I'd start with SLOs agreed with product: e.g. 99.95% availability, 99% of calls under 50 ms, replica staleness under 5 s 99.9% of the time, RPO zero for single-node loss via quorum synchronous replication, and RTO under a minute. Instrument client-side SLIs and a heartbeat probe, with burn-rate paging. Write an error-budget policy mapping change classes to budget states. Before launch, run failover drills and chaos experiments in staging, then schedule monthly drills in production; set up automated weekly PITR restore tests as the durability SLI. Runbooks for every paging alert, game days quarterly, capacity reviews quarterly, and blameless postmortems with tracked actions.

**Q: Your failover drill shows promotion in 20 seconds but the application is down for 6 minutes. How do you investigate and fix it? (Senior)**
A: The gap is in routing and client behaviour. I'd check how clients find the primary: if DNS, the TTL and client-side DNS caching (JVMs often cache much longer than the TTL); if a VIP or proxy, how fast it follows the new leader. Then connection pools: dead connections to the old primary may sit until TCP timeouts expire, often minutes, unless keepalives, validation queries and max-lifetime are set. I'd also look for retry storms delaying recovery, and whether any service hard-coded a host. Fixes: route through HAProxy or a pooler that tracks the Patroni leader via its REST API, shorten DNS caching, configure TCP keepalives and pool validation, and re-run the drill to confirm.

**Q: How would you convince a product team to accept a change freeze when the error budget is exhausted? (Senior)**
A: By having agreed the policy before it was needed, so the freeze is the team's own rule, not an operations veto. I'd show the data: which incidents consumed the budget, their user impact, and how the next risky change would push the service further out of its objective. I'd scope the freeze tightly — only high-risk database changes, not all feature work — and pair it with the reliability work that restores velocity, like a migration linter and rehearsal environment. If the SLO turns out to be stricter than users need, that's a legitimate discussion to change the SLO, but not by ignoring it.

**Q: What database toil would you automate first, and how do you decide?**
A: I'd measure where the hours go over a few weeks, then rank by frequency, time and risk. Common top candidates are replica rebuilds, access and role requests, restore verification, slot and archive housekeeping, and "why is my query slow" questions. Automating restore tests and replica rebuilds improves reliability as well as saving time, so they often come first; self-service roles and developer-facing query dashboards remove the most interrupts.

## 10. Quick Revision & Cheat Sheet

| Concept | Database-specific version |
|---|---|
| SLI: availability | Successful transactions / valid transactions (client-side) + write probe |
| SLI: latency | Fraction of calls under threshold per operation class |
| SLI: freshness | Fraction of samples with replica staleness under bound |
| SLI: durability | WAL archived within bound; restore tests pass |
| Error budget | 1 − SLO; 99.95%/28 d ≈ 20 min |
| Budget policy | Maps change classes (standard/normal/high-risk) to budget state |
| Failover RTO | Detection + election + promotion + routing + client reconnect |
| Chaos | Hypothesis, blast radius, abort criteria, observer |
| Runbook | Confirm → buy time → cause tree → recover → verify → escalate → follow-up |
| Postmortem | Blameless; impact, timeline, contributing factors, owned actions |

- Measure reliability from the client; "instance up" is not availability.
- Replicas need a freshness SLO; backups need a durability SLI proven by restores.
- Most database downtime comes from changes — gate them with the error budget.
- Serial dependencies multiply; the DB SLO must beat the product SLO.
- Failover is a hypothesis until drilled; measure every phase.
- Runbooks are tested in game days and owned, or they rot.
- Measure toil and automate the top sources every quarter.

## 11. Hands-On Exercises

Lab: two or three `postgres:17` containers (primary + streaming replicas via `pg_basebackup -R`), or a Patroni docker-compose lab with etcd and HAProxy.

1. **Heartbeat SLIs.** Deploy the probe from §5, then stop a replica and pause the primary (`docker pause`) and watch availability and freshness SLIs react. Compute SLO attainment over a 1-hour window.
2. **Failover drill.** In the Patroni lab, run pgbench through HAProxy, kill the leader, and measure the client-observed zero-TPS gap. Then change `ttl`/`loop_wait` and measure again.
3. **Chaos: partition a replica.** Use `iptables` (or `docker network disconnect`) to isolate a replica with a physical slot; watch retained WAL grow; set `max_slot_wal_keep_size` and observe the slot become `lost` instead of filling the disk.
4. **Chaos: fill the disk.** On a small volume, fill it with `fallocate` until PostgreSQL can't write WAL; follow the runbook from §5 to recover, noting every step that was unclear.
5. **Error budget calculator.** Write a script that takes an SLO and a list of incident durations and prints budget consumed, remaining, and which change classes the policy currently allows.

**Mini project:** Produce a DBRE pack for one cluster: an SLO document, an error-budget policy, three runbooks (WAL volume filling, replica lag high, primary failover), a failover drill script with a results template, and a game-day plan with hypothesis and abort criteria.

## 12. Related Topics & Free Learning Resources

**This handbook:** [Ch 09 · Replication](topic.html?p=09-replication) · [Ch 18 · High Availability](topic.html?p=18-high-availability) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) · [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) · [Ch 23 · Bottleneck Diagnosis](topic.html?p=23-bottleneck-diagnosis) · [Ch 24 · Database Monitoring](topic.html?p=24-database-monitoring) · [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery) · [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution)

**SQL Handbook:** [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [Locking & MVCC](../sql/topic.html?p=27-locking-mvcc)

**Other handbooks:** [System Design · Observability](../system-design/topic.html?p=28-observability) · [System Design · Resilience Patterns](../system-design/topic.html?p=27-resilience-patterns) · [System Design · Non-Functional Requirements](../system-design/topic.html?p=03-non-functional-requirements) · [Caching with Redis · Replication & Sentinel](../redis-caching/topic.html?p=25-replication-sentinel)

- **Google SRE Book — Service Level Objectives** — Google · *Intermediate* · the canonical definitions of SLIs, SLOs and SLAs. <https://sre.google/sre-book/service-level-objectives/>
- **Google SRE Workbook — Implementing SLOs and Error Budget Policy** — Google · *Advanced* · how to write and enforce an error-budget policy. <https://sre.google/workbook/error-budget-policy/>
- **Google SRE Book — Eliminating Toil** — Google · *Intermediate* · defining, measuring and reducing toil. <https://sre.google/sre-book/eliminating-toil/>
- **Google SRE Book — Postmortem Culture** — Google · *Intermediate* · blameless postmortems in practice. <https://sre.google/sre-book/postmortem-culture/>
- **Database Reliability Engineering** — Laine Campbell & Charity Majors (O'Reilly) · *Advanced* · the book that defined DBRE: SLOs, risk, operational visibility and change management for data stores. <https://www.oreilly.com/library/view/database-reliability-engineering/9781491925935/>
- **Patroni Documentation** — Zalando / Patroni · *Advanced* · HA configuration, switchover/failover commands and the settings drills measure. <https://patroni.readthedocs.io/en/latest/>
- **Principles of Chaos Engineering** — principlesofchaos.org · *Intermediate* · hypotheses, blast radius and running experiments safely. <https://principlesofchaos.org/>

---

*Database Design Handbook — chapter 25.*
