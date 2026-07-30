# 15 · Producers: Partitioning, Batching & acks

> **In one line:** A Kafka producer is a throughput machine wrapped around three dials — the *key* that decides partition and ordering, the *batch* that trades a little latency for a lot of throughput, and `acks` that trades latency for durability — and knowing which dial does what is the difference between a fast, safe pipeline and a slow, lossy one.

---

## 1. Overview

The producer looks trivial from the outside: you call "send this record" and it appears in a topic. Underneath, the client is doing real engineering on your behalf — serialising the record, choosing a partition, buffering it into a batch with other records bound for the same partition, optionally compressing that batch, sending it to the right broker, waiting for the configured acknowledgement, and retrying on failure without (if configured right) creating duplicates or reordering. Every one of those steps is a knob, and the defaults are good but not universal. The job of this chapter is to make the knobs legible so you set them deliberately rather than by cargo-cult.

Three decisions dominate. **Partitioning** — how the producer maps a record to a partition — is really an *ordering* decision, because same-partition records are ordered and cross-partition records are not (chapter 13). Give related records the same key and they stay in order; give them null keys and they scatter. **Batching** — collecting many records into one request before sending — is the *throughput* decision, because per-request overhead (network round-trips, broker request handling) is amortised across the batch; `linger.ms` and `batch.size` govern how long and how large the producer waits. **acks** — how many replicas must confirm a write before the producer considers it done — is the *durability* decision, and it is a genuine trade: `acks=0` is fastest and can silently lose data, `acks=all` is durable and slower. Around these sit compression (shrink the batch), the idempotent producer (retry without duplicating), and the ordering-versus-parallelism interplay of `max.in.flight.requests.per.connection`.

The honest framing is that a producer is a set of trade-offs between three things you cannot maximise simultaneously — latency, throughput and durability — plus a correctness layer (idempotence) that removes the old tax of "retries create duplicates". Modern Kafka defaults (`enable.idempotence=true`, `acks=all`) push you toward safe-and-fast, but you should understand what each setting buys so you can move along the curve when a workload demands it.

## 2. Core Concepts

- **Producer** — the client that publishes records to topics. Thread-safe; one instance is meant to be shared across many application threads.
- **Record** — key, value, headers, timestamp, and (implicitly) a target topic and partition. The key drives partitioning.
- **Serializer** — turns your key and value objects into bytes (String, Avro, Protobuf, JSON). The broker only ever sees bytes.
- **Partitioner** — the component that maps a record to a partition: key hash if there is a key, sticky/round-robin if not, or a custom implementation.
- **Record accumulator** — the in-memory buffer that groups records into per-partition batches awaiting send.
- **batch.size** — the maximum size (bytes) of one partition's batch before it is considered full and ready to send.
- **linger.ms** — how long the producer waits for more records to fill a batch before sending it anyway. Trades latency for batching.
- **Compression** — `compression.type` (`lz4`/`zstd`/`snappy`/`gzip`/`none`) compresses the batch, cutting network and storage at some CPU cost.
- **acks** — required acknowledgements: `0` (none), `1` (leader only), `all`/`-1` (all in-sync replicas). The durability dial.
- **Idempotent producer** — `enable.idempotence=true`: the broker deduplicates retries per producer/partition using a sequence number, so a retry cannot create a duplicate. Default in modern Kafka.
- **max.in.flight.requests.per.connection** — how many unacknowledged requests can be in flight at once; interacts with retries and ordering.
- **delivery.timeout.ms / retries** — the overall deadline for a send (including retries) and the retry count.

## 3. Theory & Principles

### The three-way trade: latency, throughput, durability

A producer cannot simultaneously minimise latency, maximise throughput and maximise durability; you choose a point in that space, and the settings are how you express it. **Latency** is how quickly a single send completes: it is lowest when the producer sends immediately (`linger.ms=0`) and waits for the fewest acks (`acks=0` or `1`). **Throughput** is records per second across the pipeline: it is highest when records are batched (larger `batch.size`, non-zero `linger.ms`) and compressed, because per-request overhead is amortised and less data crosses the wire. **Durability** is the probability a acknowledged record survives failures: it is highest with `acks=all` plus `min.insync.replicas=2` on a replication-factor-3 topic, so an acknowledged record is on at least two brokers. These pull against each other — waiting to batch adds latency, waiting for all replicas to ack adds latency, and the safest ack level is the slowest — so the art is choosing the point your workload actually needs, not maxing one dial blindly.

The key insight is that batching makes the latency cost of durability nearly free at scale. If you are sending thousands of records per second, a `linger.ms` of a few milliseconds fills batches that would have formed anyway, so you pay almost no extra latency but gain large throughput; and `acks=all` on those batches adds one replication round-trip amortised across the whole batch. So the modern default posture — `acks=all`, `enable.idempotence=true`, a small `linger.ms`, compression on — is fast *and* safe for high-volume streams. It is only at low volume or for latency-critical single sends that the trade becomes sharp.

### Partitioning is an ordering decision

