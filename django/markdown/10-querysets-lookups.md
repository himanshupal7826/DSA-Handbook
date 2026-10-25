# 10 · QuerySets, Lookups, Q & F Expressions

> **In one line:** A QuerySet is a lazy, immutable description of a SQL query that runs only when you ask for its results and then caches them — so writing good ORM code means knowing exactly when a QuerySet is evaluated, how lookups and `Q`/`F` objects compile into the `WHERE` clause, and which methods run a query you did not expect.

---

## 1. Overview

> **Builds on:** [Ch 08 · Models & Fields](topic.html?p=08-models-fields) and [Ch 09 · Relationships](topic.html?p=09-relationships) (the fields and relations you query across). Aggregation and subqueries continue in [Ch 12 · Aggregation, Annotation, Subqueries & Window Functions](topic.html?p=12-aggregation-annotation-subqueries); N+1 and performance tooling in [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization).

Every web request in a Django app ends up asking the database questions: *the 20 most recent published posts*, *orders over 100 from customers in India placed this month*, *does this email already exist?*, *decrement stock by one*. The naive approaches are both bad. Writing raw SQL strings everywhere gives up portability, composability and protection against injection. Loading everything into Python and filtering there (`[o for o in Order.objects.all() if o.total > 100]`) moves millions of rows over the network to discard most of them.

The Django ORM gives you the **QuerySet**: a Python object that *describes* a query and can be refined step by step — `Order.objects.filter(status="paid").exclude(customer__country="US").order_by("-placed_at")[:20]` — without touching the database. Only when you actually need rows (iterate, `list()`, `len()`, `bool()`, print it) does Django compile the description into one SQL statement, execute it, and cache the results on that QuerySet.

That laziness is the source of both the ORM's power and its most common bugs. Power: you can build a query across functions, add filters conditionally, pass it to a template, and still send a single, precise `SELECT`. Bugs: a QuerySet evaluated twice runs twice; `if qs:` loads every row just to check emptiness; a "small" `print(qs)` in production fetches 21 rows; `obj.balance = obj.balance - 10; obj.save()` races with other requests where `F("balance") - 10` would not. Interviewers love this territory — "are QuerySets lazy?", "get vs filter", "Q vs F", "exists vs count", "what does this generate in SQL?" — because the answers reveal whether you understand what your code sends to the database.

## 2. Core Concepts

- **QuerySet** — a lazy, chainable representation of a query over one model. Each method like `filter()` returns a **new** QuerySet (a clone). *Why it matters:* building is free; evaluation is the cost.
- **Manager** — the entry point (`Model.objects`) that hands out QuerySets. *Why it matters:* custom managers change the default starting query ([Ch 15](topic.html?p=15-managers-model-inheritance)).
- **Evaluation** — the moment SQL runs: iteration, `list()`, `len()`, `bool()`, `repr()`, slicing with a step, pickling, `x in qs`. *Why it matters:* everything before that is just Python object construction.
- **Result cache** — `qs._result_cache`, filled by `_fetch_all()` on first evaluation; later iterations of the *same* QuerySet object reuse it. *Why it matters:* reuse the evaluated object; a new chain (`qs.all()`, `qs.filter()`) means a new query.
- **Lookup** — the `__op` suffix in a filter keyword: `exact`, `iexact`, `contains`, `icontains`, `in`, `gt`, `gte`, `lt`, `lte`, `startswith`, `endswith`, `range`, `isnull`, `regex`. The default is `exact`.
- **Transform** — a suffix that changes the value before the lookup: `__date`, `__year`, `__month`, `__lower`, `__len` (on some fields). Chainable: `placed_at__date__gte`.
- **Spanning relations** — `__` follows relationships and becomes JOINs: `customer__country__code="IN"`.
- **`Q` object** — encapsulates a condition so you can combine with `|` (OR), `&` (AND), `~` (NOT), `^` (XOR, 4.2+). *Why it matters:* keyword arguments can only express AND.
- **`F` expression** — a reference to a column's value **in the database**, used in filters, updates and annotations. *Why it matters:* compare two columns, or update atomically without a read-modify-write race.
- **`values()` / `values_list()`** — return dicts / tuples instead of model instances (`flat=True` for one field, `named=True` for namedtuples). *Why it matters:* cheaper, and the gateway to `GROUP BY`.
- **`get()`** — exactly one object or an exception (`DoesNotExist`, `MultipleObjectsReturned`).
- **`exists()` / `count()`** — `SELECT 1 ... LIMIT 1` vs `SELECT COUNT(*)`: presence check vs number.
- **`iterator()`** — streams rows without filling the result cache, using server-side cursors on PostgreSQL. *Why it matters:* bounded memory for large scans.
- **`sql.Query` / `SQLCompiler`** — the internal objects that hold the query tree and turn it into SQL. *Why it matters:* `str(qs.query)` and `qs.explain()` are how you inspect what will run.

## 3. Theory & Principles

### Laziness, cloning and evaluation — step by step

```python
qs = Order.objects.filter(status="paid")      # 1. no SQL
qs = qs.exclude(total__lt=10)                  # 2. no SQL (new clone)
qs = qs.order_by("-placed_at")                 # 3. no SQL
first_page = qs[:20]                           # 4. no SQL: adds LIMIT 20
for order in first_page:                       # 5. SQL runs NOW, once
    ...
for order in first_page:                       # 6. no SQL: result cache
    ...
```

Internally, a `QuerySet` wraps a `django.db.models.sql.Query` object (`qs.query`) — a tree of the model, joins (`alias_map`), the `where` node, ordering, limits and selected columns. `filter(**kwargs)` calls `_filter_or_exclude()`, which **clones** the QuerySet (`_chain()` → `_clone()`, copying the `Query`) and calls `query.add_q(Q(**kwargs))`. `add_q` resolves each keyword: it splits `customer__country__code` on `__`, walks `_meta` to find relations (`setup_joins`, adding JOINs to the alias map), finds the final field, applies any transforms, picks the lookup class (`Exact`, `IContains`, `GreaterThan`…) and adds it to the `WhereNode`. Nothing is sent to the database.

