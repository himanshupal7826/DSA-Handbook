# 33 · Buffered Channels

> **In one line:** A buffered channel is a typed, thread-safe FIFO ring buffer of fixed capacity that lets senders proceed without a waiting receiver—until the buffer fills, at which point it becomes back-pressure.

---

## 1. Overview

A *buffered channel* is created with `make(chan T, capacity)` where `capacity > 0`. Unlike an unbuffered channel (capacity 0), which forces a *rendezvous*—a send blocks until a receiver is ready and vice versa—a buffered channel decouples sender and receiver in time. A send succeeds immediately as long as there is room in the buffer; a receive succeeds immediately as long as the buffer is non-empty.

The capacity is the maximum number of elements the channel can hold *without a corresponding receiver*. This single number is one of the most important knobs in a Go concurrent system: it sets the depth of the queue between producers and consumers, and therefore controls **back-pressure**, latency, and memory footprint.

Think of it as a bounded mailbox. Senders drop letters in; receivers pick them up. If the mailbox is full, the next sender waits at the door (blocks). If it is empty, the next receiver waits. That bounded-ness is the whole point: it is a queue you cannot accidentally grow without limit.

> [!NOTE]
> Buffering changes *when* goroutines block, never *whether* the channel is safe. Both buffered and unbuffered channels are fully synchronized by the runtime.

---

## 2. Why It Exists

Unbuffered channels are perfect for handoff and synchronization, but they couple the two parties tightly: every send pays the full cost of waiting for a receiver. Buffered channels exist to solve three concrete problems:

1. **Absorb bursts.** Producers and consumers rarely run at exactly the same instantaneous rate. A small buffer smooths jitter so a producer doesn't stall on every transient slow-down in the consumer.
2. **Bound resource usage (back-pressure).** The crucial design property is the *bound*. An unbuffered-plus-goroutine-per-task pattern can spawn unbounded goroutines; a buffered channel of capacity N caps in-flight work at N. When full, sends block, which propagates pressure upstream to the producer—exactly what you want instead of running out of memory.
3. **Express a semaphore/quota.** A buffered channel of capacity N is the canonical counting semaphore: N tokens, acquire by sending, release by receiving.

The key mental shift: an unbounded queue (e.g., an ever-growing slice protected by a mutex) hides overload until OOM. A bounded buffer *converts overload into blocking*, which is observable, recoverable, and self-regulating.

---

## 3. Internal Working

A channel value is a pointer to a runtime `hchan` struct (defined in `runtime/chan.go`). For a buffered channel, the element storage is a **circular ring buffer** allocated contiguously right after the struct.

```text
hchan (heap-allocated):
+------------------+
| qcount    uint   |  # elements currently in buffer
| dataqsiz  uint   |  # capacity (ring size)
| buf       ptr ---+----> [ e0 | e1 | e2 | e3 ]   <- contiguous array, dataqsiz slots
| elemsize  uint16 |          ^send       ^recv
| closed    uint32 |        sendx=2      recvx=1   (indices into ring)
| elemtype  *type  |
| sendx     uint   |  # next slot to write
| recvx     uint   |  # next slot to read
| recvq     waitq  |  # FIFO of blocked receivers (sudog list)
| sendq     waitq  |  # FIFO of blocked senders (sudog list)
| lock      mutex  |  # guards every field above
+------------------+
```

Every operation takes `hchan.lock` (a runtime mutex, not `sync.Mutex`). The flow for a **send** on a buffered channel:

1. Lock. If `closed`, panic.
2. If a receiver is already waiting (`recvq` non-empty), hand the element *directly* to it, bypassing the buffer entirely, and wake it.
3. Else if `qcount < dataqsiz` (room available), copy the element into `buf[sendx]`, advance `sendx = (sendx+1) % dataqsiz`, increment `qcount`, unlock. **No blocking.**
4. Else (buffer full): wrap the goroutine in a `sudog`, enqueue on `sendq`, unlock, and call `gopark` to deschedule. A later receiver will copy the element out, dequeue the `sudog`, and `goready` the sender.

A **receive** is symmetric: prefer a direct handoff from a blocked sender; else pop from `buf[recvx]`; else park on `recvq`.

