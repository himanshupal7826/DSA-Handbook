# 31 · Challenge: Time-Series Resample & Rolling

> **In one line:** Turn a stream of irregular event timestamps into a clean daily series — resample to daily, fill the gaps, add a 7-day rolling average and a cumulative total, and locate the peak window — with `resample`, `rolling`, and `cumsum`.

---

## 1. The Scenario

You get a raw event log: purchases arriving at **irregular** times — several on some days, none on others, gaps of two or three days. Analytics wants a **regular daily series** they can chart: one row per calendar day (including the empty ones as 0), a **7-day rolling average** to smooth the noise, a **running cumulative total**, and the **peak 7-day window** flagged.

Irregular timestamps break everything downstream: you can't diff day-over-day when days are missing, a rolling window over rows-not-days smears across gaps, and `cumsum` over unsorted events is nonsense. Step one is always to *regularize the time axis*.

**The starting artifact** — build it and look:

```python
import pandas as pd
import numpy as np

events = pd.DataFrame({
    "ts": pd.to_datetime([
        "2024-01-01 09:12", "2024-01-01 17:40", "2024-01-02 11:05",
        "2024-01-05 08:30", "2024-01-05 12:15", "2024-01-05 20:50",
        "2024-01-06 10:00", "2024-01-09 14:20", "2024-01-10 09:45",
        "2024-01-10 10:10", "2024-01-10 22:30"]),
    "amount": [50, 20, 35, 80, 40, 10, 25, 90, 15, 60, 30],
})
print(events)
```

The raw events (note the gaps: no Jan 3–4, 7–8):

| ts               | amount |
|------------------|--------|
| 2024-01-01 09:12 | 50 |
| 2024-01-01 17:40 | 20 |
| 2024-01-02 11:05 | 35 |
| 2024-01-05 08:30 | 80 |
| 2024-01-05 12:15 | 40 |
| 2024-01-05 20:50 | 10 |
| 2024-01-06 10:00 | 25 |
| 2024-01-09 14:20 | 90 |
| 2024-01-10 09:45 | 15 |
| 2024-01-10 10:10 | 60 |
| 2024-01-10 22:30 | 30 |

**The goal:** a daily frame indexed by every calendar day Jan 1–10 with `daily` total (0 on empty days), `roll7` 7-day mean, `cumulative` running sum, and the peak 7-day window identified.

## 2. Approach

A senior fixes the **time axis first**, then layers analytics on the regular grid:

1. **Sort & set a DatetimeIndex.** `resample`/`rolling` on time require a sorted `DatetimeIndex`. Set `ts` as the index and sort.
2. **Resample to daily.** `resample("D")["amount"].sum()` buckets all events per calendar day and sums them. Crucially, `resample` **materializes the empty days** in between (as `NaN`), which raw `groupby(date)` would not.
3. **Fill gaps deliberately.** For a *count/total* series, an empty day means **0**, so `fillna(0)`. (For a sensor *level* you'd `ffill` instead — the choice depends on the metric's meaning.)
4. **Rolling average** over the *regular* series: `rolling(7).mean()`. Now "7" means 7 *days*, because every day is present. On an irregular series it would mean 7 *events*, smearing across gaps.
5. **Cumulative total** with `cumsum()` on the sorted daily series — a monotonic running sum.
6. **Peak window** — the 7-day window with the highest total is `rolling(7).sum().idxmax()`; its *end* date is that index, the window is the 7 days ending there.

> [!NOTE]
> **`resample` vs `groupby(date)`**: both bucket by day, but only `resample` (or reindexing to a full date range) inserts the *missing* days. Filling gaps is the whole point — a rolling/diff on a series with holes is silently wrong.

## 3. Solution

```python
import pandas as pd

# 1. Regular time axis: sorted DatetimeIndex
s = events.set_index("ts").sort_index()

# 2. Resample to daily total (empty days appear as NaN)
daily = s["amount"].resample("D").sum()

# 3. Empty day = 0 sales for a total/count series
daily = daily.fillna(0)

# 4-5. Assemble the report frame on the regular grid
report = pd.DataFrame({"daily": daily})
report["roll7"]      = report["daily"].rolling(window=7, min_periods=1).mean().round(2)
report["cumulative"] = report["daily"].cumsum()

# 6. Peak 7-day window = end date of the max rolling-7 sum
roll7_sum   = report["daily"].rolling(7).sum()
peak_end    = roll7_sum.idxmax()
peak_start  = peak_end - pd.Timedelta(days=6)
peak_total  = roll7_sum.max()

print(report)
print(f"\nPeak 7-day window: {peak_start.date()} → {peak_end.date()} "
      f"totalling {peak_total:.0f}")
```

## 4. Walkthrough

