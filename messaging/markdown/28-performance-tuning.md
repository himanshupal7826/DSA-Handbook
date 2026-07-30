# 28 · Performance Tuning & Capacity Planning

> **In one line:** Messaging throughput comes almost entirely from *amortisation* — batching many small messages into few large I/Os and compressing them — which is why every throughput lever (batch size, linger, compression, prefetch) also adds latency, and why capacity planning is arithmetic: target throughput times retention times replication equals the storage, network and partitions you must buy.

---

## 1. Overview

Message brokers are, at their fastest, engines for turning many small operations into few big ones. A single message is tiny and a per-message round trip is dominated by fixed costs — a network packet, a system call, a disk seek, a replication acknowledgement. The entire art of making a broker fast is *amortising* those fixed costs across many messages: batch a thousand messages into one produce request, one compression pass, one sequential disk write, one replication round trip, and the per-message cost collapses. This is why Kafka can push millions of messages per second on modest hardware — not because any single message is handled quickly, but because almost nothing is handled per-message.

The consequence, and the theme of this chapter, is that **every throughput lever is a latency cost**. Batching means a message waits for its batch-mates. `linger.ms` means the producer deliberately pauses to accumulate more. Compression trades CPU and a little latency for far less network and disk. `acks=all` trades latency for durability. Larger prefetch on RabbitMQ trades fairness and memory for consumer throughput. There is no free throughput; there is only throughput bought with latency, memory, CPU, or durability, and tuning is choosing *which* to spend for your workload.

The second half of the chapter is **capacity planning**, which is refreshingly concrete: it is arithmetic. If you know your target throughput in MB/s and messages/s, your retention window, and your replication factor, you can compute the storage you need (throughput × retention × replication), the network you need (replication multiplies write bandwidth), and the partition count you need (target throughput ÷ per-partition throughput), all with headroom for spikes and failures. Getting this arithmetic right *before* you deploy is what separates a cluster that absorbs Black Friday from one that falls over at the first unexpected load, because — as the chapter will stress — some of these decisions, partition count chief among them, are painful or impossible to change later.

We cover the throughput levers for both systems, the latency-versus-throughput trade in detail, partition-count sizing (the decision you must get roughly right early), the capacity arithmetic worked through, the hardware profile a broker actually wants, and how to benchmark honestly with the tools that ship in the box.

## 2. Core Concepts

- **Batching** — accumulating multiple messages into one produce request / write / compression unit to amortise fixed per-request cost. The single biggest throughput lever.
- **`batch.size` (Kafka producer)** — the maximum bytes per partition batch; the producer fills a batch up to this size before sending.
- **`linger.ms` (Kafka producer)** — how long the producer waits for more messages before sending a partially-full batch; the deliberate latency you pay to batch better.
- **Compression** — encoding the batch to fewer bytes (lz4, zstd, snappy, gzip); trades CPU for reduced network and disk. Applied per-batch, so batching and compression compound.
- **`acks` (Kafka)** — durability level of a produce: 0 (fire-and-forget), 1 (leader only), all/-1 (all in-sync replicas). Higher acks = more latency, more durability.
- **Partition count** — Kafka's unit of parallelism; caps consumer parallelism per group and producer/broker throughput. Easy to add, hard to remove.
- **Prefetch / `basic.qos` (RabbitMQ)** — the number of unacknowledged messages the broker will push to a consumer at once; the main consumer-side throughput/fairness lever.
- **Persistence vs transient (RabbitMQ)** — whether messages are written to disk (`delivery_mode=2`) or held in memory; durability versus speed.
- **Lazy queue (RabbitMQ)** — a queue that keeps messages on disk rather than RAM, trading per-message latency for the ability to hold huge backlogs without memory pressure.
- **Publisher confirms (RabbitMQ)** — the broker acknowledging a publish; batching confirms (waiting for many at once) is the RabbitMQ analogue of Kafka's async batching.
- **Replication factor (RF)** — copies of each partition/queue; multiplies storage and inter-broker network.
- **Capacity planning** — computing storage, network, and partition/broker counts from target throughput, retention, and RF, with headroom.
- **Zero-copy (`sendfile`)** — Kafka reading log data from page cache straight to the socket without copying into user space; a major throughput source (and one TLS defeats — chapter 29).

## 3. Theory & Principles

### The amortisation identity

Think of the cost to move one message as `fixed_overhead / batch_size + per_byte_cost × message_size`. The `fixed_overhead` is everything that happens once per request regardless of how many messages it carries: the network round trip, the syscall, the disk seek to the tail of the log, the replication handshake. When `batch_size` is 1, you pay the full fixed overhead per message and throughput is terrible. As `batch_size` grows, the fixed overhead is divided across more messages and the per-message cost asymptotes to `per_byte_cost × message_size` — the irreducible floor. This single identity explains almost every tuning knob: `batch.size` and `linger.ms` grow the batch; compression shrinks `message_size` on the wire; sequential writes and zero-copy minimise `per_byte_cost`; more partitions add parallel pipelines each running this identity independently.

