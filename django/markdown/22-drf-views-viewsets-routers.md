# 22 · DRF Views, ViewSets & Routers

> **In one line:** Every DRF endpoint is an `APIView` whose `dispatch()` wraps the request, negotiates content, authenticates, checks permissions and throttles, runs your handler and turns exceptions into responses; generic views and ViewSets are layers of mixins on top of that one pipeline, and routers just map HTTP verbs and URLs onto ViewSet actions.

---

## 1. Overview

> **Builds on:** [Ch 04 · Views, Requests & Responses](topic.html?p=04-views-requests-responses), [Ch 17 · Class-Based & Generic Views](topic.html?p=17-class-based-views), [Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers).

A plain Django view can serve JSON: `return JsonResponse(list(Book.objects.values()), safe=False)`. That works until you need the things every real API needs. You have to parse JSON *and* form data *and* multipart uploads. You need consistent authentication across endpoints, a permission check before the handler runs, a throttle, and an error format that is the same whether the failure is a missing object, bad input, or an unauthenticated user. You need `405 Method Not Allowed` with an `Allow` header, `406` when the client asks for XML you cannot produce, and an `OPTIONS` response. Doing that by hand in every view means hundreds of lines of copy-paste that drift, and the first endpoint someone forgets to protect is your data breach.

Django REST Framework's answer is to put all of that in **one** class, `APIView`, and make every endpoint inherit it. Then, because 80% of endpoints are "list/create/retrieve/update/delete a model", DRF layers on **`GenericAPIView`** (queryset, serializer, lookup, pagination, filtering hooks) and **mixins** (`ListModelMixin`, `CreateModelMixin`, ...) that implement those actions. **ViewSets** go one step further: one class holds all the actions for a resource, and a **router** generates the URL patterns.

The trade-off is the usual one with abstraction: you write very little code, but when something goes wrong ("why is my permission not checked on the list endpoint?", "why does my queryset return stale data?", "why do I get 403 instead of 401?") you need to know exactly which method in the stack does what. That is what this chapter teaches, and it is exactly what interviewers probe with "APIView vs ViewSet vs ModelViewSet" and "what happens when a request hits a DRF view?".

> **Why this matters:** Knowing the `dispatch()` → `initial()` → handler → `finalize_response()` sequence lets you answer almost every DRF debugging question from first principles instead of from memory.

## 2. Core Concepts

- **`APIView`** — DRF's base class, a subclass of Django's `View`. *Why:* centralises parsing, auth, permissions, throttling, content negotiation and exception handling.
- **`Request`** — `rest_framework.request.Request` wrapping Django's `HttpRequest`; adds `request.data` (parsed body for any method), `request.query_params` (alias of `GET`), `request.user` and `request.auth` (lazy). *Why:* one interface regardless of content type.
- **`Response`** — a `SimpleTemplateResponse` that holds *unrendered* data; the chosen renderer serialises it after the view returns. *Why:* the same view can return JSON or the browsable API.
- **Parsers / Renderers** — `JSONParser`, `FormParser`, `MultiPartParser`; `JSONRenderer`, `BrowsableAPIRenderer`. *Why:* control accepted and produced media types.
- **Content negotiation** — picks a renderer from the `Accept` header (or `?format=`/suffix). *Why:* returns 406 when nothing matches.
- **`@api_view`** — decorator that turns a function into an `APIView`. *Why:* FBV style with the full DRF pipeline.
- **`GenericAPIView`** — adds `queryset`, `serializer_class`, `lookup_field`, `get_queryset()`, `get_object()`, `get_serializer()`, `filter_queryset()`, `paginate_queryset()`. *Why:* the hooks you override in real projects.
- **Mixins** — `List/Create/Retrieve/Update/DestroyModelMixin` implement `list()`, `create()`, `retrieve()`, `update()`/`partial_update()`, `destroy()`. *Why:* composable behaviour; `perform_create/update/destroy` are the extension points.
- **Concrete generics** — `ListCreateAPIView`, `RetrieveUpdateDestroyAPIView`, etc. *Why:* mixin + `GenericAPIView` + method handlers pre-wired.
- **`ViewSet`** — groups actions (`list`, `retrieve`, ...) instead of HTTP methods. `ViewSet`, `GenericViewSet`, `ModelViewSet`, `ReadOnlyModelViewSet`. *Why:* one class per resource; consistent URLs.
- **`self.action`** — name of the current ViewSet action. *Why:* switch serializers/permissions per action.
- **`@action`** — extra routes on a ViewSet, `detail=True` (`/books/{pk}/publish/`) or `detail=False` (`/books/recent/`). *Why:* non-CRUD operations without a new class.
- **Routers** — `SimpleRouter`, `DefaultRouter` (adds an API root view and format-suffix routes). *Why:* generate URL patterns and names (`book-list`, `book-detail`).
- **Exception handler** — `EXCEPTION_HANDLER` setting; converts `APIException`, `Http404`, Django `PermissionDenied` into `Response`s. *Why:* one error envelope for the whole API.

## 3. Theory & Principles

### How `APIView` processes a request

`APIView.as_view()` calls Django's `View.as_view()` and then wraps the result in `csrf_exempt`. That surprises people: DRF disables Django's CSRF middleware for its views *because* CSRF is enforced, only when needed, by `SessionAuthentication` itself (see [Ch 23](topic.html?p=23-drf-auth-permissions-throttling)). Token/JWT clients do not need it.

When a request arrives, `APIView.dispatch(request, *args, **kwargs)` runs:

