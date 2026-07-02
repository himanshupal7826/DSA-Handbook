# 32 · Stored Procedures, Functions & Triggers

> **In one line:** Functions return a value inside a query, procedures orchestrate work and control transactions, and triggers fire logic automatically on `INSERT`/`UPDATE`/`DELETE`.

---

## 1. Overview

Databases can run code, not just store data. A **function** computes and *returns* a
value (scalar, row, or table) and is meant to be called from inside a query —
`SELECT total_with_tax(id) FROM orders`. It runs within the caller's transaction and
generally can't `COMMIT` or `ROLLBACK`. A **stored procedure** is invoked with `CALL`, may
return nothing, and — crucially in PostgreSQL 11+ and most engines — *can* manage
transactions (`COMMIT`/`ROLLBACK` between steps), making it the right tool for multi-step
batch jobs and ETL.

A **trigger** is a function bound to a table that the engine fires *automatically* when a
DML event occurs. You never call it; you declare "on this event, run this." Triggers enforce
invariants, maintain derived columns, and write audit trails right where the data changes,
so no application code path can bypass them.

The power is also the danger: logic in the database is centralized and impossible to skip,
but it's invisible to application developers, hard to unit-test, versioned outside your app's
repo, and can turn a one-row `UPDATE` into a cascade of hidden work. This page covers when
that trade-off pays off and when it bites.

## 2. Core Concepts

- **Function** — returns a value; callable in SQL expressions; runs in the caller's transaction;
  no transaction control. Types: scalar, set-returning (`RETURNS TABLE`/`SETOF`).
- **Procedure** — invoked via `CALL`; need not return anything; **can `COMMIT`/`ROLLBACK`**
  (Postgres 11+, MySQL, Oracle). Use for orchestration and batching.
- **PL/pgSQL** — Postgres's procedural language: `DECLARE` variables, `IF`/`CASE`, `LOOP`/`FOR`,
  `RAISE` exceptions, `RETURN`/`RETURN NEXT`. (MySQL/SQL Server have analogous SQL/PSM, T-SQL.)
- **Trigger timing** — **`BEFORE`** (inspect/modify the row *before* it's written, e.g. fill
  derived columns, validate), **`AFTER`** (react once the change is durable, e.g. audit,
  cascade), **`INSTEAD OF`** (on views, to make them writable).
- **Trigger granularity** — **`FOR EACH ROW`** fires once per affected row (sees `NEW`/`OLD`);
  **`FOR EACH STATEMENT`** fires once per statement regardless of row count.
- **`NEW` / `OLD`** — the incoming and previous row versions available inside row-level triggers.
- **Common uses** — auditing/history, derived/denormalized columns, validation beyond `CHECK`,
  enforcing cross-row/cross-table invariants, soft-delete, view DML routing.
- **The trade-off** — centralized, unbypassable logic vs hidden control flow, testing/versioning
  friction, and performance surprises from per-row cascades.

## 3. Syntax & Examples

```sql
-- FUNCTION: returns a value, used inside queries (PL/pgSQL)
CREATE FUNCTION order_total(o_id int) RETURNS numeric AS $$
DECLARE t numeric;
BEGIN
  SELECT SUM(qty * unit_price) INTO t FROM order_items WHERE order_id = o_id;
  RETURN COALESCE(t, 0);
END;
$$ LANGUAGE plpgsql STABLE;

SELECT id, order_total(id) AS total FROM orders;   -- call in a query
```

```sql
-- PROCEDURE: orchestrates work and controls transactions
CREATE PROCEDURE settle_batch() LANGUAGE plpgsql AS $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id FROM orders WHERE status = 'pending' LOOP
    UPDATE orders SET status = 'settled' WHERE id = r.id;
    COMMIT;              -- commit each order independently (illegal in a function)
  END LOOP;
END;
$$;

CALL settle_batch();     -- procedures are CALLed, not SELECTed
```

```sql
-- TRIGGER 1 — BEFORE row: maintain a derived column + validate
CREATE FUNCTION fill_line_total() RETURNS trigger AS $$
BEGIN
  IF NEW.qty <= 0 THEN
    RAISE EXCEPTION 'qty must be positive, got %', NEW.qty;  -- validation
  END IF;
  NEW.line_total := NEW.qty * NEW.unit_price;                -- derived column
  RETURN NEW;            -- BEFORE triggers return the (possibly modified) row
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_line_total
BEFORE INSERT OR UPDATE ON order_items
FOR EACH ROW EXECUTE FUNCTION fill_line_total();
```

