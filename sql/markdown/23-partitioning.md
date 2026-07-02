# 23 · Partitioning & Sharding

> **In one line:** Split one giant table into many smaller physical pieces — by key range on a single server (partitioning) or across many servers (sharding) — so scans, indexes, and retention stay cheap.

---

## 1. Overview

A table with 2 billion rows is slow not because SQL is slow but because its **B-tree indexes are tall**, its scans are wide, and deleting old data means row-by-row churn. **Partitioning** breaks that one logical table into many physical **partitions** by a partition key, while the table still looks like a single table to queries. The engine routes each row to the right partition on write and, on read, skips partitions that cannot match — **partition pruning**.

Partitioning is a *single-server* technique: all partitions live in one database instance sharing one buffer pool and one transaction log. You reach for it when a table is too big for comfortable index maintenance, when you need time-based **retention** (drop last month instantly), or when a natural boundary (tenant, region, month) makes most queries hit one slice.

**Sharding** is the horizontal cousin: the same idea, but partitions (**shards**) live on *different servers*, giving you more CPU, RAM, disk, and write throughput than one box can offer. Sharding buys scale-out but costs you cross-shard joins, distributed transactions, and a routing layer. Rule of thumb: partition first (it is free and transparent); shard only when a single node genuinely can't hold the working set or serve the write rate.

## 2. Core Concepts

- **Partition key** — the column(s) that decide which partition a row lands in (e.g. `created_at`, `tenant_id`). Choosing it well is the whole game.
- **Declarative partitioning** — you declare the scheme (`PARTITION BY RANGE/LIST/HASH`) and the engine routes rows automatically; no triggers needed (PostgreSQL 10+, MySQL native partitioning).
- **RANGE** — contiguous key ranges (months, id ranges). Ideal for time-series and retention.
- **LIST** — explicit value sets per partition (region = 'EU' vs 'US'). Good for low-cardinality categories.
- **HASH** — `hash(key) % N` spreads rows evenly across N partitions. Good for load balancing when no natural range exists.
- **Partition pruning** — the planner reads the WHERE clause and touches only partitions that can contain matching rows; the rest are never opened.
- **Local index** — a separate index per partition (PostgreSQL only supports local). Cheap to build/drop with the partition; a query without the partition key must probe every local index.
- **Global index** — one index spanning all partitions (Oracle). Enables efficient non-key lookups but must be maintained/rebuilt when a partition is dropped.
- **Partition-wise operations** — DROP/attach a whole partition as a metadata-only DDL, and run scans/joins/aggregates on partitions in **parallel**.
- **Sharding** — partitioning across independent servers; adds a routing/coordinator layer and turns cross-shard work into distributed queries.

## 3. Syntax & Examples

```sql
-- PostgreSQL: RANGE partition an events table by month
CREATE TABLE events (
    id          bigint       GENERATED ALWAYS AS IDENTITY,
    tenant_id   int          NOT NULL,
    created_at  timestamptz  NOT NULL,
    payload     jsonb
) PARTITION BY RANGE (created_at);

-- One partition per month
CREATE TABLE events_2026_06 PARTITION OF events
    FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE events_2026_07 PARTITION OF events
    FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');

-- A local index lives on each partition
CREATE INDEX ON events (tenant_id, created_at);
```

```sql
-- LIST partitioning by region
CREATE TABLE customers (id bigint, region text, name text)
  PARTITION BY LIST (region);
CREATE TABLE customers_eu PARTITION OF customers FOR VALUES IN ('EU','UK');
CREATE TABLE customers_us PARTITION OF customers FOR VALUES IN ('US','CA');

-- HASH partitioning to spread load across 4 buckets
CREATE TABLE sessions (id bigint, user_id bigint) PARTITION BY HASH (user_id);
CREATE TABLE sessions_p0 PARTITION OF sessions FOR VALUES WITH (MODULUS 4, REMAINDER 0);
CREATE TABLE sessions_p1 PARTITION OF sessions FOR VALUES WITH (MODULUS 4, REMAINDER 1);
CREATE TABLE sessions_p2 PARTITION OF sessions FOR VALUES WITH (MODULUS 4, REMAINDER 2);
CREATE TABLE sessions_p3 PARTITION OF sessions FOR VALUES WITH (MODULUS 4, REMAINDER 3);
```

```sql
-- Instant retention: drop a whole month in O(1) metadata time
DROP TABLE events_2026_06;              -- vs. DELETE ... WHERE created_at < ...

-- Detach without deleting (archive it)
ALTER TABLE events DETACH PARTITION events_2026_06;
```

