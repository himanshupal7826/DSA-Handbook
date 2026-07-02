# 13 · Window Functions Fundamentals

> **In one line:** Compute per-row calculations over a *related* set of rows — running totals, group aggregates, comparisons — without collapsing those rows the way `GROUP BY` does.

---

## 1. Overview

A **window function** performs a calculation across a set of rows that are somehow related to the current row — the row's **window** — and returns *one value per input row*. Unlike a `GROUP BY` aggregate, which folds many rows into one, a window function **keeps every row** and simply attaches the computed value as an extra column.

The problem it solves: over and over you need "this row, *plus* something about its group" in the same result set. The employee's salary *and* the department average. Today's revenue *and* the running total to date. The order *and* its rank within the customer. With plain aggregation you'd have to compute the group value separately and self-join it back. Window functions collapse that whole pattern into one clause: `OVER (...)`.

You reach for windows whenever the phrase "**per** something" or "**compared to** the group" or "**running / cumulative**" appears: top-N per group, running totals, moving averages, percent-of-total, deduplication, month-over-month deltas. They are the single highest-leverage feature separating basic from advanced SQL, and they appear in nearly every senior analytics interview.

This page covers the **fundamentals** — the `OVER` clause, `PARTITION BY`, how windows differ from `GROUP BY`, aggregate window functions, and where windows sit in evaluation order. Ranking functions and the frame clause (`ROWS`/`RANGE BETWEEN`) get their own deep dive in **Ranking & Window Frames**.

## 2. Core Concepts

- **Window function** — a function with an `OVER` clause. Produces one output value per input row; the row count of the result is unchanged.
- **The `OVER` clause** — defines *which* rows form the window. An empty `OVER ()` means "every row in the result set is the window."
- **`PARTITION BY`** — splits rows into independent groups (partitions); the function restarts for each partition. This is the window analogue of `GROUP BY`, but rows are **kept**, not merged.
- **`ORDER BY` inside `OVER`** — orders rows *within* each partition. It turns a plain aggregate into a *running* one and is mandatory for ranking, `LAG`/`LEAD`, and running totals.
- **Rows are preserved** — the defining trait. `GROUP BY dept` yields one row per department; `SUM(...) OVER (PARTITION BY dept)` yields one row per *employee*, each carrying the department total.
- **Aggregate window functions** — `SUM`, `AVG`, `COUNT`, `MIN`, `MAX` all work as window functions when given an `OVER`. Same aggregate, no collapsing.
- **Evaluation order** — window functions run **after** `FROM`/`WHERE`/`GROUP BY`/`HAVING`, but **before** the final `SELECT DISTINCT`, `ORDER BY`, and `LIMIT`. Consequences flow from this.
- **No windows in `WHERE`** — because `WHERE` runs first, you cannot filter on a window result directly; wrap it in a subquery/CTE and filter the outer query.
- **`window_name` reuse** — a named `WINDOW w AS (...)` clause lets several functions share one definition, avoiding repetition and mistakes.

## 3. Syntax & Examples

The anatomy of any window function:

```sql
function_name(args) OVER (
    [ PARTITION BY expr [, ...] ]   -- split into groups
    [ ORDER BY expr [ASC|DESC] ]    -- order within each group
    [ frame_clause ]                -- ROWS/RANGE BETWEEN ... (see topic 14)
)
```

Start simple — a grand total attached to every row (empty `OVER`):

```sql
SELECT name, dept_id, salary,
       SUM(salary) OVER () AS total_payroll
FROM employees;
```

Add `PARTITION BY` — the aggregate restarts per department, but every employee row survives:

```sql
SELECT name, dept_id, salary,
       AVG(salary) OVER (PARTITION BY dept_id) AS dept_avg,
       salary - AVG(salary) OVER (PARTITION BY dept_id) AS diff_from_avg
FROM employees;
```

Add `ORDER BY` inside `OVER` — now the aggregate becomes **cumulative** (a running total), because an ordered window defaults to "all rows from the start of the partition up to the current row":

