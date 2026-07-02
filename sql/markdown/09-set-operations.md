# 09 · UNION, INTERSECT & EXCEPT

> **In one line:** Combine the result sets of two queries by row-wise set algebra — union, intersection, and difference.

---

## 1. Overview

Where a `JOIN` stitches tables **side by side** (adding columns), a **set operation** stacks result sets **on top of each other** (adding rows) and then applies set logic. The three standard operators map directly to Venn-diagram algebra: **UNION** (A ∪ B), **INTERSECT** (A ∩ B), and **EXCEPT** / Oracle's **MINUS** (A − B).

They operate on two *SELECT results*, not on tables, so each side can have its own filters, joins, and expressions — the only requirement is that both sides return the **same number of columns with compatible types**. The engine lines the columns up **by position**, not by name.

You reach for set operations to merge like-shaped rows from different sources ("active users this month `UNION` last month"), to find overlap ("customers who bought *and* returned", `INTERSECT`), or to find a difference ("products never ordered", `EXCEPT`). They often express in one clean statement what would otherwise be an awkward outer join with `NULL` checks.

The critical distinction — and a favorite interview trap — is **UNION vs UNION ALL**: plain `UNION` removes duplicates (paying a sort/hash cost); `UNION ALL` keeps everything and is much cheaper.

## 2. Core Concepts

- **UNION** = combine and **remove duplicate rows**. Requires a dedup pass (sort or hash) → extra cost.
- **UNION ALL** = combine and **keep all rows**, duplicates included. No dedup — fastest; use it whenever duplicates are impossible or acceptable.
- **INTERSECT** = rows present in **both** inputs (distinct by default).
- **EXCEPT** (Postgres/SQL Server/SQLite) / **MINUS** (Oracle) = rows in the **first** input but **not** the second.
- **Positional, type-compatible columns.** Both sides need equal column counts; types must be coercible to a common type. Column **names come from the first SELECT**.
- **Duplicates by default:** UNION/INTERSECT/EXCEPT are **distinct** operations; add `ALL` (`UNION ALL`, `INTERSECT ALL`, `EXCEPT ALL`) to use bag/multiset semantics that count duplicates.
- **NULLs are treated as equal** for de-duplication in set operations (unlike `=`, which yields UNKNOWN) — two NULL rows collapse into one under UNION.
- **One ORDER BY, at the end.** `ORDER BY` (and `LIMIT`) apply to the **combined** result, placed after the last SELECT; branch-level ordering is meaningless.
- **Precedence:** `INTERSECT` binds tighter than `UNION`/`EXCEPT`; use parentheses to force evaluation order.

## 3. Syntax & Examples

```sql
-- UNION ALL: stack two months, keep duplicates (cheap)
SELECT user_id FROM logins_jan
UNION ALL
SELECT user_id FROM logins_feb;

-- UNION: distinct set of users across both months (dedup pass)
SELECT user_id FROM logins_jan
UNION
SELECT user_id FROM logins_feb;
```

```sql
-- INTERSECT: users who logged in BOTH months
SELECT user_id FROM logins_jan
INTERSECT
SELECT user_id FROM logins_feb;

-- EXCEPT / MINUS: users active in Jan but NOT in Feb (churned)
SELECT user_id FROM logins_jan
EXCEPT
SELECT user_id FROM logins_feb;   -- Oracle: MINUS
```

```sql
-- ORDER BY applies to the whole combined result, at the very end
SELECT id, name, 'active'   AS bucket FROM active_users
UNION ALL
SELECT id, name, 'inactive' AS bucket FROM inactive_users
ORDER BY name;        -- one ORDER BY, after the last SELECT

-- Precedence: INTERSECT binds before UNION — parenthesize to be explicit
(SELECT id FROM a UNION SELECT id FROM b)
INTERSECT
SELECT id FROM c;
```

## 4. Sample Data & Results

Input — `logins_jan` and `logins_feb`:

| logins_jan.user_id |
|-------------------:|
| 1 |
| 2 |
| 2 |
| 3 |

| logins_feb.user_id |
|-------------------:|
| 2 |
| 3 |
| 4 |

Results:

