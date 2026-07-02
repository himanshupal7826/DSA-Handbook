# 14 · CPU/Memory Limits & cgroups

> **In one line:** Cap and reserve a container's CPU and memory through Linux cgroups so one workload can't starve the host or its neighbours.

---

## 1. Overview

A container is just a process tree with **namespaces** (what it can see) and **cgroups** (what it can use). By default a container sees the *whole* host — all CPUs, all RAM — and will happily consume every byte until the kernel intervenes. On a shared host or a Kubernetes node, one unbounded container can trigger the **OOM killer**, cause CPU starvation, and take down unrelated services. This is the "noisy neighbour" problem.

**Resource limits** are how you bound that blast radius. `docker run` translates flags like `--memory` and `--cpus` into writes to the container's **cgroup** (control group), the kernel mechanism that meters and throttles a group of processes. Memory limits are *hard walls* — exceed them and the kernel kills you. CPU limits are *throttles* — exceed them and the kernel slows you down.

You reach for this whenever containers share a host: multi-tenant nodes, CI runners, dev laptops running a dozen services, and every production orchestrator. Get it right and workloads are predictable and isolated; get it wrong and you get mysterious **exit 137** crashes, latency spikes from throttling, or a host that falls over under load.

## 2. Core Concepts

- **cgroups (control groups)** — the Linux kernel subsystem that accounts and limits CPU, memory, I/O, and PIDs for a set of processes. Docker creates one cgroup per container.
- **cgroups v2** — the unified hierarchy (single tree, `/sys/fs/cgroup`) that replaced the per-controller v1 layout. Default on modern distros (RHEL 9, Ubuntu 22.04+). Enables features like `memory.high` and better `cpu.max` accounting.
- **`--memory` (hard limit)** — the maximum RAM the container may use. Hit it and the kernel's OOM killer terminates a process in the cgroup.
- **`--memory-swap`** — limit on **memory + swap** combined. Set equal to `--memory` to disable swap entirely for the container.
- **`--memory-reservation` (soft limit)** — a target the kernel tries to keep you under when the host is under memory pressure; not a hard cap.
- **`--cpus`** — a fractional CPU quota (`--cpus=1.5` = 1.5 cores) implemented via cgroup CPU **quota/period**. This is a throttle, not a reservation.
- **`--cpu-shares`** — a *relative weight* (default 1024) that only matters under contention; a 2048-share container gets 2× the CPU of a 1024-share one when both want more.
- **`--cpuset-cpus`** — pin the container to specific physical cores (e.g. `0-3`), for NUMA locality or noisy-neighbour isolation.
- **OOM killer & exit 137** — when a cgroup exceeds its memory limit, the kernel kills a process; the container exits with `128 + 9 (SIGKILL) = 137`.
- **CPU throttling** — when a container exhausts its CPU quota within a period, the kernel de-schedules it until the next period, adding latency. Visible in `nr_throttled`/`throttled_time`.
- **Reservations vs limits** — a *reservation* guarantees a floor (scheduling); a *limit* enforces a ceiling (throttle/kill). They answer different questions.

## 3. Syntax & Examples

Basic memory cap — kill the container if it exceeds 512 MB:

```bash
docker run --memory=512m --memory-swap=512m nginx
# --memory-swap == --memory  ->  swap disabled for this container
```

CPU quota vs weight:

```bash
docker run --cpus=1.5 myapp          # hard: at most 1.5 cores of wall-clock CPU
docker run --cpu-shares=512 myapp    # soft: half the default weight, only bites under contention
docker run --cpuset-cpus=0,1 myapp   # pin to cores 0 and 1 only
```

Soft reservation plus hard limit together:

```bash
docker run \
  --memory-reservation=256m \   # soft: kernel reclaims toward this under pressure
  --memory=512m \               # hard: OOM-kill above this
  --cpus=2 \
  redis:7
```

Docker Compose (the deploy block works in Swarm; the top-level `mem_limit`/`cpus` keys work in plain Compose):

