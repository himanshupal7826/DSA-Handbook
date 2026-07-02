# 27 · Locking, MVCC & Deadlocks

> **In one line:** MVCC keeps multiple versions of each row so readers never block writers, while locks serialize conflicting writers — and when two writers wait on each other in a cycle, the engine breaks the deadlock by aborting a victim.

---

## 1. Overview

Concurrency control is how a database lets many transactions run at once without corrupting data. Two mechanisms do the heavy lifting: **MVCC** (Multi-Version Concurrency Control) for reads, and **locks** for conflicting writes.

The classic problem MVCC solves is the reader-writer conflict. In a naive lock-everything design, a long report reading a table blocks every writer, and any writer blocks every reader. **MVCC** breaks this by keeping *multiple versions* of a row: a writer creates a new version while the old one stays visible to transactions that started earlier. So **readers never block writers and writers never block readers** — they only see different versions. Locks are then only needed between *writers* that touch the same row.

But locks introduce a new hazard: **deadlock**. If T1 holds row A and wants row B while T2 holds row B and wants row A, neither can proceed. The engine detects the wait-for **cycle** and aborts one transaction (the **victim**) so the other completes.

This page covers MVCC version chains and snapshots, **row vs. table locks**, explicit `SELECT … FOR UPDATE`/`FOR SHARE`, the **optimistic vs. pessimistic** locking strategies, how **deadlocks** form and how consistent lock ordering prevents them, and the maintenance cost of MVCC: dead tuples, **bloat**, and **VACUUM**. It builds directly on *Transactions & ACID* and *Isolation Levels & Concurrency Anomalies*.

## 2. Core Concepts

- **MVCC** — each write creates a new **row version** instead of overwriting; old versions linger until no snapshot needs them. Readers see the version valid as of their snapshot.
- **Snapshot** — the set of transactions considered "committed and visible" to a given transaction/statement; determines which row version each read returns.
- **Version chain** — the linked sequence of a row's versions (PostgreSQL links heap tuples via `ctid`; InnoDB reconstructs older versions from the **undo log**).
- **Row lock** — a lock on a single row; taken by `UPDATE`/`DELETE`/`SELECT FOR UPDATE`. Fine-grained, high concurrency.
- **Table lock** — a lock on a whole table; taken by DDL (`ALTER`), `LOCK TABLE`, or lock escalation in some engines. Coarse, low concurrency.
- **`FOR UPDATE`** — an exclusive row lock acquired by a `SELECT`, reserving rows for a later write (prevents lost updates).
- **`FOR SHARE` / `LOCK IN SHARE MODE`** — a shared row lock: others may read, not write, the row until you commit.
- **Pessimistic locking** — lock first, then work; assumes conflicts are likely. Uses `FOR UPDATE`.
- **Optimistic locking** — don't lock; detect conflict at write time via a **version column** and retry. Assumes conflicts are rare.
- **Deadlock** — a cycle of transactions each waiting for a lock another holds; the engine aborts a **victim** to break it.
- **VACUUM / purge** — background reclamation of dead row versions no snapshot can see; prevents **bloat** and transaction-ID wraparound.

## 3. Syntax & Examples

Pessimistic read-modify-write — lock the row, then update safely:

```sql
BEGIN;
  SELECT stock FROM products WHERE id = 42 FOR UPDATE;   -- exclusive row lock
  -- another txn's FOR UPDATE / UPDATE on id=42 now blocks
  UPDATE products SET stock = stock - 1 WHERE id = 42;
COMMIT;                                                   -- lock released
```

Shared lock — pin a row you're reading so nobody changes it mid-transaction:

```sql
-- PostgreSQL
SELECT * FROM accounts WHERE id = 1 FOR SHARE;
-- MySQL
SELECT * FROM accounts WHERE id = 1 LOCK IN SHARE MODE;   -- (8.0: FOR SHARE)
```

Skip or fail fast instead of waiting — great for job-queue workers:

```sql
-- grab the next free job without blocking on locked rows
SELECT id FROM jobs WHERE state='ready'
ORDER BY id LIMIT 1
FOR UPDATE SKIP LOCKED;                 -- or FOR UPDATE NOWAIT to error immediately
```

