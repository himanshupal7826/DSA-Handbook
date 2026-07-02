# 24 · JSON & Semi-Structured Data

> **In one line:** Store flexible, schema-light documents inside a relational column — use `jsonb`, extract with `->`/`->>`, match with containment `@>`, and index with GIN so those queries stay fast.

---

## 1. Overview

Not every attribute deserves its own column. Event payloads, third-party API responses, per-tenant custom fields, and feature flags are **semi-structured**: the shape varies row to row and evolves faster than you want to run migrations. A **JSON column** lets you store that document inline while keeping the row in a normal relational table you can still join and index.

The key decision is representation. PostgreSQL offers **`json`** (stores the raw text verbatim) and **`jsonb`** (a decomposed binary form). `jsonb` is what you almost always want: it parses once on write, deduplicates keys, loses insignificant whitespace, and — critically — supports **GIN indexing** and the containment operator `@>`. MySQL's `JSON` type is likewise a binary form similar to `jsonb`.

JSON is a power tool, not a schema replacement. Attributes you filter, join, sort, or constrain on belong in real typed columns; JSON is for the sparse, variable, or rarely-queried tail. The craft is knowing where that line sits — and using **generated columns** to promote a hot JSON field into an indexable typed column without denormalizing your writes.

## 2. Core Concepts

- **`json` vs `jsonb`** — `json` keeps exact input text (order, whitespace, duplicate keys) and is fast to store, slow to query; `jsonb` is parsed binary, slightly slower to write, far faster to query, and the only one you can GIN-index.
- **`->` (arrow)** — returns the value at a key/index as JSON (still a `json`/`jsonb`). Chainable: `data->'a'->'b'`.
- **`->>` (double arrow)** — returns the value as **text**, ready to cast or compare. Use it at the end of a path.
- **`#>` / `#>>`** — extract by a path array: `data #> '{a,b}'` (as JSON) and `#>>` (as text).
- **Containment `@>`** — "does the left JSON contain this JSON on the right?" `data @> '{"status":"paid"}'`. The workhorse for filtering, and GIN-indexable.
- **Existence `?`, `?|`, `?&`** — does a key exist (any/all). Also GIN-supported.
- **GIN index** — a Generalized Inverted Index over keys/values inside the document; accelerates `@>`, `?`, and (with `jsonb_path_ops`) containment specifically.
- **Generated column** — a derived, stored typed column computed from a JSON expression, which you can B-tree index like any normal column.
- **Arrays** — JSON arrays support element containment (`@> '[2]'`), expansion (`jsonb_array_elements`), and length (`jsonb_array_length`).
- **`jsonb_set` / `||` / `-`** — update a path, merge documents, or delete a key/element.

## 3. Syntax & Examples

```sql
-- A products table with a jsonb attributes column
CREATE TABLE products (
    id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name   text NOT NULL,
    attrs  jsonb NOT NULL DEFAULT '{}'
);

INSERT INTO products (name, attrs) VALUES
 ('Trail Runner', '{"brand":"Z","color":"red","sizes":[8,9,10],"waterproof":true}'),
 ('City Slip-on', '{"brand":"Z","color":"black","sizes":[7,8],"waterproof":false}');
```

```sql
-- Extraction: -> keeps JSON, ->> returns text
SELECT attrs -> 'brand'        AS brand_json,   -- "Z"  (a jsonb)
       attrs ->> 'brand'       AS brand_text,   -- Z    (text)
       attrs #>> '{sizes,0}'   AS first_size    -- 8    (text via path)
FROM products;

-- Filtering by a scalar field (cast text out)
SELECT name FROM products WHERE attrs ->> 'color' = 'red';

-- Containment: does the document contain this fragment?
SELECT name FROM products WHERE attrs @> '{"waterproof": true}';

-- Array containment: size 9 available?
SELECT name FROM products WHERE attrs -> 'sizes' @> '9';

-- Key existence
SELECT name FROM products WHERE attrs ? 'waterproof';
```

```sql
-- Index the whole document for @> / ? queries
CREATE INDEX idx_products_attrs ON products USING GIN (attrs);

-- Narrower, smaller index tuned for containment only
CREATE INDEX idx_products_attrs_ops
    ON products USING GIN (attrs jsonb_path_ops);

-- Promote a hot field to a typed, B-tree-indexable generated column
ALTER TABLE products
  ADD COLUMN color text GENERATED ALWAYS AS (attrs ->> 'color') STORED;
CREATE INDEX idx_products_color ON products (color);
```

> [!NOTE]
> **MySQL** uses `JSON_EXTRACT(attrs,'$.brand')` or the shorthand `attrs->'$.brand'` (JSON) and `attrs->>'$.brand'` (unquoted text). It has no GIN; you index JSON by creating a generated column and a normal index on it. There is no `@>` — use `JSON_CONTAINS(attrs, '9', '$.sizes')`.

