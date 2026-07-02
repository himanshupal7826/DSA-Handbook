# 02 · Data Types, Memory & Strides

> **In one line:** How NumPy interprets raw bytes — dtype fixes the element size, strides fix the layout, and both decide whether a slice is a free view or an expensive copy.

---

## 1. Overview

Under every ndarray is a flat block of bytes. The **dtype** says how many bytes one element takes and how to read them; the **strides** say how many bytes to step to move along each axis. Change either and you change the *interpretation* of the same bytes — often for free.

This layer is where performance is won or lost. Choosing `float32` over `float64` halves your memory. Reading a matrix in the wrong order (C vs Fortran) can be 10× slower because of cache misses. And the single most common source of "why did my original array change?!" bugs is not knowing when an operation returned a **view** (shares memory) versus a **copy** (independent memory).

You reach for this knowledge whenever you profile a memory-heavy pipeline, interop with C/Fortran/BLAS code, debug an aliasing bug, or try to squeeze a big dataset into RAM. It's the difference between using NumPy and *understanding* it.

The mental model: an ndarray never "contains" a 2-D grid. It contains a 1-D buffer plus a rule (dtype + strides + shape) for pretending it's N-D. Most reshaping is just rewriting the rule.

## 2. Core Concepts

- **dtype** — the element type object: `int64`, `float32`, `bool`, `complex128`, fixed-width strings `<U10`, and structured/record types. Carries `itemsize`, byte order, and kind.
- **itemsize** — bytes per element (`float64` → 8, `int32` → 4, `bool` → 1). `nbytes == size * itemsize`.
- **byte order (endianness)** — `<` little-endian, `>` big-endian; matters when reading binary files from another platform.
- **C order (row-major)** — last axis varies fastest; the default. Rows are contiguous.
- **Fortran order (column-major)** — first axis varies fastest; columns are contiguous. Used by BLAS/LAPACK, MATLAB, R.
- **strides** — bytes to jump per axis. Derived from shape + itemsize + order; the heart of view-based reshaping.
- **view** — a new header over the *same* buffer (`b.base is a`); `may_share_memory(a, b)` is True. O(1), zero copy.
- **copy** — an independent buffer; mutating it never touches the source. Produced by fancy indexing, `astype`, `.copy()`.
- **`as_strided`** — a low-level tool to fabricate arbitrary strides over a buffer; powerful and *dangerous* (can read out of bounds).

## 3. Syntax & Examples

Inspecting dtype and size:

```python
import numpy as np

a = np.ones((3, 4), dtype=np.float32)
a.dtype           # dtype('float32')
a.dtype.itemsize  # 4
a.nbytes          # 48  = 12 elements * 4 bytes
a.dtype.kind      # 'f'  (b=bool, i=int, u=uint, f=float, c=complex, U=unicode)
```

C vs Fortran order and the strides they imply:

```python
c = np.arange(6).reshape(2, 3)              # C order (default)
c.strides                                   # (24, 8): 24B to next row, 8B to next col
c.flags['C_CONTIGUOUS'], c.flags['F_CONTIGUOUS']   # (True, False)

f = np.asfortranarray(c)
f.strides                                   # (8, 16): 8B to next row, 16B to next col
f.flags['F_CONTIGUOUS']                     # True
```

Casting changes dtype and always copies:

```python
x = np.array([1.9, 2.5, 3.1])
x.astype(np.int64)      # array([1, 2, 3])  -> truncates toward zero, NEW buffer
x.astype(np.int64).base is None   # True: it's a copy
```

Views vs copies — the crucial test:

```python
a = np.arange(10)
v = a[2:8]              # basic slice -> VIEW
v.base is a            # True
np.may_share_memory(a, v)   # True
v[0] = 999
a[2]                    # 999  <- source mutated!

c = a[[2, 3, 4]]        # fancy index -> COPY
c.base is a            # False
c[0] = -1
a[2]                    # unchanged
```

## 4. Worked Example

Measure how memory layout (C vs Fortran) changes summation speed, and confirm the view/copy distinction on the same data.

