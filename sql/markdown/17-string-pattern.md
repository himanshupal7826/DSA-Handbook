# 17 · String Functions & Pattern Matching

> **In one line:** Concatenate, slice, clean, and match text — and know which patterns an index can serve and which force a full scan.

---

## 1. Overview

Text is everywhere in real schemas: names, emails, SKUs, log lines, addresses. **String functions** cover the everyday work — joining, measuring, slicing, trimming, and normalizing case — while **pattern matching** (`LIKE`, `ILIKE`, regex, `SIMILAR TO`) answers "does this value look like X?".

The senior lens here is not syntax but **sargability**: whether a predicate can use a B-tree index. `col LIKE 'abc%'` (anchored prefix) can range-scan an index; `col LIKE '%abc'` (leading wildcard) and most regex predicates cannot, and degrade to a full scan. Knowing this line divides a query that answers in milliseconds from one that reads the whole table.

The second trap is **collation and case sensitivity**. Whether `'A' = 'a'`, how strings sort, and whether `ILIKE` or `LOWER()` is the right tool all depend on the column's collation — which differs sharply between PostgreSQL (case-sensitive by default) and MySQL (case-insensitive `ci` collations by default).

You reach for these tools constantly, but the ones that touch large tables — search boxes, prefix lookups, "contains" filters — are exactly where indexing strategy decides performance.

## 2. Core Concepts

- **Concatenation** — SQL-standard `a || b` (PostgreSQL); MySQL uses `CONCAT(a, b)` (`||` is logical OR there unless `PIPES_AS_CONCAT`). `CONCAT` is null-tolerant; `||` yields NULL if any operand is NULL.
- **Length** — `LENGTH()` counts characters in PostgreSQL, **bytes** in MySQL (use `CHAR_LENGTH()` there for characters). Multibyte text makes the distinction matter.
- **Slicing** — `SUBSTRING(s FROM p FOR n)` / `SUBSTR(s, p, n)`; `LEFT`/`RIGHT`; `POSITION(sub IN s)` (or `STRPOS`/`INSTR`) to locate.
- **Cleaning** — `TRIM`/`LTRIM`/`RTRIM`, `UPPER`/`LOWER`, `REPLACE(s, from, to)`, `LPAD`/`RPAD`.
- **`LIKE` / `ILIKE`** — `%` = any run, `_` = one char; `ILIKE` is PostgreSQL's case-insensitive `LIKE`. `ESCAPE` handles literal `%`/`_`.
- **Regex** — PostgreSQL `~` (match), `~*` (case-insensitive), `!~`; `SIMILAR TO` is SQL-standard regex-ish; MySQL uses `REGEXP`/`RLIKE`.
- **Splitting** — `split_part(s, delim, n)` grabs the nth field; `string_to_array(s, delim)` → array; `regexp_split_to_table` explodes to rows.
- **Collation & case** — the collation on a column/DB governs equality and sort order; case sensitivity is a collation property, not a function.
- **Sargability** — anchored prefix `LIKE 'x%'` is index-usable; leading `%` and arbitrary regex are not, unless you use a trigram (GIN) index.

## 3. Syntax & Examples

```sql
-- Concatenate + normalize
SELECT first_name || ' ' || last_name AS full_name,          -- PostgreSQL
       CONCAT(first_name, ' ', last_name) AS full_name_my     -- MySQL / null-safe
FROM users;
```

```sql
-- Measure, slice, locate
SELECT email,
       LENGTH(email)                       AS len,            -- chars (PG) / bytes (MySQL)
       SUBSTRING(email FROM 1 FOR 3)        AS first3,
       POSITION('@' IN email)              AS at_pos,
       SUBSTRING(email FROM POSITION('@' IN email) + 1) AS domain
FROM users;
```

```sql
-- Clean: trim, case-fold, replace
SELECT TRIM(BOTH ' ' FROM raw)             AS trimmed,
       LOWER(REPLACE(sku, '-', ''))        AS norm_sku
FROM products;
```

```sql
-- Pattern matching: LIKE vs ILIKE vs regex
SELECT * FROM users WHERE email LIKE 'admin%';     -- anchored prefix (SARGABLE)
SELECT * FROM users WHERE name  ILIKE '%smith%';   -- case-insensitive contains (SCAN)
SELECT * FROM users WHERE phone ~ '^\+?[0-9]{10,}$';        -- regex validate (SCAN)
SELECT * FROM users WHERE code SIMILAR TO '[A-Z]{2}[0-9]{4}'; -- SQL-standard regex
```

