# 05 · Joins: INNER, LEFT, RIGHT, FULL, CROSS

> **In one line:** A join pairs each row of one table with related rows of another on a predicate, and the join *type* decides what happens to rows that find no partner.

---

## 1. Overview

A **join** combines columns from two (or more) tables into a single result set by evaluating a **join predicate** — usually an equality on a key like `orders.customer_id = customers.id`. Relational data is deliberately split across tables (normalization); joins are how you stitch it back together at query time.

The predicate finds the *matches*. The **join type** decides the fate of the *non-matches* — the rows on one side that have no partner on the other. INNER discards them; the OUTER joins (LEFT, RIGHT, FULL) preserve them and pad the missing side with NULLs. CROSS ignores predicates entirely and pairs everything with everything.

Getting joins right is 80% of day-to-day SQL. The two mistakes that bite hardest are (1) accidentally turning an outer join back into an inner one by filtering the null-padded side in `WHERE`, and (2) **row inflation** — a one-to-many join silently multiplying rows and corrupting every downstream `SUM`/`COUNT`.

## 2. Core Concepts

- **Join predicate** — the `ON` condition that pairs rows. Usually `equi-join` (`=`); can be range or expression (`theta-join`).
- **INNER JOIN** — the intersection: only rows with a match on both sides survive.
- **LEFT (OUTER) JOIN** — every left row survives; unmatched right columns become NULL.
- **RIGHT (OUTER) JOIN** — mirror of LEFT; every right row survives. Rewrite as LEFT for readability.
- **FULL (OUTER) JOIN** — union of LEFT and RIGHT: unmatched rows from *both* sides, NULL-padded.
- **CROSS JOIN** — Cartesian product: every left row × every right row, no predicate. `m × n` rows.
- **ON vs WHERE** — for outer joins, `ON` decides *matching*; `WHERE` filters the *final* result and can silently demote an outer join to inner.
- **Row inflation (fan-out)** — a one-to-many join emits one output row per match, multiplying the "one" side.
- **NULL never equals NULL** — join predicates use `=`, so NULL keys never match; they behave like unmatched rows.

## 3. Syntax & Examples

```sql
-- INNER: customers that have at least one order
SELECT c.name, o.id AS order_id, o.total
FROM customers c
INNER JOIN orders o ON o.customer_id = c.id;

-- LEFT: ALL customers, with order data where it exists (NULLs otherwise)
SELECT c.name, o.id AS order_id, o.total
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id;

-- FULL: every customer and every order, matched where possible
SELECT c.name, o.id AS order_id
FROM customers c
FULL JOIN orders o ON o.customer_id = c.id;

-- CROSS: pair every size with every color (deliberate combinatorics)
SELECT s.label, c.label
FROM sizes s
CROSS JOIN colors c;
```

```sql
-- The critical distinction: filter in ON vs WHERE on a LEFT JOIN.

-- (A) Predicate in ON: keeps ALL customers; only *shipped* orders attach.
SELECT c.name, o.id
FROM customers c
LEFT JOIN orders o
       ON o.customer_id = c.id
      AND o.status = 'shipped';

-- (B) Same predicate in WHERE: silently becomes an INNER JOIN.
--     Customers with no shipped order have o.status = NULL,
--     and NULL = 'shipped' is UNKNOWN -> row is dropped.
SELECT c.name, o.id
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'shipped';
```

> [!WARN]
> Any condition on the **null-supplying** (right) table placed in `WHERE` — except `IS NULL` — nullifies a LEFT JOIN. The unmatched rows carry NULLs, and every comparison to NULL is UNKNOWN, so `WHERE` filters them out. Put such conditions in `ON`.

## 4. Sample Data & Results

**`customers`**

| id | name  |
|----|-------|
| 1  | Ada   |
| 2  | Grace |
| 3  | Lin   |

**`orders`**

