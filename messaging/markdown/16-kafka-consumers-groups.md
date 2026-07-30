# 16 · Design: Consumers, Groups, Offsets & Rebalancing

> **In one line:** A Kafka consumer group is a coordination protocol that shares a topic's partitions across members so each partition is read by exactly one member, and the three things that decide whether your consumer is correct and fast are *when you commit the offset*, *how the group rebalances*, and *how far behind you are* — everything else is detail.

---

## 1. Overview

The consumer is where Kafka's "smart consumer" philosophy cashes out. The broker hands you bytes from an offset; everything else — tracking your position, sharing work with peers, recovering when a peer dies, deciding when a record counts as "processed" — is your side of the contract, mediated by the **consumer group** protocol. This chapter is framed as a design round, because "design a Kafka consumer" is a real interview and a real engineering task, and the good answers all turn on the same three axes: offset-commit semantics, rebalancing, and lag.

A **consumer group** is a named set of consumers that cooperate to read a topic (or topics) exactly once as a group. The group coordinator distributes the topic's partitions across the members so that **each partition is assigned to at most one consumer in the group**. That single rule produces all the group's behaviour: it is how you scale (add consumers up to the partition count and the load splits), it is why you cannot exceed the partition count (a surplus consumer gets no partition and sits idle), and it is what makes different groups independent (each group gets the whole topic — pub/sub across groups, queue within a group, as chapter 2 showed).

The two hard parts are offsets and rebalancing. **Offset commit** decides delivery semantics: commit *after* you process and a crash redelivers the record (at-least-once); commit *before* and a crash loses it (at-most-once); the near-universal choice is at-least-once plus idempotent processing (chapter 21). **Rebalancing** is what happens when membership or partitions change — a consumer joins, leaves, or dies — and the group must reassign partitions; done naively it is a stop-the-world pause (eager), and the modern improvement is cooperative/incremental rebalancing (KIP-429) that reshuffles only what must move. And underneath both sits **consumer lag** — how far a group's committed offset trails the log end — the single most important consumer health metric. Get commit semantics, rebalancing and lag right and the rest of consuming Kafka is mechanical.

## 2. Core Concepts

- **Consumer** — a client that reads records from partitions by polling. It owns its position (offset) and its processing.
- **Consumer group** — a set of consumers sharing a `group.id` that together read the subscribed topics, with each partition assigned to one member.
- **Group coordinator** — a broker that manages a group's membership and partition assignment and stores the group's committed offsets.
- **Poll loop** — the consumer's core structure: repeatedly call `poll`, process the returned batch, commit, repeat. `poll` also drives heartbeats and rebalances.
- **Offset commit** — recording how far the group has processed a partition, stored in the internal `__consumer_offsets` topic. Auto (periodic) or manual (`commitSync`/`commitAsync`).
- **At-least-once / at-most-once** — commit after processing (redeliver on crash) vs commit before (lose on crash).
- **Rebalance** — reassigning partitions across group members when membership or partition count changes.
- **Eager rebalance** — the classic protocol: all members revoke all partitions, then reassign (stop-the-world).
- **Cooperative/incremental rebalance** — KIP-429: only the partitions that must move are revoked; the rest keep processing.
- **Static membership** — `group.instance.id`: a consumer keeps its identity across restarts so a brief bounce does not trigger a rebalance.
- **session.timeout.ms / heartbeat.interval.ms / max.poll.interval.ms** — the liveness and progress deadlines that decide when a consumer is considered dead.
- **Assignment strategy** — how partitions map to members: range, round-robin, sticky, cooperative-sticky.
- **Consumer lag** — log-end offset minus committed offset per partition; how far behind the group is.

## 3. Theory & Principles

### The group rule and what it buys

The consumer group is one rule with far-reaching consequences: **within a group, each partition is consumed by at most one member.** From that, everything follows. Scaling: add members and the coordinator splits partitions across them, so throughput rises — until you hit the partition count, at which point extra members sit idle because there is no partition to give them (chapter 13). Fault tolerance: if a member dies, its partitions are reassigned to survivors, so processing continues. Independence: two groups with different `group.id`s each read the whole topic, tracking separate offsets, so a group of workers (queue) and a group of analytics readers (pub/sub) coexist on one topic without interfering. The rule is also why ordering survives scaling: because one member owns a partition, and a partition is ordered, per-partition order is preserved even as you add consumers — you parallelise across partitions without scrambling within them.

### Offset commit is where delivery semantics live

Kafka does not "deliver" a record in the queue sense; it lets you read from an offset, and you tell it how far you have got by committing. *When* you commit relative to processing is the entire delivery-semantics story, and it is a choice you make, not a property Kafka imposes:

- **Commit after processing → at-least-once.** You process the record, *then* commit its offset. If you crash after processing but before committing, the group restarts at the un-committed offset and reprocesses the record — so it is delivered at least once, possibly twice. This is the near-universal default, paired with idempotent processing so a reprocess is harmless (chapter 21).
- **Commit before processing → at-most-once.** You commit the offset, *then* process. If you crash after committing but before finishing, the record is never reprocessed — it is lost. Delivered at most once, possibly zero times. Rarely what you want, except where losing a record is preferable to processing it twice.

Auto-commit (`enable.auto.commit=true`) commits periodically in the background, which is convenient but subtly at-least-once-with-a-twist: it commits the offsets of records *returned by the last poll*, on a timer, regardless of whether you have finished processing them — so a crash can both lose records (committed but not processed) and reprocess others. For anything that matters, turn auto-commit off and commit manually *after* processing, choosing `commitSync` (blocking, retried, safe) or `commitAsync` (non-blocking, higher throughput, no retry) — or both, sync on shutdown.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Offset commit timing decides delivery semantics</text>

  <rect x="24" y="38" width="410" height="196" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="229" y="58" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Commit AFTER process = at-least-once</text>
  <rect x="44" y="72" width="90" height="30" rx="5" fill="#fff" stroke="#16a34a"/><text x="89" y="91" text-anchor="middle" fill="#15803d" font-size="9">poll(offset 5)</text>
  <rect x="164" y="72" width="90" height="30" rx="5" fill="#fff" stroke="#16a34a"/><text x="209" y="91" text-anchor="middle" fill="#15803d" font-size="9">PROCESS</text>
  <rect x="284" y="72" width="90" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="329" y="91" text-anchor="middle" fill="#15803d" font-size="9">commit 5</text>
  <text x="44" y="130" fill="#166534" font-size="10">crash between PROCESS and commit?</text>
  <text x="44" y="150" fill="#166534" font-size="10">&#8594; restart at offset 5 &#8594; REPROCESS record 5</text>
  <text x="44" y="176" fill="#15803d" font-size="10" font-weight="bold">never lost; may be seen twice</text>
  <text x="44" y="200" fill="#166534" font-size="10">&#8594; make processing IDEMPOTENT (chapter 21)</text>
  <text x="44" y="222" fill="#15803d" font-size="10" font-weight="bold">THE practical default</text>

  <rect x="446" y="38" width="410" height="196" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="651" y="58" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Commit BEFORE process = at-most-once</text>
  <rect x="466" y="72" width="90" height="30" rx="5" fill="#fff" stroke="#dc2626"/><text x="511" y="91" text-anchor="middle" fill="#b91c1c" font-size="9">poll(offset 5)</text>
  <rect x="586" y="72" width="90" height="30" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="631" y="91" text-anchor="middle" fill="#b91c1c" font-size="9">commit 5</text>
  <rect x="706" y="72" width="90" height="30" rx="5" fill="#fff" stroke="#dc2626"/><text x="751" y="91" text-anchor="middle" fill="#b91c1c" font-size="9">PROCESS</text>
  <text x="466" y="130" fill="#991b1b" font-size="10">crash between commit and PROCESS?</text>
  <text x="466" y="150" fill="#991b1b" font-size="10">&#8594; restart at offset 6 &#8594; record 5 LOST</text>
  <text x="466" y="176" fill="#b91c1c" font-size="10" font-weight="bold">never seen twice; may be lost</text>
  <text x="466" y="202" fill="#991b1b" font-size="10">rare: only when a dropped record beats a dup</text>

  <rect x="24" y="248" width="832" height="206" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="268" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">The poll loop: the heartbeat of a consumer</text>
  <rect x="60" y="286" width="120" height="40" rx="6" fill="#fff" stroke="#2563eb"/><text x="120" y="310" text-anchor="middle" fill="#1e40af" font-size="10">poll(timeout)</text>
  <rect x="240" y="286" width="140" height="40" rx="6" fill="#fff" stroke="#2563eb"/><text x="310" y="310" text-anchor="middle" fill="#1e40af" font-size="10">process batch</text>
  <rect x="440" y="286" width="140" height="40" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="510" y="310" text-anchor="middle" fill="#15803d" font-size="10">commit offsets</text>
  <path d="M180,306 L236,306" stroke="#2563eb" stroke-width="2"/>
  <path d="M380,306 L436,306" stroke="#2563eb" stroke-width="2"/>
  <path d="M510,326 L510,360 L120,360 L120,330" stroke="#2563eb" stroke-width="2" fill="none"/>
  <text x="315" y="352" text-anchor="middle" fill="#1d4ed8" font-size="9">loop</text>
  <text x="60" y="392" fill="#1d4ed8" font-size="10">poll() also drives HEARTBEATS and joins rebalances &#8212; you must call it regularly</text>
  <text x="60" y="412" fill="#1d4ed8" font-size="10">max.poll.interval.ms: if processing a batch takes longer than this, the broker thinks you're DEAD</text>
  <text x="60" y="432" fill="#1e40af" font-size="10" font-weight="bold">&#8594; keep per-batch processing bounded, or raise max.poll.interval.ms / lower max.poll.records</text>
