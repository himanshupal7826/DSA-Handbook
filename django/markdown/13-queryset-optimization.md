# 13 · QuerySet Optimization & the N+1 Problem

> **In one line:** Most slow Django pages are not slow queries but *too many* queries — one per row, hidden behind attribute access — so optimization means counting queries first, then choosing the right tool: `select_related` (JOIN) for single-valued relations, `prefetch_related` (a second `IN` query) for multi-valued ones, `only`/`values` to fetch less, `bulk_*`/`update()` to write in sets, and `iterator()` to stream.

---

## 1. Overview

> **Builds on:** [Ch 09 · Relationships](topic.html?p=09-relationships) · [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) · [Ch 12 · Aggregation, Annotation, Subqueries](topic.html?p=12-aggregation-annotation-subqueries)

The ORM makes related data feel like ordinary Python attributes: `order.customer.email`, `book.authors.all()`. That convenience has a price. Each attribute access on a relation that hasn't been loaded triggers a **lazy query**. In a template looping over 100 orders and printing the customer's name, you run 1 query for the orders and then 100 more for the customers — the **N+1 problem**. Nothing in the code looks like a query. Locally, with 10 rows and a database on localhost, it takes 15 ms and nobody notices. In production, with 500 rows per page and 1 ms network latency per round trip, it's half a second of pure latency — before any query is actually slow.

The naive fixes fail in their own ways. Caching the page hides the problem until the cache misses. Adding indexes doesn't help: each of the 100 queries is already a primary-key lookup. Writing raw SQL with joins works but throws away the ORM. The real fix is to tell the ORM, up front, which relations you will touch, so it can fetch them in **one JOIN** or **one extra query per relation** instead of one per row.

The same pattern hides on the write side: calling `save()` in a loop issues one `UPDATE` per object, `create()` in a loop one `INSERT` each. And on the read side, loading full model instances (all 40 columns, including a 50 KB `description` text field) to display three columns wastes memory and bandwidth.

> **Why this matters:** "Difference between `select_related` and `prefetch_related`" is the single most-asked Django ORM interview question. Interviewers then probe whether you can *detect* N+1 (not just name it), and whether you know when a prefetch is silently defeated.

## 2. Core Concepts

- **N+1 problem** — 1 query for the parent list + N queries for a relation accessed per row. *Why:* latency scales with page size × round-trip time, not with data complexity.
- **Lazy relation access** — related objects are fetched by descriptors (`ForwardManyToOneDescriptor.__get__`, `ReverseManyToOneDescriptor`, `ManyToManyDescriptor`) on first access. *Why:* this is where hidden queries come from.
- **`select_related(*fields)`** — follow forward `ForeignKey`/`OneToOneField` (and reverse one-to-one) with SQL JOINs in the same query. *Why:* zero extra round trips for single-valued relations.
- **`prefetch_related(*lookups)`** — after the main query, run **one extra query per relation** with `WHERE fk IN (...)` and stitch results in Python. Works for M2M, reverse FK, `GenericForeignKey`, and also forward FK. *Why:* multi-valued relations can't be JOINed without duplicating parent rows.
- **`Prefetch(lookup, queryset=None, to_attr=None)`** — customise the prefetch query (filter, order, `select_related`, `only`) and optionally store it as a list attribute. *Why:* "prefetch only the active items, newest first".
- **`prefetch_related_objects(instances, *lookups)`** — prefetch onto an already-evaluated list. *Why:* useful when objects came from cache or multiple sources.
- **`only(*fields)` / `defer(*fields)`** — load a subset of columns into model instances; others become deferred and load lazily on access. *Why:* smaller rows, but accessing a deferred field per row is a new N+1.
- **`values()` / `values_list(flat=True)`** — return dicts/tuples instead of instances. *Why:* no model instantiation overhead; ideal for exports and IDs.
- **`bulk_create` / `bulk_update`** — many rows in one (or a few batched) statements; skip `save()` and signals. *Why:* 10,000 inserts become ~10 queries.
- **`QuerySet.update()` / `delete()`** — set-based writes in SQL. *Why:* one statement, atomic per row, no read-modify-write race.
- **`iterator(chunk_size=…)`** — stream results without the result cache; uses a server-side cursor on PostgreSQL. *Why:* constant memory for huge exports.
- **`exists()` / `count()` / `contains()`** — ask the DB for a boolean/number instead of fetching rows. *Why:* don't `len(qs)` just to check emptiness.
- **`explain()`** — returns the database's query plan. *Why:* tells you whether a single query is slow (index problem) as opposed to too many queries (N+1).
- **Query counting** — `assertNumQueries`, `django_assert_num_queries` (pytest-django), `connection.queries`, debug toolbar. *Why:* you can't fix what you don't measure, and tests lock fixes in.

## 3. Theory & Principles

### 3.1 Where the N+1 actually happens

```python
orders = Order.objects.all()[:100]      # lazy, no query yet
for o in orders:                          # query 1: SELECT ... FROM order LIMIT 100
    print(o.customer.name)                # queries 2..101: SELECT ... FROM user WHERE id = %s
```

When you access `o.customer`, `ForwardManyToOneDescriptor.__get__` checks the instance's field cache (`o._state.fields_cache["customer"]`). On a miss it runs `self.get_object(instance)` — a `get()` on the related model by primary key — and caches the result on that instance only. Each `Order` instance has its own cache, so every row misses once. Reverse and M2M managers (`o.items.all()`) work similarly: `ReverseManyToOneDescriptor` returns a `RelatedManager` whose `get_queryset()` first checks `instance._prefetched_objects_cache`; on a miss it builds a fresh filtered QuerySet and runs it.

So both fixes work by **pre-filling those caches**: `select_related` fills `fields_cache` from joined columns while building each instance; `prefetch_related` fills `_prefetched_objects_cache` (or your `to_attr`) after a batched query.

