# 40 · APIs in Microservices Architectures

> **In one line:** Once a system is split into services, every method call you used to make becomes a network call that can be slow, duplicated, or lost — so the design problem shifts from "what is the API" to "sync or async, what timeout, whose retry, and how do we undo a half-finished business transaction".

---

## 1. Overview

A monolith gives you two guarantees for free that you never think about: a function call either happens or throws, and a database transaction either commits everything or nothing. Split that monolith into services and both guarantees vanish simultaneously. The function call becomes an HTTP request that can time out *after* the work completed on the other side; the transaction becomes a sequence of independent commits across separate databases with no coordinator. Almost every hard problem in microservices — retries, idempotency, circuit breakers, sagas, eventual consistency — is a consequence of losing those two guarantees.

The problem microservices *solve* is organisational before it is technical. Conway's Law observes that systems mirror the communication structure of the organisations that build them; the microservice bet is to invert that deliberately — draw service boundaries around business capabilities so that a team can own, deploy, and scale one independently without a release-train negotiation. The cost is that the calls between those capabilities are now unreliable, and the *fallacies of distributed computing* (Deutsch and Gosling, Sun Microsystems, 1994) come due in full: the network is not reliable, latency is not zero, bandwidth is not infinite, the network is not secure, topology changes, and transport cost is not zero.

The lineage runs from SOA and enterprise service buses in the 2000s (which centralised smarts in the bus and got brittle), through the "smart endpoints, dumb pipes" reaction articulated by James Lewis and Martin Fowler in their 2014 *Microservices* article, to the current synthesis: HTTP/REST or gRPC for synchronous request/response, an event log (Kafka, Pulsar) or a queue (SQS, RabbitMQ) for asynchronous propagation, a service mesh for transport-level reliability, and explicit patterns — outbox, saga, circuit breaker — for the correctness problems that reliability alone cannot fix.

The single most consequential design choice per interaction is **synchronous or asynchronous**. Synchronous is simple to reason about and gives the caller an immediate answer, but it creates **temporal coupling**: if the callee is down, the caller is down. Chain four synchronous services each with 99.9% availability and the composite is `0.999^4 ≈ 99.6%` — from 43 minutes of downtime a month to nearly three hours. Asynchronous messaging removes temporal coupling — the producer commits an event and moves on — but pays with eventual consistency, out-of-order and duplicate delivery, and debugging that requires real tracing.

A concrete example to hold onto: placing an order at a retailer. `POST /v1/orders` must synchronously validate the cart and reserve inventory, because the customer needs an immediate yes or no. But charging the card, allocating a warehouse, emailing a confirmation, updating the loyalty balance, and notifying analytics must all be asynchronous — each is a separate failure domain, none should be able to fail the checkout, and several take seconds or minutes. The order is created in a `pending` state, an `order.placed` event is published through the **outbox** in the same database transaction as the order row, and a **saga** drives it to `confirmed` or issues compensating actions (release inventory, refund) if payment ultimately fails. Amazon, Uber, and Shopify all describe versions of exactly this shape.

---

## 2. Core Concepts

- **Synchronous (request/response)** — the caller blocks until the callee answers; simple, immediate, and temporally coupled.
- **Asynchronous (event/message)** — the caller emits a message and continues; decoupled in time, eventually consistent.
- **Orchestration vs choreography** — orchestration has a central coordinator telling services what to do next; choreography has each service react to events emitted by others. Orchestration is easier to observe, choreography is more decoupled.
- **Service discovery** — resolving a logical service name to healthy instance addresses; client-side (Eureka, Consul) or server-side (Kubernetes Service + DNS, mesh xDS).
- **Timeout / deadline** — the maximum time a caller will wait; a **deadline** is an absolute point in time propagated downstream so the whole call graph stops when the budget expires.
- **Retry with backoff and jitter** — reissuing a failed request after an exponentially growing, randomised delay; safe only for idempotent operations.
- **Circuit breaker** — a state machine (closed → open → half-open) that stops sending traffic to a failing dependency so it can recover and the caller fails fast.
- **Bulkhead** — isolating resources (connection pools, thread pools) per dependency so one sick upstream cannot starve the others.
- **Idempotency key** — a client-supplied unique token that lets a service deduplicate retried unsafe requests, turning at-least-once delivery into effectively-once processing.
- **Saga** — a sequence of local transactions across services, where each step has a **compensating action** that semantically undoes it if a later step fails.
- **Transactional outbox** — writing the event to an `outbox` table in the same local transaction as the state change, then relaying it to the broker, guaranteeing the two never diverge.
- **Dead-letter queue (DLQ)** — where messages go after exhausting redelivery, so a poison message does not block the partition forever.
- **Backpressure / load shedding** — refusing or slowing intake when saturated (`429`/`503` + `Retry-After`) rather than queueing unboundedly and collapsing.

---

## 3. Theory & Principles

**Availability multiplies down a synchronous chain.** If service *A* calls *B* calls *C*, and each is independently available with probability *p*, the end-to-end availability is `p^n`. Three nines across four hops is 99.6%; across ten hops it is 99.0% — roughly seven hours of downtime a month, from components that each look excellent on their own dashboard. There are exactly three ways out: reduce *n* (fewer synchronous hops per request), raise *p* per hop (redundancy, but with diminishing returns), or **break the dependency** by making the call asynchronous or by having a fallback that lets the caller succeed without the callee. The third is nearly always the highest-leverage.

**Latency adds down the same chain, and tails amplify across fan-out.** Serial hops sum their latency; parallel fan-out takes the max but multiplies tail exposure — with *n* independent calls each at p99 = 100 ms, `P(at least one slow) = 1 - 0.99^n`, which is 9.6% at n=10. This is the practical reason deep synchronous call graphs are an anti-pattern regardless of how clean the boundaries look.

**Delivery semantics are a choose-two.** Networks give you **at-most-once** (fire and forget; may lose) or **at-least-once** (retry until acked; may duplicate). True exactly-once *delivery* is impossible over an unreliable network — the classic Two Generals result — but **effectively-once processing** is achievable by pairing at-least-once delivery with an idempotent consumer: deduplicate on a message ID or business key, or make the operation naturally idempotent (`SET status = 'paid'` rather than `balance = balance - 10`). Every message consumer you write must answer "what happens if this is delivered twice?" — and the answer must not be "we hope it isn't".

