# 10 · Subqueries: Scalar, Correlated, IN/EXISTS

> **In one line:** A query nested inside another — as a single value, a virtual table, or a per-row existence test — that the optimizer often rewrites into a join.

---

## 1. Overview

A **subquery** is a `SELECT` wrapped in parentheses and embedded inside another statement. Depending on *where* it sits and *what* it returns, it plays one of three roles: a **scalar** value (one row, one column) usable anywhere an expression is; a **derived table** in `FROM` that behaves like a temporary relation; or a **predicate subquery** in `WHERE`/`HAVING` (`IN`, `EXISTS`, `ANY`, `ALL`) that filters the outer rows.

The distinction that dominates performance is **uncorrelated vs correlated**. An uncorrelated subquery references only its own tables, so it can be evaluated once. A **correlated** subquery references a column from the outer query, so conceptually it re-executes *for every outer row* — an O(outer × inner) trap unless the planner rewrites it.

You reach for subqueries to express "filter by a computed set", "compare against an aggregate", or "does a related row exist?" — cases where a plain join would either duplicate rows or be awkward to phrase. In practice, modern optimizers (PostgreSQL, MySQL 8+, SQL Server) **flatten** most subqueries into semi-joins, anti-joins, or plain joins, so the readable form and the fast form usually converge. The skill is knowing when they *don't*.

## 2. Core Concepts

- **Scalar subquery** — returns exactly one row and one column; usable in `SELECT`, `WHERE`, `SET`. Returns `NULL` if it matches zero rows; **errors** if it returns more than one row.
- **Derived table** — a subquery in `FROM`, aliased, materialized or inlined as a virtual relation. Must have an alias in most dialects.
- **`IN (subquery)`** — a **semi-join**: keep an outer row if its value appears in the subquery's result set.
- **`EXISTS (subquery)`** — also a semi-join, but tests *presence of any row*, not a value; the subquery's `SELECT` list is irrelevant (`SELECT 1`).
- **`NOT IN` / `NOT EXISTS`** — **anti-joins**: keep outer rows with no match. `NOT IN` is dangerous with `NULL` (see below).
- **Correlated subquery** — references an outer column, logically re-runs per outer row; cost scales with outer cardinality unless flattened.
- **Subquery flattening / decorrelation** — the optimizer rewrites `IN`/`EXISTS`/correlated forms into join operators (**hash semi-join**, **nested-loop anti-join**) so they run once, set-based.
- **Three-valued logic** — `x IN (1, NULL)` is `TRUE` or `UNKNOWN`, never `FALSE`; this poisons `NOT IN`.

## 3. Syntax & Examples

```sql
-- (a) Scalar subquery: compare each salary to the company average
SELECT name, salary
FROM   employees
WHERE  salary > (SELECT AVG(salary) FROM employees);

-- (b) Scalar in SELECT list: attach the department name per row
SELECT e.name,
       (SELECT d.name FROM departments d WHERE d.id = e.dept_id) AS dept
FROM   employees e;

-- (c) Derived table in FROM: aggregate then join back
SELECT d.name, t.headcount
FROM   departments d
JOIN  (SELECT dept_id, COUNT(*) AS headcount
       FROM   employees
       GROUP  BY dept_id) t  ON t.dept_id = d.id;

-- (d) IN: employees in departments located in Berlin
SELECT name FROM employees
WHERE  dept_id IN (SELECT id FROM departments WHERE city = 'Berlin');

-- (e) EXISTS (correlated): departments that have at least one employee
SELECT d.name FROM departments d
WHERE  EXISTS (SELECT 1 FROM employees e WHERE e.dept_id = d.id);

-- (f) NOT EXISTS (anti-join): departments with no employees
SELECT d.name FROM departments d
WHERE  NOT EXISTS (SELECT 1 FROM employees e WHERE e.dept_id = d.id);

-- (g) Correlated scalar: each employee vs their own department's average
SELECT e.name, e.salary
FROM   employees e
WHERE  e.salary > (SELECT AVG(e2.salary)
                   FROM   employees e2
                   WHERE  e2.dept_id = e.dept_id);
```

## 4. Sample Data & Results

**`employees`**

| id | name    | dept_id | salary |
|----|---------|---------|--------|
| 1  | Ada     | 10      | 9000   |
| 2  | Björn   | 10      | 7000   |
| 3  | Chen    | 20      | 8000   |
| 4  | Dara    | 20      | 6000   |
| 5  | Emil    | NULL    | 5000   |

**`departments`**

