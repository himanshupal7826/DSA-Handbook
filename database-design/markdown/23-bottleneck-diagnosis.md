# 23 · Database Bottleneck Diagnosis: 'The DB Is Slow'

> **In one line:** "The database is slow" is a symptom, not a diagnosis — walk a fixed path from the application inward (pool, CPU, memory, disk, locks, queries, replication, connections, storage, network), use wait events to see what sessions are actually waiting on, and let evidence, not intuition, name the bottleneck before you touch anything.

---

## 1. Overview

It's 14:05. Checkout p99 has gone from 80 ms to 4 seconds. The on-call channel fills with theories: "the database is overloaded", "it's the new release", "Postgres needs more RAM", "restart it". Someone restarts the application pods. It gets worse. Someone else kills a query at random. Twenty minutes later the real cause surfaces: a migration started at 14:03 is waiting for an ACCESS EXCLUSIVE lock behind a long-running analytics query, and every request that touches the `orders` table is queued behind the migration. None of the guesses were even about the right resource.

This is why the naive approach — guess, change something, see if it helps — fails. A database has many independent resources that can saturate (CPU, memory, disk I/O, locks, connections, replication, storage, network), and the symptom looks identical for all of them: queries get slower, the application's pool fills, requests time out. Worse, bottlenecks cascade: a lock wait makes queries slower, which makes sessions hold connections longer (Little's law), which exhausts the pool, which makes the application retry, which adds more connections. By the time you look, *everything* looks bad, and the first thing that went wrong is buried under its consequences.

The fix is a **systematic flow**: start where the user feels it (the application), move inward one layer at a time, and at each layer check a small set of specific signals with a known "bad" shape. The single most powerful tool in PostgreSQL is **wait events** in `pg_stat_activity`: at any instant, each active session is either running on CPU or waiting on something named — a lock, an I/O, a lightweight lock, the client, a replica. Counting sessions by wait event turns "it's slow" into "40 sessions are waiting on `Lock:relation`" in one query.

This chapter gives you the flow, the exact queries and OS commands for each step, what "bad" looks like, the usual causes, and eight production incidents walked end to end.

> **Builds on:** [SQL Handbook · Query Optimization & EXPLAIN](../sql/topic.html?p=21-query-optimization) and [SQL Handbook · Execution Plans](../sql/topic.html?p=22-execution-plans) (reading a plan — linked, not re-taught; this chapter is about *finding* which query and which resource) · [SQL Handbook · Locking & MVCC](../sql/topic.html?p=27-locking-mvcc) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (lock modes and the lock queue) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (bloat and the xmin horizon) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) (pools, timeouts, storms).

> **Why this matters:** In incidents, time-to-diagnosis dominates time-to-recovery. In interviews, "how would you debug a slow database?" is a standard senior question, and a structured answer with specific views and failure patterns stands out immediately.

## 2. Core Concepts

- **Symptom vs cause** — high latency, timeouts and pool exhaustion are symptoms; a lock queue, an I/O cap or a plan flip is a cause. *Why it matters:* fixing symptoms (restarting, raising pool size) usually makes causes worse.
- **Wait event** — what an active backend is currently waiting on (`wait_event_type`, `wait_event` in `pg_stat_activity`); NULL while active means running on CPU. *Why it matters:* it's a live, per-session answer to "where is the time going?"
- **Average active sessions (AAS) / DB load** — the number of sessions active at an instant, averaged over time, broken down by wait event. *Why it matters:* comparing AAS to vCPU count tells you whether you're CPU-saturated or waiting; RDS Performance Insights / Database Insights charts exactly this.
- **Saturation** — work queued because a resource is busy (run queue, I/O queue depth, lock queue, pool wait queue). *Why it matters:* utilization can look moderate while saturation spikes; saturation is what users feel.
- **Blocking chain** — session A waits on B, which waits on C. *Why it matters:* the root blocker (often idle in transaction) is the one to act on, not the hundreds of victims.
- **Plan flip** — the planner switches a statement to a different (worse) plan after statistics change, data grows, or a generic plan is chosen. *Why it matters:* the query text didn't change, so nobody suspects it.
- **xmin horizon** — the oldest snapshot any session or slot still needs; dead tuples newer than it can't be removed. *Why it matters:* a single old transaction can bloat the entire database.
- **Replication slot** — a primary-side record of how much WAL a consumer still needs. *Why it matters:* an inactive slot retains WAL indefinitely and can fill the disk.
- **Burst credits** — cloud mechanism where volumes or instances exceed baseline performance until a credit bucket drains. *Why it matters:* performance drops to baseline without any configuration change.
- **N+1** — issuing one query per item in a loop instead of one query for the set. *Why it matters:* each query is fast, so nothing looks slow in isolation; the database sees 50x the statements.

## 3. Theory & Principles

### Where time goes: the wait-event model

At any moment, a client backend is in one of three conditions: **idle** (waiting for the client to send the next statement), **active and on CPU**, or **active and waiting**. PostgreSQL publishes the wait in `pg_stat_activity.wait_event_type` / `wait_event`. The main types and what they indicate:

| wait_event_type | Typical wait_event values | What it usually means |
|---|---|---|
| (NULL, state = active) | — | Running on CPU (or in a code path without a wait event) |
| `Lock` | `relation`, `transactionid`, `tuple`, `advisory` | Heavyweight lock wait: DDL, row lock contention, blocking chain |
| `LWLock` | `BufferMapping`, `WALWrite`, `LockManager`, `BufferContent` | Internal contention: buffer pressure, WAL write contention, fast-path lock exhaustion |
| `IO` | `DataFileRead`, `WALSync`, `WALWrite`, `DataFileExtend` | Disk: cache misses, commit flush latency, relation extension |
| `Client` | `ClientRead`, `ClientWrite` | Waiting on the application or network (if in a transaction: app is slow between statements) |
| `IPC` | `SyncRep`, `BufferIO`, `ParallelFinish` | Waiting for a synchronous standby, another process's I/O, parallel workers |
| `Timeout` | `PgSleep`, `VacuumDelay` | Deliberate sleeps, vacuum cost delay |
| `Activity` | `WalWriterMain`, `AutoVacuumMain` | Background processes idling (ignore for client diagnosis) |

The diagnostic loop is: sample `pg_stat_activity` several times, count active sessions by wait event, compare the total to vCPUs, and follow the dominant wait. If AAS is 60 on a 16-vCPU box and 55 of them are `Lock:transactionid`, you have a locking problem, not a CPU problem, and adding CPUs will do nothing.

### The systematic flow