```sql
SELECT dept_id, name, salary,
       SUM(salary) OVER (PARTITION BY dept_id ORDER BY salary DESC)
         AS running_payroll
FROM employees;
```

Percent-of-total in one pass — combine a partitioned window with the current row:

```sql
SELECT dept_id, name, salary,
       ROUND(100.0 * salary
             / SUM(salary) OVER (PARTITION BY dept_id), 1) AS pct_of_dept
FROM employees;
```

Reuse a definition with a named window (both DB engines support this):

```sql
SELECT dept_id, name, salary,
       AVG(salary) OVER w  AS dept_avg,
       MAX(salary) OVER w  AS dept_max,
       COUNT(*)    OVER w  AS dept_headcount
FROM employees
WINDOW w AS (PARTITION BY dept_id);
```

## 4. Sample Data & Results

Input table `employees`:

| emp_id | name    | dept_id | salary |
|--------|---------|---------|--------|
| 1      | Alice   | 10      | 90000  |
| 2      | Bob     | 10      | 70000  |
| 3      | Carol   | 10      | 80000  |
| 4      | Dave    | 20      | 60000  |
| 5      | Eve     | 20      | 60000  |
| 6      | Frank   | 20      | 50000  |

Query — department average alongside each employee, without losing rows:

```sql
SELECT name, dept_id, salary,
       AVG(salary) OVER (PARTITION BY dept_id) AS dept_avg,
       SUM(salary) OVER (PARTITION BY dept_id
                         ORDER BY salary DESC)  AS running_payroll
FROM employees
ORDER BY dept_id, salary DESC;
```

Result — **6 rows in, 6 rows out**. `dept_avg` is constant per department; `running_payroll` accumulates down the ordered partition:

| name  | dept_id | salary | dept_avg | running_payroll |
|-------|---------|--------|----------|-----------------|
| Alice | 10      | 90000  | 80000    | 90000           |
| Carol | 10      | 80000  | 80000    | 170000          |
| Bob   | 10      | 70000  | 80000    | 240000          |
| Dave  | 20      | 60000  | 56666.67 | 60000           |
| Eve   | 20      | 60000  | 56666.67 | 120000          |
| Frank | 20      | 50000  | 56666.67 | 170000          |

Contrast the `GROUP BY` version — same average, but only **2 rows** and the names are gone:

```sql
SELECT dept_id, AVG(salary) AS dept_avg
FROM employees
GROUP BY dept_id;
```

| dept_id | dept_avg |
|---------|----------|
| 10      | 80000    |
| 20      | 56666.67 |

## 5. Under the Hood

Conceptually the engine (1) evaluates `FROM`/`WHERE`/`GROUP BY` to build the base rows, (2) **partitions** those rows by the `PARTITION BY` keys, (3) **sorts** each partition by the `OVER … ORDER BY`, then (4) sweeps through each partition computing the function per row. Because it needs partition-then-sort, a `WindowAgg` (PostgreSQL) or `Window` (SQL Server / MySQL 8) operator is usually preceded by a `Sort` unless an index already delivers the rows in window order.

The diagram below shows the key mental model: `GROUP BY` **collapses** the partition to one row; the window function **broadcasts** a per-partition value back onto every row.

