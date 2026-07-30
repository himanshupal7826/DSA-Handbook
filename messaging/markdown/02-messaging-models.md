# 02 · Messaging Models: Queues vs Pub/Sub vs the Log

> **In one line:** There are three fundamental shapes for moving messages — the *queue* where each message goes to exactly one of many competing workers, *pub/sub* where each message is broadcast to every interested subscriber, and the *log* where messages are retained and any consumer can read or re-read at its own position — and almost every messaging design is a combination of these three.

---

## 1. Overview

Beneath the marketing of every message broker are three primitives. Getting them straight is the single most clarifying thing you can do before choosing between Kafka and RabbitMQ, because the two systems are, at their core, different default combinations of these primitives — RabbitMQ leads with queues and pub/sub, Kafka leads with the log — and most confusion between them comes from not seeing the primitives underneath.

The **queue** (competing-consumer) model is the oldest: messages line up, and a pool of workers each pull the next available message. Every message is processed by *exactly one* worker; adding workers spreads the load. This is how you parallelise a stream of tasks — image resizing, email sending, order fulfilment — and it is the natural home of *commands*.

The **publish/subscribe** model broadcasts: a message published to a topic is delivered to *every* subscriber, each of which processes its own independent copy. Adding a subscriber adds a reaction, not more throughput. This is how you let many parts of a system react to the same fact — an order being placed triggers search indexing, email, analytics, and fraud checks, independently — and it is the natural home of *events*.

The **log** model is the newest and the one Kafka popularised: messages are appended to an ordered, retained sequence, and consumers read it by tracking their *position* (offset) rather than by having messages handed out and removed. Because the log is retained, a consumer can read history, replay from the beginning, or have several independent consumers each reading the whole log at their own pace. The log turns out to *subsume* the other two — it can behave as a queue (partition the log, one consumer per partition) or as pub/sub (many consumer groups each reading the whole log) — which is why Kafka can do both, and why the log is often described as the more fundamental abstraction.

This chapter defines the three, shows how they compose, and — crucially — shows how the log generalises the queue and pub/sub, which is the key insight for understanding why Kafka and RabbitMQ feel so different despite solving overlapping problems.

## 2. Core Concepts

- **Queue (point-to-point / competing consumers)** — messages buffered in order; each message delivered to exactly one consumer from a pool. Adding consumers increases throughput.
- **Competing consumers** — multiple workers reading from one queue, sharing the load; the pattern that parallelises task processing.
- **Publish/subscribe (pub/sub)** — a message published to a topic is delivered to every subscriber; each subscriber gets its own copy. Adding subscribers adds reactions, not throughput.
- **Topic** — a named channel subscribers register interest in. In pub/sub, a fan-out point; in Kafka, a named log split into partitions.
- **Log (commit log / event log)** — an append-only, ordered, retained sequence of messages that consumers read by position.
- **Offset** — a consumer's position in the log: the index of the next message to read. The consumer, not the broker, tracks it (in Kafka).
- **Retention** — how long messages are kept. Queues and classic pub/sub delete on delivery/ack; the log keeps messages for a time/size window regardless.
- **Replay** — re-reading messages already consumed, possible only when messages are retained (the log), not when deleted on ack (queue/pub/sub).
- **Consumer group** — Kafka's mechanism: a named set of consumers that together read a topic once (queue-like within the group), while different groups each read the whole topic (pub/sub-like across groups).
- **Fan-out** — one message reaching many consumers (pub/sub); contrast with fan-in (many producers to one queue).

## 3. Theory & Principles

### The three primitives, precisely

The models differ on one axis above all: **how many consumers process each message, and whether the message survives being consumed.**

- **Queue:** each message → *exactly one* consumer, then *deleted*. Consumers compete; the broker load-balances. Throughput scales with consumers. No replay. Order is preserved within the queue but interleaves once several consumers pull concurrently.
- **Pub/sub:** each message → *every* subscriber, each getting an independent copy, then (classically) *deleted* once all have received it. Subscribers do not compete; each is autonomous. Adding a subscriber adds a reaction. No replay of past messages for a subscriber that joins later.
- **Log:** each message → *appended and retained*; any number of consumers read it at their own offset, and the message is *not deleted on read*. A consumer can replay, a new consumer can read all of history, and reads are non-destructive. Order is preserved within a partition.

The consequences cascade from that one axis. Because a queue deletes on ack, it cannot replay, so a bug in a consumer that corrupts processing loses the data — you cannot re-run history. Because the log retains, you *can* re-run: fix the consumer, reset the offset, reprocess. Because pub/sub delivers to all current subscribers, a subscriber that was down misses messages (unless the broker holds a durable subscription); because the log retains, a consumer that was down simply resumes from its last offset and catches up. These are not incidental features — they follow directly from "delete on consume" versus "retain and track position".

### The log subsumes the queue and pub/sub

The deepest idea in modern messaging is that the log is not a *third* model alongside the other two — it is a *more general* model that can express both. Kafka's consumer-group mechanism is exactly this generalisation:

- **Queue behaviour** comes from *partitions within one group*: a topic is split into partitions, and within a consumer group each partition is read by exactly one consumer. So the members of a group *compete* for the topic's partitions — that is the competing-consumer queue, with parallelism equal to the partition count.
- **Pub/sub behaviour** comes from *multiple groups*: each consumer group independently reads the *whole* topic, tracking its own offsets. So group A (search) and group B (email) each get every message — that is publish/subscribe, with each group a subscriber.