1. **`initialize_request()`** wraps the `HttpRequest` in a `Request` with `parsers=self.get_parsers()`, `authenticators=self.get_authenticators()` and `negotiator=self.get_content_negotiator()`. Nothing is parsed or authenticated yet.
2. **`initial()`**:
   - `perform_content_negotiation()` chooses renderer + media type (stored on `request.accepted_renderer`), raising `NotAcceptable` (406) if none fit,
   - `determine_version()` sets `request.version` / `request.versioning_scheme` ([Ch 24](topic.html?p=24-drf-pagination-filtering-versioning)),
   - `perform_authentication()` simply accesses `request.user`, which triggers the lazy authenticators,
   - `check_permissions()` calls `has_permission(request, view)` on each permission class,
   - `check_throttles()` calls `allow_request()` on each throttle; failures raise `Throttled` (429) with a `Retry-After`.
3. **Handler lookup**: `getattr(self, request.method.lower(), self.http_method_not_allowed)` — so `get()`, `post()`... or 405.
4. **`handle_exception(exc)`** on any exception: for `NotAuthenticated`/`AuthenticationFailed` it decides 401 vs 403 by asking the first authenticator for an `authenticate_header()`; then calls the configured exception handler; if that returns `None`, the exception is re-raised (→ Django 500).
5. **`finalize_response()`** attaches the renderer and media type to the `Response`, adds `Vary: Accept` (and `Allow`), and Django renders it on the way out.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj22a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj22b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">APIView.dispatch(): one pipeline for every DRF endpoint</text>
  <rect x="20" y="44" width="150" height="46" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="95" y="64" text-anchor="middle" fill="#1e293b">HttpRequest</text>
  <text x="95" y="80" text-anchor="middle" fill="#334155" font-size="9">after Django middleware</text>
  <path d="M170,67 L200,67" stroke="#2563eb" stroke-width="2" marker-end="url(#dj22a)"/>
  <rect x="202" y="44" width="170" height="46" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="287" y="64" text-anchor="middle" fill="#1e293b">initialize_request()</text>
  <text x="287" y="80" text-anchor="middle" fill="#334155" font-size="9">Request(parsers, authenticators)</text>
  <path d="M372,67 L402,67" stroke="#2563eb" stroke-width="2" marker-end="url(#dj22a)"/>
  <rect x="404" y="40" width="456" height="150" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="632" y="58" text-anchor="middle" fill="#1e293b" font-weight="bold">initial()</text>
  <rect x="416" y="68" width="104" height="52" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="468" y="88" text-anchor="middle" fill="#1e293b" font-size="10">negotiation</text>
  <text x="468" y="103" text-anchor="middle" fill="#334155" font-size="9">Accept, 406</text>
  <rect x="528" y="68" width="104" height="52" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="580" y="88" text-anchor="middle" fill="#1e293b" font-size="10">version</text>
  <text x="580" y="103" text-anchor="middle" fill="#334155" font-size="9">request.version</text>
  <rect x="640" y="68" width="104" height="52" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="692" y="88" text-anchor="middle" fill="#1e293b" font-size="10">authenticate</text>
  <text x="692" y="103" text-anchor="middle" fill="#334155" font-size="9">request.user (lazy)</text>
  <rect x="752" y="68" width="98" height="52" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="801" y="88" text-anchor="middle" fill="#1e293b" font-size="10">permissions</text>
  <text x="801" y="103" text-anchor="middle" fill="#334155" font-size="9">has_permission</text>
  <rect x="640" y="130" width="210" height="48" rx="6" fill="#ffffff" stroke="#7c3aed"/>
  <text x="745" y="150" text-anchor="middle" fill="#1e293b" font-size="10">throttles: allow_request()</text>
  <text x="745" y="166" text-anchor="middle" fill="#334155" font-size="9">429 + Retry-After</text>
  <text x="520" y="160" text-anchor="middle" fill="#334155" font-size="10">runs BEFORE your handler,</text>
  <text x="520" y="174" text-anchor="middle" fill="#334155" font-size="10">for every request</text>
  <path d="M632,190 L632,214" stroke="#2563eb" stroke-width="2" marker-end="url(#dj22a)"/>
  <rect x="404" y="216" width="456" height="56" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="632" y="236" text-anchor="middle" fill="#1e293b" font-weight="bold">handler = getattr(self, method.lower()) or ViewSet action</text>
  <text x="632" y="254" text-anchor="middle" fill="#334155" font-size="10">get_object() calls check_object_permissions() (detail routes only)</text>
  <path d="M632,272 L632,300" stroke="#2563eb" stroke-width="2" marker-end="url(#dj22a)"/>
  <rect x="404" y="302" width="456" height="56" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="632" y="322" text-anchor="middle" fill="#1e293b" font-weight="bold">finalize_response()</text>
  <text x="632" y="340" text-anchor="middle" fill="#334155" font-size="10">attach renderer, Vary: Accept, Allow; Django renders on the way out</text>
  <path d="M404,140 L230,200" stroke="#dc2626" stroke-width="2" marker-end="url(#dj22b)"/>
  <path d="M404,244 L230,244" stroke="#dc2626" stroke-width="2" marker-end="url(#dj22b)"/>
  <rect x="20" y="196" width="210" height="96" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="125" y="216" text-anchor="middle" fill="#1e293b" font-weight="bold">handle_exception(exc)</text>
  <text x="125" y="234" text-anchor="middle" fill="#334155" font-size="9">401 vs 403 via authenticate_header</text>
  <text x="125" y="250" text-anchor="middle" fill="#334155" font-size="9">EXCEPTION_HANDLER(exc, context)</text>
  <text x="125" y="266" text-anchor="middle" fill="#334155" font-size="9">returns None: re-raise, Django 500</text>
  <text x="125" y="282" text-anchor="middle" fill="#334155" font-size="9">set_rollback() if ATOMIC_REQUESTS</text>
  <path d="M230,280 L402,320" stroke="#dc2626" stroke-width="2" marker-end="url(#dj22b)"/>