```svg
<svg viewBox="0 0 900 640" width="100%" height="640" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c23a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="450" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">"The DB is slow": walk from the user inward, one layer at a time</text>

  <rect x="20" y="40" width="250" height="44" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="145" y="58" text-anchor="middle" fill="#1e293b" font-weight="bold">0. Application</text>
  <text x="145" y="75" text-anchor="middle" fill="#334155" font-size="10">which endpoints? since when? deploy?</text>

  <rect x="20" y="100" width="250" height="44" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="145" y="118" text-anchor="middle" fill="#1e293b" font-weight="bold">1. Connection pool</text>
  <text x="145" y="135" text-anchor="middle" fill="#334155" font-size="10">pool wait time, active vs max</text>

  <rect x="20" y="160" width="250" height="44" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="145" y="178" text-anchor="middle" fill="#1e293b" font-weight="bold">2. DB CPU</text>
  <text x="145" y="195" text-anchor="middle" fill="#334155" font-size="10">AAS on CPU vs vCPUs, run queue</text>

  <rect x="20" y="220" width="250" height="44" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="145" y="238" text-anchor="middle" fill="#1e293b" font-weight="bold">3. Memory</text>
  <text x="145" y="255" text-anchor="middle" fill="#334155" font-size="10">hit ratio, swap, OOM, temp files</text>

  <rect x="20" y="280" width="250" height="44" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="145" y="298" text-anchor="middle" fill="#1e293b" font-weight="bold">4. Disk / IOPS</text>
  <text x="145" y="315" text-anchor="middle" fill="#334155" font-size="10">IO waits, await, queue depth, caps</text>

  <rect x="20" y="340" width="250" height="44" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="145" y="358" text-anchor="middle" fill="#1e293b" font-weight="bold">5. Locks</text>
  <text x="145" y="375" text-anchor="middle" fill="#334155" font-size="10">Lock waits, pg_blocking_pids chain</text>

  <rect x="20" y="400" width="250" height="44" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="145" y="418" text-anchor="middle" fill="#1e293b" font-weight="bold">6. Slow queries</text>
  <text x="145" y="435" text-anchor="middle" fill="#334155" font-size="10">pg_stat_statements delta, plan flips</text>

  <rect x="20" y="460" width="250" height="44" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="145" y="478" text-anchor="middle" fill="#1e293b" font-weight="bold">7. Replication lag</text>
  <text x="145" y="495" text-anchor="middle" fill="#334155" font-size="10">replay_lag, stale reads, SyncRep</text>

  <rect x="20" y="520" width="250" height="44" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="145" y="538" text-anchor="middle" fill="#1e293b" font-weight="bold">8. Connection count</text>
  <text x="145" y="555" text-anchor="middle" fill="#334155" font-size="10">by state; idle in transaction</text>

  <rect x="20" y="580" width="120" height="44" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="80" y="598" text-anchor="middle" fill="#1e293b" font-weight="bold">9. Storage</text>
  <text x="80" y="615" text-anchor="middle" fill="#334155" font-size="9">free %, WAL, slots</text>
  <rect x="150" y="580" width="120" height="44" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="210" y="598" text-anchor="middle" fill="#1e293b" font-weight="bold">10. Network</text>
  <text x="210" y="615" text-anchor="middle" fill="#334155" font-size="9">RTT, bandwidth, DNS</text>

  <path d="M145,84 L145,98" stroke="#334155" stroke-width="1.5" marker-end="url(#c23a1)"/>
  <path d="M145,144 L145,158" stroke="#334155" stroke-width="1.5" marker-end="url(#c23a1)"/>
  <path d="M145,204 L145,218" stroke="#334155" stroke-width="1.5" marker-end="url(#c23a1)"/>
  <path d="M145,264 L145,278" stroke="#334155" stroke-width="1.5" marker-end="url(#c23a1)"/>
  <path d="M145,324 L145,338" stroke="#334155" stroke-width="1.5" marker-end="url(#c23a1)"/>
  <path d="M145,384 L145,398" stroke="#334155" stroke-width="1.5" marker-end="url(#c23a1)"/>
  <path d="M145,444 L145,458" stroke="#334155" stroke-width="1.5" marker-end="url(#c23a1)"/>
  <path d="M145,504 L145,518" stroke="#334155" stroke-width="1.5" marker-end="url(#c23a1)"/>
  <path d="M145,564 L145,578" stroke="#334155" stroke-width="1.5" marker-end="url(#c23a1)"/>

  <rect x="320" y="40" width="560" height="160" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="600" y="62" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Shortcut: one query tells you which box to jump to</text>
  <text x="336" y="84" fill="#334155" font-family="ui-monospace,monospace" font-size="10">SELECT wait_event_type, wait_event, count(*)</text>
  <text x="336" y="100" fill="#334155" font-family="ui-monospace,monospace" font-size="10">FROM pg_stat_activity WHERE state = 'active'</text>
  <text x="336" y="116" fill="#334155" font-family="ui-monospace,monospace" font-size="10">GROUP BY 1, 2 ORDER BY 3 DESC;</text>
  <text x="336" y="142" fill="#334155" font-size="10">NULL (CPU) dominant -&gt; box 2 / 6      IO:DataFileRead -&gt; box 3 / 4</text>
  <text x="336" y="160" fill="#334155" font-size="10">Lock:* dominant -&gt; box 5              IO:WALSync / LWLock:WALWrite -&gt; box 4</text>
  <text x="336" y="178" fill="#334155" font-size="10">IPC:SyncRep -&gt; box 7                  few active, pool full -&gt; box 1 / 8</text>
  <text x="336" y="194" fill="#334155" font-size="10">Client:ClientRead inside txn -&gt; app is slow between statements (box 0)</text>

  <rect x="320" y="220" width="560" height="190" rx="10" fill="#fef2f2" stroke="#dc2626"/>
  <text x="600" y="242" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">The cascade that hides the root cause</text>
  <text x="336" y="266" fill="#334155" font-size="10">1. Root cause: lock queue / IO cap / plan flip makes queries slower</text>
  <text x="336" y="286" fill="#334155" font-size="10">2. Little's law: same arrival rate x longer duration = more concurrent sessions</text>
  <text x="336" y="306" fill="#334155" font-size="10">3. App pools fill; requests wait for a connection; timeouts fire</text>
  <text x="336" y="326" fill="#334155" font-size="10">4. Retries and new pods open more connections: connection storm</text>
  <text x="336" y="346" fill="#334155" font-size="10">5. CPU and memory rise from sheer session count: everything looks bad</text>
  <text x="336" y="374" fill="#dc2626" font-size="11" font-weight="bold">Find the FIRST thing that changed: timeline + wait events,</text>
  <text x="336" y="392" fill="#dc2626" font-size="11" font-weight="bold">not the loudest graph right now.</text>

  <rect x="320" y="430" width="560" height="194" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="600" y="452" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Rules of engagement</text>
  <text x="336" y="476" fill="#334155" font-size="10">Capture evidence before acting (activity snapshot, locks, top statements).</text>
  <text x="336" y="496" fill="#334155" font-size="10">Ask "what changed?" deploys, migrations, config, traffic, stats, cron jobs.</text>
  <text x="336" y="516" fill="#334155" font-size="10">Prefer reversible mitigations: cancel a query, roll back a deploy, shed load.</text>
  <text x="336" y="536" fill="#334155" font-size="10">pg_cancel_backend before pg_terminate_backend; never kill -9 a backend.</text>
  <text x="336" y="556" fill="#334155" font-size="10">Don't raise max_connections or pool sizes to fix latency.</text>
  <text x="336" y="576" fill="#334155" font-size="10">Don't restart the database as a first move: you lose the evidence and</text>
  <text x="336" y="592" fill="#334155" font-size="10">the cache, and come back cold into the same load.</text>
  <text x="336" y="614" fill="#16a34a" font-size="10" font-weight="bold">Mitigate first, root-cause second, prevent third.</text>
</svg>
```

### Why the order is application-first