Optimistic locking with a version column — no locks held, conflict detected at write:

```sql
-- read
SELECT id, qty, version FROM inventory WHERE id = 42;    -- version = 7
-- write only if nobody else bumped it
UPDATE inventory SET qty = qty - 1, version = version + 1
WHERE id = 42 AND version = 7;
-- if 0 rows affected → someone changed it → reload and retry
```

Atomic in-place update (avoids the whole read-modify-write race):

```sql
UPDATE counters SET n = n + 1 WHERE id = 1;              -- single statement, no lost update
```

## 4. Sample Data & Results

Two sessions decrement the same product's stock. Table `products`:

| id | name   | stock |
|----|--------|-------|
| 42 | Widget | 1     |

**Without protection** (both read then write) → lost update, stock goes to 0 but *two* orders shipped from a stock of 1 — oversold. **With `FOR UPDATE`**, T2 blocks until T1 commits, then re-reads the *current* value:

T1:
```sql
BEGIN;
  SELECT stock FROM products WHERE id=42 FOR UPDATE;   -- 1
  UPDATE products SET stock = stock-1 WHERE id=42;     -- 0
COMMIT;
```

T2 (started concurrently, blocks at its `FOR UPDATE` until T1 commits):
```sql
BEGIN;
  SELECT stock FROM products WHERE id=42 FOR UPDATE;   -- sees 0 after unblocking
  -- app logic: stock is 0, refuse the order
ROLLBACK;
```

Final table — exactly one unit sold, no oversell:

| id | name   | stock |
|----|--------|-------|
| 42 | Widget | 0     |

Meanwhile a concurrent **reporting** query `SELECT sum(stock) FROM products` at the same instant never blocks — MVCC serves it the last-committed version. That's the payoff: the writer's lock doesn't touch readers.

## 5. Under the Hood

**MVCC version chain.** When a transaction updates a row, the engine doesn't overwrite it — it writes a *new* version stamped with the writing transaction's id (`xmin`) and marks the old version's end (`xmax`). Each reader compares versions against its snapshot and picks the newest one that was committed before the snapshot began. A `SELECT` running concurrently with the `UPDATE` still sees the old version — no blocking.

```svg
<svg viewBox="0 0 720 260" width="100%" height="260" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">MVCC version chain for row id=42 (balance)</text>

  <rect x="40" y="90" width="160" height="72" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="120" y="114" text-anchor="middle" fill="#1e293b" font-weight="600">v1  balance=100</text>
  <text x="120" y="134" text-anchor="middle" fill="#64748b">xmin=10  xmax=20</text>
  <text x="120" y="152" text-anchor="middle" fill="#64748b">(superseded)</text>

  <rect x="280" y="90" width="160" height="72" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="114" text-anchor="middle" fill="#1e293b" font-weight="600">v2  balance=120</text>
  <text x="360" y="134" text-anchor="middle" fill="#64748b">xmin=20  xmax=35</text>
  <text x="360" y="152" text-anchor="middle" fill="#64748b">(superseded)</text>

  <rect x="520" y="90" width="160" height="72" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="600" y="114" text-anchor="middle" fill="#1e293b" font-weight="600">v3  balance=90</text>
  <text x="600" y="134" text-anchor="middle" fill="#64748b">xmin=35  xmax=∞</text>
  <text x="600" y="152" text-anchor="middle" fill="#059669">(current)</text>

  <line x1="200" y1="126" x2="276" y2="126" stroke="#475569" marker-end="url(#a2)"/>
  <line x1="440" y1="126" x2="516" y2="126" stroke="#475569" marker-end="url(#a2)"/>

  <rect x="40" y="196" width="300" height="40" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="190" y="221" text-anchor="middle" fill="#1e293b">Reader with snapshot @ xid=25 → sees v2 (120)</text>
  <rect x="380" y="196" width="300" height="40" rx="8" fill="#fff" stroke="#475569"/>
  <text x="530" y="221" text-anchor="middle" fill="#1e293b">Reader with snapshot @ xid=40 → sees v3 (90)</text>
</svg>
```

