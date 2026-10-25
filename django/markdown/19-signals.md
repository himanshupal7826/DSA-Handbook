# 19 · Signals

> **In one line:** Signals are an in-process, synchronous observer pattern: `Signal.send()` loops over connected receivers in the same thread and the same database transaction as the caller, so they are perfect for decoupling *your* code from *other apps'* events — and an anti-pattern when used to hide core business logic inside `post_save`.

---

## 1. Overview

> **Builds on:** [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings), [Ch 08 · Models & Fields](topic.html?p=08-models-fields), [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency).

When a user signs up you want to create a profile, send a welcome email, and record an analytics event. The naive approach puts all of that in the view. Then the admin creates users without a profile, the management command for imports forgets the analytics, and the `User` model — which belongs to `django.contrib.auth`, code you don't own — can't be edited to call your code.

**Signals** solve the "code I don't own" part: a sender (Django, or a third-party app) announces "a `User` was saved" and any number of **receivers** react, without the sender knowing they exist. That's genuine decoupling and the reason signals exist: `django.contrib.auth` sends `user_logged_in`, the ORM sends `post_save`, the test runner sends `setting_changed`, and your app can listen.

The problem is that signals are frequently used for *your own* models, where the coupling they "remove" was never a problem. The result is **action at a distance**: saving an `Order` mysteriously sends emails, charges cards and updates inventory, nobody can tell from reading `order.save()`, bulk operations silently skip all of it, and the work runs inside the request's transaction. Experienced Django engineers treat signals as a tool of last resort for cross-app hooks — and interviewers love asking "when are signals an anti-pattern?"

This chapter is the home for the signals framework. Background processing lives in [Ch 31 · Celery](topic.html?p=31-celery-background-tasks); `transaction.on_commit` details in [Ch 14](topic.html?p=14-transactions-concurrency).

## 2. Core Concepts

- **`Signal`** — `django.dispatch.Signal()`, an object holding a list of receivers. *Why it matters:* every signal, built-in or custom, is an instance of this class.
- **Receiver** — any callable accepting `sender` and `**kwargs`. *Why it matters:* `**kwargs` is mandatory; Django may add arguments in future versions.
- **Sender** — usually the class that sent the signal (e.g. the model class for `post_save`). *Why it matters:* filtering by sender (`sender=Order`) avoids running for every model.
- **`connect(receiver, sender=None, weak=True, dispatch_uid=None)`** / **`@receiver(signal, sender=...)`** — registration. *Why it matters:* `weak=True` by default — a locally defined function can be garbage-collected and silently stop receiving.
- **`dispatch_uid`** — unique string identifying a registration. *Why it matters:* prevents duplicate connections if the registering module is imported twice.
- **`send(sender, **kwargs)`** — calls receivers in order; an exception **propagates** and stops remaining receivers. *Why it matters:* a failing receiver breaks the `save()` that triggered it.
- **`send_robust()`** — catches exceptions per receiver and returns `[(receiver, response_or_exception), ...]`. *Why it matters:* use for optional notifications.
- **`asend()` / `asend_robust()`** — async variants (Django 5.0+); sync and async receivers can both be connected and Django adapts. *Why it matters:* async views can dispatch signals without blocking.
- **Model signals** — `pre_init`, `post_init`, `pre_save`, `post_save`, `pre_delete`, `post_delete`, `m2m_changed`, `class_prepared`; migration signals `pre_migrate`, `post_migrate`. *Why it matters:* the most used — and most abused — hooks.
- **Request signals** — `request_started`, `request_finished`, `got_request_exception`. *Why it matters:* lifecycle hooks used by Django itself (closing DB connections, resetting queries).
- **Auth signals** — `user_logged_in`, `user_logged_out`, `user_login_failed`. *Why it matters:* audit logging and lockout without touching auth views.
- **`AppConfig.ready()`** — where to import the signals module. *Why it matters:* receivers must be registered after the app registry is ready and exactly once.

## 3. Theory & Principles

### 3.1 What `send()` actually does

`Signal` keeps `self.receivers`, a list of `((receiver_id, sender_id), receiver_ref, is_async)` entries, protected by a lock. `send()`:

1. Returns immediately if there are no receivers (cheap fast-path), or if a sender cache says none are connected for this sender (`use_caching=True` for model signals).
2. Computes the live receivers for the sender via `_live_receivers(sender)`, dereferencing weak refs and dropping dead ones.
3. Calls each receiver **synchronously, in order of connection**: `response = receiver(signal=self, sender=sender, **named)`. Async receivers are run via `async_to_sync` when sent with `send()`; with `asend()`, sync receivers are run via `sync_to_async`.
4. Returns `[(receiver, response), ...]`.

