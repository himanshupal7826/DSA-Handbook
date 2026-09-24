# 28 · Data Lifecycle: Hot, Warm, Cold & Deletion

> **In one line:** Every row has a life — written hot, read less and less, eventually archived or destroyed — and a database that is not designed for the end of that life grows until it is slow, expensive and legally risky, so plan retention, tiering and deletion into the schema from day one.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Partitioning & Sharding](../sql/topic.html?p=23-partitioning) (declarative partitioning syntax, `DROP`/`DETACH PARTITION`) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) (partition keys and pruning in production) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (why deletes leave dead tuples) · [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery). This chapter assumes you know how to partition a table and focuses on what happens to data *over time*.

Most schemas are designed for the first day of a row's life: how it is inserted, indexed and queried while it is fresh. Almost none are designed for day 400, when the row is read once a quarter, or day 2,000, when a regulation says it must be gone, or the day a customer asks you to erase everything you know about them. The result is predictable. The `events` table grows by 50 GB a month forever. Its indexes no longer fit in memory, so even queries about today get slower. Backups take longer every week. Storage bills grow linearly with time while the value of the old data decays toward zero. And when someone finally writes `DELETE FROM events WHERE created_at < now() - interval '2 years'`, the replicas fall hours behind and the table does not get any smaller.

The problem exists because **access frequency decays with age but storage cost does not**. On a typical OLTP system, the vast majority of reads touch data from the last days or weeks; older data is touched by occasional support lookups, audits and analytics. Yet in a single table on a single tier of fast SSD, a two-year-old row costs exactly as much to store, back up, and carry in index pages as a two-minute-old one — and it actively hurts the new rows by diluting the buffer cache.

The naive fixes fail in specific ways. **"Keep everything forever"** fails on cost, performance and law (data protection rules require you to keep personal data no longer than necessary). **"Run a nightly `DELETE` of old rows"** works at small scale but at large scale produces write amplification, WAL bursts, replica lag, and bloat that vacuum can reuse but not return. **"We will deal with it when it's a problem"** fails because the cheap fix — partitioning by time — is easy when the table is empty and a major migration when it holds 3 TB.

This chapter treats the lifecycle as a design dimension: classify data by temperature, pick the storage and access path for each tier, make expiry cheap by designing it into the physical layout, delete safely when you must delete row by row, and handle the special, hard case of deleting personal data that has already been copied into replicas, caches, analytics and backups.

## 2. Core Concepts

- **Hot / warm / cold data** — hot is read and written constantly (last hours–weeks); warm is read occasionally (months); cold is rarely or never read but must be retained (years). *Why it matters:* each tier deserves a different cost/latency point.
- **Retention policy** — the rule stating how long each class of data is kept and why (business need, legal minimum, legal maximum). *Why it matters:* without a written policy, nobody is allowed to delete anything, and data accumulates by default.
- **Archiving** — moving data out of the primary OLTP tables into cheaper storage while keeping it retrievable. *Why it matters:* shrinks the hot working set without losing history.
- **TTL (time to live)** — per-row or per-item expiry enforced by the store. *Why it matters:* some stores (Cassandra, DynamoDB, MongoDB, Redis) delete expired data for you; PostgreSQL and MySQL do not.
- **Partition expiration** — removing old data by dropping or detaching whole time partitions. *Why it matters:* a catalog operation instead of millions of row deletions.
- **Bloat** — space occupied by dead tuples and half-empty pages after deletes and updates. *Why it matters:* `DELETE` makes space reusable but does not shrink files; indexes stay large too.
- **History table** — a separate table holding prior versions or closed records. *Why it matters:* keeps the current-state table small and fast while preserving the past.
- **Right to erasure** — the data-protection concept (e.g. GDPR Article 17) that a person can request deletion of their personal data in many circumstances. *Why it matters:* deletion must reach every copy, which is an architecture problem.
- **Crypto-shredding** — encrypting a subject's data with a per-subject key and "deleting" the data by destroying the key. *Why it matters:* the practical answer to erasure in immutable or hard-to-edit places (backups, logs, event stores).
- **Pseudonymization vs anonymization** — replacing identifiers with tokens (reversible with the mapping) versus irreversibly removing the ability to identify. *Why it matters:* pseudonymized data is generally still personal data; only real anonymization takes data out of scope.
- **Tiered storage** — placing data on media with different cost and latency (NVMe, cheaper block storage, object storage classes, archive). *Why it matters:* storage is usually the largest line item for large databases.
- **Columnar compression** — storing data by column (Parquet, TimescaleDB compressed chunks, Citus columnar) so similar values compress together. *Why it matters:* often several-fold smaller and much faster for analytical scans of cold data.

## 3. Theory & Principles

### Why DELETE is expensive and DROP PARTITION is not

In PostgreSQL a `DELETE` does not remove anything physically. For each matching row it sets the tuple's `xmax` to the deleting transaction ([Ch 03](topic.html?p=03-mvcc)), dirties the page, and writes a WAL record. After the next checkpoint, the first touch of each page also writes a **full page image** to WAL. Deleting 200 M rows therefore dirties every page that holds one of them, generates WAL roughly proportional to the pages touched (often many tens of GB), and ships all of it to every replica and to the WAL archive. Then vacuum must visit each of those pages again to reclaim the dead tuples and remove the corresponding entries from every index — more I/O, more WAL. At the end the table and its indexes are the *same size on disk*; the space is reusable for future inserts but is not returned to the operating system except for empty pages at the very end of the file. And if the `DELETE` ran as one transaction, it held back the xmin horizon for its entire duration, blocking vacuum everywhere else in the database.

