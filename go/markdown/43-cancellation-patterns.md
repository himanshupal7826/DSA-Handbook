# 43 · Cancellation Patterns

> **In one line:** Cancellation is the discipline of propagating a single "stop now" signal — via `done` channels or `context` trees — down through every goroutine you spawned, so fan-outs unwind cleanly instead of leaking.

---

## 1. Overview

A goroutine is cheap to start and impossible to kill from the outside. Go gives you no `thread.interrupt()`, no `kill -9` for a goroutine. The only way to stop work is **cooperative cancellation**: the goroutine itself must periodically check a signal and return.

This chapter is about the three layers of that discipline:

1. **The `done` channel** — the primitive. A channel you `close()` to broadcast "stop" to N readers at once.
2. **`context.Context`** — the standardized, composable wrapper around a `done` channel, plus deadline and value propagation, that forms a **cancellation tree**.
3. **Graceful shutdown of fan-outs** — applying both to pipelines, worker pools, and servers so that when one stage fails or the caller walks away, *every* downstream goroutine stops, no goroutine leaks, and resources (sockets, file handles, DB transactions) are released.

If you take one idea away: **cancellation is a tree, and the close of a channel is a broadcast.** Everything else is plumbing.

---

## 2. Why It Exists

Without cancellation, concurrent Go programs rot in two ways:

- **Goroutine leaks.** A goroutine blocked forever on a channel send/receive is never garbage-collected — the runtime can't prove it's dead. Each leak holds its stack (min 8 KB), captured variables, and any resources it owns. A request handler that leaks one goroutine per request will OOM a server in hours.
- **Wasted work.** The user closed the browser tab, the gRPC client hit its deadline, the parent request failed — but your 12 fan-out workers keep hammering the database for results nobody will read.

The classic motivating case is from the **Go blog's "Pipelines and cancellation"** article: a `gen → sq → merge` pipeline where the consumer reads only the first result and returns. Without a cancellation signal, the upstream stages block forever trying to send into a channel nobody drains. The fix is a shared `done` channel that every stage selects on.

`context` was added to the standard library (Go 1.7, promoted from `golang.org/x/net/context`) precisely because every team was reinventing this `done`-channel-plus-deadline pattern incompatibly. It standardized the *shape* of cancellation so libraries could interoperate.

---

## 3. Internal Working

### The `done` channel as a broadcast

The whole mechanism rests on one runtime fact: **closing a channel makes every blocked and future receive return immediately** with the zero value and `ok == false`.

```text
        close(done)
            │
   ┌────────┼────────┬────────┐
   ▼        ▼        ▼        ▼
 <-done   <-done   <-done   <-done     (all unblock at once)
  g1       g2       g3       g4
```

Internally a channel is an `hchan` struct (`runtime/chan.go`). It holds a `closed uint32` flag, a mutex, and two wait queues (`recvq`, `sendq`) of `sudog`s — one per parked goroutine. `closechan` takes the lock, sets `closed = 1`, then walks `recvq` and `sendq` and calls `goready` on every parked goroutine, releasing them onto run queues. That single `O(waiters)` sweep is the "broadcast." A `select` with a `<-done` case compiles to `selectgo`, which registers the goroutine on each channel's wait queue; the close wakes it.

### The context tree

A `context.Context` is an interface. The concrete types live in `context/context.go`:

```text
context.Background()                  <- emptyCtx (never cancelled, no done chan)
        | WithCancel
        v
   cancelCtx (root of a subtree)
   |-- done   atomic.Value -> chan struct{}   (lazily created)
   |-- children map[canceler]struct{}         (set of child cancelCtxs)
   |-- err     error                          (Canceled / DeadlineExceeded)
   '-- mu      sync.Mutex
        | WithTimeout / WithDeadline
        v
   timerCtx (embeds cancelCtx + *time.Timer + deadline)
```

A `cancelCtx`'s `done` channel is created **lazily** on first call to `Done()` (via `atomic.Value`) — if you never select on it, you never allocate it. When you call the `cancel()` func returned by `WithCancel`:

1. It locks `mu`, sets `err` (the reason), and **closes the `done` channel** (the broadcast above).
2. It iterates `children` and calls `child.cancel(false, err, cause)` on each — **recursively cancelling the whole subtree**.
3. It removes itself from its parent's `children` map so the parent can be GC'd.

That child registration is why cancellation propagates downward but not upward: cancelling a child never touches the parent. A `timerCtx` additionally arms a `time.Timer` that calls `cancel` with `DeadlineExceeded` when the deadline fires.

