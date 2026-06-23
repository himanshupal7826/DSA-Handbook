# 42 · Context Package

> **In one line:** The `context` package propagates cancellation, deadlines, and request-scoped values across API boundaries and goroutine trees so work can be stopped cleanly and on time.

---

## 1. Overview

The `context` package solves one of the hardest problems in concurrent server code: *when do I stop?* A single inbound HTTP request can fan out into dozens of goroutines — database queries, RPCs to other services, cache lookups. When the client disconnects, the deadline passes, or any one branch fails, you want every downstream goroutine to abandon its work and release its resources. `context.Context` is the standard plumbing for broadcasting that "stop now" signal and for carrying a small amount of request-scoped metadata (trace IDs, auth tokens) along the same path.

A `Context` is an immutable value. You never mutate one; you *derive* a new context from a parent with `WithCancel`, `WithTimeout`, `WithDeadline`, or `WithValue`. This builds a **tree** rooted at `context.Background()`. Cancelling a node cancels its entire subtree. The convention — enforced by `go vet`, the linters, and every reviewer worth their salt — is that `Context` is the **first parameter** of any function that does blocking or cancellable work, named `ctx`.

> [!NOTE]
> Context does not *force* anything to stop. It is a cooperative signal. A goroutine that never checks `ctx.Done()` or never passes `ctx` to the blocking call it makes will happily ignore cancellation. Context is a contract, not a kill switch.

## 2. Why It Exists

Before `context` (introduced experimentally as `golang.org/x/net/context`, promoted to the standard library in Go 1.7, 2016), every team rolled its own cancellation channel and passed it through call chains by hand. This produced incompatible conventions: some used `chan struct{}`, some used a `*Request` with a `Cancel` field, some used a `time.Timer` plus a mutex. Libraries could not interoperate, so a timeout in your HTTP handler could not propagate into the database driver written by someone else.

The package standardizes three intertwined concerns that always travel together along a request path:

- **Cancellation** — explicit "I no longer need this result" (caller gave up, error elsewhere).
- **Deadlines / timeouts** — implicit cancellation at a wall-clock time, so a slow dependency can't pin a goroutine forever.
- **Request-scoped values** — data that belongs to *this* request and must flow with it but doesn't belong in the function signature (trace span, user identity, locale).

By giving these a single interface, the standard library (`net/http`, `database/sql`, `os/exec`) and the entire ecosystem (gRPC, Kafka clients, AWS SDK) can all honor the same cancellation signal end to end. That interoperability is the whole point.

## 3. Internal Working

`Context` is a four-method interface:

```go
type Context interface {
	Deadline() (deadline time.Time, ok bool)
	Done() <-chan struct{}
	Err() error
	Value(key any) any
}
```

The concrete types live in `context.go`. The base values `Background()` and `TODO()` are both `*emptyCtx` (since Go 1.21, distinct `backgroundCtx`/`todoCtx` wrappers for nicer `String()` output) — they never cancel, have no deadline, and hold no values. Everything else is a wrapper that holds a pointer to its parent, forming a linked tree.

The workhorse is `cancelCtx`:

```text
                context.Background()  (*emptyCtx — never done)
                          │
                          ▼
            ┌──────────── cancelCtx ──────────────┐
            │ mu       sync.Mutex                  │
            │ done     atomic.Value(chan struct{}) │  lazily created on first Done()
            │ children map[canceler]struct{}       │  set of cancelable descendants
            │ err      error                       │  Canceled / DeadlineExceeded
            │ cause    error  (Go 1.20+)           │
            └─────────────────┬────────────────────┘
                              │ propagateCancel registers child in parent.children
                ┌─────────────┴─────────────┐
                ▼                            ▼
            cancelCtx                  timerCtx (embeds cancelCtx + *time.Timer)
```

Key runtime behaviors:

- **Lazy `Done` channel.** The `done` channel is created the first time `Done()` is called, stored in an `atomic.Value`. If nobody ever selects on `Done()`, no channel is allocated.
- **`cancel()` is closing the channel.** Cancellation is implemented by `close(done)`. A closed channel makes every `<-ctx.Done()` return immediately — that's how the signal fans out to N goroutines with one operation. The mutex guards the one-time transition; `err` is set before the close so a goroutine that wakes up sees a non-nil `Err()`.
- **`propagateCancel` registers the link.** When you derive a cancelable child, the runtime walks up to find the nearest cancelable ancestor and adds the child to its `children` map. If the parent is already done, the child cancels immediately. If the parent is not a standard `cancelCtx` (a custom implementation), the runtime spawns a **goroutine** that selects on `parent.Done()` — the one place context can cost you a goroutine.
- **Cancellation propagates *down*, removal propagates *up*.** Cancelling a node closes its channel, then iterates `children` calling each child's `cancel`. Calling a child's own `cancel` removes it from the parent's `children` map (so a finished request doesn't leak entries in a long-lived parent).
- **`timerCtx`** embeds a `cancelCtx` and adds a `*time.Timer` armed via `time.AfterFunc(d, func(){ c.cancel(DeadlineExceeded) })`. Calling its `cancel` stops the timer.
- **`valueCtx`** holds a single `key, val any` plus the parent pointer. `Value(k)` does a **linear walk up the parent chain** comparing keys — O(depth). There is no map; each `WithValue` adds exactly one node.

## 4. Syntax

```go
// Roots — pick one.
ctx := context.Background() // top of main, init, tests
ctx := context.TODO()       // placeholder: "context belongs here, TBD"

// Derive cancellation.
ctx, cancel := context.WithCancel(parent)
defer cancel() // ALWAYS — releases resources even if not cancelled

// Derive a deadline / timeout.
ctx, cancel := context.WithTimeout(parent, 2*time.Second)
defer cancel()
ctx, cancel := context.WithDeadline(parent, time.Now().Add(5*time.Second))
defer cancel()

// Carry a value (use a private key type — see below).
ctx = context.WithValue(parent, traceKey, "abc-123")

// Consume.
select {
case <-ctx.Done():
	return ctx.Err() // context.Canceled or context.DeadlineExceeded
case res := <-work:
	use(res)
}

// Go 1.20+ extras.
ctx, cancel := context.WithCancelCause(parent)
cancel(fmt.Errorf("upstream 503"))   // attach a reason
err := context.Cause(ctx)            // retrieve it (richer than ctx.Err())

// Go 1.21+ extras.
ctx := context.WithoutCancel(parent) // keep values, detach cancellation
ctx, cancel := context.WithDeadlineCause(parent, t, errSLA)
context.AfterFunc(ctx, func(){ cleanup() }) // run fn when ctx is done
```

## 5. Common Interview Questions

**Q1. What are the three things a context carries, and why bundle them?**
Cancellation, deadlines/timeouts, and request-scoped values. They're bundled because they all flow along the same request path and must propagate together across API and goroutine boundaries.
*Follow-up: Is a deadline just cancellation?* Yes — internally `timerCtx` is a `cancelCtx` plus a timer that calls `cancel(DeadlineExceeded)`. The only externally visible difference is `Deadline()` returns `ok=true` and `Err()` is `DeadlineExceeded` rather than `Canceled`.

**Q2. Why must you call the `cancel` function even when the operation succeeds?**
`WithCancel`/`WithTimeout` register the child in the parent's `children` map and, for timers, arm a `time.Timer`. If you never call `cancel`, the child stays referenced by a long-lived parent and the timer lives until it fires — a memory/goroutine leak. `go vet` flags the missing `cancel`.
*Follow-up: Where do you put it?* `defer cancel()` immediately after creation. It is idempotent and safe to call multiple times.

