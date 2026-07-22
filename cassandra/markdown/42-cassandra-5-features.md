# 42 · Cassandra 4.x & 5.x: New Features

> **In one line:** Cassandra 4.0 made the database observable and safe to operate (virtual tables, audit log, zero-copy streaming), and Cassandra 5.0 made it competitive again as a query and AI platform (Storage-Attached Indexes, trie memtables and SSTables, Unified Compaction, and native vector search).

---

## 1. Overview

For most of the 2010s Cassandra's reputation was earned and stagnant: extraordinary write throughput and linear scale, paired with an operator experience built out of JMX beans, log-grepping, and folklore. Version 3.11 shipped in 2017 and the project then spent nearly four years on 4.0, which arrived in July 2021 as the most heavily tested release in the project's history — including a fuzz-testing and simulation effort (`CASSANDRA-15348`) that found bugs nobody had reproduced in a decade of production. The theme of 4.0 was not features but **trust**: make the thing observable, make streaming fast, make upgrades boring.

Cassandra 4.1 (December 2022) followed with pluggability: pluggable memtables, guardrails, `CassandraNetworkAuthorizer`, and a much better `nodetool` surface. Then 5.0 (September 2024) delivered the largest functional change since CQL itself. **Storage-Attached Indexes** finally give a secondary index that is not a trap. **Trie memtables and trie-indexed SSTables** (`BTI` format) cut memory and improve lookup performance materially. **Unified Compaction Strategy** replaces the STCS/LCS/TWCS choice with one strategy and a scaling parameter. **Vector search** with a `vector<float, n>` type and an ANN index turns Cassandra into a viable store for embeddings, arriving exactly as retrieval-augmented generation became the dominant AI application pattern.

Why these features exist is a coherent story. Cassandra's original secondary index (`2i`) was a hidden local table keyed by the indexed value; on a high-cardinality column it fanned out to every node and returned almost nothing, so the community's guidance became "never use it". SASI, added experimentally in 3.4, was better but was never made production-ready. SAI (`CASSANDRA-16052`) is a genuinely new design: a per-SSTable index attached to the storage engine, sharing the same term dictionary infrastructure, with dramatically lower write amplification than 2i and support for numeric ranges, text matching, collection indexing, and vector similarity in one framework.

Meanwhile compaction had become a configuration burden: choose STCS and accept read amplification and 50% wasted disk, choose LCS and pay 2–3× write I/O, choose TWCS and accept its assumptions about time-ordered writes. UCS (`CASSANDRA-18397`) parameterizes the whole family with a single scaling parameter `w`, where negative values behave like levelled, positive like tiered, and zero sits between — and it can be changed online without rewriting the whole dataset.

A concrete example of the combined effect: a product-search team previously ran Cassandra for the canonical catalogue, Elasticsearch for filtered search, and a separate vector database for semantic similarity — three stores, three consistency stories, three on-call rotations. On 5.0 they define one table with SAI indexes on `category`, `price`, and `brand`, plus a `vector<float, 768>` column with an ANN index for embedding similarity, and answer both filtered and semantic queries from the store that already holds the truth. That consolidation is what 5.0 is actually selling.
## 2. Core Concepts

- **Virtual tables** — read-only, node-local tables in `system_views` and `system_virtual_schema` exposing metrics, settings, caches, and thread pools as CQL, so you can query `nodetool`-grade information without JMX.
- **Audit log** — 4.0's categorized, filterable binary log of cluster activity, decoded with `auditlogviewer` (see chapter 39).
- **Full query log (FQL)** — 4.0's record of every query with bind values, replayable with `fqltool replay` for upgrade and capacity testing.
- **Zero-copy streaming** — 4.0 streams whole SSTables at the block level without deserializing, making bootstrap and repair several times faster.
- **Guardrails** — 4.1+ configurable warn/fail thresholds (partition size, collection size, number of tables, `ALLOW FILTERING` usage) that stop bad usage at the server instead of in a wiki page.
- **SAI (Storage-Attached Index)** — 5.0's secondary index attached to each SSTable, supporting equality, ranges, collections, text analysis, and vector similarity with low write amplification.
- **Trie memtable / BTI SSTable format** — 5.0 memtable and SSTable index structures based on tries, reducing heap use and improving key lookup; `BTI` is selected with `sstable_format`.
- **UCS (Unified Compaction Strategy)** — 5.0's single compaction strategy parameterized by a scaling factor `w`, subsuming tiered and levelled behaviour and adjustable online.
- **Vector type + ANN** — 5.0's `vector<float, n>` column type and `ORDER BY ... ANN OF ...` query using a JVector-based HNSW-style index for approximate nearest-neighbour search.
- **Dynamic data masking** — 5.0 column-level masking functions (`mask_inner`, `mask_replace`, …) with `UNMASK` and `SELECT_MASKED` permissions.
- **Accord / general transactions** — the Paxos-successor consensus protocol (`CEP-15`) targeting multi-partition ACID transactions, landing after 5.0; know it exists and that it is not yet GA.
## 3. Theory & Internals

### 3.1 SAI: why it is not `2i`

A legacy secondary index (`2i`) is a hidden Cassandra table whose partition key is the *indexed value* and whose rows point at base-table primary keys, stored locally on each node. Consequences: writing a row writes a second row; a query with only the index restriction must be sent to **every node** because the index is local; and on a high-cardinality column each node returns a handful of matches, so you pay N nodes of latency for a few rows.

SAI keeps the query fan-out (it is still a local index, so a non-partition-restricted query still hits all nodes) but changes everything else:

- **One index structure per SSTable**, built during flush and compaction, not a separate table with its own write path. Write amplification drops from roughly 1 extra row per index to a modest per-SSTable structure.
- **Shared infrastructure across index types.** Numeric columns get a balanced k-d-tree-like structure for range queries; text columns get an inverted index over an on-disk trie term dictionary; vectors get a graph index. Multiple SAI indexes on the same table intersect their posting lists before touching the base data.
- **Multi-column intersection.** `WHERE category = 'shoes' AND price < 5000` with SAI on both columns intersects postings, so the number of base-table rows read is close to the number of matches, not the number matching the more selective single predicate.

