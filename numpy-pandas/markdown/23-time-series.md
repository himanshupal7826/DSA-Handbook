# 23 · Time Series & Resampling

> **In one line:** Put time on the index, then resample, roll, shift, and re-zone it with calendar-aware operations no plain integer index can do.

---

## 1. Overview

Time series work is what pandas was *born* for — the library grew out of quant finance, and its **DatetimeIndex** is the feature that unlocks the whole toolbox. Once a column of timestamps becomes the index, you get calendar arithmetic, frequency-aware alignment, gap-filling, and grouping by "month" or "business day" for free.

The core problem is that raw event data arrives at irregular, high-frequency, or timezone-ambiguous timestamps, and analysis needs it at a *regular* frequency: daily revenue, hourly averages, 5-minute OHLC bars. **Resampling** is the bridge — a groupby specialized for time. **Downsampling** collapses fine data into coarse buckets (ticks → minutes) with an aggregation; **upsampling** expands coarse into fine (monthly → daily) and fills the new slots.

You reach for this whenever the *when* matters: metrics over rolling windows, period-over-period diffs, lag features for a model, or reconciling data recorded in different timezones. The golden rule: **get the timestamps into a real `DatetimeIndex` first** — almost every time-series method assumes it.

## 2. Core Concepts

- **`DatetimeIndex`** — an index of `datetime64[ns]` values. Enables partial-string slicing (`df['2026-07']`), `.dt`-like calendar attributes, and frequency inference.
- **`to_datetime`** — parse strings/ints to timestamps. Pass `format=` for speed and safety; `utc=True` to land everything in UTC.
- **`resample(rule)`** — time-based groupby. Returns a `Resampler`; you chain an aggregation (`.mean()`, `.ohlc()`) for downsampling or a fill (`.ffill()`, `.interpolate()`) for upsampling.
- **Offset aliases** — the frequency strings: `D` day, `h` hour, `min` minute, `W` week, `MS`/`ME` month-start/end, `QE` quarter-end, `YE` year-end, `B` business day.
- **`asfreq(rule)`** — change the frequency *without* aggregating; just reindex onto a regular grid, inserting `NaN` (or a fill) at new stamps.
- **`shift(n)` / `diff(n)`** — move data forward/back by `n` rows (lag/lead features); `diff` is `x - x.shift`.
- **`rolling(window)`** — sliding-window stats. With a **time-based** window (`'7D'`) the window spans a duration, not a fixed row count — correct even with gaps.
- **`tz_localize`** — attach a timezone to naive stamps (interpret them). **`tz_convert`** — translate already-aware stamps into another zone.
- **Closed / label** — each bucket has a `closed` side (which edge is inclusive) and a `label` (which edge names the row). Defaults differ by frequency; know them for boundary correctness.

## 3. Syntax & Examples

```python
import pandas as pd, numpy as np

# Parse to a DatetimeIndex (always specify format when you can)
ts = pd.to_datetime(["2026-07-01 09:00", "2026-07-01 09:30"],
                    format="%Y-%m-%d %H:%M")

# Build a series indexed by time
idx = pd.date_range("2026-07-01", periods=6, freq="h")
s = pd.Series([10, 12, 9, 15, 11, 14], index=idx)

# Partial-string slicing — no exact match needed
s["2026-07-01"]            # all of that day
s["2026-07-01 09":"2026-07-01 11"]

# DOWNSAMPLE: hourly -> 3-hour sums
s.resample("3h").sum()

# UPSAMPLE: hourly -> 30-min, forward-fill the new slots
s.resample("30min").ffill()

# asfreq: reindex to a grid WITHOUT aggregating
s.asfreq("30min")          # NaN in the gaps
s.asfreq("30min", method="ffill")

# Lag / delta features
s.shift(1)                 # yesterday's value on today's row
s.diff()                   # s - s.shift(1)
s.pct_change()             # relative change

# Time-based rolling (a 3-hour window, gap-safe)
s.rolling("3h").mean()

# Timezones: localize naive -> aware, then convert
aware = s.tz_localize("UTC")
aware.tz_convert("Asia/Kolkata")
```

## 4. Worked Example

End-to-end: a day of irregular trade ticks → clean 1-hour OHLC bars with volume.

