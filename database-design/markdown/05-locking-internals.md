# 05 · Locking Internals: Lock Modes, Queues & Deadlocks

> **In one line:** Locks are a queue, not a switch — every lock request waits behind the ones ahead of it, so a harmless-looking `ALTER TABLE` waiting behind one slow query can block every query after it, and understanding lock modes, the queue and deadlock detection is what turns "the database froze" into a five-minute diagnosis.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Locking, MVCC & Deadlocks](../sql/topic.html?p=27-locking-mvcc) (row vs table locks, `FOR UPDATE`, what a deadlock is, lock ordering) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (why readers don't take row locks) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) (which pattern to choose). This chapter is the engine-level view: the eight table lock modes and their conflict matrix, the four row lock modes and where they are stored, how the wait queue orders requests, how deadlock detection actually runs, and how to diagnose all of it live with `pg_locks` and `pg_blocking_pids()`.

A Tuesday, 14:02. A developer ships a migration: `ALTER TABLE orders ADD COLUMN gift_note text;`. On PostgreSQL 11+ that is a metadata-only change that completes in milliseconds. Yet within ten seconds the checkout API is timing out, the connection pool is exhausted, and the on-call engineer sees 400 sessions "waiting". Nothing is using CPU. Nothing is doing I/O. The database is simply *waiting*. The migration eventually gets killed, and everything recovers instantly.

What happened is the most important lesson in this chapter. `ALTER TABLE` needs an **ACCESS EXCLUSIVE** lock, which conflicts with everything, including the **ACCESS SHARE** lock every `SELECT` takes. An analytics query had been reading `orders` for four minutes, so the ALTER had to wait. And while the ALTER was waiting, every *new* `SELECT` on `orders` queued **behind the ALTER** — because PostgreSQL's lock manager does not let later requests jump over an earlier waiting request that they conflict with. One slow reader plus one instant DDL produced a complete outage of the table.

The naive model of locks — "a writer locks the row it changes, readers don't lock under MVCC, deadlocks are rare" — is true and dangerously incomplete. It misses that **every statement takes a table-level lock**, that **locks are granted through a queue**, that the lock you *wait* for can hurt more than the lock you *hold*, and that row locks in PostgreSQL are not in a lock table at all. Senior engineers are expected to know these mechanics because the incidents they cause look mysterious from the outside and are trivial from the inside.

> **Why this matters:** DDL migrations, job queues, batch updates, foreign keys and hot rows all run through the lock manager. Its behaviour decides whether a deploy is invisible or an outage.

## 2. Core Concepts

- **Heavyweight lock (regular lock)** — a lock in PostgreSQL's shared lock table on a table, a transaction ID, a tuple-in-waiting, an advisory key, etc.; held until transaction end; visible in `pg_locks`. *Why it matters:* this is what DDL, DML and waits use, and what the deadlock detector inspects.
- **Lightweight lock (LWLock) and spinlock** — short-term latches protecting shared-memory structures (buffer mapping, WAL insertion, the lock manager itself). *Why it matters:* not visible in `pg_locks`, but show up as `wait_event_type = 'LWLock'`; contention here is a different problem (e.g. `LockManager`, `WALWrite`).
- **Table lock modes** — eight levels from ACCESS SHARE (plain `SELECT`) to ACCESS EXCLUSIVE (most `ALTER TABLE`, `DROP`, `TRUNCATE`). *Why it matters:* the mode your DDL needs decides whether it blocks reads, writes or neither.
- **Row lock modes** — `FOR KEY SHARE`, `FOR SHARE`, `FOR NO KEY UPDATE`, `FOR UPDATE`. *Why it matters:* the weaker modes let foreign-key checks and non-key updates coexist.
- **Row lock storage** — PostgreSQL records row locks *in the tuple* (`xmax` + infomask bits), not in shared memory. *Why it matters:* you can lock millions of rows without exhausting memory, but waits on rows appear as waits on the holder's **transaction ID**.
- **MultiXact** — an ID standing for a *set* of transactions when several share-lock one row. *Why it matters:* heavy `FOR SHARE`/FK traffic generates multixacts, which need their own vacuuming and freezing.
- **Lock queue** — waiters on an object are granted in order; a new request that conflicts with a queued waiter queues behind it. *Why it matters:* the root of the "ALTER TABLE took the site down" incident.
- **lock_timeout** — maximum time a statement waits to acquire any lock before failing (SQLSTATE 55P03). *Why it matters:* the single most important safety setting for migrations.
- **Deadlock** — a cycle in the wait-for graph. *Why it matters:* it never resolves on its own; the database must abort a participant.
- **deadlock_timeout** — how long (default 1s) a waiter sleeps before running the deadlock check. *Why it matters:* deadlocks take at least this long to break; also the threshold for `log_lock_waits`.
- **NOWAIT / SKIP LOCKED** — row-locking clauses that fail immediately or skip locked rows instead of waiting. *Why it matters:* the building blocks of responsive UIs and job queues.
- **`pg_locks` / `pg_blocking_pids()`** — the lock table view and a function returning the PIDs blocking a given backend. *Why it matters:* your primary diagnostic tools.
- **Record, gap and next-key locks (InnoDB)** — InnoDB locks index records and the gaps between them. *Why it matters:* a completely different deadlock profile from PostgreSQL, especially for inserts.
- **Metadata lock (MySQL MDL)** — MySQL's table-definition lock. *Why it matters:* the MySQL twin of the ALTER TABLE queue incident.

## 3. Theory & Principles

### Three layers of locking

1. **Spinlocks and LWLocks** protect in-memory data structures for microseconds: the buffer mapping table, a buffer's content while it is being read or modified, WAL insertion slots, the lock manager's own partitions. They are never held until commit and never participate in deadlock detection (the code is written so they cannot deadlock). You see them only as wait events.
2. **Heavyweight (regular) locks** on database objects: relations, transaction IDs, tuples (only while queuing), pages, advisory keys, objects in the catalog. Held until end of transaction (advisory session locks excepted). These live in a shared-memory hash table sized from `max_locks_per_transaction`, appear in `pg_locks`, and participate in deadlock detection.
3. **Row locks**, stored in the tuple header. Taking one means writing your XID into the row's `xmax` with lock bits in `t_infomask` (and dirtying the page, and writing WAL). Nothing goes into shared memory unless someone has to *wait*.

### Table lock modes and the conflict matrix

Every SQL statement takes a table-level lock on each table it touches, even if it only reads. The mode determines what can run concurrently:

| Mode | Taken by (examples) |
|---|---|
| ACCESS SHARE | `SELECT` |
| ROW SHARE | `SELECT … FOR UPDATE / FOR SHARE` |
| ROW EXCLUSIVE | `INSERT`, `UPDATE`, `DELETE`, `MERGE` |
| SHARE UPDATE EXCLUSIVE | `VACUUM`, `ANALYZE`, `CREATE INDEX CONCURRENTLY`, `ALTER TABLE … VALIDATE CONSTRAINT`, `… SET STATISTICS` |
| SHARE | `CREATE INDEX` (non-concurrent) |
| SHARE ROW EXCLUSIVE | `CREATE TRIGGER`, `ALTER TABLE … ADD FOREIGN KEY` (both tables) |
| EXCLUSIVE | `REFRESH MATERIALIZED VIEW CONCURRENTLY` |
| ACCESS EXCLUSIVE | `DROP`, `TRUNCATE`, most `ALTER TABLE`, `VACUUM FULL`, `CLUSTER`, `REFRESH MATERIALIZED VIEW`, `LOCK TABLE` (default) |

Conflict matrix (✗ = the requested mode conflicts with a held mode):

| Requested ↓ / Held → | ACC SH | ROW SH | ROW EX | SH UPD EX | SHARE | SH ROW EX | EXCL | ACC EX |
|---|---|---|---|---|---|---|---|---|
| ACCESS SHARE | | | | | | | | ✗ |
| ROW SHARE | | | | | | | ✗ | ✗ |
| ROW EXCLUSIVE | | | | | ✗ | ✗ | ✗ | ✗ |
| SHARE UPDATE EXCLUSIVE | | | | ✗ | ✗ | ✗ | ✗ | ✗ |
| SHARE | | | ✗ | ✗ | | ✗ | ✗ | ✗ |
| SHARE ROW EXCLUSIVE | | | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| EXCLUSIVE | | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |
| ACCESS EXCLUSIVE | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

Read it as design guidance: plain `CREATE INDEX` (SHARE) blocks all writes for the whole build; `CREATE INDEX CONCURRENTLY` (SHARE UPDATE EXCLUSIVE) blocks neither reads nor writes but conflicts with VACUUM and other schema changes; anything ACCESS EXCLUSIVE blocks even `SELECT`. The zero-downtime migration techniques in [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution) are mostly about substituting a weaker mode for a stronger one.

### Row lock modes

| Row lock | Taken by | Conflicts with |
|---|---|---|
| FOR KEY SHARE | FK check when inserting/updating a child row (locks the parent row) | FOR UPDATE |
| FOR SHARE | `SELECT … FOR SHARE` | FOR NO KEY UPDATE, FOR UPDATE |
| FOR NO KEY UPDATE | `UPDATE` that does not modify key columns; `SELECT … FOR NO KEY UPDATE` | FOR SHARE, FOR NO KEY UPDATE, FOR UPDATE |
| FOR UPDATE | `DELETE`; `UPDATE` of a column in a unique index usable by an FK; `SELECT … FOR UPDATE` | all four |

The two "weak" modes exist for foreign keys. Inserting an order line must ensure the parent order is not deleted or its key changed until the insert commits, so it takes `FOR KEY SHARE` on the parent. An `UPDATE orders SET status = 'paid'` takes `FOR NO KEY UPDATE`, which does *not* conflict with `FOR KEY SHARE` — so adding lines and updating the order's status do not block each other. (Before PostgreSQL 9.3, FK checks took `FOR SHARE`, and this was a notorious source of contention and deadlocks.)

Lock-free reads remain lock-free: a plain `SELECT` takes no row lock in any mode.

### How a row-lock wait really works

Because row locks live in the tuple, there is nothing in shared memory to "wait on" for a row. PostgreSQL uses the holder's transaction instead:

```text
T1 (xid 9811): UPDATE accounts SET balance = balance - 100 WHERE id = 1;
    → writes new version; old version xmax = 9811 (lock bits = NO KEY UPDATE)
    → T1 holds an ExclusiveLock on its own transactionid 9811 (every writing txn does)

T2 (xid 9812): UPDATE accounts SET balance = balance + 5 WHERE id = 1;
    → sees xmax = 9811, still in progress, lock mode conflicts
    → acquires a heavyweight TUPLE lock on (page, item) — to claim first place in line
    → requests ShareLock on transactionid 9811  → WAITS (appears in pg_locks, granted = false)

T3: same UPDATE on id = 1
    → requests the TUPLE lock, held by T2 → WAITS behind T2 (wait_event = 'tuple')

T1 COMMIT → its transactionid lock is released → T2 wakes, re-checks the row (Ch 04: EvalPlanQual),
            updates, releases the tuple lock → T3 moves to waiting on T2's transactionid
```

So in `pg_stat_activity`, the first waiter on a row shows `wait_event_type = 'Lock', wait_event = 'transactionid'`, and further waiters show `wait_event = 'tuple'`. When several transactions hold *share* locks on the same row (e.g. many FK checks), xmax cannot hold several XIDs, so PostgreSQL allocates a **MultiXact** ID representing the set, stored in `pg_multixact`. Workloads with heavy FK or `FOR SHARE` traffic can churn through multixacts quickly, which is why `mxid_age` is worth monitoring ([Ch 03](topic.html?p=03-mvcc)).

### The lock queue and queue-jumping

When a lock request conflicts with a lock already *held*, it waits. The subtle part is what happens to requests arriving *after* it. PostgreSQL grants a new request immediately only if it conflicts with neither the held locks nor the requests *already waiting* ahead of it (otherwise a stream of compatible readers could starve a waiting writer forever). The consequence:

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c05a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Lock queue on table "orders": one waiting ALTER blocks every later SELECT</text>

  <line x1="150" y1="60" x2="860" y2="60" stroke="#334155" stroke-width="1.5"/>
  <text x="150" y="52" fill="#334155" font-size="10">14:00</text><text x="400" y="52" fill="#334155" font-size="10">14:02:00</text><text x="560" y="52" fill="#334155" font-size="10">14:02:10</text><text x="800" y="52" fill="#334155" font-size="10">14:04</text>

  <text x="20" y="92" fill="#1e293b" font-weight="bold">Analytics query</text>
  <rect x="150" y="78" width="650" height="24" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="160" y="94" fill="#15803d" font-size="10" font-weight="bold">HOLDS ACCESS SHARE — SELECT … FROM orders JOIN … (4 minutes)</text>

  <text x="20" y="134" fill="#1e293b" font-weight="bold">Migration</text>
  <rect x="400" y="120" width="400" height="24" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="410" y="136" fill="#92400e" font-size="10" font-weight="bold">WAITS for ACCESS EXCLUSIVE (ALTER TABLE ADD COLUMN, needs ~5 ms)</text>
  <rect x="800" y="120" width="30" height="24" rx="4" fill="#fee2e2" stroke="#dc2626"/>

  <text x="20" y="176" fill="#1e293b" font-weight="bold">Checkout SELECTs</text>
  <rect x="410" y="162" width="390" height="18" rx="3" fill="#fee2e2" stroke="#dc2626"/>
  <rect x="440" y="184" width="360" height="18" rx="3" fill="#fee2e2" stroke="#dc2626"/>
  <rect x="470" y="206" width="330" height="18" rx="3" fill="#fee2e2" stroke="#dc2626"/>
  <rect x="500" y="228" width="300" height="18" rx="3" fill="#fee2e2" stroke="#dc2626"/>
  <rect x="530" y="250" width="270" height="18" rx="3" fill="#fee2e2" stroke="#dc2626"/>
  <text x="560" y="176" fill="#7f1d1d" font-size="9">ACCESS SHARE — compatible with the holder,</text>
  <text x="560" y="198" fill="#7f1d1d" font-size="9">but conflicts with the WAITING ALTER → queued</text>
  <text x="560" y="220" fill="#7f1d1d" font-size="9">behind it; connection pool fills in seconds</text>
  <text x="20" y="300" fill="#1e293b" font-weight="bold">Queue at 14:02:10</text>
  <rect x="150" y="286" width="120" height="26" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="210" y="303" text-anchor="middle" fill="#15803d" font-size="9">granted: analytics</text>
  <path d="M272,299 L292,299" stroke="#dc2626" stroke-width="1.5" marker-end="url(#c05a)"/>
  <rect x="294" y="286" width="120" height="26" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="354" y="303" text-anchor="middle" fill="#92400e" font-size="9">1st waiter: ALTER</text>
  <path d="M416,299 L436,299" stroke="#dc2626" stroke-width="1.5" marker-end="url(#c05a)"/>
  <rect x="438" y="286" width="300" height="26" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="588" y="303" text-anchor="middle" fill="#7f1d1d" font-size="9">SELECT, SELECT, UPDATE, SELECT, … (hundreds)</text>

  <rect x="20" y="330" width="840" height="96" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="36" y="350" fill="#1e293b" font-size="11" font-weight="bold">Fix: never let DDL wait indefinitely</text>
  <text x="36" y="370" fill="#334155" font-size="10">SET lock_timeout = '2s';  ALTER TABLE orders ADD COLUMN gift_note text;   → fails fast (55P03) instead of queueing; retry in a loop with backoff</text>
  <text x="36" y="388" fill="#334155" font-size="10">Before the migration: check for long transactions on the table (pg_stat_activity, pg_locks) and cancel or wait for them.</text>
  <text x="36" y="406" fill="#334155" font-size="10">The ALTER's actual work is milliseconds — the outage is entirely the WAIT. The same happens with autovacuum-to-prevent-wraparound,</text>
  <text x="36" y="420" fill="#334155" font-size="10">which does not yield to DDL, and with idle-in-transaction sessions that once read the table.</text>
</svg>
```

Note that the blocker can be *idle*: a session that ran `SELECT 1 FROM orders LIMIT 1` inside a transaction and then went `idle in transaction` still holds its ACCESS SHARE lock on `orders` until it ends. That is why `idle_in_transaction_session_timeout` is a locking setting as much as an MVCC one.

### Deadlock detection

PostgreSQL does not check for deadlocks when a lock is requested (that would add cost to every wait). Instead, a backend that has waited for **`deadlock_timeout`** (default 1s) runs the deadlock detector: it builds the wait-for graph from the lock table, following "waits for" edges from itself, and looks for a cycle back to itself. If it finds a *hard* cycle it aborts its own transaction with SQLSTATE **40P01**; the others then proceed. (It can sometimes resolve *soft* cycles caused only by queue order by rearranging the wait queue, without aborting anyone.) If there is no cycle, it goes back to waiting — and with `log_lock_waits = on`, logs that it has been waiting longer than `deadlock_timeout`.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c05b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c05c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two carts, same SKUs, opposite order: how a deadlock forms and is broken</text>

  <text x="110" y="52" text-anchor="middle" fill="#1e293b" font-weight="bold">T1 (cart A: sku 7, sku 9)</text>
  <text x="360" y="52" text-anchor="middle" fill="#1e293b" font-weight="bold">T2 (cart B: sku 9, sku 7)</text>
  <line x1="110" y1="60" x2="110" y2="370" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="360" y1="60" x2="360" y2="370" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="20" y="84" fill="#334155" font-size="9">t=0 ms</text>
  <rect x="30" y="72" width="160" height="24" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="110" y="88" text-anchor="middle" fill="#15803d" font-size="9">UPDATE sku 7 → lock ✓</text>
  <rect x="280" y="102" width="160" height="24" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="360" y="118" text-anchor="middle" fill="#15803d" font-size="9">UPDATE sku 9 → lock ✓</text>
  <text x="20" y="150" fill="#334155" font-size="9">t=3 ms</text>
  <rect x="30" y="138" width="160" height="24" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="110" y="154" text-anchor="middle" fill="#92400e" font-size="9">UPDATE sku 9 → WAIT on T2</text>
  <rect x="280" y="168" width="160" height="24" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="360" y="184" text-anchor="middle" fill="#92400e" font-size="9">UPDATE sku 7 → WAIT on T1</text>
  <text x="20" y="226" fill="#334155" font-size="9">both sleep</text>
  <rect x="30" y="210" width="410" height="30" rx="4" fill="#f1f5f9" stroke="#94a3b8"/><text x="235" y="229" text-anchor="middle" fill="#334155" font-size="10">… no progress, no CPU, locks held … until deadlock_timeout = 1 s</text>
  <text x="20" y="270" fill="#334155" font-size="9">t≈1003 ms</text>
  <rect x="30" y="256" width="160" height="40" rx="4" fill="#dcfce7" stroke="#16a34a"/><text x="110" y="272" text-anchor="middle" fill="#15803d" font-size="9">proceeds: sku 9 updated</text><text x="110" y="286" text-anchor="middle" fill="#15803d" font-size="9">COMMIT</text>
  <rect x="280" y="256" width="160" height="40" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="360" y="272" text-anchor="middle" fill="#b91c1c" font-size="9">runs detector, finds cycle</text><text x="360" y="286" text-anchor="middle" fill="#b91c1c" font-size="9">ERROR 40P01 → rollback</text>
  <rect x="280" y="306" width="160" height="40" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="360" y="322" text-anchor="middle" fill="#1e40af" font-size="9">app retries whole txn</text><text x="360" y="336" text-anchor="middle" fill="#1e40af" font-size="9">(after T1 commits → OK)</text>

  <rect x="480" y="60" width="380" height="200" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="670" y="82" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Wait-for graph at t = 3 ms</text>
  <circle cx="570" cy="160" r="36" fill="#fff" stroke="#dc2626" stroke-width="2"/><text x="570" y="156" text-anchor="middle" fill="#1e293b" font-weight="bold">T1</text><text x="570" y="171" text-anchor="middle" fill="#334155" font-size="9">holds sku 7</text>
  <circle cx="770" cy="160" r="36" fill="#fff" stroke="#dc2626" stroke-width="2"/><text x="770" y="156" text-anchor="middle" fill="#1e293b" font-weight="bold">T2</text><text x="770" y="171" text-anchor="middle" fill="#334155" font-size="9">holds sku 9</text>
  <path d="M600,140 C650,105 690,105 738,140" stroke="#dc2626" stroke-width="2" fill="none" marker-end="url(#c05b)"/>
  <text x="670" y="108" text-anchor="middle" fill="#b91c1c" font-size="9">waits for xid of T2</text>
  <path d="M740,182 C690,215 650,215 602,182" stroke="#dc2626" stroke-width="2" fill="none" marker-end="url(#c05b)"/>
  <text x="670" y="226" text-anchor="middle" fill="#b91c1c" font-size="9">waits for xid of T1</text>
  <text x="670" y="248" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">cycle → cannot resolve by waiting</text>

  <rect x="480" y="276" width="380" height="130" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="670" y="298" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Prevention: a global lock order</text>
  <text x="496" y="320" fill="#166534" font-size="10">Sort SKUs before locking: both carts lock 7, then 9.</text>
  <text x="496" y="338" fill="#166534" font-size="10">T2 waits for sku 7 while holding nothing → no cycle.</text>
  <text x="496" y="356" fill="#166534" font-size="10">SELECT id FROM stock WHERE sku = ANY($1)</text>
  <text x="496" y="372" fill="#166534" font-size="10">  ORDER BY sku FOR UPDATE;   -- then UPDATE</text>
  <text x="496" y="394" fill="#166534" font-size="10" font-weight="bold">Detection costs ≥ 1 s + a retry; ordering costs nothing.</text>
  <path d="M110,370 L110,390" stroke="#334155" stroke-width="1" marker-end="url(#c05c)"/>
</svg>
```

Tuning note: raising `deadlock_timeout` makes true deadlocks take longer to break but saves CPU on systems with many long, legitimate lock waits; lowering it below ~100 ms mostly wastes cycles. Leave it at 1s and fix the ordering.

### Lock-manager scalability: fast path and max_locks_per_transaction

Taking a heavyweight lock means touching a shared hash table partition protected by an LWLock. To keep ordinary queries cheap, PostgreSQL lets a backend record *weak* relation locks (ACCESS SHARE, ROW SHARE, ROW EXCLUSIVE) in a small per-backend **fast-path** array (16 slots per backend through PG 17; PG 18 sizes it from `max_locks_per_transaction`) as long as no one holds a conflicting strong lock. A query that touches more relations than that — a partitioned table with hundreds of partitions, each with several indexes, without partition pruning — spills into the shared table, and at high concurrency backends queue on `LWLock:LockManager`. Separately, the shared table has room for roughly `max_locks_per_transaction` (default 64) × (`max_connections` + `max_prepared_transactions`) locks; a transaction that touches thousands of partitions can exhaust it, failing with "out of shared memory" and a hint to raise `max_locks_per_transaction`.

## 4. Architecture & Workflow

### Lifecycle of a lock request

```text
LockAcquire(object, mode)
  ├─ already hold a mode ≥ requested on this object?          → return (no-op)
  ├─ weak relation lock & fast path allowed & slot free?        → record locally, done (no shared table)
  ├─ hash to a lock-table partition (LWLock)
  │    ├─ conflicts with granted modes OR with waiters ahead?   → no → grant, done
  │    └─ yes → if NOWAIT: error 55P03 ; else enqueue as waiter
  ├─ sleep on semaphore/latch
  │    ├─ after deadlock_timeout: run deadlock check → cycle? → abort self (40P01)
  │    │                          log_lock_waits? → LOG "still waiting … after 1000 ms"
  │    ├─ lock_timeout / statement_timeout expires           → error, dequeue
  │    └─ woken by releaser → granted
  └─ locks released at COMMIT/ROLLBACK (all at once), waiters re-evaluated
```

Two consequences worth internalising. **Locks are held until transaction end**, not statement end — a transaction that updates a hot row and then spends 200 ms on other statements holds the row lock for those 200 ms. And **timeouts are per statement** (`lock_timeout`, `statement_timeout`), while `idle_in_transaction_session_timeout` and (PG 17) `transaction_timeout` bound the transaction.

### SELECT FOR UPDATE, NOWAIT and SKIP LOCKED

| Clause | Behaviour when a target row is locked | Typical use |
|---|---|---|
| `FOR UPDATE` | wait (subject to `lock_timeout`) | pessimistic RMW |
| `FOR UPDATE NOWAIT` | error 55P03 immediately | "someone else is editing this" UI; fail-fast APIs |
| `FOR UPDATE SKIP LOCKED` | silently skip that row | job queues, work distribution |

`SKIP LOCKED` intentionally returns an *inconsistent* view (it hides rows that exist), which is exactly right for "give me any free job" and wrong for anything that must see all rows.

> **MySQL difference:** InnoDB locks **index records**, not tuples, and at REPEATABLE READ uses **next-key locks** — a record lock plus a lock on the *gap* before it — on every index record a locking read or DML statement *scans*, to prevent phantoms. Gap locks are compatible with each other but block **insert intention** locks into that gap. Consequences: an `UPDATE … WHERE unindexed_col = x` scans and locks the whole table; `SELECT … FOR UPDATE` on a non-existent key locks a gap; and concurrent "check then insert" transactions deadlock. InnoDB detects deadlocks **immediately** when a wait would close a cycle (`innodb_deadlock_detect = ON`) and rolls back the transaction that has done the least work; otherwise waits end at `innodb_lock_wait_timeout` (50 s), which by default rolls back only the *statement*. At READ COMMITTED most gap locking is disabled. Table-level DDL goes through **metadata locks (MDL)**, which queue exactly like PostgreSQL's ACCESS EXCLUSIVE — "Waiting for table metadata lock" — and `lock_wait_timeout` defaults to one year, so always set it low for migrations.

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">InnoDB next-key locks on index values 10, 20, 30 (REPEATABLE READ)</text>

  <line x1="60" y1="90" x2="820" y2="90" stroke="#334155" stroke-width="2"/>
  <rect x="60" y="70" width="170" height="40" fill="#fef3c7" stroke="#d97706"/><text x="145" y="94" text-anchor="middle" fill="#92400e" font-size="10">gap (−∞, 10)</text>
  <rect x="230" y="66" width="40" height="48" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/><text x="250" y="94" text-anchor="middle" fill="#1e40af" font-weight="bold">10</text>
  <rect x="270" y="70" width="170" height="40" fill="#fef3c7" stroke="#d97706"/><text x="355" y="94" text-anchor="middle" fill="#92400e" font-size="10">gap (10, 20)</text>
  <rect x="440" y="66" width="40" height="48" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/><text x="460" y="94" text-anchor="middle" fill="#1e40af" font-weight="bold">20</text>
  <rect x="480" y="70" width="170" height="40" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/><text x="565" y="94" text-anchor="middle" fill="#b91c1c" font-size="10">gap (20, 30)</text>
  <rect x="650" y="66" width="40" height="48" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/><text x="670" y="94" text-anchor="middle" fill="#1e40af" font-weight="bold">30</text>
  <rect x="690" y="70" width="130" height="40" fill="#fef3c7" stroke="#d97706"/><text x="755" y="94" text-anchor="middle" fill="#92400e" font-size="10">gap (30, +∞)</text>

  <text x="60" y="140" fill="#1e293b" font-weight="bold">The classic "check-then-insert" deadlock (id 25 does not exist):</text>
  <rect x="60" y="152" width="370" height="104" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="72" y="172" fill="#334155" font-size="10">T1: SELECT … WHERE id = 25 FOR UPDATE  → GAP lock (20,30)</text>
  <text x="72" y="190" fill="#334155" font-size="10">T2: SELECT … WHERE id = 25 FOR UPDATE  → GAP lock (20,30) ✓</text>
  <text x="84" y="206" fill="#334155" font-size="9">(gap locks never conflict with each other)</text>
  <text x="72" y="224" fill="#b91c1c" font-size="10">T1: INSERT id = 25 → insert-intention waits for T2's gap</text>
  <text x="72" y="242" fill="#b91c1c" font-size="10">T2: INSERT id = 25 → waits for T1's gap → DEADLOCK</text>

  <rect x="450" y="152" width="370" height="104" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="462" y="172" fill="#15803d" font-size="10" font-weight="bold">Fixes</text>
  <text x="462" y="192" fill="#166534" font-size="10">• INSERT … ON DUPLICATE KEY UPDATE (one statement)</text>
  <text x="462" y="210" fill="#166534" font-size="10">• INSERT first, handle duplicate-key error</text>
  <text x="462" y="228" fill="#166534" font-size="10">• READ COMMITTED (gap locks mostly off)</text>
  <text x="462" y="246" fill="#166534" font-size="10">• always index the columns in locking WHEREs</text>

  <rect x="60" y="268" width="760" height="50" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="72" y="288" fill="#5b21b6" font-size="10">PostgreSQL has no gap locks: SELECT … FOR UPDATE on a missing row locks nothing, and two concurrent INSERTs of id 25</text>
  <text x="72" y="306" fill="#5b21b6" font-size="10">are serialised by the unique index (the second waits for the first, then gets 23505). Phantom protection comes from SSI instead (Ch 06).</text>
</svg>
```

## 5. Implementation

### Simple example: watch a row-lock wait in pg_locks

```sql
-- Session 1
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;

-- Session 2
BEGIN;
UPDATE accounts SET balance = balance + 5 WHERE id = 1;     -- hangs

-- Session 3: what is going on?
SELECT pid, locktype, relation::regclass, transactionid, mode, granted, waitstart
FROM pg_locks
WHERE pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())
  AND locktype IN ('relation', 'transactionid', 'tuple')
