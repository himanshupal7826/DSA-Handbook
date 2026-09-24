# 20 · Database + Application: Pools, Timeouts & Storms

> **In one line:** Most "database outages" are started by the application — too many connections, unbounded waits, synchronized retries, reconnect stampedes after a failover — so the database's real capacity is protected or destroyed by pool sizes, timeouts and retry policies that live in your service code, not in postgresql.conf.

---

## 1. Overview

A PostgreSQL server that handles 20,000 transactions per second on a benchmark can be brought to its knees by 3,000 connections doing nothing. A primary that fails over in 30 seconds can take 20 minutes to recover because 400 application pods reconnect at once and retry every failed request three times. A single slow reporting query can exhaust the connection pool that checkout depends on. None of these is a database bug. They are **application architecture** problems at the seam where many stateless, autoscaled processes meet one stateful, finitely-sized database.

The naive model is "the app sends queries, the database answers them; if it's slow, add a bigger database". It fails because the database's throughput is not a smooth function of the load you offer it. Past its saturation point, more concurrent work makes it **slower in total** — more context switches, more lock contention, more memory per backend, cache thrashing — and the extra waiting causes client timeouts, which cause retries, which add load. Throughput collapses precisely when demand peaks. The fix is not more database; it is **bounding and shaping the demand** the application places on it: a correct number of connections, queueing in the right place with a timeout, deadlines at every layer, retries that back off and give up, and isolation so one workload cannot starve another.

This chapter covers the application side of database load end to end: why PostgreSQL connections are expensive, the connection-budget arithmetic, PgBouncer and other poolers, what autoscaling does to that budget, backpressure, connection and retry storms, the full timeout stack, circuit breakers and bulkheads — with Go code you can lift into a service.