You start at the application because it is where you learn *scope*: is it every endpoint or one? Every pod or one? Since exactly when? Did a deploy, feature flag or migration land at that time? Scope eliminates half the tree immediately. If only one endpoint is slow, you're looking for one statement or one lock, not a resource saturation. If everything became slow at 14:03 exactly, something happened at 14:03. Then you check the pool, because the pool is the boundary: if the application waits for connections while the database is mostly idle, the problem is in the application (leaks, long transactions, a too-small pool); if the database is busy, go inward.

## 4. Architecture & Workflow

Each step below lists **what to look at**, **what bad looks like**, and **usual causes**.

### Step 0 — Application

**Look at:** APM traces for the slow endpoints (time in DB spans vs elsewhere), error rates, deploy log, feature-flag changes, migration jobs, cron schedules. **Bad:** DB spans dominate the slow traces; one endpoint's DB span count jumped (N+1); timeouts cluster at a specific time. **Usual causes:** a release with new queries, a migration, a batch job, a traffic spike, a retry storm.

### Step 1 — Connection pool

**Look at:** pool metrics (active, idle, pending/waiting, wait time; e.g. HikariCP `hikaricp_connections_pending`, pgx `AcquireDuration`, PgBouncer `SHOW POOLS` → `cl_waiting`, `maxwait`). **Bad:** clients waiting for connections while `pg_stat_activity` shows few *active* sessions — connections are held but idle. **Usual causes:** long transactions with application work (HTTP calls) inside them, leaked connections not returned, pool too small for Little's-law concurrency, or the database slowed down so each connection is held longer.

```text
pgbouncer=# SHOW POOLS;
 database | user | cl_active | cl_waiting | sv_active | sv_idle | maxwait | pool_mode
----------+------+-----------+------------+-----------+---------+---------+-------------
 app      | app  |        50 |        412 |        50 |       0 |      18 | transaction
```

412 clients waiting, max wait 18 s, all 50 server connections active: the database side is where the time goes. If instead `sv_active` were low and `sv_idle` high, the bottleneck is client-side.

### Step 2 — Database CPU

**Look at:** host CPU (`top`, `vmstat 1` → `us`, `sy`, `r` run queue, `st` steal), AAS on CPU vs vCPUs, CloudWatch `CPUUtilization`, Performance Insights DB load by wait. **Bad:** CPU > 90% with run queue `r` > vCPUs; AAS with NULL wait event exceeding vCPU count; high `st` on shared VMs; CPU credit balance at zero on burstable instances. **Usual causes:** a plan flip (a query now scans), a new expensive query, sheer volume (N+1), too many active connections contending (spinlocks, LWLocks), JSON/regex heavy functions, missing index after data growth.

```text
$ vmstat 1
procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----
 r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st
38  2      0 812344  10240 98123456   0    0  1210  8820 41233 90122 91  6  1  2  0
```

`r = 38` on a 16-vCPU host with 91% user CPU: CPU saturation. Next: which statements are burning it (step 6).

### Step 3 — Memory

**Look at:** buffer cache hit ratio from `pg_stat_database` (delta over minutes, not lifetime), `IO:DataFileRead` waits, `temp_files`/`temp_bytes` growth (sorts/hashes spilling past `work_mem`), OS: `free -m`, `vmstat` `si`/`so` (swap), `dmesg` for OOM kills, CloudWatch `FreeableMemory` and `SwapUsage`. **Bad:** hit ratio dropping from ~99% to the low 90s for OLTP; any sustained swapping; OOM killer messages (PostgreSQL will then restart all backends — "server process was terminated by signal 9"). **Usual causes:** working set outgrew RAM, a new query touching cold data, huge `work_mem` × many sessions, too many connections, a large report reading history.

```sql
-- Hit ratio and temp spill, per database (compare two samples a few minutes apart).
SELECT datname, blks_hit, blks_read,
       round(100.0 * blks_hit / NULLIF(blks_hit + blks_read, 0), 2) AS hit_pct,
       temp_files, pg_size_pretty(temp_bytes) AS temp
FROM pg_stat_database WHERE datname = current_database();
```

### Step 4 — Disk and IOPS