One mechanism — the retained log plus per-group offsets — gives you both the queue and pub/sub, *plus* replay, which neither of the others can offer. This is why Kafka is often described as the more fundamental abstraction, and why a single Kafka topic can simultaneously feed a competing-consumer worker pool and a fan-out of independent reactors. RabbitMQ, by contrast, gives you queues and pub/sub as *first-class, separate* objects (via exchanges and queues) with rich routing between them, but without retention/replay by default — a different, and often more ergonomic, way to compose the same two primitives when replay is not needed.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="m1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="m2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="m3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Three primitives, on one axis: how many consumers, and does the message survive?</text>

  <rect x="24" y="42" width="272" height="180" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="160" y="64" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">QUEUE (competing)</text>
  <rect x="40" y="80" width="120" height="24" rx="4" fill="#fff" stroke="#60a5fa"/><text x="100" y="97" text-anchor="middle" fill="#1e40af" font-size="9">m3 m2 m1 &#8594;</text>
  <rect x="200" y="76" width="76" height="24" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="238" y="93" text-anchor="middle" fill="#1e40af" font-size="9">worker 1</text>
  <rect x="200" y="106" width="76" height="24" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="238" y="123" text-anchor="middle" fill="#1e40af" font-size="9">worker 2</text>
  <path d="M162,90 L196,88" stroke="#2563eb" stroke-width="1.5" marker-end="url(#m1)"/>
  <path d="M162,94 L196,116" stroke="#2563eb" stroke-width="1.5" marker-end="url(#m1)"/>
  <text x="40" y="152" fill="#1d4ed8" font-size="9" font-weight="bold">each msg &#8594; EXACTLY ONE worker</text>
  <text x="40" y="168" fill="#1d4ed8" font-size="9">deleted on ack &#183; no replay</text>
  <text x="40" y="184" fill="#1d4ed8" font-size="9">add workers &#8594; more THROUGHPUT</text>
  <text x="40" y="204" fill="#1e40af" font-size="9" font-weight="bold">for: commands / tasks</text>

  <rect x="304" y="42" width="272" height="180" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">PUB/SUB (broadcast)</text>
  <rect x="320" y="86" width="70" height="24" rx="4" fill="#fff" stroke="#86efac"/><text x="355" y="103" text-anchor="middle" fill="#15803d" font-size="9">topic</text>
  <rect x="470" y="72" width="90" height="20" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="515" y="87" text-anchor="middle" fill="#15803d" font-size="9">search</text>
  <rect x="470" y="96" width="90" height="20" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="515" y="111" text-anchor="middle" fill="#15803d" font-size="9">email</text>
  <rect x="470" y="120" width="90" height="20" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="515" y="135" text-anchor="middle" fill="#15803d" font-size="9">analytics</text>
  <path d="M392,94 L466,82" stroke="#16a34a" stroke-width="1.5" marker-end="url(#m2)"/>
  <path d="M392,98 L466,106" stroke="#16a34a" stroke-width="1.5" marker-end="url(#m2)"/>
  <path d="M392,102 L466,130" stroke="#16a34a" stroke-width="1.5" marker-end="url(#m2)"/>
  <text x="320" y="164" fill="#166534" font-size="9" font-weight="bold">each msg &#8594; EVERY subscriber (own copy)</text>
  <text x="320" y="180" fill="#166534" font-size="9">subscribers don't compete</text>
  <text x="320" y="196" fill="#166534" font-size="9">add subscriber &#8594; more REACTIONS</text>
  <text x="320" y="212" fill="#15803d" font-size="9" font-weight="bold">for: events</text>

  <rect x="584" y="42" width="272" height="180" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="720" y="64" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">LOG (retained)</text>
  <g font-size="8">
    <rect x="600" y="80" width="22" height="20" fill="#ede9fe" stroke="#7c3aed"/><text x="611" y="94" text-anchor="middle" fill="#5b21b6">0</text>
    <rect x="622" y="80" width="22" height="20" fill="#ede9fe" stroke="#7c3aed"/><text x="633" y="94" text-anchor="middle" fill="#5b21b6">1</text>
    <rect x="644" y="80" width="22" height="20" fill="#ede9fe" stroke="#7c3aed"/><text x="655" y="94" text-anchor="middle" fill="#5b21b6">2</text>
    <rect x="666" y="80" width="22" height="20" fill="#ede9fe" stroke="#7c3aed"/><text x="677" y="94" text-anchor="middle" fill="#5b21b6">3</text>
    <rect x="688" y="80" width="22" height="20" fill="#ede9fe" stroke="#7c3aed"/><text x="699" y="94" text-anchor="middle" fill="#5b21b6">4</text>
    <rect x="710" y="80" width="60" height="20" fill="#f5f3ff" stroke="#c4b5fd" stroke-dasharray="3 2"/><text x="740" y="94" text-anchor="middle" fill="#7c3aed">append &#8594;</text>
  </g>
  <text x="600" y="120" fill="#6d28d9" font-size="9">consumer A offset=2 &#8593;</text>
  <text x="600" y="134" fill="#6d28d9" font-size="9">consumer B offset=4 &#8593; (own position)</text>
  <text x="600" y="158" fill="#6d28d9" font-size="9" font-weight="bold">appended &amp; RETAINED &#183; read by position</text>
  <text x="600" y="174" fill="#6d28d9" font-size="9">NOT deleted on read &#8594; REPLAY</text>
  <text x="600" y="190" fill="#6d28d9" font-size="9">down consumer resumes from its offset</text>
  <text x="600" y="212" fill="#5b21b6" font-size="9" font-weight="bold">for: events + replay + both above</text>

  <rect x="24" y="238" width="832" height="248" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="260" text-anchor="middle" fill="#334155" font-size="13" font-weight="bold">The key insight: the LOG subsumes the queue AND pub/sub</text>

  <rect x="48" y="278" width="380" height="190" rx="8" fill="#fff" stroke="#7c3aed" stroke-width="2"/>
  <text x="238" y="300" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">Queue behaviour = partitions in ONE group</text>
  <g font-size="8">
    <rect x="70" y="312" width="150" height="18" fill="#ede9fe" stroke="#7c3aed"/><text x="145" y="325" text-anchor="middle" fill="#5b21b6">partition 0</text>
    <rect x="70" y="334" width="150" height="18" fill="#ede9fe" stroke="#7c3aed"/><text x="145" y="347" text-anchor="middle" fill="#5b21b6">partition 1</text>
  </g>
  <rect x="248" y="312" width="160" height="18" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="328" y="325" text-anchor="middle" fill="#5b21b6" font-size="8">group G: consumer 1 &#8592; p0</text>
  <rect x="248" y="334" width="160" height="18" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="328" y="347" text-anchor="middle" fill="#5b21b6" font-size="8">group G: consumer 2 &#8592; p1</text>
  <path d="M222,321 L246,321" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#m3)"/>
  <path d="M222,343 L246,343" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#m3)"/>
  <text x="70" y="378" fill="#6d28d9" font-size="9">within a group, each partition &#8594; ONE consumer</text>
  <text x="70" y="394" fill="#6d28d9" font-size="9">&#8594; members COMPETE &#8594; that is the QUEUE</text>
  <text x="70" y="414" fill="#6d28d9" font-size="9" font-weight="bold">parallelism = partition count</text>
  <text x="70" y="440" fill="#6d28d9" font-size="9">&#8230; plus replay, which a real queue cannot do</text>

  <rect x="452" y="278" width="380" height="190" rx="8" fill="#fff" stroke="#7c3aed" stroke-width="2"/>
  <text x="642" y="300" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">Pub/sub behaviour = MULTIPLE groups</text>
  <rect x="474" y="316" width="150" height="18" fill="#ede9fe" stroke="#7c3aed"/><text x="549" y="329" text-anchor="middle" fill="#5b21b6" font-size="8">the whole topic</text>
  <rect x="650" y="308" width="160" height="18" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="730" y="321" text-anchor="middle" fill="#5b21b6" font-size="8">group SEARCH (own offsets)</text>
  <rect x="650" y="330" width="160" height="18" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="730" y="343" text-anchor="middle" fill="#5b21b6" font-size="8">group EMAIL (own offsets)</text>
  <path d="M626,320 L648,317" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#m3)"/>
  <path d="M626,326 L648,339" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#m3)"/>
  <text x="474" y="374" fill="#6d28d9" font-size="9">each group independently reads the WHOLE topic</text>
  <text x="474" y="390" fill="#6d28d9" font-size="9">&#8594; every group gets every message &#8594; that is PUB/SUB</text>
  <text x="474" y="414" fill="#6d28d9" font-size="9" font-weight="bold">one mechanism (log + per-group offsets)</text>
  <text x="474" y="440" fill="#6d28d9" font-size="9">gives queue + pub/sub + replay together</text>
