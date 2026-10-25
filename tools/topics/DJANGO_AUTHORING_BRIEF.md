# Django Handbook — Authoring Brief (read fully before writing)

Repo root: /Users/himanshu/Temp11/DSA-Patterns-Handbook
Your output: `django/markdown/<slug>.md` — ONE file per assigned chapter. Write NOTHING else, and edit no other files.
Manifest (slugs, names, summaries, keywords, categories, levels): `tools/topics/django_topics.json`.

## Audience & thesis
Readers are Python developers going from **first Django project → Senior Backend Engineer**, preparing for **Django / backend interviews** and for running Django in production. Every chapter must answer three questions: *what must I know*, *what breaks in production*, and *what will the interviewer ask*.

Teaching arc everywhere: **Problem → why the naive approach fails → the Django concept → how Django implements it internally → simple example → real-world example → trade-off → production pitfalls → interview angle.** No long definitions without a "why".

Target versions: **Django 5.2 LTS** (mention 4.2 LTS differences where they matter), **Python 3.12+**, **DRF 3.15+**, **PostgreSQL** as the default database, Celery 5.x, Channels 4.x.

## BEFORE writing each chapter
1. Read `messaging/markdown/21-idempotency-outbox.md` once (house style, depth, SVG style, Q/A format).
2. Read the manifest entries for your chapters AND their neighbours so you know what sibling chapters cover — link to them instead of re-teaching. Each topic has ONE home chapter; others give a one-line recap + link.
3. Overlapping handbooks exist — link them where useful, never copy: `sql/` (queries, indexes, isolation), `database-design/` (MVCC, pooling, replication), `rest-api/` (HTTP, status codes, pagination, JWT, OAuth), `redis-caching/`, `messaging/`, `docker/`, `kubernetes/`, `system-design/`. Verify a slug with `ls <handbook>/markdown` before linking.

## Links (relative; inline markdown links render)
- Sibling: `[Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization)` — slugs EXACTLY as in the manifest (siblings may not exist yet on disk; trust the manifest).
- Other handbooks: `[REST API · Pagination](../rest-api/topic.html?p=13-pagination)`, `[SQL · Isolation Levels](../sql/topic.html?p=26-isolation-levels)`.
- External: only stable official URLs — `https://docs.djangoproject.com/en/5.2/...`, `https://www.django-rest-framework.org/...`, `https://docs.celeryq.dev/...`, `https://channels.readthedocs.io/...`, `https://github.com/...` for well-known projects. Never invent deep URLs you are unsure of; prefer the docs topic index pages.
- Each chapter (except 01) must have a `> **Builds on:**` callout at the top of §1 linking prerequisite sibling chapters.

## Exact file skeleton (a quality gate checks this — do not deviate)
```
# NN · <Chapter name exactly as in manifest>

> **In one line:** <the chapter's thesis in one or two sentences>

---

## 1. Overview
## 2. Core Concepts
## 3. Theory & Principles
## 4. Architecture & Workflow
## 5. Implementation
## 6. Advantages, Disadvantages & Trade-offs
## 7. Common Mistakes & Best Practices
## 8. Production: Pitfalls, Debugging & Scaling
## 9. Interview Questions
## 10. Quick Revision & Cheat Sheet
## 11. Hands-On Exercises
## 12. Related Topics & Free Learning Resources

---

*Django Handbook — chapter NN.*
```
NN is two digits (01..40). H2s must begin exactly `## 1. Overview`, `## 2. Core Concepts`, `## 3. Theory`, `## 4. Architecture`, `## 5. Implementation`, `## 6. Advantages`, `## 7. Common Mistakes`, `## 8. Production`, `## 9. Interview Questions`, `## 10. Quick Revision`, `## 11. Hands-On Exercises`, `## 12. Related Topics` — use the full titles above. Use `###` subsections freely.

