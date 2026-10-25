# 35 · Deployment & Production Operations

> **In one line:** Production Django is a small fleet of cooperating processes — an application server sized to its workload, a proxy in front, static files off the app server, migrations as a separate release step, and settings, logging, health checks and graceful shutdown designed so that deploys are boring and failures are visible.

---

## 1. Overview

> **Builds on:** [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings), [Ch 20 · Static & Media Files](topic.html?p=20-static-media-files), [Ch 28 · Security: CSRF, XSS, SQL Injection & Hardening](topic.html?p=28-security), [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi), [Ch 34 · Scaling Django: Connections, Replicas & Multiple Databases](topic.html?p=34-scaling-databases).

`python manage.py runserver` is a single-process development server: it auto-reloads, serves static files when `DEBUG=True`, has not been security-audited, and the Django docs say plainly not to use it in production. The first "deployment" many people make is exactly that — `runserver 0.0.0.0:8000` on a VM — and it fails in predictable ways: one slow request blocks others, a crash takes the site down until someone SSHes in, `DEBUG=True` leaks settings and stack traces to anyone who triggers an error, and static files are served by Python at a fraction of a proper server's speed.

A production deployment replaces each piece with something designed for the job. An **application server** (Gunicorn for WSGI, uvicorn/Daphne for ASGI) runs several worker processes, restarts crashed ones, and enforces timeouts. A **reverse proxy** (Nginx, or a cloud load balancer / Kubernetes Ingress) terminates TLS, buffers slow clients so they do not tie up Python workers, and serves or forwards static files. **Static files** are collected at build time and served by WhiteNoise, Nginx or a CDN; **media files** go to object storage. **Settings** come from the environment, with `DEBUG=False`, a strict `ALLOWED_HOSTS` and the HTTPS hardening flags. **Migrations** run once per release as a separate step, not on every container start. **Logs** go to stdout as structured lines, **errors** go to Sentry, and **health checks** tell the orchestrator when a process is alive and when it is ready for traffic.

None of this is exotic, which is exactly why interviewers ask about it: "how many Gunicorn workers would you run?", "why not run migrations in the container entrypoint?", "what does `SECURE_PROXY_SSL_HEADER` do?", "how do you deploy without downtime?". This chapter answers those with the mechanics behind them. Container and cluster depth lives in the [Docker](../docker/topic.html?p=30-lab-production-dockerfile) and [Kubernetes](../kubernetes/topic.html?p=29-lab-zero-downtime-rollout) handbooks.

## 2. Core Concepts

- **WSGI / ASGI application** — `proj.wsgi.application` (`WSGIHandler`) or `proj.asgi.application` (`ASGIHandler`). *Why it matters:* this callable is what the application server imports; choose by whether you need async/WebSockets.
- **Gunicorn** — pre-fork WSGI server: a master process that forks N workers and supervises them. *Why:* crash recovery, timeouts, graceful reloads and signals for free.
- **Worker class** — `sync` (default, one request at a time per process), `gthread` (threads per process), `gevent` (greenlets), `uvicorn_worker.UvicornWorker` (ASGI). *Why:* determines concurrency per process and how blocking I/O behaves.
- **Worker count** — starting point `2 × CPU cores + 1` for sync workers. *Why:* enough to overlap I/O waits without thrashing; tune by measurement.
- **`--timeout`** — seconds of silence before the master kills a worker (default 30). *Why:* stops hung requests, and is the reason long work belongs in Celery.
- **`--max-requests` / `--max-requests-jitter`** — recycle a worker after N requests. *Why:* contains slow memory leaks without restarts all at once.
- **Reverse proxy** — Nginx / ALB / Ingress in front of the app server. *Why:* TLS, buffering slow clients, request size limits, static files, connection limits.
- **`SECURE_PROXY_SSL_HEADER`** — tells Django which header signals the original request was HTTPS (e.g. `("HTTP_X_FORWARDED_PROTO", "https")`). *Why:* behind a TLS-terminating proxy Django otherwise thinks every request is HTTP — redirect loops, insecure URLs, CSRF origin failures.
- **`DEBUG = False`** — disables debug pages and requires `ALLOWED_HOSTS`. *Why:* debug pages leak settings and code; Django refuses to serve unknown hosts.
- **`STORAGES`** (4.2+) — the setting configuring the `default` (media) and `staticfiles` storages, replacing `DEFAULT_FILE_STORAGE`/`STATICFILES_STORAGE`. *Why:* manifest-hashed static files and S3 media are configured here.
- **WhiteNoise** — middleware serving compressed, cache-busted static files from the app. *Why:* simplest correct static serving in containers; pair with a CDN for scale.
- **Release step** — a one-off job that runs `migrate` (and other one-time tasks) before new code takes traffic. *Why:* concurrent migrations from many containers race and lock tables.
- **Expand/contract migrations** — split breaking schema changes into backwards-compatible steps across deploys. *Why:* during a rolling deploy, old and new code run against the same schema.
- **Liveness vs readiness probes** — "is the process alive?" vs "can it serve traffic now?". *Why:* a DB outage should stop traffic (readiness), not restart every pod (liveness).
- **Graceful shutdown** — on SIGTERM, stop accepting, finish in-flight requests, exit. *Why:* zero-downtime deploys depend on it.
- **Structured logging** — JSON lines to stdout via `LOGGING`. *Why:* containers collect stdout; JSON is searchable.
- **Sentry** — error tracking with stack traces, request context and releases. *Why:* emails from `ADMINS` do not scale; you need grouping, alerting and release correlation.

## 3. Theory & Principles

### How Gunicorn serves Django

When you run `gunicorn proj.wsgi:application --workers 5`, the **master** process imports nothing by default (unless `--preload`), binds the socket, and forks five **workers**. Each worker imports `proj.wsgi`, which calls `get_wsgi_application()` → `django.setup()` (load settings, configure logging, populate the app registry) and builds a `WSGIHandler`, whose `BaseHandler.load_middleware()` builds the middleware chain once. Each worker then loops: `accept()` a connection from the shared socket, parse the HTTP request, call `application(environ, start_response)`, write the response. With the sync worker class, one worker handles exactly one request at a time.

