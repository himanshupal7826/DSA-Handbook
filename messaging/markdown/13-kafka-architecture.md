# 13 · Kafka Architecture: Brokers, Topics & Partitions

> **In one line:** A Kafka cluster is a set of brokers that host the partitions of topics; the partition — an ordered, replicated log with one leader — is the single unit that carries both Kafka's parallelism and its only ordering guarantee, and almost every Kafka design decision is really a decision about partitions.

---

## 1. Overview

Kafka is a distributed commit log dressed up as a messaging system, and its architecture is best understood from the outside in: a **cluster** of servers called **brokers**, each broker hosting some **partitions**, where a partition is a slice of a **topic**, and a topic is just a name you give to a stream of records. That is the whole hierarchy — cluster → broker → topic → partition — and once you see how the layers fit, the behaviour that surprises newcomers (why ordering is not global, why you cannot have more consumers than partitions, why adding partitions is a one-way door) stops being surprising and becomes obvious.

The design goal that shaped everything is throughput at scale with durability. Kafka was built at LinkedIn to move enormous volumes of activity data, and its answer was to make the broker do as little as possible per message — just append bytes to a file and hand bytes back on request — while pushing the intelligence out to the clients. This is the famous **"dumb broker, smart consumer"** philosophy, and it is the opposite of RabbitMQ's smart-broker model. A Kafka broker does not track which consumer has seen which message, does not route per message, does not filter, does not maintain per-consumer delivery state. It appends to a log and serves ranges of that log. The consumer keeps its own position. That asymmetry is what lets a modest Kafka cluster sustain millions of messages per second.

The **partition** is the protagonist of this chapter and of Kafka generally. A topic is split into one or more partitions, and each partition is an independent, ordered, append-only log living on a broker (and replicated to others). Two things flow from the partition and nothing else: **parallelism** — different partitions are consumed in parallel, so the partition count is the ceiling on how many consumers in a group can work at once — and **ordering** — records are ordered *within* a partition and only within a partition, never across the whole topic. If you remember one sentence from this chapter, make it this: the partition is simultaneously the unit of parallelism and the unit of ordering, and those two roles are in permanent tension, because more partitions buys more parallelism but spreads a topic's records across more independent order-lines.

This chapter walks the cluster (brokers and the controller), the topic-to-partition split, replication (leaders and followers), how a producer's key maps to a partition, and the single most consequential capacity decision you will make on day one: how many partitions to give a topic.

## 2. Core Concepts

- **Broker** — a single Kafka server. It stores partition data on local disk and serves produce/fetch requests. A cluster is a set of brokers, each identified by a numeric `broker.id`.
- **Cluster** — the set of brokers acting together. Brokers discover each other and share cluster metadata (which broker leads which partition) via the controller.
- **Controller** — a broker role responsible for cluster-management decisions: electing partition leaders, tracking broker liveness, and propagating metadata. In modern Kafka (KRaft, KIP-500) the controllers form a Raft quorum that stores metadata in an internal log; older clusters used ZooKeeper.
- **Topic** — a named stream of records. Purely a logical grouping; the physical unit is the partition.
- **Partition** — an ordered, immutable, append-only log. The unit of storage, replication, parallelism and ordering. A topic has N partitions, numbered 0..N-1.
- **Offset** — the monotonically increasing position of a record within its partition (chapter 14).
- **Replica** — a copy of a partition on a broker. One replica is the **leader**; the rest are **followers**. The replication factor (RF) is the number of replicas.
- **Leader** — the replica that handles all produces and (normally) all fetches for a partition. Followers replicate from it.
- **ISR (in-sync replicas)** — the set of replicas currently caught up to the leader; the basis of the durability contract (chapter 17).
- **Record** — a key/value pair plus headers and a timestamp. The key (may be null) determines the partition.
- **Producer / Consumer** — clients that write to and read from partitions. Producers write to the leader; consumers read from the leader (or, since KIP-392, optionally a nearby follower).

## 3. Theory & Principles

### The partition is the atom

Everything Kafka does at scale is a consequence of one design choice: a topic is not a single log but a set of independent logs called partitions. This buys horizontal scale — you can spread a topic's partitions across many brokers, so a topic's throughput is not bounded by one machine's disk — but it costs you a global order, because there is no single sequence that spans partitions. Within partition 3, record at offset 100 definitively came before offset 101. Between partition 3's offset 100 and partition 7's offset 100, Kafka makes *no* promise about which happened first. There is no global clock and no global sequence. This is not a limitation to be worked around so much as the price of the scale: a single ordered log across many machines would require coordination on every write, which is exactly the bottleneck Kafka refuses to pay.

So the partition wears two hats at once, and they pull against each other:

- **Partition as the unit of parallelism.** Within a consumer group, each partition is consumed by at most one consumer (chapter 16). So if a topic has 12 partitions, at most 12 consumers in a group can process it concurrently; a 13th sits idle. Partition count is therefore the hard ceiling on consumer parallelism. Want to process faster? You need more partitions — and you must set that up front, because reducing partitions later is not supported and increasing them reshuffles key-to-partition mapping.
- **Partition as the unit of ordering.** Order is guaranteed only within a partition. If two records must be processed in order relative to each other — two events about the same account, say — they must land in the *same* partition, which you achieve by giving them the same key. Records with different keys may be spread across partitions and processed in any relative order.

