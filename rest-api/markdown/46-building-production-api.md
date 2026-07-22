# 46 · Building a Production API End-to-End

> **In one line:** One real API — a multi-tenant Link Shortener — taken through design, implementation, security, documentation, testing, deployment and monitoring, with nothing hand-waved.

---

## 1. Overview

Every previous chapter isolated one concern: status codes here, pagination there, OAuth somewhere else. Production is where they all have to hold hands at once, and where the interesting failures live — the auth middleware that works until you add a health check, the pagination that's correct until someone deletes a row mid-scroll, the Docker image that runs locally and OOMs in Kubernetes. This chapter builds **one coherent API** all the way through so the seams are visible.

The subject is a **multi-tenant link shortener with analytics** — `zariya.link`. It is deliberately unglamorous and deliberately complete: it has a write path with conflict semantics (custom slugs), a read path with enormous volume and caching (the redirect), an asynchronous path (click ingestion), authentication (API keys for machines, JWT for the dashboard), object-level authorization (workspaces), pagination (link lists), rate limiting (per key), and an analytics endpoint that is a genuine aggregation problem. If you can build this properly you can build almost any CRUD-plus-scale API.

Why a link shortener and not "another todo API"? Because the read:write ratio is roughly **1000:1**, which forces real caching decisions; because slugs are a shared namespace, which forces real conflict handling; and because click analytics cannot be written synchronously on the redirect path without destroying latency, which forces a real asynchronous design. A todo API teaches you routing. This teaches you production.

The stack is **FastAPI + PostgreSQL + Redis**, containerised, deployed behind a reverse proxy, instrumented with Prometheus and OpenTelemetry. Those are choices, not requirements — the shape transfers to Express, Spring or Go unchanged. What matters is that every layer is present: schema-validated input, an explicit error contract (RFC 9457), a generated OpenAPI 3.1 document, a test pyramid that includes contract tests, a migration story, a deployment with health probes, and dashboards and alerts that would actually wake the right person.

**The definition of "production" used here.** An API is production-ready when: a client can integrate from the docs alone without asking you a question; every failure mode returns a status code the client can act on; you can answer "what happened to request X" in under a minute; you can deploy on a Friday and roll back in under five; and you know, from a graph rather than a feeling, whether it is currently healthy.

## 2. Core Concepts

- **Layered architecture** — routers (HTTP concerns) → services (business rules) → repositories (persistence). Business logic never imports `Request`, and routers never write SQL.
- **Pydantic schema separation** — distinct `Create`, `Update`, and `Public` models so a client can never set a server-owned field (`id`, `created_at`, `workspace_id`) by including it in the body — mass-assignment prevention by construction.
- **Dependency injection (`Depends`)** — FastAPI's mechanism for supplying a database session, the current principal and the resolved workspace to a handler, and the seam where tests substitute fakes.
- **RFC 9457 problem details** — `application/problem+json` with `type`, `title`, `status`, `detail`, `instance` plus domain extensions; the single error contract for every failure in the service.
- **Migration** — a versioned, reversible schema change (Alembic) applied as a separate step before the new code rolls out, so old and new code both work against the intermediate schema.
- **Test pyramid** — many fast unit tests over services, fewer integration tests over a real Postgres, a thin layer of contract tests asserting responses match the OpenAPI schema, and a handful of end-to-end smoke tests.
- **Liveness vs readiness** — liveness answers "should I be restarted"; readiness answers "should I receive traffic". Readiness checks dependencies; liveness must not, or one slow database restarts your whole fleet.
- **The four golden signals** — latency, traffic, errors, saturation (Google SRE). Everything else on a dashboard is a drill-down from these.
- **Structured logging with correlation** — JSON log lines carrying `request_id`, `workspace_id` and `route`, so a single incident is one filtered query rather than a grep across pods.
- **Graceful shutdown** — on `SIGTERM`, stop accepting new connections, drain in-flight requests, flush buffers, then exit — without it every deploy drops requests.

## 3. Theory & Principles

### The resource model, decided before any code

Four resources, and the relationships between them determine every endpoint:

```
Workspace 1─────* ApiKey
    │
    └─────* Link ─────* ClickEvent (write-heavy, append-only, never returned raw)
                  └── Analytics (a derived read model, not a stored resource)
```

The important modelling calls:

- **`Link` is owned by a `Workspace`, not a user.** Multi-tenancy is a property of the data, not of the session. Every query is `WHERE workspace_id = $1` and there is no code path that omits it — this is enforced by making the repository take the workspace as a constructor argument, not a parameter a caller might forget.
- **Analytics is a sub-resource, not a field.** `GET /v1/links/{id}/analytics` rather than an `analytics` object on the link. Embedding it would make every list response an aggregation query.
- **`ClickEvent` is never a REST resource.** Nobody paginates a billion raw clicks. It is an internal append-only stream with derived rollups exposed through the analytics endpoint.

### Status codes as the contract, decided per operation

| Operation | Success | Failure modes |
|---|---|---|
| Create link, generated slug | `201` + `Location` | `422` invalid URL, `429` |
| Create link, custom slug taken | — | `409 Conflict` with the conflicting slug in the problem body |
| Update link (full) | `200` | `412` stale `If-Match`, `428` missing `If-Match`, `404` |
| Delete link | `204` | `404` |
| Redirect | `301` or `302` | `404` unknown slug, `410` expired |
| Analytics | `200` | `404`, `422` bad range |
| List links | `200` | `400` bad cursor, `429` |

The redirect status choice is a real decision with a real consequence: **`301 Moved Permanently` is cached by browsers indefinitely**, which is free traffic reduction but makes a link permanently un-editable in practice — the browser will never ask you again. `302 Found` (or better, `307 Temporary Redirect`, which additionally guarantees the method is not rewritten) keeps control. Production link shorteners overwhelmingly use `302`, and this API does too, with `Cache-Control: private, max-age=0` so intermediaries do not cache either. Say this trade-off out loud in an interview; it is a small question that reveals whether you understand HTTP caching.

### Idempotency and conflict, precisely

`POST /v1/links` with a **generated** slug is not idempotent — two calls make two links. With a **custom** slug it effectively is: the second call collides and returns `409`. Both paths accept an optional `Idempotency-Key` so a client retrying a timeout gets its original link back rather than a duplicate. The rule of thumb the whole handbook keeps returning to: *any `POST` a client will retry on timeout needs a key.*

Updates use optimistic concurrency instead. The link resource carries an `ETag` derived from its version column; `PUT` requires `If-Match` and returns `412` on mismatch, `428` when it is absent. This costs the client one header and eliminates the lost-update race in which two dashboard tabs overwrite each other.

### The read path is the whole design

At 1000:1 read:write, the redirect endpoint is 99.9% of traffic and everything else is rounding error. So the redirect path is designed first and the rest is fitted around it:

```
redirect p99 budget: 30 ms
  ├─ Redis GET slug→url        ~1 ms   (hit ratio target > 99%)
  ├─ on miss: Postgres lookup  ~4 ms   (unique index on slug)
  ├─ enqueue click event       ~0.2 ms (fire-and-forget to a Redis stream)
  └─ 302 response              ~0 ms
```

The click write is **never** on the synchronous path. It goes to a Redis Stream, a consumer batches it into Postgres (or ClickHouse at real volume), and rollups are maintained incrementally. Losing a handful of click events during a crash is acceptable; adding 15 ms to every redirect is not. State that trade-off explicitly — choosing to lose data is a legitimate engineering decision when you say *which* data and *why*.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="324" rx="14" fill="#ffffff" stroke="#4f46e5"/>
  <text x="390" y="32" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Two paths, two designs: the 1000:1 read path vs the write path</text>

  <rect x="24" y="52" width="360" height="180" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="204" y="74" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Redirect path (hot, 30 ms p99 budget)</text>

  <rect x="44" y="88" width="90" height="40" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="89" y="106" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">GET /{slug}</text>
  <text x="89" y="120" text-anchor="middle" fill="#1e293b" font-size="9">no auth</text>

  <rect x="154" y="88" width="90" height="40" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="199" y="106" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">Redis GET</text>
  <text x="199" y="120" text-anchor="middle" fill="#1e293b" font-size="9">~1 ms, &gt;99% hit</text>

  <rect x="264" y="88" width="100" height="40" rx="6" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="314" y="106" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">302 Found</text>
  <text x="314" y="120" text-anchor="middle" fill="#1e293b" font-size="9">Location: target</text>

  <line x1="134" y1="108" x2="152" y2="108" stroke="#16a34a" stroke-width="2" marker-end="url(#pxA)"/>
  <line x1="244" y1="108" x2="262" y2="108" stroke="#16a34a" stroke-width="2" marker-end="url(#pxA)"/>

  <rect x="154" y="148" width="90" height="36" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="199" y="164" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">miss: Postgres</text>
  <text x="199" y="177" text-anchor="middle" fill="#1e293b" font-size="9">unique idx, ~4 ms</text>
  <line x1="199" y1="128" x2="199" y2="146" stroke="#d97706" stroke-width="2" marker-end="url(#pxA)"/>

  <rect x="44" y="192" width="320" height="30" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="204" y="212" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">XADD click to Redis Stream &#8212; fire and forget, ~0.2 ms</text>
  <line x1="89" y1="128" x2="89" y2="190" stroke="#0ea5e9" stroke-width="2" marker-end="url(#pxA)"/>

  <rect x="404" y="52" width="352" height="180" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="580" y="74" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Management path (cold, correctness first)</text>

  <rect x="420" y="88" width="104" height="46" rx="6" fill="#ffffff" stroke="#4f46e5"/>
  <text x="472" y="106" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">POST /v1/links</text>
  <text x="472" y="119" text-anchor="middle" fill="#1e293b" font-size="9">API key + scope</text>
  <text x="472" y="131" text-anchor="middle" fill="#1e293b" font-size="9">Idempotency-Key</text>

  <rect x="540" y="88" width="100" height="46" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="590" y="106" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">Validate</text>
  <text x="590" y="119" text-anchor="middle" fill="#1e293b" font-size="9">URL scheme,</text>
  <text x="590" y="131" text-anchor="middle" fill="#1e293b" font-size="9">SSRF deny-list</text>

  <rect x="656" y="88" width="84" height="46" rx="6" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="698" y="106" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">Postgres</text>
  <text x="698" y="119" text-anchor="middle" fill="#1e293b" font-size="9">UNIQUE slug</text>
  <text x="698" y="131" text-anchor="middle" fill="#1e293b" font-size="9">&#8594; 409 on clash</text>

  <line x1="524" y1="111" x2="538" y2="111" stroke="#4f46e5" stroke-width="2" marker-end="url(#pxA)"/>
  <line x1="640" y1="111" x2="654" y2="111" stroke="#4f46e5" stroke-width="2" marker-end="url(#pxA)"/>

  <rect x="420" y="150" width="320" height="34" rx="6" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="580" y="164" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">201 + Location, then cache warm: SET slug &#8594; url</text>
  <text x="580" y="178" text-anchor="middle" fill="#1e293b" font-size="9">write-through so the first redirect is never a miss</text>

  <rect x="420" y="192" width="320" height="30" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="580" y="212" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">PUT needs If-Match &#8594; 412 stale, 428 missing; DELETE &#8594; 204 + cache evict</text>

  <rect x="24" y="248" width="732" height="72" rx="10" fill="#ffffff" stroke="#4f46e5"/>
  <text x="390" y="270" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Consumer: batch clicks from the stream &#8594; append to events table &#8594; incremental rollups per (link, day, country)</text>
  <text x="390" y="290" text-anchor="middle" fill="#1e293b" font-size="11">GET /v1/links/{id}/analytics reads rollups only &#8212; never scans raw events</text>
  <text x="390" y="310" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">Deliberate trade-off: a crash may lose a few seconds of clicks; it may never add latency to a redirect.</text>

  <defs>
    <marker id="pxA" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#4f46e5"/>
    </marker>
  </defs>