The master supervises: workers send a heartbeat by touching a temp file; if a worker is silent for longer than `--timeout`, the master kills it (you see `WORKER TIMEOUT` and the request gets a 502 from the proxy) and forks a replacement. On SIGTERM, the master stops accepting and gives workers up to `--graceful-timeout` (default 30 s) to finish; on SIGHUP it reloads configuration and replaces workers gracefully.

**Sizing.** For sync workers the classic formula `2 × cores + 1` assumes requests are a mix of CPU and I/O waits (database, cache): while one worker waits on PostgreSQL, another uses the CPU. It is a starting point, not a law. Measure: if CPU is saturated at peak, more workers will not help; if CPU is idle while requests queue (most time in DB/HTTP waits), add workers or threads (`gthread`: e.g. 4 workers × 4 threads). Remember each worker is a full Python process with Django loaded (commonly on the order of 100–300 MB), and each thread holds its own database connection — so worker count drives both memory and the connection budget from [Ch 34](topic.html?p=34-scaling-databases). In containers, `cores` means the CPU limit of the container, not the host's core count.

**ASGI.** For async views or Channels, run uvicorn workers under Gunicorn — `gunicorn proj.asgi:application -k uvicorn_worker.UvicornWorker` (the `uvicorn-worker` package; older docs use `uvicorn.workers.UvicornWorker`) — or uvicorn directly with `--workers`. Each process runs an event loop and handles many concurrent connections; sync views still run in a thread via `sync_to_async`, so ASGI is not automatically faster for a sync codebase.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj35a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Production request path: proxy, Gunicorn master and workers, backing services</text>
  <rect x="20" y="170" width="100" height="60" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="70" y="195" text-anchor="middle" fill="#1e293b" font-weight="bold">Client</text>
  <text x="70" y="213" text-anchor="middle" fill="#334155">HTTPS</text>
  <rect x="150" y="60" width="170" height="280" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="235" y="84" text-anchor="middle" fill="#1e293b" font-weight="bold">Nginx / LB / Ingress</text>
  <text x="235" y="108" text-anchor="middle" fill="#334155">TLS termination</text>
  <text x="235" y="126" text-anchor="middle" fill="#334155">buffers slow clients</text>
  <text x="235" y="144" text-anchor="middle" fill="#334155">client_max_body_size</text>
  <text x="235" y="162" text-anchor="middle" fill="#334155">sets X-Forwarded-Proto</text>
  <text x="235" y="180" text-anchor="middle" fill="#334155">and X-Forwarded-For</text>
  <rect x="170" y="200" width="130" height="50" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="235" y="221" text-anchor="middle" fill="#1e293b">/static/ via CDN</text>
  <text x="235" y="238" text-anchor="middle" fill="#334155">or WhiteNoise</text>
  <text x="235" y="290" text-anchor="middle" fill="#334155">health checks</text>
  <text x="235" y="308" text-anchor="middle" fill="#334155">drains on deploy</text>
  <rect x="360" y="50" width="300" height="300" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="510" y="74" text-anchor="middle" fill="#1e293b" font-weight="bold">Gunicorn (one container / pod)</text>
  <rect x="380" y="88" width="260" height="56" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="510" y="108" text-anchor="middle" fill="#1e293b" font-weight="bold">master</text>
  <text x="510" y="126" text-anchor="middle" fill="#334155">binds :8000, forks, kills silent workers</text>
  <text x="510" y="139" text-anchor="middle" fill="#334155">(--timeout 30), SIGTERM: graceful</text>
  <rect x="380" y="160" width="120" height="80" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="440" y="180" text-anchor="middle" fill="#1e293b" font-weight="bold">worker 1</text>
  <text x="440" y="198" text-anchor="middle" fill="#334155">django.setup()</text>
  <text x="440" y="214" text-anchor="middle" fill="#334155">WSGIHandler</text>
  <text x="440" y="230" text-anchor="middle" fill="#334155">1 req (sync)</text>
  <rect x="520" y="160" width="120" height="80" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="580" y="180" text-anchor="middle" fill="#1e293b" font-weight="bold">worker N</text>
  <text x="580" y="198" text-anchor="middle" fill="#334155">2 x cores + 1</text>
  <text x="580" y="214" text-anchor="middle" fill="#334155">or gthread</text>
  <text x="580" y="230" text-anchor="middle" fill="#334155">or uvicorn</text>
  <text x="510" y="270" text-anchor="middle" fill="#334155">each worker: own memory, own DB connection(s)</text>
  <text x="510" y="290" text-anchor="middle" fill="#334155">--max-requests 1000 --max-requests-jitter 100</text>
  <text x="510" y="310" text-anchor="middle" fill="#334155">logs to stdout (JSON)</text>
  <rect x="700" y="60" width="160" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="780" y="90" text-anchor="middle" fill="#1e293b">PostgreSQL / PgBouncer</text>
  <rect x="700" y="125" width="160" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="780" y="155" text-anchor="middle" fill="#1e293b">Redis (cache, broker)</text>
  <rect x="700" y="190" width="160" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="780" y="220" text-anchor="middle" fill="#1e293b">S3 media (STORAGES)</text>
  <rect x="700" y="255" width="160" height="50" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="780" y="285" text-anchor="middle" fill="#1e293b">Sentry / log pipeline</text>
  <path d="M120,200 L148,200" stroke="#334155" stroke-width="2" marker-end="url(#dj35a)"/>
  <path d="M320,200 L358,200" stroke="#334155" stroke-width="2" marker-end="url(#dj35a)"/>
  <path d="M660,90 L698,85" stroke="#334155" stroke-width="1.5" marker-end="url(#dj35a)"/>
  <path d="M660,150 L698,150" stroke="#334155" stroke-width="1.5" marker-end="url(#dj35a)"/>
  <path d="M660,215 L698,215" stroke="#334155" stroke-width="1.5" marker-end="url(#dj35a)"/>
  <path d="M660,280 L698,280" stroke="#334155" stroke-width="1.5" marker-end="url(#dj35a)"/>
  <text x="20" y="385" fill="#334155">Without the proxy's buffering, a client on a slow mobile link holds a sync worker for the whole upload or download;</text>
  <text x="20" y="403" fill="#334155">with it, the worker hands the response to Nginx in milliseconds and moves on.</text>
