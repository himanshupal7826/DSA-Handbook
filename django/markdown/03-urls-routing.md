# 03 · URL Routing & URLconf

> **In one line:** A URLconf is an ordered list of patterns that Django walks top to bottom — descending into `include()`d URLconfs by prefix — until the first one matches, converts the captured values, and hands them to a view; naming every route and using `reverse()` with namespaces is what lets you change URLs without breaking links.

---

## 1. Overview

> **Builds on:** [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle) (where resolution happens in `_get_response`) and [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings) (`ROOT_URLCONF` and per-app modules).

Every web framework has to answer one question for every request: *which code handles this path?* The **naive approach** is a chain of `if path == "/orders/": ... elif path.startswith("/orders/"): ...` inside one function. It works for five endpoints and collapses at fifty: parameter parsing is repeated and inconsistent (`int(path.split("/")[2])` that crashes on `/orders/abc/`), there is no way to generate a URL from its name so templates hard-code strings, and two teams editing the same function step on each other.

Django separates routing into a declarative **URLconf**: a Python module with a `urlpatterns` list. Each entry maps a route to a view, optionally captures typed parameters with **path converters**, and has a **name** used to build URLs in reverse. Apps own their own URLconfs, which the project mounts with `include()` under a prefix and optionally a **namespace**, so `orders:detail` and `blog:detail` never collide.

Interviewers ask about routing because it reveals whether you understand three subtle things: **order** (first match wins, so a greedy pattern can shadow later ones), **reversing** (`reverse()` and `{% url %}` instead of hard-coded paths, and why `reverse_lazy` exists), and **what happens when nothing matches** (the 404 path, `APPEND_SLASH` redirects, custom `handler404`).

## 2. Core Concepts

- **URLconf** — a module defining `urlpatterns`; the root one is `settings.ROOT_URLCONF`, overridable per request by setting `request.urlconf` in middleware. *Why it matters:* it is the routing table for the whole site.
- **`path(route, view, kwargs=None, name=None)`** — matches a route string with optional `<converter:name>` segments. Routes have no leading slash. *Why it matters:* the default, readable way to declare routes.
- **`re_path(regex, view, ...)`** — matches a Python regular expression; named groups become kwargs (as strings). *Why it matters:* for patterns converters can't express, and legacy URLs.
- **Path converter** — a class with `regex`, `to_python()` and `to_url()`. Built-ins: `str` (default; any non-empty text without `/`), `int` (zero or positive integers, converted to `int`), `slug`, `uuid`, `path` (any non-empty text, including `/`). *Why it matters:* validation and type conversion at the routing layer.
- **`register_converter(cls, "name")`** — makes a custom converter usable in `path()`.
- **`include(module_or_list, namespace=None)`** — mounts another URLconf under a prefix. *Why it matters:* apps own their routes; the project composes them.
- **URL name** — the `name=` argument, used by `reverse("name")`, `{% url "name" %}` and `redirect("name")`.
- **Application namespace (`app_name`)** — declared in an app's `urls.py`; prefixes every name (`orders:detail`).
- **Instance namespace (`include(..., namespace="...")`)** — distinguishes multiple mounts of the same app (two admin sites, an API mounted twice).
- **`reverse()` / `reverse_lazy()`** — build a path from a name and arguments; `reverse_lazy` defers until the string is used, for module- or class-level attributes evaluated at import time.
- **`ResolverMatch`** — the result of resolution, stored on `request.resolver_match`: `func`, `args`, `kwargs`, `url_name`, `route`, `namespaces`, `view_name`.
- **`Resolver404` / `NoReverseMatch`** — raised when a path matches nothing, or a name/arguments combination can't be reversed.
- **`APPEND_SLASH`** — when `True` (default) and a path without a trailing slash doesn't match but the slashed version does, `CommonMiddleware` issues a permanent redirect.
- **`handler404`, `handler500`, `handler403`, `handler400`** — root-URLconf variables naming custom error views.

## 3. Theory & Principles

### 3.1 How `path()` compiles

`path("orders/<int:pk>/", views.detail, name="detail")` builds a `URLPattern` whose pattern is a `RoutePattern`. On first use, the route string is translated into a regex by replacing each `<converter:name>` with a named group using the converter's `regex`:

```text
"orders/<int:pk>/"   ->   ^orders/(?P<pk>[0-9]+)/\Z
"blog/<slug:slug>/"  ->   ^blog/(?P<slug>[-a-zA-Z0-9_]+)/\Z
"files/<path:rest>"  ->   ^files/(?P<rest>.+)\Z
```

When the regex matches, each captured string is passed through the converter's `to_python()`. If `to_python()` raises `ValueError`, Django treats the pattern as **not matching** and moves on to the next one — so a custom converter can reject values (an unknown year, an invalid checksum) and let another pattern try.

`re_path()` builds a `RegexPattern` from your regex directly. Named groups become string kwargs; if there are no named groups, unnamed groups are passed as positional args (mixing them is not supported — named groups win).

### 3.2 How resolution walks the tree

The root URLconf becomes a `URLResolver` (cached per URLconf by `get_resolver()`). `URLResolver.resolve(path)`:

1. Matches its own prefix (the root's is `^/`), strips it, and keeps the remainder.
2. Iterates `url_patterns` **in order**. For a `URLPattern`, it tries the full-match regex on the remainder. For a nested `URLResolver` (an `include()`), it tries the include's prefix; only if the prefix matches does it recurse with the rest of the path.
3. Returns a `ResolverMatch` for the **first** match, merging captured kwargs from every level (`include` prefixes can capture too) plus any extra `kwargs` dict passed in `path()`.
4. If nothing matches, raises `Resolver404` carrying the list of tried patterns — that list is what the yellow debug 404 page shows when `DEBUG=True`.

Because includes are pruned by prefix, a request for `/api/orders/42/` never evaluates the hundreds of patterns under `/admin/`. But *within* a level, matching is linear and order-sensitive.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj03a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj03b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#94a3b8"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Resolving GET /api/orders/42/ : ordered, prefix-pruned, first match wins</text>
  <rect x="20" y="44" width="230" height="350" rx="10" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="135" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">ROOT_URLCONF (config/urls.py)</text>
  <rect x="36" y="82" width="198" height="40" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="46" y="100" fill="#334155" font-size="10">1. "admin/"  include(admin.urls)</text>
  <text x="46" y="114" fill="#dc2626" font-size="9">prefix fails: subtree skipped</text>
  <rect x="36" y="132" width="198" height="40" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="46" y="150" fill="#334155" font-size="10">2. "" (home view)</text>
  <text x="46" y="164" fill="#dc2626" font-size="9">full match fails on "api/orders/42/"</text>
  <rect x="36" y="182" width="198" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="46" y="200" fill="#1e293b" font-size="10">3. "api/"  include(api.urls)</text>
  <text x="46" y="214" fill="#16a34a" font-size="9">prefix matches: recurse on "orders/42/"</text>
  <rect x="36" y="232" width="198" height="40" rx="6" fill="#ffffff" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="46" y="250" fill="#94a3b8" font-size="10">4. "&lt;path:page&gt;" catch-all</text>
  <text x="46" y="264" fill="#94a3b8" font-size="9">never tried: earlier match won</text>
  <text x="36" y="300" fill="#334155" font-size="10">Nothing matches at any level:</text>
  <text x="36" y="316" fill="#334155" font-size="10">Resolver404 with "tried" list</text>
  <text x="36" y="332" fill="#334155" font-size="10">DEBUG: technical 404 page</text>
  <text x="36" y="348" fill="#334155" font-size="10">else: handler404 view</text>
  <path d="M234,202 L296,202" stroke="#2563eb" stroke-width="2" marker-end="url(#dj03a)"/>
  <rect x="300" y="44" width="260" height="250" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="430" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">api/urls.py  (app_name = "api")</text>
  <rect x="316" y="82" width="228" height="40" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="326" y="100" fill="#334155" font-size="10">a. "orders/"  name="order-list"</text>
  <text x="326" y="114" fill="#dc2626" font-size="9">full match fails (extra "42/")</text>
  <rect x="316" y="132" width="228" height="40" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="326" y="150" fill="#334155" font-size="10">b. "orders/new/"</text>
  <text x="326" y="164" fill="#dc2626" font-size="9">literal "new" does not match "42"</text>
  <rect x="316" y="182" width="228" height="50" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="326" y="200" fill="#1e293b" font-size="10">c. "orders/&lt;int:pk&gt;/"</text>
  <text x="326" y="214" fill="#16a34a" font-size="9">regex ^orders/(?P&lt;pk&gt;[0-9]+)/\Z matches</text>
  <text x="326" y="226" fill="#16a34a" font-size="9">to_python("42") gives 42</text>
  <text x="316" y="260" fill="#334155" font-size="10">Put "orders/new/" BEFORE &lt;str:slug&gt;</text>
  <text x="316" y="276" fill="#334155" font-size="10">patterns, or "new" is captured as a slug</text>
  <path d="M544,207 L596,207" stroke="#2563eb" stroke-width="2" marker-end="url(#dj03a)"/>
  <rect x="600" y="140" width="260" height="154" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="730" y="162" text-anchor="middle" fill="#1e293b" font-weight="bold">ResolverMatch</text>
  <text x="614" y="184" fill="#334155" font-size="10">func       = order_detail</text>
  <text x="614" y="202" fill="#334155" font-size="10">kwargs     = {"pk": 42}</text>
  <text x="614" y="220" fill="#334155" font-size="10">url_name   = "order-detail"</text>
  <text x="614" y="238" fill="#334155" font-size="10">namespaces = ["api"]</text>
  <text x="614" y="256" fill="#334155" font-size="10">view_name  = "api:order-detail"</text>
  <text x="614" y="274" fill="#334155" font-size="10">route      = "api/orders/&lt;int:pk&gt;/"</text>
  <rect x="600" y="310" width="260" height="84" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="730" y="330" text-anchor="middle" fill="#1e293b" font-weight="bold">Then</text>
  <text x="614" y="350" fill="#334155" font-size="10">request.resolver_match = match</text>
  <text x="614" y="368" fill="#334155" font-size="10">process_view(...) hooks</text>
  <text x="614" y="386" fill="#334155" font-size="10">order_detail(request, pk=42)</text>
</svg>
```

### 3.3 How `reverse()` works

Reversing is the inverse lookup: from a view name and arguments to a path. The resolver lazily builds a **reverse dictionary** (`_populate()`) mapping each name — and each view callable — to its possible patterns, including the prefixes of every enclosing `include()`. `reverse("api:order-detail", kwargs={"pk": 42})`:

1. Splits the name on `:` into namespaces and the final name.
2. Resolves each namespace: if it is an application namespace with several instances, it picks the instance from `current_app` (or `request.current_app` / `request.resolver_match.namespace` in templates), falling back to the **default instance** — the one whose instance namespace equals the app name — and then to the last deployed instance.
3. Finds candidate patterns for the name, and for each, checks that the supplied args/kwargs fit the pattern's parameters. Each value is converted with the converter's `to_url()` and must match the converter's regex.
4. Returns the first candidate that fits, with the script prefix (`FORCE_SCRIPT_NAME` or the WSGI `SCRIPT_NAME`) prepended and the result percent-quoted. If none fits: `NoReverseMatch`, whose message lists the patterns tried.

> **Version note:** Django 5.2 added `query` and `fragment` keyword arguments to `reverse()` and `reverse_lazy()`, so `reverse("search", query={"q": "django"})` yields `/search/?q=django`. On 4.2 you append `"?" + urlencode(...)` yourself.

```svg
<svg viewBox="0 0 880 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj03c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Namespaces: app_name (application) vs include(namespace=...) (instance)</text>
  <rect x="20" y="44" width="260" height="140" rx="10" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="150" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">config/urls.py</text>
  <text x="34" y="90" fill="#334155" font-size="10">path("api/v1/", include("api.urls",</text>
  <text x="54" y="106" fill="#334155" font-size="10">namespace="v1"))</text>
  <text x="34" y="130" fill="#334155" font-size="10">path("api/v2/", include("api.urls",</text>
  <text x="54" y="146" fill="#334155" font-size="10">namespace="v2"))</text>
  <text x="34" y="170" fill="#334155" font-size="9">same app mounted twice, two instances</text>
  <rect x="20" y="200" width="260" height="140" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="150" y="222" text-anchor="middle" fill="#1e293b" font-weight="bold">api/urls.py</text>
  <text x="34" y="246" fill="#334155" font-size="10">app_name = "api"</text>
  <text x="34" y="266" fill="#334155" font-size="10">urlpatterns = [</text>
  <text x="44" y="284" fill="#334155" font-size="10">path("orders/&lt;int:pk&gt;/", ...,</text>
  <text x="64" y="300" fill="#334155" font-size="10">name="order-detail"),</text>
  <text x="34" y="318" fill="#334155" font-size="10">]</text>
  <rect x="320" y="44" width="540" height="296" rx="10" fill="#ffffff" stroke="#94a3b8"/>
  <text x="590" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">How a name is reversed</text>
  <rect x="336" y="80" width="508" height="52" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="348" y="100" fill="#1e293b" font-size="10">reverse("v2:order-detail", kwargs={"pk": 7})</text>
  <text x="348" y="118" fill="#16a34a" font-size="10">instance namespace named explicitly: /api/v2/orders/7/</text>
  <rect x="336" y="142" width="508" height="70" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="348" y="162" fill="#1e293b" font-size="10">reverse("api:order-detail", kwargs={"pk": 7}, current_app="v1")</text>
  <text x="348" y="180" fill="#16a34a" font-size="10">application namespace + current instance: /api/v1/orders/7/</text>
  <text x="348" y="198" fill="#334155" font-size="9">in templates, current_app comes from request.resolver_match.namespace</text>
  <rect x="336" y="222" width="508" height="52" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="348" y="242" fill="#1e293b" font-size="10">reverse("api:order-detail", ...) with no current app</text>
  <text x="348" y="260" fill="#92400e" font-size="10">default instance (namespace == "api") if any, else the LAST deployed one</text>
  <rect x="336" y="284" width="508" height="46" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="348" y="304" fill="#1e293b" font-size="10">reverse("order-detail")  without namespace</text>
  <text x="348" y="320" fill="#b91c1c" font-size="10">NoReverseMatch: names inside an app_name are only reachable namespaced</text>
  <path d="M280,110 L332,106" stroke="#2563eb" stroke-width="2" marker-end="url(#dj03c)"/>
</svg>
```

### 3.4 The 404 path and `APPEND_SLASH`

When resolution fails, `Resolver404` propagates up and is converted into a 404 response — the technical page with the tried patterns when `DEBUG=True`, otherwise your `handler404` (default `django.views.defaults.page_not_found`, which renders `404.html`).

`CommonMiddleware` then inspects 404 responses on the way out. If `APPEND_SLASH=True`, the path doesn't end in `/`, and the path *with* a slash would resolve, it replaces the 404 with a **301** redirect to the slashed URL (preserving the query string). It cannot preserve a POST body across a redirect, so with `DEBUG=True` it raises a `RuntimeError` explaining the problem for POST/PUT/PATCH requests instead of silently redirecting and losing data. This is why API clients that post to `/api/orders` (no slash) suddenly "lose" their payload in production: they get a 301, follow it as a GET, and hit the list endpoint.

## 4. Architecture & Workflow

### 4.1 Project URLconf composed from app URLconfs

```text
config/urls.py  (ROOT_URLCONF)
├── ""             -> pages.urls        app_name="pages"
├── "accounts/"    -> django.contrib.auth.urls   (login, logout, password_reset...)
├── "shop/"        -> shop.urls         app_name="shop"
│                    ├── ""                         name="product-list"
│                    ├── "p/<slug:slug>/"           name="product-detail"
│                    └── "cart/"                    name="cart"
├── "api/v1/"      -> api.urls          namespace="v1"  (app_name="api")
├── "admin/"       -> admin.site.urls   (namespace "admin")
└── handler404 = "pages.views.not_found"
```

Each app knows only its own relative routes. The project decides where it is mounted. Moving the shop from `/shop/` to `/store/` is a one-line change, and every `{% url "shop:product-detail" slug=p.slug %}` keeps working.

### 4.2 Request-time and template-time flows

```text
REQUEST TIME                                   RENDER / REDIRECT TIME
GET /shop/p/blue-mug/                          {% url "shop:product-detail" slug=p.slug %}
  -> get_resolver(ROOT_URLCONF) (cached)          -> reverse("shop:product-detail",
  -> "shop/" prefix ok, recurse "p/blue-mug/"            kwargs={"slug": "blue-mug"},
  -> "p/<slug:slug>/" matches                            current_app=request namespace)
  -> ResolverMatch(func=product_detail,           -> to_url("blue-mug") checked vs slug regex
                   kwargs={"slug": "blue-mug"})   -> "/shop/p/blue-mug/"
  -> product_detail(request, slug="blue-mug")  redirect("shop:cart") -> 302 Location: /shop/cart/
```

## 5. Implementation

### 5.1 Simple example: an app URLconf with converters and names

```python
# shop/urls.py
from django.urls import path
from . import views

app_name = "shop"

urlpatterns = [
    path("", views.product_list, name="product-list"),
    path("p/new/", views.product_create, name="product-create"),          # before the slug route
    path("p/<slug:slug>/", views.product_detail, name="product-detail"),
    path("orders/<int:pk>/", views.order_detail, name="order-detail"),
    path("orders/<uuid:token>/receipt/", views.receipt, name="receipt"),
    path("docs/<path:page>", views.docs, name="docs"),                    # page may contain "/"
]
```

```python
# config/urls.py
from django.contrib import admin
from django.urls import include, path

urlpatterns = [
    path("admin/", admin.site.urls),
    path("shop/", include("shop.urls")),         # namespace defaults to app_name "shop"
]
```

The view receives converted values, not strings:

```python
# shop/views.py
from django.shortcuts import get_object_or_404, redirect, render
from .models import Order, Product

def order_detail(request, pk: int):
    order = get_object_or_404(Order, pk=pk, user=request.user)
    return render(request, "shop/order_detail.html", {"order": order})

def product_create(request):
    ...
    product = Product.objects.create(...)
    return redirect("shop:product-detail", slug=product.slug)     # 302 to /shop/p/<slug>/
```

Reverse from Python, templates and models:

```python
from django.urls import reverse
reverse("shop:order-detail", kwargs={"pk": 42})            # '/shop/orders/42/'
reverse("shop:docs", args=["guides/setup"])                 # '/shop/docs/guides/setup'
reverse("shop:product-list", query={"page": 2})             # '/shop/?page=2'  (Django 5.2+)
```

```html
<a href="{% url 'shop:product-detail' slug=product.slug %}">{{ product.name }}</a>
{% url 'shop:order-detail' pk=order.pk as order_url %}
<a href="{{ order_url }}">View order</a>
```

```python
# shop/models.py
class Product(models.Model):
    slug = models.SlugField(unique=True)
    ...
    def get_absolute_url(self):
        return reverse("shop:product-detail", kwargs={"slug": self.slug})
```

`get_absolute_url()` is used by the admin's "View on site" link, by `redirect(product)` (passing a model instance) and by generic views' default `success_url`, so defining it once removes URL-building from views.

Explore resolution in the shell:

```python
>>> from django.urls import resolve
>>> m = resolve("/shop/orders/42/")
>>> m.func.__name__, m.kwargs, m.view_name, m.route
('order_detail', {'pk': 42}, 'shop:order-detail', 'shop/orders/<int:pk>/')
>>> resolve("/shop/orders/abc/")
Traceback (most recent call last):
django.urls.exceptions.Resolver404: {'tried': [...], 'path': 'shop/orders/abc/'}
```

### 5.2 Custom converter

A converter for four-digit years, and one for comma-separated ID lists used in a bulk endpoint:

```python
# core/converters.py
class YearConverter:
    regex = r"[0-9]{4}"

    def to_python(self, value: str) -> int:
        year = int(value)
        if not 1990 <= year <= 2100:
            raise ValueError("year out of range")       # -> this pattern doesn't match; try the next
        return year

    def to_url(self, value: int) -> str:
        if not 1990 <= int(value) <= 2100:
            raise ValueError("year out of range")       # -> NoReverseMatch
        return f"{int(value):04d}"


class IdListConverter:
    regex = r"[0-9]+(?:,[0-9]+){0,99}"                  # cap at 100 IDs in the URL itself

    def to_python(self, value: str) -> list[int]:
        return [int(x) for x in value.split(",")]

    def to_url(self, value) -> str:
        return ",".join(str(int(x)) for x in value)
```

```python
# blog/urls.py
from django.urls import path, register_converter
from core.converters import IdListConverter, YearConverter
from . import views

register_converter(YearConverter, "yyyy")
register_converter(IdListConverter, "ids")

app_name = "blog"
urlpatterns = [
    path("archive/<yyyy:year>/", views.archive, name="archive"),
    path("posts/<ids:ids>/", views.posts_bulk, name="posts-bulk"),
]
```

```python
reverse("blog:archive", kwargs={"year": 2026})           # '/blog/archive/2026/'
reverse("blog:posts-bulk", kwargs={"ids": [3, 5, 8]})   # '/blog/posts/3,5,8/'
reverse("blog:archive", kwargs={"year": 1800})          # NoReverseMatch
```

`re_path` is still the right tool for legacy URLs you must keep alive:

```python
from django.urls import re_path
from django.views.generic import RedirectView

urlpatterns += [
    # old PHP-era links: /article.php?id=12 is handled by the query string; path part only here
    re_path(r"^archive/(?P<year>[0-9]{4})/(?P<month>0[1-9]|1[0-2])/$", views.month_archive),
    re_path(r"^old-shop/(?P<rest>.*)$",
            RedirectView.as_view(url="/shop/%(rest)s", permanent=True)),
]
```

### 5.3 Real-world example: a versioned, namespaced project URLconf

```python
# config/urls.py
from django.conf import settings
from django.contrib import admin
from django.urls import include, path
from django.views.generic import TemplateView

admin.site.site_header = "Acme Ops"

api_v1 = [
    path("orders/", include("orders.api_urls")),       # app_name = "orders-api"
    path("catalog/", include("catalog.api_urls")),
]

urlpatterns = [
    path("", TemplateView.as_view(template_name="home.html"), name="home"),
    path("accounts/", include("django.contrib.auth.urls")),
    path("shop/", include("shop.urls")),
    path("api/v1/", include((api_v1, "api"), namespace="v1")),  # (patterns, app_name) tuple
    path("healthz/", include("core.health_urls")),
    path("ops-7f3a/", admin.site.urls),                         # obscure admin path
]

if settings.DEBUG:
    import debug_toolbar
    from django.conf.urls.static import static
    urlpatterns = [path("__debug__/", include(debug_toolbar.urls)), *urlpatterns]
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)