Where a record lands is not a load-balancing detail; it decides ordering. Kafka guarantees order only within a partition (chapter 13), so the partitioner is where you decide which records are ordered relative to each other. With a **key**, the default partitioner computes `murmur2(key) % numPartitions`, so all records with the same key go to the same partition and are therefore strictly ordered — this is how you keep, say, all events for one account in sequence. With a **null key**, there is nothing to order by, so the producer spreads records for throughput: modern clients use a **sticky partitioner** that sends a burst of records to one partition (filling a batch), then switches to another, which batches far better than pure round-robin while still spreading load over time. You can also write a **custom partitioner** when you need routing the default cannot express — for example pinning a set of keys to a specific partition, or hashing on a field inside the value.

The practical rule: choose the key to be the thing whose order you care about (the entity id), high in cardinality (so load spreads across partitions), and evenly distributed (so no partition is hot). A null key means "I do not care about order for these", which is fine for independent events but wrong the moment two records must be processed in sequence.

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="p1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The producer send path: serialize &#8594; partition &#8594; batch &#8594; send &#8594; ack</text>

  <rect x="24" y="40" width="832" height="150" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <rect x="40" y="66" width="120" height="44" rx="6" fill="#fff" stroke="#2563eb"/><text x="100" y="84" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">1. Serialize</text><text x="100" y="100" text-anchor="middle" fill="#1d4ed8" font-size="8">key,value &#8594; bytes</text>
  <path d="M160,88 L196,88" stroke="#2563eb" stroke-width="2" marker-end="url(#p1)"/>
  <rect x="200" y="66" width="120" height="44" rx="6" fill="#fff" stroke="#2563eb"/><text x="260" y="84" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">2. Partition</text><text x="260" y="100" text-anchor="middle" fill="#1d4ed8" font-size="8">key hash / sticky</text>
  <path d="M320,88 L356,88" stroke="#2563eb" stroke-width="2" marker-end="url(#p1)"/>
  <rect x="360" y="66" width="140" height="44" rx="6" fill="#fff" stroke="#2563eb"/><text x="430" y="84" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">3. Accumulate</text><text x="430" y="100" text-anchor="middle" fill="#1d4ed8" font-size="8">per-partition batch</text>
  <path d="M500,88 L536,88" stroke="#2563eb" stroke-width="2" marker-end="url(#p1)"/>
  <rect x="540" y="66" width="130" height="44" rx="6" fill="#fff" stroke="#2563eb"/><text x="605" y="84" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">4. Compress+send</text><text x="605" y="100" text-anchor="middle" fill="#1d4ed8" font-size="8">to the leader</text>
  <path d="M670,88 L706,88" stroke="#2563eb" stroke-width="2" marker-end="url(#p1)"/>
  <rect x="710" y="66" width="130" height="44" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="775" y="84" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">5. Ack</text><text x="775" y="100" text-anchor="middle" fill="#15803d" font-size="8">per acks setting</text>
  <text x="40" y="140" fill="#1d4ed8" font-size="10">batch.size = max bytes per batch &#183; linger.ms = how long to WAIT to fill it &#183; larger/longer = more throughput, more latency</text>
  <text x="40" y="162" fill="#1d4ed8" font-size="10">idempotent producer tags each batch with a producer id + sequence &#8594; broker drops a duplicate on retry</text>
  <text x="40" y="182" fill="#1e40af" font-size="10" font-weight="bold">one producer instance is thread-safe &#8212; share it across your app threads</text>

  <rect x="24" y="204" width="410" height="256" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="229" y="224" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">acks: the durability dial</text>
  <rect x="44" y="238" width="370" height="56" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="56" y="256" fill="#b91c1c" font-size="10" font-weight="bold">acks=0 &#8226; fire-and-forget</text>
  <text x="56" y="272" fill="#991b1b" font-size="9">no wait; fastest; CAN LOSE (leader may never store it)</text>
  <text x="56" y="288" fill="#991b1b" font-size="9">use: high-volume metrics where loss is tolerable</text>
  <rect x="44" y="300" width="370" height="56" rx="6" fill="#fff" stroke="#d97706"/>
  <text x="56" y="318" fill="#b45309" font-size="10" font-weight="bold">acks=1 &#8226; leader ack</text>
  <text x="56" y="334" fill="#92400e" font-size="9">leader stored it; CAN LOSE if leader dies before</text>
  <text x="56" y="350" fill="#92400e" font-size="9">a follower replicates &#8594; the window of loss</text>
  <rect x="44" y="362" width="370" height="82" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="56" y="380" fill="#15803d" font-size="10" font-weight="bold">acks=all (-1) &#8226; ISR ack &#8226; DURABLE</text>
  <text x="56" y="396" fill="#166534" font-size="9">all in-sync replicas have it before ack</text>
  <text x="56" y="412" fill="#166534" font-size="9">pair with min.insync.replicas=2, RF=3 (chapter 17)</text>
  <text x="56" y="430" fill="#166534" font-size="9">&#8594; acked record survives one broker failure</text>

  <rect x="446" y="204" width="410" height="256" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="651" y="224" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Idempotence &amp; ordering</text>
  <text x="462" y="248" fill="#b45309" font-size="10" font-weight="bold">enable.idempotence=true (default)</text>
  <text x="462" y="266" fill="#92400e" font-size="9">each record gets (producer id, sequence) per partition</text>
  <text x="462" y="282" fill="#92400e" font-size="9">broker rejects a duplicate sequence &#8594; retry is SAFE</text>
  <text x="462" y="298" fill="#92400e" font-size="9">requires acks=all &amp; max.in.flight &#8804; 5</text>
  <text x="462" y="324" fill="#b45309" font-size="10" font-weight="bold">ordering under retries</text>
  <text x="462" y="342" fill="#92400e" font-size="9">without idempotence: a retried batch can land AFTER</text>
  <text x="462" y="358" fill="#92400e" font-size="9">a later one &#8594; reordering, if max.in.flight &gt; 1</text>
  <text x="462" y="378" fill="#92400e" font-size="9">with idempotence: broker restores order by sequence</text>
  <text x="462" y="402" fill="#b45309" font-size="10" font-weight="bold">delivery.timeout.ms</text>
  <text x="462" y="420" fill="#92400e" font-size="9">the overall deadline for a send incl. all retries;</text>
  <text x="462" y="436" fill="#92400e" font-size="9">retries happen until this elapses, then the send fails</text>
