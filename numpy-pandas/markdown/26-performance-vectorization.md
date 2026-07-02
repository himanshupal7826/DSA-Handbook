# 26 · Performance: Vectorize & Avoid apply

> **In one line:** Push work down into C — replace Python-level row loops with array/column operations, and reach for `eval`/`query` (numexpr) or raw NumPy when Pandas overhead itself becomes the cost.

---

## 1. Overview

Pandas is fast when it can run a loop **in C over a contiguous buffer**, and slow the moment it has to call back into the Python interpreter once per row. Every `iterrows`, `itertuples`, or `apply(axis=1)` pays that per-row interpreter tax — box a value into a Python object, call your function, unbox the result — millions of times. The same computation expressed as a **vectorized** column operation runs a single C loop with no boxing.

The mental model is a **cost ladder**. For a fixed transformation, the runtime typically spans two to three orders of magnitude depending on how you express it: `iterrows` ≫ `apply(axis=1)` ≫ `.map`/`.apply` on a Series ≫ vectorized Pandas ≫ raw NumPy on `.to_numpy()`. Knowing where you are on that ladder — and how to climb it — is the single highest-leverage performance skill in Pandas.

This page covers the ladder, the timing methodology to prove where you stand, `eval`/`query` for expression fusion via **numexpr**, and when dropping to NumPy or Arrow is worth it. The companion topic *Memory Optimization & dtypes* covers the memory axis; this one is about wall-clock time.

## 2. Core Concepts

- **The per-row interpreter tax** — `iterrows`/`apply(axis=1)` invoke a Python callable N times; the CPython dispatch, attribute lookups, and object boxing dominate, not your arithmetic.
- **Vectorization** — a whole-array operation (`df.a + df.b`) executes one compiled C loop over a typed buffer. This is the default you should reach for.
- **The cost ladder** — `iterrows` ≫ `apply(axis=1)` ≫ Series `.apply`/`.map` ≫ vectorized Pandas ≫ NumPy on `.to_numpy()`. Each rung is often 5–50× the next.
- **`np.where` / `np.select`** — vectorize conditional logic instead of an `if/else` inside `apply`.
- **`eval` / `query`** — parse an expression string and evaluate it with **numexpr**, fusing operations to avoid materializing large intermediate arrays and using multiple cores.
- **numexpr** — the engine behind `eval`/`query`; it chunks arrays into cache-sized blocks and threads them, cutting memory traffic on big frames.
- **`apply` is not vectorized** — even `Series.apply` is a Python loop; it is only "fast" relative to `iterrows`, never relative to true vector ops.
- **Timing methodology** — use `%timeit` (many loops, reports best-of), warm the cache, hold data size fixed, and compare against a vectorized baseline — never eyeball a single `time.time()`.
- **Drop to NumPy** — `.to_numpy()` sheds per-element index alignment and dtype dispatch; for tight numeric kernels it is the last rung before Cython/Numba.

## 3. Syntax & Examples

Start with the anti-pattern, then climb the ladder. All examples compute `c = a * b + 1`.

```python
import numpy as np, pandas as pd
df = pd.DataFrame(np.random.rand(1_000_000, 2), columns=['a', 'b'])

# ❌ Rung 0: iterrows — a Python object per row
c = []
for _, row in df.iterrows():
    c.append(row['a'] * row['b'] + 1)

# ❌ Rung 1: apply(axis=1) — Python callable per row
df['c'] = df.apply(lambda r: r['a'] * r['b'] + 1, axis=1)

# ⚠️ Rung 2: itertuples — faster than iterrows (namedtuples, no boxing to Series)
df['c'] = [t.a * t.b + 1 for t in df.itertuples()]

# ✅ Rung 3: vectorized Pandas — one C loop
df['c'] = df['a'] * df['b'] + 1

# ✅ Rung 4: NumPy on raw buffers — no index alignment
a, b = df['a'].to_numpy(), df['b'].to_numpy()
df['c'] = a * b + 1
```

Vectorize conditionals with `np.where` (binary) or `np.select` (multi-branch):

```python
# ❌ df['tier'] = df.apply(lambda r: 'hi' if r.score > 90 else 'lo', axis=1)
df['tier'] = np.where(df['score'] > 90, 'hi', 'lo')

conds = [df.score >= 90, df.score >= 70]
df['grade'] = np.select(conds, ['A', 'B'], default='C')
```

Use `eval`/`query` to fuse large expressions via numexpr:

```python
# Fuses the whole RHS, avoids temporaries, threads across cores
df['z'] = df.eval('a * b + a / (b + 1) - b ** 2')
hot = df.query('a > 0.9 and b < 0.1')     # boolean mask via numexpr
```

