# 04 · Views, HttpRequest & HttpResponse

> **In one line:** A Django view is just a callable that takes an `HttpRequest` and returns an `HttpResponse` (or raises an exception Django maps to one); mastering what lives on the request — and which parts are parsed lazily, limited, or spoofable — and choosing the right response class for buffered, JSON, streamed or file output is what separates a view that works in a demo from one that survives production traffic.

---

## 1. Overview

> **Builds on:** [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle) (where views sit in the handler) and [Ch 03 · URL Routing & URLconf](topic.html?p=03-urls-routing) (how the view and its kwargs are chosen).

Once the URL resolver has picked a view, your code runs. The contract is tiny — *request in, response out* — and that minimalism is deliberate. A view can be a plain function (a **function-based view**, FBV), a class whose `as_view()` returns a function ([Ch 17 · Class-Based Views](topic.html?p=17-class-based-views)), or a DRF `APIView` ([Ch 22](topic.html?p=22-drf-views-viewsets-routers)). Underneath they all obey the same contract, so this chapter is the foundation for all of them.

The **naive approach** to request handling is to treat the request as a dictionary of strings and the response as a string: read `request.POST["qty"]`, `int()` it, build HTML with f-strings, return it. That fails in many small ways at once. `request.POST` is empty for JSON bodies. `KeyError` on a missing field becomes a 500 instead of a 400. A GET handler that changes data is cached, prefetched by browsers and replayed. A 2 GB CSV export built in memory kills the worker. An IP read from `X-Forwarded-For` is whatever the attacker typed. Refreshing the page after a POST resubmits the order.

Django gives you structured tools for each of these: a rich `HttpRequest` (`GET`, `POST`, `body`, `FILES`, `headers`, `META`, `COOKIES`, plus `user` and `session` from middleware), a family of response classes (`HttpResponse`, redirects, `JsonResponse`, `StreamingHttpResponse`, `FileResponse`, `TemplateResponse`), shortcuts (`render`, `redirect`, `get_object_or_404`), decorators that declare behaviour (`require_POST`, `login_required`, `cache_control`), and exceptions (`Http404`, `PermissionDenied`, `BadRequest`) that become correct status codes.

Interview questions in this area are concrete: *"What's the difference between `request.POST` and `request.body`?"*, *"How do you return JSON?"*, *"How would you stream a large file?"*, *"What is the Post/Redirect/Get pattern?"*, *"How do you get the client's IP behind a load balancer?"*

## 2. Core Concepts

- **View** — any callable `view(request, *args, **kwargs) -> HttpResponse`. *Why it matters:* everything else (CBVs, DRF) compiles down to this.
- **`HttpRequest`** — `WSGIRequest` or `ASGIRequest`; attributes are mostly read-only and many are **parsed lazily** on first access.
- **`request.method`** — uppercase string (`"GET"`, `"POST"`). *Why it matters:* branch on it, or better, restrict it with decorators.
- **`request.GET`** — a `QueryDict` of query-string parameters, for any method. **`request.POST`** — a `QueryDict` of form fields, populated **only** for `application/x-www-form-urlencoded` and `multipart/form-data` bodies. *Why it matters:* JSON requests have an empty `request.POST`.
- **`QueryDict`** — an immutable multi-value dict: `get()` returns the last value, `getlist()` all values; `.copy()` returns a mutable copy.
- **`request.body`** — the raw request body as bytes. *Why it matters:* the place to read JSON or webhooks' signed payloads.
- **`request.FILES`** — a `MultiValueDict` of `UploadedFile` objects, only for `multipart/form-data` POSTs from a form with `enctype="multipart/form-data"`.
- **`request.headers`** — a case-insensitive, read-only mapping of HTTP headers (`request.headers["X-Request-ID"]`). **`request.META`** — the full WSGI environ: headers as `HTTP_*`, plus `REMOTE_ADDR`, `SERVER_NAME`, `CONTENT_LENGTH`.
- **`request.COOKIES`** — dict of cookie strings; **`get_signed_cookie()`** validates signed ones.
- **`request.get_host()` / `build_absolute_uri()` / `is_secure()`** — host and scheme helpers that respect `ALLOWED_HOSTS`, `USE_X_FORWARDED_HOST` and `SECURE_PROXY_SSL_HEADER`.
- **`HttpResponse`** — buffered content (bytes), `status`, `headers`; `set_cookie()`, `delete_cookie()`.
- **Response subclasses** — `HttpResponseRedirect` (302), `HttpResponsePermanentRedirect` (301), `HttpResponseNotModified` (304), `HttpResponseBadRequest` (400), `HttpResponseForbidden` (403), `HttpResponseNotFound` (404), `HttpResponseNotAllowed` (405, takes the allowed methods), `HttpResponseGone` (410), `HttpResponseServerError` (500).
- **`JsonResponse`** — serializes with `DjangoJSONEncoder` (dates, decimals, UUIDs); `safe=True` by default, which requires a `dict`.
- **`StreamingHttpResponse`** — content is an iterator consumed while sending; no `.content`, no `Content-Length` by default.
- **`FileResponse`** — a streaming response optimized for files (uses `wsgi.file_wrapper` when available), sets `Content-Type`, `Content-Length` and `Content-Disposition`.
- **`TemplateResponse`** — keeps template and context until the end of the response phase, so decorators and middleware can modify them.
- **Shortcuts** — `render()`, `redirect()`, `get_object_or_404()`, `get_list_or_404()`.
- **View decorators** — `require_http_methods`, `require_GET`, `require_POST`, `require_safe`, `login_required`, `permission_required`, `csrf_exempt`, `ensure_csrf_cookie`, `cache_page`, `never_cache`, `cache_control`, `vary_on_headers`, `condition`/`etag`/`last_modified`.
- **Error exceptions** — `Http404` (404), `PermissionDenied` (403), `BadRequest` (400), `SuspiciousOperation` (400, logged as a security event).

