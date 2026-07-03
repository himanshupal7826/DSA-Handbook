# 24 · Categorical & String Data

> **In one line:** the `category` dtype stores a column of repeated labels as small integer codes (huge memory + speed wins), while the `.str` accessor vectorizes text operations across a whole Series.

---

## 1. Overview

Two of the most common non-numeric column types are **low-cardinality labels** ("country", "status", "plan_tier") and **free text** ("email", "product_name", "log_line"). pandas has a specialized tool for each: the **`category` dtype** for the former, the **`.str` accessor** for the latter.

A `category` column stores each distinct value **once** in a lookup table (the *categories*) and represents the actual column as an array of tiny integer **codes** pointing into it. A million-row `object` column holding just `"US"`/`"UK"`/`"IN"` might take ~60 MB; as `category` it drops to ~1 MB plus a three-entry lookup. Beyond memory, `groupby`, `value_counts`, and comparisons get faster because they operate on integers, and you can encode a **meaningful order** (`XS < S < M < L`) for correct sorting and comparisons.

The **`.str` accessor** exposes Python string methods (`.lower()`, `.contains()`, `.split()`, `.extract()`, `.replace()`) in a **vectorized, null-safe** form: `s.str.lower()` instead of a Python loop. It also handles regex and returns proper missing values for `NaN` inputs instead of crashing.

You reach for `category` when a text column repeats a small set of values many times; for `.str` whenever you clean, parse, or match text. Knowing *when `category` hurts* (high cardinality, constant mutation) is as important as knowing when it helps.

## 2. Core Concepts

- **`category` dtype** — two parts: the **categories** (unique values, stored once) and integer **codes** (`int8`/`int16`…) indexing into them. Access via `s.cat.categories` and `s.cat.codes`.
- **Memory win** — codes are 1–2 bytes each vs a full string/object pointer per row; the win grows with row count and shrinks with cardinality (number of distinct values).
- **Speed win** — grouping, joining, and comparing on integer codes is faster than on strings; `value_counts` and `groupby` are notably quicker.
- **Ordered categories** — `pd.Categorical(vals, categories=[...], ordered=True)` gives a meaningful `<`/`>` and correct sort (sizes, grades), unlike alphabetical string order.
- **`.cat` accessor** — category-specific methods: `add_categories`, `remove_categories`, `remove_unused_categories`, `rename_categories`, `reorder_categories`, `set_categories`, `as_ordered`.
- **`.str` accessor** — vectorized string ops on a Series: `contains`, `startswith`, `extract`, `split`, `replace`, `len`, `lower`, `strip`, `pad`, `get`, and regex variants; null-safe (returns `NaN` for missing).
- **`str` vs `object`** — text can be classic `object` dtype or the newer nullable `string` dtype (`dtype="string"`), which uses `pd.NA` and is more explicit; both support `.str`.
- **When category hurts** — high-cardinality columns (near-unique values, e.g. user IDs) gain nothing and pay overhead; frequent appends/edits force expensive category rebuilds; some ops silently fall back to object.

## 3. Syntax & Examples

```python
import pandas as pd

s = pd.Series(["US", "UK", "US", "IN", "UK", "US"])

# Convert to category
c = s.astype("category")
c.cat.categories        # Index(['IN', 'UK', 'US'])
c.cat.codes             # [2, 1, 2, 0, 1, 2]  (int8)

c.memory_usage(deep=True)   # much smaller than s.memory_usage(deep=True)

# Ordered category — meaningful comparison & sort
size = pd.Categorical(
    ["M", "XS", "L", "S"],
    categories=["XS", "S", "M", "L", "XL"],
    ordered=True,
)
pd.Series(size).sort_values()   # XS < S < M < L  (NOT alphabetical)
(pd.Series(size) > "S")         # element-wise ordered comparison
```

```python
# --- .cat methods ---
c = pd.Series(["a", "b", "a"]).astype("category")
c.cat.add_categories(["c"])          # extend the domain
c.cat.rename_categories({"a": "A"})  # relabel
c.cat.reorder_categories(["b", "a"], ordered=True)
c.cat.remove_unused_categories()     # drop categories no row uses
```

```python
# --- .str accessor ---
emails = pd.Series(["Ana <ana@x.com>", "ben@y.io", None, "CY@z.NET"])

emails.str.lower()                       # null-safe: None -> NaN
emails.str.contains("y", na=False)       # boolean mask (na=False avoids NaN in filter)
emails.str.extract(r"([\w.]+)@([\w.]+)")  # regex groups -> 2 columns
emails.str.split("@").str[-1]            # domain part
emails.str.replace(r"<|>", "", regex=True)
emails.str.len()                         # length per string (NaN stays NaN)

# chaining
(emails.str.strip()
       .str.extract(r"([\w.]+)@")[0]
       .str.upper())
```

