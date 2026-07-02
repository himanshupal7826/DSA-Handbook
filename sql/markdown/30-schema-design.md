# 30 · Schema Design & Data Modeling

> **In one line:** Turn a domain into entities, relationships, and keys — then shape tables and indexes around how the application actually reads and writes.

---

## 1. Overview

**Data modeling** is the act of translating a real-world domain into a relational schema: identifying the **entities** (things you store), the **relationships** between them, the **cardinality** of those relationships (1:1, 1:N, M:N), and the **keys** that identify and connect everything. It sits above normalization — normalization tells you how to *arrange* attributes; modeling tells you *what the tables even are*.

A good model is **queryable, correct, and evolvable**. It captures the domain's rules as structure (a many-to-many becomes a junction table; an optional relationship becomes a nullable FK), so illegal states are unrepresentable. It also anticipates **access patterns**: the same entities can be modeled for transaction integrity (**OLTP**) or for analytic scanning (**OLAP**), and the right choice depends on how the data is used, not on abstract purity.

You do this work at the start of any nontrivial system and revisit it whenever a new access pattern (a report, a feed, a search) stresses the current shape. The deliverable is an **ER diagram** plus DDL: entities as tables, relationships as foreign keys, and indexes chosen for the queries you know you'll run.

## 2. Core Concepts

- **Entity** — a distinct thing worth storing (Customer, Order, Product). Becomes a table; its instances are rows.
- **Attribute** — a property of an entity (name, price, created_at). Becomes a column with a chosen data type.
- **Relationship** — an association between entities (a Customer *places* Orders). Realized by a foreign key.
- **Cardinality** — how many instances relate: **1:1**, **1:N** (one-to-many), **M:N** (many-to-many). Drives where the FK lives.
- **Optionality / participation** — whether the relationship is mandatory (NOT NULL FK) or optional (nullable FK).
- **Junction (associative) table** — resolves an M:N into two 1:N relationships; its PK is usually the composite of the two FKs.
- **Identifying vs non-identifying relationship** — whether the parent's key is *part of* the child's key (weak entity) or merely referenced.
- **Inheritance / subtype modeling** — representing "a Payment is a Card or a Bank transfer" via single-table, class-table, or concrete-table strategies.
- **Surrogate vs natural key choice** — per entity, pick a stable identifier (see topic 29).
- **Access-pattern-driven indexing** — index the columns your `WHERE`, `JOIN`, and `ORDER BY` clauses actually use, in the order they're used.
- **OLTP vs OLAP** — normalized, write-optimized transactional model vs denormalized, scan-optimized analytic (star/snowflake) model.

## 3. Syntax & Examples

Model cardinalities by where the FK lives. Below: 1:N, then M:N via a junction, then a 1:1.

```sql
-- 1:N — one customer has many orders. FK lives on the "many" side (orders).
CREATE TABLE customers (
  id    BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name  TEXT NOT NULL
);
CREATE TABLE orders (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  placed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_customer ON orders(customer_id);   -- for "orders of a customer"
```

```sql
-- M:N — orders contain many products; products appear in many orders.
-- Resolve with a junction table whose PK is the composite of both FKs.
CREATE TABLE products (
  sku   TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0)
);
CREATE TABLE order_items (
  order_id BIGINT NOT NULL REFERENCES orders(id)    ON DELETE CASCADE,
  sku      TEXT   NOT NULL REFERENCES products(sku) ON DELETE RESTRICT,
  qty      INT    NOT NULL CHECK (qty > 0),
  PRIMARY KEY (order_id, sku)          -- composite key = the association itself
);
CREATE INDEX idx_items_sku ON order_items(sku);      -- reverse lookup: "orders for a product"
```

```sql
-- 1:1 — a customer has at most one loyalty profile. FK is UNIQUE (or shares the PK).
CREATE TABLE loyalty_profiles (
  customer_id BIGINT PRIMARY KEY REFERENCES customers(id) ON DELETE CASCADE,
  tier        TEXT NOT NULL DEFAULT 'bronze',
  points      INT  NOT NULL DEFAULT 0 CHECK (points >= 0)
);
-- PK = FK enforces at-most-one profile per customer (a shared-primary-key 1:1).
```

