# 04 · Data Types, Casting & Basic Constraints

> **In one line:** The type you pick is a contract the engine enforces and the planner optimizes against — and one sloppy implicit cast can silently disable every index on the column.

---

## 1. Overview

A column's **data type** decides how values are stored, how much space they take, what operations are legal, and — critically — whether an index can be used against them. Choosing `TEXT` for a status flag, `FLOAT` for money, or `VARCHAR` for a timestamp is the kind of decision that looks harmless on day one and costs you correctness and performance on day one thousand.

Two forces meet in this topic. First, **casting**: SQL will sometimes convert types *implicitly* to make a comparison work, and that convenience can quietly turn a sargable predicate into a full scan. Second, **constraints** (`NOT NULL`, `DEFAULT`, `CHECK`): the schema-level guarantees that keep bad data out so your application doesn't have to defend against it on every read.

This page covers the core type families, the difference between implicit and explicit casts (and why implicit casts kill index use), and the everyday constraints that make a table trustworthy.

## 2. Core Concepts

- **Type families** — numeric (`INT`, `BIGINT`, `NUMERIC`), text (`CHAR`, `VARCHAR`, `TEXT`), temporal (`DATE`, `TIME`, `TIMESTAMP`, `TIMESTAMPTZ`), boolean, and `UUID`.
- **Exact vs approximate numeric** — `NUMERIC/DECIMAL` is exact (use for money); `FLOAT/DOUBLE` is binary approximate (rounding error).
- **`TIMESTAMPTZ` vs `TIMESTAMP`** — `TIMESTAMPTZ` stores an absolute instant (UTC); `TIMESTAMP` is a "wall clock" with no zone — a frequent bug source.
- **Explicit cast** — `CAST(x AS type)` or `x::type` (PostgreSQL); you control when and how conversion happens.
- **Implicit cast** — the engine converts silently to compare mismatched types; convenient but can make predicates **non-sargable**.
- **Sargability & casts** — a cast applied to the *column* side (`col::text = '5'`) disables the index; a cast on the *literal* side keeps it.
- **`NOT NULL`** — forbids missing values; enables optimizations and clearer semantics.
- **`DEFAULT`** — supplies a value when none is given (`DEFAULT now()`, `DEFAULT 0`).
- **`CHECK`** — a boolean invariant enforced on every write (`CHECK (price >= 0)`); NULL passes a CHECK (predicate is UNKNOWN, not FALSE).
- **Precise typing pays** — narrow, correct types shrink rows, improve cache hit rates, and let the planner estimate better.

## 3. Syntax & Examples

```sql
-- A table with well-chosen types and constraints
CREATE TABLE payments (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  BIGINT        NOT NULL,
  amount      NUMERIC(12,2) NOT NULL CHECK (amount > 0),   -- exact money
  currency    CHAR(3)       NOT NULL DEFAULT 'USD',
  status      VARCHAR(16)   NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','settled','failed')),
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Explicit casts: you decide the conversion
SELECT '2026-07-02'::date;                 -- PostgreSQL shorthand
SELECT CAST('42' AS INTEGER) + 1;          -- standard SQL

-- SARGABLE: literal is cast to the column's type; index on account_id usable
SELECT * FROM payments WHERE account_id = 12345;

-- NON-SARGABLE: casting the COLUMN forces a per-row conversion; index unused
SELECT * FROM payments WHERE account_id::text = '12345';

-- Safe conversion patterns
SELECT amount::float FROM payments;        -- lossy on purpose
SELECT NULLIF(currency, '')::char(3);
```

## 4. Sample Data & Results

Table `payments` (abbreviated):

| id     | account_id | amount   | currency | status  | created_at            |
|--------|------------|----------|----------|---------|-----------------------|
| a1..   | 12345      | 19.99    | USD      | settled | 2026-07-01 09:12:00+00 |
| b2..   | 12345      | 5.00     | USD      | pending | 2026-07-02 08:00:00+00 |
| c3..   | 98765      | 250.00   | EUR      | settled | 2026-07-02 10:30:00+00 |