</svg>
```

### Retention is the dividing line

If you internalise one distinction from this chapter, make it retention. The queue and classic pub/sub **delete on consume**; the log **retains**. Everything else — replay, catch-up after downtime, multiple independent readers, reprocessing after a bug — flows from that. A message deleted on ack is gone: the only copy was the one the consumer processed, so a processing bug is unrecoverable and a consumer that was down missed the message. A message retained in a log persists independently of any consumer: it can be re-read, so a bug is recoverable (reset and reprocess), a down consumer catches up, and new consumers read history.

This is *the* reason Kafka and RabbitMQ feel different in practice even though both move messages. RabbitMQ's queues are lean and ephemeral — a message occupies memory until acked, then vanishes — which makes them ergonomic for task distribution and rich routing but means the broker is not a system of record. Kafka's log is durable and replayable — messages sit on disk for days regardless of consumption — which makes it a system of record and an integration backbone, at the cost of being heavier and less flexible about per-message routing. Neither is "better"; they optimise for different points on the retain-vs-delete axis (chapter 3 turns this into a decision).

## 4. Architecture & Workflow

How each model maps onto the two brokers, which is what makes the abstract concrete:

1. **Queue on RabbitMQ.** Declare a queue; producers publish (via an exchange) to it; multiple consumers `basic.consume` from it and compete. The broker load-balances round-robin (moderated by prefetch). Acked messages are deleted. This is the canonical work-queue.
2. **Queue on Kafka.** Create a topic with N partitions; one consumer group with up to N consumers, each owning some partitions. The group members compete for partitions. Parallelism is capped at the partition count. Messages are retained, so it is a *replayable* queue.
3. **Pub/sub on RabbitMQ.** Use a fanout (or topic) exchange bound to several queues, one per subscriber; each subscriber consumes its own queue. The exchange copies each message to every bound queue. Adding a subscriber means binding a new queue.
4. **Pub/sub on Kafka.** Several consumer *groups* subscribe to one topic; each group reads the whole topic independently. Adding a subscriber means adding a group. Because the log is retained, a new group can start from the beginning and read all history.
5. **Log on Kafka.** The native model: a topic is the log, offsets are positions, retention is time/size-bounded, and log compaction can keep the latest value per key. Replay, reprocessing and multiple readers are first-class.
6. **Log on RabbitMQ.** Since RabbitMQ 3.9, **Streams** provide a log-like, replayable, retained structure alongside classic queues — RabbitMQ's answer to workloads that need the log's replay and high throughput (chapter 12).

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The three models mapped onto the two brokers</text>

  <rect x="24" y="42" width="200" height="30" rx="6" fill="#f1f5f9" stroke="#64748b"/>
  <text x="124" y="62" text-anchor="middle" fill="#334155" font-size="11" font-weight="bold">Model</text>
  <rect x="234" y="42" width="300" height="30" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="384" y="62" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">RabbitMQ (first-class objects)</text>
  <rect x="544" y="42" width="312" height="30" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="700" y="62" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">Kafka (one retained log)</text>

  <rect x="24" y="80" width="200" height="70" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="124" y="106" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">QUEUE</text>
  <text x="124" y="124" text-anchor="middle" fill="#1d4ed8" font-size="9">one worker each</text>
  <text x="124" y="138" text-anchor="middle" fill="#1d4ed8" font-size="9">(competing consumers)</text>
  <rect x="234" y="80" width="300" height="70" rx="6" fill="#fff" stroke="#fbbf24"/>
  <text x="384" y="104" text-anchor="middle" fill="#92400e" font-size="10">a queue + many consumers</text>
  <text x="384" y="122" text-anchor="middle" fill="#b45309" font-size="9">broker round-robins; prefetch for fair dispatch</text>
  <text x="384" y="138" text-anchor="middle" fill="#b45309" font-size="9">acked &#8594; deleted &#183; no replay</text>
  <rect x="544" y="80" width="312" height="70" rx="6" fill="#fff" stroke="#c4b5fd"/>
  <text x="700" y="104" text-anchor="middle" fill="#5b21b6" font-size="10">ONE consumer group, N partitions</text>
  <text x="700" y="122" text-anchor="middle" fill="#6d28d9" font-size="9">members compete for partitions</text>
  <text x="700" y="138" text-anchor="middle" fill="#6d28d9" font-size="9">retained &#8594; a REPLAYABLE queue &#183; parallelism = partitions</text>

  <rect x="24" y="158" width="200" height="70" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="124" y="184" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">PUB/SUB</text>
  <text x="124" y="202" text-anchor="middle" fill="#166534" font-size="9">every subscriber</text>
  <text x="124" y="216" text-anchor="middle" fill="#166534" font-size="9">(broadcast)</text>
  <rect x="234" y="158" width="300" height="70" rx="6" fill="#fff" stroke="#fbbf24"/>
  <text x="384" y="182" text-anchor="middle" fill="#92400e" font-size="10">fanout/topic exchange &#8594; per-subscriber queues</text>
  <text x="384" y="200" text-anchor="middle" fill="#b45309" font-size="9">exchange copies each message to every bound queue</text>
  <text x="384" y="216" text-anchor="middle" fill="#b45309" font-size="9">add subscriber = bind a new queue</text>
  <rect x="544" y="158" width="312" height="70" rx="6" fill="#fff" stroke="#c4b5fd"/>
  <text x="700" y="182" text-anchor="middle" fill="#5b21b6" font-size="10">MULTIPLE consumer groups</text>
  <text x="700" y="200" text-anchor="middle" fill="#6d28d9" font-size="9">each group reads the whole topic independently</text>
  <text x="700" y="216" text-anchor="middle" fill="#6d28d9" font-size="9">add subscriber = add a group (can start from offset 0)</text>

  <rect x="24" y="236" width="200" height="70" rx="6" fill="#cffafe" stroke="#0891b2"/>
  <text x="124" y="262" text-anchor="middle" fill="#155e75" font-size="11" font-weight="bold">LOG</text>
  <text x="124" y="280" text-anchor="middle" fill="#0e7490" font-size="9">retained, read by offset</text>
  <text x="124" y="294" text-anchor="middle" fill="#0e7490" font-size="9">(replay)</text>
  <rect x="234" y="236" width="300" height="70" rx="6" fill="#fff" stroke="#fbbf24"/>
  <text x="384" y="262" text-anchor="middle" fill="#92400e" font-size="10">Streams (RabbitMQ 3.9+)</text>
  <text x="384" y="280" text-anchor="middle" fill="#b45309" font-size="9">a replicated append-only log alongside queues</text>
  <text x="384" y="296" text-anchor="middle" fill="#b45309" font-size="9">the retention/replay answer, bolted on</text>
  <rect x="544" y="236" width="312" height="70" rx="6" fill="#f0fdfa" stroke="#0891b2" stroke-width="2"/>
  <text x="700" y="262" text-anchor="middle" fill="#155e75" font-size="10" font-weight="bold">NATIVE &#8212; the topic IS the log</text>
  <text x="700" y="280" text-anchor="middle" fill="#0e7490" font-size="9">offsets, retention, compaction, replay are first-class</text>
  <text x="700" y="296" text-anchor="middle" fill="#0e7490" font-size="9">the model the other two are built out of</text>

  <rect x="24" y="318" width="832" height="66" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="340" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The lesson: you rarely use one model in isolation</text>
  <text x="40" y="362" fill="#475569" font-size="10">A real system composes all three &#8212; one Kafka topic can feed a competing-consumer group (queue) AND several reactor groups</text>
  <text x="40" y="378" fill="#475569" font-size="10">(pub/sub) AND a stream processor replaying history (log). Naming the model on each edge is what makes the topology legible.</text>
</svg>
```