`DROP TABLE events_2024_01` (a partition) is a catalog change plus unlinking the partition's files: the space is returned immediately, no per-row WAL is written, no vacuum is needed, and replicas replay one small record. It does need a brief `ACCESS EXCLUSIVE` lock on the partition (and a lock on the parent), so it should run with `lock_timeout`; `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY` (PG 14+) detaches with a weaker lock on the parent first.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c28a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c28a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Expiring a month of data: row-by-row DELETE vs dropping a partition</text>
  <rect x="20" y="40" width="410" height="366" rx="10" fill="#fef2f2" stroke="#dc2626"/>
  <text x="225" y="62" text-anchor="middle" fill="#991b1b" font-weight="bold">DELETE ... WHERE created_at &lt; '2024-02-01'</text>
  <rect x="40" y="78" width="370" height="30" rx="4" fill="#fff" stroke="#fca5a5"/>
  <text x="52" y="97" fill="#7f1d1d">1. scan + set xmax on 200M tuples, dirty every page</text>
  <path d="M225,108 L225,120" stroke="#dc2626" stroke-width="2" marker-end="url(#c28a1)"/>
  <rect x="40" y="122" width="370" height="30" rx="4" fill="#fff" stroke="#fca5a5"/>
  <text x="52" y="141" fill="#7f1d1d">2. WAL per row + full-page images: tens of GB</text>
  <path d="M225,152 L225,164" stroke="#dc2626" stroke-width="2" marker-end="url(#c28a1)"/>
  <rect x="40" y="166" width="370" height="30" rx="4" fill="#fff" stroke="#fca5a5"/>
  <text x="52" y="185" fill="#7f1d1d">3. replicas replay it all: replay_lag grows</text>
  <path d="M225,196 L225,208" stroke="#dc2626" stroke-width="2" marker-end="url(#c28a1)"/>
  <rect x="40" y="210" width="370" height="30" rx="4" fill="#fff" stroke="#fca5a5"/>
  <text x="52" y="229" fill="#7f1d1d">4. vacuum re-reads pages, cleans every index</text>
  <path d="M225,240 L225,252" stroke="#dc2626" stroke-width="2" marker-end="url(#c28a1)"/>
  <rect x="40" y="254" width="370" height="30" rx="4" fill="#fee2e2" stroke="#dc2626"/>
  <text x="52" y="273" fill="#7f1d1d" font-weight="bold">5. file size unchanged: space reusable, not returned</text>
  <text x="40" y="310" fill="#991b1b">Heap after: [live][dead][dead][live][dead][dead] ...</text>
  <text x="40" y="330" fill="#991b1b">One big txn also pins the xmin horizon for hours.</text>
  <text x="40" y="350" fill="#991b1b">To actually shrink: pg_repack / VACUUM FULL (rewrite).</text>
  <text x="40" y="380" fill="#991b1b" font-weight="bold">Cost is O(rows deleted) and paid 3 times:</text>
  <text x="40" y="396" fill="#991b1b" font-weight="bold">primary, every replica, vacuum.</text>
  <rect x="450" y="40" width="410" height="366" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="655" y="62" text-anchor="middle" fill="#166534" font-weight="bold">DROP TABLE events_2024_01 (a partition)</text>
  <rect x="470" y="80" width="80" height="44" rx="4" fill="#e2e8f0" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="510" y="100" text-anchor="middle" fill="#334155">2024_01</text>
  <text x="510" y="116" text-anchor="middle" fill="#334155">dropped</text>
  <rect x="558" y="80" width="80" height="44" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="598" y="100" text-anchor="middle" fill="#78350f">2024_02</text>
  <text x="598" y="116" text-anchor="middle" fill="#78350f">cold</text>
  <rect x="646" y="80" width="80" height="44" rx="4" fill="#fef3c7" stroke="#d97706"/>
  <text x="686" y="100" text-anchor="middle" fill="#78350f">...</text>
  <text x="686" y="116" text-anchor="middle" fill="#78350f">warm</text>
  <rect x="734" y="80" width="106" height="44" rx="4" fill="#dcfce7" stroke="#16a34a"/>
  <text x="787" y="100" text-anchor="middle" fill="#14532d">2026_09</text>
  <text x="787" y="116" text-anchor="middle" fill="#14532d">hot, in cache</text>
  <path d="M655,140 L655,160" stroke="#16a34a" stroke-width="2" marker-end="url(#c28a2)"/>
  <rect x="470" y="164" width="370" height="30" rx="4" fill="#fff" stroke="#86efac"/>
  <text x="482" y="183" fill="#14532d">1. brief ACCESS EXCLUSIVE (use lock_timeout)</text>
  <rect x="470" y="202" width="370" height="30" rx="4" fill="#fff" stroke="#86efac"/>
  <text x="482" y="221" fill="#14532d">2. catalog update + unlink files: space freed now</text>
  <rect x="470" y="240" width="370" height="30" rx="4" fill="#fff" stroke="#86efac"/>
  <text x="482" y="259" fill="#14532d">3. a few WAL records: replicas unaffected</text>
  <rect x="470" y="278" width="370" height="30" rx="4" fill="#fff" stroke="#86efac"/>
  <text x="482" y="297" fill="#14532d">4. no dead tuples, no vacuum, indexes gone with it</text>
  <text x="470" y="340" fill="#166534">Optional first: DETACH PARTITION ... CONCURRENTLY,</text>
  <text x="470" y="356" fill="#166534">export to Parquet, verify, then DROP.</text>
  <text x="470" y="390" fill="#166534" font-weight="bold">Cost is O(1) in rows. Design for this on day one.</text>