> **Builds on:** [SQL Handbook · Transactions & ACID](../sql/topic.html?p=25-transactions-acid) (what a transaction holds while it's open) · [Ch 01 · Database Architecture](topic.html?p=01-database-architecture) (postmaster, backends, shared memory) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) (lock queues, lock_timeout) · [Ch 18 · High Availability](topic.html?p=18-high-availability) (failover, which triggers connection storms). The generic resilience patterns are in [System Design · Resilience Patterns](../system-design/topic.html?p=27-resilience-patterns); this chapter applies them specifically to the database.

> **Why this matters:** "How many connections should your service open?" and "what happens to the DB when you scale from 20 to 200 pods?" are senior-level interview questions because the answer requires arithmetic, not a buzzword.

## 2. Core Concepts

- **Backend process** — PostgreSQL forks one OS process per client connection. *Why it matters:* connections cost memory, CPU for setup, and scheduler overhead; thousands of them hurt even when idle.
- **max_connections** — the hard cap on backends (default 100). *Why it matters:* the budget every application instance shares; exceeding it gives `FATAL: sorry, too many clients already`.
- **Connection pool (client-side)** — a set of reusable connections inside an app process (database/sql, pgxpool, HikariCP, SQLAlchemy). *Why it matters:* avoids per-request connects and bounds per-instance concurrency.
- **Connection pooler (server-side)** — a proxy that multiplexes many client connections onto few server connections (PgBouncer, pgcat, RDS Proxy, Odyssey, Supavisor). *Why it matters:* decouples the number of app instances from the number of backends.
- **Pool mode** — session, transaction or statement pooling in PgBouncer. *Why it matters:* transaction mode gives the best multiplexing but breaks session state.
- **Little's law** — `concurrency = throughput × latency`. *Why it matters:* tells you how many connections you actually need.
- **Backpressure** — making upstream callers wait or fail when a downstream is saturated, instead of queueing unboundedly. *Why it matters:* keeps the database at its efficient operating point.
- **Connection storm** — many clients opening connections at once (deploy, autoscale, failover). *Why it matters:* connection setup is expensive and can saturate the primary on its own.
- **Retry storm / retry amplification** — failed requests retried by many clients, often at several layers, multiplying load on an already struggling database.
- **Deadline / timeout stack** — client timeout → service deadline → driver context → `statement_timeout` / `lock_timeout` / `idle_in_transaction_session_timeout`. *Why it matters:* without it, a stuck query holds a connection (and locks) forever.
- **Circuit breaker** — stops calling a failing dependency for a cool-down period. *Why it matters:* converts slow failures into fast ones and gives the database room to recover.
- **Bulkhead** — separate, bounded resource pools per workload. *Why it matters:* a batch job can't consume checkout's connections.

## 3. Theory & Principles

### Why PostgreSQL connections are expensive

When a client connects, the postmaster **forks a new backend process**. That backend performs authentication (SCRAM-SHA-256 hashing, optionally TLS handshakes), loads catalog caches as it touches tables, and allocates private memory. A mostly idle backend uses a few MB of private memory; one that runs sorts and hashes can use many multiples of `work_mem` on top. Beyond memory, each backend is a process the kernel schedules, and several internal operations historically scaled with the number of connections — computing snapshots walked the array of all backends (significantly optimised in PostgreSQL 14, but active connections still contend for locks, buffer mappings and CPU).

So the cost has three parts:

1. **Setup cost:** fork + auth + TLS — on the order of milliseconds of CPU per connection. Harmless once; ruinous when 2,000 pods connect in the same second.
2. **Standing cost:** memory and kernel/process overhead per idle connection. Tolerable at hundreds; painful at thousands.
3. **Concurrency cost:** active backends beyond the number of CPU cores (and I/O channels) don't add throughput — they add contention and context switching, and they make every query slower.

The third is the one people miss. A 16-core database server doesn't run 500 queries in parallel; it time-slices them. Beyond a point (commonly a small multiple of core count for OLTP), adding active connections *reduces* total throughput.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Throughput vs active connections: the saturation cliff (illustrative, 16-core OLTP server)</text>
  <line x1="90" y1="360" x2="840" y2="360" stroke="#334155" stroke-width="1.5"/>
  <line x1="90" y1="360" x2="90" y2="50" stroke="#334155" stroke-width="1.5"/>
  <text x="465" y="392" text-anchor="middle" fill="#334155">active connections (concurrent queries)</text>
  <text x="40" y="205" text-anchor="middle" fill="#334155" transform="rotate(-90 40 205)">transactions/s</text>
  <text x="90" y="376" text-anchor="middle" fill="#64748b" font-size="9">0</text>
  <text x="190" y="376" text-anchor="middle" fill="#64748b" font-size="9">16</text>
  <text x="290" y="376" text-anchor="middle" fill="#64748b" font-size="9">32</text>
  <text x="390" y="376" text-anchor="middle" fill="#64748b" font-size="9">64</text>
  <text x="540" y="376" text-anchor="middle" fill="#64748b" font-size="9">200</text>
  <text x="690" y="376" text-anchor="middle" fill="#64748b" font-size="9">500</text>
  <text x="820" y="376" text-anchor="middle" fill="#64748b" font-size="9">1000+</text>
  <rect x="150" y="60" width="200" height="300" fill="#dcfce7" opacity="0.6"/>
  <text x="250" y="76" text-anchor="middle" fill="#166534" font-size="10" font-weight="bold">sweet spot</text>
  <text x="250" y="90" text-anchor="middle" fill="#166534" font-size="9">~1&#8211;4&#215; cores busy</text>
  <path d="M90,360 C 140,240 170,130 230,110 C 290,95 330,100 390,120 C 470,150 540,190 620,240 C 700,285 770,315 840,335" stroke="#2563eb" stroke-width="3" fill="none"/>
  <path d="M90,360 L 190,120 L 840,120" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="5 4" fill="none"/>
  <text x="700" y="112" fill="#64748b" font-size="9">ideal (no contention)</text>
  <text x="560" y="182" fill="#1e40af" font-size="10">real: context switches, lock and</text>
  <text x="560" y="196" fill="#1e40af" font-size="10">buffer contention, cache thrash</text>
  <rect x="600" y="250" width="240" height="90" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="720" y="270" text-anchor="middle" fill="#991b1b" font-size="10" font-weight="bold">Past saturation, more load = less work</text>
  <text x="720" y="288" text-anchor="middle" fill="#991b1b" font-size="9">latency rises &#8594; client timeouts &#8594; retries</text>
  <text x="720" y="302" text-anchor="middle" fill="#991b1b" font-size="9">&#8594; even more active connections</text>
  <text x="720" y="318" text-anchor="middle" fill="#991b1b" font-size="9">= congestion collapse</text>
  <rect x="110" y="400" width="720" height="30" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="470" y="419" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">Design goal: keep ACTIVE backends near the sweet spot and make excess demand WAIT (bounded) in a pool queue &#8212; not inside the database.</text>
</svg>
```

### Little's law: how many connections do you need?

**Concurrency = throughput × time in system.** If a service performs 3,000 queries/s at a mean of 4 ms each (including network round trip), it keeps on average 3,000 × 0.004 = **12 connections busy**. Allow for bursts and variance — say 2–3× — and ~30 connections serve it comfortably. Not 200.

Transactions change the arithmetic: a connection is held for the whole transaction, *including application think time between statements*. A transaction that runs 3 queries of 2 ms but spends 40 ms in between calling a payment API holds its connection for 46 ms, not 6 ms. At 500 such transactions/s, that is 23 connections busy instead of 3. **Never make network calls inside a database transaction** — it multiplies the connections you need and holds row locks for the duration.

### The connection budget

The database has one budget; every client shares it:

```text
Σ over services ( instances × max pool size per instance )
    + poolers' server connections + migrations/cron + replication + monitoring + admin headroom
    ≤ max_connections − superuser_reserved_connections (default 3) − reserved_connections (PG 16+)
```

**Worked example.** `max_connections = 500`. Reserve 3 for superusers, 20 for replication, monitoring, migrations and humans → 477 for applications.

- `orders-api`: 12 pods × pool 20 = 240
- `catalog-api`: 8 pods × pool 15 = 120
- `workers`: 6 pods × pool 10 = 60
- Total: 420 — fits, with 57 spare.

Now the autoscaler doubles `orders-api` to 24 pods for a sale: 480 + 120 + 60 = 660 > 477. Pods 18–24 fail to connect (or, worse, succeed while other services' reconnects fail). **Autoscaling policies must be derived from the connection budget**, or connections must go through a pooler so the number of pods stops mattering. Note also that the database needed only ~12 × Little's-law connections per service; most of those 420 are idle — the budget was being spent on idleness.

### Backpressure: queue outside the database, with a timeout

When demand exceeds capacity, work must wait *somewhere*. The only question is where:

- **Inside the database** (thousands of connections all actively running): every query slows, locks are held longer, and throughput collapses.
- **In the client pool's wait queue** (bounded pool, requests wait for a free connection): the database runs at its efficient concurrency; excess requests queue in cheap application memory.
- **At the edge** (load shedding: 429/503 immediately): best for requests that can't wait.

A bounded pool is backpressure *only if the wait is also bounded*. Go's `database/sql`, for example, waits for a free connection until the request's `context` expires — with `context.Background()`, forever. The rule is: **every acquisition has a deadline** (e.g. 100–500 ms for an interactive request), and on timeout you fail fast with a retryable error or a degraded response, so the queue can't grow without bound.

## 4. Architecture & Workflow

### Server-side pooling: PgBouncer and friends

A pooler sits between the application and PostgreSQL and multiplexes many client connections onto few server connections:

- **Session pooling** — a server connection is assigned to a client for its whole session. Safe for everything; only helps when clients connect/disconnect often.
- **Transaction pooling** — a server connection is assigned only for the duration of a transaction, then returned. 2,000 client connections can share 50 server connections, as long as at most ~50 transactions are in flight. This is the mode that solves the pod-count problem.
- **Statement pooling** — per statement; multi-statement transactions are disallowed. Rarely used.

Transaction pooling **breaks session state**, because consecutive transactions from one client may run on different backends: session-level `SET` (use `SET LOCAL` inside the transaction instead), session advisory locks (`pg_advisory_lock` — use `pg_advisory_xact_lock`), `LISTEN`/`NOTIFY` listeners, temporary tables that outlive a transaction, `WITH HOLD` cursors, and — historically — protocol-level prepared statements. **PgBouncer 1.21+** tracks protocol-level named prepared statements in transaction mode (`max_prepared_statements`), which removes the most common incompatibility with drivers like pgx and JDBC.

Other poolers: **pgcat** and **PgDog** (multi-threaded, add load balancing across replicas and sharding), **Odyssey** (multi-threaded, Yandex), **Supavisor** (cloud-scale, Elixir), and **RDS Proxy** (managed; it "pins" a client to a backend when it detects session state, which silently reduces multiplexing — monitor the pinning metric).

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="c20a1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="c20a2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two layers of pooling and where requests wait</text>
  <rect x="20" y="44" width="250" height="330" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="145" y="66" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">40 app pods (autoscaled)</text>
  <rect x="40" y="82" width="210" height="80" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="145" y="102" text-anchor="middle" fill="#1e40af" font-weight="bold">pod: client pool</text>
  <text x="145" y="120" text-anchor="middle" fill="#1e40af" font-size="10">MaxOpenConns = 10</text>
  <text x="145" y="136" text-anchor="middle" fill="#1e40af" font-size="10">acquire wait &#8804; 200 ms (ctx)</text>
  <text x="145" y="152" text-anchor="middle" fill="#1e40af" font-size="10">queue here = cheap app memory</text>
  <rect x="40" y="172" width="210" height="36" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="145" y="194" text-anchor="middle" fill="#1e40af" font-size="10">pod 2 &#8230; 39</text>
  <rect x="40" y="218" width="210" height="36" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="145" y="240" text-anchor="middle" fill="#92400e" font-size="10">batch pods: separate pool (bulkhead)</text>
  <text x="36" y="286" fill="#1e40af" font-size="10">client-side total:</text>
  <text x="36" y="302" fill="#1e40af" font-size="10">40 &#215; 10 = 400 client connections</text>
  <text x="36" y="330" fill="#991b1b" font-size="10" font-weight="bold">Without a pooler, 400 backends.</text>
  <text x="36" y="346" fill="#991b1b" font-size="10">Scale to 120 pods = 1,200 &gt; max_connections.</text>
  <rect x="330" y="104" width="220" height="210" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="126" text-anchor="middle" fill="#166534" font-size="12" font-weight="bold">PgBouncer (transaction mode)</text>
  <text x="346" y="150" fill="#166534" font-size="10">max_client_conn = 5000</text>
  <text x="346" y="168" fill="#166534" font-size="10">default_pool_size = 40 (per db/user)</text>
  <text x="346" y="186" fill="#166534" font-size="10">reserve_pool_size = 5</text>
  <text x="346" y="204" fill="#166534" font-size="10">query_wait_timeout = 5s</text>
  <text x="346" y="222" fill="#166534" font-size="10">max_prepared_statements = 200</text>
  <text x="346" y="248" fill="#166534" font-size="10">server conn assigned per TXN,</text>
  <text x="346" y="264" fill="#166534" font-size="10">returned at COMMIT/ROLLBACK</text>
  <text x="346" y="290" fill="#14532d" font-size="10" font-weight="bold">400&#8211;5,000 clients &#8594; 40 backends</text>
  <rect x="610" y="84" width="250" height="250" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="735" y="106" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">PostgreSQL primary</text>
  <text x="626" y="130" fill="#92400e" font-size="10">16 cores &#183; max_connections = 200</text>
  <text x="626" y="148" fill="#92400e" font-size="10">~40&#8211;45 backends from PgBouncer</text>
  <text x="626" y="166" fill="#92400e" font-size="10">+ 20 batch (role CONNECTION LIMIT 20)</text>
  <text x="626" y="184" fill="#92400e" font-size="10">+ replication, monitoring, admin</text>
  <text x="626" y="210" fill="#92400e" font-size="10">statement_timeout = 2s (app role)</text>
  <text x="626" y="228" fill="#92400e" font-size="10">lock_timeout = 1s</text>
  <text x="626" y="246" fill="#92400e" font-size="10">idle_in_transaction_session_timeout</text>
  <text x="626" y="262" fill="#92400e" font-size="10">  = 10s</text>
  <text x="626" y="296" fill="#78350f" font-size="10" font-weight="bold">Active backends stay near the</text>
  <text x="626" y="312" fill="#78350f" font-size="10" font-weight="bold">sweet spot regardless of pod count.</text>
  <path d="M252,122 L326,160" stroke="#2563eb" stroke-width="2" marker-end="url(#c20a1)"/>
  <path d="M252,190 L326,190" stroke="#2563eb" stroke-width="2" marker-end="url(#c20a1)"/>
  <path d="M552,200 L606,200" stroke="#16a34a" stroke-width="3" marker-end="url(#c20a2)"/>
  <path d="M252,236 C 400,340 560,330 640,336" stroke="#d97706" stroke-width="2" fill="none" stroke-dasharray="5 4" marker-end="url(#c20a1)"/>
  <text x="430" y="352" text-anchor="middle" fill="#92400e" font-size="9">batch: direct or separate pool, own limit</text>
  <rect x="20" y="392" width="840" height="76" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="36" y="414" fill="#1e293b" font-size="11" font-weight="bold">Waiting happens at two bounded queues, never inside PostgreSQL:</text>
  <text x="36" y="434" fill="#334155" font-size="10">1. app pool acquire (deadline from the request context, ~100&#8211;500 ms) &#8594; fail fast, degrade, or 503</text>
  <text x="36" y="454" fill="#334155" font-size="10">2. PgBouncer client queue (query_wait_timeout) &#8594; error to client. Monitor cl_waiting and maxwait in SHOW POOLS.</text>
</svg>
```

### Connection storms: deploys, autoscaling and failover

A **connection storm** is a burst of connection attempts large enough that setup cost (fork, auth, TLS) saturates the database, or that attempts exceed `max_connections`. Three triggers:

- **Deploys.** A rolling deploy of 200 pods, each opening `MinConns = 10` at startup: 2,000 connects in a minute, plus the old pods still holding theirs. Fix: min idle connections small (0–2), lazy connection opening, pooler in front, surge limits.
- **Autoscaling.** Scale-out happens precisely under load, adding connections when the database is busiest.
- **Failover.** Every client loses its connections at the same instant, and every pool tries to reconnect at once — often in a tight loop with no backoff, against a new primary with a cold cache. A 30 s failover becomes a multi-minute brown-out.

Mitigations: jittered exponential backoff on *connect* (not just on queries), `MaxConnLifetime` with **jitter** so connections don't all recycle simultaneously, a pooler that holds client connections open while it reconnects to the new primary (PgBouncer keeps clients connected and reconnects server-side), and admission control so the reconnect wave doesn't also carry a retry wave.

### Retry storms and amplification

A timeout doesn't mean the query failed — it may still be running on the database, holding a connection and locks. If the client retries immediately, the database now has two copies of the work. Multiply by 1,000 clients and by retry layers (the HTTP client retries, the service retries, the ORM retries): **3 attempts at each of 3 layers = up to 27 executions per user action**, all aimed at the component that was already slow.

Rules for database retries:

1. **Retry only retryable errors:** serialization failures (`40001`), deadlocks (`40P01`), connection errors *before the statement was sent*, pool-acquire timeouts, and failover-induced "read-only transaction" errors (`25006`) after reconnect. Do **not** blindly retry statement timeouts (`57014`) — the query was too slow; retrying repeats it.
2. **Retry at one layer**, the one that owns the transaction boundary (retry the whole transaction, not the last statement).
3. **Exponential backoff with full jitter:** `sleep = random(0, min(cap, base × 2^attempt))`.
4. **Retry budget:** retries may add at most ~10% to the request rate; when the budget is spent, fail instead of retrying.
5. **Ambiguous commits:** if the connection dropped during `COMMIT`, you don't know whether it committed. Retrying is safe only if the transaction is idempotent (idempotency key with a unique constraint).

### The timeout stack

Timeouts must be set at every layer and must **shrink as you go inward**, so the inner layer gives up first and releases resources cleanly:

```text
edge / load balancer                         30 s   (outermost; rarely the one that should fire)
client → service HTTP timeout                 3 s
service request deadline (context)          2.5 s
  pool acquire (context-bound)             ≤ 200 ms
  per-query / per-transaction context        2 s   (driver sends a cancel request on expiry)
PostgreSQL statement_timeout                  2 s   (per role or per transaction: SET LOCAL)
PostgreSQL lock_timeout                       1 s   (waiting for a lock, not running)
PostgreSQL idle_in_transaction_session_timeout 10 s (app forgot to COMMIT / crashed mid-txn)
PostgreSQL transaction_timeout (PG 17)       5 s   (caps the whole transaction)
PostgreSQL idle_session_timeout (PG 14)       —    (careful: poolers hold idle sessions on purpose)
TCP keepalives / client_connection_check_interval   detect dead clients so their queries are cancelled
```

Why each exists: `statement_timeout` kills runaway queries server-side even if the client vanished; `lock_timeout` prevents lock *queues* from growing behind a blocked DDL or long transaction (Ch 05, Ch 27); `idle_in_transaction_session_timeout` kills sessions that hold locks and the xmin horizon while doing nothing (a primary cause of bloat, Ch 03); client-side deadlines stop the app waiting forever and trigger a driver-level cancel. `client_connection_check_interval` (PG 14+) lets a backend notice mid-query that its client has disconnected, so abandoned queries stop consuming resources.

### Circuit breakers and bulkheads, applied to the database

A **circuit breaker** around database calls opens when the error or timeout rate crosses a threshold (e.g. >50% of the last 50 calls), fails fast for a cool-down (e.g. 5–10 s), then lets a few probe requests through (half-open). For a database, it's most useful per *workload* (e.g. around the reporting queries or around a replica), so that a sick dependency returns fast errors and the service can serve degraded responses instead of stacking up goroutines waiting for connections.

A **bulkhead** gives each workload its own bounded resources: separate pools for interactive vs batch vs reporting traffic, separate database roles with `CONNECTION LIMIT` and role-level `statement_timeout`, and ideally reporting on a replica. Without bulkheads, the nightly export that opens 50 connections and runs 3-minute queries shares the pool with checkout, and checkout's requests wait behind it.

## 5. Implementation

### Simple example: see your connections from the database side

```sql
-- How many connections, in what state, from whom?
SELECT usename, application_name, state, count(*) AS conns,
       max(now() - state_change) AS longest_in_state
FROM pg_stat_activity
WHERE backend_type = 'client backend'
GROUP BY 1, 2, 3
ORDER BY conns DESC;
```

```text
 usename | application_name |        state        | conns | longest_in_state
---------+------------------+---------------------+-------+------------------
 app     | orders-api       | idle                |   212 | 00:41:07
 app     | orders-api       | active              |     9 | 00:00:00.8
 app     | orders-api       | idle in transaction |     3 | 00:02:13
 batch   | exporter         | active              |    18 | 00:03:40
```

212 idle connections from one service is the budget being spent on nothing; three sessions `idle in transaction` for two minutes are holding locks and the xmin horizon. Configure the guard rails per role:

```sql
ALTER ROLE app   SET statement_timeout = '2s';
ALTER ROLE app   SET lock_timeout = '1s';
ALTER ROLE app   SET idle_in_transaction_session_timeout = '10s';
ALTER ROLE batch CONNECTION LIMIT 20;
ALTER ROLE batch SET statement_timeout = '10min';
ALTER ROLE reporting SET default_transaction_read_only = on;

-- one unusually long migration step can override locally:
BEGIN;
SET LOCAL statement_timeout = '30min';
SET LOCAL lock_timeout = '3s';
-- ...
COMMIT;
```

### Real-world example: a Go service with a correctly shaped pool

Using `database/sql` with the pgx stdlib driver (the same knobs exist on `pgxpool.Config` as `MaxConns`, `MinConns`, `MaxConnLifetime`, `MaxConnLifetimeJitter`, `MaxConnIdleTime`):

```go
package store

import (
	"context"
	"database/sql"
	"errors"
	"math/rand"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
)

// OpenPools builds two bulkheaded pools against the same database (via PgBouncer).
func OpenPools(dsn string) (oltp *sql.DB, batch *sql.DB, err error) {
	oltp, err = sql.Open("pgx", dsn+"&application_name=orders-api")
	if err != nil {
		return nil, nil, err
	}
	// Little's law: ~3,000 q/s per pod x 3 ms = 9 busy; x2 headroom.
	oltp.SetMaxOpenConns(20)                   // hard cap per pod -> part of the global budget
	oltp.SetMaxIdleConns(20)                   // keep them; default is only 2 (causes churn)
	oltp.SetConnMaxLifetime(30 * time.Minute)  // recycle (DNS changes, failover, memory)
	oltp.SetConnMaxIdleTime(5 * time.Minute)   // shrink after bursts

	batch, err = sql.Open("pgx", dsn+"&application_name=orders-batch")
	if err != nil {
		return nil, nil, err
	}
	batch.SetMaxOpenConns(4) // batch can never take more than 4 connections per pod
	batch.SetMaxIdleConns(1)
	return oltp, batch, nil
}

var ErrOverloaded = errors.New("database busy, try later")

// retryable reports whether the whole transaction may be retried safely.
func retryable(err error) bool {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		switch pgErr.Code {
		case "40001", "40P01": // serialization failure, deadlock detected
			return true
		}
		return false // includes 57014 statement timeout: don't repeat slow work
	}
	return pgconn.SafeToRetry(err) // connection failed before anything was sent
}

// InTx runs fn in a transaction with a deadline, bounded retries, and full-jitter backoff.
func InTx(ctx context.Context, db *sql.DB, budget *RetryBudget, fn func(*sql.Tx) error) error {
	const maxAttempts = 3
	base, maxBackoff := 20*time.Millisecond, 500*time.Millisecond

	for attempt := 0; ; attempt++ {
		err := func() error {
			// Bound the whole attempt, including waiting for a pool connection.
			actx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()

			tx, err := db.BeginTx(actx, nil) // blocks for a free conn until actx expires
			if err != nil {
				if errors.Is(err, context.DeadlineExceeded) {
					return ErrOverloaded // pool acquire timed out: backpressure, not a DB error
				}
				return err
			}
			defer tx.Rollback() // no-op after a successful Commit
			if err := fn(tx); err != nil {
				return err
			}
			return tx.Commit()
		}()

		if err == nil || !retryable(err) || attempt+1 >= maxAttempts || !budget.Allow() {
			return err
		}
		backoff := base << attempt
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
		sleep := time.Duration(rand.Int63n(int64(backoff))) // full jitter
		select {
		case <-time.After(sleep):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}
```

A retry budget that caps retries at ~10% of requests (a token bucket refilled by successes):

```go
type RetryBudget struct {
	mu     sync.Mutex
	tokens float64
	max    float64
}

func NewRetryBudget() *RetryBudget { return &RetryBudget{tokens: 10, max: 10} }

func (b *RetryBudget) OnRequest() { b.mu.Lock(); b.tokens = min(b.max, b.tokens+0.1); b.mu.Unlock() }

func (b *RetryBudget) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.tokens >= 1 {
		b.tokens--
		return true
	}
	return false // retries exhausted: fail fast instead of amplifying load
}
```

(`min` is the Go 1.21+ builtin; call `budget.OnRequest()` once per incoming request.) Expose pool health as metrics — `db.Stats()` returns `OpenConnections`, `InUse`, `Idle`, `WaitCount`, `WaitDuration` and `MaxIdleClosed`. A rising `WaitDuration` per request is the earliest signal that the pool — i.e. the database — is saturated.

### PgBouncer configuration for this service

```ini
[databases]
orders = host=pg-primary.internal port=5432 dbname=orders

[pgbouncer]
listen_addr = 0.0.0.0
listen_port = 6432
auth_type = scram-sha-256
pool_mode = transaction
max_client_conn = 5000          ; client connections are cheap for PgBouncer
default_pool_size = 40          ; server connections per (database, user) pair
reserve_pool_size = 5
reserve_pool_timeout = 3
query_wait_timeout = 5          ; a client waiting longer than this gets an error (backpressure)
server_lifetime = 1800
server_idle_timeout = 300
max_prepared_statements = 200   ; PgBouncer 1.21+: named prepared statements in txn mode
```

```text
pgbouncer=# SHOW POOLS;
 database | user | cl_active | cl_waiting | sv_active | sv_idle | sv_used | maxwait | pool_mode
----------+------+-----------+------------+-----------+---------+---------+---------+-------------
 orders   | app  |       812 |          0 |        31 |       9 |       0 |       0 | transaction
```

812 client connections served by 40 server connections, nobody waiting. When `cl_waiting` and `maxwait` climb, the database (or the transactions' length) is the limit — raising `default_pool_size` just moves the queue into PostgreSQL.

> **MySQL difference:** MySQL uses a **thread per connection**, which is cheaper than a process, and its default `max_connections` is 151. Very high connection counts still hurt (thread scheduling, per-connection buffers), so MySQL deployments use **ProxySQL** for multiplexing (its equivalent of transaction pooling, disabled automatically for connections with session state) or the **thread pool** plugin (MySQL Enterprise, Percona Server, MariaDB). Timeouts differ: `max_execution_time` (milliseconds, applies to read-only SELECTs), `innodb_lock_wait_timeout` (default 50 s — far too long for OLTP; commonly lowered to a few seconds), and `wait_timeout` (default 28,800 s) for idle connections, which silently closes pooled connections that sit idle longer than that — set the pool's max lifetime below it.

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Gains | Costs |
| --- | --- | --- |
| Small client pools (Little's law) | DB runs near its sweet spot; budget fits many pods | requests queue in the app under bursts (bounded wait required) |
| Large client pools | fewer app-side waits | DB overload under load, budget exhausted by idle conns |
| PgBouncer transaction mode | pod count decoupled from backends; storm absorption | session state breaks; another hop and component to make HA |
| PgBouncer session mode | full compatibility | little multiplexing |
| Aggressive timeouts | resources freed fast; failures surface quickly | legitimate slow queries fail; needs per-role/per-txn overrides |
| Retries with backoff + budget | rides out transient conflicts and failovers | added latency; complexity; must be idempotent |
| Circuit breaker | fast failure, room to recover | tuning; risk of opening on benign blips |
| Bulkheads (separate pools/roles) | one workload can't starve another | lower peak utilisation, more config |

### When to use

- **Always:** bounded pools with bounded acquire waits, `statement_timeout`/`lock_timeout`/`idle_in_transaction_session_timeout` per role, context deadlines on every query.
- **A server-side pooler** when the number of app processes × pool size approaches `max_connections`, with serverless/FaaS clients, or with frequent autoscaling.
- **Retries** for serialization failures and deadlocks — mandatory under SERIALIZABLE and on distributed SQL (Ch 06, Ch 16).
- **Bulkheads** whenever batch, reporting and interactive traffic share a database.

### When NOT to use

- **Not transaction pooling** for workloads that depend on session state (session advisory locks, LISTEN, temp tables across transactions) — give those a session-mode pool or direct connections.
- **Not retries** on statement timeouts or on non-idempotent commits with ambiguous outcomes.
- **Not a circuit breaker** as a substitute for capacity — if it's open during normal peaks, you are under-provisioned.
- **Not raising max_connections** as the fix for connection errors; it usually converts an error into a slowdown.

## 7. Common Mistakes & Best Practices

- **Pool size = "100, to be safe".** *Why it hurts:* 50 pods × 100 = 5,000 potential backends; under load, the DB thrashes. *Instead:* size by Little's law with 2–3× headroom and check the global budget.
- **Unbounded wait for a connection.** *Why it hurts:* requests pile up in memory, clients time out, retry, and the pile grows. *Instead:* context deadline on every acquisition; fail fast with 503 or degrade.
- **Network calls inside transactions.** *Why it hurts:* holds a connection and row locks for the duration of someone else's latency. *Instead:* call external services before or after the transaction; use an outbox for side effects (Ch 29).
- **Retrying at every layer, without jitter.** *Why it hurts:* synchronized waves and multiplicative amplification. *Instead:* retry once, at the transaction boundary, with full jitter and a budget.
- **No `idle_in_transaction_session_timeout`.** *Why it hurts:* a crashed request path leaves a transaction open, holding locks and blocking vacuum for hours. *Instead:* set it (e.g. 10–60 s) for application roles.
- **Session state through transaction pooling.** *Why it hurts:* `SET search_path` or `SET statement_timeout` leaks to other clients, or silently doesn't apply. *Instead:* `SET LOCAL`, role-level settings, or connection-string options.
- **MinConns high on every pod.** *Why it hurts:* deploys and scale-outs create connection storms. *Instead:* small min idle, lazy creation, lifetime jitter.
- **One pool for everything.** *Why it hurts:* reporting queries starve checkout. *Instead:* bulkhead pools and roles, reporting on replicas.
- **Best practice:** publish a connection budget table per database (service, instances min/max, pool size, total) and make the autoscaler's `maxReplicas` respect it.

## 8. Production: Failure Scenarios, Monitoring & Scaling

### Failure scenarios

**Black Friday autoscale.** At 10:00 traffic triples; the HPA scales `orders-api` from 20 to 60 pods. Each pod opens up to 25 connections; at pod 36 the database returns `FATAL: sorry, too many clients already`. New pods crash-loop on readiness checks that query the DB, the autoscaler adds more, and existing pods' reconnects also fail. Root cause: pool size × max replicas exceeded `max_connections`. Fix: PgBouncer in transaction mode (60 pods × 25 client conns → 60 backends), HPA max derived from the budget, readiness probes that don't open fresh DB connections.

**Failover turned into a 15-minute brown-out.** Patroni fails over in 35 s. Then 300 pods reconnect in a tight loop; each connect does SCRAM + TLS; the new primary's CPU hits 100% on authentication alone while its cache is cold. Requests time out, HTTP clients retry 3×, the service layer retries 3×. Root cause: no connect backoff, no retry budget, retries at two layers. Fix: jittered backoff on reconnect, retry only at the transaction layer with a budget, PgBouncer to hold client connections through the failover.

**The report that took down checkout.** A new finance report runs a 4-minute query per region through the shared pool; at month-end, 12 of them run concurrently and hold 12 of each pod's 15 connections. Checkout requests wait for connections, time out. Root cause: no bulkhead. Fix: reporting uses its own pool and role (`CONNECTION LIMIT 10`, `statement_timeout = 15min`) against a replica.

**The lock queue.** A migration runs `ALTER TABLE orders ADD COLUMN ...` which waits behind a long transaction; every subsequent query on `orders` queues behind the ALTER's ACCESS EXCLUSIVE request. Pools fill with waiting queries; the site stops. Root cause: no `lock_timeout` on the migration. Fix: `SET lock_timeout = '3s'` and retry the migration step; `idle_in_transaction_session_timeout` to kill the forgotten transaction ([Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution)).

**Idle-in-transaction bloat.** A code path returns early without committing when a cache lookup fails; the transaction stays open for hours. Autovacuum can't remove dead tuples newer than its snapshot; tables bloat, queries slow over the day. Fix: `idle_in_transaction_session_timeout`, `defer tx.Rollback()` everywhere, and an alert on `max(now() - xact_start)`.

### What to monitor

| Metric | Source | Signal |
| --- | --- | --- |
| Connections by state/app/user | `pg_stat_activity` | budget use; idle-in-transaction count |
| Connections vs `max_connections` | `pg_stat_activity` count / `SHOW max_connections` | headroom (alert at ~80%) |
| Pool wait count/duration | `db.Stats()` / HikariCP / pgxpool metrics | saturation, first to move |
| PgBouncer `cl_waiting`, `maxwait`, `sv_active` | `SHOW POOLS`, `SHOW STATS` | server-side queueing |
| Oldest transaction age | `max(now() - xact_start)` in `pg_stat_activity` | leaked transactions, vacuum blockers |
| Statement/lock timeout counts | server logs, SQLSTATE 57014 / 55P03 counts in app | queries/locks hitting limits |
| Retry rate and retry-budget exhaustion | app metrics | amplification risk |
| Connection rate (new connections/s) | `pg_stat_database` sessions (PG 14+), pooler stats | churn and storms |
| Circuit-breaker state changes | app metrics | dependency health |

### Scaling notes

As you scale out app instances, the connection budget, not CPU, is usually the first database limit you hit — a pooler removes it. As you scale the database up (more cores), the sweet spot for active connections rises; revisit pool sizes after every resize. When reads move to replicas, give each replica its own budget and pool, and treat replica pools as a separate bulkhead so replica lag or failure doesn't block primary traffic.

## 9. Interview Questions

**Q: Why are PostgreSQL connections expensive?**
A: PostgreSQL forks a separate backend process for each connection, and each connection also pays authentication and often TLS setup. Each backend has private memory, a few MB idle and much more when running sorts or hashes with work_mem. Thousands of idle connections waste memory and scheduling, and many active connections beyond the core count add contention and context switching that reduce total throughput. That's why you keep the number of backends modest and pool connections.

**Q: How do you size a connection pool?**
A: Start from Little's law: the number of busy connections equals throughput times the time each request holds a connection. For 3,000 queries per second at 4 ms each, that's about 12 connections busy on average, so a pool of 20–30 per service is plenty. Then check the global budget: instances times pool size across all services, plus admin and replication headroom, must fit under max_connections. Keep transactions short, because a connection is held for the whole transaction including application time between statements.

**Q: Explain PgBouncer's pool modes and what transaction mode breaks?**
A: Session mode assigns a server connection to a client for its whole session, which is fully compatible but multiplexes little. Transaction mode assigns a server connection only for the duration of a transaction, so many clients can share few backends. Statement mode goes further and forbids multi-statement transactions. Transaction mode breaks features that rely on session state spanning transactions: session-level SET, session advisory locks, LISTEN, temp tables and held cursors. Older PgBouncer also broke protocol-level prepared statements; version 1.21+ supports them with max_prepared_statements.

**Q: What happens to your connection budget when the service autoscales?**
A: Each new instance brings its own pool, so potential connections scale with instance count times pool size. If the autoscaler can exceed the budget, new instances fail to connect, or they take connections other services need, and it happens precisely at peak load. You either cap max replicas based on the budget and keep per-instance pools small, or put a transaction-mode pooler in front so the number of backends is independent of instance count.

**Q: What is backpressure in the context of a database, and how do you implement it?**
A: Backpressure means making excess demand wait or fail outside the database instead of letting it all run concurrently inside, where it would slow everything down. You implement it with a bounded connection pool whose acquisition wait is also bounded by a deadline, a pooler queue with a wait timeout, and load shedding at the edge. When the deadline expires, you return a fast 503 or a degraded response. The database then runs at its efficient concurrency even when demand exceeds capacity.

**Q: List the PostgreSQL timeouts you'd configure for an OLTP application role and why?**
A: statement_timeout caps how long any single statement runs, killing runaway queries even if the client has gone. lock_timeout caps how long a statement waits for a lock, which prevents long lock queues behind DDL or long transactions. idle_in_transaction_session_timeout kills sessions that opened a transaction and stopped doing anything, which otherwise hold locks and block vacuum. PostgreSQL 17's transaction_timeout caps the whole transaction. I'd set them per role, override with SET LOCAL for specific jobs, and make sure client-side deadlines are slightly longer so the server-side timeout fires first and cleans up.

**Q: Which database errors should an application retry?**
A: Serialization failures (40001) and deadlocks (40P01) should be retried by re-running the whole transaction, since they are expected under concurrency. Connection failures that happened before the statement was sent, and pool-acquire timeouts, can be retried with backoff. Statement timeouts should generally not be retried, since the query was too slow and will likely be slow again. And if the connection dropped during COMMIT, the outcome is ambiguous, so you can only retry if the transaction is idempotent, for example protected by an idempotency key with a unique constraint.

**Q: How do retry storms form, and how do you prevent them? (Senior)**
A: When the database slows, requests time out, and clients retry; if several layers each retry three times, one user action becomes many executions, while the original queries may still be running. Without jitter, retries from thousands of clients synchronise into waves. The database gets more load exactly when it has least capacity, so it never recovers. Prevention: retry at a single layer that owns the transaction, use exponential backoff with full jitter, cap retries with a retry budget such as 10% of request volume, don't retry non-retryable errors like timeouts, and use circuit breakers to fail fast when the error rate is high.

**Q: A failover completes in 30 seconds but the service is degraded for 15 minutes. What happened and how do you fix it? (Senior)**
A: The likely cause is a reconnect and retry storm: every pod lost its connections at once and reconnected in a tight loop, each connection paying fork, SCRAM and TLS costs on a new primary with a cold cache, while failed requests were retried at multiple layers. The new primary spent its CPU on authentication and duplicate work. Fixes: jittered exponential backoff on reconnect, retry only at the transaction layer with a budget, modest pool sizes and min idle connections, and a pooler like PgBouncer that keeps client connections open and reconnects server-side. Also make sure clients discover the new primary quickly, without long DNS caching, and rehearse failovers under load to measure recovery.

**Q: Design the database access layer for a service with checkout traffic and a nightly export job sharing one PostgreSQL. (Senior)**
A: I'd bulkhead them: checkout uses its own small pool sized by Little's law with a short acquire deadline, and the export uses a separate pool of a few connections, ideally against a replica. At the database, they use different roles: the checkout role gets statement_timeout of a couple of seconds, lock_timeout and idle_in_transaction_session_timeout; the export role gets a CONNECTION LIMIT and a longer statement_timeout. The export processes data in keyset-paginated batches with short transactions to avoid holding snapshots. Checkout retries only serialization and deadlock errors with jittered backoff and a budget, and a circuit breaker lets it degrade if the database is failing.

**Q: Why might raising max_connections make an outage worse?**
A: Connection errors are often the symptom of the database already being at or past saturation. Raising the limit lets more queries run concurrently, which increases contention, memory use and context switching, so each query slows down and total throughput can drop. Slower queries cause more client timeouts and retries, creating more load. The better fix is to reduce concurrent demand with smaller pools, a pooler, and backpressure, and to find why queries or transactions got longer.

**Q: How would you detect that application code is leaking open transactions?**
A: In pg_stat_activity, look for sessions in the 'idle in transaction' state and the age of the oldest transaction via now() minus xact_start. Leaked transactions show up as long-lived idle-in-transaction sessions from a particular application_name, often correlated with growing dead tuples in pg_stat_user_tables and autovacuum unable to clean up. I'd set idle_in_transaction_session_timeout to kill them, alert on oldest transaction age, and fix the code path, typically an early return without commit or rollback, by always deferring a rollback after beginning a transaction.

## 10. Quick Revision & Cheat Sheet

| Topic | Remember |
| --- | --- |
| PG connection cost | process per connection; setup (fork+auth+TLS) + memory + contention |
| Pool size | Little's law: busy = QPS × hold time; ×2–3 headroom |
| Budget | Σ(instances × pool) + admin/replication ≤ max_connections − reserved |
| PgBouncer | session / transaction / statement; txn mode breaks session state; 1.21+ prepared stmts |
| Backpressure | bounded pool + bounded wait + shed; queue outside the DB |
| Storms | deploy, autoscale, failover → jittered connect backoff, small min idle, lifetime jitter, pooler |
| Retries | 40001/40P01/connect-before-send only; one layer; full jitter; budget; beware ambiguous COMMIT |
| Timeouts | shrink inward; statement_timeout, lock_timeout, idle_in_transaction_session_timeout, transaction_timeout (17) |
| Circuit breaker | closed → open (fail fast) → half-open probes |
| Bulkheads | separate pools + roles (CONNECTION LIMIT) per workload |
| Go | SetMaxOpenConns, SetMaxIdleConns (default 2!), SetConnMaxLifetime, SetConnMaxIdleTime, ctx on every call |
| MySQL | thread per connection, max_connections 151, ProxySQL, innodb_lock_wait_timeout 50 s, wait_timeout |

- Past saturation, more concurrency means less throughput.
- Every wait needs a deadline, including waiting for a connection.
- No network calls inside transactions.
- Retry the whole transaction, at one layer, with jitter and a budget.
- Autoscaling limits come from the connection budget.
- Separate pools for separate workloads.
- Raising max_connections is rarely the fix.

## 11. Hands-On Exercises

1. **Find the cliff.** Run `postgres:17` with 4 CPUs (`--cpus=4`). Initialise `pgbench -i -s 50`, then run `pgbench -c N -j 4 -T 30 -S` for N = 4, 8, 16, 32, 64, 128, 256 (raise `max_connections` to 300). Plot TPS and average latency vs N and find the sweet spot.
2. **PgBouncer multiplexing.** Add `edoburu/pgbouncer` (or the `bitnami/pgbouncer` image) in transaction mode with `default_pool_size = 16`. Rerun `pgbench -c 256` through PgBouncer and compare TPS and latency with exercise 1. Watch `SHOW POOLS` during the run.
3. **Session state breakage.** Through PgBouncer in transaction mode, run `SET statement_timeout = '1ms'` in one transaction and then a slow query in another from the same client; observe that the setting did not stick (or leaked to another client). Repeat with `SET LOCAL` inside the transaction.
4. **Timeout stack.** Open a transaction, `SELECT ... FOR UPDATE` a row, and leave it idle. From another session with `lock_timeout = '1s'`, update the row and observe SQLSTATE 55P03. Then set `idle_in_transaction_session_timeout = '5s'` and watch the first session get terminated.
5. **Retry storm simulation.** Write a small Go program with 200 goroutines issuing transactions against a hot row under SERIALIZABLE. Compare total executions and p99 latency with (a) immediate retries without limits, (b) full-jitter backoff, (c) backoff plus retry budget.

**Mini project — "Database load shaper".** Build a small Go or Python library that wraps database access with: a context-bounded pool acquire, per-workload bulkhead pools, transaction retries with full jitter and a retry budget, a circuit breaker per pool, and metrics (pool wait, retries, breaker state). Load-test it against PostgreSQL behind PgBouncer while you kill the primary (Patroni lab from Ch 18) and while you run a heavy report in the batch pool, and show that checkout p99 stays within its SLO.

## 12. Related Topics & Free Learning Resources

**This handbook:** [Ch 01 · Database Architecture](topic.html?p=01-database-architecture) · [Ch 03 · MVCC](topic.html?p=03-mvcc) · [Ch 05 · Locking Internals](topic.html?p=05-locking-internals) · [Ch 06 · Isolation Deep Dive](topic.html?p=06-isolation-deep-dive) · [Ch 18 · High Availability](topic.html?p=18-high-availability) · [Ch 19 · Database Caching Architecture](topic.html?p=19-database-caching-architecture) · [Ch 22 · Capacity Planning](topic.html?p=22-capacity-planning) · [Ch 23 · Bottleneck Diagnosis](topic.html?p=23-bottleneck-diagnosis) · [Ch 27 · Schema Evolution](topic.html?p=27-schema-evolution)

**SQL Handbook:** [Transactions & ACID](../sql/topic.html?p=25-transactions-acid) · [Locking & MVCC](../sql/topic.html?p=27-locking-mvcc)

**Other handbooks:** [System Design · Resilience Patterns](../system-design/topic.html?p=27-resilience-patterns) · [System Design · Scaling Approaches](../system-design/topic.html?p=13-scaling-approaches) · [Go · PostgreSQL Integration](../go/topic.html?p=76-postgresql-integration) · [Go · Context Package](../go/topic.html?p=42-context-package) · [Caching with Redis · Client-Side Caching & Pooling](../redis-caching/topic.html?p=27-client-side-caching-pooling)

- **PgBouncer Configuration** — PgBouncer docs · *Intermediate* · pool modes, sizing parameters and prepared-statement support. <https://www.pgbouncer.org/config.html>
- **PostgreSQL: Client Connection Defaults** — PostgreSQL docs · *Intermediate* · statement_timeout, lock_timeout, idle_in_transaction_session_timeout, transaction_timeout. <https://www.postgresql.org/docs/current/runtime-config-client.html>
- **About Pool Sizing** — HikariCP wiki (Brett Wooldridge) · *Intermediate* · why smaller pools are faster, with the reasoning behind it. <https://github.com/brettwooldridge/HikariCP/wiki/About-Pool-Sizing>
- **Exponential Backoff and Jitter** — AWS Architecture Blog (Marc Brooker) · *Intermediate* · full jitter vs other strategies, with simulations. <https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/>
- **Go database/sql: Managing connections** — Go docs · *Beginner* · SetMaxOpenConns, idle connections and lifetimes. <https://go.dev/doc/database/manage-connections>
- **Google SRE Book, ch. 22 "Addressing Cascading Failures"** — Google · *Advanced* · overload, retry amplification, deadlines and load shedding. <https://sre.google/sre-book/addressing-cascading-failures/>
- **Improving Postgres Connection Scalability: Snapshots** — Andres Freund (Microsoft Tech Community) · *Advanced* · why many connections hurt and what PG 14 changed. <https://techcommunity.microsoft.com/t5/azure-database-for-postgresql/improving-postgres-connection-scalability-snapshots/ba-p/1806462>

---

*Database Design Handbook — chapter 20.*
