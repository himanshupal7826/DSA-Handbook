# 01 · Django Architecture & the Request/Response Lifecycle

> **In one line:** Django is a stack of small, well-defined layers — server gateway, handler, middleware onion, URL resolver, view, ORM and template engine — and if you can trace one HTTP request through every layer and back, you can debug almost anything Django does in production and answer the most common opening question in a Django interview.

---

## 1. Overview

Every Django interview, at every level, opens with some version of the same question: *"What happens when a request hits a Django application?"* Junior candidates answer "the URL goes to a view, the view returns a template." Senior candidates answer with the gateway interface, the handler class, the order in which middleware runs, what happens when no URL matches, where exceptions become responses, and when the database connection is closed. The difference between those two answers is the difference between someone who has *used* Django and someone who can *operate* it.

The problem Django solves is old and unglamorous. A web application has to parse raw HTTP, decide which code should handle each URL, protect itself against forged requests, talk to a database without SQL injection, render HTML safely, manage sessions and authentication, and do all of that the same way in every endpoint. The **naive approach** — one big script that reads `environ`, branches on the path with `if/elif`, builds SQL with string formatting and concatenates HTML — fails fast. Cross-cutting concerns (auth, CSRF, compression, logging) get copy-pasted into every branch, one forgotten check becomes a security hole, and nobody can find where a header was set. Frameworks exist to put each concern in exactly one place.

Django's answer is **"batteries included"**: a single, coherent framework that ships with an ORM, migrations, a template engine, forms, an admin, authentication, sessions, caching, security middleware and a test runner, all designed to work together. Its architecture is usually described as **MTV (Model–Template–View)**, sometimes written MVT. The moving parts are:

- a **gateway interface** (WSGI or ASGI) that turns bytes from the web server into a Python call,
- a **handler** (`WSGIHandler` / `ASGIHandler`, both subclasses of `BaseHandler`) that builds a request object and runs it through
- a **middleware chain** — an onion of wrappers around the view,
- a **URL resolver** that maps the path to a view function,
- the **view**, your code, which typically uses
- the **ORM** to read and write models and
- the **template engine** to render a response,
- and then the response travels back out through the middleware and the gateway.

This chapter is the map for the whole handbook. Each layer gets its own chapter later; here you learn how they fit together and what really happens inside `BaseHandler`.

> **Why this matters:** most production incidents in Django — a missing header, a 500 that should be a 404, a request that holds a database connection too long, a middleware that silently swallows an exception — are easiest to diagnose once you know exactly which layer of the lifecycle owns the behaviour.

## 2. Core Concepts

- **MTV / MVT** — Django's naming of the classic MVC split. The **Model** is the data layer (ORM classes); the **Template** is presentation (what MVC calls the *view*); the **View** is the request-handling logic (what MVC calls the *controller*). The URLconf plus the framework itself act as the dispatcher. *Why it matters:* interviewers love the "MVC vs MVT" question, and the honest answer is "same idea, different names, with the framework acting as the front controller."
- **WSGI** — the synchronous Python gateway standard (PEP 3333): the server calls `application(environ, start_response)` once per request. Django's entry point is `django.core.handlers.wsgi.WSGIHandler`, exposed as `application` in your project's `wsgi.py`. *Why it matters:* Gunicorn, uWSGI and mod_wsgi all speak WSGI; one request occupies one worker thread for its full duration.
- **ASGI** — the asynchronous successor: `await application(scope, receive, send)`. Django's entry point is `django.core.handlers.asgi.ASGIHandler` in `asgi.py`. *Why it matters:* needed for async views, WebSockets (via Channels) and long-lived connections; served by Uvicorn, Daphne or Hypercorn.
- **`BaseHandler`** — the shared core of both handlers. It builds the middleware chain once at startup (`load_middleware`) and processes each request in `get_response` / `get_response_async`. *Why it matters:* this is "the request lifecycle" in code.
- **`HttpRequest`** — the object your view receives (`WSGIRequest` or `ASGIRequest`): method, path, headers in `META`, `GET`, `POST`, `FILES`, `COOKIES`, plus attributes added by middleware such as `user` and `session`.
- **`HttpResponse`** — what every view must return (or an exception it raises). Middleware can inspect and modify it on the way out.
- **Middleware** — callables that wrap the view: code before `get_response(request)` runs on the way in, code after runs on the way out. Ordered by the `MIDDLEWARE` setting. *Why it matters:* order is semantics; `AuthenticationMiddleware` needs the session that `SessionMiddleware` loads.
- **URLconf / resolver** — the module named by `ROOT_URLCONF`, containing `urlpatterns`. `URLResolver.resolve(path)` returns a `ResolverMatch` (view function, args, kwargs, url name, namespaces).
- **ORM** — Django's object-relational mapper: models, managers and lazy QuerySets that compile to parameterized SQL.
- **Template engine** — the Django Template Language (DTL) or Jinja2, configured in `TEMPLATES`, with autoescaping on by default.
- **Signals in the lifecycle** — `request_started`, `request_finished` and `got_request_exception`. Django itself connects `close_old_connections` to `request_started` and `request_finished`, which is how per-request database connection management works.
- **Batteries included** — the contrib apps (`admin`, `auth`, `contenttypes`, `sessions`, `messages`, `staticfiles`) and built-ins that cover what most web apps need. *Why it matters:* faster delivery and a consistent security baseline, at the cost of some flexibility.

## 3. Theory & Principles

### 3.1 From socket to Python call

Django never touches a socket. A web server or application server (Gunicorn, Uvicorn, uWSGI) accepts the TCP connection, parses the HTTP request, and calls your **application object**. With WSGI that object is created in `wsgi.py`:

```python
# mysite/wsgi.py
import os
from django.core.wsgi import get_wsgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "mysite.settings")
application = get_wsgi_application()
```

