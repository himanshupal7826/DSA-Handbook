# 18 · Middleware

> **In one line:** Middleware is Django's onion: `BaseHandler.load_middleware()` wraps the view in every class from `MIDDLEWARE` once at startup, so requests flow top→bottom and responses bottom→top; knowing that order, the `process_view` / `process_exception` / `process_template_response` hooks, and when a layer short-circuits is what lets you write correct cross-cutting code — and debug why `request.user` is anonymous.

---

## 1. Overview

> **Builds on:** [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle), [Ch 04 · Views, HttpRequest & HttpResponse](topic.html?p=04-views-requests-responses), [Ch 17 · Class-Based & Generic Views](topic.html?p=17-class-based-views).

Some logic belongs to *every* request: attach a request ID, enforce HTTPS, load the session, authenticate the user, add security headers, time the request, route a tenant by hostname. The naive approach is a decorator on every view, or a helper call at the top of each one. It fails fast: someone forgets it on a new view, it doesn't cover 404s or responses from other layers, and ordering between helpers is implicit.

**Middleware** is Django's answer: a chain of callables, configured in the `MIDDLEWARE` setting, that every request passes through on the way in and every response passes through on the way out. Each layer can inspect or modify the request, **short-circuit** by returning a response without calling the inner layers, or modify the response coming back. The order of the list is semantics: `AuthenticationMiddleware` needs `request.session`, so it must come after `SessionMiddleware`; CSRF checks must happen before your view runs; GZip must happen after anything that changes the body.

This chapter is the home for middleware mechanics, the built-in ordering, and writing custom (including async-capable) middleware. Specific built-ins are explained in their own chapters: sessions ([Ch 27](topic.html?p=27-sessions-cookies)), CSRF/security headers ([Ch 28](topic.html?p=28-security)), per-site caching ([Ch 29](topic.html?p=29-caching)), WhiteNoise ([Ch 20](topic.html?p=20-static-media-files)).

> **Why this matters:** "Explain the middleware order", "write a middleware that logs request duration", and "why is `request.user` anonymous in my middleware when I use JWT?" are staple questions. They test whether you understand the request lifecycle beyond views.

## 2. Core Concepts

- **`MIDDLEWARE` setting** — ordered list of dotted paths. *Why it matters:* order defines nesting; first = outermost.
- **Middleware factory** — a callable taking `get_response` and returning a middleware callable; usually a class with `__init__(self, get_response)` and `__call__(self, request)`. *Why it matters:* `__init__` runs **once per process** at startup, `__call__` per request.
- **`get_response`** — the next layer inward (another middleware or the view-calling core). *Why it matters:* code before calling it is the request phase, code after is the response phase.
- **Short-circuit** — returning an `HttpResponse` without calling `get_response`. *Why it matters:* inner middleware and the view never run, but outer middleware still process the response.
- **`process_view(request, view_func, view_args, view_kwargs)`** — called after URL resolution, just before the view. *Why it matters:* the only hook that knows *which* view will run (e.g. check view attributes set by decorators).
- **`process_exception(request, exception)`** — called when the view raises. *Why it matters:* map domain exceptions to responses, report errors; return `None` to let default handling continue.
- **`process_template_response(request, response)`** — called when the response has a `render()` method (`TemplateResponse`). *Why it matters:* modify `response.context_data` or template before it renders.
- **`MiddlewareMixin`** — `django.utils.deprecation.MiddlewareMixin`, supports old-style `process_request`/`process_response`. *Why it matters:* many built-ins and third-party middleware use it; also gives async compatibility.
- **`MiddlewareNotUsed`** — raise it from `__init__` to remove the middleware from the chain (e.g. feature-flag off). *Why it matters:* zero per-request cost when disabled.
- **`sync_capable` / `async_capable`** — flags (and decorators `sync_only_middleware`, `async_only_middleware`, `sync_and_async_middleware`) telling the handler which mode the middleware supports. *Why it matters:* a sync middleware in an ASGI stack forces thread hops on every request.
- **`convert_exception_to_response`** — wraps each layer so exceptions become responses (404, 403, 400, 500) before they reach the outer layer. *Why it matters:* outer middleware see a response, not an exception.

## 3. Theory & Principles

### 3.1 How the chain is built — `BaseHandler.load_middleware`

When `WSGIHandler` (or `ASGIHandler`) is created — at process start, via `get_wsgi_application()` — it calls `load_middleware()`. Simplified:

```python
def load_middleware(self, is_async=False):
    self._view_middleware = []
    self._template_response_middleware = []
    self._exception_middleware = []

    get_response = self._get_response_async if is_async else self._get_response
    handler = convert_exception_to_response(get_response)        # innermost: the view caller
    handler_is_async = is_async

    for middleware_path in reversed(settings.MIDDLEWARE):         # build from the inside out
        middleware = import_string(middleware_path)
        # adapt handler to sync/async as the middleware requires (sync_to_async/async_to_sync)
        try:
            mw_instance = middleware(adapted_handler)            # __init__(get_response) ONCE
        except MiddlewareNotUsed:
            continue
        if hasattr(mw_instance, "process_view"):
            self._view_middleware.insert(0, mw_instance.process_view)          # top -> bottom
        if hasattr(mw_instance, "process_template_response"):
            self._template_response_middleware.append(mw_instance.process_template_response)  # bottom -> top
        if hasattr(mw_instance, "process_exception"):
            self._exception_middleware.append(mw_instance.process_exception)   # bottom -> top
        handler = convert_exception_to_response(mw_instance)

    self._middleware_chain = handler                              # outermost layer
```

Then each request calls `self._middleware_chain(request)`. Iterating `reversed()` means the **last** middleware in the list wraps the view directly and the **first** becomes the outermost layer. The hook lists are ordered so `process_view` runs top→bottom and `process_exception`/`process_template_response` run bottom→top — matching the onion.

### 3.2 The onion

```svg
<svg viewBox="0 0 860 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj18a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj18b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">The middleware onion: request in top-to-bottom, response out bottom-to-top</text>
  <rect x="150" y="40" width="560" height="320" rx="14" fill="#dbeafe" stroke="#2563eb"/>
  <text x="430" y="58" text-anchor="middle" fill="#1e293b">SecurityMiddleware (outermost)</text>
  <rect x="180" y="66" width="500" height="282" rx="12" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="430" y="84" text-anchor="middle" fill="#1e293b">SessionMiddleware: request.session</text>
  <rect x="210" y="92" width="440" height="244" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="430" y="110" text-anchor="middle" fill="#1e293b">CommonMiddleware: APPEND_SLASH, ALLOWED_HOSTS via get_host()</text>
  <rect x="240" y="118" width="380" height="206" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="430" y="136" text-anchor="middle" fill="#1e293b">CsrfViewMiddleware: check in process_view</text>
  <rect x="270" y="144" width="320" height="168" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="430" y="162" text-anchor="middle" fill="#1e293b">AuthenticationMiddleware: lazy request.user</text>
  <rect x="300" y="170" width="260" height="130" rx="10" fill="#fff" stroke="#94a3b8"/>
  <text x="430" y="188" text-anchor="middle" fill="#334155">Messages, XFrameOptions ...</text>
  <rect x="340" y="200" width="180" height="84" rx="8" fill="#f1f5f9" stroke="#334155"/>
  <text x="430" y="222" text-anchor="middle" fill="#1e293b" font-weight="bold">_get_response</text>
  <text x="430" y="240" text-anchor="middle" fill="#334155">resolve URL</text>
  <text x="430" y="256" text-anchor="middle" fill="#334155">process_view chain</text>
  <text x="430" y="272" text-anchor="middle" fill="#334155">call view</text>
  <path d="M60,70 L60,250 L336,250" stroke="#2563eb" stroke-width="2" fill="none" marker-end="url(#dj18a)"/>
  <text x="60" y="62" text-anchor="middle" fill="#2563eb" font-weight="bold">request</text>
  <path d="M524,236 L800,236 L800,70" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#dj18b)"/>
  <text x="800" y="62" text-anchor="middle" fill="#16a34a" font-weight="bold">response</text>
  <text x="80" y="300" fill="#334155" font-size="10">code before get_response()</text>
  <text x="660" y="300" fill="#334155" font-size="10">code after get_response()</text>
</svg>
```

### 3.3 Inside `_get_response`

The innermost layer, `BaseHandler._get_response(request)`, does:

1. **Resolve** the URL: `resolver_match = resolve(request.path_info)` (using `request.urlconf` if a middleware set it). `Resolver404` becomes a 404 response.
2. Run each `process_view` in order. The first one that returns a response **stops** the rest and the view.
3. Call the view (wrapped in `atomic` if `ATOMIC_REQUESTS`). If it raises, run `process_exception` hooks bottom→top; the first non-`None` response wins; if none, re-raise and `convert_exception_to_response` turns it into a 404/403/400/500 response (calling `handler404`/`handler500`).
4. If the response has `render()` (a `TemplateResponse`), run `process_template_response` hooks bottom→top, then `response.render()`.
5. Return the response outward through each middleware's post-`get_response` code.

Key subtleties interviewers probe:

- **`process_exception` only sees exceptions from the view** (and from `TemplateResponse` rendering), not from other middleware. If a middleware's `__call__` raises, `convert_exception_to_response` around that layer converts it to an error response, and the outer layers see a *response*.
- **Short-circuit is symmetric:** if `SessionMiddleware` returned early (it doesn't, but suppose), `SecurityMiddleware`'s response phase would still run; inner layers' response phases would not.
- **Signals:** `request_started` / `request_finished` are sent by the handler outside the middleware chain; `request_finished` fires when the response is closed, which is when Django closes stale DB connections (`close_old_connections`).

### 3.4 Built-in ordering and why

| Position | Middleware | Why here |
|---|---|---|
| 1 | `SecurityMiddleware` | HTTPS redirect, HSTS etc. before any work; cheap |
| 2 | `whitenoise.middleware.WhiteNoiseMiddleware` (if used) | Serve static files before sessions/auth do needless work |
| (cache) | `UpdateCacheMiddleware` | Must be early so its response phase runs **last**, caching the final response |
| 3 | `SessionMiddleware` | Provides `request.session` for later layers |
| (i18n) | `LocaleMiddleware` | After Session (and cache), before Common (uses session/cookie for language) |
| 4 | `CommonMiddleware` | `APPEND_SLASH`/`PREPEND_WWW` redirects, `DISALLOWED_USER_AGENTS` |
| 5 | `CsrfViewMiddleware` | Before any view middleware that assumes CSRF is checked |
| 6 | `AuthenticationMiddleware` | Needs session; sets lazy `request.user` |
| 7 | `MessageMiddleware` | Uses session/cookie storage |
| 8 | `XFrameOptionsMiddleware` | Response header; position matters little |
| last | `FetchFromCacheMiddleware` | Late so its request phase runs after Session/Auth have set `Vary` |

`GZipMiddleware` should go before (i.e. above) anything that reads or modifies the response body, so its response phase runs after them. Note the BREACH attack risk when compressing responses containing secrets alongside attacker-controlled input.

> **Version note:** Django 5.1 added `django.contrib.auth.middleware.LoginRequiredMiddleware`: every view requires login unless decorated with `@login_not_required`. Place it after `AuthenticationMiddleware`.

## 4. Architecture & Workflow

### 4.1 Hook order for one request

```svg
<svg viewBox="0 0 860 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj18c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">MIDDLEWARE = [A, B, C]: the exact call order, including hooks</text>
  <rect x="20" y="45" width="120" height="30" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="80" y="64" text-anchor="middle" fill="#1e293b">A.__call__ (pre)</text>
  <rect x="160" y="45" width="120" height="30" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="220" y="64" text-anchor="middle" fill="#1e293b">B.__call__ (pre)</text>
  <rect x="300" y="45" width="120" height="30" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="360" y="64" text-anchor="middle" fill="#1e293b">C.__call__ (pre)</text>
  <rect x="440" y="45" width="120" height="30" rx="5" fill="#fef3c7" stroke="#d97706"/><text x="500" y="64" text-anchor="middle" fill="#1e293b">resolve URL</text>
  <rect x="580" y="45" width="260" height="30" rx="5" fill="#ede9fe" stroke="#7c3aed"/><text x="710" y="64" text-anchor="middle" fill="#1e293b">A.process_view, B.process_view, C.process_view</text>
  <path d="M142,60 L158,60" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj18c)"/>
  <path d="M282,60 L298,60" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj18c)"/>
  <path d="M422,60 L438,60" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj18c)"/>
  <path d="M562,60 L578,60" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj18c)"/>
  <rect x="640" y="110" width="200" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="740" y="131" text-anchor="middle" fill="#1e293b" font-weight="bold">view(request, ...)</text>
  <path d="M740,77 L740,108" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj18c)"/>
  <rect x="330" y="110" width="280" height="34" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="470" y="131" text-anchor="middle" fill="#1e293b">raises: C.process_exception, B..., A...</text>
  <path d="M638,127 L612,127" stroke="#dc2626" stroke-width="2" marker-end="url(#dj18c)"/>
  <rect x="580" y="180" width="260" height="34" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="710" y="201" text-anchor="middle" fill="#1e293b">TemplateResponse: C, B, A .process_template_response</text>
  <path d="M740,146 L740,178" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj18c)"/>
  <rect x="580" y="240" width="260" height="30" rx="5" fill="#fef3c7" stroke="#d97706"/><text x="710" y="259" text-anchor="middle" fill="#1e293b">response.render()</text>
  <path d="M710,216 L710,238" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj18c)"/>
  <rect x="300" y="285" width="120" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="360" y="304" text-anchor="middle" fill="#1e293b">C.__call__ (post)</text>
  <rect x="160" y="285" width="120" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="220" y="304" text-anchor="middle" fill="#1e293b">B.__call__ (post)</text>
  <rect x="20" y="285" width="120" height="30" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="80" y="304" text-anchor="middle" fill="#1e293b">A.__call__ (post)</text>
  <path d="M640,272 L422,296" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj18c)"/>
  <path d="M298,300 L282,300" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj18c)"/>
  <path d="M158,300 L142,300" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj18c)"/>
</svg>
```

### 4.2 Short-circuit scenarios

```text
B returns a response in its pre phase
    A.pre -> B.pre (returns 403) -> A.post -> client          C and the view never run

B.process_view returns a response
    A.pre B.pre C.pre -> A.pv -> B.pv (returns) -> C.post B.post A.post   C.pv and view skipped

C.__call__ raises ValueError in its pre phase
    convert_exception_to_response(C) -> 500 response -> B.post -> A.post   no process_exception
```

## 5. Implementation

### 5.1 Simple example — timing + request ID middleware

```python
# core/middleware.py
import logging
import time
import uuid

logger = logging.getLogger("request")


class RequestIDTimingMiddleware:
    header = "HTTP_X_REQUEST_ID"

    def __init__(self, get_response):
        self.get_response = get_response          # runs once per process

    def __call__(self, request):
        # ---- request phase ----
        request.id = request.META.get(self.header) or uuid.uuid4().hex
        start = time.perf_counter()

        response = self.get_response(request)     # inner layers + view

        # ---- response phase ----
        duration_ms = (time.perf_counter() - start) * 1000
        response["X-Request-ID"] = request.id
        response["Server-Timing"] = f"app;dur={duration_ms:.1f}"
        logger.info("%s %s %s %.1fms", request.method, request.path,
                    response.status_code, duration_ms, extra={"request_id": request.id})
        return response
```

```python
# settings.py
MIDDLEWARE = [
    "core.middleware.RequestIDTimingMiddleware",     # outermost: times everything below
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
```

```text
INFO GET /articles/ 200 23.4ms  request_id=6f1c0d...
```

Accept an incoming `X-Request-ID` only from trusted proxies in real deployments, and validate its format so clients can't inject log lines.

### 5.2 All the hooks in one class

```python
from django.http import JsonResponse
from django.core.exceptions import PermissionDenied


class MaintenanceAndErrorsMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        return self.get_response(request)

    def process_view(self, request, view_func, view_args, view_kwargs):
        # Views opt out with an attribute set by a decorator
        if getattr(view_func, "maintenance_exempt", False):
            return None
        from django.conf import settings
        if getattr(settings, "MAINTENANCE_MODE", False):
            return JsonResponse({"detail": "Down for maintenance"}, status=503)
        return None                                     # continue to next process_view/view

    def process_exception(self, request, exception):
        from billing.exceptions import PaymentProviderDown
        if isinstance(exception, PaymentProviderDown):
            return JsonResponse({"detail": "Payments temporarily unavailable"}, status=503)
        return None                                     # let Django's 500 handling continue

    def process_template_response(self, request, response):
        response.context_data["build_sha"] = "abc123"   # must return the response
        return response


def maintenance_exempt(view):
    view.maintenance_exempt = True
    return view
```

> **Gotcha:** For CBVs, `view_func` in `process_view` is the function returned by `as_view()`. Attributes set by a decorator applied in the URLconf are on that function; class attributes are reachable via `view_func.view_class`.

### 5.3 Real-world example — tenant routing + async-capable middleware + contextvars logging

```python
# tenants/middleware.py
import contextvars
from asgiref.sync import iscoroutinefunction, markcoroutinefunction
from django.http import HttpResponseNotFound
from django.utils.decorators import sync_and_async_middleware

current_tenant = contextvars.ContextVar("current_tenant", default=None)


def _resolve_tenant(host):
    from django.core.cache import cache
    from tenants.models import Tenant
    key = f"tenant:host:{host}"
    tenant_id = cache.get(key)
    if tenant_id is None:
        tenant = Tenant.objects.filter(domain=host, is_active=True).only("id").first()
        tenant_id = tenant.id if tenant else 0
        cache.set(key, tenant_id, 300)
    return tenant_id or None


@sync_and_async_middleware
def tenant_middleware(get_response):
    """Works natively under both WSGI and ASGI — no thread hop either way."""
    if iscoroutinefunction(get_response):
        from asgiref.sync import sync_to_async
        resolve = sync_to_async(_resolve_tenant)

        async def middleware(request):
            tenant_id = await resolve(request.get_host().split(":")[0])
            if tenant_id is None:
                return HttpResponseNotFound("Unknown tenant")
            token = current_tenant.set(tenant_id)
            request.tenant_id = tenant_id
            try:
                return await get_response(request)
            finally:
                current_tenant.reset(token)
    else:
        def middleware(request):
            tenant_id = _resolve_tenant(request.get_host().split(":")[0])
            if tenant_id is None:
                return HttpResponseNotFound("Unknown tenant")
            token = current_tenant.set(tenant_id)
            request.tenant_id = tenant_id
            try:
                return get_response(request)
            finally:
                current_tenant.reset(token)
    return middleware
```

The class-based async form, for comparison:

```python
from asgiref.sync import iscoroutinefunction, markcoroutinefunction


class AsyncHeaderMiddleware:
    async_capable = True
    sync_capable = False

    def __init__(self, get_response):
        self.get_response = get_response
        if iscoroutinefunction(self.get_response):
            markcoroutinefunction(self)        # tell Django this instance is async

    async def __call__(self, request):
        response = await self.get_response(request)
        response["X-Async"] = "1"
        return response
```

A logging filter reads the contextvar so every log line in the request — including from deep inside services — carries the tenant:

```python
# core/logging.py
import logging
from tenants.middleware import current_tenant

class TenantFilter(logging.Filter):
    def filter(self, record):
        record.tenant_id = current_tenant.get()
        return True
```

Use `contextvars`, not `threading.local`: under ASGI many requests share one thread, and thread-locals bleed across them; contextvars are per-task and also work under WSGI.

### 5.4 Testing middleware in isolation

```python
from django.http import HttpResponse
from django.test import RequestFactory, SimpleTestCase
from core.middleware import RequestIDTimingMiddleware


class RequestIDTests(SimpleTestCase):
    def test_sets_header(self):
        mw = RequestIDTimingMiddleware(lambda req: HttpResponse("ok"))
        request = RequestFactory().get("/", HTTP_X_REQUEST_ID="abc")
        response = mw(request)
        self.assertEqual(response["X-Request-ID"], "abc")
```

## 6. Advantages, Disadvantages & Trade-offs

| Approach | Scope | Pros | Cons |
|---|---|---|---|
| Middleware | Every request | Can't be forgotten; sees 404s and all responses; ordered | Runs even where unneeded; global cost; hidden from view code |
| View decorator | One view | Explicit, opt-in | Easy to forget; no coverage of non-view responses |
| CBV mixin | Views inheriting it | Reusable, knows view context | Only class-based views; MRO pitfalls |
| DRF auth/permission classes | DRF views | Per-view config, lazy auth | Not visible to Django middleware |
| Signals (`request_started`) | Every request | Decoupled | No access to the response; hard to reason about |
| Reverse proxy (Nginx/Envoy) | Edge | Fast, language-agnostic | Can't use Django state (user, session) |

### When to use

- Truly global concerns: request IDs, timing, security headers, tenant resolution by host, maintenance mode, locale.
- Response post-processing that must apply to everything (headers, compression).
- Mapping specific exceptions to responses across the app (`process_exception`).

### When NOT to use

- Logic that applies to a few views — use a decorator or mixin.
- Per-request DB queries that most requests don't need (every request pays). Make them lazy (`SimpleLazyObject`) or move them into views.
- Authentication for token APIs — DRF authentication classes run in the view; duplicating it in middleware causes double work and inconsistencies.
- Heavy work (calling external APIs) — that's latency on every request; consider the edge or async.

## 7. Common Mistakes & Best Practices

**1. Wrong order.** `AuthenticationMiddleware` above `SessionMiddleware` raises an `ImproperlyConfigured`-style assertion ("requires session middleware"). Custom middleware reading `request.user` placed above `AuthenticationMiddleware` gets `AttributeError`. *Instead:* put custom middleware that needs user/session **below** them.

**2. Per-request state on `self`.**

```python
# Before: shared across threads and requests — data leak / race
class Bad:
    def __init__(self, get_response):
        self.get_response = get_response
    def __call__(self, request):
        self.user = request.user              # another thread overwrites this
        return self.get_response(request)

# After: per-request data lives on the request (or a contextvar)
class Good:
    def __init__(self, get_response):
        self.get_response = get_response
    def __call__(self, request):
        request.audit_actor = getattr(request, "user", None)
        return self.get_response(request)
```

**3. Forgetting to return the response** (or returning `None` from `process_template_response`). Django raises `ValueError: ... didn't return an HttpResponse object`.

**4. Eagerly evaluating `request.user`** in a middleware for every request (e.g. for logging) — it triggers session + user queries even for static/health endpoints. *Instead:* read it lazily only when needed, or log in a later stage.

**5. Reading `request.body` in middleware.** It consumes the stream; later `request.POST` or file upload parsing may fail, and large bodies get loaded into memory. *Instead:* avoid, or cap with `DATA_UPLOAD_MAX_MEMORY_SIZE` and only for specific paths.

**6. Expecting `process_exception` to catch everything.** It won't see exceptions from middleware or from `StreamingHttpResponse` iteration. *Instead:* use Sentry's integration and `got_request_exception` signal for reporting.

**7. Sync middleware in an ASGI app.** Every sync layer forces a `sync_to_async` hop per request. *Instead:* make custom middleware `sync_and_async_middleware`; check the `django.request` debug log for "Asynchronous handler adapted for middleware ..." messages.

**Best practices:** keep middleware tiny and fast; make expensive work lazy; set `MiddlewareNotUsed` when disabled; document the ordering assumptions in a comment beside `MIDDLEWARE`; unit test with `RequestFactory`.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: `request.user` is AnonymousUser for JWT/Token API calls inside your middleware.** Root cause: `AuthenticationMiddleware` authenticates via the **session** only; DRF authenticates in `APIView.initial()`, i.e. inside the view, after middleware ran. Fix: don't rely on `request.user` in middleware for API audit; do it in a DRF authentication class, permission, or after the view in the response phase (DRF sets `request.user` on the underlying `HttpRequest` once authenticated — but only after view execution starts).

**Pitfall: all requests suddenly 400.** After a deploy, `CommonMiddleware`/`get_host()` raises `DisallowedHost` because the load balancer's health checks use the pod IP as Host. Fix: add health-check host to `ALLOWED_HOSTS`, or answer health checks in a middleware placed **above** `SecurityMiddleware`/`CommonMiddleware` that short-circuits `/healthz` without calling `get_host()`.

**Pitfall: per-site cache serving one user's page to another.** `UpdateCacheMiddleware`/`FetchFromCacheMiddleware` in the wrong positions bypass `Vary: Cookie` set by `SessionMiddleware`. Fix: Update first, Fetch last, exactly as documented (see [Ch 29](topic.html?p=29-caching)).

**Pitfall: latency regression after adding middleware.** A "feature flag" middleware calls Redis on every request including static and health checks: +3 ms p50, more at p99. Fix: cache in-process with a short TTL, skip paths early, or move to views.

**Pitfall: memory/time leak from contextvars or thread-locals not reset.** A thread-local "current user" survives into the next request on the same thread. Fix: always reset in `finally`, prefer contextvars with tokens.

**Debugging:**

- `from django.conf import settings; print(settings.MIDDLEWARE)` — and remember third-party packages may document their required position.
- Add a temporary logging middleware at different positions to see what each layer sees (`request.user`, headers).
- `django.request` logger at DEBUG prints middleware sync/async adaptation messages.
- Sentry and APM tools (OpenTelemetry Django instrumentation) show middleware spans so you can measure each layer's cost.

**Scaling notes:** middleware cost is multiplied by every request, including static files if Django serves them. Keep the hot path allocation-free and query-free; put expensive cross-cutting logic at the edge (Nginx, CDN, API gateway) when it doesn't need Django state. Under ASGI, a fully async middleware stack avoids thread pool contention.

## 9. Interview Questions

**Q: What is middleware in Django and how does it work?**
A: Middleware is a framework of hooks that wraps the view: each middleware is a callable built with the next layer (`get_response`) and called per request. Django builds the chain once at startup in `BaseHandler.load_middleware()` by iterating `MIDDLEWARE` in reverse, so the first entry becomes the outermost layer. Code before `get_response(request)` runs in the request phase top→bottom; code after runs in the response phase bottom→top. Any layer can short-circuit by returning a response itself.

**Q: In what order do middleware run for the request and response?**
A: Request phase follows the `MIDDLEWARE` list top to bottom, then `process_view` hooks top to bottom, then the view. Response phase runs bottom to top, as does `process_exception` and `process_template_response`. If a middleware returns early, only the layers above it see the response. This symmetric nesting is why `UpdateCacheMiddleware` goes first (its response phase runs last) and `FetchFromCacheMiddleware` goes last.

**Q: Why must `AuthenticationMiddleware` come after `SessionMiddleware`?**
A: `AuthenticationMiddleware` sets `request.user` to a lazy object that reads the user ID from `request.session`. `request.session` is created by `SessionMiddleware`, so it must have run already; otherwise Django raises an error telling you to insert the session middleware before it. Similarly, `MessageMiddleware` with session storage depends on sessions, and any custom middleware using `request.user` must be placed below `AuthenticationMiddleware`.

**Q: How do you write a custom middleware?**
A: Write a class with `__init__(self, get_response)` storing `get_response`, and `__call__(self, request)` that does request-phase work, calls `response = self.get_response(request)`, does response-phase work and returns the response. Optionally add `process_view`, `process_exception` and `process_template_response` methods. Add its dotted path to `MIDDLEWARE` at the right position. A function-based factory returning an inner `middleware(request)` closure works equally well.

**Q: What are `process_view`, `process_exception` and `process_template_response` for?**
A: `process_view(request, view_func, view_args, view_kwargs)` runs after URL resolution and before the view; it can inspect the target view (e.g. attributes from decorators) and return a response to skip it — CSRF checking lives here. `process_exception(request, exception)` runs if the view raises; returning a response handles it, `None` defers to the next hook and finally Django's default handling. `process_template_response` runs for responses with a `render()` method and can alter `context_data` or `template_name` before rendering; it must return a response.

**Q: What happens when a middleware returns a response before calling `get_response`?**
A: The chain short-circuits: inner middleware, `process_view` hooks and the view never run. The returned response travels back out through the response phase of the middlewares *above* it only. Examples: `SecurityMiddleware` returning an HTTPS redirect, `CommonMiddleware` returning an `APPEND_SLASH` redirect, WhiteNoise returning a static file, `FetchFromCacheMiddleware` returning a cached page.

**Q: Is a middleware instance shared between requests?**
A: Yes. `__init__` runs once per process when the handler loads, and the same instance's `__call__` is invoked for every request, potentially concurrently in threaded workers. Therefore never store per-request data on `self`; attach it to `request` or use a `contextvars.ContextVar`. Expensive one-time setup (compiling regexes, reading settings) belongs in `__init__`, and raising `MiddlewareNotUsed` there removes the middleware entirely.

**Q: Why is `request.user` anonymous in my middleware when the API uses JWT?**
A: Django's `AuthenticationMiddleware` only knows session authentication. DRF authentication (JWT, Token) runs lazily inside the view — `APIView.initial()` → `perform_authentication()` — after all middleware request phases have run. So in middleware the user is anonymous (or unauthenticated) for token requests. Do per-user logic in DRF authentication/permission classes, or in the middleware's response phase after the view has authenticated, accepting that coupling.

**Q: Does `process_exception` catch exceptions raised inside other middleware?**
A: No. It only handles exceptions raised by the view (and while rendering a `TemplateResponse`). Each middleware layer is wrapped by `convert_exception_to_response`, so an exception in a middleware becomes an error response (500, or 404/403/400 for the respective exceptions) at that layer, and outer middleware receive a response, not an exception. That's why error reporting should rely on `got_request_exception`/logging/Sentry rather than a custom `process_exception`.

**Q: How do you make middleware work efficiently under ASGI? (Senior)**
A: Mark it as supporting both modes with `@sync_and_async_middleware` (or `sync_capable`/`async_capable` flags) and branch on `iscoroutinefunction(get_response)`, returning an `async def` middleware in async mode; for class-based async middleware call `markcoroutinefunction(self)`. If any middleware in the chain is sync-only, Django adapts with `sync_to_async`/`async_to_sync` at that boundary, costing a thread hop per request and serializing through the thread-sensitive executor. Use `contextvars` instead of thread-locals, and run blocking calls through `sync_to_async`. Enable DEBUG logging on `django.request` to confirm no adaptation happens.

**Q: Design request-scoped context (request ID, tenant, user) available in logs everywhere. (Senior)**
A: An outermost middleware generates or validates an incoming request ID, sets a `ContextVar` with a token, and resets it in `finally`; a tenant middleware does the same after resolving the host; a `logging.Filter` copies contextvars onto every record, and the JSON formatter emits them. The request ID is returned in a response header and propagated to Celery tasks via headers and to downstream HTTP calls. Contextvars work across sync, async and threads spawned via `asgiref`, unlike thread-locals. OpenTelemetry instrumentation can replace parts of this with trace IDs.

**Q: After adding a middleware, p99 latency doubled. How do you investigate? (Senior)**
A: Measure first: APM spans or a temporary timing middleware placed above and below the suspect to isolate its cost. Typical culprits are a DB/cache call per request, eager evaluation of `request.user`/session (triggering queries on static/health paths), reading `request.body`, or a sync middleware forcing thread hops under ASGI. Fix by skipping irrelevant paths early, making work lazy, caching in-process with a short TTL, or moving the concern into views or the edge. Verify with a load test comparing before/after percentiles.

**Q: How does `CsrfViewMiddleware` use the hooks?**
A: In its request phase it ensures a CSRF secret is available; the actual check happens in `process_view`, because it needs the resolved view to honour `@csrf_exempt` (an attribute on the view function). Safe methods pass; for POST/PUT/PATCH/DELETE it validates the masked token from the form field or `X-CSRFToken` header against the cookie or session, and for HTTPS checks `Origin`/`Referer` against trusted origins. In the response phase it sets or rotates the `csrftoken` cookie when used. Details in [Ch 28](topic.html?p=28-security).

## 10. Quick Revision & Cheat Sheet

| Hook | When | Order | Return |
|---|---|---|---|
| `__init__(get_response)` | Once per process | — | raise `MiddlewareNotUsed` to disable |
| `__call__` pre | Each request | top→bottom | response to short-circuit |
| `process_view` | After URL resolve, before view | top→bottom | `None` or response |
| `process_exception` | View raised | bottom→top | `None` or response |
| `process_template_response` | Response has `render()` | bottom→top | response (required) |
| `__call__` post | Each response | bottom→top | response (required) |

- First in `MIDDLEWARE` = outermost; built by `load_middleware()` iterating reversed.
- Security → (WhiteNoise) → Session → Common → Csrf → Auth → Messages → XFrame.
- Cache: `UpdateCacheMiddleware` first, `FetchFromCacheMiddleware` last.
- Short-circuit: only outer layers see the response.
- One instance per process: no per-request state on `self`; use `request` or contextvars.
- `process_exception` sees view exceptions only.
- DRF auth happens in the view, not middleware.
- Async: `sync_and_async_middleware`, `markcoroutinefunction`; avoid sync layers under ASGI.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2"`, start a project with one app and two views.

1. **Trace the onion.** Write middleware `A`, `B`, `C` that print on pre, post and every hook. Request a normal view, a view that raises, and a `TemplateResponse` view; write down the printed order and compare with §4.1.
2. **Short-circuit.** Make `B` return 403 for `/blocked/`. Observe which prints disappear.
3. **Request ID + JSON logs.** Implement §5.1 plus a contextvar and a logging filter; confirm logs from a service function carry the ID.
4. **Exception mapping.** Map a custom `RateLimited` exception to a 429 JSON response with `process_exception`, and prove that raising it inside a middleware yields a 500 instead.
5. **Async.** Run under `uvicorn` with a sync middleware, enable `django.request` DEBUG logging and find the adaptation message; convert the middleware to `sync_and_async_middleware` and confirm it disappears.

**Mini project — "Edge kit":** a package with request-ID, tenant-by-host, maintenance-mode (`process_view` with an exempt decorator) and health-check short-circuit middleware, all async-capable, with unit tests using `RequestFactory` and a documented recommended position in `MIDDLEWARE`.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 01 · Architecture & Request Lifecycle](topic.html?p=01-architecture-request-lifecycle) · [Ch 19 · Signals](topic.html?p=19-signals) · [Ch 20 · Static & Media Files](topic.html?p=20-static-media-files) · [Ch 23 · DRF Authentication, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling) · [Ch 27 · Sessions, Cookies & Messages](topic.html?p=27-sessions-cookies) · [Ch 28 · Security](topic.html?p=28-security) · [Ch 29 · Caching](topic.html?p=29-caching) · [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi) · [Ch 36 · Django Internals](topic.html?p=36-django-internals)