## 4. Worked Example

A 1M-row survey with a repeated `country` label and a `raw_email` field to parse. Convert the label to `category` for memory, parse the email with `.str`.

```python
import pandas as pd, numpy as np

n = 1_000_000
df = pd.DataFrame({
    "country": np.random.choice(["US", "UK", "IN", "DE"], n),
    "raw_email": np.random.choice(
        ["a@GMAIL.com", "b@corp.io", "c@gmail.com"], n),
})

before = df["country"].memory_usage(deep=True)
df["country"] = df["country"].astype("category")
after = df["country"].memory_usage(deep=True)

df["domain"] = df["raw_email"].str.lower().str.split("@").str[-1]
by_domain = df["domain"].value_counts()
```

**Memory of the `country` column:**

| representation | approx bytes | note |
|---|---|---|
| object (strings) | ~62 MB | one pointer + string per row |
| category | ~1 MB | int8 codes + 4-entry lookup |

**`domain` value counts:**

| domain | count |
|---|---|
| gmail.com | ~666,000 |
| corp.io | ~334,000 |

The `country` column shrank ~60× with zero information loss, and grouping on it is now integer-fast. The `.str` chain lowercased and split a million emails without a Python loop, correctly unifying `GMAIL.com` and `gmail.com`. A `groupby("country")` on the categorical version runs materially faster than on the original object column.

## 5. Under the Hood

A `Categorical` is physically two arrays. The **categories** array holds each distinct value once (the dictionary). The **codes** array is a compact integer array (`int8` for ≤128 categories) where each entry is the index of that row's value in the categories array. `-1` is the code reserved for missing.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a4" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">category = codes (tiny ints) + categories (lookup)</text>

  <!-- original -->
  <text x="120" y="58" text-anchor="middle" fill="#64748b">object column</text>
  <g fill="#1e293b">
    <rect x="60" y="66" width="120" height="26" rx="5" fill="#fff7ed" stroke="#d97706"/><text x="120" y="84" text-anchor="middle">"US"</text>
    <rect x="60" y="94" width="120" height="26" rx="5" fill="#fff7ed" stroke="#d97706"/><text x="120" y="112" text-anchor="middle">"UK"</text>
    <rect x="60" y="122" width="120" height="26" rx="5" fill="#fff7ed" stroke="#d97706"/><text x="120" y="140" text-anchor="middle">"US"</text>
    <rect x="60" y="150" width="120" height="26" rx="5" fill="#fff7ed" stroke="#d97706"/><text x="120" y="168" text-anchor="middle">"IN"</text>
    <rect x="60" y="178" width="120" height="26" rx="5" fill="#fff7ed" stroke="#d97706"/><text x="120" y="196" text-anchor="middle">"US"</text>
  </g>
  <text x="120" y="228" text-anchor="middle" fill="#64748b">each row stores full string</text>

  <line x1="190" y1="135" x2="270" y2="135" stroke="#475569" marker-end="url(#a4)"/>

  <!-- codes -->
  <text x="360" y="58" text-anchor="middle" fill="#64748b">codes (int8)</text>
  <g>
    <rect x="320" y="66" width="80" height="26" rx="5" fill="#eff6ff" stroke="#2563eb"/><text x="360" y="84" text-anchor="middle">2</text>
    <rect x="320" y="94" width="80" height="26" rx="5" fill="#eff6ff" stroke="#2563eb"/><text x="360" y="112" text-anchor="middle">1</text>
    <rect x="320" y="122" width="80" height="26" rx="5" fill="#eff6ff" stroke="#2563eb"/><text x="360" y="140" text-anchor="middle">2</text>
    <rect x="320" y="150" width="80" height="26" rx="5" fill="#eff6ff" stroke="#2563eb"/><text x="360" y="168" text-anchor="middle">0</text>
    <rect x="320" y="178" width="80" height="26" rx="5" fill="#eff6ff" stroke="#2563eb"/><text x="360" y="196" text-anchor="middle">2</text>
  </g>

  <line x1="410" y1="135" x2="490" y2="135" stroke="#475569" marker-end="url(#a4)"/>

  <!-- categories -->
  <text x="590" y="58" text-anchor="middle" fill="#64748b">categories (stored once)</text>
  <g fill="#1e293b">
    <rect x="500" y="94" width="180" height="26" rx="5" fill="#ecfdf5" stroke="#059669"/><text x="590" y="112" text-anchor="middle">0 → "IN"</text>
    <rect x="500" y="122" width="180" height="26" rx="5" fill="#ecfdf5" stroke="#059669"/><text x="590" y="140" text-anchor="middle">1 → "UK"</text>
    <rect x="500" y="150" width="180" height="26" rx="5" fill="#ecfdf5" stroke="#059669"/><text x="590" y="168" text-anchor="middle">2 → "US"</text>
  </g>
  <text x="590" y="230" text-anchor="middle" fill="#64748b">3 strings total, not 5</text>
