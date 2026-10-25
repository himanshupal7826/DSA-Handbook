# 26 · Permissions, Groups & Authorization

> **In one line:** Authentication tells you *who* is calling; authorization decides *what they may do to which object* — Django gives you model-level permissions, groups and a pluggable backend chain for free, but object-level and tenant-level rules are your job, and the safest place to enforce them is the queryset, not the template.

---

## 1. Overview

> **Builds on:** [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user) (users, backends, `AUTH_USER_MODEL`), [Ch 17 · Class-Based Views](topic.html?p=17-class-based-views) (mixins and `dispatch`), [Ch 07 · The Django Admin](topic.html?p=07-django-admin) (where model permissions are most visible).

Every non-trivial app eventually needs to answer the question "may this user do this thing?". The naive answer is a scattering of `if request.user.is_staff:` checks in views and `{% if user.is_superuser %}` in templates. It works for the first week. Then a product manager asks for "editors who can publish but not delete", a support role that can *view* orders but not refund them, and customers who must only ever see *their own* invoices. The boolean flags cannot express any of that, the checks drift apart between views, templates and the API, and one forgotten `if` in a new endpoint becomes an **IDOR** (insecure direct object reference) — the single most common authorization bug in web applications.

Django's answer is a small, layered system inside `django.contrib.auth`:

- A **`Permission`** table with one row per *(model, action)* — `add`, `change`, `delete` and `view` are generated automatically for every model, and you can declare custom ones like `publish_article`.
- **Groups** that bundle permissions so you assign *roles*, not individual rights — this is Django's built-in **RBAC**.
- **`user.has_perm("app_label.codename")`**, which asks every configured **authentication backend** in turn. The default `ModelBackend` answers from the user's own permissions plus their groups' permissions.
- Decorators and mixins (`@permission_required`, `PermissionRequiredMixin`, `LoginRequiredMixin`, `UserPassesTestMixin`) to enforce checks at the view boundary, plus the `perms` proxy in templates for hiding UI.

What Django does **not** do out of the box is **object-level permissions** — "Alice may edit *this* article but not *that* one". The `has_perm(perm, obj)` signature exists, but `ModelBackend` returns `False` for any call that passes an object. You fill that gap with ownership rules in `get_queryset()`, with a rules engine such as **django-rules**, or with a per-row permission table such as **django-guardian**. In multi-tenant SaaS, the most important authorization rule of all — "never show tenant A's data to tenant B" — is not a permission at all; it is a mandatory filter on every queryset.

This chapter covers the mechanism end to end: how permissions are created, how `has_perm` resolves them (and caches them), how to enforce them in function views, CBVs, templates, the admin and DRF, how to do object-level and tenant-scoped authorization correctly, and the production failures (stale permission caches, missing permissions in data migrations, 403-vs-404 leaks) interviewers love to probe.

## 2. Core Concepts

- **Authentication vs authorization** — authentication establishes identity (`request.user`); authorization decides whether that identity may perform an action. *Why it matters:* interviewers open with this distinction; mixing them up is a red flag.
- **`Permission` model** — rows of `(name, content_type, codename)`, e.g. codename `change_article` for content type `blog.article`. *Why:* permissions are data, so you can assign them at runtime without a deploy.
- **Default permissions** — `add_`, `change_`, `delete_`, `view_` per model, created by a `post_migrate` handler. `view` was added in Django 2.1. *Why:* the admin and `DjangoModelPermissions` rely on them; `Meta.default_permissions = ()` disables them.
- **Custom permissions** — `Meta.permissions = [("publish_article", "Can publish article")]`. *Why:* model actions beyond CRUD ("publish", "refund", "export") deserve named rights.
- **Group** — a named set of permissions; users get the union of their direct and group permissions. *Why:* assign roles once instead of 40 permissions per new hire.
- **`is_active`, `is_staff`, `is_superuser`** — inactive users have no permissions; `is_staff` only gates admin *login*; an active superuser has *every* permission. *Why:* `is_staff` is not an authorization system.
- **`has_perm` / `has_perms` / `has_module_perms`** — methods on `PermissionsMixin` that delegate to backends. Permission strings are `"<app_label>.<codename>"`. *Why:* the most common bug is passing `"change_article"` without the app label — it silently returns `False`.
- **Authentication backend** — any class in `AUTHENTICATION_BACKENDS`; it may implement `has_perm`, `get_all_permissions`, etc. *Why:* this is the extension point for object permissions (guardian, rules).
- **`PermissionDenied`** — raising it in a backend's `has_perm` short-circuits the chain to `False`; raising it in a view produces a 403. *Why:* explicit deny beats "nobody said yes".
- **Object-level permission** — a rule about a specific row. Not supported by `ModelBackend`. *Why:* almost every real app needs it.
- **Queryset scoping** — filtering `get_queryset()` by owner or tenant so unauthorized rows are simply not reachable. *Why:* it fixes IDOR at the root and protects list endpoints that never call an object check.
- **RBAC vs ABAC** — role-based (groups) vs attribute-based (rules over user, object and context attributes). *Why:* design rounds ask which you would choose; see [REST API · Authorization: RBAC & ABAC](../rest-api/topic.html?p=21-authorization-rbac-abac).

## 3. Theory & Principles

### How permissions come into existence

Permissions are not created by `makemigrations`. After every `migrate`, Django fires the `post_migrate` signal, and `django.contrib.auth`'s handler `create_permissions()` walks every installed model, computes the default and `Meta.permissions` codenames, and `bulk_create`s whatever rows are missing. It **never deletes** rows. Consequences:

1. In a fresh test database permissions exist only after migrations finish — a `RunPython` data migration that does `Permission.objects.get(codename="publish_article")` can fail with `DoesNotExist` because `post_migrate` has not run yet for that app.
2. Renaming a model or a codename leaves the old `Permission` row behind and creates a new one; groups still point at the old row. You must migrate assignments yourself.
3. Permissions are keyed by `ContentType`, which is keyed by `(app_label, model)`. Proxy models get their own content type and permissions (since Django 2.2).

