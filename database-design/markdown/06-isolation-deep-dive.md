# 06 · Isolation Deep Dive: Snapshot, Write Skew & SSI

> **In one line:** An isolation level is not a label on a table of anomalies — it is a concrete mechanism (a per-statement snapshot, a per-transaction snapshot, next-key locks, or SSI dependency tracking), and you only get correct behaviour when you know which mechanism is running, which anomalies it lets through, and what your application must do when it refuses to commit.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Isolation Levels & Concurrency Anomalies](../sql/topic.html?p=26-isolation-levels) (the four levels, the anomaly table, the on-call doctors example) · [SQL Handbook · Locking, MVCC & Deadlocks](../sql/topic.html?p=27-locking-mvcc) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (snapshots, xmin/xmax) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) (lost updates, CAS). This chapter assumes you know the anomaly table and goes into *how each level is implemented*, where the implementation leaks, and how to design around it.

Here is the problem this chapter exists to solve. A team reads the anomaly table, sees that REPEATABLE READ "prevents non-repeatable reads and phantoms", switches their booking service to it, and a week later two customers hold the same meeting room from 14:00 to 15:00. Nobody made a coding mistake in the usual sense: every transaction checked for a conflict, found none, and inserted its booking. The table was not wrong either. What was missing is the understanding that REPEATABLE READ in PostgreSQL is **snapshot isolation**, that snapshot isolation checks conflicts only between transactions that write the **same row**, and that two bookings are two *different* rows. The invariant "no overlapping bookings" lives in a *predicate*, not in a row, and snapshot isolation has no idea predicates exist.

The naive approach — "pick the level whose row in the table says the anomaly is prevented" — fails for three reasons. First, the SQL standard defines levels by three read phenomena, but real bugs come from **write skew**, **lost updates** and **read-only anomalies** that the standard does not name. Second, the same level name means different mechanisms on different engines: PostgreSQL's REPEATABLE READ is pure snapshot isolation that *aborts* on conflict, while InnoDB's REPEATABLE READ mixes a snapshot for plain `SELECT`s with *current reads plus gap locks* for writes, and the two produce different bugs. Third, the strongest level, SERIALIZABLE, is only correct if the application **retries** — PostgreSQL's SSI guarantees serializability by *refusing* transactions, and a refusal the application turns into a 500 is not a guarantee, it is an outage.

The core idea, which you should carry into every design review: **stronger isolation buys stronger guarantees by reducing concurrency** — either by blocking (locks), or by aborting (optimistic validation). There is no free level. Your job is to find the *weakest* mechanism that protects each invariant, and to place stronger mechanisms only where invariants actually need them.

> **Why this matters:** Isolation bugs do not show up in unit tests, rarely show up in staging, and in production they look like "data is occasionally wrong" — a double booking a week, a negative balance a month. They are the most expensive class of bug to find after the fact. Understanding the mechanisms is how you find them *before* they ship.

## 2. Core Concepts

