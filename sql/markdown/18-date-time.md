# 18 · Date/Time Functions & Intervals

> **In one line:** Store instants as `timestamptz`, bucket with `DATE_TRUNC`, do arithmetic with `INTERVAL`, and keep the indexed column bare so range scans still work.

---

## 1. Overview

Every reporting query eventually becomes a time question: "revenue per month", "sign-ups in the last 7 days", "sessions grouped by hour". Getting this right rests on two decisions made early — **which type stores the moment** and **which function buckets it**.

The type decision is `timestamp` vs `timestamptz`. Despite the name, `timestamptz` does **not** store a time zone; it stores an absolute instant (UTC internally) and converts to the session's zone on display. `timestamp` (without time zone) stores wall-clock digits with no zone meaning — a common source of "off by N hours" bugs. For anything representing "a real moment that happened", use `timestamptz`.

The bucketing decision is `DATE_TRUNC` (and `EXTRACT`). `DATE_TRUNC('month', ts)` snaps a timestamp down to the start of its month, which is how you build "per month" reports that group and sort correctly. `EXTRACT` pulls out a field (year, dow, epoch) for grouping or filtering.

The performance lens: keep the **indexed timestamp column bare** in `WHERE`. `WHERE created_at >= :from AND created_at < :to` uses an index; `WHERE DATE(created_at) = :d` or `EXTRACT(month FROM created_at)=7` wraps the column in a function and forces a scan (unless you built an expression index).

## 2. Core Concepts

- **`timestamptz`** — an absolute instant stored as UTC; input/output converted per session `TimeZone`. Use for real events. **`timestamp`** — naive wall-clock, no zone; use only for zone-less local times.
- **`DATE` / `TIME` / `INTERVAL`** — calendar date, clock time, and a duration (`INTERVAL '1 day'`, `'3 months'`, `'2 hours'`).
- **`NOW()` / `CURRENT_TIMESTAMP`** — transaction start instant (`timestamptz`); **`CURRENT_DATE`** — today's date; `clock_timestamp()` = real wall clock, moves within a statement.
- **`EXTRACT(field FROM ts)`** — pull `year`, `month`, `day`, `dow` (0=Sun), `hour`, `epoch` (seconds since 1970).
- **`DATE_TRUNC(unit, ts)`** — floor to `'day'`/`'week'`/`'month'`/`'quarter'`/`'hour'`; the core of time-bucketed reports.
- **Interval arithmetic** — `ts + INTERVAL '7 days'`, `ts - ts` → `interval`, `date - date` → integer days.
- **`AGE(a, b)`** — human "years/months/days" difference (calendar-aware), unlike a raw interval of seconds.
- **Time zones** — `ts AT TIME ZONE 'Asia/Kolkata'` converts; `SET TimeZone` changes the session's display zone; DST is handled by named zones, not fixed offsets.
- **`generate_series(start, stop, step)`** — produce a dense calendar to left-join against, so empty buckets still appear.

## 3. Syntax & Examples

```sql
-- Types & "now"
SELECT NOW()                       AS instant_tz,   -- timestamptz, tx start
       CURRENT_DATE                AS today,        -- date
       NOW() + INTERVAL '7 days'   AS next_week,    -- interval arithmetic
       CURRENT_DATE - INTERVAL '30 days' AS since;  -- 30-day window start
```

```sql
-- EXTRACT vs DATE_TRUNC
SELECT EXTRACT(YEAR  FROM created_at)  AS yr,
       EXTRACT(DOW   FROM created_at)  AS weekday,   -- 0=Sun … 6=Sat
       DATE_TRUNC('month', created_at) AS month_start,
       DATE_TRUNC('hour',  created_at) AS hour_bucket
FROM events;
```

```sql
-- Monthly report: bucket, group, order (SARGABLE filter on bare column)
SELECT DATE_TRUNC('month', created_at) AS month,
       COUNT(*)                        AS orders,
       SUM(amount)                     AS revenue
FROM orders
WHERE created_at >= DATE '2026-01-01'
  AND created_at <  DATE '2027-01-01'
GROUP BY 1
ORDER BY 1;
```

```sql
-- Time-zone conversion & AGE
SELECT event_at,
       event_at AT TIME ZONE 'Asia/Kolkata' AS local_ist,  -- tz -> naive local
       AGE(NOW(), signup_at)                 AS tenure       -- "2 years 3 mons"
FROM users;
```