### How `user.has_perm()` resolves

`PermissionsMixin.has_perm(perm, obj=None)` does three things:

1. If the user `is_active` and `is_superuser`, return `True` immediately — **even when `obj` is passed**.
2. Otherwise call `django.contrib.auth.models._user_has_perm(user, perm, obj)`, which iterates `auth.get_backends()` in `AUTHENTICATION_BACKENDS` order.
3. For each backend that defines `has_perm`: if it returns `True`, the answer is `True`; if it raises `PermissionDenied`, the answer is `False` and remaining backends are skipped; otherwise continue. If nobody says yes, `False`.

`ModelBackend.has_perm` checks `user_obj.is_active` and then whether `perm` is in `get_all_permissions(user_obj, obj)`. That method returns an **empty set whenever `obj is not None`** — which is exactly why `ModelBackend` "does not support object permissions". For `obj=None`, it builds the set from two queries (user permissions and group permissions) and caches them on the user instance as `_user_perm_cache`, `_group_perm_cache` and `_perm_cache`.

The diagram shows the resolution chain with a third-party object backend plugged in.

```svg
<svg viewBox="0 0 860 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj26a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="dj26b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="dj26c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">user.has_perm("blog.change_article", obj) resolution</text>
  <rect x="20" y="50" width="190" height="44" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="115" y="68" text-anchor="middle" fill="#1e293b" font-weight="bold">PermissionsMixin.has_perm</text>
  <text x="115" y="84" text-anchor="middle" fill="#334155" font-size="10">perm string + optional obj</text>
  <path d="M210,72 L262,72" stroke="#334155" stroke-width="2" marker-end="url(#dj26a)"/>
  <rect x="264" y="46" width="200" height="52" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="364" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">is_active and is_superuser?</text>
  <text x="364" y="84" text-anchor="middle" fill="#334155" font-size="10">checked before any backend</text>
  <path d="M464,72 L560,72" stroke="#16a34a" stroke-width="2" marker-end="url(#dj26b)"/>
  <text x="512" y="64" text-anchor="middle" fill="#16a34a" font-size="10">yes</text>
  <rect x="562" y="50" width="270" height="44" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="697" y="70" text-anchor="middle" fill="#1e293b" font-weight="bold">return True</text>
  <text x="697" y="86" text-anchor="middle" fill="#334155" font-size="10">even for object checks</text>
  <path d="M364,98 L364,130" stroke="#334155" stroke-width="2" marker-end="url(#dj26a)"/>
  <text x="378" y="118" fill="#334155" font-size="10">no: _user_has_perm iterates AUTHENTICATION_BACKENDS</text>
  <rect x="40" y="134" width="370" height="130" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="225" y="154" text-anchor="middle" fill="#1e293b" font-weight="bold">1. ModelBackend</text>
  <text x="56" y="176" fill="#334155" font-size="10">obj is not None: get_all_permissions returns empty set</text>
  <text x="56" y="194" fill="#334155" font-size="10">obj is None: user_permissions UNION group permissions</text>
  <text x="56" y="212" fill="#334155" font-size="10">2 queries first time, then cached in _perm_cache</text>
  <text x="56" y="230" fill="#334155" font-size="10">cache lives on THIS user instance only</text>
  <text x="56" y="250" fill="#2563eb" font-size="10">returns True or falls through</text>
  <rect x="450" y="134" width="380" height="130" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="640" y="154" text-anchor="middle" fill="#1e293b" font-weight="bold">2. Object backend (guardian / rules)</text>
  <text x="466" y="176" fill="#334155" font-size="10">guardian: looks up UserObjectPermission rows</text>
  <text x="466" y="194" fill="#334155" font-size="10">  and GroupObjectPermission rows for (perm, obj)</text>
  <text x="466" y="212" fill="#334155" font-size="10">rules: evaluates a predicate, e.g. is_author(user, obj)</text>
  <text x="466" y="230" fill="#334155" font-size="10">may raise PermissionDenied = hard deny</text>
  <text x="466" y="250" fill="#7c3aed" font-size="10">returns True, None/False, or raises</text>
  <path d="M410,200 L448,200" stroke="#334155" stroke-width="2" marker-end="url(#dj26a)"/>
  <path d="M225,264 L225,310" stroke="#16a34a" stroke-width="2" marker-end="url(#dj26b)"/>
  <path d="M640,264 L640,310" stroke="#dc2626" stroke-width="2" marker-end="url(#dj26c)"/>
  <rect x="40" y="312" width="370" height="60" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="225" y="336" text-anchor="middle" fill="#1e293b" font-weight="bold">first backend returning True wins</text>
  <text x="225" y="356" text-anchor="middle" fill="#334155" font-size="10">order of AUTHENTICATION_BACKENDS matters</text>
  <rect x="450" y="312" width="380" height="60" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="640" y="336" text-anchor="middle" fill="#1e293b" font-weight="bold">PermissionDenied or nobody says yes: False</text>
  <text x="640" y="356" text-anchor="middle" fill="#334155" font-size="10">default is deny</text>
</svg>
```

### Principles worth stating in an interview

- **Default deny.** Nothing is allowed unless a backend affirmatively says yes. Your own checks should follow the same shape: start from "no", add explicit allows.
- **Enforce on the server, at the narrowest point.** Hiding a button in a template is UX, not security. The authoritative check belongs in the view (and ideally in the queryset), so that the API, the admin and a hand-crafted `curl` all hit it.
- **Model permissions are coarse; object rules are domain logic.** "Can change articles" is a role; "can change *this* article because they wrote it and it is unpublished" is a rule. Keep both, and combine them: model permission as the gate, object rule as the refinement.
- **Scope before you check.** A list endpoint never calls an object check. If `get_queryset()` returns every row, `has_object_permission` on the detail view protects nothing on the list view.
- **Least privilege.** Superuser is a break-glass account, not a role. Staff + specific groups for humans; service accounts with only the permissions their job needs.

