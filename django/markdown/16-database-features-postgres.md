# 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features

> **In one line:** The ORM is a thin, honest layer over a real database. Declare indexes and constraints in `Meta` so the database enforces your invariants, drop to raw SQL safely (always with parameters) when the ORM runs out of road, and use `django.contrib.postgres` — JSONField, ArrayField, full-text search, GIN indexes, exclusion constraints — to get PostgreSQL's power without giving up migrations.

---

## 1. Overview

> **Builds on:** [Ch 08 · Models & Fields](topic.html?p=08-models-fields), [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups), [Ch 11 · Migrations](topic.html?p=11-migrations), [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization).

Most Django projects start with nothing but models and `.filter()` calls. That works until three things happen at once: the table grows to millions of rows, two requests race to create "the same" record, and product asks for search. At that point the naive approach — Python-side validation plus whatever indexes Django created by accident — fails in three predictable ways:

1. **Slow queries.** A `WHERE lower(email) = ...` or `WHERE status = 'pending' ORDER BY created_at` scans the whole table because no index matches the predicate. The ORM did not "do something wrong"; you never told the database what to index.
2. **Broken invariants.** You checked `if not Booking.objects.filter(room=r, day=d).exists(): create(...)` in Python. Two concurrent requests both pass the check and both insert. Only a **database constraint** closes that race — application checks are advisory, constraints are law.
3. **Feature gaps.** You need "search posts by words, ranked", "filter on a key inside a JSON blob", or "no two reservations may overlap in time". The generic ORM cannot express these portably; PostgreSQL can, and Django exposes it through `django.contrib.postgres`.

This chapter is the home for **indexes and constraints declared in `Meta`**, **raw SQL** (`Manager.raw()`, `connection.cursor()`, `RawSQL`) and its injection safety, and the **PostgreSQL-specific fields, lookups, indexes and constraints**. Query-shape optimization (N+1, `select_related`) lives in [Ch 13](topic.html?p=13-queryset-optimization); the database theory behind B-trees and planners lives in the SQL handbook ([SQL · Indexes](../sql/topic.html?p=19-indexes), [SQL · Execution Plans](../sql/topic.html?p=22-execution-plans)).

> **Why this matters:** Interviewers use this topic to separate people who "use Django" from people who "run Django on a database". Expect: "how do you enforce uniqueness only for active rows?", "is `raw()` safe from SQL injection?", "JSONField vs a real column?", and "how do you add an index to a 50M-row table without downtime?".

## 2. Core Concepts

- **`db_index=True` / `unique=True`** — field-level shortcuts that create a single-column index or unique index. *Why it matters:* quick, but they cannot express composite, partial, functional or covering indexes.
- **Automatic FK index** — every `ForeignKey` gets an index by default (`db_index=True`). *Why it matters:* a composite index that starts with that FK column may make the auto index redundant; you can set `db_index=False` deliberately.
- **`Meta.indexes`** — a list of `models.Index(...)` (or Postgres index classes). Supports `fields`, expressions (functional indexes), `condition=` (partial), `include=` (covering, PostgreSQL), `opclasses=`. *Why it matters:* this is how you match the index to the query.
- **`Meta.constraints`** — `UniqueConstraint`, `CheckConstraint`, and Postgres `ExclusionConstraint`. *Why it matters:* the database rejects bad data even when code paths bypass Python (bulk operations, raw SQL, other services).
- **`UniqueConstraint`** — `fields=` or expressions, optional `condition=` (partial unique), `deferrable=`, `include=`, `nulls_distinct=` (5.0+, PostgreSQL 15+), `violation_error_message`/`violation_error_code`. *Why it matters:* replaces `unique_together`, which the docs now discourage.
- **`CheckConstraint`** — a `Q`/boolean expression the row must satisfy. In 5.1+ the argument is `condition=`; `check=` is deprecated. *Why it matters:* domain rules like "price ≥ 0" or "end > start" enforced at the source.
- **`validate_constraints()`** — since 4.1, `Model.full_clean()` validates `Meta.constraints` (ModelForms therefore surface them as form errors). *Why it matters:* nice messages for users, but `save()` still does not call it — the DB is the final guard.
- **`Manager.raw(sql, params)`** — returns a `RawQuerySet` of model instances from hand-written SQL. Must select the primary key. *Why it matters:* escape hatch for SQL the ORM cannot build, while still returning models.
- **`connection.cursor()`** — DB-API cursor for arbitrary SQL; placeholders are `%s` on every backend. *Why it matters:* reporting queries, DDL, stored procedures.
- **`RawSQL` / `extra()`** — inject SQL fragments into an ORM query. `extra()` is a "last resort" API slated for deprecation in spirit. *Why it matters:* most common source of injection in Django codebases.
- **`JSONField`** — cross-database since 3.1; `jsonb` on PostgreSQL; key/path lookups, `contains`, `has_key`. *Why it matters:* flexible attributes without a schema migration — and a performance trap if abused.
- **`ArrayField`** (Postgres) — a native array column with `contains`, `overlap`, `len`, index transforms. *Why it matters:* tags without a join table, at the cost of referential integrity.
- **Full-text search** — `SearchVector`, `SearchQuery`, `SearchRank`, `SearchVectorField`, `TrigramSimilarity`. *Why it matters:* "good enough" search inside Postgres before reaching for Elasticsearch.
- **GIN / GiST / BRIN indexes** — `django.contrib.postgres.indexes`. GIN for "contains" queries on jsonb, arrays, tsvector; GiST for ranges/geometry/trigram; BRIN for huge append-only time-ordered tables.
- **`AddIndexConcurrently`** — migration operation building an index with `CREATE INDEX CONCURRENTLY`; requires `atomic = False` on the migration. *Why it matters:* indexing a hot table without locking writes.

## 3. Theory & Principles

### 3.1 From `Meta` to DDL

When the `ModelBase` metaclass builds a model, `Options` (`_meta`) stores `indexes` and `constraints`. The migration autodetector compares `_meta` against the *migration state* (not the live DB) and emits `AddIndex`, `AddConstraint`, `RemoveConstraint` operations. At `migrate` time each operation calls the backend's **schema editor** (`connection.schema_editor()`, e.g. `DatabaseSchemaEditor` for PostgreSQL), which asks the index/constraint object for its SQL via `create_sql(model, schema_editor)`. Expressions inside a functional index or check constraint are compiled through the same `SQLCompiler`/`Query` machinery as a normal QuerySet, which is why you can write `Lower("email")` or `Q(price__gte=0)` and get correct SQL.