`get_wsgi_application()` does two things: it calls `django.setup()` (configure logging, populate the app registry — import every app's `AppConfig`, then its models, then call each `ready()`), and it returns a `WSGIHandler()` instance. Creating the handler calls `load_middleware()`, which builds the middleware chain **once per process**. That is why a syntax error in a middleware crashes the worker at boot rather than on the first request, and why middleware `__init__` is a good place for one-time configuration.

### 3.2 What `WSGIHandler.__call__` does

For each request the server calls `handler(environ, start_response)`. Simplified from Django 5.2's source, the handler:

1. calls `set_script_prefix(get_script_name(environ))` so `reverse()` produces correct URLs when the site is mounted under a sub-path;
2. sends the **`request_started`** signal (Django's own receiver closes database connections that have exceeded `CONN_MAX_AGE` or are unusable);
3. builds `request = WSGIRequest(environ)` — headers are lazily parsed, `GET`/`POST`/`FILES`/`COOKIES` are computed on first access;
4. calls `response = self.get_response(request)`;
5. calls `start_response(status, headers)` and returns the response (an iterable of bytes) to the server;
6. when the server finishes sending and calls `response.close()`, Django sends **`request_finished`**, which again runs `close_old_connections` and closes any file objects.

### 3.3 `BaseHandler.get_response` and the middleware chain

`get_response(request)` sets the URLconf for the thread (`set_urlconf(settings.ROOT_URLCONF)`), calls `self._middleware_chain(request)`, and logs any 4xx/5xx response through the `django.request` logger. The chain itself is constructed by `load_middleware()`:

```python
# Simplified from django/core/handlers/base.py
def load_middleware(self, is_async=False):
    get_response = self._get_response_async if is_async else self._get_response
    handler = convert_exception_to_response(get_response)
    for middleware_path in reversed(settings.MIDDLEWARE):
        middleware = import_string(middleware_path)
        mw_instance = middleware(handler)            # new-style: __init__(get_response)
        if hasattr(mw_instance, "process_view"):
            self._view_middleware.insert(0, mw_instance.process_view)
        if hasattr(mw_instance, "process_template_response"):
            self._template_response_middleware.append(mw_instance.process_template_response)
        if hasattr(mw_instance, "process_exception"):
            self._exception_middleware.append(mw_instance.process_exception)
        handler = convert_exception_to_response(mw_instance)
    self._middleware_chain = handler
```

Read that loop carefully, because it explains the **onion**. It iterates `MIDDLEWARE` **in reverse**, wrapping each middleware around the previous handler. So the *first* entry in `MIDDLEWARE` ends up as the *outermost* layer: it sees the request first and the response last. Every layer is wrapped in `convert_exception_to_response`, which means an exception raised anywhere inside is converted to an HTTP response right there, so the outer middleware always receives a response object, never a raw exception.

### 3.4 `_get_response`: resolve, process_view, call the view

The innermost callable is `_get_response(request)`:

1. **Resolve the URL.** `resolve_request()` uses `request.urlconf` if a middleware set one, otherwise `ROOT_URLCONF`, calls `get_resolver(urlconf).resolve(request.path_info)`, and stores the `ResolverMatch` on `request.resolver_match`. Patterns are tried **in order; the first match wins**. No match raises `Resolver404` (a subclass of `Http404`).
2. **Run `process_view` hooks** in `MIDDLEWARE` order with `(request, view_func, view_args, view_kwargs)`. If one returns a response, the view is skipped. This is how `CsrfViewMiddleware` checks the token *after* it knows which view will run (so `@csrf_exempt` on the view can be honoured).
3. **Wrap in a transaction** if any database has `ATOMIC_REQUESTS=True` (`make_view_atomic`).
4. **Call the view** with `(request, *args, **kwargs)`.
5. **On exception**, run `process_exception` hooks (in reverse `MIDDLEWARE` order); the first one to return a response wins, otherwise the exception re-raises and `convert_exception_to_response` handles it.
6. **Check the response.** If the view returned `None`, Django raises `ValueError: The view ... didn't return an HttpResponse object. It returned None instead.`
7. **Deferred rendering.** If the response has a `render()` method (a `TemplateResponse`), the `process_template_response` hooks run, then `response.render()` is called.

### 3.5 Exceptions become responses

`convert_exception_to_response` calls `response_for_exception`, which maps:

| Exception | Response |
|---|---|
| `Http404` (incl. `Resolver404`) | 404 — `technical_404_response` when `DEBUG=True`, otherwise `handler404` |
| `PermissionDenied` | 403 via `handler403` |
| `BadRequest`, `SuspiciousOperation`, `MultiPartParserError` | 400 via `handler400` (suspicious ops are also logged to `django.security.*`) |
| anything else | 500 — sends `got_request_exception`, then `technical_500_response` (DEBUG) or `handler500` |

The diagram below puts the whole path on one page.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj01a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj01b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">One request through Django (WSGI path)</text>
  <rect x="20" y="50" width="110" height="60" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="75" y="75" text-anchor="middle" fill="#1e293b" font-weight="bold">Client</text>
  <text x="75" y="92" text-anchor="middle" fill="#334155" font-size="9">GET /orders/42/</text>
  <rect x="160" y="50" width="130" height="60" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="225" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">Nginx + Gunicorn</text>
  <text x="225" y="88" text-anchor="middle" fill="#334155" font-size="9">parse HTTP, pick worker</text>
  <text x="225" y="101" text-anchor="middle" fill="#334155" font-size="9">application(environ, sr)</text>
  <rect x="320" y="50" width="160" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="400" y="70" text-anchor="middle" fill="#1e293b" font-weight="bold">WSGIHandler.__call__</text>
  <text x="400" y="86" text-anchor="middle" fill="#334155" font-size="9">request_started signal</text>
  <text x="400" y="100" text-anchor="middle" fill="#334155" font-size="9">WSGIRequest(environ)</text>
  <rect x="510" y="50" width="160" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="590" y="70" text-anchor="middle" fill="#1e293b" font-weight="bold">BaseHandler.get_response</text>
  <text x="590" y="86" text-anchor="middle" fill="#334155" font-size="9">set_urlconf(ROOT_URLCONF)</text>
  <text x="590" y="100" text-anchor="middle" fill="#334155" font-size="9">_middleware_chain(request)</text>
  <path d="M130,80 L156,80" stroke="#2563eb" stroke-width="2" marker-end="url(#dj01a)"/>
  <path d="M290,80 L316,80" stroke="#2563eb" stroke-width="2" marker-end="url(#dj01a)"/>
  <path d="M480,80 L506,80" stroke="#2563eb" stroke-width="2" marker-end="url(#dj01a)"/>
  <rect x="510" y="140" width="350" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="685" y="160" text-anchor="middle" fill="#1e293b" font-weight="bold">Middleware (request phase, top to bottom)</text>
  <text x="685" y="178" text-anchor="middle" fill="#334155" font-size="9">Security, Session, Common, Csrf, Authentication, Message, XFrame</text>
  <text x="685" y="194" text-anchor="middle" fill="#334155" font-size="9">any layer may return a response and short-circuit</text>
  <path d="M590,110 L590,136" stroke="#2563eb" stroke-width="2" marker-end="url(#dj01a)"/>
  <rect x="510" y="240" width="350" height="66" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="685" y="260" text-anchor="middle" fill="#1e293b" font-weight="bold">_get_response</text>
  <text x="685" y="277" text-anchor="middle" fill="#334155" font-size="9">resolve(path_info) to ResolverMatch, 404 if none</text>
  <text x="685" y="292" text-anchor="middle" fill="#334155" font-size="9">process_view hooks, ATOMIC_REQUESTS wrap, call view</text>
  <path d="M685,210 L685,236" stroke="#2563eb" stroke-width="2" marker-end="url(#dj01a)"/>
  <rect x="510" y="336" width="160" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="590" y="358" text-anchor="middle" fill="#1e293b" font-weight="bold">View (your code)</text>
  <text x="590" y="375" text-anchor="middle" fill="#334155" font-size="9">Order.objects.get(pk=42)</text>
  <text x="590" y="390" text-anchor="middle" fill="#334155" font-size="9">render(request, tpl, ctx)</text>
  <rect x="700" y="336" width="160" height="70" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="780" y="358" text-anchor="middle" fill="#1e293b" font-weight="bold">ORM + Templates</text>
  <text x="780" y="375" text-anchor="middle" fill="#334155" font-size="9">SQL to PostgreSQL</text>
  <text x="780" y="390" text-anchor="middle" fill="#334155" font-size="9">DTL render, autoescape</text>
  <path d="M685,306 L620,332" stroke="#2563eb" stroke-width="2" marker-end="url(#dj01a)"/>
  <path d="M670,371 L696,371" stroke="#2563eb" stroke-width="2" marker-end="url(#dj01a)"/>
  <rect x="20" y="240" width="460" height="166" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="250" y="262" text-anchor="middle" fill="#1e293b" font-weight="bold">Response path (bottom to top)</text>
  <text x="40" y="284" fill="#334155" font-size="10">1. View returns HttpResponse (None raises ValueError)</text>
  <text x="40" y="304" fill="#334155" font-size="10">2. TemplateResponse: process_template_response, then render()</text>
  <text x="40" y="324" fill="#334155" font-size="10">3. Middleware response phase runs in REVERSE order</text>
  <text x="40" y="344" fill="#334155" font-size="10">4. Exceptions at any layer become 404/403/400/500 responses</text>
  <text x="40" y="364" fill="#334155" font-size="10">5. start_response(status, headers), body iterable to server</text>
  <text x="40" y="384" fill="#334155" font-size="10">6. close(): request_finished signal, close_old_connections</text>
  <path d="M506,371 L484,371" stroke="#16a34a" stroke-width="2" marker-end="url(#dj01b)"/>
</svg>
```

### 3.6 Why MTV and not MVC?

In classic MVC the *controller* receives input and picks a *view* to render the *model*. In Django the framework itself is the front controller (handler + URLconf), your **view function** is the request-specific controller logic, and the **template** is the presentation. Django's FAQ states it plainly: what MVC calls a "view" is a Django template, and what MVC calls a "controller" is the framework plus the view function. The names are different; the separation of concerns is the same. In an API-only project (DRF), the "template" is replaced by a serializer and a renderer, which is why people say Django REST projects are "MV + serializer".

### 3.7 ASGI: the same core, a different front door

`ASGIHandler.__call__(scope, receive, send)` is a coroutine. For an `http` scope it reads the request body from `receive()` into a spooled temporary file, builds an `ASGIRequest`, awaits `get_response_async`, and streams the response back with `send()` messages (`http.response.start`, then one or more `http.response.body`). The middleware chain is built in async mode; sync-only middleware and sync views are adapted with `sync_to_async` (thread-sensitive by default), and async middleware under WSGI is adapted with `async_to_sync`. Each adaptation costs a thread hop, so a mixed stack under ASGI is slower than a pure one. The details belong in [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi).

## 4. Architecture & Workflow

### 4.1 The middleware onion

New-style middleware (since Django 1.10) is a callable factory. Everything before `self.get_response(request)` is the request phase; everything after is the response phase:

```python
class TimingMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response      # the next layer inward; runs once per process

    def __call__(self, request):
        start = time.perf_counter()           # request phase (outer to inner)
        response = self.get_response(request)
        response["Server-Timing"] = f"app;dur={(time.perf_counter() - start) * 1000:.1f}"
        return response                       # response phase (inner to outer)
```

Because layers wrap each other, the recommended order in Django's own `startproject` template is meaningful:

```python
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",          # HTTPS redirect, HSTS, nosniff: first
    "django.contrib.sessions.middleware.SessionMiddleware",   # loads request.session
    "django.middleware.common.CommonMiddleware",              # APPEND_SLASH, DISALLOWED_USER_AGENTS
    "django.middleware.csrf.CsrfViewMiddleware",              # process_view token check
    "django.contrib.auth.middleware.AuthenticationMiddleware",# request.user (needs session)
    "django.contrib.messages.middleware.MessageMiddleware",   # needs session
    "django.middleware.clickjacking.XFrameOptionsMiddleware", # X-Frame-Options: DENY
]
```

The next diagram shows the onion, and what a short-circuit looks like.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj01c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj01d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="dj01e" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">The middleware onion: first in MIDDLEWARE = outermost layer</text>
  <rect x="20" y="40" width="560" height="340" rx="14" fill="#fef3c7" stroke="#d97706"/>
  <text x="300" y="58" text-anchor="middle" fill="#1e293b" font-weight="bold">SecurityMiddleware</text>
  <rect x="50" y="68" width="500" height="300" rx="14" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="300" y="86" text-anchor="middle" fill="#1e293b" font-weight="bold">SessionMiddleware</text>
  <rect x="80" y="96" width="440" height="260" rx="14" fill="#dbeafe" stroke="#2563eb"/>
  <text x="300" y="114" text-anchor="middle" fill="#1e293b" font-weight="bold">CommonMiddleware</text>
  <rect x="110" y="124" width="380" height="220" rx="14" fill="#fee2e2" stroke="#dc2626"/>
  <text x="300" y="142" text-anchor="middle" fill="#1e293b" font-weight="bold">CsrfViewMiddleware</text>
  <rect x="140" y="152" width="320" height="180" rx="14" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="300" y="170" text-anchor="middle" fill="#1e293b" font-weight="bold">AuthenticationMiddleware</text>
  <rect x="200" y="200" width="200" height="90" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="300" y="228" text-anchor="middle" fill="#1e293b" font-weight="bold">URL resolve + view</text>
  <text x="300" y="246" text-anchor="middle" fill="#334155" font-size="9">_get_response</text>
  <text x="300" y="262" text-anchor="middle" fill="#334155" font-size="9">process_view hooks run here</text>
  <path d="M160,190 L196,220" stroke="#2563eb" stroke-width="2" marker-end="url(#dj01c)"/>
  <text x="150" y="186" text-anchor="middle" fill="#2563eb" font-size="9">request in</text>
  <path d="M404,270 L444,300" stroke="#16a34a" stroke-width="2" marker-end="url(#dj01d)"/>
  <text x="440" y="318" text-anchor="middle" fill="#16a34a" font-size="9">response out</text>
  <rect x="610" y="40" width="250" height="150" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="735" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Normal flow</text>
  <text x="625" y="84" fill="#334155" font-size="10">Request: Security, Session, Common,</text>
  <text x="625" y="100" fill="#334155" font-size="10">Csrf, Auth ... then the view</text>
  <text x="625" y="122" fill="#334155" font-size="10">Response: ... Auth, Csrf, Common,</text>
  <text x="625" y="138" fill="#334155" font-size="10">Session (saves cookie), Security</text>
  <text x="625" y="164" fill="#334155" font-size="10">Session must wrap Auth: request.user</text>
  <text x="625" y="180" fill="#334155" font-size="10">is read from request.session</text>
  <rect x="610" y="210" width="250" height="170" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="735" y="232" text-anchor="middle" fill="#1e293b" font-weight="bold">Short-circuit</text>
  <text x="625" y="254" fill="#334155" font-size="10">CommonMiddleware with PREPEND_WWW</text>
  <text x="625" y="270" fill="#334155" font-size="10">sees example.com/orders/ and</text>
  <text x="625" y="286" fill="#334155" font-size="10">returns a 301 to www. itself.</text>
  <text x="625" y="310" fill="#334155" font-size="10">Csrf, Auth and the view never run;</text>
  <text x="625" y="326" fill="#334155" font-size="10">Session and Security still see the</text>
  <text x="625" y="342" fill="#334155" font-size="10">response on the way out.</text>
  <path d="M520,110 L604,290" stroke="#dc2626" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#dj01e)"/>
</svg>
```

### 4.2 Sequence view

The same journey as a sequence, including the cleanup that happens after the bytes are sent:

```text
Client      Gunicorn     WSGIHandler      Middleware chain          Resolver/View        DB
  |  GET /orders/42/ |           |                 |                        |               |
  |----------------->|           |                 |                        |               |
  |                  | app(env)  |                 |                        |               |
  |                  |---------->| request_started |                        |               |
  |                  |           | WSGIRequest     |                        |               |
  |                  |           |---------------->| Security..Auth (in)    |               |
  |                  |           |                 |----------------------->| resolve()     |
  |                  |           |                 |                        | process_view  |
  |                  |           |                 |                        | view()------->| SELECT ...
  |                  |           |                 |                        |<--------------|
  |                  |           |                 |<-----------------------| HttpResponse  |
  |                  |           |<----------------| Auth..Security (out)   |               |
  |                  |<----------| start_response  |                        |               |
  |<-----------------| bytes     | close(): request_finished -> close_old_connections       |
```

### 4.3 Where each concern lives

| Concern | Layer | Chapter |
|---|---|---|
| Worker processes, timeouts, TLS termination | Gunicorn/Uvicorn + Nginx | [Ch 35 · Deployment](topic.html?p=35-deployment-production) |
| Settings, app registry, `ready()` | `django.setup()` | [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings) |
| HTTPS redirect, sessions, CSRF, `request.user` | Middleware | [Ch 18 · Middleware](topic.html?p=18-middleware) |
| Path to view mapping | URLconf | [Ch 03 · URL Routing](topic.html?p=03-urls-routing) |
| Business logic, status codes | Views | [Ch 04 · Views](topic.html?p=04-views-requests-responses) |
| Data access | ORM | [Ch 10 · QuerySets](topic.html?p=10-querysets-lookups) |
| HTML rendering | Templates | [Ch 05 · Templates](topic.html?p=05-templates) |

## 5. Implementation

### 5.1 Simple example: watch the lifecycle happen

Create a throwaway project and add a middleware that prints each phase.

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2"
django-admin startproject mysite .
python manage.py startapp shop
```

```python
# shop/views.py
from django.http import HttpResponse, Http404

def hello(request, name):
    print("  [view] running for", name)
    if name == "ghost":
        raise Http404("No such person")
    return HttpResponse(f"Hello, {name}!")
```

```python
# mysite/urls.py
from django.urls import path
from shop import views

urlpatterns = [
    path("hello/<str:name>/", views.hello, name="hello"),
]
```

```python
# shop/middleware.py
class TraceMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response
        print("[init] TraceMiddleware built once per process")

    def __call__(self, request):
        print(f"[in ] {request.method} {request.path}")
        response = self.get_response(request)
        print(f"[out] status={response.status_code}")
        return response

    def process_view(self, request, view_func, view_args, view_kwargs):
        print(f"  [process_view] {view_func.__name__} kwargs={view_kwargs}")
        return None   # continue to the view
```

Add `"shop.middleware.TraceMiddleware"` as the **last** entry of `MIDDLEWARE` and `"shop"` to `INSTALLED_APPS`, then run the server and hit three URLs.

```bash
python manage.py runserver
curl -s localhost:8000/hello/ada/
curl -s localhost:8000/hello/ghost/ -o /dev/null
curl -s localhost:8000/nope/ -o /dev/null
```

The console shows the order of the phases, and how a URL miss never reaches `process_view`.

```text
[init] TraceMiddleware built once per process
[in ] GET /hello/ada/
  [process_view] hello kwargs={'name': 'ada'}
  [view] running for ada
[out] status=200
[in ] GET /hello/ghost/
  [process_view] hello kwargs={'name': 'ghost'}
  [view] running for ghost
[out] status=404
[in ] GET /nope/
[out] status=404
```

Notice two things. First, the `Http404` raised in the view was converted into a response *before* it reached `TraceMiddleware`'s response phase — that is `convert_exception_to_response` at work. Second, for `/nope/` the resolver raised `Resolver404` before `process_view` ran, so the middleware saw only the request and the 404 response.

### 5.2 Real-world example: request ID, timing and structured logging

In production you want every log line from one request tied together, a latency number per endpoint, and the correlation ID returned to the client so support can find the logs. This is a classic interview "design a middleware" task.

```python
# core/middleware.py
import logging
import time
import uuid
from contextvars import ContextVar

request_id_var: ContextVar[str] = ContextVar("request_id", default="-")
logger = logging.getLogger("core.request")


class RequestIdFilter(logging.Filter):
    """Inject the current request id into every log record."""
    def filter(self, record):
        record.request_id = request_id_var.get()
        return True


class RequestContextMiddleware:
    header = "HTTP_X_REQUEST_ID"     # set by the load balancer if present

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        rid = request.META.get(self.header) or uuid.uuid4().hex
        token = request_id_var.set(rid)
        request.request_id = rid
        start = time.perf_counter()
        try:
            response = self.get_response(request)
        finally:
            request_id_var.reset(token)
        elapsed_ms = (time.perf_counter() - start) * 1000
        match = getattr(request, "resolver_match", None)
        logger.info(
            "request",
            extra={
                "method": request.method,
                "path": request.path,
                "route": match.route if match else None,
                "view": match.view_name if match else None,
                "status": response.status_code,
                "ms": round(elapsed_ms, 1),
            },
        )
        response["X-Request-ID"] = rid
        return response
```

Wire it in near the top of the stack so its timing includes the other middleware, and attach the filter to your log handler:

```python
# settings.py (excerpt)
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "core.middleware.RequestContextMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "filters": {"request_id": {"()": "core.middleware.RequestIdFilter"}},
    "formatters": {
        "plain": {"format": "%(asctime)s %(levelname)s [%(request_id)s] %(name)s %(message)s"},
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "filters": ["request_id"], "formatter": "plain"},
    },
    "root": {"handlers": ["console"], "level": "INFO"},
    "loggers": {"django.request": {"level": "WARNING"}},
}
```

Using `request.resolver_match.route` (for example `orders/<int:pk>/`) instead of `request.path` is what makes the metric useful: a dashboard grouped by route has a handful of rows, while one grouped by raw path has one row per order ID. A `ContextVar` rather than a thread-local is chosen deliberately so the same code works under ASGI, where many requests share one thread.

### 5.3 A tiny view touching every layer

```python
# shop/views.py
from django.shortcuts import get_object_or_404, render
from .models import Order

