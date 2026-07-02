# 15 · CASE, COALESCE & NULLIF

> **In one line:** Branch, default, and guard values inside a query — the if/else, first-non-null, and null-if-equal of SQL.

---

## 1. Overview

SQL is declarative, but you still need row-level decisions: bucket an amount into a tier, substitute a fallback for a missing value, avoid dividing by zero. The trio **CASE**, **COALESCE**, and **NULLIF** covers almost all of it.

**CASE** is SQL's portable conditional expression — an `if/elseif/else` that returns a value. It comes in two shapes: the **searched** form (`CASE WHEN <condition> THEN ...`) for arbitrary boolean tests, and the **simple** form (`CASE <expr> WHEN <value> THEN ...`) for equality against one expression. Because it is an *expression*, it can appear anywhere a value can: `SELECT`, `WHERE`, `ORDER BY`, `GROUP BY`, and — powerfully — **inside aggregates**.

**COALESCE(a, b, c, …)** returns the **first non-NULL** argument — the standard, portable way to supply defaults (unlike Oracle's `NVL` or MySQL's `IFNULL`, which take exactly two args). **NULLIF(a, b)** returns NULL when `a = b` and `a` otherwise — its classic job is to turn a zero denominator into NULL so a division yields NULL instead of erroring.

Together they are the everyday toolkit for cleaning, defaulting, and classifying data — and `CASE` inside `SUM`/`COUNT` is the gateway to **conditional aggregation** and pivoting.

## 2. Core Concepts

- **CASE is an expression, not a statement.** It returns one value and can be used anywhere a scalar is allowed — including nested inside functions and aggregates.
- **Searched CASE:** `CASE WHEN cond1 THEN r1 WHEN cond2 THEN r2 ELSE rN END`. Evaluated **top-to-bottom, first match wins**.
- **Simple CASE:** `CASE expr WHEN v1 THEN r1 ... END` — shorthand for `expr = v1`. Cannot test `NULL` (because `expr = NULL` is UNKNOWN); use searched CASE with `IS NULL`.
- **No ELSE → NULL.** If no branch matches and there is no `ELSE`, CASE returns NULL.
- **Result type unification.** All THEN/ELSE branches must resolve to a compatible type; the engine coerces to a common type.
- **Short-circuit / lazy:** CASE stops at the first true WHEN — useful to guard later, riskier expressions.
- **COALESCE(a,b,…)** = first non-NULL argument; NULL if all are NULL. Portable standard (vs `NVL`, `IFNULL`, `ISNULL`).
- **NULLIF(a,b)** = `CASE WHEN a = b THEN NULL ELSE a END` — most used as `x / NULLIF(divisor, 0)` to dodge divide-by-zero.
- **NULL propagation:** arithmetic/comparison with NULL yields NULL/UNKNOWN, which is why COALESCE and NULLIF pair so well with CASE for defensive queries.
- **Booleans:** in PostgreSQL a condition is a real `boolean`; you can even `SUM(CASE WHEN cond THEN 1 ELSE 0 END)` or `COUNT(*) FILTER (WHERE cond)` to count matches.

## 3. Syntax & Examples

```sql
-- Searched CASE: tier a numeric amount
SELECT order_id, amount,
       CASE WHEN amount >= 1000 THEN 'gold'
            WHEN amount >= 100  THEN 'silver'
            ELSE 'bronze'
       END AS tier
FROM orders;
```

```sql
-- Simple CASE: map a status code to a label (equality only)
SELECT status,
       CASE status
         WHEN 'P' THEN 'Paid'
         WHEN 'R' THEN 'Refunded'
         ELSE 'Unknown'
       END AS status_label
FROM orders;
```

```sql
-- COALESCE: fall back through preferred → mobile → 'N/A'
SELECT customer_id,
       COALESCE(preferred_phone, mobile_phone, 'N/A') AS contact
FROM customers;
```

```sql
-- NULLIF: guard divide-by-zero → returns NULL instead of erroring
SELECT campaign_id,
       clicks,
       impressions,
       clicks::numeric / NULLIF(impressions, 0) AS ctr   -- NULL when impressions = 0
FROM ad_stats;
```

