# 04 · Delivery Guarantees: At-Most, At-Least & Exactly-Once

> **In one line:** There are only three delivery semantics — at-most-once (ack first, may lose), at-least-once (ack last, may duplicate), and exactly-once (mostly an illusion) — and the honest truth is that the network cannot give you exactly-once *delivery*, so you build exactly-once *processing* by making an at-least-once consumer idempotent or transactional.

---

## 1. Overview

Ask an engineer what delivery guarantee their system provides and you learn a great deal about how carefully they have thought. There are exactly three possible answers, and they are decided by one small choice: **when do you acknowledge a message — before you process it, or after?** That single decision, made at both the producer and the consumer, is the whole subject.

**At-most-once** means every message is delivered zero or one times: it may be lost, never duplicated. You get it by acknowledging *before* processing (or by fire-and-forget) — fast, simple, and lossy. **At-least-once** means every message is delivered one or more times: never lost, but possibly duplicated. You get it by acknowledging *after* successful processing — so if you crash between processing and the ack being recorded, the broker redelivers, and you handle the message twice. This is the practical default of essentially every serious messaging system, because losing data is usually worse than repeating work. **Exactly-once** means every message takes effect once and only once — no loss, no duplication. It is what everyone wants and what the network fundamentally cannot promise end-to-end.

The uncomfortable, important truth this chapter insists on is that **exactly-once *delivery* is an illusion**. The two generals problem tells us that over an unreliable network, two parties can never be *certain* the other received a message, so the sender must either risk not-delivering (at-most-once) or risk delivering-again (at-least-once) — there is no third option at the wire. What you *can* build is exactly-once **processing**: take an at-least-once transport, which may deliver a message several times, and make the *effect* happen once — by deduplicating on a stable id (idempotency), or by making the read-process-write a single atomic transaction so duplicates are discarded. That is what Kafka's idempotent producer and transactions provide, and it is what an idempotent consumer provides on any broker.

So the mental model to carry through this chapter and the handbook is: choose at-least-once as your transport (never lose data), then make your consumer idempotent so at-least-once *becomes* effectively exactly-once at the level that matters — the effect. Everything else — ack timing, the two generals intuition, Kafka transactions, the outbox pattern — is detail hung on that spine. This chapter shows the three semantics with runnable Go, explains why the ack timing decides everything, and is honest about where exactly-once is real and where it is marketing.

## 2. Core Concepts

- **Delivery guarantee** — the promise about how many times a message's *effect* is applied: at-most-once (0 or 1), at-least-once (1 or more), exactly-once (exactly 1).
- **Acknowledgement (ack)** — the signal from consumer to broker that a message is handled and can be forgotten (RabbitMQ) or that the offset can advance (Kafka). Its *timing* decides the guarantee.
- **At-most-once** — ack before processing / fire-and-forget: never duplicated, may be lost on a crash. Fast.
- **At-least-once** — ack after successful processing: never lost, may be duplicated on redelivery. The practical default.
- **Exactly-once (delivery)** — the illusion: impossible end-to-end over an unreliable network (two generals problem).
- **Exactly-once (processing)** — achievable: an at-least-once transport plus idempotency or a transaction so the effect happens once.
- **Idempotency** — an operation safe to apply more than once for the same input, so duplicate deliveries cause no extra effect (chapter 21).
- **Deduplication** — recording processed message ids and skipping repeats — the mechanism that makes a consumer idempotent.
- **Idempotent producer (Kafka)** — `enable.idempotence=true`: sequence numbers per producer per partition let the broker discard duplicate appends from retries.
- **Transaction (Kafka)** — `transactional.id` + `read_committed`: atomically commit consumed offsets and produced records, giving exactly-once *processing* across consume-transform-produce.
- **Two generals problem** — the proof that no protocol over a lossy channel can make both parties certain of delivery; the reason exactly-once delivery is impossible.

## 3. Theory & Principles

### The ack timing decides everything

Strip away the vocabulary and the three guarantees are one decision made twice — once at the producer, once at the consumer — about *when the acknowledgement happens relative to the work*.

Consider the consumer. It receives a message, processes it (writes to a database, sends an email), and acknowledges. There are only two orderings:

- **Ack, then process (at-most-once).** The moment the broker gets the ack it deletes the message / advances the offset. If the consumer now crashes before processing finishes, the message is *gone* — the broker thinks it is handled, but the effect never happened. Zero-or-one delivery: never twice, sometimes never. Fast, because you never re-do work and never hold state waiting to ack.
- **Process, then ack (at-least-once).** The broker keeps the message until the ack arrives. If the consumer crashes *after* processing but *before* the ack is recorded, the broker never saw the ack, so on restart it *redelivers*, and the consumer processes the same message again. One-or-more delivery: never lost, sometimes twice.

There is no ordering that gives you "exactly once", because the crash can always land in the gap between process and ack (or between ack and process). You cannot make "process" and "ack" a single atomic step across a network — the consumer's work (a database write) and the broker's ack are two different systems, and any two-system update can partially fail. This is not an implementation weakness; it is fundamental.

The same choice exists at the producer. Fire-and-forget (don't wait for the broker's confirm) risks losing a message if the send fails silently — at-most-once. Wait for a confirm and retry on failure risks sending the message *twice* if the first send actually succeeded but the confirm was lost — at-least-once. Same gap, same fork.

### The two generals problem, and why exactly-once delivery is impossible

