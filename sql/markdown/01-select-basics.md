# 01 · SELECT, WHERE, ORDER BY

> **In one line:** Retrieve and filter rows — the foundation of every query.

---

## 1. Overview

`SELECT` is the workhorse of SQL: it reads rows from one or more tables, filters them with `WHERE`, orders them with `ORDER BY`, and limits output with `LIMIT`/`FETCH`. SQL is **declarative** — you describe *what* you want, the optimizer decides *how*.

## 2. Key Concepts

- Logical order of evaluation: FROM → WHERE → GROUP BY → HAVING → SELECT → ORDER BY → LIMIT.
- `WHERE` filters rows *before* grouping; `HAVING` filters *after*.
- `DISTINCT` removes duplicate rows; it is not free (requires a sort/hash).
- `NULL` is unknown — comparisons with `=` fail; use `IS NULL`.

## 3. Syntax & Code

```sql
-- Top 5 most recent active users
SELECT id, name, created_at
FROM users
WHERE status = 'active'
ORDER BY created_at DESC
LIMIT 5;
```

## 4. Worked Example

**Filter + sort + paginate**

Page 2 of 20 products, cheapest first, in-stock only:

```sql
SELECT name, price
FROM products
WHERE stock > 0
ORDER BY price ASC
LIMIT 20 OFFSET 20;  -- rows 21..40
```

## 5. Best Practices

- ✅ Select only the columns you need — avoid `SELECT *` in production.
- ✅ Always pair `LIMIT` with `ORDER BY` for deterministic results.
- ✅ Use keyset pagination (`WHERE id > ?`) instead of large `OFFSET`.
- ✅ Filter on indexed columns in `WHERE`.
- ✅ Treat `NULL` explicitly with `IS [NOT] NULL` / `COALESCE`.

## 6. Common Pitfalls

1. ⚠️ `WHERE col = NULL` never matches — use `IS NULL`.
2. ⚠️ `SELECT *` breaks when schema changes and over-fetches.
3. ⚠️ Large `OFFSET` scans and discards all skipped rows (slow).
4. ⚠️ `ORDER BY` on an unindexed column forces a sort.
5. ⚠️ String comparisons may be case/collation sensitive.
6. ⚠️ Implicit type casts (e.g., `WHERE id = '5'`) can disable index use.

## 7. Interview Questions

1. **Q: What is the logical execution order of a SELECT?**
   A: FROM/JOIN, WHERE, GROUP BY, HAVING, SELECT, DISTINCT, ORDER BY, LIMIT — not the written order.

2. **Q: Difference between WHERE and HAVING?**
   A: WHERE filters individual rows before aggregation; HAVING filters groups after aggregation.

3. **Q: Why avoid SELECT *?**
   A: Over-fetches data, breaks on schema change, prevents covering-index-only scans, hurts network I/O.

4. **Q: How does NULL behave in comparisons?**
   A: Any comparison with NULL yields UNKNOWN; rows are excluded unless you use IS NULL or IS NOT DISTINCT FROM.

5. **Q: Why is OFFSET pagination slow at scale?**
   A: The DB must read and discard all preceding rows; keyset pagination on an indexed column is O(log n).

6. **Q: DISTINCT vs GROUP BY?**
   A: Both deduplicate; GROUP BY also enables aggregates. DISTINCT is shorthand for grouping by all selected columns.

7. **Q: How to get deterministic LIMIT results?**
   A: Add a total ordering in ORDER BY (include a unique tiebreaker like primary key).

8. **Q: What is a covering index?**
   A: An index that contains all columns a query needs, so the table heap is never read.

## 8. Practice

- [ ] Write a query for the 10 newest orders over $100.
- [ ] Paginate users with keyset pagination instead of OFFSET.
- [ ] Return rows where a nullable column is NULL.

## 9. Quick Revision

SELECT picks columns, WHERE filters rows (pre-group), HAVING filters groups (post-aggregate), ORDER BY sorts, LIMIT caps. Mind NULL semantics and prefer keyset pagination.

**References:** PostgreSQL docs: SELECT

---

*SQL Handbook — topic 01.*
