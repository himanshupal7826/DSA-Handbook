# 34 · Scaling Django: Connections, Replicas & Multiple Databases

> **In one line:** Django opens one database connection per thread and, by default, closes it at the end of every request — so the first scaling problems are connection churn and connection *count*, solved with `CONN_MAX_AGE`, Django 5.1's native pool or PgBouncer; after that come read replicas via database routers (and the read-your-writes bugs they cause), and finally partitioning data by tenant or shard.

---

## 1. Overview

> **Builds on:** [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization), [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency), [Ch 29 · Caching in Django](topic.html?p=29-caching), [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks).

Your Django app is getting real traffic. The database CPU is fine, the slow-query log is clean (you already fixed the N+1s), and yet p99 latency is climbing and every few days PostgreSQL logs `FATAL: sorry, too many clients already`. Two different problems are hiding there. First, **connection churn**: with the default `CONN_MAX_AGE = 0`, every request opens a fresh TCP connection to PostgreSQL, negotiates TLS, authenticates, and PostgreSQL forks a backend process — several milliseconds of overhead per request, and on a busy server a large share of database CPU. Second, **connection count**: 20 pods × 4 Gunicorn workers × 4 threads + 10 Celery pods × 8 processes = 400 potential connections, and each PostgreSQL backend costs memory and contends for locks; `max_connections` defaults to 100.

