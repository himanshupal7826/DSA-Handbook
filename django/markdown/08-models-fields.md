# 08 · Models & Fields

> **In one line:** A Django model is a Python class that the `ModelBase` metaclass turns into a table definition, a validation schema and a row-to-object mapper at once — and almost every model bug (two kinds of "empty", silent invalid saves, overflowing IDs, unenforced choices) comes from confusing which of those three layers an option belongs to.

---

## 1. Overview

> **Builds on:** [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings) (models live in apps listed in `INSTALLED_APPS`, and `DEFAULT_AUTO_FIELD` is a setting) and [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation) (where `blank` and model validation surface to users).

Your application's data has rules: an order has a customer, a price is a decimal with two places, a status is one of five values, an email is unique. Those rules have to be expressed in three places that are easy to let drift apart — the **database schema** (`CREATE TABLE`, `NOT NULL`, `UNIQUE`, types), the **validation layer** (what a form or API will accept), and the **Python objects** your code manipulates. The naive approach writes SQL DDL by hand, a separate validation layer, and hand-rolled row mappers; within months the schema says one thing, the forms another, and the objects a third.

Django's **model** is a single declaration that drives all three. You write:

```python
class Product(models.Model):
    sku = models.CharField(max_length=20, unique=True)
    price = models.DecimalField(max_digits=10, decimal_places=2)
```

and Django derives the table (via migrations — [Ch 11 · Migrations](topic.html?p=11-migrations)), the validation (`full_clean()`, ModelForms, the admin, DRF ModelSerializers), and an object mapper (`Product.objects.get(...)` returns a `Product` with a `Decimal` price).

The catch is that the field options you pass are **not all the same kind of thing**. `null=True` changes the schema; `blank=True` changes only validation; `choices` changes validation and display but **not** the database; `default` is applied in Python, while `db_default` (5.0+) is applied by the database; `auto_now` is applied in `save()` and therefore *not* by `update()`. Knowing which layer each option lives in is exactly what the classic interview questions — "null vs blank", "does save() validate?", "why is this CharField both NULL and empty string?" — are testing.

## 2. Core Concepts

- **Model** — a subclass of `django.db.models.Model`; one class ≈ one table, one instance ≈ one row. *Why it matters:* it is the source of truth for schema and validation.
- **`ModelBase`** — the metaclass that processes the class body at import time: creates `_meta`, calls each field's `contribute_to_class`, adds the default manager and the `DoesNotExist`/`MultipleObjectsReturned` exceptions, and registers the model in the app registry.
- **`_meta` (`Options`)** — the model's metadata: fields, table name, ordering, constraints, relations. *Why it matters:* the admin, forms, serializers and migrations are all built by reading `_meta`.
- **Field** — a class attribute instance (`CharField`, `DecimalField`, …) that knows its DB column type (`db_type()`), how to convert values to and from the DB (`get_prep_value`, `from_db_value`, `to_python`) and its validation rules.
- **`null`** — **database-level**: column allows `NULL`. Default `False` (`NOT NULL`).
- **`blank`** — **validation-level**: empty value accepted by `full_clean()` / forms. Default `False`.
- **`default`** — value (or callable) used by Python when an instance is created without that field. *Why it matters:* not in the database schema (Django drops the DB default after a migration), so raw SQL inserts do not get it.
- **`db_default`** (5.0+) — a database-side default (literal or expression like `Now()`), present in the schema. *Why it matters:* applies to inserts from any client and helps zero-downtime column adds.
- **`choices`** — limits valid values for validation and provides `get_<field>_display()`; best expressed with `TextChoices`/`IntegerChoices`. *Why it matters:* the DB does **not** enforce it.
- **`unique` / `db_index`** — create a unique constraint / an index. `unique=True` implies an index.
- **`Meta`** — inner class for model-level options: `db_table`, `ordering`, `indexes`, `constraints`, `verbose_name`, `abstract`, `managed`, `get_latest_by`, `default_related_name`, `permissions`.
- **Primary key** — every model has exactly one; if you do not declare one Django adds `id` of type `DEFAULT_AUTO_FIELD` (`BigAutoField` in new projects). Django 5.2 also supports **composite primary keys** via `CompositePrimaryKey`.
- **`save()`** — persists the instance: INSERT for new rows, UPDATE for existing ones; sends `pre_save`/`post_save`; does **not** validate.
- **`full_clean()`** — runs `clean_fields()`, `clean()`, `validate_unique()` and `validate_constraints()` (4.1+); raises `ValidationError` with a dict of errors.
- **`_state`** — per-instance `adding` (not yet saved) and `db` (the alias it was loaded from). *Why it matters:* `save()` uses it to decide between INSERT and UPDATE.

## 3. Theory & Principles

### What happens when Python imports `models.py`

When Python executes `class Product(models.Model): ...`, the metaclass `ModelBase.__new__` runs:

1. It separates "contributable" attributes (anything with a `contribute_to_class` method — fields, managers, `Meta`) from plain attributes.
2. It creates `Options` from the inner `Meta` and attaches it as `_meta`. The default `db_table` is `<app_label>_<modelname lowercased>`.
3. It calls `field.contribute_to_class(cls, name)` for each field: the field learns its `name`, `attname` (`customer_id` for an FK named `customer`) and `column`, adds itself to `_meta`, and, for some fields, installs descriptors on the class (`DeferredAttribute` for normal fields, relation descriptors for FKs).
4. If no field has `primary_key=True`, `_meta` adds an auto field named `id` using the app's `default_auto_field` or `DEFAULT_AUTO_FIELD`.
5. It adds `objects = Manager()` if you defined no manager, creates `Product.DoesNotExist` and `Product.MultipleObjectsReturned`, and registers the model in `apps` (the app registry).

