# 05 · Reshaping, Stacking & Splitting

> **In one line:** Re-describe or combine arrays by rearranging their **shape and strides** — cheap views where possible (`reshape`, `ravel`, transpose), fresh copies where required (`stack`, `flatten`, `concatenate`).

---

## 1. Overview

Data rarely arrives in the shape your operation wants. You flatten an image into a feature vector, fold a 1-D reading into a `(days, hours)` grid, stitch mini-batches together, or peel a dataset into train/test slices. **Reshaping and combining** are the verbs for all of this — and because a NumPy array is *a buffer plus a header*, many of these operations are nearly free.

The core insight from topic 01 carries through: an array's dimensionality is an *interpretation* of a flat buffer via `strides`. So **`reshape`** and **`transpose`** usually just rewrite the header and return a **view** — O(1), zero copy. In contrast, **stacking** arrays (`concatenate`, `stack`, `hstack`, `vstack`) must allocate a new buffer, because two separate buffers can't be viewed as one contiguous block. Knowing which is which is the difference between a fast pipeline and one that silently copies gigabytes.

You reach for this family constantly: `reshape(-1, 1)` to make a column for scikit-learn, `ravel()` to flatten, `vstack` to append rows of features, `np.split` to chunk a dataset. This page gives you the whole toolkit plus the view-vs-copy rules that decide performance and aliasing.

## 2. Core Concepts

- **`reshape(new_shape)`** — reinterpret the same elements as a different shape. Total `size` must be preserved. Returns a **view** when the layout permits, else a copy.
- **`-1` placeholder** — let NumPy infer one dimension: `a.reshape(-1)` flattens; `a.reshape(3, -1)` fixes 3 rows and computes the columns. Exactly one `-1` allowed.
- **`ravel()` vs `flatten()`** — both give a 1-D array. `ravel()` returns a **view** when possible (cheap); `flatten()` **always copies** (safe, independent).
- **`transpose` / `.T` / `swapaxes`** — permute axes by swapping strides. A **view**, no data moved; the result is usually non-contiguous.
- **`concatenate((a,b), axis=)`** — join arrays along an **existing** axis; shapes must match on all other axes. Always a copy.
- **`stack((a,b), axis=)`** — join along a **new** axis, increasing `ndim` by one. All inputs must be identically shaped.
- **`hstack` / `vstack` / `dstack`** — convenience wrappers: horizontal (columns / axis 1), vertical (rows / axis 0), depth (axis 2). `column_stack` builds columns from 1-D arrays.
- **`split` / `hsplit` / `vsplit`** — inverse of concatenate: cut into N equal parts, or at given indices. `array_split` allows unequal parts.
- **`newaxis` / `expand_dims` / `squeeze`** — add or drop size-1 axes to make shapes line up (often for broadcasting or ML APIs).

## 3. Syntax & Examples

Reshape and the `-1` inference:

```python
import numpy as np
a = np.arange(12)
a.reshape(3, 4)        # 3 rows, 4 cols (a view)
a.reshape(3, -1)       # -1 -> inferred as 4
a.reshape(-1, 2)       # -1 -> inferred as 6  => shape (6, 2)
a.reshape(-1)          # flatten to (12,)
```

`ravel` (view) vs `flatten` (copy):

```python
m = np.arange(6).reshape(2, 3)
r = m.ravel()          # view where possible
f = m.flatten()        # always a fresh copy
np.shares_memory(m, r), np.shares_memory(m, f)
# (True, False)
```

Transpose / swapaxes — strides permuted, no copy:

```python
m.T.shape              # (3, 2)
m.T.strides            # strides swapped vs m
np.swapaxes(m, 0, 1).shape   # (3, 2)  — same as .T for 2-D
```

Combine along axes:

```python
a = np.array([[1, 2], [3, 4]])
b = np.array([[5, 6], [7, 8]])
np.vstack((a, b)).shape        # (4, 2)  rows stacked
np.hstack((a, b)).shape        # (2, 4)  columns stacked
np.stack((a, b)).shape         # (2, 2, 2)  NEW leading axis
np.concatenate((a, b), axis=1).shape   # (2, 4)
```

Split back apart:

```python
c = np.arange(12).reshape(3, 4)
np.hsplit(c, 2)        # two (3,2) blocks
np.vsplit(c, 3)        # three (1,4) rows
np.array_split(np.arange(10), 3)   # unequal: sizes 4,3,3
```

## 4. Worked Example

Turn a flat sensor log into a per-day matrix, append a new day, then split off the last day — a realistic reshape → stack → split flow.

