# 06 · Indexes & How They Work

> **In one line:** B-tree indexes turn full scans into logarithmic lookups.

---

## 1. Overview

An index is a sorted data structure (usually a **B-tree**) that lets the DB find rows without scanning the whole table. Indexes speed reads but cost write overhead and storage. Choosing the right index is the highest-leverage SQL performance skill.

## 2. Key Concepts

- B-tree gives O(log n) lookup, range scans, and ORDER BY support.
- Composite index (a,b) helps queries filtering on a, or a+b — leftmost-prefix rule.
- Covering index includes all needed columns → index-only scan.
- High-cardinality columns benefit most; low-cardinality may not.

## 3. Syntax & Code

```sql
-- Composite index supporting filter + sort
CREATE INDEX idx_orders_cust_date
  ON orders (customer_id, created_at DESC);

-- This query can use it fully:
SELECT id FROM orders
WHERE customer_id = 42
ORDER BY created_at DESC
LIMIT 10;
```

## 4. Worked Example

**Reading EXPLAIN**

Confirm an index scan instead of a seq scan:

```sql
EXPLAIN ANALYZE
SELECT * FROM orders WHERE customer_id = 42;
-- Look for: Index Scan using idx_orders_cust_date  (not Seq Scan)
```

## 5. Best Practices

- ✅ Index columns used in WHERE, JOIN, and ORDER BY.
- ✅ Order composite-index columns by selectivity and the leftmost-prefix rule.
- ✅ Use covering indexes for hot read paths.
- ✅ Avoid functions on indexed columns in WHERE (or use expression indexes).
- ✅ Drop unused indexes — they slow writes.

## 6. Common Pitfalls

1. ⚠️ `WHERE func(col) = x` disables the index (use an expression index).
2. ⚠️ Leading wildcard `LIKE '%foo'` can't use a B-tree.
3. ⚠️ Implicit type casts prevent index use.
4. ⚠️ Too many indexes slow INSERT/UPDATE/DELETE.
5. ⚠️ Composite index (a,b) doesn't help a query filtering only on b.
6. ⚠️ Low-cardinality boolean index rarely helps.

## 7. Interview Questions

1. **Q: What data structure backs most indexes?**
   A: A balanced B-tree (or B+ tree), giving O(log n) search and ordered range scans.

2. **Q: Leftmost-prefix rule?**
   A: A composite index on (a,b,c) supports predicates on a, a+b, or a+b+c — but not b alone.

3. **Q: What is a covering index?**
   A: One containing all columns a query reads, enabling an index-only scan (no heap fetch).

4. **Q: Why can an index hurt?**
   A: It adds write amplification and storage; every modifying statement must maintain it.

5. **Q: Why does LIKE '%x' skip the index?**
   A: B-trees are ordered by prefix; a leading wildcard has no usable prefix.

6. **Q: How to index for ORDER BY?**
   A: Match the index column order and direction to the ORDER BY clause.

7. **Q: How do you verify index usage?**
   A: EXPLAIN/EXPLAIN ANALYZE — look for Index Scan vs Seq Scan.

8. **Q: When is a full scan actually better?**
   A: When a large fraction of rows match — random index lookups cost more than a sequential scan.

## 8. Practice

- [ ] Add an index that serves WHERE+ORDER BY for a hot query.
- [ ] Use EXPLAIN to confirm an index-only scan.
- [ ] Find and drop a redundant index.

## 9. Quick Revision

B-tree index = O(log n) lookups + range/ORDER support. Index WHERE/JOIN/ORDER columns; respect leftmost-prefix; cover hot reads; avoid functions/wildcards that disable it. Verify with EXPLAIN.

**References:** Use The Index, Luke

---

*SQL Handbook — topic 06.*