</svg>
```

## 4. Architecture & Workflow

### Inside the producer: the accumulator and sender

A record you "send" does not go straight to the network. The call serialises the key and value, runs the partitioner to pick a partition, and appends the record to a per-partition batch inside the **record accumulator** — an in-memory buffer bounded by `buffer.memory`. A background **sender** thread drains the accumulator: a batch becomes eligible to send when it reaches `batch.size` *or* when `linger.ms` has elapsed since the batch's first record, whichever comes first. The sender groups eligible batches by destination broker, optionally compresses each batch, and sends them, respecting `max.in.flight.requests.per.connection` per broker connection. When the broker acks (per `acks`), the futures for that batch's records complete; on a retriable error the sender re-enqueues the batch until `delivery.timeout.ms` is exhausted.

This architecture is why `linger.ms` is not "added latency" so much as "a window to batch": at high volume the batch fills before `linger.ms` elapses, so you pay little; at low volume you pay up to `linger.ms` but there was no throughput to gain anyway. And it is why one producer instance should be shared — the accumulator and sender amortise across all your threads, so creating a producer per request destroys batching and throughput.

### acks and the durability contract

The `acks` setting decides when the leader tells the producer "done". With `acks=0` the producer does not wait at all — it fires the batch and moves on, so if the leader never stored it (network drop, broker crash) the record is silently lost. With `acks=1` the leader acknowledges once *it* has written the record to its log, but before followers have necessarily replicated it; if the leader then dies and a follower that never got the record becomes leader, the record is lost — a real but narrow window. With `acks=all` (`-1`) the leader waits until all **in-sync replicas** have the record before acknowledging, so an acknowledged record survives the loss of any replica that was in the ISR. But `acks=all` alone is not enough: you must also set `min.insync.replicas=2` (with replication factor 3) so that if the ISR shrinks to just the leader, the write is *rejected* rather than acknowledged with only one copy. `acks=all` plus `min.insync.replicas=2` is the durability contract, and chapter 17 covers the replication side in full.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Where each acks level acknowledges &#8212; and the window each leaves open</text>

  <rect x="24" y="42" width="180" height="34" rx="6" fill="#fff" stroke="#2563eb"/><text x="114" y="64" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">Producer sends batch</text>
  <rect x="24" y="120" width="180" height="200" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="114" y="142" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">Leader (broker 1)</text>
  <rect x="44" y="154" width="140" height="28" rx="4" fill="#fff" stroke="#2563eb"/><text x="114" y="172" text-anchor="middle" fill="#1e40af" font-size="9">append to log</text>
  <rect x="360" y="120" width="180" height="90" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="450" y="142" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Follower (broker 2)</text>
  <rect x="380" y="154" width="140" height="28" rx="4" fill="#fff" stroke="#16a34a"/><text x="450" y="172" text-anchor="middle" fill="#15803d" font-size="9">replicate (ISR)</text>
  <rect x="360" y="230" width="180" height="90" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="450" y="252" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Follower (broker 3)</text>
  <rect x="380" y="264" width="140" height="28" rx="4" fill="#fff" stroke="#16a34a"/><text x="450" y="282" text-anchor="middle" fill="#15803d" font-size="9">replicate (ISR)</text>

  <path d="M204,168 L356,168" stroke="#16a34a" stroke-width="1.5"/>
  <path d="M204,172 L356,278" stroke="#16a34a" stroke-width="1.5"/>

  <line x1="620" y1="150" x2="620" y2="196" stroke="#dc2626" stroke-width="2"/>
  <text x="700" y="158" text-anchor="middle" fill="#b91c1c" font-size="9" font-weight="bold">acks=0: no wait</text>
  <text x="700" y="176" text-anchor="middle" fill="#991b1b" font-size="8">lost if leader never stored it</text>

  <line x1="620" y1="216" x2="620" y2="262" stroke="#d97706" stroke-width="2"/>
  <text x="700" y="224" text-anchor="middle" fill="#b45309" font-size="9" font-weight="bold">acks=1: leader wrote it</text>
  <text x="700" y="242" text-anchor="middle" fill="#92400e" font-size="8">lost if leader dies pre-replication</text>

  <line x1="620" y1="286" x2="620" y2="332" stroke="#16a34a" stroke-width="2"/>
  <text x="700" y="294" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">acks=all: ISR has it</text>
  <text x="700" y="312" text-anchor="middle" fill="#166534" font-size="8">survives one broker failure</text>

  <rect x="24" y="336" width="832" height="0" fill="none"/>
  <text x="24" y="356" fill="#334155" font-size="10" font-weight="bold">min.insync.replicas=2 (RF=3): if the ISR shrinks to just the leader, acks=all REJECTS the write rather than acking one copy.</text>
</svg>
```