That is why model definitions must be importable without side effects and why an app must be in `INSTALLED_APPS` — the registry is how Django finds every model for migrations, relations by string (`"shop.Order"`), and the admin.

### Two empty values: `null` vs `blank`

`null` is about the column; `blank` is about validation. They combine into four cases:

| `null` | `blank` | Schema | `full_clean()` with empty | Typical use |
|---|---|---|---|---|
| False | False | `NOT NULL` | error "This field cannot be blank." | Required value (the default) |
| False | True | `NOT NULL` | allowed — stores `""` for strings | Optional text (`CharField`, `TextField`) |
| True | True | `NULL` allowed | allowed — stores `NULL` | Optional non-string (`DateField`, `IntegerField`, FK) |
| True | False | `NULL` allowed | error in forms; code can still save `None` | "Required in UI, but legacy rows may be NULL" |

The Django convention for string fields is **`blank=True` without `null=True`**: empty is `""`, and there is only one way to be empty. With `null=True` on a `CharField` you get two — `NULL` and `""` — and now `filter(nickname="")` misses half the "empty" rows and `filter(nickname__isnull=True)` misses the other half. The one exception: an **optional unique** string (e.g. an optional external id). Multiple `""` values would violate `UNIQUE`, but multiple `NULL`s do not (NULLs are distinct in a SQL unique constraint), so use `null=True, blank=True, unique=True` and make sure forms convert empty to `None` (`empty_value=None` on the form field).

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj08a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Which layer does each field option live in?</text>
  <rect x="20" y="44" width="270" height="250" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="155" y="66" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Database schema (DDL)</text>
  <text x="36" y="90" fill="#1e293b">null=True &#8594; column allows NULL</text>
  <text x="36" y="110" fill="#1e293b">unique=True &#8594; UNIQUE constraint</text>
  <text x="36" y="130" fill="#1e293b">db_index=True &#8594; CREATE INDEX</text>
  <text x="36" y="150" fill="#1e293b">max_length &#8594; varchar(n)</text>
  <text x="36" y="170" fill="#1e293b">db_default (5.0+) &#8594; DEFAULT expr</text>
  <text x="36" y="190" fill="#1e293b">db_column, db_comment, db_table</text>
  <text x="36" y="210" fill="#1e293b">Meta.indexes / Meta.constraints</text>
  <text x="36" y="236" fill="#1e40af" font-size="10">Enforced for EVERY writer:</text>
  <text x="36" y="252" fill="#1e40af" font-size="10">ORM, update(), raw SQL, other services</text>
  <rect x="305" y="44" width="270" height="250" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="66" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Validation (full_clean / forms)</text>
  <text x="321" y="90" fill="#1e293b">blank=True &#8594; empty accepted</text>
  <text x="321" y="110" fill="#1e293b">choices &#8594; value must be listed</text>
  <text x="321" y="130" fill="#1e293b">validators=[...]</text>
  <text x="321" y="150" fill="#1e293b">max_length (also checked here)</text>
  <text x="321" y="170" fill="#1e293b">editable=False &#8594; not in forms</text>
  <text x="321" y="190" fill="#1e293b">Model.clean() cross-field rules</text>
  <text x="321" y="210" fill="#1e293b">unique/constraints re-checked by SELECT</text>
  <text x="321" y="236" fill="#15803d" font-size="10">Runs ONLY when someone calls</text>
  <text x="321" y="252" fill="#15803d" font-size="10">full_clean(): ModelForm, admin, you</text>
  <rect x="590" y="44" width="270" height="250" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="725" y="66" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Python / save() behaviour</text>
  <text x="606" y="90" fill="#1e293b">default=callable &#8594; set in __init__</text>
  <text x="606" y="110" fill="#1e293b">auto_now / auto_now_add &#8594; pre_save</text>
  <text x="606" y="130" fill="#1e293b">to_python / from_db_value</text>
  <text x="606" y="150" fill="#1e293b">get_FOO_display() from choices</text>
  <text x="606" y="170" fill="#1e293b">verbose_name, help_text</text>
  <text x="606" y="190" fill="#1e293b">save() INSERT vs UPDATE logic</text>
  <text x="606" y="210" fill="#1e293b">pre_save / post_save signals</text>
  <text x="606" y="236" fill="#92400e" font-size="10">Skipped by QuerySet.update(),</text>
  <text x="606" y="252" fill="#92400e" font-size="10">bulk_create/bulk_update, raw SQL</text>
  <rect x="20" y="312" width="840" height="74" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="334" text-anchor="middle" fill="#991b1b" font-size="12" font-weight="bold">Interview traps that come straight from this picture</text>
  <text x="36" y="354" fill="#7f1d1d" font-size="10">save() does not call full_clean() &#183; choices are not a DB constraint (add CheckConstraint) &#183; default is not in the schema (use db_default)</text>
  <text x="36" y="372" fill="#7f1d1d" font-size="10">update() does not touch auto_now fields &#183; null=True on CharField gives two empties &#183; blank=True alone does not allow NULL</text>
