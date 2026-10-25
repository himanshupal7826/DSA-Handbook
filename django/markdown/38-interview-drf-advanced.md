# 38 · Most-Asked Django Interview Questions: DRF, Security & Scale

> **In one line:** The DRF, security, async, Celery, testing and scaling questions that make up the second half of every backend Django interview, plus the scenario questions ("the API got slow", "users see each other's data", "duplicate orders on retry") where you are judged on how you debug, not on what you remember.

---

## 1. Overview

> **Builds on:** [Ch 37 · Most-Asked Django Interview Questions: Core & ORM](topic.html?p=37-interview-core-orm) for the request lifecycle and the ORM, plus the concept chapters from [Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers) to [Ch 36 · Django Internals](topic.html?p=36-django-internals). Each answer here is compressed and links the chapter that teaches the topic.

Most Django jobs today are API jobs, so once an interviewer is satisfied with your ORM knowledge, they move to DRF, then to how you secure the API, then to how it behaves under load. Questions at mid and senior level increasingly take the form of **scenarios**: an incident description with no stated topic. You are expected to form hypotheses, name the tools you would use, and explain the fix and how you would prevent it happening again.

### How the second half of the interview usually goes

| Stage | Typical prompt | What a strong answer shows |
|---|---|---|
| DRF fundamentals | "Serializer vs ModelSerializer?", "ViewSet vs APIView?" | You know the DRF request flow (`dispatch`, `initial`, handler) |
| Auth & permissions | "Session or JWT for our SPA?", "How do object permissions work?" | Threat models and trade-offs, not a favourite library |
| Security | "How does Django prevent CSRF?", "What does `check --deploy` flag?" | Exact mechanisms and the settings that turn them on |
| Performance & async | "When do async views help?", "How do you cache this endpoint?" | Knowing where time actually goes (I/O vs CPU vs DB) |
| Background work | "How do you send 1M emails?", "A task ran twice — why?" | At-least-once thinking, idempotency, `on_commit` |
| Scale & ops | "We're running out of DB connections", "Zero-downtime deploys?" | Numbers: workers × threads × pods vs `max_connections` |
| Scenarios | "The API got slow after Tuesday's release" | A method: scope, measure, hypothesise, verify, fix, guard against recurrence |

### What each level is expected to know

- **Junior:** write a ModelSerializer and a ModelViewSet with a router, use `IsAuthenticated`, explain CSRF at a high level, run tests with `APIClient`.
- **Mid:** validation hooks, `get_queryset` scoping, object permissions and the list-view gap, JWT vs session trade-offs, pagination types, throttling scopes, Celery retries and `on_commit`, cache layers, `assertNumQueries` on API endpoints.
- **Senior:** auth architecture for web plus mobile, token revocation, multi-tenant isolation that can't be bypassed by accident, idempotency keys, async vs threads vs workers sizing, connection budgets and pooling, read replicas with read-your-writes, safe deploys, and a clear incident-debugging method.

## 2. Core Concepts

The topic map below lists what this chapter covers, which chapter teaches each area, and how often it comes up.

| Area | Typical questions | Home chapter | Frequency |
|---|---|---|---|
| Serializers | validation order, nested writes, `SerializerMethodField` N+1 | [Ch 21](topic.html?p=21-drf-serializers) | Very high |
| Views, viewsets, routers | `APIView` vs `GenericAPIView` vs `ModelViewSet`, `@action`, `get_queryset` | [Ch 22](topic.html?p=22-drf-views-viewsets-routers) | Very high |
| Auth, permissions, throttling | session/token/JWT, `has_object_permission`, rate scopes | [Ch 23](topic.html?p=23-drf-auth-permissions-throttling) | Very high |
| Pagination, filtering, versioning | cursor vs offset, django-filter, versioning schemes | [Ch 24](topic.html?p=24-drf-pagination-filtering-versioning) | High |
| Custom user & auth | `AbstractUser` vs `AbstractBaseUser`, backends, hashing | [Ch 25](topic.html?p=25-authentication-custom-user) | Very high |
| Authorization | permissions, groups, object-level, multi-tenant | [Ch 26](topic.html?p=26-permissions-authorization) | High |
| Sessions & cookies | session engines, cookie flags | [Ch 27](topic.html?p=27-sessions-cookies) | Medium |
| Security | CSRF, XSS, SQLi, clickjacking, deploy checklist | [Ch 28](topic.html?p=28-security) | Very high |
| Caching | per-view, low-level, invalidation, stampede | [Ch 29](topic.html?p=29-caching) | High |
| Async & ASGI | async views, async ORM, `sync_to_async` | [Ch 30](topic.html?p=30-async-django-asgi) | High (rising) |
| Celery | retries, idempotency, `on_commit`, beat, canvas | [Ch 31](topic.html?p=31-celery-background-tasks) | Very high |
| Channels | consumers, groups, channel layer | [Ch 32](topic.html?p=32-channels-websockets) | Medium |
| Testing | `TestCase` vs `TransactionTestCase`, factories, mocking | [Ch 33](topic.html?p=33-testing) | High |
| Scaling databases | pooling, replicas, routers, multi-DB | [Ch 34](topic.html?p=34-scaling-databases) | High (senior) |
| Deployment | Gunicorn/Uvicorn, static, settings, migrations on deploy | [Ch 35](topic.html?p=35-deployment-production) | High |

Vocabulary the answers rely on:

- **Authentication vs authorization**: *who are you* vs *what may you do*. *Why it matters:* DRF runs them as separate steps (`perform_authentication`, then `check_permissions`), and most data leaks are authorization bugs.
- **Object-level permission**: a check against a specific instance. *Why it matters:* DRF calls it only from `get_object()`, so list endpoints need queryset scoping instead.
- **At-least-once**: the delivery guarantee you actually get from Celery with `acks_late`, from retries, and from clients retrying. *Why it matters:* every handler that has side effects must be idempotent.
- **Idempotency key**: a client-supplied unique key that makes a retried POST return the original result. *Why it matters:* it is the standard answer to "duplicate orders on retry".
- **Connection budget**: processes × threads × pods, compared with what the database can accept. *Why it matters:* "too many connections" is the most common scaling outage in Django.

## 3. Theory & Principles

### The DRF request flow (draw this for any DRF question)

Almost every DRF question, whether about auth, permissions, throttling or serializers, is answered by knowing where in `APIView.dispatch()` the thing happens.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj38a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj38b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">APIView.dispatch(): where auth, permissions, throttles and serializers run</text>
  <rect x="16" y="50" width="130" height="56" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="81" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">Django request</text>
  <text x="81" y="90" text-anchor="middle" fill="#334155" font-size="9">after middleware and URL</text>
  <path d="M148,78 L170,78" stroke="#2563eb" stroke-width="2" marker-end="url(#dj38a)"/>
  <rect x="172" y="50" width="130" height="56" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="237" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">initialize_request</text>
  <text x="237" y="90" text-anchor="middle" fill="#334155" font-size="9">wraps in DRF Request</text>
  <path d="M304,78 L326,78" stroke="#2563eb" stroke-width="2" marker-end="url(#dj38a)"/>
  <rect x="328" y="40" width="300" height="140" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="478" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">initial()</text>
  <rect x="344" y="70" width="268" height="28" rx="5" fill="#ffffff" stroke="#7c3aed"/>
  <text x="478" y="88" text-anchor="middle" fill="#334155" font-size="10">1. perform_authentication: request.user (lazy)</text>
  <rect x="344" y="104" width="268" height="28" rx="5" fill="#ffffff" stroke="#7c3aed"/>
  <text x="478" y="122" text-anchor="middle" fill="#334155" font-size="10">2. check_permissions: has_permission()</text>
  <rect x="344" y="138" width="268" height="28" rx="5" fill="#ffffff" stroke="#7c3aed"/>
  <text x="478" y="156" text-anchor="middle" fill="#334155" font-size="10">3. check_throttles: rate in the cache</text>
  <path d="M630,110 L652,110" stroke="#2563eb" stroke-width="2" marker-end="url(#dj38a)"/>
  <rect x="654" y="40" width="212" height="140" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="760" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Handler (list / create...)</text>
  <text x="670" y="84" fill="#334155" font-size="10">get_queryset(): scope rows here</text>
  <text x="670" y="102" fill="#334155" font-size="10">get_object(): object permissions</text>
  <text x="670" y="120" fill="#334155" font-size="10">serializer.is_valid(): validate</text>
  <text x="670" y="138" fill="#334155" font-size="10">perform_create(): save(owner=...)</text>
  <text x="670" y="156" fill="#334155" font-size="10">paginate, serializer.data</text>
  <path d="M760,182 L760,214" stroke="#2563eb" stroke-width="2" marker-end="url(#dj38a)"/>
  <rect x="654" y="216" width="212" height="50" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="760" y="236" text-anchor="middle" fill="#1e293b" font-weight="bold">finalize_response</text>
  <text x="760" y="252" text-anchor="middle" fill="#334155" font-size="9">content negotiation, renderer</text>
  <rect x="328" y="216" width="300" height="50" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="478" y="236" text-anchor="middle" fill="#1e293b" font-weight="bold">handle_exception</text>
  <text x="478" y="252" text-anchor="middle" fill="#334155" font-size="9">401 / 403 / 429 / 400, via EXCEPTION_HANDLER</text>
  <path d="M478,182 L478,214" stroke="#dc2626" stroke-width="2" stroke-dasharray="4 3" marker-end="url(#dj38b)"/>
  <rect x="16" y="290" width="850" height="74" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="441" y="312" text-anchor="middle" fill="#1e293b" font-weight="bold">The three facts interviewers probe</text>
  <text x="32" y="332" fill="#334155" font-size="10">has_object_permission runs only when get_object() runs, so list endpoints are protected only by get_queryset() filtering.</text>
  <text x="32" y="350" fill="#334155" font-size="10">Authentication is lazy, and failing to authenticate is not an error: the user becomes AnonymousUser, and permissions decide.</text>
</svg>
```

### The scenario-question method

Scenario questions are scored on method. Use the same six steps every time, and say each one out loud.

```svg
<svg viewBox="0 0 880 250" width="100%" height="250" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj38c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Debugging a production scenario out loud: six beats</text>
  <rect x="16" y="46" width="132" height="110" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="82" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">1. Scope</text>
  <text x="82" y="88" text-anchor="middle" fill="#334155" font-size="9">Which endpoints?</text>
  <text x="82" y="102" text-anchor="middle" fill="#334155" font-size="9">All users or some?</text>
  <text x="82" y="116" text-anchor="middle" fill="#334155" font-size="9">Since when?</text>
  <path d="M150,100 L162,100" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj38c)"/>
  <rect x="164" y="46" width="132" height="110" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="230" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">2. Stop the bleed</text>
  <text x="230" y="88" text-anchor="middle" fill="#334155" font-size="9">Roll back, flip a flag,</text>
  <text x="230" y="102" text-anchor="middle" fill="#334155" font-size="9">disable the cache.</text>
  <text x="230" y="116" text-anchor="middle" fill="#334155" font-size="9">Mitigate first.</text>
  <path d="M298,100 L310,100" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj38c)"/>
  <rect x="312" y="46" width="132" height="110" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="378" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">3. Measure</text>
  <text x="378" y="88" text-anchor="middle" fill="#334155" font-size="9">APM traces, Sentry,</text>
  <text x="378" y="102" text-anchor="middle" fill="#334155" font-size="9">pg_stat_statements,</text>
  <text x="378" y="116" text-anchor="middle" fill="#334155" font-size="9">deploy diff.</text>
  <path d="M446,100 L458,100" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj38c)"/>
  <rect x="460" y="46" width="132" height="110" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="526" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">4. Hypothesise</text>
  <text x="526" y="88" text-anchor="middle" fill="#334155" font-size="9">Two or three ranked</text>
  <text x="526" y="102" text-anchor="middle" fill="#334155" font-size="9">causes, each with</text>
  <text x="526" y="116" text-anchor="middle" fill="#334155" font-size="9">a test that rules it out.</text>
  <path d="M594,100 L606,100" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj38c)"/>
  <rect x="608" y="46" width="124" height="110" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="670" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">5. Fix</text>
  <text x="670" y="88" text-anchor="middle" fill="#334155" font-size="9">Smallest safe change,</text>
  <text x="670" y="102" text-anchor="middle" fill="#334155" font-size="9">then verify the</text>
  <text x="670" y="116" text-anchor="middle" fill="#334155" font-size="9">metric recovers.</text>
  <path d="M734,100 L746,100" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj38c)"/>
  <rect x="748" y="46" width="118" height="110" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="807" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">6. Prevent</text>
  <text x="807" y="88" text-anchor="middle" fill="#334155" font-size="9">Test, alert,</text>
  <text x="807" y="102" text-anchor="middle" fill="#334155" font-size="9">constraint, or</text>
  <text x="807" y="116" text-anchor="middle" fill="#334155" font-size="9">guard-rail in CI.</text>
  <rect x="16" y="180" width="850" height="50" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="441" y="200" text-anchor="middle" fill="#1e293b" font-weight="bold">The senior signal is beats 2 and 6</text>
  <text x="441" y="218" text-anchor="middle" fill="#334155" font-size="10">Juniors jump straight to a fix. Seniors mitigate first and finish with a structural guard so the bug class cannot return.</text>
