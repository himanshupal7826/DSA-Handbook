# 06 · Exchanges, Queues & Bindings (AMQP 0-9-1)

> **In one line:** In AMQP a producer never touches a queue — it publishes to an *exchange*, the exchange applies *bindings* to decide which *queues* get a copy, and consumers read from queues; understanding those three objects and the routing key that glues them together is understanding RabbitMQ.

---

## 1. Overview

Newcomers to RabbitMQ reach for the mental model they already have — "I put a message on a queue, a worker takes it off" — and it quietly misleads them, because in AMQP 0-9-1 a producer *cannot* put a message on a queue. It publishes to an **exchange**, and the exchange, following rules called **bindings**, decides which queues receive a copy. The queue is a consumer-side object; the producer does not name it and, in the general case, does not know it exists. This indirection is not bureaucracy. It is the whole point of RabbitMQ's "smart broker" design: routing logic lives in the broker, expressed as exchanges and bindings, so a producer can publish one message and have it fan out to five queues, or one, or none, without changing a line of producer code.

The AMQP object model has exactly three routing objects and one connecting attribute. A **producer** publishes a message to an **exchange**, tagging the message with a **routing key** — a short string like `order.created` or `payments.eu.refund`. The exchange holds a set of **bindings**, each a link from the exchange to a **queue** carrying a **binding key** (a pattern or exact value). The exchange compares the message's routing key against its bindings, according to the exchange's *type* (chapter 7), and delivers a copy to every queue whose binding matches. A **consumer** then reads messages from a queue. That is the entire pipeline: `producer → EXCHANGE → [binding] → QUEUE → consumer`. Nothing skips a stage.

If that is true, why does every "hello world" RabbitMQ tutorial appear to publish straight to a queue named `"hello"`? Because of the **default exchange** — a nameless, pre-declared direct exchange to which *every* queue is automatically bound using its own name as the binding key. Publishing to exchange `""` with routing key `"hello"` therefore lands in the queue named `hello`, and the illusion of "publishing to a queue" is really "publishing to the default exchange with the queue name as the routing key". Seeing through that illusion is the first real step into AMQP, because it reveals that the direct-to-queue case is not special — it is the general model with a convenient default wired in.

This chapter defines the four objects precisely, explains *idempotent declaration* (how a client asserts the topology it needs), pins down the difference between a **routing key** (set by the producer, per message) and a **binding key** (set at bind time, per binding), walks the full publish-and-consume flow, and gives real `amqp091-go` code that declares a topology and moves a message end to end. Exchange *types* — direct, fanout, topic, headers — and reliability concerns like publisher confirms and durable messages are the subjects of chapters 7 and 10; here we build the skeleton everything else hangs on.

## 2. Core Concepts

- **Producer (publisher)** — the client that publishes messages. It names an *exchange* and a *routing key*; it never names a queue (except via the default-exchange shorthand).
- **Exchange** — the broker object that receives every published message and routes copies to queues according to its type and its bindings. Producers publish *here*, not to queues.
- **Queue** — an ordered buffer that holds messages until a consumer takes them. A consumer-side object; messages are removed once acknowledged (chapter 8).
- **Binding** — a rule linking an exchange to a queue, carrying a *binding key*. It tells the exchange "deliver matching messages to this queue". One exchange can bind to many queues; one queue can be bound from many exchanges.
- **Routing key** — a string set by the producer *on each message* at publish time (e.g. `order.created`). The exchange matches it against bindings.
- **Binding key** — the pattern or value declared *on the binding* (e.g. `order.*`). What the routing key is matched against. Ignored by fanout exchanges.
- **Default (nameless) exchange** — a pre-declared direct exchange named `""` to which every queue is auto-bound by its own name; makes `publish(exchange="", routingKey="q")` land in queue `q`.
- **Declare** — the idempotent operation that asserts an object exists with given properties: `exchange.declare`, `queue.declare`, `queue.bind`. Re-declaring an identical object is a no-op; re-declaring with conflicting properties fails.
- **Durable** — a queue/exchange property: its *definition* survives a broker restart. (Surviving messages additionally need persistent delivery — chapter 10.)
- **Exclusive** — a queue used by only one connection and deleted when that connection closes; for private, per-client reply queues.
- **Auto-delete** — a queue/exchange deleted automatically once its last consumer (queue) or binding (exchange) goes away.
- **Channel** — the lightweight virtual connection over a single TCP connection on which all these operations (declare, publish, consume, ack) are issued (chapter 5).

## 3. Theory & Principles

### Why the producer must not name the queue

The indirection through an exchange is the design decision that separates RabbitMQ from a naive queue server, so it is worth stating why it matters rather than treating it as a formality. If producers published directly to queues, the producer would need to know the full set of interested consumers — one queue for search, one for email, one for audit — and would have to publish once per queue. Adding a fourth consumer would mean editing and redeploying the producer. That is exactly the *location and identity coupling* a message system is supposed to remove (chapter 1). By publishing to an exchange instead, the producer states only *what happened* (via the routing key) and leaves *who cares* to the bindings. New consumers declare a queue and bind it; the producer never changes. The exchange is the seam that lets the routing topology evolve independently of the code that emits events.

This is the concrete meaning of "smart broker, dumb consumer". The intelligence — the decision about which messages go where — is centralised in the broker as a declarative topology of exchanges and bindings, and the consumer is a simple loop that reads a queue. Kafka makes the opposite choice ("dumb broker, smart consumer"): the broker just appends to a partition and the consumer decides what to read. Neither is superior; RabbitMQ's choice buys rich, per-message, attribute-based routing at the cost of the broker doing more work and holding more state.