</svg>
```

### The class hierarchy

```text
django.views.View
 └─ APIView                              dispatch, initial, handle_exception, finalize_response
     └─ GenericAPIView                   queryset, serializer_class, get_queryset, get_object, get_serializer,
         │                               filter_queryset, paginate_queryset, get_paginated_response
         ├─ ListAPIView        = ListModelMixin     + GenericAPIView  (get → list)
         ├─ CreateAPIView      = CreateModelMixin   + GenericAPIView  (post → create)
         ├─ ListCreateAPIView, RetrieveUpdateDestroyAPIView, ...
         └─ GenericViewSet     = ViewSetMixin + GenericAPIView
             ├─ ReadOnlyModelViewSet = Retrieve + List mixins
             └─ ModelViewSet         = Create + Retrieve + Update + Destroy + List mixins
ViewSet = ViewSetMixin + APIView   (no queryset/serializer machinery)
```

### `get_queryset()` and why `.all()` matters

`GenericAPIView.get_queryset()` returns `self.queryset.all()` if you set a class attribute — and asserts if you set neither attribute nor override. The `.all()` is important: a class attribute is created once at import time and shared across all requests and threads. If DRF evaluated it directly, its result cache would hold rows from the first request forever. `.all()` clones it into a fresh, unevaluated QuerySet per request ([Ch 10 · QuerySets & Lookups](topic.html?p=10-querysets-lookups)). The same reasoning means you should **override `get_queryset()`** whenever the queryset depends on the request (the user, tenant, query params) — never filter `self.queryset` in place.

### `get_object()`

`get_object()` runs `queryset = self.filter_queryset(self.get_queryset())`, builds a filter from `lookup_field` (default `pk`) and `lookup_url_kwarg`, calls `get_object_or_404(queryset, **filter)`, then **`self.check_object_permissions(request, obj)`**. Two consequences: (1) object-level permissions only run where `get_object()` runs — retrieve, update, destroy, and your detail `@action`s that call it — never on `list`; (2) because the lookup uses the *filtered* queryset, scoping `get_queryset()` to the user automatically turns "someone else's object" into a 404 rather than a 403, which avoids leaking existence.

### ViewSets: how actions become handlers

`ViewSetMixin.as_view(actions)` *requires* an `actions` mapping such as `{"get": "list", "post": "create"}`. The returned view function, at request time, does `setattr(self, method, getattr(self, action))` for each pair — literally binding `self.get = self.list` — and sets `self.action` to the action name. After that, the normal `APIView.dispatch` runs unchanged. That is why `self.action` is available in `get_permissions()`, `get_serializer_class()` and `get_queryset()`, and why it can be `None` for an `OPTIONS` request (the metadata handler) — guard for that.

Routers are the thing that calls `as_view(actions)` for you, once for the list route and once for the detail route, plus one per `@action`.

## 4. Architecture & Workflow

### Router → URL → action

```svg
<svg viewBox="0 0 880 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj22c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">router.register("books", BookViewSet, basename="book")</text>
  <rect x="20" y="44" width="200" height="270" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="120" y="66" text-anchor="middle" fill="#1e293b" font-weight="bold">BookViewSet</text>
  <text x="120" y="92" text-anchor="middle" fill="#334155">list()</text>
  <text x="120" y="112" text-anchor="middle" fill="#334155">create()</text>
  <text x="120" y="132" text-anchor="middle" fill="#334155">retrieve()</text>
  <text x="120" y="152" text-anchor="middle" fill="#334155">update() / partial_update()</text>
  <text x="120" y="172" text-anchor="middle" fill="#334155">destroy()</text>
  <text x="120" y="204" text-anchor="middle" fill="#7c3aed">@action(detail=True)</text>
  <text x="120" y="220" text-anchor="middle" fill="#334155">publish()</text>
  <text x="120" y="252" text-anchor="middle" fill="#7c3aed">@action(detail=False)</text>
  <text x="120" y="268" text-anchor="middle" fill="#334155">recent()</text>
  <rect x="290" y="56" width="560" height="64" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="570" y="78" text-anchor="middle" fill="#1e293b" font-weight="bold">^books/$   name="book-list"</text>
  <text x="570" y="98" text-anchor="middle" fill="#334155">as_view({"get": "list", "post": "create"})</text>
  <rect x="290" y="134" width="560" height="64" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="570" y="156" text-anchor="middle" fill="#1e293b" font-weight="bold">^books/{pk}/$   name="book-detail"</text>
  <text x="570" y="176" text-anchor="middle" fill="#334155">as_view({"get": "retrieve", "put": "update", "patch": "partial_update", "delete": "destroy"})</text>
  <rect x="290" y="212" width="560" height="44" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="570" y="238" text-anchor="middle" fill="#1e293b">^books/{pk}/publish/$   name="book-publish"   as_view({"post": "publish"})</text>
  <rect x="290" y="266" width="560" height="44" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="570" y="292" text-anchor="middle" fill="#1e293b">^books/recent/$   name="book-recent"   as_view({"get": "recent"})</text>
  <path d="M220,100 L288,88" stroke="#2563eb" stroke-width="2" marker-end="url(#dj22c)"/>
  <path d="M220,150 L288,166" stroke="#2563eb" stroke-width="2" marker-end="url(#dj22c)"/>
  <path d="M220,214 L288,234" stroke="#2563eb" stroke-width="2" marker-end="url(#dj22c)"/>
  <path d="M220,262 L288,288" stroke="#2563eb" stroke-width="2" marker-end="url(#dj22c)"/>