</svg>
```

### What `save()` actually does

`Model.save()` → `save_base()` → `_save_table()`. Step by step:

1. Send **`pre_save`** (unless `raw`).
2. For each field, call `field.pre_save(instance, add)` — this is where `auto_now`/`auto_now_add` set timestamps and `FileField` commits the file to storage.
3. Decide INSERT vs UPDATE. If the instance has a pk value **and** is not in the "adding with a pk default" case, try an **UPDATE … WHERE pk = %s**. If that UPDATE matched **zero rows**, fall back to **INSERT**. If there is no pk value, INSERT directly. Since Django 3.0, when `_state.adding` is true and the pk field has a `default` (e.g. `UUIDField(default=uuid4)`), Django skips the UPDATE attempt and inserts straight away — saving a pointless query.
4. On INSERT, PostgreSQL returns the generated id via `RETURNING`, which is assigned back to `instance.pk`.
5. Set `_state.adding = False`, `_state.db = using`, and send **`post_save`** with `created=True/False`.

Notably absent: **validation**. `save()` writes what you give it; only database constraints can stop it. And because the UPDATE writes **every** concrete field, two processes that load the same row and save different fields will overwrite each other's changes (a lost update). `save(update_fields=["status"])` limits the UPDATE to the named columns — cheaper and much safer under concurrency.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj08b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">obj.save(): from Python object to SQL statement</text>
  <rect x="20" y="44" width="150" height="40" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="95" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">obj.save()</text>
  <path d="M172,64 L196,64" stroke="#334155" stroke-width="2" marker-end="url(#dj08b)"/>
  <rect x="198" y="44" width="150" height="40" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="273" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">pre_save signal</text>
  <text x="273" y="76" text-anchor="middle" fill="#5b21b6" font-size="9">synchronous, same txn</text>
  <path d="M350,64 L374,64" stroke="#334155" stroke-width="2" marker-end="url(#dj08b)"/>
  <rect x="376" y="44" width="200" height="40" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="476" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">field.pre_save() for each field</text>
  <text x="476" y="76" text-anchor="middle" fill="#92400e" font-size="9">auto_now timestamps, file commit</text>
  <path d="M578,64 L602,64" stroke="#334155" stroke-width="2" marker-end="url(#dj08b)"/>
  <rect x="604" y="44" width="256" height="40" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="732" y="62" text-anchor="middle" fill="#991b1b" font-weight="bold">NO full_clean() here</text>
  <text x="732" y="76" text-anchor="middle" fill="#7f1d1d" font-size="9">only DB constraints can reject</text>
  <path d="M440,86 L440,112" stroke="#334155" stroke-width="2" marker-end="url(#dj08b)"/>
  <rect x="300" y="114" width="280" height="50" rx="10" fill="#f8fafc" stroke="#334155" stroke-width="2"/>
  <text x="440" y="134" text-anchor="middle" fill="#1e293b" font-weight="bold">pk set? and not (adding with pk default)?</text>
  <text x="440" y="152" text-anchor="middle" fill="#334155" font-size="10">also: force_insert / force_update / update_fields</text>
  <path d="M300,140 L196,190" stroke="#334155" stroke-width="2" marker-end="url(#dj08b)"/>
  <text x="222" y="160" fill="#334155" font-size="10">no pk</text>
  <path d="M580,140 L684,190" stroke="#334155" stroke-width="2" marker-end="url(#dj08b)"/>
  <text x="640" y="160" fill="#334155" font-size="10">pk present</text>
  <rect x="20" y="192" width="330" height="66" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="185" y="212" text-anchor="middle" fill="#14532d" font-weight="bold">INSERT INTO ... RETURNING id</text>
  <text x="185" y="230" text-anchor="middle" fill="#166534" font-size="10">generated pk assigned to obj.pk</text>
  <text x="185" y="246" text-anchor="middle" fill="#166534" font-size="10">created=True</text>
  <rect x="530" y="192" width="330" height="66" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="695" y="212" text-anchor="middle" fill="#1e40af" font-weight="bold">UPDATE ... SET all columns WHERE id = %s</text>
  <text x="695" y="230" text-anchor="middle" fill="#1e293b" font-size="10">or only update_fields=[...]</text>
  <text x="695" y="246" text-anchor="middle" fill="#1e293b" font-size="10">rows matched = 0 &#8594; fall back to INSERT</text>
  <path d="M528,240 L352,240" stroke="#334155" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#dj08b)"/>
  <path d="M440,262 L440,288" stroke="#334155" stroke-width="2" marker-end="url(#dj08b)"/>
  <rect x="250" y="290" width="380" height="40" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="440" y="314" text-anchor="middle" fill="#1e293b" font-weight="bold">_state.adding=False, _state.db set &#8594; post_save(created=...)</text>
  <rect x="20" y="344" width="840" height="44" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="440" y="362" text-anchor="middle" fill="#92400e" font-size="10">Full-row UPDATE overwrites columns another process changed since you loaded the row (lost update).</text>
  <text x="440" y="378" text-anchor="middle" fill="#92400e" font-size="10">Use update_fields=[...] for targeted writes, or F() / select_for_update() for counters and contention (Ch 14).</text>
</svg>
```

### Value conversion

Each field mediates between three representations. `to_python()` converts arbitrary input (form strings, deserialised JSON) to the Python type; `get_prep_value()` turns the Python value into something the DB adapter accepts; `get_db_prep_value()` adds backend-specific tweaks; `from_db_value()` (if defined, as on custom fields and `JSONField`) converts what the database driver returns back to Python when loading. Custom fields implement exactly these hooks.

## 4. Architecture & Workflow

### From class to table to object

```text
models.py (class)
   │  import → ModelBase.__new__ → _meta (Options), fields.contribute_to_class, registry
   ▼
makemigrations → autodetector compares models' state vs migration state → 0001_initial.py
   ▼
migrate → SchemaEditor.create_model() → CREATE TABLE ... (field.db_type(), NULL/NOT NULL, UNIQUE)
   ▼
runtime:  Product(...).save()        → INSERT/UPDATE (get_db_prep_value)
          Product.objects.get(pk=1)  → SELECT → Model.from_db() → instance (from_db_value)
          product.full_clean()       → validators, clean(), unique & constraint SELECTs
```

