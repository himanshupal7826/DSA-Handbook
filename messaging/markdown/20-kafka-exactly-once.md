# 20 · Design: Kafka Exactly-Once — Idempotent Producers & Transactions

> **In one line:** Kafka's exactly-once is not a network miracle — it is two concrete mechanisms, an idempotent producer that dedupes retries at the broker and transactions that atomically bind a set of writes to a set of consumed offsets, and together they make the *consume-transform-produce* loop exactly-once *within Kafka* while doing nothing for the external systems you touch.

---

## 1. Overview

"Exactly-once" is the phrase that launches a thousand arguments, because in the general distributed-systems sense it is impossible: a sender can never be sure, over an unreliable network, whether a lost acknowledgement means the message was not delivered or the acknowledgement was. So when Kafka advertises exactly-once semantics (EOS), the honest question is *exactly-once of what?* — and the honest answer is that Kafka provides exactly-once *processing* for a specific, common shape of pipeline, built from two mechanisms that are worth understanding separately before you believe any marketing.

The first mechanism is the **idempotent producer**. Left to itself, a producer that sends a record, times out waiting for the ack, and retries can write the record *twice* — the first send may have succeeded silently. The idempotent producer fixes this by tagging every record with a producer id and a per-partition sequence number, so the broker can recognise and discard a retried duplicate. This turns producer retries from a duplicate source into a non-event, and it is on by default in modern Kafka. It solves duplicates from *the producer side of one send*.

The second mechanism is **transactions**. The idempotent producer does nothing about the *other* duplicate source: a consumer that processes records, produces results, and then crashes *before* committing its offsets — on restart it reprocesses the same input and produces the results again. Transactions solve this by letting a producer write to several partitions *and* commit the input consumer's offsets *atomically*: either all the output records and the offset advance are committed together, or none are. This is what makes the read-process-write loop — read from a topic, transform, write to another topic — exactly-once: the outputs and the record of "I have consumed this input" succeed or fail as a unit.

The crucial boundary, which this chapter insists on, is that both mechanisms operate *within Kafka*. If your transformation also writes to a database, sends an email, or calls a payment API, Kafka's transaction cannot enrol that external effect — so across that boundary you are back to at-least-once and need idempotency there (chapter 21). Kafka EOS is exactly-once for Kafka-to-Kafka pipelines and stream processing; it is not a universal exactly-once guarantee, and treating it as one is a classic and expensive mistake.

## 2. Core Concepts

- **Exactly-once processing** — each input record affects the output and the committed offset exactly once, even across retries and crashes. Distinct from the impossible "exactly-once delivery".
- **Idempotent producer** — `enable.idempotence=true`: the broker dedupes retried records using a producer id + per-partition sequence number.
- **Producer ID (PID)** — a broker-assigned identifier for a producer session, used to detect duplicates.
- **Sequence number** — a per-partition, monotonically increasing number the producer stamps on each record; the broker rejects out-of-order or duplicate sequences.
- **Transaction** — an atomic unit spanning writes to multiple partitions and consumer-offset commits, all committed or all aborted.
- **`transactional.id`** — a stable, application-assigned producer identity that survives restarts, enabling zombie fencing.
- **Transaction coordinator** — the broker component that manages a transaction's state and writes commit/abort markers.
- **Control markers** — commit/abort records the coordinator writes into partitions to signal a transaction's outcome to consumers.
- **`isolation.level=read_committed`** — a consumer setting to skip records from aborted or in-flight transactions, reading only committed data.
- **Consume-transform-produce (read-process-write)** — the pipeline shape Kafka EOS makes exactly-once: read a topic, transform, produce to another topic, atomically with the offset commit.
- **Zombie fencing** — preventing an old, hung instance of a transactional producer from committing after a new instance has taken over, via an epoch bump on the `transactional.id`.

## 3. Theory & Principles

### Two duplicate sources, two mechanisms

The reason EOS needs *two* mechanisms is that duplicates enter a pipeline from two independent places, and each mechanism closes one.

**Source one: producer retries.** A producer sends record R to a partition and waits for the broker's ack. If the network drops the ack (not the record), the producer times out and retries, and now R is on the log twice. Without idempotence, the only defences are giving up retries (accepting loss) or deduplicating downstream. The idempotent producer closes this at the broker: each record carries a `(producer id, partition, sequence number)`, the broker tracks the last sequence it accepted per producer per partition, and a retry with an already-seen sequence is acknowledged but *not appended again*. Duplicates from retries simply cannot land. This requires `acks=all` (so the record is durably committed before the ack the producer might retry on) and is default-on in modern Kafka.

**Source two: consumer reprocessing.** A consumer reads records up to offset N, processes them, produces outputs, and is *about* to commit offset N when it crashes. On restart it resumes from the last *committed* offset, which is before N, so it reprocesses those records and produces the outputs again. The idempotent producer does nothing here — those are genuinely new sends of new sequence numbers. The fix must make "the outputs are written" and "the input offset is advanced" a single atomic fact, so that a crash can never leave outputs written but the offset not advanced (which causes reprocessing) or the offset advanced but outputs not written (which causes loss). That is precisely what a transaction provides.

