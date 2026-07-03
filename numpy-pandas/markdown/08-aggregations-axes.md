# 08 · Aggregations & the `axis` Argument

> **In one line:** Reductions like `sum`/`mean`/`max` collapse an array to fewer numbers — and `axis` names *which* dimension disappears, with `keepdims` letting you keep the slot for broadcasting.

---

## 1. Overview

An **aggregation** (or reduction) takes many values and returns few: the sum of a vector, the mean of each column, the max down each row. These are the workhorses of data analysis — totals, averages, spreads, extremes — and NumPy computes them in fast C loops over the whole buffer.

The one idea that trips people up is the **`axis`** argument. Almost every aggregation accepts it, and the rule is simple but must be internalized: **`axis` names the dimension that gets collapsed (removed).** `sum(axis=0)` collapses the rows, leaving one value per column; `sum(axis=1)` collapses the columns, leaving one value per row. Get this backwards and your "per-column average" is silently a per-row average.

You reach for aggregations everywhere: normalizing features (subtract the per-column mean), scoring rows, summarizing batches, computing standard deviations. This page nails the axis mental model, the `keepdims` trick that makes reductions broadcast cleanly back onto the original, and the **nan-aware** variants (`nansum`, `nanmean`) you need the moment real data contains missing values.

## 2. Core Concepts

- **Reduction** — an operation mapping an array to fewer elements along one or more axes: `sum`, `prod`, `mean`, `min`, `max`, `std`, `var`, `all`, `any`, `argmin`, `argmax`.
- **`axis` = the dimension collapsed** — `axis=0` removes the first axis (down the rows → per-column result); `axis=1` removes the second (across columns → per-row result). Result `ndim` drops by one.
- **`axis=None` (default)** — reduce over *everything*, returning a single scalar.
- **Negative axes** — `axis=-1` is the last axis, handy for shape-agnostic code (reduce over the innermost dimension).
- **Tuple axes** — `axis=(0, 1)` collapses several axes at once (e.g. reduce H and W of an `(N, H, W)` batch, keeping N).
- **`keepdims=True`** — keep the collapsed axis as size 1 instead of dropping it, so the result **broadcasts back** onto the original shape.
- **`argmin` / `argmax`** — return the *index* of the extreme along an axis, not the value.
- **nan-aware funcs** — `nansum`, `nanmean`, `nanmax`, `nanstd`, … ignore `NaN` instead of letting it poison the result (a plain `mean` of data containing `NaN` is `NaN`).
- **`ddof` for std/var** — delta degrees of freedom; NumPy defaults to `ddof=0` (population); use `ddof=1` for the sample estimate.

## 3. Syntax & Examples

Reduce everything vs along an axis:

```python
import numpy as np
a = np.array([[1, 2, 3],
              [4, 5, 6]])          # shape (2, 3)

a.sum()            # 21          -> scalar (axis=None)
a.sum(axis=0)      # [5 7 9]     -> collapse rows, per-COLUMN (shape (3,))
a.sum(axis=1)      # [ 6 15]     -> collapse cols, per-ROW   (shape (2,))
```

The other reducers follow the same axis rule:

```python
a.mean(axis=0)     # [2.5 3.5 4.5]
a.max(axis=1)      # [3 6]
a.std(axis=0)      # [1.5 1.5 1.5]   (population, ddof=0)
a.argmax(axis=1)   # [2 2]           index of the max in each row
```

`keepdims` keeps the slot so it broadcasts back:

```python
col_mean = a.mean(axis=0, keepdims=True)   # shape (1, 3), not (3,)
a - col_mean                                # centers each column, no reshape needed
# array([[-1.5, -1.5, -1.5],
#        [ 1.5,  1.5,  1.5]])
```

nan-aware reductions on dirty data:

```python
d = np.array([1.0, 2.0, np.nan, 4.0])
d.mean()           # nan   -- poisoned
np.nanmean(d)      # 2.333333...   -- NaN ignored
np.nansum(d)       # 7.0
```

## 4. Worked Example

Standardize a small feature matrix column-by-column (z-score) — the canonical use of `axis` + `keepdims` — then find the top feature per sample.

```python
import numpy as np

X = np.array([[ 2.,  50., 100.],
              [ 4.,  30., 300.],
              [ 6.,  40., 200.]])          # 3 samples x 3 features

mu    = X.mean(axis=0, keepdims=True)      # (1,3) per-feature mean
sigma = X.std(axis=0, keepdims=True)       # (1,3) per-feature std
Z = (X - mu) / sigma                        # broadcasts cleanly

print("means   :", mu.ravel())             # [ 4. 40. 200.]
print("stds    :", sigma.round(3).ravel()) # [1.633 8.165 81.65]
print(Z.round(3))
# [[-1.225  1.225 -1.225]
#  [ 0.    -1.225  1.225]
#  [ 1.225  0.     0.   ]]

# which standardized feature is largest per sample?
print("top feature idx per row:", Z.argmax(axis=1))   # [1 2 0]

# sanity: standardized columns have ~0 mean, unit std
print("col means ~0 :", Z.mean(axis=0).round(6))      # [0. 0. 0.]
print("col stds  ~1 :", Z.std(axis=0).round(6))       # [1. 1. 1.]
```

