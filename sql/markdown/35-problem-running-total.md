# 35 · Problem: Running Totals & Moving Averages

> **In one line:** Compute a per-account cumulative balance and a 7-day moving average with `SUM()/AVG() OVER (ORDER BY … ROWS …)`, and see why the self-join alternative is O(n²).

---

## 1. Problem

Given a `transactions` table of dated amounts per account, produce for each row:

1. a **running total** (cumulative sum of `amount` per account, ordered by date), and
2. a **7-day moving average** of `amount` per account.

```sql
CREATE TABLE transactions (
    account_id  INT NOT NULL,
    txn_date    DATE NOT NULL,
    amount      NUMERIC(12,2) NOT NULL,
    PRIMARY KEY (account_id, txn_date)
);
```

**Sample input — `transactions`** (account 100):

| account_id | txn_date   | amount |
|------------|------------|--------|
| 100        | 2026-01-01 | 100.00 |
| 100        | 2026-01-02 | -40.00 |
| 100        | 2026-01-03 | 60.00  |
| 100        | 2026-01-04 | 20.00  |
| 100        | 2026-01-05 | 50.00  |

**Expected output** (running total = cumulative balance):

| account_id | txn_date   | amount | running_total |
|------------|------------|--------|---------------|
| 100        | 2026-01-01 | 100.00 | 100.00        |
| 100        | 2026-01-02 | -40.00 | 60.00         |
| 100        | 2026-01-03 | 60.00  | 120.00        |
| 100        | 2026-01-04 | 20.00  | 140.00        |
| 100        | 2026-01-05 | 50.00  | 190.00        |

Each `running_total` is the sum of all amounts for that account up to and including the current date.

---

## 2. Approach

The right tool is a **window aggregate with an explicit frame**:

- **`SUM(amount) OVER (PARTITION BY account_id ORDER BY txn_date ROWS UNBOUNDED PRECEDING)`** — for each row, sum every row from the start of the partition through the current row. That's the running total.
- **Moving average** — restrict the frame to a sliding window: `AVG(amount) OVER (… ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)` for a 7-row trailing average, or a `RANGE`-based interval for a true 7-*calendar-day* average.

The critical distinction is **`ROWS` vs `RANGE`**:

- **`ROWS`** counts physical rows (6 preceding + current = 7 rows) — correct when there is exactly one row per day and no gaps.
- **`RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW`** frames by the *value* of `txn_date`, giving a true calendar-week window even with gaps or multiple rows per day. Prefer `RANGE` for "last 7 days".

A single ordered scan computes both — no self-join, no correlated subquery.

---

## 3. Solution

```sql
SELECT
    account_id,
    txn_date,
    amount,
    -- cumulative balance: start-of-partition through current row
    SUM(amount) OVER (
        PARTITION BY account_id
        ORDER BY txn_date
        ROWS UNBOUNDED PRECEDING
    ) AS running_total,
    -- 7-calendar-day trailing average (gap-safe)
    AVG(amount) OVER (
        PARTITION BY account_id
        ORDER BY txn_date
        RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW
    ) AS avg_7d
FROM transactions
ORDER BY account_id, txn_date;
```

