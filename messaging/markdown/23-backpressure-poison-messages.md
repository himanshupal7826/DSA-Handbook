# 23 · Backpressure, Flow Control & Poison Messages

> **In one line:** When consumers cannot keep up, the system must either signal the producer to slow down or absorb the excess — that is backpressure — and Kafka handles it naturally because consumers *pull* while RabbitMQ handles it with prefetch and connection blocking; the pathological case is a *poison message* that always fails, which will retry forever and block everything behind it unless you bound the retries with backoff and route it to a dead-letter queue.

---

## 1. Overview

Every messaging system eventually faces the same imbalance: producers generate work faster than consumers can process it. Maybe a marketing campaign trebled the order rate, maybe a downstream database slowed down, maybe a consumer deployment halved throughput for ten minutes. Whatever the cause, the queue between them starts to grow, and the question becomes: what does the system *do* about the mismatch? The answer is **backpressure** — the mechanism by which a system either signals "I am overwhelmed, slow down" back toward the producer, or deliberately absorbs the excess in a buffer, so the mismatch degrades gracefully into latency rather than catastrophically into an outage.

Kafka and RabbitMQ solve backpressure in fundamentally different ways because their delivery models differ. Kafka is **pull-based**: consumers ask the broker for the next batch of records at their own pace, so if a consumer is slow it simply polls less often and the unread messages sit on disk in the partition. There is nothing to "push back" against — backpressure is the natural consequence of pulling, and the visible symptom is **consumer lag**, the gap between the latest offset and the consumer's committed offset, growing. RabbitMQ is **push-based**: the broker pushes messages to consumers, so it needs an explicit brake, which is **prefetch** (QoS) — a limit on how many unacknowledged messages a consumer may hold at once. When memory or disk pressure gets severe, RabbitMQ escalates to **connection blocking**, refusing to accept more publishes, which propagates back as TCP backpressure to the producer. Two models, same goal: keep the imbalance from becoming an outage.

Then there is the failure that no amount of flow control fixes: the **poison message**. This is a message that fails *every* time it is processed — a malformed payload, a reference to a deleted entity, a bug triggered only by this input. Because a well-behaved consumer does not acknowledge a message it failed to process, the broker redelivers it, the consumer fails again, and you have an infinite retry loop. Worse, in a system that preserves order (a Kafka partition, an ordered queue), that one message sits at the head and **blocks every message behind it** — one bad message halts an entire partition. The fix is a discipline: **bounded retries with exponential backoff**, and when the bound is exceeded, route the message aside to a **dead-letter queue (DLQ)** or topic where it stops blocking the flow and can be inspected, fixed, and replayed. This chapter covers both halves — flow control so the system bends under load, and poison-message handling so one bad message does not break it — with the concrete recipes for Kafka and RabbitMQ.

## 2. Core Concepts

- **Backpressure** — the response to a producer/consumer rate mismatch: either signalling upstream to slow down, or absorbing the excess in a buffer so the mismatch becomes latency, not failure.
- **Flow control** — the concrete mechanisms that implement backpressure: pull-based pacing (Kafka), prefetch limits and connection blocking (RabbitMQ).
- **Pull vs push** — Kafka consumers *pull* batches at their own rate (natural backpressure); RabbitMQ *pushes* to consumers and needs prefetch to bound the push.
- **Consumer lag (Kafka)** — the difference between the log-end offset and the consumer group's committed offset; the #1 signal that consumers are falling behind.
- **Prefetch / QoS (RabbitMQ)** — `basic.qos(prefetch_count)`: the maximum number of unacknowledged messages the broker will push to a consumer before waiting for acks — the core RabbitMQ flow-control knob.
- **Connection blocking (RabbitMQ)** — when a memory or disk alarm fires, the broker stops reading from publishing connections (TCP backpressure), pausing producers.
- **max.poll.records / max.poll.interval.ms (Kafka)** — how many records a poll returns, and the maximum time between polls before the consumer is considered dead and removed from the group.
- **pause / resume (Kafka)** — a consumer API to stop fetching from specific partitions (apply backpressure to itself) without leaving the group, then resume.
- **Poison message** — a message that fails every processing attempt; left unbounded it retries forever and, under ordering, blocks everything behind it.
- **Dead-letter queue / topic (DLQ / DLT)** — a separate destination for messages that exceeded their retry budget, so they stop blocking the main flow and can be inspected and replayed.
- **DLX (RabbitMQ)** — dead-letter exchange: a queue's `x-dead-letter-exchange`; messages rejected, expired, or over-length are republished there.
- **Delivery limit (quorum queues)** — `x-delivery-limit`: RabbitMQ dead-letters a message after it has been redelivered that many times, giving bounded retries natively.
- **Retry topic pattern (Kafka)** — routing a failed message through a chain of retry topics with increasing delays, then to a DLT, so retries do not block the main partition.
- **Exponential backoff** — increasing the delay between retry attempts (with jitter) so a struggling dependency is not hammered and transient failures get time to clear.

## 3. Theory & Principles

### What backpressure actually is

Backpressure is the answer to a simple physical fact: a buffer between a fast producer and a slow consumer fills up, and a full buffer must do *something*. There are only three possibilities, and every system picks among them. It can **block the producer** — refuse to accept more until the consumer catches up, which propagates the slowdown upstream (the producer now waits, or its own buffer fills, and so on up the chain). It can **drop messages** — discard the excess, trading completeness for availability, acceptable for some telemetry but catastrophic for orders. Or it can **buffer without bound** — keep accepting, which merely defers the problem until memory or disk is exhausted and the whole broker falls over, converting a slow consumer into a total outage. Healthy systems choose *bounded buffering plus signalling*: absorb bursts in a bounded buffer, and when the bound is approached, signal upstream to slow down. That signal *is* backpressure.

The reason backpressure matters so much is that the failure mode without it is nonlinear and delayed. A system that buffers without limit looks perfectly healthy right up until the moment it does not — the disk fills, the broker stops accepting writes, and now *everything* fails at once, producers included, often cascading across services. Backpressure converts that cliff into a slope: as consumers fall behind, latency rises gradually and visibly (lag climbs), giving you time to react — scale consumers, shed load, investigate — before anything breaks. The whole point is to make the degradation *legible and gradual* rather than *invisible and sudden*.

### Kafka's model: pull is backpressure

Kafka's design makes backpressure almost a non-issue by construction, and understanding why illuminates the whole topic. Kafka consumers **pull**: a consumer calls `poll()` and the broker returns up to `max.poll.records` records; the consumer processes them, then polls again. The broker never pushes; it never gets ahead of the consumer, because the consumer sets the pace. If a consumer is slow, it simply polls less frequently, and the messages it has not yet read sit durably on disk in the partition, up to the retention limit. There is no buffer to overflow in the broker's memory, no push to throttle — the "buffer" is the log itself, sized by disk and retention, which is enormous. Backpressure is therefore *automatic*: a slow consumer naturally reads slower, and the only visible effect is that its **lag** — the distance between the newest offset and its committed offset — grows.

