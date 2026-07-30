# 21 · Idempotency, Deduplication & the Outbox Pattern

> **In one line:** At-least-once is the delivery guarantee you actually get, so the only way to make a system behave *as if* it were exactly-once is to make the consumer idempotent — deduplicate on a stable key — and to make the *publish itself* trustworthy by writing the message in the same transaction as the data change, which is exactly what the outbox pattern does.

---

## 1. Overview

Chapter 4 established the uncomfortable truth: in any real broker, across crashes, retries and rebalances, the practical delivery guarantee is **at-least-once**. A message you sent once may be delivered twice, five times, or a hundred times, because the acknowledgement that would have marked it "done" can be lost after the work was performed. There is no cheap escape from this. "Exactly-once delivery" over a network is, in the general case, impossible — the two-generals problem in a work shirt. What you *can* build is a system whose observable *effect* is exactly-once even though its *delivery* is at-least-once. That is what this chapter is about, and it rests on a single discipline: **idempotency**.

An operation is idempotent if performing it twice has the same effect as performing it once. If your consumer's handler is idempotent, then a duplicate delivery is harmless — it re-does something already done, changes nothing, and the system converges to the correct state regardless of how many times the broker redelivered. This turns at-least-once from a liability into a nuisance you have already paid for. Some operations are *naturally* idempotent (setting a value, deleting by id). Most business operations are not — "charge the card", "increment the balance", "send the email" all cause a fresh effect every time they run — and must be *made* idempotent, usually by remembering which messages you have already processed in a **deduplication store**, sometimes called the **inbox** pattern.

But idempotent consumers only fix half the problem, and it is the *downstream* half. There is a subtler, upstream failure that idempotency cannot touch: the **dual-write problem**. When a service handles a request it typically does two things — it changes its database, and it publishes a message so other services learn about the change. These are two separate systems with two separate commits, and there is no transaction that spans a database and a message broker. So a crash in the gap between them leaves you inconsistent: the database committed but the message was never sent (downstream never learns), or the message was sent but the database rolled back (downstream acts on a change that did not happen). No amount of consumer-side dedup helps, because the message either does not exist or lies. The fix is the **transactional outbox**: write the domain change *and* an "outbox" row describing the message in **one** database transaction, then let a separate relay process read committed outbox rows and publish them. Now the message is published **if and only if** the data change committed, because they succeed or fail together. Combine an outbox (trustworthy publish) with an idempotent consumer (harmless duplicates) and you have **effective exactly-once** end to end — the closest thing to the guarantee that does not actually exist.

## 2. Core Concepts

- **Idempotent operation** — an operation whose repetition has no additional effect: `f(f(x)) = f(x)`. Applying it once or ten times yields the same state.
- **Naturally idempotent** — operations that are idempotent by their nature: `SET balance = 100`, `DELETE WHERE id = 42`, upsert-by-key. Repeats are inherently safe.
- **Made idempotent** — an operation that is not naturally idempotent (charge, increment, append, send) wrapped so repeats are suppressed, typically via a dedup store.
- **Deduplication key** — the stable identifier used to recognise a message already processed: a producer-assigned message id, or a business key (order id + event type). Must be stable across redeliveries.
- **Dedup store / inbox** — a durable table of processed message ids (with a TTL), checked before doing work and written after, so a redelivery is recognised and skipped. The consumer-side mirror of the outbox.
- **Idempotency key** — the client/HTTP term for the same idea: a caller-supplied key on a request so a retried POST does not create two orders. Same mechanism, request-layer.
- **Dual-write problem** — the inconsistency that arises when a service must update its database *and* publish a message as two separate, non-atomic operations that can partially fail.
- **Transactional outbox** — writing the domain change and a message row in a single local DB transaction, so the intent-to-publish commits atomically with the data.
- **Relay / message relay** — the process that reads committed outbox rows and publishes them to the broker, then marks them sent. Can poll or use CDC.
- **CDC (Change Data Capture)** — reading a database's commit log (e.g. Postgres WAL, MySQL binlog) to stream row changes; Debezium tails the outbox table and publishes each new row with no polling.
- **Exactly-once processing** — the *effect* of processing each message exactly once, achieved with idempotency + dedup, as opposed to the impossible "exactly-once delivery".
- **Idempotent producer (Kafka)** — `enable.idempotence=true`: the broker dedupes producer retries within a session using a producer id + sequence number, so a retried batch is not appended twice. A narrower guarantee than end-to-end idempotency (chapter 4).

## 3. Theory & Principles

### Why at-least-once forces idempotency

Recall the acknowledgement dance from chapter 1: to avoid *losing* a message, a consumer acknowledges only *after* it has processed it. That single choice is what makes duplicates inevitable. Picture a consumer that reads message `M`, performs the side effect (charges a card), and then — before its acknowledgement reaches the broker — crashes, or the network drops the ack, or a Kafka rebalance revokes the partition. The broker never heard "done", so by its contract it must redeliver `M`. The next consumer reads `M` and charges the card *again*. The work happened twice; the guarantee held (at-least-once); the customer is furious.

You cannot fix this by acking *before* processing — that is at-most-once and loses the message on any crash during processing, which is worse. You cannot fix it with a cleverer broker, because the fundamental problem is that "I did the work" and "I recorded that I did the work" are two events with a gap between them, and a crash can land in that gap. This is not a Kafka bug or a RabbitMQ bug; it is a property of distributed systems. **The only durable answer is to make the second delivery a no-op** — to make the handler idempotent — so that whether `M` is delivered once or twenty times, the card is charged once.

### The two families of idempotency

There are exactly two ways to get there, and knowing which one applies saves enormous effort.

**Naturally idempotent operations** need nothing extra. If processing `M` means "set the user's status to ACTIVE" or "store this document under key `k`" or "delete order 42", then re-running it changes nothing — the state is already ACTIVE, the document is already stored, the order is already gone. Absolute, blind upserts keyed by a stable id are the workhorse here: `INSERT ... ON CONFLICT (id) DO UPDATE` reaches the same final state no matter how many times it runs. Whenever you can *express the effect as a state you converge to* rather than *a delta you apply*, you get idempotency for free, and you should reach for this first. It is far cheaper than a dedup store.

