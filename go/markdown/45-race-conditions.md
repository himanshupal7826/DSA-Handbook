# 45 · Race Conditions

> **In one line:** A data race is concurrent unsynchronized access to the same memory with at least one write — undefined behavior in Go that the `-race` detector catches by enforcing the happens-before model at runtime.

---

## 1. Overview

A **race condition** is any situation where the correctness of a program depends on the *timing* or *interleaving* of concurrent operations. A **data race** is the sharpest, language-defined subset: two goroutines access the same memory location concurrently, at least one access is a write, and there is no synchronization (channel op, mutex, atomic, `sync.Once`, etc.) ordering them.

The Go Memory Model states this bluntly: a program with a data race has **undefined behavior**. It is not "you read a slightly stale value" — the compiler and CPU are free to tear writes, reorder loads, hoist reads out of loops, or produce values that were never written. On a 64-bit platform a torn `int` is rare; a torn `interface{}` (two words: type + data) or a torn slice header (three words) can crash with a segfault or, worse, silently corrupt state.

> [!WARNING]
> "It worked in testing" means nothing for races. A data race can sit dormant for years and then surface under a new compiler version, a different CPU, a GC change, or higher load. Treat *every* race report as a bug, not a nuisance.

This chapter covers what races are, how the **`-race`** detector (built on ThreadSanitizer, **tsan**) works internally, the **happens-before** rules that define legal synchronization, and how to find, fix, and prevent races in production Go.

---

## 2. Why It Exists

Races are not a feature — they are a *consequence* of two goals colliding:

1. **Shared-memory concurrency.** Go gives you cheap goroutines and shared address space. Sharing memory without coordination is the path of least resistance, and the language does not force synchronization on you the way an actor model or message-passing-only language might.
2. **Aggressive optimization.** Compilers and CPUs reorder, cache, and elide memory operations to go fast. These optimizations are *correct* for single-threaded code and for properly-synchronized concurrent code, but visible (and dangerous) only when you race.

The Go team's answer is the **memory model** (a contract: "if you synchronize like *this*, you get *these* visibility guarantees") plus a tool — the race detector — to verify you honored the contract. Go's mantra is *"Don't communicate by sharing memory; share memory by communicating."* Channels exist precisely so you can avoid manual synchronization. The detector exists because, in practice, people still share memory.

---

## 3. Internal Working

The `-race` flag instruments your program with **ThreadSanitizer (tsan)**, a runtime developed at Google and shipped as a C library inside the Go toolchain. It does *not* statically analyze code; it observes the actual execution and verifies the happens-before graph dynamically.

**What instrumentation does.** When you compile with `-race`, the compiler injects a call before every memory access that escape analysis can't prove is goroutine-local:

```text
        Original                    Instrumented (-race)
   ┌──────────────┐            ┌─────────────────────────┐
   │  x = 42      │   ──►      │  __tsan_write8(&x)       │
   │              │            │  x = 42                  │
   └──────────────┘            └─────────────────────────┘
```

**Shadow memory.** tsan maintains *shadow memory*: for every 8 application bytes it keeps N "shadow cells" (typically 4). Each shadow cell records a recent access: which **goroutine ID**, a **vector-clock timestamp (epoch)**, the **size/offset**, and whether it was a **read or write**.

```text
 Application memory                Shadow memory (4 cells / 8 bytes)
 ┌────────────────┐               ┌──────┬──────┬──────┬──────┐
 │ var counter    │ ───maps to──► │ G3,W │ G7,R │  --  │  --  │
 │   (8 bytes)    │               │ ep=12│ ep=9 │      │      │
 └────────────────┘               └──────┴──────┴──────┴──────┘
```

**Vector clocks & happens-before.** Each goroutine carries a vector clock. Synchronization events update clocks:
- A channel send / mutex unlock / atomic store **publishes** the sender's clock to the sync object.
- A channel receive / mutex lock / atomic load **acquires** that clock, merging it into the receiver's.

On each memory access, tsan compares the new access against the stored shadow cells. If two accesses touch overlapping bytes, at least one is a write, and their vector clocks are **concurrent** (neither happens-before the other), tsan prints a report with both stacks.

