# 30 · Challenge: Sales Analysis with GroupBy

> **In one line:** From a flat orders table, produce the four reports every sales dashboard needs — revenue by region × month, top-N products per category, month-over-month growth, and a pivot — using `groupby`, `rank`, and `pivot_table`.

---

## 1. The Scenario

You're handed `orders` — one row per line item — and asked for a monthly sales pack. Product wants: **revenue by region and month**, the **top 2 products in each category**, **month-over-month growth** for the business, and a **region × month pivot** they can paste into a deck. It's all `groupby`, but each report bends it differently: aggregate, rank-within-group, shift-within-group, reshape.

**The starting artifact** — build it and look:

```python
import pandas as pd
import numpy as np

orders = pd.DataFrame({
    "order_id": range(1, 13),
    "date": pd.to_datetime([
        "2024-01-05","2024-01-18","2024-02-02","2024-02-20","2024-03-11","2024-03-25",
        "2024-01-09","2024-02-14","2024-03-03","2024-01-27","2024-02-28","2024-03-30"]),
    "region":   ["US","US","US","US","US","US","EU","EU","EU","EU","EU","EU"],
    "category": ["Electronics","Home","Electronics","Home","Electronics","Home",
                 "Electronics","Home","Electronics","Home","Electronics","Home"],
    "product":  ["Laptop","Blender","Phone","Blender","Laptop","Lamp",
                 "Phone","Lamp","Laptop","Blender","Phone","Lamp"],
    "units":    [2, 5, 3, 4, 1, 6, 2, 3, 4, 5, 2, 7],
    "price":    [1000, 40, 600, 40, 1000, 25, 600, 25, 1000, 40, 600, 25],
})
orders["revenue"] = orders["units"] * orders["price"]
print(orders)
```

The raw orders (revenue = units × price):

| order_id | date       | region | category    | product | units | price | revenue |
|----------|------------|--------|-------------|---------|-------|-------|---------|
| 1  | 2024-01-05 | US | Electronics | Laptop  | 2 | 1000 | 2000 |
| 2  | 2024-01-18 | US | Home        | Blender | 5 | 40   | 200  |
| 3  | 2024-02-02 | US | Electronics | Phone   | 3 | 600  | 1800 |
| 4  | 2024-02-20 | US | Home        | Blender | 4 | 40   | 160  |
| 5  | 2024-03-11 | US | Electronics | Laptop  | 1 | 1000 | 1000 |
| 6  | 2024-03-25 | US | Home        | Lamp    | 6 | 25   | 150  |
| 7  | 2024-01-09 | EU | Electronics | Phone   | 2 | 600  | 1200 |
| 8  | 2024-02-14 | EU | Home        | Lamp    | 3 | 25   | 75   |
| 9  | 2024-03-03 | EU | Electronics | Laptop  | 4 | 1000 | 4000 |
| 10 | 2024-01-27 | EU | Home        | Blender | 5 | 40   | 200  |
| 11 | 2024-02-28 | EU | Electronics | Phone   | 2 | 600  | 1200 |
| 12 | 2024-03-30 | EU | Home        | Lamp    | 7 | 25   | 175  |

**The goal:** four tidy report frames, each derived from this one table with the right `groupby` shape.

## 2. Approach

A senior maps each ask to a **groupby shape** before writing code:

1. **Revenue by region × month** — a straight *aggregate*: derive a `month` key, `groupby(["region","month"])["revenue"].sum()`. The only subtlety is making `month` a proper period so it sorts chronologically, not lexically.
2. **Top-N per category** — this is *rank within group*. Aggregate to `(category, product)` totals, then `groupby("category")["revenue"].rank(method="dense", ascending=False)` and keep rank ≤ N. Don't `sort + head` globally — that gives global top-N, not per-category.
3. **Month-over-month growth** — *shift within an ordered group*. Aggregate to monthly totals, sort by month, then `.pct_change()` (a within-series shift). If splitting by region, `groupby("region")["revenue"].pct_change()` so growth doesn't leak across regions.
4. **Pivot report** — *reshape*, not new aggregation: `pivot_table(index="region", columns="month", values="revenue", aggfunc="sum")` for the deck-ready grid, with margins for totals.

The through-line: **derive a clean `month` key once**, reuse it everywhere, and pick `groupby` vs `rank` vs `pct_change` vs `pivot_table` by whether you're *aggregating, ranking, shifting, or reshaping*.

> [!NOTE]
> Use `dt.to_period("M")` for the month key — it sorts chronologically and formats as `2024-01`. Using the raw month *number* (1..12) silently mixes years and breaks multi-year growth.

## 3. Solution

