# 03 · Design: Kafka vs RabbitMQ — When to Use Which

> **In one line:** Kafka is a dumb broker holding a smart, replayable *log* and RabbitMQ is a smart broker routing to dumb, ephemeral *queues* — so the choice is almost never about raw speed, it is about whether you need replayable retention and per-partition ordering at high throughput (Kafka) or rich per-message routing, priority and acknowledgement semantics (RabbitMQ).

---

## 1. Overview

Every "Kafka vs RabbitMQ" argument that turns into a benchmark shoot-out has already gone wrong. They are not two implementations of the same thing that differ on performance; they are two different *shapes* of messaging, and the honest decision is about which shape fits your problem. Chapter 2 named the primitives — queue, pub/sub, log. This chapter turns the retain-versus-delete axis into an actual decision procedure, because that axis is where the two systems part company and nearly everything else follows from it.

The one-sentence version: **RabbitMQ is a smart broker with dumb consumers; Kafka is a dumb broker with smart consumers.** In RabbitMQ the intelligence lives in the broker — producers publish to an *exchange*, and the broker routes to *queues* by binding rules, applies per-message TTL and priority, hands each message to exactly one consumer, waits for an acknowledgement, and then *deletes* the message. The consumer just processes what it is handed. In Kafka the intelligence lives in the client — the broker is close to a dumb, append-only file that it serves with brutal efficiency, and the *consumer* decides what to read, tracks its own position (offset), and can re-read history because the broker retains everything for a window regardless of who consumed it.

That single difference cascades. Because Kafka retains, it can replay, feed many independent consumer groups from one topic, and act as a system of record and an integration backbone — at the cost of dumb routing (a key picks a partition, and that is almost all it does) and ordering that holds only *within* a partition, never globally. Because RabbitMQ deletes on acknowledgement, it cannot replay, but in exchange it offers genuinely rich routing (direct, topic, fanout, headers exchanges), per-message priority and TTL, dead-letter routing, and RPC — the ergonomics of a *smart* broker that a log deliberately refuses to be.

So the summary you should carry into a design round is: reach for **Kafka** when the problem is *event streaming, a replayable log, high fan-out throughput, or ordered-per-key processing*; reach for **RabbitMQ** when the problem is *complex routing, task queues, request/reply, or per-message semantics like priority and TTL at more modest volume*. And notice, before we even get to the matrix, that these are not mutually exclusive: a great many production systems run *both*, using each for the shape of traffic it fits. This chapter gives you the matrix, the "when each wins" cases, and a decision procedure you can actually apply.

## 2. Core Concepts

- **Dumb broker / smart consumer (Kafka)** — the broker appends records to a partitioned log and serves reads; the consumer decides what to read, tracks its own offset, and can re-read. Routing intelligence is minimal.
- **Smart broker / dumb consumer (RabbitMQ)** — the broker routes messages to queues by binding rules, applies per-message semantics, and pushes to consumers; the consumer just processes and acknowledges.
- **The log (Kafka)** — a topic split into partitions, each an ordered, immutable, append-only sequence of records addressed by monotonic **offset**; retained by time/size, replayable, not deleted on read.
- **The queue (RabbitMQ)** — an ordered buffer a consumer reads from; a message is removed once acknowledged. Fed *indirectly* — producers publish to an **exchange**, which routes to queues via **bindings**.
- **Exchange & routing (RabbitMQ)** — direct (exact routing-key match), topic (`*`/`#` wildcards), fanout (broadcast), headers (attribute match). This is the "smart" in smart broker.
- **Partition & key (Kafka)** — the producer's key hashes to a partition; same key → same partition → ordered. Partition count is the unit of parallelism *and* the only ordering guarantee.
- **Offset-based vs ack-based** — Kafka consumers commit an offset ("I have read up to here"); RabbitMQ consumers acknowledge individual messages ("delete this one now").
- **Retention vs deletion** — Kafka keeps messages for a window regardless of consumption (replayable); RabbitMQ deletes on ack (ephemeral).
- **Consumer group (Kafka)** — a set of consumers sharing a topic's partitions; different groups each read the whole topic (this is how one log yields both queue and pub/sub).
- **Throughput vs routing flexibility** — the headline trade: Kafka trades routing richness for sequential-write throughput; RabbitMQ trades throughput for routing and per-message flexibility.

## 3. Theory & Principles

### The fundamental split, precisely

Hold the two mental models side by side, because confusing them is the source of nearly every bad "vs" argument.

**Kafka is a distributed commit log.** A topic is partitioned; each partition is an ordered, append-only file. Producers append; the broker's genius is that appending to a file and serving it via the OS page cache with zero-copy `sendfile` is astonishingly fast and scales linearly with partitions. The broker does *not* track who has read what — the consumer does, via an offset stored in the `__consumer_offsets` topic. Messages are retained for days regardless of consumption. This makes Kafka a *pull*, offset-based, replayable log: dumb broker, smart consumer.

**RabbitMQ is a message router with queues.** Producers never publish to a queue directly; they publish to an *exchange* with a routing key, and the broker's bindings decide which queue(s) the message lands in. The broker then *pushes* messages to consumers (with prefetch limiting how many are in flight), waits for a per-message acknowledgement, and deletes the message once acked. It can hold per-message priority, per-message and per-queue TTL, dead-letter routing, and reply-to for RPC. This makes RabbitMQ a *push*, ack-based, ephemeral router: smart broker, dumb consumer.

From this, everything else is downstream:

- **Replay.** Kafka: yes, seek an offset back and re-read — retained data is still there. RabbitMQ: no, an acked message is gone (Streams, chapter 12, are the exception RabbitMQ added to close this gap).
- **Ordering.** Kafka: total order *within a partition*, never across partitions — so per-key order is achievable, global order is not (without a single partition, which kills parallelism). RabbitMQ: order within a single queue with a single consumer, lost once you add competing consumers or requeue.
- **Fan-out.** Kafka: cheap — add a consumer group, it reads the whole retained log independently, including history. RabbitMQ: bind another queue to the exchange, but a subscriber that was down misses messages (no retention).
- **Delivery unit.** Kafka: the consumer advances a coarse offset ("I have processed up to record N"). RabbitMQ: the consumer acks or nacks *individual* messages, can selectively requeue one and keep the rest — far finer-grained.
- **Throughput.** Kafka: very high (sequential disk, batching, zero-copy), millions of messages/sec on modest clusters. RabbitMQ: high but lower (per-message bookkeeping, routing, acks), tens of thousands/sec per queue typically — plenty for most systems, but a different order of magnitude.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="k1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="k2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#ea580c"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two shapes of messaging: dumb broker + smart log vs smart broker + dumb queue</text>

  <rect x="24" y="40" width="410" height="404" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#5b21b6" font-size="13" font-weight="bold">KAFKA &#8212; dumb broker, smart consumer</text>
  <rect x="44" y="76" width="70" height="30" rx="5" fill="#fff" stroke="#a78bfa"/><text x="79" y="95" text-anchor="middle" fill="#5b21b6" font-size="10">producer</text>
  <text x="150" y="88" fill="#6d28d9" font-size="9">key hashes</text><text x="150" y="100" fill="#6d28d9" font-size="9">to a partition</text>
  <path d="M116,91 L232,91" stroke="#7c3aed" stroke-width="2" marker-end="url(#k1)"/>
  <text x="330" y="80" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">topic = partitioned LOG</text>
  <g font-size="8">
    <rect x="244" y="90" width="24" height="18" fill="#fff" stroke="#7c3aed"/><text x="256" y="103" text-anchor="middle" fill="#5b21b6">0</text>
    <rect x="268" y="90" width="24" height="18" fill="#fff" stroke="#7c3aed"/><text x="280" y="103" text-anchor="middle" fill="#5b21b6">1</text>
    <rect x="292" y="90" width="24" height="18" fill="#fff" stroke="#7c3aed"/><text x="304" y="103" text-anchor="middle" fill="#5b21b6">2</text>
    <rect x="316" y="90" width="24" height="18" fill="#fff" stroke="#7c3aed"/><text x="328" y="103" text-anchor="middle" fill="#5b21b6">3</text>
    <rect x="340" y="90" width="66" height="18" fill="#f5f3ff" stroke="#c4b5fd" stroke-dasharray="3 2"/><text x="373" y="103" text-anchor="middle" fill="#7c3aed">append &#8594;</text>
  </g>
  <rect x="244" y="132" width="180" height="24" rx="4" fill="#ddd6fe" stroke="#7c3aed"/><text x="334" y="148" text-anchor="middle" fill="#5b21b6" font-size="9">group A: offset=2 (pulls, tracks own pos)</text>
  <rect x="244" y="160" width="180" height="24" rx="4" fill="#ddd6fe" stroke="#7c3aed"/><text x="334" y="176" text-anchor="middle" fill="#5b21b6" font-size="9">group B: offset=0 (replays history)</text>
  <text x="44" y="212" fill="#5b21b6" font-size="10" font-weight="bold">Broker just appends &amp; serves the file.</text>
  <text x="44" y="232" fill="#6d28d9" font-size="10">&#8226; RETAINED &#8594; replayable, many groups</text>
  <text x="44" y="252" fill="#6d28d9" font-size="10">&#8226; order per-partition only (key &#8594; partition)</text>
  <text x="44" y="272" fill="#6d28d9" font-size="10">&#8226; offset-based, coarse commit</text>
  <text x="44" y="292" fill="#6d28d9" font-size="10">&#8226; dumb routing: key picks a partition, that's all</text>
  <text x="44" y="312" fill="#6d28d9" font-size="10">&#8226; sequential disk + zero-copy &#8594; very high throughput</text>
  <rect x="44" y="330" width="366" height="98" rx="6" fill="#f5f3ff" stroke="#a78bfa"/>
  <text x="227" y="350" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">Wins: streaming, CDC backbone, replay,</text>
  <text x="227" y="368" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">high fan-out, ordered-per-key at scale</text>
  <text x="227" y="392" text-anchor="middle" fill="#6d28d9" font-size="9">throughput &amp; retention over routing richness</text>
  <text x="227" y="412" text-anchor="middle" fill="#6d28d9" font-size="9">heavier ops: partitions, offsets, replicas</text>

  <rect x="446" y="40" width="410" height="404" rx="10" fill="#fff7ed" stroke="#ea580c" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#c2410c" font-size="13" font-weight="bold">RABBITMQ &#8212; smart broker, dumb consumer</text>
  <rect x="466" y="76" width="66" height="30" rx="5" fill="#fff" stroke="#fdba74"/><text x="499" y="95" text-anchor="middle" fill="#c2410c" font-size="10">producer</text>
  <path d="M534,91 L572,91" stroke="#ea580c" stroke-width="2" marker-end="url(#k2)"/>
  <rect x="574" y="76" width="80" height="30" rx="5" fill="#fed7aa" stroke="#ea580c" stroke-width="2"/><text x="614" y="95" text-anchor="middle" fill="#c2410c" font-size="9">EXCHANGE</text>
  <text x="700" y="88" fill="#c2410c" font-size="9">routes by key</text><text x="700" y="100" fill="#c2410c" font-size="9">+ bindings</text>
  <rect x="574" y="120" width="120" height="22" rx="4" fill="#ffedd5" stroke="#ea580c"/><text x="634" y="135" text-anchor="middle" fill="#c2410c" font-size="9">queue: orders</text>
  <rect x="574" y="146" width="120" height="22" rx="4" fill="#ffedd5" stroke="#ea580c"/><text x="634" y="161" text-anchor="middle" fill="#c2410c" font-size="9">queue: audit</text>
  <path d="M614,106 L620,118" stroke="#ea580c" stroke-width="1.5" marker-end="url(#k2)"/>
  <path d="M624,106 L640,144" stroke="#ea580c" stroke-width="1.5" marker-end="url(#k2)"/>
  <rect x="720" y="120" width="120" height="22" rx="4" fill="#fff" stroke="#fdba74"/><text x="780" y="135" text-anchor="middle" fill="#c2410c" font-size="9">consumer (acks)</text>
  <path d="M694,131 L716,131" stroke="#ea580c" stroke-width="1.5" marker-end="url(#k2)"/>
  <text x="466" y="196" fill="#c2410c" font-size="10" font-weight="bold">Broker routes, holds semantics, pushes.</text>
  <text x="466" y="216" fill="#c2410c" font-size="10">&#8226; DELETED on ack &#8594; ephemeral, no replay</text>
  <text x="466" y="236" fill="#c2410c" font-size="10">&#8226; rich routing: direct / topic / fanout / headers</text>
  <text x="466" y="256" fill="#c2410c" font-size="10">&#8226; per-message ack / nack / TTL / priority</text>
  <text x="466" y="276" fill="#c2410c" font-size="10">&#8226; push + prefetch flow control</text>
  <text x="466" y="296" fill="#c2410c" font-size="10">&#8226; order in one queue, one consumer</text>
  <text x="466" y="316" fill="#c2410c" font-size="10">&#8226; throughput lower: per-message bookkeeping</text>
  <rect x="466" y="330" width="366" height="98" rx="6" fill="#fffbeb" stroke="#fdba74"/>
  <text x="649" y="350" text-anchor="middle" fill="#c2410c" font-size="10" font-weight="bold">Wins: complex routing, task queues,</text>
  <text x="649" y="368" text-anchor="middle" fill="#c2410c" font-size="10" font-weight="bold">RPC, per-message priority / TTL</text>
  <text x="649" y="392" text-anchor="middle" fill="#c2410c" font-size="9">routing richness &amp; per-message control over</text>
  <text x="649" y="412" text-anchor="middle" fill="#c2410c" font-size="9">raw throughput and replay</text>