The read cost model, approximately:

```
2i:   rows_read ≈ matches_per_node × nodes   (+ one extra read path per row)
SAI:  rows_read ≈ intersected_matches        (postings intersected first)
```

SAI still cannot make an unbounded scan cheap. The correct mental model is: **SAI turns "impossible" into "acceptable for moderate selectivity", not into a relational index.** Restrict by partition key when you can.

### 3.2 Trie memtables and the BTI format

The classic memtable is a `ConcurrentSkipListMap` of `DecoratedKey` to partition, and the classic SSTable index (`big` format) is a sorted index file with a sampled summary held on heap. Both are pointer-heavy: every key carries object headers and skip-list node overhead.

Cassandra 5.0's trie memtable stores keys in a byte-comparable trie, sharing common prefixes and holding data off-heap. The `BTI` (Big Trie-Indexed) SSTable format replaces the index summary with an on-disk trie, so key lookup is a trie walk rather than a binary search plus a disk seek, and the on-heap summary disappears. Measured effects reported by the project: substantially lower heap pressure per gigabyte of memtable and meaningfully faster point lookups on large SSTables, with the biggest wins on workloads with many partitions.

```svg
<svg viewBox="0 0 760 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif"> <rect x="0" y="0" width="760" height="380" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#1e293b">Legacy 2i versus Storage-Attached Index</text>
<rect x="20" y="50" width="345" height="150" rx="8" fill="#fef3c7" stroke="#d97706"/> <text x="38" y="76" font-size="13" font-weight="bold" fill="#1e293b">Legacy 2i</text>
<rect x="38" y="90" width="140" height="38" rx="6" fill="#ffffff" stroke="#d97706"/> <text x="52" y="114" font-size="11" fill="#1e293b">base table row</text>
<rect x="205" y="90" width="140" height="38" rx="6" fill="#ffffff" stroke="#d97706"/> <text x="219" y="114" font-size="11" fill="#1e293b">hidden index row</text>
<path d="M178 109 L205 109" stroke="#d97706" stroke-width="1.5" marker-end="url(#a42)"/> <text x="38" y="152" font-size="11" fill="#1e293b">One extra write per indexed column.</text>
<text x="38" y="172" font-size="11" fill="#1e293b">Query fans out to every node and</text> <text x="38" y="190" font-size="11" fill="#1e293b">returns few rows per node.</text>
<rect x="395" y="50" width="345" height="150" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="413" y="76" font-size="13" font-weight="bold" fill="#1e293b">SAI (Cassandra 5.0)</text>
<rect x="413" y="90" width="100" height="38" rx="6" fill="#ffffff" stroke="#16a34a"/> <text x="427" y="114" font-size="11" fill="#1e293b">SSTable</text>
<rect x="533" y="90" width="90" height="38" rx="6" fill="#ffffff" stroke="#16a34a"/> <text x="547" y="114" font-size="11" fill="#1e293b">SAI index</text>
<rect x="643" y="90" width="90" height="38" rx="6" fill="#ffffff" stroke="#16a34a"/> <text x="657" y="114" font-size="11" fill="#1e293b">postings</text>
<path d="M513 109 L533 109" stroke="#16a34a" stroke-width="1.5" marker-end="url(#a42)"/> <path d="M623 109 L643 109" stroke="#16a34a" stroke-width="1.5" marker-end="url(#a42)"/>
<text x="413" y="152" font-size="11" fill="#1e293b">Index built at flush and compaction,</text> <text x="413" y="172" font-size="11" fill="#1e293b">attached to the SSTable. Multiple</text>
<text x="413" y="190" font-size="11" fill="#1e293b">SAI predicates intersect postings first.</text>
<text x="20" y="238" font-size="13" font-weight="bold" fill="#1e293b">Unified Compaction Strategy scaling parameter</text>
<rect x="20" y="252" width="230" height="80" rx="8" fill="#eef2ff" stroke="#4f46e5"/> <text x="38" y="276" font-size="12" font-weight="bold" fill="#1e293b">w negative</text>
<text x="38" y="298" font-size="11" fill="#1e293b">levelled behaviour</text> <text x="38" y="316" font-size="11" fill="#1e293b">low read amp, high write amp</text>
<rect x="265" y="252" width="230" height="80" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="283" y="276" font-size="12" font-weight="bold" fill="#1e293b">w = 0</text>
<text x="283" y="298" font-size="11" fill="#1e293b">balanced middle ground</text> <text x="283" y="316" font-size="11" fill="#1e293b">the sensible default</text>
<rect x="510" y="252" width="230" height="80" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="528" y="276" font-size="12" font-weight="bold" fill="#1e293b">w positive</text>
<text x="528" y="298" font-size="11" fill="#1e293b">tiered behaviour</text> <text x="528" y="316" font-size="11" fill="#1e293b">low write amp, high read amp</text>
<text x="20" y="360" font-size="11" fill="#1e293b">One strategy, one knob, changeable online with ALTER TABLE. No full rewrite required.</text> <defs>
<marker id="a42" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"> <path d="M0 0 L8 4 L0 8 z" fill="#1e293b"/> </marker> </defs> </svg>
```

### 3.3 UCS: one strategy, one dial

Every LSM compaction strategy trades read amplification against write amplification and space amplification. UCS expresses the whole family with a fan factor derived from a scaling parameter `w`:

```
w > 0   →  fan F = w + 2, tiered: merge F similarly-sized SSTables into one
w = 0   →  F = 2, balanced
w < 0   →  F = 2 - w, levelled: keep one run per level, merge into it
```

