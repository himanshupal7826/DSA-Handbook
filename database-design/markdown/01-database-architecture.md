# 01 · Database Architecture: Inside the Engine

> **In one line:** A database is not one thing but a pipeline of cooperating components — query engine, buffer manager, transaction manager, WAL and storage — and you cannot reason about why it is slow, why it lost data or why it will not scale until you can trace one request through every one of them.

---

## 1. Overview

> **Builds on:** [SQL Handbook · Execution: Nested Loop, Hash & Merge Joins](../sql/topic.html?p=22-execution-plans) (how to read a plan) · [SQL Handbook · Transactions & ACID](../sql/topic.html?p=25-transactions-acid) (what COMMIT promises). This chapter assumes both and opens the box: which process runs your query, where the page it reads lives, and what physically happens between `COMMIT` and "OK".

Most developers meet the database as a network endpoint that accepts SQL and returns rows. That abstraction is wonderful until the day something goes wrong: p99 latency triples after a deploy, a replica falls ten minutes behind, the disk fills with files named `000000010000A3F2000000B7`, or 400 connections pile up and the whole cluster stops answering. Every one of those incidents is a symptom of a *specific component* misbehaving — the planner, the buffer pool, the checkpointer, the WAL, the connection model. If you only know "the database", you can only guess. If you know the components, you can go straight to the one that is hurting.

The naive mental model — "SQL goes in, the database reads the table from disk, rows come out" — fails in three important ways. First, the database almost never reads the table from disk on the hot path; it reads **pages** from an in-memory **buffer pool**, and whether a query takes 0.2 ms or 20 ms is mostly a question of whether those pages were cached. Second, a write does not "update the table on disk" when you commit; it appends a record to a sequential **write-ahead log**, flushes that, and leaves the actual data page dirty in memory to be written minutes later by a background process. Third, the SQL text you send is not executed as written; it is parsed, rewritten, and turned into a **plan** by a cost-based optimizer using statistics that may be stale, and the plan — not your SQL — determines the work done.

This handbook's thesis is that you design data systems from workload, access patterns, consistency, concurrency, scale and failure. All six of those land on the components in this chapter. Concurrency lands on the transaction and lock managers (chapters 03–06). Durability and failure land on the WAL and recovery (chapters 07–08). Scale lands first on memory and the buffer pool, then on the process model and connections (chapter 20), and only then on replication and sharding. So before optimizing or scaling anything, learn the machine.

> **Why this matters:** "Add an index", "add a replica", "add more connections" are the three most common reflex fixes — and each one makes a different component *worse* when applied to the wrong bottleneck. The architecture is how you tell which bottleneck you have.

## 2. Core Concepts

- **Query engine (the "upper half")** — parser, analyzer, rewriter, planner/optimizer and executor. Turns SQL text into a tree of physical operators and runs it. *Why it matters:* the plan decides how many pages get touched; most "slow query" work happens here.
- **Parser / analyzer** — checks syntax, then resolves names against the system catalogs (`pg_class`, `pg_attribute`) to produce a query tree. *Why it matters:* catalog lookups are cached per backend; thousands of tables or partitions inflate per-connection memory.
- **Rewriter** — expands views and applies rules (and row-level security policies). *Why it matters:* a "simple" query on a view may be a 12-way join after rewriting.
- **Planner / optimizer** — enumerates access paths and join orders, costs them from statistics (`pg_statistic`, collected by `ANALYZE`) and picks the cheapest. *Why it matters:* a wrong row estimate produces a plan that is correct but catastrophically slow.
- **Executor** — runs the plan as a tree of iterators (the **Volcano model**): each node asks its child for the next tuple. *Why it matters:* it is where `work_mem` is consumed, sorts spill to disk, and rows are fetched through the buffer manager.
- **Storage engine (the "lower half")** — access methods (heap, B-tree, GIN…), buffer manager, transaction manager, lock manager, WAL and the storage manager that talks to files. *Why it matters:* this is where durability, isolation and I/O cost actually live.
- **Buffer pool (`shared_buffers`)** — a shared-memory array of 8 KB page slots caching table and index pages. *Why it matters:* a cache hit costs on the order of a microsecond; a miss costs an OS call and possibly a device read.
- **Transaction manager** — assigns transaction IDs, records commit/abort status (PG: `pg_xact`, a.k.a. CLOG), and hands out snapshots. *Why it matters:* it is the foundation of MVCC visibility (chapter 03).
- **Lock manager** — heavyweight locks on tables, rows-in-waiting, advisory keys; plus lightweight locks (LWLocks) and spinlocks protecting shared memory. *Why it matters:* contention here shows up as `wait_event_type = Lock` or `LWLock` in `pg_stat_activity`.
- **WAL (write-ahead log)** — the sequential, append-only record of every change; flushed at commit. *Why it matters:* durability, crash recovery, replication and point-in-time recovery all derive from it (chapter 07).
- **Storage layer** — files on a filesystem: one file (in 1 GB segments) per table/index "fork", plus WAL segment files (16 MB by default). *Why it matters:* the OS page cache, filesystem and device characteristics sit underneath everything.
- **Process model** — how client connections map to OS processes or threads. PostgreSQL forks one backend process per connection; MySQL runs one thread per connection inside one process. *Why it matters:* it sets the cost of a connection and the ceiling on how many you can have (chapter 20).
- **Background workers** — checkpointer, background writer, WAL writer, autovacuum, archiver, WAL sender. *Why it matters:* much of the database's I/O is done by processes that are not running any client's query, and they can be the bottleneck.

## 3. Theory & Principles

### Two halves, one contract

Every serious relational engine — PostgreSQL, MySQL/InnoDB, SQL Server, Oracle — splits into a **query engine** that knows about SQL and relations, and a **storage engine** that knows about pages, logs and locks. The contract between them is roughly "give me the next tuple from this relation / this index range, visible to this snapshot" and "insert/update/delete this tuple under this transaction". PostgreSQL formalised the table side of that contract in version 12 as the **table access method** API (the default AM is `heap`); MySQL made it the defining feature of its architecture with the **pluggable storage engine** API (InnoDB, MyISAM, MyRocks…).

The split exists because the two halves change for different reasons. The optimizer evolves with SQL features and statistics; the storage layer evolves with hardware (spinning disks → SSD → NVMe → cloud block storage). Keeping them apart lets each evolve, and it is the reason you can reason about them separately: a bad plan is a query-engine problem; a slow commit is a storage-engine problem.

### The query engine, stage by stage

