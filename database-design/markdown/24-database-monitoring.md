# 24 · Production Database Monitoring: Metrics That Matter

> **In one line:** Good database monitoring measures what users feel (latency, errors, throughput) to decide when to wake someone up, measures every resource and internal process (CPU, memory, I/O, connections, locks, replication, WAL, vacuum, bloat, XID age) to explain why, and keeps the two separate — symptom alerts page, cause signals diagnose and forecast.

---

## 1. Overview

Most teams' first database dashboard is a CPU graph and a disk-free graph, plus an alert on "CPU > 80%". Then the incidents arrive, and none of them are caught. The site goes down because a migration is stuck in a lock queue — CPU was *low*. Writes stop because a forgotten replication slot filled the WAL volume — disk-free on the data volume looked fine. The database refuses writes to protect itself from transaction ID wraparound — nobody was graphing XID age. Users see stale data for an hour because a replica fell behind — the replica's CPU was fine. Meanwhile the CPU alert fires every Monday morning during the weekly report and everyone learns to ignore it.

The naive approach fails in two directions. It **misses** the failure modes that are specific to databases: lock queues, replication lag, WAL retention, vacuum falling behind, bloat, wraparound, connection exhaustion, idle-in-transaction sessions pinning the xmin horizon. None of these are visible in host metrics. And it **over-alerts** on causes that may or may not matter: high CPU during a batch window is not an incident if latency is fine. Alerts that don't correspond to user pain train people to ignore alerts.

This chapter covers, metric by metric: what it means, how to collect it (the `pg_stat_*` view or exporter), what healthy and warning look like (phrased as guidance — your baselines win), and what a bad value indicates. Then it organizes them with **RED** (for the database as a service) and **USE** (for its resources), shows how to design alerts that page on symptoms and ticket on causes, and lays out a dashboard in diagnostic order.

> **Builds on:** [System Design · Observability](../system-design/topic.html?p=28-observability) (logs/metrics/traces, RED/USE, SLOs in general — not repeated) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (dead tuples, vacuum, freezing) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) · [Ch 09 · Replication](topic.html?p=09-replication) · [Ch 23 · Bottleneck Diagnosis](topic.html?p=23-bottleneck-diagnosis) (using these signals during an incident). The SQL Handbook's [Locking & MVCC](../sql/topic.html?p=27-locking-mvcc) covers vacuum basics; this chapter is about watching them in production.

> **Why this matters:** Most database outages are preceded by hours or days of a visible trend — WAL retained growing, dead tuples climbing, XID age rising, free space shrinking, connections creeping up. Monitoring that forecasts turns outages into tickets.

## 2. Core Concepts

- **Symptom metric** — something users experience: query latency, error rate, availability, data freshness. *Why it matters:* these are what you page on.
- **Cause metric** — a resource or internal state that may produce symptoms: CPU, IOPS, dead tuples, lag. *Why it matters:* used for diagnosis, capacity planning and forecast alerts, not for waking people up at 3 a.m. (with a few exceptions like imminent disk-full or wraparound).
- **RED** — Rate, Errors, Duration: how the database performs *as a service* for its clients. *Why it matters:* the user-visible health summary.
- **USE** — Utilization, Saturation, Errors per resource. *Why it matters:* the systematic way to find which resource is the bottleneck.
- **Counter vs gauge** — most `pg_stat_*` columns are cumulative counters (`xact_commit`, `blks_read`, `deadlocks`); you graph their **rate**. Others are gauges (connections, lag, sizes). *Why it matters:* graphing a raw counter shows a meaningless ever-rising line.
- **Percentiles** — p50/p95/p99 latency. *Why it matters:* averages hide the tail; users feel p99. PostgreSQL's `pg_stat_statements` gives mean, stddev, min and max per statement, not percentiles — you get percentiles from client-side histograms or extensions like `pg_stat_monitor`.
- **Baseline** — normal values for this system at this time of day/week. *Why it matters:* "hit ratio 97%" is fine on one system and a crisis on another; deviation from baseline is often the better signal.
- **Forecast alert** — fires on a projected future breach (e.g. "disk full in 4 hours" via linear prediction). *Why it matters:* gives time to act before the outage.
- **Cardinality** — number of distinct time series. *Why it matters:* per-query or per-table labels can explode a metrics system; keep high-cardinality detail (per statement) in `pg_stat_statements` and dashboards, not in thousands of alert series.

## 3. Theory & Principles

### Where the numbers come from

PostgreSQL exposes almost everything through the **cumulative statistics system** (in shared memory since PG 15) and a few functions:

| Source | What it gives |
|---|---|
| `pg_stat_database` | Per-database commits, rollbacks, blocks hit/read, tuples, temp files/bytes, deadlocks, conflicts, checksum failures |
| `pg_stat_activity` | Every session: state, wait event, transaction/query start, `backend_xmin` |
| `pg_stat_statements` | Per-normalized-statement calls, total/mean/stddev time, rows, block hits/reads, WAL bytes |
| `pg_stat_user_tables` / `pg_stat_user_indexes` | Scans, tuples inserted/updated/deleted, `n_live_tup`, `n_dead_tup`, last (auto)vacuum/analyze, index usage |
| `pg_statio_user_tables` | Per-table heap/index/TOAST block hits and reads |
| `pg_stat_replication`, `pg_stat_wal_receiver` | Replica LSNs and write/flush/replay lag |
| `pg_replication_slots` | Slot activity and retained WAL (`restart_lsn`, `wal_status`) |
| `pg_stat_wal` | WAL records, full-page images, bytes, buffers full |
| `pg_stat_bgwriter`, `pg_stat_checkpointer` (PG 17) | Checkpoints timed vs requested, buffers written by whom |
| `pg_stat_io` (PG 16) | I/O by backend type, object and context |
| `pg_stat_progress_vacuum` | Live vacuum phase and progress |
| `pg_stat_archiver` | WAL archiving successes and failures |
| `pg_locks` + `pg_blocking_pids()` | Lock holders and waiters |
| `pg_database.datfrozenxid`, `pg_class.relfrozenxid` | XID age for wraparound monitoring |

A metrics agent — **postgres_exporter** for Prometheus, the Datadog/New Relic Postgres integrations, or CloudWatch/Performance Insights on RDS/Aurora — polls these views every 15–60 seconds and ships counters and gauges. Host metrics come from node_exporter or the cloud provider. Application-side latency histograms come from the DB client instrumentation (OpenTelemetry spans, driver metrics).