</svg>
```

### Why "which is faster?" is the wrong question

Kafka *is* faster at raw throughput — that is not in dispute, and it is by design: sequential appends, large batches, compression, and zero-copy reads make it a throughput machine. But framing the choice as speed misleads, because RabbitMQ's tens of thousands of messages per second per queue is *more than enough* for the overwhelming majority of systems, and choosing Kafka for a workload that needs rich routing and per-message priority means fighting the log's deliberate dumbness for the rest of the project. Conversely, choosing RabbitMQ for a 500k-events/sec analytics firehose that needs replay means fighting the broker's per-message bookkeeping. The right question is never "which is faster" but **"which shape fits — do I need a replayable ordered log, or a smart per-message router?"** Speed is a tie-breaker inside the right shape, not the thing that picks the shape.

## 4. Architecture & Workflow

The two data paths make the split concrete. Trace a message through each.

**Kafka path.** (1) The producer serialises a record with an optional *key*, batches it, and sends it to the partition leader; the key hashes to a partition, so same key → same partition → order preserved. (2) The leader appends to the partition's log segment and replicates to in-sync followers; with `acks=all` it confirms only once the replicas have it. (3) The record sits in the log, retained by time/size, *whether or not anyone reads it*. (4) Each consumer group independently reads forward from its committed offset, pulling batches; the broker does no per-consumer bookkeeping beyond serving offsets. (5) The consumer commits its offset ("processed up to N"). To replay, it seeks the offset backwards. Nothing is deleted on read.

**RabbitMQ path.** (1) The producer publishes to an *exchange* with a routing key (never to a queue directly). (2) The exchange applies its type and bindings — direct matches the key exactly, topic matches wildcards, fanout ignores the key and copies to all bound queues, headers matches attributes — and the message lands in zero or more queues. (3) Each queue holds the message (in memory, and on disk if durable + persistent). (4) The broker *pushes* messages to consumers subscribed to the queue, respecting each consumer's prefetch limit (how many unacked messages it will hold). (5) The consumer processes and sends `basic.ack` — now the broker *deletes* the message. On `basic.nack`/`reject` it can requeue or dead-letter. Order and delivery are per-message and fine-grained.

The workflow difference that bites in practice: in Kafka the consumer owns its progress (the offset), so a slow or crashed consumer never affects the broker's storage — the log just sits there. In RabbitMQ the broker owns undelivered and unacked messages, so a consumer that stops acking makes the queue grow *in the broker*, consuming its memory, until flow control or an alarm kicks in. Kafka pushes the "where am I" state to the client; RabbitMQ keeps it in the broker. That is the smart/dumb split expressed as an operational reality.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="d1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">A decision tree: which shape fits the traffic?</text>

  <rect x="330" y="40" width="220" height="46" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="60" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Do you need to REPLAY / re-read</text>
  <text x="440" y="76" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">history, or many independent readers?</text>

  <path d="M400,86 L250,120" stroke="#2563eb" stroke-width="1.5" marker-end="url(#d1)"/>
  <text x="300" y="106" fill="#15803d" font-size="10" font-weight="bold">YES</text>
  <path d="M480,86 L630,120" stroke="#2563eb" stroke-width="1.5" marker-end="url(#d1)"/>
  <text x="560" y="106" fill="#b91c1c" font-size="10" font-weight="bold">NO</text>

  <rect x="120" y="122" width="250" height="44" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="245" y="142" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">Very high throughput OR ordered-</text>
  <text x="245" y="158" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">per-key streaming at scale?</text>

  <rect x="510" y="122" width="250" height="44" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="2"/>
  <text x="635" y="142" text-anchor="middle" fill="#c2410c" font-size="10" font-weight="bold">Need complex routing, priority,</text>
  <text x="635" y="158" text-anchor="middle" fill="#c2410c" font-size="10" font-weight="bold">per-message TTL, or RPC?</text>

  <path d="M200,166 L160,200" stroke="#2563eb" stroke-width="1.5" marker-end="url(#d1)"/>
  <text x="150" y="188" fill="#15803d" font-size="9" font-weight="bold">YES</text>
  <path d="M300,166 L360,200" stroke="#2563eb" stroke-width="1.5" marker-end="url(#d1)"/>
  <text x="345" y="188" fill="#94a3b8" font-size="9">either</text>
  <path d="M600,166 L560,200" stroke="#2563eb" stroke-width="1.5" marker-end="url(#d1)"/>
  <text x="548" y="188" fill="#b91c1c" font-size="9" font-weight="bold">NO</text>
  <path d="M690,166 L720,200" stroke="#2563eb" stroke-width="1.5" marker-end="url(#d1)"/>
  <text x="708" y="188" fill="#15803d" font-size="9" font-weight="bold">YES</text>

  <rect x="70" y="204" width="190" height="70" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="165" y="228" text-anchor="middle" fill="#5b21b6" font-size="13" font-weight="bold">KAFKA</text>
  <text x="165" y="248" text-anchor="middle" fill="#6d28d9" font-size="9">replayable log, high fan-out,</text>
  <text x="165" y="262" text-anchor="middle" fill="#6d28d9" font-size="9">per-partition order, streaming</text>

  <rect x="300" y="204" width="290" height="70" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="445" y="226" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Judgement zone</text>
  <text x="445" y="246" text-anchor="middle" fill="#475569" font-size="9">modest volume, simple routing, no replay:</text>
  <text x="445" y="262" text-anchor="middle" fill="#475569" font-size="9">RabbitMQ is usually simpler &#8212; or run BOTH</text>

  <rect x="630" y="204" width="190" height="70" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="2"/>
  <text x="725" y="228" text-anchor="middle" fill="#c2410c" font-size="13" font-weight="bold">RABBITMQ</text>
  <text x="725" y="248" text-anchor="middle" fill="#c2410c" font-size="9">smart routing, task queues,</text>
  <text x="725" y="262" text-anchor="middle" fill="#c2410c" font-size="9">RPC, priority / TTL</text>

  <rect x="24" y="296" width="832" height="118" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="318" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">The one axis that decides most cases: retention</text>
  <text x="48" y="344" fill="#1d4ed8" font-size="10">&#8226; Need replay, a system of record, CDC, or many independent readers of the same stream &#8594; the LOG (Kafka).</text>
  <text x="48" y="366" fill="#1d4ed8" font-size="10">&#8226; Need to route one message to different consumers by content, or per-message priority / TTL / RPC &#8594; the smart BROKER (RabbitMQ).</text>
  <text x="48" y="388" fill="#1d4ed8" font-size="10">&#8226; Need both, on different traffic (a streaming firehose AND a routed task pipeline) &#8594; run BOTH; it is common and correct.</text>
  <text x="440" y="408" text-anchor="middle" fill="#1e3a8a" font-size="10" font-weight="bold">Pick the shape first; let throughput be the tie-breaker inside the shape.</text>
</svg>
```