### Permission caching semantics

Because `ModelBackend` caches on the *instance*, adding a permission to a user during a request does not take effect on that same `user` object:

```python
user.user_permissions.add(Permission.objects.get(codename="publish_article"))
user.has_perm("blog.publish_article")   # False - _perm_cache already populated
user = User.objects.get(pk=user.pk)     # re-fetch to drop the cache
user.has_perm("blog.publish_article")   # True
```

Across requests this is a non-issue: `AuthenticationMiddleware` loads a fresh user from the session on every request (lazily, via `SimpleLazyObject`). It does mean every request that calls `has_perm` pays two permission queries on first use. That is fine for most apps; at high request rates you can cache the permission set yourself (keyed on user id plus a version you bump on role changes).

## 4. Architecture & Workflow

Authorization is not a single check but a set of layers, each catching a different class of bug. A well-built Django request passes through all of them.

```svg
<svg viewBox="0 0 860 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj26d" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Layered authorization for GET/PATCH /articles/42/</text>
  <rect x="20" y="44" width="560" height="56" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="36" y="66" fill="#1e293b" font-weight="bold">Layer 1 - Authentication (middleware)</text>
  <text x="36" y="86" fill="#334155" font-size="10">AuthenticationMiddleware sets request.user; LoginRequiredMiddleware (5.1+) or LoginRequiredMixin</text>
  <rect x="20" y="114" width="560" height="56" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="36" y="136" fill="#1e293b" font-weight="bold">Layer 2 - Model / role permission (view entry)</text>
  <text x="36" y="156" fill="#334155" font-size="10">PermissionRequiredMixin: has_perm("blog.change_article") via groups; fail = 403</text>
  <rect x="20" y="184" width="560" height="56" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="36" y="206" fill="#1e293b" font-weight="bold">Layer 3 - Queryset scoping (get_queryset)</text>
  <text x="36" y="226" fill="#334155" font-size="10">Article.objects.filter(tenant=request.tenant); other tenants' rows are unreachable = 404</text>
  <rect x="20" y="254" width="560" height="56" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="36" y="276" fill="#1e293b" font-weight="bold">Layer 4 - Object rule (get_object + check)</text>
  <text x="36" y="296" fill="#334155" font-size="10">has_perm("blog.change_article", article): author, or editor while unpublished</text>
  <rect x="20" y="324" width="560" height="56" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="36" y="346" fill="#1e293b" font-weight="bold">Layer 5 - Field / state rules (form or serializer)</text>
  <text x="36" y="366" fill="#334155" font-size="10">only editors may set status=published; read-only fields per role</text>
  <path d="M600,72 L600,352" stroke="#2563eb" stroke-width="2" marker-end="url(#dj26d)"/>
  <rect x="620" y="44" width="220" height="336" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="730" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">What each layer catches</text>
  <text x="634" y="92" fill="#334155" font-size="10">1: anonymous access</text>
  <text x="634" y="162" fill="#334155" font-size="10">2: wrong role entirely</text>
  <text x="634" y="226" fill="#334155" font-size="10">3: cross-tenant IDOR,</text>
  <text x="634" y="240" fill="#334155" font-size="10">   list-endpoint leaks</text>
  <text x="634" y="296" fill="#334155" font-size="10">4: same tenant, not owner</text>
  <text x="634" y="366" fill="#334155" font-size="10">5: privilege escalation</text>
  <text x="634" y="380" fill="#334155" font-size="10">   via extra fields</text>
  <text x="430" y="410" text-anchor="middle" fill="#334155" font-size="10">Templates ({% if perms.blog.change_article %}) only hide buttons - they are never a layer.</text>
</svg>
```

### Where the check lives in each Django surface

| Surface | Gate (role) | Object / scope | Notes |
|---|---|---|---|
| Function view | `@login_required`, `@permission_required("blog.change_article", raise_exception=True)` | `get_object_or_404(Article.objects.filter(owner=request.user), pk=pk)` | `user_passes_test` for arbitrary predicates |
| Class-based view | `LoginRequiredMixin`, `PermissionRequiredMixin` | override `get_queryset()`; `has_permission()` | mixins must come **left** of the view class |
| Template | `{% if perms.blog.change_article %}` | `{% if article.author_id == user.id %}` | cosmetic only |
| Admin | model perms automatically; `has_change_permission(request, obj)` | `get_queryset(request)` | `is_staff` needed to log in at all |
| DRF | `permission_classes`, `DjangoModelPermissions` | `get_queryset()`, `has_object_permission` | object check skipped for list; see [Ch 23](topic.html?p=23-drf-auth-permissions-throttling) |

### Decorator and mixin flow

```text
request ──▶ LoginRequiredMixin.dispatch
              └─ not authenticated? ──▶ handle_no_permission() ──▶ 302 to LOGIN_URL?next=...
          ──▶ PermissionRequiredMixin.dispatch
              └─ not has_permission()? ──▶ handle_no_permission()
                       authenticated + raise_exception=False ──▶ 403 PermissionDenied
          ──▶ View.dispatch ──▶ get()/post() ──▶ get_object() ──▶ get_queryset() (scoped)
```

`AccessMixin.handle_no_permission()` redirects anonymous users to the login page and raises `PermissionDenied` (403) for authenticated users when `raise_exception` is false — the sensible default since Django 2.1. The function decorator `@permission_required` is cruder: without `raise_exception=True` it redirects *authenticated* users to the login page too, which creates login loops.

## 5. Implementation

### Simple example: custom permissions, groups, and view checks

```python
# blog/models.py
from django.conf import settings
from django.db import models


class Article(models.Model):
    class Status(models.TextChoices):
        DRAFT = "draft", "Draft"
        PUBLISHED = "published", "Published"

    title = models.CharField(max_length=200)
    body = models.TextField()
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="articles")
    status = models.CharField(max_length=10, choices=Status, default=Status.DRAFT)

    class Meta:
        permissions = [
            ("publish_article", "Can publish article"),
            ("export_article", "Can export articles"),
        ]
```

