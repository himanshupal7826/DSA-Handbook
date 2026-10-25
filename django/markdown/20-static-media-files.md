# 20 · Static & Media Files

> **In one line:** Static files are *your* assets, gathered by finders from app `static/` folders and `STATICFILES_DIRS` into a single `STATIC_ROOT` by `collectstatic` and served by WhiteNoise, Nginx or a CDN with hashed names; media files are *users'* uploads, written through the `STORAGES["default"]` backend (local disk or S3 via django-storages) — and neither should ever be served by Django's development server in production.

---

## 1. Overview

> **Builds on:** [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings), [Ch 05 · Django Template Language](topic.html?p=05-templates), [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation), [Ch 18 · Middleware](topic.html?p=18-middleware).

Every web app has two kinds of files that are not Python code:

- **Static files** — CSS, JavaScript, fonts, images that ship with the code. They change only on deploy, are the same for every user, and should be cached aggressively.
- **Media files** — user uploads: avatars, invoices, documents. They're created at runtime, can be large, can be malicious, and often need access control.

The naive approach — "it works with `runserver`" — breaks the moment you set `DEBUG = False`: CSS disappears, uploads 404, and someone discovers that `django.views.static.serve` "fixes" it and ships that to production, where a Python worker now streams megabytes of images, blocking a Gunicorn slot per request. Or the team scales to three containers and uploads written to one container's disk are invisible on the others. Or a deploy changes `app.css` but browsers keep the old cached copy for a year.

Django's answer is a clear separation. **`django.contrib.staticfiles`** finds static assets across apps, `collectstatic` copies them to one directory (`STATIC_ROOT`), and a storage backend can hash filenames for cache busting. **Media** goes through the file storage API (`FileField`, `default_storage`), whose backend you swap from local disk to object storage without changing model code. Serving is somebody else's job: WhiteNoise, Nginx, a CDN or S3.

> **Why this matters:** "What's the difference between `STATIC_ROOT` and `STATICFILES_DIRS`?", "What does `collectstatic` do?", "Why does my CSS 404 with DEBUG=False?" and "How do you store uploads with multiple servers?" come up in almost every Django interview and in every first deployment.

## 2. Core Concepts

