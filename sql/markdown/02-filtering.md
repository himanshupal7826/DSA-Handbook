# 02 · Filtering: IN, BETWEEN, LIKE & NULL Logic

> **In one line:** Filtering is easy until NULL turns your two-valued logic into three-valued logic and quietly drops rows you swore should match.

---

## 1. Overview

`WHERE` is where queries earn their keep. Beyond simple equality, SQL gives you set membership (`IN`), range tests (`BETWEEN`), pattern matching (`LIKE`/`ILIKE`), and a full suite of comparison and logical operators.

The genuinely hard part is not syntax — it is **NULL**. SQL does not use ordinary boolean logic; it uses **three-valued logic (3VL)**: every predicate evaluates to `TRUE`, `FALSE`, or `UNKNOWN`. `WHERE` keeps only rows where the predicate is `TRUE`. `NULL = NULL` is `UNKNOWN`, not `TRUE`, and this ripples into `IN`, `NOT IN`, joins, and `CHECK` constraints.

This page covers the operator toolkit and then the NULL traps that ambush even experienced engineers — especially `NOT IN` with a NULL in the list, which can silently return zero rows.

## 2. Core Concepts

- **Three-valued logic (3VL)** — predicates yield `TRUE`, `FALSE`, or `UNKNOWN`; `WHERE`/`ON`/`HAVING` keep only `TRUE`.
- **NULL means "unknown"** — any comparison *with* NULL (`=`, `<>`, `<`) yields `UNKNOWN`, so it never matches.
- **`IS NULL` / `IS NOT NULL`** — the *only* correct way to test for NULL; `= NULL` is always `UNKNOWN`.
- **`IN` is OR sugar** — `x IN (1,2,3)` ≡ `x=1 OR x=2 OR x=3`; both are sargable and index-friendly.
- **`NOT IN` + NULL trap** — if the list/subquery contains a NULL, `NOT IN` can never be `TRUE` → zero rows.
- **`BETWEEN` is inclusive** — `a BETWEEN x AND y` ≡ `a >= x AND a <= y`; both endpoints included.
- **`LIKE` wildcards** — `%` = any run of chars, `_` = exactly one char; leading `%` breaks index use.
- **`ILIKE` vs `LIKE`** — `ILIKE` (PostgreSQL) is case-insensitive; MySQL `LIKE` is case-insensitive by default via collation.
- **`COALESCE` / `NULLIF`** — normalize NULLs to defaults, or turn a sentinel value into NULL.

## 3. Syntax & Examples

```sql
-- Comparison + logical operators
SELECT * FROM products
WHERE price > 100 AND category <> 'clearance';

-- IN: set membership (equivalent to chained ORs)
SELECT * FROM products WHERE category IN ('books', 'music', 'games');

-- BETWEEN: inclusive on BOTH ends
SELECT * FROM products WHERE price BETWEEN 10 AND 20;   -- includes 10 and 20

-- LIKE: % = many chars, _ = one char
SELECT * FROM users WHERE email LIKE '%@gmail.com';     -- ends with
SELECT * FROM users WHERE code  LIKE 'A_9%';            -- A, any 1 char, 9, then anything

-- Case-insensitive match
SELECT * FROM users WHERE name ILIKE 'jon%';            -- PostgreSQL
-- MySQL: LIKE is case-insensitive under a *_ci collation

-- NULL is tested with IS, never =
SELECT * FROM orders WHERE shipped_at IS NULL;          -- correct
-- SELECT * FROM orders WHERE shipped_at = NULL;        -- always 0 rows

-- Normalize NULLs
SELECT COALESCE(nickname, name, 'anon') AS display FROM users;
SELECT NULLIF(discount, 0) AS discount FROM orders;     -- 0 -> NULL
```

## 4. Sample Data & Results

Table `orders`:

| id | customer | amount | coupon | shipped_at  |
|----|----------|--------|--------|-------------|
| 1  | 10       | 50     | SAVE10 | 2026-06-01  |
| 2  | 11       | 120    | NULL   | NULL        |
| 3  | 12       | 15     | NULL   | 2026-06-03  |
| 4  | 13       | 200    | VIP    | NULL        |
| 5  | 14       | 80     | SAVE10 | 2026-06-05  |

Query — unshipped orders with a mid-range amount:

```sql
SELECT id, amount
FROM orders
WHERE shipped_at IS NULL
  AND amount BETWEEN 100 AND 200;
```

Result:

| id | amount |
|----|--------|
| 2  | 120    |
| 4  | 200    |

Now the NULL trap. This looks like "orders without a SAVE10 coupon" but returns **zero rows** because `coupon` contains NULLs:

```sql
SELECT id FROM orders
WHERE coupon NOT IN ('SAVE10', 'VIP', NULL);   -- returns NOTHING
```

Since `coupon <> NULL` is `UNKNOWN`, the `NOT IN` can never be `TRUE`. Fix by excluding NULL from the list and handling it explicitly (see §5).

## 5. Under the Hood