**Cost & limits.** Instrumentation adds 5–10× CPU and 5–10× memory overhead, and a fixed limit of **8192 live goroutines** (older builds) — exceeding it aborts. Critically, the detector is **sound but incomplete**: it never reports a false race, but it only catches races on the *code paths actually executed* during the run. No execution, no detection.

---

## 4. Syntax

There is no race-specific syntax; you toggle the detector via the build flag on any Go command:

```bash
go test -race ./...
go run -race ./cmd/server
go build -race -o server ./cmd/server
go install -race ./...
```

You tune behavior via the `GORACE` environment variable:

```bash
# halt_on_error=1 stops at first race; history_size grows the per-goroutine
# memory access history (helps when stacks are truncated); log_path writes reports.
GORACE="halt_on_error=1 history_size=7 log_path=/var/log/race" go test -race ./...
```

The minimal synchronization primitives that *create* happens-before edges (and thus make access legal):

```go
var mu sync.Mutex        // mu.Lock()/mu.Unlock()
var rw sync.RWMutex      // rw.RLock()/rw.RUnlock() for read-mostly
var once sync.Once       // once.Do(f)
var v atomic.Int64       // v.Load()/v.Store()/v.Add() (Go 1.19+ typed atomics)
ch := make(chan int)     // send/receive
var wg sync.WaitGroup    // wg.Add/Done/Wait
```

---

## 5. Common Interview Questions

**Q1. What is the difference between a race condition and a data race?**
A *race condition* is a logic bug where outcome depends on timing (e.g., a TOCTOU check-then-act, even with locks). A *data race* is a specific memory-safety violation: unsynchronized concurrent access with a write. All data races are race conditions; not all race conditions are data races. *Follow-up: give a race condition that is NOT a data race.* — A `check-then-set` on a map fully guarded by a mutex per operation, but where the gap between the two locked operations lets another goroutine slip in. No data race (every access locked), but still a logic race.

**Q2. Why is a data race undefined behavior rather than "just a stale read"?**
Because the compiler and CPU may reorder, tear, or elide accesses. A multi-word value (interface, slice, string) can be read half-updated, yielding a pointer to garbage and a segfault. *Follow-up: is reading/writing a single `bool` from two goroutines safe?* — No. Even a single byte is a data race; use `atomic.Bool`.

**Q3. Does `-race` guarantee your program is race-free?**
No. It only detects races on executed paths. Untested interleavings escape it. *Follow-up: how do you raise confidence?* — Run `-race` in CI on the full test suite, add concurrency stress tests with `t.Parallel()` and `-count`, fuzz, and run a `-race` build of integration/load tests.

**Q4. What's the overhead of `-race` and why can't it run in production?**
~5–10× CPU and memory plus the goroutine cap. It's a dev/CI tool. *Follow-up: ever run it in prod?* — Some teams run a small `-race` canary fleet to catch field-only races, accepting the cost on a fraction of traffic.

**Q5. How do atomics and channels create happens-before edges?**
An atomic store/channel send *releases* the writer's memory state; the matching load/receive *acquires* it, so writes before the send are visible after the receive. *Follow-up: does `atomic.Add` on a counter make a separately-written field visible?* — Only if readers also synchronize through that same atomic; mixing atomic and plain access to *different* fields gives no ordering.

**Q6. Loop variable captured in a goroutine — race or not?**
Pre-Go 1.22 the classic `for _, v := range xs { go func(){ use(v) }() }` shared one variable; combined with the goroutine it was often a data race *and* a logic bug. Go 1.22 made each iteration's variable fresh, fixing the capture bug — but concurrent writes to *shared* state inside still race. *Follow-up: does 1.22 eliminate the need to pass loop vars as args?* — For the capture bug, yes; for shared mutable state, no.

**Q7. Is appending to a slice from two goroutines safe if they never touch the same index?**
No. `append` may reallocate and rewrites the slice header (ptr/len/cap) — a data race on the header and on length bookkeeping. Use a mutex or per-goroutine slices merged later.

