# 03 · Indexing & Slicing

> **In one line:** Basic slicing carves a **view** — a live window into the same buffer — using per-axis `start:stop:step` plus tricks like `...` and `np.newaxis`.

---

## 1. Overview

Every NumPy array is a small header (shape, dtype, strides) pointing at one flat block of memory. **Basic indexing and slicing** reinterpret that same block without copying it: you get a *view* that shares the buffer with its parent. This is why slicing a million-row array is O(1) and why writing through a slice mutates the original.

You reach for slicing constantly: grabbing a channel from an image, a window from a signal, every other row, the last column. Because a slice is a view, it is both blazing fast and a common source of "why did my original array change?" bugs.

The mental model: an index expression is a list of per-axis selectors separated by commas — `a[rows, cols, ...]`. Each selector is a scalar (drops that axis), a slice `start:stop:step` (keeps a strided range), or a helper like `...` (fill remaining axes) or `np.newaxis` (insert a length-1 axis). Understanding *which operations stay views vs. copy* is the single most useful NumPy skill.

## 2. Core Concepts

- **Basic slicing returns a view.** `a[1:5]`, `a[:, 0]`, `a[::2]` all share memory with `a`. No allocation, no copy.
- **A view is a re-strided header.** Same `data` pointer, different `shape`/`strides`/offset. `b.base is a` confirms it.
- **Multi-axis indexing** uses one selector per axis, comma-separated: `a[i, j]`, `a[1:3, ::2]`. Missing trailing axes are taken whole.
- **Scalar index drops an axis;** slice keeps it. `a[0]` on a 2D array → 1D; `a[0:1]` → still 2D.
- **Steps and negatives.** `a[::2]` every other; `a[::-1]` reverses; `a[-1]` last element; `a[5:1:-1]` counts down.
- **Ellipsis `...`** expands to "as many full slices `:` as needed" to fill unspecified axes — great for high-D arrays: `a[..., 0]`.
- **`np.newaxis` (a.k.a. `None`)** inserts a length-1 axis, reshaping `(n,)` → `(n,1)` for broadcasting.
- **Slices never raise on out-of-range;** they clip. `a[:999]` on length 5 returns length 5. (Scalar indices *do* raise `IndexError`.)
- **Assignment through a slice writes back** to the parent buffer — the defining trait that separates basic indexing from fancy indexing (topic 04, which copies).

## 3. Syntax & Examples

```python
import numpy as np
a = np.arange(10)          # [0 1 2 3 4 5 6 7 8 9]

a[2:7]        # array([2, 3, 4, 5, 6])   start:stop  (stop exclusive)
a[2:7:2]      # array([2, 4, 6])         step 2
a[::-1]       # array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])  reverse
a[-3:]        # array([7, 8, 9])         last three
a[:4] = 0     # writes back → [0 0 0 0 4 5 6 7 8 9]
```

Multi-axis on a 2D grid:

```python
M = np.arange(12).reshape(3, 4)
# [[ 0  1  2  3]
#  [ 4  5  6  7]
#  [ 8  9 10 11]]

M[1, 2]       # 6            scalar, both axes indexed
M[1]          # array([4,5,6,7])   row 1  (trailing axis whole)
M[:, 2]       # array([2,6,10])    column 2  (axis dropped → 1D)
M[0:2, 1:3]   # [[1,2],[5,6]]      sub-block
M[::2, ::-1]  # rows 0,2 with columns reversed
```

Ellipsis and newaxis:

```python
T = np.zeros((2, 3, 4, 5))
T[..., 0].shape     # (2, 3, 4)   ... = :,:,:  ; last axis indexed
T[1, ..., 2].shape  # (3, 4)      fills the middle axes

v = np.array([1, 2, 3])       # shape (3,)
v[:, np.newaxis].shape        # (3, 1)  column vector
v[np.newaxis, :].shape        # (1, 3)  row vector
v[:, None]                    # None is an alias for np.newaxis
```

## 4. Worked Example

Extract the green channel of an RGB image, then flip it horizontally — all as views, zero copies.

```python
import numpy as np

img = np.arange(2*4*3).reshape(2, 4, 3)   # (H=2, W=4, C=3)

green   = img[..., 1]        # (2,4) view: all rows/cols, channel 1
flipped = green[:, ::-1]     # (2,4) view: reverse the width axis

print("green:\n", green)
print("flipped:\n", flipped)
print("shares buffer with img? ", flipped.base is img)

flipped[0, 0] = 999          # write through two chained views...
print("original pixel img[0,3,1] =", img[0, 3, 1])   # ...lands in img
```

```text
green:
 [[ 1  4  7 10]
 [13 16 19 22]]
flipped:
 [[10  7  4  1]
 [22 19 16 13]]
shares buffer with img?  True
original pixel img[0,3,1] = 999
```

