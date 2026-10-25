# 36 · Django Internals: How It Really Works

> **In one line:** Django is a few hundred lines of carefully ordered startup code (lazy settings → `django.setup()` → the app registry), a metaclass that turns your model classes into `_meta` plus descriptors, a lazy `QuerySet` that builds a `sql.Query` tree and hands it to a `SQLCompiler` only when you iterate, and a handler that compiles `MIDDLEWARE` into one nested callable at boot. Know these four machines and nearly every confusing Django error explains itself.

---

## 1. Overview

> **Builds on:** [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle), [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings), [Ch 08 · Models & Fields](topic.html?p=08-models-fields), [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups), [Ch 18 · Middleware](topic.html?p=18-middleware).

Most Django developers learn the framework from the outside in: write a model, write a view, it works. That is fine until one of these lands on your desk:

- `django.core.exceptions.AppRegistryNotReady: Apps aren't loaded yet.` from a Celery worker or a standalone script.
- `ImproperlyConfigured: Requested setting DEBUG, but settings are not configured.` in a test runner.
- `RuntimeError: Model class shop.models.Book doesn't declare an explicit app_label and isn't in an application in INSTALLED_APPS.`
- A page that issues 400 queries even though "there's only one loop" — because a template touched `book.author.name`.
- A middleware that "doesn't run" for some requests, or whose exception handler never sees an exception.
- A `QuerySet` you "filtered" that still returns everything, because you forgot that `filter()` returns a *new* object.

The naive approach to such bugs is cargo-cult: move the import, add `django.setup()` somewhere, sprinkle `select_related`, reorder middleware until it works. That gets you through the afternoon but leaves you unable to predict the next failure — and it collapses in a senior interview, where "what happens when you call `Book.objects.filter(...)`?" or "how does `book.author` know to run a query?" are standard probes.

This chapter opens the box. It is the **home chapter** for Django's internal machinery; the concept chapters it builds on explain *how to use* each piece. Here you learn *how each piece is built*, in four parts:

1. **Startup** — `LazySettings`, `django.setup()`, and the three-phase `Apps.populate()`.
2. **Models** — the `ModelBase` metaclass, `Options` (`_meta`), `contribute_to_class`, and the descriptors that power attribute access.
3. **Queries** — `Manager` → `QuerySet` → `sql.Query` → `SQLCompiler` → cursor → `ModelIterable` → instances.
4. **Requests** — `WSGIHandler`/`ASGIHandler`, `BaseHandler.load_middleware()`, `get_response()`, URL resolution and exception conversion.

> **Why this matters:** Every one of these machines is *lazy* or *built once*. Settings load on first attribute access, models register at import time, queries compile on iteration, the middleware chain is compiled at the first request. Most "mysterious" bugs are a mismatch between when you *think* something happens and when it actually does.

## 2. Core Concepts

