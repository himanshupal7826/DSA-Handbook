# 30 · Design: Messaging Interview Questions & System Design Rounds

> **In one line:** A messaging design round is not a Kafka-versus-RabbitMQ trivia quiz — it tests whether you can derive a topology from a workload, name the decisions that cannot be undone (broker, partition key, delivery model), and defend the failure behaviour out loud.

---

## 1. Overview

This is the synthesis chapter. Everything in the previous twenty-nine — the three messaging models, the delivery semantics, RabbitMQ's exchanges and Kafka's log, replication and ordering and idempotency — exists somewhere in a real design round, and the job here is to organise it into something you can execute under time pressure.

Interviews at different levels probe different things. **Mid-level** tests mechanics: can you explain a consumer group, choose an exchange type, describe at-least-once? **Senior** tests judgement: why *this* broker, why *this* partition key, what breaks at 10×, which decisions are irreversible? **Staff and principal** tests consequence: how does this topology evolve as the organisation grows, what is the migration, what is the failure mode you would page on, and what is the blast radius of getting the key wrong?

The single behaviour that separates a strong round from a weak one is **naming the irreversible decisions early**. A large fraction of messaging design is hard to change once running: the choice of broker, the partition count and partition key (which together fix your ordering guarantee and consumer parallelism), and the delivery model. A candidate who says "these three I want to get right now, the rest we can tune" has demonstrated more than one who produces a longer topology diagram. The second strongest behaviour is **stating a trade-off before being asked** — "I'm choosing at-least-once with idempotent consumers, which costs me a dedup store but avoids the throughput and fragility of transactions" — because that is exactly what shipping a real system sounds like.

This chapter gives a repeatable procedure, three worked designs at increasing difficulty, and a question bank organised by what it is actually testing.

## 2. Core Concepts

- **Design round** — 45 minutes, open-ended, judged on reasoning rather than a single correct answer.
- **The irreversible set** — decisions that are painful or impossible to change once the system is running: broker, partition count/key, delivery model.
- **Workload-driven topology** — deriving topics/partitions or exchanges/queues from the message rate, ordering needs and fan-out, not from a template.
- **Delivery contract** — the chosen semantics (at-least-once + idempotent consumers, or exactly-once) and what each costs.
- **Ordering boundary** — where order holds (a partition, a single-consumer queue) and where it breaks, set by the partition/routing key.
- **Failure vocabulary** — how retries, dead-letter queues, poison messages and rebalances are handled, decided up front.
- **Durability contract** — replication factor, `min.insync.replicas` or quorum, and `acks`, and the data-loss window on failover.
- **Back-pressure plan** — what happens when consumers fall behind: lag, prefetch/flow control, and the drain time.
- **The 10× question** — what breaks first when volume multiplies, and how you would detect and fix it.
- **Blast radius** — what a wrong key, a lost message, or a broker outage does to the rest of the system.

## 3. Theory & Principles

### The ten-step procedure

Work these in order. Steps 1–3 take ten minutes and determine everything else.

1. **Clarify the workload.** Message rate (per second, peak vs average), payload size, fan-out (how many consumers react), ordering needs, latency SLO, and — crucially — *how bad is a lost message, and how bad is a duplicate?* This last question decides the delivery contract.
2. **Choose the broker and model.** Kafka's retained log for event streaming, replay, high-throughput fan-out and a system of record; RabbitMQ's queues and exchanges for complex routing, task distribution, per-message priority/TTL, and RPC. Justify it against the retention and routing needs, not by preference.
3. **Design the topology.** Kafka: topics and partition count, and *the partition key* — because the key fixes both ordering (same key, same partition, ordered) and the maximum consumer parallelism (partition count). RabbitMQ: exchanges, queues, bindings and routing keys. This is where the irreversible decisions are made.
4. **Pick the delivery contract.** At-least-once with idempotent consumers is the pragmatic default; exactly-once (Kafka transactions / Streams) only for Kafka-internal pipelines where it is worth the cost. State what you accept.
5. **Plan ordering and keys.** What must be ordered, at what granularity (per-user, per-account), and the key that guarantees it — and acknowledge where global ordering would cost all your parallelism.
6. **Handle failure.** Retries with backoff, a dead-letter queue/topic for poison messages, and the consumer crash/rebalance behaviour. Every consumer needs a poison escape hatch.
7. **Size durability and HA.** Replication factor, `acks=all` + `min.insync.replicas` (Kafka) or quorum queues (RabbitMQ), and the acknowledged-data-loss window on failover.
8. **Plan back-pressure and lag.** Prefetch/flow control, consumer lag as the health signal, and what the backlog and drain time look like if consumers fall behind at peak.
9. **Observe and operate.** Consumer lag above all, throughput, under-replicated partitions / queue depth, DLQ growth, and rebalance storms — and the alerts that page someone.
10. **The 10× question.** What breaks first, how you detect it, what you do — usually the partition count capping parallelism, a hot partition from a skewed key, or the broker's disk/throughput.