handler404 = "core.views.not_found"
handler500 = "core.views.server_error"
```

```python
# core/views.py
from django.shortcuts import render

def not_found(request, exception):
    return render(request, "errors/404.html", {"path": request.path}, status=404)

def server_error(request):
    # Keep it dependency-free: no DB queries, no context processors that could fail again.
    return render(request, "errors/500.html", status=500)
```

Things to notice:

- `include((api_v1, "api"), namespace="v1")` passes an inline list with an application namespace; names become `v1:orders-api:list` style chains when the included URLconfs declare their own `app_name`.
- The admin is moved off `/admin/` to reduce automated brute-force noise (security by obscurity is not a control, but it cuts log spam).
- `handler404` takes `(request, exception)`; `handler500` takes only `(request)`. These are only used when `DEBUG=False`.
- `static()` only works when `DEBUG=True`; it returns an empty list otherwise. Media in production is served by Nginx, a CDN or S3 — see [Ch 20 · Static & Media Files](topic.html?p=20-static-media-files).

## 6. Advantages, Disadvantages & Trade-offs

| Option | Pros | Cons | Use for |
|---|---|---|---|
| `path()` + built-in converters | Readable, typed, validated | Limited expressiveness | Almost everything |
| Custom converter | Reusable validation and typing, works both ways | Must keep `regex`/`to_python`/`to_url` consistent | Domain IDs, dates, encoded lists |
| `re_path()` | Full regex power | Harder to read; captures are strings; easy to forget anchors | Legacy URLs, complex constraints |
| `include()` per app | Apps own routes; prefix pruning | Namespace setup needed | All multi-app projects |
| Instance namespaces | Same app mounted twice | `current_app` subtleties | Multiple admin sites, API versions |
| Hard-coded URLs in templates | Nothing to learn | Breaks on every URL change | Never |
| DRF routers | Generate CRUD routes for viewsets | Less explicit | APIs; see [Ch 22](topic.html?p=22-drf-views-viewsets-routers) |

### When to use

- Use `path()` with converters by default, a custom converter whenever the same parameter shape appears in several routes, and `re_path()` only for the leftovers.
- Use `app_name` in every app URLconf and refer to routes as `app:name` everywhere.
- Use `reverse_lazy()` for URLs in class attributes, settings (`LOGIN_URL` can be a name) and module-level constants.

### When NOT to use

- Don't do routing in views (`if kwargs["action"] == "delete": ...`) — give each action its own route and view.
- Don't put validation that needs the database in a converter (e.g. "does this product exist?"); converters run for every request that reaches that pattern and cannot return a 404 cleanly. Do lookups in the view.
- Don't encode large or sensitive data in paths; URLs end up in logs, browser history and `Referer` headers.

## 7. Common Mistakes & Best Practices

**A greedy pattern shadows later ones.**

```python
# Before: "new" is captured as a slug; product_create is unreachable
urlpatterns = [
    path("p/<slug:slug>/", views.product_detail),
    path("p/new/", views.product_create),
]