### Transactions: atomic writes plus offset commit

A Kafka transaction lets a single producer, identified by a stable `transactional.id`, do the following as one atomic operation:

1. Write records to one or more partitions (possibly across several topics).
2. Commit the *consumer's* offsets for the input it processed — using `sendOffsetsToTransaction`, which writes the offsets *into the transaction* rather than committing them separately.
3. Commit (or abort) the whole thing.

If the transaction commits, the outputs *and* the offset advance are both durable. If it aborts (or the producer crashes), neither takes effect — the outputs are marked aborted and the offset is not advanced, so the restarted consumer reprocesses cleanly and produces the outputs again under a *new* transaction, with the old aborted outputs invisible to `read_committed` consumers. The atomic binding of "what I produced" to "what I consumed" is the entire trick: it eliminates the window where a crash desynchronises them.

The coordinator makes this work by writing **control markers** into the partitions at commit or abort. A `read_committed` consumer reads the log but *withholds* records belonging to a transaction until it sees the commit marker, and *discards* them if it sees an abort marker. So a downstream consumer never observes the records of an aborted transaction — that is what makes the atomicity visible to readers, not just to the coordinator.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="e1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="e2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two duplicate sources &#8594; two mechanisms</text>

  <rect x="24" y="42" width="410" height="180" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Source 1: producer RETRIES</text>
  <text x="40" y="88" fill="#1d4ed8" font-size="10">send R &#8594; broker commits &#8594; ack LOST on the wire</text>
  <text x="40" y="106" fill="#1d4ed8" font-size="10">&#8594; producer times out &#8594; retries &#8594; R twice on the log</text>
  <text x="40" y="132" fill="#15803d" font-size="10" font-weight="bold">FIX: idempotent producer (default on)</text>
  <text x="40" y="150" fill="#166534" font-size="9">every record = (producer id, partition, sequence no.)</text>
  <text x="40" y="166" fill="#166534" font-size="9">broker tracks last seq &#8594; a seen sequence is acked but</text>
  <text x="40" y="180" fill="#166534" font-size="9">NOT appended again &#8594; retry duplicates cannot land</text>
  <text x="40" y="204" fill="#1e40af" font-size="9" font-weight="bold">requires acks=all &#183; solves ONE send's duplicates</text>

  <rect x="446" y="42" width="410" height="180" rx="10" fill="#fefce8" stroke="#d97706" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Source 2: consumer REPROCESSING</text>
  <text x="462" y="88" fill="#b45309" font-size="10">read to offset N &#8594; process &#8594; produce outputs</text>
  <text x="462" y="106" fill="#b45309" font-size="10">&#8594; CRASH before committing N &#8594; restart from &lt; N</text>
  <text x="462" y="124" fill="#b45309" font-size="10">&#8594; reprocess &#8594; produce the outputs AGAIN</text>
  <text x="462" y="148" fill="#15803d" font-size="10" font-weight="bold">FIX: transactions (bind writes + offset)</text>
  <text x="462" y="166" fill="#166534" font-size="9">write outputs AND commit the input offset atomically</text>
  <text x="462" y="182" fill="#166534" font-size="9">&#8594; a crash leaves NEITHER done &#8594; clean reprocess</text>
  <text x="462" y="204" fill="#92400e" font-size="9" font-weight="bold">the idempotent producer does NOTHING here</text>

  <rect x="24" y="240" width="832" height="220" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="262" text-anchor="middle" fill="#15803d" font-size="13" font-weight="bold">The transaction, atomically: outputs + the consumed offset, or nothing</text>

  <rect x="48" y="280" width="130" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="113" y="298" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">input topic</text>
  <text x="113" y="313" text-anchor="middle" fill="#1d4ed8" font-size="8">consumed to offset N</text>
  <path d="M180,300 L228,300" stroke="#16a34a" stroke-width="2" marker-end="url(#e1)"/>
  <rect x="232" y="278" width="150" height="44" rx="6" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="307" y="298" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">transactional producer</text>
  <text x="307" y="313" text-anchor="middle" fill="#6d28d9" font-size="8">transactional.id = "svc-1"</text>

  <path d="M384,290 L432,282" stroke="#16a34a" stroke-width="2" marker-end="url(#e1)"/>
  <rect x="436" y="272" width="180" height="24" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="526" y="288" text-anchor="middle" fill="#166534" font-size="9">output topic A (records)</text>
  <path d="M384,300 L432,304" stroke="#16a34a" stroke-width="2" marker-end="url(#e1)"/>
  <rect x="436" y="300" width="180" height="24" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="526" y="316" text-anchor="middle" fill="#166534" font-size="9">output topic B (records)</text>
  <path d="M384,312 L432,326" stroke="#16a34a" stroke-width="2" marker-end="url(#e1)"/>
  <rect x="436" y="328" width="180" height="24" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="526" y="344" text-anchor="middle" fill="#92400e" font-size="9">__consumer_offsets: N</text>

  <path d="M616,312 L664,312" stroke="#16a34a" stroke-width="2" marker-end="url(#e1)"/>
  <rect x="668" y="290" width="164" height="44" rx="6" fill="#bbf7d0" stroke="#16a34a" stroke-width="2"/>
  <text x="750" y="310" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">commit marker</text>
  <text x="750" y="325" text-anchor="middle" fill="#166534" font-size="8">or ABORT &#8594; all invisible</text>

  <text x="48" y="372" fill="#166534" font-size="10">&#8226; commitTransaction &#8594; ALL three (topic A, topic B, offset N) become durable together. isolation.level=read_committed</text>
  <text x="60" y="388" fill="#166534" font-size="10">consumers see them only after the commit marker.</text>
  <text x="48" y="408" fill="#166534" font-size="10">&#8226; abort / crash &#8594; NONE take effect. The outputs are marked aborted (read_committed skips them) and offset N is not</text>
  <text x="60" y="424" fill="#166534" font-size="10">advanced &#8594; the restarted consumer reprocesses cleanly under a NEW transaction.</text>
  <text x="48" y="448" fill="#7f1d1d" font-size="10" font-weight="bold">Binding "what I produced" to "what I consumed" is the whole trick &#8212; there is no window to desynchronise them.</text>