The workflow lesson is that **you rarely use one model in isolation**. A real system is a composition: a Kafka topic feeding a competing-consumer group (queue) *and* several other groups (pub/sub) *and* a stream processor replaying history (log); or a RabbitMQ topology with a topic exchange fanning out to work queues, each with competing consumers, and a dead-letter exchange behind them. Recognising which primitive each edge of the design is expressing is what makes the design legible.

## 5. Implementation

Because the models are broker-agnostic, the clearest implementation is a small abstraction that names each model explicitly, so a design's *intent* — competing, broadcast, or replayable — is visible in the code rather than buried in broker configuration.

```go
package messagingmodels

import "context"

// Message is a broker-agnostic record. In RabbitMQ it maps to a basic.publish
// body + routing key; in Kafka to a record with a key that picks a partition.
type Message struct {
	ID      string // stable id, for idempotent consumers (chapter 21)
	Key     string // ordering/partition key (chapter 22)
	Payload []byte
}

// Queue is the competing-consumer model: each message goes to EXACTLY ONE of
// the workers reading it. Adding workers increases throughput. Order holds
// within the queue but interleaves once workers pull concurrently.
type Queue interface {
	// Publish enqueues a message for one-of-N delivery.
	Publish(ctx context.Context, m Message) error
	// Consume registers a competing worker. The broker load-balances across
	// all workers that call this on the same queue.
	Consume(ctx context.Context, handle func(Message) error) error
}

// Topic is the pub/sub model: each message goes to EVERY subscriber, each
// getting its own copy. Adding a subscriber adds a reaction, not throughput.
type Topic interface {
	Publish(ctx context.Context, m Message) error
	// Subscribe registers an INDEPENDENT subscriber. Every subscriber receives
	// every message; they do not compete.
	Subscribe(ctx context.Context, name string, handle func(Message) error) error
}

// Log is the retained model: messages are appended and kept, and a consumer
// reads by POSITION. Unlike Queue/Topic, a consumer can REPLAY — seek to an
// earlier offset and re-read. This is the capability delete-on-consume models
// structurally cannot provide.
type Log interface {
	Append(ctx context.Context, m Message) (offset int64, err error)
	// ReadFrom reads sequentially from `offset`. Passing 0 replays from the
	// start; passing the last committed offset resumes; the broker does NOT
	// delete on read.
	ReadFrom(ctx context.Context, group string, offset int64, handle func(offset int64, m Message) error) error
	// CommitOffset records how far `group` has processed, so a restart resumes
	// from here rather than replaying everything. The consumer owns its
	// position — this is what lets many groups read the same log independently.
	CommitOffset(ctx context.Context, group string, offset int64) error
}

// KafkaLog demonstrates that ONE log implementation yields both the queue and
// pub/sub, which is the chapter's key insight expressed as code.
type KafkaLog struct{ /* wraps a Kafka topic with N partitions */ }

// AsQueue: many consumers in ONE group compete for the topic's partitions.
// Within the group, each partition is read by exactly one consumer, so the
// members share the load — that is the competing-consumer queue.
func (k *KafkaLog) AsQueue(ctx context.Context, group string, workers int, handle func(Message) error) error {
	// Each of `workers` consumers joins the SAME group; Kafka assigns
	// partitions across them. Parallelism is capped at the partition count.
	// ... start `workers` consumers with groupID = group ...
	return nil
}

// AsPubSub: give each subscriber its OWN group. Each group reads the WHOLE
// topic independently and tracks its own offsets, so every group receives
// every message — that is publish/subscribe, from the same log.
func (k *KafkaLog) AsPubSub(ctx context.Context, subscribers []string, handle func(sub string, m Message) error) error {
	// Each subscriber name becomes a distinct groupID; distinct groups do NOT
	// compete — each gets a full copy of the stream.
	// ... start one consumer per subscriber, each with a UNIQUE groupID ...
	return nil
}

// ReplayFrom: only the log can do this. Seek a group's offset back to `from`
// and reprocess — the recovery move that delete-on-consume queues lack.
func (k *KafkaLog) ReplayFrom(ctx context.Context, group string, from int64, handle func(Message) error) error {
	// Reset the committed offset for `group` to `from`, then read forward.
	// Because the messages were RETAINED (not deleted on the first read), they
	// are still there to reprocess — e.g. after fixing a consumer bug.
	return nil
}
```

