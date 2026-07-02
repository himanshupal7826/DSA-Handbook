# 12 · Recursive CTEs

> **In one line:** A `WITH RECURSIVE` CTE that seeds with an anchor row set and repeatedly feeds its own output back in — the standard SQL tool for hierarchies, graphs, and generated series.

---

## 1. Overview

A **recursive CTE** lets a single SQL statement iterate. It is built from two parts glued by `UNION ALL`: an **anchor member** that produces the starting rows, and a **recursive member** that references the CTE itself and produces the next "generation" from the previous one. The engine repeats the recursive member until it yields no new rows, accumulating every generation into the result.

This is how you traverse **tree and graph structures** stored in the relational model — an org chart via `manager_id`, a bill-of-materials, a category tree, a folder hierarchy, "all reports under this VP", "all ancestors of this comment". Without recursion you'd need N self-joins for depth N; a recursive CTE handles arbitrary, unknown depth in one statement.

The same machinery **generates series** (numbers, dates, calendars) with no source table, and walks **graphs** (who-follows-whom, dependency DAGs) — but graphs demand **cycle detection**, because a loop would recurse forever. The engineering discipline of recursive CTEs is therefore mostly about **termination**: a real base case, `UNION ALL` vs `UNION`, a depth cap, and a visited-path guard.

## 2. Core Concepts

- **`WITH RECURSIVE cte AS ( anchor UNION ALL recursive )`** — the required shape (some engines, e.g. SQL Server/Oracle, omit the `RECURSIVE` keyword).
- **Anchor member** — the non-recursive `SELECT` that seeds the working set (e.g., the root node, or `SELECT 1`).
- **Recursive member** — references `cte`; each pass reads only the rows produced by the *previous* pass (the working table), not the whole accumulation.
- **`UNION ALL` vs `UNION`** — `ALL` keeps every row (fast, standard); `UNION` de-duplicates each step (implicit cycle guard, slower).
- **Termination** — recursion stops when the recursive member returns zero rows. A missing/incorrect base case = infinite loop.
- **Depth control** — carry a `depth` column and filter `WHERE depth < N`, or rely on the engine's recursion limit.
- **Cycle detection** — for graphs, track the visited path (an array/string) and stop when a node repeats; PostgreSQL 14+ has a `CYCLE` clause.
- **Column list must line up** — anchor and recursive `SELECT`s need identical column count and compatible types.

## 3. Syntax & Examples

```sql
-- (a) Org chart: everyone under manager 1, with depth
WITH RECURSIVE org AS (
    SELECT id, name, manager_id, 1 AS depth          -- anchor: the root
    FROM   employees
    WHERE  id = 1
    UNION ALL
    SELECT e.id, e.name, e.manager_id, o.depth + 1   -- recursive: children
    FROM   employees e
    JOIN   org o ON e.manager_id = o.id
)
SELECT * FROM org ORDER BY depth, id;

-- (b) Generate a series of dates (no source table)
WITH RECURSIVE cal(d) AS (
    SELECT DATE '2026-01-01'
    UNION ALL
    SELECT d + INTERVAL '1 day' FROM cal WHERE d < DATE '2026-01-07'
)
SELECT d FROM cal;

-- (c) Generate integers 1..10
WITH RECURSIVE nums(n) AS (
    SELECT 1
    UNION ALL
    SELECT n + 1 FROM nums WHERE n < 10
)
SELECT n FROM nums;

-- (d) Graph traversal WITH cycle detection (manual path tracking)
WITH RECURSIVE reach AS (
    SELECT src, dst,
           ARRAY[src, dst] AS path,
           false          AS is_cycle
    FROM   edges WHERE src = 'A'
    UNION ALL
    SELECT r.dst, e.dst,
           r.path || e.dst,
           e.dst = ANY(r.path)               -- have we seen dst before?
    FROM   edges e
    JOIN   reach r ON e.src = r.dst
    WHERE  NOT r.is_cycle                     -- stop expanding a cyclic path
      AND  array_length(r.path, 1) < 20       -- hard depth cap (belt & braces)
)
SELECT DISTINCT dst FROM reach WHERE NOT is_cycle;

-- (e) PostgreSQL 14+: built-in CYCLE clause
WITH RECURSIVE reach AS (
    SELECT src, dst FROM edges WHERE src = 'A'
    UNION ALL
    SELECT e.src, e.dst FROM edges e JOIN reach r ON e.src = r.dst
) CYCLE dst SET is_cycle USING path
SELECT dst FROM reach WHERE NOT is_cycle;
```

## 4. Sample Data & Results

**`employees`** (self-referencing `manager_id`)