You can see the DDL a model produces without touching the database:

```bash
python manage.py makemigrations shop
python manage.py sqlmigrate shop 0001
```

### Choosing a primary key

| Option | Column (PostgreSQL) | Pros | Cons |
|---|---|---|---|
| `AutoField` | `integer GENERATED BY DEFAULT AS IDENTITY` | Small, ordered | Overflows at ~2.1 billion |
| `BigAutoField` (default since 3.2) | `bigint` identity | Effectively never overflows; ordered | 8 bytes; enumerable in URLs |
| `UUIDField(primary_key=True, default=uuid.uuid4)` | `uuid` | Unguessable, generate anywhere (offline, client) | 16 bytes; random v4 inserts scatter across the B-tree (worse locality, bigger indexes) |
| Time-ordered UUID (v7 via a library) | `uuid` | Unguessable-ish and index-friendly | Leaks creation time |
| `CompositePrimaryKey("tenant_id", "id")` (5.2+) | composite `PRIMARY KEY` | Matches legacy/multi-tenant schemas | Young feature: limited admin support, FKs to it not supported |

> **Version note:** on PostgreSQL, Django 4.1+ creates auto fields as `GENERATED BY DEFAULT AS IDENTITY` columns rather than `serial`. Projects created before 3.2 may have `DEFAULT_AUTO_FIELD` unset, which triggers system check `models.W042` and keeps 32-bit `AutoField` ids — set it explicitly in settings or per app (`AppConfig.default_auto_field`).

A common production pattern is a `BigAutoField` primary key for joins and indexes plus a separate `public_id = UUIDField(default=uuid.uuid4, unique=True, editable=False)` used in URLs and APIs — internal efficiency, external opacity.

## 5. Implementation

### Simple example

```python
# library/models.py
from django.db import models


class Book(models.Model):
    class Genre(models.TextChoices):
        FICTION = "fic", "Fiction"
        SCIENCE = "sci", "Science"
        HISTORY = "his", "History"

    title = models.CharField(max_length=200)
    subtitle = models.CharField(max_length=200, blank=True)          # optional text: "" not NULL
    isbn = models.CharField(max_length=13, unique=True)
    genre = models.CharField(max_length=3, choices=Genre, default=Genre.FICTION)  # 5.0+: pass the enum
    pages = models.PositiveIntegerField(null=True, blank=True)       # optional number: NULL
    price = models.DecimalField(max_digits=8, decimal_places=2)      # money: Decimal, never Float
    published_on = models.DateField(null=True, blank=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["title"]

    def __str__(self):
        return self.title
```

```sql
-- python manage.py sqlmigrate library 0001 (PostgreSQL, abridged)
CREATE TABLE "library_book" (
    "id" bigint NOT NULL PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
    "title" varchar(200) NOT NULL,
    "subtitle" varchar(200) NOT NULL,
    "isbn" varchar(13) NOT NULL UNIQUE,
    "genre" varchar(3) NOT NULL,
    "pages" integer NULL CHECK ("pages" >= 0),
    "price" numeric(8, 2) NOT NULL,
    "published_on" date NULL,
    "created_at" timestamp with time zone NOT NULL,
    "updated_at" timestamp with time zone NOT NULL
);
CREATE INDEX "library_book_isbn_..._like" ON "library_book" ("isbn" varchar_pattern_ops);
CREATE INDEX "library_book_published_on_..." ON "library_book" ("published_on");
```

Read the DDL closely: `subtitle` is `NOT NULL` despite being optional (that is `blank=True`); `genre` has **no** CHECK constraint and **no** DEFAULT (choices and `default` live in Python); `PositiveIntegerField` does add a CHECK; `unique=True` on a `CharField` also gets a `_like` index for `LIKE 'abc%'` queries on PostgreSQL.

Exercising validation in the shell:

```python
>>> b = Book(title="Dune", isbn="9780441013593", genre="xyz", price="9.999")
>>> b.save()                     # succeeds! save() never validates; genre "xyz" is stored
>>> b.full_clean()
```

```text
ValidationError: {'genre': ["Value 'xyz' is not a valid choice."],
                  'price': ['Ensure that there are no more than 2 decimal places.']}
```

The row with an invalid genre is already in the database — `save()` accepted it. Notice that `isbn` is *not* reported even though a row with that ISBN exists: `validate_unique()` excludes the instance's own primary key, so it only complains when a *different* row has the value. Running `full_clean()` **before** `save()` is the pattern for code paths outside forms.

### Real-world example: an order model with invariants at every layer

