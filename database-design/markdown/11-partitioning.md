# 11 · Partitioning: Pruning, Keys & Lifecycle

> **In one line:** Partitioning is mostly an *operational* tool — it makes data lifecycle, vacuum and bulk maintenance cheap — and only a *performance* tool when your hot queries carry the partition key in a form the planner can prune on; choose the key from access patterns and retention, not from table size.

---

## 1. Overview

A team has a 3 TB `events` table growing by 400 GB a month. Queries are slowing down, autovacuum on the table runs for eleven hours, and deleting 90-day-old rows with a nightly `DELETE` generates more WAL than the day's real traffic. Someone says "let's partition it" — and they are half right. Partitioning will fix the retention job (drop a partition instead of deleting a billion rows), it will fix vacuum (each partition is vacuumed on its own, and old partitions stop changing), and it will make "last 24 hours" queries touch one small partition. But it will *not* make `SELECT * FROM events WHERE id = $1` faster — that query, lacking the partition key, now probes forty indexes instead of one. And if the ORM wraps the timestamp in `date_trunc()`, pruning silently stops working and every dashboard query scans every partition.

That is the whole chapter in one story: **partitioning is not a performance silver bullet.** The B-tree depth win is small (an index over a billion rows is maybe four levels deep; over 30 million rows, three). The real wins are:

1. **Lifecycle** — `DROP` / `DETACH` a partition is a catalog operation; `DELETE` of the same rows is a row-by-row write storm that leaves bloat behind.
2. **Maintenance locality** — vacuum, analyze, reindex and backups work on bounded, mostly-cold pieces instead of one ever-growing heap.
3. **Pruning** — queries that filter on the key touch only the partitions that can match, which keeps the working set (the recent partitions and their indexes) small enough to stay cached.

The naive approach fails in two opposite ways. Teams that never partition end up with an unmaintainable monolith where retention is impossible and a single `VACUUM` pass is measured in hours. Teams that partition "because it's big" pick the wrong key, create thousands of tiny partitions, and discover that planning time, lock counts and global uniqueness have become their new problems. This chapter is about getting between those failure modes: how pruning *really* works (plan time vs execution time and the ways it fails), how to choose the key from access patterns, the hot-partition problem, pg_partman-style maintenance, how to repartition a live table, and the limits you accept in exchange.

> **Builds on:** [SQL Handbook · Partitioning & Sharding](../sql/topic.html?p=23-partitioning) (the `PARTITION BY RANGE/LIST/HASH` syntax, local vs global indexes, the basic idea of pruning) · [SQL Handbook · Execution Plans](../sql/topic.html?p=22-execution-plans) (reading `EXPLAIN`) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (why `DELETE` leaves dead tuples) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (lock levels taken by DDL). This chapter assumes the syntax and goes into pruning mechanics, key selection, maintenance and failure modes at production scale.

## 2. Core Concepts

- **Partitioned table (parent)** — a logical table with no storage of its own; every row lives in exactly one leaf partition. *Why it matters:* statistics, locks and DDL behave differently on the parent than on leaves — e.g. autovacuum never analyzes the parent.
- **Partition key** — the column(s) whose value routes a row. *Why it matters:* it decides which queries can prune, what your primary key must contain, and where write load concentrates.
- **Plan-time pruning** — the planner removes partitions using constants in the query. *Why it matters:* the cheapest form; pruned partitions are never even opened or locked by the plan.
- **Execution-time (runtime) pruning** — pruning using values only known when the query runs: bound parameters of a generic plan, `STABLE` expressions like `now()`, or join keys in a nested loop. *Why it matters:* shows up as `Subplans Removed: N` or `(never executed)`; without it prepared statements would scan everything.
- **Hot partition** — the partition absorbing most writes (usually "now"). *Why it matters:* its stats, bloat and index contention matter far more than the other 99 partitions combined.
- **Default partition** — catches rows matching no other partition. *Why it matters:* a safety net that turns into a trap — every new partition has to verify the default holds none of its rows.
- **Premake** — creating partitions *ahead* of the data that will need them. *Why it matters:* if next month's partition does not exist at midnight, inserts either fail or pile into the default.
- **Detach / attach** — removing a partition from (or adding a table to) the partition tree without copying data. *Why it matters:* the building block for archiving, swapping, and repartitioning.
- **Partition-wise join / aggregate** — executing a join or `GROUP BY` partition by partition when both sides share the scheme. *Why it matters:* can cut memory and enable parallelism, but is off by default (`enable_partitionwise_join`, `enable_partitionwise_aggregate`) because it raises planning cost.
- **Partition count** — how many leaves exist. *Why it matters:* every leaf is a relation with its own indexes, relcache entries and locks; too many turns planning and locking into the bottleneck.

## 3. Theory & Principles

### Why partition — and what it does not buy you

Think in terms of *what gets smaller*. A partition is a normal table: its own heap, its own indexes, its own visibility map, its own vacuum schedule. When a query can be confined to one partition, everything it touches is proportionally smaller. When it cannot, it touches *all* of them, plus the overhead of an `Append` node over N children.

| Operation | Unpartitioned 3 TB table | 36 monthly partitions |
|---|---|---|
| `DELETE` rows older than 36 months | Billions of dead tuples, WAL for each, long vacuum | `DROP TABLE events_2023_09` — milliseconds |
| Autovacuum on active data | Scans a huge heap (visibility map helps, but index cleanup scans every index) | Mostly on the current partition; old ones become all-frozen and skipped |
| `WHERE created_at > now() - '1 day'` | Index range scan on a big index | Index scan on one ~80 GB partition |
| `WHERE id = 42` (no key) | One index probe | 36 index probes (one per partition) |
| Unique `email` across all rows | One unique index | Impossible as a partitioned constraint |

The last two rows are the tax. If your top queries by `pg_stat_statements` total time do not filter on the candidate key, partitioning makes them *slower*.

### How pruning actually works

PostgreSQL stores each leaf's bounds in the catalog (`pg_class.relpartbound`). Pruning is the act of comparing the query's key predicates against those bounds. It happens at up to three moments, and knowing which one applies is the key to debugging "why is it scanning everything?".