This is why lag is the master metric for Kafka. It directly measures the rate mismatch: flat lag means consumers keep up; rising lag means they do not; falling lag means they are catching up after a burst. Kafka gives consumers two further levers. `max.poll.records` bounds how much one poll returns, so a consumer does not fetch more than it can process before the next poll deadline. `max.poll.interval.ms` is the deadline: if a consumer takes longer than this between polls (because a batch is taking too long), the broker assumes it is dead and triggers a rebalance, reassigning its partitions — a subtle trap, because a *slow* consumer can be mistaken for a *dead* one and get kicked out, making things worse. And `pause`/`resume` let a consumer explicitly stop fetching from specific partitions — applying backpressure to *itself*, for example while a downstream system it feeds is unavailable — without leaving the group. So Kafka's flow control is: pull for natural pacing, `max.poll.records` to bound batch size, `max.poll.interval.ms` to avoid false-dead eviction, and `pause`/`resume` for deliberate self-throttling.

### RabbitMQ's model: prefetch and blocking

RabbitMQ **pushes**, so it needs an explicit brake, and that brake is **prefetch** (set via `basic.qos`). Prefetch is the maximum number of *unacknowledged* messages the broker will deliver to a consumer before it stops and waits for acks. With `prefetch=1`, the broker sends one message and will not send another until the consumer acks it — maximum flow control, fair distribution, lowest throughput. With `prefetch=100`, the broker can have a hundred messages in flight to that consumer — higher throughput, but the consumer is holding a hundred unacked messages, and if it is slow they pile up in its local buffer. Prefetch is thus the primary tuning knob for RabbitMQ backpressure: it directly caps how far ahead the broker can get, per consumer. Set it too low and throughput suffers from the round-trip per message; set it too high and a slow consumer hoards messages and loses the flow-control benefit. A common starting point is a modest value (tens) tuned against processing time.

When flow control at the consumer level is not enough — when the broker itself is running out of resources because producers are outrunning *all* consumers — RabbitMQ escalates to **resource alarms** and **connection blocking**. If memory use crosses `vm_memory_high_watermark` or free disk drops below `disk_free_limit`, the broker raises an alarm and *stops reading from connections that are publishing*. The publishing sockets are no longer drained, TCP's own flow control kicks in, and producers *block* on their next publish — genuine end-to-end backpressure propagated over TCP. This is RabbitMQ protecting itself: rather than accept messages until it crashes, it refuses new publishes and lets producers feel the pressure. Producers that use publisher confirms see the confirm stall; producers that fire-and-forget simply block on the socket. The lesson is that RabbitMQ's backpressure is a two-level system: prefetch bounds per-consumer flow, and resource alarms plus connection blocking bound the broker as a whole.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two models of backpressure: Kafka pulls, RabbitMQ pushes with a brake</text>

  <rect x="24" y="40" width="410" height="200" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">KAFKA &#8212; pull is backpressure</text>
  <rect x="44" y="80" width="90" height="34" rx="5" fill="#fff" stroke="#60a5fa"/><text x="89" y="101" text-anchor="middle" fill="#1e40af" font-size="9">producer</text>
  <path d="M136,97 L172,97" stroke="#2563eb" stroke-width="2" marker-end="url(#b1)"/>
  <rect x="174" y="72" width="150" height="50" rx="5" fill="#eff6ff" stroke="#2563eb"/><text x="249" y="92" text-anchor="middle" fill="#1e40af" font-size="9">partition log (on disk)</text><text x="249" y="108" text-anchor="middle" fill="#1d4ed8" font-size="8">0 1 2 3 4 5 6 7 8 &#8594;</text>
  <path d="M326,97 L362,97" stroke="#2563eb" stroke-width="2" marker-end="url(#b1)"/>
  <rect x="344" y="80" width="70" height="34" rx="5" fill="#fff" stroke="#60a5fa"/><text x="379" y="101" text-anchor="middle" fill="#1e40af" font-size="8">consumer</text>
  <text x="360" y="130" fill="#1d4ed8" font-size="8">poll() at own pace</text>
  <text x="44" y="150" fill="#1d4ed8" font-size="10">slow consumer &#8594; polls less &#8594; unread msgs</text>
  <text x="44" y="166" fill="#1d4ed8" font-size="10">sit on disk &#8594; LAG grows (the signal)</text>
  <text x="44" y="188" fill="#1e3a8a" font-size="10" font-weight="bold">levers:</text>
  <text x="44" y="206" fill="#1d4ed8" font-size="9">max.poll.records (batch) &#183; max.poll.interval.ms</text>
  <text x="44" y="222" fill="#1d4ed8" font-size="9">pause/resume (self-throttle) &#183; no push to overflow</text>

  <rect x="446" y="40" width="410" height="200" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">RABBITMQ &#8212; push + prefetch brake</text>
  <rect x="466" y="80" width="90" height="34" rx="5" fill="#fff" stroke="#fcd34d"/><text x="511" y="101" text-anchor="middle" fill="#92400e" font-size="9">producer</text>
  <path d="M558,97 L594,97" stroke="#d97706" stroke-width="2" marker-end="url(#b2)"/>
  <rect x="596" y="72" width="120" height="50" rx="5" fill="#fffbeb" stroke="#d97706"/><text x="656" y="92" text-anchor="middle" fill="#92400e" font-size="9">queue</text><text x="656" y="108" text-anchor="middle" fill="#b45309" font-size="8">broker PUSHES &#8594;</text>
  <path d="M718,97 L754,97" stroke="#d97706" stroke-width="2" marker-end="url(#b2)"/>
  <rect x="736" y="80" width="70" height="34" rx="5" fill="#fff" stroke="#fcd34d"/><text x="771" y="101" text-anchor="middle" fill="#92400e" font-size="8">consumer</text>
  <text x="466" y="146" fill="#b45309" font-size="10" font-weight="bold">prefetch (basic.qos): max UNACKED msgs</text>
  <text x="466" y="162" fill="#b45309" font-size="10">bounds how far ahead the broker pushes</text>
  <text x="466" y="184" fill="#92400e" font-size="10" font-weight="bold">memory / disk alarm &#8594; CONNECTION BLOCKING</text>
  <text x="466" y="200" fill="#b45309" font-size="9">broker stops reading publisher sockets &#8594; TCP</text>
  <text x="466" y="216" fill="#b45309" font-size="9">backpressure &#8594; producers BLOCK on publish</text>

  <rect x="24" y="256" width="832" height="204" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="278" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">The poison message: one message that always fails blocks everything behind it</text>
  <g font-size="9">
    <rect x="48" y="294" width="40" height="26" rx="3" fill="#fee2e2" stroke="#dc2626"/><text x="68" y="311" text-anchor="middle" fill="#7f1d1d">POISON</text>
    <rect x="90" y="294" width="34" height="26" rx="3" fill="#fff" stroke="#94a3b8"/><text x="107" y="311" text-anchor="middle" fill="#475569">m2</text>
    <rect x="126" y="294" width="34" height="26" rx="3" fill="#fff" stroke="#94a3b8"/><text x="143" y="311" text-anchor="middle" fill="#475569">m3</text>
    <rect x="162" y="294" width="34" height="26" rx="3" fill="#fff" stroke="#94a3b8"/><text x="179" y="311" text-anchor="middle" fill="#475569">m4</text>
    <text x="210" y="311" fill="#b91c1c">&#8592; fail, no ack &#8594; redeliver &#8594; fail &#8594; forever. m2..m4 STARVE (order preserved = head blocks all).</text>
  </g>
  <text x="48" y="344" fill="#991b1b" font-size="10" font-weight="bold">The fix: bounded retries with exponential backoff, then route aside to a dead-letter destination.</text>
  <rect x="48" y="356" width="180" height="40" rx="5" fill="#fff" stroke="#dc2626"/><text x="138" y="374" text-anchor="middle" fill="#7f1d1d" font-size="9">attempt 1..N with</text><text x="138" y="388" text-anchor="middle" fill="#7f1d1d" font-size="9">backoff 1s,2s,4s,8s + jitter</text>
  <path d="M230,376 L266,376" stroke="#dc2626" stroke-width="2" marker-end="url(#b1)"/>
  <rect x="268" y="356" width="180" height="40" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="358" y="374" text-anchor="middle" fill="#7f1d1d" font-size="9">exceeded budget &#8594;</text><text x="358" y="388" text-anchor="middle" fill="#7f1d1d" font-size="9">DLQ / DLT (stops blocking)</text>
  <path d="M450,376 L486,376" stroke="#dc2626" stroke-width="2" marker-end="url(#b1)"/>
  <rect x="488" y="356" width="180" height="40" rx="5" fill="#f0fdf4" stroke="#16a34a"/><text x="578" y="374" text-anchor="middle" fill="#15803d" font-size="9">inspect, fix, replay;</text><text x="578" y="388" text-anchor="middle" fill="#15803d" font-size="9">main flow moves on</text>
  <text x="48" y="424" fill="#991b1b" font-size="10">Kafka: retry-topic chain (retries off the main partition) &#8594; DLT. RabbitMQ: DLX + x-delivery-limit (quorum) or manual retry count.</text>
  <text x="48" y="444" fill="#991b1b" font-size="10" font-weight="bold">Never retry a poison message in place forever &#8212; it converts one bad input into a stalled partition/queue.</text>
