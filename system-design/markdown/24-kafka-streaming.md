# 24 · Event Streaming & Kafka Internals

> **In one line:** Kafka is a distributed, replicated, append-only commit log — model your data as an ordered stream of immutable events and most of streaming, ordering, and exactly-once falls out of that one abstraction.

---

## 1. Overview

**Event streaming** treats data as an unbounded, ordered sequence of **immutable events** rather than a mutable table of current state. Instead of "the account balance is $100," you store the stream of deposits and withdrawals that *produced* $100. **Apache Kafka** is the dominant implementation of this idea, and its power comes from a single, humble data structure: the **append-only log**. A log is the simplest possible storage abstraction — you can only append to the end, and you read forward from a position. Everything else (topics, ordering, replication, replay, exactly-once) is engineering around that core.

Jay Kreps' essay *"The Log"* framed why this matters: a durable, ordered log is the ideal integration primitive for a distributed system. If every state change is an entry in a shared log, then databases, caches, search indexes, and analytics systems are all just different **consumers replaying the same log** into different shapes. The log becomes the source of truth and the **backbone** that decouples every producer from every consumer, in time and in throughput.

A real example: LinkedIn (where Kafka was born) and companies like Netflix and Uber run Kafka as a central nervous system moving **trillions of events per day** — clickstreams, metrics, CDC from databases, order events — feeding fraud detection, recommendations, dashboards, and data warehouses, each an independent consumer reading the same immutable streams at its own pace. This page dissects how the log delivers high throughput, strong per-partition ordering, and exactly-once semantics. See **Message Queues & Async Processing** for the broader queue-vs-log framing.

## 2. Core Concepts

- **Log** — an append-only, totally-ordered, immutable sequence of records. Writes go to the tail; reads start from any offset. This is the whole foundation.
- **Topic** — a named stream (e.g. `orders`). Logically one log, physically split into partitions.
- **Partition** — the unit of parallelism, ordering, and storage. Each partition is a *separate* ordered log; a topic's total order is only the union of its partitions' orders.
- **Offset** — a monotonically increasing integer id of a record *within a partition*. Consumers track their position by offset; Kafka does not track per-message acks.
- **Producer** — appends records, optionally with a **key** that decides the partition (`hash(key) % partitions`), guaranteeing same-key records share a partition and thus an order.
- **Consumer group** — a set of consumers that split a topic's partitions among themselves; each partition is read by exactly one consumer in the group at a time.
- **Broker** — a server holding partitions. A cluster of brokers spreads and replicates partitions.
- **Replication (leader/follower, ISR)** — each partition has one **leader** and R−1 **followers**; the **in-sync replicas (ISR)** are those caught up to the leader. Durability comes from the ISR, not raw replica count.
- **Retention & compaction** — records are kept by time/size (retention) or the log is **compacted** to keep only the latest value per key (a changelog/table view).
- **Idempotent producer + transactions** — the machinery that turns at-least-once into **exactly-once** for read-process-write pipelines.

## 3. Architecture