# After: specific routes first
urlpatterns = [
    path("p/new/", views.product_create),
    path("p/<slug:slug>/", views.product_detail),
]
```

The same applies to a catch-all `<path:page>` route for a CMS: it must be **last**.

**Leading slash in a route.** `path("/orders/", ...)` never matches, because Django strips the leading slash before matching. `manage.py check` warns (`urls.W002`).

**`reverse()` at import time.**

```python
# Before: raises ImproperlyConfigured / circular import, because URLconfs aren't loaded yet
class OrderCreate(CreateView):
    success_url = reverse("shop:order-list")

# After
class OrderCreate(CreateView):
    success_url = reverse_lazy("shop:order-list")
```

**Namespace without `app_name`.** `include("shop.urls", namespace="shop")` when `shop/urls.py` has no `app_name` raises `ImproperlyConfigured: Specifying a namespace in include() without providing an app_name is not supported`. Set `app_name` in the module or pass a `(patterns, app_name)` tuple.

**Forgetting `$` / `\Z` in `re_path`.** `re_path(r"^orders/(?P<pk>\d+)/", ...)` without an end anchor also matches `/orders/42/anything/else`. `path()` routes are always fully matched; regexes aren't unless you anchor them.

**Using `\d` in regexes and expecting ASCII digits.** In Python 3 `\d` matches any Unicode digit (Arabic-Indic, Devanagari...). `int()` will accept many of those, but they produce surprising URLs. Prefer `[0-9]`, which is what the built-in `int` converter uses.

**Trailing-slash mismatch for APIs.** Clients posting to `/api/orders` get a 301 and lose the body. Pick one convention (DRF routers default to trailing slashes; `DefaultRouter(trailing_slash=False)` drops them) and make clients follow it; consider `APPEND_SLASH=False` for pure APIs so they get a clear 404.

**Best practices**

- Name every route; never hard-code paths in templates, views, emails or tests.
- Keep URLs nouns (`/orders/42/`) and actions as HTTP methods where possible.
- Define `get_absolute_url()` on models with a canonical page.
- Test routing explicitly: `self.assertEqual(resolve("/shop/").func, views.product_list)` and `reverse()` round-trips.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: POST data lost after deploy.** *Symptom:* a form or webhook "succeeds" but nothing is created; logs show a 301 followed by a GET. *Root cause:* the client posts to a URL without a trailing slash; `CommonMiddleware` redirects; the client follows with GET. *Fix:* fix the URL at the client, or add a route without a slash for that webhook, or disable `APPEND_SLASH` for the API.

**Pitfall: 500s from `NoReverseMatch` after a refactor.** A renamed route or a changed parameter breaks a `{% url %}` buried in a rarely visited template; only users find it. *Fix:* render every template in tests, grep for old names, and keep old names alive (or add redirects) during migrations.

**Pitfall: broken URLs behind a path prefix.** The app is deployed at `https://example.com/app/` but generated links point to `/orders/`. *Root cause:* the proxy strips the prefix without setting `SCRIPT_NAME`. *Fix:* pass `SCRIPT_NAME` from the proxy or set `FORCE_SCRIPT_NAME="/app"` (and adjust `STATIC_URL`).

