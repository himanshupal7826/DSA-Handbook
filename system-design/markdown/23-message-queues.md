# 23 · Message Queues & Async Processing

> **In one line:** Put a durable buffer between producers and consumers so systems stay decoupled, absorb load spikes, and survive partial failure — at the cost of new delivery-semantics and idempotency problems.

---

## 1. Overview

A **message queue** is a durable buffer that sits between a **producer** (the code that has work to hand off) and a **consumer** (the code that does it). The producer writes a message and returns immediately; the consumer reads and processes it later, at its own pace. That single indirection buys three properties that are hard to get any other way: **temporal decoupling** (the two sides need not be up at the same time), **load leveling** (a 10× traffic spike becomes queue depth, not dropped requests or a melted database), and **resilience** (a consumer crash pauses processing instead of losing work).

The classic example is checkout. A synchronous flow charges the card, writes the order, sends a confirmation email, updates inventory, notifies the warehouse, and refreshes a recommendation model — all inside the user's HTTP request. Any one slow or down dependency fails the whole purchase. The async version does the minimum synchronously (validate, reserve, charge) and drops an `OrderPlaced` message on a queue. Email, inventory, warehouse, and analytics consume it independently. The user gets a 200 in 80ms; the tail work happens in the background and retries on failure.

The cost is that you have traded a simple, strongly-consistent function call for a distributed system with its own failure modes: messages can be **delivered more than once**, **arrive out of order**, **pile up faster than they drain** (backpressure), or **never succeed** (poison messages). The rest of this page is about paying that cost deliberately. See also **Microservices** and **CAP & Consistency** for the surrounding context.

## 2. Core Concepts

- **Producer / Consumer** — decoupled endpoints. The producer never blocks on the consumer; it blocks (briefly) only on the broker's durable write.
- **Broker** — the middleware that stores messages and tracks who has read what (RabbitMQ, Amazon SQS, Kafka, NATS, Google Pub/Sub).
- **Queue vs. Pub/Sub** — a **queue** delivers each message to exactly **one** of N competing consumers (work distribution). **Pub/Sub** fans a message out to **every** subscriber (event broadcast). A **log** (Kafka) is pub/sub with durable, replayable, ordered history.
- **Delivery guarantee** — the contract on duplication and loss: **at-most-once**, **at-least-once**, or **exactly-once**. Almost every practical system is at-least-once plus idempotency.
- **Acknowledgement (ack)** — the consumer tells the broker "I'm done; delete it." Ack **after** processing, not on receipt, or a crash loses work.
- **Visibility timeout / lease** — when a consumer picks up a message, the broker hides it for T seconds. If no ack arrives in time, it becomes visible again for redelivery. Sets the redelivery clock.
- **Dead-letter queue (DLQ)** — a side queue where messages land after N failed attempts, so one poison message can't block the pipeline forever.
- **Backpressure** — the signal (or mechanism) that tells producers to slow down when consumers can't keep up. Without it, an unbounded queue just defers the crash.
- **Idempotent consumer** — a handler that produces the same effect whether it runs once or five times. This is the price of at-least-once delivery, and it is non-negotiable.
- **Consumer group** — a set of consumers that share the work of one logical stream, scaling throughput horizontally.

## 3. Architecture

