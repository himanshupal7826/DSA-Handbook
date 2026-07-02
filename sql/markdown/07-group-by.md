# 07 · GROUP BY & Aggregate Functions

> **In one line:** `GROUP BY` collapses rows sharing a key into one row per group, and aggregate functions (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`) summarize each group into a single value.

---

## 1. Overview

Aggregation answers "per-group" questions: revenue per customer, orders per day, max salary per department. **`GROUP BY`** partitions the rows into groups that share the same value(s) in the grouping columns, and each **aggregate function** reduces a whole group to one scalar. The result has exactly one row per distinct group.

The mental model: rows go *in*, groups come *out*. Every column in the `SELECT` must therefore be either a **grouping column** (constant within the group) or wrapped in an **aggregate** (reduces the group) — anything else is ambiguous, because there'd be many candidate values and no rule to pick one.

Two things reliably trip people up. First, **NULL handling**: `COUNT(col)` and `SUM/AVG` *skip* NULLs, but `COUNT(*)` counts every row and `GROUP BY` treats all NULLs as one group. Second, the difference between filtering rows *before* grouping (`WHERE`) and filtering groups *after* (`HAVING`). Get those two right and aggregation becomes routine.

## 2. Core Concepts

- **`GROUP BY key`** — collapse rows with the same key into one output row per distinct key (multi-column keys group on the combination).
- **Aggregate function** — `COUNT`, `SUM`, `AVG`, `MIN`, `MAX` (and `STRING_AGG`/`ARRAY_AGG`) reduce a group to one value.
- **The grouping rule** — every non-aggregated `SELECT` expression must appear in `GROUP BY`.
- **`COUNT(*)`** — counts rows in the group, including all-NULL rows.
- **`COUNT(col)`** — counts rows where `col IS NOT NULL`.
- **`COUNT(DISTINCT col)`** — counts distinct non-NULL values.
- **NULLs in aggregates** — `SUM`/`AVG`/`MIN`/`MAX` ignore NULLs; `AVG` divides by the *non-NULL* count.
- **`WHERE` vs `HAVING`** — `WHERE` filters rows before grouping; `HAVING` filters groups after (can reference aggregates).
- **`FILTER (WHERE …)`** — per-aggregate conditional aggregation (SQL-standard; PostgreSQL/SQLite).
- **Empty groups** — `COUNT` returns `0`; `SUM`/`AVG`/`MIN`/`MAX` return `NULL` over zero rows.

## 3. Syntax & Examples

```sql
-- Orders and revenue per customer
SELECT customer_id,
       COUNT(*)        AS order_count,
       SUM(total)      AS revenue,
       AVG(total)      AS avg_order,
       MAX(total)      AS biggest
FROM orders
GROUP BY customer_id;
```

```sql
-- WHERE (pre-group) vs HAVING (post-group)
SELECT customer_id, SUM(total) AS revenue
FROM orders
WHERE status = 'paid'          -- filter rows BEFORE aggregating
GROUP BY customer_id
HAVING SUM(total) > 100        -- filter GROUPS after aggregating
ORDER BY revenue DESC;
```

```sql
-- COUNT variants side by side
SELECT COUNT(*)                 AS rows_total,       -- every row
       COUNT(coupon_code)       AS rows_with_coupon, -- non-NULL only
       COUNT(DISTINCT customer_id) AS unique_buyers  -- distinct non-NULL
FROM orders;
```

```sql
-- FILTER: conditional aggregation without self-joins (Postgres/SQLite)
SELECT customer_id,
       COUNT(*)                                AS all_orders,
       COUNT(*) FILTER (WHERE status='paid')   AS paid_orders,
       SUM(total) FILTER (WHERE status='paid') AS paid_revenue
FROM orders
GROUP BY customer_id;
-- MySQL equivalent: SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END)
```

> [!NOTE]
> **Standard vs MySQL grouping.** Standard SQL (PostgreSQL, SQL Server, Oracle) rejects a non-aggregated, non-grouped column with "must appear in the GROUP BY clause". MySQL historically allowed it and returned an *arbitrary* value from the group (`ONLY_FULL_GROUP_BY` now off by default enforces the standard). Never rely on the old MySQL leniency.

## 4. Sample Data & Results

**`orders`**

| id  | customer_id | status | total | coupon_code |
|-----|-------------|--------|-------|-------------|
| 100 | 1           | paid   | 40    | NULL        |
| 101 | 1           | paid   | 25    | SAVE10      |
| 102 | 2           | refund | 90    | NULL        |
| 103 | 2           | paid   | 30    | NULL        |
| 104 | 3           | paid   | 15    | SAVE10      |

Query:

```sql
SELECT customer_id,
       COUNT(*)                 AS orders,
       COUNT(coupon_code)       AS with_coupon,
       SUM(total)               AS revenue,
       SUM(total) FILTER (WHERE status='paid') AS paid_rev
