# 14 · Transactions, Locking & Race Conditions

> **In one line:** Django runs in autocommit, so every query is its own transaction until you say otherwise; `transaction.atomic()` groups work (nesting with savepoints), `on_commit` defers side effects until the data is durable, and correctness under concurrency comes from pushing the decision into the database — `F()` updates, `select_for_update()` row locks, version checks and unique constraints — never from "read in Python, then write".

---

## 1. Overview

> **Builds on:** [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) · [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization)

Consider the code almost every e-commerce project writes in week one:

```python
def buy(request, product_id):
    product = Product.objects.get(pk=product_id)
    if product.stock > 0:
        product.stock -= 1
        product.save()
        Order.objects.create(user=request.user, product=product)
        send_confirmation_email.delay(request.user.id)
    ...
```

It has four bugs, none of which show up in development:

1. **Lost update.** Two requests read `stock = 1` at the same time, both pass the check, both write `stock = 0`. You sold two items and recorded one decrement.
2. **Oversell.** Same race, viewed from the business: the check-then-act is not atomic.
3. **Partial failure.** If `Order.objects.create` raises after `product.save()` committed (autocommit!), stock is decremented with no order.
4. **Phantom side effect.** The email task is enqueued before anything is guaranteed committed; if a later step rolls back, the customer gets a confirmation for an order that doesn't exist — or the worker runs before the commit and can't find the row.

Each has a precise fix: `atomic()` for (3), `on_commit()` for (4), and for (1)/(2) either an atomic conditional update (`filter(stock__gt=0).update(stock=F("stock") - 1)`) or a row lock (`select_for_update()`). This chapter is about knowing which fix applies, what SQL it produces, and what new failure modes (deadlocks, lock waits, serialization errors) it introduces.

> **Why this matters:** Interviewers love concurrency because it separates people who have run Django under load from those who haven't. Expect: "what does `atomic` do when nested?", "what's `select_for_update` and why must it be inside a transaction?", "how do you prevent two users booking the same seat?", "why enqueue Celery tasks with `on_commit`?".

## 2. Core Concepts