```svg
<svg viewBox="0 0 900 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c24a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="450" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Database monitoring pipeline: three vantage points, one set of dashboards and alerts</text>

  <rect x="20" y="44" width="250" height="150" rx="10" fill="#dbeafe" stroke="#2563eb"/>
  <text x="145" y="66" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Application (client view)</text>
  <text x="34" y="88" fill="#334155" font-size="10">DB span latency histograms</text>
  <text x="34" y="106" fill="#334155" font-size="10">p50 / p95 / p99 per operation</text>
  <text x="34" y="124" fill="#334155" font-size="10">errors: timeouts, 40001, 40P01, 53300</text>
  <text x="34" y="142" fill="#334155" font-size="10">pool: active, pending, acquire time</text>
  <text x="34" y="160" fill="#334155" font-size="10">queries per request (N+1 detector)</text>
  <text x="34" y="182" fill="#2563eb" font-size="10" font-weight="bold">= RED, as users feel it</text>

  <rect x="20" y="210" width="250" height="190" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="145" y="232" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">PostgreSQL (engine view)</text>
  <text x="34" y="254" fill="#334155" font-size="10">pg_stat_database: TPS, hits, deadlocks</text>
  <text x="34" y="272" fill="#334155" font-size="10">pg_stat_activity: states, waits, xmin</text>
  <text x="34" y="290" fill="#334155" font-size="10">pg_stat_statements: per-query time</text>
  <text x="34" y="308" fill="#334155" font-size="10">pg_stat_replication, slots: lag, WAL kept</text>
  <text x="34" y="326" fill="#334155" font-size="10">pg_stat_user_tables: dead tuples, vacuum</text>
  <text x="34" y="344" fill="#334155" font-size="10">pg_stat_wal / checkpointer / io</text>
  <text x="34" y="362" fill="#334155" font-size="10">datfrozenxid: XID age</text>
  <text x="34" y="388" fill="#16a34a" font-size="10" font-weight="bold">= internal causes (DB-specific)</text>

  <rect x="290" y="210" width="190" height="190" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="385" y="232" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Host / cloud</text>
  <text x="304" y="254" fill="#334155" font-size="10">CPU, run queue, steal</text>
  <text x="304" y="272" fill="#334155" font-size="10">memory, swap, OOM</text>
  <text x="304" y="290" fill="#334155" font-size="10">IOPS, await, queue depth</text>
  <text x="304" y="308" fill="#334155" font-size="10">throughput vs caps</text>
  <text x="304" y="326" fill="#334155" font-size="10">free space (data + WAL)</text>
  <text x="304" y="344" fill="#334155" font-size="10">burst / credit balances</text>
  <text x="304" y="362" fill="#334155" font-size="10">network in/out</text>
  <text x="304" y="388" fill="#d97706" font-size="10" font-weight="bold">= USE per resource</text>

  <rect x="530" y="150" width="150" height="90" rx="10" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="605" y="176" text-anchor="middle" fill="#1e293b" font-weight="bold">Collectors</text>
  <text x="605" y="196" text-anchor="middle" fill="#334155" font-size="10">postgres_exporter</text>
  <text x="605" y="212" text-anchor="middle" fill="#334155" font-size="10">node_exporter / OTel</text>
  <text x="605" y="228" text-anchor="middle" fill="#334155" font-size="10">CloudWatch, PI</text>

  <path d="M270,120 L528,180" stroke="#334155" stroke-width="1.5" marker-end="url(#c24a1)"/>
  <path d="M270,300 L528,210" stroke="#334155" stroke-width="1.5" marker-end="url(#c24a1)"/>
  <path d="M480,300 L528,225" stroke="#334155" stroke-width="1.5" marker-end="url(#c24a1)"/>

  <rect x="720" y="60" width="160" height="80" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="800" y="84" text-anchor="middle" fill="#1e293b" font-weight="bold">TSDB</text>
  <text x="800" y="104" text-anchor="middle" fill="#334155" font-size="10">Prometheus / CW /</text>
  <text x="800" y="120" text-anchor="middle" fill="#334155" font-size="10">vendor; rate() on counters</text>

  <rect x="720" y="180" width="160" height="80" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="800" y="204" text-anchor="middle" fill="#1e293b" font-weight="bold">Dashboards</text>
  <text x="800" y="224" text-anchor="middle" fill="#334155" font-size="10">in diagnostic order</text>
  <text x="800" y="240" text-anchor="middle" fill="#334155" font-size="10">RED row, then USE rows</text>

  <rect x="720" y="300" width="160" height="100" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="800" y="324" text-anchor="middle" fill="#1e293b" font-weight="bold">Alerts</text>
  <text x="800" y="344" text-anchor="middle" fill="#334155" font-size="10">PAGE: symptoms, SLO burn,</text>
  <text x="800" y="360" text-anchor="middle" fill="#334155" font-size="10">imminent disk-full/wraparound</text>
  <text x="800" y="376" text-anchor="middle" fill="#334155" font-size="10">TICKET: causes, trends</text>

  <path d="M680,180 L718,110" stroke="#334155" stroke-width="1.5" marker-end="url(#c24a1)"/>
  <path d="M800,140 L800,178" stroke="#334155" stroke-width="1.5" marker-end="url(#c24a1)"/>
  <path d="M800,260 L800,298" stroke="#334155" stroke-width="1.5" marker-end="url(#c24a1)"/>
</svg>
```

### RED and USE, applied to a database

**RED for the database as a service** (measure from the client and from `pg_stat_*`):

- **Rate:** statements/s (`pg_stat_statements.calls` rate), transactions/s (`xact_commit` + `xact_rollback` rate), per important query family.
- **Errors:** rollbacks/s and their ratio, application-observed DB errors by SQLSTATE class — `40001` serialization failures, `40P01` deadlocks, `57014` statement timeouts (query_canceled), `53300` too many connections, `08xxx` connection failures — plus deadlocks from `pg_stat_database.deadlocks`.
- **Duration:** client-side p50/p95/p99 per operation; server-side mean and stddev per statement from `pg_stat_statements`.

**USE for each resource:**

| Resource | Utilization | Saturation | Errors |
|---|---|---|---|
| CPU | CPU % | Run queue > vCPUs; AAS on CPU > vCPUs | — |
| Memory | Used, hit ratio | Swap in/out, temp file spills | OOM kills |
| Disk I/O | IOPS and MB/s vs provisioned | await, queue depth, `IO:*` waits | I/O errors in logs |
| Storage | % used | Growth rate / days to full | "No space left on device" |
| Connections | Count / `max_connections` | Pool waiters, `53300` | Connection failures |
| Locks | Sessions holding | Sessions waiting on `Lock:*` | Deadlocks, lock timeouts |
| WAL / checkpoints | WAL bytes/s | Requested checkpoints, `WALWrite` waits | Archive failures |
| Replication | Sender count | Lag bytes/seconds | Replica disconnected |
| Vacuum | Workers busy | Dead tuples rising, xmin age | Vacuum errors, wraparound warnings |

