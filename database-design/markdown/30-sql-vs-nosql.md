# 30 · SQL vs NoSQL: A Decision Framework

> **In one line:** "SQL vs NoSQL" is the wrong question — the right one is which storage model's physical layout and guarantees match *this* workload's access patterns, consistency and transaction needs, relationships, scale, latency and your team's operational budget, and for most workloads the honest answer starts with PostgreSQL and adds a specialised store only when a measured requirement forces it.

---

## 1. Overview

> **Builds on:** [System Design · SQL vs NoSQL & Data Modeling](../system-design/topic.html?p=14-sql-vs-nosql) (the four NoSQL families, BASE, denormalization, polyglot persistence) · [Cassandra · Cassandra vs ScyllaDB, DynamoDB & HBase](../cassandra/topic.html?p=43-cassandra-vs-alternatives) (choosing *within* the wide-column family) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) · [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem) · [Ch 21 · Database Scaling](topic.html?p=21-database-scaling). The system design chapter introduces the families; this chapter is the decision procedure you apply in a design review, with the database-internals reasons behind each step.

Every few months a team somewhere starts a new service by asking "should we use MongoDB or Postgres?" and settles it in a meeting by preference, familiarity or a blog post. A year later they discover the consequences. The document store that was "faster to develop with" now needs a multi-document transaction for every checkout and a reporting pipeline to answer any question the product manager asks. Or the relational database that was "the safe default" is being asked to ingest two million sensor readings a second across three regions. Both failures come from the same mistake: choosing a database by category name instead of by the workload's requirements.

The problem exists because database categories are **bundles of trade-offs** fixed at the storage-engine level. A wide-column store like Cassandra is fast at writes because it appends to a commit log and memtable and never reads before writing — which is also why it cannot enforce a uniqueness constraint or join. A document store is convenient because it stores an aggregate in one place — which is also why data shared across aggregates is duplicated or needs application-side joins. A relational database gives you arbitrary queries and multi-row transactions because it keeps normalized data with a general-purpose query planner and a single ordered log — which is also why scaling writes past one primary is hard. You cannot pick the benefits without the costs, so you must know which costs your workload can pay.

The naive decision methods fail predictably. **"NoSQL scales, SQL doesn't"** ignores that one well-tuned PostgreSQL node handles tens of thousands of transactions per second and many terabytes, which covers the large majority of products that will ever exist. **"Schemaless is faster to develop"** confuses *no schema enforcement* with *no schema*: the schema moves into every piece of code that reads the data. **"Use the right tool for each job"** taken literally produces six databases for a ten-person team, each with its own backups, upgrades, failure modes and on-call knowledge. The framework in this chapter replaces these slogans with a sequence of questions, answered with numbers.

> **Why this matters:** In a system design interview, "I'd use Cassandra because it scales" is a red flag; "our dominant access pattern is a time-range read per device, writes are 400k/s across two regions, we need no cross-partition transactions, so a wide-column store's partition + clustering key layout fits, and I accept eventual consistency and query rigidity" is a senior answer.

## 2. Core Concepts

- **Access pattern** — the concrete queries and writes the system performs, with frequency, shape (point, range, scan, traversal, search, aggregate) and latency target. *Why it matters:* every storage model is optimized for some patterns and hostile to others.
- **Relational** — normalized tables, SQL, general planner, multi-row ACID transactions, constraints. *Why it matters:* the only model that handles unanticipated queries well.
- **Document** — self-contained JSON/BSON documents per aggregate, secondary indexes, (now) multi-document transactions with costs. *Why it matters:* matches aggregate-shaped reads; weak for data shared across aggregates.
- **Key-value** — opaque value by key; the store knows nothing about the value. *Why it matters:* the cheapest, most scalable access path when you always know the key.
- **Wide-column** — partition key plus sorted clustering key, LSM storage, leaderless replication (Cassandra/ScyllaDB), or managed equivalents (DynamoDB, Bigtable). *Why it matters:* huge write throughput and predictable single-partition reads; queries must be designed up front.
- **Graph** — nodes and edges stored for traversal. *Why it matters:* multi-hop relationship queries that explode as SQL joins.
- **Time-series** — storage organized by time (chunks, columnar compression, retention by dropping chunks). *Why it matters:* ingest and range-aggregate over time at high volume and low cost.
- **Search** — inverted indexes, analyzers, relevance scoring, facets. *Why it matters:* text relevance and faceting are a different problem from exact-match lookups.
- **Polyglot persistence** — using several stores in one system. *Why it matters:* matches each workload to a model, and multiplies operational and consistency costs.
- **Operational complexity budget** — how many distinct data systems a team can run well (backups, upgrades, monitoring, incidents). *Why it matters:* a store you cannot operate is a worse choice than a store that fits less perfectly.
- **Source of truth vs derived store** — the store whose data is authoritative versus stores rebuilt from it (search index, cache, analytics). *Why it matters:* a specialised store is much less risky as a derived store than as the system of record.

## 3. Theory & Principles

### What each model physically does with the same data