- **Autocommit** — Django's default: each SQL statement is committed immediately unless inside `atomic()`. *Why:* `save()` followed by another `save()` is two independent transactions; a crash between them leaves half the work.
- **`transaction.atomic(using=None, savepoint=True, durable=False)`** — decorator or context manager; outermost block opens a transaction, inner blocks create **savepoints**. *Why:* all-or-nothing units of work, composable across functions.
- **Savepoint** — a named point inside a transaction you can roll back to without aborting the whole transaction. *Why:* lets an inner failure be recovered while the outer work continues.
- **`durable=True`** (3.2+) — raises `RuntimeError` if the block is nested in another atomic. *Why:* guarantees "when this block exits, it's committed" (e.g. payment ledger writes).
- **`ATOMIC_REQUESTS`** — per-database setting wrapping each view in `atomic()`; opt out with `@transaction.non_atomic_requests`. *Why:* simple safety net, but holds a transaction for the entire view, including slow external calls.
- **`transaction.on_commit(func, using=None, robust=False)`** — register a callback to run after the outermost transaction commits; discarded on rollback. `robust=True` (4.2+) logs and continues if the callback raises. *Why:* the correct place to enqueue Celery tasks, send emails, publish events.
- **`transaction.set_rollback(True)`** — mark the current atomic block for rollback without raising. *Why:* lets you return a response while still discarding work.
- **Race condition** — correctness depends on interleaving of concurrent operations. *Why:* Gunicorn workers, Celery workers and multiple pods all run concurrently against one database.
- **Lost update** — two read-modify-write cycles overlap; one write overwrites the other. *Why:* the most common race in Django code (`obj.x += 1; obj.save()`).
- **`F()` expression update** — `update(x=F("x") + 1)` computes in SQL from the current row value. *Why:* the database serializes row updates, so no update is lost.
- **`select_for_update(nowait=False, skip_locked=False, of=(), no_key=False)`** — `SELECT … FOR UPDATE` row locks held until the transaction ends. *Why:* pessimistic locking for check-then-act across several statements.
- **Optimistic locking** — read a `version`, update `WHERE version = v`, treat 0 rows updated as a conflict. *Why:* no locks held while the user thinks; detects concurrent edits.
- **Isolation level** — READ COMMITTED (PostgreSQL default, and Django's), REPEATABLE READ, SERIALIZABLE. *Why:* determines which anomalies the DB prevents; higher levels raise serialization errors you must retry.
- **Deadlock** — two transactions each wait for a lock the other holds; PostgreSQL detects it and aborts one. *Why:* the price of row locking; prevented by consistent lock order.

## 3. Theory & Principles

### 3.1 How `atomic()` works internally

`transaction.atomic` returns an `Atomic` object (a `ContextDecorator`). In `__enter__` it looks at `connection.in_atomic_block`:

- **Outermost block:** sets `connection.set_autocommit(False)` (the driver will `BEGIN` on the next statement), sets `in_atomic_block = True`, and starts collecting `on_commit` callbacks in `connection.run_on_commit`.
- **Nested block:** if `savepoint=True` (default), calls `connection.savepoint()` which emits `SAVEPOINT "s140234_x1"` and pushes the id onto `connection.savepoint_ids`.

In `__exit__`:

- **No exception, nested:** `RELEASE SAVEPOINT …`.
- **No exception, outermost:** `connection.commit()`, then run the `on_commit` callbacks, then restore autocommit.
- **Exception, nested:** `ROLLBACK TO SAVEPOINT …` and re-raise.
- **Exception, outermost:** `connection.rollback()`, discard callbacks, re-raise.

`connection.needs_rollback` is the flag that ties it together: if a database error happens and isn't handled by a nested atomic, the connection is marked broken, and any further query in that atomic block raises `TransactionManagementError: An error occurred in the current transaction. You can't execute queries until the end of the 'atomic' block.` PostgreSQL itself refuses statements in an aborted transaction (`current transaction is aborted, commands ignored until end of transaction block`), and Django surfaces it early.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj14a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Nested atomic(): savepoints, partial rollback, and on_commit</text>
  <path d="M30,60 L850,60" stroke="#334155" stroke-width="2" marker-end="url(#dj14a)"/>
  <text x="845" y="52" text-anchor="end" fill="#334155" font-size="10">time</text>
  <rect x="40" y="76" width="800" height="230" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="56" y="96" fill="#1e3a8a" font-size="12" font-weight="bold">with atomic():   (outer &#8212; BEGIN)</text>
  <rect x="60" y="108" width="150" height="30" rx="5" fill="#fff" stroke="#2563eb"/><text x="135" y="127" text-anchor="middle" fill="#1e293b" font-size="10">INSERT order</text>
  <rect x="230" y="108" width="270" height="110" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="244" y="126" fill="#7f1d1d" font-size="11" font-weight="bold">try: with atomic():  SAVEPOINT s1</text>
  <rect x="244" y="136" width="110" height="26" rx="5" fill="#fff" stroke="#dc2626"/><text x="299" y="153" text-anchor="middle" fill="#7f1d1d" font-size="10">INSERT coupon_use</text>
  <rect x="368" y="136" width="120" height="26" rx="5" fill="#fff" stroke="#dc2626"/><text x="428" y="153" text-anchor="middle" fill="#7f1d1d" font-size="10">IntegrityError!</text>
  <text x="244" y="182" fill="#7f1d1d" font-size="10">ROLLBACK TO SAVEPOINT s1</text>
  <text x="244" y="200" fill="#7f1d1d" font-size="10">except IntegrityError: (outside inner block)</text>
  <rect x="520" y="108" width="150" height="30" rx="5" fill="#fff" stroke="#2563eb"/><text x="595" y="127" text-anchor="middle" fill="#1e293b" font-size="10">UPDATE stock (F)</text>
  <rect x="520" y="150" width="150" height="40" rx="5" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="595" y="166" text-anchor="middle" fill="#4c1d95" font-size="10">on_commit(send_email)</text>
  <text x="595" y="182" text-anchor="middle" fill="#4c1d95" font-size="9">queued, not run</text>
  <rect x="690" y="108" width="135" height="82" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="757" y="128" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">COMMIT</text>
  <text x="757" y="146" text-anchor="middle" fill="#14532d" font-size="10">order + stock durable</text>
  <text x="757" y="164" text-anchor="middle" fill="#14532d" font-size="10">coupon_use absent</text>
  <text x="757" y="182" text-anchor="middle" fill="#7c3aed" font-size="10">then send_email runs</text>
  <text x="60" y="246" fill="#1e293b" font-size="10">Outer block survives because the inner failure was contained by its own savepoint.</text>
  <text x="60" y="264" fill="#1e293b" font-size="10">If the outer block raised instead: ROLLBACK everything, and the on_commit callback is discarded &#8212; no email.</text>
  <text x="60" y="282" fill="#1e293b" font-size="10">Callbacks registered inside a rolled-back savepoint are discarded too.</text>
  <rect x="40" y="318" width="800" height="70" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="56" y="338" fill="#78350f" font-size="11" font-weight="bold">Anti-pattern: catching the DB error INSIDE the atomic block without a nested atomic</text>
  <text x="56" y="358" fill="#78350f" font-size="10">with atomic(): try: create_dup() except IntegrityError: pass;  Order.objects.count()</text>
  <text x="56" y="376" fill="#78350f" font-size="10">&#8594; TransactionManagementError: the transaction is aborted; no savepoint existed to roll back to.</text>
</svg>
```

### 3.2 The lost update, and the three fixes

Under READ COMMITTED, each statement sees data committed before *that statement* began. Two transactions doing `SELECT stock` then `UPDATE … SET stock = <python value>` both read 1 and both write 0. The database did nothing wrong: you told it to set `stock = 0` twice.

**Fix 1 — atomic SQL update.** `Product.objects.filter(pk=pid, stock__gt=0).update(stock=F("stock") - 1)` compiles to `UPDATE product SET stock = stock - 1 WHERE id = 42 AND stock > 0`. PostgreSQL takes a row lock for the UPDATE; the second transaction waits, then **re-evaluates the WHERE clause against the new row version** (READ COMMITTED's "EvalPlanQual" re-check), sees `stock = 0`, and updates zero rows. The return value (rows affected) tells you whether you won. One statement, no explicit lock, no race. Use it whenever the decision fits in a WHERE clause.

**Fix 2 — pessimistic lock.** `select_for_update()` makes the *read* take the row lock: `SELECT … FOR UPDATE`. The second transaction blocks on its SELECT until the first commits, then reads the fresh value. Use it when the decision needs Python logic or several rows/tables (check balance, check limits, write ledger entries, update status).

**Fix 3 — optimistic lock.** Don't lock; detect. Store a `version` integer, update `WHERE id = 42 AND version = 7` setting `version = 8`; zero rows means someone else changed it — reload and retry or report a conflict. Use it when conflicts are rare and the read happens long before the write (an edit form, an API PATCH with an ETag; see [REST API · Concurrency & Optimistic Locking](../rest-api/topic.html?p=28-concurrency-optimistic-locking)).

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj14b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="dj14c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two buyers, one item in stock</text>
  <rect x="20" y="40" width="410" height="360" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="225" y="62" text-anchor="middle" fill="#7f1d1d" font-size="12" font-weight="bold">Read-modify-write in Python (lost update)</text>
  <text x="70" y="86" text-anchor="middle" fill="#7f1d1d" font-weight="bold">Worker A</text>
  <text x="380" y="86" text-anchor="middle" fill="#7f1d1d" font-weight="bold">Worker B</text>
  <rect x="30" y="98" width="150" height="26" rx="4" fill="#fff" stroke="#dc2626"/><text x="105" y="115" text-anchor="middle" fill="#7f1d1d" font-size="10">SELECT stock &#8594; 1</text>
  <rect x="270" y="134" width="150" height="26" rx="4" fill="#fff" stroke="#dc2626"/><text x="345" y="151" text-anchor="middle" fill="#7f1d1d" font-size="10">SELECT stock &#8594; 1</text>
  <rect x="30" y="170" width="150" height="26" rx="4" fill="#fff" stroke="#dc2626"/><text x="105" y="187" text-anchor="middle" fill="#7f1d1d" font-size="10">1 &gt; 0, stock = 0</text>
  <rect x="270" y="206" width="150" height="26" rx="4" fill="#fff" stroke="#dc2626"/><text x="345" y="223" text-anchor="middle" fill="#7f1d1d" font-size="10">1 &gt; 0, stock = 0</text>
  <rect x="30" y="242" width="150" height="26" rx="4" fill="#fff" stroke="#dc2626"/><text x="105" y="259" text-anchor="middle" fill="#7f1d1d" font-size="10">UPDATE SET stock=0</text>
  <rect x="270" y="278" width="150" height="26" rx="4" fill="#fff" stroke="#dc2626"/><text x="345" y="295" text-anchor="middle" fill="#7f1d1d" font-size="10">UPDATE SET stock=0</text>
  <path d="M182,111 L268,141" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4,3" marker-end="url(#dj14b)"/>
  <text x="225" y="340" text-anchor="middle" fill="#dc2626" font-size="11" font-weight="bold">2 orders created, stock 0: oversold by one</text>
  <text x="225" y="362" text-anchor="middle" fill="#7f1d1d" font-size="10">atomic() alone does NOT fix this under READ COMMITTED:</text>
  <text x="225" y="380" text-anchor="middle" fill="#7f1d1d" font-size="10">plain SELECT takes no lock.</text>
  <rect x="450" y="40" width="410" height="360" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="655" y="62" text-anchor="middle" fill="#14532d" font-size="12" font-weight="bold">select_for_update() inside atomic()</text>
  <text x="500" y="86" text-anchor="middle" fill="#14532d" font-weight="bold">Worker A</text>
  <text x="810" y="86" text-anchor="middle" fill="#14532d" font-weight="bold">Worker B</text>
  <rect x="460" y="98" width="170" height="26" rx="4" fill="#fff" stroke="#16a34a"/><text x="545" y="115" text-anchor="middle" fill="#14532d" font-size="10">SELECT ... FOR UPDATE &#8594; 1</text>
  <rect x="680" y="134" width="170" height="40" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="765" y="151" text-anchor="middle" fill="#78350f" font-size="10">SELECT ... FOR UPDATE</text><text x="765" y="166" text-anchor="middle" fill="#78350f" font-size="10">BLOCKED on row lock</text>
  <rect x="460" y="184" width="170" height="26" rx="4" fill="#fff" stroke="#16a34a"/><text x="545" y="201" text-anchor="middle" fill="#14532d" font-size="10">UPDATE stock=0, INSERT order</text>
  <rect x="460" y="220" width="170" height="26" rx="4" fill="#fff" stroke="#16a34a"/><text x="545" y="237" text-anchor="middle" fill="#14532d" font-size="10">COMMIT (lock released)</text>
  <path d="M632,233 L678,268" stroke="#16a34a" stroke-width="1.5" marker-end="url(#dj14c)"/>
  <rect x="680" y="256" width="170" height="40" rx="4" fill="#fff" stroke="#16a34a"/><text x="765" y="273" text-anchor="middle" fill="#14532d" font-size="10">unblocks, reads stock = 0</text><text x="765" y="288" text-anchor="middle" fill="#14532d" font-size="10">"sold out" &#8594; no order</text>
  <text x="655" y="330" text-anchor="middle" fill="#16a34a" font-size="11" font-weight="bold">Correct: exactly one order</text>
  <text x="655" y="352" text-anchor="middle" fill="#14532d" font-size="10">Equivalent single statement: UPDATE ... SET stock = stock - 1</text>
  <text x="655" y="370" text-anchor="middle" fill="#14532d" font-size="10">WHERE id = 42 AND stock &gt; 0   (check rowcount)</text>
</svg>
```

### 3.3 Isolation levels in Django

Django uses the database's default — READ COMMITTED on PostgreSQL. You can change it per database:

```python
# settings.py  (psycopg 3)
from psycopg import IsolationLevel
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        # ...
        "OPTIONS": {"isolation_level": IsolationLevel.SERIALIZABLE},
    }
}
```

At REPEATABLE READ and SERIALIZABLE, PostgreSQL never lets you silently overwrite a concurrent change; instead it aborts with a **serialization failure** (`could not serialize access due to concurrent update`, SQLSTATE `40001`), surfaced as `django.db.OperationalError`. That's safer, but every transaction must then be **retried** on that error — which means your atomic blocks must be idempotent and must not trigger external side effects before commit (another reason for `on_commit`). Most Django apps stay on READ COMMITTED and use targeted `F()`/`select_for_update()`/constraints. Background: [SQL · Isolation Levels](../sql/topic.html?p=26-isolation-levels), [Database Design · Isolation Deep Dive](../database-design/topic.html?p=06-isolation-deep-dive), [Database Design · MVCC](../database-design/topic.html?p=03-mvcc).

### 3.4 What `select_for_update` really locks

- It must be **evaluated inside `atomic()`** (or with autocommit disabled); evaluating it in autocommit raises `TransactionManagementError: select_for_update cannot be used outside of a transaction.` Without a transaction the lock would be released immediately after the SELECT, so Django refuses.
- The lock is acquired when the QuerySet is **evaluated**, not when it's built; it's released at **COMMIT/ROLLBACK** of the outermost transaction — not at the end of the inner `atomic` block.
- With `select_related`, PostgreSQL locks rows of **all joined tables** unless you restrict it with `of=("self",)` (or names of related fields). Locking the nullable side of an outer join isn't allowed on PostgreSQL; use `of=` to exclude it.
- `nowait=True` → raise `DatabaseError` immediately if the row is locked. `skip_locked=True` → silently skip locked rows (job queues). `no_key=True` → `FOR NO KEY UPDATE`, a weaker lock that doesn't block inserts of rows with an FK to the locked row — usually what you want when you're not changing the primary key.
- Under `TestCase` everything runs inside a transaction, so `select_for_update` "works" in tests even if your production code forgot `atomic()`. Use `TransactionTestCase` to catch that.

The PostgreSQL lock modes are covered in [SQL · Locking & MVCC](../sql/topic.html?p=27-locking-mvcc) and [Database Design · Locking Internals](../database-design/topic.html?p=05-locking-internals).

## 4. Architecture & Workflow

### 4.1 Where side effects belong

```svg
<svg viewBox="0 0 880 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj14d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">task.delay() inside vs after the transaction</text>
  <rect x="20" y="40" width="400" height="230" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="220" y="62" text-anchor="middle" fill="#7f1d1d" font-size="12" font-weight="bold">delay() inside atomic()</text>
  <rect x="40" y="76" width="130" height="28" rx="5" fill="#fff" stroke="#dc2626"/><text x="105" y="94" text-anchor="middle" fill="#7f1d1d" font-size="10">INSERT order 99</text>
  <rect x="40" y="112" width="130" height="28" rx="5" fill="#fff" stroke="#dc2626"/><text x="105" y="130" text-anchor="middle" fill="#7f1d1d" font-size="10">task.delay(99)</text>
  <path d="M172,126 L246,126" stroke="#dc2626" stroke-width="2" marker-end="url(#dj14d)"/>
  <rect x="250" y="112" width="150" height="44" rx="5" fill="#fff" stroke="#dc2626"/>
  <text x="325" y="130" text-anchor="middle" fill="#7f1d1d" font-size="10">worker: Order.get(99)</text>
  <text x="325" y="146" text-anchor="middle" fill="#7f1d1d" font-size="10">DoesNotExist (not committed)</text>
  <rect x="40" y="148" width="130" height="28" rx="5" fill="#fff" stroke="#dc2626"/><text x="105" y="166" text-anchor="middle" fill="#7f1d1d" font-size="10">charge fails &#8594; ROLLBACK</text>
  <text x="40" y="206" fill="#7f1d1d" font-size="10">Two failures: the worker may run before COMMIT,</text>
  <text x="40" y="224" fill="#7f1d1d" font-size="10">and after ROLLBACK the task still runs for an</text>
  <text x="40" y="242" fill="#7f1d1d" font-size="10">order that never existed.</text>
  <rect x="460" y="40" width="400" height="230" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="660" y="62" text-anchor="middle" fill="#14532d" font-size="12" font-weight="bold">transaction.on_commit(lambda: task.delay(99))</text>
  <rect x="480" y="76" width="130" height="28" rx="5" fill="#fff" stroke="#16a34a"/><text x="545" y="94" text-anchor="middle" fill="#14532d" font-size="10">INSERT order 99</text>
  <rect x="480" y="112" width="130" height="28" rx="5" fill="#fff" stroke="#16a34a"/><text x="545" y="130" text-anchor="middle" fill="#14532d" font-size="10">register callback</text>
  <rect x="480" y="148" width="130" height="28" rx="5" fill="#fff" stroke="#16a34a"/><text x="545" y="166" text-anchor="middle" fill="#14532d" font-size="10">COMMIT</text>
  <path d="M612,162 L686,162" stroke="#16a34a" stroke-width="2" marker-end="url(#dj14d)"/>
  <rect x="690" y="140" width="150" height="44" rx="5" fill="#fff" stroke="#16a34a"/>
  <text x="765" y="158" text-anchor="middle" fill="#14532d" font-size="10">then delay(99)</text>
  <text x="765" y="174" text-anchor="middle" fill="#14532d" font-size="10">worker finds the row</text>
  <text x="480" y="206" fill="#14532d" font-size="10">On ROLLBACK the callback is dropped. Remaining gap:</text>
  <text x="480" y="224" fill="#14532d" font-size="10">process dies between COMMIT and delay() &#8594; task lost.</text>
  <text x="480" y="242" fill="#14532d" font-size="10">If that matters, use a transactional outbox table.</text>
</svg>
```

The remaining gap — commit succeeded, process crashed before the broker accepted the task — is the dual-write problem. If losing that message is unacceptable (payments, ledger events), write an outbox row in the same transaction and relay it; see [Messaging · Idempotency & the Outbox Pattern](../messaging/topic.html?p=21-idempotency-outbox) and [Ch 31 · Celery](topic.html?p=31-celery-background-tasks).

### 4.2 Choosing a concurrency strategy

```text
Is the change expressible as one UPDATE with a WHERE condition?
   yes -> filter(cond).update(col=F(col) +/- n); check rowcount          (no explicit lock)
   no  -> Does the decision need several reads/rows, done within one request?
            yes -> atomic() + select_for_update() (lock in a consistent order; no_key=True)
            no  -> Long gap between read and write (forms, mobile edits)?
                     yes -> optimistic version column / ETag + If-Match
Is the invariant "only one row like this may exist"?
   -> UniqueConstraint (+ get_or_create / IntegrityError handling) — the DB enforces it
Is it a work queue (claim the next N jobs)?
   -> select_for_update(skip_locked=True)
Is it "only one process may run this job" (cron, migration, report)?
   -> pg_advisory_xact_lock or a Redis lock with TTL
```

## 5. Implementation

### 5.1 Simple example: `atomic` basics

```python
from django.db import IntegrityError, transaction

# As a decorator: the whole function is one transaction
@transaction.atomic
def transfer(src_id, dst_id, amount):
    Account.objects.filter(pk=src_id).update(balance=F("balance") - amount)
    Account.objects.filter(pk=dst_id).update(balance=F("balance") + amount)

# As a context manager, with a recoverable inner step
def place_order(user, cart, coupon_code):
    with transaction.atomic():
        order = Order.objects.create(user=user, total=cart.total)
        try:
            with transaction.atomic():                 # savepoint
                CouponUse.objects.create(order=order, code=coupon_code)   # unique (user, code)
        except IntegrityError:
            order.note = "coupon already used"         # outer transaction still healthy
            order.save(update_fields=["note"])
        transaction.on_commit(lambda: send_receipt.delay(order.pk))
    return order
```

The SQL Django emits for `place_order` when the coupon is a duplicate:

```sql
BEGIN;
INSERT INTO "shop_order" ("user_id", "total", "note") VALUES (7, 120.00, '') RETURNING "shop_order"."id";
SAVEPOINT "s139823_x1";
INSERT INTO "shop_couponuse" ("order_id", "code") VALUES (99, 'WELCOME');
-- ERROR: duplicate key value violates unique constraint
ROLLBACK TO SAVEPOINT "s139823_x1";
UPDATE "shop_order" SET "note" = 'coupon already used' WHERE "shop_order"."id" = 99;
COMMIT;
-- then: send_receipt.delay(99)
```

And the broken version — catching inside without a savepoint:

```python
with transaction.atomic():
    order = Order.objects.create(...)
    try:
        CouponUse.objects.create(order=order, code=code)
    except IntegrityError:
        pass
    order.save()     # TransactionManagementError
```

### 5.2 Atomic counters with `F()`

```python
from django.db.models import F

# Increment safely
Article.objects.filter(pk=aid).update(views=F("views") + 1)

# On an instance: save() writes the expression, not a value
article.views = F("views") + 1
article.save(update_fields=["views"])
article.refresh_from_db(fields=["views"])     # otherwise article.views is still the F() object

# Conditional decrement (oversell-proof) — the WHERE clause is the guard
sold = Product.objects.filter(pk=pid, stock__gte=qty).update(stock=F("stock") - qty)
if sold == 0:
    raise OutOfStock()
```

```sql
UPDATE "shop_product" SET "stock" = ("shop_product"."stock" - 2)
WHERE ("shop_product"."id" = 42 AND "shop_product"."stock" >= 2);
```

Pair it with a database constraint so even buggy code paths can't go negative: `models.CheckConstraint(condition=Q(stock__gte=0), name="stock_non_negative")` (in 5.1+ the kwarg is `condition`; `check=` is deprecated). See [Ch 16](topic.html?p=16-database-features-postgres).

### 5.3 Real-world example: seat booking with `select_for_update`

Requirements: a user holds up to 4 seats for a show; a seat can be held by one user; holds expire after 10 minutes; payments are confirmed later. The decision involves several rows (the seats, the user's existing holds), so a single UPDATE doesn't fit.

```python
# booking/models.py
from django.conf import settings
from django.db import models
from django.db.models import Q

class Seat(models.Model):
    class Status(models.TextChoices):
        FREE = "free"; HELD = "held"; SOLD = "sold"
    show = models.ForeignKey("Show", on_delete=models.CASCADE, related_name="seats")
    label = models.CharField(max_length=8)
    status = models.CharField(max_length=4, choices=Status.choices, default=Status.FREE)
    held_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL)
    held_until = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["show", "label"], name="seat_unique_label"),
            models.CheckConstraint(
                condition=Q(status="free") | Q(held_by__isnull=False),
                name="seat_held_has_holder",
            ),
        ]
