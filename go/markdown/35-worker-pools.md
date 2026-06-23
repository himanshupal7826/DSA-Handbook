# 35 · Worker Pools

> **In one line:** A worker pool bounds concurrency by feeding jobs through a channel to a fixed set of long-lived goroutines, trading unlimited parallelism for predictable resource usage and throughput.

---

## 1. Overview

A *worker pool* is the canonical Go answer to the question: "I have N units of work, but I cannot afford N concurrent goroutines hammering a downstream resource." Instead of spawning one goroutine per job, you spawn a *fixed* number of workers — say 16 — and stream the jobs to them over a shared channel. Each worker loops: receive a job, do the work, repeat. When the job channel closes and drains, the workers exit.

The pattern gives you three things at once: **bounded concurrency** (never more than W things in flight), a natural **job queue** (the buffered channel), and a clean **backpressure** mechanism (producers block when the queue is full). It is the structural backbone of crawlers, image pipelines, batch ETL, request fan-out, and almost every "process a list of things in parallel but not *too* parallel" task you will ever write.

The mental model is a factory line: a conveyor belt (the channel) carries parts (jobs) past a fixed row of stations (workers). You don't add a new worker for every part; you size the line for sustainable throughput.

## 2. Why It Exists

Go makes goroutines cheap — ~2 KB initial stack, scheduled in user space. This cheapness is a trap. The naive `for _, job := range jobs { go process(job) }` looks idiomatic and works fine for 100 jobs. At 100,000 jobs it can:

- Open 100,000 simultaneous DB connections or HTTP sockets, exhausting file descriptors (`too many open files`) or the connection pool.
- Blow past a downstream API's rate limit and get you throttled or banned.
- Spike memory because every in-flight job holds its buffers, request bodies, and decoded payloads at once.
- Cause scheduler and GC pressure from millions of live goroutines.

The problem is **unbounded concurrency**. A worker pool exists to put a hard ceiling on "how much can happen at the same time" regardless of how much work arrives. It decouples *arrival rate* (how fast jobs come in) from *service rate* (how fast you process them), with the channel buffer absorbing the difference. That decoupling is the whole point.

> [!NOTE]
> A worker pool is a *concurrency limiter expressed as goroutines*. A weighted semaphore (`golang.org/x/sync/semaphore`) is the same idea expressed as a counter. Pick the one whose ergonomics fit your problem.

## 3. Internal Working

There is no special runtime support for "worker pools" — the pattern is built entirely from goroutines and channels, which *do* have deep runtime machinery. Understanding that machinery is what separates a working pool from a fast, correct one.

A channel is a runtime `hchan` struct on the heap. Its key fields:

```text
hchan
+----------------------------------------------------+
| qcount    : items currently in buffer              |
| dataqsiz  : buffer capacity (cap of the channel)   |
| buf       : pointer to circular ring buffer        |
| sendx     : next send index into ring              |
| recvx     : next recv index into ring              |
| sendq     : waitq of goroutines blocked on send    |
| recvq     : waitq of goroutines blocked on recv    |
| lock      : mutex guarding the whole struct        |
+----------------------------------------------------+
```

When W workers all execute `<-jobs` on an empty channel, each parks itself: the runtime creates a `sudog` (a wait record), enqueues it in `recvq`, and calls `gopark` to deschedule the goroutine off its OS thread (the M). No CPU is spent spinning.

When a producer sends a job, `chansend` takes the lock, finds a waiting receiver in `recvq`, and performs a **direct hand-off**: it copies the job straight into the parked worker's stack slot and calls `goready` to mark it runnable. The freed worker is placed on a P's run queue and picked up by the scheduler — often on a different OS thread. The data never touches the ring buffer in this hand-off path; that's why an *unbuffered* pool still works well.

```text
Producer(s)                 jobs chan (cap=N)              Workers (W goroutines)
  job ──send──►  [ ][ ][x][x][x][ ][ ]  ──recv──►  W1: process()
  job ──send──►       (ring buffer)     ──recv──►  W2: process()
  (blocks when         qcount==N        ──recv──►  W3: (parked in recvq)
   full → backpressure)
```

