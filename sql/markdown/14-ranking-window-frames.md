# 14 · Ranking & Window Frames

> **In one line:** The ranking family (`ROW_NUMBER`/`RANK`/`DENSE_RANK`/`NTILE`), navigation functions (`LAG`/`LEAD`/`FIRST_VALUE`/`LAST_VALUE`), and the frame clause (`ROWS`/`RANGE BETWEEN`) that decides exactly which rows each window sees.

---

## 1. Overview

Once you know that a window function computes over a partition (see **Window Functions Fundamentals**), the next questions are: *how do I rank rows within a partition*, *how do I reach the previous or next row*, and *exactly which slice of the partition does a running aggregate cover?* This page answers all three.

**Ranking functions** turn an ordering into position numbers — but they disagree about ties, and choosing the wrong one is the single most common window bug. **Navigation functions** (`LAG`, `LEAD`, `FIRST_VALUE`, `LAST_VALUE`, `NTH_VALUE`) let a row peek at other rows in its partition, powering deltas, gap detection, and "compare to first/last." And the **frame clause** — the `ROWS`/`RANGE BETWEEN … AND …` part of `OVER` — controls the moving set of rows an aggregate sees, which is what makes **running totals** and **moving averages** work (and what silently breaks them when you rely on the default).

These are the tools behind classic interview problems: top-N per group, "second highest salary," month-over-month growth, 7-day moving average, sessionization, and gaps-and-islands. Getting the tie semantics and the frame boundaries right is what separates a correct answer from a plausible-looking wrong one.

## 2. Core Concepts

- **`ROW_NUMBER()`** — a strictly increasing 1,2,3,… per partition; ties are broken *arbitrarily* unless your `ORDER BY` is fully deterministic. No duplicates ever.
- **`RANK()`** — ties share the same rank, then the next rank **skips** (1,2,2,4). Leaves gaps.
- **`DENSE_RANK()`** — ties share the rank, next rank does **not** skip (1,2,2,3). No gaps.
- **`NTILE(n)`** — distributes rows into `n` as-equal-as-possible buckets (quartiles, deciles); earlier buckets get the extra rows when it doesn't divide evenly.
- **`LAG(col, k, default)` / `LEAD(col, k, default)`** — value from `k` rows before / after the current row in partition order; `default` (else `NULL`) fills the edges.
- **`FIRST_VALUE` / `LAST_VALUE` / `NTH_VALUE`** — value at the first / last / n-th row *of the frame* — and the frame is why `LAST_VALUE` surprises people.
- **The frame clause** — `ROWS|RANGE|GROUPS BETWEEN <start> AND <end>` restricts the aggregate/navigation to a sub-window of the partition.
- **`ROWS` vs `RANGE`** — `ROWS` counts *physical rows*; `RANGE` counts *logical peers* (rows with equal `ORDER BY` values are one unit, and `RANGE` needs a numeric/date offset for value-based bounds).
- **The default-frame gotcha** — with `ORDER BY` present and no explicit frame, the default is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`, which includes *all peer ties* at the current row — often not what you want.
- **Running total / moving average** — an ordered aggregate over an explicit frame: `UNBOUNDED PRECEDING → CURRENT ROW` (cumulative) or `N PRECEDING → CURRENT ROW` (trailing window).

## 3. Syntax & Examples

Frame grammar:

```sql
function(args) OVER (
    PARTITION BY ...
    ORDER BY ...
    { ROWS | RANGE | GROUPS } BETWEEN <frame_start> AND <frame_end>
)
-- bounds: UNBOUNDED PRECEDING | n PRECEDING | CURRENT ROW | n FOLLOWING | UNBOUNDED FOLLOWING
```

The four ranking functions side by side:

```sql
SELECT name, salary,
       ROW_NUMBER() OVER (ORDER BY salary DESC) AS rn,
       RANK()       OVER (ORDER BY salary DESC) AS rnk,
       DENSE_RANK() OVER (ORDER BY salary DESC) AS drnk,
       NTILE(4)     OVER (ORDER BY salary DESC) AS quartile
