# 20 · Reshaping: pivot, pivot_table & stack

> **In one line:** Turn long rows into a wide grid (and back) with pivot/pivot_table, and move labels between axes with stack/unstack.

---

## 1. Overview

Analytical data arrives in two shapes. **Long** (aka *tidy*) form has one observation per row with key columns identifying it — great for storage, filtering, and groupby. **Wide** form spreads one categorical key across columns to form a matrix — great for reading, comparing, and feeding into heatmaps or spreadsheets. Reshaping is the act of rotating data between these two layouts without changing the underlying facts.

Pandas gives you four core tools. **`pivot`** is a pure reshape: it needs the (index, column) pair to be unique and does no aggregation. **`pivot_table`** is pivot plus a groupby — it accepts an `aggfunc` and collapses duplicates, so it never raises on repeated keys. **`stack`/`unstack`** rotate the *innermost* index level to/from the columns, operating on a MultiIndex. **`crosstab`** is a convenience wrapper over `pivot_table` for frequency/contingency tables.

You reach for these when a report needs a category-by-category grid, when a model wants one feature per column, or when a groupby produced a MultiIndex you want laid flat. The mental model: **pivot moves a column's *values* into new column *headers*; stack/unstack move index *levels* between the row and column axes.**

## 2. Core Concepts

- **Long ↔ wide** — the two canonical shapes; reshaping rotates between them losslessly.
- **`pivot(index, columns, values)`** — pure reshape; **raises `ValueError`** if (index, columns) pairs are not unique.
- **`pivot_table(index, columns, values, aggfunc)`** — pivot + groupby; default `aggfunc='mean'`; safely aggregates duplicates.
- **`margins=True`** — adds an "All" row/column with row/column totals (subtotals).
- **`fill_value`** — replaces the `NaN`s that appear where a combination has no data.
- **`stack()`** — pivots the innermost *column* level down into a new innermost *row* level → taller, narrower.
- **`unstack(level)`** — pivots an *index* level up into columns → shorter, wider (inverse of stack).
- **MultiIndex** — hierarchical axis labels; stack/unstack add or remove levels here.
- **`crosstab(index, columns)`** — frequency table by default; add `values`+`aggfunc` for aggregated cross-tabs; `normalize=` for proportions.
- **Dropna** — `stack` drops all-NaN rows by default; `unstack` introduces NaN for missing combinations.

## 3. Syntax & Examples

```python
import pandas as pd

df = pd.DataFrame({
    "date":    ["2026-01", "2026-01", "2026-02", "2026-02"],
    "product": ["A", "B", "A", "B"],
    "region":  ["EU", "EU", "US", "US"],
    "sales":   [100, 200, 150, 250],
})
```

**pivot — pure reshape (keys must be unique):**

```python
df.pivot(index="date", columns="product", values="sales")
```

**pivot_table — aggregates duplicates, adds totals:**

```python
df.pivot_table(
    index="date", columns="product", values="sales",
    aggfunc="sum", margins=True, fill_value=0,
)
```

**Multiple aggregations at once:**

```python
df.pivot_table(index="region", values="sales",
               aggfunc=["sum", "mean", "count"])
```

**stack / unstack on a MultiIndex:**

```python
wide = df.pivot_table(index="date", columns="product", values="sales", aggfunc="sum")
long_again = wide.stack()          # columns 'product' → row level
back_to_wide = long_again.unstack()  # inverse
```

**crosstab — contingency / frequency:**

```python
pd.crosstab(df["region"], df["product"])                     # counts
pd.crosstab(df["region"], df["product"],
            values=df["sales"], aggfunc="sum", margins=True)  # aggregated
```

## 4. Worked Example

A sales log with **duplicate** (date, product) pairs — `pivot` would fail, so we use `pivot_table`.

```python
import pandas as pd

df = pd.DataFrame({
    "date":    ["2026-01","2026-01","2026-01","2026-02","2026-02"],
    "product": ["A","A","B","A","B"],
    "sales":   [100, 40, 200, 150, 250],
})

report = df.pivot_table(
    index="date", columns="product", values="sales",
    aggfunc="sum", margins=True, fill_value=0,
)
print(report)
```

**Result** — note January's product A summed 100+40=140, and the `All` margins:

| date | A | B | All |
|------|---|---|-----|
| 2026-01 | 140 | 200 | 340 |
| 2026-02 | 150 | 250 | 400 |
| **All** | 290 | 450 | 740 |

Now rotate it back to long form for storage:

```python
tidy = (report.drop(index="All", columns="All")
              .stack()
              .rename("sales")
              .reset_index())
```

| date | product | sales |
|------|---------|-------|
| 2026-01 | A | 140 |
| 2026-01 | B | 200 |
| 2026-02 | A | 150 |
| 2026-02 | B | 250 |

## 5. Under the Hood

`pivot` is implemented as a **`set_index` + `unstack`**: it builds a MultiIndex from `[index, columns]`, then unstacks the `columns` level up into the column axis. That's why non-unique pairs error — unstacking a duplicated index label is ambiguous. `pivot_table` first runs a **groupby** on `[index, columns]` with your `aggfunc` to guarantee uniqueness, *then* unstacks. So `pivot_table` = groupby-aggregate + reshape; `pivot` = reshape only.

