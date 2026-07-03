# 14 · Selection: loc, iloc & Boolean Masks

> **In one line:** Select rows and columns by **label** (`loc`), by **position** (`iloc`), or by **condition** (boolean masks) — and stop using chained `[]`.

---

## 1. Overview

Once data is in a **DataFrame**, almost everything you do starts with *selecting a subset*: some rows, some columns, or the cells that satisfy a condition. Pandas gives you three orthogonal tools and the whole game is knowing which one to reach for.

- **`.loc[]`** selects by **label** (the index/column *names*), and is **inclusive** of the stop label.
- **`.iloc[]`** selects by **integer position** (0-based), and is **exclusive** of the stop — like normal Python slicing.
- **Boolean masks** select rows where a condition is `True`.

Getting this right matters because the wrong tool silently returns the wrong rows (label vs position), and the classic `df[df.a > 0]['b'] = ...` pattern triggers the dreaded **`SettingWithCopyWarning`** and may not write back at all.

## 2. Core Concepts

- **Label vs position** — `loc` speaks names, `iloc` speaks positions. An integer index makes them look the same until the index isn't `0..n`.
- **`loc` is inclusive** on both ends: `df.loc[2:5]` returns labels 2,3,4,**5**. `iloc[2:5]` returns positions 2,3,4.
- **Row + column in one call** — `df.loc[rows, cols]` / `df.iloc[rows, cols]` selects both axes at once (faster and clearer than chaining).
- **Boolean mask** — a Series of `True`/`False` aligned to the index; `df[mask]` or `df.loc[mask, cols]` keeps the `True` rows.
- **Combine conditions** with `&` (and), `|` (or), `~` (not) — and **wrap each in parentheses** (they bind tighter than comparisons).
- **`.query("a > 0 and b == 'x'")`** — a readable string form, great for long filters.
- **`isin([...])`** for set membership; **`between(lo, hi)`** for ranges.
- **View vs copy** — selection may return a view or a copy; never assign through a *chained* selection. Use a single `.loc[...]`.

## 3. Syntax & Examples

```python
import pandas as pd
df = pd.DataFrame(
    {"name": ["Ana","Bo","Cy","Di"], "dept": ["eng","eng","sales","sales"], "salary": [120, 90, 75, 110]},
    index=["u1","u2","u3","u4"])

# --- label-based (loc) ---
df.loc["u2"]                    # one row (as a Series)
df.loc["u1":"u3", ["name","salary"]]   # rows u1..u3 INCLUSIVE, two columns
df.loc[:, "salary"]             # every row, one column

# --- position-based (iloc) ---
df.iloc[0]                      # first row
df.iloc[0:2, 0:2]               # first 2 rows, first 2 cols (stop EXCLUSIVE)
df.iloc[[0, 3], -1]             # rows at pos 0 and 3, last column

# --- boolean mask ---
df[df["salary"] > 100]                       # rows where salary > 100
df.loc[df["dept"].eq("eng"), "salary"]       # salaries in eng only
df[(df.salary > 80) & (df.dept == "eng")]    # AND — parenthesize each side!
```

## 4. Sample Data & Results

Filtering the frame above with `df[(df.salary > 80) & (df.dept == "eng")]`:

| index | name | dept | salary |
|-------|------|------|--------|
| u1 | Ana | eng | 120 |
| u2 | Bo  | eng | 90  |

Selecting with `.loc["u1":"u3", ["name","salary"]]` (note **u3 is included**):

| index | name | salary |
|-------|------|--------|
| u1 | Ana | 120 |
| u2 | Bo  | 90  |
| u3 | Cy  | 75  |

## 5. Under the Hood

`loc` resolves labels through the index's hash table (O(1) per label, or a binary search on a sorted index for slices); `iloc` indexes straight into the underlying NumPy block by position. A **boolean mask** is itself a `Series[bool]` aligned on the index, so `df[mask]` is really `df.loc[mask]` — alignment means a misaligned mask can reindex and inject `NaN`/drop rows.