Evaluation goes through `_fetch_all()`: if `_result_cache` is `None`, it does `self._result_cache = list(self._iterable_class(self))`. The default iterable is `ModelIterable`, which calls `query.get_compiler(using).execute_sql()`; `SQLCompiler.as_sql()` renders the tree into SQL text with `%s` placeholders and a separate params list (the driver substitutes them safely — this is why ORM filters are immune to SQL injection), and `ModelIterable` turns each row into an instance via `Model.from_db()`. `values()` swaps in `ValuesIterable`; `values_list()` uses `ValuesListIterable` or `FlatValuesListIterable`.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj10a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj10b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">A QuerySet's life: build lazily, evaluate once, cache</text>
  <rect x="20" y="44" width="840" height="110" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#1e40af" font-weight="bold">BUILD phase &#8212; pure Python, zero queries; every call returns a clone</text>
  <rect x="36" y="78" width="170" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="121" y="98" text-anchor="middle" fill="#1e293b" font-weight="bold">Order.objects</text>
  <text x="121" y="114" text-anchor="middle" fill="#334155" font-size="9">Manager.get_queryset()</text>
  <text x="121" y="128" text-anchor="middle" fill="#334155" font-size="9">Query(model=Order)</text>
  <path d="M208,108 L232,108" stroke="#2563eb" stroke-width="2" marker-end="url(#dj10a)"/>
  <rect x="234" y="78" width="190" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="329" y="98" text-anchor="middle" fill="#1e293b" font-weight="bold">.filter(customer__country="IN")</text>
  <text x="329" y="114" text-anchor="middle" fill="#334155" font-size="9">_chain() + query.add_q(Q(...))</text>
  <text x="329" y="128" text-anchor="middle" fill="#334155" font-size="9">setup_joins &#8594; JOIN; lookup &#8594; WhereNode</text>
  <path d="M426,108 L450,108" stroke="#2563eb" stroke-width="2" marker-end="url(#dj10a)"/>
  <rect x="452" y="78" width="180" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="542" y="98" text-anchor="middle" fill="#1e293b" font-weight="bold">.order_by("-placed_at")</text>
  <text x="542" y="114" text-anchor="middle" fill="#334155" font-size="9">query.order_by = (...)</text>
  <text x="542" y="128" text-anchor="middle" fill="#334155" font-size="9">still no SQL</text>
  <path d="M634,108 L658,108" stroke="#2563eb" stroke-width="2" marker-end="url(#dj10a)"/>
  <rect x="660" y="78" width="184" height="60" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="752" y="98" text-anchor="middle" fill="#1e293b" font-weight="bold">[:20]</text>
  <text x="752" y="114" text-anchor="middle" fill="#334155" font-size="9">query.set_limits(0, 20)</text>
  <text x="752" y="128" text-anchor="middle" fill="#334155" font-size="9">LIMIT 20 (no negative index)</text>
  <path d="M440,156 L440,180" stroke="#2563eb" stroke-width="2" marker-end="url(#dj10a)"/>
  <rect x="20" y="182" width="840" height="70" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="440" y="202" text-anchor="middle" fill="#92400e" font-weight="bold">EVALUATION triggers &#8212; _fetch_all() runs only if _result_cache is None</text>
  <text x="440" y="222" text-anchor="middle" fill="#b45309" font-size="10">for x in qs &#183; list(qs) &#183; len(qs) &#183; bool(qs) / if qs &#183; repr(qs) (LIMIT 21) &#183; qs[::2] &#183; pickle &#183; x in qs</text>
  <text x="440" y="240" text-anchor="middle" fill="#b45309" font-size="10">NOT triggers: filter/exclude/order_by/annotate/values, qs[:20], qs.query  &#183;  own query: count(), exists(), get(), first()</text>
  <path d="M440,254 L440,278" stroke="#2563eb" stroke-width="2" marker-end="url(#dj10a)"/>
  <rect x="20" y="280" width="270" height="76" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="155" y="302" text-anchor="middle" fill="#5b21b6" font-weight="bold">SQLCompiler.as_sql()</text>
  <text x="155" y="322" text-anchor="middle" fill="#1e293b" font-size="10">SQL text with %s placeholders</text>
  <text x="155" y="340" text-anchor="middle" fill="#1e293b" font-size="10">+ params list &#8594; driver (no injection)</text>
  <path d="M292,318 L316,318" stroke="#2563eb" stroke-width="2" marker-end="url(#dj10a)"/>
  <rect x="318" y="280" width="250" height="76" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="443" y="302" text-anchor="middle" fill="#5b21b6" font-weight="bold">ModelIterable</text>
  <text x="443" y="322" text-anchor="middle" fill="#1e293b" font-size="10">rows &#8594; Model.from_db() instances</text>
  <text x="443" y="340" text-anchor="middle" fill="#1e293b" font-size="10">(ValuesIterable for values())</text>
  <path d="M570,318 L594,318" stroke="#16a34a" stroke-width="2" marker-end="url(#dj10b)"/>
  <rect x="596" y="280" width="264" height="76" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="728" y="302" text-anchor="middle" fill="#14532d" font-weight="bold">qs._result_cache = [...]</text>
  <text x="728" y="322" text-anchor="middle" fill="#166534" font-size="10">re-iterate same object: 0 queries</text>
  <text x="728" y="340" text-anchor="middle" fill="#166534" font-size="10">qs.all() / qs.filter(): NEW query</text>
  <rect x="20" y="370" width="840" height="38" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="393" text-anchor="middle" fill="#334155" font-size="10">iterator(chunk_size=N) bypasses the cache and streams with a server-side cursor on PostgreSQL &#8212; constant memory for big scans</text>
</svg>
```

### Methods that query on their own

Some methods do not evaluate the QuerySet but **run their own query** immediately:

| Method | SQL (PostgreSQL) | Notes |
|---|---|---|
| `count()` | `SELECT COUNT(*) AS "__count" FROM ...` | If the QuerySet is already evaluated, returns `len(_result_cache)` without a query |
| `exists()` | `SELECT 1 AS "a" FROM ... LIMIT 1` | Cheapest presence test; uses cache if evaluated |
| `get(...)` | `SELECT ... WHERE ... LIMIT 21` | Limit lets Django report "returned more than one (it returned 21!)" without fetching millions |
| `first()` / `last()` | `ORDER BY "id" ASC/DESC LIMIT 1` if unordered | Returns `None` if empty, never raises |
| `in_bulk(ids)` | `WHERE id IN (...)` | Returns `{pk: obj}` |
| `aggregate(...)` | `SELECT SUM(...) ...` | Returns a dict ([Ch 12](topic.html?p=12-aggregation-annotation-subqueries)) |
| `update(...)` / `delete()` | `UPDATE ...` / collector + `DELETE` | Bulk; skip `save()` (update) |
| `contains(obj)` (4.0+) | `SELECT 1 ... WHERE pk = %s LIMIT 1` | Membership without loading all rows |

### Lookups and how they become SQL

| Filter | PostgreSQL SQL fragment |
|---|---|
| `title="Dune"` / `title__exact="Dune"` | `"title" = 'Dune'` |
| `title__iexact="dune"` | `UPPER("title"::text) = UPPER('dune')` |
| `title__icontains="dun"` | `UPPER("title"::text) LIKE UPPER('%dun%')` |
| `title__startswith="Du"` | `"title"::text LIKE 'Du%'` |
| `price__gte=10` | `"price" >= 10` |
| `id__in=[1, 2, 3]` | `"id" IN (1, 2, 3)` |
| `price__range=(10, 20)` | `"price" BETWEEN 10 AND 20` |
| `deleted_at__isnull=True` / `deleted_at=None` | `"deleted_at" IS NULL` |
| `placed_at__year=2026` | `"placed_at" BETWEEN '2026-01-01 00:00:00+00' AND '2026-12-31 23:59:59.999999+00'` |
| `placed_at__date=date(2026, 10, 25)` | `("placed_at" AT TIME ZONE 'UTC')::date = '2026-10-25'` |
| `customer__country__code="IN"` | `INNER JOIN customer ... INNER JOIN country ... WHERE country.code = 'IN'` |

Note the contrast between `__year` (rewritten into an index-friendly `BETWEEN`) and `__date` (wraps the column in a cast, which a plain B-tree index on `placed_at` cannot use). `id__in=[]` short-circuits to an empty result without querying (`EmptyResultSet`).

### Q objects: building boolean logic

Keyword arguments to `filter()` are ANDed. For OR and NOT you wrap conditions in `Q`:

```python
from django.db.models import Q

