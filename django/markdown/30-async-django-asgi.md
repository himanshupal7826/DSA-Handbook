# 30 · Async Django & ASGI

> **In one line:** ASGI lets Django serve requests from an event loop, so an `async def` view can wait on many network calls, WebSockets or streams at once without holding a thread — but the ORM still runs in threads behind `sync_to_async`, transactions are sync-only, and one blocking call stalls the whole loop, so async pays off for I/O fan-out and long-lived connections, not for ordinary CRUD.

---

## 1. Overview

> **Builds on:** [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle) (WSGI/ASGI handlers and `BaseHandler`), [Ch 18 · Middleware](topic.html?p=18-middleware) (the middleware chain that must now be sync- or async-capable), [Ch 04 · Views, Requests & Responses](topic.html?p=04-views-requests-responses), [Ch 14 · Transactions & Concurrency](topic.html?p=14-transactions-concurrency).

For most of its life Django spoke only **WSGI**: the server calls `application(environ, start_response)`, the call blocks until the response is ready, and concurrency comes from running many worker processes and threads. That model is simple and robust, and it is still the right model for the majority of Django apps. It breaks down in three situations:

1. **I/O fan-out.** A view calls four external APIs, each taking 300 ms. Sequentially that is 1.2 s per request, and the worker thread sits idle for all of it. At 200 concurrent requests you need 200 threads doing nothing but waiting.
2. **Long-lived connections.** WebSockets, Server-Sent Events and long polling hold a connection open for minutes. In WSGI each one pins a thread, so 10,000 connected clients means 10,000 threads.
3. **Slow clients and streaming.** Streaming a large response to a slow mobile client holds a worker the whole time.

The naive fix — "add more threads" — fails because threads cost memory (stack per thread), context-switching and, crucially, database connections (one per thread). **ASGI** (Asynchronous Server Gateway Interface) replaces the blocking callable with `async def application(scope, receive, send)`. One process runs an **event loop** that interleaves thousands of in-flight requests: whenever one awaits I/O, the loop runs another.

Django has been adding async support since 3.0: the `ASGIHandler` (3.0), async views and middleware (3.1), an async ORM *interface* (4.1), async model and related-manager methods (4.2), async auth helpers and signals (5.0), and async session methods (5.1). The important word is *interface*: the ORM and database drivers underneath are still synchronous, so `await Book.objects.aget(pk=1)` runs the query in a thread via `sync_to_async`. Async Django is therefore a hybrid, and using it well means knowing exactly where the sync/async boundaries are, what each crossing costs, and which workloads actually benefit.

## 2. Core Concepts

- **WSGI** — synchronous interface: one request occupies one thread until it finishes. *Why it matters:* the baseline; `gunicorn` sync workers are WSGI.
- **ASGI** — asynchronous interface with `scope`, `receive`, `send`; also carries WebSockets and lifespan events. *Why:* required for async views to deliver concurrency, and for Channels.
- **Event loop** — the `asyncio` scheduler that runs coroutines and switches at every `await`. *Why:* one blocking call (`time.sleep`, `requests.get`, sync ORM) freezes every request on that loop.
- **Coroutine / `async def` view** — a view Django detects with `asyncio.iscoroutinefunction`. *Why:* under ASGI it runs on the loop directly; under WSGI Django wraps it in `async_to_sync` and gains nothing.
- **`sync_to_async`** (asgiref) — runs a sync function in a thread and awaits the result. *Why:* the bridge from async code to the ORM, third-party sync libraries and transactions.
- **`async_to_sync`** — runs a coroutine from sync code, using the outer loop if one exists. *Why:* calling async APIs (e.g. a Channels layer) from sync views and Celery tasks.
- **`thread_sensitive=True`** (default) — sync functions run in one dedicated thread per request context (and on the main thread when called under an outer `async_to_sync`). *Why:* the ORM's connections are thread-local, so all DB work for a request must stay on the same thread.
- **`SynchronousOnlyOperation`** — raised when sync-only Django code (the ORM, lazy related access) is called directly from an async context. *Why:* the guard that stops you from blocking the loop with a DB query.
- **Async ORM API** — `aget`, `acreate`, `acount`, `aexists`, `afirst`, `aupdate`, `adelete`, `ain_bulk`, `aiterator`, `aaggregate`, `async for`, `Model.asave()`, `arefresh_from_db()`, related `aadd`/`aset`/`aclear`. *Why:* readable async code; same threaded execution underneath.
- **Async middleware** — middleware declaring `async_capable`; Django adapts mismatched middleware with sync/async wrappers per request. *Why:* one sync-only middleware in an async stack forces thread hops on every request.
- **ASGI servers** — uvicorn, Daphne, Hypercorn; often `gunicorn -k uvicorn.workers.UvicornWorker` for process management. *Why:* `manage.py runserver` is WSGI unless Daphne is in `INSTALLED_APPS`.

## 3. Theory & Principles

### Concurrency models side by side