Create roles in a data migration. Because default and custom permissions are created by `post_migrate`, the migration must create them explicitly first (or depend on a later step). The reliable trick is to call `create_permissions` for the app inside the migration:

```python
# blog/migrations/0003_roles.py
from django.contrib.auth.management import create_permissions
from django.db import migrations


def create_roles(apps, schema_editor):
    for app_config in apps.get_app_configs():
        app_config.models_module = True          # required by create_permissions
        create_permissions(app_config, apps=apps, verbosity=0)
        app_config.models_module = None

    Group = apps.get_model("auth", "Group")
    Permission = apps.get_model("auth", "Permission")
    perms = lambda *codes: Permission.objects.filter(content_type__app_label="blog", codename__in=codes)

    writer, _ = Group.objects.get_or_create(name="Writer")
    writer.permissions.set(perms("add_article", "change_article", "view_article"))

    editor, _ = Group.objects.get_or_create(name="Editor")
    editor.permissions.set(perms("add_article", "change_article", "view_article",
                                 "delete_article", "publish_article"))


class Migration(migrations.Migration):
    dependencies = [("blog", "0002_article_status"), ("auth", "0012_alter_user_first_name_max_length"),
                    ("contenttypes", "0002_remove_content_type_name")]
    operations = [migrations.RunPython(create_roles, migrations.RunPython.noop)]
```

Enforce in views:

```python
# blog/views.py
from django.contrib.auth.decorators import login_required, permission_required
from django.contrib.auth.mixins import LoginRequiredMixin, PermissionRequiredMixin
from django.shortcuts import get_object_or_404, redirect
from django.views.generic import UpdateView

from .models import Article


@login_required
@permission_required("blog.publish_article", raise_exception=True)
def publish(request, pk):
    article = get_object_or_404(Article, pk=pk)
    if request.method == "POST":
        article.status = Article.Status.PUBLISHED
        article.save(update_fields=["status"])
    return redirect("article-detail", pk=pk)


class ArticleUpdate(LoginRequiredMixin, PermissionRequiredMixin, UpdateView):
    model = Article
    fields = ["title", "body"]
    permission_required = "blog.change_article"

    def get_queryset(self):
        qs = super().get_queryset()
        if self.request.user.has_perm("blog.publish_article"):   # editors see all
            return qs
        return qs.filter(author=self.request.user)               # writers: own only -> others 404
```

And in templates (the `auth` context processor provides `perms`):

```html
{% if perms.blog.publish_article and article.status == "draft" %}
  <form method="post" action="{% url 'article-publish' article.pk %}">
    {% csrf_token %}<button>Publish</button>
  </form>
{% endif %}
{% if perms.blog %}<a href="{% url 'article-dashboard' %}">Blog dashboard</a>{% endif %}
```

Quick shell check of the resolution behaviour:

```text
>>> u = User.objects.get(username="wendy"); u.groups.add(Group.objects.get(name="Writer"))
>>> u = User.objects.get(pk=u.pk)
>>> u.has_perm("blog.change_article")
True
>>> u.has_perm("change_article")          # missing app label
False
>>> u.has_perm("blog.change_article", some_article)   # ModelBackend ignores objects
False
>>> u.get_all_permissions()
{'blog.add_article', 'blog.change_article', 'blog.view_article'}
```

### Real-world example: object rules with django-rules, plus tenant scoping

django-rules gives you object-level permissions as **predicates** — plain Python functions — without any extra tables. It plugs in as a backend, so `has_perm(perm, obj)`, `PermissionRequiredMixin` and DRF's object checks all just work.

```bash
pip install "django~=5.2" django-rules
```

```python
# settings.py
INSTALLED_APPS += ["rules.apps.AutodiscoverRulesConfig"]   # imports each app's rules.py
AUTHENTICATION_BACKENDS = [
    "rules.permissions.ObjectPermissionBackend",
    "django.contrib.auth.backends.ModelBackend",
]
```

```python
# blog/rules.py
import rules


@rules.predicate
def is_author(user, article):
    return article is not None and article.author_id == user.id


@rules.predicate
def is_draft(user, article):
    return article is not None and article.status == "draft"


is_editor = rules.is_group_member("Editor")
same_tenant = rules.predicate(lambda user, obj: obj is None or obj.tenant_id == user.tenant_id)

rules.add_perm("blog.view_article", same_tenant)
rules.add_perm("blog.change_article", same_tenant & (is_editor | (is_author & is_draft)))
rules.add_perm("blog.delete_article", same_tenant & is_editor)
rules.add_perm("blog.publish_article", same_tenant & is_editor)
```

Note the `obj is None` handling: `PermissionRequiredMixin` calls `has_perms` *without* an object at dispatch time. Predicates that crash on `None` break the whole view. With django-rules you can make CBVs check against the object by using its mixin:

```python
# blog/views.py
from rules.contrib.views import PermissionRequiredMixin as ObjectPermissionRequiredMixin


class TenantScopedMixin:
    """Every queryset is filtered by the request's tenant. Non-negotiable."""
    def get_queryset(self):
        return super().get_queryset().filter(tenant_id=self.request.user.tenant_id)


class ArticleEdit(LoginRequiredMixin, TenantScopedMixin, ObjectPermissionRequiredMixin, UpdateView):
    model = Article
    fields = ["title", "body"]
    permission_required = "blog.change_article"   # checked against self.get_object()
    raise_exception = True
```

The generated SQL for the scoped detail lookup shows why cross-tenant guessing returns 404 rather than 403 — the row is never fetched:

```sql
SELECT "blog_article"."id", "blog_article"."title", "blog_article"."body",
       "blog_article"."author_id", "blog_article"."status", "blog_article"."tenant_id"
FROM "blog_article"
WHERE ("blog_article"."tenant_id" = 7 AND "blog_article"."id" = 42)
LIMIT 21;
```