</svg>
```

### Zombie fencing and the boundary of the guarantee

A stable `transactional.id` does more than survive restarts — it enables **zombie fencing**. Suppose an instance of your processor hangs (a long GC pause), the group declares it dead, and a new instance takes over the same `transactional.id`. If the old instance wakes and tries to commit, it would corrupt the exactly-once guarantee. Kafka prevents this by associating an **epoch** with the `transactional.id`: when the new instance initialises, it bumps the epoch, and the coordinator rejects any transaction operation from the old epoch. The zombie is fenced out. This is why the `transactional.id` must be *stable* and *unique per logical processor* — it is the identity Kafka fences on.

The hard boundary is external systems. A Kafka transaction can enrol Kafka writes and Kafka offset commits, and *nothing else*. If your transform writes a row to Postgres, that write is not part of the transaction — a crash can commit the Kafka transaction but not the Postgres write, or vice versa. Across that boundary you have the dual-write problem, and Kafka EOS does not solve it; you solve it with idempotency at the external system (a dedup key), the outbox pattern (make the external write itself the source of the Kafka event), or an idempotent sink connector. Believing Kafka EOS extends past Kafka is the single most common and expensive misunderstanding of the feature.

## 4. Architecture & Workflow

The consume-transform-produce loop with EOS, step by step, is the canonical use and the one worth memorising:

1. **Configure the producer** with a stable, unique `transactional.id` and `enable.idempotence=true` (implied by transactions). Configure the consumer with `isolation.level=read_committed` and, critically, **`enable.auto.commit=false`** — the transaction commits offsets, so auto-commit must be off or it will commit offsets *outside* the transaction and break the guarantee.
2. **`initTransactions()`** once at startup — this registers the `transactional.id`, bumps its epoch (fencing any zombie), and recovers any pending transaction.
3. **Poll** a batch of input records from the consumer.
4. **`beginTransaction()`**.
5. **Process** the records and **produce** the output records within the transaction.
6. **`sendOffsetsToTransaction`** — pass the consumed offsets *and the consumer group id* into the transaction, so the offset advance is part of the atomic commit rather than a separate operation.
7. **`commitTransaction()`** — atomically commit the outputs and the offsets. On any error, **`abortTransaction()`** and let the loop retry the batch.
8. **Repeat** from step 3.

```svg
<svg viewBox="0 0 880 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="ee1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The consume-transform-produce loop with EOS</text>

  <rect x="40" y="48" width="150" height="44" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="115" y="68" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">initTransactions()</text>
  <text x="115" y="84" text-anchor="middle" fill="#6d28d9" font-size="8">ONCE: register id, bump epoch (fence zombies)</text>

  <rect x="40" y="118" width="150" height="40" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="115" y="142" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">3. poll(batch)</text>
  <path d="M115,158 L115,182" stroke="#7c3aed" stroke-width="2" marker-end="url(#ee1)"/>

  <rect x="40" y="186" width="150" height="40" rx="8" fill="#f5f3ff" stroke="#7c3aed"/>
  <text x="115" y="210" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">4. beginTransaction()</text>
  <path d="M190,206 L228,206" stroke="#7c3aed" stroke-width="2" marker-end="url(#ee1)"/>

  <rect x="232" y="176" width="200" height="60" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="332" y="198" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">5. transform + produce</text>
  <text x="332" y="214" text-anchor="middle" fill="#166534" font-size="8">output records, INSIDE the transaction</text>
  <text x="332" y="228" text-anchor="middle" fill="#166534" font-size="8">to one or more topics</text>
  <path d="M432,206 L470,206" stroke="#7c3aed" stroke-width="2" marker-end="url(#ee1)"/>

  <rect x="474" y="176" width="200" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="574" y="198" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">6. sendOffsetsToTransaction</text>
  <text x="574" y="214" text-anchor="middle" fill="#b45309" font-size="8">the consumed offsets + group id go</text>
  <text x="574" y="228" text-anchor="middle" fill="#b45309" font-size="8">INTO the transaction (not committed separately)</text>
  <path d="M674,206 L712,206" stroke="#7c3aed" stroke-width="2" marker-end="url(#ee1)"/>

  <rect x="716" y="176" width="140" height="60" rx="8" fill="#bbf7d0" stroke="#16a34a" stroke-width="2"/>
  <text x="786" y="200" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">7. commit</text>
  <text x="786" y="216" text-anchor="middle" fill="#166534" font-size="8">outputs + offsets, atomically</text>
  <text x="786" y="228" text-anchor="middle" fill="#166534" font-size="8">error &#8594; abort, retry batch</text>

  <path d="M786,236 Q786,300 200,300 Q140,300 118,160" stroke="#7c3aed" stroke-width="1.5" fill="none" stroke-dasharray="4 3" marker-end="url(#ee1)"/>
  <text x="450" y="316" text-anchor="middle" fill="#6d28d9" font-size="9">loop back to poll the next batch</text>

  <rect x="40" y="322" width="816" height="30" rx="6" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="448" y="342" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">The two silent-break traps: enable.auto.commit MUST be false (or offsets escape the transaction) &#183; transactional.id stable + unique per instance</text>
