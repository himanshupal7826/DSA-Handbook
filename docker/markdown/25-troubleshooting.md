# 25 · Debugging & Troubleshooting Containers

> **In one line:** A systematic loop — read the exit code, follow the logs, inspect state, exec in, and watch resources — turns "the container is broken" into a root cause.

---

## 1. Overview

Containers fail in a small number of recognizable ways: the image won't start, the process exits immediately, it gets **OOM-killed**, it's **CPU-throttled**, it can't reach the network, or it hits a **permission** wall on a mounted volume. The symptoms look chaotic; the causes are finite. The skill is not memorizing fixes — it's running the same diagnostic loop every time.

That loop is: **What was the exit code? → What do the last logs say? → What does `inspect` say about state and config? → Can I `exec` in and reproduce? → Is the kernel starving it (`stats`, cgroup counters)?** Each step narrows the search space by roughly an order of magnitude.

The core mental shift: a container is a **process under namespaces and cgroups**, not a tiny VM. When it dies, Linux recorded *why* — as an exit code, an OOM event in the kernel log, or a cgroup counter. Docker surfaces all of it. Debugging is reading what the kernel already told you.

You reach for this material the moment `docker ps` shows `Exited (137)`, a `CrashLoopBackOff`, a hung request, or "works on my machine but not in the container."

## 2. Core Concepts

- **Exit code** — the process's status, stored on the container. `docker inspect` and `docker ps` show it; the number tells you *who* killed it (the app, Docker, or the kernel).
- **`docker logs`** — stdout/stderr of PID 1. The single most useful command; `--tail`, `-f`, `--since`, and `--timestamps` scope the noise.
- **`docker inspect`** — the full JSON truth: state, exit code, OOMKilled flag, mounts, env, networks, restart policy. Query it with `--format` / `jq`.
- **`docker exec`** — run a second process in the container's namespaces to poke the live environment (env vars, DNS, files, ports). Requires the container to still be *running*.
- **`docker stats`** — live CPU, memory (used vs limit), net and block I/O per container, straight from cgroups. Reveals OOM pressure and throttling before the kill.
- **`docker events`** — the daemon's real-time stream (`create`, `oom`, `die`, `kill`, `health_status`). The audit log of *when* something happened.
- **OOM kill** — the kernel's cgroup memory controller kills the process when it exceeds `--memory`; shows as exit **137** and `OOMKilled: true`.
- **CPU throttle** — the cgroup CFS quota (`--cpus`) doesn't kill; it *pauses* the process, adding latency. Seen in `throttled_time`, not in exit codes.
- **Ephemeral debug** — for distroless/scratch images with no shell, attach tooling via `docker debug`, a sidecar sharing namespaces, or `nsenter`.

## 3. Syntax & Examples

```bash
# --- Triage: what happened? ---
docker ps -a                          # STATUS column shows "Exited (137)" etc.
docker inspect --format \
  '{{.State.ExitCode}} oom={{.State.OOMKilled}} err={{.State.Error}}' web

# --- Logs: scoped, timestamped ---
docker logs --tail 100 -f web          # last 100 lines, then follow
docker logs --since 10m --timestamps web
docker logs web 2>&1 | grep -i error   # stderr merged, filtered

# --- Get inside a running container ---
docker exec -it web sh                 # or bash; interactive shell
docker exec web env                    # dump env vars non-interactively
docker exec web cat /etc/resolv.conf   # inspect DNS config

# --- Resource pressure, live ---
docker stats --no-stream web           # one snapshot of CPU/mem/IO

# --- Daemon-level timeline ---
docker events --since 15m --filter container=web
```

```bash
# Container that won't even start — inspect the created (not running) state
docker inspect --format '{{.State.Status}}: {{.State.Error}}' web
# e.g. "created: ... exec: \"/app\": permission denied"

# Debug a distroless image (no shell inside) via an ephemeral toolbox
# sharing the target's PID + network namespaces:
docker run -it --rm \
  --pid=container:web --network=container:web \
  --cap-add SYS_PTRACE nicolaka/netshoot
# now: ps aux, ss -tlnp, curl localhost:8080, nslookup db  — all see web's view
```