## 3. Theory & Principles

### 3.1 How an `HttpRequest` is built, lazily

`WSGIHandler` constructs `WSGIRequest(environ)`. The constructor does very little: it sets `path`, `path_info`, `method`, `META = environ`, and reads `CONTENT_TYPE`/`CONTENT_LENGTH` metadata. Everything expensive is deferred:

- `request.GET` is a cached property that parses `QUERY_STRING` into a `QueryDict` on first access.
- `request.COOKIES` parses the `Cookie` header on first access.
- `request.POST` and `request.FILES` are built together by `_load_post_and_files()` on first access. For `multipart/form-data` Django runs the `MultiPartParser`, which streams the body through **upload handlers**: files up to `FILE_UPLOAD_MAX_MEMORY_SIZE` (2.5 MB default) stay in memory (`InMemoryUploadedFile`), larger ones are written to a temp file (`TemporaryUploadedFile`). For URL-encoded forms it parses `request.body`. For any other content type, `POST` is an empty `QueryDict`.
- `request.body` reads the whole input stream into memory the first time, enforcing `DATA_UPLOAD_MAX_MEMORY_SIZE` (2.5 MB default; file data in multipart uploads is excluded from that limit). Exceeding it raises `RequestDataTooBig`, a `SuspiciousOperation` that becomes a 400.

That design has a famous consequence. The input stream can be read **once**. If the multipart parser has already consumed it (because something accessed `request.POST`), then accessing `request.body` raises `RawPostDataException: You cannot access body after reading from request's data stream`. Conversely, if you read `request.body` first, Django can still parse `POST` from the buffered bytes. So when a view needs the raw body — e.g. to verify a webhook HMAC — read `request.body` *before* anything touches `request.POST`, including middleware such as `CsrfViewMiddleware` (which reads `POST` for the token on unsafe methods unless the view is exempt).

Other protective limits: `DATA_UPLOAD_MAX_NUMBER_FIELDS` (1000 by default) caps the number of GET/POST parameters, and `DATA_UPLOAD_MAX_NUMBER_FILES` (100) caps files per multipart request; exceeding either is a 400 (`TooManyFieldsSent` / `TooManyFilesSent`).

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj04a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj04b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">WSGIRequest: what is parsed when (the body stream can be read once)</text>
  <rect x="20" y="44" width="200" height="120" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="120" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">WSGI environ</text>
  <text x="34" y="88" fill="#334155" font-size="10">REQUEST_METHOD, PATH_INFO</text>
  <text x="34" y="104" fill="#334155" font-size="10">QUERY_STRING, HTTP_COOKIE</text>
  <text x="34" y="120" fill="#334155" font-size="10">CONTENT_TYPE, CONTENT_LENGTH</text>
  <text x="34" y="136" fill="#334155" font-size="10">HTTP_* headers, REMOTE_ADDR</text>
  <text x="34" y="152" fill="#334155" font-size="10">wsgi.input (body stream)</text>
  <rect x="260" y="44" width="200" height="60" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="360" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Eager (constructor)</text>
  <text x="360" y="84" text-anchor="middle" fill="#334155" font-size="9">method, path, path_info, META</text>
  <text x="360" y="97" text-anchor="middle" fill="#334155" font-size="9">headers view over META</text>
  <path d="M220,74 L256,74" stroke="#2563eb" stroke-width="2" marker-end="url(#dj04a)"/>
  <rect x="260" y="120" width="200" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="360" y="142" text-anchor="middle" fill="#1e293b" font-weight="bold">Lazy, cheap</text>
  <text x="360" y="160" text-anchor="middle" fill="#334155" font-size="9">GET from QUERY_STRING</text>
  <text x="360" y="173" text-anchor="middle" fill="#334155" font-size="9">COOKIES from HTTP_COOKIE</text>
  <path d="M220,140 L256,148" stroke="#2563eb" stroke-width="2" marker-end="url(#dj04a)"/>
  <rect x="500" y="44" width="360" height="200" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="680" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Lazy, reads wsgi.input: POST / FILES / body</text>
  <text x="514" y="90" fill="#1e293b" font-size="10" font-weight="bold">multipart/form-data</text>
  <text x="514" y="106" fill="#334155" font-size="10">MultiPartParser streams through upload handlers</text>
  <text x="514" y="122" fill="#334155" font-size="10">small files in memory, large ones to temp files</text>
  <text x="514" y="144" fill="#1e293b" font-size="10" font-weight="bold">application/x-www-form-urlencoded</text>
  <text x="514" y="160" fill="#334155" font-size="10">reads body (limit DATA_UPLOAD_MAX_MEMORY_SIZE), parses</text>
  <text x="514" y="182" fill="#1e293b" font-size="10" font-weight="bold">application/json, anything else</text>
  <text x="514" y="198" fill="#334155" font-size="10">POST stays EMPTY; use json.loads(request.body)</text>
  <text x="514" y="226" fill="#334155" font-size="10">Limits: 1000 fields, 100 files, 2.5 MB non-file data</text>
  <path d="M220,152 L496,152" stroke="#2563eb" stroke-width="2" marker-end="url(#dj04a)"/>
  <rect x="20" y="270" width="410" height="110" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="225" y="292" text-anchor="middle" fill="#1e293b" font-weight="bold">Order trap (multipart request)</text>
  <text x="34" y="314" fill="#334155" font-size="10">1. something reads request.POST  (e.g. CSRF check)</text>
  <text x="34" y="332" fill="#334155" font-size="10">2. multipart parser consumes wsgi.input</text>
  <text x="34" y="350" fill="#b91c1c" font-size="10">3. request.body raises RawPostDataException</text>
  <text x="34" y="368" fill="#334155" font-size="9">non-multipart bodies are buffered, so body still works there</text>
  <rect x="450" y="270" width="410" height="110" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="655" y="292" text-anchor="middle" fill="#1e293b" font-weight="bold">Safe order (webhook)</text>
  <text x="464" y="314" fill="#334155" font-size="10">1. @csrf_exempt view (signature replaces CSRF)</text>
  <text x="464" y="332" fill="#334155" font-size="10">2. raw = request.body   verify HMAC over raw bytes</text>
  <text x="464" y="350" fill="#334155" font-size="10">3. payload = json.loads(raw)</text>
  <text x="464" y="368" fill="#334155" font-size="9">request.POST can still be parsed from the buffered body</text>
  <path d="M680,244 L680,266" stroke="#dc2626" stroke-width="2" marker-end="url(#dj04b)"/>
