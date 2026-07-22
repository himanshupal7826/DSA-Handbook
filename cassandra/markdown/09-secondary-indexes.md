# 09 · Secondary Indexes, SAI & SASI

> **In one line:** A Cassandra secondary index is a *local* index on every node, so any query that uses one without a partition key becomes a cluster-wide scatter-gather — SAI in 5.0 makes that far cheaper, but it never makes it free.

---

## 1. Overview

Every engineer who meets Cassandra eventually hits the same wall: they have `users` keyed by `user_id`, product asks for "find the user by email", and CQL politely refuses. `CREATE INDEX ON users (email)` makes the error go away in seconds, the query returns in cqlsh, and the change ships. Six months later, at 200 million rows and 40 nodes, that one query is responsible for coordinator timeouts across the entire cluster. The index did not break — it did exactly what it was designed to do, and what it was designed to do is not what the developer assumed.

The crucial fact is that Cassandra's secondary indexes are **local**, not global. Each node indexes only the rows it stores. There is no distributed index that can tell a coordinator "the row with `email='ada@x.io'` lives on node 17". So a query filtered only by an indexed column must be broadcast to enough nodes to cover the whole token ring, each node consults its local index, and the coordinator merges the results. With `RF=3` and 60 nodes, that is roughly 20 nodes touched per query — 20 chances for a slow node, a GC pause, or a timeout. Latency becomes the maximum of 20 reads, and throughput ceiling drops by the same factor.

Cassandra has shipped three index implementations. The original **`2i`** (secondary index, since 0.7) builds a hidden Cassandra table per index, partitioned by the indexed value — which is precisely why a high-cardinality column produces millions of tiny partitions and a low-cardinality column produces a handful of enormous, hot ones. **SASI** (SSTable-Attached Secondary Index, CASSANDRA-10661, added experimentally in 3.4) attached index structures directly to SSTables and added `LIKE` prefix/suffix matching, but it had serious memory and correctness issues and is now effectively deprecated. **SAI** (Storage-Attached Index, CASSANDRA-16052, GA in **Cassandra 5.0**) is the modern answer: contributed from DataStax Astra, it shares one set of on-disk structures across all indexed columns of a table, supports numeric ranges, collections, and — with `vector<float,n>` — approximate nearest-neighbour search, at roughly a fifth of the disk footprint of `2i` and dramatically better write throughput.

What SAI changes is the *constant factor*, not the *complexity class*. A query filtered only by an indexed column is still a scatter-gather over the ring; SAI just makes each node's part of it much cheaper and makes multi-column conjunctions genuinely usable. The design rule survives intact: **an index is for narrowing within a known partition or for low-frequency operational queries, never for a high-QPS primary lookup path.**

The canonical production shape: an e-commerce `orders_by_user` table keyed by `((user_id), created_at)`. A support tool needs "this user's orders with status `DISPUTED`". That is a *secondary* filter inside a *known* partition — `WHERE user_id = ? AND status = 'DISPUTED'` — and it is exactly what an index is good at, because the query is restricted to one node's data. The same filter without `user_id` is a different query entirely and needs its own table.

---

## 2. Core Concepts

- **Local (per-node) index** — an index that covers only the rows stored on the node holding it. Cassandra has no global secondary index; this single property drives all index behaviour.
- **`2i` (legacy secondary index)** — the original implementation, materialized as a hidden table whose partition key is the indexed value and whose rows point at base-table primary keys.
- **SASI** — SSTable-Attached Secondary Index (3.4+, experimental, now deprecated). Added `LIKE 'prefix%'` and range search via per-SSTable term dictionaries; suffers unbounded memory use on large datasets.
- **SAI (Storage-Attached Index)** — Cassandra 5.0's index: per-SSTable, shares row-id infrastructure across columns of the same table, supports `=`, ranges, collection containment, and vector ANN.
- **Cardinality** — the number of distinct values in a column relative to row count. Indexes work best at *moderate* cardinality; both extremes fail, for opposite reasons.
- **Selectivity** — the fraction of rows a predicate matches. A highly selective predicate returns few rows; the index cost is dominated by the fan-out, not by the matches.
- **Scatter-gather (range read)** — the execution mode where the coordinator queries `ring_size / RF` nodes in sequence or parallel because no partition key was supplied.
- **`ALLOW FILTERING`** — the clause that tells Cassandra "read rows and discard the ones that don't match, server-side". Not an index; an admission that no access path exists.
- **Index-on-partition-restricted query** — a query that supplies the full partition key *and* an indexed predicate. Single node, single partition — the only universally safe use of an index.
- **`CONTAINS` / `CONTAINS KEY`** — the operators for querying an index built on a collection's values or map keys.

---

## 3. Theory & Internals

### How `2i` actually stores data

For `CREATE INDEX ON users (email)`, Cassandra creates a hidden table roughly equivalent to:

```
CREATE TABLE users_email_idx (
  email      text,        -- partition key = the INDEXED VALUE
  user_id    uuid,        -- clustering = base table primary key
  PRIMARY KEY ((email), user_id)
);
```

on **every node**, containing only that node's rows. Two failure modes follow directly:

- **High cardinality** (email, uuid, timestamp): almost every partition in the index table has exactly one row. You have created hundreds of millions of tiny partitions, each costing a bloom-filter entry, an index-summary entry and a partition header. Compaction and repair costs explode; the read still has to scatter because the coordinator does not know which node holds the value.
- **Low cardinality** (`status`, `country`, `is_active` with 2–10 values): the index table has a handful of partitions, each holding *millions* of rows on every node. That is the classic unbounded-partition anti-pattern, self-inflicted, and reads of it are brutally slow.

The sweet spot is a few hundred to a few thousand distinct values *per node* — and even then the query must be partition-restricted to be fast.

### The scatter-gather cost model

Without a partition key, the coordinator must cover the whole ring. It queries nodes in token order, honouring the page size, and uses a **concurrency factor** that starts at 1 and adapts based on how many rows the first nodes returned. Cost:

```
nodes_touched ≈ ring_size / RF          (best case, no vnode fragmentation)
latency       ≈ max(per-node latency)   over those nodes, summed across pages
p99_query     ≈ p99.95 of a single node read   (tail amplification)
```

With 60 nodes and RF=3 you touch ~20 nodes. If each node has a 1 % chance of a 100 ms GC pause, the query has a **~18 %** chance of hitting at least one — which is why indexed queries produce spiky, unexplainable p99s.

### Quorum and consistency still apply

Index reads are **not** repaired independently of the base table. The index is rebuilt from the base data during compaction and `nodetool rebuild_index`, so a stale or corrupt index heals only when its SSTables are rewritten. Because the index is local, an indexed query at `LOCAL_QUORUM` reads a quorum *per token range*, so the consistency guarantee holds, but a row deleted on one replica and not yet repaired can still surface as a false positive that is then filtered out by the base-row read.

### What SAI changes

SAI writes, per SSTable, a set of per-column index components sharing one **row-id → primary key** mapping. Numeric columns get a balanced kd-tree (block kd-tree) for ranges; text columns get a trie-based term dictionary with postings lists. Because the components are attached to SSTables, they are written once at flush and merged during compaction — there is no separate index table to keep consistent, no extra write path, and no index-specific tombstones. Multi-column predicates are intersected as postings-list operations *before* any base row is read, so `WHERE a = ? AND b > ?` costs roughly one intersection instead of two independent scans. Measured against `2i`, SAI typically uses **~20–35 %** of the disk and delivers several times the indexed-write throughput.

```svg
<svg viewBox="0 0 760 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="330" fill="#ffffff"/>
  <text x="20" y="24" font-size="15" font-weight="700" fill="#1e293b">Why an indexed query without a partition key is a scatter-gather</text>
  <circle cx="150" cy="160" r="88" fill="none" stroke="#4f46e5" stroke-width="2" stroke-dasharray="4 4"/>
  <text x="118" y="60" font-size="12" font-weight="700" fill="#1e293b">token ring</text>
  <circle cx="150" cy="72" r="15" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="142" y="77" font-size="10" fill="#1e293b">n1</text>
  <circle cx="212" cy="98" r="15" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="204" y="103" font-size="10" fill="#1e293b">n2</text>
  <circle cx="238" cy="160" r="15" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="230" y="165" font-size="10" fill="#1e293b">n3</text>
  <circle cx="212" cy="222" r="15" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="204" y="227" font-size="10" fill="#1e293b">n4</text>
  <circle cx="150" cy="248" r="15" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="142" y="253" font-size="10" fill="#1e293b">n5</text>
  <circle cx="88" cy="222" r="15" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="80" y="227" font-size="10" fill="#1e293b">n6</text>
  <circle cx="62" cy="160" r="15" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="54" y="165" font-size="10" fill="#1e293b">n7</text>
  <circle cx="88" cy="98" r="15" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="80" y="103" font-size="10" fill="#1e293b">n8</text>
  <rect x="300" y="52" width="200" height="52" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="312" y="72" font-size="11" font-weight="700" fill="#1e293b">SELECT ... WHERE email = ?</text>
  <text x="312" y="90" font-size="11" fill="#1e293b">no partition key supplied</text>
  <path d="M300 78 L 250 100" stroke="#d97706" stroke-width="1.5" fill="none"/>
  <path d="M300 78 L 256 152" stroke="#d97706" stroke-width="1.5" fill="none"/>
  <path d="M300 78 L 250 216" stroke="#d97706" stroke-width="1.5" fill="none"/>
  <text x="300" y="126" font-size="11" fill="#d97706">coordinator must cover the whole ring</text>
  <rect x="300" y="140" width="440" height="76" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="312" y="160" font-size="12" font-weight="700" fill="#1e293b">Cost model</text>
  <text x="312" y="178" font-size="11" fill="#1e293b">nodes_touched  ~ ring_size / RF        60 nodes, RF=3  →  20 nodes</text>
  <text x="312" y="196" font-size="11" fill="#1e293b">latency        ~ max(per node)          p99 becomes p99.95 of one node</text>
  <text x="312" y="212" font-size="11" fill="#1e293b">1 % slow-node chance each  →  18 % of queries hit a slow node</text>
  <rect x="300" y="228" width="440" height="76" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="312" y="248" font-size="12" font-weight="700" fill="#1e293b">The safe shape</text>
  <text x="312" y="266" font-size="11" fill="#1e293b">WHERE user_id = ? AND status = 'DISPUTED'</text>
  <text x="312" y="284" font-size="11" fill="#1e293b">partition key present  →  1 node, 1 partition, local index only</text>
  <text x="312" y="300" font-size="11" fill="#1e293b">this is the only universally safe use of any index</text>
</svg>
```

