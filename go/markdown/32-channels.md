# 32 · Channels

> **In one line:** Channels are typed, synchronizing conduits that let goroutines communicate and coordinate by passing values instead of sharing memory.

---

## 1. Overview

A **channel** is Go's primitive for communication between goroutines. It is a typed conduit: a `chan int` carries only `int` values, a `chan struct{}` carries only signals. The slogan from the Go blog — *"Do not communicate by sharing memory; instead, share memory by communicating"* — captures the philosophy. Instead of guarding shared state with mutexes, you hand ownership of data from one goroutine to another through a channel, and the channel's synchronization guarantees do the locking for you.

Channels support three operations: **send** (`ch <- v`), **receive** (`v := <-ch`), and **close** (`close(ch)`). They come in two flavors: **unbuffered** (capacity 0, where a send blocks until a receiver is ready — a rendezvous) and **buffered** (capacity N, where sends block only when the buffer is full). Add the special case of the **nil channel** (a `var ch chan int` that was never made), whose sends and receives block *forever*, and you have the full surface area.

Channels are not just a data structure — they participate in `select`, they establish *happens-before* relationships in the memory model, and they are the backbone of nearly every idiomatic concurrency pattern in Go.

## 2. Why It Exists

Concurrency primitives in most languages center on locks, condition variables, and shared memory. These are powerful but error-prone: lost wakeups, deadlocks from lock ordering, data races from a forgotten `Lock()`. Go's designers, drawing on Hoare's CSP (Communicating Sequential Processes), chose a different default: make communication the synchronization mechanism.

Channels exist to answer questions like:

- *How do I safely pass a result from a worker goroutine back to the caller?*
- *How do I signal "I'm done" or "please stop" without a shared boolean and a mutex?*
- *How do I fan work out to a pool and fan results back in?*

The payoff is that ownership of data is explicit. When you send a value on a channel, you are conceptually transferring it; the sender should stop touching it. This turns a class of concurrency bugs into compile-time-or-design-time concerns rather than runtime races. Channels don't *replace* mutexes — a high-frequency counter is still better as a `sync/atomic` or mutex-guarded field — but they make the common coordination patterns declarative and composable, especially via `select`.

## 3. Internal Working

A channel value is a pointer to a runtime struct called `hchan` (defined in `runtime/chan.go`). When you write `make(chan int, 4)`, the runtime allocates one `hchan` plus a contiguous ring buffer for the four elements.

```text
        ch (chan int)  ──►  ┌──────────────── hchan ────────────────┐
                            │ qcount    uint     // # in buffer      │
                            │ dataqsiz  uint     // capacity (4)     │
                            │ buf       ──────────────┐ ring buffer  │
                            │ elemsize  uint16        │              │
                            │ closed    uint32        │              │
                            │ sendx     uint   // 2   │              │
                            │ recvx     uint   // 0   │              │
                            │ recvq     waitq{}  // blocked receivers│
                            │ sendq     waitq{}  // blocked senders  │
                            │ lock      mutex                        │
                            └─────────────────────────┼──────────────┘
                                                      ▼
                              buf:  [ e0 ][ e1 ][    ][    ]
                                     recvx↑       ↑sendx   (wraps mod 4)
```

Key fields:

- **`buf`** is the ring buffer for buffered channels; `sendx`/`recvx` are the head/tail indices that wrap modulo `dataqsiz`.
- **`recvq` / `sendq`** are FIFO queues of `sudog` structs — each represents a goroutine parked waiting to receive or send, along with a pointer to its stack slot for the value.
- **`lock`** is a runtime mutex; every channel op takes it briefly. Channels are *not* lock-free.

**Send path** (`chansend`): take the lock. If `closed`, panic. If a receiver is waiting in `recvq`, hand the value *directly* to that goroutine's stack (skipping the buffer entirely) and wake it — this is the fast, zero-copy-to-buffer path. Else if buffer space exists, copy into `buf[sendx]`, advance `sendx`, increment `qcount`. Else, the sender wraps itself in a `sudog`, enqueues on `sendq`, and calls `gopark` to deschedule until a receiver wakes it.