**Made-idempotent operations** are everything else: charge, increment, append to a list, send an email, call a non-idempotent external API. Their effect is a *delta*, so repeating them repeats the delta. The fix is to remember, durably, that message `M` was already processed, and to check that memory *before* doing the work. That memory is the **dedup store / inbox**: a table keyed by the message's deduplication key. The consumer's shape becomes: begin a transaction, attempt to record the dedup key, if it already exists roll back and skip (it is a duplicate), otherwise do the work and commit the dedup key *in the same transaction* as the work. The atomicity of that last step is the whole game — if the dedup key and the effect commit together, a redelivery finds the key and skips, and a crash before commit leaves neither, so the redelivery safely re-does the work.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">A duplicate delivery: without dedup vs with dedup</text>

  <rect x="24" y="42" width="410" height="190" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Non-idempotent handler: double effect</text>
  <rect x="44" y="82" width="70" height="28" rx="5" fill="#fff" stroke="#fca5a5"/><text x="79" y="100" text-anchor="middle" fill="#7f1d1d" font-size="9">deliver M</text>
  <path d="M116,96 L156,96" stroke="#dc2626" stroke-width="2" marker-end="url(#a1)"/>
  <rect x="158" y="82" width="90" height="28" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="203" y="100" text-anchor="middle" fill="#7f1d1d" font-size="9">charge card</text>
  <path d="M250,96 L290,96" stroke="#dc2626" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#a1)"/>
  <text x="330" y="92" text-anchor="middle" fill="#b91c1c" font-size="9">ack LOST / crash</text>
  <text x="330" y="104" text-anchor="middle" fill="#b91c1c" font-size="9">before ack</text>
  <rect x="44" y="134" width="70" height="28" rx="5" fill="#fff" stroke="#fca5a5"/><text x="79" y="152" text-anchor="middle" fill="#7f1d1d" font-size="9">redeliver M</text>
  <path d="M116,148 L156,148" stroke="#dc2626" stroke-width="2" marker-end="url(#a1)"/>
  <rect x="158" y="134" width="90" height="28" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="203" y="152" text-anchor="middle" fill="#7f1d1d" font-size="9">charge AGAIN</text>
  <text x="44" y="188" fill="#991b1b" font-size="10" font-weight="bold">Result: card charged TWICE</text>
  <text x="44" y="208" fill="#991b1b" font-size="10">at-least-once held; the effect did not converge</text>

  <rect x="446" y="42" width="410" height="190" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Dedup store (inbox): second delivery is a no-op</text>
  <rect x="466" y="82" width="70" height="28" rx="5" fill="#fff" stroke="#86efac"/><text x="501" y="100" text-anchor="middle" fill="#14532d" font-size="9">deliver M</text>
  <path d="M538,96 L578,96" stroke="#16a34a" stroke-width="2" marker-end="url(#a2)"/>
  <rect x="580" y="76" width="120" height="40" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="640" y="92" text-anchor="middle" fill="#14532d" font-size="9">key M new?</text><text x="640" y="106" text-anchor="middle" fill="#166534" font-size="9">yes &#8594; charge + save key</text>
  <rect x="466" y="134" width="70" height="28" rx="5" fill="#fff" stroke="#86efac"/><text x="501" y="152" text-anchor="middle" fill="#14532d" font-size="9">redeliver M</text>
  <path d="M538,148 L578,148" stroke="#16a34a" stroke-width="2" marker-end="url(#a2)"/>
  <rect x="580" y="128" width="120" height="40" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="640" y="144" text-anchor="middle" fill="#14532d" font-size="9">key M seen?</text><text x="640" y="158" text-anchor="middle" fill="#166534" font-size="9">yes &#8594; SKIP</text>
  <text x="466" y="188" fill="#166534" font-size="10" font-weight="bold">Result: card charged ONCE</text>
  <text x="466" y="208" fill="#166534" font-size="10">key + effect commit together &#8594; effect converges</text>

  <rect x="24" y="248" width="832" height="204" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="270" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The two families of idempotency &#8212; reach for the first before the second</text>
  <rect x="48" y="286" width="380" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="238" y="308" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Naturally idempotent (free)</text>
  <text x="66" y="328" fill="#166534" font-size="10">SET status=ACTIVE &#183; DELETE id=42</text>
  <text x="66" y="344" fill="#166534" font-size="10">INSERT ... ON CONFLICT DO UPDATE (upsert)</text>
  <rect x="452" y="286" width="380" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="642" y="308" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">Made idempotent (dedup store)</text>
  <text x="470" y="328" fill="#b45309" font-size="10">charge &#183; increment &#183; append &#183; send email</text>
  <text x="470" y="344" fill="#b45309" font-size="10">wrap: check dedup key &#8594; do work + save key (one txn)</text>
  <text x="48" y="380" fill="#475569" font-size="10" font-weight="bold">Rule of thumb: express the effect as a STATE you converge to, not a DELTA you apply, and idempotency is free.</text>
  <text x="48" y="402" fill="#475569" font-size="10">When you cannot (money, external side effects), the dedup key + a durable store is the mechanism.</text>
  <text x="48" y="424" fill="#475569" font-size="10">The dedup key must be STABLE across redeliveries &#8212; a producer message id or a business key, never a per-delivery random id.</text>
  <text x="48" y="444" fill="#334155" font-size="10" font-weight="bold">Atomicity of "save key + do work" is the whole game. If they commit together, duplicates are harmless.</text>