A producer publishes to a broker; the broker durably persists (and often replicates) the message; one or more consumers pull work, process it, and ack. Failed messages are retried under the visibility timeout and eventually routed to a DLQ. The broker is the system of record for "what work is outstanding."

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <!-- producers -->
  <rect x="16" y="60" width="120" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="76" y="87" text-anchor="middle" fill="#1e293b">Producer A</text>
  <rect x="16" y="150" width="120" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="76" y="177" text-anchor="middle" fill="#1e293b">Producer B</text>
  <!-- broker -->
  <rect x="250" y="40" width="220" height="170" rx="8" fill="#f8fafc" stroke="#475569"/>
  <text x="360" y="60" text-anchor="middle" fill="#64748b">Broker (durable, replicated)</text>
  <rect x="270" y="80" width="180" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="100" text-anchor="middle" fill="#1e293b">Queue: orders</text>
  <rect x="270" y="120" width="180" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="140" text-anchor="middle" fill="#1e293b">msg · msg · msg · msg</text>
  <rect x="270" y="160" width="180" height="34" rx="6" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="181" text-anchor="middle" fill="#1e293b">visibility timeout / lease</text>
  <!-- consumers -->
  <rect x="570" y="40" width="120" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="630" y="65" text-anchor="middle" fill="#1e293b">Consumer 1</text>
  <rect x="570" y="95" width="120" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="630" y="120" text-anchor="middle" fill="#1e293b">Consumer 2</text>
  <text x="630" y="150" text-anchor="middle" fill="#64748b">(consumer group)</text>
  <!-- DLQ -->
  <rect x="570" y="175" width="120" height="40" rx="8" fill="#fff7ed" stroke="#b91c1c"/>
  <text x="630" y="200" text-anchor="middle" fill="#b91c1c">Dead-letter Q</text>
  <!-- arrows -->
  <line x1="136" y1="82" x2="248" y2="95" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="136" y1="172" x2="248" y2="140" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="470" y1="95" x2="568" y2="62" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="470" y1="130" x2="568" y2="115" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="470" y1="178" x2="568" y2="192" stroke="#b91c1c" marker-end="url(#ar)"/>
  <text x="510" y="250" text-anchor="middle" fill="#64748b">ack deletes · no ack ⇒ redeliver · N fails ⇒ DLQ</text>
</svg>
```

## 4. How It Works

The core work-queue flow with at-least-once delivery and a visibility timeout:

1. **Publish.** Producer sends `msg` to the broker. The broker persists it (fsync / replicate to a quorum) and only then returns success. The producer now knows the work won't be lost.
2. **Reserve.** A consumer polls (or is pushed) `msg`. The broker marks it **in-flight** and starts a **visibility timeout** of, say, 30s — during which no other consumer can see it.
3. **Process.** The consumer does the work: charge the card, write the row, call the API. This must be **idempotent** because step 5 can fail after this succeeds.
4. **Ack.** On success the consumer acks; the broker **deletes** the message. Done.
5. **Redeliver on failure.** If the consumer crashes or the timeout expires before an ack, the broker makes the message **visible again** and another consumer retries it. This is exactly why duplicates happen.
6. **Dead-letter.** After N redeliveries (tracked by a receive/delivery counter), the broker routes the message to the **DLQ** and moves on, so one bad message never blocks the queue.

```text
publish ──▶ [broker persists] ──▶ reserve (hide 30s) ──▶ process
                                          │  ack ✔ ──▶ delete
                                          │  no ack ✘ ──▶ visible again ──▶ retry
                                          └─ >N retries ──▶ DLQ