**Receive path** (`chanrecv`) is symmetric: if a sender waits in `sendq`, copy from it (and, for buffered channels, also rotate the buffer to preserve FIFO order); else dequeue from `buf`; else park on `recvq`.

**Close** (`closechan`) sets `closed = 1` and wakes *every* goroutine in both `recvq` and `sendq`. Woken receivers get the zero value with `ok == false`; woken senders panic. This is why close is a broadcast — it's the cheapest one-to-many signal in Go.

> [!NOTE]
> Unbuffered channels have `dataqsiz == 0`, so `buf` is empty; every operation must rendezvous via the wait queues. This is what makes an unbuffered send/receive a synchronization point.

## 4. Syntax

```go
// Creation
unbuffered := make(chan int)        // capacity 0, rendezvous
buffered := make(chan int, 8)       // capacity 8
var nilCh chan int                  // nil: blocks forever

// Send / receive
ch <- 42                            // send (may block)
v := <-ch                           // receive
v, ok := <-ch                       // ok == false if closed & drained

// Close (only the sender should close)
close(ch)

// Range drains until closed
for v := range ch {
    use(v)
}

// Directional types (compile-time enforced)
func producer(out chan<- int) {}    // send-only
func consumer(in <-chan int) {}     // receive-only

// select multiplexes
select {
case v := <-ch1:
    handle(v)
case ch2 <- x:
    // sent
case <-time.After(time.Second):
    // timeout
default:
    // non-blocking fallback
}
```

## 5. Common Interview Questions

**Q1. What is the difference between a buffered and an unbuffered channel?**
An unbuffered channel (cap 0) forces a rendezvous: the send completes only when a receiver is ready, so it doubles as a synchronization guarantee. A buffered channel decouples sender and receiver up to its capacity; a send blocks only when the buffer is full.
*Follow-up: When would you choose buffered?* When you want to absorb bursts or limit in-flight work (a buffer of N is a semaphore of N), but never to "fix" a deadlock by guessing a size — that hides the real backpressure design.

**Q2. What happens when you send on, receive on, or close a nil channel?**
Send and receive on a nil channel block forever; closing a nil channel panics. This is deliberately useful: setting a `select` case's channel to `nil` dynamically disables that case.
*Follow-up: Give a real use.* Disabling the send case in a `select` once there's nothing left to produce, so the loop falls through to the receive case only.

**Q3. What happens when you close a channel and then send / receive?**
Sending on a closed channel **panics**. Receiving returns immediately: any buffered values first, then the zero value with `ok == false`.
*Follow-up: Who should close?* The sender, never the receiver — because only the sender knows no more values are coming, and a send-after-close is a panic.

**Q4. How do you detect that a channel is closed?**
Use the two-value receive `v, ok := <-ch`; `ok == false` means closed and drained. Or `for range ch`, which exits on close.
*Follow-up: Can you check "is it closed" without receiving?* No, there's no non-destructive `closed(ch)` — by design, since the answer would be racy.

**Q5. How does `select` choose among ready cases?**
If multiple cases are ready, one is chosen **uniformly at random** (to avoid starvation). If none is ready and there's a `default`, `default` runs; otherwise `select` blocks.
*Follow-up: How do you implement a non-blocking send?* `select { case ch <- v: default: }`.

**Q6. Implement a worker pool with channels.**
A `jobs` channel feeds N worker goroutines; a `results` channel collects output; close `jobs` to signal completion, and use a `sync.WaitGroup` to know when all workers finished before closing `results`.
*Follow-up: How do you propagate cancellation?* Pass a `context.Context` and `select` on `ctx.Done()` in each worker.

