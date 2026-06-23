# 60 · High Throughput Systems

> **In one line:** Sustaining millions of ops/sec in Go means amortizing per-item cost with batching, removing contention with sharding, and protecting yourself with back-pressure.

---

## 1. Overview

A "high throughput system" is one whose design goal is *aggregate operations per second* — millions of messages, requests, writes, or events — rather than the latency of any single call. The two are related but pull in different directions: the techniques that maximize throughput (batching, queueing, buffering) almost always *add* latency to individual operations.

The three load-bearing ideas in this chapter are:

- **Batching** — pay a fixed per-operation cost (a syscall, a lock acquisition, a network round-trip, an `fsync`) once for *N* items instead of *N* times.
- **Sharding** — split state across independent partitions so that *P* goroutines/cores work without fighting over the same cache line, mutex, or channel.
- **Back-pressure** — a feedback signal that slows producers when consumers fall behind, so the system degrades gracefully instead of running out of memory and crashing.

Go is unusually well-suited to this work: cheap goroutines, channels as bounded queues, a low-pause garbage collector, and `sync/atomic` for lock-free coordination. But the runtime also has sharp edges — GC pressure, channel contention, false sharing — that bite hard at scale.

> [!NOTE]
> Throughput and latency are governed by **Little's Law**: `L = λ × W` (items-in-system = arrival-rate × time-in-system). You cannot raise throughput (λ) indefinitely without either growing concurrency (L) or shrinking per-item time (W). Every design decision below moves one of these levers.

---

## 2. Why It Exists

The naive concurrency model — one goroutine per request, each doing its own I/O — works beautifully up to a point and then collapses. The failure modes are predictable:

1. **Per-op fixed costs dominate.** A single `INSERT` round-trip to Postgres is ~0.5–2 ms of network + parse + plan + commit. At 1 M writes/sec that is impossible per-row; batched into a 1000-row `COPY` it is trivial. The fixed cost didn't change — you amortized it.
2. **Contention serializes you.** Ten thousand goroutines incrementing one `sync.Mutex`-guarded counter run *slower* than one goroutine, because the cache line ping-pongs between cores and goroutines park/unpark. Amdahl's Law caps your speedup at `1/serial_fraction`.
3. **Unbounded queues become OOM bombs.** A `chan T` with no bound, or a slice you keep appending to, will happily buffer faster than the consumer drains — until the process is killed. Back-pressure exists to make "slow down" a first-class signal instead of "crash."

These patterns exist because hardware reality (syscall cost, cache coherence traffic, finite RAM) does not change just because you wrote more goroutines. They are the standard production answers to "it worked in the demo, it died under load."

---

## 3. Internal Working

To design these systems you must understand what the Go runtime actually does underneath.

**Channels.** A `chan T` is an `hchan` struct: a ring buffer (`buf`), element size, send/recv indices, a `sendq`/`recvq` of waiting goroutines (`sudog` list), and a single `lock` (a `mutex`). Every send/recv on a *buffered* channel acquires that lock. So a channel is itself a contention point — a fan-in of 64 goroutines into one channel serializes on one lock. The buffer gives you a bounded queue *for free*, which is the cheapest back-pressure mechanism in the language: a full buffer blocks the sender.

**Goroutines & the scheduler.** The M:N scheduler maps G (goroutines) onto M (OS threads) via P (logical processors, `GOMAXPROCS`). Each P has a local run queue (256 slots) plus a global queue. Channel ops and `sync` primitives park goroutines into wait queues and hand off to the scheduler. Excessive blocking → constant park/unpark → scheduler overhead and lost cache locality.

**Cache lines & false sharing.** CPUs move memory in 64-byte cache lines. If two shards' counters sit in the same line, two cores writing them invalidate each other's caches on every write — *false sharing*. This is why sharded structures pad to 64 bytes.

**GC.** Go's concurrent tri-color mark-sweep is low-pause, but throughput systems generate enormous allocation rates. Each allocation is cheap, but collectively they drive GC frequency (governed by `GOGC` / `GOMEMLIMIT`) and steal CPU from your work. `sync.Pool` recycles objects per-P to cut this.

```text
 Producers                Bounded channel (hchan)             Consumers
 ┌────────┐   send→  ┌───────────────────────────┐   ←recv  ┌────────┐
 │  G1    │ ───────► │ lock | buf[ ][ ][x][x][x] │ ───────► │  W1    │
 │  G2    │ ───────► │ sendq: [G_blocked...]      │ ───────► │  W2    │  batch
 │  ...   │          │ recvq: []                  │          │  ...   │  flush
 └────────┘          └───────────────────────────┘          └────────┘
   full buffer ⇒ senders park  =  BACK-PRESSURE

 Sharding (remove the single lock):
   key ──hash%N──► shard[i] = { mu; data; _pad[64-...] }   // each shard own line
                   shard[0] shard[1] ... shard[N-1]        // cores don't collide
```