**Pitfall: 404 page that crashes.** A custom `handler404` template extends a base template that queries the database or uses `request.user`; if the DB is the reason for the error (for 500s) you get a second error. Keep `500.html` static and simple; Django renders `handler500` with a minimal context for this reason.

**Pitfall: per-tenant URLconfs.** Setting `request.urlconf` in middleware for multi-tenant routing works, but every distinct URLconf gets its own cached resolver; generating them dynamically per tenant leaks memory. Use a small fixed set of URLconfs.

**Debugging**

- `python manage.py show_urls` (from `django-extensions`) lists every route, name and view.
- `resolve(path)` and `reverse(name, kwargs=...)` in `manage.py shell`.
- The DEBUG 404 page lists every pattern tried in order — the fastest way to spot shadowing.
- Log `request.resolver_match.route` in access logs and metrics; group latency by route, not by path.

**Scaling notes.** Resolution cost is tiny compared to a database query, but it is linear in the number of patterns at each level. Very large flat URLconfs (thousands of generated patterns, common with naive per-tenant or per-language generation) show up in profiles; group them with `include()` prefixes so whole subtrees are skipped. Resolvers are cached per process, so the first request after a deploy pays the population cost for `reverse()`.

## 9. Interview Questions

**Q: What is the difference between `path()` and `re_path()`?**
A: `path()` uses a simple route syntax with converters like `<int:pk>` and `<slug:slug>`; it is always matched against the whole remaining path and converts captured values to Python types. `re_path()` takes a regular expression; named groups become keyword arguments but are passed as strings, and you must anchor the pattern yourself. Use `path()` by default and `re_path()` for patterns converters can't express or legacy URLs.