</svg>
```

### Data temperature is a property of access, not age

Age is a proxy. What actually matters is how often and how fast each piece of data is read, and by whom. An order is hot for the days it is being fulfilled, warm during the return window, and cold afterwards — unless it is part of an open dispute. A user profile is hot for as long as the user is active, regardless of when it was created. So classify by access pattern:

| Tier | Typical access | Latency need | Where it lives | Example |
|---|---|---|---|---|
| Hot | per request, constantly | ms | primary tables, in buffer cache, fast SSD | last 30 days of orders |
| Warm | occasional lookups, reports | tens–hundreds of ms | older partitions, maybe compressed; a replica or cheaper tablespace | orders 1–12 months old |
| Cold | rare: audits, legal, analytics | seconds–hours | object storage (Parquet), a warehouse, archive storage classes | orders 1–7 years old |
| Gone | never | — | deleted, keys destroyed | beyond legal retention |

The hard design question is always the *boundary* crossing: how does data move from hot to warm to cold, how are queries that need both served, and what happens to foreign keys and indexes that span the boundary.

### TTL: stores that expire for you, and the ones that don't

Several stores have built-in expiry, and each has an important footnote:

- **Cassandra** — per-write `USING TTL`; expired cells become tombstones that are purged only by compaction after `gc_grace_seconds` (10 days by default). Time-series tables should use TimeWindowCompactionStrategy so whole SSTables expire together and are dropped without tombstone scans. See [Cassandra · TTL, Counters & Static Columns](../cassandra/topic.html?p=15-ttl-counters-static-columns) and [Tombstones & Deletes](../cassandra/topic.html?p=24-tombstones-deletes).
- **DynamoDB** — a TTL attribute holding an epoch timestamp; a background process deletes expired items without consuming write capacity, but not instantly (AWS documents deletion typically within a few days), so reads must filter expired items themselves.
- **MongoDB** — a TTL index (`expireAfterSeconds`); a background monitor removes expired documents periodically (about every 60 seconds), as ordinary deletes.
- **Redis** — `EXPIRE` per key, lazy plus active sampling expiry (see [Caching with Redis · Keys, TTL & Expiration](../redis-caching/topic.html?p=06-keys-ttl-expiration)).
- **PostgreSQL / MySQL** — no TTL. You implement expiry with jobs (`pg_cron`, an external scheduler) that drop partitions or delete in batches. This is not a weakness to paper over: explicit jobs give you control, observability and the chance to archive before deletion.

## 4. Architecture & Workflow

### A lifecycle pipeline for a large event table

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c28b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Hot to warm to cold to gone: each arrow is a scheduled, observable job</text>
  <rect x="20" y="44" width="190" height="150" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="115" y="66" text-anchor="middle" fill="#991b1b" font-weight="bold">HOT (0-30 days)</text>
  <text x="32" y="88" fill="#1e293b">daily partitions</text>
  <text x="32" y="106" fill="#1e293b">all indexes, in RAM</text>
  <text x="32" y="124" fill="#1e293b">NVMe, primary + replicas</text>
  <text x="32" y="142" fill="#1e293b">fillfactor tuned for updates</text>
  <text x="32" y="176" fill="#991b1b" font-weight="bold">~5% of rows, ~95% of reads</text>
  <rect x="240" y="44" width="190" height="150" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="335" y="66" text-anchor="middle" fill="#92400e" font-weight="bold">WARM (1-12 months)</text>
  <text x="252" y="88" fill="#1e293b">monthly partitions</text>
  <text x="252" y="106" fill="#1e293b">fewer indexes, read-only</text>
  <text x="252" y="124" fill="#1e293b">lz4 TOAST / columnar</text>
  <text x="252" y="142" fill="#1e293b">cheaper tablespace (rewrite!)</text>
  <text x="252" y="176" fill="#92400e" font-weight="bold">support lookups, reports</text>
  <rect x="460" y="44" width="190" height="150" rx="10" fill="#dbeafe" stroke="#2563eb"/>
  <text x="555" y="66" text-anchor="middle" fill="#1e40af" font-weight="bold">COLD (1-7 years)</text>
  <text x="472" y="88" fill="#1e293b">Parquet in object storage</text>
  <text x="472" y="106" fill="#1e293b">partitioned by month</text>
  <text x="472" y="124" fill="#1e293b">queried via DuckDB/Athena/</text>
  <text x="472" y="142" fill="#1e293b">warehouse, not the OLTP DB</text>
  <text x="472" y="176" fill="#1e40af" font-weight="bold">audits, analytics, legal</text>
  <rect x="680" y="44" width="180" height="150" rx="10" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="770" y="66" text-anchor="middle" fill="#334155" font-weight="bold">GONE</text>
  <text x="692" y="88" fill="#1e293b">object lifecycle rule</text>
  <text x="692" y="106" fill="#1e293b">deletes files after N years</text>
  <text x="692" y="124" fill="#1e293b">backups age out on their</text>
  <text x="692" y="142" fill="#1e293b">own retention schedule</text>
  <text x="692" y="176" fill="#334155" font-weight="bold">documented, auditable</text>
  <path d="M210,120 L238,120" stroke="#334155" stroke-width="2" marker-end="url(#c28b1)"/>
  <path d="M430,120 L458,120" stroke="#334155" stroke-width="2" marker-end="url(#c28b1)"/>
  <path d="M650,120 L678,120" stroke="#334155" stroke-width="2" marker-end="url(#c28b1)"/>
  <rect x="20" y="214" width="840" height="170" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="236" text-anchor="middle" fill="#1e293b" font-weight="bold">The jobs behind the arrows (all idempotent, all alerting on failure)</text>
  <text x="36" y="260" fill="#334155">create-ahead: premake partitions for the next N days (pg_partman run_maintenance), alert if the newest partition is &lt; 3 days ahead</text>
  <text x="36" y="282" fill="#334155">hot to warm: merge daily partitions into a monthly one, drop redundant indexes, optionally compress (Timescale) or move tablespace</text>
  <text x="36" y="304" fill="#334155">warm to cold: DETACH CONCURRENTLY, export to Parquet, verify row counts + checksums, write manifest, then DROP</text>
  <text x="36" y="326" fill="#334155">cold to gone: object lifecycle expiration; retention clock is per data class, written in the policy</text>
  <text x="36" y="348" fill="#334155">erasure: per-subject jobs across hot/warm (DELETE), cold (rewrite file or crypto-shred), caches, search, analytics</text>
  <text x="36" y="372" fill="#1e293b" font-weight="bold">Queries that need all tiers go through a UNION view or a federated engine, never by keeping everything hot.</text>
</svg>
```

