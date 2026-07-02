# 26 · Isolation Levels & Concurrency Anomalies

> **In one line:** Isolation levels are the dial that trades concurrency for correctness — each level names exactly which read/write anomalies two overlapping transactions are still allowed to see.

---

## 1. Overview

The **I** in ACID promises that concurrent transactions don't corrupt each other. But *perfect* isolation — running every transaction as if it were alone — is expensive, so SQL exposes a **dial** with four settings. Turn it up and you buy correctness at the cost of concurrency and blocking; turn it down and you gain throughput while permitting specific **anomalies**.

An anomaly is a wrong result that can only occur *because* another transaction ran concurrently. The SQL-92 standard defines levels by which of three anomalies they forbid — **dirty read**, **non-repeatable read**, **phantom read** — but real engines exhibit more (**lost update**, **write skew**) and often provide *stronger* guarantees than the standard's minimum. So you must reason about your *specific engine*, not just the level's name.

You choose a level per transaction. The craft is picking the **lowest level that is still correct** for the business operation: a dashboard count tolerates READ COMMITTED; a "reserve the last seat" or "keep two on-call doctors" invariant needs SERIALIZABLE (or explicit locking).

This page defines each anomaly with a two-transaction **timeline**, maps the four SQL levels to what they prevent, contrasts **PostgreSQL** and **MySQL/InnoDB** defaults and semantics, and distinguishes **snapshot** isolation from true **serializability**. The mechanics of *how* levels are enforced — MVCC and locks — live in *Locking, MVCC & Deadlocks*.

## 2. Core Concepts

- **Isolation level** — the contract stating which anomalies concurrent transactions may still observe. Set with `SET TRANSACTION ISOLATION LEVEL …`.
- **Dirty read** — reading another transaction's **uncommitted** change (which may later roll back).
- **Non-repeatable read** — re-reading the *same row* returns a different value because another transaction committed an `UPDATE`/`DELETE` in between.
- **Phantom read** — re-running the *same range query* returns new rows because another transaction committed an `INSERT` matching the predicate.
- **Lost update** — two read-modify-write cycles overlap; one transaction's write silently overwrites the other's.
- **Write skew** — two transactions each read an overlapping set, then each writes a *disjoint* row; both commit, but together they violate an invariant neither saw broken. The signature snapshot-isolation anomaly.
- **READ UNCOMMITTED / READ COMMITTED / REPEATABLE READ / SERIALIZABLE** — the four standard levels, weakest to strongest.
- **Snapshot isolation** — each transaction reads from a consistent point-in-time snapshot; prevents dirty/non-repeatable/phantom reads but *not* write skew.
- **Serializable** — the result is equivalent to *some* serial (one-at-a-time) execution; the only level that forbids all anomalies including write skew.
- **Serialization failure** — under SERIALIZABLE, a transaction that would break serializability is aborted with a retryable error; the app must retry.

## 3. Syntax & Examples

Set the level for the next transaction (standard syntax, both engines):

```sql
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
BEGIN;
  -- ... work ...
COMMIT;

-- PostgreSQL: attach it to BEGIN directly
BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE;
  SELECT count(*) FROM on_call WHERE unit = 'ICU' AND active;
  -- decide, then write
COMMIT;   -- may raise 40001 serialization_failure → retry the whole txn
```

Inspect / set the session default:

```sql
-- PostgreSQL
SHOW default_transaction_isolation;                 -- 'read committed'
SET default_transaction_isolation = 'repeatable read';

-- MySQL
SELECT @@transaction_isolation;                     -- 'REPEATABLE-READ'
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
```

Application retry loop for SERIALIZABLE (mandatory pattern):

```sql
-- pseudocode around the SQL
-- for attempt in 1..N:
--   BEGIN ISOLATION LEVEL SERIALIZABLE;
--     ... reads + writes ...
--   COMMIT;                          -- on SQLSTATE 40001, roll back and retry
```

## 4. Sample Data & Results

Two on-call doctors must always remain in the ICU. Table `on_call`:

| id | name  | unit | active |
|----|-------|------|--------|
| 1  | Alice | ICU  | true   |
| 2  | Bob   | ICU  | true   |

Both Alice and Bob simultaneously try to go off-call. Each transaction runs:

```sql
BEGIN;                                             -- SNAPSHOT / REPEATABLE READ
  SELECT count(*) FROM on_call WHERE unit='ICU' AND active;   -- both see 2, OK to leave
  UPDATE on_call SET active=false WHERE id = :me;             -- Alice→1, Bob→2
COMMIT;
```

Under **snapshot isolation** (PostgreSQL REPEATABLE READ, MySQL default) both read `count = 2`, both update *different* rows, and **both commit** — this is **write skew**:

| id | name  | active | 
|----|-------|--------|
| 1  | Alice | false  |
| 2  | Bob   | false  |

Result: **zero** ICU doctors — the invariant is violated though each transaction saw a valid snapshot. Under **SERIALIZABLE**, PostgreSQL detects the read/write dependency cycle and aborts one transaction with `40001`; on retry it sees `count = 1` and refuses to leave. Correct outcome — exactly one doctor goes off-call:

| id | name  | active |
|----|-------|--------|
| 1  | Alice | false  |
| 2  | Bob   | true   |

## 5. Under the Hood

Each anomaly is easiest to see as a **timeline** of two interleaved transactions. The level is defined by which of these interleavings the engine forbids.

**Dirty read** — T2 reads a value T1 has written but not committed; T1 then rolls back, so T2 acted on data that never existed. Forbidden at READ COMMITTED and above.

```svg
<svg viewBox="0 0 720 190" width="100%" height="190" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="360" y="20" text-anchor="middle" fill="#1e293b" font-weight="700">Dirty read (allowed only at READ UNCOMMITTED)</text>
  <line x1="60" y1="70" x2="680" y2="70" stroke="#475569"/>
  <line x1="60" y1="150" x2="680" y2="150" stroke="#475569"/>
  <text x="30" y="74" fill="#64748b">T1</text>
  <text x="30" y="154" fill="#64748b">T2</text>
  <rect x="90" y="52" width="150" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="165" y="74" text-anchor="middle" fill="#1e293b">UPDATE bal=0 (uncommitted)</text>
  <rect x="300" y="132" width="150" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="375" y="154" text-anchor="middle" fill="#1e293b">reads bal=0 (dirty)</text>
  <rect x="510" y="52" width="150" height="34" rx="8" fill="#fdecea" stroke="#b91c1c"/>
  <text x="585" y="74" text-anchor="middle" fill="#b91c1c">ROLLBACK</text>
  <text x="585" y="154" text-anchor="middle" fill="#b91c1c">acted on ghost value</text>
</svg>
```

**Non-repeatable read** — T1 reads a row twice; T2 commits an `UPDATE` in between, so T1's two reads disagree. Forbidden at REPEATABLE READ and above.

```svg
<svg viewBox="0 0 720 190" width="100%" height="190" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="360" y="20" text-anchor="middle" fill="#1e293b" font-weight="700">Non-repeatable read (allowed up to READ COMMITTED)</text>
  <line x1="60" y1="70" x2="680" y2="70" stroke="#475569"/>
  <line x1="60" y1="150" x2="680" y2="150" stroke="#475569"/>
  <text x="30" y="74" fill="#64748b">T1</text>
  <text x="30" y="154" fill="#64748b">T2</text>
  <rect x="80" y="52" width="130" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="145" y="74" text-anchor="middle" fill="#1e293b">read price=100</text>
  <rect x="290" y="132" width="170" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="375" y="154" text-anchor="middle" fill="#1e293b">UPDATE price=120; COMMIT</text>
  <rect x="520" y="52" width="150" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="595" y="74" text-anchor="middle" fill="#b91c1c">read price=120 (differs!)</text>
</svg>
```

**Phantom read** — T1 runs a range query twice; T2 commits an `INSERT` of a new matching row in between, so a "phantom" appears. Forbidden at SERIALIZABLE (and, in practice, at InnoDB/PostgreSQL REPEATABLE READ too — see §6).

```svg
<svg viewBox="0 0 720 190" width="100%" height="190" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="360" y="20" text-anchor="middle" fill="#1e293b" font-weight="700">Phantom read (new rows appear in a re-run range query)</text>
  <line x1="60" y1="70" x2="680" y2="70" stroke="#475569"/>
  <line x1="60" y1="150" x2="680" y2="150" stroke="#475569"/>
  <text x="30" y="74" fill="#64748b">T1</text>
  <text x="30" y="154" fill="#64748b">T2</text>
  <rect x="80" y="52" width="180" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="170" y="74" text-anchor="middle" fill="#1e293b">count WHERE amt>1000 → 3</text>
  <rect x="300" y="132" width="180" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="390" y="154" text-anchor="middle" fill="#1e293b">INSERT amt=5000; COMMIT</text>
  <rect x="510" y="52" width="180" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="600" y="74" text-anchor="middle" fill="#b91c1c">count → 4 (phantom)</text>
</svg>
```

