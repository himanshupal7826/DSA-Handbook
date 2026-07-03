# 25 · apply, map & applymap

> **In one line:** `map` transforms a Series element-by-element, `apply` runs a function over a Series or across a DataFrame's rows/columns, and `applymap`/`map` hits every DataFrame cell — all convenient, all a fallback for when true vectorization won't fit.

---

## 1. Overview

These three methods answer the same question — *"run my function over the data"* — at three different granularities. **`Series.map`** substitutes or transforms each element (great for lookups via a dict). **`Series.apply`** and **`DataFrame.apply`** run a callable over a Series, or over each row/column of a DataFrame. **`DataFrame.applymap`** (renamed **`DataFrame.map`** in pandas 2.1) applies a function to every individual cell.

They are the ergonomic escape hatch when a computation doesn't map cleanly onto a built-in vectorized operation — parsing a messy field, applying arbitrary business logic per row, calling an external library per value. They read naturally and handle almost anything.

But there is a catch that every interview probes: **`apply` is usually a Python `for` loop in disguise.** It calls your Python function once per element/row, paying interpreter overhead each time, and is often **10–100× slower** than the equivalent vectorized NumPy/pandas expression. The senior skill is knowing when `apply` is genuinely necessary versus when it's a lazy substitute for a vectorized op that would be far faster.

So the mental model is a **ladder**: reach first for vectorized operations and built-ins; drop to `map` for dict lookups; use `apply` only when the logic truly can't be vectorized; and know that `applymap`/`map` (cell-wise) is the slowest of all.

## 2. Core Concepts

- **`Series.map(arg)`** — element-wise. `arg` can be a **dict/Series** (lookup/remap — unmatched keys become `NaN`), or a **function** (transform each element). Ideal for label translation.
- **`Series.apply(func)`** — element-wise like `map` for scalars, but geared toward a function and accepts extra `args`/`kwargs`; can also return a Series (expanding to a DataFrame).
- **`DataFrame.apply(func, axis=0)`** — applies `func` to each **column** (`axis=0`, default) or each **row** (`axis=1`). `func` receives a whole Series (the column or row), not a scalar.
- **`axis` semantics** — `axis=0` = "collapse down rows" → function sees each column; `axis=1` = "across columns" → function sees each row. The most common `apply` confusion.
- **`DataFrame.applymap` / `DataFrame.map`** — element-wise over **every cell**. `applymap` is deprecated in favor of `map` (2.1+). Slowest, since it's per-cell.
- **`result_type`** — with `axis=1`, controls how returned lists/Series expand: `"expand"` (→ columns), `"reduce"` (→ Series), `"broadcast"`.
- **Vectorization first** — arithmetic, comparisons, `np.where`, `.str`, `.dt`, `.clip`, `map`-by-dict all run in C; prefer them. `apply` is the fallback, not the default.
- **Legitimate `apply` uses** — row logic spanning several columns that resists vectorization, calling non-vectorized external functions, returning multiple values per row, `groupby.apply` for whole-group transforms.

## 3. Syntax & Examples

```python
import pandas as pd
import numpy as np

s = pd.Series(["cat", "dog", "cat", "bird"])

# Series.map with a DICT — the canonical lookup/remap
legs = {"cat": 4, "dog": 4, "bird": 2}
s.map(legs)                 # [4, 4, 4, 2]; unmatched keys -> NaN

# Series.map / apply with a FUNCTION
s.map(str.upper)            # ['CAT','DOG','CAT','BIRD']
s.apply(len)               # [3, 3, 3, 4]
```

```python
df = pd.DataFrame({"a": [1, 2, 3], "b": [10, 20, 30]})

# DataFrame.apply, axis=0 (default): func sees each COLUMN
df.apply(np.sum)            # a:6, b:60  (column sums)
df.apply(lambda col: col.max() - col.min())   # per-column range

# DataFrame.apply, axis=1: func sees each ROW
df.apply(lambda row: row["a"] * row["b"], axis=1)   # [10, 40, 90]

# Return multiple columns from a row function
df.apply(lambda r: pd.Series({"sum": r.a + r.b, "prod": r.a * r.b}), axis=1)
```

```python
# DataFrame element-wise (every cell). applymap -> map in pandas 2.1+
df.map(lambda x: f"${x:.2f}")     # format every cell
# older: df.applymap(lambda x: f"${x:.2f}")

# The SAME result vectorized — far faster than apply(axis=1):
df["a"] * df["b"]                 # element-wise, C-speed, no Python loop
```

## 4. Worked Example

Compute a tiered discount per order. First the natural (slow) `apply(axis=1)`, then the vectorized rewrite, then time both.

