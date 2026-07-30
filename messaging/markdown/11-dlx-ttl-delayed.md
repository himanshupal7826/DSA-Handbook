# 11 · Dead Letter Exchanges, TTL & Delayed Messages

> **In one line:** A message that a consumer cannot process must not be requeued to fail forever — RabbitMQ's answer is the *dead-letter exchange*, and by combining it with message TTL you get the two things every real system needs, a **delayed-retry-with-backoff** loop and a **parking queue** for messages that will never succeed, all built from the broker's own primitives rather than application code.

---

## 1. Overview

Every asynchronous system eventually meets the **poison message**: a message that, no matter how many times you deliver it, the consumer cannot process — a malformed payload, a reference to a deleted entity, a bug that throws on a particular shape of input. The naive reflex is to `nack` with `requeue=true`, but that is a trap: the message goes straight back to the head of the queue, is redelivered immediately, fails again, and you have built a tight infinite loop that pins a CPU and blocks every message behind it. Handling poison messages *correctly* is one of the things that separates a toy RabbitMQ deployment from a production one, and RabbitMQ gives you the tools to do it inside the broker.

The central tool is the **dead-letter exchange (DLX)**. A queue can be configured with `x-dead-letter-exchange`, and when a message is *dead-lettered* — rejected/nacked with `requeue=false`, expired by TTL, or dropped because the queue overflowed a length limit — RabbitMQ republishes it to that exchange instead of discarding it. From there it can go to a "dead-letter queue" for inspection, or, more cleverly, back into a *retry* topology. The second tool is **time-to-live (TTL)**: a message can expire after a set duration (per-message, or per-queue via `x-message-ttl`), and a queue can expire when unused (`x-expires`). The elegant trick that makes robust retries possible is that *a TTL expiry is itself a dead-letter event* — so a message parked in a short-lived "retry queue" that dead-letters back to the main queue becomes a **delayed retry**, and by using increasing TTLs you get **exponential backoff**, all without a scheduler in your code. Finally, for genuinely scheduled or delayed delivery beyond retry loops, the **rabbitmq-delayed-message-exchange plugin** holds a message until its due time before routing it.

This chapter builds the whole thing: the DLX mechanics and the three ways a message gets dead-lettered, the poison-message problem and a complete retry-with-backoff-and-give-up topology, message and queue TTL, and delayed delivery via the plugin — with `amqp091-go` code that declares the topology and the counting logic that eventually parks a message for good.

## 2. Core Concepts

