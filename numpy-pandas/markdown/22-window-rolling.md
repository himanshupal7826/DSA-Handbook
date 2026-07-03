# 22 · Window Functions: rolling & expanding

> **In one line:** Window functions compute a statistic over a *sliding or growing neighborhood* of each row — `rolling` (fixed window), `expanding` (all history so far), `ewm` (exponentially weighted) — the backbone of moving averages, running totals, and smoothing.

---

## 1. Overview

Aggregations collapse a whole column to one number; **window functions keep the shape** but replace each value with a statistic computed over a *neighborhood* of nearby rows. That's exactly what you need for time-series work: a **7-day moving average** of sales, a **running (cumulative) total**, a **rolling standard deviation** to detect volatility, an **exponentially weighted mean** that weights recent points more.

Three flavors cover almost everything. **`rolling(window)`** looks back over a fixed span (last N rows, or a time span like `"7D"`). **`expanding()`** grows the window from the start — every row sees all history up to and including it (running mean, cumulative max). **`ewm()`** applies exponentially decaying weights so recent observations dominate without a hard cutoff.

The mental model: `df.rolling(3)` is *lazy* — like `groupby`, it returns a `Rolling` object describing the windows. Nothing computes until you attach a reduction (`.mean()`, `.sum()`, `.std()`, `.apply(f)`). Get the boundary rules right — `min_periods`, `center`, and alignment — and the rest is bookkeeping.

## 2. Core Concepts

- **`rolling(window)`** — a fixed-width sliding window; `window` is an integer (row count) or an offset string like `"7D"` on a datetime index.
- **`min_periods`** — the minimum non-NaN observations required to emit a value; below it the result is `NaN`. Defaults to the window size (so the first `window-1` rows are `NaN`).
- **`center`** — when `True`, the label sits at the window's center instead of its right edge; useful for smoothing, wrong for causal/online features.
- **`expanding(min_periods=1)`** — window from the first row through the current row; produces running/cumulative statistics.
- **`ewm(span=/alpha=/halflife=/com=)`** — exponentially weighted; recent points get weight, older ones decay geometrically. No hard window edge.
- **`.rolling(...).apply(func, raw=True)`** — a custom reduction per window; `raw=True` passes a NumPy array (faster) instead of a Series.
- **`groupby(key).rolling(window)`** — windows computed **within each group** independently — per-user rolling averages without leakage across users.
- **Alignment / leakage** — a right-aligned rolling window includes the current row; for a *predictive* feature you often want to `.shift(1)` so the label can't see itself.
- **Time-based windows** — with a `DatetimeIndex`, `rolling("7D")` spans wall-clock time, correctly handling irregular gaps (unlike a fixed row count).

## 3. Syntax & Examples

```python
import numpy as np
import pandas as pd

s = pd.Series([10, 12, 14, 9, 20, 22, 18],
              index=pd.date_range("2026-01-01", periods=7, freq="D"))

# Fixed 3-row rolling mean (first 2 are NaN)
s.rolling(3).mean()

# Emit as soon as 1 obs exists (no leading NaN)
s.rolling(3, min_periods=1).mean()

# Centered smoothing (label at window middle)
s.rolling(3, center=True).mean()

# Time-based window: last 7 calendar days
s.rolling("7D").sum()

# Expanding: running mean / cumulative max
s.expanding().mean()
s.expanding().max()

# Exponentially weighted mean (recent-heavy)
s.ewm(span=3).mean()

# Custom reduction per window
s.rolling(3).apply(lambda w: w.max() - w.min(), raw=True)

# Multiple stats at once
s.rolling(3).agg(["mean", "std", "min", "max"])

# Per-group rolling (no cross-group leakage)
df = pd.DataFrame({"user": ["a","a","a","b","b"], "val": [1,2,3,10,20]})
df.groupby("user")["val"].rolling(2).mean()
```

## 4. Worked Example

Daily sales: compute a 3-day moving average, a running total, and an EWM-smoothed trend, then use `shift` to make a *leak-free* feature.