Query (sargable — cast on the literal, index on `account_id` used):

```sql
SELECT id, amount, status
FROM payments
WHERE account_id = 12345 AND status = 'settled';
```

Result:

| id   | amount | status  |
|------|--------|---------|
| a1.. | 19.99  | settled |

Constraint in action — this write is rejected before it ever touches the table:

```sql
INSERT INTO payments (account_id, amount, status)
VALUES (12345, -3.00, 'refunded');
-- ERROR: violates CHECK (amount > 0) AND CHECK (status IN (...))
```

## 5. Under the Hood

An index is a B-tree sorted by the column's *native* type. A predicate can seek that tree only if both sides are comparable in that type without transforming the column. When you cast the **column**, the engine must compute the cast for every row *before* it can compare — so it can't seek the index and falls back to a full scan with a per-row function.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah4" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <text x="180" y="22" text-anchor="middle" fill="#059669">Cast the LITERAL → index seek</text>
  <text x="540" y="22" text-anchor="middle" fill="#b91c1c">Cast the COLUMN → full scan</text>

  <rect x="60" y="40" width="240" height="30" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="180" y="59" text-anchor="middle" fill="#1e293b">account_id = 12345</text>
  <line x1="180" y1="70" x2="180" y2="100" stroke="#475569" marker-end="url(#ah4)"/>
  <rect x="60" y="102" width="240" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="121" text-anchor="middle" fill="#1e293b">'12345' cast to BIGINT once</text>
  <line x1="180" y1="132" x2="180" y2="162" stroke="#475569" marker-end="url(#ah4)"/>
  <rect x="60" y="164" width="240" height="30" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="180" y="183" text-anchor="middle" fill="#1e293b">B-tree SEEK on account_id</text>
  <text x="180" y="224" text-anchor="middle" fill="#059669">O(log n): column untouched</text>

  <rect x="420" y="40" width="240" height="30" rx="8" fill="#fdecea" stroke="#b91c1c"/>
  <text x="540" y="59" text-anchor="middle" fill="#1e293b">account_id::text = '12345'</text>
  <line x1="540" y1="70" x2="540" y2="100" stroke="#475569" marker-end="url(#ah4)"/>
  <rect x="420" y="102" width="240" height="30" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="540" y="121" text-anchor="middle" fill="#1e293b">cast EVERY row's account_id</text>
  <line x1="540" y1="132" x2="540" y2="162" stroke="#475569" marker-end="url(#ah4)"/>
  <rect x="420" y="164" width="240" height="30" rx="8" fill="#fdecea" stroke="#b91c1c"/>
  <text x="540" y="183" text-anchor="middle" fill="#1e293b">SEQ SCAN + per-row cast</text>
  <text x="540" y="224" text-anchor="middle" fill="#b91c1c">O(n): index on account_id is dead</text>

  <text x="360" y="270" text-anchor="middle" fill="#64748b">Rule: never transform the indexed column. Move the conversion to the constant.</text>
  <text x="360" y="294" text-anchor="middle" fill="#64748b">Same principle as WHERE UPPER(email)=… or WHERE amount+0=… — the index can't help.</text>