1. **Plan-time pruning.** The WHERE clause compares the raw key column to constants (`created_at >= '2026-07-01'`). The planner prunes before building child plans; pruned partitions do not appear in `EXPLAIN` at all, and — in recent versions — are not even locked or opened during planning.
2. **Executor-initialisation pruning.** The value is known only at execution start: a `$1` in a generic plan, or a `STABLE` function such as `now()` or `current_date` (they can change between plan and execution, so the planner may not fold them). The plan contains all children; the executor removes the non-matching ones before running. `EXPLAIN` shows `Subplans Removed: N`.
3. **Per-rescan pruning.** In a parameterised nested loop (`JOIN days d ON e.created_at >= d.start`), the inner `Append` re-prunes for every outer row. Partitions never needed show `(never executed)` in `EXPLAIN ANALYZE`.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c11a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c11a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The three moments pruning can happen (and the one where it cannot)</text>
  <rect x="20" y="40" width="200" height="40" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="120" y="64" text-anchor="middle" fill="#334155" font-weight="bold">Parse + plan</text>
  <rect x="340" y="40" width="200" height="40" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="64" text-anchor="middle" fill="#334155" font-weight="bold">Executor start</text>
  <rect x="660" y="40" width="200" height="40" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="760" y="64" text-anchor="middle" fill="#334155" font-weight="bold">Execution (per rescan)</text>
  <path d="M222,60 L336,60" stroke="#2563eb" stroke-width="2" marker-end="url(#c11a1)"/>
  <path d="M542,60 L656,60" stroke="#2563eb" stroke-width="2" marker-end="url(#c11a1)"/>
  <rect x="20" y="96" width="200" height="150" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="120" y="116" text-anchor="middle" fill="#15803d" font-weight="bold">1. Plan-time pruning</text>
  <text x="30" y="138" fill="#14532d" font-size="10">created_at &gt;= '2026-07-01'</text>
  <text x="30" y="154" fill="#14532d" font-size="10">AND created_at &lt; '2026-08-01'</text>
  <text x="30" y="176" fill="#166534" font-size="10">constants vs relpartbound</text>
  <text x="30" y="192" fill="#166534" font-size="10">pruned leaves never appear</text>
  <text x="30" y="208" fill="#166534" font-size="10">in the plan at all</text>
  <text x="30" y="232" fill="#15803d" font-size="10" font-weight="bold">EXPLAIN: 1 child listed</text>
  <rect x="340" y="96" width="200" height="150" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="440" y="116" text-anchor="middle" fill="#1e40af" font-weight="bold">2. Init-time pruning</text>
  <text x="350" y="138" fill="#1e3a8a" font-size="10">created_at &gt;= $1 (generic plan)</text>
  <text x="350" y="154" fill="#1e3a8a" font-size="10">created_at &gt; now() - '7 days'</text>
  <text x="350" y="176" fill="#1e40af" font-size="10">value known only at run time;</text>
  <text x="350" y="192" fill="#1e40af" font-size="10">plan has all children, executor</text>
  <text x="350" y="208" fill="#1e40af" font-size="10">drops non-matching ones</text>
  <text x="350" y="232" fill="#1e40af" font-size="10" font-weight="bold">EXPLAIN: Subplans Removed: N</text>
  <rect x="660" y="96" width="200" height="150" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="760" y="116" text-anchor="middle" fill="#5b21b6" font-weight="bold">3. Per-rescan pruning</text>
  <text x="670" y="138" fill="#4c1d95" font-size="10">Nested Loop</text>
  <text x="670" y="154" fill="#4c1d95" font-size="10">  inner: e.created_at = d.day</text>
  <text x="670" y="176" fill="#5b21b6" font-size="10">re-pruned for each outer row;</text>
  <text x="670" y="192" fill="#5b21b6" font-size="10">only parameterised nested loops</text>
  <text x="670" y="208" fill="#5b21b6" font-size="10">(hash/merge joins cannot)</text>
  <text x="670" y="232" fill="#5b21b6" font-size="10" font-weight="bold">EXPLAIN ANALYZE: (never executed)</text>
  <rect x="20" y="266" width="840" height="186" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="290" text-anchor="middle" fill="#b91c1c" font-size="13" font-weight="bold">No pruning at any stage: every partition is scanned</text>
  <text x="40" y="316" fill="#7f1d1d" font-size="11">Function on the key:  date_trunc('day', created_at) = '2026-07-10'   or   created_at::date = '2026-07-10'</text>
  <text x="40" y="338" fill="#7f1d1d" font-size="11">Key missing from WHERE:  WHERE user_id = 42   (the table is partitioned by created_at)</text>
  <text x="40" y="360" fill="#7f1d1d" font-size="11">Key hidden behind OR with a non-key column:  created_at &gt; X  OR  status = 'failed'</text>
  <text x="40" y="382" fill="#7f1d1d" font-size="11">Key only reachable through a hash join from another table (no parameterised nested loop)</text>
  <text x="40" y="404" fill="#7f1d1d" font-size="11">HASH partitioning with a range predicate (hash pruning needs equality)</text>
  <path d="M40,424 L80,424" stroke="#dc2626" stroke-width="2" marker-end="url(#c11a2)"/>
  <text x="90" y="428" fill="#991b1b" font-size="11" font-weight="bold">Fix: rewrite as a raw range on the key column:  created_at &gt;= '2026-07-10' AND created_at &lt; '2026-07-11'</text>