```sql
-- Gap-filled date series (empty days still appear)
SELECT d::date AS day, COUNT(o.id) AS orders
FROM generate_series(DATE '2026-07-01', DATE '2026-07-07', INTERVAL '1 day') AS d
LEFT JOIN orders o ON o.created_at >= d AND o.created_at < d + INTERVAL '1 day'
GROUP BY 1 ORDER BY 1;
```

## 4. Sample Data & Results

Input — `orders` (`created_at` is `timestamptz`):

| id | created_at            | amount |
|----|-----------------------|--------|
| 1  | 2026-01-14 09:20+00   | 120    |
| 2  | 2026-01-30 22:05+00   | 80     |
| 3  | 2026-02-03 11:00+00   | 200    |
| 4  | 2026-02-28 18:45+00   | 60     |
| 5  | 2026-03-05 07:10+00   | 150    |

Query (the monthly report from §3) →

| month                  | orders | revenue |
|------------------------|--------|---------|
| 2026-01-01 00:00+00    | 2      | 200     |
| 2026-02-01 00:00+00    | 2      | 260     |
| 2026-03-01 00:00+00    | 1      | 150     |

`DATE_TRUNC('month', …)` collapsed the day/time components so both January rows fell into one bucket, giving a clean per-month grouping key that also sorts chronologically.

## 5. Under the Hood

`timestamptz` is stored as an 8-byte integer count from the epoch **in UTC** — the zone is a *display* concern applied on read. So two clients in different zones inserting "the same instant" store identical bytes; `timestamp` (naive) stores whatever digits were given, with no reconciliation, which is why mixing it with real events causes drift.

For queries, the decisive fact is index usability. A B-tree on `created_at` is sorted by instant. A **half-open range** `>= from AND < to` becomes a single contiguous index range scan. Wrapping the column — `DATE(created_at)=…`, `EXTRACT(month FROM created_at)=2`, `DATE_TRUNC('month',created_at)='2026-02-01'` — transforms every row before comparison, so the index can't seek and the engine scans.

```svg
<svg viewBox="0 0 640 280" width="100%" height="280" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>
  <!-- good -->
  <rect x="20" y="24" width="300" height="110" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="170" y="46" text-anchor="middle" fill="#1e293b" font-weight="600">created_at &gt;= from AND &lt; to</text>
  <line x1="45" y1="90" x2="295" y2="90" stroke="#475569" stroke-width="1.5"/>
  <rect x="120" y="78" width="110" height="24" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="45" y="118" text-anchor="middle" fill="#64748b">Jan</text>
  <text x="175" y="118" text-anchor="middle" fill="#059669">seek range</text>
  <text x="295" y="118" text-anchor="middle" fill="#64748b">Dec</text>
  <text x="170" y="128" text-anchor="middle" fill="#059669" font-size="11">contiguous index scan ✓</text>

  <!-- bad -->
  <rect x="340" y="24" width="280" height="110" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="480" y="46" text-anchor="middle" fill="#1e293b" font-weight="600">DATE(created_at) = :d</text>
  <text x="480" y="72" text-anchor="middle" fill="#64748b">function applied per row</text>
  <text x="480" y="96" text-anchor="middle" fill="#b91c1c">index unusable → Seq Scan</text>
  <text x="480" y="118" text-anchor="middle" fill="#64748b">unless expression index on DATE(created_at)</text>

  <!-- truncation illustration -->
  <text x="320" y="176" text-anchor="middle" fill="#1e293b" font-weight="600">DATE_TRUNC('month', ts) floors the instant</text>
  <rect x="120" y="192" width="180" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="210" y="212" text-anchor="middle" fill="#1e293b">2026-01-30 22:05</text>
  <line x1="304" y1="207" x2="336" y2="207" stroke="#475569" stroke-width="1.5" marker-end="url(#arr)"/>
  <rect x="340" y="192" width="180" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="430" y="212" text-anchor="middle" fill="#1e293b">2026-01-01 00:00</text>
  <text x="320" y="248" text-anchor="middle" fill="#64748b">both January rows share this bucket key → one group</text>
</svg>
```

To keep bucketed reports index-friendly, filter on the **bare column with a range** and use `DATE_TRUNC` only in the `SELECT`/`GROUP BY`, or build an **expression index** (`CREATE INDEX ON orders (DATE_TRUNC('month', created_at))`) when you truly must filter on the truncated value.

## 6. Variations & Trade-offs