**Q: In what order are URL patterns matched, and what happens if two match?**
A: Django walks `urlpatterns` top to bottom and uses the first pattern that matches; later patterns are never tried. For an `include()`, only its prefix is checked first, and if it matches Django recurses into the included list. So more specific routes such as `p/new/` must come before generic ones such as `p/<slug:slug>/`, and catch-alls must be last. If nothing matches anywhere, a `Resolver404` becomes a 404 response.

**Q: What are path converters and how do you write a custom one?**
A: A converter defines how a URL segment is matched and converted: a `regex` class attribute, `to_python(value)` to convert the matched string for the view, and `to_url(value)` to convert a Python value back when reversing. Built-ins are `str`, `int`, `slug`, `uuid` and `path`. Register a custom one with `register_converter(MyConverter, "name")` and use `<name:param>`. Raising `ValueError` in `to_python` means "this pattern doesn't match", and in `to_url` it causes `NoReverseMatch`.

**Q: Why use `reverse()` or `{% url %}` instead of hard-coding URLs?**
A: Names decouple the code from the URL structure: you can change `/shop/` to `/store/` or alter a pattern in one place, and every link, redirect and test that uses the name keeps working. `reverse()` also applies converters' `to_url`, quoting and the script prefix, so links are correct behind a sub-path deployment. Hard-coded strings break silently and only fail when a user clicks them.