Naming the model in the interface — `Queue`, `Topic`, `Log` — makes each design decision explicit: a competing worker pool is a `Queue`, a fan-out of reactors is a `Topic`, and anything that needs replay or multiple independent readers is a `Log`. The `KafkaLog` methods make the subsumption concrete: the same log yields a queue (one group, competing) and pub/sub (many groups, independent), plus a replay no delete-on-consume model can offer.

## 6. Advantages, Disadvantages & Trade-offs

**Queue (competing consumers)**
- *Advantages:* trivially parallelises task processing; the broker load-balances; lean memory (deleted on ack); the natural model for commands.
- *Disadvantages:* no replay (a processing bug loses data); order interleaves across concurrent workers; a slow message can block a worker.

**Pub/sub (broadcast)**
- *Advantages:* clean fan-out; subscribers are independent and added without touching producers; the natural model for events.
- *Disadvantages:* a subscriber that was down misses messages unless the broker keeps a durable subscription; adding a subscriber adds load on the broker (a copy per subscriber), not throughput.

**Log (retained)**
- *Advantages:* replay and reprocessing; multiple independent readers; catch-up after downtime; subsumes queue and pub/sub; a system of record.
- *Disadvantages:* heavier (durable storage, more operational surface); less flexible per-message routing; ordering only within a partition; consumers must manage offsets.

