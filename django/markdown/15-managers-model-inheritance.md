# 15 · Custom Managers, QuerySets & Model Inheritance

> **In one line:** A custom `QuerySet` is where reusable, chainable query logic belongs (`Order.objects.paid().for_user(u)`), a `Manager` is just the entry point that hands it out, and the three inheritance styles map to three very different schemas — abstract (no parent table, copy the columns), multi-table (a parent table plus a hidden one-to-one JOIN on every query) and proxy (same table, different Python behaviour).

---

## 1. Overview

> **Builds on:** [Ch 08 · Models & Fields](topic.html?p=08-models-fields) · [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) · [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization)

Two problems show up in every growing Django codebase.

**Problem one: query logic is copy-pasted.** "Paid orders from the last 30 days for this tenant, with items prefetched" appears in a view, a serializer, a Celery task and an admin action — each slightly different. One copy forgets the tenant filter and leaks data; another forgets `prefetch_related` and causes N+1. The naive fix is a helper function `get_recent_paid_orders(user)`, but helpers don't compose: you can't do `get_recent_paid_orders(user).filter(total__gt=100)` *and* reuse the "paid" rule elsewhere. The Django answer is a **custom QuerySet** with methods that each return a QuerySet, exposed through a **Manager**, so filters chain: `Order.objects.paid().recent(days=30).for_tenant(t)`.

**Problem two: models share structure.** Every table needs `created_at`/`updated_at`; `Restaurant` "is a" `Place`; `Staff` users are users that should appear separately in the admin. The naive approach is copy-paste fields (drift) or a big model with nullable columns and a `type` field (sparse, unvalidated). Django offers three inheritance styles, and choosing wrongly is expensive: multi-table inheritance adds a JOIN to every query and a second INSERT to every save, and it is very hard to undo once data exists.

> **Why this matters:** "What's the difference between abstract, multi-table and proxy inheritance?" is a standard Django interview question, as is "how would you implement soft delete?" — which is really a question about default managers, base managers and their leaks.

## 2. Core Concepts

- **Manager** — the interface (`models.Manager`) through which a model gets QuerySets; class attribute such as `objects`. *Why:* it's the only way to start a query; customising it customises every query entry point.
- **`get_queryset()`** — the Manager method returning the base QuerySet. *Why:* override it to change what "all rows" means (e.g. hide soft-deleted rows).
- **Custom QuerySet** — a `models.QuerySet` subclass with domain methods that return `self.filter(...)`. *Why:* methods chain in any order and work on related managers too.
- **`QuerySet.as_manager()`** / **`Manager.from_queryset(QS)`** — build a manager exposing the QuerySet's public methods. *Why:* one definition, available as both `Model.objects.paid()` and `qs.paid()`.
- **Default manager (`_default_manager`)** — the first manager defined on the model (or `Meta.default_manager_name`). *Why:* used by the admin, generic views, `dumpdata`, reverse related managers and `get_object_or_404(Model, …)`.
- **Base manager (`_base_manager`)** — plain `Manager` by default (or `Meta.base_manager_name`) used when Django must reach *all* rows: forward relation access (`order.customer`), `refresh_from_db`, saving. *Why:* filtering here can break `save()`/related lookups; not filtering here means soft-deleted rows are reachable via FKs.
- **`use_in_migrations = True`** — makes a manager available on historical models inside `RunPython`. *Why:* migrations otherwise get a plain manager.
- **Abstract base class** — `Meta.abstract = True`; no table; fields copied into each child. *Why:* DRY common columns with zero runtime cost.
- **Multi-table inheritance (MTI)** — a concrete parent with its own table; the child table has a `<parent>_ptr` `OneToOneField(parent_link=True, primary_key=True)`. *Why:* true "is-a" with a shared queryable parent table — at the price of JOINs.
- **Proxy model** — `Meta.proxy = True`; same table as the parent; different managers, methods, `Meta.ordering`, admin and permissions. *Why:* alternative Python behaviour over the same rows.
- **Polymorphic query** — fetching parent rows and getting the right child class back. *Why:* Django doesn't do it natively; MTI gives you `place.restaurant` access, not automatic downcasting (libraries like django-polymorphic add it).

## 3. Theory & Principles

### 3.1 How managers attach and how QuerySet methods get copied

When `ModelBase.__new__` builds a model class, every `Manager` instance in the class body goes through `contribute_to_class`, which sets `manager.model` and `manager.name` and registers it in `model._meta.local_managers`. Django wraps managers in a `ManagerDescriptor`, which is why `Order.objects` works but `order_instance.objects` raises `AttributeError: Manager isn't accessible via Order instances`. If a non-abstract model declares no manager, Django adds `objects = models.Manager()` automatically (`Options._prepare` / `ModelBase._prepare`).