</svg>
```

### Choosing the deduplication key

The dedup key must be **stable across redeliveries of the same logical message** and **distinct across different logical messages**. Get this wrong and you either fail to deduplicate (the key changes on redelivery) or deduplicate too aggressively (two genuinely different messages share a key, and you silently drop the second). Two good sources:

- **A producer-assigned message id.** The producer generates a UUID (or a monotonic id) once, stamps it into a header, and never changes it on retry. This is the cleanest key because it is opaque and guaranteed unique. Kafka's record has no built-in message id, so you put it in a header; RabbitMQ has a standard `message_id` property (and a `correlation_id`) exactly for this.
- **A business/natural key.** `(order_id, "OrderPlaced")` or `(payment_id, version)`. This ties dedup to domain meaning and is robust even if the message is *republished* by a different producer, but you must ensure the tuple is genuinely unique per logical event.

The store needs a **TTL**. You cannot keep every processed id forever, so you keep them long enough to cover the maximum plausible redelivery window — how long could a broker hold and redeliver a message? For Kafka this is bounded by retention; for RabbitMQ by how long a message might sit unacked and get requeued. A common choice is hours to a few days. The subtle risk is a redelivery arriving *after* the key's TTL expired, which would then be reprocessed as new — so size the TTL against your worst-case redelivery latency, not your average.

## 4. Architecture & Workflow

### The dual-write problem, precisely

Here is the exact sequence that idempotency cannot save you from, because the fault is upstream of any consumer.

A service receives "place order 42". It must (a) insert the order row into its database and (b) publish an `OrderPlaced` event so the shipping, email and analytics services react. These are two writes to two different systems — a database and a broker — and there is no distributed transaction between them (and you do not want one; XA/2PC is slow, fragile, and often unsupported by the broker). So you write them in sequence, and every ordering has a failure:

- **DB first, then publish.** The DB commits, then the process crashes before the publish. The order exists but *no event was ever sent*. Shipping never ships. The database and the rest of the world silently disagree, forever, with no error anywhere.
- **Publish first, then DB.** The event is sent, then the DB write fails or rolls back. Shipping ships an order that *does not exist* in the source of truth. You have emitted a lie.

You cannot close this gap by being careful, because the gap is a crash window and crashes are not careful. You cannot close it with retries alone, because a retry of the publish after a DB commit is fine, but a retry has no way to know whether the *first* attempt already sent. This is the dual-write problem, and it is one of the most common silent data-integrity bugs in event-driven systems.

### The outbox pattern

The insight is to stop writing to two systems in the request path. Instead, write to **one** system — your database — twice, in the same local transaction:

1. Insert the order row.
2. Insert a row into an `outbox` table describing the message to be published (topic/exchange, key, headers, payload, a unique id).

Both inserts are in **one** database transaction, so they commit or roll back together. There is no partial state: either the order and its outbox row both exist, or neither does. The dual-write is gone because there is now only a *single* write.

A separate **relay** process then reads unpublished outbox rows, publishes each to the broker, and marks it sent. Because the relay only ever sees *committed* outbox rows, it publishes a message **if and only if** the order committed. If the relay crashes after publishing but before marking the row sent, it republishes on restart — which is *at-least-once publishing*, and therefore why the downstream consumer must still be idempotent. The outbox does not eliminate duplicates; it eliminates the *lie* and the *silence*. Duplicates are mopped up by the consumer's dedup store. Together, outbox + inbox = effective exactly-once.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="o1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="o2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The transactional outbox: one DB txn, then a relay publishes</text>

  <rect x="24" y="40" width="832" height="150" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">The dual-write problem (what we are fixing)</text>
  <rect x="60" y="80" width="120" height="40" rx="6" fill="#fff" stroke="#fca5a5"/><text x="120" y="104" text-anchor="middle" fill="#7f1d1d" font-size="10">1. write DB &#10003;</text>
  <text x="220" y="104" text-anchor="middle" fill="#b91c1c" font-size="20">&#215;</text>
  <text x="220" y="90" text-anchor="middle" fill="#b91c1c" font-size="9">CRASH</text>
  <rect x="260" y="80" width="140" height="40" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="330" y="104" text-anchor="middle" fill="#7f1d1d" font-size="10">2. publish &#8212; NEVER</text>
  <text x="430" y="98" fill="#991b1b" font-size="10">&#8594; DB has the order, world never hears &#8594; silent divergence</text>
  <text x="60" y="150" fill="#991b1b" font-size="10">Reverse the order and you emit an event for a change that rolled back &#8212; a lie. No ordering is safe:</text>
  <text x="60" y="170" fill="#991b1b" font-size="10" font-weight="bold">there is no transaction spanning a database and a broker.</text>

  <rect x="24" y="204" width="410" height="140" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="226" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Step 1: ONE local DB transaction</text>
  <rect x="48" y="244" width="360" height="30" rx="5" fill="#fff" stroke="#60a5fa"/><text x="228" y="263" text-anchor="middle" fill="#1e40af" font-size="10">INSERT orders (id=42, ...)</text>
  <rect x="48" y="280" width="360" height="30" rx="5" fill="#fff" stroke="#60a5fa"/><text x="228" y="299" text-anchor="middle" fill="#1e40af" font-size="10">INSERT outbox (msg_id, topic, key, payload)</text>
  <text x="229" y="330" text-anchor="middle" fill="#1d4ed8" font-size="10" font-weight="bold">COMMIT &#8594; both or neither. Dual-write gone.</text>

  <rect x="446" y="204" width="410" height="140" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="651" y="226" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Step 2: the relay publishes committed rows</text>
  <rect x="470" y="244" width="120" height="34" rx="5" fill="#fff" stroke="#c4b5fd"/><text x="530" y="265" text-anchor="middle" fill="#5b21b6" font-size="9">outbox table</text>
  <path d="M592,261 L636,261" stroke="#7c3aed" stroke-width="2" marker-end="url(#o2)"/>
  <text x="614" y="253" text-anchor="middle" fill="#6d28d9" font-size="8">poll / CDC</text>
  <rect x="638" y="244" width="90" height="34" rx="5" fill="#ddd6fe" stroke="#7c3aed"/><text x="683" y="260" text-anchor="middle" fill="#5b21b6" font-size="9">relay /</text><text x="683" y="272" text-anchor="middle" fill="#5b21b6" font-size="9">Debezium</text>
  <path d="M730,261 L774,261" stroke="#7c3aed" stroke-width="2" marker-end="url(#o2)"/>
  <rect x="776" y="244" width="66" height="34" rx="5" fill="#ddd6fe" stroke="#7c3aed"/><text x="809" y="265" text-anchor="middle" fill="#5b21b6" font-size="9">broker</text>
  <text x="470" y="300" fill="#6d28d9" font-size="10">publishes iff the row committed &#8594; no lie, no silence</text>
  <text x="470" y="320" fill="#6d28d9" font-size="10">crash after publish, before mark-sent &#8594; republish</text>
  <text x="470" y="336" fill="#6d28d9" font-size="10" font-weight="bold">&#8594; at-least-once publish (duplicates possible)</text>

  <rect x="24" y="358" width="832" height="128" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="380" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Step 3: the consumer dedups &#8594; effective exactly-once end to end</text>
  <rect x="60" y="396" width="90" height="34" rx="5" fill="#fff" stroke="#86efac"/><text x="105" y="417" text-anchor="middle" fill="#14532d" font-size="9">broker</text>
  <path d="M152,413 L196,413" stroke="#2563eb" stroke-width="2" marker-end="url(#o1)"/>
  <rect x="198" y="396" width="150" height="34" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="273" y="412" text-anchor="middle" fill="#14532d" font-size="9">consumer: key seen?</text><text x="273" y="424" text-anchor="middle" fill="#166534" font-size="8">inbox table + TTL</text>
  <text x="366" y="410" fill="#166534" font-size="10">new &#8594; do work + save key (one txn)</text>
  <text x="366" y="426" fill="#166534" font-size="10">seen &#8594; SKIP (duplicate from the relay or the broker)</text>
  <text x="60" y="454" fill="#166534" font-size="11" font-weight="bold">Outbox (trustworthy publish)  +  Inbox (harmless duplicates)  =  effective exactly-once</text>
  <text x="60" y="474" fill="#166534" font-size="10">Neither half alone is enough: the outbox stops lies/silence; the inbox stops double effects. You need both.</text>
</svg>
```

