# 07 · Write-Ahead Logging: What Happens at COMMIT

> **In one line:** A database makes a transaction durable not by writing its data pages but by appending a compact description of the change to a sequential log and forcing *that* to disk before saying "committed" — and almost every durability, performance and replication behaviour you will see in production follows from that one rule.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Transactions & ACID](../sql/topic.html?p=25-transactions-acid) (the WAL intuition: log first, pages later) · [Ch 01 · Database Architecture](topic.html?p=01-database-architecture) (where the WAL writer and checkpointer sit) · [Ch 02 · Storage Internals](topic.html?p=02-storage-internals) (8 KB pages, the buffer pool). This chapter opens the box: the exact commit sequence, LSNs, fsync, group commit, checkpoints, full-page writes, WAL volume and archiving, and MySQL's redo log + binlog.

Consider the problem a database faces when you run `UPDATE accounts SET balance = balance - 100 WHERE id = 1; UPDATE accounts SET balance = balance + 100 WHERE id = 2; COMMIT;`. The two rows live on two different 8 KB pages, perhaps in different files, plus each index on the table has its own pages. When `COMMIT` returns, you are promised that the transfer survives a power cut. What must be on disk at that moment?

The **naive approach** is to write every modified page to its place in the data files and `fsync` them before acknowledging. It fails three ways. It is **slow**: a transaction touching 6 pages scattered across a 2 TB table does 6 random writes plus fsyncs, and a busy OLTP system commits thousands of times per second. It is **not atomic**: the machine can die after page 1 is written and before page 2, leaving money destroyed, and there is no way to write two pages to two places atomically. And it is **not even safe per page**: an 8 KB PostgreSQL page is larger than the 4 KB block most filesystems and disks write atomically, so a crash can leave a page half old and half new — a **torn page**.

The solution, used by virtually every serious database since the 1970s, is **write-ahead logging (WAL)**. Every change is first described in a **log record** appended to a sequential file. At commit, the database appends a **commit record** and forces the log to durable storage up to that point. The data pages are modified only in memory and written back lazily, whenever convenient. If the machine crashes, the log contains everything needed to reconstruct the committed state. One sequential fsync replaces many random ones; atomicity comes from the single commit record; torn pages are repaired from the log.

The one-line consequence you should remember: **the commit latency of your database is the latency of a log flush**, and the recovery time, replication, backups and CDC pipelines all run on that same log. Understanding the WAL is understanding the database's heartbeat.

## 2. Core Concepts

- **WAL record** — a small description of one change ("insert tuple at page 42 slot 3 of relation 16384, with these bytes"). *Why it matters:* it is the unit of durability, replication and recovery.
- **LSN (Log Sequence Number)** — a 64-bit byte position in the WAL stream, shown as `16/B374D848`. *Why it matters:* every page, every commit, every replica position and every backup is expressed in LSNs; differences between LSNs are bytes of WAL.
- **WAL segment** — the WAL is stored as files in `pg_wal/`, 16 MB each by default (`wal_segment_size`, set at initdb). *Why it matters:* archiving and replication move whole or partial segments; disk-full incidents are counted in segments.
- **WAL buffers** — shared memory where records are assembled before being written (`wal_buffers`, default auto: 1/32 of `shared_buffers`, capped at one segment). *Why it matters:* most records are written from memory in batches; `pg_stat_wal.wal_buffers_full` tells you when it is too small.
- **Page LSN** — every data page header stores the LSN of the last WAL record that modified it. *Why it matters:* it is how the buffer manager enforces the WAL rule and how recovery knows whether a record was already applied.
- **Commit record** — the WAL record that says "transaction 745 committed at time T". *Why it matters:* a transaction is durable exactly when its commit record is durable.
- **pg_xact (CLOG)** — two bits per transaction ID recording in-progress / committed / aborted / sub-committed. *Why it matters:* PostgreSQL decides row visibility from it, which is why PostgreSQL needs no undo log.
- **fsync** — the system call that forces a file's data from the OS page cache to stable storage. *Why it matters:* without it, "written" means "in RAM"; the cost of this call is your commit latency floor.
- **Group commit** — flushing many transactions' commit records with one fsync. *Why it matters:* it is why throughput scales with concurrency even though every commit must be durable.
- **Checkpoint** — a point at which all dirty pages modified before a given LSN (the **redo point**) have been written to the data files. *Why it matters:* it bounds recovery time and lets old WAL be recycled.
- **Full-page write (FPW / FPI)** — the first time a page is modified after a checkpoint, the whole 8 KB page image goes into WAL. *Why it matters:* it protects against torn pages and is often the biggest single driver of WAL volume.
- **synchronous_commit** — per-transaction setting deciding what "commit" waits for: nothing, the local flush, or standby confirmation. *Why it matters:* it is the durability-versus-latency dial you can turn per transaction.
- **Redo log / undo log / binlog (MySQL)** — InnoDB's physical redo log, its undo logs for rollback and MVCC, and the server-level logical binary log used for replication and point-in-time recovery. *Why it matters:* MySQL has two logs to keep in agreement, which is why it runs an internal two-phase commit.

## 3. Theory & Principles

### The WAL rule

The whole mechanism rests on one invariant, the **write-ahead rule**: *a data page may not be written to disk until the WAL records describing all changes to that page have been flushed to disk.* Every page carries its page LSN; before the buffer manager (or checkpointer, or background writer) writes a dirty page, it calls the log flush routine to make sure the WAL is durable at least up to that page LSN. If a crash happens at any moment, every change present in the data files is guaranteed to also be described in the durable log — never the other way round. That is what makes recovery by replay possible.

