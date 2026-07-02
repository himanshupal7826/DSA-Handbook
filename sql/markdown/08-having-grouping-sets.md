# 08 · HAVING, ROLLUP, CUBE & GROUPING SETS

> **In one line:** Filter groups after aggregation, and generate multi-level subtotals and grand totals in a single pass.

---

## 1. Overview

`GROUP BY` collapses rows into one row per group. **HAVING** is the filter that runs *after* aggregation — it is to groups what `WHERE` is to rows. Reach for it whenever your predicate references an aggregate (`SUM`, `COUNT`, `AVG`) that does not exist until grouping has happened.

The **grouping extensions** — `ROLLUP`, `CUBE`, and `GROUPING SETS` — let one query emit several levels of aggregation at once. Instead of running four queries (detail, per-region subtotal, per-category subtotal, grand total) and `UNION ALL`-ing them, you write one `GROUP BY` and the engine scans the data a single time, producing every requested level with the totals inline.

This is the backbone of reporting and OLAP-style output: a sales report where each region shows its line items, a subtotal per region, and a grand total at the bottom. The **GROUPING()** function tells you which rows are subtotals versus real data so you can label them ("All regions") instead of showing a confusing `NULL`.

You reach for these when a business wants a **cross-tab / pivot report** without a BI tool, or when an interviewer asks "how would you produce subtotals and a grand total in one query?"

## 2. Core Concepts

- **HAVING filters groups, WHERE filters rows.** `WHERE` is evaluated before `GROUP BY`; `HAVING` after. Push any non-aggregate predicate to `WHERE` — it shrinks the input before the expensive grouping.
- **HAVING may reference aggregates and grouped columns only.** `HAVING SUM(amount) > 1000` is legal; a bare non-grouped column is not.
- **ROLLUP(a, b, c)** produces a **hierarchy** of subtotals: `(a,b,c)`, `(a,b)`, `(a)`, and `()` — n+1 grouping sets. Order matters; it rolls up right-to-left.
- **CUBE(a, b)** produces **all 2ⁿ combinations**: `(a,b)`, `(a)`, `(b)`, `()`. Use it for a full cross-tab where every dimension can stand alone.
- **GROUPING SETS((a,b),(a),())** is the explicit, fully-controlled form. `ROLLUP` and `CUBE` are just shorthand that expand into grouping sets.
- **Subtotal rows carry NULL** in the columns that were "rolled up" (aggregated over).
- **GROUPING(col) returns 1** when `col` was aggregated over (a subtotal/total row) and **0** when it is a genuine grouping value — the way to distinguish a real `NULL` from a subtotal `NULL`.
- **Combine sets:** `GROUP BY a, ROLLUP(b, c)` multiplies grouping sets — `a` is always grouped, then rollup applies to `b, c`.
- **Dialect note:** PostgreSQL, SQL Server, and Oracle support all three; **MySQL** supports `WITH ROLLUP` only (no `CUBE`/`GROUPING SETS`) and uses `GROUPING()` from 8.0.

## 3. Syntax & Examples

```sql
-- HAVING: only regions whose paid revenue exceeds 10k
SELECT region, SUM(amount) AS revenue
FROM sales
WHERE status = 'paid'        -- row filter FIRST (cheap)
GROUP BY region
HAVING SUM(amount) > 10000;  -- group filter AFTER aggregation
```

```sql
-- ROLLUP: per (region, category) detail + per-region subtotal + grand total
SELECT region, category, SUM(amount) AS revenue
FROM sales
GROUP BY ROLLUP(region, category)
ORDER BY region, category;
```

```sql
-- CUBE: every combination — by region, by category, by both, and overall
SELECT region, category, SUM(amount) AS revenue
FROM sales
GROUP BY CUBE(region, category);
```

```sql
-- GROUPING SETS: pick exactly the levels you want (no per-category-only slice)
SELECT region, category, SUM(amount) AS revenue
FROM sales
GROUP BY GROUPING SETS ((region, category), (region), ());
```

