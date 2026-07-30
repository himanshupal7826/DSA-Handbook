# 08 · Producing & Consuming: Acks, Prefetch & QoS

> **In one line:** The acknowledgement decides whether a crash loses your message or merely redelivers it, and prefetch decides whether one slow message stalls a worker or the load spreads fairly — get these two knobs right and RabbitMQ consumption is robust and fast; get them wrong and you have silent loss or an idle worker pool.

---

## 1. Overview

A queue's whole promise is that a message handed to a consumer is not forgotten until the work is actually done. That promise rests on one mechanism: the **acknowledgement**. When a consumer reads a message, RabbitMQ marks it *unacknowledged* — delivered but not yet confirmed done — and keeps it. Only when the consumer sends `basic.ack` does the broker discard it. If the consumer dies before acking, the broker notices the channel drop and *redelivers* the message to another consumer. This is the difference between at-most-once and at-least-once delivery, and it is a per-consumer choice made with a single boolean at subscribe time. Choose **auto-ack** and the broker considers a message done the instant it is *sent* — fire-and-forget, fast, and lossy if the consumer crashes mid-work. Choose **manual ack** and the message survives a crash to be processed again. For anything that matters, manual ack is the only correct choice, and understanding exactly when and how to ack is the core of this chapter.

The second knob is **prefetch**, set via `basic.qos`. Without it, RabbitMQ pushes messages to a consumer as fast as it can, filling the consumer's local buffer with unacked messages regardless of whether the consumer can keep up. That is fine for uniform, fast work and catastrophic for uneven work: a consumer that grabs twenty messages and then hits one slow one leaves nineteen queued behind it while another consumer sits idle. Prefetch caps the number of *unacknowledged* messages the broker will deliver to a consumer at once. Set it to 1 and each consumer holds exactly one message until it acks, so a free consumer always takes the next message — **fair dispatch**, ideal when processing times vary wildly. Set it higher and each consumer pipelines several messages, amortising the network round-trip for **throughput**, ideal when work is small and uniform. Prefetch is, at heart, the flow-control valve between the broker and each consumer, and tuning it is the main lever you have over the round-robin-versus-fair-dispatch trade.

This chapter pins down the ack model precisely — auto-ack versus manual ack, `basic.ack`, `basic.nack` and `basic.reject` with `requeue=true`/`false`, the `redelivered` flag, and multiple-ack for batching — and shows exactly why manual-ack plus requeue is what prevents loss when a consumer crashes. It then treats prefetch as the flow-control mechanism it is: what `basic.qos` limits, the fair-dispatch (`prefetch=1`) versus throughput (higher prefetch) trade, the interaction with multiple competing consumers, and consumer cancellation. The `amqp091-go` code shows a robust consumer with manual acks, tuned prefetch, and nack-and-requeue with the poison-message caveat. These are the two settings that most determine whether your consumers are correct and fast, so they repay precision.

## 2. Core Concepts

- **Acknowledgement (ack)** — a consumer's signal to the broker that a message has been successfully processed and may be discarded. `basic.ack`.
- **Auto-ack (`autoAck=true`)** — the broker treats a message as acknowledged the moment it is *delivered*, before the consumer processes it. Fire-and-forget; loses messages on a consumer crash. At-most-once.
- **Manual ack (`autoAck=false`)** — the consumer explicitly acks after processing. A crash before the ack causes redelivery. At-least-once.
- **Unacknowledged (unacked)** — a message delivered to a consumer but not yet acked. The broker holds it; it is redelivered if the consumer's channel drops.
- **`basic.nack` / `basic.reject`** — negative acknowledgements: the consumer says "I did not process this". `nack` can act on multiple messages; `reject` is single. Both take a `requeue` flag.
- **`requeue`** — on nack/reject: `true` puts the message back on the queue for redelivery; `false` discards it (or dead-letters it if a DLX is configured, chapter 11).
- **`redelivered` flag** — a per-message boolean set true when a message is being delivered again (after a nack-requeue or a consumer crash), warning the consumer it may have seen this before.
- **Prefetch / `basic.qos`** — a limit on the number of unacknowledged messages the broker will deliver to a consumer (or channel) at once. The core flow-control knob.
- **Fair dispatch** — `prefetch=1`: each consumer holds one unacked message, so a free consumer always takes the next. Balances uneven work.
- **Round-robin dispatch** — the default without QoS: the broker hands messages to consumers in turn regardless of how busy each is.
- **Multiple-ack** — `basic.ack` with `multiple=true` acknowledges all unacked messages up to and including the given delivery tag on that channel, batching acks.
- **Delivery tag** — a per-channel monotonic id the broker assigns each delivery; acks/nacks reference it. Not stable across channels or redeliveries.
- **Consumer cancellation** — `basic.cancel` (client-initiated) or a broker cancel notification (e.g. queue deleted) that stops a consumer's subscription and closes its delivery stream.

## 3. Theory & Principles

### The ack is where at-most-once and at-least-once diverge

The delivery guarantee is not a property of RabbitMQ; it is a property of *when you ack*, and the two options are genuinely different contracts. With **auto-ack**, the broker considers the message acknowledged as soon as it writes it to the socket toward the consumer — before the consumer has parsed it, let alone processed it. If the consumer crashes, or the process is killed, or it throws while handling the message, the message is already gone from the queue: it was acked on delivery. That is **at-most-once** — the message is processed zero or one times, never twice, and the failure mode is *loss*. It is the right choice only when losing a message is acceptable: high-volume metrics, live dashboards, best-effort notifications where a gap does not matter.

