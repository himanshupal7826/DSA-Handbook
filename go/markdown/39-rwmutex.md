# 39 · RWMutex

> **In one line:** `sync.RWMutex` lets many readers share a critical section concurrently while writers get exclusive access — a win only when reads vastly outnumber writes and the critical section is non-trivial.

---

## 1. Overview

A `sync.RWMutex` is a *reader/writer* mutual-exclusion lock. Unlike a plain `sync.Mutex`, which serializes *every* access, an `RWMutex` distinguishes two roles:

- **Readers** (`RLock`/`RUnlock`) may hold the lock *simultaneously* with other readers.
- **Writers** (`Lock`/`Unlock`) get *exclusive* access — no other reader or writer may proceed.

The invariant is simple: **any number of readers OR exactly one writer, never both.** The promise of `RWMutex` is throughput: if your data is read 1000x for every write, allowing those 1000 reads to run in parallel can dramatically beat serializing them through a `Mutex`. The catch — and the part interviewers love — is that this promise is conditional. Reader/writer locks add bookkeeping overhead, can *starve* writers (or readers, depending on policy), and frequently lose to a plain `Mutex` for short critical sections. This chapter covers when `rwmutex` actually helps, how Go implements it, and how reader-writer starvation manifests under contention.

## 2. Why It Exists

Consider a config map read on every request but reloaded once a minute. With a `Mutex`, two concurrent requests reading the map block each other for no semantic reason — they don't mutate shared state, so serializing them is pure waste. `RWMutex` exists to remove that false dependency: pure-read operations are *commutative* and *idempotent* with respect to shared memory, so they can safely overlap.

The fundamental tension `RWMutex` resolves is **correctness vs. concurrency**. You need mutual exclusion to prevent a writer from tearing a reader's view of the data, but you don't need it *between readers*. `RWMutex` encodes that asymmetry directly. The historical roots go back to Courtois, Heymans, and Parnas's 1971 "readers-writers problem," which formalized exactly this: how do you maximize reader concurrency without permanently locking out writers?

> [!NOTE]
> `RWMutex` only helps when the *workload* is read-heavy **and** the critical section is long enough that parallel reads recoup the lock's extra overhead. For trivial reads, a `Mutex` or an atomic/`sync.Map`/`atomic.Pointer` swap usually wins.

## 3. Internal Working

Go's `sync.RWMutex` (in `src/sync/rwmutex.go`) is built *on top of* a `sync.Mutex` plus atomic counters and two semaphores. The struct is small:

```go
type RWMutex struct {
    w           Mutex        // held by writers; serializes writers against each other
    writerSem   uint32       // writers wait here for active readers to drain
    readerSem   uint32       // readers wait here for an active/pending writer
    readerCount atomic.Int32 // pending+active readers; goes negative when a writer is present
    readerWait  atomic.Int32 // readers a departing writer is still waiting on
}

const rwmutexMaxReaders = 1 << 30
```

The clever trick is `readerCount`. Normally it counts readers. When a writer calls `Lock`, it atomically *subtracts* `rwmutexMaxReaders` (2^30) from `readerCount`, flipping it negative. New readers see a negative count and block on `readerSem`. The writer then records how many readers were still active (`readerWait`) and sleeps on `writerSem` until the last departing reader wakes it.

```text
            Lock()                                Unlock()
              │                                       │
  w.Lock() ───┤ serialize writers                     │ readerCount += MaxReaders (re-allow readers)
              │                                        │
 readerCount -= MaxReaders (block new readers)         │ release each waiting reader on readerSem
              │                                        │
 readerWait = #active readers ──► sleep on writerSem    │ w.Unlock()

  RLock():   if readerCount.Add(1) < 0  -> writer present/pending -> sleep on readerSem
  RUnlock(): if readerCount.Add(-1) < 0 -> writer waiting; if last (readerWait--==0) -> wake writerSem
```

Key behavioral consequences of this design:

- **Writer preference / no writer starvation.** Once a writer announces itself (the subtract), *new* readers queue behind it even if other readers are currently active. This prevents a steady stream of readers from starving a writer indefinitely. Go made this choice deliberately.
- **A reader that arrives after a writer waits.** It blocks on `readerSem`, so reads are not strictly "always allowed."
- **Cheap fast path.** With no writer present, `RLock`/`RUnlock` are just two atomic adds (`+1`/`-1`) — no semaphore, no spinning. That's why uncontended `RWMutex` reads are fast.
- **Race detector hooks.** Under `-race`, each lock/unlock calls into the race runtime to model happens-before edges, which is why race builds are much slower.

The zero value is a ready-to-use unlocked `RWMutex`. Like all `sync` types, it **must not be copied** after first use — copying duplicates the counters and semaphores, corrupting state. `go vet` catches this via the copylocks analyzer.

## 4. Syntax

```go
var mu sync.RWMutex

// Reader
mu.RLock()
v := shared.read()
mu.RUnlock()

// Writer
mu.Lock()
shared.write(v)
mu.Unlock()

// Idiomatic: defer + scoped helper
func get(k string) string {
    mu.RLock()
    defer mu.RUnlock()
    return m[k]
}

// RLocker(): adapt the read side to a sync.Locker interface
var l sync.Locker = mu.RLocker() // l.Lock() == mu.RLock()

// TryLock / TryRLock (Go 1.18+): non-blocking attempts
if mu.TryLock() {
    defer mu.Unlock()
    // got exclusive access
}
```

## 5. Common Interview Questions

**Q1. When is `RWMutex` faster than `Mutex`, and when is it slower?**
Faster when reads dominate (e.g. >90%) *and* the critical section is non-trivial so parallel readers actually overlap meaningful work. Slower when critical sections are tiny — the extra atomic bookkeeping and cache-line contention on `readerCount` exceed the parallelism gained, and a `Mutex` (a single CAS) wins.
*Follow-up: how would you decide empirically?* Benchmark both under your real read/write ratio and goroutine count with `go test -bench`; don't reason from first principles alone.

**Q2. Does Go's `RWMutex` prefer readers or writers?**
It is **writer-preferring**: a pending writer blocks newly arriving readers, so a stream of readers cannot starve a waiting writer. Readers already holding the lock are allowed to finish.
*Follow-up: can readers still be starved?* Yes — a steady stream of writers can starve readers, since each new writer takes priority over readers queued behind it.

**Q3. Can you upgrade an `RLock` to a `Lock` without releasing?**
No. Go's `RWMutex` has **no lock upgrade**. Two readers each trying to upgrade would deadlock waiting for the other to release. You must `RUnlock` then `Lock`, and **re-validate** state because it may have changed in the gap.
*Follow-up: how to make read-then-maybe-write atomic?* Acquire `Lock` up front, or use a `Mutex`, or restructure with an atomic snapshot/CAS pattern.

**Q4. Is `RWMutex` reentrant / recursive?**
No. Acquiring `RLock` twice on the same goroutine can deadlock: if a writer arrives between the two `RLock` calls, the second `RLock` blocks behind the writer, and the writer blocks behind your first (still-held) read lock — classic deadlock.
*Follow-up: how to avoid?* Never re-acquire; restructure so the lock is taken once at the boundary and helpers assume it's held.

**Q5. What happens if you `Unlock` an unlocked `RWMutex` or mismatch `RLock`/`Unlock`?**
It panics ("sync: Unlock of unlocked RWMutex" / "RUnlock of unlocked RWMutex"). The counters detect the invariant violation. Mismatching read/write pairs corrupts state.
*Follow-up: why panic instead of returning an error?* These are programmer bugs, not recoverable conditions; failing fast surfaces them immediately.

**Q6. How is `RWMutex` implemented under the hood?**
A writer `Mutex` to serialize writers, an atomic `readerCount` that goes negative when a writer is present, a `readerWait` counter, and two semaphores (`readerSem`, `writerSem`). See section 3.
*Follow-up: why subtract 2^30?* It's a sentinel large enough to exceed any realistic reader count, flipping the sign so readers cheaply detect a writer with one atomic read.