The best way to understand the categories is to store the same thing — a customer's orders — in each, and see what the layout makes cheap and expensive.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">"Customer 42 and their orders" laid out by each model: the layout decides what is cheap</text>
  <rect x="16" y="38" width="280" height="130" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="156" y="56" text-anchor="middle" fill="#1e40af" font-weight="bold">Relational</text>
  <rect x="28" y="66" width="110" height="44" rx="4" fill="#fff" stroke="#2563eb"/>
  <text x="36" y="82" fill="#1e293b">customers</text>
  <text x="36" y="98" fill="#334155">42 | Asha</text>
  <rect x="150" y="66" width="134" height="44" rx="4" fill="#fff" stroke="#2563eb"/>
  <text x="158" y="82" fill="#1e293b">orders (heap + B-tree)</text>
  <text x="158" y="98" fill="#334155">901 | 42 | ...</text>
  <text x="28" y="130" fill="#166534">cheap: any query, joins, txns</text>
  <text x="28" y="148" fill="#b91c1c">hard: writes past one primary</text>
  <rect x="300" y="38" width="280" height="130" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="440" y="56" text-anchor="middle" fill="#166534" font-weight="bold">Document</text>
  <rect x="312" y="66" width="256" height="44" rx="4" fill="#fff" stroke="#16a34a"/>
  <text x="320" y="82" fill="#1e293b">{_id:42, name:"Asha",</text>
  <text x="320" y="98" fill="#1e293b"> orders:[{id:901, items:[...]}, ...]}</text>
  <text x="312" y="130" fill="#166534">cheap: read/write whole aggregate</text>
  <text x="312" y="148" fill="#b91c1c">hard: shared data, cross-doc queries</text>
  <rect x="584" y="38" width="280" height="130" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="724" y="56" text-anchor="middle" fill="#92400e" font-weight="bold">Key-value</text>
  <rect x="596" y="66" width="256" height="44" rx="4" fill="#fff" stroke="#d97706"/>
  <text x="604" y="82" fill="#1e293b">"cust:42:orders" -&gt; opaque bytes</text>
  <text x="604" y="98" fill="#334155">store cannot look inside</text>
  <text x="596" y="130" fill="#166534">cheap: get/put by key, any scale</text>
  <text x="596" y="148" fill="#b91c1c">hard: everything else</text>
  <rect x="16" y="180" width="280" height="130" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="156" y="198" text-anchor="middle" fill="#5b21b6" font-weight="bold">Wide-column</text>
  <rect x="28" y="208" width="256" height="44" rx="4" fill="#fff" stroke="#7c3aed"/>
  <text x="36" y="224" fill="#1e293b">partition 42: rows sorted by</text>
  <text x="36" y="240" fill="#1e293b">(order_ts DESC) -&gt; one sequential read</text>
  <text x="28" y="272" fill="#166534">cheap: huge writes, partition range</text>
  <text x="28" y="290" fill="#b91c1c">hard: ad-hoc queries, joins, uniques</text>
  <rect x="300" y="180" width="280" height="130" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="440" y="198" text-anchor="middle" fill="#991b1b" font-weight="bold">Graph</text>
  <circle cx="340" cy="232" r="16" fill="#fff" stroke="#dc2626"/>
  <text x="340" y="236" text-anchor="middle" fill="#1e293b">42</text>
  <circle cx="420" cy="220" r="16" fill="#fff" stroke="#dc2626"/>
  <text x="420" y="224" text-anchor="middle" fill="#1e293b">901</text>
  <circle cx="500" cy="238" r="16" fill="#fff" stroke="#dc2626"/>
  <text x="500" y="242" text-anchor="middle" fill="#1e293b">sku</text>
  <line x1="356" y1="229" x2="404" y2="222" stroke="#dc2626"/>
  <line x1="436" y1="223" x2="484" y2="235" stroke="#dc2626"/>
  <text x="312" y="272" fill="#166534">cheap: multi-hop traversal</text>
  <text x="312" y="290" fill="#b91c1c">hard: bulk scans, sharding</text>
  <rect x="584" y="180" width="280" height="130" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="724" y="198" text-anchor="middle" fill="#334155" font-weight="bold">Time-series</text>
  <rect x="596" y="208" width="60" height="44" rx="4" fill="#fff" stroke="#94a3b8"/>
  <text x="604" y="234" fill="#334155">Mon</text>
  <rect x="664" y="208" width="60" height="44" rx="4" fill="#fff" stroke="#94a3b8"/>
  <text x="672" y="234" fill="#334155">Tue</text>
  <rect x="732" y="208" width="120" height="44" rx="4" fill="#fff" stroke="#94a3b8"/>
  <text x="740" y="226" fill="#334155">Wed (hot, row)</text>
  <text x="740" y="242" fill="#334155">old: columnar</text>
  <text x="596" y="272" fill="#166534">cheap: ingest, time aggregates</text>
  <text x="596" y="290" fill="#b91c1c">hard: updates, entity queries</text>
  <rect x="16" y="322" width="848" height="134" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="340" text-anchor="middle" fill="#1e293b" font-weight="bold">Search (inverted index): "wireless" -&gt; [901, 1733, 88012 ...], scored by BM25, faceted by brand/price</text>
  <text x="32" y="362" fill="#166534">cheap: relevance-ranked text search, typo tolerance, facets and aggregations over matches</text>
  <text x="32" y="380" fill="#b91c1c">hard: transactions, being the source of truth, frequent partial updates (documents are reindexed)</text>
  <text x="32" y="408" fill="#1e293b" font-weight="bold">Every "hard" line is a consequence of the same layout that makes the "cheap" line cheap.</text>
  <text x="32" y="428" fill="#1e293b">So the question is never which model is better, but which model's cheap operations are your frequent ones</text>
  <text x="32" y="446" fill="#1e293b">and whether you can live with its hard ones.</text>
