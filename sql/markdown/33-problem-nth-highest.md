# 33 · Problem: Nth-Highest Salary

> **In one line:** Return the Nth-highest salary, correctly collapsing ties and yielding `NULL` when fewer than N distinct salaries exist.

---

## 1. Problem

Given an `employee` table, return the **Nth-highest distinct salary**. If there is no Nth-highest salary (fewer than N distinct values), return `NULL`. This is the classic LeetCode "Nth Highest Salary" / "Second Highest Salary" family.

```sql
CREATE TABLE employee (
    id      INT PRIMARY KEY,
    name    VARCHAR(50) NOT NULL,
    salary  INT NOT NULL
);
```

**Sample input — `employee`:**

| id | name    | salary |
|----|---------|--------|
| 1  | Ava     | 300    |
| 2  | Ben     | 200    |
| 3  | Cara    | 300    |
| 4  | Dan     | 100    |
| 5  | Eve     | 200    |

**Expected output** for **N = 2** (second-highest *distinct* salary):

| second_highest_salary |
|-----------------------|
| 200                   |

The distinct salaries are `{300, 200, 100}`. Rank 1 = 300, rank 2 = **200**, rank 3 = 100. Note `300` appears twice but counts once. For **N = 4** the result is a single row containing `NULL`.

---

## 2. Approach

Two dominant patterns:

- **`DENSE_RANK()`** — rank distinct salary values (ties share a rank, no gaps), then filter to `rank = N`. `DENSE_RANK` is the correct ranking function here because "distinct salary" means duplicate salaries must not consume a rank slot. `RANK()` would leave gaps (1,1,3,…) and break "Nth **distinct**". `ROW_NUMBER()` would treat the two `300`s as ranks 1 and 2, wrongly returning `300` as the "2nd highest".
- **`LIMIT / OFFSET`** — sort the *distinct* salaries descending and skip `N-1` rows. Simple and index-friendly, but needs a `DISTINCT` and careful `OFFSET = N-1` arithmetic.

The subtle requirement is the **`NULL` when absent** rule. A bare `SELECT … LIMIT 1 OFFSET N-1` returns *zero rows*, not a row containing `NULL`. To force a single `NULL` row we wrap the query as a scalar subquery: `SELECT ( … ) AS result`, which always yields exactly one row.

---

## 3. Solution

Canonical `DENSE_RANK` solution, parameterized by `:N`:

```sql
-- Nth-highest DISTINCT salary; returns NULL if it doesn't exist.
SELECT (
    SELECT DISTINCT salary
    FROM (
        SELECT salary,
               DENSE_RANK() OVER (ORDER BY salary DESC) AS rnk
        FROM employee
    ) ranked
    WHERE rnk = 2          -- <-- N
) AS second_highest_salary;
```

The outer `SELECT ( subquery )` is a **scalar subquery**: if the inner query returns no rows, the scalar evaluates to `NULL` and we still emit one row. That single trick satisfies the "no Nth ⇒ NULL" rule for free.

MySQL's LeetCode framing wraps it in a function so `N` is a real parameter:

```sql
CREATE FUNCTION getNthHighestSalary(N INT) RETURNS INT
BEGIN
  RETURN (
    SELECT DISTINCT salary
    FROM (
      SELECT salary, DENSE_RANK() OVER (ORDER BY salary DESC) AS rnk
      FROM employee
    ) t
    WHERE rnk = N
  );
END;
```

---

## 4. Walkthrough

Using the sample data, the inner window query produces:

| salary | rnk |
|--------|-----|
| 300    | 1   |
| 300    | 1   |
| 200    | 2   |
| 200    | 2   |
| 100    | 3   |

`DENSE_RANK() OVER (ORDER BY salary DESC)` assigns the *same* rank to equal salaries and **does not skip** the next integer, so ranks run 1, 2, 3 — not 1, 1, 3.

Filtering `WHERE rnk = 2` keeps the two `200` rows; `SELECT DISTINCT salary` collapses them to a single `200`. The outer scalar wrapper returns that value: **200**.

For `N = 4`, no row has `rnk = 4`, the inner query is empty, the scalar subquery evaluates to `NULL`, and we output one row: `NULL`. Exactly the contract.

