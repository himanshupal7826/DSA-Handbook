# 04 · Fancy & Boolean Indexing

> **In one line:** Select arbitrary elements with an **integer array** or a **boolean mask** — powerful, expressive, and always a **copy** (never a view).

---

## 1. Overview

Basic slicing (topic 03) can only carve regular strided windows. **Fancy indexing** (indexing with an array of integers) and **boolean indexing** (indexing with a mask of `True`/`False`) break that limitation: you can gather elements in any order, pick scattered rows, or filter by a condition — `a[a > 0]`. This is the vectorized replacement for Python `for`/`if` loops over data.

The crucial distinction from basic slicing: **advanced indexing always returns a copy, never a view.** The selected elements can't be described by a single offset+stride, so NumPy must allocate a fresh contiguous array. That means reading is safe (independent) but `a[mask] = x` still writes back — assignment is special-cased.

You use these everywhere in data work: filter rows where a column exceeds a threshold, reorder by a sort permutation, one-hot lookups, conditional replacement with `np.where`, and finding positions with `np.nonzero`. Mastering masks is what turns slow Python loops into fast array code.

## 2. Core Concepts

- **Integer-array (fancy) indexing:** `a[[2, 0, 2, 5]]` gathers those positions *in that order*, duplicates allowed. Result shape follows the **index array's** shape.
- **Boolean mask indexing:** `a[mask]` keeps elements where `mask` is `True`. The mask must be broadcastable to (usually the same shape as) the array; the result is 1D of the count of `True`s.
- **Always a copy.** Advanced indexing can't be expressed as a strided view, so it allocates. `a[idx].base is None`.
- **Assignment is the exception.** `a[mask] = 0` and `a[idx] = vals` write back into `a` in place, even though reading produces a copy.
- **`np.where(cond, x, y)`** is vectorized ternary: pick from `x` where `cond` else `y`. With one arg, `np.where(cond)` returns index tuples (like `nonzero`).
- **`np.nonzero(a)`** returns a tuple of index arrays (one per axis) of the nonzero/`True` elements — the engine behind boolean indexing.
- **Combine masks with `&`, `|`, `~`** (bitwise), *not* Python `and`/`or`. Parenthesize: `(a > 0) & (a < 10)`.
- **Multi-axis fancy indexing pairs elementwise:** `a[[0,1],[2,3]]` picks `a[0,2]` and `a[1,3]`, not a sub-block.
- **Duplicate indices in `+=` don't accumulate;** use `np.add.at(a, idx, 1)` for unbuffered scatter-add.

## 3. Syntax & Examples

```python
import numpy as np
a = np.array([10, 20, 30, 40, 50])

# Fancy: integer array, any order, duplicates OK
a[[4, 0, 2, 2]]            # array([50, 10, 30, 30])

# Boolean mask: same-shape True/False
mask = a > 25              # array([False, False,  True,  True,  True])
a[mask]                    # array([30, 40, 50])
a[a % 20 == 0]             # array([20, 40])

# Assignment writes back through both
a[a > 25] = 0              # a -> [10 20 0 0 0]
```

Combining conditions and `np.where`:

```python
x = np.arange(-3, 4)                 # [-3 -2 -1  0  1  2  3]
x[(x > -2) & (x < 2)]                # array([-1, 0, 1])  -- & not 'and', parens required

np.where(x < 0, 0, x)                # array([0, 0, 0, 0, 1, 2, 3])  clamp negatives
np.where(x < 0)                      # (array([0, 1, 2]),)  positions of matches
np.nonzero(x)                        # (array([0,1,2,4,5,6]),)  nonzero positions
```

Fancy indexing in 2D (elementwise pairing vs. row selection):

```python
M = np.arange(12).reshape(3, 4)
M[[0, 2]]                # rows 0 and 2  -> shape (2,4)
M[[0, 1, 2], [1, 2, 3]]  # array([1, 6, 11])  diagonal-ish: (0,1),(1,2),(2,3)
M[:, [3, 0]]             # reorder columns -> shape (3,2)
```

## 4. Worked Example

