# 04 · Container Lifecycle & PID 1

> **In one line:** A container is just its **PID 1** process — it moves through created → running → stopped → removed, and how that PID 1 handles **signals** and **reaps zombies** decides whether your app shuts down gracefully or gets `SIGKILL`ed after 10 seconds.

---

## 1. Overview

A container's life is the life of **one process**. `docker run` creates a namespace/cgroup sandbox and `exec`s your command as **PID 1** inside it; when that PID 1 exits, the container is done. There is no background OS keeping it alive — kill PID 1 and the container stops. This is the single most important mental model for debugging "my container exits immediately" and "my app won't shut down cleanly."

The lifecycle has clear states: **created** (`docker create` — sandbox built, process not started), **running** (`docker start`/`run`), **paused** (`docker pause`, cgroup-frozen), **stopped/exited** (PID 1 ended or was signaled), and **removed** (`docker rm` — writable layer deleted). `docker stop` is a *polite* shutdown: it sends **SIGTERM**, waits a **grace period** (default 10s), then sends **SIGKILL**. `docker kill` skips straight to SIGKILL.

The catch: **PID 1 is special** in Linux. It doesn't get default signal handlers, and it's responsible for **reaping orphaned zombie processes**. If your app runs as PID 1 but ignores SIGTERM (common with the *shell form* of `CMD`, where PID 1 is `/bin/sh`, not your app), `docker stop` waits the full grace period and then hard-kills it — dropping in-flight requests and skipping cleanup. If PID 1 spawns children and doesn't reap them, zombies pile up.

The fixes are small and mechanical: use the **exec form** so your app *is* PID 1, handle SIGTERM, and add a tiny init (**tini** / `docker run --init`) when you need proper signal forwarding and zombie reaping.

## 2. Core Concepts

- **PID 1** — the container's main process; the container lives exactly as long as it does. Gets no default signal dispositions and must reap orphaned children.
- **Lifecycle states** — created → running → (paused) → stopped/exited → removed. `docker ps -a` shows them with exit codes.
- **SIGTERM (15)** — the graceful "please stop" signal `docker stop` sends first; your app should catch it, finish in-flight work, and exit.
- **SIGKILL (9)** — the unblockable "die now" signal sent after the grace period; no cleanup, dropped connections.
- **Stop grace period** — time between SIGTERM and SIGKILL; default **10s**, set with `docker stop -t <sec>` or `STOPSIGNAL`/`stop_grace_period`.
- **STOPSIGNAL** — Dockerfile/CLI override of which signal is sent first (e.g. nginx uses `SIGQUIT` for graceful drain).
- **Exec form vs shell form** — `CMD ["app","--flag"]` (exec) makes your app PID 1 and receives signals; `CMD app --flag` (shell) runs `/bin/sh -c` as PID 1, which by default **doesn't forward signals** to your app.
- **Zombie process** — a dead child whose exit status hasn't been `wait()`-ed; PID 1 must reap them or they accumulate.
- **tini / `--init`** — a ~10KB init that becomes PID 1, **forwards signals** to your app and **reaps zombies**; enable with `docker run --init` or bake in tini.
- **Exit codes** — `0` clean; `137` = 128+9 (SIGKILL, often OOM); `143` = 128+15 (SIGTERM); `139` = SIGSEGV.

## 3. Syntax & Examples

Lifecycle commands:

```bash
docker create --name c nginx      # created (not started)
docker start c                    # running
docker pause c ; docker unpause c # freeze/thaw via cgroup
docker stop -t 30 c               # SIGTERM, wait 30s, then SIGKILL
docker kill c                     # immediate SIGKILL (or --signal=HUP)
docker rm c                       # remove (must be stopped, or -f)
docker ps -a --format 'table {{.Names}}\t{{.Status}}'
```

Exec form vs shell form — this is the #1 signal bug:

```dockerfile
# GOOD: exec form → your app is PID 1, receives SIGTERM
CMD ["node", "server.js"]

# BAD: shell form → PID 1 is /bin/sh, signals not forwarded to node
CMD node server.js
```

Handle SIGTERM in the app (Node example):

```javascript
process.on('SIGTERM', () => {
  server.close(() => process.exit(0));   // stop accepting, drain, exit clean
});
```

Add an init for signal forwarding + zombie reaping:

```bash
docker run --init myimage        # Docker injects tini as PID 1
```
```dockerfile
# or bake it in:
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
STOPSIGNAL SIGTERM
```

## 4. Worked Example

**Goal:** see the grace period and the exec/shell difference in action.

