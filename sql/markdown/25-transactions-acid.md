# 25 · Transactions & ACID

> **In one line:** A transaction bundles many statements into a single all-or-nothing unit that either commits as a whole or leaves the database untouched — with atomicity, consistency, isolation, and durability guaranteed by the engine.

---

## 1. Overview

A **transaction** is a logical unit of work: one or more statements that the database treats as an indivisible whole. The classic example is a money transfer — debit account A, credit account B. If the debit succeeds but the credit fails (crash, constraint violation, deadlock), you must *never* be left with money vanished into thin air. A transaction guarantees you either see **both** effects or **neither**.

The guarantees are summarized by the acronym **ACID**: **A**tomicity, **C**onsistency, **I**solation, **D**urability. Atomicity and durability are about surviving failure; isolation is about surviving *concurrency*; consistency is the invariant that emerges when the other three hold and your constraints are correct.

You reach for explicit transactions whenever a single business operation spans **multiple writes** that must agree, whenever you do a **read-modify-write** cycle that a concurrent session could corrupt, or whenever you want the option to **roll back** after inspecting intermediate results. Everything else — a lone `INSERT` — is still a transaction; it is just an implicit one that autocommits.

This page covers the transaction control statements (`BEGIN`/`COMMIT`/`ROLLBACK`), the four ACID properties with concrete failures they prevent, **savepoints** for partial rollback, **autocommit** semantics, and the **write-ahead log (WAL)** intuition behind durability. Isolation gets its own deep dive in *Isolation Levels & Concurrency Anomalies*, and the locking machinery in *Locking, MVCC & Deadlocks*.

## 2. Core Concepts

- **Transaction** — a sequence of operations bracketed so the engine applies them atomically. Delimited by `BEGIN`/`START TRANSACTION` … `COMMIT` or `ROLLBACK`.
- **Atomicity** — all statements take effect or none do. A failure mid-way triggers a rollback that undoes every change made since `BEGIN`.
- **Consistency** — a committed transaction moves the database from one valid state to another; declared **constraints** (PK, FK, `CHECK`, `NOT NULL`) and triggers are never left violated on commit.
- **Isolation** — concurrent transactions do not observe each other's uncommitted, half-finished state; the degree is set by the **isolation level**.
- **Durability** — once `COMMIT` returns, the change survives a crash or power loss, because it was flushed to a persistent **write-ahead log** first.
- **COMMIT** — makes all changes permanent and visible to other transactions; releases locks.
- **ROLLBACK** — discards all changes since `BEGIN` (or since a named savepoint), restoring the pre-transaction state.
- **Savepoint** — a named marker inside a transaction you can partially roll back to without aborting the whole thing.
- **Autocommit** — the default mode where each statement is its own transaction, committed immediately unless you open an explicit block.
- **Write-Ahead Logging (WAL)** — the engine writes the *intent to change* to a sequential log and fsyncs it **before** touching the data pages, so recovery can replay or undo.

## 3. Syntax & Examples

Start simple — an explicit block that either fully applies or fully reverts:

```sql
-- PostgreSQL / standard SQL
BEGIN;                          -- also: START TRANSACTION;
  UPDATE accounts SET balance = balance - 100 WHERE id = 1;
  UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;                         -- both rows change together, or (on error) neither
```

Roll back explicitly when application logic decides the work is invalid:

```sql
BEGIN;
  INSERT INTO orders(customer_id, total) VALUES (42, 250);
  -- app checks inventory, finds it insufficient:
ROLLBACK;                       -- the order INSERT never happened
```

**Savepoints** let you retry a sub-step without losing earlier work:

```sql
BEGIN;
  INSERT INTO orders(id, customer_id) VALUES (1001, 42);

  SAVEPOINT add_line;
  INSERT INTO order_lines(order_id, sku, qty) VALUES (1001, 'BAD-SKU', 5);
  -- FK violation raised → recover just this step:
  ROLLBACK TO SAVEPOINT add_line;

  INSERT INTO order_lines(order_id, sku, qty) VALUES (1001, 'GOOD-SKU', 5);
  RELEASE SAVEPOINT add_line;   -- optional: forget the marker
COMMIT;                         -- order 1001 + the good line persist
```

Controlling **autocommit** (dialect-specific):

```sql
-- MySQL: turn off per-session autocommit, then commit manually
SET autocommit = 0;
UPDATE accounts SET balance = balance - 50 WHERE id = 1;
COMMIT;

-- PostgreSQL psql: wrap in an explicit block (autocommit is on by default)
BEGIN; UPDATE ...; COMMIT;
```

Set the isolation level for the current transaction:

```sql
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
  -- strongest guarantee for this unit of work
COMMIT;
```

## 4. Sample Data & Results

Start with two accounts and transfer 100 from Alice to Bob **atomically**.

Input — `accounts`:

| id | owner | balance |
|----|-------|---------|
| 1  | Alice | 300     |
| 2  | Bob   | 50      |

The transaction:

```sql
BEGIN;
  UPDATE accounts SET balance = balance - 100 WHERE id = 1;
  UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;
```

Result after `COMMIT` — the invariant *total balance = 350* is preserved:

| id | owner | balance |
|----|-------|---------|
| 1  | Alice | 200     |
| 2  | Bob   | 150     |

Now suppose the second `UPDATE` had violated a `CHECK (balance >= 0)` or the connection dropped after the first `UPDATE`. **Atomicity** guarantees the rollback restores the *original* table — Alice keeps her 300, Bob keeps his 50 — never the corrupt intermediate state where Alice has 200 but Bob still has 50 (100 units destroyed):

| id | owner | balance | note                          |
|----|-------|---------|-------------------------------|
| 1  | Alice | 300     | debit undone by rollback      |
| 2  | Bob   | 50      | credit never applied          |

## 5. Under the Hood

Durability and atomicity are two faces of one mechanism: the **write-ahead log**. Before a modified ("dirty") data page is ever written to the main heap files, the engine appends a **log record** describing the change to a sequential WAL and `fsync`s it to disk. `COMMIT` writes a commit record and forces the log to durable storage — *that* fsync is the moment the transaction becomes durable. The heavyweight random writes to the actual table pages happen lazily afterward (at a **checkpoint**).

This design gives both guarantees cheaply:

- **Crash before commit** → the WAL has no commit record for that transaction, so on restart recovery **undoes** (rolls back) any of its changes that leaked to disk. Atomicity.
- **Crash after commit but before pages flushed** → recovery **redoes** the committed change by replaying the log against the data files. Durability.

