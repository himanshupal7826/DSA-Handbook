# 16 · Pivoting & Conditional Aggregation

> **In one line:** Turn rows into columns (and back) with `SUM(CASE WHEN …)` / `FILTER`, `crosstab`, and `UNION ALL` — a report shape, not a new algorithm.

---

## 1. Overview

**Pivoting** reshapes a long, narrow result (one row per category+period) into a wide crosstab (one row per period, one column per category). It is the classic "monthly sales by product category" report: the analyst wants months down the side and categories across the top.

SQL has no portable `PIVOT` keyword the way spreadsheets or SQL Server do. The workhorse in PostgreSQL/MySQL is **conditional aggregation**: group by the row axis, then emit one aggregate expression per target column using `CASE WHEN` (or the SQL-standard `FILTER`) to route values into the right bucket.

The inverse — **unpivot** — folds wide columns back into (key, value) rows using `UNION ALL` or a `LATERAL` join. You reach for pivoting when the *presentation* wants columns but the *storage* is normalized long-form, which is almost always the right way to store the data.

The hard limitation: **the column list must be known at query-planning time.** SQL is statically typed on its output columns, so a truly *dynamic* pivot (columns discovered from the data) requires generating SQL text in application code or PL/pgSQL — not a single static statement.

## 2. Core Concepts

- **Long vs wide** — long form (`month, category, amount`) is the storage-friendly shape; wide form (`month, electronics, apparel, …`) is the report shape.
- **Conditional aggregation** — `SUM(CASE WHEN category='Electronics' THEN amount END)` collapses matched rows into one column; non-matches yield `NULL`, which `SUM` ignores.
- **`FILTER (WHERE …)`** — SQL-standard, PostgreSQL-supported sugar for the same thing: `SUM(amount) FILTER (WHERE category='Electronics')`. Cleaner and often faster to read.
- **One aggregate per output column** — you hand-write N expressions for N columns; the column set is fixed in the SQL text.
- **`crosstab()`** — PostgreSQL `tablefunc` extension that pivots a two-column-key result into columns; needs an explicit column definition list.
- **Unpivot** — the reverse; `UNION ALL` of per-column SELECTs, or `LATERAL (VALUES …)` to expand each wide row into several tall rows.
- **Dynamic pivot** — column names driven by data require dynamic SQL (`EXECUTE format(...)` in PL/pgSQL) because output shape can't depend on runtime rows.
- **NULL vs zero** — an empty bucket aggregates to `NULL`; wrap in `COALESCE(…, 0)` when the report wants zeros.

## 3. Syntax & Examples

```sql
-- Simplest pivot: conditional aggregation with CASE
SELECT
  category,
  SUM(CASE WHEN month = 1 THEN amount ELSE 0 END) AS jan,
  SUM(CASE WHEN month = 2 THEN amount ELSE 0 END) AS feb,
  SUM(CASE WHEN month = 3 THEN amount ELSE 0 END) AS mar
FROM sales
GROUP BY category;
```

```sql
-- Same result, SQL-standard FILTER (PostgreSQL). Cleaner, NULLs -> COALESCE for zeros.
SELECT
  category,
  COALESCE(SUM(amount) FILTER (WHERE month = 1), 0) AS jan,
  COALESCE(SUM(amount) FILTER (WHERE month = 2), 0) AS feb,
  COALESCE(SUM(amount) FILTER (WHERE month = 3), 0) AS mar
FROM sales
GROUP BY category;
```

```sql
-- crosstab() from the tablefunc extension (PostgreSQL)
CREATE EXTENSION IF NOT EXISTS tablefunc;

SELECT * FROM crosstab(
  $$ SELECT category, month, SUM(amount)
     FROM sales GROUP BY category, month ORDER BY 1, 2 $$,
  $$ SELECT generate_series(1,3) $$          -- the ordered list of pivot keys
) AS ct(category text, jan numeric, feb numeric, mar numeric);
```