The tension is exact: parallelism wants many partitions (more concurrent consumers), ordering wants records that must be ordered to share a partition (which concentrates them). You reconcile the two with **keys** — a good key gives you per-key ordering while still spreading distinct keys across all partitions for parallelism. Pick the key well and you get both; pick it badly (or use a null key when you needed order) and you get neither.

### Dumb broker, smart consumer

The second principle is where the broker's intelligence lives — and Kafka's answer is "almost nowhere". A Kafka broker's job for a produced record is to append it to the active segment file of the target partition and acknowledge. Its job for a fetch is to copy a range of bytes from a segment file to the socket — often via the OS `sendfile` zero-copy path, so the data never enters application memory. The broker does not know or care whether a given consumer has seen a record; it does not maintain a per-consumer cursor; it does not decide who gets what. **The consumer tracks its own position** (its offset) and asks for "everything from offset X onward". This is the inversion of RabbitMQ, where the broker holds each consumer's unacked messages and decides delivery.

The payoff of the dumb broker is enormous. Because the broker only appends and serves byte ranges, its work per message is nearly constant and dominated by sequential disk I/O and the page cache, which modern hardware does astonishingly fast. Because the consumer owns its offset, adding a consumer, replaying history, or having ten independent readers costs the broker almost nothing — they are just more fetch requests at different offsets. The cost is pushed onto the client: the consumer must manage offsets, handle rebalances, and deduplicate, which is real work (chapters 14, 16, 21). But that is the trade Kafka makes deliberately, and it is why "smart consumer" is not a slogan but an architecture.

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">A topic is N independent partition-logs, spread across brokers</text>

  <rect x="24" y="40" width="832" height="196" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="60" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Topic "orders" &#183; replication factor 3 &#183; 3 partitions across 3 brokers</text>

  <rect x="44" y="74" width="256" height="150" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="172" y="94" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Broker 1</text>
  <rect x="60" y="104" width="224" height="26" rx="4" fill="#fff" stroke="#2563eb"/><text x="172" y="121" text-anchor="middle" fill="#1e40af" font-size="9">P0 LEADER &#8226; offsets 0..n</text>
  <rect x="60" y="136" width="224" height="24" rx="4" fill="#eff6ff" stroke="#93c5fd"/><text x="172" y="152" text-anchor="middle" fill="#1d4ed8" font-size="9">P1 follower (replica)</text>
  <rect x="60" y="166" width="224" height="24" rx="4" fill="#eff6ff" stroke="#93c5fd"/><text x="172" y="182" text-anchor="middle" fill="#1d4ed8" font-size="9">P2 follower (replica)</text>

  <rect x="312" y="74" width="256" height="150" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="94" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Broker 2</text>
  <rect x="328" y="104" width="224" height="24" rx="4" fill="#f0fdf4" stroke="#86efac"/><text x="440" y="120" text-anchor="middle" fill="#166534" font-size="9">P0 follower (replica)</text>
  <rect x="328" y="134" width="224" height="26" rx="4" fill="#fff" stroke="#16a34a"/><text x="440" y="151" text-anchor="middle" fill="#15803d" font-size="9">P1 LEADER &#8226; offsets 0..n</text>
  <rect x="328" y="166" width="224" height="24" rx="4" fill="#f0fdf4" stroke="#86efac"/><text x="440" y="182" text-anchor="middle" fill="#166534" font-size="9">P2 follower (replica)</text>

  <rect x="580" y="74" width="256" height="150" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="708" y="94" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">Broker 3</text>
  <rect x="596" y="104" width="224" height="24" rx="4" fill="#fffbeb" stroke="#fcd34d"/><text x="708" y="120" text-anchor="middle" fill="#b45309" font-size="9">P0 follower (replica)</text>
  <rect x="596" y="134" width="224" height="24" rx="4" fill="#fffbeb" stroke="#fcd34d"/><text x="708" y="150" text-anchor="middle" fill="#b45309" font-size="9">P1 follower (replica)</text>
  <rect x="596" y="164" width="224" height="26" rx="4" fill="#fff" stroke="#d97706"/><text x="708" y="181" text-anchor="middle" fill="#92400e" font-size="9">P2 LEADER &#8226; offsets 0..n</text>

  <rect x="24" y="252" width="410" height="196" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="272" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Producer writes to the LEADER only</text>
  <rect x="44" y="286" width="90" height="30" rx="5" fill="#fff" stroke="#2563eb"/><text x="89" y="305" text-anchor="middle" fill="#1e40af" font-size="9">producer</text>
  <text x="150" y="300" fill="#1d4ed8" font-size="9">key="acct-42" &#8594; hash %% 3 &#8594; P0</text>
  <path d="M134,301 L300,301" stroke="#2563eb" stroke-width="2" marker-end="url(#a1)"/>
  <text x="60" y="336" fill="#1d4ed8" font-size="10">followers PULL from the leader to stay in sync</text>
  <text x="60" y="356" fill="#1d4ed8" font-size="10">leader dies &#8594; controller promotes an in-sync</text>
  <text x="60" y="372" fill="#1d4ed8" font-size="10">follower to leader (chapter 17)</text>
  <text x="60" y="398" fill="#1e40af" font-size="10" font-weight="bold">same key &#8594; same partition &#8594; ordered</text>
  <text x="60" y="422" fill="#1d4ed8" font-size="10">different keys &#8594; spread across partitions</text>

  <rect x="446" y="252" width="410" height="196" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="272" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Dumb broker, smart consumer</text>
  <text x="462" y="296" fill="#166534" font-size="10">Broker: append bytes, serve byte ranges (sendfile).</text>
  <text x="462" y="314" fill="#166534" font-size="10">It does NOT track who read what.</text>
  <text x="462" y="338" fill="#166534" font-size="10">Consumer: owns its offset, asks "from X onward".</text>
  <path d="M596,352 L740,352" stroke="#16a34a" stroke-width="2" marker-end="url(#a2)"/>
  <text x="668" y="346" text-anchor="middle" fill="#15803d" font-size="9">fetch(offset=X)</text>
  <text x="462" y="378" fill="#166534" font-size="10">&#8594; 10 readers cost the broker almost nothing</text>
  <text x="462" y="398" fill="#166534" font-size="10">&#8594; replay = fetch from an older offset</text>
  <text x="462" y="424" fill="#15803d" font-size="10" font-weight="bold">work per message &#8776; constant &#8594; huge throughput</text>