</svg>
```

### 3.2 What a response really is

`HttpResponse` holds a list of byte chunks; setting `content` encodes strings with the response charset (`DEFAULT_CHARSET`, UTF-8). Headers live in `response.headers`, a case-insensitive mapping (since 3.2; `response["X-Foo"]` still works). When the handler returns it, the WSGI layer calls `start_response(f"{status} {reason}", headers + cookies)` and iterates the response to send bytes. Because the content is fully built before sending, middleware can read and rewrite it (`GZipMiddleware`, `ConditionalGetMiddleware` computing an ETag), and Django sets `Content-Length` when it can.

`StreamingHttpResponse` instead wraps an iterator in `streaming_content`. Nothing is generated until the server iterates, so memory stays flat — but there is no `.content`, middleware that needs the full body must skip it (`GZipMiddleware` compresses streams chunk by chunk; ETag computation is skipped), and under a WSGI sync worker **the worker is occupied for the whole duration of the stream**. Since Django 4.2 the iterator may be async; serving a sync iterator under ASGI (or an async one under WSGI) works but Django warns and has to adapt it, consuming it in a thread or buffering.

`FileResponse(open(path, "rb"), as_attachment=True, filename="report.pdf")` is a `StreamingHttpResponse` specialized for files: it sets the type from the filename, the length from the file, the `Content-Disposition` header, and lets the WSGI server use `wsgi.file_wrapper` (e.g. `sendfile`) for efficiency. The file is closed when the response is closed.

`TemplateResponse` defers rendering: it stores `template_name` and `context_data` and renders when the handler calls `render()` after `process_template_response` hooks. That's why CBVs return it — tests can assert on `response.context_data`, and decorators can swap the template.

### 3.3 Decorators wrap views like onion layers

A decorator returns a new function wrapping the view, so stacked decorators apply **bottom-up** and run **top-down**:

```python
@require_POST          # runs first: 405 for GET before anything else
@login_required        # then: redirect anonymous users to LOGIN_URL
@transaction.atomic    # then: open a transaction
def checkout(request): ...
```

Equivalent to `checkout = require_POST(login_required(transaction.atomic(checkout)))`. Order matters: put cheap, rejecting checks outermost. Since Django 5.0 most built-in view decorators (method, cache, vary, CSRF, clickjacking) also accept `async def` views, and `login_required` and the other auth decorators followed in 5.1.

The diagram below summarizes the response-class choice from §3.2.

```svg
<svg viewBox="0 0 880 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj04c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Choosing a response class: buffered vs streamed</text>
  <rect x="20" y="44" width="400" height="290" rx="10" fill="#dbeafe" stroke="#2563eb"/>
  <text x="220" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Buffered: HttpResponse family</text>
  <rect x="40" y="80" width="360" height="44" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="52" y="98" fill="#1e293b" font-size="10" font-weight="bold">HttpResponse / render()</text>
  <text x="52" y="114" fill="#334155" font-size="10">HTML, small text; content in memory, Content-Length set</text>
  <rect x="40" y="132" width="360" height="44" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="52" y="150" fill="#1e293b" font-size="10" font-weight="bold">JsonResponse</text>
  <text x="52" y="166" fill="#334155" font-size="10">DjangoJSONEncoder; safe=True needs a dict</text>
  <rect x="40" y="184" width="360" height="44" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="52" y="202" fill="#1e293b" font-size="10" font-weight="bold">HttpResponseRedirect / redirect()</text>
  <text x="52" y="218" fill="#334155" font-size="10">302 (301 permanent); Location header; PRG pattern</text>
  <rect x="40" y="236" width="360" height="44" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="52" y="254" fill="#1e293b" font-size="10" font-weight="bold">TemplateResponse</text>
  <text x="52" y="270" fill="#334155" font-size="10">render deferred; middleware can alter template/context</text>
  <text x="40" y="306" fill="#334155" font-size="10">Middleware sees the full body (GZip, ETag).</text>
  <text x="40" y="322" fill="#334155" font-size="10">Memory = size of the body, per request.</text>
  <rect x="460" y="44" width="400" height="290" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="660" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Streamed: StreamingHttpResponse family</text>
  <rect x="480" y="80" width="360" height="56" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="492" y="98" fill="#1e293b" font-size="10" font-weight="bold">StreamingHttpResponse(iterator)</text>
  <text x="492" y="114" fill="#334155" font-size="10">CSV/NDJSON exports, SSE; chunks generated on demand</text>
  <text x="492" y="128" fill="#334155" font-size="10">no .content, usually no Content-Length</text>
  <rect x="480" y="144" width="360" height="56" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="492" y="162" fill="#1e293b" font-size="10" font-weight="bold">FileResponse(file, as_attachment=True)</text>
  <text x="492" y="178" fill="#334155" font-size="10">sets type, length, Content-Disposition</text>
  <text x="492" y="192" fill="#334155" font-size="10">wsgi.file_wrapper; file closed with the response</text>
  <rect x="480" y="208" width="360" height="72" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="492" y="226" fill="#1e293b" font-size="10" font-weight="bold">Cost</text>
  <text x="492" y="242" fill="#334155" font-size="10">a sync worker is busy until the last byte is sent</text>
  <text x="492" y="258" fill="#334155" font-size="10">exceptions mid-stream cannot change the status code</text>
  <text x="492" y="272" fill="#334155" font-size="10">big private files: X-Accel-Redirect or signed S3 URL</text>
  <text x="480" y="306" fill="#334155" font-size="10">Memory stays flat regardless of total size.</text>
  <text x="480" y="322" fill="#334155" font-size="10">Proxies may buffer: X-Accel-Buffering: no for SSE.</text>
  <path d="M420,190 L456,190" stroke="#2563eb" stroke-width="2" marker-end="url(#dj04c)"/>
