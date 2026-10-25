# 09 · Relationships: ForeignKey, ManyToMany & OneToOne

> **In one line:** Django relations are database foreign keys plus Python descriptors — a `ForeignKey` is an indexed `<name>_id` column with an accessor on each side, `on_delete` is a policy Django's deletion collector runs in Python, and `related_name` is the name of the reverse door — so modelling relations well means knowing both the SQL they create and the queries their accessors fire.

---

## 1. Overview

> **Builds on:** [Ch 08 · Models & Fields](topic.html?p=08-models-fields) (fields, `null`/`blank`, `_meta`). Querying across relations and the N+1 problem are developed in [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) and [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization).

Real data is connected. An order belongs to a customer, a book has many authors, a user has exactly one profile, a comment can be attached to a post *or* a photo *or* a video, a category has subcategories. In SQL you express these with foreign keys and junction tables; in Python you want to write `order.customer.email` and `book.authors.all()`.

The naive approach stores ids as plain integers (`customer_id = IntegerField()`) and looks things up by hand. You lose referential integrity (ids pointing at deleted rows), you write the same lookup code everywhere, and nothing tells you what should happen to orders when a customer is deleted. The opposite naive approach is to use relations without understanding them: every `order.customer` access in a loop is a query, deleting one user silently cascades through a dozen tables, and two `ForeignKey(User)` fields on one model refuse to start because their reverse accessors clash.

Django's three relation fields cover the shapes you need:

- **`ForeignKey`** — many-to-one. Many orders → one customer. Creates a column with a database FK constraint and an index.
- **`ManyToManyField`** — many-to-many. Books ↔ authors. Creates a hidden junction ("through") table, or uses one you define to hold extra data.
- **`OneToOneField`** — one-to-one. User ↔ profile. A ForeignKey with `unique=True` whose reverse side returns a single object.

Each field installs **descriptors** on both models so you can traverse the relation from either side, and each needs a deletion policy (`on_delete`) and, often, a **`related_name`** for the reverse side. Add `GenericForeignKey` for polymorphic "attach to anything" relations and `"self"` for trees and graphs, and you have the whole toolbox — along with its sharp edges.

> **Why this matters:** "Explain `on_delete` options", "what is `related_name`", "how do you add extra fields to a many-to-many", "what is the difference between `ForeignKey(unique=True)` and `OneToOneField`" and "when would you use a GenericForeignKey" are staples of every Django interview.

## 2. Core Concepts

- **Forward relation** — accessed from the model that declares the field (`order.customer`). *Why it matters:* it loads one object, and the result is cached on the instance.
- **Reverse relation** — accessed from the target model (`customer.orders.all()`). *Why it matters:* it is a **manager**, i.e. a fresh query each time you call `.all()` unless prefetched.
- **`attname` (`customer_id`)** — the raw column value on the instance. *Why it matters:* reading `order.customer_id` costs no query; `order.customer.id` costs one if the object is not loaded.
- **`on_delete`** — what happens to rows that reference an object being deleted: `CASCADE`, `PROTECT`, `RESTRICT`, `SET_NULL`, `SET_DEFAULT`, `SET(...)`, `DO_NOTHING`. Required on every FK and O2O.
- **Collector** — `django.db.models.deletion.Collector`, which walks relations in Python, applies `on_delete`, sends signals and issues the DELETE/UPDATE statements. *Why it matters:* Django emulates `ON DELETE`; the database constraint itself is plain.
- **`related_name`** — name of the reverse accessor on the target (`customer.orders` instead of `customer.order_set`). `"+"` disables it.
- **`related_query_name`** — name used in reverse *lookups* (`Customer.objects.filter(order__total__gt=100)`); defaults to `related_name` if set, else the model name.
- **Through model** — the junction table of an M2M; auto-created (`app_book_authors`) or explicit via `through=` to carry extra columns (role, date joined, position).
- **`symmetrical`** — for M2M to `"self"`: whether the relation is mirrored (friends) or directed (followers).
- **`limit_choices_to`** — restricts choices in forms/admin for the relation.
- **`to_field`** — point the FK at a unique non-pk column.
- **`db_constraint=False`** — create the column and index without a database FK constraint (legacy, cross-database, or sharded data). *Why it matters:* integrity becomes your problem.
- **Lazy reference** — refer to a model by string (`"catalog.Product"`, `"self"`, `settings.AUTH_USER_MODEL`) to avoid circular imports and swappable-model problems.
- **GenericForeignKey** — `content_type` FK + `object_id` + `GenericForeignKey()`, from `django.contrib.contenttypes`; points at any model. `GenericRelation` gives the reverse side.
- **Related descriptors** — `ForwardManyToOneDescriptor`, `ReverseManyToOneDescriptor`, `ManyToManyDescriptor`, `ForwardOneToOneDescriptor`, `ReverseOneToOneDescriptor`: the classes that implement attribute access.

## 3. Theory & Principles

### What a ForeignKey becomes

```python
class Order(models.Model):
    customer = models.ForeignKey("accounts.Customer", on_delete=models.PROTECT, related_name="orders")
```

At class creation `ForeignKey.contribute_to_class` sets `name="customer"`, `attname="customer_id"`, `column="customer_id"` and installs a `ForwardManyToOneDescriptor` at `Order.customer`. Once both models are loaded (relations by string are resolved lazily through the app registry), `contribute_to_related_class` installs a `ReverseManyToOneDescriptor` at `Customer.orders`. Migrations produce:

```sql
ALTER TABLE "shop_order" ADD COLUMN "customer_id" bigint NOT NULL
    CONSTRAINT "shop_order_customer_id_fk_accounts_customer_id"
    REFERENCES "accounts_customer"("id") DEFERRABLE INITIALLY DEFERRED;
CREATE INDEX "shop_order_customer_id_..." ON "shop_order" ("customer_id");
```

Three things to notice. The column type matches the target's primary key (`bigint` here). Django **indexes FK columns by default** (`db_index=True`), because nearly every reverse access and join uses them. And on PostgreSQL the constraint is `DEFERRABLE INITIALLY DEFERRED` — checked at commit time, not per statement — which is what lets Django insert or delete related rows in any order inside a transaction. Note what is **absent**: no `ON DELETE CASCADE`. The database only enforces "the referenced row must exist"; the cascade is Django's job.

