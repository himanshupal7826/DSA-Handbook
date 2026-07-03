# 16 · Missing Data: NaN, None & NA

> **In one line:** pandas represents "no value" three different ways — `NaN`, `None`, and `pd.NA` — and knowing which one you have decides how detection, dropping, and filling behave.

---

## 1. Overview

Real data has holes: unrecorded sensor readings, optional form fields, keys that didn't join. **Missing data** is not an edge case — it is the default state of any dataset you didn't generate yourself, and every aggregation, join, and model silently changes behavior in its presence.

pandas inherited its missing-value model from NumPy, where the only sentinel available in a float array is the IEEE-754 **`NaN`** ("Not a Number"). That one design decision ripples everywhere: an integer column with one missing value historically got **upcast to float** just so it could hold a `NaN`. To fix this, modern pandas added **nullable dtypes** (`Int64`, `boolean`, `string`) backed by a new scalar, **`pd.NA`**, that works across all types.

You reach for the missing-data toolkit — `isna`, `dropna`, `fillna`, `interpolate` — at the very start of almost every pipeline. Getting it wrong means an `int` column that silently became `float64`, a `groupby` that dropped a whole category, or a mean that quietly ignored a third of your rows.

The mental model: **there are two questions.** *How is missingness stored?* (`NaN` vs `None` vs `pd.NA`) and *what do I do about it?* (detect, drop, or fill). Sections 2–4 cover storage; 5 onward covers handling.

## 2. Core Concepts

- **`NaN`** — a special **float** value (`np.nan`). It is the classic pandas sentinel and lives in `float64`/`object` columns. Crucially, `np.nan != np.nan` is `True`, so you can never test for it with `==`.
- **`None`** — Python's null object. In an **object**-dtype column it stays `None`; but assign it into a **float** column and pandas coerces it to `NaN`.
- **`pd.NA`** — the newer, dtype-agnostic scalar used by **nullable** extension dtypes (`Int64`, `Float64`, `boolean`, `string`). It **propagates** through operations three-valued-logic style: `pd.NA + 1` is `pd.NA`, `pd.NA > 5` is `pd.NA` (not `False`).
- **`NaT`** — "Not a Time", the missing sentinel for `datetime64[ns]` and `timedelta64[ns]` columns. `isna` treats it as missing.
- **Detection is unified** — `isna()`/`isnull()` (aliases) and `notna()`/`notnull()` return the same boolean mask regardless of whether the hole is `NaN`, `None`, `NaT`, or `pd.NA`.
- **Skipna default** — reductions (`sum`, `mean`, `std`) skip missing by default (`skipna=True`); pass `skipna=False` to make one missing value poison the whole result.
- **Int upcast trap** — a plain `int64` column cannot store `NaN`; introducing missingness upcasts it to `float64`. **Nullable `Int64`** avoids this.
- **Nullable dtypes** — opt-in via `dtype="Int64"`, `.convert_dtypes()`, or `pd.read_csv(..., dtype_backend="numpy_nullable")`; they keep integer semantics and use `pd.NA`.

## 3. Syntax & Examples

```python
import numpy as np
import pandas as pd

s = pd.Series([1.0, np.nan, None, 4.0])
s
# 0    1.0
# 1    NaN      <- np.nan
# 2    NaN      <- None was coerced to NaN in a float Series
# 3    4.0
# dtype: float64

# Detect (all four spellings behave identically on missing)
s.isna()          # -> [False, True, True, False]
s.notna()         # complement
s.isna().sum()    # 2  (count of missing)

# The identity trap: never use ==
np.nan == np.nan  # False  ->  use isna(), NOT `x == np.nan`
```

```python
# None stays None in an object column, becomes NaN in a float column
pd.Series([1, None], dtype="object")   # [1, None]     object
pd.Series([1, None], dtype="float64")  # [1.0, NaN]    float64

# Nullable Int64 keeps integers AND allows missing via pd.NA
si = pd.Series([1, 2, None], dtype="Int64")
si
# 0       1
# 1       2
# 2    <NA>
# dtype: Int64
si + 1            # [2, 3, <NA>]   -> pd.NA propagates, stays Int64
```

```python
df = pd.DataFrame({
    "a": [1, 2, np.nan, 4],
    "b": [np.nan, 2, 3, 4],
    "c": ["x", None, "z", "w"],
})

# --- dropna ---
df.dropna()                       # drop any row with >=1 missing
df.dropna(how="all")              # drop only rows that are entirely missing
df.dropna(thresh=2)               # keep rows with >=2 non-null values
df.dropna(subset=["a"])           # only consider column 'a'
df.dropna(axis=1)                 # drop COLUMNS with any missing

# --- fillna ---
df.fillna(0)                      # constant
df.fillna({"a": 0, "b": -1})      # per-column constant
df["a"].fillna(df["a"].mean())    # impute with the mean
df.ffill()                        # forward-fill (carry last valid down)
df.bfill()                        # back-fill (carry next valid up)
df.ffill(limit=1)                 # fill at most 1 consecutive gap
```