| id  | customer_id | total |
|-----|-------------|-------|
| 100 | 1           | 40    |
| 101 | 1           | 25    |
| 102 | 2           | 90    |

Query — LEFT JOIN keeps Lin (no orders):

```sql
SELECT c.name, o.id AS order_id, o.total
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
ORDER BY c.name, o.id;
```

**Result** — note Ada appears **twice** (one-to-many fan-out) and Lin has NULLs:

| name  | order_id | total |
|-------|----------|-------|
| Ada   | 100      | 40    |
| Ada   | 101      | 25    |
| Grace | 102      | 90    |
| Lin   | NULL     | NULL  |

Fan-out corrupts naïve aggregation. To count *orders per customer* correctly you group; to sum a **per-customer** column that lives on `customers` you must pre-aggregate `orders` first, or you'll multiply it by the match count.

## 5. Under the Hood

Logically, SQL evaluates `FROM`/`JOIN` before `WHERE` before `SELECT`. An outer join first forms matched pairs via `ON`, then **appends** the unmatched outer rows padded with NULLs, and only then does `WHERE` run — which is exactly why a `WHERE` predicate on the padded side erases those rows.

The Venn/set picture of what each join keeps:

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <style>
    .lbl{fill:#1e293b;font-weight:600}.mut{fill:#64748b}
    .a{fill:#eff6ff;stroke:#2563eb;stroke-width:1.5}
    .b{fill:#ecfdf5;stroke:#059669;stroke-width:1.5}
    .keep{fill:#2563eb;fill-opacity:0.35}
  </style>

  <!-- INNER -->
  <g transform="translate(20,20)">
    <text x="70" y="0" text-anchor="middle" class="lbl">INNER</text>
    <clipPath id="cA"><circle cx="55" cy="70" r="45"/></clipPath>
    <circle cx="55" cy="70" r="45" class="a"/>
    <circle cx="90" cy="70" r="45" class="b"/>
    <circle cx="90" cy="70" r="45" class="keep" clip-path="url(#cA)"/>
    <text x="20" y="140" text-anchor="middle" class="mut">A</text>
    <text x="125" y="140" text-anchor="middle" class="mut">B</text>
  </g>

  <!-- LEFT -->
  <g transform="translate(180,20)">
    <text x="70" y="0" text-anchor="middle" class="lbl">LEFT</text>
    <circle cx="55" cy="70" r="45" class="a keep"/>
    <circle cx="90" cy="70" r="45" class="b"/>
    <text x="20" y="140" text-anchor="middle" class="mut">A</text>
    <text x="125" y="140" text-anchor="middle" class="mut">B</text>
  </g>

  <!-- RIGHT -->
  <g transform="translate(340,20)">
    <text x="70" y="0" text-anchor="middle" class="lbl">RIGHT</text>
    <circle cx="55" cy="70" r="45" class="a"/>
    <circle cx="90" cy="70" r="45" class="b keep" fill-opacity="0.35"/>
    <text x="20" y="140" text-anchor="middle" class="mut">A</text>
    <text x="125" y="140" text-anchor="middle" class="mut">B</text>
  </g>

  <!-- FULL -->
  <g transform="translate(500,20)">
    <text x="70" y="0" text-anchor="middle" class="lbl">FULL</text>
    <circle cx="55" cy="70" r="45" class="a keep"/>
    <circle cx="90" cy="70" r="45" class="keep" fill="#2563eb" fill-opacity="0.35" stroke="#059669" stroke-width="1.5"/>
    <text x="20" y="140" text-anchor="middle" class="mut">A</text>
    <text x="125" y="140" text-anchor="middle" class="mut">B</text>
  </g>

  <text x="360" y="230" text-anchor="middle" class="mut">Shaded = rows kept. CROSS keeps every A×B pair (no predicate) — not a set overlap.</text>
  <rect x="250" y="250" width="220" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="271" text-anchor="middle" class="lbl">CROSS: |A| × |B| rows</text>
</svg>
```

**Physical execution** — the optimizer picks a join *algorithm*, independent of the logical join type:

- **Nested loop** — for each outer row, probe the inner (great when the inner side is indexed on the key and the outer is small).
- **Hash join** — build a hash table on the smaller input's key, probe with the other (best for large, unindexed equi-joins).
- **Merge join** — sort both inputs on the key, walk in lockstep (wins when inputs are already sorted / index-ordered).

Read the plan with `EXPLAIN`; the node name (`Nested Loop`, `Hash Join`, `Merge Join`) tells you which strategy the planner chose and why.

## 6. Variations & Trade-offs

| Join       | Keeps unmatched left? | Keeps unmatched right? | Predicate? | Typical use |
|------------|:---------------------:|:----------------------:|:----------:|-------------|
| INNER      | no                    | no                     | yes        | Only related rows matter |
| LEFT       | yes                   | no                     | yes        | "All X, plus Y if any" |
| RIGHT      | no                    | yes                    | yes        | Mirror of LEFT (avoid) |
| FULL       | yes                   | yes                    | yes        | Reconcile two sets, find diffs both ways |
| CROSS      | n/a (all pairs)       | n/a                    | no         | Generate combinations, date/number spines |

**Dialect notes:** MySQL (before 8.0.31) has **no `FULL JOIN`** — emulate with `LEFT ... UNION ... RIGHT`. `CROSS JOIN` and `INNER JOIN` are interchangeable syntactically in MySQL. The comma join (`FROM a, b WHERE ...`) is a CROSS unless the WHERE constrains it — prefer explicit `JOIN` everywhere. PostgreSQL, SQL Server, and Oracle all support FULL natively.

## 7. Performance Notes

- **Index the join key** on at least the probed side — usually the FK column (`orders.customer_id`). Without it, a large join degrades to a hash or full scan.
- **Fan-out is a cost multiplier**, not just a correctness bug: a 1:100 join produces 100× the rows for the planner to sort/aggregate. Pre-aggregate in a CTE when you only need a summary.
- **Outer joins constrain join order** — the optimizer can't freely reorder around a LEFT JOIN the way it can with INNER, so the plan space is smaller.
- **CROSS on real tables explodes**: 10k × 10k = 100M rows. Intentional only for small generator sets.
- Check `EXPLAIN (ANALYZE)`: a `Nested Loop` with a huge outer row estimate and no inner index is the classic slow-join signature — add the index or coax a hash join.

## 8. Common Mistakes

1. ⚠️ **Filtering the outer side in `WHERE`** (`WHERE o.status='shipped'`) silently turns LEFT into INNER — move the predicate into `ON`.
2. ⚠️ **Forgetting the `ON` clause** (or a comma join with no WHERE link) yields a Cartesian product — always state the predicate.
3. ⚠️ **`SUM`/`COUNT` over a fan-out join** double-counts — aggregate the many-side first, then join the summary.
4. ⚠️ **Ambiguous columns** — in multi-table queries qualify every column with an alias, or you'll hit "column reference is ambiguous".
5. ⚠️ **Joining on a nullable key** and expecting NULLs to match — `NULL = NULL` is UNKNOWN; those rows behave as unmatched.
6. ⚠️ **RIGHT JOIN sprawl** — mixing LEFT and RIGHT in one query makes row-preservation logic unreadable; standardize on LEFT.
7. ⚠️ **`COUNT(*)` after a LEFT JOIN** counts the NULL-padded row too — use `COUNT(o.id)` to count real matches.

## 9. Interview Questions

**Q: What is the difference between INNER JOIN and LEFT JOIN?**
A: INNER returns only rows with a match on both sides (the intersection). LEFT returns every row from the left table, attaching right-table columns where a match exists and NULLs where it doesn't.

**Q: How do you find rows in A that have no match in B?**
A: `A LEFT JOIN B ON ...` then `WHERE B.key IS NULL` (an anti-join), or equivalently `WHERE NOT EXISTS (SELECT 1 FROM B WHERE B.key = A.key)`.

**Q: For an outer join, what is the difference between putting a condition in ON versus WHERE?**
A: `ON` conditions decide which rows *match* and still preserve unmatched outer rows (NULL-padded). `WHERE` runs after the join is formed and filters the final result — so a `WHERE` predicate on the null-supplying side removes those NULL rows and demotes the outer join to an inner join.

**Q: Why did my LEFT JOIN "lose" the unmatched rows after I added a filter?**
A: The filter referenced the right table in `WHERE`. Unmatched rows have NULL there, and `NULL <op> value` is UNKNOWN, so they get filtered out. Move the condition into the `ON` clause.

**Q: What produces a Cartesian product and when is it intentional?**
A: A join with no predicate (missing `ON`, or a comma join with no linking `WHERE`) — or an explicit `CROSS JOIN`. It's intentional when you deliberately want every combination, e.g. pairing sizes × colors or generating a date spine.

**Q: Why would a join return more rows than either table has?**
A: One-to-many fan-out — each left row matches several right rows, so the output has one row per match. A many-to-many join multiplies both sides.

**Q: How do you aggregate without fan-out inflating the totals?**
A: Pre-aggregate the many-side in a subquery/CTE (`SELECT customer_id, SUM(total) FROM orders GROUP BY customer_id`) and join that single-row-per-key summary, instead of joining raw rows and summing.

**Q: RIGHT JOIN vs LEFT JOIN — is there any performance difference?**
A: No — they're logically mirror images and the planner treats them identically. LEFT is preferred purely for readability; you can always swap table order to convert one to the other.

**Q: How does the database physically execute a join, and how do I tell which algorithm it chose?**
A: It picks nested loop, hash join, or merge join based on input sizes, sort order, and available indexes. `EXPLAIN` shows the node type: `Nested Loop` (small outer + indexed inner), `Hash Join` (large unindexed equi-join), or `Merge Join` (pre-sorted inputs).

**Q: Does an outer join limit the optimizer compared to an inner join?**
A: Yes. INNER joins are freely commutative and associative, so the planner can reorder them for the cheapest plan. OUTER joins have row-preservation semantics that restrict legal reorderings, shrinking the plan search space.

**Q: How do you emulate FULL OUTER JOIN in MySQL versions that lack it?**
A: `SELECT ... FROM a LEFT JOIN b ON ... UNION SELECT ... FROM a RIGHT JOIN b ON ...`. The `UNION` (not `UNION ALL`) dedupes the shared matched rows.

## 10. Practice

- [ ] List every customer with their order count, including zero-order customers (LEFT JOIN + `COUNT(o.id)`).
- [ ] Rewrite a RIGHT JOIN between `orders` and `customers` as an equivalent LEFT JOIN.
- [ ] Find orders whose `customer_id` points to a non-existent customer (FULL JOIN or anti-join).
- [ ] Generate a `sizes × colors` combination table with CROSS JOIN.
- [ ] Take a LEFT JOIN that inflates a `SUM`, and fix it by pre-aggregating the many-side in a CTE.

## 11. Cheat Sheet

> [!TIP]
> **Joins:** predicate finds matches; join *type* decides the non-matches. INNER=intersection, LEFT=keep all left (+NULLs), RIGHT=mirror (avoid), FULL=keep both, CROSS=every pair (m×n). Filter the outer side in **ON**, not WHERE, or you silently get an INNER join. Beware one-to-many **fan-out** inflating SUM/COUNT — pre-aggregate the many-side. Index the join key. Physical algos: nested loop / hash / merge — read them in `EXPLAIN`.

**References:** PostgreSQL docs "Table Joins", MySQL "JOIN Syntax", Use The Index Luke ("The Join Operation"), SQL Performance Explained

---

*SQL Handbook — topic 05.*