### How the accessors behave

- **`order.customer`** — `ForwardManyToOneDescriptor.__get__` looks in the instance's field cache (`order._state.fields_cache`); on a miss it runs `SELECT ... FROM accounts_customer WHERE id = %s` and caches the result. Second access is free. `select_related("customer")` fills the cache via a JOIN.
- **`order.customer = c`** — sets both the cache and `order.customer_id = c.pk`. Assigning an unsaved object raises a `ValueError` on save.
- **`customer.orders`** — returns a `RelatedManager` (built by `create_reverse_many_to_one_manager`) whose base queryset is `Order.objects.filter(customer=customer)`. Every `.all()` / `.filter()` is a new query, unless `prefetch_related("orders")` populated `_prefetched_objects_cache` — and even then, `.filter()` on the manager re-queries.
- **`book.authors`** — a `ManyRelatedManager` querying through the junction table; supports `add()`, `remove()`, `set()`, `clear()`, `create()`.
- **`user.profile`** (reverse O2O) — `ReverseOneToOneDescriptor` runs a query and returns one object, or raises `User.profile.RelatedObjectDoesNotExist` (a subclass of both `Profile.DoesNotExist` and `AttributeError`, so `hasattr(user, "profile")` works).

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj09a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj09b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">One ForeignKey, two doors: forward descriptor vs reverse manager</text>
  <rect x="30" y="50" width="300" height="170" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="180" y="72" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">shop_order</text>
  <text x="48" y="96" fill="#1e293b">id            bigint PK</text>
  <text x="48" y="116" fill="#1e293b" font-weight="bold">customer_id   bigint NOT NULL  (indexed)</text>
  <text x="48" y="136" fill="#1e293b">total         numeric(12,2)</text>
  <text x="48" y="164" fill="#334155" font-size="10">FK constraint: REFERENCES accounts_customer(id)</text>
  <text x="48" y="180" fill="#334155" font-size="10">DEFERRABLE INITIALLY DEFERRED</text>
  <text x="48" y="200" fill="#dc2626" font-size="10">no ON DELETE clause &#8212; Django's Collector does it</text>
  <rect x="550" y="50" width="300" height="170" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="700" y="72" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">accounts_customer</text>
  <text x="568" y="96" fill="#1e293b">id            bigint PK</text>
  <text x="568" y="116" fill="#1e293b">email         varchar UNIQUE</text>
  <text x="568" y="136" fill="#1e293b">name          varchar</text>
  <path d="M330,116 L548,96" stroke="#2563eb" stroke-width="2" marker-end="url(#dj09a)"/>
  <text x="440" y="96" text-anchor="middle" fill="#1e40af" font-size="10">many &#8594; one</text>
  <rect x="30" y="240" width="400" height="160" rx="10" fill="#f8fafc" stroke="#2563eb" stroke-width="2"/>
  <text x="230" y="262" text-anchor="middle" fill="#1e40af" font-weight="bold">Forward: order.customer</text>
  <text x="46" y="284" fill="#1e293b" font-size="10">ForwardManyToOneDescriptor.__get__</text>
  <text x="46" y="302" fill="#1e293b" font-size="10">1. in order._state.fields_cache? &#8594; return (0 queries)</text>
  <text x="46" y="320" fill="#1e293b" font-size="10">2. else SELECT ... WHERE id = order.customer_id, cache it</text>
  <text x="46" y="338" fill="#1e293b" font-size="10">order.customer_id &#8594; plain attribute, never a query</text>
  <text x="46" y="360" fill="#16a34a" font-size="10" font-weight="bold">select_related("customer") fills the cache via JOIN</text>
  <text x="46" y="382" fill="#dc2626" font-size="10">in a loop without it: 1 query per order (N+1)</text>
  <rect x="450" y="240" width="400" height="160" rx="10" fill="#f8fafc" stroke="#7c3aed" stroke-width="2"/>
  <text x="650" y="262" text-anchor="middle" fill="#5b21b6" font-weight="bold">Reverse: customer.orders (related_name)</text>
  <text x="466" y="284" fill="#1e293b" font-size="10">ReverseManyToOneDescriptor &#8594; RelatedManager</text>
  <text x="466" y="302" fill="#1e293b" font-size="10">base queryset: Order.objects.filter(customer=customer)</text>
  <text x="466" y="320" fill="#1e293b" font-size="10">each .all() / .count() / .filter() = new query</text>
  <text x="466" y="338" fill="#1e293b" font-size="10">default name without related_name: order_set</text>
  <text x="466" y="360" fill="#16a34a" font-size="10" font-weight="bold">prefetch_related("orders"): 1 extra query, IN (...)</text>
  <text x="466" y="382" fill="#dc2626" font-size="10">.filter() on a prefetched manager re-queries</text>
  <path d="M180,222 L180,238" stroke="#2563eb" stroke-width="2" marker-end="url(#dj09a)"/>
  <path d="M700,222 L700,238" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj09b)"/>
