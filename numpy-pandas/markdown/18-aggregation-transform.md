# 18 · agg, transform & filter

> **In one line:** Three group-apply verbs that differ only in what they return — `agg` collapses a group to a scalar, `transform` broadcasts a group stat back to every row, `filter` keeps or drops whole groups.

---

## 1. Overview

Once you have a `GroupBy` object (see sibling topic **GroupBy: Split-Apply-Combine**), the apply step is where the real analytics lives. Pandas gives you three purpose-built verbs, and choosing correctly is the single biggest lever on both **correctness** and **speed**.

The distinction is entirely about **output shape**:

- **`agg`** reduces each group to one or more scalars → result has **one row per group**.
- **`transform`** returns a value for every input row → result has the **same shape and index as the input**, so it slots straight back as a new column.
- **`filter`** returns a boolean per group → result is the **subset of original rows** belonging to groups that passed.

Get this wrong and you either lose your row alignment (using `agg` where you needed `transform`) or leave performance on the table (using `apply` where a string kernel would do). This page also settles the perennial interview question: **apply vs agg vs transform**.

## 2. Core Concepts

- **Aggregation** — group → scalar. Supports a single func, a list of funcs, per-column dicts, and **named aggregation** for clean output columns.
- **Named aggregation** — `out_col=('in_col', 'func')` — the recommended modern syntax; explicit, flat column names, no MultiIndex surprises.
- **Multiple aggregations** — pass a list (`['mean','std']`) to get a MultiIndex column result, or a dict to apply different funcs per column.
- **Transformation** — group → Series of the *same length*; pandas re-aligns it to the original index. The classic use is a **group z-score** or **percent-of-group**.
- **Filtration** — `filter(func)` where `func` takes a sub-DataFrame and returns `True`/`False`; whole groups are kept or dropped (e.g. "drop groups with < 5 rows").
- **`apply`** — the general escape hatch; the callable receives each group's sub-DataFrame and may return a scalar, Series, or DataFrame. Flexible but slowest and shape-ambiguous.
- **Kernel dispatch** — string names (`'mean'`) and named aggregations hit **Cython kernels**; Python callables run per group in the interpreter.
- **Alignment guarantee** — `transform`'s output index matches the input exactly, which is what makes `df['z'] = df.groupby(k)['x'].transform(...)` correct.

## 3. Syntax & Examples

```python
import pandas as pd

df = pd.DataFrame({
    "dept":  ["eng", "eng", "eng", "sales", "sales", "hr"],
    "name":  ["a", "b", "c", "d", "e", "f"],
    "salary":[120, 150, 90, 100, 140, 80],
})

# --- agg: one row per group ---
df.groupby("dept")["salary"].mean()                 # single func

df.groupby("dept")["salary"].agg(["mean", "std", "max"])   # list -> MultiIndex cols

# per-column dict
df.groupby("dept").agg({"salary": ["mean", "max"], "name": "count"})

# NAMED aggregation (preferred): flat, explicit columns
df.groupby("dept", as_index=False).agg(
    avg_salary=("salary", "mean"),
    top_salary=("salary", "max"),
    headcount =("salary", "size"),
)

# --- transform: same shape, broadcast back ---
g = df.groupby("dept")["salary"]
df["group_mean"] = g.transform("mean")
df["z"] = (df["salary"] - g.transform("mean")) / g.transform("std")
df["pct_of_dept"] = df["salary"] / g.transform("sum")

# --- filter: keep/drop whole groups ---
big_depts = df.groupby("dept").filter(lambda s: len(s) >= 3)   # groups with >=3 rows
```

## 4. Worked Example

**Task:** for each department compute a summary *and* tag every employee with their within-department **z-score**, then drop tiny departments.

Starting data:

| dept  | name | salary |
|-------|------|-------:|
| eng   | a    |    120 |
| eng   | b    |    150 |
| eng   | c    |     90 |
| sales | d    |    100 |
| sales | e    |    140 |
| hr    | f    |     80 |