Under WSGI, a Gunicorn sync worker handles exactly one request at a time; threaded workers (`gthread`) handle as many as they have threads. Waiting on I/O is cheap for the CPU but expensive for capacity: the thread is reserved. Under ASGI, a single worker process runs one event loop; a request that awaits a network response yields, and the loop serves other requests in the meantime. Capacity for waiting is limited by memory and file descriptors, not threads.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Three requests, each waiting 300 ms on an external API</text>
  <rect x="20" y="40" width="410" height="300" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="225" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">WSGI: one thread per in-flight request</text>
  <text x="34" y="92" fill="#334155" font-size="10">thread 1</text>
  <rect x="90" y="80" width="20" height="18" fill="#2563eb"/>
  <rect x="110" y="80" width="240" height="18" fill="#fee2e2" stroke="#dc2626"/>
  <text x="230" y="93" text-anchor="middle" fill="#7f1d1d" font-size="9">blocked: waiting for API</text>
  <rect x="350" y="80" width="20" height="18" fill="#2563eb"/>
  <text x="34" y="132" fill="#334155" font-size="10">thread 2</text>
  <rect x="90" y="120" width="20" height="18" fill="#2563eb"/>
  <rect x="110" y="120" width="240" height="18" fill="#fee2e2" stroke="#dc2626"/>
  <text x="230" y="133" text-anchor="middle" fill="#7f1d1d" font-size="9">blocked</text>
  <rect x="350" y="120" width="20" height="18" fill="#2563eb"/>
  <text x="34" y="172" fill="#334155" font-size="10">thread 3</text>
  <rect x="90" y="160" width="20" height="18" fill="#2563eb"/>
  <rect x="110" y="160" width="240" height="18" fill="#fee2e2" stroke="#dc2626"/>
  <text x="230" y="173" text-anchor="middle" fill="#7f1d1d" font-size="9">blocked</text>
  <rect x="350" y="160" width="20" height="18" fill="#2563eb"/>
  <text x="34" y="212" fill="#334155" font-size="10">thread 4</text>
  <rect x="90" y="200" width="280" height="18" fill="#fef3c7" stroke="#d97706"/>
  <text x="230" y="213" text-anchor="middle" fill="#78350f" font-size="9">4th request queues if only 3 threads</text>
  <text x="34" y="252" fill="#334155" font-size="10">Cost: N waiting requests = N threads,</text>
  <text x="34" y="268" fill="#334155" font-size="10">N stacks, up to N DB connections.</text>
  <text x="34" y="292" fill="#334155" font-size="10">Simple, debuggable, any library works.</text>
  <text x="34" y="316" fill="#16a34a" font-size="10">Fine when requests are short and CPU/DB bound.</text>
  <rect x="450" y="40" width="410" height="300" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="655" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">ASGI: one event loop interleaves requests</text>
  <text x="464" y="92" fill="#334155" font-size="10">loop</text>
  <rect x="500" y="80" width="20" height="18" fill="#2563eb"/>
  <rect x="520" y="80" width="20" height="18" fill="#7c3aed"/>
  <rect x="540" y="80" width="20" height="18" fill="#16a34a"/>
  <rect x="780" y="80" width="20" height="18" fill="#2563eb"/>
  <rect x="800" y="80" width="20" height="18" fill="#7c3aed"/>
  <rect x="820" y="80" width="20" height="18" fill="#16a34a"/>
  <text x="670" y="93" text-anchor="middle" fill="#334155" font-size="9">idle: all three awaiting</text>
  <text x="464" y="132" fill="#334155" font-size="10">req A</text>
  <rect x="520" y="120" width="260" height="18" fill="#dbeafe" stroke="#2563eb"/>
  <text x="650" y="133" text-anchor="middle" fill="#1e3a8a" font-size="9">await httpx (suspended)</text>
  <text x="464" y="172" fill="#334155" font-size="10">req B</text>
  <rect x="540" y="160" width="260" height="18" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="670" y="173" text-anchor="middle" fill="#4c1d95" font-size="9">await (suspended)</text>
  <text x="464" y="212" fill="#334155" font-size="10">req C</text>
  <rect x="560" y="200" width="260" height="18" fill="#dcfce7" stroke="#16a34a"/>
  <text x="690" y="213" text-anchor="middle" fill="#14532d" font-size="9">await (suspended)</text>
  <text x="464" y="252" fill="#334155" font-size="10">Cost: a coroutine object per request;</text>
  <text x="464" y="268" fill="#334155" font-size="10">thousands of waits on one thread.</text>
  <text x="464" y="292" fill="#dc2626" font-size="10">Any blocking call (sync ORM, requests, sleep)</text>
  <text x="464" y="308" fill="#dc2626" font-size="10">freezes A, B and C together.</text>
  <text x="440" y="364" text-anchor="middle" fill="#334155" font-size="10">Blue/purple/green blocks = CPU work for requests A, B, C. Waiting is free on the loop, expensive on threads.</text>
</svg>
```

### How Django runs a request under ASGI

`django.core.handlers.asgi.ASGIHandler.__call__(scope, receive, send)`:

1. Rejects non-`http` scopes (WebSockets need Channels), reads the body from `receive` into a spooled temporary file, and builds an `ASGIRequest`.
2. Sends `request_started` and calls `await self.get_response_async(request)`. The middleware chain was built once in `load_middleware(is_async=True)`; for each middleware, `adapt_method_mode` wraps it with `sync_to_async` or `async_to_sync` if its capabilities do not match the mode of the layer around it.
3. Resolves the URL and calls the view. An `async def` view is awaited directly on the loop. A **sync view** is wrapped in `sync_to_async(thread_sensitive=True)` and runs in a thread.
4. Each request is wrapped in an asgiref `ThreadSensitiveContext`, so all thread-sensitive sync code *for that request* (sync middleware, sync views, ORM calls from `aget` and friends) runs on one per-request thread — which keeps the thread-local database connection consistent within the request.
5. Sends the response through `send` (streaming bodies chunk by chunk; async iterators are supported by `StreamingHttpResponse` since 4.2).

Under **WSGI**, `WSGIHandler` calls `get_response` synchronously; an `async def` view is executed via `async_to_sync`, which spins up an event loop for that call. It works, which is convenient for gradual migration, but each request still holds its thread for the whole duration — no concurrency is gained, and the extra loop costs a little.

### The async ORM: an async interface over sync execution

`QuerySet.aget()` is essentially:

```python
async def aget(self, *args, **kwargs):
    return await sync_to_async(self.get)(*args, **kwargs)