### 3.2 `select_related` vs `prefetch_related`, mechanically

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj13a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="dj13b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj13c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Three ways to load 100 orders with their customer and items</text>
  <rect x="20" y="40" width="270" height="380" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="155" y="62" text-anchor="middle" fill="#7f1d1d" font-size="12" font-weight="bold">Lazy (N+1): 201 queries</text>
  <rect x="40" y="78" width="230" height="28" rx="5" fill="#fff" stroke="#dc2626"/><text x="155" y="96" text-anchor="middle" fill="#7f1d1d" font-size="10">SELECT * FROM order LIMIT 100</text>
  <path d="M155,108 L155,128" stroke="#dc2626" stroke-width="2" marker-end="url(#dj13a)"/>
  <text x="40" y="146" fill="#7f1d1d" font-size="10">for each of 100 orders:</text>
  <rect x="40" y="156" width="230" height="28" rx="5" fill="#fff" stroke="#dc2626"/><text x="155" y="174" text-anchor="middle" fill="#7f1d1d" font-size="10">SELECT * FROM user WHERE id = 7</text>
  <rect x="40" y="192" width="230" height="28" rx="5" fill="#fff" stroke="#dc2626"/><text x="155" y="210" text-anchor="middle" fill="#7f1d1d" font-size="10">SELECT * FROM item WHERE order_id = 1</text>
  <text x="155" y="240" text-anchor="middle" fill="#7f1d1d" font-size="10">... x 100</text>
  <text x="40" y="280" fill="#7f1d1d" font-size="10">Each query is fast (pk/index lookup).</text>
  <text x="40" y="298" fill="#7f1d1d" font-size="10">Cost = 201 round trips x latency.</text>
  <text x="40" y="316" fill="#7f1d1d" font-size="10">At 1 ms RTT: 200 ms of pure waiting.</text>
  <text x="40" y="350" fill="#7f1d1d" font-size="10">Indexes don't help. Only fewer</text>
  <text x="40" y="368" fill="#7f1d1d" font-size="10">round trips help.</text>
  <rect x="305" y="40" width="270" height="380" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="440" y="62" text-anchor="middle" fill="#1e3a8a" font-size="12" font-weight="bold">select_related("customer")</text>
  <rect x="320" y="78" width="240" height="56" rx="5" fill="#fff" stroke="#2563eb"/>
  <text x="330" y="96" fill="#1e293b" font-size="10">SELECT order.*, user.*</text>
  <text x="330" y="112" fill="#1e293b" font-size="10">FROM order INNER JOIN user</text>
  <text x="330" y="128" fill="#1e293b" font-size="10">ON order.customer_id = user.id</text>
  <path d="M440,136 L440,160" stroke="#2563eb" stroke-width="2" marker-end="url(#dj13b)"/>
  <text x="320" y="180" fill="#1e293b" font-size="10">one row per order, user columns appended</text>
  <text x="320" y="198" fill="#1e293b" font-size="10">ModelIterable builds Order + User,</text>
  <text x="320" y="216" fill="#1e293b" font-size="10">sets order._state.fields_cache["customer"]</text>
  <text x="320" y="250" fill="#2563eb" font-size="10" font-weight="bold">Forward FK / O2O only</text>
  <text x="320" y="268" fill="#2563eb" font-size="10">nullable FK &#8594; LEFT OUTER JOIN</text>
  <text x="320" y="286" fill="#2563eb" font-size="10">Can't do M2M/reverse FK: would</text>
  <text x="320" y="304" fill="#2563eb" font-size="10">duplicate the order row per item</text>
  <text x="320" y="338" fill="#2563eb" font-size="10">1 query total</text>
  <text x="320" y="356" fill="#2563eb" font-size="10">risk: wide rows, many joins</text>
  <rect x="590" y="40" width="270" height="380" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="725" y="62" text-anchor="middle" fill="#14532d" font-size="12" font-weight="bold">prefetch_related("items")</text>
  <rect x="605" y="78" width="240" height="28" rx="5" fill="#fff" stroke="#16a34a"/><text x="725" y="96" text-anchor="middle" fill="#1e293b" font-size="10">Q1: SELECT * FROM order LIMIT 100</text>
  <path d="M725,108 L725,124" stroke="#16a34a" stroke-width="2" marker-end="url(#dj13c)"/>
  <text x="605" y="140" fill="#1e293b" font-size="10">collect pks: [1, 2, ... 100]</text>
  <rect x="605" y="150" width="240" height="44" rx="5" fill="#fff" stroke="#16a34a"/>
  <text x="615" y="168" fill="#1e293b" font-size="10">Q2: SELECT * FROM item</text>
  <text x="615" y="184" fill="#1e293b" font-size="10">WHERE order_id IN (1, 2, ... 100)</text>
  <path d="M725,196 L725,214" stroke="#16a34a" stroke-width="2" marker-end="url(#dj13c)"/>
  <text x="605" y="232" fill="#1e293b" font-size="10">Python: group items by order_id,</text>
  <text x="605" y="250" fill="#1e293b" font-size="10">store in each order&#8217;s</text>
  <text x="605" y="268" fill="#1e293b" font-size="10">_prefetched_objects_cache["items"]</text>
  <text x="605" y="302" fill="#16a34a" font-size="10" font-weight="bold">M2M, reverse FK, GFK (and FK)</text>
  <text x="605" y="320" fill="#16a34a" font-size="10">1 extra query per relation level</text>
  <text x="605" y="338" fill="#16a34a" font-size="10">order.items.all() &#8594; served from cache</text>
  <text x="605" y="356" fill="#dc2626" font-size="10">order.items.filter(...) &#8594; NEW query</text>
  <text x="605" y="384" fill="#16a34a" font-size="10">Combined: 2 queries for all of it</text>
  <text x="605" y="402" fill="#16a34a" font-size="10">(select + prefetch together)</text>
