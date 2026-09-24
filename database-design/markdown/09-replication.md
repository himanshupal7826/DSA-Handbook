# 09 · Database Replication: Leaders, Followers & Lag

> **In one line:** Replication keeps copies of your data on other machines by shipping the primary's change log, and every design decision in it — physical or logical, synchronous or asynchronous, which replica to promote, what to read from where — is a trade between write latency, durability on failover, read freshness and operational risk, not a feature to switch on.

---

## 1. Overview

> **Builds on:** [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (the WAL stream that replication ships) · [Ch 08 · Crash Recovery](topic.html?p=08-crash-recovery) (a physical replica is a database in never-ending recovery). The SQL Handbook does not cover replication; this chapter assumes only the WAL and recovery chapters and goes from mechanism to production operation.

A single database server has three problems that grow with your business. It is a **single point of failure**: if the machine or its disk dies, you are down until you restore a backup, and you lose everything since that backup. It has a **read ceiling**: one machine's CPU and I/O serve every query. And it is **in one place**: users on another continent pay a round trip across the world for every read. Replication — keeping continuously updated copies of the database on other machines — addresses all three.

The naive approaches fail instructively. **Having the application write to two databases** is a dual write: a crash between the two writes leaves them different forever, concurrent writes can apply in different orders on each, and there is no transaction spanning both. **Periodic dumps** copied to a second server give you a copy that is hours old and cannot take over without losing hours of data. What works is to use the thing the database already produces for crash safety — the ordered, durable log of every change — and **ship that log** to other servers that apply it in the same order. The primary decides the order once; the replicas replay it. That is **leader-follower** (primary-replica) replication, and it is how PostgreSQL, MySQL, MongoDB replica sets, Redis and Kafka partitions all fundamentally work.

The hard part is not making a copy. It is deciding **what "committed" means** when there is more than one copy (acknowledged by the primary only, or also by a replica?), **what readers see** when they read a copy that is behind, **who becomes the primary** when the primary dies and how you make sure the old one stops accepting writes, and **what the replication machinery can do to the primary** when something downstream breaks — like a forgotten replication slot quietly filling the primary's disk. Each of these is a trade-off, and this chapter frames them that way.

> **Why this matters:** Most "database outages" at mid-size companies are not the database crashing. They are replication incidents: failover losing acknowledged writes, a replica serving stale data to a user who just paid, an abandoned slot filling a disk, or two primaries accepting writes after a network blip. All are design decisions made (or not made) long before the incident.

## 2. Core Concepts

- **Primary / leader** — the single node that accepts writes and decides their order. *Why it matters:* one writer means no write conflicts; it also means the writer is the bottleneck and the failure point.
- **Replica / standby / follower** — a node that applies the primary's changes. *Why it matters:* it can serve reads (hot standby) and be promoted.
- **Physical (streaming) replication** — shipping WAL bytes; the replica replays them onto an identical copy of the whole cluster. *Why it matters:* exact copy, simple, fast; but all-or-nothing, same major version and architecture.
- **Logical replication** — decoding WAL into row changes (insert/update/delete per table) and applying them as SQL-level operations. *Why it matters:* selective tables, cross-version, can feed other systems; but DDL and sequences are not replicated and conflicts are possible.
- **Asynchronous replication** — the primary commits without waiting for replicas. *Why it matters:* no latency cost; a failover can lose recent acknowledged commits.
- **Synchronous replication** — commit waits for one or more replicas to confirm. *Why it matters:* no loss on failover to a confirmed replica; commit latency includes a network round trip, and a missing replica can stall writes.
- **Quorum commit** — commit waits for any *k* of *n* replicas (`ANY k (...)`). *Why it matters:* durability across failures without depending on one specific replica.
- **Replication lag** — how far a replica is behind, in bytes of WAL or in time. *Why it matters:* it is the staleness of every read you send to that replica, and the data loss window of async failover.
- **Replication slot** — a primary-side record of how far a consumer has confirmed, which prevents the primary from removing WAL the consumer still needs. *Why it matters:* it prevents replicas from falling off the end of the WAL — and can fill the primary's disk if the consumer disappears.
- **Failover / promotion** — turning a replica into the new primary. *Why it matters:* it is when durability promises are cashed in, and when split brain happens.
- **Split brain** — two nodes both believe they are primary and accept writes. *Why it matters:* divergent histories that cannot be merged automatically.
- **Fencing** — making sure the old primary cannot accept writes (kill it, cut its network, revoke its storage, or make it lose its leader lease). *Why it matters:* it is the only reliable defence against split brain.
- **Timeline (PostgreSQL)** — a history branch number incremented at each promotion. *Why it matters:* it lets replicas and backups tell which history they belong to, and lets `pg_rewind` find the divergence point.

## 3. Theory & Principles

### Physical streaming replication: shipping the WAL

In PostgreSQL physical replication, a **walreceiver** process on the replica connects to the primary, where a **walsender** process streams WAL records as they are written. The replica writes them to its own `pg_wal`, flushes them, and its **startup process** replays them — exactly the same redo loop as crash recovery in [Ch 08](topic.html?p=08-crash-recovery), except it never ends. The result is a byte-for-byte identical copy of the entire cluster: every database, every table, every index, even the bloat.

Because the replica applies physical page changes, it must run the **same major version** on the same architecture, and it replicates **everything** — you cannot choose tables. With `hot_standby = on` (the default) it accepts read-only queries while replaying.

Hot standby creates a unique conflict: replay may need to remove row versions (because vacuum on the primary removed them) that a long-running query on the replica still needs. PostgreSQL resolves this by delaying replay up to `max_standby_streaming_delay` (default 30 s) and then **cancelling the query** with `canceling statement due to conflict with recovery`. Alternatively, `hot_standby_feedback = on` makes the replica tell the primary about its oldest snapshot, so the primary's vacuum holds back — trading replica query cancellations for **bloat on the primary**. There is no free option; long analytic queries on a streaming replica always cost something.

### Logical replication: shipping row changes

Logical replication (PostgreSQL 10+) runs **logical decoding** on the primary: a walsender reads WAL and, through an output plugin (`pgoutput` for built-in replication, `wal2json` or Debezium's plugins for CDC), turns it into a stream of committed row changes per table, in commit order. The subscriber applies them as ordinary inserts, updates and deletes. You define a **publication** (which tables, which operations, optionally row filters and column lists in PG 15+) on the source and a **subscription** on the target.

This buys flexibility — replicate a subset of tables, into a different major version (the classic near-zero-downtime upgrade path), into a database with extra indexes or tables — at the cost of things physical replication gets for free. **DDL is not replicated**: schema changes must be applied on both sides in the right order. **Sequences are not replicated** (as of PG 17), so after a cutover you must advance them. `UPDATE` and `DELETE` need a **replica identity** (normally the primary key) to find the target row. The subscriber is a writable database, so local writes can **conflict** with incoming changes (a duplicate key stops the apply worker until you resolve it). And the apply is row-by-row SQL, so a single statement updating 10 million rows on the source becomes 10 million row changes on the subscriber.

> **MySQL difference:** MySQL replication is logical at heart. The source writes the **binary log** (row-based format by default), a replica's I/O (receiver) thread copies it into a relay log, and applier (SQL) threads execute the changes — in parallel with `replica_parallel_workers` (multi-threaded by default in 8.0.27+). **GTIDs** give every transaction a global ID so a replica can auto-position after failover without file/offset arithmetic. Because it is logical, cross-version replication is routine, and "physical" copies come from tools like XtraBackup or the Clone plugin.

### Asynchronous, synchronous and quorum commit

The central durability decision is **what a COMMIT waits for**:

- **Asynchronous (the default).** The primary flushes its own WAL and replies; replicas catch up whenever. Commit latency is unaffected. If the primary dies, the WAL it had not yet sent is lost with it — typically well under a second of commits on a healthy network, but potentially much more if the replica was lagging. Failover to an async replica **can lose acknowledged transactions**.
- **Synchronous.** With `synchronous_standby_names` set, the committing backend waits (after its local flush) until the required standby confirms. `synchronous_commit` chooses how far: `remote_write` (standby received it into OS memory), `on` (standby flushed it to disk), `remote_apply` (standby replayed it, so reads there see it). Commit latency now includes a round trip — sub-millisecond within an AZ, ~1–2 ms across AZs in one region, tens of ms across regions.
- **Quorum.** `FIRST 1 (s1, s2)` waits for the highest-priority available standby; `ANY 2 (s1, s2, s3)` waits for any two of three. Quorum lets you tolerate the loss or slowness of one specific standby without stalling writes, while still guaranteeing the commit exists on *k* other machines.

The availability trap of synchronous replication: if the required number of synchronous standbys is not reachable, **commits on the primary wait indefinitely** — the application sees writes hang, not fail. So you always run synchronous replication with **more standbys than the quorum requires** (e.g. `ANY 1` of two), and with automation that can relax the requirement consciously.

```svg
<svg viewBox="0 0 880 450" width="100%" height="450" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c09a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c09a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="c09a3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Streaming replication: where the commit waits, and where lag accumulates</text>
  <rect x="20" y="40" width="260" height="210" rx="10" fill="#dbeafe" stroke="#2563eb"/>
  <text x="150" y="60" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Primary</text>
  <rect x="40" y="72" width="220" height="30" rx="5" fill="#fff" stroke="#94a3b8"/>
  <text x="150" y="91" text-anchor="middle" fill="#334155">1. backend: commit record, local fsync</text>
  <rect x="40" y="110" width="220" height="30" rx="5" fill="#fff" stroke="#94a3b8"/>
  <text x="150" y="129" text-anchor="middle" fill="#334155">2. walsender streams WAL</text>
  <rect x="40" y="148" width="220" height="44" rx="5" fill="#fef3c7" stroke="#d97706"/>
  <text x="150" y="166" text-anchor="middle" fill="#1e293b" font-weight="bold">3. sync only: wait for ack</text>
  <text x="150" y="182" text-anchor="middle" fill="#334155" font-size="10">at remote_write / on / remote_apply</text>
  <rect x="40" y="200" width="220" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="150" y="219" text-anchor="middle" fill="#14532d">4. reply COMMIT to client</text>
  <rect x="600" y="40" width="260" height="210" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="730" y="60" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Standby</text>
  <rect x="620" y="72" width="220" height="30" rx="5" fill="#fff" stroke="#94a3b8"/>
  <text x="730" y="91" text-anchor="middle" fill="#334155">walreceiver: write (OS cache)</text>
  <rect x="620" y="110" width="220" height="30" rx="5" fill="#fff" stroke="#94a3b8"/>
  <text x="730" y="129" text-anchor="middle" fill="#334155">flush to standby pg_wal</text>
  <rect x="620" y="148" width="220" height="30" rx="5" fill="#fff" stroke="#94a3b8"/>
  <text x="730" y="167" text-anchor="middle" fill="#334155">startup process: replay</text>
  <rect x="620" y="186" width="220" height="44" rx="5" fill="#fff" stroke="#94a3b8"/>
  <text x="730" y="204" text-anchor="middle" fill="#334155">hot standby read queries</text>
  <text x="730" y="220" text-anchor="middle" fill="#334155" font-size="10">see data up to replay_lsn</text>
  <path d="M260,125 L616,87" stroke="#2563eb" stroke-width="2" marker-end="url(#c09a1)"/>
  <text x="440" y="96" text-anchor="middle" fill="#1e40af" font-size="10">WAL stream (TCP)</text>
  <path d="M616,125 L264,165" stroke="#d97706" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#c09a3)"/>
  <text x="440" y="138" text-anchor="middle" fill="#92400e" font-size="10">feedback: write / flush / replay LSN</text>
  <rect x="20" y="266" width="840" height="172" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="36" y="286" fill="#1e293b" font-size="12" font-weight="bold">Lag decomposed (pg_stat_replication on the primary)</text>
  <rect x="40" y="300" width="160" height="26" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="120" y="317" text-anchor="middle" fill="#334155">sent_lsn</text>
  <rect x="210" y="300" width="160" height="26" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="290" y="317" text-anchor="middle" fill="#334155">write_lsn (write_lag)</text>
  <rect x="380" y="300" width="160" height="26" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="460" y="317" text-anchor="middle" fill="#334155">flush_lsn (flush_lag)</text>
  <rect x="550" y="300" width="160" height="26" rx="4" fill="#ede9fe" stroke="#7c3aed"/><text x="630" y="317" text-anchor="middle" fill="#334155">replay_lsn (replay_lag)</text>
  <text x="40" y="350" fill="#334155" font-size="10">current WAL position minus sent_lsn: primary-side backlog (walsender or network slow)</text>
  <text x="40" y="368" fill="#334155" font-size="10">sent minus flush: network bandwidth / standby disk. flush minus replay: single-threaded replay or replay paused by query conflicts.</text>
  <text x="40" y="386" fill="#334155" font-size="10">Async failover loses what the standby had not FLUSHED. Stale reads come from what it had not REPLAYED.</text>
  <text x="40" y="410" fill="#1e293b" font-size="10" font-weight="bold">remote_write: survives primary loss, not simultaneous OS crash of both.  on: survives both.  remote_apply: also read-your-writes on that standby.</text>
  <text x="40" y="428" fill="#334155" font-size="10">Each level adds latency to every commit; the stronger the promise, the later the reply.</text>
</svg>
```

### Why lag happens

Replication lag is not a single number with a single cause. It decomposes along the pipeline:

- **Sending lag** — the primary is generating WAL faster than the walsender or the network can ship it: a bulk `UPDATE`, an index build, a big `COPY`. WAL bandwidth, not query rate, is what replication must keep up with (see WAL volume drivers in [Ch 07](topic.html?p=07-write-ahead-logging)).
- **Flush lag** — the standby's disk is slower than the primary's, or shared with heavy read I/O.
- **Replay lag** — replay is essentially **single-threaded** in PostgreSQL. A primary with 64 cores writing in parallel can produce WAL faster than one process can apply it, especially when replay must read pages from disk. Replay also **pauses** for query conflicts up to `max_standby_streaming_delay`.
- **Logical apply lag** — logical subscribers apply row by row; large transactions are by default only sent at commit (PG 14+ can stream in-progress large transactions, and PG 16+ can apply them in parallel with `streaming = parallel`).
- **Long transactions on the primary** (for logical) — decoding outputs changes in commit order, so a transaction that runs for an hour delivers its changes only when it commits.

### Replication slots: guaranteed retention, guaranteed risk

Without a slot, the primary deletes old WAL after checkpoints; a replica that falls far enough behind (or is offline too long) finds its needed WAL gone and must be rebuilt from a fresh base backup. A **replication slot** fixes that: the primary keeps every WAL segment the slot's consumer has not confirmed. Logical replication and CDC tools (Debezium) *require* slots.

The flip side: a slot whose consumer is gone — a decommissioned replica, a paused Debezium connector, a test subscription someone forgot — **retains WAL forever**. The primary's `pg_wal` grows until the disk is full and the primary stops. A logical slot also holds back the catalog xmin, which blocks vacuum of system catalogs. Since PostgreSQL 13, `max_slot_wal_keep_size` caps retention: beyond it, the slot is invalidated (`wal_status = 'lost'`) and the consumer must be rebuilt — you trade the consumer for the primary's survival, which is almost always the right trade.

## 4. Architecture & Workflow

### Read replicas and the read-your-writes trap

The most common reason to add replicas is read scaling: route `SELECT`s to replicas, writes to the primary. It works well for data that tolerates staleness (catalog pages, feeds, analytics) and fails for the classic flow: a user updates their profile (write to primary), the page reloads (read from a replica 300 ms behind), and the old profile appears. Users experience this as "my save didn't work" and click again. The routing strategies — pinning a user's reads to the primary for a few seconds after a write, waiting for the replica to reach the write's LSN, `remote_apply` — are consistency-model decisions covered in depth in [Ch 10 · Consistency Models](topic.html?p=10-consistency-models). The replication-level facts you need: lag is usually milliseconds but has a long tail (seconds to minutes during bulk writes or replay conflicts), and **no isolation level spans primary and replica**.

### Failover and promotion, step by step

When the primary fails, a failover system (PostgreSQL has none built in; **Patroni** with etcd/Consul/ZooKeeper, cloud-managed services like RDS Multi-AZ or Aurora, or pg_auto_failover) runs a sequence like this:

1. **Detect** — the primary misses health checks, or (with Patroni) fails to renew its **leader key** in the distributed configuration store before its TTL (e.g. 30 s) expires.
2. **Fence the old primary** — make sure it cannot accept writes: Patroni's leader demotes itself when it cannot renew its key; cloud services revoke the old instance's network or storage; bare-metal setups use STONITH (power off via IPMI). Without this step you are one network partition away from split brain.
3. **Choose a candidate** — the healthy replica with the most WAL received (highest `pg_last_wal_receive_lsn()`), preferring synchronous standbys that are guaranteed to have every acknowledged commit.
4. **Promote** — `pg_promote()` (or `pg_ctl promote`): the replica finishes replaying what it has, switches to a new **timeline**, writes an end-of-recovery record and starts accepting writes.
5. **Repoint** — other replicas follow the new primary (they can switch timelines when streaming), and clients are redirected: DNS update, VIP move, proxy (HAProxy/PgBouncer) reconfiguration, or multi-host connection strings with `target_session_attrs=read-write`.
6. **Rejoin the old primary** — it cannot simply start as a replica if it wrote WAL the new primary never received. `pg_rewind` rewinds it to the divergence point on the new timeline (requires `wal_log_hints = on` or data checksums), after which it streams as a replica.

With **asynchronous** replication, anything the old primary committed and acknowledged but had not shipped to the promoted replica is **lost** — the data-loss window (RPO) equals the lag at the moment of failure. With synchronous replication to the promoted replica, RPO is zero for acknowledged commits. RPO/RTO design is the subject of [Ch 18 · High Availability](topic.html?p=18-high-availability).

### Split brain and fencing

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c09b1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c09b2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Split brain: a partition without fencing vs with a leader lease</text>
  <rect x="20" y="40" width="410" height="250" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="225" y="60" text-anchor="middle" fill="#7f1d1d" font-size="12" font-weight="bold">No fencing: naive health-check failover</text>
  <rect x="40" y="80" width="150" height="50" rx="6" fill="#fff" stroke="#dc2626"/>
  <text x="115" y="100" text-anchor="middle" fill="#1e293b" font-weight="bold">Old primary (AZ-a)</text>
  <text x="115" y="118" text-anchor="middle" fill="#334155" font-size="10">still alive, still writable</text>
  <rect x="260" y="80" width="150" height="50" rx="6" fill="#fff" stroke="#dc2626"/>
  <text x="335" y="100" text-anchor="middle" fill="#1e293b" font-weight="bold">Promoted replica (AZ-b)</text>
  <text x="335" y="118" text-anchor="middle" fill="#334155" font-size="10">monitor says: primary dead</text>
  <line x1="225" y1="72" x2="225" y2="200" stroke="#dc2626" stroke-width="3" stroke-dasharray="6 4"/>
  <text x="225" y="214" text-anchor="middle" fill="#7f1d1d" font-size="10">network partition</text>
  <rect x="40" y="150" width="150" height="34" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="115" y="171" text-anchor="middle" fill="#334155" font-size="10">app servers in AZ-a write here</text>
  <rect x="260" y="150" width="150" height="34" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="335" y="171" text-anchor="middle" fill="#334155" font-size="10">app servers in AZ-b write here</text>
  <text x="36" y="240" fill="#7f1d1d" font-size="10" font-weight="bold">Two timelines of writes: order 1001 exists twice with</text>
  <text x="36" y="256" fill="#7f1d1d" font-size="10" font-weight="bold">different contents; no automatic merge is possible.</text>
  <text x="36" y="276" fill="#334155" font-size="10">Recovery = pick one history, rewind the other, reconcile by hand.</text>
  <rect x="450" y="40" width="410" height="250" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="655" y="60" text-anchor="middle" fill="#14532d" font-size="12" font-weight="bold">Leader lease in a consensus store (Patroni + etcd)</text>
  <rect x="580" y="76" width="150" height="40" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="655" y="94" text-anchor="middle" fill="#1e293b" font-weight="bold">etcd (3 nodes)</text>
  <text x="655" y="108" text-anchor="middle" fill="#334155" font-size="10">leader key, TTL 30 s</text>
  <rect x="470" y="160" width="160" height="50" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="550" y="180" text-anchor="middle" fill="#1e293b" font-weight="bold">Old primary</text>
  <text x="550" y="198" text-anchor="middle" fill="#334155" font-size="10">cannot renew key: DEMOTES</text>
  <rect x="680" y="160" width="160" height="50" rx="6" fill="#fff" stroke="#16a34a"/>
  <text x="760" y="180" text-anchor="middle" fill="#1e293b" font-weight="bold">Replica</text>
  <text x="760" y="198" text-anchor="middle" fill="#334155" font-size="10">acquires key after TTL: PROMOTES</text>
  <path d="M600,118 L560,156" stroke="#dc2626" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#c09b1)"/>
  <path d="M710,118 L750,156" stroke="#16a34a" stroke-width="2" marker-end="url(#c09b2)"/>
  <text x="466" y="236" fill="#14532d" font-size="10">Only the side that can reach a MAJORITY of etcd can hold the key.</text>
  <text x="466" y="254" fill="#14532d" font-size="10">The old primary stops writing before the new one starts (TTL ordering).</text>
  <text x="466" y="272" fill="#14532d" font-size="10">Add watchdog / STONITH in case the old primary is too wedged to demote.</text>
  <rect x="20" y="304" width="840" height="114" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="36" y="324" fill="#1e293b" font-size="12" font-weight="bold">Fencing options, strongest first</text>
  <text x="36" y="346" fill="#334155" font-size="10">1. Power / instance off (STONITH, cloud API stop).  2. Revoke storage or network access (security group, detach volume).</text>
  <text x="36" y="366" fill="#334155" font-size="10">3. Lease: primary self-demotes when it cannot renew its lease in a majority-based store, before the lease can be granted elsewhere.</text>
  <text x="36" y="386" fill="#334155" font-size="10">4. Synchronous replication as a brake: an isolated old primary with ANY 1 sync standby cannot COMMIT at all (writes hang, not diverge).</text>
  <text x="36" y="406" fill="#334155" font-size="10">Health checks alone are NOT fencing: "I cannot reach it" is not "it is not running".</text>
</svg>
```

The reason fencing is essential is a fundamental fact of distributed systems: a monitor cannot distinguish a **dead** primary from an **unreachable** one. If failover promotes a replica while the old primary is merely partitioned from the monitor but still reachable by some application servers, both accept writes. Leader election with a lease in a consensus store ([Ch 15 · Consensus](topic.html?p=15-consensus)) ensures only one side can hold leadership; fencing ensures the losing side actually stops.

### Topologies you will meet

- **Primary + 2 replicas in different AZs**, one synchronous (`ANY 1`), with Patroni: the standard HA setup.
- **Cascading replicas** — a replica streams from another replica, reducing load and cross-region bandwidth on the primary.
- **Delayed replica** — `recovery_min_apply_delay = '4h'`: a replica that is deliberately behind, so a `DROP TABLE` at 14:00 can be recovered from it at 14:30. Not HA; a human-error safety net.
- **Logical subscriber for analytics or migrations** — a subset of tables replicated into a warehouse-shaped database, a new major version, or a new schema.
- **CDC consumers** — Debezium reading a logical slot into Kafka ([Kafka & RabbitMQ · Kafka Connect & CDC](../messaging/topic.html?p=25-kafka-connect-cdc)).

## 5. Implementation

### Simple example: a primary and a streaming replica in Docker

```text
$ docker network create pgnet
$ docker run -d --name pg1 --network pgnet -e POSTGRES_PASSWORD=pw postgres:17 \
    -c wal_level=replica -c max_wal_senders=10 -c max_replication_slots=10 \
    -c max_slot_wal_keep_size=10GB
$ docker exec pg1 psql -U postgres -c "CREATE ROLE repl WITH REPLICATION LOGIN PASSWORD 'pw';"
$ docker exec pg1 bash -c "echo 'host replication repl all scram-sha-256' >> /var/lib/postgresql/data/pg_hba.conf"
$ docker exec pg1 psql -U postgres -c "SELECT pg_reload_conf();"

# Replica: clone with pg_basebackup, create a slot (-C -S), write standby config (-R)
$ docker run -d --name pg2 --network pgnet -e POSTGRES_PASSWORD=pw \
    --entrypoint bash postgres:17 -c "sleep infinity"
$ docker exec -u postgres pg2 bash -c "PGPASSWORD=pw pg_basebackup -h pg1 -U repl \
    -D /var/lib/postgresql/data -X stream -C -S replica1 -R -P && pg_ctl -D /var/lib/postgresql/data start"
```

`-R` writes `standby.signal` and `primary_conninfo` (with `primary_slot_name`) into `postgresql.auto.conf`. On the primary:

```sql
SELECT application_name, state, sync_state,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)) AS replay_behind,
       write_lag, flush_lag, replay_lag