---

## 4. Architecture & Workflow

Walk a `2i` query and an SAI query side by side.

1. **Parse and plan.** The coordinator inspects the `WHERE` clause. If the full partition key is present, it resolves the token and routes to the replicas — a *single-partition* read. If not, it plans a `PartitionRangeReadCommand` over the whole ring.
2. **Choose the index.** With multiple indexed predicates, legacy `2i` picks exactly **one** index (the one it estimates most selective) and applies the rest as post-filters, which is why multi-predicate `2i` queries need `ALLOW FILTERING`. SAI can intersect postings lists from several column indexes before touching a row.
3. **Fan out.** For a range read the coordinator queries token ranges in waves, starting with a concurrency factor of 1 and increasing it if the first wave returned fewer rows than the page size. This adaptive behaviour is why an unselective index query can quietly escalate into a full ring sweep.
4. **Per-replica index lookup.** `2i` reads the hidden index table's partition for the indexed value and collects base primary keys. SAI searches the per-SSTable kd-tree or trie for matching row ids, unions across SSTables, and intersects across columns.
5. **Base-row fetch and validation.** Every candidate primary key is read from the base table. This is a *second* read per hit and is where the real cost sits when many rows match. Stale index entries (row since deleted or value changed) are discarded here.
6. **Merge, filter, page.** The coordinator merges per-replica results, applies remaining post-filters, enforces `LIMIT`, and returns a page plus a `paging_state`. A subsequent page may resume the ring sweep from the last token — so paging deep into an indexed query keeps paying the fan-out.
7. **Maintenance.** `2i` index entries are written on the base write path (an extra local mutation per indexed column). SAI components are built at flush and rewritten during compaction, so indexed writes cost almost nothing extra at request time. `nodetool rebuild_index <ks> <table> <idx>` regenerates from base data.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="340" fill="#ffffff"/>
  <text x="20" y="24" font-size="15" font-weight="700" fill="#1e293b">2i hidden table vs SAI storage-attached components</text>
  <rect x="20" y="40" width="350" height="140" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="34" y="60" font-size="12" font-weight="700" fill="#1e293b">Legacy 2i — a hidden table per index</text>
  <rect x="34" y="70" width="150" height="46" rx="6" fill="#ffffff" stroke="#d97706"/>
  <text x="44" y="88" font-size="10" fill="#1e293b">users (base)</text>
  <text x="44" y="104" font-size="10" fill="#1e293b">K = user_id</text>
  <path d="M188 93 L 214 93" stroke="#d97706" stroke-width="2"/>
  <rect x="218" y="70" width="140" height="46" rx="6" fill="#ffffff" stroke="#d97706"/>
  <text x="228" y="88" font-size="10" fill="#1e293b">users_email_idx</text>
  <text x="228" y="104" font-size="10" fill="#1e293b">K = email  C = user_id</text>
  <text x="34" y="136" font-size="11" fill="#1e293b">extra local mutation on every indexed write</text>
  <text x="34" y="152" font-size="11" fill="#1e293b">high cardinality → millions of 1-row partitions</text>
  <text x="34" y="168" font-size="11" fill="#1e293b">low cardinality → a few giant hot partitions</text>
  <rect x="390" y="40" width="350" height="140" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="404" y="60" font-size="12" font-weight="700" fill="#1e293b">SAI (5.0) — components inside each SSTable</text>
  <rect x="404" y="70" width="320" height="50" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="414" y="88" font-size="10" fill="#1e293b">SSTable-42:  data + rowid→PK map</text>
  <text x="414" y="104" font-size="10" fill="#1e293b">idx(status) trie · idx(price) kd-tree · idx(vec) ANN</text>
  <text x="404" y="140" font-size="11" fill="#1e293b">one shared rowid map across all indexed columns</text>
  <text x="404" y="156" font-size="11" fill="#1e293b">postings intersected before any base row is read</text>
  <text x="404" y="172" font-size="11" fill="#1e293b">built at flush, merged by compaction, no index tombstones</text>
  <text x="20" y="208" font-size="14" font-weight="700" fill="#1e293b">Query execution</text>
  <rect x="20" y="220" width="120" height="46" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="32" y="240" font-size="11" font-weight="700" fill="#1e293b">1. plan</text>
  <text x="32" y="256" font-size="10" fill="#1e293b">PK present?</text>
  <path d="M142 243 L 158 243" stroke="#4f46e5" stroke-width="2"/>
  <rect x="162" y="220" width="130" height="46" rx="6" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="174" y="240" font-size="11" font-weight="700" fill="#1e293b">2. pick index</text>
  <text x="174" y="256" font-size="10" fill="#1e293b">2i: one · SAI: many</text>
  <path d="M294 243 L 310 243" stroke="#4f46e5" stroke-width="2"/>
  <rect x="314" y="220" width="130" height="46" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="326" y="240" font-size="11" font-weight="700" fill="#1e293b">3. fan out</text>
  <text x="326" y="256" font-size="10" fill="#1e293b">adaptive concurrency</text>
  <path d="M446 243 L 462 243" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="466" y="220" width="130" height="46" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="478" y="240" font-size="11" font-weight="700" fill="#1e293b">4. index lookup</text>
  <text x="478" y="256" font-size="10" fill="#1e293b">→ candidate PKs</text>
  <path d="M598 243 L 614 243" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="618" y="220" width="122" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="630" y="240" font-size="11" font-weight="700" fill="#1e293b">5. base read</text>
  <text x="630" y="256" font-size="10" fill="#1e293b">validate + merge</text>
  <rect x="20" y="280" width="720" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="34" y="300" font-size="12" font-weight="700" fill="#1e293b">Step 5 is the hidden cost: one extra base-table read per candidate row.</text>
  <text x="34" y="318" font-size="12" fill="#1e293b">An unselective index predicate turns into thousands of random reads per node.</text>