</svg>
```

### The categories, with the trade-off that matters most

| Category | Examples | Storage essence | Strength | The cost you must accept |
|---|---|---|---|---|
| Relational | PostgreSQL, MySQL, SQL Server; distributed: CockroachDB, Spanner, YugabyteDB | B-tree/heap, normalized, planner, WAL | ad-hoc queries, joins, constraints, multi-row ACID | write scale-out is hard (or costs latency in distributed SQL) |
| Document | MongoDB, Couchbase, Firestore | one document per aggregate, B-tree secondary indexes | aggregate reads, evolving shape per record | cross-aggregate data duplicated; transactions exist but cost more; ad-hoc analytics weak |
| Key-value | Redis, DynamoDB (as KV), Memcached, etcd | hash / partition by key | lowest latency, simplest scaling | no queries beyond the key |
| Wide-column | Cassandra, ScyllaDB, Bigtable, HBase, DynamoDB | partition + sorted clustering, LSM | massive writes, multi-region, predictable reads | query-first modeling, no joins, limited transactions, tombstones |
| Graph | Neo4j, Neptune, JanusGraph | adjacency (index-free in Neo4j) | deep, variable-length traversals | sharding and bulk analytics are hard; niche ops skills |
| Time-series | TimescaleDB, InfluxDB, ClickHouse (OLAP), Prometheus (metrics) | time-partitioned chunks, columnar compression | ingest + time aggregates, cheap retention | poor for updates and entity-centric queries |
| Search | Elasticsearch, OpenSearch, Solr | inverted index + doc values | relevance, fuzziness, facets | near-real-time (refresh ~1 s), not a transactional source of truth |

A few precise points people get wrong: modern MongoDB supports multi-document ACID transactions (since 4.0 on replica sets, 4.2 across shards), but a schema that needs them on every hot path is a sign the data was relational. DynamoDB supports transactions of up to 100 items and strongly consistent reads on the base table, but global secondary indexes are eventually consistent and every item is limited to 400 KB. Cassandra's lightweight transactions use Paxos and cost several round trips, so they are for rare compare-and-set, not for normal writes. Elasticsearch documents become searchable after a refresh (default 1 second), so "write then search" is not read-your-writes.

### The decision framework

The order of questions matters: early questions eliminate options cheaply, later ones choose among the survivors.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c30b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Seven questions, in order; each one narrows the candidate set</text>
  <rect x="20" y="40" width="200" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="120" y="60" text-anchor="middle" fill="#1e40af" font-weight="bold">1. Access pattern</text>
  <text x="120" y="78" text-anchor="middle" fill="#1e293b">point, range, scan, search, graph?</text>
  <rect x="240" y="40" width="200" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="340" y="60" text-anchor="middle" fill="#1e40af" font-weight="bold">2. Consistency</text>
  <text x="340" y="78" text-anchor="middle" fill="#1e293b">stale reads OK? for which reads?</text>
  <rect x="460" y="40" width="200" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="560" y="60" text-anchor="middle" fill="#1e40af" font-weight="bold">3. Transactions</text>
  <text x="560" y="78" text-anchor="middle" fill="#1e293b">multi-entity invariants?</text>
  <rect x="680" y="40" width="180" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="770" y="60" text-anchor="middle" fill="#1e40af" font-weight="bold">4. Relationships</text>
  <text x="770" y="78" text-anchor="middle" fill="#1e293b">joins? depth of traversal?</text>
  <path d="M220,65 L238,65" stroke="#334155" stroke-width="2" marker-end="url(#c30b1)"/>
  <path d="M440,65 L458,65" stroke="#334155" stroke-width="2" marker-end="url(#c30b1)"/>
  <path d="M660,65 L678,65" stroke="#334155" stroke-width="2" marker-end="url(#c30b1)"/>
  <rect x="130" y="130" width="200" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="230" y="150" text-anchor="middle" fill="#92400e" font-weight="bold">5. Scale</text>
  <text x="230" y="168" text-anchor="middle" fill="#1e293b">writes/s, data size, regions</text>
  <rect x="350" y="130" width="200" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="450" y="150" text-anchor="middle" fill="#92400e" font-weight="bold">6. Latency</text>
  <text x="450" y="168" text-anchor="middle" fill="#1e293b">p99 target, from where</text>
  <rect x="570" y="130" width="200" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="670" y="150" text-anchor="middle" fill="#92400e" font-weight="bold">7. Ops complexity</text>
  <text x="670" y="168" text-anchor="middle" fill="#1e293b">who runs it at 3 a.m.?</text>
  <path d="M770,90 L770,110 L230,110 L230,128" stroke="#334155" stroke-width="2" fill="none" marker-end="url(#c30b1)"/>
  <path d="M330,155 L348,155" stroke="#334155" stroke-width="2" marker-end="url(#c30b1)"/>
  <path d="M550,155 L568,155" stroke="#334155" stroke-width="2" marker-end="url(#c30b1)"/>
  <rect x="20" y="210" width="410" height="150" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="225" y="230" text-anchor="middle" fill="#1e293b" font-weight="bold">What each answer rules out</text>
  <text x="34" y="252" fill="#334155">ad-hoc / unknown future queries: rules out KV, wide-column</text>
  <text x="34" y="270" fill="#334155">relevance text search on the hot path: add a search index</text>
  <text x="34" y="288" fill="#334155">multi-entity invariants (money, stock): needs ACID across them</text>
  <text x="34" y="306" fill="#334155">many-to-many, shared entities: relational beats document</text>
  <text x="34" y="324" fill="#334155">writes beyond one primary + multi-region writes: wide-col / dist SQL</text>
  <text x="34" y="342" fill="#334155">sub-ms p99 on hot keys: in-memory KV in front</text>
  <rect x="450" y="210" width="410" height="150" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="655" y="230" text-anchor="middle" fill="#166534" font-weight="bold">Default path when nothing rules it out</text>
  <text x="464" y="252" fill="#14532d">PostgreSQL (managed) as the source of truth</text>
  <text x="464" y="270" fill="#14532d">+ JSONB for variable attributes</text>
  <text x="464" y="288" fill="#14532d">+ pg_trgm / full-text for simple search</text>
  <text x="464" y="306" fill="#14532d">+ PostGIS / TimescaleDB / pgvector extensions</text>
  <text x="464" y="324" fill="#14532d">+ read replicas, partitioning, cache (Ch 21 ladder)</text>
  <text x="464" y="342" fill="#14532d">add a specialised store only for a MEASURED gap</text>
  <rect x="20" y="380" width="840" height="106" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="440" y="400" text-anchor="middle" fill="#991b1b" font-weight="bold">When a specialised store earns its place, prefer it as a DERIVED store first</text>
  <text x="36" y="422" fill="#7f1d1d">source of truth stays transactional; search index / cache / analytics / graph projection are fed by CDC or outbox</text>
  <text x="36" y="442" fill="#7f1d1d">a derived store can be rebuilt, so its failures cost freshness, not data</text>
  <text x="36" y="462" fill="#7f1d1d">make it the system of record only when the source itself cannot meet scale, latency or availability (e.g. multi-region writes)</text>
</svg>
```

**1. Access pattern.** List the top queries with frequency and shape. Point lookups by a known key fit everything; ranges within one entity fit relational and wide-column; unanticipated filters, joins and aggregations fit only relational (or a warehouse); relevance search needs an inverted index; variable-depth traversals need a graph. If you cannot list the access patterns yet, that is itself an answer: choose the store that tolerates not knowing — relational.

**2. Consistency requirement.** For each read, ask what happens if it is stale. A product listing can be seconds stale; an account balance used to authorize a payment cannot. Stores that are eventually consistent by default (Cassandra at `ONE`, DynamoDB default reads, search indexes, async replicas) are fine for the first and dangerous for the second. See [Ch 10 · Consistency Models](topic.html?p=10-consistency-models).

**3. Transaction requirement.** Identify invariants spanning multiple entities: "debits equal credits", "never oversell a seat", "a username is unique". Relational databases enforce these with multi-row transactions and constraints. In stores without them you rebuild them with conditional writes, Paxos-based compare-and-set, sagas and reconciliation — which is possible, but it is engineering you are signing up for.

**4. Data relationships.** Many-to-many relationships and entities shared across aggregates (a product referenced by orders, carts, reviews) favour normalization and joins. Strictly hierarchical data that is always read as a unit (a document with its line items) favours documents. Deep or variable-length traversals ("friends of friends of friends who like X") favour graphs; one or two hops are fine with SQL joins or recursive CTEs.

**5. Scale.** Put numbers on writes per second, reads per second, data size and growth, and the number of regions that must accept writes. A single modern PostgreSQL primary with good hardware handles on the order of tens of thousands of write transactions per second and many TB; read replicas and caches scale reads much further ([Ch 21](topic.html?p=21-database-scaling), [Ch 22](topic.html?p=22-capacity-planning)). When sustained writes exceed what one primary can apply, or when multiple regions must accept writes locally, you need sharding, distributed SQL, or a leaderless/partitioned store.