> [!NOTE]
> When the buffer is full and senders are queued, a receiver does two things atomically: it takes `buf[recvx]` for itself *and* moves the head sender's value into the freed slot, then advances both indices. This keeps strict FIFO ordering across the ring and the wait queue.

Memory layout matters: `make(chan int, 4)` is a single allocation holding the `hchan` plus a 4-slot `int` array. `elemsize` larger than the word size means values are *copied* in and out by `memmove`—a buffered channel of large structs copies the whole struct twice (in and out). The lock makes channel ops cost a few tens of nanoseconds even uncontended; this is why channels are not free.

---

## 4. Syntax

```go
ch := make(chan int, 8) // buffered, capacity 8

ch <- 42        // send: blocks only if buffer full AND no waiting receiver
x := <-ch       // receive: blocks only if buffer empty AND no waiting sender
x, ok := <-ch   // ok == false once channel is closed AND drained

len(ch)         // current number of buffered elements (qcount)
cap(ch)         // capacity (dataqsiz); 0 for unbuffered

close(ch)       // no more sends; receivers drain remaining, then get zero value

// Non-blocking send/receive via select:
select {
case ch <- v:
    // sent
default:
    // buffer full — dropped or handled elsewhere
}

// Range drains until closed:
for v := range ch {
    _ = v
}
```

> [!WARNING]
> `len(ch)` and `cap(ch)` are racy by nature—the value can change the instant after you read it. Use them for metrics/heuristics, never for correctness logic like "if len==cap then...".

---

## 5. Common Interview Questions

**Q1. What is the difference between a buffered and unbuffered channel?**
Unbuffered (cap 0) requires a rendezvous: send and receive complete together; the send is a synchronization point. Buffered (cap > 0) lets a send complete without a receiver while there is room. *Follow-up: does a buffered channel of capacity 1 ever behave like unbuffered?* Only when it is already full—then the next send blocks like a rendezvous, but the timing/ordering guarantees differ (the value is staged in the buffer first).

**Q2. Does buffering guarantee asynchrony?**
No. It only guarantees the send won't block *while there is free space*. Under sustained load the buffer saturates and sends block, giving back-pressure. *Follow-up: so what does capacity actually buy you?* Burst absorption and a hard bound on in-flight items—not unconditional non-blocking.

**Q3. What does `len(ch)` return versus `cap(ch)`?**
`len` is the number of elements currently buffered; `cap` is the fixed capacity. *Follow-up: can `len(ch) > 0` and a receive still block?* No—if `len>0` a receive returns immediately (the lock serializes it). But by the time your `if` runs, another goroutine may have drained it; the value is advisory.

**Q4. How do you implement a counting semaphore with N permits?**
`sem := make(chan struct{}, N)`. Acquire: `sem <- struct{}{}`. Release: `<-sem`. The buffer bounds concurrency to N. *Follow-up: why `struct{}` over `bool`?* Zero-width type—no per-element memory, signals intent that the value is irrelevant.

**Q5. What happens on send to / receive from / close of a full or closed channel?**
Send to closed: panic. Receive from closed: drains buffered values first, then returns zero value with `ok==false`. Send to full open channel: blocks. *Follow-up: who should close a channel?* The sender (or the sole/last sender), never a receiver—closing while another goroutine may still send causes a panic.

**Q6. Is reading `len(ch)` to decide whether to send safe?**
No—classic TOCTOU race. Use a `select` with `default` for a non-blocking send instead. *Follow-up: how do you load-shed when full?* `select { case ch <- v: default: metrics.dropped++ }`.

**Q7. How does capacity affect memory?**
The ring buffer for capacity N elements of size S is allocated up front: roughly `N*S` bytes plus the `hchan` header. A `chan [4096]byte` with cap 1000 reserves ~4 MB immediately. *Follow-up: how to avoid that for large payloads?* Buffer pointers (`chan *Payload`), not values.

**Q8. Can a buffered channel deadlock?**
Yes—if the buffer fills and no receiver ever runs (e.g., all consumers exited, or a single goroutine sends N+1 to its own channel). *Follow-up: how does the runtime detect it?* If *all* goroutines are blocked, the scheduler reports `fatal error: all goroutines are asleep - deadlock!`; a partial deadlock (some goroutines spinning) is *not* detected.