### Declares are idempotent assertions, not commands

An AMQP client does not "create" objects so much as *assert* them. `queue.declare` means "ensure a queue with this name and these properties exists; if it already does, fine; if it does not, make it". Re-running it is safe — it is idempotent — which is why the correct pattern is for *every* client, producer and consumer alike, to declare the full topology it depends on at start-up. You never assume the broker was set up in advance; each client makes its own requirements true. If two clients declare the same queue with identical properties, both succeed and share it.

The sharp edge is the **equivalence check**. If a client declares a queue that already exists but with *different* properties — say it asks for `durable=true` when the existing queue is `durable=false` — the broker rejects it with a `406 PRECONDITION_FAILED` channel exception, and the channel is closed. This is deliberate: it stops two clients silently disagreeing about a queue's durability or arguments. The lesson is that the properties in your declare are a contract, and all declarers must agree. A `passive` declare (`queue.declare` with the passive flag) sidesteps creation entirely — it only checks existence and returns the queue's message/consumer counts, failing if the queue is absent. Use passive when you want to *verify* a topology someone else owns rather than *assert* your own.

### Routing key versus binding key — the distinction that trips everyone

These two strings are matched against each other, but they live in different places and are set at different times, and conflating them is the most common source of "my message vanished" confusion.

- The **routing key** is a property of the *message*. The producer sets it on every `basic.publish`. It describes the message: `order.created`, `logs.eu.error`.
- The **binding key** is a property of the *binding*. It is fixed when you run `queue.bind` and describes what a queue wants: `order.*`, `logs.#`, or an exact `order.created`.