```

```python
# booking/services.py
from datetime import timedelta
from django.db import transaction, DatabaseError
from django.db.models import Q
from django.utils import timezone
from .models import Seat

MAX_SEATS = 4

class SeatUnavailable(Exception): ...
class TooManySeats(Exception): ...
class TryAgain(Exception): ...

def hold_seats(user, show_id, labels):
    now = timezone.now()
    try:
        with transaction.atomic():
            seats = list(
                Seat.objects.select_for_update(nowait=True, no_key=True)
                .filter(show_id=show_id, label__in=labels)
                .order_by("pk")                 # consistent lock order prevents deadlocks
            )
            if len(seats) != len(set(labels)):
                raise SeatUnavailable("unknown seat")
            for s in seats:
                expired = s.status == Seat.Status.HELD and s.held_until and s.held_until < now
                if s.status != Seat.Status.FREE and not expired:
                    raise SeatUnavailable(s.label)

            already = (Seat.objects.filter(show_id=show_id, held_by=user, status=Seat.Status.HELD,
                                           held_until__gte=now)
                       .exclude(pk__in=[s.pk for s in seats]).count())
            if already + len(seats) > MAX_SEATS:
                raise TooManySeats()

            until = now + timedelta(minutes=10)
            Seat.objects.filter(pk__in=[s.pk for s in seats]).update(
                status=Seat.Status.HELD, held_by=user, held_until=until)
            transaction.on_commit(lambda: expire_hold.apply_async((show_id, [s.pk for s in seats]),
                                                                  eta=until))
            return seats
    except DatabaseError as exc:                 # nowait: someone else holds the lock right now
        if "could not obtain lock" in str(exc):
            raise TryAgain() from exc
        raise
