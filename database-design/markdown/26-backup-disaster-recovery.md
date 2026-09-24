# 26 · Backup & Disaster Recovery: Restores, Not Backups

> **In one line:** Nobody needs backups; everybody needs *restores* — so design backwards from the recovery you must perform (how much data you may lose, how long you may be down, which disasters you must survive), and treat any backup that has never been restored as unproven.

---

## 1. Overview

> **Builds on:** [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (WAL records, segments, LSNs) · [Ch 08 · Crash Recovery](topic.html?p=08-crash-recovery) (redo from a checkpoint) · [Ch 09 · Database Replication](topic.html?p=09-replication) · [Ch 18 · High Availability](topic.html?p=18-high-availability) (RPO/RTO for failover). The SQL Handbook has no backup chapter; this one assumes you know what a transaction and the WAL are and goes straight to production recovery.

Every team has backups. Surprisingly few teams have **restores**. The difference shows up at the worst possible moment: a developer runs `DELETE FROM orders` without a `WHERE` at 14:03 on a Tuesday, someone opens the backup bucket, and the team finds that the nightly job has been failing silently for three weeks, or that the dump is there but takes eleven hours to load, or that the WAL archive has a gap so they cannot roll forward past 02:00. The backup existed the whole time. The ability to recover from it did not.

The problem exists because backups and restores fail in completely different ways. A backup job that *runs* can still produce something useless: a dump of the wrong database, a base backup without the WAL needed to make it consistent, an archive encrypted with a key nobody can find, a snapshot of a disk that was mid-write. None of these fail loudly when they are taken. They fail when you try to use them, which is exactly when you have no time left.

Replication does not solve this either, and it is the most common false sense of safety in the industry. A streaming replica applies *every* change the primary makes within milliseconds, including `DROP TABLE`, `TRUNCATE`, and a bad migration that zeroed a column. Replication protects you from *hardware* failure. Backups protect you from *logical* failure: human error, application bugs, ransomware, and the corruption that replicates faithfully to every copy.

The naive approach — "run `pg_dump` every night and copy it to S3" — fails on three axes at once. It loses up to 24 hours of data (a terrible **RPO**). Restoring a multi-terabyte logical dump means re-inserting every row and rebuilding every index, which can take many hours (a terrible **RTO**). And nobody has checked that it restores. This chapter builds the alternative: physical base backups plus continuous WAL archiving for point-in-time recovery, incremental backups to keep the cost sane, automated restore drills to prove it all works, and copies placed so that the disaster that takes out your database does not also take out your backups.

> **Why this matters:** In interviews and in incidents, "we have backups" is a claim. "We restored last night's backup into a scratch instance at 04:00, ran our sanity queries, measured a 47-minute restore, and the WAL archive has no gaps" is evidence. Senior engineers speak in the second form.

## 2. Core Concepts

- **Logical backup** — a dump of the data as SQL or an archive of rows (`pg_dump`, `mysqldump`). *Why it matters:* portable across major versions and architectures, can restore a single table, but restore is slow (re-insert + rebuild indexes) and it cannot do point-in-time recovery.
- **Physical backup** — a copy of the data files themselves (`pg_basebackup`, pgBackRest, XtraBackup). *Why it matters:* restores at disk speed, is the base for PITR, but is tied to the same major version and platform and restores the whole cluster.
- **Base backup** — a physical copy taken while the server runs, *inconsistent on its own*; it becomes consistent only after replaying the WAL generated during the copy. *Why it matters:* a base backup without its WAL is not a backup.
- **WAL archiving** — shipping every completed WAL segment (16 MB by default) to durable storage via `archive_command` or `archive_library`. *Why it matters:* this is what turns a nightly backup into a continuous one and makes your RPO minutes or seconds instead of a day.
- **PITR (point-in-time recovery)** — restore a base backup, then replay archived WAL up to a chosen moment (`recovery_target_time`, `_xid`, `_lsn`, `_name`). *Why it matters:* the only way to recover to "one second before the bad `DELETE`".
- **Full / differential / incremental** — full copies everything; differential copies what changed since the last full; incremental copies what changed since the last backup of any kind. *Why it matters:* trades backup cost against restore complexity (how many pieces must be chained).
- **RPO (Recovery Point Objective)** — the maximum data loss you accept, measured in time. *Why it matters:* dictates archiving frequency and whether you need synchronous replication.
- **RTO (Recovery Time Objective)** — the maximum time to be back in service. *Why it matters:* dictates backup format, restore throughput, and whether you need a warm standby instead of a restore at all.
- **Backup manifest / checksums** — a list of every file with its size and checksum (PG 13+ `backup_manifest`), plus page-level data checksums (`initdb --data-checksums`). *Why it matters:* lets `pg_verifybackup` prove the backup is intact without restoring it, and lets the server detect silent disk corruption.
- **Retention** — how many backups and how much WAL you keep. *Why it matters:* your PITR window is bounded by the oldest base backup that still has a continuous WAL chain after it.
- **Immutability / WORM** — storage that cannot be modified or deleted until a retention date (S3 Object Lock, Azure immutable blobs). *Why it matters:* ransomware and compromised credentials delete backups first.
- **Restore drill** — an automated, scheduled restore into a scratch environment followed by validation queries. *Why it matters:* the only thing that converts a backup from a hope into a measured capability.

## 3. Theory & Principles

### Why a base backup alone is inconsistent

`pg_basebackup` copies data files while the database is running and changing. By the time it copies `base/16384/24576` (the last file), the first file it copied is already stale, and some pages may have been caught half-written. That is fine, because PostgreSQL does not rely on the files being consistent. It relies on the WAL.

When the backup starts, PostgreSQL performs a checkpoint and records the **start LSN**. Every change made during the copy is written to WAL first (the WAL rule from [Ch 07](topic.html?p=07-write-ahead-logging)), and `full_page_writes` guarantees that the first modification of each page after that checkpoint logs a full page image — so any torn page the copy picked up will be overwritten wholesale during replay. When the copy finishes, PostgreSQL records the **end LSN**. Restoring is then exactly [crash recovery](topic.html?p=08-crash-recovery): start from the checkpoint at the start LSN and replay WAL at least up to the end LSN. Only at that point — the **consistent recovery point** — is the database valid. Stop earlier and PostgreSQL refuses to open.

This is why `pg_basebackup` defaults to `--wal-method=stream`: it opens a second replication connection and streams the WAL generated during the copy into the backup itself, so the backup is self-contained. A base backup taken with `--wal-method=none` and no WAL archive is a pile of files that cannot be started.

### Continuous archiving makes the backup continuous

Once you archive every WAL segment, the base backup is just a starting point. Replay can continue past the end LSN, through every archived segment, up to any moment you choose. Your recovery point is limited only by the last segment that reached the archive. Two settings bound the lag:

- A segment is archived when it is **full** (16 MB) — on a quiet database that could take hours.
- `archive_timeout` forces a segment switch after N seconds even if not full (for example `60s`), capping RPO for low-traffic systems at about a minute, at the cost of archiving mostly-empty 16 MB files. (They compress very well.)

Tools such as pgBackRest, WAL-G and Barman can also *stream* WAL (Barman via `pg_receivewal`) so the archive trails the primary by seconds rather than segments.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c26a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c26a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Point-in-time recovery: base backup + WAL replay up to a target</text>
  <line x1="40" y1="120" x2="850" y2="120" stroke="#94a3b8" stroke-width="2"/>
  <text x="40" y="140" fill="#334155">Sun 01:00</text>
  <text x="330" y="140" fill="#334155">Mon</text>
  <text x="560" y="140" fill="#334155">Tue 14:02:59</text>
  <text x="700" y="140" fill="#334155">14:03 DELETE</text>
  <rect x="40" y="60" width="130" height="44" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="105" y="78" text-anchor="middle" fill="#1e293b" font-weight="bold">Base backup</text>
  <text x="105" y="94" text-anchor="middle" fill="#334155">start LSN ... end LSN</text>
  <rect x="172" y="70" width="36" height="24" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="210" y="70" width="36" height="24" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="248" y="70" width="36" height="24" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="286" y="70" width="36" height="24" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="324" y="70" width="36" height="24" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="362" y="70" width="36" height="24" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="400" y="70" width="36" height="24" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="438" y="70" width="36" height="24" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="476" y="70" width="36" height="24" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="514" y="70" width="36" height="24" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="552" y="70" width="36" height="24" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="590" y="70" width="36" height="24" fill="#dcfce7" stroke="#16a34a"/>
  <rect x="628" y="70" width="36" height="24" fill="#fef3c7" stroke="#d97706"/>
  <rect x="700" y="70" width="36" height="24" fill="#fee2e2" stroke="#dc2626"/>
  <rect x="738" y="70" width="36" height="24" fill="#fee2e2" stroke="#dc2626"/>
  <text x="380" y="62" text-anchor="middle" fill="#166534">archived WAL segments (16 MB each), replayed in order</text>
  <line x1="690" y1="50" x2="690" y2="160" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 3"/>
  <text x="690" y="175" text-anchor="middle" fill="#dc2626" font-weight="bold">recovery_target_time</text>
  <path d="M105,190 L680,190" stroke="#2563eb" stroke-width="2.5" marker-end="url(#c26a1)"/>
  <text x="390" y="184" text-anchor="middle" fill="#1e40af">replay: restore_command fetches each segment, redo applies records</text>
  <path d="M700,200 L840,200" stroke="#dc2626" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#c26a2)"/>
  <text x="770" y="216" text-anchor="middle" fill="#b91c1c">NOT replayed</text>
  <rect x="40" y="240" width="390" height="140" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="235" y="260" text-anchor="middle" fill="#1e293b" font-weight="bold">What makes this work</text>
  <text x="56" y="282" fill="#334155">1. Base backup is fuzzy; replay to end LSN makes it consistent</text>
  <text x="56" y="302" fill="#334155">2. full_page_writes repairs any torn page the copy caught</text>
  <text x="56" y="322" fill="#334155">3. Every segment after the backup must exist: ONE gap = stop there</text>
  <text x="56" y="342" fill="#334155">4. Commit records carry timestamps; replay stops at the first</text>
  <text x="70" y="358" fill="#334155">commit past the target (inclusive = true by default)</text>
  <rect x="450" y="240" width="400" height="140" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="650" y="260" text-anchor="middle" fill="#92400e" font-weight="bold">After the target</text>
  <text x="466" y="282" fill="#78350f">recovery_target_action = pause (default): inspect first</text>
  <text x="466" y="302" fill="#78350f">pg_wal_replay_resume() ends recovery and promotes</text>
  <text x="466" y="322" fill="#78350f">a NEW timeline starts (00000002.history) so the old</text>
  <text x="466" y="338" fill="#78350f">future WAL can never be confused with the new one</text>
  <text x="466" y="362" fill="#92400e" font-weight="bold">RPO = age of newest archived segment at the disaster</text>
</svg>
```

### Timelines: why recovery forks history

When PITR stops at 14:02:59 and promotes, the database has a history that diverges from the one the original primary lived through — the original went on to execute the `DELETE` and more. PostgreSQL handles this by starting a new **timeline**: WAL segment names carry a timeline ID (the first 8 hex digits of `000000020000001A0000003F`), and a small `00000002.history` file records the LSN at which timeline 2 branched off timeline 1. If you later need to recover again, `recovery_target_timeline = 'latest'` (the default since PG 12) follows the branch. Without timelines, the archive would contain two conflicting versions of "segment 1A/3F", and a future restore could replay the wrong one. This is also why you must never point two live clusters at the same archive path without separate stanzas or prefixes.

### Full, differential and incremental — the restore-chain trade-off

A full backup of 4 TB every night is expensive: it reads every block, ships every byte, and stores 4 TB per day of retention. Incrementals copy only blocks (or files) that changed. The price is paid at restore time: to reconstruct Thursday you need Sunday's full *plus* every incremental through Thursday, and if any link in that chain is corrupt, everything after it is unusable. Differentials sit in between: every differential depends only on the last full, so a restore needs exactly two pieces.

PostgreSQL 17 brought block-level incremental backup into core. The server runs a **WAL summarizer** (`summarize_wal = on`) that records which blocks each range of WAL modified. `pg_basebackup --incremental=<previous backup_manifest>` then reads those summaries and copies only changed blocks. You cannot start an incremental backup directly; `pg_combinebackup` merges a full plus its chain of incrementals into a synthetic full backup, which you then start normally. pgBackRest had full/diff/incr for years (file-level, and block-level incremental since 2.46 when bundling is enabled) and manages the chain for you — which is the main reason most production teams still run it rather than stitching core tools together.

### RPO and RTO are outputs of your design, not wishes

RPO is determined by **how far behind the durable copy can be** at the instant of disaster:

| Mechanism | Typical RPO |
|---|---|
| Nightly `pg_dump` only | up to 24 h |
| Base backup + WAL archive (full segments) | minutes on a busy DB, unbounded on a quiet one |
| + `archive_timeout = 60s` | ≤ ~1 min |
| + streamed WAL (`pg_receivewal`, pgBackRest async archive) | seconds |
| Synchronous replica in another zone | ~0 for committed txns (for hardware loss; *not* for logical errors) |

RTO is arithmetic you should actually do. For a physical restore: **download time + WAL replay time + validation + DNS/app cutover**. Downloading a 3 TB backup at a sustained 500 MB/s takes roughly 100 minutes. Replaying a day of WAL depends on write rate, and replay is largely single-threaded; a database that generates 200 GB of WAL a day may need an hour or more to replay it. If your RTO is 30 minutes, no restore-based design can meet it — you need a standby that is already running ([Ch 18](topic.html?p=18-high-availability)), and backups become your answer only for the logical-corruption case.

## 4. Architecture & Workflow

### A reference backup architecture

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c26b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c26b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="c26b3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Region A runs the database; backups land in two places; a drill proves them daily</text>
  <rect x="20" y="40" width="400" height="220" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="220" y="60" text-anchor="middle" fill="#334155" font-weight="bold">Region A (production)</text>
  <rect x="40" y="76" width="150" height="56" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="115" y="98" text-anchor="middle" fill="#1e293b" font-weight="bold">Primary</text>
  <text x="115" y="116" text-anchor="middle" fill="#334155">archive-push WAL (async)</text>
  <rect x="240" y="76" width="160" height="56" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="320" y="98" text-anchor="middle" fill="#1e293b" font-weight="bold">Standby</text>
  <text x="320" y="116" text-anchor="middle" fill="#334155">base backups taken here</text>
  <path d="M190,104 L238,104" stroke="#2563eb" stroke-width="2" marker-end="url(#c26b1)"/>
  <text x="214" y="96" text-anchor="middle" fill="#1e40af" font-size="9">stream</text>
  <rect x="40" y="170" width="360" height="70" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="220" y="192" text-anchor="middle" fill="#5b21b6" font-weight="bold">repo1: object storage, same region</text>
  <text x="220" y="210" text-anchor="middle" fill="#5b21b6">fast restores; full weekly + diff daily + WAL</text>
  <text x="220" y="226" text-anchor="middle" fill="#5b21b6">retention: 14 days of PITR</text>
  <path d="M115,132 L150,168" stroke="#7c3aed" stroke-width="2" marker-end="url(#c26b2)"/>
  <path d="M320,132 L290,168" stroke="#7c3aed" stroke-width="2" marker-end="url(#c26b2)"/>
  <rect x="460" y="40" width="400" height="220" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="660" y="60" text-anchor="middle" fill="#334155" font-weight="bold">Region B / separate account</text>
  <rect x="480" y="76" width="360" height="80" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="660" y="98" text-anchor="middle" fill="#991b1b" font-weight="bold">repo2: immutable bucket (Object Lock)</text>
  <text x="660" y="116" text-anchor="middle" fill="#7f1d1d">different credentials, write-only from prod</text>
  <text x="660" y="134" text-anchor="middle" fill="#7f1d1d">retention 35-90 days, cannot be deleted early</text>
  <path d="M400,205 L478,120" stroke="#7c3aed" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#c26b2)"/>
  <text x="452" y="176" text-anchor="middle" fill="#6d28d9" font-size="9">copy</text>
  <rect x="480" y="176" width="360" height="64" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="660" y="198" text-anchor="middle" fill="#166534" font-weight="bold">DR restore target (pilot light)</text>
  <text x="660" y="216" text-anchor="middle" fill="#166534">infra-as-code ready; restored only on disaster</text>
  <rect x="20" y="290" width="840" height="124" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="440" y="312" text-anchor="middle" fill="#166534" font-weight="bold">Nightly restore drill (automated) — the part most teams skip</text>
  <rect x="40" y="328" width="150" height="44" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="115" y="348" text-anchor="middle" fill="#14532d">1. pick random</text>
  <text x="115" y="362" text-anchor="middle" fill="#14532d">backup + PITR time</text>
  <rect x="210" y="328" width="150" height="44" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="285" y="348" text-anchor="middle" fill="#14532d">2. restore into a</text>
  <text x="285" y="362" text-anchor="middle" fill="#14532d">scratch instance</text>
  <rect x="380" y="328" width="150" height="44" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="455" y="348" text-anchor="middle" fill="#14532d">3. amcheck + sanity</text>
  <text x="455" y="362" text-anchor="middle" fill="#14532d">queries vs prod</text>
  <rect x="550" y="328" width="150" height="44" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="625" y="348" text-anchor="middle" fill="#14532d">4. record restore</text>
  <text x="625" y="362" text-anchor="middle" fill="#14532d">duration = real RTO</text>
  <rect x="720" y="328" width="120" height="44" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="780" y="348" text-anchor="middle" fill="#14532d">5. alert on fail,</text>
  <text x="780" y="362" text-anchor="middle" fill="#14532d">destroy instance</text>
  <path d="M190,350 L208,350" stroke="#16a34a" stroke-width="2" marker-end="url(#c26b3)"/>
  <path d="M360,350 L378,350" stroke="#16a34a" stroke-width="2" marker-end="url(#c26b3)"/>
  <path d="M530,350 L548,350" stroke="#16a34a" stroke-width="2" marker-end="url(#c26b3)"/>
  <path d="M700,350 L718,350" stroke="#16a34a" stroke-width="2" marker-end="url(#c26b3)"/>
  <text x="440" y="400" text-anchor="middle" fill="#166534">A backup that passed step 3 last night is proven. Anything else is a hypothesis.</text>
</svg>
```

A few design decisions are embedded in that picture:

- **Take base backups from a standby.** A full backup reads every block of the database; doing it on the primary competes with production I/O. pgBackRest's `backup-standby=y` copies most files from the standby while coordinating the start and stop with the primary. The WAL archive still comes from the primary (or from a standby with `archive_mode = always`).
- **Two repositories with different failure domains.** The local repo exists for speed — most restores are "someone deleted a table", and you want them fast. The remote, immutable repo exists for the disasters: region loss, a compromised cloud account, ransomware.
- **Backups are written by a principal that cannot delete them.** If the production database host's credentials can delete backups, then an attacker (or an `rm -rf` script) with those credentials can too.

### The 14:03 incident, step by step

This is the scenario every backup design is ultimately tested against.

```text
14:03:11  app deploy runs a data-fix script: DELETE FROM orders;   (no WHERE)
14:03:12  COMMIT. 41 million rows gone. Replicas apply it within ms.
14:09     support tickets: "my orders disappeared"
14:12     incident declared. FIRST ACTION: stop the bleeding (disable the script,
          put the orders page in maintenance), do NOT restore over production yet.
14:15     find the exact point: search app logs / pg_stat_statements / archived WAL
          for the DELETE; note its commit time and xid.
14:20     start PITR of latest base backup into a NEW instance, target just before.
15:05     restore reaches target, pauses. Verify: SELECT count(*) FROM orders;
15:10     decide: (a) copy the 41M rows back into prod, or (b) fail over to the
          restored instance and lose everything written since 14:03.
15:40     (a) chosen: COPY rows out of the restored instance, INSERT ... ON
          CONFLICT DO NOTHING into prod. Orders placed after 14:03 are preserved.
```

The key insight is step (a). Restoring the *whole cluster* to 14:03:10 would roll back every other table too — all payments, signups and messages from the last hour. For a mistake confined to one table, the correct recovery is almost always **restore to the side, then surgically copy data back**. Full-cluster PITR in place is for when the damage is widespread (bad migration across many tables, ransomware, corruption).

Finding the exact target is its own skill. `pg_waldump` can decode archived segments and show you the transaction:

```text
$ pg_waldump --path=/restore/wal 000000010000002A00000031 | grep -m3 -E 'DELETE|COMMIT'
rmgr: Heap   len (rec/tot): 54/54, tx: 88412907, lsn: 2A/31000F28, desc: DELETE off: 3 ...
rmgr: Transaction len (rec/tot): 34/34, tx: 88412907, lsn: 2A/3F2210A0,
      desc: COMMIT 2026-09-22 14:03:12.418230 UTC
```

With the xid, you can use `recovery_target_xid = '88412907'` and `recovery_target_inclusive = false` to stop *just before* that transaction committed, which is more precise than a timestamp when many transactions committed in the same second.

### Disaster recovery tiers

The industry uses a ladder (AWS's whitepaper names them the same way) that trades cost for RTO/RPO:

| Tier | What is running in the DR region | RPO | RTO | Cost |
|---|---|---|---|---|
| **Backup & restore** | Nothing; backups copied there | minutes–hours | hours | lowest |
| **Pilot light** | Minimal core (e.g. a small replica or just IaC + data) | seconds–minutes | tens of minutes | low |
| **Warm standby** | A scaled-down but running copy of the stack, replica attached | seconds | minutes | medium |
| **Multi-site active/active** | Full capacity in both regions | ~0 | ~0 (routing) | highest, plus the multi-region consistency problem of [Ch 17](topic.html?p=17-multi-region-databases) |

Every tier above backup-and-restore still needs backups, because every tier above it replicates logical mistakes.

## 5. Implementation

### Simple example: a laptop-sized PITR in 15 minutes

```ini
# postgresql.conf on the primary
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /archive/%f && cp %p /archive/%f'   # never overwrite
archive_timeout = 60s
summarize_wal = on          # PG 17: enables incremental base backups
```

`test ! -f` matters: if an archive command overwrites an existing segment, a misconfigured second cluster can silently replace good WAL with its own. Real deployments use pgBackRest, WAL-G or Barman instead of `cp`, because `cp` does not `fsync`, compress, encrypt, or retry — but the contract is the same: exit 0 only once the segment is durably stored.

```bash
# Sunday: full base backup (plain format, WAL streamed in, manifest with SHA-256 checksums)
pg_basebackup -D /backups/full_sun -Fp -X stream -c fast -P --manifest-checksums=SHA256

# Monday: PG 17 incremental relative to Sunday's manifest (only changed blocks)
pg_basebackup -D /backups/incr_mon -Fp -X stream --incremental=/backups/full_sun/backup_manifest

# Verify a backup against its manifest without restoring it
pg_verifybackup /backups/full_sun

# Build a synthetic full from the chain (oldest first) before starting it
pg_combinebackup /backups/full_sun /backups/incr_mon -o /restore/pgdata
```

Now the recovery configuration (PG 12+ has no `recovery.conf`; you create a signal file and put the settings in `postgresql.conf` or `postgresql.auto.conf`):

```ini
# /restore/pgdata/postgresql.auto.conf  (plus: touch /restore/pgdata/recovery.signal)
restore_command = 'cp /archive/%f %p'
recovery_target_time = '2026-09-22 14:03:10 UTC'
recovery_target_action = 'pause'
```

```text
$ pg_ctl -D /restore/pgdata -o '-p 5433' start
LOG:  starting point-in-time recovery to 2026-09-22 14:03:10+00
LOG:  restored log file "000000010000002A00000029" from archive
LOG:  consistent recovery state reached at 2A/29000138
LOG:  recovery stopping before commit of transaction 88412907, time 2026-09-22 14:03:12.41823+00
LOG:  pausing at the end of recovery
HINT:  Execute pg_wal_replay_resume() to promote.
```

```sql
-- On port 5433, still read-only and paused: verify before you commit to this point
SELECT count(*), max(created_at) FROM orders;   -- 41,002,113 | 2026-09-22 14:03:09
SELECT pg_wal_replay_resume();                  -- ends recovery, new timeline, read-write
```

### Real-world example: pgBackRest with two repos and automated drills

```ini
# /etc/pgbackrest/pgbackrest.conf
[global]
repo1-type=s3
repo1-s3-bucket=acme-pg-backups-euw1
repo1-s3-region=eu-west-1
repo1-s3-endpoint=s3.eu-west-1.amazonaws.com
repo1-path=/orders
repo1-retention-full=2
repo1-bundle=y
repo1-block=y                      # block-level incremental
repo1-cipher-type=aes-256-cbc
repo2-type=s3
repo2-s3-bucket=acme-pg-backups-dr-locked   # Object Lock enabled, other account
repo2-s3-region=eu-central-1
repo2-s3-endpoint=s3.eu-central-1.amazonaws.com
repo2-path=/orders
repo2-retention-full=6
repo2-cipher-type=aes-256-cbc
archive-async=y
process-max=8
compress-type=zst
backup-standby=y

[orders]
pg1-path=/var/lib/postgresql/17/main
pg2-host=orders-standby-1
pg2-path=/var/lib/postgresql/17/main
```

```ini
# postgresql.conf
archive_mode = on
archive_command = 'pgbackrest --stanza=orders archive-push %p'
```

```bash
pgbackrest --stanza=orders stanza-create
pgbackrest --stanza=orders check                  # proves archive_command round-trips
pgbackrest --stanza=orders --type=full --repo=1 backup    # weekly
pgbackrest --stanza=orders --type=diff --repo=1 backup    # daily
pgbackrest --stanza=orders --type=full --repo=2 backup    # weekly, DR copy
pgbackrest --stanza=orders verify                 # checksums of repo contents

# Restore to a point in time, into an empty directory on a scratch host
pgbackrest --stanza=orders --type=time --target="2026-09-22 14:03:10+00" \
  --target-action=pause --pg1-path=/restore/pgdata restore
```

The drill script matters more than the backup script. A minimal version:

```python
import subprocess, psycopg, random, time, datetime as dt

def drill():
    t0 = time.time()
    target = dt.datetime.utcnow() - dt.timedelta(hours=random.randint(1, 72))
    subprocess.run(["pgbackrest", "--stanza=orders", "--type=time",
                    f"--target={target:%Y-%m-%d %H:%M:%S}+00", "--target-action=promote",
                    "--pg1-path=/drill/pgdata", "--delta", "restore"], check=True)
    subprocess.run(["pg_ctl", "-D", "/drill/pgdata", "-o", "-p 6543", "-w", "-t", "7200",
                    "start"], check=True)
    with psycopg.connect("port=6543 dbname=orders") as c:
        # 1. structural integrity of indexes (amcheck extension)
        c.execute("CREATE EXTENSION IF NOT EXISTS amcheck")
        c.execute("""SELECT bt_index_check(c.oid) FROM pg_class c
                     JOIN pg_am a ON a.oid = c.relam
                     WHERE a.amname = 'btree' AND c.relpersistence = 'p'""")
        # 2. business sanity: data exists and is recent relative to the target
        n, newest = c.execute("SELECT count(*), max(created_at) FROM orders").fetchone()
        assert n > 1_000_000, f"orders suspiciously small: {n}"
        assert target - newest < dt.timedelta(minutes=10), "restore is not near target"
        # 3. invariants that must hold in any correct snapshot
        (imbalance,) = c.execute("SELECT coalesce(sum(amount), 0) FROM ledger").fetchone()
        assert imbalance == 0, "ledger does not balance"
    emit_metric("backup_restore_seconds", time.time() - t0)   # this IS your measured RTO
    emit_metric("backup_restore_success", 1)
```

Run it daily, alert if `backup_restore_success` has not been emitted in 26 hours, and graph `backup_restore_seconds` over time. When that graph crosses your RTO, you have learned it on a Tuesday afternoon instead of during an outage.

### Monitoring the archive itself

```sql
SELECT archived_count, last_archived_wal, last_archived_time,
       failed_count, last_failed_wal, last_failed_time
FROM pg_stat_archiver;
```

```text
 archived_count | last_archived_wal        | last_archived_time     | failed_count | last_failed_wal          | last_failed_time
----------------+--------------------------+------------------------+--------------+--------------------------+------------------------
         981022 | 000000010000002A0000003E | 2026-09-22 14:40:02+00 |          318 | 000000010000002A0000003F | 2026-09-22 14:41:07+00
```

A `last_failed_time` newer than `last_archived_time` means archiving is currently failing. Segments pile up in `pg_wal` (the server will not recycle them until archived), so an archive outage eventually becomes a **disk-full outage on the primary** — in addition to your RPO silently growing.

> **MySQL difference:** The physical tool is **Percona XtraBackup** (or MySQL Enterprise Backup): `xtrabackup --backup --target-dir=/b/full` copies InnoDB files while tracking the redo log, `--prepare` applies the redo to make the copy consistent (the same idea as replaying WAL to the end LSN), and `--copy-back` restores. Incrementals use `--incremental-basedir` and rely on page LSNs. PITR uses the **binlog**, not the redo log: note the binlog file/position (or GTID set) recorded in `xtrabackup_binlog_info`, restore the backup, then replay `mysqlbinlog --start-position=<pos> --stop-datetime="2026-09-22 14:03:10" binlog.000412 binlog.000413 | mysql`. Keep binlogs long enough (`binlog_expire_logs_seconds`) and ship them off-host. For logical dumps, `mysqldump --single-transaction` gives a consistent InnoDB snapshot without locking; MySQL Shell's `util.dumpInstance()` is the parallel, much faster option.

### Logical backups still have a job

`pg_dump` is not your DR plan, but it is the right tool for: restoring one table or schema into a different database, moving across major versions or CPU architectures, giving developers a sanitised copy, and as a second, independent format (a physical-backup bug will not affect a logical dump). Use the directory format with parallelism, and dump globals separately — `pg_dump` does not include roles or tablespaces:

```bash
pg_dump -Fd -j 8 -f /dumps/orders_2026-09-22 orders
pg_dumpall --globals-only > /dumps/globals.sql
pg_restore -j 8 -d orders_scratch --table=orders /dumps/orders_2026-09-22
```

## 6. Advantages, Disadvantages & Trade-offs

| Approach | RPO | RTO (multi-TB) | Granularity | Cross-version | Operational cost |
|---|---|---|---|---|---|
| `pg_dump` / `mysqldump` | last dump | many hours (reload + reindex) | table / schema | yes | low |
| Physical full nightly | last backup | ~download time | whole cluster | no | medium |
| Physical + WAL/binlog archive (PITR) | seconds–minutes | download + replay | whole cluster, any instant | no | medium |
| + incrementals (PG 17, pgBackRest, XtraBackup) | same | download + combine + replay | same | no | medium; chain risk |
| Storage/volume snapshots (EBS, managed service) | snapshot interval (+ managed PITR) | fast (lazy load) | whole volume | no | low; cloud lock-in |
| Delayed replica (`recovery_min_apply_delay = '1h'`) | 0 for hardware, 1 h window for mistakes | minutes | whole cluster | no | one extra server |

### When to use what

- **PITR (base backup + WAL archive)** — every production PostgreSQL database with data you cannot recreate. It is the baseline, not an upgrade.
- **Incrementals** — when full backups become too slow or expensive to take daily, typically in the high hundreds of GB and up.
- **Logical dumps additionally** — for single-table recovery convenience, cross-version portability, and format diversity.
- **Delayed replica** — when "oops" incidents are frequent and the database is large enough that a PITR restore takes hours; a replica an hour behind lets you pause replay (`pg_wal_replay_pause()`) and extract data in minutes.
- **Managed service backups (RDS/Aurora/Cloud SQL)** — use them, they give PITR out of the box; still add cross-account copies and still run restore drills.

### When NOT to rely on each

- **Do not rely on replicas or RAID as backups.** They copy mistakes instantly.
- **Do not rely on `pg_dump` alone** for anything with an RPO under a day or an RTO under several hours at multi-hundred-GB scale.
- **Do not rely on volume snapshots alone** unless they are crash-consistent across all volumes (data and WAL on separate volumes need a multi-volume consistent snapshot) and copied out of the account.
- **Do not keep long incremental chains** without periodic fulls; a single corrupt link invalidates everything after it.
- **Do not rely on a delayed replica as your only safety net**: once the delay window passes, the mistake is applied there too.

## 7. Common Mistakes & Best Practices

- **Never testing a restore.** Teams discover during the incident that the restore takes 9 hours, needs a decryption key that left with an ex-employee, or fails on a missing extension. *Instead:* automated daily restore drills with sanity queries, plus a quarterly human game-day that follows the written runbook.
- **Monitoring the backup job's exit code, not the backup.** The job "succeeded" while dumping an empty database because the connection string pointed to a new, empty replica. *Instead:* monitor artifacts — backup age, size delta versus yesterday, `pg_stat_archiver` failures, WAL continuity, and restore-drill success.
- **Backups in the same blast radius.** Backups on the same disk, same host, or same cloud account with the same admin credentials. *Instead:* at least one copy in another region and another account with delete protection (the "3-2-1" rule: 3 copies, 2 media, 1 off-site — modern variant adds 1 immutable).
- **A WAL archive with a gap.** A failed `archive_command` that someone "fixed" by deleting files from `pg_wal`, or a retention job that expired WAL still needed by the oldest base backup. *Instead:* never delete WAL by hand; let the backup tool manage retention; verify with `pgbackrest check` / `info`.
- **Restoring over production in panic.** Under pressure, someone runs the restore into the live data directory and destroys the only copy of post-incident writes. *Instead:* always restore to a new instance; decide on cutover or copy-back after validating.
- **Forgetting everything that is not table data.** Roles and passwords, `pg_hba.conf`, extensions and their versions, cron jobs, replication slots, secrets and KMS keys. *Instead:* keep configuration in infrastructure-as-code and include `pg_dumpall --globals-only` and key escrow in the plan.
- **No data checksums.** Silent storage corruption gets backed up for weeks until the last good copy expires. *Instead:* enable checksums (`initdb --data-checksums`, or `pg_checksums --enable` offline; recent releases enable them by default at initdb), watch `checksum_failures` in `pg_stat_database`, and run `amcheck` in drills.
- **Best practice summary:** define RPO/RTO per database with the business; derive the mechanism from them; automate backup, verification and restore; store copies immutably in a separate failure domain; measure real restore time continuously.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

- **The silent archive failure.** At 02:00 a credentials rotation breaks `archive_command`. Symptom: nothing, for days; then `pg_wal` grows to fill the disk and the primary stops with `PANIC: could not write to file "pg_wal/xlogtemp..."`. Root cause: no alert on `pg_stat_archiver.failed_count` or on `pg_wal` size. Fix: alert on archive failures within minutes, on WAL directory size, and on "age of last archived segment".
- **The restore that exceeded RTO.** A region fails; the team starts restoring a 6 TB backup from cross-region storage; download throughput is 150 MB/s because the restore host is a small instance, so the download alone takes ~11 hours. Root cause: RTO was never measured. Fix: size restore hosts for throughput, use parallel restore (`process-max`), keep a pilot-light or warm-standby tier for databases whose RTO a restore cannot meet.
- **Ransomware / compromised credentials.** An attacker with the cloud admin role deletes snapshots and backup buckets, then encrypts the database. Root cause: backups deletable by the same identity. Fix: Object Lock in compliance mode on a bucket in a separate account, MFA-delete, and backup writers that have `PutObject` but not `DeleteObject`.
- **Corruption that predates every backup.** A storage firmware bug zeroes pages; checksums are off; weekly fulls and 14-day retention mean that by the time a query errors, every backup contains the corruption. Fix: checksums on, `amcheck` in drills, and a longer-retention monthly full in cold storage.
- **Restore missing an extension.** The restored instance fails at startup because the image lacks PostGIS 3.4 in the same version as production. Fix: restore onto the same pinned image as production; the drill catches this.

### Metrics to watch

| Metric | Source | Alert when |
|---|---|---|
| Age of newest successful base backup | backup tool `info` / catalog | > 1.5 × schedule |
| Archive failures, last archived age | `pg_stat_archiver` | any failure > 5 min; age > RPO |
| `pg_wal` directory size | `pg_ls_waldir()` | growing unbounded |
| Restore drill success / duration | drill job | missing > 26 h; duration > 0.7 × RTO |
| Backup size delta | backup tool | ±30% day over day without a known cause |
| Checksum failures | `pg_stat_database.checksum_failures` | > 0 |
| Cross-region copy lag | storage replication metrics | > RPO for region loss |

### Scaling notes

At tens of TB, backup design is dominated by throughput. Use block-level incrementals so daily backups read and ship only changed blocks, parallel compression (zstd/lz4) across many processes, and take backups from a standby. Restore time is dominated by download and WAL replay: keep fulls frequent enough that replay is bounded (a weekly full with 7 days of WAL to replay may blow your RTO; daily diffs cap it). For very large fleets, managed snapshots with lazy loading restore "instantly" but run slowly until blocks are hydrated — measure *time to acceptable performance*, not just time to accept connections. Beyond a single database, remember that a consistent restore of *multiple* services' databases to the same instant is impossible without coordination; design each service to tolerate peers restored to slightly different points (idempotent reprocessing, reconciliation jobs — see [Ch 25 · Database Reliability Engineering](topic.html?p=25-database-reliability-engineering)).

## 9. Interview Questions

**Q: Why is a replica not a backup?**
A: A replica's job is to be an exact, up-to-date copy of the primary, and it does that job for bad changes as faithfully as for good ones. A `DROP TABLE`, a `DELETE` without `WHERE`, or a migration that corrupts a column is applied to every streaming replica within milliseconds. Replicas protect against hardware and zone failure, which is an availability concern; backups protect against logical failure by preserving *past* states you can return to. A delayed replica is a partial hybrid, but only within its delay window. You need both, for different failure classes.

**Q: What is the difference between RPO and RTO, and what determines each in a PostgreSQL setup?**
A: RPO is how much data you can afford to lose, expressed as time; RTO is how long you can afford to be down. In PostgreSQL, RPO is set by how far the durable copy can lag: nightly dumps give up to a day, WAL archiving gives the age of the last archived segment (bounded by `archive_timeout` or streaming), and a synchronous standby gives near zero for hardware failure. RTO is set by the recovery mechanism: restore time is download plus WAL replay plus validation and cutover, while failover to a running standby takes seconds to minutes. The important point is that both are outputs you measure, not targets you declare.

**Q: Walk through point-in-time recovery in PostgreSQL.**
A: You need a physical base backup and a continuous archive of WAL segments from the backup's start onward. You restore the base backup into an empty data directory, create `recovery.signal`, and configure `restore_command` so the server can fetch archived segments, plus a target such as `recovery_target_time` or `recovery_target_xid`. On startup the server replays WAL from the backup's checkpoint, becomes consistent once it passes the backup's end LSN, and keeps replaying until it reaches the target. With `recovery_target_action = 'pause'` it stops there so you can check the data, and `pg_wal_replay_resume()` ends recovery and promotes it onto a new timeline. Any gap in the archive stops replay at the gap.

**Q: Why is a base backup taken from a running database usable if the files were copied inconsistently?**
A: Because PostgreSQL never relied on the data files being consistent; it relies on the WAL. The backup begins with a checkpoint and records the start LSN, every change during the copy is logged to WAL first, and `full_page_writes` logs a full image of each page on its first modification after that checkpoint. Replaying WAL from the start LSN to the end LSN overwrites any torn or stale pages with correct contents, exactly as crash recovery would. That is why a base backup without the WAL generated during the copy cannot start, and why `pg_basebackup` streams that WAL into the backup by default.

**Q: Someone ran DELETE FROM orders without a WHERE at 14:03. What do you do?**
A: First contain the incident: stop whatever caused it and prevent further damage, but do not restore over production. Then find the precise point: application logs, `pg_stat_statements`, or `pg_waldump` on archived WAL give the transaction's commit time and xid. Restore the latest base backup into a *separate* instance with `recovery_target_xid` and `recovery_target_inclusive = false` (or a timestamp just before), pause at the target, and verify the row count. Because only one table was damaged and the rest of the database has an hour of valid writes, I would copy the missing rows back into production with `INSERT ... ON CONFLICT DO NOTHING` rather than rolling the whole cluster back. Finally, a postmortem: why could a script delete every row, and why did no guardrail (e.g. `safe_updates`-style checks, review, or a row-count assertion) stop it.

**Q: What does a PostgreSQL 17 incremental backup require, and how do you restore one?**
A: The server must run the WAL summarizer (`summarize_wal = on`), which records which blocks were modified in each range of WAL. You then take `pg_basebackup --incremental=<manifest of the previous backup>`, which copies only the changed blocks plus the metadata needed to reconstruct the rest. An incremental cannot be started directly; you run `pg_combinebackup` over the full backup and each incremental in order to produce a synthetic full data directory, and then start that normally (with WAL replay if you want PITR beyond it). The trade-off is a cheaper daily backup in exchange for a restore that depends on every link of the chain being intact.

**Q: How do you validate a backup without trusting the backup job's exit code?**
A: At three levels. Structural: `pg_verifybackup` checks every file against the backup manifest's checksums and that the required WAL is present and parseable, and pgBackRest's `verify` checks repository contents. Physical: data checksums catch page corruption at read time, and `amcheck` verifies B-tree invariants in a restored copy. Semantic: actually restore it into a scratch instance and run business sanity queries — row counts in the expected range, the newest row near the target time, invariants like a ledger summing to zero. Only the last level proves the backup is fit for purpose, which is why it should run automatically every day.

**Q: How would you protect backups against ransomware? (Senior)**
A: I assume the attacker gains the same privileges as my production operators, so any backup those identities can delete is not safe. I would write backups to object storage in a separate cloud account, with Object Lock in compliance mode setting a retention period during which nobody, including the root account, can delete or overwrite objects. The production side gets write-only credentials, and backup encryption keys are held in a KMS where the production role can encrypt but key deletion requires a separate approval. I would also keep retention long enough to reach back past a dwell time — attackers often sit quietly for weeks — and include periodic restores from the locked copy in the drill rotation, because an immutable backup that cannot be restored is just immutable garbage.

**Q: Your database is 8 TB with a 1-hour RTO and 1-minute RPO across a full region loss. Design the recovery strategy. (Senior)**
A: A restore cannot meet a one-hour RTO at 8 TB once you add cross-region download and WAL replay, so the primary mechanism for region loss must be a running replica in the second region: asynchronous streaming replication (synchronous across regions would cost too much commit latency), with lag monitored against the one-minute RPO and a runbook or orchestrator (Patroni with a standby cluster, or the managed service's cross-region replica) to promote it. That covers hardware and region loss. For logical corruption, which the replica would copy, I would keep pgBackRest PITR with repositories in both regions, block incrementals daily and fulls weekly so replay stays bounded, and possibly a delayed replica to make "undo the last hour" fast. RPO for the backup path would be bounded with async archive-push and `archive_timeout`. Then I would prove all of it: quarterly region failover drills, daily restore drills, and dashboards of replica lag and measured restore time.

**Q: A backup-and-restore test that used to take 40 minutes now takes 3 hours. How do you find out why? (Senior)**
A: I would break the restore into its phases, because the drill should log each: fetch/download, decompress and combine, WAL replay, and startup/validation. If download grew, check backup size growth, storage throughput, and whether the restore host or network changed. If replay grew, WAL volume per day probably increased (new write-heavy feature, `full_page_writes` amplification from more frequent checkpoints, a bulk backfill) or the last full backup is older so more WAL must be replayed; recovery is largely single-threaded apply, so replay is bounded by one core and I/O latency, and prefetching (`recovery_prefetch`) helps. The fixes follow the phase: more frequent fulls or diffs to shorten replay, parallel fetch, a bigger restore host, or moving the RTO-critical path to a standby. The meta-fix is alerting on drill duration trend so the next regression is noticed at 60 minutes, not 180.

**Q: What would you back up from a replica instead of the primary, and what are the risks? (Senior)**
A: Base backups are a good fit for a replica because they read every block and would otherwise compete with production I/O; PostgreSQL supports `pg_basebackup` from a standby, and pgBackRest's `backup-standby` copies files from the standby while coordinating start and stop with the primary. The risks are that a lagging or broken replica produces a stale or failing backup, so you must alert on replica lag and on backup freshness separately. WAL archiving must still be continuous regardless of which node is primary, so either archive from the primary or set `archive_mode = always` on the standby and make sure the archive survives failover without gaps or duplicates from two archivers. Finally, after a failover the backup tool must follow the new topology, which is a classic source of silently stopped backups.

**Q: How do logical and physical backups differ, and when do you still want a logical one?**
A: A logical backup extracts rows and DDL through SQL, so it is portable across major versions and platforms, can restore a single table, and is immune to physical-layer bugs, but restoring it re-inserts every row and rebuilds every index, which is slow, and it only captures one instant. A physical backup copies data files and, combined with WAL, supports PITR and restores at disk speed, but it is bound to the same major version and restores the whole cluster. I would keep physical PITR as the DR mechanism and still run periodic logical dumps for table-level recovery, version upgrades and migrations, sanitised developer copies, and as an independent second format.

## 10. Quick Revision & Cheat Sheet

| Need | Mechanism | Key settings / tools |
|---|---|---|
| Survive disk/host/zone loss | Replica / HA | [Ch 18](topic.html?p=18-high-availability) |
| Undo a human mistake | PITR | `archive_mode`, `restore_command`, `recovery_target_*` |
| Cheap daily backups at TB scale | Incrementals | PG 17 `summarize_wal` + `--incremental` + `pg_combinebackup`; pgBackRest `diff`/`incr` |
| Prove integrity | Manifest + checksums + drill | `pg_verifybackup`, `pgbackrest verify`, `amcheck`, `data_checksums` |
| Survive region loss | Cross-region copy / replica | repo2 in region B, standby cluster |
| Survive compromised admin | Immutable backups | Object Lock, separate account, write-only creds |
| Fast "undo last hour" | Delayed replica | `recovery_min_apply_delay` |
| MySQL PITR | XtraBackup + binlog | `--prepare`, `mysqlbinlog --stop-datetime` |

- A backup that has never been restored is not proven; automate restores daily and measure them.
- Replication copies mistakes; backups preserve the past.
- A base backup is only usable with the WAL from its start to end LSN; PITR needs every segment after that.
- Restore to a side instance and copy data back unless the damage is widespread.
- RPO comes from archive lag; RTO comes from download + replay + cutover — compute and measure both.
- `pg_stat_archiver` failures eventually fill the primary's disk.
- Put at least one copy in a different region *and* account, immutably.
- Back up roles, config, extensions and keys, not just tables.

## 11. Hands-On Exercises

Lab: `docker run --name pg -e POSTGRES_PASSWORD=pg -v $PWD/archive:/archive -d postgres:17 -c wal_level=replica -c archive_mode=on -c "archive_command=test ! -f /archive/%f && cp %p /archive/%f" -c archive_timeout=30 -c summarize_wal=on`.

1. **PITR by timestamp.** Take a base backup with `pg_basebackup`, then create a table and insert rows for a couple of minutes, note the time, and run `DELETE FROM t;`. Run `SELECT pg_switch_wal();` so the segment is archived. Restore the base backup into a second container with `recovery_target_time` set one second before the delete and confirm the rows are back.
2. **PITR by xid.** Repeat, but find the delete's xid with `pg_waldump` on the archived segment and use `recovery_target_xid` with `recovery_target_inclusive = false`. Compare precision with the timestamp approach when several commits share a second.
3. **Incremental chain.** Take a full backup, change 1% of rows, take a `--incremental` backup, change more, take another. Compare sizes, then `pg_combinebackup` all three and start the result. Delete one file from the middle incremental and observe what fails.
4. **Break the archive.** Make `/archive` read-only, generate WAL with `pgbench`, and watch `pg_stat_archiver.failed_count` and the size of `pg_wal` grow. Restore permissions and watch it catch up.
5. **Verify.** Run `pg_verifybackup` on a plain-format backup, then flip one byte in a data file inside the backup and run it again.
6. **Delayed replica.** Build a standby with `recovery_min_apply_delay = '5min'`, drop a table on the primary, pause replay on the standby with `pg_wal_replay_pause()`, and extract the table with `pg_dump -t`.

**Mini project — the restore drill service.** Build a scheduled job that (a) picks a random backup and random PITR target from the last 7 days, (b) restores it into a disposable container, (c) runs `amcheck` and a configurable list of sanity SQL assertions, (d) emits `restore_success` and per-phase durations as metrics, and (e) tears everything down. Add an alert when success is missing for 26 hours or duration exceeds 70% of the stated RTO. Stretch: make it restore from the immutable DR repository once a week.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) · [Ch 08 · Crash Recovery](topic.html?p=08-crash-recovery) · [Ch 09 · Database Replication](topic.html?p=09-replication) · [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases) · [Ch 18 · High Availability](topic.html?p=18-high-availability) · [Ch 25 · Database Reliability Engineering](topic.html?p=25-database-reliability-engineering) · [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution) (take a backup before a contract step) · [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle) (deleting personal data that lives in backups).

**SQL Handbook:** [SQL Handbook · Transactions & ACID](../sql/topic.html?p=25-transactions-acid) (durability is what WAL archiving extends off-host).

**Other handbooks:** [Cassandra · Backup, Snapshots & Restore](../cassandra/topic.html?p=30-backup-restore) (the same ideas with immutable SSTables) · [Caching with Redis · Persistence: RDB & AOF](../redis-caching/topic.html?p=24-persistence-rdb-aof).

- **Continuous Archiving and Point-in-Time Recovery** — PostgreSQL Docs · *Intermediate* · the authoritative description of base backups, WAL archiving and recovery targets. <https://www.postgresql.org/docs/current/continuous-archiving.html>
- **pg_basebackup** and **pg_combinebackup** — PostgreSQL Docs · *Intermediate* · incremental backup options and how chains are combined. <https://www.postgresql.org/docs/current/app-pgbasebackup.html> · <https://www.postgresql.org/docs/current/app-pgcombinebackup.html>
- **pg_verifybackup** — PostgreSQL Docs · *Intermediate* · what manifest verification does and does not prove. <https://www.postgresql.org/docs/current/app-pgverifybackup.html>
- **pgBackRest User Guide** — pgBackRest · *Intermediate* · repositories, retention, standby backups, async archiving and restore, end to end. <https://pgbackrest.org/user-guide.html>
- **Postmortem of database outage of January 31** — GitLab · *Beginner* · the classic story of five backup mechanisms, none of which worked when needed. <https://about.gitlab.com/blog/2017/02/10/postmortem-of-database-outage-of-january-31/>
- **Point-in-Time (Incremental) Recovery Using the Binary Log** — MySQL Reference Manual · *Intermediate* · binlog-based PITR mechanics. <https://dev.mysql.com/doc/refman/8.0/en/point-in-time-recovery.html>
- **Percona XtraBackup documentation** — Percona · *Intermediate* · backup, prepare, incremental and restore for InnoDB. <https://docs.percona.com/percona-xtrabackup/8.0/>
- **Disaster Recovery of Workloads on AWS** — AWS Whitepaper · *Intermediate* · the backup/pilot-light/warm-standby/active-active ladder with RPO/RTO trade-offs. <https://docs.aws.amazon.com/whitepapers/latest/disaster-recovery-workloads-on-aws/disaster-recovery-options-in-the-cloud.html>

---

*Database Design Handbook — chapter 26.*