</svg>
```

### 3.3 How prefetching works internally

When the main QuerySet evaluates, `QuerySet._fetch_all()` fills `_result_cache` and then, if `_prefetch_related_lookups` is non-empty, calls `_prefetch_related_objects()` → `prefetch_related_objects(self._result_cache, *lookups)`. For each lookup (split on `__` into levels), it:

1. Finds the descriptor for the attribute on the first instance and asks it for a `prefetcher` via `get_prefetcher()`.
2. Calls `prefetcher.get_prefetch_querysets(instances, querysets)` (Django 5.0+; previously `get_prefetch_queryset`), which returns the related QuerySet filtered with `__in` on the collected keys, plus functions to extract the join key from each related object and each instance.
3. Evaluates that QuerySet (one query), builds a dict `key → [related objects]`, and assigns each instance's list into `_prefetched_objects_cache[cache_name]` (or `setattr(instance, to_attr, list)`).
4. Recurses for the next level (`items__product`) using the objects just fetched as the new instance list.

For M2M the extra query joins the through table and selects the source FK as an extra column (`_prefetch_related_val_<fk>`) to know which parent each row belongs to.

Two consequences matter. First, the relation manager's `.all()` reads the cache, but `.filter()`, `.order_by()`, `.exclude()` or `.first()` (which adds ordering) on the manager **builds a new QuerySet and queries again** — prefetching is defeated. Use `Prefetch(queryset=…)` to do the filtering in the prefetch itself. Second, the `IN (...)` list contains all parent keys: prefetching from 50,000 parents sends 50,000 parameters. That's legal on PostgreSQL but slow to plan and transfer; paginate or chunk.

### 3.4 Prefetch with `to_attr`, nesting and slicing

```python
from django.db.models import Prefetch

Order.objects.prefetch_related(
    Prefetch(
        "items",
        queryset=OrderItem.objects.select_related("product").filter(cancelled=False).order_by("id"),
        to_attr="active_items",                   # list attribute, not a manager
    ),
)
```

`to_attr` stores a plain `list` — `order.active_items` — making it impossible to accidentally re-query through a manager, and letting you prefetch the same relation twice with different filters. Since Django 4.2, the Prefetch queryset may be **sliced** (`[:3]`), which Django implements with a `ROW_NUMBER() OVER (PARTITION BY fk)` window, giving "latest 3 comments per post" in one extra query.

## 4. Architecture & Workflow

### 4.1 The optimization workflow

```svg
<svg viewBox="0 0 880 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj13d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Measure, classify, fix, lock in</text>
  <rect x="20" y="50" width="150" height="90" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="95" y="72" text-anchor="middle" fill="#1e3a8a" font-weight="bold">1. Measure</text>
  <text x="32" y="92" fill="#1e293b" font-size="10">debug toolbar SQL panel</text>
  <text x="32" y="108" fill="#1e293b" font-size="10">connection.queries</text>
  <text x="32" y="124" fill="#1e293b" font-size="10">APM / Sentry spans</text>
  <path d="M172,95 L208,95" stroke="#334155" stroke-width="2" marker-end="url(#dj13d)"/>
  <rect x="212" y="50" width="200" height="200" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="312" y="72" text-anchor="middle" fill="#78350f" font-weight="bold">2. Classify</text>
  <text x="224" y="96" fill="#1e293b" font-size="10">Many similar queries</text>
  <text x="224" y="112" fill="#d97706" font-size="10">&#8594; N+1 (relation access)</text>
  <text x="224" y="138" fill="#1e293b" font-size="10">One slow query</text>
  <text x="224" y="154" fill="#d97706" font-size="10">&#8594; plan problem: explain()</text>
  <text x="224" y="180" fill="#1e293b" font-size="10">Fast SQL, slow Python</text>
  <text x="224" y="196" fill="#d97706" font-size="10">&#8594; too many instances/columns</text>
  <text x="224" y="222" fill="#1e293b" font-size="10">Many INSERT/UPDATE</text>
  <text x="224" y="238" fill="#d97706" font-size="10">&#8594; loop of save()</text>
  <path d="M414,95 L450,95" stroke="#334155" stroke-width="2" marker-end="url(#dj13d)"/>
  <rect x="454" y="50" width="230" height="200" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="569" y="72" text-anchor="middle" fill="#14532d" font-weight="bold">3. Fix</text>
  <text x="466" y="96" fill="#1e293b" font-size="10">FK/O2O: select_related</text>
  <text x="466" y="112" fill="#1e293b" font-size="10">M2M/reverse: prefetch / Prefetch</text>
  <text x="466" y="128" fill="#1e293b" font-size="10">counts: annotate(Count) / Exists</text>
  <text x="466" y="154" fill="#1e293b" font-size="10">plan: index, rewrite, Exists</text>
  <text x="466" y="180" fill="#1e293b" font-size="10">only() / values() / iterator()</text>
  <text x="466" y="222" fill="#1e293b" font-size="10">bulk_create / bulk_update / update()</text>
  <path d="M686,95 L722,95" stroke="#334155" stroke-width="2" marker-end="url(#dj13d)"/>
  <rect x="726" y="50" width="134" height="90" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="793" y="72" text-anchor="middle" fill="#4c1d95" font-weight="bold">4. Lock in</text>
  <text x="736" y="92" fill="#1e293b" font-size="10">assertNumQueries(n)</text>
  <text x="736" y="108" fill="#1e293b" font-size="10">test with 2 and 20 rows:</text>
  <text x="736" y="124" fill="#1e293b" font-size="10">count must not change</text>
  <rect x="20" y="266" width="840" height="26" rx="6" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="283" text-anchor="middle" fill="#334155" font-size="10">The key N+1 test: the number of queries must be constant in the number of rows. If 2 rows = 5 queries and 20 rows = 23, you have N+1.</text>