**The dual-write problem.** The most common correctness bug in event-driven systems: a service writes to its database and then publishes an event. If the publish fails (or the process dies between the two), the database and the event log disagree, permanently and silently. Reversing the order does not help. The fix is the **transactional outbox** — insert the event row into an `outbox` table inside the *same* database transaction as the state change, then have a separate relay (a poller, or change-data-capture with Debezium) read the outbox and publish. The relay may publish twice, which is fine, because consumers are idempotent.

**Sagas replace ACID with compensation.** Two-phase commit across services is technically possible and practically a bad idea — it holds locks across the network, blocks on coordinator failure, and couples availability. Garcia-Molina and Salem's 1987 saga paper gives the alternative: a long-running business transaction as a sequence of local ACID transactions `T1…Tn` with compensations `C1…Cn-1`. If `T3` fails, run `C2` then `C1`. Three properties matter in practice. Sagas provide **atomicity but not isolation** — intermediate states are visible to other readers, so you need semantic locks (`status: pending`) or you will read money that is about to be refunded. Compensations are **semantic, not physical** — you cannot un-send an email, so you send an apology; you cannot un-ship a package, so you issue a return label. And compensations **must themselves be retriable and idempotent**, because they run precisely when things are already going wrong.

**Circuit breaker mechanics.** Closed: traffic flows, failures are counted over a rolling window. When the failure ratio exceeds a threshold (say 50% over 20 requests), the breaker **opens** — every call fails immediately with no network attempt, which both protects the caller's threads and lets the callee recover. After a cool-down (say 30 s) it goes **half-open** and admits a trickle of probe requests; success closes it, failure re-opens it with a longer cool-down. The value is asymmetric: the caller stops burning latency budget on doomed calls, and the callee stops being hammered while trying to restart.

**Retry storms and metastable failure.** Retries are load amplification. If every layer retries 3× and there are three layers, one backend blip becomes 27× the traffic — which keeps the backend down after the original cause is gone. This is a **metastable failure**: the system stays broken because of the load its own recovery attempts generate. Defences: retry at exactly **one** layer, use a **retry budget** (a global cap, e.g. retries may not exceed 10% of requests), always add **full jitter** to backoff (`sleep = random(0, min(cap, base * 2^attempt))`), and never retry a `4xx` other than `408`/`429`.

```svg
<svg viewBox="0 0 760 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="380" fill="#f8fafc"/>
  <text x="380" y="26" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">Circuit breaker states, and why synchronous chains multiply risk</text>
  <ellipse cx="130" cy="110" rx="72" ry="42" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="130" y="106" text-anchor="middle" font-size="13" font-weight="bold" fill="#1e293b">CLOSED</text>
  <text x="130" y="124" text-anchor="middle" font-size="10" fill="#1e293b">traffic flows</text>
  <ellipse cx="380" cy="110" rx="72" ry="42" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="380" y="106" text-anchor="middle" font-size="13" font-weight="bold" fill="#1e293b">OPEN</text>
  <text x="380" y="124" text-anchor="middle" font-size="10" fill="#1e293b">fail fast, no call</text>
  <ellipse cx="630" cy="110" rx="76" ry="42" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="630" y="106" text-anchor="middle" font-size="13" font-weight="bold" fill="#1e293b">HALF-OPEN</text>
  <text x="630" y="124" text-anchor="middle" font-size="10" fill="#1e293b">probe trickle</text>
  <line x1="202" y1="98" x2="306" y2="98" stroke="#dc2626" stroke-width="2"/>
  <polygon points="306,98 297,94 297,102" fill="#dc2626"/>
  <text x="254" y="88" text-anchor="middle" font-size="10" fill="#1e293b">failure ratio &gt; 50%</text>
  <line x1="452" y1="98" x2="552" y2="98" stroke="#d97706" stroke-width="2"/>
  <polygon points="552,98 543,94 543,102" fill="#d97706"/>
  <text x="502" y="88" text-anchor="middle" font-size="10" fill="#1e293b">after 30s</text>
  <path d="M 600 150 Q 380 210 160 150" fill="none" stroke="#16a34a" stroke-width="2"/>
  <polygon points="160,150 168,156 170,148" fill="#16a34a"/>
  <text x="380" y="196" text-anchor="middle" font-size="10" fill="#16a34a">probe succeeds &#8594; close</text>
  <path d="M 636 152 Q 520 176 452 128" fill="none" stroke="#dc2626" stroke-width="2" stroke-dasharray="4"/>
  <polygon points="452,128 461,131 458,123" fill="#dc2626"/>
  <text x="560" y="172" text-anchor="middle" font-size="10" fill="#dc2626">probe fails &#8594; re-open</text>
  <line x1="30" y1="228" x2="730" y2="228" stroke="#94a3b8" stroke-width="1"/>
  <text x="30" y="254" font-size="13" font-weight="bold" fill="#1e293b">Availability of a synchronous chain: A = p^n</text>
  <rect x="30" y="266" width="120" height="34" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="90" y="288" text-anchor="middle" font-size="11" fill="#1e293b">n=1  99.900%</text>
  <rect x="166" y="266" width="120" height="34" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="226" y="288" text-anchor="middle" font-size="11" fill="#1e293b">n=4  99.600%</text>
  <rect x="302" y="266" width="120" height="34" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="362" y="288" text-anchor="middle" font-size="11" fill="#1e293b">n=10 99.004%</text>
  <rect x="438" y="266" width="130" height="34" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="503" y="288" text-anchor="middle" font-size="11" fill="#1e293b">n=20 98.020%</text>
  <text x="590" y="288" font-size="11" fill="#1e293b">each hop p = 99.9%</text>
  <text x="30" y="326" font-size="11" fill="#1e293b">Fix by reducing n (fewer sync hops), not by chasing more nines per service.</text>
  <text x="30" y="346" font-size="11" fill="#1e293b">Async publish + outbox removes the hop from the critical path entirely: the caller commits and returns.</text>
  <text x="30" y="366" font-size="11" fill="#1e293b">Retry amplification: 3 layers &#215; 3 retries = 27&#215; load &#8594; metastable failure. Retry at ONE layer, with a budget and jitter.</text>
</svg>
```

---

## 4. Architecture & Workflow

