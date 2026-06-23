# 47 · GMP Model

> **In one line:** Go's scheduler multiplexes millions of goroutines (G) onto a small pool of OS threads (M) coordinated by logical processors (P), with `GOMAXPROCS` bounding parallelism and per-P run queues keeping scheduling cheap and cache-friendly.

---

## 1. Overview

The **GMP model** is the heart of the Go runtime scheduler. It describes how Go runs your `go func()` calls without spawning an OS thread per goroutine. Three entities cooperate:

- **G (goroutine):** a unit of work — a function plus its stack, program counter, and scheduling state. Cheap: ~2 KB initial stack, growable.
- **M (machine):** an OS thread. The only thing that can actually execute code on a CPU.
- **P (processor):** a logical scheduling context — a permit to run Go code. The number of Ps is `GOMAXPROCS`. A P owns a **local run queue** of runnable Gs and a cache of free stacks/mcache for allocation.

The invariant: **an M must hold a P to run Go code.** Gs are runnable; Ps decide which G runs next; Ms provide the CPU. This M:N scheduler (M goroutines onto N threads) is what makes "just add `go`" a viable concurrency primitive at scale.

> [!NOTE]
> `GOMAXPROCS` defaults to the number of logical CPUs (`runtime.NumCPU()`). In Go 1.25+ it is also container-aware via cgroup CPU quota detection, so a pod limited to 2 cores no longer spins up 64 Ps on a 64-core host.

---

## 2. Why It Exists

Early concurrency models forced a bad trade-off:

| Model | Cost per unit | Parallelism | Blocking I/O |
|-------|--------------|-------------|--------------|
| Thread-per-task (1:1) | ~1–8 MB stack, kernel scheduling | Yes | Wastes a thread while blocked |
| Single-threaded event loop (N:1) | Tiny | No (one core) | Callback hell, one blocking call stalls all |
| **GMP (M:N)** | ~2 KB stack | Yes (up to GOMAXPROCS) | Runtime parks the G, reuses the M |

The GMP model gives you the cheapness of green threads *and* true multicore parallelism *and* synchronous-looking blocking code. The runtime does the work the kernel and the programmer used to do: when a goroutine blocks on a channel, mutex, or syscall, the scheduler **parks** it and runs another G on the same M — no kernel thread switch in the channel/mutex case.

The **P** is the key design insight. Before Go 1.1 there was a single global run queue protected by one mutex (the GM model), which serialized scheduling and destroyed cache locality. Dmitry Vyukov's redesign introduced **P** so each thread has its own local queue, slashing contention and enabling **work stealing**.

---

## 3. Internal Working

### Data structures

The runtime (`runtime/runtime2.go`) defines `g`, `m`, and `p` structs.

- **`g`**: holds `stack` (lo/hi bounds), `sched` (a `gobuf` snapshot of SP, PC, BP used to resume), `atomicstatus` (`_Grunnable`, `_Grunning`, `_Gwaiting`, `_Gsyscall`, `_Gdead`), `goid`, and `m` (current M, if running).
- **`m`**: holds `g0` (the scheduling/system stack goroutine), `curg` (current user G), `p` (attached P), `nextp`, `spinning` flag, and a `tls` slot. Each M maps 1:1 to a `pthread`/clone thread.
- **`p`**: holds `runq` (a fixed **256-slot ring buffer** of `*g`), `runqhead`/`runqtail`, `runnext` (a single-G fast slot for the most-recently-readied G — improves locality for ping-pong patterns), `mcache` (per-P allocator cache), and a free-G list.

### Queues and stealing

```text
        GLOBAL RUN QUEUE (lock-protected, FIFO)
        +---+---+---+---+ ...
        | G | G | G | G |        <- overflow + fairness source
        +---+---+---+---+

   P0 (runnext: G)        P1 (runnext: G)        P2
   local runq [256]       local runq [256]       local runq [256]
   +-+-+-+-+              +-+-+-+-+              +-+-+-+-+
   |G|G|G| |              |G|G| | |              | | | | |  <-- empty
   +-+-+-+-+              +-+-+-+-+              +-+-+-+-+
      ^                                            |
      M0 (OS thread)        M1                     | steals half of P0's runq
      running G             running G              M2 ----+
```

The scheduler loop is `schedule()` → `findRunnable()`. To find the next G, a P checks, roughly in order:

1. `runnext` (the hot slot).
2. Its own local `runq`.
3. The **global queue** (periodically, ~1/61 of schedules, to guarantee fairness so global Gs aren't starved).
4. The **netpoller** (ready network/timer Gs).
5. **Work stealing:** randomly pick another P and steal **half** of its local queue.

If nothing is found, the M parks (goes to sleep) and the P may be handed to another M.

### Blocking and handoff

- **Channel/mutex block:** G goes `_Gwaiting`, M grabs another runnable G. Pure userspace, no thread switch.
- **Syscall:** G + M enter `_Gsyscall`. The P is **detached** (handoff) so another M can pick it up and keep the CPU busy. On return, the M tries to reacquire a P; if none free, the G goes back to a run queue and the M parks. A background **sysmon** thread retakes Ps from Ms stuck in long syscalls.

### Preemption

Originally Go used **cooperative** preemption (only at function-call safepoints), so a tight loop with no calls could hog a P forever. Since **Go 1.14**, preemption is **asynchronous and signal-based**: `sysmon` detects a G running >10 ms and sends a `SIGURG` to the M, injecting a safepoint that reschedules. This fixed the classic `for {}` starvation bug.

---

## 4. Syntax

There is no "GMP syntax" — it is runtime machinery. You interact via `runtime` knobs:

```go
import "runtime"

// Read / set the number of Ps (parallelism cap). Returns the previous value.
old := runtime.GOMAXPROCS(4)

// Read effective P count without changing it.
n := runtime.GOMAXPROCS(0)

// Logical CPU count (the historical default for GOMAXPROCS).
cpus := runtime.NumCPU()

// Current number of goroutines (Gs that are alive).
gs := runtime.NumGoroutine()

// Voluntarily yield the P, moving the current G to the back of the queue.
runtime.Gosched()
```

Equivalently via environment (read once at startup):

```bash
GOMAXPROCS=4 ./myserver
```

> [!TIP]
> In Go 1.25+ prefer letting the runtime auto-detect from cgroup limits. Only pin `GOMAXPROCS` manually for older Go or special cases (benchmarks, latency isolation).

---

## 5. Common Interview Questions

**Q1. What do G, M, and P each represent, and why is P necessary?**
G = goroutine (work + stack), M = OS thread (executes), P = scheduling context holding the local run queue and an allocator cache. P exists to give each running thread a private run queue, eliminating the global-lock contention of the old GM scheduler and enabling work stealing and cache locality.
*Follow-up: How many Ms can exist?* Many — far more than P. Ms blocked in syscalls don't hold a P, and the runtime creates new Ms on demand (capped by `runtime/debug.SetMaxThreads`, default 10000).

**Q2. What does `GOMAXPROCS` actually control?**
The number of Ps — i.e., the maximum number of Gs running Go code *in parallel*. It does **not** cap goroutines or threads, only concurrent execution of Go code.
*Follow-up: Does setting it to 1 make your program single-threaded?* No — you still have multiple Ms (for syscalls, the GC, sysmon), but only one G executes Go code at a time. You still need synchronization, because preemption can interleave Gs at safepoints.

**Q3. A goroutine runs a blocking syscall (e.g., file read). What happens to its M and P?**
The G+M enter `_Gsyscall`; the P is handed off so another M can run other Gs and keep the core busy. When the syscall returns, the M tries to grab a free P; if none, the G is queued and the M parks.
*Follow-up: What if the syscall is very long?* `sysmon` retakes the P (after ~20 µs–10 ms) so it isn't stranded.

**Q4. How does work stealing work and why steal *half*?**
An idle P with an empty queue picks a random victim P and steals half its local run queue. Stealing half (vs. one) amortizes the synchronization cost and balances load faster, reducing repeated steal attempts.
*Follow-up: What's checked before stealing?* `runnext`, local queue, global queue, and the netpoller — stealing is the last resort.

**Q5. How did Go fix the "tight loop never yields" problem?**
Pre-1.14, preemption was cooperative at call safepoints, so a CPU-bound loop with no calls could monopolize a P. Go 1.14 added **asynchronous preemption**: sysmon signals (`SIGURG`) long-running Ms to insert a safepoint and reschedule.
*Follow-up: Can you still see starvation?* Rarely — e.g., non-preemptible regions, or pre-1.14 binaries; also `runtime.LockOSThread`-pinned Gs behave specially.

**Q6. Why are goroutines cheaper than threads?**
~2 KB growable stack vs. MBs for threads; scheduling in userspace (no kernel transition for channel/mutex blocking); batched run queues with locality. You can run millions of goroutines, not millions of threads.
*Follow-up: When does the stack grow?* On a function-prologue stack-bounds check; the runtime allocates a larger stack and copies frames (contiguous/copying stacks since Go 1.4).

**Q7. What is `runnext` and why does it exist?**
A single-slot fast path on each P holding the most-recently-made-runnable G, scheduled before the normal queue. It optimizes producer-consumer / ping-pong patterns (e.g., unbuffered channel handoff) for cache locality and low latency.
*Follow-up: Can it cause unfairness?* Slightly — but inheritance/time-slice limits prevent two Gs from starving the rest via `runnext`.

---

## 6. Production Use Cases

- **High-throughput HTTP/RPC servers** (Go's `net/http`, gRPC-Go, the Kubernetes API server, Caddy, Traefik): each request is a goroutine; the netpoller parks goroutines blocked on sockets so a handful of Ms serve tens of thousands of connections — the model that killed the C10K problem for Go shops.
- **Container/cgroup-bound deployments** (any service on Kubernetes): the historic GMP footgun is `GOMAXPROCS` defaulting to *host* core count inside a 1-core pod, causing excessive Ps, scheduler/GC overhead, and CPU throttling. Uber's **`automaxprocs`** library (set P from cgroup quota) became near-mandatory ops hygiene; Go 1.25 folds this into the runtime.
- **Worker pools / pipelines** (Kafka consumers, ETL, image processing): bounding worker goroutines to ~`GOMAXPROCS` for CPU-bound stages avoids oversubscription, while I/O-bound stages can run far more.
- **Databases & infra written in Go** (CockroachDB, TiDB, etcd, NATS, InfluxDB): tune `GOMAXPROCS` and goroutine pools to balance latency vs. throughput on large NUMA boxes.
- **Latency-sensitive isolation**: pinning a goroutine to an OS thread via `runtime.LockOSThread` for cgo/OpenGL/graphics or for `seccomp`/`setns` namespace work (used in container runtimes) interacts directly with M scheduling.

---

## 7. Common Mistakes

> [!WARNING]
> The single most common production GMP bug: running with default `GOMAXPROCS = host cores` inside a CPU-limited container, causing throttling, GC thrash, and p99 latency spikes. Fix: `automaxprocs` (pre-1.25) or upgrade to Go 1.25+.

- **Assuming `GOMAXPROCS` limits goroutine count.** It limits parallel Go execution, not how many Gs you create — leaking goroutines still OOMs you.
- **Over-tuning `GOMAXPROCS` manually.** Hardcoding it breaks when the deployment changes core allocation. Prefer auto-detection.
- **Blocking inside a fixed-size CPU worker pool with syscalls/cgo**, expecting the pool to absorb load — blocking Gs detach Ps and the runtime spawns more Ms, defeating your sizing intent.
- **Relying on goroutine scheduling order** — there are no ordering guarantees; `runnext`, stealing, and fairness injection all reshuffle.
- **`runtime.Gosched()` as a synchronization primitive** — it yields but guarantees nothing about progress; use channels/`sync` instead.
- **Forgetting `runtime.LockOSThread`/`UnlockOSThread` pairing**, which permanently dedicates an M to one G and removes it from general scheduling.

---

## 8. Performance Considerations

- **Oversubscription:** `GOMAXPROCS` > usable cores → more context switching, cache-line bouncing, and GC stop-the-world coordination cost. Undersubscription → idle cores.
- **Goroutine cost:** ~2 KB stack each; a million idle goroutines ≈ ~2 GB plus scheduler bookkeeping. Cheap, not free.
- **Local-queue locality:** keeping a producer/consumer on the same P (via `runnext`) avoids cross-core cache misses; spraying work across Ps via channels can hurt if data isn't shared.
- **Syscall-heavy workloads** spawn many Ms; thread creation and the OS scheduler now matter. For pure I/O, prefer the netpoller (non-blocking sockets) over blocking syscalls.
- **GC interaction:** GC workers also need Ps; under `GOMAXPROCS=1` the GC competes hard with your code, raising latency. Mark-assist steals from allocating goroutines.
- **False sharing & NUMA:** on big boxes, work stealing can move Gs across NUMA nodes; latency-critical services sometimes pin via cgroups + `GOMAXPROCS` per socket.
- **Tuned constants:** the 1/61 global-queue check and half-queue steal are tuned; micro-optimizing around them rarely pays — fix algorithmic oversubscription first.

---

## 9. Best Practices

- **Let the runtime size `GOMAXPROCS`.** Use Go 1.25+ cgroup awareness or `go.uber.org/automaxprocs` on older versions.
- **Bound CPU-bound worker pools to ≈`GOMAXPROCS`**; let I/O-bound work scale higher, but always **bound** it (semaphore / buffered channel) to prevent goroutine explosions.
- **Never leak goroutines:** every goroutine must have a clear exit path tied to a `context.Context` or a closed channel.
- **Prefer channels/`sync` for coordination**, not scheduler side effects (`Gosched`, sleeps).
- **Use `LockOSThread` only when required** (cgo with thread-local state, `setns`, graphics) and always unlock.
- **Profile before tuning** with `runtime/pprof` and the execution tracer; don't guess.
- **Set `GODEBUG=schedtrace=1000`** in staging to watch P/M/G balance under load.

---

## 10. Code Examples

A CPU-bound worker pool sized to the actual parallelism, with a clean shutdown — the idiomatic way to respect the GMP model:

```go
package main

import (
	"context"
	"fmt"
	"runtime"
	"sync"
)

func main() {
	workers := runtime.GOMAXPROCS(0) // match available Ps for CPU-bound work
	jobs := make(chan int, 1024)
	results := make(chan int, 1024)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-ctx.Done():
					return
				case j, ok := <-jobs:
					if !ok {
						return
					}
					results <- j * j // CPU work
				}
			}
		}()
	}

	go func() {
		for i := 0; i < 1000; i++ {
			jobs <- i
		}
		close(jobs)
	}()

	go func() { wg.Wait(); close(results) }()

	sum := 0
	for r := range results {
		sum += r
	}
	fmt.Println("sum:", sum, "workers:", workers, "goroutines:", runtime.NumGoroutine())
}
```

Container-safe `GOMAXPROCS` for pre-1.25 deployments — a blank import that auto-tunes Ps from the cgroup CPU quota at startup:

```go
package main

import (
	"fmt"
	"runtime"

	_ "go.uber.org/automaxprocs" // sets GOMAXPROCS from cgroup limits on init
)

func main() {
	// Inside a 2-core-limited pod on a 64-core host, this prints 2, not 64.
	fmt.Println("GOMAXPROCS =", runtime.GOMAXPROCS(0))
}
```

Observing the scheduler live without code changes — run any binary with scheduler tracing:

```bash
GODEBUG=schedtrace=1000,scheddetail=1 ./myserver
# Emits per-second lines: runqueue sizes, idle/spinning Ms, per-P queues.
```

---

## 11. Advanced Concepts

- **Spinning Ms:** to hide scheduling latency, the runtime keeps a bounded number of Ms "spinning" (actively looking for work) before parking, so a newly-readied G finds a CPU fast. This trades a little CPU burn for lower wake-up latency.
- **Handoff vs. retake:** on a syscall, the runtime can proactively hand off the P (handoff) or let `sysmon` retake it later. Short syscalls avoid handoff overhead; long ones get retaken.
- **`g0` and the system stack:** scheduling, GC, and stack growth run on the M's `g0` (a special goroutine with a large fixed stack), separate from user Gs. `systemstack()` switches to it.
- **Network poller integration:** `findRunnable` polls `epoll`/`kqueue`/IOCP; sockets are non-blocking under the hood, so a goroutine "blocked" on `conn.Read` is parked and re-readied by the poller without consuming an M.
- **Stack management:** contiguous, copying, growable stacks (since 1.4). The compiler inserts stack-bounds checks (morestack); growth copies the stack and rewrites pointers — invisible to you, but it's why goroutine stacks can start tiny.
- **Fairness mechanisms:** the 1/61 global-queue check, a `runnext` time-budget, and `sysmon`-driven async preemption together prevent starvation across local queues, hot slots, and CPU-bound Gs.
- **`LockOSThread` semantics:** binds curg↔M; the M won't run other Gs and isn't returned to the pool until unlock — essential for thread-local OS state, costly if overused.

---

## 12. Debugging Tips

- **`GODEBUG=schedtrace=1000`** — per-second scheduler summary: `gomaxprocs`, `idleprocs`, `threads`, `runqueue` (global), and per-P run-queue lengths. Add `scheddetail=1` for per-P/M/G detail.
- **Execution tracer:** `runtime/trace` + `go tool trace trace.out` shows G/P/M timelines, run-queue latency, syscall blocking, and GC — the best tool to *see* scheduling stalls.
- **`runtime.NumGoroutine()`** trending upward = a leak; confirm with `pprof.Lookup("goroutine").WriteTo(w, 1)` or `GET /debug/pprof/goroutine?debug=2` for full stacks.
- **`GODEBUG=asyncpreemptoff=1`** — disable async preemption to confirm a hang is preemption-related (diagnostic only, never in prod).
- **`GOTRACEBACK=all`** then send `SIGQUIT` (Ctrl-\\) to dump all goroutine stacks of a stuck process.
- **Look for many Ms** (high `threads` in schedtrace) → blocking syscalls/cgo detaching Ps; consider non-blocking I/O.

> [!TIP]
> If p99 latency rises under load but CPU isn't saturated, check run-queue latency in `go tool trace` — Gs waiting in queues usually means too few Ps for the offered parallelism, or a few Gs hogging Ps.

---

## 13. Senior Engineer Notes

A senior engineer treats the GMP model as a *latency and resource* lens during design and review:

- **In code review**, flag unbounded goroutine creation (`go handle(req)` in a loop with no semaphore), missing `context` cancellation, and `LockOSThread` without a paired unlock. Ask "what bounds this?" for every `go`.
- **Right-size pools by workload class**: CPU-bound ≈ `GOMAXPROCS`; I/O-bound bounded but larger. Reject "one goroutine per item" for huge inputs — apply backpressure via buffered channels or `errgroup` with `SetLimit`.
- **Know the container footgun cold** and make `automaxprocs` (or Go 1.25) a default in your service template. This single change has rescued countless p99 regressions after a host migration.
- **Mentor on the mental model**: "goroutines are cheap but not free; blocking is fine because the runtime parks you; don't rely on scheduling order." Teach `go tool trace` so juniors *see* the scheduler instead of guessing.
- **Use the tracer in incident review**, not folklore. Distinguish run-queue latency, syscall blocking, and GC assist as separate root causes.

---

## 14. Staff Engineer Notes

A staff engineer reasons about GMP at the **org and architecture** level:

- **Platform defaults & guardrails:** bake `GOMAXPROCS` cgroup-awareness, goroutine-leak detectors (e.g., `goleak` in CI), and pprof/trace endpoints into the org-wide service scaffold so every team gets correct behavior for free. This is leverage: fix the footgun once, not per team.
- **Capacity & cost trade-offs:** P sizing interacts with Kubernetes requests/limits, HPA, and bin-packing. Over-provisioning Ps wastes cluster CPU at fleet scale; under-provisioning hurts latency SLOs. Drive a documented policy (e.g., "limit == GOMAXPROCS, request ~70% of limit") across services.
- **Build vs. buy / language fit:** for ultra-low-latency or hard-real-time paths, recognize where the Go scheduler's non-determinism (async preemption, GC assist, stealing) is a poor fit and a different runtime (Rust, C++, dedicated thread pinning) is warranted — and where Go's M:N model is overwhelmingly the right call (network services, control planes).
- **NUMA & big-iron strategy:** decide org-wide whether to run one fat process per node (relying on GMP + stealing) or multiple pinned processes per socket. This is a cross-team architectural call affecting deployment, observability, and cost.
- **Risk management:** track runtime upgrades (1.14 async preemption, 1.25 cgroup `GOMAXPROCS`) as fleet-wide behavior changes requiring staged rollout and trace-based validation, not silent bumps.

---

## 15. Revision Summary

- **G/M/P:** G = goroutine (work+stack), M = OS thread (runs code), P = scheduling context with a 256-slot local run queue + mcache.
- **Invariant:** an M needs a P to run Go code; `GOMAXPROCS` = number of Ps = max parallel Go execution (not goroutine or thread count).
- **Find-next order:** `runnext` → local runq → global queue (1/61 for fairness) → netpoller → **steal half** from a random P.
- **Blocking:** channel/mutex parks the G in userspace (no thread switch); syscall detaches the P (handoff) so another M keeps the core busy; `sysmon` retakes stuck Ps.
- **Preemption:** cooperative pre-1.14 → **async signal-based (SIGURG) since 1.14**; fixes tight-loop starvation.
- **Footgun:** default `GOMAXPROCS = host cores` inside CPU-limited containers → throttling. Fix with `automaxprocs` or Go 1.25+.
- **Tooling:** `GODEBUG=schedtrace=1000`, `go tool trace`, `runtime.NumGoroutine()`, pprof goroutine profile.
- **Best practice:** auto-size Ps, bound every pool, tie goroutines to `context`, profile before tuning.

**References:** Go scheduler design doc (Dmitry Vyukov, "Scalable Go Scheduler Design"); Go source `runtime/proc.go`, `runtime/runtime2.go`; Go 1.14 async preemption and Go 1.25 cgroup-aware `GOMAXPROCS` release notes; `go.uber.org/automaxprocs`.

---

*Go Engineering Handbook — topic 47.*