The reason you cannot escape the fork is a classic result. Two generals must coordinate an attack by messengers crossing hostile territory where messengers can be lost. General A sends "attack at dawn". Did B receive it? A cannot know unless B acknowledges. But did A receive B's acknowledgement? B cannot know unless A acknowledges the acknowledgement — and so on forever. No finite exchange of messages over a lossy channel lets *both* parties become *certain* the other has committed. There is always a last message whose delivery is unconfirmed.

Map that onto messaging: the "broker → consumer → ack" exchange is exactly the two generals. The broker cannot be certain the consumer processed the message unless it gets an ack; if the ack is lost, the broker must choose — assume delivered (risk loss, at-most-once) or redeliver (risk duplicate, at-least-once). There is no protocol that avoids both risks. Therefore **exactly-once *delivery* — the message crossing the wire once and only once with certainty — is provably impossible.** Any product claiming "exactly-once" is doing something more subtle, and it is worth knowing exactly what.

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="g1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="g2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="g3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The ack timing decides the guarantee &#8212; and the crash always fits in the gap</text>

  <rect x="24" y="40" width="410" height="180" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">AT-MOST-ONCE: ack, THEN process</text>
  <rect x="44" y="78" width="70" height="28" rx="5" fill="#fff" stroke="#fca5a5"/><text x="79" y="96" text-anchor="middle" fill="#b91c1c" font-size="9">broker</text>
  <rect x="330" y="78" width="80" height="28" rx="5" fill="#fff" stroke="#fca5a5"/><text x="370" y="96" text-anchor="middle" fill="#b91c1c" font-size="9">consumer</text>
  <path d="M116,86 L326,86" stroke="#dc2626" stroke-width="1.5" marker-end="url(#g1)"/>
  <text x="220" y="80" text-anchor="middle" fill="#b91c1c" font-size="8">1. deliver</text>
  <path d="M330,100 L120,100" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#g1)"/>
  <text x="220" y="114" text-anchor="middle" fill="#b91c1c" font-size="8">2. ACK immediately (broker deletes)</text>
  <text x="44" y="140" fill="#991b1b" font-size="10">3. process&#8230; &#128165; CRASH here &#8594; message LOST</text>
  <text x="44" y="162" fill="#7f1d1d" font-size="10" font-weight="bold">delivered 0 or 1 times &#8226; never duplicate</text>
  <text x="44" y="182" fill="#991b1b" font-size="10">fast, simple, lossy</text>
  <text x="44" y="204" fill="#991b1b" font-size="10">use when: metrics, logs, live dashboards</text>

  <rect x="446" y="40" width="410" height="180" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">AT-LEAST-ONCE: process, THEN ack</text>
  <rect x="466" y="78" width="70" height="28" rx="5" fill="#fff" stroke="#86efac"/><text x="501" y="96" text-anchor="middle" fill="#15803d" font-size="9">broker</text>
  <rect x="752" y="78" width="80" height="28" rx="5" fill="#fff" stroke="#86efac"/><text x="792" y="96" text-anchor="middle" fill="#15803d" font-size="9">consumer</text>
  <path d="M538,86 L748,86" stroke="#16a34a" stroke-width="1.5" marker-end="url(#g2)"/>
  <text x="642" y="80" text-anchor="middle" fill="#15803d" font-size="8">1. deliver (broker KEEPS it)</text>
  <text x="466" y="128" fill="#166534" font-size="10">2. process&#8230; &#128165; CRASH before ack</text>
  <path d="M752,144 L542,144" stroke="#16a34a" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#g2)"/>
  <text x="642" y="158" text-anchor="middle" fill="#15803d" font-size="8">3. no ack &#8594; broker REDELIVERS &#8594; process AGAIN</text>
  <text x="466" y="182" fill="#14532d" font-size="10" font-weight="bold">delivered 1 or more times &#8226; never lost</text>
  <text x="466" y="204" fill="#166534" font-size="10">the PRACTICAL DEFAULT &#8226; needs idempotent consumer</text>

  <rect x="24" y="234" width="410" height="150" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="229" y="256" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Two generals: why EO delivery is impossible</text>
  <rect x="44" y="272" width="60" height="26" rx="5" fill="#fff" stroke="#a78bfa"/><text x="74" y="289" text-anchor="middle" fill="#5b21b6" font-size="9">A</text>
  <rect x="354" y="272" width="60" height="26" rx="5" fill="#fff" stroke="#a78bfa"/><text x="384" y="289" text-anchor="middle" fill="#5b21b6" font-size="9">B</text>
  <path d="M106,280 L352,280" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#g3)"/>
  <text x="229" y="275" text-anchor="middle" fill="#5b21b6" font-size="8">attack at dawn (may be lost)</text>
  <path d="M354,294 L108,294" stroke="#7c3aed" stroke-width="1.5" stroke-dasharray="4 3" marker-end="url(#g3)"/>
  <text x="229" y="308" text-anchor="middle" fill="#5b21b6" font-size="8">ack (may be lost) &#8594; ack the ack&#8230; forever</text>
  <text x="44" y="330" fill="#6d28d9" font-size="10">No finite exchange makes BOTH sides certain.</text>
  <text x="44" y="350" fill="#6d28d9" font-size="10">The last message is always unconfirmed.</text>
  <text x="44" y="372" fill="#5b21b6" font-size="10" font-weight="bold">&#8756; you must risk loss OR risk duplication</text>

  <rect x="446" y="234" width="410" height="150" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="651" y="256" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">The escape: exactly-once PROCESSING</text>
  <text x="466" y="280" fill="#1d4ed8" font-size="10">Take at-least-once (never lose) &#8230;</text>
  <text x="466" y="300" fill="#1d4ed8" font-size="10">&#8230; then make the EFFECT happen once:</text>
  <text x="480" y="322" fill="#1d4ed8" font-size="10">&#8226; dedup on a stable message id (idempotency)</text>
  <text x="480" y="342" fill="#1d4ed8" font-size="10">&#8226; or atomic consume-transform-produce (Kafka txn)</text>
  <text x="466" y="366" fill="#1e3a8a" font-size="10" font-weight="bold">idempotent consumer &#8594; at-least-once = effectively EO</text>

  <rect x="24" y="398" width="832" height="66" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="420" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The rule to carry: default to at-least-once transport, make the consumer idempotent.</text>
  <text x="440" y="444" text-anchor="middle" fill="#475569" font-size="10">Never lose data (at-least-once) + never double an effect (idempotency) = exactly-once where it actually matters: the effect.</text>
