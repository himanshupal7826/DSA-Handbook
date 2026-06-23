# 36 · Fan-Out Fan-In

> **In one line:** Spawn many goroutines to process work in parallel (fan-out), then merge their results back into a single stream (fan-in).

---

## 1. Overview

Fan-out / fan-in is the canonical Go concurrency pattern for parallelizing a stage in a pipeline. You take one stream of work, **fan it out** to N worker goroutines that all read from the same input channel, and **fan it in** by merging their N output channels into a single result channel.

The pattern exists because most real workloads are *embarrassingly parallel* at one stage: hashing files, resizing images, calling a downstream RPC per item, enriching records. The CPU or the network can do many of these at once, but a naive single-goroutine loop processes them serially. Fan-out lets you use all your cores (or saturate I/O concurrency) without rewriting the producer or consumer.

```text
                 ┌────────► worker 1 ──┐
                 │                      │
 producer ──► in ┼────────► worker 2 ──┼──► merge ──► out ──► consumer
 (gen)           │                      │   (fan-in)
                 └────────► worker 3 ──┘
                  (fan-out: N readers,    (single
                   one shared channel)     reader)
```

The two halves are independent ideas you can use separately, but they almost always appear together because fanning out only helps if you can also collect the results in order-agnostic fashion.

---

## 2. Why It Exists

A single Go channel plus a single consumer goroutine gives you a serial pipeline. That is correct but leaves cores idle:

- A 100ms downstream RPC called 10,000 times serially takes ~17 minutes. With 50 concurrent workers it takes ~20 seconds.
- An image-resize stage that takes 30ms of CPU on an 8-core box runs ~8× faster when fanned out to 8 workers.

Fan-out exists to convert *available concurrency* (cores, network slots, DB connections) into *throughput*. Fan-in exists because the rest of your program wants **one** channel to range over, not N. The merge step also gives you a single, clean place to handle backpressure and shutdown.

> [!NOTE]
> Fan-out is about throughput, not the latency of a single item. One item still takes as long as it takes; you just process more of them per unit time.

---

## 3. Internal Working

There is no special runtime construct for "fan-out." It is built entirely from goroutines and channels, so understanding it means understanding how those are implemented.

**Channels (`hchan`).** A channel is a heap-allocated `runtime.hchan` struct: a ring buffer (`buf`) for buffered channels, element size/count, a `sendq` and `recvq` (doubly linked lists of blocked goroutines, each represented by a `sudog`), and a `mutex` guarding the whole thing. When multiple workers all receive from the same input channel, they each park on the channel's `recvq` until a sender hands them an element. The runtime wakes exactly one waiting receiver per send — this is the mechanism that **load-balances work across fan-out workers for free**: a faster worker loops back and grabs the next item sooner.

**Goroutines (`g`).** Each worker is a `g` with its own small (initially 8KB) growable stack. The scheduler multiplexes them onto OS threads (`m`) via per-P run queues (the GMP model). `GOMAXPROCS` Ps means at most that many goroutines run truly in parallel; the rest are runnable and waiting.

```text
 send on `in`:
   ┌──────────── hchan(in) ───────────┐
   │ lock | buf(ring) | sendq | recvq │
   └───────────────────┬──────────────┘
        recvq: [w1.sudog] -> [w2.sudog] -> [w3.sudog]
   producer sends x  ─► runtime dequeues w1.sudog,
                        copies x into w1's stack slot,
                        marks w1 runnable (goready)
   w1 processes x, sends result on its own `out` channel
```

**Fan-in merge.** The standard merge spins up one goroutine per input channel, each copying into a shared output channel, plus a `sync.WaitGroup` whose `Wait()` triggers `close(out)`. Internally `close` walks the `recvq`/`sendq` and wakes every parked goroutine, returning the zero value + `ok=false`, which is how `for range out` terminates cleanly.

**Memory layout note.** Values are *copied* into and out of channel buffers (Go has no implicit sharing). For large structs, workers pass pointers to avoid copying — but then you must ensure no two goroutines mutate the same pointee.

---

## 4. Syntax

The three building blocks:

```go
// 1. Fan-out: start N workers reading the SAME input channel.
for i := 0; i < n; i++ {
	go worker(in, out)
}

// 2. A worker drains the shared channel until it's closed.
func worker(in <-chan Job, out chan<- Result) {
	for job := range in { // ranges until `in` is closed
		out <- process(job)
	}
}

// 3. Fan-in: merge many channels into one, close when all done.
func merge(cs ...<-chan Result) <-chan Result {
	var wg sync.WaitGroup
	out := make(chan Result)
	wg.Add(len(cs))
	for _, c := range cs {
		go func(c <-chan Result) {
			defer wg.Done()
			for v := range c {
				out <- v
			}
		}(c)
	}
	go func() { wg.Wait(); close(out) }()
	return out
}
```

Note the directional channel types (`<-chan`, `chan<-`) which let the compiler enforce that workers only send and the merge only receives.

---

## 5. Common Interview Questions

**Q1. Who closes the channels, and why does that matter?**
The **producer** closes the input channel (sender owns close); workers `range` over it and exit naturally. For the output, the **merge** closes it after a `WaitGroup` confirms all workers finished. Rule: only the sender closes, and only once. Closing from a receiver or double-closing panics.
*Follow-up — what if a worker panics before Done?* Use `defer wg.Done()` so the count is decremented even on panic; otherwise `Wait()` blocks forever (a goroutine leak / deadlock).

**Q2. How do you stop early on the first error or on cancellation?**
Pass a `context.Context` and `select` on `ctx.Done()` in both the send and receive directions. With `errgroup.WithContext`, the first worker returning an error cancels the context, and other workers observe `ctx.Done()` and bail.
*Follow-up — why select on ctx in the SEND too?* Because `out <- v` can block forever if the consumer stopped reading; selecting on `ctx.Done()` prevents that goroutine leak.

**Q3. How many workers should you spawn?**
For CPU-bound work, ~`runtime.GOMAXPROCS(0)`. For I/O-bound work, far more (limited by downstream capacity: connection pool size, rate limits), tuned empirically. Unbounded fan-out is the classic bug.
*Follow-up — why not one goroutine per item?* Memory (8KB+ stacks), scheduler overhead, and worse: you may overwhelm the downstream (thundering herd) and lose ordering control. A fixed worker pool bounds concurrency.

**Q4. Does fan-out preserve order?**
No. Results arrive in completion order, not submission order. If you need order, tag each job with an index and reorder at the consumer, or use a slice indexed by job position instead of a channel.
*Follow-up — how to keep order without buffering everything?* Use a bounded reorder buffer keyed by sequence number, emitting the next expected index as it arrives.

**Q5. What's the difference between fan-out and a worker pool?**
They're nearly the same. "Fan-out" emphasizes the topology (one source → many readers); "worker pool" emphasizes the reusable fixed set of goroutines. A worker pool *is* how you implement bounded fan-out.
*Follow-up — when is a pool wrong?* When tasks have wildly different durations — one slow task can head-of-line block a worker. Consider per-task goroutines gated by a `semaphore` (golang.org/x/sync/semaphore) for that.

**Q6. How do you apply backpressure?**
Use unbuffered or small-buffered channels. If the consumer is slow, `out <- v` blocks, which blocks the worker, which stops it pulling from `in`, which blocks the producer. Backpressure propagates upstream automatically through channel blocking.
*Follow-up — what does a large buffer do?* It hides backpressure and grows memory; it can mask a slow consumer until you OOM.

**Q7. How do you avoid goroutine leaks in fan-in?**
Every goroutine must have a guaranteed exit: input channels get closed, sends are guarded by `ctx.Done()`, and the merge closes `out` only after all workers finish. Run with `-race` and check `runtime.NumGoroutine()` before/after, or use `go.uber.org/goleak` in tests.

---

## 6. Production Use Cases

