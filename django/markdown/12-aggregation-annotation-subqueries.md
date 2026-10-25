# 12 · Aggregation, Annotation, Subqueries & Window Functions

> **In one line:** `aggregate()` collapses a QuerySet into one dictionary, `annotate()` attaches a computed value to every row, `values().annotate()` is how you write `GROUP BY`, and `Subquery`/`OuterRef`/`Exists`/`Window` let the ORM express almost any reporting query in one round trip — provided you know the SQL each one produces and the join fan-out trap that silently multiplies your counts.

---

## 1. Overview

> **Builds on:** [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) · [Ch 09 · Relationships](topic.html?p=09-relationships)

Sooner or later every application needs numbers: revenue per month, the number of books per author, each customer's latest order, the top three products per category, a running balance. The naive approach is to fetch rows into Python and compute there:

```python
# Naive: pull every order into memory to sum it
total = sum(o.amount for o in Order.objects.filter(status="paid"))

# Naive: N+1 to count books per author
for a in Author.objects.all():
    print(a.name, a.book_set.count())     # one COUNT query per author
```

The first moves potentially millions of rows over the network to compute a single number the database could compute in milliseconds with an index. The second issues one query per author. Both are "correct" and both fall over the moment data grows. The database is an aggregation engine; your job is to ask it the right question.

Django's ORM exposes that engine through **expressions** — objects such as `Count`, `Sum`, `F`, `Case`, `Subquery`, `Window`, `Coalesce`, `TruncMonth` — that compile to SQL fragments. You attach them to a QuerySet with `aggregate()`, `annotate()`, `alias()`, `filter()`, `order_by()` and `values()`. Mastering this chapter is mostly mastering *what SQL comes out* — interviewers will show you a QuerySet and ask what it returns, or show you SQL and ask you to write the QuerySet.

> **Why this matters:** "What's the difference between `aggregate` and `annotate`?" is in nearly every Django interview. The senior follow-up is "why does `Book.objects.annotate(Count('authors'), Count('stores'))` return the wrong numbers?" — and the answer requires understanding joins, not Django.

## 2. Core Concepts