Because the WAL is written **sequentially** (fast) while data pages are random (slow), WAL turns many small durable commits into cheap appends. PostgreSQL calls it the WAL; MySQL/InnoDB has the **redo log** (plus an **undo log** that also powers MVCC rollback); SQLite offers a rollback journal or WAL mode.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="arr" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 Z" fill="#475569"/>
    </marker>
  </defs>
  <text x="360" y="22" text-anchor="middle" fill="#1e293b" font-weight="700">Write-Ahead Logging: log first, data pages later</text>

  <!-- transaction -->
  <rect x="24" y="52" width="150" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="99" y="78" text-anchor="middle" fill="#1e293b" font-weight="600">Transaction</text>
  <text x="99" y="96" text-anchor="middle" fill="#64748b">UPDATE / INSERT</text>

  <!-- WAL -->
  <rect x="270" y="42" width="180" height="80" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="360" y="66" text-anchor="middle" fill="#1e293b" font-weight="600">WAL (sequential)</text>
  <text x="360" y="86" text-anchor="middle" fill="#64748b">log record + fsync</text>
  <text x="360" y="104" text-anchor="middle" fill="#059669" font-weight="600">durable @ COMMIT</text>

  <!-- data pages -->
  <rect x="546" y="52" width="150" height="60" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="621" y="76" text-anchor="middle" fill="#1e293b" font-weight="600">Data pages (heap)</text>
  <text x="621" y="94" text-anchor="middle" fill="#64748b">flushed at checkpoint</text>

  <line x1="174" y1="82" x2="266" y2="82" stroke="#475569" marker-end="url(#arr)"/>
  <text x="220" y="74" text-anchor="middle" fill="#64748b">1. log</text>
  <line x1="450" y1="82" x2="542" y2="82" stroke="#475569" stroke-dasharray="4 3" marker-end="url(#arr)"/>
  <text x="496" y="74" text-anchor="middle" fill="#64748b">2. later</text>

  <!-- recovery -->
  <rect x="180" y="182" width="360" height="86" rx="8" fill="#fff" stroke="#475569"/>
  <text x="360" y="206" text-anchor="middle" fill="#1e293b" font-weight="600">Crash recovery replays the WAL</text>
  <text x="360" y="228" text-anchor="middle" fill="#059669">REDO committed records → durability</text>
  <text x="360" y="248" text-anchor="middle" fill="#b91c1c">UNDO uncommitted records → atomicity</text>
  <line x1="360" y1="122" x2="360" y2="178" stroke="#475569" marker-end="url(#arr)"/>