## 4. Sample Data & Results

Input — `products` table:

| id | name         | attrs                                                        |
|----|--------------|--------------------------------------------------------------|
| 1  | Trail Runner | `{"brand":"Z","color":"red","sizes":[8,9,10],"waterproof":true}` |
| 2  | City Slip-on | `{"brand":"Z","color":"black","sizes":[7,8],"waterproof":false}` |

Query — find waterproof products that come in size 9:

```sql
SELECT id, name, attrs ->> 'color' AS color
FROM products
WHERE attrs @> '{"waterproof": true}'
  AND attrs -> 'sizes' @> '9';
```

Result:

| id | name         | color |
|----|--------------|-------|
| 1  | Trail Runner | red   |

Both predicates are containment checks that the GIN index on `attrs` can serve; the engine intersects the matching row lists before touching the heap.

## 5. Under the Hood

`jsonb` is stored as a parsed tree of typed values with sorted keys, so key lookup is a binary search rather than a text re-parse. A **GIN index** turns each document into many index entries — one per key/value (or per path with `jsonb_path_ops`) — pointing back to the row. A containment query `attrs @> '{"waterproof":true}'` is answered by looking up that single entry in the inverted index and returning its posting list of row IDs, then optionally rechecking on the heap.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>

  <!-- documents -->
  <rect x="20" y="40" width="230" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="135" y="65"  text-anchor="middle" fill="#1e293b">row 1 attrs</text>
  <text x="135" y="85"  text-anchor="middle" fill="#64748b">brand=Z, color=red,</text>
  <text x="135" y="101" text-anchor="middle" fill="#64748b">waterproof=true, sizes=[8,9,10]</text>

  <rect x="20" y="140" width="230" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="135" y="165" text-anchor="middle" fill="#1e293b">row 2 attrs</text>
  <text x="135" y="185" text-anchor="middle" fill="#64748b">brand=Z, color=black,</text>
  <text x="135" y="201" text-anchor="middle" fill="#64748b">waterproof=false, sizes=[7,8]</text>

  <!-- GIN inverted index -->
  <rect x="360" y="30" width="200" height="240" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="460" y="55" text-anchor="middle" fill="#1e293b" font-weight="bold">GIN inverted index</text>
  <text x="370" y="82"  fill="#1e293b">"color"=red    &#8594; {1}</text>
  <text x="370" y="104" fill="#1e293b">"color"=black  &#8594; {2}</text>
  <text x="370" y="126" fill="#1e293b">waterproof=true  &#8594; {1}</text>
  <text x="370" y="148" fill="#1e293b">waterproof=false &#8594; {2}</text>
  <text x="370" y="170" fill="#1e293b">"sizes"=9      &#8594; {1}</text>
  <text x="370" y="192" fill="#1e293b">"sizes"=8      &#8594; {1,2}</text>
  <text x="370" y="214" fill="#1e293b">"sizes"=7      &#8594; {2}</text>
  <text x="370" y="248" text-anchor="middle" fill="#64748b" font-size="12">each key/value &#8594; posting list of rows</text>

  <line x1="250" y1="75"  x2="356" y2="90"  stroke="#475569" stroke-width="1.2" marker-end="url(#a2)"/>
  <line x1="250" y1="175" x2="356" y2="150" stroke="#475569" stroke-width="1.2" marker-end="url(#a2)"/>

  <!-- query -->
  <rect x="360" y="290" width="330" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="525" y="312" text-anchor="middle" fill="#1e293b">attrs @&gt; '{"waterproof":true}' &#8594; posting {1}</text>

  <!-- result -->
  <rect x="600" y="90" width="90" height="50" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="645" y="112" text-anchor="middle" fill="#1e293b">row 1</text>
  <text x="645" y="130" text-anchor="middle" fill="#059669">match</text>
  <line x1="560" y1="126" x2="596" y2="115" stroke="#475569" stroke-width="1.2" marker-end="url(#a2)"/>