- **Snapshot** — the set of transaction IDs a statement or transaction treats as "committed and visible". *Why it matters:* every MVCC isolation level is defined by *when* the snapshot is taken and *how long* it lives.
- **Per-statement snapshot (READ COMMITTED)** — a fresh snapshot for every SQL statement. *Why it matters:* two statements in one transaction can see different committed states; a report built from five queries can be internally inconsistent.
- **Per-transaction snapshot (REPEATABLE READ / SI)** — one snapshot taken at the first statement and held until commit. *Why it matters:* reads are stable, but writes may be based on data that is already out of date.
- **EvalPlanQual (EPQ)** — PostgreSQL's READ COMMITTED re-check: when `UPDATE`/`DELETE`/`SELECT FOR UPDATE` finds its target row was changed by a concurrent committed transaction, it re-evaluates the `WHERE` clause against the newest version. *Why it matters:* it makes `SET x = x + 1` safe, but it also produces surprising "row skipped" results.
- **First-updater-wins** — under snapshot isolation, if two transactions update the same row, the second to reach it waits, and if the first commits, the second fails with SQLSTATE `40001`. *Why it matters:* this is how SI prevents lost updates on a single row — and only on a single row.
- **Consistent read vs locking read (InnoDB)** — a plain `SELECT` reads the snapshot; `SELECT … FOR UPDATE/FOR SHARE`, `UPDATE` and `DELETE` read the **latest committed** version and lock it. *Why it matters:* one InnoDB transaction can see two different "truths".
- **Next-key lock / gap lock (InnoDB)** — a lock on an index record plus the gap before it, so no one can insert into the scanned range. *Why it matters:* this is how InnoDB blocks phantoms for locking reads — and a frequent source of deadlocks.
- **Write skew** — two transactions read an overlapping set, then write *disjoint* rows, jointly breaking an invariant. *Why it matters:* it is invisible to row-level conflict detection.
- **Phantom** — a row that did not exist when you evaluated a predicate but exists (committed by someone else) by the time you act on it. *Why it matters:* `FOR UPDATE` cannot lock a row that does not exist yet.
- **Predicate lock** — a lock on a *condition* ("all rows where room = 7 and time overlaps 14:00–15:00") rather than on rows. *Why it matters:* it is the theoretical fix for phantoms and write skew; SSI implements a cheap, non-blocking approximation.
- **SIREAD lock** — PostgreSQL's SSI marker recording "transaction T read this tuple/page/relation". It never blocks anything. *Why it matters:* it is how PostgreSQL detects read-write dependencies without making readers wait.
- **rw-antidependency** — T1 read a version that T2 later overwrote (T1 did not see T2's write). *Why it matters:* two consecutive such edges form the **dangerous structure** that SSI aborts.
- **Serialization failure (SQLSTATE 40001)** — the engine refused to commit because it could not prove a serial order. *Why it matters:* it is not a bug; it is the contract. The fix is always a whole-transaction retry.

## 3. Theory & Principles

### READ COMMITTED: a new snapshot per statement, and a re-check on write

Under READ COMMITTED, PostgreSQL takes a snapshot at the start of **each statement**. A `SELECT` sees everything committed before that statement began, and nothing committed during it. So far, simple. The interesting part is what happens to *writes*.

Suppose your `UPDATE accounts SET balance = balance - 100 WHERE id = 1 AND balance >= 100` finds row 1 in its snapshot, but a concurrent transaction T2 has already updated row 1 and not yet committed. Your statement **waits** on T2's transaction ID (row locks live in the tuple header — see [Ch 05 · Locking Internals](topic.html?p=05-locking-internals)). When T2 finishes, there are two cases:

1. **T2 rolled back** — you proceed with the original version.
2. **T2 committed** — PostgreSQL follows the update chain (the `ctid` pointer) to the **newest committed version**, and re-evaluates your `WHERE` clause on it. This is **EvalPlanQual**. If `balance >= 100` still holds on the new version, your update applies *to the new version* (so `balance - 100` is computed from T2's result — no lost update). If it no longer holds, the row is **skipped silently**. If T2 deleted the row, it is skipped.

This is why `UPDATE counters SET n = n + 1 WHERE id = 7` is safe at READ COMMITTED even with a thousand concurrent callers: every caller waits its turn and recomputes on the latest version. It is also why READ COMMITTED has a strange corner. The PostgreSQL documentation's own example: a table has rows with `hits = 9` and `hits = 10`. T1 runs `UPDATE website SET hits = hits + 1` (now 10 and 11, uncommitted). T2 runs `DELETE FROM website WHERE hits = 10`. T2's snapshot sees the row with 10, waits on T1, then re-checks it — it is now 11, so it is skipped. The row that is *now* 10 was 9 in T2's snapshot, so T2 never considered it. T2 deletes **nothing**, although before and after T1 there was exactly one row with `hits = 10`. The re-check only re-evaluates rows the statement already found; it never re-runs the search.

> **Interview tip:** "READ COMMITTED prevents lost updates for single-statement read-modify-write (`SET x = x + 1`) because of EvalPlanQual, but not for read-in-app, write-back (`SELECT x` … `UPDATE SET x = 42`)." That one sentence separates people who know the mechanism from people who memorised the table.

### REPEATABLE READ in PostgreSQL: pure snapshot isolation

At REPEATABLE READ, PostgreSQL takes one snapshot at the **first statement** of the transaction (not at `BEGIN` — an idle `BEGIN` does not freeze anything) and uses it for every statement until commit. Everything you read is a consistent picture of one instant. That kills non-repeatable reads and — unlike the SQL standard's minimum — phantoms too, because a range query re-run against the same snapshot returns the same rows.

Writes are where snapshot isolation (SI) shows its character. If your transaction tries to update or lock a row that was modified by a transaction that committed **after your snapshot was taken**, PostgreSQL cannot do the EvalPlanQual trick — re-reading the new version would break the "you see one instant" promise. So it gives up:

```text
ERROR:  could not serialize access due to concurrent update
SQLSTATE: 40001
```

This is **first-updater-wins**: the first transaction to write a row wins; any concurrent SI transaction that later tries to write the same row is aborted. That prevents lost updates *on the same row*. It does nothing for invariants that span rows, because two transactions writing different rows never collide. That gap is **write skew**, and it is the defining weakness of SI.

### InnoDB REPEATABLE READ: a snapshot for reads, the present for writes

InnoDB's default level uses the same name for a different machine. A **consistent read** (plain `SELECT`) reads from a read view established at the first consistent read in the transaction — a snapshot, reconstructed from undo logs. But a **locking read** — `SELECT … FOR UPDATE`, `SELECT … FOR SHARE`, `UPDATE`, `DELETE` — does not use the snapshot. It reads the **latest committed version**, locks it, and, for range conditions, takes **next-key locks** (record + preceding gap) on every index entry it scans so nobody can insert a phantom into the range.

The consequences are subtle and important:

- InnoDB **does not abort** on a concurrent update at RR. The second writer blocks, then applies its update to the latest committed version. `SET x = x + 1` is safe; `SET x = <value computed from my snapshot read>` is a **lost update**, silently.
- A transaction can see a row "appear" after its own write. If a concurrent transaction inserted rows matching `WHERE status = 'new'` and committed, your plain `SELECT` does not see them; but if you run `UPDATE … WHERE status = 'new'`, the update touches them (current read), and now your next plain `SELECT` *does* see them, because rows you modified are visible to you.
- Gap locks serialize inserts into scanned ranges. That prevents phantoms for locking reads, and it is also the reason an `UPDATE` with a non-indexed `WHERE` in InnoDB effectively locks the whole table's gaps and deadlocks with inserts.

> **MySQL difference:** InnoDB's RR is *not* snapshot isolation in the Berenson/Fekete sense; it is a hybrid that Kleppmann's Hermitage tests classify as permitting lost updates and write skew for read-then-write patterns. PostgreSQL RR aborts the second writer; InnoDB RR lets it proceed on newer data. Code that is "correct because RR aborts" on PostgreSQL is silently wrong on MySQL.

### Write skew: why row-level conflict detection is not enough

Write skew has a precise shape: T1 and T2 both **read** a set of rows `R` that overlaps, each checks an invariant over `R`, and each **writes** a row that the other read (or would have read) — but not the *same* row. Under SI, both see the pre-write snapshot, both conclude the invariant holds, and both commit. The canonical forms:

- **On-call doctors** (SQL Handbook's example): "at least one doctor on call" — each doctor updates their own row.
- **Double-booking**: "no overlapping bookings for a room" — each transaction *inserts* a new row. This is worse than the doctors case: the conflicting row does not exist at read time, so `SELECT … FOR UPDATE` has nothing to lock. This is a **phantom-driven write skew**.
- **Unique username across two tables**, **spending limit across many transactions**, **"max 3 active sessions per user"** — every "count/sum over a set, then insert/update" invariant.

### Phantoms and predicate locking

The theoretically clean fix is a **predicate lock**: when T1 evaluates `WHERE room_id = 7 AND during && '[14:00,15:00)'`, it locks *the predicate itself*, and any other transaction that tries to write a row satisfying that predicate must wait. True predicate locking is expensive (testing arbitrary predicates for overlap is costly), so engines approximate it:

- **InnoDB** approximates predicate locks with **index-range locks** (next-key locks). If an index covers the predicate, it locks the scanned range. If not, it scans (and locks) much more than needed.
- **PostgreSQL SSI** approximates them with **SIREAD locks** on the tuples, index pages and relations that the read touched — but crucially, SIREAD locks **do not block**. They are bookkeeping for conflict detection at commit time.

### SSI: serializability by detecting dangerous structures

Serializable Snapshot Isolation (Cahill, Röhm & Fekete, 2008; in PostgreSQL since 9.1) starts from SI — every transaction still reads a snapshot, and first-updater-wins still applies — and adds one piece of theory. Every non-serializable execution under SI contains a cycle in the dependency graph, and every such cycle contains a **pivot**: a transaction T_pivot with an incoming **rw-antidependency** (some T_in read something T_pivot later wrote, without seeing it) and an outgoing one (T_pivot read something T_out later wrote, without seeing it). Two consecutive rw edges, `T_in →rw T_pivot →rw T_out`, form the **dangerous structure**.

PostgreSQL tracks rw edges using SIREAD locks: when a transaction writes a tuple, it checks whether any concurrent transaction holds a SIREAD lock covering that tuple (or its page or relation); if so, it records an rw edge from the reader to the writer. When a dangerous structure appears — and the refined condition in PostgreSQL requires that **T_out committed first** — one transaction is aborted with `40001`. Detection is **conservative**: it aborts on the *structure*, not on a confirmed cycle, so some aborts are **false positives** (the execution was actually serializable). You pay a few spurious retries in exchange for never tracking the full graph.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c06a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c06a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Write skew under SI, and how SSI catches it</text>
  <rect x="20" y="38" width="840" height="170" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="36" y="58" fill="#334155" font-size="12" font-weight="bold">Timeline (both at REPEATABLE READ = SI): invariant "at least 1 doctor on call"</text>
  <line x1="80" y1="100" x2="840" y2="100" stroke="#94a3b8"/>
  <line x1="80" y1="170" x2="840" y2="170" stroke="#94a3b8"/>
  <text x="40" y="104" fill="#334155" font-weight="bold">T1</text>
  <text x="40" y="174" fill="#334155" font-weight="bold">T2</text>
  <rect x="100" y="84" width="170" height="32" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="185" y="98" text-anchor="middle" fill="#1e293b">SELECT count(*) on_call</text>
  <text x="185" y="110" text-anchor="middle" fill="#334155" font-size="9">sees 2 (Alice, Bob)</text>
  <rect x="150" y="154" width="170" height="32" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="235" y="168" text-anchor="middle" fill="#1e293b">SELECT count(*) on_call</text>
  <text x="235" y="180" text-anchor="middle" fill="#334155" font-size="9">sees 2 (Alice, Bob)</text>
  <rect x="340" y="84" width="170" height="32" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="425" y="98" text-anchor="middle" fill="#1e293b">UPDATE Alice off-call</text>
  <text x="425" y="110" text-anchor="middle" fill="#334155" font-size="9">row A</text>
  <rect x="400" y="154" width="170" height="32" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="485" y="168" text-anchor="middle" fill="#1e293b">UPDATE Bob off-call</text>
  <text x="485" y="180" text-anchor="middle" fill="#334155" font-size="9">row B (different row!)</text>
  <rect x="600" y="84" width="100" height="32" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="650" y="104" text-anchor="middle" fill="#14532d">COMMIT ok</text>
  <rect x="660" y="154" width="170" height="32" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="745" y="168" text-anchor="middle" fill="#7f1d1d">SI: COMMIT ok (0 doctors)</text>
  <text x="745" y="180" text-anchor="middle" fill="#7f1d1d" font-size="9">SSI: ERROR 40001</text>
  <text x="36" y="200" fill="#334155" font-size="10">No row was written by both, so first-updater-wins never fires. The conflict lives in the predicate "on_call = true".</text>
  <rect x="20" y="220" width="840" height="200" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="36" y="240" fill="#5b21b6" font-size="12" font-weight="bold">SSI bookkeeping: SIREAD locks record reads, writes create rw-antidependency edges</text>
  <circle cx="200" cy="320" r="38" fill="#fff" stroke="#7c3aed" stroke-width="2"/>
  <text x="200" y="316" text-anchor="middle" fill="#1e293b" font-weight="bold">T1</text>
  <text x="200" y="330" text-anchor="middle" fill="#334155" font-size="9">SIREAD on A, B</text>
  <circle cx="520" cy="320" r="38" fill="#fff" stroke="#7c3aed" stroke-width="2"/>
  <text x="520" y="316" text-anchor="middle" fill="#1e293b" font-weight="bold">T2</text>
  <text x="520" y="330" text-anchor="middle" fill="#334155" font-size="9">SIREAD on A, B</text>
  <path d="M236,305 Q360,262 484,305" fill="none" stroke="#dc2626" stroke-width="2" marker-end="url(#c06a1)"/>
  <text x="360" y="268" text-anchor="middle" fill="#7f1d1d" font-size="10">T1 read B, T2 wrote B: T1 rw&#8594; T2</text>
  <path d="M484,337 Q360,380 236,337" fill="none" stroke="#dc2626" stroke-width="2" marker-end="url(#c06a1)"/>
  <text x="360" y="388" text-anchor="middle" fill="#7f1d1d" font-size="10">T2 read A, T1 wrote A: T2 rw&#8594; T1</text>
  <rect x="600" y="262" width="244" height="130" rx="8" fill="#fff" stroke="#7c3aed"/>
  <text x="614" y="282" fill="#5b21b6" font-weight="bold">Dangerous structure</text>
  <text x="614" y="300" fill="#334155" font-size="10">T_in &#8594;rw T_pivot &#8594;rw T_out</text>
  <text x="614" y="318" fill="#334155" font-size="10">here: T2 &#8594; T1 &#8594; T2 (a 2-cycle)</text>
  <text x="614" y="336" fill="#334155" font-size="10">T1 committed first (T_out)</text>
  <text x="614" y="354" fill="#334155" font-size="10">&#8594; abort T2 at its COMMIT</text>
  <text x="614" y="372" fill="#334155" font-size="10">SIREAD locks never block;</text>
  <text x="614" y="386" fill="#334155" font-size="10">cost = tracking + retries</text>
  <text x="36" y="410" fill="#5b21b6" font-size="10">Conservative: aborts on the structure, not a proven cycle, so some 40001s are false positives. Retry is mandatory.</text>
</svg>
```

### Lost updates under each level

Lost updates are the anomaly most teams actually hit, and the behaviour depends on both the level and the *shape* of the write:

| Pattern | PG READ COMMITTED | PG REPEATABLE READ | PG SERIALIZABLE | InnoDB RC / RR | InnoDB SERIALIZABLE |
|---|---|---|---|---|---|
| `UPDATE SET x = x + 1` (atomic) | Safe (EPQ recompute) | Second writer 40001 | Second writer 40001 | Safe (current read, blocks) | Safe |
| `SELECT x` then `UPDATE SET x = :new` | **Lost update** | Second writer 40001 | Second writer 40001 | **Lost update** | Deadlock → one gets 1213 |
| `SELECT … FOR UPDATE` then `UPDATE` | Safe (blocks) | Second gets 40001 after wait | Second gets 40001 after wait | Safe (blocks) | Safe (blocks) |
| `UPDATE … WHERE version = :v` (CAS) | Safe (0 rows = retry) | Safe | Safe | Safe | Safe |

The pattern that bites is the second row — read into the application, compute, write an absolute value. At PostgreSQL READ COMMITTED and all InnoDB levels below SERIALIZABLE, it silently loses updates. Fix it with an atomic update, a `FOR UPDATE`, or a version-column CAS — see [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control).

### The read-only anomaly

A last theoretical point that surprises people: under SI, even a **read-only** transaction can observe a state that no serial order would produce (Fekete, O'Neil & O'Neil, 2004). Example: a batch-close transaction and a withdrawal interleave such that a report reads the batch as closed but misses the withdrawal that "logically" came before the close. SSI handles this by tracking read-only transactions too; PostgreSQL also offers `SERIALIZABLE READ ONLY DEFERRABLE`, which **waits** until it can take a snapshot that is guaranteed safe, then runs with no SIREAD overhead and no risk of abort — ideal for long reports and `pg_dump --serializable-deferrable`.

## 4. Architecture & Workflow

### What an UPDATE does when it hits a concurrently modified row

The heart of every level's behaviour is one decision point: a writing statement finds that the row version it wants to modify has been superseded or is locked. Here is the full decision tree for PostgreSQL, with InnoDB contrasted.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c06b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">PostgreSQL: UPDATE finds its target row modified by concurrent T2</text>
  <rect x="300" y="38" width="280" height="40" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="440" y="56" text-anchor="middle" fill="#1e293b" font-weight="bold">Row version in my snapshot has xmax = T2</text>
  <text x="440" y="70" text-anchor="middle" fill="#334155" font-size="10">(T2 updated/deleted/locked it)</text>
  <path d="M440,78 L440,102" stroke="#334155" stroke-width="1.5" marker-end="url(#c06b1)"/>
  <rect x="320" y="104" width="240" height="36" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="440" y="120" text-anchor="middle" fill="#1e293b" font-weight="bold">T2 still in progress?</text>
  <text x="440" y="133" text-anchor="middle" fill="#334155" font-size="10">yes: wait on T2's transactionid lock</text>
  <path d="M440,140 L440,164" stroke="#334155" stroke-width="1.5" marker-end="url(#c06b1)"/>
  <rect x="320" y="166" width="240" height="32" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="440" y="186" text-anchor="middle" fill="#1e293b" font-weight="bold">T2 finished: committed or aborted?</text>
  <path d="M320,182 L170,182 L170,222" stroke="#334155" stroke-width="1.5" marker-end="url(#c06b1)"/>
  <text x="240" y="176" text-anchor="middle" fill="#334155" font-size="10">aborted</text>
  <rect x="60" y="224" width="220" height="44" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="170" y="242" text-anchor="middle" fill="#14532d" font-weight="bold">Proceed on original version</text>
  <text x="170" y="258" text-anchor="middle" fill="#14532d" font-size="10">(all levels)</text>
  <path d="M560,182 L700,182 L700,222" stroke="#334155" stroke-width="1.5" marker-end="url(#c06b1)"/>
  <text x="630" y="176" text-anchor="middle" fill="#334155" font-size="10">committed</text>
  <rect x="590" y="224" width="220" height="36" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="700" y="246" text-anchor="middle" fill="#1e293b" font-weight="bold">Which isolation level?</text>
  <path d="M640,260 L500,318" stroke="#334155" stroke-width="1.5" marker-end="url(#c06b1)"/>
  <path d="M760,260 L760,318" stroke="#334155" stroke-width="1.5" marker-end="url(#c06b1)"/>
  <text x="540" y="290" fill="#334155" font-size="10">READ COMMITTED</text>
  <text x="770" y="296" fill="#334155" font-size="10">RR / SERIALIZABLE</text>
  <rect x="330" y="320" width="300" height="84" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="480" y="340" text-anchor="middle" fill="#1e293b" font-weight="bold">EvalPlanQual</text>
  <text x="344" y="358" fill="#334155" font-size="10">follow ctid chain to newest version</text>
  <text x="344" y="374" fill="#334155" font-size="10">re-check WHERE: match &#8594; update new version</text>
  <text x="344" y="390" fill="#334155" font-size="10">no match or deleted &#8594; skip row silently</text>
  <rect x="650" y="320" width="210" height="84" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="755" y="340" text-anchor="middle" fill="#7f1d1d" font-weight="bold">Abort: SQLSTATE 40001</text>
  <text x="664" y="358" fill="#7f1d1d" font-size="10">"could not serialize access</text>
  <text x="664" y="372" fill="#7f1d1d" font-size="10">due to concurrent update"</text>
  <text x="664" y="390" fill="#7f1d1d" font-size="10">app must retry whole txn</text>
  <rect x="20" y="414" width="840" height="46" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="36" y="432" fill="#334155" font-size="10" font-weight="bold">InnoDB contrast (RC and RR): after the wait, a current read applies the UPDATE to the latest committed version.</text>
  <text x="36" y="450" fill="#334155" font-size="10">No 40001 on concurrent update. Safe for SET x = x + 1; silently loses updates when the new value was computed from a snapshot read.</text>
</svg>
```

### Timeline: double-booking under each mechanism

```text
Invariant: no two bookings for room 7 overlap.
Both transactions run:  SELECT 1 FROM bookings WHERE room_id=7 AND during && '[14:00,15:00)';
                        -- 0 rows -> INSERT INTO bookings(room_id, during) VALUES (7, '[14:00,15:00)');

PG READ COMMITTED / REPEATABLE READ
  T1: SELECT -> 0 rows
  T2: SELECT -> 0 rows
  T1: INSERT, COMMIT          ok
  T2: INSERT, COMMIT          ok          <- DOUBLE BOOKING (two different new rows; nothing to conflict on)

PG READ COMMITTED + SELECT ... FOR UPDATE
  T1: SELECT ... FOR UPDATE -> 0 rows, locks nothing
  T2: SELECT ... FOR UPDATE -> 0 rows, locks nothing
  ... same result: DOUBLE BOOKING      <- you cannot lock a row that does not exist

PG SERIALIZABLE (SSI)
  T1: SELECT -> 0 rows   (SIREAD on index range / relation)
  T2: SELECT -> 0 rows   (SIREAD on the same range)
  T1: INSERT             (rw edge: T2 read what T1 writes)
  T2: INSERT             (rw edge: T1 read what T2 writes)
  T1: COMMIT             ok
  T2: COMMIT             ERROR 40001  -> retry sees T1's row -> refuses booking

InnoDB REPEATABLE READ + SELECT ... FOR UPDATE (index on room_id, start)
  T1: SELECT ... FOR UPDATE -> next-key/gap lock on the scanned range
  T2: SELECT ... FOR UPDATE -> gap locks are compatible with each other: also succeeds
  T1: INSERT -> waits for T2's gap lock (insert intention conflicts with gap lock)
  T2: INSERT -> waits for T1's gap lock  -> DEADLOCK, one victim gets error 1213 -> retry

Exclusion constraint (any level)
  T2's INSERT blocks on T1's uncommitted conflicting row, then fails with 23P01 once T1 commits.
```

Notice the pattern. Every correct outcome involves **someone being refused or made to wait**. That is the core trade-off of this chapter in miniature: correctness for a predicate invariant is purchased with concurrency.

### Choosing the isolation level: a workflow

Do not choose one level for "the application". Choose per **invariant**:

1. **Is the operation a single-row read-modify-write?** Express it as an atomic `UPDATE … SET x = x + :d WHERE … AND x + :d >= 0`. READ COMMITTED is enough.
2. **Is it a multi-statement read that must be internally consistent** (a report, an export, a balance sheet)? REPEATABLE READ (or `SERIALIZABLE READ ONLY DEFERRABLE` if the report must be serializable with writers).
3. **Does it check a predicate over several rows, then write** (count on-call, check overlap, sum a limit)? Either (a) turn the predicate into a **constraint** (unique index, exclusion constraint, `CHECK`), (b) **materialize the conflict** into one row everyone must lock (a `rooms` row, a `shifts` row, an `accounts` row), or (c) run those transactions at **SERIALIZABLE** with a retry loop.
4. **Is contention on that invariant high?** SSI with high contention produces retry storms; prefer pessimistic locking on a materialized row. **Is it low?** SSI is the least code and covers the invariants you forgot to think about.

## 5. Implementation

### Simple example: see EvalPlanQual and first-updater-wins with your own eyes

Start a lab: `docker run --rm -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17`, then open two `psql` sessions.

```sql
CREATE TABLE website (id int PRIMARY KEY, hits int);
INSERT INTO website VALUES (1, 9), (2, 10);
```

```text
-- Session A                                     -- Session B
BEGIN;                                           
UPDATE website SET hits = hits + 1;             
                                                 BEGIN;
                                                 DELETE FROM website WHERE hits = 10;
                                                 -- blocks (row 2 is locked by A)
COMMIT;
                                                 -- DELETE 0     <- surprise
                                                 COMMIT;
SELECT * FROM website;   -- (1,10) and (2,11): a row with hits=10 exists, yet B deleted nothing
```

Now repeat Session B at REPEATABLE READ:

```text
-- Session A                                     -- Session B
BEGIN;                                           BEGIN ISOLATION LEVEL REPEATABLE READ;
                                                 SELECT * FROM website;   -- snapshot taken here
UPDATE website SET hits = hits + 1 WHERE id=1;
COMMIT;
                                                 UPDATE website SET hits = 0 WHERE id = 1;
                                                 ERROR:  could not serialize access due to concurrent update
                                                 ROLLBACK;
```

### Simple example: write skew, then SSI catching it

```sql
CREATE TABLE on_call (doctor text PRIMARY KEY, shift_id int, on_call bool);
INSERT INTO on_call VALUES ('alice', 1, true), ('bob', 1, true);
```

```text
-- Session A (SERIALIZABLE)                      -- Session B (SERIALIZABLE)
BEGIN ISOLATION LEVEL SERIALIZABLE;              BEGIN ISOLATION LEVEL SERIALIZABLE;
SELECT count(*) FROM on_call
 WHERE shift_id=1 AND on_call;   -- 2
                                                 SELECT count(*) FROM on_call
                                                  WHERE shift_id=1 AND on_call;   -- 2
UPDATE on_call SET on_call=false
 WHERE doctor='alice';
                                                 UPDATE on_call SET on_call=false
                                                  WHERE doctor='bob';
COMMIT;   -- ok
                                                 COMMIT;
ERROR:  could not serialize access due to read/write dependencies among transactions
DETAIL:  Reason code: Canceled on identification as a pivot, during commit attempt.
HINT:  The transaction might succeed if retried.
```

While both are open, look at the bookkeeping:

```sql
SELECT locktype, relation::regclass, page, tuple, mode, pid
FROM pg_locks WHERE mode = 'SIReadLock';
```

```text
 locktype | relation | page | tuple |    mode    | pid
----------+----------+------+-------+------------+------
 relation | on_call  |      |       | SIReadLock | 4211
 relation | on_call  |      |       | SIReadLock | 4217
```

The lock is at **relation** granularity because the tiny table was sequentially scanned. With an index on `(shift_id)` and more rows, you would see `page` or `tuple` locks — and far fewer false-positive aborts. Indexing matters for SSI precision, not just speed.

> **MySQL difference:** at InnoDB REPEATABLE READ the doctors case commits both transactions (write skew). At InnoDB SERIALIZABLE (with autocommit off), each plain `SELECT` becomes `FOR SHARE`; both sessions hold shared locks on both rows, both `UPDATE`s need exclusive locks, and InnoDB's immediate deadlock detector kills one with error 1213 (SQLSTATE 40001). Same end result — one retry — reached by blocking rather than validation.

### Real-world example: a meeting-room booking service

You own the booking service for a company with 3,000 rooms and roughly 40 bookings per second at the 9 a.m. peak, heavily concentrated on popular rooms. The invariant is "no overlap per room". You have three production-grade options and one tempting wrong one.

**Option 1 — make the database enforce the predicate (best when expressible).** PostgreSQL can enforce "no two rows overlap" with an **exclusion constraint**, which is a real, index-backed predicate lock for exactly this predicate:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;       -- lets GiST handle "=" on integers
CREATE TABLE bookings (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_id  int       NOT NULL,
  during   tstzrange NOT NULL,
  booked_by bigint   NOT NULL,
  EXCLUDE USING gist (room_id WITH =, during WITH &&)
);
-- Concurrent overlapping INSERT waits for the first to finish, then:
-- ERROR:  conflicting key value violates exclusion constraint "bookings_room_id_during_excl"
-- SQLSTATE 23P01
```

This works at READ COMMITTED, has no retry storms, and cannot be bypassed by a code path someone forgets. Map `23P01` to HTTP 409 "slot taken". Uniqueness invariants work the same way with a unique (possibly partial) index — see [SQL Handbook · Keys & Constraints](../sql/topic.html?p=29-keys-constraints).

**Option 2 — materialize the conflict.** When the invariant is too complex for a constraint ("a room may have at most 2 overlapping *tentative* holds plus 1 confirmed booking"), make every transaction that touches room 7 lock the **room row** first:

```sql
BEGIN;  -- READ COMMITTED is fine
SELECT 1 FROM rooms WHERE id = 7 FOR UPDATE;       -- the materialized lock: serializes per room
SELECT count(*) FROM bookings
 WHERE room_id = 7 AND during && '[2026-09-24 14:00,2026-09-24 15:00)' AND status <> 'cancelled';
-- application checks the rule, then:
INSERT INTO bookings(room_id, during, booked_by, status) VALUES (7, '[2026-09-24 14:00,2026-09-24 15:00)', 42, 'held');
COMMIT;
```

The phantom problem vanishes because the `rooms` row always exists, so `FOR UPDATE` has something to lock. Concurrency is reduced to one booking transaction per room at a time — perfectly acceptable, since contention on one room is inherently serial.

**Option 3 — SERIALIZABLE for the booking transaction, with a retry loop.** You keep the natural code (check, then insert) and let SSI find conflicts, including ones you did not anticipate. The retry loop is non-negotiable. Here it is in Go with pgx:

```go
package booking

import (
	"context"
	"errors"
	"math/rand"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrSlotTaken = errors.New("slot taken")

// retryable reports whether the WHOLE transaction may be retried.
// 40001 = serialization_failure, 40P01 = deadlock_detected.
func retryable(err error) bool {
	var pg *pgconn.PgError
	return errors.As(err, &pg) && (pg.Code == "40001" || pg.Code == "40P01")
}

// WithSerializable runs fn in a SERIALIZABLE transaction, retrying the whole
// function on serialization failures. fn must have NO side effects outside the
// transaction (no emails, no HTTP calls) because it may run several times.
func WithSerializable(ctx context.Context, pool *pgxpool.Pool, fn func(pgx.Tx) error) error {
	const maxAttempts = 5
	backoff := 10 * time.Millisecond
	for attempt := 1; ; attempt++ {
		err := pgx.BeginTxFunc(ctx, pool, pgx.TxOptions{IsoLevel: pgx.Serializable}, fn)
		if err == nil || !retryable(err) || attempt == maxAttempts {
			return err // success, a business error, or out of attempts
		}
		// Full jitter: spread retries so colliding transactions do not collide again.
		sleep := time.Duration(rand.Int63n(int64(backoff)))
		select {
		case <-time.After(sleep):
		case <-ctx.Done():
			return ctx.Err()
		}
		backoff *= 2
	}
}

func Book(ctx context.Context, pool *pgxpool.Pool, room int, from, to time.Time, user int64) error {
	return WithSerializable(ctx, pool, func(tx pgx.Tx) error {
		var clash bool
		if err := tx.QueryRow(ctx, `
			SELECT EXISTS (SELECT 1 FROM bookings
			                WHERE room_id = $1 AND during && tstzrange($2, $3))`,
			room, from, to).Scan(&clash); err != nil {
			return err
		}
		if clash {
			return ErrSlotTaken // business outcome: not retried
		}
		_, err := tx.Exec(ctx, `INSERT INTO bookings(room_id, during, booked_by)
		                        VALUES ($1, tstzrange($2, $3), $4)`, room, from, to, user)
		return err // a 40001 may surface here OR at COMMIT; both are retried
	})
}
```

Three details make this production-grade. The retry wraps the **whole transaction**, because after a `40001` the snapshot is poisoned — retrying a single statement is meaningless. The retry has **jittered exponential backoff** and a **cap**, so a hot room does not turn into a CPU-burning retry storm. And the function body is **side-effect free** outside the database: the confirmation email goes into an outbox row inside the same transaction (see [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox)), never sent directly.

> **Production story:** A team moved their whole API to `default_transaction_isolation = 'serializable'` to "get correctness for free". Their ORM retried nothing. Within an hour the error rate went from 0.01% to 2% — every `40001` became a 500, mostly false positives from sequential scans on a small hot table holding relation-level SIREAD locks. The fix was not to abandon SSI but to (1) add the retry wrapper, (2) index the hot predicate so SIREAD locks stayed at tuple/page granularity, and (3) keep only the invariant-bearing endpoints at SERIALIZABLE.

### Diagnostics you will actually run

```sql
-- How many transactions roll back (includes 40001s, business rollbacks, errors)?
SELECT datname, xact_commit, xact_rollback,
       round(100.0 * xact_rollback / nullif(xact_commit + xact_rollback, 0), 2) AS rollback_pct
FROM pg_stat_database WHERE datname = current_database();

-- Who holds predicate locks, and at what granularity? (relation-level = more false positives)
SELECT pid, locktype, count(*) FROM pg_locks
WHERE mode = 'SIReadLock' GROUP BY pid, locktype ORDER BY count(*) DESC;

-- Long snapshots: the oldest open transactions, which hold back vacuum AND lengthen SSI tracking
SELECT pid, now() - xact_start AS xact_age, state, backend_xmin, left(query, 60)
FROM pg_stat_activity WHERE xact_start IS NOT NULL ORDER BY xact_start LIMIT 10;
```

```ini
# postgresql.conf knobs that shape SSI behaviour
max_pred_locks_per_transaction = 64    # default; raise if you see "out of shared memory" with SSI
max_pred_locks_per_relation    = -2    # default: promote to relation lock above 64/2 = 32 tuple/page locks
max_pred_locks_per_page        = 2     # default: promote tuple locks to a page lock above 2
log_min_error_statement        = error # so 40001s show up with their statement in the log
```

`pg_stat_database` has no dedicated serialization-failure counter, so count SQLSTATE `40001` in your **application metrics** (per endpoint) and in logs. That per-endpoint retry rate is the single most useful SSI health signal.

## 6. Advantages, Disadvantages & Trade-offs

| Mechanism | Guarantees | Cost | Failure mode you must handle |
|---|---|---|---|
| PG READ COMMITTED | No dirty reads; atomic single-statement RMW via EPQ | Cheapest; short snapshots | Lost updates for read-then-write; inconsistent multi-query reads; EPQ skips |
| PG REPEATABLE READ (SI) | Stable snapshot; no phantoms; no same-row lost update | Longer snapshots hold back vacuum | `40001` on concurrent update; **write skew** |
| PG SERIALIZABLE (SSI) | True serializability | SIREAD tracking memory/CPU; false-positive aborts | `40001` anywhere incl. COMMIT; retry storms under contention |
| InnoDB REPEATABLE READ | Snapshot reads; locking reads block phantoms via gap locks | Gap-lock contention and deadlocks | Lost updates for read-then-write; write skew; mixed-view surprises |
| InnoDB SERIALIZABLE | Serializable via shared locks | Readers block writers | Deadlocks (1213) and lock-wait timeouts (1205) |
| Constraint (unique / EXCLUDE) | Exactly the predicate you encode | An index | `23505` / `23P01` mapped to a business error |
| Materialized conflict row | Serializes one entity's transactions | Per-entity serialization | Hot-row contention; must be applied on every code path |

### When to use each

- **READ COMMITTED** as the default for OLTP; pair with atomic updates, CAS, and `FOR UPDATE` on existing rows.
- **REPEATABLE READ** for multi-statement consistent reads (reports, exports, reconciliation) and for single-row RMW where you would rather abort than wait.
- **SERIALIZABLE (SSI)** for complex, low-to-moderate contention invariants that are hard to express as constraints, and for teams that want a safety net for invariants nobody wrote down — *with* a shared retry wrapper.
- **Constraints** whenever the invariant is expressible: uniqueness, non-overlap, check conditions. They are the cheapest predicate locks you will ever get.

### When NOT to use each

- **Not SERIALIZABLE** on high-contention hot spots (a single counter row, a flash-sale SKU): abort-and-retry wastes whole transactions; use a materialized lock row or an atomic update instead.
- **Not SERIALIZABLE** on hot-standby replicas: PostgreSQL does not support it there (`cannot use serializable mode in a hot standby`); use REPEATABLE READ on replicas.
- **Not REPEATABLE READ** for long-running batch work on a busy primary: the pinned snapshot blocks vacuum cleanup (see [Ch 03 · MVCC](topic.html?p=03-mvcc)).
- **Not "raise the global default"** as a fix for a specific bug: it spreads the cost to every endpoint and still leaves you needing retries everywhere.

## 7. Common Mistakes & Best Practices

- **Believing REPEATABLE READ prevents all concurrency bugs.** People move to RR and stop thinking. It hurts because write skew and insert-based phantoms remain. Instead, list the multi-row invariants explicitly and protect each with a constraint, a materialized lock, or SERIALIZABLE.
- **Using `FOR UPDATE` to protect a check-for-absence.** "Lock the conflicting rows, then insert" locks nothing when there are no conflicting rows. Instead, lock a parent row that always exists, or use a unique/exclusion constraint.
- **Retrying the failed statement instead of the transaction.** After `40001`, the transaction is aborted; everything it read is suspect. Instead, retry from `BEGIN`, re-reading everything.
- **Side effects inside a retried transaction.** A retry loop that sends an email or calls a payment API in its body performs the side effect on every attempt. Instead, write intents to an outbox row inside the transaction.
- **Treating 40001 as an error to alert on per occurrence.** A healthy SSI system produces some serialization failures. Instead, alert on the *rate* and on *exhausted retries*.
- **Mixing isolation levels on the same invariant.** SSI only protects transactions that run at SERIALIZABLE; a READ COMMITTED transaction touching the same rows is invisible to its dependency tracking. Instead, run every writer of an SSI-protected invariant at SERIALIZABLE.
- **Porting "RR is safe" code from PostgreSQL to MySQL (or back).** PostgreSQL RR aborts the second writer; InnoDB RR lets it overwrite. Instead, write concurrency tests per engine (Kleppmann's Hermitage suite is the model).
- **Sequential scans in SERIALIZABLE transactions.** They take relation-level SIREAD locks and turn every concurrent write to that table into a potential conflict. Instead, index the predicates your serializable transactions read.
- **Best practice:** default to READ COMMITTED + explicit, targeted protection; encode invariants as constraints wherever possible; centralize retries in one wrapper that every transactional code path uses; test concurrency with two real sessions, not mocks.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**The flash-sale retry storm.** At 10:00 a promotion starts. The checkout transaction runs at SERIALIZABLE and reads `inventory` for one SKU. Symptom: p99 latency goes from 40 ms to 3 s, CPU at 95%, error rate climbing with "retries exhausted". Root cause: hundreds of transactions per second contend on one predicate; each commit aborts several others; each retry re-executes the full transaction; work multiplies. Fix: move the hot invariant to an atomic `UPDATE inventory SET qty = qty - 1 WHERE sku = $1 AND qty >= 1` at READ COMMITTED (EPQ serializes it cheaply), and keep SERIALIZABLE for the low-contention parts. See [Ch 31 · E-commerce](topic.html?p=31-case-ecommerce) and [Ch 33 · Ticket Booking](topic.html?p=33-case-ticket-booking).

**"Out of shared memory" under SSI.** At 2 a.m. a batch job runs a SERIALIZABLE transaction touching millions of rows. Symptom: `ERROR: out of shared memory` with `HINT: You might need to increase max_pred_locks_per_transaction`. Root cause: the predicate lock table is sized from `max_pred_locks_per_transaction × max_connections`; a huge serializable transaction exhausted it. Fix: run batch jobs at REPEATABLE READ or `READ ONLY DEFERRABLE` if they only read; raise the setting (requires restart) if genuinely needed.

**InnoDB gap-lock deadlock storm.** A MySQL service does `SELECT … FOR UPDATE` on a missing row then `INSERT` (the "upsert by hand" pattern) at RR. Symptom: `SHOW ENGINE INNODB STATUS` shows repeated deadlocks between `lock_mode X locks gap before rec` and `insert intention`. Root cause: two transactions both acquire compatible gap locks on the same gap, then both need insert-intention locks that conflict with the other's gap lock. Fix: use `INSERT … ON DUPLICATE KEY UPDATE`, or READ COMMITTED (which disables most gap locking) plus a unique key.

**The silent lost update.** An inventory service reads `qty` into the application, subtracts, and writes the absolute value — at PostgreSQL READ COMMITTED. Nothing errors. Symptom: nightly reconciliation shows stock drift of a few units per day. Root cause: concurrent read-modify-write. Fix: atomic update or version-column CAS; add a reconciliation alert so drift is detected within a day, not a quarter.

**The phantom-safe code that was not.** A service relies on InnoDB next-key locks to prevent duplicate sign-ups by `SELECT … FOR UPDATE WHERE email = ?`. A migration drops the index on `email`. Symptom: deadlocks and lock waits skyrocket. Root cause: without the index, the locking read scans and locks the entire clustered index. Fix: restore the index and, better, add a `UNIQUE` constraint so correctness does not depend on locking behaviour.

### What to monitor

- **Serialization failure rate per endpoint** (app metric on SQLSTATE `40001`), plus **retries per success** and **retries exhausted**. Healthy: a small fraction of a percent, rare exhaustion.
- **Deadlocks:** `pg_stat_database.deadlocks`; MySQL the `lock_deadlocks` counter in `information_schema.INNODB_METRICS`, or `innodb_print_all_deadlocks = ON` to log each one.
- **Lock waits:** `pg_stat_activity` rows with `wait_event_type = 'Lock'`; InnoDB `Innodb_row_lock_waits` and `Innodb_row_lock_time`.
- **Oldest transaction age** and `backend_xmin` age: long RR/SERIALIZABLE transactions hurt vacuum and SSI.
- **SIREAD lock count and granularity** (`pg_locks` where `mode = 'SIReadLock'`): a surge of relation-level locks predicts false-positive aborts.
- **Invariant checks:** a scheduled query that *counts violations* (overlapping bookings, negative balances, zero on-call shifts). It is the only monitor that catches the bugs isolation was supposed to prevent.

### Scaling notes

Isolation is a *single-node* guarantee in PostgreSQL and MySQL. Once you add read replicas, a transaction on a replica sees the replica's (possibly lagging) snapshot, and no isolation level spans primary and replica — that is a consistency-model problem, covered in [Ch 10 · Consistency Models](topic.html?p=10-consistency-models). Once you shard, a transaction spanning shards needs [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions), and serializability across shards requires a distributed SQL engine (CockroachDB defaults to SERIALIZABLE; Spanner provides external consistency). The design lesson scales: keep invariants **inside one shard, one row, or one constraint** whenever you can, and isolation stays cheap.

## 9. Interview Questions

**Q: Why is `UPDATE t SET n = n + 1` safe at PostgreSQL READ COMMITTED while "SELECT n, compute, UPDATE SET n = :v" is not?**
A: The single statement benefits from EvalPlanQual. If the row was changed by a concurrent transaction, the UPDATE waits for it, then re-reads the newest committed version, re-checks the WHERE clause, and computes `n + 1` from that newest value, so no increment is lost. In the two-step version, the application computed `:v` from a value read by an earlier statement's snapshot; the UPDATE then blindly writes that absolute value over whatever the other transaction committed. The database has no way to know `:v` was derived from stale data. Fix it with an atomic expression, `SELECT … FOR UPDATE`, or a version-column CAS.

**Q: What exactly does PostgreSQL REPEATABLE READ do when two transactions update the same row?**
A: Both run on their own transaction snapshots. The second to reach the row waits on the first's transaction ID. If the first rolls back, the second proceeds. If the first commits, the second cannot re-read the new version without breaking its snapshot guarantee, so it fails with `could not serialize access due to concurrent update`, SQLSTATE 40001. This is first-updater-wins. The application must retry the whole transaction, which then runs on a fresh snapshot including the first transaction's change.

**Q: What is write skew, and why can snapshot isolation not detect it?**
A: Write skew is when two transactions read an overlapping set of rows, each validates an invariant over that set, and each writes a different row, so both commit and together break the invariant. Snapshot isolation only detects write-write conflicts on the same row; it keeps no record of what a transaction read. Since the two writes touch different rows (or brand-new rows, in the double-booking case), there is nothing for SI to conflict on. Detecting it requires tracking reads — predicate locks, SSI's SIREAD locks — or materializing the conflict into a shared row.

**Q: Why does `SELECT … FOR UPDATE` fail to prevent double-booking, and what does?**
A: The check is "are there any overlapping bookings?", and when the answer is no, the query returns zero rows, so `FOR UPDATE` locks zero rows. Both transactions pass the check and insert. The fix is to lock something that always exists (the room row, a per-room-per-day slot row), to encode the predicate as an exclusion constraint (`EXCLUDE USING gist (room_id WITH =, during WITH &&)`), or to run the transaction at SERIALIZABLE so SSI detects the rw-dependencies. In MySQL, next-key locks on an index over the range do block the insert, but at the price of gap-lock deadlocks.

**Q: How does InnoDB REPEATABLE READ differ from PostgreSQL REPEATABLE READ?**
A: PostgreSQL RR is pure snapshot isolation: all reads use one snapshot, and a concurrent update to a row you then write aborts you with 40001. InnoDB RR uses the snapshot only for plain consistent reads; locking reads, UPDATE and DELETE read the latest committed version and take next-key locks. So InnoDB never aborts on a concurrent update — it blocks and then writes on newer data — which means a read-then-write computed from the snapshot silently loses updates. It also means a transaction can see rows appear after its own UPDATE touches them. Same name, different mechanism, different bugs.

**Q: What is a SIREAD lock and why does it not block anything?**
A: A SIREAD lock is PostgreSQL's record that a serializable transaction read a tuple, page, or relation. It exists purely for conflict detection: when another transaction writes something covered by a SIREAD lock, PostgreSQL records a read-write antidependency between them. It deliberately never blocks, because SSI is optimistic — readers and writers proceed concurrently, and the engine only intervenes at the point where a dangerous structure forms, by aborting one transaction. SIREAD locks can even outlive the transaction that took them, until all overlapping transactions finish.

**Q: Your service at SERIALIZABLE shows 3% of requests failing with 40001. How do you investigate? (Senior)**
A: First confirm there is a retry wrapper and that failures are *exhausted* retries rather than raw 40001s surfacing — often the real bug is missing retries. Then find which endpoints and tables are involved from logs with `log_min_error_statement`, and look at the DETAIL reason codes. Check `pg_locks` for SIReadLock granularity: relation-level locks from sequential scans cause many false positives, and indexing the read predicates often cuts aborts dramatically. Check for long serializable transactions that widen the conflict window, and for true hot spots where many transactions contend on one invariant — those should move to an atomic update or a materialized lock row. Finally, make sure read-only transactions are declared `READ ONLY` (or `DEFERRABLE` for long reports), since that lets SSI avoid many aborts.

**Q: Design the concurrency control for "a user may have at most 3 active API keys". (Senior)**
A: It is a count-then-insert invariant, so plain RC or RR will allow a fourth key under concurrency — classic write skew with a phantom. A constraint cannot directly express "count ≤ 3", so I would materialize the conflict: every create-key transaction first does `SELECT … FROM users WHERE id = $1 FOR UPDATE`, which serializes key creation per user while leaving other users fully concurrent. Then count and insert. An alternative is a `key_slot smallint CHECK (key_slot BETWEEN 1 AND 3)` column with `UNIQUE (user_id, key_slot)` for active keys, which turns the rule into a uniqueness constraint. SERIALIZABLE would also work, and contention per user is low, but it drags every writer of that table into SSI. I would add a periodic violation-count query as a monitor either way.

**Q: When is SERIALIZABLE the wrong answer even though it is "the most correct"? (Senior)**
A: When the invariant is hot. SSI and InnoDB's lock-based serializable both reduce concurrency on contended data — one by aborting, one by blocking — and under a flash sale or a single popular counter, abort-and-retry wastes entire transactions and can collapse throughput. It is also wrong when the invariant is expressible as a constraint, which is cheaper and cannot be bypassed; on hot-standby replicas, where PostgreSQL does not support it; and when the team cannot guarantee that every writer runs at SERIALIZABLE with retries, because SSI does not protect against transactions running at lower levels. I use it for complex, low-contention invariants behind a shared retry wrapper.

**Q: Explain the dangerous structure SSI looks for and why it produces false positives. (Senior)**
A: SSI tracks read-write antidependencies: T1 →rw T2 means T1 read something T2 later wrote without seeing it. Theory (Fekete et al.) shows every non-serializable SI execution contains a pivot transaction with both an incoming and an outgoing rw edge, with the outgoing target committing first. PostgreSQL aborts when it sees that two-edge structure rather than searching for a full cycle, because full cycle detection would require tracking all dependencies of all transactions indefinitely. Many such structures never close into a cycle, so some aborts are unnecessary. Coarse lock granularity — pages or whole relations after promotion — adds more false edges. The design accepts extra retries in exchange for cheap, bounded bookkeeping.

**Q: A report built from five queries at READ COMMITTED shows totals that do not add up. Why, and what do you change?**
A: Each statement at READ COMMITTED takes a new snapshot, so the five queries observed five different committed states; writes committed between them appear in some queries but not others. Move the report into a single REPEATABLE READ transaction so all five queries share one snapshot, or `SERIALIZABLE READ ONLY DEFERRABLE` if it must also be consistent with concurrent serializable writers. Keep it off the primary if it is long, because a long snapshot holds back vacuum; a replica at REPEATABLE READ is a good home, accepting its replication lag.

**Q: Does an isolation level protect you across a primary and its read replica?**
A: No. Isolation levels describe transactions on one node. A read on a replica sees whatever WAL the replica has replayed, so a transaction that wrote on the primary and then reads on a replica may not see its own write, whatever level either used. That is a consistency-model question — read-your-writes and monotonic reads — solved with routing, LSN tracking or synchronous replication, not with SET TRANSACTION.

## 10. Quick Revision & Cheat Sheet

| Level (engine) | Snapshot | Concurrent update of same row | Write skew | Phantom (insert) | App must handle |
|---|---|---|---|---|---|
| RC (PG) | per statement | wait, EPQ re-check, apply/skip | allowed | allowed | lost update on read-then-write |
| RR (PG) = SI | per transaction | wait, then 40001 | allowed | no phantom reads, but insert-based skew allowed | 40001 retry |
| SERIALIZABLE (PG) = SSI | per transaction + SIREAD | wait, then 40001 | aborted (40001) | aborted (40001) | 40001 retry, anywhere incl. COMMIT |
| RC (InnoDB) | per statement | wait, apply on latest | allowed | allowed | lost update on read-then-write |
| RR (InnoDB) | per txn for plain reads | wait, apply on latest | allowed | locking reads blocked by next-key locks | lost updates; gap deadlocks (1213) |
| SERIALIZABLE (InnoDB) | reads become FOR SHARE | block | prevented by locks | prevented | deadlocks (1213), timeouts (1205) |

- Stronger isolation = fewer anomalies = less concurrency (blocking or aborting). There is no free level.
- EvalPlanQual makes single-statement RMW safe at RC; it never re-runs the search, only re-checks found rows.
- PG RR is snapshot isolation: first-updater-wins with 40001; write skew still possible.
- InnoDB RR mixes snapshot reads with current-read writes; no 40001, silent lost updates for read-then-write.
- `FOR UPDATE` cannot lock absence — lock a parent row or use a constraint.
- Exclusion constraints and unique indexes are the cheapest correct predicate locks.
- SSI = SI + SIREAD locks + rw-antidependency tracking; aborts on the dangerous structure; false positives exist.
- Retry the whole transaction with jittered backoff and a cap; no external side effects inside.
- Every writer of an SSI-protected invariant must run at SERIALIZABLE.
- Isolation is per node; replicas and shards need consistency models and distributed transactions.

## 11. Hands-On Exercises

Lab: `docker run --rm --name iso -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17`, then `docker exec -it iso psql -U postgres` in two terminals.

1. **Reproduce the EvalPlanQual "delete nothing" case** from §5 exactly, then explain in one sentence why B deleted zero rows although a row with `hits = 10` existed afterwards.
2. **Write skew three ways.** Run the on-call doctors case at REPEATABLE READ (both commit), at SERIALIZABLE (one 40001), and at READ COMMITTED with `SELECT … FROM shifts WHERE id = 1 FOR UPDATE` on a new `shifts` table (the second waits and then sees count = 1). Compare throughput-relevant behaviour: abort versus wait.
3. **Exclusion constraint.** Build the `bookings` table from §5, open two sessions inserting overlapping ranges for the same room, and observe the second block and then fail with `23P01`. Then insert non-overlapping ranges concurrently and observe no blocking.
4. **SIREAD granularity.** Create `on_call` with 100,000 rows, run the doctors transactions with and without an index on `(shift_id)`, and compare `pg_locks` SIReadLock rows (relation vs page/tuple) and how often unrelated shifts abort each other.
5. **Retry wrapper under load.** Implement `WithSerializable` (Go or Python psycopg), run 50 concurrent bookers against 3 rooms with `pgbench`-style load, and plot attempts per success versus number of rooms. Observe how contention drives retries.
6. **MySQL contrast (optional).** With `docker run mysql:8.4`, reproduce a lost update at REPEATABLE READ using read-then-write, and a gap-lock deadlock with `SELECT … FOR UPDATE` on a missing key followed by `INSERT` in two sessions.

### Mini project — "Invariant Guard"

Build a small service with three invariants: (a) no overlapping room bookings, (b) at least one on-call doctor per shift, (c) at most 3 active API keys per user. Implement each with a different mechanism (exclusion constraint, SERIALIZABLE + retry, materialized parent-row lock). Write a concurrency test harness that fires 200 conflicting requests per invariant and asserts zero violations, and a nightly "violation count" SQL monitor for each. Report the p99 latency and retry counts of each mechanism under contention, and write one paragraph on which you would choose in production and why.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 03 · MVCC](topic.html?p=03-mvcc) (snapshots and visibility) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) (lost updates, CAS, retries) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (lock modes, queues, deadlocks) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) (the multi-node sequel to isolation) · [Ch 13 · Distributed Transactions](topic.html?p=13-distributed-transactions) · [Ch 32 · Banking Ledger](topic.html?p=32-case-banking) · [Ch 33 · Ticket Booking](topic.html?p=33-case-ticket-booking).

**SQL Handbook:** [Isolation Levels & Concurrency Anomalies](../sql/topic.html?p=26-isolation-levels) · [Locking, MVCC & Deadlocks](../sql/topic.html?p=27-locking-mvcc) · [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [Keys & Constraints](../sql/topic.html?p=29-keys-constraints).

**Other handbooks:** [System Design · CAP & Consistency](../system-design/topic.html?p=19-cap-consistency) · [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox) (side effects outside retried transactions).

- **PostgreSQL — Transaction Isolation** — PostgreSQL docs · *Intermediate* · the authoritative description of RC re-checks, RR serialization failures and SSI, including the `hits` example. <https://www.postgresql.org/docs/current/transaction-iso.html>
- **Serializable Snapshot Isolation in PostgreSQL** — Ports & Grittner (VLDB 2012) · *Advanced* · how SSI was actually built into PostgreSQL: SIREAD locks, read-only optimizations, memory bounds. <https://arxiv.org/abs/1208.4179>
- **SSI wiki page** — PostgreSQL wiki · *Advanced* · worked examples of write skew and read-only anomalies under SSI. <https://wiki.postgresql.org/wiki/SSI>
- **A Critique of ANSI SQL Isolation Levels** — Berenson et al. (1995) · *Advanced* · the paper that defined snapshot isolation and showed why the standard's phenomena are insufficient. <https://arxiv.org/abs/cs/0701157>
- **Hermitage: testing transaction isolation levels** — Martin Kleppmann · *Intermediate* · per-engine test cases showing exactly which anomalies each database's levels permit. <https://github.com/ept/hermitage>
- **InnoDB Transaction Isolation Levels** — MySQL Reference Manual · *Intermediate* · consistent vs locking reads and gap-lock behaviour at each level. <https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html>
- **InnoDB Locking** — MySQL Reference Manual · *Advanced* · record, gap, next-key and insert-intention locks in detail. <https://dev.mysql.com/doc/refman/8.0/en/innodb-locking.html>
- **Designing Data-Intensive Applications, ch. 7** — Martin Kleppmann · *Intermediate* · the clearest book-length treatment of weak isolation, write skew and SSI. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 06.*