### What interviewers are scoring

| Signal | Weak | Strong |
|---|---|---|
| Requirements | Starts drawing topics immediately | Asks rate, ordering, loss/duplicate tolerance first |
| Broker choice | "Kafka, it's standard" | Justifies via retention, routing and fan-out needs |
| Topology | Arbitrary partition count | Partition count from throughput; key from ordering need |
| Irreversibility | Treats everything as tunable | Names broker, key and delivery model as hard to undo |
| Delivery | "It's reliable" | At-least-once + idempotent consumers, stated with its cost |
| Ordering | Assumes global order | Per-key order, and the parallelism cost of global order |
| Failure | Ignores poison messages | Retry + DLQ + rebalance behaviour, designed in |
| Trade-offs | Only upsides | States what each choice gave up, unprompted |
| Scale | "Add brokers" | Names the specific first bottleneck and its signal |

The two cheapest strong moves: **name the irreversible decisions**, and **state a trade-off before being asked**.

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The irreversible set: decide these in the first ten minutes</text>

  <rect x="24" y="42" width="410" height="270" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Painful / impossible to change once running</text>
  <g font-size="10">
    <text x="42" y="90" fill="#7f1d1d" font-weight="bold">Broker choice</text>
    <text x="180" y="90" fill="#991b1b">retained log vs smart broker &#8212; a whole rewrite to swap</text>
    <text x="42" y="112" fill="#7f1d1d" font-weight="bold">Partition count</text>
    <text x="180" y="112" fill="#991b1b">you can ADD but not easily remove; caps consumer parallelism</text>
    <text x="42" y="134" fill="#7f1d1d" font-weight="bold">Partition / routing key</text>
    <text x="180" y="134" fill="#991b1b">fixes ordering AND which messages co-locate</text>
    <text x="42" y="156" fill="#7f1d1d" font-weight="bold">Delivery model</text>
    <text x="180" y="156" fill="#991b1b">at-least-once vs exactly-once shapes every consumer</text>
    <text x="42" y="178" fill="#7f1d1d" font-weight="bold">Ordering guarantee</text>
    <text x="180" y="178" fill="#991b1b">per-key vs global &#8212; global costs ALL parallelism</text>
    <text x="42" y="200" fill="#7f1d1d" font-weight="bold">Message schema / format</text>
    <text x="180" y="200" fill="#991b1b">a contract many consumers depend on (ch26)</text>
  </g>
  <text x="42" y="234" fill="#b91c1c" font-size="10" font-weight="bold">Changing the partition key later means:</text>
  <text x="42" y="252" fill="#991b1b" font-size="10">re-partitioning history, breaking every consumer's ordering</text>
  <text x="42" y="268" fill="#991b1b" font-size="10">assumption, and often a full topic migration.</text>
  <text x="42" y="294" fill="#7f1d1d" font-size="10" font-weight="bold">Saying "these are the ones I want right now" is the</text>
  <text x="42" y="308" fill="#7f1d1d" font-size="10" font-weight="bold">strongest cheap signal in the round.</text>

  <rect x="446" y="42" width="410" height="270" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Can tune later</text>
  <g font-size="10" fill="#166534">
    <text x="464" y="90">&#8226; consumer count (up to the partition count)</text>
    <text x="464" y="112">&#8226; retention period, compaction policy</text>
    <text x="464" y="134">&#8226; batching, linger, compression (throughput knobs)</text>
    <text x="464" y="156">&#8226; prefetch / flow-control settings</text>
    <text x="464" y="178">&#8226; replication factor (can increase; rebalances data)</text>
    <text x="464" y="200">&#8226; monitoring, alerting thresholds</text>
    <text x="464" y="222">&#8226; retry backoff and DLQ handling</text>
    <text x="464" y="244">&#8226; adding consumers / new consumer groups (fan-out)</text>
  </g>
  <text x="464" y="278" fill="#15803d" font-size="10" font-weight="bold">Spending round time here is a mistake &#8212; it is</text>
  <text x="464" y="292" fill="#15803d" font-size="10" font-weight="bold">visible work that costs nothing to change later.</text>

  <rect x="24" y="330" width="832" height="140" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="440" y="352" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">Three questions that end weak answers</text>
  <text x="40" y="378" fill="#713f12" font-weight="bold">1. "How bad is a lost message vs a duplicate?"</text>
  <text x="40" y="394" fill="#854d0e">Decides the delivery contract. Most systems: at-least-once + idempotent consumers. "It's reliable" is not an answer.</text>
  <text x="40" y="418" fill="#713f12" font-weight="bold">2. "What must be ordered, and at what granularity?"</text>
  <text x="40" y="434" fill="#854d0e">The partition key follows from this. Global ordering = one partition = one consumer = no parallelism.</text>
  <text x="40" y="458" fill="#713f12" font-weight="bold">3. "What breaks first at 10&#215;?"</text>