```yaml
services:
  api:
    image: myorg/api:1.4
    mem_limit: 512m
    mem_reservation: 256m
    cpus: 1.5
    # Swarm / deploy syntax:
    deploy:
      resources:
        limits:   { cpus: "1.5", memory: 512M }
        reservations: { cpus: "0.5", memory: 256M }
```

Inspect live usage and the OOM flag:

```bash
docker stats --no-stream                 # live CPU% / MEM USAGE / LIMIT
docker inspect -f '{{.State.OOMKilled}}' api   # true if the kernel OOM-killed it
```

## 4. Worked Example

Reproduce an OOM kill and read the evidence. We give a container 128 MB and ask it to allocate 500 MB.

```bash
docker run --name hog --memory=128m --memory-swap=128m python:3.12-slim \
  python -c "x = bytearray(500 * 1024 * 1024); print('allocated')"
```

Result — the process never prints `allocated`; the kernel kills it:

```text
$ echo $?
137

$ docker inspect -f 'OOMKilled={{.State.OOMKilled}} ExitCode={{.State.ExitCode}}' hog
OOMKilled=true ExitCode=137
```

And in the host kernel log:

```text
$ dmesg | tail -2
Out of memory: Killed process 20431 (python) total-vm:...kB
oom-kill:constraint=CONSTRAINT_MEMCG ... memcg=/docker/9f2c...
```

Now demonstrate CPU throttling. Limit to half a core and run a busy loop, then read the cgroup counters:

```bash
docker run -d --name spin --cpus=0.5 alpine \
  sh -c 'while true; do :; done'

# cgroups v2 CPU stats for that container:
cat /sys/fs/cgroup/system.slice/docker-*/cpu.stat
```

```text
usage_usec 8123456
nr_periods 812
nr_throttled 799        <- throttled in almost every 100ms period
throttled_usec 40218джей...   <- ~40s of enforced sleep
```

`nr_throttled` close to `nr_periods` is the fingerprint of a CPU-starved container: it's not slow because of your code, it's slow because the kernel is de-scheduling it.

## 5. Under the Hood

`docker run --memory=512m --cpus=1.5` does not do anything special in Docker — it writes files in the container's cgroup and lets the **kernel** enforce them. On cgroups v2 the relevant files are `memory.max`, `memory.high`, `memory.swap.max`, and `cpu.max` (`quota period`, e.g. `150000 100000` = 1.5 cores). The scheduler and the memory reclaim path read those on every accounting tick.

```svg
<svg viewBox="0 0 760 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">One container = one cgroup the kernel meters</text>

  <!-- docker run -->
  <rect x="30" y="52" width="180" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="120" y="72" text-anchor="middle" fill="#1e293b">docker run</text>
  <text x="120" y="90" text-anchor="middle" fill="#64748b" font-size="11">--memory=512m --cpus=1.5</text>

  <line x1="210" y1="75" x2="286" y2="75" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <text x="248" y="66" text-anchor="middle" fill="#64748b" font-size="11">writes</text>

  <!-- cgroup fs -->
  <rect x="290" y="44" width="230" height="120" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="405" y="64" text-anchor="middle" fill="#1e293b" font-weight="700">cgroup v2 (/sys/fs/cgroup)</text>
  <text x="405" y="86" text-anchor="middle" fill="#1e293b" font-size="12">memory.max = 536870912</text>
  <text x="405" y="106" text-anchor="middle" fill="#1e293b" font-size="12">memory.swap.max = 0</text>
  <text x="405" y="126" text-anchor="middle" fill="#1e293b" font-size="12">cpu.max = "150000 100000"</text>
  <text x="405" y="150" text-anchor="middle" fill="#64748b" font-size="11">(quota / period → 1.5 cores)</text>

  <line x1="520" y1="104" x2="596" y2="104" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <text x="558" y="95" text-anchor="middle" fill="#64748b" font-size="11">enforced by</text>

  <!-- kernel -->
  <rect x="600" y="44" width="140" height="120" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="670" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">Linux kernel</text>
  <text x="670" y="90" text-anchor="middle" fill="#1e293b" font-size="12">CFS scheduler</text>
  <text x="670" y="110" text-anchor="middle" fill="#1e293b" font-size="12">memcg reclaim</text>
  <text x="670" y="130" text-anchor="middle" fill="#1e293b" font-size="12">OOM killer</text>

  <!-- outcomes -->
  <rect x="120" y="210" width="240" height="80" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="240" y="234" text-anchor="middle" fill="#1e293b" font-weight="700">Over cpu.max</text>
  <text x="240" y="256" text-anchor="middle" fill="#64748b" font-size="12">throttle: de-schedule</text>
  <text x="240" y="274" text-anchor="middle" fill="#64748b" font-size="12">until next period (latency)</text>

  <rect x="400" y="210" width="240" height="80" rx="8" fill="#fff1f2" stroke="#b91c1c"/>
  <text x="520" y="234" text-anchor="middle" fill="#b91c1c" font-weight="700">Over memory.max</text>
  <text x="520" y="256" text-anchor="middle" fill="#64748b" font-size="12">OOM kill → SIGKILL</text>
  <text x="520" y="274" text-anchor="middle" fill="#64748b" font-size="12">exit code 137</text>

  <line x1="670" y1="164" x2="560" y2="206" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <line x1="660" y1="164" x2="290" y2="206" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
</svg>
```