## 5. Implementation

The best "implementation" of a comparison chapter is producing the *same* business requirement on both brokers so the ergonomic difference is visible, plus a decision function that encodes the matrix. First, the Kafka side of "an order was placed, keyed for per-customer ordering, replayable":

```go
package broker

import (
	"context"
	"time"

	"github.com/segmentio/kafka-go"
)

// KafkaOrderPublisher writes order events to a partitioned, RETAINED log. The
// KEY (customer id) is what buys per-customer ordering: same key -> same
// partition -> total order within that partition. There is NO exchange, no
// routing rules — the broker is "dumb", the key is the only routing lever.
func KafkaOrderPublisher(brokers []string) *kafka.Writer {
	return &kafka.Writer{
		Addr:  kafka.TCP(brokers...),
		Topic: "orders",
		// Hash the key to a partition. This is the ENTIRE routing model:
		// pick a partition by key. Contrast RabbitMQ's exchange + bindings.
		Balancer: &kafka.Hash{},
		// acks=all: the leader confirms only after in-sync replicas have the
		// record. Paired with min.insync.replicas=2 this is the durability
		// standard (chapter on replication). Throughput is preserved by batching.
		RequiredAcks: kafka.RequireAll,
		BatchTimeout: 10 * time.Millisecond, // linger: trade a little latency for big batches
		Compression:  kafka.Lz4,             // sequential + compressed = the throughput story
	}
}

func kafkaPublishOrder(ctx context.Context, w *kafka.Writer, customerID string, body []byte) error {
	// The consumer will track its own OFFSET and can replay by seeking it
	// backwards — the broker keeps this record for the retention window
	// regardless of whether anyone reads it.
	return w.WriteMessages(ctx, kafka.Message{
		Key:   []byte(customerID), // routing = partition selection, nothing more
		Value: body,
	})
}
```

Now the *same* requirement on RabbitMQ. Notice what changes: you publish to an **exchange**, routing is expressed as a *binding*, and per-message control (persistence, priority) lives on the message — the broker is "smart":