</svg>
```

### Why the proxy and `SECURE_PROXY_SSL_HEADER` matter

TLS ends at the proxy, which then speaks plain HTTP to Gunicorn. From Django's point of view, `request.is_secure()` is `False` and `request.build_absolute_uri()` produces `http://` URLs. With `SECURE_SSL_REDIRECT = True`, Django redirects to HTTPS, the proxy forwards it as HTTP again, and you have an infinite redirect loop. CSRF origin checks against `https://` trusted origins fail too. Setting `SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")` tells Django to trust that header — **only safe if your proxy always sets or strips it**, otherwise any client can claim HTTPS. Similarly, `REMOTE_ADDR` is the proxy's IP; the real client IP is in `X-Forwarded-For`, which you parse taking into account how many trusted proxies are in front (never trust the leftmost value blindly — clients can forge it).

### Migrations in a rolling deploy

During a rolling update, old pods and new pods serve traffic at the same time, both against the same database. That has two consequences. First, migrations must run **exactly once, before** the new code serves traffic — as a Kubernetes Job, an init step in the pipeline, or a Heroku-style release phase — not in every container's entrypoint, where ten pods would race (Django's migration recorder is not a distributed lock, and on PostgreSQL concurrent DDL either blocks or fails). Second, every migration must be **compatible with the old code** still running. Dropping or renaming a column the old code reads breaks it mid-deploy. The **expand/contract** pattern solves it: release 1 adds the new column (nullable or with `db_default`) and writes both; a backfill copies data; release 2 reads the new column; release 3 removes the old field from the model and drops the column. See [Ch 11 · Migrations](topic.html?p=11-migrations) and [Database Design · Schema Evolution](../database-design/topic.html?p=27-schema-evolution).

## 4. Architecture & Workflow

### The CI/CD pipeline

The pipeline below is the release sequence you should be able to describe in an interview, with the migrate step separated from the rollout.

```svg
<svg viewBox="0 0 880 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj35b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Build once, migrate once, roll out gradually</text>
  <rect x="20" y="50" width="150" height="120" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="95" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">1. CI</text>
  <text x="95" y="94" text-anchor="middle" fill="#334155">lint, tests</text>
  <text x="95" y="112" text-anchor="middle" fill="#334155">makemigrations --check</text>
  <text x="95" y="130" text-anchor="middle" fill="#334155">check --deploy</text>
  <text x="95" y="148" text-anchor="middle" fill="#334155">pip-audit</text>
  <rect x="195" y="50" width="150" height="120" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="270" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">2. Build image</text>
  <text x="270" y="94" text-anchor="middle" fill="#334155">multi-stage, non-root</text>
  <text x="270" y="112" text-anchor="middle" fill="#334155">collectstatic at build</text>
  <text x="270" y="130" text-anchor="middle" fill="#334155">tag = git SHA</text>
  <text x="270" y="148" text-anchor="middle" fill="#334155">push to registry</text>
  <rect x="370" y="50" width="150" height="120" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="445" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">3. Release job</text>
  <text x="445" y="94" text-anchor="middle" fill="#334155">same image</text>
  <text x="445" y="112" text-anchor="middle" fill="#334155">manage.py migrate</text>
  <text x="445" y="130" text-anchor="middle" fill="#334155">runs exactly once</text>
  <text x="445" y="148" text-anchor="middle" fill="#334155">fail: stop pipeline</text>
  <rect x="545" y="50" width="150" height="120" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="620" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">4. Rolling update</text>
  <text x="620" y="94" text-anchor="middle" fill="#334155">new pod starts</text>
  <text x="620" y="112" text-anchor="middle" fill="#334155">readiness OK: traffic</text>
  <text x="620" y="130" text-anchor="middle" fill="#334155">old pod: SIGTERM,</text>
  <text x="620" y="148" text-anchor="middle" fill="#334155">drain, exit</text>
  <rect x="720" y="50" width="140" height="120" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="790" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">5. Verify</text>
  <text x="790" y="94" text-anchor="middle" fill="#334155">Sentry release</text>
  <text x="790" y="112" text-anchor="middle" fill="#334155">error rate, p95</text>
  <text x="790" y="130" text-anchor="middle" fill="#334155">auto rollback</text>
  <text x="790" y="148" text-anchor="middle" fill="#334155">to previous SHA</text>
  <path d="M170,110 L193,110" stroke="#334155" stroke-width="2" marker-end="url(#dj35b)"/>
  <path d="M345,110 L368,110" stroke="#334155" stroke-width="2" marker-end="url(#dj35b)"/>
  <path d="M520,110 L543,110" stroke="#334155" stroke-width="2" marker-end="url(#dj35b)"/>
  <path d="M695,110 L718,110" stroke="#334155" stroke-width="2" marker-end="url(#dj35b)"/>
  <rect x="20" y="200" width="840" height="140" rx="10" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="40" y="222" fill="#1e293b" font-weight="bold">During step 4 old and new code share one schema, so every migration must be backwards compatible</text>
  <rect x="40" y="236" width="190" height="80" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="135" y="256" text-anchor="middle" fill="#1e293b" font-weight="bold">Deploy A: expand</text>
  <text x="135" y="274" text-anchor="middle" fill="#334155">add nullable column</text>
  <text x="135" y="292" text-anchor="middle" fill="#334155">code writes old + new</text>
  <rect x="250" y="236" width="190" height="80" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="345" y="256" text-anchor="middle" fill="#1e293b" font-weight="bold">Backfill</text>
  <text x="345" y="274" text-anchor="middle" fill="#334155">batched, in Celery or</text>
  <text x="345" y="292" text-anchor="middle" fill="#334155">a management command</text>
  <rect x="460" y="236" width="190" height="80" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="555" y="256" text-anchor="middle" fill="#1e293b" font-weight="bold">Deploy B: switch</text>
  <text x="555" y="274" text-anchor="middle" fill="#334155">read new column</text>
  <text x="555" y="292" text-anchor="middle" fill="#334155">stop using old one</text>
  <rect x="670" y="236" width="170" height="80" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="755" y="256" text-anchor="middle" fill="#1e293b" font-weight="bold">Deploy C: contract</text>
  <text x="755" y="274" text-anchor="middle" fill="#334155">remove field,</text>
  <text x="755" y="292" text-anchor="middle" fill="#334155">drop column</text>
  <path d="M230,276 L248,276" stroke="#334155" stroke-width="1.5" marker-end="url(#dj35b)"/>
  <path d="M440,276 L458,276" stroke="#334155" stroke-width="1.5" marker-end="url(#dj35b)"/>
  <path d="M650,276 L668,276" stroke="#334155" stroke-width="1.5" marker-end="url(#dj35b)"/>
</svg>
```