> [!NOTE]
> `propagateCancel` walks up looking for the nearest ancestor `cancelCtx` to register the child in its `children` map. If an ancestor is a *custom* context (not a stdlib `cancelCtx`), the runtime spins up a goroutine that selects on `parent.Done()` to bridge the two — a rare hidden cost of wrapping contexts in non-stdlib types.

---

## 4. Syntax

```go
// 1. The raw done-channel idiom
done := make(chan struct{})
go func() {
    for {
        select {
        case <-done:
            return // cancellation observed
        case v := <-work:
            process(v)
        }
    }
}()
close(done) // broadcast stop to all readers of `done`

// 2. context: cancel, timeout, deadline
ctx, cancel := context.WithCancel(context.Background())
defer cancel() // ALWAYS defer cancel — even on the timeout variants

ctx, cancel := context.WithTimeout(parent, 2*time.Second)
ctx, cancel := context.WithDeadline(parent, time.Now().Add(2*time.Second))
ctx, cancel := context.WithCancelCause(parent)        // Go 1.20+: cancel(err)
cancel(fmt.Errorf("upstream failed"))
context.Cause(ctx)                                    // retrieve that error

// 3. Observing cancellation inside a goroutine
select {
case <-ctx.Done():
    return ctx.Err() // context.Canceled or context.DeadlineExceeded
case result := <-ch:
    use(result)
}
```

`chan struct{}` is the idiomatic done channel: `struct{}` is zero-width, so the channel carries only the open/closed signal, no data.

---

## 5. Common Interview Questions

**Q1. Why `close(done)` instead of sending on it?**
A send delivers to *one* receiver. `close` unblocks *all* current and future receivers — it's the only built-in broadcast. With N workers you'd need N sends (and know N); a close is O(1) for the caller. **Follow-up: what if you send on a closed channel?** Panic. That's why the canceller owns the channel and only ever closes it — never the workers.

**Q2. Who is responsible for calling `cancel()`?**
The function that *created* the context via `WithCancel`/`WithTimeout`. You must `defer cancel()` even for timeout contexts, otherwise the `timerCtx`'s timer and the context object leak until the deadline fires. `go vet` flags a missing cancel. **Follow-up: is it safe to call cancel twice?** Yes — `cancel` is idempotent; the second call is a no-op because `done` is already closed.

**Q3. Should I store a `context.Context` in a struct field?**
Generally no. The convention is to pass `ctx` as the first parameter of each call. A struct-stored context ties the object's lifetime to one request and breaks reuse. The documented exception is request-scoped types that never escape one request. **Follow-up: where does context-as-field actually appear?** In types like `http.Request` (via `WithContext`), which *are* request-scoped.

**Q4. What's the difference between `ctx.Done()` and `ctx.Err()`?**
`Done()` returns a channel that's closed on cancellation — use it in `select`. `Err()` returns *why* (nil if not yet cancelled, else `Canceled`/`DeadlineExceeded`). Read `Err()` only after `Done()` fires. **Follow-up: how do you get the underlying cause from `WithCancelCause`?** `context.Cause(ctx)`, which returns the specific error passed to `cancel(err)`, while `ctx.Err()` still returns the generic `Canceled`.

**Q5. How does cancellation propagate through a tree?**
Cancelling a node closes its `done` and recursively cancels all children; ancestors are untouched. So a parent timeout cancels every descendant, but a child cancel doesn't affect siblings or the parent. **Follow-up: does a child's deadline override the parent's?** The *effective* deadline is the earliest of all ancestors — `WithTimeout` won't extend a parent that expires sooner.

**Q6. Why might a goroutine ignore cancellation entirely?**
Because cancellation is cooperative — a goroutine blocked in a syscall, a CGo call, or a tight CPU loop that never selects on `ctx.Done()` will not stop. You must thread the context into the blocking call (e.g. `db.QueryContext`, `http.NewRequestWithContext`) or chunk the loop. **Follow-up: how do you cancel an in-flight `net` read?** Set a deadline with `conn.SetReadDeadline`, often driven by `ctx`.

**Q7. What does `errgroup` add over a `sync.WaitGroup`?**
`errgroup.Group` collects the first non-nil error and, via `errgroup.WithContext`, **cancels the shared context the moment any goroutine returns an error** — turning "one worker failed" into "everyone stops." `WaitGroup` only waits; it has no error or cancellation semantics. **Follow-up: how do you bound concurrency with errgroup?** `g.SetLimit(n)` (Go 1.20+) caps concurrent goroutines started via `g.Go`.