Follow one checkout end to end through a synchronous front half and an asynchronous saga.

1. **Client → gateway → orders-api.** `POST /v1/orders` arrives with an `Idempotency-Key`. The gateway has already authenticated the caller, injected `X-Request-Id` and `traceparent`, and set a total deadline of 2 s which it propagates as `X-Deadline-Ms`.
2. **Idempotency check.** `orders-api` looks up the key in a dedupe store (Redis or a unique-indexed table). A hit returns the stored response verbatim with `201` and the original body — a client retry after a network timeout must never create a second order.
3. **Synchronous reservation.** Two calls must be synchronous because the customer needs an immediate answer: `POST /v1/reservations` to inventory (deadline 400 ms, 1 retry, circuit-broken) and a pricing/validation call. Anything else — payment capture, warehouse allocation, email, loyalty, analytics — is deliberately kept off the critical path.
4. **Local transaction plus outbox.** In **one** Postgres transaction: insert the `orders` row with `status='pending'`, insert the reservation reference, and insert an `outbox` row containing the `order.placed` event with an `event_id`, aggregate id, and payload. Commit. There is now no window in which the order exists but the event does not.
5. **Respond immediately.** `201 Created` with `Location: /v1/orders/ord_9f2`, body `{"status":"pending"}`, and the idempotency key stored against the response. Total time ~180 ms. The customer sees a confirmation page that says "we are processing your payment".
6. **Relay publishes.** A separate relay (Debezium CDC on the outbox table, or a poller with `SELECT … FOR UPDATE SKIP LOCKED`) reads unpublished outbox rows and publishes to Kafka topic `orders.events`, partitioned by `order_id` so all events for one order are ordered. It marks rows published; a crash between publish and mark causes a duplicate, which is fine.
7. **Saga step 1 — payment.** The payments service consumes `order.placed`, checks its own dedupe table on `event_id`, calls the PSP with the order id as the idempotency key, and publishes `payment.captured` or `payment.failed`.
8. **Saga step 2 — fulfilment.** On `payment.captured`, fulfilment allocates a warehouse, publishes `shipment.created`; `orders-api` consumes it and moves the order to `confirmed`. Notifications consumes the same event and emails the customer. These consumers are independent: an email outage does not affect fulfilment.
9. **Compensation path.** If `payment.failed` arrives, the orchestrator (or the orders service acting as one) publishes `order.cancelled`, inventory consumes it and **releases the reservation**, and notifications emails an apology. Note that the compensation is semantic — the reservation is released, not "un-reserved" atomically — and it must be idempotent, because the event may be delivered twice.
10. **Poison messages.** A consumer that fails repeatedly on one message retries with backoff up to a limit, then routes the message to a **DLQ** with the failure reason and the original headers, so the partition is not blocked. A DLQ with a growing depth is a paging-worthy alert, because it means business transactions are silently stuck.
11. **Timeouts in the saga.** The orchestrator sets a deadline per step. If `payment.captured` has not arrived within, say, 10 minutes, a timer fires the compensation path — sagas need timeouts as much as HTTP calls do, and forgetting them leaves orders `pending` forever.
12. **Observability throughout.** `traceparent` is serialized into the Kafka message headers, so the trace spans HTTP *and* messaging; the consumer uses a **span link** rather than a parent-child relationship, because the consume may happen much later and may batch many producers.

```svg
<svg viewBox="0 0 790 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="790" height="420" fill="#ffffff"/>
  <text x="395" y="24" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">Sync critical path, then an outbox-driven saga with compensation</text>
  <rect x="16" y="52" width="86" height="52" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="59" y="74" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">client</text>
  <text x="59" y="92" text-anchor="middle" font-size="10" fill="#1e293b">Idempotency-Key</text>
  <rect x="130" y="52" width="150" height="120" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="205" y="74" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">orders-api</text>
  <text x="205" y="94" text-anchor="middle" font-size="10" fill="#1e293b">1 dedupe on key</text>
  <text x="205" y="111" text-anchor="middle" font-size="10" fill="#1e293b">2 reserve stock (sync)</text>
  <text x="205" y="128" text-anchor="middle" font-size="10" fill="#1e293b">3 ONE tx: order + outbox</text>
  <text x="205" y="145" text-anchor="middle" font-size="10" fill="#1e293b">4 return 201 pending</text>
  <text x="205" y="163" text-anchor="middle" font-size="10" fill="#16a34a">~180 ms total</text>
  <rect x="308" y="52" width="110" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="363" y="74" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">inventory</text>
  <text x="363" y="92" text-anchor="middle" font-size="10" fill="#1e293b">deadline 400ms</text>
  <rect x="130" y="192" width="150" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="205" y="212" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">outbox table</text>
  <text x="205" y="229" text-anchor="middle" font-size="10" fill="#1e293b">same tx as the order row</text>
  <rect x="308" y="192" width="110" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="363" y="212" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">relay (CDC)</text>
  <text x="363" y="229" text-anchor="middle" font-size="10" fill="#1e293b">at-least-once</text>
  <rect x="446" y="184" width="320" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="606" y="208" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">topic orders.events</text>
  <text x="606" y="228" text-anchor="middle" font-size="10" fill="#1e293b">partitioned by order_id (per-key ordering), traceparent in headers</text>
  <rect x="446" y="268" width="150" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="521" y="290" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">payments</text>
  <text x="521" y="308" text-anchor="middle" font-size="10" fill="#1e293b">dedupe on event_id</text>
  <rect x="616" y="268" width="150" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="691" y="290" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">fulfilment</text>
  <text x="691" y="308" text-anchor="middle" font-size="10" fill="#1e293b">allocate warehouse</text>
  <rect x="446" y="336" width="150" height="52" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="521" y="358" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">payment.failed</text>
  <text x="521" y="376" text-anchor="middle" font-size="10" fill="#1e293b">compensate</text>
  <rect x="616" y="336" width="150" height="52" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="691" y="358" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">release stock</text>
  <text x="691" y="376" text-anchor="middle" font-size="10" fill="#1e293b">idempotent C1</text>
  <rect x="16" y="268" width="380" height="120" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="30" y="292" font-size="12" font-weight="bold" fill="#1e293b">Why the outbox exists</text>
  <text x="30" y="314" font-size="11" fill="#1e293b">Naive: INSERT order; COMMIT; publish(event)</text>
  <text x="30" y="332" font-size="11" fill="#1e293b">Crash between the two &#8594; order exists, event never sent, saga never runs.</text>
  <text x="30" y="354" font-size="11" fill="#1e293b">Outbox: INSERT order + INSERT outbox in ONE tx; relay publishes later.</text>
  <text x="30" y="376" font-size="11" fill="#1e293b">Duplicate publish is fine because every consumer dedupes on event_id.</text>
  <line x1="102" y1="78" x2="128" y2="78" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="128,78 120,74 120,82" fill="#4f46e5"/>
  <line x1="280" y1="78" x2="306" y2="78" stroke="#0ea5e9" stroke-width="2"/>
  <polygon points="306,78 298,74 298,82" fill="#0ea5e9"/>
  <line x1="205" y1="172" x2="205" y2="190" stroke="#d97706" stroke-width="2"/>
  <polygon points="205,190 201,182 209,182" fill="#d97706"/>
  <line x1="280" y1="215" x2="306" y2="215" stroke="#d97706" stroke-width="2"/>
  <polygon points="306,215 298,211 298,219" fill="#d97706"/>
  <line x1="418" y1="215" x2="444" y2="215" stroke="#d97706" stroke-width="2"/>
  <polygon points="444,215 436,211 436,219" fill="#d97706"/>
  <line x1="521" y1="244" x2="521" y2="266" stroke="#16a34a" stroke-width="2"/>
  <polygon points="521,266 517,258 525,258" fill="#16a34a"/>
  <line x1="691" y1="244" x2="691" y2="266" stroke="#16a34a" stroke-width="2"/>
  <polygon points="691,266 687,258 695,258" fill="#16a34a"/>
  <line x1="521" y1="320" x2="521" y2="334" stroke="#dc2626" stroke-width="2"/>
  <polygon points="521,334 517,326 525,326" fill="#dc2626"/>
  <line x1="596" y1="362" x2="614" y2="362" stroke="#dc2626" stroke-width="2"/>
  <polygon points="614,362 606,358 606,366" fill="#dc2626"/>
</svg>
```