**Q7. `RWMutex` vs `atomic.Pointer` vs `sync.Map` for a read-mostly cache?**
For a value swapped wholesale (config), `atomic.Pointer[T]` with copy-on-write is fastest — readers do a single atomic load, zero contention. `sync.Map` suits disjoint keys with high churn. `RWMutex` fits when you mutate *in place* and reads do real work under the lock.
*Follow-up: downside of copy-on-write?* Each write copies the whole structure — fine for small configs, costly for large frequently-written maps.

## 6. Production Use Cases

- **Configuration / feature-flag stores.** A struct read on every request, reloaded periodically. Go's own `expvar` and many config libraries guard maps with `RWMutex`. Companies like Uber and Dropbox use read-mostly config caches exactly this shape.
- **In-memory caches and routing tables.** Service meshes and reverse proxies (e.g. patterns in Envoy-style or Go-based proxies) keep route tables read on the hot path and swapped on control-plane updates.
- **Connection / client pools metadata.** Database drivers and gRPC client pools read pool state frequently, mutate on resize.
- **Prometheus client internals.** The Go `prometheus` client uses fine-grained locking for metric registries that are read during scrapes and written during registration.
- **Kubernetes informer caches** conceptually expose read-heavy local stores; the broader ecosystem uses `RWMutex` widely for shared informers' indexers and listers.

> [!TIP]
> Before reaching for `RWMutex`, ask: "Can I make the write a pointer swap?" If yes, `atomic.Pointer[T]` with copy-on-write gives lock-free reads and usually beats `RWMutex` outright.

## 7. Common Mistakes

> [!WARNING]
> The most common real-world bug is using `RWMutex` for *short* critical sections under high reader concurrency and assuming it's faster than `Mutex`. The shared `readerCount` cache line ping-pongs across cores, and you can end up *slower* than a `Mutex`.

- **Mismatched pairs.** Calling `Unlock` after `RLock` (or vice versa) — panics or corrupts state. Always pair `RLock`/`RUnlock` and `Lock`/`Unlock`, ideally with `defer`.
- **Holding the lock across I/O.** A read lock held during a network call blocks every writer for the duration. Copy out what you need, release, then do the slow work.
- **Attempting lock upgrade.** `RUnlock` then `Lock` and re-reading is the only safe way; assuming the state is unchanged is a bug.
- **Recursive `RLock`.** Re-acquiring a read lock you already hold can deadlock against an intervening writer.
- **Copying the struct.** Passing an `RWMutex` (or a struct containing one) by value. Use pointers; trust `go vet`.

## 8. Performance Considerations

The decision hinges on three variables: **read/write ratio**, **critical-section length**, and **core count**.

| Scenario | Best choice | Why |
|---|---|---|
| Tiny read, any ratio | `Mutex` or atomic | RWMutex overhead > parallelism gained |
| Long read, >95% reads | `RWMutex` | Parallel readers amortize cost |
| Whole-value swap | `atomic.Pointer[T]` (COW) | Lock-free reads |
| Disjoint-key churn | `sync.Map` | Sharded internally |
| Write-heavy | `Mutex` | RWMutex degenerates + risks reader starvation |

Concrete intuition: on a busy server, `RWMutex.RLock`/`RUnlock` is ~2 atomic ops, but all readers touch the *same* `readerCount` cache line, so the coherence traffic grows with cores. A plain `Mutex` on an uncontended path is a single CAS. Benchmarks frequently show `Mutex` winning for sub-microsecond critical sections even at 99% reads. The crossover point is real but workload-specific — **measure**.

For the read-mostly-swap case, `atomic.Pointer[T]` is in a different league: readers never contend at all, only the (rare) writer does a single atomic store.

## 9. Best Practices

