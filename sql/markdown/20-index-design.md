# 20 · Index Design & Sargability

> **In one line:** A good index isn't just "on the column in the WHERE" — it's the right columns, in the right order, matched by a *sargable* predicate the planner will actually use.

---

## 1. Overview

Having covered *what* indexes are in **Indexes: B-Tree, Composite & Covering**, this page is about *design*: given a workload, which indexes do you build, in what column order, and how do you write queries so the planner uses them?

The two ideas that decide everything are **sargability** and **column order**. *Sargable* — from "Search ARGument-able" — means a predicate that can be resolved by seeking into a B-tree rather than by testing every row. `WHERE created_at >= '2026-01-01'` is sargable; `WHERE YEAR(created_at) = 2026` is not, because wrapping the column in a function destroys the sort order the index relies on. Half of real-world "the index isn't being used" bugs are non-sargable predicates.

The other half are design errors: the wrong column order (so no useful prefix exists), too many overlapping indexes (write tax with no read benefit), or an index the planner rationally rejects because it isn't selective enough. Good index design is a small number of carefully-ordered indexes that match how your queries actually filter and sort. This page gives you the rules and the EXPLAIN intuition to verify them.

## 2. Core Concepts

- **Sargable predicate**: one the engine can satisfy by an index seek — the indexed column appears **bare** on one side, compared with `=`, `<`, `>`, `BETWEEN`, `IN`, or `LIKE 'prefix%'`.
- **Non-sargable predicate**: the column is wrapped in a function/expression, implicitly cast, or matched with a leading wildcard — forcing a scan-and-filter.
- **Column-order rule**: build composite indexes **equality columns → range column → sort column** (the "E-R-S" order).
- **Selectivity**: fraction of rows a predicate keeps; low fraction (few rows) = highly selective = index-worthy.
- **Cardinality**: number of distinct values in a column; feeds the planner's selectivity estimate via statistics/histograms.
- **Index for ORDER BY**: an index whose order matches the query's `ORDER BY` (including `ASC`/`DESC` direction) lets the engine skip the sort entirely.
- **Covering the projection**: add `INCLUDE`/trailing columns so the hot query is an index-only scan.
- **Over-indexing**: redundant/overlapping indexes that duplicate a prefix and only add write cost.
- **Planner cost model**: the optimizer picks the plan with the lowest estimated cost from **statistics** — stale stats cause bad choices.
- **When the planner ignores an index**: non-selective predicate, non-sargable filter, tiny table, or stale/missing statistics.

## 3. Syntax & Examples

```sql
-- E-R-S column order: equality (customer_id) → range (created_at) → sort satisfied too
CREATE INDEX idx_orders_cust_date
  ON orders (customer_id, created_at DESC);

-- Sargable: bare column, index seek + range walk
SELECT * FROM orders
WHERE customer_id = 42
  AND created_at >= '2026-01-01'
ORDER BY created_at DESC;               -- ORDER BY served by the index, no Sort node

-- ❌ Non-sargable: function on the column -> Seq Scan
SELECT * FROM orders WHERE date_trunc('month', created_at) = '2026-01-01';
-- ✅ Rewrite as a sargable range
SELECT * FROM orders
WHERE created_at >= '2026-01-01' AND created_at < '2026-02-01';

-- ❌ Non-sargable: implicit cast (col is BIGINT, literal is text)
SELECT * FROM orders WHERE customer_id = '42';   -- may cast the column
-- ✅ Match the type
SELECT * FROM orders WHERE customer_id = 42;

-- ❌ Leading wildcard can't use a B-tree
SELECT * FROM users WHERE email LIKE '%@gmail.com';
-- ✅ Trailing wildcard is sargable
SELECT * FROM users WHERE email LIKE 'anuj%';

-- Read the plan
EXPLAIN (ANALYZE, BUFFERS)
SELECT id FROM orders WHERE customer_id = 42 ORDER BY created_at DESC LIMIT 10;
```

## 4. Sample Data & Results

Table `orders` (cardinality: 100k rows, ~2k distinct `customer_id`, 3 distinct `status`):