```sql
-- TRIGGER 2 — AFTER row: write an audit trail
CREATE FUNCTION audit_salary() RETURNS trigger AS $$
BEGIN
  INSERT INTO salary_audit(emp_id, old_salary, new_salary, changed_by, changed_at)
  VALUES (OLD.id, OLD.salary, NEW.salary, current_user, now());
  RETURN NULL;          -- AFTER trigger return value is ignored
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_salary
AFTER UPDATE OF salary ON employees
FOR EACH ROW WHEN (OLD.salary IS DISTINCT FROM NEW.salary)
EXECUTE FUNCTION audit_salary();
```

> [!NOTE]
> **Dialect notes.** MySQL: `CREATE PROCEDURE … BEGIN … END` with `DELIMITER`; triggers use
> `NEW`/`OLD` too but MySQL allows only one trigger per timing/event (older versions) and no
> transaction control inside triggers. SQL Server uses T-SQL with `AFTER`/`INSTEAD OF` and the
> `inserted`/`deleted` pseudo-tables instead of `NEW`/`OLD`.

## 4. Sample Data & Results

`order_items` before insert, with the `BEFORE` trigger `trg_line_total` installed:

| id | order_id | qty | unit_price | line_total |
|----|----------|-----|------------|------------|
| 1  | 10       | 2   | 50.00      | 100.00     |
| 2  | 10       | 1   | 30.00      | 30.00      |

```sql
INSERT INTO order_items(id, order_id, qty, unit_price) VALUES (3, 10, 4, 25.00);
-- line_total not supplied; the BEFORE trigger computes it
SELECT * FROM order_items WHERE order_id = 10;
```

Result — the trigger filled `line_total` automatically:

| id | order_id | qty | unit_price | line_total |
|----|----------|-----|------------|------------|
| 1  | 10       | 2   | 50.00      | 100.00     |
| 2  | 10       | 1   | 30.00      | 30.00      |
| 3  | 10       | 4   | 25.00      | **100.00** |

```sql
INSERT INTO order_items(id, order_id, qty, unit_price) VALUES (4, 10, 0, 25.00);
-- ERROR: qty must be positive, got 0   ← validation trigger rejects the row
```

## 5. Under the Hood

For a row-level `UPDATE`, the engine finds each matching row, fires all `BEFORE ROW` triggers
(which may alter `NEW` or abort), applies the write, then fires `AFTER ROW` triggers once the
new row version exists — all inside the *same* transaction, so a `RAISE EXCEPTION` in any
trigger rolls the statement back. Statement-level triggers bracket the whole statement, firing
once regardless of row count.

```svg
<svg viewBox="0 0 720 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L8,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Firing order of an UPDATE (row-level)</text>

  <rect x="270" y="40" width="180" height="38" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="64" text-anchor="middle" fill="#1e293b">UPDATE statement</text>

  <rect x="270" y="98" width="180" height="38" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="116" text-anchor="middle" fill="#1e293b">BEFORE ROW trigger</text>
  <text x="360" y="131" text-anchor="middle" fill="#64748b">validate · set NEW · may abort</text>

  <rect x="270" y="156" width="180" height="38" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="180" text-anchor="middle" fill="#1e293b">apply write (row changes)</text>

  <rect x="270" y="214" width="180" height="38" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="232" text-anchor="middle" fill="#1e293b">AFTER ROW trigger</text>
  <text x="360" y="247" text-anchor="middle" fill="#64748b">audit · cascade · notify</text>

  <rect x="270" y="272" width="180" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="294" text-anchor="middle" fill="#1e293b">COMMIT (durable)</text>

  <line x1="360" y1="78" x2="360" y2="96" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="360" y1="136" x2="360" y2="154" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="360" y1="194" x2="360" y2="212" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="360" y1="252" x2="360" y2="270" stroke="#475569" marker-end="url(#ar)"/>

  <rect x="480" y="98" width="210" height="96" rx="8" fill="#fff7ed" stroke="#b91c1c"/>
  <text x="585" y="122" text-anchor="middle" fill="#b91c1c" font-weight="700">RAISE EXCEPTION</text>
  <text x="585" y="142" text-anchor="middle" fill="#1e293b">anywhere in a trigger</text>
  <text x="585" y="162" text-anchor="middle" fill="#1e293b">→ whole statement</text>
  <text x="585" y="180" text-anchor="middle" fill="#1e293b">rolls back</text>
  <line x1="480" y1="140" x2="452" y2="120" stroke="#b91c1c" marker-end="url(#ar)"/>

  <text x="150" y="120" text-anchor="middle" fill="#64748b">NEW / OLD</text>
  <text x="150" y="138" text-anchor="middle" fill="#64748b">rows available</text>
  <line x1="200" y1="128" x2="268" y2="120" stroke="#475569" marker-end="url(#ar)"/>
</svg>
```

Because triggers run per row inside the transaction, an `UPDATE` touching a million rows fires
the trigger a million times — the classic reason a "simple" statement is mysteriously slow. A
trigger that itself writes another table can also fire *that* table's triggers, producing
cascades (and, if misdesigned, infinite recursion).