The same rules power DRF. `has_object_permission` delegates to `has_perm(perm, obj)`, and the list view relies on `get_queryset()`:

```python
# blog/api.py
from rest_framework import permissions, viewsets
from .models import Article
from .serializers import ArticleSerializer


class RulesObjectPermission(permissions.BasePermission):
    action_map = {"retrieve": "view", "update": "change", "partial_update": "change", "destroy": "delete"}

    def has_permission(self, request, view):
        return request.user.is_authenticated

    def has_object_permission(self, request, view, obj):
        action = self.action_map.get(view.action, "view")
        return request.user.has_perm(f"blog.{action}_article", obj)


class ArticleViewSet(viewsets.ModelViewSet):
    serializer_class = ArticleSerializer
    permission_classes = [RulesObjectPermission]

    def get_queryset(self):   # list endpoint never calls has_object_permission
        return Article.objects.filter(tenant_id=self.request.user.tenant_id).select_related("author")

    def perform_create(self, serializer):
        serializer.save(author=self.request.user, tenant_id=self.request.user.tenant_id)
```

### When you need per-row grants: django-guardian

Rules are computed; sometimes grants are *data* — "share this document with Bob". django-guardian stores `(user|group, permission, content_type, object_pk)` rows:

```python
# settings: AUTHENTICATION_BACKENDS = ["django.contrib.auth.backends.ModelBackend",
#                                      "guardian.backends.ObjectPermissionBackend"]
from guardian.shortcuts import assign_perm, get_objects_for_user, remove_perm

assign_perm("docs.view_document", bob, doc)
bob.has_perm("docs.view_document", doc)        # True
visible = get_objects_for_user(bob, "docs.view_document", klass=Document)  # queryset, use for lists
remove_perm("docs.view_document", bob, doc)
```

Use `get_objects_for_user` (a subquery, not a Python loop) for list views. Guardian's generic `object_pk` is a `CharField`, so for large tables use its **direct foreign key** models (`UserObjectPermissionBase` subclasses) to get real FKs and indexes.

### Admin integration

```python
# blog/admin.py
from django.contrib import admin
from .models import Article


@admin.register(Article)
class ArticleAdmin(admin.ModelAdmin):
    list_display = ["title", "author", "status"]

    def get_queryset(self, request):
        qs = super().get_queryset(request)
        return qs if request.user.is_superuser else qs.filter(tenant_id=request.user.tenant_id)

    def has_change_permission(self, request, obj=None):
        if not super().has_change_permission(request, obj):
            return False
        return obj is None or request.user.has_perm("blog.change_article", obj)

    def get_readonly_fields(self, request, obj=None):
        return [] if request.user.has_perm("blog.publish_article") else ["status"]
```

## 6. Advantages, Disadvantages & Trade-offs

| Approach | Strengths | Weaknesses | Best for |
|---|---|---|---|
| `is_staff` / `is_superuser` flags | Zero setup | Two roles, no granularity | Admin login, break-glass only |
| Model permissions + Groups (built-in) | Data-driven, admin UI, works with DRF `DjangoModelPermissions` | No object level; permission rows drift on renames | Role-based internal tools |
| Ownership in `get_queryset()` | Fast (one indexed filter), fixes IDOR, protects lists | Logic spread across views unless shared mixin | Every app, always |
| django-rules (predicates) | No DB tables, readable, testable, object-aware | Not queryable: cannot turn a predicate into a filter automatically | Rule-based ABAC, "author or editor while draft" |
| django-guardian (per-row grants) | Ad-hoc sharing, admin integration, queryable via `get_objects_for_user` | Extra table grows with rows x users; generic FK slow without direct FK models | Document sharing, explicit ACLs |
| External policy engine (OPA, Oso, OpenFGA) | Central policy across services, relationship graphs | Network hop, operational cost, new language | Many services, Zanzibar-style sharing |

### When to use

- **Built-in permissions + groups** whenever you have staff roles and the admin; it is free and auditors understand it.
- **Queryset scoping** on every endpoint that returns user- or tenant-owned data, without exception.
- **django-rules** when access depends on attributes (author, status, tenant, time) and grants are not stored per row.
- **django-guardian** when users explicitly share specific objects with other users or groups.

### When NOT to use

- Do not use guardian to express "owner can edit" — that is a predicate, and storing a row per object per owner wastes space and drifts.
- Do not use model permissions as tenant isolation — `has_perm("blog.view_article")` is true for every tenant's articles.
- Do not reach for an external policy engine in a single monolith with a handful of roles; it adds latency to every request.
- Do not rely on template checks or hidden form fields for anything security-relevant.

## 7. Common Mistakes & Best Practices

**1. Permission string without the app label.** People write `has_perm("change_article")`; it never matches because permission strings are `"app_label.codename"`. It fails closed, so you see mysterious 403s. Always use `"blog.change_article"`, and add a test that asserts a role *can* do its job, not only that strangers cannot.

**2. Checking the object in the detail view only.** The detail endpoint calls `get_object()` and an object check; the list endpoint returns `Article.objects.all()`. Attackers just call the list. Fix: scope `get_queryset()`, which both views share.

```python
# Before: IDOR on the list, object check only on detail
class InvoiceViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = Invoice.objects.all()
    permission_classes = [IsOwner]           # has_object_permission only

# After: unauthorized rows are unreachable everywhere
class InvoiceViewSet(viewsets.ReadOnlyModelViewSet):
    permission_classes = [IsAuthenticated]
    def get_queryset(self):
        return Invoice.objects.filter(customer__user=self.request.user)
```

**3. Mixin order.** `class V(UpdateView, LoginRequiredMixin)` — `UpdateView.dispatch` runs first and the mixin's `dispatch` is never reached before the handler. Access mixins go **leftmost**.

