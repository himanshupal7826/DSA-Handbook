# 1 · Introduction to Go

> **In one line:** Go is a statically typed, compiled, garbage-collected language built at Google to make large-scale backend engineering simple, fast to build, and easy to operate.

---

## 1. Overview

Go (often called **golang** because of its `go.dev` / `golang.org` web home) is a general-purpose programming language that occupies a deliberate sweet spot: it has the runtime safety of a garbage-collected language, the deployment story of a natively **compiled** binary, and a type system that is **statically** checked yet stays out of your way.

The headline properties you should be able to recite in an interview:

| Property | Go's choice | Consequence |
| --- | --- | --- |
| Typing | Static, structural for interfaces | Errors caught at compile time; no class hierarchies |
| Compilation | Ahead-of-time to a single native binary | No VM, no JIT warmup, trivial deploys |
| Memory | Garbage collected (concurrent, low-pause) | No manual `free`, sub-millisecond GC pauses |
| Concurrency | Goroutines + channels (CSP model) | Cheap concurrency baked into the language |
| Toolchain | One tool (`go`) for build/test/fmt/vet | Near-zero build-config bikeshedding |

Go is *small on purpose*. The language spec fits in an afternoon. The payoff is consistency: a Go codebase written by 200 engineers reads like it was written by one, largely because `gofmt` removes formatting debate and the standard library sets idioms.

> [!NOTE]
> "Go" is the language; "golang" is the search-engine-friendly nickname and module path. They are the same thing.

## 2. Why It Exists

Go was created at Google in 2007 (public release 2009) by Robert Griesemer, Rob Pike, and Ken Thompson. The origin story is a war story: Google's C++ build for a large server binary took **45 minutes**, and the engineers were sitting idle waiting on the compiler.

The pain points Go was explicitly designed to kill:

- **Slow builds.** C++ header inclusion caused exponential recompilation. Go's package model and lack of headers make builds near-instant.
- **Dependency hell.** Go forbids unused imports and unused variables, and has explicit, acyclic package dependencies — the compiler can determine exactly what to rebuild.
- **Concurrency was painful.** Threads + locks in C++/Java were error-prone. Go made concurrency a first-class primitive (goroutines).
- **Operational complexity of the JVM.** Java gave portability but at the cost of a heavyweight runtime, GC tuning, and slow startup. Go ships a single static binary with a tiny runtime.

The design philosophy: optimize for **reading** code and for **engineering at scale** (many engineers, large codebases, long-lived services) rather than for clever expressiveness. Features were *rejected* aggressively — Go had no generics for its first 13 years (added in 1.18, 2022) precisely because the team would not add complexity without a proven need.

> [!TIP]
> In interviews, "why was Go built?" has a crisp answer: to solve Google's *engineering* problems — slow C++ builds, painful concurrency, and JVM operational weight — not to invent new computer science.

## 3. Internal Working

To understand Go you must understand three artifacts: the **compiler**, the **runtime**, and the **scheduler**.

**The compiler (`gc`).** `go build` runs an ahead-of-time compiler that lowers Go source → SSA (static single assignment) intermediate form → machine code, then statically links it. The output is a single executable that *includes the Go runtime* (GC, scheduler, allocator). There is no external dependency, no libc requirement when compiled with `CGO_ENABLED=0`. This is why a Go service image can be a `FROM scratch` Docker image of ~10 MB.

**Memory layout.** Go decides per-value whether it lives on the **stack** or the **heap** via *escape analysis* at compile time. If a value's address does not outlive the function, it stays on the goroutine's stack (cheap, no GC). If it "escapes" (e.g., returned by pointer, captured by a closure that outlives the frame), it is heap-allocated and managed by the GC.

**The garbage collector** is a *concurrent, tri-color mark-and-sweep* collector with a *write barrier*. It runs mostly concurrently with your program; "stop-the-world" pauses are typically **well under 1 ms** even on multi-GB heaps. The GC is paced by `GOGC` (default 100 = grow heap 100% before collecting) and capped by `GOMEMLIMIT`.