</svg>
```

## 4. Architecture & Workflow

### The cluster and the controller

A Kafka cluster is a set of brokers plus a **controller** function. The controller is a broker (or, in KRaft, a member of a dedicated controller quorum) that owns cluster-management decisions: which broker is the leader of each partition, which brokers are alive, and what to do when one dies. It does *not* sit in the data path — producers and consumers never talk to the controller for individual records; they talk to the leader broker of the relevant partition. The controller's job is metadata: keeping the authoritative map of partition → leader → replicas, and updating it when the cluster changes.

Historically this metadata lived in **ZooKeeper**, an external coordination service. Since KIP-500, Kafka runs in **KRaft** mode, where a quorum of controller brokers stores the metadata in an internal Kafka log (`__cluster_metadata`) replicated by Raft, eliminating the ZooKeeper dependency; ZooKeeper support was removed entirely in Kafka 4.0. For an application developer the change is mostly invisible — you still create topics and produce records the same way — but operationally it means one fewer distributed system to run.

### How a write flows

1. **Metadata discovery.** A producer connects to any broker (a bootstrap server) and asks for cluster metadata: the partitions of the topic and, for each, which broker is the current leader. It caches this.
2. **Partition selection.** For each record, the producer decides a partition. If the record has a key, the partition is `hash(key) % numPartitions` (Kafka uses murmur2 on the key bytes). If the key is null, the producer spreads records across partitions (the sticky partitioner batches to one partition then rotates — chapter 15).
3. **Write to the leader.** The producer sends the record to the broker that leads that partition. Only the leader accepts writes. The leader appends the record to the partition's active segment, assigning it the next offset.
4. **Replication.** Follower replicas on other brokers fetch the new records from the leader and append them to their own copies. When enough replicas have the record (per `acks` and `min.insync.replicas`, chapter 17), the write is considered committed and acknowledged to the producer.
5. **Read.** A consumer fetches from the leader (or a follower, with rack-aware fetching) starting at its current offset, receives a batch of records, processes them, and advances its offset.

The crucial architectural fact is step 3: **all writes for a partition go to one broker, its leader.** That serialises writes per partition (which is what makes per-partition ordering possible) and means a single partition's write throughput is bounded by one broker. Scale comes from having many partitions on many brokers, not from a partition being faster.

### Key-to-partition mapping and choosing the count

A record's partition is a deterministic function of its key: same key → same partition, always (as long as the partition count does not change). This is the mechanism behind per-key ordering — all of account 42's events, keyed by `acct-42`, land in one partition and are therefore ordered. It is also why **changing the partition count is disruptive**: `hash(key) % N` gives a different partition when N changes, so after adding partitions, `acct-42`'s new events may go to a different partition than its old ones, breaking the ordering guarantee for keys that straddle the change. That is the deepest reason to size partitions carefully up front.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Choosing a partition count: the trade the number encodes</text>

  <rect x="24" y="40" width="410" height="170" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="229" y="60" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">More partitions &#8594; more parallelism</text>
  <text x="40" y="84" fill="#166534" font-size="10">&#8226; consumer parallelism ceiling = partition count</text>
  <text x="40" y="104" fill="#166534" font-size="10">&#8226; more brokers can share the topic's throughput</text>
  <text x="40" y="124" fill="#166534" font-size="10">&#8226; rough sizing: target-throughput / per-partition</text>
  <text x="40" y="140" fill="#166534" font-size="10">&#160;&#160;throughput, then round up with headroom</text>
  <text x="40" y="164" fill="#15803d" font-size="10" font-weight="bold">rule of thumb: max(peak-in/prod-rate,</text>
  <text x="40" y="182" fill="#15803d" font-size="10" font-weight="bold">peak-out/cons-rate), plus 2-3x growth room</text>

  <rect x="446" y="40" width="410" height="170" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="651" y="60" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">More partitions &#8594; real costs</text>
  <text x="462" y="84" fill="#991b1b" font-size="10">&#8226; more open files, more memory on brokers</text>
  <text x="462" y="104" fill="#991b1b" font-size="10">&#8226; longer leader-election / recovery times</text>
  <text x="462" y="124" fill="#991b1b" font-size="10">&#8226; more end-to-end latency (more to replicate)</text>
  <text x="462" y="144" fill="#991b1b" font-size="10">&#8226; a key's records are spread thinner</text>
  <text x="462" y="168" fill="#b91c1c" font-size="10" font-weight="bold">and: raising the count later re-maps keys</text>
  <text x="462" y="186" fill="#b91c1c" font-size="10" font-weight="bold">&#8594; breaks per-key ordering across the change</text>

  <rect x="24" y="226" width="832" height="188" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="246" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Key &#8594; partition is deterministic: hash(key) %% N</text>
  <g font-size="9">
    <rect x="48" y="262" width="110" height="26" rx="4" fill="#fff" stroke="#2563eb"/><text x="103" y="279" text-anchor="middle" fill="#1e40af">key "acct-42"</text>
    <rect x="48" y="294" width="110" height="26" rx="4" fill="#fff" stroke="#2563eb"/><text x="103" y="311" text-anchor="middle" fill="#1e40af">key "acct-42"</text>
    <rect x="48" y="326" width="110" height="26" rx="4" fill="#fff" stroke="#2563eb"/><text x="103" y="343" text-anchor="middle" fill="#1e40af">key "acct-99"</text>
    <rect x="48" y="358" width="110" height="26" rx="4" fill="#fff" stroke="#94a3b8"/><text x="103" y="375" text-anchor="middle" fill="#475569">key null</text>
  </g>
  <text x="180" y="300" fill="#1e40af" font-size="10">murmur2(key) %% 3</text>
  <path d="M160,275 L300,290" stroke="#2563eb" stroke-width="1.5"/>
  <path d="M160,307 L300,300" stroke="#2563eb" stroke-width="1.5"/>
  <path d="M160,339 L300,330" stroke="#2563eb" stroke-width="1.5"/>
  <rect x="304" y="278" width="130" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="369" y="295" text-anchor="middle" fill="#1e40af" font-size="9">Partition 0 (ordered)</text>
  <rect x="304" y="318" width="130" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="369" y="335" text-anchor="middle" fill="#1e40af" font-size="9">Partition 2 (ordered)</text>
  <text x="470" y="284" fill="#166534" font-size="10" font-weight="bold">same key &#8594; same partition &#8594; the two acct-42</text>
  <text x="470" y="300" fill="#166534" font-size="10">records are ORDERED relative to each other</text>
  <text x="470" y="326" fill="#b91c1c" font-size="10" font-weight="bold">null key &#8594; sticky / round-robin across all</text>
  <text x="470" y="342" fill="#991b1b" font-size="10">partitions &#8594; NO ordering guarantee</text>
  <text x="470" y="372" fill="#475569" font-size="10">acct-42 vs acct-99 in different partitions &#8594;</text>
  <text x="470" y="388" fill="#475569" font-size="10">no cross-partition order is promised</text>
</svg>
```