---

## 6. Production Use Cases

- **HTTP/gRPC servers.** `net/http` derives a per-request `ctx` cancelled when the client disconnects (`r.Context()`); gRPC does the same with deadline propagation across service hops. Database drivers (`database/sql` `QueryContext`, pgx) abort the query when that context cancels — saving the DB from doing throwaway work.
- **Pipelines (the Go blog pattern).** ETL and stream-processing stages share a `done`/`ctx` so a failure or early consumer return tears down the whole `gen -> transform -> sink` chain.
- **Worker pools / fan-out.** Kubernetes controllers, `golang.org/x/sync/errgroup` based aggregators (e.g. a search service fanning out to 8 shards), and CI runners all cancel siblings when one shard errors or the overall deadline hits.
- **Graceful server shutdown.** `http.Server.Shutdown(ctx)` stops accepting new connections and waits for in-flight ones up to the context deadline — the canonical SIGTERM handler in every Kubernetes-deployed Go service.
- **Background daemons.** Tools like Prometheus, etcd, and CockroachDB build a root context cancelled on SIGINT/SIGTERM (`signal.NotifyContext`), propagated to every subsystem so the process exits cleanly within the orchestrator's grace period (default 30s in k8s).

---

## 7. Common Mistakes

> [!WARNING]
> These are the leaks that page you at 3 a.m.

| Mistake | Consequence | Fix |
|---|---|---|
| Forgetting `defer cancel()` | Timer + context leak until deadline | Always `defer cancel()` immediately after creation |
| Workers `close(done)` | Panic on double-close / send-on-closed | Only the owner closes; one owner |
| Goroutine selects on work but not `ctx.Done()` | Leak when consumer leaves | Add `case <-ctx.Done(): return` to every blocking select |
| Unbuffered result channel + early return | Sender blocks forever | Buffer the channel *or* select on `ctx.Done()` in the sender |
| Ignoring `ctx` in a CPU/IO loop | Cancellation never observed | Poll `ctx.Err()` per chunk; use `*Context` driver APIs |
| `context.TODO()` left in production | No real cancellation wired | `TODO()` is a placeholder; replace before shipping |
| Passing `nil` context | Panic on `Done()`/`Err()` | Use `context.Background()` at the root |

The single most common leak: a producer doing `ch <- v` with no `select { case <-ctx.Done(): }`. When the consumer cancels and stops reading, the producer parks forever.

---

## 8. Performance Considerations

- **Allocation.** A `cancelCtx`'s done channel is lazy — created only on first `Done()`. `WithValue` allocates a tiny linked node per key; deep value chains make lookups O(depth). Don't build 50-deep context chains in a hot path.
- **`select` cost.** Each `select` registers a `sudog` per channel case. In a tight inner loop, selecting on `ctx.Done()` every iteration is measurable. Mitigate by checking `ctx.Err()` (a cheap atomic-guarded load) every K iterations rather than selecting each time.
- **The close broadcast** is O(waiters) but happens once per cancellation — negligible.
- **`signal.NotifyContext`** spawns one goroutine; trivial.
- **errgroup** uses one `WaitGroup` + a `sync.Once` for the error; overhead is a few atomics per goroutine.

> [!TIP]
> Benchmark the per-iteration `select` vs periodic `ctx.Err()` check. For a loop doing microsecond-scale work, polling `ctx.Err()` every 1,024 iterations cuts cancellation-check overhead by ~1000x while keeping latency-to-cancel under a millisecond.

---

## 9. Best Practices

1. **Pass `ctx` as the first arg**, named `ctx`. Never store in a struct (except request-scoped types).
2. **`defer cancel()` always**, even with timeouts. Treat it like `defer f.Close()`.
3. **Owner closes, owner cancels.** One goroutine owns the done channel / cancel func.
4. **Every blocking operation gets a `ctx.Done()` escape** in its `select`.
5. **Use `errgroup.WithContext` for fan-outs** — it gives you error aggregation *and* sibling cancellation for free.
6. **Use `chan struct{}`** for done signals (zero-width).
7. **Honor cancellation in libraries** by accepting and threading `ctx` into downstream calls — don't swallow it.
8. **Set deadlines at the edge** (incoming request) and let them propagate; don't invent per-layer timeouts that fight the caller.
9. **On shutdown, cancel the root, then `Wait()`** for graceful drain with its own bounded deadline.