</svg>
```

The rule behind every failure case is the same: pruning compares **the bare key column** against a value using an operator from the partition's operator class. Anything that transforms the column (casts, functions, arithmetic on the column side) means the planner cannot map the predicate to bounds. Transform the *constant* instead.

### Choosing the partition key from access patterns

Do not start from "what column is big". Start from three questions:

1. **What do the top queries filter on?** Take `pg_stat_statements` ordered by `total_exec_time` and read the WHERE clauses. If 90% of time is spent in queries with `created_at` ranges, time is your key. If it is `tenant_id = $1`, consider LIST/HASH by tenant.
2. **How does data die?** Retention by age (logs, events, audit) wants RANGE on time so death is `DROP`. Retention by tenant (customer leaves) wants partitioning by tenant so offboarding is `DETACH`.
3. **Where do uniqueness and foreign keys need to hold?** The primary key must include the partition key. If you partition `orders` by `created_at`, the PK becomes `(id, created_at)` and a lookup by `id` alone no longer uses a unique constraint to stop at one row.

Two-level schemes (RANGE by month, sub-partitioned by HASH of tenant) exist, but each level multiplies the partition count. Use them only when both dimensions genuinely prune in hot queries.

## 4. Architecture & Workflow

### The partition lifecycle

A time-partitioned table is a conveyor belt. Partitions are born empty ahead of time, become the hot write target for one interval, cool into read-mostly history, and finally leave — detached into an archive, or dropped. The operational job is to keep the belt moving without anyone noticing.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c11b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Lifecycle of a monthly partition (retention = 13 months, premake = 4)</text>
  <rect x="20" y="44" width="150" height="120" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="95" y="64" text-anchor="middle" fill="#5b21b6" font-weight="bold">PREMADE</text>
  <text x="30" y="84" fill="#4c1d95" font-size="10">created 1-4 months early</text>
  <text x="30" y="100" fill="#4c1d95" font-size="10">empty, indexes built</text>
  <text x="30" y="116" fill="#4c1d95" font-size="10">cheap to create now,</text>
  <text x="30" y="132" fill="#4c1d95" font-size="10">not at 00:00 on the 1st</text>
  <text x="30" y="152" fill="#5b21b6" font-size="10" font-weight="bold">run_maintenance()</text>
  <rect x="195" y="44" width="150" height="120" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="270" y="64" text-anchor="middle" fill="#b91c1c" font-weight="bold">HOT (current)</text>
  <text x="205" y="84" fill="#7f1d1d" font-size="10">all INSERTs land here</text>
  <text x="205" y="100" fill="#7f1d1d" font-size="10">most reads land here</text>
  <text x="205" y="116" fill="#7f1d1d" font-size="10">stats go stale fast</text>
  <text x="205" y="132" fill="#7f1d1d" font-size="10">autovacuum busiest</text>
  <text x="205" y="152" fill="#b91c1c" font-size="10" font-weight="bold">tune per-partition</text>
  <rect x="370" y="44" width="150" height="120" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="445" y="64" text-anchor="middle" fill="#92400e" font-weight="bold">WARM</text>
  <text x="380" y="84" fill="#78350f" font-size="10">late updates only</text>
  <text x="380" y="100" fill="#78350f" font-size="10">vacuum freezes it,</text>
  <text x="380" y="116" fill="#78350f" font-size="10">then it is skipped</text>
  <text x="380" y="132" fill="#78350f" font-size="10">range reports read it</text>
  <text x="380" y="152" fill="#92400e" font-size="10" font-weight="bold">VACUUM (FREEZE) once</text>
  <rect x="545" y="44" width="150" height="120" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="620" y="64" text-anchor="middle" fill="#1e40af" font-weight="bold">COLD</text>
  <text x="555" y="84" fill="#1e3a8a" font-size="10">read-only in practice</text>
  <text x="555" y="100" fill="#1e3a8a" font-size="10">candidates: cheaper</text>
  <text x="555" y="116" fill="#1e3a8a" font-size="10">tablespace, fewer</text>
  <text x="555" y="132" fill="#1e3a8a" font-size="10">indexes, compression</text>
  <text x="555" y="152" fill="#1e40af" font-size="10" font-weight="bold">outside the working set</text>
  <rect x="720" y="44" width="140" height="120" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="790" y="64" text-anchor="middle" fill="#334155" font-weight="bold">RETIRED</text>
  <text x="730" y="84" fill="#334155" font-size="10">DETACH CONCURRENTLY</text>
  <text x="730" y="100" fill="#334155" font-size="10">then dump to object</text>
  <text x="730" y="116" fill="#334155" font-size="10">storage and DROP;</text>
  <text x="730" y="132" fill="#334155" font-size="10">or DROP directly</text>
  <text x="730" y="152" fill="#334155" font-size="10" font-weight="bold">O(1), no dead tuples</text>
  <path d="M172,104 L191,104" stroke="#334155" stroke-width="2" marker-end="url(#c11b1)"/>
  <path d="M347,104 L366,104" stroke="#334155" stroke-width="2" marker-end="url(#c11b1)"/>
  <path d="M522,104 L541,104" stroke="#334155" stroke-width="2" marker-end="url(#c11b1)"/>
  <path d="M697,104 L716,104" stroke="#334155" stroke-width="2" marker-end="url(#c11b1)"/>
  <text x="20" y="196" fill="#1e293b" font-size="12" font-weight="bold">Timeline on 2026-09-24 (monthly partitions)</text>
  <rect x="20" y="208" width="50" height="34" fill="#f1f5f9" stroke="#94a3b8"/><text x="45" y="229" text-anchor="middle" fill="#334155" font-size="9">2025-08</text>
  <rect x="72" y="208" width="50" height="34" fill="#dbeafe" stroke="#2563eb"/><text x="97" y="229" text-anchor="middle" fill="#1e3a8a" font-size="9">2025-09</text>
  <rect x="124" y="208" width="300" height="34" fill="#dbeafe" stroke="#2563eb"/><text x="274" y="229" text-anchor="middle" fill="#1e3a8a" font-size="10">2025-10 ... 2026-06  (cold, frozen)</text>
  <rect x="426" y="208" width="60" height="34" fill="#fef3c7" stroke="#d97706"/><text x="456" y="229" text-anchor="middle" fill="#78350f" font-size="9">2026-07</text>
  <rect x="488" y="208" width="60" height="34" fill="#fef3c7" stroke="#d97706"/><text x="518" y="229" text-anchor="middle" fill="#78350f" font-size="9">2026-08</text>
  <rect x="550" y="208" width="70" height="34" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/><text x="585" y="229" text-anchor="middle" fill="#7f1d1d" font-size="9" font-weight="bold">2026-09 HOT</text>
  <rect x="622" y="208" width="56" height="34" fill="#ede9fe" stroke="#7c3aed"/><text x="650" y="229" text-anchor="middle" fill="#4c1d95" font-size="9">2026-10</text>
  <rect x="680" y="208" width="56" height="34" fill="#ede9fe" stroke="#7c3aed"/><text x="708" y="229" text-anchor="middle" fill="#4c1d95" font-size="9">2026-11</text>
  <rect x="738" y="208" width="56" height="34" fill="#ede9fe" stroke="#7c3aed"/><text x="766" y="229" text-anchor="middle" fill="#4c1d95" font-size="9">2026-12</text>
  <rect x="796" y="208" width="64" height="34" fill="#ede9fe" stroke="#7c3aed"/><text x="828" y="229" text-anchor="middle" fill="#4c1d95" font-size="9">2027-01</text>
  <text x="45" y="258" text-anchor="middle" fill="#dc2626" font-size="9">drop next</text>
  <text x="708" y="258" text-anchor="middle" fill="#7c3aed" font-size="9">premade (4 ahead)</text>
  <rect x="20" y="276" width="840" height="138" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="40" y="298" fill="#1e293b" font-size="12" font-weight="bold">What breaks the belt</text>
  <text x="40" y="320" fill="#334155" font-size="11">Maintenance job silently stopped: premade buffer drains; after 4 months inserts fail ("no partition of relation found") or fill DEFAULT.</text>
  <text x="40" y="342" fill="#334155" font-size="11">Rows landed in DEFAULT: creating the matching partition now fails, because PostgreSQL must prove DEFAULT holds none of its rows.</text>
  <text x="40" y="364" fill="#334155" font-size="11">Retention never ran: disk fills with cold partitions nobody queries; restore times grow with them.</text>
  <text x="40" y="386" fill="#334155" font-size="11">Plain DETACH/DROP on the parent: takes ACCESS EXCLUSIVE and queues behind a long report query, blocking every insert behind it.</text>
  <text x="40" y="406" fill="#16a34a" font-size="11" font-weight="bold">Alert on: days of premade partitions remaining, rows in DEFAULT, oldest partition age vs retention.</text>
</svg>
```