```go
package broker

import (
	"context"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// rabbitPublishOrder publishes to an EXCHANGE with a routing key. The producer
// does NOT know which queues exist — the broker's bindings decide. This is the
// "smart broker": routing, per-message TTL/priority, and delivery are its job.
func rabbitPublishOrder(ctx context.Context, ch *amqp.Channel, customerRegion string, body []byte) error {
	// Declare a TOPIC exchange: routing keys like "order.eu.placed" can be
	// matched by bindings such as "order.eu.*" or "order.#". This attribute-
	// based routing is exactly what Kafka's dumb broker cannot do.
	if err := ch.ExchangeDeclare("orders", "topic", true, false, false, false, nil); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return ch.PublishWithContext(ctx,
		"orders",                       // exchange (never a queue directly)
		"order."+customerRegion+".placed", // routing key -> matched by bindings
		true,  // mandatory: return the message if it routes to NO queue
		false, // immediate (deprecated; leave false)
		amqp.Publishing{
			Body: body,
			// Per-message control the smart broker honours:
			DeliveryMode: amqp.Persistent, // delivery_mode=2: survive a broker restart (if queue is durable)
			Priority:     5,               // 0..9 priority — a per-message lever Kafka has no concept of
			Expiration:   "",              // could set per-message TTL in ms here
		},
	)
}

// A consumer acks INDIVIDUAL messages; on failure it can requeue just that one
// and keep the rest — finer-grained than Kafka's coarse offset commit.
func rabbitConsumeOrders(ch *amqp.Channel) error {
	// Declare and bind: the binding IS the routing rule. Only EU orders land here.
	if _, err := ch.QueueDeclare("eu-orders", true, false, false, false, nil); err != nil {
		return err
	}
	if err := ch.QueueBind("eu-orders", "order.eu.*", "orders", false, nil); err != nil {
		return err
	}
	_ = ch.Qos(20, 0, false) // prefetch: at most 20 unacked in flight = flow control
	msgs, err := ch.Consume("eu-orders", "", false /* manual ack */, false, false, false, nil)
	if err != nil {
		return err
	}
	go func() {
		for d := range msgs {
			if err := process(d.Body); err != nil {
				_ = d.Nack(false, true) // requeue THIS message only; keep going
				continue
			}
			_ = d.Ack(false) // ack THIS message -> broker DELETES it (no replay)
		}
	}()
	return nil
}

func process(b []byte) error { return nil }
```

And the decision function that encodes the matrix, so the choice is made on evidence:

```go
package broker

// Workload captures the properties that actually decide Kafka vs RabbitMQ.
type Workload struct {
	NeedReplay         bool // re-read history, reprocess after a bug, new readers of old data
	ManyIndependentReaders bool // several groups each needing the whole stream
	VeryHighThroughput bool // hundreds of thousands+ msgs/sec, or a system-of-record firehose
	ComplexRouting     bool // content/attribute-based routing to different consumers
	PerMessageControl  bool // priority, per-message TTL, selective requeue, RPC reply-to
	OrderedPerKey      bool // strict per-key ordering at scale
}

// Choose applies the chapter's rule: pick the SHAPE (log vs smart router) that
// fits; throughput is a tie-breaker inside the shape, not the thing that picks it.
func Choose(w Workload) (broker, reason string) {
	// Retention/replay is the strongest single signal for the log.
	if w.NeedReplay || w.ManyIndependentReaders {
		return "Kafka", "replay / many independent readers need a retained, replayable log; a delete-on-ack queue structurally cannot do this"
	}
	// Rich per-message routing/semantics is the strongest signal for the smart broker.
	if w.ComplexRouting || w.PerMessageControl {
		return "RabbitMQ", "content-based routing and per-message priority/TTL/RPC are what a smart broker exists for; the log's routing is deliberately dumb"
	}
	if w.VeryHighThroughput || w.OrderedPerKey {
		return "Kafka", "sequential-log throughput and per-partition ordering scale to a level RabbitMQ's per-message bookkeeping does not target"
	}
	// Modest volume, simple routing, no replay: RabbitMQ is usually the simpler default.
	return "RabbitMQ", "modest volume with simple routing and no replay need: a lean, smart broker is simpler than operating partitions, offsets and replicas"
}
```

The two publishers make the ergonomic difference tangible: Kafka's routing is a single `Key`; RabbitMQ's is an exchange, a routing key, and a binding you can make arbitrarily expressive. The consumer difference is just as sharp — Kafka advances one offset, RabbitMQ acks each message and can requeue exactly one.

## 6. Advantages, Disadvantages & Trade-offs

**Kafka advantages**
- Very high throughput via sequential disk writes, batching, compression and zero-copy reads.
- Retained, replayable log — a system of record and integration backbone; new consumers read all history.
- Cheap high fan-out: many independent consumer groups read one topic without extra broker bookkeeping.
- Strong per-partition ordering with a natural key-based partitioning model.
- Horizontal scale by partitioning; mature ecosystem (Connect, Streams, Schema Registry, Debezium for CDC).

**Kafka disadvantages**
- Dumb routing — a key picks a partition, and that is essentially all; no content-based routing.
- No per-message priority or straightforward per-message TTL; no built-in RPC pattern.
- Ordering is only per-partition, never global; partition count caps consumer parallelism and is painful to reduce.
- Heavier operationally — partitions, offsets, replicas, ISR, consumer-group rebalancing.

**RabbitMQ advantages**
- Rich routing — direct, topic, fanout, headers exchanges express content/attribute-based delivery naturally.
- Per-message semantics — priority, per-message and per-queue TTL, dead-letter routing, delayed messages.
- Fine-grained delivery — ack/nack/reject individual messages; requeue one and keep the rest.
- First-class request/reply (RPC) via reply-to and correlation-id; lower latency for small messages.
- Simpler mental model for task queues and routed workflows at modest volume.

**RabbitMQ disadvantages**
- No replay by default — an acked message is gone (Streams close this gap but are a separate structure).
- Lower peak throughput — per-message bookkeeping, routing and acks cost more than an append.
- The broker holds undelivered/unacked state, so a stuck consumer grows the queue *in the broker's memory*.
- Ordering is fragile — lost once you add competing consumers or requeue.