- **Default to `Mutex`.** Reach for `RWMutex` only after profiling shows reader contention on a non-trivial critical section.
- **Keep critical sections minimal.** Read the field, copy it, unlock, *then* compute. Never hold a lock across syscalls or I/O.
- **Always `defer` the unlock** unless you've measured the `defer` overhead as significant on a hot path (then unlock explicitly, carefully).
- **Wrap the lock + data in a type.** Don't expose the mutex; expose `Get`/`Set` methods so callers can't mismatch pairs.
- **Prefer copy-on-write with `atomic.Pointer`** for config/route tables.
- **Run `go vet` and `-race`** in CI to catch copies and ordering bugs.

## 10. Code Examples

Primary: a concurrency-safe read-mostly cache encapsulating the lock.

```go
package cache

import "sync"

// SafeMap is a read-optimized concurrent map.
type SafeMap[K comparable, V any] struct {
    mu sync.RWMutex
    m  map[K]V
}

func New[K comparable, V any]() *SafeMap[K, V] {
    return &SafeMap[K, V]{m: make(map[K]V)}
}

func (s *SafeMap[K, V]) Get(k K) (V, bool) {
    s.mu.RLock()
    defer s.mu.RUnlock()
    v, ok := s.m[k]
    return v, ok // copy out under the read lock
}

func (s *SafeMap[K, V]) Set(k K, v V) {
    s.mu.Lock()
    defer s.mu.Unlock()
    s.m[k] = v
}

func (s *SafeMap[K, V]) Len() int {
    s.mu.RLock()
    defer s.mu.RUnlock()
    return len(s.m)
}
```
```go
package config

import "sync/atomic"

// Config is swapped wholesale, so readers are lock-free.
type Config struct {
    Timeout int
    Hosts   []string
}

type Store struct {
    cur atomic.Pointer[Config]
}

func NewStore(initial *Config) *Store {
    s := &Store{}
    s.cur.Store(initial)
    return s
}

// Load is contention-free: a single atomic pointer read.
func (s *Store) Load() *Config { return s.cur.Load() }

// Reload swaps in a new immutable snapshot (copy-on-write).
func (s *Store) Reload(next *Config) { s.cur.Store(next) }
```

The two tabs contrast in-place mutation guarded by `RWMutex` (when readers must run real logic under the lock) versus the lock-free copy-on-write pattern (when the whole value is replaced atomically). For pure config reload, prefer the second.

Here is a separate, standalone example showing the upgrade pitfall and the correct re-validate pattern.

```go
// WRONG to assume state is unchanged: there is no lock upgrade.
func (s *SafeMap[K, V]) GetOrCompute(k K, f func() V) V {
    s.mu.RLock()
    if v, ok := s.m[k]; ok {
        s.mu.RUnlock()
        return v
    }
    s.mu.RUnlock() // must drop the read lock fully

    s.mu.Lock() // then take the write lock
    defer s.mu.Unlock()
    if v, ok := s.m[k]; ok { // RE-VALIDATE: another goroutine may have set it
        return v
    }
    v := f()
    s.m[k] = v
    return v
}
```

## 11. Advanced Concepts

- **Writer-preference policy and tail latency.** Go's writer preference bounds writer latency but can spike *reader* latency when writes cluster. If you need predictable read latency, copy-on-write removes the writer-vs-reader interaction entirely.
- **`RLocker()`** returns a `sync.Locker` whose `Lock`/`Unlock` map to `RLock`/`RUnlock`, useful for passing the read side to APIs (e.g. `sync.Cond`) that want a `Locker`.
- **Sharded locks.** For very high write rates, split data into N shards each with its own lock (or `RWMutex`), hashing keys to shards. This is essentially what `sync.Map` does internally and what high-throughput caches (e.g. `bigcache`, `groupcache`-style) adopt.
- **Seqlocks** (sequence locks) are an alternative for read-mostly data: readers retry if a write happened during their read, giving truly lock-free readers. Go has no built-in seqlock, but you can build one with atomics; it suits tiny fixed-size structs.
- **False sharing.** Place hot `RWMutex` instances on their own cache lines (padding) when multiple unrelated locks share one — otherwise unrelated contention bleeds across.

## 12. Debugging Tips