def order_detail(request, pk):
    order = get_object_or_404(
        Order.objects.select_related("customer"),   # one JOIN instead of two queries
        pk=pk, customer__user=request.user,          # request.user from AuthenticationMiddleware
    )
    return render(request, "shop/order_detail.html", {"order": order})
```

The ORM issues one parameterized query; nothing is interpolated into the SQL string:

```sql
SELECT "shop_order"."id", "shop_order"."customer_id", "shop_order"."total", ...,
       "shop_customer"."id", "shop_customer"."user_id", ...
FROM "shop_order"
INNER JOIN "shop_customer" ON ("shop_order"."customer_id" = "shop_customer"."id")
WHERE ("shop_order"."id" = %s AND "shop_customer"."user_id" = %s)
LIMIT 21
```

`LIMIT 21` is how `get()` detects `MultipleObjectsReturned` cheaply and still reports "more than 20" in the error message. The `render()` shortcut loads the template through the configured loaders, renders it with autoescaping, and wraps the result in an `HttpResponse`.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Django's choice | Benefit | Cost |
|---|---|---|---|
| Scope | Batteries included | Auth, admin, ORM, migrations, security in one coherent package | Heavier than micro-frameworks; opinions you must follow |
| Pattern | MTV with central dispatcher | Clear place for each concern | Business logic tends to bloat views/models without discipline |
| Cross-cutting code | Middleware onion | One place for auth, CSRF, headers, logging | Runs on *every* request; order mistakes are subtle |
| Concurrency | Sync-first, async optional | Simple mental model, mature libraries | Long I/O ties up a worker under WSGI |
| Data | Built-in ORM | Safe SQL, migrations, portability | Easy to write N+1 queries; complex SQL needs escape hatches |
| Errors | Exceptions mapped to responses | `raise Http404` anywhere | Swallowed exceptions in custom middleware hide bugs |

### When to use Django

- Database-backed products with users, permissions, an admin back office and forms — the sweet spot.
- APIs with DRF where you want auth, throttling, pagination and an ORM out of the box.
- Teams that value convention and security defaults over assembling libraries.

### When NOT to use Django

- A single tiny endpoint or a pure proxy where startup time and footprint dominate (a micro-framework or a function-as-a-service handler is lighter).
- Workloads that are almost entirely long-lived connections at very high fan-out with no relational data; Django Channels can do it, but a purpose-built async stack may be simpler.
- When you need a non-relational primary store and the ORM, admin and migrations would be unused weight.

## 7. Common Mistakes & Best Practices

**Mistake: thinking the URL resolver runs first.** People assume Django picks the view and then runs middleware. In fact the full request phase of every middleware's `__call__` runs *before* URL resolution; only `process_view` runs after it. Consequence: in `__call__` you cannot rely on `request.resolver_match` before calling `get_response`. Use `process_view` if you need the view.

**Mistake: wrong middleware order.** Placing `AuthenticationMiddleware` above `SessionMiddleware` raises `ImproperlyConfigured` ("The Django authentication middleware requires session middleware to be installed") on the first request, and `manage.py check` flags it for the admin. Note too that `APPEND_SLASH` works in `CommonMiddleware`'s *response* phase (it turns a 404 into a 301), so a middleware further out that replaces 404 responses will hide it. Start from the `startproject` order and insert your own middleware deliberately.

**Mistake: returning `None` from a view.** A missing `return` in one branch produces `ValueError: ... didn't return an HttpResponse object`. Make every branch return, and test the unhappy paths.