`ROWS UNBOUNDED PRECEDING` is shorthand for `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. The `RANGE … INTERVAL` frame is standard SQL and supported by PostgreSQL; MySQL 8 supports `ROWS`/`RANGE` but not `INTERVAL` range bounds, so use the row-count form there (next section).

---

## 4. Walkthrough

Walking account 100 row by row, the frame `ROWS UNBOUNDED PRECEDING` accumulates:

- `2026-01-01`: frame = {100} → **100.00**
- `2026-01-02`: frame = {100, −40} → **60.00**
- `2026-01-03`: frame = {100, −40, 60} → **120.00**
- `2026-01-04`: adds 20 → **140.00**
- `2026-01-05`: adds 50 → **190.00**

`PARTITION BY account_id` resets the running total at each new account, so account 200's cumulative sum starts fresh. The 7-day average at `2026-01-05` averages the last five present rows (all within 6 days): `(100−40+60+20+50)/5 = 38.00`.

```svg
<svg viewBox="0 0 640 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="20" y="22" fill="#1e293b" font-weight="bold">Window frames over ordered rows (account 100)</text>
  <!-- row boxes -->
  <g>
    <rect x="30"  y="45" width="110" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="85"  y="67" text-anchor="middle" fill="#1e293b">01-01  100</text>
    <rect x="150" y="45" width="110" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="205" y="67" text-anchor="middle" fill="#1e293b">01-02  -40</text>
    <rect x="270" y="45" width="110" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="325" y="67" text-anchor="middle" fill="#1e293b">01-03   60</text>
    <rect x="390" y="45" width="110" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="445" y="67" text-anchor="middle" fill="#1e293b">01-04   20</text>
    <rect x="510" y="45" width="110" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/><text x="565" y="67" text-anchor="middle" fill="#1e293b">01-05   50</text>
  </g>
  <!-- UNBOUNDED PRECEDING frame for current row 01-05 -->
  <rect x="24" y="95" width="602" height="40" rx="8" fill="none" stroke="#059669" stroke-dasharray="5 3"/>
  <text x="325" y="120" text-anchor="middle" fill="#059669">ROWS UNBOUNDED PRECEDING → running_total = 190</text>
  <!-- 3-row moving window illustration -->
  <rect x="264" y="150" width="362" height="40" rx="8" fill="none" stroke="#d97706" stroke-dasharray="5 3"/>
  <text x="445" y="175" text-anchor="middle" fill="#d97706">ROWS BETWEEN 2 PRECEDING AND CURRENT ROW → sliding frame</text>
  <text x="325" y="220" text-anchor="middle" fill="#64748b" font-size="12">running total = expanding frame; moving avg = fixed-width sliding frame</text>
</svg>
```

---

## 5. Variations & Follow-ups

**7-row moving average (MySQL-friendly, one row per day):**

```sql
AVG(amount) OVER (PARTITION BY account_id ORDER BY txn_date
                  ROWS BETWEEN 6 PRECEDING AND CURRENT ROW) AS avg_7row
```

**Centered moving average:** `ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING`.

**Running count / running max:** swap the aggregate — `COUNT(*)`, `MAX(amount)`, `MIN(balance)` over the same frame.

**Reset the cumulative sum monthly:** add the period to the partition, `PARTITION BY account_id, date_trunc('month', txn_date)`.

**Percent of running total:** divide `amount` by `SUM(amount) OVER (PARTITION BY account_id)` (whole-partition frame, no `ORDER BY`).

**Gap-aware average requiring N observations:** wrap with `CASE WHEN COUNT(*) OVER (same frame) >= 7 THEN AVG(...) END` to null out incomplete windows.

---

## 6. Alternative Solutions

**Self-join** running total (pre-window-function classic):

```sql
SELECT t1.account_id, t1.txn_date, t1.amount,
       SUM(t2.amount) AS running_total
FROM transactions t1
JOIN transactions t2
  ON t2.account_id = t1.account_id
 AND t2.txn_date  <= t1.txn_date