| id | name        | city   |
|----|-------------|--------|
| 10 | Platform    | Berlin |
| 20 | Data        | Oslo   |
| 30 | Research    | Berlin |

Query (g) — each employee earning above *their department's* average:

```sql
SELECT e.name, e.salary
FROM   employees e
WHERE  e.salary > (SELECT AVG(e2.salary) FROM employees e2 WHERE e2.dept_id = e.dept_id);
```

Result — dept 10 avg = 8000, dept 20 avg = 7000:

| name | salary |
|------|--------|
| Ada  | 9000   |
| Chen | 8000   |

Query (f) — departments with no employees returns `Research` (dept 30 has no rows).

## 5. Under the Hood

Logically a correlated subquery is a nested loop: for each outer row, bind the outer columns and run the inner query. Physically the optimizer prefers **not** to do that. It **decorrelates** the subquery into a set-based join — an `IN`/`EXISTS` becomes a **semi-join**, `NOT EXISTS` an **anti-join** — then picks a physical algorithm (hash, merge, or nested loop) by cardinality, exactly as for a normal join.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="180" y="24" text-anchor="middle" fill="#1e293b" font-weight="bold">Naive: correlated nested loop</text>
  <rect x="60" y="44" width="240" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="69" text-anchor="middle" fill="#1e293b">for each outer row (N rows)</text>
  <rect x="90" y="104" width="180" height="36" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="127" text-anchor="middle" fill="#1e293b">re-run inner query</text>
  <line x1="180" y1="84" x2="180" y2="104" stroke="#475569" marker-end="url(#ar)"/>
  <text x="180" y="168" text-anchor="middle" fill="#b91c1c" font-weight="bold">cost ≈ N × inner</text>

  <line x1="360" y1="60" x2="360" y2="250" stroke="#64748b" stroke-dasharray="4 4"/>

  <text x="540" y="24" text-anchor="middle" fill="#1e293b" font-weight="bold">Optimized: hash semi-join</text>
  <rect x="420" y="44" width="110" height="36" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="475" y="67" text-anchor="middle" fill="#1e293b">outer scan</text>
  <rect x="560" y="44" width="120" height="36" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="620" y="67" text-anchor="middle" fill="#1e293b">build hash</text>
  <rect x="470" y="120" width="160" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="550" y="145" text-anchor="middle" fill="#1e293b">SEMI JOIN (probe)</text>
  <line x1="475" y1="80" x2="530" y2="120" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="620" y1="80" x2="575" y2="120" stroke="#475569" marker-end="url(#ar)"/>
  <text x="550" y="192" text-anchor="middle" fill="#059669" font-weight="bold">cost ≈ N + inner (one pass)</text>
  <text x="550" y="230" text-anchor="middle" fill="#64748b">stops at first match per outer row</text>
