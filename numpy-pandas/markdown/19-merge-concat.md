# 19 · Merge, Join & Concat

> **In one line:** `merge` is the SQL join of pandas (align two frames on keys), `concat` stacks frames edge-to-edge (rows or columns), and `join` is merge's index-shortcut — pick by whether you're matching keys or gluing shapes.

---

## 1. Overview

Real analysis almost never lives in one table. Orders reference customers; events reference sessions; a fact table references half a dozen dimensions. **Combining frames** is therefore a daily operation, and pandas gives you three related-but-distinct tools: `merge` (key-based, SQL-style joins), `concat` (positional stacking along an axis), and `join` (a convenience wrapper around `merge` that defaults to the index).

Reach for **`merge`** when you want to *match rows across frames by one or more key columns* — this is the relational join, with `how` choosing which unmatched rows survive. Reach for **`concat`** when the frames are *already aligned* and you just want to stack them: append this month's rows to last month's (`axis=0`), or bolt extra columns onto the same rows (`axis=1`). Reach for **`join`** when the match key is an index and you want terse syntax.

The senior skill here is not memorizing syntax — it's reasoning about **join semantics and cardinality**: which rows drop, which duplicate, whether a "one-to-one" join is secretly one-to-many and silently exploding your row count. `merge`'s `validate` and `indicator` arguments exist precisely to catch those failures.

## 2. Core Concepts

- **`merge(left, right, how, on)`** — relational join; matches rows where key values are equal.
- **`how`** — `inner` (keys in both), `left` (all left + matches), `right` (all right + matches), `outer` (union of keys), `cross` (Cartesian product).
- **`on` / `left_on` / `right_on`** — `on` when the key column shares a name; the split form when key columns are named differently.
- **`left_index` / `right_index`** — join on the index instead of a column.
- **`suffixes`** — how overlapping non-key column names are disambiguated (default `("_x", "_y")`).
- **`indicator=True`** — adds a `_merge` column tagging each row `left_only` / `right_only` / `both` — invaluable for auditing what matched.
- **`validate`** — asserts cardinality: `"1:1"`, `"1:m"`, `"m:1"`, `"m:m"`; raises if the keys aren't unique as declared. Your seatbelt against accidental row explosions.
- **`concat(objs, axis)`** — stack frames: `axis=0` (rows, default) aligns on **columns**; `axis=1` aligns on **index**.
- **`join`** — DataFrame method; joins on the **caller's index** (or `on=`) against the other's index; defaults to `how="left"`.
- **Row explosion** — a many-to-many merge produces the Cartesian product per key; unintended duplicate keys are the #1 cause of "why did my row count grow?".

## 3. Syntax & Examples

```python
import pandas as pd

customers = pd.DataFrame({
    "cust_id": [1, 2, 3],
    "name":    ["Ana", "Ben", "Cy"],
    "region":  ["EU", "US", "EU"],
})
orders = pd.DataFrame({
    "order_id": [10, 11, 12, 13],
    "cust_id":  [1, 1, 2, 99],   # 99 has no matching customer
    "amount":   [50, 20, 75, 15],
})

# Inner: only matching keys
pd.merge(orders, customers, on="cust_id", how="inner")

# Left: keep all orders; unmatched customer cols become NaN
pd.merge(orders, customers, on="cust_id", how="left")

# Outer + indicator: full audit of what matched
pd.merge(orders, customers, on="cust_id", how="outer", indicator=True)

# Different key names
pd.merge(orders, customers, left_on="cust_id", right_on="cust_id")

# Enforce cardinality: many orders to one customer
pd.merge(orders, customers, on="cust_id", how="left", validate="m:1")

# Overlapping column names -> suffixes
pd.merge(a, b, on="id", suffixes=("_left", "_right"))

# concat: stack rows (union columns)
pd.concat([jan, feb], axis=0, ignore_index=True)

# concat: stack columns (align on index)
pd.concat([features, labels], axis=1)

# join on index (terse merge)
customers.set_index("cust_id").join(orders.set_index("cust_id"), how="inner")
```