</svg>
```

### Exactly-once *processing* vs exactly-once *delivery*

This is the distinction that separates people who understand delivery guarantees from people who repeat the marketing. **Exactly-once delivery** is about the wire: the message crosses once, no loss, no duplicate — and it is impossible, as above. **Exactly-once processing** is about the *effect*: no matter how many times the message is delivered, the observable outcome (the row written, the payment made, the counter incremented) happens exactly once. That *is* achievable, and by two routes:

1. **Idempotency / deduplication.** Accept that the transport is at-least-once. Give each message a stable id. Before applying the effect, check whether you have already processed that id; if so, skip. The duplicate is delivered but not *applied* twice. This works on any broker and is the workhorse technique (chapter 21).
2. **Transactional processing.** Make the "read message, produce result, commit offset" a single atomic unit so a partial failure rolls back and a duplicate read is discarded. Kafka provides this for consume-transform-produce pipelines *within Kafka* via transactions and idempotent producers. It does not magically extend to external systems (your database, a third-party API) unless those are enrolled in the same transaction, which is usually the outbox pattern (chapter 21).

The honest summary: "exactly-once" is real, but it is *processing*, achieved on top of an at-least-once transport, and it always has a cost — a dedup store, a transaction coordinator, or a careful outbox. There is no free, end-to-end, wire-level exactly-once.

## 4. Architecture & Workflow

How each guarantee is wired on the two brokers, and where Kafka's exactly-once machinery fits.

1. **At-most-once, RabbitMQ.** Consume with *auto-ack* (`autoAck=true`): the broker considers the message delivered and deletes it the instant it is pushed, before your handler runs. A crash mid-handler loses it. On the producer side, publish without publisher confirms.
2. **At-least-once, RabbitMQ.** Consume with *manual ack*: `basic.ack` only after the handler succeeds; `basic.nack`/`reject` with requeue on failure. On the producer side, enable *publisher confirms* and republish on missing confirm. Redelivery on crash gives duplicates — so the consumer must dedup.
3. **At-most-once, Kafka.** Commit the offset *before* processing (or use auto-commit with a short interval that fires before your handler completes). A crash after the commit but before processing skips the message.
4. **At-least-once, Kafka.** Commit the offset *after* processing (`commitSync` after the handler). A crash after processing but before the commit reprocesses on restart — duplicates, handled by an idempotent consumer.
5. **Exactly-once processing, Kafka (the real thing).** For consume-transform-produce *within Kafka*: enable the **idempotent producer** (`enable.idempotence=true`, default in modern Kafka) so producer retries do not create duplicate records; wrap the produce-and-commit-offsets in a **transaction** (`transactional.id`, `sendOffsetsToTransaction`, `commitTransaction`); and have downstream consumers read with `isolation.level=read_committed` so they never see aborted records. This makes the pipeline exactly-once *end to end within Kafka* (cross-reference chapter 20). It does *not* cover a write to your external database unless you use the outbox pattern.
6. **The dual-write caveat.** Whenever the effect touches a system *outside* the broker (a database, an email provider), no broker transaction spans it. The correct pattern is the *outbox* (chapter 21): write the business change and the outgoing message in one local database transaction, then relay the outbox to the broker at-least-once, deduplicated downstream.

The workflow lesson: exactly-once *processing* is not a checkbox on the broker — it is an *architecture*. Kafka gives you the strongest building blocks (idempotent producer, transactions) for Kafka-to-Kafka flows, but the moment an external system is involved, you are back to at-least-once plus idempotency plus outbox. Design for that from the start.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="w1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="w2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two routes to exactly-once PROCESSING &#8212; both built on at-least-once</text>

  <rect x="24" y="40" width="832" height="40" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="65" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Foundation: AT-LEAST-ONCE transport (never lose) &#8226; the wire is always at-least-once &#8212; the two generals forbid more</text>

  <rect x="24" y="94" width="410" height="200" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="116" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Route A: IDEMPOTENCY (any broker)</text>
  <rect x="44" y="132" width="80" height="30" rx="5" fill="#fff" stroke="#60a5fa"/><text x="84" y="151" text-anchor="middle" fill="#1e40af" font-size="9">deliver x2</text>
  <path d="M124,147 L162,147" stroke="#2563eb" stroke-width="1.5" marker-end="url(#w1)"/>
  <rect x="164" y="132" width="110" height="30" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="219" y="146" text-anchor="middle" fill="#1e40af" font-size="8">claim message id</text><text x="219" y="157" text-anchor="middle" fill="#1e40af" font-size="8">(PK insert)</text>
  <path d="M274,147 L312,147" stroke="#2563eb" stroke-width="1.5" marker-end="url(#w1)"/>
  <rect x="314" y="132" width="100" height="30" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="364" y="146" text-anchor="middle" fill="#1e40af" font-size="8">effect + commit</text><text x="364" y="157" text-anchor="middle" fill="#1e40af" font-size="8">(same txn)</text>
  <text x="44" y="188" fill="#1d4ed8" font-size="10">2nd delivery &#8594; id already present &#8594; SKIP</text>
  <text x="44" y="208" fill="#1d4ed8" font-size="10">dedup + effect in ONE transaction = no gap</text>
  <text x="44" y="228" fill="#1d4ed8" font-size="10">works on RabbitMQ, Kafka, anything</text>
  <text x="44" y="252" fill="#1e3a8a" font-size="10" font-weight="bold">covers the EXTERNAL DB boundary (via outbox)</text>
  <text x="44" y="276" fill="#1d4ed8" font-size="9">cost: a dedup store with a TTL</text>

  <rect x="446" y="94" width="410" height="200" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="651" y="116" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Route B: KAFKA TRANSACTIONS (Kafka&#8596;Kafka)</text>
  <rect x="466" y="132" width="90" height="30" rx="5" fill="#fff" stroke="#a78bfa"/><text x="511" y="146" text-anchor="middle" fill="#5b21b6" font-size="8">idempotent</text><text x="511" y="157" text-anchor="middle" fill="#5b21b6" font-size="8">producer</text>
  <path d="M556,147 L590,147" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#w1)"/>
  <rect x="592" y="132" width="120" height="30" rx="5" fill="#ede9fe" stroke="#7c3aed"/><text x="652" y="146" text-anchor="middle" fill="#5b21b6" font-size="8">produce + commit</text><text x="652" y="157" text-anchor="middle" fill="#5b21b6" font-size="8">offsets (1 txn)</text>
  <path d="M712,147 L746,147" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#w1)"/>
  <rect x="748" y="132" width="90" height="30" rx="5" fill="#ede9fe" stroke="#7c3aed"/><text x="793" y="146" text-anchor="middle" fill="#5b21b6" font-size="8">read_committed</text><text x="793" y="157" text-anchor="middle" fill="#5b21b6" font-size="8">consumer</text>
  <text x="466" y="188" fill="#6d28d9" font-size="10">seq numbers discard duplicate appends</text>
  <text x="466" y="208" fill="#6d28d9" font-size="10">produce &amp; offset-commit are ATOMIC</text>
  <text x="466" y="228" fill="#6d28d9" font-size="10">aborted records invisible downstream</text>
  <text x="466" y="252" fill="#b91c1c" font-size="10" font-weight="bold">does NOT span an external DB / API</text>
  <text x="466" y="276" fill="#6d28d9" font-size="9">cost: a transaction coordinator + latency</text>

  <rect x="24" y="308" width="832" height="108" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="330" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The boundary that decides which route</text>
  <text x="48" y="356" fill="#475569" font-size="10">&#8226; Effect stays inside Kafka (consume &#8594; transform &#8594; produce)? &#8594; Route B, Kafka transactions, is cleanest.</text>
  <text x="48" y="378" fill="#475569" font-size="10">&#8226; Effect touches a DB, an email provider, a payment API? &#8594; Route A, idempotency + outbox &#8212; no broker txn spans that wire.</text>
  <text x="440" y="404" text-anchor="middle" fill="#334155" font-size="10" font-weight="bold">Either way: at-least-once underneath, the EFFECT made once on top. There is no wire-level exactly-once.</text>
</svg>
```