### The processes you actually run

```text
role          command                                                         replicas   scales on
web           gunicorn proj.wsgi -c gunicorn.conf.py                          2..N       CPU / latency
asgi (opt.)   gunicorn proj.asgi -k uvicorn_worker.UvicornWorker              2..N       connections
worker        celery -A proj worker -Q default -c 8                           1..N       queue depth
beat          celery -A proj beat                                             exactly 1  -
release       python manage.py migrate --noinput                              1 per deploy (Job)
cron          python manage.py clearsessions                                  scheduled Job
```

## 5. Implementation

### Simple example: production settings

```python
# proj/settings/prod.py
import os
from .base import *  # noqa

DEBUG = False
SECRET_KEY = os.environ["DJANGO_SECRET_KEY"]                 # fail fast if missing
ALLOWED_HOSTS = os.environ["DJANGO_ALLOWED_HOSTS"].split(",")  # "shop.example.com,.internal"
CSRF_TRUSTED_ORIGINS = ["https://shop.example.com"]          # scheme required (4.0+)

# Behind a TLS-terminating proxy that ALWAYS sets X-Forwarded-Proto
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
SECURE_SSL_REDIRECT = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
SECURE_HSTS_SECONDS = 60 * 60 * 24 * 365   # start low (e.g. 3600) and raise once verified
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SECURE_HSTS_PRELOAD = True
SECURE_CONTENT_TYPE_NOSNIFF = True          # default True
SECURE_REFERRER_POLICY = "same-origin"
SECURE_REDIRECT_EXEMPT = [r"^healthz/$", r"^readyz/$"]   # probes hit pods over HTTP

STATIC_ROOT = BASE_DIR / "staticfiles"
STATIC_URL = "/static/"
STORAGES = {
    "default": {"BACKEND": "storages.backends.s3.S3Storage"},           # django-storages
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}

MIDDLEWARE.insert(1, "whitenoise.middleware.WhiteNoiseMiddleware")  # right after SecurityMiddleware

DATABASES["default"]["CONN_MAX_AGE"] = 60
DATABASES["default"]["CONN_HEALTH_CHECKS"] = True

CACHES = {"default": {"BACKEND": "django.core.cache.backends.redis.RedisCache",
                      "LOCATION": os.environ["REDIS_URL"]}}
```

```bash
DJANGO_SETTINGS_MODULE=proj.settings.prod python manage.py check --deploy --fail-level WARNING
```

```text
System check identified no issues (0 silenced).
```

### Gunicorn configuration

```python
# gunicorn.conf.py
import multiprocessing
import os

bind = "0.0.0.0:8000"
cpu = int(os.environ.get("WEB_CPU", multiprocessing.cpu_count()))   # set to the container CPU limit
workers = int(os.environ.get("WEB_CONCURRENCY", cpu * 2 + 1))
worker_class = "gthread"
threads = int(os.environ.get("WEB_THREADS", 2))
timeout = 30                 # kill a worker silent for 30 s
graceful_timeout = 30        # time to finish in-flight requests on SIGTERM
keepalive = 75               # must exceed the load balancer's idle timeout (see gotcha)
max_requests = 1000
max_requests_jitter = 100    # avoid all workers recycling at once
accesslog = "-"              # stdout
errorlog = "-"
forwarded_allow_ips = "*"    # trust X-Forwarded-* from the proxy network only (restrict if possible)
preload_app = False          # True saves memory via copy-on-write but breaks per-worker init and reloads
```

> **Gotcha:** if a cloud load balancer keeps idle connections to Gunicorn longer than Gunicorn's `keepalive`, Gunicorn closes them first and the LB occasionally sends a request on a closed socket, producing sporadic 502s. Set the app server's keep-alive *longer* than the load balancer's idle timeout, or disable keep-alive between them.

### Nginx in front (VM deployments)

```text
upstream django { server 127.0.0.1:8000; keepalive 32; }

server {
    listen 443 ssl http2;
    server_name shop.example.com;
    ssl_certificate     /etc/letsencrypt/live/shop/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop/privkey.pem;

    client_max_body_size 20m;

    location /static/ {
        alias /srv/shop/staticfiles/;
        expires 1y;
        add_header Cache-Control "public, immutable";   # safe: ManifestStaticFilesStorage hashes names
    }

    location / {
        proxy_pass http://django;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;     # overwrites any client-sent value
        proxy_read_timeout 35s;                         # a bit above Gunicorn's timeout
    }
}
server { listen 80; server_name shop.example.com; return 301 https://$host$request_uri; }
```

### Real-world example: container image, health checks, logging, Sentry

```text
# Dockerfile
FROM python:3.12-slim AS build
ENV PIP_NO_CACHE_DIR=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
RUN pip install --upgrade pip
COPY requirements.txt .
RUN pip wheel --wheel-dir /wheels -r requirements.txt

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 DJANGO_SETTINGS_MODULE=proj.settings.prod
RUN useradd --create-home --uid 10001 app
WORKDIR /app
COPY --from=build /wheels /wheels
RUN pip install --no-cache-dir /wheels/* && rm -rf /wheels
COPY --chown=app:app . .
# collectstatic needs settings importable without real secrets
RUN DJANGO_SECRET_KEY=build DJANGO_ALLOWED_HOSTS=localhost REDIS_URL=redis://x \
    python manage.py collectstatic --noinput
USER app
EXPOSE 8000
CMD ["gunicorn", "proj.wsgi:application", "-c", "gunicorn.conf.py"]
```