**Q3. Why should context values use a private custom key type instead of a string?**
`Value` keys are compared by equality across packages sharing one context. A bare string like `"user"` from two packages would collide. The idiom is `type ctxKey int; const userKey ctxKey = 0` — an unexported type means no other package can produce a colliding key.
*Follow-up: Why not store the whole request struct as a value?* Because values are untyped (`any`), invisible in signatures, and O(depth) to read. They're for cross-cutting metadata (trace IDs), not for passing required parameters.

**Q4. A goroutine ignores `ctx` and runs forever after cancellation. Whose bug is it?**
The goroutine's. Context is cooperative; cancellation only works if every blocking call either accepts `ctx` or the loop checks `ctx.Done()`. The fix is to thread `ctx` into the blocking call (e.g. `db.QueryContext(ctx, ...)`) or `select` on `ctx.Done()` in the loop.
*Follow-up: Does cancelling stop CPU-bound work?* No. A tight `for` loop with no `Done()` check keeps running. You must poll `ctx.Err()` periodically.

**Q5. What's the difference between `context.Canceled` and `context.DeadlineExceeded`?**
`Canceled` means someone called the cancel func explicitly; `DeadlineExceeded` means the deadline passed. `DeadlineExceeded` implements `net.Error` with `Timeout() == true`. Servers often map the latter to HTTP 504 and the former to 499/client-closed.
*Follow-up: How do you know *why* it was cancelled in 1.20+?* `context.Cause(ctx)` returns the error passed to `cancel(err)` via `WithCancelCause`, giving a richer reason than `ctx.Err()`.

**Q6. How does cancellation reach 50 goroutines simultaneously?**
By closing a single channel. All 50 are blocked on `<-ctx.Done()`; `close(done)` unblocks them all at once — O(1) signal, no per-goroutine bookkeeping for the broadcast itself.
*Follow-up: Memory cost of the channel?* It's created lazily on first `Done()` and is a `chan struct{}` (zero-size element), so it's tiny; the cost is the channel header, not per-receiver.

**Q7. Can you re-add cancellation to a context after stripping it?**
Yes. `context.WithoutCancel(parent)` (Go 1.21) keeps the values but detaches the Done channel/deadline — useful for spawning a "fire-and-forget" cleanup that must outlive the request. You can then layer a fresh `WithTimeout` on top to bound that detached work.

## 6. Production Use Cases

- **HTTP servers.** `net/http` injects a per-request context (`r.Context()`) that is cancelled when the client disconnects or the server times out. Standard practice at virtually every Go shop (Uber, Cloudflare, Dropbox) is to thread `r.Context()` into every DB query and outbound call so a hung-up client frees the whole chain.
- **gRPC.** Cancellation and deadlines are first-class in the wire protocol. A deadline set on the client `ctx` is transmitted to the server, which sets its own context deadline — true cross-process propagation. Google's internal RPC stack pioneered this pattern.
- **`database/sql`.** `QueryContext`/`ExecContext` cancel in-flight queries; the driver sends a cancel/kill to Postgres or MySQL so the DB stops computing too.
- **Distributed tracing.** OpenTelemetry stores the active span in the context (`trace.ContextWithSpan`). The span flows through every function via the `ctx` parameter and across services via header propagation. This is the canonical "request-scoped value" use case.
- **Worker pools & pipelines.** `errgroup.WithContext` cancels all sibling tasks when the first one fails — Kubernetes, etcd, and CockroachDB lean on this to bound fan-out fan-in workloads.
- **Graceful shutdown.** `signal.NotifyContext(ctx, os.Interrupt)` (Go 1.16+) yields a context cancelled on SIGINT/SIGTERM, then `http.Server.Shutdown(ctx)` drains in-flight requests within a deadline.

## 7. Common Mistakes

> [!WARNING]
> The mistakes below account for the vast majority of context bugs in code review.