- **`LazySettings` / `LazyObject`** — `django.conf.settings` is a proxy that imports `DJANGO_SETTINGS_MODULE` on first attribute access. *Why it matters:* importing `settings` is free; *reading* one before configuration raises `ImproperlyConfigured`.
- **`django.setup()`** — configures logging, sets the URL script prefix, and calls `apps.populate(settings.INSTALLED_APPS)`. *Why it matters:* every entry point (`manage.py`, `get_wsgi_application()`, `get_asgi_application()`, Celery's Django fixup, pytest-django) calls it; your standalone scripts must too.
- **App registry (`django.apps.apps`)** — the global `Apps` instance holding `AppConfig`s and models. Flags `apps_ready`, `models_ready`, `ready`. *Why it matters:* `apps.get_model()` and anything that walks models only work after population.
- **`AppConfig`** — per-app object (`label`, `name`, `path`, `models_module`) with the `ready()` hook. *Why it matters:* the right place to connect signals and register checks, because all models exist by then.
- **`ModelBase`** — the metaclass of `models.Model`. *Why it matters:* the moment Python executes `class Book(models.Model):`, `ModelBase.__new__` builds `_meta`, attaches fields, creates `DoesNotExist`, adds a default manager and registers the class.
- **`Options` (`Model._meta`)** — the model's metadata: `fields`, `get_fields()`, `get_field()`, `pk`, `db_table`, `label`, `app_label`, `ordering`, `indexes`, `constraints`. *Why it matters:* admin, forms, serializers, migrations and the ORM all introspect models through `_meta` — and so can your generic code.
- **`contribute_to_class(cls, name)`** — the hook a field or manager uses to install itself on a model class. *Why it matters:* it is why a field declaration becomes both a `_meta` entry *and* a class-level descriptor.
- **Descriptors** — objects with `__get__`/`__set__` placed on the class: `DeferredAttribute` (plain fields), `ForwardManyToOneDescriptor` (`book.author`), `ReverseManyToOneDescriptor` (`author.books`), `ManyToManyDescriptor`, `ReverseOneToOneDescriptor`, `ManagerDescriptor`. *Why it matters:* every implicit query (lazy FK load, deferred field load) is triggered inside a descriptor's `__get__`.
- **`ModelState` (`instance._state`)** — `adding`, `db`, `fields_cache`. *Why it matters:* `fields_cache` is where `select_related` results live; `adding` decides INSERT vs UPDATE.
- **`Manager`** — `BaseManager.from_queryset(QuerySet)`; a factory for QuerySets. *Why it matters:* `Book.objects.filter` is literally `Book.objects.get_queryset().filter`.
- **`QuerySet`** — lazy, chainable wrapper around a `sql.Query` plus a `_result_cache`. *Why it matters:* every chain method clones; nothing hits the DB until evaluation.
- **`sql.Query`** — the backend-neutral query tree: `alias_map` (tables and joins), `where` (a `WhereNode` of lookups), `annotations`, `group_by`, `order_by`, `low_mark`/`high_mark`. *Why it matters:* this is what `filter()` actually mutates.
- **`SQLCompiler`** — turns a `Query` into `(sql, params)` for one connection; subclasses for INSERT/UPDATE/DELETE/aggregate, and per-backend variants. *Why it matters:* it is where vendor differences (`as_postgresql`) are applied and where parameterization protects you from SQL injection.
- **Iterable classes** — `ModelIterable`, `ValuesIterable`, `ValuesListIterable`, `FlatValuesListIterable`, `NamedValuesListIterable`. *Why it matters:* `.values()` is cheaper than model instances because it swaps the iterable, skipping `Model.from_db()`.
- **`BaseHandler`** — parent of `WSGIHandler` and `ASGIHandler`; `load_middleware()` builds `_middleware_chain`; `get_response()` runs it. *Why it matters:* middleware ordering, short-circuiting and exception conversion are all decided here.
- **`convert_exception_to_response`** — wraps each middleware layer so exceptions become responses (404/403/400/500) before reaching the outer layer. *Why it matters:* outer middleware sees a 500 *response*, not an exception.
- **`ConnectionHandler` (`django.db.connections`)** — lazily opens one `DatabaseWrapper` per alias per thread (per async context). *Why it matters:* connections are not shared across threads, and `CONN_MAX_AGE` is enforced by signal handlers at request boundaries.

## 3. Theory & Principles

### 3.1 Settings are a lazy proxy

`django/conf/__init__.py` ends with `settings = LazySettings()`. `LazySettings` subclasses `LazyObject`, whose `_wrapped` attribute starts as the sentinel `empty`. The first time you read *any* attribute, `LazySettings.__getattr__` calls `self._setup(name)`, which:

1. Reads `os.environ["DJANGO_SETTINGS_MODULE"]`. If missing, it raises `ImproperlyConfigured("Requested setting X, but settings are not configured. You must either define the environment variable DJANGO_SETTINGS_MODULE or call settings.configure() ...")`.
2. Builds `Settings(settings_module)`: copies every UPPERCASE name from `django.conf.global_settings` (the defaults), then `importlib.import_module(settings_module)` and copies every UPPERCASE name from your module over them. Lower-case names in `settings.py` are silently ignored — a classic bug.
3. Validates a few things (for example, tuple/list types for `ALLOWED_HOSTS`-style settings, `SECRET_KEY` non-empty when read).

`__getattr__` then **caches the value in the proxy's own `__dict__`**, so the second read of `settings.DEBUG` is a plain attribute lookup. `__setattr__` clears that cache, which is how `override_settings` in tests can swap `_wrapped` and send the `setting_changed` signal so caches that depend on settings (template engines, URL resolver, password hashers) reset.

`settings.configure(**overrides)` is the alternative for scripts and libraries: it wraps a `UserSettingsHolder` around `global_settings` and must be called before the first read, or you get `RuntimeError: Settings already configured.`

### 3.2 `django.setup()` and the three phases of `Apps.populate()`

`django.setup(set_prefix=True)` does three things: `configure_logging(settings.LOGGING_CONFIG, settings.LOGGING)`, `set_script_prefix(...)` (so `reverse()` works outside requests), and `apps.populate(settings.INSTALLED_APPS)`. `populate()` holds a lock, is idempotent (returns if `ready`) and **not reentrant** — if code running during population calls `populate()` again, it raises `RuntimeError("populate() isn't reentrant")`. It runs in three strict phases:

- **Phase 1 — app configs.** For each `INSTALLED_APPS` entry, `AppConfig.create(entry)` imports the app *package* (not its models), finds its `AppConfig` (an explicit dotted path, or since 3.2 the single `AppConfig` subclass in `apps.py`, or the one marked `default = True`), and checks label and name uniqueness ("Application labels aren't unique"). Then `apps_ready = True`.
- **Phase 2 — models.** For each config, `import_models()` imports `<app>.models`. Importing executes the class bodies, so `ModelBase.__new__` runs for every model and calls `apps.register_model()`. Then `models_ready = True`.
- **Phase 3 — ready().** Each `AppConfig.ready()` is called in `INSTALLED_APPS` order. Then `ready = True`.

The infamous `AppRegistryNotReady: Apps aren't loaded yet.` is raised by `apps.check_apps_ready()` when something asks the registry for information it doesn't have yet — most commonly, a module imported in Phase 1 (an app's `__init__.py`) imports `models`, or a script imports `myapp.models` before calling `django.setup()`. `ModelBase` itself calls `apps.get_containing_app_config(module)` to find a model's `app_label`, which requires `apps_ready`.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj36a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj36b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Startup: from DJANGO_SETTINGS_MODULE to a ready app registry</text>
  <rect x="20" y="44" width="180" height="70" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="110" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Entry point</text>
  <text x="110" y="84" text-anchor="middle" fill="#334155" font-size="10">manage.py / wsgi.py / asgi.py</text>
  <text x="110" y="100" text-anchor="middle" fill="#334155" font-size="10">celery worker / pytest</text>
  <path d="M200,79 L240,79" stroke="#2563eb" stroke-width="2" marker-end="url(#dj36a)"/>
  <rect x="242" y="44" width="190" height="70" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="337" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">LazySettings._setup()</text>
  <text x="337" y="84" text-anchor="middle" fill="#334155" font-size="10">global_settings defaults</text>
  <text x="337" y="100" text-anchor="middle" fill="#334155" font-size="10">+ UPPERCASE names of your module</text>
  <path d="M432,79 L472,79" stroke="#2563eb" stroke-width="2" marker-end="url(#dj36a)"/>
  <rect x="474" y="44" width="190" height="70" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="569" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">django.setup()</text>
  <text x="569" y="84" text-anchor="middle" fill="#334155" font-size="10">configure_logging()</text>
  <text x="569" y="100" text-anchor="middle" fill="#334155" font-size="10">set_script_prefix()</text>
  <path d="M664,79 L704,79" stroke="#2563eb" stroke-width="2" marker-end="url(#dj36a)"/>
  <rect x="706" y="44" width="154" height="70" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="783" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">apps.populate()</text>
  <text x="783" y="84" text-anchor="middle" fill="#334155" font-size="10">lock, idempotent,</text>
  <text x="783" y="100" text-anchor="middle" fill="#334155" font-size="10">not reentrant</text>
  <path d="M783,114 L783,140" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj36b)"/>
  <rect x="20" y="146" width="270" height="130" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="155" y="168" text-anchor="middle" fill="#1e293b" font-weight="bold">Phase 1: AppConfig.create(entry)</text>
  <text x="34" y="190" fill="#334155" font-size="10">import the app package (not models)</text>
  <text x="34" y="208" fill="#334155" font-size="10">pick AppConfig from apps.py</text>
  <text x="34" y="226" fill="#334155" font-size="10">check labels / names unique</text>
  <text x="34" y="254" fill="#16a34a" font-size="10" font-weight="bold">apps_ready = True</text>
  <rect x="305" y="146" width="270" height="130" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="168" text-anchor="middle" fill="#1e293b" font-weight="bold">Phase 2: import_models()</text>
  <text x="319" y="190" fill="#334155" font-size="10">import app.models &#8594; class bodies run</text>
  <text x="319" y="208" fill="#334155" font-size="10">ModelBase.__new__ builds _meta</text>
  <text x="319" y="226" fill="#334155" font-size="10">apps.register_model(label, cls)</text>
  <text x="319" y="254" fill="#16a34a" font-size="10" font-weight="bold">models_ready = True</text>
  <rect x="590" y="146" width="270" height="130" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="725" y="168" text-anchor="middle" fill="#1e293b" font-weight="bold">Phase 3: AppConfig.ready()</text>
  <text x="604" y="190" fill="#334155" font-size="10">connect signals, register checks</text>
  <text x="604" y="208" fill="#334155" font-size="10">every model already exists</text>
  <text x="604" y="226" fill="#334155" font-size="10">avoid DB queries here</text>
  <text x="604" y="254" fill="#16a34a" font-size="10" font-weight="bold">ready = True</text>
  <path d="M290,211 L303,211" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj36b)"/>
  <path d="M575,211 L588,211" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj36b)"/>
  <rect x="20" y="296" width="840" height="106" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="440" y="318" text-anchor="middle" fill="#1e293b" font-weight="bold">Where the classic errors come from</text>
  <text x="36" y="340" fill="#334155" font-size="10">Read a setting before DJANGO_SETTINGS_MODULE is set &#8594; ImproperlyConfigured: settings are not configured</text>
  <text x="36" y="358" fill="#334155" font-size="10">Import models in an app __init__.py, or before django.setup() &#8594; AppRegistryNotReady: Apps aren't loaded yet</text>
  <text x="36" y="376" fill="#334155" font-size="10">Model module not inside an INSTALLED_APPS app &#8594; RuntimeError: doesn't declare an explicit app_label</text>
  <text x="36" y="394" fill="#334155" font-size="10">Code in ready() triggers populate() again &#8594; RuntimeError: populate() isn't reentrant</text>