Order.objects.filter(Q(status="paid") | Q(status="shipped"), total__gte=100)
Order.objects.filter(~Q(customer__country__code="US"))
Order.objects.filter(Q(is_gift=True) ^ Q(gift_note=""))              # XOR, 4.2+
```

```sql
WHERE (("shop_order"."status" = 'paid' OR "shop_order"."status" = 'shipped')
       AND "shop_order"."total" >= 100)
```

A `Q` is a tree node (`django.utils.tree.Node`) with a connector (`AND`/`OR`/`XOR`), a `negated` flag and children. `add_q` compiles it recursively into a `WhereNode` with the same shape. Positional `Q` arguments must come **before** keyword arguments in the call. You can build them dynamically:

```python
import operator
from functools import reduce

terms = ["linen", "shirt"]
cond = reduce(operator.and_, (Q(title__icontains=t) | Q(description__icontains=t) for t in terms))
Product.objects.filter(cond)
```

### F expressions: the database's view of a column

`F("field")` refers to the column value at the moment the database evaluates the statement, not the value in your Python object:

```python
from django.db.models import F

Product.objects.filter(sale_price__lt=F("price") * 0.8)       # compare two columns
Product.objects.filter(pk=7).update(stock=F("stock") - 1)     # atomic decrement
Order.objects.annotate(net=F("subtotal") - F("discount"))     # computed column
Order.objects.filter(shipped_at__gt=F("placed_at") + timedelta(days=3))
Order.objects.order_by(F("shipped_at").desc(nulls_last=True))
```

```sql
UPDATE "catalog_product" SET "stock" = ("catalog_product"."stock" - 1) WHERE "catalog_product"."id" = 7;
```

The update is a single statement executed atomically by the database, so 50 concurrent requests decrement 50 times. The read-modify-write alternative (`p.stock -= 1; p.save()`) loses updates when requests interleave — and also writes every other column back ([Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency)). After assigning an `F()` to an instance attribute and saving, the attribute holds the expression object, not a number: call `refresh_from_db()` before reading it, and do not save twice (the expression would be applied again).

```svg
<svg viewBox="0 0 880 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj10c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two requests decrement stock=10: read-modify-write vs F()</text>
  <rect x="20" y="44" width="410" height="300" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="225" y="66" text-anchor="middle" fill="#991b1b" font-size="12" font-weight="bold">p.stock -= 1; p.save()  &#8212; lost update</text>
  <text x="100" y="90" text-anchor="middle" fill="#1e293b" font-weight="bold">Request A</text>
  <text x="340" y="90" text-anchor="middle" fill="#1e293b" font-weight="bold">Request B</text>
  <rect x="40" y="104" width="130" height="30" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="105" y="123" text-anchor="middle" fill="#7f1d1d" font-size="10">SELECT &#8594; stock=10</text>
  <rect x="280" y="144" width="130" height="30" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="345" y="163" text-anchor="middle" fill="#7f1d1d" font-size="10">SELECT &#8594; stock=10</text>
  <rect x="40" y="184" width="130" height="30" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="105" y="203" text-anchor="middle" fill="#7f1d1d" font-size="10">UPDATE stock=9</text>
  <rect x="280" y="224" width="130" height="30" rx="5" fill="#fee2e2" stroke="#dc2626"/><text x="345" y="243" text-anchor="middle" fill="#7f1d1d" font-size="10">UPDATE stock=9</text>
  <path d="M225,100 L225,262" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 3"/>
  <text x="225" y="290" text-anchor="middle" fill="#991b1b" font-weight="bold">Final stock = 9 (should be 8)</text>
  <text x="225" y="310" text-anchor="middle" fill="#7f1d1d" font-size="10">both computed 10 - 1 in Python from a stale read;</text>
  <text x="225" y="326" text-anchor="middle" fill="#7f1d1d" font-size="10">save() also rewrites every other column</text>
  <rect x="450" y="44" width="410" height="300" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="655" y="66" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">update(stock=F("stock") - 1)  &#8212; atomic</text>
  <text x="530" y="90" text-anchor="middle" fill="#1e293b" font-weight="bold">Request A</text>
  <text x="770" y="90" text-anchor="middle" fill="#1e293b" font-weight="bold">Request B</text>
  <rect x="465" y="104" width="160" height="40" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="545" y="120" text-anchor="middle" fill="#14532d" font-size="10">UPDATE SET stock =</text><text x="545" y="134" text-anchor="middle" fill="#14532d" font-size="10">stock - 1 &#8594; 9 (row lock)</text>
  <rect x="690" y="164" width="160" height="40" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="770" y="180" text-anchor="middle" fill="#14532d" font-size="10">waits for A's lock, then</text><text x="770" y="194" text-anchor="middle" fill="#14532d" font-size="10">stock - 1 &#8594; 8</text>
  <path d="M627,140 L688,176" stroke="#334155" stroke-width="2" marker-end="url(#dj10c)"/>
  <path d="M655,100 L655,262" stroke="#94a3b8" stroke-width="1" stroke-dasharray="4 3"/>
  <text x="655" y="236" text-anchor="middle" fill="#166534" font-size="10">add filter(stock__gt=0) to never go negative:</text>
  <text x="655" y="252" text-anchor="middle" fill="#166534" font-size="10">update() returns rows changed (0 = sold out)</text>
  <text x="655" y="290" text-anchor="middle" fill="#15803d" font-weight="bold">Final stock = 8</text>
  <text x="655" y="310" text-anchor="middle" fill="#166534" font-size="10">arithmetic happens inside the DB statement;</text>
  <text x="655" y="326" text-anchor="middle" fill="#166534" font-size="10">no stale Python value involved</text>
</svg>
```

## 4. Architecture & Workflow

### Spanning multi-valued relations: one `filter()` or two?

This is the most misunderstood rule in the ORM. For **single-valued** relations (forward FK/O2O) it makes no difference. For **multi-valued** relations (reverse FK, M2M), conditions inside **one** `filter()` call must be satisfied by the **same** related row; conditions in **separate chained** `filter()` calls may be satisfied by **different** related rows, because each call adds its own JOIN.

```python
# Blogs that have an entry which is BOTH about Lennon AND from 2008
Blog.objects.filter(entry__headline__contains="Lennon", entry__pub_date__year=2008)

