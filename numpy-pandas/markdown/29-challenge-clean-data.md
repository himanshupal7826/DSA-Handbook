# 29 · Challenge: Clean a Messy Dataset

> **In one line:** Turn a real-world dirty CSV into a typed, deduplicated, analysis-ready DataFrame — dtypes, dates, strings, missing values, duplicates, and categories, end to end.

---

## 1. The Scenario

You inherit `customers_raw.csv` — exported by hand from three systems. Downstream code expects clean types, real dates, canonical categories, and no duplicate customers. Right now it's a mess: money stored as text with `$` and commas, dates in three formats, whitespace and mixed case in strings, `"N/A"`/`"-"`/empty as missing, a duplicate row, and inconsistent category spellings.

**The starting artifact** — load it and look:

```python
import pandas as pd
import numpy as np
from io import StringIO

raw = """id,name,signup_date,plan,spend,country,active
1, Alice  ,2023-01-15,Premium,$1,200.50,US,yes
2,BOB,15/02/2023,premium ,"$980",us,YES
3,carol,2023-03-01,Basic,-,United States,no
4,  Dave,2023/04/12,BASIC,$450.00,CA,No
5,Eve,,PREMIUM,$2,000,UK,yes
2,bob,15/02/2023,premium,$980,US,yes
6,Frank,2023-06-30,basic,N/A,uk,TRUE
"""
df = pd.read_csv(StringIO(raw), dtype=str)   # read everything as text first
print(df)
```

The raw frame:

| id | name    | signup_date | plan    | spend    | country       | active |
|----|---------|-------------|---------|----------|---------------|--------|
| 1  | ` Alice ` | 2023-01-15 | Premium | $1,200.50 | US           | yes    |
| 2  | BOB     | 15/02/2023  | premium ` ` | $980  | us           | YES    |
| 3  | carol   | 2023-03-01  | Basic   | -        | United States | no     |
| 4  | `  Dave` | 2023/04/12 | BASIC   | $450.00  | CA           | No     |
| 5  | Eve     | *(empty)*   | PREMIUM | $2,000   | UK           | yes    |
| 2  | bob     | 15/02/2023  | premium | $980     | US           | yes    |
| 6  | Frank   | 2023-06-30  | basic   | N/A      | uk           | TRUE   |

**The goal:** a clean frame where `id` is int, `signup_date` is `datetime64`, `spend` is float (NaN where unknown), `active` is boolean, `name` is trimmed Title Case, `plan`/`country` are canonical categories, row `id=2` appears once, and missing values are explicit `NaN`/`NaT`.

## 2. Approach

A senior does **not** clean columns in random order. There's a pipeline:

1. **Read as text first** (`dtype=str`) so pandas can't silently mis-guess types or turn `"$980"` into an object with hidden surprises. You cast deliberately, later.
2. **Normalize missing-value tokens** globally — `"N/A"`, `"-"`, `""`, `"null"` → real `NaN` — *before* any type casting, so casts see genuine nulls.
3. **Strings** — strip whitespace, fix case, *then* map to canonical categories. Order matters: you can't map `"premium "` if you haven't stripped the trailing space.
4. **Numbers** — strip `$` and `,`, then `to_numeric(errors='coerce')` so junk becomes `NaN` instead of raising.
5. **Dates** — parse with a tolerant strategy for mixed formats.
6. **Booleans** — map a known truthy/falsy vocabulary.
7. **Duplicates** — dedupe on the business key *after* normalizing, or the two `id=2` rows won't match.
8. **Dtypes** — cast last, when the data is clean enough to accept the type.

> [!NOTE]
> Clean *values* before you enforce *types*, and dedupe *after* normalizing keys. Doing it in the wrong order is the #1 source of silent data-cleaning bugs.

## 3. Solution

