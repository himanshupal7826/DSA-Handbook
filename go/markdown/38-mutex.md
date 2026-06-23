# 38 · Mutex

> **In one line:** `sync.Mutex` is Go's primitive for serializing access to shared state, blending fast user-space spinning with a fair, OS-backed queue that flips into starvation mode to bound tail latency.

---

## 1. Overview

A **mutex** (mutual exclusion lock) guarantees that only one goroutine at a time executes the **critical section** it guards. In Go this is `sync.Mutex`, a tiny struct with two methods, `Lock()` and `Unlock()`. Everything between a successful `Lock` and the matching `Unlock` runs as if the rest of the program were paused with respect to the protected data.

Mutexes are the workhorse of shared-memory concurrency. Channels get the marketing ("share memory by communicating"), but the moment you have a counter, a map, an LRU cache, a connection pool, or a config struct touched by many goroutines, you reach for a mutex. It is cheaper than a channel, easier to reason about for plain state, and the standard library uses it everywhere internally.

The key vocabulary for this chapter: **mutex**, **lock**, **critical section**, **contention** (multiple goroutines fighting for the same lock), and **starvation** (one goroutine repeatedly losing the race and never making progress). Go's mutex is specifically engineered to make the common low-contention case nearly free while preventing the pathological starvation case under heavy contention.

## 2. Why It Exists

Concurrent reads are harmless. Concurrent writes — or a read racing a write — corrupt memory. Consider `counter++`: it compiles to a load, an add, and a store. Two goroutines interleaving those steps lose updates. Worse, in Go the memory model gives you **no guarantees** about visibility or ordering between goroutines unless you use a synchronization primitive. A data race is undefined behavior, not merely "occasionally wrong arithmetic" — the compiler may reorder, cache in registers, or tear writes.

`sync.Mutex` exists to give you a **happens-before** edge: everything before an `Unlock` is guaranteed visible to whoever next `Lock`s. It is the smallest, cheapest tool that provides both **atomicity** (one goroutine in the section) and **visibility** (memory ordering).

> [!NOTE]
> You *could* serialize via a channel or a single owning goroutine. But for guarding a few fields, a mutex is faster, allocates nothing, and reads more naturally. Channels shine for *handing off ownership*; mutexes shine for *protecting state in place*.

## 3. Internal Working

`sync.Mutex` is deliberately small — two 32-bit fields:

```go
type Mutex struct {
    state int32 // packed: locked bit, woken bit, starving bit, waiter count
    sema  uint32 // semaphore used to park/unpark goroutines
}
```

The low bits of `state` are flags; the high bits are a count of waiting goroutines.

```text
 state int32 (bit layout)
 31                              3   2   1   0
 +------------------------------+---+---+---+---+
 |        waiter count          | S | W | L |   |
 +------------------------------+---+---+---+---+
   L (bit 0) = mutexLocked   : held by someone
   W (bit 1) = mutexWoken    : a waiter was signaled, don't wake more
   S (bit 2) = mutexStarving : mutex is in starvation mode
   bits 3..  = number of goroutines blocked in sema
```

**Fast path.** `Lock()` first tries a single atomic compare-and-swap: flip the locked bit from 0 to 1. If `state` was zero, you own the lock in a handful of nanoseconds with no kernel involvement. `Unlock()` is the mirror: atomically clear the locked bit; if no waiters, return immediately.

**Slow path (contention).** If the CAS fails, the goroutine enters `lockSlow`. On multicore hardware it may **spin** briefly (a few iterations of `procyield`/active spinning) betting the holder will release imminently — spinning avoids an expensive park/unpark round trip. If spinning doesn't win, the goroutine increments the waiter count and **parks** on `sema` via the runtime's `semacquire`, yielding its OS thread.

**Two modes.** This is the famous part:

- **Normal mode** — waiters are a FIFO queue, but a freshly-arrived goroutine that is *running* on a CPU can grab the just-released lock before a parked waiter is scheduled. This **barging** maximizes throughput (the hot goroutine keeps the CPU warm) but can starve the queue.
- **Starvation mode** — if a waiter fails to acquire for **more than 1 ms**, the mutex flips its `starving` bit. Now `Unlock` hands ownership *directly* to the goroutine at the front of the queue; no barging, no spinning. New arrivals go straight to the back of the queue. The mutex leaves starvation mode when the waiter it just served is the last one, or that waiter waited less than 1 ms — restoring throughput-friendly behavior.

```text
  Normal mode (throughput):        Starvation mode (fairness):
  unlock --> race! ---------+      unlock --> hand off to head of FIFO
   new goroutine may "barge" |      new arrivals append to tail, no barge
   ahead of parked waiters   |      bounded wait: ~1ms tail latency cap
```

This hybrid gives Go a mutex that is fast under light load yet keeps p99/p999 latency bounded under heavy contention — you don't get unbounded starvation. The 1 ms threshold is a hardcoded runtime constant (`starvationThresholdNs`).

> [!NOTE]
> `Mutex`'s zero value is a ready-to-use unlocked mutex. Never copy a `Mutex` after first use — `go vet` flags this because copying duplicates the `state`/`sema` and breaks the lock.

## 4. Syntax

```go
var mu sync.Mutex

mu.Lock()
// critical section
mu.Unlock()

// idiomatic: pair Unlock with defer
mu.Lock()
defer mu.Unlock()
// ... do work, even early returns are safe ...
```

`sync.RWMutex` adds `RLock()`/`RUnlock()` for many-reader, single-writer workloads. `TryLock()` (Go 1.18+) attempts a non-blocking acquire and returns a bool — use sparingly; it's a code smell more often than a tool.

## 5. Common Interview Questions

**Q1. What's the difference between a mutex and a channel for protecting state?**
A mutex protects *data in place* with a happens-before edge; a channel transfers *ownership of data* between goroutines. Use a mutex for shared mutable state with simple invariants; a channel when ownership moves or you're coordinating pipelines. *Follow-up: when does a channel become a mutex in disguise?* A buffered channel of size 1 used as a token is literally a binary semaphore — functionally a mutex, but slower and less clear.

**Q2. Is Go's mutex fair?**
Mostly not, by design — normal mode allows barging for throughput. But it has a fairness backstop: after a waiter is starved for >1 ms it enters starvation mode and hands off FIFO, bounding tail latency. *Follow-up: why not always be fair?* Strict FIFO forces a context switch on every handoff and loses cache locality, tanking throughput. Go trades a tiny tail-latency budget for big throughput.

**Q3. What happens if you `Unlock` a mutex you didn't `Lock`?**
`fatal error: sync: unlock of unlocked mutex` — it crashes the whole program, not just the goroutine, and it's unrecoverable. *Follow-up: why fatal, not a panic?* A double-unlock indicates corrupted lock state; continuing could deadlock or race elsewhere, so the runtime fails fast.

**Q4. Can a mutex be locked recursively (re-entrant)?**
No. Go has no recursive mutex. A goroutine that `Lock`s a mutex it already holds **deadlocks**. *Follow-up: how do you handle that need?* Split into an exported method that locks and an unexported `...locked` helper that assumes the lock is held; the public method calls the helper.

**Q5. RWMutex vs Mutex — when is RWMutex actually slower?**
`RWMutex` has more bookkeeping (reader count + writer semaphore). Under write-heavy or low-contention loads it's *slower* than a plain `Mutex`. It only pays off with genuinely read-dominated, contended workloads. *Follow-up: what's the writer-starvation risk?* A flood of readers can delay a writer; Go's `RWMutex` mitigates this by blocking new readers once a writer is waiting.

**Q6. Why must you not copy a `sync.Mutex`?**
Copying duplicates internal `state`/`sema`; the copy and original become independent locks, silently breaking mutual exclusion. *Follow-up: how is this caught?* `go vet`'s copylocks analyzer; commonly triggered by passing a struct (containing a mutex) by value.

**Q7. What ordering guarantees does a mutex give?**
Everything sequenced before `Unlock` happens-before everything after the next `Lock` of the same mutex — that's the visibility contract. *Follow-up: does `Lock` alone guarantee you see fresh data?* Only relative to the prior holder's `Unlock` of the *same* mutex — it's not a global memory barrier across unrelated state.