</svg>
```

**Semi-join** (`EXISTS`/`IN`) short-circuits: it emits the outer row on the *first* inner match and never de-duplicates the inner side — that is why `EXISTS` is often as cheap as `IN` and sometimes cheaper. Check the plan for `Hash Semi Join` / `Hash Anti Join` (PostgreSQL) or `<subquery>` / `FirstMatch` semi-join strategy (MySQL 8 `EXPLAIN FORMAT=TREE`). If you instead see a `Nested Loop` with the inner subquery re-executed per row, decorrelation failed and you should look for a blocker (a `LIMIT`, volatile function, or `LEFT JOIN` in the subquery).

## 6. Variations & Trade-offs

| Form | Semantics | NULL behavior | Best when | Typical plan |
|------|-----------|---------------|-----------|--------------|
| `IN (subquery)` | value ∈ set | inner NULLs ignored for match | small/medium inner set | hash semi-join |
| `EXISTS` (correlated) | any matching row | NULL-safe (tests rows, not values) | inner has index on join col; huge inner | semi-join, short-circuits |
| `INNER JOIN` | match + **combine columns** | — | you need inner columns too | hash/merge join |
| `NOT IN` | value ∉ set | **breaks if any inner NULL** | inner guaranteed NOT NULL | anti-join (fragile) |
| `NOT EXISTS` | no matching row | NULL-safe | "find the missing" (anti-join) | hash anti-join |
| `LEFT JOIN ... IS NULL` | no matching row | NULL-safe | pre-8.0 MySQL anti-join | left join + filter |

In modern engines `IN` and `EXISTS` usually produce **the same plan** — the old "always use EXISTS" advice is largely obsolete. Prefer a **JOIN** only when you need columns from the inner table; if you just need to *filter*, a semi-join (`IN`/`EXISTS`) avoids the row-multiplication a join causes when the inner side has duplicates. Reserve **`NOT EXISTS`** as the default anti-join because it is NULL-safe.

## 7. Performance Notes

- **Index the correlated join column.** `EXISTS (SELECT 1 FROM e WHERE e.dept_id = d.id)` wants an index on `employees(dept_id)`; without it each probe is a scan.
- **`EXISTS` beats `COUNT(*) > 0`.** `WHERE (SELECT COUNT(*) FROM ...) > 0` counts *all* matches; `EXISTS` stops at the first. Never write `COUNT(*) > 0` for existence.
- **Scalar subquery in `SELECT` = per-row lookup.** Emitting `(SELECT d.name FROM departments d WHERE d.id = e.dept_id)` for a million employees is a million index probes; a `JOIN` does one hash build. Rewrite hot scalar subqueries as joins.
- **Derived tables may materialize.** MySQL historically wrote a derived table to a temp table (no index); 8.0 added **derived-table merging** and **derived condition pushdown**. Watch for `DERIVED` in `EXPLAIN`.
- **Watch the anti-join blowup.** `NOT IN` over a large inner set with no NULL guarantee can force a slow plan; `NOT EXISTS` gives a clean hash anti-join.
- **`LIMIT`/`DISTINCT`/aggregates inside a subquery can block flattening** — the planner keeps it as a separate subplan. Read the plan rather than assuming.

## 8. Common Mistakes

1. ⚠️ **`NOT IN` with a NULL in the subquery** returns **zero rows** silently. `x NOT IN (1, NULL)` evaluates to `UNKNOWN`, never `TRUE`. Fix: use `NOT EXISTS`, or add `WHERE col IS NOT NULL` to the subquery.
2. ⚠️ **Scalar subquery returning >1 row** throws a runtime error ("more than one row returned by a subquery used as an expression"). Fix: add a key predicate, `LIMIT 1`, or an aggregate.
3. ⚠️ **`COUNT(*) > 0` for existence** — scans all matches. Fix: `EXISTS`.
4. ⚠️ **`SELECT *` inside `EXISTS`** wastes nothing functionally but signals confusion; the projection is ignored. Use `SELECT 1` for clarity.
5. ⚠️ **Correlated scalar subquery in `SELECT` on a big table** — quietly O(rows). Fix: convert to a `JOIN` or a window function.
6. ⚠️ **Forgetting the derived-table alias** — `FROM (SELECT ...)` without `AS t` errors in PostgreSQL/MySQL. Always alias.
7. ⚠️ **Assuming `IN` de-duplicates the outer** — it filters, it doesn't distinct the outer rows; duplicates in the *outer* table stay.
8. ⚠️ **Correlated column typo resolves to the outer table** — an unqualified name inside the subquery can silently bind to the outer scope, turning a filter into a tautology. Always alias both levels.

## 9. Interview Questions

**Q: What is the difference between a correlated and an uncorrelated subquery?**
A: An uncorrelated subquery references only its own tables, so it can be evaluated once and reused. A correlated subquery references a column from the outer query, so logically it re-executes per outer row — cost scales with outer cardinality unless the optimizer decorrelates it into a join.

**Q: Are `IN` and `EXISTS` interchangeable? When would you pick one?**
A: Semantically both express a semi-join and modern optimizers (PostgreSQL, MySQL 8+) usually produce the same plan. `EXISTS` is correlated and NULL-safe and short-circuits on the first match, so it shines when the inner side is large and indexed on the join column. `IN` reads naturally for a small literal-ish set. Prefer `EXISTS`/`NOT EXISTS` when NULLs are possible.

**Q: Why can `NOT IN` return no rows unexpectedly?**
A: Three-valued logic. If the subquery returns any `NULL`, every `x NOT IN (...)` comparison becomes `UNKNOWN` (because `x <> NULL` is unknown), which is not `TRUE`, so no outer row qualifies. Fix with `NOT EXISTS` or by excluding NULLs from the subquery.

**Q: When must you use a JOIN instead of `IN`/`EXISTS`?**
A: When you need **columns** from the inner table in the output. `IN`/`EXISTS` only filter the outer rows; they can't project inner columns. The trade-off: a join multiplies outer rows when the inner side has duplicate matches, whereas a semi-join emits each outer row at most once.

**Q: What does "subquery flattening" or "decorrelation" mean?**
A: The optimizer rewrites a nested/correlated subquery into an equivalent join operator — a semi-join for `IN`/`EXISTS`, an anti-join for `NOT EXISTS` — so it executes once, set-based, instead of per outer row. It lets the planner choose hash/merge/nested-loop by cardinality.

**Q: A scalar subquery in the SELECT list is slow on a 5M-row table. Why, and how do you fix it?**
A: It's evaluated once per output row — effectively 5M index probes. Rewrite it as a `LEFT JOIN` to the lookup table (one hash build/scan) or, for a within-group aggregate, as a window function. Both turn per-row work into one set-based pass.

**Q: How do you write an anti-join, and which form is safest?**
A: "Rows in A with no match in B." Options: `NOT EXISTS` (NULL-safe, clean hash anti-join — the default), `LEFT JOIN B ... WHERE B.key IS NULL` (works everywhere, verbose), or `NOT IN` (avoid unless the inner column is guaranteed `NOT NULL`).

**Q: What's the difference between a derived table and a scalar subquery?**
A: A derived table sits in `FROM`, returns a full relation (many rows/columns), and is aliased and joined like a table. A scalar subquery returns exactly one row and one column and is used wherever an expression is allowed; it errors if it yields more than one row.

**Q: (Senior) You expected a semi-join but EXPLAIN shows a nested loop re-running the subquery per row. What blocks decorrelation?**
A: Common blockers: a `LIMIT`/`OFFSET` inside the subquery, a volatile or non-deterministic function, an outer join or aggregate that changes NULL semantics, or `ROWNUM`/window constructs. The planner keeps such subqueries as an independent subplan. Refactor into an explicit join or a lateral/`LATERAL` derived table so the intent is unambiguous.

**Q: (Senior) How does a hash semi-join differ from a hash join in execution?**
A: A hash semi-join builds the hash on the inner side and, when probing, emits the outer row on the **first** match and stops probing that key — it never outputs duplicates and never projects inner columns. A plain hash join emits one output row per matching pair, so it can multiply rows and carries inner columns.

**Q: (Senior) Why can `LEFT JOIN ... IS NULL` and `NOT IN` produce different results on the same data?**
A: NULL handling. `LEFT JOIN ... IS NULL` and `NOT EXISTS` treat "no matching row" correctly, but `NOT IN` folds subquery NULLs into `UNKNOWN` and drops all rows. On NULL-free data they agree; with NULLs they diverge, which is why `NOT IN` is a classic correctness bug.

**Q: (Senior) When is a correlated subquery actually the better plan than a join?**
A: When the outer set is tiny and the inner has a selective index, a nested-loop with an index probe (the correlated form) can beat building a hash table over a large inner relation. `EXISTS` with an index on the join column and a small outer driver is the textbook case.

## 10. Practice

- [ ] Rewrite a correlated `EXISTS` query as an `INNER JOIN` and confirm the row counts match (watch for duplicate multiplication).
- [ ] Construct a dataset where `NOT IN` returns zero rows but `NOT EXISTS` returns the correct set, then explain why.
- [ ] Replace a scalar subquery in the `SELECT` list with a `LEFT JOIN` and compare `EXPLAIN ANALYZE` timings.
- [ ] Use a derived table to compute per-department averages, join it back, and check for `DERIVED`/materialization in `EXPLAIN`.
- [ ] Write both `IN` and `EXISTS` versions of one filter and verify the optimizer produces the same plan.

## 11. Cheat Sheet

> [!TIP]
> **Subqueries in one screen.**
> - **Scalar** (1×1): usable as an expression; errors on >1 row; `NULL` on 0 rows.
> - **Derived table** (`FROM (...) AS t`): virtual relation; must be aliased; may materialize.
> - **`IN` / `EXISTS`** = semi-join (keep outer if a match exists). Modern planners make them equivalent; `EXISTS` is NULL-safe and short-circuits.
> - **`NOT EXISTS`** = anti-join, NULL-safe → **default** for "find the missing". **`NOT IN` breaks on NULLs.**
> - **JOIN** only when you need inner **columns**; it can multiply rows.
> - Index the correlated join column. Rewrite hot `SELECT`-list scalar subqueries as joins. Never use `COUNT(*)>0` for existence.

**References:** PostgreSQL docs — "Subquery Expressions" & "Row and Array Comparisons"; MySQL Reference Manual — "Subqueries" & "Optimizing Subqueries, Derived Tables, and Views"; Use The Index, Luke — semi-join/anti-join chapters; LeetCode Database editorials

---
*SQL Handbook — topic 10.*
