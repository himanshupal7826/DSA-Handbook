# 21 · Query Optimization & EXPLAIN

> **In one line:** Read the planner's execution plan, spot where estimates or access paths go wrong, and fix it with the right index, a sargable rewrite, or fresher statistics.

---

## 1. Overview

Every SQL statement is *declarative* — you say **what** you want, not **how** to get it. The **query optimizer** (a cost-based planner) turns that into an **execution plan**: a tree of physical operators (scans, joins, sorts, aggregates) chosen to minimize an estimated **cost**. It picks between plans using **table statistics** — row counts, column histograms, distinct-value estimates — gathered by `ANALYZE`.

Optimization is rarely about clever SQL tricks. It is a loop: **measure** the plan with `EXPLAIN ANALYZE`, **find** the operator burning the time or misestimating rows, and **remove the cause** — add a selective index, make a predicate sargable, refresh stale stats, or rewrite a subquery. You reach for this whenever a query is slow, CPU/IO spikes under load, or a plan flips unexpectedly after data growth.

The single most important skill is reading a plan and comparing the planner's **estimated** rows against the **actual** rows. When those diverge by orders of magnitude, the planner made a good decision on bad information — and almost every "mysteriously slow" query traces back to that gap.

## 2. Core Concepts

- **Optimizer / planner** — cost-based component that enumerates candidate plans and keeps the cheapest by estimated cost.
- **Cost** — an abstract unit (not milliseconds) tuned via `seq_page_cost`, `random_page_cost`, `cpu_tuple_cost`. Shown as `cost=startup..total`.
- **Estimated rows (`rows`)** — planner's guess of rows a node emits, derived from statistics; drives every downstream choice.
- **Actual rows** — real rows seen at runtime (only in `EXPLAIN ANALYZE`). Estimated-vs-actual mismatch is the #1 diagnostic.
- **Width** — average bytes per output row; affects memory, sorts, and hash sizing.
- **Statistics** — per-column histograms, `n_distinct`, most-common-values; refreshed by `ANALYZE`/autovacuum.
- **Seq Scan** — read every heap page; best when most rows qualify.
- **Index Scan** — walk a B-tree then fetch heap rows; best for high selectivity.
- **Bitmap Heap Scan** — build a bitmap of matching pages from an index, then read the heap in physical order; the middle ground for medium selectivity or `OR`/multi-index.
- **Sargable predicate** — one where the indexed column appears bare so the index can be used (`col = x`, `col > x`), versus `func(col) = x` which cannot.
- **VACUUM** — reclaims dead tuples from MVCC updates/deletes and updates the visibility map (enabling index-only scans).

## 3. Syntax & Examples

Plain `EXPLAIN` shows the *plan and estimates only* — it does not run the query:

```sql
EXPLAIN
SELECT * FROM orders WHERE customer_id = 42;
```

`EXPLAIN ANALYZE` actually **executes** the query and reports real timing and row counts. Add `BUFFERS` to see page hits/reads:

```sql
EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
SELECT o.id, o.total
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE c.country = 'IN'
  AND o.created_at >= date '2026-06-25';
```

Refresh statistics after a big load, and reclaim dead rows:

```sql
ANALYZE orders;              -- recompute stats only
VACUUM (ANALYZE) orders;     -- reclaim dead tuples + recompute stats
```

> [!WARN]
> `EXPLAIN ANALYZE` **runs** the statement. For an `UPDATE`/`DELETE`/`INSERT`, wrap it in a transaction and `ROLLBACK`, or you will mutate data while "just checking the plan".

## 4. Sample Data & Results

Table `orders` — 5,000,000 rows, with `CREATE INDEX idx_orders_customer ON orders(customer_id);`

| id | customer_id | status | total | created_at |
|----|-------------|--------|-------|------------|
| 1 | 42 | shipped | 88.00 | 2026-06-25 |
| 2 | 42 | paid | 12.50 | 2026-06-26 |
| 3 | 7 | paid | 40.00 | 2026-06-26 |
| 4 | 91 | cancelled | 5.00 | 2026-06-27 |
| 5 | 42 | shipped | 63.20 | 2026-06-28 |

Query and its **annotated** `EXPLAIN ANALYZE` output (the columns you must read are labelled):

