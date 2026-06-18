# 12 · Performance & Memory

> **In one line:** Make Pandas fast and memory-lean at scale.

---

## 1. Overview

Pandas slows down with row loops, object dtypes, and oversized types. Speed up by **vectorizing**, downcasting **dtypes**, using **categorical** for low-cardinality strings, reading in **chunks**, and reaching for Arrow-backed dtypes or Polars/Dask when data outgrows memory.

## 2. Key Concepts

- Avoid iterrows/apply; vectorize with column ops.
- Downcast numeric dtypes (int64→int32, float64→float32).
- category dtype slashes memory for repeated strings.
- Read large files in chunks or select columns/dtypes.
- Arrow-backed/Polars/Dask for very large data.

## 3. Syntax & Code

```python
df['city'] = df['city'].astype('category')        # memory win
df['count'] = pd.to_numeric(df['count'], downcast='integer')
for chunk in pd.read_csv('big.csv', chunksize=100_000):
    process(chunk)
```

## 4. Worked Example

**Vectorize over apply**

Replace a row-wise apply with column math:

```python
# slow: df.apply(lambda r: r.a + r.b, axis=1)
df['c'] = df['a'] + df['b']   # vectorized
```

## 5. Best Practices

- ✅ Vectorize; avoid iterrows/axis=1 apply.
- ✅ Use category dtype for low-cardinality strings.
- ✅ Downcast numeric dtypes to cut memory.
- ✅ Read only needed columns/dtypes; chunk big files.
- ✅ Profile with %timeit / memory_usage before optimizing.

## 6. Common Pitfalls

1. ⚠️ Row-wise apply/iterrows on large frames.
2. ⚠️ Object dtype strings wasting memory.
3. ⚠️ Loading entire huge CSVs into memory.
4. ⚠️ Over-downcasting causing overflow/precision loss.
5. ⚠️ Repeated concat in loops (quadratic).
6. ⚠️ Ignoring copy-vs-view memory implications.

## 7. Interview Questions

1. **Q: Biggest Pandas speedups?**
   A: Vectorize (avoid loops/apply), right-size dtypes, use categoricals, and read selectively/in chunks.

2. **Q: Why is apply(axis=1) slow?**
   A: It calls a Python function per row, bypassing vectorization.

3. **Q: When use category dtype?**
   A: Low-cardinality repeated strings — large memory and groupby speedups.

4. **Q: How to reduce memory?**
   A: Downcast numerics, categoricals, load fewer columns, Arrow-backed dtypes.

5. **Q: Handling data bigger than RAM?**
   A: Chunked reads, Dask/Polars, or a database.

6. **Q: Risk of downcasting?**
   A: Overflow or precision loss if the range/precision doesn't fit.

7. **Q: Why avoid concat in loops?**
   A: Each concat copies — accumulate in a list and concat once.

8. **Q: How to profile?**
   A: %timeit for speed, df.memory_usage(deep=True) for memory.

## 8. Practice

- [ ] Convert a string column to category and measure memory.
- [ ] Replace an apply(axis=1) with vectorized math.
- [ ] Process a large CSV in chunks.

## 9. Quick Revision

Speed/memory: vectorize (no iterrows/apply axis=1), downcast dtypes, category for repeated strings, chunked/selective reads, Polars/Dask/Arrow for big data. Profile first; concat once, not in loops.

**References:** Scaling to large datasets

---

*NumPy & Pandas Handbook — topic 12.*
