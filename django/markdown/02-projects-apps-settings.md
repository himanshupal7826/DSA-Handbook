# 02 · Projects, Apps & Settings

> **In one line:** A Django *project* is configuration — settings, the root URLconf and the WSGI/ASGI entry points — while *apps* are reusable units of models, views and commands that the project activates through `INSTALLED_APPS`; understanding how settings load lazily and how the app registry boots is what lets you structure large codebases, keep secrets out of git, and avoid the classic `AppRegistryNotReady` and "works on my machine" failures.

---

## 1. Overview

> **Builds on:** [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle) — where `wsgi.py` calls `django.setup()` before the first request.

The first two commands anyone runs in Django are `django-admin startproject` and `python manage.py startapp`, and the first interview question about them is: *"What is the difference between a project and an app?"* It sounds trivial, but the answer exposes whether you understand how Django is assembled at runtime.

The underlying problem is configuration and modularity. A real backend has dozens of settings that differ between a developer laptop, CI, staging and production: database URLs, secret keys, cache servers, allowed hosts, email backends, feature flags. It also has many feature areas — accounts, catalogue, orders, billing — that should be separable, testable and sometimes reusable across projects.

The **naive approaches** both fail. Hard-coding settings in one `settings.py` and editing it per environment means the production `SECRET_KEY` ends up in git, a developer accidentally ships `DEBUG=True`, and nobody knows which config is live. Putting all models and views in one giant app means circular imports, 3,000-line `models.py` files, and migrations nobody can reason about.

Django's answer has three parts:

1. **Projects vs apps.** The project is the container of configuration; apps are Python packages that contribute models, views, templates, static files, admin registrations, signals and management commands. A project activates apps by listing them in `INSTALLED_APPS`.
2. **The app registry.** At startup `django.setup()` imports every installed app in a defined order, builds a registry (`django.apps.apps`) of `AppConfig` objects and models, and then calls each app's `ready()` hook. Almost everything — the ORM, admin autodiscovery, signal receivers, template loaders — depends on this registry being ready.
3. **Lazy settings.** `django.conf.settings` is a lazy proxy that loads the module named by `DJANGO_SETTINGS_MODULE` the first time any setting is read, layered on top of Django's defaults in `django.conf.global_settings`. Because the settings module is just Python, you can read environment variables, split by environment, and validate at import time.

Finally, `manage.py` is the project's command-line front door, and **custom management commands** are how you run operational jobs — backfills, cleanups, imports — with the full Django environment loaded.

## 2. Core Concepts

- **Project** — the directory created by `startproject`: `manage.py` plus a configuration package with `settings.py`, `urls.py`, `wsgi.py`, `asgi.py`. *Why it matters:* it is deployment-specific glue, not where business logic lives.
- **App** — a Python package with an `apps.py` (`AppConfig`) and usually `models.py`, `views.py`, `admin.py`, `migrations/`, `templates/`, `static/`, `management/commands/`. *Why it matters:* the unit of models, migrations and reuse; migrations are per app.
- **`INSTALLED_APPS`** — the ordered list of app configs or packages the project activates. *Why it matters:* only installed apps get their models registered, migrations run, templates and static files discovered and commands exposed; **order matters** for template, static and command overrides.
- **`AppConfig`** — the class describing an app: `name` (full dotted path), `label` (short unique name, default last component of `name`), `verbose_name`, `default_auto_field`, and the `ready()` hook. Since Django 3.2 it is discovered automatically from `apps.py`.
- **App registry (`django.apps.apps`)** — the global object holding every `AppConfig` and model. `apps.get_model("orders", "Order")` looks models up by label. *Why it matters:* accessing models before it is ready raises `AppRegistryNotReady`.
- **`ready()`** — called once per process after all models are loaded. The place to connect signal receivers, register checks and import modules for their side effects. *Why it matters:* the documented home for signal registration.
- **`DJANGO_SETTINGS_MODULE`** — the environment variable naming the settings module (`config.settings.prod`). `manage.py`, `wsgi.py` and `asgi.py` set a default with `os.environ.setdefault`.
- **`LazySettings`** — the `LazyObject` behind `django.conf.settings`; it builds a `Settings` instance on first attribute access. *Why it matters:* you must import `from django.conf import settings`, never the settings module directly.
- **`global_settings`** — Django's defaults for every setting; your module only overrides what it changes. `manage.py diffsettings` prints the differences.
- **Environment variables / twelve-factor config** — keeping secrets and per-environment values outside the code, read at startup. *Why it matters:* no secrets in git; the same image runs everywhere.
- **`SECRET_KEY` and `SECRET_KEY_FALLBACKS`** — the key used for signing (sessions with signed cookies, password reset tokens, `signing`, messages). Fallbacks (4.1+) let you rotate keys without invalidating every signed value at once.
- **`manage.py` / `django-admin`** — command-line utilities; `manage.py` is `django-admin` with `DJANGO_SETTINGS_MODULE` preset and the project on `sys.path`.
- **Management command** — a `BaseCommand` subclass in `<app>/management/commands/<name>.py`, run as `python manage.py <name>`. *Why it matters:* the standard way to script operational jobs with the ORM available.
- **System checks** — the framework (`manage.py check`, `check --deploy`) that validates models, settings and security configuration; runs automatically before most commands.

## 3. Theory & Principles

### 3.1 Project vs app, precisely

Django's docs define it crisply: *an app is a web application that does something; a project is a collection of configuration and apps for a particular website.* A project can contain many apps; an app can be in many projects. `django.contrib.auth` is an app; so is `rest_framework`; so is your `orders` package.