</svg>
```

## 4. Architecture & Workflow

### Consumer lag as the key signal

Whichever broker you run, the single most important operational signal for the health of a consuming system is **how far behind the consumers are**. In Kafka this is **consumer lag** — for each partition, the log-end offset minus the consumer group's committed offset, i.e. how many messages have been produced but not yet processed. Aggregate lag across a group tells you whether the group as a whole is keeping up; per-partition lag tells you *which* partition is behind (often a hot partition, chapter 22, or a stuck consumer). In RabbitMQ the analogous signal is **queue depth** — the number of ready (undelivered) messages — plus the number of unacknowledged messages. The interpretation is identical: flat is healthy, rising means consumers cannot keep up, and the *rate* of rise tells you how long until the buffer is exhausted.

Lag is the signal that makes backpressure actionable. Because Kafka's backpressure is silent (a slow consumer just reads slower), lag is *how you find out* there is a mismatch at all — without watching it, the first sign of trouble is retention deleting unread messages or a downstream SLA breach. The workflow is: alert on lag crossing a threshold *and* on lag's rate of increase (a slow steady climb and a sudden spike need different responses), then respond by adding consumers (up to the partition count), optimising the handler, or shedding load. Rising lag with all consumers healthy means genuinely too little consumer capacity; rising lag on one partition with others flat means a hotspot or a stuck consumer; lag that rises then falls is a burst being absorbed exactly as designed.

### The poison message and the retry-with-backoff + DLQ recipe

A **poison message** fails every time it is processed. The naive consumer — process, and on failure do not acknowledge so the message is redelivered and retried — turns a poison message into an *infinite loop*, and because a Kafka partition and an ordered RabbitMQ queue preserve order, that message sits at the head and **starves everything behind it**. One malformed record halts a whole partition; the lag on that partition climbs without bound while the consumer burns CPU failing on the same message forever. This is one of the most common production incidents in messaging, and the fix is a firm discipline with three parts:

1. **Bound the retries.** Decide a maximum number of attempts (say 3–5). Transient failures (a brief downstream blip) usually clear within a couple of retries; a message that fails past the bound is almost certainly poison and will never succeed.
2. **Back off exponentially, with jitter.** Space the retries out — 1s, 2s, 4s, 8s — so a struggling dependency is not hammered and transient conditions get time to clear. Add random jitter so many consumers retrying do not synchronise into a thundering herd.
3. **Dead-letter on exhaustion.** When the retry budget is spent, move the message to a **dead-letter queue/topic**, acknowledge it off the main flow, and continue. The message is now preserved for inspection (why did it fail?), the main partition/queue is unblocked, and an operator can fix the root cause and replay the DLQ.

The critical design tension is *retrying in place versus retrying aside*. Retrying **in place** — nack-and-requeue to the same queue, or not committing the Kafka offset — blocks the flow while you retry, because the poison message stays at the head. For anything but the briefest transient retry, you want to retry **aside**: move the message off the main flow (to a delay/retry queue or topic) so the main flow keeps moving, and only the retry mechanism deals with the slow, backed-off reprocessing. This is exactly what the two broker-specific recipes below do.

### Kafka: the retry-topic pattern

Kafka has no built-in per-message delay or redelivery-count, so the idiom is the **retry-topic pattern**. When a message fails on the main topic, the consumer does *not* block the partition; instead it publishes the message to a **retry topic** (with a header recording the attempt count) and commits the main offset so the partition moves on. A separate consumer reads the retry topic *after a delay* (either a topic per delay tier — `retry-5s`, `retry-30s`, `retry-5m` — or by checking a timestamp and pausing), reprocesses, and on repeated failure escalates to the next tier and finally to a **dead-letter topic (DLT)**. This keeps the main partition unblocked (its throughput is unaffected by one bad message), makes the backoff explicit via the delay tiers, and collects unrecoverable messages in the DLT for inspection and replay. Spring Kafka automates this with `@RetryableTopic`; with `kafka-go` you build it explicitly, as in section 5.

### RabbitMQ: DLX, delivery-limit, and delayed retry

RabbitMQ has richer native support. A queue can declare a **dead-letter exchange** (`x-dead-letter-exchange`): when a message is rejected (`basic.nack`/`basic.reject` with `requeue=false`), expires via TTL, or exceeds a length limit, the broker automatically republishes it to that exchange, which routes it to a dead-letter queue. **Quorum queues** add `x-delivery-limit`: after a message has been redelivered that many times, RabbitMQ dead-letters it automatically — bounded retries with no application counting. For **delayed** retry (backoff), the common pattern is a **retry queue with a message TTL and a DLX pointing back at the main queue**: reject the failed message into a retry queue that holds it for, say, 30 seconds via TTL, after which it dead-letters *back* to the main queue for another attempt — a delay loop built from TTL + DLX. Combine a delivery limit (or a manual attempt-count header) to cap total attempts, and a final DLX to a true dead-letter queue when the cap is hit. This gives the full recipe — bounded, backed-off retries then a DLQ — using RabbitMQ primitives.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="r1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="r2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Retrying ASIDE: the same recipe on Kafka and RabbitMQ</text>

  <rect x="24" y="40" width="832" height="176" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">KAFKA: retry-topic chain keeps the main partition unblocked</text>
  <rect x="44" y="80" width="120" height="40" rx="6" fill="#fff" stroke="#60a5fa"/><text x="104" y="100" text-anchor="middle" fill="#1e40af" font-size="9">main topic</text><text x="104" y="114" text-anchor="middle" fill="#1d4ed8" font-size="8">fail &#8594; publish aside</text>
  <path d="M166,100 L206,100" stroke="#2563eb" stroke-width="2" marker-end="url(#r1)"/>
  <text x="186" y="92" text-anchor="middle" fill="#1e40af" font-size="8">+ commit offset</text>
  <rect x="208" y="80" width="110" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="263" y="100" text-anchor="middle" fill="#1e40af" font-size="9">retry-5s</text><text x="263" y="114" text-anchor="middle" fill="#1d4ed8" font-size="8">delay then reprocess</text>
  <path d="M320,100 L360,100" stroke="#2563eb" stroke-width="2" marker-end="url(#r1)"/>
  <rect x="362" y="80" width="110" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="417" y="100" text-anchor="middle" fill="#1e40af" font-size="9">retry-30s</text><text x="417" y="114" text-anchor="middle" fill="#1d4ed8" font-size="8">fail again &#8594; escalate</text>
  <path d="M474,100 L514,100" stroke="#2563eb" stroke-width="2" marker-end="url(#r1)"/>
  <rect x="516" y="80" width="110" height="40" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="571" y="100" text-anchor="middle" fill="#1e40af" font-size="9">retry-5m</text><text x="571" y="114" text-anchor="middle" fill="#1d4ed8" font-size="8">exponential backoff</text>
  <path d="M628,100 L668,100" stroke="#2563eb" stroke-width="2" marker-end="url(#r1)"/>
  <rect x="670" y="80" width="150" height="40" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="745" y="100" text-anchor="middle" fill="#7f1d1d" font-size="9">dead-letter topic (DLT)</text><text x="745" y="114" text-anchor="middle" fill="#991b1b" font-size="8">inspect + replay</text>
  <text x="44" y="150" fill="#1d4ed8" font-size="10" font-weight="bold">Main partition NEVER blocks &#8212; it commits and moves on; delays live on the retry topics.</text>
  <text x="44" y="172" fill="#1d4ed8" font-size="10">Each retry topic has its own consumer that waits for the tier's delay, so only that tier is paced.</text>
  <text x="44" y="194" fill="#1d4ed8" font-size="10">Attempt count travels in a header; the key is preserved so per-key order survives the retry.</text>

  <rect x="24" y="228" width="832" height="188" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="250" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">RABBITMQ: DLX + delivery-limit + a TTL retry loop</text>
  <rect x="44" y="268" width="130" height="44" rx="6" fill="#fff" stroke="#fcd34d"/><text x="109" y="288" text-anchor="middle" fill="#92400e" font-size="9">main queue (quorum)</text><text x="109" y="302" text-anchor="middle" fill="#b45309" font-size="8">x-delivery-limit=N</text>
  <path d="M176,290 L216,290" stroke="#d97706" stroke-width="2" marker-end="url(#r2)"/>
  <text x="196" y="282" text-anchor="middle" fill="#b45309" font-size="8">nack requeue=false</text>
  <rect x="218" y="268" width="130" height="44" rx="6" fill="#fffbeb" stroke="#d97706"/><text x="283" y="288" text-anchor="middle" fill="#92400e" font-size="9">retry queue</text><text x="283" y="302" text-anchor="middle" fill="#b45309" font-size="8">message-TTL 30s + DLX</text>
  <path d="M283,314 L283,344 L155,344 L153,314" fill="none" stroke="#d97706" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#r2)"/>
  <text x="220" y="360" text-anchor="middle" fill="#b45309" font-size="8">TTL expires &#8594; dead-letters BACK to main (the delay loop)</text>
  <path d="M350,290 L390,290" stroke="#d97706" stroke-width="2" marker-end="url(#r2)"/>
  <text x="370" y="282" text-anchor="middle" fill="#b45309" font-size="8">over limit</text>
  <rect x="392" y="268" width="120" height="44" rx="6" fill="#fff" stroke="#fcd34d"/><text x="452" y="288" text-anchor="middle" fill="#92400e" font-size="9">orders.dlx</text><text x="452" y="302" text-anchor="middle" fill="#b45309" font-size="8">dead-letter exchange</text>
  <path d="M514,290 L554,290" stroke="#d97706" stroke-width="2" marker-end="url(#r2)"/>
  <rect x="556" y="268" width="120" height="44" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="616" y="288" text-anchor="middle" fill="#7f1d1d" font-size="9">orders.dlq</text><text x="616" y="302" text-anchor="middle" fill="#991b1b" font-size="8">poison rests here</text>
  <text x="700" y="286" fill="#b45309" font-size="9" font-weight="bold">Bounded (delivery-limit),</text>
  <text x="700" y="302" fill="#b45309" font-size="9">backed off (TTL loop),</text>
  <text x="700" y="318" fill="#b45309" font-size="9">then dead-lettered.</text>
  <text x="44" y="390" fill="#b45309" font-size="10" font-weight="bold">requeue=false is essential &#8212; requeue=true would loop the poison message in place and block the queue head.</text>
  <text x="44" y="408" fill="#b45309" font-size="10">Alert on DLQ depth: an unwatched dead-letter queue is silent, accumulating data loss.</text>
</svg>
```