**Trade-offs**
- *Delete-on-consume vs retain:* queues and classic pub/sub are lean and ergonomic but cannot replay; the log retains and can replay but is heavier and a system of record. This is the single axis that most distinguishes RabbitMQ from Kafka.
- *Throughput scaling vs reaction scaling:* a queue scales throughput by adding competing consumers; pub/sub scales reactions by adding subscribers. Confusing the two — adding subscribers to go faster — is a classic error.
- *One model vs composition:* real systems compose all three. Trying to force a design into a single model (all queue, or all log) is usually why it feels awkward.

## 7. Common Mistakes & Best Practices

- **Adding subscribers to increase throughput.** Pub/sub subscribers each get a full copy; adding them adds reactions and broker load, not speed. To go faster you add *competing consumers* to a queue (or partitions + consumers to a group).
- **Expecting replay from a queue.** A queue deletes on ack, so a consumer bug that mis-processes messages loses them irrecoverably. If you need to reprocess after a bug, you need a log.
- **Using the log where a lean queue would do.** Reaching for Kafka's durable log for a simple in-process task queue imports retention, partitions and offset management you do not need; a RabbitMQ queue is simpler.
- **Assuming pub/sub is durable by default.** A subscriber that is down when a message is published misses it unless you configured a durable subscription. The log makes catch-up automatic; classic pub/sub does not.
- **Forgetting order interleaves across competing consumers.** A queue preserves order in the queue, but once several workers pull concurrently, the order of *effects* interleaves. Per-key order needs partitioning (chapter 22).
- **Not recognising which primitive an edge expresses.** A design becomes legible when you can point at each edge and say "this is a queue / this is pub/sub / this is a log". Muddling them is why topologies become inscrutable.
- **Best practice: name the model, then pick the broker.** Decide, per data flow, whether you need competing consumers, broadcast, or replay — then choose the broker and configuration that expresses it most naturally.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The model determines what "stuck" means. In a queue, stuck = a growing queue depth (consumers not keeping up) or a message being redelivered forever (poison). In pub/sub, a *single* subscriber falling behind while others keep up points at that subscriber. In the log, a single consumer group's lag rising while others are flat isolates the problem to that group — the per-group offset is a precise diagnostic the other models lack.
- **Monitoring.** Each model has a characteristic health metric: queue depth for queues, per-subscriber delivery rate for pub/sub, and per-group consumer lag for the log. The log's per-group lag is the richest because it tells you exactly which reader is behind and by how much (chapter 27).
- **Security.** The models differ in blast radius. In pub/sub and the log, a message reaches many consumers, so authorization is about *who may subscribe to / read* a topic — a mis-set ACL leaks a stream to an unauthorised reader. In a queue, the concern is *who may consume*, since a rogue consumer steals messages from the pool (chapter 29).
- **Scaling.** Queue: add competing consumers, capped by nothing in RabbitMQ (one queue, many consumers) but by partition count in Kafka. Pub/sub: scaling is the broker's fan-out cost, since each subscriber is a copy. Log: scale by adding partitions (more parallelism) and readers, with the caveat that partition count is hard to reduce and sets the maximum consumer parallelism per group — a capacity decision to get right early (chapter 22).

## 9. Interview Questions

**Q: What are the three fundamental messaging models?**
A: The queue, or competing-consumer model, where each message is delivered to exactly one of a pool of workers and deleted on acknowledgement, so adding workers increases throughput — the home of commands and task distribution. Publish/subscribe, where each message is broadcast to every subscriber, each getting an independent copy, so adding a subscriber adds a reaction rather than throughput — the home of events. And the log, where messages are appended to a retained, ordered sequence and consumers read by position without the message being deleted on read, which uniquely allows replay, catch-up after downtime, and multiple independent readers. Most real designs compose all three.

