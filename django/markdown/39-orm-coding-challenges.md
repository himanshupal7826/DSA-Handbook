# 39 · ORM Coding Round: Query Challenges

> **In one line:** The ORM live-coding round tests one skill — translating a business question into a single, correct, index-friendly QuerySet and being able to say what SQL it produces — so this chapter drills 35 problems on one shared schema, each with the solution, the real generated PostgreSQL, an index note and the wrong answer interviewers watch for.

---

## 1. Overview

> **Builds on:** [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups), [Ch 12 · Aggregation, Annotation, Subqueries & Window Functions](topic.html?p=12-aggregation-annotation-subqueries), [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization), [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency), [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres).

Most Django interviews for mid and senior roles include a 30–45 minute **ORM round**. You get a few models (on a shared doc, CoderPad, or a whiteboard) and a sequence of questions that escalate: "list the books by this publisher" → "count books per publisher, including publishers with none" → "top three books per genre" → "users whose gap between orders exceeded 90 days". Sometimes there's a Django shell; often there isn't, and you're judged on whether your QuerySet *would* work and whether you can describe the SQL.

Candidates fail this round in predictable ways:

- **Python loops instead of SQL.** `[a for a in Author.objects.all() if a.books.count() == 0]` gets the right answer with N+1 queries. The interviewer stops listening.
- **Right shape, wrong semantics.** Two `Count`s over two different joins (the fan-out bug), `exclude()` with two conditions on a multi-valued relation, `annotate()` before `values()` when you meant GROUP BY. These return plausible-looking wrong numbers — the worst kind of bug.
- **No idea what SQL is produced.** The follow-up "what query does that generate, and what index helps?" is where seniority shows.
- **Not knowing the limits.** The ORM cannot put a window over an aggregate, cannot write a recursive CTE, and duplicates correlated subqueries when you filter on them. Knowing when to reach for `raw()` is a senior signal.