The second rule is the **commit rule**: *a transaction is not reported committed until its commit record (and therefore every record before it) is durable in the log.* Together they give you durability and atomicity with only sequential forced writes.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c07a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c07a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c07a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The WAL rule: a page may reach disk only after its log records do</text>
  <rect x="20" y="40" width="400" height="190" rx="10" fill="#dbeafe" stroke="#2563eb"/>
  <text x="220" y="60" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Memory</text>
  <rect x="40" y="74" width="170" height="130" rx="6" fill="#fff" stroke="#94a3b8"/>
  <text x="125" y="92" text-anchor="middle" fill="#1e293b" font-weight="bold">shared_buffers</text>
  <rect x="54" y="102" width="142" height="26" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="125" y="119" text-anchor="middle" fill="#334155" font-size="10">page 42, pageLSN 0/5A0</text>
  <rect x="54" y="134" width="142" height="26" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="125" y="151" text-anchor="middle" fill="#334155" font-size="10">page 97, pageLSN 0/5F8</text>
  <text x="125" y="186" text-anchor="middle" fill="#334155" font-size="10">dirty pages (modified)</text>
  <rect x="230" y="74" width="170" height="130" rx="6" fill="#fff" stroke="#94a3b8"/>
  <text x="315" y="92" text-anchor="middle" fill="#1e293b" font-weight="bold">WAL buffers</text>
  <rect x="244" y="102" width="142" height="22" rx="4" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="315" y="117" text-anchor="middle" fill="#334155" font-size="10">0/5A0 INSERT p42</text>
  <rect x="244" y="128" width="142" height="22" rx="4" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="315" y="143" text-anchor="middle" fill="#334155" font-size="10">0/5F8 UPDATE p97</text>
  <rect x="244" y="154" width="142" height="22" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="315" y="169" text-anchor="middle" fill="#334155" font-size="10">0/640 COMMIT xid 745</text>
  <text x="315" y="194" text-anchor="middle" fill="#334155" font-size="10">append-only, in LSN order</text>
  <rect x="460" y="40" width="400" height="190" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="660" y="60" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Disk</text>
  <rect x="480" y="74" width="170" height="130" rx="6" fill="#fff" stroke="#94a3b8"/>
  <text x="565" y="92" text-anchor="middle" fill="#1e293b" font-weight="bold">pg_wal/ (sequential)</text>
  <text x="565" y="118" text-anchor="middle" fill="#334155" font-size="10">flushed up to 0/640</text>
  <text x="565" y="136" text-anchor="middle" fill="#334155" font-size="10">16 MB segment files</text>
  <text x="565" y="154" text-anchor="middle" fill="#334155" font-size="10">fsync at every commit</text>
  <text x="565" y="184" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">durability lives here</text>
  <rect x="670" y="74" width="170" height="130" rx="6" fill="#fff" stroke="#94a3b8"/>
  <text x="755" y="92" text-anchor="middle" fill="#1e293b" font-weight="bold">data files (random)</text>
  <text x="755" y="118" text-anchor="middle" fill="#334155" font-size="10">page 42: old version</text>
  <text x="755" y="136" text-anchor="middle" fill="#334155" font-size="10">page 97: old version</text>
  <text x="755" y="154" text-anchor="middle" fill="#334155" font-size="10">written lazily by</text>
  <text x="755" y="170" text-anchor="middle" fill="#334155" font-size="10">bgwriter / checkpointer</text>
  <path d="M400,150 L476,150" stroke="#16a34a" stroke-width="2" marker-end="url(#c07a3)"/>
  <text x="438" y="142" text-anchor="middle" fill="#14532d" font-size="9">1. flush</text>
  <path d="M210,118 Q440,250 690,190" fill="none" stroke="#2563eb" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#c07a1)"/>
  <text x="470" y="236" text-anchor="middle" fill="#1e40af" font-size="10">2. later: write page only if WAL flushed LSN &#8805; pageLSN</text>
  <rect x="20" y="258" width="840" height="150" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="36" y="280" fill="#7f1d1d" font-size="12" font-weight="bold">Why the order matters (crash at any instant)</text>
  <text x="36" y="302" fill="#334155" font-size="10">Page on disk, WAL not on disk: recovery cannot know the change happened or whether it committed. A half-applied transaction survives. FORBIDDEN.</text>
  <text x="36" y="322" fill="#334155" font-size="10">WAL on disk, page not on disk: recovery replays the record onto the old page (redo). Fine.</text>
  <text x="36" y="342" fill="#334155" font-size="10">Commit record on disk: transaction is durable even if none of its pages ever got written.</text>
  <text x="36" y="362" fill="#334155" font-size="10">No commit record on disk: in PostgreSQL the xid is never marked committed in pg_xact, so its tuples are invisible forever.</text>
  <text x="36" y="390" fill="#7f1d1d" font-size="11" font-weight="bold">Sequential fsync of a few KB of log replaces random writes of many 8 KB pages: that is the whole performance win.</text>
