# 03 · MVCC: Row Versions, Snapshots & Vacuum

> **In one line:** MVCC lets readers and writers stop blocking each other by keeping several versions of every row and giving each transaction a snapshot that picks the right one — and the entire operational cost of that trick (dead tuples, vacuum, bloat, the xmin horizon, XID wraparound) is the bill you pay for never making a reader wait.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Locking, MVCC & Deadlocks](../sql/topic.html?p=27-locking-mvcc) (the version-chain idea and VACUUM basics) · [SQL Handbook · Isolation Levels](../sql/topic.html?p=26-isolation-levels) (what each level promises) · [Ch 02 · Storage Internals](topic.html?p=02-storage-internals) (tuple headers and pages). The SQL Handbook showed *that* readers see old versions; this chapter shows *exactly how* PostgreSQL decides, what the old versions cost, and how production databases get hurt by them.

Imagine the database without MVCC. A reporting query that reads a million rows needs those rows not to change mid-read, so it takes shared locks; every writer touching one of those rows now waits for the report to finish. Conversely, a writer holding an exclusive lock on a hot row makes every reader of that row wait for its commit. On a busy OLTP system this is a disaster: throughput is bounded by the longest reader, and a single slow report can freeze checkout. This was how many early engines (and still how some configurations) worked — **two-phase locking** with read locks.

The MVCC idea is simple: *never overwrite a row in place*. A write creates a new **version**; the old version stays until nobody could possibly need it. Each transaction (or each statement, at READ COMMITTED) gets a **snapshot** — a precise description of which transactions' effects it may see — and every row fetch picks the version visible to that snapshot. Readers never take row locks, so they never block writers and never wait for them. Only writers of the *same* row still conflict ([Ch 05](topic.html?p=05-locking-internals)).

The naive expectation is that this is free. It is not. Old versions occupy space in the table and its indexes until something removes them; removing them safely requires knowing that *no* running snapshot can still see them; and the 32-bit transaction counter that makes visibility checks cheap eventually wraps around. So MVCC turns concurrency problems into **garbage-collection problems**, and most PostgreSQL production incidents that are not about locks or bad plans are about this garbage collector — **VACUUM** — being unable to keep up or being blocked.

> **Why this matters:** "Our table is 40 GB but has 2 GB of live rows", "the database went read-only and demanded a vacuum", "queries got slower every day until we restarted a forgotten psql session" — each of these is an MVCC incident. You need the model to prevent them.

## 2. Core Concepts

- **Row version (tuple)** — one physical copy of a row as of some transaction. *Why it matters:* an UPDATE creates a whole new tuple, so update-heavy tables accumulate versions.
- **xmin** — the ID of the transaction that created this version (inserted it or wrote it as the result of an UPDATE). *Why it matters:* the version is invisible to anyone whose snapshot does not consider xmin committed.
- **xmax** — the ID of the transaction that deleted/superseded this version, or locked it (0 if none). *Why it matters:* once xmax is committed and visible, the version is dead to that snapshot.
- **Transaction ID (XID)** — a 32-bit counter assigned lazily on a transaction's first write. Read-only transactions only get a *virtual* XID. *Why it matters:* XIDs are a finite, wrapping resource.
- **Commit log (`pg_xact`, CLOG)** — two bits per XID recording in-progress / committed / aborted / sub-committed. *Why it matters:* visibility is decided by looking up xmin/xmax here; abort is just flipping bits, so rollback is instant.
- **Hint bits** — flags in `t_infomask` caching "xmin committed" etc. so later readers skip the CLOG lookup. *Why it matters:* the first read after a bulk write *dirties* pages to set them — reads can cause writes.
- **Snapshot** — `(xmin, xmax, xip[])`: all XIDs below `xmin` are finished, all at or above `xmax` had not started, and `xip` lists those in progress. *Why it matters:* it is the entire definition of "what this transaction can see".
- **Dead tuple** — a version no current or future snapshot can see. *Why it matters:* it occupies space and slows scans until VACUUM removes it.
- **xmin horizon** — the oldest XID any running snapshot (or replication slot, or prepared transaction, or standby with feedback) might still need. *Why it matters:* VACUUM can only remove versions deleted before the horizon; one old snapshot freezes cleanup database-wide.
- **VACUUM** — removes dead tuples, frees line pointers, updates the free space and visibility maps, and freezes old tuples. *Why it matters:* it is the garbage collector; without it, tables bloat and XIDs wrap.
- **Autovacuum** — the background launcher/workers that run VACUUM and ANALYZE when thresholds are crossed. *Why it matters:* default thresholds are proportional to table size and too lazy for large hot tables.
- **Freezing** — marking an old tuple's xmin as "committed, visible to everyone forever" so its XID no longer matters. *Why it matters:* the only defence against XID wraparound.
- **XID wraparound** — XIDs compare modulo 2³², so a tuple ~2 billion transactions old would appear to be "in the future". *Why it matters:* PostgreSQL will stop assigning XIDs (refuse writes) before letting that happen.
- **Undo log (InnoDB)** — where InnoDB keeps old versions instead of in the table. *Why it matters:* same garbage problem, different place: long transactions grow the undo history instead of table bloat.

## 3. Theory & Principles

### How a write creates versions

At the page level (see the `pageinspect` walk-through in [Ch 02](topic.html?p=02-storage-internals)):

- **INSERT** by XID 100 writes a tuple with `xmin = 100, xmax = 0`.
- **DELETE** by XID 120 does not remove anything; it sets the tuple's `xmax = 120`.
- **UPDATE** by XID 130 = delete + insert: it sets `xmax = 130` on the current version and writes a new tuple with `xmin = 130, xmax = 0`, linking the old tuple's `t_ctid` to the new one.
- **ROLLBACK** of XID 130 does nothing to the pages at all. It marks 130 as aborted in `pg_xact`; from then on every reader treats 130's tuple as never having existed and 130's xmax on the old tuple as void. PostgreSQL has **no undo log**, which is why rollback is instantaneous regardless of transaction size.

### The visibility rule

A snapshot is taken as three numbers plus a list. You can see yours:

```sql
SELECT pg_current_snapshot();          -- PG 13+ ; older: txid_current_snapshot()
--  pg_current_snapshot
-- ----------------------
--  1002:1006:1002,1004                 xmin : xmax : in-progress list
```