| id | customer_id | status | created_at | total |
|----|-------------|--------|------------|-------|
| 1  | 42          | PAID   | 2026-01-03 | 120   |
| 2  | 42          | OPEN   | 2026-02-11 | 40    |
| 3  | 7           | PAID   | 2026-02-15 | 250   |
| 4  | 42          | PAID   | 2026-03-01 | 90    |
| 5  | 99          | CANCEL | 2026-03-02 | 15    |
| 6  | 42          | PAID   | 2026-03-20 | 300   |

Two predicates, very different selectivity:

```sql
-- Highly selective (~50 of 100k rows) -> index seek wins
SELECT * FROM orders WHERE customer_id = 42;
-- Not selective (~40% of rows are PAID) -> planner prefers Seq Scan
SELECT * FROM orders WHERE status = 'PAID';
```

Result of the selective query (via `idx_orders_cust_date`):

| id | status | created_at | total |
|----|--------|------------|-------|
| 1  | PAID   | 2026-01-03 | 120   |
| 2  | OPEN   | 2026-02-11 | 40    |
| 4  | PAID   | 2026-03-01 | 90    |
| 6  | PAID   | 2026-03-20 | 300   |

The same index on `status` would be useless for `status='PAID'` — matching 40% of the table, a seq scan is genuinely cheaper than 40k random heap fetches. A **partial** index `WHERE status='CANCEL'` (a rare value) would, however, pay off.

## 5. Under the Hood

Column order determines what an index can do. Picture the composite `(customer_id, created_at)` as entries sorted first by customer, then by date within each customer. An equality on the first column locks onto a contiguous block; a range on the second column walks that block in order — and because it's already in order, the `ORDER BY` is free.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="20" text-anchor="middle" fill="#64748b">Index (customer_id, created_at): equality seeks the block, range walks it in sort order</text>

  <!-- ordered leaf entries -->
  <g font-size="12">
    <rect x="40"  y="90" width="90" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="85" y="110" text-anchor="middle" fill="#1e293b">7 · Feb-15</text>
    <rect x="135" y="90" width="90" height="30" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="180" y="110" text-anchor="middle" fill="#1e293b">42 · Jan-03</text>
    <rect x="230" y="90" width="90" height="30" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="275" y="110" text-anchor="middle" fill="#1e293b">42 · Feb-11</text>
    <rect x="325" y="90" width="90" height="30" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="370" y="110" text-anchor="middle" fill="#1e293b">42 · Mar-01</text>
    <rect x="420" y="90" width="90" height="30" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="2"/><text x="465" y="110" text-anchor="middle" fill="#1e293b">42 · Mar-20</text>
    <rect x="515" y="90" width="90" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="560" y="110" text-anchor="middle" fill="#1e293b">99 · Mar-02</text>
  </g>

  <!-- seek pointer -->
  <line x1="180" y1="55" x2="180" y2="88" stroke="#059669" stroke-width="2" marker-end="url(#ah3)"/>
  <text x="180" y="48" text-anchor="middle" fill="#059669">SEEK customer_id = 42</text>

  <!-- range walk bracket -->
  <line x1="135" y1="140" x2="510" y2="140" stroke="#059669" stroke-width="2" marker-end="url(#ah3)"/>
  <text x="322" y="160" text-anchor="middle" fill="#059669">→ walk created_at range, already in DESC/ASC order (no Sort)</text>

  <!-- contrast: wrong order -->
  <text x="360" y="205" text-anchor="middle" fill="#b91c1c">Wrong order (created_at, customer_id): customer_id=42 rows are scattered → no seek</text>
  <g font-size="12">
    <rect x="90"  y="225" width="90" height="30" rx="8" fill="#fff7ed" stroke="#d97706"/><text x="135" y="245" text-anchor="middle" fill="#1e293b">Jan-03 · 42</text>
    <rect x="185" y="225" width="90" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="230" y="245" text-anchor="middle" fill="#1e293b">Feb-11 · 42</text>
    <rect x="280" y="225" width="90" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="325" y="245" text-anchor="middle" fill="#1e293b">Feb-15 · 7</text>
    <rect x="375" y="225" width="90" height="30" rx="8" fill="#fff7ed" stroke="#d97706"/><text x="420" y="245" text-anchor="middle" fill="#1e293b">Mar-01 · 42</text>
    <rect x="470" y="225" width="90" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/><text x="515" y="245" text-anchor="middle" fill="#1e293b">Mar-02 · 99</text>
  </g>
  <text x="360" y="278" text-anchor="middle" fill="#64748b">customer 42 (orange) is interleaved everywhere — index can't isolate it</text>
