# 29 · Caching in Django

> **In one line:** Django's cache framework is one API (`django.core.cache`) over pluggable backends, exposed at four granularities — whole site, per view, template fragment and low-level keys — plus HTTP caching headers that let browsers and CDNs skip Django entirely; the hard part is never storing data, it is choosing the right layer, keying it correctly (`Vary`!) and invalidating it without serving stale or private data.

---

## 1. Overview

> **Builds on:** [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization) (fix the queries before you cache them), [Ch 18 · Middleware](topic.html?p=18-middleware) (per-site caching is a middleware pair), [Ch 27 · Sessions, Cookies & Messages](topic.html?p=27-sessions-cookies) (sessions add `Vary: Cookie`), [Ch 05 · Templates](topic.html?p=05-templates) (fragment caching).

A product page that takes 180 ms — 12 queries, a pricing service call, a template with 400 loop iterations — is fine at ten requests per second and a disaster at a thousand. Most of that work produces the same bytes for every visitor for minutes at a time. **Caching** stores the result of expensive work and reuses it, trading freshness and memory for latency and throughput.

The naive approaches fail in predictable ways. A module-level dict (`_cache = {}`) works on `runserver` and silently diverges across Gunicorn workers, grows forever, and is wiped on every deploy. Caching an entire page "because it is slow" leaks one user's name and cart into everyone else's page the moment the page contains anything personal. Caching without an invalidation plan turns "the price changed" into a support ticket about why the site still shows the old one for an hour.

Django's **cache framework** gives you:

- **Backends** behind one interface: Redis (built in since Django 4.0), Memcached, database, file system, local memory and a dummy backend for development.
- **Four granularities:** the **per-site cache** (`UpdateCacheMiddleware` + `FetchFromCacheMiddleware`), the **per-view cache** (`@cache_page`), **template fragment caching** (`{% cache %}`), and the **low-level API** (`cache.get/set/get_or_set/delete/incr`).
- **HTTP caching** helpers — `@cache_control`, `@never_cache`, `@vary_on_headers`, `@condition`/`@etag`/`@last_modified`, `ConditionalGetMiddleware` — so browsers and CDNs can cache or revalidate without your code running at all.

This chapter shows how each layer works internally (how `cache_page` builds keys, what `Vary` does to them), how to pick one, how to invalidate correctly (TTL, explicit delete on commit, versioned keys), and the production failure modes: per-process `locmem`, stampedes, cached private data, pickle pitfalls and Redis memory pressure. Redis itself — eviction policies, persistence, clustering — is covered in depth in the [Redis Caching handbook](../redis-caching/topic.html?p=03-redis-as-a-cache).

## 2. Core Concepts

- **`CACHES` setting** — a dict of aliases (`"default"` required) each with `BACKEND`, `LOCATION`, `TIMEOUT`, `OPTIONS`, `KEY_PREFIX`, `VERSION`. *Why it matters:* you can have separate caches for pages, sessions and throttling with different eviction rules.
- **`TIMEOUT`** — default 300 seconds; `None` means never expire; `0` means expire immediately (do not cache). *Why:* forgetting it means everything lives five minutes, which is either too long or too short.
- **Cache key** — the final key is `KEY_FUNCTION(key, KEY_PREFIX, VERSION)`, by default `"<prefix>:<version>:<key>"`. *Why:* prefixes isolate environments sharing one Redis; versions invalidate whole namespaces.
- **Serialization** — values are pickled (Redis, Memcached, db, file backends). *Why:* any picklable object can be cached, but class changes can break old entries and a writable cache becomes a code-execution vector.
- **Cache-aside** — read cache, on miss compute and set. Django's `get_or_set` is the one-liner. *Why:* the default pattern; see [Redis Caching · Cache-Aside](../redis-caching/topic.html?p=08-cache-aside).
- **Per-view cache (`cache_page`)** — caches the full `HttpResponse` keyed by URL and `Vary` headers. *Why:* biggest win for anonymous, read-heavy pages.
- **Per-site cache** — the same mechanism applied to every GET/HEAD via middleware. *Why:* blunt, rarely right for apps with logged-in users.
- **Fragment cache** — `{% cache 600 "sidebar" user.id %}` caches a rendered block. *Why:* caches the expensive, shared parts of a personalized page.
- **`Vary` header** — names request headers that change the response; Django's page cache folds them into the key. *Why:* `Vary: Cookie` makes the cache per-user; missing `Vary` serves one user's page to another.
- **Invalidation** — expire by TTL, delete on change, or bump a version. *Why:* the hard problem; see [Redis Caching · Cache Invalidation](../redis-caching/topic.html?p=12-cache-invalidation).
- **Stampede (dog-pile)** — many requests miss simultaneously and all recompute. *Why:* can take down the database exactly when a hot key expires; see [Redis Caching · Cache Stampede](../redis-caching/topic.html?p=15-cache-stampede).
- **Conditional GET** — `ETag`/`Last-Modified` with `If-None-Match`/`If-Modified-Since` lets the server answer `304 Not Modified`. *Why:* saves bandwidth and rendering even when content must be revalidated.

## 3. Theory & Principles

### The backend abstraction

Every backend subclasses `django.core.cache.backends.base.BaseCache`, which implements key construction (`make_and_validate_key`), default timeouts and the async methods (`aget`, `aset`, ... — by default thin `sync_to_async` wrappers). `django.core.cache.caches["alias"]` returns a per-thread backend instance (connections are not shared across threads); `django.core.cache.cache` is a proxy for `caches["default"]`.