The whole game is: **batch at the consumer**, **shard the state**, **bound the queue**.

---

## 4. Syntax

The core building blocks are stdlib primitives, not special syntax:

```go
// Bounded queue = back-pressure for free.
ch := make(chan Item, 4096) // full buffer blocks senders

// Time-or-size batch flush with a ticker.
t := time.NewTicker(5 * time.Millisecond)
defer t.Stop()

// Atomic counters (Go 1.19+ typed atomics) — no mutex.
var processed atomic.Int64
processed.Add(1)

// Sharding by hash.
idx := fnvHash(key) % uint32(len(shards))

// Drop-on-full (load shedding) with non-blocking send.
select {
case ch <- item:
default: // queue full → shed
	dropped.Add(1)
}

// Object reuse to cut GC.
var bufPool = sync.Pool{New: func() any { return new(bytes.Buffer) }}
```

---

## 5. Common Interview Questions

**Q1. How do you raise the throughput of a service that writes one row per request to a database?**
*A:* Decouple request handling from writes with a bounded channel; a writer goroutine drains it and flushes batches via `COPY`/multi-row insert on a size *or* time trigger. Amortizes the commit/round-trip cost across hundreds of rows.
*Follow-up: what's the cost?* Added p99 latency (up to the flush interval) and weaker durability — an in-memory batch is lost on crash unless you ack only after flush.

**Q2. Two goroutines incrementing a shared counter is slow. Why, and how do you fix it?**
*A:* Cache-line contention/false sharing and lock ping-pong. Fix with per-shard (often per-P) counters padded to 64 bytes, summed on read; or `atomic.Int64` if a single counter is unavoidable.
*Follow-up: when is `atomic` itself the bottleneck?* When the write rate is so high the cache line still bounces — then you must shard, because atomics don't remove the coherence traffic, only the mutex.

**Q3. What is back-pressure and how do you implement it in Go?**
*A:* A signal that propagates "consumer is behind" back to producers. The idiomatic Go form is a *bounded* channel: a full buffer blocks the sender, naturally throttling it. Alternatives: semaphores (`golang.org/x/sync/semaphore`), token buckets, or returning HTTP 429.
*Follow-up: what if blocking is unacceptable?* Switch to load shedding — non-blocking `select` with a `default` that drops or 429s, trading completeness for stability.

**Q4. How do you choose a shard key?**
*A:* It must distribute load uniformly *and* keep related operations on the same shard (so per-shard state needs no cross-shard locking). Hash of a high-cardinality field. Beware hot keys (one celebrity user) that defeat uniformity.
*Follow-up: how to handle a hot shard?* Sub-shard the hot key, add a per-key cache, or use power-of-two-choices to spread it.

**Q5. Batching adds latency. How do you bound the worst case?**
*A:* Flush on `max(size, time)` — a ticker forces a flush even if the batch isn't full, capping added latency at the interval. Tune interval against throughput needs.
*Follow-up: how do you flush on shutdown?* Drain the channel and flush the partial batch in a `defer`/`context.Done()` path before exiting, or you lose the tail.

**Q6. Why might adding goroutines *decrease* throughput?**
*A:* Contention (Amdahl), scheduler overhead, GC pressure from more concurrent allocations, and cache thrashing. Past the contention point, more workers fight more.
*Follow-up: how do you find the right count?* Benchmark a sweep; for CPU-bound work start at `GOMAXPROCS`, for I/O-bound size to keep the downstream saturated without overwhelming it.

**Q7. How does `GOMEMLIMIT` help a high-throughput service?**
*A:* It sets a soft memory ceiling; the GC runs more aggressively as you approach it, trading CPU for staying under the limit — preventing OOM kills under bursty allocation, which `GOGC` alone can't guarantee.
*Follow-up: trade-off?* Near the limit, GC can consume large CPU fractions ("GC death spiral"); pair it with load shedding.

---

## 6. Production Use Cases