## 4. Worked Example

**Symptom:** a Node API container keeps restarting. `docker ps` shows it flickering between `Up` and `Restarting`.

```bash
$ docker ps -a
CONTAINER ID   IMAGE      STATUS                       PORTS     NAMES
a1b2c3d4e5f6   api:1.4    Restarting (137) 5s ago                api
```

Exit **137** = 128 + 9 (SIGKILL). Either OOM or a manual kill. Check which:

```bash
$ docker inspect --format \
  'oom={{.State.OOMKilled}} code={{.State.ExitCode}} restarts={{.RestartCount}}' api
oom=true code=137 restarts=14
```

`OOMKilled: true` — the kernel is killing it. Confirm the ceiling and the climb:

```bash
$ docker stats --no-stream api
CONTAINER   CPU %   MEM USAGE / LIMIT   MEM %   NET I/O
api         4.10%   255.4MiB / 256MiB   99.8%   1.2MB / 900kB
```

Memory is pinned at the 256 MiB limit. Root cause: the Node heap outgrows the container limit (default V8 old-space assumes host RAM, ignores the cgroup). Two-part fix — tell V8 the real budget *and* raise the ceiling if the workload legitimately needs it:

| Change | Command |
|---|---|
| Cap the V8 heap under the limit | `-e NODE_OPTIONS=--max-old-space-size=384` |
| Raise the container memory limit | `--memory=512m` |

```bash
$ docker run -d --name api --memory=512m \
    -e NODE_OPTIONS=--max-old-space-size=384 api:1.4
$ docker stats --no-stream api
CONTAINER   CPU %   MEM USAGE / LIMIT   MEM %
api         3.80%   210.1MiB / 512MiB   41.0%   # stable, no more kills
```

The container stops restarting. Total diagnosis: three commands (`ps`, `inspect`, `stats`) walked exit code → OOM flag → the memory curve.

## 5. Under the Hood

When a container process exits, the kernel reports a **wait status** to the Docker daemon, which stores `ExitCode` and, if the OOM killer fired inside the cgroup, sets `OOMKilled: true`. Signals map to `128 + signum` (SIGKILL 9 → 137, SIGTERM 15 → 143). `docker logs` simply replays the file the **logging driver** (default `json-file`) captured from the process's stdout/stderr FDs. `docker exec` calls `setns(2)` to join the container's existing namespaces and spawns your command beside PID 1 — which is why it needs the container *running*.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">The Debugging Loop — narrow the cause each step</text>

  <rect x="30" y="55" width="150" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="105" y="79" text-anchor="middle" fill="#1e293b" font-weight="600">1. Exit code</text>
  <text x="105" y="97" text-anchor="middle" fill="#64748b">ps -a / inspect</text>

  <rect x="215" y="55" width="150" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="290" y="79" text-anchor="middle" fill="#1e293b" font-weight="600">2. Logs</text>
  <text x="290" y="97" text-anchor="middle" fill="#64748b">logs --tail -f</text>

  <rect x="400" y="55" width="150" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="475" y="79" text-anchor="middle" fill="#1e293b" font-weight="600">3. Inspect</text>
  <text x="475" y="97" text-anchor="middle" fill="#64748b">state / config JSON</text>

  <rect x="585" y="55" width="150" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="660" y="79" text-anchor="middle" fill="#1e293b" font-weight="600">4. Exec in</text>
  <text x="660" y="97" text-anchor="middle" fill="#64748b">reproduce live</text>

  <line x1="180" y1="83" x2="212" y2="83" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="365" y1="83" x2="397" y2="83" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="550" y1="83" x2="582" y2="83" stroke="#475569" marker-end="url(#ah)"/>

  <rect x="215" y="150" width="335" height="56" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="382" y="174" text-anchor="middle" fill="#1e293b" font-weight="600">5. stats + events — kernel resource truth</text>
  <text x="382" y="192" text-anchor="middle" fill="#64748b">cgroup memory / CPU throttle / oom event</text>
  <line x1="475" y1="111" x2="420" y2="147" stroke="#475569" marker-end="url(#ah)"/>

  <rect x="30" y="250" width="700" height="66" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="380" y="274" text-anchor="middle" fill="#1e293b" font-weight="600">Exit code decoder</text>
  <text x="380" y="296" text-anchor="middle" fill="#64748b">0 ok · 1 app error · 125 daemon/run flag · 126 not executable · 127 not found · 137 SIGKILL/OOM · 143 SIGTERM</text>