## 5. Implementation

Two Go implementations. First, a Kafka consumer that uses `pause`/`resume` for backpressure when a downstream is unavailable, plus the retry-topic pattern for poison messages. Second, a RabbitMQ consumer with prefetch and a DLX-based poison handler. Kafka uses `github.com/segmentio/kafka-go`; RabbitMQ uses `github.com/rabbitmq/amqp091-go`.

```go
package flowcontrol

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/segmentio/kafka-go"
)

// -----------------------------------------------------------------------------
// KAFKA: pause/resume for backpressure + retry-topic pattern for poison messages.
// -----------------------------------------------------------------------------

const maxAttempts = 4 // bound retries: past this a message is treated as poison

// RunKafkaConsumer processes a main topic. On a transient failure it republishes
// to a retry topic (retrying ASIDE, so the main partition is never blocked) and
// commits the main offset. On exhausting attempts it routes to the dead-letter
// topic. It also demonstrates pause/resume: if the downstream is unhealthy it
// stops fetching rather than failing every message.
func RunKafkaConsumer(ctx context.Context, brokers []string, mainTopic, group string) error {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers: brokers,
		Topic:   mainTopic,
		GroupID: group,
		// max.poll.records analogue: bound how much we fetch so we always process
		// a batch well within the poll interval and are not mistaken for dead.
		MaxBytes: 1e6,
	})
	defer r.Close()

	// A writer to publish failed messages to the retry / dead-letter topics.
	w := &kafka.Writer{Addr: kafka.TCP(brokers...), Balancer: &kafka.Hash{}}
	defer w.Close()

	for {
		// BACKPRESSURE: if the downstream we feed is unavailable, do not spin
		// failing every message — back off entirely. (With the lower-level
		// kafka-go Conn API you would call Pause on the partitions; with Reader we
		// simulate self-throttling by sleeping before the next fetch.)
		if !downstreamHealthy() {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(2 * time.Second): // resume-poll after a pause
			}
			continue
		}

		m, err := r.FetchMessage(ctx)
		if err != nil {
			return fmt.Errorf("fetch: %w", err)
		}

		if perr := process(m); perr != nil {
			attempt := attemptCount(m.Headers) + 1
			if attempt >= maxAttempts {
				// POISON: exhausted the retry budget. Route to the DLT so it stops
				// blocking anything and can be inspected/replayed. Then commit the
				// main offset — the main flow moves on.
				if err := publishWithAttempt(ctx, w, mainTopic+".DLT", m, attempt); err != nil {
					return fmt.Errorf("to DLT: %w", err)
				}
			} else {
				// Transient: retry ASIDE on a delayed retry topic, NOT in place.
				// A tiered set of retry topics (retry-5s, retry-30s, ...) gives the
				// exponential backoff; here we pick the tier from the attempt.
				retryTopic := fmt.Sprintf("%s.retry-%s", mainTopic, backoffTier(attempt))
				if err := publishWithAttempt(ctx, w, retryTopic, m, attempt); err != nil {
					return fmt.Errorf("to retry: %w", err)
				}
			}
		}

		// Commit the main offset whether we processed, retried-aside, or dead-lettered.
		// The message has been HANDED OFF; the main partition is never blocked by it.
		if err := r.CommitMessages(ctx, m); err != nil {
			return fmt.Errorf("commit: %w", err)
		}
	}
}

// RunRetryTopicConsumer drains a delayed retry topic: it waits until the message
// is old enough (the backoff delay), then reprocesses. On success it does
// nothing further; on failure the main consumer's logic re-escalates it. This is
// how the backoff delay is realised without blocking the main partition.
func RunRetryTopicConsumer(ctx context.Context, brokers []string, retryTopic, group string, delay time.Duration, reprocess func(kafka.Message) error) error {
	r := kafka.NewReader(kafka.ReaderConfig{Brokers: brokers, Topic: retryTopic, GroupID: group})
	defer r.Close()
	for {
		m, err := r.FetchMessage(ctx)
		if err != nil {
			return err
		}
		// Honour the backoff: sleep until the message has aged `delay` since it was
		// written. Because this is a SEPARATE topic, sleeping here does not block
		// the main partition — only this retry tier is paced.
		if wait := delay - time.Since(m.Time); wait > 0 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(wait):
			}
		}
		_ = reprocess(m) // success ends the chain; failure is re-escalated upstream
		if err := r.CommitMessages(ctx, m); err != nil {
			return err
		}
	}
}

func publishWithAttempt(ctx context.Context, w *kafka.Writer, topic string, m kafka.Message, attempt int) error {
	return w.WriteMessages(ctx, kafka.Message{
		Topic: topic,
		Key:   m.Key, // preserve the key so ordering per key is retained on retry
		Value: m.Value,
		Headers: append(dropHeader(m.Headers, "attempt"),
			kafka.Header{Key: "attempt", Value: []byte(strconv.Itoa(attempt))}),
	})
}

// -----------------------------------------------------------------------------
// RABBITMQ: prefetch (flow control) + a DLX-based poison-message handler.
// -----------------------------------------------------------------------------

// SetupRabbitTopology declares a main queue whose rejected messages dead-letter
// to a DLX, plus a retry queue that holds messages for a TTL then dead-letters
// them BACK to the main queue (the delayed-retry loop), and a final dead-letter
// queue for messages that exhaust their delivery limit.
func SetupRabbitTopology(ch *amqp.Channel) error {
	// The final resting place for poison messages: a real dead-letter queue.
	if _, err := ch.QueueDeclare("orders.dlq", true, false, false, false, nil); err != nil {
		return err
	}
	// Dead-letter exchange the main queue rejects into.
	if err := ch.ExchangeDeclare("orders.dlx", "fanout", true, false, false, false, nil); err != nil {
		return err
	}
	if err := ch.QueueBind("orders.dlq", "", "orders.dlx", false, nil); err != nil {
		return err
	}
	// Main queue: quorum type for x-delivery-limit (native bounded retries), and a
	// DLX so rejected / over-limit messages are routed aside instead of requeued
	// in place (which would block the flow).
	_, err := ch.QueueDeclare("orders", true, false, false, false, amqp.Table{
		"x-queue-type":           "quorum",
		"x-delivery-limit":       int32(maxAttempts), // dead-letter after N redeliveries
		"x-dead-letter-exchange": "orders.dlx",       // where over-limit / rejected msgs go
	})
	return err
}

// RunRabbitConsumer consumes with a PREFETCH limit (flow control) and handles
// poison messages by rejecting WITHOUT requeue, which — thanks to the delivery
// limit and DLX above — routes them to the DLQ after the bounded retries.
func RunRabbitConsumer(ctx context.Context, ch *amqp.Channel) error {
	// FLOW CONTROL: prefetch caps unacked messages in flight to this consumer.
	// Too low starves throughput; too high lets a slow consumer hoard messages.
	if err := ch.Qos(20, 0, false); err != nil { // prefetch_count = 20
		return fmt.Errorf("qos: %w", err)
	}
	deliveries, err := ch.Consume("orders", "", false /* manual ack */, false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume: %w", err)
	}
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case d, ok := <-deliveries:
			if !ok {
				return errors.New("delivery channel closed")
			}
			if err := process(kafka.Message{Value: d.Body}); err != nil {
				// Reject WITHOUT requeue. With x-delivery-limit the broker will
				// redeliver up to the limit (bounded retries), then dead-letter to
				// the DLX/DLQ automatically. requeue=false prevents an in-place
				// infinite loop that would block the queue head.
				_ = d.Nack(false, false)
				continue
			}
			// Ack only AFTER successful processing (at-least-once). This is also
			// what lets prefetch do its job: unacked messages count against it.
			_ = d.Ack(false)
		}
	}
}

// --- helpers (illustrative) ---
func downstreamHealthy() bool { return true }
func process(kafka.Message) error { return nil }
func attemptCount(hs []kafka.Header) int {
	for _, h := range hs {
		if h.Key == "attempt" {
			n, _ := strconv.Atoi(string(h.Value))
			return n
		}
	}
	return 0
}
func dropHeader(hs []kafka.Header, key string) []kafka.Header {
	out := hs[:0]
	for _, h := range hs {
		if h.Key != key {
			out = append(out, h)
		}
	}
	return out
}
func backoffTier(attempt int) string {
	switch attempt {
	case 1:
		return "5s"
	case 2:
		return "30s"
	default:
		return "5m"
	}
}
```