| Backend | Shared across processes | Atomic `incr` | Notes |
|---|---|---|---|
| `django.core.cache.backends.redis.RedisCache` | Yes | Yes | Built in since 4.0; uses redis-py; a list `LOCATION` = first is primary for writes, others replicas for reads |
| `django.core.cache.backends.memcached.PyMemcacheCache` | Yes | Yes | Keys max 250 bytes, no spaces; values default max about 1 MB; no persistence |
| `django.core.cache.backends.db.DatabaseCache` | Yes | No | Needs `createcachetable`; adds DB load — usually the wrong place |
| `django.core.cache.backends.filebased.FileBasedCache` | Same host only | No | Culls by scanning; slow with many entries |
| `django.core.cache.backends.locmem.LocMemCache` (default) | **No — per process** | Within process | LRU with `MAX_ENTRIES` (default 300); fine for tests and single-process dev |
| `django.core.cache.backends.dummy.DummyCache` | — | — | Implements the API, stores nothing |

The third-party **django-redis** backend predates the built-in one and adds features the built-in lacks: `cache.lock()`, `delete_pattern()`, `ttl()`, compression and pluggable serializers. Many production codebases still use it.

### How `cache_page` builds its key and decides what to store

`@cache_page(timeout)` wraps the view with `CacheMiddleware` (the combined fetch/update middleware). On a request:

1. **Fetch phase** (`FetchFromCacheMiddleware.process_request`): only for `GET` and `HEAD`. It calls `get_cache_key(request, key_prefix, "GET", cache)`, which first looks up a **header list** stored under a key derived from the full URL (`views.decorators.cache.cache_header.<prefix>.<md5 of absolute URL>`). That list records which request headers the cached response varies on. It then builds the **page key** (`views.decorators.cache.cache_page.<prefix>.GET.<md5 url>.<md5 of those header values>`). Hit: return the stored response; the view never runs.
2. **Update phase** (`UpdateCacheMiddleware.process_response`): stores the response only if it is a non-streaming 200 (or 304) to a GET/HEAD, the response is not `Cache-Control: private`, and the timeout is not zero. It also skips responses that set cookies on cookie-less requests while varying on `Cookie` (e.g. the first CSRF cookie). It calls `learn_cache_key()`, which saves the response's `Vary` header list under the header-list key and then stores the response under the page key. It also **patches the response headers** with `Cache-Control: max-age=<timeout>` and `Expires`, so browsers cache it too.

Two consequences everyone misses. First, if the response has `Vary: Cookie`, the page key includes the cookie value, so the cache is effectively per-session — safe, but with a hit rate near zero for logged-in traffic. Second, **where** the caching runs decides which `Vary` headers it sees. `SessionMiddleware` adds `Vary: Cookie` in *its* response phase. With the per-site middleware, `UpdateCacheMiddleware` is outermost and sees it. With the `@cache_page` **decorator**, the response is stored *inside* the middleware stack — before `SessionMiddleware` has added `Vary: Cookie` — so a decorated view that renders `request.user` can be cached once and served to everyone unless you add `@vary_on_cookie` (or never decorate personalized views).

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj29a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="dj29b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">cache_page: two keys, Vary-aware lookup</text>
  <rect x="20" y="46" width="200" height="54" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="120" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">GET /products/?page=2</text>
  <text x="120" y="86" text-anchor="middle" fill="#334155" font-size="10">Accept-Language: de</text>
  <path d="M220,72 L262,72" stroke="#334155" stroke-width="2" marker-end="url(#dj29a)"/>
  <rect x="264" y="40" width="300" height="66" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="414" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">1. header-list key</text>
  <text x="276" y="78" fill="#334155" font-size="10">cache_header.prefix.md5(absolute URL)</text>
  <text x="276" y="94" fill="#334155" font-size="10">value: ["HTTP_ACCEPT_LANGUAGE", "HTTP_COOKIE"]</text>
  <path d="M414,106 L414,132" stroke="#334155" stroke-width="2" marker-end="url(#dj29a)"/>
  <rect x="264" y="134" width="300" height="66" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="414" y="154" text-anchor="middle" fill="#1e293b" font-weight="bold">2. page key</text>
  <text x="276" y="172" fill="#334155" font-size="10">cache_page.prefix.GET.md5(URL).md5(values</text>
  <text x="276" y="188" fill="#334155" font-size="10">of the listed headers in THIS request)</text>
  <path d="M564,166 L620,166" stroke="#16a34a" stroke-width="2" marker-end="url(#dj29b)"/>
  <text x="592" y="158" text-anchor="middle" fill="#16a34a" font-size="10">hit</text>
  <rect x="622" y="134" width="238" height="66" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="741" y="158" text-anchor="middle" fill="#1e293b" font-weight="bold">return stored response</text>
  <text x="741" y="176" text-anchor="middle" fill="#334155" font-size="10">view, ORM, template skipped</text>
  <path d="M414,200 L414,226" stroke="#334155" stroke-width="2" marker-end="url(#dj29a)"/>
  <text x="426" y="218" fill="#334155" font-size="10">miss</text>
  <rect x="264" y="228" width="300" height="50" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="414" y="250" text-anchor="middle" fill="#1e293b" font-weight="bold">3. view runs</text>
  <text x="414" y="266" text-anchor="middle" fill="#334155" font-size="10">response carries Vary: Accept-Language, Cookie</text>
  <path d="M414,278 L414,304" stroke="#334155" stroke-width="2" marker-end="url(#dj29a)"/>
  <rect x="164" y="306" width="500" height="82" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="414" y="326" text-anchor="middle" fill="#1e293b" font-weight="bold">4. UpdateCacheMiddleware: store only if safe</text>
  <text x="178" y="346" fill="#334155" font-size="10">GET/HEAD, status 200, not streaming, not Cache-Control: private, timeout &gt; 0</text>
  <text x="178" y="362" fill="#334155" font-size="10">learn_cache_key(): save header list, then response under the page key</text>
  <text x="178" y="378" fill="#334155" font-size="10">patch headers: Cache-Control: max-age=timeout, Expires</text>
  <rect x="20" y="134" width="220" height="140" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="130" y="154" text-anchor="middle" fill="#1e293b" font-weight="bold">Why Vary matters</text>
  <text x="32" y="176" fill="#334155" font-size="10">Vary: Cookie puts the session</text>
  <text x="32" y="192" fill="#334155" font-size="10">cookie into the page key:</text>
  <text x="32" y="208" fill="#334155" font-size="10">safe, but one entry per user.</text>
  <text x="32" y="232" fill="#334155" font-size="10">No Vary on a personalized</text>
  <text x="32" y="248" fill="#334155" font-size="10">page: user A's HTML is served</text>
  <text x="32" y="264" fill="#334155" font-size="10">to user B.</text>
  <text x="440" y="414" text-anchor="middle" fill="#334155" font-size="10">The header-list key is why changing Vary on a deployed view needs a key_prefix bump to take effect cleanly.</text>