No queue, no thread, no broker: a signal is a **function call loop**. So:

- Receivers run in the **same thread** and, for model signals, inside the **same transaction** as the `save()`. If the outer transaction rolls back, any DB writes by receivers roll back too — but an email they already sent does not un-send.
- An exception in a receiver (with `send()`) propagates into `save()`; the row may already be written (for `post_save`) while the caller sees an error.
- Latency of all receivers adds to the request.

### 3.2 Where model signals fire inside `save()` and `delete()`

```svg
<svg viewBox="0 0 860 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj19a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Model.save(): signals run inline, inside the caller's transaction</text>
  <rect x="20" y="40" width="820" height="200" rx="12" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="430" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">transaction.atomic() (ATOMIC_REQUESTS or your block)</text>
  <rect x="40" y="80" width="140" height="44" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="110" y="100" text-anchor="middle" fill="#1e293b">obj.save()</text><text x="110" y="115" text-anchor="middle" fill="#334155" font-size="9">save_base()</text>
  <rect x="210" y="80" width="140" height="44" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="280" y="100" text-anchor="middle" fill="#1e293b">pre_save.send()</text><text x="280" y="115" text-anchor="middle" fill="#334155" font-size="9">receivers run now</text>
  <rect x="380" y="80" width="140" height="44" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="450" y="100" text-anchor="middle" fill="#1e293b">INSERT / UPDATE</text><text x="450" y="115" text-anchor="middle" fill="#334155" font-size="9">_save_table()</text>
  <rect x="550" y="80" width="140" height="44" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="620" y="100" text-anchor="middle" fill="#1e293b">post_save.send()</text><text x="620" y="115" text-anchor="middle" fill="#334155" font-size="9">created=True/False</text>
  <rect x="720" y="80" width="100" height="44" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="770" y="106" text-anchor="middle" fill="#1e293b">return</text>
  <path d="M182,102 L208,102" stroke="#2563eb" stroke-width="2" marker-end="url(#dj19a)"/>
  <path d="M352,102 L378,102" stroke="#2563eb" stroke-width="2" marker-end="url(#dj19a)"/>
  <path d="M522,102 L548,102" stroke="#2563eb" stroke-width="2" marker-end="url(#dj19a)"/>
  <path d="M692,102 L718,102" stroke="#2563eb" stroke-width="2" marker-end="url(#dj19a)"/>
  <rect x="470" y="150" width="300" height="70" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="620" y="170" text-anchor="middle" fill="#1e293b" font-weight="bold">receiver sends email / calls API</text>
  <text x="620" y="188" text-anchor="middle" fill="#334155">transaction later rolls back</text>
  <text x="620" y="205" text-anchor="middle" fill="#334155">side effect cannot be undone</text>
  <path d="M620,126 L620,148" stroke="#dc2626" stroke-width="2" marker-end="url(#dj19a)"/>
  <rect x="40" y="150" width="380" height="70" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="230" y="170" text-anchor="middle" fill="#1e293b" font-weight="bold">fix: receiver registers on_commit(...)</text>
  <text x="230" y="188" text-anchor="middle" fill="#334155">callback runs only after the outermost COMMIT</text>
  <text x="230" y="205" text-anchor="middle" fill="#334155">dropped on rollback</text>
  <text x="430" y="270" text-anchor="middle" fill="#334155">NOT fired by: QuerySet.update(), bulk_create(), bulk_update(), raw SQL, loaddata sends with raw=True</text>
  <text x="430" y="290" text-anchor="middle" fill="#334155">QuerySet.delete() DOES send pre/post_delete per collected object (fast-delete only when no receivers)</text>
</svg>
```

In `Model.save_base()`, `pre_save` is sent (unless `raw`/`origin` conditions say otherwise), then the parents and the table row are saved, then `post_save` is sent with `created`, `update_fields`, `raw` and `using`. For deletes, the `Collector` gathers all objects to delete (including cascades), sends `pre_delete` per object, executes the DELETEs, then sends `post_delete` per object; since 4.1 the `origin` argument tells receivers which model/queryset initiated the delete.

> **Gotcha:** The `Collector` can use a **fast delete** — a single `DELETE ... WHERE` with no fetching — only when nothing needs per-object handling: no signal receivers, no cascades requiring Python. Connecting even one `pre_delete`/`post_delete` receiver to a model forces Django to load every row into memory before deleting. Signals have a performance cost even when the receiver does nothing.

### 3.3 `m2m_changed`