The image runs only the web server. Migrations run from the same image as a separate command (`python manage.py migrate --noinput`) in a release job. More in [Docker · Multi-stage Builds](../docker/topic.html?p=07-multistage-builds) and [Docker · Lab: Production Dockerfile](../docker/topic.html?p=30-lab-production-dockerfile).

```python
# core/health.py
from django.core.cache import cache
from django.db import connection
from django.http import JsonResponse

def healthz(request):
    """Liveness: the process can run Python and answer. No dependencies."""
    return JsonResponse({"status": "ok"})

def readyz(request):
    """Readiness: can this pod serve real traffic right now?"""
    checks = {}
    try:
        with connection.cursor() as cur:
            cur.execute("SELECT 1")
        checks["db"] = "ok"
    except Exception as exc:          # noqa: BLE001
        checks["db"] = f"error: {exc.__class__.__name__}"
    try:
        cache.set("readyz", "1", 5)
        checks["cache"] = "ok"
    except Exception as exc:          # noqa: BLE001
        checks["cache"] = f"error: {exc.__class__.__name__}"
    ok = all(v == "ok" for v in checks.values())
    return JsonResponse({"status": "ok" if ok else "degraded", **checks}, status=200 if ok else 503)
```

```python
# proj/urls.py (excerpt)
from core.health import healthz, readyz
urlpatterns += [path("healthz/", healthz), path("readyz/", readyz)]
```

> **Gotcha:** probes connect to the pod IP with a `Host` header like `10.1.2.3:8000`, which fails `ALLOWED_HOSTS` with a 400 (`DisallowedHost`). Either configure the probe's `Host` header, add the pod network pattern, or serve health endpoints from a tiny middleware placed before `CommonMiddleware`'s host validation. Also exempt them from `SECURE_SSL_REDIRECT` as above.

```python
# proj/settings/prod.py — logging: JSON to stdout
LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "json": {"()": "pythonjsonlogger.json.JsonFormatter",
                 "fmt": "%(asctime)s %(levelname)s %(name)s %(message)s"},
    },
    "handlers": {"stdout": {"class": "logging.StreamHandler", "formatter": "json"}},
    "root": {"handlers": ["stdout"], "level": "INFO"},
    "loggers": {
        "django.request": {"level": "WARNING"},          # 4xx/5xx details
        "django.security": {"level": "WARNING"},         # DisallowedHost, CSRF failures
        "django.db.backends": {"level": "WARNING"},      # never DEBUG in prod: logs every SQL
    },
}
```

```python
# proj/settings/prod.py — Sentry
import sentry_sdk

sentry_sdk.init(
    dsn=os.environ.get("SENTRY_DSN"),
    environment=os.environ.get("APP_ENV", "production"),
    release=os.environ.get("GIT_SHA"),       # correlate errors with deploys
    traces_sample_rate=0.05,                  # sample performance traces
    send_default_pii=False,
)
```

The Django and Celery integrations are enabled automatically when the packages are installed.

### Kubernetes essentials

```text
# deployment.yaml (excerpt)
spec:
  replicas: 4
  strategy: {type: RollingUpdate, rollingUpdate: {maxSurge: 1, maxUnavailable: 0}}
  template:
    spec:
      terminationGracePeriodSeconds: 45
      containers:
      - name: web
        image: registry.example.com/shop:3f9c2ab
        envFrom: [{secretRef: {name: shop-env}}]
        resources: {requests: {cpu: "1", memory: 768Mi}, limits: {cpu: "2", memory: 1Gi}}
        env: [{name: WEB_CPU, value: "2"}]
        readinessProbe: {httpGet: {path: /readyz/, port: 8000}, periodSeconds: 5}
        livenessProbe:  {httpGet: {path: /healthz/, port: 8000}, periodSeconds: 10, failureThreshold: 6}
        lifecycle:
          preStop: {exec: {command: ["sleep", "10"]}}   # let endpoints/LB deregister first
```

The `preStop` sleep matters: when a pod is terminated, removal from Service endpoints and SIGTERM happen concurrently. Without a short sleep, Gunicorn may stop accepting while the load balancer still sends requests, causing connection-refused errors during every deploy. See [Kubernetes · Probes & Health](../kubernetes/topic.html?p=22-probes-health) and [Kubernetes · Rollouts](../kubernetes/topic.html?p=21-rollouts).

## 6. Advantages, Disadvantages & Trade-offs

| Choice | Pros | Cons | Use when |
|---|---|---|---|
| Gunicorn sync workers | Simple, robust, predictable | One request per process; slow I/O blocks workers | CPU-light, DB-bound apps with short requests |
| Gunicorn gthread | More concurrency per MB of RAM | GIL; thread-safety of your code and libs | I/O-heavy sync apps |
| Gunicorn gevent | Thousands of concurrent I/O waits | Monkey-patching surprises; C drivers may block | Many outbound HTTP calls |
| uvicorn (ASGI) | Async views, WebSockets, streaming | Sync code still threads; ecosystem caveats | Async or Channels workloads |
| WhiteNoise | No extra service, correct cache headers | App processes serve bytes (fine behind a CDN) | Containers, PaaS |
| Nginx static | Fast, sendfile | Shared volume between build and Nginx | VM deployments |
| CDN + S3 | Global edge, offloads origin | Invalidation, cost, CORS for fonts | Public sites at scale |
| PaaS (Heroku-like, Render, Fly) | Release phase, logs, TLS built in | Less control, cost at scale | Small teams |
| Kubernetes | Rollouts, autoscaling, jobs | Operational complexity | Many services, platform team |

### When to use

- Gunicorn + Nginx/LB is the default for WSGI Django; add uvicorn workers only for async needs.
- WhiteNoise for static files in containers; a CDN in front for high traffic.
- A release step for migrations on every platform.
- Readiness checks that test the database; liveness checks that do not.

### When NOT to use

- `runserver` in production, ever.
- `--preload` when workers need per-process state initialised after fork, or when you rely on graceful code reloads with SIGHUP.
- Liveness probes that hit the database (an outage restarts every pod and turns degradation into downtime).
- Huge Gunicorn timeouts to "fix" slow endpoints — move the work to Celery.

## 7. Common Mistakes & Best Practices