</svg>
```

### `on_delete`: the options and what they really do

| Option | Effect when the referenced object is deleted | Typical use |
|---|---|---|
| `CASCADE` | Delete the referencing rows too (recursively) | Children that cannot exist alone: order lines, comments |
| `PROTECT` | Refuse: raise `ProtectedError` | Financial/history data: orders → customer, invoices → product |
| `RESTRICT` (3.1+) | Refuse, **unless** the referencing row is itself being deleted by a CASCADE in the same operation; raises `RestrictedError` | Complex graphs where a parent cascade should win |
| `SET_NULL` | Set the FK to NULL (requires `null=True`) | Optional links: "assigned_to" a staff member who leaves |
| `SET_DEFAULT` | Set to the field's `default` | Rare; a "unknown/system" sentinel row |
| `SET(value_or_callable)` | Set to a value or the result of a callable | Reassign to a sentinel user: `SET(get_deleted_user)` |
| `DO_NOTHING` | Django does nothing; the DB constraint decides (usually an `IntegrityError` at commit) | Legacy schemas with real DB-level `ON DELETE`, or managed elsewhere |

`RESTRICT` vs `PROTECT` is the subtle one. Suppose `Artist` → `Album` (CASCADE) and `Song` has FKs to both `Album` (CASCADE) and `Artist` (RESTRICT). Deleting the artist cascades to albums, which cascades to songs — since every song is already being removed via a cascade path, `RESTRICT` allows it. Deleting a single song's artist *directly*, when that song would not otherwise be deleted, is blocked. `PROTECT` would block the artist deletion in both cases.

### How the Collector deletes

`instance.delete()` and `QuerySet.delete()` both create a `Collector`:

1. `collector.collect(objs)` — for each object, inspect every reverse relation (`_meta.related_objects`). For `CASCADE`, query the related rows and collect them recursively; for `PROTECT`/`RESTRICT`, gather offenders and raise; for `SET_*`, record field updates.
2. **Fast deletes** — when a related model has no signals connected, no further cascades and no generic relations, Django skips loading those rows into Python and issues a single `DELETE ... WHERE fk_id IN (...)`.
3. `collector.delete()` — inside a transaction: send `pre_delete` for each collected object, run the `SET_NULL`/`SET(...)` UPDATEs, DELETE in dependency order (children first), send `post_delete`, and clear pks on the Python objects. Returns `(total, {"app.Model": count, ...})`.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj09c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">customer.delete(): Django's Collector applies on_delete in Python</text>
  <rect x="340" y="40" width="200" height="40" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#991b1b" font-weight="bold">Customer #7 .delete()</text>
  <path d="M380,82 L150,124" stroke="#334155" stroke-width="2" marker-end="url(#dj09c)"/>
  <path d="M440,82 L440,124" stroke="#334155" stroke-width="2" marker-end="url(#dj09c)"/>
  <path d="M500,82 L730,124" stroke="#334155" stroke-width="2" marker-end="url(#dj09c)"/>
  <rect x="30" y="126" width="240" height="80" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="150" y="148" text-anchor="middle" fill="#92400e" font-weight="bold">Address.customer CASCADE</text>
  <text x="150" y="168" text-anchor="middle" fill="#b45309" font-size="10">no signals, no further relations</text>
  <text x="150" y="186" text-anchor="middle" fill="#b45309" font-size="10">&#8594; FAST delete: one DELETE ... IN</text>
  <rect x="320" y="126" width="240" height="80" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="440" y="148" text-anchor="middle" fill="#1e40af" font-weight="bold">Ticket.assignee SET_NULL</text>
  <text x="440" y="168" text-anchor="middle" fill="#1e293b" font-size="10">collected as a field update</text>
  <text x="440" y="186" text-anchor="middle" fill="#1e293b" font-size="10">&#8594; UPDATE ticket SET assignee_id = NULL</text>
  <rect x="610" y="126" width="240" height="80" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="730" y="148" text-anchor="middle" fill="#5b21b6" font-weight="bold">Order.customer PROTECT</text>
  <text x="730" y="168" text-anchor="middle" fill="#1e293b" font-size="10">any orders exist?</text>
  <text x="730" y="186" text-anchor="middle" fill="#dc2626" font-size="10" font-weight="bold">&#8594; raise ProtectedError, delete nothing</text>
  <rect x="30" y="226" width="820" height="96" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="440" y="248" text-anchor="middle" fill="#1e293b" font-weight="bold">If nothing is protected: collector.delete() in one transaction</text>
  <text x="46" y="270" fill="#334155" font-size="10">1. pre_delete signal for each loaded object (skipped for fast-deleted rows)</text>
  <text x="46" y="288" fill="#334155" font-size="10">2. UPDATEs for SET_NULL / SET_DEFAULT / SET(...)   3. DELETE children first, then parents (dependency order)</text>
  <text x="46" y="306" fill="#334155" font-size="10">4. post_delete signals, instance.pk = None &#8594; returns (total, {"app.Model": n, ...})</text>
  <rect x="30" y="338" width="820" height="50" rx="10" fill="#fee2e2" stroke="#dc2626"/>
  <text x="440" y="358" text-anchor="middle" fill="#991b1b" font-size="10">Cost: CASCADE over objects with signals loads every dependant into memory. Deleting a user with 2M events = 2M objects.</text>
  <text x="440" y="376" text-anchor="middle" fill="#991b1b" font-size="10">DB-level ON DELETE is not used, so raw SQL DELETEs bypass on_delete entirely and hit the FK constraint.</text>
</svg>
```

> **Version note:** Django 6.0 adds an option for database-level on-delete behaviour; in 5.2 LTS, `on_delete` is always emulated by the collector as described here.

## 4. Architecture & Workflow

### Many-to-many and the through table

```python
class Book(models.Model):
    title = models.CharField(max_length=200)
    authors = models.ManyToManyField("Author", related_name="books")
```

Migrations create a junction table with two FKs and a unique pair:

```sql
CREATE TABLE "library_book_authors" (
    "id" bigint NOT NULL PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
    "book_id" bigint NOT NULL REFERENCES "library_book" ("id") DEFERRABLE INITIALLY DEFERRED,
    "author_id" bigint NOT NULL REFERENCES "library_author" ("id") DEFERRABLE INITIALLY DEFERRED,
    CONSTRAINT "library_book_authors_book_id_author_id_..._uniq" UNIQUE ("book_id", "author_id")
);
```

`book.authors.add(a1, a2)` inserts junction rows. When the through model is auto-created and nobody listens to `m2m_changed`, Django can use `INSERT ... ON CONFLICT DO NOTHING` directly; otherwise it first SELECTs existing pairs to avoid duplicates, then bulk-inserts the rest, sending `m2m_changed` (`pre_add`/`post_add`). `remove()` deletes junction rows (not authors), `clear()` deletes all of them for this book, and `set([...])` computes the diff and calls remove/add.