</svg>
```

## 4. Architecture & Workflow

The full lifecycle of the service, from a developer's keyboard to a graph on a wall:

1. **Design.** Write the OpenAPI 3.1 document first (or generate it from Pydantic models and review the output). Lint it with Spectral. The endpoint table and error contract are settled before any handler is written.
2. **Scaffold.** Layered package structure: `api/routers`, `core` (config, security, errors), `services`, `repositories`, `schemas`, `workers`. Configuration comes from environment variables through a single typed `Settings` object — no `os.environ` reads scattered through the code.
3. **Migrations.** Alembic revision creates `workspaces`, `api_keys`, `links`, `click_events`, `click_rollups`, `idempotency_records`, with a `UNIQUE (slug)` constraint and indexes on `(workspace_id, created_at DESC, id DESC)` for cursor pagination.
4. **Implement inward-out.** Repositories first (pure persistence, workspace-scoped by construction), then services (business rules, no HTTP types), then routers (validation, status codes, headers).
5. **Errors.** One exception hierarchy (`AppError` → `NotFound`, `Conflict`, `Forbidden`, `RateLimited`, `Validation`) and one global handler that renders every one of them as RFC 9457. No handler ever builds an error body by hand.
6. **Security middleware chain.** In order: request ID → structured logging → CORS → security headers → rate limit → authentication. Authentication resolves an API key or JWT to a `Principal` carrying `workspace_id` and scopes. **Object-level authorization happens in the service**, using the workspace on the principal.
7. **Local run.** `docker compose up` brings Postgres, Redis, the API and the click consumer up together; `alembic upgrade head` runs as an init step; seed data creates one workspace and one test key.
8. **Test.** Unit tests over services with fake repositories; integration tests against a real Postgres in a container; contract tests that validate every recorded response against the OpenAPI schema; a smoke suite that runs against a deployed environment.
9. **CI.** Lint (`ruff`), type-check (`mypy`), test with coverage, `spectral lint openapi.json`, `oasdiff` breaking-change check against the deployed spec, build a multi-stage image, scan it (`trivy`), push with the git SHA as the tag.
10. **Deploy.** Migrations run as a pre-deploy job — always expand-then-contract, never a destructive change in the same release as the code that needs it. Then a rolling update with readiness gating, and automatic rollback if the error-rate SLO burns.
11. **Observe.** `/metrics` exposes Prometheus counters and histograms; OpenTelemetry traces span the API, Redis, Postgres and the consumer; logs are JSON with `request_id`. Dashboards show the four golden signals per route.
12. **Operate.** Alerts fire on symptoms (redirect p99, `5xx` rate, click-consumer lag, cache hit ratio) and page to a runbook. Every alert links to the dashboard panel that triggered it.

```svg
<svg viewBox="0 0 800 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="784" height="384" rx="14" fill="#ffffff" stroke="#4f46e5"/>
  <text x="400" y="30" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">From keyboard to dashboard: the delivery pipeline</text>

  <rect x="24" y="48" width="120" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="84" y="70" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Spec first</text>
  <text x="84" y="86" text-anchor="middle" fill="#1e293b" font-size="9">OpenAPI 3.1</text>
  <text x="84" y="98" text-anchor="middle" fill="#1e293b" font-size="9">spectral lint</text>

  <rect x="164" y="48" width="120" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="224" y="70" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Implement</text>
  <text x="224" y="86" text-anchor="middle" fill="#1e293b" font-size="9">routers / services</text>
  <text x="224" y="98" text-anchor="middle" fill="#1e293b" font-size="9">/ repositories</text>

  <rect x="304" y="48" width="120" height="56" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="364" y="70" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Test pyramid</text>
  <text x="364" y="86" text-anchor="middle" fill="#1e293b" font-size="9">unit / integration</text>
  <text x="364" y="98" text-anchor="middle" fill="#1e293b" font-size="9">/ contract / smoke</text>

  <rect x="444" y="48" width="130" height="56" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="509" y="70" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">CI gates</text>
  <text x="509" y="86" text-anchor="middle" fill="#1e293b" font-size="9">ruff, mypy, oasdiff</text>
  <text x="509" y="98" text-anchor="middle" fill="#1e293b" font-size="9">trivy image scan</text>

  <rect x="594" y="48" width="162" height="56" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="675" y="70" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Deploy</text>
  <text x="675" y="86" text-anchor="middle" fill="#1e293b" font-size="9">migrate (expand) &#8594; rolling</text>
  <text x="675" y="98" text-anchor="middle" fill="#1e293b" font-size="9">update &#8594; contract later</text>

  <line x1="144" y1="76" x2="162" y2="76" stroke="#4f46e5" stroke-width="2" marker-end="url(#dpA)"/>
  <line x1="284" y1="76" x2="302" y2="76" stroke="#4f46e5" stroke-width="2" marker-end="url(#dpA)"/>
  <line x1="424" y1="76" x2="442" y2="76" stroke="#4f46e5" stroke-width="2" marker-end="url(#dpA)"/>
  <line x1="574" y1="76" x2="592" y2="76" stroke="#4f46e5" stroke-width="2" marker-end="url(#dpA)"/>

  <rect x="24" y="132" width="732" height="112" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="390" y="154" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Runtime topology</text>

  <rect x="44" y="166" width="112" height="60" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="100" y="188" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">Reverse proxy</text>
  <text x="100" y="202" text-anchor="middle" fill="#1e293b" font-size="9">TLS, gzip/br</text>
  <text x="100" y="215" text-anchor="middle" fill="#1e293b" font-size="9">X-Request-Id</text>

  <rect x="176" y="166" width="132" height="60" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="242" y="184" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">API (uvicorn xN)</text>
  <text x="242" y="198" text-anchor="middle" fill="#1e293b" font-size="9">/healthz liveness</text>
  <text x="242" y="211" text-anchor="middle" fill="#1e293b" font-size="9">/readyz readiness</text>
  <text x="242" y="223" text-anchor="middle" fill="#1e293b" font-size="9">/metrics</text>

  <rect x="328" y="166" width="112" height="60" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="384" y="188" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">Redis</text>
  <text x="384" y="202" text-anchor="middle" fill="#1e293b" font-size="9">slug cache, quotas</text>
  <text x="384" y="215" text-anchor="middle" fill="#1e293b" font-size="9">click stream</text>

  <rect x="460" y="166" width="112" height="60" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="516" y="188" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">Postgres</text>
  <text x="516" y="202" text-anchor="middle" fill="#1e293b" font-size="9">primary + replica</text>
  <text x="516" y="215" text-anchor="middle" fill="#1e293b" font-size="9">pgbouncer</text>

  <rect x="592" y="166" width="144" height="60" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="664" y="184" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="700">Click consumer</text>
  <text x="664" y="198" text-anchor="middle" fill="#1e293b" font-size="9">batch insert events</text>
  <text x="664" y="211" text-anchor="middle" fill="#1e293b" font-size="9">upsert rollups</text>
  <text x="664" y="223" text-anchor="middle" fill="#1e293b" font-size="9">lag is an SLI</text>

  <line x1="156" y1="196" x2="174" y2="196" stroke="#0ea5e9" stroke-width="2" marker-end="url(#dpA)"/>
  <line x1="308" y1="196" x2="326" y2="196" stroke="#0ea5e9" stroke-width="2" marker-end="url(#dpA)"/>
  <line x1="440" y1="196" x2="458" y2="196" stroke="#0ea5e9" stroke-width="2" marker-end="url(#dpA)"/>
  <line x1="384" y1="226" x2="384" y2="238" stroke="#0ea5e9" stroke-width="2"/>
  <line x1="384" y1="238" x2="664" y2="238" stroke="#0ea5e9" stroke-width="2"/>
  <line x1="664" y1="238" x2="664" y2="228" stroke="#0ea5e9" stroke-width="2" marker-end="url(#dpA)"/>

  <rect x="24" y="268" width="360" height="112" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="204" y="290" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Golden signals per route</text>
  <text x="204" y="310" text-anchor="middle" fill="#1e293b" font-size="10">http_requests_total{route,method,status}</text>
  <text x="204" y="328" text-anchor="middle" fill="#1e293b" font-size="10">http_request_duration_seconds bucket p50/p95/p99</text>
  <text x="204" y="346" text-anchor="middle" fill="#1e293b" font-size="10">redirect_cache_hit_ratio &#183; click_consumer_lag_seconds</text>
  <text x="204" y="366" text-anchor="middle" fill="#1e293b" font-size="10">db_pool_in_use / db_pool_size (saturation)</text>

  <rect x="396" y="268" width="360" height="112" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="576" y="290" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Alerts page on symptoms, not causes</text>
  <text x="576" y="310" text-anchor="middle" fill="#1e293b" font-size="10">redirect p99 &gt; 100 ms for 5 min &#8594; page</text>
  <text x="576" y="328" text-anchor="middle" fill="#1e293b" font-size="10">5xx rate &gt; 0.5% for 5 min &#8594; page + auto-rollback</text>
  <text x="576" y="346" text-anchor="middle" fill="#1e293b" font-size="10">consumer lag &gt; 60 s &#8594; ticket (analytics stale, not down)</text>
  <text x="576" y="366" text-anchor="middle" fill="#1e293b" font-size="10">cache hit ratio &lt; 95% &#8594; ticket (DB load rising)</text>

  <defs>
    <marker id="dpA" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#4f46e5"/>
    </marker>
  </defs>