</svg>
```

**Sargability, physically.** A B-tree can only seek because its entries are sorted by the *raw column value*. The moment you write `YEAR(created_at)`, `created_at + interval '1 day'`, or force a type cast on the column, the engine no longer has a sorted quantity to binary-search — it must compute the expression for every row, i.e. a filter over a full scan. An **expression index** on exactly that expression restores a sorted quantity and makes it sargable again.

**What the planner actually does.** The optimizer estimates each candidate plan's cost from **statistics** (row counts, distinct values, histograms gathered by `ANALYZE`/`ANALYZE TABLE`). It compares "index scan: seek + N random heap fetches" against "seq scan: read all pages sequentially." Sequential I/O is far cheaper per page, so when N is large the seq scan wins — which is why a non-selective predicate rationally *shouldn't* use the index.

## 6. Variations & Trade-offs

| Predicate | Sargable? | Why | Fix |
|-----------|-----------|-----|-----|
| `col = 42` | ✅ | bare column, equality | — |
| `col >= '2026-01-01'` | ✅ | bare column, range | — |
| `col LIKE 'abc%'` | ✅ | prefix anchored | — |
| `col LIKE '%abc'` | ❌ | leading wildcard | trigram/GIN index |
| `YEAR(col) = 2026` | ❌ | function on column | range rewrite or expression index |
| `col + 1 = 10` | ❌ | arithmetic on column | rewrite `col = 9` |
| `col = '42'` (col is int) | ❌/⚠️ | implicit cast on column | match literal type |
| `lower(col) = 'x'` | ❌ | function on column | expression index on `lower(col)` |
| `col IS NULL` | ✅* | *B-tree indexes NULLs (PG); MySQL too | partial index if common |

**Design trade-offs.** More indexes → faster, more varied reads but slower writes and more storage. A single well-ordered composite often replaces several single-column indexes (its prefixes are reusable). Covering a query removes heap fetches but widens the index. The judgment call is always: does a *measured* query justify the *ongoing* write cost?

## 7. Performance Notes

- **E-R-S ordering** is the master rule: **E**quality columns first (each collapses to a point in the seek), then one **R**ange column, then columns needed only for **S**orting. Only the first range column benefits from the tree; everything after a range is just a filter.
- **Match `ORDER BY` direction.** `ORDER BY created_at DESC` is served free by an index declared `(customer_id, created_at DESC)` — or by a plain ascending index scanned backwards. Mixed directions (`a ASC, b DESC`) need the index to declare those exact directions.
- **Selectivity gate.** As a rule of thumb, below ~5–10% of the table an index scan wins; above that, expect (and accept) a seq scan.
- **Keep statistics fresh.** After a bulk load, run `ANALYZE` (PG) / `ANALYZE TABLE` (MySQL). Stale stats are the top cause of "it suddenly stopped using the index." Raise the statistics target on skewed columns.
- **Detect redundancy.** An index `(a)` is fully covered by `(a, b)` for prefix queries — drop the shorter one unless it's needed for a smaller/unique constraint. Tools: `pg_stat_user_indexes`, MySQL `sys.schema_redundant_indexes`.
- **Before/after EXPLAIN intuition:**

```text
BEFORE (non-sargable):  WHERE YEAR(created_at) = 2026
  Seq Scan on orders  (cost=0.00..2180  rows=500)  actual rows=500
    Filter: (date_part('year', created_at) = 2026)
    Rows Removed by Filter: 99500          <-- read 100k, threw away 99.5k