The corollary is the latency-throughput trade. Growing the batch means the *first* message in a batch waits for the batch to fill (or for `linger.ms` to elapse). So batching lowers per-message *cost* while raising per-message *latency*. For a firehose (analytics, logs) you want big batches and high linger — you do not care that a message waits 50ms if you move ten million per second. For a low-latency path (a trade, a user-facing notification) you want tiny batches and zero linger — you accept lower throughput to shave milliseconds. There is no universal setting; there is only the setting for *this* workload's position on the latency-throughput curve.

### Kafka's throughput comes from the OS, not the JVM

Kafka is unusually fast because it delegates the hard parts to the operating system. It writes to the log with **sequential appends**, which even spinning disks handle at hundreds of MB/s, and it reads with **`sendfile` zero-copy**, sending bytes straight from the OS **page cache** to the network socket without copying them into the JVM heap. This is why the counter-intuitive hardware advice holds: Kafka wants *lots of RAM for page cache* and *fast disks and network*, but a *modest JVM heap* (typically 6-8GB) — because the data lives in page cache, not the heap, and a big heap just means long GC pauses. A team that sizes a Kafka broker like a database (huge heap) gets worse performance than one that leaves most of the RAM to the OS.

### RabbitMQ's throughput comes from staying in memory and acking in bulk

RabbitMQ's fast path is the opposite philosophy: keep the working set in memory and route in-process. Its throughput levers are therefore about *not* forcing synchronous disk work per message (persistent messages with publisher confirms are much slower than transient) and *not* round-tripping per message on either side — prefetch lets the broker push a batch of messages to a consumer without waiting for each ack, and batched publisher confirms let a producer fire many publishes and wait for the confirms together. Quorum queues (Raft) add replication cost for durability, and lazy queues deliberately move messages to disk to trade latency for the ability to hold enormous backlogs without exhausting memory — the RabbitMQ answer to the failure mode where a stuck consumer lets a queue grow until the memory alarm blocks all publishers.

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The latency&#8211;throughput curve: every throughput lever costs latency</text>

  <rect x="40" y="44" width="480" height="250" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <line x1="90" y1="270" x2="490" y2="270" stroke="#334155" stroke-width="1.5"/>
  <line x1="90" y1="70" x2="90" y2="270" stroke="#334155" stroke-width="1.5"/>
  <text x="290" y="290" text-anchor="middle" fill="#475569" font-size="10">per-message latency &#8594;</text>
  <text x="70" y="170" text-anchor="middle" fill="#475569" font-size="10" transform="rotate(-90 70 170)">throughput &#8594;</text>
  <path d="M100,255 C160,255 200,140 300,110 C380,88 440,82 480,80" fill="none" stroke="#2563eb" stroke-width="3"/>
  <circle cx="120" cy="245" r="5" fill="#16a34a"/><text x="128" y="242" fill="#15803d" font-size="9">linger=0, batch=1: low latency, low throughput</text>
  <circle cx="300" cy="110" r="5" fill="#d97706"/><text x="200" y="128" fill="#b45309" font-size="9">linger=10ms, batch=64KB: balanced</text>
  <circle cx="450" cy="81" r="5" fill="#dc2626"/><text x="300" y="70" fill="#b91c1c" font-size="9">linger=100ms, batch=1MB, zstd: firehose</text>

  <rect x="540" y="44" width="300" height="250" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="690" y="66" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Amortisation identity</text>
  <text x="560" y="94" fill="#1d4ed8" font-size="11" font-weight="bold">cost/msg = fixed/batch + per_byte&#215;size</text>
  <text x="560" y="120" fill="#475569" font-size="9">fixed = round trip + syscall + seek +</text>
  <text x="560" y="134" fill="#475569" font-size="9">replication handshake (paid ONCE per batch)</text>
  <text x="560" y="158" fill="#166534" font-size="9">batch &#8593; &#8594; fixed cost divided across more msgs</text>
  <text x="560" y="176" fill="#166534" font-size="9">compression &#8593; &#8594; shrinks per_byte&#215;size on the wire</text>
  <text x="560" y="194" fill="#166534" font-size="9">sequential write + zero-copy &#8594; tiny per_byte</text>
  <text x="560" y="218" fill="#b91c1c" font-size="9" font-weight="bold">but batch &#8593; &#8594; first msg WAITS for batch to fill</text>
  <text x="560" y="236" fill="#b91c1c" font-size="9">&#8594; throughput bought with latency, always</text>
  <text x="560" y="262" fill="#5b21b6" font-size="9">firehose: big batch, high linger, zstd</text>
  <text x="560" y="278" fill="#5b21b6" font-size="9">low-latency: batch=1, linger=0, acks=1</text>

  <rect x="40" y="306" width="800" height="140" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="328" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Where each broker's speed comes from</text>
  <rect x="60" y="342" width="370" height="92" rx="8" fill="#fff" stroke="#86efac"/>
  <text x="245" y="362" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">Kafka: delegate to the OS</text>
  <text x="76" y="384" fill="#166534" font-size="9">sequential appends &#8594; disk at 100s of MB/s</text>
  <text x="76" y="400" fill="#166534" font-size="9">sendfile zero-copy from PAGE CACHE to socket</text>
  <text x="76" y="416" fill="#166534" font-size="9">wants: RAM for cache, fast disk+net, SMALL heap</text>
  <rect x="450" y="342" width="370" height="92" rx="8" fill="#fff" stroke="#fca5a5"/>
  <text x="635" y="362" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">RabbitMQ: stay in memory, ack in bulk</text>
  <text x="466" y="384" fill="#991b1b" font-size="9">transient &gt; persistent; prefetch batches delivery</text>
  <text x="466" y="400" fill="#991b1b" font-size="9">batched publisher confirms amortise the round trip</text>
  <text x="466" y="416" fill="#991b1b" font-size="9">lazy queues &#8594; disk-backed, huge backlogs, more latency</text>