## 5. Implementation

The CLI first, because you will live in it. `kafka-topics.sh` manages topics; `kafka-console-producer.sh`/`kafka-console-consumer.sh` are your smoke test.

```bash
# --- Cluster & topic administration with kafka-topics.sh ---

# Create a topic "orders" with 12 partitions and replication factor 3.
# Partitions = your consumer-parallelism ceiling; pick with headroom (see below).
# RF=3 means every partition has 3 copies on 3 different brokers.
kafka-topics.sh --bootstrap-server broker1:9092 \
  --create --topic orders \
  --partitions 12 \
  --replication-factor 3 \
  --config min.insync.replicas=2   # durability contract with acks=all (ch.17)

# Describe: shows each partition, its Leader broker, the Replicas, and the Isr
# (in-sync replicas). This is your first debugging tool when a partition misbehaves.
kafka-topics.sh --bootstrap-server broker1:9092 --describe --topic orders
# Topic: orders  Partition: 0  Leader: 1  Replicas: 1,2,3  Isr: 1,2,3
# Topic: orders  Partition: 1  Leader: 2  Replicas: 2,3,1  Isr: 2,3,1
# ... a healthy topic has Isr == Replicas for every partition.

# You can INCREASE partitions but never decrease them. Increasing re-maps
# hash(key) % N for future records, so it breaks per-key ordering across the change.
kafka-topics.sh --bootstrap-server broker1:9092 --alter --topic orders --partitions 24

# Quick end-to-end smoke test with the console tools:
kafka-console-producer.sh --bootstrap-server broker1:9092 --topic orders \
  --property parse.key=true --property key.separator=:
# type:  acct-42:{"amount":100}   then  acct-42:{"amount":250}

kafka-console-consumer.sh --bootstrap-server broker1:9092 --topic orders \
  --from-beginning --property print.key=true --property print.partition=true
```

