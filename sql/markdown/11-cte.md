# 11 · Common Table Expressions (WITH)

> **In one line:** Named, query-scoped result sets defined with `WITH` that make complex SQL readable and modular — usually inlined by the optimizer, but historically an optimization fence.

---

## 1. Overview

A **Common Table Expression (CTE)** is a temporary, named result set defined in a `WITH` clause and referenced by name in the statement that follows. Think of it as a query-local view: it exists only for the duration of the single statement, adds no schema object, and can be referenced one or more times.

CTEs solve a *readability* problem. A deeply nested stack of derived tables reads inside-out and repeats logic; a `WITH` chain reads **top-down** like a pipeline of named steps — `staged`, then `filtered`, then `ranked` — each building on the last. For interview whiteboards and production reports alike, that structure is the main win.

The subtlety is execution. A CTE is *logically* a virtual table, but whether it is **inlined** (folded into the main query and optimized as a whole) or **materialized** (executed once into a temporary buffer that the rest of the query reads) depends on the engine and, in newer versions, on explicit hints. That single decision — the **optimization fence** — is the difference between a CTE that is free and one that quietly blocks predicate pushdown.

## 2. Core Concepts

- **`WITH name AS (SELECT ...)`** — defines a CTE; the following statement (or later CTEs) can reference `name`.
- **Query scope** — a CTE is visible only within the single statement that contains it; it vanishes afterward.
- **Multiple CTEs** — chain them comma-separated: `WITH a AS (...), b AS (... FROM a ...) SELECT ... FROM b`. Later CTEs may reference earlier ones (top-to-bottom).
- **Referenced multiple times** — one CTE name can appear several times in the main query; materialization can then avoid recomputation.
- **Inlining** — the planner substitutes the CTE's definition into the outer query and optimizes the combined tree (predicate pushdown, join reordering).
- **Materialization** — the CTE is evaluated once into a temporary result; the outer query scans that result. This is the **optimization fence**.
- **`MATERIALIZED` / `NOT MATERIALIZED`** — PostgreSQL 12+ hints that force or forbid materialization.
- **Recursive CTEs** — `WITH RECURSIVE` for hierarchies and series (its own topic — see *Recursive CTEs*).

## 3. Syntax & Examples

```sql
-- (a) Single CTE: name a step, then use it
WITH high_earners AS (
    SELECT id, name, dept_id, salary
    FROM   employees
    WHERE  salary > 8000
)
SELECT dept_id, COUNT(*) AS n
FROM   high_earners
GROUP  BY dept_id;

-- (b) Multiple, chained CTEs: a readable pipeline
WITH dept_avg AS (
    SELECT dept_id, AVG(salary) AS avg_sal
    FROM   employees
    GROUP  BY dept_id
),
above AS (
    SELECT e.name, e.salary, e.dept_id
    FROM   employees e
    JOIN   dept_avg a ON a.dept_id = e.dept_id
    WHERE  e.salary > a.avg_sal
)
SELECT dept_id, COUNT(*) AS above_avg
FROM   above
GROUP  BY dept_id;

-- (c) Reference a CTE twice (self-comparison without repeating the query)
WITH monthly AS (
    SELECT month, SUM(revenue) AS rev
    FROM   sales GROUP BY month
)
SELECT  cur.month, cur.rev, cur.rev - prev.rev AS mom_change
FROM    monthly cur
LEFT JOIN monthly prev ON prev.month = cur.month - 1;

-- (d) PostgreSQL 12+: control the fence explicitly
WITH cheap AS NOT MATERIALIZED (        -- allow inlining + pushdown
    SELECT * FROM orders WHERE region = 'EU'
)
SELECT * FROM cheap WHERE amount > 1000;

WITH heavy AS MATERIALIZED (            -- compute once, reuse many times
    SELECT customer_id, COUNT(*) c FROM orders GROUP BY customer_id
)
SELECT * FROM heavy a JOIN heavy b ON b.c = a.c + 1;
```

## 4. Sample Data & Results

**`employees`**

| id | name  | dept_id | salary |
|----|-------|---------|--------|
| 1  | Ada   | 10      | 9000   |
| 2  | Björn | 10      | 7000   |
| 3  | Chen  | 20      | 8000   |
| 4  | Dara  | 20      | 6000   |
| 5  | Emil  | 20      | 9500   |