```python
sales = pd.Series(
    [100, 120, 90, 140, 160, 130, 170],
    index=pd.date_range("2026-06-01", periods=7, freq="D"),
    name="sales",
)

out = pd.DataFrame({"sales": sales})
out["ma3"]      = sales.rolling(3).mean()          # right-aligned, 3-day MA
out["cum_avg"]  = sales.expanding().mean()         # running average
out["ewm"]      = sales.ewm(span=3).mean().round(1)
out["ma3_lag"]  = out["ma3"].shift(1)              # leak-free feature for day t
```

Result:

| date | sales | ma3 | cum_avg | ewm | ma3_lag |
|---|---|---|---|---|---|
| 06-01 | 100 | NaN | 100.0 | 100.0 | NaN |
| 06-02 | 120 | NaN | 110.0 | 113.3 | NaN |
| 06-03 | 90 | 103.3 | 103.3 | 100.0 | NaN |
| 06-04 | 140 | 116.7 | 112.5 | 121.4 | 103.3 |
| 06-05 | 160 | 130.0 | 122.0 | 142.7 | 116.7 |
| 06-06 | 130 | 143.3 | 123.3 | 135.8 | 130.0 |
| 06-07 | 170 | 153.3 | 130.0 | 154.4 | 143.3 |

`ma3` is `NaN` for the first two rows (fewer than 3 observations). `cum_avg` uses everything up to each day. `ewm` reacts faster than `ma3` to the jump on 06-05 because recent points carry more weight. `ma3_lag` shifts the moving average down one row so a model predicting day *t* never sees day *t*'s own value.

## 5. Under the Hood

A rolling reduction is a **single left-to-right pass** with two pointers bounding the current window. For sum/mean pandas keeps a running accumulator, adding the entering value and subtracting the leaving one — O(n) total, not O(n·window). For order statistics like `min`/`max` it uses a monotonic deque; `median` uses a maintained structure. This is why `.rolling(1000).mean()` on a million rows is nearly as fast as `.rolling(3).mean()`.

`min_periods` controls the warm-up: any window with fewer valid observations emits `NaN`. `center` just relabels which index the window's result attaches to. `ewm` has *no* window at all — it's a recurrence `y_t = (1-α)·y_{t-1} + α·x_t`, so every past point contributes with geometrically decaying weight.

```svg
<svg viewBox="0 0 680 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="340" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Sliding window (window=3, right-aligned)</text>
  <!-- the data cells -->
  <g>
    <rect x="40"  y="60" width="70" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="75"  y="88" text-anchor="middle" fill="#1e293b">100</text>
    <rect x="120" y="60" width="70" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="155" y="88" text-anchor="middle" fill="#1e293b">120</text>
    <rect x="200" y="60" width="70" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="235" y="88" text-anchor="middle" fill="#1e293b">90</text>
    <rect x="280" y="60" width="70" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="315" y="88" text-anchor="middle" fill="#1e293b">140</text>
    <rect x="360" y="60" width="70" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="395" y="88" text-anchor="middle" fill="#1e293b">160</text>
    <rect x="440" y="60" width="70" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="475" y="88" text-anchor="middle" fill="#1e293b">130</text>
    <rect x="520" y="60" width="70" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="555" y="88" text-anchor="middle" fill="#1e293b">170</text>
  </g>
  <!-- window 1 -->
  <rect x="34" y="54" width="242" height="56" rx="10" fill="none" stroke="#059669" stroke-width="2" stroke-dasharray="5 3"/>
  <text x="155" y="132" text-anchor="middle" fill="#059669">win@day3 → mean 103.3</text>
  <!-- window 2 (shifted) -->
  <rect x="274" y="152" width="242" height="56" rx="10" fill="#ecfdf5" stroke="#059669" stroke-width="2" stroke-dasharray="5 3"/>
  <text x="395" y="185" text-anchor="middle" fill="#1e293b">next step: window slides right by 1</text>
  <text x="395" y="234" text-anchor="middle" fill="#059669">win@day5 → mean 130.0</text>
  <text x="340" y="252" text-anchor="middle" fill="#64748b" font-size="12">each step drops the leftmost value, admits one new value (O(n) total)</text>
</svg>
```

## 6. Variations & Trade-offs