```

The query runs in the request's sync thread through the normal compiler and psycopg connection. You get non-blocking *semantics* — the loop keeps serving other requests while your query runs — but each query costs a thread hop, and the number of concurrent queries is bounded by the threads and connections available. What does **not** work from async code:

- Lazy evaluation that would hit the DB implicitly: iterating a queryset with plain `for`, `len(qs)`, accessing an unloaded FK (`book.author`), or touching `request.user` attributes that lazy-load. These raise `SynchronousOnlyOperation`. Use `async for`, `acount()`, `select_related`, or `await request.auser()` (5.0+).
- **Transactions.** `transaction.atomic()` is not supported in async code. Put the transactional unit in a sync function and call it with `sync_to_async`.
- Anything in third-party sync libraries that queries the DB (most DRF internals, many packages).

Although psycopg 3 itself offers an async API, Django 5.2's ORM does not use it — truly async database I/O remains future work, so plan around the threaded model.

## 4. Architecture & Workflow

The diagram shows where each piece of code runs in a typical ASGI deployment and where thread hops happen.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj30a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="dj30b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Inside one uvicorn worker: event loop thread vs per-request sync thread</text>
  <rect x="20" y="44" width="150" height="70" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="95" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">gunicorn master</text>
  <text x="95" y="84" text-anchor="middle" fill="#334155" font-size="10">-k UvicornWorker</text>
  <text x="95" y="100" text-anchor="middle" fill="#334155" font-size="10">-w (cores)</text>
  <path d="M170,80 L196,80" stroke="#334155" stroke-width="2" marker-end="url(#dj30a)"/>
  <rect x="198" y="40" width="420" height="250" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="408" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Event loop thread</text>
  <rect x="212" y="72" width="392" height="34" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="222" y="93" fill="#334155" font-size="10">ASGIHandler: build ASGIRequest, ThreadSensitiveContext per request</text>
  <rect x="212" y="114" width="392" height="34" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="222" y="135" fill="#334155" font-size="10">async-capable middleware (Security, Common, Csrf ... ) run on the loop</text>
  <rect x="212" y="156" width="392" height="44" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="222" y="174" fill="#1e293b" font-size="10" font-weight="bold">async def view</text>
  <text x="222" y="190" fill="#334155" font-size="10">await asyncio.gather(httpx calls)   runs here, non-blocking</text>
  <rect x="212" y="208" width="392" height="34" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="222" y="229" fill="#7f1d1d" font-size="10">requests.get() / time.sleep() / sync ORM here = loop frozen</text>
  <text x="222" y="270" fill="#334155" font-size="10">sync-only middleware forces a hop each way on every request</text>
  <rect x="660" y="40" width="200" height="250" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="760" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Per-request sync thread</text>
  <text x="672" y="86" fill="#334155" font-size="10">thread_sensitive=True code:</text>
  <text x="672" y="104" fill="#334155" font-size="10">- await qs.aget() bodies</text>
  <text x="672" y="120" fill="#334155" font-size="10">- sync views under ASGI</text>
  <text x="672" y="136" fill="#334155" font-size="10">- sync middleware</text>
  <text x="672" y="152" fill="#334155" font-size="10">- sync_to_async(atomic fn)</text>
  <text x="672" y="180" fill="#334155" font-size="10">owns the thread-local</text>
  <text x="672" y="196" fill="#334155" font-size="10">DB connection</text>
  <path d="M604,178 L658,178" stroke="#d97706" stroke-width="2" marker-end="url(#dj30b)"/>
  <text x="630" y="170" text-anchor="middle" fill="#d97706" font-size="9">hop</text>
  <path d="M760,290 L760,326" stroke="#334155" stroke-width="2" marker-end="url(#dj30a)"/>
  <rect x="660" y="328" width="200" height="54" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="760" y="350" text-anchor="middle" fill="#1e293b" font-weight="bold">PostgreSQL</text>
  <text x="760" y="368" text-anchor="middle" fill="#334155" font-size="10">via pool or PgBouncer</text>
  <path d="M408,290 L408,326" stroke="#334155" stroke-width="2" marker-end="url(#dj30a)"/>
  <rect x="198" y="328" width="420" height="54" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="408" y="350" text-anchor="middle" fill="#1e293b" font-weight="bold">External APIs, Redis (async clients), WebSockets</text>
  <text x="408" y="368" text-anchor="middle" fill="#334155" font-size="10">true non-blocking I/O on the loop</text>
  <text x="440" y="416" text-anchor="middle" fill="#334155" font-size="10">Async gives concurrency for awaiting network I/O; DB work still costs a thread hop and a connection.</text>
</svg>
```

### Middleware capability and adaptation

Every middleware has `sync_capable` (default `True`) and `async_capable` (default `False`) attributes. When Django builds the chain in async mode, it checks each layer: an async-capable middleware is called directly; a sync-only one is wrapped so that the request crosses into a thread and back. Docs describe the penalty as on the order of a millisecond per switch — negligible once, but several sync-only middlewares on a hot endpoint add up and also serialize on the per-request thread. All of Django's built-in middleware is async-capable; audit third-party ones.