### The hot partition ("current month") problem

On a single PostgreSQL node, a hot partition is not a *throughput* problem — all partitions share the same disks, WAL and buffer pool, so routing all inserts to one partition costs no more than routing them to an unpartitioned table. It is a **statistics and maintenance** problem:

- **Fresh partitions have no statistics.** At 00:00 on the 1st, `events_2026_10` is empty. Autovacuum's analyze threshold (`autovacuum_analyze_threshold` 50 + `autovacuum_analyze_scale_factor` 0.1 × reltuples) fires early, but between runs the planner is estimating a table that grew from 0 to 5 million rows. The classic symptom is "the dashboard is slow for the first few hours of each month" — the planner thinks the current partition is tiny and picks a nested loop.
- **Autovacuum never analyzes the parent.** Partitioned parents have no storage, so autovacuum skips them. Queries that span many partitions use parent-level statistics for join estimates; those stats are only refreshed by a manual `ANALYZE events`. Schedule it.
- **Right-edge index contention.** A B-tree on a monotonically increasing timestamp or bigint concentrates inserts on the rightmost leaf page. This is the same with or without partitioning; partitioning just keeps that index small.

In a **distributed** system the story flips. If you shard or distribute by time (Cassandra partition key = `day`, a DynamoDB partition key = `date`, a Citus distribution column = `created_at`), "current" lives on one node and that node takes 100% of the write load while the rest idle. That is why distributed systems partition by an entity id and *cluster* by time within it — see [Ch 12 · Sharding](topic.html?p=12-sharding). On one node, time is usually the right partition key; across nodes, it is almost always the wrong shard key.

### DDL and the lock queue

Partition maintenance is DDL, and DDL takes locks on the parent that every query also needs. What each operation takes on the **parent** (PostgreSQL 14+):

| Operation | Lock on parent | Notes |
|---|---|---|
| `CREATE TABLE ... PARTITION OF` | ACCESS EXCLUSIVE | Brief, but queues behind long readers. Docs suggest create-then-attach for less locking. |
| `ALTER TABLE parent ATTACH PARTITION` | SHARE UPDATE EXCLUSIVE | Scans the new table to validate bounds unless a matching `CHECK` constraint already proves them; scans DEFAULT too. |
| `ALTER TABLE parent DETACH PARTITION` | ACCESS EXCLUSIVE | Blocks all reads/writes on the parent while queued. |
| `DETACH PARTITION ... CONCURRENTLY` | SHARE UPDATE EXCLUSIVE | PG 14+; two internal transactions; not in a transaction block; not allowed if a DEFAULT partition exists. |
| `DROP TABLE leaf` | ACCESS EXCLUSIVE on parent and leaf | Use detach concurrently first on busy parents. |

Every one of these should run with `SET lock_timeout = '2s'` and a retry loop. The ACCESS EXCLUSIVE request itself is not the outage — the outage is every `SELECT` that queues *behind* it while it waits for a 20-minute report to finish ([Ch 05 · Locking Internals](topic.html?p=05-locking-internals)).

## 5. Implementation

### Simple example: watching pruning succeed and fail

```sql
-- docker run --rm -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:17
CREATE TABLE events (
  id         bigint GENERATED ALWAYS AS IDENTITY,
  tenant_id  int         NOT NULL,
  created_at timestamptz NOT NULL,
  kind       text        NOT NULL,
  payload    jsonb,
  PRIMARY KEY (id, created_at)          -- must include the partition key
) PARTITION BY RANGE (created_at);

DO $$
DECLARE m date := date '2025-10-01';
BEGIN
  WHILE m < date '2027-02-01' LOOP
    EXECUTE format('CREATE TABLE events_%s PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
                   to_char(m, 'YYYY_MM'), m, m + interval '1 month');
    m := m + interval '1 month';
  END LOOP;
END $$;

CREATE INDEX ON events (created_at);
CREATE INDEX ON events (tenant_id, created_at);

INSERT INTO events (tenant_id, created_at, kind)
SELECT (random()*500)::int, timestamptz '2025-10-01' + random() * interval '360 days', 'click'
FROM generate_series(1, 2000000);
ANALYZE events;
```

Plan-time pruning with constants:

```sql
EXPLAIN (COSTS OFF)
SELECT count(*) FROM events
WHERE created_at >= '2026-07-10' AND created_at < '2026-07-11';
```

```text
 Aggregate
   ->  Index Only Scan using events_2026_07_created_at_idx on events_2026_07 events
         Index Cond: ((created_at >= '2026-07-10 00:00:00+00') AND (created_at < '2026-07-11 00:00:00+00'))
```

A function on the key kills it:

```sql
EXPLAIN (COSTS OFF)
SELECT count(*) FROM events WHERE created_at::date = '2026-07-10';
```

```text
 Aggregate
   ->  Append
         ->  Seq Scan on events_2025_10 events_1
               Filter: ((created_at)::date = '2026-07-10'::date)
         ->  Seq Scan on events_2025_11 events_2
         ...  (all 16 partitions)
```

A `STABLE` expression and a generic prepared plan both prune at executor start:

```sql
EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF)
SELECT count(*) FROM events WHERE created_at > now() - interval '7 days';

SET plan_cache_mode = force_generic_plan;
PREPARE day_count(timestamptz) AS
  SELECT count(*) FROM events WHERE created_at >= $1 AND created_at < $1 + interval '1 day';
EXPLAIN (COSTS OFF) EXECUTE day_count('2026-07-10');
```

```text
 Aggregate
   ->  Append
         Subplans Removed: 15
         ->  Index Only Scan using events_2026_07_created_at_idx on events_2026_07 events_1
               Index Cond: ((created_at >= $1) AND (created_at < ($1 + '1 day'::interval)))
```

`Subplans Removed: 15` is the proof. If you see every partition listed and no `Subplans Removed`, pruning did not happen.

> **Why this matters:** ORMs love to generate `WHERE DATE(created_at) = ?` or `created_at::date`. One such query in a hot path turns a one-partition index scan into a 36-partition scan. Grep your query log for functions around the key column before you partition, not after.

### Real-world example: pg_partman for a 13-month retention events table

Hand-written cron jobs that create next month's partition are the most common source of "inserts started failing at midnight" incidents. **pg_partman** (a widely used extension) owns premake and retention.