Every solution below was run against PostgreSQL with Django 5.2; the SQL shown is what Django emitted (long column lists trimmed with `...`). Problems escalate through §3 (warm-up), §4 (aggregation), §5 (subqueries), §6 (window functions), §7 (writes and data quality) and §8 (performance and the ORM's limits).

> **Interview tip:** Narrate in this order: *shape of the result* (one row per what?) → *which table drives* → *joins or subqueries* → *QuerySet* → *SQL* → *index*. Saying "one row per publisher, so I start from `Publisher` and LEFT JOIN books" before typing is worth more than typing fast.

## 2. Core Concepts

### 2.1 The shared schema (used by every problem)

```python
# shop/models.py
from django.conf import settings
from django.db import models


class Publisher(models.Model):
    name = models.CharField(max_length=200, unique=True)
    country = models.CharField(max_length=2)  # ISO code


class Author(models.Model):
    name = models.CharField(max_length=200)
    born = models.DateField(null=True, blank=True)
    mentor = models.ForeignKey("self", null=True, blank=True,
                               on_delete=models.SET_NULL, related_name="mentees")


class Tag(models.Model):
    name = models.SlugField(unique=True)


class Book(models.Model):
    class Genre(models.TextChoices):
        FICTION = "fiction"
        TECH = "tech"
        HISTORY = "history"

    title = models.CharField(max_length=300)
    author = models.ForeignKey(Author, on_delete=models.PROTECT, related_name="books")
    publisher = models.ForeignKey(Publisher, on_delete=models.PROTECT, related_name="books")
    genre = models.CharField(max_length=20, choices=Genre.choices)
    price = models.DecimalField(max_digits=8, decimal_places=2)
    stock = models.PositiveIntegerField(default=0)
    published_on = models.DateField()
    tags = models.ManyToManyField(Tag, related_name="books", blank=True)

    class Meta:
        indexes = [models.Index(fields=["genre", "-published_on"])]


class Order(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending"
        PAID = "paid"
        REFUNDED = "refunded"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                             related_name="orders")
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    total = models.DecimalField(max_digits=10, decimal_places=2, default=0)


class OrderItem(models.Model):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="items")
    book = models.ForeignKey(Book, on_delete=models.PROTECT, related_name="order_items")
    quantity = models.PositiveIntegerField()
    unit_price = models.DecimalField(max_digits=8, decimal_places=2)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["order", "book"], name="uniq_order_book")]


class Review(models.Model):
    book = models.ForeignKey(Book, on_delete=models.CASCADE, related_name="reviews")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                             related_name="reviews")
    rating = models.PositiveSmallIntegerField()  # 1..5
    body = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
```

All snippets assume these imports:

```python
import datetime as dt
from decimal import Decimal

from django.contrib.auth.models import User
from django.db.models import (Avg, Count, DecimalField, Exists, F, Max, Min, OuterRef,
                              Prefetch, Q, Subquery, Sum, Value, Window)
from django.db.models.functions import (Coalesce, DenseRank, Lag, Lower, Rank, RowNumber,
                                        TruncDate, TruncMonth)
from shop.models import Author, Book, Order, OrderItem, Publisher, Review, Tag
```

### 2.2 The toolbox, by question shape

- **"Rows matching a condition"** → `filter()`, `Q` for OR/NOT, `F` to compare columns. *Why it matters:* no GROUP BY, one pass.
- **"One row per X with a number"** → start from X, `annotate(Count/Sum/...)`. *Why it matters:* the model you start from decides LEFT vs INNER join and whether zero-rows appear.
- **"Group by an expression"** → `values(expr).annotate(agg)` — **values first, then annotate**. *Why it matters:* `annotate()` then `values()` is per-row, not grouped.
- **"Count only some children"** → `Count("rel", filter=Q(...))` → `COUNT(...) FILTER (WHERE ...)` on PostgreSQL.
- **"Has / has-not related row"** → `Exists(...)` / `~Exists(...)`. *Why it matters:* semi-joins don't duplicate rows and short-circuit.
- **"Value from the latest/first related row"** → `Subquery(qs.order_by(...).values("col")[:1])` with `OuterRef`.
- **"Rank / top-N per group / running total / previous row"** → `Window(RowNumber() | Rank() | DenseRank() | Sum() | Lag(), partition_by=..., order_by=...)`; since Django 4.2 you can `.filter()` on a window annotation.
- **"Change many rows safely"** → `update(col=F(...))`, `filter(guard).update(...)`, `bulk_create(update_conflicts=True, ...)`.

## 3. Theory & Principles

Warm-up problems — what a screening round asks. The theory behind every one of them: **a QuerySet is a SQL statement you build incrementally**, and every `__` that crosses a relation adds a JOIN (forward FK → INNER JOIN when the filter requires a match; reverse/M2M → a join that can multiply rows).

### Problem 1 — Filter across a relation and a date part

**Question:** Penguin books published in 2024 that cost less than 40.

```python
Book.objects.filter(publisher__name="Penguin", published_on__year=2024, price__lt=40)
```

```sql
SELECT ... FROM "shop_book"
INNER JOIN "shop_publisher" ON ("shop_book"."publisher_id" = "shop_publisher"."id")
WHERE ("shop_book"."price" < 40
   AND "shop_book"."published_on" BETWEEN '2024-01-01'::date AND '2024-12-31'::date
   AND "shop_publisher"."name" = 'Penguin')
```

**Index note:** `__year` on a `DateField` compiles to a `BETWEEN` range, so an index on `published_on` is usable — unlike `EXTRACT(YEAR ...)`. `publisher.name` is already indexed by `unique=True`.
**Common wrong answer:** `Book.objects.filter(publisher=Publisher.objects.get(name="Penguin"))` — two queries and a `DoesNotExist` crash when the publisher is missing; or `published_on__contains="2024"` on a date.

### Problem 2 — OR and NOT with Q

**Question:** Books whose title contains "django" (any case) or that were written by Ana, excluding history books.

```python
Book.objects.filter(
    (Q(title__icontains="django") | Q(author__name="Ana")) & ~Q(genre=Book.Genre.HISTORY)
)
```

```sql
SELECT ... FROM "shop_book" INNER JOIN "shop_author" ON (...)
WHERE ((UPPER("shop_book"."title"::text) LIKE UPPER('%django%') OR "shop_author"."name" = 'Ana')
   AND NOT ("shop_book"."genre" = 'history'))
```

**Index note:** a leading-wildcard `LIKE` can't use a B-tree; for real search use a `pg_trgm` GIN index (`GinIndex(OpClass(Upper("title"), name="gin_trgm_ops"))`) or full-text search (Ch 16).
**Common wrong answer:** `filter(title__icontains="django").filter(author__name="Ana")` — that's AND, not OR. Another: `Q(...) or Q(...)` with Python's `or`, which silently returns just the first `Q`.

### Problem 3 — Compare two columns with F

**Question:** Order items sold below the book's current list price.

```python
OrderItem.objects.filter(unit_price__lt=F("book__price")).select_related("book")
```

```sql
SELECT ... FROM "shop_orderitem"
INNER JOIN "shop_book" ON ("shop_orderitem"."book_id" = "shop_book"."id")
WHERE "shop_orderitem"."unit_price" < ("shop_book"."price")
```

**Index note:** a column-vs-column predicate can't use an index on either column alone; the planner will hash-join and filter. Fine for analytics, slow on a hot path.
**Common wrong answer:** a Python loop `[i for i in OrderItem.objects.all() if i.unit_price < i.book.price]` — N+1 and full table into memory.

### Problem 4 — Rows with no related rows (anti-join)

**Question:** Authors who have no books.

```python
Author.objects.filter(books__isnull=True)
# equivalent, often clearer:  Author.objects.filter(~Exists(Book.objects.filter(author=OuterRef("pk"))))
```

```sql
SELECT ... FROM "shop_author"
LEFT OUTER JOIN "shop_book" ON ("shop_author"."id" = "shop_book"."author_id")
WHERE "shop_book"."id" IS NULL
```

**Index note:** every `ForeignKey` gets an index on its column by default (`db_index=True`), which is what makes this anti-join cheap; PostgreSQL usually plans it as a hash anti-join.
**Common wrong answer:** `[a for a in Author.objects.all() if not a.books.exists()]` (N+1), or `Author.objects.annotate(n=Count("books")).filter(n=0)` — correct but aggregates every author's books just to find zeros.

### Problem 5 — The `exclude()` multi-valued trap

**Question:** Users who did **not** place a *paid* order in 2025.

```python
paid_2025 = Order.objects.filter(user=OuterRef("pk"), status="paid", created_at__year=2025)
User.objects.filter(~Exists(paid_2025))
```

```sql
SELECT ... FROM "auth_user"
WHERE NOT EXISTS(SELECT 1 AS "a" FROM "shop_order" U0
                 WHERE (U0."created_at" BETWEEN '2025-01-01 00:00:00+00:00'::timestamptz
                                            AND '2025-12-31 23:59:59.999999+00:00'::timestamptz
                        AND U0."status" = 'paid' AND U0."user_id" = ("auth_user"."id")) LIMIT 1)
```

**Index note:** composite `Index(fields=["user", "status", "created_at"])` turns each probe into an index-only lookup.
**Common wrong answer:** `User.objects.exclude(orders__status="paid", orders__created_at__year=2025)`. The docs warn that conditions inside one `exclude()` on a multi-valued relation **need not refer to the same row**; Django emits two independent `EXISTS` clauses ("has *some* 2025 order" AND "has *some* paid order") and negates the conjunction. On our test data the correct query returned 8 users; the `exclude()` version returned 2.

```sql
-- what the wrong answer generates
WHERE NOT (EXISTS(SELECT 1 FROM "shop_order" U1 WHERE U1."created_at" BETWEEN ... AND U1."user_id" = "auth_user"."id")
       AND EXISTS(SELECT 1 FROM "shop_order" U1 WHERE U1."status" = 'paid' AND U1."user_id" = "auth_user"."id"))
```

## 4. Architecture & Workflow

Aggregation problems. The architecture to keep in your head: **the model you start from is the GROUP BY key**; `annotate()` on a model groups by its primary key; `values(...).annotate(...)` groups by the listed values; and every join to a *many* side multiplies rows *before* aggregation runs.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj39a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="dj39b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The join fan-out: two Count()s over two many-relations</text>
  <rect x="20" y="40" width="200" height="120" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="120" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Book #2</text>
  <text x="120" y="84" text-anchor="middle" fill="#334155" font-size="10">reviews: R1 R2 R3 R4 R5</text>
  <text x="120" y="102" text-anchor="middle" fill="#334155" font-size="10">order items: 2 rows</text>
  <text x="120" y="120" text-anchor="middle" fill="#334155" font-size="10">(quantity 3 + 4 = 7)</text>
  <text x="120" y="144" text-anchor="middle" fill="#2563eb" font-size="10" font-weight="bold">truth: 5 reviews, 7 units</text>
  <path d="M220,100 L262,100" stroke="#dc2626" stroke-width="2" marker-end="url(#dj39a)"/>
  <rect x="264" y="40" width="300" height="200" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="414" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">LEFT JOIN review LEFT JOIN orderitem</text>
  <text x="414" y="82" text-anchor="middle" fill="#334155" font-size="10">every review paired with every item</text>
  <text x="290" y="106" fill="#334155" font-size="10">R1 x item(3)   R1 x item(4)</text>
  <text x="290" y="124" fill="#334155" font-size="10">R2 x item(3)   R2 x item(4)</text>
  <text x="290" y="142" fill="#334155" font-size="10">R3 x item(3)   R3 x item(4)</text>
  <text x="290" y="160" fill="#334155" font-size="10">R4 x item(3)   R4 x item(4)</text>
  <text x="290" y="178" fill="#334155" font-size="10">R5 x item(3)   R5 x item(4)</text>
  <text x="414" y="204" text-anchor="middle" fill="#dc2626" font-size="10" font-weight="bold">5 x 2 = 10 rows before GROUP BY</text>
  <text x="414" y="224" text-anchor="middle" fill="#dc2626" font-size="10">COUNT(review) = 10, SUM(quantity) = 35</text>
  <path d="M564,100 L606,100" stroke="#16a34a" stroke-width="2" marker-end="url(#dj39b)"/>
  <rect x="608" y="40" width="252" height="200" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="734" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Fixes</text>
  <text x="622" y="86" fill="#334155" font-size="10">Count("reviews", distinct=True)</text>
  <text x="622" y="102" fill="#334155" font-size="10">fixes COUNT only (not SUM)</text>
  <text x="622" y="130" fill="#334155" font-size="10">Subquery per relation:</text>
  <text x="622" y="146" fill="#334155" font-size="10">(SELECT SUM(qty) ... WHERE</text>
  <text x="622" y="162" fill="#334155" font-size="10">book_id = outer.id)</text>
  <text x="622" y="190" fill="#16a34a" font-size="10" font-weight="bold">one join path per aggregate</text>
  <text x="622" y="208" fill="#16a34a" font-size="10" font-weight="bold">= correct numbers</text>
  <rect x="20" y="260" width="840" height="124" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="282" text-anchor="middle" fill="#1e293b" font-weight="bold">How the start model and values() decide GROUP BY</text>
  <text x="36" y="304" fill="#334155" font-size="10">Publisher.objects.annotate(n=Count("books"))                    &#8594; GROUP BY publisher.id, LEFT JOIN: zero-book publishers appear</text>
  <text x="36" y="324" fill="#334155" font-size="10">Book.objects.values("publisher__name").annotate(n=Count("id"))  &#8594; GROUP BY name, INNER JOIN from books: zero-book publishers vanish</text>
  <text x="36" y="344" fill="#334155" font-size="10">qs.values("month").annotate(Sum(...))                             &#8594; GROUP BY month (values BEFORE annotate)</text>
  <text x="36" y="364" fill="#334155" font-size="10">qs.annotate(Sum(...)).values("month")                             &#8594; GROUP BY pk: one row per object, not per month</text>
</svg>
```

### Problem 6 — Count per parent, including zeros

**Question:** Number of books per publisher, most first, including publishers with no books.

```python
Publisher.objects.annotate(n=Count("books")).order_by("-n")
```

```sql
SELECT "shop_publisher"."name", COUNT("shop_book"."id") AS "n" FROM "shop_publisher"
LEFT OUTER JOIN "shop_book" ON ("shop_publisher"."id" = "shop_book"."publisher_id")
GROUP BY "shop_publisher"."id" ORDER BY 2 DESC
```

Result on test data: `[('Manning', 10), ('OReilly', 10), ('Penguin', 10), ('Empty Press', 0)]`.
**Index note:** the FK index on `book.publisher_id` drives the join. `COUNT("shop_book"."id")` (not `COUNT(*)`) is what makes the zero correct under a LEFT JOIN.
**Common wrong answer:** `Book.objects.values("publisher__name").annotate(n=Count("id"))` — starts from books, so "Empty Press" is missing.

### Problem 7 — Group by an expression (monthly revenue)

**Question:** Revenue and order count per calendar month, paid orders only.

```python
(Order.objects.filter(status="paid")
    .annotate(month=TruncMonth("created_at"))
    .values("month")
    .annotate(revenue=Sum("total"), orders=Count("id"))
    .order_by("month"))
```

```sql
SELECT DATE_TRUNC('month', "shop_order"."created_at" AT TIME ZONE 'UTC') AS "month",
       SUM("shop_order"."total") AS "revenue", COUNT("shop_order"."id") AS "orders"
FROM "shop_order" WHERE "shop_order"."status" = 'paid'
GROUP BY 1 ORDER BY 1 ASC
```

**Index note:** with `USE_TZ=True` the truncation happens in the *current* time zone (`AT TIME ZONE`) — activate the business time zone or pass `tzinfo=` or your month boundaries are wrong for non-UTC customers. A partial index `Index(fields=["created_at"], condition=Q(status="paid"))` serves the filter.
**Common wrong answer:** `.annotate(revenue=Sum("total")).values("month")` — annotate before values groups by `id`, giving one row per order.

### Problem 8 — Conditional aggregation

**Question:** For every author: total books, tech books, and books published since 2023 — in one query.

```python
Author.objects.annotate(
    total=Count("books"),
    tech=Count("books", filter=Q(books__genre="tech")),
    recent=Count("books", filter=Q(books__published_on__gte=dt.date(2023, 1, 1))),
)
```

```sql
SELECT "shop_author"."name", COUNT("shop_book"."id") AS "total",
       COUNT("shop_book"."id") FILTER (WHERE "shop_book"."genre" = 'tech') AS "tech",
       COUNT("shop_book"."id") FILTER (WHERE "shop_book"."published_on" >= '2023-01-01'::date) AS "recent"
FROM "shop_author" LEFT OUTER JOIN "shop_book" ON ("shop_author"."id" = "shop_book"."author_id")
GROUP BY "shop_author"."id"
```

**Index note:** one scan of the join produces all three numbers. On databases without `FILTER`, Django emits `COUNT(CASE WHEN ... THEN ... END)`.
**Common wrong answer:** three separate queries, or `Sum(Case(When(books__genre="tech", then=1), default=0))` — works but is the pre-2.0 idiom; `filter=` is clearer.

### Problem 9 — HAVING, and why filter order matters

**Question:** Users with at least three **paid** orders, with their average paid order value.

```python
(User.objects.filter(orders__status="paid")
    .annotate(n=Count("orders"), aov=Avg("orders__total"))
    .filter(n__gte=3))
```

```sql
SELECT "auth_user"."username", COUNT("shop_order"."id") AS "n", AVG("shop_order"."total") AS "aov"
FROM "auth_user" INNER JOIN "shop_order" ON ("auth_user"."id" = "shop_order"."user_id")
WHERE "shop_order"."status" = 'paid'
GROUP BY "auth_user"."id" HAVING COUNT("shop_order"."id") >= 3
```

**Index note:** `(user_id, status)` composite index. The filter *before* `annotate()` becomes `WHERE` and restricts the rows being aggregated; the filter *after* becomes `HAVING`.
**Common wrong answer:** `User.objects.annotate(n=Count("orders")).filter(orders__status="paid", n__gte=3)` — the status filter after annotate adds a **second** join, and `n` counts all orders, not paid ones. Equivalent correct alternative: `annotate(n=Count("orders", filter=Q(orders__status="paid")))`.

### Problem 10 — Two aggregates over two relations (fan-out)

**Question:** For each book, the number of reviews and total units sold.

```python
units_sold = (OrderItem.objects.filter(book=OuterRef("pk"))
              .values("book").annotate(s=Sum("quantity")).values("s"))
Book.objects.annotate(
    n_reviews=Count("reviews", distinct=True),
    units=Coalesce(Subquery(units_sold), 0),
)
```

```sql
SELECT "shop_book"."id", COUNT(DISTINCT "shop_review"."id") AS "n_reviews",
       COALESCE((SELECT SUM(U0."quantity") AS "s" FROM "shop_orderitem" U0
                 WHERE U0."book_id" = ("shop_book"."id") GROUP BY U0."book_id"), 0) AS "units"
FROM "shop_book" LEFT OUTER JOIN "shop_review" ON ("shop_book"."id" = "shop_review"."book_id")
GROUP BY 1, 3
```

On test data book #2 correctly shows `(5 reviews, 7 units)`.
**Index note:** the subquery is a per-book index probe on `orderitem.book_id`. The `.values("book").annotate(...).values("s")` dance forces a GROUP BY inside the subquery so it returns exactly one value.
**Common wrong answer:** `annotate(n_reviews=Count("reviews"), units=Sum("order_items__quantity"))` returned `(20, 35)` for the same book — both joins in one FROM multiply each other (see the diagram above). `distinct=True` rescues `Count`, but there is no safe `distinct` for `Sum`.

### Problem 11 — Top-N by an aggregate

**Question:** The ten best-selling books by units in paid orders, with revenue.

```python
(Book.objects.filter(order_items__order__status="paid")
    .annotate(units=Sum("order_items__quantity"),
              revenue=Sum(F("order_items__quantity") * F("order_items__unit_price")))
    .order_by("-units", "id")[:10])
```

```sql
SELECT "shop_book"."title", SUM("shop_orderitem"."quantity") AS "units",
       SUM(("shop_orderitem"."quantity" * "shop_orderitem"."unit_price")) AS "revenue"
FROM "shop_book"
INNER JOIN "shop_orderitem" ON ("shop_book"."id" = "shop_orderitem"."book_id")
INNER JOIN "shop_order" ON ("shop_orderitem"."order_id" = "shop_order"."id")
WHERE "shop_order"."status" = 'paid'
GROUP BY "shop_book"."id" ORDER BY 2 DESC, "shop_book"."id" ASC LIMIT 10
```

**Index note:** both sums use the *same* join path, so there is no fan-out. `Integer * Decimal` resolves to `DecimalField` automatically in modern Django; for exotic mixes pass `output_field=DecimalField(...)`. The `"id"` tiebreaker makes the top 10 deterministic.
**Common wrong answer:** `.order_by("-units")[:10]` without a tiebreak — pagination and "top N" become non-deterministic on ties.

### Problem 12 — Aggregating through a many-to-many

**Question:** Tags in use, by number of books.

```python
Tag.objects.annotate(n=Count("books")).filter(n__gt=0).order_by("-n")
```

```sql
SELECT "shop_tag"."name", COUNT("shop_book_tags"."book_id") AS "n" FROM "shop_tag"
LEFT OUTER JOIN "shop_book_tags" ON ("shop_tag"."id" = "shop_book_tags"."tag_id")
GROUP BY "shop_tag"."id" HAVING COUNT("shop_book_tags"."book_id") > 0 ORDER BY 2 DESC
```

**Index note:** Django counts the through table's `book_id` directly — it never joins `shop_book` because it doesn't need any book column. The auto-created through table has a unique index on `(book_id, tag_id)` plus an index on `tag_id`.
**Common wrong answer:** `Tag.objects.filter(books__isnull=False).annotate(n=Count("books"))` — the extra filter adds a second join and doubles counts.

## 5. Implementation

Subquery problems. `OuterRef("col")` refers to the outer query's row; `Subquery(qs)` must return **one column** and, in a SELECT position, **at most one row** (slice `[:1]`); `Exists(qs)` is a boolean you can filter on directly.

### Problem 13 — Latest row per group (three ways)

**Question:** The latest order of each user (the whole row, not just the date).

```python
# (a) correlated subquery — portable
latest_id = (Order.objects.filter(user=OuterRef("user"))
             .order_by("-created_at", "-id").values("pk")[:1])
Order.objects.filter(pk=Subquery(latest_id))

# (b) PostgreSQL DISTINCT ON — usually fastest
Order.objects.order_by("user_id", "-created_at", "-id").distinct("user_id")

# (c) just the timestamp
User.objects.annotate(last_order_at=Max("orders__created_at"))
```

```sql
-- (a)
SELECT ... FROM "shop_order" WHERE "shop_order"."id" =
  (SELECT U0."id" FROM "shop_order" U0 WHERE U0."user_id" = ("shop_order"."user_id")
   ORDER BY U0."created_at" DESC, U0."id" DESC LIMIT 1)
-- (b)
SELECT DISTINCT ON ("shop_order"."user_id") ... FROM "shop_order" ORDER BY 1 ASC, 3 DESC, 2 DESC
```

**Index note:** `Index(fields=["user", "-created_at", "-id"])` makes (a) one index probe per user and (b) a single ordered index scan. `distinct(*fields)` requires the `order_by` to *start* with the same fields.
**Common wrong answer:** `Order.objects.values("user").annotate(Max("created_at"))` and then "join back on the timestamp" — two users' orders can share a timestamp, and you've lost the order id.

### Problem 14 — Pull a column from the latest child

**Question:** Each book with the text and rating of its most recent review.

```python
latest = Review.objects.filter(book=OuterRef("pk")).order_by("-created_at", "-id")
Book.objects.annotate(
    latest_body=Subquery(latest.values("body")[:1]),
    latest_rating=Subquery(latest.values("rating")[:1]),
)
```

```sql
SELECT "shop_book"."id",
  (SELECT U0."body" FROM "shop_review" U0 WHERE U0."book_id" = ("shop_book"."id")
   ORDER BY U0."created_at" DESC, U0."id" DESC LIMIT 1) AS "latest_body",
  (SELECT U0."rating" FROM "shop_review" U0 WHERE U0."book_id" = ("shop_book"."id")
   ORDER BY U0."created_at" DESC, U0."id" DESC LIMIT 1) AS "latest_rating"
FROM "shop_book"
```

**Index note:** two correlated subqueries means two probes per book; index `(book_id, created_at DESC)`. If you need many columns, `Prefetch("reviews", queryset=Review.objects.order_by("book_id", "-created_at").distinct("book_id"), to_attr="latest")` fetches whole rows in one extra query.
**Common wrong answer:** `Subquery(latest.values("body"))` without `[:1]` → "more than one row returned by a subquery used as an expression" at runtime.

### Problem 15 — Never-ordered books (NOT EXISTS vs NOT IN)

**Question:** Books that have never appeared in any order.

```python
Book.objects.filter(~Exists(OrderItem.objects.filter(book=OuterRef("pk"))))
```

```sql
SELECT ... FROM "shop_book" WHERE NOT EXISTS(
  SELECT 1 AS "a" FROM "shop_orderitem" U0 WHERE U0."book_id" = ("shop_book"."id") LIMIT 1)
```

**Index note:** PostgreSQL plans this as a hash/merge anti-join using the FK index.
**Common wrong answer:** `Book.objects.exclude(id__in=list(OrderItem.objects.values_list("book_id", flat=True)))` — pulls every order item into Python and sends a giant literal list. Without `list()`, `exclude(id__in=<subquery>)` is fine here, but `NOT IN` returns *no rows at all* if the subquery yields a `NULL` — `NOT EXISTS` has no such trap.

### Problem 16 — Compare a row to its group's aggregate

**Question:** Books priced above their publisher's average price.

```python
pub_avg = (Book.objects.filter(publisher=OuterRef("publisher"))
           .values("publisher").annotate(a=Avg("price")).values("a"))
Book.objects.alias(pub_avg=Subquery(pub_avg)).filter(price__gt=F("pub_avg"))

# window alternative (Django 4.2+ can filter on windows):
Book.objects.annotate(pub_avg=Window(Avg("price"), partition_by=F("publisher"))
                      ).filter(price__gt=F("pub_avg"))
```

```sql
-- window version
SELECT * FROM ( SELECT "shop_book"."id", "shop_book"."price",
       AVG("shop_book"."price") OVER (PARTITION BY "shop_book"."publisher_id") AS "pub_avg"
       FROM "shop_book" ) "qualify"
WHERE "price" > ("pub_avg")
```

**Index note:** the subquery version runs one grouped probe per book (index on `publisher_id`); the window version scans once and sorts by publisher — usually better for "all rows". Using `alias()` instead of `annotate()` keeps the subquery out of the SELECT list; with `annotate()` Django repeats the subquery in both SELECT and WHERE.
**Common wrong answer:** `Book.objects.filter(price__gt=Avg("price"))` — `FieldError`; aggregates can't appear in a WHERE.

### Problem 17 — Relational division ("bought all of them")

**Question:** Users who bought **every** history book published in 2024.

```python
target = Book.objects.filter(genre="history", published_on__year=2024)
n = target.count()
(User.objects.filter(orders__status="paid", orders__items__book__in=target)
    .annotate(k=Count("orders__items__book", distinct=True))
    .filter(k=n))
```

```sql
SELECT ... FROM "auth_user"
INNER JOIN "shop_order" ON (...) INNER JOIN "shop_orderitem" ON (...)
WHERE ("shop_orderitem"."book_id" IN (SELECT U0."id" FROM "shop_book" U0
       WHERE (U0."genre" = 'history' AND U0."published_on" BETWEEN ... AND ...))
   AND "shop_order"."status" = 'paid')
GROUP BY "auth_user"."id" HAVING COUNT(DISTINCT "shop_orderitem"."book_id") = 2
```

**Index note:** two queries (the count, then the division); the `IN (subquery)` stays in the database. `distinct=True` is essential — buying the same book in two orders must count once.
**Common wrong answer:** `User.objects.filter(orders__items__book__in=target)` — that's "bought *any* of them", plus duplicate users without `.distinct()`.

### Problem 18 — Conditions on *different* related rows (retention)

**Question:** Users who ordered in **both** January and February 2026.

```python
def ordered_between(start, end):
    return Exists(Order.objects.filter(user=OuterRef("pk"), created_at__gte=start, created_at__lt=end))

jan, feb, mar = (dt.datetime(2026, m, 1, tzinfo=dt.UTC) for m in (1, 2, 3))
User.objects.filter(ordered_between(jan, feb), ordered_between(feb, mar))
```

```sql
SELECT ... FROM "auth_user"
WHERE (EXISTS(SELECT 1 FROM "shop_order" U0 WHERE (U0."created_at" >= '2026-01-01 ...' AND U0."created_at" < '2026-02-01 ...' AND U0."user_id" = ("auth_user"."id")) LIMIT 1)
   AND EXISTS(SELECT 1 FROM "shop_order" U0 WHERE (U0."created_at" >= '2026-02-01 ...' AND U0."created_at" < '2026-03-01 ...' AND U0."user_id" = ("auth_user"."id")) LIMIT 1))
```

**Index note:** `(user_id, created_at)` index; half-open ranges (`>=`/`<`) avoid the 23:59:59.999999 edge.
**Common wrong answer:** putting both ranges inside **one** `filter()` call: within a single `filter()`, conditions on a multi-valued relation apply to the *same* order row, so "an order in January that is also in February" → always empty. Chaining `.filter(jan range).filter(feb range)` is correct (it creates two joins — `INNER JOIN "shop_order" ... INNER JOIN "shop_order" T3`) but multiplies rows; `Exists` is cleaner and duplicate-free.

## 6. Advantages, Disadvantages & Trade-offs

Window-function problems. A `Window` computes a value per row over a *partition* without collapsing rows. Since Django 4.2 you can `filter()` on a window annotation: Django wraps the query in an outer `SELECT * FROM (...) "qualify" WHERE ...`, because SQL forbids window functions in WHERE.

```svg
<svg viewBox="0 0 880 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj39c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Top-3 per genre: ROW_NUMBER over partitions, then the "qualify" wrapper</text>
  <rect x="20" y="40" width="380" height="300" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="210" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Inner SELECT: window per partition</text>
  <rect x="36" y="72" width="348" height="118" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="48" y="90" fill="#2563eb" font-size="10" font-weight="bold">PARTITION genre = fiction (ORDER BY price DESC, id)</text>
  <text x="48" y="110" fill="#334155" font-size="10">Book 27   59.00   rn = 1</text>
  <text x="48" y="128" fill="#334155" font-size="10">Book 15   57.00   rn = 2</text>
  <text x="48" y="146" fill="#334155" font-size="10">Book 12   53.00   rn = 3</text>
  <text x="48" y="164" fill="#94a3b8" font-size="10">Book 18   40.00   rn = 4</text>
  <text x="48" y="180" fill="#94a3b8" font-size="10">...</text>
  <rect x="36" y="200" width="348" height="124" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="48" y="218" fill="#d97706" font-size="10" font-weight="bold">PARTITION genre = history</text>
  <text x="48" y="238" fill="#334155" font-size="10">Book 20   54.00   rn = 1</text>
  <text x="48" y="256" fill="#334155" font-size="10">Book 17   47.00   rn = 2</text>
  <text x="48" y="274" fill="#334155" font-size="10">Book 26   42.00   rn = 3</text>
  <text x="48" y="292" fill="#94a3b8" font-size="10">Book 23   41.00   rn = 4</text>
  <text x="48" y="310" fill="#334155" font-size="10">numbering restarts in every partition</text>
  <path d="M400,190 L448,190" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj39c)"/>
  <rect x="450" y="40" width="410" height="150" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="655" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Outer SELECT added by Django 4.2+</text>
  <text x="466" y="84" fill="#334155" font-size="10">SELECT * FROM ( inner ... ) "qualify"</text>
  <text x="466" y="102" fill="#334155" font-size="10">WHERE "rn" &lt;= 3</text>
  <text x="466" y="128" fill="#334155" font-size="10">SQL evaluates windows AFTER WHERE, so a window</text>
  <text x="466" y="146" fill="#334155" font-size="10">cannot be filtered in the same SELECT. The wrapper</text>
  <text x="466" y="164" fill="#334155" font-size="10">plays the role of QUALIFY (absent in PostgreSQL).</text>
  <rect x="450" y="206" width="410" height="134" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="655" y="226" text-anchor="middle" fill="#1e293b" font-weight="bold">Pick the ranking function deliberately</text>
  <text x="466" y="248" fill="#334155" font-size="10">RowNumber: 1,2,3,4 &#8212; exactly N per group (ties broken by id)</text>
  <text x="466" y="268" fill="#334155" font-size="10">Rank: 1,2,2,4 &#8212; ties share, gaps follow (may return more than N)</text>
  <text x="466" y="288" fill="#334155" font-size="10">DenseRank: 1,2,2,3 &#8212; ties share, no gaps ("Nth highest value")</text>
  <text x="466" y="314" fill="#dc2626" font-size="10" font-weight="bold">Always add a unique tiebreaker to order_by,</text>
  <text x="466" y="330" fill="#dc2626" font-size="10" font-weight="bold">or results change between runs.</text>