</svg>
```

Without a GIN index, the same containment query is a **sequential scan** that parses/evaluates `@>` on every row. A B-tree on a JSON *expression* or a **generated column** works differently: it stores one sorted key per row (e.g. the extracted `color`), giving equality/range/ORDER BY support that GIN can't — which is why hot scalar fields are best promoted to generated columns.

## 6. Variations & Trade-offs

| Choice                      | Use when                                             | Cost / caveat                              |
|-----------------------------|------------------------------------------------------|--------------------------------------------|
| `json`                      | Write-only audit log, exact text fidelity needed     | No indexing, re-parsed on every read       |
| `jsonb`                     | You query/filter the document                        | Slightly slower write, loses key order     |
| Normalized columns          | Attribute is queried/joined/constrained/sorted often | Requires migrations to change shape        |
| JSON column                 | Sparse, variable, rarely-filtered attributes         | Weak typing, no per-key constraints        |
| GIN `jsonb_ops` (default)   | Need `@>`, `?`, `?|`, `?&`                            | Larger index                               |
| GIN `jsonb_path_ops`        | Only need `@>` containment                            | Smaller/faster, but no key-existence ops   |
| Generated column + B-tree   | One hot scalar field, need range/sort/unique         | Extra stored column, only for known fields |

| Operator | Returns | Typical use                          |
|----------|---------|--------------------------------------|
| `->`     | JSON    | Navigate deeper / feed another `->`  |
| `->>`    | text    | Final extraction to compare/cast     |
| `#>`     | JSON    | Extract by path array                |
| `@>`     | boolean | Containment filter (GIN-indexable)   |
| `?`      | boolean | Key existence (GIN-indexable)        |

**Rule of thumb:** query the document with `@>` (indexable, whole-fragment); extract a scalar for display/cast with `->>`; promote a genuinely hot field to a generated column.

## 7. Performance Notes

- **`attrs ->> 'k' = 'v'` is not GIN-indexable** by default — GIN indexes containment/existence, not text-equality on an extracted value. Either rewrite as `attrs @> '{"k":"v"}'`, add an **expression index** `CREATE INDEX ... ((attrs->>'k'))`, or use a generated column.
- **`jsonb_path_ops`** produces a smaller, faster index for `@>`-only workloads because it indexes hashed paths instead of every key and value.
- **Containment reads the heap to recheck** (GIN is lossy for some ops); a covering generated-column B-tree can avoid that for scalar filters.
- **Big documents bloat every row and TOAST**; a 50 KB blob you rarely read still gets fetched/decompressed. Split cold blobs into a side table.
- **Sorting/range on a JSON field** wants a B-tree on the expression or generated column — GIN can't order results.
- **Writes rewrite the whole `jsonb`**; frequent `jsonb_set` on a large doc is expensive. Keep churny fields as real columns.
- Check the plan for `Bitmap Index Scan on idx_products_attrs` (GIN) vs a `Seq Scan` with a `Filter` — the latter means your predicate isn't using the index.

## 8. Common Mistakes

1. ⚠️ **Using `json` when you meant `jsonb`.** You lose GIN indexing and re-parse on every read. Fix: default to `jsonb` unless you truly need verbatim text.
2. ⚠️ **Confusing `->` and `->>`.** `attrs->'color' = 'red'` fails/does the wrong thing because the left side is JSON `"red"` not text `red`. Fix: use `->>` for the final scalar, or compare JSON to JSON.
3. ⚠️ **Expecting `->>`-equality to use the GIN index.** It won't. Fix: use `@>`, an expression index, or a generated column.
4. ⚠️ **Storing everything in one JSON blob** including keys you filter/join on constantly. Fix: normalize hot attributes into typed columns.
5. ⚠️ **No validation**, so `sizes` is sometimes a string and sometimes an array. Fix: add a `CHECK (jsonb_typeof(attrs->'sizes') = 'array')` or validate at the app layer.
6. ⚠️ **Assuming key order/duplicates are preserved** in `jsonb` — they aren't. Fix: use `json` if verbatim text matters (rare).
7. ⚠️ **Forgetting to cast** extracted text before numeric comparison: `attrs->>'price' > 100` compares text. Fix: `(attrs->>'price')::numeric > 100` (and index that expression).

## 9. Interview Questions

**Q: What is the difference between `json` and `jsonb` in PostgreSQL?**
A: `json` stores the exact input text (preserving whitespace, key order, and duplicate keys) and re-parses it on every access, so it's fast to write but slow to query and can't be GIN-indexed. `jsonb` stores a decomposed binary tree with sorted, de-duplicated keys — slightly slower to write, much faster to query, and indexable with GIN. Default to `jsonb` unless you need byte-exact text fidelity.

**Q: What's the difference between `->` and `->>`?**
A: `->` returns the extracted value as `json`/`jsonb` (so you can chain further navigation), while `->>` returns it as `text` (ready to compare or cast). Use `->` to drill into nested structure and `->>` at the end when you need a scalar.

**Q: How does the containment operator `@>` work and why is it useful?**
A: `a @> b` is true when every key/value (and array element) in `b` is present in `a`. It lets you filter by a whole JSON fragment (`attrs @> '{"status":"paid"}'`) in one operator, and it's directly accelerated by a GIN index — making it the idiomatic way to query jsonb.

**Q: How do you index a jsonb column and what does the index accelerate?**
A: Create a GIN index: `CREATE INDEX ... USING GIN (attrs)`. It builds an inverted index of keys/values pointing to rows, accelerating containment `@>` and existence `?`/`?|`/`?&`. For containment only, `USING GIN (attrs jsonb_path_ops)` is smaller and faster.