## 4. Worked Example

A realistic scenario: 1M-row transactions, compute a fee = `amount * rate`, capped at 100, then flag high-value rows. We benchmark each rung with `%timeit`.

```python
import numpy as np, pandas as pd
n = 1_000_000
df = pd.DataFrame({
    'amount': np.random.rand(n) * 500,
    'rate':   np.random.rand(n) * 0.05,
})

def fee_iter(df):
    out = []
    for _, r in df.iterrows():
        out.append(min(r['amount'] * r['rate'], 100))
    return out

def fee_apply(df):
    return df.apply(lambda r: min(r['amount'] * r['rate'], 100), axis=1)

def fee_vec(df):
    return np.minimum(df['amount'] * df['rate'], 100)

def fee_numpy(df):
    a, rt = df['amount'].to_numpy(), df['rate'].to_numpy()
    return np.minimum(a * rt, 100)
```

Timing on a 2023 laptop (Python 3.11, Pandas 2.2, NumPy 1.26):

```text
%timeit fee_iter(df)     # 41.7 s ± 0.9 s   per loop  (n=1)
%timeit fee_apply(df)    # 9.83 s ± 0.21 s  per loop  (n=1)
%timeit fee_vec(df)      # 6.94 ms ± 0.12 ms per loop
%timeit fee_numpy(df)    # 4.11 ms ± 0.08 ms per loop
%timeit df.eval('amount * rate')  # 3.2 ms ± 0.1 ms   (no cap; fused)
```

The vectorized version is **~6,000× faster** than `iterrows` and **~1,400× faster** than `apply(axis=1)`. Dropping to NumPy shaves another ~40% by skipping index alignment. This ratio is not exotic — it is the *normal* gap, and it grows with row count.

| Method | Time (1M rows) | Speedup vs iterrows |
|---|---|---|
| `iterrows` | 41.7 s | 1× |
| `apply(axis=1)` | 9.83 s | 4.2× |
| `itertuples` | ~1.8 s | 23× |
| vectorized Pandas | 6.94 ms | ~6,000× |
| NumPy `.to_numpy()` | 4.11 ms | ~10,100× |
| `eval` (numexpr) | 3.2 ms | ~13,000× |

## 5. Under the Hood

Why the cliff between rung 1 and rung 3? An `apply(axis=1)` builds a **Series object for every row**, dispatches into the CPython interpreter to run your lambda, and boxes/unboxes each scalar. That is O(N) Python-level calls. A vectorized `df.a * df.b` calls a single ufunc that loops in C over the two typed buffers with zero interpreter involvement.

`eval`/`query` go one step further. Instead of evaluating `a*b + a/b` as *two full-array temporaries then a third*, **numexpr** compiles the expression, walks the arrays in cache-sized blocks (~4 KB), and applies all operations to each block before moving on — so intermediates never leave L1/L2 cache, and it threads the blocks across cores.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="22" text-anchor="middle" fill="#1e293b" font-weight="bold">The Cost Ladder — same computation, different expression</text>

  <rect x="30" y="45" width="300" height="42" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">iterrows / apply(axis=1)</text>
  <text x="180" y="80" text-anchor="middle" fill="#64748b">Python callable per row → boxing → interpreter</text>
  <text x="640" y="70" text-anchor="middle" fill="#b91c1c" font-weight="bold">~10–40 s</text>

  <rect x="30" y="105" width="300" height="42" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="124" text-anchor="middle" fill="#1e293b" font-weight="bold">itertuples / Series.apply</text>
  <text x="180" y="140" text-anchor="middle" fill="#64748b">still a Python loop, less boxing</text>
  <text x="640" y="130" text-anchor="middle" fill="#d97706" font-weight="bold">~1–2 s</text>

  <rect x="30" y="165" width="300" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="184" text-anchor="middle" fill="#1e293b" font-weight="bold">vectorized Pandas (df.a * df.b)</text>
  <text x="180" y="200" text-anchor="middle" fill="#64748b">one C loop over typed buffers</text>
  <text x="640" y="190" text-anchor="middle" fill="#2563eb" font-weight="bold">~7 ms</text>

  <rect x="30" y="225" width="300" height="42" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="180" y="244" text-anchor="middle" fill="#1e293b" font-weight="bold">NumPy / eval (numexpr)</text>
  <text x="180" y="260" text-anchor="middle" fill="#64748b">no index align; fused, cache-blocked, threaded</text>
  <text x="640" y="250" text-anchor="middle" fill="#059669" font-weight="bold">~3–4 ms</text>

  <line x1="380" y1="87" x2="380" y2="105" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="380" y1="147" x2="380" y2="165" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="380" y1="207" x2="380" y2="225" stroke="#475569" marker-end="url(#ar)"/>
  <text x="410" y="100" fill="#64748b" font-size="11">faster ↓</text>