## 4. Worked Example

Attach customer region to each order (left join, keep every order), audit unmatched rows, and guard cardinality.

```python
enriched = pd.merge(
    orders, customers,
    on="cust_id", how="left",
    validate="m:1",        # many orders -> one customer; raises if customers dup
    indicator=True,
)
```

Result:

| order_id | cust_id | amount | name | region | _merge |
|---|---|---|---|---|---|
| 10 | 1 | 50 | Ana | EU | both |
| 11 | 1 | 20 | Ana | EU | both |
| 12 | 2 | 75 | Ben | US | both |
| 13 | 99 | 15 | NaN | NaN | left_only |

The `left_only` row exposes an orphan order (`cust_id=99` has no customer) — exactly the data-quality signal you want. `validate="m:1"` passed because `cust_id` is unique in `customers`; had a customer id been duplicated, pandas would raise `MergeError` instead of silently doubling every matching order.

```python
# Count what matched — the audit one-liner
enriched["_merge"].value_counts()
# both         3
# left_only    1
# right_only   0
```

## 5. Under the Hood

A `merge` builds a **hash table** on the smaller frame's key(s), then probes it once per row of the other frame — roughly O(n + m). (If both keys are already sorted, pandas can use a sort-merge path.) The `how` value decides post-join bookkeeping: which unmatched keys to retain and fill with `NaN`. Because matching is by *value*, duplicate keys on both sides produce the **Cartesian product** within each key group — the mechanism behind row explosion.

`concat` is different: it does **no key matching**. Along `axis=0` it stacks blocks and takes the **union of columns** (missing cells → `NaN`); along `axis=1` it stacks columns and **aligns on the index** (union of index labels). `ignore_index=True` throws away the original labels and renumbers.

```svg
<svg viewBox="0 0 660 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="330" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">LEFT JOIN on cust_id</text>

  <!-- left table -->
  <rect x="20" y="55" width="180" height="120" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="110" y="74" text-anchor="middle" fill="#2563eb" font-weight="bold">orders (left)</text>
  <text x="110" y="98" text-anchor="middle" fill="#1e293b">cust_id=1  amt=50</text>
  <text x="110" y="120" text-anchor="middle" fill="#1e293b">cust_id=2  amt=75</text>
  <text x="110" y="142" text-anchor="middle" fill="#b91c1c">cust_id=99 amt=15</text>
  <text x="110" y="164" text-anchor="middle" fill="#64748b">(all rows kept)</text>

  <!-- right table -->
  <rect x="460" y="55" width="180" height="120" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="550" y="74" text-anchor="middle" fill="#059669" font-weight="bold">customers (right)</text>
  <text x="550" y="98" text-anchor="middle" fill="#1e293b">cust_id=1  EU</text>
  <text x="550" y="120" text-anchor="middle" fill="#1e293b">cust_id=2  US</text>
  <text x="550" y="142" text-anchor="middle" fill="#64748b">cust_id=3  EU</text>
  <text x="550" y="164" text-anchor="middle" fill="#64748b">(unmatched dropped)</text>

  <!-- result -->
  <rect x="210" y="200" width="240" height="86" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="330" y="220" text-anchor="middle" fill="#d97706" font-weight="bold">result (per left row)</text>
  <text x="330" y="242" text-anchor="middle" fill="#1e293b">1 → EU · 2 → US</text>
  <text x="330" y="264" text-anchor="middle" fill="#b91c1c">99 → NaN (left_only)</text>

  <line x1="200" y1="115" x2="255" y2="205" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="460" y1="115" x2="405" y2="205" stroke="#475569" marker-end="url(#a2)"/>
</svg>
```

## 6. Variations & Trade-offs