### Idempotence and ordering under retries

Retries are necessary — networks drop acks — but naive retries cause two bugs: **duplicates** (the write succeeded but the ack was lost, so the retry writes it again) and **reordering** (a retried batch lands after a later batch when more than one request is in flight). The **idempotent producer** (`enable.idempotence=true`, the default in modern Kafka) fixes both. The producer is assigned a producer id, and each record carries a per-partition sequence number; the broker tracks the last sequence it accepted per producer per partition, so a retried batch with an already-seen sequence is dropped (no duplicate), and out-of-order batches are rejected and reordered by sequence (order preserved). This requires `acks=all` and `max.in.flight.requests.per.connection` ≤ 5, both of which the client enforces when idempotence is on. The result is *exactly-once semantics for the producer-to-broker hop* — a single logical write appears once in the log despite retries — which is the foundation the transactional producer builds on for end-to-end exactly-once (chapter 20).

## 5. Implementation

First a producer with `segmentio/kafka-go`, showing keys (ordering), batching, acks and required-ack durability.

```go
package main

import (
	"context"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

func main() {
	w := &kafka.Writer{
		Addr:  kafka.TCP("broker1:9092", "broker2:9092", "broker3:9092"),
		Topic: "orders",

		// PARTITIONING: Hash balancer => murmur-style hash(key) % partitions, so
		// records with the same key share a partition and stay ordered. Swap for
		// &kafka.RoundRobin{} only when you have NO ordering requirement.
		Balancer: &kafka.Hash{},

		// DURABILITY: RequireAll == acks=all. Combined with a topic that has
		// min.insync.replicas=2 and RF=3, an acknowledged record is on >=2 brokers
		// and survives one broker failure. RequireOne (acks=1) is faster but has a
		// loss window; RequireNone (acks=0) can silently lose data.
		RequiredAcks: kafka.RequireAll,

		// BATCHING: send when the batch reaches BatchBytes OR BatchTimeout elapses.
		// A few ms of BatchTimeout is the "linger" window: at volume it fills
		// batches almost for free; at low volume it caps added latency.
		BatchBytes:   1 << 20,               // ~1 MiB max batch
		BatchTimeout: 5 * time.Millisecond,  // linger.ms equivalent

		// COMPRESSION: shrink each batch on the wire and on disk. lz4/zstd are the
		// usual choices — good ratio, low CPU. Compression works on the BATCH, so
		// it pairs with batching: bigger batches compress better.
		Compression: kafka.Lz4,

		// kafka-go enables idempotent, ordered delivery semantics with RequireAll;
		// the writer retries internally without creating duplicates.
	}
	defer w.Close()

	ctx := context.Background()
	// Same key -> same partition -> these two are ordered relative to each other.
	err := w.WriteMessages(ctx,
		kafka.Message{Key: []byte("acct-42"), Value: []byte(`{"op":"debit","amt":100}`)},
		kafka.Message{Key: []byte("acct-42"), Value: []byte(`{"op":"credit","amt":30}`)},
	)
	if err != nil {
		// With RequireAll this error means the durability contract was NOT met
		// (e.g. fewer than min.insync.replicas were available) — do not assume
		// the record is stored. Handle it (retry / dead-letter / alert).
		log.Fatalf("write failed, record NOT durably stored: %v", err)
	}
	log.Println("records acknowledged by the in-sync replicas")
}
```

The `confluentinc/confluent-kafka-go` client (a librdkafka wrapper) exposes the raw Kafka config keys, which makes the trade-offs explicit and is closer to what you set in the JVM client.