</svg>
```

## 6. Variations & Trade-offs

| Technique | Best for | Cost / caveat |
|---|---|---|
| Vectorized Pandas | Default for all element-wise/column math | None — always try first |
| `.to_numpy()` + NumPy | Tight numeric kernels, no index needed | Loses index alignment & NA semantics |
| `np.where` / `np.select` | Conditional column logic | Both branches evaluated eagerly |
| `eval` / `query` | Large frames, long arithmetic expressions | Overhead dominates on small frames (<10k rows); only ndarray-ish math |
| `Series.apply` / `.map` | Genuinely non-vectorizable per-element logic (regex, custom parsing) | Still a Python loop — last resort |
| Numba / Cython | Iterative kernels that truly need loops | Compile step, extra dependency |

**When `apply` is legitimate:** truly row-dependent logic with no NumPy equivalent — parsing free-text, calling an external API, complex branching that can't reduce to `np.select`. Even then, prefer `Series.apply` (1-D) over `apply(axis=1)`, and consider `map` with a precomputed dict for lookups.

**`eval`/`query` are not free:** they carry parse + numexpr setup overhead, so on a 5,000-row frame plain vectorization wins. The crossover is roughly 10k–50k rows and grows with expression length. Always benchmark on your real size.

## 7. Production / Performance Notes

- **Profile before optimizing.** Use `%timeit` in notebooks, `%%timeit` for cells, and `line_profiler` (`%lprun`) to find the actual hot line. Do not guess.
- **Hold size fixed, warm the cache.** The first run allocates and pages in memory; `%timeit` runs many loops and reports the best, which is what you want for CPU-bound comparisons.
- **Batch, don't loop-concat.** Building a DataFrame by `pd.concat` inside a loop is O(N²) (each concat copies). Accumulate in a Python list and `pd.concat` once.
- **GroupBy: prefer built-in aggregations.** `df.groupby('k')['v'].sum()` is Cython-optimized; `groupby(...).apply(custom)` falls back to Python per group — vectorize the aggregation or use `transform`.
- **String ops:** `.str` methods are vectorized-ish but still slower than numeric; for heavy text work consider Arrow-backed string dtype (`dtype="string[pyarrow]"`) or precomputed categoricals.
- **`eval`/`query` need numexpr installed** to hit the multi-core path; without it Pandas falls back to the `python` engine (no speedup). Check with `pd.get_option('compute.use_numexpr')`.
- **Set `numexpr` threads** via `NUMEXPR_MAX_THREADS`; on shared/containerized hosts unbounded threading can hurt neighbors.
- **When Pandas overhead itself is the floor**, escalate: NumPy → Numba → Polars/DuckDB for out-of-core or multi-core columnar work.

## 8. Common Mistakes

1. ⚠️ **Reaching for `apply(axis=1)` by default.** It is a Python loop dressed as a one-liner. Fix: express as column arithmetic, `np.where`, or `np.select` first.
2. ⚠️ **Believing `apply` is "vectorized".** It is not — it is only faster than `iterrows`. Fix: benchmark against a true vector op to see the real gap.
3. ⚠️ **`pd.concat` inside a loop.** Quadratic copying. Fix: append to a list, concat once at the end.
4. ⚠️ **Using `eval`/`query` on tiny frames.** Parse/numexpr overhead makes it *slower*. Fix: only use above ~tens of thousands of rows; benchmark the crossover.
5. ⚠️ **Timing with one `time.time()` call.** Cold caches and OS noise make it meaningless. Fix: use `%timeit`/`%%timeit` (best-of-many).
6. ⚠️ **Calling `.to_numpy()` but keeping Python-loop logic.** The buffer is only fast if you then run NumPy ops on it, not a `for`. Fix: vectorize the kernel too.
7. ⚠️ **Ignoring dtype.** `object`-dtype columns kill vectorization (each element is a Python object). Fix: cast to numeric/category first (see *Memory Optimization*).
8. ⚠️ **`groupby(...).apply(python_fn)` for something built-in.** Fix: use named aggregations or `transform`, which stay in Cython.

## 9. Interview Questions

**Q: Why is `df.apply(func, axis=1)` slow, and what's the fix?**
A: It calls a Python function once per row, building a Series per row and paying interpreter/boxing overhead — O(N) Python calls. The fix is to express the logic as vectorized column operations (`df.a * df.b`), or `np.where`/`np.select` for conditionals, so a single C loop runs over typed buffers.

**Q: Rank `iterrows`, `apply(axis=1)`, vectorized ops, and NumPy by speed and explain the gaps.**
A: `iterrows` ≫ `apply(axis=1)` ≫ vectorized Pandas ≫ NumPy on `.to_numpy()`, spanning ~3–4 orders of magnitude. `iterrows` boxes each row into a Series; `apply(axis=1)` still calls Python per row; vectorized runs one C loop; raw NumPy additionally sheds index alignment and dtype dispatch.

**Q: What is `eval`/`query` doing under the hood, and when does it help?**
A: They parse an expression string and evaluate it with **numexpr**, which walks arrays in cache-sized blocks applying all fused operations per block (avoiding large temporaries) and threads across cores. It helps on large frames (~>tens of thousands of rows) with multi-term arithmetic; on small frames its setup overhead makes it slower.

**Q: Is `apply` ever the right tool?**
A: Yes — for genuinely non-vectorizable per-element logic like regex parsing, external calls, or irreducible branching. Prefer `Series.apply` (1-D) over `apply(axis=1)`, and use `map` with a dict for lookups. It should be a last resort after `np.select`/vectorization fail.

**Q: How do you benchmark a Pandas optimization credibly?**
A: Use `%timeit`/`%%timeit` (runs many loops, reports best-of, warms cache), hold data size fixed, compare against a vectorized baseline, and use `%lprun` (line_profiler) to find the actual hot line. Never rely on a single wall-clock reading.

**Q: You replaced a loop with `.to_numpy()` but saw little speedup. Why?**
A: Likely the kernel is still a Python loop over the array, or the column is `object` dtype so each element is a boxed Python object. `.to_numpy()` only helps if you then run NumPy vector ops on a numeric buffer.

**Q: (Senior) Why can building a DataFrame via `pd.concat` in a loop dominate runtime, and how do you fix it?**
A: Each `concat` allocates a new array and copies all prior data, making the loop O(N²) in total bytes moved. Accumulate rows/frames in a Python list and call `pd.concat` once (O(N)), or preallocate and assign by position.

**Q: (Senior) `groupby('k').apply(fn)` is your bottleneck. What are your options?**
A: `apply` runs `fn` in Python per group. Replace with Cython-optimized built-ins (`.agg({'v':'sum'})`, named aggregations), use `transform` for aligned results, or if the logic is truly custom, vectorize inside `fn`, use `numba` engine on supported reductions, or move to Polars/DuckDB.

**Q: (Senior) numexpr is installed but `eval` gives no speedup. What do you check?**
A: Confirm `pd.get_option('compute.use_numexpr')` is True and the frame is large enough to clear numexpr's overhead; check the expression is ndarray math (no unsupported ops force the `python` engine); verify `NUMEXPR_MAX_THREADS`/available cores aren't pinned to 1 in the container.

**Q: How does dtype choice interact with vectorization speed?**
A: Vectorized C loops require homogeneous typed buffers. `object` dtype forces per-element Python dispatch, defeating vectorization; numeric or `category`/Arrow dtypes keep operations in C. Right-sizing dtypes also improves cache locality (fewer bytes per element = more elements per cache line).

## 10. Practice

- [ ] Time `iterrows`, `apply(axis=1)`, vectorized, and `.to_numpy()` versions of `a*b+1` on a 1M-row frame with `%timeit`; record the ratios.
- [ ] Rewrite an `apply(axis=1)` conditional as `np.select` with three branches and confirm identical output.
- [ ] Find a frame size where `df.eval('a*b + a/b')` beats plain vectorization, and one where it loses; report the crossover.
- [ ] Replace a `pd.concat`-in-a-loop builder with list-accumulate-then-concat and measure the difference at 10k iterations.
- [ ] Use `%lprun` to profile a slow function and identify the single hottest line.

## 11. Cheat Sheet

> [!TIP]
> **Cost ladder (slow→fast):** `iterrows` ≫ `apply(axis=1)` ≫ `itertuples`/`Series.apply` ≫ vectorized Pandas ≫ NumPy `.to_numpy()` ≫ `eval`/numexpr.
> **Default:** vectorize (`df.a*df.b`). **Conditionals:** `np.where` / `np.select`. **Big arithmetic on big frames:** `df.eval(...)` / `df.query(...)` (needs numexpr).
> **`apply` is a Python loop** — last resort for irreducible per-element logic; prefer `Series.apply` over `axis=1`.
> **Never** concat in a loop (O(N²)) — list + one concat. **Never** trust one `time.time()` — use `%timeit`.
> **`object` dtype defeats vectorization** — cast to numeric/category first.

**References:** Pandas User Guide "Enhancing performance", numexpr docs, Pandas "Scaling to large datasets", NumPy ufunc reference

---

*NumPy & Pandas Handbook — topic 26.*
