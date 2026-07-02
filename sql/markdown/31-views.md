# 31 · Views & Materialized Views

> **In one line:** A view is a named query you `SELECT` from like a table; a materialized view is that query's result *stored on disk* and refreshed on demand.

---

## 1. Overview

A **view** is a stored `SELECT` statement given a name. Querying the view runs its
underlying query — nothing is stored except the definition. Views are the SQL layer's
main abstraction tool: they hide joins, rename and reshape columns, and expose a stable
contract to applications and BI tools even as the base tables evolve underneath.

They are also a **security boundary**. Grant a role access to a view that exposes only
non-sensitive columns (column restriction) or only the rows a tenant may see (row
restriction via a `WHERE`), and revoke direct access to the base table. The role can query
real data without ever touching the columns or rows it shouldn't.

A **materialized view (matview)** trades freshness for speed: it runs the query *once*,
stores the result set physically, and serves subsequent reads from that snapshot — no
re-computation. You pay to keep it current with `REFRESH`. Reach for a matview when the
underlying query is expensive (multi-table aggregation over millions of rows), read
frequently, and tolerant of slightly stale data — dashboards, leaderboards, reporting
rollups. A plain view recomputes every time; a matview is stale until you refresh it.

## 2. Core Concepts

- **View = stored query, zero storage.** `CREATE VIEW v AS SELECT …`. Reading `v` is
  literally substituting its definition into your query (predicate pushdown, then planned).
- **Abstraction contract.** Apps depend on the view's columns, not the base schema. You can
  refactor tables behind a stable view.
- **Security via restriction.** Expose a subset of **columns** and/or **rows**; grant on the
  view, revoke on the base table. Foundation of multi-tenant and PII-safe access.
- **Updatable view.** A simple view (one table, no aggregation/`DISTINCT`/`GROUP BY`) accepts
  `INSERT`/`UPDATE`/`DELETE`, which pass through to the base table.
- **`WITH CHECK OPTION`.** Rejects DML through an updatable view that would produce rows the
  view's `WHERE` can no longer see — enforces the view's predicate as a write constraint.
- **Materialized view = cached result.** Physically stored; reads skip recomputation.
  **Stale** between refreshes.
- **`REFRESH MATERIALIZED VIEW`.** Recomputes and repopulates. Plain refresh takes an
  `ACCESS EXCLUSIVE` lock (blocks reads); **`CONCURRENTLY`** rebuilds without blocking readers
  but requires a `UNIQUE` index and does more work.
- **Staleness window.** Data age = time since last refresh. The core trade-off you tune.
- **View vs matview vs table.** Live-but-slow vs fast-but-stale vs fast-and-authoritative.

## 3. Syntax & Examples

```sql
-- Plain view: abstraction over a 3-table join
CREATE VIEW order_summary AS
SELECT o.id            AS order_id,
       c.name         AS customer,
       o.placed_at,
       SUM(oi.qty * oi.unit_price) AS total
FROM   orders o
JOIN   customers c   ON c.id = o.customer_id
JOIN   order_items oi ON oi.order_id = o.id
GROUP  BY o.id, c.name, o.placed_at;

SELECT * FROM order_summary WHERE total > 500;   -- query like a table
```

```sql
-- Security: expose only active, non-PII customer rows/columns
CREATE VIEW customer_public AS
SELECT id, name, city          -- no email, no ssn (column restriction)
FROM   customers
WHERE  status = 'active';      -- row restriction

REVOKE ALL ON customers        FROM analyst;
GRANT  SELECT ON customer_public TO analyst;   -- analyst sees only safe slice
```

```sql
-- Updatable view + WITH CHECK OPTION
CREATE VIEW active_customers AS
SELECT id, name, status
FROM   customers
WHERE  status = 'active'
WITH CHECK OPTION;             -- writes must keep the row visible in the view

UPDATE active_customers SET name = 'Acme Inc' WHERE id = 7;  -- OK, still active
UPDATE active_customers SET status = 'closed' WHERE id = 7;  -- ERROR: violates CHECK OPTION
INSERT INTO active_customers (id, name, status) VALUES (9, 'X', 'active');  -- OK
INSERT INTO active_customers (id, name, status) VALUES (9, 'X', 'pending'); -- ERROR
```