### Designing the schema for expiry

Lifecycle is cheap only if the physical layout lines up with the retention boundary:

- **Partition key = retention key.** If retention is "90 days after `created_at`", partition by `created_at`. If retention is "7 years after the account closes", time partitioning on `created_at` does not line up and you need either a different partition key or row-level deletes.
- **Unique constraints must include the partition key** in PostgreSQL, which often means `PRIMARY KEY (id, created_at)`. Decide this at creation time.
- **Foreign keys into partitioned history are a trap.** A FK from a hot table to a row that is about to be archived blocks the drop (or cascades). Reference immutable things (users, products), not things that expire, or denormalize the needed fields into the child.
- **Keep current state and history separate.** A `subscriptions` table with one row per subscription, and a `subscription_events` history table that is partitioned and expired, beats one table with every version of every row.

### Historical tables

A history table is the lifecycle tool for *mutable* data. The current table stays small (one row per entity, hot); every change appends the old version to `*_history`, which is time-partitioned and follows the hot/warm/cold path on its own schedule. The design choices — trigger versus application writes, system time versus business effective time, how to query "as of" — are covered in [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) under temporal data. From a lifecycle perspective the rule is simple: history tables must be partitioned by the time the version *ended*, so that expiry drops whole partitions.

### The erasure workflow

Deleting one person's data is the opposite problem to deleting a month: few rows, but scattered across many tables, services and copies.

```text
request received ──▶ identity verified ──▶ legal hold / retention exceptions checked
     │                                         (e.g. invoices kept for tax law)
     ▼
erasure job keyed by subject_id  (idempotent, tracked in erasure_requests table)
     ├─ OLTP: delete or anonymize rows in every table holding the subject  (data map!)
     ├─ search index, caches, CDN: delete by key / purge
     ├─ analytics warehouse: delete, or data was only ever pseudonymized
     ├─ event logs / Kafka topics: compacted tombstones or crypto-shred
     ├─ cold Parquet: rewrite affected files, or crypto-shred
     └─ backups: not edited; they expire; on restore, replay erasure_requests
     ▼
completion recorded with evidence (what, where, when) — never the deleted data itself
```

Two things make this tractable. First, a **data map**: a maintained inventory of which tables and stores hold personal data and keyed by what. Without it, the job will miss copies. Second, **design so erasure is cheap**: keep personal data in a small number of tables keyed by `user_id`, reference it by ID elsewhere, and avoid copying names and emails into dozens of denormalized places.

**The backups problem.** Editing every backup to remove one person is usually impractical (and it would break backup integrity). The approach commonly used is: backups are access-restricted and put "beyond use", they expire on a short enough schedule, and the list of erasure requests is kept (by ID, not content) so that after any restore, the erasures are re-applied before the data is used. For data that must be unrecoverable immediately everywhere — including backups, logs and immutable event stores — **crypto-shredding** is the tool: personal fields are encrypted with a per-subject data key, the key is stored separately (a KMS-backed key table), and erasure destroys the key. Every copy of the ciphertext, in every backup, becomes noise.

> **Why this matters:** This chapter explains engineering mechanisms, not legal requirements. What must be deleted, when, with what exceptions, and whether a given technique satisfies a regulation are questions for your legal and privacy teams. Your job is to make any policy they choose *implementable*.

## 5. Implementation

### Simple example: partitioned events with automated retention

```sql
CREATE TABLE events (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  account_id  bigint      NOT NULL,
  created_at  timestamptz NOT NULL,
  kind        text        NOT NULL,
  payload     jsonb,
  PRIMARY KEY (id, created_at)                  -- must include the partition key
) PARTITION BY RANGE (created_at);

CREATE INDEX ON events (account_id, created_at DESC);  -- created on each partition

-- pg_partman creates future partitions and enforces retention
CREATE EXTENSION pg_partman;   -- (schema placement per your conventions)
SELECT partman.create_parent(p_parent_table => 'public.events',
                             p_control => 'created_at', p_interval => '1 day',
                             p_premake => 7);
UPDATE partman.part_config
   SET retention = '90 days', retention_keep_table = false
 WHERE parent_table = 'public.events';
-- scheduled (pg_cron or the partman background worker):
CALL partman.run_maintenance_proc();
```

If you manage partitions yourself, the retention step is:

```sql
SET lock_timeout = '3s';
ALTER TABLE events DETACH PARTITION events_p20260601 CONCURRENTLY;  -- PG 14+, not in a txn
-- export / verify here if the data goes to cold storage
DROP TABLE events_p20260601;
```

`DETACH ... CONCURRENTLY` cannot run inside a transaction block and is not allowed when the table has a default partition; if it is interrupted, finish it with `ALTER TABLE events DETACH PARTITION events_p20260601 FINALIZE`.

### Real-world example 1: exporting cold partitions to Parquet

The pattern: detach, export, verify, record a manifest, drop. DuckDB is a convenient exporter because it can read PostgreSQL directly and write Parquet to object storage:

```sql
-- in DuckDB
INSTALL postgres; LOAD postgres; INSTALL httpfs; LOAD httpfs;
ATTACH 'host=pg-replica dbname=app user=archiver' AS pg (TYPE postgres, READ_ONLY);

COPY (SELECT * FROM pg.public.events_p202501 ORDER BY account_id, created_at)
  TO 's3://acme-archive/events/month=2025-01/part-0.parquet'
  (FORMAT parquet, COMPRESSION zstd);

-- verify before dropping anything
SELECT count(*), min(created_at), max(created_at)
FROM read_parquet('s3://acme-archive/events/month=2025-01/*.parquet');
```

