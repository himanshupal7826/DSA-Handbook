# 40 · Django Design Rounds: Building Real Systems

> **In one line:** A Django design round is judged on whether your models, transactions and background jobs keep their promises under concurrency and failure, not on how many boxes you draw. This chapter works through five full rounds (checkout without overselling, multi-tenant SaaS, a notification fan-out pipeline, a rate-limited public API and a URL shortener) with real model, serializer, view and Celery code, and says where each design breaks.

---

## 1. Overview

> **Builds on:** [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency), [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers), [Ch 23 · DRF Authentication, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling), [Ch 29 · Caching in Django](topic.html?p=29-caching), [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks), [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases).

Generic system design interviews ask you to draw load balancers and pick databases. A **Django design round** is different. The interviewer already knows you'll use Django, PostgreSQL, Redis and Celery. What they want to see is whether you can turn a product requirement into *specific* Django code that stays correct when two requests arrive in the same millisecond, when a worker dies halfway through a task, or when one tenant's query could leak into another's response. A typical 45–60 minute round runs like this:

1. **Clarify** (5 min): users, read/write ratio, peak numbers, and *what must never happen*: an oversell, a double charge, a data leak.
2. **Model** (10 min): models with constraints and indexes derived from the queries.
3. **API** (5–10 min): DRF endpoints, serializers, error codes.
4. **Correctness** (10–15 min): transactions, locks, idempotency, `on_commit`. This is where most of the scoring happens.
5. **Async work** (5 min): which Celery tasks there are, what happens on retry, and how each task stays idempotent.
6. **Scale and failure** (10 min): caching, replicas, hot rows, queue backlogs, and what happens when Redis or the payment provider is down.

The naive approach fails in a predictable way. The candidate designs a clean model, writes `if product.stock >= qty: product.stock -= qty; product.save()`, enqueues `send_email.delay(order.id)` inside the transaction, and caches with `locmem`. Every one of those lines is a production incident: a lost update, a task that runs before the row is committed, and a cache that isn't shared between workers. The rounds below are written to show the correct version of each move and to explain *why* it's correct.

> **Interview tip:** Say the invariant out loud before writing code: "stock never goes below zero, and an order is charged at most once." Then point at the line of code that enforces each invariant. Interviewers score that more than diagrams.

## 2. Core Concepts

The toolkit every round reuses. Each item has a home chapter. Here it is in one line, with the reason it matters.

- **Invariant**: a property that must hold no matter how requests interleave (stock ≥ 0, one charge per order). *Why it matters:* you design the locking around invariants, not around endpoints.
- **`transaction.atomic()`**: all-or-nothing writes; nested blocks become savepoints. *Why:* partial writes are how inventory and money drift.
- **`select_for_update()`**: row locks held until commit; `skip_locked` for work queues, `nowait` to fail fast, `of=` to lock only some tables. *Why:* it serialises read-modify-write on the same rows.
- **Conditional `update()` with `F()`**: `filter(stock__gte=n).update(stock=F("stock") - n)` puts the check and the write in one statement. *Why:* it's the cheapest correct way to decrement a counter.
- **Idempotency key**: a client-supplied key stored under a `UniqueConstraint`, so a retried POST returns the original result. *Why:* mobile clients and load balancers retry.
- **`transaction.on_commit()`**: runs a callback only after the outermost commit. *Why:* a Celery task enqueued inside the transaction can run before the row is visible, or run for a row that was rolled back.
- **Transactional outbox**: write an event row in the same transaction as the domain change, and have a relay publish it later. *Why:* `on_commit` callbacks are lost if the process dies right after commit, while an outbox row is durable.
- **Idempotent task**: a task that can run twice with the same final effect, enforced by a status guard or a unique constraint. *Why:* with `acks_late=True`, Celery delivers at least once.
- **Tenant scoping**: every query filtered by the tenant, ideally enforced in one place (a manager, or PostgreSQL row-level security). *Why:* a single forgotten `.filter(tenant=...)` is a data breach.
- **Shared rate limiting**: counters in Redis, updated atomically with Lua, rather than per-process `locmem`. *Why:* DRF throttles that use the default per-process cache let each worker grant the full quota.
- **Back-of-envelope numbers**: 1M requests/day is about 12 requests/second on average, and peaks run 5–10× the average. A PostgreSQL primary on decent hardware handles thousands of simple indexed writes per second. One Gunicorn sync worker handles about 1 / (mean latency) requests per second. *Why:* the numbers decide whether you need caching or queues at all.

## 3. Theory & Principles

### Round 1: E-commerce checkout without overselling

**Requirements.** Logged-in users check out a cart of up to 20 products. Normal load is about 50 checkouts per minute. A flash sale peaks around 3,000 per minute on a few hot products. The service must never oversell, never charge twice, and must release stock if payment fails or is abandoned within 15 minutes. Payment uses an external provider (Stripe-like) that supports idempotency keys.

**The two invariants.** (1) `Product.stock` never goes negative, and units sold never exceed units stocked. (2) Each order produces at most one successful charge.

```svg
<svg viewBox="0 0 880 290" width="100%" height="290" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj40a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
      <marker id="dj40c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Checkout: one transaction for stock + order, payment after commit</text>
  <rect x="20" y="40" width="120" height="56" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="80" y="62" text-anchor="middle" fill="#1e293b" font-weight="bold">Client</text>
  <text x="80" y="80" text-anchor="middle" fill="#334155" font-size="9">Idempotency-Key: k1</text>
  <path d="M140,68 L178,68" stroke="#2563eb" stroke-width="2" marker-end="url(#dj40a)"/>
  <rect x="180" y="40" width="680" height="232" rx="10" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="520" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">CheckoutView.post: inside transaction.atomic()</text>
  <rect x="196" y="72" width="150" height="74" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="271" y="92" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">1. INSERT order</text>
  <text x="271" y="110" text-anchor="middle" fill="#334155" font-size="9">UNIQUE(user, idem_key)</text>
  <text x="271" y="126" text-anchor="middle" fill="#334155" font-size="9">duplicate: IntegrityError</text>
  <text x="271" y="140" text-anchor="middle" fill="#334155" font-size="9">return original order</text>
  <path d="M346,108 L370,108" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj40c)"/>
  <rect x="372" y="72" width="160" height="74" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="452" y="92" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">2. SELECT ... FOR UPDATE</text>
  <text x="452" y="110" text-anchor="middle" fill="#334155" font-size="9">products ORDER BY id</text>
  <text x="452" y="126" text-anchor="middle" fill="#334155" font-size="9">same lock order in every</text>
  <text x="452" y="140" text-anchor="middle" fill="#334155" font-size="9">request: no deadlock cycle</text>
  <path d="M532,108 L556,108" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj40c)"/>
  <rect x="558" y="72" width="140" height="74" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="628" y="92" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">3. check stock</text>
  <text x="628" y="110" text-anchor="middle" fill="#334155" font-size="9">short: raise OutOfStock</text>
  <text x="628" y="126" text-anchor="middle" fill="#334155" font-size="9">whole block rolls back</text>
  <text x="628" y="140" text-anchor="middle" fill="#334155" font-size="9">409 to client</text>
  <path d="M698,108 L722,108" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj40c)"/>
  <rect x="724" y="72" width="124" height="74" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="786" y="92" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">4. write</text>
  <text x="786" y="110" text-anchor="middle" fill="#334155" font-size="9">lines + stock</text>
  <text x="786" y="126" text-anchor="middle" fill="#334155" font-size="9">status=AWAITING</text>
  <text x="786" y="140" text-anchor="middle" fill="#334155" font-size="9">_PAYMENT</text>
  <rect x="196" y="162" width="652" height="96" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="522" y="182" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">5. transaction.on_commit(lambda: charge_order.delay(order.id))</text>
  <text x="522" y="202" text-anchor="middle" fill="#334155" font-size="10">registered now, runs only after COMMIT; discarded on rollback</text>
  <text x="522" y="222" text-anchor="middle" fill="#334155" font-size="10">locks are released at COMMIT, so hold them for milliseconds and never across the payment HTTP call</text>
  <text x="522" y="242" text-anchor="middle" fill="#334155" font-size="10">concurrent buyer of the same product waits at step 2, then re-reads the committed stock</text>
</svg>
```

**Models.**

```python
# shop/models.py
from django.conf import settings
from django.db import models
from django.db.models import Q


class Product(models.Model):
    sku = models.CharField(max_length=40, unique=True)
    name = models.CharField(max_length=200)
    price = models.DecimalField(max_digits=10, decimal_places=2)
    stock = models.PositiveIntegerField()        # PostgreSQL CHECK (stock >= 0) is created for you
    is_active = models.BooleanField(default=True)


class Order(models.Model):
    class Status(models.TextChoices):
        AWAITING_PAYMENT = "awaiting_payment"
        PAID = "paid"
        CANCELLED = "cancelled"
        EXPIRED = "expired"

    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.PROTECT, related_name="orders")
    idempotency_key = models.CharField(max_length=64)
    request_hash = models.CharField(max_length=64)  # sha256 of the normalised payload
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.AWAITING_PAYMENT)
    total = models.DecimalField(max_digits=12, decimal_places=2)
    payment_ref = models.CharField(max_length=100, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=["user", "idempotency_key"], name="uniq_order_idem_key"),
        ]
        indexes = [
            models.Index(fields=["created_at"], name="order_awaiting_idx",
                         condition=Q(status="awaiting_payment")),
        ]


class OrderLine(models.Model):
    order = models.ForeignKey(Order, on_delete=models.CASCADE, related_name="lines")
    product = models.ForeignKey(Product, on_delete=models.PROTECT, related_name="+")
    quantity = models.PositiveIntegerField()
    unit_price = models.DecimalField(max_digits=10, decimal_places=2)  # price snapshot

    class Meta:
        constraints = [models.UniqueConstraint(fields=["order", "product"], name="uniq_line_product")]
```