```python
import numpy as np, time

n = 4000
c = np.ones((n, n), dtype=np.float64)     # C-contiguous: rows adjacent
f = np.asfortranarray(c)                  # same values, columns adjacent

def timed(fn):
    t = time.perf_counter(); fn(); return (time.perf_counter()-t)*1000

# sum along axis 1 walks each row -> fast when rows are contiguous (C)
print("C-order, sum axis=1:", f"{timed(lambda: c.sum(axis=1)):.1f} ms")
print("F-order, sum axis=1:", f"{timed(lambda: f.sum(axis=1)):.1f} ms")

# a row slice of a C array is a view; a column slice may not be contiguous
row = c[0]                 # view, C-contiguous
col = c[:, 0]              # view, but stride = 32000 bytes -> cache-hostile
print("row is view:", row.base is not None, "col is view:", col.base is not None)
print("col contiguous:", col.flags['C_CONTIGUOUS'])
```

```text
C-order, sum axis=1: 11.4 ms
F-order, sum axis=1: 78.9 ms
row is view: True col is view: True
col contiguous: False
```

Same numbers, same operation — 7× slower purely because Fortran layout makes row-wise summation jump across memory, blowing the cache. Both `row` and `col` are views (share the buffer), but `col`'s large stride makes it a slow view.

## 5. Under the Hood

Strides are how one flat buffer pretends to be N-dimensional. For a C-order `(2, 3)` `int64` array, moving one column costs `itemsize = 8` bytes; moving one row costs `3 * 8 = 24` bytes. Transposing simply **swaps the strides** — no data moves, which is why `.T` is free and why a transpose is often non-contiguous.

```svg
<svg viewBox="0 0 720 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah2" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Same buffer, different strides → C-order vs its transpose</text>

  <!-- shared buffer -->
  <text x="360" y="52" text-anchor="middle" fill="#64748b">flat buffer (bytes):  values 0..5, itemsize=8</text>
  <g>
    <rect x="90" y="62" width="90" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="180" y="62" width="90" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="270" y="62" width="90" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="360" y="62" width="90" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="450" y="62" width="90" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="540" y="62" width="90" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/>
    <text x="135" y="86" text-anchor="middle" fill="#1e293b">0</text>
    <text x="225" y="86" text-anchor="middle" fill="#1e293b">1</text>
    <text x="315" y="86" text-anchor="middle" fill="#1e293b">2</text>
    <text x="405" y="86" text-anchor="middle" fill="#1e293b">3</text>
    <text x="495" y="86" text-anchor="middle" fill="#1e293b">4</text>
    <text x="585" y="86" text-anchor="middle" fill="#1e293b">5</text>
    <text x="135" y="118" text-anchor="middle" fill="#64748b">B0</text>
    <text x="405" y="118" text-anchor="middle" fill="#64748b">B24</text>
    <text x="585" y="118" text-anchor="middle" fill="#64748b">B40</text>
  </g>

  <!-- C order view -->
  <text x="185" y="160" text-anchor="middle" fill="#059669" font-weight="700">a  shape=(2,3)  strides=(24,8)</text>
  <g>
    <rect x="70" y="172" width="70" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
    <rect x="140" y="172" width="70" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
    <rect x="210" y="172" width="70" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
    <rect x="70" y="206" width="70" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
    <rect x="140" y="206" width="70" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
    <rect x="210" y="206" width="70" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
    <text x="105" y="194" text-anchor="middle" fill="#1e293b">0</text>
    <text x="175" y="194" text-anchor="middle" fill="#1e293b">1</text>
    <text x="245" y="194" text-anchor="middle" fill="#1e293b">2</text>
    <text x="105" y="228" text-anchor="middle" fill="#1e293b">3</text>
    <text x="175" y="228" text-anchor="middle" fill="#1e293b">4</text>
    <text x="245" y="228" text-anchor="middle" fill="#1e293b">5</text>
  </g>
  <text x="185" y="262" text-anchor="middle" fill="#64748b">rows contiguous → cache-friendly</text>

  <!-- transpose view -->
  <text x="530" y="160" text-anchor="middle" fill="#d97706" font-weight="700">a.T  shape=(3,2)  strides=(8,24)</text>
  <g>
    <rect x="440" y="172" width="70" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
    <rect x="510" y="172" width="70" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
    <rect x="440" y="206" width="70" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
    <rect x="510" y="206" width="70" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
    <rect x="440" y="240" width="70" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
    <rect x="510" y="240" width="70" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
    <text x="475" y="194" text-anchor="middle" fill="#1e293b">0</text>
    <text x="545" y="194" text-anchor="middle" fill="#1e293b">3</text>
    <text x="475" y="228" text-anchor="middle" fill="#1e293b">1</text>
    <text x="545" y="228" text-anchor="middle" fill="#1e293b">4</text>
    <text x="475" y="262" text-anchor="middle" fill="#1e293b">2</text>
    <text x="545" y="262" text-anchor="middle" fill="#1e293b">5</text>
  </g>
  <text x="510" y="292" text-anchor="middle" fill="#64748b">strides swapped, no bytes moved</text>

  <path d="M300 90 C 330 130, 300 150, 200 170" fill="none" stroke="#475569" stroke-width="1.4" marker-end="url(#ah2)"/>
  <path d="M420 90 C 470 130, 500 150, 510 170" fill="none" stroke="#475569" stroke-width="1.4" marker-end="url(#ah2)"/>
  <text x="360" y="335" text-anchor="middle" fill="#1e293b">Both are VIEWS over one buffer — `a.T.base is a` → True</text>
</svg>
```

