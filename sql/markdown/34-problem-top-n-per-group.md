# 34 · Problem: Top-N Per Group

> **In one line:** Return the highest-paid employee(s) in each department — the canonical "greatest-N-per-group" problem, solved with partitioned window functions and its subquery/LATERAL alternatives.

---

## 1. Problem

Given `employee` and `department`, return, **for each department, the employee(s) with the highest salary**. If several employees tie for the top salary in a department, return all of them. This is LeetCode "Department Highest Salary" and the general **Top-N-per-group** pattern (here N = 1, with the tie rule spelled out).

```sql
CREATE TABLE department (
    id    INT PRIMARY KEY,
    name  VARCHAR(50) NOT NULL
);

CREATE TABLE employee (
    id             INT PRIMARY KEY,
    name           VARCHAR(50) NOT NULL,
    salary         INT NOT NULL,
    department_id  INT NOT NULL REFERENCES department(id)
);
```

**Sample input — `department`:**

| id | name        |
|----|-------------|
| 1  | Engineering |
| 2  | Sales       |

**Sample input — `employee`:**

| id | name  | salary | department_id |
|----|-------|--------|---------------|
| 1  | Ava   | 90000  | 1             |
| 2  | Ben   | 90000  | 1             |
| 3  | Cara  | 80000  | 1             |
| 4  | Dan   | 70000  | 2             |
| 5  | Eve   | 60000  | 2             |

**Expected output** (top earner per department; Engineering has a tie):

| department | employee | salary |
|------------|----------|--------|
| Engineering | Ava     | 90000  |
| Engineering | Ben     | 90000  |
| Sales       | Dan     | 70000  |

---

## 2. Approach

The core move is to **rank rows within each group** and keep the top ones. Options:

- **`RANK() OVER (PARTITION BY department_id ORDER BY salary DESC)`** — assigns rank 1 to the max salary in each department; ties share rank 1, so `WHERE rnk = 1` returns *all* tied top earners. This matches the "include ties" contract exactly.
- **`ROW_NUMBER()`** — picks *exactly one* winner per group (arbitrary among ties). Use when you want precisely N rows and don't care which tie survives, or when a tiebreaker column makes it deterministic.
- **`DENSE_RANK()`** — for **Top-N distinct salaries** per group (e.g., "the two highest *pay levels* per department"), where ties don't consume a slot.
- **Correlated subquery** — `WHERE salary = (SELECT MAX(salary) … WHERE same department)`; classic, no window functions, naturally returns ties.
- **`LATERAL` / `CROSS APPLY`** — for each department, run a small `ORDER BY … LIMIT N` subquery; excellent when an index makes each per-group lookup a cheap Top-N.

Choosing the ranking function is the whole interview: **RANK vs ROW_NUMBER vs DENSE_RANK** encodes your tie policy.

---

## 3. Solution

Canonical partitioned-`RANK` solution (includes ties, generalizes to Top-N):

```sql
SELECT department, employee, salary
FROM (
    SELECT d.name                                         AS department,
           e.name                                         AS employee,
           e.salary,
           RANK() OVER (PARTITION BY e.department_id
                        ORDER BY e.salary DESC)            AS rnk
    FROM employee e
    JOIN department d ON d.id = e.department_id
) ranked
WHERE rnk = 1               -- rnk <= N for Top-N; RANK keeps ties
ORDER BY department, employee;
```