```

## 5. Key Components / Deep Dive

### Delivery guarantees

- **At-most-once:** ack on receive, then process. A crash mid-process loses the message. Zero duplicates, possible loss. Fine for metrics samples, sensor pings, best-effort notifications.
- **At-least-once:** process, then ack. A crash before ack causes redelivery. No loss, possible duplicates. **The default for anything that matters.**
- **Exactly-once:** no duplicates *and* no loss. Impossible in general as a pure delivery property (the ack itself can be lost). It is achievable as an **effectively-once** result: at-least-once delivery **plus** an idempotent consumer or a transactional dedupe store. Kafka offers exactly-once *within* its own read-process-write via transactions; the moment you touch an external system, you are back to idempotency.

### Idempotency — the real solution

Because at-least-once means duplicates, the consumer must make repeats harmless:

- **Dedupe key:** attach a stable `message_id` (or business key like `order_id`); record processed ids in a store with a unique constraint; skip if seen. `INSERT ... ON CONFLICT DO NOTHING` is the canonical pattern.
- **Idempotent operations:** design the effect to be naturally repeatable — `SET balance=100` not `balance += 10`; upserts not blind inserts.
- **Idempotency window:** dedupe stores can't grow forever; keep keys for a TTL longer than max possible redelivery (retention + retries).

### Ordering

Global ordering across a distributed queue is expensive and rarely needed. What you actually want is **ordering within a key**: all events for `user_42` in order, but `user_42` and `user_99` may interleave. Kafka gives this via **partition-by-key** (one partition is a total order); SQS via **FIFO queues with a MessageGroupId**; RabbitMQ only within a single queue with a single consumer. Any parallel consumption across a key's boundary breaks order — so ordering and throughput trade off directly.

### Visibility timeout tuning

Too **short** → a slow-but-healthy consumer's message gets redelivered while it's still working → duplicate processing and wasted effort. Too **long** → a genuinely crashed consumer's message sits invisible for minutes before retry → high tail latency. Set it to ~p99 processing time × a safety factor, and for long jobs **extend the lease** with heartbeats (SQS `ChangeMessageVisibility`) rather than picking one large fixed value.

### Backpressure

An unbounded queue turns a throughput problem into a latency-and-memory problem: it *looks* healthy while the age of the oldest message climbs toward hours. Real backpressure means bounding the system: cap queue depth and reject/shed at the producer (429), scale consumers on lag, or apply flow control (RabbitMQ blocks publishers when memory is high). "Just let it buffer" is not a strategy — it's a deferred outage.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **RabbitMQ** (broker/smart routing) | Flexible routing (exchanges, topics), per-message ack, priorities, mature; low latency | Throughput ceiling (~tens of k/s per queue); messages deleted on ack (no replay); ordering only within a queue |
| **Amazon SQS** (managed queue) | Fully managed, effectively infinite scale, dead-letter + visibility built in, cheap | At-least-once (standard) with no ordering; FIFO caps ~3k msg/s (batched); no replay; polling latency |
| **Apache Kafka** (durable log) | Very high throughput (M/s), replay from offset, strong per-partition ordering, retention & fan-out to many groups | Operationally heavy; ordering only per partition; not a task queue (no per-message ack/delete, no priorities) |
| **Sync RPC (no queue)** | Simple, strongly consistent, easy to reason about | No load leveling, no buffering; caller coupled to callee's uptime and latency |

Rule of thumb: reach for a **queue** (SQS/RabbitMQ) when you're distributing discrete *tasks* to workers and want per-message retry/DLQ; reach for a **log** (Kafka) when many independent consumers need the same *stream* of events, with replay and high throughput. Keep it **synchronous** when the caller genuinely needs the result now and the callee is fast and reliable.

## 7. When to Use / When to Avoid

**Use when:**
- Work is slow, spiky, or failure-prone (email, image transcode, third-party APIs, exports).
- Producers and consumers scale, deploy, or fail independently.
- You need to absorb bursts without over-provisioning the downstream (load leveling).
- Multiple independent teams/services react to the same event (fan-out).
- You want retries, DLQs, and durability for free instead of hand-rolling them.

**Avoid when:**
- The caller needs the result synchronously to proceed (a login, a balance read).
- The operation is fast, cheap, and reliable — a queue adds latency and moving parts for nothing.
- You cannot make consumers idempotent and duplicates are unacceptable and unguardable.
- Strict global total ordering across all messages is required at high throughput (fights the model).
- The extra operational surface (broker, DLQ handling, monitoring) outweighs the async benefit at your scale.

## 8. Scaling & Production Best Practices

- **Scale consumers horizontally** within a group; use queue depth / consumer lag as the autoscaling signal, not CPU.
- **Batch** publishes and consumes (SQS up to 10 msgs/call, Kafka linger.ms) — batching is often a 5–10× throughput win and a cost cut.
- **Always configure a DLQ** with a sane `maxReceiveCount` (3–5). A queue without a DLQ will eventually wedge on a poison message.
- **Make every consumer idempotent** with a dedupe key; assume at-least-once even if the docs say otherwise.
- **Keep messages small** — pass a pointer (S3 key, row id), not a 5MB payload. Brokers are for coordination, not blob storage (claim-check pattern).
- **Set retention deliberately** — long enough to recover from a multi-hour consumer outage, short enough to bound storage.
- **Separate priority classes** into separate queues; a shared queue lets bulk work starve urgent work.
- **Cap in-flight work** (prefetch/`max_in_flight`) so one consumer doesn't hoard messages it can't finish before the timeout.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Consumer crashes mid-process | Message redelivered → duplicate work | Ack-after-process + idempotent handler (dedupe key) |
| Poison message (always throws) | Retry loop blocks/throttles the queue | DLQ after N attempts; alert on DLQ depth; replay after fix |
| Slow consumer / lag growth | Oldest-message age climbs; SLA breach | Autoscale on lag; backpressure/shed at producer; add partitions |
| Visibility timeout too short | Duplicate processing of healthy work | Heartbeat-extend lease; set timeout to p99 × safety |
| Broker/partition unavailable | Producers blocked or messages lost | Replication (RF≥3, quorum acks); producer retries with buffer |
| Unbounded queue growth | Memory pressure, then hard outage | Bound depth, apply flow control, shed load |
| Duplicate publish (retry after timeout) | Same logical event enqueued twice | Producer idempotency / dedupe id; consumer dedupe as backstop |
| Out-of-order delivery | Stale state overwrites fresh | Partition/group by key; version/timestamp guards on writes |

## 10. Monitoring & Metrics

- **Queue depth / backlog** — number of visible messages. Trend matters more than absolute value.
- **Age of oldest message (`ApproximateAgeOfOldestMessage` / consumer lag in seconds)** — the single best health signal; alert when it exceeds your SLA.
- **Consumer lag** (Kafka: offset behind head) per group/partition.
- **Processing throughput** (msgs/s) and **per-message latency** (p50/p99).
- **Redelivery / receive-count** distribution — rising means failures or timeout mistuning.
- **DLQ depth and rate** — any nonzero DLQ rate is an alert.
- **Ack/error ratio** and **in-flight count** vs. capacity.
- **Producer publish latency & failure rate** — spikes reveal broker trouble or backpressure.

## 11. Common Mistakes

1. ⚠️ Acking on receive instead of after successful processing — silently drops work on any crash.
2. ⚠️ Assuming exactly-once and skipping idempotency — the first duplicate corrupts state.
3. ⚠️ No DLQ — one poison message pins the queue and pages you at 3am.
4. ⚠️ Treating queue depth as fine because "it's draining eventually" — ignore oldest-message age at your peril.
5. ⚠️ Assuming order across partitions/consumers — parallelism breaks ordering by definition.
6. ⚠️ Putting large payloads on the queue instead of a claim-check pointer — throughput collapses.
7. ⚠️ Using one queue for urgent and bulk work — bulk starves urgent under load.
8. ⚠️ Setting the visibility timeout to a random large number instead of tying it to real p99 processing time.

## 12. Interview Questions

**Q: Why put a queue between two services instead of calling directly?**
A: Decoupling (they scale/deploy/fail independently), load leveling (spikes become queue depth, not dropped requests), and resilience (a consumer outage pauses work rather than losing it). You pay with async complexity: duplicates, ordering, and idempotency.

**Q: What's the difference between a queue, pub/sub, and a log?**
A: A queue delivers each message to one of N competing consumers (work sharing). Pub/sub fans each message out to every subscriber (broadcast). A log (Kafka) is durable, ordered, replayable pub/sub — consumers track their own offset and can re-read history.

**Q: Explain the three delivery guarantees and which you'd pick.**
A: At-most-once (ack then process — possible loss, no dupes), at-least-once (process then ack — no loss, possible dupes), exactly-once (neither — impossible as pure delivery). Pick at-least-once plus idempotent consumers for anything that matters; it's the only combination that's both safe and buildable.

**Q: There's no true exactly-once. So how do you get exactly-once effects?**
A: At-least-once delivery + effectively-once processing. Either make the operation idempotent (upserts, `SET` not `+=`), dedupe on a stable message/business key with a unique constraint, or do read-process-write inside a single transaction (Kafka transactions, or an outbox with the DB). The ack can always be lost, so you defend at the consumer, not the wire.

**Q: How do visibility timeouts and DLQs interact to give you reliable retries?**
A: On pickup the broker hides the message for T seconds; ack deletes it, no ack makes it visible again for retry. A receive counter tracks attempts; after N it's routed to the DLQ instead of retried forever. Timeout controls retry latency; DLQ controls blast radius of poison messages.

**Q: A consumer job takes 5 minutes but your visibility timeout is 30s. What happens and how do you fix it?**
A: The message reappears after 30s while the first consumer is still working, so it's processed in parallel — duplicate work and possible races. Fix: heartbeat-extend the lease periodically (SQS ChangeMessageVisibility), or size the timeout above p99, or break the job into smaller messages. Never just crank the timeout to an hour — that makes genuine crash recovery glacial.

**Q: (Senior) Your queue depth is flat but users complain of staleness. What do you look at?**
A: Depth can be flat while the *age of the oldest message* climbs — a consumer keeping up with arrival rate but never catching up on a backlog, or ordering forcing serial processing of one hot key. Watch oldest-message age and per-key lag, not just count. The fix might be more partitions, better key distribution, or shedding.

**Q: (Senior) How do you guarantee ordering while still scaling consumers horizontally?**
A: You don't get global order cheaply. Partition by a key (Kafka partition, SQS MessageGroupId) so all events for one key land on one ordered lane processed by one consumer, while different keys parallelize. Throughput scales with key cardinality, and a hot key becomes a serial bottleneck — so the real work is choosing a key that's both ordering-correct and evenly distributed.

**Q: (Senior) Producers are outrunning consumers. Walk me through applying backpressure.**
A: First detect it (oldest-message age / lag rising). Then choose where to push back: scale consumers on lag (fastest), bound the queue and shed at the producer with 429s (protects the system), or use broker flow control to block publishers (RabbitMQ). "Buffer more" defers, doesn't solve. The decision is which pain you prefer — rejected requests now vs. an unbounded latency blow-up later.

**Q: (Senior) When would you choose Kafka over SQS/RabbitMQ, and when is that the wrong call?**
A: Kafka when many independent consumer groups need the same high-throughput stream with replay and per-partition order (event backbone, CDC, analytics). Wrong when you need a task queue: per-message ack/delete, priorities, per-message retry/DLQ semantics, and low operational overhead — that's SQS/RabbitMQ. Using Kafka as a task queue means reimplementing acks and DLQs yourself.

**Q: How do you make a payment-charging consumer safe under at-least-once delivery?**
A: Idempotency key on the charge (e.g. `order_id`) sent to the payment provider so a retry returns the original charge instead of double-billing; a local processed-ids table with a unique constraint as a backstop; and ack only after the charge is durably recorded. Effect is the same whether it runs once or three times.

## 13. Alternatives & Related

- **Event Streaming & Kafka Internals** — the log model in depth (partitions, offsets, exactly-once).
- **Event-Driven Architecture, CQRS & Event Sourcing** — patterns built on top of queues/logs, including the outbox.
- **Microservices** — the primary consumer of async messaging for inter-service communication.
- **Rate Limiting** — the complementary technique for shedding load the queue can't absorb.
- **CAP & Consistency** — why async messaging implies eventual consistency downstream.
- **Sagas / choreography** — coordinating multi-step workflows over messages.

## 14. Cheat Sheet

> [!TIP]
> **Message Queues in one screen**
> - **Buy:** decoupling · load leveling · resilience. **Pay:** duplicates · ordering · idempotency.
> - **Queue** = one-of-N consumers (tasks). **Pub/Sub** = all consumers (broadcast). **Log** = replayable ordered pub/sub (Kafka).
> - **Assume at-least-once.** Exactly-once effects = at-least-once + idempotent consumer (dedupe key / upsert / txn).
> - **Ack AFTER processing.** Visibility timeout ≈ p99 × safety; heartbeat-extend long jobs.
> - **Always have a DLQ** (maxReceiveCount 3–5) and **alert on DLQ depth**.
> - **Health metric = age of oldest message / lag**, not raw depth.
> - **Ordering only within a key** (partition / MessageGroupId); parallelism breaks global order.
> - **Backpressure is mandatory:** bound the queue and shed, or autoscale on lag — don't "just buffer."
> - **RabbitMQ** = routing + task semantics · **SQS** = managed infinite scale · **Kafka** = throughput + replay.

**References:** RabbitMQ docs, AWS SQS Developer Guide, Kafka documentation, "Designing Data-Intensive Applications" ch. 11, Enterprise Integration Patterns (Hohpe)

---
*System Design Handbook — topic 23.*