`np.lib.stride_tricks.as_strided` lets you hand-craft strides — e.g. a zero-stride axis to broadcast, or overlapping windows for a rolling mean without copying. But it bypasses all bounds checking: a wrong stride reads arbitrary memory or crashes the interpreter. Prefer `sliding_window_view` (a safe wrapper) in production.

## 6. Variations & Trade-offs

| Aspect | View | Copy |
|---|---|---|
| Memory | shares source buffer, O(1) | new buffer, O(n) |
| Mutation | writes propagate to source | independent |
| Produced by | basic slicing, `reshape`, `.T`, `ravel` | fancy/boolean index, `astype`, `.copy()`, `flatten` |
| Test | `b.base is a`, `may_share_memory` | `b.base is None` |

| Dtype choice | itemsize | Range / precision | When |
|---|---|---|---|
| `int8` / `uint8` | 1 | -128..127 / 0..255 | pixels, flags, categories |
| `int32` | 4 | ±2.1e9 | counters, indices |
| `int64` | 8 | ±9.2e18 | default int, safe sums |
| `float32` | 4 | ~7 sig digits | ML features, big arrays |
| `float64` | 8 | ~15 sig digits | default, scientific accuracy |

The core trade-off: **views** are fast and memory-cheap but alias the source (mutation hazard); **copies** are safe but cost memory and time. Smaller dtypes save RAM at the cost of range/precision. C vs Fortran order is a trade between fast row-wise and fast column-wise access — match it to your dominant access pattern and to any BLAS/LAPACK routine you feed.

## 7. Production / Performance Notes

- **Downcast deliberately.** `df.astype('float32')` or `int32` can halve a pipeline's memory. Verify the value range first so you don't overflow or lose precision.
- **Match order to access pattern and to BLAS.** LAPACK/BLAS expect Fortran order internally; feeding a C array to `scipy.linalg` may trigger a hidden copy. For row-wise reductions keep C order; for column-wise keep Fortran.
- **Force contiguity before hot loops.** `np.ascontiguousarray(a)` after a transpose/slice restores SIMD-friendly layout; the one-time copy pays off in a tight loop.
- **Use `may_share_memory` in tests** to assert whether a function returned a view or a copy — cheap insurance against aliasing regressions.
- **Reach for `sliding_window_view`, not `as_strided`,** for rolling windows. `as_strided` has no safety net and is a classic source of segfaults and silent corruption.
- **Structured dtypes** (`np.dtype([('x', 'f4'), ('id', 'i8')])`) pack heterogeneous records contiguously — great for binary file parsing, but pandas is usually more ergonomic for tabular work.

## 8. Common Mistakes

1. ⚠️ **Mutating a slice and being surprised the original changed.** Basic slices are views. *Fix:* `.copy()` when you need independence; test with `may_share_memory`.
2. ⚠️ **Assuming fancy indexing returns a view you can write through.** It's a copy; `a[idx] = ...` works (assignment) but `a[idx][j] = ...` writes to a throwaway copy. *Fix:* assign in one step: `a[idx] = values`.
3. ⚠️ **Feeding a transposed (non-contiguous) array to a C routine and paying a silent copy.** *Fix:* `np.ascontiguousarray` up front, or keep the right order.
4. ⚠️ **Downcasting past the value range.** `astype(np.int8)` on values > 127 wraps silently. *Fix:* check `min`/`max` before casting.
5. ⚠️ **`astype` for a cheap "reshape".** `astype` always copies; use `reshape`/`view` when you only want to reinterpret shape. *Fix:* know that only dtype changes need `astype`.
6. ⚠️ **Using `as_strided` for windows in prod.** One wrong number reads out of bounds. *Fix:* `np.lib.stride_tricks.sliding_window_view`.
7. ⚠️ **Ignoring endianness when reading binary files** from another platform. *Fix:* specify byte order in the dtype (`>i4`) or `.byteswap()`.