**The scheduler (the famous G-M-P model)** multiplexes many goroutines onto few OS threads:

```text
        Goroutines (G): cheap, ~2KB initial stack, grow/shrink
        +----+ +----+ +----+ +----+ +----+ +----+
        | G  | | G  | | G  | | G  | | G  | | G  |  ... thousands
        +----+ +----+ +----+ +----+ +----+ +----+
            \    |    /          \    |    /
             v   v   v            v   v   v
           +-----------+        +-----------+
           |  P (proc) |        |  P (proc) |   <- GOMAXPROCS of these
           | run queue |        | run queue |
           +-----------+        +-----------+
                 |                    |
                 v                    v
              +-----+              +-----+
              |  M  |              |  M  |        <- OS threads
              +-----+              +-----+
                 |                    |
              +-----------------------------+
              |        OS / CPU cores       |
              +-----------------------------+
```

- **G** = goroutine (its stack, instruction pointer, scheduling state).
- **M** = machine = an OS thread.
- **P** = processor = a scheduling context holding a local run queue; there are `GOMAXPROCS` of them (default = number of CPU cores).

An M must hold a P to run Go code. When a goroutine makes a blocking syscall, the runtime *hands the P off* to another M so other goroutines keep running. Idle P's **steal** goroutines from busy P's local queues (work-stealing) for load balance. This is why launching 100,000 goroutines is fine but launching 100,000 OS threads would crater the machine.

## 4. Syntax

```go
package main // every file belongs to a package; main = executable entry

import (
	"errors"
	"fmt"
)

// Exported identifiers start with a capital letter (Greet).
// lowercase = package-private.
func Greet(name string) (string, error) {
	if name == "" {
		return "", errors.New("name required")
	}
	return fmt.Sprintf("Hello, %s", name), nil
}

func main() {
	// Short variable declaration with type inference.
	msg, err := Greet("Ada")
	if err != nil {
		fmt.Println("error:", err)
		return
	}
	fmt.Println(msg)
}
```

Key syntactic facts that trip up newcomers:

- **No semicolons** (the lexer inserts them); **braces are mandatory** and the opening brace must be on the same line.
- **Unused imports and unused local variables are compile errors**, not warnings.
- Multiple return values are idiomatic; the `value, err` pattern is everywhere.
- Visibility is by capitalization — there is no `public`/`private` keyword.
- The `:=` operator declares and infers; `var x int` is the explicit form.

## 5. Common Interview Questions

**Q1. Is Go interpreted or compiled? What does it produce?**
Compiled, ahead-of-time, to a single statically linked native binary that embeds the runtime. No VM, no separate runtime install. *Follow-up: why is startup so fast vs the JVM?* No JIT warmup and no class-loading; the machine code is ready at process start.

**Q2. Stack vs heap — how does Go decide?**
Compile-time *escape analysis*. If a value's lifetime is provably bounded by the function, it's stack-allocated; otherwise it escapes to the heap. *Follow-up: how do you inspect this?* `go build -gcflags='-m'` prints escape decisions.

**Q3. What is a goroutine and how is it different from an OS thread?**
A goroutine is a runtime-managed lightweight coroutine with a ~2 KB growable stack, scheduled by Go's G-M-P scheduler onto a small pool of OS threads. Threads are ~1–2 MB and scheduled by the kernel. *Follow-up: what's `GOMAXPROCS`?* The number of P's = max goroutines executing Go code *simultaneously*; defaults to CPU count.

**Q4. Does Go have garbage collection? What kind?**
Yes — a concurrent tri-color mark-and-sweep collector with a write barrier and sub-millisecond pauses. *Follow-up: how do you bound memory?* Set `GOMEMLIMIT` (soft limit) and/or tune `GOGC`.

**Q5. How does Go handle errors? Why no exceptions?**
Errors are ordinary values returned explicitly (`if err != nil`). `panic`/`recover` exist but are for truly exceptional, unrecoverable situations. *Follow-up: difference between `errors.Is` and `errors.As`?* `Is` checks identity in a wrapped chain; `As` unwraps into a target type.