</svg>
```

### Principles for this half of the interview

1. **Security answers name the mechanism and the setting.** "Django has CSRF protection" earns nothing. "`CsrfViewMiddleware` compares a masked token from the form or the `X-CSRFToken` header with the `csrftoken` cookie on unsafe methods, and checks `Origin` against `CSRF_TRUSTED_ORIGINS` on HTTPS" earns the point.
2. **Scale answers come with arithmetic.** "4 pods × 9 Gunicorn workers × 1 connection = 36, plus Celery 4 × 8 = 32, plus beat and cron, against `max_connections=100`" is the answer interviewers are looking for.
3. **Every side effect is at-least-once.** Retries from clients, Celery redeliveries and webhook replays all mean the handler must be idempotent. Say so before they ask.

## 4. Architecture & Workflow

### The production topology to draw for "how would you deploy and scale this?"

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj38d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj38e" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">A typical production Django stack and where each question lives</text>
  <rect x="16" y="50" width="110" height="50" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="71" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">CDN</text>
  <text x="71" y="88" text-anchor="middle" fill="#334155" font-size="9">static, cached GETs</text>
  <path d="M128,75 L148,75" stroke="#2563eb" stroke-width="2" marker-end="url(#dj38d)"/>
  <rect x="150" y="50" width="120" height="50" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="210" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">Load balancer</text>
  <text x="210" y="88" text-anchor="middle" fill="#334155" font-size="9">TLS ends here</text>
  <path d="M272,75 L292,75" stroke="#2563eb" stroke-width="2" marker-end="url(#dj38d)"/>
  <rect x="294" y="40" width="250" height="120" rx="10" fill="#dbeafe" stroke="#2563eb"/>
  <text x="419" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Web pods (N replicas)</text>
  <text x="310" y="82" fill="#334155" font-size="10">Gunicorn: 2 x cores + 1 sync workers</text>
  <text x="310" y="100" fill="#334155" font-size="10">or Uvicorn workers for ASGI</text>
  <text x="310" y="118" fill="#334155" font-size="10">SECURE_PROXY_SSL_HEADER set</text>
  <text x="310" y="136" fill="#334155" font-size="10">1 DB connection per worker thread</text>
  <path d="M546,100 L580,100" stroke="#2563eb" stroke-width="2" marker-end="url(#dj38d)"/>
  <rect x="582" y="70" width="120" height="60" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="642" y="94" text-anchor="middle" fill="#1e293b" font-weight="bold">PgBouncer</text>
  <text x="642" y="110" text-anchor="middle" fill="#334155" font-size="9">or native pool (5.1+)</text>
  <path d="M704,100 L730,100" stroke="#2563eb" stroke-width="2" marker-end="url(#dj38d)"/>
  <rect x="732" y="50" width="134" height="50" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="799" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">Postgres primary</text>
  <text x="799" y="88" text-anchor="middle" fill="#334155" font-size="9">writes, max_connections</text>
  <rect x="732" y="116" width="134" height="44" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="799" y="136" text-anchor="middle" fill="#1e293b" font-weight="bold">Read replica</text>
  <text x="799" y="150" text-anchor="middle" fill="#334155" font-size="9">router, lag</text>
  <path d="M799,102 L799,114" stroke="#16a34a" stroke-width="2" marker-end="url(#dj38e)"/>
  <rect x="294" y="190" width="160" height="56" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="374" y="212" text-anchor="middle" fill="#1e293b" font-weight="bold">Redis</text>
  <text x="374" y="230" text-anchor="middle" fill="#334155" font-size="9">cache, throttles, broker, layer</text>
  <path d="M374,162 L374,188" stroke="#dc2626" stroke-width="2" marker-end="url(#dj38d)"/>
  <rect x="490" y="190" width="200" height="56" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="590" y="212" text-anchor="middle" fill="#1e293b" font-weight="bold">Celery workers + beat</text>
  <text x="590" y="230" text-anchor="middle" fill="#334155" font-size="9">own connection budget, acks_late</text>
  <path d="M456,218 L488,218" stroke="#d97706" stroke-width="2" marker-end="url(#dj38d)"/>
  <path d="M692,218 L740,218 L740,164" stroke="#d97706" stroke-width="2" marker-end="url(#dj38d)"/>
  <rect x="16" y="190" width="250" height="56" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="141" y="212" text-anchor="middle" fill="#1e293b" font-weight="bold">Channels (ASGI) pods</text>
  <text x="141" y="230" text-anchor="middle" fill="#334155" font-size="9">WebSockets via the Redis channel layer</text>
  <path d="M268,218 L292,218" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj38d)"/>
  <rect x="16" y="268" width="850" height="48" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="441" y="288" text-anchor="middle" fill="#1e293b" font-weight="bold">Release step (separate job): migrate, then roll out pods; collectstatic at build time</text>
  <text x="441" y="305" text-anchor="middle" fill="#334155" font-size="10">Every arrow is a question: cache headers, proxy SSL, worker sizing, pooling, replica lag, broker reliability.</text>
</svg>
```

### The request path for a typical authenticated API call

```text
Client --(Authorization: Bearer <jwt>)--> LB --> Gunicorn worker
  SecurityMiddleware -> SessionMiddleware -> CommonMiddleware -> CsrfViewMiddleware (view is csrf_exempt via APIView)
  -> AuthenticationMiddleware -> URL resolver -> OrderViewSet.as_view({"get": "list"})
  APIView.dispatch -> initial: JWTAuthentication (lazy) -> IsAuthenticated -> UserRateThrottle (Redis)
  list(): get_queryset() scoped to request.user -> filter_queryset -> paginate_queryset -> serializer -> Response
  finalize_response -> JSONRenderer -> back out through middleware
```

> **Gotcha:** `APIView.as_view()` wraps the view in `csrf_exempt`. CSRF is then enforced again *only* by `SessionAuthentication`, for requests it authenticates. That is why token- and JWT-authenticated calls don't need a CSRF token, while browser session calls still do.

## 5. Implementation

This is the question bank. Answer each one aloud before reading the answer. Every group links its home chapter.

### 5.1 DRF serializers

**Q: What is the difference between `Serializer` and `ModelSerializer`?**
A: A `Serializer` declares every field explicitly and requires you to write `create()` and `update()`. A `ModelSerializer` inspects the model to generate fields, includes validators for model field constraints and `unique` / `unique_together` / `UniqueConstraint` checks, and provides default `create()` and `update()`. Use `ModelSerializer` for CRUD on a model. Use a plain `Serializer` for input that does not map onto one model, such as a "checkout" command or a search request. Interviewers often follow up: ModelSerializer does **not** call `Model.clean()`, so validation in `clean()` is skipped unless you call it yourself. See [Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers).

**Q: Explain the serializer validation order.**
A: `is_valid()` calls `run_validation(data)`. First, `to_internal_value()` runs each field's own validation (type conversion, `required`, `max_length`, field validators), followed by that field's `validate_<field>(value)` method. Next, serializer-level `Meta.validators` run, such as `UniqueTogetherValidator`. Finally, `validate(attrs)` runs for checks across fields. Errors collect in `serializer.errors`, and `validated_data` is available only after validation passes. `is_valid(raise_exception=True)` raises `ValidationError`, which DRF turns into a 400. Calling `.save()` dispatches to `create()` or `update()`, depending on whether an `instance` was passed.

**Q: How do you write a nested writable serializer?**
A: DRF does not write nested data automatically, because it cannot know your intent: should missing children be deleted? Should the parent's id be trusted? You override `create()` (and `update()`), pop the nested data, create the parent, then create the children, all inside `transaction.atomic()`:

```python
class OrderSerializer(serializers.ModelSerializer):
    items = OrderItemSerializer(many=True)

    class Meta:
        model = Order
        fields = ["id", "items", "note"]

    @transaction.atomic
    def create(self, validated_data):
        items = validated_data.pop("items")
        order = Order.objects.create(customer=self.context["request"].user, **validated_data)
        OrderItem.objects.bulk_create([OrderItem(order=order, **i) for i in items])
        return order
```

For updates, decide explicitly whether to replace, merge or reject changes to the children. Many teams use separate endpoints for child resources instead.

**Q: Why can `SerializerMethodField` cause N+1 queries, and how do you fix it?**
A: The method runs once per object during `to_representation`, so if it queries the database (`obj.reviews.count()`), a list of 100 objects runs 100 queries. The fix is to move the computation into the viewset's `get_queryset()`: `annotate(review_count=Count("reviews"))` and read it with `serializers.IntegerField(read_only=True)`, or prefetch and compute from the cache. The same applies to nested serializers. Every relation a serializer touches needs a matching `select_related` or `prefetch_related` in `get_queryset()`. See [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization).

**Q: How do you set the owner of an object from the request, not from client input?**
A: Never accept `owner` as a writable field. Either mark it `read_only` and set it in the view with `perform_create(self, serializer): serializer.save(owner=self.request.user)`, or use `owner = serializers.HiddenField(default=serializers.CurrentUserDefault())`. Both prevent **mass assignment**, where a client sets fields it should not control. Related point: `fields = "__all__"` is risky on any model with sensitive fields. List fields explicitly.

**Q: What is the difference between `read_only`, `write_only`, `read_only_fields` and `extra_kwargs`?**
A: `read_only=True` fields appear in output but are ignored on input (ids, computed values). `write_only=True` fields are accepted on input but never returned (passwords). `Meta.read_only_fields` is a shortcut for marking generated fields read-only, and `extra_kwargs` sets options on generated fields without redeclaring them, for example `{"password": {"write_only": True}}`. Note that `read_only_fields` does not apply to fields you declare explicitly on the serializer.

**Q: How do you handle PATCH with serializers?**
A: Pass `partial=True` (`UpdateModelMixin.partial_update` does this), so required fields are not enforced and only the fields provided are validated and updated. Gotcha: in `validate(attrs)`, fields that were not sent are missing from `attrs`, so cross-field checks must fall back to `self.instance` values. Also, `update()` saves the whole model by default, so concurrent PATCHes to different fields can overwrite each other. Use `save(update_fields=...)` or optimistic locking if that matters.