**4. `@permission_required` without `raise_exception=True`.** An authenticated user without the permission is redirected to the login page, logs in, is redirected back, and loops. Use `raise_exception=True` for authenticated areas.

**5. Using `is_staff` as "admin role".** `is_staff` only lets a user log into the admin; what they can do there is controlled by permissions. Granting `is_staff` + superuser to support agents is how a support account deletes production data.

**6. Data migration referencing permissions that do not exist yet.** In a fresh database `Permission.objects.get(...)` fails. Call `create_permissions` inside the migration as shown, or create the roles in a management command run after `migrate`.

**7. Expecting a just-granted permission to apply to the same user instance.** `_perm_cache` holds the old set. Re-fetch the user (`User.objects.get(pk=...)`) after changing permissions in the same request or test.

**8. Returning 403 for other tenants' objects.** A 403 confirms the object exists, enabling enumeration. For resources the user should not know about, return 404 (which scoping gives you for free); return 403 when the user can see the object but not perform the action.

**9. Field-level escalation.** A writer's edit form includes `status`, so a writer POSTs `status=published`. Per-role `fields` / `get_form_class()` / serializer `read_only_fields`, and validate state transitions server-side.

**Best practices:** one `TenantScopedMixin` (or custom manager method `for_user(user)`) used everywhere; roles defined in code (migration or command) so every environment matches; deny-by-default DRF setting `DEFAULT_PERMISSION_CLASSES = ["rest_framework.permissions.IsAuthenticated"]`; consider `LoginRequiredMiddleware` (Django 5.1+) with `@login_not_required` on public views so new views are private by default; test authorization with a matrix of (role x action x object owner).

## 8. Production: Pitfalls, Debugging & Scaling

**Production story — the list endpoint leak.** A B2B app had `has_object_permission` checks on every detail route and a pentest passed. Six months later a mobile developer added `?ids=1,2,3` bulk fetching to the list route. *Symptom:* customer reports seeing another company's invoices. *Root cause:* the list `get_queryset()` filtered only by `ids`, never by tenant; object checks never ran. *Fix:* a base viewset that raises `ImproperlyConfigured` if a subclass's queryset is not filtered by tenant, plus a test that hits every registered route as a user from another tenant and asserts 404/empty.

**Stale permissions after a rename.** Renaming `Post` to `Article` created `change_article` while groups still held `change_post`. *Symptom:* editors suddenly get 403 after deploy. *Fix:* in the rename migration, update the existing `Permission` rows' codename and the `ContentType.model` instead of letting new ones be created; run `manage.py remove_stale_contenttypes` afterwards to clean leftovers (it cascades to their permissions — check first).

**Permission query overhead.** Each request that calls `has_perm` costs two queries (user perms, group perms) on first call. In a template loop over 50 rows calling a custom `can_edit` that re-fetches the user, it becomes 100. *Debug:* django-debug-toolbar's SQL panel, or `assertNumQueries` in tests. *Fix:* call `has_perm` once per request and pass the boolean down; never re-fetch the user per row.

**Object-permission tables at scale.** guardian's `UserObjectPermission` table is `rows x grantees`. With millions of documents shared to whole organizations, grant to *groups*, use direct-FK permission models, and index `(permission_id, user_id, object_pk)`. When sharing becomes graph-shaped (folders containing documents shared via teams), move to a relationship-based system (Zanzibar-style, e.g. OpenFGA/SpiceDB) rather than exploding rows.

**Debugging a 403.**

```python
from django.contrib.auth import get_backends
u = User.objects.get(username="wendy")
print(u.is_active, u.is_superuser, list(u.groups.values_list("name", flat=True)))
print(sorted(u.get_all_permissions()))
for b in get_backends():
    print(type(b).__name__, getattr(b, "has_perm", None) and b.has_perm(u, "blog.change_article", article))
```

Log authorization denials (user id, permission, object id, route) at INFO with a structured logger; a spike in denials after a deploy is the earliest signal of a broken role migration, and a spike from one user is an enumeration attempt.

**Auditing.** Regulated environments need "who granted Alice refunds and when". Permission and group M2M changes fire `m2m_changed`; record them to an audit table, or use django-simple-history / django-auditlog on your role models.

## 9. Interview Questions

**Q: What is the difference between authentication and authorization in Django?**
A: Authentication answers "who are you?" — `authenticate()` iterates `AUTHENTICATION_BACKENDS` to verify credentials, `login()` stores the user id in the session, and `AuthenticationMiddleware` puts the user on `request.user`. Authorization answers "may you do this?" — `has_perm`, groups, decorators, mixins and your own object rules. They share the backend mechanism: a backend can implement both `authenticate()` and `has_perm()`. A 401 means "not authenticated", a 403 means "authenticated but not allowed".

**Q: What default permissions does Django create, and when are they created?**
A: For every model, `add_<model>`, `change_<model>`, `delete_<model>` and `view_<model>` (view since 2.1), plus anything in `Meta.permissions`. They are created by the `create_permissions` handler connected to the `post_migrate` signal, not by a migration file. That is why they do not exist in the middle of a migration run on a fresh database, and why they are never deleted automatically when models are renamed or removed. `Meta.default_permissions` lets you change or disable the defaults.

**Q: How does `user.has_perm()` work internally?**
A: `PermissionsMixin.has_perm` first returns `True` for an active superuser. Otherwise it calls `_user_has_perm`, which loops over the backends in `AUTHENTICATION_BACKENDS` order: the first backend returning `True` grants, a backend raising `PermissionDenied` denies immediately, and if nobody grants the result is `False`. `ModelBackend` builds the set of the user's direct and group permissions with two queries and caches it on the user instance. Permission strings must be `"app_label.codename"`.

**Q: Does Django support object-level permissions out of the box?**
A: The API does — `has_perm(perm, obj)` and `get_all_permissions(obj)` accept an object — but the default `ModelBackend` returns an empty set whenever an object is passed, so object checks return `False` (except for superusers, who short-circuit to `True`). You implement object level by scoping querysets by ownership, by adding a backend like django-rules (predicates) or django-guardian (per-row grant table), or by writing your own backend. Always combine it with queryset scoping, because list views never perform object checks.

