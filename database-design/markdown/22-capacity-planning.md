# 22 · Database Capacity Planning: From Users to IOPS

> **In one line:** Capacity planning turns product numbers (users, DAU, requests) into database numbers (queries/s, transactions/s, bytes/day, working set, IOPS, connections, WAL) and then turns those into an architecture decision — with explicit assumptions, peak factors and headroom, so you buy the right rung of the scaling ladder before you need it rather than during an outage.

---

## 1. Overview

"How big a database do we need?" is usually answered in one of two bad ways. The first is guessing: pick an instance that "feels" big, and find out it was wrong when the working set spills out of RAM six months later and p99 latency triples overnight. The second is back-of-the-envelope math that stops at the application tier: "20,000 requests per second" is written on a whiteboard and the discussion jumps to sharding, without ever asking how many *database statements* one request makes, how many bytes one write adds to disk, how much of that data is hot, or how many connections the fleet will open.

The database is where those questions have concrete, physical answers. A PostgreSQL row has a 23-byte header (padded to 24) plus a 4-byte line pointer before any of your columns. A heap page is 8 KB. Every index is a separate B-tree that grows with the table. Every committed write generates WAL — often several times the logical size of the change, because of index entries and full-page images after each checkpoint. A backend process per connection costs memory. Disks deliver a finite number of I/O operations per second, and cloud volumes enforce that number in software. Capacity planning is the discipline of multiplying your workload through those constants and seeing which one breaks first.

The naive approach fails for three reasons. It uses **averages** where peaks matter (a system sized for its daily average falls over every evening). It ignores **amplification** (one request becomes several queries; one row becomes heap plus indexes plus WAL plus replicas plus backups). And it confuses **throughput** with **storage** — QPS is a rate that resets every second, while data accumulates forever unless you delete it, so a design that is fine on day 1 can be broken on day 400 by storage alone.

This chapter gives you a repeatable method, the physical constants that matter, and fully worked examples — including a detailed walk-through of a 10M-user, 100K-DAU, 20K-requests/sec system — showing how the numbers pick the architecture.

> **Builds on:** [System Design · Back-of-the-Envelope Estimation](../system-design/topic.html?p=02-capacity-estimation) (QPS, rounding, latency numbers — not repeated here) · [Ch 02 · Storage Internals](topic.html?p=02-storage-internals) (pages, tuples, overhead) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (why WAL volume exceeds data volume) · [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) (the ladder these numbers choose a rung on). This chapter goes from the application's numbers down to database resources.

## 2. Core Concepts

- **QPS (queries per second)** — database *statements* per second, not HTTP requests. *Why it matters:* one API request commonly issues 2–20 statements; sizing on requests underestimates load by that factor.
- **TPS (transactions per second)** — committed transactions per second. *Why it matters:* each commit forces a WAL flush (with `synchronous_commit = on`), so TPS, not QPS, bounds write latency and fsync load.
- **Read/write ratio** — reads to writes, measured at the database. *Why it matters:* reads can be served by caches and replicas; writes must all go through one primary (until you shard).
- **Peak-to-average factor** — peak rate ÷ daily average rate. *Why it matters:* consumer apps often have 2–4x daily peaks; events, launches and batch jobs can push 10x or more. You size throughput for peak, storage for average.
- **Amplification** — the multiplier from logical work to physical work: queries per request, index entries per row, WAL bytes per data byte, replicas per primary. *Why it matters:* it is where most estimates are off by 5–10x.
- **Storage growth** — bytes added per day (heap + indexes + TOAST) minus bytes removed by retention. *Why it matters:* storage accumulates; it drives backup time, restore time, and eventually partitioning and archiving.
- **Working set** — the pages the workload touches repeatedly over a window (minutes to hours). *Why it matters:* when it fits in RAM (shared_buffers plus OS page cache), reads are memory-speed; when it does not, they become disk-speed, which is 100x+ slower.
- **IOPS** — I/O operations per second the storage can sustain; **throughput** is bytes per second. *Why it matters:* cloud volumes cap both; exceeding the cap queues I/O and latency explodes.
- **Connection capacity** — how many concurrent sessions the database can hold (`max_connections`) versus how many it can usefully *run* (roughly a small multiple of CPU cores). *Why it matters:* PostgreSQL uses a process per connection; thousands of idle ones waste memory and cause contention.
- **Little's law** — `L = λ × W`: average concurrency equals arrival rate times time in system. *Why it matters:* it converts QPS and latency into required connections, and exposes how a latency increase inflates concurrency.
- **Headroom** — capacity reserved above forecast peak. *Why it matters:* latency degrades non-linearly as utilization approaches 100% (queueing), failover concentrates load, and growth continues while you provision the next rung.

## 3. Theory & Principles

### The method: a pipeline of multiplications

Capacity planning is a chain. Each stage multiplies by an amplification factor you must state explicitly:

1. **Users → requests.** DAU × requests per active user per day ÷ 86,400 = average requests/s. × peak factor = peak requests/s.
2. **Requests → database statements.** Split by endpoint type: read requests × statements per read request; write requests × statements per write transaction. Then subtract what the cache absorbs.
3. **Statements → CPU and concurrency.** Statements/s × mean execution time = busy sessions (Little's law). Busy sessions vs cores tells you CPU pressure.
4. **Writes → bytes.** New rows/day × bytes per row (including tuple overhead) × (1 + index overhead) = storage/day. Writes also × WAL bytes per write = WAL/day, which drives archive storage, replica bandwidth and checkpoint settings.
5. **Bytes → working set → RAM.** Which fraction of the data is hot? That plus the hot fraction of indexes must fit in memory.
6. **Misses and flushes → IOPS.** Cache misses become read IOPS; commits and checkpoints become write IOPS.
7. **Everything → headroom.** Size so that forecast peak (not today's) runs at a comfortable utilization, including after losing one node.

```svg
<svg viewBox="0 0 900 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c22a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="450" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">From product numbers to database resources: every arrow is an amplification factor</text>

  <rect x="20" y="44" width="160" height="60" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="100" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Users, DAU</text>
  <text x="100" y="84" text-anchor="middle" fill="#334155" font-size="10">x requests/user/day</text>
  <text x="100" y="98" text-anchor="middle" fill="#334155" font-size="10">x peak factor</text>

  <rect x="230" y="44" width="170" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="315" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Requests/s (peak)</text>
  <text x="315" y="84" text-anchor="middle" fill="#334155" font-size="10">split: reads vs writes</text>
  <text x="315" y="98" text-anchor="middle" fill="#334155" font-size="10">x statements/request</text>

  <rect x="450" y="44" width="190" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="545" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">DB statements/s</text>
  <text x="545" y="84" text-anchor="middle" fill="#334155" font-size="10">minus cache hits</text>
  <text x="545" y="98" text-anchor="middle" fill="#334155" font-size="10">reads to replicas, writes to primary</text>

  <rect x="690" y="44" width="190" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="785" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Commits/s (TPS)</text>
  <text x="785" y="84" text-anchor="middle" fill="#334155" font-size="10">each commit = WAL flush</text>
  <text x="785" y="98" text-anchor="middle" fill="#334155" font-size="10">(group commit amortizes)</text>

  <path d="M180,74 L228,74" stroke="#334155" stroke-width="1.5" marker-end="url(#c22a1)"/>
  <path d="M400,74 L448,74" stroke="#334155" stroke-width="1.5" marker-end="url(#c22a1)"/>
  <path d="M640,74 L688,74" stroke="#334155" stroke-width="1.5" marker-end="url(#c22a1)"/>

  <rect x="20" y="160" width="200" height="86" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="120" y="182" text-anchor="middle" fill="#1e293b" font-weight="bold">CPU / concurrency</text>
  <text x="32" y="202" fill="#334155" font-size="10">Little: busy = QPS x latency</text>
  <text x="32" y="218" fill="#334155" font-size="10">busy sessions vs vCPUs</text>
  <text x="32" y="234" fill="#334155" font-size="10">target &lt;= ~60-70% at peak</text>

  <rect x="240" y="160" width="200" height="86" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="340" y="182" text-anchor="middle" fill="#1e293b" font-weight="bold">Connections</text>
  <text x="252" y="202" fill="#334155" font-size="10">active = busy + burst margin</text>
  <text x="252" y="218" fill="#334155" font-size="10">clients: pods x pool size</text>
  <text x="252" y="234" fill="#334155" font-size="10">pooler maps many to few</text>

  <rect x="460" y="160" width="200" height="86" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="560" y="182" text-anchor="middle" fill="#1e293b" font-weight="bold">Storage/day</text>
  <text x="472" y="202" fill="#334155" font-size="10">rows/day x (tuple + 28 B)</text>
  <text x="472" y="218" fill="#334155" font-size="10">x (1 + index overhead)</text>
  <text x="472" y="234" fill="#334155" font-size="10">+ bloat margin, - retention</text>

  <rect x="680" y="160" width="200" height="86" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="780" y="182" text-anchor="middle" fill="#1e293b" font-weight="bold">WAL/day</text>
  <text x="692" y="202" fill="#334155" font-size="10">often 2-5x logical change</text>
  <text x="692" y="218" fill="#334155" font-size="10">drives archive, replica link,</text>
  <text x="692" y="234" fill="#334155" font-size="10">max_wal_size, PITR storage</text>

  <path d="M545,104 L140,158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#c22a1)"/>
  <path d="M545,104 L340,158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#c22a1)"/>
  <path d="M785,104 L560,158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#c22a1)"/>
  <path d="M785,104 L780,158" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#c22a1)"/>

  <rect x="240" y="290" width="200" height="72" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="340" y="312" text-anchor="middle" fill="#1e293b" font-weight="bold">Working set -&gt; RAM</text>
  <text x="252" y="332" fill="#334155" font-size="10">hot rows + hot index pages</text>
  <text x="252" y="348" fill="#334155" font-size="10">must fit buffers + OS cache</text>

  <rect x="460" y="290" width="200" height="72" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="560" y="312" text-anchor="middle" fill="#1e293b" font-weight="bold">IOPS / throughput</text>
  <text x="472" y="332" fill="#334155" font-size="10">cache misses -&gt; read IOPS</text>
  <text x="472" y="348" fill="#334155" font-size="10">WAL flush + checkpoints -&gt; write</text>

  <path d="M560,246 L360,288" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#c22a1)"/>
  <path d="M400,362 L500,362" stroke="#94a3b8" stroke-width="1.2" marker-end="url(#c22a1)"/>

  <rect x="140" y="396" width="620" height="56" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="450" y="418" text-anchor="middle" fill="#1e293b" font-weight="bold">Architecture decision = the first resource that exceeds one node at forecast peak + headroom</text>
  <text x="450" y="438" text-anchor="middle" fill="#334155" font-size="10">reads -&gt; cache/replicas; RAM -&gt; bigger node/partition; storage -&gt; partition + archive; writes -&gt; bigger node, then shard</text>
</svg>
```

### The physical constants you need

**Row size.** A PostgreSQL heap tuple costs a 23-byte header (aligned to 24), a 4-byte line pointer in the page, then your columns with alignment padding (`bigint` and `timestamptz` align to 8 bytes; ordering columns from widest to narrowest avoids padding). Values over roughly 2 KB are compressed and/or moved to a TOAST table. Pages are 8 KB and, by default, filled to 100% for tables (`fillfactor`), so a 250-byte row fits about 30 per page. A quick, honest way to get the real number: load 100,000 representative rows and divide `pg_table_size()` by the row count.

**Index overhead.** A B-tree entry holds an 8-byte index tuple header, the key (aligned), and a 4-byte line pointer; a `bigint` or `timestamptz` key costs roughly 20 bytes per entry, a UUID key roughly 28, a text key more. B-tree leaf pages are filled to 90% by default and random inserts leave pages around 70% full after splits. With 3–5 indexes on a narrow table, indexes are routinely 50–100% of the heap size; on wide tables with few indexes, 20–40%. Measure with `pg_indexes_size()`.

**WAL per write.** An INSERT logs the new tuple plus a record header; each index insertion logs its own record; an UPDATE logs a new tuple version and (unless it is a HOT update) new index entries in every index. On top of that, the first change to each page after a checkpoint logs a **full-page image** (up to 8 KB) when `full_page_writes = on`, which is the default and should stay on. For OLTP with random index writes, WAL volume of 2–5x the logical data change is common; with frequent checkpoints it can be more. Measure with `pg_stat_wal.wal_bytes` or by diffing `pg_current_wal_lsn()` across a known workload.

**Memory.** RAM on a PostgreSQL server is split between `shared_buffers` (a common starting point is ~25% of RAM), the OS page cache (most of the rest — PostgreSQL relies on it heavily, and `effective_cache_size` tells the planner roughly how big it is), per-connection backend memory (a few MB idle, much more while sorting or hashing), `work_mem` allocations (per sort or hash node, per query — a complex query can use several), `maintenance_work_mem` for vacuum and index builds (per autovacuum worker unless `autovacuum_work_mem` is set), and the OS itself. A page may sit in both shared_buffers and the page cache ("double buffering"), which is why the working set must fit in their *combined* space with margin.

```svg
<svg viewBox="0 0 900 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="450" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Where 256 GB of RAM goes on a PostgreSQL primary (illustrative starting point)</text>

  <rect x="30" y="50" width="220" height="70" fill="#dbeafe" stroke="#2563eb"/>
  <text x="140" y="76" text-anchor="middle" fill="#1e293b" font-weight="bold">shared_buffers 64 GB</text>
  <text x="140" y="94" text-anchor="middle" fill="#334155" font-size="10">~25% of RAM; PG's own cache</text>
  <text x="140" y="110" text-anchor="middle" fill="#334155" font-size="10">dirty pages flushed at checkpoints</text>

  <rect x="250" y="50" width="450" height="70" fill="#dcfce7" stroke="#16a34a"/>
  <text x="475" y="76" text-anchor="middle" fill="#1e293b" font-weight="bold">OS page cache ~150 GB</text>
  <text x="475" y="94" text-anchor="middle" fill="#334155" font-size="10">second-level cache for data files; effective_cache_size ~ 190 GB</text>
  <text x="475" y="110" text-anchor="middle" fill="#334155" font-size="10">a shared_buffers miss that hits here costs a syscall + copy, not a disk read</text>

  <rect x="700" y="50" width="90" height="70" fill="#fef3c7" stroke="#d97706"/>
  <text x="745" y="74" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">backends</text>
  <text x="745" y="90" text-anchor="middle" fill="#334155" font-size="9">~200 x MBs</text>
  <text x="745" y="104" text-anchor="middle" fill="#334155" font-size="9">+ work_mem</text>

  <rect x="790" y="50" width="50" height="70" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="815" y="80" text-anchor="middle" fill="#1e293b" font-size="9">maint</text>
  <text x="815" y="94" text-anchor="middle" fill="#334155" font-size="9">vacuum</text>

  <rect x="840" y="50" width="30" height="70" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="855" y="90" text-anchor="middle" fill="#334155" font-size="9">OS</text>

  <text x="30" y="150" fill="#1e293b" font-size="12" font-weight="bold">Working set must fit in buffers + page cache, with margin</text>
  <rect x="30" y="162" width="300" height="34" fill="#16a34a" opacity="0.25" stroke="#16a34a"/>
  <text x="180" y="184" text-anchor="middle" fill="#1e293b">Healthy: working set 80 GB, hit ratio ~99%+</text>

  <rect x="30" y="206" width="760" height="34" fill="#dc2626" opacity="0.18" stroke="#dc2626"/>
  <text x="410" y="228" text-anchor="middle" fill="#1e293b">Spilling: working set 300 GB &gt; ~214 GB cache: misses become disk reads, p99 jumps</text>

  <text x="30" y="272" fill="#334155" font-size="10">work_mem danger: a query with 4 sort/hash nodes x 64 MB x 100 concurrent sessions can ask for ~25 GB, eating the page cache.</text>
  <text x="30" y="290" fill="#334155" font-size="10">Per-connection cost: idle backends are cheap-ish (a few MB), but 2,000 of them plus catalog caches are not. Pool them.</text>
  <text x="30" y="308" fill="#334155" font-size="10">MySQL contrast: InnoDB usually gets ~70-80% of RAM as innodb_buffer_pool_size and uses O_DIRECT, so no double buffering.</text>
  <text x="30" y="336" fill="#1e293b" font-size="11" font-weight="bold">Rule: size RAM from the working set, not from total data size.</text>
</svg>
```

### Little's law for databases

`L = λ × W`. If the database executes 20,000 statements per second with a mean in-database time of 1.5 ms, then on average 30 sessions are actively running at any instant. That is the minimum pool size to sustain the rate; you add margin for variance (bursts, occasional slow queries). Two consequences matter operationally:

- **Latency inflates concurrency.** If a lock or a slow disk makes mean time go from 1.5 ms to 15 ms, the same arrival rate now needs 300 concurrent sessions. The pool runs dry, requests queue in the application, and the outage looks like "connection pool exhausted" even though the root cause is latency ([Ch 20 · Database + Application](topic.html?p=20-database-application-architecture)).
- **More connections don't add throughput past the core count.** Once busy sessions exceed the number of cores (plus some I/O overlap), additional concurrent sessions just contend for CPU, locks and buffer mappings. A widely used starting formula (from the HikariCP project) is `connections ≈ cores × 2 + effective_spindles`, then tune by measurement.

### Peak traffic and headroom

Daily traffic is a curve, not a number. For consumer apps a peak-to-average of 2–4x across a day is typical; weekly and seasonal peaks stack on top (Black Friday, exam results, a match final), and marketing pushes or batch jobs can create 10x spikes for minutes. Size throughput for the **planning peak** = forecast peak × safety factor, and target a utilization that leaves headroom:

- **CPU:** OLTP latency is usually fine up to ~60–70% sustained; above that, run-queue delays show in p99.
- **Failover headroom:** with N replicas serving reads, losing one moves its load onto N−1. Each must run at most `(N−1)/N` of its safe maximum.
- **Growth headroom:** the next rung takes weeks to months to land. Plan so that forecast peak three to six months out still fits.
- **Storage:** alert well before full (e.g. 70–80%), because vacuum, index rebuilds, and WAL retention during a replica outage all need temporary space.

## 4. Architecture & Workflow

### The daily curve and why storage uses average but throughput uses peak

```text
requests/s
 20K |                                   ____
     |                                 _/    \_          <- planning peak (design for this)
 15K |                               _/        \
     |                             _/           \
 10K |                   ________/               \
     |              ____/                         \___
  5K |- - - - - - -/- - - - - - - - - - - - - - - - - -\- - -  <- daily average (storage, WAL/day)
     |  _______/                                        \____
     +-----------------------------------------------------------> hour
       00   03   06   09   12   15   18   21   24
```

Throughput limits (CPU, IOPS, connections, lock contention) are hit **instantaneously**, so they are sized from the peak. Storage and WAL archives accumulate over the whole day, so they are sized from the **average** rate × 86,400. Mixing these up in either direction is a classic error: sizing storage from peak overstates it by the peak factor; sizing CPU from average understates it by the same factor.

### The capacity planning workflow in a team

1. **Collect inputs:** product forecasts (users, DAU, feature launches), current measurements (per-endpoint request rates, `pg_stat_statements` per-statement rates and times, table growth from `pg_total_relation_size` snapshots).
2. **Build the model:** a spreadsheet or script with every amplification factor as a named, editable cell.
3. **Validate against reality:** the model's output for *today's* inputs must match *today's* measured CPU, IOPS, storage growth within tens of percent. If it doesn't, a factor is wrong.
4. **Project:** run forecast inputs at 3, 6, 12 months.
5. **Identify the first constraint** and its date.
6. **Decide the rung** and schedule it ([Ch 21](topic.html?p=21-database-scaling)); record triggers.
7. **Load test** the chosen configuration at planning peak.
8. **Review quarterly** ([Ch 25 · Database Reliability Engineering](topic.html?p=25-database-reliability-engineering)).

## 5. Implementation

### Worked example 1 (the main one): 10M users, 100K DAU, 20K requests/sec, 80% reads / 20% writes

**Inputs as given:** 10M registered users, 100K daily active users, 20K requests/second, 80% reads, 20% writes.

#### Step 0 — Notice the tension in the inputs

Before multiplying anything, sanity-check the inputs against each other. 20K requests/second sustained all day is `20,000 × 86,400 ≈ 1.73 billion requests/day`. Divided by 100K DAU, that is **~17,000 requests per active user per day** — about one request every five seconds for 24 hours, per person. No human does that. So one of these must be true:

- **20K rps is a peak, not an average.** Then the daily average is lower. With a peak-to-average of 4, average is 5K rps, i.e. ~432M requests/day, still ~4,300 per DAU — heavy.
- **Most traffic is not humans.** API integrations, mobile background sync, polling clients, webhooks, or B2B customers whose systems call you. Then DAU is the wrong driver entirely, and you should size from per-client API rates.
- **DAU is wrong** (e.g. it counts logins, not active sessions), or the 20K rps figure is aspirational.

In a design review you say this out loud, then pick an interpretation and state it. **Assumption for this example:** 20K rps is the **planning peak**, driven largely by API/background clients; the **daily average is 5K rps** (peak factor 4). Throughput is sized for 20K; storage and WAL/day for 5K.

#### Step 1 — Requests to reads and writes

| | Peak | Daily average |
|---|---|---|
| Total requests/s | 20,000 | 5,000 |
| Read requests/s (80%) | 16,000 | 4,000 |
| Write requests/s (20%) | 4,000 | 1,000 |

#### Step 2 — Requests to database statements

Look at (or assume) the shape of each request type:

- **Read request:** auth/session lookup (1 PK lookup), the main entity (1 PK lookup), a list/related query (1 indexed range query returning ~20 rows). **3 statements**, all SELECT.
- **Write request:** one transaction: read the entity (1), insert a new row or update an existing one (1), insert a history/audit row (1), update a counter/denormalized field (1). **4 statements, 1 commit.** Assume half of write requests insert a new primary row and half update an existing one.

Before caching, at peak: reads = `16,000 × 3 = 48,000 SELECT/s`, plus `4,000 × 1 = 4,000 SELECT/s` inside write transactions, plus writes = `4,000 × 3 = 12,000 DML/s` in **4,000 TPS**. Total ≈ **64,000 statements/s**. That is the number that would hit the database if every query went straight to it.

**Apply the cache.** Session lookups and hot entity reads are good cache candidates; list queries less so. Assume a Redis cache-aside layer serves 90% of session lookups and 70% of entity lookups, and 0% of list queries:

- session: `16,000 × 10% = 1,600/s`
- entity: `16,000 × 30% = 4,800/s`
- list: `16,000/s`
- reads inside write txns: `4,000/s` (must be fresh — primary)

Database SELECTs at peak ≈ **26,400/s**, DML ≈ **12,000/s**, commits ≈ **4,000/s**. The cache removed ~40% of statements — less than people expect, because the list query is uncacheable and dominates. That's a finding: optimizing that list query (covering index, keyset pagination) is worth more than more cache.

#### Step 3 — Row sizes

Primary table `items` (typical OLTP entity): `id bigint, user_id bigint, created_at timestamptz, updated_at timestamptz, status smallint, amount numeric, title text(~60 B), payload jsonb(~80 B)`. Columns ≈ 8+8+8+8+2(+pad)+~10+~60+~80 ≈ **190 B**; plus 24 B header + 4 B line pointer ≈ **~220 B per row**. Call it **250 B** with alignment and slack.

History table `item_events`: `id bigint, item_id bigint, created_at timestamptz, kind smallint, diff jsonb(~60 B)` ≈ 100 B of columns + 28 B ≈ **~130 B**, call it **150 B**.

Indexes:

- `items`: PK on `id` (~20 B/entry), `(user_id, created_at)` for the list query (~28 B/entry), `status` partial index on active rows (small). ≈ **55 B per row** of index at fresh fill; with typical leaf fill after random inserts, **~75 B**.
- `item_events`: PK (~20 B), `(item_id, created_at)` (~28 B) ≈ **~60 B** after page slack.

#### Step 4 — Daily and yearly storage

Using the **average** write rate (1,000 write requests/s → 86.4M/day):

- New `items` rows: 50% of writes → **43.2M rows/day** × (250 + 75) B ≈ **14.0 GB/day**.
- New `item_events` rows: every write → **86.4M rows/day** × (150 + 60) B ≈ **18.1 GB/day**.
- Updates to existing rows create dead tuples that vacuum makes reusable; they cause bloat, not growth, if autovacuum keeps up. Add a **~20% bloat/free-space margin**.

**Total ≈ 32 GB/day × 1.2 ≈ 38 GB/day ≈ 14 TB/year** of primary storage, before replicas and backups.

| Component | Per day | Per year |
|---|---|---|
| items heap + indexes | 14.0 GB | 5.1 TB |
| item_events heap + indexes | 18.1 GB | 6.6 TB |
| Bloat margin (20%) | 6.4 GB | 2.3 TB |
| **Total on the primary** | **~38 GB** | **~14 TB** |
| × 3 copies (primary + 2 replicas) | ~115 GB | ~42 TB |

This is the first strong signal. Throughput has not decided anything yet, but **storage says the design cannot keep everything hot forever on one node**. Fourteen terabytes a year means backups, restores and replica rebuilds get slower every month; a restore of a multi-TB database can take many hours, which may already exceed your RTO ([Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery)). The answer is **retention and partitioning**: `item_events` partitioned by month with, say, 90 days hot in PostgreSQL and older months exported to object storage/warehouse ([Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)). With 90-day event retention, `item_events` stabilizes around `90 × 18.1 × 1.2 ≈ 2 TB`, and `items` grows ~5–6 TB/year — manageable for a year or two, and a trigger for archiving closed items later.

#### Step 5 — WAL volume

Per write request, estimate WAL:

- INSERT/UPDATE of the `items` row: ~250 B tuple + ~50 B record overhead ≈ 300 B; index entries (on insert, or on non-HOT update): ~3 × 70 B ≈ 200 B.
- INSERT into `item_events` + 2 index entries: ~150 + 50 + 140 ≈ 350 B.
- Counter update (HOT if no indexed column changes): ~150 B.
- Commit record: tens of bytes.
- **Full-page images:** random index leaf pages touched for the first time after a checkpoint log up to 8 KB each. With a 5–15-minute checkpoint interval and a large, randomly updated index, a substantial fraction of changes are first touches. Budget **~2x the above** for FPIs.

≈ 1,000 B logical → **~2 KB of WAL per write request**.

- Average: 1,000/s × 2 KB = **2 MB/s ≈ 170 GB/day** of WAL.
- Peak: 4,000/s × 2 KB = **8 MB/s**.

Consequences: WAL archive for 7-day PITR ≈ 1.2 TB before compression (WAL compresses well, often 3–5x; `wal_compression` also shrinks FPIs). Each streaming replica needs ~8 MB/s (~64 Mbit/s) at peak — trivial on the network, but a replica that falls behind must catch up at a multiple of that. And `max_wal_size` should comfortably exceed WAL generated per checkpoint interval: at 8 MB/s × 600 s ≈ 4.8 GB, the 1 GB default would force frequent requested checkpoints (more FPIs, more I/O) — set it to something like 16 GB and `checkpoint_timeout` to 10–15 minutes, then verify in `pg_stat_checkpointer` (PG 17) that most checkpoints are timed, not requested.

#### Step 6 — Working set and memory

What is actually hot?

- `users`/sessions: 10M users × ~400 B (row + indexes) ≈ **4 GB** — all of it can be hot; keep it in RAM.
- `items`: reads concentrate on recently active items. If the last 7 days of items plus items touched in that window are hot: `7 × 43.2M × 325 B ≈ 100 GB`, but only a fraction is re-read. Assume **~40 GB** of heap pages are repeatedly hit, plus the upper and hot leaf levels of the `(user_id, created_at)` index, ~**15 GB**.
- `item_events`: mostly written, rarely read; the current partition's right-hand index pages and heap tail are hot: **~5 GB**.
- Catalogs, visibility maps, misc: small.

**Working set ≈ 65–80 GB.** With a 256 GB instance (64 GB shared_buffers + ~150 GB page cache) it fits with generous margin; with 128 GB (32 GB + ~80 GB) it would be marginal — any growth or a reporting query would push it out. Choose **256 GB** for the primary. Replicas serve the list queries and need the same working set, so they get the same size.

#### Step 7 — CPU and concurrency (Little's law)

Estimate mean in-database execution time: PK lookups ~0.1–0.3 ms, the list query ~1 ms (index range + 20 heap fetches, all cached), write transaction ~2 ms of DB time plus commit flush ~1 ms.

Primary (writes + reads-in-write-txns + read-your-writes traffic, say 10% of reads):

- Write txns: 4,000/s × ~3 ms (including network round trips between statements, the session is held) ≈ **12 busy sessions**.
- Reads on primary: ~2,640/s × ~0.6 ms ≈ **1.6**.
- **~14 busy sessions** on average at peak. With 32 vCPUs, CPU-bound work at that concurrency is comfortably under 50%. Writes are not the problem at this scale.

Replicas (remaining reads: 26,400 − 4,000 in write transactions − 2,640 read-your-writes ≈ 19,800/s) × ~0.7 ms ≈ **14 busy sessions** total. Two replicas of 16–32 vCPUs handle this with room; with **N+1** (survive losing one), size each replica so it alone can carry all replica reads at ≤ ~70% CPU.

#### Step 8 — IOPS

Reads: with the working set in memory and a >99% hit ratio, DB block reads that miss both caches are a small fraction. 26,400 SELECT/s × ~5 buffer accesses ≈ 130K buffer hits/s; 0.5% missing to disk ≈ **~650 read IOPS**, mostly on replicas. Cold-cache moments (after failover or restart) can be 10–50x that — the real reason to provision above steady state.

Writes on the primary:

- WAL: sequential writes, flushed at commit; with group commit at 4,000 TPS, on the order of **1,000–4,000 small flushes/s**. Many cloud volumes count each I/O up to a size limit as one operation, so small WAL flushes count fully.
- Data pages: checkpoints and the background writer flush dirty pages; random index leaf pages dominate. Estimate **1,000–3,000 write IOPS** averaged, bursting during checkpoints (spread by `checkpoint_completion_target = 0.9`).

**Total primary: roughly 3,000–7,000 IOPS at peak.** An AWS gp3 volume starts with a baseline of 3,000 IOPS and 125 MiB/s independent of size, and more IOPS and throughput can be provisioned separately up to per-volume limits (check current AWS documentation — the ceilings have changed over time; RDS also stripes larger volumes and raises the baseline above a size threshold). **Provision ~12,000 IOPS** (2x the estimated peak) or use io2 if latency consistency matters. Do not rely on burst credits: gp2 volumes and burstable instance classes earn credits at a baseline rate and silently drop to baseline when credits run out — a classic incident ([Ch 23 · Bottleneck Diagnosis](topic.html?p=23-bottleneck-diagnosis)).

#### Step 9 — Connection pool sizing

- Application: 40 pods × pool of 20 = **800 client connections** at most.
- Needed active server sessions (from Little's law): ~14 on primary, ~7 per replica, average at peak; with 3x burst margin, **~50 on the primary and ~30 per replica**.
- Therefore: **PgBouncer in transaction mode** in front of each node, `default_pool_size` ≈ 50 (primary), 30–40 (replicas), `max_client_conn` 1,000+. PostgreSQL `max_connections` ≈ 200 (pooler + admin + monitoring + replication + migrations), not 1,000.
- Without a pooler, 800 direct backends would be mostly idle, cost several GB of RAM and add contention for no throughput gain.

#### Step 10 — Network

Replica read results: 16,000 list queries/s × 20 rows × ~300 B ≈ 96 MB/s, plus lookups ≈ **~110 MB/s ≈ 0.9 Gbit/s** across replicas at peak. WAL shipping: 8 MB/s per replica. Any instance with multi-Gbit networking is fine, but note list payloads are the network driver — returning 200 rows instead of 20 would push this to ~9 Gbit/s.

#### Step 11 — The architecture decision

| Resource | Estimate at planning peak | One node OK? | Decision |
|---|---|---|---|
| DB statements | ~38K/s after cache | Yes, split | Cache + replicas for reads |
| Write TPS | 4,000 | Yes | Single primary |
| Working set | 65–80 GB | Yes with 256 GB | 256 GB primary and replicas |
| Storage growth | ~38 GB/day, 14 TB/yr | Not forever | Partition `item_events` monthly, 90-day hot retention, archive |
| WAL | 2 MB/s avg, 8 MB/s peak | Yes | `max_wal_size` ~16 GB, WAL compression, 7-day PITR |
| IOPS | 3–7K peak | Yes, provisioned | ~12K provisioned IOPS, no burst reliance |
| Connections | ~50 active on primary | Yes, pooled | PgBouncer transaction mode |

**Design:** one PostgreSQL primary (32 vCPU, 256 GB RAM, provisioned-IOPS storage) + one synchronous-or-quorum standby for HA + two async read replicas (N+1 for reads) + Redis cache-aside for sessions and entities + monthly partitioning with retention for the event table. **No sharding.** The write path is at ~15–25% of one primary's capacity; the pressure is on reads (solved by cache and replicas) and storage (solved by lifecycle). **Triggers for the next rung:** sustained peak write TPS above ~50% of the measured ceiling of the primary, hot `items` storage beyond what can be restored within RTO, or working set above ~60% of RAM.

### Worked example 2: small SaaS, 2,000 peak requests/s

B2B SaaS, 5,000 tenants, 2,000 peak req/s, 95% reads, 3 statements/request. DB statements ≈ 6,000/s peak; writes 100 TPS. Data: 200 GB growing 5 GB/month; working set ~15 GB. **Decision:** a single 8 vCPU / 64 GB primary + standby, no cache, no replicas; add a replica only to isolate tenant reporting exports. Headroom check: at 3x growth it still fits the next instance size. The mistake to avoid here is building the 20K-rps architecture for a 2K-rps product.

### Worked example 3: forecasting from measurements instead of assumptions

Once a system exists, replace assumptions with data:

```sql
-- Growth per table: snapshot daily into a history table, then diff.
CREATE TABLE IF NOT EXISTS capacity_snapshots (
  taken_at  date   NOT NULL DEFAULT current_date,
  relname   text   NOT NULL,
  heap_b    bigint NOT NULL,
  index_b   bigint NOT NULL,
  n_live    bigint NOT NULL,
  PRIMARY KEY (taken_at, relname)
);

INSERT INTO capacity_snapshots (relname, heap_b, index_b, n_live)
SELECT c.relname, pg_table_size(c.oid), pg_indexes_size(c.oid), s.n_live_tup
FROM pg_class c JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE c.relkind IN ('r', 'p')
ON CONFLICT DO NOTHING;

-- Average bytes per row (real, including overhead) and daily growth.
SELECT relname,
       (heap_b + index_b) / NULLIF(n_live, 0)                          AS bytes_per_row,
       pg_size_pretty(((heap_b + index_b) - lag(heap_b + index_b)
                        OVER (PARTITION BY relname ORDER BY taken_at))) AS growth_since_prev
FROM capacity_snapshots
ORDER BY taken_at DESC, heap_b DESC
LIMIT 20;
```

```sql
-- WAL generated per second over a measured window (run twice, 60 s apart).
SELECT pg_current_wal_lsn();                         -- e.g. 3A/1F000000
-- ... 60 seconds later ...
SELECT pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), '3A/1F000000') / 60) AS wal_per_sec;

-- Statement mix and busy-session estimate (Little's law) from pg_stat_statements
-- over the interval since the last reset.
SELECT sum(calls) / extract(epoch FROM now() - (SELECT stats_reset FROM pg_stat_statements_info)) AS qps,
       sum(total_exec_time) / 1000
         / extract(epoch FROM now() - (SELECT stats_reset FROM pg_stat_statements_info))  AS avg_busy_sessions
FROM pg_stat_statements;
```

`avg_busy_sessions` is Little's law computed directly: total execution seconds per wall-clock second. If it is 12 on a 32-vCPU machine, you have head room for CPU-bound work; if it approaches the core count, you don't.

> **MySQL difference:** Row overhead differs (InnoDB rows carry a ~5-byte header plus 6-byte transaction id and 7-byte roll pointer; pages are 16 KB; the table *is* the clustered primary-key index, and every secondary index entry stores the primary key, so a wide PK inflates every index). Measure with `information_schema.TABLES` (`DATA_LENGTH`, `INDEX_LENGTH`). The log to size is the redo log (`innodb_redo_log_capacity` in 8.0.30+) *plus* the binlog, which is what replicas and PITR use. MySQL uses a thread per connection, so idle connections are cheaper than in PostgreSQL, but the same Little's-law logic applies to active ones; default `max_connections` is 151.

## 6. Advantages, Disadvantages & Trade-offs

| Approach | Strength | Weakness |
|---|---|---|
| Assumption-based model (pre-launch) | Fast; forces explicit assumptions | Amplification factors often wrong by 2–5x |
| Measurement-based model | Grounded in real row sizes, WAL rates, statement mix | Needs history; misses new features |
| Load testing at planning peak | Finds non-linear effects (locks, checkpoints) | Expensive; synthetic data rarely matches skew |
| Size for peak with high headroom | Survives spikes and failover | Pays for idle capacity most of the day |
| Size for average + autoscale | Cheap | Databases don't autoscale quickly; primaries can't scale out |
| Provisioned IOPS | Predictable latency | Cost even when idle |
| Burst-credit storage/instances | Cheap at low load | Silent cliff when credits run out |

### When to use detailed capacity planning

- Before launching anything expected to exceed a single small instance.
- Before a known event (sale, launch, migration) that changes traffic shape.
- Quarterly for any database approaching 50% of a resource.
- Before committing to a one-way-door rung (sharding, multi-region).

### When NOT to over-invest

- Early prototypes: the right answer is "one managed PostgreSQL, measure later".
- When the model's precision exceeds the inputs' precision: a 3-decimal spreadsheet built on a guessed DAU is theatre. Keep factors round and focus on which resource breaks first.

## 7. Common Mistakes & Best Practices

**1. Sizing from HTTP requests, not statements.** *Why it hurts:* 5–20 statements per request is common, and ORMs can make it 100. *Instead:* measure statements per endpoint (APM traces or `pg_stat_statements` / request counts).

**2. Using average for throughput.** *Why it hurts:* the database saturates every evening. *Instead:* throughput from planning peak; storage from average.

**3. Forgetting index and tuple overhead.** *Why it hurts:* "100 bytes × 1B rows = 100 GB" becomes 300 GB with header, padding and three indexes. *Instead:* measure bytes/row with a 100K-row sample.

**4. Ignoring WAL.** *Why it hurts:* WAL archive storage, replica catch-up and checkpoint pressure are sized from it; teams discover it when the WAL volume fills during a replica outage. *Instead:* measure `pg_stat_wal`/LSN diffs and size archive, `max_wal_size` and `max_slot_wal_keep_size` from it.

**5. Sizing RAM from total data.** *Why it hurts:* either wasteful (buying 2 TB of RAM for a 2 TB DB with an 80 GB working set) or dangerous (ignoring that the working set is growing). *Instead:* estimate and then monitor the working set via hit ratio and `pg_stat_io`/`pg_statio_*` reads.

**6. Setting max_connections to the client count.** *Why it hurts:* thousands of backends contend and waste memory; a latency blip turns into a connection storm. *Instead:* pool; size server connections from Little's law with margin.

**7. Relying on burst credits.** *Why it hurts:* works in testing, collapses after hours of sustained load. *Instead:* size for baseline, not burst; alert on credit balance.

**8. No failover headroom.** *Why it hurts:* two replicas at 70% become one at 140% when one dies. *Instead:* N+1 sizing.

**9. Not validating the model against today.** *Instead:* the model must reproduce today's measured CPU, IOPS and growth before you trust its forecast.

## 8. Production: Failure Scenarios, Monitoring & Scaling

**The launch that tripled statements, not requests.** A new feature adds a "related items" panel. Requests grow 10%, but DB statements grow 3x because the panel makes 12 queries. CPU goes from 45% to 95% on launch day. *Lesson:* capacity review includes statements per request per endpoint; feature launches get a DB budget.

**The working set that crossed RAM.** Over six months, a table grows gradually; one Tuesday the hit ratio drops from 99.5% to 96%. Disk reads rise ~8x, p99 goes from 20 ms to 250 ms. Nothing "changed" — the working set crossed the cache size. *Lesson:* trend the hit ratio and read IOPS; alert on the trend, not only on an absolute threshold.

**The WAL disk during a replica outage.** A replica with a physical replication slot is down for a weekend. At 170 GB/day of WAL, the primary retains ~350 GB and the WAL volume fills; the primary stops accepting writes. *Lesson:* size WAL space from measured WAL/day × longest tolerated outage, and set `max_slot_wal_keep_size`.

**The burst-credit cliff.** A migration backfill runs for 6 hours on gp2-class storage; after ~2 hours, IOPS drop to baseline, commits slow from 2 ms to 80 ms, and the application's pools exhaust. *Lesson:* size backfills against baseline, throttle them, and monitor `BurstBalance`.

**Metrics to feed capacity reviews:** peak CPU and busy sessions (from `pg_stat_activity` sampling or Performance Insights' average active sessions), statements/s and TPS (`pg_stat_statements`, `pg_stat_database.xact_commit`), bytes/day per table, WAL bytes/s (`pg_stat_wal`), hit ratio and read IOPS, connection counts by state, replica lag, storage free %. [Ch 24 · Database Monitoring](topic.html?p=24-database-monitoring) covers thresholds.

**Scaling:** the capacity model tells you *which* rung and *when*. If the first constraint is reads, add cache/replicas; RAM, a larger node or partitioning; storage, lifecycle and partitioning; writes, a larger primary then sharding ([Ch 21](topic.html?p=21-database-scaling), [Ch 12 · Sharding](topic.html?p=12-sharding)).

## 9. Interview Questions

**Q: You're told a system has 100K DAU and 20K requests per second. What's your first reaction?**
A: That the two numbers disagree unless something else is going on. 20K requests/s all day is about 1.7 billion requests/day, or ~17,000 per active user — one every few seconds, around the clock. So either 20K is a peak and the average is much lower, or most traffic comes from machines (integrations, background sync, polling), or DAU is being measured differently. I'd state the interpretation I'm using — e.g. 20K is the planning peak with a 4x peak factor — and size throughput from the peak and storage from the average.

**Q: Why do you size throughput from peak but storage from average?**
A: Throughput limits are instantaneous: CPU, IOPS, locks and connections saturate at whatever the rate is in the busiest minutes, so the peak decides whether you fall over. Storage accumulates over the whole day, so bytes/day is the average write rate × 86,400. Using the peak for storage overstates it by the peak factor; using the average for CPU understates it by the same factor.

**Q: How do you estimate the on-disk size of a PostgreSQL row?**
A: Sum the column sizes with alignment (8-byte types align on 8 bytes, so column order matters), add the ~24-byte tuple header and a 4-byte line pointer, and remember pages are 8 KB so you get roughly 8,000 ÷ row size rows per page. Then add indexes — roughly 20–30 bytes per entry for bigint/timestamp/UUID keys, more for text, with leaf pages 70–90% full. The reliable method is to load 100K representative rows and divide `pg_table_size` and `pg_indexes_size` by the row count.

**Q: What is the working set, and how does it determine RAM?**
A: It's the set of pages the workload keeps touching over a window — hot rows and the index pages that lead to them. When it fits in shared_buffers plus the OS page cache, reads are served from memory; when it doesn't, misses become disk reads that are orders of magnitude slower and p99 latency jumps. So RAM is sized from the working set with margin, not from total data size, and you monitor hit ratio and read IOPS to see it approaching the cache size.

**Q: Use Little's law to size a connection pool.**
A: Little's law says average concurrency = arrival rate × time in system. If the database runs 10,000 statements/s averaging 2 ms each, 20 sessions are busy on average. I'd add margin for bursts — perhaps 2–3x — giving a server pool of 40–60, and check that's not far above the core count, because extra concurrent sessions beyond cores add contention, not throughput. Clients can be many more; a transaction-mode pooler maps them onto that server pool.

**Q: Why is WAL volume larger than the data you write?**
A: Because WAL logs every physical change: the new tuple, a record per index entry, commit records, and — the big one — a full-page image the first time each page is modified after a checkpoint, to protect against torn pages. For random-access OLTP, many modifications are first touches, so WAL is commonly 2–5x the logical change. It matters because WAL drives archive storage, replica bandwidth, checkpoint frequency and how fast disks fill when a slot holds WAL back.

**Q: What headroom do you target, and why not run at 90%?**
A: I aim for peak CPU around 60–70% and enough spare capacity that losing one replica doesn't overload the others. Queueing theory makes latency grow sharply as utilization approaches 100%, so 90% average means a small spike becomes a latency cliff. Headroom also covers the months of growth while you build the next rung, and cold-cache or failover periods when load per node is temporarily higher.

**Q: What's the danger of burst-credit storage or burstable instances for a database?**
A: They deliver high performance while credits last and then drop silently to a baseline. A database sized in testing against burst performance falls off a cliff after hours of sustained load — during a backfill, a traffic peak, or a replica rebuild. Commit latency climbs, Little's law inflates concurrency, and pools exhaust. Size for baseline, and if you use them at all, alert on the credit balance.

**Q: Walk through the 10M users / 100K DAU / 20K rps / 80:20 system and tell me whether you'd shard. (Senior)**
A: I first flag that 20K rps with 100K DAU implies machine traffic or a peak, and take 20K as planning peak with ~5K average. That's 16K read and 4K write requests/s at peak; at ~3 statements per read and 4 per write transaction, ~64K statements/s before caching, ~38K after a cache for sessions and entities, with 4K commits/s. Half of writes add a ~325 B row-plus-indexes and every write adds a ~210 B history row-plus-indexes, which at the 1K/s average gives ~38 GB/day including bloat — ~14 TB/year — and WAL around 2 KB per write, ~170 GB/day. The working set is ~70 GB, which fits a 256 GB node, and Little's law gives ~14 busy sessions on the primary. So writes use a fraction of one primary; reads go to cache plus two replicas; storage is the real pressure, solved by monthly partitioning and retention. I wouldn't shard, and I'd write down the triggers that would change that.

**Q: How would you validate a capacity model before trusting it for a year-ahead forecast? (Senior)**
A: Run the model with today's inputs and compare against today's measurements: CPU, busy sessions, statements/s by type, IOPS, WAL bytes/s, bytes/day per table. Every factor that disagrees by more than a few tens of percent gets replaced with a measured value — real bytes/row from `pg_table_size`, real statements per request from traces, real WAL per transaction from LSN diffs. Then I'd load test the planned configuration at planning peak with realistic data skew, because non-linear effects — lock contention, checkpoint spikes, cache warmup — don't appear in a spreadsheet. Finally, re-run quarterly with fresh numbers.

**Q: Your forecast says storage will outgrow a comfortable single node in 9 months, but CPU is at 30%. What do you do? (Senior)**
A: I'd treat it as a data-lifecycle problem before a scaling problem. I'd look at which tables grow and whether all of that data needs to be hot: event, log and history tables usually don't, so time-partitioning with retention and archiving to object storage or a warehouse can flatten growth. I'd also check bloat and index bloat, and whether some large JSON columns belong in object storage. If core entity data genuinely outgrows a node, restore time versus RTO becomes the deciding factor — the next rungs are a larger volume if backups and restores stay within objectives, then sharding by the dominant access key. CPU being at 30% tells me not to buy compute I don't need.

**Q: How do replicas change your capacity math?**
A: Replicas multiply storage and IOPS cost (each is a full copy and replays every write), add WAL-sender load on the primary, and change sizing because each replica needs the same working set as the reads it serves. For availability you size N+1: with two replicas, each must be able to carry all replica read traffic alone. They add read capacity but no write capacity.

## 10. Quick Revision & Cheat Sheet

| Quantity | Formula / rule of thumb |
|---|---|
| Average rps | DAU × requests/user/day ÷ 86,400 |
| Peak rps | average × peak factor (2–4 typical, 10+ for events) |
| DB statements/s | Σ(requests/s × statements/request) − cache hits |
| TPS | write requests/s (usually 1 txn each) |
| Row size (PG) | columns + alignment + ~24 B header + 4 B line pointer |
| Index entry | ~20–30 B for bigint/timestamp/UUID keys; 50–100% of heap is common |
| Storage/day | new rows/day × (row + index) × ~1.2 bloat, at average rate |
| WAL | ~2–5x logical change (FPIs); measure via LSN diff |
| Working set | hot rows + hot index pages; must fit buffers + page cache |
| Busy sessions | QPS × mean exec time (Little's law) |
| Pool size | busy × 2–3, near a small multiple of cores |
| CPU target | ≤ 60–70% at planning peak, N+1 for replicas |

- Always sanity-check inputs against each other (rps vs DAU).
- Statements, not requests, load the database.
- Throughput from peak, storage from average.
- Amplification (tuple overhead, indexes, WAL, replicas, backups) is where estimates go wrong.
- RAM is sized from the working set; watch hit ratio trends.
- Provision IOPS for baseline and cold-cache moments; never rely on burst credits.
- Pool connections; size server-side from Little's law.
- The architecture decision is the first resource to exceed one node at forecast peak plus headroom.

## 11. Hands-On Exercises

Lab: `docker run -d --name pg -e POSTGRES_PASSWORD=pg -p 5432:5432 postgres:17 -c shared_preload_libraries=pg_stat_statements`.

1. **Measure bytes per row.** Create the `items` table from the worked example, insert 1M rows with `generate_series`, and compute `pg_table_size/rows` and `pg_indexes_size/rows`. Reorder columns (widest first) and measure again to see padding.
2. **Measure WAL per transaction.** Record `pg_current_wal_lsn()`, run 100,000 single-row insert transactions with pgbench, and compute WAL bytes per transaction. Repeat right after a `CHECKPOINT` and again with `wal_compression = on`; compare.
3. **Little's law live.** Run `pgbench -c 32 -j 8 -T 120` against a select-only script and compute busy sessions from `pg_stat_statements` (total exec time ÷ wall time). Compare with sampled `count(*) FROM pg_stat_activity WHERE state = 'active'`.
4. **Working set cliff.** Set `shared_buffers = 128MB` and run a random PK lookup workload over a table that fits, then one 4x larger than shared_buffers (in a container with limited memory). Watch `blks_hit/(blks_hit+blks_read)` and latency.
5. **Build a capacity model.** Encode the 10M-user worked example in a Python script with every factor as a variable; change peak factor, statements per request and cache hit rate and see which resource becomes the first constraint.

**Mini project:** Take a real or hypothetical service, instrument statements per endpoint, collect a week of table-size snapshots and WAL rates, and produce a one-page capacity forecast with the first constraint, its date, and the rung you'd climb.

## 12. Related Topics & Free Learning Resources

**This handbook:** [Ch 02 · Storage Internals](topic.html?p=02-storage-internals) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) · [Ch 11 · Partitioning](topic.html?p=11-partitioning) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) · [Ch 21 · Database Scaling](topic.html?p=21-database-scaling) · [Ch 24 · Database Monitoring](topic.html?p=24-database-monitoring) · [Ch 26 · Backup & Disaster Recovery](topic.html?p=26-backup-disaster-recovery) · [Ch 28 · Data Lifecycle](topic.html?p=28-data-lifecycle)

**SQL Handbook:** [Indexes](../sql/topic.html?p=19-indexes) · [Data Types](../sql/topic.html?p=04-data-types) · [Partitioning](../sql/topic.html?p=23-partitioning)

**Other handbooks:** [System Design · Back-of-the-Envelope Estimation](../system-design/topic.html?p=02-capacity-estimation) · [System Design · Replication & Sharding](../system-design/topic.html?p=16-database-scaling) · [Cassandra · Capacity Planning & Sizing](../cassandra/topic.html?p=37-capacity-planning-sizing)

- **PostgreSQL Documentation — Resource Consumption** — PostgreSQL · *Intermediate* · shared_buffers, work_mem, maintenance_work_mem and their per-session semantics. <https://www.postgresql.org/docs/current/runtime-config-resource.html>
- **PostgreSQL Documentation — Database Page Layout** — PostgreSQL · *Advanced* · exact tuple header and page structure for row-size math. <https://www.postgresql.org/docs/current/storage-page-layout.html>
- **PostgreSQL Documentation — WAL Configuration** — PostgreSQL · *Advanced* · checkpoints, max_wal_size and full-page writes, the inputs to WAL sizing. <https://www.postgresql.org/docs/current/wal-configuration.html>
- **HikariCP — About Pool Sizing** — Brett Wooldridge · *Intermediate* · why smaller pools are faster and the cores-based starting formula. <https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing>
- **Amazon EBS volume types** — AWS · *Intermediate* · current gp3/io2 baselines, provisioning limits and burst behaviour. <https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volume-types.html>
- **Designing Data-Intensive Applications, ch. 1** — Martin Kleppmann · *Intermediate* · describing load and performance with percentiles, the vocabulary of capacity planning. <https://dataintensive.net/>
- **Google SRE Book — Software Engineering in SRE (capacity planning) and Handling Overload** — Google · *Advanced* · demand forecasting and headroom in practice. <https://sre.google/sre-book/handling-overload/>

---

*Database Design Handbook — chapter 22.*