</svg>
```

### Redo, undo, and the steal / no-force vocabulary

Textbooks describe buffer management with two choices. **No-force** means committed pages are *not* forced to disk at commit — so the log must be able to **redo** committed changes. **Steal** means the buffer manager may write a dirty page containing *uncommitted* changes to disk (to free a buffer) — so the system must be able to **undo** them, or otherwise ignore them. Every mainstream engine chooses steal + no-force because it gives the buffer pool maximum freedom; the price is that recovery must handle both directions.

InnoDB handles the undo direction classically. When a transaction modifies a row in its clustered index, the old version goes to an **undo log** (in undo tablespaces / rollback segments), and a pointer to it is kept in the row. The undo log pages are themselves changed through the redo log, so after a crash, redo first rebuilds both data and undo pages, and then InnoDB rolls back every transaction that did not commit by applying its undo records. The same undo logs serve MVCC reads and `ROLLBACK`.

### Why PostgreSQL does not need undo

PostgreSQL makes the undo direction unnecessary by design. An `UPDATE` never overwrites a tuple in place; it writes a **new tuple version** stamped with `xmin = my xid`, and marks the old version's `xmax` (see [Ch 03 · MVCC](topic.html?p=03-mvcc)). Whether any tuple is visible depends on whether its `xmin` transaction **committed**, which is recorded in `pg_xact`. If a transaction's pages reached disk (steal) but its commit record never did, then after recovery its xid is not marked committed — it is treated as aborted — and every tuple it created is simply invisible, later cleaned up by vacuum like any other dead tuple. Nothing needs to be undone because nothing was destroyed. **PostgreSQL recovery is redo-only.**

The same property makes `ROLLBACK` in PostgreSQL nearly instantaneous regardless of transaction size — it just records "aborted" — whereas an InnoDB rollback of a large transaction must apply undo records row by row and can take as long as the transaction itself took.

> **Why this matters:** A note on the SQL Handbook's simplified picture, "recovery REDOes committed and UNDOes uncommitted": that is accurate for InnoDB and textbook ARIES, but in PostgreSQL the "undo" is achieved by visibility rules, not by a log pass. [Ch 08 · Crash Recovery](topic.html?p=08-crash-recovery) walks through both.

### What a WAL record contains

A PostgreSQL WAL record has a header (total length, transaction ID, the resource manager — Heap, Btree, Transaction, XLOG… — a CRC, and the LSN of the previous record) and one or more **block references** identifying which relation/fork/block it modifies, followed by the data needed to redo the change. Records are **physiological**: they name a physical page but describe the change logically within it ("insert this tuple at offset 3"). Replaying them requires the page to be in a known state, which is why the first change after each checkpoint logs the full page image instead.

## 4. Architecture & Workflow

### What exactly happens when a transaction commits

Here is the life of `BEGIN; INSERT INTO orders …; COMMIT;` on PostgreSQL with default settings (`synchronous_commit = on`, no synchronous standby), step by step.

1. **BEGIN** — nothing durable happens. A virtual transaction ID is assigned; a real **xid** is assigned lazily on the first write.
2. **INSERT** — the backend finds a heap page with free space, pins it in `shared_buffers`, takes an exclusive content lock on the page, writes the new tuple (`xmin = 745`), and calls `XLogInsert` to append a Heap INSERT record to the WAL buffers. The record gets an LSN; the page's `pd_lsn` is set to that LSN. Each index gets the same treatment with Btree records. If this is the first change to the page since the last checkpoint, the record carries a **full page image**. The page is now dirty in memory; nothing has touched disk.
3. **COMMIT** — the backend appends a **commit record** (xid 745, timestamp) to the WAL buffers. Its LSN is the transaction's **commit LSN**.
4. **Flush** — `XLogFlush(commit LSN)`: the backend `write()`s WAL buffers to the current segment file and calls `fdatasync` (or the configured `wal_sync_method`). If another backend is already flushing, it waits and often finds its record already covered — this is **group commit**. This fsync is almost all of the commit latency.
5. **Mark committed** — the xid's status bits are set to committed in `pg_xact` (in shared memory; the CLOG page reaches disk later and is protected by WAL).
6. **Synchronous replication wait** (only if `synchronous_standby_names` is set) — the backend waits until the standby(s) confirm the commit LSN at the level required (`remote_write`, `on` = flushed, `remote_apply`). Until this completes, other sessions still see the transaction as in progress.
7. **Become visible** — the transaction is removed from the ProcArray; new snapshots now treat 745 as committed.
8. **Release locks** and **reply** `COMMIT` to the client.

The data page with the new order row may not be written to the data file for minutes — until the background writer evicts it or the next checkpoint flushes it.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c07b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">COMMIT timeline in PostgreSQL, and group commit</text>
  <line x1="40" y1="70" x2="850" y2="70" stroke="#334155" stroke-width="1.5" marker-end="url(#c07b1)"/>
  <text x="846" y="62" text-anchor="end" fill="#334155" font-size="10">time</text>
  <rect x="40" y="84" width="110" height="48" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="95" y="102" text-anchor="middle" fill="#1e293b" font-weight="bold">INSERT</text>
  <text x="95" y="118" text-anchor="middle" fill="#334155" font-size="9">page + WAL buffer</text>
  <rect x="160" y="84" width="110" height="48" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="215" y="102" text-anchor="middle" fill="#1e293b" font-weight="bold">commit record</text>
  <text x="215" y="118" text-anchor="middle" fill="#334155" font-size="9">into WAL buffers</text>
  <rect x="280" y="84" width="190" height="48" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="375" y="102" text-anchor="middle" fill="#1e293b" font-weight="bold">write + fdatasync pg_wal</text>
  <text x="375" y="118" text-anchor="middle" fill="#334155" font-size="9">0.05 ms NVMe PLP .. 1-5 ms cloud disk</text>
  <rect x="480" y="84" width="100" height="48" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="530" y="102" text-anchor="middle" fill="#1e293b" font-weight="bold">pg_xact</text>
  <text x="530" y="118" text-anchor="middle" fill="#334155" font-size="9">mark committed</text>
  <rect x="590" y="84" width="130" height="48" rx="6" fill="#f8fafc" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="655" y="102" text-anchor="middle" fill="#1e293b" font-weight="bold">sync standby wait</text>
  <text x="655" y="118" text-anchor="middle" fill="#334155" font-size="9">only if configured</text>
  <rect x="730" y="84" width="120" height="48" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="790" y="102" text-anchor="middle" fill="#1e293b" font-weight="bold">visible + unlock</text>
  <text x="790" y="118" text-anchor="middle" fill="#334155" font-size="9">reply COMMIT</text>
  <text x="375" y="150" text-anchor="middle" fill="#7f1d1d" font-size="10" font-weight="bold">durability point = flush completes</text>
  <rect x="20" y="170" width="840" height="170" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="36" y="190" fill="#1e293b" font-size="12" font-weight="bold">Group commit: one fsync covers every commit record already in the buffer</text>
  <text x="36" y="214" fill="#334155" font-size="10">backend A</text>
  <rect x="110" y="202" width="70" height="18" rx="3" fill="#ede9fe" stroke="#7c3aed"/><text x="145" y="215" text-anchor="middle" fill="#334155" font-size="9">commit rec</text>
  <text x="36" y="244" fill="#334155" font-size="10">backend B</text>
  <rect x="150" y="232" width="70" height="18" rx="3" fill="#ede9fe" stroke="#7c3aed"/><text x="185" y="245" text-anchor="middle" fill="#334155" font-size="9">commit rec</text>
  <text x="36" y="274" fill="#334155" font-size="10">backend C</text>
  <rect x="190" y="262" width="70" height="18" rx="3" fill="#ede9fe" stroke="#7c3aed"/><text x="225" y="275" text-anchor="middle" fill="#334155" font-size="9">commit rec</text>
  <rect x="280" y="202" width="260" height="78" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="410" y="230" text-anchor="middle" fill="#1e293b" font-weight="bold">ONE write + fdatasync</text>
  <text x="410" y="248" text-anchor="middle" fill="#334155" font-size="10">A takes the WAL write lock and flushes</text>
  <text x="410" y="264" text-anchor="middle" fill="#334155" font-size="10">up to the newest inserted LSN (covers B, C)</text>
  <path d="M540,241 L590,241" stroke="#334155" stroke-width="1.5" marker-end="url(#c07b1)"/>
  <rect x="594" y="202" width="250" height="78" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="719" y="230" text-anchor="middle" fill="#1e293b" font-weight="bold">A, B, C all durable</text>
  <text x="719" y="248" text-anchor="middle" fill="#334155" font-size="10">B and C wake, see flushed LSN &#8805; theirs,</text>
  <text x="719" y="264" text-anchor="middle" fill="#334155" font-size="10">and return without their own fsync</text>
  <text x="36" y="310" fill="#334155" font-size="10">commit_delay (default 0 us) makes the flusher sleep briefly to gather more commits when at least commit_siblings (default 5) are active.</text>
  <text x="36" y="328" fill="#334155" font-size="10">Throughput rises with concurrency while each client's latency stays about one fsync.</text>
  <rect x="20" y="352" width="840" height="76" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="36" y="372" fill="#7f1d1d" font-size="12" font-weight="bold">synchronous_commit = off</text>
  <text x="36" y="392" fill="#334155" font-size="10">Steps 4 and 6 are skipped: COMMIT returns after the commit record is in WAL buffers. The WAL writer flushes every wal_writer_delay (200 ms).</text>
  <text x="36" y="410" fill="#334155" font-size="10">A crash can lose commits from roughly the last 3 x wal_writer_delay, but never corrupts: the lost transactions simply never happened.</text>
</svg>
```

