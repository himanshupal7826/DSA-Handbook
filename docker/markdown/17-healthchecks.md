# 17 · Health Checks & Restart Policies

> **In one line:** Teach Docker to tell *running* from *actually working*, and to decide automatically whether a dead container should come back.

---

## 1. Overview

A container in state `Up` means the **PID 1 process is alive** — nothing more. A web server can be `Up` while its event loop is deadlocked, its DB pool is exhausted, or it is returning 500s to every request. To the scheduler it looks perfectly fine. **Health checks** close that gap: they run a command *inside* the container on an interval and let the container itself declare `healthy` or `unhealthy`. Now "is it up?" and "is it working?" are two different, answerable questions.

The companion question is: *when a container stops, should Docker restart it?* That is the job of **restart policies** (`--restart`), a small state machine the daemon runs for every container. Together, health checks and restart policies are the foundation of self-healing on a single host — and the same two ideas scale up into Kubernetes liveness/readiness probes and orchestrator reconciliation loops (see *From Compose to Orchestration*).

You reach for these the moment a container runs unattended: production services, Compose stacks, CI long-runners. Without them, a crashed app stays crashed until a human notices; a deadlocked app stays in rotation forever. With them, the daemon watches and reacts in seconds.

## 2. Core Concepts

- **`HEALTHCHECK` instruction** — a Dockerfile directive that bakes a probe command into the image. Docker runs it periodically and folds the result into container state.
- **Health states** — a container is `starting` (grace period), then `healthy` or `unhealthy`. State appears in `docker ps` and `docker inspect`.
- **`--interval`** — how often the probe runs (default `30s`). The clock starts after the previous check *finishes*.
- **`--timeout`** — how long a single probe may run before it is treated as a failure (default `30s`).
- **`--retries`** — consecutive failures required to flip `healthy → unhealthy` (default `3`). Prevents one transient blip from marking the container down.
- **`--start-period`** — an initial grace window (default `0s`) during which failures **don't count** toward `--retries`; used for slow-booting apps (JVMs, DB migrations).
- **`--start-interval`** (Docker 25+) — a *faster* probe cadence during the start period so a healthy app is detected quickly.
- **Restart policy** — the daemon's rule for what to do when a container **exits**: one of `no`, `on-failure[:N]`, `always`, `unless-stopped`.
- **Exponential backoff** — Docker waits `100ms, 200ms, 400ms…` (doubling, capped at 1 min) between restart attempts so a crash-looping container doesn't hammer the host.
- **`depends_on` with `condition`** — Compose ordering that can *wait for a dependency to become healthy* before starting a service, not merely to be created.

> [!NOTE]
> Health status and restart policy are **independent**. A container can be `unhealthy` and still `Up` — a plain health check does **not** restart it. Wiring "unhealthy ⇒ restart" requires Swarm/Kubernetes or the `autoheal` pattern (below).

## 3. Syntax & Examples

The `HEALTHCHECK` instruction in a Dockerfile:

```dockerfile
FROM nginx:1.27-alpine
# curl the app's own health endpoint; non-zero exit = unhealthy
HEALTHCHECK --interval=10s --timeout=3s --retries=3 --start-period=20s \
  CMD curl -fsS http://localhost/healthz || exit 1
```

The probe's **exit code is the contract**: `0` = healthy, `1` = unhealthy, `2` = reserved (do not use). Prefer a tool that already ships in the image:

```dockerfile
# wget is in busybox/alpine; no need to install curl
HEALTHCHECK --interval=15s --timeout=2s CMD \
  wget -qO- http://localhost:8080/health || exit 1
```

Disable a health check inherited from a base image:

```dockerfile
HEALTHCHECK NONE
```

Restart policies on `docker run`:

```bash
docker run -d --restart=on-failure:5 myapi     # retry up to 5 times on non-zero exit
docker run -d --restart=always redis:7          # always bring back, even after daemon reboot
docker run -d --restart=unless-stopped nginx    # like always, but respects a manual `docker stop`
```

The same in Compose, plus health-gated ordering:

```yaml
services:
  db:
    image: postgres:16
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 5
      start_period: 30s

  api:
    image: myapi:1.0
    restart: on-failure
    depends_on:
      db:
        condition: service_healthy   # wait until db reports healthy, not just started
```

> [!TIP]
> Use the **exec form** (`CMD ["curl", …]`) to skip a shell, or **`CMD-SHELL`** in Compose when you need `||`, pipes, or env expansion. The bare `CMD curl … || exit 1` in a Dockerfile is already shell form.

## 4. Worked Example

A Flask API behind a health endpoint. We build it, run it, and watch the state machine.