```python
from asgiref.sync import iscoroutinefunction, markcoroutinefunction
from django.utils.decorators import sync_and_async_middleware


@sync_and_async_middleware
def timing_middleware(get_response):
    import time
    if iscoroutinefunction(get_response):
        async def middleware(request):
            t = time.perf_counter()
            response = await get_response(request)
            response["Server-Timing"] = f"app;dur={(time.perf_counter() - t) * 1000:.1f}"
            return response
    else:
        def middleware(request):
            t = time.perf_counter()
            response = get_response(request)
            response["Server-Timing"] = f"app;dur={(time.perf_counter() - t) * 1000:.1f}"
            return response
    return middleware
```

Class-based form: set `async_capable = True`, `sync_capable = False` (or both), and in `__init__` call `markcoroutinefunction(self)` when `get_response` is a coroutine function, implementing `async def __call__`.

### Choosing a server

| Server | Protocols | Notes |
|---|---|---|
| uvicorn | HTTP/1.1, WebSockets | Fast (uvloop, httptools); run standalone or as a Gunicorn worker class |
| Daphne | HTTP/1.1, HTTP/2, WebSockets | Reference server from the Channels project; adding `daphne` to `INSTALLED_APPS` makes `runserver` ASGI |
| Hypercorn | HTTP/1.1, HTTP/2, HTTP/3 (experimental) | Trio or asyncio |
| Gunicorn + `uvicorn.workers.UvicornWorker` (or the `uvicorn-worker` package) | as uvicorn | Gunicorn's process supervision, graceful reloads and timeouts |

## 5. Implementation

### Simple example: an async view that fans out

```bash
pip install "django~=5.2" "uvicorn[standard]" httpx gunicorn
```

```python
# config/asgi.py  (generated by startproject)
import os
from django.core.asgi import get_asgi_application

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")
application = get_asgi_application()
```

```python
# dashboard/views.py
import asyncio
import httpx
from django.http import JsonResponse

SERVICES = {
    "weather": "https://api.example.com/weather?city=berlin",
    "fx": "https://api.example.com/fx?base=EUR",
    "news": "https://api.example.com/news?top=5",
}


async def dashboard(request):
    async with httpx.AsyncClient(timeout=2.0) as client:
        results = await asyncio.gather(
            *(client.get(url) for url in SERVICES.values()),
            return_exceptions=True,                     # one failing service must not fail the page
        )
    payload = {}
    for name, res in zip(SERVICES, results):
        payload[name] = res.json() if isinstance(res, httpx.Response) and res.is_success else None
    return JsonResponse(payload)
```

```bash
uvicorn config.asgi:application --workers 4 --host 0.0.0.0 --port 8000
# or, with Gunicorn's supervision:
gunicorn config.asgi:application -k uvicorn.workers.UvicornWorker -w 4 --timeout 30
```

Three 300 ms calls now take about 300 ms total, not 900 ms, and the worker serves other requests while they are in flight.

### Async ORM usage

```python
# library/views.py
from django.http import Http404, JsonResponse
from .models import Book


async def book_detail(request, pk):
    try:
        book = await Book.objects.select_related("author").aget(pk=pk)   # FK loaded in the same query
    except Book.DoesNotExist:
        raise Http404
    return JsonResponse({"title": book.title, "author": book.author.name})


async def recent_books(request):
    qs = Book.objects.filter(published=True).order_by("-created_at")[:20]
    items = [{"id": b.id, "title": b.title} async for b in qs]            # async for, not for
    total = await Book.objects.filter(published=True).acount()
    return JsonResponse({"total": total, "items": items})


async def rename(request, pk):
    book = await Book.objects.aget(pk=pk)
    book.title = request.POST["title"]
    await book.asave(update_fields=["title"])
    user = await request.auser()                                          # 5.0+: async user access
    return JsonResponse({"ok": True, "by": user.pk})
```

The mistake every team makes first:

```text
>>> async def bad(request, pk):
...     book = await Book.objects.aget(pk=pk)
...     return JsonResponse({"author": book.author.name})     # lazy FK load from async context
django.core.exceptions.SynchronousOnlyOperation: You cannot call this from an async context - use a thread or sync_to_async.
```

### Transactions and sync-only code from async views

```python
from asgiref.sync import sync_to_async
from django.db import transaction
from django.db.models import F


def _place_order_sync(user_id, product_id, qty):
    with transaction.atomic():
        product = Product.objects.select_for_update().get(pk=product_id)
        if product.stock < qty:
            raise ValueError("out of stock")
        Product.objects.filter(pk=product_id).update(stock=F("stock") - qty)
        order = Order.objects.create(user_id=user_id, product_id=product_id, qty=qty)
        transaction.on_commit(lambda: send_confirmation.delay(order.pk))
        return order.pk


place_order = sync_to_async(_place_order_sync)       # thread_sensitive=True by default


async def checkout(request):
    user = await request.auser()
    if not user.is_authenticated:
        return JsonResponse({"detail": "login required"}, status=401)
    order_id = await place_order(user.pk, int(request.POST["product"]), int(request.POST["qty"]))
    return JsonResponse({"order": order_id}, status=201)
```

Never use `thread_sensitive=False` for ORM code: it runs in a shared thread pool, so the connection, transaction state and `select_for_update` lock could end up on a different thread than the rest of the request.

### Real-world example: Server-Sent Events with an async streaming response

Long-lived streams are where ASGI shines: each open stream is a suspended coroutine, not a thread.

