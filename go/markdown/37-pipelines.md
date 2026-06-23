# 37 · Pipelines

> **In one line:** Composable channel stages wired together to stream data, with a shared cancellation signal for clean shutdown.

---

## 1. Overview

A *pipeline* is a series of *stages* connected by channels, where each stage is a group of goroutines running the same function. Each stage:

1. **Receives** values from an upstream channel.
2. **Performs** some work (transform, filter, fan-out).
3. **Sends** values downstream on an outbound channel.

The first stage is a *source* (or *producer*); it only sends. The last stage is a *sink* (or *consumer*); it only receives. Everything in between reads from `in <-chan T` and writes to a freshly created `out chan<- U`.

The defining property is **composability**: because every stage has the same shape (`func(in <-chan A) <-chan B`), stages snap together like Unix pipes (`cat | grep | sort`). The hard part is not connecting them — it's tearing them down. If a downstream consumer stops early (error, client disconnect, `LIMIT 10`), every upstream goroutine must be told to stop, or they block forever on a send and leak. The canonical solution is a shared **`done` channel** (pre-context) or, in modern Go, `context.Context` for **cancellation**.

This chapter follows the structure of the classic *Go Blog: Pipelines and cancellation* article, then extends it to production-grade streaming, bounded fan-out, error propagation, and observability.

---

## 2. Why It Exists

Before pipelines, concurrent data processing in Go tended to collapse into one of two anti-patterns:

- **One giant goroutine** doing read → transform → write inline. No parallelism, no back-pressure control, untestable.
- **Shared mutable state guarded by a `sync.Mutex`**, with goroutines fighting over a slice or map. Lock contention, races, and impossible-to-reason-about ownership.

Pipelines exist to express "data flows through transformations" using Go's first-class concurrency primitives. They give you:

- **Natural back-pressure.** An unbuffered (or small-buffered) channel blocks the producer when the consumer is slow. The pipeline self-regulates memory: you never materialize the whole dataset.
- **Streaming.** You process item N while item N+1 is still being read. Memory stays O(buffer), not O(dataset). Critical for processing a 50 GB file on a 2 GB pod.
- **Composable parallelism.** Slow stages can be *fanned out* across N goroutines without touching upstream or downstream code.
- **Clear ownership.** The convention "the goroutine that creates a channel is the only one that closes it" makes lifecycle reasoning local and mechanical.

The trade-off it solves is the one every concurrent system faces: *how do I stop cleanly?* The `done`/`context` channel pattern is the answer.

---

## 3. Internal Working

A pipeline is built entirely on top of two runtime constructs: **goroutines** and **channels**. Understanding both at the runtime level explains every pipeline behavior.

**Goroutines.** Each stage is one or more `g` structs (defined in `runtime/proc.go`). A `g` carries a small, growable stack (starts at 2 KB, copied/grown by `morestack`). The scheduler multiplexes thousands of `g`s onto a handful of OS threads (`m`) via logical processors (`p`) — the classic GMP model. A goroutine blocked on a channel send/receive is *parked*: removed from the run queue, costing zero CPU until woken.

**Channels.** A channel is an `hchan` struct (`runtime/chan.go`):

```text
hchan
+----------------+
| qcount         |  # elements currently in buffer
| dataqsiz       |  # buffer capacity (0 for unbuffered)
| buf            |--> [ ring buffer of dataqsiz elements ]
| elemsize       |
| closed         |  # 0 or 1
| sendx, recvx   |  # ring buffer indices
| recvq          |--> waiting receivers (sudog linked list)
| sendq          |--> waiting senders   (sudog linked list)
| lock           |  # mutex protecting all fields
+----------------+
```

A send (`chansend`) acquires `hchan.lock`, then:

- If a receiver waits in `recvq`, hand the value *directly* to that goroutine's stack and wake it (no buffer copy) — the fast path.
- Else if the buffer has room, `memmove` into `buf[sendx]`, bump `sendx`/`qcount`.
- Else enqueue the sender as a `sudog` in `sendq`, park the goroutine.

`close(ch)` sets `closed = 1` and wakes *every* waiting `g` in both queues. A receive on a closed, drained channel returns the zero value with `ok == false`. This is the mechanism behind `for v := range ch` ending and behind the `done`-channel broadcast.

```text
 source ──ch1──> stage A ──ch2──> stage B ──ch3──> sink
   g0              g1               g2              g3
    │               │                │              │
    └──────── done (chan struct{}) ──┴──────────────┘
         close(done)  ==>  one signal wakes ALL selects
```