```python
import numpy as np

# 12 hourly readings across 3 days, flat
flat = np.arange(1, 13)                 # 1..12

# 1) reshape into (days, hours)  — a VIEW
grid = flat.reshape(3, 4)
print(grid)
# [[ 1  2  3  4]
#  [ 5  6  7  8]
#  [ 9 10 11 12]]

# 2) append a 4th day (new row) — vstack COPIES into a new buffer
day4 = np.array([13, 14, 15, 16])
grid = np.vstack((grid, day4))
print(grid.shape)                       # (4, 4)

# 3) column mean per hour, keep as a row via reshape(1, -1)
hourly_mean = grid.mean(axis=0).reshape(1, -1)
print(hourly_mean)                      # [[7. 8. 9. 10.]]

# 4) split off the last day for validation
train, valid = np.vsplit(grid, [3])     # rows [0:3] and [3:]
print(train.shape, valid.shape)         # (3, 4) (1, 4)
```

Result summary:

| step | op | shape | view or copy |
|---|---|---|---|
| reshape flat → grid | `reshape(3,4)` | (3, 4) | view |
| append day | `vstack` | (4, 4) | copy |
| hourly mean row | `mean(axis=0).reshape(1,-1)` | (1, 4) | copy (reduction) |
| train/valid split | `vsplit(.., [3])` | (3,4) / (1,4) | views into grid |

Note the asymmetry: reshaping and splitting cost nothing structurally, but the `vstack` genuinely allocates and copies.

## 5. Under the Hood

`reshape` and `transpose` never touch the data buffer — they compute a new `strides` tuple over the *same* memory. Transpose of a `(2,3)` array just swaps the two stride values, so the same bytes are now read column-first. That is why `.T` is O(1) but the result is **non-contiguous** (its strides no longer decrease left-to-right), which can slow later operations until you `np.ascontiguousarray` it.

`concatenate`/`stack` are fundamentally different: two independent buffers cannot be re-described as one, so NumPy allocates a new contiguous buffer sized to the total and copies both inputs in. `hstack`/`vstack` are thin wrappers over `concatenate` with a chosen axis.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah2" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">reshape(2,3) → (3,2): same buffer, new strides (a view)</text>

  <!-- flat buffer -->
  <text x="360" y="52" text-anchor="middle" fill="#64748b">shared flat buffer, row-major</text>
  <g>
    <rect x="150" y="60" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="210" y="60" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="270" y="60" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="330" y="60" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="390" y="60" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="450" y="60" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <text x="180" y="82" text-anchor="middle" fill="#1e293b">0</text>
    <text x="240" y="82" text-anchor="middle" fill="#1e293b">1</text>
    <text x="300" y="82" text-anchor="middle" fill="#1e293b">2</text>
    <text x="360" y="82" text-anchor="middle" fill="#1e293b">3</text>
    <text x="420" y="82" text-anchor="middle" fill="#1e293b">4</text>
    <text x="480" y="82" text-anchor="middle" fill="#1e293b">5</text>
  </g>

  <!-- left: (2,3) -->
  <text x="180" y="132" text-anchor="middle" fill="#1e293b" font-weight="700">shape (2,3)</text>
  <g>
    <rect x="110" y="145" width="42" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <rect x="152" y="145" width="42" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <rect x="194" y="145" width="42" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <text x="131" y="165" text-anchor="middle" fill="#1e293b">0</text>
    <text x="173" y="165" text-anchor="middle" fill="#1e293b">1</text>
    <text x="215" y="165" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="110" y="175" width="42" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <rect x="152" y="175" width="42" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <rect x="194" y="175" width="42" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <text x="131" y="195" text-anchor="middle" fill="#1e293b">3</text>
    <text x="173" y="195" text-anchor="middle" fill="#1e293b">4</text>
    <text x="215" y="195" text-anchor="middle" fill="#1e293b">5</text>
  </g>
  <text x="173" y="222" text-anchor="middle" fill="#64748b">strides (24, 8)</text>

  <line x1="300" y1="175" x2="360" y2="175" stroke="#475569" stroke-width="1.5" marker-end="url(#ah2)"/>
  <text x="330" y="167" text-anchor="middle" fill="#64748b">reshape</text>

  <!-- right: (3,2) -->
  <text x="470" y="132" text-anchor="middle" fill="#1e293b" font-weight="700">shape (3,2)</text>
  <g>
    <rect x="430" y="145" width="42" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <rect x="472" y="145" width="42" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <text x="451" y="165" text-anchor="middle" fill="#1e293b">0</text>
    <text x="493" y="165" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="430" y="175" width="42" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <rect x="472" y="175" width="42" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <text x="451" y="195" text-anchor="middle" fill="#1e293b">2</text>
    <text x="493" y="195" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="430" y="205" width="42" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <rect x="472" y="205" width="42" height="30" rx="5" fill="#ecfdf5" stroke="#059669"/>
    <text x="451" y="225" text-anchor="middle" fill="#1e293b">4</text>
    <text x="493" y="225" text-anchor="middle" fill="#1e293b">5</text>
  </g>
  <text x="470" y="252" text-anchor="middle" fill="#64748b">strides (16, 8)</text>
  <text x="360" y="285" text-anchor="middle" fill="#b91c1c">concatenate/stack instead allocate a NEW buffer + copy</text>
