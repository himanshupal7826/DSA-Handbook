# 24 · DRF Pagination, Filtering, Versioning & Docs

> **In one line:** A list endpoint is a query you let strangers write — pagination bounds how much it returns (and cursor pagination keeps it fast and stable at depth), filter backends decide which `WHERE` and `ORDER BY` clauses clients may add, versioning lets the contract evolve without breaking old clients, and an OpenAPI schema makes all of it discoverable.

---

## 1. Overview

> **Builds on:** [Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers), [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers), [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization), [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres).

The first version of every list endpoint is `return Response(Serializer(Model.objects.all(), many=True).data)`. It works in development with 40 rows. In production the table has four million rows, a mobile client calls the endpoint on launch, and the worker serialises the whole table into memory until Gunicorn kills it at the 30-second timeout. That is the first lesson: **every list endpoint must be bounded**.

Then the clients want "only my open orders", "sorted by price", "search by name". The naive implementation reads `request.GET` by hand: `qs.filter(**request.GET.dict())`. That is an injection of a different kind — a client can send `?owner__password__startswith=pbkdf2` and binary-search a hash, or `?ordering=some_unindexed_column` and force a sequential scan with a sort on four million rows. The second lesson: **clients choose from a whitelist of filters and orderings, and every whitelisted option needs an index**.

Then the mobile app ships v1 and cannot be force-upgraded, while the web team wants to rename `price` to `price_cents`. The third lesson: **the response shape is a contract**, and you need a versioning scheme to change it. And for partners to integrate at all you need the fourth piece: an **OpenAPI schema** generated from the same code, so documentation cannot drift.