**Q: How do you make a list endpoint that serializes 10,000 rows faster? (Senior)**
A: First, don't return 10,000 rows: paginate. If you really must (an export), measure where the time goes. It is usually (1) queries, so fix N+1 with `select_related`/`prefetch_related` and `only()`; then (2) serializer overhead, because DRF field-by-field serialization is pure Python and slow per object. Options: use `values()` plus a lightweight serializer or plain dicts for read-only lists, cache the serialized output, stream a CSV with `StreamingHttpResponse` and `iterator()`, or move the export to a Celery task that writes a file and notifies the user. Profile with `cProfile` or py-spy rather than guessing.

### 5.2 Views, viewsets & routers

**Q: `APIView` vs `GenericAPIView` vs `ViewSet` vs `ModelViewSet`?**
A: `APIView` is the base: you write `get()`/`post()` by hand and get DRF's request, auth, permissions, throttling and exception handling. `GenericAPIView` adds `queryset`, `serializer_class`, `get_queryset()`, `get_object()`, filtering and pagination. Combined with mixins (`ListModelMixin`, `CreateModelMixin`...), it gives the concrete generic views (`ListCreateAPIView`). `ViewSet` maps actions (`list`, `retrieve`) instead of HTTP methods, so one class serves a resource and a router generates the URLs. `ModelViewSet` is `GenericViewSet` plus all five CRUD mixins. Use viewsets for standard resources and `APIView` for actions that do not fit CRUD. See [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers).

**Q: Why override `get_queryset()` instead of setting `queryset`?**
A: The `queryset` attribute is static, defined once at class level. `get_queryset()` runs per request, so it can scope by `self.request.user` or tenant, choose `select_related` per action, or filter by query parameters. DRF calls `.all()` on the `queryset` attribute to avoid sharing a result cache between requests, but any per-user filtering *must* happen in `get_queryset()`. It is also the primary authorization mechanism for list endpoints, since object permissions do not run there.

**Q: How do you add a custom endpoint to a ViewSet?**
A: Use `@action`. `@action(detail=True, methods=["post"])` on `def cancel(self, request, pk=None)` creates `POST /orders/{pk}/cancel/`, and `detail=False` creates a collection route. You can set `permission_classes`, `serializer_class` and `url_path` per action. In `get_serializer_class()` and `get_permissions()`, branch on `self.action` to vary behaviour by action.

**Q: What do routers do, and `SimpleRouter` vs `DefaultRouter`?**
A: A router takes registered viewsets and generates URL patterns for the list and detail routes plus any `@action`s, binding HTTP methods to actions: `GET` to `list`, `POST` to `create`, and so on. `DefaultRouter` also adds an API root view and optional format-suffix patterns. `SimpleRouter` does not. Use `basename=` when the viewset has no `queryset` attribute, because the router derives URL names from it.

**Q: Where should business logic live in a DRF app?**
A: Not spread across serializers, signals and `perform_create`. A common, defensible structure: serializers validate and shape data, views handle HTTP concerns (auth, status codes), and a **service layer** (plain functions such as `place_order(user, cart, idempotency_key)`) holds the transactional logic, called from the view. Services can be tested without HTTP and reused by Celery tasks and management commands. Model methods are fine for logic about a single object.

### 5.3 Authentication: session, token, JWT

**Q: Which authentication classes does DRF provide, and how does DRF choose one?**
A: Built in: `SessionAuthentication` (Django sessions, enforces CSRF), `BasicAuthentication` (only over HTTPS, mostly for testing), `TokenAuthentication` (`Authorization: Token <key>`, a single static token per user in the `authtoken` table) and `RemoteUserAuthentication`. JWT comes from `djangorestframework-simplejwt`. DRF tries each class in `DEFAULT_AUTHENTICATION_CLASSES` in order. The first one that returns `(user, auth)` wins, a class that returns `None` passes to the next, and one that raises `AuthenticationFailed` stops the request. If none succeed, `request.user` is `AnonymousUser`. See [Ch 23 · DRF Auth, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling).

**Q: Session authentication vs JWT: which would you use for a React SPA?**
A: If the SPA is served from the same site as the API, **session cookies** are usually the better default. They are HttpOnly (JavaScript cannot steal them through XSS), revocable instantly on the server, and Django and DRF support them fully. The cost is CSRF handling (`X-CSRFToken`) and same-site constraints. **JWT** suits mobile apps, third-party clients and service-to-service calls, or cross-domain setups where cookies are awkward. Its costs are that revocation is hard, where you store the token in the browser is a security decision (localStorage is exposed to XSS), and tokens get large. A balanced answer: sessions for the first-party web app, JWT for mobile and machine clients, behind the same permissions. See [REST API · JWT](../rest-api/topic.html?p=20-jwt).

**Q: How does SimpleJWT work, and how do you handle logout or revocation?**
A: Login returns a short-lived **access** token (5 minutes by default) and a longer **refresh** token (1 day by default), both signed JWTs. The API validates the access token's signature and expiry without a database lookup. The client uses the refresh token to get new access tokens. For revocation, enable `ROTATE_REFRESH_TOKENS` and `BLACKLIST_AFTER_ROTATION` with the `token_blacklist` app, so a used or logged-out refresh token is rejected. Access tokens stay valid until they expire, which is why they are kept short. For "log out everywhere now", add a per-user token version claim, checked against the database or cache, which brings back a lookup per request.

**Q: What is wrong with DRF's built-in `TokenAuthentication` for production?**
A: Each user gets a single static token with no expiry, and the token is stored in the database as-is, so a database leak exposes usable credentials. There is also no per-device tokens or scopes. It is fine for internal tools. For production, consider `django-rest-knox` (hashed, per-device, expiring tokens), SimpleJWT, or OAuth2 via `django-oauth-toolkit` for third-party access.

**Q: Why do I get 403 instead of 401 when not logged in?**
A: DRF returns 401 only if the first authentication class provides `authenticate_header()`, which supplies the `WWW-Authenticate` header that a 401 response requires. `SessionAuthentication` has no such header, so when it is first in the list, unauthenticated requests get **403**. Put `TokenAuthentication` or JWT first if your clients rely on 401 to trigger a token refresh. A small detail, but it shows you have actually run into it.

### 5.4 Permissions & throttling

**Q: How do `has_permission` and `has_object_permission` differ?**
A: `has_permission(request, view)` runs for every request in `initial()`. `has_object_permission(request, view, obj)` runs only when the view calls `check_object_permissions()`, which `GenericAPIView.get_object()` does for retrieve, update and destroy. **List endpoints never call it.** So an `IsOwner` object permission does nothing for `GET /orders/`, and that endpoint lists everyone's orders unless `get_queryset()` filters by user. This is the most common DRF authorization bug, and interviewers know it well. Note too that the permission classes are combined with AND, and both methods must return True.

```python
class IsOwner(BasePermission):
    def has_object_permission(self, request, view, obj):
        return obj.owner_id == request.user.id

class OrderViewSet(ModelViewSet):
    permission_classes = [IsAuthenticated, IsOwner]
    def get_queryset(self):                      # protects list; IsOwner protects detail
        return Order.objects.filter(owner=self.request.user)
```

**Q: How do you compose permissions?**
A: DRF supports `&`, `|` and `~` on permission classes: `permission_classes = [IsAuthenticated & (IsOwner | IsAdminUser)]`. Use `get_permissions()` to vary them by `self.action`, for example allowing reads for anyone and writes only for staff. `DjangoModelPermissions` maps HTTP methods to model permissions (`add_`, `change_`, `delete_`). `DjangoObjectPermissions` needs an object-permission backend such as django-guardian. See [Ch 26 · Permissions & Authorization](topic.html?p=26-permissions-authorization).

**Q: How does DRF throttling work, and what are its limits?**
A: Throttle classes (`AnonRateThrottle`, `UserRateThrottle`, `ScopedRateThrottle`) store request timestamps per key in Django's **cache**, and `allow_request()` checks the count in the window ("100/hour"). Blocked requests get 429 with `Retry-After`. Limits: with the `locmem` cache, each process counts separately, so 10 workers allow about 10 times the rate. Use Redis. The check-then-write is not atomic, so it is approximate under concurrency. Anonymous identity is the client IP from `X-Forwarded-For` / `REMOTE_ADDR`, governed by `NUM_PROXIES`. Treat it as fair-use control, and put real abuse protection at the gateway or WAF. See [REST API · Rate Limiting](../rest-api/topic.html?p=24-rate-limiting-throttling).

**Q: How do you rate-limit login attempts specifically?**
A: Put a `ScopedRateThrottle` with `throttle_scope = "login"` on the token or login view, keyed by IP. Also keep a lockout counter per account in Redis (or use `django-axes`) to slow credential stuffing that rotates IPs. Return the same error for "unknown user" and "wrong password" to avoid user enumeration, and alert on spikes. The throttle protects the endpoint, and the per-account counter protects the account.

**Q: How do you implement multi-tenant isolation so one tenant can never see another's data? (Senior)**
A: Make scoping structural, not something each developer has to remember. Resolve the tenant once (from subdomain, token claim or membership) in middleware or authentication, and attach it to `request.tenant`. Put a `TenantScopedViewSet` base class whose `get_queryset()` always filters `tenant=request.tenant`, and a serializer base class that sets the tenant on create and validates that every FK in the input (`project_id`) belongs to the same tenant. Add database guard rails: composite FKs or `UniqueConstraint`s that include `tenant_id`, or PostgreSQL row-level security with a session variable. Test it: one test per endpoint that creates two tenants and asserts a 404 across tenants. Schema-per-tenant (`django-tenants`) is stronger isolation but costs operational complexity. See [Database Design · Multi-Tenant SaaS](../database-design/topic.html?p=40-case-multi-tenant-saas).

### 5.5 Pagination, filtering, versioning

**Q: Compare PageNumberPagination, LimitOffsetPagination and CursorPagination.**
A: Page-number pagination (`?page=3`) and limit-offset pagination (`?limit=50&offset=100`) both run `OFFSET`, which gets slower as the offset grows because the database scans and discards the skipped rows. They also run a `COUNT(*)` for the total, and they show duplicates or skip rows when data changes between pages. **CursorPagination** encodes the position in an opaque cursor (`WHERE created < x`). It is stable under inserts and fast at any depth, but it requires a unique, unchanging ordering, gives no total count and no "jump to page 50". Use cursor pagination for feeds and large tables, and page numbers for small admin-style lists. See [Ch 24](topic.html?p=24-drf-pagination-filtering-versioning) and [REST API · Pagination](../rest-api/topic.html?p=13-pagination).

**Q: How do you add filtering, search and ordering?**
A: Set `filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]`, with `filterset_fields` or a `FilterSet` class (from django-filter), `search_fields = ["title", "^sku"]`, and an **explicit** `ordering_fields` whitelist. Without the whitelist, clients can order by any field, including sensitive ones or unindexed columns that cause slow sorts. Every field you expose for filtering or ordering needs an index plan, so that a client can't trigger a full scan of the table.

**Q: How would you version a DRF API?**
A: DRF provides `URLPathVersioning` (`/v1/orders/`), `NamespaceVersioning`, `AcceptHeaderVersioning` (`Accept: application/json; version=2`), `HostNameVersioning` and `QueryParameterVersioning`. The view reads `request.version` and can pick a serializer per version in `get_serializer_class()`. URL path versioning is the most visible and the easiest to cache. In practice, version rarely: make additive, backward-compatible changes, and introduce a new version only for breaking changes, with a deprecation window. See [REST API · Versioning](../rest-api/topic.html?p=31-api-versioning).

**Q: How do you generate API docs for DRF?**
A: Use `drf-spectacular` to generate an OpenAPI 3 schema from your viewsets and serializers, served with Swagger UI or Redoc. Annotate unusual endpoints with `@extend_schema`. DRF's own `coreapi` schema support is deprecated. Run schema generation in CI and fail on warnings so the docs stay accurate, and you can also diff the schema to catch breaking changes.

### 5.6 Custom user model & authentication