The model decisions follow from the invariants. `PositiveIntegerField` gives a database CHECK as a backstop for stock. `UNIQUE(user, idempotency_key)` makes duplicate submission a database error rather than a race. `unit_price` snapshots the price so later price changes don't rewrite history. The partial index serves the expiry sweep without indexing the paid orders, which are the vast majority.

**Service layer (the part that's scored).**

```python
# shop/services.py
import hashlib
import json
from decimal import Decimal

from django.db import IntegrityError, transaction

from .models import Order, OrderLine, Product
from .tasks import charge_order


class OutOfStock(Exception):
    def __init__(self, product_ids):
        self.product_ids = product_ids


class IdempotencyConflict(Exception):
    """Same key reused with a different payload."""


def _hash(items) -> str:
    canonical = json.dumps(sorted((i["product_id"], i["quantity"]) for i in items))
    return hashlib.sha256(canonical.encode()).hexdigest()


def place_order(user, key: str, items: list[dict]) -> tuple[Order, bool]:
    """Returns (order, created). Safe under concurrent duplicates and concurrent buyers."""
    req_hash = _hash(items)
    try:
        with transaction.atomic():
            order = Order.objects.create(user=user, idempotency_key=key,
                                         request_hash=req_hash, total=Decimal("0"))
            wanted = {i["product_id"]: i["quantity"] for i in items}
            products = list(
                Product.objects.select_for_update()
                .filter(pk__in=wanted, is_active=True)
                .order_by("pk")                      # consistent lock order: no deadlocks
            )
            short = [p.pk for p in products if p.stock < wanted[p.pk]]
            missing = set(wanted) - {p.pk for p in products}
            if short or missing:
                raise OutOfStock(sorted(short) + sorted(missing))   # rolls back the order row too

            lines, total = [], Decimal("0")
            for p in products:
                p.stock -= wanted[p.pk]
                lines.append(OrderLine(order=order, product=p, quantity=wanted[p.pk], unit_price=p.price))
                total += p.price * wanted[p.pk]
            Product.objects.bulk_update(products, ["stock"])
            OrderLine.objects.bulk_create(lines)
            order.total = total
            order.save(update_fields=["total"])
            transaction.on_commit(lambda: charge_order.delay(order.pk))
            return order, True
    except IntegrityError:
        # Another request with the same key committed first (our INSERT waited on its unique entry).
        order = Order.objects.get(user=user, idempotency_key=key)
        if order.request_hash != req_hash:
            raise IdempotencyConflict(key)
        return order, False
```

Why this is correct:

- **Duplicate submissions.** Two requests with key `k1` both try the INSERT. The second blocks on the first's uncommitted unique-index entry. When the first commits, the second gets `IntegrityError`. Because the error is raised inside `atomic()`, the block rolls back cleanly, and the `except` outside the block can still query safely. It returns the original order, and the view answers `200` instead of `201`. A different payload under the same key becomes a `422`.
- **Concurrent buyers.** `select_for_update()` locks the product rows, so a second buyer waits and then reads the *committed* stock. Locking in `pk` order means two carts `{A, B}` and `{B, A}` can't deadlock each other.
- **Atomic failure.** `OutOfStock` raised inside the block undoes the order INSERT. The client never sees a half-created order.
- **Task timing.** `on_commit` enqueues the charge only after commit. Under `TestCase` you must use `captureOnCommitCallbacks` to see it fire.

> **Version note:** a lock-free alternative for single-product carts is `Product.objects.filter(pk=p, stock__gte=q).update(stock=F("stock") - q)`, checking that the row count is 1. For multi-product carts, apply the updates in `pk` order inside `atomic()` and raise on the first 0, so the earlier decrements roll back.

**API.**

```python
# shop/api.py
from rest_framework import serializers, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .services import IdempotencyConflict, OutOfStock, place_order


class CartItemSerializer(serializers.Serializer):
    product_id = serializers.IntegerField(min_value=1)
    quantity = serializers.IntegerField(min_value=1, max_value=10)


class CheckoutSerializer(serializers.Serializer):
    items = CartItemSerializer(many=True, allow_empty=False, max_length=20)

    def validate_items(self, items):
        if len({i["product_id"] for i in items}) != len(items):
            raise serializers.ValidationError("Duplicate product in cart.")
        return items


class CheckoutView(APIView):
    permission_classes = [IsAuthenticated]
    throttle_scope = "checkout"

    def post(self, request):
        key = request.headers.get("Idempotency-Key", "")
        if not 8 <= len(key) <= 64:
            return Response({"detail": "Idempotency-Key header required."}, status=400)
        ser = CheckoutSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        try:
            order, created = place_order(request.user, key, ser.validated_data["items"])
        except OutOfStock as exc:
            return Response({"detail": "Insufficient stock.", "product_ids": exc.product_ids},
                            status=status.HTTP_409_CONFLICT)
        except IdempotencyConflict:
            return Response({"detail": "Idempotency-Key reused with a different payload."},
                            status=status.HTTP_422_UNPROCESSABLE_ENTITY)
        body = {"order_id": order.pk, "status": order.status, "total": str(order.total)}
        return Response(body, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)
```

**Celery tasks.** Every task here can run twice without harm.

```python
# shop/tasks.py
from datetime import timedelta

from celery import shared_task
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from .models import Order, Product
from .payments import PaymentDeclined, ProviderUnavailable, provider


@shared_task(bind=True, acks_late=True, autoretry_for=(ProviderUnavailable,),
             retry_backoff=True, retry_backoff_max=300, retry_jitter=True, max_retries=10)
def charge_order(self, order_id: int) -> None:
    order = Order.objects.get(pk=order_id)
    if order.status != Order.Status.AWAITING_PAYMENT:
        return                                         # already paid / cancelled / expired
    try:
        ref = provider.charge(customer=order.user_id, amount=order.total,
                              idempotency_key=f"order-{order.pk}")   # provider dedupes retries
    except PaymentDeclined:
        cancel_order(order.pk, Order.Status.CANCELLED)
        return
    marked = (Order.objects.filter(pk=order.pk, status=Order.Status.AWAITING_PAYMENT)
              .update(status=Order.Status.PAID, payment_ref=ref))
    if not marked:
        provider.refund(ref, idempotency_key=f"refund-order-{order.pk}")  # expired meanwhile


def cancel_order(order_id: int, new_status: str) -> bool:
    with transaction.atomic():
        order = (Order.objects.select_for_update()
                 .filter(pk=order_id, status=Order.Status.AWAITING_PAYMENT).first())
        if order is None:
            return False                                # someone else already finalised it
        for line in order.lines.order_by("product_id"):
            Product.objects.filter(pk=line.product_id).update(stock=F("stock") + line.quantity)
        order.status = new_status
        order.save(update_fields=["status"])
        return True


@shared_task
def expire_stale_orders(batch: int = 200) -> int:
    cutoff = timezone.now() - timedelta(minutes=15)
    ids = list(Order.objects.filter(status=Order.Status.AWAITING_PAYMENT, created_at__lt=cutoff)
               .values_list("pk", flat=True)[:batch])
    return sum(cancel_order(pk, Order.Status.EXPIRED) for pk in ids)
```

The status guard on every transition (`filter(status=AWAITING_PAYMENT)`) turns the state machine into compare-and-swap. A late "paid" result for an order the sweeper already expired is detected because the update affects zero rows, and the charge is refunded rather than silently kept. The provider's idempotency key makes a retried `charge` return the original charge. Without that key, `acks_late` plus a worker crash after the HTTP call would charge the customer twice.

**Caching.** Product pages and prices are cached (`cache_page` or low-level caching with a version bumped on update). The checkout path never reads stock from cache. A cached number is only a hint; the locked row is the truth.

**Scaling path and failure modes.**

- **Hot row in a flash sale.** 3,000 checkouts per minute on one product serialise on one row lock. With about 5 ms of lock time per transaction that's still within budget, but lock time grows with transaction length. Keep the transaction short and do no HTTP inside it. Past that point, put a Redis gate in front of the database (an atomic `DECRBY` in a Lua script that refuses to go below zero) so that only requests holding a reservation reach PostgreSQL. Or split the inventory into N bucket rows (`ProductStockShard(product, shard, stock)`) and decrement a random shard that has stock.
- **Connections.** Waiting on locks holds connections. Use pooling (the Django 5.1+ `OPTIONS["pool"]` setting or PgBouncer in transaction mode) and set `lock_timeout` so a pile-up fails fast as `409`/`503` rather than exhausting workers.
- **Broker down.** `on_commit` → `.delay()` raises after the order committed. The order stays `AWAITING_PAYMENT`, so add a beat task that re-enqueues `charge_order` for awaiting orders older than a minute (the task is idempotent), or move to an outbox (Round 3).
- **Provider down.** `autoretry_for` with backoff, and the sweeper expires anything left too long. The UI shows "payment pending".

## 4. Architecture & Workflow

### Round 2: Multi-tenant SaaS (project management)

**Requirements.** B2B project tracker with 5,000 tenant organisations. Most are small; the 20 largest have 10k users. Users can belong to several tenants. URLs look like `acme.tracker.app`. A tenant must never see another tenant's data. Enterprise customers may later demand physical isolation. Peak load is about 2,000 requests per second, and 90% are reads.

**Isolation options (the first question the interviewer asks).**

| Model | How | Isolation | Ops cost | Fits |
|---|---|---|---|---|
| Shared schema, `tenant_id` column | FK on every table + scoped manager (+ RLS) | Logical | Lowest: one schema, one migration | Thousands of small tenants (our case) |
| Schema per tenant | PostgreSQL `search_path` per request (e.g. django-tenants) | Stronger | Migrations × N schemas; catalog bloat past a few thousand | Hundreds of mid-size tenants |
| Database per tenant | DB router picks the alias per request | Physical | Highest: N databases, pools, backups | A few enterprise tenants, compliance |

The answer here is a shared schema with defence in depth, plus a router-based escape hatch that can move an enterprise tenant to its own database later.

**Models and the scoped manager.**

```python
# tenancy/context.py
from contextlib import contextmanager
from contextvars import ContextVar

_current_tenant: ContextVar["Tenant | None"] = ContextVar("current_tenant", default=None)


class NoTenant(RuntimeError):
    pass


def get_current_tenant():
    tenant = _current_tenant.get()
    if tenant is None:
        raise NoTenant("Tenant-scoped query without a tenant in context.")
    return tenant


@contextmanager
def tenant_context(tenant):
    token = _current_tenant.set(tenant)
    try:
        yield tenant
    finally:
        _current_tenant.reset(token)
```

```python
# tenancy/models.py
from django.conf import settings
from django.db import models

from .context import get_current_tenant


class Tenant(models.Model):
    slug = models.SlugField(unique=True)
    name = models.CharField(max_length=200)
    plan = models.CharField(max_length=20, default="team")
    db_alias = models.CharField(max_length=40, default="default")


class Membership(models.Model):
    class Role(models.TextChoices):
        OWNER = "owner"
        ADMIN = "admin"
        MEMBER = "member"

    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="memberships")
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="memberships")
    role = models.CharField(max_length=10, choices=Role.choices, default=Role.MEMBER)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["tenant", "user"], name="uniq_membership")]


class TenantQuerySet(models.QuerySet):
    pass


class TenantManager(models.Manager.from_queryset(TenantQuerySet)):
    def get_queryset(self):
        return super().get_queryset().filter(tenant=get_current_tenant())


class TenantScoped(models.Model):
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name="+", editable=False)

    objects = TenantManager()            # default manager: scoped, fails closed
    unscoped = models.Manager()          # explicit, grep-able escape hatch for admin/ops

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        if self.tenant_id is None:
            self.tenant = get_current_tenant()
        elif self.tenant_id != get_current_tenant().pk:
            raise PermissionError("Cross-tenant write.")
        super().save(*args, **kwargs)


class Project(TenantScoped):
    slug = models.SlugField()
    name = models.CharField(max_length=200)
    archived = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["tenant", "slug"], name="uniq_project_slug")]
        indexes = [models.Index(fields=["tenant", "archived", "name"])]
```

The `tenant` column leads every composite index and every unique constraint. Every query starts with `tenant_id = ?`, and two tenants can both have a project called `roadmap`. Related managers (`tenant.projects`, `project.tasks`) are built from the related model's default manager, so they're scoped too. Django uses `_base_manager` (a plain `Manager`) for forward FK access like `task.project`, and that path is safe because the FK came from a row that was already scoped.

**Middleware, permission and view.**

```python
# tenancy/middleware.py
from django.core.cache import cache
from django.http import Http404

from .context import tenant_context
from .models import Tenant


class TenantMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        slug = request.get_host().split(":")[0].split(".")[0]
        tenant = cache.get(f"tenant:{slug}")
        if tenant is None:
            tenant = Tenant.objects.filter(slug=slug).first()
            if tenant is None:
                raise Http404("Unknown tenant")
            cache.set(f"tenant:{slug}", tenant, 300)
        request.tenant = tenant
        with tenant_context(tenant):
            return self.get_response(request)
```

```python
# tenancy/permissions.py
from rest_framework.permissions import BasePermission

from .models import Membership


class IsTenantMember(BasePermission):
    def has_permission(self, request, view):
        if not (request.user and request.user.is_authenticated):
            return False
        role = (Membership.objects.filter(tenant=request.tenant, user=request.user)
                .values_list("role", flat=True).first())
        request.tenant_role = role
        return role is not None
```

```python
# projects/api.py
from rest_framework import serializers, viewsets

from tenancy.permissions import IsTenantMember
from .models import Project


class ProjectSerializer(serializers.ModelSerializer):
    class Meta:
        model = Project
        fields = ["id", "slug", "name", "archived"]


class ProjectViewSet(viewsets.ModelViewSet):
    serializer_class = ProjectSerializer
    permission_classes = [IsTenantMember]

    def get_queryset(self):
        return Project.objects.filter(archived=False).order_by("name")
```

`ModelSerializer` would normally add a `UniqueTogetherValidator` for `(tenant, slug)`, but `tenant` isn't a serializer field. So add a `validate_slug()` that checks `Project.objects.filter(slug=value).exists()` against the scoped manager (excluding `self.instance` on update), and let the database constraint catch the race between two simultaneous creates (`IntegrityError` → 409 in a custom exception handler). Because `get_queryset` uses the scoped manager, `get_object()` on `/projects/<id>/` returns 404 for another tenant's id. That's the correct response: never 403, which would confirm the id exists.

**Celery and tenant context.** A task has no request, so it receives `tenant_id`, loads the tenant and wraps its body in `with tenant_context(tenant):`. The scoped manager then works unchanged, and a task that forgets to do this fails with `NoTenant` instead of leaking data.

**Row-level security backstop.** A `RunSQL` migration runs `ALTER TABLE projects_project ENABLE ROW LEVEL SECURITY`, then `FORCE ROW LEVEL SECURITY` so the table owner is filtered too, and `CREATE POLICY tenant_isolation ON projects_project USING (tenant_id = current_setting('app.tenant_id')::bigint)`. With `ATOMIC_REQUESTS=True`, a small middleware placed after `TenantMiddleware` runs `SET LOCAL app.tenant_id = %s` through `connection.cursor()` at the start of each request. `SET LOCAL` is scoped to the transaction, which makes it safe with PgBouncer in transaction mode. A plain `SET` would leak the tenant to the next client of a pooled connection. If `app.tenant_id` was never set, `current_setting` raises an error, so a missing tenant fails closed. Ops and migration roles use a role with `BYPASSRLS`.

**Caching and scaling.** Every cache key is built through a helper `tkey(name) -> f"t{tenant.pk}:{name}"`. Reads go to a replica via a router for list endpoints that tolerate a second of lag. Read-your-writes views pin to the primary for a few seconds after a write (a session flag or cookie). The 20 big tenants dominate load, so per-tenant throttling (`ScopedRateThrottle` keyed by tenant, on a Redis cache) stops one tenant's batch job from starving everyone else. That's the noisy-neighbour problem.

**Failure modes.** The worst bug is a `NoTenant` check that someone turns into a silent no-op, so the manager returns unscoped data. Write a test that runs every endpoint as tenant A against data seeded for tenant B and asserts 404 or empty lists. Run it in CI for every new viewset.

## 5. Implementation

### Round 3: Notifications and fan-out pipeline

**Requirements.** A social learning platform has 8M users. Events include "someone replied to your thread" (one recipient), "a course you follow published a lesson" (up to 500k recipients), and transactional mail like password resets and receipts. Channels are in-app (persisted, with a websocket push to online users), email and mobile push. Users set per-category, per-channel preferences. Each notification is delivered at most once per channel. Transactional mail must arrive within seconds even while a 500k fan-out is running. Volume is about 30M notifications per day, roughly 350 per second on average and several thousand per second during fan-out bursts.

```svg
<svg viewBox="0 0 880 296" width="100%" height="296" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj40f" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="dj40g" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Notification pipeline: outbox, chunked fan-out, idempotent per-channel delivery</text>
  <rect x="20" y="44" width="190" height="90" rx="8" fill="#dbeafe" stroke="#2563eb"/>
  <text x="115" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">Domain transaction</text>
  <text x="32" y="84" fill="#334155" font-size="10">INSERT lesson</text>
  <text x="32" y="100" fill="#334155" font-size="10">INSERT outbox_event</text>
  <text x="32" y="116" fill="#334155" font-size="10">COMMIT (both or neither)</text>
  <path d="M210,89 L244,89" stroke="#2563eb" stroke-width="2" marker-end="url(#dj40f)"/>
  <rect x="246" y="44" width="190" height="90" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="341" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">relay_outbox (beat, 2 s)</text>
  <text x="258" y="84" fill="#334155" font-size="10">FOR UPDATE SKIP LOCKED</text>
  <text x="258" y="100" fill="#334155" font-size="10">fan_out.delay(event_id)</text>
  <text x="258" y="116" fill="#334155" font-size="10">mark published_at</text>
  <path d="M436,89 L470,89" stroke="#2563eb" stroke-width="2" marker-end="url(#dj40f)"/>
  <rect x="472" y="44" width="190" height="90" rx="8" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="567" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">fan_out(event)</text>
  <text x="484" y="84" fill="#334155" font-size="10">stream recipient ids</text>
  <text x="484" y="100" fill="#334155" font-size="10">keyset batches of 1,000</text>
  <text x="484" y="116" fill="#334155" font-size="10">one task per batch</text>
  <path d="M662,89 L696,89" stroke="#2563eb" stroke-width="2" marker-end="url(#dj40f)"/>
  <rect x="698" y="44" width="162" height="90" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="779" y="64" text-anchor="middle" fill="#1e293b" font-weight="bold">materialise(batch)</text>
  <text x="710" y="84" fill="#334155" font-size="10">filter preferences</text>
  <text x="710" y="100" fill="#334155" font-size="10">bulk_create, ignore</text>
  <text x="710" y="116" fill="#334155" font-size="10">conflicts (unique)</text>
  <path d="M779,134 L779,166" stroke="#16a34a" stroke-width="2" marker-end="url(#dj40g)"/>
  <rect x="20" y="170" width="840" height="110" rx="8" fill="#f8fafc" stroke="#94a3b8"/>
  <text x="440" y="190" text-anchor="middle" fill="#1e293b" font-weight="bold">Per-channel delivery: separate queues so bulk never delays transactional</text>
  <rect x="36" y="202" width="190" height="66" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="131" y="222" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">in-app (queue: realtime)</text>
  <text x="131" y="240" text-anchor="middle" fill="#334155" font-size="9">row exists = delivered</text>
  <text x="131" y="256" text-anchor="middle" fill="#334155" font-size="9">group_send("user_42")</text>
  <rect x="244" y="202" width="190" height="66" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="339" y="222" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">email (queue: bulk_email)</text>
  <text x="339" y="240" text-anchor="middle" fill="#334155" font-size="9">claim PENDING to SENDING</text>
  <text x="339" y="256" text-anchor="middle" fill="#334155" font-size="9">provider key = delivery id</text>
  <rect x="452" y="202" width="190" height="66" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="547" y="222" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">transactional (queue: tx)</text>
  <text x="547" y="240" text-anchor="middle" fill="#334155" font-size="9">dedicated workers</text>
  <text x="547" y="256" text-anchor="middle" fill="#334155" font-size="9">never behind a fan-out</text>
  <rect x="660" y="202" width="186" height="66" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="753" y="222" text-anchor="middle" fill="#1e293b" font-size="10" font-weight="bold">push (queue: push)</text>
  <text x="753" y="240" text-anchor="middle" fill="#334155" font-size="9">batch per provider API</text>
  <text x="753" y="256" text-anchor="middle" fill="#334155" font-size="9">prune dead tokens</text>
</svg>
```

**Models.**

```python
# notifications/models.py
import uuid

from django.conf import settings
from django.db import models
from django.db.models import Q


class OutboxEvent(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4)
    topic = models.CharField(max_length=60)              # "lesson.published"
    payload = models.JSONField()
    created_at = models.DateTimeField(auto_now_add=True)
    published_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        indexes = [models.Index(fields=["created_at"], name="outbox_unpublished",
                                condition=Q(published_at__isnull=True))]


class Notification(models.Model):
    event = models.ForeignKey(OutboxEvent, on_delete=models.CASCADE, related_name="+")
    recipient = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                                  related_name="notifications")
    category = models.CharField(max_length=40)
    title = models.CharField(max_length=200)
    url = models.CharField(max_length=500)
    created_at = models.DateTimeField(auto_now_add=True)
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["event", "recipient"], name="uniq_event_recipient")]
        indexes = [
            models.Index(fields=["recipient", "-created_at"], name="notif_inbox"),
            models.Index(fields=["recipient"], name="notif_unread", condition=Q(read_at__isnull=True)),
        ]


class Delivery(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending"
        SENDING = "sending"
        SENT = "sent"
        FAILED = "failed"

    notification = models.ForeignKey(Notification, on_delete=models.CASCADE, related_name="deliveries")
    channel = models.CharField(max_length=10)
    status = models.CharField(max_length=10, choices=Status.choices, default=Status.PENDING)
    attempts = models.PositiveSmallIntegerField(default=0)
    claimed_at = models.DateTimeField(null=True, blank=True)
    provider_id = models.CharField(max_length=100, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=["notification", "channel"], name="uniq_delivery")]
        indexes = [models.Index(fields=["claimed_at"], name="delivery_sending",
                                condition=Q(status="sending"))]
```

`Preference(user, category, channel, enabled)` with a unique constraint on the first three fields is stored *sparsely*: only opt-outs are rows, and the default is enabled. A million users don't need a million preference rows to receive their defaults.

**Producing the event (outbox, not `on_commit`).** `publish_lesson()` creates the `Lesson` and an `OutboxEvent(topic="lesson.published", payload={"lesson_id": ..., "course_id": ...})` inside one `transaction.atomic()` block.

An `on_commit(lambda: fan_out.delay(...))` would also work and be faster, but if the web process dies between COMMIT and the broker publish, the event is lost. A lost "new lesson" notification is a business bug. The outbox row survives the crash, and the relay publishes it within seconds. Combining both is common: a fast path through `on_commit`, with the relay as the safety net. That's safe because downstream is idempotent. The pattern itself is covered in depth in [Messaging · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox).

**Tasks.**

```python
# notifications/tasks.py
from itertools import batched

from celery import group, shared_task
from django.db import transaction
from django.db.models import F
from django.utils import timezone

from courses.models import Follow, Lesson
from .channels import ProviderError, push_in_app, send_email
from .models import Delivery, Notification, OutboxEvent, Preference

BATCH = 1000


@shared_task
def relay_outbox(limit: int = 500) -> int:
    with transaction.atomic():
        events = list(OutboxEvent.objects.select_for_update(skip_locked=True)
                      .filter(published_at__isnull=True).order_by("created_at")[:limit])
        for e in events:
            fan_out.delay(str(e.pk))            # at-least-once: duplicates absorbed downstream
        OutboxEvent.objects.filter(pk__in=[e.pk for e in events]).update(published_at=timezone.now())
    return len(events)


@shared_task(acks_late=True)
def fan_out(event_id: str) -> None:
    event = OutboxEvent.objects.get(pk=event_id)
    follower_ids = (Follow.objects.filter(course_id=event.payload["course_id"])
                    .order_by("user_id").values_list("user_id", flat=True))
    for chunk in batched(follower_ids.iterator(chunk_size=5000), BATCH):
        materialise.delay(event_id, list(chunk))


@shared_task(acks_late=True, rate_limit="200/s")
def materialise(event_id: str, user_ids: list[int]) -> None:
    event = OutboxEvent.objects.get(pk=event_id)
    lesson = Lesson.objects.select_related("course").get(pk=event.payload["lesson_id"])
    opted_out_email = set(Preference.objects.filter(
        user_id__in=user_ids, category="lessons", channel="email", enabled=False
    ).values_list("user_id", flat=True))

    Notification.objects.bulk_create(
        [Notification(event_id=event_id, recipient_id=uid, category="lessons",
                      title=f"New lesson in {lesson.course.title}: {lesson.title}",
                      url=lesson.get_absolute_url()) for uid in user_ids],
        ignore_conflicts=True,                  # replayed batch: existing rows are skipped
    )
    notifs = list(Notification.objects.filter(event_id=event_id, recipient_id__in=user_ids)
                  .values_list("pk", "recipient_id"))
    Delivery.objects.bulk_create(
        [Delivery(notification_id=nid, channel="email")
         for nid, uid in notifs if uid not in opted_out_email],
        ignore_conflicts=True,
    )
    push_in_app.delay(event_id, user_ids)       # websocket push to online users, best effort
    pending = Delivery.objects.filter(notification_id__in=[n for n, _ in notifs], channel="email",
                                      status=Delivery.Status.PENDING).values_list("pk", flat=True)
    group(deliver_email.s(pk) for pk in pending).apply_async(queue="bulk_email")


@shared_task(bind=True, acks_late=True, max_retries=8)
def deliver_email(self, delivery_id: int) -> None:
    claimed = (Delivery.objects
               .filter(pk=delivery_id, status=Delivery.Status.PENDING)
               .update(status=Delivery.Status.SENDING, attempts=F("attempts") + 1,
                       claimed_at=timezone.now()))
    if not claimed:
        return                                   # sent, failed, or another worker has it
    d = Delivery.objects.select_related("notification__recipient").get(pk=delivery_id)
    try:
        provider_id = send_email(to=d.notification.recipient.email, subject=d.notification.title,
                                 url=d.notification.url, idempotency_key=f"delivery-{d.pk}")
    except ProviderError as exc:
        final = self.request.retries >= self.max_retries
        Delivery.objects.filter(pk=d.pk).update(
            status=Delivery.Status.FAILED if final else Delivery.Status.PENDING)
        if final:
            return
        raise self.retry(exc=exc, countdown=min(600, 2 ** self.request.retries * 5))
    Delivery.objects.filter(pk=d.pk).update(status=Delivery.Status.SENT, provider_id=provider_id)
```

Notes the interviewer will probe:

- **Claiming without holding locks across I/O.** `deliver_email` claims the row with a compare-and-swap `UPDATE ... WHERE status='pending'` instead of keeping a `select_for_update` lock open during an SMTP or HTTP call. A worker that dies mid-send leaves the row in `SENDING`. A beat sweeper resets `SENDING` rows older than 10 minutes back to `PENDING` (served by the partial index), and the provider's idempotency key prevents a duplicate email when the task re-runs.
- **Chunking.** `iterator(chunk_size=...)` streams follower ids without loading 500k rows into memory, and `itertools.batched` (Python 3.12) cuts them into task-sized batches. Pass ids, never model instances, as task arguments.
- **Queue isolation.** `CELERY_TASK_ROUTES = {"notifications.tasks.deliver_email": {"queue": "bulk_email"}, "accounts.tasks.send_password_reset": {"queue": "tx"}}`, with separate worker pools. A 500k fan-out can then never delay a password reset. Use `worker_prefetch_multiplier=1` and `acks_late` for slow tasks so one worker doesn't hoard a large prefetch of messages.
- **In-app real time.** The `Notification` row *is* the in-app delivery. `push_in_app` does `async_to_sync(channel_layer.group_send)(f"user_{uid}", {"type": "notify", ...})` only for users present in a Redis "online" set, and offline users read their inbox on next load ([Ch 32 · Channels](topic.html?p=32-channels-websockets)).
- **Read API.** `GET /api/notifications/?cursor=...` uses `CursorPagination(ordering="-created_at")` served by the `(recipient, -created_at)` index. The unread badge count is `Notification.objects.filter(recipient=u, read_at__isnull=True).count()` on the partial index, cached for 30 s with explicit invalidation on mark-read.

**Scaling path.** The `Notification` table grows by about 30M rows per day. Partition it by month with raw SQL in migrations (or `django-postgres-extra`), and drop partitions past retention instead of running a giant `DELETE`. When Celery-on-Redis becomes the bottleneck for fan-out bursts, move the event stream to Kafka and keep Celery for per-delivery work ([Messaging · Kafka vs RabbitMQ](../messaging/topic.html?p=03-kafka-vs-rabbitmq)). Celebrity fan-out (a course with millions of followers) eventually switches from write-time fan-out to read-time merging. The inbox query then unions the personal notifications with "course announcements since your last visit", which is the classic push-vs-pull trade-off from [System Design · Notification System](../system-design/topic.html?p=39-design-notification).

## 6. Advantages, Disadvantages & Trade-offs

### Round 4: Rate-limited public API

**Requirements.** A public REST API for third-party developers. Organisations create API keys. The Free plan allows 60 requests per minute with bursts up to 20; Pro allows 1,200 per minute with bursts up to 200. The limit must be accurate across 40 Gunicorn pods. Responses carry rate-limit headers, and an exceeded limit returns `429` with `Retry-After`. Usage is metered per key per day for billing. Keys can be rotated and revoked, and revocation takes effect within a minute. Peak traffic is about 15k requests per second.

**Why DRF's built-in throttles aren't enough.** `UserRateThrottle` and `ScopedRateThrottle` keep a list of timestamps per key in the Django cache, using a read-modify-write that isn't atomic. Two pods reading the same history at the same time can both allow the request. If the cache is `locmem`, every process keeps its own counters, so 40 pods × 4 workers each grant the full quota. Those throttles are fine for abuse protection on an internal API. A limit that customers pay for needs one atomic counter in shared storage.

**Models.**

```python
# api_keys/models.py
import hashlib
import hmac
import secrets

from django.conf import settings
from django.db import models
from django.utils import timezone


def _digest(secret: str) -> str:
    return hmac.new(settings.API_KEY_PEPPER.encode(), secret.encode(), hashlib.sha256).hexdigest()


class ApiKey(models.Model):
    class Plan(models.TextChoices):
        FREE = "free"
        PRO = "pro"

    organization = models.ForeignKey("orgs.Organization", on_delete=models.CASCADE, related_name="api_keys")
    service_user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="+")
    prefix = models.CharField(max_length=12, unique=True)       # shown in dashboards and logs
    digest = models.CharField(max_length=64)                    # HMAC-SHA256 of the secret part
    plan = models.CharField(max_length=10, choices=Plan.choices, default=Plan.FREE)
    created_at = models.DateTimeField(auto_now_add=True)
    revoked_at = models.DateTimeField(null=True, blank=True)
    last_used_at = models.DateTimeField(null=True, blank=True)

    @classmethod
    def issue(cls, organization, service_user, plan="free") -> tuple["ApiKey", str]:
        prefix, secret = secrets.token_hex(6), secrets.token_urlsafe(32)
        key = cls.objects.create(organization=organization, service_user=service_user,
                                 prefix=prefix, digest=_digest(secret), plan=plan)
        return key, f"sk_{prefix}_{secret}"                      # shown once, never stored

    def verify(self, secret: str) -> bool:
        return self.revoked_at is None and hmac.compare_digest(self.digest, _digest(secret))


class UsageDaily(models.Model):
    api_key = models.ForeignKey(ApiKey, on_delete=models.CASCADE, related_name="usage")
    day = models.DateField()
    requests = models.PositiveBigIntegerField()

    class Meta:
        constraints = [models.UniqueConstraint(fields=["api_key", "day"], name="uniq_usage_day")]
```

A fast HMAC is the right choice here, not Argon2. API secrets are 256-bit random values, so slow hashing adds nothing against brute force, and at 15k requests per second you can't spend 100 ms per request hashing. The prefix allows an indexed lookup and lets users identify a leaked key without the secret ever being logged.

**Authentication.**

```python
# api_keys/auth.py
from django.core.cache import cache
from rest_framework import authentication, exceptions

from .models import ApiKey


class ApiKeyAuthentication(authentication.BaseAuthentication):
    keyword = "Bearer"

    def authenticate(self, request):
        header = authentication.get_authorization_header(request).decode()
        if not header.startswith(f"{self.keyword} sk_"):
            return None                                     # let other authenticators try
        try:
            _, prefix, secret = header.split(" ", 1)[1].split("_", 2)
        except ValueError:
            raise exceptions.AuthenticationFailed("Malformed API key.")
        key = cache.get(f"apikey:{prefix}")
        if key is None:
            key = ApiKey.objects.select_related("service_user").filter(prefix=prefix).first()
            if key is None:
                raise exceptions.AuthenticationFailed("Invalid API key.")
            cache.set(f"apikey:{prefix}", key, 60)          # revocation visible within 60 s
        if not key.verify(secret):
            raise exceptions.AuthenticationFailed("Invalid API key.")
        return key.service_user, key                        # request.user, request.auth

    def authenticate_header(self, request):
        return self.keyword                                 # makes DRF answer 401 (not 403)
```

Revocation deletes the cache entry immediately (`cache.delete(f"apikey:{prefix}")` in `revoke()`). The 60 s TTL is only the bound for a missed invalidation. `last_used_at` isn't written on every request, since that would mean 15k UPDATEs per second. It's derived from the usage counters instead.

**Token bucket in Redis (atomic Lua).**

```python
# api_keys/ratelimit.py
from dataclasses import dataclass

import redis
from django.conf import settings
from django.utils import timezone

r = redis.Redis.from_url(settings.RATELIMIT_REDIS_URL, socket_timeout=0.05)

TOKEN_BUCKET = r.register_script("""
local cap   = tonumber(ARGV[1])
local rate  = tonumber(ARGV[2])          -- tokens per second
local cost  = tonumber(ARGV[3])
local t     = redis.call('TIME')
local now   = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local b     = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(b[1]) or cap
local ts     = tonumber(b[2]) or now
tokens = math.min(cap, tokens + (now - ts) / 1000 * rate)
local allowed, retry_ms = 0, 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) / rate * 1000)
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(cap / rate * 1000) + 1000)
return {allowed, math.floor(tokens), retry_ms}
""")


@dataclass(frozen=True)
class Plan:
    burst: int
    per_second: float


PLANS = {"free": Plan(burst=20, per_second=1.0), "pro": Plan(burst=200, per_second=20.0)}


def take(prefix: str, plan: str, cost: int = 1) -> tuple[bool, int, float]:
    p = PLANS[plan]
    allowed, remaining, retry_ms = TOKEN_BUCKET(keys=[f"rl:{{{prefix}}}"], args=[p.burst, p.per_second, cost])
    return bool(allowed), int(remaining), retry_ms / 1000


def meter_usage(api_key_id: int) -> None:
    day_key = f"usage:{timezone.localdate().isoformat()}"
    pipe = r.pipeline(transaction=False)
    pipe.hincrby(day_key, api_key_id, 1)
    pipe.expire(day_key, 3 * 86400)
    try:
        pipe.execute()
    except redis.RedisError:
        pass                                  # metering is best effort; never fail the request
```

The script reads Redis's own clock (`TIME`) so that clock skew between pods can't distort the refill. It's a single round trip and runs atomically on the shard that owns the key. The `{prefix}` hash tag keeps any future per-key companion keys on the same Redis Cluster slot. Tokens are stored as strings so fractional refill survives, because Lua numbers returned to Redis are truncated to integers.

**DRF throttle and headers.**

```python
# api_keys/throttling.py
import logging

import redis
from rest_framework.throttling import BaseThrottle

from .ratelimit import take

log = logging.getLogger(__name__)


class PlanThrottle(BaseThrottle):
    def allow_request(self, request, view):
        key = request.auth
        if key is None:
            return True                       # anonymous traffic handled by AnonRateThrottle
        try:
            allowed, remaining, wait = take(key.prefix, key.plan)
        except redis.RedisError:
            log.warning("ratelimit backend down; failing open", extra={"prefix": key.prefix})
            return True                       # availability over strictness (a business decision)
        request.ratelimit = {"remaining": remaining}
        self._wait = wait
        return allowed

    def wait(self):
        return self._wait
```

```python
# api/views.py
from rest_framework.views import APIView

from api_keys.auth import ApiKeyAuthentication
from api_keys.ratelimit import meter_usage
from api_keys.throttling import PlanThrottle


class PublicAPIView(APIView):
    authentication_classes = [ApiKeyAuthentication]
    throttle_classes = [PlanThrottle]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        info = getattr(request, "ratelimit", None)
        if info is not None:
            response["RateLimit-Remaining"] = str(info["remaining"])
        if request.auth is not None and response.status_code != 429:
            meter_usage(request.auth.pk)      # one pipelined HINCRBY; rejected calls aren't billed
        return response
```

When `allow_request` returns `False`, DRF calls `throttled()`, which raises `Throttled(wait)`. The default exception handler turns that into a `429` with a `Retry-After` header. Usage metering does `HINCRBY usage:2026-10-25 <key_id> 1` with a 3-day TTL. A beat task every 5 minutes reads the hash with `HGETALL` and upserts *absolute* daily totals with `UsageDaily.objects.bulk_create(rows, update_conflicts=True, unique_fields=["api_key", "day"], update_fields=["requests"])`. Because Redis holds the running total for the day, the flush is idempotent. Replaying it writes the same numbers, which isn't true if you flush deltas. A final flush shortly after midnight closes yesterday's numbers for billing.

**Trade-offs of the decisions across rounds.**

| Decision | Option A | Option B | Choose A when | Choose B when |
|---|---|---|---|---|
| Stock decrement | `select_for_update` + check | conditional `update(F())` | multi-row business rules, need to read first | single counter, highest throughput |
| Dedupe a POST | `UNIQUE(user, idem_key)` | Redis `SET NX` with TTL | the result is a DB row (orders) | non-DB side effects, short windows |
| Trigger async work | `on_commit(task.delay)` | transactional outbox | losing a rare event is tolerable | every event must be delivered |
| Tenant isolation | scoped manager | + PostgreSQL RLS | small team, strong tests | compliance, raw SQL in the codebase |
| Rate limit algorithm | token bucket (Lua) | fixed-window `INCR` + `EXPIRE` | bursts allowed, smooth limits | simplicity; 2× boundary burst acceptable |
| Limiter outage | fail open | fail closed | paid API, availability first | security-sensitive (login, OTP) |
| Fan-out | on write (materialise rows) | on read (merge at query time) | bounded audiences | celebrity audiences in the millions |

### When to use these patterns

- Locks, idempotency keys and outboxes: whenever money, inventory or user-visible messages are involved.
- Scoped managers and RLS: from day one of any B2B product. Retrofitting tenancy costs far more than starting with it.
- Redis-backed limiters: whenever limits are part of a contract, or your pods number more than one.

### When NOT to use them

- A personal blog or an internal admin tool doesn't need an outbox, sharded counters or RLS. Plain `atomic()` and `on_commit` are enough.
- Don't reach for schema-per-tenant or database-per-tenant without a compliance or noisy-neighbour reason. It multiplies migration time and operational surface.
- Don't build a custom limiter if API-gateway rate limiting (Kong, Envoy, a cloud gateway) already enforces the contract. Keep a DRF throttle only as a second line.

## 7. Common Mistakes & Best Practices

### Round 5 (optional): URL shortener with click analytics

**Requirements.** 50M links. 100M redirects per day, about 1,200 per second on average with 10k per second at peak. Redirect p99 latency under 20 ms. Per-link click counts and daily charts. Custom aliases for paid users. Links can expire.

```python
# links/models.py
import secrets
import string

from django.conf import settings
from django.db import IntegrityError, models, transaction

ALPHABET = string.ascii_letters + string.digits          # base62


class Link(models.Model):
    code = models.CharField(max_length=16, unique=True)
    target_url = models.URLField(max_length=2048)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="links")
    created_at = models.DateTimeField(auto_now_add=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    clicks = models.PositiveBigIntegerField(default=0)

    @classmethod
    def shorten(cls, owner, url: str, alias: str | None = None) -> "Link":
        for _ in range(5):
            code = alias or "".join(secrets.choice(ALPHABET) for _ in range(7))
            try:
                with transaction.atomic():               # savepoint: a collision doesn't poison an outer txn
                    return cls.objects.create(owner=owner, target_url=url, code=code)
            except IntegrityError:
                if alias:
                    raise
        raise RuntimeError("Could not allocate a short code")
```

Seven random base62 characters give about 3.5 × 10¹² codes, so collisions at 50M links are rare and a retry handles them. Codes derived from a sequential id are guessable and enumerable, which leaks how many links exist and lets anyone crawl them.

The redirect view reads `cache.get(f"link:{code}")`, falls back to `Link.objects.filter(code=code).values("target_url", "expires_at").first()`, caches the result for an hour, and caches misses for 60 s (a negative cache, so scanners can't hammer the database). It raises `Http404` for missing or expired links, calls `record_click()` and returns `HttpResponseRedirect(target_url)`.

Use `302`, or `307` to preserve the method. A `301` is cached by browsers, so repeat clicks never reach you and analytics go blind. `record_click` does `INCR clicks:{code}` and `XADD clicks * code ... ts ... ref ...` on a Redis stream. A beat task drains the counters atomically with `GETDEL` and applies `Link.objects.filter(code=c).update(clicks=F("clicks") + n)`. A stream consumer batches events into a monthly-partitioned `ClickEvent` table or a column store for the charts. Validate `target_url` against a scheme allow-list (`http`/`https` only, no `javascript:`) and against a malware-domain list, or the shortener becomes a phishing tool. The redirect view runs with no session middleware and no database query on a cache hit, which is how it stays under 20 ms.

### Mistakes candidates make in Django design rounds

**1. Read-modify-write on counters.** People write `p.stock -= 1; p.save()`. Two requests read the same value and one decrement is lost. Use `update(stock=F("stock") - 1)` with a guard, or lock with `select_for_update()`.

**2. Enqueuing tasks inside the transaction.** People write `order.save(); send_receipt.delay(order.id)` inside `atomic()`. The worker can run before the commit and get `DoesNotExist`, or run for an order that was later rolled back. Use `transaction.on_commit(lambda: send_receipt.delay(order.id))`, or an outbox.

**3. Holding locks across network calls.** People call `select_for_update()` and then the payment provider inside the same transaction. The lock is held for the length of the HTTP call, typically 300 ms to 30 s, and every concurrent buyer queues behind it. Commit the reservation first and charge afterwards.

**4. Non-idempotent tasks with `acks_late`.** If a worker crashes after the side effect and before the ack, the task is redelivered and the side effect happens twice. Guard with a state compare-and-swap, a unique constraint or a provider idempotency key.

**5. Tenant filters sprinkled per view.** `Project.objects.filter(tenant=request.tenant)` in 140 places means the 141st will be forgotten. Make the default manager scoped and fail closed, and test for cross-tenant access.

**6. Using the default per-process cache for throttles or idempotency.** `locmem` isn't shared across Gunicorn workers. Use `RedisCache` (built in since Django 4.0) or a dedicated Redis client.

**7. Passing model instances to Celery.** The serialised instance is stale by the time the task runs, and pickling is unsafe. Pass primary keys and re-fetch inside the task.

**8. Designing without numbers.** "We'll add caching" doesn't answer anything. "Redirects are 10k per second, a cache hit costs about 1 ms, so a single Redis primary absorbs it with headroom" does.

## 8. Production: Pitfalls, Debugging & Scaling

**Lock pile-up during a flash sale.** *Symptom:* checkout p99 jumps from 80 ms to 9 s, and Gunicorn workers time out. *Root cause:* every request waits on the same product row lock, and some transactions also do slow work while holding it. *Fix:* move slow work out of the transaction, set `SET LOCAL lock_timeout = '2s'` so excess requests return 409 or 503 instead of hanging, and add the Redis inventory gate. *Debug:* query `pg_stat_activity` with `wait_event_type = 'Lock'` and `pg_locks`, and correlate with Sentry transaction traces.

**Deadlocks between checkouts.** *Symptom:* `deadlock detected` errors in the PostgreSQL log, with the matching exceptions in Sentry. *Root cause:* rows locked in different orders, for example iterating over the cart in the order the client sent it. *Fix:* always lock with `.order_by("pk")`, and retry a deadlocked transaction once.

**Celery backlog hides a fan-out.** *Symptom:* password-reset emails arrive 40 minutes late. *Root cause:* transactional and bulk tasks share one queue, and a 500k fan-out filled it. *Fix:* separate queues and worker pools, `rate_limit` on bulk tasks, and alerts on queue depth and on the age of the oldest message rather than on task failures alone.

**Tenant leak through the cache.** *Symptom:* a customer sees another workspace's dashboard numbers. *Root cause:* `cache_page` keyed only by URL, while tenants share paths like `/dashboard/`. *Fix:* include the host in the cache key, or use `vary_on_headers("Host")`, or build keys only through a tenant-aware helper. Add the cross-tenant test suite to CI.

**Rate limiter blocks everyone after a Redis failover.** *Symptom:* 429s across the board, or no limiting at all. *Root cause:* the client timeout is too long (every request waits on a dead Redis), or there's no explicit fail-open/fail-closed decision. *Fix:* a 50 ms socket timeout, a circuit breaker, a deliberate fail-open policy for the paid API, and fail-closed for authentication endpoints.

**Idempotency rows grow forever.** Orders keep their key forever, which is fine. For generic idempotency tables, store `created_at` and purge after 24–72 hours, matching the retry window you document for clients.

**Debugging kit for these designs.**

```python
from concurrent.futures import ThreadPoolExecutor
from unittest import mock

from django.contrib.auth.models import User
from django.db import connection
from django.test import TransactionTestCase

from shop.models import Product
from shop.services import OutOfStock, place_order


class OversellTest(TransactionTestCase):           # real commits: needed to test locking
    @mock.patch("shop.services.charge_order")      # on_commit really fires here; keep the broker out
    def test_ten_buyers_one_unit(self, _charge):
        product = Product.objects.create(sku="X", name="X", price=10, stock=1)
        users = [User.objects.create(username=f"u{i}") for i in range(10)]

        def buy(u):
            try:
                place_order(u, f"key-{u.pk}", [{"product_id": product.pk, "quantity": 1}])
                return True
            except OutOfStock:
                return False
            finally:
                connection.close()                  # each thread owns its own connection

        with ThreadPoolExecutor(max_workers=10) as pool:
            results = list(pool.map(buy, users))
        self.assertEqual(sum(results), 1)
        product.refresh_from_db()
        self.assertEqual(product.stock, 0)
```

Run concurrency tests with `TransactionTestCase`, because `TestCase` wraps everything in one transaction and can't show real lock behaviour. Run them against PostgreSQL, not SQLite. Use `captureOnCommitCallbacks(execute=True)` in `TestCase` to assert that tasks were enqueued only after a successful commit.

**Scaling ladder (say it in this order).** Query fixes and indexes first. Then caching with explicit invalidation. Then connection pooling. Then read replicas with a router and read-your-writes pinning. Then moving work to Celery with queue isolation. Then partitioning the big tables. Then splitting hot domains into separate services or databases (checkout, notifications). Each step has a measurable trigger, such as p99 latency, CPU, connection count or replication lag. Name the trigger, not just the step.

## 9. Interview Questions

**Q: Why isn't "check the stock, then decrement it" safe in Django, and what are the correct options?**
A: Two requests can both read `stock = 1` before either writes, and both sell. PostgreSQL's default READ COMMITTED isolation doesn't prevent this read-modify-write race. The options are an atomic conditional update, `filter(pk=..., stock__gte=q).update(stock=F("stock") - q)` with a check on the affected row count, or `select_for_update()` inside `atomic()` so the second request waits and re-reads. A `CHECK (stock >= 0)` constraint is the last line of defence. For multi-product carts, lock or update in primary-key order to avoid deadlocks.

**Q: How does an idempotency key prevent a double order when the client retries at the same moment?**
A: Store the key in the order row under `UniqueConstraint(user, idempotency_key)`. The first request's INSERT holds an uncommitted unique-index entry. The concurrent duplicate's INSERT blocks on it, then raises `IntegrityError` after the first commits. Catch that error outside the atomic block, load the original order and return it with 200. Store a hash of the payload too, so that a key reused with a different body gets a 422 instead of someone else's result. Checking for the key with a SELECT first is only an optimisation, never the guarantee.

**Q: Why use `transaction.on_commit` to enqueue Celery tasks?**
A: A task enqueued inside the transaction can be picked up before the commit. The worker then can't see the row (`DoesNotExist`) or sees stale data. If the transaction rolls back, the task runs for something that never happened. `on_commit` defers the callback until the outermost commit and discards it on rollback. Its remaining gap is a crash between commit and publish, which loses the task. When that's unacceptable, use a transactional outbox.

**Q: The payment provider charged the card, but the worker crashed before marking the order paid. What happens in your design? (Senior)**
A: With `acks_late=True` the message wasn't acknowledged, so the broker redelivers it, and the task calls the provider again with the same idempotency key, `order-<id>`. The provider returns the original charge instead of charging again. The task then compare-and-swaps the status from `AWAITING_PAYMENT` to `PAID`. If the expiry sweeper had already expired the order, the swap affects zero rows and the task issues a refund. I'd also reconcile from provider webhooks, which are verified and deduplicated by event id, and run a nightly job that compares provider charges with orders. External side effects become safe through provider idempotency plus state-machine guards, never through hoping tasks run once.

**Q: How would you handle a flash sale where 100k users try to buy 500 units of one product? (Senior)**
A: The database row becomes a lock hotspot, so you protect it. Use a Redis gate: an atomic Lua `DECRBY` that refuses to go below zero, initialised to 500, and admit only requests that win a token. Losers get an immediate "sold out" without touching PostgreSQL. Winners proceed to the normal locked checkout, which stays the source of truth. A reservation that fails or expires returns its token. Add a virtual waiting room or queue in front if the traffic is extreme, keep the transaction tiny, set `lock_timeout`, and pre-scale workers. An alternative to the Redis gate is splitting the stock across N shard rows to spread the lock contention.

**Q: How do you guarantee that one tenant can never read another tenant's data? (Senior)**
A: Defence in depth. Middleware resolves the tenant from the host and sets a contextvar. A DRF permission verifies membership, because DRF authentication is lazy and middleware doesn't see JWT users. A default manager scopes every query and fails closed when no tenant is set. PostgreSQL row-level security, driven by `SET LOCAL app.tenant_id`, acts as a backstop that also covers raw SQL. Unique constraints and indexes are tenant-prefixed, cache keys include the tenant, and Celery tasks take `tenant_id` and enter the context explicitly. Finally, an automated cross-tenant test suite hits every endpoint as tenant A against tenant B's data and expects 404s.

**Q: When would you choose schema-per-tenant or database-per-tenant over a shared schema?**
A: A shared schema with a `tenant_id` column scales to many thousands of small tenants with one migration path, so it's the default. Schema-per-tenant, for example with django-tenants and `search_path`, gives stronger isolation and easy per-tenant backups, but migrations run once per schema and the PostgreSQL catalog bloats past a few thousand schemas. Database-per-tenant is for a few large or regulated customers: a router maps the tenant to a DB alias, at the cost of N connection pools, backups and migration runs. A hybrid is common, with a shared schema for most tenants and dedicated databases for the enterprise tier.

**Q: How do you fan a notification out to 500,000 followers without hurting the rest of the system?**
A: Never do it in the request. The request writes an outbox event in its transaction. A relay enqueues a fan-out task that streams follower ids with `iterator()` and cuts them into batches of about 1,000, one task per batch. Each batch task bulk-creates notification rows with `ignore_conflicts` on a unique `(event, recipient)` constraint, and creates delivery rows for the channels the users haven't opted out of. Delivery runs on dedicated queues with rate limits, so transactional email is never stuck behind bulk work. For truly huge audiences, switch to fan-out on read, merging announcements into the inbox query.

**Q: How do you make email delivery effectively exactly-once?**
A: You can't get exactly-once delivery, but you can get an exactly-once effect. A `Delivery` row with `UNIQUE(notification, channel)` ensures one logical send per channel. The task claims the row with a conditional update from `PENDING` to `SENDING`, so concurrent duplicates exit early. The provider call carries `delivery-<id>` as its idempotency key, so a retry after a crash doesn't send twice. A sweeper resets rows stuck in `SENDING`. Status transitions are compare-and-swap updates, so retries can't move a `SENT` row backwards.

**Q: Why are DRF's built-in throttles insufficient for a paid public API, and what do you build instead?**
A: They store request histories in the Django cache with a non-atomic read-modify-write. With `locmem` each process counts separately, and even with Redis, concurrent requests can both pass. For contractual limits, implement a custom `BaseThrottle` that calls one atomic Redis Lua script: a token bucket keyed by API key, using Redis `TIME` so skew between pods doesn't matter. Return `wait()` so DRF sends `429` with `Retry-After`, and add remaining-quota headers in `finalize_response`. Decide explicitly whether to fail open or fail closed when Redis is down.

**Q: In a URL shortener, should redirects be 301 or 302, and how do you count clicks at 10k per second?**
A: Use 302 (or 307). A 301 is cached permanently by browsers, so repeat clicks skip your server and you lose analytics and the ability to change or expire the link. Serve the redirect from cache with no database write. Count with Redis `INCR` and append raw events to a stream. A periodic task drains the counters atomically with `GETDEL` and applies `update(clicks=F("clicks") + n)`, and a consumer batches the events into a partitioned table or a column store for charts.

**Q: How would you evolve the checkout from a monolith into services without losing consistency? (Senior)**
A: First split the code into modules with service functions (`place_order`, `cancel_order`) and an outbox, still within one database. When inventory and payments move to separate services, there's no shared transaction any more. Use a saga: the order is created as `PENDING`, an `InventoryReserved` event leads to a payment command, and failures trigger compensating actions such as releasing the stock or refunding. Each step is idempotent and keyed by order id. Events flow through the outbox and Kafka or RabbitMQ, with consumers deduplicating through an inbox table. The trade is eventual consistency and more moving parts in exchange for independent deploys and scaling, so I'd only do it when team or scale pressure justifies it.

**Q: How do you test that your concurrency design actually works?**
A: Use `TransactionTestCase` against PostgreSQL, because `TestCase`'s single wrapping transaction hides real lock behaviour. Spawn threads that each call the service and close their own DB connection, then assert the invariant: exactly N successful orders and stock at zero. Test idempotency by firing the same key from two threads and asserting one order. Use `captureOnCommitCallbacks` to assert that tasks are enqueued only on commit. In staging, run load tests with production-like contention and watch `pg_locks` and deadlock counts.

## 10. Quick Revision & Cheat Sheet

| Round | Invariant | Key Django mechanism | Async piece | First scaling move |
|---|---|---|---|---|
| Checkout | stock ≥ 0, one charge per order | `select_for_update` in pk order, `UNIQUE(user, idem_key)`, `on_commit` | `charge_order` (provider key + status CAS), expiry sweeper | short transactions, Redis inventory gate |
| Multi-tenant | no cross-tenant reads or writes | contextvar + scoped manager (fail closed), membership permission, RLS | tasks take `tenant_id`, enter context | per-tenant throttles, replicas, route big tenants to own DB |
| Notifications | each notification once per channel | outbox in the domain transaction, unique `(event, recipient)` and `(notification, channel)` | relay → fan-out batches → per-channel deliver | queue isolation, partitioning, fan-out on read |
| Public API | quota honoured across all pods | custom authentication (prefix + HMAC), `BaseThrottle` + Redis Lua | usage flush (absolute totals upsert) | Redis Cluster, gateway limits |
| Shortener | codes unique and unguessable | random base62 + retry on `IntegrityError` in savepoint | click counter drain (`GETDEL` + `F()`) | cache-only redirect path, CDN |

- State the invariants first, then point at the line that enforces each one.
- The database enforces uniqueness and ranges. Application checks are optimisations.
- Locks: short, in a consistent order, never across network I/O.
- Every task must be idempotent. Use `acks_late` for at-least-once delivery, and pass ids, not instances.
- Use `on_commit` for convenience and an outbox when delivery must be guaranteed.
- Scope tenants in one place, fail closed, and test for leaks automatically.
- Throttles that customers pay for need Redis plus Lua, not `locmem`, and an explicit failure policy.
- Quote numbers: requests per second, rows per day, lock duration, queue depth.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2" djangorestframework "psycopg[binary]" "celery[redis]" redis`, then run PostgreSQL and Redis locally (Docker is easiest).

1. **Prove the oversell.** Implement a naive `place_order` that does `p.stock -= q; p.save()`, run the 10-thread test from §8, and watch it oversell. Switch to the §3 version and make the test pass. Then reverse the lock order for two-product carts and reproduce a deadlock.
2. **Idempotency under fire.** Send the same `Idempotency-Key` from 20 threads, assert exactly one order exists, and confirm that a different payload with the same key gets a 422.
3. **Break and fix tenancy.** Build `TenantScoped` and `Project`, write the cross-tenant test that hits list, detail, update and delete, then deliberately add an unscoped `objects = models.Manager()` and watch the test catch it. Finish by adding the RLS migration and showing that a raw `cursor.execute("SELECT * FROM projects_project")` is still filtered.
4. **Fan-out with replay.** Implement `relay_outbox`, `fan_out` and `materialise`, run `fan_out` twice for the same event, and assert the notification and delivery counts don't change.
5. **Limiter accuracy.** Run the token-bucket throttle behind 4 Gunicorn workers, fire 500 requests concurrently with a key on the Free plan, and count the 200s. Compare with `UserRateThrottle` on `locmem`.
6. **Shortener hot path.** Build `redirect_view` with the negative cache, load-test it with `wrk` or `locust`, confirm zero DB queries on cache hits using `CaptureQueriesContext`, and implement the `GETDEL` drain task.

**Mini project, "Shop in a weekend":** combine Rounds 1 and 4 into one repository. Build a DRF checkout API protected by API keys with plan limits, Celery payment and expiry tasks against a fake provider that randomly times out, an outbox-driven receipt email, Sentry for errors, and a CI job that runs the concurrency tests against PostgreSQL.

## 12. Related Topics & Free Learning Resources

**Sibling chapters**
- [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency): `atomic`, savepoints, `select_for_update`, `on_commit`.
- [Ch 15 · Custom Managers, QuerySets & Model Inheritance](topic.html?p=15-managers-model-inheritance): the scoped-manager pattern.
- [Ch 16 · Indexes, Constraints, Raw SQL & PostgreSQL Features](topic.html?p=16-database-features-postgres): partial indexes, unique and check constraints, `RunSQL`.
- [Ch 18 · Middleware](topic.html?p=18-middleware): tenant middleware ordering.
- [Ch 21 · DRF Serializers](topic.html?p=21-drf-serializers) and [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers): the API layer.
- [Ch 23 · DRF Authentication, Permissions & Throttling](topic.html?p=23-drf-auth-permissions-throttling): custom authentication and throttles.
- [Ch 26 · Permissions, Groups & Authorization](topic.html?p=26-permissions-authorization): object-level and role checks.
- [Ch 29 · Caching in Django](topic.html?p=29-caching), [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks), [Ch 32 · Django Channels & Real-Time](topic.html?p=32-channels-websockets).
- [Ch 33 · Testing Django Applications](topic.html?p=33-testing), [Ch 34 · Scaling Databases](topic.html?p=34-scaling-databases), [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production).
- [Ch 38 · Most-Asked Django Interview Questions: DRF, Security & Scale](topic.html?p=38-interview-drf-advanced) and [Ch 39 · ORM Coding Round](topic.html?p=39-orm-coding-challenges): the rest of the interview loop.

**Other handbooks**
- [Messaging · Idempotency, Deduplication & the Outbox Pattern](../messaging/topic.html?p=21-idempotency-outbox): the outbox and inbox in depth.
- [Redis Caching · Sorted Sets & Rate Limiting](../redis-caching/topic.html?p=19-sorted-sets-rate-limiting) and [Redis Caching · Pipelining, Lua & Transactions](../redis-caching/topic.html?p=22-pipelining-lua-transactions): limiter internals.
- [REST API · Idempotency Keys & Retries](../rest-api/topic.html?p=27-idempotency-keys-retries) and [REST API · Rate Limiting & Throttling](../rest-api/topic.html?p=24-rate-limiting-throttling): the HTTP contract.
- [Database Design · Multi-Tenant SaaS case study](../database-design/topic.html?p=40-case-multi-tenant-saas) and [Database Design · E-commerce case study](../database-design/topic.html?p=31-case-ecommerce): the data-layer view.
- [System Design · URL Shortener](../system-design/topic.html?p=32-design-url-shortener), [System Design · Notification System](../system-design/topic.html?p=39-design-notification), [System Design · Rate Limiter](../system-design/topic.html?p=35-design-rate-limiter).

**Free resources**
- **Database transactions**, Django docs (*Intermediate*): `atomic`, savepoints and `on_commit` semantics, from the source. https://docs.djangoproject.com/en/5.2/topics/db/transactions/
- **QuerySet API: select_for_update**, Django docs (*Intermediate*): `nowait`, `skip_locked`, `of`, and backend caveats. https://docs.djangoproject.com/en/5.2/ref/models/querysets/
- **Throttling**, Django REST framework (*Intermediate*): the `BaseThrottle` contract and the documented caveats of the built-in throttles. https://www.django-rest-framework.org/api-guide/throttling/
- **Celery: Tasks**, Celery docs (*Intermediate*): `acks_late`, retries, and why tasks must be idempotent. https://docs.celeryq.dev/en/stable/userguide/tasks.html
- **PostgreSQL: Row Security Policies**, PostgreSQL docs (*Advanced*): RLS, `FORCE ROW LEVEL SECURITY` and `BYPASSRLS`. https://www.postgresql.org/docs/current/ddl-rowsecurity.html
- **django-tenants**, GitHub (*Advanced*): schema-per-tenant on PostgreSQL, useful for comparing against the shared-schema design. https://github.com/django-tenants/django-tenants
- **Stripe API: Idempotent requests**, Stripe docs (*Intermediate*): how a real payment provider implements idempotency keys. https://docs.stripe.com/api/idempotent_requests

---

*Django Handbook — chapter 40.*