```python
# notifications/views.py
import asyncio
import json
import redis.asyncio as aioredis
from django.http import HttpResponse, StreamingHttpResponse

r = aioredis.from_url("redis://redis:6379/4")


async def event_stream(user_id):
    pubsub = r.pubsub()
    await pubsub.subscribe(f"notify:{user_id}")
    try:
        yield "retry: 5000\n\n"
        while True:
            msg = await pubsub.get_message(ignore_subscribe_messages=True, timeout=15)
            if msg is None:
                yield ": keep-alive\n\n"                 # comment line keeps proxies from timing out
                continue
            yield f"data: {json.dumps(json.loads(msg['data']))}\n\n"
    except asyncio.CancelledError:                       # client disconnected
        raise
    finally:
        await pubsub.unsubscribe(f"notify:{user_id}")
        await pubsub.aclose()


async def notifications(request):
    user = await request.auser()
    if not user.is_authenticated:
        return HttpResponse(status=401)
    response = StreamingHttpResponse(event_stream(user.pk), content_type="text/event-stream")
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"                 # tell Nginx not to buffer
    return response
```

Any sync code (a Celery task, a sync view) can publish to the user with a plain sync Redis client: `redis.Redis(...).publish(f"notify:{uid}", json.dumps(payload))`. For bidirectional real-time, see [Ch 32 · Django Channels & Real-Time](topic.html?p=32-channels-websockets).

### Calling async code from sync code

```python
from asgiref.sync import async_to_sync
from channels.layers import get_channel_layer


def order_shipped(order):                          # sync: a Celery task or sync view
    async_to_sync(get_channel_layer().group_send)(
        f"user_{order.user_id}", {"type": "order.shipped", "order_id": order.pk}
    )
```

### Testing async views

```python
from django.test import TestCase


class DashboardTests(TestCase):
    async def test_recent_books(self):
        await Book.objects.acreate(title="Dune", published=True, author=await Author.objects.acreate(name="FH"))
        response = await self.async_client.get("/books/recent/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["total"], 1)
```

`TestCase` methods can be `async def`; `self.async_client` is an `AsyncClient`. Use `respx` or `pytest-httpx` to mock httpx calls.

## 6. Advantages, Disadvantages & Trade-offs

| Dimension | WSGI (sync views, Gunicorn sync/gthread) | ASGI + async views |
|---|---|---|
| Concurrency for waiting | Threads/processes; bounded and memory-heavy | Thousands of coroutines per process |
| CPU-bound work | Same | Same (one loop per process; GIL) — no gain |
| DB-bound CRUD | Direct calls, no hops | Thread hop per query; no gain, slight overhead |
| External API fan-out | Sequential or manual thread pools | `asyncio.gather` — big latency and capacity win |
| WebSockets / SSE / long polling | Impractical | Natural fit |
| Ecosystem | Everything works (DRF, all packages) | Sync-only libraries need wrappers; DRF views are sync |
| Debugging | Simple stack traces | Blocking calls hide; need loop-blocking detection |
| Transactions | Native | Must wrap in `sync_to_async` |
| Failure blast radius | One stuck request = one thread | One blocking call = every request on that loop |

### When to use

- Views that call several slow external services and can do so concurrently.
- Streaming responses, SSE, long polling and WebSockets (with Channels).
- Gateways/BFF endpoints that mostly proxy and aggregate other services.
- Workloads with many slow clients where thread count is the capacity limit.
- Mixed apps: run under ASGI, keep most views sync, and make only the I/O-heavy ones async.

### When NOT to use

- Typical CRUD and admin traffic dominated by database queries — async adds hops and complexity with no throughput gain; scale with more WSGI workers and a connection pool.
- CPU-heavy work (image processing, PDF generation, ML inference) — offload to Celery ([Ch 31](topic.html?p=31-celery-background-tasks)).
- Codebases heavily dependent on sync-only libraries in the request path.
- Background jobs that must survive restarts — an `asyncio.create_task` in a view dies with the worker; use a task queue.

## 7. Common Mistakes & Best Practices

**1. Blocking calls inside `async def`.** `requests.get()`, `time.sleep()`, `boto3`, sync Redis clients and file I/O block the loop. Symptom: latency spikes for *unrelated* requests. Use async clients (`httpx.AsyncClient`, `redis.asyncio`, `aiobotocore`) or wrap with `sync_to_async`.

```python
# Before: freezes every request on this worker for up to 2 s
async def view(request):
    data = requests.get(URL, timeout=2).json()
# After
async def view(request):
    async with httpx.AsyncClient(timeout=2) as c:
        data = (await c.get(URL)).json()
```

**2. Async views under WSGI and expecting a speed-up.** Under Gunicorn sync workers an async view runs in a per-request event loop; it still holds the worker. Deploy with an ASGI server.

**3. Making every view async.** Converting CRUD views to `aget`/`asave` adds a thread hop per query and makes code harder to read for zero gain. Convert only where concurrency helps.

**4. Lazy relations and `request.user` in async code.** Accessing `book.author` or `request.user.email` without preloading raises `SynchronousOnlyOperation`. Use `select_related`/`prefetch_related` in the async query, `await request.auser()`, and serialize everything inside a sync function if the template or serializer touches many relations.

**5. Silencing the guard with `DJANGO_ALLOW_ASYNC_UNSAFE`.** It exists for Jupyter notebooks. In a server it lets sync DB calls run on the loop thread, blocking it and risking connection misuse.