### Group commit and why fsync latency dominates

On storage with a volatile write cache and no power-loss protection, an honest fsync costs a physical write — milliseconds. On enterprise NVMe with power-loss protection it can be tens of microseconds. On network block storage (EBS, Persistent Disk) it is typically on the order of a millisecond or more, because the write crosses a network and is replicated. A single-threaded client doing one-row autocommit inserts is therefore limited to roughly `1 / fsync_latency` commits per second — a few hundred to a few thousand on cloud disks. That is why batching rows into one transaction speeds bulk loads so dramatically, and why many concurrent clients get far more total throughput than one: group commit amortises one fsync across all commits waiting at that moment.

### Checkpoints: bounding recovery and recycling WAL

If pages were never written back, recovery would have to replay WAL from the beginning of time. A **checkpoint** fixes that. The checkpointer notes the current WAL insert position as the **redo point**, writes every page that was dirty at that moment to the data files, fsyncs the data files, writes a **checkpoint record** into WAL, and updates `pg_control` to point at it. After a crash, recovery starts at the last checkpoint's redo point — everything before it is already in the data files. WAL segments older than the redo point can be recycled (unless retained for archiving, `wal_keep_size`, or replication slots).

Checkpoints are triggered by **time** (`checkpoint_timeout`, default 5 min) or **WAL volume** (`max_wal_size`, default 1 GB, a soft limit), whichever comes first, plus manual `CHECKPOINT`, shutdown and base backups. The writes are spread over `checkpoint_completion_target` (default 0.9) of the interval to avoid I/O spikes. If checkpoints are triggered by WAL volume more often than `checkpoint_warning` (30 s), the log says `checkpoints are occurring too frequently` — a sign `max_wal_size` is too small.

### Full-page writes: the torn-page defence and the WAL multiplier

A WAL record like "insert tuple at offset 3" can only be replayed onto a page that is internally consistent. If the crash tore the page — 4 KB of new data, 4 KB of old — replaying a small delta produces garbage. So with `full_page_writes = on` (the default; leave it on), the **first modification of each page after a checkpoint** logs the entire 8 KB page image. During recovery, that image overwrites whatever is on disk, and subsequent deltas apply to a known-good page.

The cost is volume. Right after a checkpoint, nearly every touched page produces an 8 KB image instead of a ~100-byte delta, so WAL generation spikes and then decays until the next checkpoint. More frequent checkpoints mean more full-page images. This is the central WAL tuning trade-off: **longer checkpoint intervals reduce WAL volume and I/O, but lengthen crash recovery.**

> **MySQL difference:** InnoDB does not log full page images. It protects against torn 16 KB pages with the **doublewrite buffer**: pages are first written sequentially to a doublewrite area and fsynced, then written to their real location. After a crash, a torn page is restored from its doublewrite copy before redo is applied. Same problem, different trade-off: extra data-file writes instead of extra log volume.

### What drives WAL volume

- **Full-page images** after checkpoints (often the largest share; visible as `wal_fpi` in `pg_stat_wal`).
- **Non-HOT updates** — every index gets a new entry and its own WAL record; a table with 8 indexes multiplies write volume (see [Ch 02 · Storage Internals](topic.html?p=02-storage-internals)).
- **Random-key inserts** (UUIDv4 primary keys) touch a different B-tree leaf page per insert, so each insert can trigger a fresh full-page image; time-ordered keys (UUIDv7, bigint identity) keep inserts on a few hot pages.
- **Wide rows and bulk updates** — `UPDATE big_table SET flag = true` rewrites every row as a new version.
- **Maintenance** — `VACUUM` (especially freezing), `CREATE INDEX`, `CLUSTER`, `VACUUM FULL`.
- **wal_level** — `replica` (default) logs enough for physical standbys; `logical` adds information for logical decoding; `minimal` skips WAL for some bulk operations but makes archiving and replication impossible.
- **Hint bits with checksums** — with data checksums or `wal_log_hints = on`, setting hint bits on a page for the first time after a checkpoint can emit a full-page image even on reads.

### WAL archiving: WAL as a backup stream

With `archive_mode = on`, each completed segment is handed to `archive_command` (a shell command) or `archive_library` (a loadable module, PG 15+), typically to object storage via pgBackRest, WAL-G or Barman. A base backup plus the continuous archive gives **point-in-time recovery** — see [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery). The danger: a segment is not removed from `pg_wal/` until it has been archived successfully. If the archive target rejects writes (expired credentials, full bucket), `.ready` files pile up in `pg_wal/archive_status/` and **`pg_wal` grows until the disk is full**, at which point the database stops.

### MySQL: redo log, binlog and the internal two-phase commit

InnoDB's **redo log** plays the WAL role (sized by `innodb_redo_log_capacity` in 8.0.30+). Its flush policy is `innodb_flush_log_at_trx_commit`: `1` (default) writes and flushes at every commit; `2` writes to the OS at commit and flushes about once per second (survives a mysqld crash, not an OS crash or power loss); `0` writes and flushes about once per second.

But MySQL also has the **binary log** — a server-level, logical (usually row-based) log that replicas and PITR use. A transaction must be in both or neither, or a replica would diverge from its source. So MySQL runs an **internal two-phase commit** (XA between the binlog and InnoDB):

```text
1. InnoDB PREPARE : write a prepare record for the txn to the redo log, flush it (per innodb_flush_log_at_trx_commit)
2. Binlog write   : write the txn's events + XID event to the binlog, fsync it (per sync_binlog; 1 = every group)
3. InnoDB COMMIT  : write the commit mark in the redo log (need not be flushed synchronously)

Crash recovery:   InnoDB finds transactions in PREPARED state. For each, it checks the last binlog:
                  XID present in binlog -> COMMIT it ; absent -> ROLL BACK.
                  The binlog is the arbiter, so replicas and the source always agree.
```

Binlog group commit batches the flush and sync stages across many transactions (`binlog_group_commit_sync_delay` can widen the batch). The "fully durable" MySQL configuration is `innodb_flush_log_at_trx_commit = 1` **and** `sync_binlog = 1`; relaxing either can lose committed transactions or let the binlog and InnoDB disagree after an OS crash.

## 5. Implementation

### Simple example: measure the WAL your statements produce

In the `postgres:17` lab:

```sql
CREATE TABLE t (id bigint PRIMARY KEY, payload text);
CHECKPOINT;                                  -- start from a fresh checkpoint so FPIs appear

SELECT pg_current_wal_lsn() AS before \gset
INSERT INTO t SELECT g, repeat('x', 100) FROM generate_series(1, 100000) g;
SELECT pg_current_wal_lsn() AS after \gset

SELECT pg_size_pretty(pg_wal_lsn_diff(:'after', :'before')) AS wal_generated,
       pg_walfile_name(:'after')                             AS current_segment;
```

