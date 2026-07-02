# 29 · Keys, Constraints & Referential Integrity

> **In one line:** Keys identify rows uniquely; constraints turn business rules into invariants the database refuses to violate.

---

## 1. Overview

A **key** answers "which row?" — it is the column(s) that uniquely identify a row so the rest of the schema, and the outside world, can point at it unambiguously. A **constraint** is a rule the database enforces on every write: it converts a business invariant ("email is unique", "quantity ≥ 1", "every order belongs to a real customer") into something the engine physically will not let you break.

Together they provide **data integrity**. Without keys you get duplicate rows you can't tell apart; without constraints you get orphaned children, negative prices, and NULLs where a value is mandatory. The database becomes the last line of defense — application bugs, concurrent writers, and ad-hoc scripts all pass through the same constraint checks.

**Referential integrity** is the specific guarantee that a **foreign key** value always matches an existing row in the referenced table (or is NULL). It's what makes joins trustworthy and prevents dangling references. You reach for this material on day one of any schema: every table needs a primary key, and every relationship needs a foreign key with an explicit deletion/update policy.

## 2. Core Concepts

- **Primary key (PK)** — the chosen unique, non-NULL identifier for a row. Exactly one per table; usually backed by a unique index and clustered storage in some engines (InnoDB).
- **Unique key / UNIQUE constraint** — enforces no duplicate values in a column or column set. A table can have many; unlike a PK it *may* allow NULLs (and treats NULLs as distinct in most engines).
- **Foreign key (FK)** — a column whose values must exist as a key in another (or the same) table, enforcing **referential integrity**.
- **Natural key** — a key with real-world meaning (email, ISBN, country code). Intuitive but can change and may be wide.
- **Surrogate key** — a synthetic, meaningless identifier (`BIGSERIAL`, `IDENTITY`, `UUID`). Stable and narrow; the common default, paired with a UNIQUE constraint on the natural key.
- **Composite key** — a key of two or more columns; the *combination* is unique. Common on junction tables (`(order_id, sku)`).
- **NOT NULL** — the column must always hold a value; the simplest and most-forgotten integrity rule.
- **CHECK** — a boolean predicate every row must satisfy (`qty > 0`, `status IN (...)`, `end_date >= start_date`).
- **DEFAULT** — a value supplied when the INSERT omits the column; not a constraint but part of the integrity toolkit.
- **Referential actions** — `ON DELETE` / `ON UPDATE` policies: `CASCADE`, `RESTRICT`, `NO ACTION`, `SET NULL`, `SET DEFAULT` — what happens to children when a parent changes.
- **Deferrable constraint** — a constraint whose check can be postponed to `COMMIT` (`DEFERRABLE INITIALLY DEFERRED`), enabling circular references and bulk reorders within a transaction.

## 3. Syntax & Examples

Keys and constraints are declared in DDL and enforced from that moment on.

```sql
-- Primary key + surrogate id + natural unique key + NOT NULL + CHECK + DEFAULT
CREATE TABLE customers (
  id        BIGSERIAL PRIMARY KEY,                       -- surrogate PK
  email     TEXT        NOT NULL UNIQUE,                 -- natural unique key
  name      TEXT        NOT NULL,
  status    TEXT        NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','suspended','closed')),
  credit    NUMERIC(12,2) NOT NULL DEFAULT 0
              CHECK (credit >= 0)
);
```

```sql
-- Foreign key with an explicit deletion policy
CREATE TABLE orders (
  id          BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL
                REFERENCES customers(id)
                ON DELETE RESTRICT      -- can't delete a customer with orders
                ON UPDATE CASCADE,      -- id change propagates (rare with surrogates)
  placed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  total       NUMERIC(12,2) NOT NULL CHECK (total >= 0)
);
```

```sql
-- Composite primary key on a junction (M:N) table
CREATE TABLE order_items (
  order_id BIGINT NOT NULL REFERENCES orders(id)     ON DELETE CASCADE,
  sku      TEXT   NOT NULL REFERENCES products(sku)  ON DELETE RESTRICT,
  qty      INT    NOT NULL CHECK (qty > 0),
  PRIMARY KEY (order_id, sku)          -- the pair is unique
);
```

```sql
-- Named, table-level, and multi-column constraints (named => clean error messages)
CREATE TABLE bookings (
  id         BIGSERIAL PRIMARY KEY,
  room_id    INT NOT NULL,
  start_at   TIMESTAMPTZ NOT NULL,
  end_at     TIMESTAMPTZ NOT NULL,
  CONSTRAINT valid_window CHECK (end_at > start_at),
  CONSTRAINT uq_room_slot UNIQUE (room_id, start_at)
);

-- Add/relax constraints later
ALTER TABLE customers ADD CONSTRAINT chk_credit_cap CHECK (credit <= 100000);
```