</svg>
```

The two configuration traps that silently break EOS are worth stating loudly: **auto-commit must be off** (or offsets escape the transaction), and the **`transactional.id` must be stable and unique per processor instance topology** (or fencing fails, or two processors fence each other into a loop). Kafka Streams wraps all of this behind `processing.guarantee=exactly_once_v2`, which is the right way to get EOS unless you have a specific reason to hand-roll it.

## 5. Implementation

The idempotent producer is trivial to enable; the transactional read-process-write loop is the substance. Here is the loop in Go using `confluent-kafka-go`, with the traps commented.

```go
package eos

import (
	"fmt"
	"time"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

// idempotentProducer shows the FIRST mechanism: enabling idempotence closes the
// producer-retry duplicate source. It is default-on in modern Kafka; setting it
// explicitly documents intent. It REQUIRES acks=all under the hood.
func idempotentProducer(broker string) (*kafka.Producer, error) {
	return kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers": broker,
		// The broker dedupes retried records via producer-id + per-partition
		// sequence numbers. A timed-out ack that gets retried no longer
		// double-writes.
		"enable.idempotence": true,
		"acks":               "all", // required for idempotence; the default when it is on
		// Idempotence keeps ordering even with retries and in-flight batches,
		// so you do NOT have to set max.in.flight=1 to preserve order.
		"max.in.flight.requests.per.connection": 5,
	})
}

// transactionalProcessor is the SECOND mechanism: the consume-transform-produce
// loop made exactly-once. It reads inputTopic, transforms, writes outputTopic,
// and commits the input offset ATOMICALLY with the output.
type transactionalProcessor struct {
	consumer *kafka.Consumer
	producer *kafka.Producer
	inTopic  string
	outTopic string
	groupID  string
}

func newTransactionalProcessor(broker, groupID, inTopic, outTopic string) (*transactionalProcessor, error) {
	consumer, err := kafka.NewConsumer(&kafka.ConfigMap{
		"bootstrap.servers": broker,
		"group.id":          groupID,
		// TRAP #1: auto-commit MUST be off. The transaction commits offsets; if
		// auto-commit also runs, offsets escape the transaction and a crash can
		// advance the offset without the outputs — breaking exactly-once.
		"enable.auto.commit": false,
		// read_committed makes downstream consumers skip records from aborted or
		// still-open transactions, so an abort is invisible to them.
		"isolation.level": "read_committed",
		"auto.offset.reset": "earliest",
	})
	if err != nil {
		return nil, err
	}

	producer, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers": broker,
		// TRAP #2: the transactional.id must be STABLE across restarts and
		// UNIQUE per logical processor instance. It is the identity Kafka fences
		// zombies on: a new instance bumps its epoch and locks out the old one.
		"transactional.id": "processor-" + groupID,
		"enable.idempotence": true, // implied by transactions; explicit for clarity
	})
	if err != nil {
		return nil, err
	}

	return &transactionalProcessor{
		consumer: consumer, producer: producer,
		inTopic: inTopic, outTopic: outTopic, groupID: groupID,
	}, nil
}