Now a real producer and consumer in Go with `segmentio/kafka-go`. Note how the producer chooses a partition from the key, and how the consumer reads from a group.

```go
package main

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/segmentio/kafka-go"
)

// produce writes keyed records. The Balancer decides the partition from the key.
// kafka.Hash mimics the classic hash(key) % numPartitions behaviour, so records
// with the same key land in the same partition and are therefore ordered.
func produce(ctx context.Context) {
	w := &kafka.Writer{
		Addr:  kafka.TCP("broker1:9092", "broker2:9092", "broker3:9092"),
		Topic: "orders",
		// Hash balancer: same key -> same partition -> per-key ordering. Use
		// kafka.RoundRobin only when you have NO ordering requirement at all.
		Balancer: &kafka.Hash{},
		// RequireAll == acks=all: the leader waits for the in-sync replicas
		// before acknowledging. This is the durable setting (chapter 17).
		RequiredAcks: kafka.RequireAll,
		// Batching for throughput: flush when the batch fills or the timeout hits.
		BatchTimeout: 10 * time.Millisecond,
	}
	defer w.Close()

	// Two records for the SAME account -> same key -> same partition -> ordered.
	err := w.WriteMessages(ctx,
		kafka.Message{Key: []byte("acct-42"), Value: []byte(`{"op":"debit","amt":100}`)},
		kafka.Message{Key: []byte("acct-42"), Value: []byte(`{"op":"credit","amt":30}`)},
		// A different key MAY go to a different partition; no cross-partition order.
		kafka.Message{Key: []byte("acct-99"), Value: []byte(`{"op":"debit","amt":10}`)},
	)
	if err != nil {
		log.Fatalf("write: %v", err)
	}
}

// consume joins a consumer group. The group is how partitions are distributed
// across consumers: with 12 partitions you can run up to 12 of these before the
// 13th sits idle (chapter 16). The broker does NOT track our position for us —
// kafka-go commits offsets to __consumer_offsets on our behalf.
func consume(ctx context.Context) {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers: []string{"broker1:9092", "broker2:9092", "broker3:9092"},
		GroupID: "fulfilment",           // the consumer group id
		Topic:   "orders",
		MaxWait: 500 * time.Millisecond, // how long a fetch waits to fill a batch
	})
	defer r.Close()

	for {
		// ReadMessage fetches the next record from one of the partitions this
		// consumer owns, then commits the offset (auto-commit). The Partition and
		// Offset fields expose exactly where in the log this record lived.
		m, err := r.ReadMessage(ctx)
		if err != nil {
			log.Printf("read: %v", err)
			return
		}
		fmt.Printf("partition=%d offset=%d key=%s value=%s\n",
			m.Partition, m.Offset, string(m.Key), string(m.Value))
	}
}

func main() {
	ctx := context.Background()
	produce(ctx)
	consume(ctx)
}
```

The two things to internalise from the code: the producer's `Balancer` is where the key-to-partition decision is made (and thus where ordering is won or lost), and the consumer's `GroupID` is what places it in a group whose parallelism is capped by the partition count. Neither the producer nor the consumer ever talks to a controller for data — they talk directly to partition leaders, discovered from bootstrap metadata.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Linear horizontal scale.** Add partitions and brokers to raise a topic's throughput; the partition is a natural sharding unit.
- **High throughput per broker.** The dumb-broker design (append-only, sequential I/O, page cache, zero-copy) makes per-message work nearly constant.
- **Durable and replicated.** Every partition has RF copies on different brokers; a broker failure loses no committed data (chapter 17).
- **Cheap fan-out and replay.** Because the consumer owns its offset, many independent readers and full replays cost the broker almost nothing.
- **Per-key ordering for free.** Keying records gives you a strong, useful ordering guarantee without global coordination.

**Disadvantages**
- **No global ordering.** Order holds only within a partition; a topic-wide order does not exist.
- **Partition count is a one-way, load-bearing decision.** You can raise it but not lower it, and raising it re-maps keys and breaks ordering across the change.
- **Client complexity.** The smart consumer must manage offsets, rebalances and idempotency — real work pushed onto you.
- **Operational weight.** A replicated, stateful cluster with a controller quorum is heavier to run than a single-node queue.

**Trade-offs**
- *Parallelism vs ordering:* more partitions buys more concurrent consumers but spreads records across more independent order-lines; the key is how you reconcile the two.
- *Throughput vs latency:* batching and replication raise throughput but add latency; `acks=all` is safer but slower than `acks=1` (chapters 15, 17).
- *Broker simplicity vs client complexity:* Kafka moves work from the broker to the client, which is what makes the broker fast and the client fiddly.
- *Fixed partitions vs elasticity:* the partition count both enables and caps scaling, so it must be sized for future load, not just today's.

