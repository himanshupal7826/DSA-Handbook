# 19 · Indexes: B-Tree, Composite & Covering

> **In one line:** An index is a sorted side structure that turns O(n) table scans into O(log n) lookups — at the price of write amplification and storage.

---

## 1. Overview

An **index** is an auxiliary data structure that stores a copy of one or more columns, kept in sorted order, together with a pointer back to the full row. Without one, the engine must read every page of the table (a **sequential scan**) to answer `WHERE`, `JOIN`, or `ORDER BY`. With one, it can *navigate* directly to the rows it needs.

The overwhelming majority of database indexes are **B-tree** (technically B⁺-tree) indexes. A B-tree keeps keys sorted and balanced so that lookups, range scans, and ordered reads all cost roughly the height of the tree — 3–4 page reads for tables with hundreds of millions of rows.

Indexes are the single highest-leverage performance tool in SQL, but they are not free. Every index must be updated on every `INSERT`, `UPDATE` of an indexed column, and `DELETE`, and it consumes disk and memory. Index design is the art of adding exactly the indexes your read paths need — and no more. This page covers the physical structure; the sibling topic **Index Design & Sargability** covers how to choose them.

## 2. Core Concepts

- **B-tree**: a balanced, sorted tree. Leaf nodes hold keys in order and chain left↔right, giving O(log n) point lookups *and* efficient range/ordered scans.
- **Clustered index**: the table *is* the index — rows are physically stored in key order in the leaves. InnoDB stores every table as a clustered index on its **primary key**.
- **Secondary index**: a separate B-tree whose leaves store the index key plus a **row locator** (the PK in InnoDB, a physical `ctid`/heap TID in PostgreSQL).
- **Composite index**: an index on multiple columns `(a, b, c)`, sorted by `a`, then `b`, then `c` — like a phone book sorted by last name then first name.
- **Leftmost-prefix rule**: a composite `(a, b, c)` can serve predicates on `a`, `a,b`, or `a,b,c` — but **not** on `b` alone or `c` alone.
- **Covering index**: an index that contains *every* column a query touches, so the engine never visits the table → an **index-only scan**.
- **INCLUDE columns**: non-key payload columns bolted onto a B-tree leaf to make it covering without widening the sort key (PostgreSQL/SQL Server).
- **Selectivity / cardinality**: how many distinct values a column has; high-cardinality columns make the most useful indexes.
- **Write & space cost**: each index is a second structure to maintain — writes slow down and storage grows.
- **Specialized index types**: hash, GIN, GiST, BRIN, partial, and expression indexes cover cases B-trees handle poorly.

## 3. Syntax & Examples

```sql
-- Single-column secondary index
CREATE INDEX idx_orders_customer ON orders (customer_id);

-- Composite index: order matters — equality column first, then range/sort
CREATE INDEX idx_orders_cust_date ON orders (customer_id, created_at DESC);

-- Unique index (also enforces a constraint)
CREATE UNIQUE INDEX uq_users_email ON users (email);

-- Covering index via INCLUDE (PostgreSQL 11+, SQL Server):
-- key = (customer_id), payload = (status, total) rides along in the leaf
CREATE INDEX idx_orders_cover
  ON orders (customer_id) INCLUDE (status, total);

-- Partial index: only index the rows you actually query
CREATE INDEX idx_orders_open
  ON orders (created_at)
  WHERE status = 'OPEN';

-- Expression (functional) index: makes a non-sargable predicate sargable
CREATE INDEX idx_users_lower_email ON users (lower(email));
-- now: WHERE lower(email) = 'a@b.com'  can use it

-- Non-B-tree access methods (PostgreSQL)
CREATE INDEX idx_docs_gin  ON docs  USING gin (tags);        -- arrays/JSONB/FTS
CREATE INDEX idx_geo_gist  ON places USING gist (location);  -- geometry/ranges
CREATE INDEX idx_events_brin ON events USING brin (created_at); -- huge, append-only
```

## 4. Sample Data & Results

Table `orders`:

| id | customer_id | status | created_at | total |
|----|-------------|--------|------------|-------|
| 1  | 42          | PAID   | 2026-01-03 | 120   |
| 2  | 42          | OPEN   | 2026-02-11 | 40    |
| 3  | 7           | PAID   | 2026-02-15 | 250   |
| 4  | 42          | PAID   | 2026-03-01 | 90    |
| 5  | 99          | OPEN   | 2026-03-02 | 15    |
| 6  | 42          | PAID   | 2026-03-20 | 300   |

Query — most recent 3 orders for a customer:

```sql
SELECT id, created_at, total
FROM orders
WHERE customer_id = 42
ORDER BY created_at DESC
LIMIT 3;
```

Result (served by `idx_orders_cust_date` — the index already holds these rows sorted, so no separate sort step):

| id | created_at | total |
|----|------------|-------|
| 6  | 2026-03-20 | 300   |
| 4  | 2026-03-01 | 90    |
| 2  | 2026-02-11 | 40    |

The index seeks straight to `customer_id = 42`, then walks the leaf chain in `created_at DESC` order and stops after 3 rows — it never reads customers 7 or 99.

## 5. Under the Hood

A B-tree has one **root**, zero or more **internal** (branch) levels, and a **leaf** level. Internal nodes hold separator keys that route the search; leaves hold the actual index entries and are doubly linked so a range scan can walk sideways without returning to the root.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="20" text-anchor="middle" fill="#64748b">B-tree index: point lookup for key = 57 (root → branch → leaf)</text>

  <!-- root -->
  <rect x="300" y="36" width="120" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="58" text-anchor="middle" fill="#1e293b">[ 40 | 80 ]</text>

  <!-- branch level -->
  <rect x="70" y="130" width="120" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="130" y="152" text-anchor="middle" fill="#1e293b">[ 12 | 25 ]</text>
  <rect x="300" y="130" width="120" height="34" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="2"/>
  <text x="360" y="152" text-anchor="middle" fill="#1e293b">[ 50 | 65 ]</text>
  <rect x="530" y="130" width="120" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="590" y="152" text-anchor="middle" fill="#1e293b">[ 88 | 95 ]</text>

  <!-- leaf level -->
  <rect x="30"  y="236" width="96" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="78"  y="258" text-anchor="middle" fill="#1e293b">05 · 12 · 20</text>
  <rect x="150" y="236" width="96" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="198" y="258" text-anchor="middle" fill="#1e293b">25 · 33 · 40</text>
  <rect x="290" y="236" width="96" height="34" rx="8" fill="#ecfdf5" stroke="#059669" stroke-width="2"/>
  <text x="338" y="258" text-anchor="middle" fill="#1e293b">50 · 57 · 63</text>
  <rect x="410" y="236" width="96" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="458" y="258" text-anchor="middle" fill="#1e293b">65 · 72 · 80</text>
  <rect x="560" y="236" width="120" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="620" y="258" text-anchor="middle" fill="#1e293b">88 · 92 · 99</text>

  <!-- routing arrows (highlighted path in green) -->
  <line x1="345" y1="70" x2="360" y2="128" stroke="#059669" stroke-width="2" marker-end="url(#ah)"/>
  <line x1="330" y1="70" x2="130" y2="128" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="390" y1="70" x2="590" y2="128" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="360" y1="164" x2="338" y2="234" stroke="#059669" stroke-width="2" marker-end="url(#ah)"/>
  <line x1="345" y1="164" x2="198" y2="234" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="380" y1="164" x2="458" y2="234" stroke="#475569" marker-end="url(#ah)"/>

  <!-- leaf sibling links -->
  <line x1="126" y1="253" x2="150" y2="253" stroke="#64748b" stroke-dasharray="3 3"/>
  <line x1="246" y1="253" x2="290" y2="253" stroke="#64748b" stroke-dasharray="3 3"/>
  <line x1="386" y1="253" x2="410" y2="253" stroke="#64748b" stroke-dasharray="3 3"/>
  <line x1="506" y1="253" x2="560" y2="253" stroke="#64748b" stroke-dasharray="3 3"/>
  <text x="360" y="300" text-anchor="middle" fill="#64748b">Leaves are sorted &amp; doubly linked → range scans walk sideways; height ≈ 3–4 for 100M+ rows</text>
