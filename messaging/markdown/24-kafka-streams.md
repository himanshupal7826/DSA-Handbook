# 24 · Design: Kafka Streams & Stream Processing Basics

> **In one line:** Kafka Streams is not a cluster you deploy but a *library you embed* — it turns "consume, transform, produce" into a declarative topology, and its one genuinely deep idea is the stream–table duality: a `KStream` is every event, a `KTable` is the latest value per key, and each is the other seen from the opposite side.

---

## 1. Overview

You have events flowing through Kafka topics. Now you want to *do* something with them continuously: count clicks per user per minute, enrich an order stream with customer data, detect that three failed logins happened inside thirty seconds, maintain a running balance per account. You could write a plain consumer that reads records, keeps some state in a map, and produces results to an output topic — and for a trivial case that is fine. But the moment you need windowing, fault-tolerant local state, joins across streams, exactly-once output, and horizontal scaling, you have started to reimplement a stream-processing framework badly. **Kafka Streams** is that framework, done properly, and shipped as a JVM library.

The defining choice — and the one interviewers probe — is that Kafka Streams is **a library, not a cluster**. There is no separate processing tier to provision, no resource manager, no master node. You write a normal Java or Kotlin application, add the `kafka-streams` dependency, define a *topology*, and run your app. Scaling is not "add nodes to the Streams cluster" (there is no such thing); it is "run more instances of your app", and those instances form a **consumer group** and share the input partitions exactly like any other Kafka consumers. Ten instances against a 10-partition input topic gives you ten-way parallelism; kill four and the surviving six rebalance and pick up the orphaned partitions. All the heavy machinery — state stores, changelogs, exactly-once — rides on top of ordinary Kafka topics and the ordinary consumer-group protocol.

Stream processing itself is the idea of transforming data **in place, as it arrives**, rather than collecting it into a batch and processing the batch later. Batch asks "what is the total for all of yesterday?" and runs once; stream processing asks "what is the running total *right now*, updated on every event?" and never stops. The output of a batch job is a file; the output of a stream processor is *another stream* (or a continuously-updated table). This chapter is about the model: what a `KStream` and a `KTable` are and why their duality is the whole game, stateless versus stateful operations, the local state stores that make stateful processing fast and fault-tolerant, windowing over event time, the three kinds of join, and exactly-once processing. Because Kafka Streams is JVM-native, the code here is Java/Kotlin — this is the one place in the handbook where that is the *correct* choice, not a fallback.

## 2. Core Concepts

- **Stream processing** — transforming, aggregating or joining unbounded streams of records continuously, in place, producing new streams or tables; the opposite of batch (bounded input, run-to-completion).
- **Kafka Streams** — a JVM client library for stream processing on top of Kafka. Runs *inside your application process*; no separate cluster.
- **Topology** — the directed graph of processing steps (source → operators → sink) that your application defines and the library executes.
- **KStream** — an abstraction over a topic read as a *record stream*: every record is an independent event ("insert" semantics). Two records with the same key are two facts, not an overwrite.
- **KTable** — an abstraction over a topic read as a *changelog*: the latest value per key ("upsert" semantics). A new record with an existing key *replaces* the old value; a null value is a *tombstone* (delete).
- **Stream–table duality** — a stream aggregated by key *becomes* a table; a table's sequence of changes *is* a stream. Each is the other from the opposite direction.
- **Stateless operation** — one that needs no memory of past records: `map`, `filter`, `flatMap`, `branch`, `selectKey`. Each record processed in isolation.
- **Stateful operation** — one that must remember: `aggregate`, `reduce`, `count`, joins, windowing. Backed by a **state store**.
- **State store** — a local, embedded key-value store (default **RocksDB**) holding the operator's state on the instance that owns the partition. Fault-tolerant via a **changelog topic**.
- **Changelog topic** — a compacted Kafka topic that records every update to a state store, so the store can be rebuilt exactly on another instance after a failure.
- **Windowing** — grouping records by time buckets: **tumbling** (fixed, non-overlapping), **hopping** (fixed, overlapping), **session** (activity-gap defined), plus **sliding** for joins.
- **Event time vs processing time** — the time the event *happened* (embedded in the record) versus the time your app *saw* it. Correct windowing uses event time.
- **Exactly-once (EOS v2)** — the guarantee that each input record affects state and output *once*, even across failures, via Kafka transactions spanning consume-process-produce.

## 3. Theory & Principles

### Stream processing vs batch, and why "in place" matters

A batch job has a bounded input (yesterday's log file, this table snapshot), runs to completion, emits a result, and exits. A stream processor has an *unbounded* input — records arrive forever — so it never completes; it maintains and continuously updates a result. The practical consequences are large. Batch latency is at least the batch interval (you learn yesterday's totals today); stream latency is milliseconds-to-seconds (you learn the total as the event lands). Batch reprocesses the whole input to correct a bug; a stream processor, because Kafka retains the log, can *replay* from an offset and recompute — the same replay capability chapter 14 dwells on. The mental shift is that a stream processor's output is not a static answer but a *living* one: a stream of results or a table that keeps changing.

### The stream–table duality — the one idea to internalise

This is the deep concept and it is worth slowing down for. Consider a topic of `(user, balance-change)` records. Read as a **KStream**, every record is an independent event: `(alice, +10)`, `(alice, -3)`, `(bob, +5)` are three facts, and if you print the stream you see three lines. Read the *same key space* as a **KTable**, and each record *updates* the latest value for its key: after those records the table holds `alice → 7, bob → 5`, two rows, because the second `alice` record overwrote the first.

Now the duality:

- **A stream aggregated by key becomes a table.** `stream.groupByKey().reduce((a, b) -> a + b)` folds the event stream into a table of running totals. The table is the *accumulated* view of the stream.
- **A table's changelog is a stream.** Every update to a table (`alice → 7`, then `alice → 12`) is itself a record; the sequence of those updates *is* a stream. `table.toStream()` gives you back the change events.