**Q: Why should you set a custom user model at the start of every project?**
A: Because changing `AUTH_USER_MODEL` after the first migration is very painful. Every FK to the user, the admin log, permissions and the content types all reference the original table, and Django has no automatic migration for it. Starting with `class User(AbstractUser): pass` costs nothing and leaves room to add fields or switch to email login later. Always reference it with `settings.AUTH_USER_MODEL` in FKs and `get_user_model()` in code, never `from django.contrib.auth.models import User`. See [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user).

**Q: `AbstractUser` vs `AbstractBaseUser`: when do you use each?**
A: Subclass `AbstractUser` when Django's fields (username, email, first and last name, `is_staff`, groups) are fine and you only want to add more. Subclass `AbstractBaseUser` with `PermissionsMixin` when you need full control, such as email as the login with no username field. Then you define `USERNAME_FIELD`, `REQUIRED_FIELDS` and a custom manager with `create_user()` / `create_superuser()`, and you adapt the admin forms. Profile data that is not about authentication often belongs in a separate `Profile` table (OneToOne) to keep the user row small.

**Q: How does Django store and check passwords?**
A: `make_password()` hashes with the first hasher in `PASSWORD_HASHERS` (PBKDF2-SHA256 by default, with on the order of a million iterations in recent versions) and stores `algorithm$iterations$salt$hash`. `check_password()` reads the algorithm from the stored string, so old hashes keep working, and if the hasher or its iteration count is outdated, Django **upgrades** the hash on successful login. Argon2 is recommended (`argon2-cffi`, put `Argon2PasswordHasher` first). Passwords are never stored in reversible form, which is why "password reset" exists and "password recovery" does not.

**Q: How do `authenticate()` and `login()` work, and what does `login()` do for security?**
A: `authenticate(request, **credentials)` tries each backend in `AUTHENTICATION_BACKENDS` in order, and the first one that returns a user wins. That is how email login, LDAP or SSO plug in. `login(request, user)` stores the user id and backend in the session and **rotates the session key** (`cycle_key`), which prevents session fixation. It also rotates the CSRF token. `logout()` flushes the session. In DRF, token and JWT views call `authenticate()` but not `login()`, because there is no session.

**Q: How would you add social login or SSO?**
A: Use `django-allauth` for social providers and email verification, or `mozilla-django-oidc` / `social-auth-app-django` for OpenID Connect against Okta, Azure AD or Google Workspace. Behind the scenes it is an extra authentication backend plus the OAuth2 authorization-code flow (with PKCE for public clients). Key points: link accounts by verified email only, map IdP groups to Django groups at login, and decide what happens when a user is deprovisioned at the IdP. See [REST API · OAuth2 & OIDC](../rest-api/topic.html?p=19-oauth2-oidc).

### 5.7 Security

**Q: How does Django prevent CSRF?**
A: `CsrfViewMiddleware` enforces a token on unsafe methods (POST, PUT, PATCH, DELETE). The server sets a `csrftoken` cookie holding a secret, or stores it in the session if `CSRF_USE_SESSIONS`. Forms include a **masked** version of that secret via `{% csrf_token %}`, or JavaScript sends it in the `X-CSRFToken` header. The middleware unmasks the token and compares it with the cookie. A cross-site attacker can make the browser *send* the cookie but cannot *read* it to forge the matching token. On HTTPS, it also checks that `Origin` (or `Referer`) matches the host or `CSRF_TRUSTED_ORIGINS`, which needs a scheme since 4.0. The masking changes per request, which defeats BREACH-style compression attacks. `SameSite=Lax` cookies add defence in depth. See [Ch 28 · Security](topic.html?p=28-security).

**Q: When is `@csrf_exempt` acceptable?**
A: Only for endpoints that are not authenticated by an ambient browser credential: webhooks from Stripe or GitHub, which you verify with an HMAC signature instead, or APIs authenticated purely by `Authorization` headers, which browsers don't send automatically. Making a cookie-session endpoint exempt reopens CSRF. DRF already exempts its views and re-applies CSRF only inside `SessionAuthentication`, so you rarely need to add `@csrf_exempt` yourself.

**Q: How does the ORM protect against SQL injection, and where can it still happen?**
A: The ORM always sends values as **parameters** separately from the SQL text, and the database driver handles them, so input cannot change the query structure. Injection happens when you build SQL with string formatting: `raw(f"... {name}")`, `cursor.execute("..." % x)`, `extra()`, `RawSQL()` with interpolated input, or by interpolating *identifiers* such as column names for ordering, which parameters cannot cover. Fix: always pass `params=[...]`, and whitelist identifiers against a fixed set.

```python
# vulnerable
Book.objects.raw(f"SELECT * FROM shop_book WHERE title = '{q}'")
# safe
Book.objects.raw("SELECT * FROM shop_book WHERE title = %s", [q])
```

**Q: What is clickjacking, and how does Django prevent it?**
A: Clickjacking is when an attacker loads your page in an invisible iframe and tricks the user into clicking buttons on it. `XFrameOptionsMiddleware` sends `X-Frame-Options: DENY` by default (since 3.0), so browsers refuse to frame the page. Use `@xframe_options_sameorigin` or `@xframe_options_exempt` per view for legitimate embedding. The modern equivalent is CSP `frame-ancestors`. Django 5.2 needs `django-csp` for CSP, and newer Django versions add built-in CSP support.

**Q: What does `manage.py check --deploy` look for?**
A: It flags insecure production settings: `DEBUG=True`; a weak or default `SECRET_KEY`; missing `SECURE_HSTS_SECONDS`; `SECURE_SSL_REDIRECT` not set; `SESSION_COOKIE_SECURE` and `CSRF_COOKIE_SECURE` not set; missing `SecurityMiddleware`; `X_FRAME_OPTIONS` not DENY; and others. Run it in CI against the production settings module. Things it can't check, which you still own: `ALLOWED_HOSTS` correctness, `SECURE_PROXY_SSL_HEADER` behind a TLS-terminating proxy, admin exposure and dependency CVEs.

**Q: What is `SECRET_KEY` used for, and what happens if it leaks?**
A: It signs data: sessions when you use the signed-cookie backend, password-reset tokens, `django.core.signing` values, messages and CSRF-related values. It is **not** used to hash passwords. If it leaks, attackers can forge signed values, such as password-reset links or signed cookie sessions, which can lead to account takeover. Rotate it with `SECRET_KEY_FALLBACKS` (4.1+): put the new key in `SECRET_KEY` and the old one in fallbacks, so existing sessions keep working during the transition, then remove the old key.

**Q: Why does `ALLOWED_HOSTS` exist?**
A: To stop **Host header** attacks. Django builds absolute URLs, including password-reset links in emails, from the request's Host header. An attacker who sends `Host: evil.com` could get a reset email that points to their domain. With `DEBUG=False`, Django rejects hosts not in `ALLOWED_HOSTS` with a 400. Never set `["*"]` in production. Behind a load balancer, also make sure health checks send a valid Host.

**Q: What is an IDOR, and how does it show up in Django APIs?**
A: An Insecure Direct Object Reference is accessing another user's object by changing an id: `GET /api/invoices/124/`. In DRF it shows up when `get_queryset()` returns `Invoice.objects.all()` and nothing checks ownership, or when a serializer accepts a FK id (`project_id`) without checking that the project belongs to the user. Fix: scope `get_queryset()` by user or tenant (out-of-scope ids then become a 404), validate FK ownership in the serializer (`queryset=` on `PrimaryKeyRelatedField` limited per request), and write cross-user tests. UUIDs make ids hard to guess, but they are not authorization. See [REST API · OWASP API Security](../rest-api/topic.html?p=23-owasp-api-security).

### 5.8 Caching

**Q: What caching options does Django offer?**
A: Per-site caching (`UpdateCacheMiddleware` first plus `FetchFromCacheMiddleware` last), per-view caching (`@cache_page(60 * 5)`), template fragment caching (`{% cache 600 sidebar request.user.id %}`) and the low-level API (`cache.get`, `set`, `get_or_set`, `delete`, `incr`, `get_many`). Backends: Redis (built in since 4.0), Memcached (`PyMemcacheCache`), database, file, `locmem` and dummy. `locmem` is per-process, so it is not shared between Gunicorn workers. The default `TIMEOUT` is 300 seconds. In APIs, low-level caching of computed data is usually more useful than whole-page caching. See [Ch 29 · Caching](topic.html?p=29-caching).

**Q: How do you invalidate a cached product detail when the product changes?**
A: Use cache-aside with explicit deletion on write. Read with `cache.get_or_set(f"product:{pk}:v1", compute, timeout)`. In the write path, call `transaction.on_commit(lambda: cache.delete(key))`, after commit so that a concurrent reader can't re-cache the old value before the commit. Keep a TTL as a safety net. For data that many keys depend on, use a **version key** (`cache.incr("catalog_version")`, included in every key) so one increment invalidates everything. Signals can trigger invalidation, but they miss `update()`, so a service-layer write function is more reliable. See [Redis Caching · Cache Invalidation](../redis-caching/topic.html?p=12-cache-invalidation).

**Q: What is a cache stampede, and how do you prevent it in Django?**
A: When a hot key expires, hundreds of concurrent requests miss at the same moment and all recompute, hammering the database. Mitigations: add random jitter to TTLs; take a lock so only one request recomputes (`cache.add(lock_key, 1, 30)` returns True for one caller only) while others serve the stale value; refresh ahead of expiry in a Celery task; or keep "stale-while-revalidate" metadata in the cached value. See [Redis Caching · Cache Stampede](../redis-caching/topic.html?p=15-cache-stampede).

**Q: Why is `cache_page` dangerous on authenticated endpoints?**
A: The cache key is built from the URL plus the headers listed in `Vary`. If the response varies by user but the cache key doesn't, user A's page is served to user B. Django adds `Vary: Cookie` when the session is accessed, but token-authenticated APIs send `Authorization`, which is not in `Vary` unless you add `@vary_on_headers("Authorization")`. And a CDN in front may ignore `Vary`. Cache per-user data with user-specific low-level keys, or mark responses `Cache-Control: private`.

**Q: How do ETags and conditional requests work in Django?**
A: `ConditionalGetMiddleware`, or the `@condition(etag_func=..., last_modified_func=...)` decorator, lets Django answer `If-None-Match` / `If-Modified-Since` with `304 Not Modified` and no body. With `@condition`, the cheap ETag function runs first, and the expensive view doesn't run at all on a match. That saves bandwidth and, with `@condition`, server work. It also enables optimistic concurrency: `If-Match` on PUT returns 412 if the resource has changed. See [REST API · HTTP Caching & ETags](../rest-api/topic.html?p=25-http-caching-etags).

### 5.9 Async & ASGI

**Q: When do async views actually help?**
A: When the view spends its time **waiting on I/O** that has an async client: calling several external HTTP APIs at once with `httpx.AsyncClient` and `asyncio.gather`, long-polling, streaming, or many concurrent slow connections. They do not speed up CPU-bound work. They give little benefit for plain database CRUD, because the async ORM still runs queries in a thread pool. Under WSGI they run in a one-off event loop per request, so they gain nothing. You need an ASGI server (Uvicorn, Daphne, Hypercorn) to benefit. See [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi).

**Q: What is `SynchronousOnlyOperation`, and how do you fix it?**
A: Django raises it when you call sync-only code, typically the synchronous ORM (`Book.objects.get()`, or a lazy relation access), from inside a running event loop. Blocking the loop would stall every other coroutine. Fixes: use the async ORM methods (`await Book.objects.aget()`, `async for b in qs`, `acount`, `acreate`), or wrap sync code with `await sync_to_async(fn)()`. Remember that lazy attribute access (`book.author`) is also a sync query, so use `select_related` up front.