</svg>
```

The difference this makes is dramatic. A sequential scan reads every page; an index lookup reads one page per level plus the target leaf.

```svg
<svg viewBox="0 0 720 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="180" y="20" text-anchor="middle" fill="#b91c1c">Seq Scan — read ALL pages</text>
  <text x="540" y="20" text-anchor="middle" fill="#059669">Index Scan — descend then fetch</text>

  <!-- seq scan: grid of pages all touched -->
  <g>
    <rect x="40"  y="40" width="40" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <rect x="90"  y="40" width="40" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <rect x="140" y="40" width="40" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <rect x="190" y="40" width="40" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <rect x="40"  y="76" width="40" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <rect x="90"  y="76" width="40" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <rect x="140" y="76" width="40" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <rect x="190" y="76" width="40" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <rect x="40"  y="112" width="40" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <rect x="90"  y="112" width="40" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <rect x="140" y="112" width="40" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/>
    <rect x="190" y="112" width="40" height="26" rx="6" fill="#fff7ed" stroke="#d97706"/>
  </g>
  <text x="135" y="170" text-anchor="middle" fill="#64748b">12 pages read → O(n)</text>

  <!-- index scan: 3-level descent + 1 heap fetch -->
  <rect x="460" y="40" width="150" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="535" y="58" text-anchor="middle" fill="#1e293b">root page</text>
  <rect x="460" y="82" width="150" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="535" y="100" text-anchor="middle" fill="#1e293b">branch page</text>
  <rect x="460" y="124" width="150" height="26" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="535" y="142" text-anchor="middle" fill="#1e293b">leaf page</text>
  <rect x="460" y="166" width="150" height="26" rx="6" fill="#ecfdf5" stroke="#059669"/>
  <text x="535" y="184" text-anchor="middle" fill="#1e293b">heap row (fetch)</text>
  <line x1="535" y1="66" x2="535" y2="80" stroke="#475569" marker-end="url(#ah2)"/>
  <line x1="535" y1="108" x2="535" y2="122" stroke="#475569" marker-end="url(#ah2)"/>
  <line x1="535" y1="150" x2="535" y2="164" stroke="#475569" marker-end="url(#ah2)"/>
  <text x="535" y="212" text-anchor="middle" fill="#64748b">~4 pages read → O(log n)</text>
