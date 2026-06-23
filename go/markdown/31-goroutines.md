# 31 · Goroutines

> **In one line:** Goroutines are cheap, runtime-scheduled green threads with growable stacks that let a single Go program run hundreds of thousands of concurrent tasks over a handful of OS threads.

---

## 1. Overview

A *goroutine* is a function executing concurrently with other goroutines in the same address space. You start one by prefixing a call with the `go` keyword. Unlike an OS thread — which costs ~1–2 MB of fixed stack and a kernel-mediated context switch — a goroutine starts with a tiny **2 KB stack** that grows and shrinks on demand, and is multiplexed onto OS threads by the Go runtime scheduler.

The result is that "spawn a goroutine per request" or "per connection" is not just acceptable in Go; it is the idiomatic design. A modern server can hold *millions* of goroutines, where the same C or Java service would exhaust memory after a few thousand threads.

Goroutines are the **execution** half of Go's concurrency model. The **communication** half is channels ("Do not communicate by sharing memory; instead, share memory by communicating" — Go blog: Concurrency). This chapter is about the execution half: what a goroutine *is*, how the runtime schedules it, and how to use them without leaking or corrupting state.

## 2. Why It Exists

Concurrency primitives existed long before Go. So why a new abstraction?

- **OS threads are too expensive to use as the unit of concurrency.** With a 1 MB stack each, 10,000 threads cost ~10 GB of address space and the kernel scheduler thrashes on context switches (~1–2 µs each, plus cache pollution). You are forced into thread pools, callbacks, and event loops.
- **Event loops (epoll/libuv/Node.js) avoid the thread cost but invert your control flow.** Everything becomes callbacks or `async/await`; blocking I/O is forbidden; stack traces become useless. This is "callback hell" / "function coloring."
- **Goroutines give you the readability of blocking, synchronous code with the scalability of an event loop.** You write `conn.Read(buf)` as a straight-line blocking call; the runtime transparently parks the goroutine and runs something else on that OS thread. The kernel's `epoll` is hidden behind the **netpoller**.

So goroutines exist to make *synchronous-looking code scale like asynchronous code*, without coloring functions or hand-managing thread pools.

## 3. Internal Working

A goroutine is a `g` struct in the runtime (`runtime/runtime2.go`). The scheduler is the **G-M-P model**:

- **G** — a goroutine: its stack, instruction pointer, status, and scheduling bookkeeping.
- **M** — a *machine*, i.e. an OS thread. Code only ever runs on an M.
- **P** — a *processor*: a scheduling context holding a local run queue of runnable Gs. The number of Ps is `GOMAXPROCS` (default = number of CPUs). An M must hold a P to run Go code.

```text
            GOMAXPROCS = 4
   ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐
   │  P0  │  │  P1  │  │  P2  │  │  P3  │   each P has a LOCAL run queue
   │[G,G] │  │[G]   │  │[G,G,G]│ │[]    │
   └──┬───┘  └──┬───┘  └──┬───┘  └──┬───┘
      │M0       │M1       │M2       │(idle)
   (OS thr)  (OS thr)  (OS thr)
                                    ▲
   GLOBAL run queue: [G,G,...] ─────┘  (overflow + fairness)

   M blocked in syscall ─► P detaches, handed to another M (handoff)
   P empty ─► work-stealing: steal half of another P's local queue
```

Key runtime behaviors:

- **Growable stacks.** Each goroutine starts at 2 KB. The compiler inserts a *stack-bounds check* in the function prologue. When a call would overflow, the runtime allocates a larger contiguous stack (doubling), copies frames, and rewrites pointers (*copying stacks*, replacing the old segmented-stack scheme since Go 1.4). Stacks also shrink during GC.
- **Cooperative + asynchronous preemption.** Historically Go preempted only at function-call safepoints. A tight loop with no calls could hog a P forever. Since **Go 1.14**, the runtime uses signal-based **asynchronous preemption**: `sysmon` sends a `SIGURG` to an M running a G for >10 ms, forcing it to yield.
- **The netpoller.** Blocking network I/O does not block the OS thread. The goroutine registers its fd with `epoll`/`kqueue`/IOCP and parks; the M is freed to run other Gs. When the fd is ready, the poller makes the G runnable again.
- **Syscall handling.** A blocking *file* syscall (or cgo) does block its M. `sysmon` detects this and **hands off the P** to another M so the other Gs keep running. This is why a few thousand blocking syscalls can spike OS thread counts.
- **Work-stealing & fairness.** An idle P steals half of another P's queue. To avoid starvation, every 61st schedule tick a P checks the global queue, and there is a `runnext` slot for the most recently readied G (improves locality for ping-pong patterns).

## 4. Syntax

```go
go f(x, y, z) // f runs concurrently; arguments are evaluated NOW, on the caller

go func() { // anonymous goroutine; closes over outer variables
    doWork()
}()

// Capturing loop variables: safe in Go 1.22+ (each iteration has its own var).
// In Go <1.21 you MUST pass as an argument or copy:
for _, item := range items {
    item := item // pre-1.22 shadow
    go process(item)
}
```

There is no return value and no handle: `go f()` returns nothing. You cannot "join" a goroutine directly — you coordinate via channels, `sync.WaitGroup`, or `context`.

## 5. Common Interview Questions

**Q1. What's the difference between a goroutine and an OS thread?**
A goroutine is a user-space construct scheduled by the Go runtime onto OS threads (M:N). It starts at 2 KB (vs ~1 MB), switches in ~tens of ns without a kernel trap, and you can have millions. *Follow-up: who decides how many OS threads exist?* The runtime; `GOMAXPROCS` caps the number of Ps (Gs running Go code in parallel), but the M count can exceed it when threads block in syscalls.

**Q2. What does `go f()` return, and how do you get a result back?**
Nothing. You get results via a channel, a shared variable guarded by a mutex/atomic, or by closing over a result slot synchronized with a `WaitGroup`. *Follow-up: why no future/promise built in?* Go's model favors explicit communication via channels over implicit futures; `errgroup` builds future-like semantics on top.

**Q3. What is a goroutine leak and how do you detect one?**
A goroutine that blocks forever (on a channel send/receive with no counterpart, or a `nil` channel) and is never collected — goroutines are *not* GC'd while blocked. Detect with `runtime.NumGoroutine()`, pprof's goroutine profile, or `go.uber.org/goleak` in tests. *Follow-up: a common cause?* A producer sending to a channel after the consumer returned early (e.g. on context cancellation) with no buffer and no `select`.

**Q4. Does spawning a goroutine guarantee it runs immediately or in parallel?**
No. It becomes *runnable*; the scheduler runs it when a P is free. With `GOMAXPROCS=1` you still get concurrency but no parallelism. *Follow-up: will `go f(); fmt.Println("done")` print before or after f?* Undefined — there's no ordering without explicit synchronization.

**Q5. What happens if `main` returns while goroutines are still running?**
The program exits immediately; remaining goroutines are killed mid-flight, deferred funcs do not run. You must block `main` (WaitGroup/channel/signal) until they finish. *Follow-up: what about an unrecovered panic in a goroutine?* It crashes the *entire* process — panics do not stay contained to one goroutine.

**Q6. How does Go preempt a goroutine stuck in a tight CPU loop?**
Since Go 1.14, asynchronous preemption: `sysmon` signals the M with `SIGURG` after ~10 ms, the handler parks the G at a safepoint. Before 1.14 such a loop could starve other goroutines (a classic deadlock-at-GOMAXPROCS=1 puzzle). *Follow-up: how did it work before?* Only cooperatively, at function-call preemption points.

**Q7. What is the cost of one goroutine, and can you have a million?**
~2 KB initial stack plus a small `g` struct (~a few hundred bytes). Yes — a million idle goroutines is ~2 GB+, routinely seen in connection-heavy proxies. *Follow-up: what limits the practical maximum?* Memory (stacks), scheduler overhead, and contention on shared resources — not an artificial thread cap.