ORDER BY pid, granted DESC;
```

```text
 pid  | locktype      | relation | transactionid | mode             | granted | waitstart
------+---------------+----------+---------------+------------------+---------+----------------------
 4121 | relation      | accounts |               | RowExclusiveLock | t       |
 4121 | transactionid |          |          9811 | ExclusiveLock    | t       |
 4133 | relation      | accounts |               | RowExclusiveLock | t       |
 4133 | tuple         | accounts |               | ExclusiveLock    | t       |
 4133 | transactionid |          |          9812 | ExclusiveLock    | t       |
 4133 | transactionid |          |          9811 | ShareLock        | f       | 2026-09-24 14:02:03
```

Read it: both sessions hold compatible ROW EXCLUSIVE locks on the table; each holds an exclusive lock on its own XID; session 4133 holds the tuple lock (first in line) and is **waiting for ShareLock on transaction 9811** — i.e. for session 4121 to finish. No row appears as "locked" anywhere; the row lock is in the tuple.

### The blocking tree, the query you run first in an incident

```sql
SELECT a.pid,
       pg_blocking_pids(a.pid)                     AS blocked_by,
       a.state,
       a.wait_event_type || ':' || a.wait_event    AS waiting_on,
       now() - a.xact_start                        AS xact_age,
       now() - a.state_change                      AS in_state_for,
       left(a.query, 70)                           AS query