The engine reduces every `WHERE` predicate to one of three truth values and keeps only `TRUE`. The `NOT IN` trap is pure logic: `x NOT IN (a, b, NULL)` expands to `x<>a AND x<>b AND x<>NULL`, and that last term is always `UNKNOWN`, so the whole `AND` can never reach `TRUE`.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="24" text-anchor="middle" fill="#64748b">Three-valued logic: a predicate resolves to one of three states</text>

  <rect x="270" y="44" width="180" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="63" text-anchor="middle" fill="#1e293b">predicate on a row</text>

  <line x1="330" y1="74" x2="150" y2="112" stroke="#475569" marker-end="url(#ah2)"/>
  <line x1="360" y1="74" x2="360" y2="112" stroke="#475569" marker-end="url(#ah2)"/>
  <line x1="390" y1="74" x2="580" y2="112" stroke="#475569" marker-end="url(#ah2)"/>

  <rect x="70" y="114" width="150" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="145" y="133" text-anchor="middle" fill="#1e293b">TRUE</text>
  <rect x="285" y="114" width="150" height="30" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="133" text-anchor="middle" fill="#1e293b">FALSE</text>
  <rect x="505" y="114" width="150" height="30" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="580" y="133" text-anchor="middle" fill="#1e293b">UNKNOWN (NULL)</text>

  <rect x="70" y="176" width="150" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="145" y="195" text-anchor="middle" fill="#1e293b">row KEPT</text>
  <rect x="285" y="176" width="370" height="30" rx="8" fill="#fdecea" stroke="#b91c1c"/>
  <text x="470" y="195" text-anchor="middle" fill="#b91c1c">row DROPPED (WHERE keeps only TRUE)</text>

  <line x1="145" y1="144" x2="145" y2="174" stroke="#475569" marker-end="url(#ah2)"/>
  <line x1="360" y1="144" x2="360" y2="174" stroke="#475569" marker-end="url(#ah2)"/>
  <line x1="580" y1="144" x2="500" y2="174" stroke="#475569" marker-end="url(#ah2)"/>

  <text x="360" y="240" text-anchor="middle" fill="#b91c1c">x NOT IN (a, b, NULL)  →  x&lt;&gt;NULL is UNKNOWN  →  never TRUE  →  0 rows</text>
  <text x="360" y="266" text-anchor="middle" fill="#64748b">This is why UNKNOWN and FALSE behave the same for WHERE, but differ under NOT.</text>