**6. Latency.** State the p99 target and where the client is. Sub-millisecond p99 means memory (Redis, or a cache in front). Single-digit milliseconds at any scale is DynamoDB and Cassandra's design point for single-partition operations. Cross-region strongly consistent writes cost at least one inter-region round trip whatever the product ([Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases)).

**7. Operational complexity.** Who will run it: backups and restores ([Ch 26](topic.html?p=26-backup-disaster-recovery)), upgrades, capacity, monitoring, incidents at 3 a.m.? A managed service reduces but does not remove this. Each additional store needs someone who understands its failure modes — compaction and tombstones in Cassandra, shard balancing in Elasticsearch, hot partitions in DynamoDB. If no one on the team does, the "better" store is worse.

## 4. Architecture & Workflow

### "Postgres can do most of it" — and where the limits are

PostgreSQL's extensibility covers a large share of what teams reach for other stores to do:

| Need | In PostgreSQL | Good enough while | Specialised store earns its place when |
|---|---|---|---|
| Flexible attributes | `jsonb` + GIN index (`jsonb_path_ops`), generated columns for hot keys | documents are part of a relational model | the whole domain is aggregate-shaped and schema varies wildly per record, at huge scale |
| Fuzzy/substring search | `pg_trgm` GIN/GiST (`ILIKE`, similarity) | admin search, autocomplete on modest data | relevance tuning, synonyms, typo tolerance at scale, facets on millions of docs |
| Full-text search | `tsvector` + GIN, `ts_rank` | simple keyword search in one language | multi-language analyzers, BM25 relevance, learning-to-rank, heavy faceting |
| Geospatial | PostGIS (GiST indexes, geography type) | most location workloads | extreme write rates of moving points (often solved with Redis geo or in-memory grids for the hot part) |
| Time series | TimescaleDB hypertables, compression, continuous aggregates; or native partitions + BRIN | ingest fits one node, queries are time-range + entity | ingest beyond one node, or heavy OLAP on billions of rows (ClickHouse) |
| Queues | `FOR UPDATE SKIP LOCKED`, `LISTEN/NOTIFY` | job queues at moderate throughput | high fan-out streaming, replay, many consumer groups (Kafka) |
| Vectors | pgvector (HNSW, IVFFlat) | embeddings with filters, up to many millions | billions of vectors, specialised ANN at very low latency |
| Graph | recursive CTEs, adjacency tables | 1–3 hops, bounded fan-out | deep variable-length traversals and graph algorithms on the hot path |
| Cache | shared buffers, materialized views | reads fit in RAM, ms latency OK | sub-ms p99, very high QPS on hot keys (Redis) |

The strongest argument for this approach is not that PostgreSQL is best at each of these — it usually is not — but that doing them **inside the same transactional store** removes an entire class of consistency problems (no dual writes, no sync lag, one backup, one security model), and one team can operate it. The strongest argument against is that extensions share one node's CPU, memory and I/O with your OLTP workload: a heavy full-text or analytical workload can hurt checkout latency. Moving that workload to a replica often resolves it before a new store is needed.

### Polyglot persistence and its bill

Polyglot persistence is normal in large systems: a relational source of truth for orders and payments, Redis for sessions and hot reads, a search index for the catalog, Kafka as the change log, a warehouse for analytics. What the slogan hides is the bill:

- **Consistency between stores.** Every derived store needs a synchronization path, and the naive one (dual writes in application code) is wrong. You need an outbox or CDC ([Ch 29](topic.html?p=29-advanced-database-patterns)), idempotent consumers, rebuild tooling, and reconciliation jobs.
- **Operations multiplied.** Backups, restore drills, upgrades, security patches, capacity planning, dashboards and alerts — per store.
- **Failure modes multiplied.** Each store fails differently; incidents now involve reasoning about lag between stores ("search shows the product, the database says it is deleted").
- **Expertise.** Every store needs at least two people who can debug it under pressure.
- **Cost.** Duplicate data in several stores, each with its own replicas.

A useful rule: add a store when it removes more complexity than it adds — typically when it replaces a workaround that is already hurting, backed by measurements.

### Worked decisions

**Workload A — B2B invoicing SaaS.** 3,000 tenant companies, 40 M invoices, 200 writes/s peak, 2,000 reads/s, reports by tenant and period, strict correctness (invoice numbers unique per tenant, payments reconcile), customers add custom fields.

- Access: tenant-scoped lookups, lists, filters, ad-hoc reports → needs a flexible query engine.
- Consistency and transactions: strong; multi-row invariants (invoice + lines + payment allocation).
- Relationships: many (customers, invoices, lines, payments, tax rates).
- Scale: tiny for one node; 40 M rows is small.
- **Decision:** PostgreSQL. Custom fields in a `jsonb` column with GIN index; `(tenant_id, ...)` leading composite indexes; row-level security for tenant isolation; a read replica for reports. A document store would push invariants into application code for no scaling benefit. Revisit only if a tenant's reporting load needs a warehouse.

**Workload B — IoT telemetry.** 500,000 devices report every 10 s → 50,000 inserts/s sustained, 3 metrics each, 90-day retention (50,000 × 86,400 × 90 ≈ 389 billion readings), queries: "last 24 h for device X" (frequent), fleet aggregates per 5 minutes (dashboards), no updates.

- Access: time-range per device + time-bucketed aggregates; append-only.
- Consistency: relaxed; a lost reading is tolerable, duplicates can be deduped by (device, ts).
- Transactions: none across entities.
- Scale: 50k/s is feasible on a well-sized TimescaleDB node with batched inserts, and compression makes 90 days of narrow readings manageable; but ~389 B rows is heavy for one node's storage and query budget.
- **Decision:** TimescaleDB (hypertable partitioned by time, compression after 1 day, continuous aggregates for 5-minute rollups, retention policy dropping chunks after 90 days) if a single node's storage and ingest headroom checks out in a load test. If the fleet is expected to grow 10× or ingest must be multi-region, Cassandra/ScyllaDB with partition key `(device_id, day)` and clustering by `ts DESC`, TWCS and TTL for raw data, plus ClickHouse for fleet analytics — accepting two stores and a pipeline between them.

**Workload C — marketplace product search.** 8 M products, 2,000 searches/s, typo tolerance, synonyms, faceted filters (brand, price bucket, rating), relevance tuned by sales; catalog updates 300/s.