Names are mandatory for `Meta.indexes` and constraints (`name="..."`), and must be unique per database. In abstract base classes use `%(app_label)s_%(class)s_...` interpolation so each concrete model gets its own name.

### 3.2 How a query picks an index

The planner can use an index only when the query predicate matches the index *definition*:

- A B-tree on `(tenant_id, created_at)` serves `WHERE tenant_id = ? ORDER BY created_at` and `WHERE tenant_id = ?`, but not `WHERE created_at > ?` alone (leftmost-prefix rule).
- A functional index on `lower(email)` serves `email__iexact`? Not necessarily: `iexact` compiles to `UPPER("email"::text) = UPPER(%s)` on PostgreSQL. Your index expression must match the SQL Django generates — use `Upper("email")` for `iexact`, or query `annotate(e=Lower("email")).filter(e=...)` / a `Lower` lookup with `Lower("email")` index. Always check with `.explain()`.
- A partial index `WHERE status = 'pending'` is used only when the query's WHERE implies that condition.
- `icontains` compiles to `UPPER(col) LIKE UPPER('%x%')` — no B-tree helps a leading wildcard; you need a trigram GIN index.

> **Gotcha:** On PostgreSQL, a `CharField`/`TextField` with `db_index=True` or `unique=True` creates **two** indexes: the normal one and a `..._like` index using `varchar_pattern_ops`/`text_pattern_ops` so that `startswith` can use an index. That is extra write cost you may not need.

### 3.3 Constraints vs validation — where the truth lives

```svg
<svg viewBox="0 0 860 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj16a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj16b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Which write paths are checked by Python validation vs the database constraint</text>
  <rect x="20" y="45" width="170" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="105" y="66" text-anchor="middle" fill="#1e293b">ModelForm / Serializer</text>
  <rect x="20" y="95" width="170" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="105" y="116" text-anchor="middle" fill="#1e293b">obj.full_clean(); save()</text>
  <rect x="20" y="145" width="170" height="34" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="105" y="166" text-anchor="middle" fill="#1e293b">obj.save() alone</text>
  <rect x="20" y="195" width="170" height="34" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="105" y="216" text-anchor="middle" fill="#1e293b">bulk_create / update()</text>
  <rect x="20" y="245" width="170" height="34" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="105" y="266" text-anchor="middle" fill="#1e293b">raw SQL / other service</text>
  <rect x="300" y="60" width="210" height="100" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="405" y="84" text-anchor="middle" fill="#1e293b" font-weight="bold">Python layer</text>
  <text x="405" y="104" text-anchor="middle" fill="#334155">validate_unique()</text>
  <text x="405" y="120" text-anchor="middle" fill="#334155">validate_constraints() (4.1+)</text>
  <text x="405" y="136" text-anchor="middle" fill="#334155">friendly error messages</text>
  <text x="405" y="152" text-anchor="middle" fill="#334155">racy: check-then-insert</text>
  <rect x="610" y="120" width="230" height="130" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="725" y="144" text-anchor="middle" fill="#1e293b" font-weight="bold">PostgreSQL</text>
  <text x="725" y="164" text-anchor="middle" fill="#334155">UNIQUE / CHECK / EXCLUDE</text>
  <text x="725" y="182" text-anchor="middle" fill="#334155">enforced atomically per row</text>
  <text x="725" y="200" text-anchor="middle" fill="#334155">violation: IntegrityError</text>
  <text x="725" y="218" text-anchor="middle" fill="#334155">no bypass, no race</text>
  <path d="M192,62 L298,90" stroke="#2563eb" stroke-width="2" marker-end="url(#dj16a)"/>
  <path d="M192,112 L298,118" stroke="#2563eb" stroke-width="2" marker-end="url(#dj16a)"/>
  <path d="M512,120 L608,165" stroke="#2563eb" stroke-width="2" marker-end="url(#dj16a)"/>
  <path d="M192,162 L608,180" stroke="#dc2626" stroke-width="2" marker-end="url(#dj16b)"/>
  <path d="M192,212 L608,205" stroke="#dc2626" stroke-width="2" marker-end="url(#dj16b)"/>
  <path d="M192,262 L608,230" stroke="#dc2626" stroke-width="2" marker-end="url(#dj16b)"/>
  <text x="430" y="300" text-anchor="middle" fill="#334155">Red paths skip Python validation entirely. Only the database constraint sees every write.</text>
</svg>
```

The principle: **validation is for user experience, constraints are for correctness.** Put the rule in `Meta.constraints` so the database enforces it; Django 4.1+ will also run it in `full_clean()` so forms show a helpful message. Catch `IntegrityError` at the race boundary (e.g. `get_or_create` already does this internally — it catches the `IntegrityError` from a concurrent insert and re-fetches).

### 3.4 Raw SQL and parameter binding

Every database driver separates **SQL text** from **parameters**. When you call `cursor.execute("... WHERE id = %s", [user_id])`, Django passes the list to psycopg, which sends the value through the protocol (or quotes it correctly) — the value can never become SQL syntax. When you write `cursor.execute(f"... WHERE id = {user_id}")`, the value *is* SQL syntax. That single difference is the whole story of SQL injection.

Internally, `Manager.raw()` builds a `RawQuery`; iterating the `RawQuerySet` executes it and maps columns to fields by name (`translations=` remaps names). Fields you did not select become **deferred** and trigger one extra query each on access; omitting the primary key raises `FieldDoesNotExist`/`InvalidQuery`-style errors because instances cannot be built.

> **Gotcha:** Never quote the placeholder: `WHERE name = '%s'` is wrong — the driver adds the quotes. And placeholders work only for **values**, never for identifiers (table/column names) or SQL keywords (`ASC`/`DESC`). Those must be whitelisted.

## 4. Architecture & Workflow

### 4.1 The PostgreSQL toolbox map