FROM pg_stat_replication;
```

```text
 application_name |   state   | sync_state | replay_behind | write_lag       | flush_lag       | replay_lag
------------------+-----------+------------+---------------+-----------------+-----------------+-----------------
 walreceiver      | streaming | async      | 0 bytes       | 00:00:00.000412 | 00:00:00.001130 | 00:00:00.001207
```

On the replica, time-based lag — with a caveat: if the primary is idle, `pg_last_xact_replay_timestamp()` stops advancing and this number grows although nothing is behind:

```sql
SELECT pg_is_in_recovery(),
       pg_last_wal_receive_lsn(), pg_last_wal_replay_lsn(),
       now() - pg_last_xact_replay_timestamp() AS time_since_last_replayed_commit;
```

### Simple example: make it synchronous (quorum) and feel the latency

```ini
# primary postgresql.conf (with two standbys named via application_name in primary_conninfo)
synchronous_standby_names = 'ANY 1 (replica_b, replica_c)'
synchronous_commit = on          # wait for standby flush; use remote_apply for read-your-writes there
```

Run `pgbench -c 1 -N` before and after. With both standbys in the same host the difference is small; put one in another AZ and the single-client TPS drops by the added round trip. Then stop both standbys and run `INSERT INTO t VALUES (1);` — it hangs. In `pg_stat_activity` the backend shows `wait_event = 'SyncRep'`. That hang is the availability cost of synchronous replication made visible. (For a single transaction you can opt out: `SET LOCAL synchronous_commit = local;`.)

### Simple example: logical replication of two tables

```sql
-- on the source (needs wal_level = logical, which requires a restart)
CREATE PUBLICATION orders_pub FOR TABLE orders, order_items;