The Kafka side shows the two ideas working together: `pause`/`resume`-style self-throttling for backpressure, and the retry-topic pattern that retries *aside* so a poison message never blocks the main partition, escalating through delay tiers to a DLT. The RabbitMQ side shows `Qos` (prefetch) as the flow-control brake and a quorum queue with `x-delivery-limit` plus a DLX for bounded, automatic poison handling — rejecting with `requeue=false` so a bad message cannot loop in place.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Graceful degradation.** Backpressure turns a rate mismatch into rising latency (lag) rather than a sudden collapse, buying time to react.
- **Self-protection.** RabbitMQ's connection blocking and Kafka's disk-backed log prevent a slow consumer from taking the broker (and everyone else) down.
- **A clear health signal.** Consumer lag / queue depth is a single, interpretable metric that directly measures the mismatch and its trend.
- **Poison isolation.** Bounded retries plus a DLQ stop one bad message from halting a partition, and preserve it for diagnosis and replay.
- **Tunable flow.** Prefetch (RabbitMQ) and `max.poll.records`/`pause` (Kafka) let you dial the consumer's intake to its real processing capacity.

**Disadvantages**
- **Backpressure can cascade.** Blocking producers propagates the slowdown upstream; without care it converts one slow consumer into a stalled chain of services.
- **Retry infrastructure is real work.** Retry topics/queues, delay tiers, DLQs and their monitoring are additional components to build, operate and observe.
- **Backoff adds latency.** Exponential backoff delays a message's eventual success, which for a transient failure means slower recovery for that message.
- **DLQs rot silently.** A dead-letter queue no one watches becomes a graveyard of dropped work; the DLQ needs its own alerting and replay process.
- **Mis-tuned prefetch or poll settings.** Too-high prefetch defeats flow control; too-low kills throughput; a too-short `max.poll.interval.ms` evicts slow-but-alive consumers.