</svg>
```

### The three questions that end weak answers

Interviewers use these because they cannot be answered from memory:

1. **"How bad is a lost message versus a duplicate?"** This decides the delivery contract. If losing a message is catastrophic (a payment) you need at-least-once and durable acks; if duplicates are catastrophic and losses tolerable (some idempotent-hard side effect) the answer differs. Most systems land on at-least-once with idempotent consumers. "It's reliable" is not an answer.
2. **"What must be ordered, and at what granularity?"** The partition key follows directly. Per-user ordering means keying by user id; global ordering means a single partition, which means a single consumer and no parallelism — a trade you must name, not stumble into.
3. **"What breaks first at 10×?"** For most messaging systems the honest answer is the partition count capping consumer parallelism, or a hot partition from a skewed key, and the detection signal is rising consumer lag concentrated on specific partitions.

## 4. Architecture & Workflow

The 45-minute budget:

| Time | Activity |
|---|---|
| 0–5 | Clarify rate, payload, fan-out, ordering, latency SLO, loss/duplicate tolerance |
| 5–12 | Choose broker + model; sketch the topology and the partition/routing key |
| 12–20 | The irreversible set: broker, partition count, key, delivery model |
| 20–28 | Delivery contract, ordering, failure handling (retry/DLQ/rebalance) |
| 28–36 | Durability/HA (RF, min.insync/quorum, acks), back-pressure and lag |
| 36–42 | Observability and the 10× question |
| 42–45 | Trade-offs and what you would do differently |

```svg
<svg viewBox="0 0 880 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="ir1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The 45-minute shape</text>

  <rect x="24" y="44" width="126" height="56" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="87" y="64" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">0&#8211;5 min</text>
  <text x="87" y="80" text-anchor="middle" fill="#1d4ed8" font-size="8">rate, payload, fan-out,</text>
  <text x="87" y="92" text-anchor="middle" fill="#1d4ed8" font-size="8">ordering, loss/dup tolerance</text>
  <path d="M152,72 L170,72" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ir1)"/>

  <rect x="174" y="44" width="126" height="56" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="237" y="64" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">5&#8211;12 min</text>
  <text x="237" y="80" text-anchor="middle" fill="#166534" font-size="8">broker + model,</text>
  <text x="237" y="92" text-anchor="middle" fill="#166534" font-size="8">topology + THE KEY</text>
  <path d="M302,72 L320,72" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ir1)"/>

  <rect x="324" y="44" width="146" height="56" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="397" y="64" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">12&#8211;20 min</text>
  <text x="397" y="80" text-anchor="middle" fill="#991b1b" font-size="8">THE IRREVERSIBLE SET:</text>
  <text x="397" y="92" text-anchor="middle" fill="#991b1b" font-size="8">broker, partitions, key, delivery</text>
  <path d="M472,72 L490,72" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ir1)"/>

  <rect x="494" y="44" width="126" height="56" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="557" y="64" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">20&#8211;28 min</text>
  <text x="557" y="80" text-anchor="middle" fill="#b45309" font-size="8">delivery, ordering,</text>
  <text x="557" y="92" text-anchor="middle" fill="#b45309" font-size="8">failure (retry/DLQ/rebalance)</text>
  <path d="M622,72 L640,72" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ir1)"/>

  <rect x="644" y="44" width="120" height="56" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="704" y="64" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">28&#8211;36 min</text>
  <text x="704" y="80" text-anchor="middle" fill="#6d28d9" font-size="8">durability/HA,</text>
  <text x="704" y="92" text-anchor="middle" fill="#6d28d9" font-size="8">back-pressure + lag</text>
  <path d="M766,72 L784,72" stroke="#0ea5e9" stroke-width="2" marker-end="url(#ir1)"/>

  <rect x="788" y="44" width="68" height="56" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="822" y="64" text-anchor="middle" fill="#334155" font-size="10" font-weight="bold">36&#8211;45</text>
  <text x="822" y="80" text-anchor="middle" fill="#475569" font-size="8">observe,</text>
  <text x="822" y="92" text-anchor="middle" fill="#475569" font-size="8">10&#215;, trade-offs</text>

  <rect x="24" y="120" width="832" height="86" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="142" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Draw the topology visibly &#8212; and annotate each edge</text>
  <text x="48" y="166" fill="#475569">Producers &#8594; topics/exchanges &#8594; partitions/queues &#8594; consumers &#8594; DLQ, with each edge labelled with its DELIVERY CONTRACT</text>
  <text x="48" y="184" fill="#475569">(at-least-once + idempotent, or exactly-once) and its ORDERING GUARANTEE (per-key on partition P). A concrete diagram gives</text>
  <text x="48" y="200" fill="#334155" font-weight="bold">the interviewer something to probe &#8212; and forces you to make the correctness properties legible rather than implied.</text>

  <rect x="24" y="222" width="832" height="82" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="440" y="244" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">The two cheapest strong moves</text>
  <text x="48" y="268" fill="#713f12">1. NAME the irreversible decisions early: "the broker, the partition key and the delivery model I want to fix now; the rest we tune."</text>
  <text x="48" y="290" fill="#713f12">2. STATE a trade-off before being asked: "at-least-once + idempotent consumers &#8212; costs a dedup store, avoids transaction fragility."</text>
