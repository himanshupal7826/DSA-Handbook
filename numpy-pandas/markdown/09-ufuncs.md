# 09 · Universal Functions (ufuncs)

> **In one line:** Compiled, elementwise C loops with a rich method protocol (reduce / accumulate / outer / at) plus `out=` and `where=` — the engine underneath every vectorized NumPy expression.

---

## 1. Overview

A **ufunc** (universal function) is a function that operates **elementwise** on ndarrays, looping in compiled C rather than Python. `np.add`, `np.exp`, `np.sin`, `np.maximum`, `np.greater` — the operators `+ - * / ** > ==` are all thin wrappers over ufuncs. When you write `a + b`, Python calls `np.add(a, b)`, which dispatches to a typed inner loop that runs at memory-bandwidth speed with zero per-element Python overhead.

The problem ufuncs solve is the **interpreter tax**. A Python `for` loop over a million elements pays ~50–100 ns of dispatch per iteration; a ufunc pays it *once* and then runs a tight C loop. That's the whole basis of vectorization (see *Vectorization*). But ufuncs are more than fast maps — they carry a **protocol**: `broadcasting` to align shapes, `reduce`/`accumulate`/`outer` methods to fold and combine, `out=` to write in place, and `where=` to mask which elements compute.

You reach for the ufunc protocol when a plain expression isn't enough: a running product (`accumulate`), a pairwise table (`outer`), an in-place update that avoids a temp allocation (`out=`), or a conditional that skips work (`where=`). Knowing these turns three lines and a temporary array into one allocation-free call.

## 2. Core Concepts

- **Elementwise C loop** — one ufunc call processes the whole array in compiled code; the Python-level cost is O(1), not O(n).
- **Broadcasting is built in** — every binary ufunc aligns shapes from the right, stretching size-1 dims (see *Broadcasting*). `np.add(A, col[:,None])` just works.
- **Type resolution & the loop table** — each ufunc owns a list of typed inner loops (`'ll->l'`, `'dd->d'`…); NumPy picks the narrowest loop that fits, casting inputs (this is where unwanted upcasts to float64 happen).
- **`.reduce(axis)`** — folds a binary ufunc along an axis: `np.add.reduce` *is* `sum`, `np.multiply.reduce` *is* `prod`, `np.maximum.reduce` *is* `max`.
- **`.accumulate(axis)`** — the running/cumulative version: `np.add.accumulate` *is* `cumsum`.
- **`.outer(a, b)`** — applies the ufunc to every pair, producing a shape `(len(a), len(b))` table (outer product, distance grids).
- **`.reduceat` / `.at`** — segmented reductions and **unbuffered** in-place scatter (`np.add.at(x, idx, 1)` handles duplicate indices correctly, unlike `x[idx] += 1`).
- **`out=`** — write the result into a preallocated buffer; no temporary, no new allocation.
- **`where=`** — a boolean mask selecting which elements the ufunc computes; unselected positions keep the (uninitialized unless you pass `out`) value.
- **`np.vectorize`** — wraps a *scalar Python* function to accept arrays. It gives ufunc-like broadcasting **but not ufunc speed** — it's a Python loop in disguise.

## 3. Syntax & Examples

```python
import numpy as np

a = np.array([1, 2, 3, 4])
b = np.array([10, 20, 30, 40])

np.add(a, b)          # array([11, 22, 33, 44])  — same as a + b
np.maximum(a, 3)      # array([3, 3, 3, 4])       — elementwise max, broadcasts scalar
np.greater(a, 2)      # array([False, False,  True,  True])
```

The ufunc **methods** — this is what most people never learn:

```python
np.add.reduce(a)              # 10        — fold with + along axis (== a.sum())
np.multiply.reduce(a)         # 24        — == a.prod()
np.add.accumulate(a)          # [1 3 6 10] — running sum (== a.cumsum())
np.maximum.accumulate(a)      # [1 2 3 4]  — running max
np.multiply.outer(a, b)       # (4,4) table: every a[i]*b[j]
```