```python
# Before
def publish(request, pk):
    if request.method == "POST":
        ...
        return redirect("post-detail", pk=pk)
    # GET falls through: returns None -> 500

# After
from django.views.decorators.http import require_POST

@require_POST                               # GET now gets 405 Method Not Allowed
def publish(request, pk):
    ...
    return redirect("post-detail", pk=pk)
```

**Mistake: catching all exceptions in middleware.** A `try/except Exception: return HttpResponse(status=500)` around `get_response` hides tracebacks from Sentry and from `got_request_exception`. Let Django's exception handling run, or log with `logger.exception` and re-raise.

**Mistake: per-request work in middleware `__init__`, or per-process work in `__call__`.** `__init__` runs once per process; `__call__` runs per request. Compiling regexes or reading settings belongs in `__init__`; anything about the user belongs in `__call__`.

**Mistake: storing request state on the middleware instance.** One instance serves every request in the process (and every thread in it). `self.current_user = request.user` is a data leak between concurrent requests. Put state on `request` or in a `ContextVar`.

**Best practices**

- Keep views thin: parse input, call a service/model method, return a response.
- Raise `Http404`, `PermissionDenied`, `BadRequest` instead of hand-building error responses — they flow through the custom error handlers consistently.
- Know your gateway: WSGI for classic sync apps, ASGI only when you have async views or WebSockets that benefit.
- Use `request.resolver_match.route` for metrics, never raw paths.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: slow requests that are not slow in the view.** *Symptom:* p99 latency is high but view timing looks fine. *Root cause:* time spent in middleware (a session backed by a slow DB table, a middleware calling an external service), or in the response phase (`GZipMiddleware` on large bodies). *Fix:* put a timing middleware at the top and another just above the view; compare. Django Debug Toolbar's *Timer* and *SQL* panels show where time goes in development.