-- on the target (tables must already exist with compatible columns)
CREATE SUBSCRIPTION orders_sub
  CONNECTION 'host=pg1 dbname=shop user=repl password=pw'
  PUBLICATION orders_pub;          -- creates a logical slot on the source and copies initial data

SELECT subname, received_lsn, latest_end_lsn, last_msg_receipt_time FROM pg_stat_subscription;
```

### Real-world example: an e-commerce database with HA, read replicas and CDC

A shop runs ~4,000 writes/s at peak, a 90:10 read/write ratio and a 2 TB database. Requirements: no loss of acknowledged orders on a single-AZ failure, failover under a minute, product browsing scaled out, and an order-events stream for downstream services. The design:

```text
AZ-a: pg-a (primary)        --- sync (ANY 1) ---> AZ-b: pg-b (replica, sync candidate)
                            --- sync (ANY 1) ---> AZ-c: pg-c (replica, sync candidate)
pg-b --- async cascade ---> pg-read-1, pg-read-2  (read pool behind PgBouncer/HAProxy, product pages)
pg-a --- logical slot ----> Debezium -> Kafka topic orders.events (outbox table only)
Patroni on all nodes, etcd x3 across AZs, leader key TTL 30 s, synchronous_mode on
```

The reasoning, trade-off by trade-off:

- **`ANY 1 (pg-b, pg-c)`** gives zero loss of acknowledged commits on the loss of AZ-a, at the cost of ~1–2 ms of cross-AZ round trip on every commit. Two candidates mean one can be down for maintenance without writes hanging.
- **Read replicas cascade from pg-b**, not from the primary, so read-replica WAL traffic does not load the primary. They are async: product pages tolerate a second of staleness; the checkout and "my orders" pages read from the primary (see [Ch 10](topic.html?p=10-consistency-models)).
- **Debezium reads only the outbox table** via a publication, with an alert on slot lag and `max_slot_wal_keep_size = 50GB`, because a stalled connector must never take down checkout. PG 17 can synchronize logical failover slots to physical standbys (`failover = true` on the slot plus `sync_replication_slots`), so CDC survives a promotion without a re-snapshot.
- **Replica queries**: `max_standby_streaming_delay = 30s`, `hot_standby_feedback = off` on the HA candidates (keep them close to the primary and bloat-free), and `on` for the read pool with long-query timeouts.

The monitoring queries that run every 15 s:

```sql
-- Per standby: byte and time lag, and sync state
SELECT application_name, client_addr, sync_state,
       pg_wal_lsn_diff(pg_current_wal_lsn(), flush_lsn)  AS flush_behind_bytes,
       pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn) AS replay_behind_bytes,
       replay_lag