Filter a dataset, then conditionally transform it — the everyday pattern.

```python
import numpy as np
rng = np.random.default_rng(0)

temps = rng.integers(-5, 40, size=12)     # daily temps (°C)
print("temps:", temps)

# 1. Boolean filter: warm days
warm = temps[temps >= 25]
print("warm days:", warm)

# 2. Combined mask: mild days (10..25), count via nonzero
mild_mask = (temps >= 10) & (temps < 25)
mild_positions = np.nonzero(mild_mask)[0]
print("mild day indices:", mild_positions, "count:", mild_mask.sum())

# 3. np.where: clamp negatives to 0 (a copy, temps unchanged)
clamped = np.where(temps < 0, 0, temps)
print("clamped:", clamped)

# 4. In-place scatter: flag freezing days
temps[temps < 0] = -99
print("flagged:", temps)
```

```text
temps: [21 24 34 20 10  1 30 33 21 21 24 26]
warm days: [34 30 33 26]
mild day indices: [0 1 3 4 8 9 10] count: 7
clamped: [21 24 34 20 10  1 30 33 21 21 24 26]
flagged: [21 24 34 20 10  1 30 33 21 21 24 26]
```

`clamped` is a fresh array (no negatives existed here, but `np.where` still copies). The in-place `temps[temps < 0] = -99` found no matches this seed, leaving `temps` intact — proving assignment only touches masked positions.

## 5. Under the Hood

A boolean mask is really a compact way of producing integer positions. `a[mask]` is equivalent to `a[np.nonzero(mask)]` — NumPy finds the `True` positions, then gathers them. Because those positions are arbitrary, the output must be a newly allocated contiguous block: **there is no single stride that visits `{2, 0, 2, 5}`.** Hence advanced indexing copies.

```svg
<svg viewBox="0 0 640 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">Boolean mask → nonzero positions → gathered COPY</text>

  <text x="70" y="60" text-anchor="middle" fill="#64748b">a</text>
  <g>
    <rect x="30"  y="70" width="70" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="65"  y="94" text-anchor="middle" fill="#1e293b">10</text>
    <rect x="105" y="70" width="70" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="140" y="94" text-anchor="middle" fill="#1e293b">20</text>
    <rect x="180" y="70" width="70" height="38" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="215" y="94" text-anchor="middle" fill="#1e293b">30</text>
    <rect x="255" y="70" width="70" height="38" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="290" y="94" text-anchor="middle" fill="#1e293b">40</text>
    <rect x="330" y="70" width="70" height="38" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="365" y="94" text-anchor="middle" fill="#1e293b">50</text>
  </g>

  <text x="70" y="150" text-anchor="middle" fill="#64748b">mask = a &gt; 25</text>
  <g>
    <rect x="30"  y="160" width="70" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/><text x="65"  y="182" text-anchor="middle" fill="#1e293b">F</text>
    <rect x="105" y="160" width="70" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/><text x="140" y="182" text-anchor="middle" fill="#1e293b">F</text>
    <rect x="180" y="160" width="70" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="215" y="182" text-anchor="middle" fill="#1e293b">T</text>
    <rect x="255" y="160" width="70" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="290" y="182" text-anchor="middle" fill="#1e293b">T</text>
    <rect x="330" y="160" width="70" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="365" y="182" text-anchor="middle" fill="#1e293b">T</text>
  </g>

  <text x="470" y="182" text-anchor="middle" fill="#64748b">nonzero → [2,3,4]</text>
  <line x1="400" y1="177" x2="400" y2="177" stroke="#475569"/>

  <line x1="215" y1="194" x2="230" y2="250" stroke="#475569" marker-end="url(#ar2)"/>
  <line x1="290" y1="194" x2="300" y2="250" stroke="#475569" marker-end="url(#ar2)"/>
  <line x1="365" y1="194" x2="370" y2="250" stroke="#475569" marker-end="url(#ar2)"/>

  <text x="130" y="278" text-anchor="middle" fill="#64748b">a[mask] (new buffer)</text>
  <g>
    <rect x="210" y="258" width="70" height="38" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="245" y="282" text-anchor="middle" fill="#1e293b">30</text>
    <rect x="285" y="258" width="70" height="38" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="320" y="282" text-anchor="middle" fill="#1e293b">40</text>
    <rect x="360" y="258" width="70" height="38" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="395" y="282" text-anchor="middle" fill="#1e293b">50</text>
  </g>
  <text x="540" y="282" text-anchor="middle" fill="#b91c1c">COPY (.base is None)</text>
</svg>
```