Different snapshots read different versions of the *same* row, simultaneously, without locks. Writers only contend with other writers of the same row, via the row lock.

**Deadlock.** Two writers each hold one row and want the other, forming a **wait-for cycle**. Neither can make progress. A deadlock detector (or a lock-timeout) finds the cycle and aborts one transaction with a deadlock error so the other proceeds.

```svg
<svg viewBox="0 0 720 240" width="100%" height="240" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a3" markerWidth="10" markerHeight="10" refX="8" refY="4" orient="auto">
      <path d="M0,0 L9,4 L0,8 Z" fill="#b91c1c"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Deadlock: a wait-for cycle</text>

  <rect x="120" y="70" width="160" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="200" y="94" text-anchor="middle" fill="#1e293b" font-weight="600">T1</text>
  <text x="200" y="114" text-anchor="middle" fill="#64748b">holds A, wants B</text>

  <rect x="440" y="70" width="160" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="520" y="94" text-anchor="middle" fill="#1e293b" font-weight="600">T2</text>
  <text x="520" y="114" text-anchor="middle" fill="#64748b">holds B, wants A</text>

  <line x1="280" y1="88" x2="440" y2="88" stroke="#b91c1c" marker-end="url(#a3)"/>
  <text x="360" y="80" text-anchor="middle" fill="#b91c1c">waits for B</text>
  <line x1="440" y1="112" x2="280" y2="112" stroke="#b91c1c" marker-end="url(#a3)"/>
  <text x="360" y="128" text-anchor="middle" fill="#b91c1c">waits for A</text>

  <rect x="210" y="170" width="300" height="46" rx="8" fill="#fdecea" stroke="#b91c1c"/>
  <text x="360" y="190" text-anchor="middle" fill="#b91c1c" font-weight="600">Detector breaks the cycle</text>
  <text x="360" y="208" text-anchor="middle" fill="#64748b">aborts a victim (e.g. T2) → T1 proceeds</text>
</svg>
```

**Prevention: consistent lock order.** If *every* transaction locks rows in the same global order (e.g. always the lower `id` first), no cycle can form — the transaction that grabs the lowest id first always wins, and others simply wait in line.

## 6. Variations & Trade-offs

| | Pessimistic (`FOR UPDATE`) | Optimistic (version column) |
|--|---------------------------|-----------------------------|
| When conflicts are… | frequent | rare |
| Holds locks? | Yes, until commit | No |
| Cost of conflict | Blocking / waiting | Retry the whole unit |
| Deadlock risk | Yes | No (no locks) but livelock under high contention |
| Long think-time / web | Bad (holds lock across round-trip) | Good (lock-free between read and write) |
| Typical use | inventory decrement, transfers | edit-a-form, low-contention records |

| Lock granularity | Concurrency | Overhead | Taken by |
|------------------|-------------|----------|----------|
| Row lock | High | More locks to track | `UPDATE`, `DELETE`, `FOR UPDATE` |
| Page/gap lock | Medium | Moderate | InnoDB next-key (phantom prevention) |
| Table lock | Low | Cheap to hold | DDL, `LOCK TABLE`, escalation |

**MVCC engines vs. version storage:** PostgreSQL stores every version *in the heap* and needs `VACUUM` to remove dead tuples — great for cheap rollback/updates, but updates cause **bloat** and index churn (mitigated by HOT updates). InnoDB keeps the current version in place and older versions in the **undo log**, purged by a background thread — compact heap, but long-running readers grow the **history list** (undo). Oracle is similar to InnoDB with undo/rollback segments. SQLite is single-writer, so it sidesteps most of this.

## 7. Performance Notes