```sql
CREATE SCHEMA partman;
CREATE EXTENSION pg_partman SCHEMA partman;

-- pg_partman 5.x: parent must already be declared PARTITION BY RANGE
SELECT partman.create_parent(
  p_parent_table := 'public.events',
  p_control      := 'created_at',
  p_interval     := '1 month',
  p_premake      := 4                 -- keep 4 future partitions ready
);

UPDATE partman.part_config
   SET retention             = '13 months',
       retention_keep_table  = false,  -- true = detach only, keep the table for archiving
       infinite_time_partitions = true
 WHERE parent_table = 'public.events';
```

```ini
# postgresql.conf — run maintenance hourly from the background worker
shared_preload_libraries = 'pg_stat_statements,pg_partman_bgw'
pg_partman_bgw.interval  = 3600
pg_partman_bgw.role      = 'partman_owner'
pg_partman_bgw.dbname    = 'app'
```

Monitoring the belt:

```sql
-- How many future partitions exist? Alert if < 2.
SELECT count(*) AS future_partitions
FROM pg_partition_tree('events') t
JOIN pg_class c ON c.oid = t.relid
WHERE t.isleaf
  AND pg_get_expr(c.relpartbound, c.oid) LIKE 'FOR VALUES FROM%'
  AND substring(pg_get_expr(c.relpartbound, c.oid) FROM $$FROM \('([^']+)'$$)::timestamptz > now();

-- Rows that fell into the default partition (should be 0)
SELECT count(*) FROM events_default;

-- Size per partition, largest first
SELECT relid::regclass AS partition,
       pg_size_pretty(pg_total_relation_size(relid)) AS total
FROM pg_partition_tree('events') WHERE isleaf
ORDER BY pg_total_relation_size(relid) DESC LIMIT 5;
```

Retiring a partition without blocking inserts:

```sql
SET lock_timeout = '3s';
ALTER TABLE events DETACH PARTITION events_2025_08 CONCURRENTLY;
-- If this is interrupted, the partition is left "detach pending"; finish it with:
-- ALTER TABLE events DETACH PARTITION events_2025_08 FINALIZE;

-- archive, then drop (outside the hot path)
-- pg_dump -t events_2025_08 -Fc app > events_2025_08.dump  && upload to object storage
DROP TABLE events_2025_08;
```

Note the conflict: `DETACH ... CONCURRENTLY` is not allowed when the parent has a DEFAULT partition. Many teams therefore run with **no** default partition and rely on premake plus alerting; others keep a default and accept brief ACCESS EXCLUSIVE detaches with `lock_timeout` + retry.

### Adding an index to a large partitioned table online

`CREATE INDEX CONCURRENTLY` is not supported on the partitioned parent. The online recipe is to build per-partition and attach:

```sql
CREATE INDEX events_kind_idx ON ONLY events (kind, created_at);     -- parent index, INVALID, no children
CREATE INDEX CONCURRENTLY events_2026_09_kind_idx ON events_2026_09 (kind, created_at);
ALTER INDEX events_kind_idx ATTACH PARTITION events_2026_09_kind_idx;
-- ...repeat for every partition (script it); the parent index becomes VALID once all are attached
```

### Repartitioning a live table

**Case 1: converting an existing unpartitioned table.** Copying 3 TB is a multi-day job. The standard trick is to make the old table the *first partition* of a new parent, so only new data goes to new partitions:

```sql
-- The live, unpartitioned table is "events" (id bigint default nextval('events_id_seq')).
-- 0. Prerequisites, all online (no ACCESS EXCLUSIVE held for long):
CREATE UNIQUE INDEX CONCURRENTLY events_id_created_uq ON events (id, created_at);
ALTER TABLE events ADD CONSTRAINT legacy_bounds
  CHECK (created_at IS NOT NULL AND created_at < '2026-10-01') NOT VALID;
ALTER TABLE events VALIDATE CONSTRAINT legacy_bounds;   -- SHARE UPDATE EXCLUSIVE: scans, writes continue
ALTER TABLE events ALTER COLUMN created_at SET NOT NULL; -- PG 12+: proven by the validated CHECK, no scan

-- 1. The swap, in one short transaction (lock_timeout + retry loop around it):
BEGIN;
SET LOCAL lock_timeout = '2s';
ALTER TABLE events RENAME TO events_legacy;
CREATE TABLE events (LIKE events_legacy INCLUDING DEFAULTS)     -- keeps DEFAULT nextval('events_id_seq')
  PARTITION BY RANGE (created_at);
ALTER TABLE events ATTACH PARTITION events_legacy
  FOR VALUES FROM (MINVALUE) TO ('2026-10-01');                 -- CHECK proves the bounds: no scan
ALTER TABLE events ADD PRIMARY KEY (id, created_at);            -- adopts the matching unique index on the legacy leaf
CREATE TABLE events_2026_10 PARTITION OF events FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
COMMIT;
-- 2. The old PK on events_legacy (id) can be dropped later. Once the legacy partition is
--    entirely past retention, drop it; or split it in batches off-peak.
```

Identity columns, foreign keys pointing *at* the old table, and views that reference it by OID all need checking — rehearse on a restored copy first; [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution) covers the general zero-downtime playbook.

**Case 2: changing the scheme** (monthly → daily, or time → tenant). Range partitions do not need equal widths, so a granularity change can simply apply *going forward*: stop premaking months and start premaking days. Changing the *key* is a real migration: create the new partitioned table, dual-write (trigger or application) or stream changes via logical replication, backfill history in chunks, verify counts per range, then swap names in one short `lock_timeout`-guarded transaction. Released PostgreSQL through 17 has no online `SPLIT PARTITION`; splitting one partition means detach → create new partitions → `INSERT ... SELECT` in batches → drop the old one.

### Global uniqueness when the key is not in it

A unique constraint on a partitioned table must include every partition-key column, because each leaf enforces uniqueness only within itself. When the business rule is "email is unique across all users" and the table is partitioned by `created_at`, you have three options: (a) don't partition that table (reference tables rarely need it); (b) keep a small, unpartitioned **uniqueness side table** `user_emails(email PRIMARY KEY, user_id)` written in the same transaction; (c) generate globally unique ids (identity/UUIDv7) and accept that the *business* uniqueness must be enforced by the side table anyway.

