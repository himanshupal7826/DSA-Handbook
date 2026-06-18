# 05 · Window Functions

> **In one line:** Per-row calculations over a related set without collapsing rows.

---

## 1. Overview

Window functions compute values across a set of rows related to the current row (the *window*) **without** collapsing them like GROUP BY. They power running totals, rankings, and row-to-row comparisons.

## 2. Key Concepts

- `OVER (PARTITION BY ... ORDER BY ...)` defines the window.
- ROW_NUMBER (unique), RANK (gaps on ties), DENSE_RANK (no gaps).
- LAG/LEAD access previous/next rows.
- Running aggregates: SUM(...) OVER (ORDER BY ...).

## 3. Syntax & Code

```sql
-- Top 3 highest-paid employees per department
SELECT * FROM (
  SELECT name, dept_id, salary,
         ROW_NUMBER() OVER (PARTITION BY dept_id ORDER BY salary DESC) AS rn
  FROM employees
) t
WHERE rn <= 3;
```

## 4. Worked Example

**Running total and month-over-month change**

Cumulative revenue plus delta vs previous month:

```sql
SELECT month, revenue,
  SUM(revenue) OVER (ORDER BY month) AS running_total,
  revenue - LAG(revenue) OVER (ORDER BY month) AS mom_change
FROM monthly_revenue;
```

## 5. Best Practices

- ✅ Use ROW_NUMBER for deterministic top-N per group.
- ✅ Choose RANK vs DENSE_RANK based on how ties should number.
- ✅ Add a frame clause (ROWS BETWEEN) for precise running windows.
- ✅ Filter window results in an outer query (can't use the alias in WHERE).
- ✅ Partition to reset calculations per group.

## 6. Common Pitfalls

1. ⚠️ Referencing a window alias in the same WHERE (not allowed — wrap in subquery).
2. ⚠️ Confusing RANK (gaps) with DENSE_RANK (no gaps).
3. ⚠️ Omitting ORDER BY in a running aggregate gives the whole-partition sum.
4. ⚠️ Default frame is RANGE to current row — surprises with duplicate ORDER BY values.
5. ⚠️ Heavy windows over huge partitions can be expensive.
6. ⚠️ Mixing GROUP BY and window expecting the same grouping.

## 7. Interview Questions

1. **Q: Window function vs GROUP BY?**
   A: Windows compute per-row over a set without collapsing rows; GROUP BY returns one row per group.

2. **Q: ROW_NUMBER vs RANK vs DENSE_RANK?**
   A: ROW_NUMBER is always unique; RANK leaves gaps after ties; DENSE_RANK leaves no gaps.

3. **Q: How to get top-N per group?**
   A: ROW_NUMBER() OVER (PARTITION BY g ORDER BY metric) then filter rn <= N.

4. **Q: What does LAG do?**
   A: Returns a column value from a previous row in the ordered window.

5. **Q: Why wrap windows in a subquery to filter?**
   A: Window functions are evaluated after WHERE, so you filter their output in an outer query.

6. **Q: What is a window frame?**
   A: ROWS/RANGE BETWEEN ... that bounds which rows the aggregate sees relative to the current row.

7. **Q: Running total query?**
   A: SUM(x) OVER (ORDER BY t ROWS UNBOUNDED PRECEDING).

8. **Q: Default frame gotcha?**
   A: RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW groups ties together.

## 8. Practice

- [ ] Rank products by sales within each category.
- [ ] Compute a 7-row moving average.
- [ ] Find each user's first and latest order with FIRST_VALUE/LAST_VALUE.

## 9. Quick Revision

OVER(PARTITION BY..ORDER BY..) computes per-row without collapsing. ROW_NUMBER unique, RANK gaps, DENSE_RANK no gaps; LAG/LEAD peek neighbors; filter windows in an outer query.

**References:** OVER() clause

---

*SQL Handbook — topic 05.*
