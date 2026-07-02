# 28 · Normalization (1NF–BCNF) & Denormalization

> **In one line:** Decompose tables so every fact lives in exactly one place — then selectively re-introduce redundancy where read speed demands it.

---

## 1. Overview

**Normalization** is the disciplined process of structuring relations so that each *fact* is stored once and derivable dependencies are removed. The payoff is the elimination of **update, insert, and delete anomalies** — the pathological states where redundant copies of a fact drift out of sync, or where you cannot record one fact without inventing another.

The engine of normalization is the **functional dependency (FD)**: `X → Y` means "every value of `X` determines exactly one value of `Y`". Normal forms are simply progressively stricter rules about *which* FDs are allowed to exist inside a single table. 1NF demands atomic columns; 2NF, 3NF, and BCNF each outlaw a specific class of "a non-key column depends on the wrong thing" FD.

You reach for normalization when designing an **OLTP** schema — orders, users, inventory — where writes are frequent and correctness is non-negotiable. The default target is **3NF** (or BCNF), which practically eliminates redundancy while keeping the schema queryable.

**Denormalization** is the deliberate reverse: you copy or pre-aggregate data to cut join count and latency on read-heavy paths (reporting, dashboards, feeds). It trades write complexity and a synchronization burden for read throughput — a bargain you make with evidence, not by reflex.

## 2. Core Concepts

- **Functional dependency (`X → Y`)** — `X` uniquely determines `Y`. `emp_id → email` holds; `dept_id → email` does not. FDs are the algebra normalization operates on.
- **Candidate key** — a minimal set of columns that functionally determines every other column. A table can have several; one is chosen **primary**.
- **Prime vs non-prime attribute** — a column is *prime* if it belongs to some candidate key, else *non-prime*. The normal forms are stated in these terms.
- **First Normal Form (1NF)** — every column holds a single atomic value; no repeating groups, arrays-as-CSV, or multi-value cells.
- **Second Normal Form (2NF)** — 1NF **and** no non-prime column depends on only *part* of a composite candidate key (no **partial dependency**).
- **Third Normal Form (3NF)** — 2NF **and** no non-prime column depends on another non-prime column (no **transitive dependency**).
- **Boyce–Codd Normal Form (BCNF)** — for every non-trivial FD `X → Y`, `X` must be a **superkey**. Strictly stronger than 3NF; catches anomalies 3NF permits when overlapping candidate keys exist.
- **Anomalies** — **update** (change a fact in many rows or risk inconsistency), **insertion** (cannot add fact A without fact B), **deletion** (removing a row destroys an unrelated fact).
- **Denormalization** — intentional redundancy (copied columns, pre-joined tables, materialized aggregates) to reduce read cost; requires a sync strategy (triggers, app logic, or scheduled refresh).
- **Star schema** — the canonical analytics denormalization: a central **fact** table of measures surrounded by wide, redundant **dimension** tables, optimized for scan-and-aggregate.

## 3. Syntax & Examples

Start with the FD analysis, then let each normal form drive a decomposition.

```sql
-- 1NF violation: a repeating group crammed into one column
CREATE TABLE orders_bad (
  order_id   INT PRIMARY KEY,
  customer   TEXT,
  products   TEXT   -- 'SKU-1, SKU-9, SKU-42'  <-- NOT atomic
);

-- 1NF fix: one row per atomic fact (order line)
CREATE TABLE order_lines (
  order_id  INT,
  sku       TEXT,
  qty       INT,
  PRIMARY KEY (order_id, sku)   -- composite candidate key
);
```