```text
EXPLAIN ANALYZE
SELECT * FROM orders WHERE customer_id = 42;

Index Scan using idx_orders_customer on orders
  (cost=0.43..38.11 rows=12 width=41)
  (actual time=0.021..0.048 rows=11 loops=1)
  Index Cond: (customer_id = 42)
Planning Time: 0.093 ms
Execution Time: 0.071 ms
        │        │        │      │       │        │
   operator   startup   total  est.   actual   est. row
                cost    cost   rows   rows     width (bytes)
```

Estimated 12 vs actual 11 — statistics are healthy, so the planner correctly chose an **Index Scan** for this high-selectivity lookup. Contrast with a query matching most of the table (`WHERE total > 0`) where a **Seq Scan** with `rows=5000000` is the *correct* choice.

## 5. Under the Hood

The planner estimates the fraction of rows a predicate keeps (its **selectivity**) from column statistics, multiplies by table cardinality to get `rows`, and prices each candidate access path. For `customer_id = 42` on 5M rows with `n_distinct ≈ 400k`, it estimates ~12 rows — tiny — so a random-access **Index Scan** beats reading 5M rows sequentially. As the predicate matches more rows, index random-IO gets expensive and the crossover flips to **Bitmap Heap Scan**, then to **Seq Scan**.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="600">How the planner picks an access path by selectivity</text>

  <!-- decision boxes -->
  <rect x="40" y="70" width="180" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="130" y="98" text-anchor="middle" fill="#1e293b" font-weight="600">Index Scan</text>
  <text x="130" y="118" text-anchor="middle" fill="#64748b">few rows match</text>
  <text x="130" y="133" text-anchor="middle" fill="#64748b">(&lt; ~1% of table)</text>

  <rect x="270" y="70" width="180" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="98" text-anchor="middle" fill="#1e293b" font-weight="600">Bitmap Heap Scan</text>
  <text x="360" y="118" text-anchor="middle" fill="#64748b">medium fraction /</text>
  <text x="360" y="133" text-anchor="middle" fill="#64748b">OR, multi-index</text>

  <rect x="500" y="70" width="180" height="70" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="590" y="98" text-anchor="middle" fill="#1e293b" font-weight="600">Seq Scan</text>
  <text x="590" y="118" text-anchor="middle" fill="#64748b">most rows match</text>
  <text x="590" y="133" text-anchor="middle" fill="#64748b">(&gt; ~10–20%)</text>

  <!-- selectivity axis -->
  <line x1="40" y1="200" x2="680" y2="200" stroke="#475569" stroke-width="2" marker-end="url(#arrow)"/>
  <text x="40" y="230" text-anchor="start" fill="#64748b">high selectivity (few rows)</text>
  <text x="680" y="230" text-anchor="end" fill="#64748b">low selectivity (many rows)</text>
  <text x="360" y="255" text-anchor="middle" fill="#1e293b" font-weight="600">fraction of table matched  →</text>

  <!-- pointers -->
  <line x1="130" y1="140" x2="130" y2="196" stroke="#475569" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="360" y1="140" x2="360" y2="196" stroke="#475569" stroke-width="1.5" marker-end="url(#arrow)"/>
  <line x1="590" y1="140" x2="590" y2="196" stroke="#475569" stroke-width="1.5" marker-end="url(#arrow)"/>

  <text x="360" y="300" text-anchor="middle" fill="#b91c1c">If the row estimate is wrong, the planner lands in the wrong box → slow plan</text>