</svg>
```

Two habits that consistently help. **Draw the topology visibly** — producers, topics/exchanges, partitions/queues, consumers, DLQ — because it gives the interviewer something concrete to probe. And **annotate each edge with its delivery contract and ordering guarantee**, so the design's correctness properties are legible rather than implied.

## 5. Implementation

The most useful artefact for a design round is not more topology code — it is a small, defensible *idempotent consumer*, because "at-least-once with idempotent consumers" is the answer to the delivery question in most rounds, and being able to write it concretely proves you understand what that contract actually requires.

```go
package designround

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// IdempotentConsumer is the pattern that makes at-least-once delivery safe, and
// therefore the delivery contract most design rounds land on. The key idea: a
// message may be delivered more than once (crash-before-ack, rebalance, retry),
// so processing must be safe to run twice for the same message id.
type IdempotentConsumer struct {
	db *sql.DB // the source of truth AND the dedup record, in ONE transaction
}

// Process handles a message exactly-once IN EFFECT, even though delivery is
// at-least-once. The dedup check and the business effect commit together, so a
// crash cannot leave one done without the other.
func (c *IdempotentConsumer) Process(ctx context.Context, messageID string, apply func(*sql.Tx) error) error {
	tx, err := c.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback() // no-op after a successful commit

	// 1. Atomically record that we have SEEN this message id. A UNIQUE
	//    constraint on message_id makes a duplicate insert fail, which is how
	//    we detect a redelivery. Doing this in the SAME transaction as the
	//    business effect is what gives effective exactly-once: either both the
	//    dedup row and the effect commit, or neither does.
	_, err = tx.ExecContext(ctx,
		`INSERT INTO processed_messages (message_id, processed_at) VALUES ($1, $2)`,
		messageID, time.Now())
	if err != nil {
		if isUniqueViolation(err) {
			// Already processed — this is a DUPLICATE delivery. Ack it and do
			// nothing. This is the whole point: the redelivery is a safe no-op.
			return nil
		}
		return err
	}

	// 2. Apply the business effect in the SAME transaction. If this fails, the
	//    dedup row is rolled back too, so the message is NOT marked processed
	//    and a redelivery will retry it correctly.
	if err := apply(tx); err != nil {
		return err
	}

	// 3. Commit both together. Only now is the message truly processed. If we
	//    crash before the broker ack, the broker redelivers; step 1 then sees
	//    the committed dedup row and safely skips.
	return tx.Commit()
}

// The dedup table needs a retention policy: processed_messages grows forever
// without one. Prune rows older than the maximum possible redelivery window
// (broker retention + retry budget), so the table stays bounded.
func (c *IdempotentConsumer) PruneOldDedupRecords(ctx context.Context, olderThan time.Duration) error {
	_, err := c.db.ExecContext(ctx,
		`DELETE FROM processed_messages WHERE processed_at < $1`,
		time.Now().Add(-olderThan))
	return err
}