## Section contents (concept chapters 01–36)
- §1 Overview — the problem, why it exists, why the naive approach fails; Builds-on callout.
- §2 Core Concepts — bullet glossary; each term with *why it matters*.
- §3 Theory & Principles — the mechanism step by step, including **how Django does it internally** (which class/method, e.g. `QuerySet._fetch_all`, `BaseHandler.get_response`, `ModelBase`); at least one ```svg diagram.
- §4 Architecture & Workflow — flow/sequence/component view; at least one more ```svg diagram. ```text ASCII diagrams welcome in addition.
- §5 Implementation — a **simple example** and a **real-world example** with complete, correct, runnable code (```python for models/views/serializers/settings, ```html for templates, ```bash for manage.py/pip, ```sql for the SQL the ORM generates — show generated SQL often, it is what interviewers probe). Show output as ```text where it teaches.
- §6 Trade-offs — a table, plus explicit **When to use** and **When NOT to use** subsections.
- §7 Common Mistakes & Best Practices — each mistake: what people do, why it hurts, what to do instead (code before/after where useful).
- §8 Production — concrete pitfalls ("in production X happens, symptom Y, root cause Z, fix"), how to debug (debug-toolbar, `connection.queries`, `QuerySet.explain()`, logging, Sentry), scaling notes.
- §9 Interview Questions — at least **12**, format EXACTLY:
  ```
  **Q: Question text ending with a question mark?**
  A: Answer paragraph (3–8 sentences, reasoning-first; code inline or a short block when it helps).
  ```
  Blank line between pairs. At least **3** tagged Senior, written exactly like `**Q: How would you ...? (Senior)**` — the literal `(Senior)` must appear. These must be the questions **actually asked** in Django interviews on this topic (e.g. "difference between select_related and prefetch_related", "null vs blank", "how does Django prevent CSRF", "what happens when you call save()"), plus debugging and design follow-ups.
- §10 Quick Revision — a markdown table + 6–10 bullet "remember this" points.
- §11 Hands-On Exercises — 4–6 exercises in a throwaway project (`python -m venv .venv && pip install "django~=5.2"`), plus a mini project.
- §12 Related Topics — sibling chapters (linked), other handbooks (linked), and 5–8 free resources: `- **Title** — Source · *Level* · one-line why. <URL>`.

## Interview-prep chapters 37–40 (same 12 H2 headings, re-purposed)
- **37 & 38 (question banks):** §1 how Django interviews are structured (screening → technical → design), what each level is expected to know; §2 topic map of what's covered; §3 & §4 "how to answer" frameworks with svg diagrams (e.g. the answer structure; a request-lifecycle whiteboard you can redraw in an interview); §5 the BULK: grouped `### ` subsections each holding many Q/A pairs in the exact `**Q: …?**` / `A:` format — **37 must contain ≥ 60 questions, 38 ≥ 60 questions** in total across §5 and §9; §6 junior vs mid vs senior expectations table; §7 answering mistakes candidates make; §8 tricky/gotcha questions; §9 ≥ 12 hardest (Senior) follow-ups; §10 one-screen cheat sheet; §11 mock-interview drills; §12 links into the concept chapters that each answer comes from (≥ 15 sibling links). Do NOT simply copy Q&As from concept chapters; write fresh, interview-grade answers that cross-link the chapter.
- **39 (ORM coding round):** ≥ 25 problems. Each as `### Problem N — title`: the models (one shared schema defined once in §2, e.g. Author/Book/Publisher/Order/OrderItem/User), the question, the QuerySet solution, the generated SQL, complexity/index note, and a common wrong answer. Spread across §3–§8 by difficulty. §9 still ≥ 12 Q/A.
- **40 (design rounds):** 4–5 full rounds (e-commerce checkout without overselling, multi-tenant SaaS, notifications/fan-out pipeline, rate-limited public API, optionally a URL shortener/analytics). Each: requirements & numbers, models (code), API (DRF), concurrency (atomic/select_for_update/idempotency key), Celery tasks, caching, scaling path, failure modes. §9 ≥ 12 follow-up Qs.