**Look at:** `iostat -x 1` (`r/s`, `w/s`, `r_await`, `w_await`, `aqu-sz`, `%util`), wait events `IO:DataFileRead`, `IO:WALSync`, `LWLock:WALWrite`, `pg_stat_io` (PG 16+) for who is doing I/O, CloudWatch `ReadIOPS`/`WriteIOPS` against the provisioned limit, `ReadLatency`/`WriteLatency`, `DiskQueueDepth`, `BurstBalance`, `EBSIOBalance%`. **Bad:** IOPS flat-lined exactly at a round number (that's a cap), `await` rising from ~1 ms to tens of ms, queue depth climbing, `WALSync` waits (commit latency). **Usual causes:** cache misses from working-set growth, a checkpoint storm (`max_wal_size` too small), burst credits exhausted, a backfill or vacuum saturating I/O, a noisy neighbour, a volume near its throughput (MB/s) cap even though IOPS look fine.

```text
$ iostat -x 1 nvme1n1
Device  r/s     w/s     rkB/s    wkB/s   r_await w_await aqu-sz %util
nvme1n1 2980.0  20.0    23840.0  320.0   38.20   41.10   118.4  100.0
```

Read IOPS pinned at ~3,000 with 38 ms await and a queue of 118: a volume at its IOPS cap. `%util` alone is misleading on SSD/NVMe (it measures busy time, not capacity), but `await` and `aqu-sz` don't lie.

```sql
-- PG16+: who is doing I/O and where (cumulative; diff two samples).
SELECT backend_type, object, context, reads, writes, extends, hits, evictions
FROM pg_stat_io
WHERE reads > 0 OR writes > 0
ORDER BY reads + writes DESC
LIMIT 10;
```

If `client backend` has high `writes` in the `normal` context, backends are writing dirty buffers themselves because the checkpointer and bgwriter can't keep up — a sign of too-small shared_buffers or an I/O bottleneck.

### Step 5 — Locks

**Look at:** sessions with `wait_event_type = 'Lock'`, the blocking chain via `pg_blocking_pids()`, `pg_locks` for modes, and the age of the blocker's transaction. **Bad:** many sessions waiting on one or a few PIDs; an `AccessExclusiveLock` request waiting (DDL); a blocker that is `idle in transaction`; `Lock:transactionid` waits piling on a hot row. **Usual causes:** DDL behind a long query (the lock queue), idle-in-transaction sessions holding row locks, hot-row contention (counters, inventory), `SELECT ... FOR UPDATE` in long transactions, explicit `LOCK TABLE`, foreign-key checks on hot parents.

```sql
-- Who blocks whom, with the root blocker's state and transaction age.
SELECT a.pid,
       pg_blocking_pids(a.pid)                    AS blocked_by,
       a.state,
       a.wait_event_type || ':' || a.wait_event  AS waiting_on,
       now() - a.xact_start                       AS xact_age,
       left(a.query, 60)                          AS query
FROM pg_stat_activity a
WHERE cardinality(pg_blocking_pids(a.pid)) > 0
   OR a.pid IN (SELECT unnest(pg_blocking_pids(pid)) FROM pg_stat_activity)
ORDER BY xact_age DESC NULLS LAST;
```

```text
  pid  | blocked_by |        state        |    waiting_on     | xact_age  | query
-------+------------+---------------------+-------------------+-----------+----------------------------------
 18211 | {}         | active              |                   | 00:47:12  | SELECT merchant_id, sum(total) ...
 20455 | {18211}    | active              | Lock:relation     | 00:02:03  | ALTER TABLE orders ADD COLUMN ...
 20501 | {20455}    | active              | Lock:relation     | 00:02:01  | SELECT * FROM orders WHERE id = $1
 20502 | {20455}    | active              | Lock:relation     | 00:02:01  | UPDATE orders SET status = $1 ...
  ... 380 more rows blocked by 20455 ...
```

The root is 18211 (a 47-minute report holding ACCESS SHARE); the ALTER waits for ACCESS EXCLUSIVE; everything else queues *behind the ALTER*. Row-level waits look different: the blocked session waits on `Lock:transactionid` of the holder, because PostgreSQL row locks are recorded in the tuple (xmax), not in a shared lock table.

### Step 6 — Slow queries

**Look at:** `pg_stat_statements` **deltas** over the incident window (cumulative totals hide a statement that became slow an hour ago), `pg_stat_activity` for currently long-running statements, `auto_explain` logs for the plans actually used, and `log_min_duration_statement` logs. **Bad:** one statement's `mean_exec_time` jumped; a statement's `calls` jumped (N+1 or retry loop); `shared_blks_read` jumped for a statement (cold data or scan); rows per call exploded. **Usual causes:** plan flip after ANALYZE or data growth, generic plan chosen for a prepared statement, missing index for a new query, bloat, parameter skew (one tenant with 100x the data). Reading the plan itself is covered in [SQL Handbook · Execution Plans](../sql/topic.html?p=22-execution-plans).

```sql
-- Snapshot, wait N minutes, diff: what got worse during the incident.
CREATE TEMP TABLE s1 AS
SELECT queryid, calls, total_exec_time, shared_blks_read, rows FROM pg_stat_statements;
-- ... wait 5 minutes ...
SELECT left(p.query, 70) AS query,
       p.calls - s1.calls                                   AS calls,
       round((p.total_exec_time - s1.total_exec_time)::numeric / 1000, 1) AS exec_s,
       round(((p.total_exec_time - s1.total_exec_time)
              / NULLIF(p.calls - s1.calls, 0))::numeric, 2)   AS mean_ms,
       p.shared_blks_read - s1.shared_blks_read             AS disk_blks
FROM pg_stat_statements p JOIN s1 USING (queryid)
ORDER BY exec_s DESC
LIMIT 10;
```

### Step 7 — Replication lag

**Look at:** on the primary, `pg_stat_replication` (`write_lag`, `flush_lag`, `replay_lag`, and LSN differences); on replicas, `now() - pg_last_xact_replay_timestamp()`; wait event `IPC:SyncRep` on the primary (commits waiting for a synchronous standby); CloudWatch `ReplicaLag`. **Bad:** replay lag growing steadily (replica can't keep up) or spiking (WAL burst, long conflicting query); primary commits stalled in `SyncRep`. **Usual causes:** bulk writes or index builds producing a WAL burst, replica undersized or I/O-bound, a long query on the replica pausing replay (`max_standby_streaming_delay`), network issues, a synchronous standby that is slow or down.

```sql
SELECT application_name, state, sync_state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS replay_behind,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;
```

`pg_last_xact_replay_timestamp()` lag reads high on an idle primary even when the replica is caught up (no new transactions to replay) — compare LSNs to be sure.

### Step 8 — Connection count

**Look at:** `pg_stat_activity` counts by `state`, total vs `max_connections`, connection rate (logs with `log_connections`), `idle in transaction` count and age. **Bad:** near `max_connections` ("FATAL: sorry, too many clients already", or "remaining connection slots are reserved"); hundreds of `idle` connections (no pooler); any `idle in transaction` older than seconds; connection rate spikes (each new backend is a fork plus authentication). **Usual causes:** deploy or autoscaling multiplied pods × pool size, retry storms, missing pooler, leaks, transactions held open around application work.

```sql
SELECT state, count(*), max(now() - state_change) AS longest_in_state
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY state ORDER BY count(*) DESC;
```

### Step 9 — Storage

**Look at:** free space on data and WAL volumes (`df -h`, CloudWatch `FreeStorageSpace`, `TransactionLogsDiskUsage`), WAL directory size (`SELECT sum(size) FROM pg_ls_waldir()`), replication slots retaining WAL, table and index bloat, temp file usage. **Bad:** free space trending to zero; WAL directory far larger than `max_wal_size`; an inactive slot with a large `restart_lsn` gap. **Usual causes:** abandoned replication slot, failing `archive_command` (WAL retained until archived), runaway temp files, bloat from a held-back xmin horizon, logs on the data volume.

```sql
SELECT slot_name, slot_type, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots ORDER BY retained DESC;

SELECT archived_count, failed_count, last_failed_wal, last_failed_time
FROM pg_stat_archiver;
```

### Step 10 — Network

**Look at:** round-trip time from app hosts to the DB (`ping`, TCP connect time in APM), bandwidth (`sar -n DEV 1`, CloudWatch `NetworkReceiveThroughput`/`NetworkTransmitThroughput`), retransmits (`netstat -s`, `ss -ti`), DNS resolution time and TTLs. **Bad:** RTT that used to be 0.3 ms is now 2 ms (a query-per-row loop multiplies it), bandwidth pinned at the instance's limit, retransmits climbing, `Client:ClientWrite` waits (big result sets the client isn't reading fast enough). **Usual causes:** app moved to another AZ/region, huge result sets (`SELECT *` returning megabytes), failover changed the endpoint but clients cache old DNS, instance network allowance exhausted.

### Lock queue anatomy

```svg
<svg viewBox="0 0 900 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c23b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="450" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Why one ALTER TABLE takes the site down: the lock queue on "orders"</text>

  <rect x="30" y="50" width="200" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="130" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">pid 18211 GRANTED</text>
  <text x="130" y="90" text-anchor="middle" fill="#334155" font-size="10">AccessShareLock</text>
  <text x="130" y="106" text-anchor="middle" fill="#334155" font-size="10">47-minute report</text>

  <rect x="270" y="50" width="200" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="370" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">pid 20455 WAITING</text>
  <text x="370" y="90" text-anchor="middle" fill="#334155" font-size="10">AccessExclusiveLock</text>
  <text x="370" y="106" text-anchor="middle" fill="#334155" font-size="10">ALTER TABLE (migration)</text>

  <rect x="510" y="50" width="360" height="70" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="690" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">pids 20501 ... 20900 WAITING</text>
  <text x="690" y="90" text-anchor="middle" fill="#334155" font-size="10">AccessShareLock / RowExclusiveLock</text>
  <text x="690" y="106" text-anchor="middle" fill="#334155" font-size="10">every SELECT / UPDATE on orders</text>

  <path d="M268,85 L234,85" stroke="#dc2626" stroke-width="2" marker-end="url(#c23b1)"/>
  <path d="M508,85 L474,85" stroke="#dc2626" stroke-width="2" marker-end="url(#c23b1)"/>
  <text x="251" y="140" text-anchor="middle" fill="#334155" font-size="10">conflicts with</text>
  <text x="491" y="140" text-anchor="middle" fill="#334155" font-size="10">queued behind</text>

  <text x="30" y="176" fill="#1e293b" font-size="12" font-weight="bold">Timeline</text>
  <line x1="30" y1="200" x2="870" y2="200" stroke="#94a3b8" stroke-width="1.5"/>
  <text x="30" y="220" fill="#334155" font-size="10">13:18 report starts</text>
  <text x="250" y="220" fill="#334155" font-size="10">14:03 ALTER requests lock</text>
  <text x="470" y="220" fill="#334155" font-size="10">14:03:01 new queries queue</text>
  <text x="690" y="220" fill="#334155" font-size="10">14:05 pools exhausted</text>
  <circle cx="40" cy="200" r="5" fill="#16a34a"/>
  <circle cx="260" cy="200" r="5" fill="#d97706"/>
  <circle cx="480" cy="200" r="5" fill="#dc2626"/>
  <circle cx="700" cy="200" r="5" fill="#dc2626"/>

  <rect x="30" y="244" width="410" height="100" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="46" y="266" fill="#1e293b" font-weight="bold">Why later readers wait</text>
  <text x="46" y="286" fill="#334155" font-size="10">Lock requests are granted in queue order. A new ACCESS SHARE</text>
  <text x="46" y="302" fill="#334155" font-size="10">conflicts with the queued ACCESS EXCLUSIVE, so it waits behind</text>
  <text x="46" y="318" fill="#334155" font-size="10">it, even though it's compatible with the granted report.</text>
  <text x="46" y="334" fill="#334155" font-size="10">The ALTER itself would take milliseconds once granted.</text>

  <rect x="460" y="244" width="410" height="100" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="476" y="266" fill="#1e293b" font-weight="bold">Mitigate and prevent</text>
  <text x="476" y="286" fill="#334155" font-size="10">Now: cancel the ALTER (pid 20455); traffic resumes at once.</text>
  <text x="476" y="302" fill="#334155" font-size="10">Prevent: SET lock_timeout = '3s' in every migration + retry loop.</text>
  <text x="476" y="318" fill="#334155" font-size="10">Keep reports off the primary; statement_timeout for ad-hoc users.</text>
  <text x="476" y="334" fill="#334155" font-size="10">See Ch 27 for lock-safe DDL patterns.</text>
</svg>
```

## 5. Implementation

### Simple example: the first five minutes

Paste this into `psql` at the start of any "DB is slow" incident and save the output to the incident doc. It captures the evidence before anyone changes anything.

```sql
\pset pager off
\echo '== load by wait event =='
SELECT coalesce(wait_event_type, 'CPU') AS type, coalesce(wait_event, '-') AS event, count(*)
FROM pg_stat_activity
WHERE state = 'active' AND backend_type = 'client backend' AND pid <> pg_backend_pid()
GROUP BY 1, 2 ORDER BY 3 DESC;

\echo '== sessions by state =='
SELECT state, count(*), max(now() - state_change) AS oldest
FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1 ORDER BY 2 DESC;

\echo '== longest running transactions =='
SELECT pid, usename, application_name, state, now() - xact_start AS xact_age,
       wait_event_type || ':' || wait_event AS wait, left(query, 80) AS query
FROM pg_stat_activity
WHERE xact_start IS NOT NULL AND backend_type = 'client backend'
ORDER BY xact_start LIMIT 10;

\echo '== blocked sessions and their blockers =='
SELECT pid, pg_blocking_pids(pid) AS blocked_by, wait_event, left(query, 60) AS query
FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0 LIMIT 20;

\echo '== replication =='
SELECT application_name, state, replay_lag FROM pg_stat_replication;

\echo '== slots retaining WAL =='
SELECT slot_name, active,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;
```

On the host (or via CloudWatch/Performance Insights on RDS), in parallel: `vmstat 1 10`, `iostat -x 1 10`, `top -c` (look for which postgres backends burn CPU, then match PIDs to `pg_stat_activity`), `df -h`, `free -m`.

> **MySQL difference:** The equivalents are `SHOW PROCESSLIST` / `performance_schema.threads`, `sys.innodb_lock_waits` (who blocks whom), `performance_schema.data_locks` and `data_lock_waits` (8.0), `SHOW ENGINE INNODB STATUS` (latest deadlock, semaphore waits, history list length — a growing history list is MySQL's analogue of a held-back xmin horizon, since undo can't be purged), `sys.statement_analysis` / `events_statements_summary_by_digest` for top statements, and `SHOW REPLICA STATUS` for lag. InnoDB row-lock waits time out after `innodb_lock_wait_timeout` (50 s by default) rather than waiting indefinitely.

### Real-world examples: eight incidents, end to end

#### Incident 1 — Plan flip after statistics changed

**Symptom:** at 03:10, after the nightly batch, one API endpoint goes from 15 ms to 3 s. CPU rises from 35% to 80%. **Evidence:** wait events show mostly CPU. The `pg_stat_statements` delta shows one statement with mean time up 200x and `shared_blks_hit` up 1,000x; text unchanged. `pg_stat_user_tables.last_autoanalyze` for `orders` is 03:04. **Root cause:** the batch inserted 2M rows with `status = 'pending'`; autoanalyze updated statistics, the planner now estimates `status = 'pending'` matches 20% of rows, and switched from an index scan on `(customer_id)` to a bitmap/seq scan on `status`. For a generic prepared plan (after five executions PostgreSQL may switch to a generic plan if it looks no worse on average), the same thing can happen without any stats change. **Mitigation:** `EXPLAIN (ANALYZE, BUFFERS)` the statement with real parameters to confirm; create the right composite index `CONCURRENTLY` (e.g. `(customer_id, status)`), or for a prepared-statement case set `plan_cache_mode = force_custom_plan` for that role. **Prevention:** composite indexes that match predicates, extended statistics for correlated columns, `auto_explain` with `log_min_duration` so plan changes are captured, and alerts on per-statement mean time regressions. (If you need to *pin* plans, `pg_hint_plan` exists, but treat it as a last resort.)

#### Incident 2 — Lock queue behind a migration

**Symptom:** at 14:03 every request touching `orders` times out; CPU drops (sessions are waiting, not working). **Evidence:** 400 sessions in `Lock:relation`; blocking query shows the ALTER blocked by a 47-minute report (diagram above). **Root cause:** the migration's ACCESS EXCLUSIVE request queued behind a long ACCESS SHARE holder and everything else queued behind it. **Mitigation:** `SELECT pg_cancel_backend(20455);` — the queue drains instantly. **Prevention:** every migration sets `lock_timeout` (a few seconds) and retries; long reports go to a replica; `statement_timeout` for ad-hoc roles; migration tooling checks for long transactions before starting ([Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution)).

#### Incident 3 — Autovacuum can't keep up; bloat and a held-back horizon

**Symptom:** over two weeks, p95 for queue-like tables creeps from 5 ms to 150 ms; disk usage grows 40% without data growth. **Evidence:** `n_dead_tup` in the hundreds of millions on `jobs`; `last_autovacuum` recent but dead tuples never drop; `pg_stat_activity` shows a session `idle in transaction` for 11 days (a forgotten `psql` session), and its `backend_xmin` is the oldest in the cluster. **Root cause:** the old snapshot pins the xmin horizon, so vacuum runs but can't remove any dead tuple newer than it. Index scans wade through dead entries. **Mitigation:** terminate the session; let autovacuum catch up (or run a manual `VACUUM (VERBOSE)` on the worst tables); if the table is massively bloated, `pg_repack` it online. **Prevention:** `idle_in_transaction_session_timeout`, alert on oldest transaction age and on `age(backend_xmin)`, per-table autovacuum tuning for hot tables (lower `autovacuum_vacuum_scale_factor`), and check replication slots and `hot_standby_feedback` replicas, which pin the horizon the same way.

```sql
SELECT pid, state, now() - xact_start AS xact_age, age(backend_xmin) AS xmin_age, left(query, 50)
FROM pg_stat_activity WHERE backend_xmin IS NOT NULL ORDER BY age(backend_xmin) DESC LIMIT 5;

SELECT relname, n_live_tup, n_dead_tup, last_autovacuum, autovacuum_count
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 5;
```

#### Incident 4 — Connection storm after a deploy

**Symptom:** a deploy at 10:00 rolls 60 new pods; at 10:02 the database logs "sorry, too many clients already", CPU spikes, login latency spikes, old pods start failing too. **Evidence:** `log_connections` shows thousands of new connections per minute; `pg_stat_activity` count at `max_connections`; most sessions `idle`. **Root cause:** new pods each open `minimumIdle = 20` connections at startup while old pods still hold theirs (rolling deploy doubles the fleet briefly); failures trigger client retries without backoff, which open more connections; each new backend forks and authenticates (with SCRAM, that's meaningful CPU). **Mitigation:** pause the rollout; cap retries; if a pooler exists, let it absorb clients. **Prevention:** PgBouncer (or RDS Proxy) between app and DB with a fixed server pool; pools with small minimum idle, jittered startup, exponential backoff with jitter on connect; `max_connections` sized for pooler + admin, not for pods × pool ([Ch 20 · Database + Application](topic.html?p=20-database-application-architecture)).

#### Incident 5 — Replica lag serving stale data

**Symptom:** users report "my payment went through but the order shows unpaid"; no errors. **Evidence:** `replay_lag` on the read replica spiking to 40–90 s since 11:00; primary shows a large `CREATE INDEX` and a backfill running. The replica's `iostat` shows it I/O-bound replaying. **Root cause:** a WAL burst from the backfill outpaced single-process replay on an undersized replica; the order-status page reads from replicas. **Mitigation:** route the order-status read to the primary (feature flag); throttle the backfill. **Prevention:** read-your-writes routing for post-write reads, lag-aware routing (take a replica out of rotation above a threshold), throttled backfills in batches with sleeps, replicas sized like the primary, alert on replay lag ([Ch 09 · Replication](topic.html?p=09-replication)).

#### Incident 6 — Disk full from a replication slot

**Symptom:** at 06:40 writes fail with `could not write to file "pg_wal/xlogtemp..."`: No space left on device; the primary is effectively down for writes. **Evidence:** `pg_ls_waldir()` totals 480 GB; `pg_replication_slots` shows a logical slot `debezium_orders`, `active = false`, retaining ~470 GB. The CDC connector was decommissioned three weeks ago but the slot wasn't dropped. **Root cause:** slots retain all WAL their consumer hasn't confirmed, forever by default. **Mitigation:** drop the slot (`SELECT pg_drop_replication_slot('debezium_orders');`) after confirming it's unused; PostgreSQL removes old WAL at the next checkpoint (`CHECKPOINT;`). If the disk is completely full, you may need to grow the volume first. **Prevention:** `max_slot_wal_keep_size` to cap retention (the slot is invalidated rather than filling the disk), alert on slot retained bytes and inactive slots (RDS: `OldestReplicationSlotLag`, `TransactionLogsDiskUsage`), and slot cleanup in decommission runbooks. A failing `archive_command` produces the same symptom — check `pg_stat_archiver.failed_count`.

#### Incident 7 — Burst credits exhausted

**Symptom:** at 16:00, three hours into a data backfill, commit latency jumps from 2 ms to 60–120 ms and the application's pools exhaust. Nothing was deployed. **Evidence:** wait events dominated by `IO:WALSync` and `IO:DataFileRead`; CloudWatch `BurstBalance` for the volume hit 0% at 15:58; `WriteIOPS` flat at a low round number (the baseline for the volume size). On a burstable instance class, `CPUCreditBalance` at zero produces the CPU version of the same cliff. **Root cause:** the storage was performing on burst credits, not baseline; the long backfill drained them. **Mitigation:** pause the backfill; credits refill slowly. Modify the volume to gp3/provisioned IOPS (online on EBS, but the modification itself takes time to optimize). **Prevention:** size for baseline, never for burst; alert on `BurstBalance`/`CPUCreditBalance` < 30%; throttle backfills.

#### Incident 8 — N+1 from a new release

**Symptom:** after release 4.12, database CPU rises from 40% to 75% at the same traffic; p99 on the order history page rises from 90 ms to 700 ms. **Evidence:** `pg_stat_statements` delta: `SELECT * FROM order_items WHERE order_id = $1` calls went from 2,000/s to 60,000/s, each 0.08 ms — individually fast, collectively 5 seconds of DB time per second. APM traces show 50 DB spans per page view. **Root cause:** an ORM relation marked lazy was accessed inside a loop over orders. **Mitigation:** roll back or feature-flag off. **Prevention:** eager loading (`WHERE order_id = ANY($1)` or a join), a CI check or APM alert on queries-per-request per endpoint, and a statement-calls regression alert per release.

## 6. Advantages, Disadvantages & Trade-offs

| Technique | Strength | Limitation |
|---|---|---|
| Wait-event sampling (`pg_stat_activity`) | Live, precise, per session | A snapshot; needs repeated sampling or a tool (PI, pg_wait_sampling) to see trends |
| `pg_stat_statements` deltas | Finds the statements consuming time | Cumulative; needs snapshots; normalized text hides parameter skew |
| `auto_explain` | Captures the actual plan used in production | Logging overhead; `log_analyze` adds timing cost |
| OS tools (`vmstat`, `iostat`, `top`) | Ground truth for CPU/IO | No per-query attribution; not available on managed DBs |
| Performance Insights / Database Insights | DB load by wait and SQL, history | Managed-cloud only; retention tiers |
| Log analysis (`log_min_duration_statement`, `log_lock_waits`) | Durable record for postmortem | Volume; only captures above threshold |

### When to use the full flow

- Any unexplained regression; any incident where the first obvious fix didn't work.
- Postmortems: walk it retroactively to find the *first* change.

### When NOT to walk every step

- When the application already tells you: a single endpoint, a clear deploy correlation, and a trace pointing at one statement — go straight to step 6.
- During a total outage with a known safe mitigation (rolling back the deploy that preceded it): mitigate first, then walk the flow on the evidence you captured.

## 7. Common Mistakes & Best Practices

**1. Restarting the database first.** *Why it hurts:* destroys evidence (activity, locks, in-memory stats), empties shared_buffers so the DB returns cold under the same load, and forces crash-safe recovery time. *Instead:* capture the five-minute snapshot, then take targeted, reversible actions.

**2. Raising max_connections or pool size to fix slowness.** *Why it hurts:* more concurrent sessions on a saturated resource increases contention and memory use; latency gets worse. *Instead:* find why each connection is held longer; reduce concurrency with a pooler.

**3. Looking at lifetime-cumulative stats.** *Why it hurts:* a statement that regressed an hour ago is invisible in a month of totals; a lifetime hit ratio of 99.8% hides a current 90%. *Instead:* always diff two snapshots over the incident window.

**4. Killing victims instead of the root blocker.** *Why it hurts:* you cancel hundreds of innocent queries and the chain re-forms. *Instead:* follow `pg_blocking_pids` to the root; often it's `idle in transaction`.

**5. Trusting %util on SSDs.** *Instead:* use `await`, queue depth and the cloud IOPS/throughput caps.

**6. Ignoring "what changed?"** *Instead:* line up the deploy log, migration log, config changes, cron jobs and autovacuum/analyze times against the first bad minute.

**7. `pg_terminate_backend` on autovacuum's anti-wraparound worker.** *Why it hurts:* it restarts and must redo work; the wraparound risk grows. *Instead:* let it run; reduce its impact via cost settings or more I/O.

**8. No `lock_timeout`/`statement_timeout` defaults.** *Instead:* role-level defaults (e.g. `ALTER ROLE reporting SET statement_timeout = '5min'`), per-migration `lock_timeout`, and `idle_in_transaction_session_timeout` globally.

## 8. Production: Failure Scenarios, Monitoring & Scaling

The eight incidents above are the failure catalog. What makes diagnosis fast in production is preparation:

- **Always-on instrumentation:** `pg_stat_statements`, `auto_explain` (with a threshold like 500 ms and `log_analyze` off or sampled), `log_lock_waits = on` (logs waits longer than `deadlock_timeout`), `log_min_duration_statement`, `log_autovacuum_min_duration`, `log_checkpoints = on`, `track_io_timing = on` (so I/O time appears in statements and plans).
- **Wait-event history:** RDS Performance Insights / CloudWatch Database Insights, or `pg_wait_sampling`, or a cron that samples `pg_stat_activity` every few seconds into a table — without history you can't see what happened at 03:10.
- **Dashboards arranged in the flow order** ([Ch 24 · Database Monitoring](topic.html?p=24-database-monitoring)): pool → CPU/AAS → memory → I/O → locks → top statements → replication → connections → storage.
- **Runbooks per incident class** with the exact queries ([Ch 25 · Database Reliability Engineering](topic.html?p=25-database-reliability-engineering)).
- **Scaling note:** diagnosis often ends in a capacity finding — the working set outgrew RAM, IOPS are at the cap — which feeds [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) and the ladder in [Ch 21](topic.html?p=21-database-scaling).

## 9. Interview Questions

**Q: The database suddenly became slow. Walk me through how you diagnose it.**
A: I start at the application to establish scope and timing: which endpoints, since exactly when, and what changed — deploys, migrations, config, traffic, batch jobs. Then I check the pool to see whether requests wait for connections while the DB is idle (an app problem) or the DB is busy. On the database I sample `pg_stat_activity` and group active sessions by wait event, which tells me in one query whether time is going to CPU, locks, I/O, the client or replication. I follow the dominant wait: blocking chains for locks, `iostat` and cloud IOPS caps for I/O, `pg_stat_statements` deltas for CPU. I capture evidence before acting and prefer reversible mitigations like cancelling one query or rolling back a deploy.

**Q: What does it mean when most active sessions have a NULL wait_event?**
A: They are running on CPU (or in code paths without instrumentation). If the count of such sessions exceeds the number of vCPUs, you're CPU-saturated and there's a run queue. The next step is to find which statements are burning CPU — `pg_stat_statements` deltas and `top` matched to PIDs — typically a plan flip, a new expensive query, or an N+1 multiplying calls.

**Q: How do you find the root of a blocking chain in PostgreSQL?**
A: Use `pg_blocking_pids(pid)` on waiting sessions, then follow blockers until you reach a session that isn't blocked by anyone. That root is often `idle in transaction` or a long-running query. Cancelling victims doesn't help; you deal with the root, ideally with `pg_cancel_backend` first, `pg_terminate_backend` if it's idle in transaction. Then fix the cause: timeouts, shorter transactions, moving long reads elsewhere.

**Q: Why can a quick ALTER TABLE take down an application?**
A: Because the lock queue is ordered. ALTER TABLE usually needs ACCESS EXCLUSIVE, which conflicts with every other lock including plain SELECTs' ACCESS SHARE. If a long query holds ACCESS SHARE, the ALTER waits — and every new query on that table queues behind the ALTER, because it conflicts with the queued request. The ALTER itself would be instant, but the table is effectively offline until the long query ends. `lock_timeout` on migrations with retries prevents it.

**Q: What does `IO:DataFileRead` dominating the wait events tell you?**
A: Sessions are waiting to read data pages that weren't in shared_buffers (they may still come from the OS page cache, but often from disk). The cause is either the working set exceeding memory, a query that started scanning cold data (plan flip, new report), or the storage being slow or capped. I'd check hit ratio deltas, which statements' `shared_blks_read` jumped, and `iostat`/cloud metrics for await and IOPS against the provisioned limit.

**Q: How do you tell whether replication lag is the replica being slow or the primary producing a burst?**
A: Compare WAL generation rate on the primary (`pg_stat_wal`, LSN deltas) with the replica's replay rate. If the primary's WAL rate spiked (bulk load, index build, backfill) and lag rose with it, it's a burst. If WAL rate is normal but lag grows steadily, the replica can't keep up — I/O-bound, undersized, or replay paused by a conflicting long query. `pg_stat_replication` columns separate network (`write_lag`), durability (`flush_lag`) and apply (`replay_lag`), which localizes where it's stuck.

**Q: A developer wants to raise max_connections from 500 to 2,000 because the app keeps getting "too many clients". What do you say?**
A: That it treats a symptom and makes the underlying problem worse. PostgreSQL uses a process per connection; thousands of backends consume memory and add contention on internal structures, and only roughly core-count sessions can actually run at once. The real questions are why so many connections are open — pods × pool size, leaks, retry storms — and why each is held so long. The fix is a pooler like PgBouncer in transaction mode, smaller app pools, and backoff on connect.

**Q: Why diff pg_stat_statements snapshots instead of reading totals?**
A: Its counters are cumulative since the last reset, so a statement that got 50x slower an hour ago is diluted by weeks of normal history, and a statement with huge lifetime totals may be irrelevant now. Taking a snapshot, waiting a few minutes, and diffing calls, total time and blocks read gives the current workload. The same applies to `pg_stat_database` hit ratios and `pg_stat_io`.

**Q: Walk me through diagnosing a sudden slowdown right after a nightly batch, with no deploy. (Senior)**
A: A batch changing data distribution plus autoanalyze is the classic plan-flip setup. I'd check wait events — probably mostly CPU or `IO:DataFileRead` — then diff `pg_stat_statements` to find the statement whose mean time or blocks read jumped, and check `last_autoanalyze` for its tables against the incident start. I'd reproduce with `EXPLAIN (ANALYZE, BUFFERS)` using real parameters and compare with the old plan from `auto_explain` logs. Typical causes are a skewed value now looking common, correlated predicates misestimated, or a prepared statement switching to a generic plan. The fix is an index that matches the predicate, extended statistics, or forcing custom plans for that workload; then I'd add a per-statement latency regression alert.

**Q: Disk usage on the primary is growing 50 GB/day but table sizes aren't. Where do you look? (Senior)**
A: In order: the WAL directory (`pg_ls_waldir()`), because retained WAL is the usual culprit — check `pg_replication_slots` for inactive or lagging slots and `pg_stat_archiver` for archive failures; then temp files (`pg_stat_database.temp_bytes`, big sorts or hashes); then logs if they're on the data volume. If WAL is retained by an unused slot I'd drop it and checkpoint; for archive failures, fix the archive destination. Prevention is `max_slot_wal_keep_size`, alerts on slot retained bytes and archiver failures, and slot cleanup in decommissioning. If it turns out to be bloat after all, I'd look for a held-back xmin horizon from old transactions or `hot_standby_feedback` replicas.

**Q: CPU is low, the database is barely doing anything, but the application reports DB timeouts. What's happening? (Senior)**
A: Low CPU with timeouts means sessions are waiting, not working. The candidates: lock waits (a blocking chain, often DDL or an idle-in-transaction holder), I/O stalls (volume at its cap or burst credits exhausted, visible as `IO:*` waits), synchronous replication waiting on a slow standby (`IPC:SyncRep`), or the problem being entirely client-side — pool exhaustion from leaked or long-held connections, or network/DNS issues after a failover. Grouping `pg_stat_activity` by wait event and comparing app-side pool metrics with server-side active sessions separates these within a minute.

**Q: After a release, DB CPU rose 35% at constant traffic but no query got slower. How do you find it?**
A: If no statement got slower, the number of statements grew — typically an N+1. A `pg_stat_statements` diff across the release will show a cheap statement whose calls jumped by an order of magnitude. APM traces for the affected endpoints will show many DB spans per request. The fix is batching the lookups (`= ANY($1)` or a join, eager loading in the ORM), and prevention is a queries-per-request budget checked in CI or alerted in APM.

## 10. Quick Revision & Cheat Sheet

| Wait / signal | Likely cause | First action |
|---|---|---|
| NULL wait, AAS > vCPUs | CPU: plan flip, N+1, new query | `pg_stat_statements` delta |
| `Lock:relation` | DDL in lock queue, LOCK TABLE | Blocking chain; cancel DDL; `lock_timeout` |
| `Lock:transactionid` / `tuple` | Row contention, idle-in-txn holder | Find root blocker; shorten txns |
| `IO:DataFileRead` | Working set > RAM, scans, capped IOPS | Hit ratio delta, `iostat`, IOPS caps |
| `IO:WALSync`, `LWLock:WALWrite` | Commit flush latency, slow WAL disk | Disk latency, burst credits |
| `IPC:SyncRep` | Slow/down synchronous standby | `pg_stat_replication` |
| `Client:ClientRead` in txn | App slow between statements | App traces; move work out of txn |
| Pool waiting, DB idle | Leaks, long-held connections | Pool metrics, idle-in-txn |
| WAL dir huge | Inactive slot, archive failing | `pg_replication_slots`, `pg_stat_archiver` |
| Dead tuples not dropping | Old xmin: long txn, slot, standby feedback | `backend_xmin` age |

- Scope first: which endpoints, since when, what changed.
- Group active sessions by wait event — one query, most of the diagnosis.
- Diff cumulative stats over the incident window.
- Follow blocking chains to the root; don't kill victims.
- Don't restart first; don't raise max_connections; don't trust `%util` on SSDs.
- Timeouts (`lock_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout`) prevent whole classes of incidents.
- Capture evidence, mitigate reversibly, then root-cause and prevent.

## 11. Hands-On Exercises

Lab: `docker run -d --name pg -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:17 -c shared_preload_libraries=pg_stat_statements -c track_io_timing=on`.

1. **Reproduce the lock queue.** Session A: `BEGIN; SELECT count(*) FROM orders; ` (leave open). Session B: `ALTER TABLE orders ADD COLUMN note text;`. Session C: `SELECT * FROM orders LIMIT 1;`. Observe C blocked; run the blocking-chain query; then redo B with `SET lock_timeout = '2s'`.
2. **Held-back horizon.** Open a transaction with `BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT 1;` and leave it idle. Update a table 1M times in another session, run `VACUUM (VERBOSE)` and read "dead row versions cannot be removed yet". Close the transaction and vacuum again.
3. **Plan flip.** Create `orders(customer_id, status)` with 1% `pending`; index `status` and `customer_id` separately; run a query filtering both. Bulk-insert rows making `pending` 30%, `ANALYZE`, and compare plans and `pg_stat_statements` mean time. Fix with a composite index.
4. **N+1 in numbers.** Write a Python script that fetches 100 orders and then items per order in a loop vs with `= ANY(%s)`; compare `calls` and total time in `pg_stat_statements`.
5. **Slot fills disk.** Create a logical slot with `pg_create_logical_replication_slot('s', 'test_decoding')`, generate WAL with pgbench, watch retained bytes grow; set `max_slot_wal_keep_size = '1GB'` and observe `wal_status` become `lost` after enough WAL.

**Mini project:** Build a `dbdiag.sql` script (or a small Go/Python tool) that runs the first-five-minutes queries, takes two `pg_stat_statements` snapshots 60 seconds apart, and prints a one-screen incident summary: top waits, blockers, top regressed statements, replication and slot status.

## 12. Related Topics & Free Learning Resources

**This handbook:** [Ch 03 · MVCC](topic.html?p=03-mvcc) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) · [Ch 09 · Replication](topic.html?p=09-replication) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) · [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) · [Ch 24 · Database Monitoring](topic.html?p=24-database-monitoring) · [Ch 25 · Database Reliability Engineering](topic.html?p=25-database-reliability-engineering) · [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution)