---

## 5. Implementation

### The synchronous call, done properly

```http
POST /v1/orders HTTP/1.1
Host: api.example.com
Content-Type: application/json
Idempotency-Key: 5f1c2c3e-6c1a-4f1f-9a2b-9e6d0a3f77c1
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
X-Deadline-Ms: 2000

{"cart_id":"crt_44a","payment_method":"pm_9k2"}
```
```http
HTTP/1.1 201 Created
Location: /v1/orders/ord_9f2
Content-Type: application/json
X-Request-Id: 01J8Z2K7QF3MB4X9VN7A0S2C6D

{
  "id": "ord_9f2",
  "status": "pending",
  "created_at": "2026-03-14T14:03:11Z",
  "links": { "self": "/v1/orders/ord_9f2", "events": "/v1/orders/ord_9f2/events" }
}
```

If the inventory reservation fails, the customer gets an immediate, actionable answer rather than a `pending` order that will be cancelled minutes later:

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{
  "type": "https://errors.example.com/insufficient-stock",
  "title": "Insufficient stock",
  "status": 409,
  "detail": "SKU WIDGET-9 has 1 unit available; 2 requested.",
  "instance": "/v1/orders",
  "sku": "WIDGET-9",
  "available": 1
}
```

And when a downstream dependency is circuit-broken, the honest answer is `503` with guidance, not a `500`:

```http
HTTP/1.1 503 Service Unavailable
Content-Type: application/problem+json
Retry-After: 5

{
  "type": "https://errors.example.com/dependency-unavailable",
  "title": "Temporarily unable to place orders",
  "status": 503,
  "detail": "The inventory service is not responding. Your card has not been charged.",
  "instance": "/v1/orders"
}
```

### Outbox write — one transaction, no dual write

```sql
CREATE TABLE outbox (
  id            BIGSERIAL PRIMARY KEY,
  event_id      UUID        NOT NULL UNIQUE,
  aggregate_id  TEXT        NOT NULL,
  event_type    TEXT        NOT NULL,
  payload       JSONB       NOT NULL,
  trace_parent  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_at  TIMESTAMPTZ
);
CREATE INDEX outbox_unpublished ON outbox (id) WHERE published_at IS NULL;
```

```python
async def place_order(conn, cart, key: str, traceparent: str) -> dict:
    async with conn.transaction():                       # ONE transaction
        existing = await conn.fetchrow(
            "SELECT response FROM idempotency WHERE key = $1", key)
        if existing:
            return existing["response"]                  # replay the original response verbatim

        order_id = new_id("ord")
        await conn.execute(
            "INSERT INTO orders (id, cart_id, status, total_cents) VALUES ($1,$2,'pending',$3)",
            order_id, cart.id, cart.total_cents)
        await conn.execute(
            """INSERT INTO outbox (event_id, aggregate_id, event_type, payload, trace_parent)
               VALUES ($1,$2,'order.placed',$3,$4)""",
            uuid4(), order_id,
            json.dumps({"order_id": order_id, "total_cents": cart.total_cents}), traceparent)
        response = {"id": order_id, "status": "pending"}
        await conn.execute(
            "INSERT INTO idempotency (key, response) VALUES ($1,$2)", key, json.dumps(response))
        return response
```

The relay, using `SKIP LOCKED` so many replicas can poll concurrently without contention:

```sql
WITH batch AS (
  SELECT id FROM outbox
  WHERE published_at IS NULL
  ORDER BY id
  LIMIT 200
  FOR UPDATE SKIP LOCKED
)
UPDATE outbox o SET published_at = now()
FROM batch b WHERE o.id = b.id
RETURNING o.event_id, o.aggregate_id, o.event_type, o.payload, o.trace_parent;
```

### The idempotent consumer

```python
async def handle_order_placed(conn, msg):
    event_id = msg.headers["event_id"]
    try:
        await conn.execute("INSERT INTO processed_events (event_id) VALUES ($1)", event_id)
    except UniqueViolation:
        return                                    # already handled; ack and move on

    order = json.loads(msg.value)
    # The PSP call is itself made idempotent by keying on the order id.
    result = await psp.charge(amount=order["total_cents"],
                              idempotency_key=f"charge:{order['order_id']}")
    topic = "payment.captured" if result.ok else "payment.failed"
    await publish(topic, {"order_id": order["order_id"], "charge_id": result.id},
                  headers={"event_id": str(uuid4()), "traceparent": msg.headers.get("traceparent")})
