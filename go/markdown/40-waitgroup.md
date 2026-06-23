# 40 · WaitGroup

> **In one line:** A `sync.WaitGroup` is a concurrency-safe counter that lets one goroutine block until a known number of other goroutines have signalled completion.

---

## 1. Overview

`sync.WaitGroup` solves one of the most common problems in concurrent Go: *"I launched N goroutines — wait until all of them finish before I continue."* It is a **barrier** built from a single integer counter plus a way to park and wake waiters.

The whole API is three methods:

- `Add(delta int)` — increment (or decrement) the counter by `delta`.
- `Done()` — shorthand for `Add(-1)`; called when a goroutine finishes its work.
- `Wait()` — block until the counter reaches zero.

The mental model: you tell the WaitGroup *how many* outstanding units of work exist (`Add`), each worker reports completion (`Done`), and a coordinator waits for the count to hit zero (`Wait`). When the counter transitions to zero, every parked `Wait()` caller is released simultaneously.

WaitGroup is the right tool when you care about **completion**, not **communication**. If you need results back from goroutines, you pair it with a channel or a shared slice; the WaitGroup only answers "are they all done yet?"

> [!NOTE]
> WaitGroup gives you fan-in synchronization with zero allocations and no channel machinery. For "wait for all" it is faster and clearer than a `done` channel with manual counting.

## 2. Why It Exists

Before WaitGroup, coordinating goroutine completion meant hand-rolling a counted channel:

```go
done := make(chan struct{})
for i := 0; i < n; i++ {
    go func() { /* work */ ; done <- struct{}{} }()
}
for i := 0; i < n; i++ {
    <-done // drain exactly n signals
}
```

This works but is error-prone: you must know `n` in two places, the channel buffers or blocks, and refactors that change the launch count silently deadlock. WaitGroup encapsulates that counting in a tested, lock-light primitive.

It exists because **completion-counting is a recurring pattern** in servers: scatter a request to 5 backends, wait for all; spawn a worker per partition, wait for the batch; run cleanup goroutines, wait before exit. Channels model *streams of values*; WaitGroup models *a count reaching zero*. Using the right abstraction makes intent obvious to the next reader and to the race detector.

It also provides a correctness guarantee channels do not give you for free: a clean **happens-before** edge. Everything a goroutine did before calling `Done()` is guaranteed visible to the goroutine that returns from `Wait()`. That memory-ordering guarantee is the real reason WaitGroup lives in `sync` and is not just user code.

## 3. Internal Working

A `WaitGroup` is tiny. In modern Go (1.22+) the struct is essentially:

```go
type WaitGroup struct {
    noCopy noCopy
    state  atomic.Uint64 // high 32 bits: counter; low 32 bits: waiter count
    sema   uint32        // runtime semaphore for parking waiters
}
```

The clever part is packing **two** 32-bit numbers into one 64-bit word so the counter and the waiter count can be updated together with a single atomic operation. The high 32 bits hold the **counter** (work remaining); the low 32 bits hold the number of goroutines currently blocked in `Wait()`.

```text
        state (atomic uint64)
 ┌───────────────────────────┬───────────────────────────┐
 │   counter  (high 32 bits) │   waiters  (low 32 bits)   │
 └───────────────────────────┴───────────────────────────┘
            ^ Add/Done                    ^ Wait

 Add(+3):  counter += 3   via atomic add on the high word
 Done():   counter -= 1   ── if counter hits 0 ──► release all waiters
 Wait():   if counter==0 return; else waiters++ and sleep on `sema`
```

**`Add(delta)`** does an atomic add of `delta << 32` to `state`, reads back the new counter (high bits) and waiter count (low bits). If the resulting counter is negative it panics (`"negative WaitGroup counter"`). If the counter is now zero **and** there are waiters, it resets the low word to zero and calls `runtime_Semrelease` once per waiter to wake them.

**`Done()`** is literally `Add(-1)`.

**`Wait()`** loops with a CAS: read `state`; if the counter is already zero, return immediately. Otherwise it tries to CAS the waiter count up by one. On success it blocks via `runtime_Semacquire(&sema)`. When woken (because some `Add`/`Done` drove the counter to zero), it returns.