</svg>
```

### Invalidation strategies

There are three families; pick per data item.

1. **Time-based (TTL).** Accept staleness up to N seconds. Simple, self-healing, and the only option for `cache_page` (which has no per-URL delete API you would want to rely on). Use short TTLs for volatile data.
2. **Event-based (delete on write).** When the source changes, delete the key. In Django, do it in `transaction.on_commit()` — deleting inside the transaction lets a concurrent reader repopulate the cache from the *old* committed row before your commit lands.
3. **Version-based (namespacing).** Store a version counter (`cache.incr("catalog:v")`) and include it in every catalog key. Bumping it invalidates millions of keys in O(1); the old ones age out by TTL. Django's `version=` argument and `VERSION` setting are the built-in form of this.

The delete-on-commit race, step by step:

```text
writer: BEGIN; UPDATE product SET price=9 ...; cache.delete("p:1")   (inside txn)
reader:                            cache miss on "p:1" -> SELECT -> sees OLD price 10 (not committed yet)
reader:                            cache.set("p:1", price=10, 1h)
writer: COMMIT
result: cache holds the old price for an hour.
fix:    transaction.on_commit(lambda: cache.delete("p:1"))
```

## 4. Architecture & Workflow

A request can be satisfied at any of several layers; each layer closer to the user is cheaper and harder to invalidate.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj29c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Caching layers in a Django deployment</text>
  <rect x="20" y="44" width="130" height="300" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="85" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Browser</text>
  <text x="30" y="90" fill="#334155" font-size="10">Cache-Control</text>
  <text x="30" y="104" fill="#334155" font-size="10">max-age, ETag</text>
  <text x="30" y="118" fill="#334155" font-size="10">304 revalidation</text>
  <text x="30" y="318" fill="#dc2626" font-size="10">cannot purge</text>
  <path d="M150,190 L172,190" stroke="#2563eb" stroke-width="2" marker-end="url(#dj29c)"/>
  <rect x="174" y="44" width="130" height="300" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="239" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">CDN / Nginx</text>
  <text x="184" y="90" fill="#334155" font-size="10">public, s-maxage</text>
  <text x="184" y="104" fill="#334155" font-size="10">stale-while-revalidate</text>
  <text x="184" y="118" fill="#334155" font-size="10">static files</text>
  <text x="184" y="318" fill="#d97706" font-size="10">purge API, slow</text>
  <path d="M304,190 L326,190" stroke="#2563eb" stroke-width="2" marker-end="url(#dj29c)"/>
  <rect x="328" y="44" width="380" height="300" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="518" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Django process</text>
  <rect x="340" y="80" width="356" height="44" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="350" y="98" fill="#1e293b" font-size="10" font-weight="bold">Per-site: UpdateCacheMiddleware ... FetchFromCacheMiddleware</text>
  <text x="350" y="114" fill="#334155" font-size="10">every anonymous GET/HEAD; first and last in MIDDLEWARE</text>
  <rect x="340" y="132" width="356" height="44" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="350" y="150" fill="#1e293b" font-size="10" font-weight="bold">Per-view: @cache_page(60 * 15)</text>
  <text x="350" y="166" fill="#334155" font-size="10">whole response for one URL, keyed with Vary</text>
  <rect x="340" y="184" width="356" height="44" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="350" y="202" fill="#1e293b" font-size="10" font-weight="bold">Fragment: {% cache 600 "nav" request.LANGUAGE_CODE %}</text>
  <text x="350" y="218" fill="#334155" font-size="10">shared parts of a personalized page</text>
  <rect x="340" y="236" width="356" height="44" rx="6" fill="#ffffff" stroke="#16a34a"/>
  <text x="350" y="254" fill="#1e293b" font-size="10" font-weight="bold">Low-level: cache.get_or_set("p:42:v3", fn, 300)</text>
  <text x="350" y="270" fill="#334155" font-size="10">data, computed values, API responses; precise invalidation</text>
  <text x="340" y="304" fill="#334155" font-size="10">also in-process: @cached_property (per instance),</text>
  <text x="340" y="318" fill="#334155" font-size="10">functools.lru_cache (per process), cached template loader</text>
  <path d="M708,190 L730,190" stroke="#2563eb" stroke-width="2" marker-end="url(#dj29c)"/>
  <rect x="732" y="44" width="128" height="140" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="796" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Redis</text>
  <text x="742" y="90" fill="#334155" font-size="10">shared by all</text>
  <text x="742" y="104" fill="#334155" font-size="10">workers and hosts</text>
  <text x="742" y="118" fill="#334155" font-size="10">TTL + eviction</text>
  <rect x="732" y="204" width="128" height="140" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="796" y="226" text-anchor="middle" fill="#1e293b" font-weight="bold">PostgreSQL</text>
  <text x="742" y="250" fill="#334155" font-size="10">source of truth</text>
  <text x="742" y="264" fill="#334155" font-size="10">reached only</text>
  <text x="742" y="278" fill="#334155" font-size="10">on a miss</text>
  <text x="440" y="378" text-anchor="middle" fill="#334155" font-size="10">Left = cheapest per hit, hardest to invalidate. Right = most precise, costs a network round trip.</text>
</svg>
```