## 4. Architecture & Workflow

This section is the metric catalog. Thresholds are **starting guidance** for OLTP workloads; establish your own baselines and tune.

### Query latency (p50 / p95 / p99)

**Means:** how long statements take — the most direct symptom. **Collect:** client-side histograms (OpenTelemetry DB spans, driver metrics) for percentiles; `pg_stat_statements` for per-statement mean, stddev and max; `log_min_duration_statement` for outliers. **Healthy:** stable relative to baseline; typical OLTP point queries sub-millisecond to a few ms server-side. **Warning:** p99 drifting upward over days (working set, bloat), or a step change (plan flip, lock contention, I/O). **Symptoms it reveals:** anything — it's the summary; pair with wait events to explain.

### QPS / TPS

**Means:** workload volume. **Collect:** `rate(xact_commit + xact_rollback)` from `pg_stat_database`; `calls` rate from `pg_stat_statements`. **Healthy:** follows the traffic curve. **Warning:** TPS dropping while traffic is steady (DB stalling), statements/s rising faster than requests (N+1, retries), rollback ratio rising (application errors, serialization failures, timeouts). **Symptoms:** a sudden TPS collapse to near zero with stable connections usually means a lock queue or I/O stall.

### CPU

**Means:** compute consumed by query execution, parsing/planning, vacuum, WAL. **Collect:** host/cloud CPU, plus AAS on CPU from wait sampling. **Healthy:** below ~60–70% sustained at peak for OLTP. **Warning:** sustained > 80%, run queue exceeding vCPUs, steal time on shared hosts, CPU credits depleting on burstable classes. **Symptoms:** plan regressions, N+1, too many active connections, missing indexes after growth.

### Memory

**Means:** shared_buffers + OS page cache + backend memory. **Collect:** `FreeableMemory`/`free -m`, swap usage, OOM kills in `dmesg`/logs, `temp_files`/`temp_bytes` rates. **Healthy:** no swap activity; page cache stable. **Warning:** any sustained swapping; temp bytes/s climbing (queries spilling past `work_mem`); freeable memory trending toward zero (too many connections or large `work_mem`). **Symptoms:** latency spikes, OOM-killer restarts ("terminated by signal 9", followed by all backends being reset).

### Disk latency and IOPS

**Means:** how busy and how fast storage is. **Collect:** `iostat -x`, CloudWatch `ReadIOPS`/`WriteIOPS`, `ReadLatency`/`WriteLatency`, `DiskQueueDepth`, `ReadThroughput`/`WriteThroughput`, `BurstBalance`; `pg_stat_io`; I/O timing in `pg_stat_statements` (with `track_io_timing = on`). **Healthy:** comfortably under provisioned IOPS and throughput; SSD latencies around a millisecond or less for network block storage (lower for local NVMe). **Warning:** IOPS flat at a round number (a cap), latency rising, queue depth rising, burst balance falling. **Symptoms:** working set exceeding RAM, checkpoint storms, backfills, credit exhaustion.

### Cache hit ratio

**Means:** fraction of block requests served from shared_buffers: `blks_hit / (blks_hit + blks_read)`. **Collect:** `pg_stat_database`, per table from `pg_statio_user_tables`. Compute on **rates** over a window, not lifetime totals. **Healthy:** for OLTP typically 99%+. **Warning:** a sustained drop from baseline (e.g. 99.7% → 98%) — note a 1-point drop can mean several times more disk reads. **Caveat:** a "read" here may still be served by the OS page cache, so this ratio understates true memory hits; watch it alongside disk read IOPS. **Symptoms:** working set outgrowing RAM, a new scan-heavy query, a report on the primary.

### Connections

**Means:** sessions by state. **Collect:** `pg_stat_activity` grouped by `state` (active, idle, idle in transaction, idle in transaction (aborted)); `max_connections`; pooler stats (`SHOW POOLS`). **Healthy:** total well below `max_connections` (e.g. < 70–75%); active near or below vCPU count most of the time; idle-in-transaction near zero and short-lived. **Warning:** > 80–90% of `max_connections`; idle-in-transaction count or age rising (sessions holding locks and pinning the xmin horizon); connection rate spikes. **Symptoms:** deploy storms, leaks, app doing work inside transactions, missing pooler.

```sql
SELECT count(*) FILTER (WHERE state = 'active')                         AS active,
       count(*) FILTER (WHERE state = 'idle')                           AS idle,
       count(*) FILTER (WHERE state LIKE 'idle in transaction%')        AS idle_in_txn,
       max(now() - xact_start) FILTER (WHERE state LIKE 'idle in transaction%') AS oldest_idle_in_txn,
       current_setting('max_connections')::int                          AS max_conn
FROM pg_stat_activity WHERE backend_type = 'client backend';
```

### Lock waits

**Means:** sessions blocked on heavyweight locks. **Collect:** count of sessions with `wait_event_type = 'Lock'` and their wait duration (`now() - state_change` roughly, or sample repeatedly); `log_lock_waits = on` logs any wait longer than `deadlock_timeout` (1 s default). **Healthy:** occasional brief waits. **Warning:** more than a handful of sessions waiting for more than a few seconds; any `AccessExclusiveLock` waiter on a hot table. **Symptoms:** DDL in the lock queue, hot-row contention, idle-in-transaction blockers.

### Deadlocks

**Means:** cycles detected and broken by aborting one transaction (SQLSTATE `40P01`) after `deadlock_timeout`. **Collect:** `pg_stat_database.deadlocks` rate; the server log has full details of both sides. **Healthy:** zero or rare. **Warning:** any sustained non-zero rate, or a step change after a release. **Symptoms:** inconsistent lock ordering in application code (e.g. updating rows in different orders), foreign-key checks combined with updates on parents.

### Replication lag

**Means:** how far each replica is behind in bytes and time. **Collect:** primary: `pg_stat_replication` (`replay_lag`, and `pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)`); replica: `now() - pg_last_xact_replay_timestamp()` (reads high when the primary is idle — pair it with LSN diff); CloudWatch `ReplicaLag`. **Healthy:** sub-second to a few seconds for async streaming under normal load. **Warning:** beyond your freshness SLO (e.g. > 10–30 s for user-facing replicas), or steadily growing. **Symptoms:** WAL bursts, undersized replicas, replay paused by conflicting queries, network issues; for synchronous replicas, lag shows up as commit latency on the primary (`IPC:SyncRep`).

