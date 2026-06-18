# 07 · Message Queues & Async Processing

> **In one line:** Decouple services with async messaging for resilience and scale.

---

## 1. Overview

**Message queues** (RabbitMQ, SQS) and **logs** (Kafka) decouple producers from consumers, smoothing spikes, enabling async work, and improving resilience. They introduce delivery semantics (at-least/at-most/exactly-once) and the need for **idempotent** consumers.

## 2. Key Concepts

- Decoupling: producers don't wait on consumers.
- Queue (work distribution) vs pub-sub/log (fan-out, replay).
- Delivery: at-least-once (dedupe needed), at-most-once, exactly-once (hard).
- Backpressure & buffering absorb spikes.
- Dead-letter queues capture poison messages.

## 3. Syntax & Code

```text
Producer ─▶ [ Queue / Kafka topic ] ─▶ Consumer group
                         (buffer spikes, retry, DLQ)
Web request -> enqueue 'send_email' -> worker processes later
```

## 4. Worked Example

**Idempotent consumer**

At-least-once delivery means duplicates; make handlers idempotent (dedupe by message id).

```text
on message(id, payload):
  if seen(id): return        # dedupe
  process(payload); mark_seen(id)
```

## 5. Best Practices

- ✅ Offload slow/spiky work to async workers.
- ✅ Design consumers to be idempotent.
- ✅ Use dead-letter queues for failures.
- ✅ Pick Kafka for high-throughput streams/replay; queues for task distribution.
- ✅ Monitor lag/queue depth.

## 6. Common Pitfalls

1. ⚠️ Assuming exactly-once without idempotency.
2. ⚠️ Unbounded queues hiding a slow consumer.
3. ⚠️ No DLQ → poison messages block progress.
4. ⚠️ Ordering assumptions across partitions.
5. ⚠️ Tight producer-consumer coupling defeating the purpose.
6. ⚠️ Ignoring consumer lag growth.

## 7. Interview Questions

1. **Q: Why use a message queue?**
   A: To decouple services, absorb spikes, and process work asynchronously and resiliently.

2. **Q: Queue vs pub-sub/log?**
   A: Queues distribute work to one consumer; pub/sub and logs fan out to many and allow replay (Kafka).

3. **Q: Delivery semantics?**
   A: At-least-once (duplicates possible), at-most-once (loss possible), exactly-once (hard, usually idempotency + dedupe).

4. **Q: Why idempotent consumers?**
   A: At-least-once delivery causes duplicates; idempotency makes reprocessing safe.

5. **Q: What is a DLQ?**
   A: A dead-letter queue holding messages that repeatedly fail, for inspection/retry.

6. **Q: Kafka vs RabbitMQ?**
   A: Kafka is a partitioned, replayable log for high-throughput streaming; RabbitMQ is a flexible broker for task queues.

7. **Q: What is backpressure?**
   A: Signaling/buffering to prevent fast producers overwhelming consumers.

8. **Q: How to preserve ordering?**
   A: Within a partition/queue; global ordering across partitions isn't guaranteed.

## 8. Practice

- [ ] Design async email sending with a queue + worker.
- [ ] Make a consumer idempotent via message ids.
- [ ] Add a DLQ and explain when messages land there.

## 9. Quick Revision

Queues/logs decouple producers/consumers, smooth spikes, enable async. Mind delivery semantics (at-least-once → idempotent consumers), use DLQs, Kafka for streams/replay; monitor lag.

**References:** Messaging systems

---

*System Design Handbook — topic 07.*
