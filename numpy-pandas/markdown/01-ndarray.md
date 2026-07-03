# 01 · The ndarray: NumPy's Core

> **In one line:** The `ndarray` is a fixed-type, N-dimensional block of contiguous memory plus a small header of metadata (shape, dtype, strides) — that design is why NumPy is fast.

---

## 1. Overview

The **`ndarray`** (N-dimensional array) is the single object everything in NumPy is built on. Every vector, matrix, image, or tensor you manipulate is an `ndarray`. It is a **homogeneous** container: every element shares one **`dtype`** (e.g. `int64`, `float64`), and the elements live in **one contiguous block of memory**.

The problem it solves is Python's slowness for numeric work. A Python `list` is an array of *pointers* to boxed `PyObject`s scattered across the heap — each `int` is a full object with a refcount, type pointer, and value. Looping over a million of those means a million pointer chases and dynamic dispatches. An `ndarray` instead stores the raw values packed end-to-end and describes them with a tiny header, so NumPy can hand a tight loop over that buffer to precompiled C — no per-element Python overhead.

You reach for an `ndarray` whenever you have many numbers of the same kind and want to operate on them **as a whole**: math on entire columns, image pixels, feature matrices, simulation grids. The mental model is the key takeaway: **an ndarray is a raw memory buffer + a header that says how to interpret it.** Two arrays can even share the same buffer and disagree only in their headers — that is exactly what a reshape or a slice is.

## 2. Core Concepts

- **`dtype`** — the fixed element type and its byte width. `int64` = 8 bytes, `float32` = 4 bytes. One dtype for the whole array; NumPy will not mix.
- **`shape`** — a tuple giving the size along each axis. `(3, 4)` is 3 rows × 4 columns. The product of the shape is the element count.
- **`ndim`** — number of axes = `len(shape)`. A vector is 1-D, a matrix 2-D, a batch of images 4-D.
- **`size`** — total number of elements = product of `shape`. Independent of dtype.
- **`itemsize` / `nbytes`** — bytes per element, and total data bytes = `size * itemsize`.
- **Contiguous buffer** — all elements sit in one flat memory block. The N-D structure is an *interpretation*, not a physical nesting.
- **`strides`** — bytes to step in memory to advance one index along each axis. This is how a flat buffer pretends to be N-D.
- **Views vs copies** — a reshape or basic slice returns a **view** (new header, same buffer, zero copy); operations that can't be expressed as a re-strided window copy.
- **Row-major (C) order** — by default the *last* axis varies fastest in memory (`order='C'`); Fortran order (`order='F'`) varies the first axis fastest.

## 3. Syntax & Examples

Create an array and inspect its header:

```python
import numpy as np
a = np.array([[1, 2, 3], [4, 5, 6]])   # 2-D from nested lists
a
# array([[1, 2, 3],
#        [4, 5, 6]])
a.shape, a.ndim, a.size, a.dtype
# ((2, 3), 2, 6, dtype('int64'))
```

Byte accounting — the whole point of a fixed dtype:

```python
a.itemsize, a.nbytes      # bytes per element, total data bytes
# (8, 48)                 # 6 int64 elements * 8 bytes
```

Common constructors (shape first, dtype optional):

```python
np.zeros((2, 3))                 # float64 zeros
np.ones((2, 3), dtype=np.int32)  # int32 ones
np.arange(6)                     # array([0, 1, 2, 3, 4, 5])
np.arange(6).reshape(2, 3)       # same 6 ints, viewed as (2,3)
np.full((2, 2), 7)               # array([[7, 7], [7, 7]])
np.eye(3)                        # 3x3 identity
```

The strides — bytes to jump per axis:

```python
a.strides
# (24, 8)   # +24 bytes to next row (3 int64s), +8 bytes to next column
```

## 4. Worked Example

Prove that an `ndarray` is both **faster** and **smaller** than a `list` for a numeric workload — the two reasons it exists.

```python
import numpy as np, sys, time

n = 1_000_000
py_list = list(range(n))
np_arr  = np.arange(n)                      # dtype int64

# --- speed: sum of squares ---
t0 = time.perf_counter(); s1 = sum(x*x for x in py_list); t1 = time.perf_counter()
s2 = (np_arr * np_arr).sum();                              t2 = time.perf_counter()
print("list    :", round((t1 - t0) * 1e3, 1), "ms")
print("ndarray :", round((t2 - t1) * 1e3, 1), "ms")
print("ndarray bytes:", np_arr.nbytes)
# list    : ~70.0 ms
# ndarray : ~1.5 ms
# ndarray bytes: 8000000
```