**Trade-offs**
- *Throughput vs routing flexibility:* Kafka trades routing richness for sequential-write throughput; RabbitMQ trades throughput for expressive routing and per-message control. You rarely get both in one system.
- *Replay vs leanness:* Kafka's retention makes it a replayable system of record but heavier; RabbitMQ's delete-on-ack makes it lean and ergonomic but not a record.
- *Coarse offset vs fine acks:* Kafka's offset is one number to advance (simple, but you cannot skip a single bad message without care); RabbitMQ's per-message ack is granular (skip/requeue one) but more per-message overhead.
- *Client complexity vs broker complexity:* Kafka pushes "where am I" to the smart consumer; RabbitMQ keeps it in the smart broker. You pay the complexity somewhere.

## 7. Common Mistakes & Best Practices

- **Choosing on a throughput benchmark.** Deciding by messages/sec ignores that the real difference is shape. RabbitMQ's throughput is ample for most systems; Kafka's routing is deliberately poor. Pick the shape, then let speed break ties.
- **Using Kafka as a task queue with per-message routing.** Fighting the log's dumb routing and coarse offsets to do content-based dispatch and selective requeue — exactly what RabbitMQ's exchanges and per-message acks do naturally.
- **Using RabbitMQ as an event-sourcing log.** Expecting replay from a delete-on-ack broker, then discovering acked messages are gone. If you need replay, use Kafka (or RabbitMQ Streams), not classic queues.
- **Assuming Kafka gives global ordering.** Ordering is per-partition only. Anyone relying on total order across a topic is relying on a guarantee that does not exist without a single partition (which destroys parallelism).
- **Forgetting RabbitMQ keeps unacked messages in the broker.** A consumer that stops acking grows the queue in the broker's memory until flow control triggers — unlike Kafka, where a stuck consumer just leaves the log on disk.
- **Treating "run both" as a failure.** Insisting on one broker for the whole company forces a bad fit on half the traffic. Many mature systems run Kafka for streaming and RabbitMQ for routed task work.
- **Best practice: pick per traffic shape, not per company.** Decide, per data flow, whether it needs a replayable ordered log or a smart per-message router. Standardising on the *right shape per flow* — including running both — beats a one-size-fits-all mandate.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The failure signatures differ. In Kafka, a stuck flow shows as *rising consumer lag* on a specific group — the offset stops advancing while the log-end offset climbs; the log itself is fine, the consumer is behind. In RabbitMQ, a stuck flow shows as a *growing queue* and rising unacked count *in the broker* — the broker is holding messages a consumer took but never acked. Kafka points you at the consumer; RabbitMQ shows you the backlog directly.
- **Monitoring.** Kafka's headline metric is **consumer lag** per group per partition, plus under-replicated partitions and ISR shrink. RabbitMQ's headline metrics are **queue depth**, **unacked message count**, **publish/deliver/ack rates**, and memory/disk alarms (which trigger flow control). Both share "how far behind are consumers" as the number-one signal; they just expose it differently (offset lag vs queue depth).
- **Security.** Both support TLS in transit and authentication (SASL for Kafka; PLAIN/AMQPLAIN, external, or plugins for RabbitMQ). Authorization differs in unit: Kafka ACLs govern read/write on *topics* and *groups*; RabbitMQ permissions govern configure/write/read on *exchanges and queues* within a *virtual host*. RabbitMQ's virtual hosts give tenant isolation out of the box; Kafka uses topic prefixes and ACLs.
- **Scaling.** Kafka scales by adding *partitions* (more consumer parallelism) and *brokers* (more storage/throughput), with the caveat that partition count caps per-group parallelism and is hard to reduce — a capacity decision to get right early. RabbitMQ scales consumers freely on a queue (competing consumers, no partition cap) but the *queue itself* is a scaling unit — a single very hot queue is a bottleneck, addressed with sharding, quorum queues for HA, or Streams for high-throughput replayable workloads. Kafka scales the *stream*; RabbitMQ scales *consumers on a queue*.

## 9. Interview Questions

**Q: State the fundamental difference between Kafka and RabbitMQ in one sentence.**
A: Kafka is a dumb broker with a smart consumer — a distributed, retained, replayable commit log where the consumer tracks its own offset and re-reads history; RabbitMQ is a smart broker with a dumb consumer — a message router that applies rich routing and per-message semantics, pushes to consumers, and deletes each message once it is acknowledged. Everything else — replay, ordering, routing flexibility, throughput profile — follows from that retain-versus-delete, smart-consumer-versus-smart-broker split.

**Q: Why is "which is faster?" the wrong question when choosing between them?**
A: Because the real difference is shape, not speed. Kafka is genuinely faster at raw throughput by design — sequential appends, batching and zero-copy reads — but RabbitMQ's throughput is more than enough for the vast majority of systems, and choosing Kafka for a workload that needs content-based routing, per-message priority or RPC means fighting the log's deliberate dumbness for the whole project. The question that actually picks correctly is "do I need a replayable ordered log, or a smart per-message router?" Throughput is a tie-breaker inside the right shape, not the thing that selects the shape.

**Q: Which system would you pick for event streaming and a CDC backbone, and why?**
A: Kafka. Change-data-capture and event streaming need a retained, replayable, ordered log that many independent consumers can read and re-read — analytics, search indexing, a data lake sink — each from its own offset, including reading history. That is exactly what the log provides and what a delete-on-ack broker cannot: RabbitMQ removes a message once acked, so there is nothing to replay and no way for a new consumer to read the past. Kafka Connect and Debezium make it the standard CDC backbone.

**Q: Which system for a task queue with per-message priority and complex routing, and why?**
A: RabbitMQ. Task queues with content-based dispatch and per-message priority are precisely what a smart broker exists for: publish to an exchange, let topic or headers bindings route each task to the right queue by attribute, set per-message priority so urgent work jumps the line, and dead-letter what fails. Kafka's routing is a key picking a partition and it has no per-message priority concept, so expressing this on Kafka means re-implementing the broker's smarts in the client. RabbitMQ does it natively.