The `done`-channel trick relies on close-broadcast semantics: a single `close(done)` simultaneously unblocks every `select { case <-done: ... }` across all stages. `context.Context` wraps exactly this — `ctx.Done()` returns a channel that is `close`d on cancel/timeout. No polling, no shared boolean, no data race: the channel's internal lock provides the happens-before edge the memory model requires.

---

## 4. Syntax

The canonical stage signature and wiring:

```go
// Stage: receives ints, emits squares. Owns and closes `out`.
func sq(done <-chan struct{}, in <-chan int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out) // owner closes
		for n := range in {
			select {
			case out <- n * n:
			case <-done: // abandon-on-cancel
				return
			}
		}
	}()
	return out
}

// Source.
func gen(done <-chan struct{}, nums ...int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for _, n := range nums {
			select {
			case out <- n:
			case <-done:
				return
			}
		}
	}()
	return out
}

func main() {
	done := make(chan struct{})
	defer close(done) // guarantees every stage drains on return

	for v := range sq(done, gen(done, 1, 2, 3, 4)) {
		fmt.Println(v)
	}
}
```

> [!NOTE]
> Two rules make pipelines correct: **(1)** the goroutine that creates a channel is the only one that closes it; **(2)** every blocking send is wrapped in a `select` that also watches `done`/`ctx.Done()`. Break rule 2 and early consumer exit leaks the upstream goroutines.

---

## 5. Common Interview Questions

**Q1. What is a pipeline in Go and what shape does a stage have?**
A series of stages connected by channels; each stage is `func(in <-chan A) <-chan B` — reads from an inbound channel, does work, writes to an outbound channel it owns and closes. Source only sends; sink only receives.
*Follow-up: why directional channel types in the signature?* They document and enforce intent at compile time: a stage physically cannot close its input or read its output, catching ownership bugs.

**Q2. Why can a pipeline leak goroutines, and how do you fix it?**
If the consumer stops early, upstream goroutines block forever on `out <- v` because no one is receiving. Fix: pass a `done` channel (or `context.Context`); every send uses `select` on both `out <-` and `<-done`. Closing `done` unblocks all of them.
*Follow-up: why `chan struct{}` for `done`?* It carries no data — only the close event matters — and `struct{}` is zero bytes, so it signals pure intent.

**Q3. `done` channel vs `context.Context` — which and why?**
`context` is the modern standard: it propagates across API boundaries, supports timeouts/deadlines, and carries cancellation reasons (`context.Cause`, Go 1.20+). Use a bare `done` only in a tiny self-contained pipeline. Internally they're the same close-broadcast mechanism.
*Follow-up: does cancelling a context drain in-flight values?* No. Cancellation tells stages to *stop*; you still defer-close to let goroutines return. Values already sent but unread are dropped once stages observe cancellation.

**Q4. What is fan-out / fan-in?**
Fan-out: start N goroutines all reading the *same* input channel to parallelize a slow stage. Fan-in: merge those N output channels into one using a `sync.WaitGroup` (or `errgroup`) to know when all are done before closing the merged channel.
*Follow-up: why does fan-out work with one shared input channel?* Channel receives are atomic; each value goes to exactly one receiver, so N workers naturally load-balance without a dispatcher.

**Q5. How do you propagate errors through a pipeline?**
Either send a `struct{ Val T; Err error }` envelope down the same channel, or run the pipeline under `errgroup.Group` so the first error cancels the shared context and `g.Wait()` returns it.
*Follow-up: what's the risk of a separate error channel?* It needs its own `select` arm at every stage and complicates shutdown ordering; an envelope or `errgroup` is simpler and harder to deadlock.

**Q6. Buffered vs unbuffered channels between stages?**
Unbuffered gives strict hand-off and tightest back-pressure. A small buffer (e.g., the worker count) smooths bursty producers and reduces scheduler ping-pong, at the cost of more in-flight memory. Buffer for throughput, not "to avoid blocking" — that masks back-pressure bugs.
*Follow-up: how do you size a buffer?* Benchmark. Start at 0, then try `cap == GOMAXPROCS` or batch size; measure p99 latency and allocation, not just ops/sec.

**Q7. How do you guarantee no goroutine leak when the consumer reads only part of the output?**
`defer close(done)` (or `defer cancel()`) in the function that owns the pipeline. On any return path — early `break`, error, panic recovery — the deferred close fires and every stage's `select` takes the `<-done` arm and returns.

