# 29 · Lab: Debug a Crashing Container

> **In one line:** A container that exits the instant it starts — walk `logs → inspect → exec` to diagnose exit 1, 137, bad ENTRYPOINT, missing env, and PID 1 signal traps, then fix each.

---

## 1. The Scenario

You deploy a service. Instead of staying up it flaps:

```bash
docker run -d --name api myorg/api:latest
docker ps
```

```text
CONTAINER ID   IMAGE              STATUS                     NAMES
```

Empty — nothing running. `docker ps -a` tells the real story:

```bash
docker ps -a --filter name=api --format '{{.Names}}\t{{.Status}}'
```

```text
api   Exited (1) 3 seconds ago
```

The starting artifact — a Dockerfile that *looks* fine but produces a container that won't stay up:

```dockerfile
# The image under investigation
FROM node:20-slim
WORKDIR /app
COPY . .
RUN npm ci --omit=dev
# ⚠️ several latent bugs live here
ENTRYPOINT ["node", "server.js"]
```

Your task: build a **repeatable diagnosis loop** and fix the container across five common root causes — **exit 1** (app error), **exit 137** (OOM/SIGKILL), a **bad ENTRYPOINT**, a **missing env var**, and a **PID 1 that ignores signals**.

## 2. Approach

The instinct to `docker run` again and stare doesn't scale. A senior runs a fixed funnel — **each step narrows the cause before the next**:

1. **`docker ps -a` → read the exit code.** The number *is* the first clue: 0 = clean, 1 = app threw, 125 = daemon/CLI error, 126 = not executable, 127 = not found, 137 = SIGKILL (128+9, often OOM), 139 = SIGSEGV, 143 = SIGTERM.
2. **`docker logs`** — the app's own last words. 80% of exit-1 bugs are printed here (stack trace, "config missing", "port in use").
3. **`docker inspect`** — the *facts*: exact `Cmd`/`Entrypoint`, `Env`, `OOMKilled`, `ExitCode`, `RestartCount`, mounts. This catches config bugs that produce *no* logs.
4. **`docker exec` into a *running* variant** — override the entrypoint to get a shell and reproduce by hand. If the container dies too fast to exec, start it with `--entrypoint sh -it` and poke around.
5. **Fix, rebuild, re-run** — and confirm with `docker ps` + a health probe.

Golden rule: **logs tell you what the app saw; inspect tells you what Docker gave it.** Disagreements between the two are where bugs hide.

## 3. Solution

The diagnosis loop, then a fix for each root cause.

```bash
# The loop — run these in order on any crashing container
docker ps -a --filter name=api --format '{{.Names}}\t{{.Status}}'   # exit code
docker logs api                                                     # app output
docker inspect api --format \
  'exit={{.State.ExitCode}} oom={{.State.OOMKilled}} err={{.State.Error}}'
docker inspect api --format 'entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}'
docker inspect api --format 'env={{json .Config.Env}}'

# Can't exec a dead container — start a shell INSTEAD of the app to look around
docker run --rm -it --entrypoint sh myorg/api:latest
```

**Root cause A — exit 1, app threw on startup.** Logs show it:

```text
Error: Cannot find module './config'
    at Module._resolveFilename (node:internal/modules/cjs/loader:1145:15)
```

Fix: the file wasn't copied (see `.dockerignore` excluding it) or the path is wrong. Correct the path / ignore rule and rebuild.

**Root cause B — exit 137, OOMKilled.** `docker inspect` shows `oom=true`:

```dockerfile
# Fix: raise the limit AND cap the runtime heap so it fails gracefully
# run:  docker run -m 512m myorg/api
ENV NODE_OPTIONS=--max-old-space-size=384
```

**Root cause C — bad ENTRYPOINT (exit 127 "not found" or 126 "not executable").**

```dockerfile
# ❌ shell-form hides failures & needs a shell that may not exist
ENTRYPOINT node server.js
# ❌ typo / wrong path → 127
ENTRYPOINT ["node", "sever.js"]

# ✅ exec form, correct path, verified to exist
ENTRYPOINT ["node", "server.js"]
```

**Root cause D — missing env var.** App exits 1 with `DATABASE_URL is required`:

```bash
# Fix at run time
docker run -d --name api -e DATABASE_URL=postgres://db:5432/app myorg/api
```

```dockerfile
# Or fail loud & document the requirement; never bake secrets into the image
ENV PORT=3000
# DATABASE_URL provided at runtime — do NOT default a real secret here
```

**Root cause E — PID 1 ignores signals (slow/violent shutdown, exit 143 → 137).**

```dockerfile
# ✅ tini reaps zombies and forwards SIGTERM to your app as PID 1
FROM node:20-slim
# ... build ...
ENTRYPOINT ["/usr/bin/tini", "--", "node", "server.js"]
# or:  docker run --init myorg/api   (Docker injects tini as PID 1)
```

## 4. Walkthrough

**Why the exit code comes first.** It classifies the failure before you read a single log line. `137 = 128 + 9` means the kernel sent SIGKILL — almost always the OOM killer or `docker stop` timing out and escalating. `139 = 128 + 11` is a segfault (native module / arch mismatch). `126/127` are the entrypoint itself — not executable, or the binary/path doesn't exist. `1` is a generic app throw. Knowing the class tells you *which* of the next tools to trust.

**Why logs then inspect, in that order.** For an app-level crash (root cause A), the stack trace in `docker logs` is the fastest path — the app told you exactly what broke. But config bugs (C, D) often produce *no logs* because the process never got far enough to print. That's when `inspect` earns its keep: it shows the *actual* `Entrypoint`, `Cmd`, and `Env` the daemon used — which frequently differs from what you *think* you set (a typo'd `ENV`, a `-e` flag that didn't land, an entrypoint overridden by an orchestrator).

**Why override the entrypoint to debug.** You can't `docker exec` into a container that already exited. Start the *same image* with `--entrypoint sh -it` and you land in a shell with the exact filesystem, env, and working dir the app would have — then run `node server.js` by hand and watch it fail interactively:

```bash
docker run --rm -it --entrypoint sh myorg/api:latest
/app # ls              # is server.js actually here?
/app # node server.js  # reproduce the crash with full output
```

**Why exec-form ENTRYPOINT matters for signals.** Shell form (`ENTRYPOINT node server.js`) runs your app as a *child* of `/bin/sh`, and the shell becomes PID 1. The shell doesn't forward `SIGTERM`, so `docker stop` waits 10s then SIGKILLs (exit 137) — no graceful shutdown, connections dropped. Exec form (`["node","server.js"]`) makes your app PID 1 directly. But PID 1 has special kernel semantics: it ignores signals it has no handler for, and it must reap zombie children. `tini` (or `docker run --init`) sits at PID 1, forwards signals, and reaps zombies — so your app shuts down cleanly.

**The full decision funnel:**

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <rect x="270" y="16" width="180" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="41" text-anchor="middle" fill="#1e293b" font-weight="700">Container exited</text>
  <line x1="360" y1="56" x2="360" y2="80" stroke="#475569" stroke-width="2" marker-end="url(#a)"/>

  <rect x="255" y="82" width="210" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="107" text-anchor="middle" fill="#1e293b">docker ps -a → exit code</text>

  <line x1="360" y1="122" x2="150" y2="160" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="360" y1="122" x2="360" y2="160" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="360" y1="122" x2="570" y2="160" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>

  <rect x="40" y="162" width="220" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="150" y="180" text-anchor="middle" fill="#1e293b">1 / 139</text>
  <text x="150" y="196" text-anchor="middle" fill="#64748b">app threw → logs</text>

  <rect x="250" y="162" width="220" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="180" text-anchor="middle" fill="#1e293b">137 / 143</text>
  <text x="360" y="196" text-anchor="middle" fill="#64748b">OOM/signal → inspect</text>

  <rect x="460" y="162" width="220" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="570" y="180" text-anchor="middle" fill="#1e293b">126 / 127</text>
  <text x="570" y="196" text-anchor="middle" fill="#64748b">entrypoint → inspect Cmd</text>

  <line x1="150" y1="202" x2="150" y2="238" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="360" y1="202" x2="360" y2="238" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="570" y1="202" x2="570" y2="238" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>

  <rect x="40" y="240" width="220" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="150" y="265" text-anchor="middle" fill="#1e293b">fix code / env, rebuild</text>
  <rect x="250" y="240" width="220" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="258" text-anchor="middle" fill="#1e293b">raise -m limit,</text>
  <text x="360" y="274" text-anchor="middle" fill="#1e293b">--init for signals</text>
  <rect x="460" y="240" width="220" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="570" y="258" text-anchor="middle" fill="#1e293b">exec-form, correct path,</text>
  <text x="570" y="274" text-anchor="middle" fill="#1e293b">--entrypoint sh to poke</text>

  <line x1="150" y1="280" x2="360" y2="308" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>
  <line x1="360" y1="280" x2="360" y2="308" stroke="#475569" stroke-width="1.5"/>
  <line x1="570" y1="280" x2="360" y2="308" stroke="#475569" stroke-width="1.5" marker-end="url(#a)"/>
  <rect x="270" y="308" width="180" height="28" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="327" text-anchor="middle" fill="#1e293b">docker ps → Up ✓</text>