**Q: How does ordering differ between the two?**
A: Kafka guarantees total order *within a partition* and nothing across partitions — so if you key by, say, customer id, all of one customer's events are ordered, but there is no global order across the topic without collapsing to a single partition, which kills parallelism. RabbitMQ preserves order *within a single queue read by a single consumer*, but that guarantee evaporates once you add competing consumers or requeue a message (a requeued message can jump behind newer ones). So Kafka's ordering is stronger and more explicit (per-key via partitioning), while RabbitMQ's is only reliable in the single-queue single-consumer case.

**Q: What does "smart broker, dumb consumer" versus "dumb broker, smart consumer" mean operationally?**
A: It decides where the "where am I" state lives and therefore where backlog pressure shows up. In RabbitMQ the broker holds undelivered and unacked messages, so a consumer that stops acking grows the queue *in the broker's memory* until flow control or a memory alarm triggers. In Kafka the consumer owns its offset and the broker just keeps the log on disk, so a stuck consumer shows up as rising *consumer lag* while the broker's storage is untroubled. Same symptom — consumers falling behind — but Kafka isolates it to the client and RabbitMQ surfaces it as broker backlog.

**Q: (Senior) A team defaults to Kafka for everything "to standardise". How do you evaluate that?**
A: I would push back on standardising by *system* rather than by *traffic shape*, because a single-broker mandate forces a poor fit on whatever traffic does not match. Kafka is superb for streaming, CDC, replay and high fan-out, and I would keep those there. But a routed task pipeline that needs content-based dispatch, per-message priority, per-message TTL, selective requeue, or RPC is fighting the log the entire time on Kafka — you end up re-implementing exchange routing and priority in application code and living with coarse offsets where you wanted per-message acks. For that traffic RabbitMQ is simpler and more correct. So I would frame the standard as "the right shape per flow": Kafka for the streaming and system-of-record flows, RabbitMQ for the routed/priority/RPC flows, and accept that running both is normal and common in mature systems. The operational cost of a second broker is real, but usually smaller than the accumulated cost of bending every routed workflow around a log. I would only collapse to one if the "wrong shape" traffic were negligible.

**Q: (Senior) Walk through how you would actually decide, for a concrete new pipeline.**
A: I work through a short set of gates on the pipeline's real needs, in priority order. First, retention: does anything need to replay history, reprocess after a bug, or does more than one independent consumer need the whole stream? If yes, that pulls hard toward Kafka's log, because a delete-on-ack broker structurally cannot replay. Second, routing and per-message control: does one message need to be routed to different consumers by content, or does it need priority, per-message TTL, selective requeue, or a request/reply pattern? If yes, that pulls toward RabbitMQ's smart broker, because the log's routing is deliberately dumb. Third, throughput and ordering: is this a very high-volume firehose or does it need strict per-key ordering at scale? That favours Kafka's sequential log. If none of the strong signals fire — modest volume, simple routing, no replay — I default to RabbitMQ as the simpler operational footprint. And critically, I evaluate this *per pipeline*, so the answer for the whole company is often "both", each carrying the traffic whose shape it fits. The output is a shape-first decision with throughput as a tie-breaker, not a benchmark-first one.

**Q: (Senior) When would you deliberately run both Kafka and RabbitMQ, and how do they compose?**
A: Whenever a system has genuinely two-shaped traffic, which is common. A canonical composition: Kafka is the event backbone — services emit domain events and CDC streams into Kafka topics, retained and replayable, feeding analytics, search, a data lake and multiple independent consumer groups, with per-key ordering. RabbitMQ handles the routed, transactional task work — a request comes in, gets published to an exchange, routed by attribute to the right worker queue with priority and per-message TTL, processed once, acked, and RPC replies flow back. They compose cleanly because they own different concerns: Kafka is the *retained record of what happened*, RabbitMQ is the *routing and dispatch of work to be done*. You can even bridge them — a consumer that reads a Kafka event and publishes a routed RabbitMQ task, or a RabbitMQ dead-letter analysis that emits to Kafka for long-term retention. The cost is two systems to operate and monitor, but each is used for what it is best at, and neither is bent out of shape. The failure mode to avoid is bridging them so tightly that ordering or delivery guarantees leak across the boundary; keep the seam explicit and idempotent.

**Q: Where does a backlog show up differently in each system, and why does that matter operationally?**
A: In Kafka a backlog shows up as rising *consumer lag* — the consumer's committed offset falls behind the log-end offset — while the broker's storage is untroubled, because the log sits on disk regardless of who has read it and the consumer owns its own position. In RabbitMQ a backlog shows up as a growing *queue depth* and rising *unacked count* inside the broker, because the broker holds undelivered and unacked messages in its own memory until a consumer acks them. This matters operationally because the pressure lands in different places: a stuck Kafka consumer is a client-side problem that does not threaten the broker, so you have time to fix the consumer while the retained log waits; a stuck RabbitMQ consumer grows the queue in the broker's RAM and can eventually trip a memory alarm that applies flow control and blocks *publishers*, turning a slow consumer into a producer-side outage. So on Kafka you watch lag as a consumer-health signal, whereas on RabbitMQ you watch queue depth and memory as a broker-health signal — same underlying cause, consumers falling behind, but a very different blast radius.

## 10. Quick Revision & Cheat Sheet