### CDC with Debezium: the relay without polling

The relay can work two ways. The simple version **polls**: `SELECT * FROM outbox WHERE published = false ORDER BY id LIMIT 100`, publish each, mark `published = true` (or delete the row). This is easy, works everywhere, and is perfectly adequate at moderate volume — the cost is the polling latency and the read load. The sophisticated version uses **Change Data Capture**: a tool like **Debezium** tails the database's transaction log (the Postgres WAL, the MySQL binlog) and emits an event for every committed row change. Point Debezium at the `outbox` table and every committed outbox row becomes a Kafka record automatically, with no polling, no read load, and near-real-time latency. Debezium even ships an **Outbox Event Router** SMT that reshapes the raw row-change event into a clean domain event on a topic derived from a column. CDC is the reason the outbox pattern scales: the relay is no longer your code polling a table, it is the database's own commit log being streamed.

## 5. Implementation

Below is a complete, runnable sketch in Go: an **outbox writer** that commits a domain change and an outbox row atomically, a simple **polling relay** that publishes committed rows to Kafka, and an **idempotent consumer** that dedups against an inbox table before doing non-idempotent work. Uses `github.com/segmentio/kafka-go` and `database/sql` with Postgres. Error handling is real, not elided.

```go
package outbox

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/segmentio/kafka-go"
	// _ "github.com/lib/pq" // Postgres driver, imported by the caller
)

// -----------------------------------------------------------------------------
// Schema (run once). The outbox row and the domain row share a transaction; the
// inbox row and the effect share a transaction. Those two atomic writes are the
// entire pattern.
//
//   CREATE TABLE orders (
//     id BIGINT PRIMARY KEY, customer_id BIGINT, amount_cents BIGINT, status TEXT);
//
//   CREATE TABLE outbox (
//     id           BIGSERIAL PRIMARY KEY,
//     msg_id       UUID NOT NULL,           -- stable dedup key for consumers
//     topic        TEXT NOT NULL,
//     msg_key      TEXT NOT NULL,           -- Kafka partition key (chapter 22)
//     payload      JSONB NOT NULL,
//     published    BOOLEAN NOT NULL DEFAULT FALSE,
//     created_at   TIMESTAMPTZ NOT NULL DEFAULT now());
//   CREATE INDEX outbox_unpublished ON outbox (id) WHERE published = false;
//
//   CREATE TABLE inbox (                    -- the consumer-side dedup store
//     msg_id       UUID PRIMARY KEY,        -- processed message ids
//     processed_at TIMESTAMPTZ NOT NULL DEFAULT now());
// -----------------------------------------------------------------------------

// OrderPlaced is the event payload we will publish when an order is created.
type OrderPlaced struct {
	MsgID      string `json:"msg_id"` // stable id — travels into the message header AND the inbox
	OrderID    int64  `json:"order_id"`
	CustomerID int64  `json:"customer_id"`
	Amount     int64  `json:"amount_cents"`
}

// PlaceOrder is the PRODUCER side of the outbox. It writes the domain change and
// the outbox row in ONE transaction. If the commit succeeds, the message WILL be
// published (by the relay); if it fails, neither the order nor the message
// exists. This is what kills the dual-write problem: there is only one write.
func PlaceOrder(ctx context.Context, db *sql.DB, o OrderPlaced) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	// Roll back on any early return. A committed tx makes Rollback a harmless no-op.
	defer func() { _ = tx.Rollback() }()

	// (1) The domain change.
	if _, err = tx.ExecContext(ctx,
		`INSERT INTO orders (id, customer_id, amount_cents, status)
		 VALUES ($1, $2, $3, 'PLACED')`,
		o.OrderID, o.CustomerID, o.Amount,
	); err != nil {
		return fmt.Errorf("insert order: %w", err)
	}

	// (2) The intent to publish, as a row in the SAME transaction. We serialise
	// the payload now so the relay is a dumb pipe that never touches domain code.
	payload, err := json.Marshal(o)
	if err != nil {
		return fmt.Errorf("marshal: %w", err)
	}
	if _, err = tx.ExecContext(ctx,
		`INSERT INTO outbox (msg_id, topic, msg_key, payload)
		 VALUES ($1, 'orders.placed', $2, $3)`,
		o.MsgID, fmt.Sprintf("%d", o.CustomerID), payload, // key = customer_id keeps a customer's events ordered
	); err != nil {
		return fmt.Errorf("insert outbox: %w", err)
	}

	// One commit for both rows. Atomic. THIS is the outbox pattern.
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// RunRelay is the polling MESSAGE RELAY. It reads committed, unpublished outbox
// rows and publishes them to Kafka, then marks them sent. Because it only sees
// committed rows, it publishes a message IFF the order committed. A crash between
// the broker write and the mark-sent update means the row is republished on the
// next poll — at-least-once publishing, which is exactly why consumers dedup.
func RunRelay(ctx context.Context, db *sql.DB, w *kafka.Writer, poll time.Duration) error {
	ticker := time.NewTicker(poll)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if err := relayBatch(ctx, db, w); err != nil {
				// Log and continue — a transient broker error must not stop the relay.
				fmt.Printf("relay batch error: %v\n", err)
			}
		}
	}
}

func relayBatch(ctx context.Context, db *sql.DB, w *kafka.Writer) error {
	// Read a bounded batch of unpublished rows, oldest first to preserve order.
	// FOR UPDATE SKIP LOCKED lets multiple relay instances run without publishing
	// the same row twice (they skip rows another relay has locked).
	rows, err := db.QueryContext(ctx,
		`SELECT id, msg_id, topic, msg_key, payload
		   FROM outbox WHERE published = false
		   ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`)
	if err != nil {
		return fmt.Errorf("select outbox: %w", err)
	}
	type row struct {
		id      int64
		msgID   string
		topic   string
		key     string
		payload []byte
	}
	var batch []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.msgID, &r.topic, &r.key, &r.payload); err != nil {
			rows.Close()
			return fmt.Errorf("scan: %w", err)
		}
		batch = append(batch, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	for _, r := range batch {
		// Publish. The msg_id rides in a header so the consumer can dedup on it.
		msg := kafka.Message{
			Topic: r.topic,
			Key:   []byte(r.key),
			Value: r.payload,
			Headers: []kafka.Header{
				{Key: "msg_id", Value: []byte(r.msgID)},
			},
		}
		if err := w.WriteMessages(ctx, msg); err != nil {
			// Broker down or slow: stop this batch, retry the whole thing next tick.
			// The row stays published=false, so nothing is lost.
			return fmt.Errorf("write %d: %w", r.id, err)
		}
		// Mark sent. If we crash here, the row is republished next poll — a duplicate
		// the consumer will absorb. Correctness does not depend on this succeeding.
		if _, err := db.ExecContext(ctx,
			`UPDATE outbox SET published = true WHERE id = $1`, r.id); err != nil {
			return fmt.Errorf("mark %d: %w", r.id, err)
		}
	}
	return nil
}

// ErrDuplicate signals the message was already processed and was safely skipped.
var ErrDuplicate = errors.New("duplicate message, skipped")

// ConsumeIdempotently is the CONSUMER side: the INBOX pattern. Before doing the
// non-idempotent work (charging a card), it tries to claim the msg_id in the
// inbox table. If the id is already there, this is a redelivery and we skip.
// Crucially, the inbox INSERT and the side effect commit in ONE transaction, so
// a crash before commit leaves neither and the redelivery re-does the work
// safely, while a crash after commit means the redelivery is correctly skipped.
func ConsumeIdempotently(
	ctx context.Context, db *sql.DB, msgID string, doWork func(tx *sql.Tx) error,
) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Try to claim the id. ON CONFLICT DO NOTHING + checking RowsAffected is an
	// atomic "insert if absent" — no read-then-write race between two consumers.
	res, err := tx.ExecContext(ctx,
		`INSERT INTO inbox (msg_id) VALUES ($1) ON CONFLICT (msg_id) DO NOTHING`, msgID)
	if err != nil {
		return fmt.Errorf("claim inbox: %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("rows affected: %w", err)
	}
	if n == 0 {
		// The id was already present: a duplicate delivery. Do NOTHING and commit
		// (nothing changed). The message can be acked; the effect happened once.
		return ErrDuplicate
	}

	// First time we have seen this id. Do the real (non-idempotent) work in the
	// SAME transaction as the inbox claim, so they are atomic together.
	if err := doWork(tx); err != nil {
		return fmt.Errorf("work: %w", err) // rollback drops the inbox claim too
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// RunConsumer wires kafka-go to ConsumeIdempotently. It commits the Kafka offset
// only AFTER the effect + inbox row commit, so a crash before the offset commit
// merely redelivers a message the inbox will now recognise. Ack-after-process.
func RunConsumer(ctx context.Context, db *sql.DB, brokers []string, topic, group string) error {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers: brokers,
		Topic:   topic,
		GroupID: group, // consumer group: partitions shared across instances
	})
	defer r.Close()

	for {
		m, err := r.FetchMessage(ctx) // FetchMessage, not ReadMessage, so we control the commit
		if err != nil {
			return fmt.Errorf("fetch: %w", err)
		}
		msgID := headerValue(m.Headers, "msg_id")
		if msgID == "" {
			// No dedup key: fall back to a natural key or reject. Never process a
			// non-idempotent effect without a stable id.
			msgID = fmt.Sprintf("%s-%d-%d", m.Topic, m.Partition, m.Offset)
		}

		err = ConsumeIdempotently(ctx, db, msgID, func(tx *sql.Tx) error {
			// The non-idempotent effect: e.g. charge a card / increment a balance.
			// Runs at most once per msg_id thanks to the inbox claim above.
			_, e := tx.ExecContext(ctx,
				`UPDATE ledger SET balance_cents = balance_cents - 100 WHERE account = $1`,
				string(m.Key))
			return e
		})
		switch {
		case err == nil || errors.Is(err, ErrDuplicate):
			// Success or a recognised duplicate: both are "done" — commit the offset.
			if err := r.CommitMessages(ctx, m); err != nil {
				return fmt.Errorf("commit offset: %w", err)
			}
		default:
			// A real failure: do NOT commit the offset. The message is redelivered
			// and retried. (After N attempts, route to a DLQ — chapter 23.)
			return fmt.Errorf("process %s: %w", msgID, err)
		}
	}
}

func headerValue(hs []kafka.Header, key string) string {
	for _, h := range hs {
		if h.Key == key {
			return string(h.Value)
		}
	}
	return ""
}
```