Compare the count and time range with the source partition, store them (plus file checksums) in an `archive_manifest` table in PostgreSQL, and only then drop the partition. Sorting by `account_id` before writing makes Parquet's per-row-group min/max statistics effective, so a later "all events for account 42 in January 2025" reads a fraction of the file. Object lifecycle rules then move the files to infrequent-access or archive storage classes and eventually delete them.

Queries that occasionally need old data should hit the archive through a separate engine (DuckDB, Athena/Trino, the warehouse), not through a foreign table joined into OLTP queries in production — cold reads should never compete with hot traffic.

### Real-world example 2: safe mass deletion when you cannot drop partitions

Sometimes retention does not line up with partitions (legacy table, retention by a different column). Then you delete in batches:

```sql
-- supporting index: the deletion predicate must be an index range scan
CREATE INDEX CONCURRENTLY IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- one batch; loop from a script, committing each time
WITH doomed AS (
  SELECT ctid FROM sessions
  WHERE expires_at < now() - interval '30 days'
  ORDER BY expires_at
  LIMIT 5000
  FOR UPDATE SKIP LOCKED              -- never fight the application for rows
)
DELETE FROM sessions s USING doomed d WHERE s.ctid = d.ctid;
```

The driver loop commits after each batch, sleeps proportional to batch time, pauses when `pg_stat_replication.replay_lag` exceeds a threshold, and stops at a time budget (e.g. only between 01:00 and 05:00). Watch the effect on vacuum:

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables WHERE relname = 'sessions';
```

```text
 relname  | n_live_tup | n_dead_tup | last_autovacuum
----------+------------+------------+-------------------------------
 sessions |   18402113 |    9120442 | 2026-09-22 03:10:44.12+00
```

If dead tuples keep climbing, lower the table's `autovacuum_vacuum_scale_factor` (the default 0.2 means vacuum waits for 20% of the table to be dead) or slow the deletion. After a one-off purge of most of a table, the file stays large; `pg_repack` rebuilds it online if you need the space back. Better yet, for a table where you would delete most rows, **copy the survivors instead**: create a new table, copy the rows you keep, swap names in a short transaction — less WAL than deleting the majority.

Moving rows to an archive table atomically is a single statement:

```sql
WITH moved AS (
  DELETE FROM orders
  WHERE id IN (SELECT id FROM orders
               WHERE status = 'closed' AND closed_at < now() - interval '2 years'
               ORDER BY id LIMIT 2000)
  RETURNING *)