**Q: What is the difference between `reverse()` and `reverse_lazy()`?**
A: `reverse()` computes the URL immediately, which requires the URLconf to be loaded. `reverse_lazy()` returns a lazy object evaluated when converted to a string. You need the lazy version wherever the expression is evaluated at import time — class attributes like `success_url` on generic views, module-level constants, decorators' arguments — because URLconfs import views, so reversing while views are being imported causes circular-import or improperly-configured errors.

**Q: What are URL namespaces and what is the difference between `app_name` and `namespace`?**
A: Namespaces prevent name collisions between apps: with `app_name = "shop"` in `shop/urls.py`, routes are referenced as `shop:detail`. `app_name` defines the application namespace, shared by every deployment of that app. The `namespace=` argument of `include()` defines an instance namespace, which distinguishes multiple mounts of the same app — for example two admin sites or `v1`/`v2` of an API. When reversing an application namespace, Django uses `current_app` to pick the instance, else the default instance, else the last one deployed.

**Q: What does `APPEND_SLASH` do and when does it cause problems?**
A: With `APPEND_SLASH=True` (the default) and `CommonMiddleware` installed, a request for a path without a trailing slash that doesn't match, but would match with one, is redirected with a 301 to the slashed URL. The problem is non-GET requests: a redirect can't carry a POST body, so clients following it send a GET and the data is lost — in DEBUG mode Django raises a `RuntimeError` to warn you. APIs often choose a strict convention, disable it, or use routers without trailing slashes.

**Q: How do you customize the 404 and 500 pages?**
A: With `DEBUG=False`, Django renders `404.html` and `500.html` from your templates by default. For custom logic, set `handler404 = "app.views.not_found"` (signature `(request, exception)`) and `handler500` (signature `(request)`) in the root URLconf. Keep the 500 page simple and free of database access, because it may be rendered while the database is the cause of the failure. With `DEBUG=True` you see the technical pages instead, so test custom handlers with `DEBUG=False`.

**Q: How do you pass extra data to a view from the URLconf?**
A: Captured parameters become keyword arguments, and `path()` accepts a third argument, a dict of extra kwargs, such as `path("feed/", views.feed, {"format": "rss"})`. Extra kwargs override captured ones with the same name. You can also pass kwargs to `include()`, which applies them to every pattern in the included URLconf. The view reads them as normal function arguments, and they appear in `request.resolver_match.extra_kwargs`.

**Q: How would you design URLs for a versioned public API with Django? (Senior)**
A: I'd put the version in the URL prefix (`/api/v1/`) for clarity and cacheability, mounting the same or a forked set of app URLconfs with instance namespaces (`v1`, `v2`), or use DRF's `NamespaceVersioning` so `request.version` comes from the namespace. Shared views branch on `request.version` only for small differences, and genuinely different contracts get separate serializers. I'd pick one trailing-slash convention, name every route, document deprecation with headers, and route by `resolver_match.route` in metrics to watch traffic per version before removing one. Header-based versioning is an alternative, but URL versions are easier to debug, cache and share as links.

**Q: A pattern you just added never gets called; requests go to a different view. How do you debug it? (Senior)**
A: That is almost always ordering or prefix shadowing. I'd call `resolve("/the/path/")` in the shell to see which view and `route` actually match, and look at the DEBUG 404 or `show_urls` output for the full ordered list. Typical culprits are a generic converter earlier in the same list (`<slug:slug>` before `new/`), an `include()` prefix earlier in the root URLconf that captures the path, a catch-all CMS route that isn't last, or a missing end anchor on a `re_path`. I'd fix the order and add a test that asserts `resolve(path).func` so the regression can't recur.

**Q: How would you implement multi-tenant routing where each tenant has its own subdomain and some tenant-specific URLs? (Senior)**
A: A middleware resolves the tenant from the `Host` header (validated against `ALLOWED_HOSTS` and a tenant table, cached), attaches it to `request.tenant`, and can set `request.urlconf` to one of a small fixed set of URLconfs, such as `public_urls` versus `tenant_urls`. Resolvers are cached per URLconf module, so I avoid generating a URLconf per tenant. Tenant-specific behaviour lives in views reading `request.tenant`, not in per-tenant routes. `reverse()` uses the request's URLconf when called with `urlconf=request.urlconf`, and absolute URLs for emails must include the tenant's host, built with `request.build_absolute_uri()` or a helper.

**Q: What does `request.resolver_match` contain and how is it useful?**
A: It is the `ResolverMatch` produced by URL resolution: the view `func`, `args`, `kwargs`, `url_name`, `app_names`, `namespaces`, `view_name` (the namespaced name), and `route` (the matched route pattern). It is useful for highlighting the active menu item in templates, for picking the current namespace when reversing, and especially for per-route metrics and logging, because `route` groups `/orders/1/` and `/orders/2/` together.

## 10. Quick Revision & Cheat Sheet