The key mental model: **memory is enforced by killing, CPU is enforced by waiting.** Memory can't be "given back" instantly, so the kernel reclaims cache and, failing that, kills a process. CPU is infinitely divisible in time, so the kernel just makes you wait for the next 100 ms scheduling period.

## 6. Variations & Trade-offs

| Flag | Kind | cgroup v2 file | Behaviour when exceeded | Use when |
|---|---|---|---|---|
| `--memory` | Hard limit | `memory.max` | OOM kill (exit 137) | Cap absolute RAM |
| `--memory-reservation` | Soft limit | `memory.low`/`high` | Reclaim under pressure, no kill | Guarantee a floor, allow bursts |
| `--memory-swap` | Hard limit | `memory.swap.max` | Kill once mem+swap exhausted | Disable/limit swap |
| `--cpus` | Hard throttle | `cpu.max` (quota) | Throttled to next period | Predictable absolute CPU cap |
| `--cpu-shares` | Relative weight | `cpu.weight` | Only bites under contention | Prioritise between containers |
| `--cpuset-cpus` | Pinning | `cpuset.cpus` | Runs only on named cores | NUMA locality, isolation |

**`--cpus` vs `--cpu-shares`:** `--cpus` is an *absolute* cap that applies even on an idle host — a `--cpus=0.5` container never exceeds half a core. `--cpu-shares` is *relative* and only affects who wins when the host is saturated; on an idle host a low-share container can still use all cores. Use `--cpus` for tenancy guarantees, shares for prioritisation.

**Swap trade-off:** allowing swap (`--memory-swap` > `--memory`) can prevent OOM kills but at the cost of brutal latency when the container thrashes. Most production setups disable swap and rely on right-sized hard limits, so failures are *fast and visible* rather than *slow and mysterious*.

## 7. Production / Performance Notes

- **Always set memory limits in production.** An unbounded container is a latent host outage. In Kubernetes, a memory *request* is the reservation and a memory *limit* is the hard cap; a Pod exceeding its limit is OOM-killed exactly like `--memory`.
- **Beware runtimes that don't see the cgroup.** Older JVMs and Node processes read the *host's* total RAM, not `memory.max`, and size their heaps too large → instant OOM. Use a cgroup-aware runtime (JDK 11+ with `-XX:+UseContainerSupport`, which is on by default) or set heap size explicitly.
- **Leave headroom.** Set the limit above steady-state RSS plus GC/burst overhead. A limit at exactly the working set guarantees intermittent OOM kills under load.
- **Watch throttling, not just CPU%.** A container can show 50% CPU yet be badly throttled if its load is bursty. Alert on `throttled_time`/`nr_throttled` from `cpu.stat`, not just average utilisation. Over-tight `--cpus` on latency-sensitive services causes p99 spikes.
- **cpuset for NUMA-sensitive workloads.** Databases and low-latency services benefit from pinning to cores on one NUMA node to avoid cross-socket memory access.
- **Reservations ≠ free capacity.** Summed reservations that exceed the node cause the scheduler to refuse new work even if actual usage is low. Right-size requests to real usage (use historical p95).