`m2m_changed` is sent by `add()`, `remove()`, `clear()` and `set()` on a many-to-many manager, with `action` in `pre_add`, `post_add`, `pre_remove`, `post_remove`, `pre_clear`, `post_clear`. The sender is the **through model** (`Pizza.toppings.through`), `instance` is the object whose manager was used, `reverse` tells you which side, `model` is the class of objects added/removed and `pk_set` their primary keys (`None` for clear). Saving a model never fires `m2m_changed` — M2M data is written separately, which is why "post_save doesn't see my M2M changes from the admin form" is a classic bug (the admin saves M2M after `save()` via `save_m2m()`; use `m2m_changed` or `ModelAdmin.save_related`).

## 4. Architecture & Workflow

### 4.1 Registration lifecycle

```svg
<svg viewBox="0 0 860 280" width="100%" height="280" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj19b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#7c3aed"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Startup registers receivers once; every send loops over them</text>
  <rect x="20" y="45" width="180" height="50" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="110" y="66" text-anchor="middle" fill="#1e293b">django.setup()</text><text x="110" y="83" text-anchor="middle" fill="#334155" font-size="9">apps.populate(INSTALLED_APPS)</text>
  <rect x="230" y="45" width="180" height="50" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="320" y="66" text-anchor="middle" fill="#1e293b">import models</text><text x="320" y="83" text-anchor="middle" fill="#334155" font-size="9">all apps' models loaded</text>
  <rect x="440" y="45" width="180" height="50" rx="6" fill="#ede9fe" stroke="#7c3aed"/><text x="530" y="66" text-anchor="middle" fill="#1e293b">AppConfig.ready()</text><text x="530" y="83" text-anchor="middle" fill="#334155" font-size="9">from . import signals</text>
  <rect x="650" y="45" width="190" height="50" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="745" y="66" text-anchor="middle" fill="#1e293b">@receiver -&gt; connect()</text><text x="745" y="83" text-anchor="middle" fill="#334155" font-size="9">dispatch_uid dedupes</text>
  <path d="M202,70 L228,70" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj19b)"/>
  <path d="M412,70 L438,70" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj19b)"/>
  <path d="M622,70 L648,70" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj19b)"/>
  <rect x="20" y="140" width="820" height="110" rx="10" fill="#dbeafe" stroke="#2563eb"/>
  <text x="430" y="160" text-anchor="middle" fill="#1e293b" font-weight="bold">Per request: post_save.send(sender=Order, instance=o, created=True)</text>
  <rect x="50" y="175" width="230" height="56" rx="6" fill="#fff" stroke="#94a3b8"/><text x="165" y="198" text-anchor="middle" fill="#1e293b">receiver 1 (sender=Order)</text><text x="165" y="215" text-anchor="middle" fill="#334155" font-size="9">runs, same thread</text>
  <rect x="315" y="175" width="230" height="56" rx="6" fill="#fff" stroke="#94a3b8"/><text x="430" y="198" text-anchor="middle" fill="#1e293b">receiver 2 (sender=None)</text><text x="430" y="215" text-anchor="middle" fill="#334155" font-size="9">runs for EVERY model</text>
  <rect x="580" y="175" width="230" height="56" rx="6" fill="#fee2e2" stroke="#dc2626"/><text x="695" y="198" text-anchor="middle" fill="#1e293b">receiver 3 raises</text><text x="695" y="215" text-anchor="middle" fill="#334155" font-size="9">send() aborts, save() errors</text>
  <path d="M282,203 L313,203" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj19b)"/>
  <path d="M547,203 L578,203" stroke="#7c3aed" stroke-width="2" marker-end="url(#dj19b)"/>
</svg>
```

### 4.2 Decision flow: signal or explicit call?

```text
Is the sender code you don't own (contrib.auth, a third-party app)?
   yes -> signal receiver is reasonable (keep it thin; defer work with on_commit/Celery)
   no  -> Is the reaction part of the core use case (charge, reserve stock)?
             yes -> explicit service function call; no signal
             no  -> Do several unrelated apps need to react, and must the sender not import them?
                       yes -> custom signal sent explicitly from the service layer
                       no  -> just call the function
```

## 5. Implementation

### 5.1 Simple example — profile on user creation

```python
# accounts/signals.py
from django.conf import settings
from django.db.models.signals import post_save
from django.dispatch import receiver
from .models import Profile


@receiver(post_save, sender=settings.AUTH_USER_MODEL, dispatch_uid="accounts.create_profile")
def create_profile(sender, instance, created, raw=False, **kwargs):
    if raw:                       # loaddata: don't touch other tables
        return
    if created:
        Profile.objects.get_or_create(user=instance)
```

```python
# accounts/apps.py
from django.apps import AppConfig


class AccountsConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "accounts"

    def ready(self):
        from . import signals  # noqa: F401  — registers receivers
```