DRF covers all four with pluggable classes: **pagination classes** (`PageNumberPagination`, `LimitOffsetPagination`, `CursorPagination`), **filter backends** (django-filter's `DjangoFilterBackend`, `SearchFilter`, `OrderingFilter`), **versioning classes** (`URLPathVersioning`, `AcceptHeaderVersioning`, ...), and schema generation (in practice, **drf-spectacular**). The HTTP-level design of each is covered in the REST API handbook ([Pagination](../rest-api/topic.html?p=13-pagination), [Filtering, Sorting & Searching](../rest-api/topic.html?p=12-filtering-sorting-searching), [Versioning](../rest-api/topic.html?p=31-api-versioning)); this chapter is about how DRF implements them and what SQL they generate.

> **Why this matters:** "Offset vs cursor pagination — which and why?" is a near-universal backend interview question, and "why is page 5,000 slow?" is a near-universal production incident.

## 2. Core Concepts

- **`DEFAULT_PAGINATION_CLASS` + `PAGE_SIZE`** — global defaults; both must be set for pagination to apply. *Why:* pagination is off unless configured, and applies only to generic list actions (or where you call `paginate_queryset` yourself).
- **`PageNumberPagination`** — `?page=3`; response `{count, next, previous, results}`; uses Django's `Paginator` (a `COUNT(*)` + `LIMIT/OFFSET`). *Why:* human-friendly, jumpable, expensive at depth.
- **`LimitOffsetPagination`** — `?limit=50&offset=200`; same SQL shape, client controls the window. *Why:* flexible; same deep-offset cost.
- **`CursorPagination`** — `?cursor=<opaque>`; keyset pagination on an ordering; no `count`, no page jumping. *Why:* constant cost per page and stable results while rows are inserted.
- **`max_page_size` / `max_limit`** — server caps on client-chosen sizes. *Why:* without them `?page_size=1000000` is a DoS.
- **Filter backend** — a class with `filter_queryset(request, queryset, view)`; listed in `filter_backends`. *Why:* applied in order by `GenericAPIView.filter_queryset()` for list *and* detail.
- **`DjangoFilterBackend` / `FilterSet`** — django-filter; `filterset_fields` or a `FilterSet` class with typed, validated filters. *Why:* explicit whitelist, invalid input → 400.
- **`SearchFilter`** — `?search=term` across `search_fields`; `icontains` by default, prefixes `^` (startswith), `=` (exact), `@` (PostgreSQL full-text), `$` (regex). *Why:* convenient, but `icontains` defeats B-tree indexes.
- **`OrderingFilter`** — `?ordering=-price,name` restricted to `ordering_fields`; `ordering` sets the default. *Why:* every allowed ordering is a potential sort; index the hot ones.
- **Versioning class** — determines `request.version` in `initial()`: `URLPathVersioning`, `NamespaceVersioning`, `AcceptHeaderVersioning`, `HostNameVersioning`, `QueryParameterVersioning`. *Why:* lets views branch on version.
- **`ALLOWED_VERSIONS` / `DEFAULT_VERSION`** — validation of requested versions. *Why:* unknown versions → 404/406 instead of silent defaults.
- **OpenAPI schema** — machine-readable contract. *Why:* client generation, docs, contract tests.
- **drf-spectacular** — OpenAPI 3 generator for DRF; `@extend_schema` to annotate. *Why:* the de-facto standard; DRF's own schema generation is minimal and drf-yasg targets OpenAPI 2.

## 3. Theory & Principles

### Where these hooks live in `list()`

`ListModelMixin.list()` is short, and every concept in this chapter is a line of it:

```python
def list(self, request, *args, **kwargs):
    queryset = self.filter_queryset(self.get_queryset())   # filter backends, in order
    page = self.paginate_queryset(queryset)                 # pagination class, or None
    if page is not None:
        serializer = self.get_serializer(page, many=True)
        return self.get_paginated_response(serializer.data) # envelope with next/previous
    serializer = self.get_serializer(queryset, many=True)
    return Response(serializer.data)
```

`filter_queryset()` loops `for backend in list(self.filter_backends): queryset = backend().filter_queryset(self.request, queryset, self)`. Note that **`get_object()` also calls `filter_queryset()`**, so a filter like "status=published" applied by a backend also restricts detail lookups — usually what you want, occasionally a surprise. `paginate_queryset()` returns `None` if `pagination_class` is `None`, which is why unpaginated endpoints silently return everything. Versioning happens earlier, in `initial()` (`determine_version`), so `request.version` is available to `get_queryset()` and `get_serializer_class()`.

```svg
<svg viewBox="0 0 880 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj24a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">GET /api/v2/products/?category=3&amp;search=lamp&amp;ordering=-price&amp;cursor=cD0xOTk</text>
  <rect x="20" y="44" width="150" height="64" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="95" y="66" text-anchor="middle" fill="#1e293b">initial()</text>
  <text x="95" y="82" text-anchor="middle" fill="#334155" font-size="9">determine_version</text>
  <text x="95" y="96" text-anchor="middle" fill="#334155" font-size="9">request.version = "v2"</text>
  <path d="M170,76 L196,76" stroke="#2563eb" stroke-width="2" marker-end="url(#dj24a)"/>
  <rect x="198" y="44" width="130" height="64" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="263" y="66" text-anchor="middle" fill="#1e293b">get_queryset()</text>
  <text x="263" y="82" text-anchor="middle" fill="#334155" font-size="9">tenant scope +</text>
  <text x="263" y="96" text-anchor="middle" fill="#334155" font-size="9">select_related</text>
  <path d="M328,76 L354,76" stroke="#2563eb" stroke-width="2" marker-end="url(#dj24a)"/>
  <rect x="356" y="36" width="330" height="80" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="521" y="54" text-anchor="middle" fill="#1e293b" font-weight="bold">filter_queryset(): backends in order</text>
  <rect x="366" y="64" width="100" height="42" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="416" y="82" text-anchor="middle" fill="#1e293b" font-size="10">DjangoFilter</text>
  <text x="416" y="96" text-anchor="middle" fill="#334155" font-size="9">category_id = 3</text>
  <rect x="472" y="64" width="100" height="42" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="522" y="82" text-anchor="middle" fill="#1e293b" font-size="10">SearchFilter</text>
  <text x="522" y="96" text-anchor="middle" fill="#334155" font-size="9">name ILIKE %lamp%</text>
  <rect x="578" y="64" width="100" height="42" rx="6" fill="#ffffff" stroke="#2563eb"/>
  <text x="628" y="82" text-anchor="middle" fill="#1e293b" font-size="10">OrderingFilter</text>
  <text x="628" y="96" text-anchor="middle" fill="#334155" font-size="9">ORDER BY price DESC</text>
  <path d="M686,76 L712,76" stroke="#2563eb" stroke-width="2" marker-end="url(#dj24a)"/>
  <rect x="714" y="44" width="146" height="64" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="787" y="66" text-anchor="middle" fill="#1e293b">paginate_queryset()</text>
  <text x="787" y="82" text-anchor="middle" fill="#334155" font-size="9">decode cursor</text>
  <text x="787" y="96" text-anchor="middle" fill="#334155" font-size="9">WHERE + LIMIT n+1</text>
  <path d="M787,108 L787,148" stroke="#2563eb" stroke-width="2" marker-end="url(#dj24a)"/>
  <rect x="456" y="150" width="404" height="56" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="658" y="172" text-anchor="middle" fill="#1e293b">get_serializer(page, many=True) then get_paginated_response</text>
  <text x="658" y="190" text-anchor="middle" fill="#334155" font-size="10">{"next": "...?cursor=...", "previous": ..., "results": [...]}</text>
  <rect x="20" y="150" width="410" height="128" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="225" y="170" text-anchor="middle" fill="#1e293b" font-weight="bold">One SQL statement is built from all of it</text>
  <text x="225" y="192" text-anchor="middle" fill="#334155" font-size="10">WHERE tenant_id = 9 AND category_id = 3</text>
  <text x="225" y="208" text-anchor="middle" fill="#334155" font-size="10">AND name ILIKE '%lamp%'</text>
  <text x="225" y="224" text-anchor="middle" fill="#334155" font-size="10">AND (price, id) &lt; (cursor position)</text>
  <text x="225" y="240" text-anchor="middle" fill="#334155" font-size="10">ORDER BY price DESC, id DESC LIMIT 21</text>
  <text x="225" y="262" text-anchor="middle" fill="#dc2626" font-size="10">every allowed combination needs a plan you have checked</text>
</svg>
```

### Why OFFSET gets slow, and why COUNT is expensive

`PageNumberPagination` builds a Django `Paginator(queryset, page_size)`. `paginator.count` runs `queryset.count()` → `SELECT COUNT(*) ...`, and `paginator.page(n)` slices the queryset → `LIMIT page_size OFFSET (n-1)*page_size`. PostgreSQL implements `OFFSET k` by producing and **discarding** k rows, so page 5,000 of 20 means reading 100,000 rows to return 20. `COUNT(*)` on PostgreSQL must visit every visible row (MVCC — no cached row count; see [Database Design · MVCC](../database-design/topic.html?p=03-mvcc)), so on large filtered tables the count can cost more than the page itself. `LimitOffsetPagination` has the same two queries.

There is also a correctness problem: if rows are inserted at the head of the ordering between two page requests, every row shifts down and the client sees a duplicate on the next page; deletes cause skipped rows.

### How `CursorPagination` works

`CursorPagination` implements **keyset** (seek) pagination. It requires an `ordering` (default `"-created"`, which fails if your model has no `created` field — always set it). On a page request it decodes the cursor — a base64-encoded querystring holding `o` (offset), `r` (reverse) and `p` (position: the ordering field value of the boundary row) — and filters `WHERE ordering_field < position` (or `>` depending on direction), then `LIMIT page_size + 1` to know whether a next page exists. The cost is an index range scan from the position, independent of depth, and inserts at the head do not shift later pages.

Requirements and limits: the ordering should be on a **unique, immutable** field (or the first field should be mostly unique — DRF's cursor stores the position of the *first* ordering field and uses the small offset `o` to step past ties, which degrades if many rows share a value); you cannot jump to page N; there is no total count; and clients cannot choose arbitrary orderings unless you also allow them via `OrderingFilter` (each allowed ordering then needs an index). Cursors are opaque but not encrypted — they are not a security boundary.

```svg
<svg viewBox="0 0 880 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Page 5,000 of 20 rows: OFFSET vs cursor (keyset)</text>
  <rect x="20" y="40" width="410" height="262" rx="10" fill="#fef2f2" stroke="#dc2626"/>
  <text x="225" y="62" text-anchor="middle" fill="#b91c1c" font-weight="bold">PageNumber / LimitOffset</text>
  <text x="225" y="82" text-anchor="middle" fill="#334155" font-size="10">ORDER BY id DESC LIMIT 20 OFFSET 99980</text>
  <rect x="40" y="96" width="370" height="26" fill="#fee2e2" stroke="#dc2626"/>
  <text x="225" y="113" text-anchor="middle" fill="#7f1d1d" font-size="10">scan + discard 99,980 index entries / rows</text>
  <rect x="40" y="126" width="370" height="16" fill="#dcfce7" stroke="#16a34a"/>
  <text x="225" y="138" text-anchor="middle" fill="#14532d" font-size="9">return 20</text>
  <text x="225" y="166" text-anchor="middle" fill="#334155" font-size="10">+ SELECT COUNT(*) over the whole filtered set</text>
  <text x="225" y="190" text-anchor="middle" fill="#334155" font-size="10">cost grows linearly with page depth</text>
  <text x="225" y="214" text-anchor="middle" fill="#334155" font-size="10">insert at head between requests:</text>
  <text x="225" y="230" text-anchor="middle" fill="#dc2626" font-size="10">rows shift: duplicate or skipped items</text>
  <text x="225" y="260" text-anchor="middle" fill="#16a34a" font-size="10">but: total count, jump to any page</text>
  <text x="225" y="278" text-anchor="middle" fill="#16a34a" font-size="10">good for admin tables and small sets</text>
  <rect x="450" y="40" width="410" height="262" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="655" y="62" text-anchor="middle" fill="#15803d" font-weight="bold">CursorPagination</text>
  <text x="655" y="82" text-anchor="middle" fill="#334155" font-size="10">WHERE id &lt; 400021 ORDER BY id DESC LIMIT 21</text>
  <rect x="470" y="96" width="60" height="26" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="500" y="113" text-anchor="middle" fill="#334155" font-size="9">skipped</text>
  <text x="560" y="113" text-anchor="middle" fill="#334155" font-size="9">seek</text>
  <rect x="590" y="96" width="250" height="26" fill="#dcfce7" stroke="#16a34a"/>
  <text x="715" y="113" text-anchor="middle" fill="#14532d" font-size="10">index range scan: read 21 entries</text>
  <text x="655" y="150" text-anchor="middle" fill="#334155" font-size="10">no COUNT query</text>
  <text x="655" y="174" text-anchor="middle" fill="#334155" font-size="10">cost constant at any depth</text>
  <text x="655" y="198" text-anchor="middle" fill="#334155" font-size="10">insert at head: later pages unaffected</text>
  <text x="655" y="230" text-anchor="middle" fill="#d97706" font-size="10">needs unique, immutable ordering + index</text>
  <text x="655" y="254" text-anchor="middle" fill="#d97706" font-size="10">no page numbers, no total count</text>
  <text x="655" y="278" text-anchor="middle" fill="#15803d" font-size="10">good for feeds, infinite scroll, sync, exports</text>
</svg>
```

### Filtering: whitelists and types

django-filter's `DjangoFilterBackend` builds a `FilterSet` (from `filterset_fields` or your `filterset_class`), binds it to `request.query_params` and the queryset, and if the filterset form is invalid (e.g. `?price__gte=abc`) raises a `ValidationError` → **400**. Only declared filters are honoured; unknown params are ignored. That whitelist is the defence against lookup injection.

`SearchFilter` splits the `search` param into terms; for each term it ORs `icontains` lookups across `search_fields` and ANDs across terms. When a search field traverses a to-many relation (`tags__name`), DRF checks whether the lookup can produce duplicate rows and applies `.distinct()` when needed. The SQL is `UPPER(col) LIKE UPPER('%term%')` — a leading wildcard that cannot use a normal B-tree index. For real search, use `@` (PostgreSQL full-text, requires `django.contrib.postgres`), a trigram GIN index, or an external engine ([Ch 16](topic.html?p=16-database-features-postgres)).

`OrderingFilter` reads `?ordering=` (comma-separated, `-` for descending), keeps only terms in `ordering_fields` (if `ordering_fields` is not set it falls back to the serializer's readable fields — set it explicitly; `"__all__"` allows any model field), and applies `order_by()`; otherwise it applies the view's `ordering`.

### Versioning

In `initial()`, `determine_version()` instantiates `versioning_class` and calls `determine_version(request, *args, **kwargs)`, storing `request.version` and `request.versioning_scheme`. `URLPathVersioning` reads a URL kwarg (`<version>` in the pattern); `NamespaceVersioning` uses the URL namespace; `AcceptHeaderVersioning` reads `Accept: application/json; version=2`; `QueryParameterVersioning` reads `?version=2`; `HostNameVersioning` reads `v2.api.example.com`. With `ALLOWED_VERSIONS` set, an unknown version raises `NotFound` (path, namespace, hostname) or `NotAcceptable` (Accept header). The versioning scheme also participates in `reverse()`: `rest_framework.reverse.reverse("book-detail", args=[1], request=request)` produces a URL for the same version, so hyperlinks stay within the client's version.

## 4. Architecture & Workflow

### Choosing a pagination class

```text
Is the dataset small and bounded (< ~10k rows after filtering)?
 ├─ yes → Do humans need "page 7 of 23"?  yes → PageNumberPagination (+ max_page_size)
 │                                         no  → LimitOffsetPagination (tables with resize)
 └─ no  → Is it a feed / infinite scroll / sync / export?  → CursorPagination on (created, id)
          Do you still need a total?  → approximate count (pg_class.reltuples / cached count)
                                         or "has_more" only
```

### Versioning a breaking change

```text
v1 client  GET /api/v1/products/7/  → request.version = "v1" → ProductV1Serializer {"price": "19.99"}
v2 client  GET /api/v2/products/7/  → request.version = "v2" → ProductV2Serializer {"price_cents": 1999}
                                        same view, same queryset, serializer chosen by version
Deprecation: v1 responses carry Deprecation + Sunset headers; usage of v1 tracked in logs per client id
```

### Schema pipeline

```text
views + serializers + filters + pagination  ──▶  drf-spectacular AutoSchema
   @extend_schema / @extend_schema_field         │
                                                 ▼
                         manage.py spectacular --file schema.yml   (CI artifact, diffed per PR)
                                                 │
                    ┌────────────────────────────┼────────────────────────────┐
                    ▼                            ▼                            ▼
             Swagger UI / Redoc         client SDK generation          contract tests
```

## 5. Implementation

### Simple example: global settings

```bash
pip install "django~=5.2" "djangorestframework>=3.15" django-filter drf-spectacular
```

```python
# settings.py
INSTALLED_APPS += ["rest_framework", "django_filters", "drf_spectacular"]

REST_FRAMEWORK = {
    "DEFAULT_PAGINATION_CLASS": "config.pagination.DefaultPagination",
    "PAGE_SIZE": 20,
    "DEFAULT_FILTER_BACKENDS": [
        "django_filters.rest_framework.DjangoFilterBackend",
        "rest_framework.filters.SearchFilter",
        "rest_framework.filters.OrderingFilter",
    ],
    "DEFAULT_VERSIONING_CLASS": "rest_framework.versioning.URLPathVersioning",
    "DEFAULT_VERSION": "v1",
    "ALLOWED_VERSIONS": ["v1", "v2"],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
}

SPECTACULAR_SETTINGS = {
    "TITLE": "Shop API",
    "VERSION": "2.0.0",
    "SERVE_INCLUDE_SCHEMA": False,
}
```

```python
# config/pagination.py
from rest_framework.pagination import CursorPagination, PageNumberPagination


class DefaultPagination(PageNumberPagination):
    page_size = 20
    page_size_query_param = "page_size"   # opt-in: off by default in DRF
    max_page_size = 100                   # never let clients ask for a million rows


class FeedCursorPagination(CursorPagination):
    page_size = 25
    ordering = ("-created_at", "-id")     # newest first; id breaks ties
    page_size_query_param = "page_size"
    max_page_size = 100
```

```text
GET /api/v1/products/?page=2
{
  "count": 1342,
  "next": "https://api.example.com/api/v1/products/?page=3",
  "previous": "https://api.example.com/api/v1/products/?page=1",
  "results": [ {...}, ... ]
}
```

### Real-world example: a product catalogue

```python
# catalog/models.py
from django.db import models
from django.contrib.postgres.indexes import GinIndex


class Product(models.Model):
    tenant = models.ForeignKey("tenants.Tenant", on_delete=models.CASCADE)
    category = models.ForeignKey("Category", on_delete=models.PROTECT, related_name="products")
    name = models.CharField(max_length=200)
    sku = models.CharField(max_length=40)
    price_cents = models.PositiveIntegerField()
    in_stock = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["tenant", "sku"], name="uniq_tenant_sku")]
        indexes = [
            models.Index(fields=["tenant", "-created_at", "-id"], name="prod_tenant_feed"),
            models.Index(fields=["tenant", "category", "price_cents"], name="prod_tenant_cat_price"),
            GinIndex(fields=["name"], name="prod_name_trgm", opclasses=["gin_trgm_ops"]),  # needs pg_trgm
        ]
```

```python
# catalog/filters.py
import django_filters

from .models import Product


class ProductFilter(django_filters.FilterSet):
    min_price = django_filters.NumberFilter(field_name="price_cents", lookup_expr="gte")
    max_price = django_filters.NumberFilter(field_name="price_cents", lookup_expr="lte")
    category = django_filters.NumberFilter(field_name="category_id")
    created_after = django_filters.IsoDateTimeFilter(field_name="created_at", lookup_expr="gte")

    class Meta:
        model = Product
        fields = ["in_stock"]          # exact match; plus the declared filters above
```

```python
# catalog/views.py
from django_filters.rest_framework import DjangoFilterBackend
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import OpenApiParameter, extend_schema, extend_schema_view
from rest_framework import filters, viewsets

from config.pagination import FeedCursorPagination
from .filters import ProductFilter
from .models import Product
from .serializers import ProductV1Serializer, ProductV2Serializer


@extend_schema_view(
    list=extend_schema(
        summary="List products",
        parameters=[OpenApiParameter("search", OpenApiTypes.STR, description="Name or SKU contains")],
    ),
)
class ProductViewSet(viewsets.ReadOnlyModelViewSet):
    filter_backends = [DjangoFilterBackend, filters.SearchFilter, filters.OrderingFilter]
    filterset_class = ProductFilter
    search_fields = ["name", "=sku"]                 # icontains on name, exact on sku
    ordering_fields = ["price_cents", "created_at"]  # explicit whitelist, both indexed
    ordering = ["-created_at", "-id"]

    def get_queryset(self):
        return (Product.objects
                .filter(tenant=self.request.user.tenant)
                .select_related("category"))

    def get_serializer_class(self):
        return ProductV2Serializer if self.request.version == "v2" else ProductV1Serializer

    @property
    def paginator(self):
        # Feed-style cursor pagination unless the client asked for a custom ordering.
        if not hasattr(self, "_paginator"):
            from config.pagination import DefaultPagination
            use_cursor = "ordering" not in self.request.query_params
            self._paginator = FeedCursorPagination() if use_cursor else DefaultPagination()
        return self._paginator
```

```python
# catalog/serializers.py
class ProductV1Serializer(serializers.ModelSerializer):
    price = serializers.SerializerMethodField()

    class Meta:
        model = Product
        fields = ["id", "name", "sku", "price", "in_stock", "category"]

    @extend_schema_field(OpenApiTypes.STR)
    def get_price(self, obj):
        return f"{obj.price_cents / 100:.2f}"


class ProductV2Serializer(serializers.ModelSerializer):
    class Meta:
        model = Product
        fields = ["id", "name", "sku", "price_cents", "in_stock", "category", "created_at"]
```

```python
# config/urls.py
from drf_spectacular.views import SpectacularAPIView, SpectacularRedocView, SpectacularSwaggerView
from rest_framework.routers import DefaultRouter

router = DefaultRouter()
router.register(r"products", ProductViewSet, basename="product")

urlpatterns = [
    path("api/<str:version>/", include(router.urls)),          # URLPathVersioning reads `version`
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    path("api/docs/", SpectacularSwaggerView.as_view(url_name="schema"), name="swagger-ui"),
    path("api/redoc/", SpectacularRedocView.as_view(url_name="schema"), name="redoc"),
]
```

Now the generated SQL for `GET /api/v2/products/?category=3&min_price=1000&cursor=...`:

```sql
SELECT "catalog_product".*, "catalog_category".*
FROM "catalog_product"
INNER JOIN "catalog_category" ON ("catalog_product"."category_id" = "catalog_category"."id")
WHERE "catalog_product"."tenant_id" = 9
  AND "catalog_product"."category_id" = 3
  AND "catalog_product"."price_cents" >= 1000
  AND "catalog_product"."created_at" < '2026-10-20T08:15:00+00:00'
ORDER BY "catalog_product"."created_at" DESC, "catalog_product"."id" DESC
LIMIT 26;
```

No `COUNT`, and the `(tenant, -created_at, -id)` index serves the order. The page-number variant with `?ordering=price_cents&page=40` instead issues:

```sql
SELECT COUNT(*) AS "__count" FROM "catalog_product"
WHERE "tenant_id" = 9 AND "category_id" = 3 AND "price_cents" >= 1000;
SELECT ... ORDER BY "catalog_product"."price_cents" ASC LIMIT 20 OFFSET 780;
```

A `search=lamp` adds `AND (UPPER("name"::text) LIKE UPPER('%lamp%') OR "sku" = 'lamp')`; with the trigram GIN index PostgreSQL can serve the `LIKE` instead of scanning every row. Confirm with `queryset.explain(analyze=True)` ([Ch 13](topic.html?p=13-queryset-optimization)).

```bash
python manage.py spectacular --file schema.yml --validate
```

### Paginating a custom action or `APIView`

Pagination only runs automatically in `ListModelMixin.list()`. In an `@action` you must call it yourself:

```python
@action(detail=False)
def discounted(self, request):
    qs = self.filter_queryset(self.get_queryset()).filter(discount__gt=0)
    page = self.paginate_queryset(qs)
    if page is not None:
        return self.get_paginated_response(self.get_serializer(page, many=True).data)
    return Response(self.get_serializer(qs, many=True).data)
```

### Cheaper counts for big tables

```python
from django.core.paginator import Paginator
from django.db import connection
from django.utils.functional import cached_property


class EstimatedCountPaginator(Paginator):
    @cached_property
    def count(self):
        if self.object_list.query.where:        # filtered: fall back to the real count
            return super().count
        with connection.cursor() as cur:
            cur.execute("SELECT reltuples::bigint FROM pg_class WHERE relname = %s",
                        [self.object_list.model._meta.db_table])
            return cur.fetchone()[0]


class EstimatedPagination(PageNumberPagination):
    django_paginator_class = EstimatedCountPaginator
```

## 6. Advantages, Disadvantages & Trade-offs

| Pagination | Total count | Jump to page | Deep-page cost | Stable under inserts | Best for |
|---|---|---|---|---|---|
| PageNumber | yes (COUNT) | yes | O(offset) | no | Admin UIs, small sets |
| LimitOffset | yes (COUNT) | yes (by offset) | O(offset) | no | Data tables with variable sizes |
| Cursor | no | no | O(page) | yes | Feeds, infinite scroll, sync, exports |

| Versioning scheme | Pros | Cons |
|---|---|---|
| URL path `/api/v2/` | Visible, cacheable, easy routing and logs | URLs change per version |
| Accept header | Clean URLs, "proper" content negotiation | Harder to test in a browser; caches need `Vary: Accept` |
| Query param `?version=2` | Easy | Easily dropped; mixes with filters |
| Hostname `v2.api...` | Separate deploys possible | DNS/TLS per version |
| Namespace | Uses Django URL namespaces | Duplicated URL includes |

| Filtering tool | Strength | Weakness |
|---|---|---|
| django-filter | typed, validated, whitelisted | Another dependency; need to define FilterSets |
| SearchFilter | One line | `icontains`, poor index use, no relevance |
| OrderingFilter | One line | Each allowed field is a potential sort scan |

### When to use
- Cursor pagination for anything a client scrolls or syncs, or any table that will exceed a few hundred thousand rows.
- Page-number pagination when users genuinely need page numbers and totals on modest datasets.
- URL path versioning for public APIs — it is what most clients and gateways expect.
- drf-spectacular for every API with external consumers; check the schema into CI.

### When NOT to use
- Not page-number pagination over a growing multi-million-row feed.
- Not `SearchFilter` as a search engine — use PostgreSQL full-text/trigram or a dedicated engine.
- Not versioning for additive changes — adding a field is backwards compatible; version only for breaking changes ([REST API · Backward Compatibility](../rest-api/topic.html?p=32-backward-compatibility-deprecation)).
- Not `ordering_fields = "__all__"` on large tables.

## 7. Common Mistakes & Best Practices

**1. No pagination on some list endpoints.** Setting `pagination_class` on one view but not globally, or setting `DEFAULT_PAGINATION_CLASS` without `PAGE_SIZE`. Configure both globally; opt out explicitly with `pagination_class = None` only for genuinely tiny lists.

**2. Unbounded `page_size_query_param`.** Allowing client page size without `max_page_size`. Always set the cap.

**3. Cursor pagination on a non-unique or mutable field.** Ordering by `-updated_at` alone: rows move between pages as they are edited, and ties step through slowly. Order by an immutable column plus `id`.

**4. Hand-rolled filters from `request.GET`.**

```python
# before: lookup injection, no validation
qs = Product.objects.filter(**request.query_params.dict())

# after: whitelisted, typed, validated
filterset_class = ProductFilter
```

**5. Unindexed orderings and filters.** Each `ordering_fields` entry and each filter combination you expect should be backed by an index whose leading column matches the tenant scope.

**6. Forgetting that filter backends also apply to `get_object()`.** A detail request with `?in_stock=true` on an out-of-stock product returns 404. Usually fine; document it.

**7. Branching on `request.version` everywhere.** Scattered `if request.version == "v2"` in views rots quickly. Centralise: select serializer classes via a map keyed by version, and keep one queryset.

**8. Documenting by hand.** A hand-written Markdown API doc is wrong within a sprint. Generate the schema; annotate gaps with `@extend_schema`; fail CI on schema warnings.

**Best practices:** global pagination with caps; cursor for feeds; FilterSets for every filterable list; explicit `ordering_fields`; index per access path; version only on breaking changes; deprecation headers and usage metrics for old versions; schema generated in CI and diffed in code review.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: deep pages time out.** Symptom: crawlers walking `?page=1..N` push DB CPU to 100%; p99 for late pages is seconds. Root cause: `OFFSET` discarding hundreds of thousands of rows, plus `COUNT(*)` per request. Fix: cursor pagination for crawler-visible lists, cap the maximum page (`if page > 500: raise NotFound`), and estimated counts.

**Pitfall: COUNT dominates the request.** Symptom: `EXPLAIN ANALYZE` shows the count taking 800 ms and the page 5 ms. Fix: estimated counts, cached counts (Redis, invalidated or refreshed periodically), or drop totals in favour of `has_more`.

**Pitfall: search melts the database.** `?search=a` on a 10M-row table → `ILIKE '%a%'` sequential scan on every keystroke from the frontend's type-ahead. Fix: minimum search length, debounce in the client, trigram GIN index, or PostgreSQL full-text search with a `SearchVector` index; throttle the endpoint ([Ch 23](topic.html?p=23-drf-auth-permissions-throttling)).

**Pitfall: duplicates in results.** Filtering across an M2M (`?tag=red&tag=blue` or `search_fields = ["tags__name"]`) yields joined duplicate rows; `count` disagrees with `results`. Fix: `distinct=True` on django-filter filters for to-many fields, or use `Exists()` subqueries.

**Pitfall: caches mix versions.** With `AcceptHeaderVersioning`, a CDN caching on URL alone returns v2 bodies to v1 clients. Fix: ensure `Vary: Accept` (DRF sets it), or prefer URL versioning when a CDN is involved ([Ch 29 · Caching](topic.html?p=29-caching)).

**Pitfall: the schema endpoint is slow or leaks internals.** Generating the schema walks every view on each request; exposing `/api/schema/` publicly reveals admin-only endpoints. Fix: generate at build time with `manage.py spectacular`, serve a static file, and restrict the live endpoint (`SERVE_PERMISSIONS`).

**Debugging.** Use django-debug-toolbar on the browsable API, `print(view.filter_queryset(view.get_queryset()).query)` in a shell, `qs.explain(analyze=True)` on PostgreSQL, and `pg_stat_statements` to find which filter combinations are hot. Log the query params of slow requests (with PII scrubbed) to see real access patterns.

**Scaling.** Pagination is the main lever on response size; indexes per access path are the main lever on DB time; caching first pages of public lists is the cheapest win. For very large exports, do not paginate through the API in a loop from the client — run a Celery job ([Ch 31](topic.html?p=31-celery-background-tasks)) that streams with `.iterator(chunk_size=...)` to object storage and returns a download link.

## 9. Interview Questions

**Q: What pagination styles does DRF provide and how do they differ?**
A: `PageNumberPagination` (`?page=n`), `LimitOffsetPagination` (`?limit=&offset=`) and `CursorPagination` (`?cursor=`). The first two produce `COUNT(*)` plus `LIMIT/OFFSET`, give totals and random access, but get slower with depth and shift under inserts. Cursor pagination uses keyset filtering (`WHERE ordering_field < last_seen`) on a fixed ordering, so each page costs the same and stays stable while data changes, but there is no total and no jumping. All are configured via `DEFAULT_PAGINATION_CLASS` and `PAGE_SIZE` or per view.

**Q: Why is offset pagination slow on deep pages?**
A: The database must produce and discard `OFFSET` rows before returning `LIMIT` rows, so cost is linear in page depth — page 5,000 of 20 reads ~100k rows. PostgreSQL also has to count all matching rows for `COUNT(*)` because MVCC means there is no cheap exact count. Indexes help the ordering but do not let the engine skip the discarded rows.

**Q: What are the requirements for `CursorPagination`?**
A: A fixed `ordering` on a field that is unique (or nearly so) and never changes after creation — typically `-created_at` with `-id` as a tie-breaker — backed by an index. The default ordering is `-created`, so you must override it if your model lacks that field. Clients cannot jump to page N and there is no count. Arbitrary client orderings would each need their own index and break cursor stability, so restrict them.

**Q: Why must you set `max_page_size`?**
A: If `page_size_query_param` is enabled, clients choose page size; without a cap, `?page_size=10000000` makes the server load and serialise the whole table — an easy denial of service. `max_page_size` (and `max_limit` for limit/offset) clamps it.

**Q: How does filtering work in DRF and how do you prevent clients from filtering on arbitrary fields?**
A: `GenericAPIView.filter_queryset()` passes the queryset through each class in `filter_backends`. With django-filter's `DjangoFilterBackend`, only fields declared in `filterset_fields` or a `FilterSet` are applied, values are validated (bad input → 400), and lookups are fixed by you. Never pass `request.query_params` straight into `.filter(**...)` — it allows arbitrary lookups across relations, including sensitive columns.

**Q: What does `SearchFilter` do and what are its limitations?**
A: It applies `?search=` terms across `search_fields` using `icontains` by default (or `^` startswith, `=` exact, `@` full-text on PostgreSQL, `$` regex), ORing fields and ANDing terms, and adds `distinct()` when to-many lookups can create duplicates. `icontains` compiles to `UPPER(col) LIKE UPPER('%term%')`, which cannot use B-tree indexes, so it scans on large tables and has no relevance ranking. Use trigram indexes, PostgreSQL full-text search, or an external engine for real search.

**Q: How do you implement API versioning in DRF?**
A: Set `DEFAULT_VERSIONING_CLASS` (e.g. `URLPathVersioning`) with `ALLOWED_VERSIONS` and `DEFAULT_VERSION`; DRF sets `request.version` in `initial()`. Views then choose serializers or behaviour by version, typically in `get_serializer_class()`. URL path versioning is explicit and cache-friendly; Accept-header versioning keeps URLs stable but needs `Vary: Accept`. Version only for breaking changes and give old versions deprecation headers and a sunset date.

**Q: How do you generate API documentation for a DRF project?**
A: Use drf-spectacular: set `DEFAULT_SCHEMA_CLASS` to its `AutoSchema`, mount `SpectacularAPIView` plus Swagger/Redoc views, and annotate what introspection cannot infer with `@extend_schema` (parameters, responses, examples) and `@extend_schema_field` on `SerializerMethodField`s. Generate the file in CI with `manage.py spectacular --validate` and diff it in PRs so contract changes are reviewed. drf-yasg only supports OpenAPI 2, and DRF's built-in generator is basic.

**Q: Why is `count` sometimes different from the number of results you can page through?**
A: Usually duplicates from joins across to-many relations (filters or search on M2M/reverse FK): `COUNT(*)` counts joined rows while the client sees repeats, or `distinct()` is applied inconsistently. Also concurrent inserts/deletes between the count and page queries. Fix with `distinct=True`, `Exists()` subqueries, and cursor pagination for live data.

**Q: A public listing endpoint's DB CPU spikes whenever a crawler visits. Walk me through the fix. (Senior)**
A: Confirm with `pg_stat_statements` that deep `OFFSET` queries and `COUNT(*)` dominate. Short term: cap the page number, throttle anonymous traffic, and cache early pages. Structural fix: switch the endpoint (or a crawler-facing variant) to cursor pagination ordered by an indexed `(created_at, id)`, so each request is an index range scan with no count. Replace exact totals with estimates or `has_more`. Make sure every permitted filter/order combination has a supporting composite index starting with the scope column, and verify with `EXPLAIN ANALYZE`. Version the change if clients depend on `page` and `count`.

**Q: How would you support cursor pagination while letting clients sort by price? (Senior)**
A: Make the ordering part of the cursor contract: allow a small whitelist of orderings, each with a unique tie-breaker (`price_cents, id`) and a composite index (`tenant, price_cents, id`). DRF's `CursorPagination` reads `OrderingFilter`'s ordering if present, but it encodes only the first field's position plus an offset for ties, so heavy ties (many products at the same price) cost extra steps; for exact keyset behaviour write a custom paginator that encodes the full tuple and filters with a row comparison (`(price_cents, id) > (%s, %s)`). A cursor must be rejected if the client changes ordering mid-stream. Document that cursors are opaque and short-lived.

**Q: How do you evolve an API from v1 to v2 without breaking mobile clients you cannot force-upgrade? (Senior)**
A: Prefer additive, backwards-compatible changes; reserve a new version for breaking ones. Implement v2 with URL path versioning, sharing querysets and services and differing only in serializers (selected by a version→serializer map). Keep v1 frozen with contract tests from its published OpenAPI schema, return `Deprecation`/`Sunset` headers, track v1 usage per client id/app version in logs, and coordinate a minimum supported app version with the mobile team. Remove v1 only when traffic is near zero, after a communicated sunset date.

**Q: Where does pagination run, and why doesn't my `@action` paginate?**
A: Only `ListModelMixin.list()` calls `paginate_queryset()` and `get_paginated_response()`. Custom actions and plain `APIView`s must call them explicitly (`page = self.paginate_queryset(qs)`), or instantiate a paginator and call `paginate_queryset(qs, request, view=self)`.

## 10. Quick Revision & Cheat Sheet

| Topic | Remember |
|---|---|
| Enable pagination | `DEFAULT_PAGINATION_CLASS` **and** `PAGE_SIZE` |
| PageNumber/LimitOffset SQL | `COUNT(*)` + `LIMIT/OFFSET` |
| Cursor SQL | `WHERE key < position ORDER BY key LIMIT n+1`, no count |
| Cursor needs | unique, immutable ordering + index; default `-created` |
| Caps | `max_page_size`, `max_limit` |
| Filter order | `filter_backends` in sequence; also applied to `get_object()` |
| django-filter | whitelisted, typed, 400 on bad input |
| SearchFilter | `icontains`; `^ = @ $` prefixes; distinct on to-many |
| OrderingFilter | `ordering_fields` whitelist; `ordering` default |
| Versioning | `request.version` set in `initial()`; URL path most common |
| Docs | drf-spectacular, `@extend_schema`, `manage.py spectacular` |

- Every list endpoint must be bounded.
- Cursor for feeds, page numbers for small admin lists.
- Never `.filter(**request.query_params)`.
- Every allowed filter/ordering is an access path — index it.
- `COUNT(*)` is not free on PostgreSQL.
- Actions don't paginate automatically.
- Version only for breaking changes; deprecate with headers and data.
- Generate the schema in CI and review diffs.

## 11. Hands-On Exercises

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2" "djangorestframework>=3.15" django-filter drf-spectacular "psycopg[binary]"
```

1. **Measure offset.** Seed 2M products in PostgreSQL. Time `?page=1`, `?page=1000`, `?page=50000` with page-number pagination and capture `EXPLAIN ANALYZE` for each.
2. **Switch to cursor.** Configure `CursorPagination` on `(-created_at, -id)` with a matching index; repeat the deep-page measurement by following `next` links (script it).
3. **Lookup injection.** Write the naive `.filter(**request.query_params.dict())` view and demonstrate filtering on `owner__email__startswith`; replace with a `FilterSet` and show the 400 on bad input.
4. **Search performance.** Compare `SearchFilter` `icontains` with and without a `pg_trgm` GIN index; then implement `@` full-text search.
5. **Versioning + schema.** Add v1/v2 serializers, URL path versioning, generate the schema with `spectacular --validate`, and add a CI step that fails if the schema changes without a committed update.

**Mini project — "Catalogue API".** Products with categories and tags for multiple tenants. Requirements: cursor pagination for the feed, page numbers for an admin list with estimated counts, a FilterSet with price range/category/in_stock, trigram search, whitelisted orderings each with an index, v1/v2 with a renamed field, deprecation headers on v1, and Swagger UI at `/api/docs/` served from a build-time schema.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization) · [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres) · [Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers) · [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers) · [Ch 23 · DRF Authentication, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling) · [Ch 29 · Caching in Django](topic.html?p=29-caching) · [Ch 38 · Interview: DRF, Security & Scale](topic.html?p=38-interview-drf-advanced)

**Other handbooks:** [REST API · Pagination](../rest-api/topic.html?p=13-pagination) · [REST API · Filtering, Sorting & Searching](../rest-api/topic.html?p=12-filtering-sorting-searching) · [REST API · API Versioning](../rest-api/topic.html?p=31-api-versioning) · [REST API · Backward Compatibility & Deprecation](../rest-api/topic.html?p=32-backward-compatibility-deprecation) · [REST API · OpenAPI Specification](../rest-api/topic.html?p=33-openapi-specification) · [SQL · Sorting & Pagination](../sql/topic.html?p=03-sorting-pagination) · [SQL · Index Design](../sql/topic.html?p=20-index-design)

- **Pagination (API Guide)** — Django REST framework · *Intermediate* · all three classes, their settings and cursor caveats. <https://www.django-rest-framework.org/api-guide/pagination/>
- **Filtering (API Guide)** — Django REST framework · *Intermediate* · filter backends, SearchFilter, OrderingFilter. <https://www.django-rest-framework.org/api-guide/filtering/>
- **Versioning (API Guide)** — Django REST framework · *Intermediate* · each scheme and how `reverse` interacts with versions. <https://www.django-rest-framework.org/api-guide/versioning/>
- **django-filter documentation** — django-filter · *Intermediate* · FilterSets, lookups and the DRF integration. <https://django-filter.readthedocs.io/>
- **drf-spectacular documentation** — tfranzel · *Intermediate* · OpenAPI 3 generation, `@extend_schema`, customisation. <https://drf-spectacular.readthedocs.io/>
- **Use the Index, Luke — Paging Through Results** — Markus Winand · *Advanced* · why OFFSET is slow and how keyset pagination works. <https://use-the-index-luke.com/no-offset>
- **PostgreSQL full-text search** — PostgreSQL docs · *Advanced* · `tsvector`, ranking and GIN indexes behind the `@` search prefix. <https://www.postgresql.org/docs/current/textsearch.html>

---

*Django Handbook — chapter 24.*
