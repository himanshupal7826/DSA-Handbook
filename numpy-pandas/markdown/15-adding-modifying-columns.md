# 15 · Creating & Modifying Columns

> **In one line:** Build new columns from old ones with vectorized expressions and `assign()` — and always write to the *original* frame so `SettingWithCopyWarning` never bites.

---

## 1. Overview

Feature engineering is column engineering. Ninety percent of the transformations in a real pipeline are *"add a column that is some function of the columns I already have"* — a ratio, a flag, a bucket, a parsed field. Pandas makes this cheap because a DataFrame is a dict of aligned, typed columns (`Series`), and creating a derived column is one **vectorized** expression over whole arrays, not a Python loop over rows.

You reach for these tools constantly: `df["x"] = ...` for a quick in-place add, `df.assign(x=...)` when you want to stay inside a **method chain** without mutating the input, and `df.eval("x = a + b")` when you want a terse, memory-lean expression over many columns.

The one trap that snares every beginner lives here too: the **`SettingWithCopyWarning`**. It appears when you try to write a column *through* a slice whose provenance pandas can't guarantee — the write may land on a throwaway copy and silently vanish. Understanding why it fires (and the one-line fix) is the difference between a pipeline that works and one that "sometimes doesn't update."

## 2. Core Concepts

- **A column is a Series** — aligned to the DataFrame's index and homogeneously typed. Assigning a scalar broadcasts it to every row; assigning a Series aligns on the index.
- **Vectorized ops** — arithmetic, comparison, and NumPy ufuncs run in C over the whole array. `df["a"] + df["b"]` is one call, ~100× faster than iterating rows.
- **`df["new"] = expr`** — mutates the frame in place, adds the column at the end (or overwrites if it exists).
- **`assign(new=...)`** — returns a **new** DataFrame with the column added; the original is untouched. Chain-friendly and side-effect-free.
- **Callable in `assign`** — `df.assign(x=lambda d: d.a / d.b)` sees the frame *as it exists so far in the chain*, so you can reference just-created columns.
- **Conditional columns** — `np.where(cond, a, b)` for two-way, `np.select([...],[...])` or `pd.cut`/`map` for many-way.
- **`eval()`** — evaluates a string expression across columns; can create columns via `"col = ..."`. Uses `numexpr` to avoid intermediate temporaries on large frames.
- **Alignment on assignment** — when you assign a Series, pandas matches on **index label**, not position; non-matching labels become `NaN`.
- **`SettingWithCopyWarning`** — a heuristic warning that a write targeted an object which *might* be a view onto another frame; the write may not propagate.
- **Copy-on-Write (CoW)** — pandas 2.0+ opt-in (default in 3.0) that makes every indexing result behave predictably; it removes the ambiguity that causes the warning.

## 3. Syntax & Examples

```python
import numpy as np
import pandas as pd

df = pd.DataFrame({
    "product": ["A", "B", "C", "D"],
    "price":   [100, 250, 90, 400],
    "cost":    [60, 150, 70, 210],
    "units":   [12, 5, 30, 3],
})

# 1) In-place add — derived, vectorized
df["revenue"] = df["price"] * df["units"]
df["margin"]  = (df["price"] - df["cost"]) / df["price"]

# 2) Conditional column (two-way)
df["tier"] = np.where(df["price"] >= 200, "premium", "standard")

# 3) Many-way conditional
df["band"] = pd.cut(df["price"], [0, 100, 300, np.inf],
                    labels=["low", "mid", "high"])

# 4) assign() — no mutation, chain-friendly, can self-reference
out = (df
       .assign(profit=lambda d: d["revenue"] - d["cost"] * d["units"],
               profit_per_unit=lambda d: d["profit"] / d["units"])
       .sort_values("profit", ascending=False))

# 5) eval() — terse, low-memory expression
df.eval("gross = price * units", inplace=True)

# 6) Multiple columns at once
df[["a", "b"]] = 0                      # broadcast scalar to two new cols
df[["x", "y"]] = df[["price", "cost"]]  # copy values
```