## 6. Production Use Cases

- **Per-connection / per-request servers.** Go's `net/http` spawns a goroutine per request; gRPC-Go spawns per stream. This is why Go is dominant in API gateways and proxies — **Caddy**, **Traefik**, and **Cloudflare's** edge tooling lean on goroutine-per-connection.
- **Fan-out / fan-in pipelines.** Crawlers, ETL, and batch processors fan work across N worker goroutines reading from one channel. **Docker** and **Kubernetes** (both Go) use goroutines pervasively for controllers and watch loops.
- **Background workers & reconciliation loops.** Kubernetes controllers run informer/worker goroutines; `etcd` runs raft and lease goroutines.
- **Timeouts and racing requests.** `select` over a worker goroutine and `context.Done()` to implement deadlines, hedged requests, and "first response wins" patterns.
- **Streaming & pub/sub.** **NATS** and **NSQ** (Go message brokers) run goroutines per subscriber/connection.

## 7. Common Mistakes

> [!WARNING]
> The mistakes below cause the majority of real Go concurrency incidents.

- **Goroutine leaks** — spawning workers that block forever because nobody reads/closes their channel or cancels their context.
- **Fire-and-forget with no lifecycle** — `go doWork()` with no way to wait, cancel, or observe failure. Background work outlives the request that needed it.
- **Capturing the loop variable (pre-1.22)** — all goroutines see the final value. Fixed by language change in 1.22, but still a trap on older codebases.
- **Unrecovered panic in a goroutine** — takes down the whole process. Worker goroutines need a `recover` boundary if a panic should be survivable.
- **Unbounded goroutine creation** — `go handle()` per item from an unbounded source (e.g. a Kafka topic) → memory blowup. Use a worker pool or semaphore.
- **Data races** — two goroutines touching the same variable without synchronization. Compiles fine, corrupts silently; catch with `-race`.

## 8. Performance Considerations

- **Creation is cheap but not free.** ~1–3 µs and 2 KB. For sub-microsecond tasks, a goroutine per task is pure overhead — batch them.
- **Stack growth is the hidden cost.** Deeply recursive or large-local-variable functions trigger stack-copy events; profile with `runtime/pprof` if you see unexplained latency. Avoid huge arrays on the stack in hot goroutines.
- **GOMAXPROCS tuning.** Defaults to logical CPUs. In containers, set it to the CPU *limit* (Go 1.25 reads cgroup limits automatically; before that use `uber-go/automaxprocs`) — otherwise the scheduler oversubscribes and thrashes.
- **Channel contention vs sharding.** A single channel hit by thousands of goroutines becomes a contention point. Shard work queues per-P-style, or use buffered channels / atomics where ordering allows.
- **Bounded concurrency beats unbounded.** A pool of `runtime.NumCPU()` workers usually outperforms millions of goroutines fighting for CPU and cache lines.

| Property | OS thread | Goroutine |
|---|---|---|
| Initial stack | ~1–2 MB (fixed) | 2 KB (growable) |
| Creation cost | ~µs–ms, kernel | ~1–3 µs, user-space |
| Context switch | kernel trap (~1–2 µs) | scheduler (~tens of ns) |
| Practical count | thousands | millions |
| Scheduled by | OS kernel | Go runtime (G-M-P) |

## 9. Best Practices

- **Every goroutine needs an owner who knows when it ends.** If you can't answer "how does this stop?", you have a latent leak.
- **Pass `context.Context` for cancellation/deadlines**, and `select` on `ctx.Done()` in long-running loops.
- **Prefer `sync.WaitGroup` or `golang.org/x/sync/errgroup`** for "wait for N tasks and collect the first error."
- **Bound concurrency** with a worker pool or a semaphore (`golang.org/x/sync/semaphore`, or a buffered channel as a token bucket).
- **Don't start a goroutine in a library function and not document its lifecycle** — surprising background goroutines break callers.
- **Wrap risky workers in `recover`** if a single task's panic shouldn't kill the process.
- **Run tests with `-race`** and `goleak.VerifyTestMain` in CI.

