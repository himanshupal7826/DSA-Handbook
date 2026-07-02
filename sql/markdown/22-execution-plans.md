# 22 · Execution: Nested Loop, Hash & Merge Joins

> **In one line:** A `JOIN` in SQL is logical; the planner physically executes it as a nested loop, a hash join, or a merge join — and choosing the wrong one (usually from a bad row estimate) is the difference between milliseconds and minutes.

---

## 1. Overview

`a JOIN b ON …` says nothing about *how* rows get matched. The optimizer implements every join with one of exactly three **physical join algorithms**: **Nested Loop**, **Hash Join**, or **Merge Join**. Each has a distinct cost model, and the planner picks the cheapest one based on input sizes, available indexes, and whether inputs are already sorted.

Understanding these three is the core of reading execution plans. A **Nested Loop** is a pair of `for` loops — great when one side is tiny and the other is indexed. A **Hash Join** builds an in-memory hash table from the smaller input and probes it — the workhorse for two large, unsorted tables joined on equality. A **Merge Join** walks two **sorted** inputs in lockstep like a zipper — ideal when both sides are already ordered (e.g. by index).

The dangerous part: the planner's choice hinges on its **row estimate**. If it thinks the outer input has 3 rows but it actually has 3 million, it will happily pick a nested loop that runs the inner side 3 million times. Recognizing that "the plan is right for the estimate, but the estimate is wrong" is the senior skill this page builds.

## 2. Core Concepts

- **Physical join algorithm** — the runtime strategy (nested loop / hash / merge) implementing a logical join.
- **Driving (outer) table** — the input iterated in the outer position; the other is the **inner** (probed) input.
- **Nested Loop Join** — for each outer row, scan the inner for matches; O(outer × inner) unless the inner is indexed, then ~O(outer × log inner).
- **Hash Join** — **build** phase hashes the smaller input into memory, **probe** phase streams the larger input against it; equality joins only.
- **Merge Join** — both inputs sorted on the join key, then merged in one linear pass; needs sorted input (index or explicit sort).
- **Build vs probe side** — hash join keeps the *smaller* estimated input as the build side to minimize memory.
- **Work_mem / hash spill** — if the build side exceeds working memory, the hash spills to disk in **batches**, slowing the join.
- **Join selectivity & order** — the planner also decides *which* table drives and the order multiple joins execute; both flow from row estimates.
- **Equality vs inequality** — hash and merge (equijoin) need `=`; range/inequality joins fall back to nested loop.
- **Row-estimate sensitivity** — a wrong cardinality flips the chosen algorithm, the flip being the usual cause of sudden slowdowns.

## 3. Syntax & Examples

The join *syntax* is identical; only the plan differs. Inspect it with `EXPLAIN`:

```sql
EXPLAIN ANALYZE
SELECT c.name, o.total
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE c.country = 'IN';
```

You can *force* an algorithm to compare costs (PostgreSQL session flags — for experimentation only, never in production):

```sql
SET enable_hashjoin  = off;   -- see what the planner does without hash
SET enable_mergejoin = off;
SET enable_nestloop  = off;
EXPLAIN ANALYZE SELECT ...;   -- observe the fallback plan + cost
RESET ALL;
```

Give the planner what each algorithm wants:

```sql
-- Enables index nested loop (indexed inner) AND merge join (sorted input):
CREATE INDEX idx_orders_customer ON orders(customer_id);
```

## 4. Sample Data & Results

`customers` (small, filtered to India) joined to `orders` (large).

**customers**

| id | name | country |
|----|------|---------|
| 7 | Asha | IN |
| 42 | Ravi | IN |
| 91 | Meera | US |

**orders**

| id | customer_id | total |
|----|-------------|-------|
| 1 | 42 | 88.00 |
| 2 | 42 | 12.50 |
| 3 | 7 | 40.00 |
| 5 | 7 | 63.20 |

**Result** of the join filtered to `country = 'IN'`:

| name | total |
|------|-------|
| Ravi | 88.00 |
| Ravi | 12.50 |
| Asha | 40.00 |
| Asha | 63.20 |

Two plausible plans and their `EXPLAIN ANALYZE` signatures:

```text
-- FEW India customers, orders.customer_id indexed → Nested Loop
Nested Loop  (cost=0.43..91.20 rows=8 width=20) (actual rows=4 loops=1)
  ->  Seq Scan on customers c  (rows=2)  Filter: (country = 'IN')
  ->  Index Scan using idx_orders_customer on orders o
        (actual rows=2 loops=2)          -- inner runs once per outer row
        Index Cond: (customer_id = c.id)

-- MANY customers match, no useful index → Hash Join
Hash Join  (cost=210.0..4300.0 rows=90000 width=20) (actual rows=88712 loops=1)
  Hash Cond: (o.customer_id = c.id)
  ->  Seq Scan on orders o     (actual rows=5000000)
  ->  Hash  (actual rows=45000)          -- build side = smaller customers set
        ->  Seq Scan on customers c  Filter: (country = 'IN')
```

## 5. Under the Hood

Read a join plan as a **tree**: the join node has two children, the **outer** (top/left) and **inner** (bottom/right). The algorithm name on the join node tells you how those two streams are combined, and `loops` on the inner node reveals how many times it re-ran.

```svg
<svg viewBox="0 0 740 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="370" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="600">Execution plan tree — a Hash Join node with two child inputs</text>

  <!-- root join node -->
  <rect x="260" y="50" width="220" height="66" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="370" y="76" text-anchor="middle" fill="#1e293b" font-weight="600">Hash Join</text>
  <text x="370" y="96" text-anchor="middle" fill="#64748b">Hash Cond: o.customer_id = c.id</text>
  <text x="370" y="110" text-anchor="middle" fill="#64748b">rows=88712 (est 90000)</text>

  <!-- probe side (outer/left) -->
  <rect x="70" y="180" width="220" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="205" text-anchor="middle" fill="#1e293b" font-weight="600">Seq Scan on orders  (probe)</text>
  <text x="180" y="225" text-anchor="middle" fill="#64748b">large input, 5,000,000 rows</text>

  <!-- build side (inner/right) -->
  <rect x="450" y="180" width="220" height="60" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="560" y="205" text-anchor="middle" fill="#1e293b" font-weight="600">Hash  (build side)</text>
  <text x="560" y="225" text-anchor="middle" fill="#64748b">smaller input → hash table</text>

  <!-- build leaf -->
  <rect x="450" y="290" width="220" height="56" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="560" y="313" text-anchor="middle" fill="#1e293b" font-weight="600">Seq Scan on customers</text>
  <text x="560" y="331" text-anchor="middle" fill="#64748b">Filter: country = 'IN' → 45,000</text>

  <!-- edges (child feeds parent) -->
  <line x1="180" y1="180" x2="300" y2="116" stroke="#475569" stroke-width="1.6" marker-end="url(#arr)"/>
  <line x1="560" y1="180" x2="440" y2="116" stroke="#475569" stroke-width="1.6" marker-end="url(#arr)"/>
  <line x1="560" y1="290" x2="560" y2="242" stroke="#475569" stroke-width="1.6" marker-end="url(#arr)"/>

  <text x="240" y="160" text-anchor="middle" fill="#64748b">stream rows up</text>
  <text x="500" y="160" text-anchor="middle" fill="#64748b">probe hash table</text>
</svg>
```

**Nested Loop**: `for each outer row: probe inner`. Cheap to start (no build), but total cost scales with `outer_rows × inner_cost`. With an index on the inner join column it becomes an *index nested loop* — the inner "scan" is a cheap B-tree lookup, making it unbeatable when the outer side is tiny.

**Hash Join**: reads the smaller input fully and hashes it (the **build**), then streams the larger input and probes each row (the **probe**). Linear in both inputs, but pays memory for the hash table; if it exceeds `work_mem` it spills to disk batches. Equality only.

**Merge Join**: requires both inputs **sorted** on the join key. It advances two cursors in a single linear pass. If an index already provides the order, it is very cheap; if the planner must add explicit `Sort` nodes, that sort cost is what it weighs against building a hash table.

## 6. Variations & Trade-offs

| Algorithm | Needs | Cost model | Wins when | Loses when |
|-----------|-------|------------|-----------|------------|
| **Nested Loop** | nothing (indexed inner ideal) | outer × inner (or × log inner) | outer input tiny, inner indexed | both inputs large / inner not indexed |
| **Hash Join** | equality join, memory | build(small) + probe(large), linear | two large unsorted inputs on `=` | tiny inputs (build overhead), inequality join, hash spills to disk |
| **Merge Join** | both inputs sorted on key | sort(if needed) + linear merge | inputs already sorted by index | inputs need expensive explicit sorts |