</svg>
```

### Problem 19 — Top-N per group

**Question:** The three most expensive books in each genre.

```python
Book.objects.annotate(
    rn=Window(RowNumber(), partition_by=F("genre"), order_by=[F("price").desc(), F("id").asc()])
).filter(rn__lte=3)
```

```sql
SELECT * FROM ( SELECT "shop_book"."genre", "shop_book"."title", "shop_book"."price",
       ROW_NUMBER() OVER (PARTITION BY "shop_book"."genre"
                          ORDER BY "shop_book"."price" DESC, "shop_book"."id" ASC) AS "rn"
       FROM "shop_book" ) "qualify"
WHERE "rn" <= 3
```

**Index note:** an index on `(genre, price DESC, id)` lets PostgreSQL feed the window pre-sorted. On Django < 4.2, filtering on `rn` raised `NotSupportedError`; you'd use a `Subquery` per group or raw SQL.
**Common wrong answer:** looping over genres with `Book.objects.filter(genre=g).order_by("-price")[:3]` — fine for 3 genres, an N+1 for 3,000 categories.

### Problem 20 — Rank over an aggregate

**Question:** Top two books per genre by average rating, considering only books with at least two reviews.

```python
Book.objects.annotate(
    avg_rating=Avg("reviews__rating"),
    n=Count("reviews"),
    rk=Window(Rank(), partition_by=F("genre"), order_by=F("avg_rating").desc(nulls_last=True)),
).filter(n__gte=2, rk__lte=2)
```

```sql
SELECT * FROM ( SELECT "shop_book"."genre", "shop_book"."title",
       AVG("shop_review"."rating") AS "avg_rating",
       RANK() OVER (PARTITION BY "shop_book"."genre"
                    ORDER BY AVG("shop_review"."rating") DESC NULLS LAST) AS "rk"
       FROM "shop_book" LEFT OUTER JOIN "shop_review" ON (...)
       GROUP BY "shop_book"."id" HAVING COUNT("shop_review"."id") >= 2 ) "qualify"