```dockerfile
# Dockerfile
FROM python:3.12-slim
RUN pip install flask gunicorn
COPY app.py .
HEALTHCHECK --interval=5s --timeout=2s --retries=3 --start-period=10s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8000/healthz')" || exit 1
CMD ["gunicorn", "-b", "0.0.0.0:8000", "app:app"]
```

```bash
docker build -t healthdemo .
docker run -d --name api --restart=on-failure healthdemo
docker ps --format 'table {{.Names}}\t{{.Status}}'
```

The `Status` column narrates the lifecycle:

```text
# t=0s   (inside start-period, failures ignored)
NAMES     STATUS
api       Up 2 seconds (health: starting)

# t=12s  probe has passed
NAMES     STATUS
api       Up 12 seconds (healthy)

# after the app's DB dies and /healthz starts 500-ing, 3 checks later:
NAMES     STATUS
api       Up 40 seconds (unhealthy)
```

Inspect the last probe result and its rolling log:

```bash
docker inspect --format '{{json .State.Health}}' api | jq
```

```json
{
  "Status": "unhealthy",
  "FailingStreak": 3,
  "Log": [
    { "Start": "…", "End": "…", "ExitCode": 1,
      "Output": "urllib.error.HTTPError: HTTP Error 500" }
  ]
}
```

You can also react to the event stream — this is exactly what an "autoheal" sidecar does:

```bash
docker events --filter event=health_status
# container health_status: unhealthy  api  (image=healthdemo)
```

## 5. Under the Hood

The daemon owns two small state machines per container. The **health machine** schedules the probe as a short-lived exec inside the container's namespaces, records the exit code, and applies the `retries`/`start-period` rules. The **restart machine** fires on `die`, consults the policy, and applies exponential backoff.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Health state machine (per interval)</text>

  <rect x="40" y="45" width="150" height="52" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="115" y="68" text-anchor="middle" fill="#1e293b" font-weight="600">starting</text>
  <text x="115" y="86" text-anchor="middle" fill="#64748b" font-size="11">start-period grace</text>

  <rect x="300" y="45" width="150" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="375" y="68" text-anchor="middle" fill="#1e293b" font-weight="600">healthy</text>
  <text x="375" y="86" text-anchor="middle" fill="#64748b" font-size="11">exit 0</text>

  <rect x="560" y="45" width="150" height="52" rx="8" fill="#eff6ff" stroke="#b91c1c"/>
  <text x="635" y="68" text-anchor="middle" fill="#1e293b" font-weight="600">unhealthy</text>
  <text x="635" y="86" text-anchor="middle" fill="#64748b" font-size="11">retries hit</text>

  <line x1="190" y1="71" x2="298" y2="71" stroke="#475569" marker-end="url(#arr)"/>
  <text x="244" y="63" text-anchor="middle" fill="#64748b" font-size="11">first pass</text>
  <line x1="450" y1="71" x2="558" y2="71" stroke="#475569" marker-end="url(#arr)"/>
  <text x="504" y="63" text-anchor="middle" fill="#64748b" font-size="11">N fails</text>
  <path d="M560,85 C480,120 470,120 452,90" fill="none" stroke="#059669" marker-end="url(#arr)"/>
  <text x="500" y="128" text-anchor="middle" fill="#64748b" font-size="11">1 pass ⇒ recover</text>

  <text x="380" y="185" text-anchor="middle" fill="#1e293b" font-weight="700">Restart machine (on container exit)</text>

  <rect x="60" y="205" width="140" height="48" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="130" y="234" text-anchor="middle" fill="#1e293b">container exits</text>

  <path d="M200,229 L288,229" stroke="#475569" marker-end="url(#arr)"/>
  <rect x="290" y="205" width="180" height="48" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="228" text-anchor="middle" fill="#1e293b">policy match?</text>
  <text x="380" y="245" text-anchor="middle" fill="#64748b" font-size="11">no / on-failure / always</text>

  <path d="M470,229 L558,229" stroke="#475569" marker-end="url(#arr)"/>
  <rect x="560" y="205" width="150" height="48" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="635" y="228" text-anchor="middle" fill="#1e293b">wait backoff</text>
  <text x="635" y="245" text-anchor="middle" fill="#64748b" font-size="11">100ms→…→60s</text>

  <path d="M635,253 C635,300 200,300 130,255" fill="none" stroke="#475569" marker-end="url(#arr)"/>
  <text x="380" y="300" text-anchor="middle" fill="#64748b" font-size="11">start container again, double the delay</text>