### Choosing a layer

| Layer | Granularity | Invalidation | Personalization | Typical use |
|---|---|---|---|---|
| Browser / CDN (headers) | URL | TTL, revalidation, CDN purge | Only with `private` / `Vary` | Static assets, public pages, public API GETs |
| Per-site middleware | Every URL | TTL only | Dangerous | Mostly-anonymous content sites |
| `cache_page` | One view's URLs | TTL (or key_prefix bump) | Via `Vary` (low hit rate) | Anonymous landing pages, public listings |
| Fragment | Template block | TTL, `make_template_fragment_key` delete | Pass vary-on args | Navigation, sidebars, expensive widgets |
| Low-level | Any value | Exact delete, versions | Key per user if needed | Query results, computed aggregates, third-party API calls |

### Per-site middleware order

```python
MIDDLEWARE = [
    "django.middleware.cache.UpdateCacheMiddleware",      # FIRST: runs last on the response
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
    "django.middleware.cache.FetchFromCacheMiddleware",   # LAST: runs last on the request
]
CACHE_MIDDLEWARE_ALIAS = "pages"
CACHE_MIDDLEWARE_SECONDS = 600
CACHE_MIDDLEWARE_KEY_PREFIX = "site"
```

`UpdateCacheMiddleware` must be outermost so it sees the response after every other middleware has added its headers (especially `Vary: Cookie` from sessions); `FetchFromCacheMiddleware` must be innermost so the session and auth middleware have run and the `Vary`-based key can be computed.

## 5. Implementation

### Simple example: configure Redis and use every layer

```bash
pip install "django~=5.2" "redis>=5" hiredis
```

```python
# settings.py
CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": "redis://127.0.0.1:6379/1",
        "TIMEOUT": 300,
        "KEY_PREFIX": "shop-prod",
    },
    "pages": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": "redis://127.0.0.1:6379/3",
        "TIMEOUT": 600,
    },
}
```

Per-view:

```python
# catalog/views.py
from django.views.decorators.cache import cache_page
from django.views.decorators.vary import vary_on_headers


@cache_page(60 * 15, cache="pages", key_prefix="catalog-v1")
@vary_on_headers("Accept-Language")
def category(request, slug):
    ...

# URLconf form, useful for cache-ing a CBV or a third-party view
path("about/", cache_page(60 * 60)(AboutView.as_view())),
```

Fragment:

```html
{% load cache %}
{% cache 600 category_sidebar category.pk request.LANGUAGE_CODE %}
  {% for c in category.children.all %}<a href="{{ c.get_absolute_url }}">{{ c.name }}</a>{% endfor %}
{% endcache %}
```

```python
from django.core.cache import cache
from django.core.cache.utils import make_template_fragment_key

cache.delete(make_template_fragment_key("category_sidebar", [category.pk, "en"]))
```

Low-level API tour:

```python
>>> from django.core.cache import cache
>>> cache.set("greeting", "hi", timeout=30)
>>> cache.get("greeting"), cache.get("missing", "default")
('hi', 'default')
>>> cache.add("greeting", "other")          # only if absent -> False
False
>>> cache.get_or_set("answer", lambda: 6 * 7, timeout=60)
42
>>> cache.set("hits", 0); cache.incr("hits"); cache.incr("hits", 10)
11
>>> cache.set_many({"a": 1, "b": 2}); cache.get_many(["a", "b", "c"])
{'a': 1, 'b': 2}
>>> cache.touch("a", 120)                   # extend TTL
True
>>> cache.set("cfg", "x", version=2); cache.get("cfg"), cache.get("cfg", version=2)
(None, 'x')
```

In async views use the `a`-prefixed methods: `await cache.aget(key)`, `await cache.aset(key, value)`.

### Real-world example: product detail with cache-aside, on-commit invalidation, versioned lists and stampede protection

```python
# catalog/cache.py
import random
from django.core.cache import cache

PRODUCT_TTL = 60 * 30
LIST_TTL = 60 * 5
_MISS = object()                       # sentinel: distinguishes "cached None" from "not cached"


def product_key(pk: int) -> str:
    return f"product:{pk}"


def catalog_version() -> int:
    v = cache.get("catalog:version")
    if v is None:
        cache.add("catalog:version", 1, timeout=None)   # add() is atomic: only one writer wins
        v = cache.get("catalog:version", 1)
    return v


def bump_catalog_version() -> None:
    try:
        cache.incr("catalog:version")
    except ValueError:                   # key missing
        cache.add("catalog:version", 1, timeout=None)


def jittered(ttl: int) -> int:
    return int(ttl * random.uniform(0.9, 1.1))           # spread expiries: avoid synchronized misses
```