</svg>
```

This is why the memory win scales with **rows / distinct-values**: many rows, few categories → huge savings. It also explains the failure mode — if nearly every value is unique (a user ID), the categories array is as big as the column *plus* you pay for the codes array, so it's strictly worse. Operations like `groupby` and merges compare the small integer codes instead of hashing full strings, which is where the speed comes from.

## 6. Variations & Trade-offs

| Aspect | `object` (strings) | `category` |
|---|---|---|
| Storage | full value per row | int codes + one lookup |
| Best when | high cardinality / free text | low cardinality, repeated |
| groupby / value_counts | hashes strings | compares ints (faster) |
| Ordering | alphabetical only | custom order via `ordered=True` |
| Mutation (append new value) | trivial | may need `add_categories` |
| Memory (1M rows, 4 labels) | tens of MB | ~1 MB |

**`category` vs plain `object`:** category wins on memory and speed for repeated labels and unlocks meaningful ordering. It costs flexibility — assigning a value outside the category set raises unless you extend categories first, and heavy mutation triggers rebuilds.

**`.str` vs a Python loop / `.apply(str.lower)`:** `.str` methods run in optimized C where possible, are null-safe (skip `NaN` gracefully), and read cleanly with chaining. A per-element `.apply` pays Python overhead and needs manual `NaN` guards. For most text cleaning, `.str` is both faster and safer.

**`object` text vs nullable `string` dtype:** `dtype="string"` is the explicit, `pd.NA`-based text type; it prevents accidentally mixing numbers/strings and interoperates with nullable dtypes. It's the recommended forward-looking choice, though `object` remains the default.

## 7. Production / Performance Notes

- **Convert repeated-label columns early.** `df[col] = df[col].astype("category")` right after load cuts memory and speeds every subsequent `groupby`/`merge`. Sweep candidates with `df.select_dtypes("object").nunique()` and convert the low-cardinality ones.
- **Don't categorize high-cardinality columns.** IDs, emails, free text gain nothing and often cost more. Rule of thumb: categorize when distinct values ≪ row count (e.g. under a few % ).
- **Beware category mutation cost.** Appending rows with new labels, or `concat`-ing frames with different category sets, can silently upcast to object or require `set_categories`/`union_categories`. Align categories before combining.
- **`groupby` on category keeps unused categories.** By default `groupby(cat_col)` yields a row for *every* category even those with no data (and can be slow/wide). Use `observed=True` to only include present combinations.
- **Use `na=False` in `.str.contains` for filtering.** Missing values otherwise produce `NaN` in the mask, which raises when used for boolean indexing. `df[df.col.str.contains("x", na=False)]`.
- **Precompile intent with regex flags.** `.str.contains(pat, case=False, regex=True)` beats lowercasing then matching; `.str.extract` with named groups yields tidy columns in one pass.
- **Memory audit:** always use `memory_usage(deep=True)` — the shallow version undercounts object strings, hiding the true saving from categorizing.

## 8. Common Mistakes

1. ⚠️ **Categorizing a near-unique column.** A user-ID column as `category` uses *more* memory. **Fix:** only categorize low-cardinality columns (distinct ≪ rows).
2. ⚠️ **`groupby` on a category exploding into empty groups.** Every category appears even with no rows. **Fix:** `groupby(col, observed=True)`.
3. ⚠️ **`.str.contains` breaking a filter on missing values.** `NaN` in the mask raises during boolean indexing. **Fix:** pass `na=False`.
4. ⚠️ **Assigning an unknown value to a category column.** Raises `ValueError` because it's not in the category set. **Fix:** `cat.add_categories([...])` first, or use `set_categories`.
5. ⚠️ **Expecting alphabetical order to be meaningful.** `"L" < "M" < "S" < "XS"` sorts wrong for sizes. **Fix:** ordered categorical with an explicit `categories=` order.
6. ⚠️ **Concatenating frames with mismatched categories.** Result silently downgrades to object or loses order. **Fix:** align via `union_categories` / `set_categories` before `concat`.
7. ⚠️ **Using `.apply(lambda x: x.lower())` for text.** Slow and crashes on `NaN`. **Fix:** vectorized `.str.lower()` (null-safe).
8. ⚠️ **Forgetting `regex=True`/`regex=False`.** Recent pandas defaults `.str.replace` to literal in some versions; a pattern silently doesn't match. **Fix:** pass `regex=` explicitly.

## 9. Interview Questions

**Q: How is the `category` dtype stored, and why does it save memory?**
A: As two arrays — a *categories* lookup holding each distinct value once, and a *codes* array of small integers (`int8`/`int16`) where each row stores the index of its value in the categories. Repeated labels collapse to 1–2-byte codes instead of a full string per row, so memory savings scale with rows÷distinct-values.

**Q: When does converting to `category` hurt rather than help?**
A: When cardinality is high (values near-unique, like IDs), the categories array is as large as the column and you additionally pay for codes — strictly worse memory. It also hurts under heavy mutation, since appending new labels or concatenating mismatched category sets forces rebuilds or downgrades to object.

**Q: What's the benefit of an ordered categorical?**
A: It defines a meaningful order for the labels (`XS < S < M < L`), so `<`/`>` comparisons and `sort_values` respect domain order instead of alphabetical order. Created with `ordered=True` and an explicit `categories=` sequence.

**Q: What does the `.str` accessor give you over plain Python string methods?**
A: Vectorized, null-safe string operations across an entire Series — `s.str.lower()`, `.contains()`, `.extract()`, `.split()`, `.replace()` — running in optimized code where possible and returning `NaN`/`pd.NA` for missing inputs instead of raising, with clean chaining.

**Q: How do you extract structured fields from a text column?**
A: `s.str.extract(pattern)` with regex capture groups returns a DataFrame with one column per group; named groups become column names. For splitting, `s.str.split(sep, expand=True)` returns columns. Both are vectorized over the whole Series.

**Q: Why might `df[df.col.str.contains("x")]` raise, and how do you fix it?**
A: If `col` has missing values, `.str.contains` returns `NaN` for those rows, and `NaN` in a boolean mask raises during indexing. Pass `na=False` (treat missing as not-matching) so the mask is fully boolean.

**Q: Name three `.cat` methods and what they do.**
A: `add_categories` extends the allowed value set; `remove_unused_categories` drops categories no row uses (shrinks the lookup); `reorder_categories`/`set_categories` change order or the full domain (e.g. to make it ordered). Others include `rename_categories` and `as_ordered`.

**Q: You categorized a column, then a groupby got slower and produced empty groups. Why?** *(senior)*
A: By default `groupby` on a categorical includes *every* category, even those with no matching rows, producing empty groups and, with multiple categorical keys, a Cartesian blow-up of combinations. Pass `observed=True` to restrict to combinations actually present.

**Q: How do memory savings from `category` scale, and how would you decide which columns to convert?** *(senior)*
A: Savings ≈ proportional to rows÷distinct-values, so many rows with few labels win big and near-unique columns lose. Decide by computing `nunique()` (or the ratio to `len`) on object columns via `select_dtypes("object")`, then convert those with low cardinality and measure with `memory_usage(deep=True)`.

**Q: What's the difference between the classic `object` string type and the nullable `string` dtype?** *(senior)*
A: `object` is an untyped container that can hold mixed Python objects and uses `NaN`/`None` for missing; the nullable `string` dtype (`dtype="string"`) is an explicit text type using `pd.NA`, preventing accidental mixing with numbers and interoperating with other nullable dtypes. Both support `.str`; `string` is the recommended forward-looking choice.

## 10. Practice

- [ ] Convert a repeated-label column to `category` and measure the memory drop with `memory_usage(deep=True)`.
- [ ] Build an ordered categorical for T-shirt sizes and show `sort_values` orders them by size, not alphabetically.
- [ ] Parse an email column into `local` and `domain` columns using a single `.str.extract` regex.
- [ ] Filter rows whose text column contains a substring case-insensitively, handling missing values with `na=False`.
- [ ] Take a high-cardinality ID column, categorize it, and demonstrate that memory went *up* — then explain why.

## 11. Cheat Sheet

> [!TIP]
> **Category:** `s.astype("category")` → codes (int) + categories (lookup). Inspect `s.cat.codes`, `s.cat.categories`. Ordered: `pd.Categorical(v, categories=[...], ordered=True)`.
> **.cat methods:** add/remove/rename/reorder/set_categories, remove_unused_categories, as_ordered.
> **When it helps:** low cardinality, many rows → big memory + faster groupby/merge. **When it hurts:** near-unique columns, heavy mutation.
> **.str accessor:** `contains(na=False)`, `extract(regex)`, `split(sep, expand=True)`, `replace(pat, repl, regex=True)`, `lower/strip/len/get`. Vectorized + null-safe; chain freely.
> **Golden rules:** `groupby(cat, observed=True)`; `na=False` in filters; align categories before concat; prefer `.str` over `.apply`; audit with `memory_usage(deep=True)`.

**References:** pandas User Guide "Categorical data", pandas "Working with text data", pandas `.str`/`.cat` API reference, "pandas Cookbook — Categoricals"

---
*NumPy & Pandas Handbook — topic 24.*
