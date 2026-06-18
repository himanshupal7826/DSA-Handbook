# 08 · GroupBy: Split-Apply-Combine

> **In one line:** Aggregate, transform, and filter by group.

---

## 1. Overview

**GroupBy** implements split-apply-combine: split rows into groups by key(s), apply a function (aggregate/transform/filter), and combine results. It's the analytical workhorse for per-category metrics.

## 2. Key Concepts

- aggregate (agg) → one row per group.
- transform → same shape as input (broadcast group stat back).
- filter → keep/drop whole groups.
- Group by multiple keys for hierarchical results.
- Named aggregations for clean output columns.

## 3. Syntax & Code

```python
df.groupby('city').agg(
    avg_age=('age', 'mean'),
    n=('name', 'count'),
).reset_index()
```

## 4. Worked Example

**Transform: group-relative value**

Subtract each group's mean (same shape back):

```python
df['age_vs_city'] = df['age'] - df.groupby('city')['age'].transform('mean')
```

## 5. Best Practices

- ✅ Use named aggregations for clear column names.
- ✅ Use transform when you need the original shape back.
- ✅ Group by multiple keys when needed.
- ✅ Avoid apply with slow Python functions when agg/transform suffice.
- ✅ reset_index() to flatten grouped output.

## 6. Common Pitfalls

1. ⚠️ Confusing agg (collapses) with transform (same shape).
2. ⚠️ Slow groupby().apply(python_func) on big data.
3. ⚠️ Forgetting reset_index leaving a grouped index.
4. ⚠️ NaN keys silently dropped from groups.
5. ⚠️ Mutating groups in place unexpectedly.
6. ⚠️ Expecting order within groups without sorting.

## 7. Interview Questions

1. **Q: Explain split-apply-combine.**
   A: Split rows into groups by key, apply a function per group, combine into a result.

2. **Q: agg vs transform?**
   A: agg returns one row per group; transform returns a result aligned to the original rows.

3. **Q: How to compute a group-relative metric?**
   A: groupby(key)[col].transform('mean') then subtract.

4. **Q: What does filter do in groupby?**
   A: Keeps or removes entire groups based on a group-level condition.

5. **Q: How to name aggregated columns?**
   A: Named aggregation: out_col=(in_col, func).

6. **Q: Why is apply slow?**
   A: It runs a Python function per group, missing vectorization.

7. **Q: Are NaN group keys included?**
   A: By default they're excluded (dropna=True).

8. **Q: Multiple group keys?**
   A: Pass a list; you get a MultiIndex result.

## 8. Practice

- [ ] Aggregate mean and count per category with named agg.
- [ ] Add a group-relative column via transform.
- [ ] Filter out groups smaller than N rows.

## 9. Quick Revision

GroupBy = split-apply-combine. agg collapses (one row/group), transform preserves shape, filter drops groups. Use named aggs, reset_index; avoid slow apply; NaN keys drop by default.

**References:** Group by

---

*NumPy & Pandas Handbook — topic 08.*