| Dimension | Kafka | RabbitMQ |
|---|---|---|
| Model | Dumb broker, smart consumer | Smart broker, dumb consumer |
| Core structure | Partitioned, retained **log** | Ephemeral **queues** fed via exchanges |
| Routing | Key → partition (dumb) | direct / topic / fanout / headers (rich) |
| Delivery unit | Offset (coarse, per-group) | Per-message ack / nack / reject (fine) |
| Retention / replay | Retained, **replayable** | Deleted on ack, **no replay** |
| Ordering | Total **per partition** (per-key) | Per single queue + single consumer |
| Throughput | Very high (sequential + zero-copy) | High, lower peak (per-msg bookkeeping) |
| Per-message priority/TTL | No priority; awkward TTL | Native priority, per-message TTL |
| RPC | Not native | Native (reply-to + correlation-id) |
| Consumer scaling | Add consumers up to partition count | Add competing consumers freely |
| Ops weight | Heavier (partitions, offsets, ISR) | Lighter for task/routing workloads |

| Pick Kafka when… | Pick RabbitMQ when… |
|---|---|
| You need replay / a system of record | You need content-based routing |
| Event streaming, CDC backbone | Task queues, RPC, workflows |
| High fan-out at high throughput | Per-message priority / TTL |
| Ordered-per-key at scale | Modest volume, rich semantics |

**Flash cards**
- **One-line difference?** → Kafka = dumb broker + smart replayable log; RabbitMQ = smart broker + dumb ephemeral queues.
- **Right question to choose?** → "Log or smart router?", not "which is faster?".
- **Kafka ordering scope?** → Per-partition only (per-key), never global.
- **Why can't RabbitMQ replay?** → It deletes on ack; the message is gone.
- **Where does backlog show up?** → Kafka: consumer lag (client behind). RabbitMQ: queue depth (broker holds it).
- **Run both?** → Yes, commonly — Kafka for streaming/record, RabbitMQ for routed task work.

## 11. Hands-On Exercises & Mini Project

- [ ] Publish the same "order placed" event to a Kafka topic (keyed) and a RabbitMQ topic exchange; compare how routing is expressed in each.
- [ ] On Kafka, run two consumer groups on one topic and replay one from offset 0; on RabbitMQ, ack a message then try to re-read it and confirm it is gone.
- [ ] On RabbitMQ, set up a topic exchange routing `order.eu.*` and `order.us.*` to different queues; show Kafka cannot do the equivalent without client-side logic.
- [ ] Set a per-message priority on RabbitMQ and watch high-priority messages jump the queue; note Kafka has no equivalent.
- [ ] Simulate a stuck consumer on both: observe Kafka's rising consumer lag vs RabbitMQ's growing queue and unacked count.
- [ ] Run each `Choose()` gate against three real pipelines you know and record the broker and the deciding reason.

### Mini Project — "Same Requirement, Two Brokers"

**Goal.** Implement one realistic requirement on both brokers to feel the shape difference, then write a decision memo — making the matrix concrete rather than abstract.

**Requirements.**
1. Requirement: "orders are placed; they must be (a) routed to region-specific fulfilment workers with priority for express orders, and (b) retained as an event stream feeding analytics that can be replayed."
2. Implement (a) on RabbitMQ: a topic exchange routing by region, a priority queue, competing fulfilment consumers with manual ack and selective requeue on failure.
3. Implement (b) on Kafka: an `orders` topic keyed by customer, two consumer groups (fulfilment-mirror and analytics), and a replay of analytics from offset 0.
4. Instrument both: Kafka consumer lag per group, RabbitMQ queue depth and unacked count; induce a stuck consumer on each and compare the signal.
5. Write a one-page memo assigning each half of the requirement to the broker whose shape fits, with the deciding reasons from the decision procedure.

**Extensions.**
- Bridge them: a consumer that reads a Kafka order event and publishes a routed RabbitMQ fulfilment task; keep the seam idempotent and document the delivery guarantee across it.
- Benchmark both at your realistic volume and show that throughput is a tie-breaker, not the decider — the shape was already fixed by the routing and replay needs.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Messaging Models: Queues vs Pub/Sub vs the Log* (the primitives this decision sits on), *Delivery Guarantees* (the at-least-once default both share), *RabbitMQ Architecture: Broker, Connections & Channels* (the smart broker in depth), *The Log: Offsets, Segments & Retention* (Kafka's retained log in depth), *RabbitMQ Exchanges, Bindings & Routing* (the rich routing that defines the smart broker).

- **Apache Kafka — Documentation: Design** — Apache · *Intermediate* · the log, partitions, replication and the throughput mechanisms from the source; grounds the Kafka half of the comparison. <https://kafka.apache.org/documentation/#design>
- **RabbitMQ — AMQP 0-9-1 Model Explained** — RabbitMQ · *Beginner* · exchanges, bindings, queues and routing — the smart-broker model that Kafka deliberately lacks. <https://www.rabbitmq.com/tutorials/amqp-concepts>
- **The Log: What every software engineer should know** — Jay Kreps · *Advanced* · why the retained log is a distinct and powerful abstraction; the intellectual case for the Kafka side. <https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · the definitive comparison of message brokers versus log-based messaging and their trade-offs. <https://dataintensive.net/>
- **Kafka vs RabbitMQ — Confluent** — Confluent · *Intermediate* · a vendor-but-fair walkthrough of when the log fits and when a traditional broker does. <https://www.confluent.io/blog/>
- **RabbitMQ vs Kafka — a practical comparison** — Pivotal/VMware · *Intermediate* · a balanced engineering view emphasising routing versus streaming, useful as a cross-check. <https://www.rabbitmq.com/blog/>
- **Enterprise Integration Patterns** — Hohpe & Woolf · *Intermediate* · the routing and channel patterns RabbitMQ implements directly; context for the smart-broker capabilities. <https://www.enterpriseintegrationpatterns.com/>
- **Kafka: The Definitive Guide (free ebook)** — Narkhede, Shapira & Palino (Confluent) · *Intermediate* · the canonical Kafka reference; deepens the log, partitions and consumer-group half of the decision. <https://www.confluent.io/resources/kafka-the-definitive-guide/>

---

*Kafka & RabbitMQ Handbook — chapter 03.*