WHERE "rk" <= 2
```

**Index note:** Django places `n__gte` in HAVING (inside) and `rk__lte` in the wrapper (outside), so ranking happens only among qualifying books — exactly the intended semantics. A window *ranking by* an aggregate is fine; a window *aggregating* an aggregate is not (Problem 22).
**Common wrong answer:** forgetting `nulls_last=True` — books with no reviews (`AVG = NULL`) sort *first* in PostgreSQL's `DESC` order.

### Problem 21 — Running total per user

**Question:** For each paid order, the user's cumulative spend up to and including it.

```python
Order.objects.filter(status="paid").annotate(
    running=Window(Sum("total"), partition_by=F("user"),
                   order_by=[F("created_at").asc(), F("id").asc()])
)
```

```sql
SELECT "shop_order"."user_id", "shop_order"."total",
       SUM("shop_order"."total") OVER (PARTITION BY "shop_order"."user_id"
            ORDER BY "shop_order"."created_at" ASC, "shop_order"."id" ASC) AS "running"
FROM "shop_order" WHERE "shop_order"."status" = 'paid'
```

**Index note:** index `(user_id, created_at, id)`. With `ORDER BY` in the window, the default frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` — rows with the *same* order key are peers and get the same total; the unique `id` tiebreak prevents that surprise. Use `frame=RowRange(start=None, end=0)` to be explicit.
**Common wrong answer:** a Python accumulator over `Order.objects.all()` — correct, but loads the table; or omitting `partition_by`, which gives a global running total.