**Lost update** — two read-modify-write cycles interleave; T2's write lands on top of T1's and T1's increment vanishes. Prevented by REPEATABLE READ (first-updater-wins abort) or explicit `FOR UPDATE`.

```svg
<svg viewBox="0 0 720 210" width="100%" height="210" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <text x="360" y="20" text-anchor="middle" fill="#1e293b" font-weight="700">Lost update (concurrent read-modify-write)</text>
  <line x1="60" y1="70" x2="680" y2="70" stroke="#475569"/>
  <line x1="60" y1="160" x2="680" y2="160" stroke="#475569"/>
  <text x="30" y="74" fill="#64748b">T1</text>
  <text x="30" y="164" fill="#64748b">T2</text>
  <rect x="80" y="52" width="120" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="140" y="74" text-anchor="middle" fill="#1e293b">read qty=10</text>
  <rect x="230" y="142" width="120" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="290" y="164" text-anchor="middle" fill="#1e293b">read qty=10</text>
  <rect x="380" y="52" width="150" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="455" y="74" text-anchor="middle" fill="#1e293b">write qty=11; COMMIT</text>
  <rect x="530" y="142" width="150" height="34" rx="8" fill="#fdecea" stroke="#b91c1c"/>
  <text x="605" y="164" text-anchor="middle" fill="#b91c1c">write qty=11 (T1 lost!)</text>
</svg>
```

**Write skew** — the §4 doctors case: disjoint writes, shared read, invariant broken. Only SERIALIZABLE catches it. Under the hood, PostgreSQL's Serializable Snapshot Isolation (SSI) tracks read/write dependencies between concurrent transactions and aborts one when it detects a **dangerous cycle**.

## 6. Variations & Trade-offs

What each SQL-92 level *is required* to prevent (✓ = forbidden, ✗ = may occur):

| Level | Dirty read | Non-repeatable read | Phantom | Lost update | Write skew |
|-------|:---------:|:------------------:|:-------:|:-----------:|:----------:|
| READ UNCOMMITTED | ✗ | ✗ | ✗ | ✗ | ✗ |
| READ COMMITTED | ✓ | ✗ | ✗ | ✗ | ✗ |
| REPEATABLE READ | ✓ | ✓ | ✗* | ✓** | ✗ |
| SERIALIZABLE | ✓ | ✓ | ✓ | ✓ | ✓ |

\* *Standard allows phantoms at RR, but real engines are stronger (see below).*
\** *Standard silent on lost update; snapshot-based RR prevents it via first-updater-wins.*

**Engine reality — the names lie about the behavior:**

| | PostgreSQL | MySQL / InnoDB |
|--|-----------|----------------|
| Default level | **READ COMMITTED** | **REPEATABLE READ** |
| READ UNCOMMITTED | Behaves as READ COMMITTED (no dirty reads ever) | Truly allows dirty reads |
| REPEATABLE READ | Snapshot isolation; **no phantoms**; write skew possible | Snapshot + **gap/next-key locks** block phantoms |
| SERIALIZABLE | True serializability via **SSI** (may abort with 40001) | Promotes reads to locking (`LOCK IN SHARE MODE`); more blocking |
| Lost update at RR | Aborts 2nd writer (`40001`) | Blocks 2nd writer until 1st commits, then applies on new version |

**Snapshot vs. serializable:** REPEATABLE READ on both engines is really **snapshot isolation** — every statement sees a frozen point-in-time view, which kills dirty, non-repeatable, and (on these engines) phantom reads. But snapshot isolation still permits **write skew** because two transactions read overlapping data yet write disjoint rows, and neither sees the other's write. Only **SERIALIZABLE** guarantees an outcome equal to some serial order, closing write skew — PostgreSQL by detecting dependency cycles and aborting, MySQL by escalating to locks.

## 7. Performance Notes