---

## 10. Code Examples

Primary: a fan-out worker pool using `errgroup` with shared cancellation — any worker error stops the rest.

```go
package main

import (
	"context"
	"fmt"
	"time"

	"golang.org/x/sync/errgroup"
)

func fanOut(ctx context.Context, ids []int) ([]string, error) {
	g, ctx := errgroup.WithContext(ctx) // ctx cancelled on first error
	g.SetLimit(4)                       // at most 4 concurrent workers

	results := make([]string, len(ids))
	for i, id := range ids {
		i, id := i, id // capture (pre-1.22 habit; harmless on 1.22+)
		g.Go(func() error {
			select {
			case <-ctx.Done():
				return ctx.Err() // sibling failed or deadline hit
			case <-time.After(time.Duration(id) * 10 * time.Millisecond):
			}
			if id == 7 {
				return fmt.Errorf("worker %d failed", id)
			}
			results[i] = fmt.Sprintf("ok-%d", id)
			return nil
		})
	}
	if err := g.Wait(); err != nil { // returns first error, after all return
		return nil, err
	}
	return results, nil
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	res, err := fanOut(ctx, []int{1, 2, 3, 7, 5})
	fmt.Println(res, err)
}
```

```go
// Alternative: raw done-channel pipeline (the Go blog pattern), no errgroup.
package main

import "fmt"

func gen(done <-chan struct{}, nums ...int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for _, n := range nums {
			select {
			case out <- n:
			case <-done: // consumer left; stop producing
				return
			}
		}
	}()
	return out
}

func sq(done <-chan struct{}, in <-chan int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for n := range in {
			select {
			case out <- n * n:
			case <-done:
				return
			}
		}
	}()
	return out
}

func main() {
	done := make(chan struct{})
	defer close(done) // broadcast stop to every stage on return

	for v := range sq(done, gen(done, 2, 3, 4, 5)) {
		fmt.Println(v)
		if v == 9 {
			return // early exit — defer close(done) unwinds the pipeline
		}
	}
}
```

Graceful HTTP shutdown driven by SIGTERM — the production server skeleton:

```go
func main() {
	ctx, stop := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	srv := &http.Server{Addr: ":8080", Handler: mux}
	go func() {
		if err := srv.ListenAndServe(); err != nil &&
			err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}()

	<-ctx.Done() // SIGTERM received
	shutCtx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutCtx); err != nil { // drain in-flight requests
		log.Printf("forced shutdown: %v", err)
	}
}
```

---

## 11. Advanced Concepts

- **`context.AfterFunc` (Go 1.21).** Registers a function to run in its own goroutine when a context is cancelled — cleaner than spawning a `go func() { <-ctx.Done(); cleanup() }()`. Returns a `stop` func to deregister.
- **`context.WithoutCancel` (Go 1.21).** Derives a child that keeps values but is *immune* to the parent's cancellation — for fire-and-forget cleanup (e.g. writing an audit log *after* the request context dies). Use sparingly; it's a leak risk if abused.
- **`WithCancelCause` / `context.Cause`.** Distinguish *why* you cancelled. Invaluable when a fan-out has several failure modes and you want the original error, not generic `context.Canceled`, in your logs.
- **Decoupling cancellation from values.** Sometimes you want a long-lived background task to outlive the request that triggered it but still inherit trace IDs — combine `WithoutCancel` with a fresh `WithTimeout`.
- **`errgroup` + `SetLimit` as a semaphore.** A bounded errgroup is the idiomatic replacement for a hand-rolled `chan struct{}` semaphore plus `WaitGroup` plus error channel.

> [!NOTE]
> Cancellation does not unwind syscalls. `context` cancels at Go-level checkpoints. To interrupt a blocked socket read you still need `SetReadDeadline`; to interrupt a CGo call, you generally can't — design those paths to be short or run them where you can abandon the result.

---

## 12. Debugging Tips

- **Detect leaks with `goleak`.** `defer goleak.VerifyNone(t)` (from `go.uber.org/goleak`) in tests fails if any goroutine outlives the test — the fastest way to catch a missing `ctx.Done()` case.
- **Read goroutine dumps.** `SIGQUIT` (or `pprof.Lookup("goroutine").WriteTo(w, 2)`) prints every goroutine's stack. A leak shows up as many goroutines parked on the same `chan send`/`chan receive` line — that line is your missing cancellation point.
- **`GODEBUG` and the runtime.** `runtime.NumGoroutine()` trending upward under steady load = leak. Graph it.
- **`go vet`** catches lost cancel funcs (`the cancel function is not used on all paths`).
- **`-race`** won't find leaks but will find the data race where two goroutines write `results[i]` (use distinct indices, as in the example).
- **Reproduce early-return leaks** by writing a test that reads one value from a pipeline and returns, then `goleak`-verifies — exactly the Go blog scenario.