| operation | result rows | meaning |
|-----------|-------------|---------|
| `UNION ALL` | 1, 2, 2, 3, 2, 3, 4 | everything stacked, dups kept |
| `UNION` | 1, 2, 3, 4 | distinct union |
| `INTERSECT` | 2, 3 | in both months |
| `EXCEPT` (jan − feb) | 1 | active in Jan, gone in Feb (churned) |

Note how `UNION` collapsed the two `2`s from January into one, while `UNION ALL` preserved them — the dedup is the whole cost difference.

## 5. Under the Hood

`UNION ALL` is essentially free: the executor **appends** one child stream after the other (PostgreSQL `Append`, no extra work). `UNION`, `INTERSECT`, and `EXCEPT` must **deduplicate**, so the planner inserts a **HashSetOp/HashAggregate** or a **sort + unique** pass over the combined rows — the same machinery as `SELECT DISTINCT`.

```svg
<svg viewBox="0 0 640 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="320" y="22" text-anchor="middle" fill="#1e293b" font-weight="bold">Set operations on result sets A and B</text>

  <!-- UNION -->
  <text x="110" y="58" text-anchor="middle" fill="#1e293b" font-weight="bold">UNION (A ∪ B)</text>
  <circle cx="90" cy="110" r="42" fill="#eff6ff" stroke="#2563eb" fill-opacity="0.7"/>
  <circle cx="130" cy="110" r="42" fill="#ecfdf5" stroke="#059669" fill-opacity="0.7"/>
  <text x="70" y="114" text-anchor="middle" fill="#1e293b">A</text>
  <text x="150" y="114" text-anchor="middle" fill="#1e293b">B</text>
  <text x="110" y="170" text-anchor="middle" fill="#64748b">all, distinct</text>

  <!-- INTERSECT -->
  <text x="320" y="58" text-anchor="middle" fill="#1e293b" font-weight="bold">INTERSECT (A ∩ B)</text>
  <circle cx="300" cy="110" r="42" fill="#eff6ff" stroke="#2563eb" fill-opacity="0.35"/>
  <circle cx="340" cy="110" r="42" fill="#ecfdf5" stroke="#059669" fill-opacity="0.35"/>
  <path d="M320,74 A42,42 0 0,1 320,146 A42,42 0 0,1 320,74 Z" fill="#d97706" fill-opacity="0.5" stroke="#d97706"/>
  <text x="320" y="170" text-anchor="middle" fill="#64748b">overlap only</text>

  <!-- EXCEPT -->
  <text x="530" y="58" text-anchor="middle" fill="#1e293b" font-weight="bold">EXCEPT (A − B)</text>
  <circle cx="510" cy="110" r="42" fill="#eff6ff" stroke="#2563eb" fill-opacity="0.7"/>
  <circle cx="550" cy="110" r="42" fill="#ffffff" stroke="#059669"/>
  <text x="492" y="114" text-anchor="middle" fill="#1e293b">A</text>
  <text x="530" y="170" text-anchor="middle" fill="#64748b">A minus overlap</text>

  <!-- plan -->
  <rect x="60" y="205" width="150" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="135" y="229" text-anchor="middle" fill="#1e293b">Scan A</text>
  <rect x="430" y="205" width="150" height="40" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="505" y="229" text-anchor="middle" fill="#1e293b">Scan B</text>

  <rect x="245" y="205" width="150" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="320" y="223" text-anchor="middle" fill="#1e293b">Append</text>
  <text x="320" y="239" text-anchor="middle" fill="#64748b">(UNION ALL stops here)</text>

  <line x1="210" y1="225" x2="243" y2="225" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="430" y1="225" x2="397" y2="225" stroke="#475569" marker-end="url(#a2)"/>

  <line x1="320" y1="245" x2="320" y2="272" stroke="#475569" marker-end="url(#a2)"/>
  <rect x="215" y="274" width="210" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="320" y="298" text-anchor="middle" fill="#b91c1c">HashAggregate / Sort+Unique (dedup)</text>
  <text x="320" y="332" text-anchor="middle" fill="#64748b">UNION/INTERSECT/EXCEPT pay this extra dedup pass; UNION ALL does not.</text>
</svg>
```

## 6. Variations & Trade-offs

