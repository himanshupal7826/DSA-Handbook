# 07 · Broadcasting Rules

> **In one line:** NumPy stretches mismatched array shapes along size-1 dimensions so you can combine them element-wise — with zero copies.

---

## 1. Overview

**Broadcasting** is the set of rules NumPy uses to make arrays of *different shapes* work together in element-wise operations. Add a `(3,)` vector to a `(3,3)` matrix, subtract a per-column mean from a whole dataset, build a multiplication table from two 1-D vectors — all without writing a loop or manually tiling data.

The problem it solves is twofold: **ergonomics** and **memory**. Without broadcasting you'd have to explicitly replicate the smaller array to match the larger one (`np.tile`) before operating — verbose and wasteful. Broadcasting instead *virtually* stretches the smaller array by reusing its existing elements with a stride of 0, so the operation runs as if the array were replicated **but no replicated array is ever materialized**.

You reach for broadcasting constantly: centering/standardizing data, applying per-row or per-column scale factors, computing outer products and pairwise distances, and expanding a scalar or 1-D lookup across a grid. Understanding its rules is what separates "why did this throw a shape error?" from writing clean, fast array code.

The whole system reduces to one alignment rule plus one stretching rule — memorize those two and every case follows.

## 2. Core Concepts

- **Trailing-dimension alignment** — shapes are compared **right to left**. NumPy lines up the last dims, then the second-to-last, and so on.
- **The compatibility rule** — for each aligned dimension, they are compatible iff they are **equal**, or **one of them is 1**. Otherwise → `ValueError`.
- **Size-1 stretch** — a dimension of size 1 is virtually repeated to match the other operand's size in that dimension. This is broadcasting's core move.
- **Missing dimensions are prepended as 1** — a lower-rank array is left-padded with 1s until the ranks match (a `(3,)` acts like `(1,3)` against a 2-D array).
- **`np.newaxis` / `None`** — inserts a size-1 axis to *control* how an array aligns; turns a `(n,)` into a column `(n,1)` or row `(1,n)`.
- **Outer operations** — `a[:,None] op b[None,:]` broadcasts a `(m,1)` against a `(1,n)` to produce a full `(m,n)` grid (outer sum/product/comparison).
- **No copy, stride-0** — the stretched axis has stride 0; the same memory is read repeatedly. Broadcasting allocates only the **result**, not the expanded inputs.
- **Result shape** — the elementwise-max of the aligned dimensions. Handy predictor: `np.broadcast_shapes(s1, s2)`.

## 3. Syntax & Examples

Scalar against array (the simplest broadcast):

```python
import numpy as np
a = np.array([[1, 2, 3], [4, 5, 6]])   # (2,3)
a * 10                                  # scalar stretches over everything
```

Row vector across every row — trailing dims align `(2,3)` vs `(3,)`:

```python
a = np.arange(6).reshape(2, 3)   # (2,3)
row = np.array([100, 200, 300])  # (3,) -> treated as (1,3)
a + row
# array([[100, 201, 302],
#        [103, 204, 305]])
```

Column vector needs an explicit new axis — `(2,3)` vs `(2,1)`:

```python
col = np.array([10, 20])          # (2,)
a + col[:, np.newaxis]            # (2,1) stretches across 3 columns
# array([[10, 11, 12],
#        [23, 24, 25]])
```

Outer product / grid from two 1-D vectors — `(3,1)` × `(1,4)` → `(3,4)`:

```python
r = np.array([1, 2, 3])
c = np.array([10, 20, 30, 40])
r[:, None] * c[None, :]           # multiplication table, shape (3,4)
```

## 4. Worked Example