When the relationship itself has data — the author's **role** on a book, the **date** a user joined a group, the **position** of a track in a playlist — declare an explicit **through model**:

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj09d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">ManyToMany with an explicit through model</text>
  <rect x="30" y="60" width="200" height="110" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="130" y="82" text-anchor="middle" fill="#1e40af" font-weight="bold">Project</text>
  <text x="46" y="106" fill="#1e293b" font-size="10">id, name</text>
  <text x="46" y="126" fill="#1e293b" font-size="10">members = M2M(User,</text>
  <text x="46" y="142" fill="#1e293b" font-size="10">  through="Membership")</text>
  <rect x="340" y="50" width="200" height="140" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="72" text-anchor="middle" fill="#14532d" font-weight="bold">Membership (through)</text>
  <text x="356" y="96" fill="#1e293b" font-size="10">project_id  FK CASCADE</text>
  <text x="356" y="114" fill="#1e293b" font-size="10">user_id     FK CASCADE</text>
  <text x="356" y="132" fill="#1e293b" font-size="10">role        varchar</text>
  <text x="356" y="150" fill="#1e293b" font-size="10">joined_at   timestamptz</text>
  <text x="356" y="172" fill="#166534" font-size="10">UniqueConstraint(project, user)</text>
  <rect x="650" y="60" width="200" height="110" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="750" y="82" text-anchor="middle" fill="#5b21b6" font-weight="bold">User</text>
  <text x="666" y="106" fill="#1e293b" font-size="10">id, email</text>
  <text x="666" y="126" fill="#1e293b" font-size="10">reverse: user.projects</text>
  <text x="666" y="142" fill="#1e293b" font-size="10">reverse: user.memberships</text>
  <path d="M338,104 L232,104" stroke="#16a34a" stroke-width="2" marker-end="url(#dj09d)"/>
  <path d="M542,118 L648,118" stroke="#16a34a" stroke-width="2" marker-end="url(#dj09d)"/>
  <rect x="30" y="210" width="820" height="104" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="440" y="232" text-anchor="middle" fill="#1e293b" font-weight="bold">How you use it</text>
  <text x="46" y="254" fill="#334155" font-size="10">project.members.add(u, through_defaults={"role": "editor"})     &#8594; INSERT into membership (2.2+)</text>
  <text x="46" y="272" fill="#334155" font-size="10">Membership.objects.create(project=p, user=u, role="owner")      &#8594; when you need full control</text>
  <text x="46" y="290" fill="#334155" font-size="10">project.members.filter(membership__role="owner")                 &#8594; JOIN through the through table</text>
  <text x="46" y="306" fill="#334155" font-size="10">project.memberships.select_related("user")                       &#8594; read role + user in one query</text>
</svg>
```

### Choosing the relation shape

```text
Does each B belong to exactly one A?          → ForeignKey on B  (B.a = FK(A))
Can each B belong to many A and vice versa?   → ManyToManyField (through= if the link has data)
Is it exactly one B per A, optional extension? → OneToOneField on B (B.a = O2O(A, primary_key=True?))
Can B point at many different model types?    → GenericForeignKey (or several nullable FKs + CheckConstraint)
Does A point at other A rows (tree, graph)?   → ForeignKey("self") / ManyToManyField("self", symmetrical=...)
```

### Naming, clashes and `related_query_name`

Two FKs from one model to the same target both want the default reverse accessor `message_set`, so `manage.py check` fails with `fields.E304`/`E305` (reverse accessor/query name clashes). Give each a distinct `related_name`:

```python
class Message(models.Model):
    sender = models.ForeignKey(User, on_delete=models.CASCADE, related_name="sent_messages")
    recipient = models.ForeignKey(User, on_delete=models.CASCADE, related_name="received_messages")
```

Reverse **lookups** use `related_query_name`, which defaults to `related_name`: `User.objects.filter(sent_messages__subject__icontains="invoice")`. On abstract base classes use placeholders so each concrete child gets a unique name: `related_name="%(app_label)s_%(class)s_set"`. Use `related_name="+"` to suppress the reverse accessor entirely (e.g. `created_by` on 40 models — you do not want 40 accessors on `User`).

## 5. Implementation

### Simple example: a blog

```python
# blog/models.py
from django.conf import settings
from django.db import models


class Category(models.Model):
    name = models.CharField(max_length=80)
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.CASCADE,
                               related_name="children")            # self-referential tree


class Tag(models.Model):
    name = models.SlugField(unique=True)


class Post(models.Model):
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT,
                               related_name="posts")
    category = models.ForeignKey(Category, null=True, blank=True, on_delete=models.SET_NULL,
                                 related_name="posts")
    tags = models.ManyToManyField(Tag, blank=True, related_name="posts")   # blank: optional in forms
    title = models.CharField(max_length=200)


class AuthorProfile(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                                primary_key=True, related_name="author_profile")
    bio = models.TextField(blank=True)
```

```python
>>> post = Post.objects.get(pk=1)        # 1 query
>>> post.author_id                        # 0 queries: raw column
3
>>> post.author.username                  # 1 query, then cached
>>> post.author.username                  # 0 queries
>>> user = post.author
>>> user.posts.count()                    # SELECT COUNT(*) ... WHERE author_id = 3
>>> user.posts.filter(title__startswith="D")   # new query each call
>>> post.tags.add(python, django)         # junction INSERTs; m2m_changed fires
>>> post.tags.set([django])               # removes python, keeps django
>>> hasattr(user, "author_profile")       # False if no profile row (no exception)
>>> Category.objects.get(name="Web").children.all()   # immediate subcategories
```

Note `null=True` on `ManyToManyField` does nothing (there is no column) — use `blank=True` to make it optional in forms. And `primary_key=True` on the O2O makes the profile share the user's id: no extra id column, one less index.

The SQL behind `user.posts.filter(title__startswith="D")`:

```sql
SELECT "blog_post"."id", "blog_post"."author_id", "blog_post"."category_id", "blog_post"."title"
FROM "blog_post"
WHERE ("blog_post"."author_id" = 3 AND "blog_post"."title"::text LIKE 'D%');
```

And a reverse lookup across the M2M — "users who wrote posts tagged django":

```python
User.objects.filter(posts__tags__name="django").distinct()
```

```sql
SELECT DISTINCT "auth_user"."id", "auth_user"."username", ...
FROM "auth_user"
INNER JOIN "blog_post" ON ("auth_user"."id" = "blog_post"."author_id")
INNER JOIN "blog_post_tags" ON ("blog_post"."id" = "blog_post_tags"."post_id")
INNER JOIN "blog_tag" ON ("blog_post_tags"."tag_id" = "blog_tag"."id")
WHERE "blog_tag"."name" = 'django';
```

The `.distinct()` is needed because filtering across to-many relations returns one row per matching join path — a user with three django posts would appear three times. (Multi-valued filter semantics are developed in [Ch 10](topic.html?p=10-querysets-lookups).)

### Real-world example: a SaaS project tool

Requirements: projects have members with roles and join dates; tasks belong to a project, may be assigned to a member (unassign if the user is deleted), and have subtasks; deleting a project must remove its tasks; users who authored audit records must never be hard-deleted silently; comments can attach to tasks or projects.

```python
# work/models.py
from django.conf import settings
from django.contrib.contenttypes.fields import GenericForeignKey, GenericRelation
from django.contrib.contenttypes.models import ContentType
from django.db import models
from django.utils import timezone