```sql
-- Deferrable FK: allows a circular reference to be satisfied at COMMIT, not per-statement
CREATE TABLE employees (
  id         BIGSERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  manager_id BIGINT REFERENCES employees(id)
               DEFERRABLE INITIALLY DEFERRED
);
-- Inside one transaction you can insert a manager and report in any order.
```

## 4. Sample Data & Results

**`customers`:**

| id | email             | status    | credit |
|---:|-------------------|-----------|-------:|
| 1  | aarti@x.com       | active    | 500.00 |
| 2  | bilal@x.com       | suspended |   0.00 |

**`orders`:**

| id  | customer_id | total  |
|----:|------------:|-------:|
| 100 | 1           | 250.00 |
| 101 | 1           |  80.00 |

Now watch each constraint reject a bad write:

```sql
INSERT INTO customers(email, name) VALUES ('aarti@x.com', 'Dup');
-- ERROR: duplicate key value violates unique constraint  (email already exists)

INSERT INTO orders(customer_id, total) VALUES (999, 10.00);
-- ERROR: insert or update violates foreign key constraint  (customer 999 doesn't exist)

INSERT INTO customers(email, name, credit) VALUES ('x@x.com','X', -5);
-- ERROR: new row violates check constraint "customers_credit_check"

DELETE FROM customers WHERE id = 1;
-- ERROR: update or delete violates foreign key constraint on "orders"  (ON DELETE RESTRICT)
```

Every rejected statement is a bug that never became corrupt data. With `ON DELETE CASCADE` on `order_items`, deleting order 100 would instead silently remove its items — the policy is a design decision, not a default to accept blindly.

## 5. Under the Hood

A PK or UNIQUE constraint is enforced by a **unique index**: before a row is written, the engine probes the index for the key; a hit raises a violation. This is why unique checks are cheap (a B-tree lookup) and why a UNIQUE constraint automatically gives you an index to query by. A FK check is a lookup in the *parent's* unique index; a referential action on delete/update is a lookup in the *child* to find affected rows.

The diagram shows the reference topology and what each `ON DELETE` policy does when a parent row is removed.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="fk" markerWidth="10" markerHeight="10" refX="8" refY="4.5" orient="auto">
      <path d="M0,0 L9,4.5 L0,9 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Referential integrity &amp; ON DELETE policies</text>

  <!-- parent -->
  <rect x="270" y="44" width="180" height="70" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="66" text-anchor="middle" fill="#1e293b" font-weight="600">customers (parent)</text>
  <text x="360" y="88" text-anchor="middle" fill="#64748b">id (PK) · email (UNIQUE)</text>
  <text x="360" y="106" text-anchor="middle" fill="#059669">the referenced key</text>

  <!-- children -->
  <rect x="40" y="200" width="200" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="140" y="222" text-anchor="middle" fill="#1e293b" font-weight="600">orders (child)</text>
  <text x="140" y="244" text-anchor="middle" fill="#64748b">customer_id (FK)</text>

  <rect x="480" y="200" width="200" height="70" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="580" y="222" text-anchor="middle" fill="#1e293b" font-weight="600">order_items (child)</text>
  <text x="580" y="244" text-anchor="middle" fill="#64748b">order_id (FK)</text>

  <path d="M140,200 L300,114" stroke="#475569" stroke-width="1.5" marker-end="url(#fk)"/>
  <path d="M560,200 L420,114" stroke="#475569" stroke-width="1.5" marker-end="url(#fk)"/>

  <!-- policy legend -->
  <rect x="40" y="290" width="640" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="308" text-anchor="middle" fill="#1e293b" font-weight="600">Delete a customer with orders →</text>
  <text x="360" y="325" text-anchor="middle" fill="#64748b">RESTRICT/NO ACTION: block · CASCADE: delete children · SET NULL: orphan-safe · SET DEFAULT: reassign</text>