FROM pg_stat_activity a
WHERE a.pid IN (SELECT unnest(pg_blocking_pids(pid)) FROM pg_stat_activity)   -- blockers
   OR cardinality(pg_blocking_pids(a.pid)) > 0                                  -- blocked
ORDER BY cardinality(pg_blocking_pids(a.pid)), xact_age DESC;
```

```text
 pid  | blocked_by | state               | waiting_on           | xact_age | in_state_for | query
------+------------+---------------------+----------------------+----------+--------------+------------------------------
 3998 | {}         | idle in transaction |                      | 00:41:12 | 00:40:57     | SELECT * FROM orders WHERE …
 5120 | {3998}     | active              | Lock:relation        | 00:00:48 | 00:00:48     | ALTER TABLE orders ADD COLUMN…
 5131 | {5120}     | active              | Lock:relation        | 00:00:47 | 00:00:47     | SELECT id, status FROM orders…
 5140 | {5120}     | active              | Lock:relation        | 00:00:46 | 00:00:46     | UPDATE orders SET status = …
 ...
```

The root blocker is the row with an empty `blocked_by` that others wait on — here a session idle in transaction for 41 minutes. The ALTER is blocked by it; everything else is blocked by the *ALTER*. `pg_blocking_pids()` includes queue-order blocking (5131 is blocked by the waiting 5120, not by a holder), which is exactly what you need to see. Resolve with `SELECT pg_cancel_backend(5120);` (cancel the DDL, instantly unblocking the queue) and then deal with 3998 (`pg_terminate_backend`).

### Safe DDL: lock_timeout plus retries

```sql
-- migration step, executed by the migration tool
SET lock_timeout = '2s';            -- wait at most 2 s for the ACCESS EXCLUSIVE lock
SET statement_timeout = '30s';      -- and don't run away if the step turns out to be a rewrite
ALTER TABLE orders ADD COLUMN gift_note text;
```

```bash
# wrapper: retry a lock-sensitive migration step with backoff
for i in 1 2 3 4 5 6 7 8 9 10; do
  if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f step_042.sql; then exit 0; fi
  echo "attempt $i failed (likely lock_timeout); retrying"; sleep $((i * 3))