</svg>
```

### 4.2 Decision table

```text
Accessing in a loop...                    Use
---------------------------------------   ---------------------------------------------------
obj.fk_field / obj.one_to_one             select_related("fk_field")      (JOIN)
obj.fk.fk.fk (chain of FKs)               select_related("fk__fk__fk")
obj.reverse_set.all() / obj.m2m.all()     prefetch_related("reverse_set")  (IN query)
filtered/ordered children                 Prefetch("rel", queryset=..., to_attr="x")
children's FK                             Prefetch("rel", queryset=Child.objects.select_related("fk"))
only a count of children                  annotate(n=Count("rel"))         (no objects at all)
whether any child matches                 annotate(has=Exists(...))
the latest child                          Subquery(...[:1]) or Prefetch(queryset=...[:1]) (4.2+)
generic FK                                prefetch_related("content_object") / GenericPrefetch (5.0+)
```

## 5. Implementation

### 5.1 Simple example: spotting and fixing N+1 in a shell

```python
# shop/models.py
from django.conf import settings
from django.db import models

class Product(models.Model):
    name = models.CharField(max_length=200)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    description = models.TextField()

class Tag(models.Model):
    name = models.CharField(max_length=50, unique=True)

class Order(models.Model):
    customer = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="orders")
    coupon = models.ForeignKey("Coupon", null=True, blank=True, on_delete=models.SET_NULL)
    status = models.CharField(max_length=20, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    tags = models.ManyToManyField(Tag, blank=True)

class Coupon(models.Model):
    code = models.CharField(max_length=20, unique=True)

class OrderItem(models.Model):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="items")
    product = models.ForeignKey(Product, on_delete=models.PROTECT)
    quantity = models.PositiveIntegerField()
```

```python
# python manage.py shell   (DEBUG=True so connection.queries is populated)
from django.db import connection, reset_queries
reset_queries()
for o in Order.objects.all()[:50]:
    o.customer.email, [i.product.name for i in o.items.all()]
len(connection.queries)
```

```text
>>> len(connection.queries)
301          # 1 orders + 50 customers + 50 item lists + ~200 products
```

```python
reset_queries()
qs = (Order.objects
      .select_related("customer", "coupon")
      .prefetch_related(Prefetch("items", queryset=OrderItem.objects.select_related("product")))
      [:50])
for o in qs:
    o.customer.email, [i.product.name for i in o.items.all()]
len(connection.queries)
```

```text
>>> len(connection.queries)
2
>>> for q in connection.queries: print(q["sql"][:120])
SELECT "shop_order"."id", ..., "auth_user"."id", ..., "shop_coupon"."id", ... FROM "shop_order" INNER JOIN "auth_user" ON ... LEFT OUTER JOIN "shop_coupon" ON ... LIMIT 50
SELECT "shop_orderitem"."id", ..., "shop_product"."id", ... FROM "shop_orderitem" INNER JOIN "shop_product" ON ... WHERE "shop_orderitem"."order_id" IN (1, 2, 3, ...)
```

Notice: `customer` (non-null FK) is an INNER JOIN, `coupon` (nullable) is a LEFT OUTER JOIN, and the prefetch's own `select_related("product")` folds products into the second query.

### 5.2 Fetch less: `only`, `defer`, `values`

```python
# Load only what the list page needs; description (large TEXT) stays in the DB
Product.objects.only("id", "name", "price")
# SELECT "shop_product"."id", "shop_product"."name", "shop_product"."price" FROM "shop_product"

Product.objects.defer("description")       # everything except description

# Pitfall: touching a deferred field in a loop is a new N+1
for p in Product.objects.only("id", "name"):
    p.price        # SELECT price FROM shop_product WHERE id = %s  -- per row!

# Pure data, no model instances
Product.objects.values_list("id", flat=True)                # [1, 2, 3, ...]
Order.objects.values("id", "customer__email", "status")     # JOIN, dicts
```

With `select_related`, you can restrict the joined model's columns too: `Order.objects.select_related("customer").only("id", "status", "customer__email")`.

### 5.3 Write in sets

```python
# 10,000 INSERTs -> a handful of multi-row INSERTs
OrderItem.objects.bulk_create(
    [OrderItem(order_id=oid, product_id=pid, quantity=q) for oid, pid, q in rows],
    batch_size=1000,
)

# Upsert (4.1+): insert or update on conflict
Product.objects.bulk_create(
    products,
    update_conflicts=True,
    unique_fields=["sku"],
    update_fields=["price", "name"],
)

# Many different values in one UPDATE ... CASE WHEN
for p in products: p.price = p.price * Decimal("1.1")
Product.objects.bulk_update(products, ["price"], batch_size=500)

# Same change for a set: one UPDATE, no instances loaded
Order.objects.filter(status="pending", created_at__lt=cutoff).update(status="expired")

# Atomic increment at the database
Product.objects.filter(pk=pid).update(stock=F("stock") - 1)
```

```sql
-- bulk_update
UPDATE "shop_product" SET "price" = CASE WHEN ("shop_product"."id" = 1) THEN 11.00
                                          WHEN ("shop_product"."id" = 2) THEN 22.00 ... ELSE NULL END
WHERE "shop_product"."id" IN (1, 2, ...);

-- update with F
UPDATE "shop_product" SET "stock" = ("shop_product"."stock" - 1) WHERE "shop_product"."id" = 42;
```

Remember the trade-off: `bulk_create`, `bulk_update` and `update()` skip `save()`, don't send `pre_save`/`post_save`, and don't update `auto_now` fields unless you include them. `bulk_create` sets primary keys on PostgreSQL (via `RETURNING`). Signals are covered in [Ch 19 · Signals](topic.html?p=19-signals); the concurrency side of `F()` in [Ch 14](topic.html?p=14-transactions-concurrency).

### 5.4 Stream big result sets

```python
import csv
from django.http import StreamingHttpResponse

class Echo:
    def write(self, value): return value

def export_orders(request):
    rows = (Order.objects.filter(status="paid")
            .values_list("id", "customer__email", "created_at")
            .iterator(chunk_size=5000))
    writer = csv.writer(Echo())
    return StreamingHttpResponse((writer.writerow(r) for r in rows), content_type="text/csv")