- **Dead-letter exchange (DLX)** — an exchange (named in a queue's `x-dead-letter-exchange` argument) to which the broker republishes messages that are dead-lettered from that queue, instead of discarding them.
- **Dead-lettering** — the act of moving a message out of its queue to the DLX. Happens on three triggers: rejected/nacked with `requeue=false`, TTL expiry, or queue-overflow (max-length reached).
- **Dead-letter routing key** — the routing key used when republishing to the DLX; by default the message's original key, or overridden with `x-dead-letter-routing-key`.
- **Poison message** — a message that always fails processing; if requeued naively it loops forever, blocking the queue.
- **Retry queue** — a queue with a message TTL and a DLX pointing back at the main queue, so an expired message returns for another attempt after a delay.
- **Parking / dead queue** — the terminal queue where messages that exhausted their retries are held for human inspection, so they leave the retry loop.
- **Message TTL** — an expiration for a message: per-message (`expiration` property) or per-queue (`x-message-ttl` argument). On expiry the message is dead-lettered (or dropped if no DLX).
- **Queue TTL (`x-expires`)** — deletes an entire queue after it has been unused (no consumers, no gets) for a period; useful for transient reply/retry queues.
- **`x-death` header** — a header RabbitMQ adds/updates each time a message is dead-lettered, recording the count and reasons; the basis for a max-retries limit.
- **Delayed-message exchange** — a plugin exchange type (`x-delayed-message`) that holds a message for an `x-delay` duration before routing it, for scheduled/delayed delivery.

## 3. Theory & Principles

### The three ways a message gets dead-lettered

Dead-lettering is not a single event; it is triggered by three distinct conditions, and knowing all three is what lets you build retry loops rather than just error sinks:

1. **Reject / nack with `requeue=false`.** The consumer explicitly says "I cannot process this, do not put it back." This is the *deliberate* dead-letter — the consumer decided the message is bad (or has failed too many times) and pushes it out.
2. **TTL expiry.** The message sat in the queue longer than its TTL (per-message or the queue's `x-message-ttl`) without being consumed. This is the *time-based* dead-letter, and it is the mechanism the retry pattern exploits: a message that *nobody consumes* for N milliseconds is dead-lettered automatically.
3. **Queue overflow.** The queue hit its `x-max-length` (or `x-max-length-bytes`) with `overflow=reject-publish-dlx` or the default drop-head behaviour, so the oldest (or rejected) message is dead-lettered. This is the *capacity* dead-letter, protecting the queue from unbounded growth.

When any of these fires, RabbitMQ republishes the message to the queue's DLX with the configured routing key, and — crucially — records the event in the message's **`x-death`** header, appending or incrementing a count per (queue, reason) pair. That header is the state that lets you count attempts *without* storing anything in your application.

### The poison-message problem and the retry-with-DLX pattern

Consider a consumer that nacks-with-requeue on any failure. A message that always fails is redelivered instantly and endlessly — a busy loop that consumes CPU, floods your logs, and (because it sits at the head of the queue) blocks well-formed messages behind it. This is the poison-message problem, and requeue-in-place cannot solve it because it has no notion of *delay* or *giving up*.

The fix composes DLX and TTL into a loop with an escape hatch:

- The **main queue** dead-letters (via nack `requeue=false`) to a **retry exchange**, which routes to a **retry queue**.
- The **retry queue** has *no consumer*, a **message TTL** (say 10s), and its *own* DLX pointing back to the **main exchange**. So a message sits in the retry queue doing nothing, its TTL expires, and it is dead-lettered *back to the main queue* — a **delayed retry**. The consumer sees it again 10s later, not instantly.
- For **exponential backoff**, use several retry queues with increasing TTLs (10s, 1m, 5m) and route to progressively slower ones based on the attempt count.
- The **escape hatch**: before nacking, the consumer reads the `x-death` count (or a custom `x-retry-count` header). If it exceeds the max (say 5), it dead-letters to a **parking queue** instead of the retry loop, where the message waits for a human. This is what stops the loop from being infinite — eventually the system gives up.

The beauty is that all the *timing and routing* live in the broker's TTL and DLX configuration; the application only counts and decides "retry or park". No scheduler, no `sleep`, no delay queue in code.

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="d1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="d2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="d3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Retry-with-DLX-and-backoff: a delayed-retry loop with an escape hatch</text>

  <rect x="40" y="54" width="120" height="52" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="100" y="76" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">main exchange</text>
  <text x="100" y="94" text-anchor="middle" fill="#1d4ed8" font-size="9">orders</text>

  <rect x="240" y="54" width="120" height="52" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="300" y="76" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">main queue</text>
  <text x="300" y="94" text-anchor="middle" fill="#166534" font-size="9">consumer works here</text>

  <rect x="440" y="54" width="130" height="52" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="505" y="76" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">worker / consumer</text>
  <text x="505" y="94" text-anchor="middle" fill="#6d28d9" font-size="9">success &#8594; ack</text>

  <path d="M160,80 L238,80" stroke="#16a34a" stroke-width="2" marker-end="url(#d2)"/>
  <path d="M360,80 L438,80" stroke="#16a34a" stroke-width="2" marker-end="url(#d2)"/>

  <rect x="240" y="170" width="120" height="52" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="300" y="190" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">retry queue</text>
  <text x="300" y="206" text-anchor="middle" fill="#b45309" font-size="8">TTL=10s, NO consumer</text>
  <text x="300" y="217" text-anchor="middle" fill="#b45309" font-size="8">DLX &#8594; main exchange</text>

  <path d="M440,100 Q400,150 360,182" stroke="#dc2626" stroke-width="2" marker-end="url(#d1)"/>
  <text x="430" y="150" fill="#b91c1c" font-size="9">fail &amp; retries&lt;max:</text>
  <text x="430" y="164" fill="#991b1b" font-size="8">nack requeue=false</text>
  <text x="430" y="176" fill="#991b1b" font-size="8">&#8594; dead-letter to retry</text>

  <path d="M240,196 Q120,150 100,108" stroke="#d97706" stroke-width="2" marker-end="url(#d3)"/>
  <text x="120" y="180" fill="#b45309" font-size="9">TTL expires (nobody consumes)</text>
  <text x="120" y="194" fill="#b45309" font-size="8">= a dead-letter event</text>
  <text x="120" y="206" fill="#b45309" font-size="8">&#8594; DLX back to main exchange</text>

  <rect x="620" y="170" width="130" height="52" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="685" y="190" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">parking queue</text>
  <text x="685" y="206" text-anchor="middle" fill="#991b1b" font-size="8">retries &#8805; max</text>
  <text x="685" y="217" text-anchor="middle" fill="#991b1b" font-size="8">human inspects</text>

  <path d="M505,108 Q600,150 640,168" stroke="#dc2626" stroke-width="2" marker-end="url(#d1)"/>
  <text x="600" y="130" fill="#b91c1c" font-size="9">fail &amp; retries&#8805;max:</text>
  <text x="600" y="144" fill="#991b1b" font-size="8">&#8594; park (give up)</text>

  <rect x="40" y="250" width="800" height="210" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="272" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Why this works &#8212; and why naive requeue does not</text>
  <text x="60" y="298" fill="#b91c1c" font-size="10" font-weight="bold">Naive: nack requeue=true</text>
  <text x="60" y="316" fill="#991b1b" font-size="10">&#8226; message returns to head instantly &#8594; fails again instantly &#8594; tight infinite loop</text>
  <text x="60" y="332" fill="#991b1b" font-size="10">&#8226; pins CPU, floods logs, BLOCKS every good message behind it</text>
  <text x="60" y="360" fill="#15803d" font-size="10" font-weight="bold">Retry-with-DLX:</text>
  <text x="60" y="378" fill="#166534" font-size="10">&#8226; the DELAY comes from a TTL on the retry queue (no consumer) &#8212; a TTL expiry IS a dead-letter event</text>
  <text x="60" y="394" fill="#166534" font-size="10">&#8226; increasing TTLs across several retry queues (10s &#8594; 1m &#8594; 5m) give EXPONENTIAL BACKOFF</text>
  <text x="60" y="410" fill="#166534" font-size="10">&#8226; the x-death header counts attempts &#8594; over max, dead-letter to the PARKING queue and stop</text>
  <text x="60" y="436" fill="#334155" font-size="10" font-weight="bold">All timing/routing lives in broker config; the app only counts and decides retry-or-park.</text>
</svg>
```

### TTL is delay, and delay is a scheduler you did not write

The deep principle worth internalising is that **a TTL on a consumer-less queue is a delay primitive**. Put a message somewhere with no one to take it and a time limit, and it will re-emerge (via the DLX) exactly when the time limit passes. That single insight turns RabbitMQ's TTL + DLX into a general-purpose delayed-execution mechanism — retries are the obvious use, but "process this in 30 minutes" is the same trick. Its one important limitation: RabbitMQ expires messages only when they reach the *head* of the queue (it checks the front), so with a *per-message* TTL, a message with a short TTL sitting *behind* one with a long TTL will not be dead-lettered until the one in front is dealt with. Per-*queue* TTL (`x-message-ttl`, uniform for all messages) avoids this because all messages expire in order. This head-of-line caveat is why backoff is usually done with *several fixed-TTL queues* rather than one queue with varying per-message TTLs — and it is exactly the limitation the delayed-message plugin removes.

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="dl1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="dl2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="dl3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Retry-with-DLX: bounded delayed retries, then a parking queue</text>

  <rect x="40" y="60" width="150" height="56" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="115" y="84" text-anchor="middle" fill="#15803d" font-weight="bold">main queue</text>
  <text x="115" y="102" text-anchor="middle" fill="#166534" font-size="9">consumer processes</text>

  <rect x="360" y="60" width="160" height="56" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="80" text-anchor="middle" fill="#92400e" font-weight="bold">retry queue</text>
  <text x="440" y="98" text-anchor="middle" fill="#b45309" font-size="9">x-message-ttl = backoff (e.g. 30s)</text>
  <text x="440" y="110" text-anchor="middle" fill="#b45309" font-size="9">no consumer &#8212; it just waits</text>

  <rect x="690" y="60" width="150" height="56" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="765" y="80" text-anchor="middle" fill="#b91c1c" font-weight="bold">parking queue</text>
  <text x="765" y="98" text-anchor="middle" fill="#991b1b" font-size="9">the dead-letter graveyard</text>
  <text x="765" y="110" text-anchor="middle" fill="#991b1b" font-size="9">alert + inspect by hand</text>

  <path d="M192,74 L356,74" stroke="#dc2626" stroke-width="2" marker-end="url(#dl2)"/>
  <text x="274" y="66" text-anchor="middle" fill="#b91c1c" font-size="9">nack (requeue=false) &#8594; dead-lettered to retry</text>
  <text x="274" y="132" text-anchor="middle" fill="#b91c1c" font-size="8">x-dead-letter-exchange = retry</text>

  <path d="M440,118 Q440,170 200,170 Q120,170 118,120" stroke="#d97706" stroke-width="2" fill="none" marker-end="url(#dl3)"/>
  <text x="300" y="186" text-anchor="middle" fill="#b45309" font-size="9">TTL expires &#8594; dead-lettered BACK to main for another attempt</text>

  <path d="M522,88 L686,88" stroke="#dc2626" stroke-width="2" marker-end="url(#dl2)"/>
  <text x="604" y="72" text-anchor="middle" fill="#b91c1c" font-size="9">retries exhausted</text>
  <text x="604" y="132" text-anchor="middle" fill="#b91c1c" font-size="8">x-death count &#8805; max</text>

  <rect x="40" y="212" width="800" height="150" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="234" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The flow of one poison message</text>
  <text x="56" y="258" fill="#475569" font-size="10">1. Consumer fails &#8594; basic.nack with requeue=FALSE (requeue=true would spin it forever, blocking the queue).</text>
  <text x="56" y="278" fill="#475569" font-size="10">2. The main queue's DLX routes it to the retry queue, which has a TTL but no consumer &#8212; so it just sits for the backoff.</text>
  <text x="56" y="298" fill="#475569" font-size="10">3. TTL expires &#8594; the retry queue dead-letters it BACK to the main queue &#8594; the consumer tries again (delayed retry).</text>
  <text x="56" y="318" fill="#475569" font-size="10">4. Each hop appends to the x-death header; when the death count reaches the max, route to the parking queue instead.</text>
  <text x="56" y="342" fill="#334155" font-size="10" font-weight="bold">Why a retry queue and not requeue=true: requeue redelivers immediately with no backoff and can livelock the queue.</text>
</svg>
```

The full retry topology and the flow of one failing message:

1. **Declare the topology.** A `main` exchange → `main` queue configured with `x-dead-letter-exchange=retry`. A `retry` exchange → `retry` queue configured with `x-message-ttl=10000` and `x-dead-letter-exchange=main` (pointing *back*). A `parking` exchange → `parking` queue with no TTL. For backoff, several retry queues with TTLs 10s/60s/300s.
2. **First delivery.** A message arrives in `main`; the consumer tries to process it and fails (a transient downstream outage, say).
3. **Decide retry or park.** The consumer inspects the `x-death` header (or a custom counter) for the number of prior attempts. Below the max, it nacks `requeue=false`, dead-lettering the message to the `retry` exchange.
4. **Delay in the retry queue.** The message lands in the `retry` queue, which has no consumer. It waits out the TTL. When the TTL expires, RabbitMQ dead-letters it — because the retry queue's DLX is `main`, the message goes *back* to the main queue for another attempt, now delayed by 10s.
5. **Backoff.** On each subsequent failure, the consumer routes to a *slower* retry queue (60s, then 300s), so the delay grows — classic exponential backoff, implemented as routing choices over fixed-TTL queues.
6. **Give up.** Once `x-death` shows the attempt count has reached the max, the consumer dead-letters to the `parking` queue instead. The message leaves the loop and waits for a human, who can fix the data or the code and republish it. The queue is never blocked and the loop is never infinite.

For **scheduled** (not retry) delays — "send this reminder in 24 hours", "release this at 9am" — the TTL trick works but the head-of-line caveat and the awkwardness of arbitrary per-message delays make the **rabbitmq-delayed-message-exchange plugin** the better tool. You declare an exchange of type `x-delayed-message` (with an `x-delayed-type` of, e.g., `direct`), and publish with an `x-delay` header in milliseconds; the exchange holds the message internally until the delay elapses, then routes it normally. It handles arbitrary per-message delays without the head-of-line problem, at the cost of being a plugin (extra operational surface) and holding delayed messages in the exchange's own store.

## 5. Implementation

A complete retry-with-backoff topology in `amqp091-go`: declaring the queues with the right arguments, and a consumer that counts attempts via `x-death` and decides retry-or-park.

### Declaring the DLX + retry + parking topology

```go
package main

import (
	"log"

	amqp "github.com/rabbitmq/amqp091-go"
)

// declareTopology wires the main queue to a retry loop and a parking queue.
// The whole retry/backoff behaviour is expressed as queue ARGUMENTS here; the
// consumer code stays simple.
func declareTopology(ch *amqp.Channel) error {
	// Exchanges: main (live traffic), retry (holding pen), parking (give up).
	for _, ex := range []string{"main", "retry", "parking"} {
		if err := ch.ExchangeDeclare(ex, "direct", true, false, false, false, nil); err != nil {
			return err
		}
	}

	// MAIN queue: on nack(requeue=false) it dead-letters to the "retry" exchange.
	_, err := ch.QueueDeclare("main.q", true, false, false, false, amqp.Table{
		"x-dead-letter-exchange": "retry",
		// keep the same routing key on dead-letter so it lands in the right retry q
	})
	if err != nil {
		return err
	}
	if err := ch.QueueBind("main.q", "orders", "main", false, nil); err != nil {
		return err
	}

	// RETRY queues: NO consumer, a message TTL, and a DLX pointing BACK to main.
	// A message sits here until the TTL expires; the expiry is a dead-letter
	// event that routes it back to "main" for another attempt — a DELAYED retry.
	// Three tiers give exponential backoff: 10s -> 60s -> 300s.
	backoffs := map[string]int32{"retry.10s": 10000, "retry.60s": 60000, "retry.300s": 300000}
	for name, ttl := range backoffs {
		_, err := ch.QueueDeclare(name, true, false, false, false, amqp.Table{
			"x-message-ttl":             ttl,    // the delay
			"x-dead-letter-exchange":    "main", // expire -> back to main
			"x-dead-letter-routing-key": "orders",
		})
		if err != nil {
			return err
		}
		// Bind each retry queue under its own key so the consumer can pick a tier.
		if err := ch.QueueBind(name, name, "retry", false, nil); err != nil {
			return err
		}
	}

	// PARKING queue: terminal. No TTL, no DLX. Messages that exhausted retries
	// rest here for a human to inspect and, once fixed, republish.
	if _, err := ch.QueueDeclare("parking.q", true, false, false, false, nil); err != nil {
		return err
	}
	return ch.QueueBind("parking.q", "orders", "parking", false, nil)
}

func main() {
	conn, _ := amqp.Dial("amqp://guest:guest@localhost:5672/")
	defer conn.Close()
	ch, _ := conn.Channel()
	defer ch.Close()
	if err := declareTopology(ch); err != nil {
		log.Fatal(err)
	}
	log.Println("retry topology declared")
}
```

### Consumer: count attempts, choose a backoff tier, or park

```go
package main

import (
	"context"
	"log"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

const maxAttempts = 5

// deathCount reads the x-death header RabbitMQ maintains: each dead-letter
// appends/updates an entry with a "count". We sum the counts to know how many
// times this message has already been dead-lettered from the main queue.
func deathCount(h amqp.Table) int64 {
	raw, ok := h["x-death"]
	if !ok {
		return 0
	}
	deaths, ok := raw.([]interface{})
	if !ok {
		return 0
	}
	var total int64
	for _, d := range deaths {
		if entry, ok := d.(amqp.Table); ok {
			if c, ok := entry["count"].(int64); ok {
				total += c
			}
		}
	}
	return total
}

// tierFor picks a backoff queue by attempt number: later attempts wait longer.
func tierFor(attempt int64) string {
	switch {
	case attempt <= 1:
		return "retry.10s"
	case attempt == 2:
		return "retry.60s"
	default:
		return "retry.300s"
	}
}

func main() {
	conn, _ := amqp.Dial("amqp://guest:guest@localhost:5672/")
	defer conn.Close()
	ch, _ := conn.Channel()
	defer ch.Close()
	_ = ch.Qos(10, 0, false)

	msgs, _ := ch.Consume("main.q", "", false /*manual ack*/, false, false, false, nil)

	for d := range msgs {
		err := process(d.Body)
		if err == nil {
			_ = d.Ack(false)
			continue
		}

		attempts := deathCount(d.Headers)
		if attempts >= maxAttempts {
			// GIVE UP: republish to the parking exchange, then ack the original so
			// it leaves the main queue. We publish explicitly (rather than nack to
			// a DLX) so we control the destination precisely.
			log.Printf("parking after %d attempts: %s", attempts, d.Body)
			_ = publishTo(ch, "parking", "orders", d)
			_ = d.Ack(false)
			continue
		}

		// RETRY with backoff: republish to the chosen retry tier, then ack the
		// original. The retry queue's TTL provides the delay; its DLX sends the
		// message back to main when the TTL expires.
		tier := tierFor(attempts)
		log.Printf("retry #%d via %s: %s", attempts+1, tier, d.Body)
		_ = publishTo(ch, "retry", tier, d)
		_ = d.Ack(false)
	}
}

// publishTo re-emits the delivery to another exchange, preserving headers (so
// x-death survives) and persistence.
func publishTo(ch *amqp.Channel, exchange, key string, d amqp.Delivery) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return ch.PublishWithContext(ctx, exchange, key, false, false, amqp.Publishing{
		DeliveryMode: amqp.Persistent,
		ContentType:  d.ContentType,
		MessageId:    d.MessageId,
		Headers:      d.Headers, // carry x-death forward so the count keeps growing
		Body:         d.Body,
	})
}

func process(body []byte) error {
	// ... real processing; return a non-nil error to trigger the retry path ...
	return errFail
}

var errFail = &processingError{}

type processingError struct{}

func (*processingError) Error() string { return "downstream unavailable" }
```

### Delayed-message plugin — scheduled delivery

```go
// Requires: rabbitmq-plugins enable rabbitmq_delayed_message_exchange
package main

import (
	"context"
	"log"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func main() {
	conn, _ := amqp.Dial("amqp://guest:guest@localhost:5672/")
	defer conn.Close()
	ch, _ := conn.Channel()
	defer ch.Close()

	// Declare a delayed exchange: type "x-delayed-message", with x-delayed-type
	// naming the routing behaviour to apply once the delay elapses (here: direct).
	err := ch.ExchangeDeclare("scheduler", "x-delayed-message", true, false, false, false,
		amqp.Table{"x-delayed-type": "direct"})
	if err != nil {
		log.Fatal(err)
	}
	_, _ = ch.QueueDeclare("reminders.q", true, false, false, false, nil)
	_ = ch.QueueBind("reminders.q", "reminder", "scheduler", false, nil)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Publish with x-delay (milliseconds). The exchange HOLDS the message and
	// routes it only after 24h — no head-of-line problem, arbitrary per-message
	// delays, unlike the TTL trick.
	_ = ch.PublishWithContext(ctx, "scheduler", "reminder", false, false, amqp.Publishing{
		DeliveryMode: amqp.Persistent,
		Headers:      amqp.Table{"x-delay": int32(24 * time.Hour / time.Millisecond)},
		Body:         []byte("send-24h-reminder"),
	})
	log.Println("scheduled a reminder for +24h")
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Poison messages are contained, not fatal.** A message that always fails is delayed, retried a bounded number of times, and finally parked — it never blocks the queue or loops forever.
- **Backoff without a scheduler.** TTL-on-a-consumerless-queue is a delay primitive, so retry timing and exponential backoff are pure broker configuration; the application only counts and routes.
- **Inspectable failures.** The parking queue is a durable record of what could not be processed, with the full `x-death` history, so operators can diagnose and replay.
- **Flexible expiry and scheduling.** Message and queue TTL bound how long data lives; the delayed-message plugin gives true scheduled delivery for arbitrary delays.

**Disadvantages**
- **Topology complexity.** A robust retry setup is several exchanges and queues with interlocking DLX/TTL arguments — more to declare, document and get exactly right.
- **Per-message TTL head-of-line blocking.** With varying per-message TTLs in one queue, a short-TTL message behind a long-TTL one is not expired until the front clears; you must use per-queue TTLs or the plugin to avoid it.
- **Plugin operational cost.** The delayed-message exchange is a plugin: extra surface to install, upgrade and reason about, and its held messages have their own storage and clustering caveats.

**Trade-offs**
- *DLX-retry loop vs delayed-message plugin:* the TTL loop is built-in and needs no plugin but is coarse (fixed tiers) and has the head-of-line caveat; the plugin gives arbitrary per-message delays cleanly but adds operational surface and has replication limitations. Use tiers for retries, the plugin for arbitrary scheduling.
- *Immediate requeue vs delayed retry:* requeue-in-place is one line and fine for genuinely transient blips, but for anything that might fail repeatedly it becomes a busy loop — the delayed DLX retry is the safe general default.
- *How many retries / how much backoff:* more retries and longer backoff tolerate longer outages but delay the point at which a truly broken message is surfaced to a human; tune the max-attempts and tier durations to your recovery-time expectations.

## 7. Common Mistakes & Best Practices

- **Nack-with-requeue on every failure.** The classic poison-message trap: an always-failing message is redelivered instantly and endlessly, pinning CPU and blocking the queue. Use a delayed DLX retry instead.
- **A DLX with no give-up.** Building the retry loop but never checking the attempt count, so a permanently-bad message cycles through the retry queues forever. Always cap attempts and park.
- **Forgetting the retry queue must have no consumer.** If something consumes the retry queue, the TTL never gets a chance to expire the message, and the delay mechanism breaks.
- **Per-message TTL head-of-line surprise.** Expecting each message to expire exactly on its own TTL in a shared queue; a long-TTL message at the head holds up short-TTL ones behind it. Use per-queue TTLs (fixed tiers) or the plugin.
- **Losing the x-death header on republish.** Manually republishing without carrying the headers forward, so the attempt count resets and the message never reaches the give-up limit. Preserve headers.
- **Dead-lettering without persistence.** Non-persistent messages in a durable retry/parking queue are lost on a broker restart — the very messages you most want to keep. Publish persistent throughout the loop.
- **Using the plugin where tiers suffice.** Installing the delayed-message plugin for simple retries when fixed-TTL retry queues would do, adding operational surface for no gain.
- **Best practice:** build the standard topology — main queue → tiered retry queues (fixed per-queue TTLs, DLX back to main) → parking queue — count attempts from `x-death`, cap and park, keep everything persistent, and reserve the delayed-message plugin for genuine arbitrary-delay scheduling.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When messages "disappear", check whether they were dead-lettered: inspect the retry and parking queues, and read the `x-death` header on a sample message — it lists every queue the message was dead-lettered from, the reason (`rejected`, `expired`, `maxlen`), and the count, which reconstructs the message's whole failure history. A parking queue filling up is your signal that a class of messages is systematically failing; a retry queue that never drains means the TTL is too long or the DLX is misconfigured (a message dead-lettering to the wrong exchange goes in circles or gets stuck).
- **Monitoring.** Alert on **parking-queue depth** (systematic failures — this should be near zero and every entry investigated), **retry-queue depth and age** (transient-failure volume; a spike means a downstream dependency is struggling), and **redelivery/dead-letter rate**. Track the ratio of parked to processed as a data-quality/health signal. Watch that retry queues actually drain on schedule, which confirms the TTL/DLX loop is intact.
- **Security.** The parking queue accumulates *failed* messages, which often contain exactly the malformed or suspicious payloads worth inspecting — protect it with least-privilege access, and be careful that replaying a parked message does not re-trigger a malicious payload. TTLs are also a mild denial-of-service consideration: an attacker who can publish with huge volumes to a TTL-expiring queue can pressure the DLX target; bound queue lengths (`x-max-length`) so overflow itself dead-letters rather than exhausting memory.
- **Scaling.** Retry and parking queues are extra queues the broker must hold, and under a large outage the retry queues can balloon; set `x-max-length` on them so they overflow-dead-letter to parking rather than growing without bound. The delayed-message plugin holds all pending delayed messages in the exchange, which does not shard and has known limitations in clusters, so for very high volumes of scheduled messages prefer an external scheduler that publishes on time. Ensure retry/parking queues are quorum queues (chapter 12) if the messages in them must survive a node loss.

## 9. Interview Questions

**Q: What is a dead-letter exchange and when does a message get dead-lettered?**
A: A dead-letter exchange is an exchange, named in a queue's `x-dead-letter-exchange` argument, to which RabbitMQ republishes messages that leave the queue abnormally instead of discarding them. A message is dead-lettered on three triggers: it is rejected or nacked with `requeue=false` (the consumer refuses it), its TTL expires while it sits unconsumed in the queue, or the queue overflows its maximum length. On any of these the broker republishes the message to the DLX with a routing key (the original, or an override), and records the event in the message's `x-death` header. The DLX turns "the message left the queue" from silent loss into a controllable, routable event.

**Q: What is the poison-message problem and why doesn't requeue solve it?**
A: A poison message is one the consumer can never successfully process — bad data, a bug, a missing dependency. The instinct is to nack it with `requeue=true` so it goes back for another try, but that puts it straight back at the head of the queue where it is redelivered immediately, fails again immediately, and forms a tight infinite loop that consumes CPU, floods logs, and blocks every well-formed message behind it. Requeue-in-place has no notion of delay or of giving up, so it cannot break the loop. The correct solution introduces both — a delayed retry via a DLX-and-TTL loop, and a bounded attempt count after which the message is parked.

**Q: How do you build delayed retries using only TTL and DLX?**
A: You exploit the fact that a TTL expiry is itself a dead-letter event. The main queue dead-letters a failed message to a retry queue that has a message TTL and no consumer. The message sits in the retry queue doing nothing until the TTL expires; because the retry queue's own dead-letter exchange points back at the main exchange, the expiry sends the message back to the main queue — a retry delayed by exactly the TTL. For exponential backoff you use several retry queues with increasing TTLs (10s, 1m, 5m) and route to a slower tier as the attempt count grows. All the timing is broker configuration; the application only counts attempts and picks a tier.

**Q: How do you stop a retry loop from being infinite?**
A: You count attempts and give up past a threshold. RabbitMQ maintains an `x-death` header that records, per queue and reason, how many times a message has been dead-lettered, so before retrying the consumer reads that count (or a custom header). If it is below the maximum, the consumer routes the message into the retry loop; if it has reached the maximum, the consumer instead sends it to a parking (dead) queue, where it leaves the loop and waits for human inspection. That give-up step is what bounds the loop — without it, a permanently-bad message would cycle through the retry tiers forever.

**Q: What is the difference between message TTL and queue TTL?**
A: Message TTL is how long a *message* may live before it is dead-lettered (or dropped if there is no DLX). It can be set per-message via the `expiration` property or per-queue via the `x-message-ttl` argument, which applies uniformly to all messages in that queue. Queue TTL, set via `x-expires`, is different: it deletes an *entire queue* after the queue has been unused — no consumers and no basic.get — for the configured period. Message TTL bounds how long data waits; queue TTL cleans up transient queues (like per-client reply or retry queues) that would otherwise linger after their purpose is served.

**Q: When would you use the delayed-message plugin instead of the TTL trick?**
A: When you need arbitrary, per-message scheduled delays rather than a few fixed retry tiers — "send this in 24 hours", "release at 9am" with each message having its own due time. The TTL trick struggles here because expiry is checked at the head of the queue, so a per-message TTL means a short-delay message stuck behind a long-delay one is not released on time (head-of-line blocking); avoiding that forces you into fixed per-queue TTLs. The `rabbitmq-delayed-message-exchange` plugin holds each message in the exchange until its own `x-delay` elapses and then routes it, handling arbitrary per-message delays with no head-of-line problem — at the cost of being a plugin with its own storage and clustering caveats.

**Q: (Senior) Design a complete failure-handling topology for a payment-processing queue and justify each piece.**
A: I would build a main queue that consumers process, wired to a tiered retry loop and a terminal parking queue. The main queue's `x-dead-letter-exchange` points at a retry exchange; there are three retry queues with fixed per-queue TTLs — say 30s, 5m, 30m — each with a DLX pointing back to the main exchange, and each with no consumer so the TTL can expire and re-emit the message. On a *transient* failure (a downstream gateway timeout), the consumer republishes to the appropriate tier by attempt count, giving exponential backoff that rides out short outages without hammering the gateway. I distinguish transient from *permanent* failures explicitly: a malformed or fraudulent message that will never succeed is sent straight to parking, not retried, because retrying it wastes time and delays surfacing it. The attempt count comes from the `x-death` header, and past the max (say 5) the message is parked. The parking queue has no TTL and no DLX — it is the terminal record, protected by least-privilege access because it holds sensitive failed payments, and monitored so any entry is investigated promptly. Everything is persistent and, given payments, the queues are quorum queues so a node loss does not drop in-flight or parked messages. I would set `x-max-length` with overflow-to-DLX on the retry queues so a massive outage cannot balloon them unbounded. The justification throughout is that transient failures need *delay and bounded retry*, permanent failures need *fast parking and human attention*, and money messages need *durability and access control* — and the DLX/TTL primitives express all three inside the broker.

**Q: (Senior) What are the failure modes and limitations of the TTL-and-DLX retry pattern, and how do you mitigate them?**
A: Several, and a mature design accounts for each. First, per-message TTL head-of-line blocking: if you vary TTLs within a single queue, a message with a short TTL behind one with a long TTL is not expired until the front is dealt with, so delays are wrong — mitigated by using fixed per-queue TTLs (one queue per backoff tier) rather than per-message TTLs, which expire in order. Second, the retry queue must have *no consumer*; if monitoring tools or a stray consumer pull from it, messages leave before the TTL expires and the delay is lost — mitigated by convention and access control. Third, the `x-death` count can be reset if a message is republished without carrying its headers forward (a common bug when re-emitting manually), so the give-up limit never triggers — mitigated by always preserving headers on republish. Fourth, durability: non-persistent messages in the retry/parking queues are lost on a restart, and these are the messages you most want to keep — mitigated by publishing persistent and using quorum queues. Fifth, unbounded growth: during a long downstream outage the retry queues can fill with everything that failed, pressuring broker memory — mitigated by `x-max-length` with overflow-to-DLX so overflow itself dead-letters to parking. Sixth, the loop can misroute: a DLX pointing at the wrong exchange sends messages in circles or strands them, so I test the topology by tracing a single failing message end-to-end through the `x-death` history before trusting it. The meta-point is that the pattern is powerful precisely because it pushes timing and routing into broker config, but that same indirection makes misconfiguration subtle, so it must be verified by observation, not assumed.

**Q: (Senior) How does the `x-death` header work and why is it central to robust retries?**
A: The `x-death` header is the state RabbitMQ maintains about a message's dead-letter history, and it is what lets the retry pattern count attempts without any external storage. Each time a message is dead-lettered, RabbitMQ adds or updates an entry in `x-death` — an array of tables, one per (queue, reason) pair — containing the queue name, the reason (`rejected`, `expired`, or `maxlen`), the original routing keys, a timestamp, and crucially a `count` that increments on repeated dead-lettering from the same queue. To know how many times a message has been through the loop, the consumer reads and sums those counts, and compares against its maximum before deciding to retry or park. It is central because it makes the retry mechanism *stateless in the application*: the message carries its own attempt history, so any consumer instance can make the retry-or-give-up decision correctly without a shared counter or database, which is exactly what you want in a horizontally-scaled consumer pool. The one caveat is that the header only persists if you carry it forward when re-emitting the message, so preserving headers on republish is not optional — drop them and the count resets and the give-up limit silently never fires.

## 10. Quick Revision & Cheat Sheet

| Concept | Argument / property | Effect |
|---|---|---|
| Dead-letter exchange | `x-dead-letter-exchange` | Where dead-lettered messages go |
| DLX routing key | `x-dead-letter-routing-key` | Key used when republishing to DLX |
| Per-queue message TTL | `x-message-ttl` | All messages expire after N ms → dead-lettered |
| Per-message TTL | `expiration` property | This message expires after N ms (head-of-line caveat) |
| Queue TTL | `x-expires` | Delete the whole queue after unused N ms |
| Max length | `x-max-length` / `-bytes` | Overflow dead-letters (or drops) oldest |
| Attempt history | `x-death` header | Count + reasons per dead-letter, for max-retries |
| Scheduled delay | `x-delayed-message` exchange + `x-delay` | Hold then route after a per-message delay (plugin) |

| Dead-letter trigger | Cause |
|---|---|
| Reject / nack `requeue=false` | Consumer refuses the message |
| TTL expiry | Message sat unconsumed past its TTL |
| Queue overflow | Queue hit `x-max-length` |

**Flash cards**
- **Three ways a message dead-letters?** → Nack/reject `requeue=false`, TTL expiry, queue overflow.
- **How do you delay a retry with no scheduler?** → A retry queue with a TTL and no consumer, DLX back to main.
- **How do you get exponential backoff?** → Several retry queues with increasing fixed TTLs, routed by attempt count.
- **How do you stop an infinite loop?** → Count `x-death`, park past the max.
- **Per-message TTL gotcha?** → Head-of-line: expiry checked at the queue head only.
- **When to use the delayed-message plugin?** → Arbitrary per-message scheduled delays, no head-of-line problem.

## 11. Hands-On Exercises & Mini Project

- [ ] Configure a queue with a DLX and a dead-letter queue; nack a message with `requeue=false` and watch it appear in the DLQ.
- [ ] Build a single retry queue with a 10s TTL and a DLX back to the main queue; fail a message and confirm it returns for retry ~10s later.
- [ ] Extend to three retry tiers (10s/60s/300s) and route by attempt count to demonstrate exponential backoff.
- [ ] Read the `x-death` header in your consumer and park a message after 5 attempts; confirm the loop terminates.
- [ ] Set a per-message TTL where a short-TTL message sits behind a long-TTL one and observe the head-of-line blocking; fix it with a per-queue TTL.
- [ ] Enable the delayed-message plugin and schedule a message for +30s; confirm it is delivered on time without a retry loop.

### Mini Project — "Resilient Order Processor"

**Goal.** Build an order-processing consumer that survives poison messages and transient outages using DLX, TTL and a parking queue.

**Requirements.**
1. Declare a main queue, three fixed-TTL retry queues (backoff tiers), and a parking queue, all persistent.
2. Implement a consumer that distinguishes transient failures (retry with backoff) from permanent ones (park immediately).
3. Count attempts via `x-death`, carry headers forward on republish, and park after a configurable maximum.
4. Add `x-max-length` with overflow-to-DLX on the retry queues so an outage cannot balloon them.
5. Instrument and graph parking-queue depth, retry-queue depth, and the parked-to-processed ratio.

**Extensions.**
- Add a "republish from parking" operator tool that fixes and re-injects a parked message with a reset attempt count.
- Replace the tiered TTL retries with the delayed-message plugin and compare precision, head-of-line behaviour, and operational cost.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Reliability: Publisher Confirms, Persistence & Mandatory* (keeping the retry/parking messages from being lost), *Design: Routing Patterns — Work Queues, Pub/Sub & RPC* (the work queues these failures come from), *Backpressure, Flow Control & Poison Messages* (the broader poison-message and overload story), *Design: RabbitMQ Clustering, Quorum Queues & HA* (making retry/parking queues survive node loss and quorum-queue delivery limits), *Idempotency, Deduplication & the Outbox Pattern* (why retried messages must be safe to reprocess).

- **RabbitMQ — Dead Letter Exchanges** — RabbitMQ · *Intermediate* · the authoritative reference on dead-lettering triggers, the `x-death` header, and DLX routing. <https://www.rabbitmq.com/docs/dlx>
- **RabbitMQ — Time-To-Live and Expiration** — RabbitMQ · *Intermediate* · message TTL, queue TTL (`x-expires`), and the head-of-line expiry caveat in detail. <https://www.rabbitmq.com/docs/ttl>
- **RabbitMQ — Queue Length Limit** — RabbitMQ · *Intermediate* · `x-max-length`, overflow behaviour, and how overflow interacts with dead-lettering. <https://www.rabbitmq.com/docs/maxlength>
- **RabbitMQ Delayed Message Plugin** — RabbitMQ / GitHub · *Advanced* · the `x-delayed-message` exchange for scheduled delivery, with its clustering limitations noted. <https://github.com/rabbitmq/rabbitmq-delayed-message-exchange>
- **RabbitMQ — Retry and Backoff patterns** — RabbitMQ blog / community · *Intermediate* · the canonical retry-with-DLX-and-TTL topology and its variations. <https://www.rabbitmq.com/docs/dlx#using-dead-letter-exchanges>
- **Enterprise Integration Patterns — Dead Letter Channel & Invalid Message Channel** — Hohpe & Woolf · *Intermediate* · the pattern language behind DLX and parking queues. <https://www.enterpriseintegrationpatterns.com/patterns/messaging/DeadLetterChannel.html>
- **amqp091-go** — RabbitMQ / Go · *Intermediate* · the Go client used here, including queue arguments and header handling for `x-death`. <https://pkg.go.dev/github.com/rabbitmq/amqp091-go>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · the systems view of retries, backoff and poison messages in stream processing. <https://dataintensive.net/>

---

*Kafka & RabbitMQ Handbook — chapter 11.*