</svg>
```

### Liveness: how the group knows you are alive

A group must detect a dead member to reassign its partitions, and it does so with two independent clocks. **Heartbeats** run on a background thread every `heartbeat.interval.ms`; if the coordinator misses them for `session.timeout.ms`, the member is considered gone and a rebalance starts. Separately, **`max.poll.interval.ms`** bounds how long you may take *between polls* — because `poll` is what processes records and drives progress, a member that stops polling (e.g. stuck processing one huge batch) is considered dead even if heartbeats continue. These two catch different failures: heartbeats catch a crashed or partitioned process, `max.poll.interval.ms` catches a live process that has stopped making progress. The practical consequence: keep per-batch processing well under `max.poll.interval.ms`, or reduce `max.poll.records` so each batch is smaller, or raise the interval — otherwise a slow batch triggers a needless rebalance, the partitions move, and the work restarts elsewhere.

## 4. Architecture & Workflow

### Rebalancing: eager versus cooperative

When membership changes — a consumer joins, leaves gracefully, or is declared dead — the group must reassign partitions, and *how* it does this is the difference between a smooth system and a stuttering one.

The classic protocol is **eager (stop-the-world) rebalancing**: every member revokes *all* its partitions, the coordinator computes a fresh assignment, and members re-acquire partitions. During the revoke-to-reassign gap, **no one consumes anything** — the whole group pauses, even partitions that were not going to move. For a large group this pause can be seconds, and worse, a flapping member (repeatedly timing out and rejoining) causes a **rebalance storm**: back-to-back stop-the-world pauses that can wedge a group into making almost no progress.

The modern protocol is **cooperative (incremental) rebalancing** (KIP-429, `cooperative-sticky` assignor): instead of revoking everything, the coordinator computes the new assignment, and only the partitions that actually need to *move* to a different member are revoked; every other partition keeps being consumed throughout. A rebalance now proceeds in two short phases (revoke only what moves, then assign), and members that keep their partitions never stop. This turns a stop-the-world pause into a partial, brief reshuffle, dramatically reducing the impact of scaling events and flapping. Modern Kafka clients default toward cooperative assignment, and it is the right choice for any non-trivial group.

```svg
<svg viewBox="0 0 880 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Eager (stop-the-world) vs cooperative (incremental) rebalancing</text>

  <rect x="24" y="42" width="410" height="150" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">EAGER: everyone revokes everything</text>
  <line x1="48" y1="90" x2="410" y2="90" stroke="#94a3b8"/>
  <rect x="48" y="76" width="90" height="28" rx="3" fill="#dcfce7" stroke="#16a34a"/><text x="93" y="94" text-anchor="middle" fill="#166534" font-size="9">consuming</text>
  <rect x="140" y="76" width="150" height="28" rx="3" fill="#fee2e2" stroke="#dc2626"/><text x="215" y="94" text-anchor="middle" fill="#b91c1c" font-size="9">ALL PAUSED (revoke+reassign)</text>
  <rect x="292" y="76" width="118" height="28" rx="3" fill="#dcfce7" stroke="#16a34a"/><text x="351" y="94" text-anchor="middle" fill="#166534" font-size="9">consuming</text>
  <text x="40" y="126" fill="#991b1b" font-size="10">Every member drops all partitions; NO ONE consumes</text>
  <text x="40" y="142" fill="#991b1b" font-size="10">until the new assignment lands &#8212; even unmoved partitions.</text>
  <text x="40" y="164" fill="#7f1d1d" font-size="10" font-weight="bold">A flapping member &#8594; back-to-back pauses = REBALANCE STORM,</text>
  <text x="40" y="180" fill="#7f1d1d" font-size="10" font-weight="bold">which can wedge a group into near-zero progress.</text>

  <rect x="446" y="42" width="410" height="150" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">COOPERATIVE: only what moves is revoked</text>
  <line x1="470" y1="90" x2="832" y2="90" stroke="#94a3b8"/>
  <rect x="470" y="76" width="270" height="28" rx="3" fill="#dcfce7" stroke="#16a34a"/><text x="605" y="94" text-anchor="middle" fill="#166534" font-size="9">kept partitions KEEP consuming throughout</text>
  <rect x="742" y="76" width="90" height="28" rx="3" fill="#fef3c7" stroke="#d97706"/><text x="787" y="94" text-anchor="middle" fill="#92400e" font-size="8">moved only</text>
  <text x="462" y="126" fill="#166534" font-size="10">Two short phases: revoke only the partitions that must</text>
  <text x="462" y="142" fill="#166534" font-size="10">change member, then assign. Everything else never stops.</text>
  <text x="462" y="164" fill="#15803d" font-size="10" font-weight="bold">A scale-up or a flapping member now costs a partial,</text>
  <text x="462" y="180" fill="#15803d" font-size="10" font-weight="bold">brief reshuffle &#8212; the default for any non-trivial group.</text>

  <rect x="24" y="212" width="832" height="132" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="234" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Taming rebalances</text>
  <text x="40" y="258" fill="#475569" font-size="10">&#8226; cooperative-sticky assignor (KIP-429) &#8212; incremental, keeps most partitions in place</text>
  <text x="40" y="278" fill="#475569" font-size="10">&#8226; static membership (group.instance.id) &#8212; a restart within session.timeout.ms does NOT trigger a rebalance</text>
  <text x="40" y="298" fill="#475569" font-size="10">&#8226; tune session.timeout.ms (liveness) and max.poll.interval.ms (processing time) so a slow poll isn't mistaken for a dead member</text>
  <text x="40" y="320" fill="#334155" font-size="10" font-weight="bold">The rebalance storm &#8212; a member repeatedly timing out and rejoining &#8212; is the #1 consumer-group operational pathology.</text>