---

## 6. Production Use Cases

- **Worker pools / job queues.** A `jobs chan Job` of capacity 100 feeds a fixed set of worker goroutines. The buffer absorbs producer bursts; when full, the producer blocks—natural back-pressure. This is the backbone of ingestion pipelines at scale.
- **Bounded concurrency (semaphore).** `golang.org/x/sync/semaphore` exists, but the idiomatic `chan struct{}` token bucket is everywhere—limiting concurrent outbound HTTP calls, DB connections, or file handles.
- **Log/metrics buffering.** Libraries like Uber's **zap** and the Prometheus client batch via buffered channels: the hot path does a non-blocking send into a buffer, a background goroutine flushes. On overload they drop (sampling) rather than block the request path.
- **Event/telemetry pipelines.** **Kafka** Go producers (`confluent-kafka-go`, `sarama`) expose a buffered delivery channel; the async producer accumulates and batches.
- **Pipeline stages (e.g. `nsq`, ETL services).** Multi-stage `source -> stage1 -> stage2 -> sink` pipelines use buffered channels between stages so a slow stage applies back-pressure upstream without a global lock.
- **Fan-out/fan-in.** Buffered result channels collect outputs from many workers, sized to the worker count to avoid each worker blocking on its final send.
- **Rate limiting / token buckets.** A buffered channel periodically refilled by a ticker is a simple dependency-free rate limiter.

---

## 7. Common Mistakes

- **Treating capacity as "make it asynchronous forever."** It only delays blocking. Oversizing hides back-pressure and lets latency balloon silently while the buffer fills.
- **Using `len(ch)`/`cap(ch)` for control flow.** Racy. By the time you act, the count changed.
- **Closing from the receiver, or closing twice.** Both panic. The sender owns close.
- **Sending after close.** Panic. Common in fan-in when one producer closes while others still send—use `sync.WaitGroup` to close only after all senders finish.
- **Buffering large value types.** `chan [N]big` copies the whole array twice and pre-allocates the ring; use pointers.
- **Goroutine leaks via full buffers.** A goroutine blocked on a full channel whose consumer exited never returns—leaks forever. Always pair with `context` cancellation in a `select`.
- **Assuming ordering across multiple senders.** FIFO holds *within* the channel, but interleaving of concurrent senders is nondeterministic.

> [!WARNING]
> `make(chan T)` (no capacity) is **unbuffered**, not "capacity 1." A surprising number of bugs come from expecting buffering that isn't there.

---

## 8. Performance Considerations

Each channel op is a locked critical section: expect **~30–100 ns** per send/receive uncontended on modern hardware, rising sharply under contention because every goroutine fights for `hchan.lock`. A buffered channel is *not* a lock-free queue.

Capacity sizing trade-offs:

| Capacity | Effect |
|----------|--------|
| 0 (unbuffered) | Strict handoff, lowest memory, highest sync overhead per item |
| Small (1–N workers) | Absorbs jitter, preserves tight back-pressure, low latency |
| Large (thousands) | Absorbs big bursts, but hides overload, grows latency & memory |
| Unbounded (don't) | Not possible with channels; that's the point |

Rules of thumb:
- Size buffers to the **number of consumers** or one burst's worth, not to "as large as possible."
- For high-throughput hot paths, **batching** (one channel op per N items via a slice) amortizes the lock cost far better than a bigger buffer.
- A full or empty buffer means every op pays the *parking* cost (gopark/goready ≈ microseconds), which dwarfs the fast-path lock cost. Steady-state, you want the buffer *partially* full.
- Profile with `go test -bench` and `runtime/trace`; channel contention shows up clearly as goroutines blocked in `chansend`/`chanrecv`.

> [!TIP]
> If channel ops dominate your CPU profile, the answer is usually *fewer, bigger messages* (batching) or *sharding* the channel across cores—not a bigger buffer.

---

## 9. Best Practices

- **Make capacity a deliberate, documented decision.** Comment *why* the number is what it is (e.g., `// = worker count; one in-flight job per worker`).
- **Sender closes, receiver ranges.** Establish clear ownership; use `WaitGroup` for multi-sender close.
- **Always combine with `context`/`done` in `select`** so blocked sends/receives can be cancelled—prevents leaks.
- **Use non-blocking `select` + `default` to load-shed** when dropping is acceptable (telemetry, metrics).
- **Buffer pointers or small values**, not large structs.
- **Prefer `chan struct{}` for signaling/semaphores.**
- **Treat back-pressure as a feature.** If full buffers hurt, fix the consumer or shed load—don't just enlarge the buffer.
- **Expose `len(ch)` as a metric**, never as logic.

---

## 10. Code Examples

Primary: a bounded worker pool with explicit back-pressure and graceful shutdown.

```go
package main

import (
	"context"
	"fmt"
	"sync"
	"time"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()

	const workers = 4
	jobs := make(chan int, workers)    // back-pressure bounded to worker count
	results := make(chan int, workers) // avoid workers blocking on final send

	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs { // drains until jobs is closed
				select {
				case results <- j * j:
				case <-ctx.Done():
					return
				}
			}
		}()
	}

	// Producer: blocks when buffer full => natural back-pressure.
	go func() {
		defer close(jobs) // sender owns close
		for i := 1; i <= 10; i++ {
			select {
			case jobs <- i:
			case <-ctx.Done():
				return
			}
		}
	}()

	// Close results only after all workers exit.
	go func() { wg.Wait(); close(results) }()

	sum := 0
	for r := range results {
		sum += r
	}
	fmt.Println("sum of squares:", sum)
}
```

Alternative: a counting semaphore that caps concurrency without a pool.

```go
package main

import (
	"fmt"
	"sync"
)

func main() {
	const maxConcurrent = 3
	sem := make(chan struct{}, maxConcurrent) // N permits
	var wg sync.WaitGroup

	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			sem <- struct{}{}        // acquire (blocks if 3 in flight)
			defer func() { <-sem }() // release
			fmt.Println("working", id)
		}(i)
	}
	wg.Wait()
}
```

A non-blocking load-shedding send—useful on a latency-critical hot path where dropping beats blocking:

```go
func emit(ch chan<- Event, e Event) (dropped bool) {
	select {
	case ch <- e:
		return false
	default:
		return true // buffer full: shed load instead of blocking the caller
	}
}
```

---

## 11. Advanced Concepts

**Direct handoff bypass.** When a receiver is already parked, a send copies straight into the receiver's stack slot and skips the ring buffer entirely. So a "buffered" channel often behaves unbuffered under balanced load—the buffer only engages during imbalance.

**Channel of channels for request/reply.** Send a `struct{ req R; reply chan T }` into a buffered work channel; the worker replies on the embedded channel. Buffering the outer channel bounds queued requests; the reply channel is typically capacity 1.

**Dynamic/elastic buffering.** Channels have fixed capacity. To approximate elasticity, front a small buffered channel with a goroutine holding an internal slice that grows/shrinks—but you reintroduce unboundedness, so add a hard cap. This is what bounded "ring buffer with overwrite" libraries do (drop oldest on overflow), trading completeness for liveness.

**`nil` channels in `select`.** Setting a channel variable to `nil` disables its `case` (blocks forever). A powerful trick: toggle a send-case off by nilling the channel once the buffer is "logically full" per your own policy, re-enabling later.

**Buffered close + drain semantics.** `close` does not discard buffered values—receivers still get every staged element, then the zero/`!ok`. This makes `close` a clean "no more input" signal for `range`.

> [!TIP]
> The Go spec's *Channels* section is the authority on close/receive/send ordering—when in doubt about a corner case, read it rather than guess.

---

## 12. Debugging Tips

- **`fatal error: all goroutines are asleep - deadlock!`** means every goroutine is blocked—often a full buffer with no live consumer, or a missing `close`. The trace shows each goroutine's blocking site (`chansend`/`chanrecv`).
- **Goroutine leaks:** the `pprof` goroutine profile (`/debug/pprof/goroutine?debug=2`) lists goroutines stuck in `runtime.chansend`/`chanrecv`. Growing counts over time = leak, usually a full channel after consumer exit.
- **Latency creep with no CPU rise:** suspect a saturated buffer adding queueing delay. Instrument `len(ch)` as a gauge; a buffer pinned at `cap` is your smoking gun.
- **`runtime/trace`** (`go tool trace`) visualizes goroutine blocking on channels and scheduler latency—the best tool for "where is time going."
- **Race detector (`-race`)** won't flag channel ops themselves (they're synchronized) but catches data shared *around* channels.
- **Reproduce send-on-closed panics** by adding `defer` recovery with logging at send sites during development to find the offending owner.