</svg>
```

Route names are `<basename>-<url_name>`. `basename` defaults to the lowercased model name of `viewset.queryset`; if you only override `get_queryset()` (no `queryset` attribute) you **must** pass `basename=`, or registration fails with an assertion.

### Request walk-through: `PATCH /api/books/7/`

```text
URLResolver → book-detail → view = BookViewSet.as_view({..., "patch": "partial_update"})
  ViewSetMixin.view(): self.action = "partial_update"; self.patch = self.partial_update
  APIView.dispatch():
    initialize_request → Request(JSONParser, ...)
    initial(): negotiate → JSON; version → None; request.user → JWTAuthentication.authenticate()
               check_permissions → IsAuthenticated.has_permission ✓ ; throttles ✓
    partial_update(): update(partial=True)
        instance = get_object()  → get_queryset().filter(...) → get_object_or_404(pk=7)
                                  → check_object_permissions → IsOwner.has_object_permission ✓
        serializer = get_serializer(instance, data=request.data, partial=True)  # request.data parsed NOW
        serializer.is_valid(raise_exception=True)
        perform_update(serializer)  → serializer.save()
        return Response(serializer.data)
    finalize_response → JSONRenderer → 200
```

## 5. Implementation

### Simple example: `APIView` and `@api_view`

```python
# library/views.py
from django.shortcuts import get_object_or_404
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import Book
from .serializers import BookSerializer


class BookList(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request):
        books = Book.objects.select_related("author").order_by("id")[:50]
        return Response(BookSerializer(books, many=True).data)

    def post(self, request):
        serializer = BookSerializer(data=request.data, context={"request": request})
        serializer.is_valid(raise_exception=True)
        serializer.save()
        return Response(serializer.data, status=status.HTTP_201_CREATED)


class BookDetail(APIView):
    def get(self, request, pk):
        book = get_object_or_404(Book, pk=pk)
        self.check_object_permissions(request, book)   # APIView does NOT do this for you
        return Response(BookSerializer(book).data)


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def health(request):
    return Response({"status": "ok", "user": request.user.get_username()})
```

Note the `check_object_permissions` call: with raw `APIView` nothing calls it for you. That single line is a frequent security bug in hand-written views.

### The same thing with generics

```python
from rest_framework import generics


class BookListCreate(generics.ListCreateAPIView):
    serializer_class = BookSerializer
    permission_classes = [IsAuthenticated]

    def get_queryset(self):
        return Book.objects.select_related("author").prefetch_related("tags").order_by("id")

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)


class BookRetrieveUpdateDestroy(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = BookSerializer
    lookup_field = "pk"

    def get_queryset(self):
        return Book.objects.filter(owner=self.request.user)   # others' books → 404
```

### Real-world example: a `ModelViewSet` with per-action behaviour

```python
# library/views.py
from django.db import transaction
from django.db.models import Count
from django.utils import timezone
from rest_framework import mixins, permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from .models import Book
from .permissions import IsOwnerOrReadOnly
from .serializers import BookReadSerializer, BookWriteSerializer, PublishSerializer
from .tasks import notify_followers


class BookViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticatedOrReadOnly, IsOwnerOrReadOnly]

    def get_queryset(self):
        qs = (Book.objects.select_related("author", "owner")
              .prefetch_related("tags")
              .annotate(review_count=Count("reviews")))
        if self.action == "list":
            qs = qs.filter(status=Book.Status.PUBLISHED)
        return qs.order_by("-id")

    def get_serializer_class(self):
        if self.action in ("create", "update", "partial_update"):
            return BookWriteSerializer
        if self.action == "publish":
            return PublishSerializer
        return BookReadSerializer

    def get_permissions(self):
        if self.action == "destroy":
            return [permissions.IsAdminUser()]
        return super().get_permissions()

    def perform_create(self, serializer):
        serializer.save(owner=self.request.user)

    def perform_destroy(self, instance):
        instance.status = Book.Status.DRAFT        # soft "unpublish" instead of DELETE
        instance.save(update_fields=["status"])

    @action(detail=True, methods=["post"])
    def publish(self, request, pk=None):
        book = self.get_object()                    # object permissions run here
        serializer = self.get_serializer(book, data=request.data)
        serializer.is_valid(raise_exception=True)
        with transaction.atomic():
            book.status = Book.Status.PUBLISHED
            book.published_on = serializer.validated_data.get("published_on", timezone.localdate())
            book.save(update_fields=["status", "published_on"])
            transaction.on_commit(lambda: notify_followers.delay(book.id))
        return Response(BookReadSerializer(book, context=self.get_serializer_context()).data)

    @action(detail=False, methods=["get"], url_path="recent", permission_classes=[permissions.AllowAny])
    def recent(self, request):
        qs = self.filter_queryset(self.get_queryset())[:10]
        return Response(BookReadSerializer(qs, many=True, context=self.get_serializer_context()).data)
```

```python
# config/urls.py
from django.urls import include, path
from rest_framework.routers import DefaultRouter

from library.views import BookViewSet

router = DefaultRouter()
router.register(r"books", BookViewSet, basename="book")   # basename needed: no queryset attr