- **Higher level ⇒ more blocking or more aborts.** READ COMMITTED rarely blocks readers (MVCC); SERIALIZABLE under InnoDB adds shared locks (contention), and under PostgreSQL SSI adds retryable aborts (wasted work). Match the level to the invariant, not the whole app.
- **SERIALIZABLE requires a retry loop.** Any `40001`/deadlock must roll back and retry with backoff. Without it, you'll surface transient errors to users.
- **REPEATABLE READ pins a snapshot for the whole transaction** — the oldest such snapshot holds back `VACUUM`/purge and grows undo. Keep RR transactions short.
- **READ COMMITTED takes a *new* snapshot per statement**, so it's cheaper on version retention but means a multi-statement report can see mixed points in time.
- **Explicit locking is often cheaper than raising the level.** For a single hot invariant, `SELECT … FOR UPDATE` at READ COMMITTED beats SERIALIZABLE for the whole transaction (pay the cost only where needed).
- **Don't use READ UNCOMMITTED for "speed."** On PostgreSQL it's a no-op; on MySQL the dirty reads it permits are almost never worth the correctness loss, and it doesn't reduce locking meaningfully.

## 8. Common Mistakes

1. ⚠️ **Assuming the level name means the same on every engine** — PostgreSQL RR forbids phantoms; SQL-92 RR allows them. *Fix:* read your engine's docs; test the actual interleaving.
2. ⚠️ **Read-modify-write in application code without protection** (`SELECT` balance, compute in app, `UPDATE`) → **lost update**. *Fix:* use `FOR UPDATE`, an atomic `UPDATE … SET x = x + 1`, or SERIALIZABLE with retry.
3. ⚠️ **Using SERIALIZABLE with no retry loop** — the first `40001` becomes a user-facing 500. *Fix:* wrap the transaction in a retry-with-backoff.
4. ⚠️ **Believing REPEATABLE READ prevents write skew** — it doesn't; the doctors/seat invariant still breaks. *Fix:* SERIALIZABLE, or materialize the conflict (lock a summary row).
5. ⚠️ **Long-running REPEATABLE READ report transactions** pinning old snapshots and bloating the database. *Fix:* keep them short, or use a replica/AS OF snapshot.
6. ⚠️ **Mixing statements at READ COMMITTED and expecting a stable view** — each statement re-snapshots, so a report's parts disagree. *Fix:* use REPEATABLE READ for multi-query consistency.
7. ⚠️ **Setting the level *after* the first statement of the transaction** — it's too late; the level (and snapshot) is fixed at the start. *Fix:* set it on/before `BEGIN`.

## 9. Interview Questions

**Q: Name the four standard isolation levels from weakest to strongest.**
A: READ UNCOMMITTED, READ COMMITTED, REPEATABLE READ, SERIALIZABLE.

**Q: What is a dirty read and which level permits it?**
A: Reading another transaction's uncommitted change, which may later roll back — so you act on data that never durably existed. Only READ UNCOMMITTED permits it (and PostgreSQL never actually does, treating it as READ COMMITTED).

**Q: Distinguish a non-repeatable read from a phantom read.**
A: A non-repeatable read is the *same row* returning a different value on re-read because another txn committed an `UPDATE`/`DELETE`. A phantom is a *range query* returning new rows on re-run because another txn committed an `INSERT` matching the predicate. RR fixes the former; SERIALIZABLE (or gap locks) fixes the latter.

**Q: What is a lost update and how do you prevent it?**
A: Two transactions each read a value, modify it in app code, and write back; the second overwrites the first, so one update is lost. Prevent with `SELECT … FOR UPDATE`, an atomic in-place `UPDATE x = x + 1`, snapshot RR (first-updater-wins abort), or SERIALIZABLE.

**Q: What is write skew and why doesn't snapshot isolation prevent it?**
A: Two transactions read an overlapping set, verify an invariant, then each writes a *different* row; both commit and jointly break the invariant (e.g. both on-call doctors leave). Snapshot isolation gives each a consistent read view but doesn't detect that their writes together violate a constraint neither observed. Only SERIALIZABLE catches it.

**Q: What are the default isolation levels of PostgreSQL and MySQL/InnoDB?**
A: PostgreSQL defaults to READ COMMITTED; MySQL/InnoDB defaults to REPEATABLE READ.

