# 22 · Ordering, Partitioning & Keys

> **In one line:** Message ordering is not a global property you get for free — Kafka guarantees it only *within a partition*, the producer's *key* is what pins related messages to the same partition and therefore keeps them ordered, and the moment you demand *global* order you have chosen a single partition, a single consumer, and no parallelism — the fundamental order-versus-throughput trade that runs through all of messaging.

---

## 1. Overview

Ask an engineer "are my messages processed in order?" and the honest answer is almost always "in order *within what*?". Ordering is one of the most misunderstood properties in messaging because people imagine a topic as a single line of messages that comes out the far end in the sequence it went in. It is not. A Kafka topic is split into **partitions**, and the only ordering Kafka promises is that within *one* partition, messages are read in the exact offset order they were appended. Across partitions there is *no* ordering guarantee at all — two messages in different partitions may be processed in either order, concurrently, by different consumers. So "is the topic ordered?" is the wrong question; "which messages must stay ordered relative to each other, and are they in the same partition?" is the right one.

The lever that controls this is the **key**. When a producer sends a message with a key, Kafka hashes the key to pick a partition, and *the same key always maps to the same partition*. That single fact is the whole mechanism of ordered messaging: if you key by `user_id`, every event for a given user lands in one partition and is therefore consumed in order, while different users spread across partitions and are processed in parallel. You get *per-key* ordering and *cross-key* parallelism at the same time, which is almost always exactly what a domain needs — you rarely care that user A's events are ordered relative to user B's, only that each user's own events are in order.

The price of ordering appears when you want it *globally*, across the whole topic. Global order means every message must be in one partition (there is nowhere else to put them and keep the total order), one partition means one consumer per group can read it, and one consumer means no parallelism — your throughput is capped at what a single thread can do. This is the **order-versus-throughput trade**, and it is fundamental, not a Kafka quirk: any system that preserves a total order must serialise, and serialising is the opposite of scaling out. The engineering skill is choosing the *granularity* of ordering you actually need — per user, per account, per order — and keying to get exactly that, so you buy the minimum serialisation and keep the maximum parallelism. RabbitMQ frames the same trade differently (one queue, one consumer preserves order; competing consumers interleave; Single Active Consumer and the consistent-hash exchange recover it), and even *within* a Kafka partition, a misconfigured producer with retries and multiple in-flight requests can *reorder* — a trap this chapter closes with the idempotent producer.

## 2. Core Concepts

- **Partition** — the unit of parallelism and the *only* unit of ordering in Kafka. A topic is split into N partitions; each is an ordered, append-only log with monotonic offsets.
- **Per-partition ordering** — Kafka's guarantee: within one partition, consumers read messages in the exact order they were written. The single ordering promise Kafka makes.
- **Global (total) ordering** — a total order across the *whole* topic. Requires one partition, and therefore one consumer per group — no parallelism.
- **Key** — the field the producer attaches to a message; its hash selects the partition. Same key → same partition → ordered relative to each other.
- **Partitioner** — the function mapping key → partition. Default: `hash(key) mod partitionCount`. No key → round-robin / sticky across partitions.
- **Partition count** — the number of partitions in a topic; it sets the *maximum* consumer parallelism per group and is painful to increase (it changes key→partition mapping).
- **Consumer parallelism** — at most one consumer per partition per group; so a group's parallelism is capped at the partition count.
- **Hot partition** — a partition receiving disproportionate load because one key (or a skewed set of keys) hashes to it — a scaling bottleneck order-preservation can create.
- **Single Active Consumer (RabbitMQ)** — a queue feature where only one consumer is active at a time, preserving order even with several consumers connected (failover without interleaving).
- **Consistent-hash exchange (RabbitMQ)** — a plugin exchange that routes by hashing the routing key across bound queues, giving Kafka-like per-key ordering with per-queue parallelism.
- **max.in.flight.requests.per.connection** — how many un-acked producer batches may be in flight at once; >1 with retries can reorder *within* a partition unless the idempotent producer is enabled.
- **Idempotent producer** — `enable.idempotence=true`; sequence numbers let the broker keep in-partition order even with retries and multiple in-flight batches.

## 3. Theory & Principles

### Ordering is a per-partition property, full stop

The foundational fact: **Kafka guarantees ordering only within a partition, never across a topic.** A partition is an append-only log; a producer appends to the tail, offsets increase monotonically, and a consumer reads from a position forward. Because there is a single writer discipline per partition (the leader) and a single reader per partition per group, the sequence is deterministic: offset 5 is read after offset 4, always. That is the guarantee, and it is strong and useful.

But a topic is *several* partitions, and there is no clock or coordinator ordering messages *between* them. If message X goes to partition 0 and message Y goes to partition 1, they are on independent logs read by (potentially) different consumers at different speeds. Y may be processed before X, or after, or at the same instant. Kafka makes *no* promise about their relative order, and crucially it cannot without giving up the parallelism that partitions exist to provide. So the mental model must shift from "the topic is a line" to "the topic is a *bundle* of independent lines, and order lives inside each line, not across the bundle".

This is why "put related things in the same partition" is the entire art. If X and Y must be ordered relative to each other, they must be in the same partition — and the way you make that happen is the key.

### The key is the ordering mechanism

When a producer sends a keyed message, the default partitioner computes `partition = hash(key) mod partitionCount`. The hash is deterministic, so **the same key always lands on the same partition** (as long as the partition count does not change). Two consequences follow, and they are the reason keys matter more than almost anything else in a Kafka design:

1. **Same-key messages are ordered.** All events with `key = "user-42"` go to one partition, so they are appended and read in send order. You get a guaranteed, per-key sequence.
2. **Different-key messages parallelise.** `"user-42"` and `"user-99"` likely hash to different partitions, so they are processed concurrently by different consumers.