```sql
-- Materialized view: precompute an expensive daily rollup
CREATE MATERIALIZED VIEW daily_revenue AS
SELECT date_trunc('day', placed_at) AS day,
       COUNT(*)                      AS orders,
       SUM(total)                    AS revenue
FROM   order_summary
GROUP  BY 1
WITH DATA;

-- CONCURRENTLY needs a unique index on the matview
CREATE UNIQUE INDEX ON daily_revenue (day);

REFRESH MATERIALIZED VIEW daily_revenue;               -- blocks readers
REFRESH MATERIALIZED VIEW CONCURRENTLY daily_revenue;  -- readers keep querying
```

> [!NOTE]
> MySQL has **no** materialized views — you emulate them with a real summary table plus
> a scheduled event/trigger that repopulates it. PostgreSQL and Oracle support them natively;
> Oracle adds incremental "fast refresh" via materialized-view logs.

## 4. Sample Data & Results

Base table `orders_flat` (denormalized for brevity):

| order_id | customer | placed_at  | total |
|----------|----------|------------|-------|
| 1        | Ana      | 2026-06-01 | 120   |
| 2        | Ben      | 2026-06-01 | 300   |
| 3        | Ana      | 2026-06-02 | 80    |
| 4        | Cyd      | 2026-06-02 | 500   |
| 5        | Ben      | 2026-06-02 | 50    |

```sql
CREATE MATERIALIZED VIEW daily_revenue AS
SELECT placed_at AS day, COUNT(*) AS orders, SUM(total) AS revenue
FROM   orders_flat
GROUP  BY placed_at;
SELECT * FROM daily_revenue ORDER BY day;
```

Result (snapshot at refresh time):

| day        | orders | revenue |
|------------|--------|---------|
| 2026-06-01 | 2      | 420     |
| 2026-06-02 | 3      | 630     |

Insert a new order for 2026-06-02, then read the matview *before* refreshing — it still shows
`orders = 3, revenue = 630` (stale). After `REFRESH MATERIALIZED VIEW daily_revenue` it updates.
A plain view over the same query would have shown the new row immediately.

## 5. Under the Hood

A plain view is **macro expansion**: the planner inlines the view's definition into the
outer query, pushes down predicates, and plans the whole thing as one statement — so
`WHERE total > 500` on `order_summary` can filter *before* the join if the optimizer allows.
No result is cached. A matview is a **heap on disk** (plus its own indexes); reads are a
plain scan of stored rows, and `REFRESH` re-runs the query and swaps in the new contents.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="180" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">VIEW — recompute every read</text>
  <rect x="40" y="44" width="120" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="100" y="69" text-anchor="middle" fill="#1e293b">SELECT * FROM v</text>
  <rect x="40" y="120" width="120" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="100" y="145" text-anchor="middle" fill="#1e293b">inline definition</text>
  <rect x="40" y="196" width="120" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="100" y="215" text-anchor="middle" fill="#1e293b">scan + join</text>
  <text x="100" y="231" text-anchor="middle" fill="#64748b">base tables</text>
  <line x1="100" y1="84" x2="100" y2="118" stroke="#475569" marker-end="url(#ah)"/>
  <line x1="100" y1="160" x2="100" y2="194" stroke="#475569" marker-end="url(#ah)"/>
  <text x="100" y="272" text-anchor="middle" fill="#059669" font-weight="700">always fresh · O(query) each time</text>

  <line x1="360" y1="44" x2="360" y2="256" stroke="#64748b" stroke-dasharray="4 4"/>

  <text x="545" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">MATERIALIZED VIEW — read cache</text>
  <rect x="485" y="44" width="120" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="545" y="69" text-anchor="middle" fill="#1e293b">SELECT * FROM mv</text>
  <rect x="485" y="120" width="120" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="545" y="140" text-anchor="middle" fill="#1e293b">stored heap</text>
  <text x="545" y="156" text-anchor="middle" fill="#64748b">on disk</text>
  <line x1="545" y1="84" x2="545" y2="118" stroke="#475569" marker-end="url(#ah)"/>
  <rect x="620" y="120" width="80" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="660" y="140" text-anchor="middle" fill="#1e293b">REFRESH</text>
  <text x="660" y="156" text-anchor="middle" fill="#64748b">re-runs Q</text>
  <line x1="620" y1="140" x2="607" y2="140" stroke="#d97706" marker-end="url(#ah)"/>
  <text x="545" y="272" text-anchor="middle" fill="#d97706" font-weight="700">fast read · stale until REFRESH</text>
