# 31 · Background Tasks with Celery

> **In one line:** Anything slow, flaky or not needed to build the HTTP response belongs in a background task — and with Celery that means passing IDs not objects, dispatching only after the transaction commits, and writing every task so that running it twice is harmless, because at-least-once is the delivery you actually get.

---

## 1. Overview

> **Builds on:** [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) (atomic, `on_commit`), [Ch 19 · Signals](topic.html?p=19-signals), [Ch 30 · Async Django & ASGI](topic.html?p=30-async-django-asgi), [Ch 29 · Caching in Django](topic.html?p=29-caching).

A user clicks "Sign up". Your view creates the `User`, sends a welcome email through an SMTP provider, generates a PDF invoice, resizes the avatar and pings a CRM webhook. Each of those external calls takes between 200 ms and several seconds, and any of them can time out. Done inline, the request takes eight seconds, a Gunicorn worker is pinned for all eight, and when the CRM is down the *signup itself* returns a 500 — even though the user row was created fine. Under load, ten slow signups occupy ten workers and your whole site stops answering.

The naive fixes fail in instructive ways. **Spawning a thread** inside the view (`threading.Thread(target=send_email).start()`) looks like it works in development, but the thread dies when Gunicorn recycles or kills the worker, there is no retry, no visibility, and nothing survives a deploy. **`asyncio.create_task` in an async view** has the same problem: fire-and-forget work lives only as long as the process. **A cron job that scans a table every minute** works but adds latency, duplicates logic and needs its own locking. What you actually need is a **durable queue**: the web process writes a small message ("send welcome email to user 42") into a broker, returns immediately, and a separate pool of **worker** processes pulls messages, executes them, retries failures with backoff, and acknowledges completion.

**Celery** is the de-facto Python implementation of that pattern. It is a distributed task queue: you decorate a function with `@shared_task`, call `.delay()` from Django, and a Celery worker (a separate process started with `celery -A proj worker`) runs it. It brings retries, rate limits, time limits, scheduling (`celery beat`), workflow primitives (chain, group, chord) and monitoring (Flower, events). It also brings distributed-systems problems straight into your Django code: messages can be delivered twice, tasks can run before the database row they refer to is committed, and a model instance pickled into a message is stale by the time it runs. This chapter is about using Celery correctly — the part interviewers probe.

> **Version note:** Django 6.0 adds a built-in Tasks framework (`django.tasks`) that standardises the "enqueue a function" API with pluggable backends. On Django 5.2 LTS, Celery (or RQ/Dramatiq/Huey) is still how production systems do it, and the principles in this chapter carry over unchanged.

## 2. Core Concepts

- **Task** — a Python function registered with Celery (`@shared_task` / `@app.task`). *Why it matters:* the unit of retry, timeout and routing; its arguments must be serialisable (JSON by default).
- **Producer / client** — the code that enqueues (`task.delay()`, `task.apply_async()`), usually a Django view. *Why:* producing is cheap (one broker write) — that is the whole latency win.
- **Broker** — the message transport: **RabbitMQ** (AMQP, real acks, priorities) or **Redis** (simpler, visibility-timeout based). *Why:* it determines durability and redelivery semantics.
- **Worker** — a long-running process (`celery worker`) with a pool of child processes/threads that execute tasks. *Why:* you scale throughput by adding workers, independent of web servers.
- **Pool** — `prefork` (default, multiprocessing), `threads`, `gevent`/`eventlet` (greenlets for I/O), `solo`. *Why:* CPU-bound work wants prefork; thousands of HTTP calls want gevent.
- **Result backend** — optional store for return values/states (Redis, database via `django-celery-results`). *Why:* only needed if someone reads results; leaving it on for every task wastes memory.
- **AsyncResult** — handle returned by `.delay()` (has `.id`, `.state`, `.get()`). *Why:* calling `.get()` inside a web request (or another task) re-introduces blocking and can deadlock.
- **Acknowledgement (ack)** — telling the broker a message is done. Default: acked *before* execution (early ack). With `acks_late=True`: acked *after* the task returns. *Why:* early ack loses the task if the worker dies mid-run; late ack can run it twice.
- **Prefetch multiplier** — how many messages each worker process reserves in advance (default 4). *Why:* with long tasks, prefetching starves other workers; set `worker_prefetch_multiplier=1` for long jobs.
- **Retry** — re-enqueue on failure, via `self.retry()` or `autoretry_for`, with `retry_backoff` and `max_retries`. *Why:* transient failures (timeouts, 503s) are normal; retries without idempotency multiply side effects.
- **Idempotency** — running the task twice has the same effect as once. *Why:* at-least-once delivery (late acks, redelivery after visibility timeout, manual replays) guarantees duplicates eventually.
- **`transaction.on_commit`** — Django hook that runs a callback after the outermost transaction commits. *Why:* dispatching inside an open transaction lets the worker run before the row exists.
- **Celery beat** — the scheduler process that enqueues periodic tasks; `django-celery-beat` stores schedules in the DB. *Why:* replaces cron; must run as exactly **one** instance.
- **Canvas** — workflow primitives: `chain` (sequential, result piped), `group` (parallel), `chord` (group + callback when all finish). *Why:* fan-out/fan-in without hand-rolled coordination; chords need a result backend.
- **Routing / queues** — send tasks to named queues (`task_routes`) consumed by dedicated workers. *Why:* a flood of slow report jobs must not delay password-reset emails.
- **Time limits** — `soft_time_limit` (raises `SoftTimeLimitExceeded` inside the task) and `time_limit` (hard kill). *Why:* a hung HTTP call otherwise blocks a worker slot forever.

## 3. Theory & Principles

### The life of a task message

When you call `send_welcome_email.delay(user_id=42)`, Celery's client does not run anything. It builds a message — task name (`"accounts.tasks.send_welcome_email"`), a UUID task id, args/kwargs serialised to JSON, retry count, ETA, headers — and publishes it to the broker under the task's queue (default `celery`). That is one network round trip, typically well under a millisecond on a local network.

