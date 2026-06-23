# 34 · Select Statement

> **In one line:** `select` lets a goroutine wait on multiple channel operations at once, choosing one ready case (pseudo-randomly), falling through to `default`, or blocking until something happens.

---

## 1. Overview

The `select` statement is the control-flow primitive that turns Go's channels from point-to-point pipes into a full concurrency toolkit. A bare channel receive (`<-ch`) blocks on exactly one channel. `select` lets a single goroutine *multiplex*: it waits on a set of send/receive operations and proceeds with whichever one becomes ready first.

Conceptually `select` is to channels what `switch` is to values — but the branches are *communication operations*, not comparisons, and the choice is driven by runtime readiness rather than by evaluating the cases top-to-bottom.

Three behaviours make `select` indispensable in production code:

1. **Multiplexing** — fan-in from many channels, react to whichever fires.
2. **`default` (non-blocking)** — try an op, but never park if it isn't ready.
3. **Timeouts & cancellation** — combine a work channel with `time.After` or a `done`/`ctx.Done()` channel so no goroutine waits forever.

If you only learn one concurrency construct beyond the goroutine and the channel, learn this one. Almost every robust Go server loop is built around a `for { select { ... } }`.

---

## 2. Why It Exists

Without `select`, coordinating multiple channels forces ugly, racy workarounds. Imagine a worker that must consume jobs *and* respond to a shutdown signal. With only blocking receives you'd have to pick an order:

```go
job := <-jobs      // blocks here forever; shutdown signal ignored
<-shutdown
```

You cannot wait on "either of these, whichever comes first" with sequential receives. You could spin up a goroutine per channel, but then you'd need *another* channel to merge results — and you'd have re-invented `select` badly, with extra goroutines and lifecycle bugs.