**Task:** standardize a feature matrix column-wise (subtract each column's mean, divide by its std) — the canonical broadcasting workflow — and confirm no copies of the stats were made.

```python
import numpy as np

X = np.array([[  5.,  100.,  2.],
              [ 15.,  300.,  4.],
              [ 25.,  500.,  6.],
              [ 35.,  700.,  8.]])          # (4, 3)

mu    = X.mean(axis=0)      # (3,)  per-column mean  -> acts as (1,3)
sigma = X.std(axis=0)       # (3,)  per-column std

Xz = (X - mu) / sigma       # (4,3) - (3,) / (3,)  -> broadcasts down the rows

print("shapes:", X.shape, mu.shape, "->", Xz.shape)
print("col means ~0:", np.round(Xz.mean(axis=0), 6))
print("col stds  ~1:", np.round(Xz.std(axis=0), 6))
```

Output:

```text
shapes: (4, 3) (3,) -> (4, 3)
col means ~0: [ 0. -0.  0.]
col stds  ~1: [1. 1. 1.]
```

`mu` and `sigma` are shape `(3,)`; NumPy left-pads them to `(1,3)` and stretches the size-1 row dimension across all 4 rows. No `(4,3)` copy of the means is built — the subtraction reads the same 3 values four times via stride 0. That's the entire idiom behind z-scoring, min-max scaling, and per-channel image normalization.

## 5. Under the Hood

Alignment is purely about shapes, right-to-left. Consider `(3,1) + (1,4)`. Trailing dims: `1` vs `4` → one is 1, stretch to 4. Next: `3` vs `1` → one is 1, stretch to 3. Result `(3,4)`. Each operand is virtually expanded along its size-1 axis by setting that axis's **stride to 0**, so it re-reads the same element instead of moving through memory.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <!-- A: (3,1) -->
  <text x="90" y="30" text-anchor="middle" fill="#2563eb" font-weight="bold">A: shape (3,1)</text>
  <rect x="60" y="45" width="40" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="70" text-anchor="middle" fill="#1e293b">1</text>
  <rect x="60" y="90" width="40" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="115" text-anchor="middle" fill="#1e293b">2</text>
  <rect x="60" y="135" width="40" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="80" y="160" text-anchor="middle" fill="#1e293b">3</text>
  <text x="80" y="200" text-anchor="middle" fill="#64748b">stretch → 4 cols</text>

  <text x="160" y="115" text-anchor="middle" fill="#475569" font-size="20">+</text>

  <!-- B: (1,4) -->
  <text x="290" y="30" text-anchor="middle" fill="#059669" font-weight="bold">B: shape (1,4)</text>
  <rect x="200" y="45" width="40" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="220" y="70" text-anchor="middle" fill="#1e293b">10</text>
  <rect x="245" y="45" width="40" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="265" y="70" text-anchor="middle" fill="#1e293b">20</text>
  <rect x="290" y="45" width="40" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="310" y="70" text-anchor="middle" fill="#1e293b">30</text>
  <rect x="335" y="45" width="40" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="355" y="70" text-anchor="middle" fill="#1e293b">40</text>
  <text x="290" y="115" text-anchor="middle" fill="#64748b">stretch ↓ 3 rows</text>

  <line x1="400" y1="115" x2="450" y2="115" stroke="#475569" stroke-width="2" marker-end="url(#ar2)"/>

  <!-- Result (3,4) -->
  <text x="590" y="30" text-anchor="middle" fill="#1e293b" font-weight="bold">Result: (3,4)</text>
  <g fill="#1e293b">
  <rect x="480" y="45" width="52" height="34" rx="6" fill="#f8fafc" stroke="#475569"/><text x="506" y="67" text-anchor="middle">11</text>
  <rect x="534" y="45" width="52" height="34" rx="6" fill="#f8fafc" stroke="#475569"/><text x="560" y="67" text-anchor="middle">21</text>
  <rect x="588" y="45" width="52" height="34" rx="6" fill="#f8fafc" stroke="#475569"/><text x="614" y="67" text-anchor="middle">31</text>
  <rect x="642" y="45" width="52" height="34" rx="6" fill="#f8fafc" stroke="#475569"/><text x="668" y="67" text-anchor="middle">41</text>
  <rect x="480" y="83" width="52" height="34" rx="6" fill="#f8fafc" stroke="#475569"/><text x="506" y="105" text-anchor="middle">12</text>
  <rect x="534" y="83" width="52" height="34" rx="6" fill="#f8fafc" stroke="#475569"/><text x="560" y="105" text-anchor="middle">22</text>
  <rect x="588" y="83" width="52" height="34" rx="6" fill="#f8fafc" stroke="#475569"/><text x="614" y="105" text-anchor="middle">32</text>
  <rect x="642" y="83" width="52" height="34" rx="6" fill="#f8fafc" stroke="#475569"/><text x="668" y="105" text-anchor="middle">42</text>
  <rect x="480" y="121" width="52" height="34" rx="6" fill="#f8fafc" stroke="#475569"/><text x="506" y="143" text-anchor="middle">13</text>
  <rect x="534" y="121" width="52" height="34" rx="6" fill="#f8fafc" stroke="#475569"/><text x="560" y="143" text-anchor="middle">23</text>
  <rect x="588" y="121" width="52" height="34" rx="6" fill="#f8fafc" stroke="#475569"/><text x="614" y="143" text-anchor="middle">33</text>
  <rect x="642" y="121" width="52" height="34" rx="6" fill="#f8fafc" stroke="#475569"/><text x="668" y="143" text-anchor="middle">43</text>
  </g>

  <!-- Alignment rule box -->
  <rect x="60" y="230" width="634" height="90" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="377" y="255" text-anchor="middle" fill="#1e293b" font-weight="bold">Align right→left; per dim: equal OR one is 1 → compatible</text>
  <text x="377" y="282" text-anchor="middle" fill="#1e293b" font-family="ui-monospace,monospace">(3, 1)   vs   (1, 4)   →   (3, 4)</text>
  <text x="377" y="305" text-anchor="middle" fill="#b91c1c" font-family="ui-monospace,monospace">(3,)  vs  (4,)  →  ValueError  (3 ≠ 4, neither is 1)</text>
</svg>
```

Because the stretched axis has stride 0, broadcasting is **free in memory** — only the result array is allocated. You can inspect the virtual expansion with `np.broadcast_to(a, shape)` (returns a read-only, zero-copy view) or predict the result with `np.broadcast_shapes((3,1),(1,4))`.

## 6. Variations & Trade-offs

| Technique | Shapes | Result | Notes |
|---|---|---|---|
| Scalar op | `()` vs `(m,n)` | `(m,n)` | trivial broadcast |
| Row vector | `(n,)` vs `(m,n)` | `(m,n)` | auto left-pad to `(1,n)` |
| Column vector | `(m,1)` vs `(m,n)` | `(m,n)` | needs `[:,None]` |
| Outer op | `(m,1)` vs `(1,n)` | `(m,n)` | grid / table / pairwise |
| `broadcast_to` | any | view | explicit, read-only, zero-copy |
| `np.tile` / `repeat` | any | copy | real replication; use only if you need writable/materialized data |

Broadcasting vs explicit tiling is the key trade-off. Broadcasting is zero-copy and fast, but the *result* of an outer op can be enormous: `a[:,None] - b[None,:]` for two length-10⁴ vectors is a 10⁸-element `(10⁴,10⁴)` array — ~800 MB in `float64`. So broadcasting saves memory on the *inputs* but the *materialized result* can blow up. When that grid is the bottleneck, chunk it, use `scipy.spatial.distance.cdist`, or a memory-aware library. Use `np.tile` only when you genuinely need a writable, physically replicated array.

## 7. Production / Performance Notes

- **Broadcasting is zero-copy on inputs, so it's the memory-efficient default** — prefer `X - mu` over `X - np.tile(mu, (n,1))`.
- **The output can still explode.** Outer/pairwise ops produce `m×n` results; estimate `m*n*itemsize` before running. Chunk or use specialized routines (`cdist`, `einsum`) for large grids.
- **`einsum` and matmul** often express what you'd reach broadcasting for (weighted sums, batched products) with less temporary memory — worth knowing.
- **Control alignment explicitly with `None`/`newaxis`** rather than relying on auto-padding; it makes row-vs-column intent obvious and prevents subtle mis-broadcasts.
- **Guard your shapes.** `np.broadcast_shapes(...)` in a test, or `assert a.shape == (n,1)`, catches the classic bug where a `(n,)` broadcast as a row when you meant a column.
- **Dtype still applies.** Broadcasting doesn't change types; a `(m,1)` int minus `(1,n)` float still upcasts the whole result to float.

## 8. Common Mistakes

1. ⚠️ **`(n,)` broadcasts as a row, not a column.** `X - X.mean(axis=1)` fails or misaligns. *Fix:* `X - X.mean(axis=1, keepdims=True)` or `[:,None]`.
2. ⚠️ **Assuming equal-length vectors combine element-wise in 2-D.** `(3,) + (4,)` → `ValueError`. *Fix:* decide intent; for a grid use `a[:,None]` and `b[None,:]`.
3. ⚠️ **Silent giant temporaries** from outer ops on large vectors. *Fix:* compute `m*n*8` bytes first; chunk or use `cdist`/`einsum`.
4. ⚠️ **Writing to a `broadcast_to` view.** It's read-only (multiple logical elements share memory). *Fix:* `.copy()` if you need to mutate.
5. ⚠️ **Forgetting to reduce with `keepdims`,** breaking the next broadcast step. *Fix:* pass `keepdims=True` when the stat feeds back into a broadcast.
6. ⚠️ **Relying on left-padding when you meant the other axis.** *Fix:* insert `newaxis` explicitly so alignment is unambiguous.
7. ⚠️ **Expecting broadcasting to transpose.** It only stretches size-1 dims; it never reorders axes. *Fix:* transpose or reshape yourself first.

## 9. Interview Questions

**Q: State NumPy's broadcasting rules.**
A: Compare shapes right-to-left (trailing dims first). Missing leading dims are treated as 1. Two aligned dimensions are compatible if they're equal or one of them is 1; a size-1 dim is stretched to match the other. If any aligned pair is neither equal nor has a 1, it raises `ValueError`. The result shape is the elementwise max of the aligned dims.

**Q: Why is broadcasting memory-efficient?**
A: The stretched dimension is given a stride of 0, so the same element is re-read rather than copied. Only the result array is allocated; the "expanded" inputs are never materialized. `np.broadcast_to` demonstrates this — it returns a zero-copy read-only view.

**Q: `a` is `(3,)` and `b` is `(4,)`. What does `a + b` do, and how do you make a 3×4 grid?**
A: `a + b` raises `ValueError` because trailing dims 3 and 4 are unequal and neither is 1. For a grid, add axes: `a[:, None] + b[None, :]` broadcasts `(3,1)` with `(1,4)` → `(3,4)`.

**Q: What does `np.newaxis` do and when do you need it?**
A: It inserts a new length-1 axis, letting you control alignment. You need it to make a 1-D array behave as a *column* (`v[:, None]` → `(n,1)`) since auto-padding only ever makes it a row, and to set up outer operations.

**Q: How do you subtract each row's mean from a 2-D array? (careful one)**
A: `X - X.mean(axis=1, keepdims=True)`. The row means are `(m,)`; without `keepdims` they'd broadcast as a row `(1,m)` and either error or subtract wrongly. `keepdims=True` gives `(m,1)`, which correctly stretches across columns.

**Q: When does broadcasting hurt performance despite being zero-copy? (senior)**
A: When the *result* is huge. Pairwise/outer ops turn two length-n vectors into an n×n array; at n=10⁴ that's 10⁸ elements (~800 MB float64). Inputs stay small but the materialized output dominates memory/time. Mitigate with chunking, `scipy` `cdist`, or `einsum`.

**Q: Contrast broadcasting with `np.tile`. (senior)**
A: Broadcasting virtually stretches size-1 dims via stride 0 — no copy, read-only expansion, only the result is allocated. `np.tile` physically replicates data into a new writable array, using real memory. Use broadcasting by default; use `tile` only when you need a materialized, mutable replicate.

**Q: How can you inspect or predict a broadcast result without running the full op? (senior)**
A: `np.broadcast_shapes(s1, s2, ...)` returns the result shape (or raises if incompatible). `np.broadcast_to(a, shape)` returns the zero-copy expanded view so you can see the virtual layout, and `np.broadcast_arrays(a, b)` returns both expanded views.

**Q: Does broadcasting ever change dtype or order of axes?**
A: It changes neither the order of axes nor performs a transpose — it only stretches size-1 dimensions. Dtype follows normal type-promotion rules of the operation (e.g. int + float → float); broadcasting itself doesn't cast, the operation does.

**Q: What's the outer-product idiom and one real use?**
A: `a[:, None] * b[None, :]` yields the full `(len(a), len(b))` product grid. Real uses: multiplication tables, pairwise distance/similarity matrices (`(a[:,None]-b[None,:])**2`), and building 2-D coordinate grids for evaluating functions over a mesh.

## 10. Practice

- [ ] Center a `(100, 5)` matrix by subtracting its per-column mean using broadcasting; verify column means are ~0.
- [ ] Build a 10×10 multiplication table with `np.arange` and `newaxis`, no loops.
- [ ] Trigger a broadcasting `ValueError` on purpose, then fix it two ways: reshape and `newaxis`.
- [ ] Compute the full pairwise Euclidean distance matrix between two `(N,2)` point sets via broadcasting; then estimate its memory for N=20000.
- [ ] Use `np.broadcast_to` to expand a `(3,1)` array to `(3,4)`, confirm it's a view, and observe that writing to it fails.

## 11. Cheat Sheet

> [!TIP]
> **Broadcasting = stretch size-1 dims to match, zero-copy.**
> - Rule: align shapes **right→left**; each dim must be **equal or one is 1**; size-1 stretches. Else `ValueError`.
> - Missing leading dims → treated as 1, so `(n,)` acts like a **row** `(1,n)`.
> - Column: `v[:, None]` → `(n,1)`. Row: `v[None, :]` → `(1,n)`. Grid/outer: `a[:,None] op b[None,:]`.
> - Zero-copy on inputs (stride 0); only the **result** is allocated — but outer ops can make it huge (`m*n*8` bytes).
> - Row-wise reduce feeding a broadcast → use `keepdims=True`.
> - Predict/inspect: `np.broadcast_shapes`, `np.broadcast_to` (read-only view). Materialize only with `np.tile`.

**References:** NumPy user guide "Broadcasting", NumPy API `broadcast_to`/`broadcast_shapes`, "From Python to NumPy" (Rougier), SciPy Lecture Notes on array operations

---
*NumPy & Pandas Handbook — topic 07.*