```

`iterator()` skips the result cache, and on PostgreSQL uses a server-side cursor (named cursor) fetching `chunk_size` rows at a time (default 2000). Behind PgBouncer in transaction mode server-side cursors break; set `DISABLE_SERVER_SIDE_CURSORS = True` for that database (see [Ch 34](topic.html?p=34-scaling-databases)). Since 4.1, `prefetch_related` works with `iterator()` if you pass `chunk_size` — each chunk is prefetched separately.

### 5.5 Real-world example: a DRF order list from 203 queries to 3

```python
# api/serializers.py
from rest_framework import serializers
from shop.models import Order, OrderItem

class OrderItemSerializer(serializers.ModelSerializer):
    product_name = serializers.CharField(source="product.name")
    class Meta:
        model = OrderItem
        fields = ["id", "product_name", "quantity"]

class OrderSerializer(serializers.ModelSerializer):
    customer_email = serializers.EmailField(source="customer.email")
    coupon_code = serializers.CharField(source="coupon.code", default=None)
    items = OrderItemSerializer(many=True, source="active_items")
    tags = serializers.SlugRelatedField(many=True, read_only=True, slug_field="name")
    item_count = serializers.IntegerField(read_only=True)

    class Meta:
        model = Order
        fields = ["id", "status", "created_at", "customer_email", "coupon_code", "items", "tags", "item_count"]
```

```python
# api/views.py
from django.db.models import Count, Prefetch
from rest_framework import viewsets
from shop.models import Order, OrderItem
from .serializers import OrderSerializer

class OrderViewSet(viewsets.ReadOnlyModelViewSet):
    serializer_class = OrderSerializer

    def get_queryset(self):
        return (
            Order.objects.filter(customer__is_active=True)
            .select_related("customer", "coupon")
            .only("id", "status", "created_at", "customer__email", "coupon__code")
            .annotate(item_count=Count("items"))
            .prefetch_related(
                Prefetch(
                    "items",
                    queryset=OrderItem.objects.select_related("product").only(
                        "id", "order_id", "quantity", "product__name"),
                    to_attr="active_items",
                ),
                "tags",
            )
            .order_by("-created_at")
        )
```

```text
GET /api/orders/?page=1  (page size 50)
before: 203 queries, 410 ms   (1 list + 1 count + 50 customer + 50 coupon + 50 items + 50 tags + N products...)
after:    4 queries,  28 ms   (count, orders+customer+coupon JOIN with GROUP BY, items+product, tags)
```

Lock it in:

```python
# api/tests.py
from django.test import TestCase
from django.urls import reverse

class OrderListQueryCountTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = make_user_with_orders(n_orders=30, items_per_order=3)  # your factory

    def test_query_count_is_constant(self):
        self.client.force_login(self.user)
        # 2 auth queries (session + user) + count + orders + items + tags
        with self.assertNumQueries(6):
            r = self.client.get(reverse("order-list"))
        self.assertEqual(r.status_code, 200)
```

> **Gotcha:** the `only()` here must include `order_id` in the Prefetch queryset — Django needs the FK to attach items to orders. Leave it out and every item triggers a deferred-field load.

## 6. Advantages, Disadvantages & Trade-offs

| Tool | Queries | Best for | Cost / risk |
|---|---|---|---|
| `select_related` | 1 (JOIN) | FK, O2O chains | Wide rows; many joins can explode the plan; duplicate data when many children share one parent |
| `prefetch_related` | 1 + 1 per relation | M2M, reverse FK, GFK | Large `IN` lists; memory for all children; defeated by manager `.filter()` |
| `Prefetch(queryset, to_attr)` | same | Filtered/ordered/sliced children | More code; to_attr lists aren't managers |
| `annotate(Count)` | 1 | Counts only | GROUP BY cost; fan-out with several relations ([Ch 12](topic.html?p=12-aggregation-annotation-subqueries)) |
| `only` / `defer` | 1 | Skipping big columns | Deferred access = N+1; fragile when templates change |
| `values` / `values_list` | 1 | Exports, IDs, aggregates | No model methods/properties |
| `iterator(chunk_size)` | 1 cursor | Huge scans | No result cache; server-side cursor vs PgBouncer |
| `bulk_create` / `bulk_update` | N/batch | Imports, backfills | No `save()`/signals; `bulk_update` CASE gets slow for huge batches |
| `update()` / `delete()` | 1 | Set-based changes | No `save()` (update); delete still collects for cascades/signals |

### When to use

- `select_related` for every FK you touch per row in a list; `prefetch_related` for every collection.
- `only()` when a model has large columns (TEXT, JSON) not shown in the list.
- `values_list(flat=True)` to feed IDs into another query (or better, pass the QuerySet itself as a subquery: `filter(id__in=qs.values("id"))`).
- `bulk_*` for imports and migrations; `update()` with `F()` for counters.

### When NOT to use

- Don't `select_related()` with no arguments on models with many FKs — it follows every non-null FK recursively (bounded by depth) and pulls huge rows.
- Don't prefetch relations you don't render — that's a wasted query and memory.
- Don't use `bulk_create` when business logic lives in `save()` or signals you depend on (or replicate that logic explicitly).
- Don't micro-optimise with `only()` in code paths whose templates change often — a new field in the template silently becomes N+1. Pair with query-count tests.

## 7. Common Mistakes & Best Practices

**1. Filtering on a prefetched manager.**

```python
# Before: prefetch is wasted, one query per order
orders = Order.objects.prefetch_related("items")
for o in orders:
    active = o.items.filter(cancelled=False)      # new query each time

# After
orders = Order.objects.prefetch_related(
    Prefetch("items", queryset=OrderItem.objects.filter(cancelled=False), to_attr="active_items"))
for o in orders:
    active = o.active_items                        # list, no query