</svg>
```

## 5. Implementation

### Endpoint contract

| Method | Path | Auth | Success | Errors |
|---|---|---|---|---|
| `POST` | `/v1/links` | key `links:write` | `201` + `Location` + `ETag` | `409`, `422`, `429` |
| `GET` | `/v1/links?limit=&cursor=&q=` | key `links:read` | `200` | `400`, `401`, `429` |
| `GET` | `/v1/links/{id}` | key `links:read` | `200` + `ETag` | `404` |
| `PUT` | `/v1/links/{id}` | key `links:write` | `200` + `ETag` | `404`, `412`, `428`, `422` |
| `DELETE` | `/v1/links/{id}` | key `links:write` | `204` | `404` |
| `GET` | `/v1/links/{id}/analytics?from=&to=&group_by=` | key `links:read` | `200` | `404`, `422` |
| `GET` | `/{slug}` | public | `302` + `Location` | `404`, `410` |
| `GET` | `/healthz` `/readyz` `/metrics` | internal | `200` | `503` |

### Config, errors and app wiring

```python
# app/core/config.py
from functools import lru_cache
from pydantic import PostgresDsn, RedisDsn
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    env: str = "local"
    database_url: PostgresDsn
    redis_url: RedisDsn
    api_key_pepper: str                 # secret used to hash API keys at rest
    base_url: str = "https://zariya.link"
    rate_limit_per_minute: int = 600
    cache_ttl_seconds: int = 3600
    class Config:
        env_file = ".env"

@lru_cache
def settings() -> Settings:
    return Settings()          # type: ignore[call-arg]
```

```python
# app/core/errors.py  — one hierarchy, one renderer, RFC 9457 everywhere
from fastapi import Request
from fastapi.responses import JSONResponse

BASE = "https://errors.zariya.link"

class AppError(Exception):
    status = 500; code = "internal_error"; title = "Internal Server Error"
    def __init__(self, detail: str = "", **extra):
        self.detail, self.extra = detail, extra

class NotFound(AppError):      status, code, title = 404, "not_found", "Resource not found"
class Conflict(AppError):      status, code, title = 409, "conflict", "Conflict"
class Forbidden(AppError):     status, code, title = 403, "forbidden", "Forbidden"
class Unauthenticated(AppError): status, code, title = 401, "unauthenticated", "Unauthenticated"
class PreconditionFailed(AppError): status, code, title = 412, "precondition_failed", "Stale ETag"
class PreconditionRequired(AppError): status, code, title = 428, "precondition_required", "If-Match required"
class RateLimited(AppError):   status, code, title = 429, "rate_limited", "Too Many Requests"
class Gone(AppError):          status, code, title = 410, "gone", "Link expired"

async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    body = {
        "type": f"{BASE}/{exc.code}",
        "title": exc.title,
        "status": exc.status,
        "detail": exc.detail,
        "instance": request.url.path,
        "request_id": request.state.request_id,
        **exc.extra,
    }
    headers = {"Content-Type": "application/problem+json"}
    if isinstance(exc, RateLimited):
        headers["Retry-After"] = str(exc.extra.get("retry_after", 60))
    if isinstance(exc, Unauthenticated):
        headers["WWW-Authenticate"] = 'Bearer realm="zariya.link"'
    return JSONResponse(status_code=exc.status, content=body, headers=headers)
```

Note that validation errors get the same treatment — FastAPI's default `422` body is not problem+json, so override it:

```python
from fastapi.exceptions import RequestValidationError

async def validation_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, media_type="application/problem+json", content={
        "type": f"{BASE}/validation_error", "title": "Unprocessable Content", "status": 422,
        "detail": "One or more fields failed validation.",
        "instance": request.url.path,
        "errors": [{"field": ".".join(str(p) for p in e["loc"][1:]),
                    "message": e["msg"], "code": e["type"]} for e in exc.errors()],
    })
```

### Schemas — separate models are the security control

```python
# app/schemas/link.py
from datetime import datetime
from pydantic import BaseModel, Field, HttpUrl, field_validator

SLUG = r"^[a-zA-Z0-9_-]{3,32}$"

class LinkCreate(BaseModel):
    model_config = {"extra": "forbid"}      # reject unknown fields — catches client typos as 422
    target_url: HttpUrl
    slug: str | None = Field(default=None, pattern=SLUG)
    expires_at: datetime | None = None
    tags: list[str] = Field(default_factory=list, max_length=10)

    @field_validator("target_url")
    @classmethod
    def safe_target(cls, v: HttpUrl) -> HttpUrl:
        if v.scheme not in {"http", "https"}:
            raise ValueError("only http and https targets are allowed")
        host = (v.host or "").lower()
        if host in {"localhost", "127.0.0.1", "::1"} or host.endswith(".internal"):
            raise ValueError("target host is not routable from the public internet")
        return v

class LinkUpdate(BaseModel):
    model_config = {"extra": "forbid"}
    target_url: HttpUrl
    expires_at: datetime | None = None
    tags: list[str] = Field(default_factory=list, max_length=10)

class LinkPublic(BaseModel):
    id: str
    slug: str
    short_url: str
    target_url: HttpUrl
    tags: list[str]
    click_count: int
    expires_at: datetime | None
    created_at: datetime
    updated_at: datetime
    # NOTE: workspace_id and version are deliberately absent from the public shape.
```

> **Note:** `extra: "forbid"` is doing two jobs. It prevents **mass assignment** (a client cannot smuggle `workspace_id` into a create body) and it turns a client typo like `target_ur1` into an immediate `422` instead of a silently ignored field that becomes a support ticket three weeks later. Stripe does the same thing and it is one of the highest-value defaults in this chapter.

### The write path with conflict and idempotency

```python
# app/api/routers/links.py
@router.post("", response_model=LinkPublic, status_code=201)
async def create_link(
    payload: LinkCreate,
    response: Response,
    principal: Principal = Depends(require_scope("links:write")),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    svc: LinkService = Depends(get_link_service),
):
    if idempotency_key:
        if replay := await svc.replay(principal.workspace_id, idempotency_key, payload):
            response.status_code = replay.status
            response.headers["Location"] = f"/v1/links/{replay.body['id']}"
            return replay.body

    link = await svc.create(principal.workspace_id, payload, idempotency_key)
    response.headers["Location"] = f"/v1/links/{link.id}"
    response.headers["ETag"] = f'W/"{link.version}"'
    return link
