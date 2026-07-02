# 03 · Sorting & Pagination

> **In one line:** `OFFSET` pagination reads and throws away everything before your page — keyset pagination seeks straight to it and stays fast on page one million.

---

## 1. Overview

Users see data one page at a time, so almost every list endpoint sorts and paginates. The naive tool is `ORDER BY ... LIMIT n OFFSET m`: order the whole result, skip `m` rows, return the next `n`. It is correct and trivial to write.

It is also a **performance time bomb**. `OFFSET m` forces the engine to generate and discard `m` rows before it can return anything, so page 10,000 costs ~10,000× more than page 1. Deep pagination over `OFFSET` is one of the most common causes of a query that "was fast in dev, dies in prod".

The senior answer is **keyset (a.k.a. seek) pagination**: instead of "skip 200,000 rows", say "give me the rows *after* the last one I saw". With the right index this seeks directly to your position and reads exactly `n` rows — regardless of how deep you are. This page also covers multi-key ordering and NULL placement (`NULLS FIRST/LAST`), which matter because pagination requires a *deterministic total order*.

## 2. Core Concepts

- **Deterministic total order** — pagination is only correct if the `ORDER BY` uniquely orders rows; always append a unique tiebreaker (e.g. `id`).
- **Multi-key ordering** — `ORDER BY a, b DESC` sorts by `a`, then breaks ties by `b` descending; direction is per-column.
- **`NULLS FIRST` / `NULLS LAST`** — controls where NULLs land; PostgreSQL defaults NULLs *last* for ASC, MySQL treats NULLs as smallest (first for ASC).
- **`LIMIT` / `OFFSET`** — cap and skip; `OFFSET` cost is proportional to the number skipped.
- **Keyset / seek pagination** — page by `WHERE (sort_key) > (last_seen)` instead of `OFFSET`, giving O(log n + page) cost.
- **Index-ordered read** — a B-tree matching the `ORDER BY` lets the engine return sorted rows with no `Sort` node.
- **Stable page boundaries** — keyset is immune to rows being inserted/deleted mid-scroll; `OFFSET` can skip or repeat rows when the data shifts.
- **Composite key comparison** — row-value comparison `(a, b) > (a0, b0)` expresses "after this position" across multiple columns.

## 3. Syntax & Examples

```sql
-- Multi-key sort with an explicit NULL placement and a unique tiebreaker
SELECT id, title, published_at
FROM articles
ORDER BY published_at DESC NULLS LAST, id DESC;

-- OFFSET pagination (simple, but slow when deep)
SELECT id, title, published_at
FROM articles
ORDER BY published_at DESC, id DESC
LIMIT 20 OFFSET 200;                 -- page 11 of 20/page

-- Keyset pagination: pass the LAST row of the previous page
-- previous page ended at (published_at = '2026-05-01', id = 8042)
SELECT id, title, published_at
FROM articles
WHERE (published_at, id) < ('2026-05-01', 8042)   -- row-value comparison
ORDER BY published_at DESC, id DESC
LIMIT 20;

-- Same idea, spelled out for engines without row-value comparison (e.g. some MySQL versions)
SELECT id, title, published_at
FROM articles
WHERE published_at < '2026-05-01'
   OR (published_at = '2026-05-01' AND id < 8042)
ORDER BY published_at DESC, id DESC
LIMIT 20;
```

The index that makes keyset fast:

```sql
CREATE INDEX idx_articles_feed ON articles (published_at DESC, id DESC);
```

## 4. Sample Data & Results

Table `articles`:

| id | title      | published_at |
|----|------------|--------------|
| 12 | Indexes    | 2026-05-03   |
| 11 | Joins      | 2026-05-03   |
| 9  | Windows    | 2026-05-01   |
| 8  | Isolation  | 2026-04-28   |
| 5  | Vacuum     | NULL         |

Query — first page (2 rows), newest first, NULLs last, `id` tiebreaker:

```sql
SELECT id, title, published_at
FROM articles
ORDER BY published_at DESC NULLS LAST, id DESC
LIMIT 2;
```

Result (page 1):

| id | title   | published_at |
|----|---------|--------------|
| 12 | Indexes | 2026-05-03   |
| 11 | Joins   | 2026-05-03   |

Next page via keyset — last seen was `(2026-05-03, 11)`:

```sql
SELECT id, title, published_at
FROM articles
WHERE (published_at, id) < ('2026-05-03', 11)
ORDER BY published_at DESC, id DESC
LIMIT 2;
```

Result (page 2):

| id | title   | published_at |
|----|---------|--------------|
| 9  | Windows | 2026-05-01   |
| 8  | Isolation | 2026-04-28 |

No rows were skipped-and-discarded; the index seeks straight to the boundary `(2026-05-03, 11)`.

## 5. Under the Hood