**`out=`** for in-place, allocation-free work:

```python
x = np.arange(5, dtype=float)     # [0. 1. 2. 3. 4.]
np.multiply(x, 2, out=x)          # writes back into x, no temp: [0. 2. 4. 6. 8.]
np.exp(x, out=x)                  # exponentiate in place
```

**`where=`** to compute conditionally (here: reciprocal only where nonzero):

```python
v = np.array([2., 0., 4., 0.])
out = np.zeros_like(v)
np.divide(1.0, v, out=out, where=v != 0)   # [0.5 0.  0.25 0. ] — no divide-by-zero warning
```

**Custom "ufunc" via `np.vectorize`** (convenience, not speed):

```python
def step(x, lo, hi):
    return lo if x < 0 else (hi if x > 1 else x)   # scalar Python logic

vstep = np.vectorize(step)
vstep(np.array([-0.5, 0.3, 1.7]), 0.0, 1.0)        # array([0. , 0.3, 1. ])
```

## 4. Worked Example

**Softmax over rows** — combine broadcasting, `out=`, `.reduce`, and numeric stability, all in ufunc land.

```python
import numpy as np

logits = np.array([[2.0, 1.0, 0.1],
                   [1.0, 3.0, 0.2],
                   [0.5, 0.5, 0.5]])

# 1. subtract per-row max for stability (keepdims -> broadcast back)
m = np.max(logits, axis=1, keepdims=True)          # np.maximum.reduce under the hood
z = np.subtract(logits, m)                          # (3,3)-(3,1) broadcasts

# 2. exponentiate IN PLACE — no temporary array
np.exp(z, out=z)

# 3. normalize by row sum (np.add.reduce along axis=1)
z /= z.sum(axis=1, keepdims=True)

print(np.round(z, 3))
print("row sums:", z.sum(axis=1))
```

Output:

```text
[[0.659 0.242 0.099]
 [0.114 0.844 0.042]
 [0.333 0.333 0.333]]
row sums: [1. 1. 1.]
```

Every line here is a ufunc call: `max` (`maximum.reduce`), `subtract`, `exp` with `out=`, `sum` (`add.reduce`), `divide`. No Python loop touches a single element, and the `out=z` on `exp` avoids allocating a second `(3,3)` buffer.

## 5. Under the Hood

A ufunc is a C object holding: the number of inputs/outputs, a **list of typed inner loops**, and a type-resolution function. Calling it triggers four steps — **broadcast** the operands to a common shape, **resolve** the dtype (pick the inner loop, insert casts), **allocate** the output (unless `out=` is given), then run the **C inner loop** over a buffered iterator (`NpyIter`). The methods (`reduce`, `accumulate`, `outer`) reuse the *same* binary inner loop but drive it with a different iteration pattern.