- **Cloudflare / CDN log processing** — fan out batches of log lines to parser workers, fan in to an aggregator. Per-core parsing is the bottleneck.
- **gRPC/REST gateways** — a request that must call 5 downstream services fans out one goroutine per call and fans in via `errgroup`, cutting latency from sum-of-calls to max-of-calls. This is the *scatter-gather* variant used heavily at Google and in service meshes.
- **Image/video pipelines (Cloudinary-style)** — resize/transcode each asset on its own worker; CPU-bound, pool sized to cores.
- **Web crawlers** — the Go blog's pipeline example and Colly use fan-out for concurrent fetching with bounded workers to respect rate limits.
- **ETL / data ingestion (Kafka consumers)** — partition consumers fan out records to enrichment workers, fan in to a batched DB writer. Tools like `segmentio/kafka-go` are commonly wrapped this way.
- **MapReduce / sharded computation** — the "map" stage is fan-out, the "reduce" stage is fan-in. This is literally the architecture of the pattern.

---

## 7. Common Mistakes

> [!WARNING]
> The top three production incidents from this pattern: goroutine leaks, double-close panics, and unbounded fan-out exhausting memory or hammering a downstream.

- **Unbounded fan-out** — `go process(item)` inside a loop over a huge slice spawns millions of goroutines. Always bound with a worker pool or semaphore.
- **Forgetting to close `in`** — workers `range` forever, the merge never sees EOF, `out` never closes, the consumer hangs.
- **Double close / closing from a receiver** — panics with `close of closed channel` or `close of nil channel`.
- **Leaking workers on early return** — if the consumer stops reading (e.g., found what it wanted) without cancellation, workers block on `out <- v` forever.
- **Sharing a mutable pointer across workers** — passing `*Record` and mutating it races. Pass values or give each worker its own copy.
- **Calling `wg.Add` inside the goroutine** — a race against `wg.Wait`; always `Add` before `go`.

---

## 8. Performance Considerations

- **Channel ops aren't free.** Each send/receive takes a lock on the `hchan` and may park/unpark a goroutine. For tiny work items, the coordination cost dominates. **Batch** items (send `[]Job` of 100) to amortize.
- **Worker count.** CPU-bound: start at `GOMAXPROCS`. I/O-bound: benchmark — the sweet spot is where the downstream saturates without queuing. Plot throughput vs. workers; it rises, then plateaus, then often *declines* due to contention.
- **Buffer sizing.** A small buffer (equal to worker count) smooths jitter; a huge buffer hides backpressure and bloats memory. Default to unbuffered or `N`.
- **Allocation pressure.** Per-item allocations in the hot loop pressure the GC; reuse buffers via `sync.Pool` where the result is short-lived.
- **Contention on a single output channel.** With many fast workers, one merged `out` channel becomes a serialization point. Measure with `go test -bench` and `runtime/pprof`; if the merge is the bottleneck, shard the output or batch.

| Knob | Too low | Too high |
|------|---------|----------|
| Workers | Idle cores, low throughput | Contention, downstream overload |
| Buffer | More blocking/jitter | Memory bloat, hidden backpressure |
| Batch size | Per-item overhead | Latency spikes, big copies |

---

## 9. Best Practices

- **The producer closes the input; the merge closes the output.** Sender-owns-close, always.
- **Bound concurrency.** Fixed worker pool or `semaphore.Weighted`. Never `go` per item over unbounded input.
- **Always pass `context.Context`** and select on `ctx.Done()` in both send and receive directions.
- **Use `errgroup`** for the common "do N things, fail fast on first error" case — it handles cancellation and error aggregation for you.
- **`defer wg.Done()`** so panics don't deadlock `Wait`.
- **Pass values or immutable pointers** between stages; never share mutable state without synchronization.
- **Make stages composable.** Each stage takes `<-chan In` and returns `<-chan Out` so you can wire pipelines like Lego.

> [!TIP]
> If your fan-out/fan-in code is more than ~40 lines, reach for `golang.org/x/sync/errgroup` or `semaphore` before hand-rolling WaitGroups and done-channels.

---

## 10. Code Examples

**Primary — idiomatic fan-out/fan-in with `errgroup` and context.** This bounds concurrency, fails fast, and never leaks goroutines.