```sql
-- Split a delimited field
SELECT split_part('2026-07-02', '-', 2) AS month;          -- '07'
SELECT string_to_array('a,b,c', ',')     AS arr;           -- {a,b,c}
SELECT unnest(string_to_array('a,b,c', ',')) AS tag;       -- 3 rows
```

## 4. Sample Data & Results

Input — `users`:

| id | name          | email                |
|----|---------------|----------------------|
| 1  | Ada Lovelace  | ada@math.org         |
| 2  | Alan Turing   | alan@BLETCHLEY.uk    |
| 3  | Grace Hopper  |  grace@navy.mil      |

Query:

```sql
SELECT id,
       UPPER(SUBSTRING(name FROM 1 FOR 1)) AS initial,
       LOWER(TRIM(email))                  AS clean_email,
       SUBSTRING(email FROM POSITION('@' IN email) + 1) AS domain
FROM users;
```

Result →

| id | initial | clean_email       | domain        |
|----|---------|-------------------|---------------|
| 1  | A       | ada@math.org      | math.org      |
| 2  | A       | alan@bletchley.uk | BLETCHLEY.uk  |
| 3  | G       | grace@navy.mil    | navy.mil      |

Note `clean_email` is trimmed and lowercased, but `domain` (sliced from the raw column) keeps `BLETCHLEY.uk`'s original case — case-folding happens only where you apply it.

## 5. Under the Hood

A B-tree stores strings **sorted by collation**. An anchored `LIKE 'admin%'` translates to a range scan `code >= 'admin' AND code < 'admio'` — the engine descends to the first matching key and reads a contiguous run. A **leading wildcard** `LIKE '%smith%'` has no prefix to seek on, so the B-tree is useless and the engine scans every row.

```svg
<svg viewBox="0 0 640 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="#475569"/>
    </marker>
  </defs>
  <!-- sargable side -->
  <rect x="20" y="30" width="280" height="240" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="160" y="52" text-anchor="middle" fill="#1e293b" font-weight="600">LIKE 'admin%'  (SARGABLE)</text>
  <rect x="120" y="70" width="80" height="26" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="160" y="87" text-anchor="middle" fill="#1e293b">root</text>
  <line x1="160" y1="96" x2="90" y2="120" stroke="#475569" marker-end="url(#arr)"/>
  <line x1="160" y1="96" x2="230" y2="120" stroke="#475569" marker-end="url(#arr)"/>
  <rect x="55" y="122" width="70" height="24" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="90" y="139" text-anchor="middle" fill="#1e293b">a…c</text>
  <rect x="195" y="122" width="70" height="24" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="230" y="139" text-anchor="middle" fill="#64748b">d…z</text>
  <text x="160" y="180" text-anchor="middle" fill="#059669">seek to 'admin',</text>
  <text x="160" y="200" text-anchor="middle" fill="#059669">read contiguous run</text>
  <text x="160" y="228" text-anchor="middle" fill="#64748b">admin_bot</text>
  <text x="160" y="246" text-anchor="middle" fill="#64748b">admin_ops  &lt; 'admio'</text>

  <!-- non-sargable side -->
  <rect x="330" y="30" width="290" height="240" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="475" y="52" text-anchor="middle" fill="#1e293b" font-weight="600">LIKE '%smith%'  (FULL SCAN)</text>
  <text x="475" y="80" text-anchor="middle" fill="#64748b">no prefix → no seek key</text>
  <rect x="360" y="95" width="230" height="150" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="475" y="120" text-anchor="middle" fill="#1e293b">row 1  ✗</text>
  <text x="475" y="142" text-anchor="middle" fill="#1e293b">row 2  ✗</text>
  <text x="475" y="164" text-anchor="middle" fill="#1e293b">row 3  ✓ (…smith…)</text>
  <text x="475" y="186" text-anchor="middle" fill="#1e293b">…</text>
  <text x="475" y="216" text-anchor="middle" fill="#b91c1c">every row tested</text>
</svg>
```

`ILIKE` and `LOWER(col) = …` are also non-sargable against a plain index because they transform the column before comparison — unless you build a **functional index** (`CREATE INDEX ON users (LOWER(email))`) or a **case-insensitive collation**. For "contains" and regex search on large tables, PostgreSQL's `pg_trgm` **GIN trigram index** makes `%smith%` and many regexes index-assisted.

## 6. Variations & Trade-offs