```svg
<svg viewBox="0 0 640 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="20" y="24" text-anchor="start" fill="#1e293b" font-weight="bold">DENSE_RANK vs RANK vs ROW_NUMBER on salaries [300,300,200,200,100]</text>
  <g>
    <text x="120" y="60" text-anchor="middle" fill="#64748b">salary</text>
    <text x="260" y="60" text-anchor="middle" fill="#2563eb">DENSE_RANK</text>
    <text x="400" y="60" text-anchor="middle" fill="#d97706">RANK</text>
    <text x="540" y="60" text-anchor="middle" fill="#059669">ROW_NUMBER</text>
  </g>
  <g fill="#1e293b" text-anchor="middle">
    <text x="120" y="88">300</text><text x="260" y="88">1</text><text x="400" y="88">1</text><text x="540" y="88">1</text>
    <text x="120" y="112">300</text><text x="260" y="112">1</text><text x="400" y="112">1</text><text x="540" y="112">2</text>
    <text x="120" y="136">200</text><text x="260" y="136">2</text><text x="400" y="136">3</text><text x="540" y="136">3</text>
    <text x="120" y="160">200</text><text x="260" y="160">2</text><text x="400" y="160">3</text><text x="540" y="160">4</text>
    <text x="120" y="184">100</text><text x="260" y="184">3</text><text x="400" y="184">5</text><text x="540" y="184">5</text>
  </g>
  <rect x="222" y="70" width="76" height="122" rx="8" fill="none" stroke="#2563eb" stroke-width="2"/>
  <text x="260" y="205" text-anchor="middle" fill="#2563eb" font-size="11">correct: no gaps</text>
</svg>
```

---

## 5. Variations & Follow-ups

**LIMIT/OFFSET variant** (Nth distinct = skip N−1 distinct rows):

```sql
SELECT (
  SELECT DISTINCT salary
  FROM employee
  ORDER BY salary DESC
  LIMIT 1 OFFSET 1        -- OFFSET = N-1
) AS second_highest_salary;
```

**Non-distinct (Nth-highest row, ties count separately)** — swap `DENSE_RANK` for `ROW_NUMBER`:

```sql
SELECT salary
FROM (SELECT salary, ROW_NUMBER() OVER (ORDER BY salary DESC) rn FROM employee) t
WHERE rn = 2;   -- would return 300 here, since the 2nd row is still 300
```

**Nth-highest per department** — add `PARTITION BY department_id` to the window (see *Problem: Top-N Per Group*).

**Return NULL explicitly with a fallback** — `COALESCE((subquery), NULL)` is redundant but sometimes required for typed columns in strict engines.

---

## 6. Alternative Solutions

**Correlated-subquery / self-count** approach — for the Nth-highest, count how many *distinct* salaries are strictly greater:

```sql
SELECT DISTINCT e.salary
FROM employee e
WHERE (SELECT COUNT(DISTINCT e2.salary)
       FROM employee e2
       WHERE e2.salary > e.salary) = 1;   -- N-1 salaries above it
```

This is the pre-window-function classic (works on MySQL 5.x, old SQLite). It reads well but is **O(n²)**: for each candidate row it rescans the table to count greater salaries.

| Approach | Pros | Cons | Best when |
|----------|------|------|-----------|
| `DENSE_RANK()` | Handles ties = distinct correctly; single scan + sort; N is a clean predicate | Needs window-function support (PG, MySQL 8+, SQLite 3.25+) | Default choice; modern engines |
| `LIMIT/OFFSET` + `DISTINCT` | Simplest; sort can stop early (Top-N heap); index-friendly | `OFFSET = N−1` off-by-one trap; empty set unless wrapped for NULL | Small N, indexed salary |
| Correlated `COUNT(DISTINCT …)` | Runs on ancient engines; no window functions | O(n²); slow at scale; awkward NULL handling | Legacy DBs only |

---

## 7. Performance & Indexes

For all approaches, an index on `salary` is the lever:

```sql
CREATE INDEX idx_employee_salary ON employee (salary DESC);
```

- **LIMIT/OFFSET**: with the index, the planner does a **backward index scan** and stops after N distinct values — near O(N) for small N, no full sort. This is the cheapest at scale for small N.
- **DENSE_RANK**: the window function must read all qualifying rows and sort them (or scan the index in order). Cost is dominated by the sort ≈ O(n log n), or O(n) if it walks the ordered index. The whole set is ranked even though you want one rank — but a single ordered pass is cheap.
- **Correlated count**: O(n²); the index on `salary` turns each inner count into an index range scan but you still pay per outer row. Avoid for large tables.

`EXPLAIN` tell: look for `WindowAgg` over an `Index Scan` (good) vs a `Seq Scan` + `Sort` (add the index), and for the correlated form, a nested `SubPlan` executed once per row (the O(n²) smell).

---

## 8. Common Mistakes

1. ⚠️ **Using `ROW_NUMBER` for "Nth distinct".** Two employees at 300 become ranks 1 and 2, so "2nd highest" wrongly returns 300. **Fix:** use `DENSE_RANK`.
2. ⚠️ **`RANK` instead of `DENSE_RANK`.** `RANK` leaves gaps (1,1,3), so `rnk = 2` finds nothing when there's a tie at the top. **Fix:** `DENSE_RANK` for contiguous ranks.
3. ⚠️ **Forgetting the scalar wrapper.** `SELECT salary … WHERE rnk = 4` returns zero rows, not `NULL`. **Fix:** wrap as `SELECT ( … )`.
4. ⚠️ **`OFFSET N` instead of `OFFSET N−1`.** For N=2 you must skip 1 row. **Fix:** `OFFSET N-1`.
5. ⚠️ **Missing `DISTINCT` in LIMIT/OFFSET.** Duplicate salaries make you skip the wrong rows. **Fix:** `SELECT DISTINCT salary … ORDER BY salary DESC`.
6. ⚠️ **`MAX(salary) WHERE salary < MAX(salary)` only works for N=2.** It doesn't generalize to arbitrary N. **Fix:** rank-based solution.