```svg
<svg viewBox="0 0 860 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj16c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Query shape  ->  Django lookup  ->  index that serves it</text>
  <rect x="20" y="40" width="250" height="26" rx="5" fill="#ede9fe" stroke="#7c3aed"/><text x="145" y="57" text-anchor="middle" fill="#1e293b" font-weight="bold">Query shape</text>
  <rect x="305" y="40" width="250" height="26" rx="5" fill="#ede9fe" stroke="#7c3aed"/><text x="430" y="57" text-anchor="middle" fill="#1e293b" font-weight="bold">ORM expression</text>
  <rect x="590" y="40" width="250" height="26" rx="5" fill="#ede9fe" stroke="#7c3aed"/><text x="715" y="57" text-anchor="middle" fill="#1e293b" font-weight="bold">Index</text>
  <rect x="20" y="80" width="250" height="36" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="145" y="102" text-anchor="middle" fill="#1e293b">equality / range / ORDER BY</text>
  <rect x="305" y="80" width="250" height="36" rx="5" fill="#fff" stroke="#94a3b8"/><text x="430" y="102" text-anchor="middle" fill="#334155">filter(a=1).order_by("b")</text>
  <rect x="590" y="80" width="250" height="36" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="715" y="102" text-anchor="middle" fill="#1e293b">B-tree Index(fields=["a","b"])</text>
  <rect x="20" y="126" width="250" height="36" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="145" y="148" text-anchor="middle" fill="#1e293b">subset of rows (status=pending)</text>
  <rect x="305" y="126" width="250" height="36" rx="5" fill="#fff" stroke="#94a3b8"/><text x="430" y="148" text-anchor="middle" fill="#334155">filter(status="pending")</text>
  <rect x="590" y="126" width="250" height="36" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="715" y="148" text-anchor="middle" fill="#1e293b">partial Index(condition=Q(...))</text>
  <rect x="20" y="172" width="250" height="36" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="145" y="194" text-anchor="middle" fill="#1e293b">JSON containment</text>
  <rect x="305" y="172" width="250" height="36" rx="5" fill="#fff" stroke="#94a3b8"/><text x="430" y="194" text-anchor="middle" fill="#334155">filter(data__contains={...})</text>
  <rect x="590" y="172" width="250" height="36" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="715" y="194" text-anchor="middle" fill="#1e293b">GinIndex (jsonb_path_ops)</text>
  <rect x="20" y="218" width="250" height="36" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="145" y="240" text-anchor="middle" fill="#1e293b">words, ranked</text>
  <rect x="305" y="218" width="250" height="36" rx="5" fill="#fff" stroke="#94a3b8"/><text x="430" y="240" text-anchor="middle" fill="#334155">filter(search_vector=SearchQuery())</text>
  <rect x="590" y="218" width="250" height="36" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="715" y="240" text-anchor="middle" fill="#1e293b">GinIndex on SearchVectorField</text>
  <rect x="20" y="264" width="250" height="36" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="145" y="286" text-anchor="middle" fill="#1e293b">fuzzy / substring match</text>
  <rect x="305" y="264" width="250" height="36" rx="5" fill="#fff" stroke="#94a3b8"/><text x="430" y="286" text-anchor="middle" fill="#334155">icontains, trigram_similar</text>
  <rect x="590" y="264" width="250" height="36" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="715" y="286" text-anchor="middle" fill="#1e293b">GinIndex(gin_trgm_ops)</text>
  <rect x="20" y="310" width="250" height="36" rx="5" fill="#dbeafe" stroke="#2563eb"/><text x="145" y="332" text-anchor="middle" fill="#1e293b">time-range overlap</text>
  <rect x="305" y="310" width="250" height="36" rx="5" fill="#fff" stroke="#94a3b8"/><text x="430" y="332" text-anchor="middle" fill="#334155">during__overlap=range</text>
  <rect x="590" y="310" width="250" height="36" rx="5" fill="#dcfce7" stroke="#16a34a"/><text x="715" y="332" text-anchor="middle" fill="#1e293b">GiST / ExclusionConstraint</text>
  <path d="M272,98 L303,98" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj16c)"/>
  <path d="M557,98 L588,98" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj16c)"/>
  <path d="M272,190 L303,190" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj16c)"/>
  <path d="M557,190 L588,190" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj16c)"/>
  <path d="M272,282 L303,282" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj16c)"/>
  <path d="M557,282 L588,282" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj16c)"/>
</svg>
```

### 4.2 The workflow for adding an index safely

```text
1. Find the slow query     -> pg_stat_statements / Sentry / debug-toolbar / slow log
2. Reproduce in Django     -> qs = Order.objects.filter(...); print(qs.explain(analyze=True))
3. Design the index        -> match predicate + sort; partial if the hot subset is small
4. Declare in Meta.indexes -> makemigrations
5. Make it non-blocking    -> swap AddIndex for AddIndexConcurrently, atomic = False
6. Review the SQL          -> manage.py sqlmigrate app 0042
7. Deploy as its own release step; verify with explain() again; watch write latency
```

### 4.3 Raw SQL decision ladder

```text
Can the ORM express it?            -> use the ORM (annotate, Subquery, Window, Func)
Need one SQL fragment in a query?  -> custom Func/Lookup, or RawSQL(sql, params)
Need model instances from SQL?     -> Model.objects.raw(sql, params)
Need arbitrary rows / DDL / CTE?   -> with connection.cursor() as c: c.execute(sql, params)
Building identifiers dynamically?  -> whitelist, then connection.ops.quote_name()
```

## 5. Implementation

### 5.1 Simple example — indexes and constraints on one model

```python
# shop/models.py
from django.db import models
from django.db.models import Q, F
from django.db.models.functions import Lower


class Product(models.Model):
    sku = models.CharField(max_length=32)
    name = models.CharField(max_length=200)
    email_contact = models.EmailField()
    price = models.DecimalField(max_digits=10, decimal_places=2)
    sale_price = models.DecimalField(max_digits=10, decimal_places=2, null=True, blank=True)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            # composite: "active products, newest first"
            models.Index(fields=["is_active", "-created_at"], name="product_active_recent_idx"),
            # functional: case-insensitive lookups on name
            models.Index(Lower("name"), name="product_name_lower_idx"),
        ]
        constraints = [
            # SKU unique only among active products (partial unique index)
            models.UniqueConstraint(
                fields=["sku"],
                condition=Q(is_active=True),
                name="uniq_active_sku",
                violation_error_message="An active product with this SKU already exists.",
            ),
            models.CheckConstraint(condition=Q(price__gte=0), name="price_non_negative"),
            models.CheckConstraint(
                condition=Q(sale_price__isnull=True) | Q(sale_price__lt=F("price")),
                name="sale_below_price",
            ),
        ]

    def __str__(self):
        return self.name
```