urlpatterns = [
    path("api/", include(router.urls)),
]
```

```bash
python manage.py show_urls   # needs django-extensions; otherwise inspect router.urls in a shell
```

```text
/api/                         api-root
/api/books/                   book-list
/api/books/<pk>/              book-detail
/api/books/<pk>/publish/      book-publish
/api/books/recent/            book-recent
```

The list query the router-backed `list` action issues (with pagination configured, see [Ch 24](topic.html?p=24-drf-pagination-filtering-versioning)):

```sql
SELECT COUNT(*) FROM (SELECT ... FROM "library_book" WHERE "status" = 'published' GROUP BY ...) subquery;
SELECT "library_book".*, "library_author".*, "auth_user".*, COUNT("library_review"."id") AS "review_count"
FROM "library_book"
INNER JOIN "library_author" ON (...) INNER JOIN "auth_user" ON (...)
LEFT OUTER JOIN "library_review" ON ("library_book"."id" = "library_review"."book_id")
WHERE "library_book"."status" = 'published'
GROUP BY "library_book"."id", "library_author"."id", "auth_user"."id"
ORDER BY "library_book"."id" DESC LIMIT 20;
SELECT ... FROM "library_book_tags" INNER JOIN "library_tag" ... WHERE "book_id" IN (...);
```

### Pick only the actions you need

```python
class ReviewViewSet(mixins.CreateModelMixin,
                    mixins.ListModelMixin,
                    viewsets.GenericViewSet):
    """No update/delete: the router will only generate GET/POST on /reviews/."""
    serializer_class = ReviewSerializer

    def get_queryset(self):
        return Review.objects.filter(book_id=self.kwargs["book_pk"])
```

Nested URLs like `/books/{book_pk}/reviews/` are not built into DRF routers; use `drf-nested-routers` or add a `path()` manually with `ReviewViewSet.as_view({"get": "list", "post": "create"})`.

### A plain `ViewSet` for non-model resources

```python
class StatsViewSet(viewsets.ViewSet):
    permission_classes = [permissions.IsAdminUser]

    def list(self, request):
        return Response({"books": Book.objects.count(), "authors": Author.objects.count()})

    def retrieve(self, request, pk=None):
        return Response({"author": pk, "books": Book.objects.filter(author_id=pk).count()})

router.register(r"stats", StatsViewSet, basename="stats")
```

### Custom exception handler: one error envelope

```python
# config/exceptions.py
import logging

from django.db import IntegrityError
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import exception_handler

log = logging.getLogger(__name__)


def api_exception_handler(exc, context):
    response = exception_handler(exc, context)        # handles APIException, Http404, PermissionDenied

    if response is None and isinstance(exc, IntegrityError):
        response = Response({"detail": "Conflict with existing data."}, status=status.HTTP_409_CONFLICT)

    if response is None:
        log.exception("Unhandled API error", extra={"view": context["view"].__class__.__name__})
        return None                                     # let Django return 500 (and Sentry capture it)

    detail = response.data
    response.data = {
        "error": {
            "status": response.status_code,
            "code": getattr(exc, "default_code", "error"),
            "detail": detail,
        }
    }
    return response
```

```python
# settings.py
REST_FRAMEWORK = {
    "EXCEPTION_HANDLER": "config.exceptions.api_exception_handler",
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],   # no browsable API in prod
    "DEFAULT_PARSER_CLASSES": ["rest_framework.parsers.JSONParser"],
}
```

Custom domain exceptions are just `APIException` subclasses:

```python
from rest_framework.exceptions import APIException


class OutOfStock(APIException):
    status_code = 409
    default_detail = "Item is out of stock."
    default_code = "out_of_stock"
```

> **Gotcha:** catching `IntegrityError` in the exception handler while `ATOMIC_REQUESTS=True` is fine — DRF's handler calls `set_rollback()` to mark the request transaction for rollback. But if you catch it *inside* an `atomic()` block in your view without a nested savepoint, the transaction is broken ([Ch 14](topic.html?p=14-transactions-concurrency)).

### Testing a ViewSet

```python
from django.urls import reverse
from rest_framework.test import APITestCase


class BookApiTests(APITestCase):
    @classmethod
    def setUpTestData(cls):
        cls.user = User.objects.create_user("ann", password="pw")

    def test_publish_requires_owner(self):
        book = BookFactory(owner=UserFactory())
        self.client.force_authenticate(self.user)
        resp = self.client.post(reverse("book-publish", args=[book.pk]), {})
        self.assertEqual(resp.status_code, 403)

    def test_list_query_count(self):
        BookFactory.create_batch(25, status="published")
        with self.assertNumQueries(3):
            self.client.get(reverse("book-list"))