### WAL growth and retention

**Means:** WAL generated per second and WAL kept on disk. **Collect:** `pg_stat_wal.wal_bytes` rate and `wal_fpi` (full-page images); `pg_ls_waldir()` total; per-slot retained bytes; `pg_stat_archiver.failed_count`; RDS `TransactionLogsDiskUsage`, `OldestReplicationSlotLag`. **Healthy:** WAL rate follows write traffic; `pg_wal` size near `max_wal_size` range; archiver failures zero; every slot active. **Warning:** retained WAL growing; any inactive slot; archive failures; WAL rate step-change (a new write-heavy job, missing HOT updates, full-page-image surge from too-frequent checkpoints). **Symptoms:** disk-full outages, replica rebuilds, CDC pipelines stalled.

### Checkpoints

**Means:** how often dirty buffers are flushed and why. **Collect:** PG 17 `pg_stat_checkpointer` (`num_timed`, `num_requested`, `buffers_written`); earlier `pg_stat_bgwriter` (`checkpoints_timed`, `checkpoints_req`); `log_checkpoints = on`. **Healthy:** most checkpoints are timed. **Warning:** frequent requested checkpoints (WAL volume exceeds `max_wal_size` before `checkpoint_timeout`) — more I/O and more full-page images. **Symptoms:** periodic latency spikes, WAL volume higher than expected.

### Vacuum progress and dead tuples

**Means:** whether MVCC garbage is being cleaned faster than it's produced. **Collect:** `pg_stat_user_tables` (`n_dead_tup`, `n_live_tup`, `last_autovacuum`, `autovacuum_count`), `pg_stat_progress_vacuum` for running vacuums, number of autovacuum workers busy vs `autovacuum_max_workers`, `log_autovacuum_min_duration`. **Healthy:** dead tuples oscillate (rise, then drop after each autovacuum); hot tables vacuumed regularly. **Warning:** dead tuples rising monotonically; all autovacuum workers busy all the time (falling behind); `last_autovacuum` stale on a busy table; the same vacuum running for hours. **Symptoms:** held-back xmin horizon (long transactions, slots, `hot_standby_feedback`), autovacuum too throttled for the write rate, huge tables needing per-table settings.

```sql
SELECT relname, n_live_tup, n_dead_tup,
       round(100.0 * n_dead_tup / NULLIF(n_live_tup + n_dead_tup, 0), 1) AS dead_pct,
       last_autovacuum, now() - last_autovacuum AS since_vacuum
FROM pg_stat_user_tables
WHERE n_live_tup + n_dead_tup > 100000
ORDER BY n_dead_tup DESC LIMIT 10;
```

### Table and index bloat

**Means:** space occupied by dead or free space inside relation files, beyond what live data needs. **Collect:** exact measurement with the `pgstattuple` extension (reads the whole relation — run off-peak or on sampled tables; `pgstattuple_approx` is cheaper), or widely used statistical estimation queries based on `pg_stats` and `pg_class` (approximate). **Healthy:** some free space is normal and useful (room for HOT updates); stable over time. **Warning:** large tables with bloat estimates well above normal (e.g. > 30–50%) and growing; indexes many times larger than expected for their row count. **Symptoms:** past vacuum starvation, mass deletes/updates, a formerly held-back horizon. **Fix:** `pg_repack` or `REINDEX CONCURRENTLY` online; `VACUUM FULL` only in a maintenance window (ACCESS EXCLUSIVE).

### Storage growth

**Means:** free space and its trend. **Collect:** `FreeStorageSpace`/`df`, `pg_database_size`, top relations by `pg_total_relation_size`. **Healthy:** growth matches the capacity model ([Ch 22](topic.html?p=22-capacity-planning)). **Warning:** projected full within days; unexpected acceleration. Alert with a forecast (Prometheus `predict_linear`) rather than a fixed percentage alone. **Symptoms:** bloat, WAL retention, temp files, a new write-heavy feature.

### XID age (wraparound)

**Means:** how many transaction IDs old the oldest unfrozen tuples are. XIDs are 32-bit; vacuum must freeze old tuples before their age approaches ~2 billion. Anti-wraparound autovacuum starts when a table's age exceeds `autovacuum_freeze_max_age` (200M default). If ages keep growing toward ~2^31, PostgreSQL first warns loudly, then stops assigning new XIDs — the database refuses writes until vacuum catches up. **Collect:** `age(datfrozenxid)` per database, `age(relfrozenxid)` per table, and `mxid_age(datminmxid)` for multixacts. **Healthy:** oscillating in the low hundreds of millions (freezing keeps resetting it). **Warning:** consistently above ~500M–1B and rising — something is blocking freezing (long transactions, abandoned prepared transactions, stale slots, a table autovacuum keeps failing on). This is one of the few cause metrics that deserves a page at a high threshold, because the outcome is a write outage.

```sql
SELECT datname, age(datfrozenxid) AS xid_age, mxid_age(datminmxid) AS mxid_age
FROM pg_database ORDER BY xid_age DESC;

SELECT c.oid::regclass AS table, age(c.relfrozenxid) AS xid_age,
       pg_size_pretty(pg_total_relation_size(c.oid)) AS size
FROM pg_class c WHERE c.relkind IN ('r', 'm', 't')
ORDER BY age(c.relfrozenxid) DESC LIMIT 10;
```

### Long-running transactions and the xmin horizon

**Means:** the oldest open transaction or snapshot. **Collect:** `max(now() - xact_start)` and `max(age(backend_xmin))` from `pg_stat_activity`; `pg_prepared_xacts`; slot `xmin`/`catalog_xmin`. **Healthy:** OLTP transactions complete in milliseconds to seconds. **Warning:** anything older than your longest legitimate job; any forgotten prepared transaction. **Symptoms:** bloat across the whole database, vacuum ineffective, XID age rising.

### The dashboard layout