```go
package main

import (
	"fmt"
	"log"

	"github.com/confluentinc/confluent-kafka-go/v2/kafka"
)

func main() {
	p, err := kafka.NewProducer(&kafka.ConfigMap{
		"bootstrap.servers": "broker1:9092,broker2:9092,broker3:9092",

		// DURABILITY + CORRECTNESS: idempotence forces acks=all and bounded
		// in-flight, so retries neither duplicate nor reorder. This is the
		// modern default and the right baseline.
		"enable.idempotence": true,
		"acks":               "all",

		// THROUGHPUT: batch up to 5ms and 64 KiB, compress with zstd.
		"linger.ms":        5,
		"batch.size":       65536,
		"compression.type": "zstd",

		// ORDERING: with idempotence on, up to 5 in-flight requests still preserve
		// order (the broker reorders by sequence). Without idempotence you'd need
		// max.in.flight=1 to guarantee order under retries — a throughput cost.
		"max.in.flight.requests.per.connection": 5,

		// The overall deadline for a send including retries. After this the
		// delivery report carries an error and you must handle the failure.
		"delivery.timeout.ms": 120000,
	})
	if err != nil {
		log.Fatal(err)
	}
	defer p.Close()

	// Delivery reports arrive asynchronously; you MUST check them — a produce call
	// enqueues, it does not confirm. This is where you learn a send truly failed.
	go func() {
		for e := range p.Events() {
			if m, ok := e.(*kafka.Message); ok {
				if m.TopicPartition.Error != nil {
					log.Printf("DELIVERY FAILED: %v", m.TopicPartition.Error)
				} else {
					fmt.Printf("delivered to %v\n", m.TopicPartition)
				}
			}
		}
	}()

	topic := "orders"
	// Keyed produce: the key drives partition and ordering.
	_ = p.Produce(&kafka.Message{
		TopicPartition: kafka.TopicPartition{Topic: &topic, Partition: kafka.PartitionAny},
		Key:            []byte("acct-42"),
		Value:          []byte(`{"op":"debit","amt":100}`),
	}, nil)

	// Flush blocks until outstanding messages are delivered (or the timeout hits).
	// Always flush before exit, or you lose whatever is still buffered.
	p.Flush(15000)
}
```

Two disciplines the code encodes: **always check the delivery outcome** (the async `WriteMessages` error or the delivery report) — a produce call enqueues, it does not confirm, so ignoring the result is how "we sent it" quietly becomes "it was lost"; and **flush before exit**, because whatever is still in the accumulator is gone if the process dies.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **High throughput from batching + compression.** Amortising per-request overhead and shrinking the wire payload lets one producer sustain very high rates.
- **Tunable durability.** `acks` plus `min.insync.replicas` lets you dial from fire-and-forget to survives-a-broker-failure per topic/producer.
- **Safe retries by default.** The idempotent producer removes the old duplicate-on-retry and reorder-on-retry hazards without effort.
- **Per-key ordering for free.** Keying gives strict ordering for related records while distinct keys spread for parallelism.
- **Backpressure built in.** A full accumulator (`buffer.memory`) blocks or errors the producer, signalling the app to slow down rather than exploding memory.

**Disadvantages**
- **Async completion is easy to ignore.** A send only enqueues; forgetting to check the result or flush loses records silently.
- **Latency cost of safety.** `acks=all` and `linger.ms` add latency, which matters for low-volume, latency-critical sends.
- **CPU cost of compression.** Compression trades CPU for network/disk; the wrong codec or tiny batches can cost more than they save.
- **Misconfiguration is subtle.** `acks=1` with a false sense of durability, or `acks=0` "for speed", produces data loss that only shows up during broker failures.

**Trade-offs**
- *Latency vs throughput:* larger `batch.size`/`linger.ms` and compression raise throughput but add latency; at high volume the latency cost is near-zero, at low volume it is real.
- *Latency vs durability:* `acks=all` + `min.insync.replicas=2` is durable but waits for replication; `acks=1` is faster with a loss window; `acks=0` is fastest and lossy.
- *Ordering vs parallelism:* keying pins related records to one partition (ordered) but concentrates them; null keys parallelise but abandon order.
- *Idempotence constraints vs freedom:* idempotence caps in-flight requests at 5 and forces `acks=all`, a small constraint for a large correctness gain.

## 7. Common Mistakes & Best Practices