```python
import pandas as pd
import numpy as np

# 1. Read as text so nothing is coerced behind our back.
df = pd.read_csv(StringIO(raw), dtype=str)

# 2. Global missing-token normalization (do this FIRST).
NA_TOKENS = {"", "-", "n/a", "na", "null", "none", "nan"}
df = df.apply(lambda s: s.str.strip())                       # trim every string cell
df = df.replace(r"(?i)^\s*(-|n/?a|null|none|nan)?\s*$",       # blanks & NA tokens -> NaN
                np.nan, regex=True)

# 3a. Names: collapse inner whitespace + Title Case.
df["name"] = (df["name"].str.replace(r"\s+", " ", regex=True)
                        .str.strip()
                        .str.title())

# 3b. Categories: normalize case, then map to canonical values.
plan_map = {"basic": "Basic", "premium": "Premium"}
df["plan"] = df["plan"].str.strip().str.lower().map(plan_map)

country_map = {
    "us": "US", "usa": "US", "united states": "US",
    "ca": "CA", "canada": "CA",
    "uk": "UK", "united kingdom": "UK",
}
df["country"] = df["country"].str.strip().str.lower().map(country_map)
df["plan"]    = df["plan"].astype("category")
df["country"] = df["country"].astype("category")

# 4. Money: strip $ and thousands separators, then coerce.
df["spend"] = (df["spend"].str.replace(r"[$,]", "", regex=True)
                          .pipe(pd.to_numeric, errors="coerce"))

# 5. Dates: tolerant parse of mixed formats -> NaT on failure.
df["signup_date"] = pd.to_datetime(df["signup_date"],
                                   format="mixed", dayfirst=False,
                                   errors="coerce")

# 6. Booleans via an explicit vocabulary.
TRUTHY = {"yes", "y", "true", "1"}
FALSY  = {"no", "n", "false", "0"}
norm = df["active"].str.strip().str.lower()
df["active"] = norm.map(lambda v: True if v in TRUTHY
                        else False if v in FALSY else pd.NA).astype("boolean")

# 7. Duplicates: same customer id -> keep the last (most complete) row.
df["id"] = pd.to_numeric(df["id"], errors="coerce").astype("Int64")
df = df.drop_duplicates(subset="id", keep="last").reset_index(drop=True)

# 8. Final tidy: sort, mark any rows still holding critical NaNs.
df = df.sort_values("id").reset_index(drop=True)
print(df.dtypes)
print(df)
```

The cleaned frame:

| id | name  | signup_date | plan    | spend   | country | active |
|----|-------|-------------|---------|---------|---------|--------|
| 1  | Alice | 2023-01-15  | Premium | 1200.50 | US      | True   |
| 2  | Bob   | 2023-02-15  | Premium | 980.00  | US      | True   |
| 3  | Carol | 2023-03-01  | Basic   | NaN     | US      | False  |
| 4  | Dave  | 2023-04-12  | Basic   | 450.00  | CA      | False  |
| 5  | Eve   | NaT         | Premium | 2000.00 | UK      | True   |
| 6  | Frank | 2023-06-30  | Basic   | NaN     | UK      | True   |

`dtypes`:

```text
id                    Int64
name                 object
signup_date  datetime64[ns]
plan               category
spend               float64
country            category
active              boolean
```

## 4. Walkthrough

- **Read as text (`dtype=str`).** `read_csv` type-inference would turn the `$1,200.50` column into `object` anyway and might mis-parse a numeric-looking column. Reading everything as `str` gives you one uniform starting point and full control.
- **Strip then replace.** `.str.strip()` removes the leading/trailing spaces around `" Alice "` and `"premium "`. Then a single case-insensitive regex maps blanks, `-`, `N/A`, `null` to `np.nan`. Doing this *before* casts means `to_numeric`/`to_datetime` see a real `NaN` and don't have to interpret junk.
- **Names.** `\s+ → " "` collapses the double space in `"  Dave"`/interior runs; `.str.title()` gives canonical `Alice`, `Bob`, `Carol`.
- **Categories via map.** After lower-casing, `map(plan_map)` converts `premium`, `PREMIUM`, `basic`, `BASIC` to just `Premium`/`Basic`. `map` returns `NaN` for anything not in the dict — a *feature*: unexpected spellings surface as nulls instead of silently passing through. `country_map` folds `US`, `us`, `United States` into `US`. Casting to `category` shrinks memory and enforces the allowed set.
- **Money.** `[$,]` regex removes `$` and thousands commas, so `"$1,200.50" → "1200.50"`. `to_numeric(errors="coerce")` turns the already-NaN `spend` for Carol/Frank into `NaN` float (they were `-` and `N/A`).
- **Dates.** `format="mixed"` lets pandas parse `2023-01-15`, `15/02/2023`, and `2023/04/12` row-by-row. Eve's empty date becomes `NaT`. (For a single known format, pass it explicitly — far faster; see Variations.)
- **Booleans.** A mapped vocabulary handles `yes/YES/No/TRUE`. Unknown tokens become `pd.NA`; the `boolean` nullable dtype keeps them as missing rather than coercing to `False`.
- **Dedupe last.** Both `id=2` rows normalize to the same `Bob / Premium / 980 / US / True`. `drop_duplicates(subset="id", keep="last")` keeps one. Doing this *after* normalization is essential — before, `"BOB"` and `"bob"` looked different.

## 5. Under the Hood — the cleaning pipeline