1. **Parse.** The SQL string is tokenised and parsed into a *raw parse tree*. Pure syntax; no catalog access. A typo fails here.
2. **Analyze.** Table and column names are resolved against the catalogs, types are checked and functions/operators chosen. Output: a *query tree*. Permission checks begin here.
3. **Rewrite.** Views are replaced by their definitions, rules are applied, and RLS policies are added as extra quals. The rewriter can turn one query into several.
4. **Plan.** The optimizer generates candidate paths — sequential scan, index scan, index-only scan, bitmap scan for each relation; nested loop, hash or merge join for each pair ([SQL Handbook · Execution Plans](../sql/topic.html?p=22-execution-plans) covers these) — and costs each using `seq_page_cost` (1.0), `random_page_cost` (4.0 by default), `cpu_tuple_cost` and row estimates from statistics. With many tables in `FROM` (≥ `geqo_threshold`, default 12) PostgreSQL switches from exhaustive search to a genetic optimizer.
5. **Execute.** The executor walks the plan tree. Leaf nodes (scans) call into the access methods, which call the buffer manager for pages; inner nodes (joins, sorts, aggregates) consume tuples from children. Results stream back to the client over the wire protocol as they are produced.

With the **extended query protocol** (what every driver uses for parameterised queries) steps 1–3 happen at `Parse`, and a prepared statement can reuse its plan. PostgreSQL builds *custom* plans for the first five executions and then may switch to a cached *generic* plan if it is not much worse — controlled by `plan_cache_mode`. That is why a prepared statement can suddenly get slower on its sixth run for a skewed parameter.

### The storage engine: buffer, transaction, WAL, files

When a scan needs block 42 of `orders`, it asks the **buffer manager**. The buffer manager hashes `(relation, fork, block)` into a lookup table; on a hit it *pins* the buffer (so it cannot be evicted while in use) and returns it. On a miss it picks a victim slot using the **clock-sweep** algorithm (each buffer has a small usage counter that the sweep decrements; a buffer at zero is evicted), writes the victim out first if it is dirty, and issues a `read()` to the OS for the 8 KB block. The OS may serve that read from its own page cache — PostgreSQL deliberately relies on the OS cache as a second tier, which is why `shared_buffers` is typically set to around a quarter of RAM rather than most of it, and why `effective_cache_size` exists as a *hint* to the planner about how much total caching to expect.

Every change to a page follows the **WAL rule**: first build a WAL record describing the change and insert it into the in-memory **WAL buffers**, then modify the page and mark it dirty, stamping the page with the log sequence number (**LSN**) of that record. The buffer manager will refuse to write a dirty page to disk until the WAL up to that page's LSN has been flushed. This one ordering constraint is what makes crash recovery possible (chapter 07).

At `COMMIT`, the transaction manager writes a **commit record** into the WAL and — with `synchronous_commit = on` — waits until the WAL has been flushed (`fsync`/`fdatasync`) up to that record's LSN. Then it marks the transaction committed in `pg_xact`, releases its locks and returns success. Notice what did *not* happen: none of the modified table or index pages were written to their data files. They are still dirty in shared buffers. They will be written later by the **background writer** (trickling dirty buffers out so backends rarely have to) and by the **checkpointer** (which periodically flushes *all* dirty buffers so that recovery never needs WAL older than the last checkpoint; `checkpoint_timeout` 5 min, `max_wal_size` 1 GB by default).

```svg
<svg viewBox="0 0 880 560" width="100%" height="560" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c01a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c01b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
    <marker id="c01c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">PostgreSQL engine: the components one query touches</text>

  <rect x="20" y="40" width="130" height="44" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="85" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Client / driver</text>
  <text x="85" y="75" text-anchor="middle" fill="#334155" font-size="9">SQL over TCP (5432)</text>
  <path d="M152,62 L196,62" stroke="#2563eb" stroke-width="2" marker-end="url(#c01a)"/>

  <rect x="198" y="36" width="662" height="160" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="529" y="56" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Backend process (one per connection) — QUERY ENGINE</text>
  <rect x="214" y="70" width="110" height="46" rx="6" fill="#fff" stroke="#2563eb"/><text x="269" y="90" text-anchor="middle" fill="#1e293b" font-weight="bold">Parser</text><text x="269" y="105" text-anchor="middle" fill="#334155" font-size="9">raw parse tree</text>
  <path d="M326,93 L344,93" stroke="#2563eb" stroke-width="2" marker-end="url(#c01a)"/>
  <rect x="346" y="70" width="110" height="46" rx="6" fill="#fff" stroke="#2563eb"/><text x="401" y="90" text-anchor="middle" fill="#1e293b" font-weight="bold">Analyzer</text><text x="401" y="105" text-anchor="middle" fill="#334155" font-size="9">catalog lookup</text>
  <path d="M458,93 L476,93" stroke="#2563eb" stroke-width="2" marker-end="url(#c01a)"/>
  <rect x="478" y="70" width="110" height="46" rx="6" fill="#fff" stroke="#2563eb"/><text x="533" y="90" text-anchor="middle" fill="#1e293b" font-weight="bold">Rewriter</text><text x="533" y="105" text-anchor="middle" fill="#334155" font-size="9">views, rules, RLS</text>
  <path d="M590,93 L608,93" stroke="#2563eb" stroke-width="2" marker-end="url(#c01a)"/>
  <rect x="610" y="70" width="110" height="46" rx="6" fill="#fff" stroke="#2563eb"/><text x="665" y="90" text-anchor="middle" fill="#1e293b" font-weight="bold">Planner</text><text x="665" y="105" text-anchor="middle" fill="#334155" font-size="9">cost + statistics</text>
  <path d="M722,93 L740,93" stroke="#2563eb" stroke-width="2" marker-end="url(#c01a)"/>
  <rect x="742" y="70" width="106" height="46" rx="6" fill="#fff" stroke="#2563eb"/><text x="795" y="90" text-anchor="middle" fill="#1e293b" font-weight="bold">Executor</text><text x="795" y="105" text-anchor="middle" fill="#334155" font-size="9">iterator tree</text>
  <text x="214" y="140" fill="#1e40af" font-size="10">Private memory: work_mem (sorts, hashes — per node!), temp_buffers, catalog &amp; plan caches</text>
  <text x="214" y="158" fill="#1e40af" font-size="10">Access methods: heap AM (tables), nbtree / GIN / GiST / BRIN (indexes)</text>
  <text x="214" y="176" fill="#1e40af" font-size="10">Transaction manager: xid assignment, snapshots · Lock manager: heavyweight locks + LWLocks</text>
  <path d="M795,118 L795,222" stroke="#2563eb" stroke-width="2" marker-end="url(#c01a)"/>
  <text x="802" y="212" fill="#1e40af" font-size="9">get page</text>

  <rect x="198" y="226" width="662" height="120" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="529" y="246" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">SHARED MEMORY (all backends + background processes)</text>
  <rect x="214" y="258" width="250" height="76" rx="6" fill="#fff" stroke="#d97706"/>
  <text x="339" y="278" text-anchor="middle" fill="#1e293b" font-weight="bold">Buffer pool — shared_buffers</text>
  <text x="339" y="294" text-anchor="middle" fill="#334155" font-size="9">8 KB page slots, clock-sweep eviction</text>
  <text x="339" y="308" text-anchor="middle" fill="#334155" font-size="9">dirty pages stamped with LSN</text>
  <text x="339" y="322" text-anchor="middle" fill="#334155" font-size="9">default 128 MB (tune ~25% RAM)</text>
  <rect x="478" y="258" width="170" height="76" rx="6" fill="#fff" stroke="#d97706"/>
  <text x="563" y="278" text-anchor="middle" fill="#1e293b" font-weight="bold">WAL buffers</text>
  <text x="563" y="294" text-anchor="middle" fill="#334155" font-size="9">records appended here first</text>
  <text x="563" y="308" text-anchor="middle" fill="#334155" font-size="9">flushed at COMMIT</text>
  <rect x="662" y="258" width="186" height="76" rx="6" fill="#fff" stroke="#d97706"/>
  <text x="755" y="278" text-anchor="middle" fill="#1e293b" font-weight="bold">Lock table, pg_xact,</text>
  <text x="755" y="294" text-anchor="middle" fill="#1e293b" font-weight="bold">proc array</text>
  <text x="755" y="310" text-anchor="middle" fill="#334155" font-size="9">who holds what; which xids</text>
  <text x="755" y="324" text-anchor="middle" fill="#334155" font-size="9">are running / committed</text>

  <rect x="20" y="226" width="160" height="212" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="100" y="246" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Background</text>
  <text x="100" y="262" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">processes</text>
  <text x="32" y="286" fill="#5b21b6" font-size="10">postmaster (parent)</text>
  <text x="32" y="304" fill="#5b21b6" font-size="10">checkpointer</text>
  <text x="32" y="322" fill="#5b21b6" font-size="10">background writer</text>
  <text x="32" y="340" fill="#5b21b6" font-size="10">WAL writer</text>
  <text x="32" y="358" fill="#5b21b6" font-size="10">autovacuum launcher</text>
  <text x="32" y="376" fill="#5b21b6" font-size="10">  + workers</text>
  <text x="32" y="394" fill="#5b21b6" font-size="10">archiver, walsender</text>
  <text x="32" y="412" fill="#5b21b6" font-size="10">logical repl launcher</text>
  <path d="M182,300 L196,300" stroke="#7c3aed" stroke-width="2" marker-end="url(#c01c)"/>

  <path d="M339,336 L339,388" stroke="#d97706" stroke-width="2" marker-end="url(#c01b)"/>
  <text x="346" y="366" fill="#92400e" font-size="9">miss: read() · evict/flush dirty</text>
  <path d="M563,336 L563,388" stroke="#d97706" stroke-width="2" marker-end="url(#c01b)"/>
  <text x="570" y="366" fill="#92400e" font-size="9">write + fsync at commit</text>

  <rect x="198" y="390" width="662" height="48" rx="10" fill="#f1f5f9" stroke="#94a3b8" stroke-width="2"/>
  <text x="529" y="410" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">OS page cache (second cache tier) + filesystem</text>
  <text x="529" y="428" text-anchor="middle" fill="#334155" font-size="10">a PG "read" may be a memory copy from here, not a device I/O</text>

  <rect x="198" y="454" width="320" height="90" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="358" y="474" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Data files: base/&lt;db oid&gt;/&lt;relfilenode&gt;</text>
  <text x="214" y="494" fill="#166534" font-size="10">main fork (heap / index pages), 1 GB segments</text>
  <text x="214" y="510" fill="#166534" font-size="10">_fsm (free space map) · _vm (visibility map)</text>
  <text x="214" y="526" fill="#166534" font-size="10">written LAZILY by bgwriter + checkpointer</text>
  <rect x="540" y="454" width="320" height="90" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="700" y="474" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">pg_wal/ — WAL segments (16 MB)</text>
  <text x="556" y="494" fill="#7f1d1d" font-size="10">sequential appends, fsynced at COMMIT</text>
  <text x="556" y="510" fill="#7f1d1d" font-size="10">source of recovery, replication, PITR</text>
  <text x="556" y="526" fill="#7f1d1d" font-size="10">recycled after checkpoint (unless a slot holds it)</text>
  <path d="M358,440 L358,452" stroke="#94a3b8" stroke-width="2"/>
  <path d="M700,440 L700,452" stroke="#94a3b8" stroke-width="2"/>
</svg>
```