```text
 wal_generated | current_segment
---------------+--------------------------
 21 MB         | 000000010000000000000003
```

About 21 MB of WAL for roughly 14 MB of heap plus a 2 MB index: heap records, B-tree records, and page images. Now repeat with `UPDATE t SET payload = payload || 'y'` right after a `CHECKPOINT` and again without one — the difference is full-page images.

Look at the records themselves with `pg_waldump` (run inside the container as the postgres user):

```text
$ pg_waldump -p /var/lib/postgresql/data/pg_wal -s 0/3000060 -n 4
rmgr: Heap        len (rec/tot):     54/  7890, tx:        749, lsn: 0/03000060, prev 0/03000028, desc: INSERT off: 1, flags: 0x00, blkref #0: rel 1663/5/16390 blk 0 FPW
rmgr: Btree       len (rec/tot):     64/    64, tx:        749, lsn: 0/03001F38, prev 0/03000060, desc: INSERT_LEAF off: 2, blkref #0: rel 1663/5/16393 blk 1
rmgr: Heap        len (rec/tot):    163/   163, tx:        749, lsn: 0/03001F78, prev 0/03001F38, desc: INSERT off: 2, flags: 0x00, blkref #0: rel 1663/5/16390 blk 0
rmgr: Transaction len (rec/tot):     34/    34, tx:        749, lsn: 0/03002020, prev 0/03001F78, desc: COMMIT 2026-09-24 09:12:44.113204 UTC
```

The first heap record is ~7.9 KB because it carries a full-page write (`FPW`); the next insert on the same page is 163 bytes. The commit record is 34 bytes — the whole durability of the transaction hinges on that tiny record reaching disk.

### Simple example: feel synchronous_commit

```text
$ pgbench -i -s 10 postgres
$ pgbench -c 1 -j 1 -T 30 -N postgres                          # synchronous_commit = on
$ PGOPTIONS='-c synchronous_commit=off' pgbench -c 1 -j 1 -T 30 -N postgres
$ pgbench -c 32 -j 8 -T 30 -N postgres                        # group commit at work
```

On a laptop SSD you will typically see single-client TPS jump severalfold with `synchronous_commit=off`, and 32 clients with it `on` reach far more total TPS than one client — the fsync is shared. On cloud block storage the gap is larger, because each fsync costs more.

### Real-world example: an event-ingestion service drowning in WAL

A telemetry service inserts ~15,000 rows/s into `events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), device_id, ts, body jsonb)` with three secondary indexes. Symptoms: WAL generation around 60 MB/s, the replica lagging, the archive bucket growing by 4 TB a day, and checkpoints logged as "occurring too frequently". Diagnose with the WAL statistics views:

```sql
-- PG 14-17: cumulative WAL activity. Sample twice, 60 s apart, and diff.
SELECT wal_records, wal_fpi, pg_size_pretty(wal_bytes) AS wal_bytes, wal_buffers_full
FROM pg_stat_wal;

-- PG 17: checkpoint counters moved from pg_stat_bgwriter to pg_stat_checkpointer
SELECT num_timed, num_requested, write_time, sync_time, buffers_written
FROM pg_stat_checkpointer;

-- Which statements write the most WAL (pg_stat_statements has wal_* columns since PG 13)
SELECT left(query, 60) AS query, calls, wal_records, wal_fpi, pg_size_pretty(wal_bytes) AS wal
FROM pg_stat_statements ORDER BY wal_bytes DESC LIMIT 5;
```

```text
 wal_records |  wal_fpi  | wal_bytes | wal_buffers_full
-------------+-----------+-----------+------------------
    91203344 |  38170211 | 3553 GB   |           120440

 num_timed | num_requested | ...
-----------+---------------+
       112 |          9804 |
```

The story is in the numbers: `num_requested` dwarfs `num_timed` (checkpoints are forced by WAL volume, every ~15 s), and `wal_fpi` is a large fraction of records — random UUID inserts touch a different index leaf each time, and each first touch after a checkpoint is an 8 KB image. The fixes, in order of impact:

```ini
# postgresql.conf
max_wal_size = 32GB                 # let checkpoints be time-driven, not volume-driven
checkpoint_timeout = 15min          # fewer checkpoints => far fewer full-page images
checkpoint_completion_target = 0.9  # spread checkpoint writes (the default)
wal_compression = lz4               # compress full-page images (PG 15+: lz4/zstd)
wal_buffers = 64MB                  # wal_buffers_full was climbing
```

Then the schema: switch the primary key to a time-ordered UUIDv7 or a `bigint` identity so inserts append to the right edge of the B-tree, and drop an unused secondary index found via `pg_stat_user_indexes.idx_scan = 0`. The cost of longer checkpoints: crash recovery may now replay up to ~15 minutes or 32 GB of WAL — see [Ch 08 · Crash Recovery](topic.html?p=08-crash-recovery) for how to estimate that and decide if your RTO allows it.

### Choosing durability per transaction

`synchronous_commit` can be set per transaction, which lets you keep strict durability for money and relax it for data you can regenerate:

```sql
-- Page-view counters, analytics beacons: losing the last ~600 ms on a crash is acceptable
BEGIN;
SET LOCAL synchronous_commit = off;
INSERT INTO page_views(page_id, viewed_at) VALUES ($1, now());
COMMIT;

-- Payments stay at the cluster default (on, or remote_apply with a sync standby)
```

> **Why this matters:** `synchronous_commit = off` is **not** `fsync = off`. The former can lose the most recent commits but the database stays consistent. `fsync = off` lets the OS reorder and drop writes, and a power loss can leave the entire cluster **corrupted**. The first is a legitimate engineering trade-off; the second is only acceptable for throwaway test databases.

## 6. Advantages, Disadvantages & Trade-offs

| Setting | Commit waits for | Can lose on crash | Can corrupt? | Typical use |
|---|---|---|---|---|
| `synchronous_commit = off` | nothing (WAL buffer insert) | last ~3 × `wal_writer_delay` of commits | No | counters, telemetry, cache-like tables |
| `local` | local WAL flush | nothing locally; recent commits on failover to a replica | No | primary-only durability even with sync standbys configured |
| `on` (default) | local flush (+ standby flush if sync rep) | nothing (with sync rep: nothing on failover) | No | default OLTP |
| `remote_write` | standby received into OS cache | only if primary and standby OS crash together | No | sync rep with lower latency |
| `remote_apply` | standby replayed it | nothing; read-your-writes on that standby | No | reads on standby must see the commit |
| `fsync = off` | nothing reaches disk reliably | anything | **Yes** | never in production |
| InnoDB `flush_log_at_trx_commit = 1` + `sync_binlog = 1` | redo + binlog flush | nothing | No | MySQL default-safe |
| InnoDB `= 2` | OS write | ~1 s on OS crash/power loss | No | tolerant workloads |