**Q: How does the async ORM work under the hood, and what are its limits?**
A: The async methods (4.1+) are wrappers that run the sync query code through `sync_to_async`, so the database call still happens in a thread, with a sync driver. The main limit is that **transactions are not supported in async code**: `atomic()` does not work across awaits, so put the transactional unit in a sync function and call it with `sync_to_async`. With `thread_sensitive=True`, the default, those calls run in a single shared thread, which keeps connection handling safe but serialises them.

**Q: Explain `sync_to_async` and `async_to_sync`.**
A: Both come from `asgiref`. `sync_to_async(fn)` runs blocking code in a thread so the event loop isn't blocked. With `thread_sensitive=True`, the default, it uses one shared thread, which matters for code that uses thread-locals or database connections. `async_to_sync(coro)` runs a coroutine from sync code by using or creating an event loop, and is used for things like `channel_layer.group_send` from a sync view or a Celery task. Each crossing costs a thread hop, so mixing sync and async within one request adds latency. Keep each request path mostly one or the other.

**Q: How does Django handle sync middleware in an async stack?**
A: Each middleware declares `sync_capable` / `async_capable`. When a sync-only middleware sits in an ASGI stack, Django adapts it with `sync_to_async`, which adds a thread switch for each sync middleware the request passes through. To get the real benefit of ASGI, every middleware in the chain should be async-capable. Check third-party middleware before you assume that ASGI makes your app async.

### 5.10 Celery & background tasks

**Q: Why use Celery, and what are its components?**
A: To move slow or unreliable work out of the request: emails, reports, third-party calls, image processing. Components: the **broker** (Redis or RabbitMQ) queues task messages; **workers** consume and run them; an optional **result backend** stores return values; **beat** schedules periodic tasks (django-celery-beat keeps schedules in the database). A task call such as `send_receipt.delay(order_id)` serialises the name and arguments to the broker and returns immediately. See [Ch 31 · Celery](topic.html?p=31-celery-background-tasks).

**Q: Why should you pass IDs to tasks, not model instances?**
A: Serialised instances go stale: the task runs seconds or minutes later, and the row may have changed or been deleted. JSON can't serialise model instances anyway, and pickle is a security risk. Pass the primary key, re-fetch inside the task, and handle `DoesNotExist`. Combine this with dispatching via `transaction.on_commit` so the row is guaranteed to be committed when the worker looks for it.

**Q: How do you make Celery tasks reliable: retries, acks and idempotency?**
A: Use `@shared_task(bind=True, autoretry_for=(RequestException,), retry_backoff=True, retry_jitter=True, max_retries=5)` for transient failures. `acks_late=True` acknowledges the message only after the task finishes, so a worker crash redelivers it instead of losing it. That makes delivery **at-least-once**, so the task must be **idempotent**: check a status before acting, use unique constraints or an idempotency record, and pass a stable key to external APIs (Stripe idempotency keys). Also set `task_reject_on_worker_lost` deliberately, and use time limits (`soft_time_limit`) so a hung task does not hold a worker forever.

```python
@shared_task(bind=True, acks_late=True, autoretry_for=(PaymentGatewayTimeout,),
             retry_backoff=True, max_retries=5)
def capture_payment(self, order_id):
    order = Order.objects.get(pk=order_id)
    if order.payment_status == Order.PaymentStatus.CAPTURED:
        return "already captured"                      # idempotent on redelivery
    gateway.capture(order.payment_ref, idempotency_key=f"capture-{order_id}")
    Order.objects.filter(pk=order_id).update(payment_status=Order.PaymentStatus.CAPTURED)
```

**Q: What are chain, group and chord?**
A: Celery's **canvas** primitives. `chain(a.s(), b.s(), c.s())` runs tasks in sequence, passing each result to the next. `group(t.s(i) for i in ids)` runs tasks in parallel. `chord(group, callback)` runs the group, then the callback with all the results, which needs a result backend and can be fragile at scale. For very large fan-outs, prefer chunking (`t.chunks(items, 100)`) and a counter or status table over a giant chord.

**Q: How would you send a newsletter to one million users?**
A: Don't create one task per user from the request, and don't create one giant task either. A beat-triggered or admin-triggered "dispatcher" task iterates over user ids in key-range batches (`iterator()` or pk ranges) and enqueues batch tasks of, say, 500 users. Each batch task sends through the email provider's bulk API, records sends in a `NewsletterDelivery` table with a unique `(campaign, user)` constraint (so a redelivered batch skips users already sent), and respects provider rate limits (`rate_limit` or token buckets). Use a dedicated queue and workers so the newsletter can't starve transactional email. Monitor progress from the delivery table.

**Q: What does `worker_prefetch_multiplier` do, and when do you change it?**
A: Each worker process reserves `prefetch_multiplier × concurrency` messages ahead of time (the default multiplier is 4). That is good for many short tasks and bad for long ones: one worker can sit on 4 long tasks while other workers are idle, and with `acks_late` the reserved tasks are redelivered if the worker dies. Set it to 1 for long-running tasks. Routing long and short tasks to separate queues helps more.

### 5.11 Channels & real-time

**Q: How does Django Channels work?**
A: Channels runs Django under ASGI and adds protocol routing: `ProtocolTypeRouter({"http": django_asgi_app, "websocket": AuthMiddlewareStack(URLRouter(ws_patterns))})`. Each WebSocket connection is a **consumer** instance (`AsyncWebsocketConsumer`) with `connect`, `receive` and `disconnect` handlers. A **channel layer** (`channels_redis.core.RedisChannelLayer`) lets processes talk to each other: consumers join **groups** with `group_add`, and any code can `group_send(group, {"type": "chat.message", ...})`. The `type` is mapped to a handler method (`chat_message`) on every consumer in the group. See [Ch 32 · Channels](topic.html?p=32-channels-websockets).

**Q: How do you push a notification to a user's WebSocket from a Django view or a Celery task?**
A: On connect, the consumer joins a per-user group (`f"user_{user.id}"`). The view or task calls `async_to_sync(channel_layer.group_send)("user_42", {"type": "notify", "payload": data})`, ideally inside `transaction.on_commit`. Whichever server holds that user's sockets receives the message through Redis and calls `notify()`, which sends to the client. Channel layers are fire-and-forget with no persistence, so store the notification in the database as well and let clients fetch missed ones on reconnect.

**Q: How do you access the ORM from an async consumer?**
A: Wrap ORM calls in `database_sync_to_async` (from `channels.db`). It runs them in a thread and also closes stale connections, which plain `sync_to_async` does not. Alternatively, use the async ORM methods for simple queries. Never call the sync ORM directly in `async def` handlers, as that raises `SynchronousOnlyOperation`. Keep the work per message small, because long handlers block that consumer's message processing.

**Q: How do you authenticate WebSocket connections?**
A: `AuthMiddlewareStack` reads the Django session cookie, which works for same-site browser clients, and sets `scope["user"]`. Check `self.scope["user"].is_authenticated` in `connect()` and `close()` if not. Validate the `Origin` header too (`AllowedHostsOriginValidator`), because WebSockets are not protected by CSRF. For token clients, write a small middleware that validates a short-lived token passed in the query string or the first message. Avoid long-lived JWTs in URLs, because they end up in logs.

### 5.12 Testing

**Q: `TestCase` vs `TransactionTestCase` vs `SimpleTestCase`?**
A: `SimpleTestCase` blocks database access, for pure logic and fast tests. `TestCase` wraps each test in a transaction that is rolled back at the end (fast), and supports `setUpTestData` for data created once per class. Because nothing is committed, `on_commit` callbacks don't run unless you use `captureOnCommitCallbacks(execute=True)`, and you can't test real concurrency or commit behaviour. `TransactionTestCase` truncates tables after each test. It is slower, but it is needed for testing `select_for_update` across threads, real commits, or code that manages its own transactions. See [Ch 33 · Testing](topic.html?p=33-testing).

**Q: How do you test a DRF endpoint?**
A: Use `APITestCase` / `APIClient`. `self.client.force_authenticate(user)` skips the auth mechanics when they are not under test. Post JSON with `format="json"`, assert `status_code` and `response.json()`, and cover the cases that matter: unauthenticated (401/403), another user's object (404), invalid input (400 with field errors), success, and a query-count assertion. With pytest-django, use fixtures and `@pytest.mark.django_db`, plus factory_boy factories instead of fixture files.

```python
def test_cannot_read_other_users_order(api_client, user_factory, order_factory):
    me, other = user_factory(), user_factory()
    order = order_factory(owner=other)
    api_client.force_authenticate(me)
    assert api_client.get(f"/api/orders/{order.id}/").status_code == 404
```

**Q: How do you mock external services in Django tests?**
A: Isolate them behind a thin client module, and patch that module (`unittest.mock.patch("payments.client.capture")`) rather than `requests` deep inside your code. For HTTP-level mocking, use `responses` or `respx` (httpx). For Celery, set `CELERY_TASK_ALWAYS_EAGER=True` in unit tests to run tasks inline (it hides serialisation and broker behaviour, so keep a few integration tests), or patch `.delay` and assert it was called with the right ids. Use `freezegun` or `time-machine` for time.

**Q: How do you keep a large Django test suite fast?**
A: Use `setUpTestData` instead of `setUp` for shared data. Use factories that build only what each test needs. Run in parallel (`manage.py test --parallel` or `pytest -n auto`). Use `--keepdb` locally. Switch to the MD5 password hasher in test settings, because the default hasher is deliberately slow and dominates user-creation time. Avoid `TransactionTestCase` unless you need it, and mock network calls. Track the slowest tests (`--durations=20`) in CI.

### 5.13 DB scaling & connection pooling

**Q: How does Django manage database connections?**
A: Django uses one connection per thread, opened lazily on first query. `CONN_MAX_AGE` controls reuse: `0` (the default) closes the connection at the end of each request, a number keeps it for that many seconds, and `None` keeps it open indefinitely. `CONN_HEALTH_CHECKS = True` (4.1+) checks a reused connection before the request uses it. Persistent connections save the connect cost (TLS plus auth, which can take milliseconds) but hold a server connection per worker even while idle. See [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases).

**Q: What is new about connection pooling in Django 5.1+?**
A: Django 5.1 added native pooling for PostgreSQL with psycopg 3: `"OPTIONS": {"pool": True}`, or a dict of `psycopg_pool` options such as `min_size`, `max_size` and `timeout`. Each process keeps a pool, and connections are borrowed per request. It is a process-local pool, so total connections are still pools × processes. For many pods, or for serverless, an external pooler (PgBouncer in transaction mode) is still how you cap total server connections. Don't combine the native pool with a non-zero `CONN_MAX_AGE`.

**Q: What breaks when you put PgBouncer in transaction mode in front of Django?**
A: In transaction mode, a server connection is assigned to a client only for the length of a transaction, so anything that depends on session state across transactions breaks: server-side cursors used by `iterator()` (set `DISABLE_SERVER_SIDE_CURSORS = True`), session-level `SET` statements, advisory locks held across transactions, `LISTEN/NOTIFY`, and, depending on the PgBouncer version, prepared statements. Recent PgBouncer versions support protocol-level prepared statements. Keep `CONN_MAX_AGE` reasonable, and let PgBouncer do the pooling.

**Q: How do you route reads to a replica, and what goes wrong?**
A: Configure a `replica` entry in `DATABASES` and a router class implementing `db_for_read` (return `"replica"`), `db_for_write` (`"default"`), `allow_relation` and `allow_migrate`, listed in `DATABASE_ROUTERS`. Or route explicitly with `.using("replica")`. The problem is **replication lag**: a user creates an object, is redirected, and the read hits a replica that doesn't have it yet, so they see a 404. Fixes: pin a user's reads to the primary for a few seconds after they write (a cookie or a request flag), always read from the primary inside transactions, and send only lag-tolerant queries (reports, public lists) to replicas. See [Database Design · Replication](../database-design/topic.html?p=09-replication).

