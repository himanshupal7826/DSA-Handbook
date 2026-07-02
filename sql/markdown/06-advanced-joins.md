# 06 · Self-Joins, Anti-Joins & Semi-Joins

> **In one line:** Three join *patterns* — a table joined to itself, "rows with no match", and "rows with at least one match" — that express hierarchy, exclusion, and existence.

---

## 1. Overview

Beyond the five physical join *types* (INNER/LEFT/RIGHT/FULL/CROSS) lie three join *patterns* that dominate interviews and real reporting. A **self-join** joins a table to another copy of itself — the standard way to relate a row to another row in the same table (employee → manager, event → previous event). An **anti-join** returns rows from one table that have **no** matching row in another ("customers who never ordered"). A **semi-join** returns rows that have **at least one** match ("customers who *have* ordered") — without duplicating them the way an inner join would.

The subtlety is that semi- and anti-joins are *patterns*, not keywords: SQL has no `SEMI JOIN` clause. You express them with `EXISTS`/`IN` (semi) and `NOT EXISTS`/`NOT IN`/`LEFT ... IS NULL` (anti). Choosing among these forms is where correctness and performance are won or lost — especially the infamous **`NOT IN` NULL trap**, which can make a query silently return *zero rows*.

Master these and you can express hierarchy traversal, set difference, and existence tests fluently — the vocabulary of almost every non-trivial analytics query.

## 2. Core Concepts

- **Self-join** — a table aliased twice and joined on a relationship between its own rows (e.g. `e.manager_id = m.id`).
- **Semi-join** — keep left rows that have ≥1 match on the right; the right columns are *not* projected and rows are *not* duplicated.
- **Anti-join** — keep left rows that have **zero** matches on the right (set difference).
- **`EXISTS`** — correlated existence test; stops at the first matching row (short-circuits).
- **`IN` (subquery)** — value-membership test; the planner usually rewrites it to a semi-join.
- **`NOT EXISTS`** — the safe, NULL-correct anti-join.
- **`NOT IN` NULL trap** — if the subquery yields *any* NULL, `NOT IN` returns UNKNOWN for every row → **empty result**.
- **`LEFT JOIN ... IS NULL`** — the "outer-join anti-join" idiom; correct but can fan out on non-unique keys.
- **`USING` / `NATURAL JOIN`** — shorthand that joins on same-named columns; convenient but fragile.

## 3. Syntax & Examples

**Self-join** — pair each employee with their manager's name:

```sql
SELECT e.name AS employee, m.name AS manager
FROM employees e
LEFT JOIN employees m ON e.manager_id = m.id;   -- LEFT keeps the CEO (no manager)
```

**Semi-join** — customers who have placed at least one order (each customer once):

```sql
-- EXISTS form (preferred: short-circuits, ignores duplicates naturally)
SELECT c.id, c.name
FROM customers c
WHERE EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);

-- IN form (equivalent for non-NULL keys; planner rewrites to a semi-join)
SELECT c.id, c.name
FROM customers c
WHERE c.id IN (SELECT customer_id FROM orders);
```

**Anti-join** — customers who never ordered, three ways:

```sql
-- (1) NOT EXISTS — correct even if customer_id contains NULLs
SELECT c.id, c.name
FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);

-- (2) LEFT JOIN ... IS NULL — the outer-join anti-join
SELECT c.id, c.name
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.id IS NULL;

-- (3) NOT IN — DANGER: returns ZERO rows if any orders.customer_id is NULL
SELECT c.id, c.name
FROM customers c
WHERE c.id NOT IN (SELECT customer_id FROM orders);   -- ⚠️ NULL trap
```

> [!WARN]
> **The `NOT IN` NULL trap.** If the subquery `(SELECT customer_id FROM orders)` returns even one NULL, then `c.id NOT IN (..., NULL, ...)` evaluates to UNKNOWN (never TRUE) for *every* row — the query returns **nothing**. `NOT EXISTS` does not have this flaw. Either use `NOT EXISTS`, or guard the subquery with `WHERE customer_id IS NOT NULL`.