`PARTITION BY e.department_id` restarts the ranking per department; `ORDER BY e.salary DESC` makes rank 1 the highest paid. Filtering in an outer query is required because you **cannot** put a window function in a `WHERE` clause (it's computed after `WHERE`).

---

## 4. Walkthrough

The inner query produces one ranked row per employee:

| department  | employee | salary | rnk |
|-------------|----------|--------|-----|
| Engineering | Ava      | 90000  | 1   |
| Engineering | Ben      | 90000  | 1   |
| Engineering | Cara     | 80000  | 3   |
| Sales       | Dan      | 70000  | 1   |
| Sales       | Eve      | 60000  | 2   |

Within **Engineering**, Ava and Ben both earn 90000, so `RANK` gives both rank 1 and skips to rank 3 for Cara. Within **Sales**, Dan is rank 1, Eve rank 2. The outer `WHERE rnk = 1` keeps Ava, Ben, and Dan — precisely the expected output, ties preserved.

Had we used `ROW_NUMBER`, Engineering would emit only *one* of Ava/Ben (whichever the engine ordered first), silently dropping a legitimate top earner.

```svg
<svg viewBox="0 0 640 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="20" y="22" fill="#1e293b" font-weight="bold">PARTITION BY department_id — ranking restarts per group</text>
  <!-- Engineering partition -->
  <rect x="30" y="40" width="270" height="180" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="165" y="60" text-anchor="middle" fill="#2563eb" font-weight="bold">Engineering</text>
  <text x="165" y="90" text-anchor="middle" fill="#1e293b">Ava  90000  → rnk 1 ✓</text>
  <text x="165" y="118" text-anchor="middle" fill="#1e293b">Ben  90000  → rnk 1 ✓</text>
  <text x="165" y="146" text-anchor="middle" fill="#64748b">Cara 80000  → rnk 3</text>
  <text x="165" y="186" text-anchor="middle" fill="#059669" font-size="11">tie at top: RANK keeps both</text>
  <!-- Sales partition -->
  <rect x="330" y="40" width="270" height="180" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="465" y="60" text-anchor="middle" fill="#059669" font-weight="bold">Sales</text>
  <text x="465" y="90" text-anchor="middle" fill="#1e293b">Dan 70000 → rnk 1 ✓</text>
  <text x="465" y="118" text-anchor="middle" fill="#64748b">Eve 60000 → rnk 2</text>
  <text x="465" y="186" text-anchor="middle" fill="#64748b" font-size="11">WHERE rnk = 1</text>
</svg>
```

---

## 5. Variations & Follow-ups

**Top-N (e.g., 3 highest per department):** change the predicate.

```sql
... WHERE rnk <= 3   -- RANK: "the top-3 pay ranks, ties included"
```

**Exactly one winner per group (deterministic tiebreak):** use `ROW_NUMBER` with a tiebreaker.

```sql
ROW_NUMBER() OVER (PARTITION BY department_id
                   ORDER BY salary DESC, id ASC)   -- lowest id wins ties
... WHERE rn = 1
```

**Top-N distinct pay levels per group:** use `DENSE_RANK` so equal salaries share a level and don't burn a slot.

```sql
DENSE_RANK() OVER (PARTITION BY department_id ORDER BY salary DESC) ... WHERE lvl <= 2
```

**Lowest-paid per group:** flip to `ORDER BY salary ASC`.

**Empty departments:** the inner `JOIN` drops departments with no employees; use a `LEFT JOIN` from `department` if you must list them.

---

## 6. Alternative Solutions

**Correlated-subquery** (no window functions; naturally includes ties):

```sql
SELECT d.name AS department, e.name AS employee, e.salary
FROM employee e
JOIN department d ON d.id = e.department_id
WHERE e.salary = (
    SELECT MAX(e2.salary)
    FROM employee e2
    WHERE e2.department_id = e.department_id
);
```

**`LATERAL` join** (PostgreSQL; `CROSS APPLY` in SQL Server) — Top-N per group with early stop:

```sql
SELECT d.name AS department, top.name AS employee, top.salary
FROM department d
CROSS JOIN LATERAL (
    SELECT e.name, e.salary
    FROM employee e
    WHERE e.department_id = d.id
    ORDER BY e.salary DESC
    LIMIT 1                 -- N; use a tiebreaker or fetch WITH TIES
) AS top;
```

| Approach | Ties | Top-N (N>1) | Perf profile | Best when |
|----------|------|-------------|--------------|-----------|
| `RANK() OVER PARTITION` | Keeps all ties (`rnk<=N`) | Trivial: change predicate | One scan + partitioned sort, O(n log n) | Default; N>1; want ties |
| `ROW_NUMBER() OVER PARTITION` | One row (tiebreak needed) | `rn<=N` | Same as RANK | Need exactly N deterministic rows |
| Correlated `MAX` subquery | Keeps ties naturally | Awkward for N>1 | O(n·g) or O(n²) without index | N=1, legacy engines |
| `LATERAL` / `CROSS APPLY` | Depends on inner `ORDER BY`/`FETCH WITH TIES` | Native `LIMIT N` | O(g · log rows) with index — often best | Few groups, indexed `(dept, salary)` |

The `LATERAL` form shines when there are **few groups but many rows per group** and you have an index on `(department_id, salary DESC)`: each group becomes an index-driven Top-N with early termination.

---

## 7. Performance & Indexes

Build a **composite covering index** matching partition + order:

```sql
CREATE INDEX idx_emp_dept_salary ON employee (department_id, salary DESC, name);
```

- **Window functions**: the planner can feed the window from this index in `(department_id, salary DESC)` order, avoiding an explicit sort — you'll see `WindowAgg` over an `Index Scan` instead of `Sort`. Still processes every row once.
- **LATERAL**: for each department the inner query is an index range scan on `department_id` that stops after N rows — roughly O(groups × N) index descents. With few departments this beats scanning all employees.
- **Correlated `MAX`**: the same composite index turns each inner `MAX(salary)` into a single index-boundary lookup (O(1) per group), but the outer scan still touches every row to compare, and without the index it degrades toward O(n²).

`EXPLAIN` tells: `WindowAgg` + `Index Scan` (no `Sort`) is the good window plan; a nested `Subquery Scan` / `SubPlan` per row is the correlated pattern; `Nested Loop` with an inner `Limit` over `Index Scan` is the LATERAL plan.

```svg
<svg viewBox="0 0 640 170" width="100%" height="170" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="20" y="22" fill="#1e293b" font-weight="bold">LATERAL Top-1 per department (few groups, indexed)</text>
  <rect x="30" y="45" width="150" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="105" y="70" text-anchor="middle" fill="#1e293b">department (scan)</text>
  <line x1="180" y1="65" x2="240" y2="65" stroke="#475569" marker-end="url(#a)"/>
  <rect x="240" y="45" width="200" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="340" y="70" text-anchor="middle" fill="#1e293b">for each dept:</text>
  <text x="340" y="92" text-anchor="middle" fill="#64748b" font-size="12">Index Scan (dept,salary DESC)</text>
  <text x="340" y="108" text-anchor="middle" fill="#059669" font-size="11">LIMIT 1 — early stop</text>
  <line x1="440" y1="80" x2="500" y2="80" stroke="#475569" marker-end="url(#a)"/>
  <rect x="500" y="55" width="110" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="555" y="80" text-anchor="middle" fill="#1e293b">top earner</text>
  <defs><marker id="a" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="#475569"/></marker></defs>
</svg>
```

---

## 8. Common Mistakes

1. ⚠️ **Putting the window function in `WHERE`.** `WHERE RANK() OVER (…) = 1` is illegal — windows are evaluated after `WHERE`. **Fix:** rank in a subquery/CTE, filter in the outer query.
2. ⚠️ **`ROW_NUMBER` when ties must be kept.** It silently drops co-top-earners. **Fix:** `RANK` (or `DENSE_RANK`) for "include ties".
3. ⚠️ **Forgetting `PARTITION BY`.** You then rank globally and return only the single highest-paid employee in the whole company. **Fix:** partition by the group key.
4. ⚠️ **Correlated `MAX` without matching the department.** Omitting `WHERE e2.department_id = e.department_id` compares against the global max. **Fix:** correlate on the group key.
5. ⚠️ **`INNER JOIN` hiding empty groups** when the task says "every department". **Fix:** drive from `department` with `LEFT JOIN`/`LATERAL`.
6. ⚠️ **Assuming `LIMIT 1` handles ties.** It picks one arbitrary top row. **Fix:** `FETCH FIRST 1 ROWS WITH TIES` (PG 13+/standard) or rank-based filtering.

---

## 9. Interview Follow-ups

**Q: Why can't you filter on a window function directly in the `WHERE` clause?**
A: Window functions are logically evaluated after `WHERE`/`GROUP BY`/`HAVING`, so the rank isn't available yet. You must compute it in a subquery or CTE and filter the result in an enclosing query.

**Q: When do you use `RANK` vs `ROW_NUMBER` vs `DENSE_RANK` for Top-N-per-group?**
A: `RANK` (filter `rnk<=N`) keeps all ties, so you may get more than N rows; `ROW_NUMBER` returns exactly N rows but needs a tiebreaker to be deterministic; `DENSE_RANK` selects the top-N *distinct* values (ties don't consume a slot), useful for "top-N pay levels".

**Q: How do you make `ROW_NUMBER` deterministic under ties?**
A: Add tiebreaker columns to the `ORDER BY`, e.g. `ORDER BY salary DESC, id ASC`, so equal salaries are broken by a unique column and the same row wins every run.

**Q: Give the LATERAL/CROSS APPLY solution and say when it wins.**
A: `SELECT … FROM department d CROSS JOIN LATERAL (SELECT … FROM employee WHERE department_id = d.id ORDER BY salary DESC LIMIT N) t`. It wins when there are few groups and many rows per group with an index on `(department_id, salary DESC)`, because each group is an index Top-N with early termination instead of ranking every row.

**Q: What index best supports the partitioned window plan and why?**
A: A composite index on `(department_id, salary DESC)` (optionally covering `name`) lets the engine read rows already in partition-and-order sequence, so `WindowAgg` runs without an explicit `Sort` — the single biggest cost saver.

**Q: How does the correlated-subquery solution scale compared to the window solution?**
A: With the right index the correlated `MAX` is a boundary lookup per group, but the outer query still scans every employee to compare; without the index it approaches O(n²). The window solution is a single scan plus one partitioned sort, O(n log n), and is more predictable.

**Q: How would you return the top-3 earners per department including ties?**
A: Use `RANK() OVER (PARTITION BY department_id ORDER BY salary DESC)` and filter `WHERE rnk <= 3`; ties at any rank are all included, so a three-way tie for 3rd returns all of them.

**Q: The task says "list every department, even those with no employees." How do you adjust?**
A: Drive from `department` with a `LEFT JOIN` (or `LEFT JOIN LATERAL … ON true`) so departments with no matching employees still appear, with `NULL` employee/salary.

**Q: Two employees tie for the top salary and the interviewer wants only one, deterministically. What do you change?**
A: Switch from `RANK` to `ROW_NUMBER` with a tiebreaker in the `ORDER BY` (e.g. earliest `hire_date`, then `id`), and filter `rn = 1`.

**Q: How would you get the second-highest-paid employee per department?**
A: Use `DENSE_RANK() OVER (PARTITION BY department_id ORDER BY salary DESC)` and filter `= 2` for the second-highest *distinct* salary, or `ROW_NUMBER` filtered `= 2` for the literal second row.

---

## 10. Cheat Sheet

> [!TIP]
> **Top-N-per-group (greatest-N-per-group)**
> - Pattern: `func() OVER (PARTITION BY group ORDER BY metric DESC)`, filter in outer query.
> - `RANK` ⇒ Top-N **with ties** (`rnk<=N`); `ROW_NUMBER` ⇒ **exactly N** (add tiebreaker); `DENSE_RANK` ⇒ Top-N **distinct** levels.
> - Windows can't go in `WHERE` — rank in a CTE/subquery, filter outside.
> - Index `(group_key, metric DESC)` ⇒ no sort for the window; enables LATERAL Top-N.
> - Few groups + many rows ⇒ `CROSS JOIN LATERAL (… ORDER BY … LIMIT N)` with early stop.
> - Keep ties in `LIMIT` land via `FETCH FIRST N ROWS WITH TIES`.

**References:** PostgreSQL docs — Window Functions & `LATERAL`; MySQL 8 Reference — Window Functions; Use The Index, Luke — Top-N & Pagination; LeetCode — "Department Highest Salary".

---
*SQL Handbook — topic 34.*
