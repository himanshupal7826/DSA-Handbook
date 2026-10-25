# 07 · The Django Admin

> **In one line:** The admin is a full CRUD application generated at runtime from your models and `ModelAdmin` classes — superb as an internal back-office tool if you control its queries and permissions, and a liability if you let it run unbounded `COUNT(*)`s, N+1 list pages and customer-facing workflows.

---

## 1. Overview

> **Builds on:** [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation) (every admin add/change page is a generated ModelForm) and [Ch 03 · URL Routing & URLconf](topic.html?p=03-urls-routing) (the admin mounts its own URLconf). Models and relations are covered in [Ch 08 · Models & Fields](topic.html?p=08-models-fields) and [Ch 09 · Relationships](topic.html?p=09-relationships).

Every product needs a back office: support staff look up a customer, finance refunds an order, ops toggles a feature flag, a content editor fixes a typo. Building those screens by hand — list pages with search, filters, pagination, edit forms with validation, audit history, permissions — is weeks of unglamorous work for every model. Teams that skip it end up running SQL against production, which is how "I accidentally updated every row" incidents happen.

Django's answer is **`django.contrib.admin`**: register a model and you get a searchable, filterable, paginated list view, add/change/delete forms with validation, a history log and per-model permissions, all driven by introspecting `Model._meta`. You customise it declaratively through a **`ModelAdmin`** class — `list_display`, `list_filter`, `search_fields`, `inlines`, `actions` — and imperatively by overriding hooks like `get_queryset()`, `save_model()` and `has_change_permission()`.

The naive use is `admin.site.register(Order)` and nothing else. It works beautifully on a 500-row dev database. In production with 20 million orders, the same page runs a full-table `COUNT(*)`, renders a `<select>` with every customer for the FK field, and issues one query per row for each related column in the list. The admin did not get slower; your data got bigger and the defaults were tuned for convenience, not scale. This chapter teaches both halves: how to build a genuinely useful admin, and how to keep it fast and safe.

> **Why this matters:** interviewers ask "how would you customise the admin" to see whether you know `ModelAdmin` beyond `list_display` — and they ask "the admin page for orders times out, what do you do" to see whether you understand the queries it generates.

## 2. Core Concepts

- **`AdminSite`** — the object that holds the registry (`site._registry: {Model: ModelAdmin instance}`) and serves the index, login, and app pages. `admin.site` is the default instance. *Why it matters:* you can create several sites (e.g. a restricted support site) with different models.
- **Autodiscovery** — `django.contrib.admin`'s `AdminConfig.ready()` calls `autodiscover()`, which imports every installed app's `admin.py`. *Why it matters:* registrations run at startup; an import error in any `admin.py` breaks the whole project boot.
- **`ModelAdmin`** — the per-model configuration and view controller; one instance per registered model, shared across all requests. *Why it matters:* never store per-request state on `self`.
- **`@admin.register(Model)`** — decorator form of `admin.site.register(Model, ModelAdmin)`.
- **Changelist** — the list page, implemented by `ModelAdmin.changelist_view()` and the `ChangeList` class (`django.contrib.admin.views.main`) that builds the queryset.
- **`list_display`** — columns on the changelist: field names, callables, or `ModelAdmin` methods (decorate with `@admin.display(description=..., ordering=..., boolean=...)`).
- **`list_filter`** — sidebar filters: field names, `SimpleListFilter` subclasses, or `("field", RelatedOnlyFieldListFilter)`.
- **`search_fields`** — fields searched by the search box, with prefixes `^` (startswith), `=` (iexact), `@` (full-text search, on PostgreSQL); default is `icontains`.
- **`list_select_related`** — controls `select_related()` on the changelist queryset. *Why it matters:* the main N+1 lever.
- **Inlines** — `TabularInline` / `StackedInline` edit child rows (FK to the parent) on the parent's page; they are inline formsets.
- **Actions** — functions applied to selected rows of the changelist (`delete_selected` is built in); declared with `@admin.action`.
- **`raw_id_fields` / `autocomplete_fields`** — replace a giant `<select>` for FK/M2M with an ID input or an AJAX autocomplete. *Why it matters:* the cure for multi-megabyte change pages.
- **`readonly_fields`**, **`fieldsets`**, **`fields`**, **`exclude`** — what the change form shows and how.
- **Permissions** — the admin checks `is_staff` to let a user in, then `has_view/add/change/delete_permission` per model, which by default map to `app.view_model` etc. Superusers pass everything.
- **`LogEntry`** — the `django_admin_log` table recording each add/change/delete made through the admin. *Why it matters:* a free (partial) audit trail.

## 3. Theory & Principles

### How the admin builds a page

The admin is just Django: URLs, views, ModelForms and templates. When you include `admin.site.urls`, `AdminSite.get_urls()` generates, for each registered model, five URL patterns pointing at the ModelAdmin's views:

```text
/admin/<app>/<model>/                     → changelist_view   (list, filters, search, actions)
/admin/<app>/<model>/add/                 → add_view          (changeform_view, object_id=None)
/admin/<app>/<model>/<pk>/change/         → change_view       (changeform_view)
/admin/<app>/<model>/<pk>/delete/         → delete_view       (confirmation + collector preview)
/admin/<app>/<model>/<pk>/history/        → history_view      (LogEntry rows)
```

Each view is wrapped by `AdminSite.admin_view()`, which enforces login + `is_staff`, adds `csrf_protect`, and marks the response as never cached. Inside, the view checks the relevant `has_*_permission(request, obj)` and returns 403 if it fails.