The naive fixes make it worse. Raising `max_connections` to 2,000 trades a connection error for a memory and context-switch problem — PostgreSQL performance degrades well before such numbers because each connection is a process. Setting `CONN_MAX_AGE = None` (persistent forever) removes churn but pins a connection per thread even when idle, so the count problem gets *worse*. The right answer is layered: reuse connections within a process (persistent connections or Django 5.1's native **psycopg pool**), multiplex many client connections onto few server connections with **PgBouncer**, and budget connections deliberately.

Once connections are under control, the next limit is read throughput on a single primary. Django's **multiple-database** support and **database routers** let you send reads to **read replicas** while writes go to the primary — at the cost of replication lag, which turns into "I saved my profile and the page still shows the old name". Beyond replicas, write scaling requires partitioning data: per-tenant schemas or databases, or application-level sharding. This chapter walks that path in the order you will hit it. Database-side theory lives in [Database Design · Replication](../database-design/topic.html?p=09-replication) and [Database Design · Pools, Timeouts & Storms](../database-design/topic.html?p=20-database-application-architecture); here is the Django side.

## 2. Core Concepts

- **Connection per thread** — `django.db.connections` is a `ConnectionHandler` that keeps one `DatabaseWrapper` per alias *per thread* (asgiref `Local`). *Why it matters:* connection count = processes × threads per alias, not "number of servers".
- **Lazy connect** — the wrapper connects on the first query, not at startup. *Why:* a request that never touches the DB costs no connection.
- **`CONN_MAX_AGE`** — seconds to keep a connection open after a request: `0` (default) closes at the end of each request; `None` keeps it forever; `60` reuses for a minute. *Why:* removes per-request connect overhead.
- **`close_old_connections`** — handler for `request_started` and `request_finished` signals; closes connections that exceeded `CONN_MAX_AGE` or are unusable after errors. *Why:* this is the only place persistent connections are recycled — outside requests (Celery, management commands) you call it yourself.
- **`CONN_HEALTH_CHECKS`** (4.1+) — when `True`, a reused persistent connection is pinged at the start of a request and replaced if dead. *Why:* avoids the first query of a request failing after a DB failover or idle timeout.
- **Native pooling** (Django 5.1+, PostgreSQL + psycopg 3) — `OPTIONS: {"pool": True}` or pool kwargs, using `psycopg_pool.ConnectionPool` per process. *Why:* threads borrow connections only for the duration of a request, so idle threads hold none.
- **PgBouncer** — external connection pooler. **Session mode** maps a client to a server connection for the whole session; **transaction mode** only for each transaction. *Why:* transaction mode lets thousands of client connections share tens of server connections — but breaks session state.
- **`DISABLE_SERVER_SIDE_CURSORS`** — make `.iterator()` use client-side cursors. *Why:* server-side cursors (named cursors used by `iterator()` on PostgreSQL) do not survive PgBouncer transaction mode outside a transaction.
- **`DATABASES` aliases** — multiple entries (`default`, `replica`, `analytics`). *Why:* each alias is a separate connection; querysets choose one via routers or `.using()`.
- **Database router** — a class in `DATABASE_ROUTERS` implementing `db_for_read`, `db_for_write`, `allow_relation`, `allow_migrate`. *Why:* central policy for where each query goes.
- **`.using(alias)` / `save(using=)` / `Manager.db_manager(alias)`** — explicit per-query routing. *Why:* override the router for specific cases (force primary after a write).
- **Instance `_state.db`** — every model instance remembers which alias it was loaded from. *Why:* related lookups from that instance default to the same database ("stickiness").
- **Replication lag** — the delay between a commit on the primary and its visibility on a replica. *Why:* reading your own write from a replica can return stale data.
- **Multi-tenancy** — isolating customers via a shared schema with `tenant_id`, schema-per-tenant (PostgreSQL `search_path`, e.g. django-tenants), or database-per-tenant. *Why:* determines isolation, migration cost and how you shard later.

## 3. Theory & Principles

### How Django manages connections internally

`connections["default"]` returns the `DatabaseWrapper` for the current thread (creating it from `settings.DATABASES` on first use). When you evaluate a QuerySet, the compiler calls `connection.cursor()`, which calls `ensure_connection()` → `connect()` if `self.connection is None`. `connect()` records `self.close_at = now + CONN_MAX_AGE` (or `None` for unlimited). At the start and end of each HTTP request, `BaseHandler` sends `request_started` / `request_finished`, and `django.db.close_old_connections` calls `close_if_unusable_or_obsolete()` on every connection, which closes it if it errored, if autocommit was left off, or if `close_at` has passed. With `CONN_MAX_AGE = 0`, `close_at` is "now", so every request ends with a close.

Two consequences matter for interviews. **Persistent connections are per thread**, so with Gunicorn `--threads 8`, each worker process can hold eight connections. And **persistent connections only get recycled at request boundaries**: a Celery worker or a long-running management command never sends `request_finished`, so a connection broken by a failover stays broken until you call `close_old_connections()` (Celery's Django fixup does this around each task).

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj34a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Three ways to hold connections: churn, persistent, pooled</text>
  <rect x="20" y="40" width="270" height="250" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="155" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">CONN_MAX_AGE = 0 (default)</text>
  <text x="155" y="86" text-anchor="middle" fill="#334155">request 1: connect, query, close</text>
  <text x="155" y="104" text-anchor="middle" fill="#334155">request 2: connect, query, close</text>
  <text x="155" y="122" text-anchor="middle" fill="#334155">request 3: connect, query, close</text>
  <rect x="45" y="140" width="220" height="50" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="155" y="160" text-anchor="middle" fill="#1e293b">each connect: TCP + TLS + auth</text>
  <text x="155" y="178" text-anchor="middle" fill="#1e293b">+ Postgres forks a backend</text>
  <text x="155" y="215" text-anchor="middle" fill="#dc2626" font-weight="bold">cost: ms per request, DB CPU</text>
  <text x="155" y="235" text-anchor="middle" fill="#334155">count: only threads mid-request</text>
  <text x="155" y="270" text-anchor="middle" fill="#334155">fine at low traffic</text>
  <rect x="305" y="40" width="270" height="250" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">CONN_MAX_AGE = 60 / None</text>
  <text x="440" y="86" text-anchor="middle" fill="#334155">thread keeps its connection</text>
  <text x="440" y="104" text-anchor="middle" fill="#334155">across requests until close_at</text>
  <rect x="330" y="122" width="220" height="68" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="440" y="142" text-anchor="middle" fill="#1e293b">worker: T1 conn, T2 conn,</text>
  <text x="440" y="160" text-anchor="middle" fill="#1e293b">T3 conn, T4 conn</text>
  <text x="440" y="178" text-anchor="middle" fill="#334155">even when T2..T4 are idle</text>
  <text x="440" y="215" text-anchor="middle" fill="#16a34a" font-weight="bold">no churn</text>
  <text x="440" y="235" text-anchor="middle" fill="#dc2626">count = processes x threads</text>
  <text x="440" y="255" text-anchor="middle" fill="#334155">add CONN_HEALTH_CHECKS=True</text>
  <rect x="590" y="40" width="270" height="250" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="725" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Pool (Django 5.1+) / PgBouncer</text>
  <text x="725" y="86" text-anchor="middle" fill="#334155">threads borrow on first query,</text>
  <text x="725" y="104" text-anchor="middle" fill="#334155">return at request end</text>
  <rect x="615" y="122" width="220" height="68" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="725" y="142" text-anchor="middle" fill="#1e293b">psycopg pool: per process</text>
  <text x="725" y="160" text-anchor="middle" fill="#1e293b">PgBouncer: shared across</text>
  <text x="725" y="178" text-anchor="middle" fill="#1e293b">all pods (txn mode)</text>
  <text x="725" y="215" text-anchor="middle" fill="#16a34a" font-weight="bold">no churn, bounded count</text>
  <text x="725" y="235" text-anchor="middle" fill="#334155">busy threads only</text>
  <text x="725" y="255" text-anchor="middle" fill="#334155">txn mode: no session state</text>
  <rect x="20" y="310" width="840" height="74" rx="10" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="40" y="332" fill="#1e293b" font-weight="bold">Connection budget (per DB alias)</text>
  <text x="40" y="352" fill="#334155">web pods x Gunicorn workers x threads  +  Celery pods x concurrency  +  beat, cron, migrations, admins</text>
  <text x="40" y="372" fill="#334155">must stay below max_connections minus reserved slots; PgBouncer turns the left side into "client" connections</text>
</svg>
```

### Native pooling in Django 5.1+

With `psycopg[pool]` installed and `"OPTIONS": {"pool": True}`, the PostgreSQL backend creates one `psycopg_pool.ConnectionPool` per process per alias. `connect()` borrows a connection from the pool; `close()` returns it instead of closing the socket. Because Django still "closes" at the end of each request (pooling requires `CONN_MAX_AGE = 0`; Django raises `ImproperlyConfigured` if you combine pooling with persistent connections), an idle thread holds nothing. You can pass pool options as a dict: `{"pool": {"min_size": 2, "max_size": 10, "timeout": 10}}`. When all connections are busy, a thread waits up to `timeout` seconds and then raises `PoolTimeout` — backpressure instead of overwhelming PostgreSQL.

The pool is still **per process**. With 80 Gunicorn processes and `max_size=10`, the ceiling is 800. Pooling solves churn and idle waste inside a process; PgBouncer solves the fleet-wide count.

### PgBouncer and transaction mode

In **transaction pooling** mode, PgBouncer assigns a server connection to a client only for the duration of a transaction; between transactions (and in autocommit, between statements) the server connection may serve someone else. That breaks anything that relies on session state persisting: `SET` statements, session-level advisory locks, `LISTEN/NOTIFY`, temporary tables, and **server-side cursors** — which Django uses for `QuerySet.iterator()` on PostgreSQL. A named cursor declared outside a transaction is gone when the next `FETCH` lands on a different server connection, and you see `cursor "_django_curs_..." does not exist`. The fix is `DISABLE_SERVER_SIDE_CURSORS = True` on that alias (iterator then streams via client-side fetching in chunks, using more memory). Django's own per-connection setup (time zone, isolation level) is applied on connect, which with PgBouncer means on the *client* connection — so make sure PgBouncer's server connections are consistent (same `timezone` in `postgresql.conf` and UTC everywhere is the safe default).

### Read replicas and routers

Django sends every query through `django.db.router`, a `ConnectionRouter` that iterates `DATABASE_ROUTERS`. For reads, `QuerySet.db` asks `router.db_for_read(model, **hints)`; for writes (`save`, `delete`, `update`, `bulk_create`), `router.db_for_write`. The first router that returns a non-`None` value wins; if all return `None`, Django falls back to the instance's `_state.db` (when an instance hint is present) or `"default"`. Explicit `.using()` always overrides the router.

A QuerySet created inside `transaction.atomic()` still asks the router; if your router sends reads to a replica, reads inside a transaction go to a different connection that is not part of that transaction and cannot see its uncommitted writes. Good routers check whether the primary is inside an atomic block and pin reads to it.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj34b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="dj34c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Router decisions and the read-your-writes trap</text>
  <rect x="20" y="50" width="180" height="70" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="110" y="74" text-anchor="middle" fill="#1e293b" font-weight="bold">QuerySet / save()</text>
  <text x="110" y="94" text-anchor="middle" fill="#334155">.using()? wins</text>
  <text x="110" y="110" text-anchor="middle" fill="#334155">else ask the router</text>
  <rect x="250" y="40" width="300" height="150" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="400" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">PrimaryReplicaRouter</text>
  <text x="265" y="86" fill="#334155">db_for_write: "default"</text>
  <text x="265" y="106" fill="#334155">db_for_read:</text>
  <text x="280" y="124" fill="#334155">in atomic() on default?  "default"</text>
  <text x="280" y="142" fill="#334155">pinned (wrote recently)? "default"</text>
  <text x="280" y="160" fill="#334155">else random replica</text>
  <text x="265" y="180" fill="#334155">allow_migrate: only "default"</text>
  <rect x="620" y="40" width="240" height="60" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="740" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">Primary ("default")</text>
  <text x="740" y="84" text-anchor="middle" fill="#334155">all writes, pinned reads</text>
  <rect x="620" y="130" width="240" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="740" y="154" text-anchor="middle" fill="#1e293b" font-weight="bold">Replica(s)</text>
  <text x="740" y="174" text-anchor="middle" fill="#334155">most reads, lag 10 ms .. seconds</text>
  <path d="M200,85 L248,95" stroke="#334155" stroke-width="2" marker-end="url(#dj34b)"/>
  <path d="M550,80 L618,72" stroke="#16a34a" stroke-width="2" marker-end="url(#dj34b)"/>
  <path d="M550,150 L618,158" stroke="#d97706" stroke-width="2" marker-end="url(#dj34b)"/>
  <path d="M740,100 L740,128" stroke="#94a3b8" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#dj34b)"/>
  <text x="750" y="118" fill="#334155" font-size="9">WAL streaming</text>
  <rect x="20" y="220" width="840" height="180" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="242" text-anchor="middle" fill="#1e293b" font-weight="bold">Without pinning: user edits profile, redirect shows the old name</text>
  <rect x="50" y="260" width="170" height="40" rx="6" fill="#ffffff" stroke="#94a3b8"/><text x="135" y="285" text-anchor="middle" fill="#1e293b">POST /profile</text>
  <rect x="270" y="260" width="170" height="40" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="355" y="285" text-anchor="middle" fill="#1e293b">UPDATE on primary</text>
  <rect x="490" y="260" width="170" height="40" rx="6" fill="#ffffff" stroke="#94a3b8"/><text x="575" y="285" text-anchor="middle" fill="#1e293b">302, GET /profile</text>
  <rect x="690" y="260" width="150" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="765" y="285" text-anchor="middle" fill="#1e293b">SELECT on replica</text>
  <path d="M220,280 L268,280" stroke="#334155" stroke-width="2" marker-end="url(#dj34b)"/>
  <path d="M440,280 L488,280" stroke="#334155" stroke-width="2" marker-end="url(#dj34b)"/>
  <path d="M660,280 L688,280" stroke="#dc2626" stroke-width="2" marker-end="url(#dj34c)"/>
  <text x="765" y="320" text-anchor="middle" fill="#dc2626" font-weight="bold">old row: lag not caught up</text>
  <text x="40" y="350" fill="#334155">Fixes: pin the user to the primary for N seconds after a write (cookie or cache key), read from the primary inside</text>
  <text x="40" y="368" fill="#334155">transactions and for "my own data" pages, or use .using("default") explicitly on read-after-write paths.</text>
  <text x="40" y="386" fill="#334155">Monitor lag (pg_stat_replication / replay_lag) and drop replicas that fall too far behind.</text>
</svg>
```

## 4. Architecture & Workflow

### The scaling ladder

```text
Stage 0  single Postgres, CONN_MAX_AGE=0          fix N+1, add indexes first (Ch 13, Ch 16)
Stage 1  reuse connections                         CONN_MAX_AGE=60 + CONN_HEALTH_CHECKS, or "pool": True (5.1+)
Stage 2  bound the fleet's connections             PgBouncer (transaction mode) + DISABLE_SERVER_SIDE_CURSORS
Stage 3  cache hot reads                           Redis cache, per-view / low-level (Ch 29)
Stage 4  read replicas                             DATABASE_ROUTERS, pinning after writes, lag monitoring
Stage 5  split by function                         analytics DB, separate DB for audit/events (allow_migrate per app)
Stage 6  partition data                            Postgres declarative partitioning, tenant-per-schema/DB, sharding
```

Do not skip stages. Most Django apps never need stage 6, and a replica added before connections are pooled just doubles the connection problem.

### Request flow with PgBouncer and replicas

```text
 Gunicorn pod ─┐                       ┌──► PgBouncer-primary  (pool_mode=transaction, default_pool_size≈20) ──► Postgres primary
 Gunicorn pod ─┼── DATABASES aliases ──┤
 Celery pod   ─┘   default / replica   └──► PgBouncer-replica  ───────────────────────────────────────────────► Postgres replica(s)
```

Each Django alias points at a PgBouncer host/port. Django sees "a database"; PgBouncer multiplexes many client connections to a small number of server connections per database/user pair.

## 5. Implementation

### Simple example: persistent connections and the native pool

```python
# settings.py — Option A: persistent connections (any Django version)
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "shop",
        "USER": "shop",
        "PASSWORD": os.environ["DB_PASSWORD"],
        "HOST": "db.internal",
        "PORT": "5432",
        "CONN_MAX_AGE": 60,              # reuse for up to 60 s
        "CONN_HEALTH_CHECKS": True,      # ping before reuse (4.1+)
        "OPTIONS": {"connect_timeout": 5},
    }
}
```

```python
# settings.py — Option B: native pool (Django 5.1+, pip install "psycopg[binary,pool]")
DATABASES = {
    "default": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "shop",
        "USER": "shop",
        "PASSWORD": os.environ["DB_PASSWORD"],
        "HOST": "db.internal",
        "CONN_MAX_AGE": 0,               # required with pooling
        "OPTIONS": {
            "pool": {"min_size": 2, "max_size": 8, "timeout": 10},
        },
    }
}
```

Verify what is happening from PostgreSQL's side:

```sql
SELECT usename, application_name, state, count(*)
FROM pg_stat_activity
WHERE datname = 'shop'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

```text
 usename | application_name |        state        | count
---------+------------------+---------------------+-------
 shop    |                  | idle                |   212
 shop    |                  | active              |    14
 shop    |                  | idle in transaction |     3
```

212 idle connections and 14 active ones is the classic signature of persistent connections with too many threads — a pool or PgBouncer would hold perhaps 20. "idle in transaction" rows are worse: a transaction left open (often a long `atomic()` around an external call) holding locks and preventing vacuum.

### Real-world example: primary + replicas with pinning

```python
# settings.py
DATABASES = {
    "default": {  # primary, via PgBouncer
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "shop", "USER": "shop", "PASSWORD": os.environ["DB_PASSWORD"],
        "HOST": "pgbouncer-primary", "PORT": "6432",
        "CONN_MAX_AGE": 60, "CONN_HEALTH_CHECKS": True,
        "DISABLE_SERVER_SIDE_CURSORS": True,           # PgBouncer transaction mode
    },
    "replica": {
        "ENGINE": "django.db.backends.postgresql",
        "NAME": "shop", "USER": "shop_ro", "PASSWORD": os.environ["DB_RO_PASSWORD"],
        "HOST": "pgbouncer-replica", "PORT": "6432",
        "CONN_MAX_AGE": 60, "CONN_HEALTH_CHECKS": True,
        "DISABLE_SERVER_SIDE_CURSORS": True,
        "TEST": {"MIRROR": "default"},                 # tests: replica = primary
    },
}
DATABASE_ROUTERS = ["core.db.PrimaryReplicaRouter"]
REPLICA_PIN_SECONDS = 5
```

```python
# core/db.py
import random
from contextvars import ContextVar
from django.db import connections

# Set per request by middleware; contextvars work for both WSGI threads and ASGI tasks.
_pinned: ContextVar[bool] = ContextVar("pinned_to_primary", default=False)

REPLICAS = ["replica"]

def pin_to_primary() -> None:
    _pinned.set(True)

class PrimaryReplicaRouter:
    def db_for_read(self, model, **hints):
        if _pinned.get() or connections["default"].in_atomic_block:
            return "default"            # read-your-writes, and consistency inside transactions
        return random.choice(REPLICAS)

    def db_for_write(self, model, **hints):
        pin_to_primary()                # any write pins the rest of this request
        return "default"

    def allow_relation(self, obj1, obj2, **hints):
        # Primary and replica hold the same data, so relations between them are fine.
        return {obj1._state.db, obj2._state.db} <= {"default", *REPLICAS}

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        return db == "default"          # never run migrations against replicas
```

```python
# core/middleware.py
from django.conf import settings
from .db import _pinned, pin_to_primary

PIN_COOKIE = "pin_primary"

class ReplicaPinningMiddleware:
    """Keep a user on the primary for a few seconds after they write."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        token = _pinned.set(False)
        try:
            if request.COOKIES.get(PIN_COOKIE) or request.method not in ("GET", "HEAD", "OPTIONS"):
                pin_to_primary()
            response = self.get_response(request)
            if _pinned.get() and request.method not in ("GET", "HEAD", "OPTIONS"):
                response.set_cookie(PIN_COOKIE, "1", max_age=settings.REPLICA_PIN_SECONDS,
                                    httponly=True, samesite="Lax", secure=True)
            return response
        finally:
            _pinned.reset(token)
```

Explicit routing where intent matters more than policy:

```python
# Reports can tolerate lag: always replica.
monthly = Order.objects.using("replica").filter(created_at__gte=start).aggregate(total=Sum("total"))

# Payment confirmation must see the latest state: always primary.
payment = Payment.objects.using("default").select_for_update().get(pk=pid)

# Instances remember their DB; saving an object loaded from the replica still goes through
# db_for_write, which returns "default" here.
order = Order.objects.using("replica").get(pk=7)
order._state.db      # 'replica'
order.save()          # router.db_for_write -> 'default'
```

Migrations per alias:

```bash
python manage.py migrate                     # default only (router allow_migrate)
python manage.py migrate --database=analytics
python manage.py dbshell --database=replica
```

### Functional split: a separate analytics database

```python
class AnalyticsRouter:
    app = "analytics"

    def db_for_read(self, model, **hints):
        return "analytics" if model._meta.app_label == self.app else None

    def db_for_write(self, model, **hints):
        return "analytics" if model._meta.app_label == self.app else None

    def allow_relation(self, obj1, obj2, **hints):
        a, b = obj1._meta.app_label == self.app, obj2._meta.app_label == self.app
        return None if not (a or b) else a and b     # no FKs across databases

    def allow_migrate(self, db, app_label, model_name=None, **hints):
        if app_label == self.app:
            return db == "analytics"
        return None if db == "default" else False

DATABASE_ROUTERS = ["core.db.AnalyticsRouter", "core.db.PrimaryReplicaRouter"]
```

> **Gotcha:** Django does not support foreign keys or joins across databases. A `ForeignKey` from an `analytics` model to `auth.User` in `default` cannot be enforced by the DB and cannot be traversed in a single query; store `user_id` as a plain integer (`db_constraint=False` on the FK at minimum) and join in Python.

### Multi-tenancy patterns

```python
# Pattern 1: shared schema, tenant column (simplest, scales to many tenants)
class TenantScopedManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(tenant_id=current_tenant_id())

class Invoice(models.Model):
    tenant = models.ForeignKey("tenants.Tenant", on_delete=models.CASCADE, db_index=True)
    number = models.CharField(max_length=32)
    objects = TenantScopedManager()
    all_tenants = models.Manager()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["tenant", "number"], name="uniq_invoice_per_tenant")]
        indexes = [models.Index(fields=["tenant", "-id"])]
```

```python
# Pattern 3: database per tenant (or per shard), chosen per request
from contextvars import ContextVar
_tenant_db: ContextVar[str] = ContextVar("tenant_db", default="default")

class TenantShardRouter:
    def db_for_read(self, model, **hints):
        return _tenant_db.get() if model._meta.app_label in TENANT_APPS else None
    db_for_write = db_for_read

    def allow_migrate(self, db, app_label, **hints):
        if app_label in TENANT_APPS:
            return db.startswith("shard_")
        return db == "default"

# middleware: tenant = resolve(request.get_host()); _tenant_db.set(tenant.shard_alias)
```

| Pattern | Isolation | Migrations | Tenant count | Cross-tenant queries |
|---|---|---|---|---|
| Shared schema + `tenant_id` | Row-level (app enforced; add Postgres RLS for defence in depth) | One run | Unlimited | Easy |
| Schema per tenant (django-tenants) | Schema (`search_path`) | Once per schema — slow at thousands | Hundreds to low thousands | Hard |
| Database per tenant / shard | Strong | Per database | Limited by ops | Very hard |

See [Database Design · Case: Multi-Tenant SaaS](../database-design/topic.html?p=40-case-multi-tenant-saas) and [Database Design · Sharding](../database-design/topic.html?p=12-sharding).

## 6. Advantages, Disadvantages & Trade-offs

| Technique | Solves | Costs | Gotchas |
|---|---|---|---|
| `CONN_MAX_AGE > 0` | Connect overhead | Connections = processes × threads | Stale connections after failover (use health checks) |
| Native pool (5.1+) | Churn + idle threads | Per-process ceiling, needs psycopg 3 | Not with persistent connections; `PoolTimeout` under load |
| PgBouncer transaction mode | Fleet-wide connection count | Extra hop, ops | No session state; disable server-side cursors |
| PgBouncer session mode | Connection storms on deploy | Little multiplexing | Same count as clients when all busy |
| Read replicas + router | Read throughput, isolation of reports | Lag, more connections, router complexity | Read-your-writes, reads inside atomic |
| Functional split | Noisy workloads | No cross-DB joins/FKs | `allow_migrate` mistakes |
| Sharding / DB-per-tenant | Write throughput, data size | Huge complexity | Cross-shard queries, rebalancing |

### When to use

- Persistent connections or the pool for any production deployment with steady traffic.
- PgBouncer when total connections across pods approach a few hundred, or with autoscaling fleets.
- Replicas when read load dominates *after* caching and query fixes, or to isolate heavy reporting.
- Shared-schema multi-tenancy by default; schemas or databases only for strong isolation requirements.

### When NOT to use

- Replicas to fix slow queries — a slow query is slow on a replica too.
- Transaction-mode PgBouncer with code that needs `SET`, advisory locks held across transactions, `LISTEN`, or server-side cursors.
- `CONN_MAX_AGE = None` with many threads and no pooler.
- Sharding before exhausting vertical scaling, partitioning and caching.

## 7. Common Mistakes & Best Practices

**Persistent connections with threaded or async servers and no budget.** `--threads 16` × 40 pods × `CONN_MAX_AGE=None` = 640 mostly idle connections. Do the arithmetic; use the pool or PgBouncer.

**Expecting `CONN_MAX_AGE` to work in async views.** Under ASGI, each request's sync ORM work runs via `sync_to_async`, and persistent connections have historically been unreliable there; the Django docs recommend `CONN_MAX_AGE = 0` under ASGI and an external pooler or the native pool instead.

**Long transactions around external calls.** `with atomic(): charge_card(); order.save()` holds a connection (and locks) for the duration of the HTTP call — in PgBouncer transaction mode, it also holds a *server* connection. Do I/O outside transactions.

**Router that ignores transactions.** Reading from the replica inside `atomic()` returns data that does not include your own uncommitted writes, and `select_for_update()` routed to a replica fails (replicas are read-only). Check `in_atomic_block` and route locking reads to the primary.

**Running migrations against replicas.** Without `allow_migrate`, `migrate --database=replica` will try DDL on a read-only server. Restrict migrations to the primary alias.

**Assuming objects carry their DB on save.** With no router, an object loaded via `.using("replica")` saves back to `"replica"` (its `_state.db`) and fails. Always have `db_for_write` return the primary.

**Forgetting `TEST: {"MIRROR": "default"}`.** The test runner creates a separate test DB for the replica alias, which is empty — tests reading via the router see nothing.

**Best practices**

- Write down the connection budget per alias and alert at 70–80% of `max_connections`.
- Set `statement_timeout` and `idle_in_transaction_session_timeout` in PostgreSQL (or via `OPTIONS: {"options": "-c statement_timeout=5000"}`, which in PgBouncer transaction mode should be set on the role instead).
- Monitor replica lag; remove replicas that exceed a threshold from rotation.
- Route by *intent* in code that cares (`using("default")` for read-after-write, `using("replica")` for reports).

## 8. Production: Pitfalls, Debugging & Scaling

> **Production story:** After moving to PgBouncer transaction mode, a nightly export job failed with `cursor "_django_curs_140234_sync_1" does not exist`. Root cause: `QuerySet.iterator()` uses a named server-side cursor, and the next `FETCH` landed on a different server connection. Fix: `DISABLE_SERVER_SIDE_CURSORS = True`, or wrap the iteration in `atomic()` so the whole loop is one transaction pinned to one server connection (at the cost of a long transaction).

**`too many clients already` during deploys.** Rolling deploys briefly run old and new pods together, doubling connections. Budget for surge (`maxSurge`), and put PgBouncer in front so client spikes queue instead of failing.

**First request after a failover errors.** Persistent connections point at the dead primary; the first query raises `OperationalError`. Enable `CONN_HEALTH_CHECKS`, use a DNS name or PgBouncer that follows the failover, and keep connect timeouts short.

**Pool exhaustion (`PoolTimeout`).** All pool connections are busy — usually slow queries or long transactions, not too few connections. Find them in `pg_stat_activity` (`state`, `xact_start`, `query`) before raising `max_size`.

**Stale reads reported by users.** Measure lag (`SELECT now() - pg_last_xact_replay_timestamp();` on the replica; `replay_lag` in `pg_stat_replication` on the primary). Correlate with write bursts (bulk imports, big migrations). Pin sessions after writes; send critical reads to the primary.

**Celery workers holding broken connections.** Workers do not get `request_finished`; Celery's fixup closes connections around tasks, but long loops inside a task should call `close_old_connections()` periodically.

**Debugging toolkit**

- `connection.queries` / `connection.vendor` / `connections.all()` in a shell to see which alias was used.
- `QuerySet.db` tells you which alias a queryset will use *before* evaluating it.
- `pg_stat_activity`, `pg_stat_statements`, and PgBouncer's `SHOW POOLS; SHOW CLIENTS;` admin console.
- django-debug-toolbar's SQL panel shows the alias per query.
- See [Database Design · Bottleneck Diagnosis](../database-design/topic.html?p=23-bottleneck-diagnosis) and [Database Design · Database Scaling](../database-design/topic.html?p=21-database-scaling).

## 9. Interview Questions

**Q: What does `CONN_MAX_AGE` do, and what are the trade-offs of 0, 60 and `None`?**
A: It controls how long Django keeps a database connection open after a request. `0` (the default) closes the connection at the end of every request, so each request pays connect overhead (TCP, TLS, auth, a new PostgreSQL backend process). A positive number reuses the connection for that many seconds, removing churn; `None` keeps it forever. The cost of persistence is that every thread holds a connection even when idle, so the total count becomes processes × threads, and a connection broken by a failover is only discovered at use unless `CONN_HEALTH_CHECKS` is on. Recycling happens only at request start/end, so non-request code must call `close_old_connections()`.

**Q: How many database connections can a Django deployment open?**
A: Django keeps one connection per thread per database alias, opened lazily. So the ceiling for web is pods × Gunicorn workers × threads per worker per alias, plus Celery pods × concurrency, plus beat, cron jobs, management commands and admin sessions. With persistent connections that ceiling is approached even at low load; with `CONN_MAX_AGE = 0` or pooling, only threads that are mid-request hold one. You compare that total against PostgreSQL's `max_connections` minus reserved slots and use PgBouncer when it does not fit.

**Q: What connection pooling options exist for Django on PostgreSQL?**
A: Django 5.1+ has native pooling with psycopg 3: `"OPTIONS": {"pool": True}` or a dict of `psycopg_pool` options like `min_size`, `max_size`, `timeout`. It is per process and requires `CONN_MAX_AGE = 0`. Before 5.1 there was no in-process pool, only persistent connections. The external option is PgBouncer, which pools across the whole fleet; transaction mode gives the most multiplexing but forbids session state. Many production setups use both: a small per-process pool or persistent connections to PgBouncer, and PgBouncer to PostgreSQL.

**Q: What breaks when you put PgBouncer in transaction mode in front of Django?**
A: Anything that assumes the same server connection across transactions: session-level `SET` commands, session advisory locks, `LISTEN/NOTIFY`, temporary tables and server-side cursors. Django uses named server-side cursors for `QuerySet.iterator()` on PostgreSQL, which fail with "cursor does not exist" when the next fetch lands on a different backend, so you set `DISABLE_SERVER_SIDE_CURSORS = True`. Settings Django applies at connect time should be consistent at the server level. Long transactions also pin server connections, so keep transactions short.

**Q: How do database routers work?**
A: `DATABASE_ROUTERS` is a list of classes; Django asks each in order and uses the first non-`None` answer. `db_for_read(model, **hints)` and `db_for_write(model, **hints)` choose an alias for reads and writes, `allow_relation(obj1, obj2)` decides whether a relation between objects on different databases is permitted, and `allow_migrate(db, app_label, model_name)` controls which migrations run on which alias. Hints include `instance` for operations on an existing object. Explicit `.using()` and `save(using=...)` override routers.

**Q: How would you set up read replicas in Django?**
A: Add a second alias for each replica in `DATABASES` (read-only user, `TEST: {"MIRROR": "default"}` so tests use the primary), and a router whose `db_for_write` returns `"default"`, `db_for_read` returns a replica, `allow_relation` returns `True` for objects in the same replica set, and `allow_migrate` only allows the primary. Then deal with lag: read from the primary inside transactions and for a few seconds after a user writes (pinning via cookie or contextvar), and route reports explicitly to replicas with `.using()`. Monitor lag and remove lagging replicas.

**Q: What is the read-your-writes problem with replicas and how do you fix it?**
A: A user writes to the primary, gets redirected, and the next request reads from a replica that has not yet replayed the change, so the page shows stale data. Replication is asynchronous by default, so lag of milliseconds to seconds is normal. Fixes: pin the user to the primary for a short window after any write (cookie, session or cache flag consulted by the router), always read the user's own data from the primary, read from the primary inside `atomic()`, or in extreme cases use synchronous replication or wait for a specific WAL position. The cheapest robust fix is time-based pinning.

**Q: Can you have a ForeignKey between models on different databases?**
A: No — Django does not support cross-database relations. The database cannot enforce a constraint across servers and the ORM cannot JOIN across connections, so a router's `allow_relation` should return `False` for such pairs. Store the foreign ID as a plain field (or a FK with `db_constraint=False` if both live in the same physical database under different aliases) and resolve it with a second query. This is the main reason functional splits must be planned along domain boundaries.

**Q: How does Django handle connections in Celery workers or management commands?**
A: The same per-thread connection model applies, but there are no `request_started`/`request_finished` signals, so `CONN_MAX_AGE` and health checks are never applied automatically. Celery's Django fixup closes stale connections before and after each task. A long-running command or loop should call `django.db.close_old_connections()` periodically so that a connection killed by a failover or idle timeout is replaced. Budget Celery's connections too: each prefork child has its own.

**Q: Your PostgreSQL primary has 900 connections, mostly idle, and new pods fail to connect. Walk me through fixing it. (Senior)**
A: First quantify from `pg_stat_activity`: grouped by application, state and client address, which shows persistent connections from many threads plus maybe some `idle in transaction`. Short term: reduce `CONN_MAX_AGE` or threads, kill idle-in-transaction sessions, and set `idle_in_transaction_session_timeout`. Structural fix: put PgBouncer in transaction mode in front (with `DISABLE_SERVER_SIDE_CURSORS`), size its server pool to what PostgreSQL handles well (on the order of a few times CPU cores for active work), and optionally enable Django 5.1's pool for per-process reuse. Then write the connection budget into the deployment config, budget deploy surges, and alert at 70–80% of `max_connections`.

**Q: Design a router that sends reads to replicas without ever showing users stale data for their own actions. (Senior)**
A: Writes always go to the primary. Reads go to the primary when the primary connection is inside an atomic block, when the request is a write method, or when the user is pinned; otherwise to a healthy replica. Pinning is set on every write and persisted for a few seconds beyond the expected lag via a cookie (stateless) or a cache key per user; state for the current request lives in a `ContextVar` so it is safe under threads and ASGI. Health checking removes replicas whose lag exceeds a threshold. Celery tasks triggered by a write read from the primary (the task was dispatched on commit, but replicas may lag), and reports use `.using("replica")` explicitly. Tests use `MIRROR` so routing does not change behaviour.

**Q: How would you scale writes beyond a single PostgreSQL primary in a Django app? (Senior)**
A: First make sure it is really a write problem: batch writes (`bulk_create`, `update()`), move non-critical writes to async pipelines, partition large tables (PostgreSQL declarative partitioning, invisible to the ORM aside from constraints), and scale the primary vertically. If it still does not fit, partition data along a key that most requests are scoped to — usually tenant or user. In Django, implement it with a router reading the shard alias from a `ContextVar` set by middleware, one `DATABASES` alias per shard, `allow_migrate` applying tenant apps to every shard, and a directory (tenant → shard) in a small global database. Accept that cross-shard queries, uniqueness and transactions become application problems, and plan rebalancing from day one — or adopt Citus, which shards PostgreSQL behind one endpoint.

**Q: What are the multi-tenancy options in Django and how do you choose? (Senior)**
A: Shared schema with a `tenant_id` column on every tenant table, enforced by managers/middleware and ideally PostgreSQL row-level security, is simplest, scales to huge tenant counts and keeps one migration run. Schema-per-tenant (django-tenants sets `search_path` per request) gives stronger isolation and easy per-tenant backup, but migrations run once per schema and catalog bloat limits you to hundreds or low thousands of tenants. Database-per-tenant gives the strongest isolation and noisy-neighbour protection but the highest ops cost. Choose by isolation and compliance requirements, tenant count and size skew; a common hybrid is shared schema for most tenants and dedicated databases for the largest.

## 10. Quick Revision & Cheat Sheet

| Setting / API | Meaning | Default / note |
|---|---|---|
| `CONN_MAX_AGE` | Seconds to keep a connection after a request | `0` (close each request); `None` = forever |
| `CONN_HEALTH_CHECKS` | Ping persistent connection before reuse | `False`; Django 4.1+ |
| `OPTIONS["pool"]` | Native psycopg 3 pool | Django 5.1+, PostgreSQL only, needs `CONN_MAX_AGE=0` |
| `DISABLE_SERVER_SIDE_CURSORS` | `iterator()` without named cursors | Needed with PgBouncer transaction mode |
| `DATABASE_ROUTERS` | Routing policy | First non-None answer wins |
| `db_for_read` / `db_for_write` | Alias per operation | Fallback: instance's `_state.db` or `default` |
| `allow_relation` / `allow_migrate` | Cross-DB relations / where migrations run | Forbid cross-DB FKs; migrate primary only |
| `.using()` / `save(using=)` | Explicit alias | Overrides routers |
| `TEST["MIRROR"]` | Replica alias uses primary's test DB | Prevents empty replica in tests |
| `close_old_connections()` | Recycle stale/broken connections | Call in non-request loops |

- One connection per thread per alias; count = processes × threads.
- Persistent connections remove churn but increase idle count.
- Pool (5.1+) is per process; PgBouncer is fleet-wide.
- Transaction-mode PgBouncer: no session state, no server-side cursors.
- Replicas mean lag: pin after writes, primary inside transactions.
- No FKs or joins across databases.
- Fix queries and cache before adding replicas; replicas before shards.
- Write down and alert on the connection budget.

## 11. Hands-On Exercises

Setup: `python -m venv .venv && pip install "django~=5.2" "psycopg[binary,pool]"`; run PostgreSQL with `docker run -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16`.

1. **Churn vs reuse.** Load-test a view doing one query with `CONN_MAX_AGE=0`, then `60`, then `"pool": True`; compare latency and watch `pg_stat_activity` counts.
2. **Thread math.** Run Gunicorn with `--workers 2 --threads 8` and `CONN_MAX_AGE=None`; hit it concurrently and count connections. Switch to the pool and count again.
3. **PgBouncer.** Run PgBouncer in transaction mode (e.g. the `edoburu/pgbouncer` image), iterate a large queryset with `.iterator()`, reproduce the cursor error, fix with `DISABLE_SERVER_SIDE_CURSORS`.
4. **Replica router.** Simulate a replica with a second alias pointing at the same DB but a different user; implement the router and log which alias each query uses (`QuerySet.db`). Add pinning middleware and test it with the test client.
5. **Cross-DB FK.** Put a model in an `analytics` alias with a FK to `User` and observe the error; refactor to a plain `user_id`.

**Mini project:** a multi-tenant notes app with shared-schema tenancy (tenant resolved from subdomain, scoped manager, unique constraints including tenant), a primary/replica router with pinning, PgBouncer in docker-compose, a documented connection budget, and tests proving that a user always sees their own edits immediately.

## 12. Related Topics & Free Learning Resources

- [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization) — fix queries before scaling infrastructure.
- [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) — `atomic(using=...)`, locks on the primary.
- [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres) — partial indexes, partitioning-friendly constraints.
- [Ch 29 · Caching in Django](topic.html?p=29-caching) — the cheaper alternative to replicas.
- [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production) — worker counts drive connection counts.
- [Database Design · Replication](../database-design/topic.html?p=09-replication), [Database Design · Consistency Models](../database-design/topic.html?p=10-consistency-models), [Database Design · Pools, Timeouts & Storms](../database-design/topic.html?p=20-database-application-architecture), [Database Design · Sharding](../database-design/topic.html?p=12-sharding), [Database Design · Case: Multi-Tenant SaaS](../database-design/topic.html?p=40-case-multi-tenant-saas).
- [System Design · Database Scaling](../system-design/topic.html?p=16-database-scaling).

- **Databases: persistent connections and pooling** — Django docs · *Intermediate* · `CONN_MAX_AGE`, health checks, the PostgreSQL connection pool and server-side cursor notes. <https://docs.djangoproject.com/en/5.2/ref/databases/>
- **Multiple databases** — Django docs · *Intermediate* · routers, `using()`, cross-database limitations, the primary/replica example. <https://docs.djangoproject.com/en/5.2/topics/db/multi-db/>
- **PgBouncer features** — PgBouncer · *Intermediate* · what works in session vs transaction pooling. <https://www.pgbouncer.org/features.html>
- **psycopg 3 connection pools** — psycopg docs · *Advanced* · pool sizing, timeouts and behaviour. <https://www.psycopg.org/psycopg3/docs/advanced/pool.html>
- **PostgreSQL: Monitoring Database Activity** — PostgreSQL docs · *Intermediate* · `pg_stat_activity` and replication views. <https://www.postgresql.org/docs/current/monitoring-stats.html>
- **django-tenants** — GitHub · *Advanced* · schema-per-tenant multi-tenancy for PostgreSQL. <https://github.com/django-tenants/django-tenants>

---

*Django Handbook — chapter 34.*