**Q: What is the difference between `is_staff`, `is_superuser` and permissions?**
A: `is_staff` only controls whether the user can log into the admin site. `is_superuser` makes an active user pass every `has_perm` check without any explicit assignment. Permissions are the granular grants that decide what a staff user can actually do in the admin and what your views allow. A staff user with no permissions can log into the admin and sees nothing. Inactive users (`is_active=False`) have no permissions at all from `ModelBackend`, even if they are superusers.

**Q: How do `LoginRequiredMixin`, `PermissionRequiredMixin` and `UserPassesTestMixin` differ, and why does mixin order matter?**
A: All three extend `AccessMixin` and override `dispatch`. `LoginRequiredMixin` checks `is_authenticated`; `PermissionRequiredMixin` checks `has_perms(self.get_permission_required())` (override `has_permission()` for custom logic); `UserPassesTestMixin` runs your `test_func()`. On failure, `handle_no_permission()` redirects anonymous users to login and raises 403 for authenticated users. They must appear to the left of the view class in the bases, because Python's MRO calls the leftmost `dispatch` first; put them on the right and the view's own dispatch runs the handler before your check.

**Q: How would you prevent users from accessing other users' objects (IDOR)?**
A: Make unauthorized objects unreachable by filtering the queryset: `get_queryset()` returns `Invoice.objects.filter(owner=request.user)`, and `get_object_or_404` operates on that. Then guessing another id yields a 404, the list endpoint is protected by the same code, and no separate check can be forgotten. Add object checks only for finer rules (an owner can view but only an editor can delete). Test it explicitly: log in as user B and request user A's URLs.

**Q: How do permissions work in Django templates?**
A: The `django.contrib.auth.context_processors.auth` context processor exposes `user` and `perms`. `{% if perms.blog.change_article %}` calls `user.has_perm("blog.change_article")`, and `{% if perms.blog %}` calls `has_module_perms("blog")`. The `perms` proxy has no object-level syntax. Template checks are only for hiding UI; the view must enforce the same rule because anyone can send the request directly.

**Q: How do DRF permissions relate to Django permissions?**
A: DRF has its own permission classes with `has_permission(request, view)` (always runs in `initial()`) and `has_object_permission(request, view, obj)` (runs only when `get_object()` calls `check_object_permissions`). `DjangoModelPermissions` maps HTTP methods to Django model permissions — POST to `add`, PUT/PATCH to `change`, DELETE to `delete` — and by default does not require `view` for GET. `DjangoObjectPermissions` calls `has_perm(perm, obj)` and needs an object-capable backend. Details are in [Ch 23](topic.html?p=23-drf-auth-permissions-throttling).

**Q: You added a permission to a user and `has_perm` still returns False. Why?**
A: Most likely the permission cache on that user instance: `ModelBackend` stores the computed set in `_perm_cache` the first time you call `has_perm`, and adding a permission does not invalidate it. Re-fetch the user from the database. Other causes: missing app label in the string, the user is inactive, the permission belongs to a different content type (for example a proxy model), or a backend earlier in the chain raised `PermissionDenied`.