```go
package main

import (
	"context"
	"fmt"

	"golang.org/x/sync/errgroup"
)

func process(ctx context.Context, n int) (int, error) {
	return n * n, nil // pretend this is expensive / I/O-bound
}

func fanOutFanIn(ctx context.Context, jobs []int, workers int) ([]int, error) {
	g, ctx := errgroup.WithContext(ctx)
	in := make(chan int)
	out := make(chan int)

	// Producer: feed jobs, respecting cancellation, then close `in`.
	g.Go(func() error {
		defer close(in)
		for _, j := range jobs {
			select {
			case in <- j:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
		return nil
	})

	// Fan-out: N workers share `in`, all write to `out`.
	var workerG errgroup.Group
	for i := 0; i < workers; i++ {
		workerG.Go(func() error {
			for j := range in {
				r, err := process(ctx, j)
				if err != nil {
					return err
				}
				select {
				case out <- r:
				case <-ctx.Done():
					return ctx.Err()
				}
			}
			return nil
		})
	}

	// Fan-in: close `out` once all workers finish.
	go func() { _ = workerG.Wait(); close(out) }()

	// Consumer: drain results into a slice.
	results := make([]int, 0, len(jobs))
	for r := range out {
		results = append(results, r)
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}
	if err := workerG.Wait(); err != nil {
		return nil, err
	}
	return results, nil
}

func main() {
	res, err := fanOutFanIn(context.Background(), []int{1, 2, 3, 4, 5}, 3)
	fmt.Println(res, err)
}
```

The alternative below is the classic Go-blog merge using explicit channels and a `WaitGroup` — useful when you have *already-created* output channels (true pipeline composition) rather than a worker pool.

```go
package main

import (
	"fmt"
	"sync"
)

// gen turns a slice into a channel (pipeline source).
func gen(nums ...int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for _, n := range nums {
			out <- n
		}
	}()
	return out
}

// sq is one fan-out worker: square the input.
func sq(in <-chan int) <-chan int {
	out := make(chan int)
	go func() {
		defer close(out)
		for n := range in {
			out <- n * n
		}
	}()
	return out
}

// merge fans in any number of channels into one.
func merge(cs ...<-chan int) <-chan int {
	var wg sync.WaitGroup
	out := make(chan int)
	output := func(c <-chan int) {
		defer wg.Done()
		for n := range c {
			out <- n
		}
	}
	wg.Add(len(cs))
	for _, c := range cs {
		go output(c)
	}
	go func() { wg.Wait(); close(out) }()
	return out
}

func main() {
	in := gen(1, 2, 3, 4, 5, 6, 7, 8)
	// Fan-out to 3 identical workers reading the same `in`.
	c1, c2, c3 := sq(in), sq(in), sq(in)
	// Fan-in.
	for n := range merge(c1, c2, c3) {
		fmt.Println(n)
	}
}
```

---

## 11. Advanced Concepts

- **Ordered fan-in.** Tag jobs with a sequence number, fan out, then reorder at the consumer with a min-heap or a `map[int]Result` emitting the next expected index. Necessary for streaming where output order must match input.
- **Bounded fan-out via semaphore.** Instead of a fixed pool, use `semaphore.Weighted` to launch one goroutine per task but cap concurrent execution — good when task costs vary widely (no head-of-line blocking).
- **Dynamic / adaptive worker pools.** Scale workers based on queue depth or measured latency. Rare in practice; usually a fixed pool tuned by load test is enough and far simpler.
- **Pipeline of fan-outs.** Chain stages where each is itself fanned out (parse → enrich → write), tuning worker counts per stage to balance throughput. This is the full "pipeline" model from the Go blog.
- **`select`-based merge for a small fixed N.** For exactly 2–3 channels you can merge with a single `select` loop instead of N goroutines, avoiding the merge goroutines entirely.
- **Result batching at the sink.** The consumer accumulates results and flushes in batches (e.g., bulk DB insert) to amortize downstream cost — a fan-in optimization independent of the workers.

---

## 12. Debugging Tips

- **Goroutine leaks:** print `runtime.NumGoroutine()` before and after; a steadily growing count under load means leaked workers. `go.uber.org/goleak` catches them in CI.
- **Deadlock (`all goroutines are asleep`):** usually a channel never closed or a `wg.Wait` waiting on a worker that exited without `Done`. Read the panic dump — it lists every goroutine's blocked location.
- **Races:** always run `go run -race` / `go test -race`. Fan-out plus a shared pointer is the #1 source of detected races.
- **Stuck pipeline:** send `SIGQUIT` (Ctrl-\) to dump all goroutine stacks; look for many goroutines parked on `chan send` (slow/dead consumer) or `chan receive` (no producer / unclosed input).
- **Profiling the merge bottleneck:** `import _ "net/http/pprof"`, then `go tool pprof` the goroutine and mutex profiles; high `runtime.chanrecv`/`lock2` time means the merge channel is the contention point.