- **`STATIC_URL`** — URL prefix for static files (e.g. `/static/` or `https://cdn.example.com/static/`). *Why it matters:* `{% static %}` builds URLs from it; switching to a CDN is a settings change.
- **App `static/` directories** — each app's `static/<app_name>/...`. *Why it matters:* reusable apps ship their assets; namespacing by app name prevents collisions.
- **`STATICFILES_DIRS`** — extra *source* directories (project-level assets not in an app). *Why it matters:* it's an input to `collectstatic`, never the output.
- **`STATIC_ROOT`** — the single *destination* directory `collectstatic` writes to. *Why it matters:* this is what the web server/WhiteNoise serves; it must not be in `STATICFILES_DIRS`.
- **Finders** — `STATICFILES_FINDERS`: `FileSystemFinder` (searches `STATICFILES_DIRS`) and `AppDirectoriesFinder` (searches each app's `static/`). *Why it matters:* the **first match wins**, so order and namespacing decide which `logo.png` you get.
- **`collectstatic`** — management command that runs the finders and saves every file through the static storage backend, then `post_process()`. *Why it matters:* a build/deploy step; hashing and compression happen here.
- **`findstatic`** — `manage.py findstatic css/app.css -v 2` shows which file wins and where it searched. *Why it matters:* debugging "wrong file served".
- **`STORAGES`** (4.2+) — dict with `"default"` (media) and `"staticfiles"` backends. *Why it matters:* replaced `DEFAULT_FILE_STORAGE`/`STATICFILES_STORAGE`, which were removed in 5.1.
- **`ManifestStaticFilesStorage`** — saves `app.css` also as `app.3f2a9c1b7e4d.css`, rewrites references in CSS, writes `staticfiles.json`. *Why it matters:* cache-busting so you can set far-future cache headers.
- **WhiteNoise** — middleware that serves `STATIC_ROOT` efficiently from Python with correct headers, compression and immutable caching. *Why it matters:* the simplest production static setup for containers/PaaS.
- **`MEDIA_URL` / `MEDIA_ROOT`** — URL prefix and local directory for uploads with `FileSystemStorage`. *Why it matters:* never the same as static settings.
- **`FileField` / `ImageField`** — store a *path string* (varchar, default `max_length=100`) in the DB; the bytes live in storage. *Why it matters:* deleting the row doesn't delete the file; long paths overflow `max_length`.
- **`upload_to`** — string (with `strftime` placeholders) or callable `(instance, filename)` returning a path. *Why it matters:* controls layout, avoids hot directories, prevents user-controlled paths.
- **django-storages** — third-party backends (S3, GCS, Azure). `storages.backends.s3.S3Storage` for S3-compatible stores. *Why it matters:* shared, durable media across many app servers.

## 3. Theory & Principles

### 3.1 How `collectstatic` works

`collectstatic` (in `django.contrib.staticfiles.management.commands.collectstatic`):

1. Iterates `get_finders()`; each finder's `list(ignore_patterns)` yields `(path, source_storage)` pairs.
2. For each relative path, the **first finder/location to yield it wins**; later duplicates are skipped (with `-v 2` it reports them).
3. Copies (or symlinks with `--link`) the file into the **static storage** (`storages["staticfiles"]`) — for `StaticFilesStorage` that's the `STATIC_ROOT` directory; for an S3 backend, a bucket. Unchanged files are skipped by comparing modification times where the storage supports it.
4. If the storage has `post_process()` (Manifest storage does), calls it: it hashes file contents (MD5, truncated to 12 hex chars), saves hashed copies, rewrites `url(...)` and `@import` references in CSS (and JS module imports when `support_js_module_import_aggregation` is enabled), repeats passes for nested references, and writes `staticfiles.json` mapping `css/app.css → css/app.3f2a9c1b7e4d.css`.

At runtime, `{% static "css/app.css" %}` calls `staticfiles_storage.url(path)`. With Manifest storage and `DEBUG=False` it looks the path up in the manifest and returns the hashed URL; with `manifest_strict = True` (default) a missing entry raises `ValueError` — the famous "Missing staticfiles manifest entry" 500. With `DEBUG=True` it returns the unhashed name.

```svg
<svg viewBox="0 0 860 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj20a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">collectstatic: many sources, finders pick first match, one STATIC_ROOT</text>
  <rect x="20" y="45" width="230" height="56" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="135" y="67" text-anchor="middle" fill="#1e293b">STATICFILES_DIRS</text><text x="135" y="85" text-anchor="middle" fill="#334155" font-size="9">BASE_DIR / "assets"   (FileSystemFinder)</text>
  <rect x="20" y="115" width="230" height="56" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="135" y="137" text-anchor="middle" fill="#1e293b">blog/static/blog/...</text><text x="135" y="155" text-anchor="middle" fill="#334155" font-size="9">AppDirectoriesFinder</text>
  <rect x="20" y="185" width="230" height="56" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="135" y="207" text-anchor="middle" fill="#1e293b">django/contrib/admin/static</text><text x="135" y="225" text-anchor="middle" fill="#334155" font-size="9">AppDirectoriesFinder</text>
  <rect x="300" y="100" width="200" height="90" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="400" y="124" text-anchor="middle" fill="#1e293b" font-weight="bold">collectstatic</text>
  <text x="400" y="144" text-anchor="middle" fill="#334155">first match per path wins</text>
  <text x="400" y="160" text-anchor="middle" fill="#334155">copy via staticfiles storage</text>
  <text x="400" y="176" text-anchor="middle" fill="#334155">then post_process()</text>
  <rect x="550" y="60" width="290" height="170" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="695" y="84" text-anchor="middle" fill="#1e293b" font-weight="bold">STATIC_ROOT (output only)</text>
  <text x="695" y="106" text-anchor="middle" fill="#334155">css/app.css</text>
  <text x="695" y="124" text-anchor="middle" fill="#334155">css/app.3f2a9c1b7e4d.css</text>
  <text x="695" y="142" text-anchor="middle" fill="#334155">css/app.3f2a9c1b7e4d.css.gz / .br</text>
  <text x="695" y="160" text-anchor="middle" fill="#334155">admin/css/base.css ...</text>
  <text x="695" y="178" text-anchor="middle" fill="#334155">staticfiles.json (manifest)</text>
  <text x="695" y="206" text-anchor="middle" fill="#16a34a">served by WhiteNoise / Nginx / CDN</text>
  <path d="M252,73 L298,125" stroke="#2563eb" stroke-width="2" marker-end="url(#dj20a)"/>
  <path d="M252,143 L298,145" stroke="#2563eb" stroke-width="2" marker-end="url(#dj20a)"/>
  <path d="M252,213 L298,165" stroke="#2563eb" stroke-width="2" marker-end="url(#dj20a)"/>
  <path d="M502,145 L548,145" stroke="#2563eb" stroke-width="2" marker-end="url(#dj20a)"/>
  <rect x="20" y="270" width="820" height="50" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="430" y="290" text-anchor="middle" fill="#1e293b">Template: {% static "css/app.css" %}  -&gt;  manifest lookup  -&gt;  /static/css/app.3f2a9c1b7e4d.css</text>
  <text x="430" y="308" text-anchor="middle" fill="#334155">Content changes =&gt; new hash =&gt; new URL =&gt; Cache-Control: max-age=31536000, immutable is safe</text>
</svg>
```

### 3.2 Why hashing makes caching safe

HTTP caching has a dilemma: long `max-age` makes repeat visits fast but means users keep stale CSS after a deploy; short `max-age` forces revalidation round-trips. **Content-hashed filenames** dissolve it: each version of a file has a unique URL, so the URL can be cached forever (`immutable`) and a deploy simply references new URLs from the (uncached, short-lived) HTML. WhiteNoise detects hashed names and sets a one-year `Cache-Control` on them automatically; unhashed names get a short max-age.

### 3.3 The storage API for media

`FileField` is a thin layer over `django.core.files.storage.Storage`. On `save()` of a model with a new uploaded file, the field's `pre_save()` calls `FieldFile.save(name, content)`, which calls `field.generate_filename(instance, filename)` (applies `upload_to`), then `storage.save(name, content)`. The storage calls `get_available_name()` — if a file already exists at that name, it appends a random 7-character suffix rather than overwriting — and returns the final name, which is what gets stored in the DB column. `instance.file.url` calls `storage.url(name)`; `.path` exists only for local filesystem storage (S3 raises `NotImplementedError`), which is why portable code uses `.open()`/`.url`, never `.path`.

Uploads arrive via `request.FILES` (only with `method="post"` and `enctype="multipart/form-data"`). Upload handlers stream them: files up to `FILE_UPLOAD_MAX_MEMORY_SIZE` (default 2.5 MB) are kept in memory (`InMemoryUploadedFile`), larger ones go to a temp file (`TemporaryUploadedFile`). `DATA_UPLOAD_MAX_MEMORY_SIZE` (also 2.5 MB) caps the non-file request body and does **not** cover file uploads — limit file size yourself (and at the proxy, e.g. Nginx `client_max_body_size`).

## 4. Architecture & Workflow

### 4.1 Production topology

```svg
<svg viewBox="0 0 860 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj20b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
    <marker id="dj20c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Who serves what in production</text>
  <rect x="20" y="140" width="110" height="50" rx="8" fill="#f1f5f9" stroke="#334155"/><text x="75" y="170" text-anchor="middle" fill="#1e293b" font-weight="bold">Browser</text>
  <rect x="190" y="50" width="170" height="54" rx="8" fill="#ede9fe" stroke="#7c3aed"/><text x="275" y="72" text-anchor="middle" fill="#1e293b">CDN</text><text x="275" y="90" text-anchor="middle" fill="#334155" font-size="9">/static/* hashed, cached 1y</text>
  <rect x="190" y="140" width="170" height="54" rx="8" fill="#dbeafe" stroke="#2563eb"/><text x="275" y="162" text-anchor="middle" fill="#1e293b">Gunicorn + Django</text><text x="275" y="180" text-anchor="middle" fill="#334155" font-size="9">HTML, API, upload handling</text>
  <rect x="190" y="240" width="170" height="54" rx="8" fill="#dcfce7" stroke="#16a34a"/><text x="275" y="262" text-anchor="middle" fill="#1e293b">S3 / object storage</text><text x="275" y="280" text-anchor="middle" fill="#334155" font-size="9">media via presigned URL</text>
  <rect x="430" y="50" width="200" height="54" rx="8" fill="#fef3c7" stroke="#d97706"/><text x="530" y="72" text-anchor="middle" fill="#1e293b">WhiteNoise (origin)</text><text x="530" y="90" text-anchor="middle" fill="#334155" font-size="9">serves STATIC_ROOT in-process</text>
  <rect x="430" y="140" width="200" height="54" rx="8" fill="#fff" stroke="#94a3b8"/><text x="530" y="162" text-anchor="middle" fill="#1e293b">PostgreSQL</text><text x="530" y="180" text-anchor="middle" fill="#334155" font-size="9">FileField stores path only</text>
  <rect x="680" y="50" width="160" height="54" rx="8" fill="#fef3c7" stroke="#d97706"/><text x="760" y="72" text-anchor="middle" fill="#1e293b">CI build</text><text x="760" y="90" text-anchor="middle" fill="#334155" font-size="9">collectstatic in image</text>
  <path d="M132,155 L188,85" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj20b)"/>
  <path d="M132,165 L188,165" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj20b)"/>
  <path d="M132,178 L188,262" stroke="#16a34a" stroke-width="2" marker-end="url(#dj20c)"/>
  <path d="M362,77 L428,77" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj20b)"/>
  <path d="M362,167 L428,167" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj20b)"/>
  <path d="M275,196 L275,238" stroke="#16a34a" stroke-width="2" marker-end="url(#dj20c)"/>
  <path d="M678,77 L632,77" stroke="#d97706" stroke-width="2" marker-end="url(#dj20b)"/>
  <text x="300" y="222" fill="#334155" font-size="9">storage.save()</text>
  <text x="430" y="325" text-anchor="middle" fill="#334155">Django never streams static or media bytes in the hot path; it only generates URLs and accepts uploads.</text>
</svg>
```

### 4.2 Dev vs production

```text
                     DEBUG=True (runserver)                  DEBUG=False (production)
static            staticfiles app serves from finders      collectstatic -> STATIC_ROOT -> WhiteNoise/Nginx/CDN
                  (no collectstatic needed)                runserver refuses unless --insecure
media             add static(MEDIA_URL, ...) to urls       storage backend URL (S3/CDN) or Nginx alias
                  helper returns [] when DEBUG=False       private files: presigned URLs or X-Accel-Redirect
{% static %}      unhashed names                           hashed names from staticfiles.json
```

### 4.3 Deploy workflow

```text
1. CI: pip install, then  python manage.py collectstatic --noinput  (inside the Docker build)
2. Image contains STATIC_ROOT + staticfiles.json  -> every container has the same manifest
3. (CDN/S3 static) collectstatic uploads to the bucket once per release instead
4. Release: migrate as a separate step; roll out containers
5. Old hashed files stay available during rollout (don't --clear S3 static mid-deploy)
```

## 5. Implementation

### 5.1 Simple example — settings, templates, uploads in development

```python
# settings.py
from pathlib import Path
BASE_DIR = Path(__file__).resolve().parent.parent

INSTALLED_APPS = [
    "django.contrib.staticfiles",
    # ...
    "profiles",
]

STATIC_URL = "static/"
STATICFILES_DIRS = [BASE_DIR / "assets"]          # sources (project-wide)
STATIC_ROOT = BASE_DIR / "staticfiles"            # destination of collectstatic

MEDIA_URL = "media/"
MEDIA_ROOT = BASE_DIR / "media"

STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "django.contrib.staticfiles.storage.StaticFilesStorage"},
}
```

```html
{# templates/base.html #}
{% load static %}
<!doctype html>
<html>
<head>
  <link rel="stylesheet" href="{% static 'css/app.css' %}">
</head>
<body>
  <img src="{% static 'profiles/img/default-avatar.png' %}" alt="">
  {% if user.profile.avatar %}
    <img src="{{ user.profile.avatar.url }}" alt="avatar">
  {% endif %}
</body>
</html>
```

```python
# profiles/models.py
import uuid
from pathlib import Path
from django.conf import settings
from django.core.validators import FileExtensionValidator
from django.db import models


def avatar_path(instance, filename):
    ext = Path(filename).suffix.lower()
    # never trust the user's filename; spread files across prefixes
    return f"avatars/{instance.user_id}/{uuid.uuid4().hex}{ext}"


class Profile(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    avatar = models.ImageField(                 # requires Pillow
        upload_to=avatar_path, blank=True, max_length=255,
        validators=[FileExtensionValidator(["jpg", "jpeg", "png", "webp"])],
    )
```

```python
# profiles/views.py
from django.contrib.auth.decorators import login_required
from django.shortcuts import redirect, render
from .forms import AvatarForm


@login_required
def upload_avatar(request):
    profile = request.user.profile
    form = AvatarForm(request.POST or None, request.FILES or None, instance=profile)
    if request.method == "POST" and form.is_valid():
        form.save()
        return redirect("profile")
    return render(request, "profiles/avatar.html", {"form": form})
```

```html
<form method="post" enctype="multipart/form-data">
  {% csrf_token %}
  {{ form.as_p }}
  <button type="submit">Upload</button>
</form>
```

```python
# urls.py — development only; static() returns [] when DEBUG is False
from django.conf import settings
from django.conf.urls.static import static
from django.urls import include, path

urlpatterns = [path("", include("profiles.urls"))]
if settings.DEBUG:
    urlpatterns += static(settings.MEDIA_URL, document_root=settings.MEDIA_ROOT)
```

```bash
python manage.py findstatic css/app.css -v 2
python manage.py collectstatic --noinput
```

```text
Found 'css/app.css' here:
  /srv/app/assets/css/app.css
Looking in the following locations:
  /srv/app/assets
  /srv/app/.venv/lib/python3.12/site-packages/django/contrib/admin/static
  /srv/app/profiles/static

132 static files copied to '/srv/app/staticfiles'.
```

### 5.2 Real-world example — WhiteNoise for static, S3 for media, private documents

```bash
pip install "whitenoise[brotli]" "django-storages[s3]" boto3 Pillow
```

```python
# settings/production.py
import os

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",       # right after SecurityMiddleware
    "django.contrib.sessions.middleware.SessionMiddleware",
    # ...
]

STATIC_URL = os.environ.get("STATIC_URL", "/static/")  # or https://cdn.example.com/static/
STATIC_ROOT = BASE_DIR / "staticfiles"

STORAGES = {
    "default": {                                         # public media (avatars)
        "BACKEND": "storages.backends.s3.S3Storage",
        "OPTIONS": {
            "bucket_name": os.environ["MEDIA_BUCKET"],
            "location": "media",
            "file_overwrite": False,                     # unique names instead of overwrite
            "querystring_auth": False,                   # public objects; URLs without signature
            "custom_domain": os.environ.get("MEDIA_CDN_DOMAIN"),
        },
    },
    "staticfiles": {
        "BACKEND": "whitenoise.storage.CompressedManifestStaticFilesStorage",
    },
    "private": {                                         # named storage for sensitive files
        "BACKEND": "storages.backends.s3.S3Storage",
        "OPTIONS": {
            "bucket_name": os.environ["PRIVATE_BUCKET"],
            "querystring_auth": True,                    # presigned URLs
            "querystring_expire": 300,                   # seconds
            "file_overwrite": False,
        },
    },
}
# Credentials come from the instance/pod IAM role; don't put keys in settings.
```

```python
# documents/models.py
from django.conf import settings
from django.core.files.storage import storages
from django.db import models


def private_storage():
    return storages["private"]          # callable: resolved lazily, testable, migration-stable


def invoice_path(instance, filename):
    return f"invoices/{instance.account_id}/{instance.number}.pdf"


class Invoice(models.Model):
    account = models.ForeignKey("accounts.Account", on_delete=models.PROTECT)
    number = models.CharField(max_length=32, unique=True)
    pdf = models.FileField(storage=private_storage, upload_to=invoice_path, max_length=255)
```

```python
# documents/views.py
from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, redirect
from .models import Invoice


@login_required
def download_invoice(request, number):
    invoice = get_object_or_404(Invoice, number=number, account__members=request.user)
    return redirect(invoice.pdf.url)    # 5-minute presigned S3 URL; Django never streams bytes
```

For local-disk private files behind Nginx, the equivalent is to authorize in Django and return an empty response with `X-Accel-Redirect: /protected/invoices/...` pointing at an `internal` Nginx location, so Nginx streams the file.

Generating a file server-side and saving it through storage:

```python
from django.core.files.base import ContentFile

def attach_pdf(invoice, pdf_bytes):
    invoice.pdf.save(f"{invoice.number}.pdf", ContentFile(pdf_bytes), save=True)
    # name passes through upload_to; storage may adjust it to avoid collisions
```

Dockerfile excerpt — collect at build time so every container ships the same manifest:

```bash
# in Dockerfile
RUN DJANGO_SETTINGS_MODULE=config.settings.production \
    SECRET_KEY=build-only MEDIA_BUCKET=x PRIVATE_BUCKET=x \
    python manage.py collectstatic --noinput
```

### 5.3 Cleaning up orphaned files

Django doesn't delete files when you delete the row or replace the file (by design, since a rollback could leave the row pointing to a deleted file). Handle it explicitly after commit:

```python
from django.db import transaction
from django.db.models.signals import post_delete
from django.dispatch import receiver
from .models import Invoice


@receiver(post_delete, sender=Invoice, dispatch_uid="documents.delete_pdf")
def delete_pdf_file(sender, instance, **kwargs):
    if instance.pdf:
        name, storage = instance.pdf.name, instance.pdf.storage
        transaction.on_commit(lambda: storage.delete(name))
```

Remember that a delete receiver disables fast-delete for that model (see [Ch 19](topic.html?p=19-signals)); for high-volume tables prefer a periodic cleanup job or S3 lifecycle rules.

## 6. Advantages, Disadvantages & Trade-offs

| Option | Serves | Pros | Cons |
|---|---|---|---|
| `runserver` / `static()` | Dev only | Zero setup | Insecure, slow, disabled when DEBUG=False |
| WhiteNoise | Static | One process, correct headers, gzip/brotli, works on PaaS/containers | Uses app worker for cache misses (put a CDN in front) |
| Nginx `alias` | Static + local media | Very fast, sendfile | Needs shared volume; another config to manage |
| CDN (with WhiteNoise/S3 origin) | Static + public media | Global latency, offloads origin | Cache invalidation (solved by hashing), cost |
| Local `FileSystemStorage` for media | Media | Simple | Breaks with >1 server unless shared volume; backups |
| S3 via django-storages | Media (and static) | Durable, shared, presigned URLs, lifecycle rules | Latency on save, network dependency, IAM setup |
| `ManifestStaticFilesStorage` | Static names | Cache busting, immutable caching | Strict manifest errors; `collectstatic` required in every env with DEBUG=False |

### When to use

- WhiteNoise + `CompressedManifestStaticFilesStorage` for nearly every containerized Django app; add a CDN when traffic is global.
- S3 (or GCS/Azure) for media as soon as you have more than one app server or ephemeral containers.
- Private storage + presigned URLs (or `X-Accel-Redirect`) for anything that needs authorization.

### When NOT to use

- Don't serve media through WhiteNoise — it only serves files present at startup (`STATIC_ROOT`), not runtime uploads.
- Don't put user uploads on the same domain as your app without protections; don't serve them via `django.views.static.serve` in production.
- Don't use the S3 storage for static files if you can avoid it and are on WhiteNoise — it slows `collectstatic` and adds a moving part; use a CDN over WhiteNoise instead.
- Don't use local disk media on Kubernetes/Heroku-style ephemeral filesystems.

## 7. Common Mistakes & Best Practices

**1. Confusing `STATIC_ROOT` and `STATICFILES_DIRS`.** Putting `STATIC_ROOT` inside `STATICFILES_DIRS` raises `ImproperlyConfigured` ("The STATICFILES_DIRS setting should not contain the STATIC_ROOT setting"). Editing files in `STATIC_ROOT` by hand — they get overwritten on the next `collectstatic`. *Instead:* sources in app `static/` and `STATICFILES_DIRS`; `STATIC_ROOT` is build output, git-ignored.

**2. Not namespacing app static files.**

```text
# Before: two apps both ship static/logo.png -> first finder wins, wrong logo
blog/static/logo.png
shop/static/logo.png

# After
blog/static/blog/logo.png      {% static 'blog/logo.png' %}
shop/static/shop/logo.png      {% static 'shop/logo.png' %}
```

**3. Hardcoding `/static/...` in templates.** Breaks hashing and CDN switching. *Instead:* `{% static %}` everywhere (and `static()` from `django.templatetags.static` in Python).

**4. "Missing staticfiles manifest entry" in production.** Template references a file that wasn't collected (typo, file added after build, or `collectstatic` not run). *Instead:* run `collectstatic` in CI, run tests with Manifest storage and `DEBUG=False` once, and fix references.

**5. Trusting upload metadata.** `content_type` and the filename are client-controlled. *Instead:* generate names server-side; validate with `FileExtensionValidator` and by inspecting content (Pillow for images via `ImageField`, `python-magic` for others); size limits.

**6. Serving uploads from the main domain.** An uploaded `.html` or `.svg` with script runs as your origin → stored XSS that can read cookies and CSRF tokens. *Instead:* separate domain (`usercontent.example.com`), `Content-Disposition: attachment` for downloads, `X-Content-Type-Options: nosniff`.

**7. Using `.path` on files.** Works locally, raises `NotImplementedError` on S3. *Instead:* `.open()`, `.read()`, `.url`, `storage.exists()`.

**8. `FileField` default `max_length=100`.** Long `upload_to` paths with UUIDs exceed it, raising a `DataError`/validation error. *Instead:* set `max_length=255`.

**9. Using removed settings.** `DEFAULT_FILE_STORAGE`/`STATICFILES_STORAGE` were removed in 5.1. *Instead:* `STORAGES`.

**Best practices:** collect at build time; long cache on hashed files only; media on object storage; private by default for documents; `upload_to` callable with server-generated names; clean up orphans asynchronously.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: CSS disappears after setting `DEBUG=False`.** Symptom: unstyled admin, 404s for `/static/...`. Root cause: the staticfiles app only serves in DEBUG, and nothing else serves `STATIC_ROOT`. Fix: `collectstatic` + WhiteNoise (or Nginx/CDN). Don't "fix" with `runserver --insecure`.

**Pitfall: 500s with `ValueError: Missing staticfiles manifest entry for 'js/new.js'`.** After a deploy, some containers run old images with an old `staticfiles.json`, or `collectstatic` ran in a different container than the one serving. Fix: bake static + manifest into the image; deploy immutable images; if static is on S3, upload new files before rolling out and don't delete old hashed files until the rollout finishes.

**Pitfall: uploads vanish.** Users' avatars disappear after every deploy on Kubernetes. Root cause: `FileSystemStorage` writing to the container's ephemeral filesystem; or uploads land on pod A and pod B can't serve them. Fix: S3 storage; or a ReadWriteMany volume (simpler but slower and riskier).

**Pitfall: Gunicorn workers blocked by large uploads.** A sync worker reads a 500 MB upload from a slow client for minutes; timeouts hit at 30 s; workers exhausted. Fix: Nginx in front buffers request bodies (`client_max_body_size`, default buffering), enforce size limits, or upload **directly to S3 with presigned POST/PUT URLs** and send Django only the object key.

**Pitfall: Stale CSS after deploy.** Without Manifest storage, `app.css` was cached for a year by the CDN. Fix: hashed names; or purge the CDN; never long-cache unhashed URLs.

**Pitfall: slow `collectstatic`.** With S3 static storage, each run compares/upload thousands of files over the network. Fix: WhiteNoise in the image + CDN, or cache `STATIC_ROOT` between CI runs.

**Debugging:**

```bash
python manage.py findstatic admin/css/base.css -v 2      # which source wins
python manage.py collectstatic --dry-run --noinput -v 2   # what would be copied
curl -I https://example.com/static/css/app.3f2a9c1b7e4d.css   # Cache-Control, Content-Encoding
python manage.py shell -c "from django.contrib.staticfiles.storage import staticfiles_storage as s; print(s.url('css/app.css'))"
python manage.py shell -c "from django.core.files.storage import default_storage as d; print(type(d), d.url('x'))"
```

- Check `staticfiles.json` in the running container to confirm a file is in the manifest.
- `manage.py check --deploy` warns about some static/media misconfigurations alongside security settings.
- S3 403s on `.url`: check `querystring_auth`, bucket policy (public access block), object ACLs (prefer bucket policy over per-object `default_acl`).

**Scaling notes:** put a CDN in front of both static (origin WhiteNoise) and public media (origin S3). Use direct-to-S3 uploads for large files, processing (thumbnails, virus scan) in Celery tasks triggered after commit or by S3 events. Use S3 lifecycle rules to expire temp uploads. Keep media paths prefix-distributed (by user ID/UUID) for listing and for operational sanity.

## 9. Interview Questions

**Q: What is the difference between `STATIC_ROOT`, `STATICFILES_DIRS` and `STATIC_URL`?**
A: `STATICFILES_DIRS` lists extra *source* directories that the `FileSystemFinder` searches, in addition to each app's `static/` folder found by `AppDirectoriesFinder`. `STATIC_ROOT` is the single *destination* directory where `collectstatic` copies everything for deployment, and it's what the web server or WhiteNoise serves. `STATIC_URL` is the URL prefix used to build links (e.g. `/static/` or a CDN URL). `STATIC_ROOT` must not be one of the `STATICFILES_DIRS`, and you never edit it by hand.

**Q: What does `collectstatic` do?**
A: It runs each configured finder, gathers every static file across apps and `STATICFILES_DIRS` (first match per relative path wins), and saves them through the static storage backend — into `STATIC_ROOT` for filesystem storage, or a bucket for remote storage. Then it calls the storage's `post_process()`, which for Manifest storage hashes files, rewrites CSS references, and writes `staticfiles.json`. It's a deploy/build-time step, usually run with `--noinput` in CI.

**Q: Why does static stop working when `DEBUG=False`?**
A: The `django.contrib.staticfiles` app serves files via `runserver` only when `DEBUG=True`, as a development convenience; Django is not meant to serve static files in production because it's inefficient and insecure. In production you must run `collectstatic` and serve `STATIC_ROOT` with WhiteNoise, Nginx or a CDN. Also, `static()` URL helper for media returns no patterns when DEBUG is off.

**Q: What is the difference between static and media files?**
A: Static files are part of the codebase — CSS, JS, images shipped by developers — the same for all users and changed only on deploy, so they're collected and cached aggressively. Media files are uploaded by users at runtime through `FileField`/`ImageField` and the default storage backend; they're untrusted, may need access control, and must live on shared storage when you have multiple servers. They have separate settings (`STATIC_*` vs `MEDIA_*`, `STORAGES["staticfiles"]` vs `STORAGES["default"]`) and should be served from different paths or domains.

**Q: How does `ManifestStaticFilesStorage` work and why use it?**
A: During `collectstatic` post-processing it computes an MD5-based hash of each file's content, saves a copy named like `app.3f2a9c1b7e4d.css`, rewrites `url()`/`@import` references in CSS to the hashed names, and stores the mapping in `staticfiles.json`. `{% static %}` then emits hashed URLs (when DEBUG is False). Because a content change produces a new URL, you can set year-long immutable cache headers without ever serving stale assets. The catch: references to files missing from the manifest raise `ValueError` with `manifest_strict` on.

**Q: What does WhiteNoise do and where does it go in `MIDDLEWARE`?**
A: WhiteNoise is a middleware that serves files from `STATIC_ROOT` directly from the Python process with proper headers: far-future caching for hashed files, gzip/brotli pre-compressed variants, `Content-Type` and range support. It goes immediately after `SecurityMiddleware` and above everything else, so static requests short-circuit before sessions, CSRF or auth do work. Its `CompressedManifestStaticFilesStorage` combines hashing with compression at `collectstatic` time. Put a CDN in front for global traffic; it isn't for user uploads.

**Q: How do you store user uploads when you run several app servers?**
A: Use a shared storage backend — typically S3 or another object store through django-storages, configured as `STORAGES["default"]` — so any server can write and any server (or the CDN) can serve. The model's `FileField` stores only the object key; `.url` returns a public or presigned URL. Alternatives like an NFS/RWX volume work but are slower and less durable. Also avoid `.path` in code because remote storages don't support it.

**Q: What is the `STORAGES` setting?**
A: Introduced in Django 4.2, it's a dict of named storage configurations, each with a `BACKEND` and `OPTIONS`; the `"default"` alias is used for `FileField` and `default_storage`, the `"staticfiles"` alias for static files. You can add more aliases (e.g. `"private"`) and access them via `django.core.files.storage.storages["private"]`. It replaced `DEFAULT_FILE_STORAGE` and `STATICFILES_STORAGE`, which were deprecated in 4.2 and removed in 5.1.

**Q: How would you serve private files that only authorized users may download? (Senior)**
A: Keep them in non-public storage and authorize in Django, but don't stream bytes through the Python worker. With S3, the view checks permissions and redirects to a short-lived presigned URL (`querystring_auth=True`, a few minutes' expiry), possibly with `ResponseContentDisposition` to force download. With local disk behind Nginx, return `X-Accel-Redirect` to an `internal` location (or `X-Sendfile` on Apache) so the web server sends the file. Log access, avoid predictable keys, and serve from a separate domain to contain any content-type tricks.