```python
import pandas as pd

# One clean month key, reused by every report
orders = orders.assign(month=orders["date"].dt.to_period("M"))

# --- Report 1: revenue by region x month -----------------------------------
rev_region_month = (
    orders
    .groupby(["region", "month"], as_index=False)["revenue"].sum()
    .sort_values(["region", "month"], ignore_index=True)
)

# --- Report 2: top-2 products per category (groupby + rank) -----------------
prod_tot = (
    orders.groupby(["category", "product"], as_index=False)["revenue"].sum()
)
prod_tot["rank"] = (
    prod_tot.groupby("category")["revenue"]
            .rank(method="dense", ascending=False).astype(int)
)
top2 = (
    prod_tot[prod_tot["rank"] <= 2]
    .sort_values(["category", "rank"], ignore_index=True)
)

# --- Report 3: month-over-month growth (overall) ----------------------------
monthly = (
    orders.groupby("month", as_index=False)["revenue"].sum()
          .sort_values("month", ignore_index=True)
)
monthly["mom_growth_pct"] = (monthly["revenue"].pct_change() * 100).round(1)

# --- Report 4: pivot report region x month, with totals ---------------------
pivot = orders.pivot_table(
    index="region", columns="month", values="revenue",
    aggfunc="sum", margins=True, margins_name="Total",
)
```

## 4. Walkthrough

**Report 1 — aggregate.** `groupby(["region","month"])["revenue"].sum()` collapses the 12 line items into one row per (region, month). `as_index=False` keeps `region`/`month` as columns (tidier than a MultiIndex for a report), and sorting by the `Period` month key orders it chronologically.

**Report 2 — rank within group.** First aggregate to per-`(category, product)` revenue so each product appears once. Then `groupby("category")["revenue"].rank(method="dense", ascending=False)` assigns 1 to each category's biggest product, 2 to the next — **independently per category**. Filtering `rank <= 2` yields the top 2 *of each* category. `method="dense"` avoids gaps on ties; `"first"` would break ties by row order if you need exactly N.

**Report 3 — shift within an ordered series.** After summing to monthly totals and sorting by month, `pct_change()` computes `(this − prev) / prev`. The first month is `NaN` (no prior). This is a *shifted* comparison, not an aggregation — the reason sorting first is mandatory. Splitting by region would use `groupby("region")["revenue"].pct_change()` so January-of-EU doesn't compare against December-of-US.

**Report 4 — reshape.** `pivot_table` doesn't compute anything new here; it lays the region×month revenue into a grid — regions down the side, months across the top — and `margins=True` adds row/column totals. It's the same aggregation as Report 1, reshaped for human reading.

Outputs:

**Report 1 — revenue by region × month:**

| region | month   | revenue |
|--------|---------|---------|
| EU     | 2024-01 | 1400    |
| EU     | 2024-02 | 1275    |
| EU     | 2024-03 | 4175    |
| US     | 2024-01 | 2200    |
| US     | 2024-02 | 1960    |
| US     | 2024-03 | 1150    |

**Report 2 — top 2 products per category:**

| category    | product | revenue | rank |
|-------------|---------|---------|------|
| Electronics | Laptop  | 7000    | 1    |
| Electronics | Phone   | 4200    | 2    |
| Home        | Blender | 560     | 1    |
| Home        | Lamp    | 400     | 2    |

**Report 3 — month-over-month growth (overall):**

| month   | revenue | mom_growth_pct |
|---------|---------|----------------|
| 2024-01 | 3600    | NaN            |
| 2024-02 | 3235    | -10.1          |
| 2024-03 | 5325    | 64.6           |

**Report 4 — pivot (region × month, with totals):**

| region | 2024-01 | 2024-02 | 2024-03 | Total |
|--------|---------|---------|---------|-------|
| EU     | 1400    | 1275    | 4175    | 6850  |
| US     | 2200    | 1960    | 1150    | 5310  |
| Total  | 3600    | 3235    | 5325    | 12160 |

The split-apply-combine engine behind all four:

```svg
<svg viewBox="0 0 660 280" width="100%" height="280" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ag" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="330" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">groupby = split · apply · combine</text>

  <rect x="30" y="45" width="120" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="90" y="66" text-anchor="middle" fill="#1e293b" font-weight="700">orders</text>
  <text x="90" y="86" text-anchor="middle" fill="#64748b">12 line items</text>
  <text x="90" y="112" text-anchor="middle" fill="#1e293b">US · Elec · 2000</text>
  <text x="90" y="132" text-anchor="middle" fill="#1e293b">US · Home · 200</text>
  <text x="90" y="152" text-anchor="middle" fill="#1e293b">EU · Elec · 1200</text>
  <text x="90" y="172" text-anchor="middle" fill="#64748b">…</text>

  <text x="205" y="60" text-anchor="middle" fill="#64748b">split by key</text>
  <line x1="150" y1="120" x2="235" y2="90"  stroke="#475569" marker-end="url(#ag)"/>
  <line x1="150" y1="120" x2="235" y2="185" stroke="#475569" marker-end="url(#ag)"/>

  <rect x="240" y="66"  width="150" height="48" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="315" y="86"  text-anchor="middle" fill="#1e293b" font-weight="700">group: US</text>
  <text x="315" y="104" text-anchor="middle" fill="#64748b">rows for US</text>

  <rect x="240" y="162" width="150" height="48" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="315" y="182" text-anchor="middle" fill="#1e293b" font-weight="700">group: EU</text>
  <text x="315" y="200" text-anchor="middle" fill="#64748b">rows for EU</text>

  <text x="450" y="60" text-anchor="middle" fill="#64748b">apply</text>
  <line x1="390" y1="90"  x2="470" y2="105" stroke="#475569" marker-end="url(#ag)"/>
  <line x1="390" y1="186" x2="470" y2="160" stroke="#475569" marker-end="url(#ag)"/>

  <rect x="475" y="95" width="160" height="80" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="555" y="118" text-anchor="middle" fill="#1e293b" font-weight="700">combine → result</text>
  <text x="555" y="140" text-anchor="middle" fill="#1e293b">US · 5310</text>
  <text x="555" y="160" text-anchor="middle" fill="#1e293b">EU · 6850</text>

  <text x="330" y="255" text-anchor="middle" fill="#64748b">sum→aggregate · rank→top-N · pct_change→growth · pivot_table→reshape</text>
</svg>
```

## 5. Variations & Follow-ups

- **Top-N per category *per region*** — add `region` to the group key: `groupby(["region","category"])["revenue"].rank(...)`. The rank scope is exactly the group key.
- **Exactly N with ties broken deterministically** — use `rank(method="first")` (row-order tiebreak) or `sort_values(...).groupby("category").head(N)`. `"dense"` can return more than N rows on ties.
- **MoM growth per region** — `orders.groupby(["region","month"])["revenue"].sum().groupby(level="region").pct_change()`, or sort then `groupby("region")["revenue"].pct_change()` so growth resets at each region boundary.
- **Year-over-year** — key on `dt.to_period("M")` and `.shift(12)` within a product/region series, or pivot year × month.
- **Multiple aggs at once** — `groupby(...).agg(revenue=("revenue","sum"), orders=("order_id","size"), aov=("revenue","mean"))`.
- **Fill missing month/region combos** — after pivot, `reindex` the columns to the full month range and `fillna(0)` so gaps show as 0, not absent.

## 6. Verify It Works

```python
# Totals reconcile across every report
assert rev_region_month["revenue"].sum() == orders["revenue"].sum() == 12160
assert monthly["revenue"].sum() == 12160
assert pivot.loc["Total", "Total"] == 12160

# Every category has at most 2 ranked rows, ranks are 1..2
assert (top2.groupby("category").size() <= 2).all()
assert set(top2["rank"]) <= {1, 2}

# MoM math: Feb vs Jan overall
assert round((3235 - 3600) / 3600 * 100, 1) == -10.1

# Month key sorts chronologically (Period, not int)
assert list(monthly["month"].astype(str)) == ["2024-01", "2024-02", "2024-03"]
print("all checks passed")
```

Expected: `all checks passed`. The key invariant — **every report's grand total equals the raw `revenue` sum (12160)** — is the fastest way to catch a dropped group or a leaked join.

## 7. Pitfalls

1. ⚠️ **Grouping on month *number* (1..12) instead of a period.** Mixes years and sorts `10, 11, 1, 2`. **Fix:** `dt.to_period("M")` (or `dt.strftime("%Y-%m")`) as the key.
2. ⚠️ **Global `sort + head(N)` for "top-N per category".** Returns the overall top-N, not per group. **Fix:** `groupby(cat)["rev"].rank(ascending=False)` then filter `<= N`.
3. ⚠️ **`pct_change` without sorting first.** Growth is computed against whatever row happens to precede — garbage if unsorted. **Fix:** `sort_values("month")` before `pct_change()`, and `groupby` the entity so it doesn't leak across regions/products.
4. ⚠️ **`rank(method="dense")` when you need exactly N.** Ties share a rank and you can get >N rows. **Fix:** `method="first"` or `.head(N)` if N must be exact.
5. ⚠️ **Forgetting `as_index=False`** and then being surprised the group keys became the index. **Fix:** pass `as_index=False`, or `.reset_index()` after aggregating.
6. ⚠️ **Pivoting with unfilled gaps** — a region missing a month vanishes from the grid. **Fix:** `reindex` columns to the full month range and `fillna(0)`.