```svg
<svg viewBox="0 0 900 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="450" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">One database dashboard, top to bottom in diagnostic order</text>

  <text x="20" y="50" fill="#2563eb" font-size="11" font-weight="bold">Row 1 RED: is it hurting users?</text>
  <rect x="20" y="58" width="210" height="60" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="125" y="82" text-anchor="middle" fill="#1e293b" font-weight="bold">Latency p50/p95/p99</text>
  <text x="125" y="100" text-anchor="middle" fill="#334155" font-size="10">client histograms, SLO line</text>
  <rect x="240" y="58" width="210" height="60" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="345" y="82" text-anchor="middle" fill="#1e293b" font-weight="bold">TPS / statements/s</text>
  <text x="345" y="100" text-anchor="middle" fill="#334155" font-size="10">commits, rollbacks, calls</text>
  <rect x="460" y="58" width="210" height="60" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="565" y="82" text-anchor="middle" fill="#1e293b" font-weight="bold">Errors by SQLSTATE</text>
  <text x="565" y="100" text-anchor="middle" fill="#334155" font-size="10">40001, 40P01, 57014, 53300</text>
  <rect x="680" y="58" width="200" height="60" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="780" y="82" text-anchor="middle" fill="#1e293b" font-weight="bold">DB load (AAS) by wait</text>
  <text x="780" y="100" text-anchor="middle" fill="#334155" font-size="10">stacked, vCPU line</text>

  <text x="20" y="146" fill="#d97706" font-size="11" font-weight="bold">Row 2 USE resources: which resource?</text>
  <rect x="20" y="154" width="165" height="56" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="102" y="178" text-anchor="middle" fill="#1e293b" font-weight="bold">CPU + run queue</text>
  <text x="102" y="196" text-anchor="middle" fill="#334155" font-size="10">credits if burstable</text>
  <rect x="195" y="154" width="165" height="56" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="277" y="178" text-anchor="middle" fill="#1e293b" font-weight="bold">Memory + hit ratio</text>
  <text x="277" y="196" text-anchor="middle" fill="#334155" font-size="10">swap, temp bytes/s</text>
  <rect x="370" y="154" width="165" height="56" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="452" y="178" text-anchor="middle" fill="#1e293b" font-weight="bold">IOPS vs cap</text>
  <text x="452" y="196" text-anchor="middle" fill="#334155" font-size="10">latency, queue depth</text>
  <rect x="545" y="154" width="165" height="56" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="627" y="178" text-anchor="middle" fill="#1e293b" font-weight="bold">Connections by state</text>
  <text x="627" y="196" text-anchor="middle" fill="#334155" font-size="10">% of max, idle in txn</text>
  <rect x="720" y="154" width="160" height="56" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="800" y="178" text-anchor="middle" fill="#1e293b" font-weight="bold">Network</text>
  <text x="800" y="196" text-anchor="middle" fill="#334155" font-size="10">in/out vs limit</text>

  <text x="20" y="238" fill="#dc2626" font-size="11" font-weight="bold">Row 3 Contention and queries: what inside the engine?</text>
  <rect x="20" y="246" width="280" height="56" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="160" y="270" text-anchor="middle" fill="#1e293b" font-weight="bold">Lock waiters, deadlocks/s</text>
  <text x="160" y="288" text-anchor="middle" fill="#334155" font-size="10">oldest waiter age</text>
  <rect x="310" y="246" width="280" height="56" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="450" y="270" text-anchor="middle" fill="#1e293b" font-weight="bold">Top statements by time (table)</text>
  <text x="450" y="288" text-anchor="middle" fill="#334155" font-size="10">calls, mean, blocks read, delta</text>
  <rect x="600" y="246" width="280" height="56" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="740" y="270" text-anchor="middle" fill="#1e293b" font-weight="bold">Oldest transaction / xmin age</text>
  <text x="740" y="288" text-anchor="middle" fill="#334155" font-size="10">and prepared txns</text>

  <text x="20" y="330" fill="#7c3aed" font-size="11" font-weight="bold">Row 4 Replication and WAL: copies and durability</text>
  <rect x="20" y="338" width="280" height="56" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="160" y="362" text-anchor="middle" fill="#1e293b" font-weight="bold">Replica lag (s and bytes)</text>
  <text x="160" y="380" text-anchor="middle" fill="#334155" font-size="10">per replica, SLO line</text>
  <rect x="310" y="338" width="280" height="56" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="450" y="362" text-anchor="middle" fill="#1e293b" font-weight="bold">WAL bytes/s, FPI share</text>
  <text x="450" y="380" text-anchor="middle" fill="#334155" font-size="10">checkpoints timed vs requested</text>
  <rect x="600" y="338" width="280" height="56" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="740" y="362" text-anchor="middle" fill="#1e293b" font-weight="bold">Slot retained WAL, archiver</text>
  <text x="740" y="380" text-anchor="middle" fill="#334155" font-size="10">inactive slots, failures</text>

  <text x="20" y="422" fill="#16a34a" font-size="11" font-weight="bold">Row 5 Maintenance and growth: slow-burn risks</text>
  <rect x="20" y="430" width="210" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="125" y="452" text-anchor="middle" fill="#1e293b">Dead tuples, vacuum age</text>
  <rect x="240" y="430" width="210" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="345" y="452" text-anchor="middle" fill="#1e293b">Bloat estimates (daily)</text>
  <rect x="460" y="430" width="210" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="565" y="452" text-anchor="middle" fill="#1e293b">Storage + days-to-full</text>
  <rect x="680" y="430" width="200" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="780" y="452" text-anchor="middle" fill="#1e293b">XID / MXID age</text>
</svg>
```

## 5. Implementation

### Simple example: postgres_exporter plus a handful of custom queries

Run the exporter with a least-privilege role (the built-in `pg_monitor` role grants read access to all statistics views):

```sql
CREATE ROLE monitoring WITH LOGIN PASSWORD '...';
GRANT pg_monitor TO monitoring;
ALTER ROLE monitoring SET statement_timeout = '5s';   -- a monitoring query must never hurt the DB
```

The exporter's built-in collectors cover `pg_stat_database`, replication, locks and settings. Anything else can be added as a custom query. Keep custom queries cheap (no `pgstattuple` every 15 seconds) and label cardinality low:

```yaml
# queries.yaml (custom metrics; exporter versions differ in how these are loaded)
pg_xid_age:
  query: "SELECT datname, age(datfrozenxid) AS age FROM pg_database WHERE datallowconn"
  metrics:
    - datname: { usage: "LABEL" }
    - age:     { usage: "GAUGE", description: "XID age of oldest unfrozen tuple" }

pg_slot_retained:
  query: >
    SELECT slot_name, active::int AS active,
           pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn) AS retained_bytes
    FROM pg_replication_slots
  metrics:
    - slot_name:      { usage: "LABEL" }
    - active:         { usage: "GAUGE" }
    - retained_bytes: { usage: "GAUGE" }

pg_oldest_xact:
  query: >
    SELECT coalesce(max(extract(epoch FROM now() - xact_start)), 0) AS seconds
    FROM pg_stat_activity WHERE backend_type = 'client backend' AND xact_start IS NOT NULL
  metrics:
    - seconds: { usage: "GAUGE" }
```

