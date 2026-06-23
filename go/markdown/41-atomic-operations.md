# 41 · Atomic Operations

> **In one line:** Atomic operations let goroutines mutate shared memory safely without locks, using hardware-level instructions for loads, stores, swaps, and compare-and-swap.

---

## 1. Overview

An *atomic operation* is one that completes indivisibly: from the perspective of every other goroutine, it either fully happened or did not happen at all — there is no observable intermediate state. Go exposes these through the `sync/atomic` package, which maps almost directly onto CPU instructions like `LOCK XADD` (x86) or `LDADD`/`CAS` (ARMv8.1).

The core operations are **load**, **store**, **add**, **swap**, and **compare-and-swap (CAS)**. On top of these primitives Go builds higher-level tools: lock-free counters, `atomic.Value` for swapping whole values, and — since Go 1.19 — the *typed atomics* (`atomic.Int64`, `atomic.Bool`, `atomic.Pointer[T]`) that make correct usage the path of least resistance.

The promise of atomics is **lock-free** coordination: no goroutine ever blocks waiting for a mutex, no scheduler parking, no convoy effects. The cost is that they only protect *single words*, and reasoning about correctness gets harder fast. This chapter treats atomics as a production tool with sharp edges, not a clever trick.

---

## 2. Why It Exists

Consider a request counter incremented by thousands of goroutines. With a plain `count++`, the operation is actually read-modify-write — three steps — and two goroutines can interleave, losing updates. The classic fix is a `sync.Mutex`:

```go
mu.Lock()
count++
mu.Unlock()
```

This is correct but costs a full lock/unlock cycle (tens of nanoseconds under contention, far more when goroutines actually park). For a single integer, that is enormous overhead. `atomic.AddInt64(&count, 1)` does the same work as one uninterruptible CPU instruction — typically 5–20 ns even under contention, with no parking.

Atomics exist to fill the gap between "unsynchronized and broken" and "mutex and slow" for the narrow-but-common case of **single-word shared state**: counters, flags, sequence numbers, config pointers, and hot-swappable values. They are also the foundation on which `sync.Mutex`, `sync.Once`, `sync.WaitGroup`, and channels are themselves built.

---

## 3. Internal Working

`sync/atomic` functions are *compiler intrinsics*. The Go compiler recognizes calls like `atomic.AddInt64` and emits the corresponding machine instruction inline — there is no real function call in the hot path. On amd64, `atomic.AddInt64(p, d)` becomes a `LOCK XADD` instruction; CAS becomes `LOCK CMPXCHG`; loads/stores of aligned words are already atomic at the hardware level but the compiler adds memory-ordering guarantees.