```python
# catalog/services.py
from django.core.cache import cache
from django.db import transaction
from .cache import PRODUCT_TTL, LIST_TTL, _MISS, product_key, catalog_version, bump_catalog_version, jittered
from .models import Product


def get_product_card(pk: int) -> dict | None:
    key = product_key(pk)
    data = cache.get(key, _MISS)
    if data is not _MISS:
        return data
    # Simple stampede guard: one process recomputes, others briefly serve nothing or retry
    lock_key = f"lock:{key}"
    if cache.add(lock_key, 1, timeout=10):
        try:
            p = (Product.objects.select_related("brand").only("id", "name", "price", "brand__name")
                 .filter(pk=pk).first())
            data = None if p is None else {"id": p.id, "name": p.name, "price": str(p.price), "brand": p.brand.name}
            cache.set(key, data, jittered(PRODUCT_TTL))   # caches "not found" too (negative caching)
            return data
        finally:
            cache.delete(lock_key)
    # Lost the race: fall back to the DB rather than block
    p = Product.objects.filter(pk=pk).values("id", "name", "price").first()
    return p


def featured_products() -> list[dict]:
    key = f"featured:v{catalog_version()}"
    return cache.get_or_set(
        key,
        lambda: list(Product.objects.filter(featured=True).order_by("-score").values("id", "name", "price")[:20]),
        jittered(LIST_TTL),
    )


@transaction.atomic
def update_price(pk: int, new_price) -> None:
    Product.objects.filter(pk=pk).update(price=new_price)
    transaction.on_commit(lambda: cache.delete(product_key(pk)))
    transaction.on_commit(bump_catalog_version)        # every list keyed on the version is now stale
```

Generic invalidation from signals (remember `QuerySet.update()` and `bulk_update()` do **not** send `post_save`, so services must still invalidate explicitly):

```python
# catalog/signals.py  (connected in CatalogConfig.ready)
from django.db import transaction
from django.db.models.signals import post_delete, post_save
from django.dispatch import receiver
from django.core.cache import cache
from .cache import product_key, bump_catalog_version
from .models import Product


@receiver([post_save, post_delete], sender=Product, dispatch_uid="product_cache_invalidate")
def invalidate_product(sender, instance, **kwargs):
    transaction.on_commit(lambda: cache.delete(product_key(instance.pk)))
    transaction.on_commit(bump_catalog_version)
```

HTTP caching for a public API endpoint with ETag revalidation:

```python
# catalog/api.py
import hashlib
from django.http import JsonResponse
from django.views.decorators.cache import cache_control
from django.views.decorators.http import condition
from .models import Product


def product_etag(request, pk):
    row = Product.objects.filter(pk=pk).values_list("updated_at", flat=True).first()
    return None if row is None else hashlib.md5(row.isoformat().encode()).hexdigest()


@cache_control(public=True, max_age=60, s_maxage=300, stale_while_revalidate=30)
@condition(etag_func=product_etag)
def product_json(request, pk):
    p = Product.objects.values("id", "name", "price").get(pk=pk)
    p["price"] = str(p["price"])
    return JsonResponse(p)
```

```text
$ curl -i https://shop.example.com/api/products/42/
HTTP/1.1 200 OK
Cache-Control: public, max-age=60, s-maxage=300, stale-while-revalidate=30
ETag: "9b2c..."
$ curl -i -H 'If-None-Match: "9b2c..."' https://shop.example.com/api/products/42/
HTTP/1.1 304 Not Modified
```

The `etag_func` costs a single indexed one-column query, far cheaper than rendering; the CDN serves most requests for 300 s without reaching Django. Personal pages get the opposite: `@never_cache` or `@cache_control(private=True, no_store=True)`. The HTTP side is covered in depth in [REST API · HTTP Caching & ETags](../rest-api/topic.html?p=25-http-caching-etags).

### Caching expensive aggregates in DRF

```python
from rest_framework.decorators import api_view
from rest_framework.response import Response
from django.core.cache import cache
from django.db.models import Count, Sum


@api_view(["GET"])
def dashboard_stats(request):
    key = f"stats:tenant:{request.user.tenant_id}"     # tenant in key: never share across tenants
    stats = cache.get_or_set(
        key,
        lambda: Order.objects.filter(tenant_id=request.user.tenant_id)
                .aggregate(n=Count("id"), revenue=Sum("total")),
        timeout=120,
    )
    return Response(stats)
```

## 6. Advantages, Disadvantages & Trade-offs

| Choice | Pros | Cons |
|---|---|---|
| Redis (built-in backend) | Shared, fast, atomic incr, persistence options, also usable for sessions and throttling | Another stateful service; memory sizing and eviction to manage |
| django-redis | Locks, `delete_pattern`, compression, TTL inspection | Third-party dependency |
| Memcached | Simple, multi-threaded, predictable LRU | No persistence, 250-byte keys, about 1 MB values, fewer data structures |
| LocMem | Zero setup | Per process: inconsistent across workers, invisible to other hosts |
| DatabaseCache | No extra service | Adds load to the thing you are trying to protect |
| Long TTLs | High hit rate | Staleness |
| Delete-on-write | Fresh data | Every write path must remember; missed paths (`update()`) cause stale reads |
| Versioned keys | O(1) mass invalidation | Old keys linger until TTL/eviction, using memory |

### When to use

- Cache **after** fixing N+1 and indexes — caching a bad query hides it until the cache is cold (deploys, evictions) and then it hurts more.
- Low-level cache for data read far more often than written, expensive to compute, and tolerant of seconds-to-minutes staleness.
- `cache_page` / CDN for anonymous, public, identical-for-everyone responses.
- Fragment caching for shared pieces of personalized pages.
- ETags for resources clients poll.

### When NOT to use

- Not for data that must be strongly consistent (balances, inventory decrements) — read the DB, use `select_for_update` or atomic `F()` updates (see [Ch 14](topic.html?p=14-transactions-concurrency)).
- Not `cache_page` or per-site caching on pages containing user-specific content without correct `Vary` / `private`.
- Not as the only copy of data — caches evict.
- Not `locmem` in any multi-process deployment for anything that must be consistent (sessions, rate limits, locks).

## 7. Common Mistakes & Best Practices

**1. `LocMemCache` in production.** It is the default when `CACHES` is unset. With 8 Gunicorn workers you have 8 independent caches: invalidation in one worker leaves 7 stale, DRF throttles allow 8x the rate, and `cache.add`-based locks do not lock. Configure Redis or Memcached.