## 8. Interview Follow-ups

**Q: How do you get the top-N products *within each* category rather than overall?**
A: Aggregate to per-`(category, product)` revenue, then rank *inside* each category with `groupby("category")["revenue"].rank(method="dense", ascending=False)` and keep rows where rank ≤ N. A global `sort_values().head(N)` gives the overall top-N and ignores category boundaries — wrong for a per-group ask.

**Q: What's the difference between `rank` methods `dense`, `min`, and `first` for top-N?**
A: `dense` gives tied values the same rank with no gaps (1,1,2) — can return more than N rows on ties. `min` gives ties the same rank but skips (1,1,3). `first` breaks ties by order of appearance so ranks are unique (1,2,3) — use it (or `head(N)`) when you need *exactly* N rows deterministically.

**Q: Why use `dt.to_period("M")` instead of `dt.month` for a monthly key?**
A: `dt.month` is just 1..12 and collapses different years together, and sorts numerically not chronologically across year boundaries. `to_period("M")` produces a `Period` like `2024-01` that is year-aware, sorts chronologically, formats cleanly for reports, and supports period arithmetic (`+ 1`, `.shift`).

**Q: How does `pct_change` compute month-over-month growth, and what must you do first?**
A: `pct_change()` computes `(x_t − x_{t−1}) / x_{t−1}` on the series in its current order, with the first element `NaN`. You must sort by the time key first, and if the series spans multiple entities (regions/products), wrap in `groupby(entity)[...].pct_change()` so period t−1 is the same entity's prior period, not a different group's.

**Q: When would you use `pivot_table` versus `groupby().sum()` — they seem to do the same thing?**
A: They share the aggregation, but `groupby` returns a long/tidy frame (good for further computation and joins) while `pivot_table` reshapes to a wide grid (index × columns) that's human/deck-friendly and supports `margins` for totals and `fill_value`. Use `groupby` for pipelines, `pivot_table` for presentation.

**Q: How do you compute several aggregations (sum, count, mean) per group in one pass?** *(senior)*
A: Named aggregation: `groupby(key).agg(revenue=("revenue","sum"), orders=("order_id","size"), aov=("revenue","mean"))`. Each output column names its source column and function, so you get a clean flat result in a single grouped pass rather than multiple groupbys.

**Q: A region is missing an entire month — how do you make it appear as 0 in the pivot and in growth?** *(senior)*
A: After pivoting, `reindex` the columns (and/or index) to the complete month/region range and `fillna(0)`; for a long frame, build a full `MultiIndex` of all (region, month) combos and reindex before computing. Otherwise the missing period is simply absent, and `pct_change` would compare non-adjacent months, understating/overstating growth.

**Q: How would you extend month-over-month to year-over-year growth for the same product?** *(senior)*
A: Aggregate to a `(product, month)` series keyed on `to_period("M")`, sort, and within each product compare against the value 12 periods back: `groupby("product")["revenue"].apply(lambda s: s / s.shift(12) - 1)`, or pivot to year × month and divide rows. The pattern is the same shift-within-group, just a lag of 12 instead of 1.

**Q: Your report totals don't reconcile with the raw revenue sum — how do you debug it?**
A: Compare grand totals (`report.sum()` vs `orders["revenue"].sum()`). A shortfall usually means a dropped group (an inner join or a filter removing rows), duplicated rows (a many-to-many merge) inflate it, or NaNs silently excluded by `sum`. Check group counts (`groupby(key).size()`), look for NaN in the value column, and verify no filter/join changed row count before aggregation.

## 9. Cheat Sheet

> [!TIP]
> **Sales groupby playbook**
> - **Month key once:** `df["month"] = df.date.dt.to_period("M")` — year-aware, sorts right.
> - **Aggregate:** `groupby(["region","month"], as_index=False)["revenue"].sum()`.
> - **Top-N per group:** `df.groupby(cat)["rev"].rank(method="dense", ascending=False)` → keep `<= N`. Exactly N → `method="first"` or `.head(N)`.
> - **MoM growth:** sort by month → `pct_change()`; per entity → `groupby(entity)["rev"].pct_change()`.
> - **Pivot for the deck:** `pivot_table(index="region", columns="month", values="revenue", aggfunc="sum", margins=True)`.
> - **Multi-agg:** `.agg(rev=("revenue","sum"), n=("order_id","size"), aov=("revenue","mean"))`.
> - **Sanity:** every report's grand total must equal the raw `revenue` sum.

**References:** pandas User Guide — "Group by: split-apply-combine" & "Reshaping and pivot tables"; pandas `rank`, `pct_change`, `pivot_table` API docs; "Grouper and period" cookbook.

---
*NumPy & Pandas Handbook — topic 30.*