### Real-world example: an alert set that pages on symptoms and tickets on causes

```yaml
groups:
- name: postgres-symptoms            # PAGE: users are hurting or will be very soon
  rules:
  - alert: DBLatencySLOFastBurn
    # client-side histogram; 99% of queries under 50 ms over 30 days -> 1% budget
    expr: |
      (1 - (sum(rate(db_client_duration_bucket{le="0.05",svc="checkout"}[5m]))
            / sum(rate(db_client_duration_count{svc="checkout"}[5m])))) > 14.4 * 0.01
      and
      (1 - (sum(rate(db_client_duration_bucket{le="0.05",svc="checkout"}[1h]))
            / sum(rate(db_client_duration_count{svc="checkout"}[1h])))) > 14.4 * 0.01
    labels: {severity: page}
  - alert: DBDown
    expr: pg_up == 0
    for: 1m
    labels: {severity: page}
  - alert: DBDiskFullSoon
    expr: predict_linear(node_filesystem_avail_bytes{mountpoint=~"/pgdata|/pgwal"}[6h], 4*3600) < 0
    labels: {severity: page}
  - alert: DBXIDWraparoundRisk
    expr: max(pg_xid_age_age) > 1.2e9
    labels: {severity: page}

- name: postgres-causes              # TICKET / business hours: explain and forecast
  rules:
  - alert: DBReplicaLagHigh
    expr: pg_replication_lag_seconds > 30      # metric name varies by exporter/version
    for: 10m
    labels: {severity: ticket}
  - alert: DBInactiveSlotRetainingWAL
    expr: pg_slot_retained_active == 0 and pg_slot_retained_retained_bytes > 20e9
    for: 15m
    labels: {severity: ticket}                 # promote to page if WAL disk is small
  - alert: DBLongTransaction
    expr: pg_oldest_xact_seconds > 3600
    labels: {severity: ticket}
  - alert: DBConnectionsHigh
    expr: sum(pg_stat_activity_count) / max(pg_settings_max_connections) > 0.8
    for: 10m
    labels: {severity: ticket}
  - alert: DBDeadlocks
    expr: increase(pg_stat_database_deadlocks[1h]) > 5
    labels: {severity: ticket}
  - alert: DBXIDAgeRising
    expr: max(pg_xid_age_age) > 5e8
    for: 6h
    labels: {severity: ticket}
```

The fast-burn condition (14.4x the budget rate over both 5 minutes and 1 hour) comes from the multi-window, multi-burn-rate approach in Google's SRE Workbook; see [Ch 25](topic.html?p=25-database-reliability-engineering) for the error-budget reasoning.