</svg>
```

## 6. Variations & Trade-offs

| operation | joins along | ndim change | copy? | typical use |
|---|---|---|---|---|
| `reshape` | — | same size | view (usually) | refold dimensions |
| `ravel` | — | → 1-D | view if possible | flatten cheaply |
| `flatten` | — | → 1-D | **always copy** | flatten, need independence |
| `.T` / `swapaxes` | — | same | view | matrix transpose |
| `concatenate` | existing axis | same | copy | general join |
| `stack` | **new** axis | +1 | copy | build a batch dimension |
| `hstack` / `vstack` | axis 1 / axis 0 | same | copy | glue cols / rows |
| `split` / `hsplit` / `vsplit` | — | same | views | chunk a dataset |

Prose: use `reshape`/`ravel`/`.T` when you want the cheapest possible transform and don't need an independent buffer. Reach for `flatten` or an explicit `.copy()` when downstream code will mutate and you must not alias the source. Prefer `concatenate` for known axes and `stack` only when you genuinely want a new dimension (e.g. stacking images into an `(N, H, W)` batch).

## 7. Production / Performance Notes

- **Building arrays by repeated `vstack`/`concatenate` in a loop is O(n²)** — each call copies everything so far. Collect chunks in a list and call `np.concatenate(list)` **once**.
- **Transpose returns non-contiguous views.** Feeding them to routines that assume contiguity (or that internally copy) can silently allocate. `np.ascontiguousarray` once if you'll reuse it heavily.
- **`reshape` may copy** when the array isn't contiguous (e.g. after a transpose). If you need a guaranteed view, keep operations contiguous or check `np.shares_memory`.
- **`reshape(-1, 1)` is the idiom** for turning a 1-D array into a single feature column for scikit-learn/pandas; `reshape(1, -1)` for a single sample row.
- **`squeeze` defensively** when an API returns spurious size-1 axes (e.g. `(n, 1)` predictions) that break broadcasting downstream.
- **`array_split` over `split`** when the number of parts may not divide evenly — `split` raises, `array_split` doesn't.

## 8. Common Mistakes

1. ⚠️ **`reshape` with a mismatched total size.** `np.arange(10).reshape(3, 4)` raises `ValueError: cannot reshape array of size 10 into shape (3,4)`. Fix: ensure the product matches, or use `-1` for the flexible axis.
2. ⚠️ **Assuming `ravel` gives an independent copy.** It's a view when possible, so mutating it edits the source. Fix: use `flatten()` or `.copy()` for independence.
3. ⚠️ **Confusing `stack` with `concatenate`.** `stack` adds a new axis (`(2,3)+(2,3)→(2,2,3)`); `concatenate` extends an existing one (`→(4,3)`). Pick by whether you want more rows or a new dimension.
4. ⚠️ **Mismatched non-join dimensions.** `concatenate` along axis 0 needs equal column counts. A shape error here means one array's other axis differs — check shapes before joining.
5. ⚠️ **`hstack` on 1-D arrays doesn't add a column.** `hstack((a,b))` on two `(3,)` arrays gives `(6,)`, not `(3,2)`. Fix: use `column_stack` or `np.stack(..., axis=1)`.
6. ⚠️ **Growing arrays with `np.append`/`vstack` inside a loop.** Quadratic copying. Fix: append to a Python list, concatenate once at the end.
7. ⚠️ **Forgetting a transpose is non-contiguous.** `a.T.reshape(-1)` may copy; `a.reshape(-1)` on the original may not. Know when you've broken contiguity.

## 9. Interview Questions

**Q: What's the difference between `ravel()` and `flatten()`?**
A: Both return a 1-D array of the same elements. `ravel()` returns a **view** onto the original buffer when the memory layout allows (cheap, aliased), while `flatten()` **always returns a fresh copy** (safe, independent). Use `ravel` for speed, `flatten` when you must not alias the source.

**Q: Does `reshape` copy the data?**
A: Usually not — it returns a view by rewriting `shape`/`strides` over the same buffer, so it's O(1). It copies only when the requested shape can't be expressed as a re-striding of the current (often non-contiguous) layout, in which case NumPy silently makes a contiguous copy. Check with `np.shares_memory`.

**Q: What does the `-1` mean in `reshape(-1, 4)`?**
A: It's a placeholder telling NumPy to infer that dimension from the total size and the other fixed dimensions. Here it computes `size // 4` rows. Exactly one axis may be `-1`; `reshape(-1)` alone flattens to 1-D.