</svg>
```

Under MVCC, every `UPDATE`/`DELETE` leaves **dead tuples**. `VACUUM` reclaims them and maintains the **visibility map**; without it, indexes bloat and index-only scans degrade to heap fetches. `ANALYZE` (run standalone or by autovacuum) resamples rows to keep the histograms that feed all of the above accurate.

## 6. Variations & Trade-offs

| Access path | Reads | Best when | Cost signature |
|-------------|-------|-----------|----------------|
| **Seq Scan** | whole heap, sequential | most rows qualify, or no useful index | cheap per page, high total on big tables |
| **Index Scan** | B-tree + random heap fetch per match | very selective predicate, few rows | low startup, cost grows per matched row |
| **Index-Only Scan** | index alone (covering) | all needed columns in index + pages all-visible | cheapest; needs recent VACUUM |
| **Bitmap Heap Scan** | index → bitmap → heap in page order | medium selectivity, `OR`, combining indexes | startup to build bitmap, then sequential-ish |

| Command | Effect | When to run |
|---------|--------|-------------|
| `EXPLAIN` | plan + estimates, no execution | quick check, unsafe statements |
| `EXPLAIN ANALYZE` | plan + real rows/time | true diagnosis |
| `ANALYZE` | refresh statistics | after bulk load / big data shift |
| `VACUUM` | reclaim dead tuples | after heavy update/delete churn |

PostgreSQL exposes all four access paths and `EXPLAIN (ANALYZE, BUFFERS)`. MySQL/InnoDB uses `EXPLAIN` (and `EXPLAIN ANALYZE` since 8.0), where the analogues are "ALL" (seq scan), "ref"/"range" (index), and it lacks a distinct bitmap-heap operator but has Index Merge.

## 7. Performance Notes

- **Trust actual over estimated.** A node showing `rows=5 ... actual rows=500000` means the plan above it is built on a lie — fix the stats or the predicate, not the index.
- **Watch `loops`.** In a nested loop, per-row cost multiplies by `loops`; `rows=3 loops=200000` is 600k inner executions.
- **Make predicates sargable.** `WHERE date(created_at)=…` or `WHERE total*1.1 > 100` hides the column from the index — rewrite as a bare-column range.
- **Cover the query.** If a plan does an Index Scan then heap fetch just for one extra column, a covering index (`INCLUDE`) turns it into an index-only scan.
- **Keep stats fresh.** After a 10× load, old stats say "small table" → nested loops that were fine now scan millions. Run `ANALYZE`.
- **BUFFERS reveals IO.** High `read=` (disk) vs `hit=` (cache) explains latency that timing alone hides.
- **`random_page_cost`** defaults to 4.0 (spinning disk); on SSDs lowering it to ~1.1 makes the planner favor index scans more readily.

## 8. Common Mistakes

1. ⚠️ **Reading `cost` as milliseconds.** Cost is an abstract unit for *comparing* plans; use `EXPLAIN ANALYZE` timing for real latency. *Fix: judge speed by `actual time`/`Execution Time`.*
2. ⚠️ **Ignoring estimated-vs-actual gaps.** A 1000× mismatch guarantees a bad downstream plan. *Fix: run `ANALYZE`; add extended statistics for correlated columns.*
3. ⚠️ **Wrapping indexed columns in functions.** `WHERE lower(email)=…` kills the index. *Fix: index the expression (`CREATE INDEX ... (lower(email))`) or store normalized data.*
4. ⚠️ **Optimizing on tiny dev data.** 1,000 rows always seq-scans fast; the prod plan differs. *Fix: test on representative volumes/stats.*
5. ⚠️ **`SELECT *` blocking index-only scans.** Extra columns force heap fetches. *Fix: select only needed columns and use a covering index.*
6. ⚠️ **Never vacuuming update-heavy tables.** Dead-tuple bloat slows every scan and disables index-only scans. *Fix: ensure autovacuum keeps up; tune thresholds.*
7. ⚠️ **`OR` across columns.** Often prevents a single index. *Fix: rewrite as `UNION`, or rely on Bitmap Index Merge.*
8. ⚠️ **Adding indexes blindly.** Each index slows writes and can still be ignored if non-selective. *Fix: confirm the plan uses it before keeping it.*

## 9. Interview Questions

**Q: What is the difference between EXPLAIN and EXPLAIN ANALYZE?**
A: `EXPLAIN` shows the planned tree and cost/row estimates without running the query; `EXPLAIN ANALYZE` actually executes it and adds real timings, actual row counts, and loop counts.

**Q: In `cost=0.43..38.11 rows=12 width=41`, what does each number mean?**
A: `0.43` is the startup cost (before the first row), `38.11` the total cost to return all rows, `rows=12` the estimated output rows, and `width=41` the estimated average bytes per row.

**Q: Why do estimated and actual rows diverge, and why does it matter?**
A: Because statistics are stale, sampled imperfectly, or the predicates are correlated. It matters because the planner chooses join methods, join order, and access paths from the estimate — a wrong estimate cascades into a wrong, often catastrophic, plan.

**Q: When is a Seq Scan the correct choice over an Index Scan?**
A: When the predicate matches a large fraction of the table (roughly >10–20%). Reading pages sequentially is far cheaper per row than doing millions of random index-driven heap fetches.

**Q: What is a Bitmap Heap Scan and when does the planner use it?**
A: It uses one or more indexes to build an in-memory bitmap of matching pages, then reads the heap in physical page order. The planner picks it for medium selectivity or to combine multiple indexes / `OR` conditions, avoiding both full seq scans and scattered random IO.

**Q: What makes a predicate sargable and give a non-sargable example plus its fix?**
A: Sargable means the indexed column appears bare so a B-tree range/equality can be applied. `WHERE date(created_at) = '2026-06-25'` is non-sargable; rewrite it as `created_at >= '2026-06-25' AND created_at < '2026-06-26'`.

**Q: What do ANALYZE and VACUUM each do, and how do they relate to plans?**
A: `ANALYZE` resamples rows to refresh the statistics the planner uses for estimates. `VACUUM` reclaims dead MVCC tuples and updates the visibility map. Fresh stats give good estimates; vacuuming prevents bloat and enables index-only scans.

**Q: A nested-loop plan shows the inner node with `loops=200000`. Why is that a red flag?**
A: The inner subtree runs once per outer row, so its cost multiplies by 200,000. It usually signals the planner underestimated the outer row count; fixing the outer estimate often flips the plan to a hash join and collapses the runtime.

**Q: How would you diagnose a query that was fast for months then suddenly went slow after a data load?**
A: Compare estimated vs actual rows in `EXPLAIN ANALYZE`; a large gap after a load points to stale statistics that still describe the old small table. Run `ANALYZE`, re-check the plan, and confirm the access path flipped back to the appropriate index or hash join.

**Q: What does adding BUFFERS to EXPLAIN ANALYZE reveal that timing alone does not?**
A: It splits page access into `shared hit` (served from cache) versus `read` (fetched from disk). High reads explain latency caused by cold cache or a plan touching far more pages than necessary.

**Q: Why can `SELECT *` prevent an index-only scan, and how do you restore it?**
A: An index-only scan needs every referenced column present in the index and the pages marked all-visible. `SELECT *` references columns not in the index, forcing heap fetches. Restore it by selecting only needed columns and creating a covering index with `INCLUDE`.

**Q: Your table has a WHERE on two correlated columns (`city` and `country`) and the estimate is wildly low. What tool helps?**
A: Extended statistics (`CREATE STATISTICS ... (dependencies, ndistinct)` in PostgreSQL). Default stats assume independent columns and multiply selectivities; extended stats capture the functional dependency so the estimate stops collapsing to near-zero.

## 10. Practice

- [ ] Run `EXPLAIN ANALYZE` on a selective and a non-selective predicate on the same table; observe the Index Scan → Seq Scan flip.
- [ ] Rewrite a `date(col) = x` filter into a sargable range and confirm the plan switches to an Index Scan.
- [ ] Delete/update 30% of a table, then compare plans before and after `VACUUM ANALYZE`.
- [ ] Force stale stats (load 10× rows without `ANALYZE`) and watch a nested loop misbehave, then fix with `ANALYZE`.
- [ ] Turn an Index Scan + heap fetch into an index-only scan by adding a covering `INCLUDE` index.

## 11. Cheat Sheet

> [!TIP]
> **Query Optimization in one screen.** `EXPLAIN` = estimates only; `EXPLAIN ANALYZE` = real run + actual rows/time; add `BUFFERS` for cache vs disk. Read a node as `cost=start..total rows=est width=bytes (actual time=… rows=act loops=n)`. **Compare est vs actual** — a big gap means bad stats → run `ANALYZE`. Access paths by selectivity: few rows → **Index Scan**, medium/OR → **Bitmap Heap Scan**, most rows → **Seq Scan**; all columns in index + vacuumed → **Index-Only Scan**. Fixes: add a selective/covering index, make predicates **sargable** (no `func(col)`), rewrite `OR` as `UNION`, keep stats fresh with `ANALYZE`, reclaim bloat with `VACUUM`. Cost is abstract, not milliseconds; `loops` multiplies inner cost.

**References:** PostgreSQL docs — "Using EXPLAIN" & "Planner/Optimizer"; Use The Index, Luke!; "SQL Performance Explained" (Markus Winand); MySQL Reference Manual — "Optimizing Queries with EXPLAIN"

---
*SQL Handbook — topic 21.*
