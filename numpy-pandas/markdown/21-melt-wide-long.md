# 21 · Tidy Data: melt & wide↔long

> **In one line:** `melt` collapses many value-columns into two tidy columns (variable, value) so every observation is one row.

---

## 1. Overview

**Tidy data** is a discipline, not a format: each *variable* is a column, each *observation* is a row, and each *type of observational unit* is its own table. Most raw data violates this — spreadsheets spread a single variable (say, "sales") across many columns (Jan, Feb, Mar), one per category. That wide layout is easy for humans to read but hostile to analysis: you can't `groupby` a month that lives in a column header, and every plotting/modeling library expects one variable per column.

**`melt`** is the tool that tidies wide data. It takes a set of columns you want to *keep as identifiers* (`id_vars`) and a set you want to *unpivot* (`value_vars`), and stacks the latter into two new columns: one holding the former column *names* (`var_name`) and one holding the *values* (`value_name`). The result is longer and narrower — the canonical tidy shape.

You reach for `melt` (and its structured cousin `wide_to_long`) whenever downstream work is grouped, faceted, or plotted by a dimension currently trapped in column headers. Tidy form is the lingua franca that `groupby`, seaborn, plotly-express, and most SQL loads expect. `melt` is the inverse of `pivot`: **pivot spreads a column into headers; melt gathers headers back into a column.**

## 2. Core Concepts

- **Tidy data (three rules)** — variables in columns, observations in rows, one table per unit type.
- **`melt(id_vars, value_vars, var_name, value_name)`** — unpivots value columns into (variable, value) pairs.
- **`id_vars`** — the columns that identify each observation and are *repeated* down the melted output.
- **`value_vars`** — the columns to unpivot; if omitted, **every** non-`id_vars` column is melted.
- **`var_name` / `value_name`** — names for the two new columns (defaults: `"variable"` / `"value"`).
- **Wide → long** — `melt` gathers; **long → wide** — `pivot`/`pivot_table` spreads (the inverse).
- **`wide_to_long`** — parses *structured* column names like `income_2020`, `income_2021` into a stub + numeric suffix, producing a MultiIndex — melt on steroids for panel data.
- **`stubnames`** — the shared prefix `wide_to_long` groups on (e.g. `income`, `weight`).
- **Why tidy wins** — enables `groupby`, faceting, joins, and one-line plots; avoids column-header semantics.
- **Round-trip** — `df.melt(...).pivot(...)` should recover the original (order aside).

## 3. Syntax & Examples

```python
import pandas as pd

wide = pd.DataFrame({
    "student": ["Ann", "Ben"],
    "math":    [90, 70],
    "science": [85, 95],
    "history": [60, 80],
})
```

**Basic melt — unpivot the subject columns:**

```python
wide.melt(
    id_vars="student",
    value_vars=["math", "science", "history"],
    var_name="subject",
    value_name="score",
)
```

**Omit `value_vars` — melt everything except the id:**

```python
wide.melt(id_vars="student")   # var_name='variable', value_name='value'
```

**Melt then immediately group (the whole point):**

```python
(wide.melt(id_vars="student", var_name="subject", value_name="score")
     .groupby("subject")["score"].mean())
```

**`wide_to_long` for structured names (`math_2025`, `math_2026`, …):**

```python
panel = pd.DataFrame({
    "id": [1, 2],
    "math_2025": [80, 60], "math_2026": [88, 65],
})
pd.wide_to_long(panel, stubnames="math", i="id", j="year", sep="_")
```

**Inverse — long back to wide:**

```python
long_df.pivot(index="student", columns="subject", values="score")
```

## 4. Worked Example

Grades stored one-column-per-subject — untidy. We melt, then compute a per-subject average and a per-student total, both trivial once tidy.

```python
import pandas as pd

wide = pd.DataFrame({
    "student": ["Ann", "Ben", "Cara"],
    "math":    [90, 70, 100],
    "science": [85, 95, 80],
})

tidy = wide.melt(id_vars="student", var_name="subject", value_name="score")
print(tidy)
```