Representative comparison on a laptop:

| workload | Python list | NumPy ndarray | ratio |
|---|---|---|---|
| memory (1M int64) | ~36 MB | 8 MB | ~4.5× smaller |
| sum of squares | ~70 ms | ~1.5 ms | ~45× faster |

The list pays for a pointer *plus* a boxed ~28-byte int per element and interprets bytecode in the loop. The ndarray packs 8-byte values back-to-back and runs one C loop — the header stays tiny (~112 bytes) no matter how big the buffer.

## 5. Under the Hood

An `ndarray` is a **header** (a small C struct) pointing at a **data buffer**. The header holds the `dtype`, `shape`, and `strides`; the buffer is `size * itemsize` bytes of packed values. Indexing `a[i, j]` is pure arithmetic: `offset = i*strides[0] + j*strides[1]`, then read `itemsize` bytes at `data + offset`. No search, no pointer chase.

Because the N-D shape is just an interpretation of a flat buffer, many operations only rewrite the header. `a.reshape(3, 2)` keeps the same buffer and changes `shape`/`strides` — that is why it is O(1) and returns a **view**.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">ndarray = header + contiguous buffer</text>

  <rect x="24" y="52" width="200" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="124" y="74" text-anchor="middle" fill="#1e293b" font-weight="700">header</text>
  <text x="124" y="100" text-anchor="middle" fill="#1e293b">dtype = int64</text>
  <text x="124" y="122" text-anchor="middle" fill="#1e293b">shape = (2, 3)</text>
  <text x="124" y="144" text-anchor="middle" fill="#1e293b">strides = (24, 8)</text>
  <text x="124" y="166" text-anchor="middle" fill="#64748b">ndim=2  size=6</text>
  <text x="124" y="188" text-anchor="middle" fill="#64748b">itemsize=8</text>

  <line x1="224" y1="127" x2="286" y2="110" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <text x="255" y="116" text-anchor="middle" fill="#64748b">data*</text>

  <text x="490" y="74" text-anchor="middle" fill="#1e293b" font-weight="700">one flat memory buffer (row-major)</text>
  <g>
    <rect x="292" y="90" width="66" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/>
    <rect x="358" y="90" width="66" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/>
    <rect x="424" y="90" width="66" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/>
    <rect x="490" y="90" width="66" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/>
    <rect x="556" y="90" width="66" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/>
    <rect x="622" y="90" width="66" height="40" rx="6" fill="#ecfdf5" stroke="#059669"/>
    <text x="325" y="115" text-anchor="middle" fill="#1e293b">1</text>
    <text x="391" y="115" text-anchor="middle" fill="#1e293b">2</text>
    <text x="457" y="115" text-anchor="middle" fill="#1e293b">3</text>
    <text x="523" y="115" text-anchor="middle" fill="#1e293b">4</text>
    <text x="589" y="115" text-anchor="middle" fill="#1e293b">5</text>
    <text x="655" y="115" text-anchor="middle" fill="#1e293b">6</text>
  </g>
  <text x="325" y="150" text-anchor="middle" fill="#64748b">byte 0</text>
  <text x="523" y="150" text-anchor="middle" fill="#64748b">byte 24</text>

  <text x="490" y="196" text-anchor="middle" fill="#1e293b" font-weight="700">interpreted as (2,3)</text>
  <g>
    <rect x="360" y="210" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="422" y="210" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="484" y="210" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <text x="390" y="232" text-anchor="middle" fill="#1e293b">1</text>
    <text x="452" y="232" text-anchor="middle" fill="#1e293b">2</text>
    <text x="514" y="232" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="360" y="250" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="422" y="250" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <rect x="484" y="250" width="60" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/>
    <text x="390" y="272" text-anchor="middle" fill="#1e293b">4</text>
    <text x="452" y="272" text-anchor="middle" fill="#1e293b">5</text>
    <text x="514" y="272" text-anchor="middle" fill="#1e293b">6</text>
  </g>
  <text x="352" y="231" text-anchor="end" fill="#64748b">row 0</text>
  <text x="352" y="271" text-anchor="end" fill="#64748b">row 1</text>
  <text x="600" y="269" text-anchor="middle" fill="#64748b">a[i,j] → i·24 + j·8</text>