The `sema` field is a runtime-managed semaphore — the same primitive backing `sync.Mutex`. Parking a waiter de-schedules the goroutine off its OS thread, so a blocked `Wait()` costs no CPU.

`noCopy` is a zero-size marker the `go vet` copylocks analyzer recognises: copying a WaitGroup by value is a bug (you'd duplicate the counter), and vet flags it.

> [!NOTE]
> Older Go versions stored a `[3]uint32` and did pointer-alignment gymnastics so the 64-bit word was 8-byte aligned on 32-bit platforms. Go 1.20+ uses `atomic.Uint64`, which guarantees alignment, eliminating that historical foot-gun.

## 4. Syntax

```go
var wg sync.WaitGroup

for _, job := range jobs {
    wg.Add(1)          // register ONE unit, BEFORE launching
    go func(j Job) {
        defer wg.Done() // guarantee the decrement, even on panic
        process(j)
    }(job)
}

wg.Wait() // block until counter == 0
```

Go 1.25 added a convenience method that fuses `Add(1)` + `go` + `defer Done()`:

```go
var wg sync.WaitGroup
for _, job := range jobs {
    wg.Go(func() { process(job) }) // Add/launch/Done handled internally
}
wg.Wait()
```

The cardinal rules: **always `Add` before `go`**, never inside the goroutine; **always `defer Done()`**; **never copy** a WaitGroup (pass `*sync.WaitGroup` or embed by pointer).

## 5. Common Interview Questions

**Q1. Why must `Add` be called before launching the goroutine, not inside it?**
If you call `Add(1)` inside the goroutine, the scheduler may run `Wait()` before that goroutine even starts. `Wait()` sees a zero counter and returns early, so you "wait" for nothing.
*Follow-up: Is there a deadlock risk?* No deadlock — the opposite, a premature return (a lost-wakeup-style bug). The fix is structural: `Add` happens-before `go`.

**Q2. What happens if the counter goes negative?**
`Add`/`Done` panics with `"sync: negative WaitGroup counter"`. It means more `Done()` calls than `Add()` — usually a double `Done` or an `Add` you forgot.
*Follow-up: How do you guard against double Done?* Use exactly one `defer wg.Done()` at the top of each goroutine and never call `Done()` elsewhere in that function.

**Q3. Can you reuse a WaitGroup?**
Yes — after `Wait()` returns and the counter is zero, you may `Add` again for a new round. But you must not call `Add` (raising the count from zero) *concurrently* with a `Wait()` that is still in flight; that's a documented race.
*Follow-up: How do you wait on successive batches?* Complete one `Add…Wait` cycle fully before starting the next. Don't overlap a new `Add` with a pending `Wait`.

**Q4. WaitGroup vs `errgroup.Group` — when do you reach for which?**
Use `sync.WaitGroup` when goroutines can't fail (or you handle errors yourself) and you only need completion. Use `golang.org/x/sync/errgroup` when you also need first-error propagation and group-wide cancellation.
*Follow-up: Does errgroup use a WaitGroup internally?* Yes — it embeds a `sync.WaitGroup` plus a `sync.Once` for the first error and a cancel func.

**Q5. Does WaitGroup provide memory-ordering guarantees?**
Yes. All operations before a `Done()` happen-before the return of any `Wait()` it unblocks. So writes a worker makes are visible after `Wait()` without extra synchronization.
*Follow-up: Then can I read a shared slice after Wait without a mutex?* Yes, **if** each goroutine writes to a disjoint index and you only read after `Wait()` returns.

**Q6. Why does `go vet` complain about passing a WaitGroup by value?**
WaitGroup embeds `noCopy`; copying duplicates the counter state, so `Done` on the copy never reaches the original's waiter. Always pass `*sync.WaitGroup`.
*Follow-up: What if it's a struct field?* Embedding it by value is fine; just never copy the enclosing struct after it's in use, and pass pointers to that struct.

**Q7. How would you implement "wait for all, but with a timeout"?**
WaitGroup has no timeout. Run `wg.Wait()` in a goroutine that closes a channel on return, then `select` on that channel against `time.After` or `ctx.Done()`.
*Follow-up: What leaks?* The worker goroutines keep running after the timeout; the `Wait`-watcher goroutine also stays parked until they finish. Cancel the work via context too.

## 6. Production Use Cases

- **Scatter-gather / fan-out API calls.** A request handler queries N microservices in parallel (e.g. an aggregation gateway hitting pricing, inventory, and reviews services), each goroutine writes its result into a preallocated slot, and the handler `Wait()`s before assembling the response. This is bread-and-butter for API gateways at companies like Uber and Netflix.
- **Parallel batch processing.** Data pipelines (ETL jobs, log shippers like Vector/Filebeat-style agents) spawn one goroutine per shard or file, then `Wait()` before committing a checkpoint.
- **Graceful shutdown.** A server tracks in-flight background workers with a WaitGroup and calls `wg.Wait()` in its shutdown path so it doesn't exit mid-write. Kubernetes controllers and gRPC servers commonly do this.
- **Bounded worker pools.** A WaitGroup tracks N persistent workers; closing the job channel lets them drain and `Done()`, and the dispatcher `Wait()`s for clean teardown.
- **Test orchestration.** `errgroup` (WaitGroup-backed) is the standard way to run parallel sub-tasks in integration tests and fail fast on the first error.

## 7. Common Mistakes

> [!WARNING]
> The five classic WaitGroup bugs, ranked by how often they appear in code review.

| Mistake | Symptom | Fix |
|---|---|---|
| `Add(1)` inside the goroutine | `Wait()` returns too early; flaky tests | `Add` before `go` |
| Forgetting `Done()` on an error path | `Wait()` hangs forever | `defer wg.Done()` first line |
| Calling `Done()` twice | panic: negative counter | one `defer`, never call manually |
| Passing `wg` by value | other goroutines decrement a copy; hang | pass `*sync.WaitGroup` |
| `Add` racing with `Wait` on reuse | data race, undefined behaviour | finish each cycle before the next |

A subtler one: closing over a loop variable. Before Go 1.22 each iteration shared one variable, so all goroutines saw the last value. Go 1.22+ scopes the loop variable per iteration, fixing it — but if you target older toolchains, pass the value as an argument: `go func(j Job){…}(job)`.

## 8. Performance Considerations

WaitGroup is cheap. `Add`/`Done` are a single atomic 64-bit add on the uncontended fast path — a few nanoseconds, **zero allocations**. `Wait()` on an already-zero counter is one atomic load and an immediate return.

Cost shows up only under genuine contention:

- **False sharing.** The `state` word is hammered by every `Add`/`Done`. If your goroutines call `Done` millions of times per second, that one cache line ping-pongs between cores. For extreme fan-out, prefer **one `Add(n)` up front** over `n` separate `Add(1)` calls — fewer atomic round-trips.
- **Granularity.** Don't use a WaitGroup to track a billion tiny tasks each doing nanoseconds of work; the synchronization dominates. Batch so each goroutine does a meaningful chunk.
- **Parking cost.** A `Wait()` that actually blocks costs a goroutine park plus a semaphore wakeup (sub-microsecond, but a scheduler interaction). That's fine for a once-per-request coordinator; it's a non-issue.

Rule of thumb: WaitGroup overhead is negligible unless you've made it the hot loop. If profiling shows the `state` cache line as contended, restructure to fewer, coarser `Add`/`Done` calls.

## 9. Best Practices

- **`Add` before `go`, always.** Make it a reflex; it's the single most important rule.
- **`defer wg.Done()` as the first statement** of the goroutine body — survives panics and early returns.
- **Add in bulk when N is known:** `wg.Add(len(jobs))` once, outside the loop, beats `Add(1)` per iteration.
- **Pass `*sync.WaitGroup`**, never a value. Let `go vet` catch copies.
- **Don't store results in the WaitGroup's mental model** — use a channel, a mutex-guarded structure, or disjoint slice slots.
- **For error handling and cancellation, use `errgroup`** instead of WaitGroup plus manual error plumbing.
- **One cycle at a time** when reusing: fully drain before re-`Add`.
- **Adopt `wg.Go` (Go 1.25+)** where available — it makes the Add/Done pairing un-forgettable.

## 10. Code Examples

Primary: idiomatic scatter-gather with disjoint result slots (no mutex needed).

```go
package main

import (
    "fmt"
    "sync"
)

func fetchAll(urls []string) []string {
    results := make([]string, len(urls)) // one slot per goroutine
    var wg sync.WaitGroup

    wg.Add(len(urls)) // bulk add, before any launch
    for i, url := range urls {
        go func(i int, url string) {
            defer wg.Done()
            results[i] = fetch(url) // disjoint index → race-free
        }(i, url)
    }

    wg.Wait() // safe to read results after this returns
    return results
}

func fetch(u string) string { return "body of " + u }

func main() {
    fmt.Println(fetchAll([]string{"a", "b", "c"}))
}
```

```go
// Alternative: errgroup for first-error + cancellation.
package main

import (
    "context"
    "fmt"

    "golang.org/x/sync/errgroup"
)

func fetchAll(ctx context.Context, urls []string) ([]string, error) {
    results := make([]string, len(urls))
    g, ctx := errgroup.WithContext(ctx)

    for i, url := range urls {
        i, url := i, url
        g.Go(func() error {
            body, err := fetchCtx(ctx, url)
            if err != nil {
                return err // cancels the group
            }
            results[i] = body
            return nil
        })
    }
    if err := g.Wait(); err != nil { // WaitGroup-backed Wait
        return nil, err
    }
    return results, nil
}

func fetchCtx(ctx context.Context, u string) (string, error) { return "ok:" + u, nil }
func main()                                                  { fmt.Println(fetchAll(context.Background(), []string{"x"})) }
```

Wait-with-timeout, since WaitGroup itself has none:

```go
func waitTimeout(wg *sync.WaitGroup, d time.Duration) bool {
    done := make(chan struct{})
    go func() { wg.Wait(); close(done) }()
    select {
    case <-done:
        return true // finished in time
    case <-time.After(d):
        return false // timed out (workers still running — cancel via ctx)
    }
}
```

## 11. Advanced Concepts

**Dynamic work generation.** When a worker discovers more work (e.g. a crawler finding new links), it can `Add` *to a counter that is still non-zero*, because its own outstanding `Add(1)` keeps the count above zero. This is safe: the rule that forbids racing `Add` with `Wait` only applies when raising from zero. The pattern: the spawning goroutine holds a "live" count, `Add`s children before spawning them, then `Done`s itself.

**Composing with context.** A WaitGroup answers "are they done?"; a `context.Context` answers "should they stop?". Real systems use both: context to signal cancellation, WaitGroup to confirm everyone *observed* the cancellation and exited. `wg.Wait()` after `cancel()` is the standard "drain" step in graceful shutdown.

**Why not a channel barrier?** A buffered channel of size N can emulate a WaitGroup, but you lose the panic-on-misuse safety, you allocate, and dynamic `Add` is awkward. WaitGroup is the specialized, cheaper tool.

**errgroup internals.** `errgroup.Group` = `sync.WaitGroup` + `sync.Once` (capture first error) + a cancel func + (in recent versions) an optional concurrency-limiting semaphore via `SetLimit`. Reading its source is the best way to internalize idiomatic WaitGroup composition.

## 12. Debugging Tips

- **Hang in `Wait()`?** Some goroutine never called `Done()` — usually an early `return` or `error` path that skipped it. Send `SIGQUIT` (or set `GOTRACEBACK=all`) to dump all goroutine stacks; look for the ones not parked in `Wait`. The fix is almost always a missing `defer wg.Done()`.
- **`panic: sync: negative WaitGroup counter`** — `Done` called more than `Add`. Search for every `Done()` call; you likely have a stray one outside the single `defer`.
- **`Wait()` returns instantly / flaky test** — `Add` is inside the goroutine. Move it before `go`.
- **`go vet ./...`** catches by-value copies of WaitGroup (copylocks). Run it in CI.
- **Race detector (`go test -race`)** catches `Add`-vs-`Wait` reuse races and disjoint-slot violations. Make `-race` part of CI; it's the single highest-leverage tool for concurrency bugs.

> [!TIP]
> Reproduce a "hang" deterministically by adding a `time.Sleep` before `Done` in one path and confirming `Wait` blocks — then you've located the offending goroutine.

## 13. Senior Engineer Notes

As a senior engineer your job is to make WaitGroup misuse *impossible* in code you own and review.

- **In reviews, scan for four patterns:** `Add` location, `defer Done`, by-value passing, and reuse races. These four checks catch ~95% of WaitGroup bugs. Make them a checklist comment.
- **Prefer the higher-level tool.** If a PR uses WaitGroup plus a manually-managed `error` and a `done` channel, push for `errgroup`. Raw WaitGroup is correct but lower-level; reserve it for the "can't fail / I handle errors inline" case.
- **Establish the disjoint-slot idiom** for fan-out results so juniors don't reach for a mutex they don't need — but make the disjointness obvious (index by loop var), or the next reader will "fix" it with a lock.
- **Always pair with context.** A WaitGroup with no cancellation path turns a slow dependency into an unbounded hang. The timeout wrapper without a context cancel leaks goroutines — flag that in review.
- **Mentoring framing:** teach the *why* (happens-before, lost-wakeup) not just the rule. Engineers who understand the memory model stop writing the bugs.

## 14. Staff Engineer Notes

At staff level the question shifts from "is this WaitGroup correct?" to "should concurrency primitives be exposed here at all, and how do we keep the org consistent?"

- **Encapsulate, don't proliferate.** Hundreds of hand-rolled WaitGroup loops across services are a liability. Provide a small internal library — a `parallel.Map`, a bounded worker pool, a scatter-gather helper — so application code expresses *intent* and the primitive lives in one audited place. This is the classic build-vs-buy-vs-wrap call: the stdlib primitive is "buy," your safe wrapper is the thin "build" that prevents org-wide footguns.
- **Backpressure and bounded concurrency are the real architectural concern.** A naked WaitGroup over an unbounded input set spawns unbounded goroutines and can OOM a node. At org scale, mandate `errgroup.SetLimit` or a semaphore-bounded pool in shared libraries; unbounded fan-out should fail review by policy.
- **Shutdown semantics are cross-cutting.** Standardize how every service drains in-flight work (context cancel → `wg.Wait()` with a deadline → forced exit). Inconsistent shutdown causes data loss and noisy 5xxs during deploys; this belongs in a platform framework, not per-team folklore.
- **Observability.** A bare WaitGroup is invisible in production. For critical pools, wrap it so the in-flight count is exported as a gauge — then a hung `Wait` shows up on a dashboard instead of as a mystery latency spike.
- **Trade-off judgement:** WaitGroup gives you completion with near-zero overhead but no errors, no cancellation, no limits, no visibility. Each gap is fine for a leaf utility and unacceptable for a core request path. Pick the abstraction level deliberately and document the choice.

## 15. Revision Summary

- WaitGroup = concurrency-safe counter + barrier; API is `Add`, `Done` (`= Add(-1)`), `Wait`.
- **Golden rule:** `Add` before `go`; `defer wg.Done()` first; never copy (pass `*sync.WaitGroup`).
- Internals: one `atomic.Uint64` packs counter (high 32) + waiters (low 32); zero counter releases all waiters via a runtime semaphore.
- Provides a **happens-before** edge: work before `Done` is visible after `Wait` — disjoint-slot writes need no mutex.
- Negative counter → panic (too many `Done`); `Add` inside goroutine → `Wait` returns early.
- Reuse is allowed one full cycle at a time; never race `Add`-from-zero with a live `Wait`.
- No timeout/cancel/errors built in — wrap with a channel for timeout, use **`errgroup`** for first-error + cancellation, and pair with **context** for graceful drain.
- Performance: nanosecond, zero-alloc fast path; watch false sharing under extreme fan-out — prefer bulk `Add(n)`; bound concurrency to avoid OOM.
- Tooling: `go vet` (copylocks) + `go test -race` catch most misuse; `GOTRACEBACK=all` to find a missing `Done`.

**References:** Go `sync` package documentation (`sync.WaitGroup`); the Go Memory Model; `golang.org/x/sync/errgroup`; Go 1.22 loop-variable semantics; Go 1.25 `WaitGroup.Go`.

---

*Go Engineering Handbook — topic 40.*