```

```sql
BEGIN;
SELECT "booking_seat"."id", "booking_seat"."show_id", "booking_seat"."label", ...
FROM "booking_seat"
WHERE ("booking_seat"."label" IN ('A1', 'A2') AND "booking_seat"."show_id" = 3)
ORDER BY "booking_seat"."id" ASC
FOR NO KEY UPDATE NOWAIT;
SELECT COUNT(*) AS "__count" FROM "booking_seat" WHERE (... "held_by_id" = 7 ...);
UPDATE "booking_seat" SET "status" = 'held', "held_by_id" = 7, "held_until" = '...' WHERE "booking_seat"."id" IN (11, 12);
COMMIT;
```

Notes on the design:

- `order_by("pk")` makes every transaction lock seats in the same order, so two users grabbing overlapping seat sets can't deadlock each other.
- `nowait=True` turns a contended seat into an instant "try again" instead of a request hanging on a lock — good UX on a hot show. Plain blocking is fine for low-contention cases.
- The user-limit check (`already`) reads rows that aren't locked; two concurrent requests by the same user for different seats could both pass. If that matters, lock a per-user-per-show row (e.g. a `Cart` row) first — always lock a **single parent row** to serialize a user's actions.
- The DB constraints are the last line of defence.

### 5.4 A job queue with `skip_locked`

```python
def claim_jobs(worker_id, n=10):
    with transaction.atomic():
        jobs = list(
            Job.objects.select_for_update(skip_locked=True)
            .filter(status="queued").order_by("priority", "id")[:n]
        )
        Job.objects.filter(pk__in=[j.pk for j in jobs]).update(status="running", worker=worker_id)
    return jobs