## 8. Common Mistakes

1. ⚠️ **Running production containers with no `--memory` limit.** One leak takes the host down. Fix: set a hard memory limit on every container.
2. ⚠️ **Setting the limit exactly at the working set.** Causes intermittent exit-137 crashes under bursts. Fix: add 20–50% headroom above observed peak RSS.
3. ⚠️ **Ignoring `--memory-swap`.** With swap available, a leaking container thrashes for minutes before dying. Fix: set `--memory-swap` equal to `--memory` to disable swap.
4. ⚠️ **Assuming `--cpu-shares` caps CPU.** It only matters under contention; on an idle host the container uses everything. Fix: use `--cpus` for a real cap.
5. ⚠️ **JVM/Node sizing heap from host RAM.** Runtime ignores the cgroup and OOMs immediately. Fix: use a container-aware runtime or set `-Xmx`/`--max-old-space-size` explicitly.
6. ⚠️ **Diagnosing throttling as "slow code."** High `nr_throttled` means the *limit* is too low, not the app. Fix: read `cpu.stat`, raise `--cpus`.
7. ⚠️ **Over-committing reservations.** Reservations summing past node capacity block scheduling. Fix: base requests on measured p95, not guesses.
8. ⚠️ **Confusing exit 137 with OOM every time.** 137 is any SIGKILL (also `docker stop` timeout). Fix: confirm with `docker inspect .State.OOMKilled` / `dmesg`.

## 9. Interview Questions

**Q: What kernel mechanism actually enforces `--memory` and `--cpus`, and what is Docker's role?**
A: Linux **cgroups**. Docker just creates a cgroup for the container and writes limit values (e.g. `memory.max`, `cpu.max` on cgroups v2); the kernel's memory-controller and CFS scheduler enforce them. Docker itself does no metering at runtime.

**Q: A container exits with code 137. What does that tell you and how do you confirm the cause?**
A: 137 = 128 + 9, i.e. the process received **SIGKILL**. The most common cause is the cgroup OOM killer hitting the memory limit, but `docker stop` timing out also SIGKILLs. Confirm OOM with `docker inspect -f '{{.State.OOMKilled}}'` (true) and the host `dmesg`/journal for an `oom-kill` line naming the memcg.

**Q: Explain the difference between `--cpus` and `--cpu-shares`.**
A: `--cpus` is an **absolute** cap enforced via CPU quota/period, active even on an idle host (`--cpus=0.5` never exceeds half a core). `--cpu-shares` is a **relative weight** (default 1024) that only affects scheduling *under contention* — a low-share container can still use all cores when nobody else wants them.

**Q: What is the difference between a resource reservation and a resource limit?**
A: A **reservation** is a guaranteed floor used for scheduling/placement (soft for memory, weight for CPU); a **limit** is a hard ceiling enforced by throttling (CPU) or killing (memory). Reservation answers "how much am I promised?", limit answers "how much before I'm punished?".

**Q: Why is CPU throttling "invisible" in average CPU usage, and how do you detect it?**
A: A bursty workload can average, say, 40% CPU but still hit its quota in individual 100 ms periods and get de-scheduled, adding latency. Average utilisation hides it. Detect via cgroup `cpu.stat` counters `nr_throttled` and `throttled_usec`, or container metrics exporters — a high throttled ratio means the CPU limit is too tight.