**Q: What are the security risks of user uploads and how do you mitigate them? (Senior)**
A: Risks: stored XSS via HTML/SVG served from your origin, path traversal through crafted filenames, oversized uploads exhausting disk/memory/workers, malware distribution, and content-type spoofing. Mitigate by generating filenames server-side in `upload_to`, validating extension and actual content (Pillow, libmagic), enforcing size limits in Django and at the proxy, serving from a separate cookieless domain with `nosniff` and `Content-Disposition: attachment` for non-images, keeping sensitive files private with presigned URLs, and scanning asynchronously before making files available. Django's storage already prevents writing outside the storage root and avoids overwriting via `get_available_name`.

**Q: A deploy causes intermittent 500s: "Missing staticfiles manifest entry". Diagnose it. (Senior)**
A: Manifest storage raises when `{% static %}` references a path absent from `staticfiles.json` of the process handling the request. Intermittency suggests version skew — some instances have the new templates but an old manifest, or the manifest is generated at container start in some pods and not others, or static lives in a shared bucket that was overwritten/cleared mid-rollout. Fix by running `collectstatic` at image build so templates and manifest ship together, using immutable images, uploading new static before rollout and keeping old hashed files, and catching missing references in CI by running tests or a smoke render with `DEBUG=False`.

**Q: How would you handle 1 GB video uploads in a Django app? (Senior)**
A: Don't route the bytes through Django: a sync worker would be tied up for the whole transfer and hit timeouts. Issue a presigned S3 multipart upload (or presigned POST) from an API endpoint after authorization, let the browser upload directly to S3, then have the client notify Django (or use an S3 event) with the object key. A Celery task validates, transcodes and creates thumbnails, updating the model after commit. Enforce size and content-type in the presigned policy, and use lifecycle rules to clean up abandoned uploads.