- **Small × large, inner indexed → Nested Loop.** A 5-row driving table hitting an indexed 5M-row table beats hashing 5M rows.
- **Large × large, unsorted, equijoin → Hash Join.** The default heavy-lifter for analytics.
- **Both sorted (or sorted output needed) → Merge Join.** Common when an index or an upstream `ORDER BY`/merge already yields order, or for `FULL OUTER JOIN`.
- **Inequality / range join (`a.x BETWEEN b.lo AND b.hi`)** — hash and merge can't equijoin it, so the planner falls back to a **Nested Loop**.

PostgreSQL implements all three. MySQL/InnoDB historically used only the (Block) Nested Loop Join; **Hash Join** arrived in MySQL 8.0.18 for equijoins without usable indexes, and it has no merge join. Oracle and SQL Server support all three like PostgreSQL.

## 7. Performance Notes

- **The driving table matters most.** The planner wants the *smaller* filtered input driving a nested loop; a bad estimate here picks the wrong driver and the loop count explodes.
- **`loops` is the tell.** `Index Scan ... (actual rows=2 loops=3000000)` means 6M inner executions — a nested loop that should have been a hash join.
- **Hash spills hurt.** In `EXPLAIN ANALYZE`, `Batches: 8  Memory Usage: …` above 1 batch means the hash didn't fit `work_mem` and spilled; raise `work_mem` for that query or reduce the build side.
- **Feed merge joins pre-sorted data.** A merge join preceded by two big `Sort` nodes is often losing to a hash join — check whether an index can supply the order for free.
- **Index the inner join key** to unlock index nested loops for selective queries; without it the planner is pushed toward hashing everything.
- **Multi-way joins = join order search.** The planner reorders joins to keep intermediate results small; `join_collapse_limit` caps how far it searches. Wrong estimates early produce huge intermediates.

## 8. Common Mistakes

1. ⚠️ **Assuming SQL join order = execution order.** The planner reorders freely; the written order is irrelevant to the physical plan. *Fix: read the plan tree, not the query text.*
2. ⚠️ **A nested loop with a huge `loops` count.** Almost always an underestimated outer input. *Fix: `ANALYZE`; add extended statistics; the plan should flip to hash.*
3. ⚠️ **Blaming the algorithm instead of the estimate.** The join type is a symptom; the cardinality error is the disease. *Fix: compare estimated vs actual rows on each node first.*
4. ⚠️ **Expecting a merge/hash join for an inequality.** `ON a.ts BETWEEN b.s AND b.e` can only nested-loop. *Fix: add a range-friendly index, or restructure to an equijoin.*
5. ⚠️ **Ignoring hash spill to disk.** Multiple batches silently slow a hash join. *Fix: increase `work_mem`, shrink/filter the build side, or select fewer columns.*
6. ⚠️ **Over-large driving table.** Not filtering the outer side before the join forces a big loop or big hash. *Fix: push selective predicates down so the driver is small.*
7. ⚠️ **Missing index on the FK / join column.** Forces seq scans and blocks index nested loops. *Fix: index the join key on the inner side.*

## 9. Interview Questions

**Q: What are the three physical join algorithms and the one-line intuition for each?**
A: Nested Loop (for each outer row, look up matches in the inner — best when outer is tiny and inner indexed), Hash Join (build a hash table from the smaller input, probe with the larger — best for two big unsorted equijoined inputs), and Merge Join (walk two sorted inputs in lockstep — best when both are already ordered on the key).

**Q: What is the cost model of a nested loop, and how does an index change it?**
A: Naively it is outer_rows × inner_scan_cost, i.e. O(N×M). If the inner join column is indexed, each inner "scan" becomes a B-tree lookup (~log M), giving roughly outer_rows × log(inner) — very cheap when the outer side is small.

**Q: In a hash join, which input becomes the build side and why?**
A: The smaller estimated input, because it is loaded fully into an in-memory hash table; keeping it small minimizes memory and the chance of spilling to disk. The larger input then streams through as the probe side.

**Q: Why can't a hash join or merge join handle a `BETWEEN`/inequality join condition?**
A: Both are equijoin strategies — a hash matches on exact key equality and a merge relies on ordered equality comparison. Range/inequality predicates have no single matching key, so the planner falls back to a nested loop.