```bash
# App that ignores SIGTERM, run via SHELL form (PID 1 = /bin/sh)
docker run -d --name slow --stop-timeout 5 alpine sh -c \
  'trap "echo IGNORING SIGTERM" TERM; while true; do sleep 1; done'

time docker stop slow          # watch how long it takes
docker inspect slow --format '{{.State.ExitCode}}'
```

Result — SIGTERM is swallowed, so Docker waits the 5s grace and SIGKILLs:

```text
$ time docker stop slow
slow
real    0m5.4s                 # full grace period elapsed
$ docker inspect slow --format '{{.State.ExitCode}}'
137                            # 128 + 9 = killed by SIGKILL, not graceful
```

Now the exec form + a real handler + `--init`:

```bash
docker run -d --name fast --init --stop-timeout 30 node:20-slim node -e \
  'process.on("SIGTERM",()=>{console.log("draining");process.exit(0)}); setInterval(()=>{},1e9)'

time docker stop fast
docker inspect fast --format '{{.State.ExitCode}}'
```

```text
$ time docker stop fast
fast
real    0m0.3s                 # exited immediately on SIGTERM
$ docker inspect fast --format '{{.State.ExitCode}}'
0                             # clean shutdown, no forced kill
```

Same `docker stop`, wildly different behavior — decided entirely by whether PID 1 receives and handles SIGTERM.

## 5. Under the Hood

`docker stop` is a two-phase, timed handshake with PID 1; the exit code tells you which phase ended it.

```svg
<svg viewBox="0 0 680 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- states -->
  <rect x="20" y="150" width="110" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="75" y="170" text-anchor="middle" fill="#1e293b" font-weight="700">created</text>
  <text x="75" y="186" text-anchor="middle" fill="#64748b" font-size="11">docker create</text>

  <rect x="170" y="150" width="110" height="44" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="225" y="170" text-anchor="middle" fill="#1e293b" font-weight="700">running</text>
  <text x="225" y="186" text-anchor="middle" fill="#64748b" font-size="11">start / run</text>

  <rect x="320" y="150" width="110" height="44" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="375" y="170" text-anchor="middle" fill="#1e293b" font-weight="700">stopped</text>
  <text x="375" y="186" text-anchor="middle" fill="#64748b" font-size="11">exit code set</text>

  <rect x="470" y="150" width="110" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="525" y="170" text-anchor="middle" fill="#1e293b" font-weight="700">removed</text>
  <text x="525" y="186" text-anchor="middle" fill="#64748b" font-size="11">docker rm</text>

  <line x1="130" y1="172" x2="168" y2="172" stroke="#475569" marker-end="url(#a)"/>
  <line x1="280" y1="172" x2="318" y2="172" stroke="#475569" marker-end="url(#a)"/>
  <line x1="430" y1="172" x2="468" y2="172" stroke="#475569" marker-end="url(#a)"/>

  <!-- stop sequence -->
  <text x="340" y="40" text-anchor="middle" fill="#1e293b" font-weight="700">docker stop -t 10</text>

  <rect x="150" y="60" width="150" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="225" y="79" text-anchor="middle" fill="#1e293b">1. SIGTERM → PID 1</text>
  <text x="225" y="94" text-anchor="middle" fill="#64748b" font-size="11">please drain &amp; exit</text>

  <rect x="330" y="60" width="150" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="405" y="79" text-anchor="middle" fill="#1e293b">2. wait grace (10s)</text>
  <text x="405" y="94" text-anchor="middle" fill="#64748b" font-size="11">app exits? → code 0/143</text>

  <rect x="510" y="60" width="150" height="40" rx="8" fill="#fef2f2" stroke="#b91c1c"/>
  <text x="585" y="79" text-anchor="middle" fill="#b91c1c" font-weight="700">3. SIGKILL</text>
  <text x="585" y="94" text-anchor="middle" fill="#64748b" font-size="11">no cleanup → code 137</text>

  <line x1="300" y1="80" x2="328" y2="80" stroke="#475569" marker-end="url(#a)"/>
  <line x1="480" y1="80" x2="508" y2="80" stroke="#475569" marker-end="url(#a)"/>
  <line x1="225" y1="150" x2="225" y2="102" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#a)"/>

  <!-- PID1 duties -->
  <rect x="60" y="240" width="560" height="80" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="340" y="264" text-anchor="middle" fill="#1e293b" font-weight="700">PID 1 is special</text>
  <text x="340" y="286" text-anchor="middle" fill="#64748b" font-size="12">no default signal handlers → must explicitly handle SIGTERM (or it's ignored)</text>
  <text x="340" y="305" text-anchor="middle" fill="#64748b" font-size="12">must reap orphaned children (wait) or zombies accumulate — tini/--init does both</text>
</svg>
```