**Melted (long) result** — 3 students × 2 subjects = 6 rows:

| student | subject | score |
|---------|---------|-------|
| Ann | math | 90 |
| Ben | math | 70 |
| Cara | math | 100 |
| Ann | science | 85 |
| Ben | science | 95 |
| Cara | science | 80 |

Now analysis is one line each:

```python
tidy.groupby("subject")["score"].mean()   # per-subject average
tidy.groupby("student")["score"].sum()     # per-student total
```

| subject | mean score |   | student | total |
|---------|-----------|---|---------|-------|
| math | 86.67 |   | Ann | 175 |
| science | 86.67 |   | Ben | 165 |
|  |  |   | Cara | 180 |

Neither of those was expressible as a clean groupby while `math`/`science` lived in column headers.

## 5. Under the Hood

`melt` is a **repeat + concatenate**. It tiles the `id_vars` block once per `value_var`, then stacks the value columns into a single vertical `value` column while recording which original column each block came from in the `variable` column. The output row count is `len(df) * len(value_vars)`; it never aggregates — it's a pure structural rotation, the exact inverse of `pivot`.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto" markerUnits="strokeWidth">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- WIDE -->
  <text x="150" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">WIDE</text>
  <rect x="30" y="40"  width="240" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="70"  y="60" text-anchor="middle" fill="#1e293b" font-weight="600">student</text>
  <text x="150" y="60" text-anchor="middle" fill="#d97706" font-weight="600">math</text>
  <text x="230" y="60" text-anchor="middle" fill="#d97706" font-weight="600">science</text>
  <rect x="30" y="72"  width="240" height="28" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="70"  y="91" text-anchor="middle" fill="#1e293b">Ann</text>
  <text x="150" y="91" text-anchor="middle" fill="#1e293b">90</text>
  <text x="230" y="91" text-anchor="middle" fill="#1e293b">85</text>
  <rect x="30" y="102" width="240" height="28" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="70"  y="121" text-anchor="middle" fill="#1e293b">Ben</text>
  <text x="150" y="121" text-anchor="middle" fill="#1e293b">70</text>
  <text x="230" y="121" text-anchor="middle" fill="#1e293b">95</text>
  <text x="150" y="160" text-anchor="middle" fill="#64748b">value columns → headers hold a variable</text>

  <!-- arrow -->
  <line x1="290" y1="100" x2="420" y2="100" stroke="#475569" stroke-width="1.5" marker-end="url(#ah2)"/>
  <text x="355" y="88" text-anchor="middle" fill="#059669" font-weight="700">melt →</text>
  <text x="355" y="118" text-anchor="middle" fill="#64748b">id_vars=student</text>

  <!-- LONG -->
  <text x="560" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">LONG (tidy)</text>
  <rect x="440" y="40" width="250" height="30" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="490" y="60" text-anchor="middle" fill="#1e293b" font-weight="600">student</text>
  <text x="575" y="60" text-anchor="middle" fill="#1e293b" font-weight="600">subject</text>
  <text x="655" y="60" text-anchor="middle" fill="#1e293b" font-weight="600">score</text>
  <g fill="#1e293b">
    <rect x="440" y="72"  width="250" height="24" rx="4" fill="#ffffff" stroke="#cbd5e1"/>
    <text x="490" y="88" text-anchor="middle">Ann</text><text x="575" y="88" text-anchor="middle" fill="#d97706">math</text><text x="655" y="88" text-anchor="middle">90</text>
    <rect x="440" y="98"  width="250" height="24" rx="4" fill="#ffffff" stroke="#cbd5e1"/>
    <text x="490" y="114" text-anchor="middle">Ben</text><text x="575" y="114" text-anchor="middle" fill="#d97706">math</text><text x="655" y="114" text-anchor="middle">70</text>
    <rect x="440" y="124" width="250" height="24" rx="4" fill="#ffffff" stroke="#cbd5e1"/>
    <text x="490" y="140" text-anchor="middle">Ann</text><text x="575" y="140" text-anchor="middle" fill="#d97706">science</text><text x="655" y="140" text-anchor="middle">85</text>
    <rect x="440" y="150" width="250" height="24" rx="4" fill="#ffffff" stroke="#cbd5e1"/>
    <text x="490" y="166" text-anchor="middle">Ben</text><text x="575" y="166" text-anchor="middle" fill="#d97706">science</text><text x="655" y="166" text-anchor="middle">95</text>
  </g>
  <text x="560" y="196" text-anchor="middle" fill="#64748b">headers become a 'subject' column</text>
  <text x="560" y="214" text-anchor="middle" fill="#64748b">rows = len(df) × #value_vars</text>