**Other handbooks:** [REST API · Observability, Logging & Tracing](../rest-api/topic.html?p=38-observability-logging-tracing) · [REST API · TLS, CORS & Security Headers](../rest-api/topic.html?p=22-tls-cors-security-headers) · [System Design · Proxies & Gateway](../system-design/topic.html?p=10-proxies-gateway)

**Free resources:**
- **Middleware (topic guide)** — Django docs · *Intermediate* · writing middleware, hooks, async support. <https://docs.djangoproject.com/en/5.2/topics/http/middleware/>
- **Middleware reference and ordering** — Django docs · *Intermediate* · every built-in middleware and the recommended order. <https://docs.djangoproject.com/en/5.2/ref/middleware/>
- **Asynchronous support** — Django docs · *Advanced* · how sync/async adaptation works and its cost. <https://docs.djangoproject.com/en/5.2/topics/async/>
- **Django source: django/core/handlers/base.py** — GitHub · *Advanced* · read `load_middleware` and `_get_response` yourself. <https://github.com/django/django/blob/main/django/core/handlers/base.py>
- **contextvars** — Python docs · *Intermediate* · the right primitive for request-scoped state. <https://docs.python.org/3/library/contextvars.html>
- **WhiteNoise documentation** — whitenoise.readthedocs.io · *Beginner* · a canonical example of a short-circuiting middleware. <https://whitenoise.readthedocs.io/>

---

*Django Handbook — chapter 18.*