`num_shards` (or `base_shard_count`) splits the token range so compaction parallelizes across shards on a single node, which is what makes UCS work well on very dense nodes. `target_sstable_size` bounds output file size. The operational win is that `w` is an `ALTER TABLE` away and takes effect on subsequent compactions — no dump-and-reload to move between tiered and levelled behaviour.

### 3.4 Vector search

A `vector<float, 768>` column stores a fixed-length float array. `CREATE CUSTOM INDEX ... USING 'StorageAttachedIndex'` on that column builds a JVector-based graph index (a DiskANN/HNSW-family structure) per SSTable. An ANN query walks the graph from entry points toward the query vector, bounded by a search-effort parameter, then merges candidate sets across SSTables and replicas.

Two properties matter operationally. First, results are **approximate** — recall is a tuning parameter (`similarity_function`, and search-effort settings), not a guarantee. Second, the index is per-SSTable, so a table with many SSTables costs more per query; compaction directly improves vector query latency and recall, which is an unusual coupling worth remembering.
## 4. Architecture & Workflow

How to actually adopt these features on a running estate:

1. **Get to 4.1 first.** Upgrades are one major version at a time (`3.11 → 4.0 → 4.1 → 5.0`). Run `nodetool upgradesstables` after each major upgrade before starting the next, and never run repair during a mixed-version window.
2. **Turn on observability immediately after 4.0.** Query `system_views.*` to replace half your `nodetool` scripting; enable the audit log with a narrow filter; keep FQL available but off.
3. **Adopt guardrails in 4.1.** Set `partition_size_warn_threshold`, `collection_size_warn_threshold`, `tables_warn_threshold`, and `allow_filtering_enabled: false` in `cassandra.yaml`. This converts tribal knowledge into enforced policy.
4. **Upgrade to 5.0** with the same discipline. Note that new on-disk formats are opt-in: an upgraded cluster keeps writing `big`-format SSTables until you change `sstable_format`.
5. **Enable BTI and trie memtables on a canary.** Set `sstable_format: bti` and a trie memtable configuration on one node, run `nodetool upgradesstables -a` on a subset of tables, and compare heap usage, read latency, and compaction throughput against a control node.
6. **Migrate compaction to UCS table by table.** `ALTER TABLE ... WITH compaction = {'class':'UnifiedCompactionStrategy','scaling_parameters':'T4'}`. Start with the table whose existing strategy fits you worst, watch pending compactions and disk, then proceed.
7. **Introduce SAI where you currently do client-side filtering.** Create the index, verify the query plan with `TRACING ON`, and measure. Drop any legacy `2i` you are replacing only after the SAI index has fully built (`nodetool tablestats` shows index build completion; `system_views` exposes index status).
8. **Add vectors last.** Add a `vector<float, n>` column, backfill embeddings through a throttled Spark job (chapter 41), create the SAI vector index, and tune recall against a labelled evaluation set before exposing it to users.
9. **Re-baseline capacity.** UCS and BTI change usable disk fraction and memory footprint; SAI and vector indexes add real storage. Redo chapter 37's arithmetic after adoption, not before.
10. **Watch for Accord.** Multi-partition transactions (CEP-15) will change data modelling advice again. Track the CEP, but do not design around it until it is GA in a release you run.

```svg
<svg viewBox="0 0 760 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif"> <rect x="0" y="0" width="760" height="360" fill="#ffffff"/>
<text x="20" y="26" font-size="15" font-weight="bold" fill="#1e293b">Feature timeline and adoption order</text> <line x1="40" y1="86" x2="720" y2="86" stroke="#1e293b" stroke-width="2"/>
<circle cx="120" cy="86" r="7" fill="#0ea5e9" stroke="#0ea5e9"/> <circle cx="330" cy="86" r="7" fill="#4f46e5" stroke="#4f46e5"/>
<circle cx="540" cy="86" r="7" fill="#16a34a" stroke="#16a34a"/> <circle cx="690" cy="86" r="7" fill="#d97706" stroke="#d97706"/>
<text x="92" y="72" font-size="12" font-weight="bold" fill="#1e293b">4.0  2021</text> <text x="302" y="72" font-size="12" font-weight="bold" fill="#1e293b">4.1  2022</text>
<text x="512" y="72" font-size="12" font-weight="bold" fill="#1e293b">5.0  2024</text> <text x="652" y="72" font-size="12" font-weight="bold" fill="#1e293b">next</text>
<rect x="40" y="110" width="200" height="120" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/> <text x="56" y="134" font-size="11" fill="#1e293b">virtual tables</text>
<text x="56" y="154" font-size="11" fill="#1e293b">audit log + FQL</text> <text x="56" y="174" font-size="11" fill="#1e293b">zero copy streaming</text>
<text x="56" y="194" font-size="11" fill="#1e293b">incremental repair fix</text> <text x="56" y="214" font-size="11" fill="#1e293b">Java 11 support</text>
<rect x="255" y="110" width="200" height="120" rx="8" fill="#eef2ff" stroke="#4f46e5"/> <text x="271" y="134" font-size="11" fill="#1e293b">guardrails</text>
<text x="271" y="154" font-size="11" fill="#1e293b">pluggable memtables</text> <text x="271" y="174" font-size="11" fill="#1e293b">network authorizer</text>
<text x="271" y="194" font-size="11" fill="#1e293b">CQL improvements</text> <text x="271" y="214" font-size="11" fill="#1e293b">paxos v2</text>
<rect x="470" y="110" width="200" height="120" rx="8" fill="#f0fdf4" stroke="#16a34a"/> <text x="486" y="134" font-size="11" fill="#1e293b">SAI indexes</text>
<text x="486" y="154" font-size="11" fill="#1e293b">trie memtable + BTI</text> <text x="486" y="174" font-size="11" fill="#1e293b">unified compaction</text>
<text x="486" y="194" font-size="11" fill="#1e293b">vector type + ANN</text> <text x="486" y="214" font-size="11" fill="#1e293b">dynamic data masking</text>
<rect x="40" y="258" width="630" height="82" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="58" y="282" font-size="12" font-weight="bold" fill="#1e293b">Upgrade path is strictly one major version at a time</text>
<text x="58" y="304" font-size="11" fill="#1e293b">3.11 to 4.0 to 4.1 to 5.0. Run nodetool upgradesstables between majors. Never repair in a mixed version window.</text>
<text x="58" y="326" font-size="11" fill="#1e293b">New on disk formats are opt in: an upgraded 5.0 cluster keeps writing big format SSTables until you change sstable_format.</text> </svg>
```
## 5. Implementation