done
exit 1
```

A failed attempt costs the application at most 2 s of queued queries; an unbounded wait costs an outage. Combine with the lock-weakening techniques (`CREATE INDEX CONCURRENTLY`, `ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT`) covered in [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution).

### Deadlock: reproduce, read the log, fix with ordering

```sql
-- Session 1                                   -- Session 2
BEGIN;                                         BEGIN;
UPDATE stock SET qty = qty - 1 WHERE sku = 7;  UPDATE stock SET qty = qty - 1 WHERE sku = 9;
UPDATE stock SET qty = qty - 1 WHERE sku = 9;  UPDATE stock SET qty = qty - 1 WHERE sku = 7;
-- (waits)                                     -- ~1 s later:
```

```text
ERROR:  deadlock detected
DETAIL:  Process 4133 waits for ShareLock on transaction 9811; blocked by process 4121.
Process 4121 waits for ShareLock on transaction 9812; blocked by process 4133.
HINT:  See server log for query details.
CONTEXT:  while updating tuple (0,7) in relation "stock"
```

The fix is to make every code path lock rows in one global order. For a cart, lock all SKUs up front, sorted:

```sql
BEGIN;
SELECT sku FROM stock WHERE sku = ANY($1::int[]) ORDER BY sku FOR UPDATE;   -- consistent order
UPDATE stock s SET qty = s.qty - c.qty
FROM unnest($1::int[], $2::int[]) AS c(sku, qty)
WHERE s.sku = c.sku AND s.qty >= c.qty;                                      -- then write
COMMIT;
```

Keep the retry loop from [Ch 04](topic.html?p=04-concurrency-control) for 40P01 anyway: ordering removes the deadlocks you know about; the retry handles the ones you do not.

### Real-world example: a SKIP LOCKED job queue

```sql
CREATE TABLE jobs (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue      text        NOT NULL,
  payload    jsonb       NOT NULL,
  status     text        NOT NULL DEFAULT 'ready',     -- ready | running | done | failed
  run_at     timestamptz NOT NULL DEFAULT now(),
  attempts   int         NOT NULL DEFAULT 0,
  locked_by  text,
  locked_at  timestamptz
);
CREATE INDEX jobs_ready ON jobs (queue, run_at, id) WHERE status = 'ready';