**Q: How does `--memory-swap` relate to `--memory`, and why do many teams disable swap?**
A: `--memory-swap` caps **memory + swap** combined. Setting it equal to `--memory` disables swap for the container. Teams disable swap so that hitting the memory limit fails *fast and visibly* (an OOM kill) rather than degrading into minutes of thrashing that looks like a hang.

**Q: (Senior) A Java service OOM-kills at startup with a 2 GB limit despite using ~800 MB heap steady-state. What's likely wrong?**
A: Either the JVM isn't cgroup-aware and sized its heap from host RAM, or non-heap memory (metaspace, thread stacks, direct buffers, JIT code cache) plus heap exceeds the limit. Fixes: run JDK 11+ with container support (default on), or set `-Xmx`/`-XX:MaxRAMPercentage` explicitly and account for off-heap overhead in the limit.

**Q: (Senior) What changed with cgroups v2 that matters for container resource management?**
A: v2 uses a single **unified hierarchy** instead of separate per-controller trees, giving consistent accounting and features like `memory.high` (throttle before the hard `memory.max`), better PSI (pressure stall information) for detecting contention, and `cpu.max`/`cpu.weight` semantics. It's the default on RHEL 9, Ubuntu 22.04+, and required for some Kubernetes features (e.g. proper memory QoS).

**Q: (Senior) When would you use `--cpuset-cpus` instead of `--cpus`?**
A: When you need **core affinity**, not just a quota — e.g. pinning a low-latency service or database to cores on a single NUMA node to avoid cross-socket memory latency and cache thrash, or hard-isolating a noisy tenant to dedicated cores. `--cpus` limits *how much* CPU time; `--cpuset-cpus` limits *which* cores.

**Q: (Senior) Two containers both set `--cpu-shares=1024` on a 4-core host, but one is pinned with `--cpuset-cpus=0`. How does CPU get divided?**
A: The pinned container can only run on core 0, so it gets at most 1 core regardless of its share. Shares only balance contention *within the cores a container is allowed on*. The unpinned 1024-share container can spread across all 4 cores. Pinning overrides share-based fairness by constraining the eligible CPU set first.

## 10. Practice

- [ ] Run a container with `--memory=100m --memory-swap=100m` and a script that allocates 200 MB; confirm exit 137 and `OOMKilled=true` via `docker inspect`.
- [ ] Launch a busy-loop container with `--cpus=0.25`, then read its `cpu.stat` and identify `nr_throttled` climbing.
- [ ] Start two `--cpu-shares` containers (1024 and 512) both running busy loops on a saturated host; use `docker stats` to observe the ~2:1 CPU split.
- [ ] Set `--memory-reservation=100m --memory=300m` and use `docker stats` to watch usage under a memory-pressure workload — confirm no kill until 300 MB.
- [ ] Inspect `/sys/fs/cgroup/.../memory.max` and `cpu.max` for a running container and map each back to its `docker run` flag.

## 11. Cheat Sheet

> [!TIP]
> **Resource limits = cgroups.** Memory limit = hard wall → OOM kill → **exit 137** (verify `.State.OOMKilled`). CPU limit = throttle → de-schedule → latency (verify `cpu.stat` `nr_throttled`).
> **Memory:** `--memory=512m` (hard), `--memory-reservation` (soft floor), `--memory-swap=512m` (= memory → swap off).
> **CPU:** `--cpus=1.5` (absolute cap), `--cpu-shares=1024` (relative, only under contention), `--cpuset-cpus=0-3` (pin cores).
> **Rules:** always set a memory limit in prod; add headroom above peak RSS; disable swap for fast-fail; alert on throttling not just CPU%; make runtimes cgroup-aware (JVM/Node). Reservation = floor (schedule), limit = ceiling (enforce).

**References:** Docker "Runtime options with Memory, CPUs, and GPUs" docs, Linux kernel cgroup-v2 documentation, Kubernetes "Resource Management for Pods and Containers", "Analysis of Docker CPU throttling" (engineering blogs on CFS quota).

---
*Docker Handbook — topic 14.*
