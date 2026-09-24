# 12 · Sharding: Shard Keys, Rebalancing & Cross-Shard Pain

> **In one line:** Sharding solves a capacity problem — more data, writes or working set than one machine can hold — by creating distributed-systems problems: routing, skew, rebalancing, cross-shard queries and transactions, global identity and partial failure; the shard key decides how many of those you will actually feel.

---

## 1. Overview

A single PostgreSQL primary can go a very long way: tens of terabytes, tens of thousands of writes per second, hundreds of thousands of reads per second with replicas and caching. [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) walks the ladder — indexes, pooling, caching, read replicas, partitioning, vertical scaling — and sharding is the rung you climb when every rung below it is exhausted. The trigger is almost always one of three things: the **write rate** (WAL generation, checkpoint I/O, a single primary's CPU) cannot keep up; the **working set** no longer fits in the largest affordable machine's memory; or the **dataset** is so large that operations — a restore, a major-version upgrade, building an index — take days.

Sharding answers all three by splitting rows across N independent databases, each owning a subset of keys. Every shard is a normal database with its own primary, replicas, WAL and failure domain. Capacity scales roughly linearly with N — *for queries that touch one shard*.

The catch is that you have turned one database into a distributed system, and every guarantee the single node gave you for free now has to be rebuilt or given up:

- **A join or aggregate** across shards becomes a scatter-gather through a router, with latency set by the slowest shard.
- **A transaction** touching two shards needs two-phase commit or a saga ([Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions)).
- **A unique constraint or a sequence** no longer exists globally; you need a global ID scheme.
- **Adding capacity** means moving live data between machines without losing writes.
- **Load** is only as even as your key's distribution — one celebrity user or one enterprise tenant can melt one shard while the rest idle.

That is the thesis: *sharding solves capacity by introducing distributed-systems problems.* A good shard key minimises how often you hit them; a bad one makes every query a distributed query. The naive approaches fail predictably: `hash(id) % N` makes adding the (N+1)th shard move nearly everything; sharding by time makes one shard absorb all writes; sharding by a column most queries don't filter on makes every read a fan-out.

> **Builds on:** [SQL Handbook · Partitioning & Sharding](../sql/topic.html?p=23-partitioning) (partitioning vs sharding, the basic strategies) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) (single-node partitioning, key choice) · [Ch 09 · Replication](topic.html?p=09-replication) (each shard is itself replicated) · [System Design · Database Scaling](../system-design/topic.html?p=16-database-scaling) and [System Design · Consistent Hashing](../system-design/topic.html?p=17-consistent-hashing) (the ring and virtual nodes, which this chapter does not re-derive). This chapter goes into shard-key design, logical shards, live resharding, hot shards, cross-shard work and global IDs.

## 2. Core Concepts

- **Shard** — an independent database (primary + replicas) owning a subset of the keyspace. *Why it matters:* it is also a failure domain; losing one shard is a partial outage.
- **Shard key (distribution column)** — the column that decides placement. *Why it matters:* queries carrying it route to one shard; queries without it fan out to all.
- **Logical shard / bucket** — a fixed, large number of virtual partitions (e.g. 1,024 or 4,096) mapped onto fewer physical servers. *Why it matters:* rebalancing moves whole buckets without rehashing keys.
- **Routing layer** — the component that maps key → shard: a client library, a proxy (Vitess VTGate, mongos), or a coordinator (Citus). *Why it matters:* it must be fast, correct during migrations, and never a single point of failure.
- **Directory (lookup) sharding** — an explicit table mapping key (or tenant) → shard. *Why it matters:* lets you place and move individual hot tenants, at the cost of a lookup and a critical metadata store.
- **Co-location** — rows that are joined together live on the same shard because they share a shard key (orders and order_items by `customer_id`). *Why it matters:* co-located joins and transactions stay local.
- **Reference (broadcast) table** — a small table replicated to every shard (countries, plans). *Why it matters:* joins against it stay single-shard.
- **Scatter-gather** — sending a query to every shard and merging results. *Why it matters:* cost and tail latency scale with shard count.
- **Hot shard** — a shard receiving disproportionate load due to key skew. *Why it matters:* your capacity is capped by the hottest shard, not the average.
- **Resharding** — changing the number of shards or the key→shard mapping while serving traffic. *Why it matters:* the riskiest routine operation in a sharded system.
- **Global ID** — an identifier unique across all shards without coordination on every insert (UUIDv7, Snowflake, ticket servers). *Why it matters:* per-shard sequences collide.

## 3. Theory & Principles

### Choosing a shard key

A shard key has to satisfy five properties at once, and the art is deciding which one you trade away.

1. **Present in the dominant queries.** Rank queries by frequency × cost. The key must appear in the WHERE clause of the queries that make up most of the load, or they all fan out.
2. **High cardinality.** `country` has ~200 values — you can never have more than 200 useful shards, and the US shard will be enormous. `user_id` has millions.
3. **Even distribution of load, not just rows.** One tenant with 30% of traffic makes its shard hot even if row counts look balanced.
4. **Co-locates what must be atomic or joined.** If an order and its items and its payment must commit together, they should share the key.
5. **Immutable.** Changing a row's shard key means moving it between databases — a delete on one and an insert on another, not an `UPDATE`.

For multi-tenant SaaS, `tenant_id` usually wins all five (except distribution, handled by isolating whales). For consumer apps, `user_id` is typical — but "a user's feed" involves other users' posts, which is why feeds are materialised per reader instead of joined at read time. For marketplaces there is often **no single key**: orders are queried by buyer *and* by seller. The usual answer is to shard by one (buyer) and maintain a second, asynchronously-updated copy or index keyed by the other (seller) — accepting eventual consistency on the secondary access path.

### Hash, range, directory — and why databases prefer logical shards

| Strategy | Mapping | Strength | Weakness |
|---|---|---|---|
| Hash mod N | `hash(k) % N` | Even spread, trivial routing | Changing N remaps ~all keys |
| Consistent hashing | Ring + virtual nodes | Adding a node moves ~1/N of keys | Per-key movement; range queries scatter |
| Range | Key ranges per shard | Range scans local; split hot ranges | Sequential keys → hot last range |
| Logical buckets | `hash(k) % B` (B fixed, large) → bucket → node | Move whole buckets; hashing never changes | Bucket count fixed at design time |
| Directory | Lookup table key → shard | Place/move individual tenants | Metadata store is critical-path |