**Q7. What memory-model guarantee does a channel provide?**
A send *happens-before* the corresponding receive completes; the close of a channel happens-before a receive that observes the channel is closed. So data written before a send is visible to the goroutine after it receives.
*Follow-up: Does that mean channels replace mutexes?* For ownership transfer, yes; for high-contention shared counters, a mutex/atomic is usually faster.

**Q8. Why might a goroutine leak with channels, and how do you prevent it?**
A goroutine blocked forever on a send/receive that no one will service leaks. Prevent with a `done`/`ctx` channel in a `select`, buffered channels sized to never block a fire-and-forget sender, or ensuring every started goroutine has a guaranteed exit path.

## 6. Production Use Cases

- **Worker pools / pipelines:** Image/video transcoding services, ETL pipelines, and crawlers fan jobs across workers via a `jobs chan` and collect via a `results chan`. The Go blog's "Pipelines and cancellation" article is the canonical pattern.
- **Request fan-out / scatter-gather:** Search backends (e.g., a Google-style query hitting many shards) send sub-requests on goroutines and `select` the first/quickest responses.
- **Rate limiting & semaphores:** A buffered channel of capacity N as a counting semaphore caps concurrent DB connections or outbound API calls. `golang.org/x/sync/semaphore` formalizes this; `time.Tick` + channels build token-bucket limiters.
- **Graceful shutdown:** Servers close a `done`/`quit` channel (or cancel a context, which closes its `Done()` channel) to broadcast "stop" to every goroutine at once — used throughout Kubernetes, etcd, and the standard `net/http` server's shutdown path.
- **Event buses / pub-sub:** In-process event distribution in tools like HashiCorp Consul/Nomad uses fan-out over per-subscriber channels.
- **`context.Context`:** The entire cancellation system is built on a `chan struct{}` returned by `Done()` — the single most-used channel pattern in production Go.

## 7. Common Mistakes

> [!WARNING]
> The four classic channel bugs: **send on closed** (panic), **double close** (panic), **close by receiver** (race + panic risk), and **leaked goroutine blocked on a channel** (silent, hard to find).

- **Closing from the receiver side** or from multiple senders. Only the sole owner/sender closes. For multiple senders, coordinate via a separate `done` channel or `sync.Once`.
- **Forgetting to close**, then `range`-ing — the consumer blocks forever after the last value.
- **Using a buffer size to paper over a deadlock.** A buffer hides the symptom and changes timing; it doesn't fix the design.
- **Assuming `select` is ordered.** It's random among ready cases.
- **Sending into a channel that has no receiver and no context/cancellation** — instant goroutine leak under load.
- **Sharing a value after sending it.** Once sent, you've transferred ownership; mutating it concurrently is a race.

## 8. Performance Considerations

Every channel operation acquires the channel's internal lock, so channels are **not free** and **not lock-free**. A single uncontended send+receive is on the order of tens of nanoseconds; under heavy contention it degrades because all goroutines serialize on `hchan.lock`.

Rules of thumb:

| Scenario | Prefer |
|---|---|
| Ownership transfer / coordination | Channel |
| High-frequency counter / flag | `sync/atomic` |
| Protect a small struct, mixed read/write | `sync.Mutex` / `RWMutex` |
| One-time signal to many | `close(chan struct{})` |
| Bounded concurrency | Buffered channel as semaphore |

Other notes:

- **`chan struct{}`** carries zero bytes per element — use it for pure signaling; it avoids allocating element storage.
- **Buffered channels reduce wakeups**: if producer and consumer rates match on average, a small buffer (say, equal to GOMAXPROCS) smooths scheduling and cuts park/unpark overhead.
- **Don't over-shard with thousands of tiny channels**; the per-`hchan` memory and lock-cache-line traffic add up. Sometimes one mutex-protected queue beats N channels.
- A **closed channel as a broadcast** is O(waiters) at close time but O(1) per receiver afterward — extremely cheap for shutdown.

## 9. Best Practices