func isUniqueViolation(err error) bool {
	// Postgres: pgerrcode.UniqueViolation "23505"; simplified here.
	var target interface{ SQLState() string }
	return errors.As(err, &target) && target.SQLState() == "23505"
}
```

The three things this code proves you understand: at-least-once means duplicates are *normal*, not exceptional; the dedup record and the business effect must commit *together* or a crash desynchronises them; and the dedup store needs a *retention policy* bounded by the redelivery window. A candidate who can write this confidently has answered the "how do you make it reliable?" question far more convincingly than one who says "exactly-once".

## 6. Advantages, Disadvantages & Trade-offs

**What the procedure gives you**
- **A defensible order** — requirements before topology, irreversible decisions before tunable ones.
- **Visible artefacts** — the topology diagram with delivery contracts annotated gives the interviewer something to probe.
- **Time discipline** — 45 minutes forces prioritisation onto the decisions that matter.
- **Trade-off vocabulary** — every choice has a named cost, which is what senior signal sounds like.

**Where it can go wrong**
- **Over-structuring.** Reciting a procedure without engaging the specific problem reads as rehearsed.
- **Too long on requirements.** Five minutes, not fifteen; the interviewer wants to see design.
- **Depth in the comfortable area.** Twenty minutes on partition math and none on failure handling is a common imbalance.

**Trade-offs in the round itself**
- *Breadth vs depth:* covering the ten steps shallowly beats three steps deeply, because the round scores judgement across the surface; go deep only where probed.
- *Ideal vs pragmatic:* proposing exactly-once everywhere signals poor judgement; at-least-once + idempotent consumers is the pragmatic default and saying so is a strength.
- *Confidence vs honesty:* "I don't know, here's how I'd find out" is a strong answer; bluffing a number is the weakest thing you can do.

## 7. Common Mistakes & Best Practices

- **Choosing the broker by fashion.** "Kafka because it's standard" without weighing retention, routing and fan-out needs. RabbitMQ is the better answer for complex routing and task queues.
- **Picking a partition count arbitrarily.** It caps consumer parallelism and is painful to reduce; derive it from target throughput divided by per-partition throughput, with headroom.
- **Ignoring the partition key.** The key fixes ordering and co-location; choosing it carelessly causes hot partitions or breaks the ordering a consumer assumed.
- **Claiming exactly-once reflexively.** It is costly, Kafka-internal only, and usually unnecessary; at-least-once + idempotent consumers is the pragmatic answer and stating its cost is a strength.
- **Forgetting poison messages.** A message that always fails, retried forever, blocks the partition or queue. Every consumer needs a retry-with-backoff + DLQ path.
- **Assuming global ordering is free.** It requires a single partition and a single consumer, forfeiting all parallelism. Name the trade explicitly.
- **Not naming the 10× bottleneck.** "Add brokers" is weak; name the specific first constraint (partition count, hot partition, disk) and its detection signal (consumer lag).
- **Best practice: name the irreversible decisions and state trade-offs unprompted.** The two cheapest ways to sound like someone who has shipped a real messaging system.

## 8. Production: Debugging, Monitoring, Security & Scaling

These four are where senior rounds spend their last fifteen minutes, and where candidates are thinnest.

- **Debugging.** Be able to say concretely: consumer lag per partition to find a slow or stuck consumer; the DLQ to inspect poison messages; under-replicated partitions to spot broker trouble; a correlation id carried through the message to trace a logical operation across producer, broker and consumer.
- **Monitoring.** Consumer lag above all — rising lag concentrated on specific partitions localises the problem instantly. Then under-replicated partitions (the key broker alert), queue depth (RabbitMQ), DLQ growth, and rebalance rate. Say what pages someone and what merely graphs.
- **Security.** TLS for encryption, SASL/mTLS for authentication, ACLs for authorization, and multi-tenant isolation via topic/vhost naming plus quotas — and the historical trap that brokers are insecure by default, so an exposed unauthenticated broker is a breach.
- **Scaling.** The honest first bottleneck is usually the partition count capping consumer parallelism or a hot partition from a skewed key; after that the broker's disk throughput and network. Say how you would verify — lag concentrated on partitions, disk and network saturation on specific brokers — rather than "add capacity".

## 9. Interview Questions

**Q: Walk me through how you would approach a messaging system design.**
A: I start by clarifying the workload — message rate at peak and average, payload size, how many consumers fan out, what must be ordered, the latency SLO, and above all how bad a lost message is versus a duplicate, because that decides the delivery contract. Then I choose the broker and model: Kafka's retained log for event streaming, replay and high-throughput fan-out, or RabbitMQ's queues and exchanges for complex routing, task distribution and per-message semantics. Then the topology — for Kafka, the partition count and the partition key, which together fix ordering and consumer parallelism; for RabbitMQ, the exchanges, queues and routing keys. Those are the irreversible decisions, so I name them explicitly. After that: the delivery contract (usually at-least-once with idempotent consumers), ordering and keys, failure handling with retries and a dead-letter queue, durability and HA with replication and acks, back-pressure and lag, and observability. I finish with what breaks first at 10×. The thing I emphasise is that the broker, the partition key and the delivery model are hard to change later, so I get those right before tuning anything else.

**Q: How do you decide between Kafka and RabbitMQ?**
A: By the retention and routing needs, not by preference. Kafka is the right answer when you need a retained, replayable log — event streaming, a CDC or integration backbone, replay after a bug, multiple independent consumer groups reading the same high-throughput stream, or a system of record. RabbitMQ is the right answer when you need complex, attribute-based routing — topic and headers exchanges — or task queues with competing consumers, per-message priority and TTL, RPC, or lower-volume workloads with rich per-message semantics, and when you do not need replay. The deepest distinguishing question is whether messages must survive being consumed so they can be re-read: if yes, the log; if no, the smart broker. Many mature systems run both — Kafka for the event backbone, RabbitMQ for task distribution and routing — and saying so signals that the choice is per-use-case, not a religion.

**Q: What are the irreversible decisions in a messaging design?**
A: The broker, because swapping the log model for the smart-broker model or vice versa is essentially a rewrite. The partition count, because you can add partitions but not easily remove them, and it caps your maximum consumer parallelism per group. The partition or routing key, because it fixes both the ordering guarantee — same key, same partition, ordered — and which messages co-locate, so changing it later means re-partitioning history and breaking every consumer's ordering assumption. And the delivery model, because at-least-once versus exactly-once shapes every consumer's code. The message schema is a fifth, since it is a contract many consumers depend on. Everything else — consumer count, retention, batching, replication factor, monitoring — is tunable, so I spend the round's scarce time on the irreversible set.

**Q: What delivery contract do you default to, and why?**
A: At-least-once with idempotent consumers. Exactly-once delivery is impossible over an unreliable network, and Kafka's exactly-once processing is real but Kafka-internal only, costly, and fragile to misconfigure — it does nothing for the external systems most pipelines touch. At-least-once is the natural default: the consumer acknowledges only after successfully processing, so a crash redelivers rather than loses. The cost is that duplicates are normal, so the consumer must be idempotent — deduplicating on a stable message id, ideally recording the dedup and the business effect in one transaction so a crash cannot desynchronise them. This gives effective exactly-once end to end without the throughput and complexity cost of transactions, and it works uniformly across Kafka, RabbitMQ and any external system, which is why I standardise on it unless a pipeline is purely Kafka-to-Kafka and genuinely warrants transactions.

**Q: How does the partition key relate to ordering and scaling?**
A: The key is the single decision that ties them together. Kafka guarantees order only within a partition, and a message's key hashes to a partition, so all messages with the same key land on the same partition and are therefore ordered relative to each other. That means you get ordering at exactly the granularity of your key: keying by user id orders each user's events; keying by nothing orders nothing across the topic. Global ordering requires a single partition, which means a single consumer and no parallelism — the fundamental order-versus-throughput trade. Scaling is capped by the partition count, because within a consumer group at most one consumer reads each partition, so parallelism can never exceed the number of partitions. And a skewed key — one value far more frequent than others — creates a hot partition that concentrates load and cannot be spread, so the key must both give the ordering you need and distribute load evenly.

**Q: What breaks first when a messaging system goes to 10× traffic?**
A: Almost always the partition count capping consumer parallelism, or a hot partition from a skewed key. Because at most one consumer per partition reads within a group, once you have as many consumers as partitions you cannot add more parallelism without adding partitions — and adding partitions changes the key-to-partition mapping, disrupting ordering. A skewed key is worse: it concentrates load on one partition that a single consumer must drain, so that partition's lag climbs while others stay flat. The detection signal is consumer lag concentrated on specific partitions rather than spread evenly. After partitioning, the next bottleneck is usually the broker's disk throughput and network bandwidth. So my answer names the specific constraint and its signal — lag on particular partitions, disk and network saturation on particular brokers — rather than "add capacity", and I plan the partition count with headroom precisely because it is the first and hardest-to-change limit.

**Q: (Senior) Design an order-processing pipeline and defend the hard parts.**
A: Orders flow from checkout through validation, payment, inventory and fulfilment, and the hard parts are ordering, exactly-once effects, and failure isolation. I would use Kafka, because I want a retained log that multiple services can consume independently and replay after a bug, and because order events are a natural system of record. The partition key is the order id (or the customer id if I need per-customer ordering of related orders), so all events for one order are ordered on one partition — this is the irreversible decision I name first, because payment-before-fulfilment ordering depends on it. Delivery is at-least-once with idempotent consumers everywhere, because payment and inventory effects must not double-apply: each consumer deduplicates on the event id and commits the dedup record with the business effect in one database transaction, so a redelivery is a safe no-op. For the payment step specifically, the external payment API is outside any Kafka transaction, so I use an idempotency key on the API call — Kafka's exactly-once would not cover it. Failure handling: a poison order event (one that always fails validation) goes to a dead-letter topic after bounded retries with backoff, so it does not block its partition, and it is alerted for manual inspection. Durability is replication factor 3 with acks=all and min.insync.replicas=2, so an acknowledged order survives one broker loss. The dual-write at the source — the checkout service writing its database and publishing the order event — I close with the outbox pattern, writing the order and the outbox row atomically and relaying via CDC, so the event is published if and only if the order committed. The trade I state unprompted: keying by order id means I cannot trivially parallelise a single huge order's events, but that is not a real workload, whereas per-order ordering is essential, so it is the right trade.

**Q: (Senior) Design a real-time analytics firehose ingesting millions of events per second.**
A: This is a throughput-and-fan-out problem where some loss is tolerable and duplicates are harmless if the analytics are idempotent, which changes the contract meaningfully. Kafka is the clear choice — the retained log, high sequential-write throughput, and the ability to have many independent consumer groups (real-time dashboards, a batch warehouse loader, an anomaly detector) each read the whole stream. The topology centres on partition count for parallelism: I size it from target throughput divided by per-partition throughput with generous headroom, because at millions of events per second the partition count is the parallelism ceiling and I would rather over-provision it than re-partition later. The partition key depends on the aggregation — if dashboards aggregate per-tenant, I key by tenant id so a tenant's events are ordered and co-located, but I watch for a hot tenant creating a hot partition and would fall back to a composite key or random partitioning if ordering is not needed. Delivery is at-least-once, and crucially the analytics consumers are made idempotent by design — counting into aggregates keyed by event id, or using a dedup window — so duplicates from redelivery do not corrupt counts; for pure counting I might even accept at-most-once for the lowest latency if a fraction of a percent of loss is within the analytics error bar, which is a legitimate trade at this scale. Producers batch aggressively with linger and lz4 compression to hit throughput, accepting a few milliseconds of added latency. Retention is short — hours to days — because the warehouse is the long-term store and the log is a buffer. The back-pressure story is that consumers pull at their own rate, so lag is the signal, and if the batch loader falls behind it simply catches up from the retained log without back-pressuring the producers. The 10× answer: the first bottleneck is partition count and broker network, and I would detect it as rising lag and network saturation, and scale by adding partitions (planned for) and brokers. The trade I name: keying by tenant risks a hot partition, so I explicitly decide whether per-tenant ordering is worth that risk or whether random partitioning with idempotent aggregation is safer for a firehose.

**Q: (Senior) A consumer group is stuck in a rebalance storm. How do you diagnose and fix it?**
A: A rebalance storm — the group repeatedly rebalancing and making little progress — is one of the most common consumer-group pathologies, and it almost always traces to a member being repeatedly declared dead and rejoining. My first check is whether processing time per poll exceeds `max.poll.interval.ms`: if a consumer takes longer to process a batch than that interval, the coordinator considers it dead, revokes its partitions, triggers a rebalance, and then the consumer rejoins — over and over. The fix there is to reduce `max.poll.records` so each poll processes less, or raise `max.poll.interval.ms`, or move slow processing off the poll thread. Second, I check `session.timeout.ms` against heartbeat behaviour and network stability — a flaky network or GC pauses longer than the session timeout cause the same death-and-rejoin cycle. Third, I check whether consumers are crashing and restarting for an unrelated reason (an OOM, an unhandled poison message), because each restart is a membership change that rebalances. The structural fixes are the cooperative-sticky assignor, so a rebalance only moves the partitions that must move rather than stopping the whole group, and static membership via `group.instance.id`, so a consumer restarting within the session timeout does not trigger a rebalance at all — which alone eliminates the storm from rolling restarts. I would confirm the diagnosis with the consumer logs (they log every rebalance and the reason), the rebalance-rate metric, and per-consumer processing latency, and I would treat a poison message that keeps crashing a consumer as a first-class cause, routing it to a DLQ so one bad message cannot storm the whole group. The general lesson I would state is that a rebalance storm is a symptom, and the discipline is to find *which* member keeps leaving and *why*, rather than blindly tuning timeouts.

## 10. Quick Revision & Cheat Sheet

**The 10-step procedure**
1. Clarify workload (rate, payload, fan-out, ordering, SLO, **loss/dup tolerance**) → 2. Broker + model → 3. Topology + **the key** → 4. Delivery contract → 5. Ordering + keys → 6. Failure (retry/DLQ/rebalance) → 7. Durability/HA (RF, min.insync/quorum, acks) → 8. Back-pressure + lag → 9. Observe → 10. The 10× question.

**The irreversible set**

| Decision | Why permanent |
|---|---|
| Broker | Model swap ≈ rewrite |
| Partition count | Add but not remove; caps parallelism |
| Partition/routing key | Fixes ordering + co-location |
| Delivery model | Shapes every consumer |
| Schema/format | Contract many consumers depend on |

**Broker choice**

| Need | Choose |
|---|---|
| Replay, event streaming, system of record, high fan-out throughput | Kafka |
| Complex routing, task queues, priority/TTL, RPC, lower volume | RabbitMQ |

**Flash cards**
- **First question in a round?** → Rate, ordering, and how bad is a lost message vs a duplicate?
- **Strongest cheap signal?** → Naming the irreversible decisions (broker, key, delivery model).
- **Default delivery contract?** → At-least-once + idempotent consumers; state its cost.
- **Ordering vs scaling link?** → The partition key; global order = one partition = no parallelism.
- **First bottleneck at 10×?** → Partition count / hot partition; signal is lag on specific partitions.
- **Second-strongest signal?** → Stating a trade-off before being asked.

## 11. Hands-On Exercises & Mini Project

- [ ] Run the 10-step procedure against a system you know, timed to 45 minutes; note where you ran out of time.
- [ ] For three real message flows, name the decisions that could not now be changed without a migration.
- [ ] Write out the delivery contract and ordering guarantee for each edge of a design, and check every consumer has a poison-message path.
- [ ] Compute a partition count from a target throughput and per-partition throughput, with headroom, and justify it.
- [ ] Practise the order-pipeline design aloud in 20 minutes, counting how many trade-offs you stated unprompted.
- [ ] Take a design that assumes global ordering and rework it to per-key ordering, noting the parallelism you regain.

### Mini Project — "Design Round Portfolio"

**Goal.** Build three complete, defensible messaging designs you can deliver under time pressure, so the round tests judgement rather than recall.

**Requirements.**
1. Three designs at increasing difficulty — a task-processing queue, an order-processing pipeline, and a high-throughput analytics firehose.
2. For each: a clarifying-questions list, a topology diagram with the partition/routing key marked, and each edge annotated with its delivery contract and ordering guarantee.
3. The irreversible set named explicitly for each, with the reason it is irreversible.
4. A failure plan per design: retries with backoff, DLQ, poison handling, and rebalance/consumer-crash behaviour.
5. A durability contract (RF, min.insync/quorum, acks) and the acknowledged-data-loss window on failover.
6. The 10× bottleneck named with its detection signal, and a trade-offs page listing, unprompted, what each choice gave up.

**Extensions.**
- Have someone play interviewer and push on the three questions from §3 until you can answer each in under a minute.
- Implement the idempotent-consumer core of one design and crash-test it to prove duplicates are safe no-ops.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Design: Kafka vs RabbitMQ* (the broker decision), *Delivery Guarantees* (the delivery contract), *Ordering, Partitioning & Keys* (the key that fixes ordering and scaling), *Idempotency, Deduplication & the Outbox Pattern* (making at-least-once safe), *Backpressure, Flow Control & Poison Messages* (the failure-handling half of a senior round).

- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · the systems reasoning behind broker choice, delivery semantics and the log; the reference for the judgement a senior round tests. <https://dataintensive.net/>
- **Apache Kafka — Design & Documentation** — Apache · *Intermediate* · partitions, consumer groups, replication and delivery, the authoritative source for the mechanics. <https://kafka.apache.org/documentation/#design>
- **RabbitMQ — Reliability Guide & Distributed RabbitMQ** — RabbitMQ · *Intermediate* · the reliability, routing and HA decisions a RabbitMQ design must defend. <https://www.rabbitmq.com/docs/reliability>
- **Confluent — Kafka: The Definitive Guide (free ebook)** — Narkhede, Shapira, Palino · *Advanced* · the full production reasoning behind topology, delivery and operations. <https://www.confluent.io/resources/kafka-the-definitive-guide/>
- **The Log** — Jay Kreps · *Advanced* · the essay that frames event-streaming design; essential background for the log-centric designs. <https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying>
- **Microservices Patterns — Messaging & Saga** — Chris Richardson · *Intermediate* · the patterns (outbox, saga, idempotent consumer) that recur in messaging design rounds. <https://microservices.io/patterns/>
- **You Cannot Have Exactly-Once Delivery** — Tyler Treat · *Advanced* · the honest framing of delivery semantics that separates strong answers from hand-waving. <https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/>
- **Grokking the System Design Interview — Messaging sections** — educative · *Intermediate* · the interview-format practice of applying these decisions to worked designs. <https://www.educative.io/courses/grokking-the-system-design-interview>

---

*Kafka & RabbitMQ Handbook — chapter 30.*