```

```python
# app/services/link_service.py
import secrets, string
from asyncpg.exceptions import UniqueViolationError

ALPHABET = string.ascii_letters + string.digits          # 62 chars

class LinkService:
    def __init__(self, repo: LinkRepository, cache: Cache):
        self.repo, self.cache = repo, cache

    async def create(self, workspace_id: str, data: LinkCreate, key: str | None) -> Link:
        if data.slug:
            try:
                link = await self.repo.insert(workspace_id, data.slug, data)
            except UniqueViolationError:
                raise Conflict(f"Slug '{data.slug}' is already taken.",
                               slug=data.slug, code="slug_taken")
        else:
            # Retry on collision rather than pre-checking: the check-then-insert
            # race is real, and the UNIQUE constraint is the only true arbiter.
            for attempt in range(5):
                candidate = "".join(secrets.choice(ALPHABET) for _ in range(7))
                try:
                    link = await self.repo.insert(workspace_id, candidate, data)
                    break
                except UniqueViolationError:
                    continue
            else:
                raise AppError("Could not allocate a unique slug; retry.")

        await self.cache.set_link(link.slug, link.target_url, link.expires_at)  # write-through
        if key:
            await self.repo.save_idempotent(workspace_id, key, 201, link)
        return link
```

Seven random characters over a 62-symbol alphabet is 62⁷ ≈ **3.5 × 10¹²** slugs. At 100 million links stored, the birthday-style collision probability *per insert* is ~2.9 × 10⁻⁵ — rare enough that a five-attempt retry loop never realistically exhausts, and using random rather than sequential slugs means an attacker cannot enumerate the corpus.

### The read path: redirect with cache and async click

```python
# app/api/routers/redirect.py
@router.get("/{slug}", include_in_schema=False)
async def redirect(slug: str, request: Request, svc: LinkService = Depends(get_link_service)):
    entry = await svc.resolve(slug)                 # Redis first, Postgres on miss
    if entry is None:
        raise NotFound("No link exists for that slug.", slug=slug)
    if entry.expired:
        raise Gone("This link has expired.", slug=slug)

    # Fire and forget — never await a database write on the hot path.
    await svc.record_click(
        slug=slug,
        ts=time.time(),
        ua=request.headers.get("user-agent", "")[:256],
        referer=request.headers.get("referer", "")[:256],
        ip_hash=hash_ip(request.client.host),        # hashed, never stored raw (GDPR)
        country=request.headers.get("cf-ipcountry", "XX"),
    )
    return RedirectResponse(
        url=entry.target_url,
        status_code=302,
        headers={"Cache-Control": "private, max-age=0, no-store",
                 "Referrer-Policy": "no-referrer"},
    )
```

```python
# app/services/click_stream.py — Redis Stream producer + batching consumer
async def record_click(self, **fields) -> None:
    try:
        await self.redis.xadd("clicks", fields, maxlen=1_000_000, approximate=True)
    except RedisError:
        CLICK_DROPPED.inc()      # a dropped analytic event must never fail a redirect

async def consume(self) -> None:
    while True:
        batch = await self.redis.xreadgroup("agg", self.consumer, {"clicks": ">"},
                                            count=500, block=2000)
        if not batch:
            continue
        rows = [parse(entry) for _, entries in batch for entry in entries]
        async with self.db.transaction():
            await self.db.executemany(INSERT_EVENT, rows)
            await self.db.executemany(UPSERT_ROLLUP, rollup_deltas(rows))   # ON CONFLICT DO UPDATE
        await self.redis.xack("clicks", "agg", *[e_id for _, es in batch for e_id, _ in es])
        CONSUMER_LAG.set(time.time() - min(r.ts for r in rows))
```

### Pagination and analytics

```http
GET /v1/links?limit=20&cursor=eyJ0IjoiMjAyNi0wNy0yMlQwNTo1OCIsImkiOiJsbmtfN1prMSJ9 HTTP/1.1
Host: api.zariya.link
Authorization: Bearer zk_live_9d2f7c1a...
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 594
X-RateLimit-Reset: 1784707200
X-Request-Id: 01J8Z3Q7VN2M4K

{
  "data": [
    {
      "id": "lnk_7Zk1Qp",
      "slug": "launch26",
      "short_url": "https://zariya.link/launch26",
      "target_url": "https://zariya.in/blog/launch-2026",
      "tags": ["marketing"],
      "click_count": 18422,
      "expires_at": null,
      "created_at": "2026-07-20T09:14:02Z",
      "updated_at": "2026-07-21T11:02:44Z"
    }
  ],
  "pagination": { "next_cursor": "eyJ0IjoiMjAyNi0wNy0yMFQwOToxNCIsImkiOiJsbmtfN1prMVFwIn0", "has_more": true }
}
```

```sql
-- analytics reads rollups only; raw click_events is never scanned by an API request
SELECT day, country, SUM(clicks) AS clicks, SUM(unique_visitors) AS uniques
FROM click_rollups
WHERE link_id = $1 AND day BETWEEN $2 AND $3
GROUP BY day, country
ORDER BY day;
```

### Deployment

```dockerfile
# Multi-stage: build wheels once, ship a slim non-root runtime.
FROM python:3.12-slim AS build
WORKDIR /w
RUN pip install --no-cache-dir uv
COPY pyproject.toml uv.lock ./
RUN uv export --frozen --no-dev -o req.txt && \
    pip wheel --no-cache-dir -r req.txt -w /wheels