</svg>
```

## 5. Variations & Follow-ups

**It restarts forever instead of exiting.** With `--restart=always` a crash-looping container hides the failure. Check `RestartCount` and read logs across restarts:

```bash
docker inspect api --format '{{.RestartCount}}'
docker logs --tail 50 api
```

**Health check flapping, not a crash.** The process stays up but `HEALTHCHECK` reports unhealthy. Inspect the probe's own output:

```bash
docker inspect api --format '{{json .State.Health}}' | jq '.Log[-1]'
```

**Exits 0 immediately.** The container "succeeded" and stopped because the main process is short-lived (a script that finishes) — not a bug, a *design* issue. Long-running services must not fork to background; PID 1 must be the server itself.

**Kubernetes flavor.** Same funnel, different verbs: `kubectl get pod` (STATUS = `CrashLoopBackOff`, `OOMKilled`), `kubectl logs --previous <pod>` (the crashed container), `kubectl describe pod` (events + last state + exit code), `kubectl debug` (ephemeral shell). `--previous` is the equivalent of reading logs from the container that just died.

**Reproduce OOM deliberately** to confirm your fix: `docker run -m 128m ...` and watch for `oom=true`.

## 6. Verify It Works

After fixing, the container should stay up and answer:

```bash
docker build -t myorg/api:fixed .
docker run -d --name api -m 512m --init \
  -e DATABASE_URL=postgres://db:5432/app myorg/api:fixed