| Operator | Keeps duplicates? | Cost | Equivalent join/anti-join |
|----------|-------------------|------|---------------------------|
| `UNION ALL` | yes | cheapest (append only) | — (concatenation) |
| `UNION` | no (distinct) | append + dedup | — |
| `INTERSECT` | no | append + dedup | semi-join / `IN` |
| `INTERSECT ALL` | multiset min-count | dedup-ish | — |
| `EXCEPT` / `MINUS` | no | append + dedup | anti-join / `NOT IN`/`NOT EXISTS` |

**Set ops vs joins:** `A INTERSECT B` on a key is equivalent to a **semi-join** (`WHERE key IN (SELECT ...)`); `A EXCEPT B` is an **anti-join** (`NOT EXISTS`). Set operators compare **entire rows** (all selected columns), which is cleaner for "same-shape" data but less flexible than a join when you need extra columns from B. Joins can also be indexed more directly. Choose set ops for readability on identical schemas; choose joins/`EXISTS` when you need columns from both sides or index-driven lookups.

**Dialects:** `EXCEPT` is standard (PostgreSQL, SQL Server, SQLite); Oracle spells it `MINUS`. MySQL added `INTERSECT`/`EXCEPT` in 8.0.31; older MySQL emulates them with joins/`EXISTS`.

## 7. Performance Notes

- **Default to `UNION ALL`** and only use `UNION` when duplicates are genuinely possible and unwanted. The dedup pass is a full sort or hash over the combined rows — often the dominant cost.
- If both branches are already distinct on disjoint data (e.g., partitioned by month), `UNION` and `UNION ALL` return the same rows but `UNION` still *pays* for a needless dedup — use `ALL`.
- `INTERSECT`/`EXCEPT` on indexed keys can be rewritten as `EXISTS`/`NOT EXISTS`, which often produce an **index-driven semi/anti-join** and avoid materializing both sides — check `EXPLAIN` both ways.
- `ORDER BY` on the combined result is applied **once at the end**; it cannot exploit a per-branch index order, so large sorted unions may need a top-level sort. A `UNION ALL` of two index-ordered branches still re-sorts.
- Watch memory: the dedup HashAggregate can spill to disk (`Batches > 1` in `EXPLAIN ANALYZE`) for large inputs — raise `work_mem` or switch to `ALL`.
- **`NOT IN` vs `EXCEPT`/`NOT EXISTS`:** `NOT IN` breaks silently when the subquery contains `NULL`. `EXCEPT` and `NOT EXISTS` handle NULL correctly — prefer them.

## 8. Common Mistakes

1. ⚠️ Using `UNION` when you meant `UNION ALL`, paying for an unnecessary dedup on data that has no duplicates. Fix: use `UNION ALL` unless you specifically need distinct rows.
2. ⚠️ Mismatched column counts or incompatible types between branches. Fix: align each SELECT to the same column count and coercible types (cast if needed).
3. ⚠️ Assuming columns line up **by name** — they line up **by position**. Fix: order the SELECT lists identically; rely on the first SELECT for output names.
4. ⚠️ Putting `ORDER BY` inside a branch. Fix: a single `ORDER BY` after the last SELECT applies to the whole result.
5. ⚠️ Expecting `INTERSECT`/`EXCEPT` to keep duplicates. Fix: they are distinct by default; add `ALL` for multiset semantics.
6. ⚠️ Forgetting Oracle uses `MINUS`, not `EXCEPT`. Fix: use the dialect's keyword.
7. ⚠️ Misreading precedence — `A UNION B INTERSECT C` runs `B INTERSECT C` first. Fix: parenthesize to make evaluation order explicit.
8. ⚠️ Replacing `EXCEPT` with `NOT IN` over a nullable column and getting empty results. Fix: use `EXCEPT` or `NOT EXISTS`, which are NULL-safe.

## 9. Interview Questions

**Q: What is the difference between UNION and UNION ALL?**
A: UNION combines both result sets and removes duplicate rows (a dedup sort/hash pass); UNION ALL concatenates them and keeps every row. UNION ALL is cheaper — prefer it unless you specifically need distinct rows.

**Q: How are columns matched between the two SELECTs in a set operation?**
A: By position, not by name. Both sides must have the same number of columns and type-compatible columns; the output column names come from the first SELECT.