```

The same applies to `.first()`, `.last()`, `.order_by()`, `.count()` on the manager — although `.count()` on a prefetched `.all()` uses the cache (`len`), `manager.count()` without prefetch is a query. In templates, prefer `{{ order.items.all|length }}` after prefetching.

**2. N+1 in `__str__`.** `def __str__(self): return f"{self.order.customer} – {self.product}"` — harmless on one object, catastrophic in an admin changelist or a select widget with 500 options. Add `list_select_related` in the admin, or keep `__str__` free of relations.

**3. Counting with `len()` or checking with `if qs:`.** `len(qs)` fetches every row; `if qs:` too. Use `qs.count()` / `qs.exists()` — unless you're going to iterate anyway, in which case evaluating once and reusing the cache is the cheapest.

**4. Re-evaluating QuerySets.** `Order.objects.filter(...)` called twice in a template (once for `count`, once for the loop) via a method that builds a new QuerySet each time. Assign once in the view; pass the evaluated list.

**5. `save()` in a loop.**

```python
# Before: N UPDATEs, and a race if two workers do it
for p in Product.objects.filter(category=c):
    p.price = p.price * Decimal("0.9")
    p.save()

# After: one UPDATE, computed by the database
Product.objects.filter(category=c).update(price=F("price") * Decimal("0.9"))
```

**6. `IN` with a materialised Python list.** `ids = list(qs.values_list("id", flat=True)); Other.objects.filter(fk__in=ids)` makes two round trips and ships the list both ways. Pass the QuerySet (`fk__in=qs.values("id")`) so Django emits a subquery.

**7. Serializer method fields that query.** `SerializerMethodField` doing `obj.items.count()` per row. Annotate in `get_queryset` instead. See [Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers).

**Best practices:** optimise in `get_queryset()` (view or manager), not ad hoc in templates; write query-count tests for every list endpoint; keep django-debug-toolbar in local dev; review `select_related`/`prefetch_related` whenever a serializer or template gains a field.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: endpoint latency grows with page size.** *Symptom:* p95 doubles when the mobile app raises page size from 20 to 50. *Root cause:* a nested serializer added `product.brand.name` without a matching `select_related`. *Fix:* `Prefetch("items", queryset=OrderItem.objects.select_related("product__brand"))` and a query-count test that runs with two different row counts.

**Pitfall: memory spike in an export job.** A Celery task did `for o in Order.objects.all()` on 8M rows; the result cache held every instance and the worker was OOM-killed. *Fix:* `.iterator(chunk_size=2000)` and `values_list`, or keyset batches (`filter(id__gt=last_id).order_by("id")[:5000]`).

**Pitfall: `select_related` made it slower.** Joining five FKs including a wide `profile` with JSON blobs turned a 3 ms query into 300 ms and a 40 MB result. *Fix:* `only()` the joined columns you need, or use `prefetch_related` for the wide relation so it's fetched once per distinct row (prefetch de-duplicates parents — 100 orders from 3 customers fetch 3 customers, whereas a JOIN repeats the customer columns 100 times).

**Pitfall: giant `IN` lists.** Prefetching from 100k parents creates a 100k-parameter query; on some backends (SQLite, Oracle) there are hard parameter limits, and Django batches on those backends, but on PostgreSQL it's one huge query. *Fix:* paginate, or `iterator(chunk_size=…)` with prefetch (4.1+).

**Pitfall: N+1 from permissions.** `has_object_permission` hitting the DB per object, or a template tag checking `user.has_perm` per row with a custom backend. Cache per-request, or precompute in the queryset. See [Ch 26 · Permissions](topic.html?p=26-permissions-authorization).

**Debugging toolkit:**

```python
# Local: debug toolbar SQL panel shows duplicates ("similar" / "duplicated" counts) and EXPLAIN per query.
# Shell / scripts:
from django.db import connection, reset_queries
from django.test.utils import CaptureQueriesContext
with CaptureQueriesContext(connection) as ctx:
    render_page()
print(len(ctx.captured_queries))
for q in ctx.captured_queries: print(q["time"], q["sql"][:150])