- **Kafka producers** (Sarama / `franz-go`): the client batches records per partition (`linger.ms`, `batch.size`) before a single produce request — classic time-or-size batching that takes LinkedIn-scale clusters to millions of msgs/sec.
- **Metrics & logging pipelines** (Prometheus remote-write, Datadog/StatsD agents, OpenTelemetry batch span processor): aggregate/batch then ship, with drop-on-full shedding so observability never takes down the app it observes.
- **Sharded in-memory stores:** the standard library's own `sync.Map` and `sync.Pool` shard internally; community `xsync.Map`, `bigcache`, and `groupcache` shard buckets to kill lock contention. Caches at scale (Discord, Cloudflare) are sharded by key.
- **Databases:** ClickHouse and Cassandra ingest fastest via large batched inserts; Postgres `COPY` over single-row `INSERT`.
- **Stream processors / ingestion:** Uber's and Cloudflare's pipelines, NATS JetStream consumers, and any "ingest firehose" service combine bounded queues, batch flush, and back-pressure as the default architecture.
- **API gateways / rate limiters:** token-bucket back-pressure (Envoy, Go `golang.org/x/time/rate`) shedding load with 429s.

---

## 7. Common Mistakes

> [!WARNING]
> The single most common production outage in this space is an **unbounded queue** — a `make(chan T)` used as a buffer with no size, or an ever-growing slice — that OOMs when the consumer stalls.

- **No flush-on-timeout.** Size-only batching stalls forever under low traffic; the last partial batch never ships.
- **Forgetting to flush on shutdown.** `ctx.Done()` fires, you `return`, and the in-flight batch is silently dropped.
- **Sharding without padding.** False sharing quietly negates the benefit; the code looks sharded but cores still collide on one cache line.
- **Choosing a low-cardinality shard key** (e.g., `country`), creating hot shards and idle ones.
- **Treating `atomic` as free** at extreme write rates — it still incurs cache-coherence traffic.
- **Batching that breaks durability/ordering** without telling callers — acking before the flush means data loss looks like success.
- **One giant channel as fan-in**, making the channel's internal lock the bottleneck you tried to escape.

---

## 8. Performance Considerations

| Lever | Helps | Hurts | Typical knob |
|---|---|---|---|
| Batch size ↑ | throughput, fewer syscalls/commits | latency, memory per batch | 100–10 000 items |
| Flush interval ↓ | latency | throughput (smaller batches) | 1–50 ms |
| Shard count ↑ | parallelism, less contention | memory, harder cross-shard ops | ≈ `GOMAXPROCS`..4× |
| Channel buffer ↑ | absorbs bursts | hides back-pressure, more RAM, more latency | bounded, modest |
| `GOGC` ↑ | less GC CPU | more memory | 100→200+ |
| `GOMEMLIMIT` | OOM safety | GC CPU near limit | ~80% of container RAM |
| `sync.Pool` | fewer allocs/GC | complexity, leaks if misused | per hot object |