## 5. Implementation

Three ack strategies in Go, made concrete. First, at-most-once and at-least-once on RabbitMQ, where the difference is literally the `autoAck` flag and the position of `Ack`:

```go
package delivery

import (
	amqp "github.com/rabbitmq/amqp091-go"
)

// AtMostOnceRabbit: autoAck=true. The broker deletes the message the instant it
// is delivered, BEFORE Handle runs. A crash inside Handle loses the message.
// Fast and lossy — correct only when a lost message is cheaper than a slow one.
func AtMostOnceRabbit(ch *amqp.Channel, queue string, handle func([]byte)) error {
	msgs, err := ch.Consume(queue, "",
		true,  // autoAck=true -> ACK BEFORE PROCESS => at-most-once
		false, false, false, nil)
	if err != nil {
		return err
	}
	go func() {
		for d := range msgs {
			handle(d.Body) // if this panics/crashes, the message is already gone
		}
	}()
	return nil
}

// AtLeastOnceRabbit: manual ack AFTER Handle succeeds. On failure we nack with
// requeue, so the message is redelivered — never lost, but possibly duplicated.
// This is the practical default; Handle MUST be idempotent (see below).
func AtLeastOnceRabbit(ch *amqp.Channel, queue string, handle func([]byte) error) error {
	_ = ch.Qos(20, 0, false) // prefetch: bound unacked messages = flow control
	msgs, err := ch.Consume(queue, "",
		false, // autoAck=false -> we ack manually AFTER processing => at-least-once
		false, false, false, nil)
	if err != nil {
		return err
	}
	go func() {
		for d := range msgs {
			if err := handle(d.Body); err != nil {
				// Processing failed: return the message for another attempt.
				// requeue=true; in production, cap retries then dead-letter (chapter 11).
				_ = d.Nack(false, true)
				continue
			}
			// Success: NOW acknowledge. A crash between handle() and here means
			// the broker never saw the ack and will redeliver -> a DUPLICATE.
			_ = d.Ack(false)
		}
	}()
	return nil
}
```