```

> **Note:** Deduplicating with an `INSERT` that hits a unique constraint is stronger than a `SELECT`-then-`INSERT` check, which has a race between the two statements. Insert first, catch the violation.

### Resilient HTTP client: timeout, retry budget, jitter, circuit breaker

```python
import asyncio, httpx, random, time

class Breaker:
    def __init__(self, threshold=0.5, window=20, cooldown=30.0):
        self.threshold, self.window, self.cooldown = threshold, window, cooldown
        self.results, self.opened_at = [], None

    def allow(self) -> bool:
        if self.opened_at is None:
            return True
        if time.monotonic() - self.opened_at > self.cooldown:
            self.opened_at = None                     # half-open: let one probe through
            self.results.clear()
            return True
        return False

    def record(self, ok: bool):
        self.results.append(ok)
        self.results = self.results[-self.window:]
        if len(self.results) >= self.window and self.results.count(False) / len(self.results) > self.threshold:
            self.opened_at = time.monotonic()

RETRYABLE = {408, 429, 500, 502, 503, 504}

async def call_inventory(client: httpx.AsyncClient, breaker: Breaker,
                         payload: dict, deadline_ms: int, attempts: int = 2):
    if not breaker.allow():
        raise DependencyOpen("inventory")             # fail fast, do not touch the network
    deadline = time.monotonic() + deadline_ms / 1000
    for attempt in range(attempts):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise DeadlineExceeded("inventory")
        try:
            r = await client.post("/v1/reservations", json=payload,
                                  timeout=remaining,
                                  headers={"Idempotency-Key": payload["reservation_id"]})
            if r.status_code in RETRYABLE and attempt < attempts - 1:
                raise Transient(r.status_code)
            breaker.record(r.is_success)
            r.raise_for_status()
            return r.json()
        except (Transient, httpx.TransportError, asyncio.TimeoutError):
            breaker.record(False)
            if attempt == attempts - 1:
                raise
            # Full jitter (AWS): sleep uniformly in [0, base * 2^attempt], capped.
            await asyncio.sleep(random.uniform(0, min(1.0, 0.05 * 2 ** attempt)))
```

Three deliberate details: the retry **reuses the same idempotency key** so a duplicate reservation is impossible; the per-attempt timeout is the **remaining** deadline, not a fresh full timeout (otherwise two retries silently triple the budget); and only `408`, `429`, and `5xx` are retried — retrying a `400` or `422` is pure waste and retrying a `409` can corrupt state.

### Kubernetes service discovery and a mesh-level policy

```yaml
apiVersion: v1
kind: Service
metadata: { name: inventory }
spec:
  selector: { app: inventory }
  ports: [{ port: 8080, targetPort: 8080 }]
# Resolvable as http://inventory.default.svc.cluster.local:8080 — DNS is the discovery mechanism.
---
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata: { name: inventory }
spec:
  host: inventory
  trafficPolicy:
    connectionPool:
      tcp:  { maxConnections: 200, connectTimeout: 200ms }
      http: { http2MaxRequests: 400, maxRequestsPerConnection: 0, http1MaxPendingRequests: 50 }
    outlierDetection:
      consecutive5xxErrors: 5
      interval: 10s
      baseEjectionTime: 30s
      maxEjectionPercent: 50
