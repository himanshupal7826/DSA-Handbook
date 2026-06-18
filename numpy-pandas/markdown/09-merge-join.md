# 09 · Merge, Join & Concat

> **In one line:** Combine DataFrames by keys or by stacking.

---

## 1. Overview

Combine tables with **merge** (SQL-style joins on keys), **join** (index-based), or **concat** (stack along an axis). The `how` parameter (inner/left/right/outer) controls which keys survive — mirroring SQL joins.

## 2. Key Concepts

- merge(on=...) joins on column keys; how sets the join type.
- join() aligns on the index by default.
- concat stacks rows (axis=0) or columns (axis=1).
- Validate one-to-one/one-to-many to catch dup explosions.
- indicator=True shows the match source.

## 3. Syntax & Code

```python
orders.merge(customers, on='customer_id', how='left', validate='m:1')
```

## 4. Worked Example

**Find unmatched rows**

Outer merge + indicator to detect mismatches:

```python
m = a.merge(b, on='id', how='outer', indicator=True)
only_a = m[m['_merge'] == 'left_only']
```

## 5. Best Practices

- ✅ Be explicit about how (inner/left/right/outer).
- ✅ Use validate to assert cardinality (1:1, m:1).
- ✅ Name/align join keys consistently.
- ✅ Use indicator to debug joins.
- ✅ concat with ignore_index when stacking unrelated frames.

## 6. Common Pitfalls

1. ⚠️ Many-to-many merges exploding row counts.
2. ⚠️ Default inner join silently dropping rows.
3. ⚠️ Mismatched key dtypes failing to match.
4. ⚠️ Duplicate keys inflating results.
5. ⚠️ Index misalignment in concat producing NaNs.
6. ⚠️ Forgetting suffixes for overlapping column names.

## 7. Interview Questions

1. **Q: merge vs join vs concat?**
   A: merge joins on keys (SQL-style), join aligns on index, concat stacks along an axis.

2. **Q: What does how control?**
   A: Which keys are kept: inner (both), left, right, or outer (all).

3. **Q: How to detect unmatched rows?**
   A: Outer merge with indicator=True, then filter left_only/right_only.

4. **Q: Why use validate?**
   A: To assert the join cardinality and catch unexpected duplicates/explosions.

5. **Q: Cause of row explosion?**
   A: Many-to-many keys producing the Cartesian product per key.

6. **Q: Why might a merge match nothing?**
   A: Key dtype mismatch or differing values/whitespace.

7. **Q: Overlapping column names?**
   A: Disambiguate with suffixes.

8. **Q: concat axis 0 vs 1?**
   A: 0 stacks rows, 1 stacks columns (aligning on index).

## 8. Practice

- [ ] Left-merge orders with customers using validate.
- [ ] Use indicator to find unmatched keys.
- [ ] Concatenate monthly frames with ignore_index.

## 9. Quick Revision

merge (keys, how=inner/left/right/outer), join (index), concat (stack rows/cols). Use validate + indicator; align key dtypes; beware m:m explosions and inner-join row loss.

**References:** Merge, join, concatenate

---

*NumPy & Pandas Handbook — topic 09.*