A topic is partitioned across brokers; each partition is replicated (leader + followers). Producers write to partition leaders; consumers in a group each own a subset of partitions and advance their offsets. Coordination (leader election, membership) is handled by ZooKeeper in older versions or **KRaft** (Kafka's own Raft quorum) in modern ones.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="390" y="22" text-anchor="middle" fill="#64748b">Topic "orders" — 3 partitions, replication factor 3</text>
  <!-- producer -->
  <rect x="16" y="70" width="110" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="71" y="97" text-anchor="middle" fill="#1e293b">Producer</text>
  <text x="71" y="132" text-anchor="middle" fill="#64748b">key→partition</text>
  <!-- brokers with partitions -->
  <rect x="180" y="45" width="200" height="120" rx="8" fill="#f8fafc" stroke="#475569"/>
  <text x="280" y="63" text-anchor="middle" fill="#64748b">Broker 1</text>
  <rect x="196" y="72" width="168" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="280" y="90" text-anchor="middle" fill="#1e293b">P0 (leader) ▸ 0 1 2 3 4</text>
  <rect x="196" y="104" width="168" height="24" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="280" y="121" text-anchor="middle" fill="#1e293b">P1 (follower)</text>
  <rect x="196" y="132" width="168" height="24" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="280" y="149" text-anchor="middle" fill="#1e293b">P2 (follower)</text>
  <rect x="180" y="180" width="200" height="120" rx="8" fill="#f8fafc" stroke="#475569"/>
  <text x="280" y="198" text-anchor="middle" fill="#64748b">Broker 2</text>
  <rect x="196" y="207" width="168" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="280" y="225" text-anchor="middle" fill="#1e293b">P1 (leader) ▸ 0 1 2 3</text>
  <rect x="196" y="239" width="168" height="24" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="280" y="256" text-anchor="middle" fill="#1e293b">P0 (follower)</text>
  <rect x="196" y="267" width="168" height="24" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="280" y="284" text-anchor="middle" fill="#1e293b">P2 (follower)</text>
  <!-- consumer group -->
  <rect x="470" y="70" width="150" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="545" y="95" text-anchor="middle" fill="#1e293b">Consumer A → P0</text>
  <rect x="470" y="145" width="150" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="545" y="170" text-anchor="middle" fill="#1e293b">Consumer B → P1</text>
  <rect x="470" y="220" width="150" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="545" y="245" text-anchor="middle" fill="#1e293b">Consumer C → P2</text>
  <text x="545" y="285" text-anchor="middle" fill="#64748b">consumer group "billing"</text>
  <!-- arrows -->
  <line x1="126" y1="88" x2="178" y2="85" stroke="#475569" marker-end="url(#ar2)"/>
  <line x1="364" y1="85" x2="468" y2="88" stroke="#475569" marker-end="url(#ar2)"/>
  <line x1="364" y1="220" x2="468" y2="165" stroke="#475569" marker-end="url(#ar2)"/>
  <line x1="640" y1="88" x2="700" y2="88" stroke="#475569" marker-end="url(#ar2)"/>
  <text x="720" y="92" text-anchor="middle" fill="#64748b">offset</text>
</svg>
```

## 4. How It Works

The read-process-write lifecycle of a record with `acks=all`:

1. **Partition select.** Producer computes the partition: `hash(key) % numPartitions` (keyed), else round-robin/sticky. Same key ⇒ same partition ⇒ preserved order.
2. **Batch & send.** The producer buffers records into a batch per partition (`linger.ms`, `batch.size`) and sends to the partition's **leader** broker — batching is where Kafka's throughput comes from.
3. **Leader append.** The leader appends the batch to its log, assigning consecutive **offsets**, and writes to the OS page cache (persisted to disk on flush).
4. **Replicate.** **Follower** replicas in the ISR pull the new records and append them. With `acks=all` the leader waits until all ISR members have the record.
5. **Ack.** The leader returns success once `min.insync.replicas` have the record. Only now is the record **committed** and visible to consumers (the **high-water mark** advances).
6. **Consume.** A consumer in a group fetches from its assigned partitions starting at its stored offset, processes records **in offset order**, and periodically **commits** its offset back to Kafka (`__consumer_offsets`).
7. **Advance / recover.** On restart or rebalance, a consumer resumes from its last committed offset — reprocessing anything after it (at-least-once) unless transactions make it exactly-once.

```text
produce ─▶ leader appends (offset n,n+1,...) ─▶ ISR followers replicate
        ─▶ acks=all & min.insync.replicas met ─▶ committed (high-water mark)
consume ─▶ fetch from committed offset ─▶ process in order ─▶ commit offset
crash   ─▶ resume from last committed offset (reprocess tail)
```

## 5. Key Components / Deep Dive

### Partitions, ordering & keys

A partition is the atom of everything. **Ordering is guaranteed only within a partition** — there is no global order across a topic. You get ordering where you need it by **choosing a key** so related events (all events for `user_42`, `account_99`) hash to the same partition. Consequences: partition count caps consumer parallelism in a group (more consumers than partitions ⇒ idle consumers); a **hot key** overloads one partition and can't be split without changing the key; and you can only *increase* partitions, which reshuffles the `hash(key) % n` mapping and breaks historical co-location — so size partitions generously up front.

### Replication: leader, followers, ISR

Each partition has a leader and R−1 followers. Producers and consumers only talk to the **leader**; followers passively replicate. The **in-sync replica set (ISR)** is the followers within `replica.lag.time.max.ms` of the leader. Durability is defined by the ISR plus **`min.insync.replicas`**: with RF=3 and `min.insync.replicas=2`, a write needs the leader + 1 follower to commit, tolerating one broker loss with zero data loss. If ISR shrinks below the minimum, the partition rejects writes (choosing consistency over availability). **`unclean.leader.election=false`** ensures a stale out-of-sync replica can never become leader (which would silently drop committed records).

### Producer acks — the durability dial

- **`acks=0`** — fire and forget; no wait. Max throughput, data loss on any hiccup. Metrics only.
- **`acks=1`** — leader-only ack. Fast, but a leader crash before replication loses committed-looking records.
- **`acks=all`** — wait for all ISR (with `min.insync.replicas`). Strongest durability; the default for anything important. Pair with `enable.idempotence=true` to also avoid duplicate appends on retry.

### Consumer groups & rebalancing

A group divides a topic's partitions among its members so each partition is consumed by exactly one member — that's how you scale reads. When a member joins/leaves/dies, the group **rebalances**: partitions are reassigned via the group coordinator. Classic **eager** rebalancing is stop-the-world (everyone pauses); **cooperative/incremental** rebalancing (KIP-429) moves only the affected partitions. Rebalances are the top operational pain — caused by slow processing tripping `max.poll.interval.ms`, so tune poll size and use **static membership** to survive brief restarts without reshuffling.

### Retention vs. compaction

- **Retention** (default): keep records for a time or size (e.g. 7 days), then delete old segments. Good for event streams you replay within a window.
- **Log compaction**: retain the **latest value per key**, garbage-collecting superseded ones. This turns a topic into a durable **changelog / table** — replay it and you rebuild current state. It's how Kafka backs `KTable`s, state stores, and `__consumer_offsets`. Tombstones (null value) delete a key.

### Exactly-once semantics (EOS)

Two mechanisms combine:
- **Idempotent producer** (`enable.idempotence=true`): each producer gets a PID and per-partition sequence numbers, so a retried batch is deduplicated by the broker — no duplicate appends from retries.
- **Transactions**: a producer wraps writes to *multiple* partitions/topics **and** its consumer-offset commit in one atomic transaction. Consumers with `isolation.level=read_committed` never see aborted or in-flight records. Together this gives **exactly-once read-process-write** entirely inside Kafka. The caveat, same as always: the instant you write to an external database or call an external API, EOS ends and you're back to idempotency at that boundary (or an outbox/transaction bridging the two).

### Stream processing basics

**Kafka Streams** / ksqlDB / Flink consume topics, transform, and produce back. Two dualities matter: a **stream** is an unbounded sequence of events; a **table** is the compacted current-state view — and you can convert between them (`stream ⇄ table`). Stateful operations (aggregations, joins, windows) keep local **state stores** backed by compacted **changelog topics**, so state survives restarts by replaying the changelog. Time is handled with **event-time windows** and **watermarks** to deal with late/out-of-order data.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Kafka (log)** | Very high throughput, replay from any offset, per-partition order, multi-consumer fan-out, retention/compaction | Ordering only per partition; heavy to operate; not a task queue (no per-msg ack/priority) |
| **Traditional MQ (RabbitMQ/SQS)** | Per-message ack/retry/DLQ, priorities, simple task semantics | No replay (delete on ack); lower throughput; limited fan-out/history |
| **`acks=all` + RF3 + minISR2** | Zero data loss on single-broker failure | Higher write latency; rejects writes when ISR too small (CP behavior) |
| **`acks=1`** | Lower latency, higher throughput | Silent loss if leader dies pre-replication |
| **Compaction** | Rebuild current state from the log; bounded storage | Loses full history (only latest per key); not for event-sourcing audit trails |
| **Retention (time/size)** | Full history within window; simple | Storage grows; replays limited to the window |

Kafka's central bet: **make writes and sequential reads cheap** (append-only + zero-copy + page cache + batching) and push ordering/parallelism onto the partition. You trade the convenience of global order and per-message semantics for throughput and replay.

## 7. When to Use / When to Avoid

**Use when:**
- Many independent consumers need the same high-volume stream (analytics, ML, search index, CDC).
- You need **replay** — reprocess history to fix a bug or bootstrap a new consumer/service.
- You want an event **backbone** decoupling dozens of producers and consumers.
- Per-key ordering at scale matters (a user's events in order, across millions of users).
- Throughput is measured in hundreds of thousands to millions of events/second.

**Avoid when:**
- You need task-queue semantics: per-message ack, priorities, delayed messages, targeted retry/DLQ — use SQS/RabbitMQ.
- You have low volume and a small team; Kafka's operational weight isn't justified.
- You need strict **global** total ordering at high throughput (single partition ⇒ no parallelism).
- Request/response, low-latency synchronous RPC is what the caller actually needs.

## 8. Scaling & Production Best Practices

- **Partition count** = target throughput ÷ per-partition throughput, and ≥ max consumers you'll ever want. Over-provision (you can only add, and adding reshuffles keys). Typical: hundreds to thousands per cluster, not millions (each has memory/file-handle cost).
- **RF=3, `min.insync.replicas=2`, `acks=all`, `unclean.leader.election=false`** — the standard durable configuration.
- **Enable idempotent producers by default** (`enable.idempotence=true`, essentially free) and use transactions for EOS pipelines.
- **Batch aggressively:** tune `linger.ms` (5–100ms) and `batch.size`; enable compression (lz4/zstd) — often 3–5× throughput.
- **Keep partitions balanced** across brokers; avoid hot keys; monitor and rebalance leadership.
- **Use cooperative rebalancing + static group membership** to minimize stop-the-world pauses on deploys.
- **Tune `max.poll.records` / `max.poll.interval.ms`** so slow processing doesn't trigger rebalances.
- **Tier storage** (Kafka tiered storage / cloud) for long retention without bloating broker disks.
- Kafka scales to **millions of msgs/s** and **GB/s** per cluster with sequential disk I/O and zero-copy — commodity disks are fine; network and page cache are usually the limits.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Leader broker dies | Partition briefly unavailable during election | RF≥3 + ISR; automatic leader election from in-sync followers |
| ISR shrinks below min.insync.replicas | Writes rejected for that partition | Alert on under-replicated partitions; add capacity; investigate slow follower |
| Unclean leader election allowed | Silent loss of committed records | `unclean.leader.election=false` (never elect a stale replica) |
| Consumer lag grows unbounded | Stale downstream data / SLA breach | Scale consumers up to partition count; add partitions; optimize processing |
| Frequent rebalances (rebalance storm) | Repeated processing pauses, duplicate work | Cooperative rebalancing, static membership, tune poll interval |
| Hot partition (skewed key) | One broker/consumer saturated | Choose a higher-cardinality key; add a salt; repartition |
| Consumer crash mid-batch | Reprocessing from last committed offset (dupes) | Idempotent processing or transactions (read_committed) |
| Disk full / retention too long | Broker outage | Size retention + tiered storage; monitor disk; quotas |
| Producer retries create duplicates | Duplicate records appended | `enable.idempotence=true` (PID + sequence dedupe) |

## 10. Monitoring & Metrics

- **Consumer lag** (records and time) per group/partition — the primary health signal.
- **Under-replicated partitions** and **offline partitions** — must be zero; nonzero = durability at risk.
- **ISR shrink/expand rate** — churn signals slow followers or network trouble.
- **Broker throughput** (bytes/messages in & out per sec) and **request latency** (produce/fetch p99).
- **Rebalance rate & duration** per consumer group.
- **Log flush latency**, **disk usage**, and **page-cache hit** behavior.
- **Producer:** batch size, record-error-rate, retries, `record-queue-time`.
- **Active controller count** = exactly 1; **unclean leader elections** = 0.

## 11. Common Mistakes

1. ⚠️ Expecting global ordering across a topic — order is per-partition only.
2. ⚠️ Under-partitioning, then discovering you can't scale consumers past partition count.
3. ⚠️ Running `acks=1` (or leaving `unclean.leader.election=true`) and being surprised by data loss on failover.
4. ⚠️ Ignoring hot keys — one partition saturates while others idle.
5. ⚠️ Treating Kafka as a task queue and hand-rolling acks/DLQs instead of using RabbitMQ/SQS.
6. ⚠️ Long, slow processing inside the poll loop triggering endless rebalances.
7. ⚠️ Assuming exactly-once extends to your external database — EOS is Kafka-internal; use idempotency/outbox at the boundary.
8. ⚠️ Compacting a topic you needed as a full audit trail — compaction throws away history.

## 12. Interview Questions

**Q: Why is an append-only log a good foundation for a streaming system?**
A: Appends are sequential (fast on disk), records are immutable (safe to share and cache), and a total order plus a read position (offset) makes replay and multi-consumer fan-out trivial. Every downstream — DB, cache, index — is just a projection of the same log, which decouples all producers from all consumers. That's the core idea in Kreps' "The Log."

**Q: Topic vs. partition vs. offset — what's the relationship?**
A: A topic is a logical stream, physically split into partitions for parallelism and storage. Each partition is an independent ordered log; an offset is a record's position *within* a partition. Ordering and consumer parallelism are properties of partitions, not topics.

**Q: How does Kafka guarantee ordering, and what are the limits?**
A: Within a single partition, records are strictly ordered by offset. Cross-partition, there's no ordering. You get per-entity order by keying records so they hash to the same partition. The cost: partition count caps parallelism and a hot key becomes a serial bottleneck.

**Q: Explain producer `acks` and the durability trade-off.**
A: `acks=0` doesn't wait (fast, lossy), `acks=1` waits for the leader only (loses data if the leader dies before followers replicate), `acks=all` waits for all in-sync replicas per `min.insync.replicas` (strongest). Production durable config is `acks=all` + RF3 + minISR2, tolerating one broker loss with no data loss.

**Q: What is the ISR and why does it matter more than replication factor?**
A: The in-sync replica set is the replicas currently caught up to the leader. Durability is defined by ISR + `min.insync.replicas`, not the raw replica count — a follower that's fallen behind doesn't count. With `unclean.leader.election=false`, only an in-sync replica can be promoted, so committed records survive failover.

**Q: How do consumer groups scale reads, and what happens during a rebalance?**
A: A group splits partitions among members, one consumer per partition, so throughput scales up to partition count. On membership change the group coordinator reassigns partitions (rebalance). Eager rebalancing pauses everyone; cooperative rebalancing moves only affected partitions. Rebalances cause processing pauses and possible reprocessing.

**Q: (Senior) Your service reprocesses events after every deploy. Diagnose and fix.**
A: Deploys trigger consumer group rebalances; if offsets aren't committed before shutdown or slow processing trips `max.poll.interval.ms`, partitions reassign and resume from the last committed offset — reprocessing the tail. Fix with graceful shutdown that commits offsets, static group membership (survive brief restarts), cooperative rebalancing, and idempotent processing so reprocessing is harmless.

**Q: (Senior) Walk me through actual exactly-once with Kafka and where it stops working.**
A: Idempotent producer (PID + per-partition sequence numbers) dedupes retried appends; transactions atomically commit writes to multiple partitions plus the consumer offset; consumers set `read_committed` to hide aborted/in-flight records. That gives exactly-once read-process-write *inside* Kafka. It stops the moment you write to an external system — the DB write and offset commit aren't in one transaction — so you need idempotency or the outbox pattern at that boundary.

**Q: (Senior) When would you compact a topic vs. use time retention, and what's the risk?**
A: Compaction keeps the latest value per key, turning the topic into a durable changelog you can replay to rebuild current state (state stores, `__consumer_offsets`, KTables). Time retention keeps full history within a window. Risk: compaction discards history, so it's wrong for audit/event-sourcing streams where every event must survive — there you want long retention or tiered storage.

**Q: (Senior) How do you choose partition count, and why is it hard to change later?**
A: Size it from target throughput ÷ per-partition throughput, and at least the max consumers you'll ever run — then over-provision. It's hard to change because you can only *add* partitions, and adding changes `hash(key) % n`, so existing keys remap to different partitions, breaking historical co-location and per-key ordering across the boundary. Getting it wrong up front is expensive.

**Q: How does Kafka achieve such high throughput on commodity hardware?**
A: Sequential append-only writes (disks are fast sequentially), batching + compression on the producer, zero-copy (`sendfile`) from page cache to socket on reads, and no per-message broker bookkeeping (consumers track their own offsets). The broker mostly moves bytes; the OS page cache does the caching. Network and page cache, not disk seeks, are the usual limits.

**Q: What's the difference between a stream and a table in stream processing?**
A: A stream is an unbounded sequence of immutable events (facts that happened); a table is the current-state view (latest value per key), materialized by folding the stream. They're duals — you compact a stream into a table, or emit a table's changes as a stream. Stateful stream apps keep tables in local state stores backed by compacted changelog topics for recovery.

## 13. Alternatives & Related

- **Message Queues & Async Processing** — the queue-vs-log framing and delivery guarantees.
- **Event-Driven Architecture, CQRS & Event Sourcing** — architectural patterns that use the log as source of truth (CDC, outbox, projections).
- **Pulsar / Pravega / Kinesis** — alternative streaming logs (segment storage, managed).
- **Flink / Kafka Streams / ksqlDB** — stream-processing engines on top of Kafka.
- **CAP & Consistency** — why `min.insync.replicas` is a CP-vs-AP tuning knob.
- **Database Scaling** — CDC from a DB into Kafka as the integration pattern.

## 14. Cheat Sheet

> [!TIP]
> **Kafka in one screen**
> - **Everything is an append-only log.** Topic = stream; **partition = ordered log** (unit of order + parallelism); **offset** = position in a partition.
> - **Order is per-partition only.** Key your records to co-locate related events; hot keys serialize.
> - **Durability:** RF=3 · `min.insync.replicas=2` · `acks=all` · `unclean.leader.election=false`. ISR (not RF) defines safety.
> - **Consumers track offsets, not acks.** A group = one consumer per partition; parallelism caps at partition count.
> - **Rebalances hurt** — use cooperative rebalancing + static membership; commit offsets on shutdown.
> - **Retention** = full history in a window; **compaction** = latest-per-key changelog (a table).
> - **EOS** = idempotent producer + transactions + `read_committed` — *inside Kafka only*; use outbox/idempotency at external boundaries.
> - **Throughput** from sequential writes + batching + zero-copy + page cache. Scales to millions/s.
> - **Watch:** consumer lag, under-replicated/offline partitions, ISR churn, rebalance rate, unclean elections = 0.

**References:** Apache Kafka documentation, "The Log: What every software engineer should know…" (Jay Kreps, LinkedIn Engineering), "Designing Data-Intensive Applications" ch. 11 (Kleppmann), Confluent engineering blog

---
*System Design Handbook — topic 24.*
