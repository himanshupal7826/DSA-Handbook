# 17 · GroupBy: Split-Apply-Combine

> **In one line:** `groupby` splits rows into buckets by key, applies a function to each bucket, and combines the results back into one object — the analytical workhorse of pandas.

---

## 1. Overview

Almost every analytics question is *"per something"*: revenue **per region**, average latency **per endpoint**, churn **per cohort**. **GroupBy** is the pandas primitive that answers all of them with the same three-step recipe Hadley Wickham named **split-apply-combine**.

You reach for `groupby` whenever you want a metric computed *within* categories rather than over the whole table. It replaces the hand-rolled loop-and-dictionary pattern (`for row: buckets[key].append(...)`) with a single vectorized, C-accelerated call.

The key mental model: `df.groupby('key')` does **not** compute anything yet. It returns a lazy `DataFrameGroupBy` object — a plan describing how rows map to groups. Work only happens when you attach an **apply step** (`.mean()`, `.agg(...)`, `.size()`, `.transform(...)`, `.filter(...)`). What that apply step *returns* determines the shape of the combined result.

## 2. Core Concepts

- **Split** — pandas builds a mapping from each distinct key value to the integer row-positions in that group. This is a hash/sort over the key column(s), not a copy of the data.
- **Apply** — a function runs once per group. Its category: **aggregation** (group → scalar), **transformation** (group → same-length series), or **filtration** (group → boolean keep/drop).
- **Combine** — pandas stitches the per-group outputs together, using the group keys to build the result index.
- **Group keys** — a column name, a list of names (→ MultiIndex result), a Series, an array, a dict/function mapping the index, or `pd.Grouper` (e.g. time buckets).
- **`as_index`** — when `True` (default) the keys become the result index; `as_index=False` keeps them as regular columns (like SQL `GROUP BY`).
- **`dropna`** — by default rows whose key is `NaN` are silently **excluded**. Pass `dropna=False` to keep a `NaN` group.
- **`sort`** — groups are returned sorted by key by default; `sort=False` preserves first-seen order and is faster.
- **`.size()` vs `.count()`** — `size` counts rows per group (includes NaN); `count` counts non-null values per column.
- **Iteration** — a groupby is iterable: `for key, sub_df in gb:` yields each group's sub-DataFrame — useful for debugging, rarely for production (slow).

## 3. Syntax & Examples

```python
import pandas as pd

df = pd.DataFrame({
    "city":   ["NYC", "NYC", "SF", "SF", "SF"],
    "team":   ["A", "B", "A", "A", "B"],
    "age":    [30, 41, 25, 38, 29],
    "salary": [120, 150, 110, 160, 130],
})

# Simplest: one key, one aggregation
df.groupby("city")["salary"].mean()

# Multiple keys -> MultiIndex result
df.groupby(["city", "team"])["salary"].sum()

# Count rows per group
df.groupby("city").size()          # rows per group (Series)
df.groupby("city").count()         # non-null per column (DataFrame)

# Keep keys as columns instead of index (SQL-style)
df.groupby("city", as_index=False)["salary"].mean()

# Several aggregations at once via a dict
df.groupby("city").agg({"salary": "mean", "age": "max"})

# Iterate groups (debugging)
for key, sub in df.groupby("city"):
    print(key, len(sub))
```

## 4. Worked Example

**Question:** average salary and headcount per city, as a flat table.

```python
result = (
    df.groupby("city", as_index=False)
      .agg(avg_salary=("salary", "mean"),
           headcount=("salary", "size"))
)
```

Result:

| city | avg_salary | headcount |
|------|-----------:|----------:|
| NYC  |      135.0 |         2 |
| SF   |    133.33  |         3 |

Now the same split, but grouped by two keys — note the **MultiIndex**:

```python
df.groupby(["city", "team"])["salary"].mean()
```

| city | team | salary |
|------|------|-------:|
| NYC  | A    |  120.0 |
| NYC  | B    |  150.0 |
| SF   | A    |  135.0 |
| SF   | B    |  130.0 |

Call `.reset_index()` on that to flatten the MultiIndex back into columns.

## 5. Under the Hood

`groupby` is lazy. `df.groupby('city')` computes a **groupings object**: it factorizes the key column into integer codes (`NYC→0, SF→1`) and records, for each code, the array of row positions that belong to it. No aggregation runs until you attach an apply step. When you call `.mean()`, pandas dispatches to a **Cython aggregation kernel** that walks each group's positions and reduces in C — far faster than a Python loop.

The *shape* of the output is decided entirely by what the apply step returns per group:

```svg
<svg viewBox="0 0 720 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>

  <!-- input -->
  <text x="70" y="24" text-anchor="middle" fill="#64748b">Input</text>
  <rect x="20" y="34" width="100" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="70" y="58" text-anchor="middle" fill="#1e293b">SF  110</text>
  <text x="70" y="80" text-anchor="middle" fill="#1e293b">NYC 120</text>
  <text x="70" y="102" text-anchor="middle" fill="#1e293b">SF  160</text>
  <text x="70" y="124" text-anchor="middle" fill="#1e293b">NYC 150</text>
  <text x="70" y="146" text-anchor="middle" fill="#1e293b">SF  130</text>
  <text x="70" y="170" text-anchor="middle" fill="#64748b">key = city</text>

  <text x="200" y="24" text-anchor="middle" fill="#2563eb" font-weight="bold">SPLIT</text>
  <line x1="120" y1="90" x2="260" y2="70" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="120" y1="130" x2="260" y2="200" stroke="#475569" marker-end="url(#arr)"/>

  <!-- groups -->
  <rect x="265" y="40" width="120" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="325" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">NYC</text>
  <text x="325" y="80" text-anchor="middle" fill="#1e293b">120</text>
  <text x="325" y="98" text-anchor="middle" fill="#1e293b">150</text>

  <rect x="265" y="170" width="120" height="88" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="325" y="190" text-anchor="middle" fill="#1e293b" font-weight="bold">SF</text>
  <text x="325" y="210" text-anchor="middle" fill="#1e293b">110</text>
  <text x="325" y="228" text-anchor="middle" fill="#1e293b">160</text>
  <text x="325" y="246" text-anchor="middle" fill="#1e293b">130</text>

  <text x="455" y="24" text-anchor="middle" fill="#2563eb" font-weight="bold">APPLY</text>
  <text x="455" y="150" text-anchor="middle" fill="#64748b">mean()</text>
  <line x1="385" y1="75" x2="520" y2="75" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="385" y1="214" x2="520" y2="214" stroke="#475569" marker-end="url(#arr)"/>

  <!-- reduced -->
  <rect x="522" y="55" width="80" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="562" y="80" text-anchor="middle" fill="#1e293b">135.0</text>
  <rect x="522" y="194" width="80" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="562" y="219" text-anchor="middle" fill="#1e293b">133.3</text>

  <text x="670" y="24" text-anchor="middle" fill="#2563eb" font-weight="bold">COMBINE</text>
  <line x1="602" y1="75" x2="640" y2="120" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="602" y1="214" x2="640" y2="170" stroke="#475569" marker-end="url(#arr)"/>
  <rect x="620" y="110" width="90" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="665" y="132" text-anchor="middle" fill="#1e293b">NYC 135.0</text>
  <text x="665" y="154" text-anchor="middle" fill="#1e293b">SF  133.3</text>
  <text x="665" y="174" text-anchor="middle" fill="#64748b">result</text>
</svg>
```

For built-in reducers (`mean`, `sum`, `min`, `max`, `count`, `std`, `first`, `last`) pandas uses hand-written Cython kernels. For anything passed as a Python callable via `.apply()`, it falls back to running Python per group — correct but often 10–100× slower.

## 6. Variations & Trade-offs

| Apply step | Returns per group | Result shape | Example |
|------------|-------------------|--------------|---------|
| `.agg('mean')` | scalar | one row / group | totals, averages |
| `.agg(['mean','max'])` | several scalars | one row / group, MultiIndex cols | multi-metric summary |
| `.transform('mean')` | Series (group length) | **same shape as input** | group z-score, % of group |
| `.filter(func)` | bool | subset of original rows | drop small groups |
| `.apply(func)` | anything | depends | escape hatch, slow |
| `.size()` | scalar count | Series | headcount incl. NaN |

**Trade-off:** `agg`/`transform` with string kernels are fast and predictable. `apply` is the flexible escape hatch but pays the Python-per-group tax and has surprising shape semantics — prefer it last. See sibling topic **agg, transform & filter** for the deep dive.

## 7. Production / Performance Notes

- **Prefer built-in string aggregations** (`'mean'`, `'sum'`) over lambdas — they hit Cython kernels; a lambda forces the slow Python path.
- **`observed=True`** for categorical keys: without it, groupby materializes the full Cartesian product of *all* categories (even empty ones), which can explode memory on high-cardinality categoricals.
- **`sort=False`** skips sorting the group keys — a free speedup when you don't need ordered output.
- **`as_index=False`** (or a trailing `.reset_index()`) keeps downstream merges/joins simple by leaving keys as columns.
- On very large data, a single `groupby().agg({...})` with several columns beats multiple separate groupbys — one split, many reductions.
- Watch memory: `groupby().apply()` that returns DataFrames can concatenate large intermediates. For huge data consider Dask/Polars or a database.

## 8. Common Mistakes