- **The sender owns the channel and closes it.** Document this in the function signature with directional types (`chan<-`, `<-chan`).
- **Use `chan struct{}` for signals**, `close` for broadcast, a value channel for data.
- **Always pair a blocking channel op with a cancellation path** (`select` on `ctx.Done()`).
- **Size buffers intentionally** based on backpressure semantics, not vibes.
- **Prefer `for v := range ch`** over manual `ok`-checks when draining until close.
- **Never close a channel you receive from.** Never close twice — guard with `sync.Once` if ownership is shared.
- **Return receive-only channels from constructors** so callers can't close or send.

> [!TIP]
> A buffered channel of capacity N is the idiomatic counting semaphore: `sem <- struct{}{}` to acquire, `<-sem` to release. No external library needed.

## 10. Code Examples

Primary idiomatic example — a worker pool with cancellation and clean shutdown:

```go
package main

import (
	"context"
	"fmt"
	"sync"
)

func worker(ctx context.Context, id int, jobs <-chan int, results chan<- int) {
	for {
		select {
		case <-ctx.Done():
			return
		case j, ok := <-jobs:
			if !ok {
				return // jobs closed and drained
			}
			results <- j * j
		}
	}
}

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	jobs := make(chan int, 100)
	results := make(chan int, 100)

	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(id int) { defer wg.Done(); worker(ctx, id, jobs, results) }(i)
	}

	go func() {
		for n := 1; n <= 10; n++ {
			jobs <- n
		}
		close(jobs) // sender closes
	}()

	go func() { wg.Wait(); close(results) }() // close results after workers exit

	sum := 0
	for r := range results {
		sum += r
	}
	fmt.Println("sum of squares:", sum) // 385
}
```

Alternative — the nil-channel trick to dynamically disable a `select` case, producing values then switching the case off once exhausted:

```go
package main

import "fmt"

func produce(values []int) <-chan int {
	out := make(chan int)
	go func() {
		i := 0
		for {
			var send chan<- int
			var next int
			if i < len(values) {
				send, next = out, values[i] // active case
			} // else send stays nil -> case disabled forever
			if send == nil {
				close(out)
				return
			}
			select {
			case send <- next:
				i++
			}
		}
	}()
	return out
}

func main() {
	for v := range produce([]int{1, 2, 3}) {
		fmt.Println(v)
	}
}
```

A non-blocking send/receive and a timeout, the everyday `select` idioms:

```go
select {
case v := <-ch:
	fmt.Println("got", v)
case <-time.After(200 * time.Millisecond):
	fmt.Println("timed out")
default:
	fmt.Println("nothing ready right now")
}
```

## 11. Advanced Concepts

- **Nil channels as state machines.** Inside a long-lived `select` loop, set a case's channel variable to `nil` to "turn off" that branch — a clean way to stop reading from an exhausted source or stop writing once the output is closed, without restructuring the loop.
- **Merging / fan-in.** Combine multiple input channels into one by spawning a goroutine per input that copies into a shared output, with a `WaitGroup` closing the output when all inputs are done.
- **The done channel pattern → context.** Before `context`, cancellation was a `done chan struct{}` passed everywhere and `close`d to broadcast. `context.Context` standardizes this; `ctx.Done()` *is* that channel.
- **`reflect.Select`** lets you `select` over a dynamic, runtime-determined set of channels (used in frameworks that multiplex an arbitrary number of subscribers).
- **Memory model precision.** The k-th receive on a channel with capacity C happens-before the (k+C)-th send completes — this is the formal basis for using a buffered channel as a semaphore.
- **Direct send optimization.** The runtime's hand-off from a parked sender straight to a parked receiver's stack avoids touching the buffer at all, which is why unbuffered channels can be competitive with buffered ones for ping-pong workloads.

## 12. Debugging Tips