## 4. Worked Example

An orders table: compute total, apply a tiered discount, flag high-value rows, and derive a clean unit price — all without mutating the raw input.

```python
raw = pd.DataFrame({
    "order_id": [1, 2, 3, 4, 5],
    "qty":      [3, 1, 10, 2, 6],
    "unit":     [19.99, 149.0, 4.50, 89.0, 12.0],
    "coupon":   ["SAVE10", None, "SAVE10", None, "VIP20"],
})

discount = {"SAVE10": 0.10, "VIP20": 0.20}

orders = (raw
    .assign(
        gross       = lambda d: d["qty"] * d["unit"],
        disc_rate   = lambda d: d["coupon"].map(discount).fillna(0.0),
        net         = lambda d: d["gross"] * (1 - d["disc_rate"]),
        high_value  = lambda d: d["net"] >= 100,
        segment     = lambda d: np.select(
            [d["net"] >= 100, d["net"] >= 30],
            ["A", "B"], default="C"),
    )
    .round({"gross": 2, "net": 2}))
```

Result:

| order_id | qty | unit | coupon | gross | disc_rate | net | high_value | segment |
|---|---|---|---|---|---|---|---|---|
| 1 | 3 | 19.99 | SAVE10 | 59.97 | 0.10 | 53.97 | False | B |
| 2 | 1 | 149.00 | None | 149.00 | 0.00 | 149.00 | True | A |
| 3 | 10 | 4.50 | SAVE10 | 45.00 | 0.10 | 40.50 | False | B |
| 4 | 2 | 89.00 | None | 178.00 | 0.00 | 178.00 | True | A |
| 5 | 6 | 12.00 | VIP20 | 72.00 | 0.20 | 57.60 | False | B |

`raw` is unchanged — every derivation happened in the chain, so the transformation is reproducible and safe to re-run.

## 5. Under the Hood

Two things matter: **why vectorized assignment is fast**, and **why the copy trap exists**.

A column lives as a contiguous typed NumPy block. `df["a"] * df["b"]` dispatches to a C loop that walks both buffers once — no per-row Python object boxing. `assign` builds a shallow-copied frame and drops the new block in; the underlying arrays of untouched columns are shared, so it is cheap.

The trap: **indexing can return a *view* or a *copy*, and pandas often can't tell which until runtime.** When you do `sub = df[df.price > 100]` and then `sub["x"] = 1`, pandas warns because the write might have hit a temporary. Under **Copy-on-Write** (default in pandas 3.0), every such result is logically independent, and a write triggers a lazy copy of just that block — the ambiguity disappears.

```svg
<svg viewBox="0 0 640 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Chained assignment: the copy trap</text>

  <!-- DANGER path -->
  <rect x="20" y="50" width="290" height="180" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="165" y="72" text-anchor="middle" fill="#b91c1c" font-weight="bold">df[mask]["col"] = v   ⚠️</text>
  <rect x="45" y="90" width="110" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="100" y="115" text-anchor="middle" fill="#1e293b">df[mask]</text>
  <text x="180" y="115" text-anchor="middle" fill="#64748b">→ maybe copy</text>
  <line x1="100" y1="130" x2="100" y2="165" stroke="#475569" marker-end="url(#ah)"/>
  <rect x="45" y="168" width="230" height="40" rx="8" fill="#fdecec" stroke="#b91c1c"/>
  <text x="160" y="193" text-anchor="middle" fill="#b91c1c">write lands on temp — lost</text>

  <!-- SAFE path -->
  <rect x="330" y="50" width="290" height="180" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="475" y="72" text-anchor="middle" fill="#059669" font-weight="bold">df.loc[mask, "col"] = v   ✓</text>
  <rect x="355" y="90" width="240" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="475" y="115" text-anchor="middle" fill="#1e293b">single .loc indexer</text>
  <line x1="475" y1="130" x2="475" y2="165" stroke="#475569" marker-end="url(#ah)"/>
  <rect x="355" y="168" width="240" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="475" y="193" text-anchor="middle" fill="#1e293b">writes into original frame</text>
</svg>
```