`stack`/`unstack` are the primitive axis-rotation operations. `unstack` takes labels from a chosen *row* level and turns them into the innermost *column* level; `stack` does the reverse. Missing combinations become `NaN` on unstack (the grid must be rectangular); all-NaN rows are dropped on stack.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- LONG table -->
  <text x="130" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">LONG (tidy)</text>
  <rect x="30" y="36" width="200" height="230" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="130" y="60" text-anchor="middle" fill="#64748b">date · product · sales</text>
  <line x1="46" y1="72" x2="214" y2="72" stroke="#475569"/>
  <text x="130" y="94" text-anchor="middle" fill="#1e293b">2026-01 · A · 140</text>
  <text x="130" y="120" text-anchor="middle" fill="#1e293b">2026-01 · B · 200</text>
  <text x="130" y="146" text-anchor="middle" fill="#1e293b">2026-02 · A · 150</text>
  <text x="130" y="172" text-anchor="middle" fill="#1e293b">2026-02 · B · 250</text>
  <text x="130" y="210" text-anchor="middle" fill="#64748b">one row per</text>
  <text x="130" y="228" text-anchor="middle" fill="#64748b">observation</text>

  <!-- arrows -->
  <line x1="240" y1="120" x2="470" y2="120" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <text x="355" y="110" text-anchor="middle" fill="#059669" font-weight="700">pivot / unstack →</text>
  <line x1="470" y1="180" x2="240" y2="180" stroke="#475569" stroke-width="1.5" marker-end="url(#ah)"/>
  <text x="355" y="200" text-anchor="middle" fill="#d97706" font-weight="700">← melt / stack</text>

  <!-- WIDE table -->
  <text x="590" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">WIDE (grid)</text>
  <rect x="480" y="36" width="220" height="160" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="590" y="60" text-anchor="middle" fill="#64748b">date × product</text>
  <line x1="496" y1="72" x2="684" y2="72" stroke="#475569"/>
  <text x="530" y="94"  text-anchor="middle" fill="#64748b">·</text>
  <text x="570" y="94"  text-anchor="middle" fill="#1e293b" font-weight="600">A</text>
  <text x="640" y="94"  text-anchor="middle" fill="#1e293b" font-weight="600">B</text>
  <text x="520" y="122" text-anchor="middle" fill="#64748b">2026-01</text>
  <text x="570" y="122" text-anchor="middle" fill="#1e293b">140</text>
  <text x="640" y="122" text-anchor="middle" fill="#1e293b">200</text>
  <text x="520" y="150" text-anchor="middle" fill="#64748b">2026-02</text>
  <text x="570" y="150" text-anchor="middle" fill="#1e293b">150</text>
  <text x="640" y="150" text-anchor="middle" fill="#1e293b">250</text>
  <text x="590" y="182" text-anchor="middle" fill="#64748b">values → headers</text>
