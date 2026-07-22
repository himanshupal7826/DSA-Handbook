# 07 · Query-First Data Modeling

> **In one line:** In Cassandra you do not model the data and then ask questions of it — you enumerate the questions first, then build one table per question so every read is a single-partition seek.

---

## 1. Overview

Relational modeling teaches you to find the *truth* of your domain: entities, attributes, third normal form, and then let the optimizer figure out how to answer queries by joining those normalized tables at runtime. That works because a single Postgres node can see every page of every table and can afford a hash join. Cassandra has no such luxury. A cluster is a hash ring of independent nodes; there is no global index, no cross-node join, no query planner that will rescue a bad schema. If the data your query needs is spread across 64 partitions living on 40 machines, the coordinator must fan out to 40 machines and the tail latency of your query becomes the *worst* latency of any of them.

Query-first data modeling — sometimes called *query-driven* or *workload-driven* modeling — inverts the relational process. You start from the application's access patterns, write them down as literal sentences ("find all orders placed by a user, most recent first"), and then design a table whose partition key is exactly the thing the query filters on and whose clustering columns are exactly the order the query wants. The data is duplicated across as many tables as you have queries. Storage is cheap; a random disk seek across a WAN is not.

The methodology was formalized by Artem Chebotko, Andrey Kashlev and Shiyong Lu in the 2015 paper *A Big Data Modeling Methodology for Apache Cassandra*, which gave the community the vocabulary still used today: **conceptual model** (an entity-relationship diagram, technology-neutral), **application workflow / access patterns**, **logical model** (Chebotko diagrams — one box per table, `K` for partition key, `C↑/C↓` for clustering columns), and **physical model** (CQL with types, sizing and compaction settings). The Chebotko notation is what you will see on a whiteboard in a Cassandra interview, and being able to draw it is a hiring signal.

A concrete example: Discord stores every message ever sent — trillions of rows. Their message table is keyed by `(channel_id, bucket)` as the partition key and `message_id` (a Snowflake ID, time-ordered) as a descending clustering column. That single design decision means "give me the last 50 messages in this channel" is one partition, one seek, one node's page cache — at any scale. When they later needed "give me this user's messages", they did not add a secondary index; they would need a second table keyed by user. The schema *is* the query plan. The mental model to carry: **a Cassandra table is a materialized answer to one question.** If you find yourself asking "how do I query this table a different way?", the answer is almost always "you build another table", not "you add an index" and never "you add `ALLOW FILTERING`".

---

## 2. Core Concepts