For a **change page**, `changeform_view` calls `get_object()` (via `get_queryset()`, so your restrictions apply), then `get_form()` — which calls `modelform_factory` with your `fields`/`fieldsets`/`exclude`/`readonly_fields`/`formfield_overrides` — and `get_formsets_with_inlines()` for the inline formsets. On POST it validates form and formsets exactly as in Chapter 6, then calls `save_model()`, `save_related()` (which saves M2M and inline formsets) and `log_change()` inside a transaction.

For the **changelist**, `changelist_view` builds a `ChangeList` object, and that object assembles the queryset in a fixed order. This is where almost every admin performance problem originates, so it is worth knowing precisely.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj07a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">ChangeList.get_queryset(): how one admin list page becomes SQL</text>
  <rect x="20" y="44" width="190" height="44" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="115" y="63" text-anchor="middle" fill="#1e293b" font-weight="bold">ModelAdmin.get_queryset()</text>
  <text x="115" y="78" text-anchor="middle" fill="#334155" font-size="9">your annotate / tenant filter</text>
  <path d="M212,66 L236,66" stroke="#2563eb" stroke-width="2" marker-end="url(#dj07a)"/>
  <rect x="238" y="44" width="190" height="44" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="333" y="63" text-anchor="middle" fill="#1e293b" font-weight="bold">list_filter</text>
  <text x="333" y="78" text-anchor="middle" fill="#334155" font-size="9">each filter's queryset() &#8594; WHERE</text>
  <path d="M430,66 L454,66" stroke="#2563eb" stroke-width="2" marker-end="url(#dj07a)"/>
  <rect x="456" y="44" width="190" height="44" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="551" y="63" text-anchor="middle" fill="#1e293b" font-weight="bold">get_search_results()</text>
  <text x="551" y="78" text-anchor="middle" fill="#334155" font-size="9">search_fields &#8594; ILIKE / UPPER LIKE</text>
  <path d="M648,66 L672,66" stroke="#2563eb" stroke-width="2" marker-end="url(#dj07a)"/>
  <rect x="674" y="44" width="186" height="44" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="767" y="63" text-anchor="middle" fill="#1e293b" font-weight="bold">ordering</text>
  <text x="767" y="78" text-anchor="middle" fill="#334155" font-size="9">+ pk tiebreak (deterministic)</text>
  <path d="M767,90 L767,116" stroke="#2563eb" stroke-width="2" marker-end="url(#dj07a)"/>
  <rect x="560" y="118" width="300" height="50" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="710" y="138" text-anchor="middle" fill="#14532d" font-weight="bold">apply_select_related()</text>
  <text x="710" y="155" text-anchor="middle" fill="#166534" font-size="9">list_select_related, or FKs named directly in list_display</text>
  <path d="M558,143 L512,143" stroke="#2563eb" stroke-width="2" marker-end="url(#dj07a)"/>
  <rect x="20" y="118" width="490" height="96" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="265" y="138" text-anchor="middle" fill="#991b1b" font-weight="bold">Paginator: the expensive part on big tables</text>
  <text x="36" y="158" fill="#7f1d1d" font-size="10">1. SELECT COUNT(*) FROM ... WHERE &lt;filters&gt;      (result count)</text>
  <text x="36" y="176" fill="#7f1d1d" font-size="10">2. SELECT COUNT(*) FROM ... unfiltered       (if show_full_result_count)</text>
  <text x="36" y="194" fill="#7f1d1d" font-size="10">3. SELECT ... ORDER BY ... LIMIT 100 OFFSET n   (the page)</text>
  <text x="36" y="208" fill="#7f1d1d" font-size="9">PostgreSQL COUNT(*) scans all matching rows &#8212; seconds on 10M+ rows</text>
  <path d="M265,216 L265,242" stroke="#2563eb" stroke-width="2" marker-end="url(#dj07a)"/>
  <rect x="20" y="244" width="840" height="76" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="264" text-anchor="middle" fill="#92400e" font-weight="bold">Render: one row per object, one cell per list_display entry</text>
  <text x="36" y="284" fill="#b45309" font-size="10">field name "customer" &#8594; covered by auto select_related &#183; callable obj.customer.email &#8594; NOT detected &#8594; 1 query per row</text>
  <text x="36" y="302" fill="#b45309" font-size="10">method doing obj.items.count() &#8594; 1 COUNT per row &#8594; replace with annotate(Count("items")) in get_queryset()</text>
  <rect x="20" y="334" width="840" height="70" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="440" y="354" text-anchor="middle" fill="#5b21b6" font-weight="bold">Sidebar extras that also query</text>
  <text x="36" y="374" fill="#6d28d9" font-size="10">list_filter on a FK &#8594; loads every related object as a choice &#183; date_hierarchy &#8594; DISTINCT dates query</text>
  <text x="36" y="392" fill="#6d28d9" font-size="10">show_facets (5.0+) &#8594; extra COUNTs per filter option when facets are shown</text>