```python
# shop/models.py
import uuid
from decimal import Decimal
from django.conf import settings
from django.core.exceptions import ValidationError
from django.core.validators import MinValueValidator
from django.db import models
from django.db.models import Q
from django.db.models.functions import Now
from django.urls import reverse


class Order(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending", "Pending"
        PAID = "paid", "Paid"
        SHIPPED = "shipped", "Shipped"
        CANCELLED = "cancelled", "Cancelled"

    public_id = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    customer = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT,
                                 related_name="orders")
    status = models.CharField(max_length=16, choices=Status, default=Status.PENDING,
                              db_default=Status.PENDING)
    subtotal = models.DecimalField(max_digits=12, decimal_places=2,
                                   validators=[MinValueValidator(Decimal("0"))])
    discount = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal("0"))
    coupon_code = models.CharField(max_length=32, blank=True)
    external_ref = models.CharField(max_length=64, null=True, blank=True, unique=True)  # optional unique
    notes = models.JSONField(default=dict, blank=True)      # callable default: never {} literal
    placed_at = models.DateTimeField(db_default=Now())       # DB clock; works for raw inserts too
    shipped_at = models.DateTimeField(null=True, blank=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-placed_at"]
        indexes = [models.Index(fields=["customer", "-placed_at"], name="order_cust_recent_idx")]
        constraints = [
            models.CheckConstraint(
                condition=Q(status__in=["pending", "paid", "shipped", "cancelled"]),
                name="order_status_valid",
            ),
            models.CheckConstraint(condition=Q(discount__lte=models.F("subtotal")),
                                   name="order_discount_lte_subtotal"),
            models.CheckConstraint(
                condition=Q(status="shipped", shipped_at__isnull=False) | ~Q(status="shipped"),
                name="order_shipped_has_timestamp",
            ),
        ]

    def __str__(self):
        return f"Order {self.public_id} ({self.get_status_display()})"

    def get_absolute_url(self):
        return reverse("order-detail", kwargs={"public_id": self.public_id})

    @property
    def total(self):
        return self.subtotal - self.discount

    def clean(self):
        # Cross-field rule with a friendly message; the CheckConstraint is the backstop.
        if self.discount and not self.coupon_code:
            raise ValidationError({"coupon_code": "A discount requires a coupon code."})

    def mark_shipped(self):
        from django.utils import timezone
        self.status = self.Status.SHIPPED
        self.shipped_at = timezone.now()
        self.save(update_fields=["status", "shipped_at", "updated_at"])  # include auto_now field
```

> **Version note:** `CheckConstraint(condition=...)` is the Django 5.1+ spelling; on 4.2 the argument is `check=...` (deprecated in 5.1). `choices=Status` (passing the enum class directly) works from 5.0; on 4.2 write `choices=Status.choices`. `db_default` requires 5.0+.

Because `Meta.constraints` are validated by `full_clean()` since 4.1, a ModelForm on `Order` reports constraint violations as form errors. And because they are real database constraints, `Order.objects.filter(...).update(status="bogus")` is rejected by PostgreSQL too — the layer that `update()` cannot bypass.

The `mark_shipped` UPDATE is narrow:

```sql
UPDATE "shop_order"
SET "status" = 'shipped', "shipped_at" = '2026-10-25T10:14:03+00:00'::timestamptz,
    "updated_at" = '2026-10-25T10:14:03+00:00'::timestamptz
WHERE "shop_order"."id" = 1042;
```

> **Gotcha:** `auto_now` fields are only updated when included in `update_fields`. Leave `updated_at` out of the list and it silently stops changing.

### Overriding `save()` correctly

```python
class Article(models.Model):
    title = models.CharField(max_length=200)
    slug = models.SlugField(max_length=220, unique=True)

    def save(self, *args, **kwargs):
        if not self.slug:
            from django.utils.text import slugify
            self.slug = slugify(self.title)[:200]
            update_fields = kwargs.get("update_fields")
            if update_fields is not None:            # keep update_fields callers correct
                kwargs["update_fields"] = {"slug"}.union(update_fields)
        super().save(*args, **kwargs)                # ALWAYS call super, pass args through
```

Remember that this override does not run for `QuerySet.update()`, `bulk_create()` or `bulk_update()` — derive values in a way that does not depend on `save()` if those paths exist.

### Custom field (when built-ins do not fit)

```python
from decimal import Decimal
from django.db import models


class CentsField(models.BigIntegerField):
    """Stores money as integer cents; exposes Decimal in Python."""

    def from_db_value(self, value, expression, connection):
        return None if value is None else Decimal(value) / 100

    def to_python(self, value):
        if value is None or isinstance(value, Decimal):
            return value
        return Decimal(str(value))

    def get_prep_value(self, value):
        value = self.to_python(value)
        return None if value is None else int(value * 100)
```

## 6. Advantages, Disadvantages & Trade-offs

| Decision | Option A | Option B | Guidance |
|---|---|---|---|
| Optional string | `blank=True` (`""`) | `null=True, blank=True` | A, unless the field is also `unique` |
| Default value | `default=` (Python) | `db_default=` (DB, 5.0+) | `db_default` when other writers exist or for safe column adds |
| Enumerations | `choices` only | `choices` + `CheckConstraint` | Add the constraint when data integrity matters |
| Money | `DecimalField` | `FloatField` / integer cents | Decimal (or cents); never float |
| PK | `BigAutoField` | `UUIDField` | Big int internally; UUID as a public id |
| Timestamps | `auto_now(_add)` | `default=timezone.now` / `db_default=Now()` | `auto_now` is not editable and skipped by `update()` |
| Uniqueness | `unique=True` | `UniqueConstraint` (with `condition=`, expressions) | `UniqueConstraint` for multi-column/partial |
| Default ordering | `Meta.ordering` | explicit `order_by()` | Meta ordering adds ORDER BY to every query — keep it cheap or omit |

### When to use
- Models as the single source of truth for schema and validation for any relational data Django owns.
- `full_clean()` in service functions, imports and tasks that create objects outside forms.
- Database constraints for every invariant that would corrupt data if violated.

### When NOT to use
- A model for data you do not own and cannot migrate — use `managed = False` (read-only mapping to an existing table or view) instead of letting migrations touch it.
- Fat models with business workflows that call external services in `save()` — use a service layer.
- `JSONField` as an excuse to skip modelling relational data you will filter and join on.

## 7. Common Mistakes & Best Practices

**1. `null=True` on `CharField`/`TextField`.** Two empty states, inconsistent filters, and `NOT NULL` migrations later. *Instead:* `blank=True` only (except optional-unique).