```python
ticks = pd.DataFrame({
    "ts":    pd.to_datetime([
        "2026-07-01 09:05", "2026-07-01 09:47", "2026-07-01 10:12",
        "2026-07-01 10:58", "2026-07-01 11:03", "2026-07-01 11:59"]),
    "price": [101.0, 102.5, 101.8, 103.2, 103.0, 104.1],
    "size":  [10, 4, 7, 3, 9, 6],
}).set_index("ts")

bars = ticks["price"].resample("1h").ohlc()
bars["volume"] = ticks["size"].resample("1h").sum()
print(bars)
```

Result — six irregular ticks collapse into three clean hourly bars:

| ts                  | open  | high  | low   | close | volume |
|---------------------|-------|-------|-------|-------|--------|
| 2026-07-01 09:00:00 | 101.0 | 102.5 | 101.0 | 102.5 | 14     |
| 2026-07-01 10:00:00 | 101.8 | 103.2 | 101.8 | 103.2 | 10     |
| 2026-07-01 11:00:00 | 103.0 | 104.1 | 103.0 | 104.1 | 15     |

The `09:00` bar's `open` is the 09:05 tick and its `close` is the 09:47 tick — `resample` grouped every timestamp into its containing hour, and each bucket is labelled by its **left edge** (the default for `h`).

## 5. Under the Hood

`resample("3h")` does not scan a Python loop over your rows. It computes bucket **edges** from the offset, then uses a fast C `searchsorted`/`groupby` over the underlying `int64` nanosecond values to assign each row to a bucket, then applies the aggregation over the grouped blocks. Downsampling is a group-and-reduce; upsampling is a reindex-onto-a-finer-grid followed by a fill. `asfreq` is *just* that reindex with no reduction.

Two knobs decide which row lands in which bucket: **`closed`** (is the bucket `[start, end)` or `(start, end]`?) and **`label`** (does the output row carry the left or right edge?). For most frequencies the bucket is left-closed, left-labelled; for `ME`/`W`/`QE`/`YE` it flips to right-closed, right-labelled. Get these wrong and a value sits one bucket over.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">resample("3h").sum() — group timestamps into fixed buckets</text>

  <!-- raw hourly points -->
  <text x="20" y="70" fill="#64748b">raw (1h)</text>
  <line x1="90" y1="80" x2="680" y2="80" stroke="#475569"/>
  <g fill="#1e293b" text-anchor="middle">
    <circle cx="120" cy="80" r="5" fill="#2563eb"/><text x="120" y="105">10</text>
    <circle cx="200" cy="80" r="5" fill="#2563eb"/><text x="200" y="105">12</text>
    <circle cx="280" cy="80" r="5" fill="#2563eb"/><text x="280" y="105">9</text>
    <circle cx="400" cy="80" r="5" fill="#2563eb"/><text x="400" y="105">15</text>
    <circle cx="480" cy="80" r="5" fill="#2563eb"/><text x="480" y="105">11</text>
    <circle cx="560" cy="80" r="5" fill="#2563eb"/><text x="560" y="105">14</text>
  </g>

  <!-- buckets -->
  <rect x="100" y="140" width="240" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="220" y="168" text-anchor="middle" fill="#1e293b">bucket 09:00  [09,12)</text>
  <rect x="360" y="140" width="240" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="480" y="168" text-anchor="middle" fill="#1e293b">bucket 12:00  [12,15)</text>

  <line x1="120" y1="90" x2="180" y2="138" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="200" y1="90" x2="205" y2="138" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="280" y1="90" x2="240" y2="138" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="400" y1="90" x2="440" y2="138" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="480" y1="90" x2="470" y2="138" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="560" y1="90" x2="510" y2="138" stroke="#475569" marker-end="url(#ar)"/>

  <!-- result -->
  <rect x="100" y="230" width="240" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="220" y="258" text-anchor="middle" fill="#1e293b" font-weight="700">sum = 31</text>
  <rect x="360" y="230" width="240" height="46" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="480" y="258" text-anchor="middle" fill="#1e293b" font-weight="700">sum = 40</text>
  <line x1="220" y1="188" x2="220" y2="228" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="480" y1="188" x2="480" y2="228" stroke="#475569" marker-end="url(#ar)"/>
  <text x="655" y="258" text-anchor="middle" fill="#64748b">left-labelled</text>