```

```sql
SELECT ... FROM "jobs_job" WHERE "jobs_job"."status" = 'queued'
ORDER BY "jobs_job"."priority" ASC, "jobs_job"."id" ASC LIMIT 10 FOR UPDATE SKIP LOCKED;
```

Ten workers running this concurrently each get a disjoint batch without waiting on each other.

### 5.5 Optimistic locking with a version column

```python
class Document(models.Model):
    title = models.CharField(max_length=200)
    body = models.TextField()
    version = models.PositiveIntegerField(default=1)

class Conflict(Exception): ...

def save_document(doc_id, expected_version, **changes):
    updated = Document.objects.filter(pk=doc_id, version=expected_version).update(
        **changes, version=F("version") + 1)
    if updated == 0:
        raise Conflict("document changed since you loaded it")
```

In an API, return the version as an `ETag` and require `If-Match`; respond `412 Precondition Failed` on conflict.

### 5.6 `get_or_create` and unique races

`get_or_create(**lookup)` does `get()`, and on `DoesNotExist` tries `create()` inside a savepoint; if that raises `IntegrityError`, it retries the `get()`. This is race-safe **only if a unique constraint covers the lookup fields** — without one, two concurrent calls both create and you get duplicates (and later `MultipleObjectsReturned`). `update_or_create` locks the existing row with `select_for_update()` inside its own `atomic()`, but the *create* branch has the same requirement: without a unique constraint, two callers can both insert. Always back "only one" invariants with `UniqueConstraint`.

### 5.7 Testing transactional behaviour

```python
from django.test import TestCase, TransactionTestCase

class ReceiptTests(TestCase):
    def test_receipt_enqueued_on_commit(self):
        with self.captureOnCommitCallbacks(execute=True) as callbacks:
            place_order(self.user, self.cart, "WELCOME")
        self.assertEqual(len(callbacks), 1)

class OversellTests(TransactionTestCase):           # real commits, real locks
    def test_two_buyers_one_item(self):
        import threading
        from django.db import connection
        product = Product.objects.create(stock=1)
        results = []
        def buy():
            try:
                results.append(buy_one(product.pk))
            finally:
                connection.close()                   # each thread has its own connection
        threads = [threading.Thread(target=buy) for _ in range(2)]
        [t.start() for t in threads]; [t.join() for t in threads]
        self.assertEqual(sorted(results), [False, True])