sleep 2
docker ps --filter name=api --format '{{.Names}}\t{{.Status}}'
```

```text
api   Up 2 seconds (healthy)
```

Confirm graceful shutdown (signals now forwarded — clean stop, not a 10s SIGKILL):

```bash
time docker stop api
```

```text
api
docker stop api  0.31s          # stopped in <1s, not the 10s timeout
```

Confirm the fix held under memory pressure — should NOT be OOMKilled:

```bash
docker inspect api --format 'oom={{.State.OOMKilled}} exit={{.State.ExitCode}}'
```

```text
oom=false exit=0
```

## 7. Pitfalls

1. ⚠️ **Ignoring the exit code.** 137 vs 1 vs 127 point at completely different root causes. Read `docker ps -a` before touching logs.
2. ⚠️ **Trying to `docker exec` a dead container.** It's gone. Use `docker run --entrypoint sh -it <image>` to get a shell in the same environment, or `logs --previous` on Kubernetes.
3. ⚠️ **Shell-form ENTRYPOINT/CMD in production.** It swallows signals (no graceful shutdown → 137) and depends on `/bin/sh` existing (breaks on distroless). Use exec form.
4. ⚠️ **Assuming env vars are set.** A `-e` flag typo or a compose file that didn't interpolate produces a silent config crash. `docker inspect ... .Config.Env` shows what the container *actually* received.
5. ⚠️ **No init process for PID 1.** Without `tini`/`--init`, zombies accumulate and SIGTERM is ignored. Add an init unless your app explicitly handles PID 1 duties.
6. ⚠️ **Baking secrets/defaults for required env.** `ENV DATABASE_URL=...` in the image leaks credentials and masks the "missing var" error. Require it at runtime and fail loudly if absent.

## 8. Interview Follow-ups

**Q: A container exits with code 137 — what happened and how do you confirm?**
A: 137 = 128 + 9 = SIGKILL. Usually the OOM killer (memory limit exceeded) or `docker stop` escalating after the 10s grace period. Confirm with `docker inspect --format '{{.State.OOMKilled}}'`; if true it's memory — raise `-m` and/or cap the app's heap.

**Q: What's your first command when a container won't stay up, and why?**
A: `docker ps -a` to read the exit code. It classifies the failure (app throw vs OOM vs bad entrypoint vs signal) so I know whether to trust `logs` or `inspect` next, instead of guessing.

**Q: The container dies too fast to `docker exec` into it. Now what?**
A: Override the entrypoint: `docker run --rm -it --entrypoint sh <image>`. That drops me into the same filesystem/env/workdir with no app running, so I can run the start command by hand and watch it fail interactively.

**Q: Why does exec-form ENTRYPOINT matter for graceful shutdown?**
A: Shell form runs the app as a child of `/bin/sh`, which becomes PID 1 and doesn't forward SIGTERM. `docker stop` then waits 10s and SIGKILLs (exit 137), dropping in-flight requests. Exec form makes the app PID 1 directly so it receives the signal.

**Q: What special responsibilities does PID 1 have in a container?**
A: It must reap zombie child processes and it only handles signals it explicitly registers for (the kernel gives PID 1 no default handlers). An app not written for this leaks zombies and ignores SIGTERM. `tini` or `docker run --init` provides a proper init that reaps and forwards signals.

**Q: `docker logs` is empty but the container exited 1 — where do you look?**
A: `docker inspect` — the crash happened before the app printed anything, so the cause is config: a wrong `Entrypoint`/`Cmd` path, a missing `Env` var, or a bad mount. Compare the actual `.Config` and `.State.Error` against what you intended.

**Q: How is debugging a CrashLoopBackOff pod different from a Docker container?**
A: Same funnel, Kubernetes verbs: `kubectl get pod` for status (CrashLoopBackOff/OOMKilled), `kubectl logs --previous` for the crashed container's output, `kubectl describe pod` for events and last exit code, `kubectl debug` for an ephemeral shell. The restart backoff also means you read logs from the *previous* instance, not the current one.

**Q: What do exit codes 125, 126, and 127 mean?**
A: 125 = the Docker daemon/CLI itself failed (bad flag, image not found). 126 = the entrypoint was found but is not executable (permissions / not a binary). 127 = the entrypoint command was not found (typo, wrong path, missing binary in the image).

**Q: A service container exits 0 right after starting — bug or not?**
A: Usually a design bug: the main process is short-lived or forked to the background, so PID 1 finished and Docker stopped the container. A long-running service must run in the foreground as PID 1 and not daemonize.

**Q: How do you verify a signal-handling fix actually works?**
A: `time docker stop <container>` — a correctly-handling app stops in well under the 10s grace window and exits 143 (SIGTERM) cleanly, not 137 (SIGKILL escalation). I also check logs for a graceful-shutdown message.

## 9. Cheat Sheet

> [!TIP]
> **The crash-debug funnel:**
> 1. `docker ps -a` → **exit code** (1 app · 125 daemon · 126 not-exec · 127 not-found · 137 SIGKILL/OOM · 139 segv · 143 SIGTERM).
> 2. `docker logs [--tail 50] <c>` → app's last words.
> 3. `docker inspect <c> --format '{{.State.ExitCode}} {{.State.OOMKilled}} {{json .Config.Env}}'` → the facts.
> 4. Can't exec a dead container → `docker run -it --entrypoint sh <img>` and reproduce by hand.
> 5. Fixes: exec-form `ENTRYPOINT [...]` · `--init`/tini for PID 1 · `-e VAR=...` for env · raise `-m` for OOM.
> 6. K8s: `get pod` · `logs --previous` · `describe pod` · `kubectl debug`.

**References:** Docker docs — `docker inspect`, ENTRYPOINT vs CMD, `--init`; krallin/tini; Kubernetes docs — Debug Running Pods & ephemeral containers.

---
*Docker Handbook — topic 29.*