</svg>
```

### How `list_select_related` really works

`ChangeList.apply_select_related()` follows three rules. If `list_select_related = True`, it calls `select_related()` with no arguments (follows all non-null FKs — can create big joins). If it is a list/tuple, it calls `select_related(*fields)`. If it is `False` (the default), Django **inspects `list_display`** and adds `select_related()` for any entry that is directly a ForeignKey field. The catch: a callable or method that does `obj.customer.email` is opaque to that inspection, so it triggers one query per row. Explicit `list_select_related = ["customer", "customer__company"]` is the reliable form.

### How search is compiled

`get_search_results()` splits the search string into terms (respecting quotes). Each term must match **at least one** search field (OR across fields), and **all** terms must match (AND across terms). With the default `icontains` lookup on PostgreSQL that becomes `UPPER(col::text) LIKE UPPER('%term%')`, which **cannot use a normal B-tree index** — a leading wildcard forces a sequential scan. Searching across a to-many relation (`items__sku`) can produce duplicate rows; the admin detects this (`lookup_spawns_duplicates`) and de-duplicates the result, which adds cost.

## 4. Architecture & Workflow

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj07b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Admin components: registry &#8594; ModelAdmin &#8594; views &#8594; forms &#8594; DB + LogEntry</text>
  <rect x="20" y="50" width="180" height="120" rx="10" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="110" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">Startup</text>
  <text x="110" y="94" text-anchor="middle" fill="#334155" font-size="10">AdminConfig.ready()</text>
  <text x="110" y="110" text-anchor="middle" fill="#334155" font-size="10">autodiscover()</text>
  <text x="110" y="126" text-anchor="middle" fill="#334155" font-size="10">imports each app's admin.py</text>
  <text x="110" y="142" text-anchor="middle" fill="#334155" font-size="10">@admin.register &#8594; site._registry</text>
  <path d="M202,110 L236,110" stroke="#334155" stroke-width="2" marker-end="url(#dj07b)"/>
  <rect x="238" y="50" width="190" height="120" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="333" y="72" text-anchor="middle" fill="#1e40af" font-weight="bold">AdminSite</text>
  <text x="333" y="94" text-anchor="middle" fill="#1e293b" font-size="10">get_urls(): index, login,</text>
  <text x="333" y="110" text-anchor="middle" fill="#1e293b" font-size="10">5 URLs per registered model</text>
  <text x="333" y="126" text-anchor="middle" fill="#1e293b" font-size="10">admin_view(): login + is_staff</text>
  <text x="333" y="142" text-anchor="middle" fill="#1e293b" font-size="10">+ csrf_protect + never_cache</text>
  <path d="M430,110 L464,110" stroke="#334155" stroke-width="2" marker-end="url(#dj07b)"/>
  <rect x="466" y="50" width="394" height="120" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="663" y="72" text-anchor="middle" fill="#5b21b6" font-weight="bold">ModelAdmin (one shared instance per model)</text>
  <text x="482" y="94" fill="#1e293b" font-size="10">changelist_view &#8594; ChangeList (filters, search, paging, actions)</text>
  <text x="482" y="112" fill="#1e293b" font-size="10">changeform_view &#8594; get_form() + inline formsets</text>
  <text x="482" y="130" fill="#1e293b" font-size="10">delete_view &#8594; Collector preview of cascades</text>
  <text x="482" y="148" fill="#1e293b" font-size="10">has_view/add/change/delete_permission(request, obj)</text>
  <path d="M663,172 L663,206" stroke="#334155" stroke-width="2" marker-end="url(#dj07b)"/>
  <rect x="466" y="208" width="394" height="80" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="663" y="230" text-anchor="middle" fill="#14532d" font-weight="bold">POST on change page (one transaction)</text>
  <text x="482" y="250" fill="#166534" font-size="10">form.is_valid() + formsets valid &#8594; save_model() &#8594; save_related()</text>
  <text x="482" y="268" fill="#166534" font-size="10">&#8594; log_change() writes LogEntry &#8594; message + redirect</text>
  <path d="M464,248 L380,248" stroke="#334155" stroke-width="2" marker-end="url(#dj07b)"/>
  <rect x="160" y="208" width="218" height="80" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="269" y="230" text-anchor="middle" fill="#92400e" font-weight="bold">Database</text>
  <text x="269" y="250" text-anchor="middle" fill="#b45309" font-size="10">your tables</text>
  <text x="269" y="268" text-anchor="middle" fill="#b45309" font-size="10">django_admin_log (LogEntry)</text>
  <rect x="20" y="306" width="840" height="58" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="440" y="326" text-anchor="middle" fill="#991b1b" font-weight="bold">Bypasses to remember</text>
  <text x="440" y="346" text-anchor="middle" fill="#7f1d1d" font-size="10">delete_selected uses queryset.delete() (no Model.delete() override) &#183; list_editable saves via formset &#183; actions see the raw queryset</text>
</svg>
```

### The request workflow for a bulk action

```text
POST /admin/shop/order/   action=mark_shipped  _selected_action=[12, 15, 19]
  → changelist_view → response_action()
      → checks the action's required permissions (@admin.action(permissions=["change"]))
      → queryset = cl.get_queryset().filter(pk__in=selected)   # your get_queryset applies
      → action(modeladmin, request, queryset)
          → returns None  → redirect back to changelist (messages shown)
          → returns HttpResponse → rendered as-is (intermediate page / CSV download)
```

### Customisation layers (cheapest first)

1. **Declarative options** on `ModelAdmin` — `list_display`, `list_filter`, `search_fields`, `readonly_fields`, `fieldsets`, `autocomplete_fields`.
2. **Hook methods** — `get_queryset`, `get_readonly_fields`, `get_list_display`, `get_search_results`, `save_model`, `delete_queryset`, `has_*_permission`, `get_form`.
3. **Custom forms** — `form = OrderAdminForm` for validation specific to staff.
4. **Template overrides** — `templates/admin/<app>/<model>/change_form.html` extending the stock template and overriding a block.
5. **Custom views** — `get_urls()` to add pages, wrapped in `self.admin_site.admin_view()`.
6. **Your own app** — when you find yourself at layer 5 for most screens, it is time to build a real internal tool.