```sql
-- GROUPING(): label subtotal/total rows instead of showing raw NULL
SELECT
  CASE WHEN GROUPING(region)   = 1 THEN 'All regions' ELSE region   END AS region,
  CASE WHEN GROUPING(category) = 1 THEN 'All categories' ELSE category END AS category,
  SUM(amount) AS revenue
FROM sales
GROUP BY ROLLUP(region, category)
ORDER BY GROUPING(region), region, GROUPING(category), category;
```

## 4. Sample Data & Results

Input — `sales`:

| id | region | category | amount |
|----|--------|----------|-------:|
| 1  | East   | Books    |   100  |
| 2  | East   | Toys     |   200  |
| 3  | West   | Books    |   300  |
| 4  | West   | Toys     |   400  |
| 5  | West   | Toys     |   150  |

Query — `GROUP BY ROLLUP(region, category)` with `GROUPING()` labels:

Result:

| region       | category       | revenue |
|--------------|----------------|--------:|
| East         | Books          |    100  |
| East         | Toys           |    200  |
| East         | All categories |    300  | ← region subtotal
| West         | Books          |    300  |
| West         | Toys           |    550  |
| West         | All categories |    850  | ← region subtotal
| All regions  | All categories |   1150  | ← grand total

Note the two subtotal rows (one per region) and the single grand total, all produced by a **single scan**. `CUBE(region, category)` would add extra `(All regions, Books)` and `(All regions, Toys)` rows — the per-category-only slices.

## 5. Under the Hood

The engine computes the *finest* grouping set first, then derives coarser sets by further aggregation — it does **not** re-scan the base table per level. PostgreSQL uses a **`GroupAggregate`** (sorted) or **`MixedAggregate`/`HashAggregate`** node; the planner may sort once and roll subtotals up as it advances, or build multiple hash tables in one pass. Each requested grouping set becomes an output "phase" sharing the same input scan.

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" fill="#1e293b" font-weight="bold">ROLLUP(region, category): one scan, many levels</text>

  <rect x="230" y="40" width="180" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="320" y="66" text-anchor="middle" fill="#1e293b">Seq Scan on sales (one pass)</text>

  <line x1="320" y1="82" x2="320" y2="108" stroke="#475569" marker-end="url(#arr)"/>

  <rect x="210" y="110" width="220" height="42" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="320" y="136" text-anchor="middle" fill="#1e293b">Sort / Hash by (region, category)</text>

  <line x1="320" y1="152" x2="320" y2="176" stroke="#475569" marker-end="url(#arr)"/>

  <rect x="60" y="180" width="150" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="135" y="200" text-anchor="middle" fill="#1e293b">Level: (region,cat)</text>
  <text x="135" y="216" text-anchor="middle" fill="#64748b">detail rows</text>

  <rect x="245" y="180" width="150" height="44" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="320" y="200" text-anchor="middle" fill="#1e293b">Level: (region)</text>
  <text x="320" y="216" text-anchor="middle" fill="#64748b">subtotals</text>

  <rect x="430" y="180" width="150" height="44" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="505" y="200" text-anchor="middle" fill="#1e293b">Level: ( )</text>
  <text x="505" y="216" text-anchor="middle" fill="#64748b">grand total</text>

  <line x1="300" y1="152" x2="150" y2="178" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="320" y1="152" x2="320" y2="178" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="340" y1="152" x2="490" y2="178" stroke="#475569" marker-end="url(#arr)"/>

  <text x="320" y="262" text-anchor="middle" fill="#64748b">Coarser levels reuse the sorted/hashed input — no extra table scans.</text>
  <text x="320" y="284" text-anchor="middle" fill="#64748b">GROUPING(col)=1 marks the rolled-up (NULL) column on subtotal rows.</text>