Multi-axis fancy indexing broadcasts the index arrays together and pairs them **elementwise**: `a[rows, cols]` yields `a[rows[k], cols[k]]` for each `k`. That's why `M[[0,1,2],[1,2,3]]` returns three picked elements, not a `3×3` block — a frequent surprise.

## 6. Variations & Trade-offs

| Technique | Selector | Result shape | View/Copy | Use when |
|---|---|---|---|---|
| Basic slice | `a[1:5]` | strided range | **view** | regular windows |
| Fancy (int array) | `a[[3,1,3]]` | index-array shape | **copy** | arbitrary/reordered picks |
| Boolean mask | `a[a>0]` | 1D, count of True | **copy** | filter by condition |
| `np.where(c,x,y)` | condition | broadcast shape | **copy** | conditional replace |
| `np.nonzero(a)` | array | tuple of index arrays | — | get positions |
| `np.add.at` | int array | in place | in place | duplicate-safe scatter |

Masks are the most readable for filtering; fancy integer indexing is the tool for reordering, sampling, and lookups (e.g., `palette[label_ids]`). `np.where` shines for elementwise conditional assignment without an intermediate mask variable. All three cost an allocation — fine for most work, but in tight loops prefer boolean *assignment* (`a[mask] = v`) which avoids a second array.

## 7. Production / Performance Notes

- **Vectorize, don't loop.** Replacing a Python `for`/`if` filter with `a[a > t]` is often 50–200× faster; the comparison and gather run in C.
- **Reuse masks.** A boolean mask is a real array; compute once, use for multiple columns: `df_vals[mask]`, `weights[mask]`.
- **`&`/`|` bind loosely — parenthesize.** `a > 0 & a < 10` parses as `a > (0 & a) < 10` and errors. Always `(a > 0) & (a < 10)`.
- **Duplicate-index `+=` silently under-counts.** `a[[0,0,0]] += 1` adds 1, not 3, because the RHS is computed once. Use `np.add.at(a, [0,0,0], 1)` for correct scatter accumulation.
- **Masks cost memory:** a boolean mask over an N-element array is N bytes; over a huge array that's non-trivial. Fuse conditions or use `np.count_nonzero(cond)` when you only need the count (no gather).
- **`np.where` with scalars is cheap; with big arrays it evaluates both branches** — don't put expensive/side-effecting expressions in `x` or `y`.

## 8. Common Mistakes

1. ⚠️ **Using `and`/`or` to combine masks.** They call `__bool__` on the whole array → `ValueError: truth value is ambiguous`. Fix: `&`, `|`, `~` with parentheses.
2. ⚠️ **Expecting a view from `a[mask]`.** It's a copy; mutating it won't change `a`. To edit in place, assign: `a[mask] = ...`.
3. ⚠️ **Expecting a sub-block from `a[[0,1],[2,3]]`.** That's elementwise pairing → 2 elements. For a block use `a[[0,1]][:, [2,3]]` or `np.ix_`.
4. ⚠️ **Mask length mismatch.** A boolean index must match the axis length; a shorter/longer mask raises `IndexError`.
5. ⚠️ **`+=` on duplicate fancy indices** under-accumulating. Fix: `np.add.at`.
6. ⚠️ **Chained boolean assignment** like `a[a>0][a<10] = 0` — the first index makes a copy, so the write is lost. Combine into one mask.
7. ⚠️ **Forgetting `np.where(cond)` returns a tuple.** Index it: `np.where(cond)[0]` for the first axis.
8. ⚠️ **Building a mask when you only need a count** — use `np.count_nonzero(cond)` to skip the gather allocation.