### Problem 22 — Running total of a daily aggregate (an ORM limit)

**Question:** Daily paid revenue with a cumulative running total.

```python
(Order.objects.filter(status="paid")
    .annotate(day=TruncDate("created_at"))
    .annotate(revenue=Window(Sum("total"), partition_by=F("day")),
              running=Window(Sum("total"), order_by=F("day").asc()))
    .values("day", "revenue", "running")
    .distinct()
    .order_by("day"))
```

```sql
SELECT DISTINCT ("shop_order"."created_at" AT TIME ZONE 'UTC')::date AS "day",
  SUM("shop_order"."total") OVER (PARTITION BY ("shop_order"."created_at" AT TIME ZONE 'UTC')::date) AS "revenue",
  SUM("shop_order"."total") OVER (ORDER BY ("shop_order"."created_at" AT TIME ZONE 'UTC')::date ASC) AS "running"
FROM "shop_order" WHERE "shop_order"."status" = 'paid' ORDER BY 1 ASC
```

**Why this shape:** the natural answer — `values("day").annotate(revenue=Sum("total")).annotate(running=Window(Sum("revenue"), ...))` — raises `FieldError: Cannot compute Sum('revenue'): 'revenue' is an aggregate`. The ORM cannot nest a window around a GROUP BY aggregate. The trick: compute both numbers as windows over raw rows (the default `RANGE` frame makes all rows of a day peers, so each gets the cumulative total through that day), then `distinct()` collapses to one row per day.
**Common wrong answer:** `Window(Sum(Sum("total")))` — `FieldError` too. For anything more elaborate, write the CTE with `raw()` (Problem 35).

### Problem 23 — Share of a partition total

**Question:** Each paid order's percentage of that user's total paid spend.

```python
Order.objects.filter(status="paid").annotate(
    user_total=Window(Sum("total"), partition_by=F("user")),
    share=F("total") * 100 / F("user_total"),
)
```

```sql
SELECT "shop_order"."user_id", "shop_order"."total",
       SUM("shop_order"."total") OVER (PARTITION BY "shop_order"."user_id") AS "user_total",
       (("shop_order"."total" * 100) / SUM("shop_order"."total") OVER (PARTITION BY "shop_order"."user_id")) AS "share"
FROM "shop_order" WHERE "shop_order"."status" = 'paid'
```

**Index note:** no `order_by` in the window → the frame is the whole partition. Arithmetic referencing a window annotation is inlined, which is legal in a SELECT.
**Common wrong answer:** a `Subquery` that sums the user's orders per row — correct but one probe per order instead of one sort.

### Problem 24 — Previous row and gaps (Lag)

**Question:** Orders placed more than 90 days after the same user's previous order.

```python
(Order.objects
    .annotate(prev=Window(Lag("created_at"), partition_by=F("user"), order_by=F("created_at").asc()))
    .annotate(gap=F("created_at") - F("prev"))
    .filter(gap__gt=dt.timedelta(days=90)))
```

```sql
SELECT * FROM ( SELECT "shop_order"."user_id", ...,
       ("shop_order"."created_at" - LAG("shop_order"."created_at", 1) OVER
         (PARTITION BY "shop_order"."user_id" ORDER BY "shop_order"."created_at" ASC)) AS "gap"
       FROM "shop_order" ) "qualify"
WHERE "gap" > '90 days 0:00:00'::interval
```

**Index note:** `(user_id, created_at)`. `gap` is a `timedelta` on PostgreSQL (`interval`). The first order of every user has `prev = NULL`, so `gap` is NULL and drops out naturally.
**Common wrong answer:** a self-join "order o2 where o2.created_at < o1.created_at, take the max" with `Subquery` per row — works, but quadratic-ish and far slower than one `LAG`.

### Problem 25 — Dense rank over a filtered aggregate

**Question:** Rank authors by paid revenue (ties share a rank, no gaps); authors with no sales get 0.

```python
revenue = Sum(F("books__order_items__quantity") * F("books__order_items__unit_price"),
              filter=Q(books__order_items__order__status="paid"))
Author.objects.annotate(
    revenue=Coalesce(revenue, Value(Decimal("0"))),
    rnk=Window(DenseRank(), order_by=F("revenue").desc()),
)
```

```sql
SELECT "shop_author"."name",
  COALESCE(SUM(("shop_orderitem"."quantity" * "shop_orderitem"."unit_price"))
           FILTER (WHERE "shop_order"."status" = 'paid'), 0) AS "revenue",
  DENSE_RANK() OVER (ORDER BY COALESCE(SUM(...) FILTER (WHERE ...), 0) DESC) AS "rnk"
FROM "shop_author" LEFT OUTER JOIN "shop_book" ON (...)
LEFT OUTER JOIN "shop_orderitem" ON (...) LEFT OUTER JOIN "shop_order" ON (...)
GROUP BY "shop_author"."id"
```