## SVG rules (the gate XML-parses every ```svg block; malformed = fail)
- Fence ```svg … ``` containing exactly one root: `<svg viewBox="0 0 W H" width="100%" height="H" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">`.
- **≥ 2** svg diagrams per chapter, each genuinely explaining a mechanism (request flow, middleware onion, query compilation, prefetch two-query join, transaction/savepoint timeline, Celery topology, router decisions, validation pipeline…). Not decorative.
- Well-formed XML: escape `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;` in text; no XML comments; close every tag; quote every attribute.
- Marker/gradient ids unique per chapter (prefix with chapter number, e.g. `id="dj13a"`).
- Fixed light palette (renders on a white card in both themes): text `#1e293b`/`#334155`, borders `#94a3b8`, blue `#2563eb`/`#dbeafe`, green `#16a34a`/`#dcfce7`, red `#dc2626`/`#fee2e2`, amber `#d97706`/`#fef3c7`, purple `#7c3aed`/`#ede9fe`. Text ≥ 9px and inside its box; width ≤ 900.
- **Gotcha:** the page renderer merges *consecutive* fenced code blocks into tabs. Never put a ```svg block immediately after another code block — always put a prose sentence between them.
- Validate: `python3 -c "import re,sys,xml.dom.minidom as m;t=open(sys.argv[1]).read();[m.parseString(s.strip()) for s in re.findall(r'\`\`\`svg\s*(.*?)\`\`\`',t,re.S)];print('ok')" django/markdown/<slug>.md`

## Length & depth
Target **450–750 lines** per concept chapter; 37–40 may be longer (700–1100). Floor enforced: 150. Deep, specific, correct; paragraphs, not just bullets.

## ACCURACY SHEET (get these right)
- Django calls its pattern **MTV/MVT**: the Django *view* ≈ MVC controller logic, the *template* ≈ MVC view; the framework itself (URLconf) is the dispatcher. WSGI entry `django.core.handlers.wsgi.WSGIHandler`, ASGI `ASGIHandler`; both subclass `BaseHandler`, which builds the middleware chain once (`load_middleware`) and calls `get_response`. URL resolution: `ROOT_URLCONF` (or `request.urlconf`), patterns tried **in order**, first match wins; no match → 404 (`technical_404` when DEBUG). `APPEND_SLASH` is done by `CommonMiddleware`.
- Middleware: since 1.10 new-style callables `__init__(get_response)` / `__call__(request)`; request phase runs top→bottom, response bottom→top; `process_view`, `process_exception`, `process_template_response` hooks. Recommended order: SecurityMiddleware first, then SessionMiddleware, CommonMiddleware, CsrfViewMiddleware, AuthenticationMiddleware (needs session), MessageMiddleware, XFrameOptionsMiddleware. A middleware returning a response short-circuits the inner layers.
- QuerySets are **lazy**; evaluated by iteration, `len()`, `list()`, `bool()`, slicing with a step, `repr()`, pickling. Result cache lives on the QuerySet instance; `.all()` returns a new QuerySet (fresh cache); slicing an unevaluated QuerySet adds LIMIT/OFFSET (negative indexing not supported). `get()` raises `DoesNotExist` / `MultipleObjectsReturned`. `count()` on an evaluated QuerySet uses `len(cache)`. `exists()` is cheaper than `count()` for presence. `iterator(chunk_size=…)` bypasses the result cache (prefetch_related works with iterator() only when chunk_size is given, Django 4.1+).
- `select_related` → SQL JOIN for forward FK and OneToOne (and reverse O2O); `prefetch_related` → one extra query per relation using `WHERE ... IN (...)` and joins in Python; works for M2M, reverse FK, GenericForeignKey. `Prefetch('books', queryset=..., to_attr=...)`. Any further `.filter()` on a prefetched relation manager re-queries (defeats the prefetch).
- `null=True` is database-level (NULL allowed), `blank=True` is validation-level (forms/full_clean). Avoid `null=True` on CharField/TextField (two empty values). `Model.save()` does NOT call `full_clean()`; ModelForm does. `QuerySet.update()` / `bulk_create()` / `bulk_update()` skip `save()` and do not send `pre_save`/`post_save` signals; `QuerySet.delete()` does send pre/post_delete per object (it collects them) — but not if fast-delete applies. `bulk_create` sets PKs on PostgreSQL (and SQLite 3.35+, MariaDB 10.5+). `update_fields=` limits the UPDATE columns.
- `DEFAULT_AUTO_FIELD` = `BigAutoField` in new projects (since 3.2). `on_delete` options: CASCADE, PROTECT, RESTRICT, SET_NULL, SET_DEFAULT, SET(...), DO_NOTHING; on_delete is emulated by Django (the collector), not by DB `ON DELETE` constraints (Django 6.0 adds db-level on_delete — mention only as "newer versions" if at all).
- Transactions: Django runs in **autocommit** by default. `transaction.atomic()` nests via **savepoints**; an exception inside a nested atomic rolls back to the savepoint; catching DatabaseError *inside* an atomic block without a nested atomic leaves the transaction broken (`TransactionManagementError`). `ATOMIC_REQUESTS=True` wraps each view in a transaction. `transaction.on_commit(fn)` runs after the outermost commit (dropped on rollback); use it to enqueue Celery tasks. `select_for_update()` must run inside atomic(); options `nowait`, `skip_locked`, `of=`, `no_key=`. `F('stock') - 1` in `update()` is an atomic DB-side update; after `obj.save()` with F expressions call `refresh_from_db()`. Django's default isolation on PostgreSQL is READ COMMITTED.
- Migrations: autodetector compares models to the migration state (not the DB). `RunPython(forwards, backwards)` must use `apps.get_model`, not direct imports. `--fake`, `--fake-initial`, `squashmigrations`, `makemigrations --merge`, `sqlmigrate`, `showmigrations`, `migrate app zero`. PostgreSQL migrations are transactional by default (`atomic = False` for `AddIndexConcurrently` from `django.contrib.postgres.operations`). Adding a NOT NULL column with default: Django 5.0 adds `db_default`.
- Signals are **synchronous** and run in the same transaction/thread; register receivers in `AppConfig.ready()`; `dispatch_uid` prevents duplicate registration. `m2m_changed` fires for `.add/.remove/.clear/.set`.
- Forms validation order: `field.clean()` = `to_python()` → `validate()` → `run_validators()`; then `clean_<fieldname>()`; then `Form.clean()`; ModelForm `_post_clean` runs `instance.full_clean()` (model validation, unique checks). `is_valid()` triggers it; errors in `form.errors`; `cleaned_data` only after validation.
- Auth: `AUTH_USER_MODEL` must be set **before the first migrate**; changing it mid-project is painful. `AbstractUser` (keep fields, add more) vs `AbstractBaseUser` + `PermissionsMixin` (full control, need a custom manager with create_user/create_superuser). Reference the user via `settings.AUTH_USER_MODEL` in FKs and `get_user_model()` elsewhere. Default hasher PBKDF2-SHA256 (iterations raised each release; say "about a million" or avoid the exact number); Argon2 recommended via `argon2-cffi`. Passwords stored as `algorithm$iterations$salt$hash`. `authenticate()` iterates `AUTHENTICATION_BACKENDS`. `login()` rotates the session key (prevents fixation).
- Sessions: default engine `django.contrib.sessions.backends.db`; others `cache`, `cached_db`, `file`, `signed_cookies`. Default `SESSION_COOKIE_AGE` 2 weeks (1209600 s); `SESSION_COOKIE_HTTPONLY=True`; `SESSION_COOKIE_SAMESITE='Lax'`; session saved only when modified (unless `SESSION_SAVE_EVERY_REQUEST`).
- CSRF: `CsrfViewMiddleware` + `{% csrf_token %}`; token is a masked secret compared with the `csrftoken` cookie (or session if `CSRF_USE_SESSIONS`); checked for unsafe methods (POST/PUT/PATCH/DELETE); HTTPS requests check `Origin`/`Referer` against `CSRF_TRUSTED_ORIGINS` (which needs a scheme since 4.0). AJAX sends `X-CSRFToken`. `@csrf_exempt` is dangerous. DRF `SessionAuthentication` enforces CSRF for authenticated requests; Token/JWT auth does not need CSRF.
- XSS: templates autoescape `< > ' " &`; `|safe`, `mark_safe`, `{% autoescape off %}` disable it; autoescape does not protect inside `<script>` blocks or unquoted attributes — use `json_script`. SQLi: ORM parameterizes; danger in `raw()`/`extra()`/`cursor.execute()` with string formatting — pass params. Clickjacking: `XFrameOptionsMiddleware`, default `X_FRAME_OPTIONS='DENY'` (since 3.0). Host header: `ALLOWED_HOSTS` (enforced when DEBUG=False). `manage.py check --deploy`. Django 6.0 adds built-in CSP; for 5.2 use django-csp.
- Caching: backends `django.core.cache.backends.redis.RedisCache` (built-in since 4.0), `memcached.PyMemcacheCache`, `locmem` (per-process — not shared across Gunicorn workers), `db`, `file`, `dummy`. `cache_page` per-view; `UpdateCacheMiddleware` (first) + `FetchFromCacheMiddleware` (last) per-site; `{% cache %}` fragment; low-level `cache.get/set/get_or_set/delete/incr`, `version=`, `KEY_PREFIX`. Default TIMEOUT 300 s. `@vary_on_headers`, `ConditionalGetMiddleware` / `@condition` for ETag.
- Async: async views since 3.1; async ORM interface (`aget`, `acreate`, `async for`, `acount`…) since 4.1 — queries still run in a thread via `sync_to_async` under the hood; **transactions are not yet supported in async code** (wrap in `sync_to_async`). `sync_to_async(thread_sensitive=True)` default runs in the single main thread. Under WSGI, async views run in a one-off event loop per request (no benefit). Calling the sync ORM from async code raises `SynchronousOnlyOperation`.
- DRF: request flow `APIView.dispatch` → `initial()` (perform_authentication, check_permissions, check_throttles) → handler → `finalize_response`. Authentication is **lazy** (on `request.user` access). `has_permission` runs for every request; `has_object_permission` only when `get_object()` / `check_object_permissions` is called — **not** for list views. Serializer: `is_valid(raise_exception=True)`, `validate_<field>`, `validate()`, `create()`/`update()`; `.data` after save; nested writes require overriding create/update. ModelSerializer runs model field validators and unique validators, but **not** `Model.clean()`. Pagination classes: PageNumberPagination, LimitOffsetPagination, CursorPagination (stable, needs unique ordering, no total count). Throttles: AnonRateThrottle, UserRateThrottle, ScopedRateThrottle — they use the cache (locmem per process ⇒ inaccurate across workers). SimpleJWT: access token short (default 5 min), refresh (1 day), rotation + blacklist app.
- Celery: broker (Redis/RabbitMQ), workers, optional result backend; `@shared_task(bind=True, autoretry_for=(...), retry_backoff=True, max_retries=…)`; `acks_late=True` + idempotent tasks for at-least-once safety; pass IDs, not model instances; dispatch with `transaction.on_commit(lambda: task.delay(id))`; beat for periodic tasks (django-celery-beat for DB schedules); canvas: chain, group, chord. Default prefetch multiplier 4 (set 1 for long tasks). Django 6.0 adds a built-in Tasks framework — mention only as "newer versions".
- Channels: ASGI `ProtocolTypeRouter`, `URLRouter`, `AuthMiddlewareStack`; `WebsocketConsumer`/`AsyncWebsocketConsumer`/`AsyncJsonWebsocketConsumer`; channel layer `channels_redis.core.RedisChannelLayer`; `group_add`/`group_send` with `type` mapping to a handler method; `database_sync_to_async` for ORM access.
- Testing: `SimpleTestCase` (no DB), `TestCase` (wraps each test in a transaction + rollback; `setUpTestData` for class-level data; on_commit callbacks need `captureOnCommitCallbacks` since 3.2), `TransactionTestCase` (truncates tables; needed to test real commit behaviour), `LiveServerTestCase`. `self.assertNumQueries(n)`, `override_settings`, `Client`/`RequestFactory`, DRF `APIClient`/`APITestCase`. pytest-django `@pytest.mark.django_db`, `django_assert_num_queries`.
- DB connections: one connection per thread; `CONN_MAX_AGE` (0 = close each request; `None` = persistent forever), `CONN_HEALTH_CHECKS` (4.1+). **Django 5.1 adds native connection pooling for PostgreSQL** with psycopg 3: `OPTIONS: {"pool": True}` (or pool kwargs). PgBouncer in transaction mode breaks server-side cursors (set `DISABLE_SERVER_SIDE_CURSORS=True`). Database routers: `db_for_read`, `db_for_write`, `allow_relation`, `allow_migrate`; `.using('replica')`; replication lag ⇒ read-your-writes issues.
- Deployment: Gunicorn sync workers default formula `2 × cores + 1` (a starting point), `--timeout` default 30 s; uvicorn worker class `uvicorn.workers.UvicornWorker` (or `uvicorn-worker` package) for ASGI. `DEBUG=False` requires `ALLOWED_HOSTS`; static served by WhiteNoise or a CDN/Nginx, never by `runserver`. `STORAGES` setting (4.2+) replaced `DEFAULT_FILE_STORAGE`/`STATICFILES_STORAGE`. `SECURE_PROXY_SSL_HEADER` behind a TLS-terminating proxy. Run migrations as a separate release step, not on every container boot in parallel.
- Internals: `settings` is a `LazySettings` (`LazyObject`) configured on first access from `DJANGO_SETTINGS_MODULE`; `django.setup()` configures logging and populates the `apps` registry (import app configs → import models → call `ready()`). `ModelBase` metaclass builds `Options` (`_meta`), contributes fields via `contribute_to_class`, registers the model. Related access uses descriptors (`ForwardManyToOneDescriptor`, `ReverseManyToOneDescriptor`, `ManyToManyDescriptor`). `QuerySet` holds a `sql.Query`; on evaluation `query.get_compiler(using).execute_sql()` → `SQLCompiler.as_sql()`; `ModelIterable` builds instances. `str(qs.query)` shows (approximate, unquoted-params) SQL.
- Never state a number or API you aren't confident of; phrase as "on the order of" or omit.

## Style
- Second person, direct, confident; short paragraphs; bold key terms on first use.
- Tables for comparisons. Callouts: `> **Why this matters:**`, `> **Interview tip:**`, `> **Production story:**`, `> **Gotcha:**`, `> **Version note:**`.
- No emojis in headings. No filler. No "In conclusion".

## Self-check before you report done
Run the gate; YOUR chapters' rows must say OK (others show MISSING until other authors finish — ignore them):
`python3 tools/hb_pipeline.py gate tools/topics/django_topics.json`
Also check every `topic.html?p=` slug you used: siblings must be in the manifest; other handbooks verified via `ls`.
Report per chapter: lines, svg count, Q count, Senior count — one line each. Keep the report short.