`Manager` itself is `BaseManager.from_queryset(QuerySet)`. `from_queryset(qs_class)` creates a new Manager subclass and, via `_get_queryset_methods`, copies every public method of the QuerySet class onto it as a proxy that calls `self.get_queryset().<method>(...)`. Methods starting with an underscore are not copied; you can override with `method.queryset_only = True` (don't copy) or `False` (copy even if private). `QuerySet.as_manager()` is just `Manager.from_queryset(cls)()`.

Because every QuerySet method calls `_chain()` → `_clone()`, which constructs a new instance of `self.__class__`, a custom QuerySet class survives chaining: `Order.objects.filter(x=1).paid()` works because `filter` returns your `OrderQuerySet`.

### 3.2 Which manager Django uses where

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj15a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj15b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Soft-delete via the default manager: who sees deleted rows?</text>
  <rect x="330" y="44" width="220" height="110" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="66" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">class Product</text>
  <text x="344" y="88" fill="#1e293b" font-size="10">objects = AliveManager()  (first = default)</text>
  <text x="344" y="106" fill="#1e293b" font-size="10">    get_queryset: deleted_at IS NULL</text>
  <text x="344" y="124" fill="#1e293b" font-size="10">all_objects = models.Manager()</text>
  <text x="344" y="142" fill="#1e293b" font-size="10">_base_manager: plain Manager</text>
  <rect x="20" y="190" width="400" height="210" rx="10" fill="#dbeafe" stroke="#2563eb"/>
  <text x="220" y="212" text-anchor="middle" fill="#1e3a8a" font-size="12" font-weight="bold">_default_manager (filtered): deleted HIDDEN</text>
  <text x="36" y="236" fill="#1e293b" font-size="10">Product.objects.all() / .get(pk=...)</text>
  <text x="36" y="256" fill="#1e293b" font-size="10">category.products.all()  (reverse related manager is built</text>
  <text x="36" y="272" fill="#1e293b" font-size="10">     from the default manager&#8217;s class)</text>
  <text x="36" y="292" fill="#1e293b" font-size="10">Django admin changelist, ModelForm choice fields</text>
  <text x="36" y="312" fill="#1e293b" font-size="10">generic views / get_object_or_404(Product, ...)</text>
  <text x="36" y="332" fill="#1e293b" font-size="10">dumpdata (unless --all)</text>
  <text x="36" y="360" fill="#2563eb" font-size="10">Good: deleted products disappear from lists</text>
  <text x="36" y="378" fill="#2563eb" font-size="10">and pickers automatically.</text>
  <rect x="460" y="190" width="400" height="210" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="660" y="212" text-anchor="middle" fill="#78350f" font-size="12" font-weight="bold">_base_manager (unfiltered): deleted VISIBLE</text>
  <text x="476" y="236" fill="#1e293b" font-size="10">order_item.product   (forward FK descriptor)</text>
  <text x="476" y="256" fill="#1e293b" font-size="10">obj.refresh_from_db(), save() existence check</text>
  <text x="476" y="276" fill="#1e293b" font-size="10">Product.all_objects / Product._base_manager</text>
  <text x="476" y="296" fill="#1e293b" font-size="10">raw SQL, other services, analytics</text>
  <text x="476" y="324" fill="#d97706" font-size="10">Usually right: an old order must still show the</text>
  <text x="476" y="342" fill="#d97706" font-size="10">product it was for, even if that product is deleted.</text>
  <text x="476" y="366" fill="#dc2626" font-size="10">Wrong if you used a default manager for SECURITY</text>
  <text x="476" y="384" fill="#dc2626" font-size="10">(tenant isolation): FK access bypasses it.</text>
  <path d="M400,156 L260,188" stroke="#2563eb" stroke-width="2" marker-end="url(#dj15a)"/>
  <path d="M480,156 L620,188" stroke="#d97706" stroke-width="2" marker-end="url(#dj15b)"/>
</svg>
```

Rules worth memorising:

- The **first manager defined** (following inheritance from abstract parents) becomes `_default_manager`, unless `Meta.default_manager_name` says otherwise. Putting a filtering manager first changes what the admin and `dumpdata` see.
- **Forward relation access uses `_base_manager`**, which is unfiltered unless you set `Meta.base_manager_name` — and Django's docs warn the base manager must not filter out rows, because Django relies on it to find objects it already knows exist.
- **Reverse and many-to-many related managers** (`category.products`) are created by subclassing the related model's **default manager class**, so its `get_queryset()` filtering and custom methods apply: `category.products.paid()` works.

### 3.3 The three inheritance styles, as schemas

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Abstract vs multi-table vs proxy: tables and SQL</text>
  <rect x="16" y="40" width="276" height="390" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="154" y="62" text-anchor="middle" fill="#14532d" font-size="12" font-weight="bold">Abstract base class</text>
  <text x="28" y="84" fill="#1e293b" font-size="10">class Timestamped(Model): abstract</text>
  <text x="28" y="100" fill="#1e293b" font-size="10">class Post(Timestamped), class Comment(...)</text>
  <rect x="28" y="114" width="120" height="74" rx="5" fill="#fff" stroke="#16a34a"/>
  <text x="88" y="132" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">blog_post</text>
  <text x="38" y="150" fill="#1e293b" font-size="10">id, title</text>
  <text x="38" y="166" fill="#1e293b" font-size="10">created_at</text>
  <text x="38" y="182" fill="#1e293b" font-size="10">updated_at</text>
  <rect x="160" y="114" width="120" height="74" rx="5" fill="#fff" stroke="#16a34a"/>
  <text x="220" y="132" text-anchor="middle" fill="#14532d" font-size="10" font-weight="bold">blog_comment</text>
  <text x="170" y="150" fill="#1e293b" font-size="10">id, body</text>
  <text x="170" y="166" fill="#1e293b" font-size="10">created_at</text>
  <text x="170" y="182" fill="#1e293b" font-size="10">updated_at</text>
  <text x="28" y="212" fill="#1e293b" font-size="10">No Timestamped table exists.</text>
  <text x="28" y="230" fill="#1e293b" font-size="10">SELECT ... FROM blog_post</text>
  <text x="28" y="248" fill="#1e293b" font-size="10">(no join, no overhead)</text>
  <text x="28" y="276" fill="#16a34a" font-size="10">Cannot query "all Timestamped".</text>
  <text x="28" y="294" fill="#16a34a" font-size="10">Cannot FK to the abstract class.</text>
  <text x="28" y="312" fill="#16a34a" font-size="10">Meta (ordering etc.) inherited.</text>
  <text x="28" y="330" fill="#16a34a" font-size="10">related_name needs %(class)s.</text>
  <text x="28" y="370" fill="#14532d" font-size="11" font-weight="bold">Use: shared columns/methods</text>
  <text x="28" y="388" fill="#14532d" font-size="11" font-weight="bold">(the default choice)</text>
  <rect x="302" y="40" width="276" height="390" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="440" y="62" text-anchor="middle" fill="#7f1d1d" font-size="12" font-weight="bold">Multi-table inheritance</text>
  <text x="314" y="84" fill="#1e293b" font-size="10">class Place(Model)   (concrete)</text>
  <text x="314" y="100" fill="#1e293b" font-size="10">class Restaurant(Place)</text>
  <rect x="314" y="114" width="120" height="58" rx="5" fill="#fff" stroke="#dc2626"/>
  <text x="374" y="132" text-anchor="middle" fill="#7f1d1d" font-size="10" font-weight="bold">geo_place</text>
  <text x="324" y="150" fill="#1e293b" font-size="10">id, name</text>
  <text x="324" y="166" fill="#1e293b" font-size="10">address</text>
  <rect x="446" y="114" width="122" height="58" rx="5" fill="#fff" stroke="#dc2626"/>
  <text x="507" y="132" text-anchor="middle" fill="#7f1d1d" font-size="10" font-weight="bold">geo_restaurant</text>
  <text x="454" y="150" fill="#1e293b" font-size="10">place_ptr_id (PK,FK)</text>
  <text x="454" y="166" fill="#1e293b" font-size="10">serves_pizza</text>
  <path d="M446,150 L436,150" stroke="#dc2626" stroke-width="2"/>
  <text x="314" y="196" fill="#1e293b" font-size="10">Restaurant.objects.all():</text>
  <text x="314" y="212" fill="#1e293b" font-size="10">SELECT ... FROM geo_restaurant</text>
  <text x="314" y="228" fill="#1e293b" font-size="10">INNER JOIN geo_place ON place_ptr_id = id</text>
  <text x="314" y="248" fill="#1e293b" font-size="10">save(): INSERT place, then INSERT restaurant</text>
  <text x="314" y="276" fill="#dc2626" font-size="10">JOIN on every query, 2 writes per save,</text>
  <text x="314" y="294" fill="#dc2626" font-size="10">no bulk_create, Place.objects returns Place</text>
  <text x="314" y="312" fill="#dc2626" font-size="10">(downcast via place.restaurant = 1 query)</text>
  <text x="314" y="330" fill="#dc2626" font-size="10">deep chains = many joins</text>
  <text x="314" y="370" fill="#7f1d1d" font-size="11" font-weight="bold">Use: rarely; prefer explicit</text>
  <text x="314" y="388" fill="#7f1d1d" font-size="11" font-weight="bold">OneToOneField composition</text>
  <rect x="588" y="40" width="276" height="390" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="726" y="62" text-anchor="middle" fill="#4c1d95" font-size="12" font-weight="bold">Proxy model</text>
  <text x="600" y="84" fill="#1e293b" font-size="10">class Order(Model)</text>
  <text x="600" y="100" fill="#1e293b" font-size="10">class RefundedOrder(Order): proxy=True</text>
  <rect x="600" y="114" width="252" height="58" rx="5" fill="#fff" stroke="#7c3aed"/>
  <text x="726" y="132" text-anchor="middle" fill="#4c1d95" font-size="10" font-weight="bold">shop_order  (one table)</text>
  <text x="610" y="150" fill="#1e293b" font-size="10">id, status, total, ...</text>
  <text x="610" y="166" fill="#1e293b" font-size="10">both classes read/write these rows</text>
  <text x="600" y="196" fill="#1e293b" font-size="10">RefundedOrder.objects (custom manager):</text>
  <text x="600" y="212" fill="#1e293b" font-size="10">SELECT ... FROM shop_order</text>
  <text x="600" y="228" fill="#1e293b" font-size="10">WHERE status = 'refunded'</text>
  <text x="600" y="276" fill="#7c3aed" font-size="10">Can change: managers, methods, ordering,</text>
  <text x="600" y="294" fill="#7c3aed" font-size="10">admin registration, permissions.</text>
  <text x="600" y="312" fill="#7c3aed" font-size="10">Cannot add fields. Migration has no SQL.</text>
  <text x="600" y="330" fill="#7c3aed" font-size="10">Filtering is NOT automatic: write a manager.</text>
  <text x="600" y="370" fill="#4c1d95" font-size="11" font-weight="bold">Use: alternative behaviour /</text>
  <text x="600" y="388" fill="#4c1d95" font-size="11" font-weight="bold">admin views of the same data</text>
</svg>
```

Internals worth knowing for MTI: `ModelBase` detects a concrete parent and auto-creates `place_ptr = OneToOneField(Place, parent_link=True, primary_key=True, on_delete=CASCADE, auto_created=True)`. Child field access to parent fields is resolved via `_meta.parents`, and the compiler adds the JOIN through the parent link. On `save()`, `Model.save_base` calls `_save_parents()` first (INSERT/UPDATE on `geo_place`) then `_save_table()` for the child. Deleting a `Restaurant` deletes the `Place` row too (the collector follows parent links). Of the parent's `Meta`, only `ordering` and `get_latest_by` are inherited by an MTI child.

## 4. Architecture & Workflow

### 4.1 Layering query logic

```text
                 views / serializers / tasks / admin
                               |
         Order.objects.for_tenant(t).paid().recent(30).with_totals()
                               |
   +---------------------------v----------------------------+
   | OrderManager = Manager.from_queryset(OrderQuerySet)     |
   |   get_queryset(): base rules (e.g. hide soft-deleted)   |
   |   create_from_cart(cart): write-side helper (manager-   |
   |     only, not chainable)                                 |
   +---------------------------+----------------------------+
                               |
   +---------------------------v----------------------------+
   | OrderQuerySet(models.QuerySet)                          |
   |   paid()        -> self.filter(status="paid")           |
   |   recent(days)  -> self.filter(created_at__gte=...)     |
   |   for_tenant(t) -> self.filter(tenant=t)                |
   |   with_totals() -> self.annotate(...)  [Ch 12]          |
   |   for_list_api()-> self.select_related(...).prefetch(.) |
   +---------------------------+----------------------------+
                               |
                      sql.Query -> SQLCompiler -> SQL
```

Put **read rules** that should compose on the QuerySet; put **table-level operations** that don't make sense mid-chain (create helpers, complex constructors) on the Manager; keep **row behaviour** (`order.mark_paid()`) on the model. Keep **multi-model business transactions** in a service function ([Ch 14](topic.html?p=14-transactions-concurrency)).

### 4.2 Picking an inheritance strategy

```text
Do the models just share columns/behaviour, never queried together?   -> abstract base class
Same rows, different Python behaviour/admin/default filter?           -> proxy model
Need one table to query/FK "any Place" AND per-type extra columns?
    few types, few extra columns            -> single table + type field + nullable cols + CheckConstraints
    many type-specific columns              -> explicit OneToOneField "profile" tables (composition)
    you accept JOINs and want Django's sugar -> multi-table inheritance
Truly heterogeneous, open-ended attributes                            -> JSONField [Ch 16]
```

## 5. Implementation

### 5.1 Simple example: a chainable QuerySet

```python
# shop/models.py
from datetime import timedelta
from django.conf import settings
from django.db import models
from django.db.models import Count, F, Sum, DecimalField
from django.utils import timezone

class OrderQuerySet(models.QuerySet):
    def paid(self):
        return self.filter(status=Order.Status.PAID)

    def recent(self, days=30):
        return self.filter(created_at__gte=timezone.now() - timedelta(days=days))

    def for_user(self, user):
        return self.filter(customer=user)

    def with_totals(self):
        return self.annotate(
            item_count=Count("items"),
            computed_total=Sum(F("items__quantity") * F("items__unit_price"),
                               output_field=DecimalField(max_digits=12, decimal_places=2)),
        )

class Order(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending"; PAID = "paid"; REFUNDED = "refunded"

    customer = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="orders")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    created_at = models.DateTimeField(auto_now_add=True)

    objects = OrderQuerySet.as_manager()
```

```python
Order.objects.paid().recent(7).for_user(u).with_totals().order_by("-created_at")
Order.objects.filter(customer__is_active=True).paid()   # custom methods survive filter()
request.user.orders.paid()                           # works on the reverse related manager
```

```sql
SELECT "shop_order"."id", "shop_order"."customer_id", "shop_order"."status", "shop_order"."created_at",
       COUNT("shop_orderitem"."id") AS "item_count",
       SUM(("shop_orderitem"."quantity" * "shop_orderitem"."unit_price")) AS "computed_total"
FROM "shop_order"
LEFT OUTER JOIN "shop_orderitem" ON ("shop_order"."id" = "shop_orderitem"."order_id")
WHERE ("shop_order"."status" = 'paid'
       AND "shop_order"."created_at" >= '2026-10-18T10:00:00+00:00'::timestamptz
       AND "shop_order"."customer_id" = 7)
GROUP BY "shop_order"."id"
ORDER BY "shop_order"."created_at" DESC;
```

### 5.2 Manager with extra methods: `from_queryset`

```python
class OrderManager(models.Manager.from_queryset(OrderQuerySet)):
    def create_from_cart(self, cart):
        order = self.create(customer=cart.user)
        OrderItem.objects.bulk_create(
            [OrderItem(order=order, product_id=l.product_id, quantity=l.qty, unit_price=l.price)
             for l in cart.lines]
        )
        return order

class Order(models.Model):
    ...
    objects = OrderManager()
```

`Order.objects.create_from_cart(cart)` exists; `Order.objects.paid().create_from_cart(cart)` doesn't — which is the point: creation isn't a filter.

### 5.3 Real-world example: soft delete done properly

```python
# core/models.py
from django.db import models
from django.utils import timezone

class SoftDeleteQuerySet(models.QuerySet):
    def delete(self):                                   # bulk "delete" = mark
        return super().update(deleted_at=timezone.now())

    def hard_delete(self):
        return super().delete()

    def alive(self):
        return self.filter(deleted_at__isnull=True)

    def dead(self):
        return self.filter(deleted_at__isnull=False)

class AliveManager(models.Manager.from_queryset(SoftDeleteQuerySet)):
    def get_queryset(self):
        return super().get_queryset().filter(deleted_at__isnull=True)

class SoftDeleteModel(models.Model):
    deleted_at = models.DateTimeField(null=True, blank=True, db_index=True)

    objects = AliveManager()                            # first => default manager
    all_objects = SoftDeleteQuerySet.as_manager()       # escape hatch

    class Meta:
        abstract = True

    def delete(self, using=None, keep_parents=False):   # instance "delete" = mark
        self.deleted_at = timezone.now()
        self.save(update_fields=["deleted_at"])

    def restore(self):
        self.deleted_at = None
        self.save(update_fields=["deleted_at"])
```

```python
# catalog/models.py
from django.db import models
from django.db.models import Q
from core.models import SoftDeleteModel

class Product(SoftDeleteModel):
    sku = models.CharField(max_length=40)
    name = models.CharField(max_length=200)
    category = models.ForeignKey("Category", on_delete=models.PROTECT, related_name="products")

    class Meta(SoftDeleteModel.Meta):                   # inherit abstract Meta explicitly
        constraints = [
            # SKU unique among live rows only: a deleted SKU can be reused
            models.UniqueConstraint(fields=["sku"], condition=Q(deleted_at__isnull=True),
                                    name="product_sku_unique_alive"),
        ]
```

```text
>>> p = Product.objects.get(sku="A1"); p.delete()
UPDATE "catalog_product" SET "deleted_at" = '2026-10-25 09:12:00+00:00' WHERE "catalog_product"."id" = 5
>>> Product.objects.filter(sku="A1").exists()
False                                 # SELECT ... WHERE deleted_at IS NULL AND sku = 'A1'
>>> Product.all_objects.filter(sku="A1").exists()
True
>>> category.products.count()         # reverse manager uses AliveManager's class -> deleted excluded
>>> order_item.product                # forward FK uses _base_manager -> deleted product still returned
```

Decisions this design makes explicitly:

- **Instance and QuerySet `delete()` are both overridden.** Overriding only `Model.delete()` misses `Product.objects.filter(...).delete()` and admin bulk deletes, which go through the QuerySet.
- **Cascades are not soft.** Real `on_delete=CASCADE` is only triggered by real deletes; soft-deleting a category doesn't soft-delete its products. If you need it, implement it in the service layer (or use a library such as django-safedelete, which models policies).
- **The unique constraint is partial**, otherwise a deleted row blocks reuse of its SKU.
- **Forward FK access still returns deleted rows** — the right behaviour for history (old orders), but templates should show "(deleted)".
- **Not a security boundary.** Raw SQL, `_base_manager`, `all_objects`, `dumpdata --all` and other services see everything.

### 5.4 Abstract base with relations

```python
class Auditable(models.Model):
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL, null=True, on_delete=models.SET_NULL,
        related_name="%(app_label)s_%(class)s_created",       # unique per concrete child
    )

    class Meta:
        abstract = True
        ordering = ["-created_at"]
```

Without the `%(app_label)s_%(class)s` placeholders, two children would both try to create `user.created` reverse accessors and `makemigrations` fails with a clash (fields.E304).

### 5.5 Multi-table inheritance and its SQL

```python
class Place(models.Model):
    name = models.CharField(max_length=100)
    address = models.CharField(max_length=200)

class Restaurant(Place):
    serves_pizza = models.BooleanField(default=False)
```

```python
Restaurant.objects.filter(name__startswith="Bella")
```

```sql
SELECT "geo_place"."id", "geo_place"."name", "geo_place"."address",
       "geo_restaurant"."place_ptr_id", "geo_restaurant"."serves_pizza"
FROM "geo_restaurant"
INNER JOIN "geo_place" ON ("geo_restaurant"."place_ptr_id" = "geo_place"."id")
WHERE "geo_place"."name"::text LIKE 'Bella%';
```

```python
r = Restaurant.objects.create(name="Bella", address="1 Main St", serves_pizza=True)
```

```sql
INSERT INTO "geo_place" ("name", "address") VALUES ('Bella', '1 Main St') RETURNING "geo_place"."id";
INSERT INTO "geo_restaurant" ("place_ptr_id", "serves_pizza") VALUES (1, true);
```

Downcasting from the parent:

```python
for place in Place.objects.select_related("restaurant"):      # reverse O2O can be select_related
    kind = "restaurant" if hasattr(place, "restaurant") else "place"
```

Without `select_related("restaurant")`, each `place.restaurant` is a query (and raises `Restaurant.DoesNotExist` for plain places — `hasattr` catches it because `RelatedObjectDoesNotExist` subclasses `AttributeError`).

The same structure with explicit composition (often preferred — you see the JOIN, and you can make the relation optional or move it later):

```python
class Restaurant(models.Model):
    place = models.OneToOneField(Place, on_delete=models.CASCADE, primary_key=True, related_name="restaurant")
    serves_pizza = models.BooleanField(default=False)
```

### 5.6 Proxy models: a separate admin over the same table

```python
class RefundedOrderManager(models.Manager):
    def get_queryset(self):
        return super().get_queryset().filter(status=Order.Status.REFUNDED)

class RefundedOrder(Order):
    objects = RefundedOrderManager()

    class Meta:
        proxy = True
        ordering = ["-created_at"]
        verbose_name = "refunded order"

    def refund_age_days(self):
        return (timezone.now() - self.created_at).days
```

```python
# shop/admin.py
@admin.register(RefundedOrder)
class RefundedOrderAdmin(admin.ModelAdmin):
    list_display = ["id", "customer", "created_at"]
    def has_add_permission(self, request): return False
```

The proxy's migration is `CreateModel(..., options={"proxy": True}, bases=("shop.order",))` with no SQL. Since Django 2.2, a proxy model's permissions (`shop.view_refundedorder`) use the proxy's own content type, so you can grant support staff access to refunds without granting access to all orders. Note `Order.objects.get(pk=x)` returns an `Order`, not a `RefundedOrder` — proxies don't auto-cast.

## 6. Advantages, Disadvantages & Trade-offs

| Technique | Schema effect | Query cost | Strengths | Weaknesses |
|---|---|---|---|---|
| Custom QuerySet (`as_manager`) | none | none | Chainable, works on related managers, testable | Methods must return QuerySets |
| Manager `get_queryset` filter | none | WHERE on every query | Global default (soft delete, active only) | Surprises: admin, dumpdata, base manager leaks |
| Abstract base | columns copied per child | none | DRY, zero overhead | No polymorphic queries, no FK to base |
| Multi-table | parent + child tables, 1:1 PK | JOIN per query, 2 writes per save | Query/FK the parent; "is-a" | Joins, no `bulk_create`, hard to refactor, no auto-downcast |
| Proxy | none | none (+ manager filter) | Separate admin/permissions/behaviour | Can't add fields; no auto-casting |
| Explicit OneToOne composition | same as MTI | explicit JOIN | Visible, flexible, optional | Slightly more code |
| Single table + type field | one wide table | none | Simple polymorphism | Nullable columns; enforce with CheckConstraints |

### When to use

- Custom QuerySets for any filter used in more than one place — especially tenant scoping and list-API optimisation (`for_list_api()` with the select/prefetch from [Ch 13](topic.html?p=13-queryset-optimization)).
- Abstract bases for timestamps, audit fields, UUID primary keys, soft-delete columns.
- Proxies for alternative admin screens, role-specific permissions, or state-specific behaviour.
- MTI only when you genuinely need to query and reference the parent across types and the JOIN is acceptable.

### When NOT to use

- Don't put security-critical filtering (tenant isolation) *only* in a default manager; enforce it in querysets used by views plus database-level controls (row-level security, separate schemas) — see [Database Design · Case: Multi-Tenant SaaS](../database-design/topic.html?p=40-case-multi-tenant-saas).
- Don't use MTI for deep hierarchies (three levels = three tables joined on every query).
- Don't filter in a manager that will be the base manager.
- Don't use a filtering default manager on a model where the admin must show all rows — add an unfiltered manager first, or set `default_manager_name`.

## 7. Common Mistakes & Best Practices

**1. Manager methods that return lists.**

```python
# Before: not chainable, evaluates immediately
class OrderManager(models.Manager):
    def paid(self):
        return list(self.filter(status="paid"))

# After: a QuerySet method — lazy and chainable
class OrderQuerySet(models.QuerySet):
    def paid(self):
        return self.filter(status="paid")
```

**2. Putting the filtering manager first by accident.** `objects = PublishedManager()` defined before `all_objects = Manager()` makes the admin hide drafts. Decide deliberately; use `Meta.default_manager_name = "all_objects"` if the admin must see everything.

**3. Overriding only `Model.delete()` for soft delete.** QuerySet deletes bypass it (admin "delete selected" calls `queryset.delete()`). Override both, or block bulk delete.

**4. Expecting `Place.objects.all()` to return `Restaurant` instances.** MTI doesn't downcast. Use `select_related("restaurant")` and check, or a polymorphic library, or redesign.

**5. Forgetting `Meta` inheritance rules.** An abstract child that defines its own `class Meta:` *replaces* the parent's Meta unless it subclasses it (`class Meta(Base.Meta):`) — you lose `ordering`, `indexes`, etc. MTI children inherit only `ordering` and `get_latest_by`.

**6. `related_name` clashes in abstract bases.** Use `%(app_label)s_%(class)s`.

**7. Custom manager methods unavailable in migrations.** Historical models get plain managers unless `use_in_migrations = True` — and even then, avoid importing code that will change; inline logic in `RunPython` ([Ch 11](topic.html?p=11-migrations)).

**8. Changing inheritance later.** Converting MTI to abstract (or vice versa) means moving data between tables and rewriting FKs — a multi-step migration. Choose early; when unsure, start with abstract + explicit OneToOne.

**Best practices:** one QuerySet class per model with domain verbs; test QuerySet methods directly (`Order.objects.paid()` with fixtures, plus `assertNumQueries`); name escape-hatch managers explicitly (`all_objects`, `with_deleted`); document which manager is default.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: deleted rows reappearing.** *Symptom:* customers see a "deleted" address on old invoices *and* in a dropdown. *Root cause:* the dropdown used `ModelChoiceField(queryset=Address._base_manager.all())` copied from somewhere, and an FK access in the template. *Fix:* use the default manager for pickers; label deleted rows in history views.

**Pitfall: tenant leak via forward FK.** A multi-tenant app relied on `TenantManager` reading a thread-local tenant. `invoice.customer` uses the base manager, so a crafted invoice ID from another tenant (fetched via an unscoped `get`) exposed a customer. *Fix:* scope every view queryset explicitly (`Invoice.objects.for_tenant(request.tenant)`), add `tenant_id` to every unique constraint and FK checks, and consider PostgreSQL row-level security.

**Pitfall: MTI join explosion.** A `Content` → `Article` → `SponsoredArticle` hierarchy made every list query join three tables; an index on the leaf couldn't help filters on the root. *Symptom:* `explain()` shows nested loops over all three. *Fix:* flatten to abstract base + a type column, migrating data in an expand/contract sequence ([Ch 11](topic.html?p=11-migrations)).

**Pitfall: `bulk_create` on MTI children.** Raises `ValueError: Can't bulk create a multi-table inherited model`. Imports have to create parents first (`bulk_create` parents, then children with `place_ptr_id`), which is fiddly — another reason to prefer composition.

**Pitfall: soft-deleted rows bloating indexes.** Years of soft-deleted rows make every query filter them out. *Fix:* partial indexes `WHERE deleted_at IS NULL` (`models.Index(fields=[...], condition=Q(deleted_at__isnull=True), name=...)`), and archive/purge old dead rows ([Database Design · Data Lifecycle](../database-design/topic.html?p=28-data-lifecycle)).

**Debugging:**

```python
Product._default_manager, Product._base_manager            # which managers?
[m.name for m in Product._meta.managers]                   # declaration order
Restaurant._meta.parents                                    # {Place: <OneToOneField place_ptr>}
Restaurant._meta.get_parent_list()
print(Restaurant.objects.all().query)                       # see the JOIN
```

**Scaling notes:** custom QuerySets are the natural home for performance rules (always `select_related` the tenant, always `only()` list columns), so a fix lands everywhere at once. For heavy polymorphic reads, consider a denormalised "feed" table maintained on write rather than MTI joins.

## 9. Interview Questions

**Q: What is a Manager in Django, and how is it different from a QuerySet?**
A: A Manager is the class attribute (`objects` by default) through which a model starts queries; it's accessible on the class but not on instances. A QuerySet is the lazy, chainable query object a Manager hands out via `get_queryset()`. Practically, filtering logic belongs on a custom QuerySet so it chains (`Order.objects.paid().recent()`), while the Manager is the entry point and the place for table-level helpers that don't make sense mid-chain. `QuerySet.as_manager()` or `Manager.from_queryset()` connect the two so you write the methods once.

**Q: Why put custom methods on a QuerySet rather than a Manager?**
A: Manager methods only exist on the manager, so `Order.objects.paid()` works but `Order.objects.filter(x=1).paid()` doesn't. QuerySet methods are available at any point in a chain, because every QuerySet method clones into the same QuerySet class, and they're also available on related managers like `user.orders.paid()`. With `as_manager()` they're also exposed on the manager. So composable read logic goes on the QuerySet.

**Q: What is the difference between the default manager and the base manager?**
A: The default manager (`_default_manager`) is the first manager defined, or the one named in `Meta.default_manager_name`; Django uses it for the admin, generic views, `dumpdata`, and as the basis of reverse related managers. The base manager (`_base_manager`) is a plain unfiltered `Manager` unless `Meta.base_manager_name` is set, and Django uses it when it must reach any row — forward FK/one-to-one access, `refresh_from_db()`, and saving. Django's docs say a base manager shouldn't filter rows. This distinction is why a soft-delete default manager doesn't hide deleted objects accessed via a ForeignKey.

**Q: What are the three types of model inheritance in Django?**
A: Abstract base classes (`Meta.abstract = True`) create no table; their fields and Meta are copied into each child, so there's no runtime cost but you can't query or FK the base. Multi-table inheritance subclasses a concrete model: the parent keeps its table, the child gets its own table with a `parent_ptr` one-to-one primary key, and queries on the child JOIN the parent. Proxy models (`Meta.proxy = True`) use the parent's table unchanged and can only change Python behaviour — managers, methods, ordering, admin and permissions — not fields.

**Q: What are the downsides of multi-table inheritance?**
A: Every query on the child joins the parent table, and every save writes two rows, which adds latency and complicates indexing because filters may span both tables. Querying the parent returns parent instances, not children, so you need extra queries or `select_related("child")` to downcast. `bulk_create` isn't supported for MTI children. Refactoring away from MTI later requires data migrations across tables. Many teams prefer an explicit `OneToOneField` (composition) or an abstract base instead.

**Q: When would you use a proxy model?**
A: When you want different Python behaviour over the same rows: a separate admin section (e.g. "Refunded orders" with its own list display and permissions), a different default ordering, a manager with a default filter, or extra methods for a particular state. Proxy models get their own content type, so permissions can be granted per proxy. They can't add fields, and the parent's manager won't return proxy instances, so the filtering must be in the proxy's own manager.

**Q: How would you implement soft delete in Django?**
A: Add a nullable `deleted_at` on an abstract base, override `Model.delete()` to set it, and use a custom QuerySet whose `delete()` does `update(deleted_at=now())` so bulk and admin deletes are covered too. Make the default manager filter `deleted_at IS NULL` and add an unfiltered `all_objects` manager. Use partial unique constraints and partial indexes on live rows only. Be aware that forward FK access uses the base manager, so deleted objects remain reachable from history, that cascades don't happen automatically, and that raw SQL and other services see everything.

**Q: What does `use_in_migrations` do on a manager?**
A: It makes the manager available on historical models inside data migrations. By default, `apps.get_model()` models in `RunPython` get only a plain manager, so custom methods aren't there. Setting `use_in_migrations = True` serializes the manager into migration state so it can be used. The caveat is that the migration then depends on importable manager code, which can change over time, so many teams avoid it and write migration logic inline.

**Q: Why do abstract models often need `related_name="%(app_label)s_%(class)s_..."`?**
A: Because the fields of an abstract base are copied into every concrete child, a ForeignKey with a fixed `related_name` would create the same reverse accessor name on the target model from each child, which is a clash that system checks reject. The placeholders are substituted per child with its app label and lowercased class name, giving unique accessors like `blog_post_created` and `blog_comment_created`.

**Q: A colleague used a thread-local "current tenant" in a default manager for multi-tenancy. What are the risks? (Senior)**
A: The default manager isn't used everywhere: forward FK access and `refresh_from_db` use the base manager, raw SQL and `_base_manager` bypass it, and Celery tasks, management commands and async contexts may have no tenant set — returning everything or nothing silently. Thread-locals also behave unexpectedly under async views and in thread pools. I'd make tenant scoping explicit in view querysets (`for_tenant(request.tenant)`), include `tenant_id` in unique constraints and composite FKs, add tests that cross-tenant IDs return 404, and consider PostgreSQL row-level security or schema-per-tenant for defence in depth. The manager can still help as a convenience, but not as the only boundary.

**Q: You inherited a three-level multi-table hierarchy that's slow. How would you migrate away from it without downtime? (Senior)**
A: First decide the target — usually one table with an abstract base and a type column, or composition with explicit OneToOne tables for rare, wide subtypes. Then expand: create the new table, dual-write from the application (or a trigger) on every save, backfill existing rows in batches by joining the old tables. Switch reads endpoint by endpoint behind a flag, comparing results. Repoint ForeignKeys from other models to the new table with the same expand/backfill/switch pattern. Finally contract: stop writing the old tables and drop them in a later release. Primary keys can stay the same since MTI children share the parent's pk, which simplifies the FK move.

**Q: How do custom QuerySets help prevent N+1 and data leaks across a large team? (Senior)**
A: They give one named place for the rules: `Order.objects.for_tenant(t).for_list_api()` encapsulates the tenant filter plus the `select_related`/`Prefetch`/`only` that the list serializer needs, so every view, task and export gets the same optimised, correctly scoped query. Tests can target these methods with `assertNumQueries` and cross-tenant fixtures. When the serializer changes, the QuerySet method changes with it in the same PR. It also makes code review easier — a raw `Order.objects.filter(...)` in a view becomes a visible smell.

**Q: What happens when you call `save()` on a multi-table child?**
A: `save_base` first saves the parents — `_save_parents` inserts or updates the parent table row — and then saves the child table row with the parent's primary key as its own `parent_ptr_id`. So creating a child is two INSERTs, wrapped in a transaction by Django to keep them consistent. Updating a child updates both tables only for fields that belong to each. Deleting a child deletes the parent row too, because the collector follows the parent link.

## 10. Quick Revision & Cheat Sheet

| Concept | Key fact |
|---|---|
| `objects` | Auto-added if no manager declared |
| Default manager | First declared or `Meta.default_manager_name`; admin, dumpdata, reverse managers |
| Base manager | Plain unless `Meta.base_manager_name`; forward FK, refresh, save |
| `QuerySet.as_manager()` | Manager exposing QuerySet's public methods |
| `Manager.from_queryset(QS)` | Same, plus your own manager methods |
| `use_in_migrations` | Manager available in `RunPython` historical models |
| Abstract | No table; fields copied; Meta inherited (subclass `Base.Meta` to extend) |
| Multi-table | Parent + child table, `parent_ptr` O2O PK; JOIN per query; 2 writes per save |
| Proxy | Same table; managers/methods/ordering/admin/perms; no new fields |
| MTI Meta | Only `ordering`, `get_latest_by` inherited |
| Downcast | `place.restaurant` (query) or `select_related("restaurant")` |

- Read logic → QuerySet; table helpers → Manager; row behaviour → model; transactions → service.
- QuerySet methods return QuerySets, never lists.
- Soft delete: override both instance and QuerySet `delete()`; partial unique constraints.
- Forward FK access bypasses default-manager filtering.
- Default managers are not a security boundary.
- Prefer abstract bases and explicit OneToOne over MTI.
- Proxies don't auto-cast; give them their own filtering manager.
- `related_name="%(app_label)s_%(class)s_..."` in abstract bases.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" "psycopg[binary]"`, `startproject lab`, apps `shop`, `geo`, `core`.

1. Build `OrderQuerySet` with `paid()`, `recent()`, `for_user()`, `with_totals()`; prove chaining in any order and on `user.orders`. Print SQL.
2. Implement the soft-delete base from §5.3. Write tests: instance delete, queryset delete, admin "delete selected", reverse manager hides, forward FK still returns, partial unique allows SKU reuse.
3. Swap the order of `objects` and `all_objects`; observe the admin; then fix with `default_manager_name`.
4. Create `Place`/`Restaurant` MTI; log SQL for create, filter, update and delete; then rewrite as explicit OneToOne and compare.
5. Add a `RefundedOrder` proxy with its own admin and grant a test user only `shop.view_refundedorder`; verify they can't see the main Order admin.
6. Try `Restaurant.objects.bulk_create([...])` and read the error; write the two-step workaround.

**Mini project:** a multi-tenant notes app where `Note`, `Notebook` and `Tag` share an abstract `TenantScoped` base (tenant FK, timestamps, soft delete), each with a QuerySet providing `for_tenant()` and `for_list_api()`. Write cross-tenant tests that try to access another tenant's objects via list views, detail views and FK traversal, and fix every leak you find.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 08 · Models & Fields](topic.html?p=08-models-fields), [Ch 09 · Relationships](topic.html?p=09-relationships) (OneToOne composition), [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups), [Ch 11 · Migrations](topic.html?p=11-migrations) (`use_in_migrations`, refactoring inheritance), [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization), [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency), [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres) (partial unique constraints), [Ch 07 · The Django Admin](topic.html?p=07-django-admin), [Ch 26 · Permissions, Groups & Authorization](topic.html?p=26-permissions-authorization), [Ch 36 · Django Internals](topic.html?p=36-django-internals).

**Other handbooks:** [SQL · Schema Design](../sql/topic.html?p=30-schema-design), [SQL · Keys & Constraints](../sql/topic.html?p=29-keys-constraints), [Database Design · Data Lifecycle](../database-design/topic.html?p=28-data-lifecycle), [Database Design · Advanced Database Patterns](../database-design/topic.html?p=29-advanced-database-patterns), [Database Design · Case: Multi-Tenant SaaS](../database-design/topic.html?p=40-case-multi-tenant-saas).

- **Managers** — Django docs · *Intermediate* · custom managers, `from_queryset`, default vs base managers and their rules. <https://docs.djangoproject.com/en/5.2/topics/db/managers/>
- **Models: model inheritance** — Django docs · *Beginner* · abstract, multi-table and proxy inheritance with Meta rules. <https://docs.djangoproject.com/en/5.2/topics/db/models/>
- **Model Meta options** — Django docs · *Intermediate* · `abstract`, `proxy`, `default_manager_name`, `base_manager_name`, constraints. <https://docs.djangoproject.com/en/5.2/ref/models/options/>
- **django-polymorphic** — GitHub · *Intermediate* · automatic downcasting for multi-table hierarchies, and a good read on why it's needed. <https://github.com/django-polymorphic/django-polymorphic>
- **django-safedelete** — GitHub · *Intermediate* · soft-delete policies including cascades, as a reference design. <https://github.com/makinacorpus/django-safedelete>
- **PostgreSQL: Row Security Policies** — PostgreSQL docs · *Advanced* · database-enforced tenant isolation beyond managers. <https://www.postgresql.org/docs/current/ddl-rowsecurity.html>

---

*Django Handbook — chapter 15.*