AFTER (sargable range):  WHERE created_at >= '2026-01-01' AND created_at < '2027-01-01'
  Index Scan using idx_orders_created (cost=0.42..38  rows=500) actual rows=500
    Index Cond: (created_at >= '2026-01-01' AND created_at < '2027-01-01')
                                            <-- seeked directly, ~2 pages
```

The signature to hunt for is a large **`Rows Removed by Filter`** — it means the engine read rows the index should have excluded.

## 8. Common Mistakes

1. ⚠️ **Wrapping the indexed column in a function** (`YEAR(col)`, `lower(col)`, `col::text`). Fix: rewrite as a range, or build a matching expression index.
2. ⚠️ **Implicit type cast** from comparing an `int` column to a quoted literal (or `varchar` to a number). Fix: make the literal's type match the column exactly.
3. ⚠️ **Leading `%` in LIKE.** Fix: anchor the pattern, or use a trigram/GIN full-text index for substring search.
4. ⚠️ **Range column before equality column** in a composite (`(created_at, customer_id)`). Fix: equality first — `(customer_id, created_at)`.
5. ⚠️ **Indexing a low-cardinality column** (status, boolean) and expecting a seek. Fix: partial index on the rare value, or don't index it.
6. ⚠️ **`ORDER BY` direction mismatch** forcing a Sort node despite the index. Fix: declare the index column direction to match, or rely on backward scan.
7. ⚠️ **Over-indexing** — many overlapping indexes duplicating prefixes. Fix: consolidate into one composite; drop indexes with zero scans.
8. ⚠️ **Blaming the planner for "ignoring" the index** when the predicate matches 40% of rows. Fix: accept the seq scan, or make the query more selective / covering.

## 9. Interview Questions

**Q: What does "sargable" mean and where does the term come from?**
A: Search-ARGument-able: a predicate the engine can resolve by seeking into an index instead of testing every row. It requires the indexed column to appear bare, compared via `=`, range, `IN`, or an anchored `LIKE 'x%'`. Non-sargable predicates force a scan-and-filter.

**Q: Why does `WHERE YEAR(created_at) = 2026` not use an index on `created_at`?**
A: The B-tree is sorted by the raw `created_at` value, not by `YEAR(created_at)`. Applying the function destroys the ordering the seek relies on, so the engine must compute `YEAR()` for every row. Rewrite it as a sargable range `created_at >= '2026-01-01' AND created_at < '2027-01-01'`, or create an expression index.

**Q: Give the rule for ordering columns in a composite index.**
A: Equality → Range → Sort (E-R-S). Put all equality-predicate columns first (each collapses the search to a point), then the single range/inequality column, then any column needed only to satisfy `ORDER BY`. Columns after the first range only act as filters, not seeks.

**Q: How does an implicit type cast silently break index usage?**
A: If a `BIGINT` column is compared to a text literal (`customer_id = '42'`), some engines cast the *column* to text to match, wrapping it in a function and making it non-sargable. Matching the literal's type to the column (`= 42`) keeps it sargable.

**Q: What is selectivity, and how does it decide whether the planner uses an index?**
A: Selectivity is the fraction of rows a predicate keeps; high selectivity = few rows. The planner compares an index scan's cost (seek + random heap fetches per matched row) against a sequential scan. When the predicate matches a large fraction (say >5–10%), the seq scan's cheap sequential I/O wins, so the index is correctly skipped.

**Q: Can a single index satisfy both filtering and `ORDER BY`? How?**
A: Yes — if the index's leading columns match the equality/range filter and its trailing column order (and direction) matches the `ORDER BY`, the engine seeks the block and reads it already sorted, eliminating the Sort node. `(customer_id, created_at DESC)` serves `WHERE customer_id=? ORDER BY created_at DESC`.

**Q: You have indexes on `(a)`, `(a,b)`, and `(a,b,c)`. Which are redundant?**
A: `(a)` and `(a,b)` are redundant for query purposes — `(a,b,c)` already serves any prefix query on `a` or `a,b` via the leftmost-prefix rule. Keep the shorter ones only if they're smaller for a specific hot path, enforce uniqueness, or are covering with different `INCLUDE`s.

**Q: How does a leading wildcard `LIKE '%term%'` change your index choice?**
A: A B-tree can't seek on it (no anchored prefix), so you need a substring-capable index: a PostgreSQL trigram (`pg_trgm`) GIN/GiST index, or a full-text/inverted index, or a search engine for large-scale text.

**Q: Why keep statistics fresh, and what breaks when they're stale?**
A: The planner estimates row counts and selectivity from statistics (`ANALYZE`). After bulk loads or big data shifts, stale stats make it misjudge selectivity — choosing a seq scan when an index would win, or vice versa, or picking a bad join order. `ANALYZE`/`ANALYZE TABLE` refreshes them; raising the stats target helps skewed columns.

**Q: (Senior) EXPLAIN shows a huge `Rows Removed by Filter`. What does that tell you?**
A: The engine read far more rows than it returned and discarded them in a filter step — the predicate wasn't resolvable by the index (non-sargable, or no suitable index). It's the classic signature of a missing/mis-ordered index or a function/cast on the column. Fix the sargability or add the right index and the rows should move into `Index Cond`.

**Q: (Senior) When is adding an index the wrong fix even though a query is slow?**
A: When the predicate is inherently non-selective (returns a big fraction of the table), when the table is small enough to live in memory, when the workload is write-heavy and the index tax outweighs the read gain, or when the real problem is a non-sargable query that should be rewritten. Index only after confirming selectivity and read/write balance.

**Q: (Senior) How would you design indexes for a query filtering on `customer_id`, ranging on `created_at`, and paginating `ORDER BY created_at DESC LIMIT 20`?**
A: One composite `(customer_id, created_at DESC)` — equality seeks the customer's block, the range trims dates, and the DESC ordering serves both the sort and the `LIMIT` (stop after 20 leaf entries). Add `INCLUDE (status, total)` if those are the only other projected columns, making it an index-only scan and keeping keyset pagination fast.

## 10. Practice

- [ ] Take a query using `date_trunc`/`YEAR()` on a column, capture its `Seq Scan` + `Rows Removed by Filter`, rewrite it as a sargable range, and show the plan flips to `Index Scan`.
- [ ] Build `(customer_id, created_at)` and its reverse `(created_at, customer_id)`; run a `customer_id=? ORDER BY created_at` query against each and compare plans.
- [ ] Compare an int-vs-quoted-literal predicate (`= '42'` vs `= 42`) and observe whether an implicit cast disables the index.
- [ ] Use `pg_stat_user_indexes` (or `sys.schema_unused_indexes`) to find a zero-scan index and a redundant prefix index, and write the `DROP` statements.
- [ ] Force stale stats (bulk insert without `ANALYZE`), watch a bad plan, then `ANALYZE` and watch it correct.

## 11. Cheat Sheet

> [!TIP]
> **Index design in a nutshell.** Order composite columns **Equality → Range → Sort (E-R-S)** — only the first range column seeks; the rest just filter. Keep predicates **sargable**: bare column, `=`/range/`IN`/`LIKE 'x%'`. Killers of sargability: **function on the column** (`YEAR()`, `lower()`), **arithmetic** (`col+1`), **implicit cast** (int vs `'42'`), **leading wildcard** (`'%x'`). Fix with a range rewrite, matched literal type, or **expression index**. **Selectivity** decides use: below ~5–10% of rows → index; above → the planner *rightly* seq-scans. Match `ORDER BY` direction to serve sorts free. Keep **statistics** fresh (`ANALYZE`). Hunt `Rows Removed by Filter` in EXPLAIN — it means the index isn't doing the work. Fewer, well-ordered indexes beat many overlapping ones.

**References:** Use The Index, Luke (Markus Winand) — "The Where Clause" & "Sorting/Grouping"; PostgreSQL docs — "Using EXPLAIN" & "Row Estimation Examples"; MySQL Reference Manual — "Optimizing Queries with EXPLAIN"; "SQL Performance Explained"

---
*SQL Handbook — topic 20.*
