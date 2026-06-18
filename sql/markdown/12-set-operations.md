# 12 · Set Operations & CASE

> **In one line:** Combine result sets and add conditional logic.

---

## 1. Overview

Set operators combine the rows of two queries: `UNION` (distinct), `UNION ALL` (keep duplicates), `INTERSECT`, `EXCEPT`. `CASE` adds row-level conditional logic; `COALESCE`/`NULLIF` handle NULLs.

## 2. Key Concepts

- UNION removes duplicates (costly sort); UNION ALL keeps them (faster).
- Both sides must have matching column count and compatible types.
- CASE WHEN ... THEN ... ELSE ... END for inline conditionals.
- COALESCE returns the first non-NULL; NULLIF returns NULL when equal.

## 3. Syntax & Code

```sql
-- Label orders and combine two sources
SELECT id, 'web' AS channel FROM web_orders
UNION ALL
SELECT id, 'pos' FROM pos_orders;
```

## 4. Worked Example

**Bucketing with CASE**

Categorize customers by spend:

```sql
SELECT name,
  CASE WHEN spend > 1000 THEN 'VIP'
       WHEN spend > 100  THEN 'Regular'
       ELSE 'New' END AS tier
FROM customer_spend;
```

## 5. Best Practices

- ✅ Use UNION ALL unless you specifically need de-duplication.
- ✅ Keep column order/types aligned across set operations.
- ✅ Use CASE for conditional aggregation (pivot-like sums).
- ✅ COALESCE to provide defaults for NULLs.
- ✅ Parenthesize mixed set operations for clarity.

## 6. Common Pitfalls

1. ⚠️ UNION's implicit DISTINCT sort being a hidden cost.
2. ⚠️ Mismatched column counts/types across queries.
3. ⚠️ Relying on result order without ORDER BY (apply ORDER BY once at the end).
4. ⚠️ CASE without ELSE returning NULL unexpectedly.
5. ⚠️ INTERSECT/EXCEPT also de-duplicate by default.
6. ⚠️ COALESCE type mismatches.

## 7. Interview Questions

1. **Q: UNION vs UNION ALL?**
   A: UNION removes duplicates (extra sort); UNION ALL concatenates and is faster.

2. **Q: Requirements for set operations?**
   A: Same number of columns and compatible data types in the same order.

3. **Q: What does EXCEPT do?**
   A: Returns rows from the first query not present in the second (set difference).

4. **Q: Conditional aggregation example?**
   A: SUM(CASE WHEN status='paid' THEN total ELSE 0 END) to sum a subset.

5. **Q: COALESCE vs ISNULL/IFNULL?**
   A: COALESCE is standard and n-ary; ISNULL/IFNULL are vendor-specific 2-arg variants.

6. **Q: How to ORDER BY a UNION?**
   A: Apply a single ORDER BY after the last query; it sorts the combined result.

7. **Q: NULLIF use case?**
   A: Avoid divide-by-zero: x / NULLIF(y, 0).

8. **Q: Pivot without PIVOT keyword?**
   A: Conditional aggregation with CASE inside aggregates grouped by a key.

## 8. Practice

- [ ] Merge two order sources with a channel label.
- [ ] Bucket users into tiers with CASE.
- [ ] Compute paid vs unpaid totals via conditional aggregation.

## 9. Quick Revision

UNION(distinct)/UNION ALL(keep dups)/INTERSECT/EXCEPT combine result sets (matching columns/types). CASE adds row logic; COALESCE/NULLIF tame NULLs; ORDER BY once at the end.

**References:** UNION/INTERSECT/EXCEPT

---

*SQL Handbook — topic 12.*