**2. Caching personalized responses.** `@cache_page` on a view that renders `request.user.username` serves one user's page to others: the decorator stores the response before `SessionMiddleware` adds `Vary: Cookie`, so the cookie is not part of the key. Prefer fragment caching around the shared parts and keep the personal parts uncached; or use `@vary_on_cookie` explicitly.

**3. Not distinguishing "cached None" from a miss.**

```python
# Before: a product that doesn't exist is re-queried on every request
data = cache.get(key)
if data is None:
    data = load()          # returns None for missing products
    cache.set(key, data)
# After: sentinel default
data = cache.get(key, _MISS)
if data is _MISS:
    data = load()
    cache.set(key, data, 60)
```

**4. Invalidating inside the transaction.** See the race in §3. Use `transaction.on_commit`.

**5. Caching QuerySets or model instances.** Pickling a QuerySet evaluates it and stores all rows; pickled model instances break or misbehave after a field is added and old entries are unpickled by new code. Cache plain dicts/lists (`values()`), and include a schema version in the key prefix.

**6. Unbounded key cardinality.** `cache_page` on a search view caches every distinct `?q=` permanently-until-TTL; bots generate millions of keys and evict everything useful. Do not page-cache high-cardinality URLs; normalize parameters for low-level keys.

**7. Forgetting `cache_page` sets browser headers.** It adds `Cache-Control: max-age=<timeout>`. Even after you clear Redis, browsers keep their copy. For server-side-only caching use the low-level API or `cache_page` combined with `@cache_control(max_age=0)` (inner decorator) — or accept it deliberately.

**8. `cache.clear()` on a shared Redis.** It flushes the whole Redis DB, including other apps' and sessions' keys if they share it. Separate DBs/instances per purpose, and invalidate by version instead.

**Best practices:** one key-builder module per domain (no ad-hoc f-strings scattered through views); include tenant/user in keys for scoped data; TTL on everything (no `timeout=None` except version counters); jitter TTLs; measure hit rate before and after; never cache what you have not first profiled.

## 8. Production: Pitfalls, Debugging & Scaling

**Production story — the post-deploy stampede.** A homepage aggregate took 2 s to compute and was cached for 10 minutes. A deploy changed `KEY_PREFIX`, so every key missed at once; 400 concurrent requests computed it simultaneously and saturated the database connection pool, causing a site-wide outage. *Fixes:* a lock (`cache.add(lock_key)` or django-redis `cache.lock()`) so one request recomputes while others serve a stale copy; warm critical keys from a post-deploy job; never change prefixes during peak; jittered TTLs. For hot keys, refresh-ahead from a Celery beat task so users never see a miss. Background: [Redis Caching · Cache Stampede](../redis-caching/topic.html?p=15-cache-stampede) and [Hot Keys & Avalanche](../redis-caching/topic.html?p=17-hot-keys-avalanche).

**Production story — stale prices after a bulk import.** An admin action used `Product.objects.filter(...).update(price=F("price") * 1.1)`. No `post_save` fired, so per-product keys stayed stale for 30 minutes. *Fix:* bulk paths call an explicit invalidation (`cache.delete_many([...])` plus a version bump) in `on_commit`.

**Production story — user data leak through the CDN.** An API returned `Cache-Control: public, max-age=60` from a shared decorator, including `/api/me/`. The CDN cached one user's profile and served it to others. *Fix:* default `private, no-store` for authenticated endpoints, and an allowlist for public ones; CDN configured to never cache responses to requests with `Authorization` or session cookies.

**Redis memory pressure.** Symptoms: rising latency, `OOM command not allowed` errors, or (with an eviction policy) mysteriously low hit rates. Check `INFO memory` and `INFO stats` (`evicted_keys`, `keyspace_hits`/`keyspace_misses`). Set `maxmemory` and `maxmemory-policy allkeys-lru` (or `volatile-lru` if non-expiring keys must survive) on a cache-only instance. See [Redis Caching · Memory & Eviction](../redis-caching/topic.html?p=07-memory-and-eviction).

**Debugging.**

- django-debug-toolbar's **Cache panel** lists every cache call, hit/miss and time per request.
- `redis-cli MONITOR` (briefly, never on a busy production node) or `redis-cli --bigkeys` / `--memkeys` to find heavy keys.
- Log hit/miss counters per key family to your metrics system; a hit rate below about 80% for a supposedly hot family means the keying or TTL is wrong.
- `curl -I` to confirm `Cache-Control`, `Vary`, `ETag`, `Age` and CDN hit headers.

**Scaling.** One Redis primary handles a very large request rate for small values; scale out reads with replicas (the built-in backend sends reads to the replicas listed after the first `LOCATION`), shard with Redis Cluster for memory, and keep values small (compress large blobs with django-redis or store ids). Network round trips dominate: batch with `get_many`/`set_many`, and consider a small per-request in-memory memo for keys read many times in one request.

## 9. Interview Questions

**Q: What cache backends does Django support, and which would you use in production?**
A: Built-in: Redis (since 4.0), Memcached (`PyMemcacheCache`, `PyLibMCCache`), database, file-based, local memory and dummy. In production use Redis or Memcached because they are shared across all worker processes and hosts and support atomic increments. Redis adds persistence options and richer data types and can also back sessions, throttling and Celery. Local memory is per process, so it is only suitable for tests or single-process development.

**Q: What are the different levels of caching in Django?**
A: Per-site caching with `UpdateCacheMiddleware` (first) and `FetchFromCacheMiddleware` (last) caches every GET/HEAD response. Per-view caching with `@cache_page(timeout)` caches one view's full response. Template fragment caching with `{% cache timeout name vary_args %}` caches part of a page. The low-level API (`cache.get`, `set`, `get_or_set`, `delete`, `incr`, `get_many`) caches arbitrary values. On top of that, HTTP headers (`Cache-Control`, `ETag`) let browsers and CDNs cache without hitting Django.

