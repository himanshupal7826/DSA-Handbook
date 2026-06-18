# 11 · Data Types & Constraints

> **In one line:** Pick correct types and enforce integrity at the schema level.

---

## 1. Overview

Choosing the right column types and constraints makes data correct *by construction*. Constraints (NOT NULL, UNIQUE, CHECK, FOREIGN KEY, PRIMARY KEY) are enforced by the database, so bad data can't enter regardless of the application.

## 2. Key Concepts

- Use precise types: INT/BIGINT, NUMERIC for money, TIMESTAMPTZ for time, TEXT for strings.
- PRIMARY KEY = unique + not null identity.
- FOREIGN KEY enforces referential integrity.
- CHECK constraints encode domain rules (e.g., price >= 0).

## 3. Syntax & Code

```sql
CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id),
  total NUMERIC(12,2) NOT NULL CHECK (total >= 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','paid','shipped','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

## 4. Worked Example

**Enum-like CHECK vs lookup table**

For small fixed sets a CHECK works; for evolving sets use a lookup table + FK.

```sql
-- Evolving set:
CREATE TABLE statuses (code TEXT PRIMARY KEY);
ALTER TABLE orders ADD FOREIGN KEY (status) REFERENCES statuses(code);
```

## 5. Best Practices

- ✅ Prefer TIMESTAMPTZ over TIMESTAMP for correctness across time zones.
- ✅ Use NUMERIC/DECIMAL for currency, never float.
- ✅ Add NOT NULL wherever a value is required.
- ✅ Encode invariants with CHECK constraints.
- ✅ Name constraints for clear error messages.

## 6. Common Pitfalls

1. ⚠️ Storing dates/numbers as TEXT.
2. ⚠️ Using FLOAT for money.
3. ⚠️ Missing NOT NULL allowing accidental NULLs.
4. ⚠️ No FK → orphaned child rows.
5. ⚠️ Overly large VARCHAR(n) limits with no real benefit.
6. ⚠️ Time zone bugs from naive TIMESTAMP.

## 7. Interview Questions

1. **Q: Why NUMERIC for money?**
   A: Exact decimal arithmetic; floats introduce rounding errors.

2. **Q: TIMESTAMP vs TIMESTAMPTZ?**
   A: TIMESTAMPTZ stores an absolute instant (UTC) and converts for the session zone; TIMESTAMP is zone-naive.

3. **Q: What does a CHECK constraint do?**
   A: Rejects rows violating a boolean condition at write time.

4. **Q: PRIMARY KEY vs UNIQUE?**
   A: PK is one per table, not null, the row identity; UNIQUE can be multiple and allows (usually one) NULL.

5. **Q: Why enforce constraints in the DB not just the app?**
   A: The DB is the last line of defense; multiple apps/scripts can't bypass it.

6. **Q: CHECK enum vs lookup table?**
   A: CHECK for small fixed sets; FK lookup table for sets that change over time.

7. **Q: What is a composite key?**
   A: A primary key spanning multiple columns, common in junction tables.

8. **Q: Default values?**
   A: DEFAULT supplies a value when none is provided, e.g., created_at DEFAULT now().

## 8. Practice

- [ ] Design a table with PK, FK, NOT NULL, and a CHECK.
- [ ] Convert a stringly-typed date column to TIMESTAMPTZ.
- [ ] Replace a status CHECK with a lookup-table FK.

## 9. Quick Revision

Right types + constraints make data correct by construction: NUMERIC for money, TIMESTAMPTZ for time, NOT NULL/UNIQUE/CHECK/FK enforced by the DB. Push invariants into the schema.

**References:** SQL types

---

*SQL Handbook — topic 11.*