**Pitfall: worker timeouts under Gunicorn.** *Symptom:* `[CRITICAL] WORKER TIMEOUT` and 502s from Nginx. *Root cause:* a sync worker is blocked for longer than Gunicorn's `--timeout` (30 s default) — usually an external HTTP call without a timeout or a huge query. *Fix:* set timeouts on every outbound call, move slow work to Celery ([Ch 31](topic.html?p=31-celery-background-tasks)), add `statement_timeout` on PostgreSQL.

**Pitfall: database connections pile up.** *Symptom:* `FATAL: too many connections` on PostgreSQL. *Root cause:* each worker thread holds its own connection; with `CONN_MAX_AGE=None` connections persist forever, multiplied by workers × threads × pods. *Fix:* size the pool consciously, use Django 5.1+'s native psycopg pool or PgBouncer — see [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases).

**Pitfall: `DEBUG=True` in production.** *Symptom:* tracebacks with settings shown to users; every connection keeps a log of recent SQL queries (`connection.queries`), which costs memory and CPU on every request. *Fix:* `DEBUG=False`, set `ALLOWED_HOSTS`, and run `python manage.py check --deploy` in CI.

**Pitfall: 500 instead of 404 for missing objects.** `Order.objects.get(pk=pk)` raises `Order.DoesNotExist`, which is *not* an `Http404`, so users see a 500 and your error tracker fills up. Use `get_object_or_404`.