-- Claim up to 10 jobs; concurrent workers skip each other's rows instead of waiting
WITH next AS (
  SELECT id FROM jobs
  WHERE queue = $1 AND status = 'ready' AND run_at <= now()
  ORDER BY run_at, id
  LIMIT 10
  FOR UPDATE SKIP LOCKED
)
UPDATE jobs j
SET status = 'running', locked_by = $2, locked_at = now(), attempts = j.attempts + 1
FROM next WHERE j.id = next.id
RETURNING j.id, j.payload;
-- COMMIT immediately: the claim is a lease recorded in the row, not a held lock.

-- Reaper: re-queue jobs whose worker died mid-flight
UPDATE jobs SET status = 'ready', locked_by = NULL, run_at = now() + interval '30 seconds'
WHERE status = 'running' AND locked_at < now() - interval '5 minutes';
```

Design choice: claim-and-commit (lease) versus holding the row lock while processing. Holding the lock is simpler (a crashed worker's lock disappears with its connection) but pins a connection and an open transaction for the whole job duration — terrible for the pool and for the xmin horizon ([Ch 03](topic.html?p=03-mvcc)). The lease pattern releases both immediately and needs a reaper plus idempotent job handlers. Queue tables churn heavily, so give them aggressive autovacuum settings; see [Kafka & RabbitMQ · What Is a Message Queue?](../messaging/topic.html?p=01-what-is-a-message-queue) for when a real broker is the better tool.

### Settings that belong in every production config

```ini
deadlock_timeout = 1s                          # default; tune only with evidence
log_lock_waits = on                            # log any wait longer than deadlock_timeout
lock_timeout = 0                               # global default (off); set per role / per migration
idle_in_transaction_session_timeout = '60s'    # stop idle sessions holding locks + snapshots
max_locks_per_transaction = 64                 # raise (e.g. 256) for many-partition schemas
```

```sql
ALTER ROLE migrator SET lock_timeout = '2s';
ALTER ROLE app      SET lock_timeout = '5s';   -- fail fast rather than pile up behind a stuck lock
```

## 6. Advantages, Disadvantages & Trade-offs

| Design decision | Benefit | Cost |
|---|---|---|
| Row locks in tuples (PG) | Unlimited row locks, no memory pressure | Locking writes pages + WAL; waits indirect via XIDs; multixacts need vacuum |
| Row locks in a lock table (InnoDB) | Rich lock types (gap, next-key), immediate deadlock detection | Memory per lock; gap locking causes insert deadlocks |
| Strict FIFO-ish queue | No starvation of DDL / strong locks | One waiting strong lock blocks everyone behind it |
| Periodic deadlock detection (PG) | No cost on the fast path | Deadlocks take ≥ `deadlock_timeout` to break |
| Immediate deadlock detection (InnoDB) | Deadlocks break instantly | CPU cost on every wait; can be disabled at extreme concurrency |
| NOWAIT | Instant feedback | Caller must handle 55P03 |
| SKIP LOCKED | Contention-free work distribution | Inconsistent view by design |

### When to use explicit locking

- `FOR UPDATE` for short read-decide-write transactions with contention ([Ch 04](topic.html?p=04-concurrency-control)).
- `FOR UPDATE SKIP LOCKED` for job/work distribution among competing consumers.
- `NOWAIT` for user-facing "record is being edited" flows.
- `LOCK TABLE … IN SHARE ROW EXCLUSIVE MODE` rarely, for a short critical section that must block concurrent writers of a whole table (e.g. a one-off reconciliation).
- Advisory locks for mutual exclusion on concepts, not rows.

### When NOT to

- Do not take `FOR UPDATE` on rows you only read for display — use plain MVCC reads.
- Do not use table locks to "simplify" concurrency in OLTP paths; they serialise everything.
- Do not hold any lock across network calls, user think time or queue waits.
- Do not rely on deadlock detection as flow control; ordering and short transactions are the design, detection is the safety net.

## 7. Common Mistakes & Best Practices

1. **Running DDL without `lock_timeout`.** The migration waits behind one long query and every later query waits behind the migration. Instead always set `lock_timeout` (1–5 s) for DDL and retry, and check for long transactions first.
2. **Assuming "metadata-only" DDL is safe.** Fast DDL still needs ACCESS EXCLUSIVE, briefly. The danger is the wait, not the work. Instead treat every ACCESS EXCLUSIVE step as potentially outage-causing and guard it.
3. **Locking rows in data-dependent order.** Iterating a cart, a batch or a transfer in request order creates opposite orders across transactions. Instead sort by primary key and lock up front (`ORDER BY id FOR UPDATE`).
4. **Holding locks while doing I/O.** A transaction that locks a row and then calls a payment API holds the lock for the API's p99. Instead do external calls before or after the transaction, and record intent with an outbox.
5. **Using `CREATE INDEX` (non-concurrent) on a live table.** SHARE mode blocks all writes for the build. Instead use `CREATE INDEX CONCURRENTLY` and check for an INVALID index if it fails.
6. **Missing indexes on foreign-key columns.** Deleting a parent row must find child rows; without an index on the child FK column, each delete scans the child table while holding locks, turning deletes into long lock holds (and in InnoDB, wide next-key locks). Instead index FK columns on the child side.
7. **Using `SKIP LOCKED` for reads that must be complete.** It hides locked rows, so a "count pending jobs" or a report using it is wrong. Instead use it only for claiming work.
8. **Treating 40P01 as a bug to page on rather than a retry.** Occasional deadlocks are normal in concurrent systems. Instead retry automatically, count them, and investigate only when the rate trends up.

**Best practices:** keep transactions short; lock in a consistent global order; set `lock_timeout` per role; enable `log_lock_waits`; set `idle_in_transaction_session_timeout`; index FK columns; use `CONCURRENTLY` variants of DDL; and keep a saved "blocking tree" query in your runbook.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**Migration queue-jump outage.** Described in §1. Detection: sudden spike of sessions with `wait_event_type = 'Lock'`, `wait_event = 'relation'` on one table; the blocking tree shows a DDL statement blocked by one old transaction and blocking everything else. Immediate fix: cancel the DDL. Permanent fix: `lock_timeout` in the migration framework, pre-migration check for transactions older than N seconds, and `idle_in_transaction_session_timeout`.

**Anti-wraparound vacuum vs deploy.** At 03:00 a deploy runs `ALTER TABLE events ADD CONSTRAINT …`. An autovacuum "to prevent wraparound" is running on `events`; normal autovacuum would cancel itself after `deadlock_timeout` when it blocks a lock request, but anti-wraparound vacuums do not. The ALTER waits; all traffic to `events` queues behind it. Fix: cancel the DDL, let the vacuum finish (never kill anti-wraparound vacuums casually — they will restart), reschedule, and monitor XID age so wraparound vacuums run on your schedule ([Ch 03](topic.html?p=03-mvcc)).

**Deadlocks after a "harmless" refactor.** A team moves "update order totals" before "decrement stock" in one code path but not in another. Deadlocks go from 0 to 300/hour on a sale day; each costs a 1 s stall plus a retry. Detection: `pg_stat_database.deadlocks` rising, server log DETAIL lines naming the two statements. Fix: a documented lock order (order row, then stock rows sorted by SKU, then payment row) enforced in a shared data-access function.

**InnoDB insert deadlocks on an upsert path.** A MySQL service does `SELECT … FOR UPDATE` by natural key, then INSERT if absent. Under concurrent requests for new keys, gap locks from the SELECTs block each other's inserts, and `SHOW ENGINE INNODB STATUS` shows `LATEST DETECTED DEADLOCK` with `lock_mode X locks gap before rec insert intention waiting`. Fix: `INSERT … ON DUPLICATE KEY UPDATE`, or insert first and handle the duplicate-key error, or READ COMMITTED for that transaction.

**Lock-manager contention on a partitioned table.** A table with 1,000 daily partitions, each with 4 indexes, is queried with a predicate the planner cannot prune (a parameter type mismatch). Each query locks thousands of relations, overflowing the fast-path slots; at 2,000 QPS backends pile up on `LWLock:LockManager` and CPU is high with low throughput. Fix: make pruning work (correct types, prune-friendly predicates), reduce partition count, and raise `max_locks_per_transaction` if needed.

### Metrics to watch

| Metric | Source | Signal |
|---|---|---|
| Sessions waiting on locks, by `wait_event` | `pg_stat_activity` | lock pile-ups (relation vs transactionid vs tuple) |
| Longest lock wait | `pg_locks.waitstart` (PG 14+) | stuck DDL or hot rows |
| Deadlocks | `pg_stat_database.deadlocks`, log | lock-order regressions |
| Lock wait log lines | `log_lock_waits` | waits > `deadlock_timeout`, with holder PIDs |
| Oldest transaction / idle in transaction | `pg_stat_activity` | future blockers |
| `LWLock:LockManager` waits | `pg_stat_activity` sampling | too many relations per query |
| Multixact age | `mxid_age(datminmxid)` | heavy share-locking churn |
| InnoDB: lock waits, deadlocks | `performance_schema.data_lock_waits`, `SHOW ENGINE INNODB STATUS`, `innodb_print_all_deadlocks` | gap-lock and hot-row issues |

### Scaling notes

Lock contention does not go away with bigger hardware; it is a property of the workload's access pattern. Scale it by shrinking lock hold time (short transactions, hot updates last), shrinking lock scope (row not table, `CONCURRENTLY` DDL, weaker FK locks), and spreading hot rows (Ch 04's sharded counters). At the cluster level, partitioning can reduce lock contention on maintenance (vacuum and DDL per partition) but increases lock-manager work per query unless pruning is effective.

## 9. Interview Questions

**Q: Why did a fast ALTER TABLE take the whole application down?**
A: The ALTER needed an ACCESS EXCLUSIVE lock, which conflicts with the ACCESS SHARE lock held by a long-running query or an idle-in-transaction session that had read the table. While it waited, every new query on the table conflicted with the *waiting* ALTER, and PostgreSQL does not let later requests jump ahead of a conflicting waiter, so they all queued behind it. The ALTER's own work would have taken milliseconds; the outage was entirely the wait. The fix is `lock_timeout` on DDL with retries, and clearing long transactions before migrating.

**Q: Where does PostgreSQL store row locks, and what are the consequences?**
A: In the tuple itself: the locker's XID goes into `xmax` with lock-mode bits in the infomask, and multiple share-lockers are represented by a MultiXact ID. So row locks do not consume shared memory, and you can lock millions of rows. The consequences are that taking a row lock writes the page and WAL, waiting for a row shows up as waiting for the holder's transaction ID in `pg_locks`, and heavy share-locking generates multixacts that need vacuuming and can themselves approach wraparound.

**Q: What are the four row-level lock modes, and why do the weak ones exist?**
A: FOR KEY SHARE, FOR SHARE, FOR NO KEY UPDATE and FOR UPDATE, in increasing strength. The weak ones exist for foreign keys: inserting a child row takes FOR KEY SHARE on the parent to stop it being deleted or having its key changed, while an ordinary UPDATE of non-key columns takes FOR NO KEY UPDATE. Those two do not conflict, so updating an order's status and inserting its line items can proceed concurrently. FOR UPDATE, taken by DELETE and key-changing updates, conflicts with all of them.

**Q: Which table lock does each of SELECT, UPDATE, CREATE INDEX and CREATE INDEX CONCURRENTLY take, and what do they block?**
A: SELECT takes ACCESS SHARE, which conflicts only with ACCESS EXCLUSIVE. UPDATE takes ROW EXCLUSIVE, which conflicts with SHARE and stronger, so it coexists with reads and other writes. Plain CREATE INDEX takes SHARE, which blocks all INSERT, UPDATE and DELETE for the entire build. CREATE INDEX CONCURRENTLY takes SHARE UPDATE EXCLUSIVE, which blocks neither reads nor writes but conflicts with VACUUM and other schema changes, at the cost of a slower two-pass build and a possible INVALID index on failure.

**Q: How does PostgreSQL detect deadlocks, and what does the application see?**
A: A backend that has waited for `deadlock_timeout`, one second by default, runs the deadlock detector, which walks the wait-for graph from the lock table looking for a cycle back to itself. If it finds one it aborts its own transaction with "deadlock detected", SQLSTATE 40P01, and the details list which process waited for which transaction. The other transactions then proceed. The application should roll back and retry the whole transaction, and investigate lock ordering if the rate rises.

**Q: How do you prevent deadlocks rather than just surviving them?**
A: Make every code path acquire locks in one global order, typically ascending primary key, and acquire them up front — for example `SELECT … WHERE id = ANY($1) ORDER BY id FOR UPDATE` before the updates. Keep transactions short and lock only what you need, and index the columns used in locking WHERE clauses and foreign keys so statements do not lock or scan more than intended. Keep a retry for 40P01 anyway, because some orderings, like triggers and FK checks, are not obvious.

**Q: What do NOWAIT and SKIP LOCKED do, and when do you use each?**
A: Both change what happens when a row you want to lock is already locked. NOWAIT raises an error immediately (SQLSTATE 55P03) instead of waiting, which suits user-facing "this record is being edited" flows and fail-fast APIs. SKIP LOCKED silently skips locked rows, which makes it ideal for competing consumers claiming jobs from a queue table without blocking each other. SKIP LOCKED deliberately gives an incomplete view, so never use it for queries that must see every row.

**Q: How do you find what is blocking a query in PostgreSQL?**
A: Use `pg_blocking_pids(pid)` together with `pg_stat_activity`: it returns the PIDs blocking a backend, including blocking caused by queue order behind a waiting request. A blocking-tree query lists each waiting session, whom it is waiting for, its wait event and transaction age, and identifies root blockers — sessions that block others but are not blocked. For detail, `pg_locks` shows the lock type, mode, granted flag and wait start. `log_lock_waits` records waits longer than `deadlock_timeout` in the log for after-the-fact analysis.

**Q: How do InnoDB's gap and next-key locks differ from PostgreSQL's approach, and why do they cause insert deadlocks?**
A: InnoDB locks index records and, at REPEATABLE READ, the gaps before them — next-key locks — on every record a locking statement scans, to prevent phantoms. Gap locks are compatible with each other but block insert-intention locks into the gap. So two transactions that each run `SELECT … FOR UPDATE` on the same missing key both get the gap lock, then both try to insert into that gap and wait on each other: a deadlock. PostgreSQL has no gap locks; concurrent inserts of the same key are serialised by the unique index, and phantom protection comes from SSI.

**Q: Design a safe process for schema migrations on a busy PostgreSQL database with respect to locking. (Senior)**
A: Every step gets a lock budget: run with a low `lock_timeout` (1–5 s) and `statement_timeout`, wrapped in a retry loop with backoff, so a blocked step fails fast instead of queueing traffic. Before running, the tool checks for transactions older than a threshold touching the table and aborts or waits. Steps are rewritten to use weaker locks: `CREATE INDEX CONCURRENTLY`, `ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT`, constant defaults, batching data backfills, and avoiding table rewrites. Operationally I would set `idle_in_transaction_session_timeout`, avoid running migrations during anti-wraparound vacuums, and alert on lock-wait pile-ups during deploys.

**Q: Deadlocks jumped from near zero to hundreds per hour after a release. How do you investigate? (Senior)**
A: The deadlock log entries give the two processes, the transaction IDs they waited on, the relation and tuple, and with query details in the server log, the statements involved. I would group them by statement pair to find the dominant pattern, then diff the release for changes in the order code paths touch tables or rows — a moved UPDATE, a new trigger, a new FK, or batch operations iterating in request order. The fix is imposing a global lock order in a shared data-access layer, adding up-front ordered `FOR UPDATE`, and keeping the 40P01 retry. I would add a dashboard for `pg_stat_database.deadlocks` so the next regression is caught in canary.

**Q: A partitioned table with 2,000 partitions shows high CPU and waits on LWLock:LockManager at modest QPS. What is happening? (Senior)**
A: Each query that cannot prune partitions must lock every partition and its indexes — thousands of relations. Weak relation locks normally go into per-backend fast-path slots, but there are only a few of them, so the rest go into the shared lock table, whose partitions are protected by LWLocks; at concurrency, backends contend on those. The same pattern can exhaust the lock table and produce "out of shared memory". The fix is making pruning work — matching parameter types, predicates on the partition key, plan-time or run-time pruning — reducing the partition count, and raising `max_locks_per_transaction` as a secondary measure.

## 10. Quick Revision & Cheat Sheet

| Statement | Table lock | Blocks |
|---|---|---|
| `SELECT` | ACCESS SHARE | only ACCESS EXCLUSIVE |
| `SELECT … FOR UPDATE` | ROW SHARE (+ row locks) | EXCLUSIVE, ACCESS EXCLUSIVE |
| `INSERT/UPDATE/DELETE` | ROW EXCLUSIVE | SHARE and stronger |
| `VACUUM`, `CREATE INDEX CONCURRENTLY`, `VALIDATE CONSTRAINT` | SHARE UPDATE EXCLUSIVE | itself and stronger |
| `CREATE INDEX` | SHARE | all writes |
| `ADD FOREIGN KEY` | SHARE ROW EXCLUSIVE | writes (both tables) |
| most `ALTER TABLE`, `DROP`, `TRUNCATE`, `VACUUM FULL` | ACCESS EXCLUSIVE | everything, incl. SELECT |

| Row lock | Taken by | Conflicts with |
|---|---|---|
| KEY SHARE | FK check | UPDATE |
| SHARE | `FOR SHARE` | NO KEY UPDATE, UPDATE |
| NO KEY UPDATE | ordinary UPDATE | SHARE, NO KEY UPDATE, UPDATE |
| UPDATE | DELETE, key UPDATE, `FOR UPDATE` | all |

**Remember this**
- Every statement takes a table lock; SELECT's is just very weak.
- Locks are granted through a queue: a *waiting* strong lock blocks later weak ones.
- Always put `lock_timeout` on DDL; the outage is the wait, not the work.
- PG row locks live in tuples; row waits show as `transactionid` / `tuple` waits.
- Deadlock detection runs after `deadlock_timeout` (1 s); victim gets 40P01 — retry.
- Prevent deadlocks with a global lock order and short transactions.
- `NOWAIT` = fail fast; `SKIP LOCKED` = work queues only.
- InnoDB locks index ranges (next-key/gap) and detects deadlocks immediately; MySQL DDL queues on metadata locks.

## 11. Hands-On Exercises

Lab: `docker run -d --name pg -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17`, three psql sessions.

1. **Recreate the queue-jump outage.** Session 1: `BEGIN; SELECT count(*) FROM orders;` (leave open). Session 2: `ALTER TABLE orders ADD COLUMN x int;` (hangs). Session 3: `SELECT 1 FROM orders LIMIT 1;` (hangs). Run the blocking-tree query from a fourth session and identify the root blocker. Repeat with `SET lock_timeout = '2s'` in session 2.
2. **Row-lock anatomy.** Reproduce the `pg_locks` output from §5 with two waiters on the same row; identify which waits on `transactionid` and which on `tuple`. Use the `pgrowlocks` extension to list locked rows of the table.
3. **Deadlock and ordering.** Reproduce the two-SKU deadlock, read the server log (`docker logs pg`), then implement the sorted `FOR UPDATE` version and hammer it with `pgbench -c 16` using random SKU pairs; confirm zero deadlocks.
4. **FK lock modes.** With `orders` and `order_lines` (FK), show that `INSERT INTO order_lines` and `UPDATE orders SET status = …` on the same order do not block each other, but `UPDATE orders SET id = …` or `DELETE FROM orders` does.
5. **SKIP LOCKED queue.** Build the `jobs` table from §5, insert 100k jobs, run 8 concurrent workers (a small script or `pgbench -f`) claiming batches of 10, and verify no job is processed twice. Then remove `SKIP LOCKED` and observe throughput.
6. **MySQL gap-lock deadlock (optional).** In `mysql:8` reproduce the §4 "check-then-insert" deadlock and read `LATEST DETECTED DEADLOCK` in `SHOW ENGINE INNODB STATUS`.

### Mini project — "Lock doctor"

Build a CLI that connects to PostgreSQL and prints, in one screen: the blocking tree (root blockers first) with transaction ages and queries; any DDL currently waiting; sessions idle in transaction longer than 30 s; deadlocks since last run (from `pg_stat_database`); and relations with the most granted locks. Add a `--migrate-check <table>` mode that exits non-zero if any transaction older than 5 s holds a lock on the table — suitable as a pre-migration gate in CI/CD. Extension: parse `log_lock_waits` and deadlock entries from the server log and group them by statement fingerprint.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 03 · MVCC](topic.html?p=03-mvcc) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) · [Ch 06 · Isolation Deep Dive](topic.html?p=06-isolation-deep-dive) (SSI predicate locks) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) (timeouts and pools) · [Ch 23 · Bottleneck Diagnosis](topic.html?p=23-bottleneck-diagnosis) · [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution) (lock-safe migrations).

**SQL Handbook:** [Locking, MVCC & Deadlocks](../sql/topic.html?p=27-locking-mvcc) · [Isolation Levels](../sql/topic.html?p=26-isolation-levels) · [Keys & Constraints](../sql/topic.html?p=29-keys-constraints).

**Other handbooks:** [Caching with Redis · Distributed Locks & Redlock](../redis-caching/topic.html?p=23-distributed-locks-redlock) (locks outside the database) · [Kafka & RabbitMQ · What Is a Message Queue?](../messaging/topic.html?p=01-what-is-a-message-queue) (when a queue table should be a broker).

- **PostgreSQL docs — Explicit Locking** — PostgreSQL · *Intermediate* · the authoritative table/row lock modes, conflict tables and advisory locks. <https://www.postgresql.org/docs/current/explicit-locking.html>
- **PostgreSQL docs — pg_locks** — PostgreSQL · *Intermediate* · every column of the lock view and how waits are represented. <https://www.postgresql.org/docs/current/view-pg-locks.html>
- **PostgreSQL Wiki — Lock Monitoring** — PostgreSQL community · *Intermediate* · battle-tested queries for finding blockers. <https://wiki.postgresql.org/wiki/Lock_Monitoring>
- **PostgreSQL docs — Lock Management settings** — PostgreSQL · *Intermediate* · `deadlock_timeout`, `max_locks_per_transaction` and friends. <https://www.postgresql.org/docs/current/runtime-config-locks.html>
- **MySQL docs — InnoDB Locking** — Oracle · *Intermediate* · record, gap, next-key and insert-intention locks explained with examples. <https://dev.mysql.com/doc/refman/8.0/en/innodb-locking.html>
- **MySQL docs — Deadlocks in InnoDB** — Oracle · *Intermediate* · detection, victim choice and how to minimise deadlocks. <https://dev.mysql.com/doc/refman/8.0/en/innodb-deadlocks.html>
- **The Internals of PostgreSQL, ch. 5 (Concurrency Control)** — Hironobu Suzuki · *Advanced* · row locking in tuple headers alongside MVCC. <https://www.interdb.jp/pg/>

---

*Database Design Handbook — chapter 05.*