| Tool | Syntax | Notes |
|---|---|---|
| Route | `path("orders/<int:pk>/", view, name="detail")` | no leading slash; full match |
| Regex | `re_path(r"^x/(?P<y>[0-9]{4})/$", view)` | anchor it; strings captured |
| Converters | `str int slug uuid path` | `path` includes `/` |
| Custom | `regex`, `to_python`, `to_url`; `register_converter` | `ValueError` = no match / `NoReverseMatch` |
| Include | `path("shop/", include("shop.urls"))` | prefix pruned |
| Namespaces | `app_name = "shop"`; `include(..., namespace="v1")` | `shop:detail` |
| Reverse | `reverse("shop:detail", kwargs={"pk": 1})` | 5.2: `query=`, `fragment=` |
| Lazy | `reverse_lazy(...)` | class attrs, import time |
| Template | `{% url "shop:detail" pk=o.pk %}` | `as var` form |
| Redirect | `redirect("shop:detail", pk=1)` / `redirect(obj)` | 302; `permanent=True` for 301 |
| Errors | `handler404(request, exception)`, `handler500(request)` | only when `DEBUG=False` |

- First match wins; specific before generic; catch-all last.
- `include()` checks its prefix before descending.
- Every route gets a name; every app gets an `app_name`.
- `reverse_lazy` for anything evaluated at import time.
- `APPEND_SLASH` redirects lose POST bodies.
- `Http404`/`Resolver404` become 404; `DoesNotExist` does not.
- Use `resolver_match.route` for metrics.
- Test routing with `resolve()` and `reverse()`.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" && django-admin startproject config . && python manage.py startapp shop`.

1. **Shadowing.** Add `p/<slug:slug>/` above `p/new/`, request `/shop/p/new/`, and read the DEBUG 404 or the view that answers. Fix the order and add a test with `resolve()`.
2. **Custom converter.** Implement the `YearConverter` from §5.2. Show that `/blog/archive/1800/` falls through to the next pattern (or 404) and that `reverse()` with 1800 raises `NoReverseMatch`.
3. **Namespaces.** Mount `shop.urls` twice (`shop/` with `namespace="shop"` and `outlet/` with `namespace="outlet"`). Render a template that uses `{% url "shop:product-list" %}` from each mount and observe which instance is chosen with and without `current_app`.
4. **APPEND_SLASH.** With `DEBUG=True`, POST to `/shop/cart` (no slash) using `curl -X POST` and read the `RuntimeError`. Set `DEBUG=False` and observe the 301.
5. **Error handlers.** Add `handler404`/`handler500` views, set `DEBUG=False` and `ALLOWED_HOSTS=["localhost"]`, and trigger both.

**Mini project — Link-safe blog.** Build a `blog` app with list, detail (`<yyyy:year>/<slug:slug>/`), tag (`tag/<slug:tag>/`), and archive routes, all named under `app_name="blog"`. Give `Post` a `get_absolute_url()`, use only `{% url %}` and `reverse()` for links, add a legacy `re_path` redirect from `/posts/<id>/` to the canonical URL, and write tests that reverse every route and resolve every path back to the right view.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle), [Ch 04 · Views, HttpRequest & HttpResponse](topic.html?p=04-views-requests-responses) (what the resolved view receives), [Ch 05 · Django Template Language](topic.html?p=05-templates) (`{% url %}`), [Ch 17 · Class-Based & Generic Views](topic.html?p=17-class-based-views) (`as_view()` in URLconfs), [Ch 18 · Middleware](topic.html?p=18-middleware) (`CommonMiddleware`, `request.urlconf`), [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers), [Ch 24 · DRF Pagination, Filtering, Versioning & Docs](topic.html?p=24-drf-pagination-filtering-versioning).

**Other handbooks:** [REST API · Resource Modeling & URI Design](../rest-api/topic.html?p=05-resource-modeling-uri-design), [REST API · Naming Conventions](../rest-api/topic.html?p=09-naming-conventions), [REST API · API Versioning](../rest-api/topic.html?p=31-api-versioning).

- **URL dispatcher** — Django docs · *Beginner* · the complete guide: converters, namespaces, reversing, error handlers. <https://docs.djangoproject.com/en/5.2/topics/http/urls/>
- **django.urls functions** — Django docs · *Beginner* · reference for `path`, `re_path`, `include`, `register_converter`. <https://docs.djangoproject.com/en/5.2/ref/urls/>
- **django.urls utility functions** — Django docs · *Intermediate* · `reverse`, `reverse_lazy`, `resolve`, `ResolverMatch`. <https://docs.djangoproject.com/en/5.2/ref/urlresolvers/>
- **Writing your first Django app, part 3** — Django docs · *Beginner* · URLs, names and namespacing in the official tutorial. <https://docs.djangoproject.com/en/5.2/intro/tutorial03/>
- **django/urls/resolvers.py** — GitHub · *Advanced* · `URLResolver.resolve` and `_reverse_with_prefix` in a few hundred lines. <https://github.com/django/django/blob/stable/5.2.x/django/urls/resolvers.py>
- **django-extensions (show_urls)** — GitHub · *Beginner* · list every route and its view from the command line. <https://github.com/django-extensions/django-extensions>
- **Cool URIs don't change** — W3C (Tim Berners-Lee) · *Beginner* · why stable, named URLs matter. <https://www.w3.org/Provider/Style/URI>

---

*Django Handbook — chapter 03.*
