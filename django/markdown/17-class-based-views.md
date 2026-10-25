# 17 · Class-Based & Generic Views

> **In one line:** A class-based view is a function factory: `as_view()` returns a plain function that builds a fresh instance per request and calls `dispatch()`, which routes to `get()`/`post()`; generic views are stacks of small mixins wired together by Python's MRO, so mastering CBVs means knowing which hook (`get_queryset`, `get_object`, `get_context_data`, `form_valid`) each mixin calls and in what order.

---

## 1. Overview

> **Builds on:** [Ch 03 · URL Routing & URLconf](topic.html?p=03-urls-routing), [Ch 04 · Views, HttpRequest & HttpResponse](topic.html?p=04-views-requests-responses), [Ch 05 · Django Template Language](topic.html?p=05-templates), [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation).

A function-based view (FBV) is just `def view(request, ...) -> HttpResponse`. That is perfect for one-off endpoints, but CRUD-heavy apps repeat the same skeleton dozens of times: fetch an object or 404, branch on `request.method`, bind a form, validate, save, redirect, render a template with a context. Copy-paste of that skeleton is the naive approach, and it fails in the usual ways — subtle inconsistencies (one view forgets the 404, another forgets `login_required`), no reuse beyond helper functions, and changes that must be applied in twenty places.

**Class-based views (CBVs)** factor that skeleton into overridable methods. **Generic views** (`ListView`, `DetailView`, `CreateView`, `UpdateView`, `DeleteView`, `FormView`, `TemplateView`, `RedirectView`, date-based views) are prebuilt combinations of **mixins**: `ListView` = `MultipleObjectTemplateResponseMixin` + `BaseListView` (which is `MultipleObjectMixin` + `View`). You customize behaviour by setting attributes (`model`, `paginate_by`, `template_name`) or overriding hook methods.

The cost is **indirection**: the code that runs is spread across six classes, and a newcomer cannot see where the template name or the redirect came from. That is why the classic interview question is "FBV or CBV?", followed by "explain the MRO of this view" and "where do you put the queryset filtering?" This chapter is the home for CBV mechanics; DRF's `APIView`/ViewSets build on exactly the same `as_view()`/`dispatch()` design and are covered in [Ch 22](topic.html?p=22-drf-views-viewsets-routers).

> **Interview tip:** The answer to "FBV or CBV?" is never "CBV is better". It is "CBVs for standard CRUD and shared behaviour via mixins; FBVs for bespoke logic where explicit control flow beats inheritance — and consistency within a codebase matters more than either."

## 2. Core Concepts