Stores built for elasticity (Cassandra, DynamoDB, Riak) use consistent hashing or its descendants — see [System Design · Consistent Hashing](../system-design/topic.html?p=17-consistent-hashing). Sharded relational systems mostly use **fixed logical buckets** instead: Citus creates a fixed number of shards per table (`citus.shard_count`, default 32) and moves whole shards between workers; Vitess assigns each row a *keyspace ID* and each shard owns a contiguous range of that space, so resharding splits ranges (`-80` becomes `-40` and `40-80`); Instagram famously ran thousands of logical shards as PostgreSQL schemas on a handful of physical servers. The reason is operational: a bucket is a unit you can copy with logical replication, verify with a checksum, and cut over atomically. Moving an arbitrary hash arc of individual keys is much harder to make transactional.

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c12a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c12a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="c12a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two-level routing: key to logical bucket (fixed) to physical shard (movable)</text>
  <rect x="20" y="44" width="150" height="60" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="95" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">tenant_id = 7713</text>
  <text x="95" y="86" text-anchor="middle" fill="#334155" font-size="10">shard key from request</text>
  <path d="M172,74 L226,74" stroke="#2563eb" stroke-width="2" marker-end="url(#c12a1)"/>
  <rect x="228" y="44" width="180" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="318" y="68" text-anchor="middle" fill="#1e40af" font-weight="bold">bucket = hash(k) mod 4096</text>
  <text x="318" y="86" text-anchor="middle" fill="#1e40af" font-size="10">= 1409  (never changes)</text>
  <path d="M410,74 L464,74" stroke="#7c3aed" stroke-width="2" marker-end="url(#c12a2)"/>
  <rect x="466" y="44" width="200" height="60" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="566" y="66" text-anchor="middle" fill="#5b21b6" font-weight="bold">directory: bucket to shard</text>
  <text x="566" y="84" text-anchor="middle" fill="#5b21b6" font-size="10">0-1023 to S1, 1024-2047 to S2 ...</text>
  <text x="566" y="98" text-anchor="middle" fill="#5b21b6" font-size="10">override: tenant 42 to S9</text>
  <path d="M668,74 L722,74" stroke="#7c3aed" stroke-width="2" marker-end="url(#c12a2)"/>
  <rect x="724" y="44" width="136" height="60" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="792" y="68" text-anchor="middle" fill="#15803d" font-weight="bold">shard S2</text>
  <text x="792" y="86" text-anchor="middle" fill="#166534" font-size="10">primary + replicas</text>
  <rect x="20" y="124" width="410" height="150" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="225" y="146" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">hash(k) mod N: add one shard (4 to 5)</text>
  <rect x="40" y="160" width="70" height="26" fill="#fff" stroke="#fca5a5"/><text x="75" y="177" text-anchor="middle" fill="#7f1d1d" font-size="10">S1</text>
  <rect x="115" y="160" width="70" height="26" fill="#fff" stroke="#fca5a5"/><text x="150" y="177" text-anchor="middle" fill="#7f1d1d" font-size="10">S2</text>
  <rect x="190" y="160" width="70" height="26" fill="#fff" stroke="#fca5a5"/><text x="225" y="177" text-anchor="middle" fill="#7f1d1d" font-size="10">S3</text>
  <rect x="265" y="160" width="70" height="26" fill="#fff" stroke="#fca5a5"/><text x="300" y="177" text-anchor="middle" fill="#7f1d1d" font-size="10">S4</text>
  <rect x="340" y="160" width="70" height="26" fill="#fee2e2" stroke="#dc2626"/><text x="375" y="177" text-anchor="middle" fill="#7f1d1d" font-size="10">S5 new</text>
  <path d="M75,190 C120,220 300,220 370,192" stroke="#dc2626" stroke-width="1.5" fill="none" marker-end="url(#c12a3)"/>
  <text x="40" y="236" fill="#7f1d1d" font-size="11">about 80% of keys change shard; every row is</text>
  <text x="40" y="252" fill="#7f1d1d" font-size="11">a candidate to move; no unit of copy or cutover</text>
  <text x="40" y="268" fill="#991b1b" font-size="11" font-weight="bold">Resharding = rewrite the whole dataset</text>
  <rect x="450" y="124" width="410" height="150" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="655" y="146" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Logical buckets: add one shard</text>
  <rect x="470" y="160" width="90" height="26" fill="#fff" stroke="#86efac"/><text x="515" y="177" text-anchor="middle" fill="#14532d" font-size="10">S1: 0-1023</text>
  <rect x="566" y="160" width="90" height="26" fill="#fff" stroke="#86efac"/><text x="611" y="177" text-anchor="middle" fill="#14532d" font-size="10">S2: 1024-2047</text>
  <rect x="662" y="160" width="90" height="26" fill="#fff" stroke="#86efac"/><text x="707" y="177" text-anchor="middle" fill="#14532d" font-size="10">S3: 2048-3071</text>
  <rect x="758" y="160" width="90" height="26" fill="#fff" stroke="#86efac"/><text x="803" y="177" text-anchor="middle" fill="#14532d" font-size="10">S4: 3072-4095</text>
  <text x="470" y="210" fill="#166534" font-size="11">move buckets 0-203, 1024-1227, ... to S5</text>
  <text x="470" y="228" fill="#166534" font-size="11">keys keep their bucket; only directory rows change</text>
  <text x="470" y="246" fill="#166534" font-size="11">each bucket = copy + catch-up + verify + flip</text>
  <text x="470" y="266" fill="#15803d" font-size="11" font-weight="bold">Move ~20% of data, one bucket at a time</text>
  <rect x="20" y="292" width="840" height="150" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="314" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Which queries stay on one shard? (shard key = tenant_id)</text>
  <text x="40" y="338" fill="#15803d" font-size="11">WHERE tenant_id = 7713 AND id = 5              to one shard (router hashes the key)</text>
  <text x="40" y="358" fill="#15803d" font-size="11">orders JOIN order_items USING (tenant_id, order_id)   one shard (co-located on the same key)</text>
  <text x="40" y="378" fill="#15803d" font-size="11">orders JOIN plans (reference table copied to every shard)   one shard</text>
  <text x="40" y="398" fill="#b91c1c" font-size="11">WHERE email = 'a@b.com'                         all shards (scatter-gather) unless a global lookup table exists</text>
  <text x="40" y="418" fill="#b91c1c" font-size="11">SELECT count(*) GROUP BY plan                   all shards, merged by the router; latency = slowest shard</text>
  <text x="40" y="436" fill="#b91c1c" font-size="11">UPDATE two tenants in one transaction           two shards: needs 2PC or a saga</text>
