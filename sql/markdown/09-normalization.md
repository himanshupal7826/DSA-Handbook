# 09 · Normalization & Schema Design

> **In one line:** Structure tables to reduce redundancy and anomalies.

---

## 1. Overview

Normalization organizes columns/tables so each fact is stored once, eliminating update/insert/delete anomalies. 1NF (atomic columns), 2NF (no partial key dependency), 3NF (no transitive dependency) cover most designs. Denormalization deliberately reintroduces redundancy for read speed.

## 2. Key Concepts

- 1NF: atomic values, no repeating groups.
- 2NF: non-key columns depend on the whole composite key.
- 3NF: non-key columns depend only on the key (no transitive deps).
- Denormalization trades write complexity for faster reads.

## 3. Syntax & Code

```sql
-- 3NF: separate the transitively-dependent attribute (city->zip) appropriately
CREATE TABLE customers (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  address_id BIGINT REFERENCES addresses(id)
);
CREATE TABLE addresses (
  id BIGSERIAL PRIMARY KEY,
  street TEXT, city TEXT, zip TEXT
);
```

## 4. Worked Example

**Anomaly removed**

Storing category_name on every product means renaming a category requires many updates. Move it to a categories table referenced by category_id.

```sql
CREATE TABLE categories (id SERIAL PRIMARY KEY, name TEXT UNIQUE);
ALTER TABLE products ADD COLUMN category_id INT REFERENCES categories(id);
```

## 5. Best Practices

- ✅ Start normalized (3NF); denormalize only with evidence.
- ✅ Use surrogate keys (BIGSERIAL/UUID) plus natural unique constraints.
- ✅ Enforce integrity with FKs, UNIQUE, NOT NULL, CHECK.
- ✅ Pick correct data types (avoid stringly-typed numbers/dates).
- ✅ Document the schema and relationships.

## 6. Common Pitfalls

1. ⚠️ Over-normalizing read-heavy schemas → many joins.
2. ⚠️ Denormalizing without keeping copies in sync.
3. ⚠️ Storing CSV/JSON blobs where relations belong.
4. ⚠️ Missing foreign keys → orphaned rows.
5. ⚠️ Using floats for money (use NUMERIC/DECIMAL).
6. ⚠️ No unique constraint on natural keys → duplicates.

## 7. Interview Questions

1. **Q: What problem does normalization solve?**
   A: Redundancy and the resulting insert/update/delete anomalies.

2. **Q: Define 1NF/2NF/3NF briefly.**
   A: 1NF: atomic columns; 2NF: no partial dependency on a composite key; 3NF: no transitive dependency on the key.

3. **Q: When denormalize?**
   A: For read-heavy hot paths where join cost dominates and you can keep copies consistent.

4. **Q: Surrogate vs natural key?**
   A: Surrogate (auto id) is stable and simple; natural key is meaningful but can change — often use both.

5. **Q: Why not store money as float?**
   A: Floating point can't represent decimals exactly; use NUMERIC/DECIMAL.

6. **Q: How do FKs help?**
   A: They enforce referential integrity and document relationships.

7. **Q: Star schema vs 3NF?**
   A: Analytics often use denormalized star schemas (fact + dimensions) for fast aggregation.

8. **Q: How to handle many-to-many?**
   A: A junction table with two foreign keys (and a composite PK).

## 8. Practice

- [ ] Normalize a flat orders sheet into 3NF tables.
- [ ] Add FK + UNIQUE constraints to prevent duplicates.
- [ ] Design a many-to-many tags relationship.

## 9. Quick Revision

Normalize to store each fact once (1NF/2NF/3NF) to kill anomalies; denormalize deliberately for read speed. Use surrogate keys + constraints; NUMERIC for money; junction tables for M:N.

**References:** Codd's normal forms

---

*SQL Handbook — topic 09.*