GROUP BY t1.account_id, t1.txn_date, t1.amount
ORDER BY t1.account_id, t1.txn_date;
```

For each row it re-joins every earlier row and re-sums — the join produces ~n²/2 intermediate rows per account. A **correlated subquery** (`SELECT SUM(amount) FROM transactions t2 WHERE t2.account_id = t1.account_id AND t2.txn_date <= t1.txn_date`) has the same O(n²) shape.

| Approach | Complexity | Reads data | Frame flexibility | Notes |
|----------|-----------|------------|-------------------|-------|
| `SUM() OVER (ORDER BY … ROWS …)` | O(n log n) (sort) then O(n) | Once | Any frame: expanding, sliding, centered, RANGE by interval | Default; PG, MySQL 8+, SQLite 3.25+, SQL Server |
| Self-join + `GROUP BY` | **O(n²)** per partition | Re-reads earlier rows | Only cumulative; sliding is painful | Legacy; explodes at scale |
| Correlated subquery | **O(n²)** | Rescans per row | Cumulative / bounded via extra predicates | Legacy; readable but slow |

The window version reads each row **once** after an ordered pass; the self-join and correlated forms re-touch history for every row. At 1M rows the difference is seconds vs hours.

---

## 7. Performance & Indexes

Match the index to `PARTITION BY` + `ORDER BY`:

```sql
CREATE INDEX idx_txn_acct_date ON transactions (account_id, txn_date, amount);
```

- **Window plan**: with this index the engine reads rows already grouped by `account_id` and ordered by `txn_date`, so `WindowAgg` runs with **no explicit sort**; including `amount` makes it a **covering** index (index-only scan). Cost ≈ one index scan + streaming aggregation, O(n).
- Without a matching index the planner adds a `Sort` before `WindowAgg` — O(n log n), fine but pays the sort.
- **Self-join**: even with the index each `t1` row drives an index range scan over all earlier `t2` rows; total work is quadratic. `EXPLAIN` shows a `Nested Loop` whose inner side row count grows with position — the O(n²) tell.

`ROWS` frames let the engine maintain a running accumulator in O(1) per row. Some `RANGE`/`INTERVAL` frames with peers require a bit more bookkeeping but stay linear over the sorted stream.

```svg
<svg viewBox="0 0 640 160" width="100%" height="160" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="20" y="22" fill="#1e293b" font-weight="bold">Window (one pass) vs Self-join (quadratic)</text>
  <rect x="30" y="45" width="250" height="90" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="155" y="70" text-anchor="middle" fill="#059669" font-weight="bold">WindowAgg</text>
  <text x="155" y="94" text-anchor="middle" fill="#1e293b">Index Scan (acct, date)</text>
  <text x="155" y="116" text-anchor="middle" fill="#64748b" font-size="12">O(n) after sort — reads each row once</text>
  <rect x="330" y="45" width="280" height="90" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="470" y="70" text-anchor="middle" fill="#d97706" font-weight="bold">Nested Loop self-join</text>
  <text x="470" y="94" text-anchor="middle" fill="#1e293b">inner rescans all earlier rows</text>
  <text x="470" y="116" text-anchor="middle" fill="#b91c1c" font-size="12">O(n²) — grows with row position</text>