</svg>
```

## 6. Variations & Trade-offs

| Tool | Aggregates? | Duplicate keys | Typical use |
|------|-------------|----------------|-------------|
| `pivot` | No | **Raises ValueError** | Already-unique keys; fast pure reshape |
| `pivot_table` | Yes (`aggfunc`) | Collapses via aggfunc | Reports, subtotals (`margins`), messy data |
| `stack` | No | n/a | Wide → long; flatten a column MultiIndex |
| `unstack` | No | n/a | Long → wide; spread an index level |
| `crosstab` | Yes (default count) | Collapses | Frequency / contingency tables, `normalize` |
| `groupby().unstack()` | Yes | Collapses | Manual control over the agg then reshape |

`pivot_table` is the safe default because it never errors on duplicates and supports `margins`, `fill_value`, and multiple `aggfunc`s. Use bare `pivot` only when you *know* keys are unique and want the speed. `crosstab` is just `pivot_table` with friendlier defaults for counting. `stack`/`unstack` are lower-level and shine when you already have a MultiIndex from a groupby.

## 7. Production / Performance Notes

- **`pivot_table` is a groupby underneath** — cost scales with the number of groups, not just rows. For very high-cardinality columns you'll get a wide, sparse, memory-heavy frame; prefer keeping data long.
- **`observed=True`** on categorical keys avoids materializing the full Cartesian product of unused category combinations (a classic memory blowup).
- **`fill_value=0`** turns the sparse `NaN` grid dense — good for math, but check it doesn't distort means (`mean` skips NaN but counts zeros).
- **Flatten MultiIndex columns** from multi-aggfunc pivots before export: `df.columns = ['_'.join(c) for c in df.columns]`.
- For simple counts, `crosstab(..., normalize='index')` gives row-proportions in one call — cleaner than manual division.
- Reshaping is **not** a substitute for a database `GROUP BY` at scale; pivot in-memory only what fits comfortably in RAM.

## 8. Common Mistakes

1. ⚠️ Using `pivot` on data with duplicate (index, columns) pairs → `ValueError`. **Fix:** use `pivot_table` with an `aggfunc`, or dedupe first.
2. ⚠️ Forgetting `aggfunc` and being surprised by averaged values. **Fix:** `pivot_table` defaults to `mean`; set `aggfunc='sum'`/`'count'` explicitly.
3. ⚠️ Leaving `NaN` holes in the grid and breaking downstream math. **Fix:** pass `fill_value=0` (or impute deliberately).
4. ⚠️ Confusing `stack` (columns → rows) with `unstack` (rows → columns). **Fix:** remember *un*stack makes it *wider*.
5. ⚠️ Exporting a pivot with a MultiIndex column and getting ugly headers. **Fix:** flatten with a join before `to_csv`.
6. ⚠️ Including `margins=True` then doing math over the `All` row/column by accident. **Fix:** drop `All` before further aggregation.
7. ⚠️ Categorical keys silently exploding to a huge grid. **Fix:** set `observed=True`.

## 9. Interview Questions

**Q: What is the difference between `pivot` and `pivot_table`?**
A: `pivot` is a pure reshape and requires each (index, columns) pair to be unique — it raises otherwise. `pivot_table` first groups and aggregates with an `aggfunc`, so it tolerates duplicates and also supports `margins`, `fill_value`, and multiple aggregations.

**Q: Explain long vs wide (tidy) data and why reshaping matters.**
A: Long form has one observation per row with identifier columns — ideal for filtering, groupby, and storage. Wide form spreads a category across columns into a matrix — ideal for reading and plotting. Reshaping rotates between them losslessly so each stage of a pipeline gets the shape it wants.

**Q: What do `stack` and `unstack` do exactly?**
A: `unstack` moves an innermost *row* index level up into the *column* axis (long → wide); `stack` moves the innermost *column* level down into the *row* index (wide → long). They are inverses and operate on a MultiIndex.

**Q: How do you add row and column totals to a pivot?**
A: Pass `margins=True` (optionally `margins_name='Total'`); pandas appends an "All" row and column computed with the same `aggfunc`.

**Q: When would you use `crosstab` over `pivot_table`?**
A: `crosstab` is a thin wrapper for frequency/contingency tables — it counts by default and offers `normalize=` for proportions. Use it for quick counts of two categoricals; both are equivalent for aggregated cross-tabs.

**Q: Why does `pivot` raise "Index contains duplicate entries"?**
A: Because it reshapes by unstacking a MultiIndex built from (index, columns); duplicate pairs make the unstack ambiguous. Aggregate them first (use `pivot_table`) or ensure uniqueness.

**Q: (Senior) How is `pivot_table` implemented under the hood, and what's the cost model?**
A: It is a `groupby([index, columns]).aggfunc()` followed by an `unstack`. Cost scales with the number of distinct groups; high-cardinality columns produce wide, sparse frames and can blow up memory — mitigate with `observed=True` and by keeping data long.

**Q: (Senior) Your pivot on categorical keys uses huge memory even though most cells are empty — why, and how do you fix it?**
A: By default groupby materializes every combination of category levels, including unused ones. Set `observed=True` so only observed combinations are computed, avoiding the full Cartesian product.

**Q: (Senior) After a multi-aggfunc `pivot_table` you have a MultiIndex on columns — how do you make it export-friendly?**
A: Flatten it: `df.columns = ['_'.join(map(str, c)).strip('_') for c in df.columns]`, then `reset_index()` so the row index becomes a column before `to_csv`.

**Q: How do you go from a groupby result straight to a wide grid?**
A: `df.groupby([a, b])[val].sum().unstack(b)` — group and aggregate, then unstack the second key into columns. This gives explicit control over the aggregation before reshaping.

## 10. Practice

- [ ] Given a sales log with duplicate (date, product) rows, build a wide sum-pivot with row/column totals and zero-filled holes.
- [ ] Convert that wide report back to tidy long form using `stack` + `reset_index`.
- [ ] Produce a `crosstab` of two categoricals with `normalize='index'` and verify each row sums to 1.
- [ ] Build a `pivot_table` with `aggfunc=['sum','mean','count']` and flatten the resulting MultiIndex columns.
- [ ] Reproduce a `pivot_table` result using only `groupby` + `unstack` and confirm the frames are equal.

## 11. Cheat Sheet

> [!TIP]
> **pivot** = pure reshape (keys must be unique) · **pivot_table** = groupby + reshape (`aggfunc`, `margins`, `fill_value`) · **unstack** = row level → columns (wider) · **stack** = column level → rows (taller) · **crosstab** = frequency table (`normalize=`). Long ↔ wide: `df.pivot_table(index=..., columns=..., values=..., aggfunc='sum', margins=True, fill_value=0)` to go wide; `.stack().reset_index()` to go back. Use `observed=True` on categoricals to avoid memory blowups; flatten MultiIndex columns before export.

**References:** pandas User Guide — "Reshaping and pivot tables"; pandas API docs (`pivot`, `pivot_table`, `stack`, `unstack`, `crosstab`); Hadley Wickham "Tidy Data" paper

---
*NumPy & Pandas Handbook — topic 20.*