So a table is "a stream folded up", and a stream is "the sequence of a table's changes". They are two representations of the same information, and Kafka Streams lets you move between them freely (`aggregate`/`reduce`/`count` turn a stream into a table; `toStream()` turns a table into a stream). This is not academic: it is *why* Kafka can be both a messaging system and a database inside-out (Kleppmann's phrase). A KTable is literally backed by a **compacted** topic — compaction keeps the latest value per key, which is exactly table semantics — and a KStream is backed by an ordinary retained topic where every record survives. The storage model mirrors the abstraction.

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="d1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="d2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The stream&#8211;table duality: same data, opposite views</text>

  <rect x="24" y="44" width="400" height="196" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="224" y="66" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">KSTREAM &#8212; every event (insert)</text>
  <g font-size="10" fill="#5b21b6">
    <rect x="44" y="80" width="150" height="22" rx="3" fill="#fff" stroke="#a78bfa"/><text x="54" y="95">(alice, +10)</text>
    <rect x="44" y="106" width="150" height="22" rx="3" fill="#fff" stroke="#a78bfa"/><text x="54" y="121">(alice, -3)</text>
    <rect x="44" y="132" width="150" height="22" rx="3" fill="#fff" stroke="#a78bfa"/><text x="54" y="147">(bob, +5)</text>
    <rect x="44" y="158" width="150" height="22" rx="3" fill="#fff" stroke="#a78bfa"/><text x="54" y="173">(alice, +5)</text>
  </g>
  <text x="44" y="204" fill="#6d28d9" font-size="9">4 records &#8594; 4 independent facts</text>
  <text x="44" y="220" fill="#6d28d9" font-size="9">backed by a RETAINED topic (all kept)</text>

  <rect x="456" y="44" width="400" height="196" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="656" y="66" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">KTABLE &#8212; latest per key (upsert)</text>
  <g font-size="10" fill="#15803d">
    <rect x="476" y="90" width="180" height="24" rx="3" fill="#fff" stroke="#4ade80"/><text x="486" y="106">alice &#8594; 17</text>
    <rect x="476" y="120" width="180" height="24" rx="3" fill="#fff" stroke="#4ade80"/><text x="486" y="136">bob &#8594; 5</text>
  </g>
  <text x="476" y="168" fill="#166534" font-size="9">2 rows &#8594; the accumulated view</text>
  <text x="476" y="184" fill="#166534" font-size="9">null value = tombstone (delete the key)</text>
  <text x="476" y="204" fill="#166534" font-size="9">backed by a COMPACTED topic (latest kept)</text>
  <text x="476" y="220" fill="#166534" font-size="9">17 = 10 &#8722; 3 + 5 + 5, folded by key</text>

  <path d="M300,244 C340,290 360,300 420,300" stroke="#7c3aed" stroke-width="2.5" fill="none" marker-end="url(#d1)"/>
  <text x="300" y="270" fill="#5b21b6" font-size="10" font-weight="bold">groupByKey().reduce(+)</text>
  <text x="300" y="284" fill="#6d28d9" font-size="9">aggregate a stream &#8594; a TABLE</text>

  <path d="M580,300 C640,300 660,290 700,246" stroke="#16a34a" stroke-width="2.5" fill="none" marker-end="url(#d2)"/>
  <text x="600" y="270" fill="#15803d" font-size="10" font-weight="bold">table.toStream()</text>
  <text x="600" y="284" fill="#166534" font-size="9">a table's changelog &#8594; a STREAM</text>

  <rect x="24" y="300" width="832" height="140" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="322" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The consequence</text>
  <text x="48" y="348" fill="#475569" font-size="10">&#8226; A table is a stream FOLDED UP by key; a stream is the SEQUENCE of a table's changes. Same information, two shapes.</text>
  <text x="48" y="370" fill="#475569" font-size="10">&#8226; Choose KStream when every record is a fact to process (page views, payments). Choose KTable when you want the latest state (prices, profiles).</text>
  <text x="48" y="392" fill="#475569" font-size="10">&#8226; A KTable is literally a compacted topic; a KStream a retained topic. The storage mirrors the abstraction &#8212; database inside-out.</text>
  <text x="48" y="418" fill="#334155" font-size="10" font-weight="bold">Master this and 80% of Kafka Streams design questions answer themselves.</text>
</svg>
```

### Stateless vs stateful, and where the state actually lives

**Stateless** operators process each record in isolation and need no memory: `map` (transform one record to one), `filter` (keep or drop), `flatMap` (one record to zero-or-many), `selectKey` (re-key), `branch` (split into several streams), `merge`. Because they hold nothing, they are trivially parallel and cheap, and a crashed instance loses nothing but its position in the log.

**Stateful** operators must remember across records: `count`, `reduce`, `aggregate` (fold a stream into a table), the various *joins*, and everything *windowed*. Their memory lives in a **state store** — by default an embedded **RocksDB** instance on local disk, on the machine that owns the relevant input partition. Local state is what makes Kafka Streams fast: a lookup during a join or an aggregation is a local disk/memory read, not a network round-trip to a remote database. But local state raises the obvious question — *what happens when that instance dies?* The answer is the **changelog topic**: every write to a state store is also written to a dedicated, **compacted** Kafka topic. If the instance dies, another instance takes over its partition, reads the changelog from the start, and rebuilds the state store *exactly* before resuming. The state is durable because it is, underneath, just another Kafka topic — the same trick as everything else in this system.

## 4. Architecture & Workflow

A Kafka Streams application is a *topology* — a graph — executed by *stream threads*, and the whole thing is partition-parallel. Walk it end to end:

1. **Define the topology.** Using the `StreamsBuilder` DSL you declare sources (input topics), operators (`map`, `filter`, `groupByKey`, `aggregate`, `join`, `windowedBy`), and sinks (`to(outputTopic)`). This builds a directed graph; nothing runs yet.
2. **Start the application.** `new KafkaStreams(topology, config).start()` launches **stream threads**. Each thread runs one or more **tasks**; a task is bound to a specific input partition (or a set of co-partitioned partitions for a join).
3. **Form a consumer group.** All instances of your app (across machines) join one consumer group named by `application.id`. Kafka assigns input partitions across all their tasks. This is how scaling works: more instances → more tasks → more partitions covered, capped at the partition count exactly like any consumer group.
4. **Process records.** Each task pulls records from its partition, runs them through the topology, updates its local state stores for stateful steps, and produces results to sinks. Stateless steps just transform and forward.
5. **Persist state to changelogs.** Every state-store write is mirrored to a compacted changelog topic keyed by the store key, so the store is recoverable.
6. **Recover on failure.** If an instance dies, its partitions (and their tasks) are reassigned to survivors, which rebuild the state stores from the changelog topics before resuming — restoring both position *and* state.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">A library, not a cluster: instances share partitions like a consumer group</text>

  <rect x="24" y="40" width="200" height="118" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="124" y="60" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Input topic: orders</text>
  <g font-size="9" fill="#1e40af">
    <rect x="40" y="72" width="168" height="18" fill="#fff" stroke="#60a5fa"/><text x="48" y="85">partition 0</text>
    <rect x="40" y="94" width="168" height="18" fill="#fff" stroke="#60a5fa"/><text x="48" y="107">partition 1</text>
    <rect x="40" y="116" width="168" height="18" fill="#fff" stroke="#60a5fa"/><text x="48" y="129">partition 2</text>
    <rect x="40" y="138" width="168" height="14" fill="#eff6ff" stroke="#93c5fd" stroke-dasharray="3 2"/><text x="48" y="149">partition 3</text>
  </g>

  <rect x="300" y="40" width="250" height="118" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="425" y="60" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">App instance A (JVM)</text>
  <text x="316" y="80" fill="#b45309" font-size="9">application.id = order-agg</text>
  <rect x="316" y="88" width="100" height="26" rx="4" fill="#fff" stroke="#f59e0b"/><text x="366" y="105" text-anchor="middle" fill="#92400e" font-size="9">task p0</text>
  <rect x="424" y="88" width="100" height="26" rx="4" fill="#fff" stroke="#f59e0b"/><text x="474" y="105" text-anchor="middle" fill="#92400e" font-size="9">task p1</text>
  <rect x="316" y="120" width="208" height="30" rx="4" fill="#fed7aa" stroke="#d97706"/><text x="420" y="139" text-anchor="middle" fill="#92400e" font-size="9">RocksDB state store (local)</text>

  <rect x="600" y="40" width="256" height="118" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="728" y="60" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">App instance B (JVM)</text>
  <text x="616" y="80" fill="#b45309" font-size="9">same application.id = same group</text>
  <rect x="616" y="88" width="110" height="26" rx="4" fill="#fff" stroke="#f59e0b"/><text x="671" y="105" text-anchor="middle" fill="#92400e" font-size="9">task p2</text>
  <rect x="734" y="88" width="106" height="26" rx="4" fill="#fff" stroke="#f59e0b"/><text x="787" y="105" text-anchor="middle" fill="#92400e" font-size="9">task p3</text>
  <rect x="616" y="120" width="224" height="30" rx="4" fill="#fed7aa" stroke="#d97706"/><text x="728" y="139" text-anchor="middle" fill="#92400e" font-size="9">RocksDB state store (local)</text>

  <path d="M224,90 L298,100" stroke="#2563eb" stroke-width="1.5" marker-end="url(#a1)"/>
  <path d="M224,112 L298,110" stroke="#2563eb" stroke-width="1.5" marker-end="url(#a1)"/>
  <path d="M224,124 L598,110" stroke="#2563eb" stroke-width="1.5" marker-end="url(#a1)"/>
  <path d="M224,145 L598,132" stroke="#2563eb" stroke-width="1.5" marker-end="url(#a1)"/>

  <rect x="24" y="182" width="400" height="120" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="224" y="204" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Fault tolerance = the changelog topic</text>
  <text x="40" y="226" fill="#166534" font-size="9">every state-store write &#8594; compacted changelog topic</text>
  <text x="40" y="244" fill="#166534" font-size="9">order-agg-store-changelog (keyed, latest kept)</text>
  <text x="40" y="266" fill="#166534" font-size="9">instance dies &#8594; survivor rebuilds the store from it,</text>
  <text x="40" y="282" fill="#166534" font-size="9">restoring STATE + POSITION before resuming</text>

  <rect x="456" y="182" width="400" height="120" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="656" y="204" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Scaling &amp; rebalance</text>
  <text x="472" y="226" fill="#991b1b" font-size="9">add instance &#8594; more tasks &#8594; more partitions covered</text>
  <text x="472" y="244" fill="#991b1b" font-size="9">capped at partition count (here 4)</text>
  <text x="472" y="266" fill="#991b1b" font-size="9">kill an instance &#8594; its partitions reassign to survivors</text>
  <text x="472" y="282" fill="#991b1b" font-size="9">(cooperative rebalancing avoids stop-the-world)</text>
  <path d="M656,158 L656,180" stroke="#dc2626" stroke-width="1.5" marker-end="url(#a2)"/>

  <rect x="24" y="322" width="832" height="132" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="344" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Topology: source &#8594; operators &#8594; sink</text>
  <g font-size="9" fill="#334155">
    <rect x="48" y="360" width="118" height="30" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="107" y="379" text-anchor="middle">source: orders</text>
    <rect x="190" y="360" width="118" height="30" rx="4" fill="#ede9fe" stroke="#7c3aed"/><text x="249" y="379" text-anchor="middle">filter(paid)</text>
    <rect x="332" y="360" width="140" height="30" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="402" y="379" text-anchor="middle">groupByKey (stateful)</text>
    <rect x="496" y="360" width="150" height="30" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="571" y="379" text-anchor="middle">windowedBy(5m).count</text>
    <rect x="670" y="360" width="150" height="30" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="745" y="379" text-anchor="middle">sink: counts-out</text>
  </g>
  <path d="M166,375 L188,375" stroke="#64748b" stroke-width="1.5" marker-end="url(#a1)"/>
  <path d="M308,375 L330,375" stroke="#64748b" stroke-width="1.5" marker-end="url(#a1)"/>
  <path d="M472,375 L494,375" stroke="#64748b" stroke-width="1.5" marker-end="url(#a1)"/>
  <path d="M646,375 L668,375" stroke="#64748b" stroke-width="1.5" marker-end="url(#a1)"/>
  <text x="48" y="416" fill="#475569" font-size="10">Stateless steps (filter, map) forward records with no memory; stateful steps (groupByKey + count) read/write a state store.</text>
  <text x="48" y="436" fill="#334155" font-size="10" font-weight="bold">One graph, executed per-partition by stream threads, scaled by running more instances.</text>
</svg>
```

The workflow lesson is that **everything reduces to Kafka topics and the consumer-group protocol**: inputs are topics, outputs are topics, state is a compacted changelog topic, offsets and membership use the same group machinery. Kafka Streams adds no new distributed-systems primitive; it *composes* the ones Kafka already has into a processing model, which is exactly why it can be a mere library.

## 5. Implementation

Below is a complete, runnable topology in Java: read an `orders` topic, keep only paid orders, count them per customer in 5-minute tumbling windows with a grace period for late events, and write the results out — then a stateful aggregation and a stream–table join. The comments explain the *why*, since the *what* is the DSL.

```java
import org.apache.kafka.common.serialization.Serdes;
import org.apache.kafka.common.utils.Bytes;
import org.apache.kafka.streams.*;
import org.apache.kafka.streams.kstream.*;
import org.apache.kafka.streams.state.*;

import java.time.Duration;
import java.util.Properties;

public class OrderStreamsApp {

    public static void main(String[] args) {
        Properties props = new Properties();
        // application.id IS the consumer group id. Every instance sharing this id
        // joins one group and shares the input partitions. Change it and you get
        // a NEW group that reprocesses from the configured offset reset.
        props.put(StreamsConfig.APPLICATION_ID_CONFIG, "order-analytics");
        props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:9092");
        // Default key/value serdes; overridable per operator with Consumed/Produced.
        props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
        props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.String().getClass());
        // Exactly-once-v2: consume-process-produce becomes ONE Kafka transaction,
        // so state updates and output records commit atomically or not at all.
        props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG, StreamsConfig.EXACTLY_ONCE_V2);
        // Commit interval bounds how often EOS transactions commit = the latency
        // floor for downstream read_committed consumers.
        props.put(StreamsConfig.COMMIT_INTERVAL_MS_CONFIG, 100);

        StreamsBuilder builder = new StreamsBuilder();

        // ---- Source: a KSTREAM, because every order is an independent event ----
        // Key = customerId, value = a JSON order string (kept simple here).
        KStream<String, String> orders =
                builder.stream("orders", Consumed.with(Serdes.String(), Serdes.String()));

        // ---- STATELESS: filter keeps only paid orders. No state store, cheap,
        // trivially parallel. A crashed instance loses nothing but its offset. ----
        KStream<String, String> paid =
                orders.filter((customerId, order) -> order.contains("\"status\":\"PAID\""));

        // ---- STATEFUL + WINDOWED: count paid orders per customer per 5 minutes ----
        // groupByKey needs records already keyed by customerId (they are). If we
        // needed a different key we'd selectKey(...) first, which forces a
        // repartition (a shuffle through an internal topic) so the new key's
        // records land co-located.
        TimeWindows window = TimeWindows
                // Tumbling: fixed 5-minute buckets that do NOT overlap.
                .ofSizeAndGrace(Duration.ofMinutes(5), Duration.ofMinutes(1));
                // grace = 1 min: accept events whose EVENT TIME falls in a window
                // for up to 1 min after the window ends, then close it. Late
                // events beyond grace are dropped (or routed if you handle them).

        KTable<Windowed<String>, Long> countsPerWindow = paid
                .groupByKey(Grouped.with(Serdes.String(), Serdes.String()))
                .windowedBy(window)
                // count() is a stateful aggregate: it reads/writes a windowed
                // state store (RocksDB) backed by a compacted changelog topic
                // named <application.id>-KSTREAM-AGGREGATE-STATE-STORE-...-changelog.
                .count(Materialized.<String, Long, WindowStore<Bytes, byte[]>>as("paid-counts")
                        .withKeySerde(Serdes.String())
                        .withValueSerde(Serdes.Long()));

        // A KTable is a changelog; toStream() turns each UPDATE back into an event
        // so we can write it to an output topic. The window is embedded in the key.
        countsPerWindow
                .toStream()
                .map((windowedKey, count) -> KeyValue.pair(
                        windowedKey.key() + "@" + windowedKey.window().start(),
                        Long.toString(count)))
                .to("paid-counts-out", Produced.with(Serdes.String(), Serdes.String()));

        // ---- STATEFUL AGGREGATE: running revenue per customer (no window) ----
        // aggregate() is the general fold: initializer + adder. Result is a KTable,
        // i.e. the stream folded into the latest value per key. This is the
        // stream-to-table half of the duality, in code.
        KTable<String, Long> revenuePerCustomer = paid
                .mapValues(OrderStreamsApp::extractAmountCents)
                .groupByKey(Grouped.with(Serdes.String(), Serdes.Long()))
                .aggregate(
                        () -> 0L,                       // initializer: start at 0
                        (customerId, amount, sum) -> sum + amount,  // adder
                        Materialized.<String, Long, KeyValueStore<Bytes, byte[]>>as("revenue")
                                .withValueSerde(Serdes.Long()));

        // ---- STREAM-TABLE JOIN: enrich each order with the customer's tier ----
        // customers is read as a KTABLE: latest tier per customer (upsert). A
        // stream-table join is a LOOKUP: for each order event, fetch the current
        // table value for that key. Only the STREAM side drives output; a table
        // update does not emit. Both sides must be co-partitioned (same key,
        // same partition count).
        KTable<String, String> customers =
                builder.table("customers", Consumed.with(Serdes.String(), Serdes.String()));

        KStream<String, String> enriched = paid.join(
                customers,
                (order, tier) -> order + " | tier=" + (tier == null ? "UNKNOWN" : tier));
        enriched.to("orders-enriched", Produced.with(Serdes.String(), Serdes.String()));

        // Build and start. start() launches stream threads that form the group.
        KafkaStreams streams = new KafkaStreams(builder.build(), props);
        // Clean shutdown: leaves the group cooperatively and flushes state.
        Runtime.getRuntime().addShutdownHook(new Thread(streams::close));
        streams.start();
    }

    // Toy parser: pull "amount":<cents> out of the JSON. Real code uses a proper
    // deserializer + Schema Registry (chapter 26) instead of string scraping.
    private static long extractAmountCents(String order) {
        int i = order.indexOf("\"amount\":");
        if (i < 0) return 0L;
        int start = i + 9, end = start;
        while (end < order.length() && Character.isDigit(order.charAt(end))) end++;
        return Long.parseLong(order.substring(start, end));
    }
}
```

The same topology in **Kotlin** with the `kafka-streams` Kotlin DSL reads more tightly; the shape is identical, which is the point — the topology *is* the program:

```kotlin
val builder = StreamsBuilder()
val orders: KStream<String, String> = builder.stream("orders")

orders
    .filter { _, order -> "\"status\":\"PAID\"" in order }
    .groupByKey()
    // Hopping window: 5-minute windows advancing every 1 minute (they OVERLAP,
    // so each record falls into up to 5 windows). Use for smoothed moving counts.
    .windowedBy(TimeWindows.ofSizeAndGrace(Duration.ofMinutes(5), Duration.ofMinutes(1))
                          .advanceBy(Duration.ofMinutes(1)))
    .count(Materialized.`as`("hopping-paid-counts"))
    .toStream()
    .to("paid-counts-hopping")
```

To run it you first create the topics, then launch as many instances as you have partitions:

```bash
# Create input/output topics. Partition count on 'orders' caps Streams parallelism.
kafka-topics.sh --bootstrap-server localhost:9092 --create \
  --topic orders --partitions 6 --replication-factor 3
kafka-topics.sh --bootstrap-server localhost:9092 --create \
  --topic paid-counts-out --partitions 6 --replication-factor 3

# 'customers' is a KTable source: make it COMPACTED so latest-per-key is retained.
kafka-topics.sh --bootstrap-server localhost:9092 --create \
  --topic customers --partitions 6 --replication-factor 3 \
  --config cleanup.policy=compact

# Scale out by running more copies of the SAME jar (same application.id). They
# join one group; Kafka shares the 6 partitions across them (max parallelism 6).
java -jar order-analytics.jar   # instance 1
java -jar order-analytics.jar   # instance 2  (on another host)
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **No cluster to run.** It is a library; you deploy your app the way you already deploy apps (containers, autoscalers), and scale by running more instances.
- **Local state = low latency.** Aggregations and joins read RocksDB locally, not a remote database, so per-record processing is fast.
- **Fault-tolerant state for free.** Changelog topics rebuild state exactly on failover; you did not have to design a replication scheme.
- **Exactly-once processing.** EOS v2 makes consume-transform-produce atomic across state and output, which is genuinely hard to build by hand.
- **The duality is expressive.** KStream/KTable and the join family model enrichment, aggregation and CDC-style materialised views cleanly.

**Disadvantages**
- **JVM only.** No first-class Streams for Go, Python or Rust — if your stack is not JVM, you use ksqlDB, Flink, Faust-like libraries, or a plain consumer.
- **State is heavy to operate.** RocksDB tuning, disk sizing, and slow restores from large changelogs are real operational costs.
- **Restore time on rebalance.** A task that owns a large state store must replay its changelog before it can process, which delays recovery (mitigated by *standby replicas*).
- **Repartition shuffles.** `selectKey`/`groupBy` on a new key writes an internal repartition topic — extra I/O and latency that is easy to trigger unknowingly.
- **Partition count caps parallelism.** Like any consumer group, you cannot have more active tasks than input partitions; under-partitioning limits scale-out.

**Trade-offs**
- *Library vs framework:* a library is simpler to deploy and reason about than a Flink/Spark cluster, but you get no cluster-level resource management, cross-app scheduling, or the richer state/time features Flink offers — you trade power for operational simplicity.
- *Local state vs remote lookups:* local RocksDB is fast but must be replicated (changelog) and restored (slow on failover); a remote store avoids restore pain but adds a network hop per record. Kafka Streams commits hard to local state.
- *Exactly-once vs latency/throughput:* EOS v2 batches into transactions that commit on `commit.interval.ms`, so stronger semantics raise end-to-end latency for `read_committed` consumers. Turn it on where correctness needs it, not everywhere.
- *Event time correctness vs completeness:* a longer grace period catches more late events (correctness) but delays closing windows and holds state longer (latency, memory). The window and grace are a business decision, not a default.

## 7. Common Mistakes & Best Practices

- **Reading state that needs upsert semantics as a KStream.** Modelling a "current price per product" as a KStream means you reprocess every historical change instead of holding the latest — it should be a KTable (compacted). Match the abstraction to whether records are *facts* or *state*.
- **Ignoring co-partitioning for joins.** Stream-stream and stream-table joins require both sides keyed the same way with the *same partition count*; otherwise matching records live on different tasks and the join silently misses. Re-key and repartition deliberately.
- **Using processing time when you mean event time.** Windowing on wall-clock time gives wrong answers whenever ingestion lags or replays happen. Extract the event timestamp (a `TimestampExtractor`) and window on it.
- **Setting grace to zero and dropping late events.** A window that closes the instant it ends discards every event that arrives even slightly late (mobile, retries, backfills). Choose a grace period that reflects real lateness.
- **Unbounded aggregation state.** A non-windowed aggregate keyed by something high-cardinality (session id, request id) grows the state store forever. Window it, or use a store with a retention/TTL, or you will exhaust disk.
- **Changing `application.id` casually.** It is the group id; changing it starts a brand-new group that reprocesses (or skips) from the offset reset, and orphans the old changelog/state. Treat it as identity, not config.
- **Forgetting standby replicas.** With `num.standby.replicas=0`, a failover must fully restore state from the changelog before processing resumes — minutes of downtime for large stores. Set standbys for hot spares.
- **Best practice:** decide *fact vs state* (KStream vs KTable) and *event time vs processing time* explicitly for every source, size partitions for your target parallelism up front, enable EOS v2 only where correctness demands it, and configure standby replicas so state failover is fast.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** The essentials are `KafkaStreams.metadataForAllStreamsClients()` and the `TopologyDescription` (`topology.describe()`), which prints the graph including the hidden repartition and changelog topics — invaluable when a join "silently misses" (usually a co-partitioning bug). For live state, **interactive queries** let you read a running state store directly (`store.get(key)`), turning the processor into a queryable materialised view. When results are wrong, the first questions are: is the timestamp extractor using event time, is grace long enough, and are the join sides co-partitioned?
- **Monitoring.** The headline metric is still **consumer lag** on the input topics (the app is a consumer group) — rising lag means you cannot keep up and need more instances or partitions. Then Streams-specific gauges: `process-rate` and `process-latency`, the RocksDB metrics (memtable/compaction, cache hit ratio), `commit-latency` (EOS transaction commit cost), and crucially **state-store restore progress** during a rebalance, because a long restore is invisible as lag but very visible as downtime. Watch task assignment for skew — one task owning a hot partition throttles the whole app.
- **Security.** Because everything is topics, security is Kafka security: TLS in transit, SASL authentication, and ACLs. Note the app needs ACLs not just on its input/output topics but on its *internal* topics — repartition and changelog topics (named `<application.id>-...`) — and on the consumer group; forgetting the internal topics is a classic "works in dev, `TopicAuthorizationException` in prod" failure (chapter 29).
- **Scaling.** Scale out by running more instances up to the input partition count; beyond that you must add partitions (which resets keyed aggregation locality, so plan partition count for peak up front). Use `num.standby.replicas` for fast failover, size RocksDB memory and disk for your state, and prefer **cooperative rebalancing** (the default in modern versions) so adding or removing an instance does not stop the whole group. If a single key is hot, no amount of instances helps — that partition is one task — so design keys to spread load.

## 9. Interview Questions

**Q: Is Kafka Streams a cluster you deploy separately?**
A: No, and this is the defining point. It is a JVM *library* you embed in your own application. There is no processing cluster, master, or resource manager. You add the `kafka-streams` dependency, define a topology with `StreamsBuilder`, and run your app as an ordinary process. All instances that share an `application.id` form a single Kafka *consumer group* and split the input partitions among their tasks, so you scale by running more instances — capped at the partition count — exactly like any consumer group. State, offsets and coordination all ride on ordinary Kafka topics and the group protocol, which is precisely why it can be just a library.

**Q: Explain the difference between a KStream and a KTable.**
A: A `KStream` is a topic read as a *record stream* — every record is an independent event with insert semantics, so two records with the same key are two facts. A `KTable` is a topic read as a *changelog* — each record upserts the latest value for its key, so a new record with an existing key replaces the old value and a null value is a tombstone (delete). Concretely, a stream of balance changes read as a KStream shows every change; read as a KTable it shows the current balance per account. You pick a KStream when each record is a fact to process and a KTable when you want the latest state per key. Underneath, a KTable is backed by a compacted topic (latest per key) and a KStream by a retained topic (all records kept).

**Q: What is the stream–table duality?**
A: The observation that a stream and a table are two views of the same information. A stream *aggregated by key* becomes a table — `groupByKey().reduce(...)` folds an event stream into the latest value per key. And a table's *changelog* is a stream — `table.toStream()` emits each update as a record. So a table is a stream folded up, and a stream is the sequence of a table's changes. Kafka Streams lets you move between them freely, which is what makes it able to express aggregation, enrichment via joins, and materialised views. It is also why Kafka is described as a database turned inside-out: the log of changes and the current-state table are the same thing seen from two directions.

**Q: What is the difference between a stateless and a stateful operation?**
A: A stateless operation processes each record in isolation and keeps no memory — `map`, `filter`, `flatMap`, `selectKey`, `branch`, `merge`. They are cheap and trivially parallel; a crash loses only the offset. A stateful operation must remember across records — `count`, `reduce`, `aggregate`, joins, and anything windowed — and its memory lives in a *state store*, by default an embedded RocksDB instance on the local disk of the instance that owns the partition. Stateful operations are more powerful but bring the cost of managing, replicating and restoring that state.

**Q: Where does state live, and how does it survive an instance crashing?**
A: State lives in a local, embedded **state store** — RocksDB by default — on the machine that owns the relevant input partition, which is what makes lookups fast (local disk, not a network hop). Every write to the store is also written to a dedicated *compacted changelog topic* in Kafka. If the instance dies, another instance takes over its partition, reads the changelog from the beginning, and rebuilds the state store exactly before resuming processing — restoring both the offset position and the accumulated state. So durability comes from the same place as everything else in Kafka Streams: an ordinary Kafka topic.

**Q: What windowing types does Kafka Streams offer?**
A: Four. **Tumbling** windows are fixed-size and non-overlapping — 5-minute buckets, each record in exactly one. **Hopping** windows are fixed-size but overlapping, defined by a size and a smaller advance — 5-minute windows advancing every minute, so a record can fall in several — useful for smoothed moving aggregates. **Session** windows are dynamic, defined by an inactivity gap: records within the gap belong to one session, and a gap of silence closes it — ideal for user-activity bursts. And **sliding** windows (mainly for joins/aggregations) group records within a fixed time difference of each other. All of them should be driven by *event time*, and they carry a *grace period* for late events.

**Q: What is exactly-once-v2 in Kafka Streams and what does it guarantee?**
A: It makes the whole consume-process-produce cycle atomic. With `processing.guarantee=exactly_once_v2`, Kafka Streams wraps reading input, updating state stores, and producing output into a single Kafka *transaction*, using the idempotent producer and transactional writes plus committing consumer offsets inside the same transaction. Either all of it commits or none does, so a failure cannot leave state advanced but output missing, or output written twice. Downstream consumers must set `isolation.level=read_committed` to see only committed results. It guarantees exactly-once *processing within the Kafka ecosystem*; a side effect to an external system (an email, a non-transactional DB write) is still your responsibility to make idempotent.

**Q: (Senior) Walk me through what co-partitioning means and why a join can silently produce wrong results without it.**
A: A join in Kafka Streams is executed per-task, and a task owns one partition (or a co-located set) of each input. For a stream-stream or stream-table join to find matching records, the records that should match must land on the *same task*, which requires the two inputs to be *co-partitioned*: keyed by the same key, using the same partitioner, and — critically — having the *same number of partitions*. If the orders topic has 6 partitions and the customers topic has 12, then `customer-42`'s orders and `customer-42`'s profile hash to different partition indexes and are owned by different tasks, so the join never sees them together and quietly emits unmatched (or null-side) results with no error. The fix is to ensure both topics share a partition count and key, or to force a repartition by re-keying and letting Streams write an internal repartition topic with the correct partitioning before the join. This is one of the most common "it compiles, it runs, the numbers are just wrong" bugs, and `topology.describe()` plus checking partition counts is how you catch it. The GlobalKTable is the escape hatch when you cannot co-partition — it replicates the entire table to every instance so any task can look up any key, at the cost of holding the whole table in memory everywhere.

**Q: (Senior) A stateful job takes ten minutes to recover after a node dies. What is happening and how do you fix it?**
A: The delay is almost certainly *state restoration*. When the failed instance's partitions are reassigned, the receiving instance cannot process until its state stores are rebuilt, and it rebuilds them by replaying the *changelog topic* for each store from the beginning. If the store is large — millions of keys, or a wide windowed aggregation — that replay is a lot of records to read and write into RocksDB, and it is serial before processing resumes, which shows up not as consumer lag but as a stall. The primary fix is **standby replicas** (`num.standby.replicas >= 1`): standbys continuously consume the changelog on other instances and keep a warm copy of the state, so on failover the promotion is near-instant instead of a cold restore. Beyond that: keep changelog topics compacted and bounded (window your aggregations so state has retention rather than growing forever), tune RocksDB and the restore consumer for throughput, size partitions so no single store is enormous, and use *static group membership* plus a sensible session timeout so a brief blip does not trigger a full reassignment at all. Prefer cooperative rebalancing so unrelated tasks are not disrupted. The mental model is that stateful stream processing trades fast steady-state (local state) for a recovery cost (restore), and standbys are how you buy the recovery cost back down.

**Q: (Senior) When would you choose Flink or ksqlDB over Kafka Streams, and vice versa?**
A: I choose Kafka Streams when the workload is JVM-native, the topology is "an application" rather than "a platform", and I value deploying it like any other microservice with no extra cluster to operate — it excels at per-service enrichment, aggregation and materialised views close to the data. I reach for **ksqlDB** when the transformations are simple enough to express in SQL and I want non-programmers or quick iterations to define streams and tables declaratively; it *is* Kafka Streams underneath, so it inherits the same model but trades code for SQL and adds its own server to run. I reach for **Apache Flink** when I need things Kafka Streams does not do well: sources and sinks beyond Kafka as first-class citizens, richer event-time and watermark semantics, very large state with tiered/remote state backends and savepoints for versioned upgrades, sophisticated CEP, or a shared multi-tenant cluster with real resource management — Flink is a full processing framework with a cluster, and that power is worth it at scale or for heterogeneous pipelines. The honest summary: Kafka Streams for "a Kafka-to-Kafka processing library embedded in my service", ksqlDB for "the same but in SQL", Flink for "a general stream-processing platform when I have outgrown a library". The deciding questions are: is it JVM, is it Kafka-to-Kafka, how big is the state, and do I want a library or a platform.

**Q: Why does re-keying a stream trigger a repartition, and why should you care?**
A: Because Kafka Streams keeps records for a key co-located on one task, and re-keying with `selectKey` or `groupBy` changes which partition a record *should* be on. To honour the new key's locality, Streams writes the re-keyed records to an internal *repartition topic* partitioned by the new key, then reads them back — a shuffle through Kafka. You should care because it is easy to trigger unknowingly (any `groupBy` on a non-key field does it), and it adds a full write-and-read round-trip to Kafka plus another internal topic to provision and secure. When a `groupByKey` on the existing key would do, prefer it; when you genuinely need a new key, do the re-key once and reuse the result rather than re-keying repeatedly.

## 10. Quick Revision & Cheat Sheet

| Concept | KStream | KTable |
|---|---|---|
| Semantics | Every record = a fact (insert) | Latest value per key (upsert) |
| Same key twice | Two independent events | Second overwrites first |
| Null value | Just a record | Tombstone (delete key) |
| Backed by | Retained topic | Compacted topic |
| Use for | Page views, payments, clicks | Prices, profiles, current state |

| Operation class | Examples | State store? |
|---|---|---|
| Stateless | map, filter, flatMap, selectKey, branch, merge | No |
| Stateful | count, reduce, aggregate, joins, windowing | Yes (RocksDB + changelog) |

| Window | Shape | Use |
|---|---|---|
| Tumbling | Fixed, non-overlapping | Per-minute counts |
| Hopping | Fixed, overlapping (size + advance) | Moving averages |
| Session | Gap-defined, dynamic | Activity bursts |

**Flash cards**
- **Library or cluster?** → Library; scale by running more instances that share partitions like a consumer group.
- **Stream–table duality?** → Aggregate a stream → a table; a table's changelog → a stream. Same data, opposite views.
- **Where is stateful state?** → Local RocksDB, made fault-tolerant by a compacted changelog topic.
- **Event vs processing time?** → Window on event time (from the record), not wall-clock, or windows go wrong.
- **What does EOS v2 guarantee?** → Consume-process-produce is one atomic Kafka transaction (state + output + offsets).
- **Why co-partition for joins?** → Matching keys must land on the same task; same key + same partition count, or the join silently misses.

## 11. Hands-On Exercises & Mini Project

- [ ] Build a topology that reads a `clicks` topic and counts clicks per user in 1-minute tumbling windows; write results to `click-counts`.
- [ ] Convert the same job to a hopping window (1-minute size, 10-second advance) and observe each click landing in multiple windows.
- [ ] Read a `prices` topic as a KTable and a `trades` stream as a KStream, and stream-table join to enrich each trade with the current price; verify only trades emit output.
- [ ] Introduce deliberately late events (event time older than the window) and show that a grace period of 30s admits them while zero grace drops them.
- [ ] Run two instances against a 4-partition input, kill one, and watch the survivor rebuild state from the changelog and resume; then add `num.standby.replicas=1` and measure the faster failover.
- [ ] Turn on `exactly_once_v2`, produce duplicates upstream, and confirm downstream `read_committed` consumers see each result once.

### Mini Project — "Real-Time Leaderboard"

**Goal.** Build a continuously-updated per-game leaderboard from a stream of score events, demonstrating stateful aggregation, windowing, the stream–table duality, and interactive queries.

**Requirements.**
1. Produce a `scores` topic of `(playerId, {game, points, eventTimeMs})` events, keyed by playerId, with a timestamp extractor reading `eventTimeMs` as event time.
2. Aggregate total points per player per game into a KTable (`aggregate` with an initializer and adder), backed by a materialised state store.
3. Add a windowed view: top scores per game in 10-minute tumbling windows with a 2-minute grace period, written to a `leaderboard-windowed` topic.
4. Expose the current leaderboard via **interactive queries** so an HTTP endpoint can read the state store directly (`store.get(playerId)`), turning the processor into a queryable materialised view.
5. Enrich each score with the player's country by stream-table joining against a compacted `players` KTable, ensuring both topics are co-partitioned.

**Extensions.**
- Enable `exactly_once_v2` and prove that a forced restart mid-processing neither double-counts nor loses points.
- Add `num.standby.replicas=1`, kill the active instance, and measure failover time with and without standbys.
- Replace the windowed count with a *session* window keyed by play session and report per-session totals.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *The Log: Offsets, Segments & Retention* (retention and compaction that back KStream/KTable), *Messaging Models: Queues vs Pub/Sub vs the Log* (why the log subsumes the rest), *Delivery Guarantees* (the exactly-once semantics EOS v2 builds on), *Kafka Connect & Change Data Capture* (getting data in and out of the topics Streams processes), *Schema Management: Avro, Protobuf & the Registry* (typed records instead of string-scraping in a topology).

- **Kafka Streams — Developer Guide** — Apache/Confluent · *Intermediate* · the authoritative reference for the DSL, state stores, windowing and EOS; the natural next read. <https://kafka.apache.org/documentation/streams/>
- **Streams and Tables in Apache Kafka** — Confluent (Michael Noll) · *Advanced* · the definitive four-part explanation of the stream–table duality with diagrams. <https://www.confluent.io/blog/kafka-streams-tables-part-1-event-streaming/>
- **Designing Data-Intensive Applications, ch. 11** — Martin Kleppmann · *Advanced* · stream processing, event time vs processing time, and the database-inside-out framing. <https://dataintensive.net/>
- **Kafka Streams in Action, 2nd ed.** — Bill Bejeck (Manning) · *Intermediate* · a full, code-first tour of topologies, joins, windowing and testing. <https://www.manning.com/books/kafka-streams-in-action-second-edition>
- **Introducing Exactly-Once Semantics in Apache Kafka** — Confluent · *Advanced* · how idempotence and transactions make EOS work, the foundation of EOS v2. <https://www.confluent.io/blog/exactly-once-semantics-are-possible-heres-how-apache-kafka-does-it/>
- **ksqlDB Documentation** — Confluent · *Intermediate* · the SQL layer over Kafka Streams; when declarative beats code. <https://docs.ksqldb.io/>
- **Apache Flink — Concepts: Stateful Stream Processing** — Apache Flink · *Advanced* · the main alternative framework, for comparing event-time, state and watermarks. <https://nightlies.apache.org/flink/flink-docs-stable/docs/concepts/stateful-stream-processing/>
- **Turning the database inside-out** — Martin Kleppmann · *Advanced* · the argument that materialised views over a log are the future, underpinning the duality. <https://www.confluent.io/blog/turning-the-database-inside-out-with-apache-samza/>

---

*Kafka & RabbitMQ Handbook — chapter 24.*