> [!NOTE]
> As of pandas 2.x the method form `fillna(method="ffill")` is deprecated — call the dedicated `df.ffill()` / `df.bfill()` instead.

## 4. Worked Example

A daily temperature log with gaps. We detect, then fill sensibly by column type.

```python
df = pd.DataFrame({
    "day":   pd.date_range("2026-01-01", periods=6, freq="D"),
    "temp":  [20.0, np.nan, np.nan, 26.0, np.nan, 30.0],
    "city":  ["NYC", "NYC", None, "NYC", "NYC", "NYC"],
    "sensor_id": pd.array([1, 1, 1, None, 2, 2], dtype="Int64"),
})

report = df.isna().sum()          # missing per column
```

**Missing per column:**

| column | missing |
|---|---|
| day | 0 |
| temp | 3 |
| city | 1 |
| sensor_id | 1 |

```python
clean = df.copy()
clean["temp"] = clean["temp"].interpolate()   # numeric -> linear interpolate
clean["city"] = clean["city"].ffill()         # categorical -> carry forward
clean["sensor_id"] = clean["sensor_id"].ffill()
```

**Result** (note `temp` filled by straight-line estimate, `sensor_id` stays `Int64`):

| day | temp | city | sensor_id |
|---|---|---|---|
| 2026-01-01 | 20.0 | NYC | 1 |
| 2026-01-02 | 22.0 | NYC | 1 |
| 2026-01-03 | 24.0 | NYC | 1 |
| 2026-01-04 | 26.0 | NYC | 1 |
| 2026-01-05 | 28.0 | NYC | 2 |
| 2026-01-06 | 30.0 | NYC | 2 |

Each column got the *right* strategy: interpolation for a continuous signal, forward-fill for a slowly-changing label. A blanket `fillna(0)` would have injected fake 0°C readings.

## 5. Under the Hood

Why does `None` sometimes become `NaN`? Because a NumPy `float64` array has no slot for a Python object — it can only store 64-bit floats, and IEEE-754 reserves a bit pattern for `NaN`. So pandas coerces. An **object** array, by contrast, holds pointers to real Python objects, so `None` survives there.

Nullable dtypes solve this with a **two-array design**: a values array plus a separate boolean **mask** marking which slots are missing. That mask is what lets `Int64` stay integer-typed while still expressing "absent" — the sentinel is not smuggled into the value bits.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two ways pandas stores missingness</text>

  <!-- NumPy float sentinel -->
  <rect x="30" y="50" width="300" height="110" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="180" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">NumPy float64 (sentinel)</text>
  <rect x="50" y="90" width="50" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="75" y="112" text-anchor="middle" fill="#1e293b">1.0</text>
  <rect x="105" y="90" width="50" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="130" y="112" text-anchor="middle" fill="#b91c1c">NaN</text>
  <rect x="160" y="90" width="50" height="34" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="185" y="112" text-anchor="middle" fill="#1e293b">4.0</text>
  <text x="180" y="148" text-anchor="middle" fill="#64748b">missing hides IN the value bits → forces float</text>

  <!-- Nullable mask -->
  <rect x="390" y="50" width="300" height="180" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="540" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">Nullable Int64 (values + mask)</text>
  <text x="415" y="104" fill="#64748b">values</text>
  <rect x="470" y="90" width="44" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="492" y="110" text-anchor="middle">1</text>
  <rect x="518" y="90" width="44" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="540" y="110" text-anchor="middle">2</text>
  <rect x="566" y="90" width="44" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/><text x="588" y="110" text-anchor="middle">?</text>
  <text x="415" y="164" fill="#64748b">mask</text>
  <rect x="470" y="150" width="44" height="30" rx="6" fill="#f1f5f9" stroke="#475569"/><text x="492" y="170" text-anchor="middle">F</text>
  <rect x="518" y="150" width="44" height="30" rx="6" fill="#f1f5f9" stroke="#475569"/><text x="540" y="170" text-anchor="middle">F</text>
  <rect x="566" y="150" width="44" height="30" rx="6" fill="#fee2e2" stroke="#b91c1c"/><text x="588" y="170" text-anchor="middle" fill="#b91c1c">T</text>
  <line x1="588" y1="122" x2="588" y2="148" stroke="#475569" marker-end="url(#ar)"/>
  <text x="540" y="212" text-anchor="middle" fill="#64748b">mask says "missing" → value bits stay integer, uses pd.NA</text>