**Index note:** the status condition lives in `FILTER`, not `WHERE`, so authors with zero paid sales survive the LEFT JOINs.
**Common wrong answer:** `Author.objects.filter(books__order_items__order__status="paid").annotate(...)` — the WHERE turns the LEFT JOINs into inner semantics and silently removes unsold authors.

### Problem 26 — The Nth highest distinct value

**Question:** The third-highest distinct book price.

```python
Book.objects.order_by("-price").values_list("price", flat=True).distinct()[2]
# or, to get the books at that price:
Book.objects.annotate(r=Window(DenseRank(), order_by=F("price").desc())).filter(r=3)
```

```sql
SELECT DISTINCT "shop_book"."price" FROM "shop_book" ORDER BY 1 DESC LIMIT 1 OFFSET 2
```

**Index note:** an index on `price` serves the ordered distinct scan.
**Common wrong answer:** `Book.objects.order_by("-price")[2]` — ignores duplicates (two books at the same price make "third" wrong). Also note `[2]` raises `IndexError` when fewer than three distinct prices exist; `.distinct()[2:3]` returns an empty list instead.

### Problem 27 — Month-over-month change (know when to stop)

**Question:** Monthly paid revenue and the change versus the previous month.

```python
monthly = list(
    Order.objects.filter(status="paid")
    .annotate(month=TruncMonth("created_at")).values("month")
    .annotate(revenue=Sum("total")).order_by("month")
)
prev = None
for row in monthly:                     # at most a few dozen rows
    row["delta"] = None if prev is None else row["revenue"] - prev
    prev = row["revenue"]
```

**Why:** `annotate(prev=Window(Lag(Sum("total")), order_by=F("month")))` compiles but PostgreSQL rejects it — `ProgrammingError: aggregate functions are not allowed in GROUP BY` — because Django adds the window expression to the GROUP BY. With a handful of aggregated rows, finishing in Python is the senior answer; for heavy reporting, a `raw()` CTE (`WITH m AS (SELECT ... GROUP BY 1) SELECT month, revenue, revenue - LAG(revenue) OVER (ORDER BY month) FROM m`) or a reporting view mapped with `managed = False`.
**Common wrong answer:** fighting the ORM for twenty minutes. Say the limit out loud and move on.

## 7. Common Mistakes & Best Practices

Writes and data-quality problems. These are the ones where a wrong answer is not just slow but **corrupts data**, so interviewers probe concurrency.

### Problem 28 — Find case-insensitive duplicates

**Question:** Emails used by more than one user (ignoring case), then the users involved.

```python
dups = (User.objects.annotate(email_l=Lower("email"))
        .values("email_l").annotate(n=Count("id")).filter(n__gt=1))
User.objects.annotate(email_l=Lower("email")).filter(email_l__in=dups.values("email_l")).order_by("email_l", "id")
```

```sql
SELECT LOWER("auth_user"."email") AS "email_l", "auth_user"."id" FROM "auth_user"
WHERE LOWER("auth_user"."email") IN (SELECT LOWER(U0."email") AS "email_l" FROM "auth_user" U0
                                     GROUP BY 1 HAVING COUNT(U0."id") > 1)
ORDER BY 1 ASC, 2 ASC
```

**Index note:** a functional index `Index(Lower("email"), name="user_email_lower")` serves both; prevent recurrence with `UniqueConstraint(Lower("email"), name="uniq_email_ci")` (Ch 16).
**Common wrong answer:** `values("email")` — misses `Ann@x.com` vs `ann@x.com`, which is exactly how duplicates sneak in.

### Problem 29 — Delete duplicates, keep the newest

**Question:** A bug let users review the same book several times. Delete all but each user's latest review per book.

```python
from django.db import transaction

extra = Review.objects.annotate(
    rn=Window(RowNumber(), partition_by=[F("user"), F("book")],
              order_by=[F("created_at").desc(), F("id").desc()])
).filter(rn__gt=1)

with transaction.atomic():
    deleted, per_model = Review.objects.filter(pk__in=extra.values("pk")).delete()
```

```sql
DELETE FROM "shop_review" WHERE "shop_review"."id" IN (
  SELECT "pk" FROM ( SELECT * FROM ( SELECT U0."id" AS "pk", ROW_NUMBER() OVER (
      PARTITION BY U0."user_id", U0."book_id" ORDER BY U0."created_at" DESC, U0."id" DESC) AS "qual0"
    FROM "shop_review" U0 ) "qualify" WHERE "qual0" > 1 ) "qualify_mask")
```

**Index note:** then add `UniqueConstraint(fields=["user", "book"], name="one_review_per_user_book")` in a migration so it can't recur. Because `Review` has no dependants and no signal receivers, Django can fast-delete in a single statement; with receivers or cascades it collects rows first.
**Common wrong answer:** `for r in Review.objects.all(): ...` comparing in Python, deleting one by one — thousands of queries, and racy without a lock.

### Problem 30 — Bulk update relative to the current value

**Question:** Raise all Manning book prices by 10% atomically.

```python
Book.objects.filter(publisher__name="Manning").update(price=F("price") * Decimal("1.10"))
```

```sql
UPDATE "shop_book" SET "price" = ("shop_book"."price" * 1.10)
WHERE "shop_book"."id" IN (SELECT U0."id" FROM "shop_book" U0
  INNER JOIN "shop_publisher" U1 ON (U0."publisher_id" = U1."id") WHERE U1."name" = 'Manning')
```

**Index note:** Django doesn't emit `UPDATE ... FROM`, so a filter across a relation becomes `id IN (subquery)`. The `numeric(8,2)` column rounds the result. `update()` returns the row count, skips `save()` and sends no `pre_save`/`post_save` signals.
**Common wrong answer:** `for b in qs: b.price *= Decimal("1.1"); b.save()` — N queries, and a lost update if another request changes a price between your read and write.

### Problem 31 — Conditional decrement (no overselling)

**Question:** Reserve `qty` copies of a book; fail if stock is insufficient, safely under concurrency.

```python
class OutOfStock(Exception):
    pass


def reserve(book_id: int, qty: int) -> None:
    updated = Book.objects.filter(pk=book_id, stock__gte=qty).update(stock=F("stock") - qty)
    if updated == 0:
        raise OutOfStock(book_id)
```

```sql
UPDATE "shop_book" SET "stock" = ("shop_book"."stock" - 3)
WHERE ("shop_book"."id" = 1 AND "shop_book"."stock" >= 3)
```

**Index note:** primary-key lookup; the row lock taken by `UPDATE` serialises concurrent reservations, and the guard is re-evaluated against the committed value under READ COMMITTED. As a backstop, `PositiveIntegerField` already creates a `CHECK ("stock" >= 0)` on PostgreSQL; on a plain `IntegerField` add `CheckConstraint(condition=Q(stock__gte=0), ...)` (`check=` before 5.1).
**Common wrong answer:** `b = Book.objects.get(pk=id); if b.stock >= qty: b.stock -= qty; b.save()` — read-modify-write race: two requests both see 1 in stock and both sell it. See [Ch 14](topic.html?p=14-transactions-concurrency) and the checkout round in [Ch 40](topic.html?p=40-design-rounds).

### Problem 32 — Upsert in bulk

**Question:** Sync a feed of publishers: insert new names, update the country of existing ones, in one statement.

```python
feed = [Publisher(name="Penguin", country="US"), Publisher(name="NoStarch", country="US")]
Publisher.objects.bulk_create(
    feed, update_conflicts=True, unique_fields=["name"], update_fields=["country"]
)
```

```sql
INSERT INTO "shop_publisher" ("name", "country")
SELECT * FROM UNNEST(('{Penguin,NoStarch}')::varchar[], ('{US,US}')::varchar[])
ON CONFLICT("name") DO UPDATE SET "country" = EXCLUDED."country"
RETURNING "shop_publisher"."id"
```

**Index note:** `ON CONFLICT` needs a unique index or constraint on `unique_fields`. Django 5.2 on PostgreSQL sends the rows via `UNNEST` arrays (fewer bind parameters). Use `ignore_conflicts=True` when existing rows should be left alone (PKs are then not set on the objects).
**Common wrong answer:** `update_or_create()` in a loop — two queries per row and racy without a unique constraint.

## 8. Production: Pitfalls, Debugging & Scaling

Performance problems and the ORM's hard limits — the problems that separate "it returns the right rows" from "it survives production traffic".

### Problem 33 — Keyset (seek) pagination

**Question:** Page through orders newest-first, 50 at a time, given the last row of the previous page — without `OFFSET`.

```python
def next_page(last_created_at, last_id, size=50):
    return (Order.objects
            .filter(Q(created_at__lt=last_created_at) |
                    Q(created_at=last_created_at, id__lt=last_id))
            .order_by("-created_at", "-id")[:size])
```