**`DEBUG = True` in production.** Leaks settings, SQL and source in error pages, and Django stores every query in memory (`connection.queries`), which grows per request. Read `DEBUG` from the environment with a safe default of `False`.

**Running migrations in the entrypoint.** Every pod runs `migrate` at start; parallel runs block each other on locks or fail, and a long migration delays pod readiness so the rollout times out. Use a release job.

**Non-backwards-compatible migrations.** Renaming a field in one deploy breaks old pods still serving traffic. Use expand/contract; Django's `RenameField` is a breaking change for running code.

**Wrong worker count in containers.** `multiprocessing.cpu_count()` returns the host's cores (e.g. 64) inside a container limited to 2 CPUs, so Gunicorn starts 129 workers and the pod OOMs. Set `WEB_CONCURRENCY` from the CPU limit.

**Trusting `X-Forwarded-For`/`X-Forwarded-Proto` from anywhere.** If the app is reachable without the proxy, clients can forge them. Ensure only the proxy can reach Gunicorn and that it overwrites the headers.

**Secrets in the image or repository.** `SECRET_KEY` committed to git or baked into a Docker layer. Inject from the environment / secret manager at runtime ([Docker · Secrets](../docker/topic.html?p=24-secrets), [Kubernetes · ConfigMaps & Secrets](../kubernetes/topic.html?p=05-configmaps-secrets)).

**Serving media from the app server's disk.** Pods are ephemeral and not shared; uploads disappear or are visible on one pod only. Use object storage via `STORAGES["default"]`.

**Logging SQL in production.** `django.db.backends` at DEBUG logs every query (only when DEBUG is on, but people force it) — huge volume and possibly sensitive data.

**Best practices**

- One image, many roles: web, worker, beat, release job all from the same tag.
- Twelve-factor config: everything that varies between environments comes from env vars.
- `check --deploy` and `makemigrations --check` in CI.
- Tag images with the git SHA and pass it to Sentry as `release`.
- Recycle workers with `max_requests` + jitter; keep timeouts tight.
- Run `clearsessions` periodically if you use database sessions.

## 8. Production: Pitfalls, Debugging & Scaling

> **Production story:** Every deploy produced a burst of 502s for about ten seconds. Root cause: on SIGTERM, Gunicorn stopped accepting immediately while the cloud load balancer still routed to the pod for several seconds. Fix: a `preStop` sleep of 10 s, `terminationGracePeriodSeconds` greater than the sleep plus Gunicorn's `graceful_timeout`, and `maxUnavailable: 0`.

**`WORKER TIMEOUT` and 502s under load.** Symptom: Gunicorn logs `[CRITICAL] WORKER TIMEOUT (pid:...)`, Nginx logs `upstream prematurely closed connection`. Root cause: requests exceeding `--timeout` — slow queries, external API calls without timeouts, or all workers busy so requests queue. Fix: find the slow endpoints (APM/Sentry performance, slow query log), add timeouts to every outbound call, move long work to Celery, and only then revisit worker counts.

**`DisallowedHost` flooding the logs.** Scanners hit the IP with random `Host` headers. That is `ALLOWED_HOSTS` working; filter the `django.security.DisallowedHost` logger and reject unknown hosts at the proxy (a default `server` block returning 444).

**Static files 404 after deploy with `DEBUG=False`.** `collectstatic` did not run, or `ManifestStaticFilesStorage` raises `ValueError: Missing staticfiles manifest entry` for a file referenced in a template but not collected. Run `collectstatic` in the build and fail the build on errors.

**Memory creeping until OOM kill.** A leak in a library or caching in module globals. `max_requests` with jitter contains it; find it with `tracemalloc` or memray in staging.

**Mixed-content and redirect loops.** Missing `SECURE_PROXY_SSL_HEADER` (loops with `SECURE_SSL_REDIRECT`) or a proxy that does not set `X-Forwarded-Proto`. Check `request.is_secure()` in a debug endpoint in staging.

**HSTS lockout.** Enabling `SECURE_HSTS_SECONDS = 31536000` with `include_subdomains` while some subdomain lacks HTTPS makes it unreachable for browsers for a year. Start with a small value and raise it.

**Debugging toolkit**

- `py-spy dump --pid <worker pid>` shows what a stuck worker is doing without restarting it; `py-spy top` for live profiling.
- Gunicorn access logs with request time (`%(D)s` in `access_log_format`) to spot slow endpoints.
- Sentry issues grouped per release to tell whether a deploy introduced errors.
- `manage.py shell` inside a running pod (`kubectl exec`) with production settings — read-only investigations only.
- Correlation IDs: a middleware that reads or creates `X-Request-ID`, adds it to logs and returns it in the response.

**Scaling.** Scale horizontally first: more pods behind the load balancer, since Django web processes are stateless if sessions and cache live in Redis/DB and media in S3. Autoscale on CPU or request latency ([Kubernetes · Autoscaling](../kubernetes/topic.html?p=20-autoscaling)), watching the database connection budget as replicas grow. Put a CDN in front of static assets and cacheable pages. Separate traffic classes (public API, admin, webhooks) into different deployments when one can starve another.

## 9. Interview Questions

**Q: Why shouldn't you use `runserver` in production?**
A: It is a development server: single process with threads, an auto-reloader, static file serving tied to `DEBUG`, and no hardening or security audit — the Django docs explicitly say not to use it in production. It has no worker supervision, no timeouts for hung requests and no graceful restarts. A production setup uses Gunicorn or uvicorn behind a reverse proxy that handles TLS, buffering and static files. `runserver` is for local development only.

**Q: How many Gunicorn workers would you run, and how do you decide?**
A: The documented starting point for sync workers is `2 × CPU cores + 1`, where cores means the CPUs actually available to the container. Then measure: if CPU saturates at peak, more workers will not help; if CPU is low but requests queue because workers wait on the database or external APIs, add workers or switch to `gthread` with a few threads. Constraints are memory (each worker is a full Django process) and database connections (each worker thread may hold one). Long-running work does not belong in web workers at all — it goes to Celery.