**Q: Does deleting a model instance delete its file?**
A: No. Since Django 1.3, `FileField` files are not deleted when the instance is deleted or when the file is replaced, because a transaction rollback could leave a row pointing to a missing file and other rows might reference it. If you want cleanup, delete explicitly — e.g. in a `post_delete` receiver using `transaction.on_commit(lambda: storage.delete(name))` — or with a periodic orphan sweep or object-storage lifecycle rules. Packages like django-cleanup automate it.

**Q: How does Django handle an uploaded file in memory vs on disk?**
A: Upload handlers process the multipart stream: by default `MemoryFileUploadHandler` keeps files up to `FILE_UPLOAD_MAX_MEMORY_SIZE` (2.5 MB) in memory as `InMemoryUploadedFile`, and `TemporaryFileUploadHandler` streams larger ones to a temp file (`TemporaryUploadedFile`, in `FILE_UPLOAD_TEMP_DIR`). Both appear in `request.FILES` and are iterable in chunks via `.chunks()`. `DATA_UPLOAD_MAX_MEMORY_SIZE` limits the non-file body only, so total upload size must be limited in validation and at the proxy.

## 10. Quick Revision & Cheat Sheet

| Setting / tool | Role |
|---|---|
| `STATIC_URL` | URL prefix for static (`/static/` or CDN) |
| `STATICFILES_DIRS` | Extra source dirs (input) |
| app `static/<app>/` | Per-app sources (input) |
| `STATIC_ROOT` | `collectstatic` output; served in prod |
| `STATICFILES_FINDERS` | FileSystemFinder, AppDirectoriesFinder; first match wins |
| `STORAGES["staticfiles"]` | `StaticFilesStorage`, `ManifestStaticFilesStorage`, WhiteNoise storage |
| `MEDIA_URL` / `MEDIA_ROOT` | Uploads URL / local dir |
| `STORAGES["default"]` | Media backend (`FileSystemStorage`, `storages.backends.s3.S3Storage`) |
| `findstatic -v 2` | Which file wins |
| `collectstatic --noinput` | Build-time gather + hash |