</svg>
```

### Hot shards: skew is the default, not the exception

Real keys follow power laws. A social network's most-followed account gets orders of magnitude more reads than the median; a B2B SaaS's largest customer can be 20% of all rows. Hashing spreads *keys* evenly, but it cannot split a single key's load. Mitigations, from cheapest to most invasive:

- **Cache the hot key's reads** in front of the shard ([Caching with Redis · Hot Keys & Avalanche](../redis-caching/topic.html?p=17-hot-keys-avalanche)). Works for reads, not for writes.
- **Isolate whales with the directory.** Route the top tenants to dedicated shards via directory overrides. This is why a pure hash function is rarely enough in B2B systems.
- **Split the key (salting / write sharding).** For write-hot counters or append streams, write to `key#0 … key#15` chosen randomly and read-merge all 16. DynamoDB's documentation recommends exactly this for partitions that exceed per-partition throughput (on the order of 1,000 write units and 3,000 read units per second per partition).
- **Change the data model.** A celebrity's "followers" list sharded by follower rather than followee; fan-out-on-read for celebrities, fan-out-on-write for everyone else.

Time is the most common accidental hot key: sharding events by `created_at` range sends every insert to the newest range. Range-sharded stores (HBase, older MongoDB range keys on ObjectId) hit this constantly; the fix is to lead the key with an entity id or a hash prefix.

### Cross-shard queries and the tail-latency tax

If one shard answers within its p99 latency 99% of the time, a query that must wait for all N shards is slow whenever *any* shard is slow: P(slow) = 1 − 0.99^N. For N = 10 that is ~10%; for N = 100, ~63%. Your fan-out query's median becomes a single shard's p99. This is why a sharded system's reporting queries go to an **analytics copy** (CDC into a warehouse, [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns)) rather than scatter-gather against production shards, and why "look up user by email" gets a small **global secondary index** — a separate table keyed by email that maps to the shard key, written alongside the main row (synchronously with 2PC, or asynchronously with reconciliation).

### Global IDs

Per-shard `bigserial` sequences collide across shards. Options:

| Scheme | Layout | Pros | Cons |
|---|---|---|---|
| UUIDv4 | 122 random bits | No coordination | Random B-tree inserts: page splits, poor cache locality, 16 bytes |
| UUIDv7 (RFC 9562) | 48-bit Unix ms + random | Time-ordered inserts, no coordination; built-in `uuidv7()` in PostgreSQL 18 | 16 bytes; leaks creation time |
| Snowflake | 41-bit ms + 10-bit worker + 12-bit sequence | 64-bit, time-ordered, ~4,096 ids/ms/worker | Needs unique worker ids; clock going backwards must be handled |
| Instagram-style | 41-bit ms + 13-bit logical shard + 10-bit seq | Shard id *embedded* in the id: route by id alone | Logical shard count fixed at 8,192 |
| Ticket server (Flickr) | Central `auto_increment`, two servers with offset 1/2, step 2 | Dense 64-bit ints | Central dependency; batched to reduce round-trips |

The Instagram-style id is worth noticing: if the logical shard is inside the id, any id-only lookup can be routed without a directory hit.

## 4. Architecture & Workflow

### Resharding live: copy, catch up, verify, flip