This says: every XID < 1002 has finished; every XID ≥ 1006 had not started when the snapshot was taken; among 1002–1005, transactions 1002 and 1004 were still running (the snapshot's xmin is always the oldest one still running). From this, a transaction ID `X` "happened before my snapshot" iff `X < xmax` **and** `X` not in `xip` **and** `pg_xact` says `X` committed.

A tuple version is **visible** to a snapshot when (simplified, ignoring the transaction's own writes, which use command IDs):

1. its `xmin` committed *before the snapshot* (per the rule above) — otherwise the creating transaction is invisible, so the version is too; **and**
2. its `xmax` is either empty, aborted, or *not* committed-before-the-snapshot — otherwise the deletion/update is visible, so this version is gone.

Walk through it with a row that went through three versions:

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c03a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Three versions of account 42; three snapshots see three different rows</text>

  <rect x="30" y="44" width="240" height="96" rx="8" fill="#f1f5f9" stroke="#94a3b8" stroke-width="2"/>
  <text x="150" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">v1  balance = 500</text>
  <text x="150" y="84" text-anchor="middle" fill="#334155">xmin = 900 (committed)</text>
  <text x="150" y="102" text-anchor="middle" fill="#334155">xmax = 1001 (committed)</text>
  <text x="150" y="122" text-anchor="middle" fill="#334155" font-size="9">ctid (7,3) → t_ctid (7,5)</text>

  <rect x="320" y="44" width="240" height="96" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#15803d" font-weight="bold">v2  balance = 400</text>
  <text x="440" y="84" text-anchor="middle" fill="#166534">xmin = 1001 (committed)</text>
  <text x="440" y="102" text-anchor="middle" fill="#166534">xmax = 1004 (IN PROGRESS)</text>
  <text x="440" y="122" text-anchor="middle" fill="#166534" font-size="9">ctid (7,5) → t_ctid (7,6)</text>

  <rect x="610" y="44" width="240" height="96" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="730" y="64" text-anchor="middle" fill="#92400e" font-weight="bold">v3  balance = 250</text>
  <text x="730" y="84" text-anchor="middle" fill="#92400e">xmin = 1004 (IN PROGRESS)</text>
  <text x="730" y="102" text-anchor="middle" fill="#92400e">xmax = 0</text>
  <text x="730" y="122" text-anchor="middle" fill="#92400e" font-size="9">ctid (7,6) — HOT, same page</text>
  <path d="M272,92 L316,92" stroke="#334155" stroke-width="1.5" marker-end="url(#c03a)"/>
  <path d="M562,92 L606,92" stroke="#334155" stroke-width="1.5" marker-end="url(#c03a)"/>

  <rect x="30" y="166" width="820" height="84" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="46" y="188" fill="#1e293b" font-weight="bold">Snapshot A = 1000:1000:—   (taken before 1001 started, e.g. a long report)</text>
  <text x="46" y="208" fill="#334155" font-size="10">v1: xmin 900 &lt; 1000, committed ✓ · xmax 1001 ≥ snapshot xmax 1000 → "in the future" → deletion not visible ✓  ⇒ VISIBLE</text>
  <text x="46" y="226" fill="#334155" font-size="10">v2: xmin 1001 ≥ 1000 → not yet started for A ✗  ⇒ invisible</text>
  <text x="46" y="242" fill="#15803d" font-size="10" font-weight="bold">A reads balance = 500</text>

  <rect x="30" y="260" width="820" height="84" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="46" y="282" fill="#1e293b" font-weight="bold">Snapshot B = 1004:1006:1004   (taken after 1001 committed, while 1004 runs)</text>
  <text x="46" y="302" fill="#334155" font-size="10">v1: xmax 1001 committed before B ✗ ⇒ dead to B · v2: xmin 1001 ✓ · xmax 1004 is in xip → still running ✓ ⇒ VISIBLE</text>
  <text x="46" y="320" fill="#334155" font-size="10">v3: xmin 1004 in xip → uncommitted ✗ ⇒ invisible (no dirty reads, ever)</text>
  <text x="46" y="336" fill="#15803d" font-size="10" font-weight="bold">B reads balance = 400 — without waiting for 1004's row lock</text>

  <rect x="30" y="354" width="820" height="70" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="46" y="376" fill="#1e293b" font-weight="bold">Snapshot C = 1007:1007:—   (after 1004 commits)</text>
  <text x="46" y="396" fill="#334155" font-size="10">v1 dead · v2 dead (xmax 1004 committed) · v3 xmin 1004 committed ✓ xmax 0 ✓ ⇒ VISIBLE</text>
  <text x="46" y="414" fill="#15803d" font-size="10" font-weight="bold">C reads balance = 250</text>

  <text x="440" y="452" text-anchor="middle" fill="#b91c1c" font-size="11" font-weight="bold">v1 can be vacuumed only after snapshot A ends; v2 only after B ends. The OLDEST live snapshot sets the cleanup horizon.</text>
</svg>
```

Three properties fall straight out of this rule:

- **No dirty reads, ever.** An in-progress xmin is invisible to everyone else. That is why READ UNCOMMITTED in PostgreSQL behaves as READ COMMITTED.
- **Readers never wait.** Snapshot B saw v2 even though 1004 held a row lock on it; the reader did not care.
- **The snapshot's lifetime defines what must be kept.** Snapshot A pins v1. At REPEATABLE READ/SERIALIZABLE a transaction keeps one snapshot for its whole life; at READ COMMITTED it takes a fresh one per statement, which is why RC holds back cleanup less (the [SQL Handbook](../sql/topic.html?p=26-isolation-levels) covers the anomaly consequences; [Ch 06](topic.html?p=06-isolation-deep-dive) goes deeper into snapshot isolation and SSI).

### Hint bits, and why a SELECT can write

Checking `pg_xact` for every tuple would be slow, so the first transaction to see a tuple after its xmin (or xmax) is known committed or aborted sets a **hint bit** in `t_infomask`. That modifies the page, marking it dirty — so the first `SELECT` over a freshly bulk-loaded table writes the whole table back out, and with data checksums or `wal_log_hints` enabled, the first hint-bit change after a checkpoint also logs a full-page image. This surprises people who see write I/O on a read replica or after a large import. A `VACUUM` right after a bulk load sets hint bits (and the visibility map) once, in the background.

### Where the garbage goes: pruning and VACUUM

Dead versions are reclaimed at two levels:

- **Page pruning (opportunistic).** When any backend reads a page that is nearly full and contains dead HOT-chain tuples, it prunes them in place — compacting the page and leaving *redirect* line pointers so index entries still work. Cheap, local, no index work, but it only handles HOT chains on pages being visited.
- **VACUUM.** Scans the heap (skipping pages marked all-visible in the visibility map), collects the TIDs of dead tuples older than the horizon, removes their entries from *every* index, then marks the heap line pointers unused, updates the free space map, sets visibility-map bits, freezes old tuples, and truncates empty pages at the end of the file. Space is reusable by future inserts to the same table but is *not* returned to the OS (except trailing pages). Only `VACUUM FULL` or `pg_repack` rewrite the table smaller — `VACUUM FULL` under an ACCESS EXCLUSIVE lock.

### The xmin horizon: one old snapshot stops all cleanup

VACUUM may remove a dead version only if its deleting transaction committed before **every** snapshot that could still read it. PostgreSQL computes this as the horizon: the minimum over

- every backend's `backend_xmin` (open snapshots, including `idle in transaction` sessions and long-running queries),
- every replication slot's `xmin` and `catalog_xmin`,
- every prepared (two-phase) transaction,
- every hot standby with `hot_standby_feedback = on` (its queries' xmins are reported upstream).

The horizon is effectively **database-cluster wide**: a forgotten `BEGIN` in a psql session on table A prevents VACUUM from cleaning table B. VACUUM still runs, reads everything, and reports the dead tuples as "not yet removable" — burning I/O while the bloat grows.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c03b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The xmin horizon: why a 3-hour-old transaction bloats every table</text>

  <line x1="60" y1="70" x2="840" y2="70" stroke="#334155" stroke-width="2"/>
  <text x="60" y="58" fill="#334155" font-size="10">09:00</text><text x="250" y="58" fill="#334155" font-size="10">10:00</text><text x="450" y="58" fill="#334155" font-size="10">11:00</text><text x="800" y="58" fill="#334155" font-size="10">12:00</text>
  <text x="840" y="86" text-anchor="end" fill="#334155" font-size="9">time / XIDs →</text>

  <rect x="60" y="96" width="780" height="28" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="70" y="114" fill="#b91c1c" font-size="10" font-weight="bold">psql session: BEGIN; SELECT ... ; (then idle in transaction for 3 h) — backend_xmin = XID 5,000,000</text>

  <rect x="120" y="140" width="40" height="22" rx="3" fill="#dbeafe" stroke="#2563eb"/>
  <rect x="220" y="140" width="40" height="22" rx="3" fill="#dbeafe" stroke="#2563eb"/>
  <rect x="330" y="140" width="40" height="22" rx="3" fill="#dbeafe" stroke="#2563eb"/>
  <rect x="440" y="140" width="40" height="22" rx="3" fill="#dbeafe" stroke="#2563eb"/>
  <rect x="560" y="140" width="40" height="22" rx="3" fill="#dbeafe" stroke="#2563eb"/>
  <rect x="680" y="140" width="40" height="22" rx="3" fill="#dbeafe" stroke="#2563eb"/>
  <text x="740" y="156" fill="#1e40af" font-size="10">thousands of short OLTP txns per second,</text>
  <text x="740" y="170" fill="#1e40af" font-size="10">each updating rows</text>

  <rect x="60" y="190" width="780" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="70" y="208" fill="#92400e" font-size="10" font-weight="bold">Dead versions created after 09:00 on EVERY table:  cannot be removed (someone might still need them)</text>
  <text x="70" y="223" fill="#92400e" font-size="10">autovacuum runs, scans, reports "N dead row versions cannot be removed yet" — work done, nothing freed</text>

  <path d="M420,316 L520,308 L620,294 L720,272 L830,246" stroke="#dc2626" stroke-width="2.5" fill="none"/>
  <text x="70" y="262" fill="#b91c1c" font-size="10" font-weight="bold">table + index size keep growing →</text>
  <text x="70" y="280" fill="#b91c1c" font-size="10">scans read more pages; cache holds fewer live rows</text>
  <text x="70" y="296" fill="#b91c1c" font-size="10">index scans wade through dead entries</text>

  <path d="M830,98 L830,130" stroke="#dc2626" stroke-width="2" marker-end="url(#c03b)"/>
  <rect x="560" y="330" width="290" height="40" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="570" y="348" fill="#15803d" font-size="10" font-weight="bold">12:00 session killed → horizon jumps forward</text>
  <text x="570" y="363" fill="#166534" font-size="10">next vacuum frees space (but files stay large)</text>

  <rect x="60" y="330" width="480" height="40" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="70" y="348" fill="#334155" font-size="10">Other horizon holders: replication slot xmin / catalog_xmin,</text>
  <text x="70" y="363" fill="#334155" font-size="10">prepared transactions, standby queries with hot_standby_feedback = on</text>
</svg>
```

### XID wraparound and freezing

XIDs are 32 bits and compared with modular arithmetic: from any XID's point of view, roughly 2 billion XIDs are "in the past" and 2 billion "in the future". A tuple whose xmin is older than ~2³¹ transactions would suddenly look like it was created in the future — the row would vanish. To prevent that, VACUUM **freezes** tuples old enough that every snapshot sees them: it sets a frozen flag in the infomask, after which the xmin value is ignored and the tuple is visible to everyone forever.

The relevant ages, per table (`age(pg_class.relfrozenxid)`) and per database (`age(pg_database.datfrozenxid)`):

| Setting | Default | Meaning |
|---|---|---|
| `vacuum_freeze_min_age` | 50M | freeze tuples at least this old when VACUUM passes their page |
| `vacuum_freeze_table_age` | 150M | beyond this, VACUUM scans all non-frozen pages (aggressive) |
| `autovacuum_freeze_max_age` | 200M | beyond this, autovacuum *forces* an anti-wraparound vacuum, even if autovacuum is off |
| `vacuum_failsafe_age` (PG 14+) | 1.6B | emergency: skip index cleanup and cost delays to finish freezing fast |

If none of that succeeds — typically because something is holding the xmin horizon so nothing can be frozen, or autovacuum keeps getting cancelled — PostgreSQL starts emitting warnings as the remaining XID budget shrinks and, close to the ~2³¹ limit, **refuses to assign new XIDs**: every write fails with an error saying the database is not accepting commands that assign XIDs to avoid wraparound data loss. Reads still work; the fix is to remove whatever holds the horizon and run VACUUM on the oldest tables. This is an outage measured in hours on a multi-TB database, which is why XID age is a top-tier alert.

Multixact IDs (used when several transactions share-lock the same row, [Ch 05](topic.html?p=05-locking-internals)) have their own counter and their own wraparound, governed by `autovacuum_multixact_freeze_max_age` (400M).

## 4. Architecture & Workflow

### Autovacuum's decision loop

The launcher wakes every `autovacuum_naptime` (1 min) per database and starts workers (up to `autovacuum_max_workers`, default 3) for tables that cross a threshold:

```text
vacuum   if n_dead_tup      > autovacuum_vacuum_threshold (50)        + autovacuum_vacuum_scale_factor (0.2)        × reltuples
vacuum   if n_ins_since_vac > autovacuum_vacuum_insert_threshold (1000) + autovacuum_vacuum_insert_scale_factor (0.2) × reltuples   (PG 13+)
analyze  if n_mod_since_an  > autovacuum_analyze_threshold (50)       + autovacuum_analyze_scale_factor (0.1)       × reltuples
freeze   if age(relfrozenxid) > autovacuum_freeze_max_age (200M)       -- regardless of the above
```

The scale factor is the trap. For a 1-billion-row table, 0.2 × 1B = **200 million dead tuples** before autovacuum even starts — by which point the table is badly bloated and the vacuum itself takes hours. Workers are also throttled by cost-based delay (`autovacuum_vacuum_cost_limit`, which inherits `vacuum_cost_limit` = 200, shared across workers, and `autovacuum_vacuum_cost_delay` = 2 ms), which on modern SSDs is often far too gentle. And a worker vacuuming a table is cancelled if someone requests a conflicting lock (e.g. DDL), except for anti-wraparound vacuums, which do not yield.

### The lifecycle of one row under a steady update load

```text
t0   INSERT (xid 100)                          v1 live
t1   UPDATE (xid 200, commits)                 v1 dead-but-maybe-visible, v2 live
t2   (all snapshots older than 200 end)        v1 now DEAD → removable
t3   next page visit with little free space    HOT prune: v1's space reclaimed in page
     OR autovacuum reaches the table           v1 removed from heap + all indexes
t4   UPDATE (xid 300) fits on page (fillfactor) new version reuses the freed space
...  200M XIDs later                           VACUUM freezes the surviving version
```

On a healthy system the gap between t1 and t3 is seconds to minutes and table size is stable. Every production MVCC problem is some step in this chain getting stuck: t2 (a long snapshot), t3 (autovacuum too slow or cancelled), t4 (no free space on the page → new page → table grows), or freezing (horizon blocked).

> **MySQL difference:** InnoDB updates rows **in place** in the clustered index and writes the *previous* column values to an **undo log** record; each row carries hidden `DB_TRX_ID` and `DB_ROLL_PTR` columns, and a reader whose **read view** cannot see the current version follows the roll pointer back through undo records to reconstruct the version it may see. Old versions therefore never bloat the table; they live in undo tablespaces and are removed by **purge threads** once no read view needs them. The same xmin-horizon problem appears as a growing **history list length** (`SHOW ENGINE INNODB STATUS`, or `trx_rseg_history_len` in `information_schema.INNODB_METRICS`): a long transaction makes undo grow and makes every reader of hot rows walk longer version chains. Rollback in InnoDB is expensive (it must apply undo), whereas in PostgreSQL it is free. Secondary indexes in InnoDB carry no version info, so they are delete-marked and purged, and a secondary-index read may need to check the clustered record to decide visibility.

## 5. Implementation

### Simple example: watch versions and snapshots in two sessions

```sql
-- setup
CREATE TABLE acct (id int PRIMARY KEY, balance int);
INSERT INTO acct VALUES (42, 500);

-- Session A
BEGIN ISOLATION LEVEL REPEATABLE READ;
SELECT pg_current_snapshot(), xmin, xmax, ctid, balance FROM acct WHERE id = 42;
--  pg_current_snapshot | xmin | xmax | ctid  | balance
--  1003:1003:          | 1002 |    0 | (0,1) |     500

-- Session B
BEGIN;
UPDATE acct SET balance = 400 WHERE id = 42;
SELECT pg_current_xact_id(), xmin, xmax, ctid, balance FROM acct WHERE id = 42;
--  pg_current_xact_id | xmin | xmax | ctid  | balance
--               1003  | 1003 |    0 | (0,2) |     400      ← B sees its own new version
COMMIT;

-- Session A again (same snapshot)
SELECT xmin, xmax, ctid, balance FROM acct WHERE id = 42;
--  xmin | xmax | ctid  | balance
--  1002 | 1003 | (0,1) |     500      ← old version; xmax = 1003 is "in the future" for A
COMMIT;

-- New statement, new snapshot
SELECT xmin, xmax, ctid, balance FROM acct WHERE id = 42;
--  1003 |    0 | (0,2) |     400
```

Now see the garbage, and see it pinned:

```sql
CREATE EXTENSION IF NOT EXISTS pgstattuple;

-- Session A: open a snapshot and leave it
BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1;

-- Session B: churn
DO $$ BEGIN FOR i IN 1..10000 LOOP UPDATE acct SET balance = balance + 1 WHERE id = 42; END LOOP; END $$;
VACUUM (VERBOSE) acct;
```

```text
INFO:  vacuuming "postgres.public.acct"
INFO:  finished vacuuming "postgres.public.acct": index scans: 0
pages: 0 removed, 55 remain, 55 scanned (100.00% of total)
tuples: 0 removed, 10001 remain, 10000 are dead but not yet removable
removable cutoff: 1003, which was 10002 XIDs old when operation ended
```

`removable cutoff: 1003` is the xmin horizon, pinned by session A. Commit session A, vacuum again, and "10000 removed" appears — but the table stays 55 pages on disk, now mostly free space for reuse.

### Diagnostic queries you will use in real incidents

```sql
-- 1. Who is holding the horizon? (sessions)
SELECT pid, usename, application_name, state,
       age(backend_xmin)          AS xmin_age_xids,
       now() - xact_start         AS xact_age,
       left(query, 60)            AS last_query
FROM pg_stat_activity
WHERE backend_xmin IS NOT NULL
ORDER BY age(backend_xmin) DESC
LIMIT 5;

-- 2. ...replication slots (logical slots also hold catalog_xmin)
SELECT slot_name, slot_type, active, age(xmin) AS xmin_age, age(catalog_xmin) AS catalog_xmin_age
FROM pg_replication_slots;

-- 3. ...prepared transactions (forgotten 2PC)
SELECT gid, prepared, owner, age(transaction) AS xid_age FROM pg_prepared_xacts;

-- 4. Which tables need vacuum, and is autovacuum reaching them?
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / nullif(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_autovacuum, autovacuum_count
FROM pg_stat_user_tables
ORDER BY n_dead_tup DESC LIMIT 10;

-- 5. Wraparound exposure
SELECT datname, age(datfrozenxid) AS xid_age, mxid_age(datminmxid) AS mxid_age
FROM pg_database ORDER BY 2 DESC;
SELECT c.oid::regclass AS table, age(c.relfrozenxid) AS xid_age,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c WHERE c.relkind IN ('r','m','t')
ORDER BY age(c.relfrozenxid) DESC LIMIT 10;

-- 6. What is autovacuum doing right now?
SELECT p.pid, p.relid::regclass, p.phase, p.heap_blks_scanned, p.heap_blks_total, p.index_vacuum_count
FROM pg_stat_progress_vacuum p;
```

### Real-world example: tuning autovacuum for a hot 500M-row table

An `orders` table (500M rows, ~5,000 updates/s) had `n_dead_tup` swinging between 20M and 100M, with autovacuum runs taking 6 hours and table size growing 3% a week. Per-table settings brought vacuum in small, frequent bites:

```sql
ALTER TABLE orders SET (
  autovacuum_vacuum_scale_factor     = 0.0,      -- ignore table size…
  autovacuum_vacuum_threshold        = 2000000,  -- …vacuum every ~2M dead tuples
  autovacuum_vacuum_insert_scale_factor = 0.0,
  autovacuum_vacuum_insert_threshold = 5000000,
  autovacuum_analyze_scale_factor    = 0.01,
  autovacuum_vacuum_cost_limit       = 2000,     -- let this table's worker do more I/O per cycle
  fillfactor                         = 90        -- room for HOT updates (affects new pages / after rewrite)
);
```

```ini
# postgresql.conf — cluster-wide
autovacuum_max_workers = 6
autovacuum_vacuum_cost_limit = 2000      # shared budget across workers; default is effectively 200
autovacuum_naptime = 15s
maintenance_work_mem = 2GB               # dead-TID memory for index passes (PG 17 stores TIDs far more compactly)
idle_in_transaction_session_timeout = '5min'
transaction_timeout = '30min'            # PG 17+: caps total transaction time for app roles
log_autovacuum_min_duration = '10s'
```

And the operational guards that actually prevented the next incident:

```sql
ALTER ROLE app       SET idle_in_transaction_session_timeout = '60s';
ALTER ROLE reporting SET statement_timeout = '15min';
-- long analytical queries go to a replica WITHOUT hot_standby_feedback, accepting query cancellations,
-- or to a logical copy, so they cannot pin the primary's horizon
```

Result: vacuum runs every 5–10 minutes taking a few minutes each, `n_dead_tup` stays under 3M, HOT ratio rose from 40% to 85%, and table growth stopped. The existing bloat still had to be removed once with `pg_repack` (online rewrite) because VACUUM does not shrink files.

> **MySQL difference:** the equivalent tuning is purge, not vacuum: `innodb_purge_threads`, `innodb_max_purge_lag` (throttles DML when history grows), undo tablespace truncation (`innodb_undo_log_truncate`, `innodb_max_undo_log_size`), and above all killing long transactions — `information_schema.INNODB_TRX` ordered by `trx_started` shows them.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | MVCC (PostgreSQL heap) | MVCC (InnoDB undo) | Locking only (2PL, no versions) |
|---|---|---|---|
| Readers block writers? | No | No | Yes |
| Writers block readers? | No | No | Yes |
| Where old versions live | In the table + indexes | Undo tablespaces | Nowhere |
| Rollback cost | Free (flip CLOG bits) | Proportional to changes | Proportional to changes |
| Update cost | New tuple; index writes unless HOT | In-place + undo record | In-place |
| Garbage collection | VACUUM (heap and indexes) | Purge (undo, delete-marked index entries) | None |
| Long transaction impact | Table/index bloat everywhere | Undo growth, longer version chains | Blocking |
| Consistent point-in-time reads | Cheap (snapshot) | Cheap (read view) | Requires locking the read set |

### When MVCC shines

- Mixed read/write OLTP where reads vastly outnumber conflicting writes.
- Long-ish consistent reads (reports, `pg_dump`) alongside writes — as long as they are bounded.
- Workloads needing cheap rollback (PostgreSQL) or cheap point-in-time views.

### When MVCC works against you

- **Queue tables** with constant insert/delete churn: dead tuples pile up at the head where consumers read, index scans slow down, and any long transaction makes it dramatic. Keep queue tables small, vacuum aggressively, or use a real queue ([Ch 29 · Advanced Patterns](topic.html?p=29-advanced-database-patterns)).
- **Hot single-row counters** updated thousands of times per second: every update is a new version; prefer batching or sharded counters ([Ch 04](topic.html?p=04-concurrency-control)).
- **Very wide rows with one frequently updated column**: each update copies the entire row; split the hot column into a narrow table.
- **Mixed OLTP + multi-hour analytics on the same primary**: the analytics pin the horizon. Move them off the primary.

## 7. Common Mistakes & Best Practices

1. **Leaving sessions "idle in transaction".** An ORM opens a transaction on first query and the request handler never commits, or a developer leaves `BEGIN` in a psql tab. The session pins the xmin horizon cluster-wide and bloat grows on every busy table. Instead set `idle_in_transaction_session_timeout` for application roles and alert on `xact_age` > a few minutes.
2. **Disabling autovacuum "because it causes load".** The load is the garbage your writes created; skipping it converts steady background work into bloat and eventually a forced anti-wraparound vacuum at the worst time. Instead make autovacuum *more* aggressive and more frequent so each run is small.
3. **Relying on default scale factors for large tables.** 20% of a billion rows is 200M dead tuples. Instead set per-table `autovacuum_vacuum_scale_factor` near 0 with an absolute threshold for big, hot tables.
4. **Running `VACUUM FULL` in production to "fix bloat".** It takes an ACCESS EXCLUSIVE lock for the duration of a full rewrite — minutes to hours of complete unavailability for that table. Instead use `pg_repack` (online), and fix the cause (horizon, autovacuum settings) first or bloat returns.
5. **Forgetting replication slots and prepared transactions.** A logical slot for a decommissioned CDC pipeline holds `catalog_xmin` and WAL; an orphaned `PREPARE TRANSACTION` holds the horizon indefinitely. Instead monitor `pg_replication_slots` and `pg_prepared_xacts`; drop what is unused.
6. **Turning on `hot_standby_feedback` without thinking.** It stops replica query cancellations by making the primary keep versions the replica's queries need — so long replica queries bloat the primary. Instead use it with `statement_timeout` on the replica, or accept cancellations for analytics replicas.
7. **Treating XID age as an obscure metric.** Teams discover wraparound when writes start failing. Instead alert when `age(datfrozenxid)` exceeds ~40–50% of the 2-billion budget (well above `autovacuum_freeze_max_age`, meaning anti-wraparound vacuums are not completing).

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**The forgotten psql session.** At 02:00 an engineer runs `BEGIN; SELECT count(*) FROM orders;` on the primary to check something and goes home. By 10:00 queue-polling queries that took 2 ms take 400 ms; the `jobs` table (normally 30 MB) is 9 GB. Symptom: `VACUUM VERBOSE` reports "dead but not yet removable" with a removable cutoff eight hours old; `pg_stat_activity` shows one `idle in transaction` session with `xact_age` 08:00:00. Fix: `pg_terminate_backend(pid)`, let autovacuum run, `pg_repack` the worst tables, and add `idle_in_transaction_session_timeout`.

**Wraparound shutdown at 3 am.** A 6 TB database starts logging "must be vacuumed within N transactions" warnings that nobody alerts on. Anti-wraparound autovacuums on the largest tables have been running for days at the default cost limit, but they cannot make progress: a logical replication slot for an abandoned Debezium connector is holding `catalog_xmin` (and months of WAL), so tuples newer than that point can never be frozen and `datfrozenxid` cannot advance. Eventually writes fail with the "not accepting commands that assign new transaction IDs" error. Fix: drop the stale slot, run `VACUUM (FREEZE, VERBOSE)` on the oldest tables with a high cost limit (the failsafe kicks in at 1.6B age), then add XID-age and slot alerts. Duration: hours of write outage.

**Replica pins the primary.** Analysts run 4-hour queries on a replica with `hot_standby_feedback = on` to avoid "canceling statement due to conflict with recovery". The primary's update-heavy tables grow 30% per day. Fix: separate the analytics replica (feedback off, `max_standby_streaming_delay` raised so queries finish while replay waits), or move analytics to a warehouse via CDC.

**Queue table death spiral.** A `jobs` table with `FOR UPDATE SKIP LOCKED` consumers processes 2,000 jobs/s by inserting and deleting. Each consumer scans from the head of the index, which is full of dead entries; as the scan cost rises, consumers slow, jobs back up, and the table grows further. Fix: aggressive per-table autovacuum (threshold in the thousands, cost limit high), partitioned queue tables truncated/dropped per period instead of deleted, and no long transactions on the same cluster.

### Metrics to watch

| Metric | Source | Alert idea |
|---|---|---|
| Oldest transaction / snapshot age | `pg_stat_activity` (`xact_start`, `age(backend_xmin)`) | > 5–15 min on OLTP primary |
| Idle-in-transaction count and age | `pg_stat_activity.state` | any > 1 min |
| Dead tuples and dead % per hot table | `pg_stat_user_tables` | dead % > 10–20% sustained |
| Last autovacuum per hot table | `last_autovacuum` | older than expected cadence |
| XID age, multixact age | `age(datfrozenxid)`, `mxid_age(datminmxid)` | > ~500M–800M |
| Replication slot xmin age / inactive slots | `pg_replication_slots` | any inactive slot, any growing xmin age |
| Table/index size vs live rows | `pg_total_relation_size`, `n_live_tup` | bytes per live row trending up |
| InnoDB: history list length | `SHOW ENGINE INNODB STATUS` | sustained growth |

### Scaling notes

MVCC cost scales with *write rate × horizon age*. You can reduce the first (fewer updates, HOT updates, batch counters) or the second (short transactions, no long queries on the primary). As write rates grow, per-table autovacuum tuning and more workers become mandatory; beyond that, partitioning helps because each partition is vacuumed independently and old partitions are dropped instead of vacuumed ([Ch 11](topic.html?p=11-partitioning), [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)).

## 9. Interview Questions

**Q: What problem does MVCC solve, and what does it cost?**
A: It removes read/write blocking: writers create new row versions instead of overwriting, and each reader uses a snapshot to pick the version it should see, so readers never take row locks and never wait for writers. The cost is garbage: old versions must be kept until no snapshot can see them and then removed by a background process — VACUUM in PostgreSQL, purge in InnoDB. That creates bloat when cleanup falls behind, sensitivity to long-running transactions, and in PostgreSQL the need to freeze tuples to prevent XID wraparound. Only writers of the same row still conflict.

**Q: How does PostgreSQL decide whether a row version is visible to a transaction?**
A: Each tuple carries `xmin` (creating transaction) and `xmax` (deleting or updating transaction). A snapshot records the lowest still-running XID, the next unassigned XID, and the list of in-progress XIDs. A version is visible if its xmin is committed and "before" the snapshot — less than the snapshot's xmax, not in the in-progress list, and committed in `pg_xact` — and its xmax is empty, aborted, or not committed-before-the-snapshot. Hint bits cache the commit status to avoid repeated `pg_xact` lookups, and command IDs handle a transaction's own earlier writes.

**Q: What does an UPDATE physically do in PostgreSQL compared with InnoDB?**
A: In PostgreSQL an UPDATE writes a complete new tuple and sets `xmax` on the old one, linking them via `t_ctid`; indexes need new entries unless it qualifies as a HOT update. In InnoDB the row is modified in place in the clustered index and the prior values go into an undo log record, with the row's roll pointer linking to it. So PostgreSQL's old versions bloat the table and indexes until VACUUM, while InnoDB's live in undo until purge. Rollback is correspondingly free in PostgreSQL and costly in InnoDB.

**Q: Why is ROLLBACK instant in PostgreSQL even for a huge transaction?**
A: Because nothing on the data pages needs undoing. The rolled-back transaction's tuples carry its XID as xmin, and its deletions carry it as xmax; marking the XID aborted in `pg_xact` makes every reader ignore the new tuples and ignore the xmax on the old ones. The dead tuples it left behind are cleaned by VACUUM later like any other garbage. That is also why PostgreSQL has no undo log.

**Q: What is the xmin horizon and what can hold it back?**
A: It is the oldest transaction ID whose effects some snapshot might still need, and VACUUM can only remove versions deleted before it. It is held back by the oldest `backend_xmin` among sessions (long queries, `idle in transaction`, REPEATABLE READ transactions), by replication slots' `xmin` and `catalog_xmin`, by prepared transactions, and by standbys reporting their queries via `hot_standby_feedback`. Because it is effectively cluster-wide, one old snapshot stops cleanup on every table and bloat grows everywhere.

**Q: Why doesn't VACUUM shrink the table file, and what does?**
A: VACUUM marks dead tuples' space as reusable within their pages and records it in the free space map, so future inserts and updates to the same table reuse it; it only truncates completely empty pages at the end of the file. Shrinking requires rewriting the table compactly: `VACUUM FULL` or `CLUSTER` do that under an ACCESS EXCLUSIVE lock, and `pg_repack` does it online with brief locks. The better fix is preventing bloat so the file never grows beyond steady state.

**Q: How are autovacuum thresholds computed, and why are defaults bad for large tables?**
A: A table is vacuumed when dead tuples exceed `autovacuum_vacuum_threshold` (50) plus `autovacuum_vacuum_scale_factor` (0.2) times the row count, with analogous insert-based and analyze thresholds and a separate forced trigger by XID age. Because the scale factor is proportional, a billion-row table accumulates 200 million dead tuples before vacuum starts, and the resulting vacuum is huge and slow. For big hot tables you set the scale factor near zero with an absolute threshold, and raise the cost limit so each run finishes quickly.

**Q: What is XID wraparound and how does PostgreSQL prevent it?**
A: XIDs are 32-bit and compared modulo 2³², so a tuple more than about 2 billion transactions old would appear to be in the future and vanish from queries. VACUUM prevents this by freezing old tuples — marking them visible to everyone so their XID no longer matters — and autovacuum forces an anti-wraparound vacuum when a table's `relfrozenxid` age passes `autovacuum_freeze_max_age` (200M). If freezing cannot keep up, typically because the xmin horizon is held, PostgreSQL warns and eventually refuses to assign new XIDs, which stops all writes until a vacuum completes.

**Q: Why can a plain SELECT cause disk writes in PostgreSQL?**
A: The first reader that sees a tuple after its creating or deleting transaction has finished sets hint bits in the tuple header to cache the commit status, which dirties the page; the page is written out later. With data checksums or `wal_log_hints`, the first such change after a checkpoint also writes a full-page image to WAL. After a bulk load, the first full scan can therefore rewrite much of the table. Running VACUUM after bulk loads sets hint bits and visibility-map bits once, off the critical path.

**Q: A primary's tables grow 30% a day but row counts are flat. Walk through your investigation. (Senior)**
A: Flat live rows with growing size is dead-tuple accumulation, so either vacuum is not running or it cannot remove what it finds. I would check `pg_stat_user_tables` for `n_dead_tup` and `last_autovacuum`, then `VACUUM VERBOSE` on one table: "dead but not yet removable" with an old removable cutoff means the horizon is held. Then I look for the holder: oldest `backend_xmin` in `pg_stat_activity`, `pg_replication_slots` xmin and catalog_xmin, `pg_prepared_xacts`, and replicas with `hot_standby_feedback`. If nothing holds the horizon, autovacuum is under-provisioned: too few workers, low cost limit, proportional thresholds. After fixing the cause, reclaim space with `pg_repack`.

**Q: How would you design a high-throughput job queue in PostgreSQL that does not suffer from MVCC bloat? (Senior)**
A: The failure mode is constant insert/delete churn leaving dead entries at the index head that consumers scan, amplified by any long transaction. I would keep the working table small, claim with `FOR UPDATE SKIP LOCKED` in short transactions, and set aggressive per-table autovacuum with an absolute threshold and high cost limit. For large volumes I would partition the queue by time or batch and drop or truncate finished partitions instead of deleting rows, so there is nothing to vacuum. I would also keep analytics and long-running transactions off that cluster, and consider a dedicated broker when throughput or retention needs exceed what the table handles comfortably.

**Q: Compare PostgreSQL's and InnoDB's MVCC designs and when each is the better fit. (Senior)**
A: PostgreSQL stores versions in the heap: updates write new tuples, rollback is free, and snapshots are cheap, but updates can touch every index and garbage lives in the table, needing VACUUM and freezing. InnoDB updates in place and keeps prior versions in undo: the table stays compact and secondary indexes are untouched unless their columns change, but rollback is proportional to work done and long transactions lengthen version chains for readers of hot rows. Update-heavy workloads on wide rows with many indexes tend to favour InnoDB's approach; workloads with large rollbacks, heavy inserts and HOT-friendly updates suit PostgreSQL. Both punish long transactions — they just bloat different structures.

**Q: An analytics team needs 3-hour queries against production data. How do you give them that without harming the OLTP primary? (Senior)**
A: Any long snapshot on the primary pins the horizon and bloats hot tables, so the query must not run there. A physical replica works if `hot_standby_feedback` is off and `max_standby_streaming_delay` is raised so replay waits while queries finish — the cost is replica lag, which is acceptable for analytics. Alternatively use a logical replica or CDC into a warehouse, which fully decouples the workloads. I would enforce this with role-level `statement_timeout` on the primary so analytics credentials cannot run long there.

## 10. Quick Revision & Cheat Sheet

| Concept | PostgreSQL | InnoDB |
|---|---|---|
| New version on UPDATE | New heap tuple (xmin/xmax) | In place + undo record |
| Old versions stored | Heap + index entries | Undo tablespaces |
| Visibility input | Snapshot `xmin:xmax:xip` + `pg_xact` | Read view + `DB_TRX_ID` / roll pointer |
| Rollback | Free (mark aborted) | Apply undo |
| Garbage collector | VACUUM / autovacuum, HOT pruning | Purge threads |
| Long-txn symptom | Table and index bloat, "not yet removable" | History list length, undo growth |
| Wraparound | 32-bit XIDs → freezing required | Not applicable in the same form |

| Setting | Default |
|---|---|
| `autovacuum_vacuum_threshold` / `scale_factor` | 50 / 0.2 |
| `autovacuum_vacuum_insert_threshold` / `scale_factor` | 1000 / 0.2 |
| `autovacuum_max_workers` / `naptime` | 3 / 1 min |
| `autovacuum_freeze_max_age` | 200M |
| `vacuum_failsafe_age` | 1.6B |

**Remember this**
- Readers never block writers because they read an older version, not because of magic.
- Every UPDATE is an INSERT plus a tombstone; every DELETE is a tombstone.
- The oldest snapshot anywhere in the cluster decides what VACUUM can remove.
- VACUUM makes space reusable; it does not return it to the OS.
- Scale-factor thresholds are wrong for big tables — use absolute thresholds.
- XID age is an outage predictor; alert on it.
- Slots, prepared transactions and standby feedback hold the horizon too.

## 11. Hands-On Exercises

Lab: `docker run -d --name pg -e POSTGRES_PASSWORD=pw postgres:17`, two `psql` sessions.

1. **See versions.** Run the §5 two-session example. Add `pageinspect` and dump the heap page before and after the update to see both tuples.
2. **Pin the horizon.** Open a REPEATABLE READ transaction in session A; in session B run 50k updates on a table and `VACUUM VERBOSE`. Record "dead but not yet removable" and the removable cutoff. Commit A, vacuum again, and compare `pg_relation_size` before and after.
3. **Slot as a horizon holder.** Set `wal_level = logical`, create a logical slot with `pg_create_logical_replication_slot('s1', 'test_decoding')`, never consume it, churn updates, and show the slot in the horizon query. Drop the slot and vacuum.
4. **Autovacuum thresholds.** Create a 5M-row table, lower `autovacuum_naptime` to 10s, and measure how many updates it takes before autovacuum runs (`last_autovacuum`). Then set `autovacuum_vacuum_scale_factor = 0` and `threshold = 10000` on it and repeat.
5. **Burn XIDs.** Use `SELECT pg_current_xact_id();` in a loop from a script (each call in its own transaction) to advance XID age by a few million; watch `age(relfrozenxid)` grow; run `VACUUM (FREEZE)` and watch it reset.

### Mini project — "Bloat watchdog"

Write a small script (Python or Go) that every minute records: the oldest `xact_age` and its pid/application, all slots with their xmin ages, prepared transactions, top-10 tables by dead tuples with `last_autovacuum`, and database XID age. Store the samples, and emit an alert (stdout is fine) with a *specific cause* — "horizon held by pid 4312 (app=reporting) for 47 min", "slot debezium_old inactive, catalog_xmin age 120M" — rather than a generic "bloat high". Extension: add the MySQL equivalent using `INNODB_TRX` and history list length.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 02 · Storage Internals](topic.html?p=02-storage-internals) · [Ch 04 · Concurrency Control](topic.html?p=04-concurrency-control) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) · [Ch 06 · Isolation Deep Dive](topic.html?p=06-isolation-deep-dive) · [Ch 09 · Replication](topic.html?p=09-replication) (slots and standby feedback) · [Ch 24 · Database Monitoring](topic.html?p=24-database-monitoring) · [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle).