## 9. Interview Questions

**Q: Do fancy and boolean indexing return a view or a copy?**
A: Always a copy. The selected elements can't be described by a fixed offset and stride, so NumPy allocates a new contiguous array. (Assignment through them is the special in-place exception.)

**Q: How do you combine two conditions in a boolean mask?**
A: With bitwise operators and parentheses: `(a > 0) & (a < 10)`. Python's `and`/`or` don't work because they try to take the truth value of the whole array.

**Q: What does `np.where` do in its one-argument vs three-argument form?**
A: `np.where(cond, x, y)` is a vectorized ternary returning `x` where `cond` else `y`. `np.where(cond)` returns a tuple of index arrays of the `True` positions, equivalent to `np.nonzero(cond)`.

**Q: What's the difference between `M[[0,1],[2,3]]` and `M[[0,1]][:,[2,3]]`?**
A: The first pairs indices elementwise → `[M[0,2], M[1,3]]` (2 elements). The second selects rows 0,1 then columns 2,3 → a `2×2` sub-block.

**Q: Why does `a[[0,0,0]] += 1` add only 1 instead of 3?**
A: The right-hand side `a[[0,0,0]] + 1` is computed once against the original values, then assigned, so duplicates don't accumulate. Use `np.add.at(a, [0,0,0], 1)` for unbuffered scatter-add.

**Q: How is boolean indexing related to `np.nonzero`?**
A: `a[mask]` is equivalent to `a[np.nonzero(mask)]` — the mask is converted to integer positions of its `True` entries, which are then gathered.

**Q: How do you filter and modify in place given a condition?**
A: Assign through the mask: `a[a < 0] = 0`. Reading `a[a<0]` copies, but assignment writes back into `a` at the masked positions.

**Q: (Senior) When is a boolean mask cheaper than fancy integer indexing, and vice versa?**
A: A mask is natural and cache-friendly for condition-based filtering of a full array. Integer indexing wins for sparse/reordered selection or lookups (gathering a few scattered elements from a huge array) where building a full-length mask would waste memory.

**Q: (Senior) How would you one-hot / map labels to values efficiently?**
A: Use fancy indexing as a lookup table: `palette[label_ids]` where `label_ids` is an integer array — a single vectorized gather, no loop.

**Q: (Senior) Why can chained boolean assignment silently fail?**
A: The first advanced index produces a copy; assigning into the second index writes to that temporary copy, which is discarded. You must express the selection as a single combined mask so the write targets the original.

## 10. Practice

- [ ] From a random integer array, extract all values divisible by 3 using a boolean mask.
- [ ] Use `np.where` to replace negatives with 0 and values > 100 with 100 (clamp), in one expression via nesting.
- [ ] Given `labels` (ints 0–2) and a `colors` array of 3 RGB rows, produce per-label colors with a single fancy index.
- [ ] Count how many elements satisfy `(x > 0) & (x % 2 == 0)` without allocating the filtered array.
- [ ] Demonstrate the `+=` duplicate-index pitfall, then fix it with `np.add.at`.

## 11. Cheat Sheet

> [!TIP]
> **Fancy & Boolean Indexing** — advanced indexing = **always a COPY** (assignment writes back).
> Fancy: `a[[2,0,2]]` gathers positions in order, dups OK; result follows index shape.
> Boolean: `a[a>0]` keeps True elements → 1D. Combine with `&` `|` `~` + **parentheses**.
> Multi-axis fancy pairs **elementwise**: `a[[0,1],[2,3]]` = `[a[0,2], a[1,3]]`.
> `np.where(c,x,y)` = vectorized ternary; `np.where(c)`/`np.nonzero(c)` = positions.
> Duplicate `+=` under-counts → use `np.add.at`. Count only? `np.count_nonzero`.

**References:** NumPy User Guide — Advanced indexing; NumPy Reference — `where`, `nonzero`, `add.at`; SciPy Lecture Notes — Fancy indexing

---

*NumPy & Pandas Handbook — topic 04.*