FROM orders
GROUP BY customer_id
ORDER BY customer_id;
```

**Result:**

| customer_id | orders | with_coupon | revenue | paid_rev |
|-------------|--------|-------------|---------|----------|
| 1           | 2      | 1           | 65      | 65       |
| 2           | 2      | 0           | 120     | 30       |
| 3           | 1      | 1           | 15      | 15       |

Note customer 1 has `orders = 2` but `with_coupon = 1` (one NULL coupon skipped), and customer 2's `paid_rev = 30` excludes the 90 refund while `revenue = 120` includes it.

## 5. Under the Hood

The engine executes aggregation as a distinct plan node placed *after* `WHERE` filtering. There are two strategies:

- **Hash aggregate** — build a hash table keyed by the grouping columns, updating each group's running aggregates as rows stream in. No ordering required; ideal for many small groups. Costs memory (one entry per group).
- **Sorted/streaming aggregate** — if the input arrives sorted on the grouping key (e.g. from an index), the engine emits a group the moment the key changes, using O(1) extra memory.

```svg
<svg viewBox="0 0 700 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <style>
    .lbl{fill:#1e293b;font-weight:600}.mut{fill:#64748b}.txt{fill:#1e293b}
    .box{fill:#eff6ff;stroke:#2563eb;stroke-width:1.5}
    .grp{fill:#ecfdf5;stroke:#059669;stroke-width:1.5}
    .ln{stroke:#475569;stroke-width:1.4}
  </style>

  <text x="80" y="24" text-anchor="middle" class="lbl">Input rows</text>
  <rect x="20" y="36" width="120" height="150" rx="8" class="box"/>
  <text x="80" y="60" text-anchor="middle" class="txt">c1 · 40</text>
  <text x="80" y="82" text-anchor="middle" class="txt">c1 · 25</text>
  <text x="80" y="104" text-anchor="middle" class="txt">c2 · 90</text>
  <text x="80" y="126" text-anchor="middle" class="txt">c2 · 30</text>
  <text x="80" y="148" text-anchor="middle" class="txt">c3 · 15</text>
  <text x="80" y="176" text-anchor="middle" class="mut">5 rows</text>

  <line x1="145" y1="110" x2="255" y2="110" class="ln" marker-end="url(#ar)"/>
  <text x="200" y="100" text-anchor="middle" class="mut">GROUP BY</text>
  <text x="200" y="126" text-anchor="middle" class="mut">customer_id</text>

  <text x="360" y="24" text-anchor="middle" class="lbl">Groups (hash buckets)</text>
  <rect x="260" y="36" width="200" height="46" rx="8" class="grp"/>
  <text x="360" y="64" text-anchor="middle" class="txt">c1 → [40, 25]</text>
  <rect x="260" y="92" width="200" height="46" rx="8" class="grp"/>
  <text x="360" y="120" text-anchor="middle" class="txt">c2 → [90, 30]</text>
  <rect x="260" y="148" width="200" height="46" rx="8" class="grp"/>
  <text x="360" y="176" text-anchor="middle" class="txt">c3 → [15]</text>

  <line x1="465" y1="110" x2="555" y2="110" class="ln" marker-end="url(#ar)"/>
  <text x="510" y="100" text-anchor="middle" class="mut">SUM()</text>

  <text x="628" y="24" text-anchor="middle" class="lbl">Output</text>
  <rect x="560" y="36" width="120" height="158" rx="8" class="box"/>
  <text x="620" y="66" text-anchor="middle" class="txt">c1 · 65</text>
  <text x="620" y="118" text-anchor="middle" class="txt">c2 · 120</text>
  <text x="620" y="170" text-anchor="middle" class="txt">c3 · 15</text>

  <rect x="150" y="240" width="400" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="350" y="264" text-anchor="middle" class="lbl">Pipeline: FROM/JOIN → WHERE → GROUP BY</text>
  <text x="350" y="286" text-anchor="middle" class="txt">→ aggregates → HAVING → SELECT → ORDER BY</text>
</svg>
```

Crucially, `WHERE` runs *before* the group node, so it filters raw rows and cannot see aggregates. `HAVING` runs *after*, so it can. And because `SELECT` aliases are computed last, most engines won't let `HAVING`/`WHERE` reference a `SELECT` alias (though PostgreSQL permits it in `GROUP BY`/`ORDER BY`).

## 6. Variations & Trade-offs

| Expression | Counts / sums what | NULL behavior |
|------------|--------------------|---------------|
| `COUNT(*)` | all rows in group | counts NULL rows |
| `COUNT(col)` | rows where `col` is not NULL | skips NULLs |
| `COUNT(DISTINCT col)` | distinct non-NULL values | skips NULLs, dedupes |
| `SUM(col)` / `AVG(col)` | non-NULL values | skips NULLs; `AVG` = sum ÷ non-NULL count |
| `MIN(col)` / `MAX(col)` | extreme non-NULL value | skips NULLs |
| `SUM(...)` over 0 rows | — | returns **NULL**, not 0 |

**Filtering approaches:** `FILTER (WHERE …)` (Postgres, SQLite, standard) vs `SUM(CASE WHEN … THEN … END)` (portable, works in MySQL). Both do conditional aggregation in one pass — far better than multiple self-joins or correlated subqueries.

**`GROUP BY` extensions:** `ROLLUP`, `CUBE`, and `GROUPING SETS` compute multiple grouping levels (subtotals + grand totals) in one query — supported by PostgreSQL, SQL Server, Oracle, and MySQL (`WITH ROLLUP`).

## 7. Performance Notes

- **Index the grouping key** — an index ordered on the `GROUP BY` columns lets the planner use a cheap streaming aggregate and skip the sort/hash-build step.
- **Hash aggregate memory** — many distinct groups inflate the hash table; if it spills to disk (`work_mem` exceeded in PostgreSQL) it slows sharply. Watch for `Batches > 1` in `EXPLAIN ANALYZE`.
- **`COUNT(DISTINCT …)` is expensive** — it must dedupe, typically via a sort or a second hash. On huge tables consider approximate counts (`HLL`/`APPROX_COUNT_DISTINCT`) if exactness isn't required.
- **Filter early** — push selective conditions into `WHERE` (pre-group) so fewer rows reach the aggregate; reserve `HAVING` for genuinely aggregate conditions.
- **Covering index** — if the index contains both the grouping key and the aggregated column, the aggregate can be satisfied index-only (no heap fetch). Look for `Index Only Scan`.

## 8. Common Mistakes

1. ⚠️ **Selecting a non-grouped, non-aggregated column** — errors in standard SQL, returns garbage in lenient MySQL. Add it to `GROUP BY` or wrap it in an aggregate.
2. ⚠️ **Putting an aggregate condition in `WHERE`** (`WHERE SUM(total) > 100`) fails — aggregates belong in `HAVING`.
3. ⚠️ **Confusing `COUNT(*)` with `COUNT(col)`** on a nullable column — they differ by the NULL count; pick deliberately.
4. ⚠️ **Expecting `SUM` of an empty/all-NULL group to be 0** — it's `NULL`; wrap with `COALESCE(SUM(x), 0)`.
5. ⚠️ **`AVG` surprises** — it divides by the *non-NULL* count, not the row count, so NULLs raise the average versus treating them as 0.
6. ⚠️ **Filtering with `WHERE` then wondering where groups went** — a pre-group `WHERE` on the metric removes rows that would have formed groups; use `HAVING` for group-level thresholds.
7. ⚠️ **Fan-out before grouping** — a one-to-many join upstream inflates `SUM`; aggregate the many-side first (see topic 05).

## 9. Interview Questions

**Q: What is the difference between `COUNT(*)`, `COUNT(col)`, and `COUNT(DISTINCT col)`?**
A: `COUNT(*)` counts every row in the group including all-NULL rows. `COUNT(col)` counts only rows where `col IS NOT NULL`. `COUNT(DISTINCT col)` counts distinct non-NULL values of `col`.

**Q: What's the rule for which columns may appear in the SELECT of a GROUP BY query?**
A: Every SELECT expression must be either a grouping column (listed in `GROUP BY`) or inside an aggregate function. Anything else is ambiguous because the group holds multiple candidate values — standard SQL rejects it.

**Q: How do aggregates treat NULLs?**
A: `SUM`, `AVG`, `MIN`, `MAX`, and `COUNT(col)` all ignore NULLs. `COUNT(*)` counts them. Notably `AVG` divides by the non-NULL count, so NULLs are excluded, not treated as zero.

**Q: What does `SUM` return over an empty group or an all-NULL column?**
A: `NULL`, not `0`. `COUNT` returns `0` in that case. Wrap with `COALESCE(SUM(x), 0)` if you need a zero.

**Q: WHERE vs HAVING — when do you use each?**
A: `WHERE` filters individual rows before grouping and cannot reference aggregates. `HAVING` filters whole groups after aggregation and can use aggregates like `HAVING SUM(total) > 100`. Push selective predicates into `WHERE` for efficiency.

**Q: How would you count paid vs unpaid orders per customer in a single query?**
A: Conditional aggregation: `COUNT(*) FILTER (WHERE status='paid')` and `FILTER (WHERE status<>'paid')`, or portably `SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END)`.

**Q: Why does `AVG(col)` differ from `SUM(col)/COUNT(*)` when the column has NULLs?**
A: `AVG` and `SUM` skip NULLs, so `AVG = SUM/COUNT(col)`. Dividing by `COUNT(*)` uses the full row count including NULL rows, giving a smaller (and usually wrong) average.

**Q: Can you reference a SELECT alias in HAVING or WHERE?**
A: Generally no — `SELECT` is logically evaluated after `WHERE`, `GROUP BY`, and `HAVING`, so the alias isn't defined yet. Repeat the expression, or use a subquery/CTE. (PostgreSQL does allow aliases in `GROUP BY` and `ORDER BY` as an extension.)

**Q: How does the engine physically compute `GROUP BY`, and how does indexing help?**
A: Via a hash aggregate (hash table keyed by the grouping columns) or a streaming/sorted aggregate when the input is already ordered on the key. An index on the grouping columns supplies that order, letting the planner skip the sort and use O(1)-memory streaming aggregation.

**Q: Why is `COUNT(DISTINCT col)` slower than `COUNT(col)`?**
A: `COUNT(col)` just increments a counter, but `COUNT(DISTINCT col)` must deduplicate — via a sort or an auxiliary hash set per group — which costs extra CPU and memory. At scale, approximate distinct counts (HyperLogLog) are far cheaper.

**Q: What happens to a `SUM` when an upstream one-to-many join inflates rows?**
A: The measure gets multiplied by the number of matched rows, overstating the total. Fix by pre-aggregating the many-side in a CTE/subquery before joining, so each key contributes one summarized row.

**Q: How do you produce subtotals and a grand total in one query?**
A: `GROUP BY ROLLUP(a, b)` (or `GROUPING SETS`) generates the group rows plus subtotal and grand-total rows in a single pass; `GROUPING()` distinguishes the total rows from real NULLs.

## 10. Practice

- [ ] Compute order count, total revenue, and average order value per customer.
- [ ] Show only customers whose total revenue exceeds 100 (`HAVING`).
- [ ] For each status, count orders and count distinct customers in one query.
- [ ] Return paid vs refunded revenue per customer using `FILTER` (and the `CASE` equivalent).
- [ ] Add a grand-total row with `ROLLUP`, and `COALESCE` empty `SUM`s to 0.

## 11. Cheat Sheet

> [!TIP]
> **GROUP BY** collapses rows into one row per key; every non-aggregate in SELECT must be grouped. **COUNT(\*)** = all rows, **COUNT(col)** skips NULLs, **COUNT(DISTINCT)** dedupes non-NULLs. `SUM/AVG/MIN/MAX` ignore NULLs; `SUM` of nothing is **NULL** (COALESCE it), and `AVG` divides by the non-NULL count. **WHERE** filters rows pre-group; **HAVING** filters groups post-group. Use `FILTER (WHERE …)` / `CASE` for conditional aggregation. Index the grouping key for streaming aggregation.

**References:** PostgreSQL docs "Aggregate Functions" & "GROUP BY / HAVING", MySQL "GROUP BY Aggregate Functions", Use The Index Luke ("Grouping and Sorting"), SQL-92 grouping rules

---

*SQL Handbook — topic 07.*