INSERT INTO orders_archive SELECT * FROM moved;
```

### Storage cost optimization inside PostgreSQL

- **TOAST** compresses and moves large values out of line once a row exceeds roughly 2 KB. Since PG 14 you can choose `lz4` (faster than the default `pglz`): `ALTER TABLE events ALTER COLUMN payload SET COMPRESSION lz4;` — applies to newly written values only.
- **Drop unused indexes**: they cost storage, cache, WAL and backup time. `SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) FROM pg_stat_user_indexes WHERE idx_scan = 0;` (check every replica too; stats are per node).
- **Fewer indexes on old partitions**: indexes can be created per partition, so warm partitions can carry only what their queries need.
- **Columnar for analytical history**: TimescaleDB compression converts old chunks to a columnar layout, often shrinking them by an order of magnitude; Citus provides a columnar table access method; for true analytics, move cold data to a warehouse or lakehouse.
- **Tablespaces on cheaper disks**: `ALTER TABLE events_p202501 SET TABLESPACE slow_disk` works but *rewrites* the partition under `ACCESS EXCLUSIVE`, so do it only for partitions nobody writes to. In managed cloud databases this usually is not available; there, the cheap tier is object storage.

> **MySQL difference:** InnoDB tables are clustered on the primary key, so a batched `DELETE ... WHERE id BETWEEN ...` is efficient, but deleted space is reclaimed only by rebuilding (`OPTIMIZE TABLE` / `ALTER TABLE ... FORCE`, online for InnoDB). Purge threads remove delete-marked records from the undo log asynchronously; a mass delete grows the **history list length**, which slows reads until purge catches up. Partition expiry is `ALTER TABLE events DROP PARTITION p202401` (no `DETACH`; `EXCHANGE PARTITION` swaps a partition with a standalone table for archiving). MySQL requires the partitioning column in every unique key, and foreign keys are not supported on partitioned InnoDB tables. Row compression is `ROW_FORMAT=COMPRESSED` or transparent page compression.

## 6. Advantages, Disadvantages & Trade-offs

| Technique | Cost of expiry | Complexity | Query impact | Best for |
|---|---|---|---|---|
| Keep everything in one table | none (never expires) | lowest | degrades with age | small, slow-growing data |
| Batched `DELETE` job | O(rows), WAL + vacuum + lag | low | none if throttled | retention not aligned with partitions |
| Time partitions + drop | O(1) | medium (PK includes key, create-ahead) | pruning speeds hot queries | append-mostly time series, logs, events |
| Archive table in same DB | O(rows) moved | low | old data still queryable in SQL | warm data, same backups |
| Export to Parquet/object storage | O(rows) once, cheap storage | medium–high (pipeline, manifest) | cold queries through another engine | years of cold data |
| Store-native TTL (Cassandra/Dynamo/Mongo) | handled by store | low | tombstones / delayed deletes | stores that have it |
| Crypto-shredding | O(1) per subject | high (key mgmt, no indexing on ciphertext) | decrypt on read | erasure across immutable copies |

### When to use

- **Time partitioning with drop-based retention** — any table that grows with time and whose rows expire by age: events, logs, audit trails, metrics, notifications, sessions.
- **Archiving to object storage** — when data must be retained for years but is rarely read, and the storage or backup time of the primary is growing.
- **Crypto-shredding** — personal data that ends up in places you cannot edit: event-sourced streams, long-retention backups, append-only logs.

### When NOT to use

- **Do not partition small tables for retention**: below a few GB, a batched delete job is simpler and fine.
- **Do not archive what you query often**: if support needs 2-year-old orders daily, they are warm, not cold. Moving them to Parquet just shifts cost into slow tooling and angry support staff.
- **Do not crypto-shred everything**: encrypting every column per user prevents indexing and range queries on those columns, and complicates analytics. Use it for the personal fields that need it.
- **Do not rely on TTLs for correctness**: DynamoDB and Cassandra expire lazily; if a user must not see expired data, filter on read.

## 7. Common Mistakes & Best Practices

- **No retention policy at all.** What people do: nothing, because nobody owns deletion. Why it hurts: unbounded growth, cost, and legal exposure for data kept longer than necessary. Instead: a written policy per data class, with an owner and a job that enforces it.
- **Retention as a single giant DELETE.** Hours-long transaction, WAL storm, replica lag, vacuum blocked. Instead: partitions and `DROP`, or batched deletes with throttling.
- **Partitioning after the table is huge.** Converting a 5 TB table to partitions is a major project. Instead: partition by time at creation for anything that grows with time.
- **Forgetting to create future partitions.** Inserts start failing at midnight on the first of the month (`no partition of relation "events" found for row`). Instead: premake partitions days ahead with pg_partman and alert on premake depth; a default partition catches strays but makes later partition creation slower and blocks `DETACH CONCURRENTLY`.
- **Expecting DELETE to free disk space.** It does not. Instead: plan for reuse, or rebuild with pg_repack, or drop partitions.
- **Archiving without verification.** Dropping the source after an export that silently wrote zero rows. Instead: count, time range and checksum comparison recorded in a manifest before any drop.
- **Erasure that misses copies.** Deleting from the users table but not from the search index, the analytics warehouse, the email tool, and the CSV export in a shared drive. Instead: a data map, an erasure job with per-system steps and evidence, and design that minimises copies of personal data.
- **Treating pseudonymized data as anonymous.** Replacing emails with hashes while keeping the mapping (or with unsalted hashes that can be recomputed) is still personal data. Instead: be precise with privacy teams about which one you have.
- **Best practice summary:** retention written down, layout aligned to retention, expiry by dropping, deletion by batches when needed, archives verified, erasure mapped across every copy, and every lifecycle job monitored like production code.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

- **Midnight on the 1st.** Partition creation ran from a cron on a host that was decommissioned. At 00:00 UTC every insert fails with "no partition found". Fix now: create the partition manually. Fix forever: in-database scheduling (pg_cron or partman background worker), premake of at least 7 intervals, and an alert on "newest partition upper bound < now + 3 days".
- **The retention job that lagged the replicas.** At 02:00 a nightly `DELETE FROM audit_log WHERE ts < now() - '1 year'` removes 60 M rows in one statement. Replicas fall 40 minutes behind; read traffic served from replicas shows stale data; the failover candidate is now far behind. Fix: partitions, or batches with lag-based throttling.
- **Disk full from "deleted" data.** The team deleted 70% of a table to save disk, and the disk kept growing, because deleted space is reused only for new rows in that table and the WAL for the delete filled `pg_wal` and the archive. Fix: know the mechanics; drop partitions or copy survivors to a new table.
- **Tombstone overload in Cassandra.** A table with short TTLs written with SizeTieredCompaction accumulates tombstones; reads hit `TombstoneOverwhelmingException`. Fix: TWCS aligned to TTL, and never mixing TTL'd and non-TTL'd data in one table.
- **Erasure resurrected by a restore.** A backup from before an erasure request is restored after an incident; the erased user reappears and receives marketing email. Fix: re-apply the erasure log after every restore as part of the runbook, or crypto-shred.

### Metrics to watch

| Metric | Source | Why |
|---|---|---|
| Table and index size growth per day | `pg_total_relation_size`, stored daily | detects missing retention |
| Premake depth of partitions | catalog query on partition bounds | prevents midnight insert failures |
| Retention job last success / rows removed | job metrics | silent failures accumulate for months |
| `n_dead_tup`, last autovacuum | `pg_stat_user_tables` | deletes outpacing vacuum |
| WAL rate and replica lag during lifecycle jobs | `pg_stat_wal`, `pg_stat_replication` | throttling signal |
| Archive manifest vs source counts | manifest table | proves archives are complete |
| Erasure requests open / oldest age | erasure tracking table | deadlines for data requests |

### Scaling notes

At scale, lifecycle is a platform concern: a shared library or service that knows each table's retention class, creates and drops partitions, exports and verifies archives, and executes erasure fan-out across services. Storage cost optimization compounds: shrinking the hot set improves cache hit rate ([Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning)), which reduces IOPS, which lets you use smaller instances; backups shrink, so RTO improves ([Ch 26](topic.html?p=26-backup-disaster-recovery)). In sharded systems ([Ch 12](topic.html?p=12-sharding)), retention jobs run per shard and must be staggered so they do not all generate WAL and lag at the same minute.

## 9. Interview Questions

**Q: Why is dropping a partition so much cheaper than deleting the same rows?**
A: A `DELETE` in PostgreSQL marks each row dead by setting its `xmax`, dirtying every page it touches and writing WAL for each change, including full-page images after checkpoints; replicas replay all of it and vacuum later revisits every page and index to reclaim the space. The work is proportional to the number of rows, is paid on the primary, every replica and in vacuum, and still leaves the files the same size. Dropping a partition is a catalog change plus unlinking the partition's files, so it writes almost no WAL, frees disk immediately and needs no vacuum. The price is that you must design the table so that retention boundaries line up with partition boundaries.

**Q: What happens to disk usage after deleting half the rows of a large PostgreSQL table?**
A: Almost nothing, at first. The deleted tuples become dead; after vacuum, their space is marked free in the free space map and reused by future inserts and updates into that table, but the data files are not truncated except for completely empty pages at the end. Indexes also retain their size. Meanwhile, the delete itself produced a lot of WAL, which temporarily increases disk use in `pg_wal` and the archive. To actually return space you rewrite the table with `pg_repack` (online) or `VACUUM FULL` (blocking), or you avoid the situation with partitions.

**Q: How would you design retention for an events table that receives 500 million rows a day and must keep 90 days?**
A: I would range-partition by `created_at`, daily, with the primary key including `created_at`, and use pg_partman (or an equivalent job) to premake a week of future partitions and drop partitions older than 90 days, with an alert on premake depth and on job failures. Indexes would be only what the hot queries need, created on the parent so each partition gets them. If older data must remain available for analytics, a job would detach each expiring partition, export it to Parquet in object storage, verify counts, and then drop it. The drops run with `lock_timeout`, and nothing about retention ever requires a row-level `DELETE`.

**Q: How do TTLs differ between Cassandra, DynamoDB, MongoDB and PostgreSQL?**
A: Cassandra supports TTL per write; expired cells become tombstones that are removed only when compaction runs after `gc_grace_seconds`, so the table design and compaction strategy decide how costly expiry is. DynamoDB uses a timestamp attribute and deletes expired items in the background without consuming write capacity, but not immediately, so reads must filter out expired items. MongoDB uses a TTL index with a background monitor that deletes expired documents roughly every minute as normal deletes. PostgreSQL and MySQL have no TTL at all; you implement expiry with scheduled jobs, ideally by dropping partitions.

**Q: How do you safely delete 300 million rows from a live table that is not partitioned?**
A: In small batches, each its own transaction, driven by an index on the deletion predicate, with throttling. Each batch selects a few thousand rows by index range, uses `FOR UPDATE SKIP LOCKED` so it never waits on application transactions, deletes them, and commits so row locks are short and the xmin horizon keeps moving. The driver pauses when replica replay lag or latency rise and stops at a time budget. I would monitor dead tuples and tune per-table autovacuum so vacuum keeps up. If the rows to delete are the majority, I would instead copy the survivors into a new table and swap, which writes much less, and I would plan a partitioned layout so this never happens again.

**Q: What is the difference between pseudonymization and anonymization, and why does it matter for engineering?**
A: Pseudonymization replaces direct identifiers with tokens while keeping a way to re-identify — a mapping table, a key, or a hash that can be recomputed from known inputs. Anonymization irreversibly removes the ability to identify a person, including by combining the data with other sources. The engineering consequence is that pseudonymized data is still personal data under regulations like GDPR, so retention and erasure still apply to it; it reduces risk but does not take the data out of scope. Teams that treat a hashed email column as "anonymous" often keep it forever and replicate it everywhere, which is exactly the wrong outcome.

**Q: What is crypto-shredding and what are its costs?**
A: Crypto-shredding encrypts a subject's personal data with a key dedicated to that subject, stores the keys separately (typically wrapped by a master key in a KMS), and implements deletion by destroying the key. Every copy of the ciphertext — replicas, backups, logs, event streams, exports — becomes unreadable at once, which solves erasure in places you cannot edit. The costs are real: the database cannot index, sort or range-query encrypted columns (you add blind indexes such as keyed hashes for equality lookups), every read needs a decryption step and key lookup, and key management becomes critical infrastructure — lose the key store and you have shredded everyone. It is best applied to the specific personal fields that need it, not to whole tables.

**Q: A user requests erasure. Your data lives in PostgreSQL, Elasticsearch, Redis, a Kafka topic with 30-day retention, a Snowflake warehouse and nightly backups kept for 35 days. How do you design the erasure? (Senior)**
A: I would build an erasure pipeline keyed by subject ID, tracked in an `erasure_requests` table with per-system status so it is idempotent, resumable and auditable, after a check for legal holds or retention obligations like invoices. PostgreSQL rows are deleted or anonymized using a maintained data map of every table that holds personal data; Elasticsearch documents and Redis keys are deleted by ID; Kafka is the hard one, so either the topic is compacted and keyed by subject so a tombstone removes it, or its personal fields are encrypted with a per-subject key that I destroy, or I accept expiry within its 30-day retention if the policy allows. The warehouse gets a delete job or, better, only ever receives pseudonymized data with the mapping held in the OLTP system. Backups are not edited; they are access-restricted and expire within 35 days, and the restore runbook replays the erasure log before restored data is used. I would record completion evidence per system without storing the deleted data itself, and confirm the whole approach with the privacy and legal teams.

**Q: Your primary database is 12 TB and growing 400 GB a month; 90% of reads touch the last 60 days. What is your plan? (Senior)**
A: The hot working set is small, so the goal is to stop paying hot-tier prices and hot-path costs for cold data. I would identify the large tables by size and growth, classify each by access pattern, and agree retention per class with the business and legal teams. The growth tables get time partitioning — often through a new partitioned table with dual writes and a backfill, since converting in place is heavy — then warm partitions get fewer indexes and compression, and cold partitions are exported to Parquet in object storage, verified, and dropped. Old data queries go to an analytics engine, not the primary. I would expect smaller indexes and a better cache hit ratio on the primary, faster backups and restores, and a much slower-growing storage bill, and I would verify with before-and-after metrics rather than assuming.

**Q: How do foreign keys interact with archiving and partition drops? (Senior)**
A: A foreign key from a live table to rows in a partition you want to drop will block the drop or, with `ON DELETE CASCADE`, silently delete live data, so lifecycle and referential design must be decided together. I keep foreign keys pointing at long-lived entities (users, products), not at expiring rows; when a child needs data from an expiring parent, I denormalize the few fields it needs at write time. For partitioned tables referenced by others, PostgreSQL requires the referenced unique key to include the partition key, which often makes such references awkward anyway. When the referencing data and referenced data expire together, co-partitioning both by the same time key and dropping them together keeps integrity without per-row deletes.

**Q: How would you verify that an archive is complete before dropping the source partition?**
A: I would compare facts computed independently on both sides: row count, minimum and maximum of the partition key, and an aggregate checksum such as a sum of hashes of the primary keys, computed on the source partition and on the Parquet files. The results, file paths and object checksums go into an `archive_manifest` table in the database. The drop step is a separate job that only proceeds if the manifest entry exists and matches, and a periodic job samples archived files and runs a query through the cold engine to prove they are readable. Dropping first and verifying later is how teams discover a year later that the export wrote empty files.

## 10. Quick Revision & Cheat Sheet

| Problem | Tool |
|---|---|
| Table grows forever | Retention policy + time partitions + drop |
| Retention not aligned with partitions | Batched delete, throttled, `SKIP LOCKED`, commit per batch |
| Want space back after deletes | `pg_repack`, or copy survivors and swap |
| Old data rarely read but kept | Export to Parquet in object storage, manifest, drop |
| Warm data too big | Fewer indexes, lz4 TOAST, columnar/compressed chunks |
| Expiry in Cassandra / DynamoDB / Mongo | TTL (+ TWCS; filter on read; TTL index) |
| Personal data erasure | Data map + erasure pipeline + erasure log for restores |
| Erasure in immutable copies | Crypto-shredding with per-subject keys |
| MySQL | `DROP PARTITION`, `EXCHANGE PARTITION`, `OPTIMIZE TABLE`, watch history list length |

- Access frequency decays with age; storage cost does not — tier accordingly.
- `DELETE` costs O(rows), three times over (primary, replicas, vacuum), and does not shrink files.
- Align partition key with retention key on day one; include it in the primary key.
- Premake partitions and alert on it; midnight-on-the-1st outages are common.
- Verify archives before dropping; record a manifest.
- Keep personal data in few places keyed by user ID so erasure is tractable.
- Backups are handled by expiry and re-applying erasures after restore, or by crypto-shredding.
- Pseudonymized is not anonymized.

## 11. Hands-On Exercises

Lab: `docker run --name pg -e POSTGRES_PASSWORD=pg -d postgres:17`.

1. **DELETE vs DROP.** Create two identical 20 M-row tables, one plain and one monthly-partitioned. Record `pg_current_wal_lsn()` before and after deleting one month from the first and dropping the month partition from the second; compute WAL bytes with `pg_wal_lsn_diff`. Compare `pg_total_relation_size` afterwards.
2. **Bloat you can see.** Delete 50% of rows from a table, run `VACUUM`, and check the file size and `n_dead_tup`. Then insert new rows and confirm the file does not grow until the free space is used. Finally use `pg_repack` (or `VACUUM FULL` on a test copy) and compare.
3. **Throttled batch delete.** Write the batched delete loop with `SKIP LOCKED`, run `pgbench` updates against the same table concurrently, and graph latency with and without throttling.
4. **Parquet archive.** Export one partition to Parquet with DuckDB, verify counts and time range, record a manifest row, drop the partition, and query the archive for one account's events.
5. **Crypto-shredding toy.** Store a user's email encrypted with `pgcrypto` using a per-user key from a `user_keys` table; take a `pg_dump`; delete the key; show the email in the dump is unrecoverable while other data is intact.

**Mini project — lifecycle manager.** Build a small service that reads a YAML policy (`table`, `partition interval`, `hot days`, `archive after`, `delete after`) and, on a schedule: premakes partitions, exports and verifies partitions past the archive threshold, drops them, and deletes archived files past the delete threshold. Expose metrics (premake depth, last success per table, bytes archived) and an alert rule set. Stretch: add an erasure endpoint that deletes a subject across two tables and a Redis cache and records evidence.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 03 · MVCC](topic.html?p=03-mvcc) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 12 · Sharding](topic.html?p=12-sharding) · [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) · [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery) · [Ch 29 · Advanced Database Patterns](topic.html?p=29-advanced-database-patterns) (history tables, temporal data, event stores and erasure).

**SQL Handbook:** [SQL Handbook · Partitioning & Sharding](../sql/topic.html?p=23-partitioning) (the syntax this chapter builds on) · [SQL Handbook · Locking & MVCC](../sql/topic.html?p=27-locking-mvcc).

**Other handbooks:** [Cassandra · TTL, Counters & Static Columns](../cassandra/topic.html?p=15-ttl-counters-static-columns) · [Cassandra · Tombstones & Deletes](../cassandra/topic.html?p=24-tombstones-deletes) · [Cassandra · Compaction Strategies](../cassandra/topic.html?p=23-compaction-strategies) · [Caching with Redis · Keys, TTL & Expiration](../redis-caching/topic.html?p=06-keys-ttl-expiration) · [Kafka & RabbitMQ · The Log, Offsets & Retention](../messaging/topic.html?p=14-the-log-offsets-retention).

- **Table Partitioning** — PostgreSQL Docs · *Intermediate* · partition maintenance, `DETACH CONCURRENTLY`, and why dropping beats deleting. <https://www.postgresql.org/docs/current/ddl-partitioning.html>
- **Routine Vacuuming** — PostgreSQL Docs · *Intermediate* · what vacuum reclaims and what it does not. <https://www.postgresql.org/docs/current/routine-vacuuming.html>
- **pg_partman** — pgpartman · *Intermediate* · partition creation and retention automation for PostgreSQL. <https://github.com/pgpartman/pg_partman>
- **Expiring items by using DynamoDB Time to Live** — AWS Docs · *Beginner* · TTL semantics and timing caveats. <https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html>
- **TTL Indexes** — MongoDB Docs · *Beginner* · how the TTL monitor removes documents. <https://www.mongodb.com/docs/manual/core/index-ttl/>
- **Art. 17 GDPR — Right to erasure** — gdpr-info.eu · *Beginner* · the text of the right and its exceptions (read with your legal team). <https://gdpr-info.eu/art-17-gdpr/>
- **pg_repack** — reorg · *Intermediate* · reclaim bloat online without long locks. <https://github.com/reorg/pg_repack>

---

*Database Design Handbook — chapter 28.*