# Blogs that have an entry about Lennon, and an entry (maybe another) from 2008
Blog.objects.filter(entry__headline__contains="Lennon").filter(entry__pub_date__year=2008)
```

```sql
-- one filter(): single JOIN, both conditions on the same entry row
SELECT "blog"."id", ... FROM "blog"
INNER JOIN "entry" ON ("blog"."id" = "entry"."blog_id")
WHERE ("entry"."headline"::text LIKE '%Lennon%'
       AND "entry"."pub_date" BETWEEN '2008-01-01' AND '2008-12-31');

-- chained filter(): two JOINs (T3 is a second alias of entry)
SELECT "blog"."id", ... FROM "blog"
INNER JOIN "entry" ON ("blog"."id" = "entry"."blog_id")
INNER JOIN "entry" T3 ON ("blog"."id" = T3."blog_id")
WHERE ("entry"."headline"::text LIKE '%Lennon%'
       AND T3."pub_date" BETWEEN '2008-01-01' AND '2008-12-31');
```

`exclude()` over multi-valued relations is different again: `Blog.objects.exclude(entry__headline__contains="Lennon", entry__pub_date__year=2008)` does **not** mean "exclude blogs having one entry matching both"; Django builds a subquery per condition. When you need precise semantics, write an explicit `Exists()`/`~Exists()` subquery ([Ch 12](topic.html?p=12-aggregation-annotation-subqueries)). Also remember that both forms can return a blog **multiple times** (one row per matching entry) — add `.distinct()` or use `Exists`.

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Multi-valued relations: same row (one filter) vs any rows (chained filters)</text>
  <rect x="20" y="40" width="250" height="150" rx="10" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="145" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Blog "Beatles Daily" entries</text>
  <rect x="36" y="76" width="218" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="145" y="92" text-anchor="middle" fill="#1e293b" font-size="10">E1: "Lennon tribute"</text>
  <text x="145" y="108" text-anchor="middle" fill="#334155" font-size="10">pub 2005</text>
  <rect x="36" y="126" width="218" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="145" y="142" text-anchor="middle" fill="#1e293b" font-size="10">E2: "McCartney tour"</text>
  <text x="145" y="158" text-anchor="middle" fill="#334155" font-size="10">pub 2008</text>
  <rect x="290" y="40" width="270" height="150" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="425" y="62" text-anchor="middle" fill="#991b1b" font-weight="bold">filter(headline~Lennon, year=2008)</text>
  <text x="306" y="88" fill="#7f1d1d" font-size="10">one JOIN alias &#8594; the SAME entry row</text>
  <text x="306" y="106" fill="#7f1d1d" font-size="10">must match both conditions</text>
  <text x="306" y="128" fill="#7f1d1d" font-size="10">E1: Lennon but 2005 &#10007;</text>
  <text x="306" y="146" fill="#7f1d1d" font-size="10">E2: 2008 but not Lennon &#10007;</text>
  <text x="306" y="174" fill="#991b1b" font-weight="bold">Blog NOT returned</text>
  <rect x="580" y="40" width="280" height="150" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="720" y="62" text-anchor="middle" fill="#14532d" font-weight="bold">filter(headline~Lennon).filter(year=2008)</text>
  <text x="596" y="88" fill="#166534" font-size="10">two JOIN aliases (entry, T3)</text>
  <text x="596" y="106" fill="#166534" font-size="10">each condition may use a different row</text>
  <text x="596" y="128" fill="#166534" font-size="10">entry = E1 matches Lennon &#10003;</text>
  <text x="596" y="146" fill="#166534" font-size="10">T3 = E2 matches 2008 &#10003;</text>
  <text x="596" y="174" fill="#14532d" font-weight="bold">Blog returned</text>
  <rect x="20" y="208" width="840" height="108" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="440" y="230" text-anchor="middle" fill="#1e293b" font-weight="bold">Rules of thumb</text>
  <text x="36" y="252" fill="#334155" font-size="10">Forward FK / O2O (single-valued): one or many filter() calls are equivalent &#8212; the join is reused.</text>
  <text x="36" y="272" fill="#334155" font-size="10">Reverse FK / M2M: conditions that must hold on the same child go in ONE filter() (or one Q, or an Exists subquery).</text>
  <text x="36" y="292" fill="#334155" font-size="10">Either way you may get duplicate parents (one per matching child): add .distinct() or use Exists(...).</text>
  <text x="36" y="308" fill="#334155" font-size="10">exclude() across multi-valued relations is subtle; prefer ~Exists(...) for exact semantics.</text>
</svg>
```

### Choosing the right retrieval method

```text
Need exactly one row or an error?           → get()                (DoesNotExist / MultipleObjectsReturned)
Need one row or None?                       → filter(...).first()  (adds ORDER BY pk if unordered)
Need one row by unique key in a view?       → get_object_or_404(Model, ...)
Need to know "is there any?"                → exists()             (but if you'll use the rows anyway, just evaluate)
Need a number?                              → count()              (or len(qs) if you already evaluated it)
Need just a few columns?                    → values() / values_list(flat=True)
Need many rows with bounded memory?         → iterator(chunk_size=2000)
Need rows by a list of ids?                 → in_bulk(ids)
Create if missing?                          → get_or_create() / update_or_create()  (needs a unique constraint to be race-safe)
```

## 5. Implementation

### Simple example: exploring in the shell

```python
# catalog/models.py
from django.db import models


class Category(models.Model):
    name = models.CharField(max_length=80)


class Product(models.Model):
    category = models.ForeignKey(Category, on_delete=models.PROTECT, related_name="products")
    title = models.CharField(max_length=200)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    sale_price = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    stock = models.PositiveIntegerField(default=0)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
```

```python
>>> from django.db import connection, reset_queries
>>> from django.db.models import Q, F
>>> qs = Product.objects.filter(is_active=True, price__lt=50).order_by("price")
>>> print(qs.query)              # no query executed; approximate SQL with params inlined
SELECT "catalog_product"."id", ... FROM "catalog_product"
WHERE ("catalog_product"."is_active" AND "catalog_product"."price" < 50) ORDER BY "catalog_product"."price" ASC
>>> reset_queries()
>>> bool(qs); len(qs); list(qs)  # first bool() evaluates; len/list reuse the cache
>>> len(connection.queries)
1
>>> qs.count()                   # already evaluated → len(cache), no query
>>> Product.objects.filter(is_active=True).count()   # fresh QuerySet → SELECT COUNT(*)
>>> Product.objects.values_list("title", flat=True)[:3]
<QuerySet ['Linen shirt', 'Wool scarf', 'Canvas tote']>
>>> Product.objects.values("id", "category__name")[:2]
<QuerySet [{'id': 1, 'category__name': 'Shirts'}, {'id': 2, 'category__name': 'Scarves'}]>
>>> Product.objects.get(pk=999)
Product.DoesNotExist: Product matching query does not exist.
>>> Product.objects.get(category__name="Shirts")
Product.MultipleObjectsReturned: get() returned more than one Product -- it returned 3!
```

