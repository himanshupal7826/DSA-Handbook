# 46 · Scheduler Internals

> **In one line:** Go's runtime multiplexes millions of goroutines onto a handful of OS threads using work-stealing run queues, cooperative-plus-asynchronous preemption, and a netpoller that hands off blocking syscalls without burning a thread.

---

## 1. Overview

The Go scheduler is the piece of the runtime that decides *which goroutine runs on which OS thread, when*. It is a **user-space, cooperative-ish, work-stealing scheduler** built around three core abstractions known by their internal letters: **G** (goroutine), **M** (machine, an OS thread), and **P** (processor, a scheduling context that holds a run queue and the resources needed to execute Go code).

The mental model that matters: you write `go f()` and a goroutine costs ~2 KB of initial stack and a tiny struct. The scheduler then time-shares those goroutines across `GOMAXPROCS` logical processors, steals work between them to stay balanced, parks threads that block in syscalls, and forcibly preempts goroutines that hog the CPU. Understanding this layer is the difference between "concurrency works by magic" and being able to diagnose a latency cliff under load.

This chapter assumes you know channels and goroutines and want to understand the machinery underneath: the **GMP model**, **local and global run queues**, **work stealing**, **preemption** (both cooperative and signal-based asynchronous preemption since Go 1.14), and **syscall handoff** via `handoffp` and the **netpoller**.

## 2. Why It Exists

Early concurrency runtimes mapped one user thread to one OS thread (1:1). OS threads are expensive: ~1 MB default stack, kernel scheduling overhead, expensive context switches (~1-2 µs through the kernel), and you can realistically run thousands but not millions. Languages that went the other way (pure green threads, N:1) couldn't use multiple cores and blocked the whole world on a single syscall.

Go chose **M:N scheduling** — many goroutines onto many OS threads — to get the best of both:

- **Cheap concurrency.** A goroutine starts at 2 KB and grows its stack on demand. You can have a million live goroutines.
- **Multicore parallelism.** `GOMAXPROCS` Ps run Go code in parallel, one per core by default.
- **Non-blocking I/O without callback hell.** Blocking-looking code (`conn.Read`) is internally turned into an epoll/kqueue registration via the netpoller, so a blocked goroutine doesn't cost a thread.
- **Fairness.** Work stealing and preemption stop one busy goroutine or one hot P from starving everyone else.

> [!NOTE]
> The scheduler is invisible by design. You rarely call into it directly. But its behavior leaks through `GOMAXPROCS`, syscall-heavy workloads, and tail latency — which is exactly why interviewers love it.

## 3. Internal Working

### The GMP data structures

Defined in `runtime/runtime2.go`:

- **G (`g`)** — a goroutine. Holds its stack bounds, the saved register set (`gobuf` with `sp`, `pc`, `g`, `bp`), a status (`_Grunnable`, `_Grunning`, `_Gwaiting`, `_Gsyscall`, `_Gdead`), and bookkeeping like `atomicstatus` and `preempt`.
- **M (`m`)** — an OS thread. Has a `g0` (a special scheduling goroutine with a fixed system stack used to run the scheduler itself), a pointer to its current `curg`, and a pointer to the `p` it is attached to.
- **P (`p`)** — a logical processor / scheduling context. There are exactly `GOMAXPROCS` of them. Each P owns a **local run queue**: a lock-free ring buffer `runq [256]guintptr` plus a single-slot `runnext` for the most-recently-readied goroutine (a latency optimization for ping-pong patterns). P also caches an mcache for allocation.

To run Go code you need the triple: a **G on an M holding a P**. No P, no Go execution.

```text
        Global Run Queue (lock-protected)
        +-----------------------------+
        | G  G  G  G  G  ...          |
        +-----------------------------+
                  ^   steals 1/2 when local empty
                  |
   +----------- P0 -----------+   +----------- P1 -----------+
   | runnext: [G]             |   | runnext: [G]             |
   | runq: [G][G][G][ ][ ]... |   | runq: [G][G][ ][ ][ ]... |
   +-----------+--------------+   +-----------+--------------+
               |                              |
              M0 (curg=G) ---steal--->       M1 (curg=G)
               |                              |
          OS thread                      OS thread
                                              |
                                  blocked in syscall? -> hand off P
                                              v
                            M2 picks up P, keeps it busy
```