**Trade-offs**
- *Signal upstream vs absorb the excess:* blocking the producer applies true backpressure but can cascade; buffering absorbs bursts but defers the problem and risks exhausting the broker if unbounded. Healthy systems bound the buffer and signal near the bound.
- *Retry in place vs retry aside:* in-place retry is simple but blocks the flow (fine only for the briefest transient); retry-aside (retry topics / TTL+DLX) keeps the main flow moving at the cost of extra topology.
- *Prefetch high vs low:* high prefetch maximises throughput but weakens flow control and fairness and lets a slow consumer hoard; low prefetch gives tight flow control and fair distribution but adds per-message round-trips.
- *Retry budget size:* more attempts recover more transient failures but keep a truly-poison message churning longer; fewer attempts dead-letter faster but may give up on a recoverable blip.

## 7. Common Mistakes & Best Practices

- **Retrying a poison message forever in place.** Not acknowledging a failing message so it is redelivered indefinitely blocks the partition/queue head and starves everything behind it. Bound the retries and dead-letter.
- **No dead-letter path at all.** Without a DLQ, a poison message either loops forever or (if you ack-and-drop) is silently lost. Every consumer needs a DLQ escape hatch.
- **An unmonitored DLQ.** A dead-letter queue no one alerts on is invisible data loss — messages pile up unseen. Alert on DLQ depth and have a replay procedure.
- **Ignoring consumer lag.** Because Kafka backpressure is silent, not watching lag means the first symptom is retention deleting unread data or a downstream SLA breach. Alert on lag and its rate of change.
- **Prefetch too high.** A large prefetch lets a slow consumer hoard hundreds of unacked messages, defeating flow control and unbalancing distribution across consumers. Tune it to processing time.
- **`max.poll.interval.ms` too short for slow batches.** A consumer doing heavy per-message work can exceed the poll interval, be declared dead, and be kicked out mid-batch, triggering a rebalance storm. Size the interval to the real batch time or reduce `max.poll.records`.
- **Requeue-with-requeue on failure in RabbitMQ.** `nack` with `requeue=true` on a poison message loops it in place. Use `requeue=false` with a DLX (and delivery limit) so it routes aside.
- **No jitter on backoff.** Synchronised retries from many consumers create a thundering herd on the recovering dependency. Add random jitter to the backoff.
- **Best practice:** monitor lag/queue depth as the primary health signal, tune prefetch/poll settings to real processing capacity, and give every consumer a bounded-retry-with-exponential-backoff-and-jitter path that retries *aside* and dead-letters on exhaustion — with the DLQ itself alerted and replayable.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** A stalled partition with climbing lag and a consumer burning CPU on the same offset is the classic poison-message signature — inspect the message at the stuck offset. In RabbitMQ, a queue whose `messages_ready` is flat but `messages_unacknowledged` is high points at a consumer holding but not processing (too-high prefetch or a stuck handler); a queue that stops accepting publishes points at a resource alarm (check memory/disk watermarks). Always log the attempt count and the failure reason when routing to a DLQ, so the DLQ is diagnosable rather than a pile of opaque payloads.
- **Monitoring.** The primary metric is **consumer lag** (Kafka, per partition and aggregate) or **queue depth + unacked** (RabbitMQ). Alert on both the absolute value and the rate of change. Track **DLQ/DLT depth** and alert on any growth — a rising DLQ is unhandled failures accumulating. Track **redelivery rate** and **retry-topic depth**; a spike signals a systemic downstream problem rather than isolated bad messages. For RabbitMQ, monitor **connection blocking events** and the **memory/disk alarm** state, since a blocked connection is invisible to a fire-and-forget producer until confirms stall.
- **Security.** A DLQ often contains the very messages that broke processing — sometimes malformed or malicious input — so treat it as untrusted data: validate before replay, and restrict who can read it, because it may contain sensitive payloads that failed mid-processing. Backpressure interacts with denial-of-service: an attacker flooding a topic can drive lag and, in RabbitMQ, trigger connection blocking that stalls legitimate producers, so rate-limit and authenticate producers (chapter 29). Ensure retry and DLQ topics inherit the same ACLs as the main topic, or you leak messages via a less-guarded destination.
- **Scaling.** Scale consumers to reduce lag — but only up to the partition count in Kafka, beyond which extra consumers idle (chapter 22); if lag is high and you are already at the partition count, you need more partitions or a faster handler, not more consumers. In RabbitMQ, add competing consumers (order permitting) and tune prefetch as you do. When backpressure blocks producers, decide deliberately whether to shed load (drop or sample low-value messages), buffer further upstream, or scale consumers — and make that a designed policy, not an accident of which buffer fills first. For poison handling at scale, ensure the retry infrastructure itself scales: a retry topic that backs up because its consumer is under-provisioned just moves the blockage.

## 9. Interview Questions

**Q: What is backpressure and why does it matter?**
A: Backpressure is how a system responds to a producer/consumer rate mismatch: it either signals upstream to slow down or deliberately absorbs the excess in a bounded buffer, so the mismatch shows up as rising latency rather than as a sudden collapse. It matters because the alternative — buffering without limit — fails nonlinearly: the system looks healthy right up until the buffer (memory or disk) is exhausted, at which point everything fails at once, often cascading across services. Backpressure converts that cliff into a slope: as consumers fall behind, lag rises gradually and visibly, giving you time to scale, shed load, or investigate before anything breaks. The goal is to make degradation legible and gradual instead of invisible and sudden.

