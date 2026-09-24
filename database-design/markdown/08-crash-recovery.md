# 08 · Crash Recovery: Redo, Undo & Proving It Works

> **In one line:** When a database crashes it does not "check the disk and hope" — it rebuilds a correct state by replaying the write-ahead log from the last checkpoint and discarding (PostgreSQL) or rolling back (InnoDB) every transaction that never committed; your job is to know which crash windows lose what, how long recovery will take, how to detect corruption that replay cannot fix, and to prove all of it with drills before production proves it for you.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Transactions & ACID](../sql/topic.html?p=25-transactions-acid) (atomicity and durability as promises) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (the WAL rule, commit records, checkpoints and full-page writes — read it first; this chapter does not re-explain them) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (why uncommitted tuples are invisible). This chapter is about what happens *after* the power goes out.

At 02:14 the hypervisor under your primary database reboots. The PostgreSQL process did not shut down; it simply stopped existing mid-instruction. At that instant there were 40 transactions in flight: some had inserted rows into pages in memory, a few had written parts of their changes to the data files because the background writer evicted those pages, one was halfway through writing its commit record, and the checkpointer was in the middle of flushing 2 GB of dirty pages. Some 8 KB pages on disk are half old, half new. When the machine comes back, what does the database do, and what does your application see?

The **naive idea** — scan the data files, find inconsistent pages and repair them — cannot work. The data files do not contain enough information to know which changes belonged to committed transactions, and a half-written page is not self-describing. Nor can the database just "use what is on disk": that would expose partial transactions and lose committed ones whose pages were never written. The only thing that can restore a correct state is the log, which was written *ahead* of every page and forced at every commit.