## 4. Sample Data & Results

**`employees`**

| id | name    | manager_id |
|----|---------|------------|
| 1  | Ada     | NULL       |
| 2  | Grace   | 1          |
| 3  | Lin     | 1          |
| 4  | Raj     | 2          |

Self-join result (`LEFT JOIN` keeps Ada, the CEO):

| employee | manager |
|----------|---------|
| Ada      | NULL    |
| Grace    | Ada     |
| Lin      | Ada     |
| Raj      | Grace   |

**`customers`** = {1 Ada, 2 Grace, 3 Lin}  **`orders.customer_id`** = {1, 1, 2}

| Pattern                        | Result rows        |
|--------------------------------|--------------------|
| Semi-join (has ordered)        | Ada, Grace         |
| Anti-join (never ordered)      | Lin                |
| `NOT IN` if an order has NULL  | **(empty!)**       |

## 5. Under the Hood

A semi-join and an anti-join are single-pass set operations, not row-multiplying joins. The planner exposes them as dedicated nodes — PostgreSQL prints `Hash Semi Join` / `Hash Anti Join`, and it will rewrite `EXISTS`/`IN`/`NOT EXISTS` into these when it's cheaper than a correlated subquery loop.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <style>
    .lbl{fill:#1e293b;font-weight:600}.mut{fill:#64748b}
    .a{fill:#eff6ff;stroke:#2563eb;stroke-width:1.5}
    .b{fill:#ecfdf5;stroke:#059669;stroke-width:1.5}
    .keepL{fill:#2563eb;fill-opacity:0.35}
  </style>

  <!-- SEMI -->
  <g transform="translate(30,30)">
    <text x="90" y="0" text-anchor="middle" class="lbl">SEMI-JOIN — A rows WITH a match</text>
    <clipPath id="cS"><circle cx="70" cy="90" r="50"/></clipPath>
    <circle cx="70" cy="90" r="50" class="a"/>
    <circle cx="115" cy="90" r="50" class="b"/>
    <circle cx="115" cy="90" r="50" class="keepL" clip-path="url(#cS)"/>
    <text x="35" y="95" text-anchor="middle" class="mut">A</text>
    <text x="150" y="95" text-anchor="middle" class="mut">B</text>
    <text x="90" y="170" text-anchor="middle" class="mut">EXISTS / IN — no duplication</text>
  </g>

  <!-- ANTI -->
  <g transform="translate(390,30)">
    <text x="90" y="0" text-anchor="middle" class="lbl">ANTI-JOIN — A rows with NO match</text>
    <clipPath id="cO"><circle cx="70" cy="90" r="50"/></clipPath>
    <path d="M 70 40 A 50 50 0 1 0 70 140 A 50 50 0 1 0 70 40" class="a"/>
    <circle cx="70" cy="90" r="50" class="keepL"/>
    <circle cx="115" cy="90" r="50" fill="#ffffff" fill-opacity="0.85" clip-path="url(#cO)"/>
    <circle cx="70" cy="90" r="50" class="a" fill="none"/>
    <circle cx="115" cy="90" r="50" class="b"/>
    <text x="35" y="95" text-anchor="middle" class="mut">A</text>
    <text x="150" y="95" text-anchor="middle" class="mut">B</text>
    <text x="90" y="170" text-anchor="middle" class="mut">NOT EXISTS / LEFT+IS NULL</text>
  </g>

  <rect x="140" y="245" width="440" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="270" text-anchor="middle" class="lbl">NOT IN + a NULL in the subquery → empty result (avoid)</text>
</svg>
```

Why `EXISTS` is efficient: it **short-circuits** — the correlated subquery can stop scanning the moment it finds one matching row, so an index on `orders.customer_id` turns each probe into an index seek. `NOT EXISTS` scans until it proves *no* match exists, but still benefits from the same index.

The `LEFT JOIN ... IS NULL` anti-join works differently: it materializes *all* matches (fanning out on duplicates), then discards everything that matched. On a non-unique right key it can be slower and, if you `COUNT(*)`, wrong — `NOT EXISTS` sidesteps both issues.

## 6. Variations & Trade-offs

| Goal | Idiom | NULL-safe? | Notes |
|------|-------|:----------:|-------|
| Has ≥1 match (semi) | `EXISTS (…)` | yes | Short-circuits; preferred |
| Has ≥1 match (semi) | `IN (subquery)` | yes | Planner rewrites to semi-join |
| Has ≥1 match (semi) | `INNER JOIN` + `DISTINCT` | yes | Works but risks fan-out; needs DISTINCT |
| No match (anti) | `NOT EXISTS (…)` | **yes** | Safest, usually fastest |
| No match (anti) | `LEFT JOIN … IS NULL` | yes | Correct; can fan out on dup keys |
| No match (anti) | `NOT IN (subquery)` | **NO** | Empty result if subquery has a NULL |

**`USING` / `NATURAL JOIN` caveats:** `JOIN … USING (customer_id)` joins on that identically-named column and collapses it to one output column — cleaner than `ON`, but only when names line up. `NATURAL JOIN` auto-joins on *all* same-named columns — dangerous: add an unrelated `created_at` or `id` column to both tables and the join predicate silently changes, breaking the query. Prefer explicit `ON`; use `USING` sparingly for obvious keys; avoid `NATURAL JOIN` in production.

## 7. Performance Notes

- **Anti-join:** default to `NOT EXISTS`. It's NULL-safe, short-circuits, and the planner maps it to a `Hash Anti Join` / anti-semi nested loop. `NOT IN` is both a correctness hazard and often slower.
- **Semi-join:** `EXISTS` and `IN` are typically equivalent after planning; both want an **index on the inner join key** so each existence probe is a seek, not a scan.
- **Self-join:** index the referencing column (`manager_id`). Hierarchy traversal deeper than one level wants a **recursive CTE**, not a chain of self-joins.
- **`LEFT JOIN ... IS NULL`** builds and probes a full hash of the right side before discarding matches — heavier than an anti-join when the right table is large or the key is non-unique.
- Confirm with `EXPLAIN`: look for `Semi Join` / `Anti Join` nodes. A correlated subquery showing up as a per-row `SubPlan` loop (no semi-join rewrite) on a big table is a red flag — add the index or rephrase.

## 8. Common Mistakes

1. ⚠️ **`NOT IN` with a nullable subquery** returns zero rows — switch to `NOT EXISTS` or filter `IS NOT NULL` in the subquery.
2. ⚠️ **Using `INNER JOIN` as a semi-join** duplicates left rows on one-to-many matches — add `DISTINCT`, or just use `EXISTS`.
3. ⚠️ **Self-join with `INNER`** drops the root (the CEO with `manager_id IS NULL`) — use `LEFT JOIN` to keep it.
4. ⚠️ **`NATURAL JOIN`** silently re-derives its predicate when a column is added to either table — use explicit `ON`.
5. ⚠️ **`COUNT(*)` after `LEFT JOIN ... IS NULL`** — fine here since unmatched rows are single, but the same idiom on a fan-out key double-counts; prefer `NOT EXISTS`.
6. ⚠️ **Chaining self-joins for deep hierarchies** — three levels of self-join is a smell; reach for a recursive CTE.
7. ⚠️ **Forgetting to alias** both instances of a self-joined table — the query won't parse without distinct aliases (`e`, `m`).

## 9. Interview Questions

**Q: What is a self-join and give a real use case?**
A: Joining a table to another alias of itself to relate one row to another in the same table. Classic case: `employees e JOIN employees m ON e.manager_id = m.id` to show each employee's manager. Use `LEFT JOIN` so the top-level employee (NULL manager) is retained.

**Q: Define a semi-join and an anti-join.**
A: A semi-join returns left rows that have at least one match on the right, without projecting right columns or duplicating left rows. An anti-join returns left rows that have no match — a set difference.

**Q: Why can `NOT IN` return an empty result, and what do you use instead?**
A: If the subquery yields any NULL, `x NOT IN (…, NULL)` evaluates to UNKNOWN for every row (never TRUE), so nothing passes. Use `NOT EXISTS`, which is NULL-safe, or add `WHERE col IS NOT NULL` to the subquery.

**Q: Compare the three anti-join idioms.**
A: `NOT EXISTS` — NULL-safe, short-circuits, usually the fastest and the default. `LEFT JOIN … IS NULL` — correct but materializes all matches first and can fan out on non-unique keys. `NOT IN` — concise but has the NULL trap; avoid unless the subquery is provably NULL-free.

**Q: Are `EXISTS` and `IN` equivalent?**
A: For a non-NULL, single-column membership test the optimizer usually rewrites both to the same semi-join, so they perform identically. `EXISTS` is more general (arbitrary correlated predicate) and immune to the NULL issues that affect `NOT IN`.

**Q: How does `EXISTS` help performance versus a plain join?**
A: It short-circuits — it needs only to prove *one* match exists, so with an index on the inner key each row becomes an index seek that stops immediately, and it never duplicates outer rows the way an inner join can.

**Q: When you write `SELECT ... FROM a INNER JOIN b` to test existence, what bug appears?**
A: Fan-out: if `b` has multiple matching rows per `a` row, `a`'s rows are duplicated. You must add `DISTINCT` (extra sort/hash cost) — which is exactly why a semi-join via `EXISTS` is cleaner.

**Q: What's wrong with `NATURAL JOIN` in production code?**
A: It joins on *every* commonly-named column and re-derives the predicate whenever schemas change. Adding an `id`/`created_at` to both tables silently alters or breaks the join. Prefer explicit `ON`; use `USING` only for a clearly-intended shared key.

**Q: How do you traverse a hierarchy more than one level deep?**
A: A **recursive CTE** (`WITH RECURSIVE`), not repeated self-joins. Self-joins handle a fixed depth (employee→manager); recursion handles arbitrary depth (full management chain, org subtree).

**Q: How can you tell the planner used a semi/anti-join?**
A: `EXPLAIN` shows node types like `Hash Semi Join` or `Hash Anti Join` (PostgreSQL). If instead you see a correlated `SubPlan` executed once per outer row with no rewrite, on a large table, add an index on the inner key or rephrase the predicate.

**Q: `USING (customer_id)` vs `ON a.customer_id = b.customer_id` — any difference?**
A: `USING` requires the column name to be identical on both sides and collapses it to a single output column (unqualified). `ON` is explicit and works for differing names or complex predicates. Behaviorally the join is the same; `USING` is just terser and slightly more fragile.

## 10. Practice

- [ ] List each employee with their manager's name, keeping the CEO (self LEFT JOIN).
- [ ] Find products that have never been ordered, using `NOT EXISTS`.
- [ ] Rewrite that anti-join with `LEFT JOIN ... IS NULL` and compare the `EXPLAIN` plans.
- [ ] Demonstrate the `NOT IN` NULL trap: insert one order with `customer_id = NULL` and observe the empty result.
- [ ] Write a semi-join (customers who ordered in 2026) two ways — `EXISTS` and `IN` — and confirm identical output.

## 11. Cheat Sheet

> [!TIP]
> **Self-join:** table joined to its own alias for row-to-row relations (employee↔manager); use LEFT to keep the root. **Semi-join** (`EXISTS`/`IN`) = left rows *with* a match, no dupes. **Anti-join** (`NOT EXISTS` preferred, or `LEFT JOIN … IS NULL`) = left rows with *no* match. **Never** use `NOT IN` on a nullable subquery — one NULL empties the result. Avoid `NATURAL JOIN`; index the inner/self key; go recursive-CTE for deep hierarchies.

**References:** PostgreSQL docs "Subquery Expressions" (EXISTS/IN), Use The Index Luke, "SQL Antipatterns" (Ambler/Karwin), MySQL "Subqueries with EXISTS/NOT EXISTS"

---

*SQL Handbook — topic 06.*