The SQL for that `get()` — note the limit and that a single `get()` on a non-unique condition still fetches only up to 21 rows:

```sql
SELECT "catalog_product"."id", "catalog_product"."category_id", "catalog_product"."title", ...
FROM "catalog_product"
INNER JOIN "catalog_category" ON ("catalog_product"."category_id" = "catalog_category"."id")
WHERE "catalog_category"."name" = 'Shirts'
LIMIT 21;
```

### Real-world example: a product search endpoint

Requirements: filter by optional query text, category ids, price range, "on sale only" (sale price below price), "in stock"; exclude discontinued; sort by a whitelisted field; paginate; and provide a "buy" operation that decrements stock safely.

```python
# catalog/services.py
from decimal import Decimal
from django.db import transaction
from django.db.models import F, Q, QuerySet
from .models import Product

ALLOWED_SORTS = {"price": "price", "-price": "-price", "new": "-created_at", "title": "title"}


def search_products(*, text: str = "", category_ids: list[int] | None = None,
                    min_price: Decimal | None = None, max_price: Decimal | None = None,
                    on_sale: bool = False, in_stock: bool = False,
                    sort: str = "new") -> QuerySet[Product]:
    qs = Product.objects.filter(is_active=True).select_related("category")

    if text:
        for term in text.split()[:5]:                       # cap terms: each one adds conditions
            qs = qs.filter(Q(title__icontains=term) | Q(category__name__icontains=term))
    if category_ids:
        qs = qs.filter(category_id__in=category_ids)         # *_id: no join needed
    if min_price is not None:
        qs = qs.filter(price__gte=min_price)
    if max_price is not None:
        qs = qs.filter(price__lte=max_price)
    if on_sale:
        qs = qs.filter(sale_price__isnull=False, sale_price__lt=F("price"))
    if in_stock:
        qs = qs.filter(stock__gt=0)

    return qs.order_by(ALLOWED_SORTS.get(sort, "-created_at"), "pk")   # pk tiebreak = stable pages


class OutOfStock(Exception):
    pass


def buy(product_id: int, qty: int = 1) -> None:
    with transaction.atomic():
        updated = (Product.objects
                   .filter(pk=product_id, stock__gte=qty, is_active=True)
                   .update(stock=F("stock") - qty))
        if updated == 0:
            raise OutOfStock(product_id)
        # create the order line here, in the same transaction
```

```python
# catalog/views.py
from django.core.paginator import Paginator
from django.http import JsonResponse
from .services import search_products


def product_search(request):
    params = request.GET
    qs = search_products(
        text=params.get("q", ""),
        category_ids=[int(c) for c in params.getlist("category") if c.isdigit()],
        on_sale=params.get("on_sale") == "1",
        in_stock=params.get("in_stock") == "1",
        sort=params.get("sort", "new"),
    )
    page = Paginator(qs.values("id", "title", "price", "sale_price", "category__name"), 24) \
        .get_page(params.get("page"))
    return JsonResponse({"results": list(page.object_list), "num_pages": page.paginator.num_pages})
```

A request for `?q=linen&category=3&on_sale=1&in_stock=1&sort=price&page=2` produces exactly two queries — the paginator's count and the page:

```sql
SELECT COUNT(*) AS "__count"
FROM "catalog_product"
INNER JOIN "catalog_category" ON ("catalog_product"."category_id" = "catalog_category"."id")
WHERE ("catalog_product"."is_active"
       AND (UPPER("catalog_product"."title"::text) LIKE UPPER('%linen%')
            OR UPPER("catalog_category"."name"::text) LIKE UPPER('%linen%'))
       AND "catalog_product"."category_id" IN (3)
       AND "catalog_product"."sale_price" IS NOT NULL
       AND "catalog_product"."sale_price" < ("catalog_product"."price")
       AND "catalog_product"."stock" > 0);

SELECT "catalog_product"."id", "catalog_product"."title", "catalog_product"."price",
       "catalog_product"."sale_price", "catalog_category"."name" AS "category__name"
FROM "catalog_product"
INNER JOIN "catalog_category" ON ("catalog_product"."category_id" = "catalog_category"."id")
WHERE ( ...same conditions... )
ORDER BY "catalog_product"."price" ASC, "catalog_product"."id" ASC
LIMIT 24 OFFSET 24;
```

And `buy()` is a single conditional, atomic statement — no read, no race, no negative stock:

```sql
UPDATE "catalog_product" SET "stock" = ("catalog_product"."stock" - 1)
WHERE ("catalog_product"."id" = 7 AND "catalog_product"."is_active" AND "catalog_product"."stock" >= 1);
```

> **Production story:** the sort parameter is whitelisted. Passing user input straight into `order_by()` lets clients sort by any field, including across relations (`order_by("customer__password")`) — an information leak and a way to force expensive sorts.

### Large exports with `iterator()`

```python
import csv

def export_products(fileobj):
    writer = csv.writer(fileobj)
    rows = (Product.objects.filter(is_active=True)
            .values_list("id", "title", "price")
            .order_by("pk")
            .iterator(chunk_size=5000))       # server-side cursor; no result cache
    for row in rows:
        writer.writerow(row)
```

On PostgreSQL `iterator()` uses a named server-side cursor and fetches `chunk_size` rows at a time (default 2000), keeping memory flat. Behind PgBouncer in transaction pooling mode, server-side cursors break — set `DISABLE_SERVER_SIDE_CURSORS = True` for that database ([Ch 34](topic.html?p=34-scaling-databases)). Since 4.1, `prefetch_related()` works with `iterator()` when you pass `chunk_size`.

### `get_or_create` and its race

```python
tag, created = Tag.objects.get_or_create(slug="django", defaults={"label": "Django"})
```

It runs `SELECT ... LIMIT 21`; if nothing is found it `INSERT`s inside a savepoint; if the insert raises `IntegrityError` (another request inserted first) it retries the `get()`. That retry only works if a **unique constraint** on `slug` exists — without one, two concurrent calls happily create duplicates. `update_or_create()` locks the found row with `select_for_update()` before updating.

## 6. Advantages, Disadvantages & Trade-offs

| Technique | Strength | Cost / Risk |
|---|---|---|
| Lazy chaining | Compose queries across functions; one SQL statement | Hidden evaluation points; repeated evaluation if you rebuild |
| Result cache | Free re-iteration of the same object | Memory for large results; stale if data changes |
| `values()` / `values_list()` | Less data, no model instantiation | No model methods/properties; dicts leak into templates |
| `Q` objects | OR/NOT/XOR, dynamic conditions | Complex ORs may defeat indexes (consider UNION) |
| `F` expressions | DB-side computation; atomic updates | Instance attribute becomes an expression until `refresh_from_db()` |
| `update()` | One statement, no race | Skips `save()`, signals, `auto_now` |
| `iterator()` | Constant memory | No cache; server-side cursors vs PgBouncer |
| `icontains` search | Simple | `LIKE '%x%'` = sequential scan without trigram index |
| Raw SQL | Anything the DB can do | Lose composability; injection risk if you format strings ([Ch 16](topic.html?p=16-database-features-postgres)) |