**Q: You hit "FATAL: too many connections" after scaling out. Walk through the numbers. (Senior)**
A: Count every client. Web: pods × Gunicorn workers × threads, with each thread holding one connection when `CONN_MAX_AGE` is non-zero. For example, 10 pods × 9 workers × 1 = 90. Celery: pods × concurrency, say 4 × 8 = 32. Plus beat, cron jobs, migrations, admin shells and monitoring. Against PostgreSQL's `max_connections` of 100 (with a few reserved for superusers), you are out. Each PostgreSQL connection is a process using several MB, so raising `max_connections` far is not the answer. Fixes, in order: put PgBouncer in transaction mode in front, so thousands of client connections share tens of server connections; size the native per-process pool small; reduce idle connections (`CONN_MAX_AGE` lower, or 0 behind PgBouncer); and give Celery its own pool limit. Then alert on the active-connection count.

### 5.14 Deployment & operations

**Q: How do you run Django in production?**
A: Use a WSGI server (Gunicorn) or an ASGI server (Uvicorn workers via `uvicorn.workers.UvicornWorker` or the `uvicorn-worker` package) behind a reverse proxy or load balancer. Never `runserver`. Set `DEBUG=False`, a correct `ALLOWED_HOSTS`, secrets from the environment, and `SECURE_PROXY_SSL_HEADER` if TLS terminates at the proxy. Serve static files with WhiteNoise or a CDN after `collectstatic` at build time. Configure the `STORAGES` setting (4.2+) for media on S3. Add structured logging, Sentry and health-check endpoints. Run migrations as a separate release step. See [Ch 35 · Deployment](topic.html?p=35-deployment-production).

**Q: How many Gunicorn workers should you run?**
A: The usual starting point is `2 × cores + 1` sync workers, then tune by measuring. Sync workers handle one request at a time, so concurrency equals the worker count. If requests mostly wait on I/O, add threads (`--threads 4`, gthread) or move to ASGI. Each worker is a full Python process with its own memory and database connection, so memory and the database connection budget usually set the ceiling before CPU does. Set `--timeout` (30 s by default) above your slowest legitimate request, and `--max-requests` with jitter to recycle workers that leak memory.