```sql
-- 2NF: composite key (order_id, sku); product_name depends on sku ALONE (partial dep)
CREATE TABLE order_lines_bad (
  order_id     INT,
  sku          TEXT,
  qty          INT,
  product_name TEXT,            -- FD: sku -> product_name  (partial!)
  PRIMARY KEY (order_id, sku)
);

-- 2NF fix: split the partially-dependent fact into its own table
CREATE TABLE products (
  sku          TEXT PRIMARY KEY,
  product_name TEXT NOT NULL
);
CREATE TABLE order_lines (
  order_id INT,
  sku      TEXT REFERENCES products(sku),
  qty      INT,
  PRIMARY KEY (order_id, sku)
);
```

```sql
-- 3NF: key is emp_id; dept_name depends on dept_id (transitive: emp_id -> dept_id -> dept_name)
CREATE TABLE employees_bad (
  emp_id    INT PRIMARY KEY,
  name      TEXT,
  dept_id   INT,
  dept_name TEXT               -- transitive dependency on the key
);

-- 3NF fix: dept_name moves to the table whose key determines it
CREATE TABLE departments (
  dept_id   INT PRIMARY KEY,
  dept_name TEXT NOT NULL
);
CREATE TABLE employees (
  emp_id  INT PRIMARY KEY,
  name    TEXT,
  dept_id INT REFERENCES departments(dept_id)
);
```

```sql
-- BCNF: overlapping candidate keys. Rule: one instructor teaches exactly one subject.
-- FDs: (student, subject) -> instructor   AND   instructor -> subject
-- Candidate keys: {student, subject} and {student, instructor}. 'instructor' is prime,
-- yet instructor -> subject has a non-superkey LHS => 3NF-satisfied but BCNF-violating.
CREATE TABLE teaches_bad (
  student    TEXT,
  subject    TEXT,
  instructor TEXT,
  PRIMARY KEY (student, subject)
);

-- BCNF fix: decompose so every determinant is a superkey
CREATE TABLE instructor_subject (
  instructor TEXT PRIMARY KEY,   -- instructor -> subject
  subject    TEXT NOT NULL
);
CREATE TABLE enrolment (
  student    TEXT,
  instructor TEXT REFERENCES instructor_subject(instructor),
  PRIMARY KEY (student, instructor)
);
```

## 4. Sample Data & Results

Consider an un-normalized enrolment sheet and watch an anomaly bite.

**`enrolment_flat` (violates 3NF — `dept_id → dept_name` is transitive):**

| student_id | student | dept_id | dept_name   |
|-----------:|---------|--------:|-------------|
| 1          | Aarti   | 10      | Physics     |
| 2          | Bilal   | 10      | Physics     |
| 3          | Chen    | 20      | Chemistry   |
| 4          | Divya   | 10      | Physics     |

To rename department 10 to "Applied Physics" you must touch **three** rows; miss one and the table now claims two names for `dept_id = 10` (**update anomaly**). You also cannot register a brand-new department that has no students yet (**insertion anomaly**), and deleting the last student in a department erases the department's existence (**deletion anomaly**).

After decomposing to 3NF, the rename is a single-row write:

```sql
UPDATE departments SET dept_name = 'Applied Physics' WHERE dept_id = 10;
```

**`departments`:**

| dept_id | dept_name         |
|--------:|-------------------|
| 10      | Applied Physics   |
| 20      | Chemistry         |

**`students`:**

| student_id | student | dept_id |
|-----------:|---------|--------:|
| 1          | Aarti   | 10      |
| 2          | Bilal   | 10      |
| 3          | Chen    | 20      |
| 4          | Divya   | 10      |

The join reconstructs the original view on demand, with zero redundancy:

```sql
SELECT s.student, d.dept_name
FROM students s JOIN departments d USING (dept_id);
```

## 5. Under the Hood

Normalization is really *dependency-preserving, lossless decomposition*: split a relation `R` into `R1, R2` on a shared attribute such that `R1 ⋈ R2 = R` (lossless join) and no FD is lost. The engine doesn't "know" normal forms — you encode the FDs as **keys and foreign keys**, and the constraint machinery then enforces the single-source-of-truth property physically.