**6. Persistent DB connections under ASGI.** `CONN_MAX_AGE > 0` assumes long-lived worker threads; under ASGI the per-request threads come and go, so persistent connections leak or pile up. Django's docs recommend disabling persistent connections in async deployments and using connection pooling instead — Django 5.1's native psycopg 3 pool (`OPTIONS: {"pool": True}`) or PgBouncer.

**7. Fire-and-forget tasks.** `asyncio.create_task(send_email())` in a view is not durable, has no retries, and may be garbage-collected if no reference is kept. Use Celery with `transaction.on_commit`.

**8. Creating an HTTP client per call in hot paths.** `httpx.AsyncClient` holds a connection pool; creating one per request loses keep-alive. Create a module-level client (closed on shutdown) or one per request that does multiple calls, as in the example.

**Best practices:** keep business logic in sync service functions and call them via `sync_to_async` from the few async views; set timeouts on every await (`asyncio.timeout()` / client timeouts); use `return_exceptions=True` or `TaskGroup` with error handling for fan-out; enable asyncio debug mode in development (`PYTHONASYNCIODEBUG=1`) to log slow callbacks that block the loop.

## 8. Production: Pitfalls, Debugging & Scaling

**Production story — p99 latency explodes after "going async".** A team moved a DRF API to uvicorn and rewrote a few views as async. *Symptom:* p99 rose from 200 ms to 3 s although CPU was low. *Root cause:* one async view used the sync `stripe` SDK, blocking the loop for 400–800 ms per call; every concurrent request on that worker waited. *Debug:* `PYTHONASYNCIODEBUG=1` with `loop.slow_callback_duration = 0.1` logged "Executing <Task ...> took 0.6 seconds"; py-spy showed the loop thread inside `ssl.read`. *Fix:* wrap the SDK call in `sync_to_async` (or use an async client), and add a CI lint rule flagging known blocking calls inside `async def`.

**Production story — database connection exhaustion.** Under ASGI with `CONN_MAX_AGE = 600`, connections grew until PostgreSQL hit `max_connections`. *Root cause:* per-request sync threads each opened a connection that was not reused or closed promptly. *Fix:* `CONN_MAX_AGE = 0` plus Django 5.1 pooling (`"OPTIONS": {"pool": {"min_size": 2, "max_size": 10}}`) or PgBouncer in transaction mode (with `DISABLE_SERVER_SIDE_CURSORS = True`). See [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases) and [Database Design · Application Architecture](../database-design/topic.html?p=20-database-application-architecture).

**Production story — SSE streams cut at 60 s.** *Symptom:* clients reconnect every minute. *Root cause:* Nginx `proxy_read_timeout` default and response buffering. *Fix:* `X-Accel-Buffering: no`, keep-alive comments every 15 s, `proxy_read_timeout 1h` on the stream location, and Gunicorn `--timeout` raised or a dedicated uvicorn deployment for streaming routes.

**Capacity planning.** An ASGI worker can hold thousands of idle streams, but DB-touching requests are still limited by the sync thread pool and the connection pool. Size: processes ≈ CPU cores; DB pool per process sized so `processes x pool_max` stays below the database's budget; external-call concurrency bounded with `asyncio.Semaphore` so a slow upstream does not create unbounded in-flight requests. Split traffic: a WSGI deployment for CRUD/admin and an ASGI deployment for streaming and fan-out endpoints is a common and pragmatic architecture.

**Debugging toolkit.**

- `PYTHONASYNCIODEBUG=1` and `loop.slow_callback_duration` for blocking detection.
- `py-spy dump --pid <worker>` to see what the loop thread is doing right now.
- Structured logs with request ids propagated via `contextvars` (thread-locals do not follow coroutines; asgiref preserves contextvars across `sync_to_async`).
- APM tools (Sentry, OpenTelemetry) have async-aware instrumentation for Django; verify spans cross the sync/async boundary.
- Graceful shutdown: long streams must handle `CancelledError`; set server graceful timeouts so deploys do not hang.

## 9. Interview Questions

**Q: What is the difference between WSGI and ASGI?**
A: WSGI is a synchronous interface: the server calls `application(environ, start_response)` and the call blocks until the response is complete, so each in-flight request holds a thread or process. ASGI is asynchronous: `async def application(scope, receive, send)` lets a server run many requests concurrently on an event loop and also supports long-lived protocols like WebSockets and a lifespan protocol. Django provides `WSGIHandler` and `ASGIHandler`, both built on `BaseHandler`. ASGI is required to get concurrency from async views and for Channels.

**Q: Do async views make Django faster?**
A: Not by themselves. Async improves *concurrency* when a request spends most of its time waiting on I/O that can be awaited — several external API calls, streaming, long polling. It does not make CPU work or database queries faster; the ORM still runs queries in a thread via `sync_to_async`, adding a small overhead per query. Under WSGI, async views run in a per-request event loop and give no benefit at all. For ordinary DB-bound CRUD, sync views under WSGI with enough workers perform as well or better.

**Q: What do `sync_to_async` and `async_to_sync` do?**
A: `sync_to_async(fn)` returns an awaitable that runs a synchronous function in a thread, so async code can call the ORM or a sync library without blocking the event loop. `async_to_sync(coro_fn)` lets synchronous code call a coroutine function, running it on the outer event loop if there is one or a new loop otherwise — for example calling a Channels layer's `group_send` from a Celery task. Both come from asgiref and propagate contextvars across the boundary.