</svg>
```

## 6. Variations & Trade-offs

| Tool | Direction | Handles structured names | Output |
|------|-----------|--------------------------|--------|
| `melt` | wide → long | No (flat unpivot) | (id_vars…, variable, value) |
| `wide_to_long` | wide → long | **Yes** (stub + suffix) | MultiIndex (i, j) |
| `stack` | wide → long | Works on MultiIndex columns | Series/MultiIndex |
| `pivot` / `pivot_table` | long → wide | — | Grid (inverse of melt) |
| `str.split` + `melt` | wide → long | Manual multi-part parse | Custom |

**When tidy beats wide:** analysis and plotting. `groupby`, faceting (`seaborn`/`plotly` `hue`/`facet`), joins, and SQL loads all want one variable per column — tidy makes them one-liners. **When wide wins:** human reading, spreadsheet export, correlation matrices, and dense ML feature matrices where each column *is* a distinct feature. Rule of thumb: **store and compute in long; present and model in wide.** Use `melt` on ingest, `pivot` on egress.

## 7. Production / Performance Notes

- **`melt` multiplies row count** by the number of `value_vars` — a 1M-row × 50-column melt is 50M rows. Melt only the columns you'll actually use; drop the rest first.
- **Mixed dtypes collapse to `object`** — if your value columns have different types (int + string), the single `value` column upcasts to `object` and loses efficiency. Melt homogeneous columns together.
- **`wide_to_long` needs consistent naming** (`stub<sep><suffix>`); irregular names silently drop columns. Validate with a column-name regex first.
- **Categoricals** — cast `var_name` to `category` after melting high-cardinality headers to save memory.
- **Round-trip integrity:** `melt` then `pivot` should reconstruct the source; test it in pipelines to catch silent data loss.
- Prefer melting **once at ingest** and keeping data long through the pipeline rather than repeatedly reshaping — reshapes copy data.

## 8. Common Mistakes

1. ⚠️ Forgetting `id_vars`, so identifier columns get unpivoted into the value stack. **Fix:** always list the columns that identify a row in `id_vars`.
2. ⚠️ Omitting `value_vars` and accidentally melting columns you meant to keep. **Fix:** pass `value_vars` explicitly when you don't want *all* non-id columns.
3. ⚠️ Leaving default `variable`/`value` names and shipping cryptic output. **Fix:** always set `var_name` and `value_name`.
4. ⚠️ Melting columns of different dtypes and silently getting an `object` value column. **Fix:** melt homogeneous groups separately.
5. ⚠️ Using `melt` when column names are structured (`x_2020`, `x_2021`) and losing the suffix meaning. **Fix:** use `wide_to_long` to split stub and suffix.
6. ⚠️ Melting a huge frame before filtering, exploding memory. **Fix:** filter/select columns first, then melt.
7. ⚠️ Assuming melt aggregates — it doesn't. **Fix:** melt only reshapes; aggregate afterward with `groupby`.

## 9. Interview Questions

**Q: What are the three rules of tidy data?**
A: Each variable is its own column, each observation is its own row, and each type of observational unit forms its own table. Tidy form makes groupby, joins, and plotting straightforward.

**Q: What does `melt` do and what are `id_vars` vs `value_vars`?**
A: `melt` unpivots wide columns into two columns — one for the original column names, one for their values. `id_vars` are identifier columns repeated down the output; `value_vars` are the columns unpivoted. If `value_vars` is omitted, all non-id columns are melted.

**Q: How is `melt` related to `pivot`?**
A: They are inverses. `pivot` spreads a column's values into new column headers (long → wide); `melt` gathers headers back into a single variable column (wide → long).

**Q: When is wide better than tidy?**
A: For human reading, spreadsheet export, correlation matrices, and ML feature matrices where each column is a genuine distinct feature. Store/compute long, present/model wide.

**Q: What does `wide_to_long` add over `melt`?**
A: It parses *structured* column names (a shared `stubname` plus a numeric/label suffix, e.g. `income_2020`) into a stub column and a suffix index level, producing a MultiIndex — ideal for panel/longitudinal data where melt's flat unpivot would lose the suffix meaning.

**Q: Why did all my values become `object` dtype after melting?**
A: The melted columns had mixed dtypes; stacking them into one `value` column upcasts to the common type (`object`). Melt homogeneous columns together to preserve numeric dtype.

**Q: (Senior) You need to plot score-over-time faceted by student from a wide frame — what's the reshape and why?**
A: `melt` (or `wide_to_long` if columns encode the time) into long form so time and metric are columns, then pass them as x/hue/facet to the plotting library. Plotting libraries map columns to aesthetics, so the dimension must be a column, not a header.

**Q: (Senior) How do you guard a pipeline against silent data loss when reshaping?**
A: Assert a round-trip: `melt(...).pivot(...)` should reconstruct the source (values and shape), and check that `wide_to_long` didn't drop columns whose names failed the stub/suffix pattern. Validate column names with a regex before reshaping.

**Q: (Senior) A 1M-row × 40-column frame is slow after melt — what happened and how do you fix it?**
A: `melt` multiplied rows by the number of value columns (40M rows) and possibly upcast to `object`. Fix by selecting only needed value columns before melting, keeping dtypes homogeneous, and casting the `variable` column to `category`.

**Q: Does `melt` aggregate or lose data?**
A: No — it's a pure structural rotation with no aggregation; output row count is exactly `rows × len(value_vars)`. Aggregation is a separate `groupby` step afterward.

## 10. Practice

- [ ] Melt a wide grades table (`student`, `math`, `science`, `history`) into tidy `(student, subject, score)` with proper `var_name`/`value_name`.
- [ ] From the tidy frame, compute per-subject mean and per-student total with one `groupby` each.
- [ ] Use `wide_to_long` on columns like `sales_2024`, `sales_2025` to produce a `(id, year)` MultiIndex.
- [ ] Round-trip: `melt` then `pivot` a frame and assert you recover the original values.
- [ ] Take a wide frame with mixed-dtype value columns; melt homogeneous groups separately and confirm dtypes are preserved.

## 11. Cheat Sheet

> [!TIP]
> **Tidy = variables in columns, observations in rows.** `df.melt(id_vars=[...], value_vars=[...], var_name='variable', value_name='value')` gathers wide value-columns into long (variable, value) pairs — the inverse of `pivot`. `id_vars` repeat down; omitting `value_vars` melts everything else. Use `pd.wide_to_long(df, stubnames='x', i='id', j='year', sep='_')` for structured `x_2024`/`x_2025` names. Store/compute long (enables groupby + one-line plots); present/model wide. Melt multiplies rows — select columns first and keep dtypes homogeneous.

**References:** pandas User Guide — "Reshaping"; pandas API (`melt`, `wide_to_long`); Hadley Wickham "Tidy Data" (JSS 2014); seaborn "Data structures" guide

---
*NumPy & Pandas Handbook — topic 21.*