```sql
-- CASE inside an aggregate: conditional aggregation (pivot preview)
SELECT region,
       SUM(CASE WHEN status = 'paid'     THEN amount ELSE 0 END) AS paid_revenue,
       SUM(CASE WHEN status = 'refunded' THEN amount ELSE 0 END) AS refunds,
       COUNT(*) FILTER (WHERE status = 'paid')                    AS paid_orders  -- PG shorthand
FROM orders
GROUP BY region;
```

## 4. Sample Data & Results

Input — `ad_stats`:

| campaign_id | clicks | impressions |
|-------------|-------:|------------:|
| A | 50  | 1000 |
| B | 10  |  200 |
| C |  0  |    0 |
| D | 30  |    0 |

Query — tier + NULL-safe CTR:

```sql
SELECT campaign_id,
       CASE WHEN clicks >= 40 THEN 'high' ELSE 'low' END AS activity,
       clicks::numeric / NULLIF(impressions, 0) AS ctr
FROM ad_stats;
```

Result:

| campaign_id | activity | ctr  |
|-------------|----------|-----:|
| A | high | 0.050 |
| B | low  | 0.050 |
| C | low  | NULL  | ← 0/NULLIF(0,0)=0/NULL=NULL, no error
| D | low  | NULL  | ← divisor guarded to NULL

Without `NULLIF`, rows C and D would raise `division by zero`. With it, they safely return `NULL`, which a report can display as "—".

## 5. Under the Hood

These are all **scalar expressions** evaluated per row during projection/filtering — no extra scan or join. The optimizer folds constants and, for `CASE`, **short-circuits**: it evaluates WHEN conditions in order and stops at the first true one, so an expensive or unsafe expression placed after its guard is never computed for guarded rows. `COALESCE` and `NULLIF` are themselves defined in the standard as `CASE` expressions, so they share this lazy, first-match evaluation.

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a3" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" fill="#1e293b" font-weight="bold">CASE evaluation: top-to-bottom, first match wins</text>

  <rect x="250" y="40" width="140" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="320" y="64" text-anchor="middle" fill="#1e293b">row value</text>

  <line x1="320" y1="78" x2="320" y2="98" stroke="#475569" marker-end="url(#a3)"/>

  <rect x="230" y="100" width="180" height="38" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="320" y="124" text-anchor="middle" fill="#1e293b">WHEN amount &gt;= 1000?</text>
  <line x1="410" y1="119" x2="470" y2="119" stroke="#475569" marker-end="url(#a3)"/>
  <rect x="472" y="100" width="150" height="38" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="547" y="124" text-anchor="middle" fill="#1e293b">'gold' — stop</text>

  <line x1="320" y1="138" x2="320" y2="158" stroke="#475569" marker-end="url(#a3)"/>
  <text x="410" y="132" fill="#64748b" font-size="12">true</text>

  <rect x="230" y="160" width="180" height="38" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="320" y="184" text-anchor="middle" fill="#1e293b">WHEN amount &gt;= 100?</text>
  <line x1="410" y1="179" x2="470" y2="179" stroke="#475569" marker-end="url(#a3)"/>
  <rect x="472" y="160" width="150" height="38" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="547" y="184" text-anchor="middle" fill="#1e293b">'silver' — stop</text>

  <line x1="320" y1="198" x2="320" y2="218" stroke="#475569" marker-end="url(#a3)"/>
  <text x="410" y="192" fill="#64748b" font-size="12">true</text>

  <rect x="250" y="220" width="140" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="320" y="244" text-anchor="middle" fill="#1e293b">ELSE 'bronze'</text>

  <text x="320" y="284" text-anchor="middle" fill="#64748b">No ELSE and no match → NULL. COALESCE/NULLIF desugar to this same CASE.</text>