Query (b) — count employees above **their department's** average:

```sql
WITH dept_avg AS (
    SELECT dept_id, AVG(salary) AS avg_sal FROM employees GROUP BY dept_id
),
above AS (
    SELECT e.name, e.dept_id FROM employees e
    JOIN dept_avg a ON a.dept_id = e.dept_id
    WHERE e.salary > a.avg_sal
)
SELECT dept_id, COUNT(*) AS above_avg FROM above GROUP BY dept_id;
```

Averages: dept 10 = 8000, dept 20 ≈ 7833. Rows above: Ada (9000>8000), Chen (8000>7833), Emil (9500>7833):

| dept_id | above_avg |
|---------|-----------|
| 10      | 1         |
| 20      | 2         |

## 5. Under the Hood

A CTE lands in the plan one of two ways. **Inlined**, its definition is merged into the outer query so the planner can push predicates *into* it, reorder joins, and pick indexes across the boundary — the CTE effectively disappears as a separate step. **Materialized**, it runs once, its output is stored in a work buffer (a `CTE Scan` node in PostgreSQL), and the outer query reads that buffer — no predicate crosses the fence.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="180" y="22" text-anchor="middle" fill="#1e293b" font-weight="bold">Inlined (NOT MATERIALIZED)</text>
  <rect x="70" y="40" width="220" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="62" text-anchor="middle" fill="#1e293b">outer filter amount &gt; 1000</text>
  <line x1="180" y1="74" x2="180" y2="100" stroke="#475569" marker-end="url(#a2)"/>
  <text x="315" y="92" text-anchor="middle" fill="#059669" font-size="11">pushed down ↓</text>
  <rect x="70" y="100" width="220" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="180" y="122" text-anchor="middle" fill="#1e293b">CTE body: region='EU'</text>
  <line x1="180" y1="134" x2="180" y2="160" stroke="#475569" marker-end="url(#a2)"/>
  <rect x="70" y="160" width="220" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="182" text-anchor="middle" fill="#1e293b">Index Scan (both filters)</text>
  <text x="180" y="222" text-anchor="middle" fill="#059669" font-weight="bold">one fused, optimized plan</text>

  <line x1="360" y1="30" x2="360" y2="280" stroke="#64748b" stroke-dasharray="4 4"/>

  <text x="540" y="22" text-anchor="middle" fill="#1e293b" font-weight="bold">Materialized (the fence)</text>
  <rect x="430" y="40" width="220" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="540" y="62" text-anchor="middle" fill="#1e293b">CTE body runs ONCE</text>
  <line x1="540" y1="74" x2="540" y2="100" stroke="#475569" marker-end="url(#a2)"/>
  <rect x="430" y="100" width="220" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="540" y="122" text-anchor="middle" fill="#1e293b">temp buffer (CTE Scan)</text>
  <rect x="562" y="82" width="120" height="20" rx="6" fill="#fff" stroke="#b91c1c"/>
  <text x="622" y="97" text-anchor="middle" fill="#b91c1c" font-size="11">no pushdown</text>
  <line x1="540" y1="134" x2="540" y2="160" stroke="#475569" marker-end="url(#a2)"/>
  <rect x="430" y="160" width="220" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="540" y="182" text-anchor="middle" fill="#1e293b">outer filter on full buffer</text>
  <text x="540" y="222" text-anchor="middle" fill="#d97706" font-weight="bold">reusable once; scans everything</text>