```svg
<svg viewBox="0 0 720 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 z" fill="#475569"/>
    </marker>
  </defs>

  <text x="360" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">np.add(A, B) — one ufunc call, four stages</text>

  <rect x="30" y="50" width="120" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="90" y="72" text-anchor="middle" fill="#1e293b">A, B (ndarrays)</text>
  <text x="90" y="90" text-anchor="middle" fill="#64748b" font-size="11">Python: a + b</text>

  <rect x="200" y="50" width="130" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="265" y="72" text-anchor="middle" fill="#1e293b">1. Broadcast</text>
  <text x="265" y="90" text-anchor="middle" fill="#64748b" font-size="11">align shapes R→L</text>

  <rect x="380" y="50" width="140" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="450" y="70" text-anchor="middle" fill="#1e293b">2. Resolve dtype</text>
  <text x="450" y="88" text-anchor="middle" fill="#64748b" font-size="11">pick 'dd->d' loop</text>

  <rect x="570" y="50" width="120" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="630" y="70" text-anchor="middle" fill="#1e293b">3. Allocate out</text>
  <text x="630" y="88" text-anchor="middle" fill="#64748b" font-size="11">skip if out= given</text>

  <line x1="150" y1="76" x2="196" y2="76" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="330" y1="76" x2="376" y2="76" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="520" y1="76" x2="566" y2="76" stroke="#475569" marker-end="url(#ah)"/>

  <rect x="240" y="150" width="240" height="58" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="174" text-anchor="middle" fill="#1e293b" font-weight="bold">4. C inner loop (NpyIter)</text>
  <text x="360" y="193" text-anchor="middle" fill="#64748b" font-size="11">for i: out[i] = A[i] + B[i]  — no Python</text>
  <line x1="630" y1="104" x2="470" y2="148" stroke="#475569" marker-end="url(#ah)"/>

  <text x="360" y="248" text-anchor="middle" fill="#1e293b" font-weight="bold">Same inner loop, driven differently by the methods:</text>

  <rect x="40" y="268" width="150" height="66" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="115" y="290" text-anchor="middle" fill="#1e293b">.reduce</text>
  <text x="115" y="308" text-anchor="middle" fill="#64748b" font-size="11">acc = f(acc, x[i])</text>
  <text x="115" y="324" text-anchor="middle" fill="#64748b" font-size="11">→ scalar / axis fold</text>

  <rect x="285" y="268" width="150" height="66" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="290" text-anchor="middle" fill="#1e293b">.accumulate</text>
  <text x="360" y="308" text-anchor="middle" fill="#64748b" font-size="11">keep every partial</text>
  <text x="360" y="324" text-anchor="middle" fill="#64748b" font-size="11">→ running result</text>

  <rect x="530" y="268" width="150" height="66" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="605" y="290" text-anchor="middle" fill="#1e293b">.outer</text>
  <text x="605" y="308" text-anchor="middle" fill="#64748b" font-size="11">f(a[i], b[j]) ∀ i,j</text>
  <text x="605" y="324" text-anchor="middle" fill="#64748b" font-size="11">→ (n,m) table</text>
</svg>
```

The critical consequence: `out=` skips stage 3 (no allocation), and `where=` gates the stage-4 loop body so masked elements are never computed. `np.vectorize` sits *outside* this machinery — it only borrows the broadcasting shell and calls your Python function once per element.

## 6. Variations & Trade-offs

| Construct | What it does | Speed | Use when |
|---|---|---|---|
| `a + b` / `np.add(a,b)` | elementwise, new array | C loop, fastest | default arithmetic |
| `np.add(a, b, out=c)` | write into `c`, no temp | C loop, no alloc | hot loops, big arrays, memory pressure |
| `ufunc.reduce(x, axis)` | fold to lower rank | C loop | `sum`/`prod`/`max` on custom ufuncs |
| `ufunc.accumulate(x)` | running fold | C loop | `cumsum`/`cumprod`, prefix scans |
| `ufunc.outer(a, b)` | pairwise table `(n,m)` | C loop | distance/gram matrices |
| `np.add.at(x, idx, v)` | unbuffered scatter | C loop, slower than `+=` | duplicate indices must accumulate |
| `np.vectorize(f)` | broadcast a Python fn | **Python loop** | readability only; f is unavoidably scalar |
| `np.frompyfunc(f,i,o)` | like vectorize, returns object dtype | Python loop | quick pyfunc → array-ish |
| numba `@vectorize` / Cython | compile a *real* ufunc | C speed | custom elementwise math at scale |