> [!NOTE]
> MySQL uses `PARTITION BY RANGE (TO_DAYS(created_at)) (PARTITION p202606 VALUES LESS THAN (...))` and has no `DETACH`; use `ALTER TABLE ... DROP PARTITION`. In MySQL the partitioning column must be part of every unique/primary key.

## 4. Sample Data & Results

Input — logical `events` table (rows physically split by month):

| id | tenant_id | created_at          | partition        |
|----|-----------|---------------------|------------------|
| 1  | 42        | 2026-06-15 09:00    | events_2026_06   |
| 2  | 42        | 2026-06-28 12:30    | events_2026_06   |
| 3  | 7         | 2026-07-01 08:10    | events_2026_07   |
| 4  | 42        | 2026-07-03 14:45    | events_2026_07   |

Query — the WHERE clause hits only July:

```sql
SELECT count(*) FROM events
WHERE created_at >= '2026-07-01' AND created_at < '2026-08-01'
  AND tenant_id = 42;
```

Result:

| count |
|-------|
| 1     |

The planner **prunes `events_2026_06` entirely** — it never opens that partition's heap or index. Only `events_2026_07` is scanned, using its local `(tenant_id, created_at)` index.

## 5. Under the Hood

On INSERT, the engine evaluates the partition key and routes the row to the matching partition's heap. On SELECT, the planner compares the WHERE predicate against each partition's boundary metadata and drops non-matching partitions *before* execution (or, for parameterized/runtime values, during execution — "runtime pruning"). Each surviving partition is a normal table with its own smaller, shorter B-tree.

```svg
<svg viewBox="0 0 720 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- incoming query -->
  <rect x="20" y="150" width="190" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="115" y="175" text-anchor="middle" fill="#1e293b">WHERE created_at</text>
  <text x="115" y="193" text-anchor="middle" fill="#1e293b">&#8712; July 2026</text>

  <!-- router -->
  <rect x="270" y="150" width="150" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="345" y="175" text-anchor="middle" fill="#1e293b">Planner</text>
  <text x="345" y="193" text-anchor="middle" fill="#64748b">partition pruning</text>

  <line x1="210" y1="180" x2="264" y2="180" stroke="#475569" stroke-width="1.5" marker-end="url(#arr)"/>

  <!-- three partitions -->
  <rect x="500" y="30"  width="200" height="70" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="5 4"/>
  <text x="600" y="58"  text-anchor="middle" fill="#64748b">events_2026_05</text>
  <text x="600" y="78"  text-anchor="middle" fill="#b91c1c">PRUNED — skipped</text>

  <rect x="500" y="120" width="200" height="70" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="5 4"/>
  <text x="600" y="148" text-anchor="middle" fill="#64748b">events_2026_06</text>
  <text x="600" y="168" text-anchor="middle" fill="#b91c1c">PRUNED — skipped</text>

  <rect x="500" y="210" width="200" height="70" rx="8" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="600" y="238" text-anchor="middle" fill="#1e293b">events_2026_07</text>
  <text x="600" y="258" text-anchor="middle" fill="#059669">SCANNED (local index)</text>

  <line x1="420" y1="170" x2="494" y2="70"  stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4 4"/>
  <line x1="420" y1="180" x2="494" y2="155" stroke="#94a3b8" stroke-width="1.2" stroke-dasharray="4 4"/>
  <line x1="420" y1="190" x2="494" y2="245" stroke="#2563eb" stroke-width="2" marker-end="url(#arr)"/>

  <text x="360" y="330" text-anchor="middle" fill="#64748b">Only the matching partition's smaller B-tree is opened — the rest are never touched.</text>
</svg>
```

Because each partition's index is shorter, a lookup within it traverses fewer B-tree levels, and a `DROP TABLE partition` is a catalog edit rather than billions of row deletions and index updates. With `enable_partitionwise_join`/`aggregate` on, the engine can also process partitions concurrently.

## 6. Variations & Trade-offs

| Dimension            | Partitioning (1 server)                    | Sharding (N servers)                          |
|----------------------|--------------------------------------------|-----------------------------------------------|
| Goal                 | Smaller indexes, fast retention, pruning   | Scale-out CPU/RAM/disk/write throughput       |
| Transparency         | Fully transparent — looks like one table   | App/proxy must route; distributed txns hard   |
| Cross-slice query    | One planner, parallel, cheap               | Scatter-gather across nodes, network cost      |
| Failure domain       | Whole DB fails together                    | One shard down ≠ whole system down            |
| Ops complexity       | Low (DDL only)                             | High (rebalancing, resharding, coordinator)   |
| Joins across slices  | Native SQL join                            | Often disallowed or app-side                   |