---

## 6. Production Use Cases

- **Log/event ingestion (ETL).** A source reads from Kafka, stages parse → enrich → validate → batch, sink writes to ClickHouse/S3. This is the spine of pipelines at Uber (Cadence/CDC tooling), Grafana Loki ingesters, and the Datadog agent's metric processing.
- **`io` and streaming.** Go's own `io.Pipe` is a one-stage pipeline; `bufio.Scanner` feeds line-oriented stages. Media transcoders stream frames through decode → filter → encode stages.
- **gRPC streaming services.** A server-streaming RPC is literally a sink-to-network stage; pipelines back-pressure naturally onto the gRPC flow-control window.
- **Build tools / linters.** `go build`'s package loader and many linters (golangci-lint runs analyzers as fan-out stages) parallelize independent units via fan-out/fan-in.
- **Crawlers and scrapers.** Fetch (fan-out, I/O-bound) → parse → dedup → store. The classic interview crawler is a bounded-fan-out pipeline.
- **CI/CD and image builds.** BuildKit models builds as a DAG of cancellable stages — a generalization of the linear pipeline.

---

## 7. Common Mistakes

> [!WARNING]
> The single most common bug is a **goroutine leak from a blocked send** when the consumer exits early. Always `select` sends against `done`/`ctx.Done()`.

- **Closing a channel you don't own.** A downstream stage closing its input causes a `panic: send on closed channel` upstream. Only the creating goroutine closes.
- **Closing a channel twice.** `panic: close of closed channel`. With fan-in, only the merge goroutine (after `wg.Wait()`) closes the merged channel.
- **Forgetting `defer close(out)`.** The downstream `range` never ends → consumer hangs forever.
- **Using a buffer to "fix" a deadlock.** It only delays it and hides missing back-pressure handling.
- **Writing to `out` after the consumer is gone without watching `done`** — the textbook leak.
- **Calling `context.WithCancel` but never `cancel`.** It leaks a goroutine/timer even on the happy path. `defer cancel()` always.
- **Fan-in without a `WaitGroup`** → closing the merged channel too early drops values or panics.

---

## 8. Performance Considerations

- **Channel ops cost ~50–100 ns** under contention (lock + sudog + scheduler). For tiny per-item work, the channel overhead can dwarf the work — **batch** (send `[]T` slices, not single `T`) to amortize. Batching by 100 routinely yields 10–50x throughput on cheap transforms.
- **Unbuffered channels** trigger a goroutine switch on every send (hand-off). A buffer of `cap == GOMAXPROCS` lets producers run ahead and cuts context switches.
- **Fan-out width.** For CPU-bound stages, `runtime.GOMAXPROCS(0)` workers is the sweet spot — more just adds scheduler overhead. For I/O-bound stages (HTTP, DB), width can be far higher (limited by connection pool / downstream rate limit, not CPU).
- **Allocation pressure.** Sending large structs by value copies through the buffer. Prefer small values or pointers; reuse buffers with `sync.Pool` for hot byte slices. Watch escape analysis — closures over loop variables can force heap allocation.
- **Per-item overhead** dominates the profile in naive pipelines. Always `go tool pprof` before tuning buffer sizes by feel.

| Knob | Helps | Costs |
|------|-------|-------|
| Batching items | Throughput (huge) | Latency per item, memory |
| Buffered channel | Fewer switches | In-flight memory, hides back-pressure |
| More fan-out (CPU) | Parallelism up to NumCPU | Scheduler overhead beyond it |
| More fan-out (I/O) | Concurrency | Downstream overload |

---

## 9. Best Practices

- Use **`context.Context`** as the cancellation primitive in any non-trivial pipeline; `defer cancel()` immediately after creating it.
- Keep the **stage signature uniform**: `func(ctx, in <-chan A) <-chan B`. Uniformity is what makes stages composable.
- **One owner per channel.** Closing is the owner's job, in a `defer`.
- **Bound fan-out** with a worker count or semaphore; never spawn one goroutine per item from an unbounded source.
- For errors, prefer **`golang.org/x/sync/errgroup`** with a derived context — first error cancels the whole pipeline.
- Make stages **pure and testable**: a stage is just `func(in) out`; test it by feeding a slice-backed channel and collecting results.
- **Document back-pressure expectations** and buffer sizes in code comments — future maintainers will otherwise "fix" a deadlock with a buffer.
- Add **metrics per stage** (items in/out, queue depth, latency) from day one; pipelines are opaque without them.