- **Aggregate function** — `Count`, `Sum`, `Avg`, `Min`, `Max`, `StdDev`, `Variance` (and PostgreSQL's `ArrayAgg`, `StringAgg`, `JSONBAgg`, `BoolAnd`…). *Why:* they compile to SQL aggregates and accept `distinct=`, `filter=` and (4.0+) `default=`.
- **`aggregate()`** — terminal; evaluates immediately and returns a `dict` like `{"price__avg": 31.5}`. *Why:* use it for "one number (or a few) about the whole set".
- **`annotate()`** — non-terminal; adds a column to each row/object. With an aggregate inside, it triggers a `GROUP BY` on the model's primary key (or on the `values()` fields). *Why:* "a number per row".
- **`values(...).annotate(...)`** — group by the listed fields. *Why:* this is the ORM's `GROUP BY x`. Order matters: `values()` *before* `annotate()` groups; *after* just selects.
- **`alias()`** (3.2+) — like `annotate()` but the expression isn't selected; usable in `filter()`/`order_by()`. *Why:* avoids computing and transferring a column you only filter on.
- **`F()` / `ExpressionWrapper` / `output_field`** — column references and arithmetic; `output_field` tells Django the result type when it can't infer it (e.g. mixing `DecimalField` and `IntegerField`). *Why:* wrong or missing output types raise `FieldError: Expression contains mixed types`.
- **Conditional aggregation** — `Count("id", filter=Q(status="paid"))`. *Why:* many counts in one pass; compiles to `FILTER (WHERE …)` on PostgreSQL, `CASE WHEN` elsewhere.
- **`Case` / `When`** — SQL `CASE` expression. *Why:* bucketing, custom ordering, conditional updates.
- **`Subquery` + `OuterRef`** — embed a correlated subquery returning one column (and usually one row). *Why:* "latest order per customer" without N+1 or fan-out.
- **`Exists`** — `EXISTS (subquery)`; boolean; usable directly in `filter()` (3.0+). *Why:* cheapest way to test a related row exists without duplicating rows.
- **Database functions** — `Coalesce`, `Greatest`, `Lower`, `Concat`, `Cast`, `Now`, `TruncMonth`, `ExtractYear`… *Why:* push computation into SQL so you can filter/group by it.
- **`Window`** — `Window(expression, partition_by, order_by, frame)` with `RowNumber`, `Rank`, `DenseRank`, `Lag`, `Lead`, `NTile`, or any aggregate. *Why:* rankings and running totals without collapsing rows.
- **Join fan-out** — when two multi-valued relations are joined in one query, each row of A is repeated once per B per C. *Why:* aggregates over the fanned-out rows are multiplied.

## 3. Theory & Principles

### 3.1 How expressions become SQL

Every expression is a subclass of `django.db.models.expressions.BaseExpression` (most via `Expression` / `Func` / `Aggregate`). When you call `qs.annotate(n=Count("books"))`, `QuerySet.annotate()` clones the QuerySet and calls `query.add_annotation(expr, "n")`, which **resolves** the expression with `expr.resolve_expression(query)`. Resolution turns `"books"` into a `Col` reference, adding the required JOIN to `query.alias_map` (via `Query.setup_joins`). Because the expression `contains_aggregate`, the query's `group_by` is set — to `True` meaning "group by all selected non-aggregate columns" for model queries, or to the `values()` fields.

At evaluation, `SQLCompiler.as_sql()` calls `pre_sql_setup()`, `get_select()`, `get_group_by()` and compiles each expression with `compiler.compile(expr)`, which dispatches to `expr.as_sql()` (or a vendor-specific `as_postgresql()`, `as_sqlite()`…). `Count("books", filter=Q(...))` on PostgreSQL renders `COUNT(...) FILTER (WHERE ...)`; on backends without `FILTER`, `Aggregate.as_sql` rewrites it to `COUNT(CASE WHEN ... THEN ... ELSE NULL END)`.

`aggregate()` is different: it calls `query.get_aggregation(using, aggregate_exprs)`. If the QuerySet already has annotations, a LIMIT, `distinct()` or existing aggregates, Django wraps the existing query as a **subquery** and aggregates over it (`SELECT AVG(n) FROM (SELECT ..., COUNT(...) AS n ... GROUP BY ...) subquery`). That is how `annotate(n=Count(...)).aggregate(Avg("n"))` works.

### 3.2 The three shapes

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj12a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Same table, three result shapes</text>
  <rect x="20" y="44" width="200" height="150" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="120" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">book rows</text>
  <text x="34" y="86" fill="#334155" font-size="10">id  publisher  price</text>
  <text x="34" y="106" fill="#334155" font-size="10">1   Acme       20</text>
  <text x="34" y="124" fill="#334155" font-size="10">2   Acme       40</text>
  <text x="34" y="142" fill="#334155" font-size="10">3   Zeta       30</text>
  <text x="34" y="160" fill="#334155" font-size="10">4   Zeta       50</text>
  <text x="34" y="178" fill="#334155" font-size="10">5   Zeta       10</text>
  <path d="M222,90 L282,70" stroke="#334155" stroke-width="1.5" marker-end="url(#dj12a)"/>
  <path d="M222,120 L282,170" stroke="#334155" stroke-width="1.5" marker-end="url(#dj12a)"/>
  <path d="M222,160 L282,290" stroke="#334155" stroke-width="1.5" marker-end="url(#dj12a)"/>
  <rect x="286" y="44" width="574" height="58" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="300" y="64" fill="#1e3a8a" font-weight="bold">Book.objects.aggregate(avg=Avg("price"))  &#8594; {"avg": 30.0}</text>
  <text x="300" y="84" fill="#1e293b" font-size="10">SELECT AVG(price) FROM book   &#8212; terminal, returns a dict, one row total</text>
  <rect x="286" y="118" width="574" height="112" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="300" y="138" fill="#14532d" font-weight="bold">Book.objects.values("publisher").annotate(avg=Avg("price"))</text>
  <text x="300" y="158" fill="#1e293b" font-size="10">SELECT publisher_id, AVG(price) FROM book GROUP BY publisher_id</text>
  <text x="300" y="180" fill="#1e293b" font-size="10">&#8594; [{"publisher": Acme, "avg": 30}, {"publisher": Zeta, "avg": 30}]   one row per group</text>
  <text x="300" y="200" fill="#16a34a" font-size="10">values() BEFORE annotate() = the GROUP BY columns</text>
  <text x="300" y="218" fill="#16a34a" font-size="10">filter() on an aggregate alias after this = HAVING</text>
  <rect x="286" y="246" width="574" height="138" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="300" y="266" fill="#4c1d95" font-weight="bold">Book.objects.annotate(pub_avg=Window(Avg("price"), partition_by=F("publisher")))</text>
  <text x="300" y="286" fill="#1e293b" font-size="10">SELECT ..., AVG(price) OVER (PARTITION BY publisher_id) FROM book</text>
  <text x="300" y="308" fill="#1e293b" font-size="10">&#8594; all 5 rows kept, each carries its group&#8217;s value: 1:30  2:30  3:30  4:30  5:30</text>
  <text x="300" y="330" fill="#7c3aed" font-size="10">Contrast: Publisher.objects.annotate(n=Count("book"))  &#8594; one row per publisher,</text>
  <text x="300" y="348" fill="#7c3aed" font-size="10">GROUP BY publisher.id (plus its columns), n is attached to each Publisher instance.</text>
  <text x="300" y="370" fill="#7c3aed" font-size="10">Window functions never collapse rows; GROUP BY always does.</text>
</svg>
```

### 3.3 Ordering of clauses is meaning

The order you chain `values`, `annotate` and `filter` changes the SQL, not just the style:

| Chain | SQL meaning |
|---|---|
| `filter(books__rating__gt=4).annotate(n=Count("books"))` | WHERE first: count only highly rated books |
| `annotate(n=Count("books")).filter(books__rating__gt=4)` | Count *all* books; the second filter adds a **second** join for the filter (for multi-valued relations) |
| `annotate(n=Count("books")).filter(n__gt=3)` | `HAVING COUNT(...) > 3` |
| `values("x").annotate(n=Count("id"))` | `GROUP BY x` |
| `annotate(n=Count("id")).values("x")` | GROUP BY the model pk (plus columns), *then* select `x` — not grouped by x |
| `values("x").annotate(n=Count("id")).order_by("y")` | `y` is **added to GROUP BY** — groups split unexpectedly |

> **Version note:** Before Django 3.1, a model's `Meta.ordering` leaked into `GROUP BY` and broke `values().annotate()` groupings. Since 3.1 `Meta.ordering` is ignored in such queries — but an explicit `order_by()` on a non-grouped field still adds it to `GROUP BY`. Call `.order_by()` (empty) to clear ordering when in doubt.

### 3.4 The join fan-out trap

```svg
<svg viewBox="0 0 880 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Book.annotate(Count("authors"), Count("stores")) multiplies across joins</text>
  <rect x="20" y="44" width="250" height="120" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="145" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">Book "Django Deep Dive"</text>
  <text x="34" y="88" fill="#334155" font-size="10">authors: A1, A2, A3       (3)</text>
  <text x="34" y="108" fill="#334155" font-size="10">stores: S1, S2            (2)</text>
  <text x="34" y="132" fill="#334155" font-size="10">Expected: authors=3, stores=2</text>
  <rect x="290" y="44" width="300" height="250" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="440" y="64" text-anchor="middle" fill="#7f1d1d" font-weight="bold">LEFT JOIN author, LEFT JOIN store: 3 x 2 rows</text>
  <text x="310" y="88" fill="#7f1d1d" font-size="10">Acme  B1  S1</text>
  <text x="310" y="106" fill="#7f1d1d" font-size="10">Acme  B1  S2</text>
  <text x="310" y="124" fill="#7f1d1d" font-size="10">Acme  B2  S1</text>
  <text x="310" y="142" fill="#7f1d1d" font-size="10">Acme  B2  S2</text>
  <text x="310" y="160" fill="#7f1d1d" font-size="10">Acme  B3  S1</text>
  <text x="310" y="178" fill="#7f1d1d" font-size="10">Acme  B3  S2</text>
  <text x="310" y="206" fill="#dc2626" font-size="11" font-weight="bold">COUNT(author.id) = 6  (wrong)</text>
  <text x="310" y="226" fill="#dc2626" font-size="11" font-weight="bold">COUNT(store.id) = 6  (wrong)</text>
  <text x="310" y="250" fill="#7f1d1d" font-size="10">Sum("stores__rent") would be tripled too,</text>
  <text x="310" y="268" fill="#7f1d1d" font-size="10">and distinct=True cannot fix SUM.</text>
  <rect x="610" y="44" width="250" height="250" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="735" y="64" text-anchor="middle" fill="#14532d" font-weight="bold">Fixes</text>
  <text x="624" y="90" fill="#14532d" font-size="10">1. Count("authors", distinct=True)</text>
  <text x="624" y="108" fill="#14532d" font-size="10">   Count("stores", distinct=True)</text>
  <text x="624" y="126" fill="#14532d" font-size="10">   OK for COUNT only</text>
  <text x="624" y="152" fill="#14532d" font-size="10">2. One Subquery per relation:</text>
  <text x="624" y="170" fill="#14532d" font-size="10">   aggregate inside, correlate on</text>
  <text x="624" y="188" fill="#14532d" font-size="10">   OuterRef("pk") &#8212; no fan-out,</text>
  <text x="624" y="206" fill="#14532d" font-size="10">   works for SUM/AVG too</text>
  <text x="624" y="232" fill="#14532d" font-size="10">3. Two queries, merge in Python</text>
  <text x="624" y="258" fill="#14532d" font-size="10">Rule: at most ONE multi-valued</text>
  <text x="624" y="276" fill="#14532d" font-size="10">join per aggregating query</text>
  <rect x="20" y="310" width="840" height="36" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="440" y="333" text-anchor="middle" fill="#78350f" font-size="11">Django docs call this out: combining multiple aggregations with annotate() over different multi-valued relations yields wrong results.</text>
</svg>
```

This is not a Django bug; it is what SQL `JOIN` + `GROUP BY` mean. The ORM simply joins every relation you mention. `distinct=True` fixes counts (count distinct ids), but `Sum`/`Avg` over duplicated rows can't be "distincted" correctly — two books with the same price would collapse. The robust fix is a correlated subquery per relation (§5.3).

### 3.5 Subqueries and `OuterRef`

`Subquery(qs)` wraps an inner QuerySet; `OuterRef("pk")` is a placeholder resolved against the *outer* query when the subquery is embedded (`ResolvedOuterRef`). The inner QuerySet must return exactly **one column** (`.values("field")`) and, when used as a scalar, **at most one row** (`[:1]`). Django compiles it inline into the SELECT, WHERE or ORDER BY. `Exists(qs)` is the same mechanism rendered as `EXISTS(SELECT 1 ... LIMIT 1)`, and since 3.0 can be passed straight into `filter()` / `exclude()` (`~Exists(...)` for NOT EXISTS).

Aggregating inside a subquery needs a small idiom, because `aggregate()` is terminal: group the inner query by the correlated column, then select only the aggregate:

```python
books_total = (
    Book.objects.filter(publisher=OuterRef("pk"))
    .order_by()                       # clear ordering so it doesn't enter GROUP BY
    .values("publisher")              # GROUP BY publisher_id
    .annotate(total=Sum("price"))
    .values("total")                  # single column
)
Publisher.objects.annotate(book_total=Coalesce(Subquery(books_total), Decimal("0")))
```

### 3.6 Window functions

`Window(expression=RowNumber(), partition_by=[F("category")], order_by=F("price").desc())` compiles to `ROW_NUMBER() OVER (PARTITION BY category_id ORDER BY price DESC)`. Frames are expressed with `RowRange(start=None, end=0)` / `ValueRange`. SQL forbids window functions in `WHERE`; since **Django 4.2** you can `filter()` on a window annotation and Django wraps the query in a subquery and filters outside — making top-N-per-group a one-liner. On older versions you had to use `Subquery` or raw SQL. The SQL fundamentals are in [SQL · Window Functions](../sql/topic.html?p=13-window-functions).

## 4. Architecture & Workflow

### 4.1 From QuerySet to SQL with annotations

```text
qs = Publisher.objects.filter(country="IN")          WHERE added to query.where
     .annotate(n=Count("book"))                       resolve_expression -> JOIN book
                                                      query.group_by = True
     .filter(n__gt=2)                                 n is an aggregate -> query.having
     .order_by("-n")                                  ORDER BY n DESC

SQLCompiler.as_sql():
  SELECT publisher.id, publisher.name, publisher.country, COUNT(book.id) AS n
  FROM publisher LEFT OUTER JOIN book ON book.publisher_id = publisher.id
  WHERE publisher.country = 'IN'
  GROUP BY publisher.id                              (PG: pk is enough, functional dependency)
  HAVING COUNT(book.id) > 2
  ORDER BY n DESC
```

On PostgreSQL Django groups by the primary key only (the backend feature `allows_group_by_selected_pks`), since every other column of that table is functionally dependent on it.

### 4.2 Correlated subquery vs join, visually

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj12b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj12c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">"Latest order per customer" with Subquery + OuterRef</text>
  <rect x="20" y="44" width="260" height="200" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="150" y="64" text-anchor="middle" fill="#1e3a8a" font-weight="bold">Outer query: customer</text>
  <text x="34" y="90" fill="#1e293b" font-size="10">for each customer row c ...</text>
  <rect x="40" y="104" width="220" height="30" rx="5" fill="#fff" stroke="#2563eb"/><text x="150" y="123" text-anchor="middle" fill="#1e293b" font-size="10">c.id = 7, name = Asha</text>
  <rect x="40" y="144" width="220" height="30" rx="5" fill="#fff" stroke="#2563eb"/><text x="150" y="163" text-anchor="middle" fill="#1e293b" font-size="10">c.id = 9, name = Ben</text>
  <text x="34" y="200" fill="#1e293b" font-size="10">SELECT c.*, (subquery) AS last_total</text>
  <text x="34" y="218" fill="#1e293b" font-size="10">FROM customer c</text>
  <path d="M262,119 L346,119" stroke="#2563eb" stroke-width="2" marker-end="url(#dj12b)"/>
  <text x="304" y="110" text-anchor="middle" fill="#2563eb" font-size="9">OuterRef("pk")</text>
  <rect x="350" y="44" width="300" height="200" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="500" y="64" text-anchor="middle" fill="#4c1d95" font-weight="bold">Inner query: order (correlated)</text>
  <text x="364" y="90" fill="#1e293b" font-size="10">SELECT o.total FROM order o</text>
  <text x="364" y="108" fill="#1e293b" font-size="10">WHERE o.customer_id = c.id</text>
  <text x="364" y="126" fill="#1e293b" font-size="10">ORDER BY o.created_at DESC</text>
  <text x="364" y="144" fill="#1e293b" font-size="10">LIMIT 1</text>
  <text x="364" y="172" fill="#7c3aed" font-size="10">one column (.values), one row ([:1])</text>
  <text x="364" y="190" fill="#7c3aed" font-size="10">index (customer_id, created_at DESC)</text>
  <text x="364" y="208" fill="#7c3aed" font-size="10">makes each probe an index seek</text>
  <path d="M652,119 L716,119" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj12c)"/>
  <rect x="720" y="44" width="140" height="200" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="790" y="64" text-anchor="middle" fill="#14532d" font-weight="bold">Result</text>
  <text x="732" y="96" fill="#1e293b" font-size="10">Asha  last=120.00</text>
  <text x="732" y="120" fill="#1e293b" font-size="10">Ben   last=NULL</text>
  <text x="732" y="150" fill="#16a34a" font-size="10">one row/customer</text>
  <text x="732" y="168" fill="#16a34a" font-size="10">no fan-out</text>
  <text x="732" y="186" fill="#16a34a" font-size="10">one round trip</text>
  <rect x="20" y="262" width="840" height="56" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="40" y="284" fill="#78350f" font-size="10">Alternative 1: prefetch all orders and pick max in Python &#8212; transfers every order.</text>
  <text x="40" y="304" fill="#78350f" font-size="10">Alternative 2: annotate(Max("orders__created_at")) gives the date, not the order&#8217;s other columns &#8212; you need Subquery for those.</text>
</svg>
```

### 4.3 Choosing the tool

```text
Need one number for the whole set?            -> aggregate()
Need a number per object?                     -> annotate(Count/Sum...) on that model
Need a number per group of some column(s)?    -> values(cols).annotate(...)  (.order_by() to be safe)
Need several aggregates over DIFFERENT
  multi-valued relations?                     -> one Subquery each (or distinct=True for counts)
Need a column from the "latest/first" child?  -> Subquery(...order_by(...).values("col")[:1])
Need "has any child matching X"?              -> filter(Exists(...))
Need rank / running total / prev row?         -> Window(...)   (filter on it: 4.2+)
Need conditional counts in one pass?          -> Count("id", filter=Q(...))
```

## 5. Implementation

### 5.1 Simple example: a bookshop

```python
# catalog/models.py
from django.db import models

class Publisher(models.Model):
    name = models.CharField(max_length=200)

class Author(models.Model):
    name = models.CharField(max_length=200)
    age = models.PositiveIntegerField()

class Book(models.Model):
    title = models.CharField(max_length=300)
    pages = models.PositiveIntegerField()
    price = models.DecimalField(max_digits=8, decimal_places=2)
    rating = models.FloatField()
    pubdate = models.DateField()
    publisher = models.ForeignKey(Publisher, on_delete=models.PROTECT, related_name="books")
    authors = models.ManyToManyField(Author, related_name="books")

class Store(models.Model):
    name = models.CharField(max_length=200)
    books = models.ManyToManyField(Book, related_name="stores")
```

```python
from django.db.models import Avg, Count, Max, Min, Q, Sum, F

Book.objects.aggregate(Avg("price"), max_pages=Max("pages"))
# {'price__avg': Decimal('31.50'), 'max_pages': 1132}

Book.objects.filter(publisher__name="Acme").aggregate(total=Sum("price", default=0))
# default= (4.0+) returns 0 instead of None for an empty set

pubs = Publisher.objects.annotate(num_books=Count("books")).order_by("-num_books")
pubs[0].num_books        # attribute on each instance

# GROUP BY a column
Book.objects.values("publisher__name").annotate(n=Count("id"), avg=Avg("price")).order_by("-n")

# HAVING
Author.objects.annotate(n=Count("books")).filter(n__gte=3)

# Conditional aggregation: several counts in one scan
Publisher.objects.annotate(
    total=Count("books"),
    good=Count("books", filter=Q(books__rating__gte=4)),
    cheap=Count("books", filter=Q(books__price__lt=10)),
)
```

The SQL for the last one on PostgreSQL:

```sql
SELECT "catalog_publisher"."id", "catalog_publisher"."name",
       COUNT("catalog_book"."id") AS "total",
       COUNT("catalog_book"."id") FILTER (WHERE "catalog_book"."rating" >= 4.0) AS "good",
       COUNT("catalog_book"."id") FILTER (WHERE "catalog_book"."price" < 10) AS "cheap"
FROM "catalog_publisher"
LEFT OUTER JOIN "catalog_book" ON ("catalog_publisher"."id" = "catalog_book"."publisher_id")
GROUP BY "catalog_publisher"."id";
```

`Count("books")` produces a **LEFT OUTER JOIN**, so publishers with zero books appear with `total = 0`. Filtering `filter(books__rating__gte=4).annotate(...)` instead produces an INNER JOIN and drops publishers without matching books — a different question.

Expressions and types:

```python
from django.db.models import DecimalField, ExpressionWrapper, Case, When, Value, CharField

Book.objects.annotate(
    price_per_page=ExpressionWrapper(F("price") / F("pages"), output_field=DecimalField(max_digits=10, decimal_places=4)),
    tier=Case(
        When(price__gte=50, then=Value("premium")),
        When(price__gte=20, then=Value("standard")),
        default=Value("budget"),
        output_field=CharField(),
    ),
).values("tier").annotate(n=Count("id")).order_by("tier")
```

```sql
SELECT CASE WHEN "catalog_book"."price" >= 50 THEN 'premium'
            WHEN "catalog_book"."price" >= 20 THEN 'standard'
            ELSE 'budget' END AS "tier",
       COUNT("catalog_book"."id") AS "n"
FROM "catalog_book"
GROUP BY 1
ORDER BY 1 ASC;
```

Aggregate over annotation (Django builds a subquery):

```python
Publisher.objects.annotate(n=Count("books")).aggregate(avg_books=Avg("n"))
```

```sql
SELECT AVG("n") FROM (
  SELECT "catalog_publisher"."id" AS "col1", COUNT("catalog_book"."id") AS "n"
  FROM "catalog_publisher" LEFT OUTER JOIN "catalog_book" ON (...)
  GROUP BY 1
) subquery;
```

### 5.2 Subquery and Exists

```python
from django.db.models import Exists, OuterRef, Subquery

newest = Book.objects.filter(publisher=OuterRef("pk")).order_by("-pubdate")

Publisher.objects.annotate(
    newest_title=Subquery(newest.values("title")[:1]),
    newest_date=Subquery(newest.values("pubdate")[:1]),
)

# Publishers that have at least one book rated 5 (no duplicates, no DISTINCT needed)
Publisher.objects.filter(Exists(Book.objects.filter(publisher=OuterRef("pk"), rating=5)))

# Authors with NO books in any store
Author.objects.filter(~Exists(Store.objects.filter(books__authors=OuterRef("pk"))))
```

```sql
SELECT "catalog_publisher"."id", "catalog_publisher"."name"
FROM "catalog_publisher"
WHERE EXISTS (
  SELECT 1 AS "a" FROM "catalog_book" U0
  WHERE (U0."publisher_id" = ("catalog_publisher"."id") AND U0."rating" = 5.0)
  LIMIT 1
);
```

The `U0`, `U1` aliases are how Django names tables inside subqueries — recognising them helps when reading logs.

### 5.3 Real-world example: a customer analytics endpoint

```python
# sales/models.py
from django.conf import settings
from django.db import models

class Category(models.Model):
    name = models.CharField(max_length=100)

class Product(models.Model):
    name = models.CharField(max_length=200)
    category = models.ForeignKey(Category, on_delete=models.PROTECT, related_name="products")
    price = models.DecimalField(max_digits=10, decimal_places=2)

class Order(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending"; PAID = "paid"; REFUNDED = "refunded"
    customer = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="orders")
    status = models.CharField(max_length=10, choices=Status.choices, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    total = models.DecimalField(max_digits=12, decimal_places=2)

    class Meta:
        indexes = [models.Index(fields=["customer", "-created_at"], name="order_cust_created_idx")]

class OrderItem(models.Model):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="items")
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="order_items")
    quantity = models.PositiveIntegerField()
    unit_price = models.DecimalField(max_digits=10, decimal_places=2)
```

**(a) Customer list with lifetime value, paid-order count, ticket count and last order — no fan-out:**

```python
from decimal import Decimal
from django.contrib.auth import get_user_model
from django.db.models import Count, DecimalField, OuterRef, Q, Subquery, Sum, Value
from django.db.models.functions import Coalesce

User = get_user_model()
paid = Order.objects.filter(customer=OuterRef("pk"), status=Order.Status.PAID).order_by()

ltv_sq = paid.values("customer").annotate(s=Sum("total")).values("s")
cnt_sq = paid.values("customer").annotate(c=Count("pk")).values("c")
last_sq = Order.objects.filter(customer=OuterRef("pk")).order_by("-created_at")

customers = (
    User.objects.filter(is_active=True)
    .annotate(
        lifetime_value=Coalesce(Subquery(ltv_sq), Value(Decimal("0")), output_field=DecimalField()),
        paid_orders=Coalesce(Subquery(cnt_sq), 0),
        last_order_at=Subquery(last_sq.values("created_at")[:1]),
        last_order_total=Subquery(last_sq.values("total")[:1]),
    )
    .order_by("-lifetime_value")[:50]
)
```

Each subquery is a correlated index probe on `(customer_id, created_at)`; no relation is joined, so nothing multiplies. Compare the wrong version: `annotate(ltv=Sum("orders__total"), items=Count("orders__items"))` — joining orders *and* items would multiply every order's total by its item count.

**(b) Monthly revenue report (GROUP BY a truncated date):**

```python
from django.db.models.functions import TruncMonth

monthly = (
    Order.objects.filter(status=Order.Status.PAID, created_at__year=2026)
    .annotate(month=TruncMonth("created_at"))
    .values("month")
    .annotate(revenue=Sum("total"), orders=Count("id"), customers=Count("customer", distinct=True))
    .order_by("month")
)
```

```sql
SELECT DATE_TRUNC('month', "sales_order"."created_at" AT TIME ZONE 'UTC') AS "month",
       SUM("sales_order"."total") AS "revenue",
       COUNT("sales_order"."id") AS "orders",
       COUNT(DISTINCT "sales_order"."customer_id") AS "customers"
FROM "sales_order"
WHERE ("sales_order"."created_at" BETWEEN '2026-01-01 00:00:00+00:00' AND '2026-12-31 23:59:59.999999+00:00'
       AND "sales_order"."status" = 'paid')
GROUP BY 1
ORDER BY 1 ASC;
```

With `USE_TZ=True`, `TruncMonth` converts to the current time zone (`AT TIME ZONE`), so "month" means the user's month, not UTC's. Pass `tzinfo=` to control it.

**(c) Top 3 best-selling products per category (window + filter, Django 4.2+):**

```python
from django.db.models import F, Sum, Window
from django.db.models.functions import Rank

top3 = (
    Product.objects.annotate(units=Coalesce(Sum("order_items__quantity",
                                                filter=Q(order_items__order__status="paid")), 0))
    .annotate(rnk=Window(Rank(), partition_by=F("category_id"), order_by=F("units").desc()))
    .filter(rnk__lte=3)
    .order_by("category_id", "rnk")
)
```

```sql
SELECT * FROM (
  SELECT "sales_product"."id" AS "col1", ..., 
         COALESCE(SUM("sales_orderitem"."quantity") FILTER (WHERE "sales_order"."status" = 'paid'), 0) AS "units",
         RANK() OVER (PARTITION BY "sales_product"."category_id"
                      ORDER BY COALESCE(SUM(...) FILTER (...), 0) DESC) AS "rnk"
  FROM "sales_product"
  LEFT OUTER JOIN "sales_orderitem" ON (...) LEFT OUTER JOIN "sales_order" ON (...)
  GROUP BY "sales_product"."id"
) "qualify"
WHERE "rnk" <= 3
ORDER BY ...;
```

Django names the wrapper `qualify`, after the `QUALIFY` clause some databases offer. Note windows are computed **after** GROUP BY, so a window can rank an aggregate.

**(d) Running balance per account with a frame:**

```python
from django.db.models import RowRange
from django.db.models.functions import Lag

Ledger.objects.filter(account_id=acct).annotate(
    balance=Window(Sum("amount"), order_by=[F("created_at").asc(), F("id").asc()],
                   frame=RowRange(start=None, end=0)),
    prev_amount=Window(Lag("amount"), order_by=F("created_at").asc()),
)
```

`RowRange(start=None, end=0)` = `ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW`. Always add a unique tiebreaker (`id`) to the window ordering, otherwise ties produce non-deterministic running totals.

**(e) Use the result in DRF without N+1:** annotate in `get_queryset()` and expose the alias as a read-only field (`serializers.DecimalField(read_only=True, max_digits=12, decimal_places=2)`) — see [Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers).

## 6. Advantages, Disadvantages & Trade-offs

| Technique | Rows returned | Good for | Watch out for |
|---|---|---|---|
| `aggregate()` | 1 dict | Totals, KPIs | Terminal; can't chain further |
| `annotate(Agg)` on model | 1 per object | Per-object counts | Fan-out with ≥2 multi-valued joins; GROUP BY cost |
| `values().annotate()` | 1 per group | Reports, charts | `order_by` fields join GROUP BY; returns dicts |
| Conditional aggregate `filter=Q` | same as above | Many metrics in one scan | Needs PG for `FILTER`; CASE elsewhere is fine |
| `Subquery` | unchanged | Child column, isolated aggregates | Needs index on correlated column; one column/row |
| `Exists` | unchanged | Semi-joins, permission filters | None significant — usually optimal |
| `Window` | unchanged | Rank, running totals, lag/lead | Computed after WHERE/GROUP BY; filter needs 4.2+ |
| Raw SQL / `RawSQL` | any | Truly exotic SQL (`LATERAL`, CTEs) | Loses composability; injection risk if formatted |

### When to use

- Any number you would otherwise compute by looping over model instances.
- `Subquery` whenever you aggregate across more than one multi-valued relation, or need columns of a "latest" child.
- `Exists` instead of `filter(children__x=...).distinct()` to avoid duplicates and DISTINCT sorts.
- Windows for leaderboards, rank-within-group, running totals, gaps between events.

### When NOT to use

- Don't annotate heavy aggregates on list endpoints that are paginated over huge tables without an index strategy — the GROUP BY runs over all matched rows before LIMIT. Consider denormalised counters (updated with `F()`; see [Ch 14](topic.html?p=14-transactions-concurrency)) or a materialized view.
- Don't build reporting on the primary when replicas exist ([Ch 34](topic.html?p=34-scaling-databases)).
- Don't force the ORM into recursive CTEs — use raw SQL or a package; see [SQL · Recursive CTE](../sql/topic.html?p=12-recursive-cte).

## 7. Common Mistakes & Best Practices

**1. Confusing `aggregate` and `annotate`.** `Publisher.objects.aggregate(Count("books"))` returns the total number of book links across all publishers, one number. `annotate` gives one number per publisher.

**2. `values()` in the wrong position.**

```python
# Wrong: grouped by book pk, then projected -> one row per book with n=1
Book.objects.annotate(n=Count("id")).values("publisher")
# Right: group by publisher
Book.objects.values("publisher").annotate(n=Count("id"))
```

**3. A stray ordering splitting groups.** `values("publisher").annotate(n=Count("id")).order_by("title")` adds `title` to GROUP BY → one row per title. Order by the aggregate or the group key, or clear with `.order_by()`.

**4. Multiple aggregates across different relations.** Covered in §3.4. Before/after:

```python
# Before (wrong): authors x stores rows per book
Book.objects.annotate(a=Count("authors"), s=Count("stores"))
# Before (wrong): each book's price repeated once per author
Publisher.objects.annotate(n_authors=Count("books__authors"), value=Sum("books__price"))

# After
Book.objects.annotate(a=Count("authors", distinct=True), s=Count("stores", distinct=True))

book_value = (Book.objects.filter(publisher=OuterRef("pk")).order_by()
              .values("publisher").annotate(v=Sum("price")).values("v"))
Publisher.objects.annotate(
    n_authors=Count("books__authors", distinct=True),
    value=Coalesce(Subquery(book_value), Decimal("0")),   # SUM must not see the fanned-out rows
)
```

**5. Forgetting `None` for empty sets.** `Sum` over no rows is `NULL` → `None`. Use `default=0` (4.0+) on `aggregate`, or `Coalesce(..., 0)` in `annotate`/subqueries.

**6. Mixed types.** `F("price") * F("quantity")` (Decimal × Integer) may raise `FieldError: Expression contains mixed types` on some combinations — add `output_field=DecimalField(...)` or wrap in `ExpressionWrapper`.

**7. Subquery returning multiple rows/columns.** Missing `[:1]` → `more than one row returned by a subquery used as an expression`. Missing `.values("col")` → `subquery has too many columns`.

**8. Filtering on a related field after annotate unexpectedly adds a join.** For multi-valued relations, `annotate(n=Count("books")).filter(books__rating=5)` creates a *second* join to book, which also fans out the count. Put the filter before the annotate, or use `filter=Q(...)` inside the aggregate.

**Best practices:** print `str(qs.query)` for every non-trivial report while developing; write a test with `assertNumQueries(1)` and known fixture totals; use `alias()` for expressions only needed in filters; index the correlated columns of every subquery.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: dashboard totals off by 2–10×.** *Symptom:* revenue on the admin dashboard doesn't match finance's export. *Root cause:* `annotate(Sum("orders__total"), Count("orders__items"))` — fan-out. *Fix:* subqueries per relation; add a regression test with an order having multiple items.

**Pitfall: annotated admin list view times out.** `ModelAdmin.get_queryset` annotated `Count("orders")` across 5M customers; the admin's `paginator.count` then runs `SELECT COUNT(*) FROM (... GROUP BY ...)`. *Fix:* annotate only in the changelist when needed, use `show_full_result_count = False`, or denormalise a counter. See [Ch 07 · The Django Admin](topic.html?p=07-django-admin).

**Pitfall: correlated subquery without an index.** Each outer row triggers a sequential scan of the inner table — O(N×M). `explain()` shows `SubPlan` with `Seq Scan`. *Fix:* composite index matching the subquery's filter + order, e.g. `(customer_id, created_at DESC)`.

```python
print(customers.explain(analyze=True, buffers=True))   # PostgreSQL options pass through
```

```text
Limit  (cost=... rows=50)
  ->  Sort  (... Sort Key: (COALESCE((SubPlan 1), 0)) DESC)
        ->  Seq Scan on accounts_user ...
              SubPlan 1
                ->  GroupAggregate
                      ->  Index Scan using order_cust_created_idx on sales_order u0
                            Index Cond: (customer_id = accounts_user.id)
```

**Pitfall: `count()` on a grouped queryset is slow.** `values("x").annotate(...).count()` becomes `SELECT COUNT(*) FROM (SELECT ... GROUP BY ...) subquery` — it computes every group. Fine for hundreds of groups, not for millions.

**Pitfall: time-zone surprises in date grouping.** Orders at 23:30 IST land in the "next" day when the report runs in UTC. Decide the reporting tz explicitly (`TruncDate("created_at", tzinfo=ZoneInfo("Asia/Kolkata"))`).

**Debugging:** `str(qs.query)` (approximate SQL), `connection.queries` with `DEBUG=True`, django-debug-toolbar's SQL panel (shows EXPLAIN per query), and PostgreSQL's `pg_stat_statements` for the heaviest aggregate queries in production.

**Scaling:** heavy reporting belongs on a read replica (`.using("replica")`), in materialized views refreshed on a schedule, or in a warehouse. Hot counters (likes, stock) belong in denormalised columns updated atomically, not recomputed with `Count` per request. Query-level deep dive: [SQL · Group By](../sql/topic.html?p=07-group-by), [SQL · Query Optimization](../sql/topic.html?p=21-query-optimization).

## 9. Interview Questions

**Q: What is the difference between `aggregate()` and `annotate()`?**
A: `aggregate()` computes summary values over the entire QuerySet and returns a plain dictionary immediately — it is terminal, so you can't chain filters after it. `annotate()` adds a computed expression to each object in the QuerySet and returns a new lazy QuerySet you can keep filtering and ordering. When the annotation contains an aggregate, Django adds a GROUP BY on the model's primary key (or the `values()` fields), so you get one value per object. Example: `Book.objects.aggregate(Avg("price"))` → `{"price__avg": ...}`; `Publisher.objects.annotate(n=Count("books"))` → each publisher has `.n`.

**Q: How do you write a GROUP BY query in the Django ORM?**
A: Call `values()` with the grouping columns *before* `annotate()`: `Book.objects.values("publisher__name").annotate(n=Count("id"))`. Django groups by the fields in `values()` and returns dictionaries. If you call `values()` after `annotate()`, it only selects columns and the grouping stays on the primary key. Be careful with `order_by()`: an ordering on a field not in `values()` is added to GROUP BY and splits groups, so order by the key or the aggregate, or clear ordering with `.order_by()`.

**Q: How do you express HAVING?**
A: Filter on an aggregate annotation after it is defined: `Author.objects.annotate(n=Count("books")).filter(n__gt=3)` produces `HAVING COUNT(...) > 3`. A filter placed before the annotate, or on a non-aggregate field, goes into WHERE. So `filter(books__rating__gt=4).annotate(n=Count("books"))` counts only highly rated books, which is a different result from annotating first.

**Q: Why might `Book.objects.annotate(Count("authors"), Count("stores"))` return wrong numbers?**
A: Because both relations are multi-valued and Django joins them in the same query, producing authors × stores rows per book before grouping. Each COUNT then counts the product, not the individual relation. For counts, `distinct=True` fixes it by counting distinct ids. For `Sum`/`Avg` it does not, so you compute each aggregate in its own correlated `Subquery` (or in separate queries). The rule: at most one multi-valued join per aggregating query.

**Q: What are `Subquery` and `OuterRef` used for?**
A: `Subquery` embeds a QuerySet as a SQL subquery, and `OuterRef` refers to a column of the enclosing query, making it correlated. Typical use: annotate each customer with their latest order's total — `Subquery(Order.objects.filter(customer=OuterRef("pk")).order_by("-created_at").values("total")[:1])`. The inner query must return one column and, as a scalar, at most one row. It avoids N+1 and avoids join fan-out, and with an index on the correlated column each probe is cheap.

**Q: When would you use `Exists` instead of a join filter?**
A: When you only need to know whether a related row exists. `filter(books__rating=5)` joins and returns a publisher once per matching book, forcing you to add `.distinct()`, which sorts or hashes the whole result. `filter(Exists(Book.objects.filter(publisher=OuterRef("pk"), rating=5)))` produces a semi-join that stops at the first match and never duplicates rows. `~Exists(...)` gives a clean NOT EXISTS, which is also safer than `NOT IN` with NULLs.

**Q: What is conditional aggregation and how does Django implement it?**
A: Computing aggregates over subsets of rows in a single pass, e.g. `Count("id", filter=Q(status="paid"))` alongside `Count("id")`. On PostgreSQL Django emits the standard `COUNT(...) FILTER (WHERE ...)`; on databases without `FILTER` support it rewrites to `COUNT(CASE WHEN ... THEN ... END)`. It replaces several separate queries with one table scan, which is the usual way to build a status breakdown or dashboard tile set.

**Q: What does `F()` do in an annotation, and when do you need `ExpressionWrapper` or `output_field`?**
A: `F("field")` references a column in SQL so arithmetic happens in the database — `annotate(line_total=F("quantity") * F("unit_price"))`. Django infers the output type from the operands; when they differ (decimal times integer, date minus date producing a duration) it may not be able to and raises "Expression contains mixed types". You then supply `output_field=DecimalField(...)`, either directly on the expression or via `ExpressionWrapper`. The output field also determines how the value is converted back to Python.

**Q: How do window functions differ from `annotate` with an aggregate, and how do you get the top N per group?**
A: A window function computes over a partition of rows but keeps every row, while GROUP BY collapses each group into one row. In Django: `annotate(rnk=Window(RowNumber(), partition_by=F("category"), order_by=F("price").desc()))`. SQL doesn't allow window functions in WHERE, but since Django 4.2 you can write `.filter(rnk__lte=3)` and Django wraps the query in a subquery and filters outside it. Before 4.2 you'd use a subquery or raw SQL.

**Q: You need a list of 50 customers sorted by lifetime value, with order count, ticket count and last order date. How would you build it efficiently? (Senior)**
A: Avoid joining orders and tickets in one aggregating query because of fan-out. Annotate each metric with its own correlated subquery: grouped `Sum("total")` and `Count("pk")` over paid orders with `OuterRef("pk")`, a `Count` over tickets, and `Subquery(...order_by("-created_at").values("created_at")[:1])` for last order, each wrapped in `Coalesce` for customers with none. Make sure each correlated column has a supporting index like `(customer_id, created_at DESC)`, and check `explain(analyze=True)` for index scans in the SubPlans. If the list must sort by LTV across millions of users, that still computes LTV for every user before LIMIT, so at scale I'd denormalise `lifetime_value` onto the customer (updated in the order-paid transaction with `F()`) or precompute it in a materialized view.

**Q: An admin dashboard's revenue numbers are 3× too high, but only for some customers. How do you debug it? (Senior)**
A: "Only some" strongly suggests fan-out: customers with multiple rows in a second joined relation get multiplied. I'd print `str(qs.query)` and look for more than one LEFT JOIN to multi-valued relations under a GROUP BY, then reproduce with a fixture of one order with three items. The fix is to move each aggregate to a subquery or compute `Sum(F("quantity")*F("unit_price"))` at the item level only. I'd add a regression test asserting exact totals for that fixture, and review other reports for the same pattern.

**Q: A correlated subquery annotation made a list endpoint go from 50 ms to 8 s. What happened and what are your options? (Senior)**
A: Most likely the inner query has no usable index, so PostgreSQL runs a sequential scan per outer row; `explain(analyze=True)` will show a SubPlan with Seq Scan and loops equal to the outer row count. Add a composite index matching the inner filter and order. If the endpoint sorts or filters by the annotation, the subquery is evaluated for every row before LIMIT — then consider a `LATERAL` join via raw SQL, a denormalised column, or computing the annotation only for the page of IDs already selected (two-step: pick IDs, then annotate `filter(pk__in=ids)`). Also confirm the annotation isn't duplicated by both a list and a count query in pagination.

**Q: What is `alias()` and why use it over `annotate()`?**
A: `alias()` (Django 3.2+) defines an expression you can reference in `filter()`, `exclude()`, `order_by()` or other expressions without adding it to the SELECT list. That saves computing and transferring a column you don't need, and it avoids the expression being part of GROUP BY. If you later need the value, you can `annotate()` it from the alias.

**Q: What does `Sum` return when there are no rows, and how do you handle it?**
A: SQL aggregates other than COUNT return NULL over an empty set, which Django turns into `None` — a common source of `TypeError` in templates and serializers. Since Django 4.0 aggregates accept `default=`, e.g. `Sum("total", default=0)`, which wraps it in `COALESCE`. In annotations and subqueries, wrap explicitly with `Coalesce(Subquery(...), Value(0))` and specify an `output_field` if types differ.

## 10. Quick Revision & Cheat Sheet

| Want | ORM | SQL |
|---|---|---|
| One total | `.aggregate(t=Sum("x", default=0))` | `SELECT COALESCE(SUM(x),0)` |
| Per object | `.annotate(n=Count("rel"))` | `LEFT JOIN … GROUP BY pk` |
| Per group | `.values("g").annotate(n=Count("id")).order_by()` | `GROUP BY g` |
| HAVING | `.annotate(n=...).filter(n__gt=3)` | `HAVING …` |
| Conditional | `Count("id", filter=Q(...))` | `COUNT(...) FILTER (WHERE …)` |
| Distinct count | `Count("customer", distinct=True)` | `COUNT(DISTINCT customer_id)` |
| Latest child col | `Subquery(qs.order_by("-t").values("c")[:1])` | correlated scalar subquery |
| Has child | `.filter(Exists(qs))` | `WHERE EXISTS(…)` |
| Bucketing | `Case(When(...), default=...)` | `CASE WHEN … END` |
| Rank in group | `Window(Rank(), partition_by=…, order_by=…)` | `RANK() OVER (…)` |
| Running total | `Window(Sum("a"), order_by=…, frame=RowRange(None, 0))` | `SUM() OVER (… ROWS …)` |
| Date bucket | `TruncMonth("created_at")` | `DATE_TRUNC('month', …)` |

- `aggregate` is terminal and returns a dict; `annotate` returns a QuerySet.
- `values()` before `annotate()` = GROUP BY; after = projection.
- Extra `order_by` fields leak into GROUP BY — clear with `.order_by()`.
- Two multi-valued joins in one aggregating query = multiplied results.
- `Count` over a relation uses LEFT JOIN (zero counts kept); a prior `filter` on the relation makes it INNER.
- Subquery: one column (`values`), one row (`[:1]`), index the correlated column.
- Empty `Sum` is `None`: `default=` or `Coalesce`.
- Filtering on window annotations works from 4.2 (Django wraps in a subquery).

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" "psycopg[binary]"`; create the bookshop models from §5.1 and a seeding command that builds 20 publishers, 200 authors, 5,000 books, 50 stores.

1. Write `aggregate` and `annotate` versions of "average price"; print `str(qs.query)` for each and explain the GROUP BY.
2. Produce `[{publisher, n_books, avg_rating}]` sorted by `n_books` desc. Then add `.order_by("title")` and explain the new result.
3. Reproduce the fan-out bug: annotate books with `Count("authors")` and `Count("stores")`, and publishers with `Count("books__authors")` plus `Sum("books__price")`; compute the true values in Python; fix with `distinct=True`, then with subqueries.
4. Annotate each author with the title and date of their newest book using `Subquery`, and filter authors with no book in any store using `~Exists`.
5. Top 2 highest-rated books per publisher using `Window(RowNumber())` + `filter(rn__lte=2)`; inspect the generated `qualify` subquery.
6. Add an index that makes exercise 4's subquery an index scan; prove it with `explain(analyze=True)`.

**Mini project:** a `/api/reports/sales/` endpoint (DRF or plain JSON view) returning monthly revenue, distinct customers, refund rate (conditional aggregation) and the top product per month (window), in at most three queries, with a test using `assertNumQueries` and hand-computed fixture totals.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) (Q, F, laziness), [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization) (annotations as an N+1 cure), [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) (denormalised counters with `F()`), [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres) (`ArrayAgg`, `StringAgg`, raw SQL), [Ch 39 · ORM Coding Round](topic.html?p=39-orm-coding-challenges).