**Debugging toolkit**

- `django.db.connection.queries` (DEBUG only) and `len(connection.queries)` for query counts; `QuerySet.explain()` for plans.
- `python manage.py shell` + `from django.urls import resolve; resolve("/orders/42/")` to see which view a path maps to.
- Logging: the `django.request` logger records every 4xx/5xx with the request attached; `django.db.backends` at DEBUG logs every SQL statement.
- Sentry's Django integration hooks `got_request_exception` and adds request data and breadcrumbs.

**Scaling notes.** Django scales horizontally: the request lifecycle is stateless as long as sessions, cache and files live in shared services (database/Redis/S3). Capacity per instance is roughly *workers × threads* concurrent requests under WSGI; under ASGI one process can hold many idle connections but CPU-bound work still serializes on the event loop. The usual ladder: fix queries → cache → more workers/pods → read replicas → offload to tasks.

## 9. Interview Questions

**Q: What happens, step by step, when a request hits a Django application?**
A: The web server (Nginx) forwards to an application server such as Gunicorn, which calls Django's WSGI application, a `WSGIHandler`. The handler sends `request_started`, builds a `WSGIRequest` and calls `BaseHandler.get_response`, which runs the middleware chain. Each middleware's request phase runs top to bottom; the innermost `_get_response` resolves the URL against `ROOT_URLCONF` (first match wins, 404 otherwise), runs `process_view` hooks, and calls the view. The view uses the ORM and usually renders a template into an `HttpResponse`. The response then passes back through middleware in reverse order, the handler calls `start_response`, and when the server closes the response `request_finished` fires and stale DB connections are closed.