**Q6. What does "structural typing" mean for Go interfaces?**
A type satisfies an interface simply by having the right methods — there is no `implements` declaration. *Follow-up: what is the nil-interface gotcha?* An interface holding a `(type, nil-pointer)` is itself non-nil; comparing it to `nil` returns false.

**Q7. Why are unused variables a compile error?**
A deliberate quality choice: unused code is usually a bug or leftover. It keeps codebases clean at scale. *Follow-up: how to intentionally discard?* Assign to the blank identifier `_`.

**Q8. What is the zero value?**
Every type has a usable default: `0`, `""`, `false`, `nil` for pointers/maps/slices/channels. *Follow-up: is a nil map usable?* You can *read* from a nil map (returns zero), but *writing* panics.

## 6. Production Use Cases

Go dominates the **cloud-native / infrastructure** layer. Concrete, real systems written in Go:

- **Kubernetes**, **Docker**, **containerd**, **etcd** — essentially the entire container orchestration stack.
- **Prometheus** and **Grafana Loki/Tempo** — observability backends ingesting millions of samples/sec.
- **Terraform**, **Consul**, **Vault**, **Nomad** (HashiCorp's whole portfolio).
- **CockroachDB**, **InfluxDB** — databases needing concurrency + predictable latency.
- **Caddy** and **Traefik** — modern web servers / reverse proxies.
- At companies: **Uber** (geofence, microservices), **Cloudflare** (edge proxies), **Dropbox** (migrated perf-critical services from Python), **Twitch**, **Netflix** (telemetry), **Monzo** (1000+ Go microservices).

The pattern: Go wins where you need **high-concurrency network services with predictable latency, fast deploys, and low operational overhead** — API backends, gRPC services, CLIs, proxies, and control planes. It is less common for heavy numeric/ML work (Python/C++ territory) or hard-real-time systems (GC pauses, however small, exist).

## 7. Common Mistakes

> [!WARNING]
> The classic loop-variable capture bug bit every Go developer pre-1.22.

- **Loop variable capture in goroutines.** Before Go 1.22 the loop variable was shared across iterations, so `for _, v := range xs { go func() { use(v) }() }` would often see the last `v`. Go 1.22 made each iteration get a fresh variable. If you target older versions, shadow it: `v := v`.
- **Ignoring errors.** Writing `result, _ := doThing()` discards real failures. Lint with `errcheck`.
- **Goroutine leaks.** Spawning a goroutine that blocks forever on a channel nobody closes. Always have a cancellation path (`context.Context`).
- **Mutating a map concurrently.** Maps are not safe for concurrent read+write; you'll get a fatal `concurrent map writes`. Use a `sync.Mutex` or `sync.Map`.
- **`nil` interface confusion.** Returning a `*MyError` typed nil as an `error` makes `err != nil` true unexpectedly.
- **Slice aliasing.** `append` may or may not share the backing array; an unexpected reslice can mutate data elsewhere.

## 8. Performance Considerations

Go's performance model is "fast enough, predictable, and easy to reason about" rather than "fastest possible."

- **Allocations dominate.** GC cost scales with allocation *rate*, not heap size alone. Reducing heap allocations (keep values on the stack, reuse buffers via `sync.Pool`) is the #1 lever. Profile with `pprof` and `-benchmem`.
- **Escape analysis matters.** A small struct returned by value stays on the stack; returned by pointer it escapes. Measure, don't guess.
- **`GOMEMLIMIT` (Go 1.19+)** lets you cap memory so the GC runs harder before OOM — essential in containers with hard memory limits.
- **`GOMAXPROCS` in containers.** The runtime historically read host CPU count, not the cgroup quota; use `automaxprocs` (Uber) or set it explicitly so a 2-core pod doesn't spin up 64 P's.
- **Channels are not free.** For a tight hot path, a mutex-protected slice or atomic counter can beat channel-based coordination.

Typical numbers: goroutine creation ~ hundreds of nanoseconds; GC pause < 1 ms; a net/http "hello world" handles tens of thousands of req/s per core.

## 9. Best Practices

- **Accept interfaces, return structs.** Keep functions flexible at the input, concrete at the output.
- **Pass `context.Context` as the first parameter** to anything doing I/O or that can be cancelled.
- **Handle every error explicitly**; wrap with `fmt.Errorf("doing X: %w", err)` to preserve the chain.
- **Keep interfaces small** — `io.Reader`/`io.Writer` are one method. Define interfaces at the *consumer*, not the producer.
- **Use `gofmt`, `go vet`, and `staticcheck`** in CI — non-negotiable.
- **Don't communicate by sharing memory; share memory by communicating** (the Go proverb) — but use a mutex when it's genuinely simpler.
- **Make the zero value useful** so callers can use a struct without a constructor.

## 10. Code Examples

A small, idiomatic concurrent program: fan out work to a fixed pool of goroutines with cancellation.

```go
package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

func worker(ctx context.Context, id int, jobs <-chan int, results chan<- int, wg *sync.WaitGroup) {
	defer wg.Done()
	for {
		select {
		case <-ctx.Done(): // respect cancellation
			return
		case j, ok := <-jobs:
			if !ok {
				return // channel closed, no more work
			}
			results <- j * j
		}
	}
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	jobs := make(chan int, 10)
	results := make(chan int, 10)
	var wg sync.WaitGroup

	for i := 0; i < 3; i++ { // 3 workers
		wg.Add(1)
		go worker(ctx, i, jobs, results, &wg)
	}

	go func() {
		for j := 1; j <= 5; j++ {
			jobs <- j
		}
		close(jobs)
	}()

	go func() { wg.Wait(); close(results) }()

	for r := range results {
		fmt.Println("got:", r)
	}
}
```

The same fan-out using `errgroup` (golang.org/x/sync/errgroup), which propagates the first error and bounds concurrency — preferred in real services:

```go
package main

import (
	"context"
	"fmt"

	"golang.org/x/sync/errgroup"
)

func main() {
	g, ctx := errgroup.WithContext(context.Background())
	g.SetLimit(3) // bound concurrency to 3

	results := make([]int, 5)
	for i := 1; i <= 5; i++ {
		i := i // pre-1.22 safety
		g.Go(func() error {
			select {
			case <-ctx.Done():
				return ctx.Err()
			default:
				results[i-1] = i * i
				return nil
			}
		})
	}
	if err := g.Wait(); err != nil {
		fmt.Println("error:", err)
		return
	}
	fmt.Println(results)
}
```

## 11. Advanced Concepts

- **Generics (1.18+).** Type parameters with *constraints* (interfaces describing type sets) enable `func Map[T, U any](s []T, f func(T) U) []U`. The compiler uses *GC shape stenciling* — it generates one implementation per memory layout (pointer-shaped types share code), trading some indirection for smaller binaries.
- **Memory model.** Go's memory model defines *happens-before* via channel ops, mutexes, and `sync/atomic`. Without synchronization, concurrent access to shared data is a data race (catch it with `go test -race`).
- **`unsafe` and the `runtime` package.** Escape hatches for zero-copy conversions and introspection — powerful, rarely needed, easy to get wrong.
- **Profile-Guided Optimization (PGO, 1.21+).** Feed a production CPU profile back into the compiler to guide inlining; commonly yields ~2–7% throughput gains for free.
- **Cooperative-to-preemptive scheduling.** Since 1.14 the runtime can asynchronously preempt a goroutine stuck in a tight loop via signals, fixing old "goroutine starves the scheduler" hangs.

## 12. Debugging Tips

- **Race detector:** `go test -race ./...` and `go run -race main.go`. Instruments memory access; ~5–10x slowdown, so use in CI/staging.
- **pprof:** import `net/http/pprof`, then `go tool pprof http://localhost:6060/debug/pprof/heap` (or `profile` for CPU, `goroutine` for stacks). The goroutine profile is the fastest way to find leaks.
- **Escape analysis:** `go build -gcflags='-m -m'` shows why a value escaped.
- **`GODEBUG`:** e.g. `GODEBUG=gctrace=1` prints every GC cycle; `schedtrace=1000` dumps scheduler state every second.
- **Delve (`dlv`)** is the de-facto debugger with breakpoints and goroutine inspection.
- **Deadlock detection:** the runtime panics with `all goroutines are asleep - deadlock!` when nothing can proceed.

> [!TIP]
> A leaking service that slowly grows memory is almost always leaking goroutines. Check `/debug/pprof/goroutine?debug=2` first — it shows every stuck goroutine's stack.

## 13. Senior Engineer Notes

As a senior engineer your value in Go is *judgement at the code and design level*:

- **Concurrency reviews.** Most Go bugs that reach production are concurrency bugs (leaks, races, unbounded fan-out). In reviews, demand a cancellation path for every goroutine and a bound on every worker pool. "Where does this goroutine stop?" should be a reflex question.
- **API design.** Push back on premature interfaces. Define interfaces where they're *consumed*; returning concrete types keeps call sites honest and discoverable.
- **Error strategy.** Establish a team convention: wrap with `%w` at boundaries, use sentinel errors or typed errors for branching, never log-and-return (double logging). Mentor juniors on `errors.Is`/`As`.
- **Mentoring.** Teach the *why* behind idioms — why the zero value should be useful, why small interfaces compose. Steer people away from porting Java-style inheritance/factory patterns.
- **Performance pragmatism.** Profile before optimizing. Reject micro-optimizations that hurt readability without benchmark evidence.

## 14. Staff Engineer Notes

At staff level the lens shifts to *architecture, cross-team, and org-level trade-offs*:

- **Language fit / build-vs-buy.** Know when Go is *not* the answer: ML/numeric workloads (Python + C++), latency-critical-zero-GC systems (Rust), or rich front-ends. Recommending the right tool — and defending Go where it genuinely wins (control planes, network services, CLIs) — is your job.
- **Standardization at scale.** Drive org-wide tooling: a shared `golangci-lint` config, a service template (logging, metrics, tracing, graceful shutdown baked in), and a monorepo-or-multirepo decision. Consistency across hundreds of services is worth more than any single clever optimization.
- **Operability as architecture.** Go's single-binary deploy, `GOMEMLIMIT`, and `automaxprocs` are *platform* decisions. Ensure every container sets memory/CPU correctly so a fleet of 1000 pods behaves predictably under load.
- **Migration leadership.** Many staff Go engineers run language migrations (Python/Ruby → Go for hot paths). Frame these in dollars: latency, CPU cost, and headcount-to-maintain, not "Go is cooler."
- **Dependency governance.** A small, vetted dependency set; vendoring/`GOFLAGS` policy; supply-chain scanning. The Go module ecosystem is your attack surface.

## 15. Revision Summary

- Go = **compiled**, **statically typed**, **garbage collected**, single static binary, tiny runtime.
- Built at Google (2007/2009) to fix slow C++ builds, painful concurrency, and JVM operational weight.
- Concurrency via **goroutines + channels** scheduled by the **G-M-P** work-stealing scheduler; `GOMAXPROCS` = number of P's.
- GC is **concurrent tri-color mark-sweep**, sub-ms pauses; tune with `GOGC` / `GOMEMLIMIT`.
- Stack vs heap decided by **escape analysis** at compile time (`-gcflags=-m`).
- Errors are values (`if err != nil`, wrap with `%w`); no exceptions for normal flow.
- Visibility by capitalization; unused imports/vars are compile errors; `gofmt` ends style debates.
- Dominates cloud-native: Kubernetes, Docker, Prometheus, Terraform, CockroachDB.
- Debug with `-race`, `pprof`, `GODEBUG`, and `dlv`; goroutine leaks usually explain growing memory.

**References:** [A Tour of Go](https://go.dev/tour/), [go.dev](https://go.dev/), the Go Memory Model and runtime docs at go.dev/ref and go.dev/doc.

---
*Go Engineering Handbook — topic 1.*
