# 12 · Series & DataFrame Fundamentals

> **In one line:** A **Series** is a labeled 1D array; a **DataFrame** is an ordered dict of Series sharing one **index** — labels are what make pandas more than NumPy.

---

## 1. Overview

NumPy gives you fast, typed n-dimensional arrays addressed by **position**. Pandas adds one transformative idea on top: **labels**. Every value carries a row label (the **index**) and, in 2D, a column label. Those labels drive alignment, joins, group-bys, and human-readable selection — the whole pandas experience.

The two core objects are the **Series** (a single labeled column: `values` + `index`) and the **DataFrame** (a table of columns, each a Series, all sharing the same row index). A DataFrame is best pictured not as a 2D matrix but as an **ordered dictionary of Series** keyed by column name.

You reach for pandas whenever data is **heterogeneous** (mixed dtypes per column), **labeled** (named rows/columns, time stamps), or needs **relational** operations (merge, group, pivot). For dense numeric math of one dtype, raw NumPy is leaner; the moment you have columns with names and types, DataFrame earns its keep.

## 2. Core Concepts

- **Series = values + index.** Two aligned arrays: a typed `.values` (usually a NumPy array) and an `.index` of labels. Length-matched, ordered.
- **DataFrame = dict of Series.** Columns are Series sharing one row **index**; `df['col']` returns that Series. Column order is preserved.
- **The index is a first-class object.** `RangeIndex` by default; can be strings, `DatetimeIndex`, or a `MultiIndex`. It powers alignment and O(1)-ish label lookup when unique/sorted.
- **One dtype per column, not per cell.** Each column is homogeneously typed (`int64`, `float64`, `bool`, `datetime64[ns]`, `category`, or `object`). Mixed content falls back to slow `object`.
- **Automatic alignment.** Binary ops match on labels, inserting **NaN** where labels don't overlap — a feature, not a bug.
- **`object` dtype is the escape hatch.** It stores Python object pointers (e.g. `str`), forfeiting vectorization. Prefer `string`, `category`, or numeric dtypes.
- **Axis convention.** `axis=0` = index/rows (down), `axis=1` = columns (across). Most reductions default to `axis=0`.
- **Construction is flexible.** Build from a dict of columns, a list of row records, a 2D NumPy array, or by reading files.

## 3. Syntax & Examples

**A Series — values plus an explicit index:**

```python
import numpy as np
import pandas as pd

s = pd.Series([30, 25, 35], index=['ann', 'bob', 'cy'], name='age')
s['bob']          # 25   -> label lookup
s.iloc[1]         # 25   -> positional lookup
s.values          # array([30, 25, 35])
s.index           # Index(['ann', 'bob', 'cy'], dtype='object')
s.dtype           # dtype('int64')
```

**DataFrame from a dict of columns** (the most common form):

```python
df = pd.DataFrame({
    'name': ['Ann', 'Bob', 'Cy'],
    'age':  [30, 25, 35],
    'city': ['NYC', 'LA', 'NYC'],
})
df['age']          # -> Series (one column)
df[['name', 'age']]  # -> DataFrame (list of columns)
```

**From a list of records (row-oriented)** — handy for API/JSON rows:

```python
records = [
    {'name': 'Ann', 'age': 30},
    {'name': 'Bob', 'age': 25},
]
pd.DataFrame.from_records(records)   # missing keys -> NaN
```

**From a NumPy array** — supply your own labels:

```python
arr = np.arange(6).reshape(3, 2)
pd.DataFrame(arr, columns=['x', 'y'], index=['r0', 'r1', 'r2'])
```

**Inspect dtypes and shape:**

```python
df.dtypes
df.shape       # (3, 3)  -> (rows, cols)
df.info()      # dtypes + non-null counts + memory
```

Output of `df.dtypes`:

| column | dtype  |
|--------|--------|
| name   | object |
| age    | int64  |
| city   | object |