## 9. Interview Questions

**Q: What is a stride, concretely?**
A: The number of *bytes* you step in the buffer to advance one index along a given axis. For a C-order `(2,3)` int64 array, strides are `(24, 8)`: 24 bytes to the next row, 8 to the next column. Strides let a 1-D buffer be indexed as N-D.

**Q: How do you tell whether `b = a[...]` is a view or a copy?**
A: Check `b.base is a` (a view's `base` points at the owner) or `np.may_share_memory(a, b)`. Basic slicing/reshape/transpose give views; fancy and boolean indexing, `astype`, and `.copy()` give copies.

**Q: Why is `a.T` essentially free?**
A: Transpose just swaps the shape and strides in the header; no bytes move. The cost is that the result is usually non-contiguous, which can slow later operations.

**Q: C order vs Fortran order — what's the difference and why does it matter?**
A: C (row-major) stores rows contiguously; Fortran (column-major) stores columns contiguously. It matters for cache performance — reductions along the contiguous axis are far faster — and for interop with BLAS/LAPACK/MATLAB/R which expect Fortran.

**Q: Does `reshape` copy?**
A: Usually no — it returns a view when the new shape is compatible with the current strides. If it can't (e.g. reshaping a non-contiguous array in a way that needs reordering), it silently returns a copy.

**Q: Why does downcasting to a smaller dtype save memory and what's the risk?**
A: Fewer bytes per element (`itemsize`) means a smaller buffer. The risk is overflow (integers wrap) or precision loss (floats), so validate the value range before casting.

**Q: What does `astype` do that `view` doesn't?**
A: `astype` converts values to a new dtype and always allocates a new buffer (a copy). `.view(dtype)` reinterprets the same bytes under a new dtype without converting — useful but easy to misuse.

**Q: (Senior) You pass a sliced column of a large C-order matrix into a tight numeric loop and it's slow despite being a view. Why?**
A: The column has a large stride (one row-width per element), so consecutive reads jump across memory and miss cache. It's a "view" but not contiguous. Fix with `ascontiguousarray` or store the data Fortran-order if column access dominates.

**Q: (Senior) What is `as_strided` and why is it dangerous?**
A: It builds an array with hand-specified shape and strides over an existing buffer, enabling zero-copy tricks like overlapping rolling windows or broadcasting. It performs no bounds checking, so incorrect strides read arbitrary memory or segfault. Prefer `sliding_window_view`.

**Q: (Senior) How would you assert in a unit test that your function returns a view rather than copying a 10 GB array?**
A: Call it, then assert `np.may_share_memory(input, output)` is True (or `output.base is input`). This catches accidental copies that would blow the memory budget.

## 10. Practice

- [ ] Build a `(3,4)` C-order array; print its strides, then print `.T`'s strides and confirm they're swapped and share `base`.
- [ ] Slice a row and a column from a large 2-D array; check `flags['C_CONTIGUOUS']` for each and explain the difference.
- [ ] Take `a = np.arange(10)`, make `v = a[::2]`, mutate `v`, and show that `a` changed; then repeat with a fancy index and show it doesn't.
- [ ] Cast a `float64` array of large values to `int8` and demonstrate the overflow wrap.
- [ ] Time `sum(axis=1)` on the same data stored C-order vs Fortran-order and report the ratio.

## 11. Cheat Sheet

> [!TIP]
> **dtype = how to read one element; strides = how to step between them.** `nbytes = size * itemsize`.
> **View** (shares buffer, O(1)): basic slice, `reshape`, `.T`, `ravel`. Test `b.base is a` / `may_share_memory`.
> **Copy** (new buffer): fancy/boolean index, `astype`, `.copy()`, `flatten`.
> `.T` swaps strides (free) but makes array non-contiguous → `ascontiguousarray` before hot loops.
> **C order** = rows contiguous (default, fast axis-1 reduce); **Fortran** = cols contiguous (BLAS/LAPACK).
> Downcast (`float32`, `int32`) to halve RAM — check range first. `as_strided` = powerful + unsafe → use `sliding_window_view`.

**References:** NumPy — "Memory layout of ndarray"; NumPy `stride_tricks` docs; SciPy Lecture Notes — advanced NumPy.

---

*NumPy & Pandas Handbook — topic 02.*