**SQL Handbook:** [Query Optimization & EXPLAIN](../sql/topic.html?p=21-query-optimization) · [Execution Plans](../sql/topic.html?p=22-execution-plans) · [Locking & MVCC](../sql/topic.html?p=27-locking-mvcc) · [Transactions & ACID](../sql/topic.html?p=25-transactions-acid)

**Other handbooks:** [System Design · Observability](../system-design/topic.html?p=28-observability) · [System Design · Resilience Patterns](../system-design/topic.html?p=27-resilience-patterns) · [Cassandra · Troubleshooting Latency & Hotspots](../cassandra/topic.html?p=36-troubleshooting-latency-hotspots)

- **PostgreSQL Documentation — The Cumulative Statistics System (wait events tables)** — PostgreSQL · *Intermediate* · the definitive list of `pg_stat_activity` wait events and every `pg_stat_*` view. <https://www.postgresql.org/docs/current/monitoring-stats.html>
- **PostgreSQL Documentation — Explicit Locking** — PostgreSQL · *Intermediate* · lock modes and the conflict table behind lock-queue incidents. <https://www.postgresql.org/docs/current/explicit-locking.html>
- **PostgreSQL Documentation — auto_explain** — PostgreSQL · *Intermediate* · capturing the plans production actually used. <https://www.postgresql.org/docs/current/auto-explain.html>
- **Brendan Gregg — The USE Method** — Brendan Gregg · *Intermediate* · the utilization/saturation/errors checklist that underlies resource-by-resource diagnosis. <https://www.brendangregg.com/usemethod.html>
- **Brendan Gregg — Linux Performance Analysis in 60,000 Milliseconds** — Netflix Tech Blog · *Intermediate* · the first-minute OS commands (vmstat, iostat, mpstat, sar) and how to read them. <https://netflixtechblog.com/linux-performance-analysis-in-60-000-milliseconds-accc10403c55>
- **Amazon RDS — Tuning with wait events for RDS for PostgreSQL** — AWS · *Intermediate* · each common wait event with likely causes and actions. <https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/PostgreSQL.Tuning.html>
- **Use The Index, Luke!** — Markus Winand · *Intermediate* · the fix side of most "slow query" findings. <https://use-the-index-luke.com/>

---

*Database Design Handbook — chapter 23.*