</svg>
```

## 4. Architecture & Workflow

The tuning workflow is the same regardless of broker: establish the workload's position on the latency-throughput curve, then turn the levers in the right direction, then verify with a benchmark under realistic conditions. What differs is which levers exist.

**Kafka producer path.** A message is serialised, assigned a partition (by key hash or round-robin), and appended to an in-memory batch for that partition. The batch is sent when it reaches `batch.size` *or* `linger.ms` elapses, whichever first. Compression is applied to the whole batch. The broker receives the batch, appends it to the partition's active segment (sequential write), and — if `acks=all` — waits for the in-sync followers to replicate before acknowledging. Every one of those steps is a lever: buffer size (`buffer.memory`), batch size, linger, compression codec, acks, and on the broker side `num.replica.fetchers` and segment sizes.

**Kafka consumer path.** A consumer fetches batches (`fetch.min.bytes` and `fetch.max.wait.ms` are the *consumer-side* linger — wait for at least this many bytes or this long), decompresses, and processes. `max.poll.records` caps how many are handed to your loop per poll. Reads are served from page cache via zero-copy when the data is recent.

**RabbitMQ path.** A producer publishes to an exchange; the broker routes to queues; each queue pushes up to `prefetch` unacknowledged messages to each consumer. The producer can run in confirm mode and batch its confirm-waits. Persistence (`delivery_mode=2`) forces a disk write; lazy queues force disk residence. The levers are prefetch, persistence, queue type (classic/quorum/stream), lazy-vs-default, and connection/channel reuse (opening a channel per message is a classic throughput killer).

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="p1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Partition-count sizing: the decision to get right early</text>

  <rect x="30" y="46" width="260" height="150" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="160" y="68" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Too FEW partitions</text>
  <text x="46" y="92" fill="#991b1b" font-size="9">&#8226; consumer parallelism capped</text>
  <text x="46" y="110" fill="#991b1b" font-size="9">&#8226; add consumers &#8594; some sit IDLE</text>
  <text x="46" y="128" fill="#991b1b" font-size="9">&#8226; broker throughput ceiling</text>
  <text x="46" y="146" fill="#991b1b" font-size="9">&#8226; a hot key overloads one partition</text>
  <text x="46" y="172" fill="#7f1d1d" font-size="9" font-weight="bold">symptom: lag rises, cannot scale out</text>

  <rect x="310" y="46" width="260" height="150" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="68" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">About RIGHT</text>
  <text x="326" y="92" fill="#166534" font-size="9">partitions = target_tput /</text>
  <text x="326" y="108" fill="#166534" font-size="9">   per_partition_tput  (+ headroom)</text>
  <text x="326" y="130" fill="#166534" font-size="9">&#8226; &#8805; max consumers you will ever run</text>
  <text x="326" y="148" fill="#166534" font-size="9">&#8226; multiple of consumer count is neat</text>
  <text x="326" y="172" fill="#14532d" font-size="9" font-weight="bold">rule of thumb: 2&#8211;4&#215; expected consumers</text>

  <rect x="590" y="46" width="260" height="150" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="720" y="68" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Too MANY partitions</text>
  <text x="606" y="92" fill="#b45309" font-size="9">&#8226; more open files &amp; memory/broker</text>
  <text x="606" y="110" fill="#b45309" font-size="9">&#8226; longer leader election on failure</text>
  <text x="606" y="128" fill="#b45309" font-size="9">&#8226; more end-to-end latency</text>
  <text x="606" y="146" fill="#b45309" font-size="9">&#8226; heavier rebalances</text>
  <text x="606" y="172" fill="#7c2d12" font-size="9" font-weight="bold">symptom: slow failover, churny rebalances</text>

  <rect x="30" y="212" width="820" height="88" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="234" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">The asymmetry that makes this a get-it-right-early decision</text>
  <text x="52" y="258" fill="#6d28d9" font-size="10">You can ADD partitions online &#8212; but doing so CHANGES key&#8594;partition mapping, breaking per-key ordering for existing keys.</text>
  <text x="52" y="278" fill="#6d28d9" font-size="10">You essentially CANNOT reduce partitions without recreating the topic. So size for future load + headroom, but resist over-provisioning.</text>

  <rect x="30" y="316" width="820" height="90" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="338" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Worked capacity math</text>
  <text x="52" y="362" fill="#1d4ed8" font-size="10">target 200 MB/s, retention 72h, RF 3 &#8594; storage = 200 MB/s &#215; 259200 s &#215; 3 = ~155 TB (before compression, plus headroom)</text>
  <text x="52" y="382" fill="#1d4ed8" font-size="10">per-partition ~10 MB/s &#8594; partitions &#8805; 200/10 = 20, round to 30 for headroom &#183; write network &#215;RF for replication traffic</text>
  <text x="52" y="398" fill="#475569" font-size="9">always add headroom (2&#215;) for spikes and for a broker being down and its load redistributing.</text>
</svg>
```