### 5.1 Virtual tables: nodetool without JMX

```cql
-- What is actually on disk, per table, on THIS node
SELECT keyspace_name, table_name, mebibytes FROM system_views.disk_usage
 WHERE keyspace_name = 'shop' ALLOW FILTERING;

-- Read latency percentiles without touching JMX
SELECT keyspace_name, table_name, p99th_ms, max_ms
  FROM system_views.local_read_latency
 WHERE keyspace_name = 'shop' ALLOW FILTERING;
--  keyspace_name | table_name        | p99th_ms | max_ms
-- ---------------+-------------------+----------+--------
--          shop  | orders_by_customer|     3.31 |  61.21

-- Thread pool saturation
SELECT name, active_tasks, pending_tasks, blocked_tasks
  FROM system_views.thread_pools WHERE pending_tasks > 0 ALLOW FILTERING;

-- Every yaml setting the node is actually running with
SELECT name, value FROM system_views.settings WHERE name = 'compaction_throughput';

-- Client connections, useful for auditing who is connected
SELECT address, username, driver_name, driver_version, ssl_enabled
  FROM system_views.clients;

-- Discover what else exists
SELECT table_name, comment FROM system_virtual_schema.tables
 WHERE keyspace_name = 'system_views';
```

### 5.2 Guardrails (4.1+)

```yaml
# cassandra.yaml -- enforce the rules instead of documenting them
guardrails:
  partition_size_warn_threshold: 100MiB
  partition_tombstones_warn_threshold: 1000
  collection_size_warn_threshold: 10MiB
  items_per_collection_warn_threshold: 1000
  tables_warn_threshold: 150
  tables_fail_threshold: 300
  columns_per_table_warn_threshold: 50
  fields_per_udt_warn_threshold: 20
  page_size_warn_threshold: 5000
  allow_filtering_enabled: false          # refuse ALLOW FILTERING outright
  read_before_write_list_operations_enabled: false
  secondary_indexes_per_table_warn_threshold: 2
  in_select_cartesian_product_warn_threshold: 25
```

### 5.3 SAI in practice

```cql
CREATE TABLE shop.products (
  product_id  uuid PRIMARY KEY,
  brand       text,
  category    text,
  price_cents int,
  tags        set<text>,
  title       text,
  embedding   vector<float, 768>
);

-- Equality / range indexes
CREATE CUSTOM INDEX products_category_sai ON shop.products (category)
  USING 'StorageAttachedIndex';

CREATE CUSTOM INDEX products_price_sai ON shop.products (price_cents)
  USING 'StorageAttachedIndex';

-- Collection index: index the VALUES of a set
CREATE CUSTOM INDEX products_tags_sai ON shop.products (VALUES(tags))
  USING 'StorageAttachedIndex';

-- Analyzed text index for case-insensitive matching
CREATE CUSTOM INDEX products_title_sai ON shop.products (title)
  USING 'StorageAttachedIndex'
  WITH OPTIONS = {
    'index_analyzer': '{"tokenizer":{"name":"standard"},
                        "filters":[{"name":"lowercase"},{"name":"porterstem"}]}'
  };

-- Multi-predicate query: SAI intersects postings before reading base rows.
SELECT product_id, brand, price_cents
  FROM shop.products
 WHERE category = 'running-shoes'
   AND price_cents < 900000
   AND tags CONTAINS 'waterproof';

-- Text match uses the : operator with an analyzed index
SELECT product_id, title FROM shop.products WHERE title : 'trail running';
```

```bash
# Watch an index build after creation
nodetool tablestats shop.products | grep -A2 "SAI"
cqlsh -e "SELECT * FROM system_views.sstable_tasks;"   # index build shows as a task
```

### 5.4 Vector search

```cql
CREATE CUSTOM INDEX products_embedding_ann ON shop.products (embedding)
  USING 'StorageAttachedIndex'
  WITH OPTIONS = { 'similarity_function': 'cosine' };
-- similarity_function: cosine | dot_product | euclidean

-- Pure ANN search
SELECT product_id, title
  FROM shop.products
 ORDER BY embedding ANN OF [0.021, -0.114, 0.883, /* ... 768 dims ... */]
 LIMIT 10;

-- Hybrid: filter with SAI, rank by vector similarity
SELECT product_id, title, similarity_cosine(embedding, [0.021, -0.114, 0.883]) AS score
  FROM shop.products
 WHERE category = 'running-shoes' AND price_cents < 900000
 ORDER BY embedding ANN OF [0.021, -0.114, 0.883]
 LIMIT 10;
```

```python
# Python driver 3.29+ handles the vector type natively
from cassandra.cluster import Cluster
session = Cluster(["10.0.1.11"]).connect("shop")

UPSERT = session.prepare("""
  INSERT INTO products (product_id, brand, category, price_cents, title, embedding)
  VALUES (?, ?, ?, ?, ?, ?)
""")
UPSERT.is_idempotent = True
session.execute(UPSERT, (pid, "Trailhead", "running-shoes", 749900,
                         "Trailhead GTX Trail Runner", embedding_list_of_768_floats))

ANN = session.prepare("""
  SELECT product_id, title FROM products
   WHERE category = ?
   ORDER BY embedding ANN OF ? LIMIT ?
""")
ANN.is_idempotent = True
for row in session.execute(ANN, ("running-shoes", query_vector, 10)):
    print(row.product_id, row.title)
```