```python
g = df.groupby("dept")["salary"]

# transform -> per-row group stats (same shape as df)
df["dept_mean"] = g.transform("mean")
df["z"] = (df["salary"] - g.transform("mean")) / g.transform("std")

# filter -> keep only depts with >= 2 people
df2 = df.groupby("dept").filter(lambda s: len(s) >= 2)
```

After `transform` (hr's std is NaN — a single-element group):

| dept  | name | salary | dept_mean | z |
|-------|------|-------:|----------:|------:|
| eng   | a    |    120 |     120.0 |  0.00 |
| eng   | b    |    150 |     120.0 |  1.00 |
| eng   | c    |     90 |     120.0 | -1.00 |
| sales | d    |    100 |     120.0 | -0.71 |
| sales | e    |    140 |     120.0 |  0.71 |
| hr    | f    |     80 |      80.0 |   NaN |

`filter(len >= 2)` then drops the single-row **hr** group entirely, leaving the 5 eng+sales rows. And the collapsed summary:

```python
df.groupby("dept", as_index=False).agg(
    avg=("salary", "mean"), n=("salary", "size"))
```

| dept  | avg   | n |
|-------|------:|--:|
| eng   | 120.0 | 3 |
| hr    |  80.0 | 1 |
| sales | 120.0 | 2 |

## 5. Under the Hood

The three verbs share the *split* step but differ in the *combine* step — specifically how per-group outputs are reassembled:

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>

  <!-- source group -->
  <rect x="20" y="120" width="110" height="100" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="75" y="112" text-anchor="middle" fill="#64748b">one group</text>
  <text x="75" y="150" text-anchor="middle" fill="#1e293b">120</text>
  <text x="75" y="172" text-anchor="middle" fill="#1e293b">150</text>
  <text x="75" y="194" text-anchor="middle" fill="#1e293b">90</text>

  <!-- agg -->
  <line x1="130" y1="150" x2="250" y2="70" stroke="#475569" marker-end="url(#a2)"/>
  <text x="300" y="40" text-anchor="middle" fill="#2563eb" font-weight="bold">agg</text>
  <rect x="255" y="52" width="90" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="300" y="74" text-anchor="middle" fill="#1e293b">120.0</text>
  <text x="470" y="74" text-anchor="middle" fill="#64748b">group → scalar</text>
  <text x="470" y="90" text-anchor="middle" fill="#64748b">1 row / group</text>

  <!-- transform -->
  <line x1="130" y1="170" x2="250" y2="170" stroke="#475569" marker-end="url(#a2)"/>
  <text x="300" y="140" text-anchor="middle" fill="#2563eb" font-weight="bold">transform</text>
  <rect x="255" y="150" width="90" height="80" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="300" y="172" text-anchor="middle" fill="#1e293b">120.0</text>
  <text x="300" y="192" text-anchor="middle" fill="#1e293b">120.0</text>
  <text x="300" y="212" text-anchor="middle" fill="#1e293b">120.0</text>
  <text x="470" y="180" text-anchor="middle" fill="#64748b">group → same-length</text>
  <text x="470" y="196" text-anchor="middle" fill="#64748b">broadcast, aligned to rows</text>

  <!-- filter -->
  <line x1="130" y1="200" x2="250" y2="290" stroke="#475569" marker-end="url(#a2)"/>
  <text x="300" y="262" text-anchor="middle" fill="#2563eb" font-weight="bold">filter</text>
  <rect x="255" y="272" width="90" height="48" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="300" y="300" text-anchor="middle" fill="#1e293b">keep? T/F</text>
  <text x="470" y="290" text-anchor="middle" fill="#64748b">group → bool</text>
  <text x="470" y="306" text-anchor="middle" fill="#64748b">keep/drop whole group</text>

  <line x1="660" y1="40" x2="660" y2="320" stroke="#475569" stroke-dasharray="4 4"/>
  <text x="660" y="30" text-anchor="middle" fill="#64748b">output</text>
  <text x="660" y="72" text-anchor="middle" fill="#1e293b">rows↓</text>
  <text x="660" y="185" text-anchor="middle" fill="#1e293b">rows=</text>
  <text x="660" y="298" text-anchor="middle" fill="#1e293b">rows⊆</text>
</svg>
```

Why `transform` can slot back as a column: pandas guarantees its output carries the **same index** as the input, so `df['z'] = df.groupby(k)['x'].transform(f)` aligns element-wise even though groups were computed out of order. `agg` throws that alignment away (one label per group). `filter` never changes values — it returns the original rows of surviving groups.

**Performance:** `transform('mean')` and `agg('sum')` dispatch to Cython. `transform(lambda x: ...)` and `apply(...)` run Python per group. On a 1M-row, 10k-group frame, the string path is typically **10–50× faster**.

## 6. Variations & Trade-offs

| Verb | Callable receives | Returns | Output rows | Speed | Typical use |
|------|-------------------|---------|-------------|-------|-------------|
| `agg` | column(s) → | scalar(s) | one / group | fast (string) | summaries, KPIs |
| `transform` | one column → | same-length Series | = input | fast (string) | z-score, % of group, fill |
| `filter` | sub-DataFrame → | bool | subset | medium | drop small/low groups |
| `apply` | sub-DataFrame → | anything | depends | slow | multi-column custom logic |

**apply vs agg vs transform — the rule:** if the output is *one number per group*, use `agg`; if it's *one number per row*, use `transform`; if you're *keeping/dropping groups*, use `filter`. Reach for `apply` only when the function genuinely needs the whole sub-DataFrame and touches multiple columns at once — and expect it to be slower.

**Trade-off:** named aggregation (`out=('col','func')`) vs list/dict agg. Named is flat and explicit (best for pipelines); list/dict gives a MultiIndex you'll often have to flatten.

## 7. Production / Performance Notes

- **Default to named aggregation** — flat column names avoid brittle MultiIndex-flattening code downstream.
- **Prefer string kernels** — `transform('mean')` over `transform(lambda x: x.mean())`; the former is vectorized in Cython.
- **Compute a shared groupby once.** `g = df.groupby('k')['x']` then reuse `g.transform('mean')`, `g.transform('std')` — don't re-split per line.
- **Watch single-element groups in z-scores** — `std` is `NaN` (ddof=1) for a 1-row group, producing `NaN`/inf z-scores. Guard or use `ddof=0`.
- **`filter` returns a copy** of the surviving rows with the original index — reset it if you need contiguous positions.
- **`apply` can silently change shape/order.** Its result-combining heuristics differ between returning a scalar vs a DataFrame; pin behavior down and test on real data.
- For very large data, chained `transform`s materialize full-length intermediates — mind memory; Polars/Dask may scale better.

## 8. Common Mistakes

1. ⚠️ **Using `agg` where you needed `transform`.** Assigning a one-row-per-group result back to the full frame misaligns or raises. → Use `transform` for per-row output.
2. ⚠️ **`transform` with a function that changes length.** `transform` requires same-length (or scalar broadcastable) output; returning a reduced Series errors. → Use `agg` if you're reducing.
3. ⚠️ **`filter` expected to filter rows within a group.** `filter` is all-or-nothing per group — it can't drop *some* rows of a group. → Use a boolean mask for row-level filtering.
4. ⚠️ **z-score blows up on singleton groups.** `std` is NaN for n=1. → Handle small groups or set `ddof=0`.
5. ⚠️ **Reaching for `apply` by default.** It's the slowest and most shape-ambiguous path. → Try `agg`/`transform` first.
6. ⚠️ **MultiIndex columns from list-agg breaking later code.** `agg(['mean','max'])` yields tuple column names. → Prefer named aggregation, or flatten explicitly.
7. ⚠️ **Forgetting alignment when combining transforms.** Mixing a transformed Series with a filtered/re-sorted frame breaks index alignment. → Assign transforms before filtering.

## 9. Interview Questions

**Q: Explain the difference between `agg`, `transform`, and `filter`.**
A: All share the split step but differ in what the apply returns. `agg` reduces each group to a scalar → one row per group. `transform` returns a same-length Series per group, re-aligned to the original index → same shape as input. `filter` returns a boolean per group → the subset of rows in groups that passed. Shape of output is the whole distinction.

**Q: When would you use `transform` instead of `agg`?**
A: When you need the group statistic attached back to every original row — e.g. group mean, group sum for a percent-of-group, or a within-group z-score. `transform` preserves the index so `df['col'] = groupby(k)['x'].transform('mean')` aligns correctly.

**Q: How do you compute a within-group z-score?**
A: `g = df.groupby('grp')['x']; df['z'] = (df['x'] - g.transform('mean')) / g.transform('std')`. `transform` broadcasts each group's mean and std back to its rows so the arithmetic is element-wise aligned.

**Q: What is named aggregation and why prefer it?**
A: `df.groupby(k).agg(out=('col','func'), ...)` — you name each output column and specify its source column and function. It produces flat, explicit column names (no MultiIndex), which makes pipelines robust and readable.

**Q: How do you apply different aggregations to different columns?**
A: Pass a dict: `df.groupby(k).agg({'price':'mean','qty':'sum'})`, or use named aggregation with multiple entries pointing at different source columns.

**Q: What does `filter` do, and what can't it do?**
A: `df.groupby(k).filter(func)` keeps or drops *entire groups* based on a group-level predicate (e.g. `len(g) >= 5`). It cannot drop individual rows within a group — for row-level filtering use a boolean mask instead.

**Q: (Senior) apply vs agg vs transform — how do you decide, and what's the performance implication?**
A: One-number-per-group → `agg`; one-number-per-row → `transform`; keep/drop groups → `filter`. Use `apply` only when the function needs the whole sub-DataFrame across multiple columns. `agg`/`transform` with string kernels run in Cython; `apply` and lambda-transforms run Python per group and are often 10–50× slower.

**Q: (Senior) Why can you assign a `transform` result directly to a column but not an `agg` result?**
A: `transform` guarantees output with the same index/length as the input, so pandas aligns it row-for-row on assignment. `agg` returns one label per group (a different, shorter index), so direct assignment either misaligns via index or raises a length mismatch.

**Q: (Senior) Your z-score column has NaNs/infs for some groups — why?**
A: Those groups have a single row, so `std` with default `ddof=1` is NaN (or 0 causing division issues), yielding NaN/inf z-scores. Handle singleton groups explicitly or use `ddof=0`.

**Q: How would you keep only groups whose total sales exceed a threshold?**
A: `df.groupby('cust').filter(lambda g: g['sales'].sum() > 10_000)`. The predicate gets each group's sub-DataFrame and returns a bool; surviving groups' rows are returned.

**Q: What's the risk of defaulting to `groupby().apply()` for everything?**
A: It's the slowest path (Python per group) and its result-combining rules are shape-sensitive and can differ between returning a scalar, Series, or DataFrame — leading to subtle shape/index surprises. Prefer the specialized verbs.

## 10. Practice

- [ ] Build a per-department summary with named aggregation: mean, max, and headcount in flat columns.
- [ ] Add a within-group z-score column using two `transform` calls, and handle singleton groups.
- [ ] Add a `pct_of_group` column via `x / groupby(k)['x'].transform('sum')`.
- [ ] Drop all groups with fewer than 3 rows using `filter`, and confirm the row count change.
- [ ] Rewrite a slow `groupby().apply(lambda g: g['x'].mean())` as a string aggregation and time both.

## 11. Cheat Sheet

> [!TIP]
> **Pick the verb by output shape.** `agg` → one row per group (summaries; use **named aggregation** `out=('col','func')` for flat columns). `transform` → same shape as input, group stat broadcast back and index-aligned (z-score: `(x - g.transform('mean'))/g.transform('std')`; percent-of-group: `x / g.transform('sum')`). `filter(func)` → keep/drop *whole* groups by a group-level bool (can't drop individual rows). Prefer **string kernels** over lambdas (Cython, 10–50× faster). Use `apply` only for genuine multi-column custom logic. Rule: number-per-group→agg, number-per-row→transform, keep-groups→filter.

**References:** pandas User Guide — Group by (Aggregation / Transformation / Filtration), pandas API `GroupBy.agg`/`transform`/`filter`, "Named aggregation" in the pandas docs

---

*NumPy & Pandas Handbook — topic 18.*