</svg>
```

### 3.4 Errors are exceptions, not return values

Inside a view you can `raise Http404("...")`, `raise PermissionDenied`, `raise BadRequest("...")`. The handler's `response_for_exception` turns them into 404/403/400 responses rendered by `handler404`/`handler403`/`handler400` (or the technical pages in DEBUG). An uncaught `Model.DoesNotExist`, `KeyError` or `ValueError` is a 500. So the discipline is: validate input and raise the right exception, and let `get_object_or_404` convert missing rows into 404s.

## 4. Architecture & Workflow

### 4.1 The Post/Redirect/Get pattern

```text
Browser                       Django view                        Database
   |  GET /orders/new/            |                                  |
   |----------------------------->| render empty form (200)          |
   |<-----------------------------|                                  |
   |  POST /orders/new/ (form)    |                                  |
   |----------------------------->| validate; create Order --------->| INSERT
   |                              |<---------------------------------|
   |<-----------------------------| 302 Location: /orders/42/        |
   |  GET /orders/42/             |                                  |
   |----------------------------->| render detail (200)              |
   |<-----------------------------|                                  |
   |  user presses F5             |  -> repeats the harmless GET, not the POST
```

Returning HTML directly from a successful POST means a refresh re-submits the form ("Confirm form resubmission"), creating a duplicate order. Redirecting after a successful POST — and re-rendering the form with errors (status 200 or 400) on failure — is the standard pattern.

### 4.2 Anatomy of a well-behaved FBV

```text
@decorators                -> method restriction, auth, caching headers
def view(request, **kw):
    1. parse + validate input   -> 400 (BadRequest / form errors) on bad input
    2. load objects             -> get_object_or_404, scoped to request.user (403/404)
    3. do the work              -> service function, transaction.atomic where needed
    4. build response           -> render / redirect / JsonResponse / FileResponse
```

## 5. Implementation

### 5.1 Simple example: reading the request

```python
# shop/views.py
from django.http import HttpResponse, JsonResponse
from django.views.decorators.http import require_GET

@require_GET
def inspect(request):
    return JsonResponse({
        "method": request.method,
        "path": request.path,
        "q": request.GET.get("q", ""),                 # last value or default
        "tags": request.GET.getlist("tag"),            # ?tag=a&tag=b -> ["a", "b"]
        "user_agent": request.headers.get("User-Agent"),
        "accepts_json": request.accepts("application/json"),
        "host": request.get_host(),                    # validated against ALLOWED_HOSTS
        "secure": request.is_secure(),
        "absolute": request.build_absolute_uri("/shop/"),
        "cookies": sorted(request.COOKIES),
        "user": str(request.user),                     # set by AuthenticationMiddleware
    })
```

```bash
curl -s "localhost:8000/inspect/?q=mug&tag=a&tag=b" -H "Accept: application/json"
```

```text
{"method": "GET", "path": "/inspect/", "q": "mug", "tags": ["a", "b"],
 "user_agent": "curl/8.7.1", "accepts_json": true, "host": "localhost:8000",
 "secure": false, "absolute": "http://localhost:8000/shop/", "cookies": [], "user": "AnonymousUser"}
```

`QueryDict` is immutable, which surprises people building "next page" links:

```python
params = request.GET.copy()          # mutable copy
params["page"] = 2
next_url = f"{request.path}?{params.urlencode()}"
```

### 5.2 Handling forms, JSON and files

A form POST with Post/Redirect/Get (forms in depth in [Ch 06](topic.html?p=06-forms-validation)):

```python
from django.contrib import messages
from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render
from django.views.decorators.http import require_http_methods
from .forms import AddressForm

@login_required
@require_http_methods(["GET", "POST"])
def edit_address(request):
    if request.method == "POST":
        form = AddressForm(request.POST, instance=request.user.address)
        if form.is_valid():
            form.save()
            messages.success(request, "Address saved.")
            return redirect("accounts:address")          # PRG
    else:
        form = AddressForm(instance=request.user.address)
    return render(request, "accounts/address.html", {"form": form})
```

A JSON endpoint without DRF — parsing, validating and returning proper status codes:

```python
import json
from decimal import Decimal, InvalidOperation
from django.core.exceptions import BadRequest
from django.http import JsonResponse
from django.views.decorators.http import require_POST

@require_POST
def quote(request):
    if request.content_type != "application/json":
        return JsonResponse({"error": "expected application/json"}, status=415)
    try:
        data = json.loads(request.body)
        qty = int(data["qty"])
        price = Decimal(str(data["unit_price"]))
    except (json.JSONDecodeError, KeyError, ValueError, TypeError, InvalidOperation):
        raise BadRequest("qty and unit_price are required numbers")
    if qty <= 0:
        return JsonResponse({"error": "qty must be positive"}, status=422)
    return JsonResponse({"qty": qty, "total": price * qty})   # Decimal -> "12.50" via DjangoJSONEncoder
