# 09 · Design: Routing Patterns — Work Queues, Pub/Sub & RPC

> **In one line:** RabbitMQ is a routing engine, and almost every design you will build on it is one of three shapes — a *work queue* that shares tasks across competing workers, a *pub/sub* fan-out that broadcasts an event to many independent queues, or *request/reply RPC* bolted on top of the broker — and knowing which shape you need, and how the exchange makes it happen, is the whole game.

---

## 1. Overview

RabbitMQ is a *smart broker*: unlike Kafka, where a dumb log hands bytes to smart consumers, RabbitMQ puts the routing logic in the middle. A producer never publishes to a queue directly — it publishes to an **exchange**, and the exchange decides which queues receive a copy based on **bindings** and a **routing key**. That single indirection is what makes RabbitMQ so good at the classic messaging patterns, because each pattern is just a different exchange type wired to a different arrangement of queues.

This chapter is a design-round tour of the three patterns that account for the overwhelming majority of RabbitMQ topologies. The **work queue** (competing consumers) is the workhorse: one queue, many workers, each message handled by exactly one of them, so you parallelise a stream of tasks — resize these images, send these emails, fulfil these orders — by adding workers. **Pub/sub** is the broadcast: a *fanout* exchange copies each message to every bound queue, so several independent subsystems each react to the same event without knowing about one another. **Routing** proper — selective delivery — uses *direct* and *topic* exchanges to send a message only to the queues that asked for that class of message, which is pub/sub with a filter. And **RPC** is the awkward but occasionally necessary one: request/reply over a broker, where the caller publishes a request carrying a `reply_to` queue and a `correlation_id`, and the worker publishes the answer back to that queue.

The honest framing, which an interviewer wants to hear, is that the first three are what RabbitMQ was *built* for and the fourth is something you can do but usually should not. Doing synchronous request/reply over an asynchronous broker adds a network hop, a broker dependency, and correlation bookkeeping to an interaction that a plain HTTP or gRPC call handles more simply — so RPC-over-RabbitMQ is often an anti-pattern. But "often" is not "always", and this chapter names the cases where it earns its place. By the end you should be able to look at any requirement and say, without hesitation, which exchange type and queue arrangement expresses it, and whether it belongs on RabbitMQ at all.

## 2. Core Concepts

- **Exchange** — the entry point a producer publishes to. It holds no messages; it *routes* them to queues per its type and the bindings attached to it. Never publish to a queue directly.
- **Queue** — an ordered buffer that holds messages until a consumer acknowledges them. Consumers read from queues, never from exchanges.
- **Binding** — a rule that links an exchange to a queue, optionally qualified by a *binding key* (or header match). The binding is what tells the exchange "send messages matching this to that queue".
- **Routing key** — a string the producer stamps on each message; the exchange matches it against binding keys to decide routing. Its meaning depends on the exchange type.
- **Direct exchange** — routes a message to the queues whose binding key *exactly equals* the routing key. Also the behaviour of the *default* (nameless) exchange, where the routing key is a queue name.
- **Fanout exchange** — ignores the routing key and copies each message to *every* bound queue. The pub/sub broadcast primitive.
- **Topic exchange** — matches routing keys against binding *patterns* with wildcards: `*` matches exactly one dotted word, `#` matches zero or more. Selective, expressive fan-out.
- **Competing consumers** — several consumers on *one* queue, sharing its messages round-robin; the pattern that turns a queue into a parallel worker pool.
- **Prefetch (`basic.qos`)** — a cap on how many unacknowledged messages the broker will push to one consumer at a time; the lever for *fair dispatch* under uneven task durations.
- **Reply-to / correlation id** — the two message properties that make RPC work: `reply_to` names the callback queue for the answer; `correlation_id` lets the caller match a reply to the request it belongs to.

## 3. Theory & Principles

### The producer never talks to a queue

The mental model that unlocks RabbitMQ is that publishing and consuming are *decoupled by the exchange*. A producer knows an exchange name and a routing key; it does not know, and must not care, how many queues exist behind that exchange or who consumes them. A consumer knows a queue; it does not know who publishes. Bindings — created by whoever owns the topology — are the wiring in between. This is why adding a new subscriber to an event is a change to the *consumer side* (declare a queue, bind it) and never to the producer: the producer keeps publishing the same message to the same exchange, oblivious.

Each pattern is then a choice of exchange type and a shape of bindings:

- **Work queue** = a *single* queue with *many consumers*. The message goes to the queue once; the broker load-balances it to one of the competing consumers. You reach it via the default exchange (routing key = queue name) or a direct exchange bound to that one queue.
- **Pub/sub** = a *fanout* exchange bound to *several* queues, one per subscriber. Each subscriber owns its queue; the exchange copies the message to all of them; each subscriber then has its *own* competing-consumer pool if it wants throughput. Fan-out and load-sharing compose.
- **Selective routing** = a *direct* exchange (route on an exact key, e.g. severity `error`) or a *topic* exchange (route on a pattern, e.g. `orders.*.eu`) so each queue receives only the subset it bound for.

### Fair dispatch: why prefetch exists