**Q: What does INTERSECT return, and does it keep duplicates?**
A: Rows present in both result sets. By default it returns distinct rows; INTERSECT ALL uses multiset semantics returning the minimum per-row duplicate count.

**Q: What is EXCEPT and what is its Oracle equivalent?**
A: EXCEPT returns rows in the first query's result that are not in the second (set difference). Oracle spells it MINUS; the semantics are the same.

**Q: How do NULLs behave in set operations?**
A: Set operations treat NULLs as equal for de-duplication, so two NULL rows collapse into one under UNION and match under INTERSECT — unlike `=`, which returns UNKNOWN for NULL comparisons.

**Q: Where does ORDER BY go in a set operation and what does it apply to?**
A: Once, after the final SELECT, applying to the combined result. Ordering inside an individual branch is not allowed (or is meaningless) for the overall output.

**Q: When would you use a set operation instead of a join?**
A: When both inputs share the same shape and you want row-level set logic — merging like rows (UNION), overlap (INTERSECT ≈ semi-join), or difference (EXCEPT ≈ anti-join). Joins are better when you need extra columns from the other side or index-driven lookups.

**Q: Rewrite `A EXCEPT B` and `A INTERSECT B` using EXISTS.**
A: `A EXCEPT B` → `SELECT ... FROM A WHERE NOT EXISTS (SELECT 1 FROM B WHERE B.key = A.key)`; `A INTERSECT B` → the same with `EXISTS`. These are NULL-safe anti-/semi-joins and often index-driven.

**Q: (Senior) Why is UNION ALL faster, and what does EXPLAIN show for each?**
A: UNION ALL is just an Append node — it streams one child then the other. UNION adds a HashAggregate or Sort+Unique on top to dedup, which can spill to disk if it exceeds work_mem. EXPLAIN shows the extra aggregate/sort node for UNION.

**Q: (Senior) What is the precedence among UNION, INTERSECT, and EXCEPT?**
A: INTERSECT binds tighter than UNION and EXCEPT (which are left-associative and equal precedence). So `A UNION B INTERSECT C` evaluates `B INTERSECT C` first. Parenthesize to control it explicitly.

**Q: (Senior) Two branches are each ordered by an index. Does UNION ALL preserve that order?**
A: No — Append concatenates the streams but does not merge them, and set semantics don't guarantee order anyway. You need an explicit top-level ORDER BY, which forces a sort over the combined output.

**Q: (Senior) Why prefer EXCEPT/NOT EXISTS over NOT IN for a difference?**
A: NOT IN returns no rows (or wrong rows) when the subquery yields any NULL, because `x NOT IN (…, NULL, …)` evaluates to UNKNOWN. EXCEPT and NOT EXISTS handle NULLs correctly and are the safe choice.

## 10. Practice

- [ ] List all distinct product IDs appearing in either `orders_2023` or `orders_2024` using UNION.
- [ ] Find customers who purchased in both years with INTERSECT, then rewrite it with EXISTS.
- [ ] Find products sold in 2023 but not 2024 with EXCEPT, then with NOT EXISTS — compare EXPLAIN.
- [ ] Show why swapping UNION for UNION ALL changes the row count on a table with duplicate keys.
- [ ] Combine active and inactive user lists with a literal `bucket` column and ORDER BY name across the whole result.

## 11. Cheat Sheet

> [!TIP]
> **UNION** = A ∪ B distinct · **UNION ALL** = A ∪ B keep dups (cheapest, default choice) · **INTERSECT** = A ∩ B · **EXCEPT**/**MINUS** = A − B.
> Columns match **by position**; equal count + compatible types; names come from the first SELECT.
> All except `ALL` variants **dedup** (sort/hash) — that's the cost. One **ORDER BY** at the very end applies to the combined result.
> NULLs compare **equal** for dedup. INTERSECT ≈ semi-join, EXCEPT ≈ anti-join — rewrite with EXISTS/NOT EXISTS (NULL-safe, index-driven). INTERSECT binds tighter than UNION/EXCEPT.

**References:** PostgreSQL docs — "Combining Queries (UNION, INTERSECT, EXCEPT)"; MySQL 8.0 Reference — "Set Operations"; Oracle SQL Language Reference — "The UNION [ALL], INTERSECT, MINUS Operators"

---

*SQL Handbook — topic 09.*