## 4. Worked Example

Build a small table, add a derived column, set a meaningful index, and observe label alignment end to end.

```python
import pandas as pd

df = pd.DataFrame({
    'name':  ['Ann', 'Bob', 'Cy', 'Dee'],
    'dept':  ['eng', 'eng', 'sales', 'sales'],
    'salary':[120, 95, 80, 85],
})
df = df.set_index('name')          # 'name' becomes the row index
df['bonus'] = df['salary'] * 0.10  # vectorized derived column
print(df)
print(df.dtypes)

# Alignment: add a Series indexed by name; mismatches -> NaN
adj = pd.Series({'Ann': 5, 'Cy': 3, 'Zoe': 9})
print(df['salary'] + adj)
```

Result:

| name | dept  | salary | bonus |
|------|-------|--------|-------|
| Ann  | eng   | 120    | 12.0  |
| Bob  | eng   | 95     | 9.5   |
| Cy   | sales | 80     | 8.0   |
| Dee  | sales | 85     | 8.5   |

`df['salary'] + adj` aligns on the **name** index:

```text
Ann    125.0
Bob      NaN    # Bob absent from adj -> NaN
Cy      83.0
Dee      NaN
Zoe      NaN    # Zoe absent from df -> NaN, but label still appears
dtype: float64
```

The union of labels is preserved and any non-overlapping label yields NaN — this is automatic alignment doing exactly what a manual `merge` would, for free.

## 5. Under the Hood

A DataFrame is a thin, labeled wrapper over columnar storage. Historically pandas used a **BlockManager** that grouped columns of the same dtype into contiguous 2D NumPy blocks; pandas 2.x can back each column by an **Arrow** array. Either way the mental model holds: **columns are the unit of storage and typing**, the index is a separate object, and `df['col']` hands you a Series viewing that column plus the shared index.

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" fill="#1e293b" font-weight="bold">DataFrame = shared index + columns (each a typed Series)</text>

  <!-- index column -->
  <rect x="30" y="60" width="90" height="150" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="75" y="52" text-anchor="middle" fill="#64748b">index</text>
  <text x="75" y="90" text-anchor="middle" fill="#1e293b">Ann</text>
  <text x="75" y="118" text-anchor="middle" fill="#1e293b">Bob</text>
  <text x="75" y="146" text-anchor="middle" fill="#1e293b">Cy</text>
  <text x="75" y="174" text-anchor="middle" fill="#1e293b">Dee</text>

  <!-- col: dept (object) -->
  <rect x="150" y="60" width="140" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="220" y="52" text-anchor="middle" fill="#64748b">dept · object</text>
  <text x="220" y="90" text-anchor="middle" fill="#1e293b">eng</text>
  <text x="220" y="118" text-anchor="middle" fill="#1e293b">eng</text>
  <text x="220" y="146" text-anchor="middle" fill="#1e293b">sales</text>
  <text x="220" y="174" text-anchor="middle" fill="#1e293b">sales</text>

  <!-- col: salary (int64) -->
  <rect x="310" y="60" width="140" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="52" text-anchor="middle" fill="#64748b">salary · int64</text>
  <text x="380" y="90" text-anchor="middle" fill="#1e293b">120</text>
  <text x="380" y="118" text-anchor="middle" fill="#1e293b">95</text>
  <text x="380" y="146" text-anchor="middle" fill="#1e293b">80</text>
  <text x="380" y="174" text-anchor="middle" fill="#1e293b">85</text>

  <!-- col: bonus (float64) -->
  <rect x="470" y="60" width="140" height="150" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="540" y="52" text-anchor="middle" fill="#64748b">bonus · float64</text>
  <text x="540" y="90" text-anchor="middle" fill="#1e293b">12.0</text>
  <text x="540" y="118" text-anchor="middle" fill="#1e293b">9.5</text>
  <text x="540" y="146" text-anchor="middle" fill="#1e293b">8.0</text>
  <text x="540" y="174" text-anchor="middle" fill="#1e293b">8.5</text>

  <line x1="120" y1="235" x2="120" y2="235" stroke="#475569"/>
  <text x="320" y="250" text-anchor="middle" fill="#64748b">df['salary'] returns the int64 column + the shared index as a Series</text>
  <line x1="380" y1="215" x2="380" y2="238" stroke="#475569" marker-end="url(#ah)"/>
  <text x="320" y="282" text-anchor="middle" fill="#64748b">one dtype per column · the index is a separate, reusable object</text>