Prose: reach for `out=` and the methods before you reach for anything exotic. `np.vectorize` is documented by NumPy itself as "provided primarily for convenience, not performance" — its loop is Python. If you genuinely need a fast custom ufunc, compile one (numba's `@guvectorize`/`@vectorize` or Cython), don't wrap Python.

## 7. Production / Performance Notes

- **`out=` in hot paths.** For large arrays, the temporary allocation and its later free dominate. `np.multiply(x, w, out=x)` on a `1e8`-element array saves ~800 MB of churn versus `x = x * w`.
- **Watch dtype resolution.** `int8_array + 1` may upcast the *literal* but stay int8; `int_array / 2` always promotes to float64 (true division is a float ufunc). Unexpected float64 outputs are almost always a ufunc casting rule. Pin with `out=` of the desired dtype or `astype`.
- **`np.add.at` is correct but slow.** It's unbuffered specifically so duplicate indices accumulate. If indices are unique, plain `x[idx] += v` is far faster. For heavy histogram-style scatter, prefer `np.bincount` / `np.histogram`.
- **`where=` doesn't initialize skipped slots.** Without `out=`, masked-out positions are *uninitialized memory*. Always pair `where=` with an `out=` you've prefilled (e.g. `np.zeros_like`).
- **`np.vectorize` cost is real.** Benchmark: a scalar function over `1e6` floats is ~100× slower via `np.vectorize` than an equivalent expression built from real ufuncs. It also infers the output dtype from the *first* element unless you pass `otypes=`, a subtle correctness trap.
- **`reduce` with `initial=` and `where=`** lets you fold safely over possibly-empty slices (`np.add.reduce(x, where=mask, initial=0)`).

## 8. Common Mistakes

1. ⚠️ **Using `np.vectorize` for speed.** It's a Python loop. Fix: rebuild the logic from real ufuncs / `np.where` / boolean masks, or compile with numba.
2. ⚠️ **`x[idx] += 1` for a histogram with repeated `idx`.** Duplicates are lost (last-write-wins on the buffered read-modify-write). Fix: `np.add.at(x, idx, 1)` or `np.bincount`.
3. ⚠️ **Forgetting `out=` must have the exact broadcast shape and a compatible dtype.** Writing a float result into an int `out=` raises or truncates. Fix: allocate `out` with the resolved dtype.
4. ⚠️ **`where=` without `out=`.** Skipped elements are garbage memory. Fix: pass a preinitialized `out=`.
5. ⚠️ **Assuming `.reduce` needs a named function.** `sum` exists, but for a *custom* binary ufunc, `.reduce` is how you fold it — people reimplement it in Python by mistake.
6. ⚠️ **Chaining that allocates temporaries in a tight loop** (`x = a*b + c*d`) when memory-bound. Fix: `np.multiply(a,b,out=t1); np.multiply(c,d,out=t2); np.add(t1,t2,out=t1)`.
7. ⚠️ **Silent int→float upcast** breaking a downstream `dtype` assumption. Fix: check `result.dtype`; use integer-preserving ops (`//`) or explicit `out=`.
8. ⚠️ **`np.vectorize` inferring wrong output dtype** from element 0 (e.g. all-int first row → truncated floats). Fix: pass `otypes=[float]`.

## 9. Interview Questions

**Q: What exactly is a ufunc, and why is it fast?**
A: A universal function that operates elementwise on ndarrays via a compiled, typed C inner loop. It's fast because the Python-level dispatch cost is paid once for the whole array (O(1)) instead of once per element; the loop itself runs at C/memory-bandwidth speed with no interpreter overhead.

**Q: The operator `+` on arrays — what actually runs?**
A: `a + b` calls `a.__add__`, which dispatches to the `np.add` ufunc: broadcast shapes, resolve dtype and pick the inner loop, allocate output, run the C loop.

**Q: What do `.reduce`, `.accumulate`, and `.outer` do?**
A: `.reduce` folds a binary ufunc along an axis to lower rank (`np.add.reduce` == `sum`); `.accumulate` keeps every partial result (running/cumulative, == `cumsum`); `.outer(a,b)` applies the ufunc to every pair, yielding an `(len(a), len(b))` table.

**Q: Why and when use `out=`?**
A: `out=` writes the result into a preallocated buffer, skipping the temporary allocation. In memory-bound hot paths or with very large arrays it avoids allocating and later freeing a full-size array, cutting both time and peak memory. It also lets you pin the output dtype.

**Q: What does `where=` do, and what's the trap?**
A: `where=` is a boolean mask selecting which elements the ufunc computes. The trap: elements where the mask is False are *not written*, so without an accompanying preinitialized `out=` they contain uninitialized memory.

**Q: Why is `x[idx] += 1` wrong when `idx` has duplicates, and what's the fix?**
A: Fancy-indexed `+=` does a buffered read-modify-write, so duplicate indices all read the same original value and the last write wins — increments are lost. `np.add.at(x, idx, 1)` performs an unbuffered scatter that accumulates correctly (or use `np.bincount`).

**Q: Is `np.vectorize` a way to make code fast?**
A: No. It provides ufunc-style broadcasting and a clean interface, but internally it's a Python loop calling your scalar function per element — essentially as slow as a manual loop. It's for convenience/readability, not performance.

**Q: (Senior) How does NumPy decide which C loop and output dtype a ufunc uses?**
A: Each ufunc carries an ordered list of typed inner loops (signatures like `'ll->l'`, `'dd->d'`). Type resolution finds the first loop all inputs can safe-cast to, inserting casts as needed; this is why `int / int` promotes to float64 (division's only loops are float) and why mixed-dtype ops upcast. You can inspect `np.add.types`.

**Q: (Senior) You need a genuinely fast custom elementwise function. Options?**
A: Compose it from existing ufuncs + `np.where`/masks (best), or compile a real ufunc: numba's `@vectorize`/`@guvectorize`, Cython, or a C extension registering inner loops. Avoid `np.vectorize`/`np.frompyfunc` for hot paths — they stay in Python and `frompyfunc` returns object dtype.

**Q: (Senior) How do the ufunc methods relate to reductions like `np.sum`?**
A: They *are* the reductions. `np.sum` is essentially `np.add.reduce`, `np.prod` is `np.multiply.reduce`, `np.cumsum` is `np.add.accumulate`, `np.max` is `np.maximum.reduce`. The high-level functions add axis/dtype/nan-handling conveniences over the same machinery.

**Q: (Senior) What's `reduceat` for?**
A: Segmented reduction: `np.add.reduceat(x, indices)` reduces `x` over the slices bounded by `indices`, giving grouped sums in one pass — a fast building block for ragged/grouped aggregation without a Python loop.

## 10. Practice

- [ ] Implement softmax over rows using only ufuncs, with the `exp` step in place via `out=`; verify each row sums to 1.
- [ ] Build a pairwise squared-distance matrix between two point sets using `np.subtract.outer` (or broadcasting) and `np.add.reduce`.
- [ ] Given an index array with duplicates, build a histogram three ways: `x[idx]+=1` (observe the bug), `np.add.at`, and `np.bincount`; compare results and timings.
- [ ] Reciprocal-only-where-nonzero: use `np.divide(1, v, out=..., where=v!=0)` and confirm no divide warning fires.
- [ ] Benchmark a scalar transform over 1e6 elements as a Python loop, `np.vectorize`, and a pure-ufunc expression; report the speedups.

## 11. Cheat Sheet

> [!TIP]
> **Ufuncs = compiled elementwise C loops with a protocol.**
> - `a+b` ⇒ `np.add(a,b)`: broadcast → resolve dtype → alloc → C loop.
> - Methods (same inner loop, different driver): `.reduce`=`sum`, `.accumulate`=`cumsum`, `.outer`=pairwise table, `.reduceat`=segmented, `.at`=unbuffered scatter.
> - `out=`: no temp allocation, pin dtype — use in hot/large paths.
> - `where=`: compute only masked elements — **always** pair with a preinitialized `out=`.
> - Duplicate-index accumulate ⇒ `np.add.at` (not `x[idx]+=`). Unique ⇒ `+=` is fine.
> - Int/int division ⇒ float64 (dtype resolution). Check `result.dtype`.
> - `np.vectorize` = convenience, **Python loop, ~100× slower**. Fast custom ufunc ⇒ numba/Cython.

**References:** NumPy Universal Functions (ufunc) docs, NumPy "Universal functions" reference, NumPy Enhancement Proposals on ufunc overrides, SciPy Lecture Notes

---
*NumPy & Pandas Handbook — topic 09.*
