# 14 · SQL vs NoSQL & Data Modeling

> **In one line:** Pick a datastore by how you read and write the data, not by fashion — then model the schema around those access patterns.

---

## 1. Overview

Every system stores state, and the shape of that store decides your query power, your consistency guarantees, and your scaling ceiling. The historical default is the **relational database** (Postgres, MySQL): data lives in normalized tables, you compose queries with **joins**, and **ACID** transactions keep it correct. It is the right answer far more often than interview folklore suggests.

**NoSQL** is not one thing — it is four families (key-value, document, wide-column, graph) that each drop some relational guarantee to buy something else: horizontal write scale, a flexible schema, or graph traversal. They typically relax consistency to **BASE** (basically available, soft-state, eventual consistency) to stay available and partition-tolerant.

The real skill is not "SQL vs NoSQL" as a religious war. It is **data modeling**: enumerate your access patterns, estimate their volume and latency budget, and choose the store — often *stores*, plural — whose physical layout serves those patterns cheaply. Amazon's shopping cart uses DynamoDB (key-value) for the cart, a relational store for orders, Redis for sessions, and a search index for the catalog. That is **polyglot persistence**, and it is normal.

A concrete example: a chat app. "Fetch the last 50 messages in a room, newest first" is a range scan by `(room_id, ts)` — a wide-column store nails it. "Charge a user and credit a merchant atomically" is a transaction — that belongs in a relational database. Same product, two engines, chosen by access pattern.

## 2. Core Concepts