With **manual ack**, the broker holds the message as *unacknowledged* from the moment it delivers it until the consumer explicitly acks. If the consumer's channel or connection drops before the ack — crash, kill, network partition — the broker returns the message to the queue and redelivers it to another consumer. That is **at-least-once** — the message is processed one or more times, never zero, and the failure mode is *duplication*, not loss. Because duplication is almost always recoverable (make the consumer idempotent, chapter 21) and loss usually is not, at-least-once via manual ack is the correct default for any message whose processing matters. The entire safety of the pattern hinges on the ordering: **process first, ack second**. Ack before processing and you have quietly re-created at-most-once with extra steps.

### Why manual ack + requeue survives a crashed consumer

Trace the failure precisely. A consumer subscribes with `autoAck=false`. The broker delivers message M and marks it unacked, remembering which channel holds it. The consumer starts processing M and, halfway through, the process is killed. The TCP connection drops; the broker detects the channel closure. Because M was unacked, the broker knows it was never confirmed done, so it puts M back at (or near) the head of the queue and delivers it to another live consumer — with the `redelivered` flag set true. No message was lost: the crash converted "processed once" into "processed again", exactly the at-least-once contract. Had the consumer used auto-ack, M would have been acked on delivery and lost the instant the process died, with nothing to redeliver. This is the whole reason manual ack exists: it moves the point of no return from *delivery* to *successful completion*, so the window in which a crash loses data shrinks to nothing.

`nack`/`reject` with `requeue` generalise this to *deliberate* failure. If the consumer reads M, tries to process it, and fails in a way that might succeed later — a transient downstream outage — it calls `basic.nack(requeue=true)`, and the broker redelivers M just as if the consumer had crashed. If it fails in a way that will *never* succeed — a malformed message, a poison message — it calls `basic.nack(requeue=false)`, and the broker discards M (or routes it to a dead-letter exchange if configured, chapter 11) so it does not loop forever. The `requeue` boolean is thus the fork between "try again" and "give up on this one", and choosing it correctly is what keeps a single bad message from wedging the whole queue.

### The requeue loop and the poison-message trap

There is a sharp trap in `requeue=true`: if a message fails *deterministically*, requeueing it creates an infinite loop. The consumer reads M, fails, nacks with requeue, the broker redelivers M, the consumer fails again, and so on — a hot loop that burns CPU and blocks progress, often on the *same* consumer since a requeued message frequently returns to the head of the queue. This is the poison-message problem, and it is why blind `requeue=true` on every failure is a mistake. The disciplined pattern is: requeue only on *transient* failures, and for *deterministic* ones (or after a bounded number of redeliveries) nack with `requeue=false` toward a dead-letter exchange, where the message can be inspected and reprocessed out of band. The `redelivered` flag is your signal — if a message arrives already redelivered and fails again, that is strong evidence it is poison, and continuing to requeue it is throwing good CPU after bad (chapter 23 treats poison-message handling in full).

### Prefetch is flow control between broker and consumer

Prefetch (`basic.qos`) exists because without it the broker's dispatch is *greedy and blind*. By default RabbitMQ pushes messages to a consumer as fast as the socket allows, round-robin across competing consumers, with no regard for how many each consumer already holds unprocessed. For fast, uniform work that is fine and even optimal — pipelining hides the network latency. But for uneven work it is a disaster: suppose ten messages are queued, two consumers, and the broker round-robins five to each. If consumer A's messages happen to be slow and B's fast, B finishes its five and sits *idle* while A grinds through its five, even though A still has four waiting that B could have taken. The messages were committed to A at dispatch time and cannot be reassigned. Throughput collapses to the slow consumer's rate despite a free worker.