- **Treating `send` as confirmation.** A produce call only enqueues into the accumulator; ignoring the async result or delivery report means you never learn about failures. Always check the outcome.
- **Not flushing/closing on shutdown.** Records buffered in the accumulator are lost if the process exits without a flush. Flush (or close) before exit.
- **Using `acks=1` and believing it is durable.** It acknowledges before followers replicate, so a leader failure in that window loses the record. Use `acks=all` with `min.insync.replicas=2` when durability matters.
- **A producer per request.** Creating a producer per message or request destroys batching and connection reuse; create one thread-safe producer and share it.
- **Null keys where order matters.** Null-key records scatter across partitions, so two related records can be processed out of order. Key them by the ordering entity.
- **A low-cardinality or skewed key.** Keying by something like country creates a hot partition; choose a high-cardinality, evenly-distributed key.
- **Disabling idempotence for "speed".** You reintroduce duplicates and reordering under retries for a negligible gain. Leave it on.
- **Best practice: default to `acks=all`, `enable.idempotence=true`, a small `linger.ms`, and compression; then key by the ordering entity and only deviate with a measured reason.** This posture is fast and safe for high-volume streams; move off it deliberately, not by habit.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** For "records are missing", check whether the app ignored delivery errors or exited without flushing, and whether `acks` was `0`/`1` during a broker failure. For "duplicates", confirm idempotence is on and look at consumer-side dedup (chapter 21). For "ordering is wrong", check for null keys, a custom partitioner, or `max.in.flight > 1` with idempotence off. For "producer is slow", inspect batch size and compression and whether one producer is shared.
- **Monitoring.** Track producer metrics: `record-error-rate` and `record-retry-rate` (failures and retries), `request-latency-avg`, `batch-size-avg` and `records-per-request-avg` (are batches actually forming?), `buffer-available-bytes` (accumulator pressure), and compression ratio. Rising retry rate or falling buffer-available signals broker trouble or backpressure (chapter 27).
- **Security.** Producers authenticate to the broker (SASL) and encrypt in transit (TLS); ACLs restrict which principals may write to which topics, so a compromised producer cannot publish to arbitrary topics. Validate and size payloads (a giant record can exceed `max.request.size` / broker `message.max.bytes`), and never log message contents that carry sensitive data (chapter 29).
- **Scaling.** One producer scales far with batching; scale out by running more producer instances (each a shared client) across app instances. Throughput per topic is ultimately bounded by partition count and broker capacity, so a producer hitting a wall may need more partitions rather than more producers. Watch that `buffer.memory` and `max.block.ms` express the backpressure you want: block (slow the app) versus fail fast.

## 9. Interview Questions

**Q: What does the `acks` setting control, and what are the three values?**
A: It controls how many replicas must acknowledge a write before the producer considers it complete — the durability dial. `acks=0` means the producer does not wait at all: fastest, but if the leader never stored the record it is silently lost. `acks=1` means the leader acknowledges once it has written the record to its own log, before followers necessarily replicated it; if the leader then fails and an un-replicated follower becomes leader, the record is lost — a real but narrow window. `acks=all` (or `-1`) means the leader waits until all in-sync replicas have the record, so an acknowledged record survives the loss of any in-sync replica. `acks=all` is only fully durable when paired with `min.insync.replicas=2` on a replication-factor-3 topic, so a shrunken ISR causes writes to be rejected rather than under-replicated.

**Q: How does the producer decide which partition a record goes to?**
A: Through the partitioner. If the record has a key, the default partitioner computes a hash of the key modulo the partition count (`murmur2(key) % N`), so the same key always maps to the same partition and its records are ordered. If the key is null, there is nothing to order by, so the producer spreads records for throughput — modern clients use a sticky partitioner that fills a batch for one partition then rotates, which batches better than round-robin. You can also supply a custom partitioner for routing the default cannot express. Because order is per-partition, the partitioning choice is really an ordering decision.

**Q: What do `batch.size` and `linger.ms` do?**
A: They govern batching, the main throughput lever. Records are accumulated into per-partition batches; `batch.size` is the maximum bytes a batch holds before it is ready to send, and `linger.ms` is how long the producer waits for more records to fill a batch before sending it anyway. Larger values mean bigger batches, which amortise per-request overhead and compress better, raising throughput at the cost of some latency. The nice property is that at high volume batches fill before `linger.ms` elapses, so you gain throughput for almost no added latency; at low volume `linger.ms` caps the extra latency you pay.

**Q: What is the idempotent producer and what problem does it solve?**
A: It solves the duplicate-and-reorder problem that naive retries cause. When a produce succeeds but its acknowledgement is lost, a retry would write the record again (a duplicate), and with multiple requests in flight a retried batch could land after a later one (reordering). With `enable.idempotence=true` — the default in modern Kafka — the producer gets a producer id and each record carries a per-partition sequence number; the broker tracks the last sequence it accepted, so it drops a retried duplicate and reorders by sequence. This gives exactly-once semantics for the producer-to-broker hop. It requires `acks=all` and bounds in-flight requests at 5, which the client enforces.

**Q: Why should you share one producer instance rather than create one per message?**
A: Because batching, compression and connection reuse all live in the shared client. A single producer's accumulator groups records from all threads into batches and its sender amortises requests and connections across them; it is thread-safe by design. Creating a producer per message or per request means every record is its own request with no batching, plus the cost of establishing connections and fetching metadata each time — destroying throughput and hammering the broker. The correct pattern is one long-lived producer shared across the application.

**Q: What does compression buy and cost?**
A: Compression (`compression.type` = lz4/zstd/snappy/gzip) shrinks each batch, reducing bytes on the wire and on disk, which raises effective throughput and lowers storage — and because Kafka stores the batch compressed, the saving persists through to the consumer. The cost is CPU to compress on the producer and (if the consumer decompresses) on the consumer, though brokers can often pass compressed batches through untouched. Compression works on the batch, so it pairs with batching — bigger batches compress better — and tiny batches barely benefit. lz4 and zstd are the usual choices for a good ratio at low CPU.