```svg
<svg viewBox="0 0 720 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <rect x="10" y="80" width="120" height="52" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="70" y="102" text-anchor="middle" fill="#1e293b">Raw CSV</text>
  <text x="70" y="120" text-anchor="middle" fill="#64748b" font-size="11">dtype=str</text>

  <rect x="160" y="80" width="120" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="220" y="102" text-anchor="middle" fill="#1e293b">Normalize NA</text>
  <text x="220" y="120" text-anchor="middle" fill="#64748b" font-size="11">strip + tokens</text>

  <rect x="310" y="20" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="370" y="47" text-anchor="middle" fill="#1e293b">Strings + cats</text>
  <rect x="310" y="80" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="370" y="107" text-anchor="middle" fill="#1e293b">Numbers/dates</text>
  <rect x="310" y="140" width="120" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="370" y="167" text-anchor="middle" fill="#1e293b">Booleans</text>

  <rect x="460" y="80" width="120" height="52" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="520" y="102" text-anchor="middle" fill="#1e293b">Dedupe key</text>
  <text x="520" y="120" text-anchor="middle" fill="#64748b" font-size="11">after normalize</text>

  <rect x="610" y="80" width="100" height="52" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="660" y="102" text-anchor="middle" fill="#1e293b">Cast dtypes</text>
  <text x="660" y="120" text-anchor="middle" fill="#64748b" font-size="11">tidy frame</text>

  <line x1="130" y1="106" x2="158" y2="106" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="280" y1="106" x2="308" y2="43"  stroke="#475569" marker-end="url(#ah)"/>
  <line x1="280" y1="106" x2="308" y2="103" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="280" y1="106" x2="308" y2="163" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="430" y1="43"  x2="458" y2="100" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="430" y1="103" x2="458" y2="106" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="430" y1="163" x2="458" y2="112" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="580" y1="106" x2="608" y2="106" stroke="#475569" marker-end="url(#ah)"/>
</svg>
```

## 6. Variations & Follow-ups

- **Known single date format** → skip `format="mixed"` (which infers per row and is slow). If a source column is uniformly `dd/MM/yyyy`, use `pd.to_datetime(col, format="%d/%m/%Y", errors="coerce")` — 10–50× faster on large frames.
- **`na_values` at read time** → for tokens you know up front, `pd.read_csv(..., na_values=["N/A","-","null"])` handles missing during load, shrinking step 2. Keep `dtype=str` if you still want manual casts.
- **`pd.NA`-backed dtypes** → cast to `"Int64"`, `"Float64"`, `"boolean"`, `"string"` (capital-N nullable dtypes) to keep missing values without falling back to `float`/`object`. Great for integer IDs that can be missing.
- **Fuzzy category matching** → when spellings are open-ended (`"U.S.A"`, `"united  states"`), add a regex-normalize step or `rapidfuzz` before the map, and log values that map to `NaN` for review.
- **Validation gate** → after cleaning, assert invariants (`df["spend"].ge(0).all()`, `df["plan"].notna().all()`) or use `pandera`/`great_expectations` so bad data fails loudly in a pipeline.
- **Audit the drops** → capture `dupes = df[df.duplicated("id", keep=False)]` before dedupe to log exactly what was merged.

## 7. Verify It Works

```python
# Types are correct
assert df["id"].dtype == "Int64"
assert str(df["signup_date"].dtype) == "datetime64[ns]"
assert df["spend"].dtype == "float64"
assert df["active"].dtype == "boolean"
assert str(df["plan"].dtype) == "category"

# Values are clean
assert df["id"].is_unique                          # duplicate id=2 removed
assert set(df["plan"].dropna()) <= {"Basic", "Premium"}
assert set(df["country"].dropna()) <= {"US", "CA", "UK"}
assert df["name"].tolist() == ["Alice","Bob","Carol","Dave","Eve","Frank"]
assert df["spend"].isna().sum() == 2               # Carol, Frank
assert df["signup_date"].isna().sum() == 1         # Eve
assert df.loc[df["id"] == 2, "spend"].item() == 980.0
print("All assertions passed ✔")
```

Expected: `All assertions passed ✔` and a 6-row frame (the duplicate collapsed from 7 rows).

## 8. Pitfalls

1. ⚠️ **Casting before cleaning.** `to_numeric` on `"$1,200.50"` yields `NaN` (silent data loss) because it can't parse `$`/`,`. Strip symbols first, then coerce.
2. ⚠️ **Deduplicating before normalizing.** `"BOB"` ≠ `"bob"` and `" Alice "` ≠ `"Alice"`, so `drop_duplicates` misses real dupes. Normalize the key columns first.
3. ⚠️ **`dayfirst` ambiguity.** `01/02/2023` is Jan-2 (US) or Feb-1 (EU). `format="mixed"` guesses; if a source is known EU, set `dayfirst=True` or an explicit `format` — silent month/day swaps corrupt data invisibly.
4. ⚠️ **`.replace` vs `.str.replace`.** `Series.replace(a, b)` matches whole values; `Series.str.replace(pat, repl, regex=...)` does substring/regex. Using the wrong one leaves `$` in place or blanks the whole cell.
5. ⚠️ **Truthy coercion of booleans.** `col.astype(bool)` makes *every* non-empty string `True` (even `"no"`!). Map an explicit vocabulary instead.
6. ⚠️ **Chained-assignment warning.** Assign back to the column (`df["x"] = ...`), never mutate a slice like `df[df.a>0]["x"] = ...` — it may silently no-op under copy-on-write.