| Knob | Raising it | Lowering it |
|---|---|---|
| `checkpoint_timeout`, `max_wal_size` | less WAL (fewer FPIs), smoother I/O | faster crash recovery, less `pg_wal` disk |
| `full_page_writes` | (keep on) torn-page safety | only if the storage guarantees atomic 8 KB writes (e.g. some copy-on-write filesystems) |
| `commit_delay` | more commits per fsync under heavy concurrency | lower single-commit latency |
| `wal_compression` | less WAL volume and network | less CPU |

### When to use relaxed durability

- **Use `synchronous_commit = off`** for data you can recompute or tolerate losing a fraction of a second of: metrics, logs, session touch timestamps, idempotent re-deliverable events.
- **Use longer checkpoint intervals** on write-heavy systems where WAL volume, replica lag or archive cost hurt, and your RTO tolerates a longer replay.

### When NOT to

- **Never relax durability for ledgers, orders, payments, inventory** or anything where a client was told "done" and acted on it.
- **Never use `fsync = off` or `full_page_writes = off`** on real data unless you have proven your storage makes it safe.
- **Do not raise `max_wal_size`** without the disk space for it — `pg_wal` can legitimately grow beyond it during bursts.

## 7. Common Mistakes & Best Practices

- **Assuming "committed" means "the row is in the table file".** It means the commit record is in the WAL. The heap page may be minutes from disk. This matters when you reason about backups by file copy (never copy a running data directory without `pg_basebackup` or a snapshot that includes `pg_wal`).
- **Tiny `max_wal_size` on a write-heavy system.** Checkpoints every few seconds multiply full-page images and I/O. Watch `num_requested` versus `num_timed`; size `max_wal_size` so checkpoints are mostly timed.
- **Deleting files from `pg_wal` to free disk.** It destroys the database's ability to recover; the cluster may not start. Instead, fix the retention cause (failing archive, abandoned slot, `wal_keep_size`) and let PostgreSQL remove segments itself.
- **Putting `pg_wal` on slow or shared storage.** WAL is latency-critical sequential I/O; a noisy neighbour on the same volume shows up directly in commit latency. Use a dedicated low-latency volume where you can.
- **Storage that lies about fsync.** Consumer SSDs and some virtualised disks acknowledge writes from a volatile cache. Every commit "succeeds" and a power cut loses them. Use enterprise drives with power-loss protection, and test with `pg_test_fsync` (an implausibly fast fsync is a warning sign).
- **Unmonitored archiving.** A silently failing `archive_command` fills the disk days later. Alert on `pg_stat_archiver.failed_count` increasing and on `last_archived_time` age.
- **Using `synchronous_commit = off` globally to "fix" slow commits.** It fixes the symptom for all data, including data that must not be lost. Fix batching and storage first; relax durability per transaction for low-value writes.
- **Best practice:** keep defaults for safety (`fsync`, `full_page_writes`, `synchronous_commit = on`), tune checkpoints for volume, enable `wal_compression`, choose append-friendly keys, and measure WAL per statement with `pg_stat_statements`.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**The disk fills with WAL at 3 a.m.** Symptom: `PANIC: could not write to file "pg_wal/xlogtemp.1234": No space left on device`; the primary shuts down. Root cause, in rough order of frequency: a failing `archive_command` (check `pg_stat_archiver`), an inactive replication slot retaining WAL (check `pg_replication_slots.wal_status` and `restart_lsn`; see [Ch 09 · Replication](topic.html?p=09-replication)), or a huge `wal_keep_size`. Fix: free space safely (grow the volume), fix or drop the retention cause, restart. Prevent with `max_slot_wal_keep_size`, archive alerts, and a disk alert well before 100%.

**Periodic latency spikes every five minutes.** Symptom: p99 write latency jumps at regular intervals. Root cause: checkpoints writing a burst of dirty pages, saturating I/O and slowing WAL fsyncs; or the post-checkpoint surge of full-page images. Fix: raise `checkpoint_completion_target` (default 0.9 is usually right), increase `max_wal_size`/`checkpoint_timeout`, check storage IOPS headroom, and look at `write_time`/`sync_time` in `pg_stat_checkpointer`.

**Commit latency doubles after a cloud migration.** Symptom: same workload, TPS down, CPU idle. Root cause: network block storage with ~1 ms+ fsync versus local NVMe. Fix: provisioned-IOPS or local-NVMe instance classes for WAL, larger transactions/batching, more concurrency for group commit, and `synchronous_commit = off` for non-critical writes.

**Replica lag after a bulk job.** Symptom: an `UPDATE` of 200 million rows produces hundreds of GB of WAL; replicas and CDC fall hours behind. Root cause: WAL volume exceeds replication/apply bandwidth. Fix: batch the job with pauses, throttle by watching `pg_stat_replication.replay_lag`, and prefer rewriting via a new table when touching most rows.

**MySQL replica diverges after an OS crash.** Symptom: a replica has transactions the recovered source does not, or vice versa. Root cause: `sync_binlog = 0` or `innodb_flush_log_at_trx_commit = 2` lost part of the binlog or redo, breaking the two-phase commit guarantee. Fix: `sync_binlog = 1` and `innodb_flush_log_at_trx_commit = 1` for any source whose replicas must stay consistent; rebuild the replica.

### Metrics to watch

- **WAL generation rate** (bytes/s from `pg_stat_wal.wal_bytes` deltas or `pg_current_wal_lsn()` deltas) and **FPI share** (`wal_fpi / wal_records`).
- **`pg_wal` directory size** and free disk on the WAL volume.
- **Checkpoints**: `num_requested` vs `num_timed`, `write_time`, `sync_time` (`pg_stat_checkpointer` in PG 17, `pg_stat_bgwriter` before).
- **Archiver**: `pg_stat_archiver.failed_count`, `last_failed_wal`, age of `last_archived_time`.
- **Commit latency** from the application and `pg_stat_statements` for `COMMIT`; `wal_sync_time` in `pg_stat_wal` when `track_wal_io_timing = on` (PG 14–17).
- **Wait events**: `WALWrite`, `WALSync`, `WALInsert` lock contention in `pg_stat_activity`.
- **MySQL**: `Innodb_os_log_written`, `Innodb_log_waits` (redo log buffer too small), binlog size growth.

### Scaling notes