## 6. Variations & Trade-offs

| Method | Mutates input? | Chainable | Self-reference | Best for |
|---|---|---|---|---|
| `df["x"] = expr` | Yes | No | N/A | Quick single add in a script |
| `df.assign(x=...)` | No | Yes | Yes (via lambda) | Pipelines; reproducibility |
| `df.eval("x = ...")` | Optional | Partly | Yes | Many-column math on large frames |
| `df.loc[mask, "x"] = v` | Yes | No | N/A | Conditional/subset writes (safe) |
| `df.insert(i, "x", v)` | Yes | No | N/A | Placing a column at a position |

`assign` costs a shallow copy per call — negligible for wide-but-not-huge frames, but in a hot loop prefer a single in-place assignment. `eval` shines when an expression has many terms on a large frame: `numexpr` fuses the operation and avoids materializing every intermediate array, cutting memory and cache misses.

## 7. Production / Performance Notes

- **Never iterate rows to build a column.** `df.apply(f, axis=1)` and `for _, row in df.iterrows()` are 50–500× slower than a vectorized expression. Reach for `np.where`, `np.select`, `.map`, or arithmetic first.
- **`assign` for pipelines.** Side-effect-free steps compose, are testable, and re-run cleanly — critical in scheduled jobs where a cell may execute twice.
- **`eval`/`query` on big frames** (millions of rows, several terms) can be 2–4× faster and lower-memory than the equivalent Python expression thanks to `numexpr`.
- **Turn on Copy-on-Write** (`pd.set_option("mode.copy_on_write", True)`) on pandas 2.x to kill the warning class entirely and get view/copy semantics that never surprise you. It is the default from pandas 3.0.
- **Downcast derived columns** when appropriate — a boolean flag as `bool` (1 byte) beats an object column; a bounded category as `category`.
- **Assign aligns on index.** When merging a computed Series back, make sure its index matches, or you will silently get `NaN`s.

## 8. Common Mistakes

1. ⚠️ **Chained assignment** `df[df.a > 0]["b"] = 1` — writes to a temporary, original unchanged, warning fires. **Fix:** `df.loc[df.a > 0, "b"] = 1` (one indexer).
2. ⚠️ **Writing to a slice you took earlier** `sub = df[cols]; sub["x"] = ...` triggers the warning. **Fix:** `sub = df[cols].copy()` if you want an independent frame, or write back via `df.loc`.
3. ⚠️ **Row-wise `apply` for simple math.** **Fix:** use column arithmetic / `np.where`; reserve `apply(axis=1)` for genuinely non-vectorizable logic.
4. ⚠️ **Index-misaligned assignment** — assigning a Series with a different index yields `NaN`. **Fix:** align first (`.reset_index(drop=True)` or `.values` when position-based is intended).
5. ⚠️ **`np.where` for many branches** produces unreadable nesting. **Fix:** `np.select([...], [...], default=...)` or `pd.cut`/`map`.
6. ⚠️ **`eval` with Python-only functions** — `eval` supports a limited grammar; complex calls fail. **Fix:** fall back to `assign(lambda ...)`.
7. ⚠️ **Assuming `assign` mutates** — forgetting to capture its return value silently drops the new column. **Fix:** `df = df.assign(...)` or chain it.

## 9. Interview Questions

**Q: What causes a `SettingWithCopyWarning` and how do you fix it?**
A: It fires when you write to an object that pandas suspects is a view/copy of another frame — classically chained indexing like `df[mask]["col"] = v`, where `df[mask]` may return a temporary so the write can silently no-op. Fix by using a single indexer: `df.loc[mask, "col"] = v`. If you genuinely want a separate frame, take an explicit `.copy()`. Enabling Copy-on-Write removes the ambiguity entirely.

**Q: What's the difference between `df["x"] = ...` and `df.assign(x=...)`?**
A: The bracket form mutates the frame in place and returns nothing; `assign` returns a new frame and leaves the original untouched, making it safe inside method chains. `assign` also accepts a callable that sees the frame as-built-so-far, letting you reference just-created columns.