</svg>
```

**Exit code table — memorize it:**

| Code | Meaning | Typical cause |
|---|---|---|
| **0** | Clean exit | Process finished normally (fine for jobs; a bug for daemons) |
| **1** | Generic app error | Unhandled exception, bad config, failed assertion |
| **125** | Docker daemon failed | Bad `docker run` flag, invalid mount, image issue — container never started |
| **126** | Command not executable | Missing `+x` bit, wrong architecture binary, script without interpreter |
| **127** | Command not found | Typo in `CMD`/`ENTRYPOINT`, binary not in `PATH`, missing shell |
| **137** | 128 + 9 (SIGKILL) | **OOM kill** or `docker kill`; check `OOMKilled` |
| **143** | 128 + 15 (SIGTERM) | Graceful stop — `docker stop`, orchestrator scale-down |

## 6. Variations & Trade-offs

| Tool | Answers | Needs container running? | Best for |
|---|---|---|---|
| `docker logs` | "What did the app say?" | No (persists after exit) | First look, crash post-mortem |
| `docker inspect` | "What's the config & final state?" | No | Exit code, OOM flag, mounts, IP |
| `docker exec` | "What's true *right now* inside?" | **Yes** | Live DNS, env, files, ports |
| `docker stats` | "Is it starving?" | Yes | OOM/CPU throttle diagnosis |
| `docker events` | "What happened, when?" | No | Timeline, restart storms |
| `docker debug` / netshoot | "Inspect a shell-less image" | Yes | distroless/scratch, network |

The key trade-off is **live vs post-mortem**: `logs`/`inspect`/`events` survive the container's death and are your only option for a crash you can't reproduce; `exec`/`stats` need a live process but let you interact. For crash loops, catch it during an `Up` blip or add `--restart=no` and a `sleep infinity` entrypoint override to freeze the environment for inspection.

## 7. Production / Performance Notes

- **Structured JSON logs to stdout.** Then `docker logs` is greppable and your aggregator (Loki/ELK/CloudWatch) parses fields, not regexes. Never write logs to files *inside* the container — they vanish on removal.
- **Cap the `json-file` driver** with `--log-opt max-size=10m --log-opt max-file=3`, or unbounded logs silently fill the host disk and take the daemon down with them.
- **Right-size limits, then set them.** Watch `docker stats` under load, set `--memory`/`--cpus` with headroom. No limit = a noisy neighbor OOMs the whole host, not just itself.
- **CPU throttling is invisible in exit codes.** A "slow" service with no errors is often throttled. Check the cgroup: `cat /sys/fs/cgroup/cpu.stat` → rising `throttled_usec` means raise `--cpus`.
- **Make images debuggable in staging.** distroless is great for prod security but has no shell; keep a `-debug` tag variant, or standardize on `docker debug` / a netshoot sidecar so on-call isn't stuck.
- **Permission failures are UID mismatches**, not Docker bugs. A volume owned by host UID 1000 mounted into a container running as UID 1001 → `EACCES`. Fix with matching `--user`, an `chown` in an init step, or `:z`/`:Z` SELinux relabel on RHEL.
- **`--restart=on-failure` masks crashes.** A container that restarts cleanly can hide a bug for weeks; alert on `RestartCount` and exit codes, don't just watch `STATUS: Up`.

## 8. Common Mistakes

1. ⚠️ **Reading `docker logs` and stopping there.** If the app was SIGKILLed there may be *no* final log line. Always pair with the exit code from `inspect`. Fix: check `State.ExitCode` and `State.OOMKilled` first.
2. ⚠️ **Assuming 137 always means OOM.** 137 is any SIGKILL, including `docker stop` timing out. Fix: confirm with `OOMKilled: true`; if false, look for a slow shutdown exceeding the stop grace period.
3. ⚠️ **`docker exec` into a crashed container.** exec needs a running process; on an exited container it errors. Fix: use `logs`/`inspect` for post-mortem, or restart with an overridden long-running entrypoint to freeze it.
4. ⚠️ **Debugging the wrong layer for "connection refused."** The app may be listening on `127.0.0.1` inside the container, unreachable from outside. Fix: `exec … ss -tlnp` — bind to `0.0.0.0`, not localhost.
5. ⚠️ **Blaming the network for DNS.** "Can't reach db" is usually service-name resolution. Fix: `exec … nslookup db` and check you're on the same user-defined network (the default bridge has no DNS).
6. ⚠️ **Setting `--memory` without fixing the runtime.** JVM/V8/Go read host RAM, not the cgroup, and OOM anyway. Fix: set `-XX:MaxRAMPercentage`, `--max-old-space-size`, or `GOMEMLIMIT` to the container budget.
7. ⚠️ **Ignoring `docker events` during restart storms.** You stare at one container while the daemon has the whole timeline. Fix: `docker events --filter container=x` shows the die/oom/start cadence.
8. ⚠️ **`chmod 777` on a volume to "fix" permissions.** It works and is a security hole. Fix: align UIDs with `--user $(id -u)` or `chown` to the container's user.

## 9. Interview Questions

**Q: A container shows `Exited (137)`. Walk me through diagnosing it.**
A: 137 = 128 + 9 (SIGKILL). First `docker inspect --format '{{.State.OOMKilled}}'` — if true, it's an OOM kill: check `docker stats` for memory pinned at the limit and either raise `--memory` or cap the runtime heap. If false, something sent SIGKILL — often `docker stop` exceeding the grace period, so look at shutdown handling. Logs may be empty because SIGKILL can't be trapped.

**Q: What's the difference between exit codes 125, 126, and 127?**
A: They form a ladder. 125 = the Docker daemon itself failed to run the container (bad flag, invalid mount) — the process never started. 126 = the command was found but isn't executable (missing `+x`, wrong architecture). 127 = the command wasn't found at all (typo, not in `PATH`, missing shell). 125 is Docker's fault; 126/127 are your ENTRYPOINT/CMD's fault.

**Q: How do you tell an OOM kill from a CPU throttle?**
A: OOM *kills* — the process dies with exit 137 and `OOMKilled: true`; you see it in exit codes and events. Throttling *slows* — the CFS quota pauses the process when it exceeds `--cpus`, adding latency but never killing it, so it's invisible in exit codes. You find throttling in `docker stats` (CPU capped below demand) or the cgroup's `cpu.stat` `throttled_usec` counter climbing.

**Q: A service inside a container returns "connection refused" from another container. Where do you look?**
A: Rule out layers top-down. `exec … ss -tlnp` to confirm the app is actually listening and on `0.0.0.0` not `127.0.0.1`. Then confirm both containers share a user-defined network (`inspect` the networks). Then `exec … nslookup <service>` to verify Docker DNS resolves the name — the default bridge has no DNS, so you must use a custom network or `--link`.

**Q: Why can't you `docker exec` into a crashing container, and what do you do instead?**
A: exec joins an existing process's namespaces via `setns`; if the container has exited there's no process to join. Options: read the persisted `logs` and `inspect` state for a post-mortem; or restart it with an overridden entrypoint (`--entrypoint sh` or `sleep infinity`) so the environment stays up while you investigate; or in Kubernetes, use an ephemeral debug container.

**Q: How do you debug a distroless or scratch image with no shell?**
A: You bring your own tools without modifying the image. Run a debug container sharing the target's namespaces: `docker run --pid=container:app --network=container:app nicolaka/netshoot` gives you a full toolbox that sees the app's processes and network. Or use `docker debug` (Desktop) which attaches a toolbox to any container. In K8s, `kubectl debug` with an ephemeral container does the same.

**Q: You set `--memory=512m` on a JVM app and it still OOM-kills. Why?**
A: The JVM historically read the *host's* total RAM to size its heap, ignoring the cgroup limit, so it happily grew past 512m and the kernel killed it. Fix: on modern JDKs it's container-aware, but you should still set `-XX:MaxRAMPercentage=75` (or an explicit `-Xmx`) so the heap plus non-heap (metaspace, threads, direct buffers) stays under the limit. Same class of bug affects Node (`--max-old-space-size`) and Go (`GOMEMLIMIT`).

**Q: What does `docker events` give you that `docker logs` doesn't?**
A: `logs` is the *application's* output from one container. `events` is the *daemon's* real-time control-plane stream across all containers — create, start, die, kill, oom, health_status, network connect/disconnect — with timestamps. For a restart storm or intermittent OOM, events reconstruct the timeline of what the daemon did and when, which the app logs can't show.

**Q: A mounted volume gives "permission denied" though the file exists. Root cause and fix?**
A: A UID/GID mismatch. The container process runs as some UID; the host directory is owned by a different UID, and Linux DAC checks are by numeric ID, not name. Fix by aligning: run the container as the owning UID (`--user $(id -u):$(id -g)`), or `chown` the volume to the container's user in an init step, or on SELinux hosts add `:z`/`:Z` to the mount to relabel. `chmod 777` "works" but is a security hole.

**Q: Senior follow-up — how would you make crash loops observable in production so you're not SSH-ing to hosts?**
A: Ship structured JSON logs to stdout into an aggregator (Loki/ELK/CloudWatch) so post-mortems don't depend on a live container. Export container metrics (cAdvisor → Prometheus) including memory-vs-limit and CPU throttle counters, and alert on `RestartCount` and non-zero/137 exit codes — not just `STATUS: Up`, which a restart policy will happily keep green over a real bug. Keep a `-debug` image variant so on-call can attach tooling without a rebuild.

## 10. Practice

- [ ] Run a container with `--memory=64m` and a memory-hungry process; confirm exit 137 and `OOMKilled: true` via `inspect`, then watch it climb in `docker stats`.
- [ ] Break a Dockerfile's `CMD` three ways (typo the binary, drop the `+x`, point at a non-existent path) and match each to exit code 127 / 126 / 125.
- [ ] Start two containers on the default bridge and again on a user-defined network; `exec … nslookup` the other by name and explain the difference.
- [ ] Reproduce a volume permission error with `--user 1001` on a root-owned mount, then fix it three ways (`--user`, `chown`, `:z`).
- [ ] Debug a distroless image using a `netshoot` sidecar sharing its network namespace; list its listening sockets with `ss -tlnp`.

## 11. Cheat Sheet

> [!TIP]
> **Debugging loop:** `ps -a` (exit code) → `logs --tail -f` → `inspect` (state/OOM/mounts) → `exec -it sh` (live) → `stats` + `events` (resource truth).
> **Exit codes:** 0 clean · 1 app error · 125 daemon/run flag · 126 not executable · 127 not found · **137 SIGKILL/OOM** · 143 SIGTERM. 137: check `OOMKilled`.
> **OOM vs throttle:** OOM *kills* (137, `OOMKilled:true`, `stats` mem at limit); CPU throttle *slows* (no exit code, `cpu.stat` `throttled_usec`). Runtimes ignore cgroups — set `MaxRAMPercentage`/`--max-old-space-size`/`GOMEMLIMIT`.
> **Network:** "conn refused" → app on `127.0.0.1` not `0.0.0.0` (`ss -tlnp`); "can't reach name" → not on a user-defined network / DNS (`nslookup`).
> **Permissions:** `EACCES` on a volume = UID mismatch → `--user`, `chown`, or `:z`/`:Z`. Never `chmod 777`.
> **Shell-less images:** `docker debug` or `--pid=container:x --network=container:x netshoot`.

**References:** Docker CLI reference (logs/inspect/exec/stats/events), Docker "Troubleshoot the runtime", Linux cgroups v2 memory/cpu docs, nicolaka/netshoot

---

*Docker Handbook — topic 25.*