</svg>
```

## 6. Variations & Trade-offs

| Operation | Changes frequency? | Aggregates? | Fills gaps? | Use when |
|-----------|-------------------|-------------|-------------|----------|
| `resample().mean()` | yes (down) | yes | n/a | many→few: bin fine data |
| `resample().ffill()` | yes (up) | no | yes | few→many: expand + carry forward |
| `asfreq()` | yes | no | optional | put on a regular grid, keep exact values |
| `rolling(w)` | no | yes (windowed) | no | smoothing, moving averages |
| `shift(n)` | no | no | inserts NaN | lag/lead features |
| `groupby(pd.Grouper(freq=))` | yes | yes | n/a | resample *within* another group key |

Downsampling is lossy but denoising; upsampling never creates information — `ffill`/`interpolate` only *invent* plausible values, so be honest about it downstream. `resample` needs a `DatetimeIndex`; `pd.Grouper(freq=..., key='col')` lets you resample by a timestamp *column* while grouping by something else. Prefer time-based `rolling('7D')` over count-based `rolling(7)` whenever rows can be missing — the fixed count silently spans a variable duration.

## 7. Production / Performance Notes

- **Always pass `format=` to `to_datetime`.** Inference is 10–100× slower and can silently misparse `MM/DD` vs `DD/MM`. Use `errors='coerce'` to turn bad rows into `NaT` instead of crashing a pipeline.
- **Store and compute in UTC; convert to local only for display.** Mixing naive and aware timestamps raises, and DST transitions cause duplicate or missing wall-clock hours — `tz_localize` exposes `ambiguous=` and `nonexistent=` for exactly these.
- **`datetime64[ns]` overflows outside ~1677–2262.** For out-of-range dates use `datetime64[us]`/`[s]` (pandas 2.0+ supports non-nano resolutions) or `Period`.
- Sort the index before slicing/resampling — partial-string slices on an unsorted `DatetimeIndex` are slow or raise.
- `resample` on a huge frame is memory-cheap (group-reduce) but `resample().apply(python_func)` reintroduces the Python-loop tax; prefer built-in reducers or `.agg(['mean','max'])`.
- For lag features in ML, generate them with `shift` **after** sorting and **within** each entity group (`df.groupby('id')['y'].shift(1)`) to avoid leaking across series.

## 8. Common Mistakes

1. ⚠️ Resampling a frame whose timestamps are still **strings** → `TypeError`. Fix: `set_index(pd.to_datetime(col))` first.
2. ⚠️ Letting `to_datetime` **infer** the format and getting month/day swapped. Fix: pass explicit `format=`.
3. ⚠️ Confusing **`resample`** (aggregates) with **`asfreq`** (only reindexes). If you want a mean per hour you need `resample`, not `asfreq`.
4. ⚠️ Assuming every frequency labels buckets on the **left**. `ME`, `W`, `QE` label on the **right** and are right-closed — off-by-one-bucket bugs.
5. ⚠️ **`tz_localize` vs `tz_convert`** mix-up: localize *attaches* a zone to naive data; convert *translates* aware data. Localizing already-aware data raises.
6. ⚠️ Upsampling and forgetting to fill → a frame full of `NaN` and confusion. Chain `.ffill()`/`.interpolate()`.
7. ⚠️ Count-based `rolling(7)` on gappy data, thinking it means "7 days." Use `rolling('7D')`.
8. ⚠️ `shift` **across** entities in a multi-series frame, leaking the previous group's last value. Shift inside `groupby`.

## 9. Interview Questions

**Q: What does a DatetimeIndex give you that a plain RangeIndex does not?**
A: Calendar-aware operations: partial-string slicing (`df['2026-07']`), `resample`/`asfreq`, time-based `rolling`, timezone localize/convert, and frequency inference — all keyed off the underlying int64 nanosecond values.

**Q: Explain downsampling vs upsampling.**
A: Downsampling reduces frequency (many rows → fewer buckets) and requires an aggregation like `mean`/`sum`/`ohlc`. Upsampling increases frequency (few → many), creating empty slots you must fill with `ffill`/`bfill`/`interpolate`. Downsampling loses detail; upsampling adds no real information.

**Q: How does `resample` differ from `asfreq`?**
A: `resample` is a time-based groupby that aggregates rows into buckets. `asfreq` only reindexes onto a regular frequency grid without aggregating — new stamps get `NaN` (or an optional fill). Use `resample` to summarize, `asfreq` to regularize while keeping exact values.

**Q: What do `closed` and `label` control in `resample`?**
A: `closed` sets which edge of each interval is inclusive (left vs right); `label` sets which edge names the output row. Defaults are left/left for most frequencies but right/right for `ME`, `W`, `QE`, `YE` — a common source of off-by-one-bucket errors.

**Q: Difference between `tz_localize` and `tz_convert`?**
A: `tz_localize` attaches a timezone to *naive* timestamps (declares what zone the wall-clock numbers were in). `tz_convert` translates *already-aware* timestamps into another zone, shifting the wall-clock display. You localize once, then convert as many times as needed.

**Q: What is the difference between `shift` and `diff`?**
A: `shift(n)` moves values down (or up) by `n` positions, inserting `NaN` at the exposed end — used for lag/lead features. `diff(n)` is `x - x.shift(n)`, the change over `n` periods. `pct_change` is the relative version.

**Q: (Senior) Why prefer a time-based rolling window (`'7D'`) over a count window (`7`)?**
A: A count window assumes evenly spaced rows; with gaps or irregular sampling it silently spans a variable real duration. `'7D'` defines the window by elapsed time using the DatetimeIndex, so it stays a true 7-day window regardless of how many observations fall inside.

**Q: (Senior) How do you handle DST transitions safely?**
A: Store data in UTC and only convert for display. When you must localize local wall-clock times, DST creates ambiguous (fall-back, repeated hour) and nonexistent (spring-forward, skipped hour) stamps; `tz_localize` takes `ambiguous=` and `nonexistent=` arguments to resolve them explicitly instead of raising.

**Q: (Senior) You need to resample within each customer. How?**
A: `df.groupby('customer').resample('D', on='ts').sum()` or `df.groupby(['customer', pd.Grouper(key='ts', freq='D')]).sum()`. `pd.Grouper` lets you combine a normal group key with a time bucket in one pass.

**Q: Why always pass `format=` to `to_datetime`?**
A: Format inference is far slower on large inputs and can misparse ambiguous strings (e.g. `03/04/2026`). An explicit format is fast, deterministic, and fails loudly on malformed data (or with `errors='coerce'` yields `NaT`).

**Q: What is `NaT` and how does it behave?**
A: `NaT` (Not a Time) is the datetime equivalent of `NaN`. It propagates through datetime arithmetic, is excluded by default in aggregations, and is what `to_datetime(errors='coerce')` produces for unparseable values.

## 10. Practice

- [ ] Parse a CSV column of `"DD-MM-YYYY HH:MM"` strings with an explicit `format=`, set it as the index, and slice out a single day.
- [ ] Downsample a minute-level series into hourly OHLC bars plus a summed volume column.
- [ ] Take a monthly series, upsample to daily two ways (`ffill` vs `interpolate`) and compare.
- [ ] Add a 7-day time-based rolling mean and a `shift(1)` lag column, then compute `diff` and `pct_change`.
- [ ] Localize a naive UTC series, convert it to `Asia/Kolkata`, and verify the wall-clock shift.

## 11. Cheat Sheet

> [!TIP]
> **Time Series in one screen.** Get a `DatetimeIndex` first: `to_datetime(col, format=...)` then `set_index`. **Downsample** = `resample(rule).agg` (many→few, needs a reducer: `mean`/`sum`/`ohlc`). **Upsample** = `resample(rule).ffill/interpolate` (few→many, must fill). **`asfreq`** = reindex to a grid, no aggregation. Offsets: `D h min W MS ME QE YE B`. **`shift`/`diff`/`pct_change`** = lag & delta features (shift inside `groupby` for multi-series). **`rolling('7D')`** = gap-safe time window; count windows assume even spacing. Zones: **`tz_localize`** attaches a zone to naive stamps, **`tz_convert`** translates aware ones — store UTC, display local. Watch `closed`/`label` defaults (right-labelled for `ME`/`W`/`QE`/`YE`).

**References:** pandas User Guide "Time series / date functionality", pandas "Resampling" docs, "Time zone handling" docs

---

*NumPy & Pandas Handbook — topic 23.*