### Memory versus disk: the numbers that shape every design

The architecture exists to hide one brutal fact: the gap between memory and durable storage. Keep these orders of magnitude in your head (they vary by hardware, so treat them as scale, not spec):

| Operation | Rough latency | Relative to a buffer hit |
|---|---|---|
| Find a page in `shared_buffers` (hit) | well under a microsecond to a few µs | 1× |
| Copy a page from the OS page cache | a few µs | ~5–10× |
| Random 8 KB read, local NVMe SSD | on the order of 10–100 µs | ~100× |
| Random read, cloud network block storage (e.g. EBS) | on the order of 0.5–1+ ms | ~1,000× |
| Random read, spinning disk | ~5–10 ms (a seek) | ~10,000× |
| WAL `fsync` on a device with power-loss-protected cache | tens of µs to ~1 ms | — |
| Network round trip app ↔ DB in one AZ | on the order of 0.1–0.5 ms | — |

Two lessons fall out. First, **the working set is everything**: a database whose hot pages fit in memory behaves like an in-memory system, and one whose hot pages do not fit is suddenly 100–1000× slower per page on the misses. Second, **durability is paid per commit, not per row**: the only synchronous disk I/O on a normal write path is the WAL flush, which is sequential and can be shared by many concurrent commits (**group commit**). That is why batching many rows into one transaction is dramatically faster than autocommitting each one, and why `synchronous_commit` is the single biggest durability-vs-latency knob.

## 4. Architecture & Workflow

### The PostgreSQL process model

When you start PostgreSQL you start one process — historically called the **postmaster** (it appears as `postgres` in `ps`). It allocates shared memory, starts the background processes, and then listens on the port. For every incoming connection it `fork()`s a new **backend** process that authenticates the client and then serves that one connection for its whole life. Backends communicate only through shared memory (buffers, WAL buffers, lock table, proc array) and signals/latches.

```text
$ ps -o pid,cmd --ppid $(head -1 $PGDATA/postmaster.pid)
  PID CMD
   52 postgres: checkpointer
   53 postgres: background writer
   55 postgres: walwriter
   56 postgres: autovacuum launcher
   57 postgres: logical replication launcher
  811 postgres: app shop 10.0.3.14(51234) idle
  812 postgres: app shop 10.0.3.14(51240) SELECT
  813 postgres: app shop 10.0.3.15(40112) idle in transaction
  902 postgres: autovacuum worker shop
```

Each background process owns one job:

- **Checkpointer** — at every checkpoint, writes all dirty buffers to the data files (spread over `checkpoint_completion_target`, default 0.9 of the interval), fsyncs them, and records a checkpoint so older WAL can be recycled.
- **Background writer** — continuously writes *some* dirty buffers ahead of the clock-sweep so that backends looking for a free buffer rarely have to write one themselves.
- **WAL writer** — flushes WAL buffers periodically (`wal_writer_delay`, 200 ms), which matters mainly for asynchronous commits.
- **Autovacuum launcher + workers** — the launcher wakes every `autovacuum_naptime` (1 min) and starts up to `autovacuum_max_workers` (3) workers to vacuum and analyze tables that crossed their thresholds (chapter 03).
- **Archiver / WAL sender / WAL receiver** — ship completed WAL segments to an archive and stream WAL to replicas (chapters 09 and 26).
- (Before PG 15 there was also a *stats collector*; statistics now live in shared memory.)