```

`TestCase` wraps each test in a transaction that is rolled back, so `on_commit` callbacks never fire unless you use `captureOnCommitCallbacks`, and missing `atomic()` around `select_for_update` isn't detected. See [Ch 33 · Testing](topic.html?p=33-testing).

## 6. Advantages, Disadvantages & Trade-offs

| Strategy | Prevents | Cost | Failure mode | Best for |
|---|---|---|---|---|
| `atomic()` | Partial writes | Holds locks/snapshot until commit | Long transactions block others | Any multi-write unit |
| `ATOMIC_REQUESTS=True` | Partial writes per view | Transaction spans whole view (incl. HTTP calls, templates) | Pool exhaustion, lock hold time | Small apps; opt-out for heavy views |
| `F()` conditional update | Lost update, oversell | None (one statement) | Logic limited to WHERE clause | Counters, stock, balances |
| `select_for_update` | Check-then-act races across rows | Lock waits, deadlock risk | Blocked requests, deadlock errors | Bookings, transfers, state machines |
| `skip_locked` | Double-claiming | Unfair ordering | Starvation under load | DB-backed job queues |
| Optimistic version | Lost update over long gaps | Retry/merge UX | Conflicts under high contention | Edit forms, PATCH APIs |
| `UniqueConstraint` | Duplicates | Index | IntegrityError to handle | "Only one" invariants |
| SERIALIZABLE | All anomalies | Retries on 40001 | Retry storms | Complex invariants, low volume |
| Advisory lock | Concurrent runs of a job | Session/txn bookkeeping | Lock leak with session locks + poolers | Singletons, cron jobs |

### When to use

- `atomic()` around every sequence of writes that must succeed together — usually in a service function, not the view.
- `on_commit()` for every side effect outside the database (tasks, emails, webhooks, cache invalidation).
- `F()` updates for every counter; `select_for_update` when the decision needs Python logic.
- `durable=True` on functions that must commit independently (e.g. idempotency-key records).

### When NOT to use

- Don't hold a transaction (or a row lock) across network calls — payment providers, S3, external APIs. Do the external call before (with an idempotency key) or after (via `on_commit`/state machine).
- Don't use `select_for_update` for simple counters — `F()` is cheaper.
- Don't enable SERIALIZABLE globally without a retry wrapper.
- Don't use `ATOMIC_REQUESTS` with streaming responses or long views; the transaction ends when the view returns, not when the stream finishes, and long views hold connections.

## 7. Common Mistakes & Best Practices

**1. Believing `atomic()` prevents races.** It provides atomicity (all-or-nothing), not isolation from concurrent readers under READ COMMITTED. Two atomic blocks reading the same row without `FOR UPDATE` still race.

**2. Catching `DatabaseError` inside atomic without a nested block.** Covered in §5.1. Wrap the risky statement in its own `atomic()` and catch *outside* it.

**3. `select_for_update` outside a transaction.** Raises `TransactionManagementError` — but only when evaluated. Tests using `TestCase` hide it. Wrap in `atomic()`; use `TransactionTestCase` for this code.

**4. Locking more than you think.** `select_for_update().select_related("customer")` also locks the customer row, blocking every other order for that customer. Use `of=("self",)`.

**5. Inconsistent lock order → deadlocks.** Transfer A→B locks A then B; transfer B→A locks B then A. Always lock by sorted primary key:

```python
with transaction.atomic():
    a, b = sorted([src_id, dst_id])
    accounts = {x.pk: x for x in Account.objects.select_for_update().filter(pk__in=[a, b]).order_by("pk")}
```

**6. `obj.save()` after using F without refresh.** `obj.views` holds an `F` expression after save; rendering it shows `F(views) + Value(1)`, and saving again increments again. Call `refresh_from_db()`.

**7. Full `save()` overwriting concurrent changes.** `save()` writes every field. If request A changed `email` and B changed `name` from stale copies, B's `save()` reverts A's email. Use `save(update_fields=[...])`.

**8. Enqueuing tasks inside the transaction.** Use `transaction.on_commit(lambda: task.delay(obj.pk))` — or `task.delay_on_commit(...)` in Celery 5.4+.

**9. Lambdas capturing loop variables.** `for o in orders: on_commit(lambda: notify.delay(o.pk))` notifies the last order N times. Use `functools.partial(notify.delay, o.pk)` or a default argument.

**Best practices:** keep transactions short; put business transactions in a service layer; set `statement_timeout`/`lock_timeout` for the app role; back every invariant with a DB constraint; add idempotency keys to retryable endpoints ([REST API · Idempotency Keys](../rest-api/topic.html?p=27-idempotency-keys-retries)).

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: oversold flash sale.** *Symptom:* 1,000 units, 1,060 orders. *Root cause:* `if p.stock >= qty: p.stock -= qty; p.save()` inside `atomic()` — no lock, lost updates. *Fix:* conditional `F()` update + `CheckConstraint(stock >= 0)`; reconcile with a script that compares orders vs inventory movements.

**Pitfall: connection pool exhausted during a payment outage.** With `ATOMIC_REQUESTS=True`, every checkout view held a transaction (and a pool connection) while waiting 30 s on the payment provider. *Symptom:* `OperationalError: too many connections` / pool timeouts on unrelated pages. *Fix:* `@transaction.non_atomic_requests` on the checkout view; short `atomic()` blocks before and after the external call; HTTP timeouts on the client.

**Pitfall: deadlocks under load.** *Symptom:* Sentry shows `deadlock detected` sporadically from the transfer endpoint. *Root cause:* inconsistent lock order, or locking FK-referenced rows implicitly (inserting a child takes `FOR KEY SHARE` on the parent). *Fix:* sorted locking, `no_key=True` when not touching keys, retry once on deadlock (PostgreSQL aborts one side; a retry usually succeeds).

**Pitfall: lock waits pile up.** A hot row (a global counter, a "settings" row) locked by every request serializes your whole site. *Symptom:* p99 latency equals queue length × transaction time. *Fix:* shard the counter (N rows, sum on read), move to Redis `INCR` ([Redis · Pipelining, Lua & Transactions](../redis-caching/topic.html?p=22-pipelining-lua-transactions)), or make it eventually consistent.

**Pitfall: idle in transaction.** A Celery task opened `atomic()`, then called an API for minutes. `pg_stat_activity` shows `idle in transaction`; autovacuum can't clean dead tuples older than its snapshot; table bloat grows. *Fix:* set `idle_in_transaction_session_timeout` on the role; restructure the task.

**Pitfall: advisory session locks behind PgBouncer.** `pg_advisory_lock` (session-level) under transaction pooling leaks to another client's session. *Fix:* use `pg_advisory_xact_lock` (released at commit), or a Redis lock with TTL ([Redis · Distributed Locks](../redis-caching/topic.html?p=23-distributed-locks-redlock)).

**Debugging:**

```sql
-- What is waiting on what?
SELECT a.pid, a.state, now() - a.xact_start AS xact_age, pg_blocking_pids(a.pid) AS blocked_by,
       left(a.query, 100) AS query
FROM pg_stat_activity a
WHERE a.datname = current_database() AND a.state <> 'idle'
ORDER BY xact_age DESC NULLS LAST;