### 5.5 Unified Compaction and BTI

```cql
-- Tiered-like behaviour with fan factor 4
ALTER TABLE shop.orders_by_customer WITH compaction = {
  'class': 'UnifiedCompactionStrategy',
  'scaling_parameters': 'T4',
  'target_sstable_size': '1GiB',
  'base_shard_count': 4
};

-- Levelled-like behaviour for a read-heavy, overwrite-heavy table
ALTER TABLE shop.products WITH compaction = {
  'class': 'UnifiedCompactionStrategy',
  'scaling_parameters': 'L10',
  'target_sstable_size': '512MiB'
};
```

```yaml
# cassandra.yaml -- 5.0 storage engine options
sstable:
  selected_format: bti          # trie-indexed SSTables

memtable:
  configurations:
    trie:
      class_name: TrieMemtable
    default:
      inherits: trie
```

```bash
# Rewrite existing SSTables into the new format (heavy; do it rack by rack)
nodetool upgradesstables -a shop products
nodetool compactionstats -H
```

**Optimization note.** Adopt in the order that gives value per unit of risk. Virtual tables and guardrails are free and immediate — do them first. UCS is a per-table `ALTER` that pays back in usable disk (levelled-like behaviour at ~65% usable versus STCS's 50%) and can be tuned without a rewrite, so it is next. BTI and trie memtables need `upgradesstables`, which is an I/O campaign, so canary first and measure heap and p99. SAI is the highest-value but highest-care item: each index adds write-path and storage cost, so index only the columns you actually filter on, keep `secondary_indexes_per_table_warn_threshold` honest at 2–3, and never treat SAI as permission to stop thinking about partition keys. For vector search, remember that recall improves with compaction because the graph index is per-SSTable — a table with 200 small SSTables gives worse ANN results than the same data in 20.
## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost/Trade-off |
|---|---|---|
| Virtual tables (4.0) | `nodetool`-grade data over CQL; no JMX plumbing | Node-local only — you must query each node or aggregate yourself |
| Audit log / FQL (4.0) | Real compliance and replay capability | Unfiltered audit doubles I/O; FQL volume is enormous |
| Zero-copy streaming (4.0) | Bootstrap and replace several times faster; raises safe node density | Only applies when the whole SSTable is within the streamed range |
| Guardrails (4.1) | Turns best practices into enforced limits | Can break existing (bad) queries on upgrade — audit before setting fail thresholds |
| SAI (5.0) | Usable secondary indexing: ranges, collections, analyzed text, multi-predicate intersection | Still fans out to all nodes without a partition restriction; adds write and storage cost per index |
| Trie memtable + BTI (5.0) | Lower heap per GB of memtable, faster key lookup, smaller on-heap footprint | Requires `upgradesstables` to convert existing data; newer code path with less production mileage |
| UCS (5.0) | One strategy, one dial, changeable online; better disk utilization than STCS | New; existing runbooks and tuning intuition are written for STCS/LCS/TWCS |
| Vector + ANN (5.0) | Embeddings live with the source of truth; hybrid filter+similarity in one query | Approximate recall needs tuning; index quality depends on compaction state; high memory per index |
| Dynamic data masking (5.0) | Column-level obfuscation without application changes | Masking is not encryption — a role with `UNMASK` sees everything |
| Accord (future) | Real multi-partition transactions | Not GA; do not model around it yet |
## 7. Common Mistakes & Best Practices

1. ⚠️ **Skipping major versions on upgrade.** → ✅ Go one major at a time (`3.11 → 4.0 → 4.1 → 5.0`), running `nodetool upgradesstables` between them. Direct jumps hit incompatible messaging and SSTable formats.
2. ⚠️ **Running repair during a mixed-version rolling upgrade.** → ✅ Suspend all repair (and ideally heavy compaction) until every node is on the new version. Streaming between versions is where upgrade incidents come from.
3. ⚠️ **Assuming 5.0 automatically gives you BTI and trie memtables.** → ✅ They are opt-in via `sstable.selected_format: bti` and memtable configuration, plus `nodetool upgradesstables -a` to convert existing data. An upgraded cluster keeps the old formats until you act.
4. ⚠️ **Treating SAI as a relational index.** → ✅ Without a partition key restriction, an SAI query still coordinates across every node in the DC. Use it to add selectivity within a known partition or for genuinely moderate-selectivity lookups, not to replace data modelling.
5. ⚠️ **Creating an SAI index on every column "just in case".** → ✅ Each index adds flush/compaction work and disk. Index the columns your queries actually filter on; keep the count per table small (2–3) and let `secondary_indexes_per_table_warn_threshold` police it.
6. ⚠️ **Migrating from `2i` to SAI by dropping the old index first.** → ✅ Create the SAI index, wait for the build to complete on every node, verify query results and latency, then drop the legacy index. Index builds on a large table take hours.
7. ⚠️ **Turning on `allow_filtering_enabled: false` without auditing.** → ✅ Enable audit logging or FQL first to find which queries use `ALLOW FILTERING`; flipping the guardrail blind will break production code paths, including some analytics jobs.
8. ⚠️ **Switching every table to UCS in one change window.** → ✅ Migrate table by table, starting with the one whose current strategy fits worst, and watch pending compactions and disk between each. UCS will rewrite data as it reorganizes.
9. ⚠️ **Expecting exact results from ANN queries.** → ✅ Vector search is approximate; recall is a tuning outcome. Build a labelled evaluation set, measure recall@k, and tune `similarity_function` and search effort before shipping.
10. ⚠️ **Ignoring the compaction/vector-recall coupling.** → ✅ The vector index is per-SSTable, so a fragmented table means more graphs to search and worse latency and recall. Keep SSTable counts healthy on vector tables.
11. ⚠️ **Believing dynamic data masking is a security control on its own.** → ✅ It obscures values in query results for roles lacking `UNMASK`, but the data is stored in plaintext and any role with `UNMASK` or filesystem access sees it. Combine with RBAC and at-rest encryption.
12. ⚠️ **Reading a virtual table on one node and calling it a cluster view.** → ✅ `system_views` is node-local by design. Query every node (or scrape into your metrics system) before drawing cluster-wide conclusions.
## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

Virtual tables are the fastest debugging surface Cassandra has ever had. A five-query triage:

```cql
SELECT name, active_tasks, pending_tasks, blocked_tasks FROM system_views.thread_pools;
SELECT keyspace_name, table_name, mebibytes FROM system_views.disk_usage;
SELECT * FROM system_views.sstable_tasks;              -- compactions, index builds, streams
SELECT keyspace_name, table_name, p99th_ms FROM system_views.local_read_latency;
SELECT address, username, driver_name, requests FROM system_views.clients;
```

For SAI, trace a query to confirm the index was used and how many rows it actually touched:

```
cqlsh> TRACING ON;
cqlsh> SELECT product_id FROM shop.products WHERE category='running-shoes' AND price_cents < 900000;
 activity                                                    | source    | source_elapsed
--------------------------------------------------------------+-----------+---------------
 Executing read on shop.products using index products_categ.. | 10.0.1.11 |            311
 Index posting lists intersected: 412 candidates               | 10.0.1.11 |           1044
 Read 401 live rows and 0 tombstone cells                      | 10.0.1.11 |           2870
```

If "candidates" is orders of magnitude above the returned row count, your predicate is not selective and SAI is scanning far more than you think.

### Monitoring

| Signal | Where |
|---|---|
| SAI index build progress | `system_views.sstable_tasks` (task type `INDEX_BUILD`) |
| SAI query selectivity | query trace `candidates` vs rows returned; `Table.*` read latency |
| Per-index disk usage | `system_views.disk_usage`, and `nodetool tablestats` index section |
| UCS backlog | `Compaction.PendingTasks` plus `system_views.sstable_tasks` |
| SSTable count on vector tables | `Table.LiveSSTableCount` — high counts degrade ANN recall and latency |
| Memtable heap after trie migration | `Table.MemtableOnHeapSize` compared to pre-migration baseline |
| Guardrail violations | `system.log` WARN lines; guardrail metrics under `org.apache.cassandra.metrics:type=Guardrails` |
| Audit log volume | file growth in `audit_logs_dir` |

### Security

5.0's dynamic data masking adds two permissions worth understanding: `UNMASK` lets a role see real values in masked columns, and `SELECT_MASKED` lets a role query (filter on) a masked column without seeing it. Combine with the RBAC design from chapter 38: analytics roles get `SELECT` plus `SELECT_MASKED` but not `UNMASK`. Guardrails have a security dimension too — `allow_filtering_enabled: false` and page-size limits are effective denial-of-service protections against a careless or malicious client. And the 4.0 audit log is what turns any of this into evidence.

### Performance & Scaling

Every 5.0 feature changes a number from chapter 37's capacity plan. UCS raises usable disk fraction from ~50% (STCS) toward ~65%. Trie memtables lower heap pressure, which may let you shift RAM to page cache. SAI adds storage per index — budget 5–20% of the base table per indexed column depending on cardinality — and adds flush and compaction CPU. Vector indexes are the heaviest: a 768-dimension float vector is 3 KB per row before the graph, so a 100-million-row table carries ~300 GB of raw vectors plus index. Re-run the sizing arithmetic after adoption, and canary each feature on one rack with a control rack for comparison rather than trusting release-note benchmarks.
## 9. Interview Questions

**Q: What were the headline changes in Cassandra 4.0?**
A: Observability and operational trust rather than new query features: virtual tables exposing metrics and settings over CQL, audit logging and full query logging, zero-copy streaming that made bootstrap and repair several times faster, a corrected incremental repair, Java 11 support, and an unprecedented testing effort including simulation and fuzz testing. The practical effect was that 4.0 made Cassandra far cheaper to operate and safer to upgrade.

**Q: Why is SAI different from the old secondary index?**
A: A legacy `2i` is a hidden local table, so every indexed write is an extra row write, and high-cardinality columns produce queries that fan out to every node for a handful of matches. SAI attaches index structures to each SSTable, built during flush and compaction, sharing infrastructure across numeric, text, collection, and vector index types, and it intersects posting lists across multiple indexed predicates before reading base rows. Write amplification and read cost both drop substantially — though the query still fans out across nodes when there is no partition key restriction.

**Q: Does SAI let you stop worrying about partition keys?**
A: No. SAI is a local index, so a query restricted only by an indexed column must be coordinated across every node in the datacenter, gather results, and merge them. It makes moderate-selectivity secondary access viable and makes multi-predicate filtering within a partition genuinely cheap, but partition-key-driven access remains the design centre of Cassandra data modelling.

**Q: What is the Unified Compaction Strategy and what problem does it solve?**
A: UCS replaces the STCS/LCS/TWCS choice with a single strategy parameterized by a scaling factor: negative values behave like levelled compaction, positive like tiered, zero in between, with sharding to parallelize compaction on dense nodes. It solves both the "which strategy" decision and the migration problem — you change behaviour with an `ALTER TABLE` and it takes effect on subsequent compactions rather than requiring a dump and reload.

**Q: What are virtual tables and what are their limits?**
A: They are read-only tables in `system_views` and `system_virtual_schema` that expose runtime information — thread pools, disk usage, latency histograms, settings, caches, connected clients, running SSTable tasks — as ordinary CQL, so you can debug without JMX or `nodetool`. The key limit is that they are node-local: querying one node tells you about that node only, so cluster-wide views require querying every node or scraping into a metrics system.

**Q: How does vector search work in Cassandra 5.0?**
A: You declare a `vector<float, n>` column and create a `StorageAttachedIndex` on it with a similarity function (cosine, dot product, or euclidean), which builds a JVector graph index per SSTable. Queries use `ORDER BY embedding ANN OF [...] LIMIT k`, optionally combined with SAI predicates for hybrid filtered search. Results are approximate, so recall must be measured and tuned rather than assumed.

**Q: (Senior) You are upgrading a 3.11 cluster to 5.0. Lay out the plan.**
A: One major version at a time: 3.11 → 4.0 → 4.1 → 5.0, with `nodetool upgradesstables` completed between majors and no repair running during any mixed-version window. Before starting, capture a workload sample with FQL on a 4.0 canary so you can `fqltool replay` against each target version, and audit for `ALLOW FILTERING` and oversized partitions since 4.1 guardrails may reject them. Roll node by node, rack by rack, verifying `nodetool status`, gossip stability, and client error rates between nodes, and hold at each major long enough to observe a full daily cycle. Once on 5.0, treat the new storage formats as separate projects: enable BTI and trie memtables on a canary rack first, migrate compaction to UCS table by table, and only then consider SAI and vectors.

**Q: (Senior) What is the operational cost of adding SAI indexes, and how do you decide what to index?**
A: Each SAI index is built during flush and compaction, so it adds CPU to both and storage proportional to cardinality — typically 5–20% of the base table per indexed column. Adding indexes therefore raises write-path cost, lengthens compaction, and changes your capacity plan. Decide by looking at real query patterns: index columns that appear in `WHERE` clauses of high-volume queries where the predicate is genuinely selective, prefer intersecting two moderately selective indexes over one weak one, and verify with query tracing that the candidate count is close to the returned row count. Keep the per-table count to two or three and let the guardrail warn you when it creeps.

**Q: (Senior) Why does compaction state affect vector search quality?**
A: The vector index is attached per SSTable, so a query must search one graph per SSTable and merge candidates. With many small SSTables, each graph is built from a small, unrepresentative subset of vectors, so the approximate search explores poorer neighbourhoods and both latency and recall degrade. Compacting into fewer, larger SSTables builds better-connected graphs over more vectors, improving both. This makes SSTable count a *quality* metric for vector tables, not just a performance one, and argues for a compaction strategy tuned toward fewer files on vector-bearing tables.

**Q: What are guardrails and why do they matter?**
A: Guardrails, added in 4.1, are server-side warn and fail thresholds for the things that historically killed Cassandra clusters: partition size, tombstone counts, collection sizes, number of tables, columns per table, page size, secondary index count, and `ALLOW FILTERING` usage. They convert best practices from documentation into enforcement, which matters because the failures they prevent are the ones application teams cannot see from their side. Enable warns first, audit what fires, then promote to fail thresholds.

**Q: What is dynamic data masking and what is it not?**
A: It is a 5.0 feature that applies masking functions (`mask_inner`, `mask_replace`, `mask_hash`, and others) to column values in query results, so roles without the `UNMASK` permission see obfuscated data while `SELECT_MASKED` lets them still filter on it. It is not encryption: the values are stored in plaintext on disk, so anyone with filesystem access or the `UNMASK` permission sees everything. Use it as a convenience layer over proper RBAC and at-rest encryption, never instead of them.

**Q: What is Accord and should you design for it today?**
A: Accord (CEP-15) is a leaderless consensus protocol intended to give Cassandra general multi-partition ACID transactions with one round trip in the common case, replacing the limitations of Paxos-based lightweight transactions. It is genuinely transformative for data modelling if it lands as designed, since it would remove the "denormalize because you cannot join or transact" constraint. But it is not GA, so track the CEP and prototype if you like — do not model production schemas around it until it ships in a version you actually run.
## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Cassandra 4.0 (2021) was about trust: virtual tables in `system_views`, audit log and FQL, zero-copy streaming, fixed incremental repair, massive testing. 4.1 (2022) added guardrails, pluggable memtables, and network authorization. 5.0 (2024) is the functional leap: SAI gives a secondary index that actually works (numeric ranges, analyzed text, collections, multi-predicate intersection, all attached per SSTable), trie memtables and the BTI SSTable format cut heap and speed lookups, Unified Compaction Strategy collapses STCS/LCS/TWCS into one strategy with a scaling parameter you can change online, and `vector<float, n>` plus `ORDER BY ... ANN OF` brings native approximate nearest-neighbour search. Upgrade one major at a time with `upgradesstables` between, never repair mid-upgrade, and remember the new storage formats are opt-in. SAI is not a relational index — without a partition restriction it still fans out to every node — and ANN recall depends on compaction state because the graph index is per-SSTable.

| Feature | Version | How to use it |
|---|---|---|
| Virtual tables | 4.0 | `SELECT * FROM system_views.thread_pools;` |
| Audit log | 4.0 | `audit_logging_options` / `nodetool enableauditlog` |
| Full query log | 4.0 | `nodetool enablefullquerylog` + `fqltool replay` |
| Zero-copy streaming | 4.0 | automatic; makes bootstrap/replace much faster |
| Guardrails | 4.1 | `guardrails:` block in `cassandra.yaml` |
| Network authorizer | 4.1 | `ALTER ROLE r WITH ACCESS TO DATACENTERS {...}` |
| SAI | 5.0 | `CREATE CUSTOM INDEX ... USING 'StorageAttachedIndex'` |
| Analyzed text index | 5.0 | index option `index_analyzer`, query with `title : 'term'` |
| Trie memtable | 5.0 | `memtable.configurations` with `TrieMemtable` |
| BTI SSTable format | 5.0 | `sstable.selected_format: bti` + `nodetool upgradesstables -a` |
| UCS | 5.0 | `compaction = {'class':'UnifiedCompactionStrategy','scaling_parameters':'T4'}` |
| Vector search | 5.0 | `vector<float, 768>` + SAI + `ORDER BY col ANN OF [...] LIMIT k` |
| Data masking | 5.0 | `MASKED WITH mask_inner(1,1)` + `UNMASK` / `SELECT_MASKED` perms |

**Flash cards**

- **4.0's theme** → Observability and safety: virtual tables, audit log, FQL, zero-copy streaming.
- **What makes SAI different** → Index attached per SSTable, built at flush/compaction, postings intersected across predicates.
- **UCS in one line** → One strategy, scaling parameter `w`: negative = levelled, positive = tiered, changeable online.
- **Vector search caveat** → Approximate; recall degrades with high SSTable counts because the graph index is per-SSTable.
- **Upgrade rule** → One major at a time, `upgradesstables` between, no repair in a mixed-version window.
## 11. Hands-On Exercises & Mini Project

- [ ] Start a Cassandra 5.0 container, then answer five operational questions using only `system_views` (disk usage per table, pending compactions, thread pool saturation, p99 read latency, connected clients) without running `nodetool` once.
- [ ] Create a 5-million-row table with a legacy `2i` on a medium-cardinality column and an identical table with SAI. Compare write throughput, on-disk size, and query latency for the same filtered query.
- [ ] Build a two-predicate SAI query (`category` + `price_cents` range), run it with `TRACING ON`, and record the candidate count versus rows returned. Then make one predicate far less selective and observe how the candidate count changes.
- [ ] Migrate a table from STCS to `UnifiedCompactionStrategy` with `T4`, then to `L10`, measuring SSTable count, total disk, and read latency at each step.
- [ ] Enable guardrails with `allow_filtering_enabled: false` and `partition_size_warn_threshold: 10MiB` on a test cluster, then deliberately violate each and capture the exact client error and log line.
- [ ] Load 100k text embeddings into a `vector<float, 384>` column, create the ANN index, and measure recall@10 against exact brute-force results before and after running `nodetool compact`.

### Mini Project — "One Store Instead of Three"

**Goal.** Replace a three-system stack (Cassandra for records, Elasticsearch for filtered search, a vector DB for similarity) with a single Cassandra 5.0 table, and prove the trade-offs with measurements rather than assertions.

**Requirements.**
1. A `products` table holding the canonical record plus `category`, `brand`, `price_cents`, `tags set<text>`, `title`, and `embedding vector<float, 384>`, loaded with at least 1 million realistic rows.
2. SAI indexes for structured filtering (category, price range, tags collection) and an analyzed text index on `title`, plus an ANN index on `embedding` with a chosen similarity function.
3. Three query paths implemented and benchmarked: exact key lookup, filtered structured search, and hybrid filter-plus-similarity search — each reported with p50/p99 and result counts.
4. A recall evaluation: compute exact nearest neighbours by brute force for 500 sample queries and report recall@10 for the ANN index, before and after a major compaction.
5. A cost report using chapter 37's arithmetic: base table size, added SAI size per index, added vector storage, and the resulting node-count delta versus the same table with no indexes.

**Extensions.**
- Add dynamic data masking to a sensitive column and demonstrate that a role with `SELECT_MASKED` but not `UNMASK` can filter on it without reading it.
- Migrate the table to `bti` format and trie memtables on one rack only, and report the heap and latency delta against the control rack under identical load.
- Add UCS with two different scaling parameters on two copies of the table and chart read amplification, write amplification, and disk usage against each other to find your workload's right value.
## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Secondary Indexes & Materialized Views* — what SAI replaces and why the old options failed; *Compaction Strategies* — the STCS/LCS/TWCS baseline that UCS unifies; *Capacity Planning & Cluster Sizing* — every 5.0 feature changes a number in that plan; *Encryption & Auditing* — the audit log and FQL introduced here in operational detail; *Authentication, Authorization & RBAC* — the `UNMASK`/`SELECT_MASKED` permissions; *Monitoring & Observability* — virtual tables as a metrics source; *Spark, Kafka & Streaming Integration* — SAI reduces how much you need to push into Spark.

- **Apache Cassandra 5.0 Documentation** — Apache Software Foundation · *Intermediate* · The authoritative reference for SAI syntax, vector types, UCS options, and the new storage formats. <https://cassandra.apache.org/doc/latest/>
- **Apache Cassandra Blog — "Introducing Storage-Attached Indexes"** — Apache Cassandra project · *Advanced* · Design rationale and performance characteristics of SAI versus 2i and SASI. <https://cassandra.apache.org/_/blog/Apache-Cassandra-5.0-Features-Storage-Attached-Indexes.html>
- **Apache Cassandra Blog — "Vector Search in Cassandra 5.0"** — Apache Cassandra project · *Intermediate* · How the vector type, ANN queries, and similarity functions work, with hybrid search examples. <https://cassandra.apache.org/_/blog/Apache-Cassandra-5.0-Features-Vector-Search.html>
- **CASSANDRA-16052: Storage Attached Index** — Apache JIRA · *Advanced* · The implementation ticket; read the design docs attached for the posting-list intersection model. <https://issues.apache.org/jira/browse/CASSANDRA-16052>
- **CASSANDRA-18397: Unified Compaction Strategy** — Apache JIRA · *Advanced* · The scaling-parameter model, sharding, and how UCS subsumes tiered and levelled behaviour. <https://issues.apache.org/jira/browse/CASSANDRA-18397>
- **Apache Cassandra — Virtual Tables** — Apache Software Foundation · *Beginner* · The full catalogue of `system_views` tables and what each column means. <https://cassandra.apache.org/doc/latest/cassandra/managing/operating/virtualtables.html>
- **CEP-15: General Purpose Transactions (Accord)** — Apache Cassandra Confluence · *Advanced* · The design for multi-partition ACID transactions; essential context for where the project is heading. <https://cwiki.apache.org/confluence/display/CASSANDRA/CEP-15%3A+General+Purpose+Transactions>
- **JVector** — DataStax (open source) · *Advanced* · The vector index library behind Cassandra 5.0's ANN search; the README explains the recall/latency trade-offs you will tune. <https://github.com/jbellis/jvector>

---

*Apache Cassandra Handbook — chapter 42.*