</svg>
```

**Clustered vs secondary in InnoDB.** InnoDB stores the whole row inside the PK B-tree leaves (the *clustered index*). A secondary index leaf stores `(index_key, primary_key)`. So a lookup via a secondary index that needs non-indexed columns performs a **double lookup**: find the PK in the secondary index, then descend the clustered index to fetch the row. This is why a fat PK (e.g. a UUID string) bloats *every* secondary index, and why covering secondary indexes are so valuable — they skip the second descent.

## 6. Variations & Trade-offs

| Index type | Structure | Best for | Weak at |
|------------|-----------|----------|---------|
| **B-tree** | balanced sorted tree | `=`, `<`,`>`, `BETWEEN`, `ORDER BY`, prefix `LIKE 'foo%'` | full-text, `%foo`, containment |
| **Hash** | hash table | pure equality `=` | ranges, sorting (no order) |
| **GIN** | inverted index | arrays, `JSONB`, full-text, `@>` containment | slow to update, large |
| **GiST** | balanced tree of predicates | geometry, ranges, nearest-neighbour | not exact-match optimal |
| **BRIN** | per-block min/max summaries | huge, naturally-ordered tables (time-series) | random/unclustered data |
| **Partial** | B-tree over a `WHERE` subset | skewed data (e.g. `status='OPEN'`) | queries outside the predicate |
| **Expression** | B-tree over `f(col)` | `lower(email)`, `(a+b)` predicates | must match the expression exactly |

**Clustered vs heap trade-off:** a clustered PK gives fast PK lookups and range scans but makes secondary indexes pay a double lookup; PostgreSQL's heap keeps all indexes symmetric (each stores a `ctid`) but has no natural clustering. Covering indexes and `INCLUDE` neutralize the double-lookup cost on hot paths.

## 7. Performance Notes

- **Index-only scan:** if the index (key + `INCLUDE`) contains every column the query references, the engine answers entirely from the index. In PostgreSQL this also requires the pages to be **visible** (`VACUUM` keeps the visibility map fresh); otherwise it still touches the heap.
- **Selectivity drives usefulness.** An index on a column where one value matches 60% of rows is worthless for that value — the planner (correctly) prefers a seq scan. High-cardinality columns (user_id, email, order_id) are the sweet spot.
- **Write amplification:** N indexes ≈ N extra B-tree maintenance operations per write. A table with 8 indexes can spend most of an `INSERT`'s time updating indexes, not the row.
- **Space:** each index is a full copy of its key columns plus overhead — often 10–40% of the table size each. Covering indexes with wide `INCLUDE` lists cost the most.
- **EXPLAIN intuition:** look for `Index Scan` / `Index Only Scan` (good) vs `Seq Scan` on a large table (suspicious). `Rows Removed by Filter` being large means the index isn't selective enough or the predicate isn't sargable.
- **Fillfactor & bloat:** frequently-updated indexes fragment; `REINDEX` (PG) or `OPTIMIZE TABLE` (MySQL) rebuilds them.

## 8. Common Mistakes

1. ⚠️ **Indexing every column "just in case."** Each index taxes every write. Fix: index for measured read paths, drop unused ones (`pg_stat_user_indexes.idx_scan = 0`).
2. ⚠️ **Wrong composite order.** `(created_at, customer_id)` cannot serve `WHERE customer_id = 42`. Fix: put the equality column first — `(customer_id, created_at)`.
3. ⚠️ **Expecting `(a,b)` to help a query on `b` alone.** The leftmost-prefix rule forbids it. Fix: add an index leading with `b`, or reorder.
4. ⚠️ **Function on the indexed column** (`WHERE lower(email)=…` with a plain index on `email`) disables it. Fix: create an expression index on `lower(email)`.
5. ⚠️ **Leading wildcard** `LIKE '%foo'` cannot use a B-tree. Fix: trigram/GIN index, or store a reversed column.
6. ⚠️ **Low-cardinality index** (boolean, status with 2 values) rarely beats a seq scan. Fix: use a *partial* index on the rare value.
7. ⚠️ **Fat clustered PK in InnoDB** (random UUID) bloats every secondary index and causes page splits. Fix: use a monotonic surrogate (`BIGINT AUTO_INCREMENT`) or UUIDv7.
8. ⚠️ **Forgetting `INCLUDE`/covering** on a hot read path, paying a heap fetch per row. Fix: add the projected columns to the index.

## 9. Interview Questions

**Q: What is a database index and what does it fundamentally trade?**
A: A sorted auxiliary structure (usually a B-tree) mapping key values to row locations, turning O(n) scans into O(log n) lookups. The trade is faster reads for slower writes (every index maintained per write) and extra storage.

**Q: Why B-trees instead of binary search trees or hash tables for general indexing?**
A: B-trees are shallow and high-fanout, so each node fills a disk page and a lookup costs only 3–4 page reads even for billions of rows. Unlike hash tables they keep keys sorted, so they also serve range scans and `ORDER BY`. Binary trees are too deep (too many random I/Os).

**Q: Explain the difference between a clustered and a secondary index.**
A: A clustered index stores the full rows in key order in its leaves — the table *is* the index (InnoDB on the PK). A secondary index is a separate tree whose leaves store the key plus a row locator (the PK in InnoDB, a `ctid` in PostgreSQL); it points *at* the row rather than containing it.

**Q: In InnoDB, what happens when a secondary-index query needs a non-indexed column?**
A: A double lookup: the secondary index yields the primary key, then the engine descends the clustered index by that PK to fetch the full row. This is why a wide PK inflates every secondary index and why covering indexes are valuable.

**Q: State the leftmost-prefix rule with an example.**
A: A composite index `(a, b, c)` can serve predicates on the leftmost contiguous prefix: `a`, `a+b`, or `a+b+c`. It cannot serve `b` alone, `c` alone, or `b+c`, because the index is sorted by `a` first. A query on `a` + range on `b` uses `a` for the seek and `b` for the range.

**Q: What is a covering index / index-only scan?**
A: An index that contains every column a query references (in its key or `INCLUDE` payload), so the engine answers entirely from the index without touching the table. The plan shows `Index Only Scan`. In PostgreSQL it also needs the visibility map to confirm the rows are all-visible.

**Q: What does `INCLUDE` do and why not just add the column to the key?**
A: `INCLUDE` stores non-key columns in the leaf as payload only. They ride along to make the index covering but don't widen the sort key or enforce ordering/uniqueness — keeping the tree narrower and the key comparisons cheaper than folding them into the key.

**Q: When will the planner deliberately ignore an existing index?**
A: When the predicate isn't selective (matches a large fraction of rows, so a seq scan is cheaper), when statistics are stale, when the predicate is non-sargable, on a small table where a scan fits in memory, or when a heap fetch per matched row would cost more than scanning.

**Q: Compare hash, GIN, and GiST indexes and when you'd pick each.**
A: Hash: pure equality only, no ordering. GIN: inverted index for multi-valued columns — arrays, `JSONB`, full-text, containment (`@>`). GiST: balanced tree of bounding predicates for geometry, ranges, and nearest-neighbour search. B-tree remains the default for scalar `=`/range/sort.

**Q: What is a partial index and when does it beat a full one?**
A: An index with a `WHERE` clause that only indexes a subset of rows, e.g. `WHERE status='OPEN'`. It's smaller, cheaper to maintain, and ideal for skewed data where you only query the rare subset — an open-orders queue among mostly-closed orders.

**Q: (Senior) How do you decide the column order in a composite index?**
A: Equality columns first (so the seek is a single point), then the range/inequality column, then the `ORDER BY` column so the index also satisfies the sort. Among equality columns, order by how the query filters, not blindly by selectivity — the goal is the longest usable prefix and eliminating a sort.

**Q: (Senior) You added an index but writes got slow and the read didn't improve. Diagnose.**
A: The index likely isn't sargable-matched (function/cast on the column, wrong prefix) so reads still seq-scan, while every write now maintains an extra tree. Check `EXPLAIN` for `Seq Scan` + `Rows Removed by Filter`, check `idx_scan` in index stats — if it's 0, the index is pure write tax and should be dropped or redefined (e.g. as an expression index).

**Q: (Senior) Why can a monotonically-increasing key be both good and bad for an index?**
A: Good: appends go to the rightmost leaf, minimizing page splits and keeping the clustered index compact. Bad: under heavy concurrent inserts that rightmost leaf becomes a hot contention point (latch/lock), and for BRIN the natural ordering is exactly what makes tiny block-summary indexes work.

## 10. Practice

- [ ] Create a `(customer_id, created_at DESC)` index and confirm via `EXPLAIN` that a "latest N orders per customer" query does an index scan with no separate sort.
- [ ] Add an `INCLUDE (status, total)` covering index and verify the plan flips to `Index Only Scan`.
- [ ] Build a partial index on `WHERE status='OPEN'` and compare its size (`pg_relation_size`) to the full index.
- [ ] Write a query with `WHERE lower(email)=…`, show it seq-scans, then add an expression index and show it now seeks.
- [ ] Inspect `pg_stat_user_indexes` (or MySQL `sys.schema_unused_indexes`) to find an index with zero scans and justify dropping it.

## 11. Cheat Sheet

> [!TIP]
> **Indexes in a nutshell.** B-tree = sorted, balanced, height 3–4 → O(log n) point + range + ORDER BY. InnoDB: table = clustered PK; secondary index leaf = key + PK → double lookup unless covering. Composite `(a,b,c)` obeys the **leftmost-prefix** rule (a / a,b / a,b,c only). Order columns **equality → range → sort**. **Covering / INCLUDE** → index-only scan, no heap fetch. Cost: every index taxes writes + storage. Reach for **partial** on skewed data, **expression** to fix `f(col)` predicates, **GIN** for JSONB/arrays/FTS, **GiST** for geo/ranges, **BRIN** for huge append-only. Planner ignores an index when it isn't selective, stats are stale, or the predicate isn't sargable.

**References:** PostgreSQL docs — "Indexes"; MySQL Reference Manual — "Optimization and Indexes"; Use The Index, Luke (Markus Winand); "SQL Performance Explained"

---
*SQL Handbook — topic 19.*