```sql
-- Inheritance: single-table strategy — one table, a type discriminator, nullable subtype cols.
CREATE TABLE payments (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES orders(id),
  method      TEXT NOT NULL CHECK (method IN ('card','bank')),
  card_last4  TEXT,        -- only for method='card'
  bank_iban   TEXT,        -- only for method='bank'
  -- guard: the right columns are present for the chosen subtype
  CHECK ( (method='card' AND card_last4 IS NOT NULL)
       OR (method='bank' AND bank_iban  IS NOT NULL) )
);
```

## 4. Sample Data & Results

**`orders`:**

| id  | customer_id | placed_at  |
|----:|------------:|------------|
| 100 | 1           | 2026-06-01 |
| 101 | 2           | 2026-06-02 |

**`order_items` (junction resolving the M:N):**

| order_id | sku    | qty |
|---------:|--------|----:|
| 100      | SKU-A  | 2   |
| 100      | SKU-B  | 1   |
| 101      | SKU-A  | 5   |

The junction lets you traverse the relationship in **both** directions with a plain join:

```sql
-- Products in order 100  (traverse order -> items -> products)
SELECT p.name, oi.qty
FROM order_items oi JOIN products p ON p.sku = oi.sku
WHERE oi.order_id = 100;
```

| name       | qty |
|------------|----:|
| Widget A   | 2   |
| Widget B   | 1   |

```sql
-- Total units sold per product  (the reverse traversal, aggregated)
SELECT sku, SUM(qty) AS units
FROM order_items GROUP BY sku ORDER BY units DESC;
```

| sku   | units |
|-------|------:|
| SKU-A | 7     |
| SKU-B | 1     |

The second query uses `idx_items_sku`; without it, "units per product" scans the whole junction — the classic reason to index *both* FK columns of a junction table.

## 5. Under the Hood

A relational model is a graph of entities connected by FK edges; a query is a *traversal* the optimizer plans as joins. The physical model that matters is: FKs are join predicates, and the indexes you place on them decide whether each hop is an index nested-loop (fast, few rows) or a hash join over a scan (better for bulk). The ER diagram below is a small e-commerce domain — the shape you'd hand to both the DBA and the app team.