**Q8. Map access under concurrency?**
Concurrent read+write on a built-in `map` is a data race *and* the runtime actively panics with "concurrent map writes". Use `sync.Map`, a sharded map, or a mutex. *Follow-up: when is `sync.Map` the wrong choice?* — Write-heavy or non-stable-key workloads; it's tuned for read-mostly / append-once caches.

---

## 6. Production Use Cases

- **CI gating.** Google, Uber, Dropbox, and most large Go shops run `go test -race ./...` as a required CI check. CockroachDB and TiDB run enormous `-race` test matrices; Cockroach runs nightly `-race` stress to flush rare interleavings.
- **Production canaries.** Some teams (notably reported in the Go community) deploy a single `-race`-built instance per service to a low-traffic canary to catch races that only manifest under real workloads — accepting the 5–10× cost on ~1% of traffic.
- **Library hardening.** Standard-library and infrastructure libraries (gRPC-Go, `net/http`, Kubernetes client-go) treat any `-race` failure as a release blocker. Kubernetes' e2e and unit suites include `-race` jobs.
- **Caching layers.** Read-mostly config and feature-flag caches use `atomic.Pointer[T]` for lock-free snapshots — a pattern validated by `-race` to confirm the publish/acquire edges hold.

---

## 7. Common Mistakes

> [!WARNING]
> The single most common production race: a shared `map` or slice mutated by request handlers without a lock.

- **Closing over a shared variable** in a goroutine and mutating it (counters, error vars, accumulators).
- **Double-checked locking done wrong** — reading a flag without atomics, then locking. The unsynchronized read is a race. Use `sync.Once` or `atomic`.
- **Assuming word-sized writes are atomic.** They may be on amd64, but the *memory model* gives no ordering, so the compiler can still reorder or cache them.
- **Sharing a value via a struct field** updated by one goroutine and read by another without sync (e.g., `cfg.Timeout`).
- **Reusing a buffer** (`bytes.Buffer`, byte slice) across goroutines, or passing the *same* `sync.WaitGroup` by value.
- **Logging or metrics counters** incremented with `c++` instead of `atomic.Add`.
- **Calling `wg.Add` inside the spawned goroutine** instead of before `go` — a race with `wg.Wait`.

---

## 8. Performance Considerations

| Aspect | Plain build | `-race` build |
|---|---|---|
| CPU overhead | 1× | 5–10× |
| Memory overhead | 1× | 5–10× (shadow memory) |
| Max live goroutines | unbounded | 8192 (build-dependent) |
| Use | prod | dev / CI / canary |

Beyond the detector, the *fix* you choose has real cost:

- **Mutex** — cheap when uncontended (~20ns); under contention it serializes and can collapse throughput. Profile with the `mutex` profiler.
- **`sync.RWMutex`** — wins only with many readers and rare writers; readers still cache-bounce the lock word, so for tiny critical sections a plain `Mutex` is often faster.
- **Atomics** — fastest for single-word counters/flags, but each atomic is a memory barrier; a hot `atomic.Add` on one cache line creates **false sharing** and contention. Shard counters across cache lines (pad to 64 bytes) when hot.
- **Copy-on-write with `atomic.Pointer[T]`** — readers pay nothing (a single load); writers pay a full snapshot. Ideal for read-mostly config.

> [!TIP]
> Don't reach for `RWMutex` reflexively. Benchmark it against a plain `Mutex` for your read/write ratio and critical-section size — `RWMutex` has more overhead per op and frequently loses below ~4 concurrent readers.

---

## 9. Best Practices

1. **Make `-race` a required CI check.** `go test -race ./... -count=1` on every PR.
2. **Prefer channels for ownership transfer**; prefer mutexes for *protecting state*. Pick one owner per piece of mutable state.
3. **Keep critical sections tiny.** Lock, mutate, unlock — never do I/O under a lock.
4. **Co-locate the lock with the data it guards** and document the invariant (`// guarded by mu`).
5. **Use typed atomics** (`atomic.Int64`, `atomic.Pointer[T]`) over the older `atomic.AddInt64(&x, ...)` free functions for clarity and to prevent unaligned-access bugs on 32-bit.
6. **Run stress tests** with `-count=100` and `t.Parallel()` to widen the interleavings `-race` observes.
7. **Never ignore a race report.** If it's "benign," it isn't — fix it.