The Kafka equivalent — the guarantee is decided by *when you commit the offset* relative to processing:

```go
package delivery

import (
	"context"

	"github.com/segmentio/kafka-go"
)

// AtLeastOnceKafka: process, THEN commit the offset. A crash after processing
// but before CommitMessages reprocesses on restart -> duplicates. Never loses.
func AtLeastOnceKafka(ctx context.Context, r *kafka.Reader, handle func([]byte) error) error {
	for {
		m, err := r.FetchMessage(ctx) // fetch WITHOUT auto-committing
		if err != nil {
			return err
		}
		if err := handle(m.Value); err != nil {
			// Do NOT commit; on restart we re-read from the last committed offset.
			return err
		}
		// Commit only AFTER success => at-least-once. The window between handle()
		// succeeding and this commit is exactly where a duplicate is born.
		if err := r.CommitMessages(ctx, m); err != nil {
			return err
		}
	}
}

// AtMostOnceKafka: commit the offset BEFORE processing. A crash after the commit
// but before handle() completes SKIPS the message -> possible loss, no duplicate.
func AtMostOnceKafka(ctx context.Context, r *kafka.Reader, handle func([]byte)) error {
	for {
		m, err := r.FetchMessage(ctx)
		if err != nil {
			return err
		}
		if err := r.CommitMessages(ctx, m); err != nil { // commit FIRST => at-most-once
			return err
		}
		handle(m.Value) // if this crashes, the offset already advanced -> lost
	}
}
```

And the piece that turns at-least-once into *effectively exactly-once* — an idempotent consumer that deduplicates on a stable message id. This is the technique that matters most in practice:

```go
package delivery

import (
	"context"
	"database/sql"
)

// IdempotentApply makes an at-least-once handler safe against redelivery by
// recording processed message ids and doing the business effect in the SAME
// database transaction. If the message is delivered twice, the second attempt
// hits a duplicate-key on processed_messages and does nothing — the EFFECT
// happens exactly once even though DELIVERY was at-least-once.
func IdempotentApply(ctx context.Context, db *sql.DB, messageID string, effect func(*sql.Tx) error) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // no-op if we commit

	// Claim the id. processed_messages(message_id PRIMARY KEY). A duplicate
	// delivery fails this insert -> we treat it as already-done and skip.
	_, err = tx.ExecContext(ctx,
		`INSERT INTO processed_messages(message_id) VALUES ($1)`, messageID)
	if err != nil {
		// Unique-violation => already processed this message. Ack it and move on;
		// applying the effect again would be the double-charge bug.
		return nil
	}

	// First time we have seen this id: apply the business effect in the SAME
	// transaction, so the dedup record and the effect commit atomically. There
	// is no window where the effect happened but the id was not recorded.
	if err := effect(tx); err != nil {
		return err // rolls back BOTH the effect and the id claim; safe to retry
	}
	return tx.Commit()
}
```

The three ack strategies show the guarantee is a *timing* choice; `IdempotentApply` shows the escape hatch: at-least-once transport plus a transactional dedup makes the effect exactly-once. Kafka's transactions (chapter 20) generalise this for Kafka-to-Kafka flows, but the id-plus-transaction pattern here works on any broker.

## 6. Advantages, Disadvantages & Trade-offs

**At-most-once**
- *Advantages:* lowest latency and overhead; no redelivery, no duplicate handling, no dedup store; simplest consumer.
- *Disadvantages:* silently loses messages on any crash in the processing window; unacceptable for anything with a durable effect (payments, orders).

**At-least-once**
- *Advantages:* never loses a message; the practical default; simple to reason about (crash → redeliver); works on every broker.
- *Disadvantages:* delivers duplicates, so every consumer must be idempotent or tolerate repeats; redelivery storms possible if handlers are slow.

**Exactly-once (processing)**
- *Advantages:* the effect happens once despite an at-least-once transport — correctness for money-moving and stateful pipelines.
- *Disadvantages:* costs a dedup store or a transaction coordinator; Kafka transactions add latency and complexity and only cover Kafka-to-Kafka; external systems still need the outbox.

**Trade-offs**
- *Loss vs duplication:* the fundamental fork. At-most-once risks loss for speed; at-least-once risks duplication for safety. There is no wire-level option that risks neither.
- *Transport guarantee vs effect guarantee:* you can only cheaply get at-least-once *delivery*; exactly-once is always about the *effect*, bought with idempotency or a transaction on top.
- *Simplicity vs correctness:* at-most-once is simplest but lossy; exactly-once processing is most correct but adds a dedup/transaction layer. At-least-once plus idempotency is the pragmatic sweet spot almost everyone lands on.
- *Kafka transactions vs outbox:* transactions give clean exactly-once *within* Kafka but do not span external systems; the outbox spans the database boundary at the cost of a relay and downstream dedup.

## 7. Common Mistakes & Best Practices