Choosing the key is therefore choosing *the granularity at which order is preserved*. Key by `user_id` and you get per-user order with cross-user parallelism. Key by `account_id` and you get per-account order. Key by `order_id` and each order's lifecycle (`Created → Paid → Shipped`) stays in sequence while different orders fly in parallel. The design question is always: **what is the smallest unit within which order must hold?** — and you key by exactly that unit, because a finer key gives more parallelism and a coarser key gives more serialisation. If you send *no* key, the producer spreads messages round-robin (sticky-batched in modern clients) across all partitions, maximising throughput and abandoning ordering entirely — correct for events where order does not matter, disastrous where it does.

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="k1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="k2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The key hashes to a partition &#8212; same key, same partition, ordered</text>

  <rect x="24" y="40" width="150" height="180" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="99" y="62" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">Producer</text>
  <text x="99" y="86" text-anchor="middle" fill="#1d4ed8" font-size="9">key=user-42 (A)</text>
  <text x="99" y="104" text-anchor="middle" fill="#1d4ed8" font-size="9">key=user-99 (B)</text>
  <text x="99" y="122" text-anchor="middle" fill="#1d4ed8" font-size="9">key=user-42 (A)</text>
  <text x="99" y="140" text-anchor="middle" fill="#1d4ed8" font-size="9">key=user-99 (B)</text>
  <text x="99" y="170" text-anchor="middle" fill="#1e3a8a" font-size="9">hash(key) mod 3</text>
  <text x="99" y="186" text-anchor="middle" fill="#1e3a8a" font-size="9">&#8595; deterministic</text>
  <text x="99" y="204" text-anchor="middle" fill="#1e3a8a" font-size="9" font-weight="bold">picks partition</text>

  <path d="M176,110 L230,88" stroke="#2563eb" stroke-width="2" marker-end="url(#k1)"/>
  <path d="M176,120 L230,150" stroke="#16a34a" stroke-width="2" marker-end="url(#k2)"/>

  <rect x="234" y="52" width="360" height="46" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="252" y="70" fill="#1e40af" font-size="10" font-weight="bold">Partition 0</text>
  <text x="252" y="88" fill="#1d4ed8" font-size="9">A(1) &#8594; A(2)  &#8212; user-42's events, in order</text>
  <rect x="234" y="104" width="360" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="252" y="122" fill="#15803d" font-size="10" font-weight="bold">Partition 1</text>
  <text x="252" y="140" fill="#166534" font-size="9">B(1) &#8594; B(2)  &#8212; user-99's events, in order</text>
  <rect x="234" y="156" width="360" height="46" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="252" y="174" fill="#475569" font-size="10" font-weight="bold">Partition 2</text>
  <text x="252" y="192" fill="#64748b" font-size="9">(other keys)</text>

  <rect x="622" y="52" width="234" height="46" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="739" y="80" text-anchor="middle" fill="#1e40af" font-size="10">Consumer 1 &#8592; P0 (A ordered)</text>
  <rect x="622" y="104" width="234" height="46" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="739" y="132" text-anchor="middle" fill="#15803d" font-size="10">Consumer 2 &#8592; P1 (B ordered)</text>
  <rect x="622" y="156" width="234" height="46" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="739" y="184" text-anchor="middle" fill="#475569" font-size="10">Consumer 3 &#8592; P2</text>
  <path d="M594,75 L618,75" stroke="#2563eb" stroke-width="1.5" marker-end="url(#k1)"/>
  <path d="M594,127 L618,127" stroke="#16a34a" stroke-width="1.5" marker-end="url(#k2)"/>

  <text x="234" y="222" fill="#334155" font-size="10" font-weight="bold">Per-key order (A ordered, B ordered) AND cross-key parallelism (A &#38; B concurrently). Usually exactly what you want.</text>

  <rect x="24" y="238" width="410" height="222" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="229" y="260" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Per-partition order + parallelism</text>
  <text x="44" y="284" fill="#166534" font-size="10">key by the unit order must hold within:</text>
  <text x="44" y="304" fill="#166534" font-size="10">&#8226; user_id &#8594; per-user order, users parallel</text>
  <text x="44" y="322" fill="#166534" font-size="10">&#8226; order_id &#8594; each order's lifecycle in sequence</text>
  <text x="44" y="340" fill="#166534" font-size="10">&#8226; account_id &#8594; per-account order</text>
  <text x="44" y="366" fill="#166534" font-size="10" font-weight="bold">parallelism = partition count</text>
  <text x="44" y="388" fill="#166534" font-size="10">finer key &#8594; more parallelism</text>
  <text x="44" y="406" fill="#166534" font-size="10">coarser key &#8594; more serialisation</text>
  <text x="44" y="432" fill="#15803d" font-size="10" font-weight="bold">Choose the SMALLEST unit order must hold within.</text>

  <rect x="446" y="238" width="410" height="222" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="651" y="260" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Global order: the cost</text>
  <rect x="466" y="278" width="374" height="30" rx="5" fill="#fff" stroke="#fca5a5"/><text x="653" y="297" text-anchor="middle" fill="#7f1d1d" font-size="10">1 partition (nowhere else to keep total order)</text>
  <text x="653" y="326" text-anchor="middle" fill="#b91c1c" font-size="16">&#8595;</text>
  <rect x="466" y="332" width="374" height="30" rx="5" fill="#fff" stroke="#fca5a5"/><text x="653" y="351" text-anchor="middle" fill="#7f1d1d" font-size="10">1 consumer per group (one per partition)</text>
  <text x="653" y="380" text-anchor="middle" fill="#b91c1c" font-size="16">&#8595;</text>
  <rect x="466" y="386" width="374" height="30" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="653" y="405" text-anchor="middle" fill="#7f1d1d" font-size="10" font-weight="bold">NO parallelism &#8212; throughput capped at one thread</text>
  <text x="466" y="436" fill="#991b1b" font-size="10" font-weight="bold">The order-vs-throughput trade: total order requires serialising.</text>
  <text x="466" y="453" fill="#991b1b" font-size="10">Almost always: prefer per-key order, not global.</text>
</svg>
```

### The order-versus-throughput trade

Global ordering is where the trade becomes stark and unavoidable. Suppose you genuinely need every message on a topic processed in a single total order. The only way to preserve a total order in Kafka is to keep every message in one partition — because ordering is a per-partition property and there is no cross-partition order. But a partition is read by at most one consumer per group, so one partition means one consumer, which means all processing is serial: your maximum throughput is whatever a single consumer thread can sustain, no matter how many machines you own. You have traded away the entire point of a distributed log.

This is not a defect; it is a law. *Any* system that guarantees a total order must serialise the ordered items through a single point, and a single point does not scale horizontally. So the senior instinct is to be suspicious of every claim that global order is required and to ask: is it *really* total order, or is it per-entity order dressed up as total order? Ninety-nine times out of a hundred the requirement is "each account's transactions in order" or "each order's state transitions in order", which is *per-key* order — fully parallel across keys — not global order. Reserve global ordering for the rare genuine cases (a single strict audit sequence, a leader-election log) and pay the single-partition price knowingly. Everywhere else, find the key that gives you the ordering granularity the domain needs and nothing coarser.

## 4. Architecture & Workflow

### Choosing the partition key

The workflow for getting ordering right is short and consequential:

1. **Identify the ordering unit.** For each message flow, ask "within what boundary must these be in order?" Payments per account, events per order, edits per document, clicks per session. That boundary is your key.
2. **Key by that unit.** Set the producer key to the account id / order id / document id. Now all messages for one unit share a partition and are ordered; different units parallelise.
3. **Size the partition count for parallelism.** Partition count caps consumer parallelism per group, so pick enough partitions for your target throughput plus headroom. But not *too* many keys-per-partition skew (below), and remember increasing partitions later re-maps keys and breaks historical co-location.
4. **Verify the key is not skewed.** If one key is enormously more frequent than others, its partition becomes hot (below). Check the key's cardinality and distribution before committing.

The subtle failure is choosing a key that is *correct for ordering but wrong for distribution*, or vice versa. Keying by `country` gives you per-country order but only ~200 keys and a massive skew toward a few countries — hot partitions. Keying by a random UUID gives perfect distribution but *no* useful ordering, because nothing related shares a key. The key must simultaneously (a) co-locate the messages that must be ordered and (b) spread evenly enough to avoid hot partitions — and when those two pull apart, you have a real design tension to resolve (composite keys, salting).

### Hot partitions and mitigations

A **hot partition** is one that receives far more traffic than its peers because a single key — or a few keys — dominates the load and hashes there. The consumer of that partition falls behind while others idle; you cannot fix it by adding consumers because a partition is read by only one consumer per group. Ordering *causes* this problem: you keyed to preserve order, but the key concentrated load. Mitigations, in rough order of preference:

- **Pick a higher-cardinality key.** If `country` is too coarse, key by `user_id` — more keys, more even spread, and often the ordering you actually need is per-user anyway.
- **Salt the hot key.** Append a small random suffix (`account-42#0`..`account-42#3`) to split one hot key across several partitions — but *only* if you can tolerate losing strict order within that key, because you have deliberately spread it. Often you salt only the few known-hot keys.
- **Composite key.** Key by `(account_id, region)` or `(tenant_id, entity_id)` to combine ordering scope with better distribution.
- **Custom partitioner.** Override the partitioner to route known-hot keys specially while default-hashing the rest.

The honest framing: hot partitions are the tax of ordered partitioning, and every mitigation is a negotiation between the order you promised and the spread you need.

### RabbitMQ ordering

RabbitMQ's model is different but the same trade surfaces. A **single queue consumed by exactly one consumer** preserves order — messages are delivered in the order they reached the queue (subject to requeues, below). The instant you add **competing consumers** to that queue for throughput, ordering interleaves: consumer 1 gets message 1, consumer 2 gets message 2, and if consumer 1 is slower, message 2's effect may land first. So RabbitMQ has the same order-versus-parallelism tension — one consumer preserves order, many consumers interleave.

RabbitMQ offers two tools to recover order under parallelism:

- **Single Active Consumer (SAC).** Declare the queue with `x-single-active-consumer`; several consumers may connect but only *one* is active at a time, so ordering is preserved and you get *failover* (if the active one dies, another takes over) without interleaving. This is ordered processing with high availability but no parallelism — the RabbitMQ analogue of a single-partition consumer.
- **Consistent-hash exchange.** A plugin exchange that hashes the routing key and routes to one of several bound queues, each with its own consumer — giving Kafka-like *per-key order with per-queue parallelism*. Same routing key → same queue → ordered; different keys spread across queues in parallel. This is how you get partition-style ordering in RabbitMQ.

One extra RabbitMQ subtlety: a **requeue reorders**. If a consumer `nack`s a message with requeue, it typically goes back to the *head* of the queue and is redelivered before messages behind it — but under load and with prefetch, requeues can shuffle relative order. So even a single-consumer queue is only strictly ordered if you never requeue out of band; for strict order you pair SAC with careful nack/DLQ handling.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="h1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
    <marker id="h2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Hot partitions (the tax of ordered keys) and RabbitMQ's ordering options</text>

  <rect x="24" y="40" width="410" height="220" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Hot partition: a skewed key concentrates load</text>
  <rect x="44" y="80" width="120" height="34" rx="5" fill="#fff" stroke="#fcd34d"/><text x="104" y="101" text-anchor="middle" fill="#92400e" font-size="9">key=country</text>
  <path d="M166,97 L206,84" stroke="#d97706" stroke-width="3" marker-end="url(#h1)"/>
  <path d="M166,100 L206,132" stroke="#d97706" stroke-width="1" marker-end="url(#h1)"/>
  <path d="M166,104 L206,180" stroke="#d97706" stroke-width="1" marker-end="url(#h1)"/>
  <rect x="208" y="72" width="150" height="30" rx="4" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/><text x="283" y="92" text-anchor="middle" fill="#7f1d1d" font-size="9">P0: 80% (HOT) &#8212; lag climbs</text>
  <rect x="208" y="120" width="150" height="24" rx="4" fill="#f0fdf4" stroke="#16a34a"/><text x="283" y="136" text-anchor="middle" fill="#15803d" font-size="9">P1: 10% (idle)</text>
  <rect x="208" y="168" width="150" height="24" rx="4" fill="#f0fdf4" stroke="#16a34a"/><text x="283" y="184" text-anchor="middle" fill="#15803d" font-size="9">P2: 10% (idle)</text>
  <text x="44" y="216" fill="#b45309" font-size="10" font-weight="bold">can't add consumers &#8212; 1 per partition per group</text>
  <text x="44" y="234" fill="#b45309" font-size="9">fix: higher-cardinality key &#183; salt hot key &#183; composite</text>
  <text x="44" y="250" fill="#b45309" font-size="9">key &#183; custom partitioner &#8212; each trades some order</text>

  <rect x="446" y="40" width="410" height="220" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">RabbitMQ: recovering order under parallelism</text>
  <text x="466" y="84" fill="#6d28d9" font-size="10" font-weight="bold">Single Active Consumer (order + HA, no parallelism)</text>
  <rect x="466" y="92" width="90" height="24" rx="4" fill="#fff" stroke="#c4b5fd"/><text x="511" y="108" text-anchor="middle" fill="#5b21b6" font-size="9">queue</text>
  <path d="M558,104 L594,104" stroke="#7c3aed" stroke-width="2" marker-end="url(#h2)"/>
  <rect x="596" y="92" width="110" height="24" rx="4" fill="#ddd6fe" stroke="#7c3aed"/><text x="651" y="108" text-anchor="middle" fill="#5b21b6" font-size="9">consumer 1 (ACTIVE)</text>
  <rect x="716" y="92" width="120" height="24" rx="4" fill="#f5f3ff" stroke="#c4b5fd" stroke-dasharray="3 2"/><text x="776" y="108" text-anchor="middle" fill="#7c3aed" font-size="8">consumer 2 (standby)</text>
  <text x="466" y="140" fill="#6d28d9" font-size="10" font-weight="bold">Consistent-hash exchange (per-key order + parallel)</text>
  <rect x="466" y="150" width="100" height="24" rx="4" fill="#fff" stroke="#c4b5fd"/><text x="516" y="166" text-anchor="middle" fill="#5b21b6" font-size="8">x-consistent-hash</text>
  <path d="M568,156 L600,150" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#h2)"/>
  <path d="M568,164 L600,182" stroke="#7c3aed" stroke-width="1.5" marker-end="url(#h2)"/>
  <rect x="602" y="140" width="120" height="20" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="662" y="154" text-anchor="middle" fill="#5b21b6" font-size="8">queue A &#8594; consumer A</text>
  <rect x="602" y="172" width="120" height="20" rx="3" fill="#ddd6fe" stroke="#7c3aed"/><text x="662" y="186" text-anchor="middle" fill="#5b21b6" font-size="8">queue B &#8594; consumer B</text>
  <text x="466" y="214" fill="#6d28d9" font-size="9">same routing key &#8594; same queue &#8594; ordered; keys spread</text>
  <text x="466" y="230" fill="#6d28d9" font-size="9">across queues &#8594; parallel &#8212; like Kafka partitions</text>
  <text x="466" y="250" fill="#5b21b6" font-size="9" font-weight="bold">competing consumers on one queue = interleaving!</text>

  <rect x="24" y="276" width="832" height="150" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="298" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The key must do two jobs at once &#8212; and they can pull apart</text>
  <rect x="48" y="314" width="380" height="44" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="238" y="334" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">Job 1: CO-LOCATE what must stay ordered</text>
  <text x="238" y="350" text-anchor="middle" fill="#166534" font-size="9">same key &#8594; same partition &#8594; sequenced</text>
  <rect x="452" y="314" width="380" height="44" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="642" y="334" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">Job 2: SPREAD evenly across partitions</text>
  <text x="642" y="350" text-anchor="middle" fill="#1d4ed8" font-size="9">high cardinality &#8594; no hot partition</text>
  <text x="48" y="382" fill="#475569" font-size="10">Keying by country co-locates well but has ~200 skewed values &#8594; hot partition. A random UUID spreads perfectly</text>
  <text x="48" y="400" fill="#475569" font-size="10">but co-locates nothing &#8594; no useful order. When the two jobs conflict: composite keys, or salt only the known-hot keys.</text>
  <text x="48" y="420" fill="#334155" font-size="10" font-weight="bold">Pick the key that co-locates the ordering unit AND spreads evenly; resolve the tension deliberately, not by accident.</text>
</svg>
```

## 5. Implementation

Two Go implementations: a Kafka producer showing that keying pins messages to a partition (and the ordering guarantee that gives), and a RabbitMQ consistent-hash setup showing per-key ordering with per-queue parallelism. Kafka uses `github.com/segmentio/kafka-go`, RabbitMQ uses `github.com/rabbitmq/amqp091-go`.

```go
package ordering

import (
	"context"
	"fmt"
	"log"

	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/segmentio/kafka-go"
)

// -----------------------------------------------------------------------------
// KAFKA: keyed partitioning gives per-key ordering + cross-key parallelism.
// -----------------------------------------------------------------------------

// NewOrderedWriter builds a producer that preserves in-partition order EVEN under
// retries. The two settings that matter for ordering are hidden inside kafka-go:
// it uses an idempotent-style hashing balancer for keys, and we set MaxAttempts
// plus require acks=all so a retried batch cannot be silently reordered or lost.
func NewOrderedWriter(brokers []string, topic string) *kafka.Writer {
	return &kafka.Writer{
		Addr:  kafka.TCP(brokers...),
		Topic: topic,
		// Hash balancer: partition = hash(key) mod partitionCount. The SAME key
		// therefore ALWAYS maps to the same partition — the ordering mechanism.
		Balancer: &kafka.Hash{},
		// acks=all: the leader waits for the in-sync replicas. Combined with the
		// broker-side idempotent producer (enable.idempotence, default on modern
		// brokers) this keeps in-partition order across retries. Without it,
		// retrying a failed batch while a later batch already landed REORDERS.
		RequiredAcks: kafka.RequireAll,
		// Bound retries; with the idempotent producer these retries do not reorder.
		MaxAttempts: 5,
	}
}

// PublishOrderEvents sends an order's lifecycle events KEYED BY ORDER ID, so all
// events for one order share a partition and are consumed in sequence, while
// different orders spread across partitions and are processed in parallel.
func PublishOrderEvents(ctx context.Context, w *kafka.Writer, orderID string, events []string) error {
	msgs := make([]kafka.Message, 0, len(events))
	for _, e := range events {
		msgs = append(msgs, kafka.Message{
			// KEY = orderID. This is the whole ordering decision in one line:
			// every event for this order goes to the same partition, so
			// Created -> Paid -> Shipped is guaranteed to be read in that order.
			Key:   []byte(orderID),
			Value: []byte(e),
		})
	}
	// A single WriteMessages call keeps these in order within the batch; because
	// they share a key they share a partition, so their offsets are contiguous.
	if err := w.WriteMessages(ctx, msgs...); err != nil {
		return fmt.Errorf("write order %s: %w", orderID, err)
	}
	return nil
}

// ConsumePartitionInOrder reads ONE partition strictly in offset order. Within a
// consumer group, this partition is owned by exactly one consumer, so there is
// exactly one reader advancing through it — that single-reader-per-partition rule
// is what makes per-partition order a guarantee and not a hope.
func ConsumePartitionInOrder(ctx context.Context, brokers []string, topic, group string, handle func(kafka.Message) error) error {
	r := kafka.NewReader(kafka.ReaderConfig{
		Brokers: brokers,
		Topic:   topic,
		GroupID: group, // group => partitions divided across members, 1 consumer/partition
	})
	defer r.Close()
	for {
		m, err := r.FetchMessage(ctx)
		if err != nil {
			return err
		}
		// Messages arrive in offset order within a partition; handle them serially
		// to PRESERVE that order. Fanning these out to a worker pool would break it.
		if err := handle(m); err != nil {
			return err // do not commit; redeliver and retry (chapter 23)
		}
		if err := r.CommitMessages(ctx, m); err != nil {
			return err
		}
	}
}

// -----------------------------------------------------------------------------
// RABBITMQ: the consistent-hash exchange gives per-key order with per-queue
// parallelism — the RabbitMQ analogue of Kafka's keyed partitioning.
// -----------------------------------------------------------------------------

// SetupConsistentHash declares an x-consistent-hash exchange bound to several
// queues. The exchange hashes the routing key and routes each message to ONE
// bound queue, so the same routing key always hits the same queue (ordered),
// while different keys spread across queues (parallel) — like partitions.
func SetupConsistentHash(ch *amqp.Channel, exchange string, queues []string) error {
	// The consistent-hash exchange type is provided by the
	// rabbitmq_consistent_hash_exchange plugin (enable it first).
	if err := ch.ExchangeDeclare(
		exchange, "x-consistent-hash", true, false, false, false, nil,
	); err != nil {
		return fmt.Errorf("declare exchange: %w", err)
	}
	for _, q := range queues {
		if _, err := ch.QueueDeclare(q, true, false, false, false, nil); err != nil {
			return fmt.Errorf("declare queue %s: %w", q, err)
		}
		// The binding key "1" is the weight: each queue gets an equal share of the
		// hash ring. Higher weights bias more keys onto a queue.
		if err := ch.QueueBind(q, "1", exchange, false, nil); err != nil {
			return fmt.Errorf("bind %s: %w", q, err)
		}
	}
	return nil
}

// PublishHashed sends a message whose ROUTING KEY is the ordering unit (e.g. the
// account id). The exchange hashes it to one queue, so all messages for that
// account are ordered within that queue, and different accounts parallelise.
func PublishHashed(ch *amqp.Channel, exchange, orderingKey string, body []byte) error {
	return ch.Publish(exchange, orderingKey, false, false, amqp.Publishing{
		DeliveryMode: amqp.Persistent, // survive a broker restart
		Body:         body,
	})
}

// SetupSingleActiveConsumer declares a queue where only ONE consumer is active at
// a time. Several consumers may connect (for failover), but RabbitMQ delivers to
// just one, preserving order without interleaving — ordered processing with HA
// but no parallelism, the analogue of a single-partition consumer.
func SetupSingleActiveConsumer(ch *amqp.Channel, queue string) error {
	_, err := ch.QueueDeclare(queue, true, false, false, false, amqp.Table{
		"x-single-active-consumer": true, // key ordering setting
	})
	if err != nil {
		return fmt.Errorf("declare SAC queue: %w", err)
	}
	return nil
}

func mustHash() { log.Println("hash balancer keeps same-key messages co-located") }
```

The Kafka side shows the essential move — `Key: []byte(orderID)` — and the essential constraint: handle a partition's messages *serially* to preserve the order that keying bought, because fanning them to a worker pool would reorder within the partition. The RabbitMQ side shows both recovery tools: the consistent-hash exchange for per-key order with parallelism, and Single Active Consumer for strict order with failover but no parallelism.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Per-key ordering with parallelism.** Keying gives a strict order within each entity while different entities process concurrently — the sweet spot most domains actually need.
- **Deterministic co-location.** The same key always maps to the same partition, so related messages are guaranteed to be handled by the same consumer in sequence.
- **Tunable granularity.** The key choice directly sets how much you serialise versus parallelise; finer keys buy more throughput.
- **Broker-native.** Kafka's partitions and RabbitMQ's consistent-hash exchange implement this without application-level sequencing.

**Disadvantages**
- **Global order kills parallelism.** Total order forces a single partition and a single consumer — throughput capped at one thread.
- **Hot partitions.** A skewed key concentrates load on one partition that you cannot parallelise, while others idle.
- **Partition count is sticky.** Increasing partitions re-maps keys, breaking historical co-location and any ordering assumptions built on it.
- **Reordering traps.** In Kafka, retries with multiple in-flight requests reorder within a partition unless the idempotent producer is on; in RabbitMQ, requeues and competing consumers reorder.

**Trade-offs**
- *Order vs throughput:* the fundamental trade — any total order must serialise, and serialising does not scale out. Global order is expensive; per-key order is cheap.
- *Ordering co-location vs even distribution:* a key must both group the messages that must stay ordered and spread evenly to avoid hot partitions; when those pull apart, you compromise with composite keys or salting.
- *Parallelism vs strict order (RabbitMQ):* one consumer or Single Active Consumer preserves order with no parallelism; competing consumers or the consistent-hash exchange add parallelism at the cost of strict global order.
- *Partition count now vs later:* too few caps throughput; too many raises overhead and skew risk, and changing it later is disruptive — a capacity decision to get roughly right early.

## 7. Common Mistakes & Best Practices

- **Assuming a topic is globally ordered.** It is not — order is per-partition. Two messages on different partitions have no defined relative order. Reason about "ordered within what?".
- **Demanding global order when per-key order suffices.** "Process everything in order" is almost always "process each account/order/user in order". Insisting on true global order needlessly caps you at one consumer.
- **Sending no key where order matters.** No key means round-robin across partitions and no ordering. If related messages must be sequenced, they must share a key.
- **Fanning a partition's messages to a worker pool.** Consuming a partition and dispatching its messages to concurrent workers reorders them, silently discarding the guarantee keying gave you. Process a partition serially.
- **Keying by something skewed.** Keying by `country` or `tenant` when one value dominates creates a hot partition you cannot parallelise. Check cardinality and distribution before choosing a key.
- **Leaving max.in.flight > 1 with retries and no idempotent producer.** A retried batch can be appended *after* a later batch that already succeeded, reordering within the partition. Enable `enable.idempotence=true`.
- **Adding competing consumers to a RabbitMQ queue that needs order.** Competing consumers interleave. Use Single Active Consumer for strict order, or the consistent-hash exchange for per-key order with parallelism.
- **Best practice:** identify the smallest unit within which order must hold, key by exactly that unit, size partitions for throughput with headroom, verify the key is not skewed, and turn on the idempotent producer so in-partition order survives retries — reserving true global order for the rare cases that genuinely require it.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Out-of-order *effects* usually trace to one of three causes: messages that should share a key do not (check the producer's key logic), a partition being consumed by a worker pool instead of serially, or reordering from retries without the idempotent producer. To confirm order is preserved, log `(partition, offset)` at consume time and assert monotonic offsets per partition; if offsets are monotonic but effects are out of order, the reorder is in your handler, not Kafka. In RabbitMQ, check for competing consumers on an order-sensitive queue and for requeues.
- **Monitoring.** Watch **per-partition consumer lag**, not just aggregate lag — a hot partition shows as one partition's lag climbing while others stay flat, the signature of key skew. Track **partition throughput distribution**; a healthy topic has roughly even bytes/sec per partition. A widening spread is an early hot-partition warning. In RabbitMQ, monitor per-queue depth across the consistent-hash queues for the same skew signal.
- **Security.** The key can leak information — if you key by a user identifier and partitions are observable (via metrics or ACLs per partition), the key choice may expose which entity is active. More practically, per-topic authorization is the control surface; partitions inherit the topic's ACL, so you cannot grant per-partition access. Do not encode secrets in keys, since keys are stored in the clear and often logged.
- **Scaling.** Partition count sets the ceiling on consumer parallelism per group, so scaling consumers past the partition count does nothing — idle consumers. Plan partitions for peak parallelism plus headroom, knowing that raising the count later re-maps keys and breaks co-location (so over-provision modestly rather than under-provision). To scale a hot partition, change the *key* (higher cardinality) or salt the hot key, since you cannot add consumers to one partition. In RabbitMQ, scale by adding queues to the consistent-hash exchange (which re-shards keys) or by adding competing consumers where strict order is not required.

## 9. Interview Questions

**Q: What ordering does Kafka actually guarantee?**
A: Ordering within a single partition, and nothing more. Within one partition, messages are appended and read in strict offset order, so a consumer sees offset 4 before offset 5, always. Across partitions there is no ordering guarantee at all — two messages on different partitions may be processed in either order or concurrently, because partitions are independent logs read by potentially different consumers. So a topic is not a single ordered line; it is a bundle of independent ordered lines, and order lives inside each line, not across the bundle. The practical consequence is that if two messages must be ordered relative to each other, they must be in the same partition.

**Q: How does the key control ordering?**
A: When a producer sends a keyed message, the default partitioner computes `partition = hash(key) mod partitionCount`, and because the hash is deterministic, the same key always maps to the same partition. That means all messages with the same key land in one partition and are therefore read in send order — per-key ordering — while messages with different keys spread across partitions and are processed in parallel. Choosing the key is choosing the granularity at which order is preserved: key by `user_id` for per-user order, by `order_id` for per-order order. A finer key gives more parallelism; a coarser key gives more serialisation; no key gives round-robin distribution and no ordering.

**Q: Why does global ordering eliminate parallelism?**
A: Because ordering in Kafka is a per-partition property, the only way to keep a *total* order across a whole topic is to put every message in a single partition — there is nowhere else to put them without losing the total order. But a partition is read by at most one consumer per group, so a single partition means a single consumer, which means processing is serial and throughput is capped at what one thread can do, regardless of how many machines you have. This is the order-versus-throughput trade, and it is a law rather than a limitation: any system that guarantees a total order must funnel the ordered items through one serial point, and a serial point does not scale horizontally.

**Q: What is a hot partition and how do you fix it?**
A: A hot partition is one receiving far more load than its peers because a single key, or a small set of keys, dominates the traffic and hashes to that partition. Its consumer falls behind while others idle, and you cannot fix it by adding consumers because a partition is read by only one consumer per group. The fixes all involve the key: choose a higher-cardinality key so load spreads more evenly (often the per-entity order you get is what you needed anyway); salt the hot key with a small random suffix to split it across partitions, if you can tolerate losing strict order within that key; use a composite key that combines ordering scope with better distribution; or write a custom partitioner that routes known-hot keys specially. Every fix is a negotiation between the order you promised and the spread you need.

**Q: How does RabbitMQ preserve ordering, and where does it break?**
A: A single queue consumed by exactly one consumer preserves order — messages are delivered in the order they reached the queue. Order breaks the moment you add competing consumers for throughput: consumer 1 takes message 1 and consumer 2 takes message 2, and if consumer 1 is slower, message 2's effect can land first, so the effects interleave. RabbitMQ offers two recoveries: Single Active Consumer, where several consumers connect but only one is active at a time, preserving order with failover but no parallelism; and the consistent-hash exchange, which hashes the routing key to route each message to one of several bound queues, giving per-key order with per-queue parallelism, the analogue of Kafka partitions. A further subtlety is that requeues can reorder even a single-consumer queue, so strict order also requires careful nack handling.

**Q: What is Single Active Consumer and when would you use it?**
A: Single Active Consumer is a RabbitMQ queue feature, enabled with `x-single-active-consumer`, where multiple consumers may be connected to a queue but only one is active and receiving messages at any time; if the active consumer dies, RabbitMQ promotes another. You use it when you need strictly ordered processing of a queue together with high availability, but do not need parallelism — for example a queue of state transitions for a single aggregate that must be applied in order. It is the RabbitMQ analogue of a single-partition Kafka consumer: order preserved, failover provided, throughput limited to one consumer.

**Q: (Senior) A stakeholder says every event must be processed in strict order. How do you interrogate and design for that?**
A: I would push hard on the word "order", because true global order is expensive and almost never what is actually required. I would ask: ordered relative to *what*? If the answer is "each customer's events in order" or "each order's transitions in order", that is per-key order, not global order, and I get it for free by keying on the customer or order id — strict within each entity, fully parallel across entities, no throughput penalty. Only if the answer is a genuine single total sequence — a strict audit log, a replicated state-machine command log, a ledger that must have one canonical order across all accounts — do I accept global ordering, and then I design for a single partition and a single active consumer, knowing throughput is capped at one thread and sizing the work per message accordingly (batching, keeping the handler cheap, offloading heavy work downstream where order no longer matters). I would also document the cost explicitly, because "strict order" is often stated casually and, once the single-consumer throughput ceiling is understood, the requirement frequently relaxes to per-key order. The design skill is matching the ordering granularity to the real domain boundary and refusing to serialise more than the domain actually demands.

**Q: (Senior) Explain how a Kafka producer can reorder messages within a single partition, and how to prevent it.**
A: This surprises people because per-partition order is supposed to be guaranteed, but the producer can violate it before the broker ever sees a stable sequence. The mechanism is retries combined with multiple in-flight requests. With `max.in.flight.requests.per.connection` greater than one, the producer can have several batches to the same partition outstanding at once. Suppose batch 1 and batch 2 are both in flight, batch 1 fails transiently and is retried, but batch 2 succeeded in the meantime — the retried batch 1 is now appended *after* batch 2, reordering them within the partition. The classic blunt fix was to set `max.in.flight.requests.per.connection=1`, which serialises and hurts throughput. The modern fix is the idempotent producer, `enable.idempotence=true` (the default on current brokers), which tags each record with a producer id and a monotonic sequence number per partition; the broker uses the sequence numbers to detect and reject out-of-order or duplicate batches, so it preserves in-partition order and deduplicates retries even with up to five in-flight requests. So the correct configuration for ordered, high-throughput producing is the idempotent producer with `acks=all`, not throttling in-flight requests to one. I always check this setting when investigating out-of-order effects that survive correct keying.

**Q: (Senior) How do partition count and key choice interact, and what makes them hard to change later?**
A: Partition count and key choice together determine both your ordering granularity and your parallelism ceiling, and they are coupled through the partitioner. The key sets *which* messages must stay together; the partition count sets *how many* independent streams there are and therefore the maximum consumer parallelism per group. The difficulty is that the default partitioner computes `hash(key) mod partitionCount`, so the partition a key maps to depends on the partition count — which means increasing the partition count re-maps existing keys to different partitions. Any historical co-location breaks: messages for key K that used to be in partition 3 now hash to partition 7, so K's old and new messages are split across two partitions and their relative order is lost across the boundary, and any consumer state keyed by partition is invalidated. That is why partition count is effectively sticky and must be sized with headroom up front — enough partitions for peak parallelism plus growth, but not so many that per-partition overhead and skew rise. If I truly must repartition later, I do it deliberately: create a new topic with the new partition count, reprocess or dual-write into it, and cut consumers over, rather than mutating a live topic's partition count and silently breaking ordering. The interaction is the single most consequential early decision in a Kafka design, because it is cheap to get right at design time and expensive to change in production.

**Q: If two messages have different keys, can you rely on the order they were sent?**
A: No. Different keys generally hash to different partitions, and there is no ordering guarantee across partitions, so even though you sent message X (key A) before message Y (key B), the consumers of their respective partitions may process Y before X, or concurrently. If the domain requires X to be processed before Y, they must share a key so they share a partition — otherwise you must enforce the dependency in application logic (for example, Y's handler checks that X's effect is present, or you model both under a common entity key). Relying on send order across keys is one of the most common ordering bugs, because it works by luck in low-traffic testing and fails under real concurrency.

## 10. Quick Revision & Cheat Sheet

| Concept | Kafka | RabbitMQ |
|---|---|---|
| Order guarantee | Within a partition only | Within one queue, one consumer |
| Ordering mechanism | Key → `hash(key) mod N` → partition | Consistent-hash exchange (routing key) |
| Per-key order + parallelism | Key by the ordering unit | Consistent-hash exchange to N queues |
| Strict order + HA, no parallelism | Single partition, one consumer | Single Active Consumer |
| Parallelism cap | Partition count (per group) | Number of hash queues / consumers |
| Reorder trap | Retries + in-flight >1 without idempotence | Competing consumers; requeues |

| Key choice | Effect |
|---|---|
| No key | Round-robin, max throughput, NO order |
| Fine key (user_id) | Per-user order, high parallelism |
| Coarse key (country) | Few keys → hot partitions, low parallelism |
| Random key | Perfect spread, no useful ordering |

**Flash cards**
- **What ordering does Kafka guarantee?** → Per-partition only; never across a topic.
- **What pins messages to a partition?** → The key: `hash(key) mod partitionCount`, deterministic.
- **Cost of global ordering?** → One partition → one consumer → no parallelism (order-vs-throughput).
- **How to choose the key?** → The smallest unit within which order must hold.
- **What is a hot partition?** → A skewed key concentrating load on one partition you can't parallelise.
- **How does a producer reorder within a partition?** → Retries + in-flight >1; fix with the idempotent producer (`enable.idempotence=true`).

## 11. Hands-On Exercises & Mini Project

- [ ] Produce an order's lifecycle events keyed by `order_id` and confirm all land in one partition (log the partition) and are consumed in sequence.
- [ ] Produce the same events with *no* key and observe them spread across partitions and consumed out of order.
- [ ] Consume one partition serially versus fanning its messages to a worker pool, and demonstrate the worker pool reorders the effects.
- [ ] Deliberately key by a skewed field (e.g. one dominant tenant) and watch one partition's lag climb while others idle; then re-key by a higher-cardinality field and watch it even out.
- [ ] Set `max.in.flight.requests.per.connection` high with retries and no idempotence, inject a transient failure, and try to observe a reorder within a partition; then enable the idempotent producer and confirm order holds.
- [ ] In RabbitMQ, add a second competing consumer to an order-sensitive queue and observe interleaving; then switch to a consistent-hash exchange and confirm per-key order returns.

### Mini Project — "Per-Key Order at Throughput"

**Goal.** Build a pipeline that preserves per-entity ordering while processing many entities in parallel, and prove where ordering holds and where it breaks, on both Kafka and RabbitMQ.

**Requirements.**
1. Create a Kafka topic with several partitions and a producer that keys events by an entity id; verify per-key order with a monotonic-sequence check per key at the consumer.
2. Add a second entity and show the two entities are processed concurrently (interleaved across partitions) while each remains internally ordered.
3. Introduce a hot key, observe the hot partition, and mitigate it by salting the key across N sub-keys, documenting the order you gave up.
4. Reproduce the retry-reordering trap and fix it with the idempotent producer plus `acks=all`.
5. Implement the same per-key order on RabbitMQ with a consistent-hash exchange, and separately demonstrate strict order with Single Active Consumer.

**Extensions.**
- Force a genuine global-order requirement onto a single partition and measure the throughput ceiling versus the multi-partition per-key design.
- Simulate a partition-count increase on a live topic and demonstrate the broken co-location for existing keys; then do it the safe way via a new topic and cutover.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *The Log: Offsets, Segments & Retention* (why a partition is an ordered append-only log), *Design: Consumers, Groups, Offsets & Rebalancing* (one consumer per partition per group, the basis of per-partition order), *Idempotency, Deduplication & the Outbox Pattern* (keeping a key's events ordered through the relay), *Backpressure, Flow Control & Poison Messages* (why a partition's serial processing makes a poison message block everything behind it), *Producers: Batching, Acks & the Idempotent Producer* (the settings that keep in-partition order under retries).

- **Apache Kafka — Design: partitioning & ordering** — Apache · *Intermediate* · the source on per-partition ordering, keys and the partitioner. <https://kafka.apache.org/documentation/#intro_concepts_and_terms>
- **How to choose the number of topics/partitions in a Kafka cluster** — Jun Rao (Confluent) · *Advanced* · partition count, parallelism and the cost of getting it wrong. <https://www.confluent.io/blog/how-choose-number-topics-partitions-kafka-cluster/>
- **Kafka Producer — enable.idempotence & max.in.flight** — Confluent docs · *Advanced* · exactly how the idempotent producer preserves in-partition order under retries. <https://docs.confluent.io/platform/current/installation/configuration/producer-configs.html>
- **RabbitMQ — Consistent Hash Exchange** — RabbitMQ · *Advanced* · the plugin that gives partition-like per-key ordering across queues. <https://github.com/rabbitmq/rabbitmq-server/tree/main/deps/rabbitmq_consistent_hash_exchange>
- **RabbitMQ — Single Active Consumer** — RabbitMQ · *Intermediate* · ordered processing with failover and no interleaving. <https://www.rabbitmq.com/docs/consumers#single-active-consumer>
- **Designing Data-Intensive Applications, ch. 5 & 11** — Martin Kleppmann · *Advanced* · partitioning, ordering guarantees and the order-versus-throughput tension in depth. <https://dataintensive.net/>
- **Hot partitions and key skew** — Confluent blog · *Intermediate* · diagnosing and mitigating skewed keys and hot partitions. <https://www.confluent.io/blog/>
- **The Log: What every software engineer should know** — Jay Kreps · *Advanced* · why the log's total order per partition is the foundational ordering abstraction. <https://engineering.linkedin.com/distributed-systems/log-what-every-software-engineer-should-know-about-real-time-datas-unifying>

---

*Kafka & RabbitMQ Handbook — chapter 22.*