**Q: How does the log subsume the queue and pub/sub?**
A: Through Kafka's consumer-group mechanism plus retention. Queue behaviour comes from partitions within one group: a topic is split into partitions, and within a group each partition is read by exactly one consumer, so the group's members compete for the partitions — that is the competing-consumer queue, with parallelism equal to the partition count. Pub/sub behaviour comes from multiple groups: each consumer group independently reads the whole topic and tracks its own offsets, so every group receives every message — that is publish/subscribe, one group per subscriber. One mechanism, the retained log plus per-group offsets, gives both, plus replay, which neither delete-on-consume model can offer. That is why the log is often called the more fundamental abstraction.

**Q: What is the single most important difference between a queue and a log?**
A: Retention. A queue deletes a message once it is acknowledged; the log retains messages for a time or size window regardless of consumption. Everything else follows from that one difference. Because a queue deletes on ack, it cannot replay — a consumer bug that mis-processes messages loses them, and a consumer that was down missed them. Because the log retains, a bug is recoverable by resetting the offset and reprocessing, a down consumer resumes from its last position and catches up, and new consumers can read all of history. This retain-versus-delete axis is the deepest distinction between Kafka and RabbitMQ.

**Q: If you need to increase task-processing throughput, do you add subscribers?**
A: No — that is a classic confusion between the models. Subscribers belong to pub/sub, where each gets a full copy of every message, so adding them adds independent reactions and broker fan-out cost, not speed. To process a stream of tasks faster you add *competing consumers* to a queue, which share the load so each message is handled by one of them; in Kafka that means adding consumers to a single group, up to the partition count. The mental check is: am I trying to make more things react (add subscribers / groups) or make the same work go faster (add competing consumers)?

**Q: Why can't a classic queue replay messages?**
A: Because it deletes each message once it is acknowledged, so the only copy is the one the consumer processed. There is nothing left to re-read. This is fine when processing is reliable and history is not needed, but it means a bug that corrupts processing is unrecoverable — you cannot fix the consumer and re-run the messages, because they are gone. The log solves this by retaining messages independently of consumption, so replay is just seeking a consumer's offset backwards and reading forward again over messages that were never deleted.

**Q: What happens to a pub/sub subscriber that is down when a message is published?**
A: With classic pub/sub, it misses the message, unless the broker was configured to hold a durable subscription that buffers messages for it while it is away. Delivery is to the subscribers present at publish time. This is a real operational hazard: a subscriber restart during a burst silently drops messages. The log removes the hazard structurally — because messages are retained, a consumer that was down simply resumes from its last committed offset and catches up on everything it missed, with no special durable-subscription configuration needed.

**Q: (Senior) How would you decide which model each edge of a system uses?**
A: I would go edge by edge and ask what the consumer relationship is. If the work must be shared across a pool so that each item is processed once and adding workers speeds it up, that edge is a queue — competing consumers. If several independent parts of the system must each react to the same fact, that edge is pub/sub — a subscriber each. If any consumer needs to replay history, reprocess after a bug, catch up after downtime, or if I need several independent readers of the same stream, that edge is a log. The subtlety is that one physical Kafka topic can express several of these at once — a competing-consumer group for the primary processing, several other groups for independent reactors, and a stream processor replaying for analytics — so I annotate each edge with the model it expresses rather than assuming one topic equals one model. Naming the model per edge is what keeps a composed topology legible, and it also tells me the health metric to watch on that edge: queue depth, per-subscriber rate, or per-group lag.

**Q: (Senior) Why do Kafka and RabbitMQ feel so different if both just move messages?**
A: Because they optimise for opposite points on the retain-versus-delete axis, and that choice cascades into their whole design and ergonomics. RabbitMQ leads with lean, ephemeral queues and rich broker-side routing: a message lives in memory until acked, then vanishes, which makes it a superb task distributor and router — direct, topic and headers exchanges, per-message TTL and priority, dead-letter routing — but not a system of record, because there is nothing to replay. Kafka leads with the durable, replayable log: messages sit on disk for days regardless of consumption, which makes it a system of record and an integration backbone that many independent consumers and stream processors can read and re-read, but at the cost of being heavier, with partitions and offsets to manage and far less flexible per-message routing. So the same primitives — queue and pub/sub — are present in both, but RabbitMQ composes them as first-class ephemeral objects with smart routing, while Kafka composes them out of one retained log with dumb routing. Neither is better; they are tuned for "distribute and route tasks now" versus "retain and replay an event stream". Recognising that the difference is fundamentally about retention, not features, is what makes the choice between them clear rather than a checklist comparison.

**Q: (Senior) When is the log the wrong choice despite its power?**
A: When you do not need retention or replay and the log's weight is pure overhead. The log is a durable, ordered, partitioned system of record — it brings disk storage, partition-count decisions that cap your consumer parallelism and are painful to change, offset management, and an operational footprint. For a simple task queue — resize these images, send these emails — where each task is processed once, order across tasks does not matter, and you never need to re-run history, a lean queue is simpler, more memory-efficient, and offers richer per-message features like priority and per-message TTL that the log does not. Reaching for Kafka there imports complexity for a replay capability you will never use. The log also fits poorly when you need complex, attribute-based routing to many differently-shaped consumers, because its routing is deliberately dumb (a key picks a partition, and that is nearly all); RabbitMQ's topic and headers exchanges express that far more naturally. The discipline is to let the *need for replay and multiple independent readers* be the thing that pulls you toward the log, and to prefer the lean queue when that need is absent.

## 10. Quick Revision & Cheat Sheet