- `STATIC_ROOT` is output, `STATICFILES_DIRS` is input; never overlap.
- Namespace app static files: `static/<app>/...`.
- Always `{% static %}`; hashed names only when DEBUG=False with Manifest storage.
- WhiteNoise right after `SecurityMiddleware`; CDN in front for scale.
- Media on object storage with multiple servers; never `.path`.
- `STORAGES` replaced the old storage settings (removed in 5.1).
- Uploads are untrusted: server-side names, validate content, separate domain, size limits.
- Files are not deleted with rows; clean up after commit.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" whitenoise Pillow`.

1. **Finder precedence.** Put `css/app.css` in both `STATICFILES_DIRS` and an app's `static/`; run `findstatic -v 2` and `collectstatic -v 2` to see which wins; then namespace and fix.
2. **DEBUG=False.** Flip `DEBUG=False`, observe broken CSS; add WhiteNoise and `CompressedManifestStaticFilesStorage`, run `collectstatic`, and inspect headers with `curl -I` for hashed and unhashed URLs.
3. **Manifest error.** Reference a non-existent file in a template with Manifest storage and DEBUG=False; read the error; write a test that renders all templates to catch it.
4. **Avatar upload.** Implement §5.1 with a UUID `upload_to`, extension validator and a 2 MB size check in `clean_avatar()`; try uploading an SVG renamed to `.png`.
5. **S3 locally.** Run MinIO in Docker, configure `S3Storage` with `endpoint_url`, upload a file, and compare `.url` with `querystring_auth` on and off.