Prefetch fixes this by capping unacked messages per consumer. With `prefetch=1`, the broker gives each consumer exactly one message and will not send the next until that one is acked. Now a consumer that finishes quickly immediately asks for and receives the next message, while a slow consumer holds just its one — so work flows to whoever is free. This is **fair dispatch**, and it is the right setting when per-message processing time varies a lot. The cost is a network round-trip per message (ack, then next delivery), which caps throughput. A higher prefetch (say 10–100) lets each consumer pipeline several messages, amortising the round-trip and maximising throughput — the right setting when work is small, fast and uniform, so the pipelining does not create meaningful imbalance. Prefetch is therefore the single dial on the round-robin-versus-fair-dispatch trade: low for fairness under uneven load, high for throughput under uniform load, with the sweet spot found by watching consumer utilisation and end-to-end latency.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="q1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="q2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="20" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Prefetch: greedy round-robin vs fair dispatch (prefetch=1)</text>

  <rect x="20" y="36" width="410" height="200" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="225" y="58" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">No QoS: greedy round-robin</text>
  <rect x="36" y="74" width="150" height="24" rx="4" fill="#fff" stroke="#fca5a5"/><text x="111" y="91" text-anchor="middle" fill="#7f1d1d" font-size="9">10 messages queued</text>
  <path d="M186,86 L222,74" stroke="#dc2626" stroke-width="1.5" marker-end="url(#q1)"/>
  <path d="M186,88 L222,150" stroke="#dc2626" stroke-width="1.5" marker-end="url(#q1)"/>
  <rect x="224" y="62" width="180" height="52" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="314" y="80" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">consumer A (got 5)</text>
  <text x="314" y="96" text-anchor="middle" fill="#991b1b" font-size="8">all 5 happen to be SLOW</text>
  <text x="314" y="108" text-anchor="middle" fill="#991b1b" font-size="8">still grinding &#8230;</text>
  <rect x="224" y="126" width="180" height="52" rx="6" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="314" y="144" text-anchor="middle" fill="#64748b" font-size="9" font-weight="bold">consumer B (got 5)</text>
  <text x="314" y="160" text-anchor="middle" fill="#64748b" font-size="8">finished fast &#8212; now IDLE</text>
  <text x="314" y="172" text-anchor="middle" fill="#64748b" font-size="8">cannot take A&#8217;s backlog</text>
  <text x="36" y="204" fill="#991b1b" font-size="10">Messages were committed to A at dispatch time.</text>
  <text x="36" y="222" fill="#b91c1c" font-size="10" font-weight="bold">Throughput collapses to the slow consumer&#8217;s rate.</text>

  <rect x="450" y="36" width="410" height="200" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="655" y="58" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">prefetch=1: fair dispatch</text>
  <rect x="466" y="74" width="150" height="24" rx="4" fill="#fff" stroke="#86efac"/><text x="541" y="91" text-anchor="middle" fill="#14532d" font-size="9">10 messages queued</text>
  <path d="M616,86 L652,80" stroke="#16a34a" stroke-width="1.5" marker-end="url(#q2)"/>
  <path d="M616,88 L652,150" stroke="#16a34a" stroke-width="1.5" marker-end="url(#q2)"/>
  <rect x="654" y="66" width="188" height="46" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="748" y="84" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">consumer A: holds 1</text>
  <text x="748" y="100" text-anchor="middle" fill="#166534" font-size="8">slow one &#8212; keeps just that 1</text>
  <rect x="654" y="124" width="188" height="46" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="748" y="142" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">consumer B: holds 1</text>
  <text x="748" y="158" text-anchor="middle" fill="#166534" font-size="8">fast &#8594; acks &#8594; grabs next, repeat</text>
  <text x="466" y="196" fill="#166534" font-size="10">Broker sends the next only after an ack.</text>
  <text x="466" y="214" fill="#15803d" font-size="10" font-weight="bold">Work flows to whoever is free. No idle worker.</text>

  <rect x="20" y="252" width="840" height="236" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="274" text-anchor="middle" fill="#334155" font-size="13" font-weight="bold">Choosing prefetch, and the ack that makes it safe</text>

  <rect x="40" y="290" width="390" height="90" rx="8" fill="#fff" stroke="#16a34a" stroke-width="1.5"/>
  <text x="235" y="310" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">prefetch = 1 (fair dispatch)</text>
  <text x="56" y="332" fill="#166534" font-size="9">&#8226; uneven / slow / variable processing times</text>
  <text x="56" y="350" fill="#166534" font-size="9">&#8226; each consumer holds one; free worker takes next</text>
  <text x="56" y="368" fill="#166534" font-size="9">&#8226; cost: a round-trip per message caps throughput</text>

  <rect x="450" y="290" width="390" height="90" rx="8" fill="#fff" stroke="#2563eb" stroke-width="1.5"/>
  <text x="645" y="310" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">prefetch = N (throughput)</text>
  <text x="466" y="332" fill="#1d4ed8" font-size="9">&#8226; small, fast, uniform work</text>
  <text x="466" y="350" fill="#1d4ed8" font-size="9">&#8226; pipeline N messages, amortise the round-trip</text>
  <text x="466" y="368" fill="#1d4ed8" font-size="9">&#8226; cost: imbalance + more redelivered on a crash</text>

  <text x="40" y="406" fill="#b91c1c" font-size="10" font-weight="bold">All of this ONLY holds with manual ack (autoAck=false):</text>
  <text x="40" y="426" fill="#991b1b" font-size="10">&#8226; process the message FIRST, then basic.ack &#8212; a crash in between &#8594; redelivered, not lost.</text>
  <text x="40" y="444" fill="#991b1b" font-size="10">&#8226; transient failure &#8594; nack(requeue=true) = try again. Deterministic/poison &#8594; nack(requeue=false) &#8594; DLX.</text>
  <text x="40" y="464" fill="#334155" font-size="10" font-weight="bold">With autoAck the message is gone at delivery &#8212; prefetch and requeue are meaningless.</text>
