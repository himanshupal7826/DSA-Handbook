# 02 · Joins (INNER, LEFT, RIGHT, FULL)

> **In one line:** Combine rows across tables on a related key.

---

## 1. Overview

Joins combine rows from two tables based on a join condition. **INNER** keeps only matching rows; **LEFT** keeps all left rows (NULLs for missing right); **FULL** keeps all rows from both sides. Joins are the core of relational modeling.

## 2. Key Concepts

- INNER JOIN = intersection on the key.
- LEFT JOIN = all left rows + matched right (or NULLs).
- A LEFT JOIN with `WHERE right.id IS NULL` finds 'rows with no match' (anti-join).
- Join keys should be indexed on at least one side (usually the FK side).

## 3. Syntax & Code

```sql
-- Customers and their orders (customers with no orders included)
SELECT c.name, o.id AS order_id, o.total
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id;
```

## 4. Worked Example

**Anti-join: customers who never ordered**

LEFT JOIN then keep only the unmatched side:

```sql
SELECT c.id, c.name
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.id IS NULL;
```

## 5. Best Practices

- ✅ Always qualify columns with table aliases in multi-table queries.
- ✅ Index the foreign-key column used in the join.
- ✅ Prefer explicit `JOIN ... ON` over comma joins in WHERE.
- ✅ Put filters in ON vs WHERE deliberately for outer joins.
- ✅ Watch row multiplication on one-to-many joins (aggregate as needed).

## 6. Common Pitfalls

1. ⚠️ Forgetting a join condition produces a Cartesian product.
2. ⚠️ Filtering the right table in WHERE turns a LEFT JOIN into an INNER JOIN.
3. ⚠️ Duplicated rows from one-to-many joins inflate SUM/COUNT.
4. ⚠️ Ambiguous column names without aliases.
5. ⚠️ Joining on non-indexed columns causes full scans / hash joins on big tables.
6. ⚠️ RIGHT JOIN is rarely needed — rewrite as LEFT for readability.

## 7. Interview Questions

1. **Q: INNER vs LEFT JOIN?**
   A: INNER returns only matching rows; LEFT returns all left rows with NULLs where the right has no match.

2. **Q: How do you find rows in A with no match in B?**
   A: LEFT JOIN B and filter WHERE B.key IS NULL (anti-join), or NOT EXISTS.

3. **Q: ON vs WHERE for outer joins?**
   A: Conditions in ON affect matching (preserving outer rows); conditions in WHERE filter the final result and can nullify the outer join.

4. **Q: What causes a Cartesian product?**
   A: Missing or always-true join condition (CROSS JOIN).

5. **Q: Why might a join duplicate rows?**
   A: One-to-many relationship: each left row matches multiple right rows.

6. **Q: How does the DB execute joins physically?**
   A: Nested loop, hash join, or merge join — chosen by the optimizer based on size/indexes.

7. **Q: Self-join use case?**
   A: Comparing rows within the same table, e.g., employees to their managers.

8. **Q: How to join and aggregate without inflation?**
   A: Aggregate in a subquery/CTE first, then join the summary.

## 8. Practice

- [ ] List products and their category names (INNER).
- [ ] Find employees with no manager (self LEFT JOIN).
- [ ] Sum order totals per customer including zero-order customers.

## 9. Quick Revision

INNER=matches only, LEFT=keep-left, anti-join via LEFT+IS NULL. Index FK columns; beware Cartesian products and one-to-many row inflation.

**References:** Use The Index, Luke

---

*SQL Handbook — topic 02.*