- **`go run -race` / `go test -race`** is the first tool: it catches unsynchronized reads/writes and reports the conflicting stacks with happens-before context.
- **`go vet`** flags lock copies (copylocks) — a frequent silent corruption source.
- **Deadlock dumps.** On a hard deadlock, Go prints "fatal error: all goroutines are asleep - deadlock!" with stacks. Look for goroutines parked in `sync.runtime_SemacquireRWMutex` / `sync.runtime_SemacquireMutex`.
- **`runtime/pprof` mutex & block profiles.** Enable `runtime.SetMutexProfileFraction(n)` and `runtime.SetBlockProfileRate(n)`, then inspect `/debug/pprof/mutex` and `/debug/pprof/block` to find the contended lock and how long goroutines wait on it.
- **Goroutine dump** via `SIGQUIT` or `pprof.Lookup("goroutine")` shows who holds and who waits.

> [!NOTE]
> Mutex contention often hides as "high CPU but low throughput." A mutex profile pointing at `RWMutex.RLock` is a strong signal you've picked the wrong primitive for a short critical section.

## 13. Senior Engineer Notes

As a senior engineer, your job is to make the *right local choice* and to catch the wrong one in review. Default to `Mutex`; only introduce `RWMutex` with a benchmark or profile attached to the PR. In code review, flag: locks held across I/O, exported mutex fields, attempted lock upgrades, and recursive locking. Insist that lock-protected state be encapsulated behind methods so callers literally cannot mismatch `RLock`/`Unlock`.

When mentoring, teach the mental model — "any number of readers OR one writer" — and the empirical discipline that goes with it: nobody should claim `RWMutex` is faster without a `go test -bench` to back it. Push juniors toward `atomic.Pointer` copy-on-write for config, which sidesteps an entire class of bugs. Own the small design judgments: shard size, where the lock boundary sits, whether a hot path can drop the lock before computing. These are the decisions that quietly determine whether a service holds its p99 under load.

## 14. Staff Engineer Notes

At staff level the question shifts from "which lock" to "should this be shared mutable state at all." The most scalable answer is often *no*: partition data per-goroutine/per-shard, use message passing, or make state immutable and swap pointers. A single hot `RWMutex` is a scalability ceiling — it does not get better with more cores, it gets worse. Recognizing that ceiling *before* it's load-bearing across teams is the staff contribution.

Cross-team, standardize the patterns: a shared internal library exposing a copy-on-write config store, sharded cache, and benchmarked guidance ("use Mutex below X, shard above Y") prevents every team from re-discovering reader starvation in production. On build-vs-buy: for caches, evaluate mature libraries (`ristretto`, `bigcache`) before hand-rolling sharded `RWMutex` maps — they've already solved eviction, sizing, and contention. Weigh the org-level cost: a custom lock-heavy cache is cheap to write and expensive to operate (incidents, profiling, on-call). Finally, drive observability standards: mutex/block profiling enabled by default in services, with dashboards for lock wait time, so contention is caught in canary, not at 3 a.m.

## 15. Revision Summary

- `RWMutex` = many readers **or** one writer; never both.
- Built on a writer `Mutex` + atomic `readerCount` (goes negative when a writer is present) + two semaphores.
- **Writer-preferring**: pending writers block new readers, so writers don't starve; readers can.
- **No upgrade, not reentrant, not copyable** — re-validate after `RUnlock`→`Lock`; use pointers; trust `go vet`.
- Only beats `Mutex` when reads dominate **and** the critical section is non-trivial; measure with `go test -bench`.
- For whole-value swaps prefer `atomic.Pointer[T]` copy-on-write (lock-free reads); for key churn consider `sync.Map`; for write-heavy, shard.
- Never hold the lock across I/O; encapsulate the lock behind methods; debug with `-race`, `go vet`, and mutex/block profiles.

**References:** Go `sync` package (`sync.RWMutex`, `sync.Mutex`, `sync.Locker`); `src/sync/rwmutex.go`; `sync/atomic` (`atomic.Pointer`); `runtime/pprof` mutex & block profiles; Courtois, Heymans & Parnas (1971), "Concurrent Control with Readers and Writers."

---
*Go Engineering Handbook — topic 39.*