---

## 10. Code Examples

Primary: a complete, cancellable, fan-out/fan-in pipeline using `errgroup` and `context`.

```go
package main

import (
	"context"
	"fmt"
	"runtime"

	"golang.org/x/sync/errgroup"
)

// gen is the source stage.
func gen(ctx context.Context, nums ...int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for _, n := range nums {
			select {
			case out <- n:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// sq is a worker; many run in parallel reading the same `in`.
func sq(ctx context.Context, in <-chan int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for n := range in {
			select {
			case out <- n * n:
			case <-ctx.Done():
				return
			}
		}
	}()
	return out
}

// merge fans in N channels into one (fan-in).
func merge(ctx context.Context, cs ...<-chan int) <-chan int {
	out := make(chan int)
	var g errgroup.Group
	for _, c := range cs {
		c := c
		g.Go(func() error {
			for v := range c {
				select {
				case out <- v:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return nil
		})
	}
	go func() { _ = g.Wait(); close(out) }() // close only after all senders done
	return out
}

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	in := gen(ctx, 1, 2, 3, 4, 5, 6, 7, 8)

	// Fan-out across NumCPU workers.
	workers := runtime.GOMAXPROCS(0)
	chans := make([]<-chan int, workers)
	for i := range chans {
		chans[i] = sq(ctx, in)
	}

	count := 0
	for v := range merge(ctx, chans...) {
		fmt.Println(v)
		count++
		if count == 3 {
			cancel() // early exit: cancel unblocks every upstream send
			break
		}
	}
}
```

Alternative: the pre-context `done`-channel form (still idiomatic for small, self-contained code and faithful to the Go blog).

```go
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
	defer close(done) // single close broadcasts to all stages

	out := sq(done, sq(done, gen(done, 2, 3)))
	fmt.Println(<-out) // 16, then 81; deferred close drains the rest cleanly
}
```

---

## 11. Advanced Concepts

- **Error-carrying envelopes.** Define `type Result[T any] struct { Val T; Err error }` and stream that. Each stage forwards errors untouched or short-circuits. Generics (Go 1.18+) let you build a reusable `Map`, `Filter`, `FlatMap` stage library.
- **Bounded parallelism with `golang.org/x/sync/semaphore`** when you cannot pre-spawn workers (e.g., dynamic per-key concurrency).
- **DAG pipelines.** Linear pipelines generalize to directed acyclic graphs (split, join, conditional routing). BuildKit and Apache Beam's Go SDK model this; cancellation still propagates via one shared context.
- **Rate limiting as a stage.** Insert a stage gated by `golang.org/x/time/rate.Limiter` to throttle a downstream API without redesigning the pipeline.
- **Windowing / batching stage.** Accumulate items until count N or a `time.Ticker` fires, then emit a batch — the basis of micro-batch streaming (Loki, Tempo).
- **`iter.Seq` (Go 1.23 range-over-func).** Pull-based iterators are an alternative to channel pipelines when you want no extra goroutines and synchronous back-pressure; channels remain the choice when stages must run concurrently.

> [!TIP]
> Use `errgroup.WithContext`: the *first* stage to return a non-nil error cancels the shared context, which propagates the stop signal to every other stage automatically. One pattern handles both errors and shutdown.

---

## 12. Debugging Tips

- **Detect leaks:** print `runtime.NumGoroutine()` before and after; if it doesn't return to baseline, a stage is stuck on a send. Use `go.uber.org/goleak` in tests to assert zero leaks.
- **Find the blocked goroutine:** `SIGQUIT` (Ctrl-\\) or `curl localhost:6060/debug/pprof/goroutine?debug=2` dumps every stack; look for goroutines parked in `chansend`/`chanrecv`.
- **Deadlock:** `fatal error: all goroutines are asleep - deadlock!` means no stage can progress — usually a missing `close(out)` so a `range` never ends, or a send with no receiver.
- **Race detector:** run with `-race`. Pipelines are usually race-free *if* you don't share state outside channels; a race almost always means a stage mutates shared memory it shouldn't.
- **Visualize back-pressure:** add a gauge metric for each channel's pending count (sample with a periodic `len(ch)`); a perpetually full channel pinpoints the bottleneck stage.
- **Reproduce ordering bugs:** set `GOMAXPROCS=1` to serialize, or run under `-race` which perturbs scheduling.

---

## 13. Senior Engineer Notes