## 7. Common Mistakes & Best Practices

- **Under-partitioning a topic.** Creating a topic with 1–3 partitions "to start" and discovering you cannot add consumers when load grows. Size partitions for peak plus growth on day one.
- **Over-partitioning everything.** Thousands of partitions per broker inflate memory, open files and recovery time, and lengthen leader elections. More is not free.
- **Expecting global ordering.** Assuming records come out in the order produced across the whole topic. Order is per-partition only; use a key to co-locate records that must be ordered.
- **Using a null key when you needed order.** Null-key records are spread across partitions, so two related events may be processed out of order. Key them.
- **A skewed key.** Keying by something low-cardinality (e.g. country) sends most traffic to one partition, creating a hot partition that bottlenecks the whole topic. Choose a high-cardinality, evenly-distributed key.
- **Raising the partition count on a keyed topic casually.** It re-maps `hash(key) % N` and breaks per-key ordering for keys that straddle the change; treat it as a data-model event, not a tuning knob.
- **Best practice: decide partition count from throughput and parallelism, key from ordering, and treat both as design-time commitments.** Estimate peak produce and consume rates, divide by per-partition throughput, add headroom, and pick a key that is both high-cardinality and the natural ordering unit.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Start with `kafka-topics.sh --describe`: for every partition check that `Isr` equals `Replicas` (a shrunken ISR means a replica is lagging or a broker is unhealthy) and note which broker is `Leader` (leadership skew — many leaders on one broker — makes that broker a hotspot). `UnderReplicatedPartitions > 0` is the canonical "something is wrong" signal. For a stuck consumer, `kafka-consumer-groups.sh --describe` shows per-partition lag.
- **Monitoring.** Watch `UnderReplicatedPartitions`, `OfflinePartitionsCount` (should be 0 — a partition with no leader is unavailable), `ActiveControllerCount` (exactly 1 across the cluster), per-broker request rates and disk usage, and consumer lag per group (chapter 27). Leadership balance across brokers matters for even load.
- **Security.** Kafka supports TLS for encryption in transit, SASL (PLAIN, SCRAM, GSSAPI/Kerberos, OAUTHBEARER) for authentication, and ACLs for authorization at the topic/consumer-group level. A production cluster should authenticate every client and restrict who may produce to or consume from each topic; an open broker on the network is a data breach (chapter 29).
- **Scaling.** Scale a topic's throughput by adding partitions (up front) and brokers; scale a consumer group by adding consumers up to the partition count. Rebalance partition leadership across brokers with the reassignment tool after adding brokers, so new capacity actually carries load. Remember the ceiling: consumer parallelism per group can never exceed the partition count, so scaling consumers past that requires more partitions — a decision to make early.

## 9. Interview Questions

**Q: What is a partition and why is it the central concept in Kafka?**
A: A partition is one ordered, immutable, append-only log that is a slice of a topic; a topic with N partitions is really N independent logs, possibly spread across brokers. It is central because it is simultaneously the unit of parallelism and the unit of ordering. Parallelism: within a consumer group each partition is read by at most one consumer, so the partition count is the ceiling on how many consumers can process the topic concurrently. Ordering: records are ordered only within a partition, never across the topic. Almost every Kafka design decision — how fast you can consume, whether two events stay in order, how you shard load — is really a decision about partitions.

**Q: Why is there no global ordering across a topic?**
A: Because a topic is split into independent partition-logs, each on possibly a different broker, and a single total order across them would require coordination on every write — exactly the bottleneck Kafka avoids to achieve its throughput. Within a partition, writes go to one leader and are appended in sequence, so offsets give a definitive order. Across partitions there is no shared clock or sequence, so Kafka promises nothing about the relative order of a record in partition 3 versus one in partition 7. You get ordering where you need it by giving related records the same key, which routes them to the same partition.

**Q: What does "dumb broker, smart consumer" mean?**
A: It means Kafka pushes intelligence out of the broker and into the client. The broker's job is minimal: append produced records to a partition's log file and serve ranges of that log to fetch requests, often via zero-copy sendfile. It does not track which consumer has read which record, does not route per message, and keeps no per-consumer delivery state. The consumer is the smart party: it tracks its own position (offset), asks for records from that offset onward, and handles rebalancing and deduplication. This asymmetry is what makes the broker's per-message work nearly constant and lets a cluster sustain very high throughput, at the cost of more complex clients.

**Q: How does a producer decide which partition a record goes to?**
A: If the record has a key, the partition is a deterministic hash of the key modulo the partition count — Kafka uses murmur2 on the key bytes — so the same key always maps to the same partition (as long as the count is unchanged), which gives per-key ordering. If the key is null, the producer distributes records across partitions; modern clients use a sticky partitioner that fills a batch destined for one partition and then rotates, which improves batching over pure round-robin. You can also supply a custom partitioner. The key choice is therefore where per-key ordering is won or lost.