- Access: relevance-ranked text search with facets — an inverted-index problem.
- Consistency: seconds of staleness acceptable for search; price and stock at checkout must be authoritative.
- **Decision:** PostgreSQL as the source of truth for the catalog, OpenSearch/Elasticsearch as a **derived** index fed by CDC from the catalog tables (or outbox events), rebuildable from scratch by reindexing. Checkout re-reads price and stock from PostgreSQL. `pg_trgm` remains for internal admin search. Using the search engine as the system of record would give up transactions and make reindex-on-mapping-change dangerous.

**Workload D — global shopping cart.** 30 M daily users on three continents, carts read and written on every page view (peak 150,000 ops/s), p99 < 20 ms from each region, cart must stay writable during a regional outage, occasional lost update acceptable (merge by item), no cross-user transactions.

- Access: get/put by cart ID; single-item updates.
- Consistency: availability and local latency over linearizability; conflicts resolvable (union of items).
- Scale: high, multi-region writes.
- **Decision:** DynamoDB global tables (or Cassandra with `LOCAL_QUORUM` per region) keyed by cart ID, with item-level attributes to reduce conflict scope and last-writer-wins per attribute; TTL to expire abandoned carts. At checkout, the cart is copied into the relational order system where transactions and invariants apply. A single-primary PostgreSQL would force cross-region write latency or give up writability during a region loss.

A pattern emerges: the transactional core stays relational; specialised stores appear at the edges, for access patterns (search), scale and geography (carts), or data shape (time series) that the core cannot serve well — and each has a defined relationship to the source of truth.

## 5. Implementation

### Simple example: making "document" data relational-friendly in PostgreSQL

```sql
CREATE TABLE products (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id   bigint NOT NULL,
  name        text   NOT NULL,
  attrs       jsonb  NOT NULL DEFAULT '{}',          -- per-category attributes
  brand       text GENERATED ALWAYS AS (attrs->>'brand') STORED,  -- hot key promoted
  search_tsv  tsvector GENERATED ALWAYS AS
                (to_tsvector('english', name || ' ' || coalesce(attrs->>'description',''))) STORED
);
CREATE INDEX products_attrs_gin ON products USING gin (attrs jsonb_path_ops);
CREATE INDEX products_brand     ON products (tenant_id, brand);
CREATE INDEX products_search    ON products USING gin (search_tsv);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX products_name_trgm ON products USING gin (name gin_trgm_ops);

-- containment query served by the GIN index
SELECT id, name FROM products WHERE attrs @> '{"color":"black","wireless":true}';
-- typo-tolerant name lookup
SELECT id, name, similarity(name, 'wirless hedphones') AS s
FROM products WHERE name % 'wirless hedphones' ORDER BY s DESC LIMIT 10;
```

This gives you document-style flexibility with relational guarantees around it. Promote keys you filter on often into generated columns with B-tree indexes: GIN on JSONB is great for containment but has no statistics per key and cannot serve range queries or sorting on a key.

### Real-world example: validate the choice with a load test before committing

The framework produces a hypothesis. Numbers confirm it. For Workload B, before choosing between TimescaleDB and Cassandra, measure the single-node ceiling:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE TABLE readings (
  device_id bigint      NOT NULL,
  ts        timestamptz NOT NULL,
  temp      real, humidity real, battery real
);
SELECT create_hypertable('readings', by_range('ts', INTERVAL '1 day'));
CREATE INDEX ON readings (device_id, ts DESC);
ALTER TABLE readings SET (timescaledb.compress, timescaledb.compress_segmentby = 'device_id');
SELECT add_compression_policy('readings', INTERVAL '1 day');
SELECT add_retention_policy('readings', INTERVAL '90 days');
```

```python
# load generator: batched multi-row inserts via COPY, N parallel writers
import psycopg, time, random
def writer(dsn, device_range, batch=5000):
    with psycopg.connect(dsn) as c, c.cursor() as cur:
        while True:
            t0 = time.time()
            with cur.copy("COPY readings (device_id, ts, temp, humidity, battery) FROM STDIN") as cp:
                now = time.time()
                for _ in range(batch):
                    cp.write_row((random.choice(device_range), now, 21.5, 40.0, 3.7))
            c.commit()
            report("rows_per_s", batch / (time.time() - t0))
```

Record sustained rows/s, p99 insert latency, CPU, WAL rate, replica lag and query latency for "last 24 h of device X" *while* ingest runs, and project storage after compression for 90 days. If the numbers leave 2–3× headroom over the forecast, the simpler single-store design wins. If they do not, you have the evidence for the distributed design — and the same harness becomes the benchmark for Cassandra.

For the equivalent wide-column design, the table is shaped by the query:

```sql
-- CQL (Cassandra / ScyllaDB)
CREATE TABLE readings_by_device_day (
  device_id bigint, day date, ts timestamp,
  temp float, humidity float, battery float,
  PRIMARY KEY ((device_id, day), ts)
) WITH CLUSTERING ORDER BY (ts DESC)
  AND compaction = {'class': 'TimeWindowCompactionStrategy',
                    'compaction_window_unit': 'DAYS', 'compaction_window_size': 1}
  AND default_time_to_live = 7776000;   -- 90 days