```svg
<svg viewBox="0 0 720 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="one" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto">
      <path d="M2,1 L2,11 M6,3 L6,9" stroke="#475569" stroke-width="1.4" fill="none"/>
    </marker>
    <marker id="many" markerWidth="14" markerHeight="14" refX="11" refY="7" orient="auto">
      <path d="M11,2 L2,7 L11,12 M11,7 L3,7" stroke="#475569" stroke-width="1.4" fill="none"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">E-commerce ER model (crow's-foot)</text>

  <!-- customers -->
  <rect x="40" y="50" width="200" height="90" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="140" y="72" text-anchor="middle" fill="#1e293b" font-weight="600">customers</text>
  <text x="140" y="93" text-anchor="middle" fill="#64748b">id (PK)</text>
  <text x="140" y="112" text-anchor="middle" fill="#64748b">email (UNIQUE)</text>
  <text x="140" y="131" text-anchor="middle" fill="#64748b">name</text>

  <!-- loyalty (1:1) -->
  <rect x="40" y="270" width="200" height="80" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="140" y="292" text-anchor="middle" fill="#1e293b" font-weight="600">loyalty_profiles</text>
  <text x="140" y="313" text-anchor="middle" fill="#64748b">customer_id (PK,FK)</text>
  <text x="140" y="332" text-anchor="middle" fill="#64748b">tier · points</text>

  <!-- orders -->
  <rect x="280" y="50" width="200" height="90" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="380" y="72" text-anchor="middle" fill="#1e293b" font-weight="600">orders</text>
  <text x="380" y="93" text-anchor="middle" fill="#64748b">id (PK)</text>
  <text x="380" y="112" text-anchor="middle" fill="#64748b">customer_id (FK)</text>
  <text x="380" y="131" text-anchor="middle" fill="#64748b">placed_at</text>

  <!-- order_items (junction) -->
  <rect x="280" y="230" width="200" height="90" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="380" y="252" text-anchor="middle" fill="#1e293b" font-weight="600">order_items</text>
  <text x="380" y="273" text-anchor="middle" fill="#64748b">order_id (PK,FK)</text>
  <text x="380" y="292" text-anchor="middle" fill="#64748b">sku (PK,FK)</text>
  <text x="380" y="311" text-anchor="middle" fill="#64748b">qty</text>

  <!-- products -->
  <rect x="520" y="230" width="180" height="90" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="610" y="252" text-anchor="middle" fill="#1e293b" font-weight="600">products</text>
  <text x="610" y="273" text-anchor="middle" fill="#64748b">sku (PK)</text>
  <text x="610" y="292" text-anchor="middle" fill="#64748b">name · price</text>

  <!-- edges -->
  <line x1="240" y1="95" x2="280" y2="95" stroke="#475569" stroke-width="1.5" marker-start="url(#one)" marker-end="url(#many)"/>
  <text x="260" y="86" text-anchor="middle" fill="#059669">1:N</text>

  <line x1="140" y1="140" x2="140" y2="270" stroke="#475569" stroke-width="1.5" marker-start="url(#one)" marker-end="url(#one)"/>
  <text x="165" y="208" text-anchor="middle" fill="#059669">1:1</text>

  <line x1="380" y1="140" x2="380" y2="230" stroke="#475569" stroke-width="1.5" marker-start="url(#one)" marker-end="url(#many)"/>
  <text x="405" y="188" text-anchor="middle" fill="#059669">1:N</text>

  <line x1="520" y1="275" x2="480" y2="275" stroke="#475569" stroke-width="1.5" marker-start="url(#one)" marker-end="url(#many)"/>
  <text x="500" y="266" text-anchor="middle" fill="#059669">1:N</text>

  <text x="360" y="378" text-anchor="middle" fill="#64748b">orders ⋈ products is M:N, resolved by the order_items junction</text>
</svg>
```

Notice the M:N between `orders` and `products` never appears as a direct edge — it's *always* two 1:N edges through the junction. That's the physical truth: SQL has no native many-to-many, only foreign keys, so every M:N is a table.

## 6. Variations & Trade-offs

| Cardinality | FK placement | Key |
|-------------|--------------|-----|
| **1:1** | FK on either side, made UNIQUE (or shared PK) | Often FK = PK (shared primary key) |
| **1:N** | FK on the "many" side | FK references the "one" side's PK |
| **M:N** | Junction table with two FKs | Composite PK `(fk1, fk2)` |

| Inheritance strategy | Layout | Best when |
|----------------------|--------|-----------|
| **Single table** (one table, discriminator + nullable cols) | 1 table | Subtypes share most columns; fast, no joins; nullable sprawl |
| **Class/joined table** (base + one table per subtype) | 1 + N tables | Subtypes differ a lot; clean, but every read joins base + subtype |
| **Concrete table** (one full table per subtype) | N tables | Subtypes queried independently; no shared queries needed |

| Model | OLTP | OLAP |
|-------|------|------|
| **Goal** | Correct, concurrent writes | Fast scans & aggregation |
| **Shape** | Normalized (3NF), many narrow tables | Denormalized star/snowflake, wide dimensions |
| **Keys** | Surrogate + FKs everywhere | Surrogate dimension keys in a fact table |
| **Indexes** | Selective B-trees on lookups | Fewer, wide scans; column stores |

Modeling is a series of these placement decisions. The recurring principle: **let the relationship's cardinality dictate structure, and let the access pattern dictate indexes.** A 1:1 that is *always* read together might even be one table; a 1:1 split out is justified by optional data, differing access frequency, or security isolation.

## 7. Performance Notes