## 5. Implementation

### Simple example

```python
# blog/admin.py
from django.contrib import admin
from .models import Author, Post


@admin.register(Author)
class AuthorAdmin(admin.ModelAdmin):
    list_display = ["name", "email"]
    search_fields = ["name", "email"]          # required for autocomplete_fields elsewhere


@admin.register(Post)
class PostAdmin(admin.ModelAdmin):
    list_display = ["title", "author", "status", "published_at", "is_recent"]
    list_filter = ["status", "published_at"]
    search_fields = ["title", "^author__name"]  # ^ = istartswith (can use an index with the right opclass)
    date_hierarchy = "published_at"
    prepopulated_fields = {"slug": ["title"]}
    autocomplete_fields = ["author"]
    readonly_fields = ["created_at"]
    ordering = ["-published_at"]

    @admin.display(boolean=True, description="Recent?", ordering="published_at")
    def is_recent(self, obj):
        from django.utils import timezone
        return obj.published_at and (timezone.now() - obj.published_at).days < 7
```

```bash
python manage.py createsuperuser
python manage.py runserver   # http://127.0.0.1:8000/admin/
```

Because `author` is an FK named directly in `list_display`, the changelist SQL already joins it:

```sql
SELECT "blog_post"."id", "blog_post"."title", "blog_post"."status", "blog_post"."published_at",
       "blog_author"."id", "blog_author"."name", "blog_author"."email"
FROM "blog_post"
INNER JOIN "blog_author" ON ("blog_post"."author_id" = "blog_author"."id")
ORDER BY "blog_post"."published_at" DESC, "blog_post"."id" DESC
LIMIT 100;
```

### Real-world example: an orders back office

Requirements: support staff see orders with customer email, item count and total; they filter by status and "high value"; they search by order number or customer email; they can mark orders shipped in bulk and export CSV; they can edit line items inline; only the finance group may change totals; the table has tens of millions of rows.

```python
# shop/admin.py
import csv
from django.contrib import admin, messages
from django.db.models import Count, Sum
from django.http import StreamingHttpResponse
from django.utils import timezone
from .models import Order, OrderItem


class OrderItemInline(admin.TabularInline):
    model = OrderItem
    extra = 0
    autocomplete_fields = ["product"]          # never a 100k-option <select>
    readonly_fields = ["line_total"]
    fields = ["product", "quantity", "unit_price", "line_total"]

    def get_queryset(self, request):
        return super().get_queryset(request).select_related("product")


class HighValueFilter(admin.SimpleListFilter):
    title = "value"
    parameter_name = "value"

    def lookups(self, request, model_admin):
        return [("high", "≥ 1,000"), ("normal", "< 1,000")]

    def queryset(self, request, queryset):
        if self.value() == "high":
            return queryset.filter(total__gte=1000)
        if self.value() == "normal":
            return queryset.filter(total__lt=1000)
        return queryset


class Echo:
    def write(self, value):
        return value


@admin.register(Order)
class OrderAdmin(admin.ModelAdmin):
    list_display = ["number", "customer_email", "status", "item_count", "total", "created_at"]
    list_filter = ["status", HighValueFilter, ("created_at", admin.DateFieldListFilter)]
    search_fields = ["=number", "=customer__email"]   # exact matches: index-friendly
    list_select_related = ["customer"]
    list_per_page = 50
    show_full_result_count = False                    # skip the unfiltered COUNT(*)
    raw_id_fields = ["customer"]
    readonly_fields = ["number", "created_at"]
    inlines = [OrderItemInline]
    actions = ["mark_shipped", "export_csv"]
    fieldsets = [
        (None, {"fields": ["number", "customer", "status"]}),
        ("Money", {"fields": ["total", "currency"], "classes": ["collapse"]}),
        ("Audit", {"fields": ["created_at"]}),
    ]

    def get_queryset(self, request):
        return super().get_queryset(request).annotate(_item_count=Count("items"))

    @admin.display(description="Customer", ordering="customer__email")
    def customer_email(self, obj):
        return obj.customer.email                     # covered by list_select_related

    @admin.display(description="Items", ordering="_item_count")
    def item_count(self, obj):
        return obj._item_count                        # from the annotation, no per-row query

    def get_readonly_fields(self, request, obj=None):
        ro = list(super().get_readonly_fields(request, obj))
        if not request.user.groups.filter(name="finance").exists():
            ro += ["total", "currency"]
        return ro

    @admin.action(description="Mark selected orders as shipped", permissions=["change"])
    def mark_shipped(self, request, queryset):
        updated = queryset.filter(status=Order.Status.PAID).update(
            status=Order.Status.SHIPPED, shipped_at=timezone.now()
        )
        self.message_user(request, f"{updated} orders marked shipped.", messages.SUCCESS)

    @admin.action(description="Export selected to CSV", permissions=["view"])
    def export_csv(self, request, queryset):
        writer = csv.writer(Echo())
        rows = queryset.values_list("number", "customer__email", "status", "total").iterator(chunk_size=2000)
        header = ["number", "email", "status", "total"]
        stream = (writer.writerow(r) for r in [header, *rows])
        resp = StreamingHttpResponse(stream, content_type="text/csv")
        resp["Content-Disposition"] = 'attachment; filename="orders.csv"'
        return resp

    def save_model(self, request, obj, form, change):
        if not change:
            obj.created_by = request.user
        super().save_model(request, obj, form, change)
```

