# 05 · Aggregations & Axes

> **In one line:** Reduce arrays along axes; handle NaNs correctly.

---

## 1. Overview

Reductions (sum, mean, std, min/max, argmax) collapse an array along an **axis**. Choosing the right axis is the key skill; `nan*` variants ignore missing values, and `arg*` returns indices of extrema.

## 2. Key Concepts

- axis=0 reduces across rows (per column); axis=1 per row.
- None (default) reduces the whole array to a scalar.
- argmax/argmin give positions, not values.
- nanmean/nansum skip NaNs.
- cumsum/cumprod give running aggregates.

## 3. Syntax & Code

```python
A = np.array([[1, 2, 3], [4, 5, 6]])
print(A.sum(axis=0))   # [5 7 9]  per column
print(A.sum(axis=1))   # [6 15]   per row
print(A.argmax())      # 5 (flattened index of max)
```

## 4. Worked Example

**NaN-aware stats**

Average ignoring missing data:

```python
x = np.array([1.0, np.nan, 3.0])
print(np.nanmean(x))   # 2.0  (ignores NaN)
print(x.mean())        # nan  (propagates)
```

## 5. Best Practices

- ✅ Always be explicit about axis.
- ✅ Use nan-aware functions when data has gaps.
- ✅ Use keepdims to retain shape for broadcasting.
- ✅ Prefer arg* for locating extrema.
- ✅ Validate axis with small examples.

## 6. Common Pitfalls

1. ⚠️ Wrong axis flipping rows/columns silently.
2. ⚠️ Plain mean/sum propagating NaN to the whole result.
3. ⚠️ Confusing argmax (index) with max (value).
4. ⚠️ Flattened argmax index vs per-axis index.
5. ⚠️ Forgetting keepdims when chaining broadcasts.
6. ⚠️ Integer overflow in large sums (use a bigger dtype).

## 7. Interview Questions

1. **Q: axis=0 vs axis=1?**
   A: axis=0 aggregates down columns; axis=1 across each row.

2. **Q: Default axis?**
   A: None — reduces the entire array to a scalar.

3. **Q: argmax vs max?**
   A: argmax returns the index of the maximum; max returns the value.

4. **Q: How to ignore NaNs?**
   A: Use nansum/nanmean/etc., which skip NaN entries.

5. **Q: Why does mean return NaN?**
   A: Any NaN propagates through standard reductions.

6. **Q: How to get per-axis argmax?**
   A: Pass axis to argmax; note it indexes within that axis.

7. **Q: Running totals?**
   A: cumsum/cumprod.

8. **Q: keepdims purpose in aggregation?**
   A: Preserve reduced dims as size-1 for later broadcasting.

## 8. Practice

- [ ] Compute per-column and per-row sums.
- [ ] Use nanmean on data with missing values.
- [ ] Find the index of the max with argmax.

## 9. Quick Revision

Reductions collapse along axis (0=cols, 1=rows, None=all). arg* gives indices; nan* ignores NaN (plain ops propagate it); keepdims aids broadcasting. Always state the axis.

**References:** Statistics functions

---

*NumPy & Pandas Handbook — topic 05.*