**Q: What is the difference between MVC and Django's MVT?**
A: They are the same separation of concerns with different names. Django's *model* is the MVC model; Django's *template* is what MVC calls the view (presentation); Django's *view* holds the request-handling logic MVC assigns to the controller. The framework itself — the handler plus the URLconf — is the front controller that dispatches requests. So "where is the controller in Django?" is answered by "the framework and the view function together."

**Q: What is the difference between WSGI and ASGI, and which does Django use?**
A: WSGI is a synchronous calling convention: one call per request, `application(environ, start_response)`, returning an iterable body, which ties up a worker thread for the whole request. ASGI is its async successor: `await application(scope, receive, send)`, supporting long-lived connections such as WebSockets and many concurrent requests per process. Django supports both through `WSGIHandler` and `ASGIHandler`, which share `BaseHandler`. Use WSGI for classic sync apps and ASGI when you have async views, streaming or WebSockets via Channels.

**Q: In which order does middleware run?**
A: On the request, in the order listed in `MIDDLEWARE` (top to bottom); on the response, in reverse (bottom to top). That follows from `load_middleware` wrapping the list in reverse, so the first entry is the outermost layer. `process_view` runs top to bottom just before the view, while `process_exception` and `process_template_response` run bottom to top. If a middleware returns a response without calling `get_response`, inner layers and the view are skipped but outer layers still process the response.

**Q: Why must `SessionMiddleware` come before `AuthenticationMiddleware`?**
A: `AuthenticationMiddleware` sets `request.user` lazily by reading the user ID stored in `request.session`. That attribute only exists after `SessionMiddleware` has run its request phase. If the order is reversed, Django's auth middleware fails its check that session middleware is installed, or `request.user` cannot be loaded. The same applies to `MessageMiddleware`, whose default storage falls back to the session.

**Q: How does Django turn an exception raised in a view into an HTTP response?**
A: Every layer of the middleware chain is wrapped by `convert_exception_to_response`. When an exception escapes, `response_for_exception` maps `Http404` to 404, `PermissionDenied` to 403, `BadRequest`/`SuspiciousOperation` to 400, and anything else to 500. With `DEBUG=True` you get the technical 404/500 pages; otherwise the `handler404`/`handler500` views (customizable in the root URLconf). For 500s Django also sends `got_request_exception` and logs to `django.request`, which is what Sentry hooks into. Before that, middleware `process_exception` hooks get a chance to return their own response.

**Q: What does "batteries included" mean, and what is the downside?**
A: Django ships the things most web apps need — ORM, migrations, auth, admin, sessions, forms, templates, caching, security middleware, test tooling — designed to work together and maintained on one release schedule. That gives fast delivery and a consistent security baseline. The downside is weight and opinion: you work within Django's patterns (its ORM, its project layout), swapping a component is harder than in a micro-framework, and unused pieces still cost startup time and memory.

**Q: What happens if a view returns `None`?**
A: After calling the view, `_get_response` checks the result and raises `ValueError` saying the view didn't return an `HttpResponse` object. It becomes a 500. The usual cause is a branch without a `return`, for example handling POST but forgetting GET. Decorators like `@require_POST` and making every branch return a response fix it.

**Q: When is the URL resolved relative to middleware, and why does it matter?**
A: The middleware request phases (`__call__` code before `get_response`) run before URL resolution; resolution happens in `_get_response`, followed by `process_view`. So `request.resolver_match` is not available in a middleware's `__call__` before it calls the next layer, but it is available in `process_view` and in the response phase. This matters for middleware that wants to act per view, such as CSRF exemption or per-route metrics.

**Q: How does Django manage database connections across requests?**
A: Connections are per thread and opened lazily on the first query. Django connects `close_old_connections` to the `request_started` and `request_finished` signals; it closes a connection if it has exceeded `CONN_MAX_AGE` or is in an unusable state. With the default `CONN_MAX_AGE=0`, every request opens and closes its own connection; with a positive value connections persist across requests in the same thread; `CONN_HEALTH_CHECKS` (4.1+) validates reused connections. Django 5.1 added native connection pooling for PostgreSQL with psycopg 3.

**Q: Your API's p99 latency doubled after a deploy but the view code didn't change. How do you find the cause? (Senior)**
A: I'd first split the time by layer instead of guessing: a timing middleware at the top of the stack versus one just above the view (or APM spans) tells me whether the time is in middleware, the view, or after the response, such as streaming or GZip. Then I check what the deploy changed outside the view — a new middleware, a reordered `MIDDLEWARE`, session engine or cache settings, `CONN_MAX_AGE` (connection setup on every request costs real time with TLS to the DB), or Gunicorn worker/thread counts. Query counts per request via logging or `assertNumQueries` in tests catch a new N+1 hidden in a context processor or middleware that touches `request.user`. Finally I look at saturation: if workers are all busy, latency is queueing time in the Gunicorn backlog, not handler time.

**Q: How would you design a middleware that adds a correlation ID to every log line and response, and works under both WSGI and ASGI? (Senior)**
A: Read an incoming `X-Request-ID` from the load balancer or generate a UUID, store it in a `contextvars.ContextVar` (not a thread-local, because under ASGI many requests share a thread and the context is copied per task), attach a `logging.Filter` that injects it into each record, and set the response header on the way out. Place it near the top of `MIDDLEWARE` so its timing and logs cover other middleware. For a native async stack, implement both sync and async paths by setting `sync_capable`/`async_capable` and checking `iscoroutinefunction(get_response)`, or use `@sync_and_async_middleware`, to avoid a thread hop per request. Also propagate the ID to Celery tasks in headers so background work is traceable.

**Q: Why might running a fully sync Django app under ASGI make it slower, not faster? (Senior)**
A: Under ASGI every sync view and sync-only middleware must be adapted with `sync_to_async`, which by default is thread-sensitive and runs in a single shared thread, so you add a context switch per call and can serialize work that a threaded WSGI worker would have run in parallel. The ORM is still synchronous underneath; the async ORM methods themselves run queries in a thread. You only gain when views spend time awaiting I/O with genuinely async clients, or when you hold many idle connections such as WebSockets or long polling. For classic request/response CRUD, Gunicorn sync or threaded workers are simpler and at least as fast.