</svg>
```

## 6. Variations & Trade-offs

| Constructor | Input shape | Best for | Watch out |
|-------------|-------------|----------|-----------|
| `DataFrame({col: [...]})` | dict of columns | hand-built / columnar data | dict order = column order (3.7+) |
| `DataFrame.from_records([...])` | list of row dicts | API/JSON rows | missing keys become NaN |
| `DataFrame(ndarray, columns=)` | 2D NumPy array | numeric matrices | you must supply labels |
| `read_csv/parquet/sql` | files/DB | real datasets | see topic 13 |
| `Series(dict)` | dict | quick 1D lookup | keys become the index |

**Series vs single-column DataFrame:** `df['c']` is a Series (1D, has `.name`); `df[['c']]` is a DataFrame (2D). Many APIs behave differently on each — a frequent source of bugs.

**object vs typed:** an `object` column of Python strings iterates in Python and is memory-heavy. Converting to `category` (repeated values) or `string` dtype restores speed and shrinks memory dramatically.

## 7. Production / Performance Notes

- **Set a meaningful index** when you look rows up by key repeatedly — `df.loc[key]` on a unique, sorted index is far faster than boolean scans.
- **Fix dtypes at load time** (`read_csv(dtype=...)`, `parse_dates=...`). Cleaning them afterward copies data.
- **Kill `object` columns.** `df.select_dtypes('object')` to find them; cast to `category`/`string`/numeric. On a 10M-row column of a few repeated strings, `category` can cut memory 10–50×.
- **`df.info(memory_usage='deep')`** reveals the true footprint of object columns (shallow mode undercounts strings).
- **Avoid growing frames row-by-row** in a loop (`df = df.append(...)` / `pd.concat` per row is O(n²)). Build a list, construct once.
- **Prefer whole-column vectorized ops** over `iterrows`/`apply(axis=1)`, which run Python per row.

## 8. Common Mistakes

1. ⚠️ **Confusing Series and DataFrame return types.** `df['c']` (Series) vs `df[['c']]` (DataFrame). *Fix:* choose the bracket form your downstream API expects; use a list to force a DataFrame.
2. ⚠️ **Expecting positional selection from `df[0]`.** Bracket indexing on a DataFrame selects **columns** by label. *Fix:* use `df.iloc[0]` for the first row, `df.loc[label]` by label.
3. ⚠️ **Silent `object` columns.** One stray string turns a numeric column to `object`. *Fix:* check `df.dtypes`; coerce with `pd.to_numeric(..., errors='coerce')`.
4. ⚠️ **Assuming operations are positional.** `s1 + s2` aligns by label and injects NaN. *Fix:* reset/align indexes deliberately, or use `.values` to force positional math.
5. ⚠️ **Building frames in a loop with append/concat.** Quadratic time + repeated copies. *Fix:* accumulate rows in a list, `pd.DataFrame(rows)` once.
6. ⚠️ **Forgetting the index after `set_index`.** The column is gone from the body. *Fix:* `reset_index()` to bring it back, or `set_index(..., drop=False)`.
7. ⚠️ **Trusting default `RangeIndex` for joins.** Positional integer index misaligns after filtering. *Fix:* set a real key or `reset_index(drop=True)` before combining.

## 9. Interview Questions

**Q: What exactly is a Series?**
A: A one-dimensional labeled array: a typed values array (usually NumPy-backed) paired with an equal-length index of labels, plus an optional name.

**Q: How is a DataFrame best conceptualized — as a 2D matrix or something else?**
A: As an ordered dict of Series keyed by column name, all sharing one row index. Columns, not cells, are the unit of storage and typing.

**Q: Why can each column have a different dtype but a single column cannot mix types?**
A: Storage is columnar — each column is a homogeneously typed array for vectorization. Mixed content in one column falls back to `object` (Python-pointer array), losing that speed.

**Q: What does automatic alignment do, and when does it bite you?**
A: Binary operations match values by label and insert NaN where labels don't overlap. It bites when you assume positional math and get NaNs from a mismatched index.

**Q: `df['col']` vs `df[['col']]` — what's the difference?**
A: The first returns a 1D Series; the second returns a 2D DataFrame with one column. Different types, different downstream behavior.

**Q: How do you construct a DataFrame from row-oriented records vs column-oriented data?**
A: `DataFrame.from_records([{...}, {...}])` for row dicts (missing keys → NaN); `DataFrame({col: [...]})` for a dict of columns.

**Q: Why is the index a "first-class" object rather than just row numbers?**
A: It drives alignment, joins, group labels, and near-O(1) label lookup when unique/sorted; it can be strings, datetimes, or a MultiIndex — far more than a row counter.

**Q: (Senior) How does pandas physically store a DataFrame, and why does that matter for performance?**
A: Columnar — historically same-dtype columns consolidated into NumPy blocks (BlockManager), optionally Arrow-backed in 2.x. It matters because column-wise vectorized ops are cache-friendly and fast, while row-wise iteration crosses dtypes and runs in Python.

**Q: (Senior) You have a 50M-row column of country codes as `object`. How do you cut memory and speed it up?**
A: Cast to `category` dtype (or pandas `string`). Categories store integer codes + a small dictionary, cutting memory an order of magnitude and speeding up group-by/compare.

**Q: (Senior) Why is building a DataFrame via repeated `append`/`concat` in a loop an anti-pattern?**
A: Each call allocates a new frame and copies all prior data — O(n²) time and churn. Accumulate rows/dicts in a Python list and construct the DataFrame once.

**Q: (Senior) After filtering a DataFrame you merge on the default integer index and get wrong rows. Why?**
A: The `RangeIndex` no longer matches positions after filtering, so label-based alignment/merge pairs the wrong rows. Reset the index or join on an explicit key column.

## 10. Practice

- [ ] Build a Series with a custom string index and look up a value by both `[]` and `.iloc`.
- [ ] Construct the same DataFrame three ways: dict of columns, list of records, and NumPy array + labels; confirm equality.
- [ ] Demonstrate label alignment by adding two Series with partially overlapping indexes and explain each NaN.
- [ ] Take a frame with an `object` column of repeated strings; convert to `category` and compare `info(memory_usage='deep')` before/after.
- [ ] Show the difference between `df['c']` and `df[['c']]` by printing `type(...)` of each.

## 11. Cheat Sheet

> [!TIP]
> **Series** = values + index (1D, typed). **DataFrame** = ordered dict of Series sharing one **index** (columnar; one dtype per column). Build from `{col:[...]}`, `from_records([{...}])`, or `ndarray + columns/index`. `df['c']`→Series, `df[['c']]`→DataFrame. Bracket indexing selects **columns**; use `.iloc`/`.loc` for rows. Binary ops **align by label** → NaN on mismatch. Kill `object` columns (→ `category`/`string`/numeric); set a meaningful index for fast lookups; never grow a frame row-by-row in a loop.

**References:** Pandas User Guide — "Intro to data structures"; Pandas "Essential basic functionality"; Wes McKinney, *Python for Data Analysis* (ch. 5)

---

*NumPy & Pandas Handbook — topic 12.*