> **Gotcha:** `queryset.update()` in `mark_shipped` skips `Order.save()` and `post_save` signals. That is usually what you want for speed — but if a signal sends the "your order shipped" email, nothing is sent. Either loop and `save(update_fields=[...])`, or (better) enqueue the notification explicitly with `transaction.on_commit`.

The resulting page SQL (with a status filter and no search) is three statements, none per-row:

```sql
SELECT COUNT(*) AS "__count" FROM "shop_order" WHERE "shop_order"."status" = 'paid';

SELECT "shop_order"."id", "shop_order"."number", "shop_order"."status", "shop_order"."total",
       "shop_order"."created_at", COUNT("shop_orderitem"."id") AS "_item_count",
       "accounts_customer"."id", "accounts_customer"."email"
FROM "shop_order"
LEFT OUTER JOIN "shop_orderitem" ON ("shop_order"."id" = "shop_orderitem"."order_id")
INNER JOIN "accounts_customer" ON ("shop_order"."customer_id" = "accounts_customer"."id")
WHERE "shop_order"."status" = 'paid'
GROUP BY "shop_order"."id", "accounts_customer"."id"
ORDER BY "shop_order"."id" DESC
LIMIT 50;
```

Compare the naive version (`list_display = ["number", "customer_email_naive", "items_naive"]` where the methods do `obj.customer.email` and `obj.items.count()`): 1 COUNT + 1 page query + 50 customer queries + 50 item counts = **102 queries** per page load.

### Taming COUNT(*) on huge tables

`show_full_result_count = False` removes one COUNT, but the paginator still counts the filtered set. For very large tables, a custom paginator that uses PostgreSQL's planner estimate when there are no filters is a common pattern:

```python
# core/admin_paginator.py
from django.core.paginator import Paginator
from django.db import connection
from django.utils.functional import cached_property


class EstimatedCountPaginator(Paginator):
    @cached_property
    def count(self):
        query = self.object_list.query
        if not query.where:                      # unfiltered: use pg_class estimate
            with connection.cursor() as cur:
                cur.execute("SELECT reltuples::bigint FROM pg_class WHERE relname = %s",
                            [query.model._meta.db_table])
                estimate = cur.fetchone()[0]
            if estimate > 100_000:
                return estimate
        return super().count
```

```python
class OrderAdmin(admin.ModelAdmin):
    paginator = EstimatedCountPaginator
```

### A restricted second admin site

```python
# support/admin.py
from django.contrib import admin
from shop.models import Order


class SupportSite(admin.AdminSite):
    site_header = "Support Console"
    site_title = "Support"

    def has_permission(self, request):
        return request.user.is_active and request.user.groups.filter(name="support").exists()


support_site = SupportSite(name="support")


@admin.register(Order, site=support_site)
class SupportOrderAdmin(admin.ModelAdmin):
    list_display = ["number", "status"]
    search_fields = ["=number"]

    def has_delete_permission(self, request, obj=None):
        return False
```

```python
# config/urls.py
from django.contrib import admin
from django.urls import path
from support.admin import support_site

urlpatterns = [
    path("ops-7f3a/", admin.site.urls),     # not /admin/: cuts noise from scanners (not real security)
    path("support/", support_site.urls),
]
```

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Admin | Custom internal tool (Django views / React + DRF) |
|---|---|---|
| Time to first screen | Minutes | Days to weeks |
| CRUD, search, filters, pagination | Built in | You build them |
| Validation | Model + ModelForm validation automatically | You wire it |
| Permissions | Model-level out of the box; object-level via hooks | Whatever you design |
| Audit | `LogEntry` (no field-level diff) | Whatever you design |
| UX for complex workflows | Poor (multi-step, approvals, dashboards) | Good |
| Performance at scale | Needs tuning (COUNT, N+1, selects) | Designed in from the start |
| Exposure risk | Powerful UI that bypasses product rules | Only what you expose |

### When to use
- Internal back-office for trusted staff: support lookups, content editing, configuration tables, data fixes.
- Early-stage products, where an admin buys months of runway before you need custom tooling.
- Read-mostly inspection of production data (with `has_change_permission` returning `False` for most staff).

### When NOT to use
- As a customer-facing UI or a self-service portal — its look, permissions model and URL structure are not designed for untrusted users.
- For workflows with state machines, approvals, or multi-step wizards — fighting the admin costs more than building a view.
- For bulk operations on millions of rows — write a management command or a Celery job.

## 7. Common Mistakes & Best Practices

**1. Callables in `list_display` that touch relations.** `obj.customer.email` or `obj.items.count()` cause per-row queries. *Instead:* `list_select_related` for FKs and `annotate()` in `get_queryset()` for counts/sums; expose annotations through `@admin.display(ordering="_alias")` so the column is also sortable.