</svg>
```

## 6. Variations & Trade-offs

| aspect | Python `list` | NumPy `ndarray` |
|---|---|---|
| element type | heterogeneous, boxed objects | one fixed `dtype`, unboxed |
| memory layout | array of pointers to scattered objects | one contiguous packed buffer |
| per-element overhead | ~28 B object + 8 B pointer | just `itemsize` (e.g. 8 B) |
| elementwise math | manual Python loop | vectorized C, no loop |
| resize / append | cheap, amortized O(1) | expensive — reallocates whole buffer |
| ragged / mixed data | natural | not supported (needs `object` dtype = slow) |
| slicing | returns a copy | returns a **view** (zero copy) |

Trade-off: the ndarray wins overwhelmingly on numeric bulk work but is a poor fit for growing collections or genuinely mixed data. Appending in a loop reallocates the entire buffer each time — build a list then `np.array(list)` once, or preallocate with `np.empty` and fill by index.

## 7. Production / Performance Notes

- **Pick the smallest correct dtype.** `float32` halves memory and bandwidth versus `float64`; `int32` vs `int64` likewise. On large arrays, memory bandwidth — not FLOPs — is usually the bottleneck.
- **Preallocate, don't append.** `out = np.empty(n)` then assign; never grow an array in a loop.
- **Prefer views to copies.** Slicing and reshape are free; know when an op copies (`.copy()`, fancy indexing, most reductions produce new arrays).
- **Watch integer overflow.** Fixed-width int dtypes wrap silently: `np.int8(127) + np.int8(1)` → `-128`. Python ints are unbounded; ndarray ints are not.
- **Contiguity matters for speed.** A C-contiguous array iterated along its last axis is cache-friendly; strided/transposed access can be much slower. Check `a.flags['C_CONTIGUOUS']`.
- **`nbytes` is your memory budget.** A `(10000, 10000)` float64 array is 800 MB — know before you allocate.

## 8. Common Mistakes

1. ⚠️ **Assuming a list-of-lists is 2-D automatically.** `np.array([[1,2],[3]])` with unequal rows makes a 1-D `object` array, not a matrix. Fix: ensure equal-length rows, or you lose all vectorization.
2. ⚠️ **Ignoring dtype after division.** `np.array([1,2,3]) / 2` promotes to `float64`; integer arrays don't stay integer under `/`. Use `//` for integer division and be explicit with `astype`.
3. ⚠️ **Silent integer overflow.** Summing many `int32`s or using `int8` counters can wrap. Fix: use `int64`, or `arr.sum(dtype=np.int64)`.
4. ⚠️ **Growing an array with `np.append` in a loop.** Each call copies the whole buffer → O(n²). Fix: collect in a list, convert once, or preallocate.
5. ⚠️ **Mutating a view and surprising yourself.** `b = a[0]; b[:] = 0` also zeros `a`'s first row — slices are views. Fix: `.copy()` when you need independence.
6. ⚠️ **Confusing `size` with `len`.** `len(a)` is only the first-axis length; `a.size` is total elements. For a `(2,3)`, `len`=2 but `size`=6.
7. ⚠️ **Storing Python objects in an array.** `dtype=object` arrays lose every performance benefit — they're just lists with worse ergonomics.

## 9. Interview Questions

**Q: What exactly is an ndarray, structurally?**
A: A small header (dtype, shape, strides, flags, a pointer) plus a separate contiguous data buffer of `size * itemsize` bytes. The N-D shape is an interpretation of the flat buffer computed via strides; the header is tiny and constant-size regardless of how large the buffer is.

**Q: Why is a NumPy array faster than a Python list for numeric work?**
A: Two reasons. Memory: values are unboxed and packed contiguously, so they're cache-friendly and small. Compute: operations run as a single precompiled C loop over the buffer with no per-element Python interpreter overhead or dynamic dispatch. Lists store boxed objects behind pointers and loop in bytecode.