| Predicate | Case-insensitive? | Index-usable (plain B-tree)? | Notes |
|-----------|-------------------|------------------------------|-------|
| `col = 'x'` | depends on collation | Yes (equality) | Fastest; collation decides case |
| `col LIKE 'x%'` | No | Yes (range scan) | Anchored prefix — sargable |
| `col LIKE '%x'` / `'%x%'` | No | No | Leading wildcard → scan; use trigram GIN |
| `col ILIKE 'x%'` | Yes | No (needs functional/CI index) | PG only; MySQL `LIKE` is CI by default |
| `LOWER(col)='x'` | Yes | Only with `INDEX(LOWER(col))` | Functional index makes it sargable |
| `col ~ 'regex'` | with `~*` | No (unless trigram GIN) | Most flexible, least sargable |
| `col SIMILAR TO 'p'` | No | No | SQL-standard, rarely used; regex is clearer |

Rule of thumb: prefer equality; use anchored `LIKE 'x%'` for prefix search; for case-insensitive matching pick a **CI collation** or a **functional `LOWER()` index** over ad-hoc `LOWER()`/`ILIKE`; for substring/regex search on big tables, add a **trigram index** rather than accepting full scans.

## 7. Performance Notes

- **Anchored prefix** `LIKE 'abc%'` uses a B-tree range scan. On PostgreSQL with a non-C collation you may need `text_pattern_ops` (`CREATE INDEX … (col text_pattern_ops)`) for `LIKE` to use the index.
- **Leading wildcard** `'%abc'` / `'%abc%'` and arbitrary regex are non-sargable; add `pg_trgm` `GIN`/`GiST` to serve them, or maintain a reversed-string column for suffix search.
- **`LOWER(col)`/`ILIKE`** defeat a plain index because the column is transformed pre-comparison. Fix with `CREATE INDEX ON t (LOWER(col))` and query `LOWER(col)=LOWER(:x)`, or use a case-insensitive collation (PG `citext`/ICU CI, MySQL `_ci`).
- **`LENGTH` semantics** differ: PG = characters, MySQL = bytes — use `CHAR_LENGTH` in MySQL for character counts; wrong function inflates length checks on multibyte data.
- Applying functions to a column in `WHERE` (`SUBSTRING(col,1,3)='abc'`) is non-sargable; rewrite as `col LIKE 'abc%'` so the index can range-scan.
- `EXPLAIN` tells the truth: `Index Cond: (col ~>=~ 'abc')` = good; `Filter: (col ~~ '%abc%')` on a `Seq Scan` = full scan, add a trigram index.

## 8. Common Mistakes

1. ⚠️ Using `%term%` in a search box and wondering why it's slow — leading wildcard forces a full scan; add a trigram index or switch to prefix search.
2. ⚠️ `LOWER(col) = 'x'` without a functional index — correct results, but non-sargable. Index `LOWER(col)` or use a CI collation.
3. ⚠️ Assuming `LENGTH` counts characters — in MySQL it counts bytes; multibyte strings report too large. Use `CHAR_LENGTH`.
4. ⚠️ Using `||` for concatenation in MySQL — there it means logical OR (unless `PIPES_AS_CONCAT`); use `CONCAT`.
5. ⚠️ `a || NULL` yields NULL in PostgreSQL — a single NULL wipes the whole concatenation. Use `CONCAT`/`concat_ws` (null-tolerant) when nulls are possible.
6. ⚠️ Forgetting to `ESCAPE` literal `%`/`_` in `LIKE` — `LIKE '100%'` matches "100" followed by anything; use `LIKE '100\%' ESCAPE '\'`.
7. ⚠️ Expecting `SIMILAR TO` to behave like POSIX regex — it's a distinct dialect; use `~`/`REGEXP` for real regex.
8. ⚠️ Relying on default case behavior across engines — PostgreSQL is case-sensitive, MySQL's default `_ci` collation isn't; the same query returns different rows.

## 9. Interview Questions

**Q: Why is `col LIKE 'abc%'` fast but `col LIKE '%abc'` slow on an indexed column?**
A: The anchored prefix has a known starting substring, so the B-tree can range-scan (`col >= 'abc' AND col < 'abd'`). The leading wildcard has no prefix to seek on, so the engine must test every row — a full scan.

**Q: How do you make a case-insensitive search sargable?**
A: Either use a case-insensitive collation (`citext`/ICU CI in PostgreSQL, a `_ci` collation in MySQL) so `=`/`LIKE` are CI and indexable, or build a functional index `CREATE INDEX ON t (LOWER(col))` and query `LOWER(col)=LOWER(:x)`. Ad-hoc `ILIKE`/`LOWER()` alone don't use a plain index.