| id | name    | manager_id |
|----|---------|------------|
| 1  | Amara   | NULL       |
| 2  | Björn   | 1          |
| 3  | Chen    | 1          |
| 4  | Dara    | 2          |
| 5  | Emil    | 4          |

Query (a) starting at `id = 1` walks the tree:

| id | name  | manager_id | depth |
|----|-------|------------|-------|
| 1  | Amara | NULL       | 1     |
| 2  | Björn | 1          | 2     |
| 3  | Chen  | 1          | 2     |
| 4  | Dara  | 2          | 3     |
| 5  | Emil  | 4          | 4     |

Iteration: **pass 0** (anchor) → {1}; **pass 1** → children of 1 = {2,3}; **pass 2** → children of 2 = {4}; **pass 3** → children of 4 = {5}; **pass 4** → no children → stop.

## 5. Under the Hood

The engine runs a fixpoint loop. It evaluates the anchor once into the **result** and into a **working table**. Then it repeats: run the recursive member using only the current working table as `cte`, append the output to the result, and make that output the new working table. When a pass yields zero rows, the loop terminates.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="bold">Recursive CTE = breadth-first tree walk</text>

  <!-- tree -->
  <circle cx="360" cy="60" r="18" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="65" text-anchor="middle" fill="#1e293b">1</text>
  <text x="405" y="63" fill="#64748b" font-size="11">depth 1 (anchor)</text>

  <circle cx="270" cy="130" r="18" fill="#eff6ff" stroke="#2563eb"/>
  <text x="270" y="135" text-anchor="middle" fill="#1e293b">2</text>
  <circle cx="450" cy="130" r="18" fill="#eff6ff" stroke="#2563eb"/>
  <text x="450" y="135" text-anchor="middle" fill="#1e293b">3</text>
  <text x="560" y="133" fill="#64748b" font-size="11">depth 2 (pass 1)</text>

  <circle cx="270" cy="200" r="18" fill="#eff6ff" stroke="#2563eb"/>
  <text x="270" y="205" text-anchor="middle" fill="#1e293b">4</text>
  <text x="560" y="203" fill="#64748b" font-size="11">depth 3 (pass 2)</text>

  <circle cx="270" cy="270" r="18" fill="#eff6ff" stroke="#2563eb"/>
  <text x="270" y="275" text-anchor="middle" fill="#1e293b">5</text>
  <text x="560" y="273" fill="#64748b" font-size="11">depth 4 (pass 3)</text>

  <line x1="349" y1="74" x2="281" y2="116" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="371" y1="74" x2="439" y2="116" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="270" y1="148" x2="270" y2="182" stroke="#475569" marker-end="url(#a3)"/>
  <line x1="270" y1="218" x2="270" y2="252" stroke="#475569" marker-end="url(#a3)"/>

  <!-- fixpoint loop box -->
  <rect x="70" y="120" width="150" height="150" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="145" y="150" text-anchor="middle" fill="#1e293b" font-weight="bold">fixpoint loop</text>
  <text x="145" y="176" text-anchor="middle" fill="#1e293b" font-size="11">working table :=</text>
  <text x="145" y="194" text-anchor="middle" fill="#1e293b" font-size="11">last pass output</text>
  <text x="145" y="222" text-anchor="middle" fill="#1e293b" font-size="11">run recursive member</text>
  <text x="145" y="248" text-anchor="middle" fill="#b91c1c" font-size="11">stop when 0 rows</text>

  <text x="360" y="320" text-anchor="middle" fill="#059669" font-weight="bold">UNION ALL appends every generation; loop ends when a pass adds nothing</text>