**Q: How would you design authorization for a multi-tenant SaaS application in Django? (Senior)**
A: Treat tenant isolation as a data-layer invariant, not a permission: resolve the tenant in middleware (from subdomain, header or the user's membership), and route every query through a tenant-aware manager or base viewset that filters by `tenant_id`, failing loudly if a view bypasses it. Within a tenant, use groups or a `Membership(user, tenant, role)` model for RBAC, and django-rules predicates for attribute rules ("owner or admin of this tenant"). Every unique constraint and index includes `tenant_id`. For defence in depth on PostgreSQL, add row-level security policies keyed on a session variable set per request, so a forgotten filter still returns nothing. Test with a cross-tenant crawler over every URL, and log denials.

**Q: When would you choose django-guardian over django-rules, and what are the scaling concerns? (Senior)**
A: Choose rules when access is *computed* from attributes already on the data — ownership, status, group membership, tenant — because predicates need no storage and never drift. Choose guardian when access is *granted* explicitly per object, like sharing a document with a colleague, because that fact must be stored. Guardian's tables grow with objects times grantees, and its generic `object_pk` CharField makes joins slow, so use direct-FK permission models, grant to groups rather than users, and use `get_objects_for_user` (a subquery) for lists. Rules' weakness is that predicates cannot be translated to SQL, so you still need a parallel queryset filter for list views. When sharing becomes hierarchical (folders, teams, inheritance), a relationship-based authorization service is a better fit than either.

**Q: How do you handle permission changes when renaming a model, and how do you keep roles consistent across environments? (Senior)**
A: Renaming a model changes the content type and the default codenames; `post_migrate` creates new permissions but leaves the old ones attached to groups, so users silently lose access. In the rename migration, update `ContentType.model` and the `Permission.codename`/`name` rows in place with `RunPython` using `apps.get_model`, so group assignments survive. Define roles in code — a data migration calling `create_permissions` first, or an idempotent `sync_roles` management command run in the release step — so dev, staging and prod have identical groups. Never assign permissions by hand in production except through an audited process.

**Q: Should an unauthorized object request return 403 or 404? (Senior)**
A: It depends on whether the user is allowed to know the object exists. For objects in another tenant or owned by another user, return 404 — a 403 confirms existence and enables enumeration of ids, which is why scoped querysets that naturally 404 are preferred. For objects the user can see but cannot modify (a viewer trying to delete), 403 is correct and more helpful. GitHub's private repositories are the classic example: they return 404 to non-members. Whatever you choose, be consistent and make sure timing and error bodies do not leak the difference.

**Q: How would you implement "editors can publish, writers can only edit their own drafts"?**
A: Two layers. Groups: Writer has `add/change/view_article`, Editor additionally has `publish_article` and `delete_article`. Object rule: `change_article` is allowed if the user is an editor, or is the author and the article is a draft — expressed as a django-rules predicate or as a `get_queryset()` filter plus a status check. The publish action requires `blog.publish_article`, and the writer's form excludes the `status` field so a crafted POST cannot publish. Test each role against each article state.

## 10. Quick Revision & Cheat Sheet

| Need | Tool |
|---|---|
| Must be logged in | `@login_required`, `LoginRequiredMixin`, `LoginRequiredMiddleware` (5.1+) |
| Role check | `@permission_required("app.codename", raise_exception=True)`, `PermissionRequiredMixin` |
| Arbitrary predicate | `@user_passes_test(fn)`, `UserPassesTestMixin.test_func` |
| Custom permission | `Meta.permissions = [("publish_article", "Can publish article")]` |
| Role | `Group` + `group.permissions.set(...)`, `user.groups.add(...)` |
| Ownership / tenant | `get_queryset().filter(owner=request.user)` |
| Object rules | django-rules predicates + `rules.permissions.ObjectPermissionBackend` |
| Per-object grants | django-guardian `assign_perm`, `get_objects_for_user` |
| Template | `{% if perms.app.codename %}` (cosmetic) |
| DRF | `has_permission` always; `has_object_permission` only in `get_object()` |

- Permission strings are `"app_label.codename"`; wrong format returns `False` silently.
- Permissions are created in `post_migrate`, never deleted automatically.
- Active superusers pass every check, including object checks; inactive users pass none.
- `ModelBackend` returns `False` for any object check — object level is your job.
- Permission sets are cached per user instance; re-fetch after changing them.
- Access mixins go leftmost in the class bases.
- List views never run object checks: scope the queryset.
- Prefer 404 for objects the user must not know exist; 403 for visible-but-forbidden.
- `is_staff` = admin login only; it is not a role.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" django-rules djangorestframework`, `django-admin startproject site .`, `python manage.py startapp blog`.

1. **Permission inventory.** Create `Article` with `Meta.permissions`, migrate, then in the shell print `Permission.objects.filter(content_type__app_label="blog").values_list("codename", flat=True)`. Set `default_permissions = ("view",)`, migrate again, and observe that old rows are not deleted.
2. **Cache trap.** In a test, give a user `blog.publish_article` and assert `has_perm` is `False` on the same instance and `True` after re-fetching. Then write a role-matrix test (Writer/Editor/anonymous x view/change/publish/delete).
3. **IDOR hunt.** Build an `InvoiceListView` and `InvoiceDetailView` that use `Invoice.objects.all()` with an ownership check only on detail. Write a test as user B that reads user A's invoices via the list; then fix with a shared `OwnedQuerysetMixin` and watch the test pass.
4. **Mixin order.** Write `class Broken(UpdateView, LoginRequiredMixin)` and confirm anonymous users reach the form; swap the bases and confirm a redirect.
5. **Rules.** Implement the Writer/Editor rules from §5 with django-rules, and verify `has_perm("blog.change_article", article)` across the four combinations of author/editor x draft/published.
6. **Data migration.** Write the roles migration from §5, run `python manage.py flush` and `migrate` on a fresh SQLite DB, and confirm the groups exist with the right permissions.

**Mini project — multi-tenant notes.** `Tenant`, `Membership(user, tenant, role)` and `Note(tenant, author, body, shared_with M2M)`. Requirements: tenant resolved from a header in middleware; a base CBV mixin and a DRF base viewset that scope by tenant; owners and tenant admins can edit; notes can be shared with specific members (model the grant either as the M2M or with django-guardian); a test that crawls every URL as a member of another tenant and asserts 404 or an empty list.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 25 · Authentication & the Custom User Model](topic.html?p=25-authentication-custom-user) · [Ch 23 · DRF Authentication, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling) · [Ch 17 · Class-Based Views](topic.html?p=17-class-based-views) · [Ch 18 · Middleware](topic.html?p=18-middleware) · [Ch 07 · The Django Admin](topic.html?p=07-django-admin) · [Ch 27 · Sessions, Cookies & Messages](topic.html?p=27-sessions-cookies) · [Ch 28 · Security](topic.html?p=28-security) · [Ch 15 · Managers & Model Inheritance](topic.html?p=15-managers-model-inheritance)

**Other handbooks:** [REST API · Authorization: RBAC & ABAC](../rest-api/topic.html?p=21-authorization-rbac-abac) · [REST API · OWASP API Security](../rest-api/topic.html?p=23-owasp-api-security)

- **Using the Django authentication system — Permissions and Authorization** — Django docs · *Beginner* · the official reference for permissions, groups, decorators and mixins. <https://docs.djangoproject.com/en/5.2/topics/auth/default/>
- **Customizing authentication — custom backends and permissions** — Django docs · *Intermediate* · how backends implement `has_perm` and object permissions. <https://docs.djangoproject.com/en/5.2/topics/auth/customizing/>
- **django-rules** — GitHub · *Intermediate* · predicate-based object permissions with no database tables. <https://github.com/dfunckt/django-rules>
- **django-guardian** — GitHub · *Intermediate* · per-object permission grants with admin integration. <https://github.com/django-guardian/django-guardian>
- **DRF Permissions guide** — Django REST framework · *Intermediate* · `has_permission` vs `has_object_permission` and the built-in classes. <https://www.django-rest-framework.org/api-guide/permissions/>
- **OWASP API Security Top 10** — OWASP · *Intermediate* · broken object level authorization is the number-one API risk. <https://owasp.org/www-project-api-security/>
- **Zanzibar: Google's Consistent, Global Authorization System** — USENIX ATC 2019 · *Advanced* · the relationship-based model behind modern authorization services. <https://research.google/pubs/zanzibar-googles-consistent-global-authorization-system/>

---

*Django Handbook — chapter 26.*