**Q: What's the difference between `LIKE` and `ILIKE`?**
A: `ILIKE` is PostgreSQL's case-insensitive `LIKE`. It's non-standard and, against a plain index, non-sargable. MySQL has no `ILIKE` because its default collations are already case-insensitive.

**Q: `LENGTH('café')` returns 5 on one engine and 4 on another. Why?**
A: MySQL's `LENGTH` counts bytes (é is 2 bytes in UTF-8 → 5), while PostgreSQL's counts characters (→ 4). Use `CHAR_LENGTH` for a character count in MySQL.

**Q: How do you extract the domain from an email in SQL?**
A: `SUBSTRING(email FROM POSITION('@' IN email) + 1)` — locate `@`, then slice from the next character. Or `split_part(email, '@', 2)` in PostgreSQL.

**Q: What are `split_part` and `string_to_array` for, and how do they differ?**
A: `split_part(s, delim, n)` returns just the nth field as text; `string_to_array(s, delim)` returns the whole array, which you can `unnest` into rows. Use `split_part` for a single field, the array form when you need all pieces.

**Q: `WHERE SUBSTRING(sku,1,3) = 'ABC'` is scanning the whole table. How do you fix it?**
A: Wrapping the column in a function is non-sargable. Rewrite as `WHERE sku LIKE 'ABC%'`, which the B-tree can range-scan — or add a functional index on `SUBSTRING(sku,1,3)` if the rewrite isn't possible.

**Q: How would you support a fast "contains" search (`%term%`) on a million-row table?**
A: Add a PostgreSQL `pg_trgm` GIN (or GiST) trigram index. It indexes 3-character grams so `LIKE '%term%'`, `ILIKE`, and many regexes become index-assisted instead of full scans. For richer needs, full-text search (`tsvector`/GIN).

**Q: Why might `first || middle || last` produce NULL, and how do you avoid it?**
A: In PostgreSQL `||` propagates NULL — one NULL operand makes the whole result NULL. Use `CONCAT` (treats NULL as empty) or `concat_ws(' ', …)` which also skips NULLs and manages the separator.

**Q: The same `WHERE name = 'smith'` returns rows on MySQL but none on PostgreSQL. Why?**
A: Collation/case sensitivity. MySQL's default `utf8mb4_..._ci` collation is case-insensitive so it matches `'Smith'`; PostgreSQL's default is case-sensitive, so `'smith' <> 'Smith'`. Normalize with `LOWER()`/CI collation for consistent behavior.

**Q: When would you choose a regex (`~`) over `LIKE`, knowing regex isn't sargable?**
A: When the pattern needs classes, quantifiers, or alternation (`^\+?[0-9]{10}$`) that `LIKE` can't express. Accept the scan for validation/filtering on small sets, or back it with a trigram index; for simple prefix/contains, prefer `LIKE`.

## 10. Practice

- [ ] Extract the TLD (last dot segment) from a `url` column using `split_part` / `SUBSTRING` + `POSITION`.
- [ ] Write a sargable prefix search for usernames starting with a given letter and confirm the index range scan in `EXPLAIN`.
- [ ] Make `LOWER(email) = LOWER(:x)` use an index by adding a functional index; verify with `EXPLAIN`.
- [ ] Validate phone numbers with a regex and compare row counts to a `LIKE`-based approximation.
- [ ] Add a `pg_trgm` GIN index and show `%term%` switching from Seq Scan to a bitmap index scan.

## 11. Cheat Sheet

> [!TIP]
> **Concat:** `a || b` (PG, NULL-propagating) / `CONCAT`/`concat_ws` (null-safe, MySQL). **Length:** `CHAR_LENGTH` = chars everywhere; PG `LENGTH`=chars, MySQL `LENGTH`=bytes. **Slice/locate:** `SUBSTRING(s FROM p FOR n)`, `POSITION(sub IN s)`, `split_part(s,d,n)`. **Clean:** `TRIM`, `LOWER`/`UPPER`, `REPLACE`. **Match:** `LIKE 'x%'` = sargable range scan; `'%x%'`/`ILIKE`/regex = scan unless trigram GIN or functional/CI-collation index. Case sensitivity = collation (PG case-sensitive, MySQL `_ci` not). Never wrap the indexed column in a function in `WHERE`.

**References:** PostgreSQL docs — String Functions & Operators, Pattern Matching (LIKE/SIMILAR TO/POSIX), `pg_trgm`; MySQL Reference — String Functions & `REGEXP`; Use The Index, Luke — "LIKE Filters"

---
*SQL Handbook — topic 17.*
