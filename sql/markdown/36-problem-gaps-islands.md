# 36 · Problem: Gaps & Islands / Streaks

> **In one line:** Collapse consecutive rows into contiguous ranges ("islands") and find the missing ones ("gaps") using the `ROW_NUMBER()` date-difference grouping trick.

---

## 1. Problem

Given daily login rows per user, find each user's **consecutive-day streaks** (contiguous date ranges: start, end, length) — the "islands" — and separately find the **gaps** (missing calendar days) within their active span.

```sql
CREATE TABLE logins (
    user_id  INT NOT NULL,
    log_date DATE NOT NULL,
    PRIMARY KEY (user_id, log_date)
);
```

**Sample input — `logins`** (user 7):

| user_id | log_date   |
|---------|------------|
| 7       | 2026-03-01 |
| 7       | 2026-03-02 |
| 7       | 2026-03-03 |
| 7       | 2026-03-06 |
| 7       | 2026-03-07 |
| 7       | 2026-03-10 |

**Expected output — islands (streaks):**

| user_id | streak_start | streak_end | days |
|---------|--------------|------------|------|
| 7       | 2026-03-01   | 2026-03-03 | 3    |
| 7       | 2026-03-06   | 2026-03-07 | 2    |
| 7       | 2026-03-10   | 2026-03-10 | 1    |

**Expected output — gaps (missing days between the span):**

| user_id | gap_start  | gap_end    | missing_days |
|---------|------------|------------|--------------|
| 7       | 2026-03-04 | 2026-03-05 | 2            |
| 7       | 2026-03-08 | 2026-03-09 | 2            |

---

## 2. Approach

The **gaps-and-islands** trick: for a *dense, contiguous* sequence, if you subtract a monotonically increasing counter from the position value, all members of the same run map to the **same constant** — a stable "group key".

For dates: `log_date − ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY log_date)` days is constant within a consecutive-day run. Consecutive dates increase by 1 day per row and `ROW_NUMBER` also increases by 1 per row, so their difference is invariant across the streak but *changes* the moment a gap appears. Group by `(user_id, that difference)` and aggregate `MIN(log_date)`, `MAX(log_date)`, `COUNT(*)`.

- **Islands** = groups of the constant key.
- **Gaps** = the gaps *between* consecutive islands: for each row, compare `log_date` to the previous row's date via `LAG`; whenever the jump exceeds 1 day, the span in between is a gap.

Both are single-pass window-function solutions. The alternative is `LAG`/`LEAD` boundary detection, which finds run starts/ends directly.

---

## 3. Solution

**Islands (streaks)** — the ROW_NUMBER difference grouping:

```sql
WITH keyed AS (
    SELECT
        user_id,
        log_date,
        -- group key: constant within a consecutive-day run
        log_date - (ROW_NUMBER() OVER (PARTITION BY user_id
                                       ORDER BY log_date))::int AS grp
    FROM logins
)
SELECT
    user_id,
    MIN(log_date)                        AS streak_start,
    MAX(log_date)                        AS streak_end,
    COUNT(*)                             AS days
FROM keyed
GROUP BY user_id, grp
ORDER BY user_id, streak_start;
```

In PostgreSQL, `date − integer` yields a date, so `log_date - rn` produces a **distinct anchor date per run**; that anchor is the group key. (In MySQL use `DATE_SUB(log_date, INTERVAL ROW_NUMBER() … DAY)` or subtract on the day number.)

**Gaps** — detect jumps > 1 day with `LAG`:

```sql
WITH ordered AS (
    SELECT user_id, log_date,
           LAG(log_date) OVER (PARTITION BY user_id ORDER BY log_date) AS prev_date
    FROM logins
)
SELECT
    user_id,
    prev_date + 1                        AS gap_start,
    log_date  - 1                        AS gap_end,
    (log_date - prev_date - 1)           AS missing_days
FROM ordered
WHERE log_date - prev_date > 1           -- a jump means missing days in between
ORDER BY user_id, gap_start;
```

---

## 4. Walkthrough