```

## 6. Advantages, Disadvantages & Trade-offs

| Style | Code | Control | Best for | Pitfall |
|---|---|---|---|---|
| `@api_view` FBV | Explicit, short | Full | One-off endpoints, webhooks | Easy to forget object permissions |
| `APIView` | Explicit per method | Full | Non-CRUD, RPC-like, aggregations | Repeated boilerplate |
| Generic views | Very little | Via hooks | One or two operations on a model | Hook names must be learned |
| `GenericViewSet` + mixins | Little | Pick actions | Resources with a subset of CRUD | Mixin order / MRO confusion |
| `ModelViewSet` | Least | Via hooks | Full CRUD resources | Exposes DELETE/PUT you may not want |
| `ViewSet` | Medium | Full, no generics | Non-model resources with router URLs | No `get_object()`/pagination for free |

| Router | Adds |
|---|---|
| `SimpleRouter` | list/detail/action routes only |
| `DefaultRouter` | + browsable API root view, + `.json` format-suffix routes |

### When to use
- `ModelViewSet` when the resource genuinely supports all five operations and its URL layout is standard.
- `GenericViewSet` + chosen mixins when it supports some — this is the most common production choice.
- `APIView` for workflows: `/checkout/`, `/auth/login/`, `/reports/sales/`.

### When NOT to use
- Don't use `ModelViewSet` "because it's shorter" if clients must not delete or replace — every inherited action is a public endpoint.
- Don't cram unrelated workflows into a ViewSet as ten `@action`s; that is an RPC service in disguise — give it its own view.
- Don't use routers for deeply nested resources; write explicit `path()`s or use a dedicated package.

## 7. Common Mistakes & Best Practices

**1. Filtering the class-level `queryset` attribute.** `queryset = Book.objects.filter(owner=???)` cannot see the request. Override `get_queryset()`.

**2. Relying on `has_object_permission` for lists.** It never runs on `list`. Scope the queryset (`filter(owner=request.user)`) for list views. See [Ch 23](topic.html?p=23-drf-auth-permissions-throttling).

**3. Skipping `get_object()` in a custom detail action.** `Book.objects.get(pk=pk)` bypasses filtering and object permissions. Always use `self.get_object()`.

**4. Logic in `create()` instead of `perform_create()`.** Overriding `create()` means re-implementing serializer/response handling. Use `perform_create(serializer)` to add `owner=`, enqueue tasks (with `on_commit`), or audit-log.

**5. Assuming `self.action` is always set.** On `OPTIONS` it is `None` (metadata); `if self.action == "list"` is fine, but `self.action.startswith(...)` crashes.

**6. Missing `basename`.** Registering a viewset without a `queryset` attribute raises at import; pass `basename="book"`.

**7. Shipping the browsable API to production.** It is great for development but renders forms, exposes field lists and costs CPU. Restrict `DEFAULT_RENDERER_CLASSES` in production settings.

**8. Forgetting `context` when instantiating serializers manually.** Hyperlinked fields and `CurrentUserDefault` need `request`. Use `self.get_serializer(...)` or pass `context=self.get_serializer_context()`.

**9. Returning Django `JsonResponse` from DRF views.** It bypasses renderers and content negotiation. Return `Response`.

**Best practices:** keep views thin — queryset selection, permission wiring, serializer selection, calling a service; one viewset per resource; explicit mixins; a project-wide exception handler; query-count tests for every list action.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: data leak through an `@action`.** Symptom: a pen test finds `/api/invoices/123/pdf/` returns other tenants' invoices. Root cause: the action did `Invoice.objects.get(pk=pk)` instead of `self.get_object()`, skipping tenant filtering and object permission. Fix: always `get_object()`; add a test per action asserting 404 for foreign objects.

**Pitfall: 403 when the client expected 401.** Symptom: the SPA's token refresh never triggers. Root cause: the first class in `DEFAULT_AUTHENTICATION_CLASSES` is `SessionAuthentication`, which has no `authenticate_header`, so DRF returns 403 for unauthenticated requests. Fix: put the token/JWT authenticator first so 401 + `WWW-Authenticate` is returned.

**Pitfall: stale data from a cached queryset.** Symptom: list endpoint shows rows that were deleted hours ago on one worker. Root cause: someone overrode `get_queryset()` to return `self.queryset` (no `.all()`) after evaluating it in `__init__`, or cached a list on the class. Fix: always return a fresh QuerySet.

**Pitfall: unhandled exceptions return HTML.** With `DEBUG=False`, an exception the handler does not recognise becomes Django's HTML 500 page. Clients choke on it. Fix: set `handler500` to a JSON view for API paths, and make sure Sentry captures the original exception.

**Pitfall: DELETE that cascades.** `ModelViewSet.destroy` calls `instance.delete()`; with `on_delete=CASCADE` one request can delete thousands of rows (and their signals). Override `perform_destroy` for soft-delete or restrict the action.

**Debugging.**
- `print(router.urls)` or `django-extensions`' `show_urls` to confirm generated routes and names.
- DRF's browsable API in dev shows the allowed methods, filters and serializer form for a view.
- `django-debug-toolbar` works with the browsable API to show SQL per request.
- Log `view.action`, `request.user.pk` and status in a middleware or the exception handler for structured request logs ([REST API · Observability](../rest-api/topic.html?p=38-observability-logging-tracing)).

**Scaling.** DRF views are synchronous; under ASGI they run in a thread pool. Throughput comes from fixing queries, paginating, caching (`cache_page` on list actions with `vary_on_headers("Authorization")` for per-user data, see [Ch 29](topic.html?p=29-caching)), moving slow work to Celery ([Ch 31](topic.html?p=31-celery-background-tasks)), and horizontal scaling of stateless workers ([Ch 35](topic.html?p=35-deployment-production)).

## 9. Interview Questions

**Q: What is the difference between `APIView`, generic views and ViewSets?**
A: `APIView` is the base: you write `get()`, `post()` etc. and get DRF's request parsing, auth, permissions, throttling and exception handling. Generic views (`GenericAPIView` + mixins, e.g. `ListCreateAPIView`) add queryset/serializer/lookup/pagination hooks and implement standard CRUD so you mostly override hooks. ViewSets group actions (`list`, `retrieve`, `create`...) for one resource in one class and are bound to HTTP methods by a router via `as_view(actions)`. `ModelViewSet` is a `GenericViewSet` with all five mixins. Choose by how standard the resource is.

**Q: What happens when a request hits a DRF view?**
A: `as_view()` (CSRF-exempted) calls `dispatch()`. It wraps the `HttpRequest` in a DRF `Request`, then `initial()` performs content negotiation, determines the version, authenticates (by touching `request.user`), checks `has_permission` for each permission class, and checks throttles. It then calls the handler for the method (or the bound ViewSet action). Any exception goes through `handle_exception`, which uses the configured exception handler to build a `Response`. Finally `finalize_response` attaches the renderer and headers and Django renders it.

**Q: What is the difference between `ViewSet` and `ModelViewSet`?**
A: `ViewSet` is `ViewSetMixin + APIView`: action-based routing but no `queryset`, `get_object()`, serializer helpers or default actions — you implement `list()`/`retrieve()` yourself. `ModelViewSet` is `GenericViewSet` plus `Create/Retrieve/Update/Destroy/ListModelMixin`, giving full CRUD from `queryset` and `serializer_class`. `ReadOnlyModelViewSet` gives only list and retrieve. In between, you compose `GenericViewSet` with just the mixins you want.

**Q: How do you add a custom endpoint to a ViewSet?**
A: Use `@action(detail=True|False, methods=[...])`. `detail=True` routes to `/{prefix}/{lookup}/{url_path}/` and should call `self.get_object()`; `detail=False` routes to `/{prefix}/{url_path}/`. You can override `permission_classes`, `serializer_class`, `url_path` and `url_name` per action. The route name is `<basename>-<url_name>`, e.g. `book-publish`.

**Q: Why does DRF call `.all()` on the `queryset` attribute in `get_queryset()`?**
A: The class attribute is created once and shared across requests. Evaluating it directly would populate its result cache once and serve stale rows forever. `.all()` returns a fresh clone per request. Override `get_queryset()` whenever filtering depends on the request.

**Q: What is the difference between `perform_create` and `create` in a generic view?**
A: `create()` is the mixin's full handler: build serializer from `request.data`, validate, call `perform_create`, build the 201 response with headers. `perform_create(serializer)` is just the save step (`serializer.save()`), designed as the hook to inject server-side values (`owner=request.user`), audit, or schedule work. Override `perform_create` for these; override `create` only if you need a different response.

**Q: What does a router do, and `SimpleRouter` vs `DefaultRouter`?**
A: A router inspects a ViewSet's actions and generates URL patterns: a list route mapping GET/POST to `list`/`create`, a detail route mapping GET/PUT/PATCH/DELETE, and one per `@action`, all named `<basename>-<name>`. `DefaultRouter` also adds a root view listing the registered endpoints and format-suffix patterns. `basename` comes from `queryset.model` or must be supplied.

**Q: How does DRF handle exceptions and how do you customise the error format?**
A: Views catch exceptions in `handle_exception`. The default `exception_handler` converts `APIException` subclasses (ValidationError 400, NotAuthenticated/AuthenticationFailed 401 or 403, PermissionDenied 403, NotFound 404, MethodNotAllowed 405, Throttled 429...), plus Django's `Http404` and `PermissionDenied`, into `Response`s; anything else returns `None` and becomes a 500. Point `EXCEPTION_HANDLER` at a function that calls the default and reshapes `response.data` into your envelope, and maps extra exceptions like `IntegrityError` to 409.

**Q: Why might DRF return 403 instead of 401 for an unauthenticated request?**
A: 401 requires a `WWW-Authenticate` header. DRF asks the **first** authentication class for `authenticate_header()`; `SessionAuthentication` returns none, so DRF responds 403. `TokenAuthentication`/JWT return a header, so with them first you get 401. Order authenticators deliberately.

**Q: You must expose list, create and retrieve for a resource but never update or delete. How do you build it, and how do you prove nothing else is exposed? (Senior)**
A: Compose `mixins.ListModelMixin, mixins.CreateModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet` rather than subclassing `ModelViewSet` and blocking methods. The router then only maps GET/POST on the list route and GET on detail; PUT/PATCH/DELETE return 405 with a correct `Allow` header. Prove it with tests asserting 405 for each disallowed method, and with the OpenAPI schema (drf-spectacular) diffed in CI so new operations show up in review. Avoid `http_method_names` hacks — they are easy to forget when adding actions.

**Q: How do you make permissions, serializers and querysets differ per action without the ViewSet becoming a mess? (Senior)**
A: Use the hooks keyed by `self.action`: `get_permissions()`, `get_serializer_class()`, `get_queryset()`, and per-`@action` kwargs (`permission_classes=`, `serializer_class=`). For many variants, use declarative maps (`serializer_classes = {"list": ..., "create": ...}` with a fallback) in a small base class. Keep heavy logic out of the view — the action calls a service function that encapsulates the transaction and side effects. Guard for `self.action is None` (OPTIONS). If a ViewSet grows many unrelated actions, split it: actions are for operations on the resource, not a dumping ground.

**Q: An `@action` in production leaked other tenants' data. How did it happen and how do you prevent the class of bug? (Senior)**
A: Typically the action fetched the object directly (`Model.objects.get(pk=pk)`) or built its own queryset, bypassing `get_queryset()` tenant scoping and `check_object_permissions()`. Prevention: tenant-scope in one place (`get_queryset()` in a base class, or a tenant-aware manager), always use `self.get_object()`/`self.get_queryset()` in actions, set restrictive default permission classes globally (`IsAuthenticated`), and add a parametrised test that hits every route in `router.urls` as a user from another tenant and expects 404/403. Code review checklists and a lint rule against `.objects.` in view modules help too.

**Q: How do `ATOMIC_REQUESTS` and DRF's exception handling interact?**
A: With `ATOMIC_REQUESTS=True` Django wraps the view in `transaction.atomic()`. Because DRF converts exceptions into responses (the exception never propagates out of the view), the atomic block would otherwise commit. DRF's default handler calls `set_rollback()`, marking the transaction for rollback when an error response is produced. Custom handlers that call the default inherit that; one that builds responses without it should call `rest_framework.views.set_rollback()` itself.

**Q: How do you version or route nested resources like `/books/{id}/reviews/`?**
A: DRF's built-in routers do not nest. Options: `drf-nested-routers` (`NestedSimpleRouter`) which passes `book_pk` in `self.kwargs`; or explicit `path("books/<int:book_pk>/reviews/", ReviewViewSet.as_view({...}))`. In the nested viewset, filter `get_queryset()` by `self.kwargs["book_pk"]` and verify access to the parent (otherwise you leak children of books the user cannot see). Keep nesting to one level; deeper hierarchies are better as top-level resources with filters.

## 10. Quick Revision & Cheat Sheet

| Concept | Remember |
|---|---|
| `dispatch` order | initialize_request → negotiation → version → auth → permissions → throttles → handler → finalize |
| CSRF | `APIView.as_view` is `csrf_exempt`; `SessionAuthentication` re-enforces it |
| `get_queryset` | returns `queryset.all()`; override for request-dependent filtering |
| `get_object` | filter_queryset + lookup + 404 + `check_object_permissions` |
| Object perms | only via `get_object()` / `check_object_permissions` — never on list |
| Hooks | `perform_create/update/destroy`, `get_serializer_class`, `get_permissions` |
| ViewSet binding | `as_view({"get": "list"})` → `self.get = self.list`, `self.action = "list"` |
| Route names | `<basename>-list`, `<basename>-detail`, `<basename>-<action>` |
| `basename` | required when no `queryset` attribute |
| 401 vs 403 | decided by first authenticator's `authenticate_header()` |

- Prefer `GenericViewSet` + chosen mixins over `ModelViewSet` when not all CRUD is allowed.
- Use `self.get_object()` in every detail action.
- Return `Response`, not `JsonResponse`.
- One `EXCEPTION_HANDLER` for a consistent error envelope.
- Disable the browsable API renderer in production.
- `self.action` can be `None`.
- Nested routes need `drf-nested-routers` or manual paths.

## 11. Hands-On Exercises

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2" "djangorestframework>=3.15" django-extensions
```