-- Long-running / idle-in-transaction sessions
SELECT pid, state, now() - xact_start FROM pg_stat_activity WHERE state LIKE 'idle in transaction%';
```

Enable `log_lock_waits = on` and `deadlock_timeout` (default 1 s) in PostgreSQL to log waits longer than that. In Django, `connection.in_atomic_block` and `connection.savepoint_ids` tell you where you are; logging `django.db.backends` shows `BEGIN`/`SAVEPOINT`/`COMMIT`.

**Scaling notes:** row locks scale with contention, not with traffic — design so hot spots are rare. Beyond one database, there are no cross-database transactions in Django (each alias has its own `atomic(using=...)`); use sagas/outbox ([System Design · Distributed Transactions](../system-design/topic.html?p=21-distributed-transactions)). Async views: transactions aren't supported in async ORM code yet — put the transactional unit in a sync function and call it with `sync_to_async` ([Ch 30](topic.html?p=30-async-django-asgi)).

## 9. Interview Questions

**Q: How does Django handle transactions by default?**
A: Django runs in autocommit mode: each query is committed as soon as it executes, unless it's inside a `transaction.atomic()` block. So two `save()` calls in a view are two separate transactions, and a failure between them leaves the first committed. You opt into a multi-statement transaction with `atomic()` — or for every view with `ATOMIC_REQUESTS = True`. Internally the outermost `atomic` turns autocommit off on the connection, and the commit or rollback happens when it exits.

**Q: What happens when you nest `atomic()` blocks?**
A: The outermost block starts a real transaction; each inner block creates a savepoint. If an inner block exits with an exception, Django rolls back to its savepoint and re-raises, so if you catch that exception outside the inner block, the outer transaction continues with everything else intact. If the outer block fails, everything rolls back, including work from inner blocks that "succeeded". Only the outermost exit commits; inner blocks just release their savepoints. `savepoint=False` skips the savepoint for performance, at the cost of losing partial rollback.

**Q: Why shouldn't you catch a database exception inside an `atomic` block?**
A: Because after a database error the transaction is in an aborted state — PostgreSQL rejects further statements until rollback — and Django marks the connection `needs_rollback`. If you catch the error and keep going in the same atomic block, the next query raises `TransactionManagementError`. Worse, on some databases you could commit an inconsistent state. The correct pattern is to wrap the risky operation in its own nested `atomic()` and catch the exception outside that inner block, so the savepoint rollback restores a healthy state.

**Q: What is `transaction.on_commit` and why use it for Celery tasks?**
A: It registers a callable to run after the outermost transaction successfully commits; if the transaction rolls back, the callback is discarded. If you call `task.delay(order.id)` inside a transaction, the worker may pick it up before commit and not find the row, or the transaction may roll back after the task was already queued. `transaction.on_commit(lambda: task.delay(order.id))` avoids both. It doesn't close the gap where the process crashes after commit but before enqueueing — for that you need an outbox.

**Q: What does `select_for_update()` do, and why must it run inside a transaction?**
A: It adds `FOR UPDATE` to the SELECT, so the database locks the returned rows; other transactions trying to lock or update them wait until your transaction ends. Locks are released at commit or rollback, so in autocommit mode the lock would be released immediately after the SELECT and protect nothing — Django therefore raises `TransactionManagementError` if it's evaluated outside `atomic()`. Options: `nowait` to fail fast, `skip_locked` to skip locked rows, `of` to limit which joined tables are locked, and `no_key` for the weaker `FOR NO KEY UPDATE`.

**Q: How do you increment a counter safely under concurrency?**
A: Let the database do the arithmetic with an `F()` expression: `Post.objects.filter(pk=pk).update(likes=F("likes") + 1)`. That compiles to `UPDATE … SET likes = likes + 1`, and since the database applies row updates one at a time with row locks, no increment is lost. The naive `post.likes += 1; post.save()` reads in Python and writes back a stale value. If you use `F()` on an instance and save, call `refresh_from_db()` afterwards because the attribute still holds the expression.

**Q: What is the difference between optimistic and pessimistic locking, and how do you implement each in Django?**
A: Pessimistic locking assumes conflict and prevents it: `select_for_update()` inside `atomic()` locks rows while you decide, and others wait. Optimistic locking assumes conflicts are rare and detects them: keep a `version` field, update with `filter(pk=pk, version=v).update(..., version=F("version")+1)`, and treat zero affected rows as a conflict to retry or report. Pessimistic suits short, contended operations inside one request (seat booking, transfers); optimistic suits long user think-time between read and write (edit forms, PATCH with ETags), where holding a lock is impossible.

**Q: Is `get_or_create` race-safe?**
A: Only when the lookup fields are covered by a unique constraint. It tries `get()`, then `create()` in a savepoint, and on `IntegrityError` retries `get()` — so the database's unique index is what actually decides the race. Without a unique constraint, two concurrent calls can both miss the `get` and both insert, leaving duplicates that later cause `MultipleObjectsReturned`. The same applies to `update_or_create`.

**Q: What does `ATOMIC_REQUESTS` do and what are its downsides?**
A: It wraps each view call in a transaction on that database, committing if the view returns a response and rolling back if it raises. It's a simple guarantee that a view's writes are all-or-nothing. Downsides: the transaction spans the whole view, including slow external calls and template rendering, which holds locks and pool connections longer; it doesn't cover middleware or streaming response generation; and it can hide the need to design proper transactional boundaries. Use `@transaction.non_atomic_requests` to opt out for specific views.

**Q: How would you design a checkout that never oversells, even during a flash sale? (Senior)**
A: Reserve stock with a single conditional statement: `Product.objects.filter(pk=pid, stock__gte=qty).update(stock=F("stock") - qty)` and check the affected row count, inside an `atomic()` that also creates the order and reservation rows — plus a `CheckConstraint(stock >= 0)` as a backstop. That avoids explicit locks and keeps each transaction to a few milliseconds. The payment call happens outside the transaction with an idempotency key; the order moves through states (reserved → paid / expired) and a scheduled task releases expired reservations with another `F()` update. Side effects go through `on_commit` or an outbox. For extreme hot items, pre-split stock into buckets or front it with Redis `DECR` and reconcile.

**Q: Your transfer endpoint occasionally fails with "deadlock detected". How do you diagnose and fix it? (Senior)**
A: PostgreSQL logs both queries involved in the deadlock; I'd read those to see which rows each transaction locked and in what order. Typical cause: transfer A→B locks A then B while B→A locks B then A. The fix is to always acquire locks in a deterministic order — `select_for_update().filter(pk__in=[a,b]).order_by("pk")` — and to minimise what's locked (`of=("self",)`, `no_key=True`). Since deadlocks can still occur from implicit locks (FK checks), I'd also add a bounded retry on deadlock errors around the whole atomic unit, which is safe as long as side effects are deferred via `on_commit`.

**Q: When would you choose SERIALIZABLE isolation in a Django app, and what must change in your code? (Senior)**
A: When an invariant spans rows you can't easily lock — e.g. "at most one on-call doctor per shift" checked by reading a set of rows — so READ COMMITTED with row locks would require locking phantom rows that don't exist yet. SERIALIZABLE makes PostgreSQL detect such conflicts and abort one transaction with a serialization failure. The code must then retry the whole transaction on SQLSTATE 40001 (surfaced as `OperationalError`), which means transactions must be idempotent and side effects must happen only after commit. I'd usually set it on a separate database alias or connection used for those operations rather than globally, and measure the abort rate. Often a unique or exclusion constraint achieves the same invariant more cheaply.

**Q: How do you process a database-backed job queue with many workers without double-processing? (Senior)**
A: Claim jobs with `select_for_update(skip_locked=True)` inside a short transaction, ordered by priority, limited to a batch, and mark them as running in the same transaction. Each worker skips rows locked by others, so batches are disjoint and nobody waits. To survive worker crashes, record `claimed_at` and have a reaper requeue jobs stuck in running past a timeout, which means job handlers must be idempotent. Don't hold the lock while processing — claim, commit, then work — otherwise long jobs keep transactions open and block vacuum.

## 10. Quick Revision & Cheat Sheet

| API | Meaning |
|---|---|
| autocommit (default) | each statement commits immediately |
| `@transaction.atomic` / `with atomic():` | outermost = BEGIN…COMMIT, nested = SAVEPOINT |
| `atomic(durable=True)` | must be outermost (3.2+) |
| `atomic(savepoint=False)` | nested without savepoint |
| `transaction.on_commit(fn, robust=False)` | run after outermost commit; dropped on rollback |
| `transaction.set_rollback(True)` | roll back without raising |
| `ATOMIC_REQUESTS` / `@non_atomic_requests` | wrap views / opt out |
| `filter(...).update(x=F("x")-1)` | atomic DB-side change; check rowcount |
| `select_for_update()` | `FOR UPDATE`, must be in atomic |
| `nowait` / `skip_locked` / `of` / `no_key` | fail fast / skip / limit tables / `FOR NO KEY UPDATE` |
| version column | optimistic: `filter(version=v).update(version=F+1)` |
| `OPTIONS["isolation_level"]` | change level; retry on 40001 |
| `captureOnCommitCallbacks` / `TransactionTestCase` | test on_commit / real commits |

- `atomic()` gives all-or-nothing, not race protection.
- Catch DB errors outside a nested `atomic()`, never inside the failing block.
- Locks last until the *outermost* commit.
- Every external side effect: `on_commit` (or outbox).
- Lock rows in a consistent order (`order_by("pk")`).
- Never hold a transaction across HTTP calls.
- `get_or_create` is only safe with a unique constraint.
- Constraints are the last line of defence for every invariant.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" "psycopg[binary]"`; PostgreSQL required (SQLite's locking is database-wide and won't show these behaviours).