- **Relational model** — data as tuples in relations (tables) with a fixed schema; relationships expressed by foreign keys and resolved at query time via joins. Declarative SQL lets the query planner choose the execution strategy.
- **ACID** — **A**tomicity (all-or-nothing), **C**onsistency (invariants hold), **I**solation (concurrent txns don't corrupt each other), **D**urability (committed data survives crashes). The contract that lets you reason about correctness under concurrency and failure.
- **Normalization** — factor data so each fact lives in exactly one place (1NF→3NF). Eliminates update anomalies and redundancy; the cost is joins to reassemble data at read time.
- **Key-value** — a giant distributed hash map: `get(key)`/`put(key, value)`. O(1)-ish lookups, trivially shardable by key hash, no query language. Redis, DynamoDB, Riak.
- **Document** — key-value where the value is a queryable, nested JSON/BSON blob. Flexible schema, secondary indexes, no rigid joins. MongoDB, Couchbase, DynamoDB (item view).
- **Wide-column** — rows keyed by a **partition key** plus a sorted **clustering key**; columns are sparse. Built for massive write throughput and range scans within a partition. Cassandra, ScyllaDB, HBase, Bigtable.
- **Graph** — first-class nodes and edges; queries traverse relationships (friends-of-friends, fraud rings, recommendations) in constant time per hop instead of exponential joins. Neo4j, JanusGraph.
- **BASE** — the availability-first counterpart to ACID; the system stays writable during partitions and converges later. Suits carts, feeds, counters — not ledgers.
- **Denormalization** — deliberately duplicate data so a read touches one place instead of joining many. The core NoSQL modeling move; trades write/storage cost and update fan-out for read speed.
- **Polyglot persistence** — use several stores in one system, each matched to a workload, rather than forcing everything into one engine.

## 3. Architecture

Relational stores centralize a normalized schema behind a query planner and a transaction manager; you scale them *up* first and *out* only with effort. NoSQL stores spread data across many nodes by a partition key and serve each request from one (or a few) nodes, scaling *out* linearly but pushing join/consistency logic up into your application.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="700">One service, many stores — chosen by access pattern</text>

  <rect x="320" y="42" width="120" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="66" text-anchor="middle" fill="#1e293b">App / Service</text>

  <!-- Relational -->
  <rect x="40" y="150" width="150" height="86" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="115" y="172" text-anchor="middle" fill="#1e293b" font-weight="700">Relational (SQL)</text>
  <text x="115" y="192" text-anchor="middle" fill="#64748b" font-size="11">Orders, payments</text>
  <text x="115" y="208" text-anchor="middle" fill="#64748b" font-size="11">ACID, joins</text>
  <text x="115" y="224" text-anchor="middle" fill="#64748b" font-size="11">Postgres / MySQL</text>

  <!-- Key-value -->
  <rect x="205" y="150" width="150" height="86" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="280" y="172" text-anchor="middle" fill="#1e293b" font-weight="700">Key-Value</text>
  <text x="280" y="192" text-anchor="middle" fill="#64748b" font-size="11">Cart, sessions</text>
  <text x="280" y="208" text-anchor="middle" fill="#64748b" font-size="11">O(1) by key</text>
  <text x="280" y="224" text-anchor="middle" fill="#64748b" font-size="11">Redis / DynamoDB</text>

  <!-- Wide-column -->
  <rect x="370" y="150" width="150" height="86" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="445" y="172" text-anchor="middle" fill="#1e293b" font-weight="700">Wide-Column</text>
  <text x="445" y="192" text-anchor="middle" fill="#64748b" font-size="11">Messages, events</text>
  <text x="445" y="208" text-anchor="middle" fill="#64748b" font-size="11">write-heavy, ranges</text>
  <text x="445" y="224" text-anchor="middle" fill="#64748b" font-size="11">Cassandra</text>

  <!-- Document -->
  <rect x="535" y="150" width="105" height="86" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="587" y="172" text-anchor="middle" fill="#1e293b" font-weight="700">Document</text>
  <text x="587" y="192" text-anchor="middle" fill="#64748b" font-size="11">Catalog</text>
  <text x="587" y="208" text-anchor="middle" fill="#64748b" font-size="11">flexible JSON</text>
  <text x="587" y="224" text-anchor="middle" fill="#64748b" font-size="11">MongoDB</text>

  <!-- Graph -->
  <rect x="655" y="150" width="80" height="86" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="695" y="172" text-anchor="middle" fill="#1e293b" font-weight="700">Graph</text>
  <text x="695" y="192" text-anchor="middle" fill="#64748b" font-size="11">Social</text>
  <text x="695" y="208" text-anchor="middle" fill="#64748b" font-size="11">traversal</text>
  <text x="695" y="224" text-anchor="middle" fill="#64748b" font-size="11">Neo4j</text>

  <line x1="360" y1="82" x2="115" y2="148" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="368" y1="82" x2="280" y2="148" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="392" y1="82" x2="445" y2="148" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="400" y1="82" x2="587" y2="148" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="408" y1="82" x2="695" y2="148" stroke="#475569" marker-end="url(#ar)"/>

  <text x="380" y="272" text-anchor="middle" fill="#64748b" font-size="12">Each store's physical layout serves one class of query cheaply — polyglot persistence.</text>
</svg>
```

## 4. How It Works

The decision and modeling flow, end to end:

1. **List access patterns.** Write every read and write the feature needs, e.g. "get user by id", "list a user's last 20 orders", "top-10 items by category". Include volume (QPS) and latency budget (p99).
2. **Classify each pattern.** Point lookup by key? Range scan? Multi-entity join? Full-text? Aggregation? Graph traversal? This is what actually maps to an engine.
3. **Check transactional invariants.** Any operation that must be atomic across rows/entities (money, inventory, uniqueness) argues strongly for a relational store with real transactions.
4. **Pick the engine per workload.** Point/scan by key → key-value or wide-column; joins + transactions → relational; flexible nested reads → document; traversal → graph.
5. **Model the schema *for* the patterns.** In SQL, normalize (3NF) then add indexes for the hot queries. In NoSQL, do the opposite: start from the query and **denormalize** — one table/collection per access pattern, partition key chosen to spread load and colocate what you read together.
6. **Handle cross-cutting reads.** Data a single engine can't serve (search, analytics) gets a derived store fed by a stream/CDC pipeline — accept eventual consistency there.
7. **Revisit under load.** Watch for hot partitions, unbounded item growth, and join queries that only work at small scale; reshape the model before it's the bottleneck.

```text
Access pattern                          Engine that fits
--------------------------------------  --------------------------------
point read/write by id                  Key-Value (Redis, DynamoDB)
range scan within a partition           Wide-Column (Cassandra)
multi-table join + ACID txn             Relational (Postgres, MySQL)
flexible nested doc, few relations      Document (MongoDB)
"friends of friends", path queries      Graph (Neo4j)
full-text / relevance                   Search index (Elasticsearch)
```

## 5. Key Components / Deep Dive

### ACID and why joins are "expensive"
A join reconstructs a fact that normalization split across tables. The planner may hash-join, merge-join, or nested-loop; on indexed keys at moderate scale this is microseconds. The problem is *distribution*: once tables live on different shards, a join becomes a cross-node scatter-gather, and that is why NoSQL stores refuse joins and ask you to denormalize instead.

### Denormalization and the write fan-out
Duplicating data makes reads O(1) but turns one logical update into N physical writes. If a user renames themselves and their name is copied into every message row, you either rewrite all of them (write amplification) or tolerate stale copies. The rule: denormalize data that is **read far more than written** and where staleness is acceptable.

### Partition key design (wide-column / key-value)
The partition key decides *everything*: it sets which node owns the data and whether load spreads. A key like `country` creates a hot partition (India, US dwarf others); a key like `user_id` spreads evenly. Colocate what you read together — model `(room_id) → messages sorted by ts` so one partition read serves a screen.

### BASE and convergence
BASE stores accept a write on any replica and propagate asynchronously; readers may see stale data until replicas converge. Techniques like read-repair, hinted handoff, and quorum tuning (see **Replication & Sharding**) let you dial the staleness window. Correct for a like counter; wrong for an account balance.

### Schema evolution
Relational schemas change via migrations (`ALTER TABLE`) — safe but coordinated, and slow on huge tables. Document/wide-column stores are schema-on-read: you just write the new shape and handle both versions in code. Flexibility that quietly moves the burden of consistency into your application.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Relational (SQL)** | ACID txns, joins, mature tooling, strong consistency, ad-hoc queries | Vertical scaling ceiling; sharding is manual and painful; rigid schema migrations |
| **Key-Value** | Fastest point access, trivial horizontal scale, simple mental model | No queries beyond the key, no joins, no multi-key transactions (usually) |
| **Document** | Flexible nested schema, developer-friendly, secondary indexes | Weak cross-document consistency, easy to model badly, joins limited |
| **Wide-Column** | Enormous write throughput, linear scale, fast range scans in a partition | Query rigid to key design, no ad-hoc joins, tombstone/compaction ops burden |
| **Graph** | Constant-time traversal of relationships, expressive path queries | Hard to shard, smaller scale ceiling, niche operational expertise |

Relational is the correct default: pick NoSQL when a *specific* access pattern or scale requirement breaks it, not preemptively. And "NoSQL vs SQL" is often a false choice — the mature answer is polyglot persistence, accepting the operational cost of running two engines to serve two genuinely different workloads well.

## 7. When to Use / When to Avoid

**Reach for relational (SQL) when:**
- Data is inherently relational and you need joins across entities.
- Correctness under concurrency matters — money, inventory, bookings (ACID).
- Query patterns are ad-hoc or will evolve; you want a flexible query language.
- Scale fits one primary + read replicas (the vast majority of apps).

**Reach for NoSQL when:**
- One access pattern dominates and maps cleanly to a key (cart, session, timeline).
- Write throughput or data volume exceeds a single relational primary (wide-column).
- The schema is genuinely variable per record (document).
- The problem is traversal-shaped (graph).
- **Avoid NoSQL** when you're modeling relational data, need multi-entity transactions, or are just anticipating scale you don't have — you'll rebuild joins and consistency by hand, badly.

## 8. Scaling & Production Best Practices

- **Start relational, split by workload later.** A single Postgres handles tens of thousands of QPS with read replicas and a cache before you need anything exotic.
- **Cache the hot read path** (Redis, ~sub-ms) in front of any store to absorb read spikes; see **Caching**.
- **Choose partition keys for even distribution and locality** — model one query per NoSQL table; verify no key concentrates more than a few percent of traffic.
- **Bound item and partition size.** Cassandra partitions should stay well under ~100 MB / ~100k rows; unbounded growth destroys read latency.
- **Feed derived stores via CDC/streams** (Debezium → Kafka → search/analytics) instead of dual-writes, which drift.
- **Budget for eventual consistency** explicitly: define the acceptable staleness window per feature and tune quorums/replication to it.
- **Right-size polyglot.** Every extra engine is on-call load, backups, and expertise — add one only when a workload clearly demands it.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Hot partition (skewed key) | One node saturates, tail latency spikes, throttling | Add entropy to the key (composite/salted key); shard the hot tenant separately |
| Unbounded partition/document growth | Read latency degrades, timeouts, GC pressure | Cap partition by time-bucketing; archive cold data; enforce size limits |
| Denormalized copies drift | Stale/contradictory data shown to users | Single source of truth + async propagation; periodic reconciliation jobs |
| Dual-write to two stores diverges | Silent data corruption across engines | Use CDC / outbox pattern; make one store authoritative |
| Relational primary maxed out | Writes stall, whole app slows | Read replicas, then functional/vertical split, then shard (last resort) |
| Cross-shard join needed post-sharding | Query becomes scatter-gather, slow/impossible | Denormalize the join at write time; or serve it from a derived store |

## 10. Monitoring & Metrics

- **Read/write latency p50/p95/p99** per store and per query pattern — tail latency reveals hot partitions.
- **Partition/key skew** — max-partition-size and per-key request rate; alert on any key exceeding a threshold share of traffic.
- **Replication lag** on read replicas (seconds) — gates whether replica reads are safe.
- **Cache hit ratio** — a drop pushes load onto the primary.
- **Transaction rollback / deadlock rate** (SQL) — contention hotspots.
- **Compaction backlog & tombstone ratio** (wide-column) — read amplification early warning.
- **Storage growth per table** — projects when sharding becomes unavoidable.
- **Cross-store consistency drift** — reconciliation-job mismatch counts.

## 11. Common Mistakes

1. ⚠️ Choosing NoSQL "for scale" before you have any scale, then reimplementing joins and transactions in application code.
2. ⚠️ Modeling a NoSQL store like a relational one — normalized tables you then try to join.
3. ⚠️ Picking a partition key without checking distribution, creating a hot shard on day one.
4. ⚠️ Expecting ACID or read-your-writes from a BASE/eventually-consistent store.
5. ⚠️ Denormalizing data that changes often, drowning in update fan-out and drift.
6. ⚠️ Dual-writing to two stores in application code instead of using CDC/outbox — guaranteed divergence.
7. ⚠️ Letting partitions/documents grow without bound (no time-bucketing or archival).
8. ⚠️ Adopting five datastores for a system that a single Postgres would serve fine.

## 12. Interview Questions

**Q: How do you decide between SQL and NoSQL for a new feature?**
A: I start from access patterns, not the engine. Enumerate every read/write with its QPS and latency budget, classify each (point lookup, range scan, join, aggregation, traversal), and check for transactional invariants. Relational is my default because of joins and ACID; I move a specific workload to NoSQL only when one pattern dominates and maps to a key, or when scale exceeds a single primary. Often the answer is both — polyglot persistence.

**Q: What does ACID actually guarantee, and why do NoSQL stores relax it?**
A: Atomicity, Consistency, Isolation, Durability — the contract that lets you reason about concurrency and crashes. Distributed stores relax it (to BASE) because enforcing strong consistency across partitions costs availability and latency (CAP): a globally-distributed write-heavy store would rather stay available and converge eventually than block on cross-node coordination.

**Q: Explain normalization vs denormalization and when each wins.**
A: Normalization keeps each fact in one place, preventing update anomalies; the cost is joins at read time. Denormalization duplicates data so reads touch one place; the cost is write fan-out and drift. Normalize when data is write-heavy or consistency-critical; denormalize read-heavy data with tolerable staleness — the standard NoSQL modeling move.

**Q: Walk me through the four NoSQL families and a use case for each.**
A: Key-value (cart, session) — O(1) by key, no queries. Document (product catalog) — flexible nested JSON with secondary indexes. Wide-column (chat messages, time-series) — huge write throughput and range scans within a partition. Graph (social network, fraud) — constant-time relationship traversal. Each drops joins/consistency to buy scale or a specialized access shape.

**Q: How do you design a partition key for a chat application in Cassandra?**
A: Model per query. For "last N messages in a room", partition key = `room_id`, clustering key = `ts DESC`, so one partition read serves a screen and new messages append to the sorted tail. I'd watch partition size — a mega-room could exceed limits — so I'd bucket by `(room_id, month)` to cap growth.

**Q: What is polyglot persistence and what's the cost?**
A: Using multiple stores in one system, each matched to a workload — e.g. Postgres for orders, Redis for sessions, Cassandra for events, Elasticsearch for search. The benefit is each query is cheap; the cost is operational: more engines to back up, monitor, be on-call for, and keep consistent. I add one only when a workload clearly demands it.

**Q (senior): You denormalized a user's display name into a billion message rows. The user renames. What now?**
A: I don't rewrite a billion rows synchronously. Options: (1) keep name in one place and denormalize only an immutable `user_id`, resolving the name at read via cache — trading a lookup for zero fan-out; (2) if I must denormalize the name, propagate asynchronously via a background job/stream and accept a staleness window, with reconciliation to catch failures. The real lesson is to denormalize *immutable* or rarely-changing fields, not volatile ones.

**Q (senior): Your document store is showing stale reads after a write. Diagnose and fix.**
A: Likely reading from a replica that hasn't received the write (async replication lag) or a quorum too low to guarantee overlap. Fixes: route the writer's subsequent reads to the primary (read-your-writes), raise read/write quorum so R+W>N for that operation, or use a session/consistency token. It's a consistency-level choice per operation, not a global switch — I tune it where correctness needs it and leave the rest eventual.

**Q (senior): When would you refuse to shard a relational database and do something else instead?**
A: Almost always, until forced. Before sharding I exhaust vertical scaling, read replicas, caching, and functional splits (move tables to their own DB). Sharding breaks joins, transactions, and unique constraints across shards and makes every schema change harder. I shard only when a single primary's *write* throughput or dataset size genuinely can't fit one node — and then I choose the shard key as carefully as a NoSQL partition key. See **Replication & Sharding**.

**Q (senior): Two services dual-write to Postgres and Elasticsearch and they've drifted. How do you fix it structurally?**
A: Dual-writes have no atomicity across systems — a crash between the two writes diverges them forever. The structural fix is the **outbox/CDC pattern**: write only to Postgres (in the same transaction, append to an outbox table), then a CDC pipeline (Debezium → Kafka) streams changes to Elasticsearch. Postgres is authoritative; the index is a derived, eventually-consistent projection, and a replay rebuilds it from scratch.

## 13. Alternatives & Related

- **Indexes, B-Trees & LSM-Trees** — how each engine physically stores and finds rows; explains SQL's read strength and wide-column's write strength.
- **Replication & Sharding** — how any of these stores scales out and stays available.
- **CAP & Consistency Models** — the theory behind ACID-vs-BASE and quorum tuning.
- **Caching** — the read-path accelerator you put in front of any store.
- **Consistent Hashing** — how key-value/wide-column stores place partitions across nodes.
- **NewSQL** (Spanner, CockroachDB, TiDB) — distributed stores that aim to give SQL + ACID *and* horizontal scale, blurring this whole dichotomy.

## 14. Cheat Sheet

> [!TIP]
> - **Model by access pattern, not by trend.** List reads/writes → classify → pick engine → shape schema.
> - **SQL is the default:** joins + ACID + ad-hoc queries. Reach for it unless a pattern breaks it.
> - **NoSQL families:** KV (by key), Document (nested JSON), Wide-Column (write-heavy ranges), Graph (traversal). All trade joins/consistency for scale.
> - **ACID = correctness under concurrency; BASE = availability, converge later.** Ledgers→ACID, feeds/carts→BASE.
> - **Normalize for correctness; denormalize read-heavy, rarely-changing data** — never volatile fields.
> - **Partition key is destiny:** even distribution + read locality + bounded size.
> - **Polyglot persistence is normal**, but each store is real ops cost — add deliberately.
> - **Never dual-write** across stores; use CDC/outbox with one authoritative source.

**References:** DDIA ch.2 (Data Models & Query Languages), Amazon DynamoDB paper (2007), MongoDB & Cassandra data-modeling docs, "NoSQL Distilled" (Sadalage & Fowler)

---
*System Design Handbook — topic 14.*