```

Note this view still requires a CSRF token when called from a browser session, because `CsrfViewMiddleware` protects every POST; token-authenticated APIs normally use DRF, where CSRF applies only to session authentication ([Ch 28 · Security](topic.html?p=28-security)).

Returning a list needs `safe=False`, because JSON arrays at the top level were once an attack vector in very old browsers and Django keeps the explicit opt-in:

```python
return JsonResponse([{"id": 1}, {"id": 2}], safe=False)
```

An upload view:

```python
from django.core.exceptions import BadRequest

@login_required
@require_POST
def upload_avatar(request):
    f = request.FILES.get("avatar")                     # needs enctype="multipart/form-data"
    if f is None:
        raise BadRequest("avatar file missing")
    if f.size > 2 * 1024 * 1024 or f.content_type not in {"image/png", "image/jpeg"}:
        raise BadRequest("PNG/JPEG under 2 MB only")   # content_type is client-supplied: re-check
    request.user.profile.avatar.save(f.name, f, save=True)  # storage backend handles chunks
    return redirect("accounts:profile")
```

### 5.3 Real-world example: a streaming CSV export and a protected download

Exporting hundreds of thousands of orders as CSV must not load them all into memory or hold one huge string. Stream rows directly from a server-side cursor:

```python
# reports/views.py
import csv
from django.contrib.auth.decorators import permission_required
from django.http import StreamingHttpResponse
from django.utils import timezone
from django.views.decorators.http import require_GET
from orders.models import Order


class Echo:
    """File-like object whose write() returns the value, so csv.writer yields lines."""
    def write(self, value):
        return value


def order_rows(qs):
    writer = csv.writer(Echo())
    yield writer.writerow(["id", "created_at", "customer_email", "status", "total"])
    rows = qs.values_list("id", "created_at", "customer__email", "status", "total")
    for row in rows.iterator(chunk_size=2000):         # server-side cursor on PostgreSQL
        yield writer.writerow(row)


@require_GET
@permission_required("orders.view_order", raise_exception=True)   # 403, not a login redirect
def export_orders(request):
    since = request.GET.get("since")
    qs = Order.objects.order_by("id")
    if since:
        qs = qs.filter(created_at__date__gte=since)
    filename = f"orders-{timezone.now():%Y%m%d}.csv"
    response = StreamingHttpResponse(order_rows(qs), content_type="text/csv")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    response["Cache-Control"] = "private, no-store"
    return response
```

The SQL is one query streamed in chunks, not 2000-row pages:

```sql
DECLARE "_django_curs_..." NO SCROLL CURSOR WITH HOLD FOR
SELECT "orders_order"."id", "orders_order"."created_at", "accounts_user"."email",
       "orders_order"."status", "orders_order"."total"
FROM "orders_order"
INNER JOIN "accounts_user" ON ("orders_order"."customer_id" = "accounts_user"."id")
ORDER BY "orders_order"."id" ASC;
FETCH FORWARD 2000 FROM "_django_curs_...";
```

Two production caveats. A sync Gunicorn worker is busy for the entire download, so very large or frequent exports belong in a Celery task that writes a file to object storage and emails a signed link ([Ch 31](topic.html?p=31-celery-background-tasks)). And because headers are sent before the first row, an exception halfway through cannot turn into a 500 — the client just gets a truncated file; log errors inside the generator.

For private files (invoices), check authorization in Django but let Nginx send the bytes:

```python
from django.http import FileResponse, HttpResponse
from django.shortcuts import get_object_or_404

@login_required
def invoice_pdf(request, pk):
    invoice = get_object_or_404(Invoice, pk=pk, customer__user=request.user)  # 404, not 403: don't leak existence
    if settings.USE_X_ACCEL:
        response = HttpResponse(content_type="application/pdf")
        response["X-Accel-Redirect"] = f"/protected/invoices/{invoice.file.name}"   # internal Nginx location
        response["Content-Disposition"] = f'attachment; filename="invoice-{invoice.number}.pdf"'
        return response
    return FileResponse(invoice.file.open("rb"), as_attachment=True,
                        filename=f"invoice-{invoice.number}.pdf")
```

### 5.4 Cookies, headers and caching decorators

```python
from django.views.decorators.cache import cache_control, never_cache
from django.views.decorators.vary import vary_on_headers

@cache_control(public=True, max_age=300)
@vary_on_headers("Accept-Language")
def pricing(request):
    response = render(request, "pricing.html")
    response.set_cookie(
        "seen_pricing", "1",
        max_age=60 * 60 * 24 * 30, secure=True, httponly=True, samesite="Lax",
    )
    return response

@never_cache                      # Cache-Control: max-age=0, no-cache, no-store, must-revalidate, private
@login_required
def account_dashboard(request):
    ...
```

## 6. Advantages, Disadvantages & Trade-offs

| Response | Memory | Middleware can modify body | Worker held | Use for |
|---|---|---|---|---|
| `HttpResponse` / `render` | whole body | yes | until built | HTML pages, small payloads |
| `JsonResponse` | whole body | yes | until built | small JSON APIs without DRF |
| `TemplateResponse` | whole body | yes, before render | until built | CBVs, testable context |
| `StreamingHttpResponse` | one chunk | chunk-wise only | whole stream | exports, NDJSON, SSE (prefer ASGI) |
| `FileResponse` | one block | no | whole download | local files, small-to-medium downloads |
| `X-Accel-Redirect` / signed URL | none | n/a | milliseconds | large private files |

| FBV | CBV |
|---|---|
| Explicit, linear, easy to read and decorate | Reuse via inheritance and mixins, generic CRUD in a few lines |
| Repetition across similar views | Control flow hidden across MRO; harder for newcomers |

### When to use

- FBVs for one-off, logic-heavy endpoints, webhooks, and anything whose flow you want visible top to bottom.
- `JsonResponse` for a handful of internal JSON endpoints; DRF once you need auth schemes, serializers, pagination or browsable docs.
- Streaming for large generated output where a background job would be overkill.

### When NOT to use

- Don't use `StreamingHttpResponse` for small responses — you lose `Content-Length`, ETags and simple error handling.
- Don't serve big files through Django workers at scale; offload to Nginx, a CDN or pre-signed storage URLs.
- Don't put business logic directly in views if commands, tasks and APIs need the same logic; extract a service function.

## 7. Common Mistakes & Best Practices

**Reading JSON from `request.POST`.** It is empty for `application/json`. Use `json.loads(request.body)` (or DRF's `request.data`).

**Changing state on GET.** Links get prefetched, crawled and cached; a "delete" link called by a GET is a CSRF and data-loss bug (CSRF protection only covers unsafe methods). Restrict with `@require_POST` and use forms or buttons.

**`KeyError` on input.**

```python
# Before: missing field -> 500, logged as a server error
qty = int(request.POST["qty"])