</svg>
```

### 3.3 `ModelBase`: what `class Book(models.Model)` actually executes

When Python finishes reading a `class` statement it calls the metaclass: `ModelBase.__new__(mcs, "Book", (models.Model,), attrs)`. Simplified, it:

1. **Skips** the bare `Model` base itself (only subclasses get processed).
2. **Splits `attrs`**: attributes *with* a `contribute_to_class` method (fields, managers, `Meta`-free descriptors) are held back; plain attributes (methods, constants) go straight into `type.__new__`.
3. **Resolves `app_label`** from `Meta.app_label` or `apps.get_containing_app_config(module)`; failing both, it raises the "doesn't declare an explicit app_label" `RuntimeError`.
4. **Builds `Options`**: `new_class.add_to_class("_meta", Options(meta, app_label))`. `Options.contribute_to_class` reads your inner `Meta` (`db_table`, `ordering`, `indexes`, `constraints`, `abstract`, `proxy`…) and computes defaults like `db_table = "shop_book"`.
5. **Creates exceptions**: `Book.DoesNotExist` (subclass of the parent's or `ObjectDoesNotExist`) and `Book.MultipleObjectsReturned` — which is why `except Book.DoesNotExist` works and catches child-model misses too.
6. **Contributes fields** by calling `add_to_class(name, value)` → `value.contribute_to_class(cls, name)` for each held-back attribute. For a `Field` this sets `field.name`, `field.attname` (`author_id` for an FK), `field.column`, `field.model = cls`, calls `cls._meta.add_field(field)`, and installs a descriptor on the class (`DeferredAttribute` for plain fields; relation fields install their own).
7. **Handles inheritance**: abstract parents' fields are *copied* onto the child; multi-table inheritance auto-adds a `parent_ptr` `OneToOneField(parent_link=True)`; proxies share the concrete parent's table.
8. **`_prepare()`**: `Options._prepare()` adds an auto primary key (`DEFAULT_AUTO_FIELD`, typically `BigAutoField`) if you didn't declare one, adds a default `objects = Manager()` if the class has no managers, and sends the `class_prepared` signal.
9. **Registers** the class: `apps.register_model(app_label, new_class)`. Registration also flushes **pending lazy operations** — a `ForeignKey("shop.Author")` string reference declared before `Author` existed is resolved now via `lazy_related_operation`.

All of this happens at **import time**, once per process. That is why defining a model in a module that never gets imported (say, `shop/models/book.py` not re-exported from `shop/models/__init__.py`) means "the model doesn't exist" — no migration, no admin, nothing.

### 3.4 Descriptors: how attribute access runs queries

After `ModelBase` runs, the *class* `Book` holds descriptor objects; *instances* hold raw values in `__dict__`.

- **`DeferredAttribute`** (plain fields). `__get__` returns `instance.__dict__["title"]` if present; if the field was deferred via `only()`/`defer()`, it calls `instance.refresh_from_db(fields=["title"])` — **one query per deferred field access**.
- **`ForwardManyToOneDescriptor`** (`book.author`). `__get__` checks `instance._state.fields_cache["author"]` (filled by `select_related` or a previous access). If absent and `author_id` is not `None`, it runs `Author._base_manager.get(pk=author_id)` and caches it. That is the N+1 query, located precisely. `__set__` sets both the cache and `author_id`.
- **`ReverseManyToOneDescriptor`** (`author.books`). `__get__` returns a **related manager** — a dynamically created subclass of the default manager whose `get_queryset()` adds `filter(author=instance)`. Before querying, it checks `instance._prefetched_objects_cache["books"]`; if `prefetch_related` populated it, `.all()` returns the cached list. A further `.filter()` builds a new query and ignores the cache.
- **`ManyToManyDescriptor`** — subclass of the reverse descriptor; its manager joins through the `through` table and implements `add/remove/set/clear` (sending `m2m_changed`).
- **`ReverseOneToOneDescriptor`** (`user.profile`) — raises `RelatedObjectDoesNotExist` (a subclass of both `Profile.DoesNotExist` and `AttributeError`) when there is no row, which is why `hasattr(user, "profile")` works.
- **`ManagerDescriptor`** — `Book.objects` returns the manager; `book.objects` raises `AttributeError: Manager isn't accessible via Book instances`, a deliberate design choice separating table-level and row-level operations.

> **Interview tip:** "How does `book.author` work?" — answer with the descriptor: class attribute `ForwardManyToOneDescriptor`, cache in `_state.fields_cache`, otherwise a `get(pk=author_id)` query. Then mention that `book.author_id` never queries because it's a plain `DeferredAttribute` on the FK column.

### 3.5 The query pipeline: from `filter()` to model instances

`Book.objects.filter(price__gt=20)` is: `ManagerDescriptor.__get__` → `Manager` → `get_queryset()` returns `QuerySet(model=Book, using=self._db)` → `.filter()` → `_filter_or_exclude()` → `clone = self._chain()` → `clone._query.add_q(Q(price__gt=20))`.

`add_q()` → `_add_q()` → `build_filter()`, which splits `"price__gt"` with `solve_lookup_type()`, walks relations with `names_to_path()`/`setup_joins()` (adding `Join` objects to `alias_map` and reusing aliases where it can), resolves the right-hand side (an `F()` becomes a `Col`), finds the registered `Lookup` class (`GreaterThan`) and appends it to the `WhereNode`. **No SQL exists yet** — only a tree.

Evaluation (iteration, `len()`, `list()`, `bool()`, `repr()`, pickling, step-slicing) calls `QuerySet._fetch_all()`: if `_result_cache is None`, it runs `list(self._iterable_class(self))`, then performs `prefetch_related` lookups if any. `ModelIterable.__iter__`:

1. `compiler = queryset.query.get_compiler(using=db)` — looks up `connection.ops.compiler("SQLCompiler")`, so PostgreSQL gets `django.db.backends.postgresql.compiler.SQLCompiler`.
2. `results = compiler.execute_sql(chunked_fetch=..., chunk_size=...)` → `as_sql()` → `pre_sql_setup()` (`get_select()`, `get_order_by()`, `get_group_by()`), then each node compiled via `compiler.compile(node)`, which prefers a vendor method like `as_postgresql()` over `as_sql()`. The result is `(sql, params)` — **parameters stay separate** until the DB driver binds them.
3. `cursor.execute(sql, params)` on the connection's cursor; rows fetched in chunks (`GET_ITERATOR_CHUNK_SIZE`, 100 rows).
4. For each row, `Model.from_db(db, field_names, values)` builds an instance (`_state.adding = False`, `_state.db = db`); `select_related` rows are split by `RelatedPopulator`s into related instances stored in `fields_cache`; annotations are `setattr` onto the instance.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj36c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj36d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Build lazily, compile on evaluation: the QuerySet pipeline</text>
  <text x="20" y="48" fill="#2563eb" font-size="12" font-weight="bold">BUILD (no database access)</text>
  <rect x="20" y="58" width="150" height="62" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="95" y="80" text-anchor="middle" fill="#1e293b" font-weight="bold">Book.objects</text>
  <text x="95" y="98" text-anchor="middle" fill="#334155" font-size="10">Manager.get_queryset()</text>
  <path d="M170,89 L200,89" stroke="#2563eb" stroke-width="2" marker-end="url(#dj36c)"/>
  <rect x="202" y="58" width="170" height="62" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="287" y="80" text-anchor="middle" fill="#1e293b" font-weight="bold">.filter(price__gt=20)</text>
  <text x="287" y="98" text-anchor="middle" fill="#334155" font-size="10">_chain() clones QuerySet</text>
  <text x="287" y="112" text-anchor="middle" fill="#334155" font-size="10">query.add_q(Q(...))</text>
  <path d="M372,89 L402,89" stroke="#2563eb" stroke-width="2" marker-end="url(#dj36c)"/>
  <rect x="404" y="58" width="456" height="62" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="632" y="78" text-anchor="middle" fill="#1e293b" font-weight="bold">sql.Query tree</text>
  <text x="418" y="96" fill="#334155" font-size="10">alias_map: shop_book, shop_author (Join)   where: WhereNode(AND: GreaterThan(Col, 20))</text>
  <text x="418" y="112" fill="#334155" font-size="10">select / annotations / group_by / order_by / low_mark, high_mark (slicing)</text>
  <text x="20" y="152" fill="#16a34a" font-size="12" font-weight="bold">EVALUATE (iteration, len, list, bool, repr, pickling)</text>
  <rect x="20" y="162" width="190" height="72" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="115" y="184" text-anchor="middle" fill="#1e293b" font-weight="bold">QuerySet._fetch_all()</text>
  <text x="115" y="202" text-anchor="middle" fill="#334155" font-size="10">_result_cache is None?</text>
  <text x="115" y="218" text-anchor="middle" fill="#334155" font-size="10">list(ModelIterable(qs))</text>
  <path d="M210,198 L240,198" stroke="#16a34a" stroke-width="2" marker-end="url(#dj36d)"/>
  <rect x="242" y="162" width="200" height="72" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="342" y="184" text-anchor="middle" fill="#1e293b" font-weight="bold">query.get_compiler(using)</text>
  <text x="342" y="202" text-anchor="middle" fill="#334155" font-size="10">connection.ops.compiler(...)</text>
  <text x="342" y="218" text-anchor="middle" fill="#334155" font-size="10">backend SQLCompiler</text>
  <path d="M442,198 L472,198" stroke="#16a34a" stroke-width="2" marker-end="url(#dj36d)"/>
  <rect x="474" y="162" width="190" height="72" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="569" y="184" text-anchor="middle" fill="#1e293b" font-weight="bold">as_sql() &#8594; (sql, params)</text>
  <text x="569" y="202" text-anchor="middle" fill="#334155" font-size="10">compile(node): as_postgresql</text>
  <text x="569" y="218" text-anchor="middle" fill="#334155" font-size="10">or as_sql per expression</text>
  <path d="M664,198 L694,198" stroke="#16a34a" stroke-width="2" marker-end="url(#dj36d)"/>
  <rect x="696" y="162" width="164" height="72" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="778" y="184" text-anchor="middle" fill="#1e293b" font-weight="bold">execute_sql()</text>
  <text x="778" y="202" text-anchor="middle" fill="#334155" font-size="10">cursor.execute(sql, params)</text>
  <text x="778" y="218" text-anchor="middle" fill="#334155" font-size="10">fetchmany in chunks</text>
  <path d="M778,234 L778,262" stroke="#16a34a" stroke-width="2" marker-end="url(#dj36d)"/>
  <rect x="404" y="266" width="456" height="62" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="632" y="286" text-anchor="middle" fill="#1e293b" font-weight="bold">Row &#8594; instance</text>
  <text x="418" y="304" fill="#334155" font-size="10">Model.from_db(db, names, values): _state.adding=False, _state.db=db</text>
  <text x="418" y="320" fill="#334155" font-size="10">select_related: RelatedPopulator fills _state.fields_cache; annotations setattr</text>
  <path d="M404,297 L372,297" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj36c)"/>
  <rect x="20" y="266" width="350" height="62" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="195" y="286" text-anchor="middle" fill="#1e293b" font-weight="bold">_result_cache = [Book, Book, ...]</text>
  <text x="195" y="304" text-anchor="middle" fill="#334155" font-size="10">then _prefetch_related_objects(): one IN (...)</text>
  <text x="195" y="320" text-anchor="middle" fill="#334155" font-size="10">query per lookup into _prefetched_objects_cache</text>
  <rect x="20" y="344" width="840" height="44" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="440" y="362" text-anchor="middle" fill="#1e293b" font-size="10">.values() swaps ModelIterable for ValuesIterable (no from_db); .iterator() skips _result_cache;</text>
  <text x="440" y="378" text-anchor="middle" fill="#1e293b" font-size="10">str(qs.query) interpolates params for display only &#8212; the real call keeps them separate.</text>