</svg>
```

`isna()` on a nullable column just reads that mask — O(1) per element, no bit-pattern comparison. On a float column it does an element-wise `x != x` test (the `NaN`-identity trick).

## 6. Variations & Trade-offs

| Sentinel | Lives in | Type impact | `== ` self-test | Three-valued logic |
|---|---|---|---|---|
| `np.nan` (`NaN`) | float / object | upcasts int→float | `NaN == NaN` → False | No (comparisons give False) |
| `None` | object (kept), float (→NaN) | keeps object dtype | `None == None` → True | No |
| `pd.NA` | nullable ext dtypes | preserves Int/bool/string | returns `pd.NA` | **Yes** — propagates |
| `NaT` | datetime / timedelta | n/a | `NaT == NaT` → False | No |

The trade-off with **nullable dtypes**: they preserve integer/boolean semantics and give cleaner logic, but are newer, occasionally slower, and some third-party libraries (older scikit-learn, numba paths) still expect classic `float64`+`NaN`. For a greenfield analytics pipeline, `.convert_dtypes()` is a good default; for handing arrays to legacy numeric code, stay on classic NumPy dtypes.

`interpolate()` deserves its own note: unlike `fillna`, it *computes* replacements from neighbors — `method="linear"` (default), `"time"` (spacing-aware for datetime index), `"polynomial"`, `"spline"`. Great for continuous signals, wrong for categorical or truly-random-missing data.

## 7. Production / Performance Notes

- **Audit before you fill.** `df.isna().mean().sort_values(ascending=False)` gives the *fraction* missing per column — the single most useful one-liner for triaging a new dataset.
- **Never blanket-`fillna(0)`.** A 0 is a real value that pollutes means, sums, and models. Impute per column with a strategy that matches the semantics (mean/median for numeric, mode or a `"Unknown"` label for categorical, `ffill` for time series).
- **Watch the silent int→float upcast.** After a left join or a `reindex`, an ID column can become `float64` with `NaN`s (`1001.0`). Restore with `.astype("Int64")` (nullable) once cleaned.
- **`groupby` drops NaN keys by default.** A missing category vanishes from your aggregation. Pass `dropna=False` if the "unknown" bucket matters.
- **`ffill` across group boundaries leaks.** `df.ffill()` on a stacked multi-entity frame will carry one entity's last value into the next. Use `df.groupby("id").ffill()`.
- **Merges create missingness.** Non-matching rows in a left/outer join fill with `NaN`; use `indicator=True` to see where they came from (see *Merge, Join & Concat*).
- **Memory:** nullable dtypes cost one extra byte-per-element mask vs classic float, but let an ID stay `Int32`/`Int64` instead of `float64` — often a net win.

## 8. Common Mistakes

1. ⚠️ **Testing `df["x"] == np.nan`.** Always `False` — `NaN` is not equal to itself. **Fix:** use `df["x"].isna()`.
2. ⚠️ **`fillna(0)` on everything.** Turns "unknown" into a real zero, corrupting stats. **Fix:** impute per-column with a meaningful value; leave truly-unknown as `NA` if downstream can handle it.
3. ⚠️ **Assuming `dropna()` drops columns.** It drops **rows** by default (`axis=0`). **Fix:** pass `axis=1` for columns, and prefer `subset=` to target specific fields.
4. ⚠️ **Being surprised the int column is now float.** Introducing one `NaN` upcast it. **Fix:** use nullable `Int64` up front, or re-cast after cleaning.
5. ⚠️ **`ffill` across unrelated groups.** Leaks values between entities. **Fix:** `groupby(id).ffill()`.
6. ⚠️ **Forgetting `groupby(dropna=False)`.** A whole NaN-keyed category silently disappears from the report. **Fix:** set `dropna=False` when the missing bucket is meaningful.
7. ⚠️ **`mean()` "looks fine" with missing data.** `skipna=True` quietly averaged only present values — the denominator shrank. **Fix:** check `notna().sum()` and decide if that denominator is what you want.
8. ⚠️ **Reassigning without `inplace` or capture.** `df.fillna(0)` returns a new frame; the original is unchanged. **Fix:** `df = df.fillna(0)` (assignment is preferred over `inplace=True`).

## 9. Interview Questions

**Q: What is the difference between `NaN`, `None`, and `pd.NA`?**
A: `NaN` is a float sentinel (`np.nan`) used by NumPy-backed float/object columns and is not equal to itself. `None` is Python's null, preserved in object columns but coerced to `NaN` in float columns. `pd.NA` is the newer, dtype-agnostic scalar used by nullable extension dtypes (`Int64`, `boolean`, `string`); it propagates through operations with three-valued logic.

**Q: Why does adding a missing value to an integer column turn it into float?**
A: A NumPy `int64` array has no bit pattern to represent "missing," and `NaN` is a float value. To hold the `NaN`, pandas upcasts the whole column to `float64`. Nullable `Int64`, which stores a separate boolean mask, avoids this.

**Q: Why can't you detect missing values with `== np.nan`?**
A: IEEE-754 defines `NaN` as unordered and unequal to everything, including itself, so `np.nan == np.nan` is `False`. Detection must use `isna()`/`notna()`, which internally use the self-inequality trick or read the nullable mask.

**Q: What does `dropna(thresh=2)` do, and how does it differ from `how`?**
A: `thresh=2` keeps rows that have at least 2 non-null values (a count threshold). `how` is categorical: `how="any"` drops a row with any missing, `how="all"` only drops fully-missing rows. `thresh` overrides `how`.

**Q: When would you use `interpolate` instead of `fillna`?**
A: When the column is a continuous signal (temperature, price, sensor reading) where neighboring values estimate the gap. `interpolate` computes replacements from surrounding data (linear by default, `time`-aware for datetime indexes), whereas `fillna` inserts a constant or the last/next observed value.

**Q: How do `ffill` and `bfill` differ, and what's a danger with `ffill`?**
A: `ffill` carries the last valid value forward (down); `bfill` carries the next valid value backward (up). The danger is filling across group boundaries in a stacked frame, leaking one entity's value into another — guard with `groupby(id).ffill()`. Also use `limit=` to cap how many consecutive gaps get filled.

**Q: How does `groupby` treat missing keys, and why does it matter?**
A: By default `groupby` drops rows whose grouping key is missing (`dropna=True`), so an entire "unknown" category can silently vanish from an aggregation. Pass `dropna=False` to retain a `NaN` group.

**Q: What are nullable dtypes and when would you adopt them?** *(senior)*
A: `Int64`, `Float64`, `boolean`, and `string` are extension dtypes backed by a values array plus a boolean mask, using `pd.NA`. Adopt them when you need integers/booleans that can be missing without upcasting, or want consistent three-valued logic. Trade-off: newer, sometimes slower, and some legacy numeric libraries still expect classic `float64`+`NaN`. `df.convert_dtypes()` migrates a frame.

**Q: Explain three-valued logic with `pd.NA`.** *(senior)*
A: With `pd.NA`, comparisons and boolean ops that involve an unknown return `pd.NA` rather than `False`: `pd.NA > 5` is `pd.NA`, `pd.NA | True` is `True` (known short-circuit), `pd.NA & True` is `pd.NA`. This mirrors SQL NULL semantics and prevents silently treating unknowns as `False` in filters.

**Q: `skipna=True` is the default for reductions — what subtle bug can it cause?** *(senior)*
A: A `mean()` or `sum()` silently ignores missing values, shrinking the denominator/term count. Two columns with different missingness become non-comparable, and a "healthy-looking" average may be computed over a small fraction of rows. Inspect `notna().sum()` and decide whether skipping or `skipna=False` (poison-on-missing) matches the analysis intent.

## 10. Practice

- [ ] Build a DataFrame with a mix of `np.nan`, `None`, and `pd.NA`, then show that `isna()` catches all three identically.
- [ ] Take a numeric column with gaps and compare `fillna(mean)`, `ffill`, and `interpolate()` side by side; explain which is right for a temperature series.
- [ ] Create an `Int64` column with a missing value and prove it stays integer-typed while a plain `int64` upcasts to float.
- [ ] Given a stacked multi-entity time series, demonstrate the `ffill` leak and fix it with `groupby(id).ffill()`.
- [ ] Write a one-liner that reports the fraction missing per column, sorted descending.

## 11. Cheat Sheet

> [!TIP]
> **Detect:** `df.isna()` / `.notna()` (catch NaN, None, NaT, NA alike); `df.isna().mean()` = fraction missing per column.
> **Sentinels:** `NaN` = float sentinel (int→float upcast, `!=` itself); `None` = object null; `pd.NA` = nullable dtypes, propagates (3-valued logic); `NaT` = datetime.
> **Drop:** `dropna(how="any"|"all", thresh=N, subset=[...], axis=0|1)`.
> **Fill:** `fillna(value | dict)`, `ffill()`, `bfill()` (add `limit=`), `interpolate(method="linear"|"time")` for signals.
> **Golden rules:** never `== np.nan`; never blanket `fillna(0)`; `groupby(dropna=False)` to keep NaN groups; `groupby(id).ffill()` to avoid leaks; use `Int64` to keep integers missable.

**References:** pandas User Guide "Working with missing data", pandas "Nullable integer/boolean data types", NumPy docs on `nan`, Real Python "Working With Missing Data in pandas"

---
*NumPy & Pandas Handbook — topic 16.*