Go's designers took the idea from Hoare's **CSP** (Communicating Sequential Processes) and Newsqueak/Alef (Rob Pike's earlier languages), where a guarded-command `select`/`alt` is a first-class construct. The motivation: concurrency composes only if you can express *choice* over communication events atomically. `select` gives you that choice with a single runtime-arbitrated decision, no locks, no busy-waiting, no goroutine sprawl.

The `default` clause exists so you can *probe* a channel without committing to block — essential for backpressure ("drop the metric if the buffer is full") and for polling loops.

---

## 3. Internal Working

A `select` is compiled into a call to the runtime function `runtime.selectgo` (in `src/runtime/select.go`). The compiler lowers each case into a `scase` struct and builds two arrays describing the operation.

```text
scase {                 selectgo(cas0, order0, ...) flow:
  c    *hchan   <- chan   ┌──────────────────────────────────────┐
  elem unsafe.Pointer     │ 1. lock all involved hchans          │
}                         │    (in canonical address order to    │
                          │     avoid deadlock)                  │
pollorder []uint16  ──────┤ 2. PASS 1: scan cases in pollorder;  │
  (random permutation)    │    is any channel ready NOW?         │
lockorder []uint16  ──────┤    -> yes: execute, unlock, return   │
  (sorted by hchan addr)  │ 3. no ready case + has default?      │
                          │    -> run default, unlock, return    │
hchan {                   │ 4. no default: enqueue this goroutine │
  recvq waitq  <───────┐  │    (a *sudog) onto recvq/sendq of    │
  sendq waitq          │  │    EVERY case's channel, then park   │
  lock  mutex          │  │ 5. woken by a peer op -> dequeue from │
}                      └──┤    all other channels, run that case │
                          └──────────────────────────────────────┘
```

Key implementation facts:

- **`pollorder`** is a *random permutation* of the case indices, generated with `cheaprandn`. This is the source of `select`'s pseudo-random choice when multiple cases are simultaneously ready — it prevents starvation, so a hot channel listed first can't monopolise the loop.
- **`lockorder`** sorts channels by address so `selectgo` can lock them in a consistent global order, guaranteeing no lock-ordering deadlock between concurrent selects.
- When nothing is ready and there's no `default`, the goroutine allocates one **`sudog`** per case and enqueues itself on *all* the channels' wait queues, then calls `gopark`. A peer that sends/receives on any of those channels wakes exactly this goroutine; `selectgo` then walks the other cases and **dequeues** its stale `sudog`s so it isn't double-woken.
- A `select` with **no cases** — `select {}` — blocks forever (the compiler emits `block()`); a common idiom to park `main` deliberately.
- A `select` with a single case is optimised by the compiler into a plain channel op; the runtime arbitration machinery is skipped.

So cost scales with the number of cases (lock/enqueue per channel), not magically free — but for the common 2-4 case loop it's a handful of pointer ops and one `gopark`.

---

## 4. Syntax

```go
select {
case v := <-ch1:          // receive, bind value
    use(v)
case v, ok := <-ch2:      // receive with closed-detection
    if !ok { /* ch2 closed */ }
case ch3 <- x:            // send
    // sent successfully
case <-ctx.Done():        // cancellation
    return ctx.Err()
default:                  // optional; makes select non-blocking
    // nothing ready right now
}
```

Rules worth internalising:

- Each case must be a **single** channel send or receive (or `default`).
- A `nil` channel case **never** becomes ready — disabling a case by setting its channel to `nil` is a deliberate, powerful idiom (see §11).
- Case expressions (channel operand, and the value to send) are **all evaluated once, top-to-bottom, before** selection happens — even for cases that aren't chosen. Side effects in those expressions run regardless.
- At most one `default`.

---

## 5. Common Interview Questions

**Q1. If two cases are ready at the same time, which runs?**
One is chosen *uniformly at random* via `pollorder`. Do not rely on case order for priority.
*Follow-up: How would you implement priority?* Nest selects: first a `select` with only the high-priority case + `default`; if `default` hits, fall into a second `select` covering all cases.

**Q2. What does `select {}` (empty) do?**
Blocks the goroutine forever without consuming CPU. Used to keep `main` alive when work runs in other goroutines (or to deliberately deadlock a test). With a `default` and no other cases, it would instead fall through immediately.

**Q3. What happens if all channels in a `select` are `nil` and there's no default?**
Permanent block (same as `select {}`), because nil channels are never ready. Setting a channel to `nil` is how you *remove* a case dynamically.
*Follow-up: nil channel send vs receive?* Both block forever; neither panics (unlike sending on a closed channel).

**Q4. How do you implement a timeout?**
Add `case <-time.After(d): return ErrTimeout`. `time.After` returns a channel that fires after `d`.
*Follow-up: what's the leak risk?* In a *loop*, `time.After` allocates a new timer each iteration that lives until it fires; use `time.NewTimer` + `Reset`/`Stop`, or pass a `context.WithTimeout` whose `Done()` you reuse.

**Q5. Difference between `select` with `default` and without?**
Without `default`: blocks until a case is ready. With `default`: never blocks — if no case is ready *right now*, `default` runs immediately. This is the non-blocking send/receive idiom.

**Q6. Can you `select` on a closed channel?**
Yes, and it's always *ready*: a receive returns the zero value with `ok == false` immediately. A closed channel in a `select` will be picked constantly — a classic busy-loop bug. Fix by nil-ing the channel once you observe close.

**Q7. Does `select` evaluate the RHS of a send case if that case isn't chosen?**
Yes. All case operands (channel + send value) are evaluated exactly once, before arbitration. So `case ch <- expensive():` calls `expensive()` even if another case wins.

**Q8. How does `select` avoid deadlock when locking multiple channels?**
`selectgo` sorts channels by address (`lockorder`) and locks them in that canonical order, so two concurrent selects on the same set never acquire locks in opposing orders.

---

## 6. Production Use Cases

- **Server worker loops** — the canonical `for { select { case job := <-jobs: ...; case <-ctx.Done(): return } }`. Used everywhere from `net/http`-derived servers to gRPC interceptors.
- **Cancellation propagation** — every well-behaved Go library function that takes a `context.Context` ends up selecting on `ctx.Done()`. Kubernetes' `client-go`, etcd, and CockroachDB are saturated with this pattern.
- **Timeouts** — HTTP clients, database drivers (`database/sql` query cancellation), and RPC frameworks combine the work channel with a deadline channel.
- **Fan-in** — merging events from N producers into one consumer (log aggregators, the `errgroup`-style merge, Prometheus scrape result collection).
- **Backpressure / lossy buffering** — non-blocking send with `default` to *drop* metrics or traces under load. The OpenTelemetry Go SDK and Uber's `zap`/sampling paths use exactly this to avoid blocking hot paths.
- **Rate limiting** — `golang.org/x/time/rate` and ticker-driven loops `select` on a `time.Ticker` channel.
- **Graceful shutdown** — `signal.Notify` delivers OS signals on a channel; the main loop selects on it to drain and exit cleanly.

---

## 7. Common Mistakes

> [!WARNING]
> **`time.After` in a tight loop leaks timers.** Each call creates a `*Timer` retained until it fires. At high loop frequency this is a real heap/timer-heap pressure source. Use a single `time.NewTimer` and `Reset` it, or use `context`.

- **Treating case order as priority.** It's random. Order conveys nothing.
- **Forgetting `default` makes it non-blocking** — a `select` with `default` inside a tight `for` loop becomes a 100%-CPU spin if no case is ready. Add a sleep/ticker or remove `default`.
- **Busy-looping on a closed channel.** Once closed, a receive case is *always* ready. Set the channel variable to `nil` after detecting close to disable that case.
- **Sending on a closed channel inside select** — still panics. `select` does not make sends safe.
- **Evaluating side-effecting expressions in unchosen cases** (see Q7) — surprising bugs when `case ch <- compute():` runs `compute()` every iteration.
- **`default` swallowing readiness on first pass** — a non-blocking receive that you call too rarely can miss the window; pair with buffering or blocking selects appropriately.

---

## 8. Performance Considerations

- A **single-case** `select` is compiler-optimised to a direct channel op — zero overhead vs `<-ch`.
- A **two-case** `select` (the dominant real case) is cheap: a couple of `scase` slots, lock/unlock of the involved channels, and at most one `gopark`/`goready`.
- Cost grows roughly **linearly with the number of cases** because `selectgo` may enqueue a `sudog` on every channel and later dequeue them. Selects with 8+ cases in hot loops are worth profiling.
- The **`pollorder` shuffle** is O(n) with a cheap PRNG; negligible for small n.
- **Non-blocking selects (`default`)** never park, so they're the cheapest — but a `default`-spin without a backoff burns a core. Always gate spins with a ticker or `runtime.Gosched()`/sleep.
- **`time.After` allocation** is the most common hidden cost in `select` loops; switching to a reused `Timer` removes per-iteration allocation and timer-heap churn.

> [!TIP]
> Benchmark with `go test -bench` and `-benchmem`. A `select`-heavy hot loop that shows steady allocations usually points to `time.After` or per-iteration channel/context creation.

---

## 9. Best Practices

- Structure long-lived goroutines as `for { select { ... } }` with **`ctx.Done()` always present** so they're cancellable.
- Prefer **`context.Context`** over hand-rolled `done` channels for cancellation; reserve `done chan struct{}` for simple, local lifetimes.
- Use **`time.NewTimer` + `Stop`/`Reset`** instead of `time.After` inside loops.
- Use the **nil-channel trick** to dynamically enable/disable cases rather than restructuring code.
- For **non-blocking sends**, always have an explicit policy (drop, count, log) in the `default`.
- Keep case bodies **small**; offload heavy work so the loop stays responsive to cancellation/timeouts.
- Drain channels on shutdown deterministically; don't rely on `select` randomness for ordering guarantees.

---

## 10. Code Examples

**Primary — a cancellable, timed worker loop with backpressure:** the idiomatic shape you'll write hundreds of times.

```go
func worker(ctx context.Context, jobs <-chan Job, results chan<- Result) error {
    idle := time.NewTimer(30 * time.Second)
    defer idle.Stop()

    for {
        idle.Reset(30 * time.Second)
        select {
        case <-ctx.Done():
            return ctx.Err() // cancellation wins
        case j, ok := <-jobs:
            if !ok {
                return nil // jobs closed: clean exit
            }
            r := process(j)
            select {
            case results <- r: // try to deliver
            default:
                metrics.Dropped.Inc() // backpressure: never block
            }
        case <-idle.C:
            return fmt.Errorf("worker idle timeout")
        }
    }
}
```

The two alternative approaches below show the **fan-in merge** vs a **priority select**; they're switchable tabs.

```go
// Fan-in: multiplex N input channels into one output.
func merge[T any](ctx context.Context, ins ...<-chan T) <-chan T {
    out := make(chan T)
    var wg sync.WaitGroup
    for _, in := range ins {
        wg.Add(1)
        go func(in <-chan T) {
            defer wg.Done()
            for {
                select {
                case <-ctx.Done():
                    return
                case v, ok := <-in:
                    if !ok {
                        return
                    }
                    select {
                    case out <- v:
                    case <-ctx.Done():
                        return
                    }
                }
            }
        }(in)
    }
    go func() { wg.Wait(); close(out) }()
    return out
}
```

```go
// Priority select: always prefer hi over lo when both are ready.
func priority(hi, lo <-chan int, done <-chan struct{}) {
    for {
        select { // drain high-priority first
        case v := <-hi:
            handle(v)
            continue
        default:
        }
        select { // then fall back to either
        case v := <-hi:
            handle(v)
        case v := <-lo:
            handle(v)
        case <-done:
            return
        }
    }
}
```

---

## 11. Advanced Concepts

**The nil-channel switch.** Because a `nil` channel is never ready, you can toggle a case on/off by assigning `nil`. This replaces flags and branches with declarative readiness:

```go
func stream(in <-chan int, out chan<- int) {
    var pending int
    var outCh chan<- int // nil => "send" case disabled
    for in != nil || outCh != nil {
        select {
        case v, ok := <-in:
            if !ok {
                in = nil // stop receiving once closed
                continue
            }
            pending, outCh = v, out // enable send
        case outCh <- pending:
            outCh = nil // sent; disable send until next value
        }
    }
}
```

This is the standard way to write a one-element buffering stage without a separate state machine — when there's no value to send, `outCh` is `nil` and that case simply can't fire.

**Reflection-based dynamic select.** When the number of cases is unknown at compile time, use `reflect.Select` with a `[]reflect.SelectCase`. It's far slower (reflection + allocation) but enables building a `select` over a runtime-sized slice of channels — used in some plugin/event-bus frameworks.

**`select` + `context` chaining.** `context.WithTimeout`/`WithCancel` give you a single reusable `Done()` channel that composes across call stacks, avoiding the per-iteration `time.After` cost while propagating cancellation transitively.

---

## 12. Debugging Tips

- **100% CPU on a goroutine** → almost always a `select` with `default` spinning, or a closed channel always-ready in a loop. Inspect with `go tool pprof` (CPU profile) — the hot frame will be `selectgo`.
- **Goroutine leak** → a `select` blocked forever because no case can fire (all channels nil/never-written, no `ctx.Done()`). Capture `runtime.Stack`/`/debug/pprof/goroutine?debug=2`; leaked goroutines park in `selectgo` with a clear stack.
- **`fatal error: all goroutines are asleep - deadlock!`** → every goroutine parked in `selectgo`/chan op with nothing to wake them.
- **Race on a value sent in a case** → remember unchosen send-case expressions still evaluate; run `-race`.
- Use **`GODEBUG=schedtrace=1000`** to watch scheduler behaviour, and `dlv` to step: breakpoints on the case bodies confirm which branch the runtime actually selected.

> [!NOTE]
> A goroutine dump shows a blocked select as `select (no cases)` for `select {}`, or `chan receive`/`chan send` frames under `runtime.selectgo` — a quick visual tell for *why* it's stuck.

---

## 13. Senior Engineer Notes

As a senior engineer your `select` judgement shows up in code review and design of components:

- **Insist every long-lived `select` loop has a cancellation case.** A loop without `ctx.Done()` or a `done` channel is an un-reviewable goroutine leak. This is a hard review gate.
- **Reject `time.After` in loops** and teach the `Timer.Reset` pattern; quantify the leak (one timer per iteration × loop frequency) so the lesson sticks.
- **Push back on `default`-spins** without backoff — ask "what wakes this, and how often?" Most "non-blocking" loops should actually block.
- **Mentor on the random-order pitfall.** New engineers routinely encode priority by case order; show them the nested-select idiom and the nil-channel toggle.
- **Design channel contracts explicitly:** who closes, buffered vs unbuffered, what `default` means semantically (drop? retry?). The `select` is only as correct as the channel lifecycle around it.

---

## 14. Staff Engineer Notes

At staff level the lens widens to architecture and org-level trade-offs:

- **Channels-and-select vs an actor/queue framework.** `select` loops are perfect *within* a process; they do not survive crashes or scale across machines. The build-vs-buy call: in-process `select` orchestration for sub-millisecond fan-in, but reach for Kafka/NATS/SQS when you need durability, replay, or cross-service backpressure. Don't let teams reimplement a distributed queue out of channels.
- **Standardise cancellation org-wide on `context.Context`.** Mixed `done`-channel and `context` conventions across teams cause leak-prone glue code. A platform-level lint (e.g. forbidding context-less long-lived goroutines) pays off at scale.
- **Backpressure policy is a system property, not a local choice.** A `default`-drop in one service shifts load downstream; the staff job is to make drop/queue/shed decisions consistent and observable (metrics on every `default` branch) across the request path.
- **Cost at scale.** Thousands of goroutines each in a multi-case `select` add scheduler and `sudog` pressure; for very high-fan-in event systems, evaluate epoll-style single-loop designs or sharded consumers over naive per-channel goroutines.
- **Observability contract:** require that every `select` drop/timeout branch increments a metric, so capacity planning and incident triage have signal instead of silent loss.

---

## 15. Revision Summary

- `select` waits on multiple channel ops; runs one *ready* case, else `default`, else blocks.
- Simultaneously-ready cases are chosen **uniformly at random** (`pollorder`) — never rely on order for priority.
- `default` → non-blocking; no `default` → blocks until ready; `select {}` → blocks forever.
- All case operands evaluate once, top-to-bottom, **before** selection (even unchosen send values).
- `nil` channel case is never ready → use it to dynamically enable/disable cases.
- Closed channel is *always* ready (returns zero, `ok=false`) → nil it out to avoid busy-loops.
- Implemented by `runtime.selectgo`: lock channels in address order, poll in random order, enqueue a `sudog` per case and `gopark` if nothing ready.
- Cost ~ linear in number of cases; single-case selects optimise to a plain channel op.
- Use `time.NewTimer`+`Reset` (not `time.After`) in loops; always include `ctx.Done()`.

**References:** Go spec: Select (`go.dev/ref/spec#Select_statements`); `src/runtime/select.go` (`selectgo`); Effective Go — Concurrency; `context` package docs.

---
*Go Engineering Handbook — topic 34.*