1. Reproduce the lost update: a management command that spawns 20 threads each doing `p.stock -= 1; p.save()` on a product with stock 20. Check the final stock. Fix with `F()` and re-run.
2. Write `place_order` from §5.1; trigger the duplicate coupon; log SQL (`django.db.backends` at DEBUG) and find `SAVEPOINT` / `ROLLBACK TO SAVEPOINT`. Then remove the inner `atomic()` and observe `TransactionManagementError`.
3. Open two `psql` sessions: in one `BEGIN; SELECT * FROM shop_product WHERE id=1 FOR UPDATE;`. In Django, run `select_for_update(nowait=True)` on the same row and catch the error; then `skip_locked=True` and see an empty result.
4. Create a deadlock with two threads transferring A→B and B→A with an artificial `time.sleep` between the locks; read the PostgreSQL log; fix with sorted locking.
5. Write a `TestCase` asserting a Celery task is registered via `on_commit` using `captureOnCommitCallbacks`, and a `TransactionTestCase` that proves only one of two concurrent buyers succeeds.
6. Implement optimistic locking on a `Document` with a DRF endpoint returning `ETag` and enforcing `If-Match` (412 on mismatch).

**Mini project:** a ticketing service with shows and seats: hold seats (`select_for_update`, consistent order, `nowait`), confirm after a fake payment call made outside the transaction with an idempotency key, release expired holds via a periodic task using `skip_locked`, and a load-test script (100 concurrent clients, 50 seats) proving no seat is sold twice.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) (F expressions), [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization) (`update()` vs `save()`), [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres) (constraints, advisory locks via raw SQL), [Ch 19 · Signals](topic.html?p=19-signals) (signals run inside the transaction), [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi), [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks), [Ch 33 · Testing](topic.html?p=33-testing), [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases), [Ch 40 · Design Rounds](topic.html?p=40-design-rounds).

**Other handbooks:** [SQL · Transactions & ACID](../sql/topic.html?p=25-transactions-acid), [SQL · Isolation Levels](../sql/topic.html?p=26-isolation-levels), [SQL · Locking & MVCC](../sql/topic.html?p=27-locking-mvcc), [Database Design · Concurrency Control](../database-design/topic.html?p=04-concurrency-control), [Database Design · Locking Internals](../database-design/topic.html?p=05-locking-internals), [Database Design · Case: Ticket Booking](../database-design/topic.html?p=33-case-ticket-booking), [REST API · Concurrency & Optimistic Locking](../rest-api/topic.html?p=28-concurrency-optimistic-locking), [Messaging · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox), [Redis · Distributed Locks](../redis-caching/topic.html?p=23-distributed-locks-redlock).

- **Database transactions** — Django docs · *Intermediate* · atomic, savepoints, on_commit, autocommit and the "catching exceptions" warning. <https://docs.djangoproject.com/en/5.2/topics/db/transactions/>
- **QuerySet API: select_for_update** — Django docs · *Intermediate* · nowait, skip_locked, of, no_key and backend caveats. <https://docs.djangoproject.com/en/5.2/ref/models/querysets/>
- **Avoiding race conditions using F()** — Django docs · *Beginner* · the official explanation of F-based updates. <https://docs.djangoproject.com/en/5.2/ref/models/expressions/>
- **PostgreSQL: Transaction Isolation** — PostgreSQL docs · *Intermediate* · exactly what READ COMMITTED re-checks and when SERIALIZABLE aborts. <https://www.postgresql.org/docs/current/transaction-iso.html>
- **PostgreSQL: Explicit Locking** — PostgreSQL docs · *Advanced* · row lock modes, deadlocks, advisory locks. <https://www.postgresql.org/docs/current/explicit-locking.html>
- **Celery: Django first steps** — Celery docs · *Beginner* · including `delay_on_commit`. <https://docs.celeryq.dev/en/stable/django/first-steps-with-django.html>

---

*Django Handbook — chapter 14.*