</svg>
```

## 6. Variations & Trade-offs

| Need | Standard SQL | Postgres | MySQL | Oracle |
|------|--------------|----------|-------|--------|
| First non-NULL of N args | `COALESCE(a,b,…)` | `COALESCE` | `COALESCE`/`IFNULL` (2-arg) | `COALESCE`/`NVL` (2-arg) |
| NULL if equal | `NULLIF(a,b)` | `NULLIF` | `NULLIF` | `NULLIF` |
| Conditional value | `CASE …` | `CASE` | `CASE` / `IF()` | `CASE` / `DECODE` |
| NULL → default (2-arg) | `COALESCE(a,d)` | `COALESCE` | `IFNULL(a,d)` | `NVL(a,d)` |
| Count matching rows | `SUM(CASE WHEN c THEN 1 ELSE 0 END)` | `COUNT(*) FILTER (WHERE c)` | `SUM(c)` (bool→1/0) | `SUM(CASE …)` |

Prefer the **portable** standard forms (`CASE`, `COALESCE`, `NULLIF`) over vendor extensions (`NVL`, `IFNULL`, `DECODE`, `IF`) when code must move across engines. `COALESCE` generalizes the 2-arg helpers to any number of arguments. In PostgreSQL, `COUNT(*) FILTER (WHERE cond)` reads cleaner than `SUM(CASE WHEN cond THEN 1 ELSE 0 END)` and is equivalent for counting.

## 7. Performance Notes

- CASE/COALESCE/NULLIF are cheap per-row expressions; the real cost concern is **sargability**. Wrapping an indexed column in a `CASE` inside `WHERE` (e.g. `WHERE CASE WHEN … END = 'x'`) usually **defeats the index** — the planner can't use it. Keep the column bare on one side of the predicate.
- Put the **most selective / most common** WHEN first when branches have side effects or costly subexpressions; short-circuiting skips the rest.
- Use CASE's short-circuit to **guard expensive or unsafe calls**: `CASE WHEN divisor <> 0 THEN x/divisor END` avoids both the error and the computation.
- **Conditional aggregation** (`SUM(CASE …)`) does its pivot in a single scan — far cheaper than multiple filtered subqueries UNIONed together.
- `COALESCE(col, default)` in a `WHERE`/`JOIN` predicate is non-sargable; if you frequently filter "col or its default", consider an **expression index** (`CREATE INDEX ON t (COALESCE(col, 0))`) or store the default explicitly.
- `NULLIF(x, 0)` in a divisor is essentially free and safer than a `WHERE divisor <> 0` filter when you want to keep the zero-divisor rows (with NULL result) in the output.

## 8. Common Mistakes

1. ⚠️ Using **simple CASE to test NULL** (`CASE col WHEN NULL THEN …`) — never matches, since `col = NULL` is UNKNOWN. Fix: searched CASE with `WHEN col IS NULL`.
2. ⚠️ Omitting `ELSE` and being surprised by `NULL` for unmatched rows. Fix: add an explicit `ELSE` default.
3. ⚠️ **Mixed result types** across branches causing implicit-cast errors or precision loss. Fix: make all THEN/ELSE return the same type (cast explicitly).
4. ⚠️ Assuming `COALESCE` and vendor `NVL`/`IFNULL` are identical — the 2-arg helpers don't take N args and `NVL` always evaluates both arguments. Fix: use `COALESCE` for portability and lazy semantics.
5. ⚠️ Dividing without guarding the denominator → `division by zero` error. Fix: `x / NULLIF(divisor, 0)`.
6. ⚠️ `NULLIF(a, b)` confusion — it returns NULL when they're **equal**, not when unequal. Fix: remember `NULLIF(x, 0)` blanks out zeros.
7. ⚠️ Wrapping an indexed column in CASE/COALESCE inside `WHERE`, killing index use. Fix: keep the column bare; use an expression index if needed.
8. ⚠️ Counting with `COUNT(CASE WHEN c THEN 1 ELSE 0 END)` — COUNT counts the 0s too (non-NULL). Fix: `SUM(CASE … 1 ELSE 0)` or `COUNT(CASE WHEN c THEN 1 END)` (NULL when false) or `COUNT(*) FILTER (WHERE c)`.

## 9. Interview Questions

**Q: What is the difference between simple CASE and searched CASE?**
A: Simple CASE (`CASE expr WHEN v THEN …`) compares one expression for equality against each value; searched CASE (`CASE WHEN cond THEN …`) evaluates arbitrary boolean conditions. Searched is more general and is required for range tests, IS NULL, and compound conditions.

**Q: Why can't simple CASE test for NULL?**
A: Simple CASE uses equality (`expr = value`), and `expr = NULL` evaluates to UNKNOWN, never true — so a `WHEN NULL` branch never matches. Use searched CASE with `WHEN expr IS NULL`.

**Q: What does CASE return when no branch matches and there is no ELSE?**
A: NULL. An absent ELSE is treated as `ELSE NULL`.

**Q: What does COALESCE do and how is it better than NVL/IFNULL?**
A: COALESCE returns the first non-NULL of its arguments and accepts any number of them; it's ANSI-standard and portable. NVL (Oracle) and IFNULL (MySQL) take only two arguments and are vendor-specific; NVL also evaluates both arguments eagerly.

**Q: What does NULLIF(a, b) return, and what's its most common use?**
A: NULL when `a = b`, otherwise `a`. The classic use is `x / NULLIF(divisor, 0)` to turn a zero denominator into NULL and avoid a divide-by-zero error.

**Q: How do you compute a percentage safely when the denominator can be zero?**
A: Divide by `NULLIF(denominator, 0)`; the result is NULL for zero denominators instead of erroring. Optionally wrap in COALESCE to show 0 or a placeholder.

**Q: How do you count rows matching a condition using CASE?**
A: `SUM(CASE WHEN cond THEN 1 ELSE 0 END)` or `COUNT(CASE WHEN cond THEN 1 END)` (which is NULL when false, so uncounted). In PostgreSQL, `COUNT(*) FILTER (WHERE cond)` is the clean equivalent.

**Q: How is COALESCE related to CASE?**
A: The SQL standard defines COALESCE(a,b) as `CASE WHEN a IS NOT NULL THEN a ELSE b END`, and NULLIF(a,b) as `CASE WHEN a = b THEN NULL ELSE a END`. Both are syntactic sugar over CASE and share its lazy, first-match evaluation.

**Q: (Senior) How does CASE evaluation order affect correctness and performance?**
A: WHEN branches are evaluated top-to-bottom and short-circuit on the first true condition, so ordering matters when branches overlap (first match wins) and lets you guard expensive/unsafe expressions behind a cheaper condition, skipping them for guarded rows.

**Q: (Senior) Why can CASE or COALESCE in a WHERE clause hurt performance?**
A: Wrapping an indexed column in a function/expression makes the predicate non-sargable, so the optimizer can't use the index and falls back to a scan. Keep the column bare, or build a matching expression index.

**Q: (Senior) What is conditional aggregation and why is it efficient?**
A: Putting CASE inside aggregates — `SUM(CASE WHEN status='paid' THEN amount ELSE 0 END)` — pivots categories into columns in a single table scan, avoiding multiple correlated subqueries or UNIONed passes. It's the basis of manual pivot/cross-tab reports.

**Q: (Senior) What pitfalls arise from mixed return types across CASE branches?**
A: The engine unifies all THEN/ELSE results to one type; incompatible types raise a cast error, and silent coercions (int vs numeric vs text) can lose precision or change formatting. Cast branches explicitly to a common, intended type.

## 10. Practice

- [ ] Bucket `amount` into gold/silver/bronze tiers with a searched CASE.
- [ ] Provide a contact value falling back preferred → mobile → 'N/A' with COALESCE.
- [ ] Compute click-through rate as `clicks / NULLIF(impressions, 0)` and handle the NULL in output with COALESCE.
- [ ] Build a per-region pivot of paid vs refunded revenue using `SUM(CASE …)` (and the `FILTER` form in PostgreSQL).
- [ ] Rewrite a simple CASE that mishandles NULL into a searched CASE using `IS NULL`.

## 11. Cheat Sheet

> [!TIP]
> **CASE** = SQL if/else expression; **searched** (`WHEN cond`) is general, **simple** (`CASE expr WHEN v`) is equality-only and can't test NULL. First match wins; no ELSE → NULL; unify branch types.
> **COALESCE(a,b,…)** = first non-NULL (portable; beats 2-arg NVL/IFNULL). **NULLIF(a,b)** = NULL when equal — use `x / NULLIF(d, 0)` to dodge divide-by-zero.
> CASE **short-circuits** — guard costly/unsafe expressions. **SUM(CASE WHEN c THEN 1 ELSE 0 END)** / `COUNT(*) FILTER (WHERE c)` = conditional aggregation (pivot in one scan).
> Don't wrap indexed columns in CASE/COALESCE inside WHERE — it kills sargability.

**References:** PostgreSQL docs — "Conditional Expressions (CASE, COALESCE, NULLIF, GREATEST/LEAST)"; MySQL 8.0 Reference — "Flow Control Functions"; SQL:2016 standard — CASE expression; Use The Index, Luke — functions and sargability

---

*SQL Handbook — topic 15.*