**Q8. How would you detect a lock held too long in production?**
Add timing around critical sections, use the mutex profiler (`runtime.SetMutexProfileFraction`), or watch for goroutine pile-ups in `pprof`. *Follow-up: what does the block profile show vs mutex profile?* Block profile shows where goroutines wait; mutex profile attributes contention to the *holder* that caused the wait.

## 6. Production Use Cases

- **Connection / resource pools.** `database/sql`'s `DB` guards its idle connection list and pool counters with a mutex. Pools in Redis clients (`go-redis`), gRPC, and HTTP/2 transports do the same.
- **In-memory caches.** `groupcache`, `bigcache`, and most LRU caches (`hashicorp/golang-lru`) shard a map behind a mutex (often `RWMutex`) per shard to cut contention.
- **Metrics & counters.** Prometheus client internals and rate limiters (`golang.org/x/time/rate` token bucket) serialize counter/state updates with a mutex.
- **Config hot-reload.** A `RWMutex` lets thousands of request goroutines read config concurrently while a background goroutine swaps it under a write lock.
- **The standard library itself.** `sync.Once`, `sync.Pool` shards, `http.Server` listener tracking, and `log`'s output all use mutexes.
- **Sharded counters at scale.** Companies like Uber and Cloudflare shard hot counters across N mutexes (striped locking) to spread contention across CPU cache lines.

## 7. Common Mistakes

> [!WARNING]
> The single most common production bug is **forgetting to `Unlock` on an early return or panic**. Use `defer mu.Unlock()` immediately after `Lock` to make it bulletproof.

- **Copying a struct that embeds a mutex** — pass by pointer, always.
- **Recursive lock / lock-ordering deadlock** — locking A then B in one path and B then A in another.
- **Holding the lock during slow work** — doing I/O, RPCs, or `json.Marshal` inside the critical section serializes everything and destroys throughput.
- **Locking the wrong granularity** — one global lock for unrelated fields creates false contention.
- **Forgetting that read paths need the lock too** — a write under a mutex but a read without one is still a data race.
- **`defer mu.Unlock()` in a long-lived loop** — the unlock waits until function return; scope the lock with an inner function or explicit unlock instead.

## 8. Performance Considerations

An uncontended `Lock`/`Unlock` pair is a couple of atomic operations — roughly **15–25 ns**, often faster than a channel send. The cost explodes under contention: a parked goroutine costs a futex syscall and a context switch (microseconds), and the cache line holding `state` ping-pongs between cores (**cache-line bouncing**).

| Scenario | Approx cost | Note |
|---|---|---|
| Uncontended Lock/Unlock | ~20 ns | fast-path CAS only |
| Light contention (spin wins) | ~50–200 ns | active spin, no park |
| Heavy contention (park) | µs-range | syscall + context switch |
| Cache-line bouncing | hidden, severe | multiple cores writing `state` |

Mitigations: **shrink the critical section** to the absolute minimum; **shard the lock** (striped locking) so hot keys land on different mutexes; consider **atomics** (`sync/atomic`, `atomic.Int64`) for single-word counters where no multi-field invariant exists; use `sync.RWMutex` only when reads truly dominate.

> [!TIP]
> Pad striped mutexes to a cache line (64 bytes) to avoid *false sharing* — two mutexes on the same cache line contend even if logically independent.

## 9. Best Practices

- `defer mu.Unlock()` right after `Lock()` unless you have a measured reason not to.
- Keep the **critical section tiny** — compute outside the lock, mutate inside.
- Put the mutex **next to the data it protects**, ideally with a comment: `// guarded by mu`.
- Establish a **global lock ordering** and always acquire in that order; document it.
- Prefer **unexported mutexes**; never expose a lock as part of your public API.
- Use the `...locked` helper pattern for re-entrant-looking call paths.
- Run `go test -race` in CI — it's the single highest-ROI concurrency safeguard.
- Reach for atomics for pure counters; reach for `RWMutex` only after profiling proves read dominance.