func (p *transactionalProcessor) Run() error {
	if err := p.consumer.Subscribe(p.inTopic, nil); err != nil {
		return err
	}

	// initTransactions runs ONCE: it registers the transactional.id, bumps the
	// epoch (fencing any zombie holding the same id), and aborts any pending
	// transaction left by a previous crash. Without it, no transaction can begin.
	ctx := kafka.NewTransactionsContext()
	if err := p.producer.InitTransactions(ctx); err != nil {
		return fmt.Errorf("init transactions: %w", err)
	}

	for {
		// 3. Poll a batch of input records.
		batch := p.pollBatch(500 * time.Millisecond)
		if len(batch) == 0 {
			continue
		}

		// 4. Begin the transaction.
		if err := p.producer.BeginTransaction(); err != nil {
			return fmt.Errorf("begin: %w", err)
		}

		// 5. Transform each record and PRODUCE within the transaction.
		for _, m := range batch {
			out := transform(m.Value) // your business logic
			if err := p.producer.Produce(&kafka.Message{
				TopicPartition: kafka.TopicPartition{Topic: &p.outTopic, Partition: kafka.PartitionAny},
				Key:            m.Key,
				Value:          out,
			}, nil); err != nil {
				// On any error, abort and let the loop retry the whole batch.
				_ = p.producer.AbortTransaction(ctx)
				return fmt.Errorf("produce: %w", err)
			}
		}

		// 6. Send the consumed offsets INTO the transaction. This is the atomic
		// binding: the offset advance becomes part of the same commit as the
		// outputs, not a separate step that a crash could desynchronise.
		positions := p.consumedPositions(batch)
		cgMeta, _ := p.consumer.GetConsumerGroupMetadata()
		if err := p.producer.SendOffsetsToTransaction(ctx, positions, cgMeta); err != nil {
			_ = p.producer.AbortTransaction(ctx)
			return fmt.Errorf("send offsets: %w", err)
		}

		// 7. Commit atomically: outputs + offsets, or (on abort/crash) neither.
		if err := p.producer.CommitTransaction(ctx); err != nil {
			// A commit failure aborts; the batch is reprocessed from the last
			// committed offset under a new transaction, and read_committed
			// consumers never saw the aborted outputs.
			_ = p.producer.AbortTransaction(ctx)
			return fmt.Errorf("commit: %w", err)
		}
	}
}