```svg
<svg viewBox="0 0 640 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" fill="#1e293b" font-weight="600">PARTITION BY dept_id — rows kept vs. rows collapsed</text>

  <!-- Base rows -->
  <text x="90" y="52" text-anchor="middle" fill="#64748b">base rows</text>
  <rect x="30" y="60" width="120" height="24" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="90" y="76" text-anchor="middle" fill="#1e293b">Alice · 10 · 90k</text>
  <rect x="30" y="88" width="120" height="24" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="90" y="104" text-anchor="middle" fill="#1e293b">Carol · 10 · 80k</text>
  <rect x="30" y="116" width="120" height="24" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="90" y="132" text-anchor="middle" fill="#1e293b">Bob · 10 · 70k</text>
  <rect x="30" y="160" width="120" height="24" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="90" y="176" text-anchor="middle" fill="#1e293b">Dave · 20 · 60k</text>
  <rect x="30" y="188" width="120" height="24" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="90" y="204" text-anchor="middle" fill="#1e293b">Eve · 20 · 60k</text>
  <rect x="30" y="216" width="120" height="24" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="90" y="232" text-anchor="middle" fill="#1e293b">Frank · 20 · 50k</text>

  <!-- Window branch -->
  <line x1="155" y1="100" x2="235" y2="100" stroke="#475569" marker-end="url(#arr)"/>
  <text x="500" y="52" text-anchor="middle" fill="#64748b">AVG(salary) OVER (PARTITION BY dept_id) — 6 rows out</text>
  <rect x="240" y="60" width="200" height="24" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="340" y="76" text-anchor="middle" fill="#1e293b">Alice · 90k · avg 80k</text>
  <rect x="240" y="88" width="200" height="24" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="340" y="104" text-anchor="middle" fill="#1e293b">Carol · 80k · avg 80k</text>
  <rect x="240" y="116" width="200" height="24" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="340" y="132" text-anchor="middle" fill="#1e293b">Bob · 70k · avg 80k</text>
  <rect x="240" y="160" width="200" height="24" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="340" y="176" text-anchor="middle" fill="#1e293b">Dave · 60k · avg 56.7k</text>
  <rect x="240" y="188" width="200" height="24" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="340" y="204" text-anchor="middle" fill="#1e293b">Eve · 60k · avg 56.7k</text>
  <rect x="240" y="216" width="200" height="24" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="340" y="232" text-anchor="middle" fill="#1e293b">Frank · 50k · avg 56.7k</text>

  <!-- GROUP BY branch -->
  <line x1="440" y1="150" x2="520" y2="150" stroke="#475569" marker-end="url(#arr)"/>
  <text x="580" y="284" text-anchor="middle" fill="#64748b">GROUP BY dept_id — 2 rows out</text>
  <rect x="500" y="116" width="120" height="26" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="560" y="133" text-anchor="middle" fill="#1e293b">dept 10 · avg 80k</text>
  <rect x="500" y="160" width="120" height="26" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="560" y="177" text-anchor="middle" fill="#1e293b">dept 20 · avg 56.7k</text>
  <text x="320" y="310" text-anchor="middle" fill="#b91c1c">Same partitions, same AVG — window broadcasts it back; GROUP BY folds it down.</text>
</svg>
```

## 6. Variations & Trade-offs

| Dimension | Window function | `GROUP BY` aggregate |
|-----------|-----------------|----------------------|
| Rows returned | One per input row (kept) | One per group (collapsed) |
| Detail + summary together | Yes, in one query | No — needs a self-join back |
| Where the group key goes | `PARTITION BY` | `GROUP BY` |
| Filter on the result | Not in `WHERE`; wrap in subquery | `HAVING` filters groups directly |
| Running / ordered aggregates | Yes, via `ORDER BY` in `OVER` | No inherent ordering |
| Typical cost | Sort per partition | Hash or sort aggregate |

Dialect notes: window functions are standard SQL and supported by **PostgreSQL** (since 8.4), **MySQL 8.0+**, **SQL Server**, **Oracle**, and **SQLite 3.25+**. MySQL 5.7 and earlier have *no* window functions — you emulate them with user variables or self-joins, which is error-prone. `FILTER (WHERE …)` on an aggregate window is PostgreSQL/SQLite; MySQL uses `CASE` inside the aggregate instead.

Trade-off: when you only need the summary and don't care about detail rows, `GROUP BY` is leaner (no need to carry every row through the sort). When you need both, one windowed query beats a `GROUP BY` + join both in clarity and usually in cost.

## 7. Performance Notes