**SQL Handbook:** [Locking, MVCC & Deadlocks](../sql/topic.html?p=27-locking-mvcc) · [Isolation Levels](../sql/topic.html?p=26-isolation-levels) · [Transactions & ACID](../sql/topic.html?p=25-transactions-acid).

**Other handbooks:** [Kafka & RabbitMQ · Kafka Connect & CDC](../messaging/topic.html?p=25-kafka-connect-cdc) (why CDC slots must be monitored) · [System Design · Indexing & Storage Engines](../system-design/topic.html?p=15-indexing-storage-engines).

- **PostgreSQL docs — Concurrency Control (MVCC)** — PostgreSQL · *Intermediate* · the official model of snapshots and isolation in PostgreSQL. <https://www.postgresql.org/docs/current/mvcc.html>
- **PostgreSQL docs — Routine Vacuuming** — PostgreSQL · *Intermediate* · vacuum, autovacuum and the authoritative treatment of XID wraparound and freezing. <https://www.postgresql.org/docs/current/routine-vacuuming.html>
- **The Internals of PostgreSQL, ch. 5–6 (Concurrency Control, Vacuum)** — Hironobu Suzuki · *Advanced* · tuple headers, snapshots, visibility checks and vacuum phases with diagrams. <https://www.interdb.jp/pg/>
- **MySQL docs — InnoDB Multi-Versioning** — Oracle · *Intermediate* · hidden columns, undo logs and purge in InnoDB. <https://dev.mysql.com/doc/refman/8.0/en/innodb-multi-versioning.html>
- **Postgres Job Queues & Failure By MVCC** — Brandur Leach · *Intermediate* · a real incident of a queue table degraded by a long transaction. <https://brandur.org/postgres-queues>
- **CMU 15-445 — Multi-Version Concurrency Control lecture** — Andy Pavlo · *Advanced* · version storage, garbage collection and index management designs compared. <https://15445.courses.cs.cmu.edu/>
- **Designing Data-Intensive Applications, ch. 7** — Martin Kleppmann · *Intermediate* · snapshot isolation and MVCC in the context of transaction guarantees. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 03.*