</svg>
```

## 6. Variations & Trade-offs

| Aspect | Explicit transaction (`BEGIN…COMMIT`) | Autocommit (single statement) |
|--------|---------------------------------------|-------------------------------|
| Scope | Many statements as one unit | One statement = one txn |
| Multi-row atomicity | Yes, across all statements | Only within that one statement |
| Rollback control | Full — including `ROLLBACK TO SAVEPOINT` | None (already committed) |
| Lock duration | Held until COMMIT (longer) | Released immediately |
| Default? | Off (must open explicitly) | On, in most clients/drivers |

| Statement | Effect |
|-----------|--------|
| `COMMIT` | Persist all changes, release locks, end txn |
| `ROLLBACK` | Discard all changes since `BEGIN` |
| `SAVEPOINT s` | Mark a point to partially rewind to |
| `ROLLBACK TO SAVEPOINT s` | Undo work after `s`; transaction stays open |
| `RELEASE SAVEPOINT s` | Discard the marker (keep the work) |

**Trade-off:** longer explicit transactions buy you atomicity across many statements but hold locks and pin **MVCC** row versions longer, increasing contention and bloat. The senior discipline is *short transactions* — do slow work (external API calls, user think-time) **outside** the open block.

Dialect notes: PostgreSQL runs psql in autocommit and needs an explicit `BEGIN`. MySQL/InnoDB honors `SET autocommit = 0`. A rolled-back or errored transaction in PostgreSQL enters an **aborted state** — every subsequent statement fails with *"current transaction is aborted"* until you `ROLLBACK`; MySQL is more lenient and often continues.

## 7. Performance Notes

- **Keep transactions short.** Open late, commit early. An idle-in-transaction session pins the oldest snapshot, blocks `VACUUM`, and holds locks that stall writers.
- **Batch, but not unboundedly.** Wrapping 10,000 inserts in one transaction is far faster than 10,000 autocommits (one fsync instead of 10,000), but a million-row single transaction generates huge WAL/undo and long lock holds — chunk into batches of a few thousand.
- **The commit fsync dominates** small-write latency. Grouping writes amortizes it; some engines offer group commit or (dangerously) relaxed durability (`synchronous_commit = off` in Postgres, `innodb_flush_log_at_trx_commit = 2`) that trade a small crash window for throughput.
- **Never do network I/O inside a transaction.** A payment-gateway call between `BEGIN` and `COMMIT` holds locks for the round-trip latency.
- **Savepoints are cheap but not free** — each establishes a sub-transaction; thousands of them (e.g. per-row `ROLLBACK TO`) in one transaction can bloat internal structures in PostgreSQL.

## 8. Common Mistakes

1. ⚠️ **Forgetting to commit** — leaving a transaction open holds locks indefinitely and shows changes to nobody. *Fix:* always pair `BEGIN` with a `COMMIT`/`ROLLBACK`; use your driver's context manager (`with conn.begin():`).
2. ⚠️ **Relying on autocommit for multi-statement atomicity** — two separate autocommitted `UPDATE`s can leave money half-transferred if the second fails. *Fix:* wrap related writes in one explicit transaction.
3. ⚠️ **Doing slow external work inside the block** — user input, HTTP calls, file uploads between `BEGIN` and `COMMIT`. *Fix:* gather everything first, keep the transaction to the pure DB writes.
4. ⚠️ **Ignoring the aborted-transaction state** (PostgreSQL) — after any error, further statements silently fail. *Fix:* catch the error and `ROLLBACK` (or `ROLLBACK TO SAVEPOINT`) before continuing.
5. ⚠️ **Assuming ROLLBACK undoes side effects** — sequences/`AUTO_INCREMENT` values consumed in a rolled-back txn are **not** returned, leaving gaps. *Fix:* don't assume gapless IDs.
6. ⚠️ **Confusing consistency with isolation** — believing a transaction alone prevents concurrent anomalies. *Fix:* pick the correct **isolation level**; a transaction at READ COMMITTED still permits non-repeatable reads.
7. ⚠️ **Catching an exception but continuing to COMMIT** — swallowing an error then committing persists a partial result. *Fix:* on any error inside the block, roll back the whole unit.

## 9. Interview Questions

**Q: What does ACID stand for, and which property protects you from a crash mid-transaction?**
A: Atomicity, Consistency, Isolation, Durability. Atomicity protects against a mid-transaction crash — recovery undoes any partial changes so the transaction is all-or-nothing; durability protects against a crash *after* commit by replaying the log.

**Q: Explain atomicity with the money-transfer example.**
A: A transfer debits A and credits B. Atomicity guarantees both `UPDATE`s take effect or neither does. If the credit fails after the debit, the engine rolls back the debit too — you never destroy or duplicate money by leaving one leg applied.

**Q: What is the difference between COMMIT and ROLLBACK?**
A: `COMMIT` makes all changes since `BEGIN` permanent, visible to others, and releases locks. `ROLLBACK` discards all those changes, restoring the state as of `BEGIN` (or a savepoint).

**Q: What is a savepoint and when is it useful?**
A: A named marker inside a transaction. `ROLLBACK TO SAVEPOINT s` undoes work done after `s` without aborting the whole transaction — useful for retrying a risky sub-step (e.g. an optional insert that may violate a constraint) while keeping the earlier work.

**Q: What is autocommit and how does it interact with explicit transactions?**
A: In autocommit mode each statement is its own transaction, committed immediately. Opening an explicit `BEGIN` suspends autocommit until you `COMMIT`/`ROLLBACK`, so multiple statements become one atomic unit. MySQL exposes `SET autocommit=0`; PostgreSQL psql is autocommit-on and needs explicit `BEGIN`.

**Q: How does a write-ahead log provide durability without flushing every data page on commit?**
A: The change is described in a sequential log record that is fsynced at commit, while the random data-page writes happen lazily at a checkpoint. If the machine crashes before the pages are written, recovery replays (REDO) the committed log records against the data files. Sequential log fsync is far cheaper than random page fsyncs.

**Q: If a transaction rolls back, are consumed sequence / AUTO_INCREMENT values reused?**
A: No. Sequences are non-transactional for performance and concurrency; a value handed out in a rolled-back transaction is simply skipped, producing gaps. Design shouldn't assume gapless surrogate keys.

**Q: Is consistency (the C in ACID) something the database guarantees on its own?**
A: Only partially. The engine enforces declared constraints, FKs, and triggers at commit, and atomicity/isolation/durability keep transitions clean. But *application-level* invariants (e.g. "an order must have at least one line") are your responsibility to encode as constraints or logic — the database only guarantees the invariants you actually declare.

**Q: (Senior) Why is wrapping 10,000 inserts in one transaction faster than 10,000 autocommitted inserts, and what's the risk of a single giant transaction?**
A: One transaction pays a single commit fsync instead of 10,000, so it's dramatically faster. But an unbounded transaction generates huge WAL/undo, holds locks and MVCC snapshots for its whole duration (blocking `VACUUM` and writers), and a failure loses all the work. The balance is medium batches (a few thousand rows) per commit.

**Q: (Senior) A worker opened a transaction, made one update, then blocked on a slow API call for 30 seconds. What are the consequences?**
A: The row lock and the transaction's snapshot are held for 30 seconds. Other writers to that row block; `VACUUM`/purge can't reclaim versions older than this snapshot, causing bloat; and if it's "idle in transaction," monitoring flags it. Fix: do the API call before `BEGIN` or after `COMMIT`.

**Q: (Senior) In PostgreSQL, after a statement errors inside a transaction, the next statement fails with "current transaction is aborted." Why, and how does this differ from MySQL?**
A: PostgreSQL puts the whole transaction into an aborted state on any error to preserve atomicity — you must `ROLLBACK` (or `ROLLBACK TO SAVEPOINT` to a point before the error) to continue. MySQL/InnoDB by default only rolls back the failing statement and lets you proceed, which is more forgiving but can surprise you into committing partial work.

**Q: (Senior) How can you trade durability for throughput, and what's the exact risk?**
A: Relax the commit fsync: PostgreSQL `synchronous_commit = off` or MySQL `innodb_flush_log_at_trx_commit = 2`. Commits return before the log is guaranteed on disk, so a crash can lose the last fraction of a second of *committed* transactions — but the database stays *consistent* (no torn/partial transactions), unlike disabling atomicity. Acceptable for reconstructable data, not for financial ledgers.

## 10. Practice

- [ ] Write a transaction that transfers 200 between two accounts and add a `CHECK (balance >= 0)`; force the source below zero and confirm the whole transfer rolls back.
- [ ] Use a `SAVEPOINT` to attempt an insert that violates a FK, roll back to the savepoint, insert a valid row instead, and commit — verify only the valid row persists.
- [ ] In two psql sessions, `BEGIN` and update the same row in one; observe the second session blocking until the first commits or rolls back.
- [ ] Measure the timing difference between inserting 50,000 rows autocommitted vs. wrapped in a single transaction.
- [ ] Deliberately leave a transaction "idle in transaction" and observe its effect on `pg_stat_activity` and on `VACUUM` reclaiming dead tuples.

## 11. Cheat Sheet

> [!TIP]
> **Transactions & ACID —**
> `BEGIN` … `COMMIT` = all-or-nothing unit; `ROLLBACK` discards it; `SAVEPOINT s` + `ROLLBACK TO s` = partial rewind.
> **A**tomicity (all or none, via UNDO) · **C**onsistency (constraints hold on commit) · **I**solation (concurrency, set by isolation level) · **D**urability (survives crash, via WAL REDO).
> Durability trick: log record fsynced at commit *first*, data pages flushed lazily at checkpoint; recovery = REDO committed + UNDO uncommitted.
> Discipline: **short** transactions, no external I/O inside, batch bulk writes to amortize the commit fsync, always pair BEGIN with COMMIT/ROLLBACK. Autocommit = one statement per txn; open explicit `BEGIN` for multi-statement atomicity.

**References:** PostgreSQL docs — "Transactions" & "Reliability and the Write-Ahead Log"; MySQL Reference Manual — "InnoDB and the ACID Model"; Use The Index, Luke; SQLite — "Atomic Commit In SQLite"

---
*SQL Handbook — topic 25.*