| Choice | Use it for | Watch out |
|--------|-----------|-----------|
| `timestamptz` | Real events, cross-zone systems | Displays in session zone — set `TimeZone` explicitly |
| `timestamp` | Zone-less local wall time | No zone → silent offset bugs if used for events |
| `DATE_TRUNC(unit, ts)` | Report bucketing (month/day/hour) | Returns a timestamp, not a label; non-sargable in WHERE |
| `EXTRACT(field FROM ts)` | Grouping by year/dow, epoch math | `dow` 0=Sun; filtering by it is non-sargable |
| `AGE(a,b)` | Human "y/m/d" tenure | Calendar-aware; not a fixed-second interval |
| `a - b` (interval) | Exact elapsed duration | `date-date`=int days; `ts-ts`=interval |
| `generate_series` | Gap-filling empty buckets | Match series type to column; mind boundaries |

PostgreSQL has the richest set (`DATE_TRUNC`, `AGE`, `generate_series`, `AT TIME ZONE`). MySQL uses `DATE_FORMAT`/`STR_TO_DATE`, `DATE_ADD`/`DATE_SUB`, `TIMESTAMPDIFF`, and `CONVERT_TZ` — same ideas, different spellings, and MySQL truncation is typically emulated via `DATE_FORMAT(ts,'%Y-%m-01')`.

## 7. Performance Notes

- **Range, don't wrap.** `created_at >= :from AND created_at < :to` (half-open) uses a B-tree index; `DATE(created_at)=`, `EXTRACT(...)=`, `DATE_TRUNC(...) =` do not — they force a scan.
- Half-open `< to` avoids the `BETWEEN` boundary bug where `<= '2026-01-31'` misses times on the 31st after midnight.
- **Expression index** `(DATE_TRUNC('month', created_at))` makes bucket-filtered queries sargable when a rewrite isn't possible; cost is index maintenance.
- For time-series at scale, **range-partition** by month/day and BRIN-index the timestamp — BRIN is tiny and ideal for naturally time-ordered inserts.
- `NOW()` is stable within a transaction (good for reproducibility); `clock_timestamp()` changes mid-statement — don't use it as a filter boundary you expect to be constant.
- Comparing `timestamp` to `timestamptz` triggers implicit conversion using the session zone — align types to avoid surprise offsets and lost index use.
- `EXPLAIN` check: `Index Cond: (created_at >= …)` = good; `Filter: (date_trunc(...) = …)` on a `Seq Scan` = wrap-the-column problem.

## 8. Common Mistakes

1. ⚠️ Storing real events in `timestamp` (no zone) — inserts from different zones become inconsistent instants. Use `timestamptz`.
2. ⚠️ `WHERE DATE(created_at) = '2026-07-02'` — non-sargable; rewrite as `>= '2026-07-02' AND < '2026-07-03'`.
3. ⚠️ `BETWEEN a AND b` on timestamps — inclusive upper bound silently drops or double-counts the last day's times. Use half-open `>= a AND < b`.
4. ⚠️ Thinking `timestamptz` stores a zone — it stores UTC and displays in the session zone; a wrong `TimeZone` setting misleads you, not the data.
5. ⚠️ Using fixed offsets (`+05:30`) instead of named zones (`Asia/Kolkata`) — offsets ignore DST and break twice a year.
6. ⚠️ Confusing `AGE()` (calendar y/m/d) with `a - b` (raw interval of days/seconds) — they give different numbers for the same span.
7. ⚠️ Grouping a report by `DATE_TRUNC` but leaving empty periods missing — join against `generate_series` to show zero-rows.
8. ⚠️ `EXTRACT(DOW …)` assuming Monday=1 — it's 0=Sunday; use `ISODOW` for Monday=1.

## 9. Interview Questions

**Q: What's the real difference between `timestamp` and `timestamptz`?**
A: `timestamptz` stores an absolute instant normalized to UTC and converts to the session's zone on display; `timestamp` stores naive wall-clock digits with no zone meaning. Use `timestamptz` for real events so instants stay consistent across zones.

**Q: Does `timestamptz` store the time zone?**
A: No — that's the naming trap. It stores a UTC instant; the input zone is used to convert to UTC and is then discarded. Display zone comes from the session `TimeZone` setting.

**Q: How do you build a "revenue per month" report?**
A: `SELECT DATE_TRUNC('month', created_at) AS month, SUM(amount) FROM orders GROUP BY 1 ORDER BY 1`. `DATE_TRUNC` floors each timestamp to the month start, giving a groupable, chronologically sortable bucket key.