A worker process, started with `celery -A proj worker -l info`, holds a connection to the broker and **consumes** from one or more queues. The main worker process (the *consumer*) reserves up to `concurrency × prefetch_multiplier` messages, hands each to a child in its pool, and the child looks up the task by name in its registry (populated at startup by `app.autodiscover_tasks()` importing every installed app's `tasks.py`), deserialises the arguments, and calls the function. On success, it stores the result (if a backend is configured) and the message is acknowledged. On exception, the task either retries (a *new* message with `retries+1` and an ETA is published) or is marked `FAILURE`.

The crucial detail is **when the ack happens**. By default Celery acks the message *when the worker receives it, before running the task*. If the worker is OOM-killed halfway through, the message is already gone: the task is lost (at-most-once). With `acks_late=True` the ack is sent *after* the function returns; if the worker dies, the broker redelivers the message to another worker (RabbitMQ when the channel closes; Redis after the **visibility timeout**, default one hour). That is at-least-once — and it means your task can run twice. There is no setting that gives you exactly-once; you get it *in effect* by making the task idempotent. See [Messaging · Delivery Guarantees](../messaging/topic.html?p=04-delivery-guarantees) and [Messaging · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox).

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj31a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
    <marker id="dj31b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Celery topology: Django produces, broker stores, workers consume</text>
  <rect x="20" y="50" width="170" height="130" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="105" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">Django web (Gunicorn)</text>
  <text x="105" y="94" text-anchor="middle" fill="#334155">view: create Order</text>
  <text x="105" y="112" text-anchor="middle" fill="#334155">on_commit(lambda:</text>
  <text x="105" y="128" text-anchor="middle" fill="#334155">send_receipt.delay(id))</text>
  <text x="105" y="160" text-anchor="middle" fill="#16a34a" font-weight="bold">returns 201 in ~50 ms</text>
  <rect x="20" y="220" width="170" height="80" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="105" y="244" text-anchor="middle" fill="#1e293b" font-weight="bold">celery beat (x1)</text>
  <text x="105" y="264" text-anchor="middle" fill="#334155">every 5 min: enqueue</text>
  <text x="105" y="282" text-anchor="middle" fill="#334155">expire_abandoned_carts</text>
  <rect x="300" y="60" width="240" height="250" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="420" y="84" text-anchor="middle" fill="#1e293b" font-weight="bold">Broker (RabbitMQ / Redis)</text>
  <rect x="320" y="100" width="200" height="40" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="420" y="117" text-anchor="middle" fill="#334155">queue "default"</text>
  <text x="420" y="132" text-anchor="middle" fill="#334155">[receipt:7] [receipt:8] ...</text>
  <rect x="320" y="155" width="200" height="40" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="420" y="172" text-anchor="middle" fill="#334155">queue "reports" (slow)</text>
  <text x="420" y="187" text-anchor="middle" fill="#334155">[monthly_report:3]</text>
  <rect x="320" y="210" width="200" height="40" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="420" y="227" text-anchor="middle" fill="#334155">unacked (in flight)</text>
  <text x="420" y="242" text-anchor="middle" fill="#334155">redelivered if worker dies</text>
  <text x="420" y="285" text-anchor="middle" fill="#92400e">message = name + id + JSON args</text>
  <rect x="650" y="50" width="210" height="120" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="755" y="72" text-anchor="middle" fill="#1e293b" font-weight="bold">worker -Q default</text>
  <text x="755" y="94" text-anchor="middle" fill="#334155">prefork pool, concurrency 8</text>
  <text x="755" y="112" text-anchor="middle" fill="#334155">Order.objects.get(pk=id)</text>
  <text x="755" y="130" text-anchor="middle" fill="#334155">send email, mark sent</text>
  <text x="755" y="152" text-anchor="middle" fill="#16a34a">ack (late) after return</text>
  <rect x="650" y="190" width="210" height="100" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="755" y="212" text-anchor="middle" fill="#1e293b" font-weight="bold">worker -Q reports</text>
  <text x="755" y="234" text-anchor="middle" fill="#334155">prefetch_multiplier=1</text>
  <text x="755" y="252" text-anchor="middle" fill="#334155">soft_time_limit=600</text>
  <text x="755" y="272" text-anchor="middle" fill="#334155">isolated from emails</text>
  <rect x="650" y="310" width="210" height="60" rx="10" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="755" y="334" text-anchor="middle" fill="#1e293b" font-weight="bold">Result backend (optional)</text>
  <text x="755" y="352" text-anchor="middle" fill="#334155">states / return values</text>
  <path d="M190,115 L298,120" stroke="#334155" stroke-width="2" marker-end="url(#dj31a)"/>
  <path d="M190,260 L298,230" stroke="#334155" stroke-width="2" marker-end="url(#dj31a)"/>
  <path d="M520,120 L648,110" stroke="#334155" stroke-width="2" marker-end="url(#dj31a)"/>
  <path d="M520,175 L648,235" stroke="#334155" stroke-width="2" marker-end="url(#dj31a)"/>
  <path d="M755,290 L755,308" stroke="#334155" stroke-width="2" marker-end="url(#dj31a)"/>
  <path d="M650,160 L524,232" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="5 3" marker-end="url(#dj31b)"/>
  <text x="560" y="210" fill="#dc2626" font-size="10">crash</text>
  <text x="20" y="350" fill="#334155">Web and workers share the same codebase and settings, but are separate processes,</text>
  <text x="20" y="368" fill="#334155">scaled separately. Workers talk to the same PostgreSQL as web.</text>
</svg>
```

### Why you pass IDs, not model instances

`send_receipt.delay(order)` fails with the default JSON serializer (a model instance is not JSON-serialisable). People "fix" it by switching to pickle, and that is worse: pickle is a remote-code-execution risk if anyone can write to your broker, and the pickled object is a **snapshot** taken at enqueue time. If the task runs 30 seconds later, after an admin changed the order's address, the task sends the old address. If it is retried an hour later, the snapshot is an hour old. Passing `order.pk` forces the task to re-read the current row with `Order.objects.get(pk=order_id)` — fresh data, small messages, language-neutral JSON. It also gives you a natural place to handle "the row was deleted in the meantime" (`DoesNotExist` → log and return).

### Why you dispatch on commit

Here is the classic race. Inside `transaction.atomic()` (or with `ATOMIC_REQUESTS=True`) your view does `order = Order.objects.create(...)` then `send_receipt.delay(order.pk)`. The message hits the broker immediately. A worker picks it up in two milliseconds and runs `Order.objects.get(pk=...)` — on its own database connection, in its own transaction, under READ COMMITTED — and the view's transaction **has not committed yet**. The worker gets `DoesNotExist`. Or worse: the view later raises and rolls back, and the worker already emailed a receipt for an order that never existed.

`transaction.on_commit(callback)` fixes both. Django stores the callback on the connection's list of pending callbacks; when the **outermost** `atomic` block commits, it runs them in order; if the transaction rolls back, they are discarded. Outside any transaction (plain autocommit) the callback runs immediately. The idiom is:

```python
from functools import partial
from django.db import transaction

transaction.on_commit(lambda: send_receipt.delay(order.pk))
# or, avoiding late-binding surprises:
transaction.on_commit(partial(send_receipt.delay, order.pk))
```

> **Gotcha:** a lambda inside a loop captures the variable, not the value: `for o in orders: on_commit(lambda: task.delay(o.pk))` enqueues the *last* order N times. Use `partial(task.delay, o.pk)` or `lambda pk=o.pk: task.delay(pk)`.

`on_commit` closes the "task runs before commit" gap but leaves a smaller one: the commit succeeds and then the process dies before the callback publishes. The task is never sent. For most emails that is acceptable; for money it is not, and you use a **transactional outbox** — write an `OutboxEvent` row in the same transaction, and a relay (a beat task or CDC) publishes it. That pattern lives in [Messaging · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox). Django 5.0+ also accepts `on_commit(fn, robust=True)` so that one failing callback (say, the broker is down) does not prevent later callbacks from running.

### Idempotency: the property that makes retries safe

Duplicates come from many directions: `acks_late` redelivery after a worker crash, Redis visibility timeout expiring for a task that ran longer than an hour, a retry after a timeout where the remote call actually succeeded, a human re-running a failed task from Flower, or the producer enqueuing twice. A task is idempotent when its *effect* converges no matter how many times it runs. Techniques, cheapest first:

1. **Make the effect a state, not a delta.** `Order.objects.filter(pk=id).update(status="shipped")` is naturally idempotent; `F("balance") + 10` is not.
2. **Guard with a state check under a lock.** `select_for_update()` the row, return if `receipt_sent_at` is set, otherwise send and set it, all inside `atomic()`.
3. **Record a processed key.** Insert `(task_name, business_key)` into a table with a unique constraint; an `IntegrityError` means "already done".
4. **Pass an idempotency key to the external API** (Stripe and most payment gateways support it) so the provider dedupes retries of a call that may have succeeded.

### Retries and backoff

A task that calls an HTTP API will see timeouts. `autoretry_for=(requests.Timeout, requests.ConnectionError)` with `retry_backoff=True` makes Celery re-enqueue with exponential delays (1 s, 2 s, 4 s … capped by `retry_backoff_max`, default 600 s) and `retry_jitter=True` (default) randomises them to avoid thundering herds. `max_retries` (default 3) bounds it; after that the exception propagates and the task is `FAILURE`. Manual control: `raise self.retry(exc=exc, countdown=30)` inside a `bind=True` task. Retry only **transient** errors; retrying a `ValidationError` five times just produces five failures.

## 4. Architecture & Workflow

### The request-to-task sequence

The diagram below is the sequence you should be able to draw on a whiteboard: the publish happens only after COMMIT, so the worker's SELECT always finds the row.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj31c" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">on_commit dispatch: the task can only see committed data</text>
  <rect x="40" y="40" width="130" height="30" rx="6" fill="#dbeafe" stroke="#2563eb"/><text x="105" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">View</text>
  <rect x="260" y="40" width="130" height="30" rx="6" fill="#f1f5f9" stroke="#94a3b8"/><text x="325" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">PostgreSQL</text>
  <rect x="480" y="40" width="130" height="30" rx="6" fill="#fef3c7" stroke="#d97706"/><text x="545" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Broker</text>
  <rect x="700" y="40" width="130" height="30" rx="6" fill="#dcfce7" stroke="#16a34a"/><text x="765" y="60" text-anchor="middle" fill="#1e293b" font-weight="bold">Worker</text>
  <line x1="105" y1="70" x2="105" y2="380" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="325" y1="70" x2="325" y2="380" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="545" y1="70" x2="545" y2="380" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <line x1="765" y1="70" x2="765" y2="380" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <rect x="95" y="90" width="240" height="120" fill="#ede9fe" stroke="#7c3aed" opacity="0.6"/>
  <text x="215" y="104" text-anchor="middle" fill="#5b21b6" font-size="10">atomic(): uncommitted, invisible to others</text>
  <path d="M105,125 L320,125" stroke="#334155" stroke-width="1.5" marker-end="url(#dj31c)"/><text x="210" y="120" text-anchor="middle" fill="#334155">INSERT order 7</text>
  <text x="215" y="152" text-anchor="middle" fill="#334155">on_commit(cb) registered</text>
  <text x="215" y="166" text-anchor="middle" fill="#334155">(nothing sent yet)</text>
  <path d="M105,195 L320,195" stroke="#334155" stroke-width="1.5" marker-end="url(#dj31c)"/><text x="210" y="190" text-anchor="middle" fill="#334155">COMMIT</text>
  <path d="M105,235 L540,235" stroke="#2563eb" stroke-width="2" marker-end="url(#dj31c)"/><text x="320" y="230" text-anchor="middle" fill="#2563eb">cb(): send_receipt.delay(7) publishes</text>
  <path d="M545,265 L760,265" stroke="#334155" stroke-width="1.5" marker-end="url(#dj31c)"/><text x="655" y="260" text-anchor="middle" fill="#334155">deliver message</text>
  <path d="M765,295 L330,295" stroke="#334155" stroke-width="1.5" marker-end="url(#dj31c)"/><text x="545" y="290" text-anchor="middle" fill="#334155">SELECT order 7 (row is visible)</text>
  <text x="755" y="330" text-anchor="end" fill="#334155">send email, set receipt_sent_at</text>
  <path d="M765,355 L550,355" stroke="#16a34a" stroke-width="1.5" marker-end="url(#dj31c)"/><text x="655" y="350" text-anchor="middle" fill="#16a34a">ack (acks_late)</text>
  <text x="40" y="405" fill="#dc2626">Without on_commit: the publish happens inside the purple box and the worker SELECT finds nothing.</text>
</svg>
```

### Project layout and wiring

```text
proj/
├── proj/
│   ├── __init__.py        # imports celery app so @shared_task binds to it
│   ├── celery.py          # Celery('proj'), config_from_object, autodiscover_tasks
│   └── settings.py        # CELERY_* settings
├── orders/
│   ├── models.py
│   ├── services.py        # place_order(): atomic + on_commit
│   └── tasks.py           # @shared_task send_receipt
└── manage.py

processes in production:
  gunicorn proj.wsgi                         (N replicas)
  celery -A proj worker -Q default           (M replicas)
  celery -A proj worker -Q reports -c 2 --prefetch-multiplier=1
  celery -A proj beat                        (exactly 1)
  celery -A proj flower                      (optional, behind auth)
```

### Workflow primitives (canvas)

- `chain(a.s(1), b.s(), c.s())` — runs `a`, passes its return value as the first argument to `b`, then `c`. Sequential pipeline.
- `group(resize.s(img_id, size) for size in SIZES)` — runs in parallel across workers.
- `chord(group(...), finalize.s())` — when every member of the group finishes, calls `finalize` with the list of results. Requires a result backend and tracks completion with a counter; a single failing member means the callback never runs (it errors instead).
- `.si()` (immutable signature) when you do *not* want the previous result passed in.

Use canvas sparingly. A chord of 10,000 tasks puts 10,000 results into the backend; often a simpler design is "each task updates its own row; a periodic task checks whether all rows are done".

## 5. Implementation

### Simple example: a welcome email

```bash
python -m venv .venv && source .venv/bin/activate
pip install "django~=5.2" "celery[redis]~=5.4"
```

The Celery application module lives next to `settings.py`:

```python
# proj/celery.py
import os
from celery import Celery

os.environ.setdefault("DJANGO_SETTINGS_MODULE", "proj.settings")

app = Celery("proj")
# Read every setting that starts with CELERY_ from Django settings.
app.config_from_object("django.conf:settings", namespace="CELERY")
# Import tasks.py from every INSTALLED_APP.
app.autodiscover_tasks()
```

```python
# proj/__init__.py
from .celery import app as celery_app

__all__ = ("celery_app",)
```

```python
# proj/settings.py (excerpt)
import os

CELERY_BROKER_URL = os.environ.get("CELERY_BROKER_URL", "redis://localhost:6379/0")
CELERY_RESULT_BACKEND = None          # we don't read results
CELERY_TASK_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
CELERY_TASK_ACKS_LATE = True          # at-least-once; tasks must be idempotent
CELERY_TASK_REJECT_ON_WORKER_LOST = True
CELERY_WORKER_PREFETCH_MULTIPLIER = 1
CELERY_TASK_TIME_LIMIT = 300          # hard kill after 5 min
CELERY_TASK_SOFT_TIME_LIMIT = 240
CELERY_TIMEZONE = "UTC"
```

```python
# accounts/tasks.py
import logging
from celery import shared_task
from django.contrib.auth import get_user_model
from django.core.mail import send_mail

log = logging.getLogger(__name__)

@shared_task
def send_welcome_email(user_id: int) -> None:
    User = get_user_model()
    try:
        user = User.objects.get(pk=user_id)
    except User.DoesNotExist:
        log.warning("welcome email: user %s vanished", user_id)
        return
    send_mail("Welcome!", f"Hi {user.first_name}", None, [user.email])
```

```python
# accounts/views.py
from django.db import transaction
from django.shortcuts import redirect, render
from .forms import SignupForm
from .tasks import send_welcome_email

def signup(request):
    form = SignupForm(request.POST or None)
    if form.is_valid():
        with transaction.atomic():
            user = form.save()
            transaction.on_commit(lambda: send_welcome_email.delay(user.pk))
        return redirect("home")
    return render(request, "signup.html", {"form": form})
```

```bash
celery -A proj worker -l info          # terminal 1
python manage.py runserver              # terminal 2
```

```text
[2026-10-25 10:00:01,203: INFO/MainProcess] Task accounts.tasks.send_welcome_email[3f2c...] received
[2026-10-25 10:00:01,451: INFO/ForkPoolWorker-1] Task accounts.tasks.send_welcome_email[3f2c...] succeeded in 0.24s: None
```

### Real-world example: idempotent payment capture with retries

The order has been placed; now you must capture the payment with an external gateway, which times out occasionally and supports idempotency keys.

```python
# payments/models.py
import uuid
from django.db import models

class Payment(models.Model):
    class Status(models.TextChoices):
        PENDING = "pending"
        CAPTURED = "captured"
        FAILED = "failed"

    order = models.OneToOneField("orders.Order", on_delete=models.PROTECT)
    amount_cents = models.PositiveIntegerField()
    status = models.CharField(max_length=16, choices=Status, default=Status.PENDING)
    gateway_charge_id = models.CharField(max_length=64, blank=True)
    idempotency_key = models.UUIDField(default=uuid.uuid4, unique=True, editable=False)
    captured_at = models.DateTimeField(null=True, blank=True)
    receipt_sent_at = models.DateTimeField(null=True, blank=True)
```

```python
# payments/tasks.py
import logging
from functools import partial

import requests
from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from django.core.mail import send_mail
from django.db import transaction
from django.utils import timezone

from .gateway import GatewayClient, CardDeclined, GatewayServerError
from .models import Payment

log = logging.getLogger(__name__)
TRANSIENT = (requests.Timeout, requests.ConnectionError, GatewayServerError)

@shared_task(
    bind=True,
    acks_late=True,
    autoretry_for=TRANSIENT,
    retry_backoff=True,        # 1s, 2s, 4s, ... with jitter
    retry_backoff_max=300,
    max_retries=8,
    soft_time_limit=30,
    queue="payments",
)
def capture_payment(self, payment_id: int) -> None:
    # 1. Cheap pre-check outside the lock: already done? (duplicate delivery)
    if Payment.objects.filter(pk=payment_id, status=Payment.Status.CAPTURED).exists():
        log.info("payment %s already captured, skipping", payment_id)
        return

    with transaction.atomic():
        # 2. Lock the row so two concurrent duplicates cannot both call the gateway.
        payment = Payment.objects.select_for_update().get(pk=payment_id)
        if payment.status != Payment.Status.PENDING:
            return
        try:
            # 3. The gateway dedupes on idempotency_key: if a previous attempt
            #    succeeded but we timed out reading the response, it returns
            #    the original charge instead of charging twice.
            charge = GatewayClient().capture(
                amount=payment.amount_cents,
                idempotency_key=str(payment.idempotency_key),
                timeout=10,
            )
        except CardDeclined as exc:
            payment.status = Payment.Status.FAILED
            payment.save(update_fields=["status"])
            log.warning("payment %s declined: %s", payment_id, exc)
            return                     # business failure: do NOT retry
        except SoftTimeLimitExceeded:
            raise self.retry(countdown=60)

        payment.status = Payment.Status.CAPTURED
        payment.gateway_charge_id = charge.id
        payment.captured_at = timezone.now()
        payment.save(update_fields=["status", "gateway_charge_id", "captured_at"])
        transaction.on_commit(partial(send_payment_receipt.delay, payment.pk))


@shared_task(acks_late=True)
def send_payment_receipt(payment_id: int) -> None:
    # Idempotent by state: an atomic conditional UPDATE "claims" the send.
    # Only one execution can flip receipt_sent_at from NULL; duplicates see 0 rows.
    claimed = Payment.objects.filter(
        pk=payment_id, receipt_sent_at__isnull=True
    ).update(receipt_sent_at=timezone.now())
    if not claimed:
        return
    payment = Payment.objects.select_related("order__customer").get(pk=payment_id)
    send_mail(
        "Payment received",
        f"We received {payment.amount_cents / 100:.2f} for order {payment.order_id}.",
        None,
        [payment.order.customer.email],
    )
```

> **Gotcha:** claim-then-send makes the email *at-most-once*: if the worker dies after the UPDATE but before `send_mail`, no email goes out. Send-then-claim makes it *at-least-once*. Choose consciously — for receipts, a rare missing email is better than duplicates; for a payout, you would record the external call's idempotency key instead.

> **Gotcha:** holding `select_for_update()` across a network call keeps the row lock for up to the gateway timeout. That is acceptable here because the lock is per-payment and the timeout is bounded; never hold a lock on a *hot* row (a shared counter) across I/O.

The SQL the worker issues for the locking read and the claim:

```sql
SELECT "payments_payment"."id", "payments_payment"."order_id", ...
FROM "payments_payment"
WHERE "payments_payment"."id" = 42
LIMIT 21
FOR UPDATE;

UPDATE "payments_payment"
SET "receipt_sent_at" = '2026-10-25T10:00:03+00:00'::timestamptz
WHERE ("payments_payment"."id" = 42 AND "payments_payment"."receipt_sent_at" IS NULL);
```

### Periodic tasks with beat

```python
# settings.py
from celery.schedules import crontab

CELERY_BEAT_SCHEDULE = {
    "expire-carts": {
        "task": "orders.tasks.expire_abandoned_carts",
        "schedule": 300.0,                     # every 5 minutes
    },
    "nightly-report": {
        "task": "reports.tasks.build_daily_report",
        "schedule": crontab(hour=2, minute=0),
        "options": {"queue": "reports"},
    },
}
```

```python
# orders/tasks.py
from datetime import timedelta
from celery import shared_task
from django.utils import timezone
from .models import Cart

@shared_task
def expire_abandoned_carts() -> int:
    cutoff = timezone.now() - timedelta(hours=2)
    # Set-based and idempotent: running twice expires nothing extra.
    return Cart.objects.filter(status="open", updated_at__lt=cutoff).update(status="expired")
```

With `django-celery-beat`, schedules live in the database and are editable in the admin: run `celery -A proj beat -S django`.

### Fan-out with a chord

```python
from celery import chord, shared_task
from .models import Image

@shared_task
def resize(image_id: int, width: int) -> str:
    ...  # load, resize, upload; return the storage key of the variant

@shared_task
def mark_ready(keys: list[str], image_id: int) -> None:
    Image.objects.filter(pk=image_id).update(variants=keys, ready=True)

def process_upload(image_id: int) -> None:
    chord(resize.s(image_id, w) for w in (320, 640, 1280))(mark_ready.s(image_id))
```

### Routing to separate queues

```python
CELERY_TASK_ROUTES = {
    "payments.tasks.*": {"queue": "payments"},
    "reports.tasks.*": {"queue": "reports"},
}
CELERY_TASK_DEFAULT_QUEUE = "default"
```

```bash
celery -A proj worker -Q default,payments -c 8 -n web@%h
celery -A proj worker -Q reports -c 2 --prefetch-multiplier=1 -n reports@%h
```

## 6. Advantages, Disadvantages & Trade-offs

| Option | Strengths | Weaknesses | Pick when |
|---|---|---|---|
| Celery + RabbitMQ | Real acks, priorities, mature routing, quorum queues | Another stateful service to run | Critical tasks, many queues, high volume |
| Celery + Redis | One dependency you likely already have; simple | Visibility-timeout redelivery quirks; data loss if Redis is not persistent | Most small/medium apps |
| RQ / Dramatiq / Huey | Simpler APIs, fewer knobs; Dramatiq acks late by default | Smaller ecosystem, fewer canvas features | Small teams who want less magic |
| Threads / `asyncio.create_task` | Zero infra | Lost on restart, no retries, no visibility | Never for anything that matters |
| Cron + management command | Trivial, no broker | Minute granularity, overlapping runs need locking | Nightly batch jobs only |
| Django 6.0 Tasks framework | Standard API, swappable backend | Not in 5.2; needs a backend for real work | New projects on 6.x |

### When to use

- External I/O that the response does not need: emails, SMS, webhooks, push notifications, CRM sync.
- CPU-heavy work: image/video processing, PDF generation, report building, ML inference.
- Retries of flaky dependencies with backoff.
- Scheduled maintenance (beat): expiring carts, sending digests, refreshing materialised views.
- Fan-out of one event into many independent jobs.

### When NOT to use

- When the user needs the result in the same response (validate a coupon) — do it inline, fast.
- To "speed up" a slow query — fix the query ([Ch 13 · QuerySet Optimization](topic.html?p=13-queryset-optimization)).
- For real-time pushes to a browser — that is [Ch 32 · Django Channels & Real-Time](topic.html?p=32-channels-websockets) (often a Celery task *triggers* a channel-layer send).
- As an event bus between microservices with replay needs — that is Kafka's job ([Messaging · Kafka vs RabbitMQ](../messaging/topic.html?p=03-kafka-vs-rabbitmq)).

## 7. Common Mistakes & Best Practices

**Passing model instances.** People call `task.delay(user)`. It fails under JSON or, with pickle, ships a stale snapshot and opens an RCE hole. Pass `user.pk` and re-fetch.

**Dispatching inside the transaction.** The worker races the commit and sees `DoesNotExist`, or acts on rolled-back data. Wrap in `transaction.on_commit`. This includes dispatching from a `post_save` signal — the signal fires *inside* the transaction.

```python
# Before
@receiver(post_save, sender=Order)
def on_order(sender, instance, created, **kw):
    if created:
        send_receipt.delay(instance.pk)          # races the commit

# After
@receiver(post_save, sender=Order)
def on_order(sender, instance, created, **kw):
    if created:
        transaction.on_commit(partial(send_receipt.delay, instance.pk))
```

**Non-idempotent tasks with `acks_late`.** `Account.objects.filter(pk=id).update(balance=F("balance") + amount)` in a retried task credits twice. Record a processed key or make the effect absolute.

**Retrying everything.** `autoretry_for=(Exception,)` retries bugs and validation errors, hammering dependencies with doomed calls. List transient exceptions explicitly.

**Calling `.get()` on a result inside a task.** A task that waits on another task can deadlock the pool when all slots are waiting. Celery raises a `RuntimeError` for this by default; use chains/chords instead.

**One queue for everything.** A 20-minute report blocks password resets behind it. Route slow work to its own queue and workers.

**Running several beat instances.** Two beats (e.g. beat embedded in every worker pod via `-B`) enqueue every periodic task twice. Run exactly one beat process (a Kubernetes Deployment with `replicas: 1` and `strategy: Recreate`), and still keep periodic tasks idempotent.

**Leaving the result backend on for fire-and-forget tasks.** Millions of result keys accumulate in Redis. Set `ignore_result=True` or no backend.

**Querying the database at import time in `celery.py` or `tasks.py`.** The connection is opened in the parent before fork and the socket is shared by all children, causing corrupted protocol errors. Keep imports side-effect free.

**Best practices**

- Small, explicit arguments (IDs, primitive values); keep message payloads tiny.
- Every task idempotent; every task with a time limit.
- Log task id and business key on every line (use `self.request.id` in bound tasks).
- Celery's Django fixup calls `close_old_connections` around each task; long-running loops inside one task should call `django.db.close_old_connections()` themselves.
- Version task signatures: add new kwargs with defaults so old in-flight messages still deserialise during a rolling deploy.

## 8. Production: Pitfalls, Debugging & Scaling

> **Production story:** After a deploy, receipts went out for orders that customers said they never placed. Root cause: a refactor moved `send_receipt.delay()` above a validation step inside `atomic()`. When validation failed the transaction rolled back, but the message was already published. Fix: `on_commit`, plus a guard in the task (`if not Order.objects.filter(pk=id).exists(): return`).

**Tasks "disappearing" after a worker OOM.** Symptom: some jobs never complete, no error logged. Root cause: default early ack — the message was acked before the child was SIGKILLed. Fix: `acks_late=True` and `task_reject_on_worker_lost=True`, plus idempotency.

**Tasks running twice every hour with Redis.** Symptom: long tasks (over an hour) duplicate. Root cause: Redis transport redelivers unacked messages after `visibility_timeout` (one hour default). Fix: raise `broker_transport_options={"visibility_timeout": 43200}` above your longest task + ETA, split the task, or use RabbitMQ.

**ETA/countdown tasks piling up in worker memory.** Tasks scheduled far in the future are held by the worker (reserved) until due, inflating memory and interacting with the visibility timeout. Fix: for long delays, store a `run_at` row and let a beat task enqueue due items.

**Memory growth in workers.** Python processes fragment memory over time. Use `worker_max_tasks_per_child` (recycle a child after N tasks) or `worker_max_memory_per_child` (KiB).

**Database connection exhaustion.** Each prefork child holds its own DB connection: 10 worker pods × concurrency 16 = 160 connections, on top of web. Size Postgres `max_connections` or put PgBouncer in front — see [Ch 34 · Scaling Django: Connections, Replicas & Multiple Databases](topic.html?p=34-scaling-databases).

**Graceful shutdown during deploys.** SIGTERM triggers a warm shutdown: the worker stops consuming and finishes current tasks. Kubernetes' `terminationGracePeriodSeconds` must exceed your longest task, otherwise SIGKILL follows; with `acks_late` the task is redelivered, without it, lost. See [Kubernetes · Jobs & CronJobs](../kubernetes/topic.html?p=08-jobs-cronjobs) for one-off batch alternatives.

**Poison messages.** A task that always crashes the worker (segfault in an image library, huge payload) is redelivered forever with `acks_late`. Cap retries, detect repeated redelivery (`self.request.delivery_info.get("redelivered")`) and park it in a dead-letter table or queue — see [Messaging · Backpressure & Poison Messages](../messaging/topic.html?p=23-backpressure-poison-messages).

**Debugging toolkit**

```bash
celery -A proj inspect active          # what is running right now
celery -A proj inspect reserved        # prefetched, not yet started
celery -A proj inspect scheduled       # ETA tasks held by workers
celery -A proj inspect registered      # task names the worker knows
celery -A proj purge -Q reports        # drop queued messages (careful)
celery -A proj flower --port=5555      # web UI: rates, failures, retries
```

- Queue depth is the key metric: alert on a growing backlog of the `default` queue (RabbitMQ management API, `LLEN default` in Redis).
- Sentry's Celery integration captures task exceptions with task name and arguments.
- `Received unregistered task` means the worker runs older code or `autodiscover_tasks` did not import the module — check `inspect registered` and that worker and web images are the same version.

**Scaling.** Throughput scales with workers × concurrency until you hit the database or the external API. Scale workers on queue length (KEDA in Kubernetes, see [Kubernetes · Autoscaling](../kubernetes/topic.html?p=20-autoscaling)), give each queue its own deployment, use `rate_limit="10/s"` per task to respect API quotas (it is enforced per worker, not globally), and use gevent pools for thousands of concurrent outbound HTTP calls.

## 9. Interview Questions

**Q: Why do you pass a model's ID to a Celery task instead of the model instance?**
A: Task arguments are serialised into the broker message, JSON by default, and a model instance is not JSON-serialisable. Switching to pickle "works" but ships a snapshot that is stale by the time the task runs (and even staler on retries), bloats messages, and is a remote-code-execution risk if the broker is ever writable by an attacker. Passing the primary key makes the task re-read the current row with `Model.objects.get(pk=...)`, so it acts on fresh data. It also forces you to handle the case where the row was deleted in between, which is a real event in production.

**Q: Why should you enqueue tasks with `transaction.on_commit` rather than calling `.delay()` directly?**
A: Inside `atomic()` (or with `ATOMIC_REQUESTS`) your writes are not visible to other connections until commit. `.delay()` publishes immediately, so a fast worker can run the task before the commit and get `DoesNotExist`, or act on data that is later rolled back. `transaction.on_commit(fn)` registers the callback on the connection and runs it only after the outermost transaction commits, discarding it on rollback. Outside a transaction it runs immediately, so it is always safe to use. The residual risk — the process dies between commit and publish — is solved with an outbox when you cannot afford to lose the task.

**Q: What does `acks_late=True` do and what is its trade-off?**
A: By default Celery acknowledges a message when the worker receives it, before execution, so a crash mid-task loses it (at-most-once). `acks_late=True` acknowledges after the task finishes; if the worker dies, the broker redelivers to another worker (at-least-once). The trade-off is duplicates: the task may have done some or all of its side effects before the crash. So `acks_late` is only correct for idempotent tasks. Pair it with `task_reject_on_worker_lost=True` so a SIGKILLed child's message is requeued rather than acknowledged.

**Q: What does it mean for a task to be idempotent, and how do you make one?**
A: Running it N times has the same effect as running it once. You make the effect a target state rather than a delta (`update(status="shipped")` instead of incrementing), guard with a state check under `select_for_update()`, record a processed key in a table with a unique constraint, and pass an idempotency key to external APIs so the provider dedupes a call that succeeded but timed out. Retries, late acks, visibility timeouts and manual replays all produce duplicates, so idempotency is a requirement, not an optimisation.

**Q: How do you configure retries in Celery?**
A: Either declaratively with `@shared_task(autoretry_for=(Timeout,), retry_backoff=True, retry_backoff_max=600, max_retries=5)` or manually in a `bind=True` task with `raise self.retry(exc=exc, countdown=30)`. `retry_backoff` gives exponential delays, and jitter is on by default to avoid synchronised retry storms. Retry only transient errors — network timeouts, 5xx, deadlocks — never validation or business errors like a declined card. After `max_retries` the original exception propagates and the task is marked failed, which should alert.

**Q: What are the broker and the result backend, and do you always need a result backend?**
A: The broker transports task messages from producers to workers (RabbitMQ or Redis). The result backend stores task state and return values so a caller can poll `AsyncResult`. Most Django tasks are fire-and-forget — email, webhooks — and nobody reads the result, so you set `ignore_result=True` or configure no backend at all. You need one for chords, for `AsyncResult.get()`, or for progress polling. Leaving it on everywhere fills Redis with millions of keys.

**Q: What is Celery beat and what goes wrong if you run two of them?**
A: Beat is the scheduler process that enqueues tasks on a schedule (interval or crontab), from `CELERY_BEAT_SCHEDULE` or the database with `django-celery-beat`. It does not execute tasks; workers do. Running two beats — common when you add `-B` to every worker replica — enqueues every periodic task twice. Run exactly one beat instance and still make periodic tasks idempotent and set-based so an accidental double run is harmless.

**Q: Explain chain, group and chord.**
A: A `chain` runs tasks sequentially, passing each result as the first argument of the next. A `group` runs tasks in parallel and returns a `GroupResult`. A `chord` is a group plus a callback that receives the list of results once every member has finished; it needs a result backend to count completions. Use `.si()` for immutable signatures when the next task should not receive the previous result. Large chords are expensive and fragile — one failure blocks the callback — so for big fan-outs track completion in your own table.

**Q: Why does dispatching a task from a `post_save` signal cause intermittent `DoesNotExist` errors?**
A: Signals are synchronous and fire inside the same transaction as the `save()`, before commit. If the request is wrapped in `atomic()` or `ATOMIC_REQUESTS`, the worker can pick up the task before the row is committed and visible to its connection. It is intermittent because it depends on the race between the remaining view code and the worker's speed. Wrap the dispatch in `transaction.on_commit` inside the receiver, or better, dispatch from the service function that owns the transaction.

**Q: Your task queue backs up every morning and password-reset emails take 20 minutes. How do you fix it? (Senior)**
A: First measure: queue depth per queue, task runtimes, and which tasks dominate (Flower or broker metrics). The usual cause is mixing slow batch jobs with latency-sensitive ones in one queue, plus the default prefetch of 4 letting one worker hoard long tasks. Route tasks to separate queues (`task_routes`), give the latency-sensitive queue its own worker deployment so it can never be starved, and set `worker_prefetch_multiplier=1` with `acks_late` on the slow queue. Then scale workers on queue length, add time limits so hung tasks free their slots, and check whether the batch job can be made set-based instead of one task per row.

**Q: A task that charges a card occasionally charges customers twice. Walk me through diagnosing and fixing it. (Senior)**
A: Duplicates mean the task ran more than once or retried after a partial success. Sources: `acks_late` redelivery after a crash or deploy, the Redis visibility timeout on a long task, an `autoretry_for` on a timeout where the gateway actually succeeded, or a producer enqueuing twice (dispatch in a signal plus in the view). Fixes in layers: pass a stable idempotency key (stored on the Payment row at creation) to the gateway so it dedupes; lock the row with `select_for_update()` and check status before calling; persist the outcome in the same transaction; and dispatch with `on_commit` in exactly one place. Add an alert on any Payment with two gateway charges to catch regressions.

**Q: How would you guarantee a task is never lost even if the web process crashes right after commit? (Senior)**
A: `on_commit` cannot guarantee it, because the publish is a separate step after commit. Use the transactional outbox: in the same `atomic()` that writes the order, insert an `OutboxEvent(task="send_receipt", payload={"order_id": 7})`. A relay — a beat task every few seconds using `select_for_update(skip_locked=True)`, or Debezium CDC on the table — publishes pending rows and marks them sent. The relay can publish twice if it crashes after publishing but before marking, so the consuming task stays idempotent. This gives "published if and only if committed" plus at-least-once delivery.

**Q: How do Celery workers interact with Django's database connections, and what can go wrong? (Senior)**
A: Each prefork child opens its own connection on first query and reuses it across tasks; Celery's Django fixup closes stale or errored connections before and after each task, honouring `CONN_MAX_AGE`. Problems: connection counts multiply (pods × concurrency), so Postgres runs out of slots; a connection broken by a DB failover stays broken inside a long-running loop unless you call `close_old_connections()`; and opening a connection at import time in the parent shares one socket across forked children. Size the pool budget explicitly, consider PgBouncer, and with gevent pools remember Django connections are per thread (and greenlets patch threading), so many greenlets mean many connections.

**Q: How do you test Celery tasks?**
A: Test the task function directly as a plain call (`capture_payment(payment.pk)` or `capture_payment.apply(args=[...])`) for the business logic, with external APIs mocked. For the dispatch, assert it is enqueued after commit using `TestCase.captureOnCommitCallbacks(execute=True)` and a mocked `.delay`. `CELERY_TASK_ALWAYS_EAGER` runs tasks inline but hides serialization and transaction issues, so use it sparingly. See [Ch 33 · Testing Django Applications](topic.html?p=33-testing).

**Q: What is the visibility timeout and why does it matter with Redis?**
A: Redis has no native acks, so Celery's Redis transport keeps a reserved message in an unacked set and, if it is not acknowledged within the visibility timeout (one hour by default), redelivers it. A task that legitimately runs longer than that, or an ETA task scheduled further out than that, will be delivered again to another worker and run twice. Raise the timeout above your longest task plus ETA, avoid long ETAs, or use RabbitMQ, which redelivers only when the consumer's channel closes.

## 10. Quick Revision & Cheat Sheet

| Concern | Setting / API | Rule of thumb |
|---|---|---|
| Arguments | `task.delay(obj.pk)` | IDs and primitives, JSON serializer |
| Dispatch timing | `transaction.on_commit(partial(t.delay, pk))` | Always, including from signals |
| At-least-once | `acks_late=True`, `task_reject_on_worker_lost=True` | Only with idempotent tasks |
| Retries | `autoretry_for`, `retry_backoff`, `max_retries` | Transient errors only |
| Long tasks | `worker_prefetch_multiplier=1`, own queue | Prevent hoarding and starvation |
| Hung tasks | `soft_time_limit`, `time_limit` | Every task has a limit |
| Results | `ignore_result=True` | Backend only when someone reads it |
| Scheduling | `celery beat` (one instance) | Periodic tasks set-based and idempotent |
| Memory | `worker_max_tasks_per_child` | Recycle children |
| Redis redelivery | `visibility_timeout` | Greater than longest task + ETA |

- `.delay()` only publishes a message; a separate worker process runs the code.
- Default ack is early (at-most-once); `acks_late` makes it at-least-once — there is no exactly-once delivery.
- `post_save` runs inside the transaction: dispatch from it via `on_commit`.
- Lambdas in loops capture the variable — use `partial`.
- Never call `AsyncResult.get()` inside a request or another task.
- Separate queues for latency-sensitive and bulk work.
- Beat schedules, workers execute; exactly one beat.
- Use an outbox when a lost task is unacceptable.

## 11. Hands-On Exercises

Setup: `python -m venv .venv && pip install "django~=5.2" "celery[redis]~=5.4"` and run Redis with `docker run -p 6379:6379 redis:7`.

1. **The commit race.** Write a view that creates an `Order` inside `atomic()`, calls `task.delay(order.pk)`, then `time.sleep(2)` before leaving the block. Watch the worker log `DoesNotExist`. Switch to `on_commit` and confirm it works.
2. **Lost vs duplicated.** Write a task that sleeps 30 s then writes a row. Start it, `kill -9` the worker child mid-sleep. Observe it is lost with default settings; enable `acks_late` + `task_reject_on_worker_lost` and observe redelivery.
3. **Make it idempotent.** Write `credit_account(account_id, amount, txn_id)` and run it three times with the same `txn_id`. Add a `ProcessedTransaction` model with a unique constraint so the balance changes once.
4. **Backoff.** Write a task that calls a fake API failing 3 times then succeeding; configure `autoretry_for` and `retry_backoff` and read the retry timings in the log.
5. **Queue isolation.** Route a 60-second `slow_report` task to a `reports` queue; flood it with 20 jobs and show that `send_email` on `default` still completes instantly.

**Mini project:** an image-upload pipeline. The upload view saves `Image` and dispatches on commit; a chord resizes to three widths in parallel and a callback marks the image ready; a beat task every 10 minutes re-enqueues images stuck in "processing" for more than 15 minutes; all tasks are idempotent; Flower shows the flow.

## 12. Related Topics & Free Learning Resources

- [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) — `atomic`, `on_commit`, `select_for_update`.
- [Ch 19 · Signals](topic.html?p=19-signals) — why signals run inside the transaction.
- [Ch 32 · Django Channels & Real-Time](topic.html?p=32-channels-websockets) — pushing task results to browsers.
- [Ch 33 · Testing Django Applications](topic.html?p=33-testing) — `captureOnCommitCallbacks`, mocking `.delay`.
- [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production) — running worker and beat processes.
- [Messaging · Delivery Guarantees](../messaging/topic.html?p=04-delivery-guarantees), [Messaging · Acks, Prefetch & QoS](../messaging/topic.html?p=08-acks-prefetch-qos), [Messaging · Idempotency & Outbox](../messaging/topic.html?p=21-idempotency-outbox).
- [System Design · Message Queues](../system-design/topic.html?p=23-message-queues).

- **First Steps with Django** — Celery docs · *Beginner* · the official wiring of `celery.py`, `autodiscover_tasks` and settings. <https://docs.celeryq.dev/en/stable/django/first-steps-with-django.html>
- **Tasks guide** — Celery docs · *Intermediate* · retries, acks_late, time limits and the "avoid launching synchronous subtasks" advice. <https://docs.celeryq.dev/en/stable/userguide/tasks.html>
- **Canvas: Designing Work-flows** — Celery docs · *Intermediate* · chain, group, chord and signatures in depth. <https://docs.celeryq.dev/en/stable/userguide/canvas.html>
- **Optimizing** — Celery docs · *Advanced* · prefetch limits, acks_late and worker tuning. <https://docs.celeryq.dev/en/stable/userguide/optimizing.html>
- **Database transactions** — Django docs · *Intermediate* · the exact semantics of `on_commit`. <https://docs.djangoproject.com/en/5.2/topics/db/transactions/>
- **django-celery-beat** — GitHub · *Intermediate* · database-backed periodic task schedules editable in the admin. <https://github.com/celery/django-celery-beat>
- **Flower** — GitHub · *Beginner* · real-time monitoring UI for Celery. <https://github.com/mher/flower>

---

*Django Handbook — chapter 31.*