> **MySQL difference:** Collect from `performance_schema` and `sys` (e.g. `sys.statement_analysis`, `events_statements_summary_by_digest` which includes latency quantiles in 8.0), `SHOW GLOBAL STATUS` (`Threads_connected`, `Threads_running`, `Innodb_buffer_pool_reads` vs `read_requests`, `Innodb_row_lock_waits`), `information_schema.INNODB_METRICS`, and `SHOW REPLICA STATUS`. The MySQL-specific signals to add are **history list length** (undo not purged — MySQL's version of the held-back horizon), redo log checkpoint age, and replica SQL thread errors. There's no XID wraparound in InnoDB, but there is undo tablespace growth. mysqld_exporter is the Prometheus equivalent.

## 6. Advantages, Disadvantages & Trade-offs

| Choice | Benefit | Cost |
|---|---|---|
| 15 s scrape interval | Catches short spikes | More samples; exporter queries run more often |
| 60 s scrape interval | Cheap | Short lock storms can vanish between samples |
| Client-side latency histograms | True percentiles, per operation | Needs instrumentation in every service |
| `pg_stat_statements` only | Zero app changes | Means and stddev, not percentiles |
| Per-table metrics as labels | Rich drill-down | Cardinality explosion on schemas with thousands of tables — use top-N queries instead |
| Symptom-only paging | Few, meaningful pages | Must pair with forecast pages for disk-full and wraparound |
| Managed (PI / Database Insights) | Wait-event history out of the box | Vendor-specific, retention tiers |

### When to use each alert type

- **Page:** SLO burn on latency/errors, DB unreachable, disk full within hours, wraparound risk, replication broken for an HA-critical standby.
- **Ticket:** lag above freshness target, dead tuples trending up, bloat, long transactions, connection creep, deadlocks, requested checkpoints, slot retention.
- **Dashboard only:** CPU, hit ratio, IOPS, TPS — context for diagnosis.

### When NOT to alert

- On raw CPU %, cache hit ratio, or connection count alone at a fixed threshold, paging at night — they fire during healthy batch windows and teach people to ignore pages.
- On lifetime counters or averages computed since server start.

## 7. Common Mistakes & Best Practices

**1. Paging on CPU.** *Why it hurts:* high CPU with good latency isn't an incident; low CPU during a lock storm is. *Instead:* page on latency/error SLO burn; show CPU on the dashboard.

**2. Graphing counters instead of rates.** *Instead:* `rate()`/`increase()` for every `pg_stat_*` counter; handle stats resets.

**3. Only monitoring the data volume.** *Why it hurts:* WAL on a separate volume fills from a slot or archive failure while data free space looks fine. *Instead:* monitor every volume, retained WAL per slot, and the archiver.

**4. Not monitoring XID age.** *Why it hurts:* wraparound shutdowns come with weeks of warning, all ignored. *Instead:* graph and alert on `age(datfrozenxid)` and multixact age.

**5. Using averages for latency.** *Instead:* histograms and p95/p99, per operation.

**6. Replica lag from timestamps only.** *Why it hurts:* `pg_last_xact_replay_timestamp()` looks lagged on an idle primary and can hide a disconnected replica. *Instead:* LSN-based lag from the primary and replica connection state.

**7. Expensive monitoring queries.** *Why it hurts:* a bloat query that scans every table every 15 seconds becomes load. *Instead:* `statement_timeout` for the monitoring role, cheap queries at high frequency, expensive ones (bloat, sizes of all relations) hourly or daily.

**8. No baseline.** *Instead:* week-over-week overlays on key panels; alert on deviation for metrics without universal thresholds.

**9. Monitoring the primary only.** *Instead:* every replica gets the same dashboard (lag, conflicts, CPU, I/O) — replicas serve users too.

## 8. Production: Failure Scenarios, Monitoring & Scaling

**Wraparound warning ignored.** Logs have said "database must be vacuumed within N transactions" for days; nobody reads the logs. XID age alert would have fired at 500M weeks earlier. Root cause: an abandoned prepared transaction (`pg_prepared_xacts`) from a 2PC experiment pinned the horizon. Fix: `ROLLBACK PREPARED`, vacuum; add prepared transaction age to the dashboard.

**The silent replica.** A replica's WAL receiver disconnected after a network change; timestamp-based lag was flat because the metric query failed and returned no data. Users read week-old data from a reporting replica. Fix: alert on `absent()`/no data, on replica connection state from `pg_stat_replication` on the primary, and on LSN diff.

**Alert fatigue.** 40 alerts per week, mostly CPU and hit ratio during batch jobs; a real replica-lag incident is acknowledged and ignored. Fix: re-tier alerts — page on SLO burn and imminent resource exhaustion only; everything else is a ticket; review alert precision monthly.

**Bloat creeping for months.** Disk grew 3x with 20% data growth; no bloat metric. A long-running reporting session with `hot_standby_feedback` had been holding back vacuum on the primary. Fix: daily bloat estimate, xmin-age alert, reporting moved to a warehouse.

**Monitoring at scale.** For fleets of many databases, standardize one exporter config and dashboard template, label by cluster and role (primary/replica), and aggregate fleet-level views (worst XID age, worst lag, least free space). Keep per-statement detail in `pg_stat_statements` (queried on demand or sampled to a store) rather than as metric labels.

## 9. Interview Questions

**Q: What are the most important database metrics to monitor, and why?**
A: I split them into symptoms and causes. Symptoms: query latency percentiles from the client, throughput (TPS and statements/s), and errors by SQLSTATE — they tell me whether users are affected. Causes, organized by USE: CPU and run queue, memory and cache hit ratio, IOPS and disk latency against caps, connections by state, lock waits and deadlocks, replication lag, WAL rate and retention, dead tuples and vacuum, bloat, storage growth, XID age. Several of the causes are database-specific and invisible to host monitoring, which is why a CPU-and-disk dashboard misses most real incidents.

**Q: How do you compute the cache hit ratio correctly, and what does a drop mean?**
A: `blks_hit / (blks_hit + blks_read)` from `pg_stat_database`, but on rates over a window, because lifetime totals hide current behaviour. A sustained drop from baseline usually means the working set no longer fits in shared_buffers, or a new scan-heavy query started. A "read" might still come from the OS page cache, so I check disk read IOPS and `IO:DataFileRead` waits alongside it. Small percentage drops matter: going from 99.5% to 98% can mean four times more reads leaving shared_buffers.

**Q: Why monitor idle-in-transaction sessions specifically?**
A: Because an idle-in-transaction session holds its locks and its snapshot while doing nothing. The locks can block other writers and DDL; the snapshot holds back the xmin horizon so vacuum can't remove dead tuples anywhere, causing bloat and eventually XID age growth. They're usually application bugs — work done between BEGIN and COMMIT, or a missed commit on an error path. I graph count and oldest age and set `idle_in_transaction_session_timeout` as a guardrail.

**Q: What is XID wraparound and how do you monitor for it?**
A: PostgreSQL transaction IDs are 32-bit, and visibility depends on comparing them, so old tuples must be frozen before their XIDs become ambiguous. Autovacuum does this, with anti-wraparound vacuums once a table's age passes `autovacuum_freeze_max_age` (200M by default). If freezing is blocked — long transactions, abandoned prepared transactions, stale slots — age keeps rising, and near about 2 billion the database stops assigning XIDs and refuses writes. I monitor `age(datfrozenxid)` per database, the oldest tables by `age(relfrozenxid)`, and multixact age, with a ticket around 500M and a page well before the danger zone.

**Q: How would you monitor replication lag reliably?**
A: From both sides. On the primary, `pg_stat_replication` gives write, flush and replay lag plus LSNs, so I compute bytes behind with `pg_wal_lsn_diff` and alert if a replica disappears from the view. On the replica, `now() - pg_last_xact_replay_timestamp()` gives time lag but overstates it when the primary is idle, so I don't use it alone. I alert on sustained lag above the freshness target and, separately, on the replica being disconnected or the metric being absent.

**Q: What's the difference between a symptom alert and a cause alert?**
A: A symptom alert fires when users are affected — latency or error SLO burning, the database unreachable. A cause alert fires on a resource or internal state that might lead to symptoms — high CPU, lag, dead tuples. Symptom alerts page because they're always actionable and always matter; cause alerts become tickets or dashboard context because they often don't matter by themselves. The exceptions are causes that predict certain outages with little time to act, like disk full in hours or XID age approaching the limit — those page, based on forecasts.

**Q: Why aren't pg_stat_statements numbers enough for latency SLOs?**
A: They give per-statement calls, total, mean, min, max and stddev time, but not percentiles, and only server execution time — not time waiting for a pooled connection, network round trips, or client-side queueing. SLOs are about what the caller experiences, usually at p95/p99. So I measure latency histograms in the application's DB client and use `pg_stat_statements` to attribute time to statements during diagnosis.

**Q: How do you detect that autovacuum is falling behind?**
A: Dead tuples on busy tables rising monotonically instead of oscillating, `last_autovacuum` getting stale, all autovacuum workers busy continuously, and individual vacuums running for hours in `pg_stat_progress_vacuum`. If vacuums run but dead tuples don't drop, it's a held-back horizon — I'd look at the oldest `backend_xmin`, prepared transactions, slots and standby feedback. If vacuums can't keep pace, I'd tune per-table scale factors and cost limits.

**Q: Design the alerting for a production PostgreSQL cluster backing a payments service. (Senior)**
A: I'd start from SLOs: for example 99.9% of payment DB operations under 100 ms and 99.95% success, measured from the service's client histograms. Pages come from multi-window burn-rate alerts on those SLOs, database unreachable, failover events, data or WAL disk full within hours by linear prediction, XID age approaching danger, and synchronous standby loss if we depend on it for zero-RPO. Tickets cover replica lag above freshness targets, inactive slots, archiver failures, long transactions, deadlock rate, connection saturation, dead-tuple trends and bloat. Every page links a runbook. I'd review alert precision monthly and delete anything nobody acted on.

**Q: WAL generation doubled after a release but write QPS is unchanged. What could cause it and how would you confirm? (Senior)**
A: Candidates: updates now touch an indexed column, so HOT updates became non-HOT and every index gets a new entry; a new index on a heavily updated table; more full-page images because checkpoints became more frequent (requested checkpoints) or the write pattern touches many more distinct pages; wider rows or bigger JSON payloads; or a new job rewriting rows unnecessarily. I'd compare `pg_stat_wal.wal_fpi` vs `wal_records`, check `n_tup_hot_upd` vs `n_tup_upd` per table before and after, look at `pg_stat_statements.wal_bytes` per statement to find the generator, and check checkpoint stats. The fix depends on the finding — drop or change an index, avoid updating indexed columns, raise `max_wal_size`.

**Q: You run 300 PostgreSQL databases. How do you keep monitoring manageable? (Senior)**
A: Standardize: one exporter configuration, one dashboard template parameterized by cluster, one alert rule set with severity tiers, all managed as code. Labels stay low-cardinality — cluster, role, region — and per-statement or per-table detail lives in on-demand queries or a sampled store, not in metric labels. Fleet views rank the worst offenders — highest XID age, most lag, least disk runway, most bloat — so a handful of panels covers everything. Alert routing goes to the owning team via a cluster-to-owner map, and a periodic review retires noisy rules.

## 10. Quick Revision & Cheat Sheet

| Metric | Source | Healthy (guidance) | Worry when |
|---|---|---|---|
| Latency p99 | Client histograms | Stable vs baseline | SLO burn, step change |
| TPS / statements/s | `pg_stat_database`, `pg_stat_statements` | Tracks traffic | Drops at steady traffic; calls up faster than requests |
| CPU | Host / cloud | < ~60–70% peak | Sustained > 80%, run queue > vCPUs |
| Hit ratio | `pg_stat_database` (rates) | ~99%+ OLTP | Sustained drop vs baseline |
| IOPS / latency | iostat, CloudWatch | Under cap, low await | Flat at cap, await/queue rising, burst falling |
| Connections | `pg_stat_activity` | < ~75% of max | > 80–90%, idle-in-txn rising |
| Lock waits | `pg_stat_activity` Lock waits | Brief, few | Many waiting > seconds; AccessExclusive waiters |
| Deadlocks | `pg_stat_database.deadlocks` | ~0 | Any sustained rate |
| Replica lag | `pg_stat_replication` | Sub-second–seconds | > freshness SLO, growing, absent |
| WAL | `pg_stat_wal`, slots, archiver | Follows writes | Retained growing, inactive slot, archive failures |
| Dead tuples | `pg_stat_user_tables` | Oscillating | Monotonic rise |
| Bloat | pgstattuple / estimates | Stable | Large and growing |
| Storage | df / FreeStorageSpace | Matches plan | Full within days |
| XID age | `age(datfrozenxid)` | Low hundreds of millions | > ~500M rising; page well before ~2B |

- Page on symptoms (SLO burn) and imminent exhaustion (disk, wraparound); ticket on causes.
- Graph rates of counters; diff over windows; never trust lifetime ratios.
- Percentiles from the client; attribution from `pg_stat_statements`.
- Monitor every volume and every replica, not just the primary's data disk.
- XID age, slot retention and idle-in-transaction are database-specific must-haves.
- Lay dashboards out in diagnostic order: RED, USE, contention, replication/WAL, maintenance.

## 11. Hands-On Exercises

Lab: `docker compose` with `postgres:17`, `prometheuscommunity/postgres-exporter`, Prometheus and Grafana; `shared_preload_libraries=pg_stat_statements`.

1. **Rate vs counter.** Graph `pg_stat_database_xact_commit` raw and as `rate(...[1m])` while running pgbench; explain the difference.
2. **Custom metrics.** Add the XID age, slot retained and oldest transaction queries; then open a transaction and leave it idle and watch `pg_oldest_xact_seconds` climb.
3. **Hit ratio drop.** With small `shared_buffers`, run pgbench at scale 50 then 500 and graph the hit ratio computed from rates and `IO:DataFileRead` waits.
4. **Slot alert.** Create a logical slot, generate WAL, and fire the inactive-slot alert; drop the slot and watch it resolve.
5. **Burn-rate alert.** Instrument a small Python service with a DB latency histogram (prometheus_client), add `pg_sleep` randomly, and trigger the fast-burn alert.

**Mini project:** Build the five-row dashboard from the diagram as JSON (Grafana) with the metrics above, plus an alert rule file with page and ticket tiers, each alert linking to a runbook stub.

## 12. Related Topics & Free Learning Resources

**This handbook:** [Ch 03 · MVCC](topic.html?p=03-mvcc) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) · [Ch 09 · Replication](topic.html?p=09-replication) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) · [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) · [Ch 23 · Bottleneck Diagnosis](topic.html?p=23-bottleneck-diagnosis) · [Ch 25 · Database Reliability Engineering](topic.html?p=25-database-reliability-engineering)

