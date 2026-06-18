# 06 · DataFrame & Series

> **In one line:** Labeled 2D tables (DataFrame) of labeled 1D columns (Series).

---

## 1. Overview

Pandas adds **labels** to NumPy: a **Series** is a labeled 1D array; a **DataFrame** is a labeled 2D table of Series sharing an **index**. Labels (index + columns) enable intuitive selection, alignment, and joins.

## 2. Key Concepts

- DataFrame = dict-like collection of columns (Series).
- The index labels rows; columns label fields.
- Each column has its own dtype.
- Operations auto-align on the index.
- Construct from dicts, lists, CSV, SQL, etc.

## 3. Syntax & Code

```python
import pandas as pd
df = pd.DataFrame({
    'name': ['Ann', 'Bob', 'Cy'],
    'age': [30, 25, 35],
    'city': ['NYC', 'LA', 'NYC'],
})
print(df.dtypes)
print(df['age'].mean())   # 30.0
```

## 4. Worked Example

**Index alignment**

Operations align on labels, not position:

```python
s1 = pd.Series([1, 2], index=['a', 'b'])
s2 = pd.Series([10, 20], index=['b', 'c'])
print(s1 + s2)   # a:NaN, b:12, c:NaN  (aligned by label)
```

## 5. Best Practices

- ✅ Set a meaningful index for alignment/lookups.
- ✅ Check dtypes early (object columns are slow).
- ✅ Use vectorized column ops, not row loops.
- ✅ Load with proper parse options (dates, dtypes).
- ✅ Inspect with head/info/describe.

## 6. Common Pitfalls

1. ⚠️ Iterating rows with iterrows (slow) instead of vectorizing.
2. ⚠️ Object dtype columns from mixed/strings hurting speed.
3. ⚠️ Forgetting label-based alignment introduces NaNs.
4. ⚠️ Mutating a slice (SettingWithCopyWarning).
5. ⚠️ Default RangeIndex when a key index is better.
6. ⚠️ Ignoring memory of large object columns.

## 7. Interview Questions

1. **Q: Series vs DataFrame?**
   A: Series is a labeled 1D array; DataFrame is a 2D table of Series sharing an index.

2. **Q: What is the index?**
   A: Row labels enabling alignment, fast lookup, and joins.

3. **Q: How do operations align?**
   A: By matching index/column labels, inserting NaN where labels don't overlap.

4. **Q: Why are object dtypes slow?**
   A: They hold Python objects (e.g., strings), losing vectorization benefits.

5. **Q: How to avoid row loops?**
   A: Use vectorized column operations / apply sparingly / groupby.

6. **Q: What is SettingWithCopyWarning?**
   A: A warning that you may be assigning to a copy (a view/copy ambiguity).

7. **Q: How to inspect a DataFrame?**
   A: head(), info(), describe(), dtypes.

8. **Q: Can columns have different dtypes?**
   A: Yes — each column is a typed Series.

## 8. Practice

- [ ] Build a DataFrame from a dict and compute a column mean.
- [ ] Demonstrate label alignment producing NaNs.
- [ ] Set and use a custom index for lookups.

## 9. Quick Revision

Series=labeled 1D, DataFrame=labeled 2D table sharing an index. Ops align by label (NaN on mismatch). Set good indexes, mind object dtypes, vectorize over row loops.

**References:** Pandas intro

---

*NumPy & Pandas Handbook — topic 06.*