> **Version note:** `CheckConstraint(check=...)` was renamed to `condition=` in Django 5.1; `check=` still works in 5.2 with a deprecation warning. On 4.2 LTS you must use `check=`. `index_together` was removed in 5.1 — use `Meta.indexes`.

Run `sqlmigrate` to see what Django will execute:

```bash
python manage.py makemigrations shop
python manage.py sqlmigrate shop 0001
```

The relevant part of the generated SQL looks like this (PostgreSQL):

```sql
CREATE INDEX "product_active_recent_idx" ON "shop_product" ("is_active", "created_at" DESC);
CREATE INDEX "product_name_lower_idx" ON "shop_product" (LOWER("name"));
CREATE UNIQUE INDEX "uniq_active_sku" ON "shop_product" ("sku") WHERE "is_active";
ALTER TABLE "shop_product" ADD CONSTRAINT "price_non_negative" CHECK ("price" >= 0);
ALTER TABLE "shop_product" ADD CONSTRAINT "sale_below_price"
  CHECK (("sale_price" IS NULL OR "sale_price" < ("price")));
```

Note that a **conditional `UniqueConstraint` becomes a partial unique index**, not a table constraint — which is why it cannot be `deferrable`. Using the index from Python:

```python
from django.db.models.functions import Lower

qs = Product.objects.annotate(n=Lower("name")).filter(n="blue mug")
print(qs.explain())
```

```text
Index Scan using product_name_lower_idx on shop_product  (cost=0.29..8.30 rows=1 width=...)
  Index Cond: (lower((name)::text) = 'blue mug'::text)
```

Validation picks up the constraints as well (4.1+):

```python
p = Product(sku="A1", name="x", email_contact="a@b.c", price=-5)
p.full_clean()
# ValidationError: {'__all__': ['Constraint “price_non_negative” is violated.']}
```

### 5.2 Raw SQL, done safely

```python
from django.db import connection
from shop.models import Product


def dictfetchall(cursor):
    cols = [c[0] for c in cursor.description]
    return [dict(zip(cols, row)) for row in cursor.fetchall()]


# 1) Model instances from SQL — must include the primary key
cheap = Product.objects.raw(
    "SELECT id, name, price FROM shop_product WHERE price < %s AND is_active",
    [10],
)
for p in cheap:
    print(p.name, p.price)        # accessing p.sku would trigger a deferred query per row

# 2) Arbitrary rows, e.g. a reporting CTE
def revenue_by_day(since):
    sql = """
        WITH daily AS (
            SELECT date_trunc('day', created_at) AS day, sum(price) AS revenue
            FROM shop_product
            WHERE created_at >= %(since)s
            GROUP BY 1
        )
        SELECT day, revenue, sum(revenue) OVER (ORDER BY day) AS running
        FROM daily ORDER BY day
    """
    with connection.cursor() as cursor:
        cursor.execute(sql, {"since": since})
        return dictfetchall(cursor)


# 3) Dynamic ORDER BY — identifiers cannot be parameters, so whitelist
ALLOWED_SORT = {"price": "price", "newest": "created_at"}

def products_sorted(sort_key, direction):
    column = ALLOWED_SORT.get(sort_key, "id")
    direction = "DESC" if direction == "desc" else "ASC"
    qn = connection.ops.quote_name
    sql = f"SELECT id, name, price FROM shop_product ORDER BY {qn(column)} {direction}"
    return list(Product.objects.raw(sql))
```

Compare the injection-prone version every code reviewer should reject:

```python
# DANGEROUS: user input becomes SQL syntax
name = request.GET["q"]               # "x' OR 1=1 --"
Product.objects.raw(f"SELECT * FROM shop_product WHERE name = '{name}'")
Product.objects.extra(where=[f"name = '{name}'"])
cursor.execute("SELECT * FROM shop_product WHERE name = '%s'" % name)

# SAFE: values travel as parameters
Product.objects.raw("SELECT * FROM shop_product WHERE name = %s", [name])
Product.objects.extra(where=["name = %s"], params=[name])
cursor.execute("SELECT * FROM shop_product WHERE name = %s", [name])
```

When you only need one SQL fragment, prefer a `RawSQL` expression with params, or better, a tiny `Func` subclass so the ORM keeps composing:

```python
from django.db.models import Func, FloatField
from django.db.models.expressions import RawSQL

Product.objects.annotate(score=RawSQL("price * %s", [1.18]))


class Similarity(Func):           # wraps pg_trgm similarity(a, b)
    function = "similarity"
    output_field = FloatField()

Product.objects.annotate(sim=Similarity("name", models.Value("mug"))).filter(sim__gt=0.3)
```

### 5.3 Real-world example — a searchable catalog with JSON attributes and bookings

```python
# settings.py
INSTALLED_APPS = [
    # ...
    "django.contrib.postgres",     # required for __search, trigram lookups, unaccent, etc.
    "catalog",
]
```

```python
# catalog/models.py
from django.contrib.postgres.constraints import ExclusionConstraint
from django.contrib.postgres.fields import ArrayField, DateTimeRangeField, RangeOperators
from django.contrib.postgres.indexes import GinIndex
from django.contrib.postgres.search import SearchVectorField
from django.db import models


class Listing(models.Model):
    title = models.CharField(max_length=200)
    description = models.TextField()
    tags = ArrayField(models.CharField(max_length=40), default=list, blank=True)
    attributes = models.JSONField(default=dict, blank=True)    # {"color": "red", "size": {"w": 3}}
    search_vector = SearchVectorField(null=True, editable=False)
    city = models.CharField(max_length=80)

    class Meta:
        indexes = [
            GinIndex(fields=["search_vector"], name="listing_search_gin"),
            GinIndex(fields=["tags"], name="listing_tags_gin"),
            GinIndex(fields=["attributes"], name="listing_attrs_gin", opclasses=["jsonb_path_ops"]),
            GinIndex(fields=["title"], name="listing_title_trgm", opclasses=["gin_trgm_ops"]),
        ]


class Booking(models.Model):
    listing = models.ForeignKey(Listing, on_delete=models.CASCADE, related_name="bookings")
    during = DateTimeRangeField()
    cancelled = models.BooleanField(default=False)

    class Meta:
        constraints = [
            # No two active bookings for the same listing may overlap in time
            ExclusionConstraint(
                name="no_overlapping_bookings",
                expressions=[
                    ("listing", RangeOperators.EQUAL),
                    ("during", RangeOperators.OVERLAPS),
                ],
                condition=models.Q(cancelled=False),
            ),
        ]
```