- **MVCC's tax is dead tuples.** Every `UPDATE`/`DELETE` leaves an old version behind. `VACUUM` (Postgres) / purge (InnoDB) reclaims it; if it can't keep up (or a long transaction holds an old snapshot), tables and indexes **bloat**, scans read more pages, and performance degrades. Keep transactions short.
- **`SELECT … FOR UPDATE` serializes writers on a hot row.** A single popular row (a global counter, a "current inventory" row) becomes a contention point. Use `SKIP LOCKED` for queues, shard the counter, or use atomic `x = x + 1`.
- **`FOR UPDATE SKIP LOCKED` is the idiomatic job-queue primitive** — workers grab disjoint rows without piling up on the same locked head-of-queue.
- **Deadlocks cost a full transaction abort + retry.** Frequent deadlocks usually mean inconsistent lock ordering or overly broad locks; fix the *order*, don't just raise `deadlock_timeout`.
- **Index the columns you lock/filter on.** An `UPDATE … WHERE unindexed_col` may scan and lock far more rows than intended (in InnoDB, next-key locks over the scanned range), inflating contention and deadlock risk.
- **Autovacuum tuning matters at scale.** For update-heavy tables, make autovacuum more aggressive (lower scale factor) so bloat doesn't accumulate between runs; watch `n_dead_tup` and the oldest-snapshot age.

## 8. Common Mistakes

1. ⚠️ **Read-modify-write without a lock or version check** → lost update / oversell. *Fix:* `FOR UPDATE`, atomic `x = x + 1`, or an optimistic `WHERE version = :v`.
2. ⚠️ **Inconsistent lock ordering across code paths** → deadlocks. *Fix:* always acquire locks in a fixed global order (e.g. ascending primary key).
3. ⚠️ **Holding `FOR UPDATE` across user think-time or a network call** → the row is locked for seconds, throttling everyone. *Fix:* prefer optimistic locking for interactive edits.
4. ⚠️ **Ignoring deadlock/serialization errors** instead of retrying → user-facing failures on a normal, expected condition. *Fix:* catch and retry with backoff.
5. ⚠️ **Long-running transactions starving VACUUM** → unbounded bloat and slowdowns. *Fix:* keep transactions short; don't leave sessions "idle in transaction."
6. ⚠️ **Locking via an unindexed predicate** → far more rows locked than expected (and phantom-range gap locks in InnoDB). *Fix:* index the filter column.
7. ⚠️ **Assuming a plain `SELECT` blocks writers (or is blocked by them)** → it doesn't under MVCC; you may read a stale-but-consistent snapshot. *Fix:* if you need to reserve the row, use `FOR UPDATE`/`FOR SHARE`.

## 9. Interview Questions

**Q: What problem does MVCC solve, in one sentence?**
A: It lets readers and writers run concurrently without blocking each other by keeping multiple versions of each row, so a reader sees a consistent old version while a writer creates a new one.

**Q: Under MVCC, does a plain SELECT block an UPDATE on the same row?**
A: No. The `UPDATE` creates a new version; the `SELECT` continues reading the version valid as of its snapshot. Readers don't block writers and writers don't block readers — only two writers of the same row contend.

**Q: What is the difference between a row lock and a table lock?**
A: A row lock protects a single row (taken by `UPDATE`/`DELETE`/`FOR UPDATE`) and allows high concurrency; a table lock protects the whole table (taken by DDL, `LOCK TABLE`, or escalation) and blocks most concurrent access. Prefer the finest granularity that's correct.

**Q: What does SELECT … FOR UPDATE do and when do you use it?**
A: It takes an exclusive lock on the selected rows so other transactions can't update/lock them until you commit. Use it for read-modify-write cycles (inventory decrement, money transfer) to prevent lost updates.

**Q: Contrast optimistic and pessimistic locking.**
A: Pessimistic locks the row up front (`FOR UPDATE`) assuming conflicts are likely — safe but holds locks and risks deadlock/waiting. Optimistic takes no lock, reads a version column, and only commits if the version is unchanged (`WHERE version = :v`), retrying on conflict — better when conflicts are rare or think-time is long.

**Q: How does a deadlock form and how does the database resolve it?**
A: Two (or more) transactions form a wait-for cycle — each holds a lock the other needs. The engine's deadlock detector finds the cycle and aborts a victim transaction (releasing its locks) so the others proceed; the victim must retry.

**Q: How do you prevent deadlocks in application code?**
A: Acquire locks in a consistent global order across all code paths (e.g. always lock rows in ascending primary-key order), keep transactions short, lock only what you need, and index locked predicates so you don't lock extra rows.