Moving a bucket (or a whole shard's worth) from source S to target T while writes continue always follows the same shape, whether Vitess (VReplication `Reshard`/`MoveTables` workflows), Citus (shard moves via logical replication in `citus_rebalance_start()`), or a homegrown tool built on PostgreSQL logical replication.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c12b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="c12b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Live bucket move from shard S to shard T (writes never stop for long)</text>
  <line x1="40" y1="60" x2="860" y2="60" stroke="#94a3b8" stroke-width="2"/>
  <circle cx="60" cy="60" r="6" fill="#2563eb"/><text x="60" y="48" text-anchor="middle" fill="#1e40af" font-size="10">t0</text>
  <circle cx="220" cy="60" r="6" fill="#2563eb"/><text x="220" y="48" text-anchor="middle" fill="#1e40af" font-size="10">t1</text>
  <circle cx="380" cy="60" r="6" fill="#2563eb"/><text x="380" y="48" text-anchor="middle" fill="#1e40af" font-size="10">t2</text>
  <circle cx="540" cy="60" r="6" fill="#d97706"/><text x="540" y="48" text-anchor="middle" fill="#92400e" font-size="10">t3</text>
  <circle cx="700" cy="60" r="6" fill="#dc2626"/><text x="700" y="48" text-anchor="middle" fill="#b91c1c" font-size="10">t4</text>
  <circle cx="840" cy="60" r="6" fill="#16a34a"/><text x="840" y="48" text-anchor="middle" fill="#15803d" font-size="10">t5</text>
  <rect x="20" y="80" width="150" height="120" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="95" y="100" text-anchor="middle" fill="#1e40af" font-weight="bold">1. Snapshot copy</text>
  <text x="30" y="120" fill="#1e3a8a" font-size="10">create slot on S first</text>
  <text x="30" y="136" fill="#1e3a8a" font-size="10">(records start LSN)</text>
  <text x="30" y="152" fill="#1e3a8a" font-size="10">bulk-copy bucket rows</text>
  <text x="30" y="168" fill="#1e3a8a" font-size="10">to T at that snapshot</text>
  <text x="30" y="188" fill="#1e40af" font-size="10" font-weight="bold">hours for big buckets</text>
  <rect x="180" y="80" width="150" height="120" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="255" y="100" text-anchor="middle" fill="#1e40af" font-weight="bold">2. Catch up (CDC)</text>
  <text x="190" y="120" fill="#1e3a8a" font-size="10">stream changes since</text>
  <text x="190" y="136" fill="#1e3a8a" font-size="10">the snapshot LSN,</text>
  <text x="190" y="152" fill="#1e3a8a" font-size="10">filtered to the bucket</text>
  <text x="190" y="168" fill="#1e3a8a" font-size="10">lag shrinks to ~0</text>
  <text x="190" y="188" fill="#1e40af" font-size="10" font-weight="bold">writes still go to S</text>
  <rect x="340" y="80" width="150" height="120" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="415" y="100" text-anchor="middle" fill="#1e40af" font-weight="bold">3. Verify</text>
  <text x="350" y="120" fill="#1e3a8a" font-size="10">row counts + checksums</text>
  <text x="350" y="136" fill="#1e3a8a" font-size="10">per key range</text>
  <text x="350" y="152" fill="#1e3a8a" font-size="10">(Vitess: VDiff)</text>
  <text x="350" y="168" fill="#1e3a8a" font-size="10">optional shadow reads</text>
  <text x="350" y="188" fill="#1e40af" font-size="10" font-weight="bold">compare, do not trust</text>
  <rect x="500" y="80" width="150" height="120" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="575" y="100" text-anchor="middle" fill="#92400e" font-weight="bold">4. Switch reads</text>
  <text x="510" y="120" fill="#78350f" font-size="10">replica reads for the</text>
  <text x="510" y="136" fill="#78350f" font-size="10">bucket served from T</text>
  <text x="510" y="152" fill="#78350f" font-size="10">low risk: easy to</text>
  <text x="510" y="168" fill="#78350f" font-size="10">switch back</text>
  <text x="510" y="188" fill="#92400e" font-size="10" font-weight="bold">watch errors + latency</text>
  <rect x="660" y="80" width="200" height="120" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="760" y="100" text-anchor="middle" fill="#b91c1c" font-weight="bold">5. Switch writes (the flip)</text>
  <text x="670" y="120" fill="#7f1d1d" font-size="10">a) block writes to bucket on S</text>
  <text x="670" y="136" fill="#7f1d1d" font-size="10">b) wait: T applied up to S's LSN</text>
  <text x="670" y="152" fill="#7f1d1d" font-size="10">c) directory: bucket to T (bump version)</text>
  <text x="670" y="168" fill="#7f1d1d" font-size="10">d) start reverse replication T to S</text>
  <text x="670" y="188" fill="#b91c1c" font-size="10" font-weight="bold">write pause: ms to seconds</text>
  <rect x="20" y="220" width="840" height="100" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="40" y="242" fill="#1e293b" font-size="12" font-weight="bold">Why each guard exists</text>
  <text x="40" y="262" fill="#334155" font-size="11">Slot before snapshot: otherwise writes between "copy started" and "CDC started" are lost forever.</text>
  <text x="40" y="280" fill="#334155" font-size="11">Write block during the flip: without it, a write can land on S after T's final catch-up and be stranded on the old shard.</text>
  <text x="40" y="298" fill="#334155" font-size="11">Directory version: routers cache the map; a stale router must be rejected by S (bucket no longer owned) and refresh.</text>
  <text x="40" y="316" fill="#334155" font-size="11">Reverse replication: rollback is a second flip, not a restore from backup.</text>
  <rect x="20" y="336" width="410" height="120" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="225" y="358" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">6. Clean up (t5, days later)</text>
  <text x="40" y="380" fill="#166534" font-size="11">stop reverse replication, drop the slot on T</text>
  <text x="40" y="398" fill="#166534" font-size="11">delete bucket rows from S in batches</text>
  <text x="40" y="416" fill="#166534" font-size="11">(they are dead weight and confuse scatter queries)</text>
  <text x="40" y="440" fill="#15803d" font-size="11" font-weight="bold">Only now is the move irreversible.</text>
  <rect x="450" y="336" width="410" height="120" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="655" y="358" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Double-write without CDC: the trap</text>
  <text x="470" y="380" fill="#7f1d1d" font-size="11">app writes S then T; crash between = divergence</text>
  <text x="470" y="398" fill="#7f1d1d" font-size="11">concurrent updates can apply in different orders</text>
  <text x="470" y="416" fill="#7f1d1d" font-size="11">backfill races with live writes (last write loses)</text>
  <text x="470" y="440" fill="#991b1b" font-size="11" font-weight="bold">If you must: S stays source of truth + reconcile job</text>
</svg>
```

The critical insight is that the write flip is a tiny distributed transaction: *stop accepting writes for the bucket at S, confirm T has everything, change the owner*. Vitess does this by briefly buffering writes at VTGate and switching the routing rules atomically in its topology server; Citus shard moves take a short write lock on the shard during the final catch-up. The whole point of logical buckets is to keep this pause proportional to one bucket's in-flight writes, not the table's.

### Shard failure

Each shard is a normal replicated database with its own failover ([Ch 18 · High Availability](topic.html?p=18-high-availability)). What changes is the *blast radius*: if shard 7 of 16 is down, 1/16 of users are affected — and every scatter-gather query is affected for everyone, unless it is written to return partial results. Design decisions to make up front:

- **Fail partial, not total.** Fan-out endpoints (search, dashboards) should time out per shard and return "results from 15 of 16 shards" rather than a 500.
- **Keep the routing metadata highly available.** The directory or topology store (Vitess uses etcd/ZooKeeper/Consul; Citus stores metadata on the coordinator) is now as critical as any shard. Cache it in routers with versioning so a metadata outage does not stop routing to healthy shards.
- **Don't let one shard's retries starve the pool.** A per-shard circuit breaker prevents a dead shard from consuming every application worker ([Ch 20 · Database + Application](topic.html?p=20-database-application-architecture)).

## 5. Implementation

### Simple example: Citus on PostgreSQL

Citus turns PostgreSQL into a coordinator plus workers; you choose a distribution column per table.

```sql
-- On the coordinator (docker image: citusdata/citus)
CREATE EXTENSION citus;
SELECT citus_add_node('worker-1', 5432);
SELECT citus_add_node('worker-2', 5432);