| Window type | Span | Weighting | Typical use |
|---|---|---|---|
| `rolling(N)` | last N rows | uniform | Moving average/sum, rolling std |
| `rolling("7D")` | last 7 days (time) | uniform | Irregular time series, calendar windows |
| `expanding()` | all rows so far | uniform | Running total/mean, cumulative max |
| `ewm(span=N)` | unbounded | exponential decay | Smoothing that favors recent data |
| `rolling(N, center=True)` | N centered | uniform | Offline smoothing (not for online features) |

`rolling` vs `expanding`: rolling forgets old data (bounded memory of the past), expanding never does. `rolling` (uniform) vs `ewm` (exponential): a moving average has a hard cutoff and equal weights, so it lags and reacts abruptly when a value exits the window; EWM has no edge artifacts and smoother response, but no exact "N-period" interpretation. Integer windows are simple but *wrong* on irregular timestamps — use an offset window there so gaps are handled by wall-clock time, not row count.

## 7. Production / Performance Notes

- **Beware look-ahead leakage** in features. A right-aligned rolling window includes the current row; for a predictive model `.shift(1)` the result so the label can't see itself. `center=True` is worse — it uses future rows and must never feed an online model.
- **`groupby().rolling()` prevents cross-entity leakage** — per-user/per-symbol windows never bleed across groups. Watch the resulting MultiIndex; `.reset_index(level=0, drop=True)` to realign to the original frame.
- **Use offset windows on time series.** `rolling("30D")` is correct across missing days; `rolling(30)` silently means "30 rows," which spans different durations when data is irregular.
- **`raw=True` in `.apply`** passes NumPy arrays instead of Series — often several times faster for custom window functions.
- **Prefer built-in reductions** (`mean`, `sum`, `std`, `min`, `max`) — they use the O(n) online algorithms; `.apply(lambda)` recomputes each window and is far slower.
- **`min_periods` for partial early windows** — set it low (e.g. 1) when you'd rather have early estimates than leading `NaN`s, but document that early values are noisier.
- **Sort by time first.** Rolling assumes the intended order; an unsorted index gives silently wrong windows.

## 8. Common Mistakes

1. ⚠️ **Data leakage in features** — using the current row's own value in a predictor. **Fix:** `.shift(1)` after the rolling reduction; avoid `center=True` for causal features.
2. ⚠️ **Integer window on irregular timestamps** — `rolling(7)` spans variable durations when days are missing. **Fix:** use a time offset `rolling("7D")` on a `DatetimeIndex`.
3. ⚠️ **Surprised by leading `NaN`s** — default `min_periods == window`. **Fix:** set `min_periods=1` (or a chosen warm-up) if you want early values.
4. ⚠️ **Forgetting to sort** by the time key — windows form over the wrong neighbors. **Fix:** `df.sort_index()` / `sort_values(time)` first.
5. ⚠️ **Cross-group bleed** — a plain `rolling` over a stacked multi-entity frame mixes entities. **Fix:** `groupby(key).rolling(...)`.
6. ⚠️ **Slow `.apply`** for something built-in. **Fix:** use the native reduction, or `.apply(f, raw=True)` when custom.
7. ⚠️ **Confusing `ewm` params** — `span`, `com`, `halflife`, `alpha` all set decay differently. **Fix:** pick one and know its meaning (`span=N` ≈ an N-period EMA).

## 9. Interview Questions

**Q: What's the difference between `rolling` and `expanding`?**
A: `rolling(N)` uses a fixed-width window of the last N observations, so it forgets data that exits the window. `expanding()` grows from the first row to the current one, so every result reflects all history to date — it's the tool for running totals and cumulative statistics.

**Q: What does `min_periods` control, and why are the first rows often `NaN`?**
A: `min_periods` is the minimum number of valid observations a window must contain to emit a value; otherwise the result is `NaN`. It defaults to the window size, so the first `window-1` rows can't form a full window and come out `NaN`. Lower it (e.g. to 1) to get early, partial-window estimates.

**Q: How is `ewm` different from a simple moving average?**
A: A moving average weights the last N points equally and drops everything older; EWM applies geometrically decaying weights to *all* past points with no hard cutoff via the recurrence `y_t = (1-α)y_{t-1} + αx_t`. EWM reacts faster to recent changes and has no edge artifacts when values exit a window.