The write to `flipped[0,0]` maps back through both views to `img[0, 3, 1]` — proof that the whole chain shares one buffer.

## 5. Under the Hood

A view is just a new **header** (shape + strides + a byte offset into the parent's data) reusing the parent's memory block. `a[2:7]` keeps the same element stride but starts 2 elements in; `a[::2]` doubles the stride; `a[::-1]` uses a *negative* stride. Nothing moves in RAM.

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">a[2:7:2] is a view — same buffer, re-strided header</text>

  <text x="60" y="70" text-anchor="middle" fill="#64748b">buffer (one block of memory)</text>
  <g>
    <rect x="20"  y="84" width="56" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="48"  y="109" text-anchor="middle" fill="#1e293b">0</text>
    <rect x="80"  y="84" width="56" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="108" y="109" text-anchor="middle" fill="#1e293b">1</text>
    <rect x="140" y="84" width="56" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="168" y="109" text-anchor="middle" fill="#1e293b">2</text>
    <rect x="200" y="84" width="56" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="228" y="109" text-anchor="middle" fill="#1e293b">3</text>
    <rect x="260" y="84" width="56" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="288" y="109" text-anchor="middle" fill="#1e293b">4</text>
    <rect x="320" y="84" width="56" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="348" y="109" text-anchor="middle" fill="#1e293b">5</text>
    <rect x="380" y="84" width="56" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="408" y="109" text-anchor="middle" fill="#1e293b">6</text>
    <rect x="440" y="84" width="56" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="468" y="109" text-anchor="middle" fill="#1e293b">7</text>
    <rect x="500" y="84" width="56" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="528" y="109" text-anchor="middle" fill="#1e293b">8</text>
    <rect x="560" y="84" width="56" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="588" y="109" text-anchor="middle" fill="#1e293b">9</text>
  </g>

  <rect x="140" y="180" width="356" height="48" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="318" y="200" text-anchor="middle" fill="#1e293b" font-weight="700">view = [2, 4, 6]</text>
  <text x="318" y="218" text-anchor="middle" fill="#64748b">offset=2 · stride=2 · shape=(3,)</text>

  <line x1="168" y1="180" x2="168" y2="128" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="288" y1="180" x2="288" y2="128" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="408" y1="180" x2="408" y2="128" stroke="#475569" marker-end="url(#ar)"/>
  <text x="560" y="204" text-anchor="middle" fill="#b91c1c">no copy</text>
</svg>
```

Because the view is a window, writing through it edits the original. NumPy tracks this with `view.base`, which points at the object owning the memory. When you need independence, call `.copy()` to allocate a fresh block.

## 6. Variations & Trade-offs

| Expression | Result | View or copy | Notes |
|---|---|---|---|
| `a[2:7]` | strided range | **view** | O(1), shares memory |
| `a[0]` (scalar) | element / sub-array | **view** (sub-array) | drops one axis |
| `a[::-1]` | reversed | **view** | negative stride |
| `a[..., 0]` | last-axis pick | **view** | ellipsis fills axes |
| `a[:, None]` | axis inserted | **view** | length-1 axis |
| `a[[0,2,4]]` | fancy index | **copy** | see topic 04 |
| `a[a > 0]` | boolean mask | **copy** | see topic 04 |
| `a.copy()` | duplicate | **copy** | explicit, safe to mutate |

Basic slicing wins on speed and memory but couples you to the parent. Fancy/boolean indexing decouples (copy) at the cost of an allocation. Choose views for read-heavy pipelines and slice-assignment; choose `.copy()` when you must hand off an independent array.

## 7. Production / Performance Notes

- **Slicing is free; use it in hot loops.** A view creation is a handful of Python-level attribute sets — no data movement even for GB arrays.
- **Beware accidental aliasing.** Returning `big[:1000]` from a function keeps the *entire* `big` alive (the view holds a reference via `.base`). Return `big[:1000].copy()` to release the parent.
- **Non-contiguous views cost later.** `a[::2]` is a valid view but not C-contiguous; downstream ops that need contiguity (`.reshape` sometimes, C extensions) may silently copy. Check `arr.flags['C_CONTIGUOUS']`.
- **`np.newaxis` enables broadcasting without tiling** — `v[:,None] * w[None,:]` builds an outer product with no intermediate copy (topic 04).
- **Prefer slice-assignment `a[mask_slice] = x`** over building new arrays when updating in place; it avoids reallocation.
- **`ravel()` returns a view when possible**, `flatten()` always copies — know which you're paying for (topic 05).

## 8. Common Mistakes

1. ⚠️ **Assuming a slice is a copy.** `b = a[:5]; b[0] = 99` also changes `a[0]`. Fix: `b = a[:5].copy()` when you need independence.
2. ⚠️ **Confusing `a[0]` with `a[0:1]`.** The scalar drops an axis (shape `(4,)`); the slice keeps it (shape `(1,4)`). Match the dimensionality your code expects.
3. ⚠️ **Off-by-one on `stop`.** `stop` is exclusive: `a[2:7]` excludes index 7. Fix: use `a[2:8]` or `a[2:]`.
4. ⚠️ **Backwards ranges with positive step.** `a[7:2]` is empty; a descending range needs a negative step: `a[7:2:-1]`.
5. ⚠️ **Chained indexing on assignment.** `df`/`a[0][1] = x` may write to a temporary; use a single indexer `a[0, 1] = x`.
6. ⚠️ **Memory held hostage by a small view.** A tiny slice of a huge array pins the whole array. Fix: `.copy()` before storing long-term.
7. ⚠️ **Forgetting negative-stride views aren't contiguous**, causing a hidden copy in a later `reshape`.
8. ⚠️ **`np.newaxis` vs `newaxis` typo** — it's `np.newaxis` or `None`, not a bare `newaxis`.

## 9. Interview Questions

**Q: Does basic slicing return a view or a copy, and why does it matter?**
A: A view — it shares the parent's memory buffer via a re-strided header. It matters because writes through the view mutate the original, and because it's O(1) with no allocation.

**Q: How do you tell whether an array is a view of another?**
A: Check `b.base is a` (or `b.base is not None`). The `.base` attribute points to the object that owns the underlying memory.

**Q: What's the difference between `a[0]` and `a[0:1]` on a 2D array?**
A: `a[0]` uses a scalar index, dropping the first axis to return a 1D row. `a[0:1]` uses a slice, keeping the axis to return a 2D array of shape `(1, n)`.

**Q: What does the ellipsis `...` do?**
A: It expands to as many full `:` slices as needed to account for unspecified axes, so `a[..., 0]` grabs index 0 of the last axis regardless of how many leading axes exist.

**Q: What is `np.newaxis` and when do you use it?**
A: It inserts a new length-1 axis (alias `None`). You use it to reshape for broadcasting, e.g., turning `(n,)` into `(n,1)` to combine with a `(1,m)` row vector.

**Q: Why doesn't `a[:999]` raise on a length-5 array, while `a[999]` does?**
A: Slices clip out-of-range bounds silently and return whatever exists; scalar indices must reference a real element, so out-of-range raises `IndexError`.

**Q: How do you reverse an array, and is the result a view?**
A: `a[::-1]` reverses via a negative stride, and yes — it's a view (non-contiguous) sharing the same buffer.

**Q: (Senior) Why can returning a small slice from a function be a memory leak, and how do you fix it?**
A: The returned view holds a reference to the parent through `.base`, keeping the entire large array alive even if you only need a few elements. Return `slice.copy()` to detach and let the parent be garbage-collected.

**Q: (Senior) When does a "view" operation force NumPy to copy anyway?**
A: When you request an operation that needs a memory layout the view can't express — e.g., `reshape` on a non-contiguous slice, or feeding a strided view to a C routine that requires contiguity. NumPy silently makes a contiguous copy.

**Q: (Senior) How do strides implement `a[2:7:2]` without moving data?**
A: The view's header records an offset (start at element 2) and a stride (2 element-widths), so iteration steps through the shared buffer at every other element — pointer arithmetic, no data movement.

## 10. Practice

- [ ] Given a `(6,6)` matrix, extract the central `(2,2)` block as a view and set it to 0 in place.
- [ ] Reverse only the columns of a 2D array using a single slice expression.
- [ ] Use `...` to select index 0 of the last axis of a `(2,3,4,5)` tensor and confirm the shape.
- [ ] Turn a 1D array of length `n` into both a `(n,1)` column and a `(1,n)` row with `np.newaxis`.
- [ ] Write a function that returns the first 100 rows of a large array *without* pinning the parent in memory; verify with `.base`.

## 11. Cheat Sheet

> [!TIP]
> **Indexing & Slicing** — one selector per axis: `a[rows, cols, ...]`.
> Basic slicing = **VIEW** (shares memory, O(1), writes back). Fancy/boolean = **COPY**.
> `start:stop:step` — stop exclusive, negative step reverses, slices clip (no error).
> Scalar index **drops** an axis; slice **keeps** it. `a[0]`→1D, `a[0:1]`→2D.
> `...` = fill remaining axes with `:`. `np.newaxis`/`None` = insert length-1 axis.
> Check sharing with `b.base is a`; detach with `.copy()`. Reverse: `a[::-1]`.

**References:** NumPy User Guide — Indexing on ndarrays; NumPy Reference — Basic indexing; SciPy Lecture Notes — NumPy

---

*NumPy & Pandas Handbook — topic 03.*