</svg>
```

---

## 5. Implementation

```cql
CREATE KEYSPACE shop WITH replication =
  {'class':'NetworkTopologyStrategy','us_east':3,'eu_west':3};

CREATE TABLE shop.orders_by_user (
  user_id     uuid,
  created_at  timestamp,
  order_id    uuid,
  status      text,          -- PENDING | PAID | SHIPPED | DISPUTED  (5 values)
  total_cents bigint,
  region      text,
  tags        set<text>,
  PRIMARY KEY ((user_id), created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id DESC);
```

**Legacy `2i` — acceptable here because queries always supply `user_id`:**

```cql
CREATE INDEX orders_status_idx ON shop.orders_by_user (status);

-- ✅ SAFE: partition key + index predicate. One node, one partition.
SELECT order_id, total_cents FROM shop.orders_by_user
WHERE user_id = 8f2a3c7e-... AND status = 'DISPUTED';

-- ❌ DANGEROUS: no partition key. Scatter-gather across ring_size/RF nodes,
--    and 'PENDING' matches ~20 % of every node's rows.
SELECT order_id FROM shop.orders_by_user WHERE status = 'PENDING';
-- ReadTimeout: Operation timed out - received only 0 responses.

-- Collection index: same rules apply
CREATE INDEX orders_tags_idx ON shop.orders_by_user (tags);
SELECT * FROM shop.orders_by_user WHERE user_id = 8f2a... AND tags CONTAINS 'gift';

-- Map indexes come in three flavours
CREATE INDEX ON shop.orders_by_user (KEYS(attrs));    -- WHERE attrs CONTAINS KEY 'x'
CREATE INDEX ON shop.orders_by_user (VALUES(attrs));  -- WHERE attrs CONTAINS 'y'
CREATE INDEX ON shop.orders_by_user (ENTRIES(attrs)); -- WHERE attrs['x'] = 'y'
```

**SAI (Cassandra 5.0) — ranges, multiple predicates, and no `ALLOW FILTERING`:**

```cql
CREATE INDEX status_sai ON shop.orders_by_user (status)
  USING 'sai';
CREATE INDEX total_sai  ON shop.orders_by_user (total_cents)
  USING 'sai';
CREATE INDEX region_sai ON shop.orders_by_user (region)
  USING 'sai' WITH OPTIONS = {'case_sensitive':'false', 'normalize':'true'};

-- SAI intersects postings lists — legal without ALLOW FILTERING, unlike 2i
SELECT order_id, total_cents FROM shop.orders_by_user
WHERE user_id = 8f2a... AND status = 'PAID' AND total_cents > 50000;

-- numeric range on a kd-tree index
SELECT order_id FROM shop.orders_by_user
WHERE user_id = 8f2a... AND total_cents >= 10000 AND total_cents < 25000;

-- vector ANN, 5.0 only
CREATE TABLE shop.product_embeddings (
  sku text PRIMARY KEY, title text, embedding vector<float, 384>);
CREATE INDEX emb_ann ON shop.product_embeddings (embedding)
  USING 'sai' WITH OPTIONS = {'similarity_function':'DOT_PRODUCT'};
SELECT sku, title FROM shop.product_embeddings
ORDER BY embedding ANN OF [0.12, -0.03, ...] LIMIT 10;
```

**The alternative you should usually choose — a query table:**

```cql
CREATE TABLE shop.orders_by_status_day (
  status text, day date, created_at timestamp, order_id uuid, user_id uuid,
  PRIMARY KEY ((status, day), created_at, order_id)
) WITH CLUSTERING ORDER BY (created_at DESC, order_id DESC)
  AND default_time_to_live = 7776000;
-- one partition per (status, day): bounded, single-node, no fan-out at all
```

**Operations:**

```bash
# Watch an index build after CREATE INDEX (it is asynchronous)
nodetool -h 10.0.1.11 tpstats | grep -i secondary
# SecondaryIndexManagement          1         0            418         0        0

# Rebuild a suspect index from base data on this node
nodetool rebuild_index shop orders_by_user orders_status_idx

# 4.0+ virtual tables: see what indexes exist and how big they are
cqlsh -e "SELECT keyspace_name, index_name, table_name FROM system_schema.indexes
          WHERE keyspace_name='shop';"
cqlsh -e "SELECT * FROM system_views.disk_usage WHERE keyspace_name='shop' ALLOW FILTERING;"

# Prove the fan-out with tracing
cqlsh -e "TRACING ON; SELECT order_id FROM shop.orders_by_user WHERE status='PENDING';"
# Executing read on shop.orders_by_user using index orders_status_idx [ReadStage-3]
# Enqueuing request to /10.0.1.14  ... /10.0.1.19  ... (18 more)
# Request complete  4,812,331 us      <-- 4.8 seconds
```

```yaml
# cassandra.yaml — 4.1+ guardrails that stop index sprawl before production does
secondary_indexes_per_table_warn_threshold: 1
secondary_indexes_per_table_fail_threshold: 3
sai_sstable_indexes_per_query_warn_threshold: 32
allow_filtering_enabled: false     # turn this off in every production cluster
```

```python
# Driver-side: make the dangerous shape impossible to write by accident
from cassandra.query import SimpleStatement
from cassandra import ConsistencyLevel

def orders_with_status(session, user_id, status):
    # partition key is mandatory in the signature; there is no way to omit it
    stmt = session.prepare(
        "SELECT order_id, total_cents FROM orders_by_user "
        "WHERE user_id = ? AND status = ?")
    stmt.consistency_level = ConsistencyLevel.LOCAL_QUORUM
    return list(session.execute(stmt, (user_id, status)))
```

> **Optimization:** if you must run an unrestricted indexed query (an ops job, a nightly sweep), do the fan-out yourself by token range instead of letting the coordinator do it: iterate `WHERE token(user_id) > ? AND token(user_id) <= ? AND status = ?` over `num_nodes × 4` ranges, in parallel with bounded concurrency, at `LOCAL_ONE`. Each sub-query is routed to a single replica set, failures are retried per range rather than per whole query, and one slow node no longer stalls the entire scan. This is exactly what the Spark Cassandra Connector does.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| Legacy `2i` | Zero modeling work; instant; consistent with base data | Hidden table per index; extra write on every mutation; cardinality extremes both fail badly |
| SAI (5.0) | ~20–35 % of `2i` disk; multi-column intersection; numeric ranges; ANN vectors; no separate write path | 5.0 only; still local, so still a scatter-gather without a partition key; more heap during compaction |
| SASI | Prefix/suffix `LIKE`, tokenized text | Experimental since 3.4, effectively deprecated, unbounded memory on large data — do not use for new work |
| Index vs query table | Index costs one `CREATE INDEX`; no application changes; no dual writes | A query table costs storage plus a fan-out write, but gives a single-partition read at any scale |
| Partition-restricted query | Single node, single partition — index is genuinely cheap here | Requires the caller to always know the partition key |
| Unrestricted query | Works for ad-hoc ops and small clusters | Touches `ring_size/RF` nodes; p99 = tail of the slowest node; does not scale with cluster growth |
| Write amplification | SAI adds negligible request-time cost | `2i` adds a synchronous local index mutation per indexed column per write |
| Consistency | Index reads honour the query's consistency level | Index is rebuilt from base data, not repaired independently; stale entries filtered at base-row read |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Indexing a high-cardinality column** (email, uuid, timestamp) with `2i`. Each distinct value becomes its own partition in the hidden table: millions of one-row partitions. ✅ Build a lookup table `users_by_email` keyed by the email instead — it is one seek and it scales.
2. ⚠️ **Indexing a very low-cardinality column** (`status`, `is_active`, `country`) and querying it globally. Each index partition holds millions of rows per node. ✅ Either restrict the query by partition key, or build a table keyed by `(status, day)`.
3. ⚠️ **Querying an index without the partition key at high QPS.** This is a scatter-gather with tail amplification. ✅ Reserve unrestricted index queries for low-frequency operational work; give user-facing paths their own table.
4. ⚠️ **Adding `ALLOW FILTERING` to make an index query compile.** It converts "cannot do this efficiently" into "will do this slowly, cluster-wide". ✅ Set `allow_filtering_enabled: false` in `cassandra.yaml` (4.1+) and treat the resulting error as a design signal.
5. ⚠️ **Creating five indexes on one table.** Each `2i` index multiplies write cost and compaction load. ✅ Use the 4.1 guardrails (`secondary_indexes_per_table_fail_threshold: 3`) and prefer one SAI index set over several `2i` indexes.
6. ⚠️ **Indexing a column that is frequently updated.** Every value change writes a new index entry plus a tombstone for the old one, so the index accumulates tombstones faster than the base table. ✅ Index stable attributes only; for churny state, model transitions as new rows.
7. ⚠️ **Building new work on SASI.** It has been experimental since 3.4 and is superseded. ✅ Use SAI on 5.0, or a query table on 4.x.
8. ⚠️ **Assuming an index can enforce uniqueness.** Cassandra has no unique constraint; an index will happily hold duplicates. ✅ Use a table keyed by the unique attribute plus a lightweight transaction (`INSERT ... IF NOT EXISTS`) when you truly need uniqueness.
9. ⚠️ **Paging deep into an unrestricted index query.** Each page re-enters the ring sweep, so page 50 is not cheaper than page 1. ✅ Drive large scans by explicit token ranges with bounded parallelism.
10. ⚠️ **Forgetting that `CREATE INDEX` is asynchronous and rebuilds existing data.** On a large table it can saturate compaction for hours. ✅ Create indexes during a maintenance window, watch `nodetool compactionstats` and the `SecondaryIndexManagement` thread pool, and consider building node by node.
11. ⚠️ **Expecting `LIKE '%foo%'` to be fast.** Even SASI/SAI only accelerate prefix (and with tokenization, term) matching. ✅ Use a real search engine (Elasticsearch/OpenSearch/Solr) for full-text, or SAI with an analyzer for term matching.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Turn on `TRACING` for any suspicious query: an indexed query without a partition key prints one `Enqueuing request to /IP` line per node contacted — count them. `nodetool tpstats` shows the `SecondaryIndexManagement` pool (index builds) and a rising `ReadStage` pending count during index sweeps. `system_schema.indexes` lists every index in the cluster, which is how you find the one a departing engineer added at 2 a.m. If an index returns rows that no longer match, `nodetool rebuild_index <ks> <table> <index>` regenerates it from base data on that node; do it node by node, since it is I/O heavy. For SAI, `sstablemetadata` and the SSTable directory listing show the per-column index components and their sizes.

**Monitoring.** Track `org.apache.cassandra.metrics:type=Table,keyspace=<ks>,scope=<table>,name=RangeLatency` — this is the metric for scatter-gather reads, and a rise in it is the earliest signal of index misuse. Also watch `...type=Index,scope=<index>,name=...` beans, `...type=ClientRequest,scope=RangeSlice,name=Latency` and `...name=Timeouts`, plus `...type=ThreadPools,path=internal,scope=SecondaryIndexManagement,name=PendingTasks`. Alert when `RangeSlice` latency p99 exceeds a few hundred milliseconds or when `RangeSlice` throughput grows relative to `Read` throughput — that ratio is a proxy for "how much of my workload is scanning".

**Security.** Index metadata is readable through `system_schema.indexes` by anyone with `DESCRIBE` rights, so an index name can leak schema intent (`ssn_idx`). More materially, an indexed column is *duplicated* into `2i`'s hidden table, which means encrypted-at-rest coverage must include index SSTables (it does, since they are ordinary SSTables) and any client-side encryption makes the index useless. Grant `SELECT` per table, remember an index cannot be granted or revoked separately, and enable 4.0 audit logging for tables holding indexed PII.

**Performance & scaling.** The defining scaling property is that indexed unrestricted queries get *worse* as you add nodes: more nodes means more participants per scatter-gather. Capacity planning must therefore treat such queries as fixed-cost background load, not as something horizontal scaling will fix. For SAI, budget heap and disk: index components add roughly 10–25 % to SSTable size depending on cardinality, and ANN indexes on high-dimension vectors are far larger. Keep `sai_sstable_indexes_per_query_warn_threshold` at its default and pair SAI with `LeveledCompactionStrategy` or `UnifiedCompactionStrategy` so the number of SSTables — and therefore of index components consulted per query — stays low.

---

## 9. Interview Questions

**Q: Why are Cassandra secondary indexes called "local"?**
A: Each node indexes only the rows it stores, so there is no global structure mapping an indexed value to a node. A query filtered only by an indexed column therefore has to be sent to enough nodes to cover the entire token ring, and each node consults its own index independently.

**Q: What happens internally when you `CREATE INDEX ON users (email)`?**
A: Cassandra creates a hidden table on every node, partitioned by the indexed value with the base primary key as clustering columns, containing only that node's rows, and asynchronously backfills it from existing SSTables. Every subsequent write to `email` also writes an entry to that hidden table locally.

**Q: Why is indexing a high-cardinality column bad, and why is indexing a low-cardinality one also bad?**
A: High cardinality creates a separate index partition for nearly every row — millions of one-row partitions with per-partition overhead in bloom filters, index summaries and compaction. Low cardinality creates a handful of index partitions each holding millions of rows per node, which is the unbounded-partition anti-pattern. The usable range is moderate cardinality, ideally queried within a known partition.

**Q: When is a secondary index actually the right tool?**
A: When the query also supplies the full partition key, so the index only narrows rows within one partition on one node, and when the indexed column is stable rather than frequently updated. Low-frequency operational or admin queries on small-to-medium tables are the other legitimate case.

**Q: What does SAI change compared to legacy `2i`?**
A: SAI attaches index components to SSTables instead of maintaining a hidden table, shares one row-id mapping across all indexed columns, supports numeric ranges via kd-trees and text via tries, and can intersect multiple column predicates before reading any base row. It uses roughly a fifth of the disk and offers much higher indexed-write throughput — but it is still a local index, so the fan-out characteristic is unchanged.

**Q: Should you use SASI in a new system?**
A: No. SASI has been marked experimental since 3.4, has known unbounded-memory behaviour on large datasets, and is superseded by SAI in 5.0. On 4.x, prefer a purpose-built query table; on 5.0, prefer SAI.

**Q: What is the difference between `ALLOW FILTERING` and using an index?**
A: An index gives Cassandra a way to find candidate rows without reading everything; `ALLOW FILTERING` explicitly authorizes reading rows and discarding non-matches server-side. Both can scatter across the ring, but `ALLOW FILTERING` has no access path at all, so its cost is proportional to the total data scanned rather than to the matches.

**Q: How do you query an indexed collection?**
A: `CONTAINS` for set values and list elements, `CONTAINS KEY` for map keys, `entry['k'] = 'v'` with an `ENTRIES` index for map entries. The same partition-key rule applies: without the partition key the query is a scatter-gather regardless of the collection index.

**Q: (Senior) A dashboard query using a `status` index started timing out after the cluster grew from 12 to 48 nodes. Explain and fix.**
A: The query has no partition key, so it is a range read touching `ring_size / RF` nodes; growing from 12 to 48 nodes quadrupled the participants and quadrupled the probability of hitting a slow one, while per-node work stayed the same. The correct fix is a query table keyed by `(status, day)` so the dashboard reads one bounded partition. As a stopgap, rewrite the dashboard to iterate explicit token ranges in parallel at `LOCAL_ONE` with per-range retries, which converts one fragile query into many independent ones.

**Q: (Senior) How would you decide between adding an SAI index and building a new query table?**
A: Ask three questions: does the query always know the partition key, what QPS does it need, and how selective is the predicate. Partition-restricted plus any QPS plus any selectivity → SAI is ideal. No partition key plus low QPS (ops, admin, batch) plus high selectivity → SAI is acceptable. No partition key plus user-facing QPS → a query table, always, because no index changes the fact that the read must cover the ring.

**Q: (Senior) What are the operational hazards of running `CREATE INDEX` on a 2 TB-per-node table in production?**
A: The build is asynchronous and rebuilds from all existing SSTables, so it saturates compaction and disk I/O for hours, competes with the live read path for page cache, and temporarily inflates disk usage. Queries against the index return incomplete results until the build finishes on every node, with no strong signal that it has. Mitigate by building during low traffic, watching `nodetool compactionstats` and the `SecondaryIndexManagement` pool, throttling compaction, and — where the tooling allows — rolling it node by node before exposing the query.

**Q: Can an index enforce a uniqueness constraint?**
A: No. Cassandra has no unique constraints; an index will store duplicates without complaint. Uniqueness requires a table whose partition key is the unique attribute plus `INSERT ... IF NOT EXISTS`, which uses Paxos and costs roughly four round trips — acceptable for registration flows, not for hot paths.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Cassandra indexes are local to each node, so an indexed query without the partition key must sweep `ring_size / RF` nodes and inherits the tail latency of the slowest one — and it gets worse as the cluster grows. Legacy `2i` materializes a hidden table keyed by the indexed value, which fails at both cardinality extremes: high cardinality produces millions of tiny partitions, low cardinality produces a few enormous hot ones. SASI is deprecated. SAI in Cassandra 5.0 attaches index components to SSTables, shares a row-id map across columns, supports ranges, collections and vector ANN, and costs a fraction of `2i`'s disk — but it is still local. The rule that survives every version: use an index to narrow *within a known partition* or for low-frequency ops queries; use a purpose-built query table for anything user-facing.

| Item | Value / Command |
| --- | --- |
| Create legacy index | `CREATE INDEX name ON ks.tbl (col);` |
| Create SAI index (5.0) | `CREATE INDEX name ON ks.tbl (col) USING 'sai';` |
| Collection predicates | `CONTAINS`, `CONTAINS KEY`, `attrs['k'] = 'v'` |
| Safe query shape | `WHERE <full partition key> AND <indexed col> = ?` |
| Nodes touched, no PK | `ring_size / RF` |
| Rebuild an index | `nodetool rebuild_index <ks> <tbl> <idx>` |
| List indexes | `SELECT * FROM system_schema.indexes;` |
| Key metric | `type=Table,...,name=RangeLatency` and `scope=RangeSlice` |
| Guardrails (4.1+) | `secondary_indexes_per_table_fail_threshold: 3` |
| Disable filtering | `allow_filtering_enabled: false` |
| SAI vs 2i disk | roughly 20–35 % of `2i` |
| Vector ANN (5.0) | `ORDER BY embedding ANN OF [...] LIMIT k` |

**Flash cards**

- **Why is an indexed query without a partition key slow?** → It is a scatter-gather over `ring_size/RF` nodes; p99 becomes the slowest node's tail.
- **What does `2i` create under the hood?** → A hidden local table partitioned by the indexed value, one per node.
- **Which cardinality is safe to index?** → Moderate — and only when the query also supplies the partition key.
- **What is SAI's headline improvement?** → Storage-attached components, multi-column intersection, ranges and ANN, at ~1/5 the disk of `2i`.
- **What should you build instead of an index for a user-facing query?** → A query table keyed by the filter column, bounded by a bucket.

---

## 11. Hands-On Exercises & Mini Project

- [ ] On a 3-node local cluster (`ccm create idx -v 4.1.5 -n 3 -s` or Docker), create `orders_by_user`, load 2 M rows across 20k users, add a `2i` on `status`, then compare `TRACING` output for the query with and without `user_id` in the `WHERE` clause. Record nodes contacted and latency.
- [ ] Create a `2i` on a uuid column, run `nodetool tablestats` on the hidden index table (`orders_by_user.orders_uuid_idx`), and report the partition count and average partition size. Explain the numbers.
- [ ] Spin up Cassandra 5.0, create SAI indexes on `status` and `total_cents`, and run a two-predicate query without `ALLOW FILTERING`. Compare the on-disk size of the SAI components against an equivalent pair of `2i` indexes.
- [ ] Implement the token-range scan optimization in Python: iterate `token(user_id)` ranges with bounded concurrency at `LOCAL_ONE`, and benchmark it against the single unrestricted indexed query on 2 M rows.
- [ ] Set `allow_filtering_enabled: false` and `secondary_indexes_per_table_fail_threshold: 1`, then try to add a second index and a filtering query. Capture the exact error messages for your team's runbook.

### Mini Project — "Index or table? A decision harness"

**Goal.** Build a reproducible benchmark that tells your team, with numbers, when an index beats a query table.

**Requirements.**
1. Create one base table and three access paths for the same logical query: legacy `2i`, SAI (on a 5.0 cluster), and a purpose-built query table with fan-out writes.
2. Load 10 M rows with realistic cardinality: one column at ~5 distinct values, one at ~5,000, one unique per row.
3. Benchmark each path at 1, 10 and 100 concurrent clients, measuring p50/p95/p99 read latency, write latency, disk usage and nodes contacted (from tracing).
4. Repeat the whole benchmark on a 3-node and a 6-node cluster to demonstrate that the unrestricted index query gets *slower* with more nodes while the query table stays flat.
5. Publish a one-page decision table: cardinality × partition-key-known × QPS → recommended access path.

**Extensions.** Add a `vector<float,384>` column with an SAI ANN index and measure recall against brute-force cosine similarity at k=10. Add a churn workload that updates the indexed column frequently and chart index tombstone growth. Wire the guardrail settings and show the failure modes they prevent.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Query-First Data Modeling* explains the query table that indexes are usually a shortcut around. *Materialized Views* is the other server-side denormalization option and shares many of these caveats. *Denormalization & Table-per-Query* covers keeping the alternative consistent. *Data Types, Collections & UDTs* explains what `CONTAINS` indexes actually index, and *Data Modeling Anti-Patterns* catalogues the index failures seen in production.

- **Secondary Indexes — Apache Cassandra Documentation** — Apache Software Foundation · *Beginner–Intermediate* · Official semantics, restrictions and the explicit guidance on when not to use an index. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/indexing.html>
- **Storage-Attached Indexing (SAI) — Cassandra 5.0 Docs** — Apache Software Foundation · *Intermediate–Advanced* · The definitive description of SAI syntax, options, analyzers and vector ANN support. <https://cassandra.apache.org/doc/latest/cassandra/developing/cql/indexing/sai/sai-concepts.html>
- **CASSANDRA-16052: Storage Attached Index** — Apache JIRA · *Advanced* · The design docs and review discussion behind SAI, including the disk and throughput comparisons against `2i`. <https://issues.apache.org/jira/browse/CASSANDRA-16052>
- **CASSANDRA-10661: SSTable Attached Secondary Index (SASI)** — Apache JIRA · *Advanced* · Original SASI design plus the later discussion of why it never left experimental status. <https://issues.apache.org/jira/browse/CASSANDRA-10661>
- **Cassandra Native Secondary Index Deep Dive** — DataStax / DuyHai Doan · *Advanced* · The classic walkthrough of the hidden index table, its read path and its cardinality failure modes. <https://www.datastax.com/blog/cassandra-native-secondary-index-deep-dive>
- **When to Use (and Not Use) Secondary Indexes** — The Last Pickle · *Intermediate* · Practitioner guidance with concrete cardinality thresholds and real incident patterns. <https://thelastpickle.com/blog/>
- **Spark Cassandra Connector — token-range scanning** — DataStax (GitHub) · *Advanced* · Reference implementation of the parallel token-range scan that replaces unrestricted index queries. <https://github.com/datastax/spark-cassandra-connector>
- **ScyllaDB University — Secondary Indexes and Materialized Views** — ScyllaDB · *Intermediate* · Free lessons contrasting local and global index designs, useful for understanding what Cassandra deliberately does not do. <https://university.scylladb.com/courses/data-modeling/lessons/global-secondary-indexes/>

---

*Apache Cassandra Handbook — chapter 09.*