```

Notice what disappeared: there is no way to ask "all devices with battery < 3.3 V" without scanning everything or maintaining another table for that query. That is the trade you accept in exchange for linear write scaling ([Cassandra · Query-First Data Modeling](../cassandra/topic.html?p=07-query-first-data-modeling)).

> **MySQL difference:** Everything in the "Postgres can do most of it" table has a MySQL counterpart of varying maturity: a `JSON` type with multi-valued and functional indexes (index a generated column for hot keys), `FULLTEXT` indexes in InnoDB, spatial types with R-tree indexes, and `SKIP LOCKED` since 8.0. There is no equivalent extension ecosystem (no TimescaleDB, PostGIS-level GIS or pgvector in core MySQL, though vendors offer variants), so specialised stores tend to appear earlier in MySQL shops. For write scale-out, the MySQL world's standard answer is **Vitess** (sharding with a proxy layer), which keeps the relational model per shard.

## 6. Advantages, Disadvantages & Trade-offs

| Choice | You gain | You pay | Choose it when | Avoid it when |
|---|---|---|---|---|
| Single PostgreSQL (+ replicas, cache) | one source of truth, ACID, any query, simplest ops | vertical write ceiling, extensions share one node | most products; unknown future queries | proven write scale or multi-region writes beyond one primary |
| Document store as primary | aggregate-shaped reads/writes, flexible schema | duplication, app-side joins, weaker ad-hoc analytics | content, catalogs, profiles read as a unit | heavy many-to-many, cross-aggregate invariants |
| Wide-column / DynamoDB as primary | linear write scale, multi-region, predictable latency | query-first rigidity, limited transactions, modeling effort | known access patterns at very large scale | evolving queries, relational invariants, small data |
| Distributed SQL | SQL + transactions + horizontal scale | higher write latency, cost, newer ops model | relational core that outgrew one primary | a single node would do |
| Search engine (derived) | relevance, facets, fuzziness | sync pipeline, reindex ops | real product search | as the source of truth |
| Graph DB (derived or primary) | deep traversal performance | scaling, niche skills | traversal-heavy features on the hot path | 1–2 hop queries |
| Polyglot | best fit per workload | consistency pipelines, ops per store | each store removes a measured pain | "right tool for the job" as a slogan |

### When to use NoSQL (the right reasons)

- A **dominant, known access pattern** by key or partition, at a scale or write rate that a single relational primary cannot sustain even with partitioning, replicas and caching.
- **Multi-region active-active writes** with local latency and availability during region loss, where conflict resolution is acceptable for the data.
- A **data shape** the relational model handles poorly at your scale: time series at very high ingest, relevance search, deep graph traversal, sub-millisecond key lookups.
- A **managed serverless** operating model (e.g. DynamoDB) is itself the requirement: no capacity planning, per-request pricing for spiky workloads — and the access patterns fit.

### When NOT to use NoSQL (the wrong reasons)

- **"Schemaless is faster."** The schema moves into application code; every reader must handle every historical shape. It is faster for week one, slower for year two.
- **"SQL doesn't scale."** It scales further than most products will ever need; measure first.
- **"Joins are slow."** Indexed joins on selective predicates are fast; the alternative (denormalization) moves cost to writes and consistency.
- **"We might need scale."** Designing for 100× hypothetical load while paying the query-rigidity cost at 1× is a bad trade; the scaling ladder ([Ch 21](topic.html?p=21-database-scaling)) lets you defer.
- **"The data is JSON."** JSON on the wire says nothing about storage; JSONB in a relational table handles it.
- **Resume or fashion.** A store nobody on the team can operate is a liability, whatever its benchmark.

## 7. Common Mistakes & Best Practices

- **Choosing before listing access patterns.** Teams pick a store, then discover their top query is a cross-entity filter it cannot serve. Instead: write the top 10 queries with frequencies before the choice.
- **Using a NoSQL store for relational data.** Many-to-many relationships stored in documents become duplicated data and application joins, and consistency bugs follow. Instead: relational for relational data; documents inside it where they fit.
- **Using a relational store as a KV cache at extreme QPS.** A hot key read 200,000 times a second hits one row and one CPU. Instead: a cache or KV store in front, with invalidation designed properly ([Ch 19](topic.html?p=19-database-caching-architecture)).
- **Making a search index the source of truth.** Mapping changes require reindexing from a source that no longer exists. Instead: search as a derived, rebuildable store.
- **Dual-writing to several stores from the application.** Divergence on every partial failure. Instead: outbox or CDC with idempotent consumers.
- **Ignoring hot partitions.** DynamoDB and Cassandra scale by partition; one celebrity key concentrates load on one partition's limits (for DynamoDB on the order of 3,000 reads and 1,000 writes per second per partition). Instead: model keys for spread, add write sharding suffixes for hot keys.
- **Assuming "eventually consistent" means "consistent soon enough" everywhere.** A read-modify-write on stale data loses updates. Instead: identify which reads feed writes and give those strong reads or conditional writes.
- **Best practice:** start from a transactional source of truth, derive specialised stores from it, prove every new store with a load test and an operational runbook, and write down which store is authoritative for each entity.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

- **The reporting request that the document store could not answer.** Six months in, finance asks for revenue by product category by region by month. Orders are documents with embedded products; categories live in another collection; the aggregation pipeline scans everything and times out. Root cause: an access pattern not in the original list, on a store that tolerates unknown queries poorly. Fix: stream changes into a warehouse; long term, keep relational data relational.
- **Search shows deleted products.** The application deletes from PostgreSQL and then from Elasticsearch; the second call times out. Customers click products that 404. Root cause: dual write. Fix: CDC-driven indexing with a reconciliation job comparing IDs nightly.
- **DynamoDB throttling on launch day.** A single `pk = "leaderboard"` item receives all writes; requests throttle while table-level capacity is mostly idle. Root cause: hot partition. Fix: write sharding (`leaderboard#0..#15`) and a scatter-gather read, or move the leaderboard to Redis sorted sets.
- **Cassandra read latency creeping up.** A queue-like table (insert, then delete when processed) accumulates tombstones; reads scan thousands of tombstones per query. Root cause: an anti-pattern for LSM stores ([Cassandra · Data Modeling Anti-Patterns](../cassandra/topic.html?p=12-data-modeling-antipatterns)). Fix: redesign as time-bucketed partitions that expire whole, or use a real queue.
- **The Postgres node doing five jobs.** OLTP, full-text search, analytics dashboards and a job queue share one primary; a dashboard query saturates I/O at month-end and checkout p99 triples. Fix: move analytics to a replica or warehouse, then reassess — the answer may still not be a new store.

### What to monitor when running more than one store

| Signal | Why |
|---|---|
| Replication/CDC lag into each derived store | freshness SLO per store |
| Reconciliation mismatch counts (source vs derived) | detects silent divergence |
| Per-partition throttling / hot key metrics (DynamoDB, Cassandra) | uneven load hides behind healthy averages |
| Tombstones per read, compaction backlog (Cassandra) | LSM health |
| Search index refresh and indexing lag, rejected requests | search freshness and capacity |
| Per-store backup success and restore drill results | every store is a backup obligation |
| Cost per store per month vs traffic | polyglot cost drift |

### Scaling notes

The scaling path of a well-chosen design usually looks like: single PostgreSQL → replicas and caching → partitioning → offload analytics and search to derived stores → shard or move a specific high-scale domain to a store built for it (or to distributed SQL). Each step is taken for a measured reason ([Ch 21 · Database Scaling](topic.html?p=21-database-scaling)). Migrating the system of record between models later is expensive — weeks to months of dual writes, backfills and verification ([Ch 27](topic.html?p=27-schema-evolution)) — which is exactly why the initial choice should favour the model that keeps the most options open.

## 9. Interview Questions

**Q: Why is "SQL doesn't scale" a weak argument for choosing NoSQL?**
A: Because the claim ignores both the numbers and the options. A single well-provisioned PostgreSQL or MySQL primary handles on the order of tens of thousands of write transactions per second and many terabytes, read replicas and caches multiply read capacity, and partitioning keeps large tables manageable — which covers most products for their whole life. Beyond that, relational databases shard (Citus, Vitess) or you move to distributed SQL, which keeps transactions. NoSQL stores scale writes more easily because they give up joins, general queries and multi-entity transactions; that is a good trade only if your workload does not need those things. The real question is whether your measured write rate and geography exceed what the relational options can deliver.