The extensions must exist before the indexes — create them in a migration (needs sufficient DB privileges):

```python
# catalog/migrations/0001_extensions.py
from django.contrib.postgres.operations import BtreeGistExtension, TrigramExtension
from django.db import migrations


class Migration(migrations.Migration):
    dependencies = []
    operations = [TrigramExtension(), BtreeGistExtension()]
```

`btree_gist` is needed because the exclusion constraint mixes a scalar equality (`listing_id =`) with a range overlap in one GiST index. Keeping the search vector fresh, plus the queries:

```python
# catalog/search.py
from django.contrib.postgres.search import SearchQuery, SearchRank, SearchVector, TrigramSimilarity
from django.db.models import F
from .models import Listing

VECTOR = SearchVector("title", weight="A", config="english") + \
         SearchVector("description", weight="B", config="english")


def refresh_vector(listing_ids):
    Listing.objects.filter(pk__in=listing_ids).update(search_vector=VECTOR)


def search(q, city=None, tags=None, color=None):
    query = SearchQuery(q, search_type="websearch", config="english")
    qs = (Listing.objects
          .filter(search_vector=query)
          .annotate(rank=SearchRank(F("search_vector"), query))
          .order_by("-rank"))
    if city:
        qs = qs.filter(city=city)
    if tags:
        qs = qs.filter(tags__overlap=tags)                 # any of these tags
    if color:
        qs = qs.filter(attributes__contains={"color": color})   # served by jsonb_path_ops GIN
    return qs[:20]


def fuzzy_title(q):
    return (Listing.objects
            .annotate(sim=TrigramSimilarity("title", q))
            .filter(sim__gt=0.3).order_by("-sim")[:10])
```

The SQL for the `search()` core (trimmed):

```sql
SELECT ..., ts_rank("catalog_listing"."search_vector",
                    websearch_to_tsquery('english'::regconfig, 'red sofa')) AS "rank"
FROM "catalog_listing"
WHERE "catalog_listing"."search_vector" @@ websearch_to_tsquery('english'::regconfig, 'red sofa')
  AND "catalog_listing"."tags" && ARRAY['vintage']::varchar(40)[]
  AND "catalog_listing"."attributes" @> '{"color": "red"}'::jsonb
ORDER BY "rank" DESC
LIMIT 20;
```

Call `refresh_vector()` from a Celery task dispatched with `transaction.on_commit` after a listing is saved, or maintain it with a database trigger. On 5.0+ you can alternatively use `GeneratedField(expression=..., output_field=SearchVectorField(), db_persist=True)`, but the expression must be immutable in PostgreSQL (an explicit text search config is required), so test it on your PG version.

Booking overlap is now impossible at the database level:

```python
from datetime import datetime, timezone
from django.db import IntegrityError, transaction
from psycopg.types.range import Range   # psycopg 3

def book(listing, start, end):
    try:
        with transaction.atomic():
            return Booking.objects.create(listing=listing, during=Range(start, end))
    except IntegrityError:
        raise ValueError("Those dates are taken")
```

JSON key lookups, and what they compile to:

```python
Listing.objects.filter(attributes__color="red")           # attributes -> 'color' = '"red"'
Listing.objects.filter(attributes__size__w__gte=3)         # nested key path
Listing.objects.filter(attributes__has_key="warranty")     # attributes ? 'warranty'
Listing.objects.filter(tags__contains=["vintage", "oak"])  # tags @> ARRAY[...]
Listing.objects.filter(tags__len=0)                        # array_length(...) — not index-friendly
```

### 5.4 Indexing a big table without downtime

```python
# catalog/migrations/0007_listing_city_idx.py
from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations, models


class Migration(migrations.Migration):
    atomic = False      # CREATE INDEX CONCURRENTLY cannot run inside a transaction
    dependencies = [("catalog", "0006_previous")]
    operations = [
        AddIndexConcurrently("listing", models.Index(fields=["city"], name="listing_city_idx")),
    ]
```

If a concurrent build fails, PostgreSQL leaves an **INVALID** index behind; drop it (`RemoveIndexConcurrently` or `DROP INDEX CONCURRENTLY`) and retry. Adding a `CheckConstraint` to a large table takes a lock while it scans; for very large tables teams sometimes add it `NOT VALID` via `RunSQL` and `VALIDATE CONSTRAINT` later, keeping the model state in sync with `SeparateDatabaseAndState` (see [Ch 11 · Migrations](topic.html?p=11-migrations)).

## 6. Advantages, Disadvantages & Trade-offs

| Tool | Gains | Costs | Use it for |
|---|---|---|---|
| `Meta.indexes` B-tree | Fast equality/range/sort | Write amplification, disk, more WAL | Hot filters and ORDER BYs |
| Partial index | Small, very fast for a hot subset | Only used when WHERE implies condition | `status='pending'`, soft-delete live rows |
| Functional index | Case-insensitive / computed lookups | Must exactly match generated SQL | `Lower(email)`, `Upper` for `iexact` |
| `UniqueConstraint` | Race-proof uniqueness | `IntegrityError` handling needed | Business keys, "one active per user" |
| `CheckConstraint` | Domain rules on every write path | Large-table add needs care | Non-negative amounts, `end > start` |
| `ExclusionConstraint` | No overlapping ranges, atomically | Postgres-only, GiST + btree_gist | Bookings, schedules, IP ranges |
| `JSONField` | Schema flexibility, no migration | Weak typing, harder indexing, bloated rows | Truly variable attributes, payload snapshots |
| `ArrayField` | No join table, GIN-indexable | No FK integrity, awkward updates | Tags, small value lists |
| Postgres FTS | No extra infrastructure, transactional | Limited relevance tuning, scaling ceiling | Search for up to a few million docs |
| Raw SQL | Any SQL, full control | Portability, injection risk, no composition | Reporting CTEs, vendor features |

### When to use

- Constraints whenever a rule must hold for **all** writers — including bulk ops, admin, scripts, and other services.
- Partial unique constraints for "unique among active/non-deleted rows" (pairs with soft delete in [Ch 15](topic.html?p=15-managers-model-inheritance)).
- `JSONField` for data you store and return mostly as a blob, or for long-tail attributes queried with `contains`.
- Postgres FTS when search is a feature, not the product.
- Raw SQL for recursive CTEs, `LATERAL`, `DISTINCT ON` combos, or DB functions with no ORM equivalent — wrapped in one well-tested function.