Why PID 1 misbehaves: the kernel gives PID 1 no default signal dispositions, so an unhandled SIGTERM is simply *ignored* (whereas a normal process would terminate). It also inherits every orphaned process; if it never calls `wait()`, their exit statuses linger as **zombies** consuming PID-table slots. The **shell form** compounds this: `/bin/sh -c "app"` becomes PID 1 and, by default, neither forwards SIGTERM to `app` nor reaps zombies. **tini** (what `--init` installs) is a minimal PID 1 that forwards signals to your app and calls `wait()` in a loop to reap orphans.

## 6. Variations & Trade-offs

| Approach | PID 1 is | Signals reach app? | Reaps zombies? | Use when |
|---|---|---|---|---|
| **Exec form** `CMD ["app"]` | your app | ✅ directly | only if app does | app handles SIGTERM & has no forked children |
| **Shell form** `CMD app` | `/bin/sh` | ❌ not forwarded | ❌ | avoid for long-running services |
| **`--init` / tini** | tini | ✅ forwarded | ✅ | app forks children or can't reap; safest default |
| **Full init (systemd)** | init system | ✅ | ✅ | multi-process container (rare; anti-pattern) |

**Signal vs orchestrator:** in Kubernetes the same rules apply — the kubelet sends SIGTERM, waits `terminationGracePeriodSeconds` (default 30s), then SIGKILL, and runs `preStop` hooks first. Exec form + SIGTERM handling is what makes rolling deploys drain cleanly. **STOPSIGNAL** lets you match app conventions (nginx drains on `SIGQUIT`, not `SIGTERM`).

## 7. Production / Performance Notes

- **Always use exec form** for the final `CMD`/`ENTRYPOINT` of long-running services, so your app is PID 1 and gets signals.
- **Handle SIGTERM**: stop accepting new work, finish in-flight requests, flush/close, exit 0. This is the difference between zero-downtime deploys and dropped requests.
- **Tune the grace period** to your real drain time: `docker stop -t`, Compose `stop_grace_period`, k8s `terminationGracePeriodSeconds`. Too short → SIGKILL mid-request; too long → slow rollouts.
- **Add `--init`/tini** whenever PID 1 forks children (shells, wrappers, some app servers) to prevent zombie buildup and ensure signal forwarding.
- **Read exit codes**: `137` usually = SIGKILL/OOM (check `OOMKilled`), `143` = SIGTERM, `139` = segfault, `0` = clean. They're your first debugging signal.
- **Match STOPSIGNAL to the app** (e.g. nginx `SIGQUIT`, some apps `SIGINT`) so the *first* signal already triggers graceful drain.
- **Don't wrap in a shell** just to set env or run two commands — that reintroduces the shell-PID-1 problem; use exec-form `ENTRYPOINT` + `exec "$@"` in scripts.

## 8. Common Mistakes

1. ⚠️ **Shell form for a service** (`CMD python app.py`) — PID 1 is `/bin/sh`, SIGTERM never reaches the app, every stop takes the full grace + SIGKILL. Fix: exec form `CMD ["python","app.py"]`.
2. ⚠️ **Not handling SIGTERM** — app is killed mid-request. Fix: install a SIGTERM handler that drains and exits.
3. ⚠️ **Entrypoint shell script without `exec`** — `./start.sh` runs your app as a *child* of the script (PID 1 = sh), so signals stop at the script. Fix: end the script with `exec "$@"` or `exec app`.
4. ⚠️ **Ignoring zombie reaping** when PID 1 forks children — defunct processes pile up. Fix: `--init`/tini or reap in-app.
5. ⚠️ **Grace period too short** for slow drains — SIGKILL cuts off in-flight work. Fix: raise `-t`/`stop_grace_period`/`terminationGracePeriodSeconds`.
6. ⚠️ **Misreading exit 137 as a crash** — it's SIGKILL, frequently **OOM**. Fix: check `docker inspect .State.OOMKilled` and memory limits.
7. ⚠️ **Wrong STOPSIGNAL** — sending SIGTERM to an app that drains on SIGQUIT (nginx) causes an abrupt stop. Fix: set `STOPSIGNAL` to match the app.
8. ⚠️ **`docker rm` losing data** — removing a container deletes its writable layer. Fix: durable state in volumes; expect the container layer to vanish.

## 9. Interview Questions

**Q: What determines when a container stops?**
A: Its **PID 1**. A container runs exactly as long as its main process; when PID 1 exits (or is killed), the container transitions to stopped and records that process's exit code.

**Q: What exactly does `docker stop` do, step by step?**
A: It sends **SIGTERM** to PID 1, waits the **stop grace period** (default 10s), and if the process is still alive sends **SIGKILL**. `docker kill` skips the grace period and sends SIGKILL (or a chosen signal) immediately.