## 5. Implementation

Concrete producer/consumer tuning, RabbitMQ config, and the benchmark commands that ship with Kafka. Comments explain *why* each value, not just what.

### Kafka: a high-throughput producer (Go, segmentio/kafka-go)

```go
package tuning

import (
	"context"
	"time"

	"github.com/segmentio/kafka-go"
)

// HighThroughputWriter is tuned for a firehose: big batches, deliberate linger,
// zstd compression, and acks=all for durability. It trades ~tens of ms of
// per-message latency for a large throughput gain — the right trade for logs,
// analytics, or CDC, and the WRONG trade for a user-facing low-latency path.
func HighThroughputWriter(brokers []string, topic string) *kafka.Writer {
	return &kafka.Writer{
		Addr:  kafka.TCP(brokers...),
		Topic: topic,

		// BATCHING — the master lever. Fill batches up to 1MB before sending.
		BatchBytes: 1 << 20, // 1 MiB per-partition batch
		BatchSize:  10000,   // ...or 10k messages, whichever first

		// LINGER — wait up to 20ms to let a batch fill. This is the latency we
		// deliberately pay to amortise the per-request fixed cost across more
		// messages. Set to 0 for a low-latency path.
		BatchTimeout: 20 * time.Millisecond,

		// COMPRESSION — applied per batch, so it compounds with batching. zstd
		// gives the best ratio; lz4 is faster with a slightly worse ratio. This
		// shrinks network and disk, the dominant costs at scale.
		Compression: kafka.Zstd,

		// DURABILITY — acks=all waits for all in-sync replicas. Combined with
		// broker min.insync.replicas=2 (RF=3) this is the durability standard.
		// It adds a replication round trip to latency; that is the price.
		RequiredAcks: kafka.RequireAll,

		// Keep the pipeline full: allow several in-flight batches. With the
		// idempotent producer enabled on the broker, retries stay safe.
		Async: false, // synchronous for backpressure; set true for max throughput
	}
}

// LowLatencyWriter is the opposite tuning: no lingering, tiny batches, leader-
// only acks. Every message goes out immediately. Use for the user-facing path
// where a few ms matters more than raw throughput.
func LowLatencyWriter(brokers []string, topic string) *kafka.Writer {
	return &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        topic,
		BatchTimeout: 0,                 // do not wait to batch
		BatchSize:    1,                 // send each message on its own
		Compression:  kafka.Lz4,         // cheap, still helps the wire
		RequiredAcks: kafka.RequireOne,  // leader-only ack: one fewer round trip
	}
}

func write(ctx context.Context, w *kafka.Writer, key, val []byte) error {
	// Keying by a stable field pins related messages to one partition, which
	// preserves per-key order — but a HOT key concentrates load on one
	// partition and becomes the throughput bottleneck (chapter 22).
	return w.WriteMessages(ctx, kafka.Message{Key: key, Value: val})
}
```

### RabbitMQ: prefetch, persistence and lazy queues

```go
package tuning

import amqp "github.com/rabbitmq/amqp091-go"

// TuneRabbitConsumer sets prefetch — the single most important RabbitMQ consumer
// lever. Prefetch=1 gives perfect fairness but terrible throughput (a round trip
// per message). A prefetch of ~100-300 lets the broker push a batch ahead of the
// consumer so it never starves, at the cost of more memory in flight and less
// even distribution across consumers. Tune to processing time: fast handlers
// want higher prefetch, slow handlers lower.
func TuneRabbitConsumer(ch *amqp.Channel) error {
	// prefetchCount=200, prefetchSize=0 (no byte limit), global=false (per-consumer)
	return ch.Qos(200, 0, false)
}

// PublishTransient sends a message WITHOUT forcing a disk write — fastest, but
// lost if the broker restarts before it is consumed. Use for data where loss is
// tolerable (metrics, cache invalidations).
func PublishTransient(ch *amqp.Channel, exchange, key string, body []byte) error {
	return ch.Publish(exchange, key, false, false, amqp.Publishing{
		DeliveryMode: amqp.Transient, // delivery_mode=1: memory only
		Body:         body,
	})
}

// PublishPersistentBatched sends persistent messages but amortises the confirm
// round trip: publish many, then wait for all confirms together. Waiting per
// message would serialise on the network round trip and cripple throughput.
func PublishPersistentBatched(ch *amqp.Channel, exchange, key string, bodies [][]byte) error {
	if err := ch.Confirm(false); err != nil { // put channel in confirm mode
		return err
	}
	confirms := ch.NotifyPublish(make(chan amqp.Confirmation, len(bodies)))
	for _, b := range bodies {
		if err := ch.Publish(exchange, key, false, false, amqp.Publishing{
			DeliveryMode: amqp.Persistent, // delivery_mode=2: written to disk
			Body:         b,
		}); err != nil {
			return err
		}
	}
	// Wait for the whole batch's confirms in one loop — the amortisation.
	for range bodies {
		if c := <-confirms; !c.Ack {
			return amqp.ErrClosed
		}
	}
	return nil
}
```