- **Access pattern** — a single, concrete read or write your application performs, written as a sentence with its filter, its ordering and its expected result-set size. The atomic unit of Cassandra design.
- **Conceptual model** — a plain entity-relationship diagram of the domain (users, orders, products) with cardinalities. Technology-neutral; identical to what you would draw for a relational database.
- **Logical model (Chebotko diagram)** — one box per Cassandra table, listing columns with `K` marking partition-key columns, `C↑` / `C↓` marking ascending/descending clustering columns, and `S` marking static columns.
- **Physical model** — the logical model with concrete CQL types, table options (`compaction`, `default_time_to_live`, `caching`), and an estimated partition size.
- **Partition key** — the column(s) hashed by Murmur3 to produce a token that decides which nodes own the row. Every efficient query must supply it in full with `=` or `IN`.
- **Clustering column** — the column(s) that sort rows *inside* a partition on disk. They give you free ordering and range slices; they cannot be skipped left-to-right.
- **Query table** — a table that exists solely to serve one access pattern, populated by duplicating data written to other tables. Also called a *denormalized view* or *inverted index table*.
- **Bucketing** — splitting a naturally unbounded partition by appending a synthetic discriminator (day, month, hash-mod-N) to the partition key so partitions stay under the size budget.
- **Partition size budget** — the practical ceiling of **< 100 MB** and **< 100,000 rows** per partition. Above that, repair, compaction, and read latency all degrade sharply.
- **Static column** — a column stored once per partition rather than per row; useful for partition-level metadata (a channel's name alongside its messages) without duplicating it on every row.

---

## 3. Theory & Internals

### Why the partition key is destiny

Cassandra hashes the partition key with **Murmur3** into a 64-bit token in the range `[-2^63, 2^63 - 1]`. That token is looked up in the ring to find the primary replica; `RF - 1` further replicas follow by walking the ring (respecting racks under `NetworkTopologyStrategy`). Nothing else about a row influences placement. Two rows with the same partition key are guaranteed to live on the same replica set, adjacent on disk, in the same SSTable row-index; two rows with different partition keys are, with overwhelming probability, on different machines.

So a query's cost is essentially `number_of_partitions_touched`. One partition is one coordinator hop plus one replica read: sub-millisecond from page cache. `N` partitions is a scatter-gather whose latency is the **maximum** over `N` replica reads, and whose failure probability compounds. This is why `IN` on a partition key with 500 values is an anti-pattern even though it "works", and why a full table scan (`ALLOW FILTERING` without a partition key) touches every node and every SSTable.

### Storage layout inside a partition

Within a partition, rows are stored **sorted by the clustering columns** in the order declared. On disk an SSTable holds a partition index and, for large partitions, a *row index* with entries every `column_index_size_in_kb` (default 64 KB in 4.x; 4.1 renamed it `column_index_size`). A range slice like `WHERE channel_id = ? AND bucket = ? AND message_id < ? LIMIT 50` binary-searches that row index and reads a contiguous run of bytes — one seek, sequential I/O, no filtering.

This gives the **clustering-column prefix rule**: you may restrict clustering columns left to right, and only the last restricted one may be a range. `PRIMARY KEY ((a), b, c, d)` permits `b = ? AND c = ? AND d > ?` but not `c = ?` alone. Skipping a column would require a scan of the whole partition.

### Sizing math you should do before writing CQL

Estimate rows per partition first:

```
rows_per_partition = product of the cardinality of every clustering column
                     (per distinct partition key value)
partition_bytes    ≈ rows_per_partition × (sum of non-key column sizes
                                           + clustering key overhead ~ 8–20 B/row)
```

For a sensor table `PRIMARY KEY ((sensor_id, day), ts)` sampling every second: `86,400` rows/day × ~120 B ≈ **10 MB/day** — comfortable. Change the bucket to `month` and you get 2.6 M rows and ~310 MB — over budget on both counts. The bucket granularity *is* the sizing knob.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="300" fill="#ffffff"/>
  <text x="20" y="26" font-size="15" font-weight="700" fill="#1e293b">From question to partition: how a query becomes one seek</text>
  <rect x="20" y="46" width="200" height="70" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="34" y="70" font-size="12" font-weight="700" fill="#1e293b">Q1: last 50 messages</text>
  <text x="34" y="88" font-size="12" fill="#1e293b">in a channel, newest</text>
  <text x="34" y="106" font-size="12" fill="#1e293b">first</text>
  <path d="M225 81 L 265 81" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a7)"/>
  <defs>
    <marker id="a7" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
      <path d="M0 0 L9 4.5 L0 9 z" fill="#4f46e5"/>
    </marker>
  </defs>
  <rect x="270" y="46" width="250" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="284" y="68" font-size="12" font-weight="700" fill="#1e293b">PRIMARY KEY</text>
  <text x="284" y="86" font-size="12" fill="#1e293b">((channel_id, bucket), msg_id)</text>
  <text x="284" y="104" font-size="11" fill="#1e293b">K = filter · C↓ = ordering</text>
  <path d="M525 81 L 565 81" stroke="#0ea5e9" stroke-width="2" fill="none" marker-end="url(#b7)"/>
  <defs>
    <marker id="b7" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto">
      <path d="M0 0 L9 4.5 L0 9 z" fill="#0ea5e9"/>
    </marker>
  </defs>
  <rect x="570" y="46" width="170" height="70" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="584" y="70" font-size="12" font-weight="700" fill="#1e293b">murmur3 token</text>
  <text x="584" y="88" font-size="12" fill="#1e293b">→ 3 replicas</text>
  <text x="584" y="106" font-size="12" fill="#1e293b">→ 1 seek</text>
  <text x="20" y="152" font-size="13" font-weight="700" fill="#1e293b">Inside the partition: rows sorted by clustering column, contiguous on disk</text>
  <rect x="20" y="166" width="720" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="34" y="188" font-size="12" font-weight="700" fill="#1e293b">partition (channel=42, bucket=2026-07)</text>
  <rect x="34" y="196" width="80" height="22" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="44" y="211" font-size="11" fill="#1e293b">msg 9981</text>
  <rect x="120" y="196" width="80" height="22" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="130" y="211" font-size="11" fill="#1e293b">msg 9980</text>
  <rect x="206" y="196" width="80" height="22" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="216" y="211" font-size="11" fill="#1e293b">msg 9979</text>
  <rect x="292" y="196" width="80" height="22" rx="4" fill="#ffffff" stroke="#d97706"/>
  <text x="302" y="211" font-size="11" fill="#1e293b">msg 9978</text>
  <text x="384" y="211" font-size="12" fill="#1e293b">…  LIMIT 50 stops here — no scan, no filter, no tombstone walk</text>
  <text x="20" y="256" font-size="12" fill="#1e293b">Cost model: latency ≈ f(partitions touched). 1 partition = 1 replica read.</text>
  <text x="20" y="276" font-size="12" fill="#1e293b">N partitions = scatter-gather; p99 becomes the max of N reads, not the mean.</text>