| quantity | axis | result shape | meaning |
|---|---|---|---|
| `X.mean(axis=0, keepdims=True)` | 0 | (1, 3) | mean of each **feature** |
| `(X - mu) / sigma` | — | (3, 3) | broadcast back onto samples |
| `Z.argmax(axis=1)` | 1 | (3,) | index of top feature per **sample** |
| `Z.std(axis=0)` | 0 | (3,) | ~1.0, confirms standardization |

`keepdims=True` is what makes `X - mu` "just work": `mu` stays `(1,3)` and broadcasts across the 3 rows. Without it, `mu` would be `(3,)` — which here still broadcasts, but the moment you reduce over `axis=1` you'd get a `(3,)` that will *not* align back onto rows without a manual reshape.

## 5. Under the Hood

Picture the array as a grid with **axis 0 pointing down (rows)** and **axis 1 pointing right (columns)**. A reduction "walks" along the named axis and combines everything it passes, leaving that axis with length 1 — then (unless `keepdims`) that length-1 axis is squeezed away. So `axis=0` sweeps vertically and produces one value per column; `axis=1` sweeps horizontally and produces one value per row.

The mnemonic that never fails: **the axis you name is the one that disappears.** `(2,3).sum(axis=0) → (3,)`; `(2,3).sum(axis=1) → (2,)`.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah3" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">axis names the dimension that COLLAPSES</text>

  <text x="200" y="52" text-anchor="middle" fill="#2563eb" font-weight="700">axis=0  (collapse rows → per column)</text>
  <g>
    <rect x="120" y="66" width="46" height="30" rx="5" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="166" y="66" width="46" height="30" rx="5" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="212" y="66" width="46" height="30" rx="5" fill="#eff6ff" stroke="#2563eb"/>
    <text x="143" y="86" text-anchor="middle" fill="#1e293b">1</text>
    <text x="189" y="86" text-anchor="middle" fill="#1e293b">2</text>
    <text x="235" y="86" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="120" y="96" width="46" height="30" rx="5" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="166" y="96" width="46" height="30" rx="5" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="212" y="96" width="46" height="30" rx="5" fill="#eff6ff" stroke="#2563eb"/>
    <text x="143" y="116" text-anchor="middle" fill="#1e293b">4</text>
    <text x="189" y="116" text-anchor="middle" fill="#1e293b">5</text>
    <text x="235" y="116" text-anchor="middle" fill="#1e293b">6</text>
  </g>
  <line x1="143" y1="60" x2="143" y2="132" stroke="#475569" stroke-width="1.4" marker-end="url(#ah3)"/>
  <line x1="189" y1="60" x2="189" y2="132" stroke="#475569" stroke-width="1.4" marker-end="url(#ah3)"/>
  <line x1="235" y1="60" x2="235" y2="132" stroke="#475569" stroke-width="1.4" marker-end="url(#ah3)"/>
  <g>
    <rect x="120" y="150" width="46" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <rect x="166" y="150" width="46" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <rect x="212" y="150" width="46" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <text x="143" y="170" text-anchor="middle" fill="#1e293b">5</text>
    <text x="189" y="170" text-anchor="middle" fill="#1e293b">7</text>
    <text x="235" y="170" text-anchor="middle" fill="#1e293b">9</text>
  </g>
  <text x="189" y="198" text-anchor="middle" fill="#64748b">result shape (3,)</text>

  <text x="520" y="52" text-anchor="middle" fill="#059669" font-weight="700">axis=1  (collapse cols → per row)</text>
  <g>
    <rect x="440" y="66" width="46" height="30" rx="5" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="486" y="66" width="46" height="30" rx="5" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="532" y="66" width="46" height="30" rx="5" fill="#eff6ff" stroke="#2563eb"/>
    <text x="463" y="86" text-anchor="middle" fill="#1e293b">1</text>
    <text x="509" y="86" text-anchor="middle" fill="#1e293b">2</text>
    <text x="555" y="86" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="440" y="96" width="46" height="30" rx="5" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="486" y="96" width="46" height="30" rx="5" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="532" y="96" width="46" height="30" rx="5" fill="#eff6ff" stroke="#2563eb"/>
    <text x="463" y="116" text-anchor="middle" fill="#1e293b">4</text>
    <text x="509" y="116" text-anchor="middle" fill="#1e293b">5</text>
    <text x="555" y="116" text-anchor="middle" fill="#1e293b">6</text>
  </g>
  <line x1="590" y1="81" x2="640" y2="81" stroke="#475569" stroke-width="1.4" marker-end="url(#ah3)"/>
  <line x1="590" y1="111" x2="640" y2="111" stroke="#475569" stroke-width="1.4" marker-end="url(#ah3)"/>
  <g>
    <rect x="648" y="66" width="46" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <text x="671" y="86" text-anchor="middle" fill="#1e293b">6</text>
    <rect x="648" y="96" width="46" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <text x="671" y="116" text-anchor="middle" fill="#1e293b">15</text>
  </g>
  <text x="590" y="150" text-anchor="middle" fill="#64748b">result shape (2,)</text>

  <text x="360" y="240" text-anchor="middle" fill="#1e293b">keepdims=True → keep the collapsed axis as size 1:</text>
  <text x="360" y="262" text-anchor="middle" fill="#64748b">axis=0 → (1,3)   ·   axis=1 → (2,1)   → broadcasts back onto the original</text>
  <text x="360" y="296" text-anchor="middle" fill="#b91c1c">plain mean/sum of data with NaN → NaN; use nanmean/nansum</text>