**Q: When should you use a time-based window like `rolling("7D")` instead of `rolling(7)`?**
A: When the index is a datetime and observations are irregularly spaced. `rolling(7)` means "7 rows," which spans different real durations if days are missing; `rolling("7D")` spans a fixed 7 calendar days regardless of how many rows fall inside, giving semantically correct windows.

**Q: What does `center=True` do and when is it inappropriate?**
A: It labels each window's result at the window's center rather than its right edge, which is good for symmetric offline smoothing. It's inappropriate for any causal/online feature because the centered window includes *future* rows — that's look-ahead leakage.

**Q: How do you compute a rolling average per group without leaking across groups?**
A: `df.groupby(key)["val"].rolling(window).mean()`. Windows are computed independently within each group, so one entity's values never enter another's window. The result carries a MultiIndex (group, original index); drop the group level to realign.

**Q: (Senior) How does pandas compute a rolling mean efficiently on large data?**
A: With an online, two-pointer sweep that maintains a running accumulator — adding the entering value and subtracting the leaving one — so total cost is O(n) regardless of window size. Order statistics use a monotonic deque (min/max). That's why large windows aren't proportionally slower.

**Q: (Senior) You're building a next-day forecast feature from a 7-day rolling mean. What's the leakage risk and the fix?**
A: A right-aligned `rolling(7).mean()` at row *t* includes row *t*'s own target, so the feature encodes the answer. Fix by shifting: `roll = s.rolling(7).mean().shift(1)`, so the feature for day *t* only uses data through day *t-1*. Never use `center=True` here — it pulls in future rows too.

**Q: (Senior) Why can `.rolling(...).apply(lambda w: ...)` be a performance trap, and how do you mitigate it?**
A: `.apply` calls a Python function once per window and, by default, boxes each window into a Series — that's O(n·window) Python-level work and loses the online algorithm. Mitigate by using a built-in reduction when possible, passing `raw=True` so windows arrive as NumPy arrays, or expressing the metric via numba (`engine="numba"`) for a JIT-compiled kernel.

**Q: (Senior) Explain the relationship between `span`, `alpha`, and `halflife` in `ewm`.**
A: They're three parameterizations of the same decay. `alpha` is the smoothing factor directly (`y_t=(1-α)y_{t-1}+αx_t`). `span=s` sets `alpha = 2/(s+1)`, giving an EMA comparable to an s-period moving average. `halflife=h` sets the decay so weights halve every h steps (`alpha = 1 - exp(ln(0.5)/h)`). You specify exactly one.

## 10. Practice

- [ ] Compute a 7-day moving average and a running cumulative sum of a daily-sales Series.
- [ ] Build a leak-free feature: `rolling(7).mean().shift(1)` and verify row *t* doesn't use its own value.
- [ ] Compare `rolling(5).mean()` vs `ewm(span=5).mean()` on a series with a sudden jump; explain the different responses.
- [ ] Use `groupby("user").rolling("3D")` on a multi-user event log and confirm no cross-user leakage.
- [ ] Reimplement rolling range (`max-min`) with `.apply(..., raw=True)` and time it against separate `rolling().max()`/`min()`.

## 11. Cheat Sheet

> [!TIP]
> **Window functions**
> - Fixed window: `s.rolling(N).mean()` · time window: `s.rolling("7D").sum()` (needs DatetimeIndex)
> - Warm-up: `min_periods=1` to avoid leading NaN · label at middle: `center=True` (offline only)
> - Running stats: `s.expanding().mean()/.max()` · smoothing: `s.ewm(span=N).mean()`
> - Per group: `df.groupby(k)["v"].rolling(N).mean()` (no cross-group leak)
> - Custom: `s.rolling(N).apply(f, raw=True)` · multi: `.rolling(N).agg(["mean","std"])`
> - **Feature leakage:** `.shift(1)` the rolling result; never `center=True` for causal features.
> - Built-in reductions are O(n) online; `.apply(lambda)` is much slower.

**References:** pandas User Guide — "Windowing operations"; pandas API docs (`rolling`, `expanding`, `ewm`); pandas "Time series / date functionality" doc

---
*NumPy & Pandas Handbook — topic 22.*