A single PostgreSQL primary funnels every write through one WAL stream. At very high write rates, WAL insertion (`WALInsert` locks), fsync latency and WAL bandwidth to replicas become the ceiling before CPU does. The levers, in order: reduce WAL per write (keys, indexes, FPIs, compression), batch commits, faster WAL storage, then split write load — partitioning helps maintenance but not WAL, so ultimately [Ch 12 · Sharding](topic.html?p=12-sharding) gives each shard its own log.

## 9. Interview Questions

**Q: What is the write-ahead rule, and why is it necessary?**
A: A data page may only be written to disk after the WAL records describing its changes are durable. It is necessary because after a crash, recovery can only reason about changes that are in the log. If a page with a change reached disk but the log record did not, recovery could not tell whether that change belonged to a committed transaction, so a half-finished transaction could survive. Enforcing it is cheap: each page stores the LSN of its last change, and the buffer manager flushes WAL up to that LSN before writing the page.

**Q: Walk me through exactly what PostgreSQL does between receiving COMMIT and replying to the client.**
A: The backend appends a commit record for its xid to the WAL buffers, then flushes WAL up to that record's LSN — a write plus fdatasync, possibly satisfied by another backend's flush through group commit. It then marks the xid committed in pg_xact. If synchronous replication is configured, it waits for standby confirmation at the configured level. Then it removes itself from the ProcArray so new snapshots see it as committed, releases its locks, and replies. The data pages it changed are still only dirty in shared buffers and will be written by the background writer or checkpointer later.

**Q: Why does PostgreSQL not need an undo log for crash recovery?**
A: Because it never overwrites data in place. An update creates a new tuple version stamped with the writer's xid, and visibility depends on whether that xid is marked committed in pg_xact. If a crash happens before the commit record is durable, the xid is never marked committed, so its tuples are invisible to everyone and vacuum eventually removes them. Old versions are still sitting in the heap, so there is nothing to restore. Recovery therefore only needs to redo WAL; InnoDB, which updates in place and keeps old versions in undo logs, must redo and then roll back uncommitted transactions.

**Q: What are full-page writes, and why do they inflate WAL right after a checkpoint?**
A: An 8 KB page can be torn by a crash because the disk writes smaller units atomically. A small delta record cannot be safely replayed onto a torn page, so the first modification of each page after a checkpoint logs the entire page image; recovery restores that image and then applies later deltas. Immediately after a checkpoint, almost every page touched is a first touch, so records balloon from about a hundred bytes to about 8 KB. As the interval goes on, pages have already been imaged and WAL volume falls. Longer checkpoint intervals and `wal_compression` reduce the cost.

**Q: What does group commit do, and why does throughput rise with more concurrent clients?**
A: A flush writes and syncs WAL up to the latest inserted position, not just up to one transaction's commit record. When several backends are committing at once, one of them performs the fsync and it covers all commit records already in the buffer; the others wake up, see their LSN is flushed, and return without their own fsync. So one fsync pays for many commits. A single client is limited to about one commit per fsync latency; 32 clients share each fsync and achieve much higher total throughput with similar per-commit latency.

**Q: What exactly do you risk with `synchronous_commit = off`?**
A: A commit returns before its WAL is flushed; the WAL writer flushes in the background every `wal_writer_delay` (200 ms by default). If the server crashes, transactions committed in roughly the last three writer cycles can be lost — they are gone as if they never happened. The database remains consistent, because the WAL that did reach disk is replayed in order and the lost transactions' xids are never marked committed. That makes it a legitimate per-transaction choice for low-value data, very different from `fsync = off`, which can corrupt the whole cluster.

**Q: Your PostgreSQL primary's disk filled up with WAL. What are the likely causes, and how do you fix it safely? (Senior)**
A: WAL is kept beyond the last checkpoint for three reasons: archiving not yet done, replication slots whose consumers have not confirmed it, and `wal_keep_size`. I check `pg_stat_archiver` for failures, `pg_replication_slots` for inactive slots with an old `restart_lsn`, and the setting. I never delete files from `pg_wal` by hand. I add disk space first so the server can run, then fix the archive target or drop the abandoned slot, after which checkpoints recycle the old segments. To prevent a repeat I set `max_slot_wal_keep_size`, alert on archive failures and slot lag, and alert on disk usage long before it is full.

**Q: Explain MySQL's internal two-phase commit between InnoDB and the binlog. Why does it exist? (Senior)**
A: MySQL has two logs: the InnoDB redo log for crash recovery and the server-level binlog for replication and PITR. A transaction must be in both or in neither, otherwise the source and its replicas diverge. So commit is a two-phase protocol: InnoDB writes and flushes a prepare record in the redo log, the server writes and fsyncs the transaction to the binlog, then InnoDB marks it committed. On recovery, any transaction left in PREPARED state is committed if its XID is in the binlog and rolled back if not, making the binlog the arbiter. This only holds if both logs are actually flushed, which is why `sync_binlog = 1` and `innodb_flush_log_at_trx_commit = 1` go together.

**Q: A write-heavy service generates 60 MB/s of WAL. How do you find out why and reduce it? (Senior)**
A: I measure first. `pg_stat_wal` gives total records, full-page images and bytes, so I can see what share comes from FPIs. `pg_stat_checkpointer` tells me whether checkpoints are requested by volume far more often than timed. `pg_stat_statements` WAL columns show which statements produce the bytes. Typical culprits are frequent checkpoints (fix with `max_wal_size` and `checkpoint_timeout`), random-key B-tree inserts touching a new page per row (fix with time-ordered keys), non-HOT updates across many indexes (drop unused indexes, leave fillfactor room for HOT), and uncompressed FPIs (`wal_compression = lz4`). I balance the checkpoint change against the longer crash recovery it implies.

**Q: How does InnoDB protect against torn pages if it does not log full-page images?**
A: With the doublewrite buffer. Before flushing dirty pages to their real locations, InnoDB writes them sequentially into a doublewrite area and syncs that. If a crash tears a page during the in-place write, recovery finds an intact copy in the doublewrite area, restores it, and then applies redo. The cost is writing each flushed page twice, instead of PostgreSQL's cost of bigger WAL after checkpoints. On storage that guarantees atomic 16 KB writes, it can be disabled.

**Q: How do checkpoints bound recovery time, and what is the trade-off in tuning them?**
A: A checkpoint guarantees that every change before its redo point is in the data files, so recovery only has to replay WAL from the last redo point forward. Frequent checkpoints mean less WAL to replay and faster recovery, but more checkpoint I/O and many more full-page images, which increases WAL volume, replication traffic and archive size. Infrequent checkpoints do the opposite. You size `checkpoint_timeout` and `max_wal_size` so checkpoints are mostly time-driven and the worst-case replay fits your recovery time objective.