**Q: What does `thread_sensitive=True` mean, and why is it the default?**
A: Thread-sensitive sync functions run in a single dedicated thread rather than an arbitrary pool thread: under Django's ASGI handler, one thread per request (via `ThreadSensitiveContext`), and on the main thread when called beneath an outer `async_to_sync`. It is the default because Django's database connections and transaction state are thread-local; all ORM work for a request must happen on the same thread to reuse the connection and keep transactions coherent. `thread_sensitive=False` is fine only for thread-safe code with no Django DB access.

**Q: What is `SynchronousOnlyOperation` and how do you fix it?**
A: Django raises it when sync-only code, chiefly the ORM, is called directly from a thread running an event loop, because a blocking query would freeze the loop. Common triggers are iterating a queryset with plain `for`, accessing an unloaded foreign key, or using a sync library that queries the database inside an async view. Fix it by using the async ORM methods (`aget`, `async for`, `acount`), preloading relations with `select_related`/`prefetch_related`, or wrapping the sync code with `sync_to_async`. Do not set `DJANGO_ALLOW_ASYNC_UNSAFE` in servers.

**Q: Is the Django ORM truly asynchronous?**
A: Its interface is async since 4.1 (`aget`, `acreate`, `async for`, `aaggregate`, and `asave`, `adelete`, related-manager methods since 4.2), but execution is not: each async method calls the sync implementation through `sync_to_async`, and the database driver call blocks a worker thread. The event loop stays free while the query runs, which is what matters for concurrency, but you pay a thread switch per query and remain limited by threads and connections. Native async database drivers in the ORM are still future work.

**Q: Can you use transactions in async Django code?**
A: Not directly — `transaction.atomic()` is not supported in async contexts in Django 5.2. Put the transactional logic, including `select_for_update` and `on_commit` registration, in a synchronous function and call it with `sync_to_async` (thread-sensitive), so the entire transaction runs on one thread with one connection. This also tends to produce cleaner code: a sync service layer called from thin async views.

**Q: How do middleware work with async views?**
A: Each middleware declares `sync_capable` and `async_capable`. When building the chain for ASGI, Django calls async-capable middleware directly and wraps sync-only middleware with adapters so each request hops into a thread and back, costing on the order of a millisecond per switch. All built-in middleware supports both modes; third-party sync-only middleware in the chain erodes async benefits. Write dual-mode middleware with `@sync_and_async_middleware` or the class flags plus `markcoroutinefunction`.

**Q: Which ASGI servers can run Django, and how do you deploy one?**
A: Uvicorn, Daphne and Hypercorn. A common production setup is Gunicorn as the process manager with the uvicorn worker class — `gunicorn config.asgi:application -k uvicorn.workers.UvicornWorker -w 4` — behind Nginx or a load balancer. Daphne is the Channels reference server, and adding `daphne` to `INSTALLED_APPS` makes `runserver` serve ASGI in development. Workers are sized roughly to CPU cores, since each process runs one event loop.

**Q: When would you choose async Django over sync, and how would you migrate an existing app? (Senior)**
A: Choose async for I/O-bound concurrency: aggregating several upstream APIs, SSE or WebSockets, long polling, or many slow clients where thread count limits capacity. Keep DB-bound CRUD sync. To migrate, first switch the server to ASGI with all views unchanged — sync views keep working in per-request threads — and verify middleware is async-capable and `CONN_MAX_AGE` is replaced with pooling. Then convert only the endpoints that benefit, keep business logic in sync service functions called via `sync_to_async`, swap blocking clients for async ones in those paths, and add blocking-call detection and load tests comparing p50/p99. A split deployment (WSGI for CRUD, ASGI for streaming/fan-out) is a valid end state.

**Q: Your async endpoint has fine p50 but terrible p99 under load. How do you debug it? (Senior)**
A: That pattern suggests the event loop is being blocked intermittently, so every request queued behind a blocking call suffers. Enable asyncio debug mode with a low `slow_callback_duration` to log callbacks that run too long, and use `py-spy dump` on a worker to see what the loop thread is executing. Look for sync HTTP SDKs, sync Redis/S3 clients, CPU-heavy JSON or image work, or ORM calls hidden behind `sync_to_async` that serialize on the per-request thread or wait for a connection from an exhausted pool. Fix with async clients, `sync_to_async` wrappers, offloading CPU work, connection pool sizing and concurrency limits on upstream calls.

**Q: How do database connections behave under ASGI, and how should you configure them? (Senior)**
A: Django connections are per thread. Under ASGI, sync code runs in per-request threads, so persistent connections tied to threads (`CONN_MAX_AGE > 0`) are not reliably reused and can accumulate until PostgreSQL hits `max_connections`. Django's guidance is to disable persistent connections for async deployments and use pooling: the native psycopg 3 pool in Django 5.1+ (`OPTIONS: {"pool": True}` or explicit sizes), or PgBouncer in transaction mode with `DISABLE_SERVER_SIDE_CURSORS = True`. Size `workers x pool_max` against the database's connection budget, and remember that async does not increase how many queries can run concurrently — the pool does.

**Q: How do you call an external API from a Django view without blocking, and handle failures?**
A: In an async view under ASGI, use an async client such as `httpx.AsyncClient` with explicit timeouts, and run independent calls concurrently with `asyncio.gather(..., return_exceptions=True)` or a `TaskGroup` so one failure does not cancel or fail the page. Bound concurrency with a semaphore, add retries with backoff for idempotent calls, and degrade gracefully when a dependency is down. If the work is not needed for the response, enqueue it in Celery instead. In a sync view, the same calls block the worker; a thread pool is the sync alternative.

## 10. Quick Revision & Cheat Sheet