</svg>
```

Two more tools tame rebalances. **Static membership** (`group.instance.id`) gives a consumer a stable identity, so a quick restart (a deploy, a pod reschedule) within `session.timeout.ms` does *not* trigger a rebalance — the returning member reclaims its old partitions. And **sticky** assignment strategies try to keep partitions on the same members across rebalances, minimising the churn of moving state and re-warming caches.

### Assignment strategies

The assignor decides which partitions go to which member. **Range** assigns contiguous partition ranges per topic (can imbalance across multiple topics). **RoundRobin** spreads partitions evenly across members (better balance, more movement). **Sticky** balances while minimising changes from the previous assignment. **CooperativeSticky** is sticky *and* uses the incremental protocol so unmoved partitions never stop. For most groups, `cooperative-sticky` is the default to reach for: even balance, minimal churn, no stop-the-world.

## 5. Implementation

A consumer group with `segmentio/kafka-go` doing at-least-once with manual commit after processing.

```go
package main

import (
	"context"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

func main() {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"broker1:9092", "broker2:9092"},
		GroupID: "fulfilment",      // membership: all readers with this id share partitions
		Topic:   "orders",
		MaxWait: 500 * time.Millisecond,
		// Disable auto-commit by committing explicitly (below). CommitInterval=0
		// means we control exactly when the offset advances.
		CommitInterval: 0,
		// Liveness: if a batch takes longer than this between fetches, the group
		// treats us as dead and rebalances. Keep processing bounded or raise it.
		MaxPollBytes: 1 << 20,
	})
	defer r.Close()

	ctx := context.Background()
	for {
		// FetchMessage returns a record WITHOUT committing — so we control the
		// commit point. (ReadMessage would auto-commit; we don't want that here.)
		m, err := r.FetchMessage(ctx)
		if err != nil {
			log.Printf("fetch: %v", err)
			return
		}

		// PROCESS FIRST. Make this idempotent (dedup on a business key) because
		// at-least-once means we may see this record again after a crash/rebalance.
		if err := process(m); err != nil {
			log.Printf("process failed at offset %d: %v", m.Offset, err)
			// Do NOT commit: on restart we reprocess from here. For a poison
			// message, route to a dead-letter topic and then commit (chapter 23).
			continue
		}

		// COMMIT AFTER successful processing => at-least-once. A crash between
		// process and commit reprocesses this record — safe because process is
		// idempotent. Committing before process would be at-most-once (can lose).
		if err := r.CommitMessages(ctx, m); err != nil {
			log.Printf("commit failed at offset %d: %v", m.Offset, err)
		}
	}
}

func process(m kafka.Message) error {
	log.Printf("partition=%d offset=%d key=%s", m.Partition, m.Offset, string(m.Key))
	return nil
}
```

The `confluent-kafka-go` client exposes the rebalance callbacks and the raw group config, so you can see cooperative rebalancing and static membership directly.

```go
package main

