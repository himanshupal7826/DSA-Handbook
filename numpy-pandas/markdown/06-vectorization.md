# 06 · Vectorization: Ditch the Loop

> **In one line:** Push element-wise work down into compiled C so one array expression replaces a million-iteration Python loop.

---

## 1. Overview

**Vectorization** means expressing a computation as operations over *whole arrays* instead of iterating element-by-element in Python. `a + b`, `np.sqrt(x)`, `arr.sum(axis=0)` — each is a single call that loops internally in optimized C, not in the interpreter.

The problem it solves is the **Python interpreter tax**. A pure-Python `for` loop does an enormous amount of hidden work per element: box/unbox `PyObject`s, refcount bookkeeping, type dispatch, bytecode evaluation. For a numeric kernel that work dwarfs the actual arithmetic. Vectorization deletes that tax by handing the entire loop to NumPy's C core, which runs one tight machine loop over a contiguous buffer of raw `float64`/`int64` values.

You reach for vectorization **any time you find yourself writing a loop over the elements of an array** — arithmetic, filtering, conditional assignment, cumulative math, distance/similarity computations, feature engineering over columns. It is the single biggest performance lever in the NumPy/pandas stack, routinely 10–200× faster, and it usually makes the code *shorter and clearer* too.

The rule of thumb: **if the loop body only touches array elements and simple math, it should not be a Python loop.**

## 2. Core Concepts

- **ufunc (universal function)** — a C-compiled function (`np.add`, `np.exp`, `np.maximum`) that applies element-wise over arrays, with broadcasting and an optional `out=` buffer. Operators `+ - * / ** > ==` dispatch to ufuncs.
- **The C loop** — NumPy iterates the buffer in compiled code: no per-element `PyObject`, no refcounting, no bytecode. That is where the 100× comes from.
- **Contiguous memory** — a NumPy array is one flat, typed block. The CPU streams it predictably, so the **prefetcher and cache** stay fed; a Python list is scattered pointers to boxed objects, murdering cache locality.
- **SIMD** — on contiguous data the compiler/CPU applies one instruction to multiple lanes (AVX2 = 4× `float64` per instruction). Only possible because the data is packed and typed.
- **Reductions** — `sum`, `mean`, `max`, `dot` collapse an axis in C; never accumulate in a Python loop.
- **Masks over branches** — replace `if` inside a loop with a **boolean array** plus `np.where` / fancy indexing.
- **Temporaries** — long expressions allocate intermediate arrays. Fast, but memory-heavy; `out=` and in-place `+=` avoid the copy.
- **`np.vectorize` is not vectorized** — it is a convenience wrapper around a Python loop. It gives you broadcasting semantics, **not** C speed.

## 3. Syntax & Examples

Start simple — element-wise math with no loop:

```python
import numpy as np

x = np.arange(1_000_000, dtype=np.float64)
y = x * 2.0 + 1.0          # whole-array arithmetic, one C pass
z = np.sqrt(x) + np.log1p(x)
```

Replace a filtering loop with a **boolean mask**:

```python
a = np.array([3, -1, 4, -1, 5, -9])
positives = a[a > 0]                 # -> array([3, 4, 5])
a[a < 0] = 0                         # conditional assignment, no loop
```

Replace an `if/else` loop body with `np.where`:

```python
score = np.array([0.2, 0.9, 0.5, 0.7])
label = np.where(score >= 0.5, 1, 0)  # -> array([0, 1, 1, 1])
```

Reductions collapse loops-that-accumulate:

```python
m = np.random.rand(1000, 50)
col_means = m.mean(axis=0)     # 50 means, no loop
row_norms = np.sqrt((m ** 2).sum(axis=1))  # 1000 norms
```

## 4. Worked Example

**Task:** normalize a signal to z-scores and count values beyond 2σ — first the loop way, then vectorized — and time both.