# Single slow query:
print(Order.objects.filter(status="paid").order_by("-created_at")[:50].explain(analyze=True))
```

```python
# Log every query in dev (settings.py) — never in production
LOGGING = {
    "version": 1,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "loggers": {"django.db.backends": {"handlers": ["console"], "level": "DEBUG"}},
}
```

In production, use your APM (Sentry Performance, Datadog, New Relic) which flags N+1 spans automatically, and PostgreSQL `pg_stat_statements` sorted by `calls` — an N+1 shows up as a primary-key query with millions of calls. The `nplusone` package (GitHub) can raise on lazy loads in tests; a `CaptureQueriesContext` middleware that logs requests over a threshold also works.

**Scaling notes:** once queries are few and well-indexed, next steps are caching ([Ch 29 · Caching](topic.html?p=29-caching)), read replicas ([Ch 34](topic.html?p=34-scaling-databases)), and denormalisation. Plan analysis is in [SQL · Execution Plans](../sql/topic.html?p=22-execution-plans) and [SQL · Query Optimization](../sql/topic.html?p=21-query-optimization); diagnosing a saturated database in [Database Design · Bottleneck Diagnosis](../database-design/topic.html?p=23-bottleneck-diagnosis).

## 9. Interview Questions

**Q: What is the N+1 query problem?**
A: It's when code runs one query to fetch a list of N objects and then one additional query per object to fetch a related object or collection — N+1 queries in total. In Django it happens because related attributes are loaded lazily by descriptors on first access, so `for o in orders: o.customer.name` silently queries per row. Each query may be fast, but the total cost is N round trips, so latency grows linearly with page size. The fix is to load relations in bulk with `select_related` or `prefetch_related`, or avoid loading them by annotating.

**Q: What is the difference between `select_related` and `prefetch_related`?**
A: `select_related` follows single-valued relations — forward ForeignKey and OneToOne (plus reverse OneToOne) — with SQL JOINs, so related objects come back in the same query. `prefetch_related` runs one additional query per relation using `WHERE fk IN (...)` on the collected keys and joins the results in Python; it handles multi-valued relations (ManyToMany, reverse ForeignKey) and GenericForeignKey, and can also be used for FKs. You can't JOIN a multi-valued relation without duplicating the parent rows, which is why prefetch exists. They combine: `select_related("customer").prefetch_related("items__product")`.

**Q: How do you detect N+1 queries?**
A: Locally, django-debug-toolbar's SQL panel shows the query count and flags similar/duplicated queries; `connection.queries` (with DEBUG) or `CaptureQueriesContext` lets you count in a shell. In tests, `assertNumQueries` or pytest-django's `django_assert_num_queries` — ideally run with two different data sizes to prove the count is constant. In production, APM tools flag repeated spans, and `pg_stat_statements` shows a primary-key query with an enormous call count. Logging `django.db.backends` at DEBUG in development also makes repeated queries obvious.

**Q: Why might `prefetch_related` not reduce the number of queries?**
A: Because the code accesses the relation in a way that bypasses the prefetch cache. Calling `.filter()`, `.exclude()`, `.order_by()`, `.first()` or `.latest()` on a related manager builds a new QuerySet and queries the database, even though `.all()` would have been served from cache. The fix is to move that filtering into a `Prefetch("items", queryset=..., to_attr="...")`. Another cause is a prefetched relation whose children then access their own unprefetched FK — nest the lookup (`items__product`) or add `select_related` inside the Prefetch queryset.

**Q: What does the `Prefetch` object give you over a string lookup?**
A: It lets you supply a custom queryset for the related objects — filtering, ordering, `select_related`, `only`, annotations — and with `to_attr` store the result as a list under a new attribute. That allows prefetching the same relation twice with different filters, makes it impossible to accidentally re-query via a manager, and since Django 4.2 supports sliced querysets for "top N children per parent". The string form always prefetches all related rows with the default manager's queryset.

**Q: What's the difference between `only()` and `defer()`, and what's the risk?**
A: `only("a", "b")` loads just those fields (plus the primary key); `defer("c")` loads everything except `c`. Both return model instances whose missing fields are deferred. The risk is that accessing a deferred field triggers a query per instance — reintroducing N+1 — and that this breaks silently when someone adds a field to a template or serializer. Use them for genuinely large columns and back them with query-count tests; if you don't need model behaviour, `values()` is simpler.

**Q: What are the caveats of `bulk_create` and `bulk_update`?**
A: Both bypass `Model.save()`, so custom save logic doesn't run, and they don't send `pre_save`/`post_save` signals. `bulk_create` sets primary keys on PostgreSQL (and newer SQLite/MariaDB) but not on all backends, doesn't work with multi-table inheritance children, and supports `ignore_conflicts` or, since 4.1, `update_conflicts` with `unique_fields`/`update_fields` for upserts. `bulk_update` builds a `CASE WHEN` per field, which gets slow for very large batches, so set `batch_size`. Neither calls `full_clean()`, so validate beforehand.

**Q: When should you use `QuerySet.update()` instead of `save()`?**
A: When you're changing a set of rows the same way, or doing arithmetic on the current DB value. `update()` issues one `UPDATE … WHERE`, returns the number of rows matched, and with `F()` expressions (`stock=F("stock") - 1`) is atomic at the row level, avoiding the read-modify-write race of `obj.stock -= 1; obj.save()`. The trade-off is that it skips `save()`, signals and `auto_now` fields. Use `save(update_fields=[...])` when you need per-instance logic but want a narrow UPDATE.

**Q: What's the difference between `count()`, `len()` and `exists()`?**
A: `count()` runs `SELECT COUNT(*)` unless the QuerySet is already evaluated, in which case it uses the cached length. `len(qs)` evaluates the whole QuerySet, fetching every row, then counts the list — wasteful unless you'll iterate anyway. `exists()` runs a `SELECT 1 … LIMIT 1`, the cheapest way to test presence. If you're going to loop over the results regardless, evaluating once and using `len()` saves a query.

**Q: How would you export 10 million rows to CSV from Django without running out of memory? (Senior)**
A: Avoid the result cache and model instances: `values_list(...).iterator(chunk_size=5000)` streams through a server-side cursor on PostgreSQL, and a `StreamingHttpResponse` or a background Celery task writing to object storage keeps memory flat. If PgBouncer runs in transaction mode, server-side cursors don't survive, so use keyset pagination instead — `filter(id__gt=last).order_by("id")[:5000]` in a loop — which is also resumable. Run it against a read replica, and for very large exports consider PostgreSQL `COPY` via the driver. I'd also make it asynchronous with a progress record rather than holding an HTTP request open.

**Q: A list endpoint has p95 of 1.2 s. Walk me through how you'd find and fix the cause. (Senior)**
A: First measure: the APM trace or debug toolbar tells me whether time is in many queries, one slow query, or Python. If I see dozens of near-identical queries, it's N+1 — I trace which serializer field or template access triggers it and add `select_related`/`Prefetch` in `get_queryset`, or replace per-row counts with annotations. If one query dominates, I run `explain(analyze=True)` and look for sequential scans, sort spills or bad join orders, then add an index or rewrite (e.g. `Exists` instead of `distinct()`). If SQL is fast but Python is slow, I reduce instantiated objects and columns with `only`/`values`. Finally I pin the query count with a test and watch the p95 after deploy.

**Q: When can `select_related` be worse than `prefetch_related` for a ForeignKey? (Senior)**
A: When the related rows are wide and heavily shared. A JOIN repeats the related columns on every parent row — 10,000 order rows referencing 20 merchants with big JSON settings means transferring those settings 10,000 times — while prefetch fetches each distinct merchant once with a small `IN` query. Many joins also increase planning complexity and can lead to poor join orders. Also, `select_related` on a nullable FK uses a LEFT OUTER JOIN, which can prevent some optimizations. So for wide, low-cardinality relations, prefetch (or `only()` on the joined fields) can win; measure with EXPLAIN and payload size.

**Q: How do you prevent N+1 regressions across a team? (Senior)**
A: Make query counts part of the contract: every list endpoint gets a test asserting a constant number of queries, run with at least two dataset sizes. Centralise queryset construction in `get_queryset()` or custom QuerySet methods (`Order.objects.for_list_api()`), so serializers and querysets change together. In CI or tests, tools such as `nplusone` can fail on lazy loads. In production, APM N+1 detection alerts and `pg_stat_statements` reviews catch what tests miss. Code review checklists should flag new relation accesses in serializers, `__str__` and templates.

## 10. Quick Revision & Cheat Sheet

| Situation | Tool | SQL shape |
|---|---|---|
| FK / O2O per row | `select_related("fk")` | JOIN (INNER, or LEFT if nullable) |
| Reverse FK / M2M per row | `prefetch_related("rel")` | + `WHERE fk IN (...)` |
| Filtered/ordered children | `Prefetch("rel", queryset=..., to_attr="x")` | + filtered IN query |
| N children per parent | `Prefetch(queryset=qs[:3])` (4.2+) | ROW_NUMBER window |
| Only count of children | `annotate(n=Count("rel"))` | GROUP BY |
| Fewer columns | `only()` / `defer()` / `values()` | narrower SELECT |
| Huge scans | `iterator(chunk_size=2000)` | server-side cursor |
| Many inserts | `bulk_create(batch_size=...)` | multi-row INSERT |
| Many different updates | `bulk_update(objs, fields)` | UPDATE … CASE WHEN |
| Same update for a set | `filter(...).update(f=F("f")+1)` | single UPDATE |
| Presence | `exists()` | SELECT 1 … LIMIT 1 |
| Plan | `qs.explain(analyze=True)` | EXPLAIN ANALYZE |

- N+1 = constant per-row queries; the test is "query count independent of row count".
- `select_related` = JOIN for single-valued; `prefetch_related` = IN query for multi-valued.
- Manager `.filter()`/`.order_by()`/`.first()` after prefetch = new query.
- `to_attr` lists can't re-query by accident.
- `only()` + deferred access = new N+1; include FKs needed for stitching.
- `bulk_*` and `update()` skip `save()` and signals.
- Pass QuerySets, not lists, into `__in`.
- `iterator()` vs PgBouncer transaction mode: `DISABLE_SERVER_SIDE_CURSORS`.
- Pin every list endpoint with `assertNumQueries`.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" "psycopg[binary]" django-debug-toolbar djangorestframework`, create the §5.1 models, and seed 200 orders × 3 items with 30 products and 10 tags.