**Regularize (steps 1–3).** Setting `ts` as a sorted `DatetimeIndex` is the precondition for every time-aware method. `resample("D")` groups by calendar day and `.sum()` totals each day's events — three Jan-5 events (80+40+10) become 130. Unlike `groupby(s.index.date)`, `resample` **emits the missing days** (Jan 3, 4, 7, 8) as `NaN`, which we turn into `0` because "no purchases" means zero revenue, not unknown.

**Rolling average (step 4).** `rolling(window=7).mean()` slides a 7-row window; because the series is now one-row-per-day, that's a true **7-day** moving average. `min_periods=1` lets the first days emit a partial average instead of `NaN` (otherwise the first 6 days are blank). This smoothing is why regularizing mattered: without the zero-filled gaps, "7 rows" would span far more than 7 days.

**Cumulative total (step 5).** `cumsum()` on the sorted daily series gives a monotonically increasing running total — day N holds the sum of days 1..N. It only makes sense on a sorted axis, which we guaranteed.

**Peak window (step 6).** `rolling(7).sum()` gives, at each date, the total of the trailing 7 days; `idxmax()` returns the **date where that trailing sum is largest** — i.e. the *end* of the hottest week. Subtract 6 days for the start. Here the window ending Jan 10 (covering Jan 4–10) captures the Jan 9 spike (90) plus Jan 10's 105, the busiest stretch.

Output frame:

| ts (day)   | daily | roll7 | cumulative |
|------------|-------|-------|------------|
| 2024-01-01 | 70    | 70.00 | 70   |
| 2024-01-02 | 35    | 52.50 | 105  |
| 2024-01-03 | 0     | 35.00 | 105  |
| 2024-01-04 | 0     | 26.25 | 105  |
| 2024-01-05 | 130   | 47.00 | 235  |
| 2024-01-06 | 25    | 43.33 | 260  |
| 2024-01-07 | 0     | 37.14 | 260  |
| 2024-01-08 | 0     | 27.14 | 260  |
| 2024-01-09 | 90    | 35.00 | 350  |
| 2024-01-10 | 105   | 50.00 | 455  |

```text
Peak 7-day window: 2024-01-04 → 2024-01-10 totalling 350
```

(Daily totals: Jan 1 = 50+20 = 70; Jan 5 = 80+40+10 = 130; Jan 10 = 15+60+30 = 105. Grand total = 455, matching the last `cumulative`.)

The transform from irregular events to a regular grid:

```svg
<svg viewBox="0 0 660 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="330" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">irregular events → resample("D") → regular daily grid</text>

  <text x="120" y="52" text-anchor="middle" fill="#b91c1c" font-weight="700">irregular (gaps)</text>
  <line x1="30" y1="95" x2="230" y2="95" stroke="#475569"/>
  <g fill="#fff7ed" stroke="#d97706">
    <circle cx="45"  cy="95" r="6"/><circle cx="55" cy="95" r="6"/>
    <circle cx="75"  cy="95" r="6"/>
    <circle cx="150" cy="95" r="6"/><circle cx="160" cy="95" r="6"/>
    <circle cx="205" cy="95" r="6"/>
  </g>
  <text x="60"  y="120" text-anchor="middle" fill="#64748b">Jan1-2</text>
  <text x="155" y="120" text-anchor="middle" fill="#64748b">Jan5</text>
  <text x="205" y="120" text-anchor="middle" fill="#64748b">Jan9-10</text>
  <text x="112" y="140" text-anchor="middle" fill="#b91c1c">↕ gaps Jan3-4, 7-8</text>

  <line x1="255" y1="95" x2="300" y2="95" stroke="#475569" stroke-width="2" marker-end="url(#ar)"/>
  <text x="278" y="82" text-anchor="middle" fill="#64748b">resample</text>

  <text x="470" y="52" text-anchor="middle" fill="#059669" font-weight="700">regular daily (0-filled)</text>
  <g fill="#ecfdf5" stroke="#059669">
    <rect x="320" y="70" width="30" height="50" rx="5"/>
    <rect x="355" y="90" width="30" height="30" rx="5"/>
    <rect x="390" y="115" width="30" height="5" rx="2"/>
    <rect x="425" y="115" width="30" height="5" rx="2"/>
    <rect x="460" y="62" width="30" height="58" rx="5"/>
    <rect x="495" y="105" width="30" height="15" rx="5"/>
    <rect x="530" y="115" width="30" height="5" rx="2"/>
    <rect x="565" y="115" width="30" height="5" rx="2"/>
    <rect x="600" y="80" width="30" height="40" rx="5"/>
  </g>
  <text x="475" y="140" text-anchor="middle" fill="#64748b">every day present · empty = 0</text>

  <text x="330" y="185" text-anchor="middle" fill="#1e293b" font-weight="700">then on the regular grid:</text>
  <rect x="40"  y="205" width="180" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="130" y="230" text-anchor="middle" fill="#1e293b" font-weight="700">rolling(7).mean()</text>
  <text x="130" y="250" text-anchor="middle" fill="#64748b">smooth 7-DAY avg</text>

  <rect x="240" y="205" width="180" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="330" y="230" text-anchor="middle" fill="#1e293b" font-weight="700">cumsum()</text>
  <text x="330" y="250" text-anchor="middle" fill="#64748b">running total → 455</text>

  <rect x="440" y="205" width="180" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="530" y="230" text-anchor="middle" fill="#1e293b" font-weight="700">rolling(7).sum().idxmax()</text>
  <text x="530" y="250" text-anchor="middle" fill="#64748b">peak week end</text>
</svg>
```