The subtlety in work queues is that round-robin dispatch is *naive*. By default RabbitMQ pushes the next message to the next consumer regardless of whether that consumer is still chewing on a slow one. Two workers, alternating messages, one gets a run of heavy tasks and the other a run of trivial ones — the heavy worker builds a backlog while the light worker sits idle, because the broker already handed it messages it cannot get to. The fix is **prefetch** (`basic.qos(prefetchCount)`): cap the number of *unacknowledged* messages the broker will send a consumer. With `prefetch=1`, the broker will not dispatch a new message to a consumer until it has acknowledged the previous one, so a fast worker naturally pulls more messages and a slow worker holds just the one it is working — *fair dispatch by pull, not push*. Prefetch is therefore both a correctness lever (fairness) and a flow-control lever (bounding a consumer's in-flight work), and choosing its value is one of the two or three tuning decisions that most affect a RabbitMQ deployment.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Three routing shapes, three exchange types</text>

  <rect x="24" y="40" width="400" height="192" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="224" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">WORK QUEUE &#8212; direct / default exchange, ONE queue</text>
  <rect x="44" y="80" width="66" height="30" rx="5" fill="#fff" stroke="#60a5fa"/><text x="77" y="99" text-anchor="middle" fill="#1e40af" font-size="9">producer</text>
  <rect x="150" y="80" width="66" height="30" rx="5" fill="#bfdbfe" stroke="#2563eb"/><text x="183" y="95" text-anchor="middle" fill="#1e40af" font-size="8">direct</text><text x="183" y="106" text-anchor="middle" fill="#1e40af" font-size="8">exchange</text>
  <rect x="256" y="80" width="66" height="30" rx="5" fill="#fff" stroke="#2563eb"/><text x="289" y="99" text-anchor="middle" fill="#1e40af" font-size="9">tasks Q</text>
  <path d="M112,95 L148,95" stroke="#2563eb" stroke-width="1.5" marker-end="url(#a1)"/>
  <path d="M218,95 L254,95" stroke="#2563eb" stroke-width="1.5" marker-end="url(#a1)"/>
  <rect x="356" y="70" width="52" height="22" rx="4" fill="#fff" stroke="#2563eb"/><text x="382" y="85" text-anchor="middle" fill="#1e40af" font-size="8">worker 1</text>
  <rect x="356" y="98" width="52" height="22" rx="4" fill="#fff" stroke="#2563eb"/><text x="382" y="113" text-anchor="middle" fill="#1e40af" font-size="8">worker 2</text>
  <path d="M324,90 L354,81" stroke="#2563eb" stroke-width="1.5" marker-end="url(#a1)"/>
  <path d="M324,100 L354,109" stroke="#2563eb" stroke-width="1.5" marker-end="url(#a1)"/>
  <text x="44" y="140" fill="#1d4ed8" font-size="9" font-weight="bold">each task &#8594; EXACTLY ONE worker (they compete)</text>
  <text x="44" y="158" fill="#1d4ed8" font-size="9">add workers &#8594; more throughput</text>
  <text x="44" y="176" fill="#1d4ed8" font-size="9">prefetch=1 &#8594; fair dispatch (pull, not push)</text>
  <text x="44" y="200" fill="#1e40af" font-size="9" font-weight="bold">for: commands / tasks / background jobs</text>
  <text x="44" y="220" fill="#1d4ed8" font-size="9">durable queue + persistent msg &#8594; survives restart</text>

  <rect x="456" y="40" width="400" height="192" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="656" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">PUB/SUB &#8212; fanout exchange, ONE queue per subscriber</text>
  <rect x="476" y="90" width="66" height="30" rx="5" fill="#fff" stroke="#86efac"/><text x="509" y="109" text-anchor="middle" fill="#15803d" font-size="9">producer</text>
  <rect x="580" y="88" width="60" height="34" rx="5" fill="#bbf7d0" stroke="#16a34a"/><text x="610" y="103" text-anchor="middle" fill="#15803d" font-size="8">fanout</text><text x="610" y="114" text-anchor="middle" fill="#15803d" font-size="8">exchange</text>
  <path d="M544,105 L578,105" stroke="#16a34a" stroke-width="1.5" marker-end="url(#a2)"/>
  <rect x="686" y="72" width="72" height="20" rx="4" fill="#fff" stroke="#16a34a"/><text x="722" y="86" text-anchor="middle" fill="#15803d" font-size="8">search Q</text>
  <rect x="686" y="98" width="72" height="20" rx="4" fill="#fff" stroke="#16a34a"/><text x="722" y="112" text-anchor="middle" fill="#15803d" font-size="8">email Q</text>
  <rect x="686" y="124" width="72" height="20" rx="4" fill="#fff" stroke="#16a34a"/><text x="722" y="138" text-anchor="middle" fill="#15803d" font-size="8">audit Q</text>
  <path d="M642,100 L684,82" stroke="#16a34a" stroke-width="1.5" marker-end="url(#a2)"/>
  <path d="M642,105 L684,108" stroke="#16a34a" stroke-width="1.5" marker-end="url(#a2)"/>
  <path d="M642,110 L684,134" stroke="#16a34a" stroke-width="1.5" marker-end="url(#a2)"/>
  <text x="476" y="164" fill="#166534" font-size="9" font-weight="bold">each event &#8594; EVERY bound queue (a copy each)</text>
  <text x="476" y="182" fill="#166534" font-size="9">add subscriber &#8594; declare + bind a new queue</text>
  <text x="476" y="200" fill="#166534" font-size="9">producer unchanged &#8594; consumers invert the dependency</text>
  <text x="476" y="220" fill="#15803d" font-size="9" font-weight="bold">for: events / broadcast / fan-out</text>

  <rect x="24" y="248" width="832" height="204" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="270" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">SELECTIVE ROUTING &#8212; topic exchange filters by pattern</text>
  <rect x="48" y="290" width="70" height="30" rx="5" fill="#fff" stroke="#a78bfa"/><text x="83" y="309" text-anchor="middle" fill="#5b21b6" font-size="9">producer</text>
  <rect x="170" y="286" width="70" height="38" rx="5" fill="#ddd6fe" stroke="#7c3aed"/><text x="205" y="301" text-anchor="middle" fill="#5b21b6" font-size="8">topic</text><text x="205" y="313" text-anchor="middle" fill="#5b21b6" font-size="8">exchange</text>
  <path d="M120,305 L168,305" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#a3)"/>
  <text x="120" y="295" text-anchor="middle" fill="#5b21b6" font-size="8">key=orders.eu.paid</text>
  <rect x="330" y="278" width="230" height="22" rx="4" fill="#fff" stroke="#7c3aed"/><text x="445" y="293" text-anchor="middle" fill="#5b21b6" font-size="8">bind orders.*.paid &#8594; billing Q</text>
  <rect x="330" y="304" width="230" height="22" rx="4" fill="#fff" stroke="#7c3aed"/><text x="445" y="319" text-anchor="middle" fill="#5b21b6" font-size="8">bind orders.eu.# &#8594; eu-analytics Q</text>
  <rect x="330" y="330" width="230" height="22" rx="4" fill="#fff" stroke="#7c3aed"/><text x="445" y="345" text-anchor="middle" fill="#5b21b6" font-size="8">bind orders.us.# &#8594; us-analytics Q (no match)</text>
  <path d="M240,300 L328,289" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#a3)"/>
  <path d="M240,305 L328,315" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#a3)"/>
  <text x="600" y="292" fill="#6d28d9" font-size="9">* = exactly one word</text>
  <text x="600" y="310" fill="#6d28d9" font-size="9"># = zero or more words</text>
  <text x="600" y="328" fill="#6d28d9" font-size="9">a message can match SEVERAL bindings</text>
  <text x="48" y="378" fill="#6d28d9" font-size="10">orders.eu.paid matches "orders.*.paid" AND "orders.eu.#" &#8594; delivered to billing Q and eu-analytics Q</text>
  <text x="48" y="400" fill="#6d28d9" font-size="10">it does NOT match "orders.us.#" &#8594; us-analytics Q receives nothing</text>
  <text x="48" y="424" fill="#5b21b6" font-size="10" font-weight="bold">direct = exact-key match &#183; topic = wildcard pattern &#183; fanout = everyone &#183; headers = match on headers</text>
  <text x="48" y="444" fill="#6d28d9" font-size="10">Selective routing is pub/sub with a filter: only the queues that asked for this class receive it.</text>
</svg>
```

## 4. Architecture & Workflow

The three patterns compose into one topology, and the workflow lesson is that a real system rarely uses just one. A typical order service publishes an `order.placed` event to a *topic* exchange; a billing queue, a search queue, and an audit queue each bind for the keys they care about (pub/sub with routing); and *behind* each of those queues sits a *work-queue* pool of competing consumers for throughput. So a single event flows fan-out to N queues, and each queue fans in to M workers. Recognising these two axes — fan-out across queues, load-share within a queue — is what makes a RabbitMQ design legible.

The lifecycle of one work-queue message, and the decisions at each hop:

1. **Publish.** The producer publishes to an exchange with a routing key, and — for reliability — marks the message *persistent* (`delivery_mode=2`) and waits for a *publisher confirm* (chapter 10). Nothing is durable unless both the queue is durable and the message is persistent.
2. **Route.** The exchange applies its type. Default/direct exchange with routing key = queue name lands it in the one work queue. A fanout copies it to every bound queue.
3. **Buffer.** The queue holds the message. If it is durable, its definition survives a broker restart; if the message is persistent, the message content does too.
4. **Dispatch.** The broker pushes the message to one of the competing consumers, respecting each consumer's prefetch window. With `prefetch=1` it dispatches only to a consumer with no outstanding unacked message.
5. **Process + acknowledge.** The consumer does the work, then `basic.ack`s. Ack *after* processing is at-least-once — a crash before the ack means the broker redelivers to another consumer. Ack before processing would be at-most-once.
6. **Fail.** On a processing error the consumer `basic.nack`s (or `reject`s); with `requeue=false` the message is dead-lettered (chapter 11), with `requeue=true` it goes back on the queue — beware the infinite-redelivery loop a poison message causes.

For RPC the workflow bends the queue into a request/reply channel. The client declares (or reuses) a **callback queue**, publishes the request to the server's queue with two properties set — `reply_to` = the callback queue's name and `correlation_id` = a unique token — and then blocks (or awaits) on the callback queue. The server consumes the request, computes the answer, and publishes it to the queue named in `reply_to`, echoing the same `correlation_id`. The client reads the callback queue, matches the `correlation_id` to the pending request, and resolves it. The `correlation_id` is essential because one callback queue is typically shared across *many* in-flight requests, so the client must be able to say "this reply belongs to *that* request". Modern RabbitMQ offers a shortcut: the pseudo-queue **`amq.rabbitmq.reply-to`**, a "direct reply-to" mechanism where the client sets `reply_to` to that magic name and consumes from it without declaring a real queue at all — cheaper, because it avoids creating and tearing down a queue per client.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="r1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
    <marker id="r2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">RPC over RabbitMQ: reply_to + correlation_id</text>

  <rect x="40" y="60" width="120" height="50" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="100" y="82" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">RPC client</text>
  <text x="100" y="100" text-anchor="middle" fill="#b45309" font-size="9">blocks on callback Q</text>

  <rect x="380" y="40" width="120" height="30" rx="6" fill="#fff" stroke="#d97706"/><text x="440" y="60" text-anchor="middle" fill="#92400e" font-size="9">rpc_requests queue</text>
  <rect x="380" y="150" width="120" height="30" rx="6" fill="#fff" stroke="#16a34a"/><text x="440" y="170" text-anchor="middle" fill="#15803d" font-size="9">callback (reply) queue</text>

  <rect x="720" y="60" width="120" height="50" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="780" y="82" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">RPC server</text>
  <text x="780" y="100" text-anchor="middle" fill="#166534" font-size="9">consumes requests</text>

  <path d="M160,72 L378,55" stroke="#d97706" stroke-width="2" marker-end="url(#r1)"/>
  <text x="270" y="58" text-anchor="middle" fill="#92400e" font-size="9">1. publish request</text>
  <text x="270" y="90" text-anchor="middle" fill="#b45309" font-size="8">props: reply_to=callbackQ, correlation_id=abc123</text>

  <path d="M500,55 L718,72" stroke="#d97706" stroke-width="2" marker-end="url(#r1)"/>
  <text x="610" y="52" text-anchor="middle" fill="#92400e" font-size="9">2. server consumes</text>

  <path d="M718,100 L502,162" stroke="#16a34a" stroke-width="2" marker-end="url(#r2)"/>
  <text x="620" y="140" text-anchor="middle" fill="#15803d" font-size="9">3. publish reply</text>
  <text x="620" y="152" text-anchor="middle" fill="#166534" font-size="8">to reply_to, echo correlation_id=abc123</text>

  <path d="M378,165 L162,100" stroke="#16a34a" stroke-width="2" marker-end="url(#r2)"/>
  <text x="250" y="150" text-anchor="middle" fill="#15803d" font-size="9">4. client reads reply</text>
  <text x="250" y="162" text-anchor="middle" fill="#166534" font-size="8">match correlation_id &#8594; resolve pending call</text>

  <rect x="40" y="210" width="800" height="200" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="232" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Why correlation_id is not optional</text>
  <text x="60" y="258" fill="#475569" font-size="10">One callback queue serves MANY concurrent requests. Replies can arrive out of order. The correlation_id is</text>
  <text x="60" y="276" fill="#475569" font-size="10">how the client matches reply &#8594; the request that is waiting for it. Without it, you cannot tell whose answer this is.</text>
  <text x="60" y="304" fill="#b45309" font-size="10" font-weight="bold">Shortcut: amq.rabbitmq.reply-to (direct reply-to)</text>
  <text x="60" y="324" fill="#475569" font-size="10">Set reply_to = "amq.rabbitmq.reply-to" and consume from it. RabbitMQ routes the reply straight back on the</text>
  <text x="60" y="342" fill="#475569" font-size="10">same connection &#8212; no real queue declared, no per-call create/teardown cost. The modern default for RPC.</text>
  <text x="60" y="372" fill="#b91c1c" font-size="10" font-weight="bold">Design warning:</text>
  <text x="160" y="372" fill="#991b1b" font-size="10">RPC over a broker adds a hop, a broker dependency, and timeout/orphan-reply handling to</text>
  <text x="60" y="390" fill="#991b1b" font-size="10">a synchronous call. Reach for HTTP/gRPC first; use broker RPC only when its decoupling genuinely buys you something.</text>
</svg>
```

## 5. Implementation

Two implementations in Go with `github.com/rabbitmq/amqp091-go`: a reliable **work queue** (producer + competing-consumer worker with fair dispatch and manual ack), and an **RPC** client/server pair. Comments explain the *why*, not just the *what*.

### Work queue — producer

```go
package main

import (
	"context"
	"log"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func publishTask(ch *amqp.Channel, body string) error {
	// Declare the queue as DURABLE so its definition survives a broker restart.
	// Declaring is idempotent and safe to do on every startup; producer and
	// consumer must declare with identical arguments or the broker errors.
	q, err := ch.QueueDeclare(
		"tasks", // name
		true,    // durable: the queue itself outlives a restart
		false,   // autoDelete: keep it even with no consumers
		false,   // exclusive
		false,   // noWait
		nil,     // args
	)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// Publish to the DEFAULT exchange (empty name). For the default exchange the
	// routing key is treated as a queue name, so this lands directly in "tasks".
	// DeliveryMode 2 (Persistent) asks the broker to write the message to disk —
	// WITHOUT this, a durable queue still loses its messages on a crash.
	return ch.PublishWithContext(ctx,
		"",     // exchange: default
		q.Name, // routing key = queue name
		false,  // mandatory (chapter 10 covers the return path)
		false,  // immediate (deprecated; always false)
		amqp.Publishing{
			DeliveryMode: amqp.Persistent, // = delivery_mode 2
			ContentType:  "text/plain",
			Body:         []byte(body),
			Timestamp:    time.Now(),
		},
	)
}

func main() {
	conn, err := amqp.Dial("amqp://guest:guest@localhost:5672/")
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()
	ch, err := conn.Channel()
	if err != nil {
		log.Fatal(err)
	}
	defer ch.Close()

	for i := 0; i < 20; i++ {
		if err := publishTask(ch, "resize-image-job"); err != nil {
			log.Fatalf("publish: %v", err)
		}
	}
	log.Println("published 20 tasks")
}
```

### Work queue — competing-consumer worker (fair dispatch)

```go
package main

import (
	"log"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func main() {
	conn, err := amqp.Dial("amqp://guest:guest@localhost:5672/")
	if err != nil {
		log.Fatal(err)
	}
	defer conn.Close()
	ch, err := conn.Channel()
	if err != nil {
		log.Fatal(err)
	}
	defer ch.Close()

	// Same durable declaration as the producer — must match exactly.
	q, err := ch.QueueDeclare("tasks", true, false, false, false, nil)
	if err != nil {
		log.Fatal(err)
	}

	// FAIR DISPATCH. prefetchCount=1 tells the broker: do not push me a new
	// message until I have acked the current one. Without this, RabbitMQ
	// round-robins blindly and a worker stuck on slow tasks piles up a backlog
	// while a free worker idles. prefetch=1 makes dispatch pull-shaped.
	if err := ch.Qos(1 /*prefetchCount*/, 0 /*prefetchSize*/, false /*global*/); err != nil {
		log.Fatal(err)
	}

	// autoAck=false: we acknowledge MANUALLY, only after the work succeeds. This
	// is what makes delivery at-least-once — a crash before ack redelivers the
	// message to another worker rather than losing it.
	msgs, err := ch.Consume(q.Name, "", false /*autoAck*/, false, false, false, nil)
	if err != nil {
		log.Fatal(err)
	}

	log.Println("worker up; waiting for tasks")
	for d := range msgs {
		log.Printf("received: %s", d.Body)
		if err := process(d.Body); err != nil {
			// Nack WITHOUT requeue so a poison message goes to the dead-letter
			// exchange (chapter 11) instead of looping forever on this queue.
			_ = d.Nack(false /*multiple*/, false /*requeue*/)
			continue
		}
		// Ack only now — after success. multiple=false acks just this delivery.
		_ = d.Ack(false)
	}
}

func process(body []byte) error {
	time.Sleep(500 * time.Millisecond) // simulate real work
	return nil
}
```

### RPC server

```go
package main

import (
	"log"
	"strconv"

	amqp "github.com/rabbitmq/amqp091-go"
)

func fib(n int) int {
	if n < 2 {
		return n
	}
	return fib(n-1) + fib(n-2)
}

func main() {
	conn, _ := amqp.Dial("amqp://guest:guest@localhost:5672/")
	defer conn.Close()
	ch, _ := conn.Channel()
	defer ch.Close()

	// The well-known request queue the client publishes to.
	q, _ := ch.QueueDeclare("rpc_queue", false, false, false, false, nil)

	// prefetch=1: process one request at a time so requests spread fairly across
	// server instances rather than all piling onto whichever consumed first.
	_ = ch.Qos(1, 0, false)

	msgs, _ := ch.Consume(q.Name, "", false, false, false, false, nil)
	log.Println("rpc server: awaiting requests")

	for d := range msgs {
		n, _ := strconv.Atoi(string(d.Body))
		result := strconv.Itoa(fib(n))

		// Publish the answer BACK to the queue the client named in reply_to, and
		// ECHO the correlation_id so the client can match this reply to the
		// request it sent. Both properties come off the incoming delivery.
		_ = ch.Publish(
			"",        // default exchange
			d.ReplyTo, // route to the client's callback queue
			false, false,
			amqp.Publishing{
				ContentType:   "text/plain",
				CorrelationId: d.CorrelationId, // the crucial echo
				Body:          []byte(result),
			},
		)
		_ = d.Ack(false)
	}
}
```

### RPC client

```go
package main

import (
	"context"
	"log"
	"strconv"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/google/uuid"
)

func main() {
	conn, _ := amqp.Dial("amqp://guest:guest@localhost:5672/")
	defer conn.Close()
	ch, _ := conn.Channel()
	defer ch.Close()

	// Use direct reply-to: a broker pseudo-queue that avoids declaring a real
	// callback queue per client. We consume from the magic name; the broker
	// routes our replies straight back on this connection.
	replies, err := ch.Consume(
		"amq.rabbitmq.reply-to", // the pseudo-queue
		"", true /*autoAck: required for direct reply-to*/, false, false, false, nil,
	)
	if err != nil {
		log.Fatal(err)
	}

	corrID := uuid.NewString() // unique token to match reply -> request

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	err = ch.PublishWithContext(ctx,
		"", "rpc_queue", false, false,
		amqp.Publishing{
			ContentType:   "text/plain",
			CorrelationId: corrID,
			ReplyTo:       "amq.rabbitmq.reply-to", // tell the server where to answer
			Body:          []byte(strconv.Itoa(30)),
		},
	)
	if err != nil {
		log.Fatal(err)
	}

	// Await the reply, but NEVER wait forever — a broker or server failure must
	// surface as a timeout, not a hung caller. This orphan/timeout handling is
	// exactly the extra bookkeeping that RPC-over-broker forces on you.
	timeout := time.After(5 * time.Second)
	for {
		select {
		case d := <-replies:
			if d.CorrelationId == corrID { // is this OUR answer?
				log.Printf("fib(30) = %s", d.Body)
				return
			}
			// A reply for a different request on the shared queue: ignore it.
		case <-timeout:
			log.Fatal("rpc timed out: broker or server unavailable")
		}
	}
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Work queues parallelise trivially.** Add workers to one queue and throughput scales, with the broker load-balancing for free; `prefetch` gives fair dispatch under uneven task times.
- **Pub/sub inverts dependencies.** A fanout exchange lets you add a subscriber by binding a queue — the producer never changes, which is what makes the system extensible.
- **Selective routing is expressive.** Topic exchanges route by pattern (`orders.*.eu`), so one publish reaches exactly the interested queues without the producer knowing them.
- **RPC is possible when you need broker-mediated request/reply.** Load-balanced across server instances, decoupled from server location, with buffering if a server is briefly busy.

**Disadvantages**
- **Work queues have no replay.** A message is deleted on ack; a consumer bug loses it. If you need reprocessing, that is Kafka's log or RabbitMQ Streams, not a queue.
- **Fanout copies to every queue.** Adding subscribers adds broker fan-out cost and memory, not throughput; it is easy to confuse "more reactions" with "more speed".
- **RPC over a broker is usually the wrong tool.** It adds a network hop, a broker dependency, correlation bookkeeping and timeout handling to an interaction a direct call does more simply.

**Trade-offs**
- *Fan-out across queues vs load-share within a queue:* these are the two independent axes. Broadcasting to N subscribers (fanout/topic) is not the same as speeding up one subscriber (competing consumers on its queue) — real systems do both, and confusing them is a design error.
- *Prefetch high vs low:* a high prefetch maximises throughput (workers never starve waiting for the next message) but harms fairness and lets one consumer hoard a backlog; `prefetch=1` maximises fairness at some throughput cost. Tune per workload — small for long, uneven tasks; larger for short, uniform ones.
- *RPC over broker vs direct call:* the broker buys you decoupling from the server's location, load-balancing across instances, and buffering; the direct call buys you simplicity, lower latency and no broker on the critical path. Choose the broker only when its decoupling is worth the price.

## 7. Common Mistakes & Best Practices

- **Publishing "to a queue".** There is no such thing on the producer side — you publish to an *exchange*. Forgetting this, and relying on the default exchange for everything, means you never learn the routing that makes RabbitMQ powerful.
- **No prefetch on a work queue.** Leaving prefetch unbounded (or huge) lets one consumer grab a pile of messages, harming fair dispatch and ballooning its memory; a slow task then blocks messages queued behind it on that one consumer.
- **Auto-ack on important work.** `autoAck=true` acknowledges on delivery, so a crash mid-processing loses the message (at-most-once). Use manual ack after success for at-least-once.
- **Requeueing a poison message forever.** `nack` with `requeue=true` on a message that always fails creates an infinite redelivery loop that pins CPU and blocks the queue. Route failures to a dead-letter exchange instead (chapter 11).
- **Adding fanout subscribers to go faster.** Each subscriber gets its own copy; that adds reactions, not throughput. To go faster, add competing consumers to the slow subscriber's queue.
- **RPC without a timeout.** Blocking forever on a callback queue turns a slow or dead server into a hung caller. Always bound the wait and treat a missing reply as a failure.
- **RPC without correlation ids.** Sharing one callback queue across concurrent requests and assuming replies arrive in order — they do not. Match every reply by `correlation_id`.
- **Best practice:** name the pattern before you wire it — "this is a work queue", "this is a fanout", "this is selective routing" — pick the exchange type that expresses it, set `prefetch` deliberately, ack after success, and reach for a direct call before reaching for broker RPC.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The first question is always "did the message route?" A message published to an exchange with *no matching binding* is silently dropped unless you set the `mandatory` flag (chapter 10) or attach an *alternate exchange*. Use the management UI (or `rabbitmqctl list_bindings`) to confirm the exchange-to-queue wiring, and `rabbitmqctl list_queues name messages messages_unacknowledged consumers` to see whether messages are arriving, sitting unacked, or lacking consumers. A growing `messages_unacknowledged` with a stuck consumer usually means a task hangs without acking or nacking.
- **Monitoring.** For work queues the headline metric is **queue depth** (`messages_ready`) and its rate of change — rising depth means consumers cannot keep up. Watch **unacked count** (in-flight work; a stuck consumer shows here), **consumer count** (did a pool die?), **redelivery rate** (poison messages or flapping consumers), and **publish/deliver rates**. For RPC, monitor reply latency and the timeout/orphan-reply rate.
- **Security.** Producers and consumers authenticate to a **virtual host**; use per-service credentials and RabbitMQ's topic-authorisation and per-vhost permissions so a service can publish/consume only its own exchanges and queues. Enable TLS for the AMQP port. For RPC especially, validate request payloads — a broker-exposed RPC endpoint is a remote-code surface if you deserialise carelessly.
- **Scaling.** Scale a work queue by adding consumers up to the point where the *queue* (single-node, on its leader) becomes the bottleneck; past that, shard across multiple queues or move the queue to a less loaded node (chapter 12). Fanout scales by the broker's copy cost per subscriber, so a very wide fan-out is a broker-capacity question. For RPC, scale the server side by running many consumers on `rpc_queue`; the broker load-balances requests across them.

## 9. Interview Questions

**Q: Why does a RabbitMQ producer publish to an exchange rather than a queue?**
A: Because the exchange is where routing lives, and decoupling the producer from the queues is the whole point of the smart-broker model. The producer knows an exchange name and a routing key and nothing else; the exchange, using its type and the bindings attached to it, decides which queues get a copy. This means you can add, remove or re-bind queues — add a new subscriber, split a work queue — without touching the producer, because the producer keeps publishing the same message to the same exchange. Publishing directly to a queue would hard-wire the producer to the consumer topology and forfeit exactly the flexibility that makes RabbitMQ a routing engine.

**Q: What is a work queue and how do you scale it?**
A: A work queue is a single queue with multiple competing consumers, where each message is delivered to exactly one of them, so a stream of tasks is shared across a pool of workers. You scale it by adding consumers — the broker load-balances messages across them — up to the point where the queue itself becomes the bottleneck. The important tuning lever is prefetch: setting `basic.qos(prefetchCount)` bounds how many unacknowledged messages the broker sends each consumer, which under uneven task durations gives fair dispatch, because a slow worker holds just its current message while a fast worker naturally pulls more.

**Q: What is prefetch and why does prefetch=1 give "fair" dispatch?**
A: Prefetch caps the number of unacknowledged messages the broker will push to a single consumer at once. The default round-robin dispatch is push-based and blind: the broker hands the next message to the next consumer whether or not that consumer is still busy, so a worker that draws several slow tasks builds a backlog while another idles. With `prefetch=1` the broker will not send a consumer a new message until it acknowledges the current one, so dispatch becomes pull-shaped — fast workers get more work, slow workers get exactly one at a time — which is fair under uneven task times. The cost is some throughput, so for short uniform tasks you raise it.

**Q: How do you build pub/sub on RabbitMQ, and how does it differ from a work queue?**
A: You bind several queues — one per subscriber — to a *fanout* exchange, which copies every published message to all bound queues; each subscriber consumes its own queue independently. That differs from a work queue in the axis it scales: a work queue has one queue and many consumers competing, so adding consumers adds throughput and each message is processed once; pub/sub has many queues, so adding a subscriber adds an independent reaction and each message is processed once *per subscriber*. Real systems compose them: a fanout to N queues, and behind each queue a competing-consumer pool for that subscriber's throughput.

**Q: What is the difference between a direct and a topic exchange?**
A: A direct exchange routes a message to the queues whose binding key exactly equals the message's routing key — good for a fixed set of categories like log severities `info`/`error`. A topic exchange routes by *pattern*: binding keys are dotted patterns with wildcards, where `*` matches exactly one word and `#` matches zero or more, so a queue can bind `orders.*.eu` or `orders.#` and receive the matching subset. Topic is direct's more expressive cousin — you use it when routing decisions are multi-dimensional (region, type, priority encoded in the key) rather than a single exact category.

**Q: How does RPC work over RabbitMQ?**
A: The client publishes a request to the server's queue with two message properties set: `reply_to`, naming a callback queue the answer should go to, and `correlation_id`, a unique token. It then waits on the callback queue. The server consumes the request, computes the answer, and publishes it to the queue named in `reply_to`, echoing the same `correlation_id`. The client reads the callback queue and uses the `correlation_id` to match the reply to the pending request. Modern RabbitMQ offers `amq.rabbitmq.reply-to`, a direct-reply pseudo-queue, so the client need not declare a real callback queue at all.

**Q: (Senior) Why is RPC over a message broker often considered an anti-pattern, and when is it nonetheless the right choice?**
A: It is often an anti-pattern because it takes a fundamentally synchronous interaction — the caller needs an answer to proceed — and routes it through infrastructure designed for asynchronous decoupling, paying costs that a direct call avoids. You add a network hop (client to broker to server, then server to broker to client, instead of client to server), a hard dependency on the broker being up and fast on the critical path of a request that a plain HTTP/gRPC call would not have, and real bookkeeping: correlation ids to match replies, timeouts so a dead server does not hang the caller, and handling for orphaned replies that arrive after the caller gave up. gRPC or HTTP gives you request/reply natively with none of that. It is nonetheless right when the broker's properties genuinely help: when you want the broker to *load-balance* requests across many interchangeable server instances without a separate load balancer or service discovery, when the server is behind a network boundary that makes direct connection awkward and the broker is already the shared bus, or when you want buffering so a burst of requests queues rather than being rejected. Even then I would insist on strict timeouts and idempotent request handling, and I would treat it as a deliberate exception, not a default — the default for request/reply is a direct call.

**Q: (Senior) A message published to a topic exchange matches no binding. What happens, and how do you make that safe?**
A: By default the message is silently discarded — the exchange has nowhere to route it, so it evaporates with no error to the producer, which is one of the more insidious ways to lose data in RabbitMQ. There are three defences and I usually combine them. First, the `mandatory` flag on publish: if the message cannot be routed to any queue, the broker *returns* it to the producer, which registers a return listener and treats a return as a failure to handle (chapter 10) — this catches the mistake at runtime. Second, an *alternate exchange* configured on the primary exchange: any message the primary cannot route is forwarded to the alternate, typically bound to a catch-all "unrouted" queue you monitor, so nothing is lost even without producer-side handling. Third, discipline in topology management: bindings are part of the contract, declared and reviewed alongside the code, so a new routing key is never published without a binding to receive it. The failure mode to avoid is finding out weeks later that a whole class of events was being dropped because someone published `orders.eu.refunded` and no queue ever bound a pattern that matched it.

**Q: (Senior) Design the routing for an order-events system where billing, search, EU-analytics and an audit log all need order events, but only some of each. How would you wire it?**
A: I would use a single *topic* exchange, say `orders`, and encode the meaningful dimensions in the routing key — something like `orders.<region>.<type>`, e.g. `orders.eu.placed`, `orders.us.refunded`. Then each consumer owns a queue and binds for exactly the subset it needs: the audit log binds `orders.#` because it wants everything; billing binds `orders.*.placed` and `orders.*.refunded` because it cares about money events in any region; search binds `orders.#` too, or a narrower set if it only indexes certain types; EU-analytics binds `orders.eu.#` to get every EU event and nothing else. This is pub/sub with a filter — one publish fans out to precisely the interested queues, and the producer stays oblivious to who consumes. Behind each queue I would put a competing-consumer pool sized to that consumer's throughput, so fan-out (across queues) and load-share (within a queue) are handled on their separate axes. I would set `mandatory` plus an alternate exchange so a routing key nobody bound is caught rather than dropped, make each queue durable and messages persistent for reliability (chapter 10), and attach a dead-letter exchange to each queue for poison messages (chapter 11). The elegance is that adding a fifth consumer later — say fraud detection wanting only refunds — is a one-line binding on a new queue, with zero change to the producer or the other consumers.

**Q: (Senior) When would you choose competing consumers on one queue versus multiple queues behind a fanout, and can you have both?**
A: They answer different questions, so the choice is about intent. Competing consumers on one queue is how you make *one logical consumer* faster: the work is a single stream of tasks that must each be done once, and you add workers to share the load, capped by when the queue's single node saturates. Multiple queues behind a fanout is how you let *several distinct consumers* each react to the same event independently — billing, search, audit — each getting its own copy. You absolutely have both at once, and good designs usually do: a fanout (or topic) exchange broadcasts an event to N subscriber queues, and behind each of those queues sits its own competing-consumer pool. The mental model is two orthogonal axes — fan-out across queues to add *reactions*, load-share within a queue to add *throughput* — and the classic mistake is to conflate them, for instance adding fanout subscribers hoping to process faster, which only adds copies and broker cost, not speed.

## 10. Quick Revision & Cheat Sheet

| Pattern | Exchange type | Queues | Consumers | Each message |
|---|---|---|---|---|
| Work queue | default / direct | one | many, competing | to exactly one worker |
| Pub/sub | fanout | one per subscriber | independent | to every bound queue |
| Selective routing | direct (exact) / topic (pattern) | one per interest | independent | to matching queues only |
| RPC | default (request + reply queues) | request + callback | server pool | request out, reply back |

| Exchange | Routes by | Wildcards |
|---|---|---|
| direct | exact routing-key match | none |
| fanout | ignores key, all bound queues | n/a |
| topic | pattern match on dotted key | `*`=one word, `#`=zero+ words |
| headers | message header match | n/a |

**Flash cards**
- **Where does a producer publish?** → To an *exchange*, never a queue.
- **What makes a work queue fair?** → `prefetch=1` (`basic.qos`) — dispatch by pull, not push.
- **Pub/sub on RabbitMQ?** → Fanout exchange bound to one queue per subscriber.
- **`*` vs `#` in a topic key?** → `*` = exactly one word; `#` = zero or more words.
- **Two properties that make RPC work?** → `reply_to` (callback queue) + `correlation_id` (match reply to request).
- **RPC shortcut?** → `amq.rabbitmq.reply-to` — direct reply, no real callback queue.
- **Faster vs more reactions?** → Competing consumers (faster) vs fanout subscribers (reactions) — different axes.

## 11. Hands-On Exercises & Mini Project

- [ ] Build a work queue with a producer and two workers; confirm each task goes to exactly one worker, then add a third and watch throughput rise.
- [ ] Set `prefetch=1` on the workers, feed a mix of fast and slow tasks, and observe fair dispatch versus the unfair default.
- [ ] Kill a worker mid-task (before it acks) and confirm the message is redelivered to another worker rather than lost.
- [ ] Build a fanout exchange with three subscriber queues; confirm each subscriber receives every message.
- [ ] Build a topic exchange and bind queues for `orders.*.paid`, `orders.eu.#`, and `orders.#`; publish `orders.eu.paid` and verify exactly which queues receive it.
- [ ] Implement RPC with `amq.rabbitmq.reply-to`, then break it by removing the `correlation_id` check with two concurrent calls and observe replies mismatching.

### Mini Project — "Order Events Router"

**Goal.** Build a single RabbitMQ topology that expresses all three patterns and makes the fan-out-vs-load-share axes explicit.

**Requirements.**
1. Declare a topic exchange `orders`; publish keyed events like `orders.eu.placed`, `orders.us.refunded` from a producer.
2. Bind four subscriber queues: `audit` (`orders.#`), `billing` (`orders.*.placed`, `orders.*.refunded`), `eu-analytics` (`orders.eu.#`), `search` (`orders.#`).
3. Behind the `billing` queue, run a competing-consumer pool of three workers with `prefetch=1` and manual ack; verify each event is billed exactly once.
4. Add an RPC endpoint (`amq.rabbitmq.reply-to`) that answers "current status of order N" with correlation-id matching and a client-side timeout.
5. Set `mandatory` plus an alternate exchange so an unmatched routing key lands in an `unrouted` queue you monitor rather than being dropped.

**Extensions.**
- Add a second subscriber (fraud) that binds only `orders.*.refunded` — a one-line change with no producer edit — proving dependency inversion.
- Measure and compare RPC latency over the broker versus a direct HTTP call to the same handler, and articulate when the broker path is justified.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Messaging Models: Queues vs Pub/Sub vs the Log* (the three primitives these patterns implement), *RabbitMQ Exchanges, Bindings & the AMQP Model* (the routing machinery in depth), *Reliability: Publisher Confirms, Persistence & Mandatory* (making these patterns not lose messages), *Dead Letter Exchanges, TTL & Delayed Messages* (handling the failures work queues introduce), *Design: RabbitMQ Clustering, Quorum Queues & HA* (scaling and surviving failure of the queues behind these patterns).

- **RabbitMQ — Work Queues tutorial** — RabbitMQ · *Beginner* · competing consumers, fair dispatch and manual ack with runnable code; the canonical starting point for the work-queue pattern. <https://www.rabbitmq.com/tutorials/tutorial-two-python>
- **RabbitMQ — Publish/Subscribe tutorial** — RabbitMQ · *Beginner* · the fanout exchange and per-subscriber queues, exactly the pub/sub shape in this chapter. <https://www.rabbitmq.com/tutorials/tutorial-three-python>
- **RabbitMQ — Routing & Topics tutorials** — RabbitMQ · *Intermediate* · direct and topic exchanges, binding keys and wildcards for selective delivery. <https://www.rabbitmq.com/tutorials/tutorial-four-python>
- **RabbitMQ — Remote Procedure Call (RPC) tutorial** — RabbitMQ · *Intermediate* · reply_to, correlation_id and the request/reply pattern, with the caveats spelled out. <https://www.rabbitmq.com/tutorials/tutorial-six-python>
- **RabbitMQ — Direct Reply-to** — RabbitMQ · *Intermediate* · the `amq.rabbitmq.reply-to` pseudo-queue and why it is cheaper than a per-client callback queue. <https://www.rabbitmq.com/docs/direct-reply-to>
- **RabbitMQ — Consumer Prefetch** — RabbitMQ · *Intermediate* · what `basic.qos` does and how prefetch shapes fairness and flow control. <https://www.rabbitmq.com/docs/consumer-prefetch>
- **Enterprise Integration Patterns — Competing Consumers & Request-Reply** — Hohpe & Woolf · *Intermediate* · the canonical pattern definitions this chapter implements on RabbitMQ. <https://www.enterpriseintegrationpatterns.com/patterns/messaging/CompetingConsumers.html>
- **amqp091-go** — RabbitMQ / Go · *Intermediate* · the maintained Go client used in this chapter, with examples for publish, consume, qos and reply-to. <https://pkg.go.dev/github.com/rabbitmq/amqp091-go>

---

*Kafka & RabbitMQ Handbook — chapter 09.*