```python
import pandas as pd, numpy as np, time

n = 1_000_000
df = pd.DataFrame({
    "amount": np.random.randint(1, 500, n),
    "tier":   np.random.choice(["gold", "silver", "bronze"], n),
})

rate = {"gold": 0.20, "silver": 0.10, "bronze": 0.05}

# --- Approach A: apply over rows (Python loop per row) ---
t0 = time.perf_counter()
df["disc_apply"] = df.apply(lambda r: r["amount"] * rate[r["tier"]], axis=1)
tA = time.perf_counter() - t0

# --- Approach B: vectorized (map the dict, then multiply arrays) ---
t0 = time.perf_counter()
df["disc_vec"] = df["amount"] * df["tier"].map(rate)
tB = time.perf_counter() - t0

assert np.allclose(df["disc_apply"], df["disc_vec"])
```

**Timings (1M rows, indicative):**

| approach | what runs per element | time | speedup |
|---|---|---|---|
| `apply(axis=1)` | Python lambda per row | ~7.5 s | 1× |
| `map` dict + vector `*` | C loop | ~0.02 s | ~350× |

Both produce identical numbers, but the vectorized version — `map` the tier→rate dict to build an array, then multiply two arrays in C — is hundreds of times faster. `apply(axis=1)` had to build a Python Series object for each of a million rows and call the lambda each time. This is the single most important performance lesson in pandas: **an `apply(axis=1)` you can express as array math should be.**

## 5. Under the Hood

Why is `apply` slow? A vectorized pandas/NumPy op loops over the array **in C**, touching contiguous memory with no per-element Python overhead. `apply(axis=1)`, by contrast, must for each row: materialize a Python Series object (boxing each value), call into the Python interpreter to run your function, and collect the boxed result. That per-row overhead — object creation + interpreter dispatch — dwarfs the actual arithmetic.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a5" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Same math, two execution paths</text>

  <!-- apply path -->
  <rect x="30" y="46" width="320" height="230" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="190" y="70" text-anchor="middle" fill="#b91c1c" font-weight="bold">apply(axis=1): Python loop</text>
  <rect x="60" y="86" width="260" height="30" rx="6" fill="#ffffff" stroke="#d97706"/><text x="190" y="106" text-anchor="middle" fill="#1e293b">row 1 → box Series → call func()</text>
  <rect x="60" y="122" width="260" height="30" rx="6" fill="#ffffff" stroke="#d97706"/><text x="190" y="142" text-anchor="middle" fill="#1e293b">row 2 → box Series → call func()</text>
  <rect x="60" y="158" width="260" height="30" rx="6" fill="#ffffff" stroke="#d97706"/><text x="190" y="178" text-anchor="middle" fill="#64748b">… 1,000,000 times …</text>
  <rect x="60" y="194" width="260" height="30" rx="6" fill="#ffffff" stroke="#d97706"/><text x="190" y="214" text-anchor="middle" fill="#1e293b">interpreter dispatch each row</text>
  <text x="190" y="252" text-anchor="middle" fill="#b91c1c" font-weight="bold">~7.5 s</text>

  <!-- vectorized path -->
  <rect x="380" y="46" width="310" height="230" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="535" y="70" text-anchor="middle" fill="#059669" font-weight="bold">vectorized: one C loop</text>
  <rect x="410" y="90" width="250" height="34" rx="6" fill="#ffffff" stroke="#059669"/><text x="535" y="112" text-anchor="middle" fill="#1e293b">amount[] (contiguous array)</text>
  <line x1="535" y1="124" x2="535" y2="150" stroke="#475569" marker-end="url(#a5)"/>
  <rect x="410" y="150" width="250" height="34" rx="6" fill="#ffffff" stroke="#059669"/><text x="535" y="172" text-anchor="middle" fill="#1e293b">× rate[] → result[] (in C)</text>
  <text x="535" y="214" text-anchor="middle" fill="#64748b">no Python objects per element</text>
  <text x="535" y="252" text-anchor="middle" fill="#059669" font-weight="bold">~0.02 s (~350×)</text>