> [!TIP]
> "Make the zero value useful" extends to concurrency: design so a goroutine's exit path is obvious from its spawn site — ideally on the same screen.

## 10. Code Examples

Primary idiom: bounded worker pool with `WaitGroup` and context-aware shutdown.

```go
package main

import (
	"context"
	"fmt"
	"sync"
)

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	jobs := make(chan int)
	results := make(chan int)

	const workers = 4
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			for j := range jobs { // exits when jobs is closed
				select {
				case results <- j * j:
				case <-ctx.Done(): // never block on a dead consumer
					return
				}
			}
		}(i)
	}

	go func() { // feeder
		defer close(jobs)
		for n := 1; n <= 10; n++ {
			jobs <- n
		}
	}()

	go func() { // close results once all workers are done
		wg.Wait()
		close(results)
	}()

	for r := range results {
		fmt.Println(r)
	}
}
```

```go
package main

import (
	"context"
	"fmt"

	"golang.org/x/sync/errgroup"
)

// Same fan-out using errgroup: bounded concurrency + first-error propagation.
func main() {
	g, ctx := errgroup.WithContext(context.Background())
	g.SetLimit(4) // cap concurrent goroutines

	results := make([]int, 10)
	for i := 0; i < 10; i++ {
		i := i
		g.Go(func() error {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			results[i] = i * i // disjoint indices => no race
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		fmt.Println("failed:", err)
		return
	}
	fmt.Println(results)
}
```

A separate, minimal example of the **classic leak** to internalize the failure mode:

```go
func leak() {
	ch := make(chan int) // unbuffered
	go func() {
		ch <- 42 // blocks forever: nobody ever receives
	}()
	// function returns; the goroutine is parked for the life of the program
}
```

## 11. Advanced Concepts

- **`runtime.Gosched()`** yields the current P voluntarily — rarely needed since async preemption, but useful in tight loops on old runtimes or to nudge fairness in benchmarks.
- **`runtime.LockOSThread()`** pins a goroutine to its M. Required for thread-local OS state: OpenGL contexts, some C libraries, `syscall.Setns`, and signal handling. `main`'s init does this implicitly for signal delivery.
- **GC interaction.** Goroutine stacks are GC roots and are scanned (and shrunk) during the mark phase. A goroutine blocked on a channel holds references — a leaked goroutine can pin large objects in memory, turning a goroutine leak into a memory leak.
- **Scheduler tracing.** `GODEBUG=schedtrace=1000,scheddetail=1` prints per-P/per-M scheduler state every second — invaluable for diagnosing oversubscription or starvation.
- **The `runnext` optimization.** A freshly readied G goes into the P's `runnext` slot, not the tail of the queue, so request/response ping-pong stays on the same CPU and warm in cache.
- **Spinning Ms.** To reduce wakeup latency, the runtime keeps a small number of spinning Ms looking for work before truly sleeping — a CPU/latency trade-off you can observe in flame graphs as `runtime.findRunnable`.

## 12. Debugging Tips

- **Count goroutines:** `runtime.NumGoroutine()`. A monotonically rising count under steady load = a leak.
- **Goroutine profile / full dump:** `import _ "net/http/pprof"` then `go tool pprof http://host/debug/pprof/goroutine`, or `GET /debug/pprof/goroutine?debug=2` for a full stack dump showing exactly *where* each goroutine is blocked and *for how long*.
- **Send `SIGQUIT`** (Ctrl-\\) to any Go program to dump all goroutine stacks to stderr — the fastest way to see a hung process's state in production.
- **`-race` flag** for data races; it instruments memory accesses (5–10× slowdown, ~5–10× memory) — run it in CI, not prod.
- **`go.uber.org/goleak`** fails a test if goroutines outlive it.
- **Deadlock:** "fatal error: all goroutines are asleep - deadlock!" means *every* goroutine is blocked; the runtime detects only total deadlock, not partial.