### Scheduling loop

The heart is `schedule()` (in `runtime/proc.go`). When an M needs work it calls `findRunnable()`, which searches in priority order:

1. `runnext` then the local run queue of its P.
2. Every ~61st scheduler tick, check the **global run queue** first (anti-starvation, so global work isn't ignored forever).
3. The global run queue.
4. The **netpoller** (`netpoll(0)`) for goroutines whose I/O is ready.
5. **Work stealing**: randomly pick another P and steal *half* of its local run queue. It tries several random victims before giving up.

If nothing is found the M parks (sleeps on a futex) and is woken when work appears.

### Work stealing

When `findRunnable` steals, it takes half the victim's `runq` in one batch (`runqgrab`), which amortizes the synchronization cost. This keeps Ps balanced without a central lock. The `runnext` slot is *not* stolen immediately — it's given a brief grace period (the stealer spins briefly first) so a tight producer→consumer handoff isn't disrupted.

### Preemption

Two mechanisms:

- **Cooperative preemption (function-prologue based).** Originally the only kind. The compiler inserts a stack-bounds check at function entry. When the runtime wants to preempt a G it sets `g.stackguard0 = stackPreempt`; the next function call's prologue sees the poisoned guard and calls into the scheduler. The flaw: a tight loop with no function calls (`for {}`) never checks, so it could never be preempted — pre-1.14 this could hang GC and the whole program.
- **Asynchronous preemption (Go 1.14+).** The `sysmon` thread sends a `SIGURG` signal to a long-running M (after ~10 ms on a G). The signal handler checks whether the G is at a safe point and, if so, redirects it into `asyncPreempt`, saving register state and yielding. This is why even `for {}` is now preemptible.

### sysmon

A dedicated thread, `sysmon`, runs without a P. It: retakes Ps stuck in long syscalls, triggers async preemption of long-running Gs, runs the netpoller if it's been idle, and forces GC if it hasn't run in 2 minutes.

### Syscall handoff

When a goroutine enters a blocking syscall, `entersyscall` records that the M is about to block and **detaches the P from the M conceptually** by setting the P to `_Psyscall`. Two outcomes:

- **Fast syscall:** on return, `exitsyscall` tries to reacquire the *same* P (cheap, cache-friendly). If it can, execution continues with no scheduler involvement.
- **Slow syscall:** `sysmon` notices a P sitting in `_Psyscall` for >~20 µs and calls `handoffp`, which finds or spins up another M to take over that P so the remaining goroutines keep running. The blocked M, when the syscall finally returns, has no P; it puts its G on a run queue and parks itself in the idle M pool.

The **netpoller** avoids this dance entirely for network/file I/O on supported platforms: `conn.Read` doesn't do a blocking syscall — it registers the fd with epoll/kqueue/IOCP and parks the goroutine (`_Gwaiting`). The M stays free. When the fd is ready, `netpoll` returns the parked Gs as runnable. So 100k idle connections cost ~0 threads.

## 4. Syntax

There is no scheduler *syntax* — it's a runtime, not a language feature. But the knobs and observation points are:

```go
import "runtime"

// Set the number of Ps (logical processors running Go code).
runtime.GOMAXPROCS(8)        // returns previous value
n := runtime.GOMAXPROCS(-1)  // query without changing

// Yield the current P; put this G back on the run queue.
runtime.Gosched()

// Lock this goroutine to its current OS thread (e.g. for cgo/OpenGL).
runtime.LockOSThread()
runtime.UnlockOSThread()

// Introspection.
runtime.NumGoroutine() // count of live goroutines
runtime.NumCPU()       // physical logical CPUs visible
```

Environment / build-time controls: `GOMAXPROCS=4`, `GODEBUG=schedtrace=1000,scheddetail=1` (dump scheduler state every 1000 ms), `GODEBUG=asyncpreemptoff=1` (disable signal preemption for debugging).

> [!TIP]
> Since Go 1.5 `GOMAXPROCS` defaults to `runtime.NumCPU()`. In **containers**, `NumCPU` historically returned the *host* core count, not the cgroup quota — set `GOMAXPROCS` explicitly or use `automaxprocs`. Go 1.25 makes the runtime cgroup-aware by default.

## 5. Common Interview Questions

**Q1. Explain the GMP model.**
G = goroutine (work + stack + saved registers), M = OS thread, P = scheduling context owning a local run queue and the right to run Go code. You need G+M+P to execute. There are `GOMAXPROCS` Ps, many Ms, and potentially millions of Gs.
*Follow-up: Why have P at all — why not G on M directly?* P decouples "ability to run Go" from "OS thread." It lets a blocked M release its P so another M can keep that core busy, and it gives each P a lock-free local queue, removing the global-lock bottleneck of pre-1.1 Go.

**Q2. What is work stealing and why steal half?**
When a P's local queue is empty it steals from a random victim P. It takes half the victim's queue to amortize synchronization and to avoid immediately needing to steal again. Stealing balances load with no central coordinator.
*Follow-up: What's checked before stealing?* Local runnext/runq, then occasionally the global queue, then the global queue, then the netpoller, then stealing.

**Q3. Before Go 1.14 a `for {}` loop could hang the program. Why, and what changed?**
Preemption was cooperative via function prologues; a loop with no calls never hit a preemption check, so GC's stop-the-world could wait forever. Go 1.14 added **asynchronous preemption**: `sysmon` sends `SIGURG`, the handler yields at a safe point.
*Follow-up: Any downside to async preemption?* It can interrupt at more points, complicating debugging; some syscalls returning `EINTR` had to be made retry-safe. You can disable it with `GODEBUG=asyncpreemptoff=1`.

**Q4. What happens when a goroutine makes a blocking syscall?**
The P enters `_Psyscall`. If the syscall returns fast, the M reacquires the same P. If it's slow, `sysmon`/`handoffp` gives the P to another M so other goroutines keep running on that core; the blocked M parks when done.
*Follow-up: How is network I/O different?* It uses the netpoller (epoll/kqueue) — the goroutine parks, the M stays free, no handoff needed.

**Q5. What is the netpoller?**
An integration with the OS event mechanism (epoll/kqueue/IOCP). Blocking-looking network/file reads register the fd and park the goroutine; the scheduler resumes it when the fd is ready. Lets one thread serve thousands of connections.
*Follow-up: Who calls netpoll?* `findRunnable`, `sysmon`, and the GC — opportunistically whenever the scheduler looks for work.

**Q6. What does `runtime.Gosched()` do, and when would you use it?**
Voluntarily yields the P, moving the current G to the back of the run queue so others run. Rarely needed now that preemption is automatic; occasionally useful in tight benchmark loops or to be polite in a CPU-bound loop on old runtimes.
*Follow-up: Difference from `time.Sleep(0)`?* `Sleep(0)` also yields but routes through the timer machinery; `Gosched` is the direct scheduler primitive.

**Q7. What is `runnext` and why does it exist?**
A single-slot, higher-priority "next G to run" per P, set when a goroutine is readied (e.g. a channel send wakes a receiver). It optimizes ping-pong producer/consumer latency by running the just-woken G immediately instead of FIFO-queuing it.
*Follow-up: Does stealing take runnext?* Only after a short grace spin, to protect the handoff fast path.

**Q8. How does `GOMAXPROCS` relate to threads?**
It bounds the number of Ps (goroutines running Go code in parallel), not Ms. The runtime may create many more Ms (default cap 10,000) to cover blocking syscalls, but only `GOMAXPROCS` run Go code at once.
*Follow-up: In a container?* Set it to the CPU quota; otherwise you over-parallelize against your cgroup limit and get throttled.

## 6. Production Use Cases

- **High-fan-out network servers** (gRPC services at Google, Uber, Cloudflare). The netpoller is *the* reason a single Go process can hold hundreds of thousands of idle connections cheaply — the architecture behind much of Cloudflare's edge and Discord's gateway.
- **`automaxprocs` (Uber).** A near-mandatory library in Kubernetes deployments that reads the cgroup CPU quota and sets `GOMAXPROCS` correctly, eliminating CPU-throttling-induced tail latency. Used widely before the runtime fixed it natively in 1.25.
- **Latency-sensitive trading / streaming systems** pin goroutines with `LockOSThread` for cgo or thread-affinity-sensitive work, and tune `GOMAXPROCS` to leave headroom for GC.
- **Database drivers and proxies** (e.g. Vitess, CockroachDB) rely on syscall handoff so a slow disk read on one connection doesn't stall the pool.
- **CPU-bound batch pipelines** lean on work stealing to keep all cores saturated without manual partitioning.

## 7. Common Mistakes

- **Assuming `GOMAXPROCS` == thread count.** It's the Go-code parallelism cap; the runtime spawns extra Ms for syscalls.
- **Ignoring containers.** Host `NumCPU` of 64 with a 2-core quota → 64 Ps fighting over 2 cores → constant CFS throttling and p99 spikes. Use `automaxprocs` or Go 1.25+.
- **Tight non-yielding loops on old Go.** `for { work() }` with no allocations/calls pre-1.14 could stall GC; even now, busy-spinning wastes a whole P.
- **Blocking the whole program via cgo.** A cgo call is a blocking syscall from the scheduler's view; thousands of slow cgo calls exhaust the M pool (default 10,000) and the program aborts.
- **`runtime.LockOSThread()` without unlock**, or leaking locked goroutines — the locked M can't be reused, and an exiting locked main goroutine kills the thread.
- **Goroutine leaks** that pile up in `_Gwaiting` forever, bloating scheduler bookkeeping and memory.

## 8. Performance Considerations

- **Context switch cost.** A goroutine switch is ~tens of nanoseconds (just register save/restore in user space) vs ~1-2 µs for an OS thread switch. This is why fine-grained concurrency is viable.
- **runnext fast path** makes channel ping-pong nearly free; designing pipelines around handoffs benefits.
- **Work stealing has cost.** Under heavy imbalance, stealers spin and contend; pathological many-tiny-goroutine workloads can spend real time in the scheduler. Batch work when goroutines are tiny.
- **Global run queue is lock-protected.** Excessive spawning that overflows local queues (>256) spills to the global queue and serializes — prefer worker pools for sustained high throughput.
- **GOMAXPROCS and GC.** GC workers consume Ps; over-setting `GOMAXPROCS` past physical cores rarely helps CPU-bound work and worsens cache behavior.
- **Syscall handoff latency.** The ~20 µs sysmon detection window means a burst of slow syscalls briefly under-utilizes cores until handoff catches up.

> [!WARNING]
> The single biggest real-world scheduler perf bug is **CPU throttling in Kubernetes** from a wrong `GOMAXPROCS`. It shows up as p99 latency 5-10x p50 with low average CPU. Fix the P count before micro-optimizing anything.

## 9. Best Practices

- Set `GOMAXPROCS` to your cgroup CPU limit in containers (`automaxprocs`, or rely on Go 1.25+).
- Use bounded **worker pools** for high-volume tiny tasks rather than `go` per item — caps goroutines and keeps local queues hot.
- Avoid `LockOSThread` unless required by cgo/graphics; always pair lock/unlock with `defer`.
- Don't sprinkle `runtime.Gosched()` — trust preemption; reach for it only with measured evidence.
- Keep syscalls (especially cgo) off the hot path or pool them; they consume Ms.
- Profile scheduler behavior with `runtime/trace`, not guesses.
- Prevent goroutine leaks with `context` cancellation and timeouts so Gs don't accumulate in `_Gwaiting`.

## 10. Code Examples

Primary: observing the scheduler with `GODEBUG=schedtrace` and demonstrating work distribution.

```go
package main

import (
	"fmt"
	"runtime"
	"sync"
)

// Run with: GODEBUG=schedtrace=200,scheddetail=1 go run main.go
// to watch run queues, Ps, Ms, and steals in real time.
func main() {
	fmt.Println("GOMAXPROCS:", runtime.GOMAXPROCS(-1))
	fmt.Println("NumCPU:    ", runtime.NumCPU())

	var wg sync.WaitGroup
	results := make([]int, runtime.GOMAXPROCS(-1)*4)

	// Spawn CPU-bound goroutines; work stealing keeps all Ps busy.
	for i := range results {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			sum := 0
			for n := 0; n < 5_000_000; n++ {
				sum += n % (idx + 1)
			}
			results[idx] = sum
		}(i)
	}
	wg.Wait()
	fmt.Println("done, goroutines now:", runtime.NumGoroutine())
}
```

Alternative: a bounded worker pool — the idiomatic way to keep the scheduler healthy under high task volume instead of `go` per item.

```go
package main

import (
	"runtime"
	"sync"
)

func process(tasks <-chan int, out chan<- int, wg *sync.WaitGroup) {
	defer wg.Done()
	for t := range tasks {
		out <- t * t // pretend work
	}
}

func main() {
	workers := runtime.GOMAXPROCS(-1) // one worker per P
	tasks := make(chan int, 1024)
	out := make(chan int, 1024)

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go process(tasks, out, &wg)
	}

	go func() {
		for i := 0; i < 100_000; i++ {
			tasks <- i
		}
		close(tasks)
	}()

	go func() { wg.Wait(); close(out) }()

	total := 0
	for range out {
		total++
	}
	_ = total
}
```

The first version shows raw parallelism and stealing; the second caps goroutine count so local run queues stay hot and you never spill 100k Gs into the global queue.

## 11. Advanced Concepts

- **Spinning Ms and `nmspinning`.** To reduce wake-up latency, the runtime keeps a small number of Ms actively *spinning* looking for work (capped at half of GOMAXPROCS) before parking. This trades a little CPU for lower scheduling latency on bursty workloads.
- **`runqsteal` grace for runnext.** The stealer spins briefly before grabbing a victim's `runnext`, preserving the producer/consumer fast path.
- **Timer Ps.** Since Go 1.14, timers live on Ps (`p.timers`), making `time.After`/`time.Timer` cheap and locally schedulable instead of routed through one global timer goroutine.
- **`gcBgMarkWorker` and fractional workers.** GC mark workers are scheduled as goroutines competing for Ps; "fractional" workers run partially to hit the 25% CPU mark target without monopolizing a P.
- **Safe points.** Async preemption only happens where the stack/registers are describable to the GC. The compiler emits **stack maps** at these points; the signal handler bails if interrupted mid-non-safe-point.
- **`asyncPreempt` register save.** On preemption the runtime saves the *entire* register set to the stack (more than a normal call), which is why async-preempted frames look unusual in stack traces.
- **Forced GC and sysmon's 2-minute timer** ensure liveness even on idle programs.

## 12. Debugging Tips

- **`GODEBUG=schedtrace=1000`** prints, every second: `gomaxprocs`, `idleprocs`, `threads`, `runqueue` (global), and per-P run queue lengths. High global `runqueue` with idle Ps signals a stealing/spawn problem; many threads signals syscall-heavy load.
- **`GODEBUG=scheddetail=1`** adds per-G and per-M detail — verbose, use briefly.
- **`runtime/trace`** + `go tool trace`: the gold standard. Shows per-P timelines, goroutine blocking, syscall blocking, GC, and network-wait. Look for gaps (idle Ps) and long syscall bars.
- **`pprof` goroutine profile** (`/debug/pprof/goroutine?debug=2`): find leaks and stuck `_Gwaiting` goroutines with full stacks.
- **`GODEBUG=asyncpreemptoff=1`** to test whether a heisenbug is preemption-related.
- **Container check:** log `runtime.GOMAXPROCS(-1)` and `runtime.NumCPU()` at startup; mismatch with your CPU limit is the smoking gun for throttling.

```text
SCHED 1010ms: gomaxprocs=8 idleprocs=6 threads=12 spinningthreads=1
              idlethreads=4 runqueue=53 [3 0 0 0 0 0 0 0]
                                         ^global backlog  ^per-P (P0 has 3)
```

## 13. Senior Engineer Notes

As a senior engineer your job is to make the scheduler a non-issue for your team through good defaults and sharp reviews:

- **In code review**, flag `go` inside unbounded loops over external input — that's a goroutine-leak / scheduler-overload bug waiting for production. Push for worker pools with bounded concurrency and `context` cancellation.
- **Own the container config.** Make `automaxprocs` (or Go 1.25+) a baseline in your service template. This single decision prevents the most common production latency incident.
- **Mentor on the mental model**, not internals trivia. Engineers should know: goroutines are cheap but not free, blocking syscalls cost threads, and `GOMAXPROCS` is parallelism not thread count. They do *not* need to recite `findRunnable`'s order.
- **Reach for `runtime/trace` before speculation.** Teach the team to read a trace; "p99 is bad" → trace → "we block on a sync.Mutex / a slow cgo call" is a repeatable workflow.
- **Resist `LockOSThread`, `Gosched`, and manual `GOMAXPROCS` tuning** in PRs unless backed by a benchmark. They're almost always cargo-culted.

## 14. Staff Engineer Notes

At staff level the scheduler informs architecture and org-wide standards:

- **Concurrency budget as a platform concern.** Decide org-wide how services bound concurrency (pool sizes, semaphores, queue depths) so back-pressure is consistent and one team's fan-out doesn't melt a shared dependency. Encode it in shared libraries, not tribal knowledge.
- **Build-vs-buy for runtime tuning.** Standardize on `automaxprocs` / a runtime-version baseline across the fleet rather than each team hand-tuning. Drive the Go-version upgrade that makes cgroup-awareness automatic (1.25), and quantify the latency win to justify the migration.
- **Cross-team latency forensics.** Tail-latency regressions often span the boundary between the scheduler (CPU throttling, GC) and the platform (Kubernetes CPU limits, noisy neighbors). Staff engineers connect "p99 doubled" to "we lowered the CPU quota" — a conversation spanning app, runtime, and infra teams.
- **Language/runtime selection.** When evaluating Go vs alternatives (Rust async, JVM virtual threads/Loom) for a new platform, the M:N scheduler + netpoller is a concrete differentiator for connection-heavy services; articulate it with numbers, not vibes.
- **cgo and FFI strategy.** Heavy cgo undermines the scheduler's thread model; at the architecture level, prefer pure-Go implementations or out-of-process services for hot paths, and set policy on when cgo is acceptable.
- **Capacity planning.** Model that a Go service's effective parallelism is `min(GOMAXPROCS, cores)` minus GC overhead (~25% during marking) — feeds directly into right-sizing and cost.

## 15. Revision Summary

- **GMP:** G = goroutine, M = OS thread, P = scheduling context (run queue + right to run Go). Need G+M+P to execute; exactly `GOMAXPROCS` Ps.
- **Run queues:** per-P local lock-free `runq[256]` + `runnext` single slot; global lock-protected queue for spillover and fairness (checked every ~61 ticks).
- **findRunnable order:** runnext/local → (periodic) global → global → netpoller → steal half from a random P.
- **Preemption:** cooperative via function prologue (`stackguard0=stackPreempt`); async via `SIGURG` from sysmon after ~10 ms (Go 1.14+) — fixes the `for {}` hang.
- **Syscalls:** fast → reacquire same P; slow → `sysmon`/`handoffp` gives P to another M. Network I/O uses the **netpoller** (epoll/kqueue/IOCP), parking the G with zero thread cost.
- **sysmon:** P-less thread that retakes syscall Ps, triggers preemption, polls the net, forces GC.
- **Production trap:** wrong `GOMAXPROCS` in containers → CPU throttling → p99 blowup. Fix with `automaxprocs` / Go 1.25+.
- **Tools:** `GODEBUG=schedtrace=N`, `runtime/trace` + `go tool trace`, goroutine pprof.

**References:** Go scheduler design (Dmitry Vyukov's "Scalable Go Scheduler Design Doc"); `runtime/proc.go`, `runtime/runtime2.go`; Go 1.14 async preemption proposal; Uber `automaxprocs`; Go 1.25 cgroup-aware GOMAXPROCS release notes.

---

*Go Engineering Handbook — topic 46.*