```sql
-- UNPIVOT: wide -> long with UNION ALL
SELECT category, 'jan' AS month, jan AS amount FROM sales_wide
UNION ALL SELECT category, 'feb', feb FROM sales_wide
UNION ALL SELECT category, 'mar', mar FROM sales_wide;

-- UNPIVOT with LATERAL (single scan of the wide table)
SELECT w.category, u.month, u.amount
FROM sales_wide w
CROSS JOIN LATERAL (VALUES
  ('jan', w.jan), ('feb', w.feb), ('mar', w.mar)
) AS u(month, amount);
```

## 4. Sample Data & Results

Input — long-form `sales`:

| category    | month | amount |
|-------------|-------|--------|
| Electronics | 1     | 1200   |
| Electronics | 2     | 1500   |
| Apparel     | 1     | 800    |
| Apparel     | 3     | 950    |
| Grocery     | 2     | 600    |

Query (the `FILTER` pivot from §3) →

| category    | jan  | feb  | mar |
|-------------|------|------|-----|
| Electronics | 1200 | 1500 | 0   |
| Apparel     | 800  | 0    | 950 |
| Grocery     | 0    | 600  | 0   |

Note how Apparel's February and Grocery's January/March are empty buckets: the raw aggregate is `NULL`, and `COALESCE(…,0)` renders them as `0`.

## 5. Under the Hood

A `CASE`/`FILTER` pivot is a **single grouped aggregate**. The planner scans (or index-scans) `sales`, groups rows by `category` (via HashAggregate or sorted GroupAggregate), and for each group evaluates every conditional aggregate over the same group's rows — one pass, N accumulators. `FILTER` is not a second scan; each aggregate keeps its own running state and simply skips rows failing its predicate.

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="90" y="24" text-anchor="middle" fill="#1e293b" font-weight="600">Long rows</text>
  <rect x="20" y="36" width="140" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="90" y="58" text-anchor="middle" fill="#1e293b">Elec, m1, 1200</text>
  <text x="90" y="80" text-anchor="middle" fill="#1e293b">Elec, m2, 1500</text>
  <text x="90" y="102" text-anchor="middle" fill="#1e293b">Appa, m1, 800</text>
  <text x="90" y="124" text-anchor="middle" fill="#1e293b">Appa, m3, 950</text>
  <text x="90" y="146" text-anchor="middle" fill="#1e293b">Groc, m2, 600</text>

  <text x="320" y="24" text-anchor="middle" fill="#1e293b" font-weight="600">GROUP BY category</text>
  <rect x="240" y="36" width="160" height="150" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="320" y="70" text-anchor="middle" fill="#1e293b">3 groups, each fed</text>
  <text x="320" y="92" text-anchor="middle" fill="#1e293b">to 3 accumulators:</text>
  <text x="320" y="118" text-anchor="middle" fill="#64748b">jan += amt if m=1</text>
  <text x="320" y="138" text-anchor="middle" fill="#64748b">feb += amt if m=2</text>
  <text x="320" y="158" text-anchor="middle" fill="#64748b">mar += amt if m=3</text>

  <text x="545" y="24" text-anchor="middle" fill="#1e293b" font-weight="600">Wide row</text>
  <rect x="470" y="36" width="150" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="545" y="70" text-anchor="middle" fill="#1e293b">cat | jan feb mar</text>
  <text x="545" y="98" text-anchor="middle" fill="#1e293b">Elec |1200 1500 0</text>
  <text x="545" y="120" text-anchor="middle" fill="#1e293b">Appa | 800  0 950</text>
  <text x="545" y="142" text-anchor="middle" fill="#1e293b">Groc |  0 600  0</text>

  <line x1="162" y1="110" x2="236" y2="110" stroke="#475569" stroke-width="1.5" marker-end="url(#arr)"/>
  <line x1="402" y1="110" x2="466" y2="110" stroke="#475569" stroke-width="1.5" marker-end="url(#arr)"/>
  <text x="320" y="230" text-anchor="middle" fill="#64748b">One scan · one grouping · N conditional accumulators (no extra passes)</text>