</svg>
```

## 4. Architecture & Workflow

The consume-side lifecycle, with the decisions at each step:

1. **Set QoS.** Before consuming, call `basic.qos(prefetchCount)` on the channel to cap unacked messages per consumer. This is the flow-control valve; choose 1 for fair dispatch of uneven work, higher for throughput of uniform work.
2. **Subscribe.** Call `basic.consume(queue, autoAck=false)`. Manual ack is the safe default; the broker will now hold each delivered message as unacked until you ack it, and redeliver on channel loss.
3. **Receive.** The broker pushes up to `prefetchCount` unacked messages. Each delivery carries a `delivery tag` (for acking), the `redelivered` flag (has this been delivered before?), and the body and properties.
4. **Process, then decide.** Do the work. On success, `basic.ack(deliveryTag)`. On transient failure, `basic.nack(deliveryTag, requeue=true)` to retry. On deterministic/poison failure — or when `redelivered` is already true and it fails again — `basic.nack(deliveryTag, requeue=false)` to dead-letter it. Never ack before processing.
5. **Flow continues.** Each ack frees a prefetch slot, so the broker delivers the next message. Under `prefetch=1` this yields fair dispatch; under higher prefetch, a pipeline.
6. **Cancel cleanly.** On shutdown, `basic.cancel` the consumer so the broker stops delivering, drain and ack (or let requeue) the in-flight messages, then close the channel. Handle broker-initiated cancel notifications (e.g. the queue was deleted) so the consumer does not spin on a closed stream.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="w1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">One delivery&#8217;s fate: the three-way decision after processing</text>

  <rect x="24" y="46" width="150" height="52" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="99" y="68" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">1. QoS then consume</text>
  <text x="99" y="86" text-anchor="middle" fill="#1d4ed8" font-size="8">qos(prefetch) + autoAck=false</text>
  <path d="M176,72 L214,72" stroke="#4f46e5" stroke-width="2" marker-end="url(#w1)"/>

  <rect x="216" y="46" width="150" height="52" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="291" y="66" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">2. deliver (unacked)</text>
  <text x="291" y="82" text-anchor="middle" fill="#6d28d9" font-size="8">tag + redelivered flag</text>
  <text x="291" y="94" text-anchor="middle" fill="#6d28d9" font-size="8">broker holds it</text>
  <path d="M368,72 L406,72" stroke="#4f46e5" stroke-width="2" marker-end="url(#w1)"/>

  <rect x="408" y="46" width="150" height="52" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="483" y="68" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">3. PROCESS the work</text>
  <text x="483" y="86" text-anchor="middle" fill="#b45309" font-size="8">crash here &#8594; redelivered</text>

  <path d="M483,98 L360,140" stroke="#16a34a" stroke-width="2" marker-end="url(#w1)"/>
  <path d="M483,98 L483,140" stroke="#d97706" stroke-width="2" marker-end="url(#w1)"/>
  <path d="M483,98 L606,140" stroke="#dc2626" stroke-width="2" marker-end="url(#w1)"/>

  <rect x="210" y="146" width="200" height="72" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="310" y="166" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">SUCCESS</text>
  <text x="310" y="184" text-anchor="middle" fill="#166534" font-size="9">basic.ack(multiple=false)</text>
  <text x="310" y="200" text-anchor="middle" fill="#166534" font-size="8">broker discards it; slot freed</text>
  <text x="310" y="212" text-anchor="middle" fill="#166534" font-size="8">&#8594; next message delivered</text>

  <rect x="383" y="230" width="200" height="72" rx="8" fill="#fef9c3" stroke="#d97706" stroke-width="2"/>
  <text x="483" y="250" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">TRANSIENT fail</text>
  <text x="483" y="268" text-anchor="middle" fill="#b45309" font-size="9">nack(requeue=true)</text>
  <text x="483" y="284" text-anchor="middle" fill="#b45309" font-size="8">retry &#8212; but bound it with</text>
  <text x="483" y="296" text-anchor="middle" fill="#b45309" font-size="8">redelivered / a retry count</text>

  <rect x="556" y="146" width="220" height="72" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="666" y="166" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">POISON / deterministic</text>
  <text x="666" y="184" text-anchor="middle" fill="#991b1b" font-size="9">nack(requeue=false)</text>
  <text x="666" y="200" text-anchor="middle" fill="#991b1b" font-size="8">discarded &#8594; dead-letter exchange</text>
  <text x="666" y="212" text-anchor="middle" fill="#991b1b" font-size="8">inspected out of band (ch.11)</text>

  <rect x="24" y="316" width="832" height="52" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="338" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">The spine: QoS before consume &#183; process BEFORE ack &#183; requeue only transient, bounded &#183; dead-letter the rest</text>
  <text x="440" y="356" text-anchor="middle" fill="#475569" font-size="10">Naive requeue=true on every failure is the classic infinite poison loop &#8212; the redelivered flag is what bounds it.</text>
</svg>
```

The workflow's spine is **QoS before consume, process before ack, and a deliberate requeue decision on failure**. Those three habits are what separate a consumer that loses data or stalls under uneven load from one that is both safe and fast. Everything else — batching acks, tuning the prefetch number, wiring a dead-letter exchange — is refinement on top of that spine.

## 5. Implementation

Here is a robust `amqp091-go` consumer with manual acks, tuned prefetch, and a deliberate nack-with-requeue decision that avoids the poison-message loop. It also shows multiple-ack batching and clean cancellation.