</svg>
```

---

## 4. Architecture & Workflow

The Chebotko methodology is a five-step pipeline. Run it in order; skipping step 2 is the single most common cause of a schema that has to be rewritten in production.

1. **Build the conceptual model.** Draw entities and relationships with cardinalities, ignoring Cassandra entirely. `User —(1:N)— Order —(N:M)— Product`. Note which attributes are immutable (good key material) and which mutate (bad key material).
2. **Enumerate the application workflow and access patterns.** Walk each screen and each background job. Write each query as `Qn: <verb> <what> by <filter> ordered by <sort> [limit N]`. Annotate each with expected QPS, result size, and whether it is latency-critical. This list is the contract; a query that is not on it will not be servable.
3. **Map queries to tables (logical model).** For each `Qn`, create one table. The equality filter becomes the partition key. The ordering and range filters become clustering columns, in the order the query needs them. Everything else the screen displays becomes a regular column. Name tables after the query: `messages_by_channel`, `orders_by_user`, `orders_by_status_and_day`.
4. **Assign types and check partition sizes (physical model).** Choose CQL types, add `WITH CLUSTERING ORDER BY`, choose compaction (`TimeWindowCompactionStrategy` for time series, `LeveledCompactionStrategy` for read-heavy update workloads), estimate rows/bytes per partition, and add bucketing if the estimate exceeds budget.
5. **Validate and iterate.** Load representative data, run `nodetool tablehistograms`, check the max partition size, and re-run every `Qn` with tracing on. Any query that does not hit exactly one partition per invocation is a modeling bug, not a tuning problem.

Write-path consequence: because step 3 produces multiple tables containing the same fact, a single logical mutation ("user places an order") becomes several CQL statements. Those are grouped in a **`BEGIN BATCH` logged batch** *only* when atomicity across tables genuinely matters — the batch log costs an extra round trip and a write to `system.batches` on two nodes. Otherwise you issue them as independent async writes and accept eventual convergence.

```svg
<svg viewBox="0 0 760 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="330" fill="#ffffff"/>
  <text x="20" y="24" font-size="15" font-weight="700" fill="#1e293b">Chebotko pipeline: conceptual → access patterns → logical → physical</text>
  <rect x="20" y="42" width="150" height="88" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="32" y="62" font-size="12" font-weight="700" fill="#1e293b">1. Conceptual</text>
  <text x="32" y="80" font-size="11" fill="#1e293b">User 1:N Order</text>
  <text x="32" y="96" font-size="11" fill="#1e293b">Order N:M Product</text>
  <text x="32" y="112" font-size="11" fill="#1e293b">technology-neutral</text>
  <rect x="190" y="42" width="160" height="88" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="202" y="62" font-size="12" font-weight="700" fill="#1e293b">2. Access patterns</text>
  <text x="202" y="80" font-size="11" fill="#1e293b">Q1 orders by user ↓ts</text>
  <text x="202" y="96" font-size="11" fill="#1e293b">Q2 order by id</text>
  <text x="202" y="112" font-size="11" fill="#1e293b">Q3 open orders by day</text>
  <rect x="370" y="42" width="170" height="88" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="382" y="62" font-size="12" font-weight="700" fill="#1e293b">3. Logical</text>
  <text x="382" y="80" font-size="11" fill="#1e293b">orders_by_user</text>
  <text x="382" y="96" font-size="11" fill="#1e293b">orders_by_id</text>
  <text x="382" y="112" font-size="11" fill="#1e293b">orders_by_status_day</text>
  <rect x="560" y="42" width="180" height="88" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="572" y="62" font-size="12" font-weight="700" fill="#1e293b">4. Physical</text>
  <text x="572" y="80" font-size="11" fill="#1e293b">types + TWCS + TTL</text>
  <text x="572" y="96" font-size="11" fill="#1e293b">est. 12 MB / partition</text>
  <text x="572" y="112" font-size="11" fill="#1e293b">bucket = yyyy-mm</text>
  <path d="M172 86 L 186 86" stroke="#1e293b" stroke-width="2"/>
  <path d="M352 86 L 366 86" stroke="#1e293b" stroke-width="2"/>
  <path d="M542 86 L 556 86" stroke="#1e293b" stroke-width="2"/>
  <path d="M650 134 L 650 158 L 90 158 L 90 176" stroke="#d97706" stroke-width="1.5" fill="none" stroke-dasharray="5 4"/>
  <text x="300" y="152" font-size="11" fill="#d97706">5. validate with tablehistograms → iterate</text>
  <text x="20" y="200" font-size="13" font-weight="700" fill="#1e293b">One write fans out to every query table</text>
  <rect x="20" y="212" width="150" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="34" y="232" font-size="12" font-weight="700" fill="#1e293b">place_order()</text>
  <text x="34" y="249" font-size="11" fill="#1e293b">one domain event</text>
  <path d="M172 235 L 214 212" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <path d="M172 235 L 214 250" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <path d="M172 235 L 214 288" stroke="#4f46e5" stroke-width="1.5" fill="none"/>
  <rect x="218" y="196" width="230" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="230" y="216" font-size="11" fill="#1e293b">INSERT orders_by_user  (K=user_id)</text>
  <rect x="218" y="234" width="230" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="230" y="254" font-size="11" fill="#1e293b">INSERT orders_by_id    (K=order_id)</text>
  <rect x="218" y="272" width="230" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="230" y="292" font-size="11" fill="#1e293b">INSERT orders_by_status_day</text>
  <rect x="470" y="212" width="270" height="66" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="484" y="232" font-size="11" font-weight="700" fill="#1e293b">Atomicity needed? → LOGGED BATCH</text>
  <text x="484" y="250" font-size="11" fill="#1e293b">(same partition key ⇒ free; else batchlog)</text>
  <text x="484" y="268" font-size="11" fill="#1e293b">Otherwise → 3 async writes, converge later</text>