The three pieces embody the chapter. `PlaceOrder` writes the domain row and the outbox row in one transaction — the dual-write is gone. `relayBatch` publishes only committed rows, at-least-once, and is safe to run in multiple instances via `FOR UPDATE SKIP LOCKED`. `ConsumeIdempotently` claims the `msg_id` in the inbox and does the work in the same transaction, so duplicates are no-ops. The Kafka offset is committed *after* the effect commits (ack-after-process), so a crash redelivers a message the inbox now recognises. In RabbitMQ the same consumer shape holds with `msg.Ack(false)` after the transaction commits and the standard `message_id` property as the dedup key; the inbox table is identical.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Effective exactly-once** without the impossible "exactly-once delivery" — the observable effect is once, over an at-least-once transport.
- **No distributed transaction.** The outbox uses only your local DB transaction; no XA/2PC across DB and broker, which is slow and often unsupported.
- **Trustworthy publishing.** A message is published if and only if the data change committed — the outbox removes both the "silent divergence" and the "emitted lie" failure modes.
- **Harmless duplicates.** An idempotent consumer converts the broker's at-least-once nuisance into a non-event; you stop fearing redelivery.
- **CDC scales the relay.** With Debezium, the relay is the database's commit log being streamed, not your code polling — near-real-time, no read load.