**Q: What are Gunicorn's `--timeout` and `--max-requests` for?**
A: `--timeout` (default 30 seconds) is how long a worker may be silent before the master kills and replaces it; it protects you from hung requests but also kills legitimately slow ones, which the proxy turns into 502s. `--max-requests` restarts a worker after it has served N requests, which contains slow memory leaks; `--max-requests-jitter` randomises that number so workers do not all restart at once. Both are safety nets: the real fixes are bounding slow work and finding leaks.

**Q: What does `SECURE_PROXY_SSL_HEADER` do and when is it dangerous?**
A: Behind a TLS-terminating proxy, Django receives plain HTTP and `request.is_secure()` is `False`, causing redirect loops with `SECURE_SSL_REDIRECT`, `http://` absolute URLs and CSRF origin mismatches. Setting `SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")` makes Django treat requests with that header as secure. It is dangerous when clients can reach Django directly or the proxy passes through a client-supplied header, because then anyone can claim HTTPS. Only set it when the proxy always overwrites the header and is the only path to the app.

**Q: Why should migrations run as a separate release step instead of in the container entrypoint?**
A: With many replicas, every container would run `migrate` at the same time; Django has no distributed lock for migrations, so they block each other on DDL locks or fail mid-way, and long migrations delay readiness until the rollout times out. A single release job (Kubernetes Job, pipeline step, PaaS release phase) runs once from the same image before new pods take traffic and stops the deploy if it fails. Migrations must also be backwards compatible, because old pods keep serving during the rollout.