</svg>
```

## 6. Variations & Trade-offs

| Construct | Grouping sets produced | Row count (n cols) | Use when |
|-----------|------------------------|--------------------|----------|
| `GROUP BY a,b` | `(a,b)` only | 1 set | Plain detail, no totals |
| `ROLLUP(a,b)` | `(a,b),(a),()` | n+1 sets | **Hierarchy** with subtotals + grand total |
| `CUBE(a,b)` | `(a,b),(a),(b),()` | 2ⁿ sets | Full cross-tab, every dimension independent |
| `GROUPING SETS(...)` | exactly what you list | arbitrary | **Precise** control, mix custom levels |
| N separate `UNION ALL` queries | manual | n scans | Legacy / MySQL without grouping sets |

`ROLLUP` assumes a **hierarchy** (year→quarter→month); `CUBE` assumes **independent dimensions** and explodes to 2ⁿ sets — expensive past 3–4 columns. `GROUPING SETS` is the escape hatch when you want, say, per-region and per-category totals but *not* the per-region-per-category detail.

## 7. Performance Notes

- **HAVING is not a substitute for WHERE.** `HAVING region = 'East'` forces the engine to group every region and then discard most — put non-aggregate predicates in `WHERE` to filter before the sort/hash.
- Grouping sets **reuse one scan**, so they are far cheaper than the equivalent `UNION ALL` of N queries, each of which rescans the table.
- **CUBE cost grows as 2ⁿ.** With 5 dimensions that is 32 aggregation levels — memory for hash tables and output rows balloons. Prefer `GROUPING SETS` listing only the slices the report needs.
- A composite index on the leading `GROUP BY` columns lets PostgreSQL/InnoDB feed a **sorted `GroupAggregate`** and skip an explicit sort. Check `EXPLAIN` for `HashAggregate` (needs memory) vs `GroupAggregate` (needs sorted input).
- `HashAggregate` that exceeds `work_mem` spills to disk (visible as `Batches: >1` in `EXPLAIN ANALYZE`) — raise `work_mem` for big grouping-set reports.
- Order the report with `GROUPING(col)` in `ORDER BY` so subtotal rows sort *after* their details, not interleaved by a raw `NULL`.

## 8. Common Mistakes

1. ⚠️ Using `HAVING` for a row condition (`HAVING status='paid'`) — wasteful; belongs in `WHERE`. Fix: filter rows in `WHERE`, groups in `HAVING`.
2. ⚠️ Displaying subtotal `NULL`s raw so users can't tell a real NULL from a total. Fix: wrap columns in `CASE WHEN GROUPING(col)=1 THEN 'Total' ELSE col END`.
3. ⚠️ Assuming `ROLLUP(a,b)` gives per-`b` totals — it does not (that's `(b)`, only in `CUBE`/grouping sets). Fix: use `CUBE` or add the `(b)` set explicitly.
4. ⚠️ `CUBE` on many columns causing an exponential row/memory blowup. Fix: enumerate only needed slices with `GROUPING SETS`.
5. ⚠️ Sorting the report with a plain `ORDER BY region` — the `NULL` grand total floats to the top or bottom unpredictably. Fix: `ORDER BY GROUPING(region), region, ...`.
6. ⚠️ Expecting `CUBE`/`GROUPING SETS` in MySQL — only `WITH ROLLUP` exists there. Fix: emulate with `UNION ALL` or upgrade to a dialect that supports them.
7. ⚠️ Referencing a non-aggregated, non-grouped column in `HAVING`. Fix: only aggregates and `GROUP BY` columns are allowed.

## 9. Interview Questions

**Q: What is the difference between WHERE and HAVING?**
A: WHERE filters individual rows before grouping; HAVING filters groups after aggregation. WHERE cannot reference aggregates; HAVING typically does. Push non-aggregate predicates into WHERE for efficiency.

**Q: Can HAVING be used without GROUP BY?**
A: Yes — with no GROUP BY the whole table is one implicit group, so `SELECT SUM(x) FROM t HAVING SUM(x) > 100` returns the total only if it exceeds 100. Rare but valid.

**Q: What grouping sets does ROLLUP(a, b, c) generate?**
A: Four: (a,b,c), (a,b), (a), and (). It rolls up right-to-left, producing a hierarchy of subtotals plus the grand total — n+1 sets for n columns.

**Q: How does CUBE differ from ROLLUP?**
A: CUBE generates all 2ⁿ combinations of the columns (every dimension independently), while ROLLUP generates only the n+1 hierarchical prefixes. CUBE is for cross-tabs; ROLLUP for nested hierarchies.

**Q: What does the GROUPING() function return and why do you need it?**
A: GROUPING(col) returns 1 if col was aggregated over (a subtotal/total row) and 0 otherwise. It lets you distinguish a subtotal's NULL from a genuine data NULL, so you can label totals correctly.

**Q: How would you produce per-region subtotals and a grand total in one query?**
A: `GROUP BY ROLLUP(region)` — or `GROUP BY ROLLUP(region, category)` for detail + region subtotals + grand total — then use GROUPING() to label the total rows.

**Q: Why are grouping sets cheaper than UNION ALL of several GROUP BY queries?**
A: Grouping sets scan the base table once and derive every level from a shared sort/hash, whereas each UNION ALL branch rescans and re-aggregates the table independently.

**Q: How do you replicate ROLLUP behavior in MySQL?**
A: MySQL supports `GROUP BY ... WITH ROLLUP` (with GROUPING() from 8.0). It lacks CUBE and GROUPING SETS, so those must be emulated with UNION ALL of separate GROUP BY queries.

**Q: (Senior) How does the planner execute a grouping-set query, and what shows in EXPLAIN?**
A: PostgreSQL uses a MixedAggregate/GroupAggregate/HashAggregate node fed by one scan; each grouping set is an output phase. EXPLAIN shows the aggregate strategy and the "Group Key" sets. HashAggregate can spill to disk (Batches > 1) if it exceeds work_mem.

**Q: (Senior) You have 6 dimensions and CUBE times out. What do you do?**
A: CUBE explodes to 2⁶ = 64 grouping sets. Replace it with GROUPING SETS listing only the slices the report actually needs, pre-aggregate to a summary/materialized table, or push the cube into a dedicated OLAP engine.

**Q: (Senior) Why can ordering a ROLLUP report be tricky, and how do you fix it?**
A: Subtotal rows have NULL in rolled-up columns, so a plain ORDER BY scatters them by NULL sort position. Sort with GROUPING(col) first (`ORDER BY GROUPING(region), region, GROUPING(category), category`) so each subtotal follows its detail rows.

**Q: (Senior) Can you combine a plain GROUP BY column with ROLLUP?**
A: Yes — `GROUP BY a, ROLLUP(b, c)` keeps `a` in every grouping set and applies the rollup to (b, c), giving detail, per-(a,b) and per-(a) subtotals within each a. It's the Cartesian product of the grouping-set lists.

## 10. Practice

- [ ] Write a report of `SUM(amount)` by `region, category` with per-region subtotals and a grand total using ROLLUP.
- [ ] Rewrite it with CUBE and identify the extra rows CUBE adds.
- [ ] Use GROUPING SETS to produce per-region and per-category totals but no per-region-per-category detail.
- [ ] Add GROUPING()-based CASE labels so subtotal rows read "All regions"/"All categories".
- [ ] Explain-analyze a ROLLUP query and confirm it scans the base table only once.

## 11. Cheat Sheet

> [!TIP]
> **HAVING** filters groups (after aggregation); **WHERE** filters rows (before). Push non-aggregate predicates to WHERE.
> **ROLLUP(a,b)** → (a,b),(a),() — hierarchical subtotals + grand total (n+1 sets).
> **CUBE(a,b)** → all 2ⁿ combos — full cross-tab.
> **GROUPING SETS((a,b),(a),())** → exactly the levels you list.
> **GROUPING(col)=1** marks a subtotal/total row — use it to label NULLs and to ORDER BY correctly.
> All three do it in **one table scan**; CUBE cost is 2ⁿ — prefer explicit GROUPING SETS at scale. MySQL: `WITH ROLLUP` only.

**References:** PostgreSQL docs — "GROUPING SETS, CUBE, and ROLLUP"; MySQL Reference Manual — "GROUP BY Modifiers"; Use The Index, Luke — grouping and sorting

---

*SQL Handbook — topic 08.*