| Model | Each message → | On consume | Replay? | Scale by | For |
|---|---|---|---|---|---|
| **Queue** | Exactly one worker | Deleted | No | Competing consumers | Commands / tasks |
| **Pub/sub** | Every subscriber (copy) | Deleted | No | (Adds reactions) | Events |
| **Log** | Any reader, by offset | Retained | **Yes** | Partitions + readers | Events + replay |

| On the brokers | Queue | Pub/sub | Log |
|---|---|---|---|
| **RabbitMQ** | Queue + competing consumers | Fanout/topic exchange → queues | Streams (3.9+) |
| **Kafka** | One group, N partitions | Multiple groups | Native (topic = log) |

**Flash cards**
- **Three models?** → Queue (one worker each), pub/sub (every subscriber), log (retained, read by position).
- **How does the log subsume both?** → Partitions in one group = queue; multiple groups = pub/sub; plus replay.
- **The dividing line?** → Retention: queue/pub-sub delete on consume; the log retains.
- **Faster task processing?** → Add competing consumers, not subscribers.
- **Why can't a queue replay?** → It deletes on ack; the only copy was consumed.
- **When is the log wrong?** → No replay need + a simple task queue: a lean queue is simpler.

## 11. Hands-On Exercises & Mini Project

- [ ] For a system you know, label every message edge as queue, pub/sub, or log, and justify each.
- [ ] Build a competing-consumer queue with two workers and confirm each message is processed once, then add a third worker and watch throughput rise.
- [ ] Build a pub/sub fan-out with three subscribers and confirm each gets every message; take one subscriber down during a publish and observe what it misses.
- [ ] On a Kafka topic with 3 partitions, run one consumer group with 3 consumers (queue behaviour) and separately two groups (pub/sub behaviour) — from the same topic.
- [ ] Replay a Kafka topic from offset 0 into a fresh consumer group and observe it reprocessing history that a queue could not.
- [ ] Take a design that "feels awkward" and re-express each edge with the correct model; note whether it becomes clearer.

### Mini Project — "One Topic, Three Models"

**Goal.** Demonstrate on a single Kafka topic that the log subsumes the queue and pub/sub, and that only the log can replay — making the chapter's key insight concrete.

**Requirements.**
1. Create a topic with several partitions and produce a keyed stream of events into it.
2. Run a single consumer group with as many consumers as partitions and show competing-consumer (queue) behaviour: each message processed once, load shared, throughput scaling with consumers.
3. Run several independent consumer groups on the same topic and show pub/sub behaviour: each group receives every message, independently.
4. Reset one group's offset to the beginning and replay all history, and contrast with a RabbitMQ queue where the same reprocessing is impossible because messages were deleted on ack.
5. Instrument per-group lag and show how it isolates a slow reader — a diagnostic the delete-on-consume models cannot provide.

**Extensions.**
- Implement the same three behaviours on RabbitMQ (competing consumers on a queue; a fanout exchange to per-subscriber queues; a Stream for replay) and compare the ergonomics.
- Show order interleaving: with competing consumers, demonstrate that the order of effects interleaves, and that pinning a key to a partition restores per-key order.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is a Message Queue?* (why async at all), *Design: Kafka vs RabbitMQ* (turning the retain-vs-delete axis into a decision), *The Log: Offsets, Segments & Retention* (the log in Kafka depth), *Design: Consumers, Groups, Offsets & Rebalancing* (how consumer groups implement queue and pub/sub), *Ordering, Partitioning & Keys* (where per-partition order holds and breaks).

- **The Log: What every software engineer should know** — Jay Kreps · *Advanced* · the essay that argues the log is the unifying abstraction and subsumes the other models; essential for this chapter's key insight. <https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying>
- **Enterprise Integration Patterns — Message Channel patterns** — Hohpe & Woolf · *Intermediate* · the canonical definitions of point-to-point (queue) and publish-subscribe channels and competing consumers. <https://www.enterpriseintegrationpatterns.com/patterns/messaging/MessageChannel.html>
- **Apache Kafka — Design: consumer groups** — Apache · *Intermediate* · how one mechanism yields both queue and pub/sub semantics from a single topic. <https://kafka.apache.org/documentation/#intro_consumers>
- **RabbitMQ — Publish/Subscribe & Work Queues tutorials** — RabbitMQ · *Beginner* · the two primitives as first-class objects, with runnable examples. <https://www.rabbitmq.com/tutorials/tutorial-three-python>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · the systems treatment of message brokers versus log-based messaging, and why retention changes everything. <https://dataintensive.net/>
- **RabbitMQ Streams — Overview** — RabbitMQ · *Advanced* · RabbitMQ's log-like, replayable structure, its answer to the retention gap. <https://www.rabbitmq.com/docs/streams>
- **Turning the database inside-out with Apache Samza** — Martin Kleppmann · *Advanced* · a deeper argument for the log as the backbone of a system, extending the pub/sub-versus-log discussion. <https://www.confluent.io/blog/turning-the-database-inside-out-with-apache-samza/>
- **Confluent — Kafka vs traditional messaging** — Confluent · *Intermediate* · a vendor overview of how the log differs from queue/pub-sub brokers, useful as a cross-check on the models. <https://www.confluent.io/blog/>

---

*Kafka & RabbitMQ Handbook — chapter 02.*
