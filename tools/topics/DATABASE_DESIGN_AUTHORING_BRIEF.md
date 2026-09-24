# Database Design Handbook — Authoring Brief (read fully before writing)

Repo root: /Users/himanshu/Temp11/DSA-Patterns-Handbook
Your output: `database-design/markdown/<slug>.md` — ONE file per assigned chapter. Write NOTHING else, and edit no other files.
Manifest (slugs, names, summaries, keywords, sqlRefs): `tools/topics/database_design_topics.json`.

## Audience & thesis
Readers are developers growing toward **Senior SDE / Backend / System Design**. The handbook thesis:
> **Don't memorize database schemas. Learn to design data systems from workload, access patterns, consistency requirements, concurrency, scale, and failure.**

This handbook is the **sequel** to the existing SQL Handbook (`sql/markdown/`), NOT "SQL Part 2". The SQL Handbook already teaches:
SELECT/joins/aggregation/window functions/CTEs/subqueries, keys & constraints, normalization, schema design basics,
indexes & index design, query optimization, execution plans, declarative partitioning syntax, transactions & ACID,
the four isolation levels & anomaly table, and locking/MVCC basics (incl. SELECT FOR UPDATE, basic deadlocks, vacuum basics).
**Do not re-teach those.** When you need one, give a one-sentence recap and link it, then go deeper (internals, production behaviour, trade-offs, failure).

Prefer this teaching arc everywhere: **Problem → why the naive approach fails → concept → internal mechanism → example → trade-off → production usage.** Not an academic textbook; no long definitions without a "why".

## BEFORE writing each chapter
1. Read `messaging/markdown/21-idempotency-outbox.md` once (house style, depth, SVG style, Q/A format). Skim one more sibling chapter of your choice.
2. Read every SQL chapter listed in your chapter's `sqlRefs` (manifest) IN FULL, and `ls sql/markdown` for other overlap. Note what it already covers; your chapter must go beyond it and link to it.
3. Also be aware of overlapping chapters in other handbooks (system-design/, redis-caching/, messaging/, cassandra/). Link them where useful; do not copy them. Keep THIS handbook's angle: the database/data layer.

## Links (all relative, inline markdown links render)
- SQL Handbook: `[SQL Handbook · Isolation Levels](../sql/topic.html?p=26-isolation-levels)`
- Sibling chapter in this handbook: `[Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging)` — use slugs EXACTLY as in the manifest.
- Other handbooks: `[Caching with Redis · Cache Stampede](../redis-caching/topic.html?p=15-cache-stampede)` — verify the slug exists with `ls <handbook>/markdown` first.
- External resources: `<https://...>` (autolink) or `[text](https://...)`. Only well-known, stable URLs (postgresql.org/docs/current, dev.mysql.com/doc, official vendor docs, well-known papers/blogs). Never invent URLs.
Every chapter must contain at least one "Builds on" callout near the top of section 1 linking the relevant SQL Handbook chapter(s) (if any in sqlRefs) and prerequisite sibling chapters, e.g.
`> **Builds on:** [SQL Handbook · Locking & MVCC](../sql/topic.html?p=27-locking-mvcc) (the basics) · [Ch 02 · Storage Internals](topic.html?p=02-storage-internals). This chapter assumes those and goes into ...`

## Exact file skeleton (a quality gate checks this — do not deviate)
```
# NN · <Chapter name exactly as in manifest>

> **In one line:** <the chapter's thesis in one or two sentences>

---

## 1. Overview
## 2. Core Concepts
## 3. Theory & Principles
## 4. Architecture & Workflow
## 5. Implementation
## 6. Advantages, Disadvantages & Trade-offs
## 7. Common Mistakes & Best Practices
## 8. Production: Failure Scenarios, Monitoring & Scaling
## 9. Interview Questions
## 10. Quick Revision & Cheat Sheet
## 11. Hands-On Exercises
## 12. Related Topics & Free Learning Resources

---

*Database Design Handbook — chapter NN.*
```
(NN is two digits: 01..40. H2 headings must start exactly `## 1. Overview`, `## 2. Core Concepts`, `## 3. Theory`, `## 4. Architecture`, `## 5. Implementation`, `## 6. Advantages`, `## 7. Common Mistakes`, `## 8. Production`, `## 9. Interview Questions`, `## 10. Quick Revision`, `## 11. Hands-On Exercises`, `## 12. Related Topics` — use the full titles above.) Use `###` subsections freely inside.