**Q: Why is `df.apply(func, axis=1)` usually a bad way to create a column?**
A: It runs a Python function once per row, boxing each row into a Series — that defeats vectorization and is often 50–500× slower. Prefer array arithmetic, `np.where`, `np.select`, or `.map`, which execute in C over whole columns.

**Q: How does assignment alignment work when you assign a Series to a column?**
A: Pandas aligns on the **index label**, not position. Values whose labels exist in the target are placed; labels present only in the target become `NaN`; labels only in the source are dropped. To assign by position, use `.values` or reset both indices.

**Q: When would you use `eval()` over plain column arithmetic?**
A: On large frames with multi-term expressions. `eval` uses `numexpr` to fuse operations and avoid materializing every intermediate array, reducing memory traffic and cache misses — often 2–4× faster. For small frames the overhead isn't worth it.

**Q: How do you build a column with more than two conditional outcomes?**
A: `np.select(condlist, choicelist, default=...)` for arbitrary boolean conditions, `pd.cut`/`pd.qcut` for numeric binning, or `Series.map(dict)` for lookups. Nested `np.where` works but reads poorly beyond two branches.

**Q: (Senior) What does Copy-on-Write change about column assignment?**
A: Under CoW every indexing result is a logically independent object; a mutation triggers a lazy copy of only the affected block. That eliminates the view/copy ambiguity, so `SettingWithCopyWarning` never fires and chained-assignment bugs become impossible — writes either clearly hit the object you named or clearly don't propagate. It's the default from pandas 3.0.

**Q: (Senior) Why can `assign` be a memory concern in a long chain, and how do you mitigate it?**
A: Each `assign` returns a shallow-copied frame; the copy shares untouched column buffers, but adding many columns across many steps still allocates new blocks and index objects. On very wide/large frames, batch related derivations into a single `assign` call, drop intermediate columns you no longer need, and consider `eval` to avoid temporaries.

**Q: (Senior) You assign `df.loc[mask, "new"] = series` and get all NaN. Why?**
A: `loc` aligns the right-hand Series by index label against the masked rows. If `series` has a different index (e.g., a fresh 0..n range) none of the labels match the selected rows, so every value is `NaN`. Align the indices, or assign a positional array (`series.values`) when you intend position-based placement.

## 10. Practice

- [ ] Given a sales frame, add `revenue`, `margin`, and a `tier` (`premium`/`standard`) column in a single `assign` chain without mutating the input.
- [ ] Reproduce a `SettingWithCopyWarning` with chained indexing, then rewrite it two ways: with `.loc` and with an explicit `.copy()`.
- [ ] Create a 4-way `segment` column using `np.select`, then rebuild the same logic with `pd.cut` and compare.
- [ ] Use `eval` to add three derived columns to a 1M-row frame and time it against the equivalent Python expression.
- [ ] Assign a Series with a shuffled index to a column and explain the resulting `NaN` pattern.

## 11. Cheat Sheet

> [!TIP]
> **Add/modify columns**
> - In place: `df["x"] = df["a"] * df["b"]` · chain-safe: `df.assign(x=lambda d: d.a * d.b)`
> - Two-way flag: `np.where(cond, a, b)` · many-way: `np.select([...],[...],default=...)` · bins: `pd.cut`
> - Big multi-term math: `df.eval("x = a + b - c")`
> - **Conditional subset write:** `df.loc[mask, "col"] = v` (ONE indexer — never `df[mask]["col"]=`)
> - Warning fix: single `.loc`, or take a `.copy()`, or enable Copy-on-Write.
> - Assignment aligns on **index label**; assign `.values` for positional.
> - Avoid `apply(axis=1)` for math — vectorize.

**References:** pandas User Guide — "Indexing and selecting data" & "Copy-on-Write"; pandas API docs (`DataFrame.assign`, `DataFrame.eval`); NumPy `where`/`select` docs

---
*NumPy & Pandas Handbook — topic 15.*