CREATE TABLE tenants     (tenant_id bigint PRIMARY KEY, name text, plan text);
CREATE TABLE orders      (tenant_id bigint, order_id bigint, status text, total numeric,
                          PRIMARY KEY (tenant_id, order_id));
CREATE TABLE order_items (tenant_id bigint, order_id bigint, sku text, qty int,
                          PRIMARY KEY (tenant_id, order_id, sku));
CREATE TABLE plans       (plan text PRIMARY KEY, max_seats int);

SELECT create_distributed_table('tenants', 'tenant_id');
SELECT create_distributed_table('orders', 'tenant_id', colocate_with => 'tenants');
SELECT create_distributed_table('order_items', 'tenant_id', colocate_with => 'orders');
SELECT create_reference_table('plans');      -- copied to every worker
```

Note the primary keys: every unique constraint on a distributed table must include the distribution column, for exactly the reason partitioned tables need the partition key ([Ch 11 · Partitioning](topic.html?p=11-partitioning)).

```sql
EXPLAIN SELECT o.order_id, sum(i.qty)
FROM orders o JOIN order_items i USING (tenant_id, order_id)
WHERE o.tenant_id = 7713 GROUP BY o.order_id;
```

```text
 Custom Scan (Citus Adaptive)
   Task Count: 1
   Tasks Shown: All
   ->  Task
         Node: host=worker-2 port=5432 dbname=app
         ->  HashAggregate ...
```

Drop the `tenant_id` filter and the plan shows `Task Count: 32` — one task per shard, merged on the coordinator. `Task Count` is the single most useful number in a Citus plan: 1 means single-shard, anything else is a scatter.

Rebalancing after adding a worker:

```sql
SELECT citus_add_node('worker-3', 5432);
SELECT citus_rebalance_start();          -- background shard moves using logical replication
SELECT * FROM citus_rebalance_status();
```

### Real-world example: an application-level router with logical buckets and whale overrides

Many teams shard at the application layer over plain PostgreSQL. The router is small; the metadata discipline is what matters.

```sql
-- Metadata DB (small, replicated, heavily cached by routers)
CREATE TABLE shard_map (
  bucket     int  PRIMARY KEY CHECK (bucket BETWEEN 0 AND 4095),
  shard      text NOT NULL,          -- e.g. 'pg-shard-03'
  state      text NOT NULL DEFAULT 'active' CHECK (state IN ('active','moving','read_only')),
  version    bigint NOT NULL DEFAULT 1
);
CREATE TABLE tenant_override (         -- directory entries for whales
  tenant_id  bigint PRIMARY KEY,
  shard      text NOT NULL,
  version    bigint NOT NULL DEFAULT 1
);
```

```go
package shard

import (
	"errors"
	"hash/fnv"
	"sync/atomic"
)

const Buckets = 4096 // fixed forever: changing it would remap every key

type Map struct {
	Version   int64
	BucketTo  [Buckets]string   // bucket -> shard name
	ReadOnly  [Buckets]bool     // bucket is mid-flip: reject writes, retry shortly
	Overrides map[int64]string  // tenant -> dedicated shard
}

type Router struct{ cur atomic.Pointer[Map] } // swapped atomically on refresh

var ErrBucketMoving = errors.New("bucket is moving; retry")

func Bucket(tenantID int64) int {
	h := fnv.New64a()
	var b [8]byte
	for i := 0; i < 8; i++ {
		b[i] = byte(tenantID >> (8 * i))
	}
	h.Write(b[:])
	return int(h.Sum64() % Buckets)
}

// Route returns the shard for a tenant. forWrite=true refuses buckets in the flip window,
// so no write can land on the old shard after the final catch-up.
func (r *Router) Route(tenantID int64, forWrite bool) (shard string, mapVersion int64, err error) {
	m := r.cur.Load()
	if s, ok := m.Overrides[tenantID]; ok {
		return s, m.Version, nil
	}
	b := Bucket(tenantID)
	if forWrite && m.ReadOnly[b] {
		return "", m.Version, ErrBucketMoving
	}
	return m.BucketTo[b], m.Version, nil
}
```

The shard itself must also defend against stale routers: each shard keeps a local `owned_buckets` table, and writes go through a check (`WHERE EXISTS (SELECT 1 FROM owned_buckets WHERE bucket = $1)`, or a trigger). A router holding an old map gets an error, refreshes, and retries — the same idea as a fencing token ([Ch 15 · Consensus](topic.html?p=15-consensus)).

Instagram-style global ids that embed the logical shard:

```sql
CREATE SEQUENCE global_id_seq;
CREATE OR REPLACE FUNCTION next_id(logical_shard int) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
  our_epoch bigint := 1735689600000;   -- 2025-01-01 in ms: custom epoch extends the 41-bit range
  seq_id    bigint;
  now_ms    bigint;
BEGIN
  seq_id := nextval('global_id_seq') % 1024;                         -- 10 bits
  now_ms := floor(extract(epoch FROM clock_timestamp()) * 1000);
  RETURN ((now_ms - our_epoch) << 23)                                -- 41 bits of ms
       | ((logical_shard % 8192)::bigint << 10)                      -- 13 bits of shard
       | seq_id;
END $$;