**Q: Why doesn't `WHERE attrs->>'color' = 'red'` use a GIN index?**
A: GIN indexes containment and key/value existence, not text equality on a value extracted by `->>`. To index that predicate, rewrite it as `attrs @> '{"color":"red"}'`, or build an expression index `((attrs->>'color'))`, or add a generated column and B-tree it.

**Q: When should data live in JSON versus normalized columns?**
A: Put attributes in typed columns when you frequently filter, join, sort, aggregate, or constrain on them — you get typing, statistics, foreign keys, and B-tree indexing. Keep sparse, variable, or rarely-queried attributes (per-tenant custom fields, raw payloads) in JSON to avoid churny migrations and wide sparse tables.

**Q: What is a generated column and how does it help JSON workloads?**
A: A generated column is a derived, stored typed column computed from an expression like `attrs->>'color'`. It promotes a hot JSON field into a normal column you can B-tree index — giving equality, range, ORDER BY, and uniqueness support that GIN can't — without changing how you write the document.

**Q: How do you query and index JSON arrays?**
A: Test element membership with containment: `attrs->'sizes' @> '9'`. Expand with `jsonb_array_elements(attrs->'sizes')` to join/aggregate over elements, and get length with `jsonb_array_length`. A GIN index on the column serves the `@>` element-containment lookups.

**Q: (Senior) What's the trade-off between `jsonb_ops` and `jsonb_path_ops` GIN indexes?**
A: The default `jsonb_ops` indexes every key and value, supporting `@>`, `?`, `?|`, and `?&`, but is larger. `jsonb_path_ops` indexes hashed root-to-leaf paths, producing a smaller, faster index that only supports `@>` containment — pick it when your workload is containment-only.

**Q: (Senior) You store a 40 KB JSON blob per row but only ever read two fields — what are the costs?**
A: The blob inflates row/TOAST size, so reads fetch and decompress data you don't need, hurting cache efficiency and I/O; every write rewrites the whole `jsonb`. Better to keep the two hot fields as columns (or generated columns) and move the cold blob to a side table fetched only on demand.

**Q: (Senior) How would you enforce that a JSON field is always a number within a range?**
A: Add a CHECK constraint — e.g. `CHECK (jsonb_typeof(attrs->'price') = 'number' AND (attrs->>'price')::numeric BETWEEN 0 AND 1e6)` — or promote it to a typed generated column with its own CHECK. JSON gives no per-key typing on its own, so constraints or app-level validation are required.

**Q: (Senior) How do you read an EXPLAIN plan to confirm a jsonb query used the GIN index?**
A: Look for a `Bitmap Index Scan on <gin_index>` feeding a `Bitmap Heap Scan` with a `Recheck Cond` (GIN is lossy, so it rechecks on the heap). If instead you see a `Seq Scan` with the `@>`/`->>` predicate under `Filter`, the index wasn't used — usually because the predicate form isn't GIN-indexable or statistics favored a scan.

## 10. Practice

- [ ] Create a `jsonb` column, insert 5 documents, and write a containment query that returns exactly two of them.
- [ ] Add a GIN index and use `EXPLAIN` to confirm a `Bitmap Index Scan` before vs a `Seq Scan` after removing it.
- [ ] Rewrite a slow `attrs->>'k' = 'v'` filter three ways: as `@>`, as an expression index, and as a generated column — compare plans.
- [ ] Use `jsonb_array_elements` to unnest an array field and aggregate a count per element value.
- [ ] Add a CHECK constraint enforcing that a JSON field is a number, and demonstrate a rejected insert.

## 11. Cheat Sheet

> [!TIP]
> Prefer **`jsonb`** (binary, indexable) over `json` (raw text). Navigate with **`->`** (returns JSON, chainable) and finish with **`->>`** (returns text — then cast). Filter whole fragments with containment **`@>`** and keys with **`?`** — both served by a **GIN index** (`USING GIN(attrs)`, or `jsonb_path_ops` for `@>`-only). GIN does *not* index `->>`-equality — use `@>`, an expression index, or a **generated column** (which also gives range/sort/unique). Put hot, filtered, joined attributes in **typed columns**; keep sparse/variable data in JSON. Arrays: `@> '9'` to test membership, `jsonb_array_elements` to unnest. Watch big blobs (TOAST bloat, whole-doc rewrites) and always cast text before numeric compares.

**References:** PostgreSQL docs "JSON Types" & "JSON Functions and Operators", PostgreSQL "GIN Indexes", MySQL Reference Manual "The JSON Data Type", Use The Index Luke (functional/expression indexes)

---
*SQL Handbook — topic 24.*