---

## 13. Senior Engineer Notes

A senior engineer treats fan-out/fan-in as a *judgement call*, not a reflex. Before parallelizing, ask: is this stage actually the bottleneck? Premature fan-out adds complexity and bugs for no throughput gain — profile first.

In code review, the things I block on: (1) who closes each channel, (2) is concurrency bounded, (3) is `ctx` honored on every blocking op, (4) `defer wg.Done()`, (5) no shared mutable state across workers. I push reviewers to prefer `errgroup` over hand-rolled WaitGroup+done-channel plumbing — it eliminates an entire class of leak bugs and reads better.

When mentoring, I emphasize that **the channel does the load balancing for you** — juniors often over-engineer a dispatcher when "N workers ranging one channel" already distributes work optimally. I also teach them to write a leak test (`goleak`) for every concurrent component; if you can't prove your goroutines exit, you don't understand your own code. Finally, I insist on a benchmark that sweeps worker count, because the "obvious" number is usually wrong by 2–4×.

---

## 14. Staff Engineer Notes

At the architecture level, fan-out/fan-in is an *in-process* parallelism tool, and the staff-level question is **where the parallelism should live**. If a stage needs to scale beyond one machine, the right answer is often not more goroutines but a queue (Kafka, SQS, NATS) with horizontally-scaled consumer processes — fan-out across pods, not goroutines. Goroutine fan-out is bounded by one box's cores and one process's blast radius; a crash loses all in-flight work. I weigh that durability/elasticity trade-off explicitly.

Cross-team, the danger is *uncoordinated fan-out amplification*: service A fans out 50 calls to service B, which each fans out 20 to service C — suddenly C sees 1000× traffic and falls over. This is why org-level rate limits, concurrency budgets, and load-shedding belong in the platform, not in each service. I treat shared downstreams as a capacity contract.

Build-vs-buy: for simple in-process parallelism, the standard library plus `x/sync` is the answer — never pull a framework. But for durable, observable, retryable pipelines spanning services, I'd evaluate a workflow engine (Temporal, Cadence) or a stream processor (Flink, Kafka Streams) rather than reinventing fan-out/fan-in with at-least-once semantics, dead-letter queues, and exactly-once sinks by hand. The handbook rule I give teams: goroutine fan-out for milliseconds-to-seconds, single-process work; a queue/workflow system the moment durability, cross-service scale, or retry-after-restart enters the requirements.

---

## 15. Revision Summary

- **Fan-out:** N worker goroutines all `range` over one shared input channel; the runtime load-balances by waking one parked receiver per send.
- **Fan-in (merge):** one goroutine per input channel copying to a shared `out`, plus a `WaitGroup` that `close(out)`s when all finish.
- **Closing rule:** sender owns close — producer closes input, merge closes output; never close from a receiver or twice.
- **Bound concurrency** with a fixed pool or `semaphore`; unbounded fan-out is the classic OOM / downstream-overload bug.
- **Always honor `context`** on both send and receive to prevent goroutine leaks; `defer wg.Done()`.
- **No order guarantee** — results arrive in completion order; tag-and-reorder if you need ordering.
- **Backpressure** propagates automatically through blocking channels; big buffers hide it.
- **Reach for `errgroup`** for fail-fast scatter-gather; reach for a queue/workflow engine when you need cross-machine scale or durability.
- **Debug** with `-race`, `goleak`, `NumGoroutine()`, and SIGQUIT stack dumps.

**References:** Go blog "Go Concurrency Patterns: Pipelines and cancellation"; `golang.org/x/sync/errgroup` and `golang.org/x/sync/semaphore`; the Go memory model; `runtime/pprof` and `go.uber.org/goleak`.

---
*Go Engineering Handbook — topic 36.*