- **`View`** — the base class in `django.views.generic.base`. Provides `as_view()`, `setup()`, `dispatch()`, `http_method_not_allowed()`, `options()`. *Why it matters:* every CBV (and DRF's `APIView`) is built on it.
- **`as_view(**initkwargs)`** — classmethod returning a function `view(request, *args, **kwargs)` for the URLconf. *Why it matters:* the URLconf needs a callable; `as_view()` bridges classes to that contract and validates initkwargs.
- **Per-request instance** — `view()` creates `cls(**initkwargs)` on **every** request. *Why it matters:* `self.foo = ...` is request-local and thread-safe; class attributes are shared across all requests.
- **`setup()`** — assigns `self.request`, `self.args`, `self.kwargs` (since 2.2). *Why it matters:* override it to initialize attributes needed by `dispatch()`.
- **`dispatch()`** — looks up `getattr(self, request.method.lower())` if the method is in `http_method_names`, else `http_method_not_allowed` (405). *Why it matters:* the natural place for cross-cutting checks (permission mixins override it).
- **Mixin** — a small class that contributes methods and attributes and calls `super()` to cooperate. *Why it matters:* reuse without deep single-purpose hierarchies.
- **MRO (Method Resolution Order)** — Python's C3 linearization of the class hierarchy, visible as `Cls.__mro__`. *Why it matters:* determines which `dispatch()` or `get_context_data()` runs first; mixin order in the class statement is behaviour.
- **`TemplateResponseMixin`** — `render_to_response()` returning a lazy `TemplateResponse`; `get_template_names()`. *Why it matters:* template responses can be modified by middleware (`process_template_response`) before rendering.
- **`ContextMixin.get_context_data(**kwargs)`** — builds the template context, includes `view` and `extra_context`. *Why it matters:* always call `super()` or you lose `object`, `page_obj`, `form`.
- **`SingleObjectMixin`** — `get_object()` from `pk_url_kwarg`/`slug_url_kwarg` and `get_queryset()`; raises `Http404`. *Why it matters:* override `get_queryset()` to scope objects (e.g. to `request.user`) — the authorization foundation.
- **`MultipleObjectMixin`** — `get_queryset()`, `paginate_by`, `ordering`, `context_object_name`. *Why it matters:* pagination and listing for free.
- **`FormMixin` / `ModelFormMixin` / `ProcessFormView`** — `get_form()`, `form_valid()`, `form_invalid()`, `get_success_url()`. *Why it matters:* the POST pipeline of every editing view.
- **`method_decorator`** — adapts a function decorator to a method: `@method_decorator(login_required, name="dispatch")`. *Why it matters:* reuse FBV decorators on CBVs.

## 3. Theory & Principles

### 3.1 What `as_view()` actually does

Stripped of details, `View.as_view` in Django 5.2 looks like this:

```python
class View:
    http_method_names = ["get", "post", "put", "patch", "delete", "head", "options", "trace"]

    def __init__(self, **kwargs):
        for key, value in kwargs.items():
            setattr(self, key, value)

    @classonlymethod
    def as_view(cls, **initkwargs):
        for key in initkwargs:
            if key in cls.http_method_names:
                raise TypeError("... method name as keyword argument ...")
            if not hasattr(cls, key):
                raise TypeError("... received an invalid keyword ...")

        def view(request, *args, **kwargs):
            self = cls(**initkwargs)              # NEW instance per request
            self.setup(request, *args, **kwargs)  # sets self.request/args/kwargs
            if not hasattr(self, "request"):
                raise AttributeError("setup() did not call super()")
            return self.dispatch(request, *args, **kwargs)

        view.view_class = cls
        view.view_initkwargs = initkwargs
        # async views: view is marked as a coroutine function if handlers are async
        return view

    def setup(self, request, *args, **kwargs):
        if hasattr(self, "get") and not hasattr(self, "head"):
            self.head = self.get                  # HEAD handled by get()
        self.request, self.args, self.kwargs = request, args, kwargs

    def dispatch(self, request, *args, **kwargs):
        if request.method.lower() in self.http_method_names:
            handler = getattr(self, request.method.lower(), self.http_method_not_allowed)
        else:
            handler = self.http_method_not_allowed
        return handler(request, *args, **kwargs)
```

Three consequences interviewers like:

1. **Instance per request** — state on `self` cannot leak between requests. But **class attributes are shared**: `queryset = Book.objects.all()` is evaluated lazily and `get_queryset()` calls `.all()` on it to get a fresh clone; a mutable class attribute like `extra = []` that you `.append()` to *will* leak.
2. **initkwargs are validated** — `as_view(template_name="x.html")` works only because `template_name` is a class attribute; typos raise `TypeError` at import time.
3. **405 is automatic** — a `ListView` has no `post`, so POST returns `HttpResponseNotAllowed` with an `Allow` header built from the defined handlers. `OPTIONS` is answered by `options()`.

> **Version note:** Since Django 4.1, a CBV may define `async def get(...)` etc. All handlers on a view must be either all sync or all async (`view_is_async` checks this and raises `ImproperlyConfigured` on a mix). Generic views' internals (`get_object`, `get_queryset`) are sync, so async CBVs are mostly useful with plain `View`.

### 3.2 MRO and cooperative `super()`

Python linearizes multiple inheritance with **C3**: a class precedes its bases, and the left-to-right order of bases in the class statement is preserved. Each method calls `super().method()`, which means "the next class in the MRO of the *instance's* class", not "my parent". That is what lets independent mixins stack.

```python
from django.contrib.auth.mixins import LoginRequiredMixin
from django.views.generic import UpdateView

class ArticleUpdate(LoginRequiredMixin, UpdateView):
    model = Article
    fields = ["title", "body"]

print([c.__name__ for c in ArticleUpdate.__mro__])
```

```text
['ArticleUpdate', 'LoginRequiredMixin', 'AccessMixin', 'UpdateView',
 'SingleObjectTemplateResponseMixin', 'TemplateResponseMixin', 'BaseUpdateView',
 'ModelFormMixin', 'FormMixin', 'SingleObjectMixin', 'ContextMixin',
 'ProcessFormView', 'View', 'object']
```

When `dispatch()` is called, Python finds `LoginRequiredMixin.dispatch` first. It checks `request.user.is_authenticated`, and either returns `handle_no_permission()` (redirect to login) or calls `super().dispatch()`, which continues down the MRO to `View.dispatch`. Put the mixin on the **right** of `UpdateView` and `View.dispatch` is found first — it never calls `super()`, so **the login check silently never runs**. That is the single most important MRO fact for Django.

```svg
<svg viewBox="0 0 860 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj17a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj17b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">dispatch() lookup walks the MRO left to right: mixin order is behaviour</text>
  <rect x="20" y="40" width="400" height="280" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="220" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">class V(LoginRequiredMixin, UpdateView)</text>
  <rect x="60" y="80" width="320" height="34" rx="6" fill="#fff" stroke="#16a34a"/><text x="220" y="101" text-anchor="middle" fill="#1e293b">LoginRequiredMixin.dispatch: check auth</text>
  <rect x="60" y="140" width="320" height="34" rx="6" fill="#fff" stroke="#94a3b8"/><text x="220" y="161" text-anchor="middle" fill="#334155">super().dispatch() ... skips classes w/o dispatch</text>
  <rect x="60" y="200" width="320" height="34" rx="6" fill="#fff" stroke="#94a3b8"/><text x="220" y="221" text-anchor="middle" fill="#334155">View.dispatch: pick get()/post()</text>
  <rect x="60" y="260" width="320" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="220" y="281" text-anchor="middle" fill="#1e293b">ProcessFormView.post -&gt; form_valid</text>
  <path d="M220,116 L220,138" stroke="#2563eb" stroke-width="2" marker-end="url(#dj17a)"/>
  <path d="M220,176 L220,198" stroke="#2563eb" stroke-width="2" marker-end="url(#dj17a)"/>
  <path d="M220,236 L220,258" stroke="#2563eb" stroke-width="2" marker-end="url(#dj17a)"/>
  <rect x="440" y="40" width="400" height="280" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="640" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">class V(UpdateView, LoginRequiredMixin)</text>
  <rect x="480" y="80" width="320" height="34" rx="6" fill="#fff" stroke="#dc2626"/><text x="640" y="101" text-anchor="middle" fill="#1e293b">View.dispatch found first (in UpdateView chain)</text>
  <rect x="480" y="140" width="320" height="34" rx="6" fill="#fff" stroke="#dc2626"/><text x="640" y="161" text-anchor="middle" fill="#1e293b">View.dispatch never calls super()</text>
  <rect x="480" y="200" width="320" height="34" rx="6" fill="#fff" stroke="#94a3b8"/><text x="640" y="221" text-anchor="middle" fill="#334155">LoginRequiredMixin.dispatch: never runs</text>
  <rect x="480" y="260" width="320" height="34" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="640" y="281" text-anchor="middle" fill="#1e293b">anonymous user edits the article</text>
  <path d="M640,116 L640,138" stroke="#dc2626" stroke-width="2" marker-end="url(#dj17b)"/>
  <path d="M640,176 L640,258" stroke="#dc2626" stroke-width="2" stroke-dasharray="5,4" marker-end="url(#dj17b)"/>
</svg>
```

Rule of thumb: **access-control mixins go leftmost, the generic view goes rightmost**, and your own mixins that tweak hooks go in between.

### 3.3 The hook order inside generic views

For **`DetailView.get()`**: `get_object()` → (calls `get_queryset()`, filters by pk/slug, `.get()`, 404 on `DoesNotExist`) → `self.object = ...` → `get_context_data(object=...)` (adds `object` and the `context_object_name`, e.g. `article`) → `render_to_response()` → `get_template_names()` (`template_name`, else `<app>/<model>_detail.html`).

For **`ListView.get()`**: `self.object_list = get_queryset()` (uses `queryset` or `model._default_manager.all()`, applies `ordering`) → `allow_empty` check → `get_context_data()` → `paginate_queryset()` if `paginate_by` (adds `paginator`, `page_obj`, `is_paginated`; an out-of-range page raises `Http404`) → render `<app>/<model>_list.html`.

For **`CreateView.post()` / `UpdateView.post()`**: `self.object = None` (create) or `get_object()` (update) → `get_form()` (`get_form_class()` from `fields`/`form_class`, `get_form_kwargs()` adds `data`, `files`, `instance`, `initial`, `prefix`) → `form.is_valid()` → `form_valid(form)` (`ModelFormMixin`: `self.object = form.save()`, then `FormMixin.form_valid` redirects to `get_success_url()`) or `form_invalid(form)` (re-render with errors, status 200).

`get_success_url()` uses `success_url` (which may contain `{id}`-style placeholders formatted with `self.object.__dict__`), else `self.object.get_absolute_url()`, else raises `ImproperlyConfigured`.

**`DeleteView`** since Django 4.0 includes `FormMixin`: GET shows the confirmation template (`_confirm_delete.html`); POST validates a (empty) form and `form_valid()` deletes the object and redirects. Custom delete logic now belongs in `form_valid()`, not `delete()`.

## 4. Architecture & Workflow

### 4.1 From URLconf to response

```svg
<svg viewBox="0 0 860 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj17c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">UpdateView POST: the call chain one request takes</text>
  <rect x="15" y="45" width="130" height="44" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="80" y="64" text-anchor="middle" fill="#1e293b">URLconf</text><text x="80" y="80" text-anchor="middle" fill="#334155" font-size="9">path(..., V.as_view())</text>
  <rect x="175" y="45" width="130" height="44" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="240" y="64" text-anchor="middle" fill="#1e293b">view()</text><text x="240" y="80" text-anchor="middle" fill="#334155" font-size="9">cls(**initkwargs)</text>
  <rect x="335" y="45" width="130" height="44" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="400" y="64" text-anchor="middle" fill="#1e293b">setup()</text><text x="400" y="80" text-anchor="middle" fill="#334155" font-size="9">self.request/kwargs</text>
  <rect x="495" y="45" width="130" height="44" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="560" y="64" text-anchor="middle" fill="#1e293b">dispatch()</text><text x="560" y="80" text-anchor="middle" fill="#334155" font-size="9">mixins, then View</text>
  <rect x="655" y="45" width="190" height="44" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="750" y="64" text-anchor="middle" fill="#1e293b">post()</text><text x="750" y="80" text-anchor="middle" fill="#334155" font-size="9">BaseUpdateView</text>
  <path d="M147,67 L173,67" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj17c)"/>
  <path d="M307,67 L333,67" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj17c)"/>
  <path d="M467,67 L493,67" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj17c)"/>
  <path d="M627,67 L653,67" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj17c)"/>
  <rect x="655" y="125" width="190" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="750" y="149" text-anchor="middle" fill="#1e293b">get_object() / get_queryset()</text>
  <rect x="440" y="125" width="190" height="40" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="535" y="149" text-anchor="middle" fill="#1e293b">get_form(get_form_kwargs())</text>
  <rect x="225" y="125" width="190" height="40" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="320" y="149" text-anchor="middle" fill="#1e293b">form.is_valid()</text>
  <path d="M750,91 L750,123" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj17c)"/>
  <path d="M653,145 L632,145" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj17c)"/>
  <path d="M438,145 L417,145" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj17c)"/>
  <rect x="15" y="200" width="300" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/><text x="165" y="222" text-anchor="middle" fill="#1e293b" font-weight="bold">valid: form_valid(form)</text><text x="165" y="240" text-anchor="middle" fill="#334155">self.object = form.save()</text><text x="165" y="257" text-anchor="middle" fill="#334155">302 to get_success_url()</text>
  <rect x="345" y="200" width="300" height="70" rx="8" fill="#fee2e2" stroke="#dc2626"/><text x="495" y="222" text-anchor="middle" fill="#1e293b" font-weight="bold">invalid: form_invalid(form)</text><text x="495" y="240" text-anchor="middle" fill="#334155">get_context_data(form=form)</text><text x="495" y="257" text-anchor="middle" fill="#334155">200, re-render template with errors</text>
  <path d="M290,167 L200,198" stroke="#16a34a" stroke-width="2" marker-end="url(#dj17c)"/>
  <path d="M350,167 L450,198" stroke="#dc2626" stroke-width="2" marker-end="url(#dj17c)"/>
  <text x="755" y="225" text-anchor="middle" fill="#334155" font-size="10">Http404 here if the object</text>
  <text x="755" y="241" text-anchor="middle" fill="#334155" font-size="10">is not in get_queryset()</text>
</svg>
```

### 4.2 Which hook to override

```text
Want to...                                   Override
-------------------------------------------  -----------------------------------
scope rows to the user / tenant              get_queryset()
look up by something other than pk/slug      get_object()  (or slug_field/slug_url_kwarg)
add data to the template                     get_context_data(**kwargs) + super()
set fields the user must not control         form_valid(): form.instance.owner = request.user
pass request/user into the form              get_form_kwargs()
pick template dynamically                    get_template_names()
redirect somewhere computed                  get_success_url()
check permissions before anything            dispatch() via a mixin (leftmost)
initialize attributes from URL kwargs        setup()
```

## 5. Implementation

### 5.1 Simple example — a CRUD set for articles

```python
# blog/models.py
from django.conf import settings
from django.db import models
from django.urls import reverse


class Article(models.Model):
    author = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    title = models.CharField(max_length=200)
    slug = models.SlugField(unique=True)
    body = models.TextField()
    published = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)

    def get_absolute_url(self):
        return reverse("blog:detail", kwargs={"slug": self.slug})
```

```python
# blog/views.py
from django.contrib.auth.mixins import LoginRequiredMixin
from django.urls import reverse_lazy
from django.views.generic import CreateView, DeleteView, DetailView, ListView, UpdateView
from .models import Article


class ArticleList(ListView):
    model = Article
    paginate_by = 20
    ordering = ["-created_at"]

    def get_queryset(self):
        return super().get_queryset().filter(published=True).select_related("author")


class ArticleDetail(DetailView):
    model = Article                    # looks up by slug from URL kwarg "slug"

    def get_queryset(self):
        return Article.objects.filter(published=True).select_related("author")


class ArticleCreate(LoginRequiredMixin, CreateView):
    model = Article
    fields = ["title", "slug", "body", "published"]

    def form_valid(self, form):
        form.instance.author = self.request.user     # never trust a hidden field
        return super().form_valid(form)              # saves, redirects to get_absolute_url()


class OwnArticlesMixin:
    """Restrict editing views to the current user's articles."""
    def get_queryset(self):
        return super().get_queryset().filter(author=self.request.user)


class ArticleUpdate(LoginRequiredMixin, OwnArticlesMixin, UpdateView):
    model = Article
    fields = ["title", "body", "published"]


class ArticleDelete(LoginRequiredMixin, OwnArticlesMixin, DeleteView):
    model = Article
    success_url = reverse_lazy("blog:list")          # reverse_lazy: URLconf not loaded at import
```

```python
# blog/urls.py
from django.urls import path
from . import views

app_name = "blog"
urlpatterns = [
    path("", views.ArticleList.as_view(), name="list"),
    path("new/", views.ArticleCreate.as_view(), name="create"),
    path("<slug:slug>/", views.ArticleDetail.as_view(), name="detail"),
    path("<slug:slug>/edit/", views.ArticleUpdate.as_view(), name="update"),
    path("<slug:slug>/delete/", views.ArticleDelete.as_view(), name="delete"),
]
```

```html
<!-- blog/templates/blog/article_list.html (default name: <app>/<model>_list.html) -->
{% extends "base.html" %}
{% block content %}
  {% for article in article_list %}            {# also available as object_list #}
    <h2><a href="{{ article.get_absolute_url }}">{{ article.title }}</a></h2>
    <p>by {{ article.author }}</p>
  {% empty %}
    <p>No articles yet.</p>
  {% endfor %}

  {% if is_paginated %}
    {% if page_obj.has_previous %}<a href="?page={{ page_obj.previous_page_number }}">prev</a>{% endif %}
    Page {{ page_obj.number }} of {{ paginator.num_pages }}
    {% if page_obj.has_next %}<a href="?page={{ page_obj.next_page_number }}">next</a>{% endif %}
  {% endif %}
{% endblock %}
```

`CreateView`/`UpdateView` render `blog/article_form.html` (suffix `_form`), `DeleteView` renders `blog/article_confirm_delete.html`. Because `OwnArticlesMixin` filters `get_queryset()`, another user's slug yields **404, not 403** — which also avoids leaking that the article exists. The SQL for an update by a non-owner shows why:

```sql
SELECT ... FROM "blog_article"
WHERE ("blog_article"."author_id" = 7 AND "blog_article"."slug" = 'hello-world')
LIMIT 21;   -- get() fetches up to 21 rows to report MultipleObjectsReturned
```

The same views as FBVs, for comparison — notice how much is now explicit:

```python
from django.contrib.auth.decorators import login_required
from django.shortcuts import get_object_or_404, redirect, render
from .forms import ArticleForm

@login_required
def article_update(request, slug):
    article = get_object_or_404(Article, slug=slug, author=request.user)
    form = ArticleForm(request.POST or None, instance=article)
    if request.method == "POST" and form.is_valid():
        article = form.save()
        return redirect(article)
    return render(request, "blog/article_form.html", {"form": form, "object": article})
```

### 5.2 Real-world example — multi-tenant views with reusable mixins

A SaaS app where every object belongs to an organization from the URL, permissions are per-org, and every list supports search.

```python
# core/mixins.py
from django.contrib.auth.mixins import LoginRequiredMixin
from django.core.exceptions import PermissionDenied
from django.shortcuts import get_object_or_404
from orgs.models import Membership, Organization


class OrgMixin(LoginRequiredMixin):
    """Resolve the org from the URL once, verify membership, scope querysets."""
    org_role_required = "member"

    def setup(self, request, *args, **kwargs):
        super().setup(request, *args, **kwargs)
        self.org = None

    def dispatch(self, request, *args, **kwargs):
        if not request.user.is_authenticated:
            return self.handle_no_permission()          # LoginRequiredMixin behaviour
        self.org = get_object_or_404(Organization, slug=kwargs["org_slug"])
        membership = Membership.objects.filter(org=self.org, user=request.user).first()
        if membership is None or not membership.has_role(self.org_role_required):
            raise PermissionDenied
        self.membership = membership
        return super().dispatch(request, *args, **kwargs)

    def get_queryset(self):
        return super().get_queryset().filter(org=self.org)

    def get_context_data(self, **kwargs):
        kwargs.setdefault("org", self.org)
        return super().get_context_data(**kwargs)


class SearchMixin:
    search_fields = ()

    def get_queryset(self):
        qs = super().get_queryset()
        q = self.request.GET.get("q", "").strip()
        if q and self.search_fields:
            from django.db.models import Q
            cond = Q()
            for f in self.search_fields:
                cond |= Q(**{f"{f}__icontains": q})
            qs = qs.filter(cond)
        return qs

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        ctx["q"] = self.request.GET.get("q", "")
        return ctx


class OrgFormMixin:
    """Inject org into forms and stamp it on save."""
    def get_form_kwargs(self):
        kwargs = super().get_form_kwargs()
        kwargs["org"] = self.org
        return kwargs

    def form_valid(self, form):
        form.instance.org = self.org
        form.instance.updated_by = self.request.user
        return super().form_valid(form)
```

```python
# projects/views.py
from django.contrib import messages
from django.db import transaction
from django.urls import reverse
from django.views.generic import CreateView, ListView, UpdateView
from core.mixins import OrgFormMixin, OrgMixin, SearchMixin
from .forms import ProjectForm
from .models import Project


class ProjectList(OrgMixin, SearchMixin, ListView):
    model = Project
    paginate_by = 25
    search_fields = ("name", "client__name")

    def get_queryset(self):
        return super().get_queryset().select_related("client").order_by("-updated_at")


class ProjectCreate(OrgMixin, OrgFormMixin, CreateView):
    model = Project
    form_class = ProjectForm
    org_role_required = "editor"

    @transaction.atomic
    def form_valid(self, form):
        response = super().form_valid(form)          # self.object is now saved
        self.object.members.add(self.request.user)
        messages.success(self.request, f"Created {self.object.name}")
        return response

    def get_success_url(self):
        return reverse("projects:detail", kwargs={"org_slug": self.org.slug, "pk": self.object.pk})


class ProjectUpdate(OrgMixin, OrgFormMixin, UpdateView):
    model = Project
    form_class = ProjectForm
    org_role_required = "editor"
```

```python
# projects/forms.py
from django import forms
from .models import Client, Project


class ProjectForm(forms.ModelForm):
    class Meta:
        model = Project
        fields = ["name", "client", "budget"]

    def __init__(self, *args, org, **kwargs):
        super().__init__(*args, **kwargs)
        # Only clients of this org are selectable — prevents cross-tenant references
        self.fields["client"].queryset = Client.objects.filter(org=org)
```

The MRO for `ProjectList` is `ProjectList → OrgMixin → LoginRequiredMixin → AccessMixin → SearchMixin → ListView → ... → MultipleObjectMixin → ... → View`. `get_queryset()` therefore runs `ProjectList` (select_related, order) → `OrgMixin` (org filter) → `SearchMixin` (q filter) → `MultipleObjectMixin` (base queryset). Each layer refines the result of the next — cooperative inheritance doing its job.

A view test locks the behaviour in:

```python
from django.test import TestCase
from django.urls import reverse

class ProjectListTests(TestCase):
    def test_other_org_is_forbidden(self):
        self.client.force_login(self.alice)
        r = self.client.get(reverse("projects:list", kwargs={"org_slug": self.bob_org.slug}))
        self.assertEqual(r.status_code, 403)

    def test_query_count(self):
        self.client.force_login(self.alice)
        with self.assertNumQueries(6):   # session, user, org, membership, COUNT, page
            self.client.get(reverse("projects:list", kwargs={"org_slug": self.org.slug}))
```

### 5.3 Decorators on CBVs

```python
from django.utils.decorators import method_decorator
from django.views.decorators.cache import cache_page
from django.views.decorators.csrf import ensure_csrf_cookie
from django.views.generic import TemplateView

@method_decorator([cache_page(60), ensure_csrf_cookie], name="dispatch")
class Dashboard(TemplateView):
    template_name = "dashboard.html"

# Or at URL level (decorates the function returned by as_view):
# path("dash/", cache_page(60)(Dashboard.as_view()))
```

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | FBV | CBV / generic views |
|---|---|---|
| Readability | Linear, explicit | Indirect; must know the hooks |
| Boilerplate for CRUD | High | Very low |
| Reuse | Helpers, decorators | Mixins, inheritance, attributes |
| HTTP method branching | `if request.method == "POST"` | Separate `get()`/`post()` methods; 405 automatic |
| Testing | Call function | Same via client; `RequestFactory` + `view.setup()` for unit tests |
| Debugging | Stack trace is your code | Stack trace through Django mixins |
| Learning curve | Low | Medium (MRO, ccbv.co.uk) |
| Fit for DRF | `@api_view` | `APIView`, generics, ViewSets |

### When to use

- Standard list/detail/create/update/delete pages, especially many similar ones.
- Cross-cutting behaviour (tenant scoping, permission checks, audit stamping) shared via mixins.
- When you want automatic 405, `OPTIONS`, `HEAD` handling and consistent template naming.

### When NOT to use

- A view that orchestrates several forms, external calls and branching flows — an FBV (or a CBV with plain `View`) reads better than fighting `FormMixin`.
- Deep inheritance chains (mixin of mixin of mixin) that nobody can trace; flatten or use composition (service functions).
- When the team is unfamiliar and the app has only a handful of views — consistency and clarity beat cleverness.

## 7. Common Mistakes & Best Practices

**1. Mixin on the wrong side.** `class V(UpdateView, LoginRequiredMixin)` silently skips the login check. *Instead:* access mixins leftmost; add a test that anonymous users get a redirect.

**2. Forgetting `super()` in `get_context_data()`.**

```python
# Before: object/form/page_obj disappear from the template
def get_context_data(self, **kwargs):
    return {"stats": compute_stats()}

# After
def get_context_data(self, **kwargs):
    ctx = super().get_context_data(**kwargs)
    ctx["stats"] = compute_stats()
    return ctx
```

**3. Authorization in the template or in `get()` only.** Checking ownership in `get()` but not `post()` lets a crafted POST through. *Instead:* scope `get_queryset()` — both `get()` and `post()` go through `get_object()`.

**4. Evaluated queryset as a class attribute.** `queryset = list(Book.objects.all())` or `queryset = Book.objects.filter(created__gte=timezone.now() - ...)` freezes the timestamp at import time. *Instead:* compute in `get_queryset()`.

**5. Mutable class attributes.** `extra_context = {}` then `self.extra_context["x"] = ...` mutates the shared dict across requests. *Instead:* override `get_context_data()`.

**6. Setting the owner via a hidden form field.** Users can tamper with it. *Instead:* exclude the field and set `form.instance.owner` in `form_valid()`.

**7. `reverse()` in a class attribute.** `success_url = reverse("x")` runs at import time and may fail with circular URLconf imports. *Instead:* `reverse_lazy()` or `get_success_url()`.

**8. Overriding `post()` in DeleteView/UpdateView to add logic.** You bypass validation. *Instead:* override `form_valid()` (DeleteView since 4.0 too).

**9. N+1 in list templates.** `{{ article.author.name }}` per row. *Instead:* `select_related` in `get_queryset()` (see [Ch 13](topic.html?p=13-queryset-optimization)).

**Best practices:** keep mixins tiny and single-purpose; always cooperate with `super()`; use [ccbv.co.uk](https://ccbv.co.uk/) to see the flattened methods of any generic view; test access rules per view.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: cross-tenant data leak.** In production, a user edits `/orgs/acme/projects/42/edit/` and changes the URL to project 43 of another org. Root cause: `UpdateView` with `model = Project` and no `get_queryset()` override — `get_object()` finds any project by pk. Fix: tenant-scoped `get_queryset()` in a base mixin every view must inherit, plus a test or system check that enforces it.

**Pitfall: slow list page with `paginate_by`.** The paginator runs `COUNT(*)` on a 10M-row filtered queryset per request. Symptom: list endpoint p95 in seconds while the page query is fast. Fix: an index matching the filter, cache the count, or switch to keyset/cursor pagination for infinite scroll (see [REST API · Pagination](../rest-api/topic.html?p=13-pagination)).

**Pitfall: `PermissionDenied` vs 404 confusion.** Raising 403 for objects outside the user's scope leaks existence (enumeration). Return 404 for "not yours", 403 for "yours but not allowed".

**Pitfall: thread-safety assumptions.** Developers cache computed data on the class (`cls._cache = ...`) inside a view. Under threaded Gunicorn workers this races and leaks data between users. Keep request data on `self`, process-wide data in the cache framework.

**Debugging:**

- `print(V.__mro__)` or `inspect.getmro` to see the lookup order; ccbv.co.uk for the source of each method.
- Django debug toolbar's Templates panel shows the resolved template and context (catches a misnamed `context_object_name`).
- Put a breakpoint in `dispatch()` of your leftmost class and step through `super()` calls.
- For unit tests: `view = MyView(); view.setup(request, **kwargs); view.get_queryset()` tests one hook in isolation.

**Scaling notes:** CBVs add negligible overhead (one object per request). Real costs are queries and template rendering: `select_related`/`prefetch_related` in `get_queryset()`, fragment caching, and `cache_page` via `method_decorator`. For APIs, migrate to DRF generic views, which reuse the same mental model.

## 9. Interview Questions

**Q: What is the difference between function-based and class-based views, and when would you choose each?**
A: Both end up as a callable taking `request` and returning a response — `as_view()` turns a class into such a function. FBVs are explicit and linear, ideal for unique logic and easy to read in a stack trace. CBVs organize the request-handling skeleton into overridable methods, give you per-method handlers, automatic 405/OPTIONS/HEAD, and reuse via mixins; generic CBVs remove CRUD boilerplate. I choose generic CBVs for standard CRUD and shared behaviour, FBVs for bespoke flows. Team consistency matters more than either.

**Q: What does `as_view()` do?**
A: It is a classmethod that validates the initkwargs (they must be existing class attributes and not HTTP method names) and returns a closure `view(request, *args, **kwargs)`. On each request, that function instantiates the class with the initkwargs, calls `setup()` to store `request`, `args`, `kwargs`, then calls `dispatch()`. It also attaches `view_class` and `view_initkwargs` to the function for introspection. Because a new instance is created per request, instance attributes are request-local.

**Q: How does `dispatch()` decide which method to call?**
A: It lowercases `request.method` and, if it is in `http_method_names`, looks up a method of that name on the instance; if missing or not allowed it uses `http_method_not_allowed`, returning 405 with an `Allow` header. `HEAD` falls back to `get()` (set up in `setup()`), and `OPTIONS` is answered by the built-in `options()`. Overriding `dispatch()` (usually in a mixin) is the hook for checks that must run before any handler.

**Q: Explain MRO and why mixin order matters in Django views.**
A: Python computes a C3 linearization of the class hierarchy; attribute lookup and `super()` follow it, and left bases come before right bases. Django's mixins cooperate by calling `super()`, so each mixin's `dispatch()` or `get_queryset()` wraps the next one. `View.dispatch` is the end of the chain and does not call `super()`, so a mixin placed to the right of the generic view never gets its `dispatch()` called. That's why `LoginRequiredMixin` must be leftmost: `class V(LoginRequiredMixin, UpdateView)`.

**Q: Where do you restrict a DetailView/UpdateView to the current user's objects, and why there?**
A: Override `get_queryset()` to filter by `request.user` (or tenant). `get_object()` uses `get_queryset()` for both GET and POST, so the restriction covers every handler, and objects outside the scope produce a 404 rather than revealing their existence. Checking in `get()` or in the template misses POST and other paths. For role-based checks layer `UserPassesTestMixin` or `PermissionRequiredMixin` on top.

**Q: How do you set the owner of an object in a CreateView?**
A: Exclude `owner` from `fields`, then override `form_valid()`: `form.instance.owner = self.request.user; return super().form_valid(form)`. `ModelFormMixin.form_valid` saves the form (assigning `self.object`) and redirects to `get_success_url()`. Never rely on a hidden input, because the client controls it.

**Q: What does `get_context_data()` provide by default, and what happens if you don't call `super()`?**
A: `ContextMixin` adds `view` and merges `extra_context`; `SingleObjectMixin` adds `object` and the named alias (e.g. `article`); `MultipleObjectMixin` adds `object_list`, `<model>_list`, `paginator`, `page_obj`, `is_paginated`; `FormMixin` adds `form`. If you return a new dict without calling `super()`, all of those disappear and the template breaks silently (DTL renders missing variables as empty). Always start with `ctx = super().get_context_data(**kwargs)`.

**Q: How do you apply a function decorator like `login_required` or `cache_page` to a CBV?**
A: Use `method_decorator`, usually on `dispatch`: `@method_decorator(login_required, name="dispatch")` on the class, or decorate a method directly. A list of decorators can be passed. Alternatively wrap in the URLconf: `login_required(MyView.as_view())`. For auth specifically, `LoginRequiredMixin` is the idiomatic CBV choice; Django 5.1+ also offers `LoginRequiredMiddleware` with `login_not_required` for opt-out.

**Q: How do template names get chosen in generic views?**
A: `get_template_names()` returns `template_name` if set; otherwise for model-based views it builds `<app_label>/<model_name><template_name_suffix>.html` — `_list`, `_detail`, `_form` (create and update) and `_confirm_delete`. It can also return a list so you can try a specific template before a generic one. `TemplateResponseMixin.render_to_response` returns a lazy `TemplateResponse` that renders at the end of the middleware response phase.

**Q: Why use `reverse_lazy` for `success_url`?**
A: Class bodies execute at import time, when the URLconf may not be loaded yet (and importing it could be circular because the URLconf imports the views). `reverse_lazy` returns a lazy proxy evaluated when the URL is first used. Alternatively override `get_success_url()`, which runs at request time and can use `self.object`.

**Q: Design reusable multi-tenant behaviour for 40 CBVs. How would you structure it? (Senior)**
A: A base `TenantMixin` resolves the tenant once (in `dispatch()` or `setup()`), verifies membership, stores it on `self`, scopes `get_queryset()`, injects it into `get_form_kwargs()` and context, and stamps it in `form_valid()`. Access mixins go leftmost and the tenant mixin calls `super()` everywhere so it composes with search/pagination mixins. I'd enforce adoption with a project base class or a test that walks the URLconf and asserts each view's MRO contains the mixin, and keep foreign-key choices in forms tenant-scoped to stop cross-tenant references. Business logic stays in service functions, keeping mixins thin.

**Q: A teammate's CBV has six mixins and nobody knows why a field gets overwritten on save. How do you debug it? (Senior)**
A: Print `View.__mro__` and identify every class defining `form_valid`, `get_form_kwargs`, `get_initial` and `save` overrides (ccbv.co.uk helps for Django's own classes). Then trace the `super()` chain — a mixin that sets `form.instance.x` after another, or one that doesn't call `super()`, is the usual culprit. A breakpoint in the leftmost `form_valid` and stepping through confirms it. Fix by reordering bases, merging overlapping mixins, or moving the logic into an explicit service call so the order is visible.

**Q: When is a CBV the wrong tool? (Senior)**
A: When the flow doesn't match the generic shape — multiple forms with conditional steps, heavy orchestration, or many early returns — you end up overriding `post()` entirely and the generic machinery only adds indirection. Also when the inheritance tree becomes too deep for the team to reason about, or when async handlers are needed alongside generic sync internals. Then I use an FBV or a plain `View` subclass with explicit methods, delegating to services. The test is: can a new hire find what runs on POST in under a minute?

**Q: Can CBVs be async?**
A: Yes, since Django 4.1 a `View` subclass may define `async def get()` etc., and `as_view()` returns a coroutine function. All handlers on the class must be consistently async or sync, otherwise `ImproperlyConfigured` is raised. Generic views' helpers like `get_object()` use the sync ORM, so they don't benefit; use async primarily with plain `View` and the async ORM API, under ASGI (see [Ch 30](topic.html?p=30-async-django-asgi)).

## 10. Quick Revision & Cheat Sheet

| Generic view | Key hooks | Default template | Context |
|---|---|---|---|
| `TemplateView` | `get_context_data` | `template_name` (required) | `view`, URL kwargs |
| `RedirectView` | `get_redirect_url` | — | — (`permanent=False` default) |
| `ListView` | `get_queryset`, `paginate_by`, `ordering` | `<app>/<model>_list.html` | `object_list`, `page_obj` |
| `DetailView` | `get_object`, `get_queryset` | `<app>/<model>_detail.html` | `object`, `<model>` |
| `CreateView` | `get_form_kwargs`, `form_valid`, `get_success_url` | `<app>/<model>_form.html` | `form` |
| `UpdateView` | as Create + `get_object` | `<app>/<model>_form.html` | `form`, `object` |
| `DeleteView` | `form_valid` (4.0+), `success_url` | `<app>/<model>_confirm_delete.html` | `object`, `form` |
| `FormView` | `form_class`, `form_valid`, `success_url` | `template_name` | `form` |

- `as_view()` → `view()` → `cls(**initkwargs)` → `setup()` → `dispatch()` → handler.
- New instance per request; class attributes are shared — no mutable ones.
- Access mixins leftmost; generic view rightmost; always call `super()`.
- Scope objects in `get_queryset()`; it covers GET and POST.
- Set server-controlled fields in `form_valid()` via `form.instance`.
- `reverse_lazy` in class attributes.
- `method_decorator(dec, name="dispatch")` for FBV decorators.
- Out-of-range page → 404; `get()` uses `LIMIT 21` for `MultipleObjectsReturned`.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2"`, `django-admin startproject site .`, `python manage.py startapp blog`.

1. **Build CRUD** from §5.1 with only generic views; then rewrite `ArticleUpdate` as an FBV and compare line counts and readability.
2. **MRO experiment.** Swap `LoginRequiredMixin` to the right of `UpdateView`, log out, and confirm you can reach the edit page. Print `__mro__` for both versions.
3. **Context bug.** Override `get_context_data` without `super()`, observe the broken template, fix it, and write a test asserting `"object" in response.context`.
4. **Ownership.** Implement `OwnArticlesMixin`, then write a test that user B gets 404 for user A's edit and delete URLs on both GET and POST.
5. **Unit-test a hook.** Use `RequestFactory` and `view.setup()` to test `get_queryset()` of `ProjectList` without hitting the URLconf.

**Mini project — "Team Tasks":** organizations, projects and tasks with tenant-scoped CBVs built from `OrgMixin`, `SearchMixin`, `OrgFormMixin`; a `DeleteView` with a soft-delete `form_valid`; `assertNumQueries` on every list page; and a test that walks all URL patterns and asserts every view class inherits `OrgMixin`.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 04 · Views, HttpRequest & HttpResponse](topic.html?p=04-views-requests-responses) · [Ch 06 · Forms, ModelForms & Validation](topic.html?p=06-forms-validation) · [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization) · [Ch 18 · Middleware](topic.html?p=18-middleware) · [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers) · [Ch 26 · Permissions, Groups & Authorization](topic.html?p=26-permissions-authorization) · [Ch 33 · Testing](topic.html?p=33-testing)

**Other handbooks:** [REST API · HTTP Methods & Idempotency](../rest-api/topic.html?p=06-http-methods-idempotency) · [REST API · Status Codes](../rest-api/topic.html?p=07-status-codes) · [REST API · Pagination](../rest-api/topic.html?p=13-pagination)

**Free resources:**
- **Class-based views (topic guide)** — Django docs · *Beginner* · the official introduction and when to use them. <https://docs.djangoproject.com/en/5.2/topics/class-based-views/>
- **Using mixins with class-based views** — Django docs · *Intermediate* · how the mixins compose and where it gets tricky. <https://docs.djangoproject.com/en/5.2/topics/class-based-views/mixins/>
- **Built-in class-based views API** — Django docs · *Intermediate* · reference for every generic view's attributes and methods. <https://docs.djangoproject.com/en/5.2/ref/class-based-views/>
- **Classy Class-Based Views** — ccbv.co.uk · *Intermediate* · flattened view of every method and attribute with the MRO. <https://ccbv.co.uk/>
- **Python's super() considered super!** — Raymond Hettinger · *Intermediate* · the definitive explanation of cooperative multiple inheritance. <https://rhettinger.wordpress.com/2011/05/26/super-considered-super/>
- **The Python 2.3 Method Resolution Order** — python.org · *Advanced* · the C3 algorithm explained. <https://docs.python.org/3/howto/mro.html>

---

*Django Handbook — chapter 17.*