import (
	"fmt"
	"log"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

func main() {
	c, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers": "broker1:9092,broker2:9092",
		"group.id":          "fulfilment",

		// COOPERATIVE rebalancing (KIP-429): only partitions that must move are
		// revoked; the rest keep consuming. Avoids stop-the-world pauses.
		"partition.assignment.strategy": "cooperative-sticky",

		// STATIC MEMBERSHIP: a stable identity so a quick restart (deploy/reschedule)
		// within session.timeout.ms does NOT trigger a rebalance — the member
		// reclaims its old partitions.
		"group.instance.id": "fulfilment-pod-3",

		// LIVENESS clocks: heartbeats prove we're alive; max.poll.interval bounds
		// how long processing a batch may take before we're declared dead.
		"session.timeout.ms":    45000,
		"heartbeat.interval.ms": 3000,
		"max.poll.interval.ms":  300000,

		// AT-LEAST-ONCE: turn OFF auto-commit and commit manually AFTER processing.
		"enable.auto.commit": false,
		// Where a brand-new group starts if it has no committed offset.
		"auto.offset.reset": "earliest",
	})
	if err != nil {
		log.Fatal(err)
	}
	defer c.Close()

	// The rebalance callback lets us flush/commit state for partitions we're about
	// to lose (on revoke) and initialise for partitions we gain (on assign).
	rebalanceCb := func(c *kafka.Consumer, ev kafka.Event) error {
		switch e := ev.(type) {
		case kafka.AssignedPartitions:
			log.Printf("assigned: %v", e.Partitions)
			c.IncrementalAssign(e.Partitions) // cooperative: add, don't replace
		case kafka.RevokedPartitions:
			log.Printf("revoked: %v", e.Partitions)
			// Commit offsets for partitions being taken away, so the next owner
			// resumes cleanly and we don't reprocess more than necessary.
			c.Commit()
			c.IncrementalUnassign(e.Partitions)
		}
		return nil
	}
	_ = c.SubscribeTopics([]string{"orders"}, rebalanceCb)

	for {
		msg, err := c.ReadMessage(-1)
		if err != nil {
			log.Printf("read: %v", err)
			continue
		}
		// PROCESS then COMMIT — at-least-once. Idempotent processing required.
		fmt.Printf("offset %d key %s\n", msg.TopicPartition.Offset, string(msg.Key))
		if _, err := c.CommitMessage(msg); err != nil {
			log.Printf("commit: %v", err)
		}
	}
}
```

The disciplines the code encodes: **process then commit** (at-least-once) with idempotent processing; **commit on revoke** in the rebalance callback so a partition handed off does not needlessly reprocess; **cooperative-sticky** so scaling does not pause the group; and **static membership** so a deploy bounce is not mistaken for a failure.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Elastic scaling within a group.** Add consumers up to the partition count and the coordinator splits load automatically.
- **Fault tolerance.** A dead member's partitions are reassigned to survivors with no data loss (offsets are durable).
- **Queue and pub/sub from one mechanism.** One group shares the topic (queue); multiple groups each read it all (pub/sub).
- **Per-partition order preserved under scaling.** One member per partition keeps within-partition order even as you parallelise.
- **Tunable delivery semantics.** You choose at-least-once or at-most-once by where you commit; exactly-once via transactions (chapter 20).

**Disadvantages**
- **Rebalances disrupt.** Eager rebalances stop the world; even cooperative ones move some partitions and their in-flight work.
- **Parallelism capped by partitions.** A group can never have more active consumers than partitions; scaling past that needs more partitions.
- **Offset management is subtle.** Auto-commit, commit timing and resets have non-obvious failure modes (lost or duplicated processing).
- **Slow processing masquerades as death.** A batch that exceeds `max.poll.interval.ms` triggers a rebalance, compounding the slowness.

**Trade-offs**
- *At-least-once vs at-most-once:* commit after processing (never lose, may duplicate — needs idempotency) versus commit before (never duplicate, may lose). At-least-once is almost always right.
- *Auto-commit vs manual:* auto-commit is convenient but can both lose and duplicate; manual `commitSync` is safe but blocks; `commitAsync` is fast but unretried.
- *Eager vs cooperative rebalancing:* eager is simpler but stops the world; cooperative keeps unmoved partitions running at the cost of a slightly more complex protocol.
- *Fewer, larger polls vs more, smaller:* large `max.poll.records` improves throughput but risks exceeding `max.poll.interval.ms`; smaller batches are safer but chattier.

## 7. Common Mistakes & Best Practices

- **Leaving auto-commit on for important work.** It commits on a timer regardless of processing, so a crash can lose records (committed, not processed) and duplicate others. Turn it off and commit after processing.
- **Committing before processing.** That is at-most-once — a crash loses the record. Commit after successful processing for at-least-once.
- **Assuming exactly-once from at-least-once.** At-least-once means duplicates on redelivery; without idempotent processing you get double effects. Deduplicate on a business key (chapter 21).
- **Long per-batch processing exceeding `max.poll.interval.ms`.** The group thinks you died and rebalances mid-work. Bound processing time, lower `max.poll.records`, or raise the interval.
- **More consumers than partitions.** The surplus sit idle. Size partitions for your target consumer parallelism (chapter 13).
- **Ignoring rebalance callbacks.** Not committing on revoke causes needless reprocessing and, for stateful consumers, lost or stale local state. Commit and flush on revoke.
- **Deploys causing rebalance storms.** Rolling restarts churn membership; use static membership so a quick bounce does not rebalance, and cooperative-sticky so what does rebalance does not stop the world.
- **Best practice: manual commit after idempotent processing, cooperative-sticky assignment, static membership, bounded per-batch work, and lag as your primary alert.** That combination is correct, smooth under scaling, and observable.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `kafka-consumer-groups.sh --describe --group G` is the first tool: it shows per-partition current offset, log-end offset, and **lag**, plus which consumer owns each partition — so you can see a stuck partition, an idle consumer, or an unbalanced assignment at a glance. Frequent rebalances in the logs point at a member exceeding `max.poll.interval.ms`, flapping liveness, or deploys without static membership. Rising lag on one partition isolates a slow key or a hot partition.
- **Monitoring.** Consumer **lag** per partition and per group is the headline metric — it tells you whether consumers keep up with producers; sustained rising lag means the group is falling behind and the backlog is growing (chapter 27). Also track rebalance rate and duration, commit rate and failures, and processing time per batch relative to `max.poll.interval.ms`. Alert on lag trend, not just absolute value.
- **Security.** Consumers authenticate (SASL) and encrypt in transit (TLS); ACLs restrict which principals may join which consumer groups and read which topics, so a rogue consumer cannot join a group and steal partitions or read a stream it should not. The group's offsets live in `__consumer_offsets`, which should be protected like any other topic (chapter 29).
- **Scaling.** Scale a group by adding consumers up to the partition count; beyond that you must add partitions (a design-time decision, chapter 13). Prefer cooperative-sticky so scaling events do not pause the group, and static membership so autoscaling churn does not trigger storms. For stateful consumers, sticky assignment reduces the cost of re-warming state after a rebalance. Watch that scaling out does not just move the bottleneck downstream (the database the consumer writes to).

## 9. Interview Questions

**Q: What is a consumer group and what rule governs it?**
A: A consumer group is a set of consumers sharing a `group.id` that together read the subscribed topics, coordinated by a group coordinator on a broker. The governing rule is that within a group each partition is assigned to at most one member. That rule produces all the group behaviour: you scale by adding members and the coordinator splits partitions across them; you cannot exceed the partition count because a surplus member gets no partition and sits idle; a dead member's partitions are reassigned to survivors; and different groups are independent because each group reads the whole topic with its own offsets — queue behaviour within a group, pub/sub across groups.

**Q: How do you choose between at-least-once and at-most-once, and how do you implement each?**
A: It comes down to where you commit the offset relative to processing. For at-least-once, you process the record first and commit its offset only after processing succeeds; if you crash in between, the group restarts at the un-committed offset and reprocesses, so the record is never lost but may be seen twice — which you make safe with idempotent processing. For at-most-once, you commit before processing; a crash after the commit but before processing loses the record, so it is seen at most once, never twice. At-least-once with idempotency is the near-universal choice because losing data is usually worse than a harmless reprocess; at-most-once is reserved for cases where a dropped record is genuinely preferable to a duplicate.

**Q: What is wrong with auto-commit for important processing?**
A: Auto-commit commits the offsets of the last-polled records periodically on a timer, independent of whether you have actually finished processing them. So two bad things can happen: the timer can fire after records were returned but before they were processed, and a crash then loses them (committed but not done); and because commits are periodic, a crash can also reprocess records committed slightly behind actual progress. It blurs the commit-timing that defines delivery semantics. For anything that matters, disable auto-commit and commit manually after processing, which gives clean at-least-once.

**Q: What triggers a rebalance and why is it disruptive?**
A: A rebalance is triggered by a change in group membership or subscription — a consumer joins, leaves gracefully, is declared dead (missed heartbeats or exceeded `max.poll.interval.ms`), or the topic's partition count changes. It is disruptive because partitions must be reassigned, and in the classic eager protocol every member revokes all its partitions and no one consumes during the revoke-to-reassign gap — a stop-the-world pause. A flapping member can cause repeated rebalances, a rebalance storm, that wedges the group. Cooperative rebalancing reduces the disruption by only moving the partitions that must change.

**Q: What is cooperative (incremental) rebalancing and why is it better?**
A: Cooperative rebalancing (KIP-429, the cooperative-sticky assignor) changes the protocol so that instead of every member revoking all partitions, the coordinator computes the new assignment and only the partitions that actually need to move to a different member are revoked; every other partition keeps being consumed throughout. It proceeds in two short phases — revoke only what moves, then assign — so members that keep their partitions never stop. This turns the eager protocol's stop-the-world pause into a brief partial reshuffle, greatly reducing the impact of scaling events and flapping members. It is the right default for any non-trivial group.

**Q: What is consumer lag and why is it the key metric?**
A: Consumer lag is, per partition, the log-end offset minus the group's committed offset — how many records the group has not yet processed. Summed or maxed across a topic it tells you whether consumers are keeping up with producers. It is the key metric because it is the earliest and clearest signal that something is wrong: steadily rising lag means the group is falling behind, the backlog is growing, and end-to-end latency is increasing, whether due to a slow consumer, a hot partition, a downstream bottleneck, or too few consumers. You alert on the lag trend, and it also pinpoints which partition (and thus which key or consumer) is the problem.

**Q: Why can't a group have more active consumers than partitions?**
A: Because within a group each partition is assigned to exactly one member, so a partition is the smallest unit of work a consumer can be given. If there are more consumers than partitions, every partition is already owned by someone and the extra consumers have nothing to be assigned, so they sit idle. That makes the partition count the hard ceiling on a group's parallelism, which is why you size partitions up front for the most parallel consumer you will ever need (chapter 13).

**Q: (Senior) Design the consumer side of an order-processing pipeline that must not lose orders and must keep up under load.**
A: I would anchor on the three axes — commit semantics, rebalancing, lag — and design each deliberately. Delivery semantics: at-least-once, so I disable auto-commit and commit the offset only after an order is fully processed and its side effects are durable; because at-least-once means possible reprocessing after a crash or rebalance, I make processing idempotent by deduplicating on the order id (or making the write naturally idempotent, e.g. an upsert), so a redelivery is harmless. Ordering: I ensure orders that must be sequenced (same account) are keyed to the same partition by the producer, so one member processes them in order; I never break that by processing a partition's records concurrently out of order. Scaling and rebalancing: I use the cooperative-sticky assignor so adding consumers under load does not stop the world, and static membership so rolling deploys and autoscaling do not trigger rebalance storms; I size the topic's partition count above my peak required consumer parallelism so I can actually scale out. Liveness: I keep per-batch processing well under `max.poll.interval.ms` — tuning `max.poll.records` down if a batch of orders can take long — so a slow batch does not get me evicted and cause a needless rebalance. Failure handling: an order that repeatedly fails processing is a poison message, so after N attempts I route it to a dead-letter topic with its error and commit past it, rather than blocking the partition forever (chapter 23). Observability: I alert on the lag trend per partition, on rebalance frequency, and on dead-letter rate. The result is a group that never loses an order (commit-after-process + durable offsets), tolerates duplicates safely (idempotency), scales smoothly (cooperative-sticky + enough partitions), and is diagnosable (lag and rebalance metrics).

**Q: (Senior) A group is rebalancing constantly and barely making progress. Diagnose and fix it.**
A: Constant rebalancing is a rebalance storm, and it almost always means members are repeatedly being declared dead and rejoining. I would work through the causes in order. First and most common: per-batch processing is exceeding `max.poll.interval.ms`. If handling a poll's worth of records takes longer than that interval, the coordinator concludes the member stopped making progress, evicts it, rebalances, the work restarts elsewhere and takes just as long, and the cycle repeats — which perfectly matches "barely making progress". The fix is to bound processing time: lower `max.poll.records` so each batch is smaller, move slow work off the poll thread, or raise `max.poll.interval.ms` if the work is legitimately long. Second: liveness misconfiguration or GC/pauses causing missed heartbeats — check `session.timeout.ms` versus `heartbeat.interval.ms` and whether the process is pausing. Third: deploys or autoscaling churning membership — a rolling restart without static membership makes every pod bounce trigger a rebalance; adding `group.instance.id` (static membership) means a quick restart within the session timeout reclaims partitions without a rebalance. Fourth: using the eager assignor, so every rebalance is stop-the-world and amplifies the impact — switching to cooperative-sticky means only moving partitions pause. Fifth: a genuinely flapping/unhealthy member (OOM, crash loop) that keeps dying — find and fix or remove it. I would use `kafka-consumer-groups.sh --describe` and the client logs to see which members are joining/leaving and correlate with processing times and deploy events. In practice the top fix is almost always "processing a batch takes too long — shrink the batch or the work, and adopt cooperative-sticky plus static membership so the remaining rebalances are cheap."

**Q: (Senior) Explain the difference between the two liveness clocks and why both exist.**
A: Kafka uses two independent mechanisms to decide a consumer is dead because there are two distinct failure modes. The first is heartbeats: a background thread sends a heartbeat every `heartbeat.interval.ms`, and if the coordinator receives none for `session.timeout.ms`, it declares the member dead. Heartbeats catch a process that has crashed, hung, or been network-partitioned — the whole process is gone or unreachable. The second is `max.poll.interval.ms`: it bounds how long the application may go between calls to `poll`. This catches a different failure — a process that is alive and heartbeating fine but has stopped making progress because it is stuck processing one batch for too long (a slow downstream call, a huge batch, a bug). Heartbeats alone would not catch this, because the background heartbeat thread keeps beating while the main thread is stuck; without `max.poll.interval.ms`, such a consumer would hold its partitions indefinitely while doing nothing, silently stalling the group. So the two clocks separate "the consumer process is dead/unreachable" (heartbeats) from "the consumer is alive but not making progress" (poll interval), and both are needed because a healthy consumer must be both reachable and actively consuming. The practical implication is that you tune them for different things: heartbeat/session timeouts for how fast you want failure detection, and `max.poll.interval.ms` (with `max.poll.records`) for how long your processing legitimately takes.

## 10. Quick Revision & Cheat Sheet

| Concept | One-liner |
|---|---|
| Consumer group | Members share partitions; one member per partition |
| Commit after process | At-least-once (never lose, may duplicate) |
| Commit before process | At-most-once (never duplicate, may lose) |
| Auto-commit | Timer-based; can both lose and duplicate — avoid for important work |
| Eager rebalance | Revoke all, reassign — stop-the-world |
| Cooperative rebalance | Move only what must move — no full pause (KIP-429) |
| Static membership | Stable id; a quick restart avoids a rebalance |
| Consumer lag | Log-end offset − committed offset; #1 health metric |

| Liveness clock | Catches |
|---|---|
| heartbeat / session.timeout.ms | Crashed / partitioned process |
| max.poll.interval.ms | Alive but not making progress (slow batch) |

**Flash cards**
- **What decides delivery semantics?** → When you commit relative to processing.
- **Default choice?** → At-least-once (commit after) + idempotent processing.
- **Consumers > partitions?** → The surplus sit idle.
- **Rebalance storm cause?** → Processing exceeding `max.poll.interval.ms` (usually).
- **Cooperative rebalancing wins how?** → Only moving partitions pause; the rest keep going.
- **Primary alert?** → Consumer lag trend per partition.

## 11. Hands-On Exercises & Mini Project

- [ ] Run a group with 3 consumers on a 6-partition topic and observe the assignment; add a 4th and a 7th and watch rebalancing and the idle surplus.
- [ ] Implement commit-after-process, crash mid-batch, and confirm reprocessing; then commit-before-process and confirm loss.
- [ ] Turn on auto-commit, crash between poll and processing, and demonstrate both a lost and a duplicated record.
- [ ] Make per-batch processing exceed `max.poll.interval.ms` and observe the induced rebalance; fix it by lowering `max.poll.records`.
- [ ] Switch from eager to cooperative-sticky and compare pause behaviour when adding a consumer.
- [ ] Add static membership, do a rolling restart, and confirm no rebalance fires for a quick bounce.

### Mini Project — "Resilient Consumer Group"

**Goal.** Build an order-consuming group that is correct under crashes and smooth under scaling, and prove both with instrumentation.

**Requirements.**
1. Consume `orders` with manual commit after idempotent processing (dedup on order id), giving at-least-once with no double effects.
2. Use cooperative-sticky assignment and static membership; demonstrate that scaling the group and rolling-restarting it do not stop the world or storm.
3. Handle a poison order by routing it to a dead-letter topic after N attempts and committing past it, so one bad record does not block the partition.
4. Commit offsets on partition revoke in the rebalance callback and show a clean hand-off with no needless reprocessing.
5. Instrument per-partition lag and rebalance rate, and alert on rising lag.

**Extensions.**
- Introduce a deliberately slow batch and show it triggering a rebalance, then tune `max.poll.records`/`max.poll.interval.ms` to prevent it.
- Add a second group for analytics and show it reading the whole topic independently while the first shares the load.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Kafka Architecture: Brokers, Topics & Partitions* (why one member per partition and the parallelism ceiling), *The Log: Offsets, Segments & Retention* (committed offsets and resets), *Producers: Partitioning, Batching & acks* (the write side and keys), *Idempotency, Deduplication & the Outbox Pattern* (making at-least-once safe), *Backpressure, Flow Control & Poison Messages* (lag, dead-letter topics and keeping up).

- **Apache Kafka — Consumer configuration & the consumer group protocol** — Apache · *Intermediate* · the authoritative reference for commits, liveness clocks and assignment. <https://kafka.apache.org/documentation/#consumerconfigs>
- **KIP-429: Incremental Cooperative Rebalancing** — Apache · *Advanced* · the design of cooperative rebalancing and why it avoids stop-the-world. <https://cwiki.apache.org/confluence/display/KAFKA/KIP-429%3A+Kafka+Consumer+Incremental+Rebalance+Protocol>
- **KIP-345: Static membership** — Apache · *Advanced* · stable consumer identity to avoid rebalances on quick restarts. <https://cwiki.apache.org/confluence/display/KAFKA/KIP-345%3A+Introduce+static+membership+protocol+to+reduce+consumer+rebalances>
- **Kafka: The Definitive Guide (2nd ed.), ch. "Kafka Consumers"** — Narkhede, Shapira, Palino · *Intermediate* · the poll loop, commit strategies and rebalancing explained in depth. <https://www.confluent.io/resources/kafka-the-definitive-guide/>
- **Confluent — Consumer group protocol & rebalancing deep dive** — Confluent · *Intermediate* · practical guidance on assignors, liveness and lag. <https://developer.confluent.io/courses/architecture/consumer-group-protocol/>
- **confluent-kafka-go** — Confluent · *Intermediate* · the client used here for rebalance callbacks and static membership. <https://github.com/confluentinc/confluent-kafka-go>
- **kafka-go — segmentio** — Segment · *Intermediate* · the pure-Go group reader with manual commit used here. <https://github.com/segmentio/kafka-go>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · delivery semantics, consumer offsets and reprocessing in a systems context. <https://dataintensive.net/>

---

*Kafka & RabbitMQ Handbook — chapter 16.*