```sql
SELECT ... FROM "shop_order"
WHERE ("shop_order"."created_at" < '2025-11-09 06:21:06.840954+00:00'::timestamptz
    OR ("shop_order"."created_at" = '2025-11-09 06:21:06.840954+00:00'::timestamptz AND "shop_order"."id" < 59))
ORDER BY "shop_order"."created_at" DESC, 1 DESC LIMIT 50
```

**Index note:** `Index(fields=["-created_at", "-id"])`. Cost is constant per page; `OFFSET 100000` scans and discards 100,000 rows. This is what DRF's `CursorPagination` does for you ([Ch 24](topic.html?p=24-drf-pagination-filtering-versioning)).
**Common wrong answer:** `Paginator(qs, 50).page(2000)` on a large table — `COUNT(*)` plus a deep `OFFSET`, both linear.

### Problem 34 — Kill the N+1 in an order listing

**Question:** List the latest 20 orders with the user, each item, its book and the book's publisher, plus an item count — with a constant number of queries.

```python
orders = (Order.objects
          .select_related("user")
          .prefetch_related(Prefetch("items", queryset=OrderItem.objects.select_related("book__publisher")))
          .annotate(item_count=Count("items"))
          .order_by("-created_at")[:20])
```

```sql
SELECT "shop_order".*, COUNT("shop_orderitem"."id") AS "item_count", "auth_user".* FROM "shop_order"
LEFT OUTER JOIN "shop_orderitem" ON (...) INNER JOIN "auth_user" ON (...)
GROUP BY "shop_order"."id", "auth_user"."id" ORDER BY "shop_order"."created_at" DESC LIMIT 20;

SELECT "shop_orderitem".*, "shop_book".*, "shop_publisher".* FROM "shop_orderitem"
INNER JOIN "shop_book" ON (...) INNER JOIN "shop_publisher" ON (...)
WHERE "shop_orderitem"."order_id" IN (9, 32, 41, ...)
```

**Index note:** two queries regardless of page size. Prove it in a test with `self.assertNumQueries(2)` ([Ch 33](topic.html?p=33-testing)). Use `only()` on the prefetch queryset if `auth_user`'s password hash and other wide columns aren't needed.
**Common wrong answer:** `prefetch_related("items__book__publisher")` — correct but three extra queries instead of one; or `select_related("items")` — `FieldError`, because `select_related` only follows single-valued relations.

### Problem 35 — Hierarchies: when the answer is raw SQL