| Operation | Matches by | Default `how` | Typical use |
|---|---|---|---|
| `merge(on=...)` | key column values | `inner` | Relational join on columns |
| `merge(left_index/right_index)` | index values | `inner` | Join when keys are indices |
| `df.join(other)` | caller index vs other index | `left` | Terse index-to-index join |
| `concat(axis=0)` | nothing (stacks rows) | — | Append periods/partitions |
| `concat(axis=1)` | index alignment | — | Glue columns onto same rows |

`merge` vs `join`: `join` is just `merge` with index defaults and left-how — use it for readability when both sides are indexed. `concat` vs a merge on a unique key: if frames are already row-aligned, `concat(axis=1)` is faster (no hashing) but *trusts* the alignment — a merge is safer when you're unsure the rows correspond. `outer` merges are the most expensive and most likely to introduce `NaN`s and dtype upcasts (int → float).

## 7. Production / Performance Notes

- **Always `validate=`.** In pipelines, declare the expected cardinality (`"1:1"`, `"m:1"`). It costs a uniqueness check and turns silent row explosions into loud, early failures.
- **Watch dtype coercion.** A `left`/`outer` merge that introduces `NaN` upcasts integer keys/values to `float64`; nullable dtypes (`Int64`) or a post-merge `fillna` + downcast avoid surprises.
- **Merge on categoricals / small keys** is cheaper; convert high-cardinality string keys to `category` before repeated joins.
- **`indicator=True` for reconciliation** — the one-line way to answer "how many rows didn't match, and on which side?" before trusting a join.
- **Sort keys once** if you'll join repeatedly; a sorted key can hit the faster merge path and makes `NaN` placement predictable.
- **`concat` many small frames at once**, not in a loop — `pd.concat(list_of_frames)` is far cheaper than repeated `df = pd.concat([df, chunk])`, which reallocates every iteration.
- **Reset or manage the index** after `concat(axis=0)`; duplicate index labels break later `loc` lookups. Use `ignore_index=True` or `keys=` to build a MultiIndex.

## 8. Common Mistakes

1. ⚠️ **Silent row explosion** — merging on a key that's duplicated on both sides multiplies rows. **Fix:** pass `validate="1:m"`/`"m:1"` and dedupe or aggregate first.
2. ⚠️ **Wrong `how` drops data** — using `inner` when you meant `left` quietly discards unmatched rows. **Fix:** decide which side must be preserved; use `indicator` to verify counts.
3. ⚠️ **Different key names** — `on="id"` fails when columns are `cust_id` vs `customer_id`. **Fix:** `left_on`/`right_on`, then drop the redundant column.
4. ⚠️ **Ambiguous suffixes** — overlapping non-key columns become `_x`/`_y` and you lose track. **Fix:** set explicit `suffixes=("_ord","_cust")` or rename before merging.
5. ⚠️ **`concat(axis=1)` misalignment** — stacking columns of two frames with different indices interleaves `NaN`s. **Fix:** align indices first, or use a `merge` on the intended key.
6. ⚠️ **Growing a frame in a loop with `concat`** — quadratic cost. **Fix:** collect chunks in a list and concat once.
7. ⚠️ **Assuming int keys survive** an outer merge — they upcast to float on `NaN`. **Fix:** use nullable `Int64` or fill and downcast.

## 9. Interview Questions

**Q: Explain the four main `how` values in `merge`.**
A: `inner` keeps only keys present in both frames; `left` keeps all left rows plus matching right data (unmatched right cols → `NaN`); `right` is the mirror; `outer` keeps the union of keys from both sides. Choice is driven by which rows must be preserved regardless of a match.

**Q: What does `validate="1:m"` do and why use it?**
A: It asserts the join keys are unique on the left ("1") and may repeat on the right ("m"); pandas raises `MergeError` if that's violated. It's a guardrail against accidental many-to-many joins that silently explode row counts — you encode your cardinality assumption and fail fast when the data breaks it.

**Q: When would you use `concat` instead of `merge`?**
A: When frames are already aligned and you just need to stack them: `axis=0` to append rows (union of columns), `axis=1` to add columns (align on index). `concat` does no key matching, so it's for gluing shapes, not relating tables.

