# 01 · SELECT, WHERE, ORDER BY & LIMIT

> **In one line:** SELECT reads the mental grammar of SQL backwards — the clauses you write first are the clauses the engine runs last.

---

## 1. Overview

Every query you will ever write starts here. `SELECT ... FROM ... WHERE ... ORDER BY ... LIMIT` is the workhorse: pick a table, keep the rows you want, shape the columns, order them, and cap the count.

The trap for beginners is that SQL reads in a **different order than it executes**. You write `SELECT` first, but the engine resolves `FROM` first and `SELECT` almost last. This single fact explains a dozen "why can't I use my column alias in WHERE?" errors and why `ORDER BY` can reference an alias but `WHERE` cannot.

This page nails the **logical execution order**, the real cost of `DISTINCT`, why `SELECT *` is a liability in production, and why an `ORDER BY` without a unique tiebreaker is not actually deterministic.

## 2. Core Concepts

- **Logical execution order** — the engine evaluates clauses as `FROM → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT/OFFSET`, regardless of written order.
- **Projection vs. selection** — `SELECT` is *projection* (choosing columns); `WHERE` is *selection* (choosing rows). Different operations, different phases.
- **Alias visibility** — because `SELECT` runs after `WHERE`/`GROUP BY`/`HAVING`, a `SELECT` alias is invisible to them but visible to `ORDER BY`.
- **`WHERE` is sargable** — a predicate that can use an index is a *search argument*. `WHERE created_at >= '2026-01-01'` is sargable; `WHERE YEAR(created_at) = 2026` is not.
- **`DISTINCT` costs a sort or hash** — deduplication is not free; it materializes and compares every projected row.
- **`SELECT *` is a coupling and I/O tax** — it fetches every column, defeats covering indexes, and breaks when the schema changes.
- **`LIMIT` caps rows, not work** — without a supporting index the engine may still scan everything before trimming.
- **Deterministic ordering** — an `ORDER BY` is only stable if its keys uniquely order the rows; otherwise ties break arbitrarily and can change between runs.

## 3. Syntax & Examples

```sql
-- Simplest form: all rows, all columns (avoid * in real code)
SELECT * FROM employees;

-- Projection + selection: only the columns and rows you need
SELECT id, name, salary
FROM employees
WHERE department = 'Engineering';

-- Multiple predicates; AND/OR precedence — parenthesize when mixing
SELECT id, name, salary
FROM employees
WHERE department = 'Engineering'
  AND (salary >= 100000 OR level >= 5);

-- Ordering, then capping. Note the unique tiebreaker (id) for determinism.
SELECT id, name, salary
FROM employees
WHERE department = 'Engineering'
ORDER BY salary DESC, id ASC
LIMIT 10;

-- Alias defined in SELECT is usable in ORDER BY, NOT in WHERE
SELECT salary * 12 AS annual_pay
FROM employees
ORDER BY annual_pay DESC;   -- OK

-- This FAILS: annual_pay does not exist yet at WHERE time
-- SELECT salary * 12 AS annual_pay FROM employees WHERE annual_pay > 1000000;

-- DISTINCT deduplicates the whole projected row
SELECT DISTINCT department FROM employees;
```

## 4. Sample Data & Results

Table `employees`:

| id | name    | department  | salary | level |
|----|---------|-------------|--------|-------|
| 1  | Ada     | Engineering | 145000 | 6     |
| 2  | Bay     | Engineering | 120000 | 5     |
| 3  | Chen    | Sales       | 90000  | 4     |
| 4  | Diallo  | Engineering | 120000 | 5     |
| 5  | Esra    | Sales       | 110000 | 6     |

Query:

```sql
SELECT id, name, salary
FROM employees
WHERE department = 'Engineering'
ORDER BY salary DESC, id ASC
LIMIT 2;
```

Result:

| id | name | salary |
|----|------|--------|
| 1  | Ada  | 145000 |
| 2  | Bay  | 120000 |

Note the tie at `salary = 120000` (ids 2 and 4). The `id ASC` tiebreaker guarantees `2` sorts before `4` every run. Drop that tiebreaker and either row could appear — a classic flaky-test cause.

## 5. Under the Hood

The mismatch between written and executed order is the whole game. You *type* SELECT first for readability, but the planner must know the source rows before it can filter, and must filter before it can shape output.