</svg>
```

---

## 5. Implementation

A worked example: an order-management service. Start with the access patterns.

```
Q1  Show a user's orders, newest first, 20 per page.        ~4k QPS, latency-critical
Q2  Show one order by its id (deep link, support tool).     ~800 QPS
Q3  Ops dashboard: all PENDING orders created today.        ~5 QPS, batchy
Q4  Show the line items of one order.                       ~800 QPS
```

Four questions → four tables.

```cql
CREATE KEYSPACE shop
  WITH replication = {
    'class': 'NetworkTopologyStrategy', 'us_east': 3, 'eu_west': 3
  } AND durable_writes = true;

-- Q1: orders by user, newest first
CREATE TABLE shop.orders_by_user (
  user_id      uuid,
  created_at   timestamp,
  order_id     uuid,
  status       text,
  total_cents  bigint,
  currency     text,
  PRIMARY KEY ((user_id), created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id DESC)
  AND compaction = {'class':'LeveledCompactionStrategy'}
  AND comment = 'Q1 - max ~5k orders/user => ~600 KB partition';

-- Q2 + Q4: one order and its lines, single partition, static columns for the header
CREATE TABLE shop.order_by_id (
  order_id     uuid,
  line_no      int,
  user_id      uuid   STATIC,
  status       text   STATIC,
  created_at   timestamp STATIC,
  sku          text,
  qty          int,
  price_cents  bigint,
  PRIMARY KEY ((order_id), line_no)
) WITH CLUSTERING ORDER BY (line_no ASC);

-- Q3: pending orders bucketed by day so the partition stays bounded
CREATE TABLE shop.orders_by_status_day (
  status       text,
  day          date,
  created_at   timestamp,
  order_id     uuid,
  user_id      uuid,
  total_cents  bigint,
  PRIMARY KEY ((status, day), created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id DESC)
  AND default_time_to_live = 7776000
  AND compaction = {'class':'TimeWindowCompactionStrategy',
                    'compaction_window_unit':'DAYS',
                    'compaction_window_size':1};
```

The reads are now trivially single-partition:

```cql
-- Q1
SELECT order_id, created_at, status, total_cents
FROM shop.orders_by_user
WHERE user_id = 8f2a...  LIMIT 20;

-- Q1 next page (keyset pagination, never OFFSET — Cassandra has none)
SELECT order_id, created_at, status, total_cents
FROM shop.orders_by_user
WHERE user_id = 8f2a... AND created_at < '2026-07-01 09:14:22+0000'
LIMIT 20;

-- Q2 + Q4 in a single round trip: header (static) and lines come together
SELECT user_id, status, created_at, line_no, sku, qty, price_cents
FROM shop.order_by_id WHERE order_id = 41c9...;

-- Q3
SELECT order_id, user_id, total_cents
FROM shop.orders_by_status_day
WHERE status = 'PENDING' AND day = '2026-07-22' LIMIT 500;
```

Writing the fan-out from the Python driver:

```python
from cassandra.cluster import Cluster, ExecutionProfile, EXEC_PROFILE_DEFAULT
from cassandra.policies import DCAwareRoundRobinPolicy, TokenAwarePolicy
from cassandra import ConsistencyLevel
import uuid, datetime

profile = ExecutionProfile(
    load_balancing_policy=TokenAwarePolicy(DCAwareRoundRobinPolicy(local_dc="us_east")),
    consistency_level=ConsistencyLevel.LOCAL_QUORUM, request_timeout=5.0)
session = Cluster(["10.0.1.11", "10.0.1.12"],
                  execution_profiles={EXEC_PROFILE_DEFAULT: profile}).connect("shop")

ins_user = session.prepare("INSERT INTO orders_by_user (user_id,created_at,order_id,"
                           "status,total_cents,currency) VALUES (?,?,?,?,?,?)")
ins_byid = session.prepare("INSERT INTO order_by_id (order_id,line_no,user_id,status,"
                           "created_at,sku,qty,price_cents) VALUES (?,?,?,?,?,?,?,?)")
ins_day  = session.prepare("INSERT INTO orders_by_status_day (status,day,created_at,"
                           "order_id,user_id,total_cents) VALUES (?,?,?,?,?,?)")

def place_order(user_id, lines):
    oid, now = uuid.uuid4(), datetime.datetime.utcnow()
    total = sum(l["qty"] * l["price"] for l in lines)
    futures = [session.execute_async(ins_user, (user_id, now, oid, "PENDING", total, "USD")),
               session.execute_async(ins_day, ("PENDING", now.date(), now, oid, user_id, total))]
    for i, l in enumerate(lines):
        futures.append(session.execute_async(
            ins_byid, (oid, i, user_id, "PENDING", now, l["sku"], l["qty"], l["price"])))
    for f in futures:
        f.result()          # fan-out latency ~ slowest write, not the sum
    return oid
```

Validate the physical model before you ship it:

```bash
# after loading a representative dataset
nodetool tablehistograms shop orders_by_user
# shop/orders_by_user histograms
# Percentile  SSTables   Write(μs)  Read(μs)  Partition Size  Cell Count
# 50%             1.00       35.4      126.9            4768         120
# 99%             2.00      126.9      654.9          454826        8239
# Max             3.00      263.2     2816.2         1629722       29521   <-- 1.6 MB max: healthy

nodetool tablestats shop.orders_by_status_day | grep -E "partition|Compacted"
# Compacted partition maximum bytes: 62479625      <-- 62 MB, still under the 100 MB budget

# prove a query is single-partition
cqlsh -e "TRACING ON; SELECT * FROM shop.orders_by_user WHERE user_id=8f2a... LIMIT 20;"
# ... Read 20 live rows and 0 tombstone cells | 1 partition | 1 replica queried
```

> **Optimization:** enable **token-aware routing** in the driver (default in DataStax drivers when you use *prepared* statements) so the coordinator *is* a replica. This removes one network hop from every single-partition read — typically 0.4–1.2 ms of p99 in a same-AZ cluster. Unprepared `session.execute("SELECT ... WHERE user_id=%s", ...)` loses token awareness entirely, because the driver cannot know which bind variable is the partition key.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| Read latency | Every modelled query is one partition; p99 stays flat from 3 nodes to 300 | Any query *not* modelled is effectively impossible without a rewrite |
| Predictability | No query planner, no plan regressions, no "it was fast in staging" | The schema is coupled to the UI; a new screen means a new table and a backfill |
| Write cost | Writes are appends: no read-before-write, no index maintenance | One logical event becomes N physical writes; write amplification scales with query count |
| Storage | Cheap and linear; duplication is a deliberate purchase of latency | 3–6× the normalized footprint is normal; budget disk accordingly |
| Consistency | Each table is individually correct and repairable | Cross-table consistency is *your* job — no foreign keys, no cascading updates |
| Evolution | Adding a table is a non-breaking, zero-downtime operation | Changing a primary key is impossible in place; requires new table + dual write + backfill |
| Ad-hoc analytics | Out of scope by design — push it to Spark/Presto over the same data | Analysts cannot self-serve; you need a second system (Spark Cassandra Connector, CDC → warehouse) |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Porting the relational schema and hoping.** A normalized 3NF schema in Cassandra means every screen is a multi-partition join in application code. ✅ Throw it away and start from the access-pattern list; use the ER diagram only as the conceptual step.
2. ⚠️ **Designing tables before enumerating queries.** ✅ Write all `Qn` sentences down first, get product to sign off, then design. A query added later that needs a different partition key is a migration, not a patch.
3. ⚠️ **Unbounded partitions** — `PRIMARY KEY ((sensor_id), ts)` looks elegant and grows forever. ✅ Always bucket time-series and log-shaped data: `((sensor_id, day), ts)`. Verify with `nodetool tablehistograms` that max partition < 100 MB and < 100k rows.
4. ⚠️ **Low-cardinality partition keys** — `PRIMARY KEY ((country), ...)` gives you a 200-partition table and a hot node holding `US`. ✅ Add a discriminator to the key (`(country, day)` or `(country, bucket)` with `bucket = hash(id) % 32`).
5. ⚠️ **Reaching for `ALLOW FILTERING` to make a query "work".** It works in cqlsh on 1,000 rows and takes down the cluster at 100 M. ✅ Treat `ALLOW FILTERING` as a compile error in application code; add the query table instead.
6. ⚠️ **Adding a secondary index to avoid building a table.** A `2i` on a high-cardinality column turns every read into a cluster-wide scatter-gather. ✅ Build the query table; consider SAI (5.0) only for genuinely low-selectivity secondary filters *within* an already-narrowed partition set.
7. ⚠️ **Mutable partition keys.** Keying `orders_by_status` on a status that changes means an update becomes delete-then-insert across partitions, leaving tombstones. ✅ Partition on immutable attributes; model status transitions as new rows in a status-and-day table with a TTL.
8. ⚠️ **Using a logged batch as a performance optimization.** Batches across partitions are *slower* — the batchlog is written to two nodes before the mutations. ✅ Use logged batches only for genuine multi-table atomicity; use unlogged same-partition batches for grouped writes; otherwise fire async statements in parallel.
9. ⚠️ **`OFFSET`-style pagination emulated with `LIMIT` + client skipping**, whose cost grows linearly with page number. ✅ Use keyset pagination on the clustering column, or the driver's `paging_state`.
10. ⚠️ **Skipping the sizing arithmetic.** ✅ Before `CREATE TABLE`, write the rows-per-partition formula in the table `comment` so reviewers can check it and it survives you.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The first tool is `TRACING ON` in cqlsh or `session.execute(stmt, trace=True)` in the driver — it prints partitions touched, replicas queried, and tombstones scanned. `nodetool tablehistograms <ks> <table>` gives per-table partition-size and SSTables-per-read distributions; more than ~4 SSTables at p99 for a single-partition read means compaction is behind or your model spreads one logical row across too many writes. `nodetool toppartitions <ks> <table> 10000` samples the hottest partitions live and is the fastest way to catch a hotspot from a bad key choice.

**Monitoring.** Watch these JMX beans / metrics: `org.apache.cassandra.metrics:type=Table,name=EstimatedPartitionSizeHistogram`, `...name=SSTablesPerReadHistogram`, `...name=TombstoneScannedHistogram`, `...name=ReadLatency` (per table, not just global), and `...type=ClientRequest,scope=Read,name=Latency`. Alert on max partition bytes crossing 100 MB and on `TombstoneScannedHistogram` p99 approaching `tombstone_warn_threshold` (1000). In 4.0+ the virtual tables `system_views.local_read_latency` and `system_views.max_partition_size` expose the same data over CQL, which is far easier to scrape than JMX.

**Security.** Query-first modeling duplicates data, so a sensitive column now lives in several tables — your `GRANT` matrix and any client-side field encryption must cover all of them. Use per-table `GRANT SELECT ON shop.orders_by_user TO support_role` rather than keyspace-wide grants; the duplication is precisely what makes fine-grained grants feasible. Enable the 4.0 audit log (`audit_logging_options` in `cassandra.yaml`) filtered to the tables holding PII.

**Performance & scaling.** Because every modelled read is a single partition, throughput scales linearly with node count as long as the partition-key distribution is uniform — check with `nodetool status` (ownership should be within a few percent of `100/N × RF`) and `nodetool tablestats` per node. The scaling failure mode is never "too much data"; it is always "one partition too hot" or "one partition too big". When a query table's write rate becomes the bottleneck, shard its partition key wider (`(user_id, bucket)` with a small `bucket` range) rather than adding nodes.

---

## 9. Interview Questions

**Q: Why can't you just normalize in Cassandra and join at read time?**
A: Cassandra has no join operator and no cross-partition query planner, so a join would have to be executed in application code as N sequential round trips. Each round trip may hit a different replica set, so latency becomes the sum of the worst-case latencies and availability compounds downward. Duplicating data into a table per query converts that into one seek.

**Q: What are the four steps of the Chebotko methodology?**
A: Conceptual model (entities and relationships), access-pattern enumeration (the application workflow), logical model (one Chebotko table diagram per query, marking K, C↑/C↓ and static columns), and physical model (CQL types, table options, and partition-size validation). Iteration back from the physical step is expected.

**Q: How do you choose the partition key for a query?**
A: The partition key is exactly the set of columns the query restricts with equality and that produce enough distinct values to spread across the ring. If that set is too coarse (few distinct values) you add a synthetic discriminator such as a time bucket or `hash(id) % N` to widen it.

**Q: What is the difference between a partition key and a clustering column, practically?**
A: The partition key decides *which node* holds the data and must be fully specified with `=` or `IN`; the clustering columns decide *the order on disk within* that node's partition and support prefix equality plus one trailing range. You get free sorting and range slices from clustering columns and nothing at all from the partition key beyond placement.

**Q: What partition size should you target and why?**
A: Under 100 MB and under 100,000 rows. Beyond that, compaction needs to rewrite huge contiguous blobs, repair streams outsized chunks, reads pull large row-index structures into heap, and a single hot partition can no longer be balanced away because a partition cannot be split across nodes.

**Q: How do you paginate correctly?**
A: Use the clustering column as a keyset cursor (`WHERE pk = ? AND ts < :last_seen LIMIT 20`) or hand the driver's opaque `paging_state` back to the next request. There is no `OFFSET` in CQL, and emulating it client-side re-reads and discards everything before the offset.

**Q: When is a static column the right tool?**
A: When a fact belongs to the whole partition rather than to each row — an order header alongside its line items, or a channel's display name alongside its messages. It is stored once per partition, can be read in the same query as the rows, and can be updated without touching any clustering row.

**Q: (Senior) A new product requirement needs a query your schema can't serve. Walk through the migration.**
A: Create the new query table, deploy a dual-write path so every mutation writes both old and new tables (ideally behind a feature flag), backfill history with a Spark job or a paged reader that streams the source table by token range, verify row counts and spot-check with `TRACING`, cut reads over to the new table, then remove the dual write. Never `ALTER` a primary key — it is not supported; the new table plus backfill *is* the migration.

**Q: (Senior) How do you keep the query tables consistent when one of the fan-out writes fails?**
A: Decide per fact whether you need atomicity or convergence. For atomicity use a logged batch, which guarantees all-or-nothing eventually via the batchlog on two replicas — but pay the extra write. For convergence, make writes idempotent (deterministic keys, no counters, no read-modify-write), retry with backoff, and run a periodic reconciliation job that re-derives the derived tables from the source-of-truth table. Client-side timestamps from a single logical event make repeated retries converge to the same state.

**Q: (Senior) Your `orders_by_status_day` partition for `PENDING` is 900 MB on Black Friday. What do you do, and what would you have done differently?**
A: Immediately, widen the key with a shard: `((status, day, shard), created_at)` where `shard = hash(order_id) % 16`, dual-write, and have the dashboard read all 16 shards concurrently — a 16-way scatter is acceptable for a 5 QPS ops query. Structurally, the mistake was bucketing on a granularity chosen for the *average* day rather than the peak; the fix is either a finer bucket (hour) or the explicit shard from day one, sized from peak QPS × bucket duration × row size.

**Q: How do you validate a data model before production?**
A: Load a representative dataset at realistic cardinalities (not uniform synthetic data — real key skew matters), then check `nodetool tablehistograms` max partition size and cell count against the budget, run every access pattern with tracing and assert one partition per query, and run a load test at peak QPS while watching per-table `ReadLatency` and `SSTablesPerReadHistogram`.

**Q: Isn't storing the same data six times a maintenance nightmare?**
A: It is a deliberate trade: you buy bounded, predictable read latency with storage and write amplification. The discipline that makes it safe is a single write-path function per domain event that owns all the fan-out, idempotent statements, and a reconciliation job. In practice the tables are append-mostly, so there is far less mutation than a normalized model would suggest.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Cassandra has no joins, no global index and no query planner, so the schema must *be* the query plan. Enumerate every access pattern first; build one table per query; make the equality filter the partition key and the sort order the clustering columns; duplicate freely. Validate the physical model against the budget — **< 100 MB and < 100k rows per partition** — and bucket or shard the key when the estimate exceeds it. Writes fan out to every query table from one code path; use logged batches only when you truly need atomicity. Every modelled read must touch exactly one partition; anything else (`ALLOW FILTERING`, high-cardinality `2i`, multi-partition `IN`) is a modeling bug, not a tuning opportunity.

| Item | Value / Command |
| --- | --- |
| Partition size budget | < 100 MB, < 100,000 rows |
| Check actual sizes | `nodetool tablehistograms <ks> <table>` |
| Find hot partitions | `nodetool toppartitions <ks> <table> 10000` |
| Prove single-partition read | `TRACING ON;` in cqlsh, or `execute(stmt, trace=True)` |
| Chebotko notation | `K` partition key · `C↑`/`C↓` clustering asc/desc · `S` static |
| Ordering | `WITH CLUSTERING ORDER BY (created_at DESC)` |
| Time-series compaction | `TimeWindowCompactionStrategy`, window = bucket granularity |
| Read-heavy update table | `LeveledCompactionStrategy` |
| Prod replication | `NetworkTopologyStrategy` + `LOCAL_QUORUM` |
| Virtual table (4.0+) | `SELECT * FROM system_views.max_partition_size;` |

**Flash cards**

- **What is the atomic unit of Cassandra data modeling?** → One access pattern (a concrete query sentence), not an entity.
- **Which query filter becomes the partition key?** → The equality restriction — and it must be supplied in full on every read.
- **How many partitions should a modelled read touch?** → Exactly one.
- **What is the fix for an unbounded partition?** → Bucket the partition key by time, or shard it with `hash(x) % N`.
- **Can you change a table's primary key?** → No. New table + dual write + backfill + read cutover.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Start a 3-node cluster (`ccm create demo -v 4.1.5 -n 3 -s` or `docker compose` with three `cassandra:5.0` nodes) and create the `shop` keyspace with `NetworkTopologyStrategy` and RF 3.
- [ ] Create `orders_by_user`, load 200 users × 3,000 orders with a generator script, then run `nodetool tablehistograms shop orders_by_user` and record the max partition size. Predict it with the sizing formula first and compare.
- [ ] Deliberately build the anti-pattern: `CREATE TABLE events_bad (tenant text, ts timeuuid, ..., PRIMARY KEY ((tenant), ts))` with 3 tenants and 5 M events. Observe partition size, then rebuild as `((tenant, day), ts)` and compare `tablehistograms` and read p99 side by side.
- [ ] Take one query you cannot serve (`orders by status`) and implement it two ways — with `ALLOW FILTERING` and with a purpose-built table. Run both under `TRACING ON` and record partitions touched and latency.
- [ ] Write the Chebotko logical diagram for a three-screen app (feed, profile, search-by-tag) on paper, then implement it and prove each screen is one partition per query.

### Mini Project — "Model a ride-hailing back end"

**Goal.** Produce a complete conceptual → logical → physical model plus a working schema for a ride-hailing service, and prove every query is single-partition.

**Requirements.**
1. Enumerate at least 8 access patterns across three actors: rider (trip history, trip detail, receipt), driver (today's trips, earnings by week), ops (active trips in a city right now, surge audit by zone/hour).
2. Draw the conceptual ER model, then the Chebotko logical model with `K`/`C↑`/`C↓`/`S` annotations for every table.
3. Implement the physical model in CQL with `NetworkTopologyStrategy`, appropriate compaction per table, TTLs on the ops tables, and a `comment` on each table containing its sizing arithmetic.
4. Write one `complete_trip(trip)` function in Python or Java that performs the whole fan-out with prepared, token-aware, `LOCAL_QUORUM` statements — and explain in a comment which writes needed a logged batch and which did not.
5. Load 1 M synthetic trips with realistic skew (a few very busy drivers and cities), then validate every table against the partition budget and every query with tracing.

**Extensions.** Add a `trips_by_driver_week` roll-up and compare maintaining it via fan-out writes versus a Spark batch job. Introduce a status change (`REQUESTED → ACTIVE → COMPLETE`) and design it without ever using a mutable partition key. Add a second data centre and re-measure `LOCAL_QUORUM` versus `QUORUM` latency for the rider trip-history query.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Partition Keys, Clustering & the Primary Key* gives the key mechanics this chapter assumes. *Denormalization & Table-per-Query* covers keeping the fan-out tables consistent. *Data Types, Collections & UDTs* explains what you may safely embed in a query table. *Secondary Indexes, SAI & SASI* and *Materialized Views* are the two shortcuts people reach for instead of modeling — read them to know when the shortcut is legitimate. *Data Modeling Anti-Patterns* is the failure catalogue for everything here.

- **Data Modeling — Apache Cassandra Documentation** — Apache Software Foundation · *Beginner–Intermediate* · The canonical conceptual/logical/physical walkthrough with the official Chebotko notation and worked examples. <https://cassandra.apache.org/doc/latest/cassandra/developing/data-modeling/index.html>
- **A Big Data Modeling Methodology for Apache Cassandra** — Chebotko, Kashlev & Lu (IEEE BigData 2015) · *Intermediate* · The paper that defined the methodology and the diagram notation everyone still uses. <https://www.researchgate.net/publication/308801409_A_Big_Data_Modeling_Methodology_for_Apache_Cassandra>
- **DataStax Data Modeling by Example** — DataStax · *Beginner–Intermediate* · Free, hands-on courses that build query-first schemas step by step with downloadable datasets. <https://www.datastax.com/learn/data-modeling-by-example>
- **How Discord Stores Trillions of Messages** — Discord Engineering · *Intermediate* · The clearest real-world account of bucketed partition design at extreme scale, plus what forced their move to ScyllaDB. <https://discord.com/blog/how-discord-stores-trillions-of-messages>
- **The Last Pickle — Data Modeling posts** — The Last Pickle / DataStax · *Intermediate–Advanced* · Practitioner deep dives on partition sizing, bucketing strategies and the real cost of wide rows. <https://thelastpickle.com/blog/>
- **Basic Rules of Cassandra Data Modeling** — DataStax Docs · *Beginner* · The short, memorable rule list (spread evenly, minimize partitions read) that is worth internalizing verbatim. <https://docs.datastax.com/en/cassandra-oss/3.x/cassandra/dml/dmlIntro.html>
- **ScyllaDB University — Data Modeling** — ScyllaDB · *Intermediate* · Free course covering the same CQL model from a different implementation's perspective; excellent for understanding which rules are physics and which are Cassandra-specific. <https://university.scylladb.com/courses/data-modeling/>
- **Cassandra Data Modeling Best Practices (Cassandra Summit talk)** — Apache Cassandra / Planet Cassandra on YouTube · *Intermediate* · Conference-talk treatment of query-first design with live schema critiques. <https://www.youtube.com/@PlanetCassandra>

---

*Apache Cassandra Handbook — chapter 07.*