# After: explicit validation -> 400 with a message (or use a Form)
try:
    qty = int(request.POST.get("qty", ""))
except ValueError:
    raise BadRequest("qty must be an integer")
```

**Rendering after a successful POST.** Leads to duplicate submissions on refresh. Redirect (PRG).

**Trusting client-supplied metadata.** `request.FILES["f"].content_type` and `.name` come from the client; `X-Forwarded-For` can be forged. Validate file contents, sanitize names (storage backends generate safe names), and read the client IP only from the header your own proxy sets — typically the right-most entry appended by your trusted proxy, not the left-most.

**Using `.get()` and getting a 500.** `Order.objects.get(pk=pk)` raises `DoesNotExist` → 500. Use `get_object_or_404`, and scope the query to the current user to avoid insecure direct object references.

**`HttpResponseRedirect` to user input.** `redirect(request.GET["next"])` is an open redirect. Validate with `url_has_allowed_host_and_scheme(next_url, allowed_hosts={request.get_host()}, require_https=request.is_secure())`.

**Best practices**

- Restrict methods with decorators; return 405 automatically rather than branching manually.
- Validate input with forms/serializers; raise `BadRequest` or return form errors.
- Scope every object lookup to the user or tenant (`get_object_or_404(Order, pk=pk, user=request.user)`).
- Prefer 404 over 403 when revealing existence is itself a leak.
- Use the right response class; set `Cache-Control` explicitly for private data.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: `RequestDataTooBig` / 400s on large forms.** *Symptom:* big admin formsets or bulk-edit pages fail with 400. *Root cause:* `DATA_UPLOAD_MAX_MEMORY_SIZE` or `DATA_UPLOAD_MAX_NUMBER_FIELDS` exceeded. *Fix:* raise the limit only for the affected flow (or redesign it); these limits protect against memory and hash-collision DoS — don't set them to `None` globally.

**Pitfall: uploads fill the disk or memory.** Large uploads stream to `FILE_UPLOAD_TEMP_DIR`; a container with a tiny `/tmp` fails. Set Nginx `client_max_body_size`, validate size early, and for big files upload straight to S3 with pre-signed URLs.

**Pitfall: workers exhausted by slow clients or streams.** A sync worker serving a slow mobile client or a long CSV is blocked. Nginx buffering protects you from slow *uploads* and slow *readers* of normal responses; streams and SSE are not buffered meaningfully. Offload large exports to tasks; run long-lived streams on ASGI.

**Pitfall: wrong client IP / wrong scheme behind a load balancer.** `REMOTE_ADDR` is the proxy's address, `request.is_secure()` is false, and `build_absolute_uri()` generates `http://` links in emails. *Fix:* set `SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")` only if your proxy always sets/overwrites that header; use a vetted middleware (or `django-ipware`) configured for your proxy count to read the client IP.

**Pitfall: `DisallowedHost` noise.** Scanners hit your IP with random `Host` headers; `get_host()` raises `DisallowedHost` → 400 and a `django.security.DisallowedHost` log. Configure Nginx to drop unknown hosts and route that logger to a lower level.

**Debugging**

- `request.META` dump in a debug view (never in production) to see what the proxy actually sends.
- Django Debug Toolbar's *Request* and *Headers* panels.
- `RequestFactory` in tests to build requests with arbitrary headers: `RequestFactory().post("/x/", data, content_type="application/json", headers={"X-Signature": "..."})`.
- `curl -v` to see redirects, `Set-Cookie` and caching headers exactly.

**Scaling notes.** Views should be fast, stateless and bounded: no unbounded queries (paginate), no unbounded bodies (limits), no unbounded outbound calls (timeouts). Measure p95 per route; anything consistently above a few hundred milliseconds is a candidate for caching ([Ch 29](topic.html?p=29-caching)), query optimization ([Ch 13](topic.html?p=13-queryset-optimization)) or background processing.

## 9. Interview Questions

**Q: What is a Django view, minimally?**
A: Any callable that accepts an `HttpRequest` as its first argument (plus URL kwargs) and returns an `HttpResponse`, or raises an exception that Django converts into one, such as `Http404`. Function-based views are plain functions; class-based views produce such a function through `as_view()`; DRF views do the same with their own request and response wrappers. Returning `None` raises a `ValueError` and becomes a 500.