With an index matching the `ORDER BY`, both approaches read rows in index order. The difference is the *starting point*. `OFFSET m` still begins at the top and counts off `m` rows before emitting anything; keyset seeks the B-tree directly to the boundary key.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah3" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <text x="180" y="24" text-anchor="middle" fill="#d97706">OFFSET 200 LIMIT 20</text>
  <text x="540" y="24" text-anchor="middle" fill="#059669">Keyset: WHERE key &lt; last_seen LIMIT 20</text>

  <!-- OFFSET side: long scan then discard -->
  <rect x="40" y="44" width="280" height="30" rx="8" fill="#fdecea" stroke="#b91c1c"/>
  <text x="180" y="63" text-anchor="middle" fill="#b91c1c">read + DISCARD rows 1..200</text>
  <rect x="40" y="80" width="280" height="30" rx="8" fill="#fdecea" stroke="#b91c1c"/>
  <text x="180" y="99" text-anchor="middle" fill="#b91c1c">... still discarding ...</text>
  <rect x="40" y="116" width="280" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="180" y="135" text-anchor="middle" fill="#1e293b">finally: return rows 201..220</text>
  <text x="180" y="176" text-anchor="middle" fill="#64748b">cost grows with OFFSET (page depth)</text>

  <!-- Keyset side: seek then read -->
  <rect x="400" y="44" width="280" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="540" y="63" text-anchor="middle" fill="#1e293b">B-tree SEEK to (last_key)</text>
  <line x1="540" y1="74" x2="540" y2="112" stroke="#475569" marker-end="url(#ah3)"/>
  <rect x="400" y="116" width="280" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="540" y="135" text-anchor="middle" fill="#1e293b">read next 20 in index order</text>
  <text x="540" y="176" text-anchor="middle" fill="#64748b">cost = O(log n) seek + 20 rows, constant per page</text>

  <!-- B-tree sketch -->
  <text x="360" y="216" text-anchor="middle" fill="#64748b">the index both share (sorted by the ORDER BY key)</text>
  <rect x="320" y="228" width="80" height="26" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="246" text-anchor="middle" fill="#1e293b">root</text>
  <rect x="220" y="278" width="80" height="26" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="260" y="296" text-anchor="middle" fill="#1e293b">leaf</text>
  <rect x="320" y="278" width="80" height="26" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="296" text-anchor="middle" fill="#1e293b">leaf</text>
  <rect x="420" y="278" width="80" height="26" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="460" y="296" text-anchor="middle" fill="#1e293b">leaf</text>
  <line x1="360" y1="254" x2="260" y2="276" stroke="#475569" marker-end="url(#ah3)"/>
  <line x1="360" y1="254" x2="360" y2="276" stroke="#475569" marker-end="url(#ah3)"/>
  <line x1="360" y1="254" x2="460" y2="276" stroke="#475569" marker-end="url(#ah3)"/>
  <text x="360" y="326" text-anchor="middle" fill="#059669">keyset descends to the exact leaf; OFFSET walks leaves from the start</text>