**Q: How do you deploy with zero downtime when there are migrations?**
A: Old and new code run at the same time during a rolling deploy, so every migration must be **backward compatible** with the code currently running. Run `migrate` once as a release job (not in every container's start command, where parallel runs race), then roll out the new pods. Additive changes go first (nullable columns, new tables, concurrent indexes). Destructive changes (drop, rename, NOT NULL) go in a later release, after no running code uses the old shape. Set a `lock_timeout` so a migration waiting on a lock fails fast instead of blocking traffic. See [Ch 11 · Migrations](topic.html?p=11-migrations).

**Q: How do you serve static and media files correctly?**
A: Static files (your CSS and JS) are collected at build time with `collectstatic` into `STATIC_ROOT`, and served by WhiteNoise (with compression and hashed file names via `CompressedManifestStaticFilesStorage`) or uploaded to a CDN. Media files (user uploads) go to object storage (`django-storages` with S3) through `STORAGES["default"]`, served from the bucket or a CDN, with private files behind signed URLs. Never serve uploads from the app server's disk in a multi-pod deployment, because pods don't share disks. See [Ch 20 · Static & Media Files](topic.html?p=20-static-media-files).

**Q: What do you monitor for a Django service?**
A: Use the RED metrics per endpoint: rate, errors and duration, especially p95 and p99. Track database query count and time per request (APM), connection-pool usage, Celery queue depth and task latency, worker restarts and memory, cache hit rate, and 4xx/5xx breakdowns. Send exceptions to Sentry with release tags, so a regression maps to a deploy. Use structured JSON logs with a request id that is propagated to Celery tasks. Define SLOs and alert on them, not on CPU. See [REST API · Observability](../rest-api/topic.html?p=38-observability-logging-tracing).

### 5.15 Scenario & debugging questions

**Q: The API got slow after a release. Walk me through how you'd investigate. (Senior)**
A: **Scope:** which endpoints, all users or some, how much slower (p50 vs p99), and does it line up with the deploy time? **Mitigate:** if it is serious and clearly tied to the release, roll back first and investigate after. **Measure:** APM traces for the slow endpoint show whether the time is spent in the database, an external call or Python. Compare query counts before and after the release, because an N+1 shows up as 40 queries becoming 400. `pg_stat_statements` shows new expensive statements. **Hypotheses**, from most to least likely: a serializer or template change that touches a relation without `select_related`/`prefetch_related`; a new filter or ordering on an unindexed column (seq scan, check with `EXPLAIN ANALYZE`); a migration that left a table locked or dropped an index; a cache whose key changed so the hit rate collapsed; a new synchronous external call in the request path. **Fix** the specific cause, then **prevent** recurrence: `assertNumQueries` on the endpoint, a query budget in CI, and an alert on p95.

**Q: Users report seeing each other's data. What could cause that? (Senior)**
A: Treat it as a security incident: mitigate first (disable the suspected cache or feature, roll back), then investigate. Likely causes: (1) **caching** without the user in the key, such as `cache_page` on an authenticated endpoint, a CDN caching responses that vary by `Authorization`, or a low-level cache key missing the user id; (2) **shared mutable state** in a process, such as a module-level dict or a mutable class attribute on a view or serializer that is changed per request, or a thread-local not cleared between requests under thread workers; (3) **missing queryset scoping**, where list endpoints return `objects.all()` because object permissions never run on lists; (4) a session or auth bug, such as a proxy caching `Set-Cookie`, or a custom auth backend that returns the wrong user. Confirm the cause from logs, which user ids were served which objects, then fix it. Add a cross-user test for every endpoint, `Cache-Control: private` on user-specific responses, and a review rule against module-level mutable state. Assess the exposure for disclosure obligations.

**Q: Clients retrying a POST created duplicate orders. How do you fix it? (Senior)**
A: The network made the POST at-least-once: the client timed out after the server had committed, then retried. Fix it with an **idempotency key**. The client generates a UUID per logical operation and sends `Idempotency-Key`. The server stores `(user, key)` with a unique constraint, the request fingerprint, and the response, in the same transaction as the order. On a repeat with the same key and the same body, return the stored response. With a different body, return 422. If the first request is still in progress, return 409. Add a natural guard too, such as a unique `(cart_id)` on orders, so that even a client without the key can't double-submit the same cart.

```python
@transaction.atomic
def place_order(user, cart, key, fingerprint):
    rec, created = IdempotencyRecord.objects.select_for_update().get_or_create(
        user=user, key=key, defaults={"fingerprint": fingerprint})
    if not created:
        if rec.fingerprint != fingerprint:
            raise Conflict("key reused with a different body")
        return rec.response                      # replay the original result
    order = Order.objects.create_from_cart(user, cart)
    rec.response = OrderSerializer(order).data
    rec.save(update_fields=["response"])
    transaction.on_commit(lambda: send_confirmation.delay(order.id))
    return rec.response
```

See [REST API · Idempotency Keys](../rest-api/topic.html?p=27-idempotency-keys-retries).

**Q: A Celery task sometimes runs twice. Why? (Senior)**
A: Celery is at-least-once, so expect it. Common causes: with `acks_late`, a worker crash or OOM kill redelivers the task; with the Redis broker, a task not acknowledged within `visibility_timeout` (1 hour by default) is redelivered to another worker, which hits long tasks and ETA/countdown tasks scheduled further out than that; autoretry after a partial side effect; the dispatching code ran twice (a retried request, or a signal connected twice without `dispatch_uid`); beat running in two places at once. Fix: make the task idempotent (state checks, unique constraints, external idempotency keys), raise the visibility timeout above your longest ETA, run a single beat instance, and dispatch through `on_commit` from an idempotent service.

**Q: Gunicorn workers are getting killed with "WORKER TIMEOUT" under load. What do you check?**
A: A sync worker was busy longer than `--timeout` (30 s by default), so the master killed it. Find out why the requests are slow: a slow external API called without a client timeout (always set `timeout=` on `requests`), a lock wait in the database, a slow query, or a large export done in the request. Under load, if all workers are blocked on I/O, requests queue up and time out together. Fixes: set client timeouts, move slow work to Celery, add threads or move I/O-heavy endpoints to ASGI, and use `statement_timeout` on the database. Raising `--timeout` only hides the problem.

**Q: Memory in your web workers keeps growing until they are OOM-killed. How do you approach it?**
A: Common Django causes: `DEBUG=True` in production (`connection.queries` keeps every query); evaluating huge QuerySets into memory (`list(qs)` on millions of rows, or iterating without `iterator()`); module-level caches that grow without limit (unbounded `lru_cache`, global dicts); and large response bodies built in memory. Use `--max-requests` with jitter as an immediate mitigation, then profile with `tracemalloc` or `memray` on a staging worker under the same traffic. Look at which endpoint or task precedes the growth, using per-request memory logging.

**Q: The same view is fast locally and slow in production. What are the usual suspects?**
A: Data volume (10 rows locally, 10 million in production, so an N+1 or a missing index only bites there), network latency to the database (each query costs 1–2 ms in production instead of 0.05 ms locally, so 300 queries cost a lot more), cold caches, a different database plan due to stale statistics (`ANALYZE`), connection setup with `CONN_MAX_AGE=0` over TLS, and production-only middleware or logging. Reproduce with production-like data volume and measure with APM before changing anything.

## 6. Advantages, Disadvantages & Trade-offs

The trade-offs that come up again and again in this half of the interview:

| Decision | Option A | Option B | Rule of thumb |
|---|---|---|---|
| Web auth | Session cookie (HttpOnly, revocable, needs CSRF) | JWT (stateless, hard to revoke, storage risk) | Sessions for a first-party web app; JWT for mobile and machine clients |
| Pagination | Page number / offset (totals, jump to page) | Cursor (stable, fast at depth, no total) | Cursor for feeds and big tables |
| Authorization on lists | `get_queryset()` scoping | Object permissions | Both: scoping for lists, object permissions for detail |
| Background work | Celery (mature, retries, canvas) | Inline / thread (simple, no reliability) | Anything slow, retryable or bursty goes to Celery |
| Concurrency model | WSGI sync workers (simple, predictable) | ASGI async (high I/O concurrency) | ASGI only if the hot paths are I/O-bound and async end to end |
| Caching | Per-view `cache_page` | Low-level keys with explicit invalidation | Low-level for APIs and per-user data |
| Pooling | Native pool (5.1+, per process) | PgBouncer (global cap) | PgBouncer once pods × workers approaches `max_connections` |
| Reads | Primary only (consistent) | Replica (scales reads, lags) | Replicas for lag-tolerant reads; pin to primary after writes |

### Expectations by level

| Topic | Junior | Mid | Senior |
|---|---|---|---|
| DRF | ModelSerializer + ModelViewSet + router | Validation hooks, `get_queryset`, `@action`, N+1 in serializers | Service layer, nested writes in transactions, serialization performance |
| Auth | `IsAuthenticated`, token login | Session vs JWT, refresh and blacklist, 401 vs 403 | Auth architecture for web plus mobile, revocation, SSO |
| Security | "Django has CSRF and escapes HTML" | CSRF mechanism, `check --deploy`, SQLi in `raw()` | IDOR and tenant isolation, secret rotation, threat models |
| Async & Celery | "Use Celery for emails" | Retries, `on_commit`, idempotent tasks | Visibility timeouts, queue design, fan-out at scale |
| Scale | "Add caching" | Cache invalidation, replicas | Connection budgets, pooling, read-your-writes, safe deploys |

### When to use this chapter

- Use it after [Ch 37](topic.html?p=37-interview-core-orm), for any API-backend role.
- Use the scenarios in §5.15 and §9 for incident-style rounds and behavioural "tell me about a time" questions.

### When NOT to use this chapter

- Don't learn DRF from it. Read [Ch 21](topic.html?p=21-drf-serializers) to [Ch 24](topic.html?p=24-drf-pagination-filtering-versioning) first.
- For full system designs, use [Ch 40 · Design Rounds](topic.html?p=40-design-rounds). This chapter answers the questions *within* a design.

## 7. Common Mistakes & Best Practices

Answering mistakes that cost candidates offers:

- **"JWT is more secure than sessions."** Neither is inherently more secure. They have different threat models. Say what you are defending against (XSS stealing tokens, CSRF, revocation, scaling).
- **Relying on object permissions to protect lists.** Saying `IsOwner` alone protects `GET /orders/` is a known red flag. Always mention `get_queryset()` scoping.
- **"Celery guarantees the task runs once."** It doesn't. Say "at-least-once, so I make it idempotent" before you're asked.
- **"Async makes Django faster."** Only for I/O-bound work with async clients, under ASGI. Database CRUD gains little, and CPU-bound work gains nothing.
- **Suggesting `@csrf_exempt` to "fix" a 403.** That disables a security control instead of sending `X-CSRFToken`, and interviewers notice.
- **Scaling with no numbers.** "Add more pods" without the connection arithmetic leads straight to the "too many connections" follow-up.
- **Jumping to a fix in scenario questions.** Mitigate, measure, hypothesise, verify. A guessed fix with no evidence scores lower than a slower answer that follows the method.
- **Caching per-user data in shared keys.** If you suggest `cache_page` on an authenticated endpoint, expect "what if two users hit it?"

Before and after for a security answer:

```text
Weak:   "Django is secure by default, it handles CSRF and SQL injection."
Strong: "CsrfViewMiddleware checks a masked token against the csrftoken cookie on unsafe methods and
         Origin against CSRF_TRUSTED_ORIGINS on HTTPS. DRF only enforces it through SessionAuthentication,
         so our JWT endpoints don't need it. The ORM parameterizes; the risk is raw()/cursor with f-strings,
         and we lint for that."
```

## 8. Production: Pitfalls, Debugging & Scaling

### Tricky and gotcha questions

**Q: Throttling is set to 100/hour, but a client made 600 requests. How?**
A: The throttle state lives in the cache. With `locmem`, each Gunicorn worker has its own counter, so 6 workers allow about 600 requests. It can also be IP misidentification: behind a proxy without `NUM_PROXIES`, every client appears as the proxy's IP (over-throttling), or a client spoofs `X-Forwarded-For` (bypass). Use Redis as the throttle cache, configure `NUM_PROXIES` correctly, and enforce hard limits at the gateway.

**Q: Your `IsOwner` permission works on retrieve, but a user updated someone else's object via a custom `@action`. Why?**
A: The action looked up the object itself (`Order.objects.get(pk=pk)`) instead of calling `self.get_object()`, so `check_object_permissions()` never ran. Always use `get_object()` in detail actions, or call `self.check_object_permissions(request, obj)` explicitly, and scope `get_queryset()` so out-of-scope ids return 404 anyway.

**Q: A ModelSerializer accepted data that violated `Model.clean()`. Why?**
A: DRF serializers run field validators and unique validators, but not `Model.clean()` or `full_clean()`. DRF deliberately keeps validation in the serializer. Move the rule into `validate()` (or a shared validator function used by both), or enforce it with a database `CheckConstraint`, so every write path is covered.

**Q: Tests pass, but the email-sending `on_commit` hook never fires in tests. Why?**
A: `TestCase` wraps each test in a transaction that is rolled back, so the outermost commit never happens and `on_commit` callbacks are discarded. Use `with self.captureOnCommitCallbacks(execute=True):` (3.2+), or `TransactionTestCase` when you need real commit semantics.

**Q: After moving to ASGI, the app got slower. Why might that be?**
A: Most of the stack was still sync: sync middleware, sync views and the sync ORM. Under ASGI each sync piece is wrapped with `sync_to_async`, which adds thread switches, and `thread_sensitive=True` puts those calls through one thread per process. You paid the cost of adaptation without any async I/O to benefit from. Either go async end to end on the I/O-heavy paths, or stay on WSGI with threads for those endpoints.

**Q: JWT logout "doesn't work": the user can still call the API after logging out. Why?**
A: An access token is self-contained and valid until it expires. Logout can only blacklist the refresh token. That is expected behaviour, and the mitigations are short access lifetimes, refresh rotation with blacklisting, and a per-user token version checked per request when immediate revocation is required.

**Q: You enabled `CONN_MAX_AGE=None` with PgBouncer in transaction mode and now `iterator()` fails intermittently. Why?**
A: `iterator()` uses a named server-side cursor, which lives on one server connection across several fetches. In transaction mode PgBouncer can give later statements a different server connection, so the cursor "does not exist". Set `DISABLE_SERVER_SIDE_CURSORS = True` for that database alias, and use key-range batching for big scans.

### Debugging toolkit for this half

| Problem | Tool | Signal |
|---|---|---|
| Slow endpoint | APM traces (Sentry, Datadog, OpenTelemetry) | Time split between DB, HTTP and Python |
| Query explosion | django-debug-toolbar (browsable API), `assertNumQueries` | Repeated SELECTs per row |
| Data leak | Access logs with user id, cross-tenant tests | Object ids served to the wrong user |
| Duplicates | Unique-constraint violations, idempotency table | Same key, two effects |
| Celery stuck | `celery inspect active/reserved`, Flower, queue depth | Prefetched long tasks, a dead worker |
| Connection exhaustion | `pg_stat_activity` grouped by `application_name`/state | Idle connections per pod |

> **Production story:** After a team turned on Uvicorn "for performance", p95 rose by 30%. All their middleware was sync, and each request crossed the sync/async boundary five times. They went back to Gunicorn with gthread for the CRUD API and ran a separate ASGI deployment only for the endpoints that call several external services at once. That is a good real-world answer to "should we go async?"

## 9. Interview Questions

The hardest follow-ups, all Senior:

**Q: Design authentication for a product with a React web app, iOS and Android apps, and a public partner API. (Senior)**
A: Use one identity, with a different credential for each client type. Web app on the same site: Django session cookies (HttpOnly, Secure, SameSite=Lax), CSRF via `X-CSRFToken`, and `SessionAuthentication`. Mobile: short-lived JWT access tokens plus rotating refresh tokens stored in the platform keychain, with the blacklist on rotation and logout. Partners: OAuth2 client credentials or per-partner API keys that are hashed at rest, scoped and rate-limited separately (`ScopedRateThrottle`). The same permission classes and `get_queryset()` scoping apply to all three, so authorization logic is never duplicated. Add MFA for staff and admin, and SSO via OIDC for enterprise customers. Explain why not JWT everywhere: browser token storage and revocation.

**Q: How would you implement "log out of all devices" immediately with JWT? (Senior)**
A: Add a `token_version` integer on the user, embed it as a claim at issue, and have a custom `JWTAuthentication.get_user()` reject tokens whose claim is lower than the current value. Cache the version in Redis to avoid a database hit per request. "Log out everywhere" increments it and blacklists the outstanding refresh tokens. This makes JWT partly stateful again (one cache read per request), which is the honest trade-off: immediate revocation always needs server state.

**Q: Make a payment-capture flow correct when Django, Celery and the payment gateway can all fail independently. (Senior)**
A: Write the order in state `PENDING_CAPTURE` with an idempotency record in one transaction, and enqueue capture through `on_commit`. Better still, write an outbox row in the same transaction and have a relay enqueue it, so a crash between commit and enqueue does not lose the task. The task is `acks_late`, retries with backoff, and calls the gateway with a stable idempotency key (`capture-{order_id}`), so a retry never double-charges. It moves the order to `CAPTURED` with a conditional update (`filter(status=PENDING_CAPTURE).update(...)`). Gateway webhooks are verified by signature and handled idempotently (a unique event id table). A periodic reconciliation task queries the gateway for orders stuck in pending and repairs them. Every step is at-least-once, and every effect is idempotent. See [Messaging · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox).

**Q: How do you guarantee read-your-writes with read replicas? (Senior)**
A: Several layers. A router that sends reads to the primary when the request is in a transaction or has written in the last N seconds (set a short-lived cookie or a cache key per user on write, and have the router check a context variable populated by middleware). Explicit `.using("default")` on the post-write redirect path. Replicas only for lag-tolerant views. Monitor replica lag, and have the router stop using a replica when lag exceeds a threshold. Interviewers want to hear the failure (a 404 right after create) and a session-sticky solution, not "replication is fast".

**Q: Your API serves 5k requests per second at peak. Size the Gunicorn workers, DB connections and Celery for it. (Senior)**
A: Start from latency. If the mean is 40 ms, each sync worker handles about 25 requests per second, so roughly 200 concurrent workers, plus headroom gives about 300. On 4-core pods with 9 workers each, that is about 34 pods. Each worker holds a DB connection, so about 300 web connections, which is too many for one PostgreSQL. Put PgBouncer in transaction mode with a server pool of around 50–100, because only a fraction of workers are in a query at any moment. Celery is sized by queue throughput and task duration, on separate queues for fast and slow tasks. Then validate with a load test, because these numbers are estimates and the real limit is usually database CPU or a hot row. Show the arithmetic, then say you would measure.

**Q: How would you cache a product listing with filters for anonymous and logged-in users? (Senior)**
A: Split the response. The product data, which is the same for everyone, is cached under a key derived from the normalised filter parameters plus a catalog version (`catalog:v{n}:{hash(params)}`). Personal data (price tier, wishlist flags) is computed per request from a small per-user lookup or cached per user. Invalidate by incrementing the catalog version on product writes, in `on_commit`. Add a short TTL with jitter, lock-based recomputation on hot keys, and HTTP caching (`Cache-Control: public, max-age=60` with ETags) only on the anonymous variant at the CDN. Never let a personalised response reach a shared cache.

**Q: An endpoint must call three external services, each with about 300 ms latency. How do you build it in Django? (Senior)**
A: Sequential sync calls take about 900 ms and hold a worker. Options: (1) an async view under ASGI with `httpx.AsyncClient` and `asyncio.gather`, so the wall time is about 300 ms and no thread is blocked, with timeouts and fallbacks per call; database work in that view uses the async ORM or a `sync_to_async` unit; (2) under WSGI, a thread pool (`concurrent.futures`) for the three calls, which works but uses threads; (3) if the result can be eventually consistent, precompute it in Celery and serve from cache. Add circuit breakers and per-dependency timeouts in all cases, and degrade gracefully when one service is down.

**Q: How do you prevent and detect N+1 regressions across a large DRF codebase? (Senior)**
A: Prevent: a convention that every viewset's `get_queryset()` declares `select_related`/`prefetch_related` matching its serializer, and annotations instead of per-object `SerializerMethodField` queries. Detect: a query-count test per list endpoint at two data sizes (equal counts mean no N+1), `nplusone` or `django-zeal` raising errors in CI, and per-endpoint query-count metrics in APM with alerts on jumps after a deploy. The two-size test is the important idea, because it catches N+1 without hard-coding fragile exact counts.

**Q: Your Celery queue is growing faster than workers drain it. What do you do? (Senior)**
A: First find out whether it is a backlog or a stall. Check the workers are alive and consuming (`inspect active`), check whether one task type dominates, and check whether tasks are slow because of a downstream dependency (a database lock, a rate-limited API). Then: scale workers if the work is CPU or I/O and the downstream can take more; separate queues so slow tasks don't starve urgent ones; set `prefetch_multiplier=1` for long tasks; batch tiny tasks into chunks; add `rate_limit` if a downstream is being overwhelmed. Shed or defer non-critical work. Long term, add alerts on queue depth and age of the oldest message, and set expiry (`expires=`) on tasks that are useless when late.

**Q: How would you secure file uploads in a Django API? (Senior)**
A: Validate size (`DATA_UPLOAD_MAX_MEMORY_SIZE` and `FILE_UPLOAD_MAX_MEMORY_SIZE`, plus limits at the proxy), validate type by content rather than extension or the client's `Content-Type`, and generate storage names yourself (never trust the filename, to avoid path traversal and overwriting). Store files in object storage, not on the web root, and serve them from a separate domain or with `Content-Disposition: attachment` so uploaded HTML or SVG cannot run as your origin (stored XSS). Use signed URLs for private files. Scan files (antivirus) asynchronously before making them available. For large files, use direct-to-S3 presigned uploads so the bytes never pass through your workers.

**Q: You must ship a breaking change to an API response field used by mobile apps you cannot force to update. How? (Senior)**
A: Don't break it in place. Add the new field alongside the old one (additive and backward compatible), and switch new app versions to it. Track usage of the old field by app version from request headers. Announce deprecation (a `Deprecation`/`Sunset` header and docs), and remove it only when usage falls below a threshold or behind a new API version (`URLPathVersioning`, with the old serializer kept for v1). Add contract tests for the old shape so it doesn't break by accident before removal. See [REST API · Backward Compatibility](../rest-api/topic.html?p=32-backward-compatibility-deprecation).

**Q: Explain how you'd make a Django deploy safe end to end, from PR to production. (Senior)**
A: CI runs tests (including query-count and cross-tenant tests), `makemigrations --check`, `check --deploy` against production settings, linting for raw SQL, and a dependency audit. Build one immutable image with `collectstatic` done at build time. The release job runs `migrate` once, with migrations written to be backward compatible and with a `lock_timeout`. Then a rolling deploy with readiness probes and graceful shutdown (Gunicorn `--graceful-timeout`, Celery warm shutdown so in-flight tasks finish). Feature flags for risky behaviour. Sentry release tracking and SLO alerts to catch regressions, and a rehearsed rollback, which only works if the migrations were backward compatible. See [Ch 35 · Deployment](topic.html?p=35-deployment-production).

**Q: How do you prove to an auditor that tenant A can never read tenant B's data? (Senior)**
A: Show the controls in layers, with evidence for each. Structural: a single base viewset and queryset manager that scope by tenant, with a lint or test that fails if any viewset doesn't inherit it. Database: `tenant_id` on every tenant-owned table, composite constraints, and optionally PostgreSQL row-level security policies keyed on a session variable set per request (with care around pooling). Tests: an automated suite that creates two tenants and checks every endpoint and action for a 404 across tenants. Runtime: audit logs of access with tenant and user ids, and alerts on anomalies. Defence in depth means that a single developer mistake doesn't become a breach.

## 10. Quick Revision & Cheat Sheet

| Question | 10-second answer |
|---|---|
| DRF flow | `dispatch`, then `initial` (authenticate, permissions, throttles), then handler, then `finalize_response` |
| Serializer validation | Fields and `validate_<field>`, then Meta validators, then `validate()`; no `Model.clean()` |
| Object permissions | Only via `get_object()`; lists need `get_queryset()` scoping |
| 401 vs 403 | 401 needs `authenticate_header`; `SessionAuthentication` gives 403 |
| Session vs JWT | Sessions for a first-party web app; JWT for mobile and machine clients; revocation is the catch |
| SimpleJWT | Access 5 min, refresh 1 day, rotation plus blacklist |
| Throttling | Cache-based; `locmem` is per process; set `NUM_PROXIES` |
| Pagination | Offset is slow at depth; cursor is stable but has no total |
| Custom user | Set `AUTH_USER_MODEL` before the first migrate; use `settings.AUTH_USER_MODEL` in FKs |
| Passwords | PBKDF2 by default, Argon2 recommended, upgraded on login |
| CSRF | Masked token vs cookie on unsafe methods, Origin check on HTTPS |
| SQLi | Parameters always; danger in f-strings in `raw()`/cursor |
| Clickjacking | `XFrameOptionsMiddleware`, `DENY` by default |
| Caching | Redis backend; `on_commit` delete; version keys; `Vary` on auth |
| Async | Helps I/O fan-out under ASGI; no async transactions; `SynchronousOnlyOperation` |
| Celery | IDs not instances; `on_commit(delay)`; `acks_late` plus idempotent; prefetch 1 for long tasks |
| Channels | Groups plus a Redis layer; `database_sync_to_async`; validate Origin |
| Testing | `TestCase` rolls back (use `captureOnCommitCallbacks`); `TransactionTestCase` for real commits |
| Connections | One per thread; `CONN_MAX_AGE`; native pool 5.1+; PgBouncer transaction mode breaks server-side cursors |
| Deploy | `2 × cores + 1` workers to start; migrate as a release step; backward-compatible migrations |

**Remember this**

- Authorization bugs, not authentication bugs, cause most data leaks: scope `get_queryset()` everywhere.
- Everything is at-least-once: client retries, Celery, webhooks. Idempotency keys and unique constraints absorb the duplicates.
- Side effects go in `transaction.on_commit`.
- Shared caches must never hold per-user responses unless the user is part of the key.
- Async is a tool for I/O fan-out, not a general speed-up.
- Show the connection arithmetic for any scaling answer.
- Scenario answers: scope, mitigate, measure, hypothesise, fix, prevent.

## 11. Hands-On Exercises

Scratch project: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" "djangorestframework~=3.15" djangorestframework-simplejwt django-filter celery redis pytest-django factory-boy`.

1. **The list-view leak.** Build an `Order` ModelViewSet with an `IsOwner` object permission only. Show that `GET /orders/` leaks every order, fix it with `get_queryset()` scoping, and write the two-user test.
2. **Auth comparison.** Set up `SessionAuthentication` and SimpleJWT on the same endpoint. Show that the session POST needs `X-CSRFToken` and the JWT POST does not. Observe 403 vs 401 by reordering the authentication classes.
3. **Throttle across workers.** Run Gunicorn with 4 workers and `locmem`, and hammer an endpoint throttled at 10/min. Count the successes, then switch to Redis and repeat.
4. **Duplicate orders.** Simulate a client timeout plus a retry against `POST /orders/`. Show the duplicate, then add the `Idempotency-Key` table and replay logic from §5.15 and show the retry returning the original response.
5. **Celery twice.** Write a task with `acks_late=True`, kill the worker (`kill -9`) mid-task, and watch it redeliver. Make it idempotent with a status check and a unique constraint.
6. **Connection budget.** Run 3 Gunicorn instances × 5 workers with `CONN_MAX_AGE=60`, load them, and count the connections in `pg_stat_activity`. Add PgBouncer in transaction mode and count again.

### Mock-interview drills

- **Rapid fire (10 minutes):** 20 random questions from §5.1–§5.14, 30 seconds each.
- **Scenario round (20 minutes):** a partner picks one of the §5.15 scenarios and plays the incident commander, revealing data (APM traces, logs) only when you ask the right question.
- **Security probe (10 minutes):** "Here is our settings.py" (have a partner plant `DEBUG=True`, `ALLOWED_HOSTS=["*"]`, `CORS_ALLOW_ALL_ORIGINS=True`, `fields="__all__"`). Find them all and explain the risk of each.
- **Scaling whiteboard (10 minutes):** redraw the §4 topology and do the connection arithmetic for 3 different traffic numbers.

### Mini project

Build an "orders API" that passes a hostile test suite you write first: cross-user and cross-tenant 404s on every endpoint and action; JWT refresh rotation and blacklist on logout; idempotent `POST /orders/` with replay; a capture task that survives `kill -9` without double-charging (a mocked gateway counts calls); `assertNumQueries` at two sizes for every list endpoint; and `check --deploy` passing in CI. Each test maps to one question in this chapter, which gives you a concrete repository to walk an interviewer through.

## 12. Related Topics & Free Learning Resources

**Concept chapters each answer comes from:**

- [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization) — serializer N+1, `iterator()`.
- [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) — `on_commit`, locks, idempotent writes.
- [Ch 18 · Middleware](topic.html?p=18-middleware) — the sync/async middleware chain, ordering.
- [Ch 20 · Static & Media Files](topic.html?p=20-static-media-files) — WhiteNoise, `STORAGES`, uploads.
- [Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers) — validation order, nested writes, mass assignment.
- [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers) — generic views, `get_queryset`, `@action`.
- [Ch 23 · DRF Authentication, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling) — auth classes, object permissions, throttles.
- [Ch 24 · DRF Pagination, Filtering, Versioning & Docs](topic.html?p=24-drf-pagination-filtering-versioning) — cursor pagination, django-filter, drf-spectacular.
- [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user) — `AUTH_USER_MODEL`, hashers, backends.
- [Ch 26 · Permissions, Groups & Authorization](topic.html?p=26-permissions-authorization) — model and object permissions, tenancy.
- [Ch 27 · Sessions, Cookies & Messages](topic.html?p=27-sessions-cookies) — session engines and cookie flags.
- [Ch 28 · Security: CSRF, XSS, SQL Injection & Hardening](topic.html?p=28-security) — every security answer here.
- [Ch 29 · Caching in Django](topic.html?p=29-caching) — backends, invalidation, stampedes.
- [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi) — async views, async ORM, adapters.
- [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks) — retries, acks, canvas, beat.
- [Ch 32 · Django Channels & Real-Time](topic.html?p=32-channels-websockets) — consumers, groups, layers.
- [Ch 33 · Testing Django Applications](topic.html?p=33-testing) — test classes, APIClient, mocking.
- [Ch 34 · Scaling Django: Connections, Replicas & Multiple Databases](topic.html?p=34-scaling-databases) — pooling, routers, lag.
- [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production) — Gunicorn/Uvicorn, release steps, monitoring.
- [Ch 36 · Django Internals](topic.html?p=36-django-internals) — handlers and the app registry.
- Other rounds: [Ch 37 · Core & ORM questions](topic.html?p=37-interview-core-orm), [Ch 39 · ORM Coding Round](topic.html?p=39-orm-coding-challenges), [Ch 40 · Design Rounds](topic.html?p=40-design-rounds).

**Other handbooks:** [REST API · JWT](../rest-api/topic.html?p=20-jwt), [REST API · Idempotency Keys](../rest-api/topic.html?p=27-idempotency-keys-retries), [REST API · Rate Limiting](../rest-api/topic.html?p=24-rate-limiting-throttling), [REST API · OWASP API Security](../rest-api/topic.html?p=23-owasp-api-security), [Redis Caching · Cache Stampede](../redis-caching/topic.html?p=15-cache-stampede), [Messaging · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox), [Database Design · Replication](../database-design/topic.html?p=09-replication), [System Design · Rate Limiting](../system-design/topic.html?p=26-rate-limiting).

**Free resources**

- **Django REST framework documentation** — DRF · *Beginner* · the API guide for serializers, views, auth, permissions and throttling. https://www.django-rest-framework.org/
- **Django documentation: Security in Django** — Django Project · *Intermediate* · the official overview of CSRF, XSS, SQLi, clickjacking and host validation. https://docs.djangoproject.com/en/5.2/topics/security/
- **Django documentation: Deployment checklist** — Django Project · *Intermediate* · exactly what `check --deploy` and production settings require. https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/
- **Django documentation: Asynchronous support** — Django Project · *Advanced* · async views, the async ORM and its limits, adapters. https://docs.djangoproject.com/en/5.2/topics/async/
- **Celery documentation** — Celery Project · *Intermediate* · tasks, retries, acks_late, routing and canvas. https://docs.celeryq.dev/
- **Django Channels documentation** — Channels · *Intermediate* · consumers, routing, channel layers and auth. https://channels.readthedocs.io/
- **Simple JWT documentation** — Jazzband · *Intermediate* · token lifetimes, rotation and blacklisting. https://django-rest-framework-simplejwt.readthedocs.io/
- **OWASP API Security Top 10** — OWASP · *Intermediate* · the threat list behind the IDOR, mass-assignment and rate-limit questions. https://owasp.org/API-Security/

---

*Django Handbook — chapter 38.*