```svg
<svg viewBox="0 0 720 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="180" y="22" text-anchor="middle" fill="#64748b">Written order (how you type it)</text>
  <text x="540" y="22" text-anchor="middle" fill="#059669">Logical order (how it runs)</text>

  <rect x="90" y="36" width="180" height="26" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="54" text-anchor="middle" fill="#1e293b">SELECT cols</text>
  <rect x="90" y="68" width="180" height="26" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="86" text-anchor="middle" fill="#1e293b">FROM table</text>
  <rect x="90" y="100" width="180" height="26" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="118" text-anchor="middle" fill="#1e293b">WHERE filter</text>
  <rect x="90" y="132" width="180" height="26" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="150" text-anchor="middle" fill="#1e293b">ORDER BY / LIMIT</text>

  <rect x="450" y="36" width="190" height="26" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="545" y="54" text-anchor="middle" fill="#1e293b">1. FROM</text>
  <rect x="450" y="70" width="190" height="26" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="545" y="88" text-anchor="middle" fill="#1e293b">2. WHERE</text>
  <rect x="450" y="104" width="190" height="26" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="545" y="122" text-anchor="middle" fill="#1e293b">3. GROUP BY / HAVING</text>
  <rect x="450" y="138" width="190" height="26" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="545" y="156" text-anchor="middle" fill="#1e293b">4. SELECT (+ aliases)</text>
  <rect x="450" y="172" width="190" height="26" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="545" y="190" text-anchor="middle" fill="#1e293b">5. DISTINCT</text>
  <rect x="450" y="206" width="190" height="26" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="545" y="224" text-anchor="middle" fill="#1e293b">6. ORDER BY</text>
  <rect x="450" y="240" width="190" height="26" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="545" y="258" text-anchor="middle" fill="#1e293b">7. LIMIT / OFFSET</text>

  <line x1="280" y1="90" x2="440" y2="83" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#ah)"/>
  <text x="360" y="300" text-anchor="middle" fill="#b91c1c">Aliases from SELECT (step 4) reach ORDER BY (6) — never WHERE (2).</text>
</svg>
```

Because `WHERE` runs at step 2, it sees only base-table columns and can lean on indexes. Because `ORDER BY` runs at step 6 — after `SELECT` — it can reference computed aliases. `DISTINCT` (step 5) forces the engine to sort or hash the entire projected result before ordering, which is why it is not free.

## 6. Variations & Trade-offs

| Construct | What it does | Cost | When to use |
|-----------|--------------|------|-------------|
| `SELECT col1, col2` | Explicit projection | Minimal; enables covering indexes | Always, in production code |
| `SELECT *` | All columns | Extra I/O, breaks covering index, fragile to schema drift | Ad-hoc exploration only |
| `DISTINCT` | Remove duplicate rows | Sort or hash over full projection | When source truly has dupes |
| `GROUP BY` (no agg) | Also dedupes | Similar to DISTINCT | When you also aggregate |
| `LIMIT n` | Cap output rows | Cheap *if* an index feeds the order | Pagination, top-N |
| `LIMIT n OFFSET m` | Skip then cap | Grows with `m` (scans+discards) | Small offsets only |

In **PostgreSQL** and **MySQL** the standard `LIMIT n OFFSET m` works. Older SQL Server uses `TOP n` or `OFFSET ... FETCH`; Oracle historically used `ROWNUM`. The logical execution order is identical across all of them.

## 7. Performance Notes

- A `WHERE` predicate is **sargable** only if the indexed column appears bare on one side: `WHERE created_at >= '2026-01-01'` uses an index; `WHERE DATE(created_at) = '2026-01-01'` does not (it computes a function per row).
- `ORDER BY col LIMIT n` is the top-N pattern. With an index on `col` the engine walks the index and stops after `n` rows — no full sort. Without it, it sorts the entire result then trims.
- `SELECT *` defeats **index-only scans**: even if an index covers your `WHERE` and `ORDER BY`, `*` forces a heap fetch for the remaining columns.
- `DISTINCT` on a high-cardinality projection can spill to disk. If you only need distinct values of one indexed column, an index can supply them via a skip/loose scan (engine-dependent).
- Read plans with `EXPLAIN` / `EXPLAIN ANALYZE`. Look for `Seq Scan` (full read) vs `Index Scan`, and for a `Sort` node that a matching index could eliminate.

## 8. Common Mistakes