1. **Trace dispatch.** Subclass `APIView`, override `initial`, `check_permissions`, `handle_exception` and `finalize_response` to log, and call it with good and bad credentials. Write down the order.
2. **Same endpoint four ways.** Implement "list + create books" as `@api_view`, `APIView`, `ListCreateAPIView` and a `GenericViewSet` with mixins. Compare lines of code and behaviour of `OPTIONS`.
3. **Router inspection.** Register a viewset with two `@action`s and print `router.urls`; reverse each route name in a test.
4. **Security test.** Write a test that iterates every detail route as a foreign user and asserts 404 — then introduce a buggy `@action` using `Model.objects.get` and watch the test catch it.
5. **Error envelope.** Implement the custom exception handler above, map `IntegrityError` to 409, and verify `ATOMIC_REQUESTS` rolls back on a 400.

**Mini project — "Library API v1".** Resources: books (full CRUD for owners, read for all), reviews (create/list only, nested under books), stats (`ViewSet`, admin only). Requirements: per-action serializers and permissions, `publish` action with `on_commit` Celery dispatch, consistent error envelope, query-count tests, no browsable API in production settings.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 04 · Views, Requests & Responses](topic.html?p=04-views-requests-responses) · [Ch 17 · Class-Based & Generic Views](topic.html?p=17-class-based-views) · [Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers) · [Ch 23 · DRF Authentication, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling) · [Ch 24 · DRF Pagination, Filtering, Versioning & Docs](topic.html?p=24-drf-pagination-filtering-versioning) · [Ch 33 · Testing Django Applications](topic.html?p=33-testing) · [Ch 38 · Interview: DRF, Security & Scale](topic.html?p=38-interview-drf-advanced)