**Q: What is VACUUM / purge and why is it necessary?**
A: MVCC leaves dead row versions behind on every update/delete. VACUUM (PostgreSQL) or the purge thread (InnoDB) reclaims versions no snapshot can still see. Without it, tables and indexes bloat, scans slow down, and (in Postgres) transaction-ID wraparound becomes a risk.

**Q: (Senior) How do PostgreSQL and InnoDB differ in where they store old row versions, and what maintenance cost each incurs?**
A: PostgreSQL stores all versions inline in the heap and relies on VACUUM to remove dead tuples — updates cause heap/index bloat (partly mitigated by HOT updates). InnoDB keeps the current row in place and older versions in the undo log, purged by a background thread — a long-running reader grows the undo/history list instead of heap bloat. Both punish long transactions, differently.

**Q: (Senior) Why is FOR UPDATE SKIP LOCKED the right tool for a job queue?**
A: Multiple workers each want a *different* ready job. `FOR UPDATE` alone makes them all block on the same head-of-queue row. `SKIP LOCKED` makes each worker skip rows already locked by another and grab the next free one, so N workers pull N disjoint jobs concurrently with no contention.

**Q: (Senior) An UPDATE with an unindexed WHERE clause is causing deadlocks in InnoDB. Why, and what's the fix?**
A: Without an index, InnoDB scans and takes next-key locks across a wide range of rows (and gaps), so two such statements easily overlap and form a cycle. Adding an index on the WHERE column narrows the locked set to the matching rows, drastically cutting overlap and deadlock probability.

**Q: (Senior) Optimistic locking eliminates deadlocks — so why not always use it?**
A: Because under high write contention it degrades into repeated conflict-and-retry (wasted work, potential livelock) and offers no ordering/fairness; each retry re-reads and re-computes. For a genuinely hot row, pessimistic `FOR UPDATE` (or an atomic in-place update, or sharding the counter) gives more predictable throughput than an ever-retrying optimistic loop.

## 10. Practice

- [ ] Reproduce a lost update on a stock=1 row with two concurrent read-then-write sessions, then fix it with `FOR UPDATE`.
- [ ] Force a deadlock: in two sessions lock rows A then B vs B then A; observe the deadlock error and which session is chosen as victim.
- [ ] Rewrite the deadlocking transactions to lock in ascending id order and confirm the deadlock disappears.
- [ ] Build a mini job queue and pull work from two workers using `FOR UPDATE SKIP LOCKED`; verify they never grab the same row.
- [ ] Run an update-heavy loop, watch `n_dead_tup` grow in `pg_stat_user_tables`, then `VACUUM` and watch it drop.
- [ ] Implement optimistic locking with a `version` column and observe the 0-rows-affected conflict, then retry.

## 11. Cheat Sheet

> [!TIP]
> **Locking, MVCC & Deadlocks —**
> **MVCC:** every write makes a new row version; readers pick the version their snapshot can see → readers don't block writers, writers don't block readers. Only writer-vs-writer on the same row contends.
> **Locks:** row (fine, `UPDATE`/`FOR UPDATE`) < page/gap < table (coarse, DDL). `FOR UPDATE` = exclusive, `FOR SHARE` = shared, `SKIP LOCKED`/`NOWAIT` to avoid waiting.
> **Strategy:** pessimistic (`FOR UPDATE`, conflicts common) vs optimistic (`WHERE version=:v` + retry, conflicts rare / long think-time). Atomic `x=x+1` dodges the race entirely.
> **Deadlock** = wait-for cycle → engine aborts a victim → retry. Prevent with **consistent lock order** (ascending id), short txns, indexed predicates.
> **Cost of MVCC:** dead tuples → **VACUUM**/purge or you get bloat. Keep transactions short.

**References:** PostgreSQL docs — "Concurrency Control" (MVCC), "Explicit Locking", "Routine Vacuuming"; MySQL Reference Manual — "InnoDB Locking" & "InnoDB Multi-Versioning"; Use The Index, Luke; Kleppmann, "Designing Data-Intensive Applications" ch. 7

---
*SQL Handbook — topic 27.*