**Disadvantages**
- **Extra moving parts.** An outbox table, a relay (or Debezium + Connect), and an inbox table are infrastructure to run, monitor and reason about.
- **Dedup store growth and TTL risk.** The inbox grows without bound unless pruned, and a redelivery after the TTL expires is reprocessed as new.
- **Latency from polling.** A polling relay adds up to one poll interval of latency; CDC removes it but adds Debezium/Connect operational surface.
- **Ordering care in the relay.** Publishing outbox rows out of order (or across multiple relay threads without care) can reorder events; you must publish per-key in id order.

**Trade-offs**
- *Naturally idempotent vs dedup store:* prefer expressing effects as convergent state (upserts) — it is free and needs no store. Fall back to a dedup store only for true deltas (money, external calls) where the cost of the store is justified.
- *Polling relay vs CDC:* polling is trivial to build and adequate at moderate volume; CDC (Debezium) is near-real-time and load-free but adds a Kafka Connect cluster and log-decoding config to operate.
- *Business key vs producer message id:* a producer UUID is clean and opaque but must survive retries unchanged; a business key ties dedup to domain meaning and survives republishing but must be provably unique per logical event.
- *Inbox TTL length:* longer TTL is safer against late redeliveries but costs storage; size it against your worst-case redelivery window, not the average.

## 7. Common Mistakes & Best Practices

- **Assuming exactly-once delivery exists.** It does not. Designing a consumer that "trusts" the broker to deliver once is the root bug; every non-idempotent handler is a double-charge waiting to happen.
- **Doing the dual write anyway.** Writing the DB and then calling `producer.Send()` in the request path is the single most common data-integrity bug in event-driven systems. Use the outbox.
- **A dedup key that changes on redelivery.** Using a per-delivery id (Kafka offset, a fresh UUID at consume time) as the dedup key means redeliveries look new and are reprocessed. The key must be stamped by the producer and immutable.
- **Checking the dedup store, then doing work, in separate transactions.** A crash between "record the id" and "do the work" (or the reverse) reintroduces the very inconsistency you were preventing. The claim and the effect must commit together.
- **An unbounded inbox with no TTL, or a TTL shorter than the redelivery window.** The former runs you out of disk; the latter lets a late redelivery slip through as new. Prune with a TTL sized to the worst case.
- **A relay that publishes rows and marks them sent in separate, unguarded steps across threads.** Without `FOR UPDATE SKIP LOCKED` (or a single relay), two instances double-publish; without per-key ordering, events reorder.
- **Relying on Kafka's idempotent producer for end-to-end idempotency.** `enable.idempotence=true` only dedupes *producer retries within a session* — it does not survive a producer restart or make your *consumer* idempotent. It is necessary but not sufficient.
- **Best practice:** make effects naturally idempotent (convergent upserts) wherever you can, use the outbox for every DB-plus-publish, use an inbox with a producer-stamped stable id for the deltas you cannot make natural, and treat the two halves — trustworthy publish, harmless duplicates — as a single design that you always deploy together.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The two failure signatures are distinct. A *missing downstream effect with the source row present* is a dual-write or relay failure — check the outbox for unpublished rows and the relay's health. A *double effect* is a broken or missing dedup — check that the `msg_id` is stable and that the claim + effect are in one transaction. Carry the `msg_id` as a correlation id through every log line so you can follow one logical message from `PlaceOrder` through the relay to the consumer.
- **Monitoring.** Watch **outbox lag** (count and age of `published = false` rows) — a growing backlog means the relay is falling behind or the broker is rejecting writes, and events are being delayed. Watch the **duplicate/skip rate** in the consumer (how often the inbox claim conflicts) — a sudden spike means the broker is redelivering heavily, often a rebalance or an ack problem upstream. Watch **inbox size** and prune-job health. For Debezium, watch connector status and WAL/binlog lag.
- **Security.** The outbox and inbox tables often contain business payloads — treat them with the same access control and encryption-at-rest as the domain tables; they are not "just plumbing". The `msg_id` should be a random UUID, not a guessable sequential id, if its presence leaks information. When Debezium reads the WAL it needs a replication-privileged database role — scope it tightly, because that role can read every change in the database, not just the outbox.
- **Scaling.** The polling relay scales horizontally with `FOR UPDATE SKIP LOCKED` — add instances and they partition the unpublished rows between them, though you must preserve per-key order (a common approach: hash the key to a relay shard). At high volume switch to CDC/Debezium so the relay cost moves off your database's query path onto its commit log. The inbox is a hot table — index it on the primary key only, prune aggressively, and consider a fast key-value store (Redis with a TTL) as the dedup store when the effect is idempotent enough that a rare miss is tolerable, keeping the durable inbox only for money-grade effects.

## 9. Interview Questions

**Q: Why must an at-least-once consumer be idempotent?**
A: Because at-least-once guarantees a message is delivered *one or more* times, and the extra deliveries are real. A consumer that acks after processing will, on a crash between doing the work and recording the ack, be redelivered the same message and process it again. If the handler is not idempotent — if running it twice causes two effects — that redelivery double-charges, double-increments, or double-sends. Making the handler idempotent means a second delivery re-does something already done and changes nothing, so the effect is exactly-once even though delivery is at-least-once. There is no way to make the broker deliver exactly once, so idempotency is the only durable answer.

**Q: What is the difference between a naturally idempotent and a made-idempotent operation?**
A: A naturally idempotent operation is one whose repetition has no additional effect by its own nature — setting a field to a value, deleting by id, or an upsert keyed by a stable id all converge to the same state no matter how many times they run. A made-idempotent operation is one that is *not* naturally idempotent — charge, increment, append, send — whose effect is a delta, so repeating it repeats the delta; you make it idempotent by remembering, durably, that you already processed this message (a dedup store) and skipping if you have. The rule is to express effects as a state you converge to wherever possible, because that is free, and to fall back to a dedup store only for the true deltas.