Compute the group key for user 7. `ROW_NUMBER` ascends 1..6 by date; subtract it (as days) from `log_date`:

| log_date   | rn | log_date − rn (grp) |
|------------|----|---------------------|
| 2026-03-01 | 1  | 2026-02-28          |
| 2026-03-02 | 2  | 2026-02-28          |
| 2026-03-03 | 3  | 2026-02-28          |
| 2026-03-06 | 4  | 2026-03-02          |
| 2026-03-07 | 5  | 2026-03-02          |
| 2026-03-10 | 6  | 2026-03-04          |

The first three consecutive days share `grp = 2026-02-28`. At `03-06` a two-day gap bumps the date faster than the counter, so `grp` jumps to `2026-03-02`; `03-10` gives yet another key. Grouping by `grp` and taking `MIN/MAX/COUNT` yields the three streaks: 3 days, 2 days, 1 day — the expected islands.

For **gaps**, `LAG` pairs each date with its predecessor. Between `03-03` and `03-06` the difference is 3 days (> 1), so `gap_start = 03-04`, `gap_end = 03-05`, missing = 2. Between `03-07` and `03-10` the difference is 3, giving `03-08 … 03-09`. Rows with a 1-day step produce no gap.

```svg
<svg viewBox="0 0 640 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="20" y="22" fill="#1e293b" font-weight="bold">date − row_number() is constant within a streak</text>
  <text x="20" y="46" fill="#64748b" font-size="12">consecutive dates +1/row; row_number +1/row ⇒ difference invariant until a gap</text>
  <!-- streak 1 -->
  <rect x="30" y="60" width="270" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="165" y="85" text-anchor="middle" fill="#059669">03-01,02,03  → grp = 02-28  (island: 3 days)</text>
  <!-- gap -->
  <rect x="310" y="60" width="150" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="385" y="85" text-anchor="middle" fill="#d97706">03-04,05 gap</text>
  <!-- streak 2 -->
  <rect x="30" y="115" width="180" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="120" y="140" text-anchor="middle" fill="#059669">03-06,07 → grp=03-02</text>
  <rect x="220" y="115" width="150" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="295" y="140" text-anchor="middle" fill="#d97706">03-08,09 gap</text>
  <rect x="380" y="115" width="150" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="455" y="140" text-anchor="middle" fill="#059669">03-10 → grp=03-04</text>
  <text x="20" y="185" fill="#1e293b" font-weight="bold">Gap detection via LAG</text>
  <text x="20" y="210" fill="#64748b" font-size="12">WHERE log_date − LAG(log_date) &gt; 1 ⇒ gap = (prev+1 … curr−1)</text>
  <text x="20" y="232" fill="#2563eb" font-size="12">03-03 → 03-06 : diff 3 &gt; 1 ⇒ missing 03-04, 03-05</text>
</svg>
```

---

## 5. Variations & Follow-ups

**Streaks of length ≥ 3 only:** add `HAVING COUNT(*) >= 3`.

**Longest streak per user:** rank the islands — `ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY days DESC)` and keep rank 1.

**Contiguous integer IDs (not dates):** the key is simply `id − ROW_NUMBER() OVER (ORDER BY id)`; identical math finds contiguous ID ranges.

**Missing IDs in a sequence 1..max:** `LEFT JOIN` a generated series and keep the NULLs:

```sql
SELECT g AS missing_id
FROM generate_series(1, (SELECT MAX(id) FROM t)) g
LEFT JOIN t ON t.id = g
WHERE t.id IS NULL;               -- MySQL 8: use a recursive CTE for the series
```

**Islands over a status column** (e.g. runs of `status='active'`): filter to the status first, then apply the same `date − ROW_NUMBER()` trick, or use the "difference of two row numbers" variant partitioned by status.

**Allow 1-day tolerance** (streak survives a single missing day): bucket dates into tolerance windows before keying, or compare gaps to a threshold in the `LAG` step.

---

## 6. Alternative Solutions

**`LAG`-based boundary flagging** — mark where a new island starts (gap from the previous row), turn those flags into a running sum to build a group id, then aggregate:

```sql
WITH flagged AS (
    SELECT user_id, log_date,
           CASE WHEN log_date - LAG(log_date) OVER (PARTITION BY user_id
                                                    ORDER BY log_date) = 1
                THEN 0 ELSE 1 END AS is_new_island
    FROM logins
),
grouped AS (
    SELECT user_id, log_date,
           SUM(is_new_island) OVER (PARTITION BY user_id ORDER BY log_date) AS grp
    FROM flagged
)
SELECT user_id, MIN(log_date) AS streak_start, MAX(log_date) AS streak_end, COUNT(*) AS days
FROM grouped
GROUP BY user_id, grp;
```

| Approach | Idea | Pros | Cons |
|----------|------|------|------|
| `date − ROW_NUMBER()` grouping | Difference is constant within a run | One window + group-by; compact; no CASE | Requires a *dense* step of exactly 1; assumes no duplicates |
| `LAG` boundary + running `SUM` | Flag island starts, cumulative-sum into a group id | Handles custom "consecutive" rules and tolerances easily | Two window passes; more verbose |
| Recursive CTE walk | Chain each row to the next contiguous row | Works pre-window (old MySQL) | Slow, row-by-row; hard to read; recursion limits |
| `generate_series` LEFT JOIN | Enumerate expected values, keep missing | Best for *gaps*/missing IDs & dense calendars | Needs a full domain to enumerate; large series cost |

The `ROW_NUMBER` trick is the tightest for clean daily data; the `LAG`+`SUM` form is the more general engine when "consecutive" isn't a rigid `+1` (weekdays only, tolerance windows, status runs).

---

## 7. Performance & Indexes

```sql
CREATE INDEX idx_logins_user_date ON logins (user_id, log_date);
```

- Both window solutions need rows **ordered by `(user_id, log_date)`**; this index supplies that order, so `WindowAgg`/`ROW_NUMBER` run **without a sort** — a single index scan. Cost ≈ O(n) after the ordered read.
- The final `GROUP BY user_id, grp` groups already-adjacent rows; PostgreSQL can use a streaming/`GroupAggregate` since the derived key is monotonic within a partition, avoiding a hash and extra memory.
- The **`generate_series` LEFT JOIN** for missing IDs costs O(max_id): enumerating a huge domain (e.g. 1..1e9) is expensive — prefer the `LAG`/gap query when the present set is sparse and the domain is enormous, since it only inspects actual rows.

`EXPLAIN` tell: `WindowAgg` over `Index Scan` with no `Sort` is the target; a `Sort` before the window means the index order doesn't match — align the index to `(partition, order)`.

---

## 8. Common Mistakes

1. ⚠️ **Duplicate dates per user break the `date − ROW_NUMBER()` key.** Two rows on the same day desync the counter. **Fix:** de-duplicate first (`SELECT DISTINCT user_id, log_date`) or use `DENSE_RANK` on the day.
2. ⚠️ **Forgetting `PARTITION BY user_id`.** The row number runs across all users, so streaks merge between users. **Fix:** partition by the entity.
3. ⚠️ **Assuming a `+1` step when the domain isn't contiguous** (weekends, business days). Plain differencing then miscounts. **Fix:** map to a business-day sequence or use `LAG`-with-threshold.
4. ⚠️ **Off-by-one in gap bounds.** The gap is `prev+1 … curr−1`, not `prev … curr`. **Fix:** add/subtract one day and compute `curr − prev − 1` missing days.
5. ⚠️ **Using `RANK`/`DENSE_RANK` instead of `ROW_NUMBER` for the key.** Ties would repeat numbers and corrupt the constant-difference invariant. **Fix:** `ROW_NUMBER` (gapless, unique per row).
6. ⚠️ **Enumerating a giant `generate_series` to find a few missing dates.** Wastes work on a sparse set. **Fix:** the `LAG` gap query touches only real rows.

---

## 9. Interview Follow-ups