The magic of `LOCK` (or ARM's exclusive-monitor / LSE atomics) is **cache-coherence-level mutual exclusion**. The core acquires exclusive ownership of the cache line (MESI "Modified" state) for the duration of the read-modify-write, so no other core can observe a half-update.

```text
  Goroutine A (CPU 0)          Shared cache line          Goroutine B (CPU 1)
  ------------------           -----------------          ------------------
  CAS(&p, old, new)  ---->  [ line -> Exclusive ]
     read = old?            [ value compared+set ]
     write new (atomic)     [ line -> Modified  ]  <----  CAS(&p, old, new)
     return true                                          read != old  (stale)
                            [ invalidate CPU1 copy ]      return false  --> retry
```

**Memory ordering.** Go's memory model (formalized in Go 1.19) specifies that atomic operations are *sequentially consistent* relative to one another. A successful atomic store *synchronizes-before* an atomic load that observes it — this is what lets you publish data safely. This is stronger than C++'s relaxed atomics; Go deliberately does *not* expose memory-order parameters to keep the model simple.

**Alignment.** 64-bit atomic operations require the address to be 8-byte aligned. On 32-bit platforms (386, arm), the *first word* of an allocated struct is guaranteed aligned, but a non-first `int64` field may not be — this historically caused crashes. The typed atomics (`atomic.Int64`) sidestep this entirely: they wrap the value in a struct with an alignment guard (`align64` on 32-bit), so the compiler/allocator always aligns them.

**`atomic.Value`** stores an `interface{}` as two words (type pointer + data pointer). Because two words can't be written atomically in one instruction, `Value` uses a CAS-based protocol on the type word with a sentinel during the store, ensuring readers never see a torn type/data pair.

---

## 4. Syntax

Modern Go (1.19+) strongly prefers the **typed atomics** over the bare functions.

```go
import "sync/atomic"

// Typed atomics (preferred) — zero value is ready to use.
var hits atomic.Int64
hits.Add(1)            // atomic add, returns new value
n := hits.Load()       // atomic read
hits.Store(0)          // atomic write
old := hits.Swap(100)  // set 100, return previous
ok := hits.CompareAndSwap(100, 200) // CAS: if ==100 set 200

var ready atomic.Bool
ready.Store(true)
if ready.Load() { /* ... */ }

// Atomic pointer — type-safe hot swap.
var cfg atomic.Pointer[Config]
cfg.Store(&Config{Timeout: 5})
c := cfg.Load()

// atomic.Value — for any single type, set once-typed.
var v atomic.Value
v.Store("hello")
s := v.Load().(string)
```

```go
// Legacy function-based API (still valid, needed for embedded fields you
// can't change, or when operating on caller-provided *int64).
var count int64
atomic.AddInt64(&count, 1)
n := atomic.LoadInt64(&count)
atomic.StoreInt64(&count, 0)
ok := atomic.CompareAndSwapInt64(&count, 1, 2)
```

---

## 5. Common Interview Questions

**Q1. Why is `count++` not atomic?**
It compiles to load, increment, store — three operations. Two goroutines can both read the same value, increment, and write back, losing one update (a lost-update race). *Follow-up: would `count += 0` be safe?* No — a no-op increment is still read-modify-write and still races; the value can even be torn on 32-bit. Any non-atomic access alongside a concurrent writer is a data race per the memory model.

**Q2. When do you choose atomics over a mutex?**
When the protected state is a single word and the operation is one of load/store/add/swap/CAS. The moment you need to update *two related fields* consistently, or do anything compound, use a mutex. *Follow-up: how do you atomically update two counters?* You can't with separate atomics; either combine them into one word (bit-pack), use a mutex, or use a single `atomic.Pointer` to an immutable struct holding both.

**Q3. Explain compare-and-swap and where you'd use it.**
CAS atomically checks that a memory location equals an expected value and, if so, sets it to a new value, returning success. It's the building block for lock-free algorithms: read the current value, compute a new one, CAS; if it fails (someone else changed it), retry. *Follow-up: what is the ABA problem?* A value changes A→B→A; a naive CAS succeeds even though state was mutated in between. Mitigations: version/tag counters, hazard pointers, or epoch-based reclamation.

**Q4. Difference between `atomic.Value` and `atomic.Pointer[T]`?**
`atomic.Pointer[T]` is generic, type-safe, and stores a pointer; `atomic.Value` stores any `interface{}` but panics if you store inconsistent concrete types or `nil`. Prefer `atomic.Pointer[T]` in new code. *Follow-up: why does `Value` panic on changing type?* Because readers type-assert the result; allowing type changes would make that unsafe and is almost always a bug.

**Q5. Does an atomic store guarantee other goroutines see it immediately?**
There's no "immediately" in a memory model — but Go guarantees that a goroutine which *observes* an atomic store via an atomic load also observes everything that happened-before that store. That release/acquire relationship is the real guarantee. *Follow-up: is a plain read of an atomically-written variable safe?* No — mixing atomic and non-atomic access to the same location is a data race; all accesses must be atomic.

**Q6. How do typed atomics solve the 32-bit alignment bug?**
They embed an alignment guard so the value is always 8-byte aligned regardless of struct position, eliminating the historic "must keep int64 as first field" rule. *Follow-up: how would you detect such a bug?* Run under the race detector and on a 32-bit arch in CI; misalignment panics deterministically.

**Q7. Are atomics lock-free, and is lock-free always faster?**
Individual atomic ops are lock-free (no parking). But a CAS-retry loop under heavy contention can spin and burn CPU, sometimes performing *worse* than a mutex that parks contenders. Measure. *Follow-up: what's wait-free?* Stronger than lock-free: every operation completes in a bounded number of steps regardless of contention; CAS loops are lock-free but not wait-free.

---

## 6. Production Use Cases

- **Hot-reloadable configuration.** Services like Netflix-style edge proxies and many Go API servers store config in an `atomic.Pointer[Config]`. Readers `Load()` on every request (nanoseconds, no lock); a background goroutine `Store()`s a fresh immutable struct on change. This is the dominant real-world atomic pattern.
- **Metrics and counters.** Prometheus client_golang counters/gauges use `atomic` operations internally so instrumenting a hot path costs almost nothing. Request counters, bytes-served, error tallies — all atomics.
- **Connection/ID generation.** Snowflake-style ID generators and connection pools use `atomic.AddInt64` for monotonic sequence numbers.
- **Fast-path flags.** `sync.Once`, graceful-shutdown flags, and feature toggles use `atomic.Bool` to let the common case (already-done / not-shutting-down) skip the mutex entirely. The Go runtime's own `sync.Once` does this `Load` fast path.
- **Lock-free queues / ring buffers.** High-throughput systems (e.g., low-latency trading, the LMAX Disruptor pattern ported to Go) use CAS on head/tail indices.
- **Reference counting.** Buffer pools and `io` adapters use atomic refcounts to decide when to release memory.

---

## 7. Common Mistakes

> [!WARNING]
> The single most common atomics bug is **mixing atomic and non-atomic access** to the same variable. If one goroutine writes with `atomic.Store` and another reads with a plain load, it is a data race — even though "store is atomic." *All* accesses must go through atomics.

- **Copying an atomic value.** `atomic.Int64`, `atomic.Value`, etc. contain a `noCopy` guard; copying them by value (e.g., passing a struct that embeds one) breaks atomicity. `go vet` catches this.
- **Using atomics for compound invariants.** Two atomic fields updated separately are never jointly consistent. Readers can see field A's new value with field B's old value.
- **Storing different concrete types in `atomic.Value`** → panic. Also storing `nil` interface → panic.
- **Forgetting the CAS retry loop.** A single CAS that fails is not a no-op you can ignore; you must loop until success (or decide to give up).
- **Assuming atomics provide ordering for unrelated variables.** They establish happens-before only between the atomic op and what the observing goroutine reads through it.
- **32-bit misalignment** when using the *legacy* functions on a non-first `int64` struct field.

---

## 8. Performance Considerations

| Operation | Approx. cost (uncontended) | Under heavy contention |
|---|---|---|
| Plain memory read/write | ~0.3 ns | scales (but unsafe if shared+written) |
| `atomic.Load`/`Store` | ~0.5–1 ns | cheap; reads scale well |
| `atomic.Add`/`Swap`/CAS | ~5–15 ns | degrades — cache-line ping-pong |
| `sync.Mutex` Lock+Unlock | ~15–25 ns | can be 100s of ns (parking) |

The killer cost is not the instruction itself but **cache-line contention** (false sharing). Every atomic write invalidates that cache line on all other cores, forcing them to re-fetch. A single hot counter hammered by 32 cores becomes a coherence bottleneck.

> [!TIP]
> For write-heavy counters, **shard** them: keep one counter per CPU/goroutine (padded to 64 bytes to avoid false sharing) and sum on read. This trades read cost for massively reduced write contention — the pattern behind scalable metrics libraries.

Reads scale beautifully: many goroutines doing `atomic.Load` on a config pointer is essentially free because they share the line in MESI "Shared" state with no invalidation. This is why the read-mostly config-pointer pattern is so dominant.

---

## 9. Best Practices

- **Default to typed atomics** (`atomic.Int64`, `atomic.Bool`, `atomic.Pointer[T]`). They're safer, aligned, and self-documenting.
- **Keep the atomic the source of truth, not a cache.** Don't shadow an atomic in a local and forget to re-load.
- **Make swapped values immutable.** With `atomic.Pointer[Config]`, never mutate `*Config` after publishing — always build a new one and `Store` it. Readers hold the old pointer safely.
- **Prefer a mutex when in doubt.** Atomics are an optimization; a mutex is correct-by-default and far easier to reason about and review.
- **Document the invariant** in a comment: which goroutines write, which read, and what ordering is relied upon.
- **Run the race detector in CI** (`go test -race`). It catches mixed-access bugs that are otherwise invisible.
- **Pad hot, independently-written atomics** to cache-line size to avoid false sharing.

---

## 10. Code Examples

Primary: a lock-free, hot-reloadable config using `atomic.Pointer` (the pattern you'll actually use most).

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

func NewStore(initial *Config) *Store {
	s := &Store{}
	s.v.Store(initial)
	return s
}

// Get is called on every request — lock-free, scales across all cores.
func (s *Store) Get() *Config { return s.v.Load() }

// Reload publishes a brand-new immutable config; old readers keep their copy.
func (s *Store) Reload(c *Config) { s.v.Store(c) }
```

Alternative: a CAS-based lock-free stack, showing the retry loop and how typed atomic pointers compose.

```go
package lfstack

import "sync/atomic"

type node[T any] struct {
	val  T
	next *node[T]
}

type Stack[T any] struct {
	head atomic.Pointer[node[T]]
}

func (s *Stack[T]) Push(v T) {
	n := &node[T]{val: v}
	for {
		old := s.head.Load()
		n.next = old
		if s.head.CompareAndSwap(old, n) { // retry until we win the race
			return
		}
	}
}

func (s *Stack[T]) Pop() (T, bool) {
	for {
		old := s.head.Load()
		if old == nil {
			var zero T
			return zero, false
		}
		if s.head.CompareAndSwap(old, old.next) {
			return old.val, true
		}
	}
}
```

A sharded counter that avoids false sharing for write-heavy workloads:

```go
package counter

import (
	"runtime"
	"sync/atomic"
)

type cell struct {
	n atomic.Int64
	_ [56]byte // pad to a 64-byte cache line
}

type Sharded struct {
	cells []cell
}

func New() *Sharded { return &Sharded{cells: make([]cell, runtime.GOMAXPROCS(0))} }

func (s *Sharded) Inc(shard int) { s.cells[shard%len(s.cells)].n.Add(1) }

func (s *Sharded) Sum() int64 {
	var total int64
	for i := range s.cells {
		total += s.cells[i].n.Load()
	}
	return total
}
```

---

## 11. Advanced Concepts

**The ABA problem.** In the lock-free stack above, if a popper reads `head=A`, gets preempted, and another goroutine pops A, pushes B, then pushes A again (reusing the address), the original popper's `CompareAndSwap(A, A.next)` succeeds against a *stale* `A.next`. Go's garbage collector actually saves us here for many cases — A can't be reused while a goroutine still references it — which is one underrated benefit of writing lock-free code in a GC'd language. In manual-memory languages you'd need hazard pointers or tagged pointers.

**Building higher primitives.** `sync.Once.Do` is essentially: `if done.Load() == 0 { slowPath() }`, where the slow path takes a mutex and `done.Store(1)` at the end. The atomic fast path means once initialized, every future call is a single uncontended load. `sync.WaitGroup` packs counter and waiter-count into one 64-bit word manipulated by CAS.

**Sequence locks (seqlock).** For a read-mostly multi-word value where readers must never block writers, you can use an atomic sequence counter: writer increments to odd before writing and to even after; readers retry if the sequence changed or is odd. This allows torn-read detection without locking readers.

**Memory model nuance.** Go provides sequential consistency for atomics but says nothing useful about reordering of *non-atomic* operations except through happens-before edges established by atomics, channels, or mutexes. Never reason about timing — only about happens-before.

---

## 12. Debugging Tips

- **`go test -race`** is your first and best tool. It instruments memory accesses and reports any unsynchronized concurrent access, including the mixed atomic/non-atomic mistake. Run it in CI on every PR.
- **`go vet`** flags copying of `sync`/`atomic` types (the `noCopy` lint) and some lock-misuse patterns.
- **Reproduce contention** with `go test -bench . -cpu 1,4,8,16` to see whether your atomic scales or degrades — a benchmark that gets slower with more cores signals cache-line contention.
- **`perf` / `pprof`**: a hot atomic shows up as high cycles on the instruction plus stalls; `pprof` block/mutex profiles won't show atomics (they don't block), so use CPU profiles and look for cache-miss-heavy hot spots.
- **For alignment bugs**, build and test on a 32-bit target (`GOARCH=386`) in CI; misaligned 64-bit atomics panic immediately there.
- **Sanity-check ordering assumptions** by inserting the race detector rather than print statements — `fmt.Println` itself synchronizes and can mask races.

---

## 13. Senior Engineer Notes

As a senior engineer your job is mostly *restraint and review*. In code review, treat every new atomic as a question: "Why not a mutex?" The answer must be a measured hot path, not a vibe. Reject atomics protecting multi-field invariants — that's a correctness bug waiting to happen, and it will be subtle and intermittent in production.

When you do use atomics, insist on the **immutable-value-behind-a-pointer** discipline for anything beyond a counter; it converts a hard concurrency problem into a trivial one (publish-by-pointer). Push the team toward typed atomics and away from the legacy functions, and add `go test -race` to the required CI gate if it isn't there.

Mentoring-wise, the lesson to transmit is that atomics are about the *memory model*, not clever instructions. Juniors reach for atomics thinking "fast" and write the mixed-access bug. Teach happens-before, demonstrate a race-detector catch live, and show that a sharded mutex-counter is often simpler and just as fast as a lock-free one. Code that is "lock-free" but unreadable is a liability, not an achievement.

---

## 14. Staff Engineer Notes

At staff level the question is architectural: **where does shared mutable state live at all?** The best concurrency code minimizes it. Favor designs where ownership is clear — one writer goroutine, message passing via channels, or sharded-by-key partitioning — so that atomics become a localized optimization inside a component rather than a cross-cutting pattern teams must understand.

Build-vs-buy: do not let teams hand-roll lock-free queues or maps across the org. The failure modes (ABA, subtle ordering bugs) are expensive to debug and impossible to test exhaustively. Standardize on battle-tested libraries and the standard `sync` primitives; reserve custom CAS algorithms for the rare, profiled, isolated hot spot owned by an expert with thorough fuzz/race testing. A custom lock-free structure is a maintenance tax every future engineer pays.

Cross-team, push the config-pointer hot-swap pattern as a *platform primitive* — most services want hot-reloadable config and most reinvent it. Provide a vetted library. Finally, weigh the operational trade-off: atomics give predictable low latency (no parking, no tail-latency spikes from lock convoys), which matters enormously for latency-SLO services; that, more than raw throughput, is often the real reason to prefer them at the architecture level.

---

## 15. Revision Summary

- Atomic ops (`sync/atomic`) make single-word load/store/add/swap/CAS indivisible via CPU instructions (`LOCK XADD`, `CMPXCHG`).
- Use them for counters, flags, sequence numbers, and **hot-swapping immutable values via `atomic.Pointer[T]`** — the dominant production pattern.
- Prefer **typed atomics** (`atomic.Int64`, `atomic.Bool`, `atomic.Pointer[T]`); they fix 32-bit alignment and prevent copying.
- **CAS + retry loop** is the basis of lock-free algorithms; beware the **ABA problem** (GC mitigates it in Go).
- Never mix atomic and non-atomic access to one variable — that's a data race; never protect multi-field invariants with separate atomics — use a mutex.
- Cost is dominated by cache-line contention; **shard and pad** write-heavy counters; reads scale freely.
- Atomics are about the **memory model** (happens-before, sequential consistency), not just speed. Mutex is the safe default; atomics are a measured optimization.
- Tooling: `go test -race`, `go vet` (noCopy), benchmark across `-cpu` counts.

**References:** `sync/atomic` package docs; The Go Memory Model (go.dev/ref/mem); `sync.Once`/`sync.WaitGroup` source as real-world atomic usage.

---
*Go Engineering Handbook — topic 41.*