**2. FK dropdowns over large tables.** The default widget for a FK is a `<select>` containing every row of the target table. *Instead:* `raw_id_fields` or `autocomplete_fields` (the latter needs `search_fields` on the related model's admin).

**3. `list_filter` on a high-cardinality FK.** `list_filter = ["customer"]` loads all customers into the sidebar. *Instead:* use `RelatedOnlyFieldListFilter`, a `SimpleListFilter` with a small set of options, or search.

**4. Leading-wildcard search on big tables.** Default `icontains` across five text columns is a sequential scan on every keystroke-search. *Instead:* `=` or `^` prefixes for identifiers, a trigram index (`pg_trgm` GIN) for fuzzy text, or `@` full-text on PostgreSQL (see [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres)).

**5. Assuming `delete_selected` calls your `Model.delete()`.** It calls `delete_queryset()`, which does `queryset.delete()`. Overridden `delete()` methods (soft delete!) are skipped; signals do fire. *Instead:* override `delete_queryset()` and `delete_model()` on the ModelAdmin, or disable the action with `actions` / `get_actions()`.

**6. Giving everyone `is_superuser`.** It is the path of least resistance and it means every support agent can delete production data and change permissions. *Instead:* groups with exact model permissions, `has_*_permission` overrides for row-level rules, and a handful of named superusers.

**7. Storing request state on the ModelAdmin.** `self.current_user = request.user` in one method and reading it in another is a race between concurrent requests, since the instance is shared. Pass `request` through instead.

**8. Business logic only in `save_model()`.** It runs only for admin saves. Put invariants in the model or a service layer; use `save_model()` for admin-specific concerns (setting `created_by`).

**Best practices:** register every model you might need for debugging, but with conservative permissions; always set `list_display`, `search_fields`, `list_select_related` and `raw_id_fields`/`autocomplete_fields` on large models; write a test that loads each changelist with `assertNumQueries` so new columns cannot reintroduce N+1.

## 8. Production: Pitfalls, Debugging & Scaling

**Changelist timeouts on large tables.** In production the orders admin takes 30 s and Gunicorn kills the worker. Root cause, usually in this order: the paginator's `COUNT(*)` over millions of rows, a leading-wildcard search, ordering by an unindexed column (the default `-pk` is fine; `ordering = ["-created_at"]` needs an index), and N+1 columns. Fix with `show_full_result_count = False`, an estimating paginator, indexed `ordering`, exact search prefixes and annotations.

**Change page loads megabytes.** Symptom: the edit page for a single order is slow even though the list is fine. Root cause: FK/M2M `<select>` widgets enumerating whole tables, or inlines with hundreds of child rows. Fix: `raw_id_fields`/`autocomplete_fields`, paginate or cap inlines (`max_num`), or link to a filtered changelist instead of inlining.

**Delete confirmation page hangs.** `delete_view` runs the deletion **Collector** to show everything that will cascade — on an object with millions of dependants that is millions of rows loaded into memory. Fix: block admin deletion for such models (`has_delete_permission` → `False`), use soft delete, or delete in batches from a background job.

**Security incidents.** The admin is the most valuable target in your app: one phished staff password equals full data access. Mitigations: 2FA (e.g. `django-otp`), SSO, restrict the admin path at the proxy (VPN / IP allow-list), separate staff accounts from customer accounts, short session age for staff, and alerting on `LogEntry` deletions. Changing the URL from `/admin/` only reduces scanner noise. See [Ch 28 · Security](topic.html?p=28-security).

**Debugging.** Install django-debug-toolbar in staging and open the changelist — the SQL panel shows duplicates per row instantly. In tests:

```python
from django.test import TestCase
from django.urls import reverse


class OrderAdminQueryTest(TestCase):
    def test_changelist_query_count_is_constant(self):
        self.client.force_login(make_superuser())
        make_orders(5)
        with self.assertNumQueries(7):     # session, user, count, page, ... - measure once, then lock it
            self.client.get(reverse("admin:shop_order_changelist"))
        make_orders(50)
        with self.assertNumQueries(7):     # same number with 10x the rows → no N+1
            self.client.get(reverse("admin:shop_order_changelist"))
```

Admin URL names follow `admin:<app>_<model>_<changelist|add|change|delete|history>`, which is how you `reverse()` to them from your own code and templates.

**Scaling notes.** Point heavy read-only admin traffic at a replica with a custom `get_queryset().using("replica")` only where stale data is acceptable (see [Ch 34 · Scaling Django](topic.html?p=34-scaling-databases)). Long-running actions (exports of millions of rows, re-indexing) should enqueue a Celery task and return immediately ([Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks)).

## 9. Interview Questions

**Q: How does the admin know which models to show?**
A: Models must be registered with an `AdminSite`, either via `admin.site.register(Model, ModelAdmin)` or the `@admin.register(Model)` decorator, usually in the app's `admin.py`. At startup `django.contrib.admin`'s `AdminConfig.ready()` calls `autodiscover()`, which imports every installed app's `admin` module so those registrations run. The site keeps a `_registry` dict of model → ModelAdmin instance and generates URLs for each entry. If you use `SimpleAdminConfig` instead, autodiscovery is off and you must import modules yourself.

**Q: What are the most useful ModelAdmin options?**
A: For the list page: `list_display`, `list_filter`, `search_fields`, `list_select_related`, `date_hierarchy`, `ordering`, `list_per_page`, `list_editable` and `actions`. For the edit page: `fields`/`fieldsets`, `readonly_fields`, `raw_id_fields` or `autocomplete_fields`, `prepopulated_fields`, `inlines` and a custom `form`. Hooks such as `get_queryset`, `save_model`, `get_readonly_fields` and `has_*_permission` let you change behaviour per request. Knowing which options add queries — filters, counts, FK selects — is what separates basic from production use.

**Q: How do you show a computed column in list_display and make it sortable?**
A: Add a ModelAdmin method that takes `obj` and returns the value, and list its name in `list_display`. Decorate it with `@admin.display(description="Items", ordering="_item_count")`. Sorting needs a database expression, so compute the value with `annotate()` in `get_queryset()` and point `ordering` at the annotation; the method then just returns `obj._item_count`. This also avoids a per-row query, which a method calling `obj.items.count()` would cause.

**Q: What are inlines and when would you use TabularInline vs StackedInline?**
A: Inlines let you edit related child objects (those with a ForeignKey to the parent) on the parent's change page; internally they are inline formsets. `TabularInline` renders each child as a table row — compact, good for many small records like order lines. `StackedInline` renders each child as a full fieldset — better for few, field-heavy children like a profile. Options include `extra`, `max_num`, `fk_name` (when there are several FKs to the parent) and `autocomplete_fields`.

**Q: How do you write a custom admin action?**
A: Define a function or ModelAdmin method taking `(modeladmin, request, queryset)` (or `self, request, queryset`), decorate it with `@admin.action(description="...", permissions=["change"])`, and add it to `actions`. The queryset is the selected rows filtered through your `get_queryset()`. Return `None` to redirect back to the list with any `message_user` notices, or return an `HttpResponse` for an intermediate confirmation page or a file download. Prefer `queryset.update()` for speed but remember it skips `save()` and signals.

**Q: Why might the admin list page cause an N+1 problem, and how do you fix it?**
A: Each row's `list_display` entries are evaluated in Python; any entry that follows a relation triggers a query per row unless it was loaded up front. Django auto-applies `select_related` only for FK fields named directly in `list_display`, not for callables like `obj.customer.email`. Fix with `list_select_related = ["customer"]` for to-one relations and `annotate()` in `get_queryset()` for counts or sums over to-many relations. Prove it with debug-toolbar or a test that asserts a constant query count as rows grow.

**Q: What is the difference between raw_id_fields and autocomplete_fields?**
A: Both replace the default `<select>` widget for ForeignKey and ManyToMany fields, which would otherwise load every row of the related table. `raw_id_fields` shows a plain text input for the primary key plus a lookup popup — zero queries for options, but not very friendly. `autocomplete_fields` uses an AJAX Select2-style widget that queries the related model's admin as you type; it requires that admin to define `search_fields`, and it respects that admin's permissions and `get_search_results`. Use either on any relation to a table with more than a few hundred rows.

**Q: How does admin permission checking work?**
A: To enter the admin at all, the user must be active and `is_staff` (checked by `AdminSite.has_permission`). Then, per model, the ModelAdmin's `has_view_permission`, `has_add_permission`, `has_change_permission` and `has_delete_permission` decide what they see and can do; by default these call `user.has_perm("app.change_model")` and friends, which come from the auto-created model permissions assigned to users or groups. Superusers pass all checks. The methods receive `obj`, so you can override them for object-level rules, and `get_queryset` can hide rows entirely.

**Q: Does the admin's "delete selected" call Model.delete()?**
A: No. The built-in `delete_selected` action calls `ModelAdmin.delete_queryset()`, which runs `queryset.delete()` — a bulk delete through the collector. Your overridden `Model.delete()` (say, a soft delete) is not called, though `pre_delete`/`post_delete` signals do fire per object unless the fast-delete path applies. Deleting a single object from its change page calls `delete_model()`, which does call `obj.delete()`. To make both paths consistent, override `delete_queryset` and `delete_model`, or remove the action.

**Q: The orders admin page takes 20 seconds on a table of 50 million rows. Walk me through diagnosing and fixing it. (Senior)**
A: First measure with debug-toolbar or `connection.queries` in staging against a production-sized copy, and `EXPLAIN ANALYZE` the slowest statements. Typical culprits are the paginator's `COUNT(*)` (PostgreSQL must scan all matching rows), the extra unfiltered count from `show_full_result_count`, ordering on an unindexed column, leading-wildcard `icontains` search across several columns, and N+1 list columns. Fixes: `show_full_result_count = False`, a paginator that uses the `pg_class.reltuples` estimate when unfiltered, an index matching `ordering`, exact (`=`) or prefix (`^`) search on identifiers plus trigram or full-text indexes for fuzzy fields, `list_select_related` and annotations. Also make the default view narrower — e.g. a default filter for the last 30 days — so most loads touch a small slice. Finally lock it with `assertNumQueries` tests.

**Q: How would you implement row-level (tenant) restrictions in the admin so staff of tenant A cannot see tenant B's data? (Senior)**
A: Override `get_queryset(request)` to filter by the user's tenant; every admin view — changelist, change, delete, actions, history — fetches objects through it, so cross-tenant URLs 404. Override `has_change_permission(request, obj)` and friends for finer rules. Restrict FK choices with `formfield_for_foreignkey` so a staff member cannot attach another tenant's object, and set the tenant in `save_model` rather than exposing it as a field. Autocomplete endpoints go through the related admin's `get_search_results`, so restrict those too. Add tests that hit each URL as a user of another tenant and expect 403/404.

**Q: When would you stop using the Django admin and build a custom internal tool instead? (Senior)**
A: When the screens become workflows rather than CRUD: multi-step approvals, state machines with guarded transitions, dashboards joining many models, or operations that need idempotency and background processing. Another signal is that most of your ModelAdmins override templates and `get_urls()` heavily — you are building a custom app inside a framework that fights you. Also when non-technical or external users need access, because the admin's permission model and UX are designed for trusted staff. A common middle path is to keep the admin for data inspection and fixes, and build purpose-built views or a small React + DRF tool for the high-traffic workflows.

**Q: How do you add a custom page (for example, a "refund" form) to the admin? (Senior)**
A: Override `get_urls()` on the ModelAdmin and prepend your own `path("<int:pk>/refund/", self.admin_site.admin_view(self.refund_view), name="shop_order_refund")`. Wrapping with `admin_view` enforces login, `is_staff`, CSRF protection and no-cache headers; inside the view you still check `has_change_permission(request, obj)`. Render with `TemplateResponse` and `self.admin_site.each_context(request)` so the admin chrome and sidebar work, and add a button by overriding `change_form.html` for that model. Do the refund in a service function inside `transaction.atomic()` and log it with `log_change` so it appears in history.

**Q: What does the admin's LogEntry record, and is it a sufficient audit log?**
A: Each add, change and delete performed through the admin writes a `LogEntry` row with the user, content type, object id, a string representation, the action flag and a change message listing which fields changed. It does not record old and new values, and changes made outside the admin — API, shell, `update()` calls, Celery jobs — are not logged at all. For compliance-grade auditing, use a model-history package (e.g. django-simple-history) or database-level auditing, and treat `LogEntry` as a convenience view.

## 10. Quick Revision & Cheat Sheet

| Need | Option / hook |
|---|---|
| Columns | `list_display` + `@admin.display(description, ordering, boolean)` |
| Avoid N+1 on list | `list_select_related`, `annotate()` in `get_queryset()` |
| Filters | `list_filter` (fields, `SimpleListFilter`, `RelatedOnlyFieldListFilter`) |
| Search | `search_fields` with `^` `=` `@`; override `get_search_results` |
| Big FK dropdown | `raw_id_fields` / `autocomplete_fields` (needs related `search_fields`) |
| Avoid extra COUNT | `show_full_result_count = False`, custom `paginator` |
| Child rows | `inlines = [TabularInline/StackedInline]` |
| Bulk ops | `actions` + `@admin.action(permissions=[...])` |
| Per-user restrictions | `get_queryset`, `has_*_permission`, `get_readonly_fields`, `formfield_for_foreignkey` |
| Admin-only save logic | `save_model`, `save_related`, `delete_model`, `delete_queryset` |
| Custom pages | `get_urls()` + `admin_site.admin_view()` |
| Reverse a URL | `admin:<app>_<model>_changelist` / `_change` |

- The admin is generated ModelForms + views + templates; nothing magic.
- ModelAdmin instances are shared — no per-request state on `self`.
- Auto `select_related` only covers FK fields named directly in `list_display`.
- Paginator `COUNT(*)` is the #1 cost on huge tables.
- `icontains` search = sequential scan without a trigram index.
- `delete_selected` → `queryset.delete()`; your `Model.delete()` is skipped.
- `update()` in actions skips `save()` and signals.
- Delete confirmation runs the cascade collector — can be enormous.
- Lock admin query counts with `assertNumQueries`.

## 11. Hands-On Exercises

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2" django-debug-toolbar
django-admin startproject adminlab . && python manage.py startapp shop
```

1. **Find the N+1.** Create `Customer`, `Order`, `OrderItem`; seed 5 000 orders with a management command. Add `list_display` methods for customer email and item count, open the changelist with debug-toolbar and count queries. Fix with `list_select_related` and `annotate`.
2. **Big dropdown.** Seed 50 000 customers and open an order's change page; note the response size. Switch to `autocomplete_fields` and compare.
3. **Search plan.** Seed a million orders (use `bulk_create`), search by email with default `icontains`, and run the generated SQL under `EXPLAIN ANALYZE`. Switch to `=customer__email` with an index and compare.
4. **Soft delete trap.** Give `Order` a `delete()` override that sets `deleted_at`. Delete via the bulk action and confirm the rows are really gone; fix by overriding `delete_queryset`.
5. **Tenant isolation.** Add a `tenant` FK, restrict `get_queryset` by `request.user.tenant`, and write tests that a user of tenant B gets 404 on tenant A's change URL and does not see A's customers in autocomplete.

**Mini project — "Support console":** a second `AdminSite` at `/support/` for a `support` group with read-only access to orders and customers, a custom "Resend receipt" action that enqueues a task via `on_commit`, a custom "Refund" page via `get_urls()`, an estimated-count paginator, and a query-count test for every changelist.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation) · [Ch 08 · Models & Fields](topic.html?p=08-models-fields) · [Ch 09 · Relationships](topic.html?p=09-relationships) · [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization) · [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres) · [Ch 26 · Permissions, Groups & Authorization](topic.html?p=26-permissions-authorization) · [Ch 28 · Security](topic.html?p=28-security) · [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks)

**Other handbooks:** [SQL · Indexes](../sql/topic.html?p=19-indexes) · [SQL · Query Optimization](../sql/topic.html?p=21-query-optimization) · [SQL · Execution Plans](../sql/topic.html?p=22-execution-plans)

- **The Django admin site** — Django docs · *Beginner → Intermediate* · the complete ModelAdmin reference: every option and hook in this chapter. <https://docs.djangoproject.com/en/5.2/ref/contrib/admin/>
- **Admin actions** — Django docs · *Intermediate* · writing actions, permissions and intermediate pages. <https://docs.djangoproject.com/en/5.2/ref/contrib/admin/actions/>
- **Tutorial part 7: Customizing the admin** — Django docs · *Beginner* · gentle introduction to list_display, filters and inlines. <https://docs.djangoproject.com/en/5.2/intro/tutorial07/>
- **django-debug-toolbar** — GitHub · *Beginner* · the fastest way to see admin SQL and duplicate queries. <https://github.com/django-commons/django-debug-toolbar>
- **django-simple-history** — GitHub · *Intermediate* · full field-level history when LogEntry is not enough. <https://github.com/jazzband/django-simple-history>
- **django-otp** — GitHub · *Intermediate* · two-factor authentication for admin logins. <https://github.com/django-otp/django-otp>

---

*Django Handbook — chapter 07.*