### When to use
- The ORM for essentially all CRUD and reporting queries; it composes, parameterises and is readable.
- `F()` for any counter, balance, stock or "column vs column" comparison.
- `values_list(flat=True)` for id lists, `exists()` for guards, `iterator()` for exports and batch jobs.

### When NOT to use
- Row-by-row Python loops to compute what one `update()` or aggregate could do.
- `exists()` followed by evaluating the same QuerySet — just evaluate it and check the result.
- The ORM for very complex analytical SQL (recursive CTEs, vendor-specific features) where `raw()` or a database view is clearer.

## 7. Common Mistakes & Best Practices

**1. Evaluating to check emptiness.**

```python
# Before: loads every matching row just to test truthiness
if Order.objects.filter(customer=user, status="pending"):
    ...
# After
if Order.objects.filter(customer=user, status="pending").exists():
    ...
```

But if you are going to use the rows, evaluate once and check the list — `exists()` plus iteration is two queries.

**2. `len(qs)` to count.** Loads all rows. Use `count()` — unless the QuerySet is already evaluated, in which case `len()` is free and `count()` uses the cache anyway.

**3. Re-creating QuerySets in templates/loops.** `{% if user.orders.all %}…{% for o in user.orders.all %}` runs two queries, because each `.all` is a fresh QuerySet. Assign once in the view (or use `{% with %}`).

**4. Read-modify-write counters.** `post.views += 1; post.save()` loses increments under load. Use `Post.objects.filter(pk=post.pk).update(views=F("views") + 1)`.

**5. Using the object after an F assignment.**

```python
product.stock = F("stock") - 1
product.save()
print(product.stock)          # CombinedExpression(...), not a number
product.refresh_from_db(fields=["stock"])
```

**6. Negative indexing / filtering after slicing.** `qs[-1]` raises (`Negative indexing is not supported.`); use `qs.order_by("-pk")[0]` or `last()`. `qs[:10].filter(...)` raises `TypeError: Cannot filter a query once a slice has been taken.` — filter first, slice last.

**7. Expecting `filter(x=None)` and `exclude(x=value)` to behave like Python.** `exclude(status="paid")` does **not** return rows where `status` IS NULL in plain SQL semantics — Django adds an `IS NOT NULL` guard for nullable columns so they are included, which surprises people writing raw SQL equivalents. Be explicit with `Q(status__isnull=True) | ~Q(status="paid")` when it matters.

**8. Using `get()` with a non-unique filter.** Works in testing, raises `MultipleObjectsReturned` in production when duplicates appear. Use `get()` only with unique conditions; otherwise `filter().first()` with an explicit order.

**9. Unordered pagination.** Paginating a QuerySet without `order_by()` gives nondeterministic pages (rows repeated or skipped); Django warns with `UnorderedObjectListWarning`. Always order, with a unique tiebreaker.

**10. Dangerous dynamic filters.** `Model.objects.filter(**request.GET.dict())` lets clients filter on any field and relation (`user__password__startswith=`), a classic data-leak bug. Whitelist filterable fields (django-filter does this well; [Ch 24](topic.html?p=24-drf-pagination-filtering-versioning)).

## 8. Production: Pitfalls, Debugging & Scaling

**Accidental full evaluation.** A view calls `if queryset:` on a 2-million-row table before paginating; memory jumps by gigabytes and the worker is OOM-killed. Root cause: `bool()` evaluates the whole QuerySet. Fix: `exists()` or paginate first. Similar traps: `list(qs)` in a helper "for convenience", `random.choice(qs)` (calls `len()`), `qs in some_set`, and logging `repr(qs)` (fetches 21 rows on every log line).

**Leading-wildcard searches.** `icontains` becomes `UPPER(col) LIKE UPPER('%x%')`; on a large table it is a sequential scan. Fix: `pg_trgm` GIN index with `django.contrib.postgres` (`GinIndex(OpClass(Upper("title"), name="gin_trgm_ops"))` to match the `UPPER(...)` expression), or full-text search ([Ch 16](topic.html?p=16-database-features-postgres)).

**`__date` and functions on indexed columns.** `filter(placed_at__date=today)` casts the column and cannot use a B-tree index on `placed_at`. Rewrite as a range: `placed_at__gte=start, placed_at__lt=end`. `__year` is already rewritten into a range by Django.

**Huge `IN` lists.** `filter(id__in=list_of_100k_ids)` creates a giant statement, slow to parse and plan. Fix: pass a subquery instead of a list (`filter(id__in=Other.objects.filter(...).values("id"))` stays in SQL), batch, or join.

**OR across tables defeats indexes.** `Q(title__icontains=x) | Q(category__name__icontains=x)` often forces a scan. For hot paths, split into two indexed queries combined with `union()`, or denormalise a search column.

**Debugging tools.**

```python
print(qs.query)                          # approximate SQL (params inlined, not quoted reliably)
print(qs.explain(analyze=True))          # PostgreSQL EXPLAIN ANALYZE — actually runs the query
from django.db import connection
connection.queries[-3:]                  # last statements (DEBUG=True only)
```

```python
# settings.py — log every SQL statement in development
LOGGING = {
    "version": 1,
    "handlers": {"console": {"class": "logging.StreamHandler"}},
    "loggers": {"django.db.backends": {"handlers": ["console"], "level": "DEBUG"}},
}
```

In tests, `with self.assertNumQueries(2): view(request)` pins the query count so a refactor cannot silently add queries. In production, use slow-query logs (`log_min_duration_statement` in PostgreSQL), `pg_stat_statements`, and APM/Sentry performance traces, which group ORM queries by call site.

**Scaling notes.** Prefer keyset (cursor) pagination over large `OFFSET`s — `OFFSET 100000` still scans and discards 100k rows ([REST API · Pagination](../rest-api/topic.html?p=13-pagination)). Use `.only()`/`values()` to avoid fetching wide columns, and route heavy read queries to replicas with `.using("replica")` when staleness is acceptable ([Ch 34](topic.html?p=34-scaling-databases)).

## 9. Interview Questions

**Q: Are Django QuerySets lazy? When are they evaluated?**
A: Yes. Creating and chaining a QuerySet (`filter`, `exclude`, `order_by`, `annotate`, `values`, slicing without a step) only builds a `sql.Query` object; no SQL runs. It is evaluated when you iterate it, call `list()`, `len()` or `bool()` on it (including `if qs:`), call `repr()` (shell printing, which fetches up to 21 rows), slice with a step, pickle it, or test membership with `in`. On evaluation `_fetch_all()` runs the query once and stores the rows in `_result_cache`. Methods like `count()`, `exists()`, `get()`, `first()`, `aggregate()`, `update()` and `delete()` run their own query immediately.