```python
import numpy as np, time

rng = np.random.default_rng(0)
data = rng.normal(size=2_000_000)

# --- Python loop version ---
t0 = time.perf_counter()
mean = sum(data) / len(data)
var  = sum((v - mean) ** 2 for v in data) / len(data)
std  = var ** 0.5
count = 0
for v in data:
    if abs((v - mean) / std) > 2:
        count += 1
loop_t = time.perf_counter() - t0

# --- Vectorized version ---
t0 = time.perf_counter()
z = (data - data.mean()) / data.std()
count_v = int((np.abs(z) > 2).sum())
vec_t = time.perf_counter() - t0

print(f"loop : {count}  in {loop_t*1000:8.1f} ms")
print(f"vec  : {count_v}  in {vec_t*1000:8.1f} ms")
print(f"speedup: {loop_t/vec_t:6.0f}x")
```

Representative output on a laptop:

```text
loop : 90758  in   1523.4 ms
vec  : 90758  in      9.7 ms
speedup:    157x
```

Same answer, ~157× faster, and the vectorized core is three lines. The loop version also allocated a generator and millions of Python floats; the vectorized version streamed one contiguous buffer.

## 5. Under the Hood

Why is the C loop so much faster? Compare what happens **per element**.

In Python, `total += data[i]` triggers: index bounds check, create a boxed `PyFloat`, look up `__add__`, allocate a new `PyFloat` result, adjust three refcounts, store back. Dozens of instructions and a heap allocation for one add.

In the NumPy C loop, the same add is: load 8 bytes from a contiguous buffer, `addsd` (or a single AVX instruction across 4 lanes), store 8 bytes. No boxing, no refcount, no dispatch — and the data is packed so the cache prefetcher stays ahead.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="180" y="24" text-anchor="middle" fill="#b91c1c" font-weight="bold">Python loop — per element</text>
  <rect x="40" y="40" width="280" height="210" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="66" text-anchor="middle" fill="#1e293b">unbox PyObject</text>
  <text x="180" y="90" text-anchor="middle" fill="#1e293b">type dispatch (__add__)</text>
  <text x="180" y="114" text-anchor="middle" fill="#1e293b">refcount ++ / --</text>
  <text x="180" y="138" text-anchor="middle" fill="#1e293b">heap-allocate result</text>
  <text x="180" y="162" text-anchor="middle" fill="#1e293b">bytecode eval overhead</text>
  <text x="180" y="188" text-anchor="middle" fill="#64748b">scattered pointers →</text>
  <text x="180" y="206" text-anchor="middle" fill="#64748b">cache misses</text>
  <text x="180" y="236" text-anchor="middle" fill="#b91c1c" font-weight="bold">~30+ instr / element</text>

  <text x="540" y="24" text-anchor="middle" fill="#059669" font-weight="bold">NumPy C loop — per element</text>
  <rect x="400" y="40" width="280" height="210" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="540" y="72" text-anchor="middle" fill="#1e293b">load 8 bytes (contiguous)</text>
  <text x="540" y="100" text-anchor="middle" fill="#1e293b">addsd / AVX (4 lanes)</text>
  <text x="540" y="128" text-anchor="middle" fill="#1e293b">store 8 bytes</text>
  <rect x="430" y="150" width="220" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="540" y="171" text-anchor="middle" fill="#1e293b">SIMD + prefetch + cache hits</text>
  <text x="540" y="236" text-anchor="middle" fill="#059669" font-weight="bold">~1 instr / 4 elements</text>

  <line x1="322" y1="145" x2="398" y2="145" stroke="#475569" stroke-width="2" marker-end="url(#ar)"/>
  <text x="360" y="135" text-anchor="middle" fill="#64748b">vectorize</text>