</svg>
```

`Series.map` with a **dict** is faster than `apply` with a function because the lookup is a hashmap probe rather than a Python call per element (and pandas can optimize it). `applymap`/`map` over a DataFrame is the slowest because it's one Python call **per cell** — rows × columns invocations.

## 6. Variations & Trade-offs

| Method | Granularity | Typical use | Speed |
|---|---|---|---|
| `Series.map(dict)` | element (lookup) | remap/translate labels | fast-ish (hashmap) |
| `Series.map(func)` / `Series.apply(func)` | element | per-value transform | slow (py per elem) |
| `DataFrame.apply(func, axis=0)` | per column | column-wise reduce/transform | moderate (few calls) |
| `DataFrame.apply(func, axis=1)` | per row | multi-column row logic | **slow** (py per row) |
| `DataFrame.map` (was `applymap`) | per cell | format every cell | **slowest** (py per cell) |
| vectorized / `np.where` / `.str` | whole array | anything expressible as array math | fastest (C) |

**`map` vs `apply` on a Series:** `map` accepts a dict/Series for lookups (unmatched → `NaN`) and is the idiomatic remap tool; `apply` is function-only but accepts extra args and can return a Series that expands. For pure element transforms they're similar in speed; prefer `map` for dict lookups.

**`apply(axis=0)` vs `apply(axis=1)`:** `axis=0` calls the function once per *column* (a handful of calls, each vectorized inside) — often fine. `axis=1` calls once per *row* (millions of Python calls) — the slow one to avoid. When you see `axis=1`, ask "can this be array math?"

**When `apply` is legitimate:** row logic combining several columns that genuinely can't vectorize (complex branching, calling a non-vectorized library like a geocoder), returning multiple derived columns per row, or `groupby(...).apply(func)` for whole-group transforms. Even then, consider `np.select`/`np.where` for branching and `groupby.transform`/`agg` for group work first.

## 7. Production / Performance Notes

- **Climb the ladder: vectorize → `map` dict → `apply` → `applymap`.** Only descend when the rung above genuinely can't express the logic. Most `apply(axis=1)` in real code is avoidable.
- **Replace branching `apply` with `np.where` / `np.select`.** Tiered/conditional logic (`if tier == "gold" …`) vectorizes cleanly: `np.select([conds], [choices], default)`.
- **Use `Series.map(dict)` for lookups, not `apply`.** It's the idiomatic and faster way to translate codes to labels; unmatched keys surface as `NaN` (a feature — you can spot gaps).
- **Prefer `.str`/`.dt` accessors over `apply` for text/date work.** `s.str.extract(...)`, `s.dt.year` run in C; `s.apply(lambda x: x.year)` does not.
- **If you must `apply`, keep the function tiny and avoid per-call imports/allocations.** For heavy numeric row logic, consider `numba`, or restructure to operate on columns.
- **`groupby.apply` is flexible but slow.** Prefer `groupby.agg`/`transform` with named reducers when possible; reserve `apply` for genuinely per-group custom logic.
- **Measure before optimizing.** `%timeit` the `apply` and the vectorized rewrite; the speedups (often 50–500×) justify the rewrite, but confirm equality (`np.allclose`) — vectorized and loop versions must produce identical results.
- **Beware `apply` on empty frames / mixed dtypes.** pandas may infer the result shape/dtype from the first call; an empty input or a heterogeneous return can yield surprising dtypes.

## 8. Common Mistakes

1. ⚠️ **`apply(axis=1)` for something that's array math.** Silently 100× slower. **Fix:** express as vectorized ops (`df.a * df.b`, `np.where`, `.str`).
2. ⚠️ **Confusing `axis=0` and `axis=1`.** `axis=0` gives columns, `axis=1` gives rows — easy to invert. **Fix:** remember `axis=1` = "operate across columns → one row at a time".
3. ⚠️ **Using `apply` for a dict lookup.** Verbose and slower. **Fix:** `Series.map(mapping_dict)`.
4. ⚠️ **Ignoring `NaN` from an unmatched `map`.** Keys missing from the dict become `NaN`. **Fix:** provide a complete mapping or `.fillna(default)` after.
5. ⚠️ **Still calling `applymap`.** Deprecated in pandas 2.1. **Fix:** use `DataFrame.map`; better, avoid cell-wise entirely.
6. ⚠️ **Chaining conditionals inside `apply`.** Slow and hard to read. **Fix:** `np.select([c1, c2], [v1, v2], default=v3)`.
7. ⚠️ **Row-`apply` that mutates external state.** Order/parallelism assumptions break; also can't vectorize. **Fix:** return values; keep the function pure.
8. ⚠️ **Assuming `apply` preserves dtype.** Result dtype is inferred and may upcast to object. **Fix:** cast explicitly (`.astype(...)`) or prefer a typed vectorized op.

## 9. Interview Questions

**Q: What's the difference between `map`, `apply`, and `applymap`?**
A: `Series.map` transforms a Series element-wise and accepts a dict/Series for lookups. `apply` runs a function over a Series, or over each column (`axis=0`) or row (`axis=1`) of a DataFrame, receiving whole Series. `applymap` (now `DataFrame.map`) applies a function to every individual cell. Granularity increases map(element) → apply(row/col) with applymap being per-cell.

**Q: Why is `apply(axis=1)` usually slow?**
A: It's effectively a Python `for` loop over rows: for each row pandas boxes a Python Series object and calls your function through the interpreter, so you pay object-construction and dispatch overhead per row. A vectorized equivalent loops in C over contiguous memory with none of that overhead, often 10–100× faster.

**Q: What do `axis=0` and `axis=1` mean in `DataFrame.apply`?**
A: `axis=0` (default) applies the function to each **column** — the function receives a column Series; `axis=1` applies it to each **row** — the function receives a row Series. Mnemonic: `axis=1` operates *across columns*, i.e. one row at a time.

**Q: When is `Series.map` preferable to `apply`?**
A: For dictionary/Series lookups — remapping codes to labels — `map` is idiomatic and faster (hashmap probe), with unmatched keys becoming `NaN`. Use `apply` when you need extra positional/keyword arguments or a function that returns a Series to expand.

**Q: Give a case where `apply` is genuinely the right tool.**
A: Row logic that combines several columns with branching that doesn't vectorize cleanly, calling a non-vectorized external function per value (e.g. a geocoder or parser), returning multiple derived columns per row, or `groupby(...).apply` for a custom whole-group transform. Even then, check whether `np.select`/`transform`/`agg` fits first.

**Q: How would you rewrite a tiered-discount `apply(axis=1)` to be vectorized?**
A: Build a rate array with `df["tier"].map(rate_dict)` and multiply: `df["amount"] * df["tier"].map(rate_dict)`. For inequality-based tiers, use `np.select([conds], [rates], default)` then multiply. Both run in C and avoid the per-row Python call.

**Q: What replaced `applymap`, and why prefer to avoid cell-wise application?**
A: `DataFrame.map` (pandas 2.1+) replaced `applymap`. Cell-wise application is the slowest pattern — one Python call per cell (rows × columns). Prefer column-vectorized ops or, for formatting/display, the Styler, which formats without changing the underlying data.

**Q: How does `np.where` / `np.select` relate to `apply` for conditional logic?** *(senior)*
A: They vectorize branching. `np.where(cond, a, b)` is a two-branch ternary over arrays; `np.select([c1,c2,...], [v1,v2,...], default)` handles many branches. Both run in C and replace a per-row `apply` with `if/elif` chains, typically an order of magnitude or more faster while producing identical results.

**Q: You must `apply` a heavy numeric function per row and it's too slow. What options remain?** *(senior)*
A: Restructure to operate on whole columns (vectorize); use `np.select`/masks for branching; JIT-compile with `numba` (`@njit` on a function taking NumPy arrays); use `df.values`/`to_numpy()` and hand-write a compiled loop; parallelize with `swifter`/`pandarallel`/Dask; or push the computation to a faster engine (Polars). Vectorization or numba usually wins before parallelism.

**Q: Why can `apply` return an unexpected dtype, and how do you guard against it?** *(senior)*
A: pandas infers the result dtype from the function's returns; heterogeneous or object returns upcast the whole result to `object`, and an empty input may be inferred from a probe call. Guard by returning consistent scalar types, casting explicitly with `.astype`, using `result_type=` for `axis=1` expansions, and preferring typed vectorized ops that keep dtype deterministic.

## 10. Practice

- [ ] Write a `apply(axis=1)` that computes a per-row value, then rewrite it vectorized and `%timeit` both, asserting identical results.
- [ ] Use `Series.map` with a dict to translate status codes to labels and handle unmatched keys with a default.
- [ ] Replace an `if/elif/else` inside `apply` with `np.select` and confirm the outputs match.
- [ ] Demonstrate the difference between `df.apply(f, axis=0)` and `df.apply(f, axis=1)` on the same function.
- [ ] Take an `applymap` cell-formatting call and reproduce it with `DataFrame.map`, then note when a Styler would be preferable.

## 11. Cheat Sheet

> [!TIP]
> **Ladder (fast → slow):** vectorized/`np.where`/`.str`/`.dt` → `Series.map(dict)` → `apply` → `DataFrame.map` (cell-wise).
> **map:** `s.map(dict|func)` element-wise; dict = lookup (miss → NaN).
> **apply:** `df.apply(f, axis=0)` per **column**; `axis=1` per **row** (slow — avoid if array math works). `s.apply(f)` per element.
> **applymap → map:** `df.map(f)` every cell (slowest); deprecated name is `applymap`.
> **Golden rules:** an `apply(axis=1)` you can write as array math should be (10–100×); use `map(dict)` for lookups, `np.select`/`np.where` for branches, `.str`/`.dt` for text/dates; `groupby.agg`/`transform` before `groupby.apply`; always verify with `np.allclose` after rewriting.

**References:** pandas User Guide "Function application", pandas `apply`/`map`/`applymap` API, "Enhancing performance" (pandas docs), Sofia Heisler "No More Sad Pandas" (PyData talk on apply vs vectorization)

---
*NumPy & Pandas Handbook — topic 25.*