**Q: What is the QuerySet result cache and when does it not help?**
A: After first evaluation, the rows are stored on that QuerySet instance, so iterating it again, or calling `len()`/`count()`/`exists()` on it, costs no query. It does not help when you create a new QuerySet — `qs.all()`, `qs.filter(...)`, or accessing `obj.related.all()` twice — because each is a clone with an empty cache. Indexing or slicing an *unevaluated* QuerySet runs a LIMIT query and does not populate the cache. `iterator()` deliberately bypasses the cache. So assign the QuerySet to a variable and reuse that object.

**Q: What is the difference between get() and filter()?**
A: `filter()` returns a lazy QuerySet of zero or more objects and never raises for "no results". `get()` executes immediately and returns exactly one model instance; it raises `Model.DoesNotExist` if nothing matches and `Model.MultipleObjectsReturned` if more than one does. Internally `get()` adds `LIMIT 21` so it can report how many matched without fetching millions. Use `get()` with unique conditions (pk, unique fields) and `filter().first()` when "zero or one" is acceptable; in views, `get_object_or_404` turns `DoesNotExist` into a 404.

**Q: What is the difference between Q and F objects?**
A: They solve different problems. A `Q` object encapsulates a filter condition so conditions can be combined with `|` (OR), `&` (AND), `~` (NOT) and `^` (XOR, 4.2+) — keyword arguments alone can only AND. An `F` object refers to a column's value inside the database, letting you compare two fields (`filter(sale_price__lt=F("price"))`), compute annotations, or update relative to the current value (`update(stock=F("stock") - 1)`). They are often used together: `Q(stock__lt=F("reorder_level")) | Q(is_discontinued=True)`.

**Q: Why use F() for incrementing a counter instead of obj.count += 1; obj.save()?**
A: The Python version is a read-modify-write: it reads the value, increments it in Python and writes the result back. Two concurrent requests that read the same value both write value+1, losing one increment, and `save()` also overwrites every other column with possibly stale values. `Model.objects.filter(pk=pk).update(count=F("count") + 1)` sends `SET count = count + 1`, which the database executes atomically under a row lock, so every increment counts. If you assign an F expression to an instance and call `save()`, use `refresh_from_db()` afterwards to read the new value.

**Q: What is the difference between exists() and count(), and when would you use each?**
A: `exists()` runs `SELECT 1 ... LIMIT 1` and stops at the first matching row, so it is the cheapest way to ask "is there any?". `count()` runs `SELECT COUNT(*)`, which on PostgreSQL must visit every matching row — fine for small sets, expensive for millions. Use `exists()` for guards and permission checks and `count()` only when you need the number. If you are going to use the rows anyway, evaluate the QuerySet once and test the result instead of issuing an extra query. On an already-evaluated QuerySet both use the cache.

**Q: What does values() vs values_list() return, and why use them?**
A: `values("id", "title")` returns a QuerySet of dicts; `values_list("id", "title")` returns tuples, `values_list("id", flat=True)` returns bare values, and `named=True` returns namedtuples. They select only the named columns and skip model instantiation, which is faster and lighter for exports, id lists and JSON responses. You lose model methods and properties. Combined with `annotate()`, `values()` also defines the `GROUP BY` columns, which is how you do grouped aggregation in the ORM.

**Q: How do field lookups across relationships work, and what SQL do they generate?**
A: Double underscores follow relations: `Order.objects.filter(customer__country__code="IN")` walks Order → Customer → Country and adds an INNER JOIN for each hop, with the condition on the last table. Reverse relations use the related query name (`Customer.objects.filter(orders__total__gt=100)`), which joins the child table and can return duplicate parents. Lookups like `icontains` or `year` become SQL functions or operators at the end. Use `*_id` fields (`customer_id=5`) to filter on the FK column without a join.

**Q: What is the difference between filter(a, b) and filter(a).filter(b) on a multi-valued relation?**
A: For single-valued (forward FK) relations, they are the same. For reverse FKs and M2Ms, conditions in a single `filter()` call are applied to the same related row — one JOIN — so the parent is returned only if one child satisfies both. Chained `filter()` calls each add their own JOIN, so different children can satisfy each condition. Interviewers ask this because it silently changes results; for exact semantics, express the condition as an `Exists()` subquery.

**Q: How does get_or_create work and is it safe under concurrency?**
A: It tries `get()` with the lookup arguments; if nothing is found, it creates the object with the lookups plus `defaults` inside a savepoint. If the insert fails with `IntegrityError` because another process inserted the same row in between, it catches the error and runs `get()` again. That makes it race-safe only when a unique constraint covers the lookup fields; without one, two concurrent calls can both insert duplicates. It returns `(obj, created)`. `update_or_create` additionally locks the found row with `select_for_update()` before updating it.

**Q: A list endpoint got slower and memory usage spikes as the table grows, though it only shows 20 items. How would you investigate? (Senior)**
A: Suspect accidental full evaluation before the slice: an `if qs:`, `len(qs)`, `list(qs)` or a serializer touching the whole QuerySet before pagination, or logging `repr(qs)`. Measure with debug-toolbar or `connection.queries` locally and APM traces in production to find which statement returns millions of rows. Check for N+1 (one query per item for relations) and for missing indexes on filter and order columns with `qs.explain(analyze=True)`. Fix by slicing/paginating before evaluation, using `exists()` for guards, `select_related`/`prefetch_related`, `values()` for narrow payloads, and keyset pagination for deep pages. Pin the result with an `assertNumQueries` test.

**Q: How would you implement stock decrement for a flash sale so you never oversell? (Senior)**
A: Make the check and the decrement a single conditional statement: `Product.objects.filter(pk=pk, stock__gte=qty).update(stock=F("stock") - qty)` inside `transaction.atomic()`, and treat a return value of 0 as sold out. The database row lock serialises concurrent updates, and the WHERE guard prevents going negative without any prior read. Create the order line in the same transaction so a failure rolls back both. A `CheckConstraint(stock__gte=0)` is a backstop. If the logic needs to read the row and make decisions (pricing, multiple items), use `select_for_update()` to lock the rows, and for extreme contention consider a Redis counter or queue in front of the database.

**Q: Why might Model.objects.filter(created_at__date=today) be slow on a large table, and how do you fix it? (Senior)**
A: The `__date` transform renders as a cast of the column (in UTC or the current time zone), and a B-tree index on `created_at` cannot be used for an expression on the column, so PostgreSQL scans the table. Rewrite as a half-open range on the raw column: `created_at__gte=start_of_day, created_at__lt=start_of_next_day`, computed in the correct time zone, which uses the index. Alternatively create a functional index on the same expression, but the range is simpler and portable. The same reasoning applies to `__lower`/`__iexact` without a matching expression index. Confirm with `explain()`.

**Q: How do you safely build dynamic filters from user input? (Senior)**
A: Never pass raw request parameters as keyword arguments (`filter(**request.GET.dict())`) or into `order_by()` — users could filter or sort by any field, including sensitive ones across relations, and force expensive queries. Map allowed parameters explicitly to lookups, validate and type-convert values (a form, serializer or django-filter FilterSet), whitelist sort keys, and cap the number of terms and page size. Build OR conditions with `Q` objects and `reduce`. Values are always parameterised by the ORM, so injection is not the risk — data exposure and denial of service are.