- **Sorting dominates.** Each distinct window definition may require a sort of the partitions. Multiple functions that share one `OVER (...)` are computed in a single pass — reuse a `WINDOW w AS (...)` clause so the planner sorts once.
- **Index-ordered input avoids the sort.** A B-tree on `(dept_id, salary DESC)` can feed `PARTITION BY dept_id ORDER BY salary DESC` in order, letting the engine skip the explicit `Sort` node. Check `EXPLAIN` for a `Sort` above the scan — if present and hot, add a matching index.
- **`WHERE` filters before the window.** Push every possible predicate into `WHERE` so the window operates on fewer rows. Filtering on the window *result* (e.g. `rn = 1`) must happen in an outer query and processes all rows first — unavoidable, but keep the inner set small.
- **`work_mem` / sort spills.** Large partitions that exceed the sort memory spill to disk (`external merge Disk` in PostgreSQL `EXPLAIN ANALYZE`). Raising `work_mem` for the session can turn a disk sort into an in-memory one.
- **Cardinality intuition.** A window adds roughly the cost of one sort of N rows (`~N log N`) on top of the base scan; it does not reduce row count, so downstream `LIMIT` still sees all rows until after the window runs.

## 8. Common Mistakes

1. ⚠️ **Filtering on a window function in `WHERE`.** `WHERE ROW_NUMBER() OVER (...) = 1` fails — windows run after `WHERE`. **Fix:** compute it in a subquery/CTE and filter the outer query.
2. ⚠️ **Expecting `GROUP BY` to keep detail rows.** Mixing a bare column with an aggregate under `GROUP BY` is an error (or picks an arbitrary row in MySQL's loose mode). **Fix:** use `AVG(...) OVER (PARTITION BY ...)` when you need per-row detail plus the group value.
3. ⚠️ **Forgetting `ORDER BY` inside `OVER` for running totals.** `SUM(x) OVER (PARTITION BY g)` gives the *whole-partition* total on every row, not a running one. **Fix:** add `ORDER BY` inside the `OVER`.
4. ⚠️ **Assuming the outer `ORDER BY` sets the window order.** The query's final `ORDER BY` does not define the window; only `ORDER BY` *inside* `OVER` does. They are independent.
5. ⚠️ **`PARTITION BY` vs `GROUP BY` confusion.** Writing `GROUP BY` alongside a window when you meant to partition collapses rows unexpectedly. **Fix:** partition inside `OVER`; drop the `GROUP BY`.
6. ⚠️ **`COUNT(*) OVER ()` to get total rows, then filtering.** The `OVER ()` count reflects rows *after* `WHERE` but *before* `LIMIT` — fine for "total matches," surprising if you expected the pre-filter count.
7. ⚠️ **Nesting window functions.** You cannot call a window function inside another window function's arguments. **Fix:** layer them across two query levels (CTE then outer).

## 9. Interview Questions

**Q: What is a window function and how does it differ from a GROUP BY aggregate?**
A: A window function computes a value over a set of rows related to the current row and returns one value per input row, keeping all rows. A GROUP BY aggregate collapses each group into a single summary row. Same math (SUM, AVG, COUNT), different row cardinality: windows preserve detail, GROUP BY discards it.

**Q: What does the OVER clause do, and what does an empty OVER () mean?**
A: OVER defines the window — which rows the function sees for the current row — via PARTITION BY, ORDER BY, and an optional frame. An empty OVER () treats the entire result set (after WHERE/GROUP BY) as one window, so e.g. SUM(x) OVER () is the grand total attached to every row.

**Q: What is the difference between PARTITION BY and GROUP BY?**
A: Both split rows by key. GROUP BY then collapses each group to one row; PARTITION BY keeps every row and computes the function independently within each partition. PARTITION BY is the window-world analogue of GROUP BY, minus the collapsing.

**Q: Where do window functions sit in SQL's logical evaluation order?**
A: After FROM, WHERE, GROUP BY, and HAVING, but before SELECT DISTINCT, the final ORDER BY, and LIMIT/OFFSET. So they see post-filter, post-aggregation rows, but their output is available only to the outer ORDER BY and LIMIT — not to WHERE.

**Q: Why can't you use a window function directly in a WHERE clause?**
A: Because WHERE is evaluated before window functions. The window result doesn't exist yet at WHERE time. To filter on it, put the window in a subquery or CTE and apply the predicate in the enclosing query.

**Q: How do you write a running total, and what makes SUM cumulative rather than total?**
A: Add ORDER BY inside OVER: SUM(x) OVER (PARTITION BY g ORDER BY t). An ordered window defaults to the frame "unbounded preceding to current row," so the sum accumulates. Without ORDER BY, the frame is the whole partition and every row gets the same total.

**Q: How would you compute each row's percentage of its group total in a single query?**
A: Divide the row value by a partitioned window sum: 100.0 * salary / SUM(salary) OVER (PARTITION BY dept_id). One pass, no self-join, and every detail row is retained.

**Q: Can multiple window functions share one window definition, and why would you?**
A: Yes — define it once with a named WINDOW w AS (...) clause and reference OVER w. It avoids repeating and mis-typing the definition and lets the planner do a single sort/pass for all functions on that window instead of one per function.

**Q: What does EXPLAIN typically show for a window query, and when can you eliminate the sort?**
A: A WindowAgg (Postgres) or Window operator, usually fed by a Sort that orders rows by the partition and order keys. If a B-tree index already delivers rows in that exact order, the planner can skip the Sort and stream directly into the window — a big win on large partitions.

**Q: A window query is spilling to disk and slow. How do you diagnose and fix it?**
A: EXPLAIN ANALYZE showing "external merge Disk" on the Sort means the partition sort exceeded work_mem. Fixes: raise work_mem for the session, add an index matching the PARTITION BY/ORDER BY to avoid the sort entirely, or push more filtering into WHERE so fewer rows reach the window.

**Q: You need the department average on every employee row. Compare the window approach with a GROUP BY plus join.**
A: Window: SELECT name, AVG(salary) OVER (PARTITION BY dept_id) — one query, one sort, keeps rows. GROUP BY+join: aggregate to a per-dept table then join back on dept_id — more code, an extra join, and easy to get the join grain wrong. The window is clearer and usually cheaper; GROUP BY wins only if you don't need detail rows at all.

**Q: Does COUNT(*) OVER () give the number of rows before or after WHERE and LIMIT?**
A: After WHERE (and GROUP BY/HAVING) but before LIMIT. So it reports the number of rows that matched the filters, which is exactly what you want for a "total matching records" column alongside a paginated result — LIMIT hasn't cut anything yet when the window runs.

## 10. Practice

- [ ] Write a query returning each employee, their salary, and the difference from their department's average salary, keeping all rows.
- [ ] Produce a running total of daily revenue ordered by date, and confirm removing the inner ORDER BY turns it into a flat grand total.
- [ ] Add a column showing each order's percentage of its customer's lifetime spend using a partitioned window SUM.
- [ ] Attempt to filter WHERE SUM(x) OVER () > 100, observe the error, then rewrite it correctly with a CTE.
- [ ] Define a named WINDOW clause and reuse it for AVG, MAX, and COUNT; inspect EXPLAIN to confirm a single sort.

## 11. Cheat Sheet

> [!TIP]
> **Window functions** = per-row calc over a related set, *rows kept*. Shape: `fn(args) OVER (PARTITION BY … ORDER BY … [frame])`. `OVER ()` = whole result as one window (grand total). `PARTITION BY` = GROUP BY that keeps rows. `ORDER BY` **inside** OVER → running/cumulative (default frame = start-of-partition→current row); omit it → whole-partition value on every row. Evaluation: **after** WHERE/GROUP BY/HAVING, **before** DISTINCT/ORDER BY/LIMIT → so **no windows in WHERE** (wrap in a CTE and filter outside). Reuse one `WINDOW w AS (…)` for many functions → one sort. Speed: index on `(partition_keys, order_keys)` removes the Sort; raise `work_mem` if it spills. Ranking + frames → see topic 14.

**References:** PostgreSQL Docs — "Window Functions Tutorial" & "Window Function Calls"; MySQL 8.0 Reference — "Window Functions"; Use The Index, Luke — "Window Functions"; SQLite — "Window Functions"; Modern SQL (Markus Winand) — "Window Functions"

---
*SQL Handbook — topic 13.*