**Q: What does a document database make easy, and what does it make hard?**
A: It makes aggregate-shaped access easy: an entity and everything it owns is stored together, so reading or writing the whole aggregate is one operation, and fields can vary from document to document. It makes data shared across aggregates hard: a product referenced by many orders is either duplicated into each (and must be updated everywhere) or referenced and joined in application code or with lookups that are less efficient than relational joins. Invariants across documents need multi-document transactions, which modern MongoDB supports but at a cost, and ad-hoc analytical queries across collections are weaker. It fits catalogs, content and profiles; it fits badly when the data is a web of many-to-many relationships.

**Q: Walk me through the decision framework you use to choose a database.**
A: I go in order: access patterns first, with frequencies and shapes, because they eliminate models whose cheap operations do not match; then consistency requirements per read, then multi-entity transaction needs, then the relationships in the data. Those four usually decide the model. Then scale — writes per second, data size, regions that write — decides whether one node is enough or I need partitioned or distributed storage; latency targets decide whether I need memory-resident stores or regional placement; and finally operational complexity asks who will run it and whether we already run something that fits. Absent a strong reason, the default is a managed PostgreSQL as the source of truth, with specialised stores derived from it.

**Q: When would you choose Elasticsearch or OpenSearch alongside PostgreSQL, and when is PostgreSQL full-text search enough?**
A: PostgreSQL full-text search with `tsvector` and GIN, plus `pg_trgm` for fuzzy matching, is enough for keyword search on moderate data, admin tools and simple autocomplete, with the big benefit of being transactional and in one store. I add a search engine when search is a product feature that needs relevance tuning (BM25 scoring, boosting by popularity), typo tolerance and synonyms at scale, multi-language analyzers, and fast faceted aggregations over millions of documents at high QPS. Even then I keep PostgreSQL as the source of truth and feed the index through CDC or an outbox, so the index is rebuildable and checkout reads authoritative data.

**Q: What are the hidden costs of polyglot persistence?**
A: Each store needs a synchronization path from the source of truth, and doing that correctly means outbox or CDC pipelines, idempotent consumers, rebuild tooling and reconciliation. Each store also brings its own backups, restore drills, upgrades, monitoring, security configuration and capacity planning, and its own failure modes that on-call engineers must understand. Incidents become harder because they involve lag and divergence between stores. And data is duplicated, so cost rises. None of this means polyglot is wrong — it means every store must pay for itself by removing a measured pain.

**Q: Which reads can tolerate eventual consistency, and how do you find the ones that cannot?**
A: Reads that are displayed and not acted upon — feeds, product listings, analytics, recommendation lists — can usually be seconds stale. The dangerous ones are reads that feed a decision or a write: checking a balance before a withdrawal, checking stock before reserving, reading a counter before incrementing it, and read-your-own-writes flows where a user expects to see what they just saved. I find them by tracing each write path backwards to the reads it depends on. Those get strongly consistent reads, conditional writes (compare-and-set on a version) or a transaction; everything else can use replicas, caches or eventually consistent stores.

**Q: How does a hot partition happen in DynamoDB or Cassandra, and how do you fix it?**
A: Both distribute data by hashing the partition key, so throughput scales across partitions only if load spreads across many keys. When one key receives a large share of traffic — a celebrity's timeline, a global counter, a "today" partition for time-series data — all of it lands on one partition, which has its own throughput limit (in DynamoDB, on the order of thousands of reads and about a thousand writes per second per partition) and on a few replica nodes in Cassandra. Symptoms are throttling or latency spikes while overall capacity looks idle. Fixes include write sharding with a suffix and scatter-gather reads, bucketing time-series keys more finely, caching hot reads, or moving that specific feature to a store better suited to it, such as Redis for counters and leaderboards.

**Q: Your team wants to move from PostgreSQL to MongoDB "for flexibility". How do you evaluate the proposal? (Senior)**
A: I would ask what concrete problem they are trying to solve, because "flexibility" usually means one of three things: schema changes are painful, some entities have variable attributes, or developers prefer working with documents. Painful migrations are usually a process problem solved by expand/contract and online DDL tooling; variable attributes are solved by JSONB columns with GIN indexes and generated columns for hot keys; developer ergonomics can be addressed with better data access layers. Then I would list the access patterns and invariants: if the data has many-to-many relationships, cross-entity invariants and ad-hoc reporting needs, a document store would push joins and consistency into application code. I would also price the migration itself — dual writes, backfill, verification, retraining, new operational runbooks. If after that a bounded domain is genuinely aggregate-shaped and independent, moving just that domain may be reasonable; wholesale migration for flexibility rarely is.

**Q: Design the storage for a global ride-hailing app's trip history, driver locations and payments, and justify each store. (Senior)**
A: I would split by access pattern and consistency. Driver locations are high-frequency, short-lived writes queried by proximity; the latest location per driver belongs in an in-memory store with geo indexing (Redis geo sets, or an in-memory grid service), sharded by city, with no durability requirement beyond seconds. Trip history is append-heavy, read by rider or driver and time, and huge; a wide-column store partitioned by (user_id, month) and clustered by time, or PostgreSQL partitioned by time if volume allows, with old data exported to a warehouse. Payments need multi-row invariants, idempotency and auditability, so they stay in a relational database with strong consistency, per region, with the outbox publishing events. The trip state machine for active trips needs strong consistency per trip and can live in the relational store keyed by trip ID. Each derived view — analytics, search, dashboards — is fed by CDC, and I would state which store is authoritative for each entity.

**Q: How would you decide between distributed SQL (CockroachDB, Spanner, YugabyteDB) and a NoSQL store for a system that outgrew a single PostgreSQL primary? (Senior)**
A: The deciding question is whether the workload still needs relational features — multi-row transactions, secondary indexes with consistent reads, joins and ad-hoc SQL. If it does, distributed SQL preserves them while scaling horizontally, at the cost of higher per-transaction latency (consensus on writes, cross-range transactions), higher cost, and contention sensitivity on hot rows; schema and query patterns still need care to avoid cross-region transactions. If the workload has already collapsed to a few known key-based access patterns without cross-entity invariants, a wide-column or key-value store gives more predictable latency and cheaper scale. I would also consider a middle path — sharding PostgreSQL by tenant with Citus, or splitting the one domain that is growing — which often solves the problem with the least change. And I would prototype the top transactions on the candidate with production-like data before committing.