```go
package main

import (
	"context"
	"errors"
	"log"
	"os"
	"os/signal"
	"syscall"

	amqp "github.com/rabbitmq/amqp091-go"
)

// transientError marks a failure worth retrying (a downstream blip); anything
// else is treated as deterministic/poison and dead-lettered rather than looped.
type transientError struct{ err error }

func (t transientError) Error() string { return t.err.Error() }

func runConsumer(conn *amqp.Connection) error {
	ch, err := conn.Channel()
	if err != nil {
		return err
	}
	defer ch.Close()

	// --- 1. QoS / prefetch: the flow-control valve ----------------------------
	// prefetchCount=10 -> the broker keeps at most 10 UNACKED messages in flight
	//   to THIS consumer at once. Small enough that a slow message does not hoard
	//   a big backlog (keeping dispatch fairly balanced), large enough to pipeline
	//   and hide the ack round-trip. Use 1 for strict fair dispatch of very uneven
	//   work; raise it for small, uniform, high-throughput work.
	// prefetchSize=0 -> no byte-size limit (count-based only; almost always 0).
	// global=false   -> in RabbitMQ, the limit applies PER CONSUMER on this
	//   channel; global=true would make it a shared per-channel budget.
	if err := ch.Qos(10, 0, false); err != nil {
		return err
	}

	// --- 2. Subscribe with MANUAL ack (autoAck=false) -------------------------
	// autoAck=false is the whole point: the broker holds each message as unacked
	// until we ack, and redelivers it if we crash first (at-least-once).
	deliveries, err := ch.Consume(
		"orders.new", // queue
		"order-worker", // consumer tag (used to cancel)
		false, // autoAck = false -> MANUAL ack
		false, // exclusive
		false, // noLocal (unused by RabbitMQ)
		false, // noWait
		nil,   // args
	)
	if err != nil {
		return err
	}

	// Be told if the broker cancels us (e.g. the queue was deleted) so we don't
	// spin forever on a stream that will never deliver again.
	cancelled := ch.NotifyCancel(make(chan string, 1))

	// Graceful shutdown on SIGINT/SIGTERM: cancel the consumer, then let the
	// range loop drain the already-delivered messages before we exit.
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigs
		log.Println("shutting down: cancelling consumer")
		// basic.cancel: stop new deliveries; the deliveries channel then closes
		// after the broker has finished sending what it already committed.
		_ = ch.Cancel("order-worker", false)
	}()

	for {
		select {
		case reason := <-cancelled:
			log.Printf("broker cancelled the consumer: %s", reason)
			return nil

		case d, ok := <-deliveries:
			if !ok {
				log.Println("deliveries channel closed; consumer stopped")
				return nil
			}
			handleDelivery(&d)
		}
	}
}

func handleDelivery(d *amqp.Delivery) {
	// The redelivered flag warns us this message may have been seen before —
	// after a prior crash or a nack-requeue. If it is redelivered AND fails
	// again, that is strong evidence it is poison; do NOT requeue it forever.
	err := process(d.Body)
	switch {
	case err == nil:
		// --- 3a. SUCCESS: ack this one (multiple=false) ---------------------
		// Only now is the message discarded by the broker. Processing happened
		// FIRST, so a crash before this line would have redelivered, not lost.
		if ackErr := d.Ack(false); ackErr != nil {
			log.Printf("ack failed (message may be redelivered): %v", ackErr)
		}

	case isTransient(err) && !d.Redelivered:
		// --- 3b. TRANSIENT failure, first attempt: requeue to retry ---------
		// requeue=true puts it back on the queue for another attempt. We guard
		// with !d.Redelivered so a message that already came back once is not
		// requeued a second time — that bounds the retry loop.
		log.Printf("transient failure, requeueing once: %v", err)
		_ = d.Nack(false /* multiple */, true /* requeue */)

	default:
		// --- 3c. Deterministic / poison / already-retried: DEAD-LETTER ------
		// requeue=false discards it from THIS queue; if the queue has a
		// dead-letter exchange configured (chapter 11), the message is routed
		// there for out-of-band inspection instead of being lost or looped.
		log.Printf("permanent failure or already redelivered, dead-lettering: %v", err)
		_ = d.Nack(false /* multiple */, false /* requeue -> DLX */)
	}
}

// process does the real work. Returning a transientError signals "retryable".
func process(body []byte) error {
	if len(body) == 0 {
		return errors.New("empty body: malformed, not retryable") // -> DLX
	}
	// ... real handling; wrap downstream blips as transientError{...} ...
	return nil
}

func isTransient(err error) bool {
	var t transientError
	return errors.As(err, &t)
}

// batchAckExample shows MULTIPLE-ack: after processing a run of messages, one
// ack with multiple=true acknowledges every unacked delivery up to and including
// this tag on the channel — fewer round-trips, higher throughput. The risk: a
// crash before the batch ack redelivers ALL of them, so keep batches small and
// only batch idempotent work.
func batchAckExample(d amqp.Delivery) {
	_ = d.Ack(true) // multiple=true: ack this tag and all lower unacked tags
}

func main() {
	conn, err := amqp.Dial("amqp://guest:guest@localhost:5672/")
	if err != nil {
		log.Fatalf("dial: %v", err)
	}
	defer conn.Close()
	if err := runConsumer(conn); err != nil {
		log.Fatalf("consumer: %v", err)
	}
	_ = context.Background()
}
```

The shape to carry away: `Qos` first, `autoAck=false` always for work that matters, process-then-`Ack`, and a three-way failure decision — ack on success, requeue *once* on transient failure, dead-letter on deterministic or already-redelivered failure. The `!d.Redelivered` guard is the small but crucial detail that turns naive `requeue=true` (an infinite poison loop) into a bounded single retry. Multiple-ack is a throughput refinement to reach for only once the safety spine is solid and the work is idempotent.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Manual ack gives at-least-once for free** — no message is lost to a consumer crash, because unacked messages are redelivered.
- **The failure fork is explicit.** `requeue=true` versus `false` lets the consumer distinguish "try again" from "give up", cleanly separating transient from poison failures.
- **Prefetch is a precise flow-control dial.** One integer tunes the whole spectrum from strict fair dispatch (1) to high-throughput pipelining (large N).
- **Fair dispatch prevents idle workers** under uneven load, keeping the whole consumer pool busy and throughput near the aggregate capacity.
- **Multiple-ack amortises the ack round-trip** for a real throughput gain on uniform, idempotent workloads.