</svg>
```

`crosstab()` works differently: it consumes an already-sorted two-key result and pivots it procedurally in C, matching category values against the second query's key list. It is fast but rigid — you must spell out the output column types in the `AS ct(...)` clause.

## 6. Variations & Trade-offs

| Approach | Dialect | Dynamic columns? | Notes |
|----------|---------|------------------|-------|
| `SUM(CASE WHEN …)` | Portable (PG, MySQL, SQLite) | No | Universal; verbose; NULL→needs COALESCE |
| `agg FILTER (WHERE …)` | PostgreSQL, SQLite 3.30+ | No | Cleaner, same plan as CASE |
| `crosstab()` | PostgreSQL (`tablefunc`) | No (needs col def list) | Fast for large pivots; rigid typing |
| `PIVOT` operator | SQL Server, Oracle | No | Syntactic sugar; still static columns |
| Dynamic SQL (`EXECUTE format`) | PG PL/pgSQL, app code | Yes | Build column list from a query, then run |
| App-side pivot | Any | Yes | Fetch long form, reshape in code — often simplest |

Prefer `FILTER`/`CASE` for portability and readability. Reach for `crosstab()` only when the pivot is wide and hot. Push genuinely dynamic pivots to the application or a PL/pgSQL wrapper — do not try to bend one static statement into producing runtime-determined columns.

## 7. Performance Notes

- A conditional-aggregation pivot costs **one grouped scan**, same as a plain `GROUP BY category` — the N `CASE` expressions are cheap per-row branches, not extra scans.
- An index on the `GROUP BY` key (`category`) enables a streaming GroupAggregate and avoids a sort/hash; a covering index on `(category, month, amount)` can make it index-only.
- `FILTER` and `CASE` plan identically — pick `FILTER` for readability, not speed.
- `crosstab()` requires its input **ordered by (row_key, category_key)**; a matching index avoids the sort. Mis-ordered input silently misaligns columns.
- Unpivot via `UNION ALL` scans the wide table **once per branch** (N scans); `LATERAL (VALUES …)` scans it once — prefer LATERAL for wide tables.
- `EXPLAIN` a pivot: you want a single `HashAggregate`/`GroupAggregate` node, not nested subqueries or repeated scans of the fact table.

## 8. Common Mistakes

1. ⚠️ Using `MAX(CASE …)` when a bucket can hold multiple rows — it silently keeps one value. Use `SUM`/`COUNT` for additive facts; `MAX` only when each cell is guaranteed unique.
2. ⚠️ Forgetting `COALESCE(…, 0)` and shipping `NULL` cells the report expected as zeros.
3. ⚠️ Expecting `crosstab()` to infer columns — it needs the explicit `AS ct(col type, …)` definition list, and a mismatch throws or misaligns.
4. ⚠️ Trying to make column *names* depend on data in one static query — impossible; you need dynamic SQL.
5. ⚠️ Unpivoting with N separate `UNION ALL` scans over a huge wide table instead of one `LATERAL (VALUES …)`.
6. ⚠️ Putting the pivoted column in `GROUP BY` — it belongs inside the aggregate's condition, not the grouping key.
7. ⚠️ `crosstab()` input not `ORDER BY`'d by both keys, so values land in the wrong columns without error.

## 9. Interview Questions

**Q: How do you pivot rows into columns without a PIVOT keyword?**
A: Group by the row axis and write one conditional aggregate per target column, e.g. `SUM(CASE WHEN month=1 THEN amount END) AS jan`. Each aggregate ignores NULLs from non-matching rows, so only the matching bucket accumulates.

**Q: What's the difference between `SUM(CASE WHEN c THEN x END)` and `SUM(x) FILTER (WHERE c)`?**
A: They are semantically identical and plan the same way. `FILTER` is the SQL-standard form (PostgreSQL, SQLite 3.30+), more readable; `CASE` is portable to engines like MySQL that lack `FILTER`.

**Q: Why do empty pivot cells show NULL, and how do you get zeros?**
A: If no row matches a bucket, the aggregate sees only NULLs and `SUM` of all-NULL is NULL. Wrap it: `COALESCE(SUM(…) FILTER (WHERE …), 0)`.

**Q: Can a single SQL statement produce columns whose names come from the data?**
A: No. SQL fixes its output column set at plan time, so column names/count can't depend on runtime rows. You must generate the SQL text dynamically (PL/pgSQL `EXECUTE format(...)` or application code) after querying the distinct values.

**Q: What does PostgreSQL's `crosstab()` need that `CASE` pivots don't?**
A: It requires the `tablefunc` extension, input ordered by `(row_key, category_key)`, and an explicit output column definition list (`AS ct(category text, jan numeric, …)`). It's faster for wide pivots but rigid.

**Q: How do you unpivot a wide table back to long form efficiently?**
A: `CROSS JOIN LATERAL (VALUES ('jan', jan), ('feb', feb), …) AS u(month, amount)` expands each wide row in a single scan. `UNION ALL` also works but scans the table once per column.

**Q: Your pivot query's plan shows the fact table scanned three times. Why, and how do you fix it?**
A: Likely written as three subqueries or a `UNION ALL` unpivot instead of one grouped conditional aggregation. Rewrite as a single `GROUP BY` with per-column `FILTER` aggregates so the planner does one scan with N accumulators.

**Q: Does adding more pivot columns proportionally slow the query?**
A: Roughly linearly in CPU (more per-row branch evaluations and accumulators) but it stays **one scan** — I/O is unchanged. The cost driver is the group count and input size, not the column count, until you hit hundreds of columns.

**Q: How would you build a report where the month columns are the last 12 rolling months, unknown until runtime?**
A: Query the distinct months first, build the `FILTER`/`CASE` column list as a string, and run it via dynamic SQL (`EXECUTE format(...)` in a PL/pgSQL function returning a refcursor or SETOF record), or fetch long-form and pivot in the app.

**Q: When is pivoting in the application preferable to pivoting in SQL?**
A: When columns are dynamic, when the client already iterates the rows for rendering, or when you want to avoid coupling report layout to SQL. Storage stays normalized long-form; the app reshapes for display.

## 10. Practice

- [ ] Pivot a `sales(category, month, amount)` table into a 12-column monthly report using `FILTER`, with zeros for empty months.
- [ ] Rewrite that pivot with `SUM(CASE WHEN …)` and confirm via `EXPLAIN` the plans are identical.
- [ ] Use `crosstab()` to produce the same report and handle a category missing an entire month.
- [ ] Unpivot the wide report back to long form with `LATERAL (VALUES …)` and verify row counts match the original.
- [ ] Write a PL/pgSQL function that discovers distinct months and builds a dynamic pivot with `EXECUTE format(...)`.

## 11. Cheat Sheet

> [!TIP]
> **Pivot (rows→cols):** `GROUP BY row_axis` + one aggregate per column via `SUM(x) FILTER (WHERE col=val)` (or `SUM(CASE WHEN col=val THEN x END)`). Wrap in `COALESCE(…,0)` for zeros. **Static columns only** — dynamic column names need generated SQL (`EXECUTE format`) or app-side. **crosstab()** (PG `tablefunc`): fast, needs ordered input + explicit column list. **Unpivot (cols→rows):** `CROSS JOIN LATERAL (VALUES …)` (one scan) or `UNION ALL` (N scans). Cost = one grouped scan; index the `GROUP BY` key.

**References:** PostgreSQL docs — Aggregate Expressions (FILTER) & `tablefunc`/crosstab; PostgreSQL docs — LATERAL joins; MySQL Reference — GROUP BY & CASE; Modern SQL — "Pivot / Unpivot"

---
*SQL Handbook — topic 16.*