- **Deadlock:** `fatal error: all goroutines are asleep - deadlock!` means every goroutine is blocked, often on an unclosed channel or a missing receiver. The runtime prints the stack of each parked goroutine — read where they're stuck (`chansend`/`chanrecv`).
- **Goroutine leaks:** Run with the goroutine profile (`import _ "net/http/pprof"`, then `go tool pprof http://.../debug/pprof/goroutine`) and look for a growing count parked in `chanrecv`/`chansend`. The `go.uber.org/goleak` library asserts no leaks in tests.
- **Races:** Build/test with `-race`. While the channel op itself is safe, sharing the sent value after sending is not — the race detector catches that.
- **Stuck `select`:** Add a `time.After` case temporarily to surface which case never fires.
- **Panic `send on closed channel`:** The stack trace points to the offending send; the fix is almost always reassigning close ownership to a single sender.

## 13. Senior Engineer Notes

As a senior engineer, your channel judgement shows up in code review. Flag any `close` that isn't on the sole-sender path. Push back on buffered channels whose size is a magic number with no backpressure rationale — ask "what happens when this fills?" Insist that every spawned goroutine has a provable exit (a `ctx` or `done` case), because leaks are invisible until they're an OOM at 3 a.m.

Mentor toward the right tool: juniors reach for channels everywhere, including a shared counter where a mutex or atomic is simpler and 10x faster. Teach the heuristic — *channels for transferring ownership and orchestrating, mutexes for protecting state.* Encourage directional channel types in APIs so the compiler enforces who-sends/who-closes. In reviews of pipelines, verify the close-cascade order (close jobs → workers drain → WaitGroup → close results) and that errors have a path back, not just successes.

## 14. Staff Engineer Notes

At staff level the question is architectural: *should this coordination even be in-process channels?* Channels are an in-memory, single-process abstraction. The moment you need durability, multi-instance fan-out, or at-least-once delivery, an in-process channel is the wrong boundary — that's Kafka, NATS, SQS, or a database queue. A frequent failure mode I've seen is a beautiful channel-based pipeline that silently drops in-flight work on deploy because channels have no persistence. Make the build-vs-buy call explicitly: channels for intra-process orchestration; a real broker for inter-service or durable workflows.

Cross-team, standardize the cancellation contract on `context.Context` rather than bespoke `done` channels, so every service composes the same way and tracing/deadlines propagate. Watch the org-level cost of channel-heavy designs: they couple goroutine lifecycles, and a leak or unbounded buffer in one library can take down a whole binary. Establish guardrails — bounded channels by default, mandatory context propagation, `goleak` in CI — so the failure modes you can't review individually are caught systemically. Finally, weigh observability: channels are opaque to metrics, so require that queue depths and worker saturation be exported as gauges, turning an invisible runtime structure into an operable one.

## 15. Revision Summary

- A channel is a typed conduit; ops are **send**, **receive**, **close**; flavors are **unbuffered** (rendezvous), **buffered** (queue), and **nil** (blocks forever).
- Implemented as `hchan`: ring `buf`, `sendx`/`recvx`, `sendq`/`recvq` wait queues, and a `lock` — *not* lock-free.
- Send-on-closed **panics**; receive-on-closed returns zero + `ok == false`; close is a **broadcast**.
- **Sender owns and closes**; receiver never closes; never double-close (use `sync.Once` if shared).
- Nil channel disables a `select` case; `select` picks randomly among ready cases.
- Memory model: send happens-before receive; buffered channel = counting semaphore.
- Use `chan struct{}` for signals, `context` for cancellation, buffered channels for bounded concurrency.
- Prefer mutex/atomic for hot shared state; channels for ownership transfer and orchestration.
- Debug with `-race`, goroutine pprof, and `goleak`; deadlock errors print parked stacks.

**References:** Go blog — *Share Memory by Communicating*; *Go Concurrency Patterns: Pipelines and Cancellation*; The Go Memory Model; `runtime/chan.go` source.

---

*Go Engineering Handbook — topic 32.*