| Item | Detail |
|---|---|
| Entry points | `config/wsgi.py` (`get_wsgi_application`), `config/asgi.py` (`get_asgi_application`) |
| Async view | `async def view(request)`; real concurrency only under ASGI |
| Sync view under ASGI | Runs via `sync_to_async(thread_sensitive=True)` in a per-request thread |
| Async view under WSGI | Runs via `async_to_sync`; no gain |
| Async ORM | `aget`, `acreate`, `aget_or_create`, `acount`, `aexists`, `afirst`, `aupdate`, `adelete`, `aaggregate`, `ain_bulk`, `aiterator`, `async for`; `asave`, `adelete`, `arefresh_from_db` |
| Async auth/session | `await request.auser()`, `alogin`, `alogout` (5.0); `session.aget/aset` (5.1) |
| Transactions | Not in async — wrap a sync function with `sync_to_async` |
| Guard | `SynchronousOnlyOperation` |
| Middleware flags | `sync_capable`, `async_capable`, `@sync_and_async_middleware` |
| Servers | uvicorn, Daphne, Hypercorn; `gunicorn -k uvicorn.workers.UvicornWorker` |
| DB connections | `CONN_MAX_AGE = 0` + pool (5.1+) or PgBouncer |
| Tests | `async def test_...`, `self.async_client`, `AsyncClient` |

- Async helps waiting, not computing.
- The ORM is an async API over threaded execution.
- One blocking call in `async def` stalls the whole worker.
- Preload relations; lazy loads raise in async code.
- Keep logic sync; make only I/O-heavy edges async.
- Do not use `thread_sensitive=False` for ORM code.
- Long-lived work belongs in Celery, not `create_task`.
- Bound upstream concurrency and set timeouts on every await.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" "uvicorn[standard]" gunicorn httpx`.

1. **Sync vs async fan-out.** Create a slow stub endpoint that sleeps 300 ms (`await asyncio.sleep(0.3)`). Write a sync view that calls it three times with `httpx.Client` and an async view using `asyncio.gather`. Benchmark both under `gunicorn -w 2` (WSGI) and `uvicorn --workers 2` with `hey -c 50 -n 500`, and tabulate latency and throughput.
2. **Block the loop.** Add `time.sleep(1)` to the async view and measure the effect on a second, trivial async endpoint on the same worker. Replace it with `await asyncio.sleep(1)` and compare. Enable `PYTHONASYNCIODEBUG=1` to see the warning.
3. **SynchronousOnlyOperation.** Trigger it with a lazy FK access in an async view; fix it with `select_related`, and separately with `sync_to_async`.
4. **Transactions.** Implement a stock-decrement checkout from an async view using a sync `atomic()` function wrapped in `sync_to_async`; write an async test proving stock never goes negative under concurrent requests.
5. **Dual-mode middleware.** Write the timing middleware from §4 and confirm (with a breakpoint or `threading.get_ident()`) which thread it runs on for a sync view and an async view under ASGI.
6. **SSE.** Build the notifications stream, publish from the Django shell, and watch messages arrive in `curl -N`. Kill the client and confirm the `finally` block runs.

**Mini project — travel search aggregator.** An async endpoint that queries five simulated provider APIs concurrently with per-provider timeouts and a global semaphore, caches results in Redis via the async cache API (`await cache.aget`), streams partial results to the browser over SSE as each provider responds, stores the final search in PostgreSQL through a sync service function, and is deployed with Gunicorn + UvicornWorker and Django 5.1+ connection pooling. Include a load test report comparing it to a sequential sync implementation.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle) · [Ch 18 · Middleware](topic.html?p=18-middleware) · [Ch 14 · Transactions & Concurrency](topic.html?p=14-transactions-concurrency) · [Ch 29 · Caching in Django](topic.html?p=29-caching) · [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks) · [Ch 32 · Django Channels & Real-Time](topic.html?p=32-channels-websockets) · [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases) · [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production)

**Other handbooks:** [REST API · Streaming, SSE & WebSockets](../rest-api/topic.html?p=30-streaming-sse-websockets) · [REST API · Async APIs & Webhooks](../rest-api/topic.html?p=29-async-apis-webhooks)

- **Asynchronous support** — Django docs · *Intermediate* · async views, the sync/async boundary, `sync_to_async` and thread sensitivity. <https://docs.djangoproject.com/en/5.2/topics/async/>
- **How to deploy with ASGI** — Django docs · *Beginner* · uvicorn, Daphne and Hypercorn setup. <https://docs.djangoproject.com/en/5.2/howto/deployment/asgi/>
- **Asynchronous queries** — Django docs · *Intermediate* · the async ORM interface and its limits. <https://docs.djangoproject.com/en/5.2/topics/db/queries/#asynchronous-queries>
- **ASGI specification** — asgiref docs · *Advanced* · scope, receive/send and the HTTP and WebSocket sub-protocols. <https://asgi.readthedocs.io/en/latest/>
- **asgiref** — GitHub · *Advanced* · the source of `sync_to_async`, `async_to_sync` and `ThreadSensitiveContext`. <https://github.com/django/asgiref>
- **Uvicorn deployment docs** — Uvicorn · *Intermediate* · running with Gunicorn, workers and proxies. <https://www.uvicorn.org/deployment/>
- **Python asyncio — developing with asyncio** — Python docs · *Intermediate* · debug mode and detecting blocking calls. <https://docs.python.org/3/library/asyncio-dev.html>

---

*Django Handbook — chapter 30.*