**Q: What is the difference between `cache_page` and the low-level cache API?**
A: `cache_page` stores an entire `HttpResponse` keyed by URL, method and `Vary` headers; the view does not run on a hit, which is maximal savings but coarse — it cannot be personalized cheaply, invalidates only by TTL in practice, and also sets browser `Cache-Control` headers. The low-level API caches specific values you choose — a query result, a computed aggregate, an external API response — with keys you control, so you can invalidate precisely on writes and still render per-user templates around cached data. Use `cache_page` for public pages and low-level caching for data.

**Q: How does Django build the cache key for `cache_page`, and why does `Vary` matter?**
A: It hashes the full absolute URL (including the query string) together with the method and the values of the request headers listed in the response's `Vary` header; the list of varying headers is itself cached under a URL-based key by `learn_cache_key`. If a response says `Vary: Cookie`, the session cookie is part of the key, so each user gets their own entry. If a personalized response does not vary on the right header, one user's page can be served to another. A classic trap: the `@cache_page` decorator caches inside the middleware stack, before `SessionMiddleware` adds `Vary: Cookie`, so decorated views that use `request.user` need an explicit `@vary_on_cookie`. `vary_on_headers` and `vary_on_cookie` add headers explicitly.

**Q: How do you invalidate cached data when the underlying model changes?**
A: Delete or overwrite the affected keys when the data changes, from the service layer or a `post_save`/`post_delete` receiver, and do it in `transaction.on_commit` so a concurrent reader cannot repopulate the key with pre-commit data. For collections, include a version number in the key and bump it on change, invalidating all of them at once. Remember that `QuerySet.update()`, `bulk_create` and `bulk_update` bypass signals, so those paths must invalidate explicitly. Always keep a TTL as a safety net.

**Q: What is the default cache timeout and what do `None` and `0` mean?**
A: The default `TIMEOUT` is 300 seconds. Passing `timeout=None` stores the value with no expiry; `timeout=0` expires it immediately, effectively not caching. The `TIMEOUT` in a `CACHES` entry sets the default for that alias; `cache_page` and `{% cache %}` take their own timeouts. `cache_page` also uses its timeout for the `max-age` it writes into the response headers.

**Q: Why is LocMemCache a problem in production?**
A: Each process has its own private in-memory dict, so with multiple Gunicorn workers or multiple hosts each one has a different cache. Invalidating a key in one worker leaves the others stale, cache-based locks do not exclude each other, and DRF throttling or rate limiting counts per process, allowing many times the configured rate. It also disappears on every restart. Use Redis or Memcached for anything shared.

**Q: What is the difference between `cache.add`, `cache.set` and `cache.get_or_set`?**
A: `set` always writes. `add` writes only if the key does not exist and returns whether it did — on Redis and Memcached it is atomic, which makes it usable as a simple lock or "first writer wins" primitive. `get_or_set(key, default, timeout)` returns the cached value, or computes the default (a callable is called) and stores it with `add` semantics. `get_or_set` does not lock the computation, so many concurrent misses still compute concurrently.

**Q: How does HTTP caching with ETags work in Django?**
A: The server sends an `ETag` (a fingerprint of the representation) and the client sends it back as `If-None-Match`; if it still matches, the server returns `304 Not Modified` with no body. `ConditionalGetMiddleware` adds ETags to responses and returns 304s automatically, but the view still runs. The `@condition(etag_func=..., last_modified_func=...)` decorator, or `@etag` / `@last_modified`, compute the validator cheaply before the view, so a match skips the view entirely. Combine with `@cache_control(max_age=...)` to control how long clients may reuse without revalidating.

**Q: How would you prevent a cache stampede on an expensive key? (Senior)**
A: When a hot key expires, every concurrent request misses and recomputes, overloading the database. Mitigations: a recompute lock (`cache.add(lock_key, 1, timeout)` or django-redis `cache.lock`) so one request rebuilds while others serve a stale copy kept under a second key with a longer TTL; refresh-ahead from a Celery beat task so the key never expires under load; probabilistic early recomputation (recompute with rising probability as expiry nears); and jittered TTLs so many keys do not expire together. After deploys, warm critical keys before taking traffic and avoid changing key prefixes at peak.

**Q: Design a caching strategy for a product catalog with frequent price updates and a high read rate. (Senior)**
A: Separate data by volatility. Product descriptions and images change rarely: cache product cards with long, jittered TTLs and delete on commit when edited. Prices and stock change often and matter: either keep them out of the cached card and read them with one indexed query (or a tiny separate key with a short TTL), or delete on every price change via `on_commit`. Category and search listings use versioned keys (`catalog:v{n}`) bumped on any change, with short TTLs. Public pages go behind a CDN with `s-maxage` and `stale-while-revalidate`, and checkout always reads the database with row locks. Bulk import paths invalidate explicitly because `update()` does not send signals, and hit rates and staleness are measured per key family.

**Q: What are the risks of caching pickled objects, and how do you mitigate them? (Senior)**
A: Django's backends pickle values. Model instances and QuerySets pickled by one code version may fail to unpickle, or unpickle with missing attributes, after a deploy changes the class — producing errors right after deploys while old entries remain. Pickled QuerySets also store all evaluated rows and are large. Unpickling is code execution, so anyone who can write to your cache can run code in your app; the cache must be private and authenticated. Mitigate by caching plain JSON-like data (`values()`, dicts), versioning the key prefix with a schema version, and securing Redis (network isolation, ACLs, TLS).

**Q: How do you cache a page that is mostly shared but has a personalized header? (Senior)**
A: Do not cache the whole response per user. Cache the expensive shared parts as template fragments (`{% cache 600 "product_body" product.pk product.updated_at %}`) or as low-level data, and render the personalized header normally — it is usually cheap (the user is already loaded). Alternatively serve the page fully cached and anonymous from a CDN, and fetch the personalized bits with a small authenticated API call or edge-side includes. The key insight is to separate content by audience, not to accept `Vary: Cookie` and a near-zero hit rate.