**Q: What does a merge join require that the others don't, and what's the trade-off?**
A: Both inputs must be sorted on the join key. If an index provides that order it is nearly free and linear; if the planner must insert explicit `Sort` nodes, that sort cost is weighed against a hash join, which needs no ordering.

**Q: You see `Index Scan ... (actual rows=1 loops=2000000)` inside a Nested Loop. What happened and how do you fix it?**
A: The planner underestimated the outer input, so the inner index scan ran 2,000,000 times. The real fix is correcting the estimate — run `ANALYZE`, add extended/expression statistics — so the planner switches to a single-pass hash join instead of millions of loops.

**Q: What is the "driving table" and why does the planner's choice of it matter?**
A: The driving (outer) table is the one iterated in the outer loop / used to drive the join. Choosing the smaller, more-filtered input as the driver keeps loop counts and intermediate result sizes small; picking the wrong driver multiplies work across the join.

**Q: How does a bad row estimate flip a plan from hash to nested loop, causing a sudden slowdown?**
A: If stats say an input has ~3 rows, a nested loop looks cheapest (3 inner lookups). If it truly has 3 million, the same plan does 3 million inner scans. The plan was "optimal" for the wrong number; refreshing stats corrects the estimate and the planner reverts to a hash join.

**Q: What are hash "batches" in EXPLAIN ANALYZE and what do they indicate?**
A: When the build side exceeds `work_mem`, PostgreSQL partitions the hash into multiple batches spilled to disk (`Batches: N > 1`). It signals memory pressure — the join is doing extra IO, so raise `work_mem` or shrink the build input.

**Q: For a small dimension table joined to a large fact table with an indexed foreign key, which join wins and why?**
A: An index nested loop with the small dimension table driving. Each of its few rows does one cheap indexed lookup into the fact table, avoiding the cost of hashing or sorting millions of fact rows.

**Q: How does the planner handle a query with five joined tables?**
A: It searches join orders (bounded by `join_collapse_limit`/`from_collapse_limit`) to keep intermediate results small, choosing a physical algorithm per join step by estimated cost. Early cardinality errors are costly because they inflate every subsequent intermediate result.

**Q: How can you experimentally confirm the planner chose the best join, and what's the caveat?**
A: Toggle `enable_hashjoin`/`enable_mergejoin`/`enable_nestloop` off in a session and compare `EXPLAIN ANALYZE` costs and timings of the forced alternatives. The caveat: these are diagnostic switches only — never disable them in production, since the right choice is data-dependent.

## 10. Practice

- [ ] Join a 5-row filtered table to a large indexed table; confirm the plan is an index Nested Loop with `loops` = the small row count.
- [ ] Join two large unsorted tables on equality and identify the Hash Join, its build side, and whether it spills (`Batches > 1`).
- [ ] Add a `BETWEEN` range join condition and observe the forced Nested Loop.
- [ ] Build indexes that provide sorted order on both sides and coax a Merge Join; compare its cost to the hash version.
- [ ] Deliberately stale the statistics, watch a nested loop with a huge `loops` count, then fix it with `ANALYZE` and see it flip to a hash join.

## 11. Cheat Sheet

> [!TIP]
> **Three physical joins, one decision.** **Nested Loop** = for-each-outer probe inner; cost = outer × inner (× log if inner indexed); wins when outer is tiny / inner indexed / inequality joins. **Hash Join** = build hash from the smaller input, probe with the larger; linear, equality-only, may spill to disk (`Batches > 1` = raise `work_mem`); wins for two big unsorted equijoins. **Merge Join** = zip two **sorted** inputs; wins when order is free from an index. Read the plan as a tree: join node + outer(top) + inner(bottom); watch **`loops`** on the inner — a huge value means an underestimated outer driving a nested loop that should be a hash. The chosen algorithm follows the **row estimate**, so a bad estimate flips the plan — fix it with `ANALYZE`, not by blaming the join.

**References:** PostgreSQL docs — "Planner/Optimizer" & "Using EXPLAIN"; Use The Index, Luke! — "The Join Operation"; "SQL Performance Explained" (Markus Winand); MySQL 8.0 Reference Manual — "Hash Join Optimization" & "Nested-Loop Join Algorithms"

---
*SQL Handbook — topic 22.*