</svg>
```

Keyset also gives **stable boundaries**: if rows are inserted or deleted while a user scrolls, `OFFSET` shifts every subsequent row's position (causing skipped or duplicated items), whereas keyset anchors on an actual value the user already saw.

## 6. Variations & Trade-offs

| Approach | Page cost | Random access (jump to page 500)? | Stable under inserts/deletes? | Notes |
|----------|-----------|-----------------------------------|-------------------------------|-------|
| `LIMIT/OFFSET` | O(offset + n) | Yes (by page number) | No — rows shift | Simple; fine for shallow pages/admin tables |
| Keyset / seek | O(log n + n) | No (only next/prev) | Yes | Best for infinite scroll & deep feeds |
| Cached total + keyset | O(log n + n) | Approximate | Yes | Show counts without paying deep OFFSET |

**Dialect notes:** `NULLS FIRST/LAST` is standard in **PostgreSQL** and **Oracle**. **MySQL** lacks the syntax — NULLs sort as the lowest value (first for ASC); emulate with `ORDER BY col IS NULL, col`. Row-value comparison `(a,b) < (x,y)` works in PostgreSQL and modern MySQL; otherwise expand it to the OR form shown in §3.

## 7. Performance Notes

- The winning index **matches the `ORDER BY` columns and directions**, e.g. `(published_at DESC, id DESC)`. Then the engine reads pre-sorted rows — no `Sort` node, and keyset can seek.
- For keyset, the `WHERE (a,b) < (a0,b0)` boundary must use the **same column order** as the index or the seek degrades to a scan+filter.
- `OFFSET` cannot be indexed away — there is no "skip 200k rows" index operation; the rows must be produced and discarded. `EXPLAIN ANALYZE` shows rising `actual rows` and time as the offset grows.
- Mixed directions (`a ASC, b DESC`) need an index with matching mixed directions to stay sort-free; otherwise the engine adds a `Sort`.
- Counting total rows for a paginator (`COUNT(*)`) can itself be expensive on big tables — cache it or show an approximate count (`reltuples` in PostgreSQL).

## 8. Common Mistakes

1. ⚠️ **`ORDER BY` without a unique tiebreaker.** Rows with equal keys reorder between pages, causing dupes/gaps. Fix: append `, id`.
2. ⚠️ **Deep `OFFSET` in production feeds.** O(offset) blowup. Fix: switch to keyset pagination.
3. ⚠️ **Keyset boundary column order not matching the index/ORDER BY.** Loses the seek. Fix: keep `(a,b)` order identical everywhere.
4. ⚠️ **Ignoring NULL placement.** NULLs cluster unexpectedly and break the boundary comparison. Fix: pin with `NULLS LAST` (or `col IS NULL, col` in MySQL) and keep it consistent in the keyset predicate.
5. ⚠️ **Assuming `OFFSET` pages are stable.** Inserts/deletes shift positions. Fix: keyset anchors on real values.
6. ⚠️ **Expecting keyset to jump to an arbitrary page.** It only does next/prev. Fix: use OFFSET for random access, keyset for sequential scroll.
7. ⚠️ **`COUNT(*)` on every page load.** Expensive at scale. Fix: cache or approximate the total.

## 9. Interview Questions

**Q: Why is `LIMIT n OFFSET m` slow for large m?**
A: The engine must generate and discard all m preceding rows before returning the page, so cost is O(m + n) — page depth directly drives runtime and I/O.

**Q: What is keyset (seek) pagination?**
A: Instead of skipping rows, you filter `WHERE sort_key < last_seen_key` (using the previous page's last row) and `LIMIT n`. With a matching index the engine seeks directly to that position, giving near-constant per-page cost.

**Q: Why must a paginated ORDER BY include a unique tiebreaker?**
A: If the sort keys aren't unique, tied rows can order differently between requests, so pages overlap or skip rows. A unique key like id guarantees a total, stable order.

**Q: What does `NULLS LAST` do, and how does MySQL handle it?**
A: It forces NULLs to sort after non-NULL values. MySQL lacks the syntax and sorts NULLs as the smallest value; emulate with `ORDER BY col IS NULL, col`.

**Q: How does keyset handle multi-column sorts?**
A: Use a row-value comparison, e.g. `WHERE (published_at, id) < ('2026-05-01', 8042)`, or the expanded OR form; the columns must match the ORDER BY and the index.

**Q: Which index makes keyset pagination fast?**
A: One matching the ORDER BY columns and directions, e.g. `(published_at DESC, id DESC)`, so rows come out pre-sorted and the boundary predicate becomes a single seek.

**Q: Can you jump to an arbitrary page with keyset?**
A: No — keyset only supports next/previous from a known boundary. For true random page access you need OFFSET (accepting its cost) or precomputed boundaries.

**Q: Why is keyset more stable than OFFSET when data changes?**
A: OFFSET is positional, so an insert/delete before your position shifts every later row, causing skipped or duplicated results. Keyset anchors on an actual value the user already saw, so concurrent changes don't misalign pages.

**Q: In EXPLAIN ANALYZE, how do you spot an OFFSET problem?**
A: The plan reads far more rows than it returns — actual rows and time climb with the offset — and you'll often see a Sort or a full index scan feeding rows that are then discarded before LIMIT.

**Q: A query sorts `a ASC, b DESC`. What index avoids a Sort node?**
A: A composite index with matching mixed directions, `(a ASC, b DESC)`. A plain `(a, b)` index doesn't provide the required order for b, so the planner adds a Sort.

**Q: How do you show a total page count without paying for deep OFFSET?**
A: Cache the total, use an approximate count (e.g. PostgreSQL `reltuples`), or maintain a counter — decoupling the expensive COUNT(*) from the keyset-driven page fetch.

## 10. Practice

- [ ] Convert an `ORDER BY created_at DESC LIMIT 20 OFFSET 100000` query to keyset pagination.
- [ ] Create the composite index that makes your keyset query seek instead of scan; confirm with `EXPLAIN`.
- [ ] Write the multi-column keyset predicate using both the row-value form and the expanded OR form.
- [ ] Demonstrate an OFFSET page skipping a row after an insert, and show keyset avoiding it.
- [ ] Emulate `NULLS LAST` on MySQL for an ascending sort.

## 11. Cheat Sheet

> [!TIP]
> **OFFSET = read-and-discard** → cost grows with page depth. **Keyset** (`WHERE (a,id) < (a0,id0) ORDER BY a DESC, id DESC LIMIT n`) seeks to the boundary → constant per page + stable under writes.
> Always end `ORDER BY` with a **unique tiebreaker**. Build an index that **matches the sort columns and directions**. Pin NULLs with `NULLS LAST` (MySQL: `col IS NULL, col`). Keyset does next/prev only — use OFFSET when you truly need random page jumps.

**References:** Use The Index, Luke — "Paging Through Results" & "We need tool support"; PostgreSQL docs — SELECT (ORDER BY, LIMIT); Markus Winand — "No Offset"; MySQL — ORDER BY Optimization

---

*SQL Handbook — topic 03.*