FROM pg_stat_replication;

-- Slots: which consumers are retaining WAL, and how close to invalidation
SELECT slot_name, slot_type, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained,
       pg_size_pretty(safe_wal_size) AS until_invalidated
FROM pg_replication_slots ORDER BY restart_lsn;
```

```text
   slot_name    | slot_type | active | wal_status | retained | until_invalidated
----------------+-----------+--------+------------+----------+-------------------
 debezium_orders| logical   | f      | extended   | 31 GB    | 19 GB
 pg_b           | physical  | t      | reserved   | 2104 kB  | 50 GB
```

The first row is the one that pages someone: the CDC connector is inactive and retaining 31 GB; in 19 GB more the slot will be invalidated (and downstream consumers must re-snapshot) — better than a full disk on the primary, but still an incident.

> **MySQL difference:** The equivalent MySQL design uses GTID-based replication with **semi-synchronous** replication (`rpl_semi_sync_source_enabled = ON`, `rpl_semi_sync_source_wait_for_replica_count = 1`, wait point `AFTER_SYNC`, the lossless mode where the source waits for a replica ack after syncing the binlog and before committing in InnoDB). Beware `rpl_semi_sync_source_timeout` (default 10 s): after it expires, the source silently **falls back to asynchronous** — keeping writes available, but quietly giving up the no-loss guarantee. **Group Replication** (InnoDB Cluster) goes further with a Paxos-based group commit, and orchestrators such as Orchestrator or MySQL Router handle topology and routing.

## 6. Advantages, Disadvantages & Trade-offs

| Choice | Gains | Costs | Loss on primary failure |
|---|---|---|---|
| Async physical | Zero commit overhead; simple; exact copy | Stale reads; possible data loss on failover | Last un-flushed WAL on replica (usually sub-second, unbounded if lagging) |
| Sync physical (`on`) | Zero RPO to that replica | +1 RTT per commit; writes hang if no sync standby | None for acknowledged commits |
| Quorum (`ANY k`) | Zero RPO, tolerates slow/lost standby | Needs ≥ k+1 standbys; +RTT | None |
| `remote_apply` | Read-your-writes on the standby | Commit waits for replay (slowest part) | None |
| Logical replication | Table subset, cross-version, fan-in/out | No DDL/sequence replication; conflicts; row-by-row apply | Depends on sync settings; slot failover needs PG 17 or tooling |
| MySQL semi-sync | Near-zero RPO | Latency; silent fallback to async on timeout | None unless it fell back |
| Delayed replica | Undo human error within the delay | Useless for HA | N/A |

### When to use

- **Async replicas** for read scaling of staleness-tolerant data, for reporting, and as HA when a sub-second RPO is acceptable.
- **Synchronous quorum** when acknowledged writes must survive the loss of a node or AZ — orders, payments, ledgers — and you can afford a same-region round trip on commit.
- **Logical replication** for major-version upgrades, table-level migrations, feeding analytics, and CDC.
- **A delayed replica** when you fear `DELETE` without `WHERE` more than hardware failure.

### When NOT to

- **Not synchronous across regions** for high-throughput OLTP unless you truly need zero cross-region RPO: tens of milliseconds added to every commit usually costs more than it protects ([Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases)).
- **Not read replicas as a fix for slow queries**: a bad query is just as slow on a replica; optimize first ([Ch 21 · Database Scaling](topic.html?p=21-database-scaling)).
- **Not replication as backup**: a `DROP TABLE` replicates in milliseconds. You still need backups and PITR ([Ch 26](topic.html?p=26-backup-disaster-recovery)).
- **Not multi-primary** (bi-directional logical replication, BDR-style) unless you have designed conflict resolution for every table; it turns every write race into a data-merge problem.

## 7. Common Mistakes & Best Practices

- **Abandoned replication slots.** A replica is deleted but its slot is not; months later the primary's disk fills. Instead, set `max_slot_wal_keep_size`, alert on inactive slots and retained bytes, and drop slots as part of decommissioning.
- **Failover without fencing.** A script that promotes a replica when health checks fail will eventually create split brain. Instead, use a lease-based manager (Patroni + etcd, managed services) and a fencing mechanism.
- **Synchronous replication with exactly one standby.** When that standby restarts, every write on the primary hangs. Instead, use `ANY 1` over at least two candidates, or accept the automation that downgrades consciously (Patroni's `synchronous_mode` handles this).
- **Reading your own writes from a replica.** Users see their changes disappear. Instead, route post-write reads to the primary or wait for LSN (see [Ch 10](topic.html?p=10-consistency-models)).
- **Long analytic queries on HA standbys.** Either queries get cancelled or, with `hot_standby_feedback`, the primary bloats. Instead, give analytics its own replica with its own settings, or a logical subscriber / warehouse.
- **Measuring lag only in seconds from `pg_last_xact_replay_timestamp()`.** It reports huge "lag" on an idle primary and hides byte backlog. Instead, graph byte lag from `pg_stat_replication` and time lag from `replay_lag`.
- **Forgetting sequences and DDL in logical replication.** After a logical-replication cutover, inserts fail with duplicate keys because sequences were never advanced, or apply stops on a missing column. Instead, apply DDL on the subscriber first, and sync sequences as a cutover step.
- **Promoting the wrong replica.** Promoting a lagging async replica when a more up-to-date one exists loses more data than necessary. Instead, let the failover manager pick the replica with the highest received LSN, preferring synchronous ones.
- **Best practice:** decide RPO and RTO first, then choose sync/async and topology from them; test failover regularly under load; treat slots, lag and sync state as first-class alerts.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**The forgotten slot.** At 04:40 the primary stops: `PANIC: could not write to file "pg_wal/xlogtemp…": No space left on device`. Root cause: a logical slot for a Debezium connector that was paused three weeks ago during a Kafka migration; `max_slot_wal_keep_size` was never set (default `-1`, unlimited). Fix: grow the volume, start the primary, drop or advance the slot (`SELECT pg_drop_replication_slot('debezium_orders')`), let checkpoints recycle WAL; then set the cap and add alerts on retained bytes.

**Writes hang after a routine replica reboot.** Symptom: API latency climbs to the request timeout; the primary is idle on CPU; sessions show `wait_event = SyncRep`. Root cause: `synchronous_standby_names = 'replica_b'` with one standby, which was being patched. Fix now: `ALTER SYSTEM SET synchronous_standby_names = ''; SELECT pg_reload_conf();` (knowingly accepting async). Fix properly: quorum over two or more candidates.

**Failover loses 40 seconds of orders.** Symptom: after an automated failover, customers have confirmation emails for orders that do not exist. Root cause: asynchronous replication; the promoted replica was 40 s behind because a nightly bulk update had saturated replay. Fix: synchronous quorum for the order database, a failover policy that refuses to promote a replica lagging more than a threshold (Patroni's `maximum_lag_on_failover`), throttled bulk jobs, and reconciliation of lost orders from the outbox/email log.

**Split brain after a network partition.** Symptom: two nodes report `pg_is_in_recovery() = false`; order IDs collide. Root cause: a home-grown failover script promoted a replica when it could not ping the primary; the primary was alive and serving part of the fleet. Fix: stop writes to one side immediately (fence), choose the authoritative history, `pg_rewind` the other node, and reconcile divergent rows by hand from both. Then replace the script with lease-based failover.

**Replica queries cancelled all afternoon.** Symptom: reporting jobs on a replica fail with `canceling statement due to conflict with recovery`. Root cause: vacuum on the primary removing rows the long queries still need. Fix: a dedicated reporting replica with `hot_standby_feedback = on` and larger `max_standby_streaming_delay`, accepting it lags more; keep the HA standbys strict.

### Metrics to watch

- **Byte lag per replica** (`pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)`) and **time lag** (`replay_lag`), with alert thresholds tied to your read-staleness and RPO budgets.
- **Sync state** (`sync_state` = `sync`/`quorum`/`potential`/`async`) and the count of connected synchronous candidates; alert if fewer than the quorum + 1.
- **Slots:** `active = false`, retained bytes, `wal_status` (`extended`, `unreserved`, `lost`), `safe_wal_size`.
- **Replica conflicts:** `pg_stat_database_conflicts` on replicas (`confl_snapshot`, `confl_lock`, …).
- **Commit latency** on the primary, which includes the sync-rep wait; `SyncRep` wait events.
- **Failover drills:** time to promote, data loss measured (compare last acknowledged client write vs new primary), time for clients to reconnect.
- **MySQL:** `SHOW REPLICA STATUS` (`Seconds_Behind_Source`, `Retrieved_Gtid_Set` vs `Executed_Gtid_Set`), semi-sync status variables (`Rpl_semi_sync_source_status` = OFF means it fell back to async).

### Scaling notes

Replicas scale **reads**, not writes: every replica replays every write, so write throughput is capped by the primary and by single-threaded replay. Beyond a handful of replicas, cascading reduces primary fan-out. When writes outgrow one primary, the answer is partitioning data across primaries ([Ch 12 · Sharding](topic.html?p=12-sharding)) or distributed SQL, where replication happens per shard via consensus ([Ch 15 · Consensus](topic.html?p=15-consensus), [Ch 16 · Distributed Database Architecture](topic.html?p=16-distributed-database-architecture)). Across regions, asynchronous replicas give local reads with staleness; synchronous cross-region commit is a latency decision covered in [Ch 17](topic.html?p=17-multi-region-databases).

## 9. Interview Questions

**Q: What is the difference between physical and logical replication in PostgreSQL, and when would you pick each?**
A: Physical replication streams WAL and replays it onto a byte-identical copy of the whole cluster; it requires the same major version, replicates everything, and is the basis of HA standbys and read replicas. Logical replication decodes WAL into per-table row changes and applies them as SQL operations on an independent, writable database; it can replicate a subset of tables, cross major versions, and feed other systems. The cost of logical is that DDL and sequences are not replicated, updates and deletes need a replica identity, conflicts can stop the apply, and large statements become many row changes. I use physical for HA and read scaling, logical for upgrades, migrations, selective feeds and CDC.

**Q: What exactly can you lose when failing over to an asynchronous replica?**
A: Every transaction the old primary acknowledged but whose WAL the replica had not yet received and flushed. In steady state that is typically well under a second, but it equals the replica's lag at the moment of failure, so during a bulk job or network trouble it can be seconds or minutes. The clients of those transactions were told "committed". To bound it you use synchronous or quorum replication for data that matters, a failover policy that will not promote a replica lagging beyond a threshold, and idempotent, reconcilable writes so lost operations can be detected and replayed.

**Q: What do `remote_write`, `on` and `remote_apply` mean for `synchronous_commit` with a synchronous standby?**
A: They choose how far the standby must have processed the commit before the primary replies. `remote_write` waits until the standby has received the WAL and written it to its OS, so it survives the loss of the primary but not a simultaneous OS crash of both. `on` waits until the standby has flushed it to disk, so it survives both. `remote_apply` waits until the standby has replayed it, so a query on that standby immediately sees the commit — the only one that gives read-your-writes there. Each step adds latency to every commit.

**Q: Why can synchronous replication reduce availability, and how do you mitigate it?**
A: With synchronous replication, a commit waits for the configured standbys; if not enough of them are reachable, commits wait forever and writes appear to hang. So adding a synchronous standby adds a component whose failure stops writes. The mitigations are quorum commit over more candidates than required, such as `ANY 1` of two or three standbys in different AZs, and failover tooling like Patroni's synchronous mode that manages the standby list consciously. You should never run a single named synchronous standby in production without accepting that its maintenance means write downtime.

**Q: What causes replication lag, and how do you measure it properly?**
A: Lag builds at each stage: WAL generation outpacing the walsender or network (bulk writes, index builds), a slow standby disk, single-threaded replay that cannot keep up with a many-core primary, replay paused by hot-standby query conflicts, and for logical replication, row-by-row apply and long source transactions. I measure it on the primary with `pg_stat_replication`: byte lag as the difference between the current WAL LSN and each standby's flush and replay LSNs, and time lag from `write_lag`, `flush_lag` and `replay_lag`. On a replica, `now() - pg_last_xact_replay_timestamp()` is useful but misleading when the primary is idle, because it grows without real lag.

**Q: What is a replication slot, and why can it take down a primary?**
A: A slot records how far a consumer has confirmed and makes the primary keep all WAL after that point, so a replica or CDC connector never finds its needed WAL deleted. If the consumer disappears or stalls, the slot keeps retaining WAL indefinitely, and the primary's WAL directory grows until the disk is full and the database stops. Logical slots also hold back catalog cleanup. The defences are `max_slot_wal_keep_size` to invalidate a slot before it endangers the primary, alerts on inactive slots and retained bytes, and dropping slots when consumers are decommissioned.

**Q: How does split brain happen, and how do you prevent it? (Senior)**
A: It happens when a failover mechanism promotes a replica while the old primary is still running and reachable by some clients — usually because a monitor could not reach the primary and concluded it was dead, when it was only partitioned. Both nodes accept writes, producing divergent histories that cannot be merged automatically. Prevention has two parts. Leader election must be based on a majority, like a leader key with a TTL in etcd, so only one side of a partition can hold leadership and the old leader demotes itself when it cannot renew. And there must be fencing — powering off, revoking network or storage, or a watchdog — for the case where the old primary is too wedged to demote itself. Synchronous replication adds a brake, since an isolated primary cannot commit without its standby.

**Q: Design replication for a payments database that needs zero data loss on an AZ failure and failover under a minute. (Senior)**
A: I would run the primary in one AZ and at least two replicas in two other AZs, with `synchronous_standby_names = 'ANY 1 (b, c)'` and `synchronous_commit = on`, so every acknowledged commit is flushed in a second AZ and one replica can be down without stalling writes. Patroni with a three-node etcd across AZs handles leader election, lease-based self-demotion and promotion of a synchronous replica, with synchronous mode on so it never promotes a replica that might lack acknowledged commits. Clients use a proxy or multi-host connection strings with `target_session_attrs=read-write` and retry with idempotency keys to handle the ambiguous commits around failover. I would add a delayed replica or PITR for human error, alert on sync state, lag and slots, and run quarterly failover drills measuring RTO and verifying zero lost acknowledged payments.

**Q: You need to upgrade PostgreSQL 13 to 17 with minimal downtime on a 3 TB database. How would you use replication? (Senior)**
A: Physical replication cannot cross major versions, so I would use logical replication. I build a PG 17 instance, copy the schema with `pg_dump --schema-only`, create a publication for all tables on 13 and a subscription on 17, and let the initial copy and streaming catch up while I monitor lag and the slot's retained WAL on the old primary. Tables without a primary key need a replica identity first. During that time I freeze DDL, and I rehearse the cutover. At cutover I stop writes, wait until the subscriber has applied everything, sync sequences to above the source values, run validation (row counts, checksums on key tables), switch the connection endpoint, and keep the old cluster intact for rollback — optionally with reverse logical replication. Downtime is the write-freeze window, typically minutes.

**Q: Why are hot-standby queries sometimes cancelled, and what does `hot_standby_feedback` trade?**
A: Replay on the standby must apply changes from the primary, including vacuum removing old row versions. If a long query on the standby still needs those versions, replay waits up to `max_standby_streaming_delay` and then cancels the query with a conflict-with-recovery error. Turning on `hot_standby_feedback` makes the standby report its oldest snapshot to the primary, so the primary's vacuum keeps those versions, which avoids the cancellations. The trade is bloat and vacuum delay on the primary, driven by queries on a replica. I keep it off on HA standbys and on only for a dedicated reporting replica with bounded query timeouts.

**Q: How does MySQL semi-synchronous replication differ from PostgreSQL synchronous replication?**
A: Both make the source wait for a replica acknowledgement before the client sees the commit. In MySQL's lossless mode (`AFTER_SYNC`), the source waits after syncing the binlog and before committing in InnoDB, until a replica confirms it received the event into its relay log. The key operational difference is the timeout: after `rpl_semi_sync_source_timeout` without an ack, MySQL silently falls back to asynchronous, preserving availability at the cost of the guarantee, and returns to semi-sync when replicas catch up. PostgreSQL by default waits indefinitely, preferring the guarantee over availability, and relies on quorum or tooling to change that.

**Q: Why is a replica not a backup?**
A: A replica faithfully reproduces every change, including mistakes: a `DROP TABLE`, a bad migration or an application bug deleting rows reaches every replica within milliseconds. It also usually shares the same software bugs and, for physical replicas, the same logical corruption. A backup is an independent, point-in-time copy you can restore to a moment before the mistake — with base backups plus WAL archiving for PITR. A delayed replica narrows the gap for human error but is still not a substitute for tested, restorable backups.

## 10. Quick Revision & Cheat Sheet

| Decision | Options | Main trade |
|---|---|---|
| What to ship | Physical WAL / logical rows | Exact whole-cluster copy vs flexibility |
| When commit returns | async / `remote_write` / `on` / `remote_apply` | Latency vs RPO vs read-your-writes on replica |
| Which standbys | `FIRST k (...)` / `ANY k (...)` | Priority vs quorum; need > k candidates |
| WAL retention | slots / `wal_keep_size` / archive | Replica safety vs primary disk risk |
| Replica reads | feedback on/off, standby delay | Query cancellations vs primary bloat |
| Failover | Patroni + DCS, managed, manual | Automation + fencing vs split-brain risk |

| View / function | Tells you |
|---|---|
| `pg_stat_replication` | per-standby LSNs, lags, `sync_state` |
| `pg_replication_slots` | retention, `active`, `wal_status`, `safe_wal_size` |
| `pg_last_xact_replay_timestamp()` | time of last replayed commit (misleading when idle) |
| `pg_stat_subscription` | logical apply progress |
| `pg_stat_database_conflicts` | hot-standby query cancellations |

- Replication ships the log; replicas replay it — a physical replica is crash recovery that never ends.
- Async failover loses up to the lag; sync (quorum) loses nothing acknowledged but costs a round trip.
- A missing synchronous standby makes writes hang; always have more candidates than the quorum.
- Slots protect replicas and endanger primaries; cap them with `max_slot_wal_keep_size`.
- Health checks are not fencing; lease + majority + fencing prevents split brain.
- Replicas scale reads, not writes, and are not backups.
- Logical replication: no DDL, no sequences, needs replica identity.

## 11. Hands-On Exercises

Lab: the two-container setup from §5 (`postgres:17`), plus a third container for quorum exercises.

1. **Measure lag under load.** Run `pgbench -c 16 -T 120` on the primary and sample `pg_stat_replication` every second. Then run `UPDATE pgbench_accounts SET filler = md5(filler)` and watch byte lag and `replay_lag` spike and recover.
2. **Sync hang.** Configure `synchronous_standby_names = 'ANY 1 (pg2)'`, stop pg2, and try an `INSERT`. Find the `SyncRep` wait in `pg_stat_activity`. Add a third node and change to `ANY 1 (pg2, pg3)`; stop one and confirm writes continue.
3. **Slot disk bomb (safely).** Create a physical slot with no consumer (`SELECT pg_create_physical_replication_slot('orphan', true)` — the `true` reserves WAL immediately), generate WAL, and watch `pg_wal` grow and `wal_status` change. Then set `max_slot_wal_keep_size = '256MB'`, generate more WAL, and observe `wal_status = 'lost'`.
4. **Failover and rewind.** Promote pg2 with `SELECT pg_promote();` while pg1 still runs, write a row on each (a deliberate split brain), then stop pg1 and use `pg_rewind` to rejoin it as a replica of pg2. Note which row was lost and why.
5. **Replica conflict.** On pg2, run `SELECT pg_sleep(120) FROM pgbench_accounts LIMIT 1` inside a REPEATABLE READ transaction while running updates and `VACUUM` on pg1; observe the cancellation, then enable `hot_standby_feedback` and compare.
6. **Logical upgrade rehearsal.** Replicate two tables from `postgres:16` to `postgres:17` with a publication/subscription, then perform a cutover: stop writes, verify counts, sync sequences with `setval`, and switch.

### Mini project — "Failover Lab with Measured RPO"

Build a three-node Patroni cluster (Docker Compose with etcd) and a load generator that writes numbered, idempotency-keyed rows and logs every acknowledged ID client-side. Run failover drills — killing the primary container, partitioning it with `docker network disconnect`, and restarting a sync standby — under async, `ANY 1` sync and `remote_apply` settings. For each, measure RTO (time to first successful write after failure), RPO (acknowledged IDs missing on the new primary), and write latency. Produce a table and a recommendation for a payments workload and for a social-feed workload.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) · [Ch 08 · Crash Recovery](topic.html?p=08-crash-recovery) · [Ch 10 · Consistency Models](topic.html?p=10-consistency-models) (what readers of replicas observe) · [Ch 15 · Consensus](topic.html?p=15-consensus) (leader election without split brain) · [Ch 17 · Multi-Region Databases](topic.html?p=17-multi-region-databases) · [Ch 18 · High Availability](topic.html?p=18-high-availability) (RPO/RTO, Patroni) · [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery).

**Other handbooks:** [Caching with Redis · Replication & Sentinel](../redis-caching/topic.html?p=25-replication-sentinel) (the same leader-follower trade-offs in Redis) · [Kafka & RabbitMQ · Kafka Replication & ISR](../messaging/topic.html?p=17-kafka-replication-isr) (in-sync replicas as quorum durability) · [Kafka & RabbitMQ · Kafka Connect & CDC](../messaging/topic.html?p=25-kafka-connect-cdc) (logical slots feeding Kafka) · [Cassandra · Replication & Snitches](../cassandra/topic.html?p=19-replication-snitches) (leaderless replication for contrast) · [System Design · Database Scaling](../system-design/topic.html?p=16-database-scaling).

- **High Availability, Load Balancing, and Replication** — PostgreSQL docs · *Intermediate* · streaming replication, synchronous replication, hot standby conflicts and slots. <https://www.postgresql.org/docs/current/high-availability.html>
- **Logical Replication** — PostgreSQL docs · *Intermediate* · publications, subscriptions, restrictions (DDL, sequences) and conflicts. <https://www.postgresql.org/docs/current/logical-replication.html>
- **Replication configuration parameters** — PostgreSQL docs · *Intermediate* · `synchronous_standby_names`, `max_slot_wal_keep_size`, standby delays. <https://www.postgresql.org/docs/current/runtime-config-replication.html>
- **Patroni documentation** — Patroni · *Advanced* · lease-based HA, synchronous mode, and failover policies for PostgreSQL. <https://patroni.readthedocs.io/>
- **Replication with Global Transaction Identifiers** — MySQL Reference Manual · *Intermediate* · GTIDs and auto-positioning. <https://dev.mysql.com/doc/refman/8.0/en/replication-gtids.html>
- **Semisynchronous Replication** — MySQL Reference Manual · *Intermediate* · wait points, timeouts and the fallback to async. <https://dev.mysql.com/doc/refman/8.0/en/replication-semisync.html>
- **Designing Data-Intensive Applications, ch. 5** — Martin Kleppmann · *Intermediate* · leaders and followers, replication lag anomalies, failover pitfalls. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 09.*