`sender` accepts a lazy `"app_label.ModelName"` string for model signals, which is why `settings.AUTH_USER_MODEL` works. Behaviour summary:

```python
User.objects.create_user("ana")                    # post_save fires -> Profile created
User.objects.bulk_create([User(username="bo")])    # no signal -> no Profile!
User.objects.filter(pk=1).update(is_active=False)  # no signal
```

### 5.2 Built-in non-model signals

```python
# audit/signals.py
import logging
from django.contrib.auth.signals import user_logged_in, user_login_failed
from django.core.signals import got_request_exception
from django.dispatch import receiver

log = logging.getLogger("audit")


@receiver(user_logged_in, dispatch_uid="audit.login")
def on_login(sender, request, user, **kwargs):
    log.info("login user=%s ip=%s", user.pk, request.META.get("REMOTE_ADDR"))


@receiver(user_login_failed, dispatch_uid="audit.login_failed")
def on_login_failed(sender, credentials, request=None, **kwargs):
    # credentials has sensitive values scrubbed by Django
    log.warning("login failed username=%s", credentials.get("username"))


@receiver(got_request_exception, dispatch_uid="audit.exception")
def on_exception(sender, request=None, **kwargs):
    log.error("unhandled exception path=%s", getattr(request, "path", "?"))
```

### 5.3 Real-world example — a custom domain signal sent explicitly, with deferred side effects

A shop where the `orders` app must not import `loyalty`, `notifications` or `analytics`, yet all three react when an order is paid. The *core* work (marking paid, reserving stock) is an explicit service; the *peripheral* reactions hang off a custom signal sent from the service — not from `post_save`.

```python
# orders/signals.py
from django.dispatch import Signal

# Documented contract: sent after an order is paid; kwargs: order, payment
order_paid = Signal()
```

```python
# orders/services.py
from django.db import transaction
from django.db.models import F
from .models import Order, Stock
from .signals import order_paid


class OutOfStock(Exception):
    pass


def mark_order_paid(order_id: int, payment) -> Order:
    with transaction.atomic():
        order = Order.objects.select_for_update().get(pk=order_id)
        if order.status == Order.Status.PAID:
            return order                                   # idempotent
        for item in order.items.all():
            updated = (Stock.objects
                       .filter(product_id=item.product_id, quantity__gte=item.quantity)
                       .update(quantity=F("quantity") - item.quantity))
            if not updated:
                raise OutOfStock(item.product_id)
        order.status = Order.Status.PAID
        order.save(update_fields=["status"])
        # Explicit, visible dispatch; receivers only enqueue work after commit
        transaction.on_commit(
            lambda: order_paid.send_robust(sender=Order, order=order, payment=payment)
        )
    return order
```

```python
# loyalty/receivers.py
from django.dispatch import receiver
from orders.models import Order
from orders.signals import order_paid
from .tasks import award_points


@receiver(order_paid, sender=Order, dispatch_uid="loyalty.award_points")
def award_points_on_paid(sender, order, **kwargs):
    award_points.delay(order.pk)          # pass IDs to Celery, not instances
```

```python
# notifications/receivers.py
from django.dispatch import receiver
from orders.models import Order
from orders.signals import order_paid
from .tasks import send_receipt_email


@receiver(order_paid, sender=Order, dispatch_uid="notifications.receipt")
def receipt_on_paid(sender, order, **kwargs):
    send_receipt_email.delay(order.pk)
```

```python
# loyalty/apps.py
from django.apps import AppConfig

class LoyaltyConfig(AppConfig):
    name = "loyalty"
    def ready(self):
        from . import receivers  # noqa: F401
```

Why this design is defensible in an interview: the core flow is readable top-to-bottom in `mark_order_paid`; the signal is sent **explicitly** (grep for `order_paid.send` finds every trigger); dispatch happens **after commit** so a rollback never emails a receipt; `send_robust` keeps a failing receiver from breaking the others; and receivers only enqueue idempotent Celery tasks. For guaranteed delivery across crashes between commit and enqueue, replace the signal with a transactional outbox ([Messaging · Outbox](../messaging/topic.html?p=21-idempotency-outbox)).

### 5.4 `m2m_changed` and `pre_save` change detection