**Q: How do you see the SQL a QuerySet will run? (Senior)**
A: `str(qs.query)` prints an approximation with parameters interpolated (not reliably quoted, so do not execute it); `qs.query.sql_with_params()` gives the real SQL and params. `qs.explain()` returns the database's plan, and on PostgreSQL `explain(analyze=True, buffers=True)` actually runs it with timings. With `DEBUG=True`, `connection.queries` lists executed statements, and the `django.db.backends` logger at DEBUG level prints every query. In production, rely on PostgreSQL's `pg_stat_statements`, slow query logs and APM tools rather than DEBUG.

## 10. Quick Revision & Cheat Sheet

| Task | ORM | SQL shape |
|---|---|---|
| AND | `filter(a=1, b=2)` | `WHERE a = 1 AND b = 2` |
| OR / NOT / XOR | `Q(a=1) \| Q(b=2)`, `~Q(...)`, `Q(...) ^ Q(...)` | `OR`, `NOT (...)`, XOR emulation |
| Compare columns | `filter(x__lt=F("y"))` | `WHERE x < y` |
| Atomic update | `update(n=F("n") + 1)` | `SET n = n + 1` |
| Null | `filter(x__isnull=True)` / `x=None` | `IS NULL` |
| Range | `filter(d__gte=s, d__lt=e)` | index-friendly range |
| Across FK | `filter(customer__country__code="IN")` | `INNER JOIN` chain |
| Presence | `exists()` | `SELECT 1 ... LIMIT 1` |
| Number | `count()` | `SELECT COUNT(*)` |
| Exactly one | `get()` | `... LIMIT 21` + exceptions |
| First or None | `first()` | `ORDER BY pk LIMIT 1` if unordered |
| Columns only | `values()` / `values_list(flat=True)` | narrow `SELECT` |
| Streaming | `iterator(chunk_size=2000)` | server-side cursor |

- QuerySets are lazy; evaluation = iterate, `list`, `len`, `bool`, `repr`, step-slice, pickle, `in`.
- The cache lives on the instance; every `.all()`/`.filter()` is a fresh query.
- Slicing an unevaluated QuerySet → `LIMIT/OFFSET`; no negative indices; no filtering after slicing.
- `get()` for unique lookups only; `first()` for "maybe one".
- `Q` = boolean logic; `F` = database-side column values.
- After `obj.x = F(...)` + `save()`, `refresh_from_db()`.
- One `filter()` vs chained filters differs for multi-valued relations.
- `__date` on an indexed datetime defeats the index; use a range.
- `get_or_create` is race-safe only with a unique constraint.
- Inspect with `qs.query`, `qs.explain()`, `connection.queries`, `assertNumQueries`.

## 11. Hands-On Exercises

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2" "psycopg[binary]" django-debug-toolbar
django-admin startproject qslab . && python manage.py startapp catalog
```

1. **Count the queries.** In `shell`, with `reset_queries()` and `connection.queries`, test each evaluation trigger: `bool`, `len`, `list`, `repr`, `qs[5]`, `qs[:5]`, `qs[::2]`, `count()` before and after evaluation, and `qs.all()` after evaluation.
2. **Lookups to SQL.** For ten lookups (`iexact`, `icontains`, `in`, `range`, `isnull`, `year`, `date`, `startswith`, a two-hop relation, a reverse relation) print `qs.query` and run `explain()` with and without an index.
3. **Same row vs any row.** Build the Blog/Entry example with data where the two `filter` forms differ; then express "an entry that matches both" with `Exists()` and compare.
4. **Race it.** Write a management command that spawns 20 threads each decrementing stock with `p.stock -= 1; p.save()`; observe lost updates. Repeat with `update(stock=F("stock") - 1)` and with the `stock__gte` guard.
5. **Dynamic search.** Implement `search_products` from §5 with tests for each filter, a whitelist for sorting, and `assertNumQueries(2)` on the view.
6. **Stream.** Export 500 000 rows to CSV with and without `iterator(chunk_size=5000)` and compare peak memory (`tracemalloc`).

**Mini project — "Order explorer":** a JSON endpoint over `Order`/`OrderItem`/`Customer` with whitelisted filters (status list, date range on `placed_at` as a range, min total, customer country, "has item with SKU X" via `Exists`), OR text search across order number and customer email using `Q`, keyset pagination by `(placed_at, id)`, an atomic "cancel order and restock items" action using `F()` inside `transaction.atomic()`, `explain()` output checked into the README for the three main queries, and tests pinning query counts.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 08 · Models & Fields](topic.html?p=08-models-fields) · [Ch 09 · Relationships](topic.html?p=09-relationships) · [Ch 12 · Aggregation, Annotation, Subqueries & Window Functions](topic.html?p=12-aggregation-annotation-subqueries) · [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization) · [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) · [Ch 15 · Custom Managers, QuerySets & Model Inheritance](topic.html?p=15-managers-model-inheritance) · [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres) · [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi) (async QuerySet API) · [Ch 39 · ORM Coding Round](topic.html?p=39-orm-coding-challenges)

**Other handbooks:** [SQL · Filtering](../sql/topic.html?p=02-filtering) · [SQL · Joins](../sql/topic.html?p=05-joins) · [SQL · Indexes](../sql/topic.html?p=19-indexes) · [SQL · Execution Plans](../sql/topic.html?p=22-execution-plans) · [REST API · Pagination](../rest-api/topic.html?p=13-pagination)

- **Making queries** — Django docs · *Beginner* · the core guide: lazy QuerySets, lookups, spanning relations, Q and F, caching. <https://docs.djangoproject.com/en/5.2/topics/db/queries/>
- **QuerySet API reference** — Django docs · *Intermediate* · every method, what it returns and when it hits the database. <https://docs.djangoproject.com/en/5.2/ref/models/querysets/>
- **Query expressions** — Django docs · *Intermediate* · F, Func, Value, ExpressionWrapper and how expressions compose. <https://docs.djangoproject.com/en/5.2/ref/models/expressions/>
- **Lookup API reference** — Django docs · *Advanced* · writing custom lookups and transforms. <https://docs.djangoproject.com/en/5.2/ref/models/lookups/>
- **Database access optimization** — Django docs · *Intermediate* · official advice on evaluation, caching and query efficiency. <https://docs.djangoproject.com/en/5.2/topics/db/optimization/>
- **Use The Index, Luke** — Markus Winand · *Intermediate* · why LIKE '%x%', functions on columns and OFFSET hurt, with PostgreSQL examples. <https://use-the-index-luke.com/>
- **django-debug-toolbar** — GitHub · *Beginner* · see every query, its duplicates and its stack trace per request. <https://github.com/django-commons/django-debug-toolbar>

---

*Django Handbook — chapter 10.*