- **Index for access patterns, not for tables.** Read your top queries and index the `WHERE`/`JOIN`/`ORDER BY` columns *in use-order*. A composite index `(customer_id, placed_at)` serves "a customer's recent orders" as a single range scan.
- **Index both FKs of a junction table.** `(order_id, sku)` PK serves order→products; you need a separate index on `sku` for the product→orders direction.
- **Cardinality drives join plans.** A 1:N with a selective FK filter → index nested loop; a full-table M:N aggregation → hash join over scans. Check with EXPLAIN ANALYZE that the plan matches the intent.
- **Wide 1:1 splits can help or hurt.** Splitting rarely-read blob columns into a side table keeps the hot table's rows narrow (more per page, better cache) — but every combined read now pays a join. Split only when the cold columns are genuinely cold.
- **Over-normalization = join sprawl.** If a single screen needs 8 joins, consider a read model or targeted denormalization (topic 28) for that path.
- **OLAP shape.** Star schemas minimize joins (fact + one hop per dimension) so scan-and-aggregate stays cheap; snowflaking dimensions adds joins back and is usually a mistake unless a dimension is enormous.
- **Model growth in mind.** Time-series/event tables benefit from partitioning by time; design the PK and indexes so the partition key is present in hot queries.

## 8. Common Mistakes

1. ⚠️ **Modeling an M:N as columns** (`product1_id, product2_id, …` or a CSV). Fix: a junction table with a composite key — the only correct M:N representation.
2. ⚠️ **Designing tables before access patterns.** You index blindly and miss the composite index the top query needs. Fix: list the critical queries first, then model and index for them.
3. ⚠️ **A 1:1 with a plain (non-UNIQUE) FK,** which silently allows many. Fix: make the FK UNIQUE or use it as the child's PK.
4. ⚠️ **EAV / "one big table with a type column and 40 nullable fields"** for unrelated subtypes. Fix: pick a deliberate inheritance strategy (single/joined/concrete) with CHECK guards.
5. ⚠️ **Missing the reverse-direction index on junctions,** so product→orders scans. Fix: index the second FK column too.
6. ⚠️ **Putting mutable natural keys as PKs** across a wide model, causing rename cascades. Fix: surrogate PKs + UNIQUE natural keys.
7. ⚠️ **Using an OLTP-normalized schema for heavy reporting** (or vice-versa). Fix: separate the analytic read model (star schema / warehouse) from the transactional source.
8. ⚠️ **No indexes on FK columns,** turning every join and cascade into a scan. Fix: index FK columns as a default habit.

## 9. Interview Questions

**Q: Walk me through how you'd turn a domain description into a relational schema.**
A: Identify entities (nouns you store) and their attributes, then the relationships between them and each relationship's cardinality and optionality. Map 1:N with an FK on the many side, M:N with a junction table, 1:1 with a UNIQUE/shared-PK FK. Choose keys (surrogate + natural UNIQUE), add constraints for the domain rules, then index for the known access patterns. The output is an ER diagram plus DDL.

**Q: How do you model a many-to-many relationship, and why can't you do it directly?**
A: With a junction (associative) table holding an FK to each side and a composite PK of the two FKs. SQL has no native M:N — only foreign keys, which are inherently "many point to one." So an M:N is always decomposed into two 1:N relationships through the junction, which also gives a natural home for relationship attributes like `qty`.

**Q: On which side of a 1:N does the foreign key go, and why?**
A: On the "many" side. Each row on the many side references exactly one parent, so a single FK column captures the whole relationship. Putting it on the "one" side would require storing multiple references (an array or repeating group), which violates 1NF.

**Q: How do you enforce a true 1:1 relationship?**
A: Make the child's FK UNIQUE, or make the FK the child's primary key (shared-primary-key 1:1). Either guarantees at most one child per parent. A plain FK only gives 1:N, so without the UNIQUE/PK constraint the "1:1" is unenforced.

**Q: Compare single-table, joined-table, and concrete-table inheritance.**
A: Single-table: one table with a discriminator and nullable subtype columns — fast, no joins, but nullable sprawl and weak per-subtype constraints. Joined/class-table: a base table plus one table per subtype — clean and normalized, but every read joins base + subtype. Concrete-table: a full standalone table per subtype — no joins per type but no easy cross-type queries and duplicated columns. Choose by how similar the subtypes are and whether you query them together.