Memory layout matters: workers are persistent goroutines, so their stacks (growing/shrinking via the runtime's copy-stack mechanism) live for the pool's lifetime — you pay W stacks, not "jobs" stacks. The job struct itself, if passed by value, is copied into the ring buffer; if it contains large fields, prefer a pointer to avoid copying through the channel.

The scheduler's **work-stealing** runs underneath: each P has a local run queue of ready workers; idle Ps steal from busy ones, so workers naturally spread across cores up to `GOMAXPROCS`. This is why a CPU-bound pool rarely benefits from W much larger than `GOMAXPROCS` — extra workers just queue behind the same cores.

## 4. Syntax

The minimal skeleton — three channels of communication (jobs in, results out, a `WaitGroup` to know when workers finish):

```go
func worker(id int, jobs <-chan Job, results chan<- Result, wg *sync.WaitGroup) {
	defer wg.Done()
	for j := range jobs { // ranges until jobs is closed AND drained
		results <- process(j)
	}
}

func RunPool(numWorkers int, jobs []Job) []Result {
	jobCh := make(chan Job, numWorkers)       // buffer ~= worker count
	resultCh := make(chan Result, len(jobs))  // avoid result-side deadlock
	var wg sync.WaitGroup

	for i := 0; i < numWorkers; i++ {
		wg.Add(1)
		go worker(i, jobCh, resultCh, &wg)
	}

	go func() { // feed jobs, then signal "no more"
		for _, j := range jobs {
			jobCh <- j
		}
		close(jobCh) // workers' range loops will exit after draining
	}()

	go func() { // close results once all workers are done
		wg.Wait()
		close(resultCh)
	}()

	var out []Result
	for r := range resultCh {
		out = append(out, r)
	}
	return out
}
```

The three load-bearing rules: the **producer** closes `jobs` (the sender closes, never the receiver); a separate goroutine `wg.Wait()`s and closes `results`; the main goroutine drains `results` concurrently so workers never block on a full result channel.

## 5. Common Interview Questions

**Q1. Why not just `go process(job)` for every job?**
Unbounded concurrency. With millions of jobs you exhaust FDs, connection pools, memory, or downstream rate limits. A pool caps in-flight work to W.
*Follow-up: "How would you pick W?"* — For I/O-bound work, W is set by the downstream limit (pool size, rate cap), often ≫ `GOMAXPROCS`; benchmark for the knee of the latency/throughput curve. For CPU-bound work, W ≈ `GOMAXPROCS`.

**Q2. Who closes the jobs channel, and why does it matter?**
The producer (sender) closes it, exactly once, after sending the last job. Receivers must never close — sending on a closed channel panics, and a closed channel is the signal that lets workers' `for range` loops terminate. Closing from a receiver creates a race over "is it closed yet."

**Q3. How do you collect results without deadlocking?**
Drain the results channel in a separate goroutine (or the main one) *while* workers produce. If you wait for all workers before reading, and the results channel fills, workers block on send forever. Use a buffered results channel or a concurrent consumer.

**Q4. How do you cancel a worker pool early (e.g., on error or timeout)?**
Pass a `context.Context`; workers `select` on `<-ctx.Done()` alongside the job receive and the result send. Cancellation propagates everywhere via one `cancel()`.
*Follow-up: "What about the producer?"* — The producer must also `select` on `ctx.Done()` when sending, or it leaks blocked on a full channel after consumers stop.

**Q5. Worker pool vs. semaphore — when each?**
Use a pool when work is uniform and long-lived workers amortize setup (e.g., a reusable DB statement per worker). Use a `semaphore.Weighted` or buffered-channel token when you want one goroutine per job but a cap on concurrency, or when jobs have *different weights* (a 1 GB job costs more tokens than a 1 MB one).

**Q6. Your pool processes jobs but the program hangs at the end. Why?**
Classic causes: you forgot to `close(jobs)` (workers `range` forever); or you `wg.Wait()` before draining a full results channel; or results channel is never closed so the final `for range results` never ends.

**Q7. How do you preserve result ordering?**
Channels don't guarantee order across workers. Tag each job with an index, write results into a pre-sized slice at that index (no lock needed if indices are unique), or sort afterward.
*Follow-up:* For streaming order-preservation, use per-job result channels in an ordered queue (the "fan-out, ordered fan-in" pattern).

**Q8. How does a worker pool create backpressure?**
A bounded `jobs` channel: when it's full, producers block on send until a worker frees a slot. This naturally throttles a fast producer to the workers' service rate without any explicit rate logic.

## 6. Production Use Cases

- **Web crawlers** (Colly, custom scrapers): a fixed worker count limits concurrent outbound HTTP requests so you respect target sites and your own egress.
- **Image/video pipelines** (thumbnailing at Cloudinary-style services, FFmpeg batch jobs): CPU-bound transcoding capped at ~`GOMAXPROCS` workers.
- **Database batch writers / ETL**: bound concurrent writes to match the DB's connection pool (`db.SetMaxOpenConns(N)` paired with N workers) to avoid pool exhaustion.
- **Message-queue consumers** (Kafka, NSQ, RabbitMQ, AWS SQS): a pool of workers pulls from the partition/queue; the standard Sarama and `nsq` Go consumers expose a worker-count knob.
- **Kubernetes controllers / `client-go`**: the workqueue + N reconcile workers pattern is a worker pool over a rate-limited dedup queue — the literal heart of every operator.
- **Load/stress testing tools** (`vegeta`, `hey`, `k6`'s VU model): fixed "virtual users" are workers issuing requests at a bounded concurrency.
- **gRPC/HTTP fan-out gateways**: bound concurrent backend calls per request to protect downstreams.

## 7. Common Mistakes

> [!WARNING]
> The four deadlock/leak classics: (1) never closing `jobs`; (2) closing `jobs` from a worker; (3) waiting on the `WaitGroup` *before* draining results; (4) leaking the producer when consumers stop early.

- **Spawning one worker per CPU for I/O work.** If each job waits 50 ms on the network, 8 workers cap you at ~160 req/s; you may want hundreds of workers.
- **Sending pointers to a loop variable.** Pre-Go-1.22 `for i := range; go ... &i` aliased the same variable. Fixed in 1.22's per-iteration scoping, but still capture deliberately.
- **No context.** A pool with no cancellation path can't be shut down gracefully and leaks on timeout.
- **Unbounded results channel growth.** A `make(chan R, len(jobs))` with huge `len(jobs)` allocates a giant buffer; prefer streaming consumption.
- **Swallowing worker panics.** One job that panics kills its worker silently, shrinking the pool. Recover per job and turn panics into error results.

## 8. Performance Considerations

The sweet spot for W depends on the bottleneck:

| Workload type | Bottleneck | Good starting W |
|---|---|---|
| CPU-bound (hash, encode, compute) | cores | `GOMAXPROCS` |
| I/O-bound (HTTP, DB, disk) | downstream / latency | `(latency / service-time) × target-throughput`, often 50–500 |
| Mixed | both | benchmark; find the throughput knee |

Little's Law is your friend: *concurrency = throughput × latency*. To hit 1,000 req/s at 100 ms each you need ~100 workers in flight. Don't guess — measure with `go test -bench` and watch the throughput plateau (the "knee"), beyond which more workers only add contention.

Channel cost: each send/recv takes the `hchan` lock. At extreme throughput (tens of millions of tiny jobs/sec) that single lock becomes a contention point. Mitigations: **batch** jobs (send `[]Job` of 100 instead of single jobs — amortizes lock cost ~100×), use **per-worker channels** with a dispatcher, or switch to a lock-free queue. Buffer the job channel to `~W` so workers rarely park and producers rarely block.

> [!TIP]
> If `pprof` shows hot time in `runtime.chanrecv`/`chansend` and `runtime.lock`, your jobs are too small. Batch them.

## 9. Best Practices

- **Always plumb `context.Context`** through workers and the producer; cancel on first fatal error or timeout.
- **Sender closes the channel**, exactly once, after the last send.
- **Size the job buffer to ~W**; size or stream results to avoid giant allocations.
- **Recover per job** so one bad job can't shrink the pool: `func() { defer recover-to-error; process(j) }()`.
- **Return errors as data** (a `Result{Val, Err}` struct) rather than logging-and-dropping inside workers.
- **Make the worker function pure-ish**: take everything via the job or closure, avoid shared mutable state, or guard it.
- **Prefer `errgroup.WithContext` + `SetLimit(W)`** for the common "run these and stop on first error" case — it *is* a worker pool with first-error cancellation built in (Go 1.20+).

## 10. Code Examples

Primary: a context-aware pool that returns errors as data and cancels cleanly.

```go
package pool

import (
	"context"
	"sync"
)

type Job struct {
	Index int
	URL   string
}

type Result struct {
	Index int
	Body  []byte
	Err   error
}

func Crawl(ctx context.Context, workers int, jobs []Job,
	fetch func(context.Context, string) ([]byte, error)) []Result {

	jobCh := make(chan Job, workers)
	resCh := make(chan Result, workers)
	results := make([]Result, len(jobs))

	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobCh {
				body, err := fetch(ctx, j.URL)
				select {
				case resCh <- Result{Index: j.Index, Body: body, Err: err}:
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	go func() {
		defer close(jobCh)
		for _, j := range jobs {
			select {
			case jobCh <- j:
			case <-ctx.Done():
				return // stop feeding; workers drain & exit
			}
		}
	}()

	go func() { wg.Wait(); close(resCh) }()

	for r := range resCh {
		results[r.Index] = r // index write = order preserved, no lock
	}
	return results
}
```

The idiomatic modern alternative — `errgroup` collapses the boilerplate and gives first-error cancellation for free.

```go
package pool

import (
	"context"

	"golang.org/x/sync/errgroup"
)

// FetchAll runs all URLs with at most `limit` concurrent fetches,
// cancelling everything on the first error.
func FetchAll(ctx context.Context, limit int, urls []string,
	fetch func(context.Context, string) ([]byte, error)) ([][]byte, error) {

	g, ctx := errgroup.WithContext(ctx)
	g.SetLimit(limit) // <-- bounded concurrency, the whole pool in one line

	out := make([][]byte, len(urls))
	for i, u := range urls {
		i, u := i, u // (harmless on 1.22+, explicit for clarity)
		g.Go(func() error {
			b, err := fetch(ctx, u)
			if err != nil {
				return err // triggers ctx cancel for the rest
			}
			out[i] = b
			return nil
		})
	}
	if err := g.Wait(); err != nil {
		return nil, err
	}
	return out, nil
}
```

Use the explicit channel version when you need long-lived workers with per-worker state (a reusable buffer, prepared statement, or connection). Reach for `errgroup` for the common "fan out a slice, stop on error" case.

## 11. Advanced Concepts

**Dynamic / elastic pools.** Some systems scale W up under load and down when idle. This is rarely worth it in Go — goroutines are cheap, and a fixed pool sized to the bottleneck is simpler and more predictable. If you must, add workers that exit after an idle timeout, gated by an atomic counter.

**Weighted semaphores for heterogeneous jobs.** When jobs have wildly different costs, `semaphore.Weighted` lets a 500 MB job acquire 500 tokens and a 1 MB job acquire 1, capping *total resource* rather than *count*.

**Pipeline of pools (fan-out / fan-in).** Stages each with their own pool, connected by channels: parse → transform → write. Each stage's W is tuned independently. This is the structure of most stream processors.

**Priority pools.** Multiple input channels, workers `select` with a preference for the high-priority channel (a non-blocking high-priority drain before falling through to low-priority). `client-go`'s rate-limited workqueue is a sophisticated variant with dedup, delay, and backoff.

**Bounded pool over a *stream* (no known length).** Workers `for range` an open channel fed indefinitely by a producer; shutdown is driven purely by context + closing the source, not by a job count.

> [!NOTE]
> `errgroup.SetLimit(n)` is implemented as an internal token channel of capacity n — `g.Go` blocks on acquiring a token. It is, under the hood, exactly a bounded semaphore.

## 12. Debugging Tips

- **Hang at shutdown?** Take a goroutine dump: `kill -QUIT <pid>` or `pprof.Lookup("goroutine").WriteTo(os.Stderr, 2)`. Workers parked in `chanrecv` → you never closed `jobs`. A goroutine parked in `chansend` → results channel is full and nobody's draining.
- **Goroutine leak detection** in tests: `go.uber.org/goleak` (`defer goleak.VerifyNone(t)`) catches workers/producers that never exit.
- **Race detector:** run with `-race`; shared `results` slices written by index are safe (disjoint indices), but any shared map/counter without sync will flag.
- **Throughput stuck below expectation?** `go tool pprof` a CPU profile. Hot `runtime.chanrecv` = jobs too small (batch them). Workers idle while a queue backs up = too few workers or a serialized downstream lock.
- **Detect undersized pools** by instrumenting queue depth: export `len(jobCh)` as a metric; a chronically full job channel means producers are starved or workers can't keep up.

## 13. Senior Engineer Notes

As a senior engineer, your job is to make the *right concurrency choice* and stop the wrong ones in review. The most common review smell is `go funcCall()` in a loop with no bound — flag it every time and ask "what caps this?" Push for `errgroup.SetLimit` as the default; the hand-rolled channel pool is a code smell unless there's a concrete need for per-worker state.

Insist on three properties in any pool PR: a context cancellation path, errors returned as values (not logged-and-dropped), and per-job panic recovery so one poison job doesn't silently shrink the pool. Watch for the "WaitGroup before draining results" deadlock — it's the single most common bug and it often only manifests under load when the results buffer fills.

When mentoring, teach Little's Law explicitly: most engineers pick W by gut feel and pick wrong by 10×. Show juniors how to find the throughput knee with a benchmark rather than guessing. And teach them that the worker pool's *real* product is backpressure — the buffered channel that throttles the producer is doing the most valuable work in the system.

## 14. Staff Engineer Notes

At staff level the question shifts from "how do I write a pool" to "should this concurrency live in-process at all?" An in-process worker pool is bounded by *one box*. If the work is durable, retryable, or needs to survive deploys, the right answer is often an external queue (SQS, Kafka, Temporal, a Redis-backed jobs system like `asynq` or River) with horizontally-scaled consumer pods — each pod runs a small in-process pool, but the *real* concurrency control is the number of pods and the partition count. This is the build-vs-buy line: a 30-line errgroup is free; a durable distributed job system is months — choose based on whether losing in-flight work on a crash is acceptable.

Cross-team, the danger of worker pools is that everyone tunes W in isolation and collectively DDoSes a shared downstream. The fix is org-level: a shared, *server-enforced* concurrency/rate limit (a token service, an envoy/gateway limiter, or DB-side `max_connections`) so no single team's `W=1000` can take down the database. Bounded concurrency should be enforced at the resource, not trusted at every caller.

Think in terms of the whole system's Little's Law: total in-flight concurrency across all services must fit the narrowest downstream. Make queue depth, worker utilization, and rejection/backpressure events first-class SLO metrics. Finally, decide the **shedding policy** at the architecture level: when the queue is full, do you block (backpressure up the call chain), drop (load-shed), or spill to durable storage? That choice defines your system's behavior under overload, and it belongs in a design doc, not buried in a channel's buffer size.

## 15. Revision Summary

- A worker pool = fixed W goroutines `for range`-ing a shared job channel; bounds concurrency, provides a queue, creates backpressure.
- Built purely from goroutines + channels; channel hand-off parks/wakes workers via `sudog`/`recvq`, no busy-waiting.
- **Sender closes** the jobs channel, once. Drain results concurrently. Close results after `wg.Wait()`.
- Size W by bottleneck: CPU-bound ≈ `GOMAXPROCS`; I/O-bound via Little's Law (`concurrency = throughput × latency`), often hundreds.
- Always plumb `context`, recover per job, return errors as data, batch tiny jobs to beat channel-lock contention.
- Prefer `errgroup.WithContext` + `SetLimit(W)` for "fan out, stop on first error"; hand-roll only for per-worker state.
- Top bugs: forgot `close(jobs)`, wait-before-drain deadlock, leaked producer on early consumer exit, swallowed panics.
- Staff lens: in-process pool caps at one box — consider durable queues for retryable work; enforce concurrency at the shared resource, not per-caller.

**References:** Go Concurrency Patterns (Pike, golang.org/blog/pipelines); `sync`, `context`, `golang.org/x/sync/errgroup`, `golang.org/x/sync/semaphore`; *The Go Programming Language* (Donovan & Kernighan), ch. 8–9; `client-go` workqueue.

---
*Go Engineering Handbook — topic 35.*