</svg>
```

**Engine reality:** PostgreSQL ≤ 11 **always materialized** CTEs — a hard optimization fence people exploited to pin a plan. PostgreSQL **12+** inlines a CTE by default *if* it is referenced once, is not recursive, and is side-effect-free; `MATERIALIZED`/`NOT MATERIALIZED` override that. **MySQL 8** treats a CTE like a derived table — it may merge it into the outer query or materialize it, following derived-table rules. **SQL Server** and **Oracle** always inline non-recursive CTEs (no built-in fence). So "a CTE is just a named subquery" is true on modern PostgreSQL 12+/SQL Server, but *not* on PostgreSQL ≤ 11.

## 6. Variations & Trade-offs

| Aspect | CTE (`WITH`) | Subquery / derived table | Temp table (`CREATE TEMP TABLE`) |
|--------|--------------|--------------------------|----------------------------------|
| Scope | single statement | single statement | whole session/transaction |
| Readability | high (top-down pipeline) | low when nested deeply | medium |
| Reuse across statements | no | no | yes |
| Indexable | no | no | **yes** (add indexes, ANALYZE) |
| Optimization | inlined (or fenced) | usually inlined/merged | separate query, has stats |
| Recursion | **yes** (`WITH RECURSIVE`) | no | no (manual loop) |
| Multiple references | one definition, N uses | must repeat the SQL | one table, N uses |

**When to choose which:** reach for a **CTE** to name and sequence steps within one query and to enable recursion. Use a **derived table** for a one-off inline relation where you don't need naming. Promote to a **temp table** when the intermediate is large, reused across *multiple* statements, or benefits from an **index** and fresh statistics that a CTE cannot carry. On PostgreSQL ≤ 11 a materialized CTE *is* a cheap "temp table for one statement".

## 7. Performance Notes

- **A CTE does not create an index.** If the outer query filters or joins the CTE on a key, the planner has no index on the intermediate; a temp table (indexed + analyzed) can win for large intermediates.
- **The fence blocks predicate pushdown.** On PostgreSQL ≤ 11 (or with `MATERIALIZED`), an outer `WHERE` can't push into the CTE body, so it computes the *whole* set then filters. If you want the filter inside, inline it or use `NOT MATERIALIZED`.
- **Materialize a CTE referenced many times** to compute it once — useful for an expensive aggregate self-joined to itself. Referenced *once*, prefer inlining so the planner optimizes end-to-end.
- **MySQL derived-table merging** applies to CTEs: a mergeable CTE is folded in; one with aggregation/`DISTINCT`/`LIMIT` materializes into a temp table with no index (`EXPLAIN` shows `DERIVED`).
- **Read the plan.** Look for `CTE Scan` (PostgreSQL materialized) vs the CTE's operators appearing inline. In MySQL, `<derived N>` and `Materialize` in `EXPLAIN FORMAT=TREE`.
- **CTEs don't inherently speed anything up** — they organize logic. Performance follows from inlining/materialization and indexing on the base tables.

## 8. Common Mistakes

1. ⚠️ **Assuming a CTE is always free/inlined.** On PostgreSQL ≤ 11 it's an optimization fence and a filter won't push in. Fix: upgrade behavior with `NOT MATERIALIZED`, or inline as a subquery.
2. ⚠️ **Expecting a CTE to persist across statements.** It's scoped to the one statement. Fix: use a temp table or view for cross-statement reuse.
3. ⚠️ **Filtering the outer query and hoping it speeds the CTE body** when materialized — it computes everything first. Fix: put the predicate inside the CTE.
4. ⚠️ **Referencing a CTE before it's defined** (forward reference across the comma list). CTEs resolve top-down; define dependencies first.
5. ⚠️ **Joining a huge materialized CTE without an index** and being surprised it's slow — there's no index to have. Fix: temp table with an index, or restructure.
6. ⚠️ **Over-CTE-ing** — ten tiny CTEs where two joins would do; readability can flip into indirection. Balance clarity vs directness.
7. ⚠️ **Assuming `WITH` de-duplicates or caches automatically across a single reference** — a once-referenced inlined CTE may be evaluated as if substituted; don't rely on "runs once" unless materialized.

## 9. Interview Questions

**Q: What is a CTE and how is it different from a subquery?**
A: A CTE is a named result set defined in a `WITH` clause and referenced by name within the same statement. Functionally it's a named subquery: the main difference is readability (top-down naming, reuse of one name multiple times) and that CTEs support recursion. On some engines it also historically differed in optimization (the fence).

**Q: What is the CTE "optimization fence"?**
A: On engines that materialize CTEs (PostgreSQL ≤ 11, or PostgreSQL 12+ with `MATERIALIZED`), the CTE is computed once into a temp buffer and the optimizer cannot push outer predicates or join conditions into it. That boundary is the fence — it can force a full computation that a filter would otherwise have shrunk.

**Q: How did CTE behavior change in PostgreSQL 12?**
A: Before 12, CTEs were always materialized. From 12, a non-recursive, side-effect-free CTE referenced exactly once is inlined by default (optimized as part of the outer query). `MATERIALIZED` forces the old fence; `NOT MATERIALIZED` forces inlining.

**Q: CTE vs temp table — when do you promote to a temp table?**
A: When the intermediate is large, reused across multiple statements, or benefits from an index and fresh statistics. A CTE lives for one statement and can't be indexed; a temp table persists for the session/transaction, can carry indexes, and gets its own stats — better for big reused intermediates.

**Q: Does using a CTE make a query faster?**
A: Not inherently. It reorganizes logic for readability. Speed comes from whether it's inlined (letting the planner optimize across the boundary) or materialized (compute once, reuse), plus indexing on the base tables. A CTE can even be *slower* if a fence blocks a useful pushdown.

**Q: How do multiple CTEs reference each other?**
A: They're comma-separated and resolved top-to-bottom: a later CTE may reference any earlier one, but not vice versa. This lets you build a pipeline — stage, then filter, then aggregate — each step named.

**Q: Can a CTE be referenced more than once, and why would you materialize it?**
A: Yes — one definition, many references in the main query. Materializing it computes the expensive body once and reuses the buffer, avoiding recomputation when it's referenced several times (e.g., a heavy aggregate self-joined to itself).

**Q: (Senior) How does MySQL 8 optimize a CTE?**
A: It treats the CTE as a derived table. If mergeable it's folded into the outer query (derived-table merging); if it has aggregation, `DISTINCT`, `LIMIT`, or `UNION` it's materialized into an internal temp table with no index. `EXPLAIN` shows `<derived N>` and `Materialize` nodes.

**Q: (Senior) You add `WHERE id = 42` outside a CTE but the query still scans millions of rows. Why?**
A: The CTE is materialized (fence), so the predicate can't push into its body — the CTE computes the full set, then the outer filter runs on the buffer. Fix: inline it (`NOT MATERIALIZED` on PG 12+, or rewrite as a subquery) so the filter reaches the base-table scan and uses the index.

**Q: (Senior) How do you tell from EXPLAIN whether a CTE was inlined or materialized?**
A: In PostgreSQL, a materialized CTE shows a `CTE <name>` subplan plus `CTE Scan` nodes in the outer plan; an inlined one has its operators appear directly in the main plan tree with base-table filters/indexes applied. In MySQL, look for `Materialize`/`<derived N>` versus the CTE's tables appearing merged.

**Q: (Senior) When is the fence actually useful?**
A: To pin a plan: force an expensive selective subquery to run first and small, preventing the optimizer from re-ordering it in a way that recomputes it or mis-estimates cardinality. Pre-12 people used the guaranteed materialization deliberately; today you request it with `MATERIALIZED`.

## 10. Practice

- [ ] Rewrite a triple-nested derived-table query as a chain of named CTEs and compare readability and plans.
- [ ] On PostgreSQL 12+, run the same CTE with `MATERIALIZED` and `NOT MATERIALIZED` and diff `EXPLAIN ANALYZE`.
- [ ] Build a CTE referenced twice, then materialize it, and confirm the body executes once.
- [ ] Convert a large CTE into an indexed temp table and measure a join against it vs the CTE version.
- [ ] Add a selective outer `WHERE` and prove whether the predicate pushed into the CTE body (inlined) or not (fenced).

## 11. Cheat Sheet

> [!TIP]
> **CTEs in one screen.**
> - `WITH name AS (SELECT ...) SELECT ... FROM name` — query-scoped named result; chain many with commas, top-down.
> - Main value = **readability/modularity** and **recursion** (`WITH RECURSIVE`). Not inherently faster.
> - **Inlined** → planner optimizes across the boundary (pushdown, index use). **Materialized** → computed once into a buffer = the **optimization fence** (no pushdown).
> - **PostgreSQL ≤ 11:** always materialized. **PG 12+:** inlined if referenced once; override with `MATERIALIZED` / `NOT MATERIALIZED`. **MySQL 8:** derived-table rules. **SQL Server/Oracle:** always inline non-recursive.
> - CTEs **can't be indexed** and **don't persist** across statements → use a **temp table** for large, reused, indexable intermediates.

**References:** PostgreSQL docs — "WITH Queries (Common Table Expressions)" (esp. MATERIALIZED); MySQL Reference Manual — "WITH (Common Table Expressions)" & "Derived Table Optimization"; Use The Index, Luke; SQL Server docs — "WITH common_table_expression"

---
*SQL Handbook — topic 11.*