**Q: How does Kafka handle backpressure differently from RabbitMQ?**
A: Kafka is pull-based, so backpressure is automatic: consumers request records at their own pace with `poll()`, the broker never pushes ahead of them, and unread messages simply sit durably on disk in the partition. A slow consumer just polls less often, and the only visible effect is its lag growing — there is no broker-side buffer to overflow. RabbitMQ is push-based, so it needs an explicit brake: prefetch (`basic.qos`) caps how many unacknowledged messages the broker pushes to a consumer before waiting for acks, and when the broker itself runs low on memory or disk it raises an alarm and blocks publishing connections, applying TCP backpressure so producers block. So Kafka's flow control is inherent in the pull model plus lag as the signal, while RabbitMQ's is explicit prefetch per consumer plus connection blocking for the broker as a whole.

**Q: What is prefetch and how do you tune it?**
A: Prefetch, set via `basic.qos(prefetch_count)`, is the maximum number of unacknowledged messages RabbitMQ will push to a consumer before it stops and waits for acknowledgements. It is the primary flow-control knob: with prefetch 1 the broker sends one message and waits for its ack before sending the next — maximum control and fairness, lowest throughput; with a high prefetch the broker can keep many messages in flight — higher throughput but a slow consumer hoards unacked messages and flow control weakens. You tune it against processing time: fast handlers can take a higher prefetch to amortise the round-trip; slow handlers want a lower one so work stays fairly distributed and a slow consumer does not sit on a big backlog. A modest value in the tens is a common starting point, tuned by watching throughput and per-consumer unacked counts.

**Q: What is consumer lag and why is it the key metric?**
A: Consumer lag is the number of messages that have been produced but not yet processed by a consumer group — per partition, the log-end offset minus the group's committed offset. It is the key metric because it directly measures the producer/consumer rate mismatch: flat lag means consumers are keeping up, rising lag means they are falling behind, and falling lag means they are catching up after a burst. In Kafka especially, backpressure is silent — a slow consumer just reads slower — so lag is how you discover a mismatch exists at all; without watching it, the first symptom might be retention deleting unread messages or a downstream SLA breach. You alert on both the absolute lag and its rate of increase, because a slow steady climb and a sudden spike call for different responses.

**Q: What is a poison message and what damage does it do?**
A: A poison message is one that fails every time it is processed — a malformed payload, a reference to a deleted entity, or a bug triggered only by that input. The damage comes from the naive retry loop: a well-behaved consumer does not acknowledge a message it failed to process, so the broker redelivers it, the consumer fails again, and this repeats forever. Because a Kafka partition and an ordered RabbitMQ queue preserve order, the poison message sits at the head and blocks every message behind it — one bad message halts an entire partition or queue, lag climbs without bound, and the consumer burns CPU failing on the same input. It is one of the most common messaging incidents, and the fix is bounded retries with backoff followed by routing the message to a dead-letter queue.

**Q: Describe the retry-with-backoff-and-DLQ recipe.**
A: Three parts. First, bound the retries — pick a maximum number of attempts, typically three to five, because transient failures clear within a couple of retries and anything failing past the bound is almost certainly poison. Second, back off exponentially with jitter — space attempts out (1s, 2s, 4s, 8s) so a struggling dependency is not hammered and transient conditions get time to clear, with random jitter so many consumers do not synchronise into a thundering herd. Third, dead-letter on exhaustion — when the retry budget is spent, move the message to a dead-letter queue or topic, acknowledge it off the main flow, and continue; the message is preserved for inspection and replay while the main partition is unblocked. Crucially you retry *aside* (on separate retry topics/queues), not in place, so the main flow keeps moving while the backed-off retries happen elsewhere.

**Q: (Senior) Why does retrying a failed message in place block the whole partition, and how do you avoid it?**
A: Because Kafka delivers a partition strictly in offset order to a single consumer, and RabbitMQ delivers an ordered queue in sequence, the failing message is at the head of the flow. If your failure handling is "do not commit the offset / do not ack, so it is redelivered", the consumer keeps being handed that same message and cannot advance to the messages behind it — they are stranded until the poison message either succeeds (it never will) or is removed. So a single bad message converts into a fully stalled partition, with unbounded lag while everything else waits. The avoidance is to retry *aside* rather than in place: on failure, move the message off the main flow — in Kafka, publish it to a retry topic and commit the main offset so the partition advances; in RabbitMQ, reject it with `requeue=false` into a DLX-backed retry queue rather than requeuing it at the head. The main flow then continues at full speed, and the slow, backed-off reprocessing happens on the retry topic/queue where its delays block nothing important. The mental model is that the main partition must never be held hostage to one message's retries; retries belong on a side channel, and truly-unrecoverable messages belong in a DLQ.

**Q: (Senior) Walk through a production incident where consumer lag is climbing on one partition only. How do you diagnose it?**
A: Lag rising on a single partition while the others stay flat immediately narrows the space, because it rules out a uniform capacity shortfall — if the whole group were under-provisioned, all partitions would climb together. The two leading hypotheses are a hot partition and a stuck consumer. First I check whether the partition's *input* rate is abnormally high — a skewed key concentrating traffic there (chapter 22); if so, the fix is on the producing side (re-key or salt the hot key), because I cannot add consumers to one partition. If input is normal but the consumer is not advancing, I look at the consumer that owns that partition: is it stuck on a poison message (same offset for a long time, CPU burning, repeated failures in the logs)? If so, that one message is blocking the partition and I need the retry-aside/DLQ path to unblock it. Is the handler making a slow call for this partition's data specifically — a particular tenant hitting a cold cache or a degraded shard? Is the consumer alive but exceeding `max.poll.interval.ms` on a heavy batch, getting evicted and reassigned in a loop? I confirm by watching the committed offset for that partition over time — frozen means stuck, slowly advancing means genuinely slow processing. The distinction dictates the fix: producer-side for skew, DLQ for poison, downstream optimisation for a slow dependency, and poll-tuning for eviction loops. Throughout, per-partition lag plus the committed-offset trend and the consumer logs for that partition are the three signals that localise it.

**Q: (Senior) How would you design backpressure across a chain of services so it does not cascade into a total stall?**
A: The tension is that true backpressure — signalling upstream to slow down — is exactly what can cascade: if service C slows, it backs up B, which backs up A, and the whole chain stalls. I design so backpressure is *bounded and observable* at each hop rather than propagating unchecked. Each stage buffers in its broker (bounded by retention/disk in Kafka, by queue limits and alarms in RabbitMQ) so short bursts are absorbed locally without any upstream signal at all — the buffer is the shock absorber. When a stage's lag crosses a threshold, I want a *deliberate* policy rather than an accidental one: for high-value, must-not-drop work (orders, payments) I let backpressure propagate and accept that the chain slows, because correctness beats availability there; for low-value, high-volume work (telemetry, analytics events) I shed load at the edge — sample or drop — so a slow downstream degrades that stream's completeness rather than stalling upstream critical paths. I keep the streams isolated so backpressure on the low-value stream cannot block the high-value one (separate topics, separate consumers, separate broker resources where it matters). And I make every hop's lag and every broker's resource-alarm state a first-class alert, so a building backpressure wave is visible while it is still a slope, and I can add capacity or shed load before it reaches a cliff. The design principle is: absorb locally, propagate deliberately only where correctness demands it, shed load where it does not, and isolate critical flows so backpressure cannot cascade across value tiers.