FROM python:3.12-slim
RUN useradd -u 10001 -m app
WORKDIR /app
COPY --from=build /wheels /wheels
RUN pip install --no-cache-dir --no-index --find-links=/wheels /wheels/* && rm -rf /wheels
COPY --chown=app:app app ./app
USER app
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s \
  CMD python -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8000/healthz')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--workers", "4", "--timeout-graceful-shutdown", "30", "--no-server-header"]
```

```python
# app/api/routers/health.py — liveness must NOT check dependencies
@router.get("/healthz")
async def healthz():
    return {"status": "ok"}          # process is alive; that is all this means

@router.get("/readyz")
async def readyz(db=Depends(get_db), redis=Depends(get_redis)):
    checks = {}
    try:
        await asyncio.wait_for(db.execute("SELECT 1"), timeout=1.0); checks["db"] = "ok"
    except Exception:
        checks["db"] = "fail"
    try:
        await asyncio.wait_for(redis.ping(), timeout=0.5); checks["redis"] = "degraded_ok"
    except Exception:
        checks["redis"] = "fail"     # cache down = slower, not broken
    ready = checks["db"] == "ok"
    return JSONResponse({"ready": ready, "checks": checks},
                        status_code=200 if ready else 503)
```

> **Optimization note.** Four measurable wins, in order of payoff. (1) **Cache the redirect** — a >99% Redis hit ratio takes p99 from ~25 ms to ~4 ms and removes 99% of database reads; warm the cache write-through on create so the first click is never a miss. (2) **Never `COUNT(*)` for pagination** — fetch `limit + 1` rows; an exact total on a 50-million-row table is a sequential scan you shipped by accident. (3) **Pool connections properly** — put pgbouncer in transaction mode in front of Postgres; four uvicorn workers × 20-connection pools × 10 pods is 800 connections and Postgres falls over well before that. (4) **Batch the click consumer** — 500 events per transaction instead of one insert per click reduces write amplification by two orders of magnitude, at the cost of up to two seconds of analytics staleness that nobody notices.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Layered architecture | Business logic is testable without HTTP; repositories swap freely | More files and indirection; overkill for a genuinely small service |
| FastAPI + Pydantic | Validation, serialisation and OpenAPI from one type declaration | Async everywhere; one blocking call in a handler stalls the event loop |
| Separate Create/Update/Public schemas | Mass assignment is impossible by construction | Three models per resource to keep in sync |
| Redis cache on the read path | 6× latency reduction, 99% fewer DB reads | Invalidation on update/delete is now a correctness requirement, not an optimisation |
| Async click ingestion | Redirect latency unaffected by analytics volume | A crash loses a few seconds of clicks; consumer lag becomes a new thing to monitor |
| `302` rather than `301` | Links stay editable and revocable | No browser-side caching, so every click is a request you serve |
| Idempotency records in Postgres | Same transaction as the write, so they cannot diverge | Table growth needs TTL eviction and partitioning |
| Optimistic concurrency (`If-Match`) | No locks, no lost updates | Clients must handle `412`; `428` rejects lazy clients that would otherwise work |
| Containerised rolling deploy | Reproducible, rollback in one command | Migrations must be expand-then-contract or a rollback breaks on schema |
| Prometheus + OTel | Real answers to "is it healthy" and "where did the time go" | Cardinality discipline required — one unbounded label melts the metrics store |

## 7. Common Mistakes & Best Practices

1. ⚠️ Putting business logic in route handlers so it can only be tested through HTTP. → ✅ Handlers parse, delegate and set status codes; services hold rules and know nothing about `Request`.
2. ⚠️ Accepting the full model on create, letting a client set `id` or `workspace_id`. → ✅ Separate `Create`/`Update`/`Public` schemas with `extra: "forbid"`. Mass assignment is a top-tier API vulnerability and this removes it structurally.
3. ⚠️ Checking "does this slug exist?" then inserting. → ✅ Insert and catch the `UNIQUE` violation. Check-then-insert is a race that manifests exactly when traffic is high; the constraint is the only real arbiter.
4. ⚠️ Writing the click row synchronously inside the redirect. → ✅ Push to a stream and return. The hot path budget belongs to the user, not to your analytics.
5. ⚠️ A readiness probe that checks every dependency, and a liveness probe that checks anything at all. → ✅ Liveness = "the process responds". Readiness = "I can serve" — and degrade gracefully: Redis down should mean slower, not `503`.
6. ⚠️ Running destructive migrations in the same deploy as the code. → ✅ Expand → deploy → backfill → contract, across separate releases. A rollback must not need a schema rollback.
7. ⚠️ Logging full request bodies "for debugging". → ✅ Log a redacted, structured subset with `request_id`; bodies contain tokens, emails and target URLs, and log stores are rarely as protected as your database.
8. ⚠️ Unbounded `limit` on the list endpoint. → ✅ Default 20, hard cap 100, validated by the type (`Query(20, ge=1, le=100)`). One `?limit=1000000` is a self-inflicted outage.
9. ⚠️ Returning `200` with `{"error": ...}` for failures. → ✅ Correct status plus `application/problem+json`. Retry logic, dashboards, SDKs and load balancers all read the status line.
10. ⚠️ Using `PUT` and letting omitted fields silently null out data. → ✅ `PUT` is a full replacement — document it that way, require every field, and offer `PATCH` with JSON Merge Patch for partial edits.
11. ⚠️ Caching the redirect but forgetting to invalidate on update and delete. → ✅ Invalidate in the same service method that writes, and set a TTL as a backstop so a missed invalidation self-heals within an hour.
12. ⚠️ High-cardinality metric labels — `link_id`, `slug`, raw path. → ✅ Label by *route template* (`/v1/links/{id}`), method and status only. A label with a million values will take down Prometheus before it takes down your API.
13. ⚠️ No graceful shutdown, so every deploy drops in-flight requests. → ✅ Handle `SIGTERM`, stop accepting connections, drain with a timeout, flush the click buffer, then exit — and set the pod's `terminationGracePeriodSeconds` above that timeout.
14. ⚠️ Accepting any `target_url` a client sends. → ✅ Allow-list schemes, reject private and link-local hosts, and re-resolve at redirect time if you follow the URL server-side — an open redirector to `169.254.169.254` is an SSRF handed to attackers for free.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Generate `X-Request-Id` in the outermost middleware if the proxy did not supply one, stash it on `request.state`, include it in every log line *and* in every problem+json body, and echo it as a response header. That one thread turns "a customer says creating links failed around 3pm" into a single indexed query. Log as JSON with fixed keys (`ts`, `level`, `msg`, `request_id`, `workspace_id`, `route`, `status`, `duration_ms`) and never interpolate values into the message — you cannot aggregate on prose. Add OpenTelemetry auto-instrumentation for FastAPI, asyncpg and Redis so a slow request decomposes into spans; the most common surprise it reveals is not slow SQL but connection-pool wait time, which is invisible in query logs. Keep a `/v1/_debug/echo` endpoint behind an internal-only scope that returns the headers and parsed body exactly as the server saw them — it resolves "but I sent that field" arguments in seconds.

**Monitoring.** Instrument the four golden signals per route template. Traffic: `http_requests_total{route,method,status}`. Errors: the `5xx` share of that counter, plus `4xx` tracked separately since a `4xx` spike is a contract or client problem, not an outage. Latency: `http_request_duration_seconds` as a histogram — never an average; publish p50/p95/p99 per route because the redirect and the analytics endpoint have utterly different profiles. Saturation: `db_pool_in_use / db_pool_size`, event-loop lag, and Redis memory. Then the service-specific SLIs that actually predict pain: `redirect_cache_hit_ratio` (alert below 95%), `click_consumer_lag_seconds` (alert above 60 s — analytics stale, redirects fine, so ticket rather than page), `idempotent_replay_total` (rising means clients are timing out), and `rate_limit_rejections_total{workspace}` (one tenant hammering is a business conversation, not an incident). Define SLOs — redirect availability 99.95%, redirect p99 < 100 ms, management-API p99 < 300 ms — and alert on **error-budget burn rate**, not on instantaneous thresholds, so a 30-second blip does not page anyone at 3 a.m.

**Security.** API keys are stored as `argon2id(key + pepper)`, shown exactly once at creation, prefixed (`zk_live_` / `zk_test_`) so they are greppable in leaked repos and unmistakable in a mis-paste, and scoped (`links:read`, `links:write`, `analytics:read`) so a reporting integration cannot create links. Authentication resolves a principal at the edge of the app; **authorization is a `WHERE workspace_id = $1` that no query can omit**, because the repository is constructed with the workspace and has no API to query without it — that is how you make OWASP API1 (BOLA) structurally impossible rather than a thing you remember to check. Rate limit per key with a token bucket in Redis, returning `429` with `Retry-After` and the `X-RateLimit-*` triple. Set `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and a restrictive CORS allow-list — never `Access-Control-Allow-Origin: *` alongside credentials. Validate target URLs against an SSRF deny-list. Hash visitor IPs with a rotating salt rather than storing them, so analytics stays useful and the data stops being personal. Run `pip-audit` and `trivy` in CI and fail on high-severity findings.

**Performance & Scaling.** The API is stateless, so horizontal scaling is the first and easiest lever — but only after pgbouncer is in front of Postgres, because otherwise scaling pods scales connections and kills the database first. Reads scale with the Redis cache and a read replica for list and analytics queries; writes are low volume and stay on the primary. When click volume outgrows Postgres, move `click_events` to ClickHouse and keep only rollups relational — the API contract does not change, which is the payoff of having made analytics a derived read model. Partition `click_events` by month and drop old partitions rather than issuing `DELETE`s. At global scale, the redirect is a natural edge workload: replicate the slug→URL map to an edge KV store and serve `302`s from the nearest PoP, keeping the management API in one region. Finally, load-test before you need to: `k6` against a seeded dataset, ramping to 3× projected peak, watching p99 and pool saturation — the number you learn is your real capacity, and it is always lower than the one you guessed.

## 9. Interview Questions

**Q: Walk me through the layers of a production API service and what belongs in each.**
A: Routers handle HTTP only — parse and validate input, call a service, set status codes and headers. Services hold business rules and know nothing about `Request` or `Response`, which makes them unit-testable without a client. Repositories own persistence and are constructed scoped to a tenant. Cross-cutting concerns — request ID, logging, CORS, security headers, rate limiting, authentication — live in middleware, in that order.

**Q: Why `302` rather than `301` for a short link redirect?**
A: `301` is cached by browsers essentially forever, so once a user follows a link you can never change or revoke its target for them — the browser stops asking. `302` (or `307`, which also guarantees the method isn't rewritten) keeps every click as a request you control, at the cost of serving that traffic. For an editable, revocable, analytics-bearing link, `302` is correct.

**Q: How do you allocate a unique slug safely under concurrency?**
A: Generate a random candidate, attempt the insert, and catch the `UNIQUE` constraint violation, retrying a few times. Checking for existence first and then inserting is a time-of-check/time-of-use race that fails precisely under load. The database constraint is the only authority; application-level checks are an optimisation at best.

**Q: What's the difference between liveness and readiness probes, and what's the classic mistake?**
A: Liveness answers "should this process be restarted" and must depend on nothing external. Readiness answers "should this instance receive traffic" and may check dependencies. The classic mistake is checking the database in liveness — when the database blips, every pod is declared dead and restarted simultaneously, turning a brief dependency issue into a full outage.

**Q: How do you deploy a schema change without downtime?**
A: Expand-then-contract across separate releases. Release 1 adds the new nullable column or table; release 2 deploys code that writes both old and new; a backfill migrates existing rows; release 3 deploys code that reads only the new shape; release 4 drops the old column. At every point both the previous and current code work against the live schema, so any single release can be rolled back.

**Q: Why not write the click record synchronously during the redirect?**
A: Because the redirect is 99.9% of traffic and has a tens-of-milliseconds latency budget that belongs to the user. A synchronous insert adds database latency and couples redirect availability to write availability. Pushing to a Redis Stream costs a fraction of a millisecond, and losing a few seconds of analytics in a crash is an explicitly acceptable trade — analytics is not a ledger.

**Q: What's in the error response and why does it matter?**
A: RFC 9457 `application/problem+json` with `type` (a stable URI identifying the error class), `title`, `status`, `detail`, `instance`, plus domain extensions like `slug` on a conflict and the `request_id`. Machines branch on `type` and `status`; humans read `detail`. Clients must never regex a human message, because messages get reworded and codes must not.

**Q: How does multi-tenancy stay safe as the codebase grows?**
A: Make it structural rather than disciplinary. The repository is constructed with the workspace ID and exposes no method that can query without it, so there is no code path a new engineer can write that forgets the filter. Back that with a test per endpoint asserting that another tenant's object ID returns `404` — `404` rather than `403`, since `403` confirms the object exists.

**Q: (Senior) Redirect p99 jumps from 8 ms to 400 ms after a deploy but p50 is unchanged. Diagnose it.**
A: An unchanged p50 with a blown p99 means a tail, not general saturation — a subset of requests is taking a slow path. The first suspect is cache hit ratio: a deploy that changed the cache key format effectively emptied the cache, so misses fall through to Postgres. Check `redirect_cache_hit_ratio` against the deploy marker. Other candidates in order: connection-pool exhaustion showing as queueing (visible only in traces, not query logs), a lost index after a migration, and one slow Redis node. The fix path is roll back first, diagnose from the metric second.

**Q: (Senior) A single workspace is generating 80% of your traffic and degrading everyone. What do you do?**
A: Short term, tighten that key's rate limit and return `429` with an honest `Retry-After` — shedding load deliberately is far better than a shared brownout. Medium term, introduce per-tenant quotas with a fair-queueing or weighted token-bucket scheme so one tenant cannot consume the shared pool, and consider a dedicated pod pool or connection pool for the largest tenants. Long term this is a product conversation: a tenant at that share is either on the wrong plan or the workload belongs on a bulk endpoint you should build.

**Q: (Senior) How do you evolve this API without breaking existing integrations?**
A: Additive changes only, with a documented must-ignore rule and a contract test that injects unknown fields into responses to prove SDKs tolerate them. Never add a value to a response enum; design status-like fields as open strings with a documented fallback from the start. Run `oasdiff` in CI against the deployed spec and fail any breaking delta without a declared version bump. When a break is genuinely required, ship a new version served from one implementation via response transformers, signal with `Deprecation` and `Sunset` headers, and drive migration with per-consumer usage metrics rather than a calendar date.

**Q: (Senior) You must add "click analytics per country per hour" to an endpoint that already serves per-day rollups over 400 million events. How?**
A: Do not change the read path to scan raw events. Add an hourly rollup table maintained by the same consumer with an `ON CONFLICT DO UPDATE` upsert, backfill it from the raw partitions offline, and expose the granularity as a `group_by=hour` parameter with a bounded range — hourly data over a year is 8,760 rows per link per country and must be capped. Keep the daily rollup as the default so existing clients are unaffected, and put a retention policy on hourly data (say 90 days) so the table does not grow without limit.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Design the **contract first** (endpoint table, status codes, RFC 9457 error shape), then build inward-out: repositories scoped to a tenant by construction, services with no HTTP types, routers that only parse and set codes. Separate `Create`/`Update`/`Public` Pydantic models with `extra: "forbid"` — that single choice kills mass assignment and turns client typos into `422`s. Identify the hot path (here: the redirect at 1000:1) and design it first: cache it, keep writes off it, and push analytics to a stream. Use the `UNIQUE` constraint, not a check-then-insert, for slug conflicts (`409`). Guard updates with `If-Match` → `412`/`428`. Paginate with cursors, `limit + 1`, never `COUNT(*)`. Liveness checks nothing; readiness checks the database and degrades gracefully when the cache is down. Migrate expand-then-contract. Ship a multi-stage non-root image with graceful shutdown behind pgbouncer. Instrument the four golden signals per **route template** (never per ID), alert on error-budget burn and on symptoms — redirect p99, `5xx` rate, consumer lag, cache hit ratio — and make every response carry an `X-Request-Id` you can search on.

| Concern | Production answer |
|---|---|
| Create success | `201` + `Location` + `ETag` |
| Slug taken | `409` + problem+json with `slug` extension |
| Stale / missing `If-Match` | `412` / `428` |
| Deleted | `204`, and evict the cache entry in the same call |
| Expired link | `410 Gone` (not `404`) |
| Over quota | `429` + `Retry-After` + `X-RateLimit-*` |
| Liveness `/healthz` | No dependency checks, ever |
| Readiness `/readyz` | DB required; Redis degraded-OK |
| Metric labels | route template, method, status — never IDs |
| Migration order | expand → deploy → backfill → contract |
| Secrets | env vars into a typed `Settings`; keys hashed with argon2id + pepper |

- **Contract before code** → endpoint table and error shape settled before the first handler.
- **`extra: "forbid"`** → mass-assignment prevention and typo detection in one line.
- **Constraint over check** → catch `UniqueViolation`; check-then-insert is a race.
- **Liveness checks nothing** → a DB blip must not restart your entire fleet.
- **Label by route template** → one high-cardinality label melts the metrics store.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement `POST /v1/links` with custom-slug conflict handling and prove the race by firing 100 concurrent requests for the same slug — assert exactly one `201` and ninety-nine `409`s.
- [ ] Add the RFC 9457 handler chain, then write a test asserting that a validation error, a `404`, a `409` and an unhandled exception all return `application/problem+json` with a `request_id`.
- [ ] Add `If-Match` optimistic concurrency to `PUT /v1/links/{id}` and write tests for the `200`, `412` and `428` branches.
- [ ] Benchmark the redirect with and without the Redis cache using `k6` at 2,000 RPS; record p50/p95/p99 and the Postgres query count for both.
- [ ] Write an expand-then-contract migration that renames `target_url` to `destination_url` across four releases without downtime, and prove each intermediate state works with both old and new code.

**Mini Project — "Ship zariya.link."**
*Goal:* Take the design in this chapter from empty repository to a deployed, observable, documented API you would let a stranger integrate against.
*Requirements:*
1. **Design** — an OpenAPI 3.1 document covering all eight endpoints with request/response schemas, every error status, and security schemes; linted clean with Spectral.
2. **Implement** — FastAPI with the layered structure, Alembic migrations, Redis cache and click stream, a batching consumer, API-key auth with scopes and argon2id hashing, per-key token-bucket rate limiting, cursor pagination, and `If-Match` concurrency.
3. **Secure** — SSRF-safe URL validation, hashed visitor IPs, security headers, a CORS allow-list, and a test per endpoint proving cross-tenant access returns `404`.
4. **Test** — unit tests for services with fakes, integration tests against a real Postgres container, contract tests validating live responses against the OpenAPI schema, and a `k6` load script.
5. **Deploy** — multi-stage non-root Dockerfile, `docker compose` with Postgres/Redis/API/consumer, health probes, graceful shutdown, and a CI pipeline running lint, types, tests, spec lint, `oasdiff` and an image scan.
6. **Observe** — `/metrics` with the golden signals plus cache hit ratio and consumer lag, JSON logs with `request_id`, OpenTelemetry traces, a dashboard, and three alerts with a written runbook.

*Extensions:* add a webhook that fires on click thresholds with HMAC signing and exponential-backoff retries; add a `GET /v1/links/{id}/analytics?group_by=hour` endpoint backed by a new rollup table with a bounded range; move `click_events` to ClickHouse behind the unchanged API contract; add a `/v2` that renames a field and serve both versions from one implementation via a response transformer; deploy the redirect path to an edge runtime with a replicated KV slug map and measure the latency difference from three continents.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Error Handling & RFC 9457* for the problem-details contract used throughout; *Pagination Patterns* for the cursor implementation; *Authentication: API Keys, JWT & OAuth* for the key-hashing and scope model; *Rate Limiting & Throttling* for the token bucket; *OpenAPI & Documentation* for generating and linting the spec; *Testing APIs* for the pyramid and contract tests; *API Governance, Lifecycle & Developer Portals* (chapter 43) for running this as a long-lived product; *REST API System Design (Interview)* (chapter 45) for the design round this capstone implements.

**Free Learning Resources**
- **FastAPI Documentation** — Sebastián Ramírez · *Beginner→Advanced* · the "Bigger Applications," "Dependencies" and "Security" guides map directly onto the structure used here. <https://fastapi.tiangolo.com/>
- **Google SRE Book — Monitoring Distributed Systems** — Google · *Intermediate* · the four golden signals, SLOs and error-budget alerting behind section 8. <https://sre.google/sre-book/monitoring-distributed-systems/>
- **RFC 9457 — Problem Details for HTTP APIs** — IETF · *Intermediate* · the normative error format this service returns for every failure. <https://www.rfc-editor.org/rfc/rfc9457>
- **RFC 9110 — HTTP Semantics** — IETF · *Advanced* · the source of truth for `201`/`202`/`204`/`409`/`412`/`428` and conditional-request semantics. <https://www.rfc-editor.org/rfc/rfc9110>
- **OWASP API Security Top 10** — OWASP · *Intermediate* · BOLA, mass assignment and unrestricted resource consumption are all designed against in this chapter. <https://owasp.org/API-Security/editions/2023/en/0x11-t10/>
- **The Twelve-Factor App** — Adam Wiggins · *Beginner* · config in the environment, stateless processes, disposability and graceful shutdown — the deployment assumptions used here. <https://12factor.net/>
- **Zero-Downtime Database Migrations (expand/contract)** — Martin Fowler / ThoughtWorks · *Intermediate* · the parallel-change pattern behind the four-release migration. <https://martinfowler.com/bliki/ParallelChange.html>
- **Prometheus Best Practices — Metric and Label Naming** — Prometheus · *Intermediate* · why you label by route template and never by ID; the cardinality rules that keep monitoring alive. <https://prometheus.io/docs/practices/naming/>

---

*REST API Handbook — chapter 46.*