**Q: What makes a good deduplication key?**
A: It must be stable across all redeliveries of the same logical message and distinct across different logical messages. The two good sources are a producer-assigned message id — a UUID the producer generates once and never changes on retry, carried in a header — and a business/natural key like `(order_id, "OrderPlaced")`. A bad key is anything that changes per delivery, such as the Kafka offset or a UUID generated at consume time, because then a redelivery looks new and gets reprocessed. The store also needs a TTL long enough to cover the worst-case redelivery window; too short and a late redelivery slips through as new.

**Q: What is the dual-write problem?**
A: It is the inconsistency that arises when a service must update its database and publish a message as two separate operations, with no transaction spanning both. If it writes the database and then crashes before publishing, the change exists but no one is told — silent divergence. If it publishes and then the database write fails, it has announced a change that did not happen — a lie. No ordering is safe because the failure is a crash in the gap between the two writes, and there is no distributed transaction between a database and a broker (and you do not want the fragility of XA to add one). Consumer-side idempotency cannot fix it because the message is either missing or false.

**Q: How does the outbox pattern solve the dual-write problem?**
A: By turning two writes into one. Instead of writing the database and then publishing, you write the domain change and a row in an `outbox` table in a single local database transaction, so they commit or roll back together. A separate relay process then reads committed outbox rows and publishes them. Because the relay only ever sees committed rows, a message is published if and only if the data change committed — the silent-divergence and emitted-lie failure modes are both gone. The relay publishes at-least-once (it may republish after a crash before marking a row sent), so the consumer still needs to be idempotent, but the *existence and truth* of the message is now guaranteed.

**Q: Does Kafka's idempotent producer give you end-to-end exactly-once?**
A: No. `enable.idempotence=true` makes the *producer's retries* safe: the broker tags each record with a producer id and a sequence number and rejects a duplicate append caused by a retry within that producer session. That stops the specific duplicate where the producer sent a batch, did not get the ack, and resent it. It does not survive a producer process restart (new producer id), it does nothing about the dual-write problem, and it does not make your consumer idempotent. It is a valuable, necessary piece — you should enable it — but end-to-end exactly-once effect still requires the outbox on the produce side and a dedup store on the consume side.

**Q: (Senior) Walk me through achieving effective exactly-once end to end, and where each duplicate is absorbed.**
A: I combine a trustworthy publish with a harmless-duplicate consumer. On the produce side, the service writes its domain change and an outbox row in one local transaction, so the message exists if and only if the change committed — that removes the dual-write failure. A relay publishes committed outbox rows to the broker; it publishes at-least-once because a crash after the broker write but before marking the row sent causes a republish. On the consume side, the handler claims the message's stable id in an inbox table and performs the effect in the *same* transaction, so a duplicate delivery finds the id already present and skips, while a crash before commit leaves neither the claim nor the effect and the redelivery safely redoes it. The Kafka offset (or RabbitMQ ack) is committed only after that transaction, so the transport's own retries are also absorbed. Duplicates are therefore mopped up in exactly one place — the inbox claim — regardless of whether they originated from the relay republishing, the broker redelivering, or a rebalance. The net observable effect is once. I stress that neither half suffices alone: the outbox without an idempotent consumer still double-processes on redelivery; the idempotent consumer without the outbox still misses or fabricates events. They are one design deployed together.

**Q: (Senior) When would you choose CDC/Debezium over a polling relay, and what does it cost?**
A: I choose CDC when the polling relay's latency or database load becomes a problem, which happens at higher event volumes or when downstream needs near-real-time events. A polling relay repeatedly scans the outbox for unpublished rows; that is extra query load and adds up to a poll interval of latency, both of which are fine at moderate scale and painful at high scale. Debezium instead tails the database's transaction log — the Postgres WAL or MySQL binlog — so every committed outbox row becomes a message with no polling, no scan load on the primary's query path, and sub-second latency; the Outbox Event Router SMT even reshapes the raw row change into a clean domain event on a per-type topic. The costs are real: you now operate a Kafka Connect cluster and a Debezium connector, you must configure logical decoding and a replication slot (an unconsumed slot can pin WAL and fill the disk — a genuine outage risk), and the replication role Debezium uses can read every change in the database, so it must be tightly scoped. I reach for CDC when scale justifies that operational surface, and keep the polling relay when it does not — it is often the right answer for a long time.

**Q: (Senior) Your consumer is idempotent via a dedup store, but you are still seeing occasional double effects. What are the likely causes?**
A: I would look at the four classic breaks in the dedup discipline. First, the dedup key may not be stable — if the key is derived from something that changes per delivery, redeliveries look new; I check that the producer stamps an immutable id. Second, the claim and the effect may be in separate transactions — if the code records the id and then, in a second transaction, does the work, a crash between them lets a redelivery either redo the work or (worse) skip work that never happened; the fix is one transaction. Third, the store's TTL may be shorter than the actual redelivery window — a message requeued for longer than the TTL comes back after its id was pruned and is reprocessed; I lengthen the TTL to the worst case. Fourth, a race between two consumers on the same message — if the "check then insert" is not atomic, both can pass the check before either inserts; the fix is an atomic insert-if-absent (`ON CONFLICT DO NOTHING` and check rows affected, or a unique constraint) rather than a read followed by a write. I would reproduce by forcing a redelivery (kill the consumer between effect and offset commit) and confirm the second delivery hits the conflict path. Ninety percent of "my idempotency does not work" cases are one of these four.

**Q: Why can the relay safely publish duplicates, and what stops those duplicates from causing harm?**
A: The relay can crash after it has written a message to the broker but before it has marked the outbox row as published; on restart it sees the row still unpublished and publishes it again. That is deliberate — the alternative (mark sent before publishing) would risk *losing* a message on a crash, which is worse than duplicating one. The duplicates are harmless because the consumer is idempotent: it dedups on the message's stable id, so the second copy hits the inbox claim conflict and is skipped. This is the division of labour in the whole pattern: the outbox guarantees *at-least-once with truth* (the message exists iff the change committed), and the inbox downgrades at-least-once to effectively once. The relay is allowed to be simple and to prefer duplication over loss precisely because the consumer is defending against duplication anyway.

## 10. Quick Revision & Cheat Sheet