The diagram traces one fact — a department's name — from a redundant flat table to its normalized home.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arw" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Decomposition removes the transitive dependency</text>

  <!-- flat table -->
  <rect x="24" y="48" width="250" height="140" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="149" y="70" text-anchor="middle" fill="#1e293b" font-weight="600">enrolment_flat (violates 3NF)</text>
  <text x="149" y="94" text-anchor="middle" fill="#64748b">student_id · dept_id · dept_name</text>
  <text x="149" y="120" text-anchor="middle" fill="#b91c1c">"Physics" stored on every row</text>
  <text x="149" y="142" text-anchor="middle" fill="#b91c1c">rename ⇒ many writes / drift</text>
  <text x="149" y="168" text-anchor="middle" fill="#64748b">emp→dept→dept_name (transitive)</text>

  <line x1="280" y1="118" x2="420" y2="118" stroke="#475569" stroke-width="1.5" marker-end="url(#arw)"/>
  <text x="350" y="108" text-anchor="middle" fill="#059669" font-weight="600">3NF split</text>

  <!-- students -->
  <rect x="430" y="52" width="260" height="86" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="560" y="74" text-anchor="middle" fill="#1e293b" font-weight="600">students</text>
  <text x="560" y="98" text-anchor="middle" fill="#64748b">student_id (PK) · dept_id (FK)</text>
  <text x="560" y="120" text-anchor="middle" fill="#64748b">no dept_name copy</text>

  <!-- departments -->
  <rect x="430" y="158" width="260" height="86" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="560" y="180" text-anchor="middle" fill="#1e293b" font-weight="600">departments</text>
  <text x="560" y="204" text-anchor="middle" fill="#64748b">dept_id (PK) · dept_name</text>
  <text x="560" y="226" text-anchor="middle" fill="#059669">one row per fact ⇒ 1 write to rename</text>

  <path d="M540,138 L540,158" stroke="#475569" stroke-width="1.5" marker-end="url(#arw)"/>
  <text x="612" y="152" text-anchor="middle" fill="#64748b">FK</text>