## 10. Quick Revision & Cheat Sheet

| Task | API |
|---|---|
| Configure Redis | `"BACKEND": "django.core.cache.backends.redis.RedisCache"` |
| Default timeout | 300 s; `None` = forever; `0` = do not cache |
| Per-view | `@cache_page(60 * 15, cache="pages", key_prefix="v2")` |
| Per-site | `UpdateCacheMiddleware` first, `FetchFromCacheMiddleware` last |
| Fragment | `{% load cache %}{% cache 600 name arg1 arg2 %}...{% endcache %}` |
| Delete fragment | `cache.delete(make_template_fragment_key(name, [args]))` |
| Low-level | `get`, `set`, `add`, `get_or_set`, `get_many`, `set_many`, `delete`, `delete_many`, `incr`, `decr`, `touch`, `clear` |
| Async | `aget`, `aset`, `aget_or_set`, `adelete`, ... |
| Versions | `cache.set(k, v, version=2)`, `cache.incr_version(k)`, `VERSION`, `KEY_PREFIX` |
| HTTP | `@cache_control`, `@never_cache`, `@vary_on_headers`, `@vary_on_cookie`, `@condition`, `@etag`, `ConditionalGetMiddleware` |

- Fix queries first; cache second.
- `locmem` is per process — never for shared state.
- `Vary: Cookie` makes page caches per user; the `@cache_page` decorator runs before `SessionMiddleware` adds it, so add `@vary_on_cookie` yourself.
- Invalidate in `transaction.on_commit`.
- `update()` / `bulk_*` skip signals — invalidate explicitly.
- Use a sentinel to cache "not found".
- Jitter TTLs and lock hot recomputes to avoid stampedes.
- `cache_page` also sets browser `max-age`.
- Cache plain data, not model instances or QuerySets.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" redis django-debug-toolbar`, run Redis with `docker run -p 6379:6379 redis:7`.

1. **Backends side by side.** Configure `locmem`, then run `gunicorn -w 4` with a view that increments `cache.incr("hits")` and returns the value. Hit it 20 times and observe divergent counters; switch to Redis and repeat.
2. **cache_page and Vary.** Cache a view that shows `request.user`. Log in as two users and see whether pages leak; inspect `Vary`, then fix with fragment caching. Use `redis-cli KEYS "*cache_page*"` to see one key per session.
3. **Invalidation race.** Write a test with `TransactionTestCase` and two threads reproducing stale data when deleting inside `atomic()`; fix with `on_commit`.
4. **Versioned lists.** Implement `featured_products()` with a version key; bump it from an admin save and verify the new list appears while old keys remain until TTL.
5. **ETag.** Add `@condition(etag_func=...)` to a JSON endpoint and use `curl -H 'If-None-Match: ...'` to receive a 304. Check in debug-toolbar that the view body did not run.
6. **Stampede.** Make a view whose computation sleeps 2 s with a 5 s TTL; hit it with `hey -c 50` (or `ab`) and count computations; add the lock pattern and compare.

**Mini project — cached storefront.** A catalog with categories and products: CDN-friendly public category pages with `cache_control(public, s_maxage)`, fragment-cached product bodies keyed on `updated_at`, low-level cached product cards with on-commit invalidation, versioned featured lists, a stampede lock for the homepage aggregate, a Celery beat refresh-ahead task, and a hit/miss metrics counter displayed on a staff page.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization) · [Ch 14 · Transactions & Concurrency](topic.html?p=14-transactions-concurrency) · [Ch 18 · Middleware](topic.html?p=18-middleware) · [Ch 19 · Signals](topic.html?p=19-signals) · [Ch 27 · Sessions, Cookies & Messages](topic.html?p=27-sessions-cookies) · [Ch 23 · DRF Authentication, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling) · [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks) · [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases)

**Other handbooks:** [Redis Caching · Redis as a Cache](../redis-caching/topic.html?p=03-redis-as-a-cache) · [Cache-Aside](../redis-caching/topic.html?p=08-cache-aside) · [Cache Invalidation](../redis-caching/topic.html?p=12-cache-invalidation) · [Cache Stampede](../redis-caching/topic.html?p=15-cache-stampede) · [Memory & Eviction](../redis-caching/topic.html?p=07-memory-and-eviction) · [REST API · HTTP Caching & ETags](../rest-api/topic.html?p=25-http-caching-etags)

- **Django's cache framework** — Django docs · *Beginner* · backends, all four levels, keys, versions and the low-level API. <https://docs.djangoproject.com/en/5.2/topics/cache/>
- **Conditional View Processing** — Django docs · *Intermediate* · `@condition`, ETags and Last-Modified done right. <https://docs.djangoproject.com/en/5.2/topics/conditional-view-processing/>
- **django-redis** — GitHub · *Intermediate* · the feature-rich Redis backend with locks, patterns and compression. <https://github.com/jazzband/django-redis>
- **MDN: HTTP caching** — MDN · *Beginner* · Cache-Control, Vary, validators and shared caches. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Caching>
- **Redis: key eviction** — Redis docs · *Intermediate* · maxmemory policies for a cache-only Redis. <https://redis.io/docs/latest/develop/reference/eviction/>
- **web.dev: Prevent unnecessary network requests with the HTTP Cache** — web.dev · *Beginner* · practical Cache-Control and revalidation recipes for the browser layer. <https://web.dev/articles/http-cache>
- **django-debug-toolbar** — GitHub · *Beginner* · the cache panel shows every call and hit/miss per request. <https://github.com/django-commons/django-debug-toolbar>

---

*Django Handbook — chapter 29.*