| Concept | What it is | Fixes |
|---|---|---|
| Idempotent consumer | Handler safe to run more than once | Duplicate *deliveries* (at-least-once) |
| Naturally idempotent | Effect is a convergent state (set/delete/upsert) | Needs no dedup store |
| Dedup store / inbox | Table of processed ids, checked before work | Made-idempotent deltas (charge/increment) |
| Dedup key | Stable producer msg id or business key + TTL | Recognising a redelivery |
| Dual-write problem | DB write + publish as two non-atomic ops | (the thing the outbox fixes) |
| Transactional outbox | Domain row + outbox row in one DB txn | Silent divergence / emitted lie |
| Relay / Debezium (CDC) | Publishes committed outbox rows | Getting the message out atomically |
| Outbox + inbox | Trustworthy publish + harmless duplicates | Effective exactly-once end to end |

| Kafka | RabbitMQ |
|---|---|
| No built-in msg id → put id in a header | `message_id` / `correlation_id` properties |
| `enable.idempotence=true` dedupes producer *retries* | Publisher confirms + persistent messages |
| Debezium source connector tails WAL/binlog | Same relay pattern; or Debezium into a stream |
| Offset committed after effect = at-least-once | `basic.ack` after the effect's txn commits |

**Flash cards**
- **Why must consumers be idempotent?** → At-least-once delivers duplicates; only a no-op second run keeps the effect once.
- **Two families of idempotency?** → Naturally idempotent (convergent state, free) vs made-idempotent (dedup store on a stable key).
- **What is the dual-write problem?** → DB write and publish are two non-atomic ops; a crash between leaves silent divergence or an emitted lie.
- **What is the outbox pattern?** → Write the domain change and an outbox row in one DB txn; a relay publishes committed rows — message exists iff change committed.
- **Why still need dedup with an outbox?** → The relay publishes at-least-once (republishes after a crash); the consumer absorbs the duplicates.
- **Outbox + idempotent consumer = ?** → Effective exactly-once end to end — the closest thing to a guarantee that does not exist.

## 11. Hands-On Exercises & Mini Project

- [ ] Take a non-idempotent handler (increment a balance) and force a duplicate delivery by killing the consumer between the effect and the offset commit; observe the double effect.
- [ ] Rewrite that handler with an inbox table (`ON CONFLICT DO NOTHING`), repeat the kill test, and confirm the effect happens exactly once.
- [ ] Implement the dual-write the naive way (DB commit then publish) and inject a crash between them; show a downstream consumer that never receives the event despite the row existing.
- [ ] Replace it with the outbox writer and a polling relay; repeat the crash injection and confirm the event is eventually published exactly because the row committed.
- [ ] Run two relay instances against the same outbox with `FOR UPDATE SKIP LOCKED` and verify no row is published twice.
- [ ] Set an inbox TTL shorter than your redelivery delay and demonstrate a late redelivery slipping through as new; then lengthen the TTL and confirm it is caught.

### Mini Project — "Effective Exactly-Once Order Pipeline"

**Goal.** Build an order service that publishes `OrderPlaced` with no dual-write, and a payment consumer that charges exactly once despite forced duplicates — demonstrating outbox + inbox = effective exactly-once.

**Requirements.**
1. Create `orders`, `outbox`, and `inbox` tables in Postgres and an `OrderPlaced` payload with a stable `msg_id`.
2. Implement `PlaceOrder` that writes the order row and the outbox row in one transaction; prove that a rollback leaves neither.
3. Implement a polling relay that publishes committed outbox rows to Kafka with the `msg_id` in a header and marks them sent; make it crash-safe (republish on restart).
4. Implement an idempotent payment consumer that claims the `msg_id` in `inbox` and charges in the same transaction, committing the offset only after.
5. Write a chaos test that kills the relay after publish-before-mark and kills the consumer after effect-before-offset-commit, and assert the ledger is debited exactly once per order.

**Extensions.**
- Replace the polling relay with Debezium tailing the outbox table via the Outbox Event Router SMT, and compare latency and database load against polling.
- Add a prune job for the inbox with a TTL, then deliberately delay a redelivery past the TTL and observe (and then fix) the reprocessing.
- Port the consumer to RabbitMQ using the `message_id` property and `basic.ack` after the transaction, keeping the same inbox table.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Delivery Guarantees* (why at-least-once is the default and exactly-once delivery is impossible), *What Is a Message Queue?* (the ack is where correctness lives), *Ordering, Partitioning & Keys* (keeping a key's events ordered through the outbox and relay), *Backpressure, Flow Control & Poison Messages* (bounded retries and DLQs for messages that always fail), *Kafka Connect & CDC with Debezium* (streaming the database commit log).

- **Microservices Patterns — Transactional Outbox** — Chris Richardson · *Intermediate* · the canonical write-up of the outbox and the dual-write problem, with the polling-publisher and CDC variants. <https://microservices.io/patterns/data/transactional-outbox.html>
- **Reliable Microservices Data Exchange with the Outbox Pattern** — Debezium (Gunnar Morling) · *Intermediate* · the outbox implemented with Debezium CDC and the Outbox Event Router SMT, end to end. <https://debezium.io/blog/2019/02/19/reliable-microservices-data-exchange-with-the-outbox-pattern/>
- **You Cannot Have Exactly-Once Delivery** — Tyler Treat (Brave New Geek) · *Advanced* · why delivery is at-least-once and idempotency is the real answer to exactly-once. <https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/>
- **Exactly-Once Semantics Are Possible: Here's How Kafka Does It** — Neha Narkhede (Confluent) · *Advanced* · what Kafka's idempotent producer and transactions do and do not guarantee. <https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/>
- **Designing Data-Intensive Applications, ch. 11 & 12** — Martin Kleppmann · *Advanced* · idempotence, deduplication, and the log-based approach to exactly-once effect. <https://dataintensive.net/>
- **Idempotency Keys — Stripe API** — Stripe · *Intermediate* · the request-layer version of the same idea, a battle-tested design for safe retries. <https://docs.stripe.com/api/idempotent_requests>
- **RabbitMQ — Reliability Guide (confirms, acks, message ids)** — RabbitMQ · *Intermediate* · publisher confirms, consumer acks, and the message properties used as dedup keys. <https://www.rabbitmq.com/docs/reliability>
- **Debezium — Outbox Event Router** — Debezium · *Advanced* · the SMT that turns raw outbox row-change events into clean domain events on per-type topics. <https://debezium.io/documentation/reference/stable/transformations/outbox-event-router.html>

---

*Kafka & RabbitMQ Handbook — chapter 21.*