| Partition strategy | Best for                        | Watch out for                         |
|--------------------|---------------------------------|---------------------------------------|
| RANGE              | Time-series, retention windows  | Hot latest partition; empty tail gaps |
| LIST               | Region/tenant categories        | New value with no partition → error   |
| HASH               | Even load, no natural range     | No pruning on range predicates        |

Index choice: **local indexes** (PostgreSQL default) are cheap to build/drop per partition but a non-key lookup probes every partition. **Global indexes** (Oracle) serve non-key lookups in one probe but must be maintained when partitions are dropped — the opposite trade-off.

## 7. Performance Notes

- **Pruning needs the key in the predicate.** `WHERE created_at >= '2026-07-01'` prunes; `WHERE date_trunc('day', created_at) = ...` may not — keep the raw partition column sargable.
- **Check the plan.** In PostgreSQL, `EXPLAIN` shows only the surviving partitions as child scans; if you see all of them, pruning failed. `EXPLAIN (ANALYZE)` reveals runtime pruning (`Subplans Removed: N`).
- **Too many partitions hurt planning.** Thousands of partitions bloat planning time and catalog; keep counts to hundreds. Use sub-partitioning sparingly.
- **Partition pruning + local index** is the fast path: prune to one partition, then index-scan its short tree.
- **Cross-partition ORDER BY / LIMIT** must merge results from every partition — a natural `MergeAppend`; still touches all if the key isn't the sort key.
- **Global/cross-shard aggregates** in sharding require scatter-gather + a coordinator merge; latency is bounded by the slowest shard.

## 8. Common Mistakes

1. ⚠️ **Picking a partition key most queries don't filter on.** Then every query scans every partition. Fix: partition by the column that appears in the hot WHERE clause.
2. ⚠️ **Applying a function to the partition key in WHERE**, defeating pruning. Fix: compare the raw column to constants/ranges.
3. ⚠️ **No default/future partition**, so an insert for a new month or new LIST value errors out. Fix: add a `DEFAULT` partition or automate monthly partition creation (pg_partman / cron).
4. ⚠️ **Expecting a unique constraint across partitions for free.** In PostgreSQL a unique index must include the partition key; MySQL requires the partition column in every unique key. Fix: include the key, or enforce uniqueness at the app/global level.
5. ⚠️ **Over-partitioning** (one partition per day for 10 years) → thousands of tables, slow planning, catalog bloat. Fix: coarser ranges; archive old partitions.
6. ⚠️ **Reaching for sharding too early.** Distributed joins and 2PC are a big tax. Fix: exhaust partitioning + read replicas + bigger hardware first.
7. ⚠️ **Choosing a shard key that co-locates poorly**, so common queries fan out to all shards. Fix: shard by the entity most queries filter and join on (e.g. `tenant_id`).

## 9. Interview Questions

**Q: What is the difference between partitioning and sharding?**
A: Partitioning splits one table into physical pieces within a single database server (shared buffer pool, one transaction log, transparent to queries). Sharding spreads those pieces across independent servers to scale out CPU/RAM/disk/write throughput, at the cost of cross-shard joins, distributed transactions, and a routing layer.

**Q: What is partition pruning and what enables it?**
A: Pruning is the planner (or executor) skipping partitions that cannot contain matching rows, based on the WHERE predicate compared to each partition's boundaries. It requires the partition key to appear in the predicate in a sargable form; a function wrapped around the key or a missing key predicate forces scanning all partitions.

**Q: When would you choose RANGE vs LIST vs HASH partitioning?**
A: RANGE for ordered/continuous keys like time (enables retention and range pruning); LIST for discrete categories like region or tenant tier; HASH to spread rows evenly for load balancing when there's no natural range — but HASH gives no pruning on range predicates.

**Q: Why is partitioning great for data retention?**
A: Dropping old data becomes `DROP TABLE partition` or `DROP PARTITION` — an O(1) metadata operation that instantly reclaims space, versus a `DELETE ... WHERE created_at < x` that scans, locks, writes WAL/undo for every row, and leaves bloat needing VACUUM.