**Q: What happens to records still buffered in the producer if the process crashes?**
A: They are lost. A produce call only appends the record to the in-memory accumulator and returns; the record is not durable until the broker has acknowledged it per `acks`. If the process dies before the sender drains and the broker acks, everything still in the accumulator is gone. That is why you must flush (or close, which flushes) before exit, and why you must check delivery results — treating the send call as confirmation is the classic way to lose data silently.

**Q: (Senior) Walk through how you would configure a producer for a high-volume, must-not-lose payments stream.**
A: I would start from the safe-and-fast baseline and justify each setting against the payments requirement. Durability first: `acks=all` with the topic configured `min.insync.replicas=2` on replication factor 3, so an acknowledged payment is on at least two brokers and survives one broker failure; and `enable.idempotence=true` so retries — which will happen — cannot create duplicate payment records or reorder them. That combination is the correctness core. Then throughput, because it is high volume: a small `linger.ms` (a few milliseconds) and a reasonable `batch.size` so batches form, plus `compression.type=zstd` or `lz4` to cut the wire and disk cost; at this volume the batching latency is near-zero. Ordering: I would key each record by the account (or another entity whose order matters) so all of an account's events are in one partition and strictly ordered, and confirm the key is high-cardinality so no partition goes hot; with idempotence on, `max.in.flight=5` still preserves order. Failure handling: set `delivery.timeout.ms` to a value that gives retries room but eventually surfaces a hard failure, and on the application side actually handle a failed delivery report — retry to a retry topic or dead-letter and alert, never swallow it — because with a payment a lost send must become a visible incident, not a silent gap. Finally I would ensure one shared producer instance, flush on shutdown, and monitor record-error-rate and retry-rate. The theme is: make the correctness settings non-negotiable, then buy throughput with batching and compression that at this volume cost almost no latency, and treat every delivery result as something the application must act on.

**Q: (Senior) A downstream team reports duplicate records despite `enable.idempotence=true`. What are the possible causes?**
A: Idempotence only guarantees exactly-once for the producer-to-broker hop within a single producer session, so I would enumerate where duplicates can still arise beyond that scope. First, producer restarts: the idempotence guarantee is tied to a producer id and its per-partition sequence state, which by default does not survive a producer restart, so if the application produces the same logical record again after a crash-and-restart (for example replaying an input it had already sent), those are new sequences and the broker sees them as distinct — genuine duplicates. Exactly-once across restarts needs the transactional producer with a stable `transactional.id`, not just idempotence. Second, at-least-once at the application boundary: if the producing service itself retries a business operation (a request handler that runs twice and produces twice), idempotence cannot help because those are two different produce calls with different sequences; the dedup has to happen on a business key. Third, and most common, the duplicates may be introduced on the *consumer* side, not the producer: an at-least-once consumer that reprocesses after a rebalance or crash before committing its offset will handle the same record twice, which looks like "duplicates" downstream even though the log contains one copy (chapters 16, 21). Fourth, multiple producers writing the same data, or a mirroring/replication tool duplicating records across clusters. So my diagnosis would separate "duplicates in the log" (a producer-scope issue — check for producer restarts and whether transactions are needed) from "duplicate processing" (a consumer-scope issue — check offset-commit semantics), and the durable fix is almost always an idempotent consumer keyed on a stable business id plus, if the producer must be exactly-once across restarts, transactions. Idempotence removes the retry-duplicate within a session; it is not an end-to-end exactly-once guarantee.

**Q: (Senior) Explain the interaction between `max.in.flight.requests.per.connection`, retries and ordering.**
A: This is about whether retries can reorder records within a partition. `max.in.flight.requests.per.connection` is how many produce requests can be outstanding on one connection before the producer waits for acks. If it is greater than 1 and idempotence is off, ordering can break under retries: suppose request A (batch 1) and request B (batch 2) are both in flight to the same partition; if A fails and is retried while B has already succeeded, the retried A lands *after* B, so the records are now out of order in the log. Historically the only way to guarantee order under retries with idempotence off was `max.in.flight=1`, which serialises requests and costs throughput. The idempotent producer removes that dilemma: because each batch carries a per-partition sequence number and the broker enforces sequence order, an out-of-order or duplicate batch is rejected and the producer resends so the log ends up correctly ordered and deduplicated — and this works with up to 5 in-flight requests, so you keep most of the pipelining throughput while retaining order. So the modern answer is: turn idempotence on, leave `max.in.flight` at its default (≤5), and you get both ordering-under-retries and good throughput; the old `max.in.flight=1` workaround is only relevant if, for some reason, idempotence is disabled.

## 10. Quick Revision & Cheat Sheet