### When NOT to use

- Do not index every column "just in case": each index slows every INSERT/UPDATE and bloats vacuum.
- Do not put frequently filtered, typed, relational data in `JSONField` — make it a column (you lose FKs, types, and simple indexes).
- Do not use `ArrayField` for things that need referential integrity (user IDs) — use M2M.
- Do not pick Postgres FTS for typo-tolerant, faceted, multilingual search at scale — use OpenSearch/Elasticsearch.
- Do not reach for `extra()` in new code; it is a legacy API.

## 7. Common Mistakes & Best Practices

**1. Relying on `exists()` checks for uniqueness.** Two requests race and both insert. *Instead:* a `UniqueConstraint` plus `get_or_create`/`update_or_create`, or catch `IntegrityError` in a nested `atomic()`.

**2. Formatting SQL strings.** `raw(f"... '{q}'")` or `"%s" % q` is SQL injection. *Instead:* pass `params`. Note the difference: `cursor.execute(sql, [q])` is safe, `cursor.execute(sql % q)` is not.

**3. Functional index that the query never uses.**

```python
# Before: index on Lower("email") but query uses iexact -> UPPER(...) in SQL, index unused
User.objects.filter(email__iexact=e)

# After: query the same expression the index was built on
User.objects.annotate(e=Lower("email")).filter(e=e.lower())
# or index Upper("email"), or store a normalized/citext column
```

**4. Missing `django.contrib.postgres` in `INSTALLED_APPS`.** The `__search`, `__trigram_similar` and `__unaccent` lookups are registered by the app; without it you get `FieldError: Unsupported lookup`.

**5. Catching `IntegrityError` without a savepoint.** Inside `ATOMIC_REQUESTS` or an outer `atomic()`, swallowing the error leaves the transaction broken (`TransactionManagementError` on the next query). *Instead:* wrap just the insert in its own `with transaction.atomic():` (see [Ch 14](topic.html?p=14-transactions-concurrency)).

**6. `null=True` on a field in a `UniqueConstraint` without thinking about NULLs.** In SQL, NULLs are distinct by default, so many rows with `NULL` pass. On PostgreSQL 15+ use `nulls_distinct=False` (Django 5.0+) if you want at most one NULL.

**7. Plain `AddIndex` on a huge table in a deploy.** It blocks writes for the duration. *Instead:* `AddIndexConcurrently` with `atomic = False`, as its own migration.

**8. Treating `.raw()` like a QuerySet.** It cannot be filtered further or `count()`-ed cheaply, and skipping columns makes deferred loads (an N+1 in disguise). Select every column you will touch.

**Best practices checklist:** name every index/constraint deliberately; review `sqlmigrate` output; check plans with `qs.explain(analyze=True)` on production-like data; keep raw SQL in one module with tests; add `violation_error_message` for user-facing constraints.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: unused indexes eating write throughput.** In production, insert latency on `orders` creeps up after months of "just add an index". Root cause: a dozen overlapping indexes. Debug with `pg_stat_user_indexes` (`idx_scan = 0` over weeks) and drop redundant ones — e.g. the auto FK index on `tenant_id` when `(tenant_id, created_at)` exists.

**Pitfall: deploy hangs on migration.** `ALTER TABLE ... ADD CONSTRAINT` waits for an `ACCESS EXCLUSIVE` lock behind a long-running analytics query; meanwhile every request queues behind the waiting lock and the site goes down. Fix: set `lock_timeout` for migrations (e.g. via `RunSQL("SET lock_timeout = '5s'")` or DB role settings), retry, and use concurrent/`NOT VALID` patterns.

**Pitfall: JSONField query is slow despite a GIN index.** `attributes__color="red"` compiles to a `->` key comparison, which a default `jsonb_ops`/`jsonb_path_ops` GIN index does **not** serve; GIN serves containment (`@>`), `?` key existence (`jsonb_ops` only). Fix: rewrite as `attributes__contains={"color": "red"}`, or add a functional B-tree index on `KeyTextTransform("color", "attributes")`, or promote the key to a column.

**Pitfall: Full-text results go stale.** The `SearchVectorField` is only updated when your code updates it; a bulk import via `bulk_create` skipped your signal. Fix: a DB trigger or `GeneratedField`, or a periodic reindex task.

**Pitfall: IntegrityError surfaces as a 500.** A constraint fires during a race and the view does not handle it. Fix: catch `IntegrityError` at the write and translate to a 409/400; log constraint name (`e.__cause__.diag.constraint_name` on psycopg) for metrics.

**Debugging toolkit:**

```python
from django.db import connection, reset_queries
qs = Listing.objects.filter(attributes__contains={"color": "red"})
print(qs.query)                                   # approximate SQL
print(qs.explain(analyze=True, buffers=True))     # PostgreSQL options pass through
# DEBUG=True: connection.queries holds executed SQL and timings
```

- `pg_stat_statements` for top queries by total time; Sentry performance spans for per-request SQL.
- `django-debug-toolbar` SQL panel shows duplicated queries and lets you EXPLAIN in the browser.
- `manage.py dbshell` then `\d+ catalog_listing` to confirm what indexes actually exist (migrations state can drift from reality).

**Scaling notes:** Partial and covering indexes (`include=["total"]`) enable index-only scans for hot dashboards. For time-series tables consider `BrinIndex` and declarative partitioning (Django has no native partition API; manage with `RunSQL` or a library). When search outgrows Postgres, keep Postgres as the source of truth and stream changes to a search cluster via an outbox/CDC (see [Messaging · Outbox](../messaging/topic.html?p=21-idempotency-outbox)).

## 9. Interview Questions

**Q: What is the difference between `db_index=True`, `unique=True`, `Meta.indexes` and `Meta.constraints`?**
A: `db_index` and `unique` are single-column shortcuts on the field; `unique=True` also implies an index. `Meta.indexes` declares named indexes that can be composite, descending, functional (expressions), partial (`condition=`), covering (`include=`) or use custom operator classes. `Meta.constraints` declares rules the database enforces — `UniqueConstraint`, `CheckConstraint` and, on PostgreSQL, `ExclusionConstraint`. An index is a performance tool; a constraint is a correctness tool that may be implemented with an index (unique, exclusion). Prefer `Meta` declarations for anything beyond a trivial single-column index.