</svg>
```

## 6. Variations & Trade-offs

| call | collapses | result (from `(2,3)`) | note |
|---|---|---|---|
| `a.sum()` | everything | scalar `21` | `axis=None` default |
| `a.sum(axis=0)` | rows | `(3,)` per column | "down the columns" |
| `a.sum(axis=1)` | cols | `(2,)` per row | "across the rows" |
| `a.sum(axis=0, keepdims=True)` | rows | `(1,3)` | broadcastable |
| `a.sum(axis=(0,1))` | both | scalar | multi-axis |
| `a.argmax(axis=1)` | cols | `(2,)` indices | value's position, not value |
| `np.nanmean(a, axis=0)` | rows | `(3,)` | ignores NaN |

Prose: default `axis=None` is fine for a grand total, but be explicit in library code — `axis=-1` (last axis) makes reductions robust to added leading dimensions (e.g. a batch axis). `keepdims=True` trades a slightly odd-looking shape for zero-friction broadcasting. nan-aware funcs cost a little more (they mask) but are mandatory on real, gappy data — or drop/impute NaNs first.

## 7. Production / Performance Notes

- **Be explicit about `axis` in reusable code.** Relying on the default scalar reduction breaks the moment inputs gain a batch dimension. `axis=-1` future-proofs "reduce the feature axis."
- **`keepdims=True` for normalization.** Centering/standardizing (`x - x.mean(axis, keepdims=True)`) avoids manual `reshape`/`newaxis` and is the idiomatic, less error-prone form.
- **Guard the `ddof`.** `np.std`/`np.var` default to population (`ddof=0`); pandas defaults to sample (`ddof=1`). Mixing them silently changes results — set `ddof` explicitly when it matters.
- **NaN discipline.** One `NaN` poisons a whole `sum`/`mean`. Either use the `nan*` family, or clean upstream. `np.isnan(a).any()` is a cheap guard.
- **Watch overflow in `sum`/`prod` on small int dtypes.** `int8`/`int16` arrays can overflow their accumulator; pass `dtype=np.int64` to `sum` for a wide accumulator.
- **Reductions are memory-bound.** They read the whole array once; on huge arrays the cost is bandwidth. Reduce over the contiguous (last) axis when you can for cache efficiency.

## 8. Common Mistakes

1. ⚠️ **Swapping the meaning of `axis=0` and `axis=1`.** People expect `axis=0` to mean "along a row." It means *collapse* axis 0 → a **per-column** result. Remember: the named axis vanishes.
2. ⚠️ **`mean`/`sum` returning `NaN` on real data.** A single missing value poisons the reduction. Fix: `np.nanmean`/`np.nansum`, or clean/impute first.
3. ⚠️ **Dropping the axis then failing to broadcast back.** `a - a.mean(axis=1)` raises a shape error because `(2,)` won't align onto rows. Fix: `keepdims=True` → `(2,1)`.
4. ⚠️ **Confusing `argmax` with `max`.** `argmax` returns the **index**, not the value. Use `max` for the value, or index back with `np.take_along_axis`.
5. ⚠️ **Wrong `ddof` for standard deviation.** NumPy's default `ddof=0` (population) differs from pandas' `ddof=1` (sample). Set it explicitly to match expectations.
6. ⚠️ **Integer overflow in `sum`.** Summing a large `int32` array can wrap. Fix: `a.sum(dtype=np.int64)`.
7. ⚠️ **Assuming `axis` on a 1-D array has options.** A 1-D array only has `axis=0`; `axis=1` raises `AxisError`.

## 9. Interview Questions

**Q: What does the `axis` argument actually do?**
A: It names the dimension that gets **collapsed** by the reduction. `axis=0` removes the first axis, producing one result per column; `axis=1` removes the second, producing one per row. The result's `ndim` is one less than the input's (unless `keepdims=True`).

**Q: For a `(2,3)` array, what shapes do `sum(axis=0)` and `sum(axis=1)` return, and why?**
A: `sum(axis=0)` → shape `(3,)` (the 2 rows collapse, one value per column); `sum(axis=1)` → shape `(2,)` (the 3 columns collapse, one value per row). The named axis disappears from the shape.

**Q: What is `keepdims=True` for?**
A: It keeps the collapsed axis as size 1 rather than dropping it, so the reduced result **broadcasts back** onto the original shape. It's what makes `X - X.mean(axis=0, keepdims=True)` center each column without a manual reshape.

**Q: Why does `mean` return `NaN` sometimes, and how do you avoid it?**
A: Because a single `NaN` in the data propagates through the arithmetic — any sum/mean touching it becomes `NaN`. Use the nan-aware variants (`np.nanmean`, `np.nansum`, `np.nanstd`) which ignore `NaN`, or remove/impute the missing values before reducing.

**Q: Difference between `max` and `argmax`?**
A: `max` returns the largest *value* along the axis; `argmax` returns the *index* of that largest value. To fetch values by those indices along an axis, use `np.take_along_axis(a, np.argmax(a, axis, keepdims=True), axis)`.

**Q: How do you reduce over multiple axes at once?**
A: Pass a tuple: `a.sum(axis=(0, 1))` collapses both axis 0 and 1 simultaneously. For an `(N, H, W)` batch, `a.mean(axis=(1, 2))` gives one mean per sample while keeping the batch axis.

**Q (senior): Why prefer `axis=-1` over `axis=1` in library code?**
A: `axis=-1` always refers to the last (usually the feature/inner) axis regardless of how many leading dimensions exist. Code that hard-codes `axis=1` breaks when a batch or channel dimension is prepended; `axis=-1` keeps "reduce the innermost axis" correct across shapes.

**Q (senior): NumPy `std` and pandas `std` disagree on the same data. Why?**
A: Different default `ddof`. NumPy uses `ddof=0` (population standard deviation, dividing by N); pandas uses `ddof=1` (sample, dividing by N−1). Set `ddof` explicitly on whichever side to reconcile them.

**Q (senior): You must average a huge int16 array and get a wrong, negative total. Diagnose.**
A: The accumulator overflowed the int16 (or default int) range mid-sum and wrapped to negatives. Fix by widening the accumulator: `a.sum(dtype=np.int64)` (or `a.mean(dtype=np.float64)`), which prevents the intermediate sum from overflowing.

## 10. Practice

- [ ] For `np.arange(1,13).reshape(3,4)`, compute `sum`, `mean`, and `max` along `axis=0` and `axis=1`; predict each result shape before running.
- [ ] Standardize the columns of a random `(100, 4)` matrix using `mean`/`std` with `keepdims=True`; verify each column has ~0 mean and ~1 std.
- [ ] Insert a `NaN` into an array and show `mean` gives `NaN` while `nanmean` gives the right value.
- [ ] Use `argmax(axis=1)` to find the winning class per row of a `(5, 3)` score matrix, then recover the winning scores with `take_along_axis`.
- [ ] Reduce an `(8, 32, 32)` batch to one mean per sample with a single `mean(axis=(1,2))` call and confirm the result shape is `(8,)`.

## 11. Cheat Sheet

> [!TIP]
> **`axis` = the dimension that COLLAPSES. The named axis disappears from the shape.**
> - `(2,3).sum(axis=0) → (3,)` per **column** · `axis=1 → (2,)` per **row** · `axis=None` → scalar.
> - `keepdims=True` keeps the axis as size 1 → result **broadcasts back** (use for centering/standardizing).
> - `axis=-1` = last axis (shape-robust); tuple `axis=(0,1)` collapses several at once.
> - Reducers: `sum prod mean std var min max all any argmin argmax`.
> - Dirty data → `nansum/nanmean/nanstd` (a lone NaN poisons plain reductions).
> - `std/var` default `ddof=0` (population) — pandas uses `ddof=1`; set it to match. Widen int sums with `dtype=np.int64`.

**References:** NumPy docs (Statistics; `numpy.sum`, `numpy.mean`, `numpy.nanmean`, the `axis` argument), NumPy "Absolute Beginner's Guide" (aggregations), Jake VanderPlas "Python Data Science Handbook" (Ch. 2, aggregations)

---
*NumPy & Pandas Handbook — topic 08.*