**Q: What happens in RabbitMQ when the broker runs low on memory or disk?**
A: RabbitMQ raises a resource alarm — a memory alarm when usage crosses `vm_memory_high_watermark`, or a disk alarm when free space drops below `disk_free_limit` — and in response it stops reading from connections that are publishing. Because it no longer drains those sockets, TCP's own flow control kicks in and producers block on their next publish; producers using publisher confirms see the confirms stall. This is the broker protecting itself: rather than accept messages until it crashes, it applies genuine end-to-end backpressure and refuses new work until consumers drain the backlog and the resource recovers below the watermark. It is important to monitor these alarms explicitly, because a fire-and-forget producer experiences blocking as a silent stall with no error, and the only external sign may be that publishing has quietly stopped.

## 10. Quick Revision & Cheat Sheet

| Concern | Kafka | RabbitMQ |
|---|---|---|
| Delivery model | Pull (natural backpressure) | Push (needs a brake) |
| Flow-control knob | `max.poll.records`, `pause`/`resume` | Prefetch (`basic.qos`) |
| Broker self-protection | Disk-backed log + retention | Memory/disk alarms → connection blocking |
| Health signal | Consumer lag (per partition) | Queue depth + unacked count |
| Poison handling | Retry-topic chain → dead-letter topic | DLX + `x-delivery-limit` (quorum) |
| Delay / backoff | Retry topics per delay tier | Retry queue TTL + DLX loop |

| Poison-message recipe | Do this |
|---|---|
| Bound retries | Max 3–5 attempts, tracked in a header/delivery count |
| Back off | Exponential (1s,2s,4s,8s) + jitter |
| Retry aside | Retry topic (Kafka) / DLX retry queue (RabbitMQ), never in place |
| Dead-letter | Route to DLQ/DLT on exhaustion; alert + replay |

**Flash cards**
- **What is backpressure?** → The response to a rate mismatch: signal upstream or absorb in a bounded buffer, so mismatch → latency not outage.
- **Why is Kafka backpressure natural?** → Consumers pull at their own pace; unread messages sit on disk; lag is the signal.
- **RabbitMQ's main flow-control knob?** → Prefetch (`basic.qos`) — max unacked messages pushed per consumer.
- **What is a poison message?** → One that always fails; unbounded it retries forever and blocks everything behind it.
- **The poison fix?** → Bounded retries + exponential backoff + jitter, then dead-letter; retry aside, not in place.
- **RabbitMQ native bounded retries?** → Quorum queue `x-delivery-limit` → dead-letters after N redeliveries via the DLX.

## 11. Hands-On Exercises & Mini Project

- [ ] Produce faster than a consumer can process and watch Kafka lag climb; then add a second consumer and watch it fall (up to the partition count).
- [ ] Set a low RabbitMQ prefetch and a high one; measure throughput and per-consumer unacked counts, and observe the fairness/throughput trade.
- [ ] Trigger a RabbitMQ memory alarm (lower the watermark) and observe a publisher blocking with no error until the alarm clears.
- [ ] Inject a poison message into an ordered flow with naive retry and watch it block everything behind it; measure the stalled partition's lag.
- [ ] Add the retry-topic pattern (Kafka) so the poison message routes aside to a DLT and the main partition keeps moving; confirm throughput is restored.
- [ ] Configure a quorum queue with `x-delivery-limit` and a DLX (RabbitMQ) and confirm a message rejected repeatedly lands in the DLQ after N attempts.

### Mini Project — "Resilient Consumer with Backpressure and a DLQ"

**Goal.** Build a consumer that stays healthy under load and never lets one bad message stall it, on both Kafka and RabbitMQ, with full observability.

**Requirements.**
1. Implement a Kafka consumer with `pause`/`resume` self-throttling when a simulated downstream is unhealthy, and expose per-partition lag as a metric.
2. Add the retry-topic pattern with three delay tiers and a dead-letter topic; prove a poison message routes aside and the main partition's throughput is unaffected.
3. Implement a RabbitMQ consumer with tuned prefetch, a quorum queue with `x-delivery-limit`, and a DLX to a DLQ; prove bounded retries then dead-lettering.
4. Add exponential backoff with jitter to both retry paths and demonstrate it does not synchronise into a thundering herd under many consumers.
5. Instrument lag/queue-depth, DLQ depth, and redelivery rate, and write alerts on each; build a small replay tool that reprocesses the DLQ after a fix.

**Extensions.**
- Add a load-shedding policy for a low-value stream (sample/drop) and show backpressure on it does not stall a co-located high-value stream.
- Simulate a `max.poll.interval.ms` eviction by making the handler slow, observe the rebalance loop, and fix it by lowering `max.poll.records`.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Ordering, Partitioning & Keys* (why a partition's serial processing makes a poison message block everything behind it), *Idempotency, Deduplication & the Outbox Pattern* (why retries demand idempotent consumers), *Delivery Guarantees* (ack-after-process and redelivery, the root of both retries and duplicates), *Monitoring & Observability* (consumer lag and DLQ depth as first-class alerts), *Design: Consumers, Groups, Offsets & Rebalancing* (`max.poll.interval.ms` eviction and rebalance storms).

- **Apache Kafka — Consumer configs (`max.poll.records`, `max.poll.interval.ms`, pause/resume)** — Apache · *Advanced* · the settings and APIs behind Kafka's pull-based flow control. <https://kafka.apache.org/documentation/#consumerconfigs>
- **RabbitMQ — Consumer Prefetch** — RabbitMQ · *Intermediate* · how prefetch/QoS bounds unacknowledged messages and shapes throughput and fairness. <https://www.rabbitmq.com/docs/consumer-prefetch>
- **RabbitMQ — Flow Control & Resource Alarms** — RabbitMQ · *Advanced* · memory/disk watermarks and connection blocking as broker-level backpressure. <https://www.rabbitmq.com/docs/flow-control>
- **RabbitMQ — Dead Letter Exchanges** — RabbitMQ · *Intermediate* · DLX routing for rejected, expired, and over-length messages, the basis of poison handling. <https://www.rabbitmq.com/docs/dlx>
- **RabbitMQ — Quorum Queues (delivery-limit)** — RabbitMQ · *Advanced* · native bounded redelivery and automatic dead-lettering. <https://www.rabbitmq.com/docs/quorum-queues>
- **Spring for Apache Kafka — Non-Blocking Retries (`@RetryableTopic`)** — Spring · *Advanced* · the retry-topic-and-DLT pattern automated, a reference design even if you build it by hand. <https://docs.spring.io/spring-kafka/reference/kafka/annotation-error-handling.html>
- **Uber — Building Reliable Reprocessing and Dead Letter Queues with Kafka** — Uber Engineering · *Advanced* · a production account of retry topics, backoff, and DLQs at scale. <https://www.uber.com/blog/reliable-reprocessing/>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · flow control, buffering, and the consequences of consumers falling behind. <https://dataintensive.net/>

---

*Kafka & RabbitMQ Handbook — chapter 23.*