**Mini project — "Docs vault":** public avatars on an S3 `default` storage behind a CDN domain, private invoices on a `private` storage served via presigned URLs after a permission check, direct-to-S3 uploads for large files with a Celery post-processing task, orphan cleanup after commit, and a Docker build that runs `collectstatic` with WhiteNoise.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 05 · Django Template Language](topic.html?p=05-templates) · [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation) · [Ch 18 · Middleware](topic.html?p=18-middleware) · [Ch 19 · Signals](topic.html?p=19-signals) · [Ch 28 · Security](topic.html?p=28-security) · [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks) · [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production)

**Other handbooks:** [System Design · CDN](../system-design/topic.html?p=11-cdn) · [REST API · HTTP Caching & ETags](../rest-api/topic.html?p=25-http-caching-etags) · [Docker · Multi-stage Builds](../docker/topic.html?p=07-multistage-builds) · [Docker · Volumes & Storage](../docker/topic.html?p=13-volumes-storage) · [System Design · Design Dropbox](../system-design/topic.html?p=40-design-dropbox)

**Free resources:**
- **Managing static files (how-to)** — Django docs · *Beginner* · setup, `{% static %}`, development serving. <https://docs.djangoproject.com/en/5.2/howto/static-files/>
- **How to deploy static files** — Django docs · *Intermediate* · production strategies, CDN, remote storage. <https://docs.djangoproject.com/en/5.2/howto/static-files/deployment/>
- **The staticfiles app reference** — Django docs · *Intermediate* · finders, `collectstatic`, Manifest storage options. <https://docs.djangoproject.com/en/5.2/ref/contrib/staticfiles/>
- **Managing files** — Django docs · *Intermediate* · `FileField`, `File`, storage API, `STORAGES`. <https://docs.djangoproject.com/en/5.2/topics/files/>
- **File uploads** — Django docs · *Intermediate* · `request.FILES`, upload handlers, size settings. <https://docs.djangoproject.com/en/5.2/topics/http/file-uploads/>
- **WhiteNoise documentation** — whitenoise.readthedocs.io · *Beginner* · Django integration, compression, CDN setup. <https://whitenoise.readthedocs.io/>
- **django-storages documentation** — django-storages.readthedocs.io · *Intermediate* · S3/GCS/Azure backends and their options. <https://django-storages.readthedocs.io/>

---

*Django Handbook — chapter 20.*