The design choice — processes, not threads — buys isolation (a crashing backend cannot scribble on another's private memory; the postmaster notices and resets shared memory) at the price of a heavy connection: a `fork`, a few MB of private memory once catalog caches warm, and an entry in every shared structure sized by `max_connections` (default 100). That is why a PostgreSQL server with 5,000 direct connections is unhealthy even if they are mostly idle, and why a pooler such as PgBouncer is standard (chapter 20).

> **MySQL difference:** MySQL is a *single process* with **one thread per connection** (thread pooling exists in MySQL Enterprise, Percona Server and MariaDB). Its upper half — connection handling, parser, optimizer, the **binary log** — is the *server layer*; below it sits a **pluggable storage engine**, which since 5.5 defaults to **InnoDB**. InnoDB has its own **buffer pool** (`innodb_buffer_pool_size`, typically 50–75% of RAM on a dedicated host, because InnoDB usually bypasses the OS cache with `O_DIRECT`), its own **redo log** (the WAL equivalent), **undo tablespaces** for old row versions, a **doublewrite buffer** against torn pages, and background threads (page cleaners, purge threads, log writer). Because the binlog lives above the engine and the redo log inside it, a commit is an internal two-phase commit between them (chapter 07). The old query cache was removed in 8.0.

### One request, end to end: `UPDATE accounts SET balance = balance - 100 WHERE id = 42`

Follow a single autocommitted update through every layer. This is the sequence to replay in your head during an incident.

```text
t0   Client sends Parse/Bind/Execute over an existing connection (no fork: pool reused it)
t1   Backend: parse → analyze (look up "accounts" in catalog cache) → rewrite (no views)
t2   Planner: estimates id = 42 matches 1 row → Index Scan using accounts_pkey
t3   Transaction manager: first write in this txn → assign xid 9001
t4   Lock manager: ROW EXCLUSIVE lock on table accounts (does not block readers)
t5   Executor → nbtree: descend root → internal → leaf (3 buffer lookups, all hits)
t6   Executor → heap: fetch tuple at ctid (812,4) via buffer manager (hit)
t7   Row lock: set xmax = 9001 on old version (lock lives in the tuple, chapter 05)
t8   WAL: insert HEAP_UPDATE record into WAL buffers → LSN 3A/7F0012C8
t9   Heap: write NEW tuple version (balance - 100), same page if room → HOT update
t10  Buffer: page 812 marked dirty, page LSN = 3A/7F0012C8  (nothing on disk yet)
t11  COMMIT: insert commit record → flush WAL to ≥ its LSN (fsync; maybe grouped)
t12  pg_xact: mark xid 9001 committed · release locks · wake any waiters
t13  "UPDATE 1" returned to client
...  seconds later: bgwriter or checkpointer writes page 812 to base/16384/24576
...  meanwhile: WAL sender streams the same WAL records to replicas
```

The same journey as a picture — note that the only synchronous disk write on the commit path is the WAL flush:

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c01d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="c01e" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="c01f" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Lifecycle of one UPDATE: synchronous path vs deferred work</text>

  <text x="70" y="52" text-anchor="middle" fill="#1e293b" font-weight="bold">Client</text>
  <text x="210" y="52" text-anchor="middle" fill="#1e293b" font-weight="bold">Query engine</text>
  <text x="370" y="52" text-anchor="middle" fill="#1e293b" font-weight="bold">Buffer pool</text>
  <text x="530" y="52" text-anchor="middle" fill="#1e293b" font-weight="bold">WAL buffers</text>
  <text x="690" y="52" text-anchor="middle" fill="#1e293b" font-weight="bold">pg_wal (disk)</text>
  <text x="820" y="52" text-anchor="middle" fill="#1e293b" font-weight="bold">Data files</text>
  <line x1="70" y1="60" x2="70" y2="440" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="210" y1="60" x2="210" y2="440" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="370" y1="60" x2="370" y2="440" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="530" y1="60" x2="530" y2="440" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="690" y1="60" x2="690" y2="440" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="820" y1="60" x2="820" y2="440" stroke="#94a3b8" stroke-dasharray="4 3"/>

  <path d="M72,80 L206,80" stroke="#334155" stroke-width="1.5" marker-end="url(#c01d)"/><text x="140" y="74" text-anchor="middle" fill="#334155" font-size="9">UPDATE ... id=42</text>
  <rect x="150" y="88" width="120" height="30" rx="4" fill="#dbeafe" stroke="#2563eb"/><text x="210" y="102" text-anchor="middle" fill="#1e40af" font-size="9">parse · analyze</text><text x="210" y="113" text-anchor="middle" fill="#1e40af" font-size="9">rewrite · plan</text>
  <path d="M212,134 L366,134" stroke="#334155" stroke-width="1.5" marker-end="url(#c01d)"/><text x="290" y="128" text-anchor="middle" fill="#334155" font-size="9">pin index + heap pages</text>
  <path d="M368,150 L214,150" stroke="#16a34a" stroke-width="1.5" marker-end="url(#c01f)"/><text x="290" y="164" text-anchor="middle" fill="#15803d" font-size="9">hit (µs) — or miss → OS read</text>
  <path d="M212,186 L526,186" stroke="#334155" stroke-width="1.5" marker-end="url(#c01d)"/><text x="370" y="180" text-anchor="middle" fill="#334155" font-size="9">1. log the change (WAL record, LSN)</text>
  <path d="M212,212 L366,212" stroke="#334155" stroke-width="1.5" marker-end="url(#c01d)"/><text x="290" y="206" text-anchor="middle" fill="#334155" font-size="9">2. new tuple version</text>
  <rect x="320" y="218" width="100" height="22" rx="4" fill="#fef3c7" stroke="#d97706"/><text x="370" y="233" text-anchor="middle" fill="#92400e" font-size="9">page now DIRTY</text>
  <path d="M72,260 L206,260" stroke="#334155" stroke-width="1.5" marker-end="url(#c01d)"/><text x="140" y="254" text-anchor="middle" fill="#334155" font-size="9">COMMIT</text>
  <path d="M212,276 L526,276" stroke="#334155" stroke-width="1.5" marker-end="url(#c01d)"/><text x="370" y="270" text-anchor="middle" fill="#334155" font-size="9">commit record</text>
  <path d="M532,292 L686,292" stroke="#dc2626" stroke-width="2" marker-end="url(#c01e)"/><text x="610" y="286" text-anchor="middle" fill="#b91c1c" font-size="9">write + fsync</text>
  <rect x="560" y="298" width="180" height="22" rx="4" fill="#fee2e2" stroke="#dc2626"/><text x="650" y="313" text-anchor="middle" fill="#b91c1c" font-size="9">the ONLY synchronous disk wait</text>
  <path d="M688,334 L214,334" stroke="#16a34a" stroke-width="1.5" marker-end="url(#c01f)"/><text x="450" y="348" text-anchor="middle" fill="#15803d" font-size="9">flushed → mark committed in pg_xact, release locks</text>
  <path d="M208,362 L74,362" stroke="#16a34a" stroke-width="2" marker-end="url(#c01f)"/><text x="140" y="356" text-anchor="middle" fill="#15803d" font-size="9">UPDATE 1</text>

  <rect x="330" y="384" width="540" height="50" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="600" y="402" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">Later, asynchronously: bgwriter / checkpointer write the dirty page → data files</text>
  <text x="600" y="420" text-anchor="middle" fill="#5b21b6" font-size="10">WAL sender streams the same records to replicas · autovacuum later prunes the old version</text>
  <path d="M370,384 L370,372 L816,372 L816,436" stroke="#7c3aed" stroke-width="1.5" fill="none" stroke-dasharray="5 3"/>
</svg>
```

### Where each kind of problem lives

| Symptom | Component to suspect first | First place to look |
|---|---|---|
| One query slow, others fine | Planner (bad estimate, missing index) | `EXPLAIN (ANALYZE, BUFFERS)` |
| Everything slower after data grew | Buffer pool (working set > memory) | `pg_stat_database` hit ratio, `pg_stat_io` reads |
| Commits slow, reads fine | WAL flush / storage latency | `pg_stat_wal`, `wait_event = WALSync`/`WALWrite` |
| Periodic latency spikes every few minutes | Checkpointer I/O bursts | `pg_stat_checkpointer` (PG 17) / `pg_stat_bgwriter`, `log_checkpoints` |
| Many sessions "waiting", CPU idle | Lock manager | `pg_stat_activity.wait_event_type = 'Lock'`, `pg_blocking_pids()` |
| Tables growing though row count is flat | MVCC + autovacuum | `pg_stat_user_tables.n_dead_tup`, oldest `backend_xmin` |
| "too many connections" / memory pressure | Process model | `pg_stat_activity` count by state; add a pooler |

## 5. Implementation

### Simple example: watch the layers with EXPLAIN (ANALYZE, BUFFERS)

`BUFFERS` is the single most useful flag for connecting a plan to the storage engine: it tells you how many pages each node found in shared buffers (`hit`), had to ask the OS for (`read`), and dirtied or wrote.

```sql
CREATE TABLE accounts (id bigint PRIMARY KEY, owner text, balance numeric NOT NULL);
INSERT INTO accounts SELECT g, 'user'||g, 1000 FROM generate_series(1, 2000000) g;
VACUUM ANALYZE accounts;

-- Restart PostgreSQL (or use a fresh container) so the cache is cold, then:
EXPLAIN (ANALYZE, BUFFERS) SELECT balance FROM accounts WHERE id = 1234567;
```

```text
Index Scan using accounts_pkey on accounts  (cost=0.43..8.45 rows=1 width=6) (actual time=0.412..0.414 rows=1 loops=1)
  Index Cond: (id = 1234567)
  Buffers: shared read=4
Planning:
  Buffers: shared hit=58 read=12
Execution Time: 0.441 ms
```

Run it again immediately:

```text
Index Scan using accounts_pkey on accounts  (cost=0.43..8.45 rows=1 width=6) (actual time=0.018..0.019 rows=1 loops=1)
  Index Cond: (id = 1234567)
  Buffers: shared hit=4
Execution Time: 0.035 ms
```

Read those four buffers as architecture: three B-tree pages (root, one internal level, leaf) plus one heap page. The first run had to `read` them (served here by the OS cache, which is why it is still sub-millisecond); the second found them all in `shared_buffers`. Same plan, same SQL, an order of magnitude apart — entirely a buffer-pool effect. Note also `Planning: Buffers` — the planner itself reads catalog pages on a cold backend.

### Seeing the process model and background work

```sql
-- Who is connected and what each process is doing (backend_type distinguishes background processes)
SELECT pid, backend_type, state, wait_event_type, wait_event,
       now() - xact_start AS xact_age, left(query, 60) AS query
FROM pg_stat_activity
ORDER BY backend_type, xact_age DESC NULLS LAST;

-- Cache effectiveness per database (a "read" may still be an OS-cache hit)
SELECT datname, blks_hit, blks_read,
       round(100.0 * blks_hit / nullif(blks_hit + blks_read, 0), 2) AS hit_pct
FROM pg_stat_database WHERE datname = current_database();

-- PG 16+: I/O broken down by process type and context
SELECT backend_type, object, context, reads, writes, extends, hits, evictions
FROM pg_stat_io
WHERE reads > 0 OR writes > 0
ORDER BY writes DESC;

-- PG 17: checkpoint activity moved to its own view
SELECT num_timed, num_requested, write_time, sync_time, buffers_written
FROM pg_stat_checkpointer;

-- WAL volume and flush behaviour
SELECT wal_records, wal_fpi, pg_size_pretty(wal_bytes) AS wal, wal_buffers_full
FROM pg_stat_wal;
```

A healthy OLTP system usually shows a `hit_pct` well above 99%, `num_requested` checkpoints much smaller than `num_timed` (if requested dominates, `max_wal_size` is too small and checkpoints are being forced by WAL volume), and `pg_stat_io` writes done mostly by the checkpointer and background writer rather than by `client backend` — backends writing their own evictions is a sign the buffer pool is under pressure.

### Real-world example: a configuration baseline for a 64 GB OLTP server

The defaults ship for a tiny machine. A realistic starting point for a dedicated 16-vCPU / 64 GB host on NVMe or cloud block storage, with each setting tied to the component it tunes:

```ini
# --- Buffer pool / memory -----------------------------------------------
shared_buffers = 16GB              # ~25% RAM; the OS page cache is the second tier
effective_cache_size = 48GB        # planner HINT: shared_buffers + expected OS cache
work_mem = 32MB                    # per sort/hash NODE per backend — multiply before raising
maintenance_work_mem = 2GB         # VACUUM, CREATE INDEX

# --- Process model ------------------------------------------------------
max_connections = 300              # keep modest; put PgBouncer in front (chapter 20)

# --- WAL / checkpoints --------------------------------------------------
wal_buffers = -1                   # auto: 1/32 of shared_buffers, capped at one segment
max_wal_size = 16GB                # fewer, WAL-volume-forced checkpoints
checkpoint_timeout = 15min
checkpoint_completion_target = 0.9 # spread checkpoint writes
synchronous_commit = on            # durability knob (chapter 07)

# --- Planner cost model -------------------------------------------------
random_page_cost = 1.1             # SSD: random ≈ sequential; default 4.0 assumes spinning disks
effective_io_concurrency = 200     # SSD can serve many outstanding reads

# --- Background workers -------------------------------------------------
autovacuum_max_workers = 5
log_checkpoints = on
log_autovacuum_min_duration = 1s
```

The dangerous one is `work_mem`: it is allocated per sort or hash node, per backend, so a complex query with four hash joins on 200 active connections can in principle use `4 × 200 × 32 MB` ≈ 25 GB. The architecture — per-process private memory — is why you size it conservatively globally and raise it per session (`SET work_mem`) for known heavy reports.

> **MySQL difference:** the equivalent baseline is dominated by `innodb_buffer_pool_size` (often 70%+ of RAM), `innodb_redo_log_capacity` (8.0.30+, replaces `innodb_log_file_size`), `innodb_flush_log_at_trx_commit = 1` (full durability) and `sync_binlog = 1`, `innodb_io_capacity` for background flushing, and `innodb_flush_method = O_DIRECT` to avoid double caching. Because InnoDB clusters rows by primary key inside the buffer pool, the "working set" is measured in 16 KB pages of the clustered index.

## 6. Advantages, Disadvantages & Trade-offs

| Design choice | PostgreSQL | MySQL / InnoDB | Trade-off |
|---|---|---|---|
| Connection model | Process per connection | Thread per connection | Processes isolate crashes; threads make connections cheaper. Both need pooling at scale. |
| Caching | `shared_buffers` + OS page cache (double buffering) | Large InnoDB buffer pool, usually `O_DIRECT` | PG is simpler to size conservatively; InnoDB controls its cache precisely. |
| Engine boundary | One storage engine, table-AM API (PG 12+) | Pluggable engines under one SQL layer | Pluggable = flexibility, but the binlog/redo split forces an internal 2PC on commit. |
| Old row versions | In the heap (needs VACUUM) | In undo logs (needs purge) | Chapter 03. |
| Durability path | WAL flush at commit | Redo flush (+ binlog flush) at commit | Both: one sequential fsync per commit group. |
| Plan caching | Per-backend, custom vs generic plans | Optimizer per execution (no plan cache for ad-hoc) | Cached plans save CPU; can lock in a bad generic plan. |

### When to use this knowledge (i.e., when to think at the component level)

- When diagnosing any latency regression: identify which layer the time is spent in before changing anything.
- When sizing hardware or cloud instances: memory for the working set, IOPS/latency for misses and WAL, CPU for planning and execution.
- When choosing between "add an index", "add memory", "add a replica", "add a pooler": each fixes a different component.
- When evaluating a new database (distributed SQL, NoSQL): ask the same questions — where is the log, where is the cache, how are connections served, what runs in the background.

### When NOT to go deep

- For a small application whose entire dataset fits comfortably in RAM with headroom, defaults plus sane indexes are fine; tuning checkpoints is premature.
- Do not tune by folklore ("set `shared_buffers` to 80%"). Every knob here trades one component's resources against another's; change one thing, measure with the views above.
- Do not replace engine behaviour with application cleverness (e.g. caching every row in the app to "save the database") before you know the buffer pool is the constraint.

## 7. Common Mistakes & Best Practices

1. **Treating "the database" as a black box.** People see a slow endpoint, add an index, and move on. It hurts because half of real incidents are not planner problems — they are checkpoint storms, lock queues or cache misses, and an extra index makes writes slower. Instead, attribute time to a component first: `wait_event` in `pg_stat_activity`, `BUFFERS` in `EXPLAIN`, `pg_stat_io`.
2. **Assuming COMMIT writes the table to disk.** Teams disable `fsync` or set `synchronous_commit = off` thinking they are "only skipping the data write". `fsync = off` risks *corruption* after a crash; `synchronous_commit = off` only risks losing the last few hundred ms of commits. Know which knob touches which component.
3. **Opening thousands of direct connections.** Because each PG connection is a process, 3,000 connections mean 3,000 processes contending for CPU, locks and memory. Use a pooler and size active connections to roughly a small multiple of CPU cores (chapter 20).
4. **Setting `work_mem` globally high.** It is per operation per backend; a burst of concurrent reports OOM-kills the server (and the OOM killer taking a backend forces the postmaster to restart all sessions). Keep it modest globally; raise per session.
5. **Reading `blks_read` as "disk reads".** It counts reads requested from the OS, many of which are OS cache hits. Use `pg_stat_io` read *time* (with `track_io_timing = on`) or OS metrics to see real device I/O.
6. **Ignoring the background processes.** A saturated checkpointer or an autovacuum worker stuck behind a lock causes problems that no query-level tuning fixes. Enable `log_checkpoints` and `log_autovacuum_min_duration`.
7. **Leaving `random_page_cost = 4` on SSDs.** The planner then overestimates index-scan cost and prefers sequential scans that are no longer cheaper. Set it near 1.1–1.5 on SSD/NVMe and verify with plans.

**Best practices:** keep the hot working set in memory and know its size; keep transactions short so background processes can do their jobs; put a pooler in front of PostgreSQL from day one; enable `track_io_timing`, `log_checkpoints`, `pg_stat_statements`; and change one knob at a time with a before/after measurement.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**The checkpoint sawtooth.** At 10:00, 10:05, 10:10 p99 write latency jumps from 5 ms to 150 ms for about a minute. Root cause: `max_wal_size` was left at 1 GB on a write-heavy system, so checkpoints were being *requested* by WAL volume every few minutes, each one flushing gigabytes of dirty pages and saturating the volume's IOPS just as foreground commits needed it; `full_page_writes` then inflated WAL right after each checkpoint. Symptom in metrics: `num_requested` climbing in `pg_stat_checkpointer`, `wal_fpi` spiking. Fix: raise `max_wal_size` and `checkpoint_timeout`, keep `checkpoint_completion_target = 0.9`, provision IOPS for the checkpoint write rate.

**The cache cliff.** A table that grew 3% a month crosses the point where its hot index no longer fits in memory. Overnight, the same query set generates 20× more device reads and p99 goes from 8 ms to 300 ms, with no deploy. Root cause: working set > `shared_buffers` + OS cache. Symptom: hit ratio dropping from 99.9% to 97% (which sounds small but means 30× more misses), rising `pg_stat_io` read time. Fix short-term: more RAM (scale up); long-term: partition or archive cold data, shrink indexes, fix bloat (chapters 02, 03, 28).

**The connection storm.** At 2 am an upstream timeout causes every app instance to retry and open new connections. PostgreSQL hits `max_connections`, new logins fail, and the ones that got in are fork-and-authenticate overhead plus lock contention. Root cause: no pooler, no connection limit in the app. Fix: PgBouncer in transaction mode, bounded pools per app instance, backoff on connect (chapter 20).

**The WAL disk fill.** `pg_wal` grows until the volume is full and PostgreSQL PANICs and stops. Root cause: an inactive replication slot (a decommissioned replica or a stopped CDC connector) is pinning WAL, or `archive_command` has been failing silently. Fix: monitor `pg_replication_slots` retained WAL, set `max_slot_wal_keep_size`, alert on archiver failures (`pg_stat_archiver.failed_count`).

### Metrics to watch (one per component)

| Component | Metric | Why |
|---|---|---|
| Query engine | `pg_stat_statements` total/mean time, calls | Which statements consume the engine |
| Buffer pool | hit ratio, `pg_stat_io` reads/evictions | Working-set health |
| WAL | `pg_stat_wal` bytes/s, `wal_fpi`, WALSync waits | Commit latency and replication/backup volume |
| Checkpointer | requested vs timed checkpoints, write/sync time | I/O bursts |
| Lock manager | sessions with `wait_event_type='Lock'` | Contention, queue incidents |
| Process model | connections by state; `idle in transaction` count | Pool sizing, leaks |
| Autovacuum | `n_dead_tup`, `last_autovacuum`, oldest xmin age | MVCC health |

### Scaling notes

The component view gives you the order to scale in: first make the plan efficient (query engine), then make the working set fit (memory, scale up), then reduce connection overhead (pooler), then provision I/O for WAL and checkpoints, and only then add read replicas or partitioning. Each later step adds operational complexity that earlier ones do not ([Ch 21 · Database Scaling](topic.html?p=21-database-scaling) walks that ladder).

## 9. Interview Questions

**Q: Walk me through what happens inside PostgreSQL when a client runs a SELECT by primary key?**
A: The backend serving that connection parses the SQL, resolves names against the catalogs, runs the rewriter (views, RLS), and the planner chooses an index scan on the primary key from its statistics. The executor then descends the B-tree — root, internal pages, leaf — asking the buffer manager for each page; hits are served from `shared_buffers`, misses go to the OS (possibly its page cache, possibly the device). The leaf gives a ctid, the executor fetches that heap page, checks the tuple's visibility against its snapshot, and streams the row back. Typically that is about four buffer accesses, which is why cache residency dominates the latency.

**Q: What actually happens on disk when you COMMIT an UPDATE?**
A: Only the WAL is forced to disk. The update already wrote a WAL record and modified the page in memory; at commit the backend appends a commit record and flushes WAL up to its LSN, then marks the transaction committed in `pg_xact`. The modified data page stays dirty in shared buffers and is written later by the background writer or checkpointer. If the server crashes before that, recovery replays the WAL to reconstruct the page, which is why the WAL flush alone is enough for durability.

**Q: Why does PostgreSQL use a process per connection, and what are the consequences?**
A: Historically for portability and robustness: a crash in one backend cannot corrupt another's private memory, and the postmaster can detect it and reset shared state. The cost is that each connection is an OS process with its own memory (catalog caches, `work_mem`) and a slot in shared structures sized by `max_connections`. Thousands of connections therefore create memory pressure and scheduler and lock-manager contention even when idle, so production systems put a pooler like PgBouncer in front and keep active connections near a small multiple of CPU cores.

**Q: What is the difference between shared_buffers and the OS page cache, and why does PostgreSQL rely on both?**
A: `shared_buffers` is PostgreSQL's own cache of 8 KB pages in shared memory, managed by clock-sweep and aware of dirty pages and WAL ordering. The OS page cache sits underneath and caches file blocks for any read the database issues. PostgreSQL uses buffered I/O and leans on the OS cache as a second tier, which is why `shared_buffers` is typically about 25% of RAM rather than most of it. The cost is some double buffering; the benefit is simpler, conservative sizing and good behaviour for sequential scans.

**Q: What do the checkpointer and background writer do, and how do they differ?**
A: Both write dirty buffers to data files, but for different reasons. The checkpointer periodically writes *all* dirty buffers and records a checkpoint so that crash recovery can start from there and older WAL can be recycled; it bounds recovery time and WAL retention. The background writer continuously writes *some* dirty buffers ahead of the eviction clock so that backends needing a free buffer rarely have to write one themselves. Checkpoint frequency is governed by `checkpoint_timeout` and `max_wal_size`; too-frequent checkpoints cause I/O storms and extra full-page writes.

**Q: How does the planner decide between an index scan and a sequential scan?**
A: It estimates the rows each predicate returns from statistics in `pg_statistic` and costs each path using `seq_page_cost`, `random_page_cost`, and CPU costs per tuple and operator. An index scan pays random page reads per matched row; a sequential scan pays cheaper sequential reads for every page. When the predicate is selective the index wins; when it matches a large fraction of the table the sequential scan does. Wrong statistics or a `random_page_cost` tuned for spinning disks on an SSD system lead it astray.

**Q: Where does a query spend memory, and why is work_mem dangerous?**
A: Shared memory holds the buffer pool, WAL buffers and lock tables, sized once at startup. Each backend also has private memory: catalog and plan caches, and `work_mem` for each sort, hash or materialize node in its plan. Because `work_mem` is per node per backend, one complex query can use several multiples of it, and hundreds of concurrent queries multiply that again. Setting it high globally is a classic way to trigger the OOM killer; set it modestly and raise it per session for known heavy queries.

**Q: How does MySQL's architecture differ from PostgreSQL's?**
A: MySQL is one process with a thread per connection, split into a server layer (connection handling, parser, optimizer, binary log) and a pluggable storage engine, InnoDB by default. InnoDB manages its own large buffer pool (usually with `O_DIRECT`), a redo log for durability, undo logs for old versions and rollback, and a doublewrite buffer against torn pages. Because the binlog belongs to the server layer and the redo log to the engine, each commit is an internal two-phase commit between them. PostgreSQL has one storage engine, uses the OS cache as a second tier, keeps old versions in the heap and has no undo log.

**Q: Latency on writes spikes every few minutes while reads are unaffected. How do you diagnose it? (Senior)**
A: Periodicity on the write path points at checkpoints. I would check `pg_stat_checkpointer` (or `pg_stat_bgwriter` pre-17) for requested versus timed checkpoints and write/sync times, enable `log_checkpoints` to correlate timestamps, and look at `pg_stat_wal` for full-page-image bursts right after each checkpoint. If checkpoints are WAL-volume-forced, raise `max_wal_size` and `checkpoint_timeout`, keep `checkpoint_completion_target` at 0.9, and make sure the volume has IOPS headroom for the flush. I would also confirm that backends are not doing their own evictions in `pg_stat_io`, which would mean the background writer is not keeping up.

**Q: A service's p99 degraded gradually over months with no code change. Which components do you investigate and in what order? (Senior)**
A: Gradual degradation without change is usually growth crossing a threshold. First the buffer pool: has the working set outgrown memory? Hit ratio and `pg_stat_io` read time will show it. Second MVCC health: bloat from autovacuum not keeping up or a long-lived transaction holding the xmin horizon inflates tables and indexes and so the working set. Third the planner: statistics drift can flip plans, so compare `pg_stat_statements` mean times and plans over time. Only after those would I look at hardware or the need to scale out, because the first three are cheaper to fix.

**Q: Design the monitoring you would put on a new PostgreSQL cluster, organised by component. (Senior)**
A: For the query engine, `pg_stat_statements` top-N by total time and mean time regressions. For the buffer pool, hit ratio and `pg_stat_io` reads, evictions and backend writes. For WAL, bytes per second, full-page images and WALSync wait time, plus replication lag and slot retention. For checkpoints, requested versus timed and write time. For locks, count of sessions waiting on `Lock` and the longest wait, and for connections, counts by state with an alert on long `idle in transaction`. For MVCC, dead tuples, last autovacuum per hot table and oldest xmin/XID age. Each metric maps to one component, so an alert points you at the right subsystem.

**Q: If you set synchronous_commit = off, what can you lose and what can you not lose? (Senior)**
A: Commits return before their WAL is flushed; the WAL writer flushes it shortly after, so a crash can lose roughly the last few hundred milliseconds of transactions that clients were told had committed. What you cannot get is corruption or a partially applied transaction: the WAL-before-data rule still holds, so recovery produces a consistent state as of some slightly earlier point. That makes it a reasonable per-transaction choice for low-value writes like analytics events, but not for payments. It is very different from `fsync = off`, which can corrupt the cluster after an OS crash.

## 10. Quick Revision & Cheat Sheet

| Component | Job | Key knobs / views |
|---|---|---|
| Parser / analyzer / rewriter | SQL → query tree; resolve names, expand views | catalog caches |
| Planner | choose cheapest plan from statistics | `random_page_cost`, `ANALYZE`, `plan_cache_mode` |
| Executor | run the iterator tree | `work_mem`, `EXPLAIN (ANALYZE, BUFFERS)` |
| Buffer manager | cache 8 KB pages, clock-sweep | `shared_buffers`, `pg_stat_io`, hit ratio |
| Transaction manager | xids, snapshots, commit status | `pg_xact`, `pg_stat_activity.backend_xmin` |
| Lock manager | heavyweight locks + LWLocks | `pg_locks`, `wait_event_type` |
| WAL | durable sequential log, flushed at commit | `synchronous_commit`, `pg_stat_wal` |
| Checkpointer / bgwriter | write dirty pages lazily | `max_wal_size`, `checkpoint_timeout`, `pg_stat_checkpointer` |
| Autovacuum | clean up old versions | `autovacuum_*`, `n_dead_tup` |
| Process model | one backend per connection | `max_connections`, pooler |

**Remember this**
- The query engine decides *how much* work; the storage engine decides *how expensive* each unit of work is.
- A buffer hit is on the order of 100–1000× cheaper than a device read; the working set fitting in memory is the first scaling law.
- COMMIT flushes only the WAL; data pages are written later by background processes.
- WAL rule: log record flushed before the data page it describes can be written.
- PostgreSQL = process per connection + shared memory; MySQL = thread per connection + pluggable engine (InnoDB).
- `work_mem` is per operation per backend — multiply before you raise it.
- Periodic write spikes → checkpoints; waiting sessions with idle CPU → locks; gradual decay → working set or bloat.
- Diagnose by component before you add an index, a replica or connections.

## 11. Hands-On Exercises

Start a lab: `docker run -d --name pg -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:17` then `docker exec -it pg psql -U postgres`.

1. **Map the processes.** Run `docker exec pg ps aux` and match every `postgres:` process to its role. Open two psql sessions, start `BEGIN; SELECT 1;` in one, and find it as `idle in transaction` in `pg_stat_activity`.
2. **Cold vs warm cache.** Create the 2M-row `accounts` table from §5, restart the container (`docker restart pg`), and run the same `EXPLAIN (ANALYZE, BUFFERS)` twice. Record `read` vs `hit` counts and execution times.
3. **Commit cost.** Using `pgbench -i -s 20` and then `pgbench -c 8 -T 30` compare TPS with `synchronous_commit = on` vs `off` (`ALTER SYSTEM SET ... ; SELECT pg_reload_conf();`). Explain the gap in terms of WAL flushes.
4. **Force checkpoints.** Set `max_wal_size = '64MB'`, run pgbench for two minutes with `log_checkpoints = on`, and read the log: how many checkpoints were "requested" (WAL) vs "time"? Then set it back to `4GB` and compare.
5. **Who writes the pages?** Before and after a pgbench run, snapshot `pg_stat_io` and compute which `backend_type` performed the writes. Shrink `shared_buffers` to `32MB` (restart required) and repeat — watch `client backend` writes appear.

### Mini project — "Trace a request"

Build a one-page runbook for your team's main database: for one critical endpoint, record its top 3 SQL statements (from `pg_stat_statements`), their plans with buffer counts, the working-set estimate for the tables they touch (`pg_relation_size` of the hot indexes vs `shared_buffers`), the commit latency (pgbench or app metrics), and the checkpoint/WAL profile. Then write, per component, "what we would see if this component were the bottleneck" and the query that shows it. Extension: repeat the exercise on MySQL 8 with `EXPLAIN ANALYZE`, `performance_schema` and `SHOW ENGINE INNODB STATUS`.

## 12. Related Topics & Free Learning Resources

**In this handbook:** [Ch 02 · Storage Internals](topic.html?p=02-storage-internals) (pages, heaps and B-trees under the buffer pool) · [Ch 03 · MVCC](topic.html?p=03-mvcc) (what the transaction manager's snapshots do) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (the lock manager) · [Ch 07 · Write-Ahead Logging](topic.html?p=07-write-ahead-logging) (the commit path in depth) · [Ch 08 · Crash Recovery](topic.html?p=08-crash-recovery) · [Ch 20 · Database + Application](topic.html?p=20-database-application-architecture) (pools and the process model) · [Ch 23 · Bottleneck Diagnosis](topic.html?p=23-bottleneck-diagnosis).

**SQL Handbook:** [Execution Plans](../sql/topic.html?p=22-execution-plans) · [Query Optimization](../sql/topic.html?p=21-query-optimization) · [Transactions & ACID](../sql/topic.html?p=25-transactions-acid).

**Other handbooks:** [System Design · Indexing & Storage Engines](../system-design/topic.html?p=15-indexing-storage-engines) · [Cassandra · Write Path](../cassandra/topic.html?p=21-write-path) (a very different engine for contrast).

- **The Internals of PostgreSQL** — Hironobu Suzuki · *Intermediate* · free online book covering process architecture, buffer manager, WAL and more, with diagrams. <https://www.interdb.jp/pg/>
- **PostgreSQL docs — Overview of PostgreSQL Internals** — PostgreSQL · *Beginner* · the official path of a query: parser, rewriter, planner, executor. <https://www.postgresql.org/docs/current/overview.html>
- **Architecture of a Database System** — Hellerstein, Stonebraker, Hamilton · *Advanced* · the classic survey of process models, query processing and storage managers. <https://dsf.berkeley.edu/papers/fntdb07-architecture.pdf>
- **CMU 15-445/645 Intro to Database Systems** — Andy Pavlo, CMU · *Intermediate* · free lectures on buffer pools, storage, execution and concurrency. <https://15445.courses.cs.cmu.edu/>
- **MySQL docs — The InnoDB Storage Engine: Architecture** — Oracle · *Intermediate* · buffer pool, redo, undo, doublewrite, change buffer in one diagram. <https://dev.mysql.com/doc/refman/8.0/en/innodb-architecture.html>
- **PostgreSQL docs — Resource Consumption settings** — PostgreSQL · *Intermediate* · the authoritative meaning of shared_buffers, work_mem and friends. <https://www.postgresql.org/docs/current/runtime-config-resource.html>
- **Designing Data-Intensive Applications, ch. 3** — Martin Kleppmann · *Intermediate* · storage and retrieval from first principles. <https://dataintensive.net/>

---

*Database Design Handbook — chapter 01.*