</svg>
```

Note this is **breadth-first**: each pass expands the whole current frontier. Every intermediate generation is buffered, so a wide/deep hierarchy can consume real memory. PostgreSQL shows the plan as `Recursive Union` over a `WorkTable Scan`. `UNION` (no `ALL`) makes the engine de-duplicate the accumulated set on every pass — an automatic but costly cycle guard; `UNION ALL` does not, which is why graphs need explicit cycle detection. There is no guaranteed traversal order unless you carry a depth/path column and `ORDER BY` it in the final `SELECT`.

## 6. Variations & Trade-offs

| Goal | Technique | Termination guard |
|------|-----------|-------------------|
| Descendants (org/tree) | join `child.parent_id = cte.id` | tree has no cycles; still cap depth defensively |
| Ancestors (path to root) | join `cte.parent_id = parent.id` | reaches root (`parent_id IS NULL`) |
| Number/date series | `n + 1` / `d + interval` | `WHERE n < :limit` |
| Graph reachability (DAG) | join `edge.src = cte.dst` | `UNION` **or** path array + depth cap |
| Graph with cycles | carry `path` array, flag repeats | `NOT is_cycle` + `depth < N`; or `CYCLE` clause (PG 14+) |
| Shortest path / levels | carry `depth`, take `MIN(depth)` per node | depth cap |

**`UNION ALL` vs `UNION`:** `UNION ALL` is the default and fastest; use it for trees (acyclic) and series. `UNION` de-duplicates every pass — a cheap implicit cycle guard for small graphs but expensive at scale. For real graphs prefer `UNION ALL` **plus** explicit path tracking (or the SQL-standard `CYCLE` clause) so you control the guard and can report where the cycle was.

**Recursive CTE vs application loop:** the CTE keeps traversal in the engine (one round trip, set-based) and beats a client-side loop that fires one query per level. For extremely deep or heavily-reused hierarchies, a **materialized path** column (`/1/2/4/`) or **closure table** can outperform recursion by trading write cost for cheap reads.

## 7. Performance Notes

- **Index the recursive join column.** For `JOIN employees e ON e.manager_id = cte.id`, index `employees(manager_id)`; each pass is otherwise a full scan of the table.
- **Cap the depth even for trees.** A defensive `WHERE depth < 100` turns an accidental data cycle (a mis-set `manager_id`) from an infinite loop into a bounded, debuggable result.
- **Prefer `UNION ALL`.** `UNION`'s per-pass de-duplication sorts/hashes the growing set repeatedly; only pay it when you actually need dedup and the set is small.
- **Watch memory on wide graphs.** Breadth-first buffering means fan-out multiplies rows fast; `SELECT DISTINCT` at the end doesn't stop the intermediate blow-up.
- **Project only needed columns.** Every carried column is copied each generation; dragging wide rows through recursion is expensive.
- **Engine limits:** SQL Server defaults to `MAXRECURSION 100` (override with `OPTION (MAXRECURSION n)`); PostgreSQL has no fixed limit — an unbounded recursion runs until memory/timeout, so *you* must bound it. MySQL 8 uses `cte_max_recursion_depth` (default 1000).
- **Check the plan:** `Recursive Union` + `WorkTable Scan` (PostgreSQL). High `WorkTable` row counts signal a missing depth cap or an unintended cycle.

## 8. Common Mistakes

1. ⚠️ **No termination / infinite loop** — recursive member never stops producing rows. Fix: ensure the base case shrinks (tree bottoms out) or add `WHERE depth < N`.
2. ⚠️ **`UNION ALL` on a cyclic graph** loops forever. Fix: track a visited `path` array and stop when a node repeats, or use `UNION` / the `CYCLE` clause.
3. ⚠️ **Anchor and recursive column lists mismatch** (different count or types) — the CTE won't compile. Fix: align both `SELECT`s exactly, cast where needed.
4. ⚠️ **Forgetting the `RECURSIVE` keyword** (PostgreSQL/MySQL) — the CTE can't reference itself and errors. Fix: `WITH RECURSIVE`.
5. ⚠️ **Referencing the CTE twice in the recursive member** — standard SQL allows the self-reference only once. Fix: restructure the recursion.
6. ⚠️ **Assuming ordered output** — recursion doesn't guarantee tree order. Fix: carry `depth`/`path` and `ORDER BY` it in the outer query.
7. ⚠️ **Hitting the engine recursion cap and truncating silently-ish** (SQL Server errors at 100). Fix: raise `MAXRECURSION`/`cte_max_recursion_depth` deliberately, or reduce depth.
8. ⚠️ **Putting an aggregate or `LIMIT` inside the recursive member** where the dialect forbids it. Fix: aggregate/limit in the final `SELECT`, not inside the recursion.

## 9. Interview Questions

**Q: What are the two required parts of a recursive CTE?**
A: An anchor member (a non-recursive `SELECT` that seeds the starting rows) and a recursive member (a `SELECT` that references the CTE itself to derive the next generation), combined with `UNION ALL` (or `UNION`). The recursion repeats the recursive member until it produces no new rows.

**Q: How does a recursive CTE actually terminate?**
A: The engine loops the recursive member, each pass reading only the previous pass's output (the working table). When a pass returns zero rows, the loop stops. So termination requires the recursion to eventually produce nothing — a tree bottoming out, a series hitting its `WHERE` bound, or an explicit depth cap.

**Q: `UNION ALL` vs `UNION` in a recursive CTE — what's the difference?**
A: `UNION ALL` appends all rows without de-duplication (fast, the default). `UNION` removes duplicates on each pass, which incidentally prevents infinite loops on cyclic graphs but is expensive because it re-deduplicates the growing set. Use `UNION ALL` for trees/series and add explicit cycle handling for graphs.

**Q: How do you detect and stop cycles when traversing a graph?**
A: Carry the visited path (an array or delimited string). In the recursive member, check whether the next node is already in the path (`node = ANY(path)`); flag it and stop expanding cyclic branches (`WHERE NOT is_cycle`). Also add a hard depth cap. PostgreSQL 14+ offers a built-in `CYCLE ... SET ... USING` clause.

**Q: How would you list every employee under a given manager?**
A: Anchor on the manager row, then recursively join `employees.manager_id = cte.id` with `UNION ALL`, carrying a `depth` column. The recursion expands each level of reports until a level has no children.

**Q: How do you generate a series of dates or numbers without a table?**
A: Anchor with the first value (`SELECT DATE '2026-01-01'` or `SELECT 1`), and in the recursive member add the step (`d + interval '1 day'`, `n + 1`) guarded by `WHERE d < :end` / `WHERE n < :max`. The bound provides termination.

**Q: Is a recursive CTE depth-first or breadth-first?**
A: Breadth-first — each pass expands the entire current frontier (one whole level) before the next. That's why every generation is buffered and why there's no inherent tree ordering; you impose order by carrying `depth`/`path` and sorting in the final `SELECT`.

**Q: How do you find the ancestors (path to the root) of a node?**
A: Reverse the join direction: anchor on the node, then recursively join `cte.parent_id = parent.id`, walking up until `parent_id IS NULL`. Each pass moves one level toward the root.

**Q: (Senior) What are the performance risks of a recursive CTE at scale, and how do you mitigate them?**
A: Breadth-first buffering can explode memory on high-fan-out graphs; per-pass joins without an index on the recursive key become full scans; `UNION` dedup re-sorts the growing set each pass. Mitigate with an index on the join column, `UNION ALL` + explicit cycle guard, a depth cap, projecting only needed columns, and for hot read-heavy hierarchies a closure table or materialized path.

**Q: (Senior) How do recursion limits differ across engines?**
A: SQL Server caps at 100 by default (`OPTION (MAXRECURSION n)`, 0 = unlimited). PostgreSQL has no built-in limit — unbounded recursion runs until memory/timeout, so you must bound it yourself. MySQL 8 uses `cte_max_recursion_depth` (default 1000). Oracle/SQL Server also omit the `RECURSIVE` keyword.

**Q: (Senior) When would you NOT use a recursive CTE for hierarchy queries?**
A: When reads are frequent and depth is large: recursion re-walks the tree every query. A **closure table** (all ancestor–descendant pairs) or a **materialized path** column gives O(1)/index-range reads at the cost of extra write/maintenance. Choose based on read/write ratio and how often the hierarchy changes.

**Q: (Senior) Can you use aggregates or `ORDER BY`/`LIMIT` inside the recursive member?**
A: Generally no — the standard and most engines disallow aggregates, `GROUP BY`, `ORDER BY`, `LIMIT`, and `DISTINCT` in the recursive term (and allow the self-reference only once). Do that work in the outer query that selects from the CTE. Level-wise aggregation is done by carrying a `depth` and aggregating afterward.

## 10. Practice

- [ ] Write a recursive CTE that returns each employee with their depth and full name-path from the root (`Amara > Björn > Dara`).
- [ ] Generate a calendar of all Mondays in a given year using a recursive series.
- [ ] Insert a deliberate cycle into an `edges` table and prove your `UNION ALL` query loops, then fix it with path tracking.
- [ ] Compute, per node, the shortest number of hops from a start node using a `depth` column and `MIN`.
- [ ] Compare a recursive-CTE ancestor query against a closure-table lookup on the same data and note the plan differences.

## 11. Cheat Sheet

> [!TIP]
> **Recursive CTEs in one screen.**
> - Shape: `WITH RECURSIVE cte AS ( anchor  UNION ALL  recursive-referencing-cte ) SELECT ...`.
> - **Anchor** = seed rows; **recursive member** reads only the previous pass; loop ends when a pass adds **0 rows**.
> - **`UNION ALL`** = fast default (trees, series). **`UNION`** = dedups each pass (implicit, costly cycle guard).
> - **Trees**: join `child.parent_id = cte.id`, carry `depth`. **Ancestors**: join upward to `parent_id IS NULL`. **Series**: `n+1` / `d+interval` with a `WHERE` bound.
> - **Graphs need cycle detection**: path array + `NOT is_cycle` + depth cap, or PG 14+ `CYCLE` clause.
> - Index the recursive join column; always cap depth defensively. Limits: SQL Server 100, MySQL 1000, PostgreSQL none (bound it yourself).

**References:** PostgreSQL docs — "WITH Queries (Common Table Expressions)" incl. recursive & CYCLE; MySQL Reference Manual — "Recursive Common Table Expressions"; SQL Server docs — "Recursive Queries Using Common Table Expressions"; Use The Index, Luke — hierarchical/recursive queries

---
*SQL Handbook — topic 12.*