**Q: How do you enforce "email unique only among non-deleted users"?**
A: Use a conditional `UniqueConstraint(fields=["email"], condition=Q(deleted_at__isnull=True), name="uniq_live_email")`. On PostgreSQL this becomes a partial unique index, so deleted rows can share the email while live rows cannot. Pair it with a functional expression (`Lower("email")`) if uniqueness should be case-insensitive. Django 4.1+ validates it in `full_clean()`, so a ModelForm shows a friendly error, while the DB still guarantees correctness under concurrency.

**Q: Why prefer `UniqueConstraint` over `unique_together`?**
A: `UniqueConstraint` is a superset: it supports conditions, expressions, deferrable constraints, `include`, `nulls_distinct` and custom error messages/codes, and it sits alongside other constraints in `Meta.constraints`. The docs state `unique_together` may be deprecated in the future. Functionally a plain `UniqueConstraint(fields=[a, b])` produces the same unique index, so migrating is low-risk.

**Q: Is `Model.objects.raw()` safe from SQL injection?**
A: It is safe only if you pass user input through the `params` argument: `raw("... WHERE name = %s", [name])`. The driver then sends the value separately from the SQL text. If you build the string with f-strings, `%` formatting or concatenation, it is injectable — `raw()` does no escaping of the SQL string itself. The same applies to `cursor.execute`, `RawSQL` and `extra()`. Also don't quote placeholders (`'%s'`) and never parameterize identifiers — whitelist them.

**Q: How do you safely build a dynamic ORDER BY or table name in raw SQL?**
A: Placeholders only work for values, so identifiers must come from a server-side whitelist mapping user choices to known column names; then quote with `connection.ops.quote_name()`. Direction keywords are chosen from a fixed pair (`ASC`/`DESC`). Better still, stay in the ORM: `order_by()` with a whitelisted field name is injection-safe because Django validates field names against the model.

**Q: What does `raw()` require, and what are its limitations?**
A: The query must return the model's primary key column; Django maps other columns to fields by name (use `translations=` to remap). Columns you don't select become deferred fields that trigger an extra query on access. A `RawQuerySet` can be iterated and indexed but cannot be further filtered, annotated or chained, and `len()` executes the whole query. Extra selected columns become plain attributes on the instances.

**Q: When would you use `JSONField` and when a normal column?**
A: Use JSONField for genuinely schemaless data: per-tenant custom attributes, third-party webhook payloads, settings blobs — data mostly read and written as a whole or queried by containment. Use real columns for anything typed, frequently filtered or sorted, or relational, because columns get types, constraints, FKs, simple B-tree indexes and accurate planner statistics. A common production smell is a JSON key that every query filters on — promote it to a column (or at least a functional index).

**Q: How do you index a JSONField in PostgreSQL?**
A: For containment queries (`__contains`, `@>`) add `GinIndex(fields=["data"], opclasses=["jsonb_path_ops"], name=...)`; the default `jsonb_ops` also supports key-existence (`has_key`). For equality/range on one key, add a functional B-tree index on the key expression, e.g. `Index(KeyTextTransform("color", "data"), name=...)`, and query with the matching lookup. Always confirm with `explain()`, because `data__color="red"` and `data__contains={"color": "red"}` compile to different operators served by different indexes.

**Q: How does full-text search work in Django with PostgreSQL?**
A: `SearchVector` produces a `tsvector` (normalized lexemes, optionally weighted), `SearchQuery` produces a `tsquery` (plain, phrase, raw or websearch syntax), and the `@@` match is what `filter(vector=query)` emits; `SearchRank` orders results. Computing the vector per query is slow, so store it in a `SearchVectorField`, keep it updated (task, trigger or GeneratedField) and put a GIN index on it. For typo tolerance add `pg_trgm` and `TrigramSimilarity`. It requires `django.contrib.postgres` in INSTALLED_APPS.

**Q: You must add an index to a 200M-row table in production. How? (Senior)**
A: A plain `CREATE INDEX` holds a lock that blocks writes for the whole build, so use `AddIndexConcurrently` from `django.contrib.postgres.operations` in its own migration with `atomic = False`. Run it as a separate release step, set a `lock_timeout`/`statement_timeout` appropriate to the build, and monitor. If it fails it leaves an INVALID index that you must drop and recreate. Confirm usage afterwards with `explain(analyze=True)` and `pg_stat_user_indexes`, and consider whether a partial index on the hot subset would be far smaller. Similar care applies to constraints: add as `NOT VALID` via `RunSQL` then `VALIDATE CONSTRAINT`, with `SeparateDatabaseAndState` to keep Django's state consistent.

**Q: How would you guarantee no double-booking of a room under concurrency? (Senior)**
A: Application checks ("is there an overlapping booking?") are racy under READ COMMITTED. Options: (1) an `ExclusionConstraint` on `(room =, during &&)` with a GiST index and `btree_gist` — the database atomically rejects overlaps and you translate `IntegrityError` to a 409; (2) lock a parent row with `select_for_update()` on the room before checking and inserting, serializing bookings per room; (3) for slot-based systems, a `UniqueConstraint(room, slot)`. The exclusion constraint is the strongest because it protects every write path, not just the code path that remembers to lock. Mention handling cancelled bookings via the constraint's `condition`.

**Q: Your JSONB filter is slow even though there is a GIN index. How do you debug it? (Senior)**
A: Start with `qs.explain(analyze=True)` and `str(qs.query)` to see the generated operator. Key-path lookups like `data__status="x"` compile to `->`/`->>` comparisons that GIN does not serve; only containment (`@>`) and existence operators use it, and `jsonb_path_ops` doesn't support `?`. Fix by rewriting as `data__contains={...}`, adding a functional B-tree index on the extracted key, or promoting the key to a column. Also check statistics: the planner has poor selectivity estimates for JSON contents, so `ANALYZE` and possibly extended statistics or a real column give better plans.

**Q: When is raw SQL the right call in a Django codebase, and how do you keep it maintainable? (Senior)**
A: When the ORM cannot express the query efficiently — recursive CTEs for trees, `LATERAL` joins, vendor functions, bulk upserts with complex conflict handling, or hand-tuned reporting queries. First try `Subquery`, `Window`, custom `Func`/`Lookup` classes, which keep composability. If raw SQL wins, isolate it in a repository/service function with a typed return, parameterize everything, cover it with tests against real PostgreSQL, and reference table names via `Model._meta.db_table` so renames don't silently break it. Document why the ORM version wasn't used, with EXPLAIN evidence.