| Setting | Governs | Trade |
|---|---|---|
| key / partitioner | Partition & ordering | Order (same key) vs parallelism (spread) |
| batch.size | Batch size | Throughput vs memory |
| linger.ms | Batch wait | Throughput vs latency |
| compression.type | Payload size | Network/disk vs CPU |
| acks | Durability | Durable (all) vs fast (0/1) |
| enable.idempotence | Retry safety | Correctness for a tiny in-flight constraint |
| max.in.flight | Pipelining/order | Throughput vs ordering (if idempotence off) |
| delivery.timeout.ms | Retry deadline | Resilience vs how long a failure hides |

| acks | Waits for | Can lose? |
|---|---|---|
| 0 | nothing | yes, silently |
| 1 | leader only | yes, if leader dies pre-replication |
| all/-1 | all in-sync replicas | no (with min.insync.replicas=2, RF=3) |

**Flash cards**
- **Durability dial?** → `acks`; use `all` + `min.insync.replicas=2`.
- **Throughput dial?** → Batching (`batch.size`, `linger.ms`) + compression.
- **Ordering dial?** → The key — same key, same partition, ordered.
- **Retry duplicates/reorder fix?** → `enable.idempotence=true` (the default).
- **Does `send` confirm?** → No; check the result and flush before exit.
- **One producer or many?** → One shared, thread-safe instance.

## 11. Hands-On Exercises & Mini Project

- [ ] Send the same keyed records with `acks=0`, `1` and `all` and measure the latency difference; kill a leader mid-send and observe loss at `acks=1`.
- [ ] Produce with `linger.ms=0` versus `linger.ms=10` at high volume and compare throughput and batch-size-avg.
- [ ] Turn compression on (lz4, then zstd) and measure the on-wire and on-disk size reduction and the CPU cost.
- [ ] With idempotence off and `max.in.flight=5`, force retries and demonstrate reordering; then turn idempotence on and show order restored.
- [ ] "Forget" to flush before exit and confirm buffered records are lost; add the flush and confirm they arrive.
- [ ] Key by a low-cardinality field, observe a hot partition in per-partition metrics, then fix the key and rebalance the load.

### Mini Project — "Tuned Order Producer"

**Goal.** Build a producer for an order stream that is measurably fast and provably durable, and document the trade each setting expresses.

**Requirements.**
1. Produce order events keyed by account id with `acks=all`, `enable.idempotence=true`, a small `linger.ms`, and compression.
2. Configure the topic with `min.insync.replicas=2` and RF 3, and demonstrate that an acknowledged record survives killing one broker.
3. Instrument and report throughput, average batch size, and record-error/retry rates.
4. Add robust delivery-result handling that routes a permanently failed send to a retry/dead-letter path and alerts, never swallowing it.
5. Run a sweep over `linger.ms` and `batch.size` and produce a small table showing the throughput/latency trade.

**Extensions.**
- Add a custom partitioner that pins a set of VIP accounts to a dedicated partition and show their ordering is preserved.
- Compare `kafka-go` and `confluent-kafka-go` for the same workload and note the config-visibility and throughput differences.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Kafka Architecture: Brokers, Topics & Partitions* (where records land and why order is per-partition), *The Log: Offsets, Segments & Retention* (what happens to records after they are written), *Design: Consumers, Groups, Offsets & Rebalancing* (the read side), *Replication, ISR & Durability* (the `acks=all` contract in full), *Exactly-Once & Transactions* (idempotence extended to end-to-end).

- **Apache Kafka — Producer configuration** — Apache · *Intermediate* · the authoritative reference for `acks`, `linger.ms`, `batch.size`, idempotence and every knob in this chapter. <https://kafka.apache.org/documentation/#producerconfigs>
- **Apache Kafka — Idempotent & transactional producer (design)** — Apache · *Advanced* · how sequence numbers deduplicate retries and preserve order. <https://kafka.apache.org/documentation/#semantics>
- **Confluent — Optimizing Kafka producers (throughput vs latency vs durability)** — Confluent · *Intermediate* · the practical tuning guide for the three-way trade. <https://docs.confluent.io/cloud/current/client-apps/optimizing/throughput.html>
- **Kafka: The Definitive Guide (2nd ed.), ch. "Kafka Producers"** — Narkhede, Shapira, Palino · *Intermediate* · the producer internals — accumulator, sender, partitioner — explained clearly. <https://www.confluent.io/resources/kafka-the-definitive-guide/>
- **confluent-kafka-go** — Confluent · *Intermediate* · the librdkafka-based Go client exposing raw config keys used here. <https://github.com/confluentinc/confluent-kafka-go>
- **kafka-go — segmentio** — Segment · *Intermediate* · the pure-Go client with Writer balancers and required-acks used here. <https://github.com/segmentio/kafka-go>
- **You Cannot Have Exactly-Once Delivery** — Tyler Treat · *Advanced* · why idempotence, not delivery, is the real answer to duplicates. <https://bravenewgeek.com/you-cannot-have-exactly-once-delivery/>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · the systems view of durable, ordered, at-least-once messaging. <https://dataintensive.net/>

---

*Kafka & RabbitMQ Handbook — chapter 15.*