What makes a package an app is **not** its folder structure but its presence in `INSTALLED_APPS`. Once listed, Django will:

- import its `models` module and register every model class with the registry;
- include its `migrations/` in the migration graph;
- search its `templates/` directory (when `APP_DIRS=True`) and `static/` directory (via `AppDirectoriesFinder`);
- expose its `management/commands/*.py` as commands;
- autodiscover its `admin.py` (through `django.contrib.admin`'s `ready()`);
- call its `AppConfig.ready()`.

### 3.2 How the app registry boots: `apps.populate()`

`django.setup()` configures logging from `LOGGING`, sets the URL script prefix, and calls `apps.populate(settings.INSTALLED_APPS)`. Populate runs in three strict phases, and each phase completes for **all** apps before the next begins:

1. **Import app configs.** For each entry, import the package (or the dotted `AppConfig` path), find its `AppConfig` — the single subclass in `apps.py`, the one marked `default = True` if there are several, or a plain `AppConfig` otherwise — and instantiate it. Labels must be unique, or you get `ImproperlyConfigured: Application labels aren't unique`. After this phase `apps.apps_ready` is true.
2. **Import models.** For each app config, import its `models` module. Defining a model class runs the `ModelBase` metaclass, which calls `apps.register_model()`. After this phase `apps.models_ready` is true and relations between models (string references such as `"orders.Order"`) can be resolved.
3. **Run `ready()`.** Call each `AppConfig.ready()` in `INSTALLED_APPS` order. Then `apps.ready` is true.

If code tries to use models during phase 1 or 2 — for example a module-level `get_user_model()` call in an app's `__init__.py`, or importing `models` from another app's `apps.py` at module level — Django raises `AppRegistryNotReady: Apps aren't loaded yet.` (or `Models aren't loaded yet.`). The fix is always the same: move the import inside a function or into `ready()`.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj02a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">django.setup() and apps.populate(): three phases, each over ALL apps</text>
  <rect x="20" y="44" width="180" height="70" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="110" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">django.setup()</text>
  <text x="110" y="84" text-anchor="middle" fill="#334155" font-size="9">read settings (lazy load)</text>
  <text x="110" y="98" text-anchor="middle" fill="#334155" font-size="9">configure LOGGING</text>
  <path d="M200,79 L236,79" stroke="#2563eb" stroke-width="2" marker-end="url(#dj02a)"/>
  <rect x="240" y="44" width="190" height="150" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="335" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Phase 1: app configs</text>
  <text x="252" y="88" fill="#334155" font-size="10">import each package</text>
  <text x="252" y="106" fill="#334155" font-size="10">find AppConfig in apps.py</text>
  <text x="252" y="124" fill="#334155" font-size="10">check labels are unique</text>
  <text x="252" y="148" fill="#1d4ed8" font-size="10" font-weight="bold">apps_ready = True</text>
  <text x="252" y="172" fill="#dc2626" font-size="9">models not usable yet</text>
  <path d="M430,119 L466,119" stroke="#2563eb" stroke-width="2" marker-end="url(#dj02a)"/>
  <rect x="470" y="44" width="190" height="150" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="565" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Phase 2: models</text>
  <text x="482" y="88" fill="#334155" font-size="10">import app.models</text>
  <text x="482" y="106" fill="#334155" font-size="10">ModelBase metaclass runs</text>
  <text x="482" y="124" fill="#334155" font-size="10">apps.register_model()</text>
  <text x="482" y="148" fill="#6d28d9" font-size="10" font-weight="bold">models_ready = True</text>
  <text x="482" y="172" fill="#334155" font-size="9">lazy relations resolved</text>
  <path d="M660,119 L696,119" stroke="#2563eb" stroke-width="2" marker-end="url(#dj02a)"/>
  <rect x="700" y="44" width="160" height="150" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="780" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">Phase 3: ready()</text>
  <text x="712" y="88" fill="#334155" font-size="10">AppConfig.ready() in</text>
  <text x="712" y="104" fill="#334155" font-size="10">INSTALLED_APPS order</text>
  <text x="712" y="122" fill="#334155" font-size="10">connect signals, checks</text>
  <text x="712" y="148" fill="#15803d" font-size="10" font-weight="bold">apps.ready = True</text>
  <text x="712" y="172" fill="#334155" font-size="9">no DB queries here</text>
  <rect x="20" y="220" width="840" height="140" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="440" y="242" text-anchor="middle" fill="#1e293b" font-weight="bold">Where AppRegistryNotReady comes from</text>
  <text x="40" y="266" fill="#334155" font-size="10">orders/__init__.py:   from .models import Order      runs in phase 1, before models are ready</text>
  <text x="40" y="286" fill="#334155" font-size="10">accounts/apps.py:     User = get_user_model()       at module level, phase 1</text>
  <text x="40" y="306" fill="#334155" font-size="10">script.py:            from orders.models import Order   without django.setup() first</text>
  <text x="40" y="332" fill="#15803d" font-size="10" font-weight="bold">Fix: import inside functions or ready(); standalone scripts call django.setup() or use a management command</text>
</svg>
```

### 3.3 How settings load: `LazySettings`

`django/conf/__init__.py` defines `settings = LazySettings()`. `LazySettings` is a `LazyObject`: until something reads an attribute, it holds nothing. On the first access (`settings.DEBUG`), `_setup()` reads `os.environ["DJANGO_SETTINGS_MODULE"]` — raising `ImproperlyConfigured: Requested setting DEBUG, but settings are not configured` if it is missing — and constructs `Settings(module_name)`:

1. Copy every UPPERCASE name from `django.conf.global_settings` (the defaults).
2. `importlib.import_module(module_name)` — your settings file executes now, top to bottom.
3. Copy every UPPERCASE name from your module, overriding the defaults. Lowercase names are ignored, which is why helper variables like `env = environ.Env()` don't leak into `settings`.
4. Validate a few things (for example tuple/list types for some settings) and remember which settings were explicitly set (used by `diffsettings`).

Two consequences matter in interviews. First, **importing your settings module directly** (`from config import settings`) bypasses this: you skip defaults, you bypass `override_settings` in tests, and you can import the wrong environment's module. Always use `from django.conf import settings`. Second, settings are read **once per process**. Changing an environment variable after boot does nothing until workers restart.

For scripts without a settings module (rare — mostly libraries' test suites), `settings.configure(DEBUG=True, ...)` populates settings directly, followed by `django.setup()`.

```svg
<svg viewBox="0 0 880 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj02b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">From environment to settings.DEBUG: layered, lazy, once per process</text>
  <rect x="20" y="46" width="200" height="74" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="120" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">Process environment</text>
  <text x="120" y="86" text-anchor="middle" fill="#334155" font-size="9">DJANGO_SETTINGS_MODULE=</text>
  <text x="120" y="100" text-anchor="middle" fill="#334155" font-size="9">config.settings.prod</text>
  <text x="120" y="114" text-anchor="middle" fill="#334155" font-size="9">DATABASE_URL, SECRET_KEY ...</text>
  <rect x="260" y="46" width="200" height="74" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="360" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">first settings.X access</text>
  <text x="360" y="86" text-anchor="middle" fill="#334155" font-size="9">LazySettings._setup()</text>
  <text x="360" y="100" text-anchor="middle" fill="#334155" font-size="9">Settings(module_name)</text>
  <path d="M220,83 L256,83" stroke="#2563eb" stroke-width="2" marker-end="url(#dj02b)"/>
  <rect x="500" y="46" width="360" height="74" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="680" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">django.conf.settings (the proxy you import)</text>
  <text x="680" y="88" text-anchor="middle" fill="#334155" font-size="9">UPPERCASE names only; cached for the process lifetime</text>
  <text x="680" y="104" text-anchor="middle" fill="#334155" font-size="9">override_settings swaps the wrapped object in tests</text>
  <path d="M460,83 L496,83" stroke="#2563eb" stroke-width="2" marker-end="url(#dj02b)"/>
  <text x="440" y="150" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="bold">Layers merged inside Settings (later wins)</text>
  <rect x="60" y="164" width="240" height="140" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="180" y="186" text-anchor="middle" fill="#1e293b" font-weight="bold">1. global_settings</text>
  <text x="76" y="208" fill="#334155" font-size="10">DEBUG = False</text>
  <text x="76" y="226" fill="#334155" font-size="10">ALLOWED_HOSTS = []</text>
  <text x="76" y="244" fill="#334155" font-size="10">SESSION_COOKIE_AGE = 1209600</text>
  <text x="76" y="262" fill="#334155" font-size="10">every setting has a default</text>
  <rect x="320" y="164" width="240" height="140" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="440" y="186" text-anchor="middle" fill="#1e293b" font-weight="bold">2. settings/base.py</text>
  <text x="336" y="208" fill="#334155" font-size="10">INSTALLED_APPS, MIDDLEWARE</text>
  <text x="336" y="226" fill="#334155" font-size="10">TEMPLATES, AUTH_USER_MODEL</text>
  <text x="336" y="244" fill="#334155" font-size="10">shared by every environment</text>
  <rect x="580" y="164" width="240" height="140" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="700" y="186" text-anchor="middle" fill="#1e293b" font-weight="bold">3. settings/prod.py</text>
  <text x="596" y="208" fill="#334155" font-size="10">from .base import *</text>
  <text x="596" y="226" fill="#334155" font-size="10">SECRET_KEY = env("SECRET_KEY")</text>
  <text x="596" y="244" fill="#334155" font-size="10">DATABASES from DATABASE_URL</text>
  <text x="596" y="262" fill="#334155" font-size="10">HTTPS, HSTS, cookie flags</text>
  <path d="M300,234 L316,234" stroke="#2563eb" stroke-width="2" marker-end="url(#dj02b)"/>
  <path d="M560,234 L576,234" stroke="#2563eb" stroke-width="2" marker-end="url(#dj02b)"/>
</svg>
```

### 3.4 What `manage.py` actually does

`manage.py` is five meaningful lines: set a default `DJANGO_SETTINGS_MODULE`, then `execute_from_command_line(sys.argv)`. That creates a `ManagementUtility`, which:

1. parses `--settings` and `--pythonpath` early (so they apply before setup);
2. calls `django.setup()`;
3. builds the command map with `get_commands()` — Django's built-in commands, then each installed app's `management/commands/` scanned **in reverse `INSTALLED_APPS` order**, so an app listed earlier overrides a same-named command from an app listed later (this is how `django.contrib.staticfiles` overrides `runserver`);
4. loads the command class and calls `run_from_argv()` → `execute()` → system checks (unless `requires_system_checks = []`) → your `handle()`.

`django-admin` is the same utility without the preset settings module, which is why `django-admin migrate` fails with "settings are not configured" unless you pass `--settings` or export the variable.

### 3.5 Order in `INSTALLED_APPS` is behaviour

Because the registry and finders walk `INSTALLED_APPS` in order:

- **Templates:** the `app_directories` loader returns the *first* matching template, so putting your app above `django.contrib.admin` lets you override `admin/base_site.html`.
- **Static files:** `AppDirectoriesFinder` also takes the first match.
- **Commands:** first-listed app wins (see above).
- **`ready()`:** runs in order, so an app relying on another's `ready()` side effects must come after it.

## 4. Architecture & Workflow

### 4.1 Recommended layout for a real project

```text
repo/
├── manage.py
├── pyproject.toml
├── config/                     # the "project" package: configuration only
│   ├── __init__.py
│   ├── settings/
│   │   ├── __init__.py
│   │   ├── base.py             # shared, no secrets
│   │   ├── dev.py              # DEBUG, debug toolbar, console email
│   │   ├── test.py             # fast hasher, in-memory email
│   │   └── prod.py             # security headers, real services
│   ├── urls.py                 # ROOT_URLCONF
│   ├── wsgi.py
│   └── asgi.py
└── apps/                       # domain apps, one per bounded area
    ├── accounts/               # custom user model lives here (day one)
    ├── catalog/
    ├── orders/
    │   ├── apps.py
    │   ├── models.py
    │   ├── services.py         # business logic, called by views/commands/tasks
    │   ├── views.py
    │   ├── urls.py
    │   ├── admin.py
    │   ├── signals.py
    │   ├── migrations/
    │   ├── management/commands/expire_unpaid_orders.py
    │   ├── templates/orders/...
    │   └── tests/
    └── core/                   # shared utilities, base models, middleware
```

Two layouts are common for settings: **a settings package split by environment** (shown above, selected by `DJANGO_SETTINGS_MODULE`) or **a single settings module driven entirely by environment variables** (twelve-factor style, `DEBUG=env.bool("DEBUG", False)`). The split works well when environments differ structurally (dev adds the debug toolbar to `INSTALLED_APPS`); the single file works well when every difference is a value. Many teams combine them: `base.py` reads env vars for values, and `dev.py`/`prod.py` hold only structural differences.

### 4.2 Startup to first request

```text
gunicorn config.wsgi:application
   │
   ├─ import config.wsgi
   │     os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings.prod")
   │     get_wsgi_application()
   │        ├─ django.setup()
   │        │     ├─ settings._setup()          -> import config.settings.prod (reads env vars)
   │        │     ├─ logging.config.dictConfig(LOGGING)
   │        │     └─ apps.populate(INSTALLED_APPS)
   │        │           ├─ phase 1: AppConfigs
   │        │           ├─ phase 2: models
   │        │           └─ phase 3: ready()  -> signals connected, admin autodiscovered
   │        └─ WSGIHandler()  -> load_middleware()
   └─ fork workers (or with --preload: load once, then fork)
```

With Gunicorn's `--preload`, the app is imported in the master and workers are forked from it — faster boot and shared memory pages, but database connections or threads opened during import would be shared by forked children, which is another reason not to touch the database in `ready()`.

## 5. Implementation

### 5.1 Simple example: a project with one app

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2"
django-admin startproject config .      # trailing dot: no extra nesting
python manage.py startapp blog
```

```python
# blog/apps.py (generated)
from django.apps import AppConfig

class BlogConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "blog"
```

Add the app to the project. Listing the package name is enough since Django 3.2; the single `AppConfig` subclass in `apps.py` is picked up automatically.

```python
# config/settings.py (excerpt)
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "blog",                       # or "blog.apps.BlogConfig"
]
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
```

Check what you changed relative to Django's defaults:

```bash
python manage.py diffsettings          # settings that differ from global_settings; "###" marks names Django has no default for
python manage.py check                 # system checks
python manage.py shell -c "from django.apps import apps; print([a.label for a in apps.get_app_configs()])"
```

```text
['admin', 'auth', 'contenttypes', 'sessions', 'messages', 'staticfiles', 'blog']
```

### 5.2 Registering signals in `ready()`

```python
# orders/apps.py
from django.apps import AppConfig

class OrdersConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "apps.orders"
    label = "orders"              # keeps table names orders_order, and "orders.Order" references
    verbose_name = "Orders"

    def ready(self):
        # Imported for side effects: @receiver decorators connect handlers.
        from . import signals  # noqa: F401
```

```python
# orders/signals.py
from django.db.models.signals import post_save
from django.dispatch import receiver
from .models import Order

@receiver(post_save, sender=Order, dispatch_uid="orders.order_created_audit")
def audit_order_created(sender, instance, created, **kwargs):
    if created:
        ...
```

`dispatch_uid` makes the connection idempotent: Django's docs note `ready()` may run more than once in some test setups, and without a unique ID you would get duplicate receivers. Signals in depth are in [Ch 19 · Signals](topic.html?p=19-signals).

### 5.3 Real-world example: environment-driven settings

This settings package keeps secrets out of git, fails fast when a required variable is missing, and keeps per-environment differences small. It uses `django-environ`, but `python-decouple` or plain `os.environ` work the same way.

```python
# config/settings/base.py
from pathlib import Path
import environ

BASE_DIR = Path(__file__).resolve().parent.parent.parent
env = environ.Env()
environ.Env.read_env(BASE_DIR / ".env", overwrite=False)   # dev convenience; real envs set vars

SECRET_KEY = env("SECRET_KEY")                       # no default: crash if missing
SECRET_KEY_FALLBACKS = env.list("SECRET_KEY_FALLBACKS", default=[])
DEBUG = env.bool("DEBUG", default=False)            # default to the safe value
ALLOWED_HOSTS = env.list("ALLOWED_HOSTS", default=[])

INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    "apps.accounts",
    "apps.catalog",
    "apps.orders",
    "apps.core",
]
AUTH_USER_MODEL = "accounts.User"                    # set before the first migrate

DATABASES = {"default": env.db("DATABASE_URL")}     # postgres://user:pass@host:5432/db
DATABASES["default"]["CONN_MAX_AGE"] = env.int("DB_CONN_MAX_AGE", default=60)
DATABASES["default"]["CONN_HEALTH_CHECKS"] = True

CACHES = {
    "default": {
        "BACKEND": "django.core.cache.backends.redis.RedisCache",
        "LOCATION": env("REDIS_URL", default="redis://localhost:6379/0"),
    }
}

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
TIME_ZONE = "UTC"
USE_TZ = True
```

```python
# config/settings/dev.py
from .base import *  # noqa: F401,F403

DEBUG = True
ALLOWED_HOSTS = ["localhost", "127.0.0.1"]
INSTALLED_APPS += ["debug_toolbar"]
MIDDLEWARE = ["debug_toolbar.middleware.DebugToolbarMiddleware", *MIDDLEWARE]
INTERNAL_IPS = ["127.0.0.1"]
EMAIL_BACKEND = "django.core.mail.backends.console.EmailBackend"
```

```python
# config/settings/prod.py
from .base import *  # noqa: F401,F403

DEBUG = False
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")   # behind a TLS-terminating proxy
SECURE_SSL_REDIRECT = True
SECURE_HSTS_SECONDS = 60 * 60 * 24 * 365
SECURE_HSTS_INCLUDE_SUBDOMAINS = True
SESSION_COOKIE_SECURE = True
CSRF_COOKIE_SECURE = True
CSRF_TRUSTED_ORIGINS = env.list("CSRF_TRUSTED_ORIGINS")          # e.g. https://app.example.com
STORAGES = {
    "default": {"BACKEND": "storages.backends.s3.S3Storage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage"},
}
```

```python
# config/settings/test.py
from .base import *  # noqa: F401,F403

PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]  # fast tests only
EMAIL_BACKEND = "django.core.mail.backends.locmem.EmailBackend"
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
```

Select the environment explicitly at every entry point:

```bash
export DJANGO_SETTINGS_MODULE=config.settings.prod
python manage.py check --deploy          # flags missing HSTS, insecure cookies, DEBUG, weak SECRET_KEY
gunicorn config.wsgi:application
```

> **Gotcha:** `MIDDLEWARE` and `INSTALLED_APPS` from `base` are lists; `+=` in `dev.py` mutates the same list object imported from `base`. That is harmless when only one settings module is ever imported per process, but rebuild with `[*X, ...]` if anything else imports `base` too.

### 5.4 Real-world example: a production management command

A nightly job cancels orders that were never paid. It must be safe to rerun, report progress, support a dry run and process in batches so it never holds a long transaction or loads a million rows into memory.

```python
# apps/orders/management/commands/expire_unpaid_orders.py
from datetime import timedelta

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone

from apps.orders.models import Order


class Command(BaseCommand):
    help = "Cancel orders that stayed PENDING longer than --hours."

    def add_arguments(self, parser):
        parser.add_argument("--hours", type=int, default=24)
        parser.add_argument("--batch-size", type=int, default=500)
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, hours, batch_size, dry_run, **options):
        if hours < 1:
            raise CommandError("--hours must be at least 1")      # exit code 1, clean message

        cutoff = timezone.now() - timedelta(hours=hours)
        stale = Order.objects.filter(status=Order.Status.PENDING, created_at__lt=cutoff)
        total = stale.count()
        self.stdout.write(f"{total} stale orders older than {cutoff:%Y-%m-%d %H:%M}")
        if dry_run or total == 0:
            return

        cancelled = 0
        while True:
            with transaction.atomic():
                ids = list(
                    stale.order_by("pk")
                    .select_for_update(skip_locked=True)          # don't fight a concurrent payment
                    .values_list("pk", flat=True)[:batch_size]
                )
                if not ids:
                    break
                cancelled += Order.objects.filter(
                    pk__in=ids, status=Order.Status.PENDING      # re-check: idempotent
                ).update(status=Order.Status.CANCELLED, updated_at=timezone.now())
            self.stdout.write(f"  cancelled {cancelled}/{total}")

        self.stdout.write(self.style.SUCCESS(f"Done: {cancelled} orders cancelled"))
```

```bash
python manage.py expire_unpaid_orders --hours 48 --dry-run
python manage.py expire_unpaid_orders --hours 48 --batch-size 1000
```

The `update()` call issues one statement per batch; the `status` re-check in the `WHERE` clause makes a rerun harmless:

```sql
UPDATE "orders_order"
SET "status" = 'cancelled', "updated_at" = '2026-10-25T02:00:00+00:00'::timestamptz
WHERE ("orders_order"."id" IN (101, 102, 103, ...) AND "orders_order"."status" = 'pending');
```

Note that `update()` bypasses `save()` and does not send `post_save`; if other code relies on that signal, call a service function instead (see [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization)). Test the command with `call_command`:

```python
from io import StringIO
from django.core.management import call_command
from django.test import TestCase

class ExpireUnpaidOrdersTests(TestCase):
    def test_dry_run_changes_nothing(self):
        out = StringIO()
        call_command("expire_unpaid_orders", "--dry-run", stdout=out)
        self.assertIn("stale orders", out.getvalue())
```

## 6. Advantages, Disadvantages & Trade-offs

| Choice | Pros | Cons |
|---|---|---|
| Many small apps | Clear ownership, smaller migrations, reusable | Cross-app FKs and circular imports if boundaries are wrong |
| One big app | No boundary decisions, simple imports | Huge files, one migration stream, hard to split later |
| Settings split per environment | Structural differences are explicit | Drift between files; `import *` hides where a value came from |
| Single env-driven settings | One file, same code everywhere (twelve-factor) | Many env vars to manage; structural differences need conditionals |
| `.env` file in dev | Convenient | Easy to commit by accident; never use in production images |
| Secrets manager (Vault, AWS SM) | Rotation, audit, no plaintext on disk | More infrastructure; startup depends on it |
| Management command | Full Django env, testable with `call_command` | Runs in its own process; long jobs need batching and locking |
| Celery task for the same job | Retries, scheduling, distribution | More moving parts; see [Ch 31](topic.html?p=31-celery-background-tasks) |

### When to use

- Create a new app when a feature area owns its own models and could be reasoned about alone (accounts, billing, catalogue).
- Use environment variables for every value that differs between deploys or is secret.
- Use a management command for operator-run or cron-scheduled jobs that need the ORM.

### When NOT to use

- Don't create an app per model or per view; you get dozens of apps with tangled FKs.
- Don't put business logic in `settings.py` or query the database there or in `ready()`.
- Don't use management commands for work triggered by user requests — enqueue a task instead.

## 7. Common Mistakes & Best Practices

**Committing `SECRET_KEY` and credentials.** The `startproject` template generates an insecure key in `settings.py`. Once in git history it is compromised; anyone with it can forge signed cookies and password-reset tokens. Read it from the environment, give it no default, and rotate it using `SECRET_KEY_FALLBACKS` (old key in fallbacks, new key as `SECRET_KEY`, remove the fallback after sessions and tokens expire).

**`DEBUG` defaulting to `True`.**

```python
# Before: one missing env var and production shows tracebacks
DEBUG = os.environ.get("DEBUG", True)          # also: any non-empty string is truthy!

# After
DEBUG = env.bool("DEBUG", default=False)
```

**Importing the settings module directly.** `from config.settings import base` gives you the raw module, not Django's merged, overridable settings. Use `from django.conf import settings`.

**Querying the database in `ready()` or at import time.** It runs during `migrate` before tables exist, in every test process, and in every Gunicorn worker on boot. Django 5.0+ emits a `RuntimeWarning` when the database is accessed during app initialization. Load lazily on first use instead.

**Changing `AUTH_USER_MODEL` later.** It must be set before the first `migrate`; changing it afterwards means rewriting migrations and data. Create a custom user model on day one — see [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user).

**Renaming an app's label casually.** The label is baked into table names (`orders_order`), content types, permissions and migration dependencies. Renaming requires careful migrations; set `label` explicitly when the package path changes but you want to keep the label.

**Circular imports between apps.** `orders.models` imports `catalog.models` which imports `orders.models`. Use string references (`models.ForeignKey("catalog.Product", ...)`) and `apps.get_model` inside functions.

**Best practices**

- One config package (`config/`), domain apps under `apps/`, a `core` app for shared base classes.
- Fail fast: required settings have no defaults; run `check --deploy` in CI against production settings.
- Keep `ready()` small: import signal modules, register checks, nothing else.
- Make management commands idempotent, batched, with `--dry-run`, and test them with `call_command`.
- Never print secrets; `diffsettings` output and debug pages can leak them (Django masks names containing `KEY`, `SECRET`, `PASS`, `TOKEN` and similar on debug pages, but not in your own logs).

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: wrong settings module in production.** *Symptom:* debug toolbar appears in production, or `DisallowedHost` errors. *Root cause:* the container's `DJANGO_SETTINGS_MODULE` was unset, so `manage.py`'s `setdefault` picked `config.settings.dev`. *Fix:* make the default the *safe* one (prod) or have no default and fail; log the active module at startup.

**Pitfall: settings changed but nothing happened.** Settings are read once per process. After changing an env var or a ConfigMap you must restart or roll the workers. A feature flag that must change without restart belongs in the database or cache, not in settings.

**Pitfall: `AppRegistryNotReady` in a Celery worker or script.** A standalone script imports models without calling `django.setup()`. *Fix:* set `DJANGO_SETTINGS_MODULE` and call `django.setup()` before importing models (Celery's Django integration does this in `celery.py`), or turn the script into a management command.

**Pitfall: cron job runs twice.** Two pods each run the scheduled command, or a job overlaps the previous run. *Fix:* use a Kubernetes CronJob with `concurrencyPolicy: Forbid`, a database advisory lock, or `select_for_update(skip_locked=True)` batches as above, and make the work idempotent.

**Pitfall: memory blow-up in a command.** `for order in Order.objects.all():` caches every row in the QuerySet. *Fix:* `iterator(chunk_size=2000)` or keyset batching by primary key.

**Debugging**

- `python manage.py diffsettings --all` to see the effective value of every setting; `python manage.py shell -c "from django.conf import settings; print(settings.SETTINGS_MODULE)"`.
- `python manage.py check --deploy --settings=config.settings.prod` in CI.
- `python -X importtime manage.py check` to find slow imports that hurt boot and test start-up.
- For `ready()` issues, set a breakpoint in `django/apps/registry.py:populate` and watch which app fails.

**Scaling notes.** Large codebases (50+ apps) benefit from explicit app boundaries: a service layer per app, cross-app calls through functions not model internals, and import-linter rules to forbid cycles. Boot time matters at scale: every worker and every test process pays for imports, so heavy optional imports should happen lazily inside functions.

## 9. Interview Questions

**Q: What is the difference between a Django project and a Django app?**
A: A project is the configuration container for one site: `settings`, the root URLconf and the WSGI/ASGI entry points, plus `manage.py`. An app is a Python package that provides a feature — models, views, templates, static files, admin, commands — and is activated by listing it in `INSTALLED_APPS`. A project contains many apps, and a well-designed app can be reused across projects, the way `django.contrib.auth` or `rest_framework` are. What makes a package an app is its presence in `INSTALLED_APPS`, not its folder layout.

**Q: What does `INSTALLED_APPS` do, and does its order matter?**
A: It tells Django which apps to load into the app registry, so their models are registered, migrations are included, templates and static files are discovered, admin modules are autodiscovered and management commands are available. Order matters: template and static finders return the first match, so an app listed earlier can override another's templates; the first-listed app wins for same-named management commands; and `ready()` runs in that order. A common example is placing your app above `django.contrib.admin` to override admin templates.

**Q: What is `AppConfig.ready()` used for, and what should you never do in it?**
A: `ready()` runs once per process after all models are loaded, so it is the safe place to connect signal receivers (usually by importing a `signals` module), register system checks, or wire up anything that needs models. You should not run database queries there: it executes during `migrate` before tables may exist, in every test run and in every worker on boot, and recent Django versions warn about it. It can also run more than once in some test setups, so registrations should be idempotent (`dispatch_uid`).

**Q: How do you manage settings for different environments?**
A: Keep a shared base module and either environment-specific modules selected by `DJANGO_SETTINGS_MODULE` (`config.settings.dev`, `.prod`, `.test`), or a single module that reads every varying value from environment variables, or a combination. Secrets and per-deploy values come from the environment or a secrets manager, with safe defaults (`DEBUG=False`) and no defaults for required secrets so a misconfiguration fails at boot. Validate production configuration with `manage.py check --deploy` in CI.

**Q: Why should you import `from django.conf import settings` rather than your settings module?**
A: `django.conf.settings` is a lazy proxy that merges Django's `global_settings` defaults with your module and respects `override_settings` in tests and the `--settings` flag. Importing your module directly gives you only what that file defines, may load a different environment's file than the one active, and bypasses test overrides. It also couples code to a project path, which breaks reusable apps.

**Q: What causes `AppRegistryNotReady` and how do you fix it?**
A: It means code tried to use models or the registry before `apps.populate()` finished — usually a model import in an app's `__init__.py` or at module level in `apps.py`, calling `get_user_model()` at import time, or a standalone script that imports models without calling `django.setup()`. The fix is to delay the import: inside a function, inside `ready()`, or use string model references such as `"orders.Order"`. Scripts should set `DJANGO_SETTINGS_MODULE` and call `django.setup()`, or become management commands.

**Q: How do you write a custom management command?**
A: Create `<app>/management/commands/<name>.py` (with `__init__.py` files in `management` and `commands`) containing `class Command(BaseCommand)`. Declare options in `add_arguments(parser)` using argparse, implement `handle(self, *args, **options)`, write output with `self.stdout.write` and `self.style.SUCCESS`, and raise `CommandError` for user errors. Test it with `django.core.management.call_command`. For production jobs, add `--dry-run`, batch the work, and make it idempotent.

**Q: What is the difference between `manage.py` and `django-admin`?**
A: They run the same `ManagementUtility`. `manage.py` sets `DJANGO_SETTINGS_MODULE` to your project's settings by default and puts the project directory on `sys.path`, so commands work without extra flags. `django-admin` needs `--settings` or the environment variable for anything that requires settings; it is mostly used for `startproject`.

**Q: How should secrets like `SECRET_KEY` and database passwords be handled, and what is `SECRET_KEY` used for?**
A: Read them from environment variables or a secrets manager at startup, never commit them, and give required secrets no default so a missing value crashes the deploy instead of silently using an insecure key. `SECRET_KEY` is used for cryptographic signing — signed cookies and the signed-cookie session backend, password-reset tokens, the messages cookie, and `django.core.signing` — not for password hashing. Leaking it lets an attacker forge those signed values.

**Q: How do you rotate `SECRET_KEY` without logging everyone out? (Senior)**
A: Since Django 4.1, set the new key as `SECRET_KEY` and put the old one in `SECRET_KEY_FALLBACKS`. Signing uses the new key, while verification also accepts values signed with fallback keys, so existing sessions, password-reset links and signed cookies keep working. After the longest-lived signed artifact expires — for example `SESSION_COOKIE_AGE` and `PASSWORD_RESET_TIMEOUT` — remove the old key from the fallbacks. If the key was leaked, you skip the grace period and accept forced logouts, because keeping a compromised key as a fallback keeps the hole open.

**Q: How would you structure a large Django codebase with 40+ apps and several teams? (Senior)**
A: Organize apps around business capabilities rather than technical layers, each owning its models, migrations, services, URLs and tests. Enforce boundaries: other apps call a public service module, not another app's models internals; use string FK references to avoid import cycles; and enforce the dependency graph with a tool like import-linter in CI. Keep the config package thin, put shared base models and middleware in a `core` app, and avoid generic "utils" apps that everything depends on. Watch boot time and migration graph complexity, and squash migrations periodically.

**Q: A nightly management command occasionally processes records twice and sometimes runs out of memory. How do you fix it? (Senior)**
A: The double processing usually comes from overlapping runs (a slow run still going when the next starts, or two pods running the same cron) combined with non-idempotent work. I'd prevent overlap with a CronJob `concurrencyPolicy: Forbid` or a PostgreSQL advisory lock, claim rows inside `transaction.atomic()` with `select_for_update(skip_locked=True)`, and make updates conditional (`WHERE status = 'pending'`) so retries are harmless. The memory problem is the QuerySet result cache on a full table scan; I'd batch by primary key or use `.iterator(chunk_size=...)` and `values_list` for IDs. Finally I'd add metrics and a dry-run mode so operators can see what a run will do.

**Q: What is `DEFAULT_AUTO_FIELD` and why does it matter?**
A: It sets the primary-key type for models that don't declare one. New projects since Django 3.2 use `BigAutoField` (64-bit), which avoids exhausting a 32-bit integer key on high-volume tables. Each `AppConfig` can override it with `default_auto_field`. Changing it on an existing project generates migrations that alter primary keys and every foreign key referencing them, which can lock large tables, so decide early.

## 10. Quick Revision & Cheat Sheet

| Thing | What to remember |
|---|---|
| `startproject config .` | config package + `manage.py`; trailing dot avoids nesting |
| `startapp orders` | app skeleton with `apps.py`, `models.py`, `migrations/` |
| `INSTALLED_APPS` | activates apps; order affects template/static/command overrides |
| `apps.populate` | configs, then models, then `ready()` |
| `AppConfig` | `name`, `label`, `verbose_name`, `default_auto_field`, `ready()` |
| `DJANGO_SETTINGS_MODULE` | which module `LazySettings` imports on first access |
| `global_settings` | defaults; `diffsettings` shows your overrides |
| `SECRET_KEY_FALLBACKS` | rotate keys without invalidating signatures (4.1+) |
| `check --deploy` | security checklist for production settings |
| Custom command | `management/commands/x.py`, `BaseCommand`, `add_arguments`, `handle`, `CommandError` |
| `call_command` | run commands from code and tests |

- A package is an app because it is in `INSTALLED_APPS`.
- Settings are lazy, merged with defaults, and read once per process.
- Always `from django.conf import settings`.
- Required secrets have no default; `DEBUG` defaults to `False`.
- `AppRegistryNotReady` means you imported models too early.
- `ready()`: connect signals, no queries, idempotent.
- Set `AUTH_USER_MODEL` before the first migrate.
- Management commands: batched, idempotent, `--dry-run`, tested with `call_command`.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" django-environ && django-admin startproject config . && python manage.py startapp blog`.

1. **Split the settings.** Convert `config/settings.py` into `config/settings/{base,dev,prod}.py`. Make `SECRET_KEY` required from the environment and confirm `python manage.py check` fails with a clear error when it is unset.
2. **Watch populate.** Add `print()` calls to `blog/__init__.py`, `blog/apps.py` (module level and inside `ready()`) and `blog/models.py`. Run `python manage.py check` and explain the order. Then add `from .models import *` to `blog/__init__.py` and reproduce `AppRegistryNotReady`.
3. **Template override by order.** Create `blog/templates/admin/base_site.html` that changes the admin title. Confirm it applies only when `blog` is listed above `django.contrib.admin`.
4. **`diffsettings` and `check --deploy`.** Run both against `prod.py` and fix every warning `check --deploy` reports.
5. **Override a command.** Create a `blog` command named `check_links` and a second app with the same command name; verify which one runs depending on `INSTALLED_APPS` order.

**Mini project — Ops command suite.** In a `shop` app with an `Order` model, write `expire_unpaid_orders` (as in §5.4) and `export_orders --since YYYY-MM-DD --out file.csv` that streams rows with `iterator()` and `values_list`. Add `--dry-run`, progress output, `CommandError` on bad input, and tests using `call_command` that assert counts and idempotency (running twice changes nothing the second time).

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 01 · Django Architecture & the Request/Response Lifecycle](topic.html?p=01-architecture-request-lifecycle), [Ch 03 · URL Routing & URLconf](topic.html?p=03-urls-routing) (`ROOT_URLCONF`), [Ch 11 · Migrations](topic.html?p=11-migrations) (per-app migration graphs), [Ch 19 · Signals](topic.html?p=19-signals) (receivers in `ready()`), [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user) (`AUTH_USER_MODEL`), [Ch 28 · Security](topic.html?p=28-security) (`check --deploy`, HTTPS settings), [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production), [Ch 36 · Django Internals](topic.html?p=36-django-internals) (`LazySettings`, registry).

**Other handbooks:** [Docker · Environment & Configuration](../docker/topic.html?p=15-env-config), [Docker · Secrets](../docker/topic.html?p=24-secrets), [Kubernetes · ConfigMaps & Secrets](../kubernetes/topic.html?p=05-configmaps-secrets), [Kubernetes · Jobs & CronJobs](../kubernetes/topic.html?p=08-jobs-cronjobs).

- **Applications** — Django docs · *Beginner* · `AppConfig`, the registry and the initialization process explained officially. <https://docs.djangoproject.com/en/5.2/ref/applications/>
- **Settings** — Django docs · *Beginner* · how settings load, `DJANGO_SETTINGS_MODULE`, `settings.configure()`. <https://docs.djangoproject.com/en/5.2/topics/settings/>
- **Settings reference** — Django docs · *Intermediate* · every setting and its default. <https://docs.djangoproject.com/en/5.2/ref/settings/>
- **How to create custom django-admin commands** — Django docs · *Beginner* · `BaseCommand`, arguments, output, testing. <https://docs.djangoproject.com/en/5.2/howto/custom-management-commands/>
- **Deployment checklist** — Django docs · *Intermediate* · the settings to review before going live. <https://docs.djangoproject.com/en/5.2/howto/deployment/checklist/>
- **The Twelve-Factor App: Config** — 12factor.net · *Beginner* · why configuration belongs in the environment. <https://12factor.net/config>
- **django-environ** — GitHub · *Beginner* · typed env vars and database/cache URLs for settings. <https://github.com/joke2k/django-environ>
- **django/apps/registry.py** — GitHub · *Advanced* · read `Apps.populate` to see the three phases in code. <https://github.com/django/django/blob/stable/5.2.x/django/apps/registry.py>

---

*Django Handbook — chapter 02.*