</svg>
```

The three multipliers — **eliminated interpreter overhead**, **cache-friendly contiguous access**, and **SIMD parallelism** — compound. Interpreter elimination alone is ~10–30×; contiguity and SIMD add the rest.

## 6. Variations & Trade-offs

| Approach | Speed | Memory | Readability | When |
|---|---|---|---|---|
| Python `for` loop | 1× (baseline) | low | ok | prototyping, non-array logic |
| List comprehension | ~1.5–2× | low | good | still Python-level; small data |
| `np.vectorize(f)` | ~1× | low | good | broadcasting a scalar Python fn; **not** for speed |
| Vectorized ufunc expr | 50–200× | temporaries | best | the default for numeric work |
| In-place / `out=` | 50–200× | minimal | good | large arrays, memory-bound |
| Numba `@njit` loop | 50–300× | low | ok | irregular logic that won't vectorize cleanly |

Vectorization's main cost is **memory**: `a*b + c*d` materializes intermediate arrays. For huge arrays that pressure can dominate — chunk the work, use `out=`, or drop to Numba where a fused scalar loop avoids temporaries entirely. And some algorithms (recurrences where element *n* depends on *n−1*, like an IIR filter) genuinely can't vectorize — reach for `np.cumsum`-style prefix ops, `scipy` primitives, or Numba.

## 7. Production / Performance Notes

- **Profile first.** Vectorize the hot loop, not everything. `%timeit`, `cProfile`, `line_profiler` find it.
- **Watch temporaries on big arrays.** `x = a + b + c` allocates twice. Use `np.add(a, b, out=x); x += c` or `numexpr` to fuse and cap memory.
- **Keep dtypes tight.** `float32` halves bandwidth vs `float64` and often doubles SIMD throughput; use it when precision allows. Avoid accidental `object` dtype — it silently reverts you to Python-speed per element.
- **Contiguity matters.** Operating along the non-contiguous axis (e.g. `axis=0` reductions on a C-order array) is slower; `np.ascontiguousarray` or transposing the layout can help the cache.
- **pandas mirrors this.** `df["a"] * df["b"]` is vectorized; `df.apply(fn, axis=1)` and `df.iterrows()` are Python loops — avoid them on hot paths.
- **`np.vectorize` / `apply` are ergonomics, not speed.** Reserve them for genuinely scalar Python logic on small inputs.

## 8. Common Mistakes

1. ⚠️ **Looping over array elements in Python.** *Fix:* express it as whole-array arithmetic, masks, or reductions.
2. ⚠️ **Believing `np.vectorize` is fast.** It wraps a Python loop. *Fix:* use real ufuncs; use Numba if the logic won't vectorize.
3. ⚠️ **`df.iterrows()` / `apply(axis=1)` on hot paths.** *Fix:* operate on whole columns; use `np.where`/`np.select` for conditionals.
4. ⚠️ **Accidental `object` dtype** (from mixed types or Python ints). *Fix:* check `arr.dtype`; cast to a numeric dtype so the C loop and SIMD engage.
5. ⚠️ **Building giant temporaries** in one long expression and OOM-ing. *Fix:* chunk, use `out=`/in-place, or `numexpr`.
6. ⚠️ **Wrong `axis`** in a reduction, silently collapsing the wrong dimension. *Fix:* state the axis explicitly and check the result shape.
7. ⚠️ **Growing an array in a loop** with `np.append` (reallocates each time). *Fix:* preallocate with `np.empty` or build once with `np.concatenate`.

## 9. Interview Questions

**Q: What is vectorization and why is it faster than a Python loop?**
A: It expresses element-wise work as whole-array operations executed by compiled C ufuncs. It removes the per-element interpreter tax (boxing, refcounting, type dispatch, bytecode), streams contiguous typed memory so the CPU cache and prefetcher stay fed, and enables SIMD. Those effects compound to 10–200×.

**Q: Name the three distinct reasons vectorized code beats an interpreted loop.**
A: (1) No interpreter overhead — one C loop instead of millions of bytecode iterations; (2) contiguous, typed memory gives cache locality; (3) SIMD applies one instruction across multiple lanes. Interpreter elimination is the biggest single factor.

**Q: Is `np.vectorize` actually vectorized?**
A: No. It is a convenience wrapper that calls a Python function element-by-element with broadcasting semantics. You get cleaner code, not C speed. For speed use built-in ufuncs or Numba.

**Q: How do you vectorize a loop that has an `if/else` in its body?**
A: Convert the condition to a boolean mask and use `np.where(cond, a, b)` for two branches, or `np.select([...], [...])` for many. Boolean masks also do conditional assignment: `x[x < 0] = 0`.

**Q: What is a ufunc?**
A: A universal function — a C-compiled, element-wise operation (e.g. `np.add`, `np.exp`, `np.maximum`) that supports broadcasting, type casting, an `out=` buffer, and reduction methods like `.reduce`/`.accumulate`. Arithmetic and comparison operators dispatch to ufuncs.

**Q: Vectorized code is fast but my process OOMs — why, and what do you do? (senior)**
A: Long expressions allocate intermediate temporary arrays; several large temporaries can exceed RAM. Fixes: use `out=` and in-place ops to reuse buffers, process in chunks, use `numexpr` to fuse the expression without materializing intermediates, or use a smaller dtype like `float32`.

**Q: When can a computation NOT be vectorized, and what are the options? (senior)**
A: When there's a genuine sequential dependency — element *n* depends on the already-computed element *n−1* (IIR filters, path-dependent simulations). Options: reformulate via prefix operations (`cumsum`, `cumprod`, `np.frompyfunc`-based scans), use a library primitive (`scipy.signal.lfilter`), or JIT the scalar loop with Numba/Cython.

**Q: Why does contiguous memory layout matter for vectorized performance? (senior)**
A: A NumPy array is a single flat typed buffer, so sequential access is cache-friendly and predictable — the hardware prefetcher stays ahead and SIMD can load packed lanes. Python lists are arrays of pointers to scattered boxed objects, causing cache misses and blocking SIMD. Even within NumPy, iterating the non-contiguous axis hurts; `ascontiguousarray` or a transpose can fix it.

**Q: How do you decide whether to vectorize with NumPy or reach for Numba?**
A: Prefer NumPy vectorization when the logic maps to array ops (arithmetic, masks, reductions) — it's simplest and fast. Reach for Numba when the logic is irregular/branchy or has sequential dependencies that force huge temporaries or awkward tricks in pure NumPy; Numba JIT-compiles the readable scalar loop to near-C speed without materializing intermediates.

**Q: pandas equivalents — which operations are vectorized and which aren't?**
A: Column arithmetic (`df.a * df.b`), `.str` accessors (mostly), comparisons, `np.where`, and groupby aggregations are vectorized. `df.iterrows()`, `df.itertuples()`, and `df.apply(fn, axis=1)` run a Python loop and are slow on large frames — replace them with column ops or `np.select`.

## 10. Practice

- [ ] Rewrite a running-sum `for` loop as `np.cumsum` and confirm identical output.
- [ ] Replace an `if x>0: y=1 else y=-1` loop with `np.where` (or `np.sign`) and `%timeit` both.
- [ ] Compute pairwise Euclidean distances between two `(N,2)` arrays with no Python loop, using broadcasting + `sum(axis=...)`.
- [ ] Take a `df.apply(axis=1)` from a notebook and rewrite it as column-wise vectorized ops; measure the speedup.
- [ ] Force an `object`-dtype array, time an operation, cast to `float64`, and re-time to see the interpreter penalty.

## 11. Cheat Sheet

> [!TIP]
> **Vectorization = hand the loop to C.** If a loop body only does element math, don't write it in Python.
> - Arithmetic: `a*2+1`, `np.sqrt(x)`, `np.exp(x)` — whole-array ufuncs.
> - Filter/assign: `a[a>0]`, `a[a<0]=0` — boolean masks.
> - Branches: `np.where(cond, x, y)`, `np.select`.
> - Accumulate: `sum/mean/max(axis=…)`, `cumsum`.
> - Speed sources: no interpreter tax · contiguous cache-friendly memory · SIMD.
> - Traps: `np.vectorize`/`apply`/`iterrows` are Python loops; `object` dtype kills speed; long exprs allocate temporaries (use `out=`).
> - Won't vectorize? Sequential recurrence → Numba / scipy / prefix ops.

**References:** NumPy user guide (Universal functions, Broadcasting), "From Python to NumPy" (Rougier), pandas "Enhancing performance", Numba documentation

---
*NumPy & Pandas Handbook — topic 06.*