def get_sentinel_user():
    from django.contrib.auth import get_user_model
    return get_user_model().objects.get_or_create(username="deleted-user")[0]


class Comment(models.Model):
    content_type = models.ForeignKey(ContentType, on_delete=models.CASCADE)
    object_id = models.PositiveBigIntegerField()
    target = GenericForeignKey("content_type", "object_id")
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.SET(get_sentinel_user),
                               related_name="+")
    body = models.TextField()
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        indexes = [models.Index(fields=["content_type", "object_id"])]   # GFK lookups need this


class Project(models.Model):
    name = models.CharField(max_length=120)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT,
                              related_name="owned_projects")
    members = models.ManyToManyField(settings.AUTH_USER_MODEL, through="Membership",
                                     related_name="projects")
    comments = GenericRelation(Comment, related_query_name="project")   # reverse + cascade


class Membership(models.Model):
    class Role(models.TextChoices):
        OWNER = "owner"
        EDITOR = "editor"
        VIEWER = "viewer"

    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                             related_name="memberships")
    role = models.CharField(max_length=10, choices=Role, default=Role.VIEWER)
    joined_at = models.DateTimeField(default=timezone.now)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["project", "user"], name="uniq_membership")]


class Task(models.Model):
    project = models.ForeignKey(Project, on_delete=models.CASCADE, related_name="tasks")
    parent = models.ForeignKey("self", null=True, blank=True, on_delete=models.CASCADE,
                               related_name="subtasks")
    assignee = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True,
                                 on_delete=models.SET_NULL, related_name="assigned_tasks",
                                 limit_choices_to={"is_active": True})
    title = models.CharField(max_length=200)
    comments = GenericRelation(Comment, related_query_name="task")
```

Using it:

```python
p = Project.objects.create(name="Launch", owner=alice)
p.members.add(alice, through_defaults={"role": Membership.Role.OWNER})
p.members.add(bob, carol, through_defaults={"role": Membership.Role.EDITOR})

# Who are the editors? (JOIN through the through table)
p.members.filter(memberships__role="editor", memberships__project=p)

# Role + user in one query, via the through model
for m in p.memberships.select_related("user"):
    print(m.user.email, m.role, m.joined_at)

# Generic relation: comments on any object
Comment.objects.create(target=task, author=bob, body="On it")
task.comments.all()                                    # via GenericRelation
Comment.objects.filter(task__project=p)                # related_query_name makes this possible

# Deleting
bob.delete()        # tasks assigned to bob → assignee NULL; his memberships deleted;
                    # his comments reassigned to the sentinel user
alice.delete()      # ProtectedError: she owns projects
p.delete()          # tasks, subtasks, memberships AND comments (via GenericRelation) deleted
```

> **Gotcha:** without `GenericRelation` on `Task`, deleting a task leaves its comments orphaned — a GFK has no database FK, so nothing cascades. `GenericRelation` is what teaches the collector about the dependency.

The delete of a project, as captured by `connection.queries` (abridged), shows the collector at work:

```sql
SELECT ... FROM "work_task" WHERE "work_task"."project_id" IN (12);            -- collect tasks
SELECT ... FROM "work_task" WHERE "work_task"."parent_id" IN (40, 41, 42);    -- recurse into subtasks
DELETE FROM "work_comment" WHERE ("work_comment"."content_type_id" = 18
       AND "work_comment"."object_id" IN (40, 41, 42));                       -- fast delete via GenericRelation