---

## 10. Code Examples

A data race and its two idiomatic fixes. First, the bug — increment a counter from 1000 goroutines:

```go
package main

import (
	"fmt"
	"sync"
)

func main() {
	var counter int // shared, unsynchronized
	var wg sync.WaitGroup
	for i := 0; i < 1000; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			counter++ // DATA RACE: read-modify-write, no sync
		}()
	}
	wg.Wait()
	fmt.Println(counter) // not reliably 1000; UB under -race
}
```

Run `go run -race .` and tsan prints both conflicting stacks. The atomic fix removes the race with zero locking:

```go
package main

import (
	"fmt"
	"sync"
	"sync/atomic"
)

func main() {
	var counter atomic.Int64 // Go 1.19+ typed atomic
	var wg sync.WaitGroup
	for i := 0; i < 1000; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			counter.Add(1) // atomic RMW, establishes happens-before
		}()
	}
	wg.Wait()
	fmt.Println(counter.Load()) // always 1000
}
```

For read-mostly shared state (a config reloaded occasionally, read on every request), copy-on-write with `atomic.Pointer[T]` gives lock-free reads:

```go
package config

import "sync/atomic"

type Config struct {
	Timeout int
	Hosts   []string
}

type Store struct {
	cur atomic.Pointer[Config] // publishes whole snapshots atomically
}

func New(c *Config) *Store {
	s := &Store{}
	s.cur.Store(c)
	return s
}

// Load is lock-free and race-free: a single atomic load (acquire).
func (s *Store) Load() *Config { return s.cur.Load() }

// Reload swaps in a new immutable snapshot (release). Never mutate
// the old *Config after publishing — readers may still hold it.
func (s *Store) Reload(c *Config) { s.cur.Store(c) }
```

The key invariant: the published `*Config` is **immutable**. Mutating its `Hosts` slice in place after `Store` would reintroduce a race even though the pointer swap is atomic.

---

## 11. Advanced Concepts

**The happens-before relation formally.** Within a single goroutine, the order is program order. Across goroutines, ordering exists *only* through synchronization edges:
- A send on a channel happens-before the corresponding receive completes.
- The close of a channel happens-before a receive that returns zero due to close.
- For an unbuffered channel, the receive happens-before the send *completes*.
- An unlock of a mutex happens-before any subsequent lock.
- `once.Do(f)` — the single `f()` call happens-before any `Do` returns.
- An atomic operation that observes a value happens-after the operation that wrote it (sequentially consistent atomics in Go).

If no chain of these edges orders two accesses, they are **concurrent**, and if one writes, you have a data race.

**Sequential consistency of Go atomics.** Unlike C++ (which has relaxed/acquire/release/seq-cst), Go's `sync/atomic` provides only **sequentially consistent** operations. Simpler to reason about, slightly more expensive than relaxed atomics. There is no relaxed atomic in Go by design.