```python
from django.db.models.signals import m2m_changed, pre_save
from django.dispatch import receiver
from .models import Article


@receiver(m2m_changed, sender=Article.tags.through, dispatch_uid="blog.tags_changed")
def tags_changed(sender, instance, action, reverse, model, pk_set, **kwargs):
    if action in {"post_add", "post_remove", "post_clear"} and not reverse:
        from django.db import transaction
        transaction.on_commit(lambda: reindex_article.delay(instance.pk))


@receiver(pre_save, sender=Article, dispatch_uid="blog.detect_publish")
def detect_publish(sender, instance, update_fields=None, **kwargs):
    if instance.pk is None:
        instance._became_published = instance.published
        return
    old = sender.objects.filter(pk=instance.pk).values_list("published", flat=True).first()
    instance._became_published = (not old) and instance.published   # extra query per save!
```

That `pre_save` pattern costs a query on every save — prefer tracking the original value in `from_db()`/`__init__` or performing the transition in an explicit method (`article.publish()`).

### 5.5 Testing and muting signals

```python
from unittest import mock
from django.db.models.signals import post_save
from django.test import TestCase
from accounts.signals import create_profile


class SignalTests(TestCase):
    def test_profile_created(self):
        user = User.objects.create_user("ana")
        self.assertTrue(hasattr(user, "profile"))

    def test_without_signal(self):
        post_save.disconnect(create_profile, sender=User, dispatch_uid="accounts.create_profile")
        try:
            user = User.objects.create_user("bo")
            self.assertFalse(Profile.objects.filter(user=user).exists())
        finally:
            post_save.connect(create_profile, sender=User, dispatch_uid="accounts.create_profile")

    def test_order_paid_dispatch(self):
        handler = mock.Mock()
        order_paid.connect(handler, sender=Order, weak=False)
        with self.captureOnCommitCallbacks(execute=True):
            mark_order_paid(self.order.pk, payment=None)
        handler.assert_called_once()
        order_paid.disconnect(handler, sender=Order)
```

Note `weak=False` for the mock and `captureOnCommitCallbacks(execute=True)`, since `TestCase` wraps tests in a transaction that never commits.

## 6. Advantages, Disadvantages & Trade-offs

| Approach | Coupling | Visibility | Transaction safety | Covers bulk ops | Best for |
|---|---|---|---|---|---|
| `post_save` receiver | Lowest (sender unaware) | Poor — hidden | Runs inside txn | No | Reacting to models you don't own |
| Override `save()` | Model knows it | Medium | Runs inside txn | No | Invariants tied to the model itself |
| Explicit service function | Caller imports it | Best | You decide (`on_commit`) | You decide | Core business flows |
| Custom signal sent explicitly | Sender unaware of receivers | Medium (grep `send`) | Pair with `on_commit` | n/a | Fan-out to optional apps |
| Celery task via `on_commit` | Low | Good | After commit | n/a | Slow/external side effects |
| Outbox + relay | Lowest, cross-service | Good | Atomic with data | n/a | Reliable integration events |
| DB trigger | None in app | Poor in app | Atomic | Yes | Audit/denormalization at DB level |

### When to use

- Hooking into **third-party or contrib** models/events: create a profile when `auth.User` is created, audit `user_logged_in`.
- Letting optional apps plug into a reusable app's lifecycle (a custom signal is the app's public extension point).
- Framework-level concerns: cache invalidation on save, `post_migrate` to create default data/permissions, `setting_changed` in tests.

### When NOT to use

- Core business logic of your own domain (payments, stock, state transitions) — call it explicitly.
- Anything that must happen for bulk operations or raw SQL — signals don't fire.
- Slow work (HTTP, email) inline — it adds latency and runs before commit.
- As "async": signals are synchronous; for background work use Celery.
- Chains of signals triggering saves that trigger signals — debugging nightmare and recursion risk.

## 7. Common Mistakes & Best Practices

**1. Registering receivers in `models.py` or forgetting to import them.** Either they're never connected (module never imported) or circular import errors appear. *Instead:* a `signals.py`/`receivers.py` imported in `AppConfig.ready()`, and the app config referenced in `INSTALLED_APPS`.

**2. Duplicate registration.** A module imported twice (different import paths, or `ready()` called twice in some test setups) connects the receiver twice → two welcome emails. *Instead:* `dispatch_uid` on every `@receiver`.

**3. Side effects before commit.**

```python
# Before: email sent even if the transaction later rolls back; worker may not find the row
@receiver(post_save, sender=Order)
def notify(sender, instance, created, **kwargs):
    if created:
        send_confirmation.delay(instance.pk)

# After
@receiver(post_save, sender=Order, dispatch_uid="orders.notify")
def notify(sender, instance, created, **kwargs):
    if created:
        transaction.on_commit(lambda: send_confirmation.delay(instance.pk))
```