- **Believing "exactly-once delivery" claims literally.** No broker delivers exactly once over the wire — the two generals problem forbids it. What is offered is exactly-once *processing* under specific conditions; know what those conditions are before relying on them.
- **Using auto-ack / commit-before-process for durable work.** Acking before processing is at-most-once — a crash loses the message. Fine for metrics, catastrophic for orders. Match the guarantee to the cost of loss.
- **At-least-once without idempotency.** Choosing at-least-once (correctly) but writing a non-idempotent handler, so a redelivery double-charges or double-sends. At-least-once *requires* an idempotent or dedup-ing consumer.
- **Deduplicating in a separate step from the effect.** Recording "processed" and applying the effect in two non-atomic operations reopens the exact gap you were closing — do both in one transaction.
- **Assuming Kafka transactions cover your database.** Kafka's exactly-once is Kafka-to-Kafka. A write to an external database is not in that transaction; you need the outbox pattern to bridge it.
- **Ignoring the producer side.** Delivery guarantees are decided at *both* ends. A carefully idempotent consumer behind a fire-and-forget producer can still lose messages the producer never confirmed.
- **Best practice: default to at-least-once + idempotent consumer.** Never lose data (at-least-once), then make the effect happen once (dedup on a stable id, in the same transaction as the effect). This gives exactly-once where it matters — the effect — on any broker.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Duplicate effects (a customer charged twice, two confirmation emails) are the classic symptom of at-least-once *without* idempotency — trace the message id through the logs and you will usually find a redelivery after a crash-before-ack. Lost messages (an order that vanished) point at at-most-once — an auto-ack or a commit-before-process somewhere. Carrying a stable message id in every message and logging it at produce, deliver and ack is what makes both diagnosable.
- **Monitoring.** Track **redelivery rate** (RabbitMQ) / **reprocessing** signals and the **dedup hit rate** in your idempotent consumer — a rising dedup hit rate means more redeliveries, an early sign of slow handlers or flapping consumers. On Kafka, watch **consumer lag** and, for transactional pipelines, transaction abort rates. A dedup store that grows unbounded is its own incident — give it a TTL sized to the maximum plausible redelivery window.
- **Security.** The dedup store is now part of your correctness boundary: if an attacker can forge message ids, they can either replay a message (reusing an id you already processed → silently dropped) or force reprocessing (a fresh id for an old effect). Ids must be produced by a trusted party and, ideally, be part of the message's authenticated payload. Treat the exactly-once machinery as security-relevant, not just correctness plumbing.
- **Scaling.** Idempotency has a cost that scales with throughput: every message incurs a dedup lookup/insert. At high volume that store (often a database table or a Redis set with TTL) becomes a hot path — partition it by the same key as the messages, keep the TTL tight, and prefer natural idempotency (an upsert keyed by a business id) over a separate dedup table where you can, since it removes the extra write entirely. Kafka transactions scale but add coordinator load and latency; reserve them for pipelines that genuinely need Kafka-to-Kafka exactly-once.

## 9. Interview Questions

**Q: What are the three delivery guarantees and what distinguishes them?**
A: At-most-once means every message is delivered zero or one times — never duplicated, but may be lost — obtained by acknowledging before processing or fire-and-forget. At-least-once means every message is delivered one or more times — never lost, but may be duplicated — obtained by acknowledging after successful processing, so a crash before the ack causes redelivery. Exactly-once means the effect happens once and only once — no loss, no duplication. The first two are decided purely by ack timing; the third is not achievable at the wire and must be built as exactly-once *processing* on top of at-least-once.

**Q: Why is exactly-once delivery impossible?**
A: Because of the two generals problem. Over an unreliable network, the sender cannot be certain the receiver got a message unless it receives an acknowledgement; but the receiver cannot be certain the sender got *that* acknowledgement unless it receives an ack of the ack, and so on without end. There is always a last message whose delivery is unconfirmed, so the sender must choose: assume it arrived (risk loss, at-most-once) or resend it (risk duplicate, at-least-once). No protocol avoids both risks, so a message crossing the wire exactly once with certainty is provably impossible. What is achievable is making the *effect* happen once despite duplicate deliveries.

**Q: What decides whether you get at-most-once or at-least-once?**
A: The timing of the acknowledgement relative to processing. If you ack before processing — auto-ack in RabbitMQ, or committing the offset before your handler runs in Kafka — the broker forgets the message immediately, so a crash during processing loses it: at-most-once. If you ack after successful processing, the broker keeps the message until the ack arrives, so a crash before the ack causes a redelivery: at-least-once. The same fork exists at the producer, between fire-and-forget and wait-for-confirm-then-retry. It is one timing decision, made at each end.

**Q: What is the difference between exactly-once processing and exactly-once delivery?**
A: Exactly-once delivery is about the wire — the message crosses once, no loss, no duplicate — and it is impossible over an unreliable network. Exactly-once processing is about the effect — no matter how many times the message is delivered, the observable outcome happens once. That is achievable: take an at-least-once transport, which may deliver a message several times, and either deduplicate on a stable message id (idempotency) or make the read-process-write atomic (a transaction) so duplicates are discarded. When someone says "exactly-once", they mean, or should mean, processing — built on top of at-least-once, never at the wire.

**Q: Why must an at-least-once consumer be idempotent?**
A: Because at-least-once, by definition, can deliver the same message more than once — specifically when the consumer crashes after processing but before its acknowledgement is recorded, so the broker redelivers on restart. If the handler is not idempotent, that second delivery applies the effect a second time: the card is charged twice, the email sent twice, the counter incremented twice. Making the consumer idempotent — deduplicating on a stable id, ideally in the same transaction as the effect — means the duplicate is delivered but not applied, which is what turns at-least-once into effectively exactly-once at the level that matters.