---

## 13. Senior Engineer Notes

A senior engineer treats cancellation as a *non-negotiable code-review gate*, not a nice-to-have:

- **In reviews**, every `go func()` triggers the question "what stops this?" If the answer isn't a `ctx.Done()`/`done` case or a bounded loop, it's a leak — block the PR.
- **Every blocking channel op** must have a cancellation escape. "It works in the happy path" is the tell of a future incident.
- **Mentor the ownership rule**: one goroutine owns the cancel/close; everyone else only reads. Most cancellation bugs are ownership confusion.
- **Prefer `errgroup.WithContext` over hand-rolled** done channels + error channels + WaitGroups in app code — it's fewer moving parts and harder to get wrong. Reserve raw `done` channels for library-internal pipelines where you don't want the x/sync dependency.
- **Design timeouts at the edge** and let them flow; junior code tends to sprinkle ad-hoc `time.After` timeouts that don't compose with the caller's deadline.
- **Always pair shutdown cancel with a bounded `Wait`** — an unbounded drain is just a hang with extra steps.

---

## 14. Staff Engineer Notes

A staff engineer thinks about cancellation as an **organization-wide contract**:

- **Deadline propagation as an SLO mechanism.** Across a microservice graph, deadlines must propagate (gRPC does this natively) so a 200ms front-end budget isn't blown by a backend that ignores it. Mandate context-aware clients org-wide; a service that drops the inbound deadline is a latency-amplification bomb. This is a platform-level standard, not a per-team choice.
- **Build vs. buy.** `errgroup`, `context`, and `signal.NotifyContext` cover ~95% of needs — resist the urge to build a bespoke cancellation framework. The remaining 5% (e.g. cancellation across a message-queue boundary where there's no shared process) genuinely needs design: idempotent consumers, cancellation tokens carried in message metadata, or compensating actions.
- **Graceful shutdown as a fleet contract.** Standardize the SIGTERM -> cancel root -> drain-with-deadline pattern in a shared service skeleton, and align the drain deadline with the orchestrator's `terminationGracePeriodSeconds`. A drain longer than the grace period gets `SIGKILL`ed mid-flight — a cross-cutting reliability bug that no single team owns.
- **Cancellation, distributed.** A `context` cancel stops *local* goroutines only. Cancelling work already dispatched to Kafka/SQS/another service requires explicit protocol design. Make this boundary visible in architecture reviews; teams routinely assume cancellation is transitive across the network when it is not.
- **Observability of cancellation.** Push for metrics distinguishing `DeadlineExceeded` from client-`Canceled` from internal-error cancels. Conflating them hides whether you have a latency problem, a flaky-client problem, or a bug.

---

## 15. Revision Summary

- A goroutine can only be stopped **cooperatively** — it must observe a signal and return.
- **`close(done)` is the broadcast primitive**: unblocks all current/future receivers; only the owner closes; send-on-closed panics.
- **`context` is a tree** of `cancelCtx`/`timerCtx`; cancel closes `done` and recurses into children; done channel is lazily allocated.
- **Always `defer cancel()`**, even on timeouts; pass `ctx` as first arg; don't store in structs.
- Every blocking `select` needs a `case <-ctx.Done(): return`.
- **`errgroup.WithContext`** = error aggregation + sibling cancellation; `SetLimit(n)` bounds concurrency.
- **Graceful shutdown**: `signal.NotifyContext` -> cancel root -> `srv.Shutdown(ctx)` with a bounded deadline aligned to k8s grace period.
- Advanced: `AfterFunc`, `WithoutCancel`, `WithCancelCause`/`Cause`.
- Cancellation is **local**; crossing a network/queue boundary needs explicit protocol design.
- Debug leaks with `goleak`, goroutine dumps, `go vet`, and `runtime.NumGoroutine()`.

**References:** Go blog — "Go Concurrency Patterns: Pipelines and cancellation"; `context`, `golang.org/x/sync/errgroup`, and `net/http.Server.Shutdown` package documentation; `go.uber.org/goleak`.

---

*Go Engineering Handbook — topic 43.*