## How the user's required 12-point structure maps onto the sections (concept chapters 01–30)
For every MAJOR concept in the chapter cover, somewhere: (1) what problem it solves, (2) why the problem exists, (3) how it works internally, (4) simple example, (5) real-world example, (6) diagram, (7) trade-offs, (8) failure scenarios, (9) when to use, (10) when NOT to use, (11) interview questions, (12) common mistakes.
- §1 Overview — the problem, why it exists, why the naive approach fails; "Builds on" callout.
- §2 Core Concepts — bullet glossary, each term with a *why it matters*.
- §3 Theory & Principles — the internal mechanism, step by step; at least one ```svg diagram.
- §4 Architecture & Workflow — component/flow view, timelines, sequence of events; at least one more ```svg diagram. ASCII ```text diagrams are welcome in addition.
- §5 Implementation — a **simple example** and a **real-world example**. Concrete PostgreSQL (```sql), diagnostic queries against pg_stat_* / pg_locks / pg_stat_statements etc., config snippets (```ini / ```text), and short Go or Python where application code is the point (pools, retries, CAS loops, outbox relays). Show observed output where it teaches (as ```text). Call out **MySQL/InnoDB differences** where behaviour meaningfully differs (in a `> **MySQL difference:**` callout). Distributed topics: use Kafka/Cassandra/DynamoDB/MongoDB/Redis/etcd examples as illustrations, not product docs.
- §6 Trade-offs — a trade-off table, plus explicit **When to use** and **When NOT to use** subsections.
- §7 Common Mistakes & Best Practices — each mistake: what people do, why it hurts, what to do instead.
- §8 Production — **failure scenarios** (concrete: "at 2am, X happens, symptom Y, root cause Z, fix"), metrics to watch, scaling notes.
- §9 Interview Questions — at least **10**, format EXACTLY:
  ```
  **Q: Question text ending with a question mark?**
  A: Answer paragraph (3–8 sentences, reasoning-first).
  ```
  Blank line between Q/A pairs. At least **3** questions must be tagged Senior, written exactly like `**Q: How would you shard this table without downtime? (Senior)**` — the literal text `(Senior)` must appear. Mix conceptual, debugging, and design questions.
- §10 Quick Revision — a markdown table + 5–10 bullet "remember this" points.
- §11 Hands-On Exercises — 4–6 runnable exercises (Docker `postgres:17` + psql is the default lab), plus a mini project.
- §12 Related Topics — sibling chapters (linked), SQL Handbook links (linked), other handbooks (linked), and 5–8 free resources in the format `- **Title** — Source · *Level* · one-line why. <URL>`.

## Case-study chapters 31–40 (same 12 H2 headings, content re-purposed)
- §1 Overview — the product, the requirements (functional + non-functional), and a workload estimate with numbers (users, DAU, QPS, read/write ratio, data size & growth). Why a naive schema breaks.
- §2 Core Concepts — the domain entities & invariants that MUST hold (e.g. "never oversell", "debits = credits").
- §3 Theory & Principles — access patterns ranked by frequency; consistency boundaries (where strong, where eventual) with reasons; svg diagram.
- §4 Architecture & Workflow — data architecture diagram (svg): which stores (Postgres / Redis / Kafka / Cassandra / object storage…), which service owns what, the write path and read path of the critical flows.
- §5 Implementation — the core schema DDL (PostgreSQL), indexes justified by access patterns, and the **critical transactions written out in SQL** (e.g. the reserve-inventory transaction, the transfer transaction), with the concurrency control choice explained. Include an application-code snippet for the trickiest flow.
- §6 Trade-offs — alternatives considered and rejected, with a table; when this design is wrong.
- §7 Common Mistakes — the classic wrong designs for this system and why they fail.
- §8 Production — scaling path (reference [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) ladder: what you do at 10x, 100x), failure scenarios, monitoring, backups/DR, data lifecycle.
- §9 ≥10 interview Qs (≥3 Senior) — the follow-ups an interviewer asks in this design round.
- §10 Cheat sheet — the design on one screen. §11 — exercises that extend the design. §12 — links (heavily link concept chapters 01–30 this design relies on) + resources.
Case studies must link back to the concept chapters they apply (≥6 sibling links). They must feel like a design interview answer, not a schema dump.
Existing system-design case studies (system-design/markdown/34-design-chat-whatsapp, 37-design-youtube, 38-design-uber, 33-design-news-feed) cover the whole system; yours focus on the **data layer** — skim them and don't duplicate.

## SVG rules (the gate XML-parses every ```svg block; malformed = fail)
- Fence: ```svg … ``` containing exactly one `<svg viewBox="0 0 W H" width="100%" height="H" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">` root.
- At least **2** svg diagrams per chapter, each genuinely explaining a mechanism (flows, timelines, page layouts, lock queues, replication topologies, state machines, decision trees). Not decorative.
- Well-formed XML: escape `&` as `&amp;`, `<` in text as `&lt;`, `>` as `&gt;`; never put `--` inside `<!-- comments -->` (better: no comments). Close every tag. Quote every attribute.
- Marker ids must be unique within the chapter (e.g. prefix with chapter number: `id="c05a1"`), because multiple svgs share one page DOM.
- Fixed light palette (diagrams render on a white card in both themes): text `#1e293b`/`#334155`, borders `#94a3b8`, accents blue `#2563eb`/`#dbeafe`, green `#16a34a`/`#dcfce7`, red `#dc2626`/`#fee2e2`, amber `#d97706`/`#fef3c7`, purple `#7c3aed`/`#ede9fe`. Keep text ≥ 9px and inside boxes; keep widths ≤ 900.
- Before finishing, validate: `python3 -c "import re,sys,xml.dom.minidom as m;t=open(sys.argv[1]).read();[m.parseString(s.strip()) for s in re.findall(r'\`\`\`svg\s*(.*?)\`\`\`',t,re.S)];print('ok')" database-design/markdown/<slug>.md`