</svg>
```

Physically, the normalized form costs a join at read time — usually a cheap index nested-loop or hash join on the FK — but every write of the department name is a single logical row. The optimizer can also exploit the FK: knowing `students.dept_id` references a unique `departments.dept_id` lets it treat the join as at-most-one-match and pick a nested loop confidently.

## 6. Variations & Trade-offs

| Normal form | Forbids | Typical trigger | Cost of ignoring |
|-------------|---------|-----------------|------------------|
| **1NF** | Non-atomic / repeating groups | CSV lists, arrays as text | Can't index/filter/join on the values |
| **2NF** | Partial dependency on a composite key | `sku → product_name` inside `(order_id, sku)` | Product name duplicated per order line |
| **3NF** | Transitive dependency (non-prime → non-prime) | `dept_id → dept_name` in an emp table | Rename anomaly across many rows |
| **BCNF** | Any determinant that isn't a superkey | Overlapping candidate keys | Subtle update anomalies 3NF misses |
| **Denormalized** | Nothing — adds redundancy on purpose | Read-heavy reports, feeds, star schema | Sync burden; must refresh copies |

3NF is the pragmatic default: it removes essentially all redundancy while remaining **dependency-preserving** (all FDs stay enforceable within single tables). BCNF is stricter and lossless but a BCNF decomposition can *lose* a FD you'd then have to enforce with a trigger — so many shops stop at 3NF unless an overlapping-key anomaly actually appears.

Denormalization sits at the other pole. You denormalize when a hot read path pays too many joins, when aggregates are recomputed constantly, or when an analytics workload scans dimensions repeatedly. The cost is always the same: **you now own the consistency of the copy.**

## 7. Performance Notes

- **Normalized (OLTP):** writes are cheap and atomic (one fact, one row). Reads pay join cost — mitigate with indexes on every FK column, which most engines do **not** create automatically (PostgreSQL and MySQL/InnoDB index the PK but not referencing FK columns).
- **Join count is the read tax.** A deeply normalized "snowflake" can require 6–8 joins to render one screen. If EXPLAIN shows a tower of nested loops driven by that, a targeted denormalization (copy one hot attribute) often beats adding hardware.
- **Denormalized read path:** fewer joins, but writes fan out. A copied `dept_name` on `students` turns one rename into an `UPDATE … WHERE dept_id = ?` across many rows — index that column or the update itself scans.
- **Materialized aggregates** (e.g. `order_totals`) trade a real-time join+SUM for a maintained counter. Keep them correct with triggers or `REFRESH MATERIALIZED VIEW`; a stale total is worse than a slow one.
- **Star schema for OLAP:** wide dimension tables are denormalized on purpose so the fact-table scan joins each dimension once by surrogate key — column stores and hash joins love this shape.
- **Measure before you denormalize.** Confirm with EXPLAIN ANALYZE that joins (not missing indexes) are the bottleneck; a missing FK index masquerades as "too normalized" surprisingly often.

## 8. Common Mistakes

1. ⚠️ **Storing lists in one column** (`'a,b,c'`, JSON arrays used relationally). Fix: model a child table, one row per element — restores 1NF and makes the values indexable.
2. ⚠️ **Confusing "has a composite key" with "needs 2NF work."** 2NF only bites when a non-key column depends on *part* of the key. Fix: check each non-prime column against subsets of the key before splitting.
3. ⚠️ **Leaving transitive dependencies** (`zip → city → state` duplicated per row). Fix: extract the determinant into its own table and reference it.
4. ⚠️ **Denormalizing without a sync plan.** Copied columns silently rot. Fix: own the copy with triggers, application invariants, or scheduled refresh — and document it.
5. ⚠️ **Forgetting to index FK columns.** Then blaming normalization for slow joins. Fix: add an index on every referencing column used in joins/filters.
6. ⚠️ **Over-normalizing a reporting schema.** 3NF everything, then join 9 tables per dashboard. Fix: use a star schema / read model for analytics; keep 3NF for the OLTP source.
7. ⚠️ **Chasing BCNF blindly** and losing a dependency the decomposition can no longer enforce. Fix: stop at 3NF unless a concrete overlapping-key anomaly justifies the FD-enforcing trigger.

## 9. Interview Questions

**Q: What is a functional dependency, and how do normal forms relate to it?**
A: A functional dependency `X → Y` means each value of `X` determines exactly one `Y`. Normal forms are rules about which FDs may live inside one table: 2NF bans partial dependencies on a composite key, 3NF bans transitive (non-prime → non-prime) dependencies, and BCNF requires every determinant to be a superkey.

**Q: Give the three anomalies normalization removes, with an example of each.**
A: Update anomaly — a fact copied across rows drifts when only some are updated (renaming a department stored on every employee row). Insertion anomaly — you can't record fact A without fact B (can't add a department with no employees). Deletion anomaly — deleting a row destroys an unrelated fact (removing the last employee erases the department).

**Q: A table has primary key `(order_id, sku)` and a column `product_name`. Which normal form is violated and why?**
A: 2NF. `product_name` depends on `sku` alone — only *part* of the composite key — which is a partial dependency. Fix by moving `sku → product_name` into a `products` table keyed by `sku`.

**Q: What's the difference between 3NF and BCNF, and when does it actually matter?**
A: 3NF allows a determinant that isn't a superkey *if* the dependent attribute is prime; BCNF forbids that unconditionally — every determinant must be a superkey. It matters only with overlapping candidate keys (e.g. `instructor → subject` where `subject` is prime): 3NF is satisfied yet an update anomaly remains, which BCNF removes.

**Q: Why do many teams stop at 3NF rather than pushing to BCNF?**
A: 3NF is always achievable *and* dependency-preserving — every FD stays enforceable within a single table. BCNF is lossless but a BCNF decomposition can leave a FD spanning two tables, requiring a trigger or assertion to enforce. Unless a real overlapping-key anomaly appears, the extra enforcement cost isn't worth it.

**Q: When would you deliberately denormalize, and what do you take on by doing so?**
A: When a hot read path pays too many joins or recomputes aggregates constantly — reporting, feeds, dashboards. You take on the consistency of the redundant copy: every write must now update all copies via triggers, application logic, or a refresh job. Redundancy is only safe when its maintenance is owned.

**Q: What is a star schema and why is it denormalized on purpose?**
A: A central fact table of numeric measures (foreign keys to dimensions) surrounded by wide, redundant dimension tables. It's denormalized so an analytic query joins each dimension exactly once by surrogate key and scans the fact table — minimizing joins for scan-heavy OLAP aggregation, the opposite optimization from write-heavy OLTP.

**Q: You normalized a schema and reads got slower. How do you decide whether to denormalize?**
A: First run EXPLAIN ANALYZE — often the culprit is a missing index on an FK column, not normalization itself. If genuine join fan-out is the cost, denormalize the narrowest thing that helps (copy one hot attribute or maintain one aggregate), index the write path, and add a sync mechanism. Measure both read and write impact before committing.

**Q: How do foreign keys physically enforce what normalization logically requires?**
A: Normalization says a fact lives in one table; the FK makes the *reference* to that fact the only stored copy elsewhere. The FK constraint guarantees the referenced row exists (referential integrity), so there's no way to store a second, drift-prone copy of the fact — the schema enforces single-source-of-truth at write time.

**Q: Can a table be in 3NF but still have redundancy? How would you detect it?**
A: Yes — BCNF violations and multi-valued dependencies (4NF territory) leave redundancy 3NF permits. Detect it by computing the FDs, listing candidate keys, and checking whether any determinant is a non-superkey; if so, 3NF is met but BCNF isn't, and an update anomaly likely remains.

## 10. Practice

- [ ] Given `sales(invoice_id, product_id, product_name, qty, unit_price, customer_id, customer_email)`, list the FDs and decompose the table to 3NF.
- [ ] Construct a table that is in 3NF but violates BCNF (overlapping candidate keys), then decompose it and note which FD becomes cross-table.
- [ ] Take a flat `events(user_id, user_country, event_type, ts)` table and denormalize a normalized version for an OLAP star schema; identify the fact table and dimensions.
- [ ] Write triggers (or describe the logic) that keep a denormalized `order_total` column consistent as order lines are inserted, updated, and deleted.
- [ ] For a normalized orders schema, add the indexes needed so a 4-table join for an order-detail screen uses index nested loops instead of sequential scans.

## 11. Cheat Sheet

> [!TIP]
> **Normalization in one screen.**
> **FD `X → Y`** = X determines Y. **1NF**: atomic columns, no repeating groups. **2NF**: 1NF + no partial dependency on a composite key. **3NF**: 2NF + no transitive dependency (non-prime → non-prime). **BCNF**: every determinant is a superkey.
> **Anomalies** removed: update (drift), insert (can't add A without B), delete (losing an unrelated fact).
> **Default target = 3NF** (achievable + dependency-preserving). Go to BCNF only for real overlapping-key anomalies.
> **Denormalize** on evidence for read-heavy paths — then you own the copy's consistency (triggers / refresh). **Star schema** = denormalized dimensions + central fact table for OLAP.
> **Always index FK columns** — engines don't do it for you; missing FK indexes fake a "too normalized" problem.

**References:** PostgreSQL documentation (DDL, Constraints), MySQL Reference Manual (Data Definition), Kimball "The Data Warehouse Toolkit" (star schema), Use The Index, Luke, "Database Design" (Codd's normal forms)

---
*SQL Handbook — topic 28.*