Rules of thumb: measure **ops/sec, p50/p99/p999 latency, allocs/op, and GC %** together — optimizing one in isolation lies. Set `GOMAXPROCS` to your CPU quota (use `automaxprocs` in containers, or Go 1.25's quota-aware default). Profile with `pprof` (CPU + heap + block + mutex) before tuning a single number.

> [!TIP]
> A 64-byte cache-line pad turns a "sharded but still slow" structure into a linearly scaling one. Verify with `go test -bench` across `GOMAXPROCS=1,2,4,8` — true sharding scales near-linearly; false-shared code plateaus.

---

## 9. Best Practices

- **Bound everything.** Every queue, every worker pool, every in-flight set has an explicit cap. Unbounded = unowned.
- **Flush on `max(size, time)`**, always, and flush on shutdown via `context`.
- **Make back-pressure visible.** Export queue depth, drop counts, and flush latency as metrics; alert on sustained fullness.
- **Shard by a high-cardinality key; pad to 64 bytes.** Keep per-shard state self-contained to avoid cross-shard locks.
- **Decide the overflow policy explicitly:** block (back-pressure), drop (shed), or spill (disk). Don't let it be an accident.
- **Prefer the simplest primitive that works:** a buffered channel before a custom lock-free ring; `atomic` before a sharded counter; one writer goroutine before a lock.
- **Benchmark with realistic distributions** (hot keys, bursts), not uniform synthetic load.

---

## 10. Code Examples

Primary idiomatic example — a batching writer with time-or-size flush, back-pressure, and clean shutdown:

```go
package ingest

import (
	"context"
	"log"
	"sync/atomic"
	"time"
)

type Item struct{ Key, Val string }

type Batcher struct {
	in       chan Item
	maxBatch int
	maxWait  time.Duration
	flush    func(ctx context.Context, batch []Item) error
	dropped  atomic.Int64
}

func NewBatcher(buf, maxBatch int, maxWait time.Duration,
	flush func(context.Context, []Item) error) *Batcher {
	return &Batcher{
		in:       make(chan Item, buf), // bounded => back-pressure
		maxBatch: maxBatch,
		maxWait:  maxWait,
		flush:    flush,
	}
}

// Submit blocks when the buffer is full (back-pressure). Use TrySubmit to shed.
func (b *Batcher) Submit(it Item) { b.in <- it }

func (b *Batcher) TrySubmit(it Item) bool {
	select {
	case b.in <- it:
		return true
	default:
		b.dropped.Add(1) // load shedding
		return false
	}
}

func (b *Batcher) Run(ctx context.Context) {
	t := time.NewTicker(b.maxWait)
	defer t.Stop()
	batch := make([]Item, 0, b.maxBatch)

	doFlush := func() {
		if len(batch) == 0 {
			return
		}
		if err := b.flush(ctx, batch); err != nil {
			log.Printf("flush failed: %v", err)
		}
		batch = batch[:0] // reuse backing array (cut GC)
	}

	for {
		select {
		case it := <-b.in:
			batch = append(batch, it)
			if len(batch) >= b.maxBatch {
				doFlush()
			}
		case <-t.C:
			doFlush() // time trigger caps added latency
		case <-ctx.Done():
			// drain + final flush so we never lose the tail
			for {
				select {
				case it := <-b.in:
					batch = append(batch, it)
					if len(batch) >= b.maxBatch {
						doFlush()
					}
				default:
					doFlush()
					return
				}
			}
		}
	}
}
```

Alternative — a sharded counter that scales linearly by avoiding false sharing:

```go
package metrics

import (
	"hash/maphash"
	"sync/atomic"
)

type cacheLinePad struct {
	v atomic.Int64
	_ [56]byte // pad to 64B so shards never share a cache line
}

type ShardedCounter struct {
	shards []cacheLinePad
	seed   maphash.Seed
}

func NewShardedCounter(n int) *ShardedCounter {
	return &ShardedCounter{shards: make([]cacheLinePad, n), seed: maphash.MakeSeed()}
}

func (c *ShardedCounter) Inc(key string) {
	h := maphash.String(c.seed, key)
	c.shards[h%uint64(len(c.shards))].v.Add(1)
}

func (c *ShardedCounter) Total() int64 {
	var sum int64
	for i := range c.shards {
		sum += c.shards[i].v.Load()
	}
	return sum
}
```

For a production-grade bounded worker pool, `golang.org/x/sync/errgroup` with `SetLimit(n)` gives you concurrency-capped fan-out with error propagation in a few lines — prefer it over hand-rolled semaphores.

---

## 11. Advanced Concepts

- **Lock-free ring buffers (MPSC/SPSC).** When even a channel's lock is too expensive, a disruptor-style ring with atomic cursors (`atomic.Uint64` head/tail) gives the highest-throughput single-producer/consumer queues. Used in ultra-low-latency systems; hard to get memory-ordering right.
- **Sharded fan-out, not single fan-in.** Hash producers to *N* channels each with its own consumer; you parallelize the channel lock itself.
- **Adaptive batching.** Adjust batch size/interval based on observed downstream latency — bigger batches when the sink is fast, smaller when latency rises (AIMD-style control loop).
- **Coalescing / deduplication.** If many ops target the same key in a window, collapse them (last-write-wins, or sum) before flushing — turns N writes into 1.
- **Credit-based back-pressure (gRPC/HTTP/2 flow control).** Receivers grant credits; senders only transmit within their window — the protocol-level version of bounded queues, propagating pressure across the network.
- **`GOMEMLIMIT` + shedding as a control system.** Combine the soft memory limit with queue-depth-based 429s so the service self-stabilizes under overload instead of entering a GC death spiral.
- **NUMA / P-local sharding.** On large machines, sharding per-P (as `sync.Pool` does internally) keeps data near the core that touches it.

---

## 12. Debugging Tips

- **`pprof` mutex & block profiles:** `runtime.SetMutexProfileFraction(1)` and `runtime.SetBlockProfileRate(1)`, then inspect — a single hot mutex or channel screams "shard me."
- **`GODEBUG=gctrace=1`** prints every GC: frequency and pause. High frequency under load → allocation problem; reach for `sync.Pool` or fewer allocations.
- **`GODEBUG=schedtrace=1000,scheddetail=1`** shows run-queue depths and idle Ps — uneven queues reveal a sharding imbalance.
- **`go test -bench . -benchmem -cpu=1,2,4,8`** — if ops/sec doesn't scale with `-cpu`, you have contention or false sharing. Add padding and re-run.
- **Export queue depth as a gauge.** A queue always near full = back-pressure is firing (good) or you're under-provisioned (act). Always empty = batching may be pointless.
- **`go tool trace`** visualizes scheduler latency, GC, and goroutine blocking on a timeline — the best tool for "where did my throughput go."
- **Watch RSS, not just heap.** `GOMEMLIMIT` and fragmentation matter; correlate with drop counts.

---

## 13. Senior Engineer Notes

As a senior engineer your judgment shows in restraint and correctness:

- **Reach for the simplest mechanism first.** A buffered channel *is* back-pressure; you rarely need a custom lock-free queue. In code review, push back on hand-rolled ring buffers unless a benchmark proves the channel is the bottleneck.
- **Demand the overflow policy in design docs.** "What happens when the queue is full?" is the question that separates a robust design from a future incident. Block, drop, or spill — never "we didn't think about it."
- **Insist on flush-on-shutdown and flush-on-timeout in every batcher review.** These are the two bugs that always slip through; treat them as a checklist item.
- **Make people prove sharding with a `-cpu` sweep benchmark.** "I sharded it" without a scaling graph usually hides false sharing.
- **Mentor on the latency/throughput/durability trade-off explicitly.** Junior engineers add batching for throughput and don't realize they just weakened durability and added p99 latency. Make the trade-off conscious and documented.
- **Tie every knob to a metric.** No magic numbers; batch size and intervals should be config-driven and observable.

---

## 14. Staff Engineer Notes

At staff level the questions are architectural and organizational:

- **Build vs. buy.** Before building a bespoke ingestion pipeline, ask whether Kafka, NATS JetStream, Pulsar, or a managed queue (SQS, Pub/Sub, Kinesis) already solves batching + back-pressure + durability with operational maturity you'd otherwise reinvent. In-process batching is for the *last mile*; the firehose itself usually belongs in a broker.
- **Back-pressure must be end-to-end.** A bounded queue in one service is useless if the upstream ignores 429s and retries instantly (retry storms). Drive an org-wide standard: bounded queues + 429 + exponential backoff + jitter + circuit breakers, propagated across service boundaries (gRPC flow control, load shedding at the edge).
- **Define SLOs that name the trade-off.** "p99 < 50 ms at 1 M ops/sec, may shed above 1.2 M" is a staff-level contract. It tells every downstream team what to expect under overload and authorizes load shedding instead of cascading failure.
- **Capacity & cost model.** Throughput targets have a dollar figure: more shards/replicas vs. larger batches vs. accepting higher latency. Staff engineers own that trade curve and present it to leadership.
- **Failure-domain design.** Sharding is also a blast-radius tool — one hot/poisoned shard shouldn't take down the rest. Push for shard isolation, per-shard rate limits, and graceful degradation as cross-cutting platform concerns.
- **Standardize the primitives.** A shared, well-tested batcher/sharded-cache library beats ten team-local copies, each with the same flush-on-shutdown bug. Own the platform abstraction.

---

## 15. Revision Summary

- **Throughput ≠ latency.** Batching/queueing raise throughput but add latency; Little's Law (`L = λW`) governs the trade.
- **Batching** amortizes fixed per-op cost; always flush on `max(size, time)` *and* on shutdown.
- **Sharding** removes contention; choose a high-cardinality key and **pad to 64 bytes** to defeat false sharing. Verify with a `-cpu` benchmark sweep.
- **Back-pressure** = bounded queues (a full buffered channel blocks senders). When blocking is unacceptable, **shed load** (non-blocking `select` + `default`, or 429).
- **Channels have an internal lock** — a single fan-in channel can itself be the bottleneck; shard the channels too.
- **GC matters at scale:** use `sync.Pool`, set `GOMEMLIMIT`, tune `GOGC`, watch `gctrace`.
- **Atomics aren't free** at extreme write rates — coherence traffic remains; shard instead.
- **Make it observable:** queue depth, drop count, flush latency, p99/p999.
- **Staff lens:** prefer a broker for the firehose; enforce end-to-end back-pressure and SLOs that authorize shedding.

**References:** Production engineering practice; Go runtime (`hchan`, scheduler, GC) internals; `golang.org/x/sync` (`errgroup`, `semaphore`); `runtime/pprof` and `go tool trace`; Little's Law and Amdahl's Law; Kafka/`franz-go`, NATS JetStream, OpenTelemetry batch processors.

---

*Go Engineering Handbook — topic 60.*