## Length & depth
Target **450–700 lines** per chapter (floor enforced: 150). Deep, specific, correct. Paragraphs, not just bullets. Use real numbers (latencies, page sizes, defaults) and real config names.

## ACCURACY SHEET (get these right; PostgreSQL 16/17 unless noted)
- PG heap pages are 8 KB; tuples carry xmin/xmax/ctid/infomask; UPDATE writes a NEW tuple version (no in-place update); HOT updates avoid index writes when no indexed column changes and the page has room (fillfactor). Old versions live in the heap itself — **PostgreSQL has no undo log**; InnoDB keeps old versions in **undo logs** (rollback segments) and purges them; InnoDB tables are **clustered on the primary key** (secondary indexes store the PK), PG tables are heaps with separate indexes pointing at ctids. InnoDB page = 16 KB.
- Vacuum marks dead tuples reusable (does not shrink files except trailing pages); VACUUM FULL / pg_repack rewrite. autovacuum triggers via autovacuum_vacuum_threshold (50) + scale_factor (0.2). XIDs are 32-bit; wraparound protection via freezing; anti-wraparound autovacuum near autovacuum_freeze_max_age (200M); near ~2^31 XIDs of age the database stops assigning new XIDs (refuses writes) to protect itself — don't quote a more precise threshold. Long-running/idle-in-transaction sessions and stale replication slots hold back the xmin horizon → bloat.
- PG isolation: READ UNCOMMITTED behaves as READ COMMITTED; REPEATABLE READ is **snapshot isolation** (no phantoms in PG, but write skew possible; concurrent update of same row → `could not serialize access due to concurrent update`, SQLSTATE 40001); SERIALIZABLE is **SSI** (since 9.1) using SIREAD predicate locks, detecting rw-antidependency "dangerous structures", aborting with 40001 — apps must retry. MySQL InnoDB default is REPEATABLE READ with consistent snapshot for plain SELECTs but **locking reads/UPDATEs read the latest committed version** and use **next-key/gap locks** to block phantoms; MySQL SERIALIZABLE converts plain SELECTs to locking reads (LOCK IN SHARE MODE). PG default is READ COMMITTED; READ COMMITTED takes a new snapshot per statement and UPDATE re-checks the WHERE on the latest row version (EvalPlanQual).
- PG row locks are stored in the tuple (xmax + infomask), not a shared lock table; row-lock waits appear as waits on the holder's transactionid. Row lock modes: FOR UPDATE, FOR NO KEY UPDATE, FOR SHARE, FOR KEY SHARE. Table lock modes: 8 levels ACCESS SHARE … ACCESS EXCLUSIVE. Lock queue: a waiting ACCESS EXCLUSIVE (e.g. ALTER TABLE) blocks all later ACCESS SHARE requests behind it — the classic "migration takes the site down" incident → use lock_timeout. Deadlock detection runs after deadlock_timeout (default 1s); victim gets SQLSTATE 40P01. InnoDB detects deadlocks immediately (innodb_deadlock_detect) and has innodb_lock_wait_timeout (50s default).
- WAL: record written and flushed before the data page (WAL rule); commit = append commit record + fsync WAL up to its LSN (synchronous_commit=on). synchronous_commit=off risks losing the last few hundred ms of commits (wal_writer_delay 200ms × up to 3) but never corrupts. Group commit amortises fsync (commit_delay/commit_siblings). Checkpoints: checkpoint_timeout default 5min, max_wal_size default 1GB; full_page_writes protects against torn pages (first modification of a page after a checkpoint logs the full page image). PG recovery is **redo-only** (uncommitted changes are simply invisible because their xid never committed in CLOG/pg_xact). InnoDB does redo (redo log) then rolls back uncommitted txns via undo; MySQL binlog + redo two-phase internal commit (XA between binlog and InnoDB). ARIES = analysis/redo/undo.
- Replication: PG physical streaming replication ships WAL (byte-identical replica, same major version, whole cluster); logical replication (PG 10+) publications/subscriptions, row-level, cross-version, per table. synchronous_standby_names with FIRST/ANY quorum; synchronous_commit levels remote_write / on / remote_apply. Replication slots retain WAL — an abandoned slot can fill the disk (max_slot_wal_keep_size caps it). Lag views: pg_stat_replication (write_lag/flush_lag/replay_lag), pg_last_xact_replay_timestamp() on replica. MySQL: binlog (row-based), semi-synchronous replication, GTIDs, Group Replication.
- HA: PG has no built-in automatic failover; Patroni (with etcd/Consul/ZooKeeper DCS) or cloud managed (RDS Multi-AZ, Aurora). Fencing/STONITH prevents split brain; pg_rewind to rejoin an old primary.
- Consensus: Raft — terms, RequestVote, AppendEntries, majority quorum (2f+1 tolerates f), election timeout randomised, log matching, commit when replicated on majority of current term. etcd, Consul, CockroachDB (Raft per range), TiKV, Kafka KRaft. Paxos exists; Raft is the teachable one.
- CAP (Brewer 2000, Gilbert & Lynch 2002 proof): C = linearizability, A = every request to a non-failed node gets a non-error response, P = arbitrary message loss. Only choice is during a partition. PACELC (Abadi) adds latency vs consistency else-case. Dynamo-style (Cassandra, DynamoDB default) tunable; Spanner is CP with very high availability via TrueTime & private network.
- 2PC: PG PREPARE TRANSACTION / COMMIT PREPARED needs max_prepared_transactions > 0 (default 0); orphaned prepared txns hold locks and the xmin horizon. Coordinator failure after prepare = participants block (in-doubt). MySQL supports XA.
- Distributed SQL: Spanner (TrueTime, Paxos groups), CockroachDB (ranges ~512MB default range size in recent versions, Raft, leaseholders, HLC), YugabyteDB (DocDB tablets, Raft), Citus (PG extension, coordinator + workers, distribution column), Vitess (MySQL sharding, VTGate, keyspace/vindex).
- Pooling: PG uses a process per connection (~ several MB each; max_connections default 100). PgBouncer modes: session / transaction / statement; transaction pooling breaks session state (SET, advisory locks, LISTEN, temp tables); PgBouncer ≥1.21 supports protocol-level prepared statements in transaction mode. Timeouts: statement_timeout, lock_timeout, idle_in_transaction_session_timeout, idle_session_timeout.
- Backups: pg_dump (logical, consistent snapshot), pg_basebackup (physical), WAL archiving (archive_command / archive_library) + base backup = PITR via recovery_target_time; pgBackRest / Barman / WAL-G. PG 17 adds incremental backup in pg_basebackup (--incremental + pg_combinebackup). MySQL: mysqldump, XtraBackup, binlog for PITR.
- Migrations: PG 11+ `ADD COLUMN ... DEFAULT <constant>` is metadata-only (non-volatile default); CREATE INDEX CONCURRENTLY (can't run in a txn; leaves INVALID index on failure); ADD CONSTRAINT ... NOT VALID then VALIDATE CONSTRAINT (lighter lock); changing column type usually rewrites the table. MySQL: ALGORITHM=INSTANT/INPLACE, gh-ost / pt-online-schema-change.
- Monitoring views: pg_stat_activity (wait_event_type/wait_event), pg_stat_statements, pg_stat_user_tables (n_dead_tup, last_autovacuum), pg_statio_* / pg_stat_database (blks_hit/blks_read), pg_locks, pg_blocking_pids(), pg_stat_replication, pg_stat_wal, pg_stat_bgwriter / pg_stat_checkpointer (PG17), pg_stat_io (PG16).
- Never state a number you aren't confident of; phrase as "on the order of" instead.

## Style
- Second person, direct, confident; short paragraphs; bold key terms on first use.
- Tables for comparisons; ```text blocks for timelines like `T1: BEGIN ... T2: ...`.
- Callouts: `> **Why this matters:**`, `> **MySQL difference:**`, `> **Interview tip:**`, `> **Production story:**`.
- No emojis in headings. No filler. No "In conclusion".

## Self-check before you report done
Run the gate and make sure YOUR chapters' rows say OK (others will show MISSING until other authors finish — ignore those):
`python3 tools/hb_pipeline.py gate tools/topics/database_design_topics.json`
Also grep your file: every `topic.html?p=` slug you used must exist (`ls database-design/markdown` for siblings may not all exist yet — use manifest slugs; for sql/ and other handbooks verify with ls).
Report: per chapter — lines, svg count, Q count, Senior count, and the SQL chapters you linked instead of re-teaching.