1. ⚠️ **Confusing `agg` with `transform`.** `agg` collapses to one row per group; `transform` broadcasts back to the original shape. Assigning an `agg` result to a column raises or misaligns. → Use `transform` when you need per-row output.
2. ⚠️ **Forgetting `reset_index()`.** You get a grouped/MultiIndex result and later merges break. → `reset_index()` or `as_index=False`.
3. ⚠️ **Silently dropped NaN keys.** Rows with a null group key vanish by default. → Pass `dropna=False` if those rows matter.
4. ⚠️ **Using `.count()` when you meant `.size()`.** `count` is per-column non-null; `size` is total rows per group. → Pick deliberately.
5. ⚠️ **Slow `apply(lambda)`.** Running Python per group on millions of rows. → Replace with a string agg or `transform`.
6. ⚠️ **Chained assignment on a group.** Mutating `sub_df` from iteration doesn't write back to the original. → Build a result and reassign.
7. ⚠️ **Categorical key blow-up.** Grouping a categorical without `observed=True` produces empty groups for unused categories.

## 9. Interview Questions

**Q: Explain the split-apply-combine model.**
A: Split the rows into groups by one or more keys, apply a function independently to each group, then combine the per-group outputs into a single result indexed by the keys. It generalizes SQL's GROUP BY and is the mental model behind every pandas `groupby`.

**Q: Is `df.groupby('col')` doing any computation?**
A: No. It's lazy — it returns a `GroupBy` object that only records how rows map to groups (factorized keys + row positions). Aggregation runs only when you attach an apply step like `.mean()` or `.agg(...)`.

**Q: What's the difference between `.size()` and `.count()`?**
A: `.size()` returns the number of rows per group (a single Series, includes NaNs). `.count()` returns the number of non-null values per group **per column** (a DataFrame). If a column has nulls, its count is lower than size.

**Q: What does `as_index=False` do and when do you want it?**
A: It keeps the group keys as regular columns instead of promoting them to the result index — matching SQL GROUP BY output. You want it when the result feeds a later merge, plot, or export where an index would be awkward.

**Q: Why are rows with a NaN key missing from my groupby output?**
A: `groupby` defaults to `dropna=True`, excluding rows whose key is null. Pass `dropna=False` to keep a dedicated NaN group.

**Q: How do you group by a computed value that isn't a column, e.g. year from a timestamp?**
A: Pass a Series/array/function/`pd.Grouper`. E.g. `df.groupby(df['ts'].dt.year)` or `df.groupby(pd.Grouper(key='ts', freq='M'))`. The grouper doesn't have to be an existing column.

**Q: (Senior) Why is `groupby().apply(lambda)` often slow, and how do you fix it?**
A: `apply` runs a Python callable once per group, bypassing the vectorized Cython kernels used by string aggregations, so you pay Python interpreter overhead per group. Fix by replacing the lambda with a built-in aggregation string, splitting into `agg`+`transform`, or vectorizing across the whole frame.

**Q: (Senior) What is `observed=True` and why does it matter for categoricals?**
A: When grouping by a Categorical dtype, pandas by default emits a group for every *possible* category (the full Cartesian product across multiple keys), including empty ones — which can explode result size and memory. `observed=True` restricts output to category combinations actually present.

**Q: (Senior) You group by two keys and get a MultiIndex — how do you get a flat table with the keys as columns and one aggregation per input column?**
A: Use `df.groupby(['k1','k2'], as_index=False).agg(out=('col','mean'))`, or call `.reset_index()` on a MultiIndex result. Named aggregation gives clean, flat column names.

**Q: How would you compute each row's value as a fraction of its group total?**
A: `df['pct'] = df['x'] / df.groupby('key')['x'].transform('sum')`. `transform` broadcasts the group sum back to every original row, so the division aligns element-wise.

**Q: Does `groupby` preserve row order within a group?**
A: Yes — within each group original row order is preserved; only the *group keys* are sorted (unless `sort=False`). Don't rely on cross-group order without an explicit sort.

## 10. Practice

- [ ] Compute average salary and headcount per city as a flat table using named aggregation and `as_index=False`.
- [ ] Group by two keys and produce a MultiIndex sum, then flatten it with `reset_index()`.
- [ ] Reproduce a groupby-mean manually by iterating groups, then confirm it matches the vectorized `.mean()`.
- [ ] Group a DataFrame with some NaN keys twice — with and without `dropna=False` — and explain the row-count difference.
- [ ] Time `groupby().apply(lambda x: x['v'].mean())` vs `groupby()['v'].mean()` on 1M rows.

## 11. Cheat Sheet

> [!TIP]
> **GroupBy = split → apply → combine.** `df.groupby(keys)` is *lazy* — it only maps rows to groups. The apply step sets the output shape: **agg** (→ one row/group), **transform** (→ same shape as input), **filter** (→ subset of rows). Use `.size()` for row counts (incl. NaN), `.count()` for per-column non-null. `as_index=False` keeps keys as columns; `dropna=False` keeps NaN keys; `observed=True` for categoricals; `sort=False` for speed. Prefer string aggregations over lambdas — they hit fast Cython kernels. Flatten MultiIndex results with `reset_index()`.

**References:** pandas User Guide — Group by, pandas API `DataFrame.groupby`, Wickham "The Split-Apply-Combine Strategy for Data Analysis"

---

*NumPy & Pandas Handbook — topic 17.*