## 5. Variations & Follow-ups

- **Different cadence** — `resample("W")` weekly, `"H"` hourly, `"MS"` month-start, `"15min"` for high-frequency. Same pattern, different rule string.
- **Sensor *level*, not a total** — an empty interval means "unchanged", so `ffill()` (or `resample("D").last().ffill()`) instead of `fillna(0)`. The fill choice encodes the metric's semantics.
- **Downsample with multiple aggs** — `resample("D")["amount"].agg(["sum","mean","count","max"])` for a richer daily table.
- **Upsample & interpolate** — going *finer* than the data (`resample("H")`) creates NaNs you fill with `.interpolate("time")` for a smooth curve.
- **Centered / weighted rolling** — `rolling(7, center=True)` aligns the window on the middle day; `.ewm(span=7).mean()` gives an exponential moving average that reacts faster to recent values.
- **Right-labeled windows & min_periods** — tune `min_periods` for how many early partial windows you allow, and `closed=`/`label=` for bucket-edge conventions.
- **Timezones** — localize with `tz_localize`/`tz_convert` *before* resampling so daily buckets align to the right local midnight.

## 6. Verify It Works

```python
# The regular grid covers every calendar day, no gaps
assert (report.index == pd.date_range("2024-01-01", "2024-01-10", freq="D")).all()
assert report.index.is_monotonic_increasing

# Empty days are 0, not NaN
assert report.loc["2024-01-03", "daily"] == 0
assert report["daily"].notna().all()

# Cumulative ends at the grand total of raw amounts
assert report["cumulative"].iloc[-1] == events["amount"].sum() == 455

# Rolling mean of a 7-window equals its own manual mean (spot check Jan 10)
assert round(report["daily"].iloc[-7:].mean(), 2) == report["roll7"].iloc[-1]

# Peak window ends on the max trailing-7 sum
assert peak_end == report["daily"].rolling(7).sum().idxmax()
print("all checks passed")
```

Expected: `all checks passed`. The anchor invariant — **`cumulative.iloc[-1]` equals the raw `amount` sum (455)** — proves resampling neither dropped nor double-counted an event.

## 7. Pitfalls

1. ⚠️ **`groupby(date)` instead of `resample`/reindex.** It buckets by day but **omits days with no events**, so rolling/diffs silently span gaps. **Fix:** `resample("D")` (or reindex to a full `date_range`) so every day exists.
2. ⚠️ **`fillna(0)` vs `ffill` chosen wrong.** For totals/counts, missing = 0; for a *level/gauge* (temperature, balance), missing = last known value. Using the wrong one fabricates data. **Fix:** pick the fill by what the metric means.
3. ⚠️ **`rolling(7)` on an irregular series.** "7" counts *rows*, not days — the window smears across gaps and misaligns dates. **Fix:** regularize to daily first (or use a time-based offset window `rolling("7D")` on a DatetimeIndex).
4. ⚠️ **Resampling an unsorted index.** Results are wrong/raise. **Fix:** `sort_index()` after `set_index("ts")`.
5. ⚠️ **Confusing the peak window's *end* with its *start*.** `rolling(7).sum().idxmax()` is the **end** (right edge) day; the window is the 7 days *ending* there. **Fix:** subtract `Timedelta(days=6)` for the start, or use `center=True`.
6. ⚠️ **Forgetting `min_periods`** and getting NaN for the first 6 rolling values. **Fix:** set `min_periods=1` if partial early windows are acceptable.

## 8. Interview Follow-ups

**Q: What's the difference between `resample` and `groupby` for time-series bucketing?**
A: Both group rows into buckets and aggregate, but `resample` operates on a `DatetimeIndex` with a frequency and **materializes empty buckets** (missing days/hours appear as NaN), giving a gap-free regular series. `groupby(date)` only produces buckets that have data, so gaps stay missing — fatal for rolling windows and diffs. Use `resample` (or reindex to a full range) whenever the regular grid matters.