```ini
# rabbitmq.conf — capacity-relevant broker settings.
# Raise the disk-free limit from the absurd 50MB default: block publishers
# before the disk is dangerously low, not after.
disk_free_limit.absolute = 5GB
# Memory high watermark: fraction of RAM before publishers are blocked.
vm_memory_high_watermark.relative = 0.5
# Make queues lazy by default so a stuck consumer's backlog goes to disk
# instead of exhausting memory and blocking ALL publishers.
queue_master_locator = min-masters
```

### Benchmark honestly with the built-in tools

```bash
# Kafka producer benchmark: 10M records, 1KB each, measure MB/s and p99 latency.
# Vary --producer-props to A/B test batch/linger/compression/acks combinations.
kafka-producer-perf-test.sh \
  --topic bench --num-records 10000000 --record-size 1024 \
  --throughput -1 \
  --producer-props bootstrap.servers=broker1:9092 \
    batch.size=131072 linger.ms=20 compression.type=zstd acks=all

# Output includes: records/sec, MB/sec, avg latency, and p50/p95/p99/p99.9 —
# the tail latencies are what your SLO cares about, not the average.

# Kafka consumer benchmark: how fast can a single consumer drain the topic?
kafka-consumer-perf-test.sh \
  --bootstrap-server broker1:9092 --topic bench \
  --messages 10000000 --threads 1

# RabbitMQ: PerfTest (the official load generator) — publishers/consumers, rate,
# message size, persistence, and confirms all configurable.
# 4 publishers, 4 consumers, 1KB persistent messages, prefetch 200:
java -jar perf-test.jar \
  --uri amqp://broker:5672 \
  --producers 4 --consumers 4 --size 1024 \
  --flag persistent --qos 200 --time 60
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of deliberate tuning**
- **Order-of-magnitude throughput.** Batching plus compression routinely turns a few tens of thousands of messages/s into millions — the difference between a cluster that copes and one that melts.
- **Predictable capacity.** The capacity arithmetic turns "will it hold?" into a number you can defend before you buy hardware.
- **Cost efficiency.** Compression and right-sized partitions cut storage and network spend directly, often the largest line item at scale.
- **Failure headroom.** Planning with 2× headroom means a broker dying and its load redistributing does not tip the cluster over.

**Disadvantages / costs**
- **Latency penalty.** Every throughput lever adds latency; a firehose tuning makes an interactive path feel sluggish, so one cluster rarely serves both well.
- **Tuning is workload-specific and perishable.** The right settings depend on message size, rate and processing time; a change in workload invalidates them, so tuning is never "done".
- **Over-provisioning is a real cost.** Too many partitions slow failover and rebalances and waste file handles and memory — more is not free.
- **Benchmarks lie easily.** A benchmark on empty topics with warm caches and no competing load flatters the numbers; realistic benchmarking is hard and easy to get wrong.

**Trade-offs**
- *Throughput vs latency:* the central trade — batch size, linger, prefetch, and acks all buy throughput with latency. Pick your position on the curve per workload, not per cluster.
- *Durability vs speed:* `acks=all` + `min.insync=2` and RabbitMQ persistence + confirms are slower than `acks=1` and transient; you pay latency and throughput for not losing messages.
- *Partitions: parallelism vs overhead:* more partitions raise the throughput/parallelism ceiling but slow leader election, heavier rebalances, and cost file handles — and you can add but not easily remove them, so err slightly high but not wildly.
- *Compression: CPU vs network/disk:* zstd gives the best ratio (least network/disk) at more CPU; lz4 is cheaper CPU with a worse ratio. At scale network/disk usually dominate, favouring stronger compression.

## 7. Common Mistakes & Best Practices

- **Leaving `linger.ms=0` on a high-throughput producer.** With no lingering the producer sends tiny batches and pays the fixed per-request cost per message; a few milliseconds of linger can multiply throughput. (And leaving it high on a low-latency path needlessly adds latency — the mistake cuts both ways.)
- **Prefetch of 1 (or unlimited) on RabbitMQ.** Prefetch 1 serialises on a round trip per message (throughput floor); unlimited lets one consumer hoard the whole queue (memory blow-up, unfair). Tune it to processing time.
- **Giving Kafka a huge JVM heap.** Kafka's data lives in page cache, not the heap; a big heap just causes long GC pauses. Give it a modest heap (6-8GB) and leave the RAM to the OS.
- **Opening a channel or connection per message (RabbitMQ).** Connection/channel setup is expensive; reuse long-lived connections and a small pool of channels.
- **Sizing partitions from today's load only.** Partitions cap consumer parallelism and are painful to reduce; size for anticipated future load plus headroom, but resist wild over-provisioning that slows failover.
- **Benchmarking on unrealistic conditions.** Empty topics, warm caches, no competing traffic, and averages instead of p99 all flatter the result; benchmark with realistic size, rate, durability settings, and read the tail latencies.
- **Forgetting replication multiplies everything.** RF=3 triples storage *and* inter-broker network; a plan that ignores replication under-provisions by 3×.
- **Best practice: position each workload on the latency-throughput curve first, then turn the levers, then verify with a realistic benchmark.** Firehose paths get big batches/linger/compression; interactive paths get tiny batches and low acks — and they usually belong on different topics or even clusters.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When throughput is below expectation, decompose the pipeline: is the producer batch actually filling (check average batch size and records-per-request), is compression on, is the consumer's `max.poll.records` or prefetch starving it, or is a downstream dependency the real ceiling (the consumer is idle waiting on a database)? The amortisation identity is the debugging lens — find which term dominates. A common surprise is that the "slow broker" is actually a low-linger producer sending one-message batches.
- **Monitoring.** Tie tuning to the metrics from chapter 27: throughput (bytes/s) is the pulse, request latency p99 is the cost, and lag confirms whether a tuning change actually let consumers keep up. Watch producer batch-size and compression-ratio metrics to confirm batching is working; a batch-size average of 1 means your linger/batch config is not taking effect.
- **Security.** The biggest performance-security intersection is TLS: enabling TLS on the Kafka read path *defeats zero-copy*, because encrypted bytes must pass through user space to be encrypted rather than going straight from page cache to socket via `sendfile`. This is a real, measurable throughput cost (often 20-40%) that you must budget for when planning a secured cluster (chapter 29) — the capacity math changes once TLS is on.
- **Scaling.** Scaling is applied capacity planning: add consumers until you hit the partition ceiling, add partitions (accepting the ordering caveat) to raise that ceiling, add brokers when per-broker disk or network saturates, and re-run the arithmetic each time. The signal that a scaling action worked is lag returning to flat at the new, higher throughput. Plan capacity with headroom for a broker being down — a 3-broker cluster running at 70% per broker cannot absorb one broker's failure, because the surviving two would need 105%.

## 9. Interview Questions

**Q: Where does messaging throughput actually come from?**
A: From amortisation — turning many small per-message operations into few large ones. The cost to move a message is roughly the fixed per-request overhead (network round trip, syscall, disk seek, replication handshake) divided by the batch size, plus a per-byte cost. When you batch, the fixed overhead is divided across many messages and the per-message cost collapses toward the per-byte floor. That is why batching is the master lever, why compression compounds with it (it shrinks the per-byte term), and why Kafka can do millions of messages per second — almost nothing is done per-message.

**Q: Why does every throughput lever cost latency?**
A: Because throughput comes from batching, and batching means a message waits. When you grow the batch — via `batch.size`, `linger.ms`, or RabbitMQ prefetch — the first message in the batch waits for the batch to fill or for the linger timeout to elapse before it is sent. So you lower the per-message *cost* by raising the per-message *latency*. There is no setting that improves both; there is only the right position on the latency-throughput curve for a given workload. A firehose wants big batches and high linger; a user-facing path wants batch size one and zero linger.

**Q: What are the main Kafka producer throughput levers?**
A: `batch.size` (how many bytes to accumulate per partition before sending), `linger.ms` (how long to wait for a batch to fill), compression (`lz4`/`zstd`/`snappy`/`gzip`, applied per batch so it compounds with batching), `acks` (0/1/all — durability versus latency), and buffer sizing (`buffer.memory`). On the broker side, replica fetcher tuning (`num.replica.fetchers`) and segment sizing matter. Partition count is the parallelism lever above all of them. The typical firehose tuning is a batch of tens to hundreds of KB, linger of 10-50ms, zstd compression, and `acks=all`.

**Q: How do you size partition count?**
A: Roughly, `partitions ≥ target_throughput / per_partition_throughput`, with headroom. Per-partition throughput is workload-dependent (often 5-10 MB/s), so 200 MB/s target over 10 MB/s per partition gives at least 20, rounded up to ~30 for headroom. Partition count also caps consumer parallelism per group — you can never have more active consumers in a group than partitions — so it must be at least the maximum number of consumers you will ever run, and a neat multiple of that is convenient. Too few caps throughput and parallelism; too many cost file handles and memory, slow leader election, and make rebalances heavier.

**Q: Why can you add partitions but not easily remove them, and why does it matter?**
A: You can add partitions to a topic online, but Kafka has no operation to reduce them — you would have to create a new topic and migrate. It matters for two reasons. First, adding partitions changes the key-to-partition mapping (the hash is modulo the partition count), so a key that used to go to partition 2 may now go to partition 5, breaking per-key ordering for existing keys — messages for one key can be split across the old and new partitions. Second, because reduction is effectively impossible, over-provisioning is a one-way door: too many partitions permanently slow failover and rebalances. So you size for future load plus headroom, but resist wild over-provisioning.

**Q: Walk through the capacity arithmetic for a Kafka cluster.**
A: Start with target throughput (say 200 MB/s) and retention (say 72 hours). Raw storage is throughput × retention: 200 MB/s × 259,200 s ≈ 52 TB. Replication multiplies it: RF=3 makes it ≈ 155 TB before compression, and you add headroom (commonly 2×) for spikes and to absorb a broker failure redistributing its load. Compression reduces the stored bytes by whatever ratio your data achieves. Network: replication means every write is sent RF−1 additional times between brokers, so inter-broker bandwidth is roughly (RF−1) × write throughput. Partition count comes from target ÷ per-partition throughput with headroom. The whole plan should survive one broker being down, so per-broker utilisation should sit well below 100% — a 3-broker cluster at 70% each cannot survive a failure.

**Q: What hardware does Kafka want, and what is the common sizing mistake?**
A: Kafka wants fast disks (sequential writes), lots of RAM for the OS page cache, and fast network — but a *modest* JVM heap, typically 6-8GB. The common mistake is sizing it like a database with a huge heap. Kafka deliberately keeps data in the page cache and serves reads with zero-copy `sendfile` straight from cache to socket, bypassing the heap entirely, so a large heap does not help throughput and actively hurts it by causing long GC pauses. Give most of the RAM to the OS, not the JVM.

**Q: (Senior) A single Kafka cluster must serve both a low-latency notification path and a high-throughput analytics firehose. How do you approach it?**
A: My starting position is that these two workloads sit at opposite ends of the latency-throughput curve and cannot share one producer tuning, so I separate them. At minimum they get different topics with different producer configurations: the analytics firehose gets large batches, tens of milliseconds of linger, and zstd compression to maximise throughput, accepting that any given message may wait; the notification path gets batch size one, zero linger, lz4 or no compression, and possibly `acks=1` to shave a replication round trip, accepting lower throughput for low tail latency. If the workloads are large enough or their SLOs strict enough, I would go further and put them on separate clusters, because they compete for the same broker resources — the firehose can saturate disk and network and inflate the notification path's tail latency even with separate topics, and a firehose retention policy (days) has very different storage implications from a notification topic (hours). Multi-tenancy controls help if they must share: client quotas (chapter 29) cap the firehose's produce/fetch rate so it cannot starve the latency-sensitive tenant, and careful partition placement keeps them off the same hot brokers. I would also be explicit that the two have different durability needs — analytics can often tolerate `acks=1` and even some loss, while notifications may need `acks=all` — and let that further justify the separation. The general principle is that "one cluster for everything" is a false economy the moment two workloads have conflicting positions on the latency-throughput curve; the cost of a second cluster is usually less than the cost of the two workloads degrading each other.

**Q: (Senior) You benchmark a new cluster at two million messages/s but production tops out at four hundred thousand. What are the likely reasons and how do you investigate?**
A: The gap almost always comes from the benchmark being unrealistically favourable, so I would systematically remove each way the benchmark cheated. First, message size and shape: benchmarks often use uniform small messages that compress and batch beautifully, while production has larger, varied, less-compressible payloads — I would re-run with production-representative sizes and content. Second, durability settings: a benchmark run with `acks=1` and no replication will vastly outperform production running `acks=all` with RF=3 and `min.insync=2`, because the latter adds a replication round trip per batch — I would confirm the benchmark used the same durability contract as production. Third, key distribution and partitioning: a benchmark with round-robin or uniform keys spreads perfectly across partitions, while production may have a hot key concentrating load on one partition that becomes the bottleneck regardless of cluster capacity — I would check per-partition throughput for skew. Fourth, the consumer side and downstream: production consumers do real work and call databases, so the true ceiling may be a downstream dependency, not the broker — I would check whether consumers are CPU-idle while lag rises, which points downstream. Fifth, competing load and cold caches: the benchmark ran alone on warm caches; production shares brokers with other topics and serves reads that miss the page cache and hit disk. Sixth, client tuning drift: the benchmark's batch/linger/compression may not match what the production clients actually send — I would check the producer batch-size and compression-ratio metrics, because an average batch size of one message reveals a linger misconfiguration that alone can explain a 5× gap. The method is to make the benchmark progressively more like production one variable at a time until the number drops to match, and the variable that closes the gap is your bottleneck.

**Q: (Senior) How does enabling TLS change your capacity plan, and why?**
A: TLS materially reduces Kafka's read throughput because it defeats the zero-copy path, and that has to be budgeted into the capacity plan rather than discovered after go-live. Normally Kafka serves consumer fetches with the `sendfile` system call, which sends log bytes straight from the OS page cache to the network socket without ever copying them into user space or the JVM — this is a large part of why Kafka is fast. When TLS is enabled on the client-broker connection, the bytes must be encrypted, which cannot happen in the kernel's zero-copy path, so every byte served to a consumer now takes a trip through user space to be encrypted, adding CPU cost and memory copies. The measured effect is commonly a 20-40% reduction in read throughput and a corresponding rise in CPU usage, though the exact figure depends on the cipher, hardware AES acceleration, and message size. The capacity implications are concrete: I would provision more CPU headroom and possibly more brokers to hit the same consumer throughput under TLS, verify that AES-NI hardware acceleration is enabled (it makes a large difference), and — where the threat model allows — consider terminating TLS only on client-facing connections while keeping inter-broker traffic on a trusted network, or accept the cost as the price of encryption everywhere. The key discipline is to run the benchmark *with TLS on* if production will use TLS, because a plaintext benchmark will over-promise by exactly the zero-copy premium you are about to give up.

## 10. Quick Revision & Cheat Sheet

| Lever | Kafka | RabbitMQ | Direction for throughput |
|---|---|---|---|
| **Batch** | `batch.size` | (implicit) | Bigger |
| **Linger** | `linger.ms` | — | Higher (costs latency) |
| **Compression** | lz4/zstd/snappy/gzip | — (per-message) | On (zstd best ratio) |
| **Consumer pull** | `fetch.min.bytes`, `max.poll.records` | `prefetch` (`basic.qos`) | Higher prefetch/fetch |
| **Durability** | `acks`, `min.insync.replicas` | persistent + confirms | Lower acks = faster |
| **Parallelism** | partition count | consumers per queue | More partitions |
| **Backlog holding** | retention/segments | lazy queues | Lazy for huge backlogs |

**Capacity arithmetic**
- **Storage** = throughput × retention × RF (÷ compression ratio) + headroom.
- **Inter-broker network** ≈ (RF − 1) × write throughput.
- **Partitions** ≥ target throughput ÷ per-partition throughput (and ≥ max consumers).
- **Headroom** ≈ 2× so one broker failing does not tip the cluster.

**Flash cards**
- **Master throughput lever?** → Batching (amortises fixed per-request cost).
- **Why does throughput cost latency?** → The first message waits for its batch to fill / linger to elapse.
- **Kafka JVM heap size?** → Small (6-8GB); data lives in page cache, big heap = GC pauses.
- **Add or remove partitions?** → Add yes (breaks per-key order), remove effectively no.
- **RabbitMQ #1 consumer lever?** → Prefetch (`basic.qos`): too low starves, too high hoards.
- **What does TLS cost Kafka?** → Zero-copy on reads → 20-40% less read throughput.

## 11. Hands-On Exercises & Mini Project

- [ ] Run `kafka-producer-perf-test.sh` at `linger.ms=0` then `linger.ms=20` with compression and record the throughput and p99 latency difference.
- [ ] Sweep RabbitMQ prefetch (1, 10, 100, 500) with PerfTest and plot throughput and fairness across consumers.
- [ ] Compute the storage for a workload of your choice (throughput × retention × RF) and compare to what a compression ratio of 4:1 gives.
- [ ] Add a partition to a keyed topic and demonstrate that an existing key can now land on a different partition, breaking its order.
- [ ] Benchmark with `acks=1` then `acks=all` (RF=3, min.insync=2) and quantify the durability tax in throughput and latency.
- [ ] Run a Kafka read benchmark with and without TLS and measure the zero-copy premium.

### Mini Project — "Size and Tune a Cluster for a Target SLO"

**Goal.** Take a concrete workload and produce both a defensible capacity plan and a tuning that meets a stated throughput and latency SLO, verified by benchmark.

**Requirements.**
1. Define the workload: target msgs/s and MB/s (peak and average), message size distribution, retention, RF, and a latency SLO (e.g. p99 < 50ms).
2. Compute storage, inter-broker network, partition count, and broker count with 2× headroom, showing the arithmetic.
3. Produce two tunings — one throughput-optimised, one latency-optimised — with the exact producer/consumer/broker settings and the reasoning per lever.
4. Benchmark both with the built-in tools under realistic size, durability, and key distribution, reporting throughput and p50/p99/p99.9 latency.
5. Induce a broker failure at target load and confirm the surviving brokers stay under 100% (i.e. the headroom was sufficient).

**Extensions.**
- Repeat the benchmark with TLS on and quantify the zero-copy premium against your capacity plan.
- Introduce a deliberately hot key and show how per-partition skew caps throughput regardless of total cluster capacity, then fix it with a better key.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Monitoring: Lag, Throughput & Broker Health* (the metrics that confirm a tuning worked), *Ordering, Partitioning & Keys* (why partition count and hot keys govern throughput), *Delivery Guarantees* (why acks and durability cost throughput), *Security & Multi-Tenancy* (why TLS changes the capacity math and how quotas isolate tenants), *The Log: Offsets, Segments & Retention* (segments, retention, and how storage is laid out).

- **Apache Kafka — Producer & Broker Configuration** — Apache · *Intermediate* · the authoritative reference for `batch.size`, `linger.ms`, `acks`, compression and the broker knobs. <https://kafka.apache.org/documentation/#producerconfigs>
- **Benchmarking Apache Kafka: 2 Million Writes Per Second** — Jay Kreps / LinkedIn · *Advanced* · the classic post on how batching, sequential I/O and zero-copy produce Kafka's throughput. <https://engineering.linkedin.com/kafka/benchmarking-apache-kafka-2-million-writes-second-three-cheap-machines>
- **Confluent — Optimizing Kafka Deployments (Throughput/Latency/Durability)** — Confluent · *Advanced* · the four-way trade (throughput, latency, durability, availability) and which knob moves which. <https://docs.confluent.io/platform/current/kafka/deployment.html>
- **RabbitMQ — Consumer Prefetch & Performance** — RabbitMQ · *Intermediate* · how prefetch governs consumer throughput and fairness, with tuning guidance. <https://www.rabbitmq.com/docs/consumer-prefetch>
- **RabbitMQ — Lazy Queues & Memory** — RabbitMQ · *Intermediate* · disk-backed queues for huge backlogs and how memory pressure blocks publishers. <https://www.rabbitmq.com/docs/lazy-queues>
- **RabbitMQ PerfTest** — RabbitMQ · *Intermediate* · the official load-generation tool for benchmarking publishers/consumers under realistic settings. <https://www.rabbitmq.com/docs/java-tools>
- **Kafka — Capacity Planning & Sizing** — Confluent · *Advanced* · turning throughput, retention and RF into storage, network and broker counts. <https://docs.confluent.io/platform/current/kafka/post-deployment.html>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · the systems reasoning behind log storage, throughput, and the durability-versus-speed trade. <https://dataintensive.net/>

---

*Kafka & RabbitMQ Handbook — chapter 28.*