FROM employees;
```

Top-N per group — the canonical `ROW_NUMBER` + outer filter pattern (windows can't go in `WHERE`):

```sql
SELECT * FROM (
  SELECT name, dept_id, salary,
         ROW_NUMBER() OVER (PARTITION BY dept_id ORDER BY salary DESC) AS rn
  FROM employees
) t
WHERE rn <= 3;
```

Row-to-row comparison with `LAG` — month-over-month change:

```sql
SELECT month, revenue,
       revenue - LAG(revenue, 1, 0) OVER (ORDER BY month) AS mom_change
FROM monthly_revenue;
```

Explicit cumulative frame (a running total) and a **trailing 3-row moving average**:

```sql
SELECT month, revenue,
       SUM(revenue) OVER (ORDER BY month
             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS running_total,
       AVG(revenue) OVER (ORDER BY month
             ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)         AS moving_avg_3
FROM monthly_revenue;
```

`FIRST_VALUE`/`LAST_VALUE` done right — to compare to the partition's true last row you must widen the frame, because the default frame ends at the current row:

```sql
SELECT name, dept_id, salary,
       FIRST_VALUE(salary) OVER (PARTITION BY dept_id ORDER BY salary DESC) AS top_salary,
       LAST_VALUE(salary)  OVER (PARTITION BY dept_id ORDER BY salary DESC
             ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)      AS bottom_salary
FROM employees;
```

## 4. Sample Data & Results

Input table `employees` (one department shown):

| name  | salary |
|-------|--------|
| Alice | 90000  |
| Carol | 80000  |
| Bob   | 80000  |
| Dave  | 70000  |
| Eve   | 60000  |

Query:

```sql
SELECT name, salary,
       ROW_NUMBER() OVER (ORDER BY salary DESC) AS rn,
       RANK()       OVER (ORDER BY salary DESC) AS rnk,
       DENSE_RANK() OVER (ORDER BY salary DESC) AS drnk,
       NTILE(2)     OVER (ORDER BY salary DESC) AS half
FROM employees;
```

Result — watch the tie at 80000 (Carol/Bob): `rn` still splits them 2/3, `rnk` gives both 2 then jumps to 4, `drnk` gives both 2 then 3:

| name  | salary | rn | rnk | drnk | half |
|-------|--------|----|-----|------|------|
| Alice | 90000  | 1  | 1   | 1    | 1    |
| Carol | 80000  | 2  | 2   | 2    | 1    |
| Bob   | 80000  | 3  | 2   | 2    | 1    |
| Dave  | 70000  | 4  | 4   | 3    | 2    |
| Eve   | 60000  | 5  | 5   | 4    | 2    |

Running total and trailing-3 moving average on `monthly_revenue`:

| month   | revenue | running_total | moving_avg_3 |
|---------|---------|---------------|--------------|
| 2026-01 | 100     | 100           | 100.0        |
| 2026-02 | 200     | 300           | 150.0        |
| 2026-03 | 300     | 600           | 200.0        |
| 2026-04 | 600     | 1200          | 366.7        |

(For April the trailing-3 frame covers Feb+Mar+Apr = (200+300+600)/3 = 366.7.)

## 5. Under the Hood

The engine sorts each partition by the `ORDER BY` keys, then walks it maintaining the **frame** as a sliding pair of boundaries. For `ROWS` frames it tracks physical offsets; for cumulative `UNBOUNDED PRECEDING → CURRENT ROW` sums it keeps a running accumulator (O(1) per row). `RANK`/`DENSE_RANK` compare each row's order key to the previous row's to detect peer groups; `NTILE` needs the partition row count to size buckets. `LAG`/`LEAD` are cheap look-behind/look-ahead into the already-sorted buffer.

The diagram shows how the frame slides for a trailing 3-row moving average versus a cumulative running total.

```svg
<svg viewBox="0 0 640 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" fill="#1e293b" font-weight="600">Window frame slides down the ordered partition</text>

  <!-- ordered rows -->
  <text x="60" y="52" text-anchor="middle" fill="#64748b">ordered</text>
  <g>
    <rect x="30" y="60" width="60" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="60" y="80" text-anchor="middle" fill="#1e293b">Jan</text>
    <rect x="30" y="96" width="60" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="60" y="116" text-anchor="middle" fill="#1e293b">Feb</text>
    <rect x="30" y="132" width="60" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="60" y="152" text-anchor="middle" fill="#1e293b">Mar</text>
    <rect x="30" y="168" width="60" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="60" y="188" text-anchor="middle" fill="#1e293b">Apr</text>
    <rect x="30" y="204" width="60" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="60" y="224" text-anchor="middle" fill="#1e293b">May</text>
  </g>

  <!-- trailing 3-row frame at Apr -->
  <text x="270" y="52" text-anchor="middle" fill="#059669">ROWS BETWEEN 2 PRECEDING AND CURRENT ROW</text>
  <rect x="150" y="128" width="240" height="74" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="2"/>
  <text x="270" y="152" text-anchor="middle" fill="#1e293b">Feb + Mar + Apr</text>
  <text x="270" y="172" text-anchor="middle" fill="#64748b">3-row moving avg at Apr</text>
  <line x1="90" y1="183" x2="150" y2="165" stroke="#475569" marker-end="url(#a2)"/>
  <text x="270" y="192" text-anchor="middle" fill="#64748b">frame slides one row per step</text>

  <!-- cumulative frame -->
  <text x="520" y="52" text-anchor="middle" fill="#d97706">UNBOUNDED PRECEDING → CURRENT ROW</text>
  <rect x="430" y="60" width="180" height="142" rx="8" fill="#fff7ed" stroke="#d97706" stroke-width="2"/>
  <text x="520" y="128" text-anchor="middle" fill="#1e293b">Jan … Apr</text>
  <text x="520" y="148" text-anchor="middle" fill="#64748b">running total at Apr</text>
  <line x1="90" y1="183" x2="430" y2="150" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#a2)"/>

  <text x="320" y="256" text-anchor="middle" fill="#b91c1c">Default frame (ORDER BY, no ROWS/RANGE) = RANGE UNBOUNDED PRECEDING → CURRENT ROW …</text>
  <text x="320" y="276" text-anchor="middle" fill="#b91c1c">… which also pulls in ALL tie-peers of the current row.</text>
  <text x="320" y="300" text-anchor="middle" fill="#64748b">Use ROWS for exact N-row windows; use explicit UNBOUNDED FOLLOWING for LAST_VALUE.</text>
</svg>
```

## 6. Variations & Trade-offs

| Function | Ties | Gaps after ties | Typical use |
|----------|------|-----------------|-------------|
| `ROW_NUMBER()` | broken arbitrarily | n/a (all unique) | dedup, exact top-N per group, pagination |
| `RANK()` | share rank | yes (skips) | competition ranking, "3rd place" semantics |
| `DENSE_RANK()` | share rank | no | "Nth distinct highest salary" |
| `NTILE(n)` | split across buckets | n/a | quartiles/deciles, even bucketing |

`ROWS` vs `RANGE` vs `GROUPS`:

| Frame mode | Unit of a bound | `CURRENT ROW` includes | Value offsets (`n PRECEDING`) |
|------------|-----------------|------------------------|-------------------------------|
| `ROWS` | physical row | just this row | count of rows |
| `RANGE` | peer group (equal ORDER BY) | this row + all its tie-peers | value distance (needs numeric/date order key) |
| `GROUPS` | peer group | this row + its peers | count of peer groups (PG 11+ / MySQL not supported) |

Prose: use `ROW_NUMBER` when you need exactly one row per group (deduplication, "the latest per user"); use `DENSE_RANK` for "the Nth distinct value" problems where ties should count once; use `RANK` when a tie should consume the following positions. For running aggregates prefer **explicit `ROWS`** frames — they're deterministic and index-friendly. Reach for `RANGE` only when you genuinely want value-based windows (e.g. "sum of everything within 7 days"), and note MySQL supports value-offset `RANGE` for numeric/temporal orders but not `GROUPS`.

## 7. Performance Notes

- **One sort per distinct window.** All ranking/navigation functions sharing the same `PARTITION BY … ORDER BY` are computed in a single ordered pass. Give them an identical `OVER` (or a named `WINDOW`) so the planner sorts once.
- **Index to skip the sort.** A B-tree on `(partition_key, order_key)` lets the engine stream rows in window order — `EXPLAIN` drops the `Sort` node above the scan. For top-N-per-group this is the biggest win.
- **`ROWS` is cheaper than `RANGE`.** `ROWS` frames advance by fixed offsets and cumulative sums stay O(1) per row. `RANGE` with value offsets must scan peer groups to find boundaries, costing more per row.
- **`LAST_VALUE` needs the full frame.** The `UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` frame makes the engine hold/scan the whole partition; if you only want the max/min, `MAX()`/`MIN()` over the partition (or `FIRST_VALUE` with reversed order) is often cheaper and clearer.
- **Top-N per group at scale.** `ROW_NUMBER` filtered to `rn <= k` still sorts every partition fully. On very large tables a **lateral / correlated `LIMIT k`** subquery (PostgreSQL `LATERAL`, MySQL 8 lateral-ish rewrites) can be faster because it stops after k rows per group using the index.
- **`NTILE` needs the count.** It materializes partition size first; on huge partitions that's an extra pass but still linear.

## 8. Common Mistakes

1. ⚠️ **Using `RANK` when you meant `DENSE_RANK` (or vice versa).** "2nd highest salary" with ties: `RANK` may skip rank 2 entirely; `DENSE_RANK` gives the 2nd *distinct* value. **Fix:** pick by whether ties should consume positions.
2. ⚠️ **`ROW_NUMBER` with a non-deterministic `ORDER BY`.** Ties resolve arbitrarily and can change between runs, breaking pagination and "latest per user." **Fix:** add a tiebreaker column (e.g. `ORDER BY updated_at DESC, id DESC`).
3. ⚠️ **`LAST_VALUE` returning the current row.** The default frame ends at `CURRENT ROW`, so `LAST_VALUE` "sees" only up to now. **Fix:** add `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING`.
4. ⚠️ **Relying on the default frame for running sums with ties.** Default `RANGE … CURRENT ROW` includes all tie-peers, so equal-keyed rows all get the *same* cumulative value. **Fix:** use `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`.
5. ⚠️ **Off-by-one in `N PRECEDING`.** A "3-row moving average" is `ROWS BETWEEN 2 PRECEDING AND CURRENT ROW` (2 + current = 3), not `3 PRECEDING`. **Fix:** count the current row.
6. ⚠️ **`LAG`/`LEAD` NULL at edges ignored.** The first row's `LAG` is `NULL`, so `revenue - LAG(revenue)` is `NULL` on row 1. **Fix:** supply a default: `LAG(revenue, 1, 0)` or `COALESCE`.
7. ⚠️ **Filtering `WHERE rn = 1`.** Windows aren't allowed in `WHERE`. **Fix:** wrap in a subquery/CTE and filter outside.

## 9. Interview Questions

**Q: What is the difference between ROW_NUMBER, RANK, and DENSE_RANK?**
A: All number rows within a partition by an ORDER BY. ROW_NUMBER is always unique (ties broken arbitrarily). RANK gives ties the same number then skips the next values (1,2,2,4). DENSE_RANK gives ties the same number with no skip (1,2,2,3). Choose by tie semantics.

**Q: How would you find the second-highest distinct salary, and which ranking function fits?**
A: DENSE_RANK, because it treats duplicate salaries as one rank: SELECT salary FROM (SELECT salary, DENSE_RANK() OVER (ORDER BY salary DESC) dr FROM employees) t WHERE dr = 2. RANK could skip rank 2 when the top salary is tied; ROW_NUMBER would pick a specific row, not a distinct value.

**Q: What does NTILE do and when is it useful?**
A: NTILE(n) splits the ordered partition into n buckets of as-equal-as-possible size, labeling each row with its bucket number. When the count isn't divisible by n, earlier buckets get one extra row. Useful for quartiles, deciles, percentile bands, and load-balancing rows into groups.

**Q: What is the default window frame, and why does it bite people?**
A: When ORDER BY is present and no frame is written, the default is RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW. The RANGE part includes all rows tied with the current row on the ORDER BY key, so tied rows share the same cumulative aggregate — unexpected for running totals. Writing ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW avoids it.

**Q: What is the difference between ROWS and RANGE in a frame clause?**
A: ROWS counts physical rows, so N PRECEDING is exactly N rows back and CURRENT ROW is just this row. RANGE works on logical value peers: all rows with equal ORDER BY values count as one unit, and value offsets (e.g. 7 days) select rows within a value distance. ROWS is deterministic and cheaper; RANGE is for value-based windows.

**Q: Why does LAST_VALUE often return the current row's value instead of the partition's last?**
A: Because the default frame ends at CURRENT ROW, so LAST_VALUE only sees rows up to now — the "last" it finds is the current one. Fix it by extending the frame: ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING, or use FIRST_VALUE with the reversed ORDER BY.

**Q: How do you compute a month-over-month change with window functions?**
A: LAG the previous period and subtract: revenue - LAG(revenue, 1, 0) OVER (ORDER BY month). LAG(col, 1) reads the prior row in order; the third argument (0) supplies a default so the first month isn't NULL. LEAD does the same looking forward.

**Q: Write the frame for a trailing 7-day moving average and explain the boundaries.**
A: AVG(x) OVER (ORDER BY day ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) if rows are one per day — 6 preceding plus the current row = 7 rows. If days can be missing, use RANGE BETWEEN INTERVAL '6' DAY PRECEDING AND CURRENT ROW so it's based on date distance, not row count.

**Q: How do you get the top 3 rows per group, and why can't you filter in WHERE?**
A: Compute ROW_NUMBER() OVER (PARTITION BY group ORDER BY metric DESC) in a subquery/CTE, then WHERE rn <= 3 in the outer query. You can't filter in the inner WHERE because window functions are evaluated after WHERE, so rn doesn't exist yet at that stage.

**Q: Your top-N-per-group query is slow on a huge table. What are your options?**
A: First, add a B-tree index on (partition_key, order_key DESC) so the window's sort is replaced by an ordered index scan (check EXPLAIN for a dropped Sort). If N is small and partitions many, a LATERAL join doing ORDER BY … LIMIT N per group can beat ROW_NUMBER by stopping after N rows per group via the index instead of sorting every partition fully.

**Q: How do ROW_NUMBER and pagination interact, and what makes it deterministic?**
A: ROW_NUMBER over a stable ORDER BY gives each row a fixed position for keyset/offset pagination. Determinism requires the ORDER BY to be unique — add a unique tiebreaker (e.g. primary key) so rows with equal sort values don't swap positions between page requests.

**Q: What's the difference between RANGE and GROUPS mode, and where are they supported?**
A: RANGE bounds are measured in ORDER BY value distance (with peers grouped); GROUPS bounds are measured in whole peer-groups counted as units. GROUPS is in the SQL standard and PostgreSQL 11+, but not MySQL. Both differ from ROWS, which counts individual physical rows.

## 10. Practice

- [ ] Rank employees by salary with all three of ROW_NUMBER, RANK, DENSE_RANK and explain the differing outputs on a tie.
- [ ] Return the top 2 highest-paid employees per department using ROW_NUMBER and an outer filter.
- [ ] Find the second-highest distinct salary company-wide with DENSE_RANK, and confirm RANK gives a different answer when the top is tied.
- [ ] Build a 3-row trailing moving average of daily revenue, then change it to a cumulative running total and diff the two.
- [ ] Add FIRST_VALUE and a correctly-framed LAST_VALUE per department; demonstrate the LAST_VALUE default-frame bug and fix it.

## 11. Cheat Sheet

> [!TIP]
> **Ranking:** `ROW_NUMBER` = unique (add a tiebreaker!); `RANK` = ties share, then skip (1,2,2,4); `DENSE_RANK` = ties share, no skip (1,2,2,3) → use for "Nth distinct"; `NTILE(n)` = n even buckets. **Navigate:** `LAG/LEAD(col,k,default)` prev/next; `FIRST_VALUE/LAST_VALUE/NTH_VALUE`. **Frame:** `ROWS` = physical rows, `RANGE` = value peers, `GROUPS` = peer-groups. **Default frame** (ORDER BY, no frame) = `RANGE UNBOUNDED PRECEDING→CURRENT ROW` and pulls in tie-peers — for running totals write `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`; for `LAST_VALUE` write `… AND UNBOUNDED FOLLOWING`. Trailing N = `ROWS BETWEEN N-1 PRECEDING AND CURRENT ROW`. Top-N/group = `ROW_NUMBER … WHERE rn<=N` in an outer query. Index `(partition, order)` to kill the Sort. See topic 13 for the OVER/PARTITION basics.

**References:** PostgreSQL Docs — "Window Function Calls" (frame_clause) & "Window Functions Tutorial"; MySQL 8.0 Reference — "Window Function Concepts and Syntax"; Modern SQL (Markus Winand) — "OVER and frame clause"; Use The Index, Luke — "Window Functions"; LeetCode Database — "Rank Scores" / "Department Top Three Salaries"

---
*SQL Handbook — topic 14.*