**Q: Why is `log_date − ROW_NUMBER()` constant within a consecutive-day streak?**
A: Along a run, the date increases by exactly one day per row and `ROW_NUMBER` increases by exactly one per row, so their difference is invariant; the instant a day is missing, the date jumps more than the counter and the difference changes, starting a new group.

**Q: Why `ROW_NUMBER` rather than `RANK` or `DENSE_RANK` for the grouping key?**
A: The trick needs a gapless, strictly +1 counter with no repeats; `RANK`/`DENSE_RANK` repeat numbers on ties, which would desynchronize the constant-difference relationship. `ROW_NUMBER` guarantees one unique increment per row.

**Q: How do you find the gaps (missing days) rather than the islands?**
A: Order by date, take `LAG(log_date)`, and where `log_date − prev_date > 1` emit the interval `(prev_date + 1 … log_date − 1)` with `log_date − prev_date − 1` missing days. This inspects only present rows.

**Q: The data has duplicate dates per user. What breaks and how do you fix it?**
A: Duplicates advance `ROW_NUMBER` without advancing the date, so the `date − rn` key drifts and splits real streaks. De-duplicate to one row per user-day first (`DISTINCT` or `GROUP BY`), or key off a dense per-day rank.

**Q: How would you adapt the island trick to contiguous integer IDs instead of dates?**
A: Identically: `id − ROW_NUMBER() OVER (ORDER BY id)` is constant across a contiguous run of IDs; group by it and take `MIN(id)`/`MAX(id)` for each range.

**Q: How do you find missing IDs in the range 1..max?**
A: Generate the full domain (`generate_series(1, max)` in PostgreSQL, a recursive CTE in MySQL 8), `LEFT JOIN` the table, and keep rows where the join is `NULL`. For very large domains with sparse data, prefer the `LAG`-gap approach that scans only existing rows.

**Q: "Consecutive" should tolerate a single missing day. How do you handle that?**
A: Switch to the `LAG` + running-`SUM` form and start a new island only when the gap exceeds the tolerance (`log_date − prev_date > 2`), rather than requiring an exact `+1`. The rigid `date − ROW_NUMBER()` trick can't express tolerance directly.

**Q: How do you compute each user's longest streak?**
A: Build the islands, then `ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY days DESC, streak_start)` and keep rank 1, or `MAX(days)` per user if you only need the length.

**Q: Which index makes these queries avoid a sort, and why?**
A: A composite index on `(user_id, log_date)` supplies rows already partitioned and ordered, so the window functions and the final `GROUP BY` on the monotonic key stream without an explicit `Sort` — the plan is a single index scan.

**Q: How would you find runs of a status column, e.g. consecutive 'active' days?**
A: Filter to the status first then apply `date − ROW_NUMBER()`, or use the "difference of two row numbers" variant: `ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY log_date) − ROW_NUMBER() OVER (PARTITION BY user_id, status ORDER BY log_date)` is constant within a same-status run.

---

## 10. Cheat Sheet

> [!TIP]
> **Gaps & Islands**
> - Island key: `value − ROW_NUMBER() OVER (PARTITION BY g ORDER BY value)` is constant per contiguous run; `GROUP BY g, key` then `MIN/MAX/COUNT`.
> - Works for dates (`date − rn` days) and integer IDs (`id − rn`).
> - Use `ROW_NUMBER` (gapless, unique) — never `RANK`/`DENSE_RANK` for the key.
> - Gaps: `LAG(value)`, keep `value − prev > 1`, gap = `(prev+1 … value−1)`.
> - Missing IDs/dates: `generate_series` (or recursive CTE) `LEFT JOIN … WHERE t IS NULL`.
> - Tolerances / custom "consecutive": `LAG` boundary flag + running `SUM` group id.
> - De-dupe first; `PARTITION BY` the entity; index `(entity, order_col)` ⇒ no sort.

**References:** PostgreSQL docs — Window Functions & `generate_series`; Itzik Ben-Gan — "Gaps and Islands" articles; Use The Index, Luke; MySQL 8 Reference — Recursive CTEs.

---
*SQL Handbook — topic 36.*