**Q: What are strides and how do they enable N-dimensional indexing on a flat buffer?**
A: `strides` is a tuple of byte-steps per axis. To read `a[i, j]` NumPy computes `offset = i*strides[0] + j*strides[1]` and reads `itemsize` bytes there. So multi-dimensional structure is pure address arithmetic over one contiguous block — no nested containers.

**Q: What's the difference between shape, size, ndim, and len(a)?**
A: `shape` is the per-axis lengths tuple, `ndim` is `len(shape)` (number of axes), `size` is the total element count (product of shape), and `len(a)` is only the length of the first axis. For `(2,3)`: shape=(2,3), ndim=2, size=6, len=2.

**Q: Does reshape copy the data?**
A: Usually no — it returns a view with a new shape/strides header over the same buffer, so it's O(1). It only copies when the requested shape can't be expressed as a re-striding of the existing memory layout (e.g. reshaping a non-contiguous array in certain ways), in which case NumPy silently makes a contiguous copy.

**Q: What does a homogeneous dtype buy you, and what does it cost?**
A: It buys packed memory, predictable strides, and vectorizable C loops. It costs flexibility: you can't mix types (mixed data forces `dtype=object`, which is slow), and fixed-width integers overflow silently instead of promoting like Python ints.

**Q (senior): How would you diagnose why a vectorized operation is slower than expected?**
A: Check contiguity and access pattern — `a.flags` for C/F-contiguity; a transposed or fancy-indexed array may be non-contiguous, defeating the cache. Check dtype (float64 vs float32 doubles bandwidth), whether the op is memory-bound (large arrays usually are), and whether hidden copies/upcasts are happening. Tools: `%timeit`, `np.shares_memory`, and inspecting `.strides`.

**Q (senior): When is a Python list actually the better choice over an ndarray?**
A: When data is genuinely heterogeneous, when the collection grows incrementally (frequent appends — lists are amortized O(1), arrays reallocate), when items are non-numeric objects, or when sizes are tiny and vectorization overhead isn't worth it. ndarrays win on bulk homogeneous numeric work, not general-purpose containers.

**Q (senior): You have a 4-D array of shape (N, C, H, W) that's slow to iterate. What layout considerations matter?**
A: Memory order determines cache behavior. In C-order the last axis (W) is contiguous, so inner loops over W are fast while loops over N stride the farthest. Match your access pattern to the layout, or convert with `np.ascontiguousarray`/`order` to make the hot axis innermost. Non-contiguity from transposes/slices is the usual culprit; `.copy()` to re-pack can pay for itself.

## 10. Practice

- [ ] Create a `(4, 5)` array of the numbers 0–19 with `arange` + `reshape`; print its `shape`, `strides`, and `nbytes`, and explain each stride value.
- [ ] Empirically compare memory of a 1M-element `list` vs `int64` ndarray using `sys.getsizeof` / `.nbytes`, and time a sum-of-squares on each.
- [ ] Make an `int8` array, add 1 to its max value, and observe the overflow; then redo with `int64`.
- [ ] Take a row slice of a 2-D array, mutate it, and show the original changed (view); then repeat with `.copy()` and show it didn't.
- [ ] Build the same `(2,3)` data with `order='C'` and `order='F'`; compare `.strides` and explain the difference.

## 11. Cheat Sheet

> [!TIP]
> **ndarray = raw contiguous buffer + tiny header (dtype, shape, strides).**
> - `a.shape` per-axis lengths · `a.ndim`=len(shape) · `a.size`=product · `a.dtype` fixed type · `a.nbytes`=size×itemsize.
> - Index math: `a[i,j] → i*strides[0] + j*strides[1]` bytes into the buffer.
> - Fast + small because values are **unboxed, packed, and looped in C** — no boxing, no bytecode loop.
> - `reshape`/basic slice = **view** (zero copy); fancy index / most reductions = copy.
> - Pick the smallest correct dtype; preallocate instead of appending; watch silent int overflow.
> - Create: `np.array`, `zeros`, `ones`, `arange`, `full`, `eye`, `empty`.

**References:** NumPy official docs (Array objects; "Internal memory layout of an ndarray"), NumPy "Absolute Beginner's Guide", scipy-lectures.org NumPy chapter

---
*NumPy & Pandas Handbook — topic 01.*