> **MySQL difference:** MySQL partitioning (InnoDB) requires the partitioning columns to be part of **every** unique key including the PK, and partitioned InnoDB tables **cannot have foreign keys** at all (neither referencing nor referenced). Maintenance uses `ALTER TABLE ... ADD/DROP/REORGANIZE PARTITION` and `EXCHANGE PARTITION` (swap a partition with a standalone table — MySQL's analogue of attach/detach). Pruning works on the raw column and on a few recognised functions such as `TO_DAYS()`, `YEAR()` and `TO_SECONDS()` when they are used in the partitioning expression; check with `EXPLAIN` (the `partitions` column).

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Option A | Option B | Choose A when |
|---|---|---|---|
| Partition at all? | Partition | One big table + good indexes | Retention/archival by a key, or vacuum/maintenance on one heap is unmanageable |
| Scheme | RANGE by time | HASH/LIST by tenant/entity | Queries and retention are time-windowed |
| Granularity | Monthly | Daily | Each month is a comfortable size (tens to low hundreds of GB) and retention is in months |
| Default partition | None + premake alerting | DEFAULT partition | You want `DETACH ... CONCURRENTLY` and prefer loud failures |
| Uniqueness | PK includes key | Side table for global uniqueness | No global business-unique column outside the key |
| Old data | DROP | DETACH + archive | Data has no legal/analytics value after retention |

**Advantages**
- Retention is `DROP`/`DETACH`: no dead tuples, no WAL storm, no vacuum debt.
- Vacuum, analyze, reindex and `pg_repack` operate on bounded pieces; cold partitions freeze once and are skipped.
- Pruning keeps hot queries on a small, cache-resident slice.
- Per-partition storage choices: move cold partitions to cheaper tablespaces, drop rarely-used indexes on old partitions.

**Disadvantages**
- Queries without the key fan out to every partition.
- PK/unique constraints must include the key; no global unique index.
- More relations: planning time, relcache memory per backend, and lock-table slots grow with partition count.
- Maintenance automation becomes critical infrastructure — if it stops, writes eventually fail.

### When to use
- Time-series, events, logs, audit trails, metrics — anything with time-based retention.
- Multi-tenant tables where tenant offboarding or tenant-scoped maintenance matters (LIST/HASH by tenant, with care for skew).
- Tables whose single-heap vacuum or index rebuild no longer fits a maintenance window.

### When NOT to use
- To "make a slow query fast" when the query does not filter on the key — fix the index instead ([SQL Handbook · Index Design](../sql/topic.html?p=20-index-design)).
- Tables under roughly a hundred GB with no retention need: the complexity costs more than it saves.
- Tables whose defining constraint is global uniqueness on a non-key column (users by email).
- As a substitute for sharding when you are CPU- or write-bound on one node: partitions share the same machine.

## 7. Common Mistakes & Best Practices

- **Partitioning by the column you *think* matters.** People pick `created_at` because the table is time-series, but the hottest query is `WHERE order_id = $1`. It now probes every partition. *Instead:* rank queries in `pg_stat_statements` by total time and confirm the key appears in the top ones.
- **Functions around the key.** `DATE(created_at)`, `created_at::date`, `extract(month from ...)`. Pruning silently disappears. *Instead:* half-open ranges on the raw column; add a CI check on generated SQL for hot tables.
- **Too many partitions.** Daily partitions for ten years = 3,650 leaves, each with 4 indexes = ~18,000 relations. Queries that cannot prune take thousands of locks; `max_locks_per_transaction` (default 64, shared across `max_connections`) runs out with `out of shared memory` errors, and in PG ≤ 17 only 16 locks per backend use the fast-path. *Instead:* keep counts in the hundreds; use coarser ranges for older data.
- **Cron that creates next month's partition on the 1st.** A single missed run means failed inserts. *Instead:* premake several intervals ahead and alert on "future partitions remaining".
- **DEFAULT partition as a dumping ground.** Rows land there silently, then creating the proper partition fails because DEFAULT contains matching rows. *Instead:* alert when DEFAULT is non-empty and move rows out promptly — or run without DEFAULT.
- **Retention with `DELETE` on a partitioned table.** It works, and it throws away the main benefit. *Instead:* align retention with partition boundaries so it is always `DROP`/`DETACH`.
- **Forgetting parent-level `ANALYZE`.** Autovacuum does not analyze partitioned parents. *Instead:* schedule `ANALYZE events` (the parent) after large loads or nightly.
- **Plain `DETACH` / `DROP` at peak.** ACCESS EXCLUSIVE on the parent queues behind long queries and blocks writers. *Instead:* `DETACH ... CONCURRENTLY` or `lock_timeout` with retries, off-peak.
- **Best practice:** treat the partition scheme as a contract: key in every hot query, retention aligned to boundaries, premake + retention automated and monitored, partition count bounded.

## 8. Production: Failure Scenarios, Monitoring & Scaling

**Failure scenario: midnight insert failures.** At 00:00 UTC on the 1st, the ingestion service starts returning 500s: `ERROR: no partition of relation "events" found for row`. Root cause: the partman background worker was not in `shared_preload_libraries` after a config rollback three months ago; the four premade partitions were consumed one per month until none were left. Fix: create the partition manually (`CREATE TABLE ... PARTITION OF`), restore the worker, and add an alert that fires when fewer than two future partitions exist — it would have fired two months earlier.

**Failure scenario: first-hours-of-the-month slowness.** Dashboards time out every month between 00:00 and ~03:00. `EXPLAIN ANALYZE` shows a nested loop over `events_2026_10` estimated at 1 row, actual 4 million. Root cause: the new partition's statistics are from when it was empty. Fix: lower `autovacuum_analyze_scale_factor` on the hot partitions (`ALTER TABLE events_2026_10 SET (autovacuum_analyze_scale_factor = 0.01)`, set by the premake job), and run an explicit `ANALYZE` on the new partition an hour after rollover.

**Failure scenario: `out of shared memory` on reporting queries.** An analyst runs a query without a date filter against a table with 2,000 partitions × 5 indexes. Error: `out of shared memory — You might need to increase max_locks_per_transaction`. Root cause: the query locks every partition and index in one transaction; the shared lock table is sized by `max_locks_per_transaction × (max_connections + max_prepared_transactions)`. Fix: short-term raise `max_locks_per_transaction` (restart required); long-term, reduce partition count and force a time bound in the reporting layer.

**Failure scenario: the retention job took the site down.** A nightly `DROP TABLE events_2025_08` waited on a long-running export holding ACCESS SHARE on the parent; while it waited, every insert queued behind its ACCESS EXCLUSIVE request. Fix: `lock_timeout`, `DETACH ... CONCURRENTLY`, and move exports to a replica.

**Metrics to watch**
- Future partitions remaining (per partitioned table); rows in DEFAULT partitions.
- Partition count and total relation count (`SELECT count(*) FROM pg_class`).
- Planning time for hot queries (`pg_stat_statements.track_planning = on` adds `total_plan_time`; overhead is small but non-zero).
- `n_dead_tup`, `last_autovacuum`, `last_autoanalyze` for the current and previous partitions (`pg_stat_user_tables`).
- Lock waits on the parent during maintenance windows (`pg_stat_activity.wait_event_type = 'Lock'`).

**Scaling notes.** Partitioning is a single-node technique: it does not add CPU, memory or WAL bandwidth. When the current partition's write rate or the working set exceeds one machine, the next step is distributing the partitions — by an entity key, not by time — across nodes ([Ch 12 · Sharding](topic.html?p=12-sharding), [Ch 21 · Database Scaling](topic.html?p=21-database-scaling)). Many systems combine both: Citus distributes by `tenant_id` and each shard is itself time-partitioned locally; Cassandra partitions by `(sensor_id, day)` and clusters by timestamp.

## 9. Interview Questions

**Q: Why is partitioning not a general performance optimisation?**
A: Because the benefit only applies to queries that can be confined to a few partitions. A query filtering on the partition key prunes and touches a small heap and short indexes, but a query without the key fans out to every partition, probing N indexes instead of one, with extra planning and locking overhead. The B-tree depth saving is small because depth grows logarithmically. The dependable wins are operational: `DROP` instead of `DELETE` for retention, vacuum on bounded pieces, and freezing cold data once. So you partition for lifecycle and maintenance, and treat query speed-ups as a bonus that depends entirely on the key appearing in hot predicates.

**Q: What is the difference between plan-time and execution-time partition pruning?**
A: Plan-time pruning happens when the WHERE clause compares the raw key to constants: the planner removes partitions before building the plan, and they never appear in `EXPLAIN`. Execution-time pruning handles values known only at run time — parameters in a generic prepared plan, `STABLE` expressions like `now()`, and join keys in a parameterised nested loop. The plan includes all partitions, and the executor removes them at startup (`Subplans Removed: N`) or skips them per rescan (`never executed`). Both need the bare key column compared with a pruneable operator; they differ only in when the comparison value becomes known.

**Q: List ways partition pruning silently fails.**
A: Wrapping the key in a function or cast (`created_at::date`, `date_trunc`), omitting the key from the WHERE clause, combining the key predicate with a non-key column via `OR`, reaching the key only through a hash or merge join rather than a parameterised nested loop, and using range predicates on a HASH-partitioned table (hash pruning needs equality). Pruning is also disabled if `enable_partition_pruning` is off. The diagnostic is always `EXPLAIN`: if every partition is listed and there is no `Subplans Removed`, pruning did not happen. The fix is nearly always to rewrite the predicate as a half-open range on the raw column.

**Q: How do you choose a partition key?**
A: From access patterns and data lifecycle, not table size. I pull the top queries by total time from `pg_stat_statements` and check which column appears in their WHERE clauses, then ask how data dies — by age (RANGE on time) or by owner (LIST/HASH on tenant). I check the uniqueness consequences, because the primary key must include the partition key. Finally I size partitions so the count stays in the hundreds and each is comfortably maintainable. If the hot queries and the retention rule disagree, retention usually wins for event data, and I add indexes for the other queries or push them to a replica or warehouse.

**Q: Why must a primary key on a partitioned table include the partition key?**
A: PostgreSQL has no global index; every unique index is really a set of per-partition indexes. Each leaf can enforce uniqueness only within itself. If the constraint includes the partition key, two rows with equal constrained values must land in the same partition, so per-leaf enforcement is equivalent to global enforcement. Without the key, two partitions could each hold the same value with neither noticing. For global business uniqueness on another column you need a separate unpartitioned table (or not partition that table).

**Q: How do you drop old data from a busy partitioned table without blocking writes?**
A: Use `ALTER TABLE ... DETACH PARTITION ... CONCURRENTLY` (PG 14+), which takes only SHARE UPDATE EXCLUSIVE on the parent, then drop or archive the detached table at leisure. It cannot run inside a transaction block and is not allowed if the table has a DEFAULT partition. If you must use plain detach or drop, set `lock_timeout` to a couple of seconds and retry, because the danger is not the drop itself but the ACCESS EXCLUSIVE request queuing behind a long query and blocking every writer behind it. Never implement retention as `DELETE` on a partitioned table.

**Q: Why is a hot "current" partition a problem on one node but a disaster in a distributed database?**
A: On one PostgreSQL node, all partitions share disk, WAL and memory, so routing all inserts to the current partition costs no more than an unpartitioned table; the problems are stale statistics on the new partition and vacuum on the busy one. In a distributed database, partitions live on different nodes, so a time-based key puts 100% of writes on whichever node owns "now" while the rest idle. That is why distributed systems use an entity id as the partition or shard key and cluster by time within it.

**Q: What goes wrong with a DEFAULT partition?**
A: It hides routing mistakes: rows for months with no partition land there silently. When you later create the proper partition, PostgreSQL must verify that DEFAULT holds no rows belonging to the new range; if it does, the create fails, and even when empty it adds a scan of DEFAULT to every create/attach. A DEFAULT partition also prevents `DETACH ... CONCURRENTLY`. If you keep one, alert when it is non-empty; many teams prefer no DEFAULT and premake with monitoring so failures are loud.

**Q: How would you convert a 3 TB unpartitioned table to a partitioned one without downtime? (Senior)**
A: I avoid copying history. First, online prerequisites on the old table: build the unique index `(id, created_at)` concurrently, add a `CHECK (created_at IS NOT NULL AND created_at < cutoff) NOT VALID` and validate it, then `SET NOT NULL`, which PG 12+ can prove from the validated check. Then, in one short transaction guarded by `lock_timeout` and retries, I rename, create the new partitioned parent, attach the old table as the first partition `FROM (MINVALUE) TO (cutoff)` — the check constraint means no validation scan — and create the first new partitions. New data flows into proper partitions immediately; the legacy partition ages out under retention or gets split in batches later. I rehearse on a restored snapshot, especially identity/sequence ownership and application-visible names.

**Q: A report query with no time filter now fails with "out of shared memory". Explain and fix. (Senior)**
A: The table has thousands of partitions, each with several indexes, and a query that cannot prune must lock every partition and index for the transaction. Those locks go in the shared lock table, sized by `max_locks_per_transaction × (max_connections + max_prepared_transactions)`, and the query exhausts it. Short term, raise `max_locks_per_transaction` (requires a restart) or run the report on a replica with a larger setting. Long term, the design is wrong: reduce partition count with coarser ranges for old data, require a time bound in the reporting layer, and move full-history analytics to a warehouse. Planning time for such queries is also high, which shows in `total_plan_time`.

**Q: When would you partition by tenant instead of time, and what are the risks? (Senior)**
A: When the dominant access pattern is tenant-scoped and lifecycle is per tenant — offboarding a customer, per-tenant restores or moving a tenant elsewhere — LIST partitioning for large tenants plus HASH for the long tail makes those operations detach-and-go. The risks are skew (one tenant holding 40% of rows makes its partition the hot and oversized one), partition count growing with tenant count if you use one partition per tenant, and time-based retention turning back into `DELETE`. A common hybrid is HASH by tenant into a fixed number of partitions, with the biggest tenants in dedicated LIST partitions, or sub-partitioning by time only where retention demands it.

**Q: Prepared statements on a partitioned table got slower after upgrading traffic. What do you check? (Senior)**
A: After five executions PostgreSQL may switch a prepared statement to a generic plan. With parameters on the key, a generic plan contains all partitions and relies on executor-startup pruning. That still works (`Subplans Removed`), but depending on version the executor may lock and initialise more partitions than a custom plan would, so per-execution overhead grows with partition count. I compare `EXPLAIN EXECUTE` under `plan_cache_mode = force_custom_plan` vs `force_generic_plan`, check `pg_stat_statements` plan vs exec time, and either set `plan_cache_mode = force_custom_plan` for that workload, reduce partition count, or make the time bound a literal where the driver allows. This is also a common source of pooler-related surprises when statements are prepared per connection.

## 10. Quick Revision & Cheat Sheet

| Topic | Remember |
|---|---|
| Why partition | Lifecycle (DROP), maintenance locality, pruning on key-filtered queries |
| Not a fix for | Queries without the key, global uniqueness, CPU/write limits of one node |
| Plan-time pruning | Constants vs bounds; pruned leaves absent from `EXPLAIN` |
| Init-time pruning | `$1` in generic plans, `now()`; `Subplans Removed: N` |
| Per-rescan pruning | Parameterised nested loop; `(never executed)` |
| Kills pruning | Functions/casts on key, key missing, OR with non-key, hash join, range on HASH |
| PK rule | Must include partition key; global uniqueness needs a side table |
| Premake | Create partitions ahead; alert on remaining future partitions |
| Retire | `DETACH ... CONCURRENTLY` (no DEFAULT allowed), then DROP/archive |
| Partition count | Hundreds, not thousands (locks, planning, relcache) |
| Parent stats | Autovacuum skips the parent; schedule `ANALYZE parent` |

- Rank hot queries first; the key must appear, raw, in their WHERE clauses.
- Transform the constant, never the key column.
- On one node, time is usually the right partition key; across nodes, it is usually the wrong shard key.
- Retention aligned to partition boundaries turns deletion into DDL.
- DEFAULT partitions hide mistakes and block concurrent detach.
- Every partition DDL gets `lock_timeout` + retry.
- Convert big tables by attaching the old table as the first partition, not by copying.

## 11. Hands-On Exercises

Lab: `docker run --rm -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:17`, then `psql -h localhost -U postgres`.

1. **Pruning forensics.** Build the `events` table from §5. Run six variants of a one-day query: literal range, `::date` cast, `date_trunc`, `now() - interval`, a generic prepared plan, and `OR kind = 'x'`. For each, record whether pruning happened and at which stage (partition list vs `Subplans Removed`).
2. **Join pruning.** Create a `days(day date)` table with three rows. Join it to `events` on a range and compare plans with `SET enable_hashjoin = off; SET enable_mergejoin = off;` vs defaults. Find `(never executed)` partitions.
3. **DELETE vs DROP.** Load a month with 2M rows. Time `DELETE FROM events WHERE created_at < '2025-11-01'` and measure WAL generated (`pg_current_wal_lsn()` before/after with `pg_wal_lsn_diff`) and `n_dead_tup`. Repeat with `DROP TABLE` on the equivalent partition.
4. **Lock queue.** In session A: `BEGIN; SELECT count(*) FROM events;` (keep open). In B: `ALTER TABLE events DETACH PARTITION events_2025_10;`. In C: `INSERT` a row. Observe C blocked via `pg_blocking_pids()`. Repeat B with `DETACH ... CONCURRENTLY` (drop any DEFAULT partition first) and with `SET lock_timeout='2s'`.
5. **DEFAULT trap.** Add a DEFAULT partition, insert a row dated 2027-06-15, then try to create `events_2027_06`. Read the error; fix it by moving the row.
6. **Attach-as-first-partition.** Create an unpartitioned 5M-row `legacy` table, then convert it using the §5 recipe. Verify with `\d+` that no rewrite happened and time the attach.

**Mini project — "Retention on rails".** Build a time-partitioned `audit_log` with pg_partman (13-month retention, premake 4), a DEFAULT-free design, per-partition autovacuum settings applied to new partitions, and a monitoring SQL file that outputs: future partitions remaining, oldest partition age vs retention, rows in any DEFAULT, top-5 partitions by size, and hot-partition `last_autoanalyze`. Simulate 18 months by inserting backdated data and running maintenance, and show that retention runs as DROP with zero dead tuples.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 12 · Sharding](topic.html?p=12-sharding) (partitioning across machines) · [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) (where partitioning sits on the ladder) · [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle) (hot/warm/cold and deletion) · [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution) (online DDL) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (lock queues) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (why DELETE is expensive).