// pollBatch / consumedPositions / transform are elided business glue; the point
// is the begin -> produce -> sendOffsets -> commit atomic sequence above.
func (p *transactionalProcessor) pollBatch(d time.Duration) []*kafka.Message { return nil }
func (p *transactionalProcessor) consumedPositions(b []*kafka.Message) []kafka.TopicPartition { return nil }
func transform(v []byte) []byte { return v }
```

For most real pipelines, **Kafka Streams** is the better answer than hand-rolling this loop — a single `processing.guarantee=exactly_once_v2` config makes every transformation in the topology exactly-once, handling the transaction lifecycle, offset binding and fencing for you (chapter 24).

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Real exactly-once processing** for Kafka-to-Kafka pipelines — no duplicate outputs, no lost inputs, across retries and crashes.
- **The idempotent producer is free.** It is default-on, adds negligible overhead, and removes retry duplicates with no code change.
- **Zombie fencing** prevents a hung old instance from corrupting results after failover, automatically.
- **Kafka Streams makes it a config flag.** `exactly_once_v2` turns a whole topology exactly-once without manual transaction code.

**Disadvantages**
- **It stops at Kafka's edge.** External writes are not enrolled in the transaction, so exactly-once does not extend to databases, APIs or emails.
- **Throughput and latency cost.** Transactions add coordinator round trips and commit markers, and `read_committed` consumers wait for commit markers, adding end-to-end latency.
- **Configuration is fragile.** Auto-commit left on, or a non-unique `transactional.id`, silently breaks the guarantee while appearing to work.
- **Operational complexity.** The transaction coordinator, `transactional.id` management and the `transaction.timeout.ms` are more moving parts to understand and monitor.

**Trade-offs**
- *Exactly-once vs throughput:* transactions cost coordinator round trips and reader latency; for a pipeline that can tolerate at-least-once with idempotent consumers, that simpler path is often faster and adequate.
- *Kafka-native EOS vs external idempotency:* within Kafka, transactions are the clean answer; the moment you touch an external system, you must add idempotency there anyway, so many teams standardise on at-least-once + idempotent consumers everywhere and skip transactions entirely.
- *Streams vs hand-rolled:* Kafka Streams' one-flag EOS is safer and simpler; hand-rolling the transactional loop is only worth it when you cannot use Streams and need the control.

## 7. Common Mistakes & Best Practices

- **Believing EOS extends past Kafka.** The most expensive misconception: a Kafka transaction cannot enrol a database write or an API call. Across that boundary you have the dual-write problem and need idempotency (chapter 21).
- **Leaving auto-commit on with transactions.** The transaction commits offsets; a concurrent auto-commit commits them *outside* the transaction, silently breaking exactly-once. Set `enable.auto.commit=false`.
- **A non-unique or unstable `transactional.id`.** Two processors sharing one id fence each other into a loop; an id that changes every restart defeats zombie fencing. It must be stable and unique per logical processor.
- **Assuming the idempotent producer gives exactly-once.** It only closes producer-retry duplicates; consumer reprocessing still duplicates outputs. You need transactions for the loop.
- **Forgetting `read_committed` on downstream consumers.** With the default `read_uncommitted`, consumers see records from aborted transactions, defeating the point. Downstream readers of transactional output must set `read_committed`.
- **Setting `transaction.timeout.ms` too low.** A processing batch slower than the timeout aborts the transaction mid-flight; size it above your worst-case batch processing time.
- **Hand-rolling when Streams would do.** Manual transactional loops are error-prone; `exactly_once_v2` in Kafka Streams is the safer default.
- **Best practice: use EOS for Kafka-to-Kafka, idempotency for everything else.** Reach for transactions (or Streams EOS) inside Kafka pipelines, and design idempotent consumers and outbox writes at every external boundary, because that is where Kafka's guarantee ends.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The symptoms of broken EOS are duplicate outputs (usually auto-commit left on, or downstream not `read_committed`) or a fencing loop (two instances with the same `transactional.id`, or an id that is not unique per instance). The transaction coordinator logs and the `__transaction_state` internal topic are where the transaction lifecycle is visible; a stuck or repeatedly-aborting transaction shows up there.
- **Monitoring.** Watch transaction abort rate and commit latency — a rising abort rate signals `transaction.timeout.ms` being hit or frequent processing errors. `read_committed` consumer lag can be higher than `read_uncommitted` because reads wait for commit markers, so account for that when alerting on lag (chapter 27).
- **Security.** Transactions add an authorization surface: a principal needs `Write` on the `TransactionalId` resource to use a given `transactional.id`, so ACLs must grant it, and a mis-scoped id lets one service interfere with another's transactions (chapter 29). Treat the `transactional.id` namespace as a security boundary.
- **Scaling.** EOS throughput is bounded by the coordinator round trips per transaction, so batching more records per transaction amortises the cost — but a larger batch increases the reprocessing cost of an abort and the end-to-end latency for `read_committed` readers. The scaling lever is transaction *size*, tuned against the abort penalty and latency budget.

## 9. Interview Questions

**Q: Is exactly-once delivery possible, and what does Kafka actually provide?**
A: Exactly-once *delivery* is not achievable in general, because over an unreliable network a sender can never distinguish a lost message from a lost acknowledgement, so it must either risk not retrying (losing) or retry (duplicating). What Kafka provides is exactly-once *processing* for a specific pipeline shape — consume-transform-produce within Kafka — built from two mechanisms: the idempotent producer, which dedupes producer retries at the broker, and transactions, which atomically bind output writes to the consumed input offset. The guarantee holds inside Kafka; it does not extend to external systems, which is the boundary people most often get wrong.

**Q: What does the idempotent producer solve, and what does it not?**
A: It solves duplicates from producer retries. When a producer sends a record, the ack is lost on the network, and it retries, the record would otherwise land twice; the idempotent producer tags each record with a producer id and a per-partition sequence number, and the broker rejects a retry whose sequence it has already accepted, acknowledging it but not appending it again. It is default-on in modern Kafka and requires acks=all. What it does *not* solve is the other duplicate source: a consumer that processes records, produces outputs, and crashes before committing its offsets will reprocess and produce those outputs again on restart — those are genuinely new sends, invisible to idempotence. Closing that requires transactions.

**Q: How do transactions make consume-transform-produce exactly-once?**
A: By binding the outputs and the input offset into one atomic commit. A transactional producer writes the output records to their partitions and, using sendOffsetsToTransaction, writes the consumed offsets into the *same* transaction rather than committing them separately. When it commits, both the outputs and the offset advance become durable together; if it aborts or crashes, neither takes effect — the outputs are marked aborted and the offset is not advanced, so the restarted consumer reprocesses cleanly and re-produces under a new transaction. The atomic binding eliminates the window where a crash could leave outputs written but the offset not advanced (causing reprocessing) or the offset advanced but outputs not written (causing loss).

**Q: Why must downstream consumers set `isolation.level=read_committed`?**
A: Because the atomicity of a transaction is only visible to readers that respect commit and abort markers. The transaction coordinator writes control markers into the output partitions; a `read_committed` consumer withholds a transaction's records until it sees the commit marker and discards them if it sees an abort marker, so it never observes the output of an aborted or in-flight transaction. With the default `read_uncommitted`, a downstream consumer sees records as soon as they are written, including those that later abort, which defeats exactly-once. So every consumer reading transactional output must be `read_committed`, accepting the small added latency of waiting for the commit marker.

**Q: What is zombie fencing and why does it need a stable `transactional.id`?**
A: Zombie fencing prevents an old, hung instance of a transactional producer from committing after a new instance has taken over. If an instance pauses long enough to be declared dead and a replacement starts with the same `transactional.id`, the replacement's `initTransactions` bumps an epoch associated with that id, and the coordinator then rejects any transaction operation from the old, lower epoch — the zombie is fenced out and cannot corrupt the results. This only works if the `transactional.id` is stable across restarts (so the epoch mechanism has a consistent identity to bump) and unique per logical processor (so two live processors do not fence each other into a loop). The id is the identity Kafka fences on, which is why its stability and uniqueness are non-negotiable.

**Q: What is the single biggest misconception about Kafka exactly-once?**
A: That it extends beyond Kafka. A Kafka transaction can enrol Kafka writes and Kafka offset commits and nothing else, so if your transformation also writes to a database, calls a payment API, or sends an email, that external effect is not part of the transaction — a crash can commit the Kafka transaction but not the external write, or the reverse. Across that boundary you have the classic dual-write problem, and Kafka EOS does nothing for it. You solve it with idempotency at the external system, the outbox pattern, or an idempotent sink connector. Teams that assume Kafka EOS makes their whole pipeline exactly-once, database included, ship duplicate side effects and are surprised.

**Q: (Senior) When would you choose at-least-once with idempotent consumers over Kafka transactions?**
A: Whenever the pipeline touches an external system, and often even when it does not. The moment a transform writes to a database or calls an API, Kafka transactions cannot cover that write, so I need idempotency at that boundary regardless — a dedup key, an upsert, an outbox — and once I have built idempotent consumers, the marginal value of Kafka transactions on the Kafka-internal hops is small, while their cost is real: coordinator round trips, commit-marker latency, `read_committed` lag, fragile configuration, and a transaction coordinator to operate. So for most pipelines that are not purely Kafka-to-Kafka, I standardise on at-least-once delivery plus idempotent consumers everywhere, which is simpler to reason about, faster, and gives effective exactly-once end to end. I reserve Kafka transactions for genuinely Kafka-internal stream processing where the outputs are other Kafka topics and there are no external side effects — and there I strongly prefer Kafka Streams' `exactly_once_v2` flag over hand-rolling the transactional loop, because the manual version is easy to break with a stray auto-commit or a non-unique id. The decision hinges on where the side effects land: inside Kafka, transactions are clean; outside, idempotency is unavoidable and usually sufficient on its own.

**Q: (Senior) Walk through everything that can silently break a hand-rolled transactional loop.**
A: There are several traps, each of which leaves a loop that appears to work while quietly duplicating or losing. First and most common, leaving `enable.auto.commit=true` on the consumer: the transaction commits offsets via sendOffsetsToTransaction, but auto-commit *also* commits them on its own timer, outside the transaction, so a crash can advance the offset without the outputs having committed, causing silent loss — auto-commit must be off. Second, a non-unique or unstable `transactional.id`: if two processor instances share an id they fence each other, each bumping the epoch and invalidating the other's transactions in an endless loop that makes no progress; if the id changes on every restart, zombie fencing is defeated and a hung old instance can commit stale results. Third, forgetting `read_committed` on downstream consumers, which then see aborted-transaction records and defeat the whole point. Fourth, `transaction.timeout.ms` set below the worst-case batch processing time, so a slow batch has its transaction aborted mid-flight by the coordinator, turning a transient slowdown into repeated aborts and no progress. Fifth, not passing the consumer group metadata correctly to sendOffsetsToTransaction, so the offsets are not bound to the right group and the atomicity is illusory. Sixth, catching a produce or commit error and proceeding rather than aborting and reprocessing the batch, which corrupts the atomic unit. Because every one of these fails silently — the code runs, messages flow, and the breakage only shows as duplicates or gaps under crash conditions — I strongly prefer Kafka Streams' EOS flag, which encapsulates the entire lifecycle correctly, and I treat any hand-rolled loop as needing an explicit crash-injection test that asserts no duplicates and no loss.

**Q: (Senior) How does exactly-once interact with the outbox pattern at a system boundary?**
A: They compose to give effective exactly-once across the boundary that Kafka's own guarantee cannot cross. The problem at a boundary is the dual-write: a service that updates its database and publishes a Kafka event does two writes that can partially fail, and no Kafka transaction spans the database. The outbox pattern fixes the *produce* side: the service writes the domain change and an outbox row in one database transaction, so the event is recorded atomically with the state change, and a relay — often Debezium reading the database log via CDC — publishes the outbox rows to Kafka. This guarantees the event is published if and only if the database change committed, closing the producer-side dual-write. On the *consume* side, the downstream service must still be idempotent, because the relay publishes at-least-once (a crash between publish and marking the outbox row processed re-publishes), so the consumer deduplicates on the event's stable id. Kafka's own EOS then applies to any purely-Kafka hops in between. So the full picture is: outbox for the atomic produce at the source boundary, idempotent consumers at the sink boundary, and Kafka transactions or Streams EOS for the Kafka-internal processing — three mechanisms, each covering the segment the others cannot, which together give a pipeline that is effectively exactly-once end to end even though no single mechanism achieves that alone.

## 10. Quick Revision & Cheat Sheet

| Mechanism | Solves | Key config |
|---|---|---|
| Idempotent producer | Producer-retry duplicates | `enable.idempotence=true` (default), `acks=all` |
| Transactions | Consumer-reprocessing duplicates | `transactional.id`, atomic write + offset commit |
| `read_committed` | Seeing aborted-transaction records | consumer `isolation.level=read_committed` |
| Zombie fencing | Old instance committing after failover | stable, unique `transactional.id` + epoch |
| Kafka Streams EOS | All of the above, one flag | `processing.guarantee=exactly_once_v2` |

**The two traps that silently break it**
- **Auto-commit on** → offsets escape the transaction → loss on crash. Set `enable.auto.commit=false`.
- **Non-unique / unstable `transactional.id`** → fencing loop or defeated fencing. Stable + unique per processor.

**Flash cards**
- **Exactly-once of what?** → Processing, within Kafka. Not delivery, not external systems.
- **Idempotent producer solves?** → Producer-retry duplicates only. Not consumer reprocessing.
- **What makes the loop exactly-once?** → Transactions binding output writes to the consumed offset atomically.
- **Downstream must set?** → `read_committed`, or it sees aborted records.
- **Biggest misconception?** → That EOS covers your database. It stops at Kafka's edge.
- **Best way to get EOS?** → Kafka Streams `exactly_once_v2`, not a hand-rolled loop.

## 11. Hands-On Exercises & Mini Project

- [ ] Enable the idempotent producer, force retries (kill a broker mid-send), and confirm no duplicate records land.
- [ ] Build a naive read-process-produce loop with manual offset commit *after* producing, crash it between produce and commit, and observe duplicate outputs.
- [ ] Convert it to a transactional loop with `sendOffsetsToTransaction`, repeat the crash, and confirm no duplicates and no loss.
- [ ] Leave `enable.auto.commit=true` on the transactional loop and demonstrate that it silently breaks exactly-once under a crash.
- [ ] Run two instances with the *same* `transactional.id` and observe the fencing loop; give them unique ids and confirm both make progress.
- [ ] Read the transactional output with `read_uncommitted` and then `read_committed`, and observe aborted records appearing only in the former.

### Mini Project — "Exactly-Once Pipeline, With and Without"

**Goal.** Prove, under crash injection, that the idempotent producer and transactions each close a distinct duplicate source, and that together they make consume-transform-produce exactly-once — while nothing extends past Kafka.

**Requirements.**
1. Build a consume-transform-produce pipeline reading an input topic and writing an output topic, with a deterministic transform so duplicates are detectable.
2. Inject crashes at three points — after produce/before commit, mid-transaction, and during producer retry — and measure duplicates and loss.
3. Show the progression: at-least-once (duplicates on reprocessing), plus idempotent producer (retry duplicates gone but reprocessing duplicates remain), plus transactions (both gone).
4. Add a downstream `read_committed` consumer and confirm it never sees aborted-transaction records; contrast with `read_uncommitted`.
5. Add an external side effect (a Postgres write) inside the transform and demonstrate that the Kafka transaction does *not* make it exactly-once, then fix that boundary with an idempotency key.

**Extensions.**
- Reimplement the pipeline in Kafka Streams with `exactly_once_v2` and compare the code size and the failure behaviour.
- Measure the throughput and end-to-end latency cost of transactions versus at-least-once + idempotent consumer, and tune transaction batch size against the abort penalty.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Delivery Guarantees* (why exactly-once delivery is impossible and what the semantics mean), *Producers: Partitioning, Batching & acks* (the idempotent producer and acks=all), *Design: Consumers, Groups, Offsets & Rebalancing* (offset commit and the reprocessing window), *Idempotency, Deduplication & the Outbox Pattern* (making the external boundary safe), *Design: Kafka Streams* (EOS as a single configuration flag).

- **Apache Kafka — Exactly Once Semantics** — Apache · *Advanced* · the authoritative description of the idempotent producer, transactions, and `read_committed`; the primary source for this chapter. <https://kafka.apache.org/documentation/#semantics>
- **KIP-98: Exactly Once Delivery and Transactional Messaging** — Apache · *Advanced* · the design proposal that introduced producer ids, sequence numbers and transactions, with the reasoning behind each. <https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging>
- **Confluent — Exactly-Once Semantics Are Possible: Here's How Kafka Does It** — Neha Narkhede · *Advanced* · the canonical explainer of how the two mechanisms combine for exactly-once processing. <https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/>
- **You Cannot Have Exactly-Once Delivery** — Tyler Treat · *Advanced* · the honest account of why delivery is at-least-once and why processing idempotency is the real answer. <https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/>
- **Confluent — Transactions in Apache Kafka** — Apurva Mehta & Jason Gustafson · *Advanced* · the internals of the transaction coordinator, control markers and fencing. <https://www.confluent.io/blog/transactions-apache-kafka/>
- **Kafka Streams — Exactly-once (EOS v2)** — Confluent docs · *Intermediate* · how `processing.guarantee=exactly_once_v2` wraps the transactional loop for a whole topology. <https://docs.confluent.io/platform/current/streams/concepts.html>
- **Designing Data-Intensive Applications, ch. 9 & 11** — Martin Kleppmann · *Advanced* · the systems foundations of the two-generals problem, idempotence and exactly-once processing. <https://dataintensive.net/>
- **confluent-kafka-go — transactions example** — Confluent · *Intermediate* · a working Go transactional producer, the basis of the loop in this chapter. <https://github.com/confluentinc/confluent-kafka-go>

---

*Kafka & RabbitMQ Handbook — chapter 20.*