</svg>
```

### 3.6 What `save()` does internally

`Model.save()` → `save_base()` sends `pre_save`, then (inside an atomic block if there are MTI parents) `_save_parents()` and `_save_table()`. `_save_table()` decides between UPDATE and INSERT: if the PK is set and you didn't pass `force_insert`, it tries `_do_update()` — `UPDATE ... WHERE id = %s` via `SQLUpdateCompiler` — and if **zero rows** matched, falls back to `_do_insert()` (`SQLInsertCompiler`, with `RETURNING id` on PostgreSQL). Since Django 3.0 it **skips the UPDATE attempt** when `_state.adding` is `True` and the PK field has a default (e.g. a `UUIDField(default=uuid4)`), saving a wasted query. `update_fields=[...]` restricts the UPDATE column list. Afterwards it sets `_state.adding = False`, `_state.db = using`, and sends `post_save(created=...)`. `full_clean()` is never called.

## 4. Architecture & Workflow

### 4.1 The handler builds the middleware chain once

`get_wsgi_application()` calls `django.setup(set_prefix=False)` and returns `WSGIHandler()`, whose `__init__` calls `self.load_middleware()`. (`ASGIHandler` calls `load_middleware(is_async=True)`.) `BaseHandler.load_middleware()`:

1. Starts with `handler = convert_exception_to_response(self._get_response)` — the innermost callable, which resolves the URL and calls the view.
2. Iterates `reversed(settings.MIDDLEWARE)`. For each entry it imports the class, adapts sync/async mode (`adapt_method_mode`, using `sync_capable`/`async_capable` flags), and instantiates `mw_instance = middleware(handler)`. A middleware can opt out by raising `MiddlewareNotUsed` in `__init__`.
3. Collects hooks: `process_view` is **inserted at index 0** (so they run in top-to-bottom order), `process_template_response` and `process_exception` are appended (so they run bottom-to-top).
4. Wraps: `handler = convert_exception_to_response(mw_instance)`.
5. Stores the outermost callable as `self._middleware_chain`.

Because the list is iterated in reverse, the **first** item in `MIDDLEWARE` ends up as the **outermost** wrapper — it sees the request first and the response last. Each layer is wrapped in `convert_exception_to_response`, so if the view raises `Http404`, the layer just outside the view receives a 404 `HttpResponse`, not an exception. `response_for_exception()` maps `Http404` → 404, `PermissionDenied` → 403, `BadRequest`/`SuspiciousOperation` → 400 (and logs security events), and everything else → `handle_uncaught_exception()` → 500 (the yellow `technical_500_response` when `DEBUG=True`), firing `got_request_exception` (which Sentry hooks).

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj36e" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj36f" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">BaseHandler: one request through the compiled _middleware_chain</text>
  <rect x="20" y="40" width="840" height="300" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="34" y="58" fill="#334155" font-size="10">convert_exception_to_response( SecurityMiddleware )  &#8212; first in MIDDLEWARE = outermost</text>
  <rect x="50" y="68" width="780" height="260" rx="10" fill="#dbeafe" stroke="#2563eb"/>
  <text x="64" y="86" fill="#334155" font-size="10">convert_exception_to_response( SessionMiddleware )</text>
  <rect x="80" y="96" width="720" height="222" rx="10" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="94" y="114" fill="#334155" font-size="10">... CommonMiddleware, CsrfViewMiddleware, AuthenticationMiddleware ...</text>
  <rect x="110" y="124" width="660" height="184" rx="10" fill="#dcfce7" stroke="#16a34a"/>
  <text x="124" y="142" fill="#1e293b" font-weight="bold">convert_exception_to_response( BaseHandler._get_response )</text>
  <rect x="130" y="154" width="140" height="56" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="200" y="176" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">resolve_request()</text>
  <text x="200" y="194" text-anchor="middle" fill="#334155" font-size="9">URLResolver.resolve(path_info)</text>
  <path d="M270,182 L296,182" stroke="#2563eb" stroke-width="2" marker-end="url(#dj36e)"/>
  <rect x="298" y="154" width="140" height="56" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="368" y="176" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">process_view hooks</text>
  <text x="368" y="194" text-anchor="middle" fill="#334155" font-size="9">top &#8594; bottom; may return</text>
  <path d="M438,182 L464,182" stroke="#2563eb" stroke-width="2" marker-end="url(#dj36e)"/>
  <rect x="466" y="154" width="130" height="56" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="531" y="176" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">view(request)</text>
  <text x="531" y="194" text-anchor="middle" fill="#334155" font-size="9">make_view_atomic()</text>
  <path d="M596,182 L622,182" stroke="#2563eb" stroke-width="2" marker-end="url(#dj36e)"/>
  <rect x="624" y="154" width="136" height="56" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="692" y="176" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">response.render()</text>
  <text x="692" y="194" text-anchor="middle" fill="#334155" font-size="9">template_response hooks</text>
  <rect x="130" y="226" width="630" height="70" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="445" y="246" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">view raises? process_exception hooks (bottom &#8594; top) get first chance</text>
  <text x="445" y="264" text-anchor="middle" fill="#334155" font-size="10">none returns a response &#8594; re-raise &#8594; convert_exception_to_response()</text>
  <text x="445" y="282" text-anchor="middle" fill="#334155" font-size="10">Http404 &#8594; 404, PermissionDenied &#8594; 403, SuspiciousOperation &#8594; 400, other &#8594; 500</text>
  <path d="M20,370 L860,370" stroke="#2563eb" stroke-width="2" marker-end="url(#dj36e)"/>
  <text x="440" y="362" text-anchor="middle" fill="#2563eb" font-size="10">request phase: __call__ of each layer, outer to inner (a layer that returns a response short-circuits)</text>
  <path d="M860,400 L20,400" stroke="#16a34a" stroke-width="2" marker-end="url(#dj36f)"/>
  <text x="440" y="420" text-anchor="middle" fill="#16a34a" font-size="10">response phase: code after get_response(request) in each layer, inner to outer &#8212; always an HttpResponse</text>
</svg>
```

### 4.2 One WSGI request, end to end

```text
gunicorn worker thread
  └─ WSGIHandler.__call__(environ, start_response)
       ├─ set_script_prefix(get_script_name(environ))
       ├─ signals.request_started.send()      -> close_old_connections() (CONN_MAX_AGE / health checks)
       ├─ request = WSGIRequest(environ)       (GET/POST/body parsed lazily)
       ├─ response = self.get_response(request)
       │     ├─ set_urlconf(settings.ROOT_URLCONF)
       │     ├─ response = self._middleware_chain(request)
       │     │     └─ ... _get_response(): resolve -> process_view -> view -> render
       │     └─ log_response() if status >= 400
       ├─ start_response(status, headers)
       └─ return response  (server iterates it, then calls response.close())
                              └─ signals.request_finished -> close_old_connections()
```

Two details worth noticing. First, `request_finished` fires from `HttpResponse.close()`, which the WSGI server calls *after* sending the body — so for a `StreamingHttpResponse`, DB connections stay open until the last chunk is sent. Second, `request.urlconf` set by a middleware overrides `ROOT_URLCONF` for that request (the basis of per-host routing in multi-tenant apps).