</svg>
```

`RESTRICT` fires *immediately* when the statement runs; `NO ACTION` defers the same check to the end of the statement (and, if `DEFERRABLE`, to COMMIT) — practically identical in most cases but the timing matters for constraint reordering. A **deferrable** constraint records pending violations and only rolls back the transaction if they still exist at COMMIT, which is what lets you insert mutually-referential rows or renumber a composite key inside one transaction.

## 6. Variations & Trade-offs

| Choice | Primary key | Unique key | Foreign key |
|--------|-------------|------------|-------------|
| **How many per table** | Exactly one | Many | Many |
| **NULLs allowed** | No | Yes (usually distinct) | Yes (unmatched allowed) |
| **Auto-index** | Yes | Yes | **No** (index it yourself) |
| **Purpose** | Identify the row | Enforce alternate uniqueness | Enforce referential integrity |

| Key style | Pros | Cons |
|-----------|------|------|
| **Natural** (email, ISBN) | Meaningful, no extra column, dedup for free | Can change → cascade churn; may be wide; PII in FKs |
| **Surrogate** (`BIGSERIAL`/UUID) | Stable, narrow, opaque | Extra column; needs a UNIQUE on the natural key or you get dup "business" rows |

| ON DELETE action | Effect on children |
|------------------|--------------------|
| `RESTRICT` / `NO ACTION` | Block the delete if children exist |
| `CASCADE` | Delete the children too |
| `SET NULL` | Null out the FK (column must be nullable) |
| `SET DEFAULT` | Set FK to its DEFAULT (that value must exist) |

The dominant modern pattern is a **surrogate PK plus a UNIQUE natural key**: you get a stable join target *and* protection against duplicate business rows. Reserve pure natural keys for immutable, narrow codes (currency, country). For deletions, prefer `RESTRICT` by default and reach for `CASCADE` only where the child has no independent existence (order items without their order are meaningless).

## 7. Performance Notes

- **PK/UNIQUE come with an index for free** — use it. A UNIQUE on `email` doubles as the lookup index for `WHERE email = ?`.
- **FK columns are NOT auto-indexed** in PostgreSQL, MySQL/InnoDB (InnoDB *does* auto-index FK columns; PostgreSQL does not). Missing FK indexes make `ON DELETE CASCADE`/`RESTRICT` do a **sequential scan of the child** on every parent delete — a classic slow-delete bug.
- **Constraint checks add write cost** but are far cheaper than the corruption they prevent; a CHECK is an inline predicate, a FK is one index probe.
- **Bulk loads:** validating millions of FKs row-by-row is slow. Load into a staging table, or use `ALTER TABLE ... ADD CONSTRAINT ... NOT VALID` then `VALIDATE CONSTRAINT` (PostgreSQL) to skip the per-row check during load and validate once afterward.
- **Deferrable constraints** hold pending-violation state until COMMIT, using memory proportional to the number of deferred checks — fine for reorders, costly for enormous transactions.
- **UUID PKs** are wider (16 bytes) and, if random (v4), scatter inserts across a B-tree causing page splits and cache churn; prefer time-ordered UUIDs (v7) or `BIGSERIAL` for high-insert tables.

## 8. Common Mistakes

1. ⚠️ **No primary key at all.** Duplicate, unaddressable rows and no reliable replication key. Fix: every table gets a PK (surrogate unless a stable natural key exists).
2. ⚠️ **Relying on the app for uniqueness** instead of a UNIQUE constraint. Concurrent inserts race past app checks. Fix: enforce it in the database — it's the only place immune to races.
3. ⚠️ **Forgetting to index FK columns.** Deletes and cascades scan the child. Fix: `CREATE INDEX` on every FK column used for joins or referential actions.
4. ⚠️ **Defaulting to `ON DELETE CASCADE` everywhere.** One delete silently wipes a subtree. Fix: default to `RESTRICT`; use `CASCADE` only for truly dependent children.
5. ⚠️ **Misunderstanding NULL in UNIQUE.** Most engines treat NULLs as distinct, so multiple NULL rows are allowed. Fix: add NOT NULL, or use a partial/filtered unique index if you need "at most one NULL."
6. ⚠️ **Wide/mutable natural key as PK,** then a rename cascades through every child. Fix: surrogate PK + UNIQUE on the natural key.
7. ⚠️ **CHECK constraints that reference other rows/tables.** CHECK is per-row only. Fix: use a FK, a trigger, or an exclusion constraint for cross-row rules.
8. ⚠️ **`SET NULL` on a NOT NULL FK column** — the action can't run and the delete fails. Fix: make the column nullable or choose a different action.

## 9. Interview Questions

**Q: What is the difference between a primary key and a unique key?**
A: A primary key is the single chosen row identifier: one per table, never NULL, and typically the clustering/join target. A unique key just forbids duplicate values in its column(s): a table can have many, they usually allow NULLs (treated as distinct), and they serve as alternate keys. Both are backed by a unique index.

**Q: When would you choose a surrogate key over a natural key?**
A: When the natural key can change, is wide, or is sensitive (email, name). A surrogate (`BIGSERIAL`/UUID) is stable and narrow, so joins and FKs never churn. The standard pattern is surrogate PK plus a UNIQUE constraint on the natural key, giving both a stable join target and duplicate protection.

**Q: What is referential integrity and how does a foreign key enforce it?**
A: It's the guarantee that every FK value matches an existing key in the referenced table (or is NULL) — no dangling references. The FK enforces it by probing the parent's unique index on insert/update of the child, and by applying an ON DELETE/UPDATE action when the parent changes, so orphans can never be created.

**Q: Explain the ON DELETE options and when you'd use each.**
A: `RESTRICT`/`NO ACTION` block the delete if children exist (safe default). `CASCADE` deletes the children too (use when the child can't exist alone, like order items). `SET NULL` nulls the FK (the column must be nullable — for optional relationships). `SET DEFAULT` sets the FK to its default value, which must reference an existing row.

**Q: A DELETE on the parent table is suddenly slow. What's the likely cause?**
A: A missing index on the child's FK column. Without it, each ON DELETE CASCADE/RESTRICT check sequentially scans the child to find referencing rows. PostgreSQL doesn't auto-index FK columns, so this is a common trap — add the index.

**Q: How does NULL behave in a UNIQUE constraint, and how do you allow only one NULL?**
A: In standard SQL and most engines, NULLs are considered distinct, so a UNIQUE column can hold multiple NULL rows. To allow at most one NULL, use a partial/filtered unique index (`WHERE col IS NULL`) or mark the column NOT NULL. (PostgreSQL 15+ also offers `NULLS NOT DISTINCT`.)

**Q: What is a deferrable constraint and what problem does it solve?**
A: A constraint whose check is postponed to COMMIT (`DEFERRABLE INITIALLY DEFERRED`) rather than per-statement. It lets a transaction temporarily hold an inconsistent state — inserting mutually-referential rows in any order, or renumbering a composite unique key with a swap — as long as the constraint holds at COMMIT.

**Q: Can a CHECK constraint enforce a rule that spans two tables?**
A: No — CHECK evaluates a predicate against a single row only and cannot reliably reference other rows or tables. Cross-table rules need a foreign key, a trigger, or (in PostgreSQL) an exclusion constraint; cross-row uniqueness/overlap rules use exclusion constraints or unique indexes.

**Q: Why enforce constraints in the database when the application already validates?**
A: The database is the single point every writer passes through — app code, background jobs, migrations, manual fixes, and concurrent transactions. App checks race under concurrency and are bypassed by out-of-band writes; a database constraint is atomic with the write and cannot be skipped, making it the only trustworthy invariant.

**Q: How do you add a foreign key to a huge existing table without a long lock?**
A: In PostgreSQL, `ADD CONSTRAINT ... NOT VALID` to add it without scanning existing rows (new writes are checked immediately), then `VALIDATE CONSTRAINT` in a separate step that takes only a lighter lock. This avoids validating millions of rows under a heavy lock during the initial add.

**Q: What's the difference between RESTRICT and NO ACTION?**
A: Both block a delete/update that would orphan children. `RESTRICT` checks immediately when the row is affected; `NO ACTION` defers the check to the end of the statement, and if the constraint is DEFERRABLE, to COMMIT. The deferral lets other statements temporarily fix the reference before the check fires.

## 10. Practice

- [ ] Design a `subscriptions` table with a surrogate PK, a UNIQUE `(user_id, plan_id)`, a CHECK that `renews_at > started_at`, and a DEFAULT status.
- [ ] Create a parent/child pair and demonstrate each ON DELETE action (RESTRICT, CASCADE, SET NULL) with INSERT + DELETE statements showing the outcome.
- [ ] Reproduce the slow-parent-delete problem: build a child with an un-indexed FK, EXPLAIN a parent DELETE, add the index, and compare.
- [ ] Write a partial unique index that allows many rows with NULL `deleted_at` but only one active row per `email`.
- [ ] Use a DEFERRABLE INITIALLY DEFERRED unique constraint to swap two rows' positions in a single transaction without a violation.

## 11. Cheat Sheet

> [!TIP]
> **Keys & constraints in one screen.**
> **PK**: one per table, non-NULL, the row's identity (auto-indexed). **UNIQUE**: many per table, NULLs distinct, alternate keys (auto-indexed). **FK**: enforces referential integrity — *index it yourself*.
> **Surrogate PK + UNIQUE natural key** is the go-to pattern. **Composite key** = the column *combination* is unique (junction tables).
> **NOT NULL / CHECK / DEFAULT** turn business rules into invariants; CHECK is per-row only.
> **ON DELETE**: RESTRICT/NO ACTION (block, safe default) · CASCADE (delete children) · SET NULL / SET DEFAULT.
> **DEFERRABLE INITIALLY DEFERRED** postpones the check to COMMIT — for circular refs and reorders.
> Enforce in the DB, not just the app: it's the only writer-proof, race-proof place.

**References:** PostgreSQL documentation (Constraints, CREATE TABLE, ALTER TABLE), MySQL Reference Manual (FOREIGN KEY Constraints), SQL:2016 standard (referential actions), Use The Index, Luke (indexing foreign keys)

---
*SQL Handbook — topic 29.*