---

## 9. Interview Follow-ups

**Q: Why `DENSE_RANK` rather than `RANK` or `ROW_NUMBER` for the Nth-highest distinct salary?**
A: `DENSE_RANK` gives ties the same rank and no gaps, so distinct salary values map to 1,2,3…; `RANK` leaves gaps that make `rnk=N` miss values after a tie, and `ROW_NUMBER` treats duplicate salaries as separate ranks, breaking the "distinct" requirement.

**Q: How do you return `NULL` instead of an empty result when there is no Nth salary?**
A: Wrap the row-returning query in a scalar subquery: `SELECT ( SELECT … WHERE rnk = N )`. A scalar subquery with no rows evaluates to `NULL` and the outer query still emits exactly one row.

**Q: How do you parameterize N safely?**
A: Bind it as a query parameter (`WHERE rnk = ?`) or, in MySQL's LeetCode form, a stored-function argument; never string-concatenate N into SQL. In `LIMIT/OFFSET` engines, pass it as `OFFSET N-1` — some engines disallow expressions in OFFSET, so compute N−1 in the application.

**Q: What's the difference between "Nth-highest distinct salary" and "salary of the Nth-highest-paid employee"?**
A: Distinct uses `DENSE_RANK` and collapses ties to one value; "Nth-highest-paid employee" is row-oriented and uses `ROW_NUMBER`, where two people earning the same top salary occupy ranks 1 and 2. Clarify which the interviewer means before coding.

**Q: Compare the cost of the window-function solution vs the correlated `COUNT(DISTINCT)` solution.**
A: The window solution is one scan plus a sort, ≈ O(n log n) (or O(n) walking an ordered index). The correlated count rescans the table for every candidate row, ≈ O(n²). At millions of rows the correlated form is orders of magnitude slower.

**Q: Which index helps, and how does it change the plan for LIMIT/OFFSET?**
A: An index on `salary` (ideally `DESC`) lets the planner do a backward index scan and stop after N distinct values instead of sorting the whole table — turning Top-N into roughly O(N) with early termination.

**Q: The salary column is nullable. What breaks?**
A: `NULL` salaries sort last under `ORDER BY salary DESC` in PostgreSQL (NULLS LAST for DESC) but first in some engines, and `salary > e.salary` in the correlated form treats NULL as unknown (never counted). Filter `WHERE salary IS NOT NULL` first, or specify `NULLS LAST` explicitly.

**Q: How would you extend this to the Nth-highest salary per department?**
A: Add `PARTITION BY department_id` to the window: `DENSE_RANK() OVER (PARTITION BY department_id ORDER BY salary DESC)`, then filter `rnk = N`. This is the Top-N-per-group generalization.

**Q: For N=2 specifically, is there a simpler query, and why not use it generally?**
A: `SELECT MAX(salary) FROM employee WHERE salary < (SELECT MAX(salary) FROM employee)` works for the 2nd-highest and returns `NULL` naturally. It doesn't generalize to arbitrary N and requires nesting a `MAX` per level, so the rank-based form is preferred.

**Q: Does `LIMIT/OFFSET` guarantee a deterministic result?**
A: Only if the `ORDER BY` fully determines order. With ties in salary you must `SELECT DISTINCT salary` (ordering by the value itself) so the skipped rows are well-defined; otherwise the OFFSET may land on an arbitrary duplicate.

---

## 10. Cheat Sheet

> [!TIP]
> **Nth-highest salary pattern**
> - Nth-highest **distinct** ⇒ `DENSE_RANK() OVER (ORDER BY salary DESC)`, filter `rnk = N`.
> - Return `NULL` when absent ⇒ wrap in a **scalar subquery** `SELECT ( … )`.
> - Simple alt ⇒ `SELECT DISTINCT salary … ORDER BY salary DESC LIMIT 1 OFFSET N-1`.
> - Ranking choice: `DENSE_RANK` (no gaps, ties merge) vs `RANK` (gaps) vs `ROW_NUMBER` (ties split).
> - Index `salary DESC` ⇒ backward scan + early stop for LIMIT/OFFSET.
> - Avoid correlated `COUNT(DISTINCT …)` at scale — it's O(n²).

**References:** PostgreSQL docs — Window Functions; MySQL 8 Reference — Window Function Concepts; LeetCode — "Nth Highest Salary"; Use The Index, Luke — Top-N Queries.

---
*SQL Handbook — topic 33.*