- **Forgetting `defer cancel()`** — leaks the timer/child registration. Always pair creation with deferred cancel.
- **Storing a context in a struct field.** The docs are explicit: *do not store Contexts inside a struct type; pass them explicitly.* A stored context outlives the request it was meant for and gets reused with the wrong deadline. (Narrow exceptions exist for long-lived "service" objects, but it's a smell.)
- **Passing `nil` context.** Pass `context.TODO()` if you genuinely have none yet; never `nil` — downstream code calling `ctx.Done()` will panic.
- **Using context values for required parameters.** If a function *needs* a value to work, it belongs in the signature. Hiding it in `ctx.Value` makes the API lie and the lookup is O(depth) and unchecked.
- **Bare string keys** — collide across packages. Use an unexported key type.
- **Deriving a child timeout longer than the parent's.** The child can never outlive the parent; the shorter deadline always wins. Writing `WithTimeout(ctx, 1*time.Hour)` under a 5s parent is a misunderstanding, not a feature.

## 8. Performance Considerations

Context is cheap but not free:

- **`WithValue`** allocates one small `valueCtx` per call and `Value()` is **O(chain depth)** linear scan. A request with 12 nested values means 12 comparisons per lookup. Keep chains shallow; bundle related values into a single struct stored once rather than calling `WithValue` a dozen times.
- **`WithCancel`/`WithTimeout`** allocate a `cancelCtx` (and a `time.Timer` for timeouts) plus a map entry in the parent. The `Done` channel is lazy — zero cost if unused.
- **The hidden goroutine.** If a parent is a *non-standard* `Context` implementation (not one the runtime recognizes), `propagateCancel` spawns a goroutine to watch `parent.Done()`. Using only standard derivations avoids this; it's a real cause of goroutine growth when people wrap context in custom types.
- **`time.Timer` pressure.** A service doing 100k req/s with `WithTimeout` per request creates 100k timers/s. The runtime's timer heap handles this well post-Go-1.14, but a missing `cancel()` leaves timers armed until they fire, bloating the heap and stealing CPU. Always cancel to `timer.Stop()` early.

> [!TIP]
> Benchmark with `-benchmem`. If `ctx.Value` shows up in a CPU profile, you have too deep a chain or a hot path doing lookups in a loop — hoist the lookup out of the loop.

## 9. Best Practices

- Make `ctx context.Context` the **first parameter**, named `ctx`. Never put it in a struct.
- `defer cancel()` the instant you derive a cancelable context.
- Derive timeouts at the **boundary you own** (the RPC call, the DB query), not deep in business logic.
- Use a private key type for values; expose typed `WithUser(ctx, u)` / `UserFrom(ctx)` helpers so callers never touch raw keys.
- Restrict values to true request-scope metadata: trace/correlation IDs, auth principal, locale — never config, never optional knobs.
- Check `ctx.Err()` in long CPU loops; thread `ctx` into every blocking I/O call.
- On the server, honor inbound deadlines and propagate them outward; on the client, set a deadline so a hung dependency can't pin you.
- Prefer `errgroup.WithContext` over hand-rolled cancel channels for fan-out.

## 10. Code Examples

Primary: an HTTP handler that sets a per-call timeout and fans out to two backends, cancelling both if either fails or the deadline passes.

```go
package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"time"

	"golang.org/x/sync/errgroup"
)

type ctxKey int

const reqIDKey ctxKey = iota

func WithReqID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, reqIDKey, id)
}
func ReqID(ctx context.Context) string {
	id, _ := ctx.Value(reqIDKey).(string)
	return id
}

func handler(w http.ResponseWriter, r *http.Request) {
	// Inherit the request context (cancelled on client disconnect),
	// then bound this handler's total work to 800ms.
	ctx, cancel := context.WithTimeout(r.Context(), 800*time.Millisecond)
	defer cancel()
	ctx = WithReqID(ctx, "req-42")

	g, gctx := errgroup.WithContext(ctx)
	var user, orders string

	g.Go(func() error {
		var err error
		user, err = fetch(gctx, "user-svc", 300*time.Millisecond)
		return err
	})
	g.Go(func() error {
		var err error
		orders, err = fetch(gctx, "order-svc", 1200*time.Millisecond) // too slow
		return err
	})

	if err := g.Wait(); err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			http.Error(w, "upstream timeout", http.StatusGatewayTimeout)
			return
		}
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	fmt.Fprintf(w, "[%s] %s / %s", ReqID(ctx), user, orders)
}

func fetch(ctx context.Context, name string, latency time.Duration) (string, error) {
	select {
	case <-time.After(latency):
		return name + "-ok", nil
	case <-ctx.Done():
		return "", fmt.Errorf("%s: %w", name, ctx.Err())
	}
}
```

Alternative: a cancellable worker loop that respects both cancellation and a CPU-bound checkpoint, using `context.AfterFunc` (Go 1.21+) for cleanup.

```go
package main

import (
	"context"
	"log"
	"time"
)

func worker(ctx context.Context, jobs <-chan int) {
	stop := context.AfterFunc(ctx, func() {
		log.Println("ctx done, flushing buffers")
	})
	defer stop()

	for {
		select {
		case <-ctx.Done():
			log.Printf("worker exiting: %v (cause: %v)",
				ctx.Err(), context.Cause(ctx))
			return
		case j, ok := <-jobs:
			if !ok {
				return
			}
			// Long CPU work: poll cancellation between chunks.
			for chunk := 0; chunk < 10; chunk++ {
				if ctx.Err() != nil {
					return
				}
				compute(j, chunk)
			}
		}
	}
}

func compute(job, chunk int) { time.Sleep(time.Millisecond) }
```

## 11. Advanced Concepts

- **`WithCancelCause` / `context.Cause`** (Go 1.20). `cancel(err)` records *why*. `ctx.Err()` still returns the generic `Canceled`, but `context.Cause(ctx)` returns your specific error — invaluable for debugging which of many cancel sites fired.
- **`context.WithoutCancel`** (Go 1.21). Returns a child that inherits values but is **never** cancelled by the parent. Use it to launch best-effort cleanup, audit logging, or metric flushes that must complete even though the request was cancelled.
- **`context.AfterFunc`** (Go 1.21). Registers a callback to run in its own goroutine when `ctx` is done; returns a `stop` func to deregister. A clean alternative to spawning a `go func(){ <-ctx.Done(); ... }()` watcher.
- **`WithDeadlineCause` / `WithTimeoutCause`** (Go 1.21). Attach a custom cause that surfaces via `Cause` when *the deadline* trips — e.g. distinguishing an SLA breach from a generic timeout.
- **Deadline arithmetic.** Servers should read the inbound deadline (`d, ok := ctx.Deadline()`), subtract a budget for their own work and the response, and set a *shorter* deadline on outbound calls. This "deadline budgeting" prevents a downstream call from consuming time you needed to send a graceful error.
- **`signal.NotifyContext`** ties OS signals to context for graceful shutdown without manual signal channels.

## 12. Debugging Tips

- **Goroutine leak hunt.** `go test -run X -count=1` with `go.uber.org/goleak` at the end of a test catches goroutines that didn't exit on cancel. A growing `runtime.NumGoroutine()` in prod usually means a missing `cancel()` or a loop ignoring `Done()`.
- **`pprof` goroutine dump.** `curl localhost:6060/debug/pprof/goroutine?debug=2` — leaked context watchers show stacks parked in the goroutine spawned by `propagateCancel` or blocked on `<-ctx.Done()`.
- **Find missing cancels statically.** `go vet` reports "the cancel function is not used on all paths." Run it in CI; treat it as an error.
- **Distinguish timeout vs cancel** at the boundary: log `errors.Is(err, context.DeadlineExceeded)` vs `context.Canceled`, and in 1.20+ log `context.Cause(ctx)` to pin the exact origin.
- **"Why did this return early?"** Add the request ID (from context) to every log line; correlate the cancellation timestamp with the deadline you set to confirm it was a timeout, not an upstream cancel.

## 13. Senior Engineer Notes

A senior engineer's job with context is mostly **judgement at the boundaries and discipline in review**. Decide *where* timeouts live: business logic should accept a `ctx` and never invent its own deadline — the caller owns the budget. Push timeout creation to the I/O edge so it's testable and visible. In code review, three things are non-negotiable: `ctx` is the first param, `defer cancel()` exists on every derivation, and no context is stashed in a struct. When you see `ctx.Value` used for a required argument, push back — it's a hidden dependency that breaks compile-time safety and slows lookups.

Mentor juniors on the *cooperative* nature of cancellation: the most common production incident is "we set a timeout but the goroutine ran for 30 seconds anyway" because nobody threaded `ctx` into the blocking call. Teach them to ask "what does this goroutine do when `ctx` is cancelled mid-flight?" for every `go` statement. Establish a house pattern for value keys (private type + typed getter/setter) so the codebase has one way to do it, and codify the deadline-budgeting convention so outbound calls always get *less* time than the inbound deadline.

## 14. Staff Engineer Notes

At staff level the concern shifts from a single service to **deadline propagation as an org-wide contract**. The architectural win is end-to-end: a client deadline that flows through the API gateway, into service A, across gRPC to service B, into B's database query — every hop honoring and shrinking the remaining budget. Getting this right requires platform-level decisions: standardize on gRPC/OpenTelemetry so context propagation is automatic, mandate that every internal RPC client refuses calls with no deadline, and bake deadline budgeting into the shared client library so individual teams can't forget it. This is a classic **build-vs-buy**: the budgeting/propagation logic should be *bought* once as a shared middleware/interceptor, not re-implemented per team.

Cross-team, the failure mode you must design against is the **retry storm + missing deadline** combination: a service with no inbound deadline retries a slow dependency, amplifying load during a brownout. Staff engineers set the policy — every entry point caps total request time, every retry respects the *remaining* context budget, and graceful shutdown drains within a known SLA via `signal.NotifyContext`. Quantify the trade-offs: aggressive deadlines free resources fast but increase tail-latency failures under load; generous deadlines protect success rate but risk goroutine pileups. The right number comes from your latency histograms (p99/p99.9), not from a round figure someone liked. Finally, treat context-value sprawl as tech debt: each new value added to the request context is a cross-cutting dependency every service must understand — gate additions through architecture review.

## 15. Revision Summary

- `Context` = cancellation + deadline + request-scoped values, propagated down a tree rooted at `Background()`.
- Four methods: `Deadline`, `Done`, `Err`, `Value`. Immutable; derive children, never mutate.
- Cancellation = `close(done)` (broadcast to all receivers); deadline = `cancelCtx` + `time.Timer`.
- Always `defer cancel()`; never store context in a struct; never pass `nil` (use `TODO()`).
- Values: private key type, typed helpers, metadata only — `Value` is O(depth).
- Cooperative: thread `ctx` into blocking calls and poll `ctx.Err()` in CPU loops, or cancellation does nothing.
- `errgroup.WithContext` for fan-out; `signal.NotifyContext` for shutdown.
- Modern extras: `WithCancelCause`/`Cause` (1.20), `WithoutCancel`/`AfterFunc`/`WithTimeoutCause` (1.21).
- Senior: enforce conventions, push timeouts to boundaries, teach cooperative cancellation. Staff: org-wide deadline budgeting/propagation, shared interceptors, retry+timeout policy.

**References:** Go blog — "Go Concurrency Patterns: Context" (go.dev/blog/context); `context` package docs (pkg.go.dev/context); Go 1.20/1.21 release notes; `golang.org/x/sync/errgroup`.

---

*Go Engineering Handbook — topic 42.*