```

**Optimization note.** The dominant costs in service-to-service communication are connection setup and serialization, not routing. Reuse connections with HTTP/2 or gRPC multiplexing (one warm connection carrying many concurrent streams beats a pool of HTTP/1.1 sockets); size pools per dependency as a bulkhead rather than sharing one global pool; and prefer a compact binary encoding (protobuf) over JSON on the hottest internal paths, where it typically cuts payload size 40–60% and CPU more than that. The largest single win, though, is architectural: **remove hops from the critical path**. Moving payment capture off the synchronous checkout path took our example from a five-hop, 900 ms, `0.999^5` interaction to a two-hop, 180 ms one — no amount of protocol tuning matches that.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Synchronous request/response | Simple mental model, immediate answer, easy debugging | Temporal coupling; availability multiplies as `p^n`; latency sums along the chain |
| Asynchronous messaging | Removes temporal coupling; absorbs bursts; independent scaling and failure domains | Eventual consistency; duplicates and reordering; debugging needs real tracing |
| Orchestration (central saga) | State is explicit and queryable; easy to visualise, test, and recover | The orchestrator becomes a coupling point and a component that must itself be HA |
| Choreography (event reactions) | Maximum decoupling; adding a consumer needs no change to producers | No single place shows the workflow; cycles and hidden ordering bugs are easy to create |
| Saga with compensation | Business-level atomicity without distributed locks or 2PC | No isolation — intermediate states are visible; compensations are semantic and can fail |
| Transactional outbox | Eliminates the dual-write problem completely | Extra table, a relay to run, and at-least-once publishing that consumers must dedupe |
| Circuit breakers + bulkheads | Contain failure; fail fast; let a sick dependency recover | Tuning is empirical; too sensitive and you shed healthy traffic |
| Retries | Convert transient blips into successes invisibly | Amplify load and cause metastable failures unless budgeted, jittered, and single-layer |
| Service mesh | Uniform mTLS, retries, timeouts, and telemetry without app changes | A second data plane to operate; sidecar CPU/memory and latency overhead; steep debugging curve |
| gRPC internal / REST external | Efficient, typed, streaming-capable internally; approachable externally | Two interface styles to maintain, plus schema tooling and a gateway to translate |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **The distributed monolith.** Services that must be deployed together, share a database, and call each other synchronously in a deep chain — all the operational cost of microservices, none of the independence. → ✅ Boundaries follow business capabilities; every service owns its data exclusively; if two services must ship together, merge them.
2. ⚠️ **Shared database between services.** Team B's schema migration breaks team A at 2 a.m. → ✅ Database per service; expose data through APIs or events; if reads need to be joined, build a read model fed by events.
3. ⚠️ **No timeout, or a default of 60 seconds.** One slow dependency exhausts every thread and the caller dies of a problem it did not have. → ✅ Explicit, short, per-call timeouts derived from a propagated deadline; the per-attempt timeout must consume the *remaining* budget, not a fresh one.
4. ⚠️ **Retrying non-idempotent operations.** A `POST /payments` times out after the charge succeeded; the retry charges again. → ✅ Retry only safe methods, or unsafe ones carrying an `Idempotency-Key` that the server deduplicates — and reuse the *same* key on every retry.
5. ⚠️ **Retries at every layer.** Client 3× × gateway 3× × service 3× = 27× amplification and a metastable outage. → ✅ Retry at exactly one layer, enforce a retry budget (~10% of traffic), use full jitter, and never retry non-retryable `4xx`.
6. ⚠️ **Dual write: commit then publish.** A crash between the two silently desynchronises the database and the event log forever. → ✅ Transactional outbox, or change-data-capture. Never `commit()` then `publish()`.
7. ⚠️ **Consumers that assume exactly-once delivery.** A duplicated `payment.captured` credits the customer twice. → ✅ Every consumer deduplicates on `event_id` (insert-and-catch-unique, not select-then-insert) or is naturally idempotent.
8. ⚠️ **Ignoring ordering.** Events for the same aggregate land on different partitions and `order.cancelled` is processed before `order.placed`. → ✅ Partition by aggregate key for per-key ordering, and make handlers tolerant of out-of-order arrival using version numbers or state guards.
9. ⚠️ **Sagas with no timeout.** A step never completes and the business transaction sits `pending` forever with inventory locked. → ✅ Every saga step gets a deadline and a timer that triggers compensation; alert on sagas older than the expected duration.
10. ⚠️ **Compensations that are not idempotent or retriable.** The release-stock compensation runs twice and returns stock that was legitimately re-sold. → ✅ Design compensations as idempotent state transitions guarded by the saga step id, and test them explicitly.
11. ⚠️ **Assuming saga isolation.** Another request reads the order while it is mid-saga and shows the customer a state that will be rolled back. → ✅ Use semantic locks (`status: pending`, `available_balance` vs `ledger_balance`) and never expose intermediate state as final.
12. ⚠️ **No dead-letter queue, or a DLQ nobody watches.** A poison message blocks a partition, or silently swallows real business transactions. → ✅ DLQ with the original headers and failure reason, an alert on non-zero depth, and a documented, tested replay procedure.
13. ⚠️ **Chatty inter-service calls (N+1 over the network).** A list endpoint calls a peer once per row. → ✅ Batch endpoints, or a locally maintained read model built from events; measure the fan-out ratio per request and alert when it grows.
14. ⚠️ **Losing trace context at the async boundary.** The trace stops at the publish and nobody can follow the saga. → ✅ Serialize `traceparent` into message headers and use **span links** on the consumer side.
15. ⚠️ **Unbounded queues instead of backpressure.** Latency grows without bound and the system collapses instead of degrading. → ✅ Bounded queues, load shedding with `503` + `Retry-After`, and admission control keyed on concurrency limits.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Distributed tracing is not optional here — it is the only thing that shows a request crossing HTTP and messaging boundaries in one causal view. Propagate `traceparent` over HTTP *and* in message headers, and use span links for the consume side. Beyond tracing, the two highest-value artefacts are the **saga state table** (a queryable row per business transaction with its current step, timestamps, and next deadline — when a customer says "my order is stuck", you answer in seconds) and **structured logs with a correlation ID plus the aggregate id**. When a call fails, the diagnostic question is always the same: did the request never arrive, arrive and fail, or succeed with a lost response? Idempotency keys plus request IDs on both sides are what let you answer it. For messaging, keep tooling to inspect consumer lag, peek at a partition, and replay a DLQ message into a staging consumer.

**Monitoring.** Per dependency, per caller: request rate, error rate split by `5xx` versus timeout versus circuit-open, latency percentiles, and **retry rate** (a rising retry rate is the earliest warning of a dependency degrading). Circuit-breaker state transitions should be events on your dashboard, not just a gauge. For messaging: **consumer lag** per partition (the single most important async metric — lag growth means you are falling behind reality), publish and consume rates, DLQ depth, redelivery counts, and end-to-end event age (`now - event.created_at`) which captures whole-pipeline health that per-hop metrics miss. For sagas: count by state, and alert on any saga exceeding its expected duration. Saturation matters as much as latency — connection-pool utilisation, pending-request queue depth, and in-flight request counts lead latency by minutes and give you time to act.

**Security.** Inside the cluster, the perimeter is gone, so use **workload identity**: mTLS between services (SPIFFE/SPIRE identities, or a mesh that issues certificates automatically) so a service authenticates *who* is calling, not just that the call came from inside. Never let a service trust a plain `X-User-Id` header — propagate a signed internal assertion (short-lived JWT from token exchange at the edge) and verify it in every service, and re-check object-level authorization locally because the caller service may be compromised or buggy. Apply least privilege to messaging too: topic-level ACLs so `notifications` can read `orders.events` but not write them. Encrypt PII in event payloads or keep it out entirely (publish IDs and let consumers fetch), because an event log is a long-retention copy of your data that is easy to forget during a GDPR erasure. And apply network policies so a compromised pod cannot reach arbitrary services — flat internal networks turn one bug into full lateral movement.

**Performance & scaling.** Scale consumers by partition count, and remember that partitions are the ceiling: with 12 partitions you cannot usefully run more than 12 consumers in a group, so choose partition counts with headroom because increasing them later breaks key-based ordering guarantees for in-flight keys. Prefer **asynchronous** for anything that does not need an immediate answer, since it converts a hard availability dependency into a queue that absorbs bursts. Watch out for coordinated-load patterns — cron jobs on the hour, retry storms after a partial outage — and add jitter. For the synchronous parts, cache aggressively at the caller (a locally maintained read model beats a cross-service call), batch where the semantics allow, and enforce concurrency limits per dependency so a slow upstream causes shedding rather than a thread-pool collapse. Finally, do capacity planning on *end-to-end* budgets: give the whole checkout 2 s, allocate it explicitly across hops, and treat any service that wants more than its slice as a design conversation rather than a config change.

---

## 9. Interview Questions

**Q: When should a service-to-service call be synchronous versus asynchronous?**
A: Synchronous when the caller genuinely cannot proceed without the answer and the user is waiting — validating a cart, reserving stock, authenticating. Asynchronous for everything else: notifications, analytics, downstream projections, and any work that is allowed to complete seconds or minutes later. The test is whether a failure of the callee should also fail the caller; if not, make it asynchronous and remove the temporal coupling.

**Q: Why does availability degrade as you add synchronous hops?**
A: Because independent failures compose multiplicatively: end-to-end availability is roughly `p^n` for *n* hops each available with probability *p*. Four hops at 99.9% gives 99.6%, which is nearly three hours of monthly downtime instead of 43 minutes. The fix is fewer synchronous hops or a fallback that lets the caller succeed without the callee — chasing more nines per service has sharply diminishing returns.

**Q: What is the dual-write problem and how do you solve it?**
A: A service writes to its database and then publishes an event; if the process dies in between, the two permanently disagree and nothing detects it. The solution is the transactional outbox: insert the event into an `outbox` table inside the same local transaction as the state change, then have a separate relay (poller or CDC) publish from that table. The relay may publish duplicates, which is safe because consumers deduplicate.

**Q: Is exactly-once delivery possible?**
A: Not over an unreliable network — you can have at-most-once or at-least-once, and the Two Generals result rules out the rest. What you can achieve is effectively-once *processing*: at-least-once delivery plus an idempotent consumer that deduplicates on a message or business key, or an operation that is naturally idempotent. Any consumer design that assumes no duplicates is a bug waiting for a redelivery.

**Q: Explain the saga pattern and its main limitation.**
A: A saga models a business transaction as a series of local ACID transactions across services, each with a compensating action that semantically undoes it. If step 3 fails, run the compensations for steps 2 and 1. The main limitation is that sagas give atomicity but **not isolation** — intermediate states are visible to other readers — so you need semantic locks like a `pending` status, and compensations are semantic rather than exact (you cannot un-send an email).

**Q: Orchestration or choreography?**
A: Orchestration puts the workflow in one coordinator, which makes state explicit, queryable, and testable, at the cost of a component everyone depends on. Choreography has services react to each other's events, which is maximally decoupled but leaves the workflow implicit and hard to debug. A common pragmatic rule: orchestrate flows with money, compensations, or compliance requirements; choreograph fan-out notifications and projections.

**Q: How does a circuit breaker work and what problem does it solve?**
A: It counts failures over a rolling window; when the failure ratio exceeds a threshold it opens and fails calls immediately without touching the network, then after a cool-down goes half-open and admits probe traffic, closing on success. It solves two problems at once — the caller stops burning its latency budget and threads on doomed calls, and the failing dependency gets breathing room to recover instead of being hammered while restarting.

**Q: (Senior) A `POST /payments` times out. What are the possible states and how do you handle them?**
A: Three states are indistinguishable from the caller: the request never arrived, it arrived and failed, or it succeeded and the response was lost. Since you cannot tell, the design must make the ambiguity harmless — send an `Idempotency-Key`, retry with the *same* key, and require the server to store the original response keyed by that key and replay it. Complement this with a reconciliation job that queries the provider for the transaction by your key, and record the attempt before making the call so an orphaned charge can always be found and refunded.

**Q: (Senior) Design the order flow for a retailer where inventory, payment, shipping, and notifications are separate services. Walk through the failure modes.**
A: Keep the critical path minimal and synchronous: validate the cart and reserve inventory, then write the order plus an `order.placed` outbox row in one transaction and return `201 pending` in under 200 ms. Everything downstream runs as a saga over events: payments captures with the order id as idempotency key; on success fulfilment allocates and the order becomes `confirmed`; on failure the compensation releases the reservation and notifies the customer. Failure modes to name: duplicate delivery (dedupe on `event_id`), lost publish (outbox), stuck sagas (per-step deadlines and timers driving compensation), poison messages (DLQ with alerting and a replay path), out-of-order events (partition by `order_id` and guard on state), reservation expiry racing the payment (TTL on the reservation longer than the payment deadline), and visible intermediate state (semantic lock via `pending`, never show the customer a confirmed order until the saga completes).

**Q: (Senior) Explain metastable failure and how you would prevent it.**
A: A metastable failure is one that persists after its trigger is gone, because the system's own recovery behaviour generates the load that keeps it down — typically retry amplification. A brief backend blip causes retries across three layers, the retries triple or 27× the load, the backend cannot recover under that load, and it never returns even though nothing is originally wrong any more. Prevention: retry at exactly one layer with a global retry budget, full jitter on backoff, circuit breakers to cut traffic during the failure, load shedding with `503` + `Retry-After` so intake is bounded, and deadline propagation so doomed work is cancelled rather than completed at cost. Recovery, once in the state, usually requires reducing load externally — shedding aggressively or draining queues — because the system cannot climb out on its own.

**Q: How does service discovery work in Kubernetes versus a client-side discovery system?**
A: Kubernetes uses server-side discovery: a `Service` gives a stable DNS name and virtual IP, kube-proxy or the mesh load-balances across the healthy pods in the `Endpoints` set, and the caller just resolves a name. Client-side discovery (Eureka, Consul with a smart client) has the caller fetch the instance list from a registry and choose an instance itself, which allows richer load-balancing policy at the cost of a library in every language you use. Meshes blend the two by pushing endpoint data to a local sidecar via xDS, giving client-side flexibility without in-process libraries.

**Q: When do you *not* want microservices?**
A: When the team is small enough that coordination is not the bottleneck, when the domain boundaries are not yet understood (splitting wrong is far more expensive than splitting late), when the workload does not need independent scaling, or when you cannot yet afford the operational baseline — CI/CD per service, distributed tracing, centralised logging, service discovery, on-call. A well-modularised monolith with clear internal boundaries gives most of the design benefits and none of the network failure modes, and it is the right starting point for most products.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Every inter-service call is a network call, so availability multiplies (`p^n`) and latency adds. Keep the **synchronous** critical path short — only calls the user must wait for — and push everything else **asynchronous**. Guard every sync call with an explicit **timeout derived from a propagated deadline**, retries **only** for `408`/`429`/`5xx` with **full jitter**, a **retry budget**, retries at exactly **one** layer, and a **circuit breaker** plus a **bulkheaded** connection pool per dependency. Never `commit()` then `publish()` — use the **transactional outbox** so state and events cannot diverge. Delivery is **at-least-once**, so every consumer **deduplicates on `event_id`** (insert-and-catch-unique) and every unsafe endpoint honours an **`Idempotency-Key`**, reused across retries. Model multi-service business transactions as **sagas** with idempotent, retriable **compensations**, per-step **deadlines**, and semantic locks (`status: pending`) because sagas give atomicity but not isolation. Partition by aggregate key for ordering, run a **DLQ** with alerting, and propagate `traceparent` into message headers using **span links** on the consumer.

| Concern | Default | Notes |
|---|---|---|
| Sync timeout | 200–500 ms per internal hop | Derived from the total deadline; per-attempt uses the *remaining* budget |
| Retries | 1–2, only `408`/`429`/`5xx` | Full jitter `random(0, min(cap, base·2^n))`; one layer only |
| Retry budget | ≤ 10% of request volume | Prevents metastable amplification |
| Circuit breaker | 50% failures over 20 reqs, 30 s cool-down | States: closed → open → half-open |
| Idempotency | `Idempotency-Key` on all unsafe endpoints | Store and replay the original response |
| Event dedupe | Unique index on `event_id` | Insert-and-catch, never select-then-insert |
| Ordering | Partition by aggregate id | Guard handlers with version/state checks |
| Saga step | Explicit deadline + timer | Fire compensation on expiry; alert on stuck sagas |
| Overload | `503` + `Retry-After`, `429` for quota | Shed early; bounded queues, never unbounded |
| Status codes | `201` create · `202` accepted-async · `409` conflict · `503` dependency down | `202` + `Location` for a status resource is the async idiom |

Flash cards:
- **Why is `p^n` the key number?** → Synchronous chains multiply availability; four 99.9% hops give 99.6%.
- **Fix for the dual-write problem?** → Transactional outbox: state change and event in one local transaction, relay publishes later.
- **Is exactly-once delivery achievable?** → No. At-least-once delivery plus idempotent consumers gives effectively-once *processing*.
- **What do sagas give up compared with ACID?** → Isolation — intermediate states are visible, so use semantic locks like `status: pending`.
- **Why does retrying at every layer cause outages?** → Multiplicative amplification (3×3×3 = 27×) creates metastable failure that outlives its trigger.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Implement the transactional outbox with a `SKIP LOCKED` relay, then kill the process between commit and publish and prove no event is lost.
- [ ] Write an idempotent consumer using a unique index on `event_id`, then deliver the same message five times and assert exactly one side effect.
- [ ] Build a circuit breaker with closed/open/half-open states, drive a dependency to 100% failure, and chart caller latency with and without the breaker.
- [ ] Implement deadline propagation across three services and prove that the innermost call is cancelled when the client's budget expires rather than completing wastefully.
- [ ] Implement a saga with one compensating action, force a failure at the last step, and verify the compensation is idempotent by running it twice.

**Mini Project — "Meridian" order saga.**
*Goal:* A four-service order system that survives every failure mode discussed in this chapter.
*Requirements:* `orders`, `inventory`, `payments`, and `notifications` services with separate databases and Kafka (or Redpanda) between them; synchronous reservation on the critical path with a deadline, one retry, and a circuit breaker; order plus `order.placed` written in one transaction via an outbox with a CDC or polling relay; idempotency keys on all unsafe endpoints with stored-response replay; idempotent consumers deduplicating on `event_id`; a saga that drives `pending → confirmed` with a compensating release-stock path on `payment.failed`; per-step deadlines with a timer that compensates stuck sagas; a DLQ with an alert on depth and a documented replay command; `traceparent` propagated over HTTP and in message headers with span links on consumers; a queryable saga state table.
*Extension ideas:* Add a chaos test that randomly duplicates, delays, drops, and reorders messages, and assert business invariants still hold; add load shedding with `503` + `Retry-After` and demonstrate graceful degradation instead of collapse under 5× load; replace one JSON internal call with gRPC and measure the latency and payload difference; build an event-sourced read model in `orders` so it never has to call `inventory` synchronously for display data.

---

## 12. Related Topics & Free Learning Resources

Sibling chapters: **API Gateways & the BFF Pattern** (north-south edge policy and composition), **API Observability: Logs, Metrics & Tracing** (the tracing that makes async debuggable), **Idempotency & Retries** (the mechanics of safe retry), **Webhooks & Event-Driven APIs** (publishing events outside your boundary), **Monitoring, SLOs & Incident Response** (error budgets across a distributed call graph), and **Deploying APIs: CI/CD, Blue-Green & Canary** (shipping many services independently).

**Free Learning Resources**
- **Microservices Patterns catalogue** — Chris Richardson · *Intermediate→Advanced* · the canonical reference for saga, outbox, API composition, CQRS, and circuit breaker, each with trade-offs. <https://microservices.io/patterns/index.html>
- **Microservices** — James Lewis & Martin Fowler · *Intermediate* · the article that defined the term, including "smart endpoints, dumb pipes" and decentralised data management. <https://martinfowler.com/articles/microservices.html>
- **Sagas** — Garcia-Molina & Salem (1987) · *Advanced* · the original paper introducing compensating transactions for long-lived business processes. <https://www.cs.cornell.edu/andru/cs711/2002fa/reading/sagas.pdf>
- **Google SRE Book — Addressing Cascading Failures** — Google · *Advanced* · retry amplification, load shedding, and why systems stay down after the cause is gone. <https://sre.google/sre-book/addressing-cascading-failures/>
- **Timeouts, Retries and Backoff with Jitter** — Amazon Builders' Library · *Intermediate* · the practical case for full jitter, retry budgets, and bounded work. <https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/>
- **Implementing Health Checks / Avoiding Fallback in Distributed Systems** — Amazon Builders' Library · *Intermediate* · hard-won guidance on dependency health and why naive fallbacks make outages worse. <https://aws.amazon.com/builders-library/implementing-health-checks/>
- **CircuitBreaker** — Martin Fowler · *Beginner→Intermediate* · a short, clear explanation of the state machine and its tuning parameters. <https://martinfowler.com/bliki/CircuitBreaker.html>
- **Debezium Documentation — Outbox Event Router** — Red Hat / Debezium · *Intermediate* · change-data-capture as a production-grade outbox relay, with concrete configuration. <https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html>

---

*REST API Handbook — chapter 40.*