</svg>
```

Crucially, `NOT UNKNOWN` is still `UNKNOWN` — negation does not rescue it. That asymmetry is why `NOT IN` with NULLs fails while `IN` with NULLs merely ignores the NULL.

## 6. Variations & Trade-offs

| Predicate | Equivalent to | Index-friendly? | Watch out for |
|-----------|---------------|-----------------|---------------|
| `x IN (1,2,3)` | `x=1 OR x=2 OR x=3` | Yes | Huge lists → planner may switch to hash/scan |
| `x NOT IN (subquery)` | AND of `<>` | Often not | **NULL in subquery → 0 rows** |
| `x BETWEEN a AND b` | `x>=a AND x<=b` | Yes (range scan) | Inclusive both ends; reversed bounds match nothing |
| `col LIKE 'abc%'` | prefix match | Yes | Anchored prefix only |
| `col LIKE '%abc'` | suffix match | **No** (leading `%`) | Consider reverse index / trigram |
| `col ILIKE 'x%'` | case-insensitive | Only with expr/functional index | PG-specific; MySQL uses collation |
| `x IS NULL` | null test | Yes (if indexed) | The only correct NULL test |

**`NOT IN` vs `NOT EXISTS`:** prefer `NOT EXISTS` (or a `LEFT JOIN ... IS NULL` anti-join) when the subquery can produce NULLs — `NOT EXISTS` is NULL-safe and usually planned as an efficient anti-join.

## 7. Performance Notes

- **`IN` with a literal list** is sargable — the engine can do multiple index seeks or a bitmap. Very large `IN` lists (thousands) may tip the planner toward a hash join against a values list.
- **`BETWEEN`** on an indexed column is a clean **range scan** — the sweet spot for B-trees.
- **`LIKE 'prefix%'`** uses an index (bounded range); **`LIKE '%suffix'`** cannot use a plain B-tree. For infix/suffix search use a **trigram index** (PostgreSQL `pg_trgm`) or full-text search.
- **`ILIKE`** and `LOWER(col) = ...` are not sargable against a normal index; add a **functional index** on `LOWER(col)` or a case-insensitive collation.
- **`NOT IN (subquery)`** is doubly dangerous: correctness (NULLs) and performance (poor anti-join plans). Rewrite as `NOT EXISTS`.

## 8. Common Mistakes

1. ⚠️ **`WHERE col = NULL`.** Always `UNKNOWN` → 0 rows. Fix: `col IS NULL`.
2. ⚠️ **`NOT IN` over a nullable column/subquery.** Silently returns nothing. Fix: `NOT EXISTS`, or filter out NULLs first.
3. ⚠️ **Assuming `BETWEEN` is exclusive.** It includes both endpoints. Fix: use explicit `>=`/`<` for half-open ranges (great for dates/timestamps).
4. ⚠️ **Leading-wildcard `LIKE '%x%'` on a big table.** Full scan. Fix: trigram/full-text index.
5. ⚠️ **Forgetting NULLs don't count in `COUNT(col)` or aggregates.** `COUNT(col)` skips NULLs; `COUNT(*)` doesn't.
6. ⚠️ **`col <> 'x'` expecting NULL rows back.** NULLs are excluded (predicate is UNKNOWN). Fix: `col <> 'x' OR col IS NULL`.
7. ⚠️ **Reversed `BETWEEN` bounds** (`BETWEEN 20 AND 10`) matching nothing. Fix: order the bounds low-to-high.

## 9. Interview Questions

**Q: What is three-valued logic in SQL?**
A: Predicates evaluate to TRUE, FALSE, or UNKNOWN. WHERE, ON, and HAVING keep only rows where the predicate is TRUE; both FALSE and UNKNOWN rows are dropped.

**Q: Why does `col = NULL` never match anything?**
A: Any comparison with NULL yields UNKNOWN, not TRUE, so the row is dropped. You must use `IS NULL` / `IS NOT NULL`.

**Q: Explain the NOT IN with NULL trap.**
A: `x NOT IN (a, b, NULL)` expands to `x<>a AND x<>b AND x<>NULL`; the last term is UNKNOWN, so the AND can never be TRUE, and the query returns zero rows regardless of x.

**Q: Is BETWEEN inclusive or exclusive?**
A: Inclusive on both ends: `x BETWEEN a AND b` is `x >= a AND x <= b`. For timestamp ranges prefer a half-open `>= a AND < b` to avoid boundary double-counting.

**Q: What do % and _ mean in LIKE?**
A: `%` matches zero or more characters; `_` matches exactly one character. Escape them with an ESCAPE clause when matching literals.

**Q: Why is `LIKE '%term'` slow?**
A: A B-tree is ordered by prefix; a leading wildcard leaves no usable prefix, so the engine must scan every row. Use a trigram or full-text index for infix/suffix search.

**Q: How do you rewrite an unsafe NOT IN?**
A: Use `NOT EXISTS (SELECT 1 FROM t WHERE t.x = outer.x)` or a LEFT JOIN anti-join with `IS NULL`. Both are NULL-safe and usually planned as efficient anti-joins.

**Q: Difference between COUNT(*) and COUNT(col)?**
A: `COUNT(*)` counts all rows; `COUNT(col)` counts only rows where col is non-NULL. This surprises people when col is nullable.

**Q: How would you make an ILIKE/`LOWER()` search use an index?**
A: Create a functional index on the expression, e.g. `CREATE INDEX ON users (LOWER(email))`, and query `WHERE LOWER(email) = LOWER($1)`; or use a case-insensitive collation / citext type.

**Q: `IN` vs `EXISTS` — when do they differ in plans?**
A: `IN` with a small literal list is fine; against a subquery, `EXISTS` can short-circuit per outer row and is NULL-safe. Modern optimizers often unify semi-join plans, but `EXISTS`/`NOT EXISTS` are the safer default with nullable columns.

**Q: Why might `WHERE status <> 'closed'` miss rows you expected?**
A: Rows where status is NULL evaluate the predicate to UNKNOWN and are excluded. Add `OR status IS NULL` if NULL should be treated as "not closed".

## 10. Practice

- [ ] Write a query that returns customers *without* any of three coupon codes, safe against NULLs.
- [ ] Convert `BETWEEN '2026-01-01' AND '2026-01-31'` on a timestamp into a correct half-open range.
- [ ] Add a functional index so a case-insensitive email lookup uses an index; verify with `EXPLAIN`.
- [ ] Demonstrate the `NOT IN (…, NULL)` zero-row trap and fix it with `NOT EXISTS`.
- [ ] Show the difference between `COUNT(*)` and `COUNT(coupon)` on the sample `orders` table.

## 11. Cheat Sheet

> [!TIP]
> **NULL = unknown.** Test with `IS NULL`, never `= NULL`. WHERE keeps only TRUE (FALSE and UNKNOWN both drop).
> `IN` = OR sugar (sargable). **`NOT IN` + any NULL = 0 rows** → use `NOT EXISTS`.
> `BETWEEN` is **inclusive** both ends; use `>= / <` for dates. `LIKE 'p%'` uses an index; `LIKE '%s'` doesn't (trigram/FTS). `ILIKE`/`LOWER()` need a functional index. Remember: `col <> 'x'` silently excludes NULLs.

**References:** PostgreSQL docs — Comparison Functions & Operators, Pattern Matching; MySQL — Comparison Operators; Use The Index, Luke — LIKE and functions; SQL:1999 three-valued logic

---

*SQL Handbook — topic 02.*