**Q: Why is a one-row-per-transaction bulk load so much slower than batching, even on a fast machine?**
A: Each transaction ends with a commit that must wait for a WAL fsync, so a single-threaded loader is capped at roughly one commit per fsync latency — perhaps a few hundred to a few thousand per second on cloud disks — no matter how fast the CPU is. Batching thousands of rows per transaction pays that fsync once per batch. `COPY` goes further by cutting per-row protocol and parsing overhead. Batches should still be bounded so a single transaction does not hold locks and snapshots for too long.

## 10. Quick Revision & Cheat Sheet

| Concept | One-liner | Knob / view |
|---|---|---|
| WAL rule | log before page | page LSN, `XLogFlush` |
| Commit | commit record + WAL flush | `synchronous_commit` |
| LSN | byte position in WAL | `pg_current_wal_lsn()`, `pg_wal_lsn_diff()` |
| Group commit | one fsync covers many commits | `commit_delay`, `commit_siblings` |
| Checkpoint | dirty pages written; recovery starts at redo point | `checkpoint_timeout` 5min, `max_wal_size` 1GB |
| Full-page write | first change after checkpoint logs 8 KB image | `full_page_writes`, `wal_compression` |
| Undo | PG: none (visibility via pg_xact); InnoDB: undo logs | — |
| Archiving | segments shipped for PITR | `archive_mode`, `archive_command`, `pg_stat_archiver` |
| WAL stats | volume, FPIs, buffer pressure | `pg_stat_wal`, `pg_stat_statements.wal_bytes` |
| MySQL durability | redo + binlog via internal 2PC | `innodb_flush_log_at_trx_commit=1`, `sync_binlog=1` |

- Commit latency ≈ WAL fsync latency; storage choice sets your commit floor.
- The commit record is the durability point; data pages follow lazily.
- PostgreSQL recovery is redo-only; InnoDB is redo then undo.
- Full-page images are the usual biggest WAL cost; fewer checkpoints means fewer images but longer recovery.
- `synchronous_commit = off` loses recent commits but never corrupts; `fsync = off` can corrupt.
- Never delete from `pg_wal`; fix archiving or slots instead.
- Random UUID keys and non-HOT updates multiply WAL.
- MySQL needs both `innodb_flush_log_at_trx_commit=1` and `sync_binlog=1` for full safety.

## 11. Hands-On Exercises

Lab: `docker run --rm --name wal -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17`.

1. **WAL per statement.** Using `pg_current_wal_lsn()` before and after, measure WAL for inserting 100k rows with a `bigint` identity key vs a `gen_random_uuid()` key, each run right after `CHECKPOINT`. Explain the difference in terms of full-page images.
2. **Read the log.** Use `pg_waldump` on the segment from exercise 1 and find: a record with `FPW`, a Btree record, and the Transaction COMMIT record. Note the LSNs and sizes.
3. **Durability dial.** Run `pgbench -N` single-client with `synchronous_commit` on and off, then with 32 clients on. Record TPS and explain each change using fsync and group commit.
4. **Checkpoint pressure.** Set `max_wal_size = 64MB`, run a heavy pgbench load, and watch `pg_stat_checkpointer.num_requested` and the server log for "checkpoints are occurring too frequently". Raise it to 4 GB and compare WAL bytes per transaction from `pg_stat_wal`.
5. **Archive failure drill.** Enable `archive_mode = on` with `archive_command = 'false'`, restart, generate WAL, and watch `pg_wal` grow and `pg_stat_archiver.failed_count` rise. Fix the command to copy into a directory and watch the backlog drain.
6. **fsync honesty.** Run `pg_test_fsync` on your laptop disk and on a cloud VM volume; compare `fdatasync` ops/s and relate it to single-client TPS from exercise 3.

### Mini project — "WAL budget report"

Write a script that samples `pg_stat_wal`, `pg_stat_checkpointer`, `pg_stat_archiver` and `pg_stat_statements` every minute and produces a report: WAL MB/s, FPI share, checkpoints timed vs requested, top five statements by WAL bytes, archive backlog, and a projected daily archive size. Run it against a pgbench workload before and after tuning `max_wal_size`, `checkpoint_timeout` and `wal_compression`, and write up the trade-off you chose against a stated recovery-time target.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 01 · Database Architecture](topic.html?p=01-database-architecture) · [Ch 02 · Storage Internals](topic.html?p=02-storage-internals) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (why no undo) · [Ch 08 · Crash Recovery](topic.html?p=08-crash-recovery) (replaying this log) · [Ch 09 · Replication](topic.html?p=09-replication) (shipping this log) · [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery) (archiving and PITR) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) (CDC reads this log).

**SQL Handbook:** [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [Locking, MVCC & Deadlocks](../sql/topic.html?p=27-locking-mvcc).

**Other handbooks:** [Caching with Redis · Persistence: RDB & AOF](../redis-caching/topic.html?p=24-persistence-rdb-aof) (the same fsync trade-off in Redis) · [Kafka & RabbitMQ · The Log, Offsets & Retention](../messaging/topic.html?p=14-the-log-offsets-retention) · [Cassandra · Write Path](../cassandra/topic.html?p=21-write-path) (commit log + memtable).

- **Reliability and the Write-Ahead Log** — PostgreSQL docs · *Intermediate* · the official chapter on WAL, asynchronous commit, checkpoints and WAL internals. <https://www.postgresql.org/docs/current/wal.html>
- **WAL Configuration** — PostgreSQL docs · *Intermediate* · how checkpoints, `max_wal_size` and `commit_delay` interact. <https://www.postgresql.org/docs/current/wal-configuration.html>
- **Asynchronous Commit** — PostgreSQL docs · *Intermediate* · the precise risk window of `synchronous_commit = off`. <https://www.postgresql.org/docs/current/wal-async-commit.html>
- **The Internals of PostgreSQL, ch. 9 (WAL)** — Hironobu Suzuki · *Advanced* · diagrams of XLOG records, LSNs, checkpoints and replay. <https://www.interdb.jp/pg/pgsql09.html>
- **pg_waldump** — PostgreSQL docs · *Intermediate* · reading WAL records yourself. <https://www.postgresql.org/docs/current/pgwaldump.html>
- **InnoDB Redo Log** — MySQL Reference Manual · *Intermediate* · redo log capacity, flushing and group commit. <https://dev.mysql.com/doc/refman/8.0/en/innodb-redo-log.html>
- **ARIES: A Transaction Recovery Method** — Mohan et al., ACM TODS 1992 · *Advanced* · the foundational WAL/recovery paper behind steal/no-force. <https://dl.acm.org/doi/10.1145/128765.128770>
- **Designing Data-Intensive Applications, ch. 3 & 7** — Martin Kleppmann · *Intermediate* · logs as the backbone of storage engines and durability. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 07.*