</svg>
```

The classic real-world version: a `VARCHAR` id column compared to a numeric literal (`WHERE id = 42`). Some engines (e.g. MySQL) implicitly cast the *string column* to a number, silently killing the index and — worse — sometimes returning wrong rows because `'042abc'` casts to `42`. The fix is to store the right type in the first place, or compare like-with-like (`id = '42'`).

## 6. Variations & Trade-offs

| Type | Use for | Avoid for | Notes |
|------|---------|-----------|-------|
| `INT` / `BIGINT` | counters, ids, FKs | money | 4 vs 8 bytes; overflow at ~2.1B for INT |
| `NUMERIC(p,s)` | money, exact decimals | hot math on huge sets | exact but slower than binary types |
| `FLOAT` / `DOUBLE` | scientific, ratios | money, equality tests | rounding error: `0.1+0.2 ≠ 0.3` |
| `VARCHAR(n)` / `TEXT` | names, notes | fixed codes better as `CHAR`/enum | PG: `TEXT` and `VARCHAR` perform the same |
| `CHAR(n)` | fixed-width codes | variable text | space-padded to n |
| `DATE` / `TIMESTAMPTZ` | dates, instants | storing dates as strings | `TIMESTAMPTZ` normalizes to UTC |
| `BOOLEAN` | true/false flags | tri-state (use nullable or enum) | MySQL: `TINYINT(1)` alias |
| `UUID` | distributed ids | sequential hot inserts | 16 bytes; random UUIDv4 hurts index locality |

**Dialect notes:** PostgreSQL has a native `BOOLEAN` and `UUID`; MySQL emulates boolean as `TINYINT(1)` and (pre-8.0) stores UUIDs as `CHAR(36)` or `BINARY(16)`. `NUMERIC` and `DECIMAL` are synonyms. `TIMESTAMPTZ` is PostgreSQL's zone-aware type; MySQL's `TIMESTAMP` is UTC-normalized while `DATETIME` is zone-naive.

## 7. Performance Notes

- **Narrower types = smaller rows = more rows per page = better cache/IO.** An unnecessary `BIGINT` or padded `CHAR(255)` bloats every row and every index entry.
- **Implicit casts on the column side are silent index killers.** Watch for FK columns typed differently on each side of a join — the join predicate gets an implicit cast and can't use the index. Keep join keys the *same type*.
- **`NUMERIC` math is slower than integer/float math.** For money that's the right trade; for scientific bulk math, `DOUBLE` may be justified.
- **Random `UUID` (v4) primary keys** scatter inserts across the B-tree, hurting locality and cache; consider `BIGINT` identity, or time-ordered UUIDv7 for insert locality.
- **`NOT NULL` helps the planner** — it can skip null-handling branches and use certain optimizations; some engines store nullable columns with extra bookkeeping.
- Verify with `EXPLAIN`: an unexpected `Seq Scan` plus a cast/function in the filter is the fingerprint of a non-sargable type mismatch.

## 8. Common Mistakes

1. ⚠️ **`FLOAT` for money.** Rounding errors corrupt totals. Fix: `NUMERIC(p,s)`.
2. ⚠️ **Casting the indexed column** (`col::text = ...`, `WHERE id = 42` on a text column). Kills the index. Fix: compare same types; cast the literal, not the column.
3. ⚠️ **Storing dates/timestamps as strings.** Breaks ordering, ranges, and math. Fix: `DATE`/`TIMESTAMPTZ`.
4. ⚠️ **`TIMESTAMP` where you meant `TIMESTAMPTZ`.** Loses the zone; instants drift. Fix: store absolute time as `TIMESTAMPTZ` (UTC).
5. ⚠️ **Mismatched FK/join key types.** Forces implicit casts and full scans on joins. Fix: identical types on both sides.
6. ⚠️ **Relying on `CHECK` to reject NULLs.** A CHECK passes when its predicate is UNKNOWN, so NULL slips through. Fix: add `NOT NULL` explicitly.
7. ⚠️ **Over-wide `VARCHAR(255)`/`CHAR` everywhere.** Wastes space and misleads readers. Fix: size to the real domain, or use `TEXT`/enum.
8. ⚠️ **`DEFAULT` expecting it to fix existing rows.** `DEFAULT` only applies to new rows that omit the column. Fix: backfill existing rows with an UPDATE.

## 9. Interview Questions

**Q: Why should money use NUMERIC/DECIMAL rather than FLOAT?**
A: FLOAT/DOUBLE are binary approximations, so values like 0.1 can't be stored exactly and sums accumulate rounding error. NUMERIC(p,s) stores exact decimal values, which is required for financial correctness.

**Q: What is the difference between an implicit and an explicit cast?**
A: An explicit cast is one you write (`CAST(x AS t)` or `x::t`); an implicit cast is inserted automatically by the engine to reconcile mismatched types in a comparison or expression.

**Q: How can an implicit cast disable an index?**
A: If the engine casts the indexed column (not the literal) to match the other side, it must transform every row before comparing, so it can't seek the B-tree and falls back to a full scan.

**Q: How do you keep a predicate sargable when types differ?**
A: Convert the constant to the column's type, not the reverse — compare `account_id = 12345` (literal cast) rather than `account_id::text = '12345'` (column cast). Better still, store the correct type so no cast is needed.

**Q: TIMESTAMP vs TIMESTAMPTZ — which and why?**
A: TIMESTAMPTZ represents an absolute instant normalized to UTC and is safe across time zones; plain TIMESTAMP is a zone-naive wall-clock value that silently misinterprets across zones. Prefer TIMESTAMPTZ for event times.

**Q: Does a CHECK constraint reject NULLs?**
A: No. A CHECK fails only when its predicate evaluates to FALSE; with a NULL the predicate is UNKNOWN, which passes. Use NOT NULL to forbid missing values.

**Q: What does DEFAULT actually do?**
A: It supplies a value only for INSERTs that omit the column; it does not retroactively populate existing rows, and an explicit NULL still overrides it unless NOT NULL blocks that.

**Q: Why can CHAR(n) waste space compared to VARCHAR?**
A: CHAR is fixed width and space-pads every value to n characters, so short values still consume the full length; VARCHAR/TEXT store only the actual bytes (plus a small length header).

**Q: What's the risk of a random UUIDv4 primary key at scale?**
A: Its randomness scatters inserts across the whole index, hurting page locality and cache hit rates and increasing write amplification. A monotonic key (BIGINT identity or UUIDv7) restores insert locality.

**Q: You join `orders.customer_id BIGINT` to `legacy.cust_id VARCHAR`. What goes wrong?**
A: The engine implicitly casts one side per row to compare, defeating the index on the join key and forcing a scan/hash of the whole table; it can also mismatch values (e.g. '007' vs 7). Fix by aligning the column types.

**Q: (Senior) Why does `NOT NULL` sometimes let the planner produce a better plan?**
A: Knowing a column can't be NULL lets the optimizer drop null-handling logic, simplify predicates, and safely use certain transformations (e.g. converting subqueries or eliminating IS NULL branches), improving estimates and enabling index-only paths.

## 10. Practice

- [ ] Design a `transactions` table choosing precise types for id, amount, currency, and event time, with appropriate constraints.
- [ ] Reproduce an index becoming unused by casting the column, then fix it by casting the literal; confirm with `EXPLAIN`.
- [ ] Show that a `CHECK (score BETWEEN 0 AND 100)` lets a NULL through, then add `NOT NULL`.
- [ ] Demonstrate `0.1 + 0.2 <> 0.3` with FLOAT and exact equality with NUMERIC.
- [ ] Add a `DEFAULT now()` column and show it does not backfill existing rows until you UPDATE them.

## 11. Cheat Sheet

> [!TIP]
> **Pick precise types:** NUMERIC for money (never FLOAT), TIMESTAMPTZ for instants, native BOOLEAN/UUID, and size text to the real domain.
> **Casting rule:** never transform the indexed column — cast the *literal*, keep join keys the *same type*, or the index dies (Seq Scan + per-row cast).
> **Constraints:** `NOT NULL` forbids missing values (CHECK does *not* — NULL passes UNKNOWN), `DEFAULT` fills only new rows, `CHECK` enforces invariants on every write. Narrow rows = better cache and estimates.

**References:** PostgreSQL docs — Data Types & Type Conversion; MySQL — Data Types & Type Conversion in Expression Evaluation; Use The Index, Luke — "Types" / functions & sargability; SQL Performance Explained (Winand)

---

*SQL Handbook — topic 04.*