**Q: How do Kafka's idempotent producer and transactions help?**
A: The idempotent producer (`enable.idempotence=true`, default in modern Kafka) attaches a producer id and per-partition sequence numbers so the broker can detect and discard duplicate appends caused by producer retries — closing the duplication window on the *produce* side. Transactions (`transactional.id`) let a consume-transform-produce pipeline atomically commit both the produced records and the consumed offsets, so either the whole step commits or none of it does; downstream consumers reading with `isolation.level=read_committed` never see records from an aborted transaction. Together they give exactly-once *processing* for Kafka-to-Kafka flows. The limit is that they do not span external systems — a write to your own database is not in the transaction, so that boundary still needs the outbox pattern.

**Q: (Senior) A colleague says their new pipeline is "exactly-once, guaranteed". What questions do you ask?**
A: I would start by pinning down whether they mean delivery or processing, because exactly-once delivery is impossible and if they think they have it, they have misunderstood something. Assuming they mean processing, I would ask: what is the transport guarantee underneath — is it at-least-once, because exactly-once processing is always built on that? How is duplication actually suppressed — idempotent writes keyed by a business id, a dedup table, or Kafka transactions? If it is Kafka transactions, does the pipeline stay entirely within Kafka, or does it write to an external database or call a third-party API, because transactions do not cover those and I would expect to see an outbox pattern at that boundary? What is the dedup window and TTL, and what happens to a duplicate that arrives after the dedup record expires? Is the message id trustworthy and part of the authenticated payload? And what is the failure behaviour — does a crash mid-transaction cleanly abort? The answers usually reveal either a solid at-least-once-plus-idempotency design (good) or an assumption that the broker magically handles it (a latent double-effect bug). My goal is to locate exactly where the once-ness is enforced, because "guaranteed" without a named mechanism is a red flag.

**Q: (Senior) You have an at-least-once transport and must never double-charge a card. Design the consumer.**
A: The core is to make the charge idempotent and to record the idempotency in the same atomic unit as the charge itself, so there is no window where one happened without the other. Concretely: every message carries a stable, producer-assigned id (or I derive an idempotency key from the business event, like a payment-intent id). The consumer opens a database transaction, inserts the message id into a `processed_messages` table with a primary-key constraint, and if that insert fails with a unique violation, it treats the message as already handled, acknowledges it, and stops — no second charge. If the insert succeeds, it performs the charge (or records the intent to charge) *in the same transaction* and commits, so the dedup record and the effect are all-or-nothing. For the actual card call, which is an external system, I would not make the network call inside the database transaction; instead I would use the outbox pattern — commit the intent plus the id locally, then a relay makes the idempotent payment call using the same idempotency key, which the payment provider itself deduplicates. That gives two layers of protection: my dedup table stops reprocessing, and the provider's idempotency key stops a double charge even if my relay retries. I would give the dedup table a TTL longer than any plausible redelivery window, log the id at every hop for debugging, and alarm on a rising dedup-hit rate as an early signal of redelivery storms. The result is at-least-once delivery with an exactly-once effect, which is the only honest way to phrase the guarantee.

**Q: (Senior) When is at-most-once actually the right choice?**
A: When a lost message is genuinely cheaper than a slow or duplicated one, which is a real and legitimate class of workloads. High-frequency metrics, telemetry, live dashboards, and sampled logs are the classic cases: if you drop one data point out of a firehose because a consumer restarted, nobody notices and nothing is wrong, whereas paying the overhead of acknowledgements, redelivery handling, and a dedup store for that volume is pure waste and can itself become the bottleneck. At-most-once is also reasonable when the data is superseded quickly — the next position update, the next heartbeat, the next sensor reading makes the lost one irrelevant, so re-delivering a stale value would be worse than dropping it. The discipline is to choose it *deliberately*, after asking "what is the cost of losing this exact message?" and getting the answer "negligible, and it will be superseded". The mistake is defaulting to at-most-once (via auto-ack) for durable, non-superseded effects like orders or payments, where the answer to that question is "catastrophic". So at-most-once is correct precisely when loss is cheap and speed matters more than completeness.

**Q: Does making a consumer idempotent give you exactly-once, and how should you phrase the guarantee honestly?**
A: It gives you exactly-once at the level that actually matters — the *effect* — but not exactly-once delivery, and phrasing it precisely avoids misleading people. An idempotent consumer sits on top of an at-least-once transport that will still, physically, deliver the same message more than once when a crash lands between processing and the acknowledgement; the idempotency does not stop the duplicate delivery, it stops the duplicate *effect*, by deduplicating on a stable id (ideally in the same transaction as the effect) so the second delivery is recognised and skipped. So the honest phrasing is "at-least-once delivery with an exactly-once effect", or "effectively exactly-once processing", never "exactly-once delivery", because the wire is still at-least-once and always will be. This distinction is not pedantry: it tells the next engineer exactly where the once-ness is enforced — in your consumer's dedup logic, not in the broker or the network — which is precisely what they need to know to reason about failure modes, such as what happens if the dedup record expires before a very late duplicate arrives, or if the message id is not trustworthy. Naming the mechanism that provides the guarantee, rather than claiming a guarantee the transport cannot give, is the mark of someone who understands delivery semantics.