**2. Expecting `blank=True` to allow `None`.** Saving `pages=None` on `IntegerField(blank=True)` raises `IntegrityError: null value in column "pages"`. *Instead:* non-string optional fields need `null=True, blank=True`.

**3. Mutable defaults.** `default={}` or `default=[]` shares one object across instances (and migrations warn). *Instead:* `default=dict`, `default=list`, or a function.

**4. Calling the default.** `default=timezone.now()` evaluates once at import time — every row gets the server start time. *Instead:* `default=timezone.now` (no parentheses).

**5. Trusting `choices` for integrity.** A script or `update()` can write any value. *Instead:* add a `CheckConstraint`.

**6. Assuming `save()` validates.**

```python
# Before: invalid data reaches the DB
Order(customer=u, subtotal=Decimal("-5")).save()

# After: validate first in non-form code paths
order = Order(customer=u, subtotal=Decimal("-5"))
order.full_clean()      # ValidationError: subtotal must be >= 0
order.save()
```

**7. `FloatField` for money.** `0.1 + 0.2 != 0.3`. *Instead:* `DecimalField` with explicit `max_digits`/`decimal_places`, and `Decimal` arithmetic in Python.

**8. Expensive `Meta.ordering`.** `ordering = ["-created_at"]` without an index on a large table makes every unordered query (including admin and `first()`) sort. *Instead:* index the ordering column or drop `Meta.ordering` and order explicitly.

**9. Forgetting `__str__`.** The admin, shell and error messages show `Order object (1042)`. Always define it — cheaply, without touching relations (it is called in lists and dropdowns).

**10. Overriding `save()` without `*args, **kwargs`.** Breaks `using=`, `update_fields=` and `force_insert=` for callers. Always pass them through.

## 8. Production: Pitfalls, Debugging & Scaling

**Integer PK overflow.** A 32-bit `AutoField` on an event or log table hits 2,147,483,647 and every insert fails with `integer out of range`. Symptom: sudden total write outage on one table. Root cause: legacy `DEFAULT_AUTO_FIELD = AutoField`. Fix: migrate to `BigAutoField` — on a large table that rewrites the column and its FKs, so plan it (or do it early). Check old projects for warning `W042`.

**Adding a NOT NULL column to a big table.** Adding `status = CharField(default="active")` historically made Django set a DB default, backfill, then drop the default; long-running on huge tables and locking. With `db_default` (5.0+) the default stays in the schema and PostgreSQL 11+ can add a column with a constant default as a metadata-only change. See [Ch 11 · Migrations](topic.html?p=11-migrations).

**Lost updates from full-row saves.** Two workers load an order; one sets `status`, the other sets `notes`; the second `save()` writes back the stale `status`. Symptom: "the status flipped back by itself". Fix: `update_fields`, `F()` expressions, or `select_for_update()` ([Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency)).

**Naive vs aware datetimes.** With `USE_TZ = True` (the default since 5.0, and in every generated settings file long before) Django stores UTC and expects aware datetimes; assigning `datetime.now()` raises a `RuntimeWarning` and stores the wrong instant. Use `django.utils.timezone.now()`.

**Slow `__str__`.** A `__str__` that follows a FK (`f"{self.customer.name} – {self.id}"`) causes N+1 in admin dropdowns and log lines. Keep `__str__` to local columns.

**Debugging.** `python manage.py sqlmigrate app NNNN` for DDL; `Model._meta.get_fields()` to introspect; `connection.queries` (DEBUG) or debug-toolbar for what `save()` emits; `python manage.py check` for model system checks (`fields.E…`, `models.W…`).

```python
>>> from django.db import connection, reset_queries
>>> reset_queries(); o = Order.objects.get(pk=1); o.discount = 5; o.save()
>>> [q["sql"] for q in connection.queries]
```

**Scaling notes.** Narrow tables load faster; move rarely used large columns (`TextField` blobs, big JSON) into a OneToOne side table or use `defer()` ([Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization)). UUIDv4 primary keys on very hot insert tables bloat indexes; prefer bigint PK + UUID public id.

## 9. Interview Questions

**Q: What is the difference between null=True and blank=True?**
A: `null=True` is database-level: the column is created without `NOT NULL`, so it can store `NULL`. `blank=True` is validation-level: `full_clean()`, ModelForms and the admin accept an empty value. They are independent; for string fields the convention is `blank=True` alone so empty is stored as `""`, avoiding two kinds of empty. For non-string optional fields (dates, numbers, FKs) you need both, because there is no "empty string" for those types. The exception is an optional unique string, which needs `null=True` because multiple NULLs do not violate a unique constraint but multiple `""` values do.

**Q: Why should you avoid null=True on CharField?**
A: Because then a "no value" can be represented both as `NULL` and as `""`. Queries must check both (`Q(x="") | Q(x__isnull=True)`), forms produce `""` while code may write `None`, and uniqueness and indexing behave differently for each. Django's own convention is to store empty strings for text. The only common exception is a field that is optional and also `unique=True`.

**Q: Does Model.save() call full_clean()?**
A: No. `save()` sends `pre_save`, lets fields run `pre_save()` (auto timestamps), performs the INSERT or UPDATE and sends `post_save` — but never validates. Validation runs when you call `full_clean()`, which ModelForms and the admin do for you. That design keeps `save()` fast and predictable, but it means scripts, tasks and API code must call `full_clean()` themselves or rely on database constraints. DRF ModelSerializers run field and unique validators but not `Model.clean()`.