So recovery is a deterministic algorithm over the WAL: find where to start (the last checkpoint's redo point), **redo** history forward to the end of the durable log, and then make sure no uncommitted work is visible — by **undo** in InnoDB and in the classic ARIES algorithm, or simply by visibility rules in PostgreSQL. This chapter walks through that algorithm, through each crash window (during `INSERT`, during `UPDATE`, during `COMMIT` before and after the flush), through what bounds recovery time, and through the failures that replay *cannot* fix — silent corruption, lying storage, and the lesson of fsyncgate.

> **Why this matters:** Durability is a claim until you have killed the database under load and verified the result. Teams that never run crash drills discover their storage lies about fsync, their recovery takes 40 minutes, or their clients double-submit after an ambiguous commit — during a real incident.

## 2. Core Concepts

- **Crash (instance) failure** — the process or OS dies; memory is lost, disks survive. *Why it matters:* this is what WAL-based crash recovery handles automatically.
- **Media failure** — the disk itself is lost or corrupted. *Why it matters:* crash recovery cannot help; you need replicas or backups ([Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery)).
- **pg_control** — a small file recording cluster state and the location of the latest checkpoint record. *Why it matters:* it is where recovery starts; `pg_controldata` shows it.
- **Redo point** — the WAL position from which the latest completed checkpoint guarantees all earlier changes are in the data files. *Why it matters:* recovery replays from here; everything before is ignored.
- **Redo (repeat history)** — re-applying logged changes to pages whose page LSN shows they are missing. *Why it matters:* it restores committed work that never reached the data files, and makes replay idempotent.
- **Undo** — reversing changes by transactions that did not commit. *Why it matters:* needed when an engine overwrites in place (InnoDB); unnecessary in PostgreSQL.
- **ARIES** — the classic recovery algorithm: Analysis, Redo, Undo, with compensation log records. *Why it matters:* it is the reference model interviewers and textbooks use.
- **Compensation log record (CLR)** — a log record written while undoing, so that undo itself is never undone twice after a crash during recovery. *Why it matters:* recovery must survive crashing during recovery.
- **Torn page** — a page partially written when the power failed. *Why it matters:* delta records cannot be replayed onto it; full-page images (PostgreSQL) or the doublewrite buffer (InnoDB) repair it.
- **Ambiguous commit** — the client sent `COMMIT` and lost the connection before the reply. *Why it matters:* the transaction may or may not be durable; only the application can resolve it, via idempotency.
- **Data checksums** — a per-page checksum verified on read. *Why it matters:* they detect corruption that WAL replay would never notice.
- **fsyncgate** — the 2018 discovery that on Linux a failed `fsync` could be retried and "succeed" after dirty data had already been dropped. *Why it matters:* PostgreSQL now PANICs on fsync failure and relies on WAL replay instead of retrying.

## 3. Theory & Principles

### ARIES: analysis, redo, undo

ARIES (Mohan et al., 1992) is the recovery design most engines descend from. It assumes steal + no-force buffer management (see [Ch 07](topic.html?p=07-write-ahead-logging)), so both committed changes may be missing from disk and uncommitted changes may be present. It recovers in three passes:

1. **Analysis.** Start from the last checkpoint record, which lists the transactions active at the time and the dirty pages with their `recLSN` (the LSN of the first change that dirtied them). Scan forward to the end of the log, updating both tables. At the end you know the **losers** (transactions with no commit or abort record) and the earliest LSN any redo could be needed from.
2. **Redo — repeat history.** Scan forward from the smallest `recLSN`, and for every record whose page LSN on disk is older than the record, apply it — *including records of loser transactions*. The rule is to reconstruct the exact state at the moment of the crash, not a "clean" state. Comparing page LSNs makes redo idempotent: crashing during redo and restarting just re-skips what was already applied.
3. **Undo.** Walk the losers' records backwards and reverse them, writing a **CLR** for each reversal. If the system crashes during undo, the next recovery redoes the CLRs and continues undo where it left off, never undoing the same thing twice.

InnoDB follows this shape: it applies the redo log (reconstructing both data pages and undo log pages), then rolls back incomplete transactions using their undo records. Transactions that were in the PREPARED state of MySQL's internal two-phase commit are resolved against the binlog: committed if their XID made it to the binlog, rolled back if not.

### PostgreSQL: redo-only recovery

PostgreSQL has the analysis step (reading `pg_control` and the checkpoint record) and the redo step, but **no undo pass**. Because updates create new tuple versions instead of overwriting old ones, and because visibility is decided by the transaction status in `pg_xact`, a loser transaction's tuples are harmless: its xid was never marked committed, so at the end of recovery it is treated as aborted and its tuples are invisible to every snapshot. Vacuum eventually removes them, exactly as it removes the tuples of any rolled-back transaction. This is why PostgreSQL crash recovery time depends only on how much WAL must be replayed, while InnoDB's also depends on how much uncommitted work must be rolled back (InnoDB does this rollback in the background after accepting connections, but the rows stay locked until it finishes).

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c08a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c08a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c08a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Recovery over the WAL: ARIES passes vs PostgreSQL</text>
  <rect x="40" y="50" width="800" height="36" rx="4" fill="#f8fafc" stroke="#94a3b8"/>
  <rect x="120" y="50" width="4" height="36" fill="#7c3aed"/>
  <text x="122" y="104" text-anchor="middle" fill="#5b21b6" font-size="10">redo point</text>
  <rect x="330" y="50" width="4" height="36" fill="#7c3aed"/>
  <text x="332" y="104" text-anchor="middle" fill="#5b21b6" font-size="10">checkpoint record</text>
  <rect x="826" y="50" width="4" height="36" fill="#dc2626"/>
  <text x="828" y="104" text-anchor="middle" fill="#7f1d1d" font-size="10">crash</text>
  <text x="60" y="73" fill="#334155" font-size="10">older WAL</text>
  <rect x="160" y="58" width="60" height="20" rx="3" fill="#dcfce7" stroke="#16a34a"/><text x="190" y="72" text-anchor="middle" fill="#14532d" font-size="9">T1 ins</text>
  <rect x="240" y="58" width="60" height="20" rx="3" fill="#fef3c7" stroke="#d97706"/><text x="270" y="72" text-anchor="middle" fill="#334155" font-size="9">T2 upd</text>
  <rect x="380" y="58" width="70" height="20" rx="3" fill="#dcfce7" stroke="#16a34a"/><text x="415" y="72" text-anchor="middle" fill="#14532d" font-size="9">T1 COMMIT</text>
  <rect x="480" y="58" width="60" height="20" rx="3" fill="#fef3c7" stroke="#d97706"/><text x="510" y="72" text-anchor="middle" fill="#334155" font-size="9">T2 upd</text>
  <rect x="570" y="58" width="60" height="20" rx="3" fill="#dbeafe" stroke="#2563eb"/><text x="600" y="72" text-anchor="middle" fill="#334155" font-size="9">T3 ins</text>
  <rect x="660" y="58" width="70" height="20" rx="3" fill="#dcfce7" stroke="#16a34a"/><text x="695" y="72" text-anchor="middle" fill="#14532d" font-size="9">T3 COMMIT</text>
  <text x="780" y="73" text-anchor="middle" fill="#334155" font-size="9">end of WAL</text>
  <rect x="20" y="118" width="840" height="150" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="36" y="138" fill="#5b21b6" font-size="12" font-weight="bold">ARIES / InnoDB</text>
  <path d="M334,158 L820,158" stroke="#7c3aed" stroke-width="2" marker-end="url(#c08a3)"/>
  <text x="340" y="176" fill="#334155" font-size="10">1. Analysis: from checkpoint to end; winners T1, T3; loser T2; dirty pages + recLSNs</text>
  <path d="M124,196 L820,196" stroke="#2563eb" stroke-width="2" marker-end="url(#c08a1)"/>
  <text x="130" y="214" fill="#334155" font-size="10">2. Redo: repeat history from min recLSN for ALL txns (incl. T2) where pageLSN &lt; recordLSN</text>
  <path d="M820,234 L250,234" stroke="#dc2626" stroke-width="2" marker-end="url(#c08a2)"/>
  <text x="300" y="256" fill="#334155" font-size="10">3. Undo: roll back loser T2 backwards, writing CLRs so a crash during undo is safe</text>
  <rect x="20" y="280" width="840" height="148" rx="10" fill="#dbeafe" stroke="#2563eb"/>
  <text x="36" y="300" fill="#1e40af" font-size="12" font-weight="bold">PostgreSQL</text>
  <text x="36" y="322" fill="#334155" font-size="10">Read pg_control, locate checkpoint record, jump to its redo point.</text>
  <path d="M124,340 L820,340" stroke="#2563eb" stroke-width="2" marker-end="url(#c08a1)"/>
  <text x="130" y="358" fill="#334155" font-size="10">Redo from redo point until a record fails its CRC or length check (the end of valid WAL). FPIs restore torn pages.</text>
  <text x="36" y="384" fill="#334155" font-size="10">No undo pass: T2's xid never got a commit record, so pg_xact never marks it committed; its tuple versions are invisible.</text>
  <text x="36" y="402" fill="#334155" font-size="10">End-of-recovery checkpoint, then accept connections. Vacuum later removes T2's dead tuples like any rolled-back txn.</text>
  <text x="36" y="420" fill="#1e40af" font-size="10" font-weight="bold">Recovery time is proportional to WAL since the redo point, not to the amount of uncommitted work.</text>
</svg>
```

### Walking the crash windows

The cleanest way to understand recovery is to crash at every interesting moment and ask what the database — and the client — sees afterwards. Assume PostgreSQL, `synchronous_commit = on`.

**Crash during an INSERT (before COMMIT).** The new tuple may exist only in shared buffers (lost with memory), or its page may have been evicted to disk (steal) — in which case the WAL record for it was flushed first, by the WAL rule. Either way, there is no commit record. After redo, the tuple may physically exist on the page, stamped with an `xmin` that is not committed, so no snapshot sees it; index entries pointing at it are skipped and later cleaned. The client never got a reply to `COMMIT` because it never sent one; its connection simply broke. **Outcome: nothing happened.** In InnoDB, the redo pass may reconstruct the inserted record, and the undo pass deletes it.

**Crash during an UPDATE (before COMMIT).** In PostgreSQL the old tuple version is untouched except that its `xmax` was set to the updater's xid; the new version sits elsewhere. After recovery, `xmax` refers to a non-committed xid, so the old version is still the visible one — the update simply never happened. If the page was being written when power failed, it may be **torn**; because this page was modified since the last checkpoint, the WAL contains a full-page image from its first modification, and redo overwrites the torn page with that image before applying later deltas. In InnoDB the row was changed in place, with the old version in undo; redo rebuilds the page (doublewrite repairs a torn copy first) and undo restores the old values.

**Crash during COMMIT, before the WAL flush completes.** The commit record is in WAL buffers (or partially written), but not durable. Recovery replays until the last valid record — a partially written commit record fails its CRC check and is treated as the end of WAL — so the transaction has no durable commit. **Outcome: the transaction is lost.** The client sent `COMMIT` and got a broken connection: it does not know the outcome.

**Crash during COMMIT, after the WAL flush but before the reply.** The commit record is durable. Recovery replays it, the xid is marked committed, and the data is there. **Outcome: committed.** But the client saw the *same* broken connection as in the previous case. This is the **ambiguous commit**: from the client's side, the two cases are indistinguishable.

**Crash after the reply.** Committed and acknowledged; recovery guarantees the change exists even if not one of its data pages was written to the data files.

**With `synchronous_commit = off`.** The reply can precede the flush. A crash in that window loses a transaction the client was told had committed. The database is still consistent — just missing the last fraction of a second.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c08b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Crash windows around COMMIT: what survives, what the client knows</text>
  <line x1="40" y1="70" x2="850" y2="70" stroke="#334155" stroke-width="1.5" marker-end="url(#c08b1)"/>
  <rect x="50" y="52" width="130" height="36" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="115" y="74" text-anchor="middle" fill="#1e293b">INSERT / UPDATE</text>
  <rect x="200" y="52" width="140" height="36" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="270" y="74" text-anchor="middle" fill="#1e293b">commit record buffered</text>
  <rect x="360" y="52" width="150" height="36" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="435" y="74" text-anchor="middle" fill="#1e293b">WAL fsync completes</text>
  <rect x="530" y="52" width="140" height="36" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="600" y="74" text-anchor="middle" fill="#1e293b">reply "COMMIT"</text>
  <rect x="690" y="52" width="150" height="36" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="765" y="74" text-anchor="middle" fill="#1e293b">pages written later</text>
  <rect x="40" y="110" width="200" height="120" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="140" y="130" text-anchor="middle" fill="#7f1d1d" font-weight="bold">Crash A: mid-statement</text>
  <text x="54" y="150" fill="#334155" font-size="10">DB: txn never committed,</text>
  <text x="54" y="166" fill="#334155" font-size="10">tuples invisible (PG) or</text>
  <text x="54" y="182" fill="#334155" font-size="10">undone (InnoDB)</text>
  <text x="54" y="206" fill="#334155" font-size="10">Client: error, knows it</text>
  <text x="54" y="222" fill="#334155" font-size="10">never asked to commit</text>
  <rect x="250" y="110" width="200" height="120" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="350" y="130" text-anchor="middle" fill="#7f1d1d" font-weight="bold">Crash B: before flush</text>
  <text x="264" y="150" fill="#334155" font-size="10">DB: commit record not</text>
  <text x="264" y="166" fill="#334155" font-size="10">durable (torn record fails</text>
  <text x="264" y="182" fill="#334155" font-size="10">CRC) &#8594; txn LOST</text>
  <text x="264" y="206" fill="#7f1d1d" font-size="10" font-weight="bold">Client: connection broken</text>
  <text x="264" y="222" fill="#7f1d1d" font-size="10" font-weight="bold">outcome UNKNOWN</text>
  <rect x="460" y="110" width="200" height="120" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="560" y="130" text-anchor="middle" fill="#7f1d1d" font-weight="bold">Crash C: after flush</text>
  <text x="474" y="150" fill="#334155" font-size="10">DB: commit record durable,</text>
  <text x="474" y="166" fill="#334155" font-size="10">redo replays it &#8594; txn</text>
  <text x="474" y="182" fill="#334155" font-size="10">COMMITTED</text>
  <text x="474" y="206" fill="#7f1d1d" font-size="10" font-weight="bold">Client: connection broken</text>
  <text x="474" y="222" fill="#7f1d1d" font-size="10" font-weight="bold">outcome UNKNOWN</text>
  <rect x="670" y="110" width="190" height="120" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="765" y="130" text-anchor="middle" fill="#14532d" font-weight="bold">Crash D: after reply</text>
  <text x="684" y="150" fill="#334155" font-size="10">DB: committed; redo</text>
  <text x="684" y="166" fill="#334155" font-size="10">rebuilds pages that never</text>
  <text x="684" y="182" fill="#334155" font-size="10">reached the data files</text>
  <text x="684" y="206" fill="#14532d" font-size="10" font-weight="bold">Client: knows it</text>
  <text x="684" y="222" fill="#14532d" font-size="10" font-weight="bold">committed</text>
  <rect x="40" y="248" width="820" height="140" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="56" y="270" fill="#1e293b" font-size="12" font-weight="bold">B and C look identical to the client. The database is correct in both; the application must resolve the ambiguity.</text>
  <text x="56" y="294" fill="#334155" font-size="10">Pattern: every write carries a client-generated idempotency key stored in the same transaction (UNIQUE constraint).</text>
  <text x="56" y="314" fill="#334155" font-size="10">On reconnect, look the key up: present &#8594; it committed (case C), report success; absent &#8594; it did not (case B), safe to retry.</text>
  <text x="56" y="334" fill="#334155" font-size="10">Retrying blindly without a key turns case C into a duplicate order / double charge.</text>
  <text x="56" y="358" fill="#334155" font-size="10">With synchronous_commit = off, a crash between reply and background flush loses a commit the client was told about (D becomes B).</text>
  <text x="56" y="378" fill="#334155" font-size="10">With async replication and failover, the same loss can happen at the cluster level: see Ch 09.</text>
</svg>
```

### What bounds recovery time

PostgreSQL replays WAL from the redo point of the **last completed** checkpoint to the end of the log. The checkpoint in progress at crash time does not count. With checkpoints spread over `checkpoint_completion_target = 0.9` of the interval, the last *completed* checkpoint's redo point can be almost two intervals back in the worst case. So the replay volume is roughly bounded by up to ~2 × the WAL generated per checkpoint interval — which is limited by whichever of `checkpoint_timeout` and `max_wal_size` fires first.

Replay speed is the other factor. Recovery is performed by a **single startup process** applying records one by one; records that modify pages not in memory force random reads. Recovery prefetching (`recovery_prefetch`, PG 15+, default `try`) issues reads ahead of replay and helps a lot on high-latency storage. As a rough planning model: **RTO for crash recovery ≈ WAL to replay ÷ replay rate**, where replay rate is best measured by drill on your hardware, because it varies with record mix and cache hit rate. A system generating 50 MB/s with a 15-minute timeout could have tens of GB to replay; at a few hundred MB/s of replay, that is minutes, not seconds.

> **MySQL difference:** InnoDB's redo log capacity (`innodb_redo_log_capacity`) plays the role of `max_wal_size`: a bigger redo log means fewer forced flushes and a longer potential recovery. InnoDB also has to roll back the loser transactions; a crash during a 50-million-row `DELETE` means a long background rollback, during which those rows stay locked.

### Corruption: the failures replay cannot fix

WAL replay assumes the storage honoured its promises: that fsync meant durable, and that a page read back is the page written. When those assumptions break, recovery "succeeds" and produces wrong data. Three families matter:

- **Lying storage.** Disks or virtualisation layers that acknowledge writes from a volatile cache. Committed transactions vanish after power loss, or a data page older than the WAL says it should be is silently accepted. Only drills with real power loss (or cloud instance stop) and hardware with power-loss protection address this.
- **Bit rot and bad firmware.** A page is silently altered on disk. Without checksums, PostgreSQL reads it and returns garbage or crashes on it. **Data checksums** (enabled with `initdb --data-checksums`, or offline via `pg_checksums --enable`) verify every page on read and raise `invalid page in block N of relation …`; failures are counted in `pg_stat_database.checksum_failures` (PG 12+). Index/heap logical corruption (e.g. from a bug or collation change) is detected with the `amcheck` extension and `pg_amcheck` (PG 14+).
- **fsyncgate (2018).** PostgreSQL developers discovered that on Linux, when writeback of dirty pages failed, the kernel could report the error to one `fsync` call and then mark the pages clean; a retried `fsync` returned success although the data never reached disk. PostgreSQL's checkpointer used to retry — so a checkpoint could "complete", WAL before it be recycled, and the data be lost forever. The fix (PostgreSQL 12, back-patched to supported branches): treat an fsync failure as fatal — **PANIC**, and let crash recovery replay the WAL, which is still intact because the failed checkpoint never completed. The general lesson: **never trust a retry of a durability operation; fall back to the log.**

## 4. Architecture & Workflow

### The recovery timeline, as you will see it in the log

```text
LOG:  database system was interrupted; last known up at 2026-09-24 02:13:58 UTC
LOG:  database system was not properly shut down; automatic recovery in progress
LOG:  redo starts at 3A/1C0029F8
LOG:  invalid record length at 3A/5E91B2C0: expected at least 24, got 0
LOG:  redo done at 3A/5E91B288 system usage: CPU: user: 21.40 s, system: 6.12 s, elapsed: 48.71 s
LOG:  checkpoint starting: end-of-recovery immediate wait
LOG:  checkpoint complete: wrote 412893 buffers (39.4%); ... total=11.842 s
LOG:  database system is ready to accept connections
```

Read it like an incident timeline. The startup process read `pg_control`, found the last checkpoint, and started redo at its redo point `3A/1C0029F8`. It replayed until it hit a record of length zero — the end of valid WAL; the "invalid record length" message here is **normal**, not an error. About 1 GB (`0x5E91B2C0 − 0x1C0029F8`) was replayed in 49 s. Then PostgreSQL wrote an **end-of-recovery checkpoint** so that a second crash would not replay the same WAL again, and opened for connections. Total downtime: boot time + ~49 s replay + ~12 s checkpoint + application reconnect time.

### Step by step inside the startup process

1. **Read `pg_control`.** Determine the state (`in production` means it was not shut down cleanly) and the latest checkpoint location.
2. **Read the checkpoint record.** Get the redo point, the next xid, the next OID, and other state needed to resume.
3. **Replay loop.** For each record from the redo point: validate its CRC and length; for each block reference, read the page (prefetched if possible); if the record carries a full-page image, restore the image; otherwise, if the page's LSN is already ≥ the record LSN, skip; else apply the redo function for that resource manager and set the page LSN.
4. **Detect end of WAL.** The first record that fails validation (zeros, bad CRC, wrong previous-pointer) marks the end. Anything after it is garbage from a partial write.
5. **Finish.** Mark in-progress xids as aborted, perform the end-of-recovery checkpoint, set `pg_control` state to `in production`, and start accepting connections. Replicas in hot standby run this very same replay loop continuously — replication is recovery that never ends (see [Ch 09 · Replication](topic.html?p=09-replication)).

### Where checkpoints and recovery time trade off

| Checkpoint distance | WAL volume | Checkpoint I/O | Crash recovery time |
|---|---|---|---|
| Short (e.g. 1 min / small `max_wal_size`) | High (many full-page images) | Frequent bursts | Short |
| Default (5 min / 1 GB) | Moderate | Moderate | Usually well under a few minutes |
| Long (30 min / 64 GB) | Low | Smooth | Potentially many minutes |

The right setting is derived from your **RTO** for a crash restart and your measured replay rate — not from a blog post. If you have a hot standby with automatic failover, failover may be faster than crash recovery anyway, which changes the calculus ([Ch 18 · High Availability](topic.html?p=18-high-availability)).

## 5. Implementation

### Simple example: a kill -9 drill

Start PostgreSQL 17 with checksums and verbose checkpoint logging:

```text
$ docker run -d --name crash -e POSTGRES_PASSWORD=pw \
    -e POSTGRES_INITDB_ARGS="--data-checksums" postgres:17 \
    -c log_checkpoints=on -c checkpoint_timeout=5min
$ docker exec -it crash psql -U postgres -c "SHOW data_checksums;"
 data_checksums
----------------
 on
```

Create a workload whose correctness you can check — a ledger where the sum must always be zero:

```sql
CREATE TABLE ledger (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
                     txn uuid NOT NULL, account int NOT NULL, amount bigint NOT NULL);
-- Each transfer inserts two rows with amounts -x and +x in ONE transaction.
```

Drive it with `pgbench` using a custom script (`transfer.sql`):

```sql
\set a random(1, 1000)
\set b random(1, 1000)
\set x random(1, 500)
BEGIN;
INSERT INTO ledger(txn, account, amount)
SELECT u.t, v.acct, v.amt
FROM (SELECT gen_random_uuid() AS t) u,
     (VALUES (:a, -:x), (:b, :x)) AS v(acct, amt);
COMMIT;
```

```text
$ docker cp transfer.sql crash:/transfer.sql
$ docker exec crash pgbench -U postgres -n -c 16 -T 120 -f /transfer.sql postgres &
$ sleep 30; docker kill --signal=KILL crash      # SIGKILL the postmaster: no shutdown checkpoint
$ docker start crash; docker logs crash 2>&1 | grep -E "redo|ready|not properly"
```

Then verify the invariant and the physical structures:

```sql
SELECT sum(amount) AS must_be_zero, count(*) FILTER (WHERE amount > 0) AS credits,
       count(*) FILTER (WHERE amount < 0) AS debits FROM ledger;
```

```text
 must_be_zero | credits | debits
--------------+---------+--------
            0 |  412177 | 412177
```

```text
$ docker exec crash pg_amcheck -U postgres --heapallindexed --install-missing postgres
$ echo $?     # 0 = no corruption found
```

Every committed transfer has both legs; no in-flight transfer left one leg behind. That is atomicity and durability, *demonstrated* rather than assumed. (In the official image the postmaster is the container's PID 1, so `docker kill --signal=KILL` is the reliable way to SIGKILL it; on a VM, `kill -9` of the postmaster PID from `postmaster.pid` does the same. `pg_ctl stop -m immediate` also skips the shutdown checkpoint and forces crash recovery on the next start.)

### Simple example: see what recovery will start from

```text
$ docker exec crash pg_controldata /var/lib/postgresql/data | grep -E "state|checkpoint location|REDO location|Data page checksum"
Database cluster state:               in production
Latest checkpoint location:           0/9A3D1F8
Latest checkpoint's REDO location:    0/8F02118
Data page checksum version:           1
```

`pg_wal_lsn_diff(pg_current_wal_lsn(), '0/8F02118')` tells you how many bytes of WAL a crash right now would replay — a live "recovery debt" metric you can graph.

### Real-world example: a payment API and the ambiguous commit

A payments service writes a `payments` row and an outbox row per request. During a hypervisor failure, the database crashed while roughly 300 commits were in flight. Clients received connection errors. The mobile app retried every failed request. Result, before the fix: 41 duplicate charges — every retry of a request whose commit had actually been durable (crash window C) created a second payment.

The database did nothing wrong; recovery produced exactly the committed state. The bug was in the protocol. The fix is an **idempotency key** that is part of the same transaction:

```sql
CREATE TABLE payments (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  idempotency_key uuid   NOT NULL UNIQUE,   -- generated by the client once per logical request
  account_id      bigint NOT NULL,
  amount_cents    bigint NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
```

```python
import psycopg
from psycopg import errors

def create_payment(dsn: str, key: str, account: int, cents: int) -> int:
    """Safe to call any number of times with the same key, including after a crash."""
    for attempt in range(5):
        try:
            with psycopg.connect(dsn) as conn, conn.transaction():
                row = conn.execute(
                    """INSERT INTO payments (idempotency_key, account_id, amount_cents)
                       VALUES (%s, %s, %s)
                       ON CONFLICT (idempotency_key) DO NOTHING
                       RETURNING id""",
                    (key, account, cents)).fetchone()
                if row:                      # first time: we created it
                    return row[0]
                # Conflict: an earlier attempt already committed (crash window C). Return it.
                return conn.execute("SELECT id FROM payments WHERE idempotency_key = %s",
                                    (key,)).fetchone()[0]
        except (psycopg.OperationalError, errors.AdminShutdown):
            # Connection lost mid-COMMIT: outcome unknown (window B or C).
            # Retrying with the SAME key is safe: the UNIQUE constraint makes it idempotent.
            continue
    raise RuntimeError("database unavailable")
```

After deploying the key, the next drill (kill -9 during a load test with client retries) produced zero duplicates. The same pattern protects against the equivalent ambiguity during failover to an asynchronous replica. For the broader treatment see [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) and [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox).

### Detecting corruption on a schedule

```sql
-- Checksum failures seen by this cluster (PG 12+)
SELECT datname, checksum_failures, checksum_last_failure
FROM pg_stat_database WHERE checksum_failures > 0;

-- Logical corruption checks with amcheck (run on a replica or restored backup to avoid primary load)
CREATE EXTENSION IF NOT EXISTS amcheck;
SELECT bt_index_check(index => c.oid, heapallindexed => true), c.relname
FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_am am ON am.oid = c.relam
WHERE am.amname = 'btree' AND c.relpersistence = 'p'
LIMIT 50;
```

```text
ERROR:  invalid page in block 18231 of relation base/16384/24576
-- what a checksum failure looks like to a query; the relation is identified by its filenode
```

> **MySQL difference:** InnoDB always has page checksums (`innodb_checksum_algorithm`, default `crc32`). If InnoDB cannot start because of corruption, `innodb_force_recovery` (1 to 6) starts the server in progressively more dangerous modes — skipping undo, skipping redo — purely so you can dump data out. Values of 4 and above can permanently corrupt data files; treat them as a last resort before a rebuild from dump, never as a way to keep running.

## 6. Advantages, Disadvantages & Trade-offs

| Choice | Buys you | Costs you |
|---|---|---|
| Redo-only (PostgreSQL) | Instant rollback; recovery time independent of loser size | Dead tuples from aborted work need vacuum |
| Redo + undo (InnoDB, ARIES) | In-place updates, compact heap | Long rollbacks of big transactions; undo purge work |
| Full-page writes | Torn-page safety with no extra data-file writes | WAL volume spikes after checkpoints |
| Doublewrite buffer (InnoDB) | Torn-page safety with compact redo | Every flushed page written twice |
| Data checksums | Detect silent corruption on read | Small CPU cost; hint-bit changes can cause extra WAL |
| Frequent checkpoints | Short crash recovery | More I/O and WAL |
| PANIC on fsync failure | Never believe a false durable write | A storage hiccup becomes a restart + recovery |

### When to use (what)

- **Enable data checksums** on every new cluster unless you have measured an unacceptable cost; they are the only way PostgreSQL notices silent on-disk corruption.
- **Size checkpoints from your RTO**, verified by a timed drill.
- **Use idempotency keys** for every client-visible write whose duplication matters — they are the only resolution of ambiguous commits.
- **Run crash drills** whenever storage, instance type, PostgreSQL version or durability settings change.

### When NOT to

- **Do not rely on crash recovery as your HA strategy** when your availability target cannot absorb a reboot plus replay; that is what standbys and failover are for.
- **Do not use `zero_damaged_pages` or `innodb_force_recovery` to "keep running"**; they discard data to let you extract the rest.
- **Do not disable `full_page_writes`** unless the storage guarantees atomic 8 KB writes and you have tested it.

## 7. Common Mistakes & Best Practices

- **Treating "the database recovered" as "the data is correct".** Recovery trusts the storage. If the disk lied, recovery happily completes with lost commits. Instead, check business invariants (sums, counts, foreign keys) after every drill and on a schedule.
- **Retrying ambiguous commits blindly.** A client that re-sends a non-idempotent write after a connection error creates duplicates whenever the first commit was durable. Instead, use an idempotency key in the same transaction.
- **Never measuring recovery time.** Teams set `max_wal_size = 100GB` for write performance and discover a 30-minute recovery during an outage. Instead, time a drill at peak write rate and graph "WAL since last redo point".
- **Clusters without checksums.** Silent corruption surfaces months later as a crash on a specific query or a wrong result. Instead, create clusters with `--data-checksums` (or enable offline with `pg_checksums`), and alert on `checksum_failures`.
- **Deleting `postmaster.pid` or `pg_wal` files to "fix" a start-up failure.** Removing WAL makes consistent recovery impossible; `pg_resetwal` is a last-resort tool that knowingly loses data. Instead, find the real error in the log and restore from backup or a replica if the WAL is truly damaged.
- **Only testing clean shutdowns.** `systemctl restart` and `pg_ctl stop -m fast` never exercise recovery. Instead, use `kill -9`, `pg_ctl stop -m immediate`, and, for storage, a real instance stop or power cut.
- **Assuming cloud-managed means tested.** Managed services handle crash recovery, but your application's handling of ambiguous commits and reconnects is still yours to test.
- **Best practice:** keep safe defaults (`fsync`, `full_page_writes`, `synchronous_commit = on` for important data), enable checksums, run `pg_amcheck` against replicas or restored backups regularly, and put a kill-9 drill in your quarterly game-day runbook ([Ch 25 · Database Reliability Engineering](topic.html?p=25-database-reliability-engineering)).

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**Recovery takes 35 minutes.** At 03:00 the primary OOM-kills. Automatic failover is not configured. Symptom: the database logs `redo starts at …` and nothing else for half an hour. Root cause: `max_wal_size = 200GB` and `checkpoint_timeout = 1h` chosen to reduce WAL volume, on network storage with slow random reads during replay. Fix now: wait (interrupting recovery restarts it from the same redo point). Fix later: size checkpoint distance from the RTO, ensure `recovery_prefetch` is on (PG 15+), and add a hot standby with automated failover so a crash does not mean waiting for replay.

**"invalid page in block" after a host migration.** Symptom: a few queries fail with checksum errors on one table; `checksum_failures` > 0. Root cause: storage corruption during a live migration. Fix: do not keep writing to the damaged primary; fail over to a replica (physical replicas receive WAL, not pages, so they usually do not share the corruption), verify the replica with `pg_amcheck`, and rebuild the old primary from a fresh base backup. If no clean copy exists, restore from backup and use PITR to just before the damage.

**Committed orders vanish after a power event.** Symptom: customers have confirmation emails for orders the database does not contain. Root cause: storage with a volatile write cache and no power-loss protection acknowledged WAL fsyncs early. Fix: move to storage with power-loss protection or honest flush semantics; verify with `pg_test_fsync` (implausibly high fsync rates are a warning), and with a power-cut drill. Reconcile the missing orders from the outbox/email log.

**Duplicates after every database restart.** Symptom: each restart, deploy or failover leaves a few duplicate payments. Root cause: ambiguous-commit retries without idempotency keys. Fix: the idempotency-key pattern in §5, plus a unique constraint.

**InnoDB restart hangs on rollback.** Symptom: MySQL is up, but a table is locked and `SHOW ENGINE INNODB STATUS` shows a transaction "ROLLING BACK" with millions of undo entries. Root cause: a crash during a huge batch `DELETE`. Fix: wait (rollback continues in the background); prevent by batching large deletes into small transactions.

### What to monitor

- **Recovery debt:** WAL bytes since the last checkpoint's redo point (`pg_controldata` / `pg_control_checkpoint()` vs `pg_current_wal_lsn()`), graphed against your measured replay rate.
- **Checkpoint behaviour:** `pg_stat_checkpointer` (PG 17) — requested vs timed, write/sync times.
- **Corruption signals:** `pg_stat_database.checksum_failures`, log lines with `invalid page`, `could not read block`, `PANIC`; scheduled `pg_amcheck` results.
- **Storage errors:** kernel logs for I/O errors, cloud volume health events; any fsync-related `PANIC` means investigate the storage, not PostgreSQL.
- **Restart statistics:** time from process start to `ready to accept connections` for every restart, recorded as an SLI.
- **Application:** rate of connection errors during commit, and idempotency-key conflict rate (a spike after an incident means the pattern is doing its job).

### Scaling notes

Crash recovery time grows with write rate, not with database size — a 10 TB mostly-read database recovers faster than a 200 GB write-hot one. As write rates grow, the single-threaded replay becomes the limit, and the answer shifts from "tune checkpoints" to "fail over instead of recover": a synchronous or near-synchronous standby is already replayed up to date, so promotion takes seconds ([Ch 09 · Replication](topic.html?p=09-replication), [Ch 18 · High Availability](topic.html?p=18-high-availability)). Media failures and logical corruption scale with fleet size — at hundreds of clusters, automated `pg_amcheck` runs against restored backups become a necessity, and double as restore testing ([Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery)).

## 9. Interview Questions

**Q: What are the three passes of ARIES recovery, and why does redo "repeat history" including uncommitted transactions?**
A: Analysis scans from the last checkpoint to the end of the log to find which transactions were active (losers) and which pages may be dirty. Redo replays every logged change whose page LSN shows it is missing — including changes by losers — to rebuild the exact state at the crash. Undo then rolls back the losers, writing compensation log records. Repeating history first keeps the algorithm simple and uniform: pages end up in a known state that matches the log, and undo can then use ordinary logical rollback. It also makes it safe to crash during recovery, since both redo and CLR-based undo are idempotent.

**Q: Why does PostgreSQL crash recovery have no undo phase?**
A: Because PostgreSQL never overwrites a committed row version in place. An update or delete only creates a new version and sets `xmax` on the old one, and visibility is decided by whether the writing transaction is marked committed in pg_xact. A transaction that did not get its commit record into durable WAL is never marked committed, so after recovery its xid counts as aborted and all its changes are invisible. The old versions are still in the heap, so nothing needs to be restored; vacuum later removes the dead versions.

**Q: The database crashes while a client is executing COMMIT. What happened to the transaction?**
A: It depends on whether the commit record's WAL flush completed before the crash. If it did not, recovery ends at the last valid record, the transaction has no durable commit, and it is lost. If it did, recovery replays the commit and the transaction is durable, even though the client never received the reply. From the client's side both cases look the same — a broken connection — so the outcome is ambiguous. The application must resolve it, typically by writing an idempotency key in the transaction and checking or retrying with that key.

**Q: What is a torn page and how do PostgreSQL and InnoDB each deal with it?**
A: A torn page is a database page only partly written when power failed, because the page is larger than the unit the storage writes atomically. PostgreSQL logs a full-page image into WAL the first time each page is modified after a checkpoint; during recovery it overwrites the torn page with that image and replays later changes on top. InnoDB uses a doublewrite buffer: pages are written to a sequential doublewrite area and synced before being written in place, so a torn in-place page can be restored from the intact copy before redo runs.

**Q: What determines how long PostgreSQL crash recovery takes, and how would you estimate it?**
A: Recovery replays WAL from the redo point of the last completed checkpoint to the end of the log, in a single startup process. So time is roughly the WAL volume since that redo point divided by the replay rate. The volume is bounded by checkpoint distance (`checkpoint_timeout`, `max_wal_size`) and can reach about twice the per-checkpoint WAL, because the in-progress checkpoint does not count. Replay rate depends on storage latency, cache warmth and record mix, with `recovery_prefetch` helping. I would measure it with a kill -9 drill at peak write rate and graph WAL-since-redo-point as a live recovery-debt metric.

**Q: What was fsyncgate and what did PostgreSQL change?**
A: In 2018 it was found that on Linux, when background writeback failed, the error might be reported only once and the dirty pages marked clean, so a retried fsync could return success even though the data had never reached disk. PostgreSQL retried failed fsyncs during checkpoints, so a checkpoint could "succeed", allow older WAL to be recycled, and lose data permanently. The fix was to treat any fsync failure on data files as a PANIC, forcing crash recovery from WAL that is still intact because the checkpoint never completed. The lesson is to never trust a retried durability operation and to fall back to the log.

**Q: How would you design and run a crash-recovery drill for a production database? (Senior)**
A: I would run it on a production-like replica or staging cluster with the same storage type, instance class and configuration. Load it at peak write rate with a workload whose correctness is checkable — for example, balanced ledger transfers and idempotency-keyed payments with client retries. Then crash it the hard way: SIGKILL the postmaster, and separately stop the instance without shutdown to test the storage path. Afterwards I measure time to ready from the logs, verify invariants (ledger sums to zero, no duplicate keys, every acknowledged request present by comparing to a client-side log), run `pg_amcheck`, and check `checksum_failures`. I record replay rate and recovery time as numbers against the RTO, and I repeat the drill after any storage, version or durability-setting change.

**Q: A replica and the primary disagree after a crash. How can that happen, and how do you find out which is right? (Senior)**
A: Several ways. The primary may have lost acknowledged commits because its storage lied about fsync, while the replica had already received that WAL. With asynchronous replication, the primary may have committed transactions the replica never received before a failover. In MySQL, relaxed `sync_binlog` or `innodb_flush_log_at_trx_commit` can let the binlog and InnoDB disagree after an OS crash. To investigate I compare LSN or GTID positions, look for timeline divergence, and check business invariants and idempotency keys on both sides. The fix is usually to pick the node with the most complete durable history as the source of truth, rebuild the other (or `pg_rewind` it), and reconcile any lost acknowledged writes from upstream logs.

**Q: A query fails with "invalid page in block 18231 of relation base/16384/24576". What do you do? (Senior)**
A: That is a data-checksum failure: the page on disk does not match its checksum, so the storage or something below PostgreSQL altered it. First I stop the damage from spreading: I find which relation the filenode maps to, check `checksum_failures` for others, and look at kernel and cloud logs for I/O errors. Physical replicas receive WAL rather than pages, so they are usually clean; I verify one with `pg_amcheck` and fail over to it, then rebuild the old primary from a fresh base backup. If no clean copy exists, I restore from backup with PITR. Only as a last resort, to salvage the rest of a table, would I use `zero_damaged_pages` on a copy, knowing it discards the rows on that page.

**Q: Why is PostgreSQL rollback of a huge transaction instant, while InnoDB's can take hours?**
A: PostgreSQL rollback just marks the xid as aborted in pg_xact; its new tuple versions become invisible and the old ones stay visible, with vacuum cleaning up later. InnoDB modified rows in place and must apply undo records one by one to restore the old values in the clustered and secondary indexes, which can take as long as the forward work did. The same difference shows up after a crash: InnoDB must roll back loser transactions after redo, while PostgreSQL needs no undo pass at all.

**Q: Does synchronous_commit = off make crash recovery unsafe?**
A: No. Recovery remains correct and the database stays consistent, because WAL that reached disk is replayed in order and anything after the last flushed record simply never happened. What changes is the durability promise: the server may have told a client "committed" for a transaction whose commit record was still in memory, and a crash loses it. The window is roughly three `wal_writer_delay` cycles. That is acceptable for regenerable data but not for anything a client acts on after the acknowledgement.

## 10. Quick Revision & Cheat Sheet

| Crash moment | Durable result | Client sees | Needs |
|---|---|---|---|
| During statement, before COMMIT | Nothing committed | Error | Normal retry |
| COMMIT sent, WAL not flushed | Lost | Broken connection (ambiguous) | Idempotency key |
| WAL flushed, reply not sent | Committed | Broken connection (ambiguous) | Idempotency key |
| After reply | Committed | Success | — |
| After reply, `synchronous_commit=off` | Possibly lost | Success | Only for regenerable data |

| Engine | Redo | Undo | Torn pages | Checksums |
|---|---|---|---|---|
| PostgreSQL | WAL from redo point | None (pg_xact visibility) | Full-page images | Optional (`--data-checksums`) |
| InnoDB | Redo log | Undo logs, background rollback | Doublewrite buffer | Always on |

- Recovery = replay the log from the last completed checkpoint's redo point; PostgreSQL stops at the first invalid record.
- "invalid record length … got 0" during recovery is normal: it marks the end of WAL.
- Recovery time ≈ WAL since redo point ÷ replay rate; measure both.
- Ambiguous commit is an application problem; solve it with idempotency keys.
- Checksums detect corruption replay cannot; `pg_amcheck` finds logical index/heap damage.
- fsync failure → PANIC → replay; never trust a retried fsync.
- `kill -9` and instance-stop drills are the only proof of durability.

## 11. Hands-On Exercises

Lab: `docker run -d --name crash -e POSTGRES_PASSWORD=pw -e POSTGRES_INITDB_ARGS="--data-checksums" postgres:17 -c log_checkpoints=on`.

1. **Kill -9 drill.** Run the ledger `pgbench` workload from §5, SIGKILL the postmaster mid-run, restart, and verify the ledger sums to zero. Record the redo start and done LSNs and compute bytes replayed per second.
2. **Recovery debt.** Before crashing, compute `pg_wal_lsn_diff(pg_current_wal_lsn(), (SELECT redo_lsn FROM pg_control_checkpoint()))`. Crash at different points in the checkpoint cycle and compare predicted vs actual replay volume.
3. **Checkpoint distance vs recovery time.** Run the drill with `max_wal_size = 256MB` and again with `8GB` / `checkpoint_timeout = 30min`. Plot WAL volume per transaction and recovery time for both.
4. **Ambiguous commit.** Write a client that inserts payments with and without idempotency keys and retries on connection errors. Kill the server repeatedly during load and count duplicates in each mode.
5. **Corruption detection.** Stop the container, overwrite a few bytes in the middle of a table's data file with `dd` (find it with `SELECT pg_relation_filepath('ledger')`), start it, `SELECT` from the table, and observe the checksum error and `pg_stat_database.checksum_failures`. Then run `pg_amcheck`.
6. **InnoDB contrast (optional).** In `mysql:8.4`, start a `DELETE` of a million rows in one transaction, kill mysqld, restart, and watch the background rollback in `SHOW ENGINE INNODB STATUS`.

### Mini project — "Durability Proof Harness"

Build a harness that (1) starts PostgreSQL with a given config, (2) runs a checkable workload with client-side logging of every acknowledged commit, (3) crashes the server at random intervals N times, and (4) after each restart verifies: every acknowledged commit exists (unless `synchronous_commit = off`), the ledger invariant holds, `pg_amcheck` is clean, and recovery time is under a threshold. Output a report per configuration (`synchronous_commit` on/off, checkpoint distances). This is the durability test you wish your team already had.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (the log recovery replays) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (visibility instead of undo) · [Ch 09 · Replication](topic.html?p=09-replication) (replicas as continuous recovery) · [Ch 18 · High Availability](topic.html?p=18-high-availability) (failing over instead of waiting for recovery) · [Ch 25 · Database Reliability Engineering](topic.html?p=25-database-reliability-engineering) (drills and game days) · [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery) (media failure, PITR).

**SQL Handbook:** [Transactions & ACID](../sql/topic.html?p=25-transactions-acid).

**Other handbooks:** [Caching with Redis · Persistence: RDB & AOF](../redis-caching/topic.html?p=24-persistence-rdb-aof) (crash recovery for an in-memory store) · [Kafka & RabbitMQ · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox) (resolving ambiguous outcomes) · [Cassandra · Write Path](../cassandra/topic.html?p=21-write-path) (commit-log replay in an LSM engine).

- **Reliability and the Write-Ahead Log** — PostgreSQL docs · *Intermediate* · reliability assumptions, disk caches, data checksums and WAL internals. <https://www.postgresql.org/docs/current/wal.html>
- **Data Checksums** — PostgreSQL docs · *Intermediate* · what checksums protect and how to enable them. <https://www.postgresql.org/docs/current/checksums.html>
- **pg_amcheck** — PostgreSQL docs · *Intermediate* · checking heap and B-tree integrity across a database. <https://www.postgresql.org/docs/current/app-pgamcheck.html>
- **Fsync Errors** — PostgreSQL wiki · *Advanced* · the fsyncgate background and PostgreSQL's response. <https://wiki.postgresql.org/wiki/Fsync_Errors>
- **ARIES: A Transaction Recovery Method** — Mohan et al., ACM TODS 1992 · *Advanced* · the original analysis/redo/undo algorithm with CLRs. <https://dl.acm.org/doi/10.1145/128765.128770>
- **InnoDB Recovery** — MySQL Reference Manual · *Intermediate* · crash recovery, redo application and background rollback. <https://dev.mysql.com/doc/refman/8.0/en/innodb-recovery.html>
- **Forcing InnoDB Recovery** — MySQL Reference Manual · *Advanced* · what each `innodb_force_recovery` level skips, and why high levels are dangerous. <https://dev.mysql.com/doc/refman/8.0/en/forcing-innodb-recovery.html>
- **Designing Data-Intensive Applications, ch. 7** — Martin Kleppmann · *Intermediate* · durability, atomic commit and what "committed" really promises. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 08.*