**Q: Do constraints in `Meta.constraints` get validated by `save()`?**
A: No. `save()` sends the INSERT/UPDATE and the database enforces the constraint, raising `IntegrityError` on violation. `full_clean()` (called by ModelForm and DRF ModelSerializer for unique validators, but not by `save()`) runs `validate_constraints()` since Django 4.1 and raises `ValidationError` with your `violation_error_message`. Python-side validation can still race, so the DB check is the real guarantee.

**Q: What is the extra `_like` index Django creates on PostgreSQL?**
A: For `CharField`/`TextField` with `db_index=True` or `unique=True`, Django adds a second index using `varchar_pattern_ops`/`text_pattern_ops` so that `LIKE 'abc%'` (`startswith`) can use an index under non-C collations. If you never do prefix searches it is wasted write cost; you can declare the index explicitly via `Meta.indexes` instead of `db_index=True` to avoid it.

## 10. Quick Revision & Cheat Sheet

| Need | Django |
|---|---|
| Composite index | `models.Index(fields=["a", "-b"], name=...)` |
| Case-insensitive index | `models.Index(Lower("email"), name=...)` |
| Partial index | `models.Index(fields=["created_at"], condition=Q(status="pending"), name=...)` |
| Covering index | `models.Index(fields=["user"], include=["total"], name=...)` |
| Unique among active | `UniqueConstraint(fields=["sku"], condition=Q(is_active=True), name=...)` |
| Domain rule | `CheckConstraint(condition=Q(price__gte=0), name=...)` |
| No overlap | `ExclusionConstraint(expressions=[("room", "="), ("during", "&&")])` |
| Non-blocking index | `AddIndexConcurrently(...)` + `atomic = False` |
| Instances from SQL | `Model.objects.raw(sql, params)` (include PK) |
| Arbitrary SQL | `with connection.cursor() as c: c.execute(sql, params)` |
| JSON containment | `filter(data__contains={...})` + `GinIndex(opclasses=["jsonb_path_ops"])` |
| Full-text | `SearchVectorField` + `GinIndex` + `SearchQuery(search_type="websearch")` |

- Constraints are correctness; validation is UX. Put rules in the DB.
- Every index costs writes — measure with `pg_stat_user_indexes`.
- The index must match the SQL Django *generates*; verify with `explain()`.
- Placeholders are `%s` on all backends, never quoted, values only.
- `extra()` is legacy; prefer expressions, `RawSQL` with params, or `raw()`.
- `django.contrib.postgres` must be in `INSTALLED_APPS` for search/trigram lookups.
- Extensions (`pg_trgm`, `btree_gist`) come first, via migration operations.
- 5.1+: `CheckConstraint(condition=...)`; `index_together` is gone.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" "psycopg[binary]"`, run PostgreSQL locally (e.g. `docker run -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16`), point `DATABASES` at it.

1. **Partial unique.** Build `Product` from §5.1. Insert two inactive rows with the same SKU (succeeds) and two active ones (fails with `IntegrityError`). Then call `full_clean()` and read the `ValidationError`.
2. **Index matching.** Seed 200k rows. Compare `explain(analyze=True)` for `name__iexact`, `annotate(n=Lower("name")).filter(n=...)`, with and without the functional index. Write down which index each uses.
3. **Injection lab.** Write a deliberately vulnerable view using `raw(f"...")`, exploit it with `' OR 1=1 --`, then fix it with params and a whitelist for sorting.
4. **JSON indexing.** Store 100k `attributes` blobs; measure `attributes__color="red"` vs `attributes__contains={"color": "red"}` with a `jsonb_path_ops` GIN index.
5. **Concurrent index.** Write a migration with `AddIndexConcurrently`; run `sqlmigrate` to confirm `CONCURRENTLY`; try it without `atomic = False` and read the error.

**Mini project — "Rentals":** listings with tags (`ArrayField`), JSON amenities, weighted full-text search with a stored `SearchVectorField` refreshed by a task, trigram "did you mean", and bookings guarded by an `ExclusionConstraint`. Add a load test that fires 50 concurrent booking requests for the same dates and prove exactly one succeeds.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 08 · Models & Fields](topic.html?p=08-models-fields) · [Ch 11 · Migrations](topic.html?p=11-migrations) · [Ch 12 · Aggregation, Annotation, Subqueries & Window Functions](topic.html?p=12-aggregation-annotation-subqueries) · [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization) · [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) · [Ch 28 · Security](topic.html?p=28-security) · [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases)

**Other handbooks:** [SQL · Indexes](../sql/topic.html?p=19-indexes) · [SQL · Index Design](../sql/topic.html?p=20-index-design) · [SQL · Execution Plans](../sql/topic.html?p=22-execution-plans) · [SQL · JSON & Semi-structured](../sql/topic.html?p=24-json-semistructured) · [SQL · Keys & Constraints](../sql/topic.html?p=29-keys-constraints) · [Database Design · Schema Evolution](../database-design/topic.html?p=27-schema-evolution)

**Free resources:**
- **Models: Indexes and Constraints reference** — Django docs · *Intermediate* · authoritative option list for `Index`, `UniqueConstraint`, `CheckConstraint`. <https://docs.djangoproject.com/en/5.2/ref/models/indexes/>
- **Performing raw SQL queries** — Django docs · *Intermediate* · `raw()`, cursors, params and the injection warnings. <https://docs.djangoproject.com/en/5.2/topics/db/sql/>
- **django.contrib.postgres** — Django docs · *Intermediate* · fields, indexes, constraints, search, operations. <https://docs.djangoproject.com/en/5.2/ref/contrib/postgres/>
- **Full text search in Django** — Django docs · *Intermediate* · SearchVector/Query/Rank with weighting and performance notes. <https://docs.djangoproject.com/en/5.2/ref/contrib/postgres/search/>
- **PostgreSQL: Indexes chapter** — PostgreSQL docs · *Intermediate* · partial, expression, GIN/GiST and index-only scans. <https://www.postgresql.org/docs/current/indexes.html>
- **PostgreSQL: Full Text Search** — PostgreSQL docs · *Advanced* · tsvector/tsquery internals and dictionaries. <https://www.postgresql.org/docs/current/textsearch.html>
- **Use The Index, Luke** — Markus Winand · *Intermediate* · the best free explanation of how B-tree indexes serve queries. <https://use-the-index-luke.com/>

---

*Django Handbook — chapter 16.*