**Benign races are a myth in Go.** Other languages tolerate "benign" races (e.g., a stats counter you don't mind losing). Go's memory model declares all data races UB, so even a "harmless" counter can be miscompiled. The only correct benign-looking pattern uses atomics.

> [!NOTE]
> tsan also detects some non-data-race issues such as `sync.WaitGroup` misuse (negative counter). Deadlocks are *not* covered — use goroutine dumps and `GODEBUG` for those.

**Detector internals worth knowing for staff interviews:** the 4-shadow-cell design means very-high-contention locations can *evict* an older access before a conflicting one arrives, so even an executed race can occasionally be missed; `history_size` and re-runs mitigate this.

---

## 12. Debugging Tips

1. **Read the whole report.** tsan shows: `Read at 0x... by goroutine N`, `Previous write at 0x... by goroutine M`, both stacks, and where each goroutine was created. The *creation* stack often points at the real bug.
2. **Reproduce with stress.** `go test -race -run TestX -count=200 -cpu=8`. Many races need many iterations and parallelism (`GOMAXPROCS`) to surface.
3. **`GORACE="halt_on_error=1"`** to stop at the first race for a clean stack; **`history_size=7`** when stacks are truncated.
4. **Bisect with `go build -race`** of a smaller binary, or wrap suspect code in a focused test.
5. **Use `-race` with integration/load tests**, not just unit tests — many races only appear with real concurrency.
6. **For "concurrent map writes" panics**, the runtime gives you the offending goroutine directly even without `-race`; grep the stack for your map access.
7. **Check alignment on 32-bit** (`GOARCH=386/arm`): 64-bit atomics need 8-byte alignment; misalignment causes a panic, not a race. Typed atomics (`atomic.Int64`) handle this for you.

---

## 13. Senior Engineer Notes

As a senior engineer, your leverage is in **design and review**:

- **Design out the race.** The best fix is often architectural: give each piece of mutable state a single owning goroutine and communicate via channels, so there's nothing to synchronize. Confine state; don't share it.
- **In code review, flag the *pattern*, not just the instance.** A shared map in one handler usually means the same antipattern lives in five others. Ask: "who owns this state, and what's the lock invariant?"
- **Insist on `// guarded by mu` comments.** They make review tractable and let tooling reason about locking.
- **Mentor the loop-variable and `WaitGroup.Add` placement gotchas** — they recur for every new Go engineer. Pair the lesson with running `-race` so it sticks.
- **Distinguish data races from logic races in review.** Adding a mutex silences `-race` but doesn't fix a TOCTOU bug; make sure the *invariant* is right, not just the detector quiet.
- **Treat a flaky `-race` CI failure as a load-bearing signal**, never a "retry and move on." Quarantine, don't disable.

---

## 14. Staff Engineer Notes

At staff level the concerns are **org-wide and architectural**:

- **Make `-race` non-negotiable infrastructure.** Standardize a CI template across all Go repos so every team gets `-race` testing for free; this is far cheaper org-wide than each team relearning races in production.
- **Build-vs-buy for concurrency-heavy components.** When a subsystem is a race minefield (custom in-memory cache, work-stealing scheduler), weigh adopting a battle-tested library (`sync.Map`, `singleflight`, `golang.org/x/sync`) or a different model (actor framework, external store) versus hand-rolling locks each team will get subtly wrong.
- **Canary `-race` fleets** are an org-level call: the 5–10× cost on a 1% canary buys field detection of races that never appear in CI. Decide once, fund the headroom, and wire the alerts.
- **Cross-team API contracts.** A library you ship that hands out a shared mutable struct creates races in *every* consumer. Make shared state immutable, return copies, or document thread-safety guarantees explicitly per type — an API-design responsibility, not an implementation detail.
- **Memory-model literacy as a leveling signal.** Whether engineers understand happens-before predicts how much production firefighting your org will do. Invest in internal docs and brown-bags.
- **Trade-off framing for leadership:** races are a *correctness* risk with non-linear blast radius (silent corruption > clean crash). Frame `-race` CI cost (minutes per build) against the cost of one corrupted-data incident.

---

## 15. Revision Summary

- **Data race** = concurrent unsynchronized access, ≥1 write → **undefined behavior** in Go.
- **Race condition** is broader (timing-dependent logic); not all are data races.
- **`-race`** instruments with **tsan**: shadow memory + vector clocks verify **happens-before** at runtime. ~5–10× CPU/mem, 8192-goroutine cap, sound but incomplete (only executed paths).
- Synchronization that creates happens-before edges: channels, `Mutex`/`RWMutex`, `sync.Once`, **seq-consistent atomics**, `WaitGroup`.
- Go has **no relaxed atomics** and **no benign races** — fix every report.
- Fixes by workload: counters → `atomic`; protected state → `Mutex`; read-mostly → `atomic.Pointer[T]` copy-on-write or `RWMutex`.
- Common bugs: shared map/slice, captured loop var (pre-1.22), `wg.Add` after `go`, `append` from multiple goroutines, double-checked locking without atomics.
- Make `-race` a required CI gate; stress with `-count` and `t.Parallel()`; consider a `-race` canary.

**References:** Go Blog — "Introducing the Go Race Detector"; The Go Memory Model (go.dev/ref/mem); `sync` and `sync/atomic` package docs; ThreadSanitizer (Google) design papers.

---

*Go Engineering Handbook — topic 45.*