## 10. Code Examples

Primary: a thread-safe counter with the lock co-located with its data and the `...locked` helper pattern.

```go
package main

import (
    "fmt"
    "sync"
)

// SafeCounter guards count with mu. Lock is unexported and next to data.
type SafeCounter struct {
    mu    sync.Mutex // guards count
    count int64
}

func (c *SafeCounter) Inc() {
    c.mu.Lock()
    defer c.mu.Unlock()
    c.incLocked() // re-use logic; caller holds the lock
}

// incLocked assumes c.mu is already held (the "...locked" pattern).
func (c *SafeCounter) incLocked() { c.count++ }

func (c *SafeCounter) Value() int64 {
    c.mu.Lock()
    defer c.mu.Unlock()
    return c.count
}

func main() {
    c := &SafeCounter{}
    var wg sync.WaitGroup
    for i := 0; i < 1000; i++ {
        wg.Add(1)
        go func() { defer wg.Done(); c.Inc() }()
    }
    wg.Wait()
    fmt.Println(c.Value()) // 1000, deterministically
}
```

```go
package main

import (
    "fmt"
    "sync"
    "sync/atomic"
)

// Alternative: for a single-word counter, atomics beat a mutex.
// No critical section, no parking — just a lock-free add.
type AtomicCounter struct{ count atomic.Int64 }

func (c *AtomicCounter) Inc()         { c.count.Add(1) }
func (c *AtomicCounter) Value() int64 { return c.count.Load() }

func main() {
    c := &AtomicCounter{}
    var wg sync.WaitGroup
    for i := 0; i < 1000; i++ {
        wg.Add(1)
        go func() { defer wg.Done(); c.Inc() }()
    }
    wg.Wait()
    fmt.Println(c.Value()) // 1000
}
```

Striped locking, the production pattern for hot maps — sharding spreads contention across many mutexes so unrelated keys never serialize:

```go
package main

import (
    "hash/fnv"
    "sync"
)

const shards = 16

type ShardedMap struct {
    locks [shards]sync.Mutex
    maps  [shards]map[string]int
}

func NewShardedMap() *ShardedMap {
    m := &ShardedMap{}
    for i := range m.maps {
        m.maps[i] = make(map[string]int)
    }
    return m
}

func (m *ShardedMap) shard(key string) int {
    h := fnv.New32a()
    _, _ = h.Write([]byte(key))
    return int(h.Sum32()) % shards
}

func (m *ShardedMap) Set(key string, val int) {
    s := m.shard(key)
    m.locks[s].Lock()
    defer m.locks[s].Unlock()
    m.maps[s][key] = val
}
```

## 11. Advanced Concepts

- **Striped / sharded locks** — the example above. With N shards you reduce expected contention by ~N×, at the cost of N× memory for the locks and no cheap global snapshot.
- **`sync.RWMutex` internals** — it wraps a writer `Mutex` plus a reader-count and reader-wait semaphore. A writer waiting blocks new readers (`readerCount` goes negative as a signal) to prevent writer starvation.
- **Lock-free alternatives** — `sync/atomic` for single words, `sync.Map` for append-mostly or disjoint-key maps, and copy-on-write (swap an `atomic.Pointer` to an immutable snapshot) for read-heavy config.
- **Adaptive spinning** — the runtime only spins on multicore machines, when no other waiter is running, and for a bounded count — spinning on a single core would just waste the holder's quantum.
- **Starvation mode internals** — the 1 ms `starvationThresholdNs` constant and direct FIFO handoff are what make Go's mutex safe to use even under adversarial contention; older runtimes (pre-Go 1.9) lacked this and could starve waiters indefinitely.
- **TryLock semantics** — `TryLock` never spins or parks; useful for "skip if busy" telemetry or deadlock-avoidance probes, never for normal mutual exclusion.

## 12. Debugging Tips