**Q: What does "index for the access pattern" mean concretely?**
A: Index the columns your hot queries filter, join, and sort on, in the order they're used. For "a customer's most recent orders," a composite `(customer_id, placed_at DESC)` serves the filter and the sort as one range scan, whereas separate single-column indexes would need an extra sort or a less efficient plan.

**Q: How does cardinality influence the query plan the optimizer picks?**
A: Cardinality (estimated row counts) decides the join algorithm and order. A highly selective 1:N filter yields few rows → index nested loop; joining two large sets (a full M:N aggregation) → hash join over scans; pre-sorted inputs → merge join. Good keys, FKs, and up-to-date statistics let the optimizer estimate cardinality correctly.

**Q: How does an OLTP model differ from an OLAP model for the same data?**
A: OLTP is normalized (3NF), with many narrow tables, FKs everywhere, and selective indexes — optimized for correct, concurrent single-row writes. OLAP is denormalized into a star schema: a central fact table of measures joined to wide, redundant dimension tables, optimized for scanning and aggregating millions of rows. Same entities, opposite optimizations, often physically separated (source DB vs warehouse).

**Q: When would you split a 1:1 into two tables instead of one?**
A: When part of the data is optional (avoid nullable sprawl), rarely read (keep the hot row narrow for cache/IO), accessed at a different frequency, or needs separate security/isolation. If the two halves are always read together and always present, one table is simpler and avoids the join.

**Q: A junction table query is slow in one direction only. Why?**
A: The composite PK `(a_id, b_id)` indexes traversal by `a_id` (and the pair), but not by `b_id` alone. Queries starting from the b-side scan the whole junction. Add a secondary index on `b_id` to make the reverse traversal an index lookup.

**Q: How do you evolve a schema when a new access pattern appears?**
A: Prefer additive changes: add indexes for the new query, add a materialized read model or denormalized column if joins are the bottleneck, or introduce a junction if a relationship's cardinality changed. Validate the plan with EXPLAIN ANALYZE, keep the OLTP source normalized, and push heavy analytics to a separate read/warehouse model rather than distorting the transactional schema.

## 10. Practice

- [ ] Model a "students enroll in courses" domain: draw the ER, identify the M:N, and write DDL for the junction with a composite PK and both direction indexes.
- [ ] Design a 1:1 between `users` and `user_settings` two ways (UNIQUE FK vs shared PK) and state when you'd split it out at all.
- [ ] Take a `payments` entity with card and bank subtypes and implement it under all three inheritance strategies; note the trade-offs.
- [ ] Given the top 3 queries for an orders app, choose the composite indexes that serve each as a single range scan and justify column order.
- [ ] Convert the normalized e-commerce OLTP schema into an OLAP star schema: define the fact table (order lines) and its dimensions.

## 11. Cheat Sheet

> [!TIP]
> **Schema design in one screen.**
> **Model** = entities (tables) + attributes (columns) + relationships (FKs) + cardinality. **1:1** → UNIQUE/shared-PK FK. **1:N** → FK on the many side. **M:N** → junction table with composite PK; index *both* FKs.
> **SQL has no native M:N** — always two 1:N through a junction.
> **Inheritance**: single-table (fast, nullable sprawl) · joined-table (clean, extra join) · concrete-table (independent, duplicated cols).
> **Keys**: surrogate PK + UNIQUE natural key per entity.
> **Index for access patterns** — the `WHERE`/`JOIN`/`ORDER BY` columns, in use-order; composite indexes serve filter+sort in one scan.
> **OLTP** = normalized, write-optimized. **OLAP** = denormalized star schema, scan-optimized. Model the relationship for correctness; index for the query.

**References:** PostgreSQL documentation (DDL, Indexes), MySQL Reference Manual (Optimization, Data Definition), Kimball "The Data Warehouse Toolkit" (dimensional modeling), Hernandez "Database Design for Mere Mortals", Use The Index, Luke

---
*SQL Handbook — topic 30.*
