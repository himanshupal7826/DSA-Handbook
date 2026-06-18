# 04 · Subqueries & CTEs

> **In one line:** Compose queries with nested SELECTs and named WITH clauses.

---

## 1. Overview

A **subquery** is a query nested inside another. A **CTE** (`WITH name AS (...)`) names a subquery for readability and reuse, and enables recursion. Correlated subqueries reference the outer query and run per outer row.

## 2. Key Concepts

- Scalar subquery returns one value; row/table subqueries return sets.
- `EXISTS` short-circuits and is often faster than `IN` for large/NULL-prone sets.
- CTEs improve readability and can be referenced multiple times.
- Recursive CTEs traverse hierarchies/graphs.

## 3. Syntax & Code

```sql
WITH paid AS (
  SELECT customer_id, SUM(total) AS spend
  FROM orders WHERE status = 'paid'
  GROUP BY customer_id
)
SELECT c.name, paid.spend
FROM paid JOIN customers c ON c.id = paid.customer_id
WHERE paid.spend > 1000;
```

## 4. Worked Example

**Recursive CTE: org chart depth**

Walk a manager hierarchy:

```sql
WITH RECURSIVE chain AS (
  SELECT id, manager_id, 1 AS depth FROM employees WHERE manager_id IS NULL
  UNION ALL
  SELECT e.id, e.manager_id, c.depth + 1
  FROM employees e JOIN chain c ON e.manager_id = c.id
)
SELECT * FROM chain;
```

## 5. Best Practices

- ✅ Use CTEs to break complex queries into readable steps.
- ✅ Prefer EXISTS/NOT EXISTS over IN/NOT IN when NULLs are possible.
- ✅ Avoid correlated subqueries in SELECT for large result sets (N+1 within SQL).
- ✅ Always include a termination condition in recursive CTEs.
- ✅ Check the plan: some engines materialize CTEs (optimization fences).

## 6. Common Pitfalls

1. ⚠️ `NOT IN` with a NULL in the subquery returns no rows (NULL logic).
2. ⚠️ Correlated subqueries running once per outer row (slow).
3. ⚠️ Recursive CTE without a base/stop condition → infinite loop.
4. ⚠️ Assuming CTEs are always inlined (Postgres <12 materialized them).
5. ⚠️ Subquery returning multiple rows where a scalar is expected.
6. ⚠️ Over-nesting making queries unreadable vs a join.

## 7. Interview Questions

1. **Q: CTE vs subquery?**
   A: Functionally similar; CTEs are named, reusable, support recursion, and read top-down.

2. **Q: EXISTS vs IN?**
   A: EXISTS stops at first match and is NULL-safe; IN materializes a list and breaks with NOT IN + NULL.

3. **Q: What is a correlated subquery?**
   A: One that references the outer query's columns and is evaluated per outer row.

4. **Q: How do recursive CTEs work?**
   A: Anchor member runs once; recursive member repeatedly joins the prior result until no new rows.

5. **Q: Why can NOT IN return nothing?**
   A: If the subquery yields any NULL, the NOT IN predicate becomes UNKNOWN for all rows.

6. **Q: Are CTEs always faster?**
   A: No — they aid readability; performance depends on whether the optimizer inlines them.

7. **Q: When use a derived table?**
   A: A subquery in FROM to pre-aggregate before joining.

8. **Q: Recursive CTE real use?**
   A: Hierarchies, graph traversal, generating series, bill-of-materials.

## 8. Practice

- [ ] Rewrite a correlated subquery as a join.
- [ ] Find customers who placed no orders using NOT EXISTS.
- [ ] Generate numbers 1..100 with a recursive CTE.

## 9. Quick Revision

Subqueries nest; CTEs name them (and recurse). Prefer EXISTS over IN for NULL-safety; always bound recursive CTEs.

**References:** WITH / Common Table Expressions

---

*SQL Handbook — topic 04.*