- **Data races:** `go test -race` / `go build -race`. The race detector instruments memory accesses and prints both stacks of a conflicting pair. Run it in CI and against integration tests.
- **Deadlocks:** if *all* goroutines block, the runtime prints `fatal error: all goroutines are asleep - deadlock!` with a full goroutine dump. For partial deadlocks, grab `SIGQUIT` (Ctrl-\) or `/debug/pprof/goroutine?debug=2` and look for many goroutines stuck in `sync.runtime_SemacquireMutex`.
- **Contention:** enable the mutex profile with `runtime.SetMutexProfileFraction(5)` and inspect via `go tool pprof http://host/debug/pprof/mutex`. The block profile (`runtime.SetBlockProfileRate`) shows where goroutines wait.
- **Held-too-long:** wrap suspect sections with timing or use a debug-build wrapper that warns if a lock is held past a threshold.

> [!TIP]
> The race detector finds *actual* races at runtime, not potential ones. A clean run only proves the executed paths were race-free — drive it with realistic, concurrent load.

## 13. Senior Engineer Notes

A senior engineer treats the mutex as a *design decision*, not a reflex. In code review, the first question is "what invariant does this lock protect, and is every access to that data covered?" — a write under lock with an unsynchronized read is the classic missed race. Insist on the `// guarded by mu` comment so the next reader knows the contract.

Push back on locks that wrap I/O or RPC calls; that's nearly always a latency bomb hiding in a green test suite. Coach the team on the `...locked` helper pattern to avoid both code duplication and accidental recursive deadlocks. Mentor juniors to default to `defer mu.Unlock()` and to reach for atomics only when the data is genuinely a single word.

Know the decision tree cold: single counter → atomic; read-dominated state → `RWMutex` or copy-on-write; multi-field invariant → plain `Mutex`; ownership transfer → channel. Be the person who runs `-race` against the contended path and reads a mutex profile before declaring a hotspot fixed rather than guessing.

## 14. Staff Engineer Notes

At staff level the concern shifts from one lock to **lock topology across services and teams**. A shared library that exposes a mutex in its public type forces every consumer into its locking model — define ownership boundaries so locks stay internal and APIs stay value- or context-based. Establish an **org-wide lock-ordering convention** and encode it in lint/review checklists; cross-team deadlocks are expensive precisely because no single team owns both locks.

Frame **build-vs-buy** honestly: before hand-rolling a sharded concurrent map, evaluate `sync.Map`, `hashicorp/golang-lru`, or an external cache (Redis) — the right answer depends on read/write ratio, key cardinality, and whether the state must survive a restart. For globally hot state, recognize when the answer is *not* a better mutex but a different architecture: partition the data so it's owned by one goroutine/shard/node, move to actor-style message passing, or push the contended counter to an append-only/atomic design.

Set the guardrails: `-race` mandatory in CI, mutex/block profiling wired into the standard observability stack, and a documented latency budget so the team knows when contention has crossed from "fine" to "redesign." The trade-off you're always brokering is throughput vs tail latency vs complexity — and the staff move is choosing the architecture where that trade-off barely matters.

## 15. Revision Summary

- `sync.Mutex` = `state int32` + `sema uint32`; zero value is unlocked and ready.
- Fast path: one atomic CAS (~20 ns). Slow path: spin, then park on a semaphore.
- **Normal mode** allows barging (throughput); **starvation mode** kicks in after a 1 ms wait and does FIFO handoff (bounded tail latency).
- Always `defer mu.Unlock()`; never copy a mutex (`go vet` copylocks); mutex is **not** recursive.
- Mutex gives both atomicity and a happens-before/visibility edge — reads need the lock too.
- Keep critical sections tiny; shard locks to cut contention; atomics for single words; `RWMutex` only when reads truly dominate.
- Debug with `go test -race`, mutex profile (`SetMutexProfileFraction`), block profile, and goroutine dumps.
- Decision tree: counter→atomic, read-heavy→RWMutex/COW, multi-field→Mutex, ownership transfer→channel.

**References:** Go `sync` package docs (`sync.Mutex`, `sync.RWMutex`); Go Memory Model; runtime `src/sync/mutex.go` (state bits, `starvationThresholdNs`); `go vet` copylocks analyzer; `runtime/pprof` mutex & block profiles.

---

*Go Engineering Handbook — topic 38.*