**4. Calling `instance.save()` inside `post_save` for the same model.** Infinite recursion or double writes. *Instead:* `Model.objects.filter(pk=instance.pk).update(...)` (doesn't send signals) or compute the value in `pre_save`.

**5. Missing `**kwargs` in the receiver.** Breaks when Django passes extra arguments (`update_fields`, `origin`). Always accept `**kwargs`.

**6. Weak references to local functions.** Connecting a closure inside a function: it is garbage-collected and stops firing. *Instead:* module-level functions or `weak=False`.

**7. No `sender`.** `@receiver(post_save)` runs for **every** model save in the project, including sessions and logs. Always pass `sender`.

**8. Ignoring `raw=True`.** Fixtures loaded with `loaddata` send `post_save(raw=True)`; receivers querying related tables fail because fixture data isn't all there yet. Return early when `raw`.

**9. Assuming `update_fields` is set.** It's `None` for a normal `save()`. Check `update_fields is None or "status" in update_fields`.

**Best practices:** keep receivers to a few lines that enqueue or delegate; document custom signals' kwargs; prefer explicit service calls for your own domain; use `send_robust` for optional listeners; log receiver errors.

## 8. Production: Pitfalls, Debugging & Scaling

**Pitfall: "Celery task can't find the object".** In production, `post_save` enqueues a task with the ID; the worker picks it up in milliseconds, before the request's `ATOMIC_REQUESTS` transaction commits, and gets `DoesNotExist`. Intermittent, load-dependent. Fix: `transaction.on_commit`.

**Pitfall: a data migration or import silently skips business logic.** A `bulk_create` of 50k users creates no profiles; months later, `user.profile` raises `RelatedObjectDoesNotExist` in random places. Fix: don't rely on signals for invariants; create related rows explicitly in the import, or use `get_or_create` lazily, and add a DB-level check/backfill.

**Pitfall: deletes got slow and memory-hungry.** Someone added a `post_delete` receiver to `LogEntry` for metrics. `LogEntry.objects.filter(created__lt=cutoff).delete()` now loads millions of rows instead of one fast `DELETE`. Fix: remove the receiver, or use `_raw_delete`-style batched raw deletes in a maintenance command (with care), or track metrics differently.

**Pitfall: request latency from inline receivers.** A `post_save` receiver calls a CRM API synchronously; when the CRM slows, saving any customer takes seconds and Gunicorn workers time out. Fix: receivers must only enqueue; set timeouts on external calls in tasks.

**Pitfall: receiver exception after the row is written.** `post_save` raises; the view returns 500; the user retries; with `ATOMIC_REQUESTS` the row rolled back (fine) — without it, the first row exists and the retry creates a duplicate. Fix: idempotency keys, `send_robust` for non-critical receivers, and transactions around the whole use case.

**Debugging:**

```python
from django.db.models.signals import post_save
from orders.models import Order

print(post_save.receivers)                    # raw registry (ids)
print(post_save._live_receivers(Order))       # internal API: which receivers fire for Order
print(post_save.has_listeners(Order))         # public: any receivers at all?
```

- `_live_receivers` is private and its return shape changed in 5.0 (sync and async lists) — use it only interactively.
- Put a breakpoint in `Signal.send` to see every dispatch in a request; or grep the codebase for `@receiver(` and `.connect(`.
- In Sentry, a stack trace through `django/dispatch/dispatcher.py` tells you a receiver raised.

**Scaling notes:** signals don't scale across processes — they are local to the Python process. For cross-service events use a message broker with an outbox; for fan-out inside a monolith, signals + `on_commit` + Celery is fine. Keep receiver count low on hot models: each one is a function call per save and may disable fast-delete.

## 9. Interview Questions

**Q: What are Django signals and how do they work internally?**
A: Signals implement the observer pattern: a `Signal` object keeps a list of receivers, `connect()` adds one (optionally filtered by sender), and `send()` iterates the live receivers and calls each with `sender` and keyword arguments, returning their responses. It's an in-process synchronous loop — no queue or thread — so receivers run in the sender's thread and transaction. Built-in signals cover models (`pre_save`, `post_save`, `pre_delete`, `post_delete`, `m2m_changed`), requests, auth and migrations. Receivers use weak references by default.

**Q: Are Django signals synchronous or asynchronous?**
A: Synchronous. `send()` calls receivers one after another before returning, in the same thread, and model signals execute inside whatever transaction the `save()` is in. Django 5.0 added `asend()` so async code can dispatch without blocking and both sync and async receivers are supported, but that's still not background processing. For background work, use Celery and dispatch with `transaction.on_commit`.

**Q: Where should you register signal receivers and why?**
A: In a `signals.py` (or `receivers.py`) module imported from the app's `AppConfig.ready()`. `ready()` runs once after the app registry is fully populated, so models are importable and there are no circular-import issues; importing in `models.py` risks import cycles and putting them elsewhere risks them never being imported. Add `dispatch_uid` so duplicate imports don't register twice.

**Q: Which operations do not trigger `pre_save`/`post_save`?**
A: `QuerySet.update()`, `bulk_create()`, `bulk_update()`, raw SQL and direct `cursor.execute()` don't call `save()`, so no save signals fire. `QuerySet.delete()` is different — the collector sends `pre_delete`/`post_delete` for each object, which is why connected delete receivers disable fast-delete. `loaddata` does send save signals but with `raw=True`. This is the main reason signals can't be used to guarantee invariants.

**Q: What is `dispatch_uid` for?**
A: It's a unique identifier for a receiver registration. If `connect()` is called again with the same `dispatch_uid` (e.g. the signals module is imported twice through different paths), Django doesn't add a duplicate, so the receiver runs once per send. Without it the deduplication is by receiver identity, which fails for re-created functions.

**Q: How do you avoid sending an email from `post_save` when the transaction later rolls back?**
A: Wrap the side effect in `transaction.on_commit(lambda: send_email.delay(instance.pk))`. Django queues the callback and runs it after the outermost transaction commits; on rollback it's discarded. In autocommit mode (no active transaction) it runs immediately. Pass the ID, not the instance, to the Celery task, and make the task idempotent.

**Q: What is `m2m_changed` and why doesn't `post_save` see M2M changes?**
A: M2M relations live in a separate through table written by the related manager's `add()`, `remove()`, `clear()` and `set()`, which send `m2m_changed` with an `action` (pre/post add/remove/clear), `instance`, `model`, `pk_set` and `reverse`. `save()` writes only the model's own row, and ModelForms (including admin) save M2M afterwards via `save_m2m()`. So `post_save` runs before the M2M data is written; listen to `m2m_changed` with `sender=Model.field.through`.

**Q: What's the difference between `send()` and `send_robust()`?**
A: `send()` lets a receiver's exception propagate immediately, so later receivers don't run and the caller (e.g. `save()`) sees the error. `send_robust()` catches `Exception` per receiver and returns it in the `(receiver, response)` list, so all receivers run. Use `send_robust` for optional listeners where one failure shouldn't affect others — and log the returned exceptions, since otherwise they vanish.

**Q: When are signals an anti-pattern? (Senior)**
A: When they're used for core business logic in your own code: the behaviour of `order.save()` becomes invisible, ordering between receivers is implicit, bulk ops and raw SQL silently skip it, receivers run inside the transaction and add latency, and tests need to mute them. They also create hidden recursion when receivers save models. I reserve signals for reacting to code I don't own (contrib/third-party) and as explicit extension points of reusable apps; for my own domain, an explicit service function plus `on_commit` and Celery is clearer and testable.

**Q: You inherited a codebase where `post_save` on `Order` triggers 8 receivers. How would you refactor it? (Senior)**
A: Inventory receivers with grep and `_live_receivers(Order)`, classify them into core (stock, payment state), peripheral (email, analytics) and derived data (caches, search). Move core logic into an explicit `place_order()`/`mark_paid()` service with clear transaction boundaries and tests; convert peripheral ones to Celery tasks dispatched via `on_commit`, possibly from a custom `order_paid` signal sent explicitly by the service; replace derived-data receivers with cache invalidation helpers or DB-level mechanisms. Do it incrementally behind tests that assert side effects per use case, and verify bulk paths now behave correctly.

**Q: How would you guarantee a downstream system learns about every order, even across crashes? (Senior)**
A: Signals can't guarantee it: the process can crash after commit but before the receiver enqueues, and `on_commit` callbacks are lost then too. Use a transactional outbox — insert an `OutboxEvent` row in the same transaction as the order, then a relay (Celery beat poller or CDC like Debezium) publishes events and marks them sent, with consumers deduplicating by event ID. This gives at-least-once delivery with idempotent consumers. Signals can still be used locally to *write* the outbox row inside the transaction, but explicit service code is clearer.

**Q: Why might adding a `post_delete` receiver make deletes slower?**
A: Django's deletion `Collector` can do a "fast delete" — a single `DELETE ... WHERE` — only when no per-object work is needed, which requires no delete signal receivers for that model and no Python-side cascades. Once a receiver exists, Django must fetch every object to send `pre_delete`/`post_delete` with the instance, loading rows into memory and issuing more queries. On large tables that turns a millisecond delete into minutes.

**Q: How do you test code that depends on signals and `on_commit`?**
A: For receivers, test behaviour through the public action (create a user, assert the profile exists). To isolate, connect a `mock.Mock()` with `weak=False` and assert calls, disconnecting afterward, or temporarily `disconnect()` the real receiver. Since `TestCase` wraps each test in a transaction that's rolled back, `on_commit` callbacks never fire — use `self.captureOnCommitCallbacks(execute=True)` (3.2+) or `TransactionTestCase`. Also test that bulk paths behave correctly without signals.

## 10. Quick Revision & Cheat Sheet

| Signal | Sent by | Key kwargs |
|---|---|---|
| `pre_save` / `post_save` | `Model.save()` | `instance`, `raw`, `using`, `update_fields`, `created` (post only) |
| `pre_delete` / `post_delete` | `Model.delete()`, `QuerySet.delete()` | `instance`, `using`, `origin` (4.1+) |
| `m2m_changed` | related manager add/remove/clear/set | `action`, `instance`, `reverse`, `model`, `pk_set` |
| `pre_init` / `post_init` | Model `__init__` | `args`, `kwargs` / `instance` |
| `post_migrate` | `migrate` (per app) | `app_config`, `verbosity`, `plan`, `apps` |
| `request_started` / `request_finished` | handler | `environ` / — |
| `got_request_exception` | handler on unhandled exception | `request` |
| `user_logged_in` / `_out` / `_login_failed` | `contrib.auth` | `request`, `user` / `credentials` |

- Synchronous, same thread, same transaction.
- Register in `AppConfig.ready()`; always `sender=` and `dispatch_uid=`.
- Receivers take `sender, **kwargs`.
- `update()`, `bulk_create()`, `bulk_update()`, raw SQL: no save signals.
- Delete receivers disable fast-delete.
- Side effects: `transaction.on_commit` + Celery with IDs.
- `send_robust` isolates receiver failures; `asend` (5.0+) for async callers.
- Signals for code you don't own; explicit services for your own domain.

## 11. Hands-On Exercises

Set up: `python -m venv .venv && source .venv/bin/activate && pip install "django~=5.2"`, create a project with `accounts` and `orders` apps.

1. **Profile receiver.** Implement §5.1, then prove `bulk_create` skips it. Write a management command that backfills missing profiles.
2. **Duplicate registration.** Remove `dispatch_uid` and import the signals module from two places; observe double execution; restore `dispatch_uid`.
3. **Rollback bug.** Inside `transaction.atomic()`, save an order whose `post_save` logs "email sent", then raise. Observe the log line despite the rollback; fix with `on_commit` and confirm.
4. **Fast-delete.** Create 100k rows, time `QuerySet.delete()` with and without a `post_delete` receiver, and inspect the query count with `connection.queries`.
5. **m2m_changed.** Edit an article's tags in the admin and log which of `post_save` and `m2m_changed` see the new tags.

**Mini project — "Refactor the signal soup":** start from an `Order` model with five `post_save` receivers (stock, payment, email, analytics, cache). Refactor into a `mark_order_paid` service, a custom `order_paid` signal sent after commit, and Celery tasks — with tests proving each side effect happens exactly once and never on rollback.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** [Ch 02 · Projects, Apps & Settings](topic.html?p=02-projects-apps-settings) · [Ch 08 · Models & Fields](topic.html?p=08-models-fields) · [Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization) · [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) · [Ch 18 · Middleware](topic.html?p=18-middleware) · [Ch 29 · Caching](topic.html?p=29-caching) · [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks) · [Ch 33 · Testing](topic.html?p=33-testing)

**Other handbooks:** [Messaging · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox) · [System Design · Event-Driven & CQRS](../system-design/topic.html?p=25-event-driven-cqrs) · [Redis Caching · Cache Invalidation](../redis-caching/topic.html?p=12-cache-invalidation)

**Free resources:**
- **Signals (topic guide)** — Django docs · *Beginner* · connecting, sending, custom signals and the caveats. <https://docs.djangoproject.com/en/5.2/topics/signals/>
- **Signals reference** — Django docs · *Intermediate* · every built-in signal and its arguments. <https://docs.djangoproject.com/en/5.2/ref/signals/>
- **Database transactions: on_commit** — Django docs · *Intermediate* · why side effects must wait for commit. <https://docs.djangoproject.com/en/5.2/topics/db/transactions/>
- **Django source: django/dispatch/dispatcher.py** — GitHub · *Advanced* · the whole signal implementation in one readable file. <https://github.com/django/django/blob/main/django/dispatch/dispatcher.py>
- **Celery: Tasks** — Celery docs · *Intermediate* · the right place for work that signals should only enqueue. <https://docs.celeryq.dev/en/stable/userguide/tasks.html>

---

*Django Handbook — chapter 19.*