1. ⚠️ **Referencing a `SELECT` alias in `WHERE`.** It doesn't exist yet. Fix: repeat the expression, or wrap the query in a subquery/CTE.
2. ⚠️ **Assuming `ORDER BY` is stable without a unique key.** Ties break arbitrarily. Fix: add a unique tiebreaker like `, id`.
3. ⚠️ **`SELECT *` in application code.** Fragile and slow. Fix: list exact columns.
4. ⚠️ **Wrapping the indexed column in a function** (`WHERE UPPER(email)=...`). Kills the index. Fix: store normalized data or use an expression index.
5. ⚠️ **Mixing `AND`/`OR` without parentheses.** `AND` binds tighter than `OR`, giving surprising results. Fix: parenthesize intent.
6. ⚠️ **Believing `LIMIT` makes a query cheap.** It caps output, not the scan. Fix: support the `ORDER BY` with an index.
7. ⚠️ **Adding `DISTINCT` to "fix" duplicate rows.** It masks a bad join. Fix: correct the join/grain instead.

## 9. Interview Questions

**Q: What is the logical execution order of a SELECT statement?**
A: FROM → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT/OFFSET. You write SELECT first but the engine resolves it near the end.

**Q: Why can ORDER BY use a SELECT alias but WHERE cannot?**
A: ORDER BY runs after SELECT (where the alias is created), while WHERE runs before SELECT, so the alias does not exist yet at WHERE time.

**Q: Is SELECT * bad, and why?**
A: In production, yes — it reads unneeded columns (extra I/O), defeats covering/index-only scans, and silently changes result shape when the schema evolves. It is fine for ad-hoc exploration.

**Q: What makes a WHERE predicate sargable?**
A: The indexed column appears bare (no function/expression wrapping it) so the engine can seek the index, e.g. `created_at >= X` rather than `YEAR(created_at) = X`.

**Q: Does LIMIT make a query fast?**
A: Only if an index can feed the required order so the engine stops early. Otherwise it may scan and sort everything, then discard all but n rows.

**Q: How much does DISTINCT cost?**
A: It requires deduplicating the full projected result via a sort or hash, so it is O(n log n) time or O(n) memory — never free, and it can spill to disk on large sets.

**Q: Your ORDER BY salary DESC returns rows in a different order between runs. Why?**
A: Multiple rows share the same salary and there is no unique tiebreaker, so ties resolve arbitrarily based on the scan/plan. Add `, id` (or another unique key) to make it deterministic.

**Q: What is the difference between WHERE and HAVING?**
A: WHERE filters individual rows before grouping; HAVING filters groups after aggregation. WHERE cannot reference aggregates; HAVING can.

**Q: You have WHERE status='active' ORDER BY created_at DESC LIMIT 20. What single index serves it best?**
A: A composite index on `(status, created_at DESC)`. It seeks to `status='active'` and reads the already-sorted `created_at` range, satisfying filter, sort, and limit with no separate Sort node.

**Q: Why can SELECT * turn an index-only scan into a heap fetch?**
A: An index-only scan works only when the index contains every referenced column. `*` references columns not in the index, forcing the engine back to the heap (table) for each row.

**Q: In WHERE a = 1 OR b = 2, why might the planner choose a Seq Scan even with indexes on a and b?**
A: An OR across two columns cannot be served by one B-tree seek; the planner may do a BitmapOr of two index scans or, if selectivity is poor, decide a full scan is cheaper than merging two large bitmaps.

## 10. Practice

- [ ] Write a query returning the 5 highest-paid employees with a deterministic tiebreaker.
- [ ] Rewrite `WHERE YEAR(hire_date) = 2025` into a sargable range predicate.
- [ ] Take a `SELECT *` query and reduce it to only the columns an index covers; confirm with `EXPLAIN`.
- [ ] Demonstrate that a `SELECT` alias fails in `WHERE` but works in `ORDER BY`.
- [ ] Show two runs of a tie-prone `ORDER BY` returning different orders, then fix it.

## 11. Cheat Sheet

> [!TIP]
> **Run order:** FROM → WHERE → GROUP BY → HAVING → SELECT → DISTINCT → ORDER BY → LIMIT.
> Aliases live from SELECT onward → usable in ORDER BY, never in WHERE.
> Keep predicates **sargable** (bare indexed column). `SELECT *` = wasted I/O + no index-only scan. `DISTINCT` = a hidden sort/hash. Always give `ORDER BY` a **unique tiebreaker** for deterministic output; `LIMIT` caps rows, not the scan.

**References:** PostgreSQL docs — SELECT; MySQL Reference Manual — SELECT Statement; Use The Index, Luke; SQL Performance Explained (Winand)

---

*SQL Handbook — topic 01.*