**Q: Does PostgreSQL's REPEATABLE READ allow phantom reads?**
A: No. Although SQL-92 permits phantoms at RR, PostgreSQL implements RR as snapshot isolation, so a re-run range query sees the same rows — phantoms are prevented. Write skew, however, is still possible; that needs SERIALIZABLE.

**Q: How does MySQL/InnoDB prevent phantoms at REPEATABLE READ?**
A: With **gap locks / next-key locks** — locking not just matching rows but the gaps between index entries in the scanned range, so no concurrent transaction can insert a phantom into that range.

**Q: (Senior) How does PostgreSQL SERIALIZABLE differ mechanically from MySQL SERIALIZABLE?**
A: PostgreSQL uses **Serializable Snapshot Isolation (SSI)** — optimistic: transactions run on snapshots while the engine tracks read/write dependencies and aborts one (`40001`) if it detects a dangerous cycle. MySQL implements SERIALIZABLE pessimistically by turning plain `SELECT`s into `LOCK IN SHARE MODE`, so it blocks rather than aborts. Postgres favors throughput with retries; MySQL favors blocking.

**Q: (Senior) You need a strong guarantee for one invariant but don't want to slow the whole app. What do you do?**
A: Keep the app at READ COMMITTED and protect only the hot invariant — e.g. `SELECT … FOR UPDATE` on the relevant rows (or a summary/lock row) so competing transactions serialize *there* only. This localizes the cost instead of paying SERIALIZABLE-wide aborts/blocking.

**Q: (Senior) Why does a long-running REPEATABLE READ transaction hurt a busy database even if it only reads?**
A: RR pins one snapshot for its whole life. `VACUUM`/purge cannot reclaim row versions newer than the oldest live snapshot, so dead tuples/undo accumulate (bloat), scans slow down, and transaction-ID wraparound pressure rises. A read-only report can therefore degrade write performance across the system.

**Q: (Senior) At READ COMMITTED, an `UPDATE … WHERE status='open'` runs while another txn changes matching rows. What does PostgreSQL do?**
A: PostgreSQL re-evaluates: when the `UPDATE` hits a row locked by a concurrent txn, it waits; once that txn commits, Postgres **re-checks the WHERE against the new committed version** (EvalPlanQual). If the row no longer matches `status='open'`, it's skipped — so the update operates on current committed data, not the original snapshot, which can surprise you.

## 10. Practice

- [ ] Reproduce a non-repeatable read: at READ COMMITTED, read a row in T1, `UPDATE`+`COMMIT` it in T2, re-read in T1, and observe the change; then repeat at REPEATABLE READ and confirm stability.
- [ ] Trigger write skew with the two-doctors example under REPEATABLE READ, then switch both transactions to SERIALIZABLE and observe the `40001` abort.
- [ ] Demonstrate a lost update by doing read-in-app / write-back concurrently, then fix it with `FOR UPDATE`.
- [ ] On MySQL, insert into a range gap that another RR transaction has scanned and observe the next-key lock blocking you.
- [ ] Compare `SHOW default_transaction_isolation` on Postgres vs `SELECT @@transaction_isolation` on MySQL and note the different defaults.

## 11. Cheat Sheet

> [!TIP]
> **Isolation levels —** pick the *lowest* level that's still correct.
> Anomalies, weakest to worst: **dirty read** (uncommitted data) → **non-repeatable read** (row changed) → **phantom** (new rows in range) → **lost update** (RMW overwrite) → **write skew** (disjoint writes break shared invariant).
> Prevention: READ COMMITTED kills dirty; REPEATABLE READ (=snapshot) kills non-repeatable + (on PG/InnoDB) phantom + lost update; only **SERIALIZABLE** kills write skew.
> Defaults: **PostgreSQL = READ COMMITTED**, **MySQL/InnoDB = REPEATABLE READ**. PG SERIALIZABLE = optimistic SSI (retry `40001`); MySQL = pessimistic locking. Snapshot ≠ serializable — snapshot still allows write skew. Localize cost with `FOR UPDATE` instead of raising the whole app.

**References:** PostgreSQL docs — "Transaction Isolation" & "Serializable Snapshot Isolation"; MySQL Reference Manual — "InnoDB Transaction Isolation Levels"; Berenson et al. "A Critique of ANSI SQL Isolation Levels"; Use The Index, Luke

---
*SQL Handbook — topic 26.*