- **In code review, the first thing I look for is the cancellation path.** Every blocking send must `select` on `ctx.Done()`, and the top-level owner must `defer cancel()`. A pipeline without this is a latent production incident.
- **I reject buffer sizes chosen "to make it not block."** Ask for the benchmark that justified the number and a comment explaining the back-pressure intent.
- **Enforce the ownership rule mechanically:** directional channel types in signatures (`<-chan`, `chan<-`) so a stage *cannot* close its input. This turns a class of runtime panics into compile errors.
- **Mentoring:** I teach juniors to write each stage as a pure, independently testable function first, then wire them. The "feed a channel built from a slice, collect into a slice" test pattern catches off-by-one and close bugs cheaply.
- **Prefer `errgroup` over hand-rolled error channels** in reviews — fewer select arms, no shutdown-ordering footguns, and `Wait()` gives you the first error for free.
- **Judgement call:** if a stage's work is sub-microsecond, I push back on the pipeline entirely and ask for batching or a plain loop — channel overhead can make the "concurrent" version slower.

---

## 14. Staff Engineer Notes

- **Architecture:** a single-process channel pipeline has a ceiling — one machine, no durability. The staff-level decision is *when* to graduate from in-process channels to a durable, distributed pipeline (Kafka + consumer groups, Temporal, Apache Beam/Dataflow, Flink). Channels give you µs latency and zero ops; durable systems give you replay, exactly-once-ish semantics, and horizontal scale at the cost of operational weight.
- **Build vs buy:** for ETL above ~tens of thousands of events/sec with at-least-once delivery and replay requirements, adopt a streaming platform; don't rebuild Kafka in goroutines. In-process pipelines are right for request-scoped fan-out, agent-side processing, and CPU-bound transforms where the data already fits the machine.
- **Cross-team contracts:** when pipelines span service boundaries, the "channel" becomes a queue/topic and the `context` becomes distributed cancellation (request deadlines, gRPC cancellation propagation). Standardize the envelope schema, the dead-letter strategy, and back-pressure behavior across teams — these are organizational, not code, decisions.
- **Failure semantics at scale:** decide and document per-pipeline whether it's at-most-once, at-least-once, or exactly-once, and how partial failure is handled (drop, retry, DLQ). This single choice drives idempotency requirements on every downstream stage owned by other teams.
- **Cost and capacity:** model the pipeline as a queueing system (arrival rate λ, service rate µ per stage). The slowest stage sets throughput; over-provisioning fast stages wastes money. Right-size fan-out per stage against the actual bottleneck, not uniformly.
- **Observability as a platform concern:** mandate per-stage metrics, tracing context propagation, and queue-depth dashboards as a reusable library so every team's pipeline is debuggable the same way.

---

## 15. Revision Summary

- A **pipeline** = stages connected by channels; stage shape `func(ctx, in <-chan A) <-chan B`. Source sends only; sink receives only.
- **Ownership rule:** the goroutine that creates a channel closes it (in a `defer`); never close someone else's channel, never close twice.
- **Cancellation rule:** wrap every blocking send in `select { case out <- v: case <-ctx.Done(): return }`. `defer cancel()` / `defer close(done)` guarantees no leak on early exit.
- `done chan struct{}` and `ctx.Done()` are the *same* mechanism: a single `close` broadcasts to all waiting `select`s (channel close-broadcast at the `hchan` level).
- **Fan-out:** N goroutines on one shared input. **Fan-in:** merge with `WaitGroup`/`errgroup`, close merged channel only after all senders finish.
- **Errors:** prefer `errgroup.WithContext` (first error cancels all) or a `Result{Val, Err}` envelope.
- **Performance:** channel op ~50–100 ns; **batch** tiny work, size buffers by benchmark, fan-out ≈ NumCPU (CPU-bound) or pool-limited (I/O-bound).
- **Debug:** `goleak`, `NumGoroutine()`, pprof goroutine dump for parked `chansend`/`chanrecv`.
- **Staff lens:** know when to graduate from in-process channels to Kafka/Temporal/Beam — durability, replay, and scale vs. µs latency and zero ops.

**References:** Go Blog — *Go Concurrency Patterns: Pipelines and cancellation*; `golang.org/x/sync/errgroup`; `golang.org/x/sync/semaphore`; Go memory model (channel happens-before); `runtime/chan.go` (hchan internals); `go.uber.org/goleak`.

---
*Go Engineering Handbook — topic 37.*