**Q: How do you serve static files in production?**
A: Run `collectstatic` at build time to gather files into `STATIC_ROOT` with hashed filenames (`ManifestStaticFilesStorage` or WhiteNoise's `CompressedManifestStaticFilesStorage`, configured in `STORAGES["staticfiles"]`). Then serve them with WhiteNoise middleware (simplest in containers), Nginx from a shared directory, or upload to S3 behind a CDN. Hashed names allow far-future cache headers because a content change changes the URL. Never rely on `django.contrib.staticfiles` serving with `DEBUG=True`.

**Q: What settings do you change for production?**
A: `DEBUG = False`; `SECRET_KEY` from the environment; explicit `ALLOWED_HOSTS` and `CSRF_TRUSTED_ORIGINS` with schemes; HTTPS hardening (`SECURE_SSL_REDIRECT`, `SECURE_PROXY_SSL_HEADER` behind a proxy, `SESSION_COOKIE_SECURE`, `CSRF_COOKIE_SECURE`, HSTS); `STORAGES` for static and media; persistent connections or pooling; a shared cache like Redis rather than locmem; JSON logging to stdout; and error tracking such as Sentry. Run `manage.py check --deploy` in CI to catch omissions.

**Q: What is the difference between liveness and readiness probes for a Django app?**
A: Liveness answers "is the process healthy enough to keep running?" and should be cheap and dependency-free — if it fails, the orchestrator restarts the container. Readiness answers "can this instance serve traffic now?" and can check the database and cache — if it fails, the instance is removed from the load balancer but not restarted. Putting the database in the liveness check means a database blip restarts every pod at once, turning a partial outage into a full one and causing a reconnection storm.

**Q: How do you get the real client IP in Django behind a proxy?**
A: `REMOTE_ADDR` is the proxy's address. The proxy appends the client address to `X-Forwarded-For`, so you read the value added by your trusted proxy — counting from the right by the number of proxies you control — not the leftmost value, which clients can forge. Django does not parse it for you (the old `SetRemoteAddrFromForwardedFor` middleware was removed); use a small middleware or a library such as django-ipware configured with your proxy count. Rate limiting and audit logs depend on getting this right.

**Q: How do you deploy a Django app with zero downtime? (Senior)**
A: Build an immutable image once, run backwards-compatible migrations in a release job, then do a rolling update with `maxUnavailable: 0` so capacity never drops. New pods only receive traffic once readiness passes; old pods get a `preStop` delay so the load balancer deregisters them, then SIGTERM triggers Gunicorn's graceful shutdown within `graceful_timeout`, all inside `terminationGracePeriodSeconds`. Schema changes follow expand/contract across releases so old and new code coexist. Celery workers drain with warm shutdown and tasks are idempotent with `acks_late`; static assets have hashed names so old and new pages both find their files. Finally, watch error rate and latency per release and roll back automatically on regression.

**Q: You need to rename a heavily used column on a 200-million-row table. How do you ship it? (Senior)**
A: Never with a plain `RenameField` in one deploy, because pods running old code will query the old name during the rollout. Expand: add the new column as nullable (fast on PostgreSQL), and deploy code that writes both columns. Backfill in batches (by primary key ranges, in a management command or Celery task, with sleeps to limit replication lag and lock time). Then deploy code that reads the new column, add constraints with `NOT VALID` then `VALIDATE CONSTRAINT`, or build indexes with `AddIndexConcurrently` in a non-atomic migration. Finally contract: remove the old field from the model and drop the column in a later release. Alternatively keep the DB column name and change only the Python name via `db_column`, which needs no data movement.

**Q: Your Django pods get OOM-killed under traffic spikes. How do you investigate and fix it? (Senior)**
A: Check how many workers each pod starts — a common cause is `cpu_count()` seeing the host's cores, spawning far too many processes — and set `WEB_CONCURRENCY` from the CPU limit. Then look at per-request memory: views that load whole querysets into lists, large file uploads held in memory (`FILE_UPLOAD_MAX_MEMORY_SIZE`), unbounded serializer responses, or `DEBUG=True` accumulating `connection.queries`. Profile with memray or tracemalloc in staging under replayed traffic, stream big responses, use `iterator()` and pagination, and use `max_requests` with jitter to contain leaks. Finally set memory requests/limits from measured usage and autoscale on load rather than surviving spikes by luck.

**Q: How would you set up observability for a production Django service? (Senior)**
A: Three signals. Logs: JSON to stdout with request ID, user ID, path, status and duration, shipped to a central store; `django.request` and `django.security` at WARNING. Metrics: request rate, error rate and latency percentiles per endpoint (django-prometheus or OpenTelemetry), Gunicorn worker saturation, database connections and slow queries, Celery queue depth. Traces and errors: Sentry or OpenTelemetry tracing with a sampled rate, releases tagged with the git SHA so errors correlate with deploys. Alerts on SLOs (error rate, p95 latency) rather than raw CPU, and dashboards per release for quick rollback decisions.

## 10. Quick Revision & Cheat Sheet

| Area | Setting / tool | Rule |
|---|---|---|
| App server | `gunicorn proj.wsgi:application` | Never `runserver` |
| Workers | `2 × cores + 1` (sync) | Cores = container CPU limit; measure |
| Timeouts | `--timeout 30`, `--graceful-timeout 30` | Slow work goes to Celery |
| Leaks | `--max-requests 1000 --max-requests-jitter 100` | Recycle gradually |
| ASGI | `-k uvicorn_worker.UvicornWorker` | Only if you need async |
| Proxy | Nginx / LB / Ingress | TLS, buffering, body size |
| HTTPS behind proxy | `SECURE_PROXY_SSL_HEADER` | Only if proxy overwrites the header |
| Hosts | `ALLOWED_HOSTS`, `CSRF_TRUSTED_ORIGINS` (with scheme) | Required with `DEBUG=False` |
| Static | `collectstatic` at build + WhiteNoise / CDN | Hashed names, long cache |
| Media | `STORAGES["default"]` → S3 | Never pod disk |
| Migrations | Release job, expand/contract | Exactly once, backwards compatible |
| Probes | `/healthz` (no deps), `/readyz` (DB, cache) | DB never in liveness |
| Shutdown | `preStop` sleep + graceful timeout | Grace period > sleep + drain |
| Errors | Sentry with `release=GIT_SHA` | Correlate with deploys |
| Check | `manage.py check --deploy` | In CI |

- The proxy protects sync workers from slow clients.
- Worker count drives memory and database connections.
- Old and new code coexist during a rolling deploy.
- Liveness cheap, readiness honest.
- Secrets from the environment, never in the image.
- One image for web, workers, beat and release job.
- Start HSTS small; raise once HTTPS is verified everywhere.
- Logs to stdout as JSON; add request IDs.

## 11. Hands-On Exercises

Setup: `python -m venv .venv && pip install "django~=5.2" gunicorn whitenoise sentry-sdk python-json-logger`.

1. **check --deploy.** Run `manage.py check --deploy` on a fresh project, then fix every warning in a `prod.py` settings module until it is clean.
2. **Worker sizing.** Write a view that sleeps 200 ms (simulated DB wait). Load-test with `hey` or `wrk` using 1, 5 and 9 sync workers, then 3 workers × 4 gthread threads; plot throughput vs memory.
3. **Timeouts.** Add a view sleeping 40 s; observe `WORKER TIMEOUT` with the default timeout and the resulting 502 behind Nginx.
4. **Proxy headers.** Put Nginx with TLS (self-signed) in front, enable `SECURE_SSL_REDIRECT` without `SECURE_PROXY_SSL_HEADER` and reproduce the redirect loop; then fix it.
5. **Graceful shutdown.** Run Gunicorn, start a 10 s request, send SIGTERM to the master and confirm the request completes before exit.
6. **Expand/contract.** Rename a field across three commits (add, backfill + switch, drop) while a script hits the API continuously; confirm zero errors.

**Mini project:** a production-ready deployment of a small shop app with docker-compose: multi-stage Dockerfile, Gunicorn config from env, Nginx with TLS and static caching (or WhiteNoise), PostgreSQL + PgBouncer, Redis, a Celery worker and beat, a one-shot `migrate` service that the web service depends on, `/healthz` and `/readyz`, JSON logs and Sentry. Add a GitHub Actions pipeline that runs tests, `makemigrations --check`, `check --deploy`, builds and tags the image with the git SHA.

## 12. Related Topics & Free Learning Resources

- [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings) — settings per environment, env vars.
- [Ch 11 · Migrations](topic.html?p=11-migrations) — safe schema changes, `AddIndexConcurrently`.
- [Ch 20 · Static & Media Files](topic.html?p=20-static-media-files) — `collectstatic`, `STORAGES`, WhiteNoise.
- [Ch 28 · Security: CSRF, XSS, SQL Injection & Hardening](topic.html?p=28-security) — `check --deploy`, HSTS.
- [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks) and [Ch 34 · Scaling Django: Connections, Replicas & Multiple Databases](topic.html?p=34-scaling-databases).
- [Docker · Dockerfile](../docker/topic.html?p=05-dockerfile), [Docker · Healthchecks](../docker/topic.html?p=17-healthchecks), [Docker · Compose in Production](../docker/topic.html?p=20-compose-production), [Docker · CI/CD](../docker/topic.html?p=26-ci-cd).
- [Kubernetes · Deployments](../kubernetes/topic.html?p=03-deployments), [Kubernetes · Probes & Health](../kubernetes/topic.html?p=22-probes-health), [Kubernetes · Lab: Zero-Downtime Rollout](../kubernetes/topic.html?p=29-lab-zero-downtime-rollout).
- [REST API · Deployment & CI/CD for APIs](../rest-api/topic.html?p=41-deployment-cicd-apis).

- **Deployment checklist** — Django docs · *Beginner* · every setting `check --deploy` cares about, with explanations. <https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/>
- **How to deploy Django** — Django docs · *Beginner* · WSGI and ASGI deployment guides, Gunicorn and uvicorn. <https://docs.djangoproject.com/en/5.2/howto/deployment/>
- **Gunicorn design and settings** — Gunicorn docs · *Intermediate* · worker types, sizing advice, timeouts and signals. <https://docs.gunicorn.org/en/stable/design.html>
- **WhiteNoise documentation** — WhiteNoise · *Beginner* · Django integration, compression and caching headers. <https://whitenoise.readthedocs.io/>
- **The Twelve-Factor App** — 12factor.net · *Beginner* · config, logs, processes and dev/prod parity principles. <https://12factor.net/>
- **Sentry for Django** — Sentry docs · *Beginner* · setup, releases and performance tracing. <https://docs.sentry.io/platforms/python/integrations/django/>
- **django-storages** — GitHub · *Intermediate* · S3 and other storage backends for media files. <https://github.com/jschneier/django-storages>

---

*Django Handbook — chapter 35.*