---

## 13. Senior Engineer Notes

As a senior engineer, your job is sound judgement at the code/design level. Treat *capacity as an API contract*: in review, reject any `make(chan T, N)` where `N` is a magic number without a comment explaining the rationale (worker count? burst size? semaphore permits?). A buffer size is a back-pressure policy, and policies must be intentional.

Insist on **ownership clarity**: who sends, who closes, who cancels. Most channel bugs are ownership bugs, not concurrency-primitive bugs. In reviews, look for the trio: a `select` that includes `ctx.Done()` on every blocking op, a single well-defined closer, and a `WaitGroup` when multiple senders exist.

When mentoring, debunk the two pervasive myths: "bigger buffer = faster" (it usually just hides overload and raises tail latency) and "buffered = asynchronous" (only until full). Teach juniors to *want* back-pressure. Push for batching over buffer-inflation when channel ops show up hot in profiles. And know when *not* to reach for a channel: a simple counter or `sync.Mutex`-guarded structure is often clearer and faster than a channel-based "elegant" solution.

---

## 14. Staff Engineer Notes

At staff level the channel is an implementation detail; the real artifact is the **flow-control architecture** across services. Buffered channels give you *intra-process* back-pressure, but pressure must propagate end-to-end. A full internal buffer that blocks an HTTP handler is only useful if that blocking surfaces as a 429/503 or a slowed read from upstream Kafka/SQS—otherwise you've just moved the queue, and unbounded queues elsewhere (the kernel socket buffer, the load balancer, the client) will OOM or time out instead. Design where pressure is *allowed* to accumulate and where it must be *rejected*.

Make build-vs-buy calls deliberately. For in-process pipelines, hand-rolled buffered channels are right. The moment you need durability, cross-process delivery, replay, or backlog beyond memory, a channel is the wrong tool—reach for Kafka, NATS, Redis Streams, or a real queue. I have seen teams reinvent a durable broker with channels and a database; it never ends well.

Standardize patterns org-wide: a shared `workerpool`/`semaphore` package with metrics (queue depth, drop count, wait time) baked in, so every team's back-pressure is observable and tuned consistently rather than each service hard-coding a different magic capacity. Capacity numbers should be capacity-planned (derived from p99 service time × target concurrency), load-tested, and treated as SLO inputs—not folklore. Finally, weigh the cost of getting it wrong: an undersized buffer throttles throughput; an oversized one trades memory and tail latency for a false sense of headroom. Both are visible only if you instrument depth and wait time from day one.

---

## 15. Revision Summary

- `make(chan T, n)` with `n>0` = buffered = bounded FIFO **ring buffer**; send blocks only when full, receive only when empty.
- Capacity decouples sender/receiver in time and provides **back-pressure** when saturated—the whole value proposition.
- Runtime `hchan`: lock + ring buffer (`buf`, `sendx`, `recvx`, `qcount`, `dataqsiz`) + `sendq`/`recvq` wait queues; ops are locked, ~30–100 ns; values copied by `memmove`.
- Direct handoff to a waiting receiver bypasses the buffer.
- `len`/`cap` are advisory/racy—never use for control flow; use `select`+`default` for non-blocking.
- Sender owns `close`; closing a buffered channel still drains staged values; send-on-closed/close-twice = panic.
- Idioms: bounded worker pool, `chan struct{}` semaphore, load-shedding non-blocking send.
- Don't oversize buffers (hides overload, raises tail latency); prefer batching; combine with `context` to avoid leaks.
- Staff lens: propagate back-pressure end-to-end; channels are in-process only—use a real broker for durability.

**References:** Go spec: Channels (close/send/receive semantics); `runtime/chan.go` (`hchan`, ring buffer, `chansend`/`chanrecv`); `go tool trace`, `pprof` goroutine profile.

---

*Go Engineering Handbook — topic 33.*