</svg>
```

Key mechanics: the probe runs as `docker exec` *inside* the container, so it uses the container's own network namespace — that is why `localhost` in the check reaches the app. Probe time is bounded by `timeout`; a hung probe counts as a failure. The health `Log` keeps only the **last 5** results. On daemon restart, containers with `always`/`unless-stopped` are brought back (respecting whether they were manually stopped); `on-failure` counters reset.

## 6. Variations & Trade-offs

| Restart policy | Restarts on crash? | Restarts on `docker stop`? | Survives daemon reboot? | Use for |
|---|---|---|---|---|
| `no` (default) | No | No | No | one-shot jobs, CI steps, batch |
| `on-failure[:N]` | Yes, if exit ≠ 0, up to N | No | No | tasks that may fail transiently |
| `always` | Yes | **Yes** (comes back) | Yes | daemons you always want running |
| `unless-stopped` | Yes | No (stays stopped) | Yes | long-running services + manual control |

The subtle pair is `always` vs `unless-stopped`. Both survive a reboot; they differ only in how they treat a **manual** `docker stop`. `always` will resurrect the container after the daemon restarts even if you deliberately stopped it; `unless-stopped` remembers your intent and leaves it down. For services an operator manages by hand, `unless-stopped` is almost always the right default.

For **health checks**, the trade-off is probe cost vs detection latency. Short `interval` detects failure faster but adds exec overhead and load on the app's health path; long `interval` is cheap but slow to react. A `retries` of 1 is twitchy (flaps on one bad request); 3–5 smooths transients at the cost of slower detection: detection time ≈ `start-period` + `retries × interval`.

## 7. Production / Performance Notes

- **A health endpoint is not a home page.** `/healthz` should be cheap and check *liveness* of critical dependencies you can recover from by restarting (event loop responsive) — not every downstream, or a flaky third-party marks you unhealthy and triggers restarts that don't help.
- **Separate liveness from readiness.** Docker has one health check; Kubernetes splits them. Emulate readiness by gating traffic (LB/Swarm) on `healthy`, and keep the liveness check strictly local.
- **A plain health check does not restart anything.** On a single host, pair it with an `autoheal` container (subscribes to `docker events` and restarts unhealthy containers) or move to Swarm/K8s where the orchestrator acts on health.
- **Right-size `start-period`.** Under-set it and a slow-booting JVM gets marked unhealthy and restart-looped before it ever serves. Over-set it and real early crashes go unnoticed.
- **Backoff means "restart storms" self-limit** but also that a container crash-looping every 200ms will be `Restarting` for a while — check `docker inspect .State.RestartCount` and logs rather than staring at `docker ps`.
- **Exit codes matter for `on-failure`.** A clean `exit 0` is *not* a failure, so `on-failure` won't restart a service that exits 0 on a fatal-but-graceful shutdown. Make fatal paths exit non-zero.
- **Health checks add CPU wakeups.** Thousands of containers each probing every 5s is real load; tune `interval` at fleet scale.

## 8. Common Mistakes

1. ⚠️ **Expecting a health check to restart the container.** It only sets state. *Fix:* add autoheal on a single host, or use Swarm/K8s.
2. ⚠️ **`curl` not installed in a slim/alpine image**, so the probe always fails. *Fix:* use `wget`, a language one-liner, or a static healthcheck binary; test the probe manually with `docker exec`.
3. ⚠️ **`start-period` too short for a slow app**, causing a restart loop at boot. *Fix:* measure real cold-start time and add margin.
4. ⚠️ **Probing an external dependency in the liveness check** (e.g. a third-party API), so their outage marks *you* unhealthy. *Fix:* check only locally-recoverable state.
5. ⚠️ **Using `always` for a service operators stop by hand**, so it keeps coming back after reboots. *Fix:* prefer `unless-stopped`.
6. ⚠️ **`depends_on` without `condition: service_healthy`**, so the app starts before the DB accepts connections and crash-loops. *Fix:* gate on health, and still make the app retry its own connections.
7. ⚠️ **Timeout longer than interval**, letting probes pile up. *Fix:* keep `timeout < interval`.
8. ⚠️ **A heavyweight `/healthz`** that runs migrations or full queries, adding load and false failures under stress. *Fix:* make it O(1) and side-effect free.

## 9. Interview Questions

**Q: What is the difference between a container being `Up` and being `healthy`?**
A: `Up` means PID 1 is running; the daemon knows nothing about whether the app works. `healthy` means the container's `HEALTHCHECK` command exited 0 within its timeout for enough consecutive runs. An app can be `Up` and deadlocked, which shows as `Up (unhealthy)` once the check fails `retries` times.

**Q: Walk through every parameter of the `HEALTHCHECK` instruction.**
A: `--interval` = time between checks (after the previous finishes); `--timeout` = max duration of one check before it's a failure; `--retries` = consecutive failures needed to become `unhealthy`; `--start-period` = initial grace window where failures don't count toward retries; `--start-interval` (25+) = faster cadence during that grace window. The `CMD` exit code is the contract: 0 healthy, 1 unhealthy.

**Q: Does a health check restart an unhealthy container? If not, how do you achieve that on a single host?**
A: No — plain Docker only updates state. To act on it you subscribe to `docker events --filter event=health_status` (the `autoheal` pattern) and restart unhealthy containers yourself, or run under Swarm/Kubernetes, whose reconcilers restart/replace unhealthy tasks automatically.

**Q: Compare the four restart policies.**
A: `no` never restarts. `on-failure[:N]` restarts only on non-zero exit, up to N times, and does not survive daemon reboot. `always` restarts on any exit and survives reboot, resurrecting even manually-stopped containers. `unless-stopped` is like `always` but respects a manual `docker stop` — it won't come back until you start it.

**Q: `always` vs `unless-stopped` — when does the distinction actually matter?**
A: Only around a manual `docker stop` followed by a daemon restart. `always` will bring the container back after the daemon restarts even though you stopped it; `unless-stopped` remembers you stopped it and leaves it down. For operator-managed services, `unless-stopped` avoids surprise resurrections.

**Q: How does Docker prevent a crash-looping container from hammering the host?**
A: Exponential backoff. After each failed restart it waits an increasing delay — 100ms, 200ms, 400ms, … doubling up to a 60s cap — before trying again, and only resets after the container stays up. During this the container shows as `Restarting`, and `RestartCount` climbs.

**Q: What does `depends_on` with `condition: service_healthy` guarantee, and what does it not?**
A: It delays starting the dependent service until the dependency's health check reports `healthy`. It does **not** guarantee the dependency stays healthy afterward, and it only works in Compose (Swarm ignores `depends_on`). Apps must still handle a dependency disappearing at runtime with their own retries.

**Q: Why does `localhost` work inside a health check but might not from outside?**
A: The probe runs via `docker exec` inside the container's network namespace, so `localhost` is the container's own loopback where the app listens. From the host you'd need the published port or the container IP; inside, loopback is correct and avoids DNS/port-mapping concerns.

**Q: (Senior) How does this model map onto Kubernetes probes?**
A: Docker's single health check splits into three K8s probes: **liveness** (restart the container if it fails), **readiness** (remove from Service endpoints but don't restart), and **startup** (a `start-period` equivalent that gates the other two during boot). Docker conflates liveness and readiness; K8s separates "restart me" from "stop sending me traffic."

**Q: (Senior) Your service is `unhealthy` but restarting doesn't help — how do you reason about the health check itself?**
A: If a restart doesn't fix it, the check is probably testing something a restart can't cure — a down database, an expired cert, a network partition. That's a *readiness* concern, not liveness. Move the dependency check out of the liveness path so a fresh process isn't killed for an external outage, and alert on the dependency separately.

**Q: (Senior) At 5,000 containers, what health-check settings would you scrutinize and why?**
A: `interval` (probe frequency × container count = wakeups/sec and app health-path load), `timeout` (must stay under interval to avoid pile-up), and the probe's own cost (avoid DB queries). I'd lengthen intervals for stable services, keep checks O(1), and push per-request health signals to the LB rather than heavy periodic probes.

## 10. Practice

- [ ] Add a `HEALTHCHECK` to an image whose base is `alpine` using `wget` (no curl), and verify it flips to `unhealthy` when you kill the app inside with `docker exec`.
- [ ] Run the same container under each restart policy and observe behavior after `docker stop`, a forced crash, and a `systemctl restart docker`.
- [ ] Write a Compose file where `api` starts only after `db` is `service_healthy`; prove ordering with `docker compose logs --timestamps`.
- [ ] Deploy a 3-line `autoheal` container that watches `docker events` and restarts anything that goes `unhealthy`; demonstrate it working.
- [ ] Tune `start-period` on a deliberately slow-booting app until it stops false-failing at startup, and record the detection-time formula.

## 11. Cheat Sheet

> [!TIP]
> **Health = "is it working?", Restart = "bring it back?" — independent.**
> `HEALTHCHECK --interval=Xs --timeout=Ys --retries=N --start-period=Zs CMD probe || exit 1` (exit 0 healthy, 1 unhealthy). States: `starting → healthy/unhealthy`. Detection ≈ `start-period + retries×interval`; keep `timeout < interval`.
> Restart policies: `no` (default) · `on-failure[:N]` (non-zero exit, not across reboot) · `always` (any exit, survives reboot, resurrects stopped) · `unless-stopped` (like always but respects manual stop). Crash loops back off 100ms→60s.
> A health check alone does **not** restart — add `autoheal` or use Swarm/K8s. Compose ordering: `depends_on: {db: {condition: service_healthy}}`. Inspect with `docker inspect --format '{{json .State.Health}}'`.

**References:** Docker docs — Dockerfile `HEALTHCHECK`, `docker run --restart`, Compose `healthcheck`/`depends_on`; willfarrell/autoheal; Kubernetes docs — Liveness/Readiness/Startup Probes.

---
*Docker Handbook — topic 17.*