**Q: What is the role of the controller?**
A: The controller is the cluster-management brain. It tracks which brokers are alive, decides which replica leads each partition, elects a new leader when a leader's broker fails, and propagates the resulting metadata to the other brokers. It is not in the data path — producers and consumers talk directly to partition leaders, not the controller. In modern Kafka (KRaft) the controllers form a Raft quorum that stores metadata in an internal log, replacing the older ZooKeeper-based design.

**Q: What is the relationship between leaders, followers and replicas?**
A: Each partition has a set of replicas equal to its replication factor, living on different brokers. Exactly one replica is the leader; the rest are followers. All produces (and normally all fetches) for the partition go to the leader; followers replicate by fetching new records from the leader and appending them to their own copies. The subset of replicas currently caught up to the leader is the in-sync replica set (ISR). If the leader's broker fails, the controller promotes an in-sync follower to leader, so committed data is not lost — provided the durability settings required enough replicas to have the data (chapter 17).

**Q: Why can't you have more active consumers in a group than partitions?**
A: Because within a consumer group each partition is assigned to at most one consumer, so a partition is the smallest unit of work a consumer can own. If a topic has 12 partitions and a group has 15 consumers, only 12 do work and the other 3 sit idle with nothing assigned. That is why partition count is the hard ceiling on consumer parallelism, and why you must size partitions for your peak required consumer concurrency up front — you cannot exceed it just by adding consumers.

**Q: (Senior) How do you choose the partition count for a new topic, and why is it hard to change later?**
A: I size it from two ceilings and then add headroom. The first ceiling is throughput: estimate peak produce rate and divide by the per-partition write throughput the cluster sustains; estimate peak consume rate and divide by what one consumer instance can process. The partition count must be at least the larger of those, so that both producing and consuming can keep up. The second ceiling is parallelism: the count caps how many consumers a group can run concurrently, so it must cover the most parallel consumer you will ever need. Then I add growth headroom, typically two to three times, because raising the count later is genuinely disruptive: partition assignment is `hash(key) % N`, so increasing N re-maps future records for existing keys to different partitions, which breaks per-key ordering across the change and scrambles any consumer that assumed a key stayed put. You also cannot decrease the count at all. Against that, I temper the number because over-partitioning costs broker memory, open file handles, longer leader elections and higher end-to-end latency. So the count is a design-time commitment balancing future parallelism and throughput against per-partition overhead, not a runtime tuning knob.

**Q: (Senior) A topic has a hot partition carrying most of the traffic while others are nearly idle. What is happening and how do you fix it?**
A: This is key skew: the partitioning key has low effective cardinality or a badly skewed distribution, so `hash(key) % N` concentrates most records into one or a few partitions. A classic example is keying by a field like country or tenant where one value dominates — all of that value's records pile into a single partition, which then bottlenecks the whole topic because that partition's leader is doing most of the write and read work and one consumer must handle all of it, capping throughput regardless of how many partitions or consumers exist. The fix depends on whether the ordering the key provides is actually needed. If per-key order matters, I look for a finer-grained key that still preserves the ordering unit the domain requires — for instance keying by a specific entity id rather than a coarse category — so the hot value is split into many keys. If strict per-key order is not required for the hot value, I can add a salt or composite key (e.g. entity id plus a bucket suffix) to spread it across partitions, accepting that records for that logical key are now only partially ordered. I would also confirm the partition count itself is not the constraint and check leadership balance across brokers, because a hot partition can compound with leadership skew to make one broker the bottleneck. The general lesson is that the key must be both high-cardinality and aligned with the ordering requirement; getting one without the other produces exactly this failure.

**Q: (Senior) Why does Kafka achieve such high throughput compared with a traditional broker, in architectural terms?**
A: Several deliberate architectural choices compound. First, the dumb-broker design: the broker's per-message work is essentially "append these bytes to a file" and "copy this byte range to a socket", with no per-consumer state, routing or filtering, so its cost per message is nearly constant and dominated by I/O rather than logic. Second, sequential disk I/O: a partition is an append-only log, so writes are sequential, which is dramatically faster than random I/O and plays well with modern disks and the OS page cache — recently written data is served from cache without touching the disk. Third, zero-copy reads: serving a fetch uses the sendfile system call to move data from the page cache straight to the network socket, bypassing user space entirely, so the broker does not pay to copy data into and out of application memory. Fourth, batching and compression: producers batch many records and compress the batch, so the broker stores and transmits fewer, larger units, amortising per-request overhead. Fifth, horizontal partitioning: throughput is not bounded by one machine because a topic's partitions spread across many brokers, each doing sequential I/O independently. The consumer-owns-its-offset model then makes additional readers and replays cheap, because they are just more fetches at different offsets rather than new state the broker must maintain. Together these mean Kafka scales throughput with hardware almost linearly, which is exactly what it was designed for.

## 10. Quick Revision & Cheat Sheet