DELETE FROM "work_membership" WHERE "work_membership"."project_id" IN (12);    -- fast delete
DELETE FROM "work_task" WHERE "work_task"."id" IN (42, 41, 40);
DELETE FROM "work_comment" WHERE ("work_comment"."content_type_id" = 17 AND "work_comment"."object_id" IN (12));
DELETE FROM "work_project" WHERE "work_project"."id" IN (12);
```

### Self-referential M2M: followers vs friends

```python
class Profile(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    friends = models.ManyToManyField("self", blank=True)                    # symmetrical=True default
    following = models.ManyToManyField("self", symmetrical=False, blank=True,
                                       related_name="followers")
```

`a.friends.add(b)` also makes `b.friends` contain `a` (Django writes both rows). `a.following.add(b)` is one-way, and `b.followers.all()` gives the reverse.

### Trees in practice

`ForeignKey("self")` (adjacency list) is simple and writes are cheap, but reading a whole subtree needs one query per level — or a recursive CTE via raw SQL ([SQL · Recursive CTEs](../sql/topic.html?p=12-recursive-cte)). Libraries such as django-treebeard (materialized path / nested sets) or django-mptt make subtree reads a single indexed query at the cost of more expensive writes.

## 6. Advantages, Disadvantages & Trade-offs

| Choice | Pros | Cons |
|---|---|---|
| `ForeignKey` | Real DB integrity, indexed, joins well | Must choose `on_delete` carefully |
| Auto M2M | Zero boilerplate, `add/remove/set` | No extra data; hard to migrate to a through model later |
| Explicit through model | Extra columns, own constraints, own admin | More code; create rows via the through model or `through_defaults` |
| `OneToOneField` | Splits optional/large data from a hot table; extends third-party models | Reverse access raises if missing; an extra join |
| `GenericForeignKey` | One table for "attach to anything" | No FK integrity, no direct joins, needs `GenericRelation` for cascades, index on `(content_type, object_id)` |
| Several nullable FKs + `CheckConstraint` (exactly one set) | Real integrity, normal joins | One column per target type |
| `db_constraint=False` | Works across DBs / huge tables / legacy | Integrity is your problem; orphans happen |

### When to use
- `PROTECT` for anything with financial, legal or audit meaning; `CASCADE` for true composition (lines of an order).
- An explicit through model **from the start** whenever a relationship could plausibly gain attributes.
- `OneToOneField(User, primary_key=True)` for profiles instead of modifying the user table (if you did not make a custom user model).

### When NOT to use
- `GenericForeignKey` for core relations you query and join constantly — use concrete FKs.
- `CASCADE` from users to business records; deleting an account should not erase invoices.
- Very deep `ForeignKey("self")` hierarchies read as whole subtrees on every request — use a tree library or CTE.

## 7. Common Mistakes & Best Practices

**1. Reflexive `on_delete=models.CASCADE`.** Copy-pasted everywhere, it turns one admin delete into data loss across the schema. *Instead:* decide per relation; prefer `PROTECT` for business data and soft-delete users.

**2. Hard-coding `User`.** `ForeignKey("auth.User")` or `from django.contrib.auth.models import User` breaks with a custom user model. *Instead:* `settings.AUTH_USER_MODEL` in model fields and `get_user_model()` in code ([Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user)).

**3. `obj.fk.id` instead of `obj.fk_id`.** The former loads the related object to read a value you already have. *Instead:* `order.customer_id`, and `filter(customer_id=...)`.

**4. Missing `related_name`.** Default `order_set` names are vague and clash when two FKs share a target. *Instead:* always name reverse accessors in plural business terms.

**5. Treating a prefetched manager like a list.**

```python
# Before: prefetch is wasted, one query per project
projects = Project.objects.prefetch_related("tasks")
for p in projects:
    open_tasks = p.tasks.filter(done=False)          # new query each time

# After: filter in the prefetch, store on an attribute
from django.db.models import Prefetch
projects = Project.objects.prefetch_related(
    Prefetch("tasks", queryset=Task.objects.filter(done=False), to_attr="open_tasks"))
for p in projects:
    p.open_tasks                                     # list, no query
```

**6. `null=True` on `ManyToManyField`.** Has no effect and triggers a system check warning. Use `blank=True`.

**7. Reverse O2O without handling absence.** `request.user.profile` raises `RelatedObjectDoesNotExist` for users without a profile → 500. *Instead:* `getattr(user, "profile", None)` / `hasattr`, or guarantee creation in the signup service.

**8. GFK without an index.** Lookups by `(content_type_id, object_id)` sequential-scan the comments table. Add `Index(fields=["content_type", "object_id"])`.

**9. Changing an auto M2M to a through model by editing the field.** Django cannot migrate that automatically and wants to drop and recreate the table. *Instead:* `SeparateDatabaseAndState` to adopt the existing table as the through model ([Ch 11 · Migrations](topic.html?p=11-migrations)).

## 8. Production: Pitfalls, Debugging & Scaling

**The cascading delete that took the site down.** Support deletes a spam account; the account has 3 million `Event` rows with a `post_delete` receiver. The collector loads every event into memory to send signals, the request runs for minutes, holds locks and the worker gets OOM-killed. Symptom: one admin click → memory spike and lock waits on `events`. Fix: soft-delete users; delete dependants in batches in a background task; remove signal receivers on high-volume models so fast-delete applies; or `on_delete=DO_NOTHING` with a database-level cleanup job.

**`ProtectedError` surfaced as 500.** A view calls `obj.delete()` on something referenced via `PROTECT`. Catch `ProtectedError`/`RestrictedError` and return a 409/form error explaining what depends on the object (the exception carries `protected_objects`).

**Raw SQL bypasses `on_delete`.** A data engineer runs `DELETE FROM accounts_customer WHERE ...` — Django's cascades never run, the FK constraint fails at commit, or, with `db_constraint=False`, orphans appear silently. Document that the DB has no `ON DELETE`; add constraints/scripts accordingly.

**Unindexed through/GFK lookups.** Auto M2M through tables get indexes on both FKs plus the unique pair; hand-written through models get FK indexes automatically, but if you query `Membership.objects.filter(user=..., role=...)` heavily, add a composite index.

**FK targets changing type.** Switching a target's pk from `int` to `bigint` (e.g. fixing `W042`) also alters every FK column pointing at it — on large tables that is a long rewrite. Plan it as a dedicated migration.

**Debugging relations.** `Model._meta.get_fields()` lists forward and reverse relations (`include_hidden=True` shows `+` ones). `Model._meta.related_objects` shows what will be considered on delete. To preview a delete without running it:

```python
from django.db import router
from django.db.models.deletion import Collector

collector = Collector(using=router.db_for_write(Customer))
collector.collect([customer])
print({model._meta.label: len(objs) for model, objs in collector.data.items()})
print(collector.fast_deletes)        # querysets that will be deleted without loading
```

The admin's delete confirmation page uses the same machinery (`NestedObjects`) to show what will cascade.

**Scaling notes.** Very high-cardinality reverse relations (a user's events) should not be traversed with `user.events.all()` in requests — paginate or aggregate. M2M `prefetch_related` over thousands of parents builds a large `IN (...)` list; batch it or use `iterator(chunk_size=...)` with prefetch. Partitioned tables and sharding may force `db_constraint=False` ([Database Design · Sharding](../database-design/topic.html?p=12-sharding)).

## 9. Interview Questions

**Q: Explain the on_delete options for ForeignKey.**
A: `CASCADE` deletes referencing rows along with the target; `PROTECT` refuses the deletion with `ProtectedError`; `RESTRICT` (3.1+) also refuses, raising `RestrictedError`, except when the referencing object is itself being deleted through another CASCADE path in the same operation; `SET_NULL` sets the FK to NULL and requires `null=True`; `SET_DEFAULT` sets the field's default; `SET(value_or_callable)` sets a given value such as a sentinel user; and `DO_NOTHING` leaves it to the database constraint, which normally raises an `IntegrityError`. Importantly, Django emulates these in Python with its deletion collector rather than creating `ON DELETE` clauses in the schema. Choose per relation: CASCADE for composition, PROTECT for business and financial records.

**Q: What is the difference between PROTECT and RESTRICT?**
A: Both prevent deleting an object that is still referenced. `PROTECT` always blocks, even if the referencing rows would themselves be deleted by another cascade in the same delete. `RESTRICT` allows the deletion when every referencing object is already being removed via a CASCADE from somewhere else in the same operation, and blocks it otherwise. It is useful in graphs where a parent's cascade should win but direct deletion of the restricted target should not. Both are enforced by Django's collector, not the database.

**Q: What is related_name and why should you set it?**
A: It names the reverse accessor that a `ForeignKey`, `OneToOneField` or `ManyToManyField` installs on the target model, for example `customer.orders` instead of the default `customer.order_set`. It also becomes the default `related_query_name` used in reverse filters like `Customer.objects.filter(orders__total__gt=100)`. You must set it when two relations from one model point at the same target, or `check` fails with a clash error. Setting it to `"+"` disables the reverse relation, and on abstract models you use `%(app_label)s` / `%(class)s` placeholders to keep names unique.

**Q: How do you store extra data on a many-to-many relationship?**
A: Declare an explicit through model with two ForeignKeys and the extra fields, and point the M2M at it: `members = ManyToManyField(User, through="Membership")`. Add a `UniqueConstraint` on the pair if duplicates are not allowed. Since Django 2.2 you can still use `add()`, `create()` and `set()` with `through_defaults={"role": "editor"}`, or create `Membership` rows directly. Query extra fields by filtering across the through model (`members__memberships__role`) or by iterating `project.memberships.select_related("user")`. Decide early, because converting an auto M2M to a through model requires a `SeparateDatabaseAndState` migration.

**Q: What is the difference between ForeignKey(unique=True) and OneToOneField?**
A: At the database level they are identical: a FK column with a unique constraint. The difference is in the Python API. With `OneToOneField` the reverse accessor returns a single object (`user.profile`) and raises `RelatedObjectDoesNotExist` if missing; with `ForeignKey(unique=True)` the reverse accessor is still a manager (`user.profile_set.get()`), which is clumsy. Django even emits a system check warning suggesting `OneToOneField`. O2O is also what multi-table inheritance uses as the parent link.

**Q: Why does accessing order.customer inside a loop slow down a page?**
A: The forward accessor queries the related object the first time it is accessed on each instance and caches it only on that instance. Iterating 100 orders and touching `order.customer` therefore issues 100 extra queries — the N+1 problem. The fix is `select_related("customer")`, which loads customers with a JOIN in the same query, or `prefetch_related` for reverse and many-to-many relations. If you only need the id, read `order.customer_id`, which never queries.

**Q: What happens in the database when you call book.authors.add(author)?**
A: Django inserts a row into the junction table linking `book_id` and `author_id`. If the through table is auto-created and no `m2m_changed` receivers exist, Django can insert with `ON CONFLICT DO NOTHING`; otherwise it first SELECTs which pairs already exist and inserts only the missing ones. It sends `m2m_changed` with `pre_add` and `post_add` actions. The book must already be saved, since the junction row needs its primary key. `save()` and `post_save` of Book are not involved at all — which is why signal handlers on M2M changes must listen to `m2m_changed`.

**Q: What is a GenericForeignKey and what are its downsides?**
A: It is a polymorphic relation from `django.contrib.contenttypes`: a `content_type` FK to `ContentType`, an `object_id` column and a `GenericForeignKey("content_type", "object_id")` descriptor that resolves to an object of any model. It is handy for comments, tags, likes or audit records that attach to many types. Downsides: no database foreign key, so no referential integrity and orphans unless you add `GenericRelation` on each target (which also enables cascades and reverse queries); you cannot filter or `select_related` through the GFK itself; and you need an index on `(content_type, object_id)`. `prefetch_related` does support GFKs, and Django 5.0 adds `GenericPrefetch` for per-type querysets.

**Q: Why should you use settings.AUTH_USER_MODEL in ForeignKeys?**
A: Because the user model is swappable: projects can define their own and set `AUTH_USER_MODEL`. A FK to `"auth.User"` or an imported `User` class hard-wires the default model, breaking reusable apps and making migration to a custom user model painful. `settings.AUTH_USER_MODEL` is a lazy string reference that migrations record as a swappable dependency. In runtime code use `get_user_model()`.

**Q: A support agent deletes one user in the admin and the database CPU spikes, the request times out and other requests stall. What happened and how would you prevent it? (Senior)**
A: The deletion collector followed every reverse relation with `CASCADE`. For related models that have signal receivers or further cascades, it loads all dependent rows into Python to send `pre_delete`/`post_delete`, then deletes them in one transaction, holding row locks for the duration — with millions of events or logs that is minutes of work and huge memory. Prevention: soft-delete accounts (an `is_active`/`deleted_at` flag) instead of hard deletes; use `PROTECT` on business data so a hard delete fails fast; remove signal receivers from high-volume child models so fast delete (a single `DELETE ... IN`) applies; and perform necessary purges asynchronously in batches. Disable the admin delete for such models with `has_delete_permission`.

**Q: When would you choose a GenericForeignKey versus separate nullable foreign keys, and how would you keep integrity? (Senior)**
A: A GFK fits when the set of target types is open-ended or plugin-driven, reads are mostly "comments of this object", and you can live without DB-level integrity. If the targets are a small fixed set (say tasks and projects) that you query and join often, separate nullable FKs — `task = FK(null=True)`, `project = FK(null=True)` — give real foreign keys, normal joins, `select_related` and cascades. Enforce "exactly one is set" with a `CheckConstraint` such as `Q(task__isnull=False, project__isnull=True) | Q(task__isnull=True, project__isnull=False)`. For GFKs, keep integrity by declaring `GenericRelation` on every target, indexing `(content_type, object_id)`, and running periodic orphan-detection jobs.

**Q: How do you model hierarchical data like categories or org charts in Django, and what are the trade-offs? (Senior)**
A: The simplest is an adjacency list, `parent = ForeignKey("self", null=True, on_delete=...)`: cheap writes and moves, but fetching a full subtree needs one query per level or a recursive CTE via raw SQL. Materialized path (django-treebeard's `MP_Node`) stores the path string, so a subtree is one indexed `LIKE 'path%'` query, at the cost of rewriting paths on moves. Nested sets (treebeard `NS_Node`, django-mptt) make subtree reads very fast but make inserts and moves expensive because many rows are renumbered. Choose by read/write ratio and tree depth, and consider PostgreSQL's `ltree` for path queries. Also pick `on_delete` deliberately: CASCADE on `parent` deletes whole subtrees.

**Q: How would you migrate an existing auto-created ManyToMany to an explicit through model without data loss? (Senior)**
A: Changing `through=` on an existing field makes the autodetector want to drop and recreate the table, losing rows. Instead, create a through model whose `db_table` is the existing junction table name and whose two FK fields match its columns, then write a migration using `SeparateDatabaseAndState`: in `state_operations`, create the through model and alter the field to use it; in `database_operations`, do nothing (or only rename). In a follow-up migration, add the new columns (role, joined_at) with defaults normally. Test on a copy of production and check `sqlmigrate` to confirm no destructive SQL.

**Q: Why does User.objects.filter(posts__tags__name="django") return duplicates?**
A: Filtering across a to-many relation produces a JOIN, and the result has one row per matching combination — a user with three posts tagged django appears three times. Django does not de-duplicate automatically. Add `.distinct()`, or better, express it as `filter(Exists(Post.objects.filter(author=OuterRef("pk"), tags__name="django")))`, which never duplicates and is often faster on large tables. The same issue affects `count()` and aggregates over such joins.

## 10. Quick Revision & Cheat Sheet

| Relation | Declare on | DB | Forward | Reverse |
|---|---|---|---|---|
| FK | the "many" side | `<name>_id` + FK constraint + index | `obj.fk` (object, cached) | `target.<related_name>` manager (`<model>_set`) |
| O2O | the extension side | FK + UNIQUE | `obj.o2o` | `target.<related_name>` single object or raises |
| M2M | either side | junction table, unique pair | manager | manager |
| M2M through | either side | your model | manager | manager + `through` reverse |
| GFK | the attaching model | `content_type_id` + `object_id` (no FK) | object of any type | `GenericRelation` |

- `on_delete` is emulated by the Collector in Python; no DB `ON DELETE` in 5.2.
- `PROTECT` for business data; `CASCADE` for composition; `SET_NULL` needs `null=True`.
- `obj.fk_id` = no query; `obj.fk` = query once (or `select_related`).
- Reverse managers query every time; `.filter()` defeats a prefetch — use `Prefetch(to_attr=...)`.
- `related_name` on every relation; `"+"` to disable; `%(class)s` on abstract models.
- M2M: `add/remove/set/clear`, `through_defaults`, `m2m_changed` (not `post_save`).
- `null` on M2M is meaningless; use `blank=True`.
- FK to users: `settings.AUTH_USER_MODEL`.
- Filtering across to-many can duplicate rows: `distinct()` or `Exists()`.
- GFK needs an index and `GenericRelation` for cascades.

## 11. Hands-On Exercises

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2" "psycopg[binary]" django-debug-toolbar
django-admin startproject rellab . && python manage.py startapp work
```

1. **DDL inspection.** Create `Project`, `Task`, `Membership` from §5 and read `sqlmigrate` output; find the FK constraints, the indexes, and confirm there is no `ON DELETE`.
2. **on_delete lab.** Create one user with owned projects, assigned tasks and comments. Try deleting them under `PROTECT`, then switch to `SET(get_sentinel_user)`; preview deletes with the `Collector` snippet before running them.
3. **RESTRICT vs PROTECT.** Build the Artist/Album/Song example and show the case where `RESTRICT` allows deletion and `PROTECT` does not.
4. **Through model.** Use `add(..., through_defaults=...)`, then query all projects where a user is an `owner` and list members with roles in one query.
5. **Duplicates.** Write the "users with posts tagged django" query with and without `distinct()`, then with `Exists`; compare SQL and `EXPLAIN`.
6. **GFK integrity.** Remove `GenericRelation` from `Task`, delete a task and find the orphaned comments; add it back and repeat.

**Mini project — "Team workspace":** organisations → teams → members (through model with role), projects with tasks and subtasks, comments via either GFK or a constrained pair of FKs (justify your choice in a README), soft-deleted users with a sentinel for authored content, a "delete organisation" Celery task that removes data in batches, and tests asserting delete behaviour and query counts for a project page.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 08 · Models & Fields](topic.html?p=08-models-fields) · [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) · [Ch 11 · Migrations](topic.html?p=11-migrations) · [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization) · [Ch 15 · Custom Managers, QuerySets & Model Inheritance](topic.html?p=15-managers-model-inheritance) · [Ch 19 · Signals](topic.html?p=19-signals) (`m2m_changed`, delete signals) · [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user) · [Ch 36 · Django Internals](topic.html?p=36-django-internals) (related descriptors)