The exchange's job is to compare a message's routing key to its bindings' binding keys using the matching rule of its *type* (chapter 7) and deliver to every queue whose binding matches. For a direct exchange, "match" means the two strings are equal. For a topic exchange, the binding key is a wildcard pattern the routing key must fit. For a fanout exchange, there is no comparison at all — the routing key is ignored and every bound queue gets a copy. Crucially, **a message that matches no binding is not delivered to any queue**: by default it is silently dropped (the `mandatory` flag, chapter 10, is how you find out). So the routing key is what you *say* about a message; the binding key is what a queue *asks* to hear; the exchange type is the language they are matched in.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The AMQP object model: producer never touches the queue</text>

  <rect x="24" y="52" width="120" height="60" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="84" y="78" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">PRODUCER</text>
  <text x="84" y="96" text-anchor="middle" fill="#6d28d9" font-size="9">sets routing key</text>

  <path d="M146,82 L214,82" stroke="#7c3aed" stroke-width="2" marker-end="url(#a1)"/>
  <text x="180" y="74" text-anchor="middle" fill="#6d28d9" font-size="9">publish</text>
  <text x="180" y="100" text-anchor="middle" fill="#6d28d9" font-size="8">rk=order.created</text>

  <rect x="216" y="44" width="150" height="130" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="291" y="66" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">EXCHANGE</text>
  <text x="291" y="84" text-anchor="middle" fill="#1d4ed8" font-size="9">type decides match</text>
  <text x="291" y="104" text-anchor="middle" fill="#1d4ed8" font-size="8">compares rk vs each</text>
  <text x="291" y="118" text-anchor="middle" fill="#1d4ed8" font-size="8">binding's binding key</text>
  <text x="291" y="146" text-anchor="middle" fill="#1e40af" font-size="8" font-weight="bold">no match &#8594; DROPPED</text>
  <text x="291" y="160" text-anchor="middle" fill="#1e40af" font-size="8">(unless mandatory)</text>

  <path d="M368,78 L470,70" stroke="#2563eb" stroke-width="2" marker-end="url(#a2)"/>
  <text x="420" y="60" text-anchor="middle" fill="#1d4ed8" font-size="8">binding key: order.*</text>
  <path d="M368,110 L470,132" stroke="#2563eb" stroke-width="2" marker-end="url(#a2)"/>
  <text x="420" y="132" text-anchor="middle" fill="#1d4ed8" font-size="8">binding key: order.created</text>
  <path d="M368,150 L470,190" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="420" y="182" text-anchor="middle" fill="#64748b" font-size="8">bk: payment.* (no match)</text>

  <rect x="472" y="48" width="150" height="42" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="547" y="66" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">QUEUE orders.new</text>
  <text x="547" y="82" text-anchor="middle" fill="#166534" font-size="8">gets a copy</text>
  <rect x="472" y="112" width="150" height="42" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="547" y="130" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">QUEUE orders.audit</text>
  <text x="547" y="146" text-anchor="middle" fill="#166534" font-size="8">gets a copy</text>
  <rect x="472" y="172" width="150" height="42" rx="6" fill="#f1f5f9" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="547" y="190" text-anchor="middle" fill="#64748b" font-size="10" font-weight="bold">QUEUE payments</text>
  <text x="547" y="206" text-anchor="middle" fill="#64748b" font-size="8">no copy (unmatched)</text>

  <path d="M622,69 L690,69" stroke="#16a34a" stroke-width="2" marker-end="url(#a3)"/>
  <rect x="692" y="48" width="164" height="42" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="774" y="66" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">CONSUMER A</text>
  <text x="774" y="82" text-anchor="middle" fill="#b45309" font-size="8">basic.consume + ack</text>
  <path d="M622,133 L690,133" stroke="#16a34a" stroke-width="2" marker-end="url(#a3)"/>
  <rect x="692" y="112" width="164" height="42" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="774" y="130" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">CONSUMER B</text>
  <text x="774" y="146" text-anchor="middle" fill="#b45309" font-size="8">independent copy</text>

  <rect x="24" y="242" width="832" height="90" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="264" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Routing key vs binding key</text>
  <text x="44" y="288" fill="#b45309" font-size="10"><tspan font-weight="bold">Routing key</tspan> &#8212; on the MESSAGE, set by producer per publish. What the message SAYS about itself.</text>
  <text x="44" y="308" fill="#b45309" font-size="10"><tspan font-weight="bold">Binding key</tspan> &#8212; on the BINDING, set at queue.bind. What a queue ASKS to hear.</text>
  <text x="44" y="326" fill="#92400e" font-size="10" font-weight="bold">The exchange matches routing key against binding keys in the language of its type (direct / topic / fanout / headers).</text>

  <rect x="24" y="342" width="832" height="112" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="364" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">The default (nameless) exchange demystified</text>
  <text x="44" y="388" fill="#166534" font-size="10">Every queue is AUTO-BOUND to the nameless direct exchange &#8220;&#8221; with binding key = its own name.</text>
  <text x="44" y="408" fill="#166534" font-size="10">So publish(exchange=&#8220;&#8221;, routingKey=&#8220;hello&#8221;) &#8594; default exchange &#8594; binding key &#8220;hello&#8221; &#8594; queue named &#8220;hello&#8221;.</text>
  <text x="44" y="428" fill="#15803d" font-size="10" font-weight="bold">&#8220;Publishing to a queue&#8221; is just the general model with a convenient default wired in &#8212; nothing skips the exchange.</text>
  <text x="44" y="446" fill="#166534" font-size="9">You cannot bind to or delete the default exchange; it always exists in every vhost.</text>
</svg>
```

## 4. Architecture & Workflow

The end-to-end path of a message through RabbitMQ, with the decision at each hop, is the thing to hold in your head:

1. **Declare the topology.** Some client — usually the consumer, ideally every client — declares the exchange (`exchange.declare`), the queue (`queue.declare`), and the binding between them (`queue.bind`). These are idempotent, so ordering across clients does not matter as long as everyone agrees on properties. If the consumer declares before the producer publishes, no messages are lost; if the producer publishes to an exchange with no matching binding, the message is dropped — which is why consumers should declare their queues and bindings *early*.
2. **Publish.** The producer calls `basic.publish(exchange, routingKey, body)` on a channel. The message carries a routing key and properties (content type, delivery mode, headers). It goes to the exchange, not a queue.
3. **Route.** The exchange evaluates its type against the routing key and its bindings, producing a set of destination queues (possibly empty). For each matched queue it enqueues a *copy* of the message. One publish can therefore result in zero, one, or many enqueued messages.
4. **Enqueue.** Each destination queue appends the message. If the queue is durable and the message is persistent, it is written such that it survives a broker restart (chapter 10); otherwise it lives only in memory.
5. **Deliver / consume.** Consumers registered on the queue via `basic.consume` receive messages pushed to them (or fetch with `basic.get`). Multiple consumers on one queue compete round-robin (chapter 8).
6. **Acknowledge.** After processing, the consumer acks; the queue then discards the message. Without an ack (manual-ack mode) the message is redelivered if the consumer dies (chapter 8). This is where correctness lives.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">One publish &#8594; fan-out to many queues via bindings</text>

  <rect x="24" y="48" width="120" height="54" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="84" y="70" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">producer</text>
  <text x="84" y="88" text-anchor="middle" fill="#6d28d9" font-size="9">1 message</text>
  <path d="M146,75 L206,75" stroke="#4f46e5" stroke-width="2" marker-end="url(#b1)"/>
  <text x="176" y="67" text-anchor="middle" fill="#4f46e5" font-size="8">rk=order.created</text>

  <rect x="208" y="40" width="130" height="70" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="273" y="62" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">topic exchange</text>
  <text x="273" y="80" text-anchor="middle" fill="#1d4ed8" font-size="9">&#8220;orders&#8221;</text>
  <text x="273" y="96" text-anchor="middle" fill="#1d4ed8" font-size="8">evaluate bindings</text>

  <path d="M338,60 L410,54" stroke="#4f46e5" stroke-width="2" marker-end="url(#b1)"/>
  <text x="378" y="46" text-anchor="middle" fill="#4f46e5" font-size="8">order.*</text>
  <path d="M338,78 L410,110" stroke="#4f46e5" stroke-width="2" marker-end="url(#b1)"/>
  <text x="374" y="104" text-anchor="middle" fill="#4f46e5" font-size="8">order.created</text>
  <path d="M338,96 L410,168" stroke="#4f46e5" stroke-width="2" marker-end="url(#b1)"/>
  <text x="372" y="162" text-anchor="middle" fill="#4f46e5" font-size="8">#</text>

  <rect x="412" y="36" width="150" height="40" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="487" y="61" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">queue: fulfilment</text>
  <rect x="412" y="90" width="150" height="40" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="487" y="115" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">queue: notify</text>
  <rect x="412" y="148" width="150" height="40" rx="6" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="487" y="173" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">queue: audit-all</text>

  <path d="M562,56 L636,56" stroke="#4f46e5" stroke-width="2" marker-end="url(#b1)"/>
  <path d="M562,110 L636,110" stroke="#4f46e5" stroke-width="2" marker-end="url(#b1)"/>
  <path d="M562,168 L636,168" stroke="#4f46e5" stroke-width="2" marker-end="url(#b1)"/>
  <rect x="638" y="36" width="218" height="40" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="747" y="61" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">fulfilment worker (ack)</text>
  <rect x="638" y="90" width="218" height="40" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="747" y="115" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">email service (ack)</text>
  <rect x="638" y="148" width="218" height="40" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="747" y="173" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">audit sink (ack)</text>

  <rect x="24" y="212" width="832" height="196" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="234" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The six-step lifecycle and where the decision lives</text>
  <text x="44" y="260" fill="#475569" font-size="10"><tspan font-weight="bold" fill="#1e293b">1. Declare</tspan> exchange + queue + binding (idempotent). Every client asserts what it needs; conflicting props &#8594; 406.</text>
  <text x="44" y="282" fill="#475569" font-size="10"><tspan font-weight="bold" fill="#1e293b">2. Publish</tspan> to the EXCHANGE with a routing key. Never to a queue (bar the default-exchange shorthand).</text>
  <text x="44" y="304" fill="#475569" font-size="10"><tspan font-weight="bold" fill="#1e293b">3. Route</tspan> exchange matches rk vs bindings by its type &#8594; a set of queues (maybe empty &#8594; message dropped).</text>
  <text x="44" y="326" fill="#475569" font-size="10"><tspan font-weight="bold" fill="#1e293b">4. Enqueue</tspan> a COPY per matched queue. Durable queue + persistent msg &#8594; survives restart (ch.10).</text>
  <text x="44" y="348" fill="#475569" font-size="10"><tspan font-weight="bold" fill="#1e293b">5. Consume</tspan> consumers on a queue compete round-robin; each queue's message goes to exactly one consumer.</text>
  <text x="44" y="370" fill="#475569" font-size="10"><tspan font-weight="bold" fill="#1e293b">6. Ack</tspan> after processing &#8594; queue discards it. No ack + crash &#8594; redelivered (ch.8). Correctness lives here.</text>
  <text x="44" y="394" fill="#334155" font-size="10" font-weight="bold">One publish, three queues, three independent consumers &#8212; and the producer knew about none of them.</text>
</svg>
```

The workflow lesson is that **the producer's responsibility ends at the exchange**. It says what happened; the topology decides the rest. That is what makes a RabbitMQ system extensible: to add a reaction, you declare a queue, bind it to the existing exchange, and start a consumer — no producer change, no redeploy of the emitting service. The exchange is the extension point.

Two ordering subtleties are worth flagging here because they surprise people who think of a queue as a simple FIFO. First, the *declare order* across clients does not matter — because declares are idempotent, a consumer that starts after the producer still gets every message published *after* its queue was bound, but nothing published before. So the operational rule is "bind the queue before the first relevant publish", not "start the consumer first". Second, once a queue exists and is bound, message *arrival order* within that one queue is FIFO, but the order in which effects happen depends on how many consumers compete for it and how prefetch is set (chapter 8) — a single queue with several consumers interleaves effects, and cross-queue there is no ordering at all. Keeping "the exchange copies, the queue orders, the consumers interleave" in mind prevents most ordering confusion (chapter 22).

## 5. Implementation

Here is a complete, runnable `amqp091-go` program that declares a topology (a direct exchange, a queue, a binding), publishes a message, and consumes it. The comments explain *why* each argument is what it is, because the boolean flags on declare are where subtle production bugs hide. This uses `github.com/rabbitmq/amqp091-go`, the official Go client.

```go
package main

import (
	"context"
	"log"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

func main() {
	// A single TCP connection. In production this is long-lived and shared;
	// channels (below) are the cheap, per-goroutine multiplexed sessions.
	conn, err := amqp.Dial("amqp://guest:guest@localhost:5672/")
	must(err, "dial")
	defer conn.Close()

	// A channel is where ALL AMQP operations happen: declare, publish, consume,
	// ack. Never share one channel across goroutines that publish and consume
	// concurrently — give each goroutine its own (chapter 5).
	ch, err := conn.Channel()
	must(err, "open channel")
	defer ch.Close()

	// --- 1. Declare the topology (idempotent) ---------------------------------
	// Declare the EXCHANGE. Producers publish here, never to a queue.
	//   name="orders", kind="direct" (exact routing-key match, chapter 7),
	//   durable=true  -> the exchange DEFINITION survives a broker restart,
	//   autoDelete=false -> do not delete when the last binding is removed,
	//   internal=false -> clients may publish to it (true = exchange-to-exchange
	//                     only), noWait=false -> wait for the broker to confirm.
	err = ch.ExchangeDeclare("orders", "direct", true, false, false, false, nil)
	must(err, "declare exchange")

	// Declare the QUEUE. A consumer-side object.
	//   durable=true    -> the queue DEFINITION survives a restart (messages need
	//                      persistent delivery too, chapter 10),
	//   autoDelete=false-> keep it when the last consumer disconnects,
	//   exclusive=false -> other connections may use it (true = private + auto
	//                      deleted on this connection's close),
	//   noWait=false, args=nil. The broker returns the queue's actual name,
	//   message count and consumer count.
	q, err := ch.QueueDeclare("orders.new", true, false, false, false, nil)
	must(err, "declare queue")

	// Declare the BINDING that links exchange -> queue with a binding key.
	// For a DIRECT exchange the binding key must EQUAL a message's routing key
	// for the message to be delivered here.
	//   queue=q.Name, key="order.created" (the binding key), exchange="orders".
	err = ch.QueueBind(q.Name, "order.created", "orders", false, nil)
	must(err, "bind queue")

	// --- 2. Start a consumer BEFORE publishing so nothing is missed -----------
	// autoAck=false -> we will ack manually AFTER processing, so a crash mid-work
	// causes a redelivery rather than a loss (at-least-once, chapter 8).
	deliveries, err := ch.Consume(q.Name, "demo-consumer", false, false, false, false, nil)
	must(err, "consume")

	done := make(chan struct{})
	go func() {
		for d := range deliveries {
			log.Printf("consumed: routingKey=%q body=%q redelivered=%v",
				d.RoutingKey, d.Body, d.Redelivered)
			// Acknowledge exactly this delivery (multiple=false) now that the
			// work is done. The queue then discards the message.
			if err := d.Ack(false); err != nil {
				log.Printf("ack failed: %v", err)
			}
			close(done)
			return
		}
	}()

	// --- 3. Publish to the EXCHANGE (not the queue) ---------------------------
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// exchange="orders", routingKey="order.created" (matches the binding key),
	// mandatory=false -> if nothing matches, the broker DROPS the message
	// silently; set true + handle returns to detect unroutable ones (chapter 10),
	// immediate=false (deprecated; always false).
	err = ch.PublishWithContext(ctx, "orders", "order.created", false, false,
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent, // delivery_mode=2: write to disk so a
			// durable queue can recover it after a restart (chapter 10).
			Body:      []byte(`{"orderId":42,"amount":19.99}`),
			Timestamp: time.Now(),
			MessageId: "order-42", // stable id for idempotent consumers (chapter 21)
		})
	must(err, "publish")
	log.Println("published order.created to exchange 'orders'")

	<-done // wait for the consumer to process the one message, then exit
}

// --- The default-exchange shorthand, for contrast --------------------------
// This is what a naive tutorial does. It publishes to exchange "" (the nameless
// default direct exchange), and because every queue is auto-bound to it by its
// own name, routingKey="orders.new" lands directly in the queue "orders.new".
// It looks like "publishing to a queue" but it is the SAME model: an exchange,
// a binding (implicit), and a routing key (= the queue name).
func publishViaDefaultExchange(ch *amqp.Channel, queueName string, body []byte) error {
	return ch.PublishWithContext(context.Background(),
		"",        // the default (nameless) exchange
		queueName, // routing key == queue name, thanks to the implicit binding
		false, false,
		amqp.Publishing{ContentType: "text/plain", Body: body},
	)
}

func must(err error, what string) {
	if err != nil {
		log.Fatalf("%s: %v", what, err)
	}
}
```

Two things in this code are worth dwelling on. First, the consumer is started *before* the publish and declares nothing it does not need — this is the discipline that prevents lost messages, because a message published to an exchange with no matching bound queue is discarded. Second, `publishViaDefaultExchange` shows that the "publish straight to a queue" shorthand is not a different mechanism; it is the same exchange-binding-routing-key pipeline with the default exchange and an implicit name-based binding. Once you see that, RabbitMQ's routing stops being a special case and becomes one uniform model.

A word on the boolean-heavy signatures, since they are where real bugs hide. The `amqp091-go` API mirrors the AMQP method arguments positionally rather than by name, so `ExchangeDeclare("orders", "direct", true, false, false, false, nil)` is a wall of booleans whose meaning is not visible at the call site — durable, then auto-delete, then internal, then no-wait. It is worth wrapping topology setup in a small typed helper (a `declareExchange(name, kind string, opts ExchangeOpts)`) in any non-trivial codebase, both so the flags are self-documenting and so every client that declares the same object passes identical properties, which is exactly what the broker's equivalence check demands. The cost of a mismatched boolean here is a `406` and a closed channel at start-up, or worse, a queue that silently is not durable when you believed it was.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Producer/consumer decoupling by construction.** Publishing to an exchange rather than a queue means the producer names *what happened*, not *who cares*; new consumers bind without touching the producer.
- **Rich, centralised routing.** One message can fan out to many queues, or be filtered to one, entirely via broker-side bindings — no routing code in clients.
- **Idempotent declares.** Every client asserts the topology it needs at start-up, so the system self-heals and there is no separate provisioning step to get out of sync.
- **Fine-grained queue semantics.** Durable, exclusive and auto-delete let you model everything from a persistent shared work queue to a private, self-cleaning reply queue with the same primitive.
- **The default exchange gives a zero-config path** for the simple direct-to-named-queue case without abandoning the general model.

**Disadvantages**
- **A conceptual hurdle.** The producer-never-touches-a-queue indirection surprises newcomers and is a frequent source of "where did my message go?" confusion.
- **Silent drops.** A message that matches no binding vanishes by default; you only learn otherwise via the `mandatory` flag and return handling (chapter 10).
- **Topology sprawl.** Rich routing invites a proliferation of exchanges, queues and bindings that becomes hard to reason about and audit without discipline.
- **Property equivalence traps.** A single client declaring a queue with mismatched durability/arguments gets a `406` and a closed channel, which can be baffling mid-incident.

**Trade-offs**
- *Indirection vs directness:* routing through an exchange buys decoupling and fan-out at the cost of an extra concept and the possibility of silent unroutable messages. A direct point-to-point tool would be simpler but far less flexible.
- *Declare-everywhere vs central provisioning:* having every client assert its topology is robust and self-healing, but it spreads topology definitions across codebases; some teams prefer central provisioning (via `rabbitmqadmin` / definitions files) for auditability, at the cost of clients assuming a pre-built broker.
- *Queue lifetime flags vs simplicity:* durable/exclusive/auto-delete express precise lifecycles but multiply the ways two clients can disagree; picking sensible defaults (durable, non-exclusive, non-auto-delete for shared work queues) avoids most footguns.

## 7. Common Mistakes & Best Practices

- **Trying to publish "to a queue".** There is no such operation except via the default exchange. If you publish to a custom exchange expecting a queue name to route it, nothing matches and the message is dropped. Publish to an exchange with a routing key that a binding matches.
- **Publishing before any queue is bound.** A message with no matching binding is silently discarded. Declare and bind the consumer's queue *before* producers start, or accept that early messages vanish.
- **Assuming `durable=true` alone survives a restart.** A durable queue keeps its *definition*, but the *messages* also need persistent delivery (`delivery_mode=2`) to survive. Both are required (chapter 10).
- **Re-declaring a queue with different properties.** Changing `durable` or `arguments` on an existing queue triggers `406 PRECONDITION_FAILED` and closes the channel. Delete and recreate, or keep every declarer's properties identical.
- **Using an exclusive or auto-delete queue for shared work.** Exclusive queues die with their connection and auto-delete queues die when the last consumer leaves — great for private reply queues, disastrous for a durable shared work queue that must outlive any one client.
- **Confusing routing key with binding key.** The routing key is per-message (producer side); the binding key is per-binding (declared once). They are matched against each other in the exchange's type-specific language.
- **Best practice: make every client declare its full topology idempotently at start-up, agree on properties across clients, always publish to a named exchange with a deliberate routing key, and set `mandatory` when an unroutable message must never be lost silently.**

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The first question for a "missing message" is *did it route?* Use the management UI or `rabbitmqctl list_bindings` / `rabbitmqadmin list bindings` to confirm a binding exists whose key matches the routing key, and check the queue's message count with `rabbitmqctl list_queues name messages messages_ready messages_unacknowledged`. A routing key that matches no binding is dropped, so enable publisher `mandatory` + a return listener (chapter 10) in staging to surface unroutable messages instead of losing them. The firehose tracer (`rabbitmq_tracing` plugin) can capture exactly what the broker received and where it routed.
- **Monitoring.** Watch per-queue **message count**, **messages_ready** (waiting for a consumer) and **messages_unacknowledged** (delivered but not yet acked), plus **consumer count** per queue — a queue with rising `messages_ready` and zero consumers is a bound-but-unserviced queue, one of the commonest topology bugs. Alert on queue depth growth and on unroutable/returned message rate (chapter 27).
- **Security.** Authorisation in RabbitMQ is per-vhost and per-object: permissions are granted as regex over *configure* (declare/delete), *write* (publish to an exchange, bind), and *read* (consume from a queue, bind). A producer needs write on the exchange; a consumer needs read on the queue and write to bind. Scope permissions tightly, isolate tenants in separate vhosts, and enable TLS so routing keys and payloads are not on the wire in clear (chapter 29).
- **Scaling.** A single queue is served by one Erlang process and lives on one node (its home node), so a hot queue does not scale by adding queue capacity — it scales by adding *competing consumers* (chapter 8) and, if the queue itself is the bottleneck, by sharding across multiple queues bound to the same exchange (consistent-hash or by routing key). For availability, use **quorum queues** (Raft-replicated) rather than the deprecated classic mirrored queues (chapter 12). Bindings are cheap; queues are the unit that carries load.

## 9. Interview Questions

**Q: In AMQP 0-9-1, can a producer publish directly to a queue?**
A: No. A producer publishes to an *exchange*, always. The exchange then routes copies to queues according to its type and its bindings. The one apparent exception — publishing "to a queue" by name — is really publishing to the default (nameless) exchange with the queue's name as the routing key, exploiting the fact that every queue is automatically bound to the default exchange by its own name. So even that case goes through an exchange; the producer never enqueues a message itself. This indirection is deliberate: it decouples the producer, which states what happened, from the consumers, whose queues state what they want, so new consumers can be added by binding new queues without changing the producer.

**Q: What is the difference between a routing key and a binding key?**
A: The routing key is a property of the message, set by the producer on every publish — it describes the message, like `order.created`. The binding key is a property of the binding, fixed when you run `queue.bind` — it describes what a queue wants to receive, like `order.*`. The exchange matches a message's routing key against each binding's binding key using the matching rule of its type: exact equality for direct, wildcard pattern for topic, ignored entirely for fanout. So the routing key is what the message says about itself and the binding key is what a queue asks to hear; they meet in the exchange.

**Q: What does the default exchange do, and how does it make `publish(exchange="", routingKey="hello")` work?**
A: The default exchange is a pre-declared, nameless direct exchange that exists in every virtual host. RabbitMQ automatically binds every queue to it with a binding key equal to the queue's name. So when you publish to exchange `""` with routing key `"hello"`, the default direct exchange looks for a binding whose key equals `"hello"` and finds the auto-binding for the queue named `hello`, delivering the message there. It looks like publishing straight to a queue, but it is the ordinary exchange-binding-routing-key model with a convenient default. You cannot delete the default exchange or add your own bindings to it.

**Q: What does it mean that declares are idempotent, and what happens on a property mismatch?**
A: Declaring an exchange, queue or binding asserts that it exists with the given properties: if it already exists identically, the declare is a harmless no-op; if it does not exist, it is created. This lets every client declare the full topology it depends on at start-up without coordination. But if a client declares an object that already exists with *different* properties — for example asking for `durable=true` on a queue that was created `durable=false` — the broker rejects it with `406 PRECONDITION_FAILED` and closes the channel. This equivalence check prevents two clients silently disagreeing about a queue's durability or arguments.

**Q: What happens to a message that matches no binding?**
A: By default it is silently dropped — the exchange finds no destination queue and discards the message, with no error to the producer. This is a frequent cause of "my message disappeared". To detect it, the producer sets the `mandatory` flag on publish and registers a return listener; the broker then returns the unroutable message to the producer instead of dropping it. Alternatively, an *alternate exchange* can be configured on the exchange to catch otherwise-unroutable messages. Without one of these, an unmatched routing key means a lost message.

**Q: What do the durable, exclusive and auto-delete queue properties mean?**
A: Durable means the queue's definition survives a broker restart (the messages additionally need persistent delivery to survive). Exclusive means the queue may be used by only the connection that declared it and is deleted when that connection closes — ideal for a private, temporary reply queue. Auto-delete means the queue is deleted once its last consumer unsubscribes, after at least one has connected — useful for ephemeral subscriptions. For a shared, persistent work queue you want durable, non-exclusive, non-auto-delete; the other combinations model private or transient queues.

**Q: Why does the exchange indirection make a RabbitMQ system extensible?**
A: Because the producer publishes to an exchange and names only *what happened* via the routing key, it does not know or care which queues consume the message. To add a new reaction — say, a fraud-check service — you declare a new queue, bind it to the existing exchange with an appropriate binding key, and start a consumer. The producer is untouched and undeployed. This is the location-and-identity decoupling that a message system exists to provide: the topology of consumers evolves independently of the code that emits events, with the exchange as the stable seam between them.

**Q: (Senior) You have a producer publishing `order.created` and a bound consumer queue, yet the queue stays empty. How do you diagnose it?**
A: I would work the routing path from both ends. First, confirm the message is even reaching the broker: check the exchange's message-rate metrics or enable a tracing plugin, and verify the producer is publishing to the exchange I think it is — a very common bug is publishing to the default exchange (`""`) with the exchange name as the routing key, which routes to a queue of that name, not through my custom exchange. Second, confirm a binding exists whose key actually matches: `list_bindings` for the exchange, and check the binding key against the routing key in the exchange's type language — for a direct exchange they must be byte-for-byte equal, so a trailing space or a `orders.created` vs `order.created` typo silently drops everything. Third, check whether the message is being routed but consumed elsewhere: if two queues are bound with the same key, or a shovel/federation is siphoning it, or another consumer on the same queue is taking it round-robin. Fourth, check for property mismatches causing declare failures that leave the queue unbound. The fastest signal is usually `messages` and `messages_ready` on the queue plus the exchange's `publish_out` rate: if publishes go up but the queue's ready count does not, it is a routing (binding-key) problem, not a consumer problem. I would also turn on `mandatory` in staging so unroutable messages are returned rather than vanishing, which converts a silent drop into a loud, diagnosable event.

**Q: (Senior) When would you have every client declare the topology versus provisioning it centrally, and what are the risks of each?**
A: The declare-everywhere approach — each producer and consumer idempotently asserting the exchanges, queues and bindings it needs at start-up — is robust and self-healing: a fresh broker or a recreated vhost is repopulated by the clients themselves, there is no separate provisioning step to drift out of sync, and a client can never run against a topology it did not assert. Its risks are that topology definitions are scattered across multiple codebases (so the authoritative shape of the system is hard to see in one place), and that a single client declaring with mismatched properties throws a `406` and closes its channel, which during an incident can be confusing. Central provisioning — a definitions JSON loaded at boot, or `rabbitmqadmin` in a deployment pipeline — gives you one auditable source of truth, enforces consistent properties, and lets you review topology changes like schema migrations; its risk is that clients now *assume* a pre-built broker, so a provisioning failure or a forgotten binding is discovered only at runtime as dropped messages, and disaster recovery must rebuild the topology before clients can work. My usual answer is a hybrid: provision the durable, shared, cross-team objects (the core exchanges and their durable queues) centrally and under review, while letting clients idempotently declare their *own* private objects (per-service queues, exclusive reply queues) — with a hard rule that all declarers of any shared object agree on its properties exactly, since that agreement is what the `406` check is protecting.

**Q: (Senior) Why is a message delivered as a *copy* per matched queue, and what does that imply for ordering and delivery guarantees?**
A: When an exchange routes a message to N matched queues, it enqueues an independent copy in each, and from that point the copies have separate fates: each queue delivers its copy to its own consumers, gets its own acks, and can requeue, dead-letter or expire independently of the others. This is what makes fan-out clean — the audit queue backing up does not slow the fulfilment queue — but it has three implications. First, ordering is a per-queue property, not a global one: two messages fan out to the same set of queues in the same order, but consumers on different queues process at different rates, so there is no cross-queue ordering guarantee, and even within a queue, multiple competing consumers interleave effects (chapter 22). Second, delivery guarantees are per-copy: a publish that "succeeds" (with publisher confirms, chapter 10) means the broker durably accepted the message and routed the copies, but each copy is then independently subject to at-least-once redelivery on its own queue, so each consumer must be idempotent on its own account. Third, the mandatory/unroutable semantics are about the *set* of copies: a message is "unroutable" only if it matched zero queues; if it matched at least one, `mandatory` is satisfied even if you expected more. So the copy-per-queue model is what lets independent consumers scale and fail independently, at the cost of there being no single global order or single delivery outcome for a fanned-out message.

## 10. Quick Revision & Cheat Sheet

| Object | What it is | Who names it | Key property |
|---|---|---|---|
| Exchange | Routing target for publishes | Producer names it on publish | type: direct/fanout/topic/headers |
| Queue | Buffer consumers read from | Consumer declares it | durable / exclusive / auto-delete |
| Binding | Exchange→queue link + binding key | Declared via queue.bind | binding key matched vs routing key |
| Routing key | Per-message label | Producer, per publish | matched by exchange type |
| Default exchange | Nameless direct exchange | Always exists | auto-binds every queue by its name |

| Declare flag (queue) | Meaning |
|---|---|
| durable | Definition survives broker restart |
| exclusive | One connection only; deleted on its close |
| auto-delete | Deleted when last consumer unsubscribes |
| passive | Check existence only; do not create |

**Flash cards**
- **Where does a producer publish?** → To an *exchange*, never a queue (bar the default-exchange shorthand).
- **Routing key vs binding key?** → Routing key is on the message (producer); binding key is on the binding (queue.bind); the exchange matches them.
- **Why does publish-to-a-queue-name work?** → The default nameless direct exchange auto-binds every queue by its own name.
- **What happens to an unmatched message?** → Silently dropped, unless `mandatory` + return handling or an alternate exchange.
- **What makes a declare fail?** → Re-declaring an existing object with conflicting properties → `406 PRECONDITION_FAILED`.
- **Which queue property suits a shared work queue?** → durable, non-exclusive, non-auto-delete.

## 11. Hands-On Exercises & Mini Project

- [ ] Declare a direct exchange, a queue, and a binding with key `order.created`; publish with matching and non-matching routing keys and confirm which arrive.
- [ ] Publish to the default exchange (`""`) using a queue name as the routing key; then draw the implicit binding that makes it work.
- [ ] Re-declare an existing queue with `durable` flipped and observe the `406 PRECONDITION_FAILED` and channel closure.
- [ ] Bind two queues to one exchange with the same binding key and confirm each receives its own copy of every matching message.
- [ ] Declare an exclusive queue, open a second connection, and confirm the second cannot consume from it; then close the first connection and watch the queue disappear.
- [ ] Publish with `mandatory=true` and no matching binding, register a return listener, and catch the unroutable message instead of losing it.

### Mini Project — "Order Events Topology"

**Goal.** Build and operate a small but realistic RabbitMQ topology for order events, proving that the exchange decouples producers from consumers and that routing behaves exactly as the bindings say.

**Requirements.**
1. Declare a durable exchange `orders` and three durable queues — `orders.fulfilment`, `orders.email`, `orders.audit` — each bound with a deliberate binding key so a single `order.created` publish reaches the right subset.
2. Write a producer that publishes order events with routing keys (`order.created`, `order.cancelled`) and persistent delivery, and three consumers that each declare and bind their own queue idempotently at start-up.
3. Demonstrate adding a fourth consumer (`orders.analytics`) by binding a new queue to the existing exchange with *no change to the producer*, and show it starts receiving events immediately.
4. Enable `mandatory` on the producer with a return listener and deliberately publish an unmatched routing key to prove the message is returned rather than silently dropped.
5. Use `rabbitmqctl list_bindings` and `list_queues name messages consumers` to verify the topology and observe message counts as you publish.

**Extensions.**
- Add an *alternate exchange* to `orders` so unroutable messages are captured into a `orders.unrouted` queue instead of being returned, and compare the two approaches.
- Shard the busiest queue behind the same exchange using the consistent-hash exchange plugin and distribute load across multiple queues while preserving per-key affinity.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Connections, Channels & Virtual Hosts* (the transport these operations run over), *Exchange Types: Direct, Fanout, Topic & Headers* (how matching actually works per type), *Producing & Consuming: Acks, Prefetch & QoS* (the consume side in depth), *Reliability: Publisher Confirms, Durability & the Mandatory Flag* (not losing messages), *Dead-Letter Exchanges, TTL & Delayed Messages* (what happens to rejected and expired messages).

- **RabbitMQ — AMQP 0-9-1 Model Explained** — RabbitMQ · *Beginner* · the canonical description of exchanges, queues, bindings and the default exchange; read this alongside the chapter. <https://www.rabbitmq.com/tutorials/amqp-concepts>
- **RabbitMQ — Tutorial 1 & 4 (Hello World, Routing)** — RabbitMQ · *Beginner* · runnable examples that make the default exchange and direct routing concrete. <https://www.rabbitmq.com/tutorials/tutorial-four-python>
- **AMQP 0-9-1 Reference — classes & methods** — RabbitMQ · *Intermediate* · the precise semantics of `exchange.declare`, `queue.declare`, `queue.bind` and their arguments. <https://www.rabbitmq.com/amqp-0-9-1-reference>
- **AMQP 0-9-1 Complete Reference Guide** — RabbitMQ · *Advanced* · the full protocol model, useful when the boolean flags and equivalence rules bite. <https://www.rabbitmq.com/amqp-0-9-1-quickref>
- **rabbitmq/amqp091-go** — RabbitMQ (GitHub) · *Intermediate* · the official Go client used in this chapter, with example programs for declare/publish/consume. <https://github.com/rabbitmq/amqp091-go>
- **RabbitMQ — Queues** — RabbitMQ · *Intermediate* · durable/exclusive/auto-delete semantics, queue properties and lifecycle in depth. <https://www.rabbitmq.com/docs/queues>
- **Enterprise Integration Patterns — Message Router & Message Channel** — Hohpe & Woolf · *Intermediate* · the patterns that the exchange/binding model implements. <https://www.enterpriseintegrationpatterns.com/patterns/messaging/MessageRouter.html>
- **RabbitMQ in Depth** — Gavin M. Roy (Manning) · *Advanced* · a thorough treatment of the AMQP object model and topology design for production. <https://www.manning.com/books/rabbitmq-in-depth>

---

*Kafka & RabbitMQ Handbook — chapter 06.*