```svg
<svg viewBox="0 0 720 220" width="100%" height="220" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs><marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#475569"/></marker></defs>
  <text x="360" y="22" text-anchor="middle" font-weight="700" fill="#1e293b">Same rows, two addressing schemes</text>
  <!-- table -->
  <rect x="60" y="50" width="180" height="140" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="150" y="70" text-anchor="middle" fill="#1e293b" font-weight="700">DataFrame</text>
  <line x1="60" y1="80" x2="240" y2="80" stroke="#2563eb"/>
  <text x="90" y="100" fill="#1e293b">u1</text><text x="170" y="100" fill="#64748b">Ana 120</text>
  <text x="90" y="125" fill="#1e293b">u2</text><text x="170" y="125" fill="#64748b">Bo  90</text>
  <text x="90" y="150" fill="#1e293b">u3</text><text x="170" y="150" fill="#64748b">Cy  75</text>
  <text x="90" y="175" fill="#1e293b">u4</text><text x="170" y="175" fill="#64748b">Di 110</text>
  <!-- loc -->
  <rect x="330" y="55" width="150" height="55" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="405" y="78" text-anchor="middle" fill="#1e293b" font-weight="700">.loc["u3"]</text>
  <text x="405" y="97" text-anchor="middle" fill="#64748b">by LABEL → Cy</text>
  <line x1="240" y1="130" x2="330" y2="85" stroke="#475569" marker-end="url(#ar)"/>
  <!-- iloc -->
  <rect x="330" y="130" width="150" height="55" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="405" y="153" text-anchor="middle" fill="#1e293b" font-weight="700">.iloc[2]</text>
  <text x="405" y="172" text-anchor="middle" fill="#64748b">by POSITION → Cy</text>
  <line x1="240" y1="140" x2="330" y2="158" stroke="#475569" marker-end="url(#ar)"/>
  <!-- mask -->
  <rect x="520" y="90" width="150" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="595" y="113" text-anchor="middle" fill="#1e293b" font-weight="700">df[salary&gt;100]</text>
  <text x="595" y="132" text-anchor="middle" fill="#64748b">mask → u1, u4</text>
  <line x1="480" y1="120" x2="520" y2="120" stroke="#475569" marker-end="url(#ar)"/>
</svg>
```

## 6. Variations & Trade-offs

| Tool | Selects by | Stop bound | Best for |
|------|-----------|-----------|----------|
| `df["col"]` | column label | — | grabbing a single column (a Series) |
| `.loc[r, c]` | **labels** | **inclusive** | named rows/cols, boolean masks, assignment |
| `.iloc[r, c]` | **positions** | exclusive | "first N", "last row", position math |
| `df[mask]` | condition | — | quick row filter (shorthand for `.loc[mask]`) |
| `.query("…")` | condition (string) | — | long, readable filters; `@var` for locals |
| `.at` / `.iat` | single cell | — | fastest scalar get/set |

`.query()` reads well and can reference variables with `@`, but it parses a string (slightly slower, no IDE checks). `.at`/`.iat` beat `.loc`/`.iloc` for a single scalar.

## 7. Performance Notes

- **Select both axes in one `.loc`/`.iloc` call** — `df.loc[mask, "col"]` avoids building an intermediate frame that `df[mask]["col"]` creates.
- A **sorted index** makes label slices O(log n); an unsorted non-unique index degrades and can raise on slices.
- Boolean masks scan all rows (O(n)); for repeated point lookups, set a meaningful index and use `.loc`.
- `.query()`/`.eval()` can use **numexpr** for large frames, cutting memory for big boolean expressions.
- Use `.at`/`.iat` inside any hot single-cell loop instead of `.loc`/`.iloc`.

## 8. Common Mistakes

1. ⚠️ **Chained indexing for assignment** — `df[df.a>0]["b"] = 1` writes to a temporary copy (SettingWithCopyWarning). Fix: `df.loc[df.a>0, "b"] = 1`.
2. ⚠️ **Forgetting `.loc` is inclusive** — `df.loc[0:5]` returns 6 rows, `df.iloc[0:5]` returns 5. Mixing them off-by-one.
3. ⚠️ **`and`/`or` instead of `&`/`|`** on masks — raises "truth value of a Series is ambiguous".
4. ⚠️ **Missing parentheses** — `df[df.a>0 & df.b<5]` binds as `df.a > (0 & df.b) < 5`. Wrap: `(df.a>0) & (df.b<5)`.
5. ⚠️ **Using positions in `.loc`** when the index is `0..n` — works by accident, then breaks after a filter/sort reorders the index.
6. ⚠️ **`df[["col"]]` vs `df["col"]`** — the first returns a 1-column DataFrame, the second a Series; downstream code may expect one shape.
7. ⚠️ **Misaligned boolean mask** — a mask from a *different* index reindexes and silently drops/NaNs rows. Build masks from the same frame.