**Disadvantages**
- **Manual ack demands discipline.** Forget to ack and messages pile up unacked and are redelivered on reconnect; ack before processing and you silently lose data on a crash.
- **Naive `requeue=true` loops forever** on a poison message, burning CPU and blocking the queue — a common and painful bug.
- **Prefetch too high re-creates the imbalance** and enlarges the redelivery blast radius on a crash (all that consumer's unacked messages come back at once).
- **Prefetch too low caps throughput** to one message per round-trip, wasting capacity on fast uniform work.
- **Auto-ack's speed is a trap** — it looks fine until the first crash quietly drops in-flight messages.

**Trade-offs**
- *Fairness vs throughput:* low prefetch spreads uneven work evenly but pays a round-trip per message; high prefetch maximises throughput on uniform work but reintroduces imbalance and larger redelivery bursts. Tune to the variance of your processing times.
- *Requeue vs dead-letter:* requeueing retries transient failures at the cost of looping on deterministic ones; dead-lettering escapes the loop at the cost of needing an out-of-band path to inspect and reprocess. Use `redelivered`/a retry count to switch between them.
- *Single-ack safety vs multiple-ack speed:* acking each message limits the blast radius of a crash to one message but costs a round-trip each; batching with multiple-ack is faster but redelivers the whole batch on a crash, so only batch small, idempotent runs.

## 7. Common Mistakes & Best Practices

- **Using auto-ack for work that matters.** Fire-and-forget loses every in-flight message when a consumer crashes. Use `autoAck=false` for anything you cannot afford to drop.
- **Acking before processing.** This re-creates at-most-once — a crash between the ack and completion loses the message. Always process first, then ack.
- **Blindly requeueing every failure.** `requeue=true` on a deterministic failure is an infinite loop that pins a CPU and blocks the queue. Requeue only transient failures; dead-letter the rest.
- **Ignoring the `redelivered` flag.** It is the signal that a message may be poison or already processed; use it to bound retries and to guard idempotency.
- **Leaving prefetch unlimited (no QoS) with uneven work.** The broker greedily commits messages to consumers, so a slow consumer hoards a backlog while others idle. Set a prefetch appropriate to your work's variance.
- **Setting prefetch enormous "for speed".** A huge prefetch reintroduces imbalance and means a crash redelivers a large batch at once; it also inflates memory. Start modest (e.g. 10–50) and tune with metrics.
- **Forgetting to handle broker-initiated cancellation.** If the queue is deleted, the consumer must react to the cancel notification rather than spin on a dead stream.
- **Best practice: set QoS before consuming, use manual ack and process-then-ack, requeue transient failures only (bounded by `redelivered`/a retry count) and dead-letter the rest, and tune prefetch from consumer-utilisation and latency metrics rather than guessing.**

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The two symptoms to recognise: rising `messages_unacknowledged` with flat throughput usually means consumers are holding messages they never ack (a forgotten ack, a stuck handler, or prefetch too high with slow processing); and a message being redelivered endlessly with the `redelivered` flag set means a poison message being requeued in a loop. `rabbitmqctl list_queues name messages_ready messages_unacknowledged consumers` and `list_consumers` (which shows each consumer's prefetch) are the first tools. A single consumer with a large unacked count and no progress is the classic "stuck handler holding its whole prefetch window" picture.
- **Monitoring.** Track `messages_ready` (waiting), `messages_unacknowledged` (in flight), redelivery rate, and per-consumer prefetch and ack rate. The redelivery rate is the sharpest signal of trouble — a rising redelivery rate means either consumers are crashing mid-work or a poison message is looping. Also watch consumer utilisation: if some consumers are idle while `messages_ready` is high, prefetch is starving fairness or there are too few consumers (chapter 27).
- **Security.** Consuming from a queue requires *read* permission on it; a rogue consumer with read access competes for and can steal messages from a shared work queue, so scope consume permissions tightly per service and per vhost. Acknowledgement is not authenticated beyond the channel, so protect the connection with TLS and credentials — an attacker on the channel could ack (and thus discard) messages (chapter 29).
- **Scaling.** The consume side scales by adding competing consumers to the queue, with fair dispatch (low prefetch) keeping them balanced; throughput rises until the single queue process (one Erlang process, one node) becomes the bottleneck, at which point you shard across multiple queues (consistent-hash exchange, chapter 22) or move to a design with more queues. Prefetch is the per-consumer tuning knob within that: raise it to push more throughput per consumer on uniform work, lower it to keep dispatch fair as processing-time variance grows. The scaling metric to watch is that `messages_ready` stays flat as producer volume grows — meaning consumers, and their prefetch, are sized to the load.

## 9. Interview Questions

**Q: What is the difference between auto-ack and manual ack, and what delivery guarantee does each give?**
A: With auto-ack, the broker considers a message acknowledged the instant it delivers it — before the consumer processes it — so if the consumer crashes mid-work the message is already gone. That is at-most-once: processed zero or one times, failure mode is loss. With manual ack, the broker holds the message as unacknowledged from delivery until the consumer explicitly acks after processing; if the consumer's channel drops before the ack, the broker redelivers the message. That is at-least-once: processed one or more times, failure mode is duplication. Because duplication is recoverable with idempotency and loss usually is not, manual ack is the correct default for any message that matters, and the safety depends on processing first and acking second.

**Q: Why does manual ack plus requeue prevent message loss when a consumer crashes?**
A: Because the message is only removed from the queue when the consumer acks, and the consumer acks only after successfully processing. If it crashes partway through, it never sent the ack, so the message is still marked unacknowledged. The broker detects the channel closure, returns the message to the queue, and redelivers it to another consumer with the `redelivered` flag set — so the crash turns "processed once" into "processed again" rather than into loss. With auto-ack the message would have been acked at delivery and lost the moment the process died, with nothing to redeliver. Manual ack moves the point of no return from delivery to successful completion.

**Q: What does `basic.nack` with `requeue=true` versus `requeue=false` do, and when do you use each?**
A: A nack tells the broker the consumer did not process the message. With `requeue=true`, the broker puts it back on the queue to be redelivered — use this for *transient* failures like a downstream service being briefly unavailable, where a retry is likely to succeed. With `requeue=false`, the broker discards the message from the queue, or routes it to a dead-letter exchange if one is configured — use this for *deterministic* failures like a malformed or poison message that will never succeed. The danger is requeueing a deterministic failure, which loops forever; the discipline is to requeue only transient failures and dead-letter the rest, using the `redelivered` flag or a retry count to bound retries.

**Q: What is prefetch (`basic.qos`) and why is it called flow control?**
A: Prefetch caps the number of unacknowledged messages the broker will deliver to a consumer at once. It is flow control because it is the valve that governs how fast the broker pushes work to each consumer: without it, the broker greedily commits messages as fast as the socket allows, so a consumer can be handed a large backlog it cannot process while another sits idle. By limiting unacked messages, prefetch matches the delivery rate to the consumer's processing rate — each ack frees a slot for the next message — which both prevents any one consumer from hoarding work and bounds the memory a consumer holds. It is the single dial between fair dispatch and high-throughput pipelining.

**Q: What is fair dispatch and how do you enable it?**
A: Fair dispatch means the broker sends a consumer a new message only when it has acked its previous one, so work always flows to whoever is currently free rather than being pre-committed round-robin. You enable it by setting `basic.qos(prefetchCount=1)` before consuming: each consumer then holds exactly one unacked message at a time. It is the right setting when per-message processing time varies a lot, because it prevents a consumer that happened to receive several slow messages from leaving a fast, idle consumer unable to help. The trade-off is a network round-trip per message, which caps throughput, so for small uniform work a higher prefetch is better.

**Q: What is the `redelivered` flag and how should a consumer use it?**
A: The `redelivered` flag is a per-delivery boolean the broker sets true when a message is being delivered again — after a prior consumer crashed without acking, or after a nack with requeue. It warns the consumer "you may have seen this message before", which matters for two reasons: it is a hint that the consumer's idempotency logic must handle a possible duplicate, and it is the signal to bound retries. A message that arrives already redelivered and fails again is strong evidence it is poison, so rather than requeueing it into an infinite loop, the consumer should nack it with `requeue=false` toward a dead-letter exchange. It does not guarantee a duplicate — only that one is possible — so it complements, rather than replaces, idempotent processing.

**Q: What does multiple-ack do and what is its risk?**
A: `basic.ack` with `multiple=true` acknowledges every unacknowledged message up to and including the given delivery tag on that channel, in one operation, rather than acking each individually. It amortises the ack round-trip and raises throughput when processing a run of messages. Its risk is blast radius: if the consumer crashes after processing several messages but before the batch ack, all of them — not just one — are still unacknowledged and get redelivered, so they are all processed again. That is safe only if the work is idempotent, and even then you want small batches to bound how much is reprocessed. So multiple-ack is a throughput refinement to apply carefully on idempotent workloads, not a default.

**Q: (Senior) How do you choose a prefetch value for a given workload?**
A: I treat prefetch as the dial on the fairness-versus-throughput trade and set it from the *variance* of processing time and the round-trip latency to the broker, not by guessing. If per-message processing time varies widely — some messages take milliseconds, some take seconds — I want a low prefetch, often 1, so fast consumers are never blocked behind a slow consumer's committed backlog; fair dispatch keeps the whole pool busy and the aggregate throughput near capacity. If the work is small, fast and uniform, the round-trip per message dominates, so I raise prefetch to pipeline several messages and hide that latency — a value in the tens to low hundreds is typical, chosen so each consumer always has the next message ready without holding an excessive backlog. I bound it from above for two reasons: a large prefetch reintroduces imbalance (a consumer hoards messages others could take) and enlarges the redelivery burst if that consumer crashes, since its whole unacked window comes back at once. In practice I start around 10–50, then tune empirically: I watch consumer utilisation (are any idle while `messages_ready` is high? prefetch too low for throughput or too few consumers), end-to-end latency, and the redelivery rate, and adjust. I also factor memory: prefetch times message size times consumer count is memory the broker commits to in-flight delivery. The honest answer is that there is no universal number — it is a per-workload tuning against those metrics, with "1 for high-variance work, higher for uniform work" as the starting intuition.

**Q: (Senior) A consumer's queue shows a large and growing `messages_unacknowledged` count but throughput is near zero. Diagnose it.**
A: A high, growing unacked count with no throughput means messages are being *delivered* to consumers but not *acked*, so I look at where the acks are going. The most common cause is a stuck or slow handler: the consumer has pulled its full prefetch window and is blocked — on a downstream call with no timeout, a lock, or an infinite retry — so it holds those messages unacked and, because the prefetch window is full, the broker sends it nothing new and it makes no progress. `list_consumers` shows each consumer's prefetch and the per-consumer unacked count, which tells me whether one consumer is holding everything (a stuck handler) or the load is spread. The second cause is a forgotten ack: the code processes successfully but never calls `basic.ack` (or acks the wrong delivery tag, or on the wrong channel), so messages accumulate unacked until the connection drops and they all redeliver. The third is prefetch set too high combined with slow processing, so a large window is legitimately in flight but draining slowly — distinguishable because throughput is low-but-nonzero and the unacked count tracks the prefetch window rather than growing unbounded. I would check for a handler blocked on a downstream dependency (add timeouts), confirm the ack path actually runs on the success branch, verify the delivery tag and channel are correct, and look at whether a poison message is wedging the consumer in a retry loop. The fix depends on the cause, but the diagnostic key is that unacked-high-with-no-throughput almost always means the consumer is holding messages it will neither ack nor release — so the handler is stuck, or the ack is missing.

**Q: (Senior) Explain the poison-message loop and how you design a consumer to avoid it.**
A: The poison-message loop happens when a message fails *deterministically* and the consumer responds with `nack(requeue=true)`: the broker puts it back, redelivers it, the consumer fails identically, requeues again, and the cycle repeats — often on the same consumer, since a requeued message frequently returns to the head of the queue, so one bad message pins a CPU and can block everything behind it. The root cause is treating all failures as retryable. To avoid it I distinguish transient from deterministic failure in the handler: a wrapped "retryable" error (a downstream timeout, a 503) gets a bounded requeue, while anything else — a parse failure, a schema violation, a business-rule rejection — goes straight to a dead-letter exchange via `nack(requeue=false)`. I bound even the transient retries, because a "transient" failure that persists becomes de facto poison: I use the `redelivered` flag as a cheap one-shot bound (requeue only if not already redelivered), or, for more than one retry, carry a retry count in a header and dead-letter once it exceeds a limit, typically with exponential backoff implemented via a delay queue or the DLX-with-TTL pattern (chapter 11). The dead-letter exchange routes the poison message to a separate queue where it can be inspected, alerted on, fixed, and reprocessed out of band, instead of looping in the hot path. The design principle is that the main queue must always make forward progress, so no single message may be retried unboundedly — every failure either succeeds within a small bounded number of attempts or is moved aside. That, plus idempotent processing so the inevitable redeliveries are harmless, is what makes an at-least-once consumer robust.

## 10. Quick Revision & Cheat Sheet

| Setting | Value | Meaning / effect |
|---|---|---|
| autoAck | true | Acked on delivery; crash loses message; at-most-once |
| autoAck | false | Ack after processing; crash redelivers; at-least-once |
| basic.ack | multiple=false | Ack this one message |
| basic.ack | multiple=true | Ack all unacked up to this tag (batch) |
| basic.nack | requeue=true | Put back for retry (transient failures) |
| basic.nack | requeue=false | Discard / dead-letter (poison, deterministic) |
| basic.qos | prefetch=1 | Fair dispatch: one unacked per consumer |
| basic.qos | prefetch=N | Pipeline N; throughput; risk imbalance |

| Symptom | Likely cause |
|---|---|
| Messages lost on crash | auto-ack, or acking before processing |
| Endless redelivery, `redelivered=true` | poison message requeued in a loop |
| High unacked, zero throughput | stuck handler / forgotten ack / prefetch too high |
| Idle consumers, high `messages_ready` | prefetch starving fairness or too few consumers |

**Flash cards**
- **Safe default ack mode?** → Manual (`autoAck=false`): process first, then `basic.ack`.
- **Prevent loss on a crashed consumer?** → Manual ack — unacked messages are redelivered.
- **Transient failure vs poison?** → `nack(requeue=true)` to retry vs `nack(requeue=false)` to dead-letter.
- **Fair dispatch?** → `basic.qos(prefetch=1)`: free consumer always takes the next message.
- **Throughput on uniform work?** → Higher prefetch to pipeline and amortise the round-trip.
- **Bound the retry loop?** → Use `redelivered` / a retry-count header, then dead-letter.

## 11. Hands-On Exercises & Mini Project

- [ ] Run a consumer with `autoAck=true`, kill it mid-processing, and confirm the in-flight message is lost; repeat with `autoAck=false` and confirm it is redelivered.
- [ ] With two consumers and no QoS, feed a mix of slow and fast messages and observe one consumer idling; set `prefetch=1` and watch fair dispatch balance the load.
- [ ] Force a deterministic failure and `nack(requeue=true)` on every attempt to reproduce a poison loop; then bound it with the `redelivered` flag and dead-letter the message.
- [ ] Measure throughput at prefetch 1, 10, 100, and 1000 on small uniform messages and plot where it plateaus and where imbalance appears.
- [ ] Use multiple-ack to batch-acknowledge a run of messages, then crash before the batch ack and observe the whole batch redelivering.
- [ ] Delete a queue while a consumer is attached and confirm your code handles the broker cancel notification cleanly.

### Mini Project — "Robust Worker Pool"

**Goal.** Build a competing-consumer worker pool that is provably safe under crashes and fair under uneven load, exercising every consume-side control in this chapter.

**Requirements.**
1. Declare a durable work queue with a dead-letter exchange, and run a pool of N manual-ack consumers each with a tuned prefetch.
2. Implement the three-way failure decision — ack on success, bounded requeue on transient failure, dead-letter on deterministic/poison failure — using the `redelivered` flag or a retry-count header to bound retries.
3. Inject a mix of fast, slow, and poison messages and demonstrate: no loss on a killed consumer, fair distribution across the pool, and poison messages ending up in the dead-letter queue rather than looping.
4. Instrument `messages_ready`, `messages_unacknowledged`, redelivery rate, and per-consumer ack rate, and correlate them with the injected workload.
5. Sweep the prefetch value and record throughput and fairness at each, identifying the best value for the workload's processing-time variance.

**Extensions.**
- Add exponential backoff for transient retries using a delay queue (TTL + DLX) rather than immediate requeue, and compare recovery behaviour under a flapping downstream.
- Add graceful shutdown that cancels consumers, drains in-flight messages, and exits with zero loss and zero duplicate acks.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Exchanges, Queues & Bindings (AMQP 0-9-1)* (where messages come from), *Reliability: Publisher Confirms, Durability & the Mandatory Flag* (the producer-side safety that pairs with consumer acks), *Dead-Letter Exchanges, TTL & Delayed Messages* (where poison messages go), *Idempotency, Deduplication & the Outbox Pattern* (making at-least-once safe), *Backpressure, Flow Control & Poison Messages* (prefetch as backpressure at scale).

- **RabbitMQ — Consumer Acknowledgements & Publisher Confirms** — RabbitMQ · *Intermediate* · the definitive reference on ack modes, redelivery, and the `redelivered` flag. <https://www.rabbitmq.com/docs/confirms>
- **RabbitMQ — Consumer Prefetch** — RabbitMQ · *Intermediate* · exactly what `basic.qos` limits, and the `global` flag semantics. <https://www.rabbitmq.com/docs/consumer-prefetch>
- **RabbitMQ — Tutorial 2 (Work Queues)** — RabbitMQ · *Beginner* · manual acks and fair dispatch with runnable code, the practical starting point. <https://www.rabbitmq.com/tutorials/tutorial-two-python>
- **RabbitMQ — Reliability Guide** — RabbitMQ · *Advanced* · how acks, confirms, and durability combine into an end-to-end no-loss story. <https://www.rabbitmq.com/docs/reliability>
- **rabbitmq/amqp091-go — consumer examples** — RabbitMQ (GitHub) · *Intermediate* · the Go client used here, with manual-ack and QoS examples. <https://github.com/rabbitmq/amqp091-go>
- **RabbitMQ — Consumers (Cancellation & Prefetch)** — RabbitMQ · *Intermediate* · consumer lifecycle, cancel notifications, and prefetch interactions. <https://www.rabbitmq.com/docs/consumers>
- **CloudAMQP — RabbitMQ Best Practices** — CloudAMQP · *Intermediate* · practical guidance on prefetch tuning and ack discipline from an operator's view. <https://www.cloudamqp.com/blog/part1-rabbitmq-best-practice.html>
- **Enterprise Integration Patterns — Guaranteed Delivery & Transactional Client** — Hohpe & Woolf · *Intermediate* · the patterns behind acknowledgement and at-least-once delivery. <https://www.enterpriseintegrationpatterns.com/patterns/messaging/GuaranteedMessaging.html>

---

*Kafka & RabbitMQ Handbook — chapter 08.*