**Other handbooks:** [SQL · Joins](../sql/topic.html?p=05-joins) · [SQL · Keys & Constraints](../sql/topic.html?p=29-keys-constraints) · [SQL · Recursive CTEs](../sql/topic.html?p=12-recursive-cte) · [SQL · Schema Design](../sql/topic.html?p=30-schema-design)

- **Making queries — related objects** — Django docs · *Beginner* · forward and reverse access, related managers and lookups across relations. <https://docs.djangoproject.com/en/5.2/topics/db/queries/>
- **Model field reference — relationship fields** — Django docs · *Intermediate* · every option of ForeignKey, ManyToManyField and OneToOneField, including all `on_delete` values. <https://docs.djangoproject.com/en/5.2/ref/models/fields/>
- **Many-to-many relationships** — Django docs · *Beginner* · worked examples of `add`, `remove`, `set` and through models. <https://docs.djangoproject.com/en/5.2/topics/db/examples/many_to_many/>
- **Related objects reference** — Django docs · *Intermediate* · the related manager API in detail. <https://docs.djangoproject.com/en/5.2/ref/models/relations/>
- **The contenttypes framework** — Django docs · *Intermediate* · GenericForeignKey, GenericRelation and their caveats. <https://docs.djangoproject.com/en/5.2/ref/contrib/contenttypes/>
- **django-treebeard** — GitHub · *Advanced* · materialized path and nested set trees for Django. <https://github.com/django-treebeard/django-treebeard>

---

*Django Handbook — chapter 09.*