</svg>
```

`REFRESH … CONCURRENTLY` doesn't take the blocking `ACCESS EXCLUSIVE` lock: it builds the new
data in the background and computes a diff against the old contents (which is why it needs a
`UNIQUE` index to identify rows), then applies changes — more CPU/IO, but readers never stall.

## 6. Variations & Trade-offs

| Property            | Plain View           | Materialized View          | Real Table              |
|---------------------|----------------------|----------------------------|-------------------------|
| Storage             | none (definition)    | full result on disk        | full data on disk       |
| Freshness           | always live          | stale until `REFRESH`      | authoritative           |
| Read cost           | recomputes each time | cheap scan                 | cheap scan              |
| Writable            | if simple (+CHECK)   | no (refresh-only)          | yes                     |
| Indexable directly  | no (base indexes)    | yes (own indexes)          | yes                     |
| Best for            | abstraction/security | expensive repeated reads   | source of truth         |

Plain views cost nothing to keep current but pay full query cost on every read — great for
abstraction, thin filters, and security, poor for heavy aggregations hit constantly.
Matviews invert that: near-instant reads at the price of a refresh job and a staleness window.
When you need *both* freshness and speed, the answer is usually a proper summary **table**
maintained incrementally by triggers (see *Stored Procedures, Functions & Triggers*), not a matview.

## 7. Performance Notes

- **A view is not an optimization.** It plans the same as the inlined query — no caching. If a
  view is slow, the underlying query/indexes are slow.
- **Predicate pushdown works, mostly.** `WHERE` on top of a simple view filters base tables via
  their indexes. But a view containing `GROUP BY`, `DISTINCT`, or window functions creates an
  **optimization fence** — the aggregate must materialize before your outer filter applies.
- **Index the matview.** It's a real heap; add indexes on its filter/join columns. A matview of a
  costly aggregate + an index on `day` turns a minute-long rollup into a millisecond lookup.
- **`REFRESH` cost = full query cost.** Schedule it off-peak; size the staleness window to the
  business need. Use `CONCURRENTLY` to avoid blocking, accepting extra refresh overhead.
- **Nested views** compound: a view on a view on a view can explode into a plan the optimizer
  handles poorly. Check `EXPLAIN` on the *final* query, not the layers.
- **`WITH CHECK OPTION`** adds a per-row predicate re-check on write — negligible, but real.

## 8. Common Mistakes

1. ⚠️ **Thinking a plain view caches results.** It recomputes every read. → For repeated expensive
   queries use a **materialized** view or summary table.
2. ⚠️ **Reading a matview and expecting live data.** It's a snapshot. → Refresh on a schedule and
   document the staleness; surface "last updated" in dashboards.
3. ⚠️ **`REFRESH` blocking production reads.** Plain refresh takes `ACCESS EXCLUSIVE`. → Use
   `REFRESH MATERIALIZED VIEW CONCURRENTLY` (after creating a `UNIQUE` index).
4. ⚠️ **`CONCURRENTLY` without a unique index.** It errors. → Create a `UNIQUE` index on a key
   column set first.
5. ⚠️ **Trying to `INSERT`/`UPDATE` a view with joins or aggregation.** Not updatable. → Write to
   base tables, or use `INSTEAD OF` triggers to route the DML.
6. ⚠️ **Omitting `WITH CHECK OPTION`** on a restricting view, letting writes create rows the view
   can't see (silent "disappearing" rows). → Add `WITH CHECK OPTION`.
7. ⚠️ **Relying on a view for security while leaving base-table `SELECT` granted.** → `REVOKE` on the
   base table; grant only on the view.
8. ⚠️ **Deeply nested views** hiding a monstrous plan. → Flatten hot paths; verify with `EXPLAIN`.

## 9. Interview Questions

**Q: What is the difference between a view and a materialized view?**
A: A view stores only a query definition and recomputes on every read (always fresh, no extra storage); a materialized view stores the query's result set physically and serves reads from that snapshot (fast reads, but stale until you `REFRESH` it).

**Q: Does a plain view improve query performance by caching results?**
A: No. A plain view is macro-expanded/inlined into the outer query and planned fresh each time — it runs the same work as writing the query directly. It aids abstraction and security, not speed. For caching you need a materialized view or summary table.

**Q: How do views provide security?**
A: By restriction. Expose only safe columns (column restriction) and only permitted rows (a `WHERE` clause = row restriction), then `REVOKE` access on the base table and `GRANT` on the view. The role queries real data without touching sensitive columns/rows.

**Q: When is a view updatable, and what does `WITH CHECK OPTION` do?**
A: A view is updatable when it maps cleanly to one base table with no aggregation, `DISTINCT`, `GROUP BY`, or set operations — DML passes through. `WITH CHECK OPTION` makes writes that would produce a row the view's `WHERE` no longer selects fail, enforcing the view predicate as a write-time constraint.

**Q: What does `REFRESH MATERIALIZED VIEW CONCURRENTLY` do and what does it require?**
A: It rebuilds the matview without taking the blocking `ACCESS EXCLUSIVE` lock, so readers keep querying during the refresh. It requires a `UNIQUE` index on the matview (used to diff old vs new rows) and costs more CPU/IO than a plain refresh.

**Q: How would you keep an expensive dashboard query fast?**
A: Materialize it: `CREATE MATERIALIZED VIEW` for the rollup, add indexes on its filter columns, and `REFRESH … CONCURRENTLY` on a schedule sized to the acceptable staleness. Show a "last refreshed" timestamp so users know the data age.

**Q: MySQL doesn't support materialized views — how do you get the same effect?**
A: Maintain a real summary table and repopulate it via a scheduled `EVENT` (periodic `TRUNCATE`+`INSERT … SELECT`) or keep it incrementally current with triggers on the base tables. That's a manual matview.

**Q: A view has a `GROUP BY`, and you filter it with an outer `WHERE`. Why can it be slow?**
A: The aggregation is an optimization fence — the engine must compute the full grouped result before your outer predicate can apply, so it can't push your filter down to use base-table indexes. Filter inside the aggregate (or on `GROUP BY` keys) when possible.

**Q: You `REVOKE SELECT` on a base table but grant it on a view over that table. Can the role read the data?**
A: Yes — the view runs with its owner's privileges on the base table, so the grantee reads through it without direct base-table access. That indirection is exactly what makes views a security layer.

**Q: How do you make DML work against a multi-table (non-updatable) view?**
A: Define `INSTEAD OF INSERT/UPDATE/DELETE` triggers on the view that translate the operation into the appropriate writes on the underlying base tables.

**Q: What are the risks of deeply nested views at scale?**
A: The optimizer must expand every layer; complex nesting can defeat predicate pushdown and produce a poor plan or duplicated work. Always `EXPLAIN` the final query, and flatten/materialize hot paths.

**Q: How do you choose between a view, a materialized view, and a table?**
A: View = need live data + abstraction/security, read cost acceptable. Materialized view = expensive query, read-heavy, staleness tolerable. Table = it's a source of truth or you need incremental, always-fresh maintenance (via triggers).

## 10. Practice

- [ ] Create a view exposing only `id, name, city` of active customers, revoke base-table access, and grant the view to an `analyst` role.
- [ ] Build an updatable view with `WITH CHECK OPTION` and demonstrate an `UPDATE` that the check option rejects.
- [ ] Materialize a daily revenue rollup, add a `UNIQUE` index on `day`, and refresh it `CONCURRENTLY`.
- [ ] Insert a new base row, query the matview to show it's stale, then refresh and show it updates.
- [ ] Write `INSTEAD OF` triggers making a 2-table join view accept inserts.

## 11. Cheat Sheet

> [!TIP]
> **View** = stored query, zero storage, always fresh, recomputes every read → abstraction &
> security (column + row restriction; grant on view, revoke on base). Updatable only if simple
> one-table; add `WITH CHECK OPTION` so writes can't create invisible rows.
> **Materialized view** = result stored on disk, fast reads, **stale until `REFRESH`**; index it;
> `REFRESH … CONCURRENTLY` (needs a `UNIQUE` index) to avoid blocking readers. A view is *not* a
> cache. Fresh + fast + writable = summary **table** maintained by triggers. MySQL has no matviews.

**References:** PostgreSQL docs — CREATE VIEW / CREATE MATERIALIZED VIEW / REFRESH MATERIALIZED VIEW; MySQL Reference Manual — CREATE VIEW & Updatable Views; Use The Index, Luke

---
*SQL Handbook — topic 31.*