SELECT next_id(1409), next_id(1409) >> 10 & 8191 AS shard_from_id;
```

> **MySQL difference:** MySQL sharding at scale is dominated by **Vitess** (VTGate proxies speak the MySQL protocol; a **VSchema** declares each table's **vindex**, the function from a column to a *keyspace ID*; shards own keyspace-ID ranges such as `-80` and `80-`). Resharding is a VReplication workflow (`Reshard` → `VDiff` → `SwitchTraffic` for replicas then primaries → `Complete`), with `ReverseTraffic` as the rollback. For ticket-server ids, MySQL's `auto_increment_increment` / `auto_increment_offset` give two servers interleaved odd/even sequences — the Flickr design.

### Illustrations from other stores

- **MongoDB** splits a sharded collection into ranges (chunks) of the shard key, either ranged or `hashed`; a balancer migrates ranges between shards, and `mongos` routes. `reshardCollection` (5.0+) changes the key online by building a new copy and cutting over — the same copy/catch-up/flip shape. Monotonic ranged keys (ObjectId, timestamps) create the hot-last-chunk problem.
- **DynamoDB** hashes the partition key onto internal partitions that split automatically by size and throughput; adaptive capacity helps skew, but a single key's throughput is still bounded, so hot keys are sharded with suffixes.
- **Cassandra** uses a token ring with virtual nodes ([Cassandra · Ring, Tokens & Consistent Hashing](../cassandra/topic.html?p=18-ring-tokens-consistent-hashing)); adding a node streams ranges to it. There is no cross-partition transaction at all — the data model is built so you never need one.

## 6. Advantages, Disadvantages & Trade-offs

| Choice | Option A | Option B | Prefer A when |
|---|---|---|---|
| Shard at all | Shard | Bigger box + replicas + partitioning + caching | Write rate or working set exceeds the largest practical single node |
| Key | Tenant / user id | Secondary attributes (region, time) | Most queries and transactions are scoped to one owner |
| Mapping | Logical buckets + directory | Consistent hashing ring | Relational store where moves must be verified and cut over atomically |
| Layer | Proxy / extension (Vitess, Citus) | App-level router | You lack a team to build and run resharding tooling |
| IDs | UUIDv7 / Snowflake | Central ticket server | You want no insert-path dependency |
| Cross-shard reads | Async derived store / warehouse | Online scatter-gather | Queries are analytical or need many shards |

**Advantages**
- Near-linear capacity for single-shard work: storage, write throughput, memory.
- Smaller failure domains; per-shard maintenance, upgrades and restores are faster.
- Can place data (tenants, regions) deliberately — data residency, noisy-neighbour isolation.

**Disadvantages**
- Cross-shard joins, aggregates, uniqueness and transactions are expensive or unavailable.
- Resharding is a recurring, risky, tooling-heavy operation.
- Operational multiplication: N primaries, N sets of replicas, backups, upgrades, alerts.
- Skew caps capacity at the hottest shard.

### When to use
- The write rate, WAL volume or working set exceeds what a single primary can sustain even after the scaling ladder.
- Data is naturally owned by an entity (tenant, user, account) and most operations are scoped to it.
- You need hard isolation between customers or regions.

### When NOT to use
- Because the table is "big" — a few TB on modern hardware with partitioning is routinely fine.
- When most important queries span many owners (global leaderboards, cross-tenant analytics) — use a warehouse or a purpose-built store.
- When you need frequent multi-entity ACID transactions and can't redraw boundaries — consider a distributed SQL database ([Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture)) instead of hand-rolled sharding.
- Before you have a routing layer, global ids, per-shard monitoring and a rehearsed resharding procedure.

## 7. Common Mistakes & Best Practices

- **`hash(key) % N` with physical N.** Adding a shard remaps ~all keys. *Instead:* fix a large bucket count on day one (1,024–16,384) and map buckets to shards.
- **Sharding by time or a monotonic id.** All writes hit the newest shard. *Instead:* lead with an entity id; cluster by time inside the shard.
- **Shard key not in the hot queries.** Every request fans out and you've built a slower single database. *Instead:* audit `pg_stat_statements` and API routes before choosing the key.
- **Not co-locating related tables.** Orders sharded by `order_id` and items by `item_id` turns every order read into a cross-shard join. *Instead:* give children the parent's shard key and include it in their PKs.
- **Double-writing from the application during migrations.** Crashes between the two writes and concurrent updates cause silent divergence. *Instead:* CDC/logical replication from a single source of truth, verify with checksums, then flip.
- **Per-shard sequences as global ids.** Collisions appear the day you merge or move data. *Instead:* UUIDv7, Snowflake, or ids with the logical shard embedded.
- **Unbounded scatter-gather in the request path.** Tail latency explodes with shard count. *Instead:* global lookup tables for secondary keys, async derived views, per-shard timeouts with partial results.
- **Ignoring whales.** One tenant outgrows a shard and there is no way to move it alone. *Instead:* support directory overrides from day one.
- **Best practice:** write down the shard key contract — which queries are single-shard, which fan out and how they're served, how uniqueness and ids work, and the resharding runbook — and review every new feature against it.

## 8. Production: Failure Scenarios, Monitoring & Scaling

**Failure scenario: a whale melts a shard.** At 09:00 Monday, p99 on shard 11 goes from 8 ms to 900 ms; other shards are fine. `pg_stat_statements` on shard 11 shows one tenant's bulk import. Root cause: the largest tenant grew to 25% of the shard's writes. Fix now: rate-limit the tenant's import job. Fix properly: move the tenant to a dedicated shard via a directory override, using the same copy/catch-up/flip procedure scoped to one tenant.

**Failure scenario: stranded writes after a move.** A day after a bucket move, support reports orders "disappearing". Root cause: one router fleet had a stale map cache and kept writing to the old shard after the flip; the old shard accepted the writes because nothing checked ownership. Fix: shard-side ownership checks (`owned_buckets`), map versions in every request, and a reconciliation job that finds rows in buckets a shard does not own.

**Failure scenario: resharding filled the disk.** Mid-copy, the source shard's disk hits 100% and PostgreSQL stops. Root cause: the logical replication slot created for catch-up retained WAL while the initial copy of a 2 TB bucket took 14 hours. Fix: size WAL disk for copy duration × WAL rate, set `max_slot_wal_keep_size` (the slot is invalidated instead of the primary dying — you restart the move rather than the database), and move smaller buckets.

**Failure scenario: fan-out endpoint down because one shard is down.** Shard 3 fails over (40 s). Every search request errors for 40 s because the scatter-gather waits for all shards. Fix: per-shard timeout, partial results with a flag, and a circuit breaker.

**Metrics to watch**
- Per-shard QPS, p99 latency, CPU, disk and WAL rate — and the **max/median ratio** across shards (skew).
- Top tenants/keys by load per shard.
- Fraction of queries that are multi-shard (Citus: `Task Count > 1`; Vitess: scatter query metrics at VTGate).
- Replication-slot retained WAL during moves (`pg_replication_slots`, `pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)`).
- Directory/topology store health and map version skew across routers.

**Scaling notes.** Plan bucket count for a 10–100x future: 4,096 buckets on 4 shards can grow to hundreds of shards without rehashing. Keep shards similar in size so operations (restore time, upgrade time) are predictable. Automate: a shard move you run once a year by hand is a shard move that fails.

## 9. Interview Questions

**Q: What problem does sharding solve, and what problems does it create?**
A: It solves capacity limits of a single node: write throughput, working-set memory and dataset size beyond what one primary can handle. It does this by splitting rows across independent databases so single-shard work scales with the number of shards. In exchange you get distributed-systems problems: cross-shard queries become scatter-gather with tail-latency amplification, cross-shard transactions need 2PC or sagas, global uniqueness and sequences disappear, rebalancing requires moving live data, skew concentrates load, and each shard is a partial-failure domain. The shard key determines how often you hit these, so it is the central design decision.

**Q: How do you choose a shard key?**
A: I start from access patterns: the key must be in the WHERE clause of the dominant queries by frequency and cost. It must have high cardinality, spread load (not just rows) evenly, co-locate rows that are joined or updated atomically, and be immutable, because changing it means moving the row between databases. For multi-tenant SaaS that is usually `tenant_id`; for consumer apps usually `user_id`. When two access paths conflict, I shard by the one that needs transactions and serve the other from an asynchronously maintained copy or a global lookup table.

**Q: Why do relational sharding systems prefer fixed logical shards over a consistent-hashing ring?**
A: With a fixed bucket count, a key's bucket never changes, so resharding only changes the bucket-to-server mapping and moves whole buckets. A bucket is a clean unit to copy, catch up with logical replication, verify with checksums and cut over with a brief write pause. A ring moves arcs of individual keys whose boundaries are defined by hash values, which is harder to copy and cut over transactionally in a relational engine. Rings shine in leaderless stores like Cassandra where ownership changes are handled by streaming and repair rather than atomic cutovers.

**Q: What is a hot shard and how do you deal with one?**
A: A shard receiving disproportionate load because the key distribution is skewed — a celebrity user, a whale tenant, or a monotonic key sending all inserts to the newest range. Hashing spreads keys but cannot split one key's load. For read-hot keys, cache in front. For whale tenants, use directory overrides to give them a dedicated shard. For write-hot keys, split the key into N sub-keys with a random suffix and merge on read. For monotonic keys, change the key so it leads with an entity id or hash prefix.

**Q: Why is scatter-gather worse than it looks?**
A: Because the query waits for the slowest shard. If each shard is within its p99 99% of the time, a query over N shards is slow with probability 1 − 0.99^N: about 10% at 10 shards and 63% at 100. It also multiplies load: one request becomes N queries, so a popular fan-out endpoint consumes capacity on every shard. Keep it out of hot request paths by using global lookup tables for secondary keys, async materialised views, or a warehouse for analytics, and when it is unavoidable use per-shard timeouts and partial results.

**Q: Compare UUIDv4, UUIDv7 and Snowflake ids for a sharded system.**
A: All three avoid a central coordinator on insert. UUIDv4 is fully random, which makes B-tree inserts land on random pages, causing page splits and poor cache locality. UUIDv7 puts a 48-bit millisecond timestamp first, so inserts are roughly append-only like a sequence, while still needing no coordination; PostgreSQL 18 has a built-in `uuidv7()`. Snowflake packs a 41-bit millisecond timestamp, a 10-bit worker id and a 12-bit sequence into 64 bits: half the size, time-ordered, but it needs unique worker-id assignment and handling for clocks moving backwards. Variants that embed a logical shard id let you route by id alone.

**Q: How does a cross-shard transaction differ from a single-shard one?**
A: A single-shard transaction is an ordinary local ACID transaction. Across shards there is no shared log or lock manager, so atomicity needs a protocol: two-phase commit, where each shard prepares and a coordinator decides, or a saga of local transactions with compensations. 2PC holds locks across network round trips and blocks if the coordinator fails after prepare; sagas give up isolation. Citus uses 2PC for multi-shard writes, and Vitess offers a two-phase mode but defaults to best-effort multi-shard commits. The best design keeps transactional units on one shard by co-locating on the shard key.

**Q: Walk me through resharding a live PostgreSQL shard without downtime. (Senior)**
A: I use logical buckets so I'm moving buckets, not rehashing. For each bucket: create a logical replication slot on the source first to fix a start LSN, bulk-copy the bucket's rows at that snapshot, then stream changes from the slot filtered to the bucket until lag is near zero. I verify with per-range row counts and checksums, and optionally shadow-read. Then I switch replica reads, watch, and do the write flip: mark the bucket read-only in the directory so routers reject writes, wait until the target has applied past the source's current LSN, update the directory with a new version, and start reverse replication for rollback. Shards enforce ownership so stale routers fail and refresh. After a soak period I stop reverse replication and delete the old rows in batches. Throughout, `max_slot_wal_keep_size` and disk headroom protect the source.

**Q: Your B2B product's largest tenant is 30% of all traffic and growing. How do you design for it? (Senior)**
A: A pure hash on `tenant_id` will eventually put that tenant alone above a shard's capacity, so I need two things. First, a directory override so any tenant can be placed on a dedicated shard and moved with the same bucket-move tooling scoped to one tenant. Second, a plan for when one tenant exceeds one machine: sharding *within* the tenant by a secondary key (e.g. `(tenant_id, project_id)`), which only works if that tenant's queries are scoped to projects, or a distributed SQL engine for that tenant. I also isolate noise: separate connection pools and rate limits per tier, and CPU-heavy exports moved to replicas. The key insight is that skew is a product reality, so the routing layer must support exceptions from day one.

**Q: Where would you put a global uniqueness constraint (unique email) in a sharded users table? (Senior)**
A: Sharding by `user_id` means email uniqueness can't be enforced by any single shard. I'd create a global lookup table `user_emails(email PRIMARY KEY, user_id)` and shard it by email hash, so each email lives on exactly one shard that can enforce uniqueness. Signup then touches two shards: the email shard and the user shard. I either use 2PC for that, or order the operations so the email claim happens first (as a reservation with a pending state) and the user row second, with a cleanup job for abandoned reservations. The same table doubles as the routing index for login by email, which removes a scatter-gather.

**Q: A router bug sent writes to the wrong shard for an hour after a bucket move. How do you prevent and repair this class of bug? (Senior)**
A: Prevention is defence in depth. The directory has versions and routers include the version with each request; each shard keeps an authoritative list of buckets it owns and rejects writes for anything else, so a stale router errors and refreshes instead of writing. During the flip the bucket is read-only so nothing is in flight. For repair, I find rows on each shard whose bucket it does not own, compare them with the owning shard using primary key and updated_at, merge by business rules (usually replaying the stranded writes onto the owner if they don't conflict), and audit anything that needs a human decision. Then I add a continuous reconciliation check that alerts on unowned rows.

## 10. Quick Revision & Cheat Sheet

| Concept | One-liner |
|---|---|
| Why shard | Write rate / working set / dataset beyond one node, after the scaling ladder |
| Shard key | In hot queries, high cardinality, even load, co-locates atomic units, immutable |
| Logical buckets | `hash(k) % B` fixed; buckets mapped to shards; move buckets, not keys |
| Directory | Explicit key/bucket to shard; overrides for whales; versioned, cached |
| Consistent hashing | Ring + vnodes; the norm in Dynamo-style stores |
| Hot shard | Cache (reads), isolate (whales), salt (writes), remodel (celebrities) |
| Scatter-gather | P(slow) = 1 - 0.99^N; keep it off hot paths |
| Resharding | Slot, copy, CDC catch-up, verify, switch reads, block + flip writes, reverse repl, cleanup |
| Global IDs | UUIDv7 / Snowflake / shard-embedded ids; never per-shard sequences |
| Cross-shard txn | 2PC or saga; better: co-locate |

- Sharding trades capacity problems for distributed-systems problems.
- The shard key is a contract with every future feature.
- Fix a large bucket count on day one; never rehash physical N.
- Time is a good partition key and a bad shard key.
- Slot before snapshot, block before flip, verify before trusting.
- Shards must reject writes for buckets they don't own.
- Your capacity is the hottest shard's capacity.

## 11. Hands-On Exercises

1. **Citus lab.** Run `citusdata/citus` with docker compose (coordinator + 2 workers). Create the tenant schema from §5, load 1M orders, and compare `EXPLAIN` `Task Count` for a tenant-scoped query, a global aggregate, and a join with the reference table.
2. **Rebalance.** Add a third worker, run `citus_rebalance_start()`, and while it runs keep an insert loop going. Confirm no errors and watch `citus_rebalance_status()` and `pg_replication_slots` on the source.
3. **Mod-N vs buckets.** In Python, assign 1M keys with `hash % 4` and `hash % 5`; count how many change shard. Repeat with 4,096 buckets mapped 4 → 5 shards moving the minimum number of buckets; compare data moved.
4. **Tail latency simulation.** Simulate N shards with a latency distribution (e.g. lognormal plus a 1% slow tail); measure p50/p99 of max-over-N for N = 1, 10, 100.
5. **Global ids.** Implement the `next_id(shard)` function from §5; generate 100,000 ids in a tight loop across 4 sessions; verify uniqueness, ordering by time, and decode the shard bits.
6. **Manual bucket move.** With two plain `postgres:17` containers, move one tenant's rows using a publication with a row filter (`CREATE PUBLICATION p FOR TABLE orders WHERE (tenant_id = 42)`, PG 15+), catch up while inserting, then do a scripted flip with a read-only flag and verify counts.

**Mini project — "Shard router with safe moves".** Build a small service over three PostgreSQL containers: a metadata DB with `shard_map` and `tenant_override`, a Go or Python router that caches the map with versions, shard-side ownership checks, and a `move_bucket` command implementing slot → copy → catch-up → verify → read-only → flip → reverse replication. Chaos-test it: kill the mover mid-copy, run a stale router during the flip, and prove no write is lost or stranded.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) · [Ch 15 · Consensus](topic.html?p=15-consensus) · [Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture) · [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) · [Ch 40 · Case Study: Multi-tenant SaaS](topic.html?p=40-case-multi-tenant-saas).

**SQL Handbook:** [Partitioning & Sharding](../sql/topic.html?p=23-partitioning) · [Keys & Constraints](../sql/topic.html?p=29-keys-constraints).

**Other handbooks:** [System Design · Database Scaling](../system-design/topic.html?p=16-database-scaling) · [System Design · Consistent Hashing](../system-design/topic.html?p=17-consistent-hashing) · [Cassandra · Ring, Tokens & Consistent Hashing](../cassandra/topic.html?p=18-ring-tokens-consistent-hashing) · [Caching with Redis · Redis Cluster](../redis-caching/topic.html?p=26-redis-cluster) (hash slots: the logical-bucket idea in Redis).

- **Sharding & IDs at Instagram** — Instagram Engineering · *Intermediate* · logical shards as PostgreSQL schemas and the 64-bit id layout. <https://instagram-engineering.com/sharding-ids-at-instagram-1cf5a71e5a5c>
- **Citus documentation: choosing the distribution column** — Citus Data · *Intermediate* · co-location, reference tables and multi-tenant key choice. <https://docs.citusdata.com/en/stable/sharding/data_modeling.html>
- **Vitess: Resharding user guide** — Vitess · *Advanced* · VReplication-based resharding with verification and traffic switching. <https://vitess.io/docs/user-guides/configuration-advanced/resharding/>
- **Designing Data-Intensive Applications, ch. 6 (Partitioning)** — Martin Kleppmann · *Intermediate* · rebalancing strategies, secondary indexes and request routing. <https://dataintensive.net/>
- **The Tail at Scale** — Dean & Barroso, CACM 2013 · *Advanced* · why fan-out amplifies tail latency and how to mitigate it. <https://dl.acm.org/doi/10.1145/2408776.2408794>
- **Ticket Servers: Distributed Unique Primary Keys on the Cheap** — Flickr Engineering · *Beginner* · the two-server auto_increment design. <https://code.flickr.net/2010/02/08/ticket-servers-distributed-unique-primary-keys-on-the-cheap/>
- **RFC 9562: Universally Unique IDentifiers (UUIDs)** — IETF · *Intermediate* · the UUIDv7 layout. <https://www.rfc-editor.org/rfc/rfc9562>

---

*Database Design Handbook — chapter 12.*
