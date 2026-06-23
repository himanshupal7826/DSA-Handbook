# 48 · Memory Model

> **In one line:** The Go memory model defines the *happens-before* edges that decide when a write by one goroutine is guaranteed to be visible to a read by another — everything else is a data race.

---

## 1. Overview

The **Go memory model** specifies the conditions under which reads of a variable in one goroutine can be guaranteed to observe values produced by writes to the same variable in a different goroutine. It is not about *what value you get* in the happy path — it is about the *guarantees the runtime, compiler, and CPU are allowed to break* when you fail to synchronize.

The central abstraction is the **happens-before** relation, a partial order over memory operations. If event `A` happens-before event `B`, then the effects of `A` are visible to `B`. If neither happens-before the other and at least one is a write to the same location, you have a **data race**, and the program's behavior is undefined.

Two pillars hold up the model:

- **Visibility** — does goroutine 2 see the write goroutine 1 made?
- **Ordering / reordering** — in what order do operations *appear* to execute, given that the compiler and CPU freely reorder independent instructions?

The 2022 revision of the spec made one rule blunt and quotable: *"Programs that modify data being simultaneously accessed by multiple goroutines must serialize such access. ... If you must read the rest of this document to understand the behavior of your program, you are being too clever."* The model exists to bound cleverness, not encourage it.

> [!NOTE]
> The Go memory model is **DRF-SC**: data-race-free programs behave as if executed under sequential consistency. The moment you introduce a race, the entire program loses that guarantee — not just the racing variable.

---

## 2. Why It Exists

Without a memory model, "shared memory concurrency" has no precise meaning. Consider this fragment:

```go
var done bool
var msg string

func setup() { msg = "hello"; done = true }
func main()  { go setup(); for !done {}; print(msg) }
```

Intuition says this prints `hello`. The memory model says: **nothing is guaranteed**. The compiler may hoist `done` into a register so `for !done {}` loops forever. The CPU may make `done = true` visible *before* `msg = "hello"`, so you print an empty string. Both are legal because there is no synchronization edge between the writer and the reader.

The model exists to answer three questions definitively:

1. **What can the compiler do?** Register promotion, dead-store elimination, instruction reordering — all legal between synchronization points.
2. **What can the CPU do?** Store buffers, out-of-order execution, and weak cache coherency (especially on ARM64/POWER) reorder loads and stores.
3. **What must a correct program do?** Establish happens-before edges via channels, `sync` primitives, or `sync/atomic` so the optimizations above can't be observed.

It also gives tooling a contract: the **race detector** (`-race`) is precisely a happens-before checker. It flags any pair of accesses where one is a write and no happens-before edge connects them.

---

## 3. Internal Working

Go's memory model is implemented at three layers: the **compiler** (what it's allowed to reorder), the **runtime** (the synchronization primitives that emit edges), and the **hardware** (memory barriers / fences).

**Happens-before as a graph.** Conceptually the runtime builds a partial order. The base rules:

- Within a single goroutine, program order *is* happens-before (the "sequenced before" relation).
- A `go` statement happens-before the goroutine's execution starts.
- A send on a channel happens-before the corresponding receive completes.
- A receive from an *unbuffered* channel happens-before the send on that channel *completes*.
- The `n`th receive on a channel with capacity `C` happens-before the `n+C`th send completes.
- A `sync.Mutex.Unlock` happens-before any subsequent `Lock` that returns.
- `sync.Once.Do(f)` — `f`'s return happens-before any `Do` call returns.
- For atomics: an atomic write to `x` is *synchronized before* an atomic read that observes it (sequentially-consistent atomics, since Go 1.19's `sync/atomic` types).

```text
   goroutine A                       goroutine B
   -----------                       -----------
   msg = "hello"   (sequenced)
        |  hb
   ch <- 1  -------- hb edge -------> <-ch           (channel sync)
                                          |  hb
                                      print(msg)   <-- sees "hello"

   The channel op is the SYNCHRONIZATION EDGE that
   transports all of A's prior writes into B's view.
```

**Compiler layer.** The Go compiler treats calls into `sync`/`sync/atomic` and channel operations as optimization barriers — it will not reorder ordinary memory accesses across them, and it does not promote a variable into a register across such a call if it could be observed. Atomic operations are emitted as real atomic CPU instructions.

**Hardware layer.** On x86-64 (TSO — total store order), loads aren't reordered with loads and stores aren't reordered with stores; only store→load reordering happens, so atomics need an `XCHG`/`LOCK`-prefixed instruction for sequential consistency, but plain mutex paths are cheap. On **ARM64/POWER** (weakly ordered), the runtime must emit explicit barriers (`DMB ISH` on ARM64) inside atomic and lock operations. This is why a race that "always works" on your Intel laptop fails on an ARM Graviton instance — same Go source, different hardware memory ordering.

**Runtime data structures.** A `sync.Mutex` is a tiny struct (`state int32`, `sema uint32`); its fast path is a single atomic CAS on `state`, which carries the memory barrier. The race detector (ThreadSanitizer-derived) maintains per-goroutine vector clocks and a shadow memory of recent accesses to reconstruct the happens-before graph at runtime.

---

## 4. Syntax

There is no special syntax for "the memory model" — it is expressed through the synchronization primitives that create edges.

```go
// 1. Channels — the idiomatic edge.
ch := make(chan int)
go func() { /* writes */; ch <- 1 }()
<-ch // happens-after the goroutine's writes

// 2. Mutex.
var mu sync.Mutex
mu.Lock(); shared++; mu.Unlock()

// 3. sync.Once.
var once sync.Once
once.Do(initialize) // initialize runs exactly once, visibly

// 4. WaitGroup.
var wg sync.WaitGroup
wg.Add(1); go func() { defer wg.Done(); work() }(); wg.Wait()

// 5. Atomics (typed, Go 1.19+) — preferred over the free functions.
var ready atomic.Bool
ready.Store(true)
if ready.Load() { /* ... */ }
```

> [!TIP]
> Prefer the typed atomic wrappers (`atomic.Int64`, `atomic.Pointer[T]`, `atomic.Bool`) over the package-level `atomic.AddInt64(&x, 1)` functions. The wrappers prevent accidental non-atomic access to the same field and align the value correctly on 32-bit platforms.

---

## 5. Common Interview Questions

**Q1. What does "happens-before" actually mean — does it mean A executes before B in wall-clock time?**
No. It is a *partial order over visibility*, not a timeline. If A happens-before B, then B is guaranteed to observe A's effects. Two operations can be unordered (concurrent) even though one ran earlier on the clock. *Follow-up: can A happen-before B without any wall-clock ordering?* Yes — happens-before is the guarantee, not the schedule; the only thing it forbids is B observing a stale value relative to A.

**Q2. Is `var done bool; go func(){done=true}(); for !done{}` correct?**
No — it's a data race. The compiler may keep `done` in a register (infinite loop) and there's no edge making the write visible. Fix with a channel, mutex, or `atomic.Bool`. *Follow-up: it works on my machine, why?* x86 is strongly ordered and the optimizer happened not to hoist; on ARM64 or with `-race` it breaks. "Works on my machine" is not correctness.

**Q3. Does an unbuffered channel give a stronger guarantee than a buffered one?**
Yes. For an unbuffered channel, the *receive* happens-before the *send completes* — a full rendezvous, both sides synchronize. For a buffered channel, only send-happens-before-receive holds (plus the capacity rule). *Follow-up: how do you use a buffered channel as a semaphore?* `make(chan struct{}, N)`; the `n`th receive happens-before the `n+N`th send completes, bounding concurrency to N.

**Q4. Is `sync/atomic` enough to make a non-atomic struct field visible?**
Yes, if you publish the whole struct via an atomic pointer. Write all fields, then `atomic.Pointer[T].Store(p)`; a reader that does `Load()` and observes `p` sees all prior field writes (the atomic store/load is the edge). Mutating fields *after* publishing is again a race. *Follow-up: why is this faster than a mutex?* Readers never block or write a cache line — they only do an acquire load (copy-on-write / RCU-style).

**Q5. What is DRF-SC?**
Data-Race-Free implies Sequential Consistency: if your program has no data races, it behaves as if all goroutines' operations were interleaved in a single global order consistent with each goroutine's program order. Introduce one race and you lose this everywhere. *Follow-up: does Go guarantee SC for racy programs?* No — Go gives bounded behavior (no "out of thin air" values, type safety preserved) but not SC.

**Q6. Does `time.Sleep` create a happens-before edge?**
No. Sleeping is never synchronization. Code that "fixes" a race by adding a sleep just shrinks the window; the race remains. *Follow-up: what about `runtime.Gosched()`?* Also not a synchronization edge — it only yields the scheduler.

**Q7. Two goroutines both do `mu.Lock(); x++; mu.Unlock()`. Why is this correct?**
Each `Unlock` happens-before the next `Lock` that returns, forming a chain: G1's `x++` happens-before G2's `x++`. The mutex serializes access and carries the visibility barrier. *Follow-up: is `sync.RWMutex` weaker?* No — `RUnlock` happens-before a later `Lock`, and `Unlock` happens-before later `RLock`s; readers still get a consistent view.

**Q8. Is reading a single `int` (one word) atomic, so I can skip synchronization?**
Word-sized aligned loads/stores may be atomic at the hardware level, but the *memory model* still calls concurrent read/write a race — the compiler can reorder or cache it. Always use `atomic.Int64` or a lock. *Follow-up: what breaks on 32-bit?* A 64-bit value isn't even hardware-atomic; misaligned access can tear or panic.

---

## 6. Production Use Cases

- **Configuration hot-reload (copy-on-write).** Services at scale (e.g. config systems modeled on Netflix's dynamic config, or `etcd`-backed feature flags) store the active config in an `atomic.Pointer[Config]`. A background goroutine builds a new `*Config` and `Store`s it; thousands of request handlers `Load()` it with zero locking. The atomic publish is the only synchronization edge needed.
- **`context.Context` cancellation.** The standard library uses a closed channel (`<-ctx.Done()`) as the edge that makes cancellation visible across goroutines — closing a channel happens-before any receive that returns.
- **`sync.Once` for lazy singletons.** Database connection pools (`database/sql`), gRPC client init, and Prometheus registries use `Once.Do` so initialization is visible to all callers without each one re-checking.
- **Lock-free counters and metrics.** Prometheus client counters, `expvar`, and high-throughput request counters use `atomic.Int64` to avoid mutex contention on hot paths.
- **Worker pools and pipelines.** Channel-based fan-out/fan-in (used heavily in Kubernetes controllers and Docker) relies on send/receive edges so each work item's mutations are visible to whoever processes the result.
- **Double-buffered render/state swaps.** Game servers and stream processors keep two buffers and atomically swap a pointer between them per tick.

---

## 7. Common Mistakes

> [!WARNING]
> Every item below is a real data race, even if it "works" today.

| Mistake | Why it's wrong | Fix |
|---|---|---|
| Loop on a plain `bool` flag | Compiler hoists into register; no visibility edge | `atomic.Bool` or channel close |
| `time.Sleep` to "wait for" a goroutine | Sleep is not synchronization | `sync.WaitGroup` / channel |
| Mixing atomic and non-atomic access to the same var | Only atomic-atomic pairs are ordered | All accesses atomic, or use a lock |
| Mutating fields of a struct after atomic-publishing its pointer | Post-publish writes race with readers | Copy-on-write: never mutate published data |
| Returning a `map` and writing it concurrently | Maps aren't goroutine-safe; concurrent write panics or corrupts | `sync.Map` or mutex-guarded map |
| Capturing a loop variable in a goroutine (pre-1.22) | Shared variable, racy reads | Go 1.22 per-iteration scope, or shadow it |
| Reading 64-bit field on 32-bit without alignment | Tearing / panic | Use typed `atomic.Int64` |

A subtle one: **`sync.WaitGroup` reuse.** Calling `Add` after `Wait` has begun, or reusing a `WaitGroup` before all `Done`s land, races on the internal counter.

---

## 8. Performance Considerations

Synchronization is not free — each edge is a memory barrier that constrains the CPU.

- **Atomic load (acquire):** on x86 a plain `MOV` suffices for SC loads; on ARM64 it's `LDAR`. Cheapest possible edge — ~1ns, no cache-line write.
- **Atomic store / CAS:** issues a `LOCK`-prefixed RMW (x86) or `STLXR` loop (ARM64), ~5–20ns, and *invalidates the cache line* in other cores. Under contention this dominates.
- **Mutex uncontended:** a single CAS, comparable to an atomic store. **Contended:** futex/semaphore park, costing microseconds plus a goroutine context switch.
- **Channel op:** more expensive than a mutex (lock + queue manipulation + possible goroutine wakeup), ~50–200ns. Use channels for *ownership transfer*, not for protecting a hot counter.

**False sharing** is the silent killer: two atomics on the same 64-byte cache line cause cores to ping-pong the line even though they're logically independent. Pad hot atomics to their own line (`_ [56]byte` after an `atomic.Int64`).

| Primitive | Uncontended cost | Best for |
|---|---|---|
| `atomic.Load` | ~1 ns | read-mostly flags, RCU |
| `atomic.Add/CAS` | ~5–20 ns | counters, lock-free stacks |
| `sync.Mutex` | ~15–25 ns | small critical sections |
| channel | ~50–200 ns | ownership / pipelines |

> [!TIP]
> Rule of thumb: read-mostly → atomic pointer (RCU); short write-heavy critical section → mutex; data handoff → channel.

---

## 9. Best Practices

- **"Share memory by communicating."** Default to channels for ownership transfer; reach for shared memory + locks only when profiling demands it.
- **Make the synchronization edge explicit and local.** A reader should be able to point at the exact `Lock`, channel op, or atomic that gives them visibility.
- **Run `-race` in CI, always.** It's a happens-before oracle; treat any report as a real bug regardless of "it passed".
- **Document ownership.** Comment which goroutine owns a field and which lock guards it (`// guarded by mu`). `go vet`'s copylocks and structtag checks help.
- **Copy-on-write for read-mostly state.** Never mutate published data; build new, atomically swap.
- **Use typed atomics** to make non-atomic access of the same field a compile-time impossibility.
- **Don't be clever.** If understanding correctness requires reasoning through the memory model, refactor to an obvious primitive.

---

## 10. Code Examples

Primary: a correct flag using `atomic.Bool` versus the broken plain-bool version, shown as switchable tabs.

```go
// CORRECT — atomic establishes the happens-before edge.
package main

import (
	"fmt"
	"sync/atomic"
)

func main() {
	var done atomic.Bool
	var msg string

	go func() {
		msg = "hello"    // plain write...
		done.Store(true) // ...published via atomic store (release)
	}()

	for !done.Load() { // acquire load
	}
	fmt.Println(msg) // guaranteed to print "hello"
}
```

```go
// BROKEN — data race: no synchronization edge.
package main

import "fmt"

func main() {
	var done bool
	var msg string

	go func() {
		msg = "hello"
		done = true // racy write
	}()

	for !done { // may loop forever (hoisted) or print ""
	}
	fmt.Println(msg)
}
```

The correct version works because `done.Store(true)` is *sequenced after* `msg = "hello"`, and a `Load()` that observes `true` is synchronized-after that store — so `msg`'s write is visible.

A second, separate example: **RCU-style copy-on-write config** using `atomic.Pointer`.

```go
package config

import "sync/atomic"

type Config struct {
	Timeout int
	Hosts   []string
}

type Store struct {
	v atomic.Pointer[Config]
}

func NewStore(c *Config) *Store {
	s := &Store{}
	s.v.Store(c)
	return s
}

// Get is lock-free; readers never block writers.
func (s *Store) Get() *Config { return s.v.Load() }

// Update publishes a brand-new Config. The old one is never mutated.
func (s *Store) Update(c *Config) { s.v.Store(c) }
```

Every `Get()` sees a fully-constructed `*Config`: all field writes happen-before the `Store`, and the matching `Load` synchronizes-after it. The classic bug — mutating `cfg.Hosts = append(...)` on a published pointer — would reintroduce a race; with COW you always build a fresh value.

---

## 11. Advanced Concepts

**Release/acquire vs. sequential consistency.** Many languages (C++, Rust) expose `memory_order_relaxed/acquire/release/seq_cst`. Go deliberately does **not** — all `sync/atomic` operations are sequentially consistent. This trades a little performance for a vastly smaller correctness surface. You cannot write a relaxed atomic in Go; if you need it, you're at the wrong layer.

**The "no out-of-thin-air" guarantee.** Even racy Go programs can't fabricate values that were never written, and they preserve memory and type safety (no segfaults from a torn interface header, in practice). This is weaker than DRF-SC but stronger than C/C++ undefined behavior. The 2022 model formalized this by saying a read may observe any write that doesn't happen-after it, but not arbitrary garbage.

**Channel close as a broadcast edge.** `close(ch)` happens-before any receive that returns the zero value. This is how `context` fans cancellation out to N goroutines with a single operation — far cheaper than N sends.

**Finalizers and `runtime.SetFinalizer`.** A finalizer's execution is *not* ordered relative to ordinary program operations except that it runs after the object becomes unreachable; never use it for synchronization.

**Memory ordering of `sync.Map`.** `Load`/`Store`/`LoadOrStore` carry the necessary edges internally, but ranging over it gives a *snapshot-ish* view with no guarantee of seeing concurrent stores — fine for caches, wrong for "exactly once" logic.

> [!NOTE]
> Go's atomics being seq-cst means a common C++ lock-free trick (relaxed counter increments) has no direct Go equivalent — your `atomic.Add` always pays the full barrier. Usually fine; occasionally a reason to batch with sharded counters.

---

## 12. Debugging Tips

- **`go test -race ./...` and `go run -race`.** The race detector instruments memory accesses and reports the two stacks involved plus the goroutine that created each. ~5–10x slowdown and ~5–10x memory, so it's for tests/staging, not prod hot paths.
- **Read the report carefully:** "Previous write at 0x... by goroutine 7" + "Read at 0x... by goroutine 12" with both stacks tells you exactly which two accesses lack an edge.
- **Reproduce on weak hardware.** A race invisible on x86 often surfaces on ARM64 (Apple Silicon, AWS Graviton). Run your suite there.
- **`GORACE="halt_on_error=1 history_size=7"`** tunes the detector — bigger history finds more, costs more memory.
- **Stress it:** `go test -race -count=100 -cpu=1,2,4,8` widens scheduling windows.
- **`go vet`** catches lock copies (`copylocks`) and loop-var captures statically — cheap pre-race screening.
- When a hang (not a crash) is suspected, send `SIGQUIT` for a full goroutine dump and look for a goroutine spinning on a non-atomic flag.

> [!WARNING]
> The race detector only reports races it *observes during this run*. A clean run is not a proof of correctness — it's evidence, weighted by how thoroughly you exercised concurrent paths.

---

## 13. Senior Engineer Notes

As a senior engineer your leverage is in *code-level judgment and review discipline*:

- **In reviews, demand a named edge.** For any shared variable, ask "what makes this visible to the reader?" If the author can't name the channel/lock/atomic, it's a race. This single question catches most concurrency bugs before merge.
- **Push back on `time.Sleep` in tests and prod.** It signals a missing synchronization edge; replace with `WaitGroup`, channels, or `sync.Cond`.
- **Right-size the primitive.** Reject channel-for-a-counter and mutex-for-read-mostly. Teach the team the cost table (Section 8) so choices are deliberate.
- **Enforce `-race` in CI as a blocking gate.** Treat flakes-under-race as P1, not "retry the job".
- **Mentor on "works on my machine."** Make juniors run a suspect test on Apple Silicon / Graviton to feel weak memory ordering firsthand.
- **Codify ownership conventions.** `// guarded by mu` comments and keeping the mutex adjacent to the field it protects make future reviews mechanical.

You own the correctness of the diff and the team's instinct to *not be clever*.

---

## 14. Staff Engineer Notes

At staff level the memory model becomes an *architectural and organizational* concern:

- **Choose the concurrency architecture, not just the primitive.** Decide org-wide whether a subsystem is actor/message-passing (channels, easy to reason about, default) or shared-state (locks/atomics, for proven hot paths). This shapes how dozens of engineers write code for years.
- **Build-vs-buy for lock-free structures.** Hand-rolled lock-free code is a maintenance liability and an onboarding tax. Prefer `sync.Map`, sharded mutexes, or a vetted library over bespoke CAS loops unless profiling proves a real bottleneck with a real dollar cost.
- **Cross-team contracts.** When you expose a shared object across team boundaries (a config store, a cache), make its thread-safety part of the API contract and document the visibility guarantees. Ambiguity here causes integration races that no single team can debug.
- **Cost at fleet scale.** A mutex on a per-request hot path that costs 20ns × billions of requests is real CPU spend. Quantify whether RCU/atomic-pointer or sharding is worth the complexity — sometimes the answer is "buy more cores," sometimes it's a redesign.
- **Hardware portability strategy.** As fleets migrate to ARM (Graviton saves ~20–40% cost), latent x86-only races become incidents. Mandate `-race` on ARM CI before migration, not after.
- **Set the "don't be clever" guardrail at the org level.** Codify that seq-cst atomics and the standard `sync` primitives are the sanctioned toolkit; anything more exotic requires a design review. This bounds the blast radius of concurrency bugs across the whole codebase.

Senior keeps a diff correct; staff keeps a thousand diffs *and the next migration* correct.

---

## 15. Revision Summary

- **Happens-before** is a partial order over *visibility*, not wall-clock time; if A hb B, B sees A's effects.
- A **data race** = two accesses to the same location, ≥1 write, no hb edge → undefined behavior for the *whole* program.
- **DRF-SC**: race-free programs behave sequentially consistent; one race forfeits that everywhere.
- Edges come from: `go` start, channel send/receive (+close, +capacity rules), `Mutex`/`RWMutex`, `Once`, `WaitGroup`, and **all `sync/atomic` ops (seq-cst)**.
- Unbuffered channel: receive hb send-completion (rendezvous); buffered: send hb receive + the `n`/`n+C` rule.
- **Not** edges: `time.Sleep`, `runtime.Gosched`, finalizers, plain word-sized loads.
- Go has **no relaxed atomics** — all atomics are sequentially consistent by design.
- Cost order: atomic load < atomic CAS ≈ uncontended mutex < channel; beware **false sharing** and weak ARM64 ordering.
- Patterns: COW/RCU via `atomic.Pointer`, channel-close broadcast for cancellation, `sync.Once` singletons.
- Always run **`-race`** in CI; a clean run is evidence, not proof.

**References:** The Go Memory Model (go.dev/ref/mem); `sync` and `sync/atomic` package docs; Russ Cox, "Hardware Memory Models" and "Programming Language Memory Models" (research.swtch.com).

---
*Go Engineering Handbook — topic 48.*
