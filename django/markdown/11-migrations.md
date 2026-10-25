# 11 · Migrations

> **In one line:** Migrations are version control for your schema: `makemigrations` diffs your models against the *recorded migration state* (never the live database) and writes Python operations, `migrate` replays the unapplied ones in dependency order, and running them safely in production means designing every change so the old code and the new code can both run against the schema at the same time.

---

## 1. Overview

> **Builds on:** [Ch 08 · Models & Fields](topic.html?p=08-models-fields) · [Ch 09 · Relationships](topic.html?p=09-relationships)

Your models describe what the database *should* look like. The database on your laptop, on CI, on staging and on the three production shards each describe what the database *does* look like. Something has to move every one of those databases from its current shape to the desired shape, in the same order, with the same result, and without you hand-writing `ALTER TABLE` statements and emailing them to whoever has prod access. That something is the **migration framework** in `django.db.migrations`.

The naive approach is to edit the database by hand, or to run a "sync" tool that inspects the live database and makes it match the models (Django's ancient `syncdb` did a weak version of this). Both fail for the same reasons. A hand edit is not reproducible: a new developer, a fresh CI database and a disaster-recovery restore all end up with different schemas. A "sync" tool cannot know your *intent*: if you rename `full_name` to `name`, a diff of before/after sees "column dropped, column added" and destroys the data. And neither approach handles *data* changes — splitting a name into first/last, backfilling a new column — which are half of real schema evolution.

Django's answer is a sequence of small, committed Python files per app, each listing **operations** (`CreateModel`, `AddField`, `AlterField`, `RunPython`…) and the **dependencies** it needs applied first. Together they form a **directed acyclic graph**. Applied migrations are recorded in the `django_migrations` table, so each database knows exactly where it is in the graph.

The production half of this chapter matters more for senior interviews: a migration that is correct can still take your site down. `AddField(null=False)` on a 200-million-row table, `CREATE INDEX` without `CONCURRENTLY`, a rename that the still-running old pods do not understand — each of these is a correct migration that causes an outage. Zero-downtime migration is a discipline (expand → migrate → contract), not a flag.

> **Why this matters:** Every Django interview past junior level asks some version of "how do you add a non-nullable column to a big table without downtime?" and "what happens if two developers create migration 0007 on different branches?". Both answers fall out of understanding the graph and the lock behaviour.

## 2. Core Concepts

- **Migration file** — a module in `<app>/migrations/` defining `class Migration(migrations.Migration)` with `dependencies` and `operations`. *Why it matters:* it is committed code, reviewed like code, and is the only source of schema truth across environments.
- **Operation** — a unit of change (`CreateModel`, `AddField`, `RemoveField`, `AlterField`, `RenameField`, `AddIndex`, `AddConstraint`, `RunPython`, `RunSQL`, `SeparateDatabaseAndState`). *Why:* each operation knows how to change both the in-memory *state* and the real *database*, forwards and (usually) backwards.
- **Migration state (`ProjectState`)** — the in-memory reconstruction of every model as it looked after a given set of migrations, built by replaying operations. *Why:* the autodetector compares your models to *this*, not to the DB, so a hand-edited database is invisible to `makemigrations`.
- **Autodetector (`MigrationAutodetector`)** — the class that diffs the current models' state against the latest migration state and generates operations. *Why:* it asks interactive questions ("did you rename this field?") precisely because a diff cannot infer intent.
- **Dependencies** — `[("app", "0006_previous")]` edges in the graph, including cross-app edges (e.g. to `settings.AUTH_USER_MODEL` via `migrations.swappable_dependency`). *Why:* `migrate` performs a topological sort; a missing edge produces "relation does not exist" on fresh databases.
- **Leaf node** — a migration nothing depends on yet. *Why:* two leaves in one app = a conflict; `migrate` refuses until you merge.
- **`django_migrations` table** — rows of `(app, name, applied)`. *Why:* the recorder; `--fake` writes a row without running SQL.
- **Data migration** — a migration whose operation is `RunPython` (or `RunSQL`) that transforms rows. *Why:* schema and data change together, in order, everywhere.
- **Historical models** — models obtained via `apps.get_model("app", "Model")` inside `RunPython`, rebuilt from the migration state at that point. *Why:* importing the real model gives you *today's* fields, which may not exist yet in an older migration's world.
- **Reversibility** — whether an operation has a backwards implementation. *Why:* `migrate app 0005` (rollback) fails with `IrreversibleError` on `RunPython` without a `reverse_code`.
- **Atomic migrations** — on databases with transactional DDL (PostgreSQL, SQLite) each migration runs inside a transaction by default. *Why:* a half-applied migration rolls back cleanly — but long transactions hold locks, and some DDL (`CREATE INDEX CONCURRENTLY`) cannot run inside one.
- **Squashing** — collapsing a run of migrations into one with `replaces = [...]`. *Why:* faster test DB creation and fewer files, without breaking databases that applied the originals.
- **Expand / contract** — the zero-downtime pattern: add compatible schema first, migrate code and data, remove old schema last. *Why:* during a rolling deploy two code versions run against one schema.

## 3. Theory & Principles

### 3.1 State vs database: the two halves of every operation

Every operation implements four methods: `state_forwards(app_label, state)`, `database_forwards(app_label, schema_editor, from_state, to_state)`, `database_backwards(...)` and `describe()`. The executor (`MigrationExecutor`) walks the plan; for each migration it calls `Migration.apply()`, which for each operation first mutates a copy of the `ProjectState` and then asks the operation to emit SQL through the backend's **schema editor** (`connection.schema_editor()`, e.g. `DatabaseSchemaEditor` for PostgreSQL). The schema editor turns "add field X to model Y" into vendor SQL, defers foreign-key and index creation to the end of the migration where needed, and — when `collect_sql=True` — just records the SQL instead of executing it (that is how `sqlmigrate` works).

Keeping state and database separate is what makes `SeparateDatabaseAndState` possible: you can tell Django "the state changed, but don't touch the DB" (e.g. after you already did it by hand, or when moving a model between apps while keeping the table).

### 3.2 How `makemigrations` decides what to write

1. `MigrationLoader` reads every migration file of every installed app and builds a `MigrationGraph` (nodes + dependency edges). It also reads `django_migrations` if a database is available, but `makemigrations` does not need the DB to diff.
2. The loader replays the graph's leaf states into a `ProjectState` — "what the models looked like after all migrations".
3. `ProjectState.from_apps(apps)` builds the state of your *current* model code.
4. `MigrationAutodetector(from_state, to_state, questioner).changes(graph)` compares them: created/deleted models, added/removed/altered fields, renamed fields (detected by matching field deconstruction and asking), index/constraint changes, `Meta` option changes.
5. It orders operations so they are valid (create model before FK to it), splits across files when cross-app cycles require, names them (`0007_order_status_alter_order_total`) and writes them with `MigrationWriter`.

Because every field implements `deconstruct()` (returning path, args, kwargs), a change to *any* kwarg — even `help_text`, `verbose_name` or `choices` — produces an `AlterField`. Those are no-op SQL on PostgreSQL but they are still state changes; this is why "makemigrations generates a migration when I changed only choices" is expected behaviour.

### 3.3 How `migrate` decides what to run

`migrate` loads the graph, reads applied rows from `django_migrations`, computes the **plan** (`executor.migration_plan(targets)`) as a topological ordering of unapplied nodes up to the targets (all app leaves by default), checks consistency (`InconsistentMigrationHistory` if an applied migration has an unapplied dependency), then applies each, writing a row after success. Before and after it emits `pre_migrate` / `post_migrate` signals — `post_migrate` is what creates content types and default permissions.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj11a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj11b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="dj11c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The migration graph: dependencies, a cross-app edge, and a conflict</text>
  <text x="30" y="58" fill="#334155" font-size="12" font-weight="bold">accounts</text>
  <rect x="110" y="40" width="130" height="30" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="175" y="60" text-anchor="middle" fill="#1e293b">0001_initial (User)</text>
  <rect x="290" y="40" width="130" height="30" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="355" y="60" text-anchor="middle" fill="#1e293b">0002_user_phone</text>
  <path d="M290,55 L244,55" stroke="#2563eb" stroke-width="2" marker-end="url(#dj11a)"/>
  <text x="30" y="148" fill="#334155" font-size="12" font-weight="bold">orders</text>
  <rect x="110" y="130" width="130" height="30" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="175" y="150" text-anchor="middle" fill="#1e293b">0001_initial</text>
  <rect x="290" y="130" width="130" height="30" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="355" y="150" text-anchor="middle" fill="#1e293b">0002_order_user</text>
  <rect x="470" y="130" width="130" height="30" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="535" y="150" text-anchor="middle" fill="#1e293b">0003_order_status</text>
  <path d="M290,145 L244,145" stroke="#2563eb" stroke-width="2" marker-end="url(#dj11a)"/>
  <path d="M470,145 L424,145" stroke="#2563eb" stroke-width="2" marker-end="url(#dj11a)"/>
  <path d="M330,130 L200,72" stroke="#7c3aed" stroke-width="2" stroke-dasharray="5,3" marker-end="url(#dj11a)"/>
  <text x="300" y="104" fill="#7c3aed" font-size="10">cross-app edge (FK to User)</text>
  <rect x="660" y="95" width="160" height="30" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="740" y="115" text-anchor="middle" fill="#7f1d1d">0004_order_coupon (branch A)</text>
  <rect x="660" y="165" width="160" height="30" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="740" y="185" text-anchor="middle" fill="#7f1d1d">0004_order_notes (branch B)</text>
  <path d="M660,110 L604,140" stroke="#dc2626" stroke-width="2" marker-end="url(#dj11b)"/>
  <path d="M660,180 L604,152" stroke="#dc2626" stroke-width="2" marker-end="url(#dj11b)"/>
  <text x="740" y="150" text-anchor="middle" fill="#dc2626" font-size="10" font-weight="bold">two leaves = conflict</text>
  <rect x="660" y="240" width="160" height="30" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="740" y="260" text-anchor="middle" fill="#14532d">0005_merge (makemigrations --merge)</text>
  <path d="M720,240 L720,199" stroke="#16a34a" stroke-width="2" marker-end="url(#dj11c)"/>
  <path d="M790,240 C850,200 850,140 824,118" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#dj11c)"/>
  <rect x="40" y="300" width="800" height="80" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="60" y="322" fill="#78350f" font-size="11" font-weight="bold">migrate: plan = topological order of unapplied nodes</text>
  <text x="60" y="342" fill="#78350f" font-size="10">accounts.0001 &#8594; orders.0001 &#8594; orders.0002 (needs accounts.0001) &#8594; accounts.0002 &#8594; orders.0003 &#8594; 0004 A &#8594; 0004 B &#8594; 0005_merge</text>
  <text x="60" y="362" fill="#78350f" font-size="10">Arrows point to the dependency. Each applied node becomes a row in django_migrations(app, name, applied).</text>
</svg>
```

### 3.4 Why migrations are atomic on PostgreSQL — and when that hurts

PostgreSQL supports transactional DDL, so `Migration.atomic = True` (the default) wraps each migration in `BEGIN … COMMIT`. If operation three fails, operations one and two are rolled back too. The cost: every lock taken by every operation is held until the end of the migration. An `ALTER TABLE` takes an `ACCESS EXCLUSIVE` lock; if your migration then runs a `RunPython` that backfills ten million rows, *every query on that table* queues behind the lock until the backfill finishes. That is the single most common migration outage.

Worse, `ACCESS EXCLUSIVE` must *wait* for existing locks: if a long-running analytics query holds `ACCESS SHARE` on the table, your `ALTER` queues, and every new query queues behind your `ALTER`. A trivial "add nullable column" can freeze the table for as long as that report runs. Production fix: `SET lock_timeout = '5s'` before DDL and retry (see §8). The deeper locking story is in [SQL · Locking & MVCC](../sql/topic.html?p=27-locking-mvcc) and [Database Design · Locking Internals](../database-design/topic.html?p=05-locking-internals).

### 3.5 Historical models and why `RunPython` must use `apps.get_model`

Inside a `RunPython(forwards, backwards)` function Django passes `apps` — a registry built from the migration state *at that point in the graph*. `apps.get_model("orders", "Order")` gives a class with exactly the fields that existed then, with no custom methods and only managers marked `use_in_migrations = True`. If you `from orders.models import Order` instead, the migration works today, but a year from now — when `Order` has a field that a later migration adds — running migrations on a fresh database will crash because your import references a column that doesn't exist yet. Historical models also don't fire your overridden `save()` logic, so put needed logic inline in the migration.

## 4. Architecture & Workflow

### 4.1 The components

```text
manage.py makemigrations                   manage.py migrate
        |                                         |
  MigrationLoader --- reads */migrations/*.py --- MigrationLoader
        |                                         |   + MigrationRecorder (django_migrations)
  MigrationGraph  (nodes + dependencies)    MigrationExecutor.migration_plan()
        |                                         |
  ProjectState(graph leaves)  vs                for each Migration:
  ProjectState.from_apps(current models)         op.state_forwards()  -> new ProjectState
        |                                         op.database_forwards(schema_editor)
  MigrationAutodetector.changes()                  -> SQL via DatabaseSchemaEditor
        |                                         recorder.record_applied()
  MigrationWriter -> 0007_xxx.py               post_migrate signal (contenttypes, perms)
```

### 4.2 Zero-downtime: the expand/contract workflow

In a rolling deploy, old pods (version N) and new pods (N+1) serve traffic simultaneously against one database. Therefore the schema at every moment must be compatible with **both** versions. Any change that breaks old code — dropping a column it selects, renaming one, adding a NOT NULL column without a DB default that old code's INSERTs don't supply — must be split across multiple deploys.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj11d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Renaming customer.fullname to customer.name with zero downtime</text>
  <path d="M30,60 L850,60" stroke="#334155" stroke-width="2" marker-end="url(#dj11d)"/>
  <text x="840" y="52" text-anchor="end" fill="#334155" font-size="10">time / deploys</text>
  <rect x="30" y="80" width="190" height="150" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="125" y="100" text-anchor="middle" fill="#1e3a8a" font-size="12" font-weight="bold">Deploy 1: EXPAND</text>
  <text x="42" y="122" fill="#1e293b" font-size="10">migration: AddField name (null=True)</text>
  <text x="42" y="140" fill="#1e293b" font-size="10">code: write BOTH fullname + name</text>
  <text x="42" y="158" fill="#1e293b" font-size="10">read: fullname</text>
  <text x="42" y="182" fill="#16a34a" font-size="10">old pods: ignore name &#8594; safe</text>
  <text x="42" y="200" fill="#16a34a" font-size="10">nullable add = metadata only</text>
  <rect x="240" y="80" width="190" height="150" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="335" y="100" text-anchor="middle" fill="#78350f" font-size="12" font-weight="bold">Deploy 2: BACKFILL</text>
  <text x="252" y="122" fill="#1e293b" font-size="10">batched job (not one txn):</text>
  <text x="252" y="140" fill="#1e293b" font-size="10">UPDATE ... SET name=fullname</text>
  <text x="252" y="158" fill="#1e293b" font-size="10">WHERE id BETWEEN a AND b</text>
  <text x="252" y="182" fill="#d97706" font-size="10">atomic=False, sleep between</text>
  <text x="252" y="200" fill="#d97706" font-size="10">batches to spare replicas</text>
  <rect x="450" y="80" width="190" height="150" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="545" y="100" text-anchor="middle" fill="#4c1d95" font-size="12" font-weight="bold">Deploy 3: SWITCH</text>
  <text x="462" y="122" fill="#1e293b" font-size="10">code: read name, write both</text>
  <text x="462" y="140" fill="#1e293b" font-size="10">migration: name NOT NULL</text>
  <text x="462" y="158" fill="#1e293b" font-size="10">(CHECK NOT VALID, VALIDATE,</text>
  <text x="462" y="176" fill="#1e293b" font-size="10">then SET NOT NULL)</text>
  <text x="462" y="200" fill="#16a34a" font-size="10">old pods still write fullname</text>
  <rect x="660" y="80" width="190" height="150" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="755" y="100" text-anchor="middle" fill="#14532d" font-size="12" font-weight="bold">Deploy 4+5: CONTRACT</text>
  <text x="672" y="122" fill="#1e293b" font-size="10">4: stop using fullname in code</text>
  <text x="672" y="140" fill="#1e293b" font-size="10">   (SeparateDatabaseAndState</text>
  <text x="672" y="158" fill="#1e293b" font-size="10">    removes it from state only)</text>
  <text x="672" y="176" fill="#1e293b" font-size="10">5: RemoveField / DROP COLUMN</text>
  <text x="672" y="200" fill="#16a34a" font-size="10">no running pod references it</text>
  <rect x="30" y="260" width="820" height="140" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="440" y="282" text-anchor="middle" fill="#7f1d1d" font-size="12" font-weight="bold">The one-step version (RenameField) during a rolling deploy</text>
  <text x="50" y="306" fill="#7f1d1d" font-size="10">t0: migrate runs ALTER TABLE customer RENAME COLUMN fullname TO name (fast, but instant break)</text>
  <text x="50" y="326" fill="#7f1d1d" font-size="10">t0..t1: old pods still running SELECT ... "customer"."fullname" &#8594; ProgrammingError: column does not exist</text>
  <text x="50" y="346" fill="#7f1d1d" font-size="10">If migrate runs AFTER new pods start, the new pods fail instead. There is no ordering that is safe.</text>
  <text x="50" y="370" fill="#7f1d1d" font-size="10">Rule: a single deploy may only make schema changes that the PREVIOUS code version tolerates.</text>
  <text x="50" y="388" fill="#7f1d1d" font-size="10">Additive first (expand), destructive last (contract), each in its own release.</text>
</svg>
```

### 4.3 Where migrations run in the pipeline

Run `migrate` **once per release**, as a dedicated step (a Kubernetes Job, a Heroku release phase, a CI deploy stage) *before* new application pods roll out — never in every container's entrypoint. Ten pods booting simultaneously all running `migrate` race to apply the same migration; PostgreSQL's DDL locks usually serialize them into errors (`relation already exists`, `duplicate key in django_migrations`). The brief rule from [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production): migrations are a release step, gated by `migrate --check` in CI.

## 5. Implementation

### 5.1 Simple example: the everyday loop

```python
# shop/models.py
from django.db import models

class Product(models.Model):
    name = models.CharField(max_length=200)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    created_at = models.DateTimeField(auto_now_add=True)
```

```bash
python manage.py makemigrations shop          # writes shop/migrations/0001_initial.py
python manage.py sqlmigrate shop 0001         # print the SQL, run nothing
python manage.py migrate                      # apply everything unapplied
python manage.py showmigrations shop          # [X] applied, [ ] pending
python manage.py makemigrations --check --dry-run   # CI: fail if models drifted
python manage.py migrate --check              # CI/deploy: exit non-zero if unapplied (3.1+)
```

The generated file is ordinary Python:

```python
# shop/migrations/0001_initial.py
from django.db import migrations, models

class Migration(migrations.Migration):
    initial = True
    dependencies = []
    operations = [
        migrations.CreateModel(
            name="Product",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=200)),
                ("price", models.DecimalField(decimal_places=2, max_digits=10)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
            ],
        ),
    ]
```

And `sqlmigrate` shows what PostgreSQL will receive:

```sql
BEGIN;
--
-- Create model Product
--
CREATE TABLE "shop_product" (
    "id" bigint NOT NULL PRIMARY KEY GENERATED BY DEFAULT AS IDENTITY,
    "name" varchar(200) NOT NULL,
    "price" numeric(10, 2) NOT NULL,
    "created_at" timestamp with time zone NOT NULL
);
COMMIT;
```

> **Version note:** Since Django 4.1, PostgreSQL auto fields use `GENERATED BY DEFAULT AS IDENTITY` instead of `serial`. Existing `serial` columns are not converted automatically.

Now add a field with a default:

```python
    stock = models.PositiveIntegerField(default=0)
```

```sql
-- sqlmigrate shop 0002 (Django 5.x)
BEGIN;
ALTER TABLE "shop_product" ADD COLUMN "stock" integer DEFAULT 0 NOT NULL CHECK ("stock" >= 0);
ALTER TABLE "shop_product" ALTER COLUMN "stock" DROP DEFAULT;
COMMIT;
```

Notice the second statement: a Python-side `default=` is applied to existing rows during the migration, then **dropped** from the database. The DB has no default afterwards, so an INSERT from code that doesn't know the column (old pods, raw SQL, another service) fails with a NOT NULL violation. Django 5.0's `db_default` fixes that:

```python
from django.db.models.functions import Now

class Product(models.Model):
    ...
    stock = models.PositiveIntegerField(db_default=0)
    updated_at = models.DateTimeField(db_default=Now())
```

```sql
ALTER TABLE "shop_product" ADD COLUMN "stock" integer DEFAULT 0 NOT NULL CHECK ("stock" >= 0);
-- no DROP DEFAULT: the default lives in the database permanently
```

On PostgreSQL 11+ adding a column with a constant default is a metadata-only change (no table rewrite), so this is fast even on large tables — the default is stored in the catalog and returned for old rows.

### 5.2 Data migration with `RunPython`

```bash
python manage.py makemigrations shop --empty --name backfill_slugs
```

```python
# shop/migrations/0004_backfill_slugs.py
from django.db import migrations
from django.utils.text import slugify

def forwards(apps, schema_editor):
    Product = apps.get_model("shop", "Product")          # historical model
    db = schema_editor.connection.alias                    # respect --database
    batch = []
    for p in Product.objects.using(db).filter(slug="").only("id", "name").iterator(chunk_size=2000):
        p.slug = slugify(p.name)[:50] or f"product-{p.pk}"
        batch.append(p)
        if len(batch) >= 2000:
            Product.objects.using(db).bulk_update(batch, ["slug"])
            batch.clear()
    if batch:
        Product.objects.using(db).bulk_update(batch, ["slug"])

def backwards(apps, schema_editor):
    pass  # slugs are derived data; leaving them is harmless

class Migration(migrations.Migration):
    dependencies = [("shop", "0003_product_slug")]
    operations = [
        migrations.RunPython(forwards, backwards, elidable=True),
    ]
```

Key points: `apps.get_model`, `using(db)`, `iterator()` to avoid loading every row, `bulk_update` to avoid one UPDATE per row (see [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization)), a reverse function (even a no-op — `migrations.RunPython.noop` exists for exactly this), and `elidable=True` so `squashmigrations` can drop it.

### 5.3 Real-world example: adding a NOT NULL foreign key to a 50M-row table

Requirement: every `Order` must reference a `Store`. `orders_order` has 50 million rows and is written hundreds of times per second. The one-step `AddField(ForeignKey(Store, on_delete=PROTECT))` with a default would: add the column, take `ACCESS EXCLUSIVE`, add an FK constraint that **validates every row while holding a lock**, and create an index — all in one transaction. Here is the safe sequence.

**Release 1 — expand (nullable column, no constraint validation yet):**

```python
# orders/migrations/0031_order_store.py
from django.db import migrations, models
import django.db.models.deletion

class Migration(migrations.Migration):
    dependencies = [("orders", "0030_previous"), ("stores", "0004_store")]
    operations = [
        migrations.AddField(
            model_name="order",
            name="store",
            field=models.ForeignKey(
                null=True, db_index=False, db_constraint=False,
                on_delete=django.db.models.deletion.PROTECT, to="stores.store",
            ),
        ),
    ]
```

```sql
ALTER TABLE "orders_order" ADD COLUMN "store_id" bigint NULL;   -- metadata only, milliseconds
```

**Release 1b — the index, concurrently, in a non-atomic migration:**

```python
# orders/migrations/0032_order_store_idx.py
from django.contrib.postgres.operations import AddIndexConcurrently
from django.db import migrations, models

class Migration(migrations.Migration):
    atomic = False                                   # CONCURRENTLY cannot run in a transaction
    dependencies = [("orders", "0031_order_store")]
    operations = [
        AddIndexConcurrently(
            "order", models.Index(fields=["store"], name="order_store_idx"),
        ),
    ]
```

The model must carry `Meta.indexes = [models.Index(fields=["store"], name="order_store_idx")]` so state and code agree. If a concurrent build fails it leaves an `INVALID` index behind — drop it and retry.

**Release 2 — application code sets `store` on new orders; a backfill fills old rows in batches** (a management command or Celery task, not a migration, because it must be resumable and throttled):

```python
# orders/management/commands/backfill_order_store.py
from django.core.management.base import BaseCommand
from django.db import connection, transaction
import time

class Command(BaseCommand):
    def handle(self, *args, **opts):
        batch = 10_000
        with connection.cursor() as c:
            c.execute("SELECT min(id), max(id) FROM orders_order")
            lo, hi = c.fetchone()
        for start in range(lo, hi + 1, batch):
            with transaction.atomic():
                with connection.cursor() as c:
                    c.execute(
                        """UPDATE orders_order o SET store_id = b.store_id
                           FROM orders_branch b
                           WHERE o.branch_id = b.id AND o.store_id IS NULL
                             AND o.id >= %s AND o.id < %s""",
                        [start, start + batch],
                    )
            time.sleep(0.05)   # let replicas and autovacuum keep up
```

**Release 3 — add the FK constraint `NOT VALID`, validate separately, then enforce NOT NULL via a validated CHECK** (PostgreSQL 12+ uses a valid CHECK to skip the full-table scan in `SET NOT NULL`):

```python
# orders/migrations/0033_order_store_constraints.py
from django.db import migrations, models
import django.db.models.deletion

class Migration(migrations.Migration):
    atomic = False
    dependencies = [("orders", "0032_order_store_idx")]
    operations = [
        migrations.SeparateDatabaseAndState(
            database_operations=[
                migrations.RunSQL(
                    "ALTER TABLE orders_order ADD CONSTRAINT order_store_fk "
                    "FOREIGN KEY (store_id) REFERENCES stores_store(id) "
                    "DEFERRABLE INITIALLY DEFERRED NOT VALID",
                    reverse_sql="ALTER TABLE orders_order DROP CONSTRAINT order_store_fk",
                ),
                migrations.RunSQL(
                    "ALTER TABLE orders_order VALIDATE CONSTRAINT order_store_fk",
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    "ALTER TABLE orders_order ADD CONSTRAINT order_store_nn "
                    "CHECK (store_id IS NOT NULL) NOT VALID",
                    reverse_sql="ALTER TABLE orders_order DROP CONSTRAINT order_store_nn",
                ),
                migrations.RunSQL(
                    "ALTER TABLE orders_order VALIDATE CONSTRAINT order_store_nn",
                    reverse_sql=migrations.RunSQL.noop,
                ),
                migrations.RunSQL(
                    "ALTER TABLE orders_order ALTER COLUMN store_id SET NOT NULL",
                    reverse_sql="ALTER TABLE orders_order ALTER COLUMN store_id DROP NOT NULL",
                ),
                migrations.RunSQL(
                    "ALTER TABLE orders_order DROP CONSTRAINT order_store_nn",
                    reverse_sql=migrations.RunSQL.noop,
                ),
            ],
            state_operations=[
                migrations.AlterField(
                    model_name="order",
                    name="store",
                    field=models.ForeignKey(
                        db_index=False, on_delete=django.db.models.deletion.PROTECT, to="stores.store",
                    ),
                ),
            ],
        ),
    ]
```

`VALIDATE CONSTRAINT` scans the table but takes only a `SHARE UPDATE EXCLUSIVE` lock, so reads and writes continue. `SeparateDatabaseAndState` tells the autodetector "the field is now non-null with a constraint" without letting Django emit its own (locking) SQL. Running `makemigrations --check` afterwards must report "No changes detected" — that is your proof state and models agree.

### 5.4 Conflicts, squashing, faking, rollback

```bash
# Two branches both created 0004 -> migrate says "Conflicting migrations detected"
python manage.py makemigrations --merge            # writes 0005_merge_... depending on both leaves

# Roll back to a point (runs backwards operations)
python manage.py migrate orders 0030
python manage.py migrate orders zero               # unapply everything in the app

# Tables already exist (legacy DB, or you applied SQL by hand)
python manage.py migrate --fake-initial            # mark 0001 applied if its tables exist
python manage.py migrate orders 0033 --fake        # record as applied, run no SQL

# Collapse 0001..0040 into one
python manage.py squashmigrations orders 0040
```

The squashed file carries `replaces = [("orders", "0001_initial"), …, ("orders", "0040_x")]`. Databases that applied the originals treat it as applied; fresh databases run only the squash. Once **every** environment has migrated past the squash, delete the originals, remove `replaces`, and update any migrations elsewhere that depended on the old names.

```text
$ python manage.py showmigrations orders
orders
 [X] 0001_squashed_0040_cleanup (40 squashed migrations)
 [X] 0041_order_refund_reason
 [ ] 0042_order_store
```

## 6. Advantages, Disadvantages & Trade-offs

| Approach | Safe under rolling deploy? | Lock risk | Effort | Use for |
|---|---|---|---|---|
| Autogenerated migration, one release | Only if purely additive and nullable / `db_default` | Low–high (depends on op) | Lowest | Small tables, new models, nullable fields |
| Expand → backfill → contract over several releases | Yes | Low | High (3–5 PRs) | Renames, NOT NULL on big tables, type changes |
| `AddIndexConcurrently` / `RemoveIndexConcurrently` (`atomic=False`) | Yes | Low (no write block) | Low | Any index on a live table |
| `RunSQL` + `SeparateDatabaseAndState` | Yes, if SQL is chosen carefully | You control it | Medium–high | `NOT VALID` constraints, custom DDL |
| `RunPython` in the migration | Risky on large data (one transaction) | High if `atomic` | Low | Small/medium backfills, seed data |
| Out-of-band batched backfill command | Yes | Lowest | Medium | Large backfills |
| Squashing | n/a | n/a | Medium (coordination) | Long histories slowing tests |

### When to use

- Autogenerated migrations for every model change — never hand-edit the DB.
- `db_default` (5.0+) whenever a new NOT NULL column must be written by code that doesn't know about it.
- Non-atomic migrations for `CONCURRENTLY` operations and for batched `RunPython` that commits per batch.
- `SeparateDatabaseAndState` when the DB already matches (hand-run DDL, moving models between apps, removing a field from state before dropping the column).

### When NOT to use

- Don't put a long backfill inside an atomic migration on a hot table.
- Don't use `RenameField`/`RenameModel`/`RemoveField` in a single release on a table served by a rolling deploy.
- Don't use `--fake` to "make an error go away" — you are desynchronizing state and reality.
- Don't squash while some environment (a customer's on-prem install, a long-lived staging DB) is still in the middle of the replaced range unless you keep `replaces` around.

## 7. Common Mistakes & Best Practices

**1. Importing real models in a data migration.** People write `from shop.models import Product` because it works today. It breaks a fresh database months later when the model gains a column. Always use `apps.get_model`.

```python
# Before (time bomb)
from shop.models import Product
def forwards(apps, schema_editor):
    Product.objects.update(active=True)

# After
def forwards(apps, schema_editor):
    Product = apps.get_model("shop", "Product")
    Product.objects.update(active=True)
```

**2. Not committing migration files, or generating them on the server.** If prod runs `makemigrations`, every server can produce different files. Generate locally, review, commit; CI runs `makemigrations --check --dry-run`.

**3. Editing an applied migration.** Changing `0005` after it ran in prod does nothing there (the row says applied) but changes fresh databases — environments diverge silently. Write a new migration instead. The exception is a migration not yet merged to main.

**4. Deleting migrations to "reset" a shared project.** Fine on a throwaway branch; catastrophic on a deployed app — the `django_migrations` rows reference names that no longer exist, and dependencies from other apps break.

**5. Missing reverse code.** `RunPython(forwards)` alone makes the app irreversible past that point. Add `reverse_code=migrations.RunPython.noop` when undoing is harmless, or a real reverse when it isn't.

**6. Forgetting `using(schema_editor.connection.alias)` in multi-DB setups.** The migration writes to `default` even when `migrate --database=analytics` was requested.

**7. Swappable user model added late.** `AUTH_USER_MODEL` must be set before the first `migrate`, because `admin`, `auth` and every FK to the user depend on it (`migrations.swappable_dependency(settings.AUTH_USER_MODEL)`). Changing it later means hand-surgery on migration history. See [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user).

**8. Choices/help_text churn.** Every `choices` change generates `AlterField`. That's not a bug; it's state. Keep choices in a `TextChoices` class and accept the migrations (they cost no SQL on PostgreSQL).

**Best practices:**
- One logical change per migration; name them (`--name add_order_store`).
- Always read `sqlmigrate` output for migrations on large tables during review.
- Add a CI check that flags dangerous operations (tools such as `django-migration-linter` or `django-pg-zero-downtime-migrations`, both on GitHub).
- Keep data migrations idempotent so a retry after partial failure is safe.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: lock queue behind a long query.** *In production* a deploy runs `AddField(null=True)` — supposedly instant. *Symptom:* every request touching `orders_order` hangs for minutes; connection pool exhausts; 502s. *Root cause:* `ALTER TABLE` waited for `ACCESS EXCLUSIVE` behind a 10-minute report holding `ACCESS SHARE`; all new queries queued behind the ALTER. *Fix:* set a lock timeout for migration sessions and retry:

```python
# A first operation in risky migrations (or a custom migrate wrapper)
migrations.RunSQL("SET lock_timeout = '5s'", reverse_sql=migrations.RunSQL.noop)
```

…or set it for the migration role: `ALTER ROLE deployer SET lock_timeout = '5s';` Also set `statement_timeout` for the app role so reports can't hold locks forever.

**Pitfall: index build blocking writes.** `AddIndex` emits `CREATE INDEX`, which blocks INSERT/UPDATE/DELETE for the whole build. *Fix:* `AddIndexConcurrently` with `atomic = False`. Detail on index design in [SQL · Index Design](../sql/topic.html?p=20-index-design).

**Pitfall: type change rewrites the table.** `AlterField` from `IntegerField` to `BigIntegerField` → `ALTER COLUMN TYPE bigint` rewrites every row under `ACCESS EXCLUSIVE`. On a huge table that is hours. *Fix:* new column, dual-write trigger or app code, batched backfill, swap. Plan for int→bigint *before* you exhaust 2^31 IDs — the reason `DEFAULT_AUTO_FIELD` is `BigAutoField`.

**Pitfall: parallel `migrate` on container start.** Two pods apply 0042 simultaneously → one errors and crash-loops. *Fix:* migrate as a single release job; app pods only start after it succeeds.

**Pitfall: old code vs new schema.** Removing a field in the same release that stops using it → old pods `SELECT` the dropped column during rollout. *Fix:* contract in a later release; Django lists every concrete field in SELECTs, so even "unused" columns are referenced. A clean trick is `SeparateDatabaseAndState` with `state_operations=[RemoveField(...)]` in release N (code no longer selects it), `RunSQL("ALTER TABLE ... DROP COLUMN ...")` in N+1.

**Pitfall: replication lag from a big backfill.** A single `UPDATE` of 30M rows generates massive WAL; replicas fall minutes behind and read-your-writes breaks (see [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases) and [Database Design · Replication](../database-design/topic.html?p=09-replication)). *Fix:* batch, throttle, watch `pg_stat_replication`.

**Debugging toolkit:**

```bash
python manage.py showmigrations --plan              # execution order with [X]/[ ]
python manage.py sqlmigrate orders 0042             # exact SQL
python manage.py sqlmigrate orders 0042 --backwards # reverse SQL
python manage.py migrate --plan                     # what WOULD run now
python manage.py makemigrations --check --dry-run -v 3   # show pending diff
```

```sql
-- Who is blocking my migration?
SELECT pid, wait_event_type, state, now() - query_start AS age, left(query, 80)
FROM pg_stat_activity WHERE datname = current_database() ORDER BY age DESC;
SELECT pid, pg_blocking_pids(pid) FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0;
```

`InconsistentMigrationHistory` means a migration was applied before one of its dependencies — usually someone added a dependency to an old migration, or a `--fake` went wrong. Fix the history explicitly (fake the dependency if the schema really exists), don't delete rows blindly.

**Scaling notes:** for test speed, squash periodically and consider `--keepdb` locally; for many apps, `makemigrations --check` in pre-commit catches drift early. For schema evolution beyond Django (multi-service databases, online schema change tools like `pg_repack`), see [Database Design · Schema Evolution](../database-design/topic.html?p=27-schema-evolution).

## 9. Interview Questions

**Q: What is the difference between `makemigrations` and `migrate`?**
A: `makemigrations` is a code generator: it compares your current model definitions against the state reconstructed from existing migration files and writes new migration files describing the difference. It does not touch the database schema. `migrate` is the executor: it reads which migrations are recorded in `django_migrations`, computes a plan of unapplied migrations in dependency order, runs their operations against the database, and records each one. You run `makemigrations` on a developer machine and commit the output; you run `migrate` in every environment.

**Q: How does Django know which migrations have been applied?**
A: The `MigrationRecorder` stores one row per applied migration in the `django_migrations` table (app, name, applied timestamp). `migrate` loads the migration graph from files, subtracts the recorded set, and plans the rest. That is also why `--fake` works: it inserts the row without running SQL. If you manually alter the schema, Django has no idea — the table records history, not reality.

**Q: Does `makemigrations` look at the database?**
A: No — the autodetector compares models to the migration *state*, which it rebuilds in memory by replaying every operation in the migration files. This is a frequent trick question. Consequences: hand-made DB changes are invisible to it, and you can generate migrations without a database connection. It only consults the database for consistency checks, not for the diff.

**Q: What is a data migration and how do you write one correctly?**
A: A migration whose operation transforms rows rather than schema, usually `RunPython(forwards, backwards)`. Inside the function you get the historical model via `apps.get_model("app", "Model")` — never import the real model, because it reflects today's fields rather than the fields at that point in history. Use `schema_editor.connection.alias` for multi-database correctness, batch large updates with `iterator()` and `bulk_update`, provide reverse code (`RunPython.noop` if nothing to undo), and keep it idempotent. For very large tables run the backfill outside the migration so it doesn't hold a transaction and locks.

**Q: Two developers each created migration `0007` in the same app. What happens and how do you fix it?**
A: The graph now has two leaf nodes in that app, and `migrate` refuses with "Conflicting migrations detected". If the two migrations touch unrelated things, run `makemigrations --merge`, which creates a merge migration depending on both leaves (with no operations, or interactive resolution). If they conflict semantically — both alter the same field — rewrite one branch's migration on top of the other before merging to main. Many teams add a CI check (or a `max_migration.txt` approach via tools like django-linear-migrations) to force linear history.

**Q: What do `--fake` and `--fake-initial` do, and when are they appropriate?**
A: `--fake` marks migrations as applied without executing them; `--fake-initial` fakes an app's initial migration only if all the tables/columns it creates already exist. They are appropriate when adopting Django on an existing database, or when the schema change was applied out of band (by a DBA, by `RunSQL` elsewhere). They are dangerous as a "fix" for errors, because they make state and reality diverge and the next migration will fail in a more confusing way.

**Q: How do you roll back a migration?**
A: `python manage.py migrate app 0041` unapplies every migration after 0041 in reverse order, calling each operation's `database_backwards`. Schema ops are reversible automatically; `RunPython`/`RunSQL` need reverse code or the rollback raises `IrreversibleError`. `migrate app zero` unapplies all. In production, rollbacks of destructive changes rarely recover data — a dropped column is gone — so teams prefer roll-forward fixes and rely on expand/contract so that the old code version still works without rolling back the schema.

**Q: What does `squashmigrations` do and what are the risks?**
A: It combines a range of migrations into one file with optimized operations (e.g. `AddField` then `AlterField` collapses) and a `replaces` list. Databases that applied the originals treat the squash as applied; fresh ones run just the squash. Risks: `RunPython` operations are copied unless marked `elidable=True`, so you may need to clean them up; and you can only delete the old files once every environment has migrated past the squashed range. It mostly buys faster test database setup.

**Q: Why is a migration that adds a column with `default=` different from one with `db_default=`?**
A: With `default=`, Django uses the Python default to fill existing rows during the migration and then drops the database default, so the column has no default in the DB. Any writer that doesn't supply the column — old application pods during a rolling deploy, raw SQL, other services — gets a NOT NULL violation. `db_default` (Django 5.0+) keeps a database-level `DEFAULT`, so those INSERTs succeed and the model also reads it back. On PostgreSQL 11+ a constant default is metadata-only, so both are fast to add.

**Q: How would you add a NOT NULL column to a 100-million-row table with zero downtime? (Senior)**
A: Split it across releases. First add the column nullable (or with a constant `db_default`, which is metadata-only on modern PostgreSQL), with no index and no validated constraint. Deploy code that writes the new column for new rows. Backfill old rows in small batched transactions outside the migration, throttled to protect replicas. Then add `CHECK (col IS NOT NULL) NOT VALID`, `VALIDATE CONSTRAINT` (which takes a weak lock and lets traffic continue), `SET NOT NULL` (which PostgreSQL 12+ can do without a rescan thanks to the validated check), and drop the helper check — wrapped in `SeparateDatabaseAndState` so Django's state matches. Any index goes in via `AddIndexConcurrently` in an `atomic = False` migration. Throughout, set `lock_timeout` so a blocked DDL fails fast instead of queueing all traffic.

**Q: How do you rename a column without downtime in a rolling deployment? (Senior)**
A: Not with `RenameField` — it is instant but breaks whichever code version doesn't know the new name. Expand: add the new column, write both. Backfill. Switch reads to the new column while still writing both. Contract: remove the old field from Django state (`SeparateDatabaseAndState` with `RemoveField` in `state_operations`) so no code selects it, and in the following release drop it in SQL. Alternatively keep the column name and change only the Python attribute with `db_column="old_name"`, which needs no DDL at all — often the pragmatic answer.

**Q: Why should migrations not run in every container's entrypoint? (Senior)**
A: Because N pods starting together run `migrate` concurrently: they race to apply the same migration, producing errors and crash loops, and long migrations make health checks fail so the orchestrator restarts pods mid-DDL. Migrations also need to run *before* new code serves traffic but *after* the previous release is stable, which is a deployment-ordering concern. Run them once as a release step (Kubernetes Job, release phase), gate rollout on success, and keep `migrate --check` in CI to detect unapplied migrations.

**Q: Your deploy ran a trivial `AddField` and the whole site froze for several minutes. How do you debug and prevent it? (Senior)**
A: That's the classic lock-queue: `ALTER TABLE` needs `ACCESS EXCLUSIVE`, which waited behind a long-running query, and every subsequent query queued behind the ALTER. Confirm with `pg_stat_activity` and `pg_blocking_pids()` during the incident or via logs (`log_lock_waits`). Prevent with `lock_timeout` on the migration session plus retries, `statement_timeout` for application/report roles, routing analytics to replicas, and running risky migrations at low traffic. Also check the migration wasn't atomic with a heavy `RunPython` that kept the lock held.

**Q: When would you use `SeparateDatabaseAndState`?**
A: When you need Django's model state and the real database to change differently. Typical cases: you applied DDL manually or via custom `RunSQL` (e.g. `NOT VALID` constraints) and want the state to reflect it; moving a model to another app while keeping its table (`db_table`); or removing a field from state one release before dropping the column. It takes `database_operations` and `state_operations` lists, and afterwards `makemigrations --check` should show no changes.

## 10. Quick Revision & Cheat Sheet

| Command / API | What it does |
|---|---|
| `makemigrations [app] --name x` | Diff models vs migration state → write file |
| `makemigrations --check --dry-run` | CI: fail if models have unmigrated changes |
| `makemigrations --merge` | Resolve two leaf nodes with a merge migration |
| `makemigrations app --empty` | Blank file for a data migration |
| `migrate [app] [target]` | Apply / unapply to target (`zero` = all) |
| `migrate --plan` / `--check` | Show plan / exit non-zero if unapplied |
| `migrate --fake` / `--fake-initial` | Record without running SQL |
| `sqlmigrate app 0007 [--backwards]` | Print SQL |
| `showmigrations [--plan]` | Applied status / ordered plan |
| `squashmigrations app 0040` | Collapse with `replaces` |
| `RunPython(f, reverse, elidable=True)` | Data migration; use `apps.get_model` |
| `AddIndexConcurrently` + `atomic=False` | Non-blocking index on PostgreSQL |
| `SeparateDatabaseAndState` | Change state and DB independently |
| `db_default` (5.0+) | Persistent DB default |

- The autodetector diffs against **migration state**, not the database.
- `django_migrations` records history; `--fake` edits only history.
- PostgreSQL migrations are **atomic** by default — locks held until commit.
- `ALTER TABLE` waits in the lock queue and blocks everyone behind it: use `lock_timeout`.
- Indexes on live tables: `CONCURRENTLY`, `atomic = False`.
- Rolling deploy rule: each release's schema must work with the previous release's code.
- Expand → backfill → switch → contract for renames, NOT NULL, type changes.
- Never edit an applied migration; never import real models in `RunPython`.
- Run `migrate` once per release, not per container.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" "psycopg[binary]"`, `django-admin startproject lab .`, `python manage.py startapp shop`, point `DATABASES` at a local PostgreSQL.

1. **Read the SQL.** Create `Product(name, price)`, then add `stock = PositiveIntegerField(default=0)`. Run `sqlmigrate` and find the `DROP DEFAULT`. Switch to `db_default=0`, regenerate, compare.
2. **State vs DB.** Manually `ALTER TABLE shop_product ADD COLUMN sku text;` in `psql`, then add `sku` to the model and run `migrate`. Observe the "already exists" error. Fix it with `--fake` *for that migration only*, and explain what you just asserted.
3. **Conflict.** On two git branches, add different fields and `makemigrations` on each. Merge the branches, run `migrate`, read the error, then `makemigrations --merge`. Inspect the merge file's `dependencies`.
4. **Data migration.** Add `slug` (blank allowed), write an empty migration that backfills it with `apps.get_model`, `iterator()` and `bulk_update`. Roll back to before it — confirm that without `reverse_code` you get `IrreversibleError`.
5. **Lock queue.** In `psql` session A: `BEGIN; SELECT * FROM shop_product; ` (leave open). In session B run `migrate` for an `AddField`. In session C run `SELECT 1 FROM shop_product LIMIT 1;` and watch it hang. Repeat with `SET lock_timeout='2s'` in the migration.
6. **Concurrent index.** Seed a million rows (`generate_series`), add an index with `AddIndexConcurrently` in an `atomic=False` migration, and in parallel run inserts to confirm they aren't blocked.

**Mini project:** implement the full zero-downtime rename of `Customer.fullname` → `Customer.name` as five commits (expand, dual-write code, backfill command, switch reads + NOT NULL, contract), and write a short `DEPLOY.md` stating which commit can be deployed while the previous one's code is still running.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 08 · Models & Fields](topic.html?p=08-models-fields) (field options that drive migrations), [Ch 09 · Relationships](topic.html?p=09-relationships) (FKs and cross-app dependencies), [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization) (`bulk_update`, `iterator()` for backfills), [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency), [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres), [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user), [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production).

**Other handbooks:** [Database Design · Schema Evolution](../database-design/topic.html?p=27-schema-evolution), [Database Design · Locking Internals](../database-design/topic.html?p=05-locking-internals), [SQL · Locking & MVCC](../sql/topic.html?p=27-locking-mvcc), [SQL · Keys & Constraints](../sql/topic.html?p=29-keys-constraints), [SQL · Index Design](../sql/topic.html?p=20-index-design).

- **Migrations topic guide** — Django docs · *Beginner* · the official walkthrough of the workflow, dependencies, squashing and data migrations. <https://docs.djangoproject.com/en/5.2/topics/migrations/>
- **Migration operations reference** — Django docs · *Intermediate* · every operation including `RunPython`, `RunSQL` and `SeparateDatabaseAndState`. <https://docs.djangoproject.com/en/5.2/ref/migration-operations/>
- **Writing database migrations (how-to)** — Django docs · *Intermediate* · non-atomic migrations, unique fields on existing rows, moving models. <https://docs.djangoproject.com/en/5.2/howto/writing-migrations/>
- **PostgreSQL-specific database operations** — Django docs · *Intermediate* · `AddIndexConcurrently`, extensions, constraint validation. <https://docs.djangoproject.com/en/5.2/ref/contrib/postgres/operations/>
- **PostgreSQL ALTER TABLE** — PostgreSQL docs · *Advanced* · which forms rewrite the table and which lock level each takes. <https://www.postgresql.org/docs/current/sql-altertable.html>
- **django-pg-zero-downtime-migrations** — GitHub · *Advanced* · a backend that rewrites dangerous operations into safe ones; read its README for the patterns alone. <https://github.com/tbicr/django-pg-zero-downtime-migrations>
- **django-migration-linter** — GitHub · *Intermediate* · CI linter for backward-incompatible migrations. <https://github.com/3YOURMIND/django-migration-linter>

---

*Django Handbook — chapter 11.*