**SQL Handbook:** [Locking & MVCC](../sql/topic.html?p=27-locking-mvcc) · [Query Optimization & EXPLAIN](../sql/topic.html?p=21-query-optimization)

**Other handbooks:** [System Design · Observability](../system-design/topic.html?p=28-observability) · [Caching with Redis · Observability](../redis-caching/topic.html?p=28-observability) · [Kafka & RabbitMQ · Monitoring & Lag](../messaging/topic.html?p=27-monitoring-lag) · [Cassandra · Monitoring & Metrics](../cassandra/topic.html?p=31-monitoring-metrics)

- **PostgreSQL Documentation — Monitoring Database Activity** — PostgreSQL · *Intermediate* · every statistics view and column referenced in this chapter. <https://www.postgresql.org/docs/current/monitoring.html>
- **PostgreSQL Documentation — Routine Vacuuming (preventing XID wraparound)** — PostgreSQL · *Advanced* · freezing, `autovacuum_freeze_max_age` and what happens near wraparound. <https://www.postgresql.org/docs/current/routine-vacuuming.html>
- **postgres_exporter** — Prometheus Community · *Intermediate* · the standard Prometheus exporter, collectors and custom query configuration. <https://github.com/prometheus-community/postgres_exporter>
- **Google SRE Workbook — Alerting on SLOs** — Google · *Advanced* · multi-window, multi-burn-rate alerting used in the example rules. <https://sre.google/workbook/alerting-on-slos/>
- **Brendan Gregg — The USE Method** — Brendan Gregg · *Intermediate* · the resource checklist behind the USE table. <https://www.brendangregg.com/usemethod.html>
- **Tom Wilkie — The RED Method** — Grafana Labs · *Intermediate* · the service-level counterpart to USE. <https://grafana.com/blog/2018/08/02/the-red-method-how-to-instrument-your-services/>
- **PostgreSQL Documentation — pgstattuple** — PostgreSQL · *Advanced* · exact bloat measurement and its cost. <https://www.postgresql.org/docs/current/pgstattuple.html>

---

*Database Design Handbook — chapter 24.*