**Q: Why is `WHERE DATE(created_at) = :d` slow, and what's the fix?**
A: Wrapping the column in `DATE()` transforms every row, so the B-tree index can't range-seek and the engine scans. Rewrite as a half-open range `created_at >= :d AND created_at < :d + INTERVAL '1 day'`, or add an expression index.

**Q: Why prefer half-open `>= a AND < b` over `BETWEEN a AND b` for timestamps?**
A: `BETWEEN` is inclusive on both ends, so a timestamp at `b 00:00` or times later on the last day get mishandled — double-counted or dropped. Half-open cleanly covers exactly one period and tiles adjacent ranges without overlap.

**Q: `EXTRACT` vs `DATE_TRUNC` — when do you use each?**
A: `DATE_TRUNC` floors to a unit and keeps a timestamp (good for bucketing/sorting a report). `EXTRACT` pulls a numeric field (year, dow, epoch) for grouping across periods (e.g. "orders by weekday") or computing durations.

**Q: How do you convert a stored UTC instant to a user's local time?**
A: `event_at AT TIME ZONE 'Asia/Kolkata'` yields the local wall-clock timestamp. Use named zones (not fixed offsets) so DST is handled; or `SET TimeZone` for the whole session's display.

**Q: `AGE(NOW(), signup_at)` vs `NOW() - signup_at` — what's the difference?**
A: `AGE` returns a calendar-aware "N years M months D days"; subtraction returns a raw interval (days/hours/seconds). For "2 years 3 months tenure" use `AGE`; for "exactly how many hours elapsed" use subtraction.

**Q: How do you show months with zero orders in a report?**
A: Generate a dense calendar with `generate_series(start, stop, INTERVAL '1 month')` and `LEFT JOIN` the data to it, so empty buckets produce rows with `COUNT(*) = 0` instead of vanishing.

**Q: A dashboard filters on `DATE_TRUNC('day', created_at) = :d` and it's scanning 50M rows. How do you scale it?**
A: Rewrite to a bare-column half-open range so the B-tree is used; better yet, range-partition by day and add a BRIN index on `created_at` (tiny, ideal for time-ordered inserts) so the planner prunes partitions and scans only the relevant block ranges.

**Q: Two servers in different time zones insert `NOW()`. Do the stored `timestamptz` values match for the same instant?**
A: Yes — both normalize to the same UTC instant regardless of server zone. That's exactly why `timestamptz` is correct for events; only the display differs by session zone.

## 10. Practice

- [ ] Write a per-week signup report using `DATE_TRUNC('week', …)` and order it chronologically.
- [ ] Convert a `WHERE DATE(created_at)=:d` filter into a sargable half-open range and confirm the index scan in `EXPLAIN`.
- [ ] Gap-fill a daily orders report for a week using `generate_series` + `LEFT JOIN` so empty days show 0.
- [ ] Compute each user's tenure with `AGE` and also the exact elapsed days with subtraction; compare.
- [ ] Convert a `timestamptz` column to three user time zones with `AT TIME ZONE` and observe DST behavior around a transition date.

## 11. Cheat Sheet

> [!TIP]
> **Type:** `timestamptz` for real events (UTC instant, session-zone display); `timestamp` only for zone-less local time. **Now:** `NOW()`/`CURRENT_TIMESTAMP` (tx start), `CURRENT_DATE`. **Bucket:** `DATE_TRUNC('month'|'day'|'hour', ts)` in SELECT/GROUP BY. **Pull field:** `EXTRACT(year|month|dow|epoch FROM ts)` (dow 0=Sun). **Math:** `ts + INTERVAL '7 days'`, `date-date`=int, `ts-ts`=interval, `AGE()` for y/m/d. **Zones:** `ts AT TIME ZONE 'Asia/Kolkata'`, named zones (DST-safe). **Perf:** filter the bare column with half-open `>= a AND < b` — never `DATE()/EXTRACT/DATE_TRUNC` in WHERE (non-sargable); gap-fill with `generate_series`.

**References:** PostgreSQL docs — Date/Time Types & Functions (`DATE_TRUNC`, `EXTRACT`, `AT TIME ZONE`, `generate_series`); MySQL Reference — Date and Time Functions; Use The Index, Luke — "Dates and Time Ranges"

---
*SQL Handbook — topic 18.*