1. Render an order list template showing customer email, coupon code, item names and tags. Count queries with the debug toolbar. Fix to ≤ 3 queries.
2. Write `assertNumQueries` tests for the page with 5 and with 50 orders; prove the count is identical.
3. Introduce `o.items.filter(quantity__gt=1)` in the template and watch the prefetch break; fix with `Prefetch(to_attr=...)`.
4. Use `only("id", "name")` on products and access `price` in a loop; count queries; then fix.
5. Import 50,000 rows from a CSV three ways — `create()` loop, `bulk_create(batch_size=1000)`, and `bulk_create(update_conflicts=True, ...)` on a re-run — and time each.
6. Export all orders with `iterator(chunk_size=2000)` while watching process memory (`tracemalloc` or `ps`); compare with `list(Order.objects.all())`.

**Mini project:** build a DRF `OrderViewSet` with nested items, products, tags, customer and computed `item_count`/`total`, keep it at ≤ 4 queries per page regardless of page size, add a custom `OrderQuerySet.for_api()` method (see [Ch 15](topic.html?p=15-managers-model-inheritance)) holding the optimisations, and a test suite that fails if anyone reintroduces N+1.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 09 · Relationships](topic.html?p=09-relationships), [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) (laziness, result cache), [Ch 12 · Aggregation, Annotation, Subqueries](topic.html?p=12-aggregation-annotation-subqueries), [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency), [Ch 15 · Custom Managers, QuerySets & Model Inheritance](topic.html?p=15-managers-model-inheritance), [Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers), [Ch 29 · Caching in Django](topic.html?p=29-caching), [Ch 33 · Testing](topic.html?p=33-testing), [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases).

**Other handbooks:** [SQL · Joins](../sql/topic.html?p=05-joins), [SQL · Indexes](../sql/topic.html?p=19-indexes), [SQL · Query Optimization](../sql/topic.html?p=21-query-optimization), [SQL · Execution Plans](../sql/topic.html?p=22-execution-plans), [Database Design · Bottleneck Diagnosis](../database-design/topic.html?p=23-bottleneck-diagnosis).

- **Database access optimization** — Django docs · *Intermediate* · the official checklist: profile first, use QuerySets correctly, do work in the DB, retrieve only what you need. <https://docs.djangoproject.com/en/5.2/topics/db/optimization/>
- **QuerySet API reference** — Django docs · *Intermediate* · exact semantics of select_related, prefetch_related, Prefetch, only/defer, bulk_*, iterator, explain. <https://docs.djangoproject.com/en/5.2/ref/models/querysets/>
- **django-debug-toolbar** — GitHub · *Beginner* · the SQL panel is the fastest way to see N+1 locally. <https://github.com/django-commons/django-debug-toolbar>
- **nplusone** — GitHub · *Intermediate* · detects lazy loads and unused eager loads in Django tests. <https://github.com/jmcarp/nplusone>
- **Testing tools: assertNumQueries** — Django docs · *Beginner* · pinning query counts in tests. <https://docs.djangoproject.com/en/5.2/topics/testing/tools/>
- **PostgreSQL: Using EXPLAIN** — PostgreSQL docs · *Intermediate* · reading the plans `QuerySet.explain()` returns. <https://www.postgresql.org/docs/current/using-explain.html>

---

*Django Handbook — chapter 13.*