## 6. Variations & Trade-offs

| Aspect               | Function                    | Procedure                     | Trigger                          |
|----------------------|-----------------------------|-------------------------------|----------------------------------|
| Invocation           | inside a query (`SELECT`)   | explicit `CALL`               | automatic on DML event           |
| Returns a value      | yes (scalar/row/table)      | optional / out-params         | `NEW` (BEFORE) or ignored (AFTER)|
| Transaction control  | no (caller's txn)           | yes — `COMMIT`/`ROLLBACK`     | no (runs in triggering txn)      |
| Typical use          | computed values, reuse      | batch/ETL orchestration       | audit, derived cols, validation  |
| Can be bypassed      | n/a                         | if app doesn't call it        | never — engine enforces          |

**Business logic in the DB — the real trade-off.** *For:* it's centralized and
**unbypassable** (every write path, every client, honors it), close to the data (no round
trips), and atomic with the change. *Against:* it's **invisible** to app developers reading
application code, harder to unit-test and debug, versioned outside your app repo (migration
discipline required), and can hide expensive per-row cascades. Rule of thumb: put *data
integrity* invariants (validation, audit, derived columns) in triggers/constraints where they
can't be skipped; keep *business workflow* logic in the application where it's testable and
visible — unless unbypassability is the whole point.

## 7. Performance Notes

- **Per-row triggers scale with row count.** A bulk `UPDATE`/`COPY` fires row triggers N times;
  prefer `FOR EACH STATEMENT` (with transition tables `REFERENCING NEW TABLE`) for bulk audit.
- **Add `WHEN` conditions** so triggers skip irrelevant changes: `WHEN (OLD.salary IS DISTINCT
  FROM NEW.salary)` avoids firing on no-op updates.
- **Prefer declarative constraints** (`CHECK`, `FOREIGN KEY`, `UNIQUE`, generated columns) over
  triggers when they suffice — the planner and engine handle them far more cheaply.
- **Function volatility matters.** Mark functions `IMMUTABLE`/`STABLE` (not the default
  `VOLATILE`) when correct, so the planner can cache/inline them and use them in index
  expressions; a `VOLATILE` function in a `WHERE` is re-evaluated per row and blocks index use.
- **`SETOF`/`RETURNS TABLE` functions** are optimization fences in some engines — the planner may
  not push predicates into them. Inline SQL functions where possible.
- **Watch cascades and recursion.** Trigger A writing table B fires B's triggers; guard against
  loops and unexpected write amplification. Use `pg_trigger_depth()` to detect nesting.

## 8. Common Mistakes

1. ⚠️ **Trying to `COMMIT` inside a function.** Functions run in the caller's transaction. → Use a
   **procedure** (`CALL`) when you need transaction control.
2. ⚠️ **Forgetting `RETURN NEW` in a `BEFORE` row trigger.** Returning `NULL` silently *skips* the
   row's write. → Return `NEW` (or `NULL` deliberately to cancel the operation).
3. ⚠️ **Doing heavy work in `FOR EACH ROW` for bulk DML.** N-times overhead. → Use statement-level
   triggers with transition tables, or batch outside triggers.
4. ⚠️ **Business/workflow logic buried in triggers.** Invisible and untestable. → Keep integrity in
   the DB, workflow in the app.
5. ⚠️ **No `WHEN` guard**, so triggers fire on no-op updates and log noise. → Add
   `WHEN (OLD.x IS DISTINCT FROM NEW.x)`.
6. ⚠️ **Trigger recursion / cascade loops** (A→B→A). → Break the cycle; check `pg_trigger_depth()`.
7. ⚠️ **`VOLATILE` function in a `WHERE`/index expression**, killing index use and re-running per
   row. → Mark `STABLE`/`IMMUTABLE` when semantically correct.
8. ⚠️ **Un-versioned procedures/triggers** drifting from the app. → Manage them in migrations under
   source control like any schema change.

## 9. Interview Questions

**Q: What is the difference between a stored function and a stored procedure?**
A: A function returns a value and is called inside a query expression, running within the caller's transaction with no transaction control. A procedure is invoked with `CALL`, may return nothing, and can manage transactions (`COMMIT`/`ROLLBACK`) — making it suited to multi-step batch/ETL work.

**Q: Can a function issue `COMMIT` or `ROLLBACK`? Why or why not?**
A: No. A function executes inside the transaction that called it, so it cannot commit or roll back that transaction. If you need transaction control mid-logic, use a procedure (Postgres 11+, MySQL, Oracle all allow it in procedures).

**Q: What do `BEFORE`, `AFTER`, and `INSTEAD OF` triggers each do?**
A: `BEFORE` fires before the write and can inspect/modify `NEW` or abort — used for validation and derived columns. `AFTER` fires once the change is applied — used for auditing and cascades. `INSTEAD OF` (on views) replaces the DML, letting you make an otherwise non-updatable view writable.

**Q: What's the difference between row-level and statement-level triggers?**
A: `FOR EACH ROW` fires once per affected row and can access `NEW`/`OLD`; `FOR EACH STATEMENT` fires once per statement regardless of how many (or zero) rows changed. Statement-level (with transition tables) is far cheaper for bulk operations.

**Q: In a `BEFORE` row trigger, what happens if you return `NULL` versus `NEW`?**
A: Returning `NEW` proceeds with that (possibly modified) row. Returning `NULL` cancels the operation for that row — the `INSERT`/`UPDATE` silently doesn't happen for it. Forgetting to return `NEW` is a common bug that drops writes.

**Q: What are `NEW` and `OLD`?**
A: Pseudo-records available in row-level triggers: `NEW` is the incoming row (for `INSERT`/`UPDATE`), `OLD` is the prior version (for `UPDATE`/`DELETE`). You read them to compute derived values or write audit rows. (SQL Server uses `inserted`/`deleted` tables instead.)

**Q: How would you implement an audit log of salary changes?**
A: An `AFTER UPDATE OF salary` row trigger that inserts `OLD.salary`, `NEW.salary`, `current_user`, and `now()` into an audit table, guarded by `WHEN (OLD.salary IS DISTINCT FROM NEW.salary)` so it only logs real changes. `AFTER` guarantees the change is applied before logging.

**Q: Why can a simple one-line `UPDATE` become surprisingly slow?**
A: A `FOR EACH ROW` trigger on the table fires once per affected row, so a bulk update runs the trigger body thousands of times, and each may cascade into other tables' triggers. Row-level trigger overhead and hidden cascades are a classic cause of mystery slowness.

**Q: What are the trade-offs of putting business logic in the database?**
A: Pros: centralized, atomic with the data, and unbypassable across all clients/paths. Cons: invisible to app developers, harder to unit-test and debug, versioned outside the app repo, and prone to hidden per-row/cascade cost. Put integrity invariants in the DB; keep workflow logic in the app.

**Q: When should you use a declarative constraint instead of a trigger?**
A: Whenever the rule is expressible as `CHECK`, `FOREIGN KEY`, `UNIQUE`, `NOT NULL`, or a generated column. Constraints are cheaper, are understood by the optimizer, and can't be accidentally disabled — use triggers only for logic constraints can't express (cross-row audit, complex conditional validation).

**Q: How do you prevent trigger recursion or unintended cascades?**
A: Avoid triggers that write back to their own table on the same event; add guards so they no-op when nothing relevant changed; and detect nesting depth with `pg_trigger_depth()` (or the engine's equivalent) to short-circuit recursion.

**Q: Why does function volatility (`IMMUTABLE`/`STABLE`/`VOLATILE`) matter for performance?**
A: The planner can inline/cache `IMMUTABLE`/`STABLE` functions and use them in index expressions or evaluate them once, whereas a `VOLATILE` function in a `WHERE` clause is re-run for every row and prevents index-based access. Marking volatility correctly can change a plan from a seq scan to an index scan.

## 10. Practice

- [ ] Write a `BEFORE INSERT OR UPDATE` trigger that computes `line_total = qty * unit_price` and rejects `qty <= 0`.
- [ ] Add an `AFTER UPDATE` audit trigger with a `WHEN` guard that only logs when the value actually changes.
- [ ] Convert a bulk-audit row trigger to a statement-level trigger using transition tables.
- [ ] Write a procedure that loops over pending orders and `COMMIT`s each one independently, and explain why a function can't.
- [ ] Make a 2-table join view writable with `INSTEAD OF INSERT` / `UPDATE` triggers.

## 11. Cheat Sheet

> [!TIP]
> **Function** = returns a value, called in queries, caller's txn, *no* commit — mark
> `STABLE`/`IMMUTABLE` for planner wins. **Procedure** = `CALL`ed, controls transactions
> (`COMMIT`/`ROLLBACK`) — use for batch/ETL. **Trigger** = auto-fires on DML: `BEFORE` (validate,
> set `NEW`, return `NEW`!), `AFTER` (audit, cascade), `INSTEAD OF` (writable views); `FOR EACH
> ROW` sees `NEW`/`OLD` but costs N×, `FOR EACH STATEMENT` fires once. Add `WHEN` guards, prefer
> declarative constraints, watch cascades/recursion. DB logic = unbypassable but invisible &
> hard to test → integrity in DB, workflow in the app.

**References:** PostgreSQL docs — PL/pgSQL, CREATE FUNCTION / CREATE PROCEDURE, Trigger Functions & CREATE TRIGGER; MySQL Reference Manual — Stored Programs and Triggers; Use The Index, Luke

---
*SQL Handbook — topic 32.*