**SQL Handbook:** [Partitioning & Sharding](../sql/topic.html?p=23-partitioning) · [Execution Plans](../sql/topic.html?p=22-execution-plans) · [Index Design](../sql/topic.html?p=20-index-design) · [Query Optimization](../sql/topic.html?p=21-query-optimization).

**Other handbooks:** [Cassandra · Primary Key, Partition & Clustering](../cassandra/topic.html?p=06-primary-key-partition-clustering) (partitioning in a distributed store) · [System Design · Database Scaling](../system-design/topic.html?p=16-database-scaling).

- **Table Partitioning** — PostgreSQL Documentation · *Intermediate* · the authoritative reference for pruning, attach/detach, limitations and best practices. <https://www.postgresql.org/docs/current/ddl-partitioning.html>
- **ALTER TABLE (ATTACH/DETACH PARTITION)** — PostgreSQL Documentation · *Advanced* · exact lock levels and the CONCURRENTLY/FINALIZE rules. <https://www.postgresql.org/docs/current/sql-altertable.html>
- **pg_partman** — pgpartman project on GitHub · *Intermediate* · premake, retention and background-worker configuration. <https://github.com/pgpartman/pg_partman>
- **Partitioning** — MySQL Reference Manual · *Intermediate* · MySQL's rules on unique keys, pruning functions and partition management. <https://dev.mysql.com/doc/refman/8.0/en/partitioning.html>
- **Explicit Locking** — PostgreSQL Documentation · *Intermediate* · the lock-conflict table you need to plan partition DDL. <https://www.postgresql.org/docs/current/explicit-locking.html>
- **Use The Index, Luke** — Markus Winand · *Intermediate* · why functions on columns defeat indexes (and pruning) and how to write sargable predicates. <https://use-the-index-luke.com/>

---

*Database Design Handbook — chapter 11.*