## 10. Quick Revision & Cheat Sheet

| Guarantee | Ack timing | Loss? | Duplicate? | Use for |
|---|---|---|---|---|
| **At-most-once** | Ack **before** process | Possible | Never | Metrics, telemetry, superseded data |
| **At-least-once** | Ack **after** process | Never | Possible | The default; needs idempotent consumer |
| **Exactly-once (processing)** | At-least-once + dedup/txn | Never | Never (effect) | Payments, stateful pipelines |

| System | At-most-once | At-least-once | Exactly-once processing |
|---|---|---|---|
| **RabbitMQ** | auto-ack | manual ack after process | at-least-once + idempotent consumer (+ outbox) |
| **Kafka** | commit before process | commit after process | idempotent producer + transactions (Kafka↔Kafka) |

**Flash cards**
- **What decides at-most vs at-least?** → Ack timing: before process (lose) vs after process (duplicate).
- **Is exactly-once delivery possible?** → No — two generals problem forbids it end-to-end.
- **What IS achievable?** → Exactly-once *processing*: at-least-once + idempotency/transaction.
- **Practical default?** → At-least-once + idempotent consumer.
- **Do Kafka transactions cover my DB?** → No — Kafka-to-Kafka only; external systems need the outbox.
- **How to make at-least-once safe?** → Dedup on a stable id in the same transaction as the effect.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement all three ack strategies on RabbitMQ (auto-ack, manual-ack-after, and manual-ack-after with dedup) and crash the consumer mid-handler to observe loss vs duplication vs correctness.
- [ ] Do the same on Kafka by moving the offset commit before and after the handler.
- [ ] Build an idempotent consumer that dedups on a message id in the same DB transaction as the effect; redeliver a message and confirm the effect happens once.
- [ ] Deliberately split dedup and effect into two non-atomic steps, crash between them, and observe the double-effect bug re-appear.
- [ ] Set up a Kafka consume-transform-produce with idempotent producer + transactions + `read_committed` and verify no aborted records are visible downstream.
- [ ] Write, in your own words, the two generals argument for why the pipeline you just built is still fundamentally at-least-once underneath.

### Mini Project — "Exactly-Once Where It Matters"

**Goal.** Build a payment-processing consumer that never loses and never double-charges on an at-least-once transport, proving that exactly-once *processing* is an architecture, not a broker checkbox.

**Requirements.**
1. Produce "charge requested" messages each carrying a stable idempotency key (payment-intent id).
2. Consume at-least-once (manual ack after process / commit after process).
3. In one database transaction: claim the idempotency key (primary-key insert), record the charge intent, and commit; on a unique-violation, treat as already-done and ack.
4. Relay the charge to a (mock) payment provider using the outbox pattern with the same idempotency key, so the provider also dedups; make the relay retry and confirm no double charge.
5. Force redeliveries (kill the consumer after the effect, before the ack) and prove the effect happens exactly once; instrument the dedup-hit rate.

**Extensions.**
- Give the dedup store a TTL and demonstrate the failure mode when a duplicate arrives after expiry; size the TTL to the worst-case redelivery window.
- Replace the DB dedup with Kafka transactions for a Kafka-to-Kafka variant and contrast where each approach's guarantee ends (external boundary vs Kafka boundary).

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is a Message Queue?* (the ack is where correctness lives), *Idempotency, Deduplication & the Outbox Pattern* (making at-least-once safe, in depth), *Kafka Transactions & Exactly-Once Semantics* (the Kafka-to-Kafka machinery, chapter 20), *Backpressure, Flow Control & Poison Messages* (redelivery storms and DLQs), *Design: Kafka vs RabbitMQ* (how each broker exposes these knobs).

- **You Cannot Have Exactly-Once Delivery** — Tyler Treat (Brave New Geek) · *Advanced* · the clearest essay on why exactly-once delivery is impossible and idempotency is the real answer. <https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/>
- **Exactly-Once Semantics in Apache Kafka** — Confluent · *Advanced* · the design of idempotent producers and transactions, and precisely what "exactly-once" covers. <https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/>
- **Apache Kafka — Documentation: Message Delivery Semantics** — Apache · *Intermediate* · the at-most/at-least/exactly-once model from the source, tied to acks and offsets. <https://kafka.apache.org/documentation/#semantics>
- **RabbitMQ — Consumer Acknowledgements and Publisher Confirms** — RabbitMQ · *Intermediate* · manual ack, requeue, and confirms — the mechanics of at-least-once on RabbitMQ. <https://www.rabbitmq.com/docs/confirms>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · delivery semantics, idempotence and exactly-once in the broader systems context. <https://dataintensive.net/>
- **The Two Generals Problem** — Wikipedia · *Intermediate* · the impossibility result underpinning why delivery cannot be exactly-once; the theory in one page. <https://en.wikipedia.org/wiki/Two_Generals%27_Problem>
- **Idempotent Receiver** — Enterprise Integration Patterns (Hohpe & Woolf) · *Intermediate* · the canonical pattern for making an at-least-once consumer safe. <https://www.enterpriseintegrationpatterns.com/patterns/messaging/IdempotentReceiver.html>
- **Transactional Outbox** — microservices.io (Chris Richardson) · *Intermediate* · bridging the broker's exactly-once to an external database, the dual-write fix. <https://microservices.io/patterns/data/transactional-outbox.html>

---

*Kafka & RabbitMQ Handbook — chapter 04.*