### 4.3 The ASGI variant

`ASGIHandler.__call__(scope, receive, send)` accepts only `scope["type"] == "http"` (Channels' `ProtocolTypeRouter` handles websockets), reads the body into a `SpooledTemporaryFile`, sends `request_started` via `sync_to_async`, builds an `ASGIRequest`, and awaits `get_response_async()`. The chain was built with `is_async=True`, so any sync-only middleware is wrapped in `sync_to_async` (thread-sensitive), costing a thread hop per layer — which is why one sync middleware in an otherwise async stack quietly erodes async benefits. The ORM is still sync underneath: `aget()`/`acount()` are `sync_to_async` wrappers (see [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi)).

### 4.4 Database connections

`django.db.connections` is a `ConnectionHandler` keyed by alias; `connection` is a proxy to `connections["default"]`. Each thread (or async context, via `asgiref.local.Local`) gets its own `DatabaseWrapper`, created lazily and connected on the first `cursor()` call (`ensure_connection()`). With `DEBUG=True`, cursors are `CursorDebugWrapper`s that append to `connection.queries` (a bounded deque) — handy, but also a memory cost in long scripts. `connection.execute_wrapper(fn)` lets you instrument every query without DEBUG, which is how you build a "queries per request" budget in production. Pooling, `CONN_MAX_AGE` and replicas are covered in [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases).

## 5. Implementation

### 5.1 Simple example: poke the machinery in a shell

```python
# python manage.py shell
from django.conf import settings
from django.apps import apps
from shop.models import Book

type(settings), type(settings._wrapped)
# (<class 'django.conf.LazySettings'>, <class 'django.conf.Settings'>)

type(Book)                       # <class 'django.db.models.base.ModelBase'>
Book._meta.label, Book._meta.db_table, Book._meta.pk
# ('shop.Book', 'shop_book', <django.db.models.fields.BigAutoField: id>)
[f.name for f in Book._meta.get_fields()]
# ['order_items', 'reviews', 'id', 'title', 'author', 'publisher', ...]

type(Book.__dict__["author"]).__name__   # 'ForwardManyToOneDescriptor'
type(Book.__dict__["title"]).__name__    # 'DeferredAttribute'
type(Book.__dict__["objects"]).__name__  # 'ManagerDescriptor'

qs = Book.objects.filter(price__gt=20, author__name="Ana").order_by("-published_on")[:5]
q = qs.query
q.alias_map.keys()       # dict_keys(['shop_book', 'shop_author'])
q.where                  # (AND: Exact(Col(shop_author, shop.Author.name), 'Ana'), GreaterThan(...))
q.low_mark, q.high_mark  # (0, 5)

compiler = q.get_compiler("default")
type(compiler)           # <class 'django.db.backends.postgresql.compiler.SQLCompiler'>
compiler.as_sql()
```

The real output of `as_sql()` keeps parameters separate:

```text
('SELECT "shop_book"."id", "shop_book"."title", ... FROM "shop_book"
  INNER JOIN "shop_author" ON ("shop_book"."author_id" = "shop_author"."id")
  WHERE ("shop_author"."name" = %s AND "shop_book"."price" > %s)
  ORDER BY "shop_book"."published_on" DESC LIMIT 5',
 ('Ana', Decimal('20')))
```

`str(qs.query)` shows `WHERE ("shop_author"."name" = Ana ...)` — unquoted, because it naively interpolates for display. Never copy it into psql and never treat it as the executed SQL. For the exact statement, use `connection.queries`, the debug toolbar, or `qs.explain()`.

```python
b = Book.objects.first()
b._state.adding, b._state.db, b._state.fields_cache   # (False, 'default', {})
b.author                                              # runs SELECT ... FROM shop_author WHERE id = ...
b._state.fields_cache.keys()                          # dict_keys(['author'])
b.objects                                             # AttributeError: Manager isn't accessible via Book instances
```

### 5.2 Standalone script done right

```python
# scripts/reprice.py — run with: python scripts/reprice.py
import os

import django

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.prod")
django.setup()  # MUST run before importing any models

from decimal import Decimal  # noqa: E402

from django.db.models import F  # noqa: E402

from shop.models import Book  # noqa: E402

updated = Book.objects.filter(publisher__name="Penguin").update(price=F("price") * Decimal("1.10"))
print(f"repriced {updated} books")
```

Better still, make it a management command (`shop/management/commands/reprice.py`), because `manage.py` → `execute_from_command_line()` → `ManagementUtility.execute()` already calls `django.setup()` and runs system checks for commands that require them.

### 5.3 Real-world example 1: a generic "model to CSV" exporter built on `_meta`

```python
# core/exporters.py
import csv
from collections.abc import Iterable

from django.db import models
from django.http import StreamingHttpResponse


class Echo:
    def write(self, value):
        return value


def concrete_columns(model: type[models.Model]) -> list[models.Field]:
    """Forward, concrete, non-M2M fields in declaration order."""
    return [f for f in model._meta.concrete_fields]


def export_csv(queryset: models.QuerySet, filename: str) -> StreamingHttpResponse:
    fields = concrete_columns(queryset.model)
    header = [str(f.verbose_name) for f in fields]
    attnames = [f.attname for f in fields]  # 'author_id', not 'author' -> no FK queries

    def rows() -> Iterable[list]:
        yield header
        # values_list swaps the iterable class: tuples, no Model.from_db()
        for row in queryset.values_list(*attnames).iterator(chunk_size=2000):
            yield list(row)

    writer = csv.writer(Echo())
    resp = StreamingHttpResponse((writer.writerow(r) for r in rows()), content_type="text/csv")
    resp["Content-Disposition"] = f'attachment; filename="{filename}"'
    return resp
```

Three internals are doing the work: `_meta.concrete_fields` gives a correct column list for *any* model (including inherited fields); `f.attname` uses the raw FK column so there is no descriptor access and no N+1; `values_list().iterator()` skips both model construction and the result cache, so memory stays flat for a million rows.

### 5.4 Real-world example 2: a custom field and a custom lookup

Fields and lookups plug into the same pipeline the compiler walks. A field controls Python ⇄ DB conversion; a lookup controls the WHERE fragment.

```python
# core/fields.py
from django.db import models
from django.db.models import Lookup


class LowercaseEmailField(models.EmailField):
    """Normalises on the way in; get_prep_value runs for saves AND for filter() values."""

    def get_prep_value(self, value):
        value = super().get_prep_value(value)
        return value.lower() if isinstance(value, str) else value


@models.CharField.register_lookup
class NotEqual(Lookup):
    lookup_name = "ne"

    def as_sql(self, compiler, connection):
        lhs, lhs_params = self.process_lhs(compiler, connection)
        rhs, rhs_params = self.process_rhs(compiler, connection)
        return f"{lhs} <> {rhs}", (*lhs_params, *rhs_params)
```

```python
# usage
from django.contrib.auth.models import User

User.objects.filter(username__ne="admin")
```

The generated SQL shows the lookup compiled in place, still parameterized:

```sql
SELECT ... FROM "auth_user" WHERE "auth_user"."username" <> %s
-- params: ('admin',)
```

Because `NotEqual.as_sql` returns params rather than formatting the value into the string, it inherits the ORM's SQL-injection safety. A vendor-specific variant would be an `as_postgresql(self, compiler, connection)` method — `compiler.compile()` picks it automatically.

### 5.5 Real-world example 3: a query-count budget without DEBUG

```python
# core/middleware.py
import logging
import time

from django.db import connection

log = logging.getLogger("perf")


class QueryBudgetMiddleware:
    """Counts SQL per request in production via connection.execute_wrapper (no DEBUG needed)."""

    BUDGET = 30

    def __init__(self, get_response):
        self.get_response = get_response  # called once, at load_middleware() time

    def __call__(self, request):
        stats = {"n": 0, "ms": 0.0}

        def counter(execute, sql, params, many, context):
            start = time.perf_counter()
            try:
                return execute(sql, params, many, context)
            finally:
                stats["n"] += 1
                stats["ms"] += (time.perf_counter() - start) * 1000

        with connection.execute_wrapper(counter):
            response = self.get_response(request)
        if stats["n"] > self.BUDGET:
            log.warning("query budget exceeded", extra={
                "path": request.path, "queries": stats["n"], "db_ms": round(stats["ms"], 1),
                "view": getattr(request.resolver_match, "view_name", None),
            })
        response["Server-Timing"] = f'db;dur={stats["ms"]:.1f};desc="{stats["n"]} queries"'
        return response
```

Note `request.resolver_match`: it is set by `resolve_request()` *inside* the chain, so it is available in the response phase of any middleware but not before `get_response()` is called. Also note that a streaming response's queries (inside the generator) run after this middleware returns — the wrapper misses them.

## 6. Advantages, Disadvantages & Trade-offs

| Design choice | What you gain | What it costs |
|---|---|---|
| Lazy settings | Import `settings` anywhere; tests swap settings with `override_settings` | Errors surface at first read, far from the cause; lower-case names silently ignored |
| Global app registry populated at startup | One source of truth for models; admin, migrations, contenttypes all introspect it | Import-order sensitivity; `AppRegistryNotReady`; slow startup for huge projects |
| Metaclass + `contribute_to_class` | Declarative models; fields self-register; generic tooling via `_meta` | "Magic" — attributes on the class are not what you wrote; hard to debug metaclass errors |
| Descriptors for relations | `book.author` reads like Python | Hidden queries (N+1), invisible in code review |
| Lazy, cloning QuerySets | Composable, reusable query fragments; no wasted queries | Every chain call allocates; easy to evaluate twice or not at all; cache surprises |
| Backend-neutral `Query` + per-vendor compilers | Portable ORM; vendor tweaks via `as_<vendor>` | Generated SQL is not always the SQL you'd write; some features PostgreSQL-only |
| Middleware compiled once at boot | Zero per-request setup cost | Settings changes need a reload; `__init__` side effects run once per process |
| Exceptions converted to responses per layer | Outer middleware always receives a response | Outer middleware can't `try/except` view errors — must use `process_exception` or signals |

### When to use (internals knowledge)

- Writing reusable apps, admin extensions, serializers or exporters that work across models → `_meta` APIs (`get_fields()`, `get_field()`, `concrete_fields`).
- Writing custom fields, lookups, transforms, expressions or database functions → the compiler protocol (`as_sql`, `as_<vendor>`, `resolve_expression`).
- Debugging import-time errors, query explosions, middleware ordering, connection leaks.
- Instrumenting production: `execute_wrapper`, `got_request_exception`, `request_started/finished`.

### When NOT to use

- Don't use private attributes (`qs.query.where`, `_state.fields_cache`, `_prefetched_objects_cache`) in application code — they change between releases. Read them in a debugger, not in features.
- Don't subclass `ModelBase` or monkeypatch the compiler to "fix" a query; write a custom `Func`/`Lookup` or use `RawSQL`/`raw()`.
- Don't add logic to `AppConfig.ready()` that queries the database — it runs during `migrate` on an empty DB and on every process start.

## 7. Common Mistakes & Best Practices

**1. Importing models at module import time of an app package.** People put `from .models import Book` in `shop/__init__.py` or `apps.py` top-level. Phase 1 imports app packages before `apps_ready`, so model class creation calls `get_containing_app_config()` too early → `AppRegistryNotReady`. Instead, import models inside `ready()` or inside functions:

```python
# shop/apps.py — before (breaks)
from django.apps import AppConfig
from .models import Book  # executed during Phase 1

# after
class ShopConfig(AppConfig):
    name = "shop"
    default_auto_field = "django.db.models.BigAutoField"

    def ready(self):
        from . import signals  # noqa: F401  (imports models safely; all models exist now)
```

**2. Lower-case or conditional settings.** `debug = True` in `settings.py` does nothing — only UPPERCASE names are copied. Similarly `if os.environ.get("X"): CACHES = ...` executed at import is fine, but reading `settings.X` at import time of *another* module freezes the value before `override_settings` can patch it. Read settings inside functions.

**3. Treating `str(qs.query)` as the executed SQL.** It interpolates params without quoting. Use `connection.queries` (DEBUG), `qs.explain(analyze=True)` on PostgreSQL, or the debug toolbar.

**4. Assuming chain methods mutate.** `qs.filter(active=True)` on its own line does nothing; QuerySets are immutable-by-clone. Assign the result: `qs = qs.filter(active=True)`.

**5. Accessing an FK object when you only need its id.** `if book.author.id == user.author_id` triggers a query; `book.author_id` doesn't. Same for serializers: `PrimaryKeyRelatedField` reads `author_id` only if you use `source="author_id"` or it can — prefer the attname.

**6. Filtering a prefetched relation.** `author.books.filter(genre="tech")` inside a loop ignores `_prefetched_objects_cache` and queries every time. Use `Prefetch("books", queryset=Book.objects.filter(genre="tech"), to_attr="tech_books")`.

**7. Expensive work in middleware `__init__`.** It runs once per process at `load_middleware()`, which is fine for config — but people expect it per request (it isn't) or do network calls there (slowing every worker boot, and failing boot when the dependency is down).

**8. Catching view exceptions with `try/except` around `get_response`.** Because each layer is wrapped by `convert_exception_to_response`, your `except` never fires — you get a 500 response. Use `process_exception(request, exception)` or the `got_request_exception` signal.

**9. Calling `django.setup()` inside a library or inside `ready()`.** Libraries shouldn't configure Django; `ready()` calling it triggers the reentrancy `RuntimeError`.

## 8. Production: Pitfalls, Debugging & Scaling

**Celery workers crash with `AppRegistryNotReady`.** *Symptom:* worker boot traceback. *Root cause:* `celery.py` imports a tasks module (which imports models) before `app.config_from_object("django.conf:settings", namespace="CELERY")` and the Django fixup has run setup, or a task module is imported at the top of `config/__init__.py`. *Fix:* set `DJANGO_SETTINGS_MODULE` first, create the `Celery` app, call `app.autodiscover_tasks()`; never import models at the top of `config/celery.py`.

**Memory growth in a long data migration or script.** *Symptom:* RSS climbs into gigabytes. *Root cause:* `DEBUG=True` makes every cursor a `CursorDebugWrapper` that logs queries into `connection.queries` (bounded, but still large), *and* iterating a giant QuerySet fills `_result_cache`. *Fix:* run with `DEBUG=False`, use `.iterator(chunk_size=...)`, call `django.db.reset_queries()` periodically if you must keep DEBUG.

**Queries "outside" requests leak connections.** *Symptom:* `FATAL: too many connections` from cron containers or threads. *Root cause:* `close_old_connections()` is wired to `request_started`/`request_finished`; scripts, threads and Celery tasks don't fire those signals, so `CONN_MAX_AGE` is never enforced. *Fix:* call `django.db.close_old_connections()` at the start/end of long-running loops; use `connection.close()` in threads you spawn; Celery's Django fixup handles this for tasks.

**Slow cold start on autoscaling.** *Symptom:* the first request of each new pod takes seconds. *Root cause:* `get_wsgi_application()` does `setup()` (imports every app's models) at import, but URLconf import, `load_middleware`, template engine setup and the first DB connection all happen lazily at the first request. *Fix:* warm up with a readiness probe that hits a cheap view that touches the URL resolver and DB; avoid heavy work at module import in `urls.py`.

**Middleware "doesn't run" for some responses.** *Root cause:* an earlier (outer) middleware short-circuited — e.g. `CommonMiddleware` returning an `APPEND_SLASH` redirect, `SecurityMiddleware` an HTTPS redirect, or `FetchFromCacheMiddleware` a cached response — so inner layers never saw the request. *Fix:* reason from `load_middleware`'s order: outer = earlier in the list.

**Debugging toolkit:**

```python
from django.db import connection, reset_queries
from django.test.utils import CaptureQueriesContext

with CaptureQueriesContext(connection) as ctx:     # works without DEBUG
    list(Book.objects.select_related("author")[:10])
print(len(ctx.captured_queries), ctx.captured_queries[0]["sql"])

print(Book.objects.filter(genre="tech").explain(analyze=True))  # PostgreSQL EXPLAIN ANALYZE

import logging
logging.getLogger("django.db.backends").setLevel(logging.DEBUG)  # logs SQL when DEBUG=True
```

```bash
python manage.py check --deploy          # system checks framework (registered in ready())
python -X importtime manage.py check 2> imports.log   # find slow app imports at startup
python manage.py shell -c "from django.apps import apps; print(len(apps.get_models()))"
```

**Scaling note.** Everything in this chapter is per-process: settings, the app registry, the compiled middleware chain, URL resolver caches (`get_resolver` is `functools.cache`d), template loaders. Horizontal scaling multiplies processes, so keep module-level state immutable and push shared state into the DB or cache.

## 9. Interview Questions

**Q: What happens, step by step, when Django starts up?**
A: The entry point (`manage.py`, `wsgi.py`, `asgi.py`) sets `DJANGO_SETTINGS_MODULE` and calls `django.setup()` (directly, or via `get_wsgi_application()`). The first settings read makes `LazySettings` import your settings module over `global_settings`. `setup()` configures logging, sets the script prefix and calls `apps.populate(INSTALLED_APPS)`, which runs three phases: create `AppConfig`s by importing app packages, import every `models` module (each class body runs `ModelBase`, which registers the model), then call every `AppConfig.ready()`. The handler is then constructed and `load_middleware()` compiles the middleware chain. The URLconf itself is imported lazily on the first request.

**Q: Why do you get `AppRegistryNotReady: Apps aren't loaded yet`, and how do you fix it?**
A: Something asked the app registry for models before population finished — usually a standalone script importing models before `django.setup()`, or an app's `__init__.py`/top-level `apps.py` importing `models` during phase 1. Model class creation needs `apps.get_containing_app_config()`, which requires `apps_ready`. Fix by calling `django.setup()` before model imports in scripts, using management commands instead of raw scripts, and moving model imports into `ready()` or function bodies. Using `apps.get_model("app", "Model")` at call time instead of import time also helps.

**Q: How is `django.conf.settings` implemented?**
A: It's a `LazySettings` instance, a `LazyObject` proxy whose `_wrapped` is empty until first attribute access. `_setup()` reads `DJANGO_SETTINGS_MODULE`, builds a `Settings` object from the uppercase names of `global_settings` and then your module, and `__getattr__` caches each value in the proxy's `__dict__`. `settings.configure()` is the manual alternative. Only uppercase names count, which is why `debug = True` silently does nothing. `override_settings` works by replacing `_wrapped` and sending `setting_changed`.

**Q: What does the `ModelBase` metaclass do when you define a model?**
A: It runs `ModelBase.__new__` at import time: separates attributes with `contribute_to_class` from plain ones, resolves `app_label`, creates `Options` as `_meta` from your `Meta`, creates `DoesNotExist`/`MultipleObjectsReturned`, calls `contribute_to_class` on every field and manager (which registers the field in `_meta` and installs a descriptor), handles abstract/MTI/proxy inheritance, adds an auto PK and a default `objects` manager in `_prepare()`, and finally calls `apps.register_model()`, which also resolves pending string references like `ForeignKey("shop.Author")`. That's why a model in a module that's never imported simply doesn't exist.

**Q: How does `book.author` know to run a query, and why doesn't `book.author_id`?**
A: `Book.author` on the class is a `ForwardManyToOneDescriptor`. Its `__get__` checks `book._state.fields_cache["author"]`, which `select_related` or a previous access fills; on a miss it runs a `get(pk=book.author_id)` and caches the result. `author_id` is the FK's attname — a plain column value stored in the instance `__dict__`, served by a `DeferredAttribute` without any query. This descriptor is exactly where the N+1 problem lives. Reverse relations use `ReverseManyToOneDescriptor`, which returns a related manager rather than an object.

**Q: Walk me through what happens when you call `Book.objects.filter(price__gt=20)` and then iterate it.**
A: `Book.objects` is a `ManagerDescriptor` returning the manager; `get_queryset()` creates a `QuerySet` wrapping a fresh `sql.Query`. `filter()` clones the QuerySet (`_chain()`), and `Query.add_q()` → `build_filter()` resolves `price__gt` into a `GreaterThan(Col(price), 20)` lookup in the `WhereNode`, adding joins to `alias_map` if relations are spanned. No SQL runs. Iteration calls `_fetch_all()`, which runs `ModelIterable`: `query.get_compiler(using)` picks the backend's `SQLCompiler`, `as_sql()` produces `(sql, params)`, `execute_sql()` runs the cursor and fetches rows in chunks, and each row becomes an instance via `Model.from_db()`. The list is stored in `_result_cache` and prefetches run afterwards.

**Q: What is the difference between `str(queryset.query)` and the SQL actually executed?**
A: `str(query)` calls `sql_with_params()` and then does plain `%` interpolation for display, so string params appear unquoted and types may render differently; it can even be invalid SQL. The executed statement keeps placeholders and passes params separately to the driver, which handles quoting and escaping — that's the ORM's SQL-injection protection. To see the real thing use `connection.queries`, `CaptureQueriesContext`, the debug toolbar or `explain()`. Interviewers ask this to see whether you understand parameterization.

**Q: In what order do middleware run, and how does Django implement that?**
A: Request phase runs top to bottom of `MIDDLEWARE`; response phase bottom to top. `load_middleware()` iterates `reversed(MIDDLEWARE)`, instantiating each class with the handler built so far, so the first entry becomes the outermost wrapper. `process_view` hooks are inserted at position 0 (top-to-bottom), and `process_exception`/`process_template_response` hooks are appended (bottom-to-top). Any middleware that returns a response from `__call__` without calling `get_response` short-circuits all inner layers and the view.

**Q: Why can't a middleware catch a view's exception with try/except around `get_response`? (Senior)**
A: Because `load_middleware()` wraps every layer — and the innermost `_get_response` — with `convert_exception_to_response`. When the view raises, the `process_exception` hooks get a chance, and if none returns a response, the wrapper calls `response_for_exception()`, turning `Http404` into a 404, `PermissionDenied` into 403, `SuspiciousOperation` into 400 and anything else into a 500 response (sending `got_request_exception`). So the outer layer receives an `HttpResponse` with a status code, never the exception. To act on exceptions, implement `process_exception`, connect to `got_request_exception`, or inspect `response.status_code`. This design guarantees every middleware's response phase runs even when a view crashes.

**Q: What happens internally when you call `save()` on a model instance? (Senior)**
A: `save()` → `save_base()` sends `pre_save`, saves MTI parents, then `_save_table()`. If the PK is set and not forced, it tries an UPDATE via `SQLUpdateCompiler`; zero affected rows makes it fall back to an INSERT via `SQLInsertCompiler` (with `RETURNING` on PostgreSQL). If `_state.adding` is true and the PK has a default (like a UUID), it skips the UPDATE attempt and inserts directly. It then sets `_state.adding = False` and `_state.db`, and sends `post_save` with `created`. It never calls `full_clean()`, and `update_fields` limits the columns — important for avoiding lost updates when two processes save different fields of the same row.

**Q: How would you add database-specific SQL for a custom expression without breaking other backends? (Senior)**
A: Subclass `Func` (or `Lookup`/`Transform`) and implement `as_sql()` as the portable default, then add `as_postgresql(self, compiler, connection)` or `as_sqlite` for vendor variants. `SQLCompiler.compile(node)` looks for `as_<connection.vendor>` first and falls back to `as_sql`. Always return SQL with placeholders and a params tuple; never format values into the string. For lookups, register them on the field class with `register_lookup`. This is the same mechanism Django's built-in functions use to cover vendor differences.

**Q: How do the ORM's connections behave across threads and async code, and what leaks? (Senior)**
A: `connections` is a `ConnectionHandler` storing one `DatabaseWrapper` per alias in an `asgiref` `Local`, so each thread (or thread-sensitive async context) has its own connection, opened lazily on first cursor. Lifetime management (`CONN_MAX_AGE`, `CONN_HEALTH_CHECKS`) is enforced by `close_old_connections()`, connected to `request_started` and `request_finished`. Threads you spawn, scripts and custom daemons don't emit those signals, so their connections live until the process dies or the server drops them — then you get "connection already closed" errors or connection exhaustion. Call `close_old_connections()` around units of work, and close connections when threads finish. Under ASGI the sync ORM runs on the thread-sensitive executor, so async views share one thread's connection.

**Q: Where should you connect signals and why not in `models.py`? (Senior)**
A: In `AppConfig.ready()`, typically by importing a `signals` module there. `ready()` runs in phase 3, after every model in every app is registered, so receivers can reference any model by class. Connecting at import time of `models.py` works by accident but can register twice if the module is imported under two paths, and it couples model import to side effects; `dispatch_uid` guards duplicates. `ready()` may run more than once in tests, so keep it idempotent and never query the database there — it also runs during `migrate` on an empty schema.

**Q: Why are QuerySets lazy, and what triggers evaluation?**
A: Laziness lets you compose queries across functions — a manager method adds a filter, the view adds ordering, the paginator adds LIMIT — and run exactly one query at the end. Each chain method returns a clone with a modified `Query`; nothing hits the DB until `_fetch_all()` runs. Iteration, `len()`, `list()`, `bool()`, `repr()`, pickling and slicing with a step evaluate; plain slicing adds LIMIT/OFFSET lazily. `count()`, `exists()`, `aggregate()`, `get()`, `first()` run their own queries immediately. The result cache lives on that QuerySet instance only.

**Q: How do `prefetch_related` results get attached to instances?**
A: After the main query fills `_result_cache`, `_prefetch_related_objects()` calls `prefetch_related_objects()`, which, per lookup, asks the descriptor's manager for `get_prefetch_querysets()` (5.0+, previously `get_prefetch_queryset`), runs one `WHERE fk IN (...)` query, groups rows in Python by key and stores each group in `instance._prefetched_objects_cache[name]` (or on `to_attr`). The related manager's `get_queryset()` checks that cache first. That's why `.all()` is free afterwards but `.filter()` re-queries — it builds a new query instead of reading the cache.

**Q: What's the difference between a Manager and a QuerySet internally?**
A: `Manager` is `BaseManager.from_queryset(QuerySet)` — a class generated by copying QuerySet's public methods onto the manager as proxies that call `self.get_queryset().<method>()`. The manager is attached to the model class via `contribute_to_class` and guarded by `ManagerDescriptor`, which blocks instance access. A QuerySet holds state (query, result cache); a manager holds none beyond its model and database hints. `from_queryset` or `QuerySet.as_manager()` is how custom QuerySet methods become chainable from `objects`.

## 10. Quick Revision & Cheat Sheet

| Machine | Key class / function | Happens when | Classic error |
|---|---|---|---|
| Settings | `LazySettings._setup()` | First attribute read | `ImproperlyConfigured: settings are not configured` |
| Setup | `django.setup()` → `apps.populate()` | Entry point boot | `AppRegistryNotReady`, `populate() isn't reentrant` |
| Model class | `ModelBase.__new__`, `Options`, `contribute_to_class` | `models.py` import (phase 2) | "doesn't declare an explicit app_label" |
| Attribute access | `DeferredAttribute`, `ForwardManyToOneDescriptor`, related managers | `instance.attr` | N+1 queries, deferred-field queries |
| Query build | `QuerySet._chain()`, `Query.add_q()`, `build_filter()` | Each chain call | `FieldError: Cannot resolve keyword` |
| Query run | `_fetch_all()`, `get_compiler()`, `as_sql()`, `execute_sql()`, `ModelIterable` | Evaluation | Evaluating twice, huge `_result_cache` |
| Save | `save_base()`, `_save_table()`, `_do_update`/`_do_insert` | `save()` | Lost updates without `update_fields` |
| Request | `WSGIHandler`, `load_middleware()`, `get_response()` | Boot / per request | Wrong middleware order, swallowed exceptions |

- Settings: only UPPERCASE names are read; values are cached on first access.
- `populate()` = app configs → models → `ready()`. Never import models in an app's `__init__.py`.
- A model exists only if its module is imported during phase 2.
- `_meta` is the public introspection API: `get_fields()`, `get_field()`, `concrete_fields`, `label`.
- Relation access is a descriptor; `fields_cache` (select_related) and `_prefetched_objects_cache` (prefetch) are the two caches it checks.
- Every chain method clones; SQL is built only in `SQLCompiler.as_sql()` at evaluation.
- `str(qs.query)` is for eyes only; params are sent separately.
- First in `MIDDLEWARE` = outermost; each layer is wrapped by `convert_exception_to_response`.
- Connections are per thread; lifetime is managed by request signals only.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" && django-admin startproject lab . && python manage.py startapp shop`.

1. **Break startup on purpose.** Write `scripts/peek.py` that imports `shop.models` before `django.setup()`; read the traceback and find `check_apps_ready` in it. Then add `from .models import Book` to `shop/__init__.py` and observe the same error from `runserver`. Fix both.
2. **Trace the metaclass.** In `shop/models.py`, connect a `class_prepared` receiver (defined above the models) that prints `sender._meta.label` and `[f.attname for f in sender._meta.concrete_fields]`. Run `manage.py check` and note the order models are prepared in.
3. **Walk a Query.** In the shell, build `Book.objects.filter(author__name__startswith="A").exclude(price__lt=10).order_by("title")[10:20]`. Print `qs.query.alias_map`, `qs.query.where`, `qs.query.low_mark/high_mark`, then `qs.query.get_compiler("default").as_sql()`. Compare with `str(qs.query)`.
4. **Catch the descriptor.** Use `CaptureQueriesContext` to count queries for `[b.author.name for b in Book.objects.all()[:20]]`, then with `select_related("author")`. Inspect `b._state.fields_cache` in both cases.
5. **Write a lookup.** Implement and register the `ne` lookup from §5.4 plus an `as_sqlite` variant that prints a marker comment; confirm `compiler.compile()` picks the vendor method on SQLite.
6. **Middleware ordering lab.** Write two middleware classes that print on request and response, plus `process_view` and `process_exception`. Put them in both orders, raise `Http404` and `ValueError` in a view, and draw the printed sequence; then add a `try/except` around `get_response` and prove it never catches.

**Mini project — "django-introspect" management command:** `python manage.py introspect` prints, for every installed model, its table, PK type, every relation with the descriptor class installed on each side, the default manager, indexes and constraints — and, with `--sql "shop.Book"`, compiles a sample `.all()[:1]` through `get_compiler()` and prints the SQL and params. Add a `QueryBudgetMiddleware` (§5.5) and a test using `assertNumQueries` that fails when a view exceeds its budget.

## 12. Related Topics & Free Learning Resources

**Sibling chapters**
- [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle) — the user-level view of the request flow.
- [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings) — `INSTALLED_APPS`, `AppConfig.ready`, settings layout.
- [Ch 08 · Models & Fields](topic.html?p=08-models-fields) and [Ch 09 · Relationships](topic.html?p=09-relationships) — what the metaclass and descriptors are building.
- [Ch 10 · QuerySets, Lookups, Q & F Expressions](topic.html?p=10-querysets-lookups) — laziness and evaluation from the user's side.
- [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization) — fixing what descriptors cause.
- [Ch 15 · Custom Managers, QuerySets & Model Inheritance](topic.html?p=15-managers-model-inheritance) — `from_queryset`, MTI parent links.
- [Ch 18 · Middleware](topic.html?p=18-middleware) — writing middleware on top of `load_middleware`.
- [Ch 19 · Signals](topic.html?p=19-signals) — `class_prepared`, `request_started`, receivers in `ready()`.
- [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi) and [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases) — the async handler and connection management.
- [Ch 37 · Most-Asked Django Interview Questions: Core & ORM](topic.html?p=37-interview-core-orm) — rapid-fire practice on these internals.

**Other handbooks**
- [SQL · Execution Plans](../sql/topic.html?p=22-execution-plans) — reading what `explain()` returns.
- [Database Design · Database Application Architecture](../database-design/topic.html?p=20-database-application-architecture) — ORMs, connection handling and the app/DB boundary.

**Free resources**
- **Django source code** — GitHub · *Advanced* · `django/db/models/base.py`, `sql/query.py`, `sql/compiler.py` and `core/handlers/base.py` are surprisingly readable. https://github.com/django/django
- **Applications (the app registry)** — Django docs · *Intermediate* · `AppConfig`, `ready()`, and the population process. https://docs.djangoproject.com/en/5.2/ref/applications/
- **Model `_meta` API** — Django docs · *Intermediate* · the supported introspection surface. https://docs.djangoproject.com/en/5.2/ref/models/meta/
- **How to write custom lookups** — Django docs · *Advanced* · the compiler protocol in practice. https://docs.djangoproject.com/en/5.2/howto/custom-lookups/
- **How to create custom model fields** — Django docs · *Advanced* · `contribute_to_class`, `from_db_value`, `get_prep_value`. https://docs.djangoproject.com/en/5.2/howto/custom-model-fields/
- **Middleware** — Django docs · *Intermediate* · official semantics of ordering, hooks and async support. https://docs.djangoproject.com/en/5.2/topics/http/middleware/
- **Database instrumentation** — Django docs · *Advanced* · `execute_wrapper` for production query metrics. https://docs.djangoproject.com/en/5.2/topics/db/instrumentation/

---

*Django Handbook — chapter 36.*