**Q: Difference between `stack` and `concatenate`?**
A: `concatenate` joins along an **existing** axis and keeps `ndim` the same (all other axes must match). `stack` introduces a **new** axis, increasing `ndim` by one, and requires all inputs to be identically shaped. `vstack`/`hstack` are `concatenate` wrappers for axis 0/1.

**Q: How does transpose avoid copying data?**
A: It permutes the `strides` (and `shape`) tuple without touching the buffer — the same bytes are simply traversed in a different order. The result is a view but is typically non-contiguous, so later contiguity-dependent operations may copy.

**Q: How do you convert a 1-D array into a single-column 2-D array?**
A: `a.reshape(-1, 1)` (or `a[:, np.newaxis]`). This is the standard way to feed a feature into scikit-learn, which expects 2-D `(n_samples, n_features)`. `reshape(1, -1)` gives a single-row 2-D array for a single sample.

**Q (senior): Why is building an array by repeatedly concatenating in a loop a performance bug, and what's the fix?**
A: Each `concatenate`/`vstack` allocates a new buffer and copies all accumulated data, so total work is O(n²) in the number of elements. The fix is to accumulate chunks in a Python list and call `np.concatenate` (or `np.vstack`) **once** at the end — a single allocation and copy.

**Q (senior): You transpose a large array then reshape it and notice a memory spike. Explain.**
A: Transpose produces a non-contiguous view (strides swapped). When you then `reshape` in a way that can't be satisfied by re-striding that non-contiguous layout, NumPy must materialize a contiguous copy — hence the allocation. Either avoid the transpose, operate on the contiguous original, or accept/precompute the copy deliberately with `ascontiguousarray`.

**Q (senior): How would you split a dataset into 3 folds when the length isn't divisible by 3?**
A: Use `np.array_split(arr, 3)`, which allows unequal parts (e.g. lengths 4,3,3 for 10) instead of `np.split`, which raises when the split isn't even. For arbitrary boundaries, pass an index list: `np.split(arr, [i, j])`.

## 10. Practice

- [ ] Take `np.arange(24)` and reshape it to `(2,3,4)`, `(4,6)`, and `(-1,8)`; verify each `size` matches and print the strides.
- [ ] Show empirically (via `np.shares_memory`) that `ravel` aliases but `flatten` copies for a contiguous array — then repeat on a transposed array and explain the difference.
- [ ] Given three `(100, 5)` feature blocks, combine them into one `(300, 5)` array with a single call, and into a `(3, 100, 5)` batch with another.
- [ ] Split a `(3, 8)` array into 4 column blocks with `hsplit`, then reassemble with `hstack` and assert equality.
- [ ] Turn a `(6,)` and another `(6,)` array into a `(6, 2)` matrix two different ways (`column_stack` and `stack(axis=1)`).

## 11. Cheat Sheet

> [!TIP]
> **Reshape = rewrite the header (cheap view). Stack = allocate a new buffer (copy).**
> - `reshape(new)` / `reshape(-1, k)` — refold; one `-1` inferred; view when contiguous.
> - `ravel()` view · `flatten()` **always copies** · `.T` / `swapaxes` permute strides (view, non-contiguous).
> - Join: `concatenate(axis=)` existing axis · `stack(axis=)` **new** axis · `vstack` rows · `hstack` cols · `column_stack` 1-D→cols.
> - Split: `split` / `hsplit` / `vsplit` (even) · `array_split` (uneven) · pass index list for custom cuts.
> - Never loop-concatenate (O(n²)) — collect in a list, `np.concatenate` once.
> - Shape a feature: `reshape(-1, 1)` column · `reshape(1, -1)` row · `squeeze`/`expand_dims` to fix size-1 axes.

**References:** NumPy docs (Array manipulation routines; `reshape`, `ravel`, `stack`, `concatenate`, `split`), NumPy "Absolute Beginner's Guide" (reshaping section), Jake VanderPlas "Python Data Science Handbook" (Ch. 2)

---
*NumPy & Pandas Handbook — topic 05.*