**Q: An empty day appears — do you `fillna(0)` or `ffill`, and how do you decide?**
A: It depends on the metric's semantics. For a *flow* (sales total, event count) a day with no events is genuinely 0, so `fillna(0)`. For a *stock/level* (account balance, temperature, inventory) the value simply didn't change, so carry the last observation with `ffill`. Choosing wrong invents data — zero-filling a temperature or forward-filling a sales count both lie.

**Q: Why must you resample to a regular frequency before applying `rolling(7)`?**
A: `rolling(window=7)` counts *rows*, not time. On an irregular series, 7 rows might span two days or two weeks, so the "7-day average" is neither 7 days nor aligned to calendar dates. After resampling to one-row-per-day, 7 rows = 7 days. Alternatively, a time-based offset window `rolling("7D")` on a DatetimeIndex measures 7 calendar days directly without regularizing.

**Q: How do you find the peak 7-day window and report its date range?**
A: Compute the trailing-window sum with `rolling(7).sum()`, take `idxmax()` for the date where that sum is largest — that's the **end** of the peak window — and subtract `Timedelta(days=6)` for the start. The window is the 7 days ending on the idxmax date. Use `center=True` if you want the label on the middle day instead.

**Q: What does `min_periods` control in `rolling`, and when do you change it?** *(senior)*
A: `min_periods` is the minimum number of non-NaN observations required to emit a value; below it the window returns NaN. Default equals `window`, so the first `window-1` outputs are NaN. Set `min_periods=1` to get partial averages from the very first row (useful for charts), or a higher value to suppress unstable early estimates from too little data.

**Q: How would you handle upsampling — going to a finer frequency than the data?** *(senior)*
A: Upsampling (e.g. daily data to hourly with `resample("H")`) creates rows with no source data, which come out NaN. You fill them according to meaning: `ffill`/`bfill` to hold values, or `.interpolate("time")` for a smooth linear/time-weighted curve between known points. You can't sum your way to more resolution — you're inferring intermediate values.

**Q: What's the difference between a simple `rolling().mean()` and an EWMA (`ewm`)?** *(senior)*
A: A simple rolling mean weights all N days in the window equally and drops days as they leave the window (a sharp edge). An exponentially weighted moving average (`ewm(span=n).mean()`) weights recent observations more and older ones with geometrically decaying weight, never fully dropping them — so it reacts faster to recent changes and is smoother at the window edge. Use EWMA when recency should dominate.

**Q: How do timezones and DST affect daily resampling, and how do you handle them?** *(senior)*
A: `resample("D")` buckets by the index's notion of midnight. If timestamps are naive or in UTC, "daily" boundaries may not match local days, and DST transitions make some local days 23 or 25 hours. Localize/convert first (`tz_localize("UTC").tz_convert("America/New_York")`) so buckets align to local midnight; be aware DST days have irregular length and choose an anchoring convention deliberately.

**Q: How do you validate that resampling didn't drop or double-count events?**
A: Check a conservation invariant: the sum of the resampled series must equal the sum of the raw values (`daily.sum() == events["amount"].sum()`), and the last `cumsum` equals that same total. Also verify the index matches the expected `date_range` with no missing/duplicate timestamps. If totals disagree, look for unsorted data, duplicate timestamps collapsed by aggregation, or NaNs excluded by `sum`.

**Q: What does a time-based offset window like `rolling("7D")` do that `rolling(7)` doesn't?**
A: `rolling("7D")` uses the DatetimeIndex to include all rows within the trailing 7 *calendar days* of each point, regardless of how many rows that is — so it works correctly on irregular data without resampling. `rolling(7)` always takes exactly 7 rows. Offset windows are ideal when you want a true time span but can't or don't want to regularize the series first.

## 9. Cheat Sheet

> [!TIP]
> **Resample & rolling playbook**
> - **Regularize first:** `s = df.set_index("ts").sort_index()` — time methods need a sorted DatetimeIndex.
> - **Daily buckets (fills gaps):** `daily = s["amount"].resample("D").sum()` → `.fillna(0)` for totals, `.ffill()` for levels.
> - **Rolling avg (7 days ⇔ 7 rows after resample):** `daily.rolling(7, min_periods=1).mean()`. Irregular data? use `rolling("7D")`.
> - **Running total:** `daily.cumsum()` (ends at the grand total).
> - **Peak window:** `end = daily.rolling(7).sum().idxmax()`; `start = end - Timedelta(days=6)`.
> - **Cadence:** `resample("W"/"H"/"MS"/"15min")`; upsample → `interpolate("time")`.
> - **Sanity:** `daily.sum() == raw.sum()` and last `cumsum` == raw total.

**References:** pandas User Guide — "Time series / date functionality" (resampling, rolling, windowing); pandas `resample`, `rolling`, `ewm`, `cumsum` API docs; "Time-aware rolling" and "Resampling" cookbook entries.

---
*NumPy & Pandas Handbook — topic 31.*
