# 03 · GROUP BY & Aggregates

> **In one line:** Summarize rows into per-group metrics.

---

## 1. Overview

Aggregate functions (`COUNT`, `SUM`, `AVG`, `MIN`, `MAX`) collapse many rows into one value. `GROUP BY` produces one output row per group; `HAVING` filters those groups.

## 2. Key Concepts

- Every non-aggregated SELECT column must appear in GROUP BY (standard SQL).
- COUNT(*) counts rows; COUNT(col) ignores NULLs.
- HAVING filters aggregated groups; WHERE filters rows first (more efficient).
- Aggregates ignore NULLs (except COUNT(*)).

## 3. Syntax & Code

```sql
-- Revenue per category, only categories above $10k
SELECT category_id, SUM(total) AS revenue, COUNT(*) AS orders
FROM order_lines
WHERE status = 'paid'
GROUP BY category_id
HAVING SUM(total) > 10000
ORDER BY revenue DESC;
```

## 4. Worked Example

**Average order value per month**

Group by a truncated date:

```sql
SELECT date_trunc('month', created_at) AS month,
       AVG(total) AS avg_order
FROM orders
GROUP BY 1
ORDER BY 1;
```

## 5. Best Practices

- ✅ Filter early with WHERE before grouping to reduce work.
- ✅ Use HAVING only for conditions on aggregates.
- ✅ COUNT(*) for row counts; COUNT(DISTINCT x) for unique values.
- ✅ Alias aggregate columns for clarity.
- ✅ Group by the smallest necessary key set.

## 6. Common Pitfalls

1. ⚠️ Selecting a non-grouped, non-aggregated column (error or wrong value in MySQL's loose mode).
2. ⚠️ Using HAVING where WHERE would be cheaper.
3. ⚠️ COUNT(col) silently dropping NULL rows when you meant COUNT(*).
4. ⚠️ AVG over NULLs ignoring them, skewing results.
5. ⚠️ Grouping by an expression but ordering by another.
6. ⚠️ Forgetting DISTINCT in COUNT(DISTINCT ...) for uniques.

## 7. Interview Questions

1. **Q: WHERE vs HAVING — efficiency?**
   A: WHERE filters before aggregation (fewer rows to group); HAVING filters after. Push conditions to WHERE when possible.

2. **Q: COUNT(*) vs COUNT(col)?**
   A: COUNT(*) counts all rows; COUNT(col) counts non-NULL values of col.

3. **Q: Why must non-aggregated columns be in GROUP BY?**
   A: To define a single deterministic value per group; otherwise the value is ambiguous.

4. **Q: How do aggregates treat NULL?**
   A: They ignore NULLs, except COUNT(*) which counts every row.

5. **Q: How to count unique customers?**
   A: COUNT(DISTINCT customer_id).

6. **Q: Can you use an aggregate in WHERE?**
   A: No — aggregates aren't available until after grouping; use HAVING.

7. **Q: How to get per-group top-N?**
   A: Window functions (ROW_NUMBER partitioned by group).

8. **Q: GROUP BY with ROLLUP?**
   A: Adds subtotal/grand-total rows for hierarchical summaries.

## 8. Practice

- [ ] Count orders per status.
- [ ] Find categories with more than 100 distinct buyers.
- [ ] Compute monthly revenue and order count.

## 9. Quick Revision

Aggregates collapse rows; GROUP BY = one row per group; HAVING filters groups; WHERE filters rows first. COUNT(*) counts all, COUNT(col)/AVG ignore NULL.

**References:** SQL standard aggregates

---

*SQL Handbook — topic 03.*