| Concept | One-liner |
|---|---|
| Broker | One Kafka server; hosts partitions on local disk |
| Cluster | A set of brokers; metadata coordinated by the controller |
| Controller | Elects leaders, tracks liveness; KRaft quorum (was ZooKeeper) |
| Topic | Named stream; logical only |
| Partition | Ordered append-only log; unit of parallelism AND ordering |
| Leader / Follower | Leader takes writes; followers replicate |
| ISR | Replicas currently caught up to the leader |
| Key → partition | `murmur2(key) % N`; same key → same partition → ordered |

| Question | Answer |
|---|---|
| Global ordering? | No — per-partition only |
| Consumer parallelism ceiling? | Partition count |
| Who tracks the read position? | The consumer (its offset) |
| Can you lower partition count? | No; raising it re-maps keys |

**Flash cards**
- **Unit of parallelism AND ordering?** → The partition.
- **Where do producers write?** → To the partition's leader only.
- **Null key vs a real key?** → Spread (no order) vs same-partition (ordered).
- **What makes the broker fast?** → Append-only + page cache + zero-copy + dumb broker.
- **Partition count ceiling?** → Max concurrent consumers in a group.
- **Why is raising partitions disruptive?** → `hash(key) % N` re-maps keys, breaking per-key order.

## 11. Hands-On Exercises & Mini Project

- [ ] Create a topic with 6 partitions and RF 3, then `--describe` it and confirm `Isr == Replicas` on every partition.
- [ ] Produce ten records with two distinct keys and, with a partition-printing consumer, confirm each key always lands in the same partition.
- [ ] Produce ten null-key records and observe them spread across partitions with no ordering.
- [ ] Run one consumer, then a second in the same group, and watch partitions redistribute; add consumers past the partition count and confirm the extras sit idle.
- [ ] Kill the broker that leads a partition and watch the controller promote a follower; confirm no committed data is lost.
- [ ] Increase a keyed topic's partition count and demonstrate that some keys now map to a different partition than before.

### Mini Project — "Partition-Aware Order Service"

**Goal.** Build a small order-processing pipeline that makes the partition's dual role — parallelism and ordering — visible and testable.

**Requirements.**
1. Create an `orders` topic sized from an explicit throughput and parallelism estimate you write down and justify.
2. Produce order events keyed by account id, so all events for one account share a partition; log the partition each record lands on.
3. Run a consumer group and scale it from 1 to `partitions` consumers, measuring throughput at each step to show the parallelism ceiling.
4. Add one consumer beyond the partition count and demonstrate it is idle.
5. Write an assertion that, for any account, its events are consumed in produce order, and show it holds within a partition and would fail if you keyed by something coarse and skewed.

**Extensions.**
- Deliberately introduce a hot partition with a skewed key, observe the imbalance in per-partition lag, then fix it with a better key and compare.
- Add a second consumer group and show it reads the whole topic independently (pub/sub across groups) while the first still shares the load (queue within a group).

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Messaging Models: Queues vs Pub/Sub vs the Log* (why the partitioned log subsumes both), *The Log: Offsets, Segments & Retention* (the partition's internal storage), *Producers: Partitioning, Batching & acks* (how records reach a partition), *Design: Consumers, Groups, Offsets & Rebalancing* (how partitions are shared), *Replication, ISR & Durability* (leaders, followers and the durability contract).

- **Apache Kafka — Design** — Apache · *Intermediate* · the authoritative description of the log, partitions, replication and the broker's I/O model, from the source. <https://kafka.apache.org/documentation/#design>
- **Apache Kafka — Introduction** — Apache · *Beginner* · topics, partitions, brokers and producers/consumers in one page; the natural first read. <https://kafka.apache.org/documentation/#introduction>
- **KIP-500: Replace ZooKeeper with a self-managed metadata quorum** — Apache · *Advanced* · the KRaft design that moved cluster metadata into a Kafka log and removed ZooKeeper. <https://cwiki.apache.org/confluence/display/KAFKA/KIP-500%3A+Replace+ZooKeeper+with+a+Self-Managed+Metadata+Quorum>
- **The Log: What every software engineer should know** — Jay Kreps · *Advanced* · the essay behind Kafka's partitioned-log architecture and why it scales. <https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying>
- **Kafka: The Definitive Guide (2nd ed.), ch. "Kafka Internals"** — Narkhede, Shapira, Palino · *Intermediate* · brokers, the controller, replication and partition placement explained in depth. <https://www.confluent.io/resources/kafka-the-definitive-guide/>
- **Confluent — How to choose the number of topics/partitions** — Confluent · *Intermediate* · the practical throughput-and-overhead reasoning behind sizing partitions. <https://www.confluent.io/blog/how-choose-number-topics-partitions-kafka-cluster/>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · partitioned logs and their ordering and scaling properties in a systems context. <https://dataintensive.net/>
- **kafka-go — segmentio** — Segment · *Intermediate* · the Go client used in this chapter, with producer balancers and group readers. <https://github.com/segmentio/kafka-go>

---

*Kafka & RabbitMQ Handbook — chapter 13.*