## 13. Senior Engineer Notes

A senior engineer is judged on whether their concurrent code is *correct under review and operable in production*.

- **In code review, your first question is always "who closes this / who cancels this?"** Reject any `go` without a visible termination path. A leak that ships is a 3am page weeks later.
- **Default to bounded concurrency.** Reviewers should be suspicious of `go` inside an unbounded loop; push for `errgroup.SetLimit` or a semaphore. "It works in the demo" hides the cardinality bug.
- **Treat data races as P0.** A `-race` failure is never "flaky" — it's a real bug the test happened to catch.
- **Mentoring move:** teach juniors the difference between *concurrency* (structure: independently executing parts) and *parallelism* (execution: actually simultaneous). Most "make it faster with goroutines" requests are really latency or contention problems where more goroutines make things worse.
- **Prefer the simplest primitive that works:** a `WaitGroup` over a hand-rolled channel counter; an atomic over a mutex over a channel — only when the semantics genuinely call for it.

## 14. Staff Engineer Notes

A staff engineer reasons about goroutines at the level of *system architecture and organizational cost*.

- **Goroutine-per-X is a capacity-planning decision, not just a coding style.** Per-connection goroutines mean your memory ceiling scales with concurrent connections; model it explicitly (connections × avg stack) before promising SLOs. For 10M-connection edge systems, you may need to push backpressure to the LB rather than absorb everything in-process.
- **Set org-wide guardrails.** Standardize on `errgroup`/`context` patterns, mandate `-race` and `goleak` in the shared CI template, and ship a vetted worker-pool library so every team isn't re-implementing (and re-leaking) the same thing.
- **GOMAXPROCS in containers is a fleet-wide footgun.** A staff engineer ensures `automaxprocs` (or Go 1.25+ cgroup awareness) is baked into the base image — the cost of getting this wrong is silent CPU throttling and tail-latency regressions across hundreds of services.
- **Build-vs-buy:** for distributed work, don't reach for goroutines across machines. Goroutines solve *in-process* concurrency; cross-node fan-out belongs to a queue (Kafka/NATS/SQS) or a workflow engine (Temporal). Knowing the boundary prevents teams from building fragile in-memory schedulers that lose work on restart.
- **Cross-team failure modes:** a library that silently spawns background goroutines becomes everyone's incident. Enforce that shared libraries accept a `context` and document their goroutine lifecycle as part of the API contract.

## 15. Revision Summary

- Goroutine = runtime-scheduled green thread; start with `go f()`; **2 KB growable stack**, millions feasible.
- **G-M-P scheduler:** G = goroutine, M = OS thread, P = scheduling context (count = `GOMAXPROCS`); work-stealing + global queue for fairness.
- **Growable stacks** via copying; **async preemption** (SIGURG, >10 ms) since Go 1.14; **netpoller** keeps blocking I/O from blocking threads.
- `go f()` returns nothing — coordinate with channels, `WaitGroup`, `errgroup`, `context`.
- **Leaks** = goroutines blocked forever (never GC'd, can pin memory); detect with pprof goroutine profile, `NumGoroutine`, `goleak`.
- Panics in a goroutine crash the **whole process**; `main` returning kills all goroutines.
- Best practice: every goroutine has an owner + termination path; bound concurrency; pass context; run `-race`.
- Debug: `SIGQUIT` stack dump, `pprof/goroutine?debug=2`, `GODEBUG=schedtrace=...`.

**References:** Go blog: *Concurrency* ("Share memory by communicating"); Go runtime source (`runtime/proc.go`, `runtime/runtime2.go`); `golang.org/x/sync/errgroup`; `go.uber.org/goleak`; `uber-go/automaxprocs`.

---
*Go Engineering Handbook — topic 31.*