**Q: Where would you put code that must run once at startup versus once per request?**
A: One-time initialization that needs the app registry goes in `AppConfig.ready()` — registering signal handlers, checks — and must be idempotent and must not query the database. Per-process middleware setup goes in the middleware's `__init__`, which runs when the handler builds the chain. Per-request logic goes in `__call__` or a view. Doing database queries at import time or in `ready()` is a classic mistake that breaks migrations and tests.

## 10. Quick Revision & Cheat Sheet

| Stage | Who | Key detail |
|---|---|---|
| Accept + parse HTTP | Nginx / Gunicorn / Uvicorn | Django never sees the socket |
| Entry point | `WSGIHandler` / `ASGIHandler` | built once; `load_middleware()` at init |
| Start | `request_started` signal | closes stale DB connections |
| Middleware in | `MIDDLEWARE` top to bottom | may short-circuit with a response |
| Resolve | `URLResolver.resolve(path_info)` | ordered, first match wins, else 404 |
| `process_view` | middleware, top to bottom | CSRF check lives here |
| View | your code | must return `HttpResponse` |
| Template response | `process_template_response`, `render()` | deferred rendering |
| Middleware out | bottom to top | headers, cookies, compression |
| Errors | `convert_exception_to_response` | 404/403/400/500 mapping |
| Finish | `request_finished` signal | connection cleanup |

- MTV: template = presentation, view = controller logic, framework + URLconf = dispatcher.
- First middleware in the list is the outermost layer: first in, last out.
- Middleware `__init__` runs once per process; `__call__` per request; never store request state on `self`.
- The URL is resolved after the middleware request phases, before `process_view`.
- Exceptions are converted to responses at every layer; `DoesNotExist` is not `Http404`.
- `SessionMiddleware` before `AuthenticationMiddleware` and `MessageMiddleware`; `SecurityMiddleware` first.
- WSGI = one request per worker thread; ASGI = event loop, worth it for async I/O and WebSockets.
- DB connections are per thread, managed by `close_old_connections` on request start/finish.

## 11. Hands-On Exercises

Set up once: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" && django-admin startproject lab . && python manage.py startapp core`.

1. **Trace the onion.** Write two middleware classes, `A` and `B`, that print on the way in and out. Put them at positions 1 and 3 of `MIDDLEWARE`, hit a view and confirm the order. Swap them and predict the output before running.
2. **Short-circuit.** Make `B` return `HttpResponse("maintenance", status=503)` when a setting `MAINTENANCE=True`. Verify that `A` still sees the response but the view and `process_view` do not run.
3. **Exception mapping.** Create views that raise `Http404`, `PermissionDenied`, `BadRequest`, `Order.DoesNotExist` and `ZeroDivisionError`. Record the status codes with `DEBUG=True` and `DEBUG=False` (set `ALLOWED_HOSTS=["localhost"]`).
4. **Resolver in the shell.** In `python manage.py shell` call `resolve("/hello/ada/")` and inspect `func`, `kwargs`, `url_name`, `route`. Then call `resolve("/missing/")` and catch `Resolver404`.
5. **Signals.** Connect receivers to `request_started` and `request_finished` that log `connection.connection is None`. Change `CONN_MAX_AGE` between 0 and 60 and observe connection reuse.

**Mini project — Lifecycle profiler.** Build a `core` app with a middleware that records, per request: route, view name, status, total time, time inside the view (measure in `process_view` plus the response phase), and number of SQL queries (use `connection.execute_wrapper` to count). Log it as one JSON line and expose an `X-Request-ID` header. Add a test with `RequestFactory` and `override_settings(MIDDLEWARE=...)` that asserts the header is set.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings) (what `django.setup()` loads), [Ch 03 · URL Routing & URLconf](topic.html?p=03-urls-routing) (the resolver in depth), [Ch 04 · Views, HttpRequest & HttpResponse](topic.html?p=04-views-requests-responses), [Ch 05 · Django Template Language](topic.html?p=05-templates), [Ch 18 · Middleware](topic.html?p=18-middleware) (writing and ordering middleware), [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi), [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production), [Ch 36 · Django Internals](topic.html?p=36-django-internals).

**Other handbooks:** [REST API · HTTP Fundamentals](../rest-api/topic.html?p=02-http-fundamentals), [REST API · Status Codes](../rest-api/topic.html?p=07-status-codes), [System Design · Load Balancing](../system-design/topic.html?p=09-load-balancing), [System Design · Proxies & Gateways](../system-design/topic.html?p=10-proxies-gateway).

- **Request and response objects** — Django docs · *Beginner* · the authoritative reference for `HttpRequest`/`HttpResponse` attributes. <https://docs.djangoproject.com/en/5.2/ref/request-response/>
- **Middleware** — Django docs · *Intermediate* · the official explanation of the onion, hooks and ordering. <https://docs.djangoproject.com/en/5.2/topics/http/middleware/>
- **How to deploy with WSGI / ASGI** — Django docs · *Intermediate* · what `wsgi.py`/`asgi.py` do and how servers load them. <https://docs.djangoproject.com/en/5.2/howto/deployment/>
- **Django FAQ: "Django appears to be a MVC framework..."** — Django docs · *Beginner* · the official MTV vs MVC answer. <https://docs.djangoproject.com/en/5.2/faq/general/>
- **django/core/handlers/base.py** — GitHub · *Advanced* · read `load_middleware` and `_get_response` yourself; it is short. <https://github.com/django/django/blob/stable/5.2.x/django/core/handlers/base.py>
- **PEP 3333 — Python WSGI** — python.org · *Intermediate* · the spec every WSGI server implements. <https://peps.python.org/pep-3333/>
- **ASGI specification** — asgi.readthedocs.io · *Advanced* · scope, receive and send explained. <https://asgi.readthedocs.io/en/latest/>
- **Django Debug Toolbar** — GitHub · *Beginner* · see timing, SQL and templates for each request. <https://github.com/django-commons/django-debug-toolbar>

---

*Django Handbook — chapter 01.*