**Other handbooks:** [REST API · Resource Modeling & URI Design](../rest-api/topic.html?p=05-resource-modeling-uri-design) · [REST API · HTTP Methods & Idempotency](../rest-api/topic.html?p=06-http-methods-idempotency) · [REST API · Status Codes](../rest-api/topic.html?p=07-status-codes) · [REST API · Content Negotiation](../rest-api/topic.html?p=11-content-negotiation) · [REST API · Error Handling & Problem Details](../rest-api/topic.html?p=16-error-handling-problem-details)

- **Views (API Guide)** — Django REST framework · *Beginner* · `APIView`, `@api_view` and the policy attributes. <https://www.django-rest-framework.org/api-guide/views/>
- **Generic views** — Django REST framework · *Intermediate* · every hook on `GenericAPIView` and the mixins. <https://www.django-rest-framework.org/api-guide/generic-views/>
- **ViewSets** — Django REST framework · *Intermediate* · actions, `@action`, and per-action configuration. <https://www.django-rest-framework.org/api-guide/viewsets/>
- **Routers** — Django REST framework · *Intermediate* · generated routes, basenames, custom routers. <https://www.django-rest-framework.org/api-guide/routers/>
- **Exceptions** — Django REST framework · *Intermediate* · the exception classes and writing a custom handler. <https://www.django-rest-framework.org/api-guide/exceptions/>
- **Classy DRF** — cdrf.co · *Intermediate* · every method of every DRF class view, with the MRO laid out. <https://www.cdrf.co/>
- **drf-nested-routers** — alanjds on GitHub · *Intermediate* · nested routes for ViewSets. <https://github.com/alanjds/drf-nested-routers>

---

*Django Handbook — chapter 22.*