**Q: Explain local vs global indexes.**
A: A local index is one index per partition, aligned with it — cheap to create/drop alongside the partition, but a lookup that lacks the partition key must probe every partition's index. A global index spans all partitions, so non-key lookups take one probe, but it must be maintained/rebuilt when any partition is dropped or attached.

**Q: How does partitioning make individual index lookups faster?**
A: Each partition has its own smaller B-tree with fewer levels, so a lookup traverses fewer pages; combined with pruning, the engine first eliminates irrelevant partitions and then index-scans only the short tree of the surviving one.

**Q: What are the main pitfalls of a poorly chosen partition key?**
A: If queries rarely filter on the key, pruning never happens and every query scans all partitions (worse than an unpartitioned table due to overhead). A skewed key creates a hot partition that concentrates load. And in sharding, a bad key fans every query out to all shards, eliminating the scale-out benefit.

**Q: (Senior) How do you read an EXPLAIN plan to confirm pruning worked?**
A: In PostgreSQL the plan lists only surviving partitions as child Append/MergeAppend scans; if all partitions appear, pruning failed. With `EXPLAIN (ANALYZE)`, runtime pruning shows `Subplans Removed: N` where N partitions were eliminated at execution time (common with parameterized queries).

**Q: (Senior) Why can't you always enforce global uniqueness cheaply in a partitioned/sharded table?**
A: A B-tree unique index is per-partition (local), so it can only guarantee uniqueness within a partition unless the partition key is part of the unique key (letting the engine know duplicates can't cross partitions). Across shards there's no single index at all, so global uniqueness needs the shard key in the constraint, a global sequence/UUID, or an external coordination service.

**Q: (Senior) A dashboard query does ORDER BY created_at LIMIT 20 across a range-partitioned table — what does the plan look like and where's the cost?**
A: The planner uses a MergeAppend that pulls the top rows from each non-pruned partition's ordered index and merges them; cost scales with the number of partitions touched. If the ORDER BY column is the partition key you can often prune to the newest partitions; otherwise all surviving partitions must contribute their leading rows before the merge yields 20.

**Q: (Senior) When is it finally time to shard, and how do you pick the shard key?**
A: Shard when a single node can't hold the working set in RAM or sustain the write/WAL rate even after partitioning, replicas, and vertical scaling. Pick a high-cardinality key that co-locates the rows most queries filter and join on (often `tenant_id` or `user_id`) so the majority of queries hit one shard and cross-shard scatter-gather stays the exception.

**Q: (Senior) How does hash sharding complicate resharding compared to range sharding?**
A: With `hash % N`, changing N remaps almost every key, forcing a massive data movement; consistent hashing or a fixed large bucket count mapped to nodes mitigates this. Range sharding reshards by splitting a hot range into two, moving only that slice — easier to rebalance incrementally but prone to hotspots on the newest range.

## 10. Practice

- [ ] Create a RANGE-partitioned `orders` table by month, insert rows spanning three months, and run `EXPLAIN` to confirm a single-month query prunes to one partition.
- [ ] Add a `DEFAULT` partition and demonstrate an insert that would otherwise fail when no matching range exists.
- [ ] Measure the wall-clock difference between `DROP TABLE orders_2026_01` and `DELETE FROM orders WHERE created_at < '2026-02-01'` on a large table.
- [ ] Convert a query with `WHERE date(created_at) = '2026-07-01'` into a sargable range predicate and show pruning now kicks in.
- [ ] Design a shard key for a multi-tenant SaaS and list which three common queries stay single-shard vs fan out.

## 11. Cheat Sheet

> [!TIP]
> **Partitioning** = one table split physically on one server; **sharding** = split across servers. Declare `PARTITION BY RANGE/LIST/HASH (key)`. RANGE→time/retention, LIST→categories, HASH→even load. **Pruning** skips partitions when the key is in the WHERE (keep it sargable — no functions). Wins: shorter per-partition B-trees, instant `DROP PARTITION` retention, partition-wise parallelism. PostgreSQL indexes are **local** (cheap per-partition; probe-all without key); Oracle **global** (one probe; costly to maintain). Pitfalls: wrong key = scan everything, over-partitioning bloats planning, uniqueness needs the key in the constraint. Shard only after partitioning + replicas + bigger hardware are exhausted; pick a shard key that co-locates hot queries.

**References:** PostgreSQL docs "Table Partitioning", MySQL Reference Manual "Partitioning", Use The Index Luke (partitioning chapter), Citus Data sharding docs, pg_partman README

---
*SQL Handbook — topic 23.*