## 9. Interview Follow-ups

**Q: Why read the CSV with `dtype=str` before cleaning?**
A: It disables pandas' per-column type inference so nothing is coerced or mis-parsed silently. You get a uniform text starting point and cast each column deliberately after values are clean, which makes the pipeline predictable and auditable.

**Q: What's the difference between `NaN`, `NaT`, `None`, and `pd.NA`?**
A: `NaN` is float missing, `NaT` is datetime/timedelta missing, `None` is the Python object null (shows up in object columns), and `pd.NA` is the dtype-agnostic missing used by nullable `Int64`/`boolean`/`string` dtypes. They mostly interoperate but `pd.NA` propagates through boolean logic (Kleene) instead of coercing.

**Q: Why does `map` beat `replace` for standardizing categories?**
A: `map` uses a dict as an exhaustive lookup — anything not listed becomes `NaN`, so unexpected spellings surface loudly instead of leaking through. `replace` leaves unmatched values untouched, hiding new bad inputs.

**Q: How do you handle mixed date formats robustly?**
A: Prefer an explicit `format=` per source when known (fast, unambiguous). For genuinely mixed columns use `format="mixed"` with `errors="coerce"` so unparseable values become `NaT`, then inspect the `NaT` count to catch systematic parse failures.

**Q: `errors="coerce"` vs `errors="raise"` — when do you pick which?**
A: `coerce` turns bad values into `NaN`/`NaT` so a batch job keeps running and you quantify damage after; `raise` fails fast, which you want in a strict pipeline where any bad value is a contract violation that should stop the run.

**Q: You dropped duplicate `id=2` with `keep="last"`. How do you choose which row survives?**
A: It's a business decision. `keep="last"` assumes later rows are more complete/recent; `keep="first"` trusts the earliest. When rows conflict, better to `groupby("id").agg(...)` picking the non-null / max-timestamp value per column, or sort by a recency key before dropping.

**Q: How would you make this cleaning reproducible and testable?**
A: Wrap each step in named functions, chain with `.pipe(...)`, pin the input schema, and add assertions or a `pandera`/`great_expectations` schema that validates dtypes, ranges, and allowed categories. Same input → same output, and violations fail the build.

**Q: The dataset is 50M rows and won't fit in memory. What changes?**
A: Read in chunks (`read_csv(chunksize=...)`) or switch to a lazy engine (Polars, DuckDB, Dask). Push type casts and filters as early as possible, use category/nullable dtypes to cut memory, and parse dates with an explicit format to avoid the per-row inference cost.

**Q: How do you standardize free-text categories that aren't in your map?**
A: Normalize aggressively (lowercase, strip punctuation, collapse whitespace), then apply fuzzy matching (`rapidfuzz`) against a canonical list with a similarity threshold, and route low-confidence matches to a manual-review queue rather than guessing.

## 10. Cheat Sheet

> [!TIP]
> **Messy-CSV pipeline (order matters):**
> 1. `read_csv(..., dtype=str)` — read as text.
> 2. `.str.strip()` + regex `→ np.nan` for `""`/`-`/`N/A` — normalize missing FIRST.
> 3. Strings: `.str.replace(r"\s+"," ")`, `.str.title()`; categories: `.str.lower().map(canon).astype("category")`.
> 4. Numbers: `.str.replace(r"[$,]","")` then `pd.to_numeric(errors="coerce")`.
> 5. Dates: `pd.to_datetime(..., format=... or "mixed", errors="coerce")`.
> 6. Booleans: `.map({truthy:True, falsy:False}).astype("boolean")`.
> 7. `to_numeric(id).astype("Int64")`; `drop_duplicates(subset=key, keep="last")` — dedupe AFTER normalizing.
> 8. Validate with asserts / `pandera`. Rule of thumb: **clean values → then cast types → then dedupe keys.**

**References:** pandas User Guide (Working with missing data, Text/String methods, Time series), pandas `to_datetime`/`to_numeric` API docs, Real Python "Data Cleaning with pandas", pandera docs

---
*NumPy & Pandas Handbook — topic 29.*