**Q: When does a graph database earn its place over recursive SQL?**
A: When traversal depth is variable or deep and the traversal is on the hot path. Recursive CTEs over an indexed adjacency table handle one to three hops with bounded fan-out well, which covers "friends", "manager chain" and many permission models. As depth grows, each hop multiplies rows and the relational engine performs repeated index lookups and joins, while a native graph store follows stored adjacency directly and offers path algorithms. Even then, many teams precompute results offline (for example "people you may know" as a batch job) and serve them from a key-value store, which avoids operating a graph database for a feature that does not need real-time traversal.

**Q: What would make you pick DynamoDB for a new service, and what would stop you?**
A: I would pick it when the access patterns are known, key-based and stable, the scale or spikiness makes managed, capacity-free scaling valuable, single-digit millisecond latency is required, and multi-region writes via global tables with last-writer-wins are acceptable — sessions, carts, device state, idempotency records. What stops me is the need for ad-hoc queries or analytics on the primary data, many-to-many relationships, transactions spanning many items or large items near the 400 KB limit, or an organization where the single-table design discipline it requires will not be maintained. I would also check the cost model against expected traffic, since per-request pricing can be expensive for steady high throughput.

## 10. Quick Revision & Cheat Sheet

| Workload signal | Leans toward |
|---|---|
| Unknown or evolving queries, reporting | Relational |
| Multi-entity invariants (money, stock, uniqueness) | Relational / distributed SQL |
| Aggregate read/written as a unit, variable shape | Document (or JSONB in relational) |
| Key-only access, extreme QPS, sub-ms | Key-value (Redis / DynamoDB) |
| Very high writes, known queries, multi-region writes | Wide-column / DynamoDB |
| Deep, variable-length traversals on hot path | Graph |
| Append-only time-stamped metrics, time aggregates | Time-series (TimescaleDB, ClickHouse) |
| Relevance search, facets, typos | Search engine (derived) |

**The seven questions:** access pattern → consistency → transactions → relationships → scale → latency → operational complexity → choice.

- Categories are bundles of trade-offs fixed by the storage layout; you cannot take the benefit without the cost.
- Default to a managed PostgreSQL source of truth; JSONB, pg_trgm, full-text, PostGIS, TimescaleDB and pgvector cover a lot.
- Add a specialised store for a measured gap, preferably as a derived, rebuildable store fed by CDC/outbox.
- Polyglot persistence multiplies sync pipelines, backups, failure modes and on-call expertise.
- Wrong reasons: schemaless speed, "SQL doesn't scale", "joins are slow", hypothetical scale, JSON on the wire, fashion.
- Prove the choice with a load test on realistic data before committing.
- Write down which store is authoritative for every entity.

## 11. Hands-On Exercises

Lab: `docker run --name pg -e POSTGRES_PASSWORD=pg -d postgres:17` (use `timescale/timescaledb:latest-pg17` for exercise 3).

1. **JSONB vs columns.** Load 5 M products with 20 random attributes in `jsonb`. Compare query plans and latency for containment (`@>`), a range on a JSON key, and the same range on a generated column with a B-tree index.
2. **Postgres search ceiling.** Build `tsvector` + GIN and `pg_trgm` indexes on product names and descriptions; measure p99 for 1, 10 and 50 concurrent search clients with `pgbench` custom scripts. Note where latency degrades and what is missing (facets, typo tolerance on full text, relevance tuning).
3. **Time-series ingest ceiling.** Run the COPY-based load generator against a TimescaleDB hypertable with 1, 4 and 16 writers; record sustained rows/s, WAL rate and query latency for "last 24 h of one device" during ingest.
4. **Recursive CTE traversal.** Create a follows table with 1 M users and a power-law fan-out; measure 1-, 2- and 3-hop friend-of-friend queries with recursive CTEs and see how row counts explode.
5. **Decision write-up.** For a workload of your choice, write the seven-question analysis with numbers, the decision, what would change it, and which store is authoritative for each entity.

**Mini project — decision record with evidence.** Pick one of the four worked workloads. Implement the relational-only design and the specialised design (e.g. PostgreSQL FTS vs PostgreSQL + OpenSearch via Debezium). Load both with the same synthetic data and traffic, measure latency, freshness and resource cost, simulate one failure in each (index node down; CDC connector stopped), and write an architecture decision record that states the choice, the evidence, the rejected option and the conditions under which you would revisit it.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 14 · CAP Theorem](topic.html?p=14-cap-theorem) · [Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture) · [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases) · [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture) · [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) · [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) (CDC to derived stores).

**SQL Handbook:** [SQL Handbook · JSON & Semi-Structured Data](../sql/topic.html?p=24-json-semistructured) · [SQL Handbook · String & Pattern Matching](../sql/topic.html?p=17-string-pattern) · [SQL Handbook · Recursive CTEs](../sql/topic.html?p=12-recursive-cte) · [SQL Handbook · Schema Design & Data Modeling](../sql/topic.html?p=30-schema-design).

**Other handbooks:** [System Design · SQL vs NoSQL & Data Modeling](../system-design/topic.html?p=14-sql-vs-nosql) · [Cassandra · Cassandra vs ScyllaDB, DynamoDB & HBase](../cassandra/topic.html?p=43-cassandra-vs-alternatives) · [Cassandra · Query-First Data Modeling](../cassandra/topic.html?p=07-query-first-data-modeling) · [Caching with Redis · What Is Caching?](../redis-caching/topic.html?p=01-what-is-caching).

- **Designing Data-Intensive Applications, ch. 2–3** — Martin Kleppmann · *Intermediate* · data models and storage engines explained from first principles. <https://dataintensive.net/>
- **PostgreSQL: JSON Types** — PostgreSQL Docs · *Beginner* · `jsonb` operators, GIN operator classes and containment. <https://www.postgresql.org/docs/current/datatype-json.html>
- **pg_trgm** — PostgreSQL Docs · *Beginner* · trigram similarity and index support for fuzzy search. <https://www.postgresql.org/docs/current/pgtrgm.html>
- **Best practices for designing and architecting with DynamoDB** — AWS Docs · *Intermediate* · partition design, hot keys and single-table modeling. <https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/best-practices.html>
- **MongoDB Data Modeling** — MongoDB Docs · *Beginner* · embedding versus referencing, from the vendor's own guidance. <https://www.mongodb.com/docs/manual/data-modeling/>
- **Polyglot Persistence** — Martin Fowler · *Beginner* · the original argument, which is more careful than the slogan. <https://martinfowler.com/bliki/PolyglotPersistence.html>
- **TimescaleDB documentation** — Timescale · *Intermediate* · hypertables, compression, continuous aggregates and retention. <https://docs.timescale.com/>

---

*Database Design Handbook — chapter 30.*