**Question:** Given an author, return their mentor chain upward (mentor, mentor's mentor, ...).

```python
chain = Author.objects.raw(
    """
    WITH RECURSIVE chain AS (
        SELECT id, name, mentor_id, 0 AS depth FROM shop_author WHERE id = %s
        UNION ALL
        SELECT a.id, a.name, a.mentor_id, c.depth + 1
        FROM shop_author a JOIN chain c ON a.id = c.mentor_id
    )
    SELECT * FROM chain ORDER BY depth
    """,
    [author_id],
)
[(a.name, a.depth) for a in chain]   # extra columns become attributes
```

**Index note:** the PK serves every step. Parameters go in the second argument — never f-string `author_id` into the SQL. Alternatives: `django-cte` for CTEs as QuerySets, `django-treebeard`/`django-mptt` (materialised path, nested sets) when you query trees constantly, or PostgreSQL `ltree`.
**Common wrong answer:** a `while author.mentor:` loop — one query per level (fine for depth 3, terrible for a category tree of depth 12 per page row), or `raw(f"... WHERE id = {author_id}")` — SQL injection.

## 9. Interview Questions

**Q: What is the difference between `annotate()` and `aggregate()`?**
A: `aggregate()` collapses the whole QuerySet into a dict of values — one SQL row, terminal, it returns data, not a QuerySet. `annotate()` adds a computed column per row of the result and returns a QuerySet you can keep filtering, ordering and slicing. On a model QuerySet, `annotate(Count(...))` groups by the model's primary key; after `values(...)`, it groups by those values. Filters on annotations become `HAVING`.

**Q: Why does the order of `values()` and `annotate()` matter?**
A: `values("x").annotate(agg)` tells Django to GROUP BY `x` and aggregate per group. `annotate(agg).values("x")` computes the aggregate per object (grouped by pk) and then merely selects `x` — so you get one row per object with repeated `x` values. Interviewers use this to test whether you think in SQL. When grouping by an expression, `annotate(month=TruncMonth(...))` first, then `values("month")`, then the aggregate.

**Q: How do you count only some related rows?**
A: Use `Count("rel", filter=Q(...))`, which compiles to `COUNT(...) FILTER (WHERE ...)` on PostgreSQL and `COUNT(CASE WHEN ...)` elsewhere. It lets one query return several conditional counts. Avoid putting the condition in `.filter()` if you also need rows with zero matches — the WHERE removes them before grouping.

**Q: Why can two `Count`s in one `annotate()` return inflated numbers, and how do you fix it?**
A: Each relation adds a join, and joining two independent one-to-many relations produces a cross product per parent row before GROUP BY: 5 reviews × 2 order items = 10 rows, so both aggregates are wrong. `Count(..., distinct=True)` fixes counts because it counts distinct child ids, but it can't fix `Sum`/`Avg`. The general fix is a correlated `Subquery` per relation (or separate queries), so each aggregate has its own join path.

**Q: When would you use `Exists` instead of a join or `__in`?**
A: For "has / has not a related row" questions. `Exists` is a semi-join: it never duplicates the outer rows (no need for `distinct()`), it can stop at the first match, and `~Exists` doesn't have `NOT IN`'s NULL trap. It's also the only reliable way to express several conditions that must hold on the *same* related row inside an exclusion, because `exclude()` with multiple multi-valued conditions doesn't guarantee they refer to one row.

**Q: Explain `Subquery` and `OuterRef` with an example.**
A: `OuterRef("pk")` is a placeholder for a column of the outer query's current row, resolved when the inner QuerySet is embedded. `Subquery(Review.objects.filter(book=OuterRef("pk")).order_by("-created_at").values("body")[:1])` annotates each book with its latest review text. The inner QuerySet must return one column (`values("col")`) and, used as a value, one row (`[:1]`). For per-group aggregates inside a subquery, use `.values("fk").annotate(x=Agg(...)).values("x")` to force a GROUP BY.

**Q: How do you get the top N rows per group in Django?**
A: Annotate a `Window(RowNumber(), partition_by=F("group"), order_by=[...])` and filter on it — supported since Django 4.2, which wraps the query in an outer SELECT because SQL can't filter windows in WHERE. Include a unique tiebreaker in `order_by`. Use `Rank`/`DenseRank` if ties should share a position. Before 4.2, the options were a correlated subquery per group, `DISTINCT ON` for N=1 on PostgreSQL, or raw SQL.

**Q: How would you decrement stock without overselling under concurrent requests? (Senior)**
A: Make the check and the write a single atomic statement: `Book.objects.filter(pk=id, stock__gte=qty).update(stock=F("stock") - qty)` and treat a return value of 0 as "insufficient stock". The UPDATE takes a row lock, concurrent updates queue behind it, and under READ COMMITTED PostgreSQL re-evaluates the WHERE against the newly committed row, so the guard can't be bypassed. Back it with a `CheckConstraint(stock >= 0)`. If you must read first (multiple rows, business rules), use `select_for_update()` inside `atomic()` and lock rows in a consistent order (by id) to avoid deadlocks.

**Q: Your annotated report is correct in tests but slow in production. How do you investigate? (Senior)**
A: Capture the real SQL (`connection.queries`, debug toolbar, or `CaptureQueriesContext`), then run `qs.explain(analyze=True, buffers=True)` on production-like data. Look for sequential scans on large tables, row-estimate errors, nested loops over correlated subqueries, and sorts spilling to disk. Typical fixes: a composite index matching filter + order columns, partial indexes for status filters, `alias()` instead of `annotate()` so a subquery isn't evaluated twice, replacing per-row subqueries with a window or a join, and dropping wide columns with `only()`. Then lock the query count with `assertNumQueries` so it doesn't regress.

**Q: What can't the ORM express, and what do you do then? (Senior)**
A: Recursive CTEs, windows over GROUP BY aggregates (running totals of daily sums, `LAG` of monthly totals), `LATERAL` joins, some set operations combined with ordering, and vendor features without wrappers. First check whether a reformulation works (window over raw rows plus `distinct()`, finishing small result sets in Python). Otherwise use `Model.objects.raw(sql, params)` for model instances, `connection.cursor()` for arbitrary rows, a `managed = False` model over a database view for reusable reports, or libraries like `django-cte`. Always pass parameters separately to stay safe from SQL injection.

**Q: How would you design pagination for a feed with tens of millions of rows? (Senior)**
A: Keyset pagination: order by a unique, indexed key such as `(created_at, id)` and fetch `WHERE (created_at, id) < (last_created_at, last_id) ORDER BY created_at DESC, id DESC LIMIT n`, expressed with `Q` objects in the ORM. Cost is constant per page, while `OFFSET` grows linearly and `COUNT(*)` for page numbers is itself a full scan. In DRF, `CursorPagination` implements this with opaque cursors, at the price of no total count and no jumping to page 500. Index the ordering columns in the same direction.

**Q: What's the difference between `filter(a__x=1, a__y=2)` and `filter(a__x=1).filter(a__y=2)` on a reverse FK?**
A: In a single `filter()` call, both conditions apply to the *same* related row — "has an `a` that is both x=1 and y=2". Chained `filter()` calls on a multi-valued relation create separate joins, so each condition can be satisfied by a *different* related row — "has an `a` with x=1 and some `a` with y=2". The second form can also duplicate parent rows. For forward FKs and one-to-one there's no difference, because there's only one related row.

**Q: How do you find and remove duplicate rows with the ORM?**
A: Find with `values(key_expr).annotate(n=Count("id")).filter(n__gt=1)`, using `Lower()` for case-insensitive keys. Remove by ranking within each duplicate group with `Window(RowNumber(), partition_by=[...], order_by=[...])`, filtering `rn > 1`, and deleting `filter(pk__in=ranked.values("pk"))` inside a transaction. Then add a `UniqueConstraint` (functional if needed) so it can't recur, and make the writing code handle `IntegrityError`.

**Q: When is `bulk_create(update_conflicts=True)` better than `update_or_create()`?**
A: For syncing many rows. `bulk_create` with `update_conflicts=True, unique_fields=..., update_fields=...` issues one `INSERT ... ON CONFLICT DO UPDATE` per batch and is atomic per row at the database level. `update_or_create()` does a SELECT (with `select_for_update`) and then an INSERT or UPDATE per row, which is far slower for large sets. The trade-offs: no `save()` calls, no signals, and a unique constraint on the conflict fields is required.

## 10. Quick Revision & Cheat Sheet

| Question shape | ORM tool | SQL produced | Classic trap |
|---|---|---|---|
| Has / has no child | `Exists` / `~Exists`, `rel__isnull=True` | `EXISTS`, `LEFT JOIN ... IS NULL` | `exclude()` with two multi-valued conditions |
| Count per parent incl. zero | `Parent.objects.annotate(Count("children"))` | `LEFT JOIN ... GROUP BY parent.id` | starting from the child table |
| Group by expression | `annotate(e=...).values("e").annotate(agg)` | `GROUP BY 1` | `annotate()` before `values()` |
| Conditional count | `Count("rel", filter=Q(...))` | `COUNT(...) FILTER (WHERE ...)` | condition in `.filter()` drops zeros |
| Two aggregates, two relations | `Subquery` per relation, `distinct=True` for counts | correlated subqueries | join fan-out |
| Latest child value | `Subquery(qs.order_by(...).values("c")[:1])` | `(SELECT ... LIMIT 1)` | missing `[:1]` |
| Latest row per group | `distinct("fk")` (PG) or `pk=Subquery(...)` | `DISTINCT ON` | joining back on a timestamp |
| Top-N per group | `Window(RowNumber(), partition_by=...)` + `filter` | wrapper `"qualify"` | no tiebreaker |
| Running total | `Window(Sum(...), order_by=...)` | `SUM() OVER (ORDER BY ...)` | RANGE peers on ties |
| Safe decrement | `filter(guard).update(F(...))` | `UPDATE ... WHERE stock >= n` | read-modify-write |
| Upsert | `bulk_create(update_conflicts=True)` | `ON CONFLICT DO UPDATE` | `update_or_create` loop |
| Deep pagination | keyset `Q(...)` filter | `WHERE (ts, id) < ...` | `OFFSET` |

- Say the *result grain* first: "one row per ___".
- The model you start from is your GROUP BY and your LEFT/INNER JOIN decision.
- `values()` before `annotate()` to group; after to just select.
- Each `__` into a many-relation multiplies rows; two of them multiply each other.
- Filters on windows work since 4.2; windows over aggregates don't.
- Always add a unique tiebreaker to orderings used for ranking or pagination.
- Writes: `F()` + guard in one `UPDATE`; constraints as the backstop.
- When the ORM can't, use `raw()` with params — and say so confidently.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" "psycopg[binary]" factory-boy`, create a project with the §2 schema pointing at a local PostgreSQL, and write a seed command that generates a few thousand rows with `factory_boy` (include ties in prices and timestamps on purpose).

1. **Assert, don't eyeball.** For Problems 6, 10, 17 and 24, write a `TestCase` that computes the answer in plain Python from `Model.objects.all()` and asserts the ORM result matches. Watch Problem 10's naive version fail.
2. **Read the plans.** Run `explain(analyze=True)` for Problems 5, 13(a), 13(b) and 19 before and after adding the suggested indexes; record the plan node types that change.
3. **Break the semantics.** Write the `exclude()` version of Problem 5 and the single-`filter()` version of Problem 18; find a dataset where each returns a different answer than the correct one.
4. **Port to 4.2-less.** Rewrite Problem 19 without filtering on a window (correlated `Subquery` with `pk__in`), and compare plans.
5. **Concurrency drill.** In a `TransactionTestCase`, run Problem 31's `reserve()` from 20 threads against a book with 10 copies; assert exactly 10 succeed. Then try the naive read-modify-write and show it oversells.
6. **Raw where needed.** Implement Problem 27 as a `raw()` CTE and as a `managed = False` model over a `CREATE VIEW` migration (`RunSQL`); compare ergonomics.

**Mini project — "ORM kata" test suite:** a Django app containing all 35 problems as functions in `shop/queries.py`, each with a test asserting both the result (against a Python oracle) and the query count (`assertNumQueries`). Add a CI job that runs it against PostgreSQL so regressions in query shape fail the build.

## 12. Related Topics & Free Learning Resources

**Sibling chapters**
- [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) — lookups, `Q`, `F`, multi-valued filter semantics.
- [Ch 12 · Aggregation, Annotation, Subqueries & Window Functions](topic.html?p=12-aggregation-annotation-subqueries) — the concept chapter behind §4–§6.
- [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization) — Problem 34 in depth.
- [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) — Problems 29–31.
- [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres) — every index note, functional constraints, `raw()`.
- [Ch 24 · DRF Pagination, Filtering, Versioning & Docs](topic.html?p=24-drf-pagination-filtering-versioning) — cursor pagination.
- [Ch 33 · Testing Django Applications](topic.html?p=33-testing) — `assertNumQueries`, factories.
- [Ch 36 · Django Internals](topic.html?p=36-django-internals) — how these QuerySets compile.
- [Ch 37 · Most-Asked Django Interview Questions: Core & ORM](topic.html?p=37-interview-core-orm) and [Ch 40 · Django Design Rounds](topic.html?p=40-design-rounds) — the rest of the interview loop.

**Other handbooks**
- [SQL · Top-N per Group](../sql/topic.html?p=34-problem-top-n-per-group), [SQL · Running Total](../sql/topic.html?p=35-problem-running-total), [SQL · Gaps & Islands](../sql/topic.html?p=36-problem-gaps-islands) — the same problems in raw SQL.
- [SQL · Window Functions](../sql/topic.html?p=13-window-functions) and [SQL · Index Design](../sql/topic.html?p=20-index-design) — the theory behind the index notes.
- [REST API · Pagination](../rest-api/topic.html?p=13-pagination) — offset vs cursor at the API layer.

**Free resources**
- **Aggregation** — Django docs · *Intermediate* · the canonical explanation of `values()`/`annotate()` ordering and join interactions. https://docs.djangoproject.com/en/5.2/topics/db/aggregation/
- **Query Expressions** — Django docs · *Advanced* · `F`, `Subquery`, `OuterRef`, `Exists`, `Window` and frames. https://docs.djangoproject.com/en/5.2/ref/models/expressions/
- **Making queries** — Django docs · *Beginner* · spanning multi-valued relationships, the `filter()`/`exclude()` semantics. https://docs.djangoproject.com/en/5.2/topics/db/queries/
- **QuerySet API reference** — Django docs · *Intermediate* · `distinct(*fields)`, `bulk_create` conflicts, `explain()`. https://docs.djangoproject.com/en/5.2/ref/models/querysets/
- **PostgreSQL: Window Functions tutorial** — PostgreSQL docs · *Intermediate* · frames and peers explained by the database itself. https://www.postgresql.org/docs/current/tutorial-window.html
- **Use The Index, Luke** — Markus Winand · *Intermediate* · why keyset pagination and composite index order matter. https://use-the-index-luke.com/
- **django-cte** — GitHub · *Advanced* · CTEs (including recursive) as QuerySets. https://github.com/dimagi/django-cte

---

*Django Handbook — chapter 39.*