</svg>
```

---

## 8. Common Mistakes

1. ⚠️ **Omitting `ORDER BY` in the window.** Without it the frame is the whole partition, so `SUM` returns the grand total on every row, not a running total. **Fix:** always `ORDER BY` the sequencing column.
2. ⚠️ **Relying on the default frame.** `SUM(x) OVER (ORDER BY d)` defaults to `RANGE UNBOUNDED PRECEDING`, which sums **all peer rows sharing the same `d`** at once — surprising with duplicate dates. **Fix:** state `ROWS UNBOUNDED PRECEDING` for a true row-by-row running total.
3. ⚠️ **Using `ROWS 6 PRECEDING` for "last 7 days" when days can be missing.** Gaps make the window span more than 7 calendar days. **Fix:** `RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW`.
4. ⚠️ **Forgetting `PARTITION BY account_id`.** The running total bleeds across accounts. **Fix:** partition by the account.
5. ⚠️ **Averaging incomplete leading windows silently.** The first rows average fewer than 7 values. **Fix:** guard with `COUNT(*) OVER (…) >= 7` if a full window is required.
6. ⚠️ **Shipping the self-join to production.** It looks fine on 1k rows and dies at 1M. **Fix:** use the window aggregate.

---

## 9. Interview Follow-ups

**Q: What's the difference between `ROWS` and `RANGE` in a window frame?**
A: `ROWS` counts physical rows relative to the current row (e.g. 6 preceding = 6 rows back), while `RANGE` frames by the value of the `ORDER BY` expression, treating rows with equal values as peers and allowing interval bounds like `INTERVAL '6 days' PRECEDING`. Use `RANGE` for true calendar windows and when duplicate ordering keys should be grouped.

**Q: Why does `SUM(x) OVER (ORDER BY d)` sometimes not give a strict row-by-row running total?**
A: The default frame is `RANGE UNBOUNDED PRECEDING AND CURRENT ROW`; when several rows share the same `d`, they're peers and all get the same cumulative sum. Specify `ROWS UNBOUNDED PRECEDING` to accumulate strictly one row at a time.

**Q: How would you compute a true 7-calendar-day trailing average when some days have no rows?**
A: Use `AVG(amount) OVER (PARTITION BY account_id ORDER BY txn_date RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW)`, which frames by date value so gaps don't distort the window; `ROWS 6 PRECEDING` would wrongly reach back more than a week.

**Q: Why is the self-join running total O(n²) and the window version not?**
A: The self-join matches each row to every earlier row and re-sums, producing ~n²/2 intermediate rows per partition; the window version sorts once and streams a single accumulator across the ordered rows, touching each row once — O(n log n) including the sort.

**Q: Which index makes the window plan avoid a sort?**
A: A composite index on `(account_id, txn_date)` — matching `PARTITION BY` then `ORDER BY` — lets the engine read rows in frame order, so `WindowAgg` runs without a `Sort`; adding `amount` makes it covering for an index-only scan.

**Q: MySQL 8 doesn't accept `RANGE … INTERVAL`. How do you get a 7-day average there?**
A: If there's exactly one row per day, use `ROWS BETWEEN 6 PRECEDING AND CURRENT ROW`; otherwise pre-aggregate to one row per account-day (`GROUP BY account_id, txn_date`) and then apply the row-count frame, or join against a generated calendar to fill gaps.

**Q: How do you reset the running total each month?**
A: Add the period to the partition key: `PARTITION BY account_id, date_trunc('month', txn_date) ORDER BY txn_date ROWS UNBOUNDED PRECEDING`, so the accumulator restarts at each month boundary.

**Q: How do you express each transaction as a percentage of the account's total?**
A: Divide by a whole-partition sum with no `ORDER BY`: `amount / SUM(amount) OVER (PARTITION BY account_id)`. Omitting `ORDER BY` makes the frame the entire partition, giving the grand total as the denominator.

**Q: A centered moving average is requested. What frame do you use?**
A: `AVG(amount) OVER (PARTITION BY account_id ORDER BY txn_date ROWS BETWEEN 3 PRECEDING AND 3 FOLLOWING)` for a 7-row window centered on the current row; endpoints will average fewer rows unless you require a full window.

**Q: Can you compute the running total without a window function or a self-join?**
A: Yes — in PostgreSQL a recursive CTE walking rows in date order carrying the accumulator works, but it's clumsier and usually slower than the window function; the window aggregate is the idiomatic, fastest choice on modern engines.

---

## 10. Cheat Sheet

> [!TIP]
> **Running totals & moving averages**
> - Running total: `SUM(x) OVER (PARTITION BY g ORDER BY t ROWS UNBOUNDED PRECEDING)`.
> - Sliding N-row avg: `AVG(x) OVER (… ROWS BETWEEN N-1 PRECEDING AND CURRENT ROW)`.
> - True N-day avg: `… RANGE BETWEEN INTERVAL 'N-1 days' PRECEDING AND CURRENT ROW`.
> - `ROWS` = physical rows; `RANGE` = value-based peers/intervals. Default frame is `RANGE` — state `ROWS` for strict row-by-row.
> - Always `ORDER BY` (else you get the grand total) and `PARTITION BY` the group.
> - Index `(group, order_col[, measure])` ⇒ no sort, covering scan.
> - Self-join / correlated running total = **O(n²)** — avoid at scale.

**References:** PostgreSQL docs — Window Function Calls & Frame Clauses; MySQL 8 Reference — Window Function Frame Specification; SQL Performance Explained — Window Functions; Use The Index, Luke.

---
*SQL Handbook — topic 35.*