**Other handbooks:** [SQL · Group By](../sql/topic.html?p=07-group-by), [SQL · HAVING & Grouping Sets](../sql/topic.html?p=08-having-grouping-sets), [SQL · Subqueries](../sql/topic.html?p=10-subqueries), [SQL · Window Functions](../sql/topic.html?p=13-window-functions), [SQL · Ranking & Window Frames](../sql/topic.html?p=14-ranking-window-frames), [SQL · Conditional Logic](../sql/topic.html?p=15-conditional-logic), [SQL · Top-N per Group](../sql/topic.html?p=34-problem-top-n-per-group).

- **Aggregation topic guide** — Django docs · *Beginner* · the canonical explanation of aggregate vs annotate, ordering interactions, and the multiple-aggregation warning. <https://docs.djangoproject.com/en/5.2/topics/db/aggregation/>
- **Query expressions reference** — Django docs · *Intermediate* · F, Func, Subquery, OuterRef, Exists, Window and output_field. <https://docs.djangoproject.com/en/5.2/ref/models/expressions/>
- **Conditional expressions** — Django docs · *Intermediate* · Case/When and conditional aggregation. <https://docs.djangoproject.com/en/5.2/ref/models/conditional-expressions/>
- **Database functions** — Django docs · *Intermediate* · Coalesce, Trunc/Extract, text and math functions, window functions. <https://docs.djangoproject.com/en/5.2/ref/models/database-functions/>
- **PostgreSQL-specific aggregates** — Django docs · *Intermediate* · ArrayAgg, StringAgg, JSONBAgg and friends. <https://docs.djangoproject.com/en/5.2/ref/contrib/postgres/aggregates/>
- **PostgreSQL tutorial: window functions** — PostgreSQL docs · *Beginner* · what OVER/PARTITION BY actually compute. <https://www.postgresql.org/docs/current/tutorial-window.html>

---

*Django Handbook — chapter 12.*