**Q: What is the difference between `request.POST` and `request.body`?**
A: `request.body` is the raw request body as bytes, read from the input stream on first access and limited by `DATA_UPLOAD_MAX_MEMORY_SIZE`. `request.POST` is a parsed `QueryDict` of form fields, populated only for `application/x-www-form-urlencoded` and `multipart/form-data` requests — it is empty for JSON. For JSON you parse `request.body` yourself (or use DRF's `request.data`). For multipart requests, once the parser has consumed the stream via `request.POST`, accessing `request.body` raises `RawPostDataException`.

**Q: What is a `QueryDict` and why is it immutable?**
A: It is a dictionary subclass that can hold several values per key, because query strings and forms can repeat keys (`?tag=a&tag=b`). `get()` returns the last value and `getlist()` returns all of them. The instances on the request are immutable so that one piece of code can't silently change what later code sees as the client's input; call `.copy()` to get a mutable version, for example to build a pagination link.

**Q: How do you return JSON from a plain Django view?**
A: Use `JsonResponse(data)`, which serializes with `DjangoJSONEncoder` (handling datetimes, decimals and UUIDs) and sets the content type. By default `safe=True` requires a dict at the top level; pass `safe=False` to return a list. For serious APIs — authentication schemes, validation, pagination, content negotiation — DRF is the better choice, but `JsonResponse` is fine for a few internal endpoints.

**Q: What does `get_object_or_404` do and why use it?**
A: It calls `get()` on a model, manager or QuerySet with the given filters and raises `Http404` if the object doesn't exist, instead of letting `DoesNotExist` bubble up as a 500. Passing a QuerySet lets you add `select_related` or scope the lookup, e.g. `get_object_or_404(Order.objects.filter(user=request.user), pk=pk)`, which also prevents users from reading other users' objects. It still raises `MultipleObjectsReturned` if the filter isn't unique.

**Q: What is the Post/Redirect/Get pattern and why use it?**
A: After a successful POST, the view returns a redirect (302/303) to a GET page instead of rendering HTML directly. The browser then loads that page with GET, so refreshing or pressing back repeats a harmless GET instead of re-submitting the form and creating a duplicate. On validation failure you re-render the form with errors without redirecting. Django's `redirect()` shortcut and the generic editing views implement this by default.

**Q: How would you stream a large CSV file to the user?**
A: Use `StreamingHttpResponse` with a generator that yields CSV lines — `csv.writer` over a pseudo-buffer whose `write` returns the line — and iterate the QuerySet with `.values_list(...).iterator(chunk_size=...)` so rows are fetched through a server-side cursor without filling the QuerySet cache. Set `Content-Disposition: attachment`. Memory stays flat, but the worker is busy for the whole download and mid-stream errors can't change the status code, so for very large exports a background task that writes to object storage and sends a link scales better.

**Q: What is the difference between `HttpResponse`, `StreamingHttpResponse` and `FileResponse`?**
A: `HttpResponse` holds the full body in memory, so middleware can inspect or rewrite it and `Content-Length` is known. `StreamingHttpResponse` wraps an iterator consumed while sending; it has no `.content`, middleware must handle it chunk by chunk, and the worker is occupied until the stream ends. `FileResponse` is a streaming subclass for file objects that sets content type, length and `Content-Disposition` and can use the server's `wsgi.file_wrapper` for efficient file sending.

**Q: How do decorators like `@login_required` and `@require_POST` work, and does their order matter?**
A: Each decorator wraps the view in a new function that runs a check before (and sometimes after) calling the original. They are applied bottom-up and run top-down, so the decorator closest to `def` is the innermost. Order matters: putting `@require_POST` outermost rejects a GET with 405 before the login redirect; putting `@login_required` outermost redirects anonymous GETs to login first. Put cheap rejecting checks outermost, and put `@transaction.atomic` innermost so it covers only the real work.

**Q: How do you return an error status from a view?**
A: Raise `Http404`, `PermissionDenied` or `BadRequest` (or `SuspiciousOperation`) and Django renders the configured handler with 404, 403 or 400. Alternatively return a response with an explicit status, such as `JsonResponse({...}, status=422)` or `HttpResponseNotAllowed(["POST"])`. Raising is preferable for standard cases because the response goes through your custom error templates and logging consistently, while explicit statuses are right for API-specific errors with a body.

**Q: How do you securely serve private, user-specific files that may be large? (Senior)**
A: Authorize in Django — look up the file scoped to `request.user`, returning 404 to avoid leaking existence — but don't stream the bytes through a Python worker. Either return an empty response with `X-Accel-Redirect` (Nginx) or `X-Sendfile` pointing at an internal-only location, so the web server sends the file, or redirect to a short-lived pre-signed S3/GCS URL. Set `Content-Disposition` with a safe filename, `Cache-Control: private, no-store`, and `X-Content-Type-Options: nosniff`, and never serve user uploads from the same origin as the app with an HTML content type. `FileResponse` is fine for small files or low traffic.

**Q: How do you get the client's real IP address when Django runs behind a load balancer, and what's the risk? (Senior)**
A: `REMOTE_ADDR` will be the proxy's address. The client IP is in `X-Forwarded-For`, but that header is a comma-separated list the client can pre-populate, so the left-most value is attacker-controlled. You must take the address added by your own trusted proxy: count trusted hops from the right, or have the edge proxy overwrite a dedicated header such as `X-Real-IP`. Implement that once in middleware or with a configured library like `django-ipware`, and use it consistently for rate limiting and audit logs — getting it wrong lets attackers bypass IP-based throttles.

**Q: A webhook endpoint fails signature verification intermittently and sometimes raises `RawPostDataException`. What's going on? (Senior)**
A: The signature must be computed over the exact raw bytes, so the view needs `request.body`. `RawPostDataException` means something read `request.POST` first on a multipart request, consuming the stream — commonly CSRF middleware on a non-exempt view, or a logging middleware that touches `POST`. I'd mark the webhook `@csrf_exempt` (the HMAC is the authenticity check), read `request.body` first, verify with `hmac.compare_digest` against the provider's header, and only then parse JSON. The intermittent signature failures are often from re-serializing the JSON before hashing, a different encoding, or a timestamp tolerance window, so verify the raw bytes and the provider's timestamp header exactly as documented.

**Q: When does `request.user` get populated and what is it for anonymous visitors?**
A: `AuthenticationMiddleware` attaches `request.user` as a lazy object that loads the user from the session on first access, so views that never touch it don't pay for the query. For visitors who aren't logged in it is an `AnonymousUser` instance, whose `is_authenticated` is `False`. It requires `SessionMiddleware` earlier in the stack, and in DRF, `request.user` is instead resolved by the configured authentication classes.

## 10. Quick Revision & Cheat Sheet

| Need | Use |
|---|---|
| Query params | `request.GET.get("q")`, `getlist("tag")` |
| Form fields | `request.POST` (urlencoded/multipart only) |
| JSON body | `json.loads(request.body)` |
| Files | `request.FILES["f"]` + `enctype="multipart/form-data"` |
| Headers | `request.headers["X-Foo"]`; raw: `request.META["HTTP_X_FOO"]` |
| Host/scheme | `get_host()`, `is_secure()`, `build_absolute_uri()` |
| HTML | `render(request, tpl, ctx)` |
| Redirect | `redirect("app:name", pk=1)` / `redirect(obj)` |
| JSON | `JsonResponse(dict)`, `safe=False` for lists |
| Big output | `StreamingHttpResponse(gen)`, `FileResponse(f)` |
| 404 | `get_object_or_404(qs, ...)`, `raise Http404` |
| 400/403 | `raise BadRequest`, `raise PermissionDenied` |
| Methods | `@require_POST`, `@require_http_methods([...])`, `@require_safe` |
| Caching headers | `@cache_control(...)`, `@never_cache`, `@vary_on_headers(...)` |

- View = callable(request) -> HttpResponse.
- `request.POST` is empty for JSON.
- The body stream is read once; read `request.body` before `POST` on multipart if you need raw bytes.
- `DoesNotExist` is a 500; use `get_object_or_404`.
- PRG after successful POSTs.
- Decorators apply bottom-up, run top-down.
- Streaming saves memory, costs a worker and error handling.
- Never trust `X-Forwarded-For`'s left-most value or a file's `content_type`.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" && django-admin startproject config . && python manage.py startapp shop`.

1. **Request explorer.** Build the `inspect` view from §5.1. Call it with `curl` using a query string with repeated keys, a custom header and a cookie; then POST JSON and form data and compare `request.POST` and `request.body`.
2. **The body trap.** Write a view that reads `request.POST` and then `request.body`; POST multipart data with `curl -F` and reproduce `RawPostDataException`. Reverse the order and show it works.
3. **PRG.** Implement a tiny "create note" form without redirect, submit, and refresh the page. Add `redirect()` and observe the difference.
4. **Streaming.** Create 200,000 rows with `bulk_create`, then export them with `StreamingHttpResponse` and with a naive `HttpResponse` built from a list; compare peak memory with `tracemalloc`.
5. **Decorator order.** Stack `@require_POST` and `@login_required` in both orders and record the responses for an anonymous GET.

**Mini project — Webhook receiver.** Build `POST /hooks/payments/` that is `@csrf_exempt`, verifies an HMAC-SHA256 signature over `request.body` using a secret from settings (`hmac.compare_digest`), rejects stale timestamps, parses JSON, records the event ID in a table with a unique constraint to ignore duplicates, and returns 200 quickly (enqueue the real work). Write tests with `RequestFactory` and `Client` for valid, tampered, replayed and malformed requests.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 03 · URL Routing & URLconf](topic.html?p=03-urls-routing), [Ch 05 · Django Template Language](topic.html?p=05-templates) (`render()` and `TemplateResponse`), [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation), [Ch 17 · Class-Based & Generic Views](topic.html?p=17-class-based-views), [Ch 20 · Static & Media Files](topic.html?p=20-static-media-files) (uploads and storage), [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers), [Ch 28 · Security](topic.html?p=28-security), [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi) (async views and streaming).