## 9. Interview Questions

**Q: What's the difference between loc and iloc?**
A: `loc` selects by label (index/column names) and is inclusive of the stop label; `iloc` selects by integer position (0-based) and is exclusive of the stop, like normal Python slicing.

**Q: Why is `df.loc["a":"c"]` returning three rows when slicing normally excludes the end?**
A: Label-based slicing in `loc` is inclusive by design, because pandas can't assume the "next" label — so both endpoints are returned. Position-based `iloc` keeps the usual exclusive stop.

**Q: What causes SettingWithCopyWarning and how do you fix it?**
A: Chained indexing (`df[cond]["col"] = x`) operates on an intermediate object that may be a copy, so the write may not propagate. Fix by assigning through a single `.loc`: `df.loc[cond, "col"] = x`.

**Q: Why must you use `&`/`|` instead of `and`/`or` in a mask?**
A: `and`/`or` try to evaluate the truthiness of an entire Series (ambiguous → error). `&`/`|` are element-wise operators that combine boolean Series position-by-position. Parenthesize each comparison because `&` binds tighter than `<`/`>`.

**Q: How do you select rows where a column is one of several values?**
A: `df[df["col"].isin(["a","b","c"])]` — a vectorized set-membership test; negate with `~df["col"].isin(...)`.

**Q: When would you reach for `.query()`?**
A: For long, readable filters (`df.query("age > 30 and city == 'NYC'")`), or to reference local variables with `@var`. It can also use numexpr for large frames. Trade-off: it's a parsed string, slightly slower and not IDE-checked.

**Q: `df[mask]` vs `df.loc[mask]` — any difference?**
A: For row filtering they're equivalent (`df[mask]` dispatches to `.loc`). But `.loc` also lets you select columns in the same call (`df.loc[mask, "col"]`) and is the correct form for assignment.

**Q (senior): A colleague's filter returns extra NaN rows. What happened?**
A: The boolean mask came from a different (misaligned) index, so pandas reindexed the mask to the frame, marking unmatched positions as NaN/False and reshaping the result. Build the mask from the same DataFrame so the indexes align exactly.

**Q (senior): You need the single value at row label "u3", column "salary" in a tight loop — what's fastest?**
A: `df.at["u3", "salary"]` (label) or `df.iat[i, j]` (position). They bypass the general `.loc`/`.iloc` machinery for scalar access and are markedly faster in loops.

**Q (senior): After `df = df.sort_values("salary")`, `df.iloc[0]` and `df.loc[0]` differ — why?**
A: `sort_values` reorders rows but keeps original index labels. `iloc[0]` is the first row *after* sorting (smallest salary); `loc[0]` is still the row whose *label* is 0 (its original position). Reset the index if you want them to coincide.

## 10. Practice

- [ ] From an employees frame, select `name` and `salary` for everyone in `dept == "eng"` using a single `.loc`.
- [ ] Rewrite `df[df.a > 0]["b"] = 0` to avoid SettingWithCopyWarning.
- [ ] Select the last 3 rows and first 2 columns with `iloc`.
- [ ] Filter with `.query()` using a local threshold variable via `@`.
- [ ] Show that `df.loc["x":"z"]` and `df.iloc[0:3]` can return different counts.

## 11. Cheat Sheet

> [!TIP]
> **`loc` = labels (inclusive) · `iloc` = positions (exclusive).** Select both axes in one call: `df.loc[mask, cols]`. Masks: combine with `&`/`|`/`~` and **parenthesize** each comparison. Membership `isin`, ranges `between`, readable filters `.query("@x")`. **Never** assign through chained `[]` — use one `.loc[...] = ...`. Scalars: `.at`/`.iat`.

**References:** Pandas docs: Indexing and selecting data · Pandas docs: Returning a view vs a copy · Pandas User Guide: Boolean indexing

---
*NumPy & Pandas Handbook — topic 14.*