**Q: What's the difference between `merge` and `join`?**
A: `join` is a DataFrame method that defaults to joining on the caller's index against the other frame's index with `how="left"`. `merge` is the general function with full control over key columns and how. `join` is syntactic sugar for the index-to-index case.

**Q: How do you audit which rows matched in a join?**
A: Pass `indicator=True`; pandas adds a `_merge` column tagging each row `left_only`, `right_only`, or `both`. `result["_merge"].value_counts()` gives an instant reconciliation of match counts on each side.

**Q: Why might integer columns become floats after a merge?**
A: A `left`/`right`/`outer` merge introduces `NaN` for unmatched rows, and NumPy's `int64` can't hold `NaN`, so pandas upcasts to `float64`. Use nullable `Int64`, or fill and downcast after the merge, to keep integer semantics.

**Q: (Senior) A "one-to-one" merge doubled your row count. Diagnose it.**
A: The key isn't actually unique on one side — duplicate keys create a Cartesian product per key group. Confirm with `df[key].duplicated().any()` on both frames, add `validate="1:1"` to make it raise, and fix by deduping or aggregating the offending side to the true grain before joining.

**Q: (Senior) How does `merge` perform, and how do you speed up repeated joins?**
A: It typically builds a hash table on one side and probes with the other, ~O(n+m); sorted keys can use a sort-merge path. To speed repeated joins: convert high-cardinality string keys to `category`, sort/set the key as index once, avoid `outer` when a directional join suffices, and reduce each side to only the needed columns before joining.

**Q: (Senior) You need to append 500 daily partition frames. What's the right pattern?**
A: Collect them in a Python list and call `pd.concat(frames, ignore_index=True)` **once**. Never `df = pd.concat([df, chunk])` in a loop — that reallocates and copies on every iteration, giving quadratic time. Optionally pass `keys=dates` to build a MultiIndex tagging each partition's origin.

**Q: (Senior) When is `concat(axis=1)` dangerous compared to a merge?**
A: `concat(axis=1)` aligns purely on the index and trusts that rows correspond by label. If the two frames aren't truly row-aligned, you get misaligned data and `NaN`s with no error. A `merge` on the intended key verifies the correspondence explicitly, so prefer it whenever alignment isn't guaranteed.

## 10. Practice

- [ ] Given `orders` and `customers`, produce inner/left/outer results and explain the row-count differences.
- [ ] Add `indicator=True` and report how many orders are orphaned (no matching customer).
- [ ] Trigger a `MergeError` by duplicating a key, then fix it with `validate` and a dedupe/aggregate step.
- [ ] Merge two frames with an overlapping non-key column and control the collision with explicit `suffixes`.
- [ ] Append 12 monthly frames two ways — a `concat` loop vs a single `pd.concat(list)` — and compare timing.

## 11. Cheat Sheet

> [!TIP]
> **Combine frames**
> - Relational join: `pd.merge(l, r, on="k", how="inner|left|right|outer")`
> - Different names: `left_on=`, `right_on=` · index: `left_index=True`/`right_index=True` or `l.join(r)`
> - Audit matches: `indicator=True` → `_merge` col (`both`/`left_only`/`right_only`)
> - **Guard cardinality:** `validate="1:1"|"1:m"|"m:1"|"m:m"` — fails loud on row explosions
> - Name clashes: `suffixes=("_l","_r")`
> - Stack rows: `pd.concat([a,b], axis=0, ignore_index=True)` (union of cols)
> - Stack cols: `pd.concat([a,b], axis=1)` (aligns on index)
> - Append many: `pd.concat(list_of_frames)` ONCE, never in a loop.

**References:** pandas User Guide — "Merge, join, concatenate and compare"; pandas API docs (`merge`, `concat`, `DataFrame.join`); "Comparison with SQL" pandas doc

---
*NumPy & Pandas Handbook — topic 19.*