**Q: Why does PID 1 need special signal handling?**
A: The kernel gives PID 1 no default signal dispositions, so signals like SIGTERM are **ignored** unless the process explicitly handles them (a normal process would default-terminate). If PID 1 doesn't handle SIGTERM, `docker stop` always falls through to SIGKILL.

**Q: Exec form vs shell form — what's the difference and why does it matter?**
A: Exec form `CMD ["app"]` runs your app directly as **PID 1**, so it receives signals. Shell form `CMD app` runs `/bin/sh -c "app"`, making the shell PID 1; by default it doesn't forward SIGTERM to your app, so graceful shutdown breaks. Use exec form for services.

**Q: What is a zombie process and whose job is it to reap them?**
A: A zombie is a terminated child whose exit status hasn't been collected via `wait()`. **PID 1** inherits orphaned children and must reap them; if it doesn't, zombies accumulate and can exhaust the PID table. tini/`--init` reaps automatically.

**Q: What do `--init` and tini do?**
A: They install a tiny init (~tini) as **PID 1** that **forwards signals** to your actual process and **reaps zombies**. Enable with `docker run --init` or bake `ENTRYPOINT ["/usr/bin/tini","--"]`. Use it when PID 1 forks children or can't do these itself.

**Q: A container exits with code 137. What does that tell you?**
A: 137 = 128 + 9, i.e. killed by **SIGKILL** — often the OOM killer (check `docker inspect .State.OOMKilled` and memory limits) or a `docker stop` grace timeout. 143 (128+15) means it exited on SIGTERM.

**Q: Your entrypoint is a bash script that launches the app; SIGTERM isn't reaching the app. Why?**
A: The script is PID 1 and the app is its child, so signals stop at the script. End the script with `exec "$@"` (or `exec app`) so the app **replaces** the shell as PID 1 and receives signals directly.

**Q: (Senior) How does this map to Kubernetes pod termination?**
A: The kubelet runs any `preStop` hook, sends **SIGTERM**, waits `terminationGracePeriodSeconds` (default 30s), then SIGKILL. So the same exec-form + SIGTERM-handling discipline is what makes rolling updates drain connections without dropping requests.

**Q: (Senior) How would you pick and tune the stop grace period for a service?**
A: Measure the real worst-case drain time (finish in-flight requests, flush buffers, close connections) and set the grace slightly above it via `stop_grace_period`/`terminationGracePeriodSeconds`. Too short truncates work with SIGKILL; too long slows rollouts and node drains.

**Q: (Senior) Why might you set `STOPSIGNAL` to something other than SIGTERM?**
A: To match the app's graceful-shutdown convention — e.g. **nginx** drains on `SIGQUIT`, some apps use `SIGINT`. Setting `STOPSIGNAL` ensures the *first* signal Docker sends already triggers a clean drain instead of an abrupt stop.

## 10. Practice

- [ ] Run a container with shell-form CMD that traps and ignores SIGTERM; time `docker stop` and read the 137 exit code.
- [ ] Rewrite it in exec form with a SIGTERM handler and confirm sub-second, exit-0 shutdown.
- [ ] Write an entrypoint script that forgets `exec`, prove signals don't reach the app, then fix with `exec "$@"`.
- [ ] Spawn zombies from PID 1, observe them in `docker top`, then re-run with `--init` and confirm they're reaped.
- [ ] Force an OOM kill with `--memory=32m` and identify `OOMKilled: true` / exit 137 via `docker inspect`.

## 11. Cheat Sheet

> [!TIP]
> **Container life = PID 1's life.** States: created → running → (paused) → stopped → removed.
> **`docker stop` = SIGTERM → wait grace (10s default) → SIGKILL.** `docker kill` = SIGKILL now.
> **Exec form `CMD ["app"]`** → app is PID 1, gets signals. **Shell form `CMD app`** → `/bin/sh` PID 1, signals NOT forwarded. Entrypoint scripts must end with `exec "$@"`.
> PID 1 has **no default signal handlers** and **must reap zombies** → handle SIGTERM; use `--init`/**tini** when forking children.
> Exit codes: **0** clean · **143** SIGTERM · **137** SIGKILL/OOM (check `OOMKilled`) · **139** segfault.
> Tune grace to real drain time (`-t` / `stop_grace_period` / k8s `terminationGracePeriodSeconds`). `STOPSIGNAL` to match app (nginx=SIGQUIT).

**References:** Docker `run`/`stop` CLI reference · "Docker and the PID 1 zombie reaping problem" (Phusion) · tini project README · Kubernetes Pod termination lifecycle docs

---

*Docker Handbook — topic 04.*