**Other handbooks:** [REST API · HTTP Methods & Idempotency](../rest-api/topic.html?p=06-http-methods-idempotency), [REST API · Status Codes](../rest-api/topic.html?p=07-status-codes), [REST API · HTTP Caching & ETags](../rest-api/topic.html?p=25-http-caching-etags), [REST API · Streaming, SSE & WebSockets](../rest-api/topic.html?p=30-streaming-sse-websockets).

- **Request and response objects** — Django docs · *Beginner* · every attribute of `HttpRequest`, `QueryDict` and the response classes. <https://docs.djangoproject.com/en/5.2/ref/request-response/>
- **Writing views** — Django docs · *Beginner* · views, errors and custom error handlers. <https://docs.djangoproject.com/en/5.2/topics/http/views/>
- **Django shortcut functions** — Django docs · *Beginner* · `render`, `redirect`, `get_object_or_404`. <https://docs.djangoproject.com/en/5.2/topics/http/shortcuts/>
- **View decorators** — Django docs · *Beginner* · method, conditional, caching and vary decorators. <https://docs.djangoproject.com/en/5.2/topics/http/decorators/>
- **File uploads** — Django docs · *Intermediate* · upload handlers, memory vs temp files, limits. <https://docs.djangoproject.com/en/5.2/topics/http/file-uploads/>
- **How to create CSV output** — Django docs · *Intermediate* · the official streaming CSV recipe. <https://docs.djangoproject.com/en/5.2/howto/outputting-csv/>
- **MDN: HTTP overview** — MDN Web Docs · *Beginner* · methods, headers and status codes the request/response objects model. <https://developer.mozilla.org/en-US/docs/Web/HTTP>
- **django-ipware** — GitHub · *Intermediate* · correct client-IP extraction behind proxies. <https://github.com/un33k/django-ipware>

---

*Django Handbook — chapter 04.*