**Q: What does full_clean() do?**
A: It runs four steps and aggregates the errors into one `ValidationError` keyed by field: `clean_fields()` (each field's `to_python` and validators, including `blank` and `choices`), `clean()` (your cross-field hook), `validate_unique()` (SELECTs for `unique`, `unique_together` and similar), and, since Django 4.1, `validate_constraints()` for `Meta.constraints`. You can pass `exclude=` to skip fields, and `validate_unique=False` / `validate_constraints=False`. The unique and constraint checks are separate queries, so they are not race-proof — the database constraint is the real guarantee.

**Q: How does Django decide whether save() should INSERT or UPDATE?**
A: If the instance has no primary key value, it INSERTs. If it has one, Django tries an `UPDATE ... WHERE pk = %s`, and if no rows matched it falls back to an INSERT. Since 3.0, if the instance is still `_state.adding` and the pk field has a default (like a UUID), Django skips the UPDATE attempt and inserts directly. You can force behaviour with `force_insert=True` or `force_update=True`, and restrict columns with `update_fields`. After an insert on PostgreSQL the generated id comes back via `RETURNING` and is set on the instance.

**Q: What is the difference between default and db_default?**
A: `default` is applied in Python when the model instance is created without that value; it is not part of the database schema, so raw SQL inserts or other services do not get it. `db_default`, added in Django 5.0, sets a `DEFAULT` clause in the table definition and can be an expression such as `Now()`, so every writer gets it and the database computes it. If both are set, Python uses `default` for instances it creates. `db_default` is also useful for adding columns to large tables safely.

**Q: Are choices enforced by the database?**
A: No. `choices` drive validation in `full_clean()`/forms, the select widget, and `get_<field>_display()`, but the column is a plain `varchar` or `integer` with no constraint. Anything that bypasses validation — `update()`, `bulk_create`, raw SQL, a bug — can store an invalid value. If integrity matters, add a `CheckConstraint(condition=Q(status__in=[...]))`. Use `TextChoices`/`IntegerChoices` for readable enums.

**Q: What is DEFAULT_AUTO_FIELD and why did Django change it to BigAutoField?**
A: It is the field type Django uses for the implicit `id` primary key when a model does not declare one; it can be overridden per app via `AppConfig.default_auto_field`. A 32-bit `AutoField` overflows at around 2.1 billion rows, which high-volume tables do reach, and migrating a PK column on a huge table is painful. Since Django 3.2 new projects set `BigAutoField` (64-bit). Older projects that do not set it get warning `models.W042` and keep `AutoField` until they migrate.

**Q: When would you use a UUID primary key, and what are the costs?**
A: When ids must be unguessable in URLs, generated outside the database (offline clients, merging data from several systems), or not reveal volume. The costs are size (16 bytes, which also multiplies in every FK and index) and, for random UUIDv4, poor insert locality: new keys land all over the B-tree, causing more page splits and a less cache-friendly index. A common compromise is a `BigAutoField` primary key plus a unique `UUIDField` public id, or time-ordered UUIDs (v7). Remember `default=uuid.uuid4` without parentheses.

**Q: Why do auto_now fields sometimes not update?**
A: `auto_now` is implemented in the field's `pre_save()`, which runs only inside `Model.save()`. `QuerySet.update()`, `bulk_update()` and raw SQL never call it, so the timestamp stays stale. With `save(update_fields=[...])`, the field is only written if you include it in the list. If you need DB-level guarantees, use a trigger or set the value explicitly in updates (`update(status=..., updated_at=Now())`).

**Q: A colleague overrides save() to compute a slug, but slugs are missing for some rows. What happened? (Senior)**
A: Some code path is creating or updating rows without calling `Model.save()` — typically `bulk_create()`, `QuerySet.update()`, `bulk_update()`, `loaddata` fixtures (which call `save_base(raw=True)` and bypass your `save()`), or raw SQL from another service. Overridden `save()` methods and `pre_save`/`post_save` signals are skipped by all of these. Another possibility is `save(update_fields=[...])` from a caller that does not include `slug`, so the computed value is never written. Fixes: compute the slug in the creating code or a service function used everywhere, merge into `update_fields` inside the override, enforce non-empty with a `CheckConstraint` so violations fail loudly, and backfill with a data migration.

**Q: How would you enforce a business invariant like "discount cannot exceed subtotal" so that it holds no matter how data is written? (Senior)**
A: Express it in the database as `CheckConstraint(condition=Q(discount__lte=F("subtotal")), name=...)`, which PostgreSQL enforces for every writer including `update()` and raw SQL. Add it to `Model.clean()` or rely on `validate_constraints()` (4.1+) for a friendly message in forms and the admin. Call `full_clean()` in service functions and DRF serializers that create orders. Ship the constraint with a migration that first fixes existing violating rows (or adds it `NOT VALID` then validates, via a custom operation) so the migration does not fail on deploy. Tests should cover the constraint raising `IntegrityError` when bypassing validation.

**Q: Two Celery workers update different fields of the same order and one change disappears. Why, and how do you prevent it? (Senior)**
A: Each worker loaded the full row, changed one attribute and called `save()`, which issues an UPDATE of every column with the values from its in-memory copy. The later save writes back the stale value of the field the other worker changed — a lost update. Fix options: `save(update_fields=["field"])` so each worker only writes its column; atomic `QuerySet.update()` with `F()` for counters; `select_for_update()` inside `transaction.atomic()` when the change depends on current state; or optimistic locking with a `version` column checked in the UPDATE's WHERE clause. See the transactions chapter for the trade-offs.

**Q: What does the ModelBase metaclass do? (Senior)**
A: When the model class body executes at import time, `ModelBase.__new__` creates the `Options` object (`_meta`) from the inner `Meta`, then calls `contribute_to_class` on every field and manager so they register with `_meta` and install descriptors (for example `DeferredAttribute` for plain fields and relation descriptors for FKs). It adds an auto primary key if none was declared, a default `objects` manager if there are no managers, per-model `DoesNotExist`/`MultipleObjectsReturned` exceptions, handles abstract and proxy inheritance, and registers the model with the app registry. Everything else — forms, the admin, migrations, serializers — introspects `_meta`.

## 10. Quick Revision & Cheat Sheet

| Option | Layer | Note |
|---|---|---|
| `null=True` | DB | Column allows NULL; avoid on strings |
| `blank=True` | Validation | Empty accepted by forms/`full_clean` |
| `default=` | Python | Callable for mutables/timestamps; not in schema |
| `db_default=` | DB (5.0+) | `DEFAULT` in DDL; expressions like `Now()` |
| `choices=` | Validation/display | Not enforced by DB; `get_FOO_display()` |
| `unique=True` | DB + validation | Implies an index |
| `db_index=True` | DB | Single-column index |
| `editable=False` | Forms/admin | Hidden from ModelForms |
| `auto_now(_add)` | `save()` | Skipped by `update()`/bulk ops |
| `validators=` | Validation | Run by `full_clean()` only |

- `save()` never validates; `full_clean()` = fields → `clean()` → unique → constraints.
- `save()` = UPDATE-then-INSERT if pk set; `update_fields` narrows the UPDATE.
- `update()`, `bulk_create`, `bulk_update` skip `save()` and save signals.
- New projects: `BigAutoField`; old ones: fix W042.
- Money is `DecimalField`; datetimes are aware (`timezone.now`).
- `default=dict`, `default=timezone.now` — callables, no parentheses.
- Real invariants → `Meta.constraints`; friendly messages → `clean()`.
- 5.2: `CompositePrimaryKey`; 5.0: `db_default`, `GeneratedField`, enum `choices=`; 5.1: `CheckConstraint(condition=)`.

## 11. Hands-On Exercises

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2" "psycopg[binary]"
django-admin startproject modellab . && python manage.py startapp library
```

1. **Read the DDL.** Create the `Book` model from §5, run `makemigrations` and `sqlmigrate`, and annotate which options appear in SQL and which do not.
2. **Two empties.** Add `nickname = CharField(null=True, blank=True)`, create rows with `None` and `""`, and write the query that finds "all rows without a nickname". Then fix the model and write a data migration converting NULLs to `""`.
3. **save() vs full_clean().** Save a `Book` with an invalid `genre` and a negative price; observe what the DB accepts and what `full_clean()` reports. Add a `CheckConstraint` and repeat with `update()`.
4. **Lost update.** In two shells load the same order, change different fields, save both; observe the overwrite. Repeat with `update_fields`.
5. **INSERT vs UPDATE.** Log SQL while saving a model with a `UUIDField(primary_key=True, default=uuid4)` and one with a `BigAutoField`; confirm the UUID model skips the UPDATE attempt.
6. **Custom field.** Implement `CentsField`, store `Decimal("19.99")`, and verify the raw column value with `connection.cursor()`.

**Mini project — "Invoice model":** model `Invoice` and `InvoiceLine` with public UUID ids, `TextChoices` status with a matching `CheckConstraint`, `db_default=Now()` issue date, `DecimalField` amounts with non-negative constraints, a `clean()` rule that due date ≥ issue date (plus a constraint), a `mark_paid()` method using `update_fields`, and tests proving each invariant holds both through `full_clean()` and through raw `update()`.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation) · [Ch 09 · Relationships](topic.html?p=09-relationships) · [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) · [Ch 11 · Migrations](topic.html?p=11-migrations) · [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) · [Ch 15 · Custom Managers, QuerySets & Model Inheritance](topic.html?p=15-managers-model-inheritance) · [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres) · [Ch 19 · Signals](topic.html?p=19-signals) · [Ch 36 · Django Internals](topic.html?p=36-django-internals)

**Other handbooks:** [SQL · Data Types](../sql/topic.html?p=04-data-types) · [SQL · Keys & Constraints](../sql/topic.html?p=29-keys-constraints) · [SQL · Normalization](../sql/topic.html?p=28-normalization) · [Database Design · Schema Evolution](../database-design/topic.html?p=27-schema-evolution)

- **Models** — Django docs · *Beginner* · the topic guide to defining models, fields and Meta. <https://docs.djangoproject.com/en/5.2/topics/db/models/>
- **Model field reference** — Django docs · *Intermediate* · every field type and option, including `null`, `blank`, `db_default`. <https://docs.djangoproject.com/en/5.2/ref/models/fields/>
- **Model instance reference** — Django docs · *Intermediate* · `save()`, `full_clean()`, `refresh_from_db()` and how saving works. <https://docs.djangoproject.com/en/5.2/ref/models/instances/>
- **Model Meta options** — Django docs · *Intermediate* · `ordering`, `indexes`, `constraints`, `managed`. <https://docs.djangoproject.com/en/5.2/ref/models/options/>
- **Constraints reference** — Django docs · *Intermediate* · `CheckConstraint` and `UniqueConstraint` with conditions and expressions. <https://docs.djangoproject.com/en/5.2/ref/models/constraints/>
- **Writing custom model fields** — Django docs · *Advanced* · the conversion hooks behind every field. <https://docs.djangoproject.com/en/5.2/howto/custom-model-fields/>
- **Django 5.2 release notes** — Django docs · *Intermediate* · composite primary keys and other model changes in the current LTS. <https://docs.djangoproject.com/en/5.2/releases/5.2/>

---

*Django Handbook — chapter 08.*
