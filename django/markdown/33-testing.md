# 33 · Testing Django Applications

> **In one line:** Django's test classes buy speed by wrapping every test in a transaction that is rolled back — which is exactly why you must know when that isolation lies to you (on_commit callbacks, real commits, other threads) and why the most valuable assertions in a Django suite are about behaviour and query counts, not implementation details.

---

## 1. Overview

> **Builds on:** [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency), [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization), [Ch 22 · DRF Views, ViewSets & Routers](topic.html?p=22-drf-views-viewsets-routers), [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks).

Every Django project eventually hits the same wall: a refactor of a serializer silently adds 200 queries to a list endpoint, a migration breaks a data invariant, a Celery task fires for orders that were rolled back, and nobody notices until production. Tests are the only scalable defence, but naive tests are slow (each one recreating data from scratch), flaky (depending on test order or the clock), or worse, green while the real system is broken — because the test ran inside a transaction that never committed, so the code path that only runs on commit was never exercised.

Django ships a serious test framework on top of `unittest`. `manage.py test` creates a **separate test database** (your DB name prefixed with `test_`), runs migrations into it, discovers tests, and gives you a hierarchy of test classes with different isolation strategies: `SimpleTestCase` (no database at all), `TestCase` (each test inside a transaction that is rolled back — fast), `TransactionTestCase` (real commits, tables flushed after each test — slow but truthful), and `LiveServerTestCase` (a real HTTP server in a thread for browser tests). Around that you get the test `Client`, `RequestFactory`, `override_settings`, `mail.outbox`, and the assertion every senior Django engineer uses: `assertNumQueries`.

Most teams today run those same classes through **pytest-django**, add **factory_boy** for test data and **DRF's `APIClient`** for API tests. This chapter covers how each piece works internally, how to choose between them, and the testing questions interviewers ask: *TestCase vs TransactionTestCase*, *how do you test on_commit*, *how do you catch N+1 in CI*, *fixtures or factories*, *what do you mock and where*.

## 2. Core Concepts

- **Test database** — created at the start of a run (`test_<NAME>`), migrated, destroyed at the end (keep with `--keepdb`). *Why it matters:* tests never touch your dev data, but migrations run every time unless you keep the DB.
- **`SimpleTestCase`** — no database access allowed (queries raise an error). *Why:* fastest; for forms without models, utilities, URL resolution, templates.
- **`TestCase`** — wraps the class in an atomic block and each test in a nested atomic (savepoint) that is rolled back. *Why:* isolation without truncating tables — the default for nearly all tests.
- **`setUpTestData`** — classmethod run once per class inside the class-level transaction. *Why:* create shared data once instead of per test; since Django 3.2 instances assigned on `cls` are deep-copied for each test so in-memory mutations do not leak.
- **`TransactionTestCase`** — no wrapping transaction; tables are **flushed** (truncated) after each test. *Why:* the only way to test real commit behaviour, `select_for_update` across connections, or code that manages its own transactions.
- **`LiveServerTestCase` / `StaticLiveServerTestCase`** — starts a live server thread on a free port. *Why:* Selenium/Playwright tests; it is a `TransactionTestCase` because the server thread uses its own connection.
- **`captureOnCommitCallbacks`** — context manager on `TestCase` that captures (and optionally executes) `transaction.on_commit` callbacks. *Why:* inside `TestCase` the outer transaction never commits, so on_commit callbacks never run otherwise.
- **`assertNumQueries(n)`** — asserts exactly `n` queries were executed inside the block. *Why:* turns "no N+1" into a regression test.
- **Test `Client`** — simulates requests through the full stack (middleware, URLconf, views, templates) without a network. *Why:* integration-level tests of views; `force_login` skips authentication backends.
- **`RequestFactory`** — builds `HttpRequest` objects to call a view function directly; no middleware runs. *Why:* unit tests of view logic; you set `request.user` yourself.
- **`APIClient` / `APITestCase` / `APIRequestFactory`** — DRF equivalents with `force_authenticate`, JSON encoding by `format="json"`. *Why:* API tests without hand-building auth headers.
- **`override_settings` / `modify_settings`** — decorators/context managers that temporarily change settings and send `setting_changed`. *Why:* never mutate `settings` directly in tests.
- **Fixtures** — JSON/YAML dumps loaded via `fixtures = [...]`. *Why:* simple but brittle — they bypass `save()` and break silently when models change.
- **factory_boy** — Python factories (`DjangoModelFactory`, `SubFactory`, `Sequence`, `Faker`, traits). *Why:* data defined in code, refactors with the models, creates only what a test needs.
- **pytest-django** — pytest plugin: `@pytest.mark.django_db`, fixtures `client`, `rf`, `admin_client`, `settings`, `django_assert_num_queries`, `django_capture_on_commit_callbacks`, `--reuse-db`. *Why:* pytest's fixtures, parametrisation and output with Django's DB isolation.
- **Mocking** — `unittest.mock.patch("module.where.used.name")`. *Why:* isolate external services; patching the wrong import path is the number one mocking bug.

## 3. Theory & Principles

### How the test runner sets up

`manage.py test` instantiates `DiscoverRunner` (`TEST_RUNNER` setting). `run_tests()` does: `setup_test_environment()` (switches `EMAIL_BACKEND` to the locmem backend, so emails land in `django.core.mail.outbox`, and sets `ALLOWED_HOSTS` to include `testserver`), `build_suite()` (unittest discovery of `test*.py`), `setup_databases()` (for each alias in `DATABASES`, `connection.creation.create_test_db()` creates the test DB and runs `migrate`; with `--keepdb` it reuses it; with `--parallel` it clones it per worker process), runs the suite, then tears down. `DEBUG` is forced to `False` regardless of your settings (use `--debug-mode` to override), so tests see production-like error handling.

### How `TestCase` isolates tests

`TestCase.setUpClass` opens `transaction.atomic()` on every database the class uses (`databases = {"default"}` by default), then calls `setUpTestData()` *inside* that atomic. For each test method, `_fixture_setup` opens a *second*, nested atomic — a **savepoint** — runs `setUp`, the test, `tearDown`, and then rolls back to the savepoint. After the last test, the class-level atomic is rolled back too. Nothing is ever committed, so isolation costs one savepoint per test instead of truncating every table.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj33a" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">TestCase: one class transaction, one savepoint per test, nothing commits</text>
  <rect x="20" y="45" width="840" height="230" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="40" y="66" fill="#1e293b" font-weight="bold">setUpClass: BEGIN (class-level atomic)</text>
  <rect x="40" y="78" width="240" height="40" rx="6" fill="#ffffff" stroke="#94a3b8"/>
  <text x="160" y="96" text-anchor="middle" fill="#1e293b">setUpTestData()</text>
  <text x="160" y="111" text-anchor="middle" fill="#334155">cls.author = Author(...) once</text>
  <rect x="40" y="135" width="250" height="110" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="165" y="155" text-anchor="middle" fill="#1e293b" font-weight="bold">test_a: SAVEPOINT s1</text>
  <text x="165" y="175" text-anchor="middle" fill="#334155">setUp, test body, tearDown</text>
  <text x="165" y="193" text-anchor="middle" fill="#334155">writes rows, on_commit(cb)</text>
  <text x="165" y="215" text-anchor="middle" fill="#dc2626" font-weight="bold">ROLLBACK TO s1</text>
  <text x="165" y="233" text-anchor="middle" fill="#dc2626">cb never runs</text>
  <rect x="315" y="135" width="250" height="110" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="440" y="155" text-anchor="middle" fill="#1e293b" font-weight="bold">test_b: SAVEPOINT s2</text>
  <text x="440" y="175" text-anchor="middle" fill="#334155">sees setUpTestData rows</text>
  <text x="440" y="193" text-anchor="middle" fill="#334155">does NOT see test_a rows</text>
  <text x="440" y="215" text-anchor="middle" fill="#dc2626" font-weight="bold">ROLLBACK TO s2</text>
  <text x="440" y="233" text-anchor="middle" fill="#334155">cls.author deep-copied</text>
  <rect x="590" y="135" width="250" height="110" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="715" y="155" text-anchor="middle" fill="#1e293b" font-weight="bold">test_c: captureOnCommit</text>
  <text x="715" y="175" text-anchor="middle" fill="#334155">with self.captureOnCommitCallbacks(</text>
  <text x="715" y="191" text-anchor="middle" fill="#334155">execute=True) as cbs:</text>
  <text x="715" y="211" text-anchor="middle" fill="#16a34a" font-weight="bold">callbacks run on exit</text>
  <text x="715" y="231" text-anchor="middle" fill="#334155">assert len(cbs) == 1</text>
  <text x="40" y="265" fill="#1e293b" font-weight="bold">tearDownClass: ROLLBACK (class-level atomic)</text>
  <rect x="20" y="295" width="840" height="70" rx="10" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="40" y="317" fill="#1e293b" font-weight="bold">What TestCase cannot show you</text>
  <text x="40" y="337" fill="#334155">Real COMMIT behaviour, a second connection seeing your rows, select_for_update blocking another thread,</text>
  <text x="40" y="353" fill="#334155">code relying on durable commits. For those use TransactionTestCase (truncate after each test).</text>
</svg>
```

Three consequences follow, and interviewers probe all three:

1. **`transaction.on_commit` callbacks never fire** in a plain `TestCase`, because the outer transaction never commits. Since Django 3.2, `self.captureOnCommitCallbacks(execute=True)` collects callbacks registered inside the block and runs them when the block exits. Without it, a test of "order placement sends a receipt task" passes even if the dispatch is broken — or fails confusingly.
2. **Everything happens on one connection.** If your code opens a thread (or a live server, or `database_sync_to_async` in some setups) that uses a *different* connection, it cannot see uncommitted test data. Use `TransactionTestCase`.
3. **Durable blocks do not really commit.** `atomic(durable=True)` normally raises `RuntimeError` when nested; `TestCase` marks its own wrapping blocks so durable blocks are allowed inside them, but they still end in a rollback. Code whose correctness depends on the commit actually happening needs `TransactionTestCase`.

### How `TransactionTestCase` isolates tests

It does not wrap anything. Your code commits for real. After each test, `_fixture_teardown` calls the `flush` management command (TRUNCATE all tables on PostgreSQL), which is much slower — on the order of tens to hundreds of milliseconds per test depending on schema size, versus well under a millisecond for a savepoint rollback. Data created by migrations (e.g. a data migration that inserts default groups) is wiped by the flush; set `serialized_rollback = True` to have Django serialise the initial DB state and reload it after each flush. Django runs all `TestCase` subclasses before `TransactionTestCase` ones so a flush cannot damage expected state.

### How `assertNumQueries` works

`assertNumQueries(num, func=None, *args, using="default")` returns a `_AssertNumQueriesContext`, a subclass of `CaptureQueriesContext`. On enter, it sets `connection.force_debug_cursor = True` (so queries are recorded even though `DEBUG=False`) and remembers `len(connection.queries)`; on exit it computes the slice of `connection.queries_log` executed inside, and fails with the full list of SQL if the count differs. Savepoint statements are not counted. Because it captures the SQL, its failure message is also your best N+1 debugging tool. pytest-django exposes the same as `django_assert_num_queries` and `django_assert_max_num_queries`.

## 4. Architecture & Workflow

### Choosing the test class

The decision tree below is what you should reach for in an interview answer: start from the cheapest class and only pay for real commits when the behaviour under test needs them.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="dj33b" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#334155"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Which Django test class? Cheapest first</text>
  <rect x="330" y="40" width="220" height="40" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="440" y="65" text-anchor="middle" fill="#1e293b" font-weight="bold">Does the test touch the DB?</text>
  <rect x="40" y="120" width="220" height="60" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="150" y="143" text-anchor="middle" fill="#1e293b" font-weight="bold">SimpleTestCase</text>
  <text x="150" y="163" text-anchor="middle" fill="#334155">forms, utils, URLs, templates</text>
  <rect x="330" y="120" width="220" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="440" y="141" text-anchor="middle" fill="#1e293b" font-weight="bold">Needs real COMMIT or a</text>
  <text x="440" y="158" text-anchor="middle" fill="#1e293b" font-weight="bold">second connection/thread?</text>
  <rect x="40" y="220" width="300" height="100" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="190" y="243" text-anchor="middle" fill="#1e293b" font-weight="bold">TestCase (default choice)</text>
  <text x="190" y="263" text-anchor="middle" fill="#334155">savepoint rollback per test, fast</text>
  <text x="190" y="281" text-anchor="middle" fill="#334155">setUpTestData for shared rows</text>
  <text x="190" y="299" text-anchor="middle" fill="#334155">captureOnCommitCallbacks for on_commit</text>
  <rect x="400" y="220" width="200" height="50" rx="8" fill="#f1f5f9" stroke="#94a3b8"/>
  <text x="500" y="241" text-anchor="middle" fill="#1e293b" font-weight="bold">Needs a real browser /</text>
  <text x="500" y="258" text-anchor="middle" fill="#1e293b" font-weight="bold">HTTP server?</text>
  <rect x="400" y="300" width="200" height="80" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="500" y="323" text-anchor="middle" fill="#1e293b" font-weight="bold">TransactionTestCase</text>
  <text x="500" y="343" text-anchor="middle" fill="#334155">real commits, TRUNCATE after</text>
  <text x="500" y="361" text-anchor="middle" fill="#334155">locks, durable atomic, threads</text>
  <rect x="650" y="300" width="210" height="80" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="755" y="323" text-anchor="middle" fill="#1e293b" font-weight="bold">StaticLiveServerTestCase</text>
  <text x="755" y="343" text-anchor="middle" fill="#334155">server thread on a free port</text>
  <text x="755" y="361" text-anchor="middle" fill="#334155">Playwright / Selenium, slowest</text>
  <path d="M380,80 L200,118" stroke="#334155" stroke-width="2" marker-end="url(#dj33b)"/><text x="270" y="94" fill="#334155">no</text>
  <path d="M440,80 L440,118" stroke="#334155" stroke-width="2" marker-end="url(#dj33b)"/><text x="450" y="102" fill="#334155">yes</text>
  <path d="M400,170 L250,218" stroke="#334155" stroke-width="2" marker-end="url(#dj33b)"/><text x="300" y="190" fill="#334155">no</text>
  <path d="M470,170 L490,218" stroke="#334155" stroke-width="2" marker-end="url(#dj33b)"/><text x="490" y="195" fill="#334155">yes</text>
  <path d="M500,270 L500,298" stroke="#334155" stroke-width="2" marker-end="url(#dj33b)"/><text x="510" y="288" fill="#334155">no</text>
  <path d="M600,250 L740,298" stroke="#334155" stroke-width="2" marker-end="url(#dj33b)"/><text x="680" y="268" fill="#334155">yes</text>
</svg>
```

### Client vs RequestFactory vs calling the service

```text
                     middleware  URLconf  auth   templates  speed     use for
self.client.get()        yes       yes    yes      yes      medium    view integration tests
APIClient (DRF)          yes       yes    yes      n/a      medium    API contract tests
RequestFactory + view    no        no     manual   yes      fast      view logic in isolation
service function call    no        no     n/a      n/a      fastest   business rules (most tests)
```

A healthy suite puts most assertions on **service functions and model methods** (pure business logic, fast), a solid layer of **Client/APIClient** tests per endpoint (permissions, status codes, response shape, query count), and a thin layer of browser tests for critical flows.

### A typical CI pipeline

```text
1. pip install -r requirements.txt
2. python manage.py makemigrations --check --dry-run   # fail if models changed without a migration
3. python manage.py check --deploy --fail-level WARNING  (with prod-like settings)
4. pytest -n auto --reuse-db --cov=. --cov-report=xml    # or: manage.py test --parallel
5. coverage threshold gate; upload report
```

## 5. Implementation

### Simple example: models, views and the test client

```python
# library/tests/test_views.py
from django.test import TestCase
from django.urls import reverse
from library.models import Author, Book

class BookListViewTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        cls.author = Author.objects.create(name="Ursula")
        Book.objects.bulk_create(
            [Book(title=f"Book {i}", author=cls.author) for i in range(5)]
        )

    def test_lists_books(self):
        response = self.client.get(reverse("library:book-list"))
        self.assertEqual(response.status_code, 200)
        self.assertTemplateUsed(response, "library/book_list.html")
        self.assertContains(response, "Book 3")
        self.assertEqual(len(response.context["books"]), 5)

    def test_no_n_plus_one(self):
        # 1 query for books JOIN author (select_related), regardless of row count.
        # (Add 1-2 more if the view touches the session/user.)
        with self.assertNumQueries(1):
            self.client.get(reverse("library:book-list"))

    def test_create_requires_login(self):
        response = self.client.post(reverse("library:book-create"), {"title": "X"})
        self.assertRedirects(response, "/accounts/login/?next=/books/new/")
```

```bash
python manage.py test library --keepdb -v 2
python manage.py test library.tests.test_views.BookListViewTests.test_no_n_plus_one
python manage.py test --parallel auto --shuffle     # catch order-dependent tests
```

When the query count is wrong, the failure lists the SQL — the fastest way to see an N+1:

```text
AssertionError: 6 != 1 : 6 queries executed, 1 expected
Captured queries were:
1. SELECT "library_book"."id", "library_book"."title", "library_book"."author_id" FROM "library_book"
2. SELECT ... FROM "library_author" WHERE "library_author"."id" = 1 LIMIT 21
3. SELECT ... FROM "library_author" WHERE "library_author"."id" = 1 LIMIT 21
...
```

### Real-world example: an order API with factories, pytest, mocks and on_commit

```bash
pip install pytest pytest-django factory-boy pytest-xdist coverage
```

```ini
# pytest.ini
[pytest]
DJANGO_SETTINGS_MODULE = proj.settings.test
python_files = tests.py test_*.py
addopts = --reuse-db -p no:cacheprovider
```

```python
# proj/settings/test.py
from .base import *  # noqa

PASSWORD_HASHERS = ["django.contrib.auth.hashers.MD5PasswordHasher"]  # fast, tests only
CELERY_TASK_ALWAYS_EAGER = False      # we assert dispatch explicitly
CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
```

```python
# orders/tests/factories.py
import factory
from django.contrib.auth import get_user_model
from orders.models import Order, OrderItem, Product

class UserFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = get_user_model()
        skip_postgeneration_save = True

    username = factory.Sequence(lambda n: f"user{n}")
    email = factory.LazyAttribute(lambda o: f"{o.username}@example.com")
    password = factory.django.Password("pw")      # hashed via set_password

class ProductFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Product

    name = factory.Faker("word")
    price_cents = 1999
    stock = 10

class OrderFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = Order

    customer = factory.SubFactory(UserFactory)
    status = "pending"

    class Params:
        shipped = factory.Trait(status="shipped")

class OrderItemFactory(factory.django.DjangoModelFactory):
    class Meta:
        model = OrderItem

    order = factory.SubFactory(OrderFactory)
    product = factory.SubFactory(ProductFactory)
    quantity = 1
```

```python
# orders/tests/test_api.py
from unittest import mock

import pytest
from django.urls import reverse
from rest_framework.test import APIClient

from orders.models import Order, Product
from .factories import OrderFactory, OrderItemFactory, ProductFactory, UserFactory

pytestmark = pytest.mark.django_db

@pytest.fixture
def api():
    return APIClient()

@pytest.fixture
def user():
    return UserFactory()

def test_list_only_own_orders(api, user):
    OrderFactory.create_batch(3, customer=user)
    OrderFactory.create_batch(2)                      # someone else's
    api.force_authenticate(user)
    resp = api.get(reverse("order-list"))
    assert resp.status_code == 200
    assert resp.json()["count"] == 3

def test_list_query_count_is_constant(api, user, django_assert_num_queries):
    for _ in range(10):
        OrderItemFactory.create_batch(3, order=OrderFactory(customer=user))
    api.force_authenticate(user)
    # count + orders page + prefetch items + prefetch products = 4, for any N
    with django_assert_num_queries(4):
        api.get(reverse("order-list"))

def test_anonymous_gets_401(api):
    assert api.get(reverse("order-list")).status_code == 401

@pytest.mark.parametrize("qty,expected", [(1, 201), (10, 201), (11, 409)])
def test_place_order_stock_rules(api, user, qty, expected):
    product = ProductFactory(stock=10)
    api.force_authenticate(user)
    resp = api.post(reverse("order-list"),
                    {"items": [{"product": product.pk, "quantity": qty}]}, format="json")
    assert resp.status_code == expected

# Patch where the name is LOOKED UP (orders.services imports the task), not where defined.
@mock.patch("orders.services.send_receipt.delay")
def test_receipt_dispatched_after_commit(delay, api, user, django_capture_on_commit_callbacks):
    product = ProductFactory()
    api.force_authenticate(user)
    with django_capture_on_commit_callbacks(execute=True) as callbacks:
        resp = api.post(reverse("order-list"),
                        {"items": [{"product": product.pk, "quantity": 1}]}, format="json")
    assert resp.status_code == 201
    assert len(callbacks) == 1
    delay.assert_called_once_with(resp.json()["id"])

@mock.patch("orders.services.send_receipt.delay")
def test_no_receipt_when_order_fails(delay, api, user, django_capture_on_commit_callbacks):
    product = ProductFactory(stock=0)
    api.force_authenticate(user)
    with django_capture_on_commit_callbacks(execute=True):
        api.post(reverse("order-list"),
                 {"items": [{"product": product.pk, "quantity": 1}]}, format="json")
    delay.assert_not_called()
    assert not Order.objects.exists()
```

### Testing the Celery task itself

```python
# orders/tests/test_tasks.py
from unittest import mock
import pytest
import requests
from orders.tasks import send_receipt
from .factories import OrderFactory

pytestmark = pytest.mark.django_db

@mock.patch("orders.tasks.email_client.send")
def test_send_receipt_is_idempotent(send):
    order = OrderFactory()
    send_receipt(order.pk)            # call the function body directly
    send_receipt(order.pk)            # duplicate delivery
    send.assert_called_once()
    order.refresh_from_db()
    assert order.receipt_sent_at is not None

@mock.patch("orders.tasks.email_client.send", side_effect=requests.Timeout)
def test_send_receipt_retries_on_timeout(send):
    order = OrderFactory()
    result = send_receipt.apply(args=[order.pk])   # runs locally, honours retry logic
    assert result.state in {"RETRY", "FAILURE"}
```

### Testing real concurrency with `TransactionTestCase`

```python
# orders/tests/test_concurrency.py
import threading
from django.db import connection
from django.test import TransactionTestCase
from orders.services import reserve_stock
from orders.models import Product

class ReserveStockConcurrencyTests(TransactionTestCase):
    def test_no_oversell_under_concurrency(self):
        product = Product.objects.create(name="x", price_cents=1, stock=1)
        results = []

        def worker():
            try:
                results.append(reserve_stock(product.pk, 1))   # select_for_update inside
            finally:
                connection.close()        # each thread has its own connection

        threads = [threading.Thread(target=worker) for _ in range(5)]
        for t in threads: t.start()
        for t in threads: t.join()

        product.refresh_from_db()
        self.assertEqual(product.stock, 0)
        self.assertEqual(results.count(True), 1)
```

Under `TestCase` this test would hang or fail: the product row is created inside the test's uncommitted transaction, and the threads' separate connections cannot see it.

### RequestFactory, settings overrides and email

```python
from django.core import mail
from django.test import RequestFactory, TestCase, override_settings
from accounts.views import profile
from .factories import UserFactory

class ProfileViewTests(TestCase):
    def test_view_logic_without_middleware(self):
        request = RequestFactory().get("/profile/")
        request.user = UserFactory()          # no AuthenticationMiddleware here
        response = profile(request)
        self.assertEqual(response.status_code, 200)

    @override_settings(FEATURE_NEW_SIGNUP=True)
    def test_feature_flag(self):
        ...

    def test_password_reset_sends_email(self):
        UserFactory(email="a@example.com")
        self.client.post("/accounts/password_reset/", {"email": "a@example.com"})
        self.assertEqual(len(mail.outbox), 1)
        self.assertIn("password", mail.outbox[0].subject.lower())
```

### Testing a Channels consumer

```python
import pytest
from channels.testing import WebsocketCommunicator
from proj.asgi import application

@pytest.mark.asyncio
@pytest.mark.django_db(transaction=True)
async def test_chat_echo(settings):
    settings.CHANNEL_LAYERS = {"default": {"BACKEND": "channels.layers.InMemoryChannelLayer"}}
    comm = WebsocketCommunicator(application, "/ws/chat/lobby/",
                                 headers=[(b"origin", b"http://testserver")])
    connected, _ = await comm.connect()
    assert connected
    await comm.send_json_to({"text": "hi"})
    assert (await comm.receive_json_from())["text"] == "hi"
    await comm.disconnect()
```

## 6. Advantages, Disadvantages & Trade-offs

| Tool | Speed | Realism | Best for | Watch out |
|---|---|---|---|---|
| `SimpleTestCase` | fastest | no DB | forms, utils, URL resolution | DB queries raise |
| `TestCase` | fast | single connection, no commit | 90% of tests | on_commit, threads, real commits |
| `TransactionTestCase` | slow (truncate) | real commits | locking, concurrency, durable atomics | wipes migration data unless `serialized_rollback` |
| `LiveServerTestCase` + browser | slowest | full stack | critical user journeys | flaky waits, keep few |
| JSON fixtures | fast to load | frozen data | small reference data | bypass `save()`, break on schema change |
| factory_boy | fast enough | data per test | almost everything | SubFactory chains create hidden rows |
| `CELERY_TASK_ALWAYS_EAGER` | fast | low | quick smoke tests | hides serialization and on_commit bugs |
| Mocks | fast | depends | external services | over-mocking tests the mock, not the code |

### When to use

- `TestCase` + factories + `APIClient` as the default stack.
- `assertNumQueries` on every list endpoint and every admin changelist you care about.
- `TransactionTestCase` for code that relies on commits, row locks across connections, or `on_commit` with real commits.
- Mock at the boundary: HTTP clients, payment SDKs, email providers, the clock (`time-machine`/`freezegun`).

### When NOT to use

- Do not mock the ORM: a test with `mock.patch("Order.objects.filter")` proves nothing about your SQL. Use the test database.
- Do not use SQLite in tests when production is PostgreSQL if you rely on Postgres features (JSONField lookups, `select_for_update`, constraints, `DISTINCT ON`).
- Do not reach for `TransactionTestCase` "just in case" — it can multiply suite time.
- Do not snapshot entire HTML pages; assert on the behaviour that matters.

## 7. Common Mistakes & Best Practices

**Testing on_commit code in `TestCase` without capturing callbacks.** The task dispatch silently never runs; tests pass while production breaks (or vice versa). Use `captureOnCommitCallbacks(execute=True)`.

**Patching the wrong path.** `mock.patch("orders.tasks.send_receipt")` does nothing if `orders.services` did `from orders.tasks import send_receipt` — the name is already bound in `services`. Patch `orders.services.send_receipt`.

**Creating data in `setUp` for every test.** Fifty tests × ten factory objects is five hundred inserts. Move shared data to `setUpTestData`. Do not mutate class data in a test expecting the change to persist — each test gets a deep copy.

**Fixtures as the main test data strategy.** A JSON fixture with 400 objects breaks every time a field is added, loads data that tests do not need, and hides which data a test depends on. Use factories; keep fixtures for small static reference data.

**Asserting implementation instead of behaviour.** `assert serializer.validate_email.called` couples the test to structure. Assert status code, response body, DB state, side effects.

**Order-dependent tests.** A test that only passes because a previous one created a user. Run `--shuffle` (Django 4.0+) or `pytest-randomly` in CI.

**Time-dependent tests.** `timezone.now()` near midnight or month end flips results. Freeze time with `time-machine`.

**Slow password hashing.** Every `create_user` with PBKDF2 at around a million iterations costs real time. Use `MD5PasswordHasher` in test settings only.

**Real network calls.** A test that hits Stripe sandbox is slow and flaky. Mock the client or use `responses`/`respx`; add a separate, opt-in contract test suite.

**Best practices**

- Name tests by behaviour: `test_shipped_orders_cannot_be_cancelled`.
- One factory per model, sensible defaults, traits for states.
- `makemigrations --check` in CI so missing migrations fail the build.
- Measure coverage but gate on critical modules, not a global vanity number.
- Keep the suite fast enough to run before every push; parallelise with `--parallel` or `pytest -n auto`.

## 8. Production: Pitfalls, Debugging & Scaling

> **Production story:** A list endpoint went from 120 ms to 9 s after a "harmless" serializer change that added a nested `owner.profile.avatar_url`. The test suite had full coverage of the endpoint but only created two objects per test, so the extra queries were invisible. Fix: an `assertNumQueries` test with 20 objects for every list endpoint, so any query that scales with rows fails CI.

**Suite slowed from 3 to 25 minutes.** Root causes, in order of frequency: migrations running on every run (use `--keepdb` / `--reuse-db`), `TransactionTestCase` overuse, data created in `setUp` instead of `setUpTestData`, slow password hashers, real network calls. Profile with `pytest --durations=20`.

**Flaky tests in CI only.** Usually parallelism (tests sharing a cache, file paths or a Redis DB across workers), time zones, or ordering. Give each worker its own cache key prefix, use `tmp_path`, freeze time, run with `--shuffle` locally to reproduce.

**Tests pass with SQLite, prod fails on PostgreSQL.** SQLite ignores `max_length`, has different `LIKE` case rules, weaker type enforcement and limited locking. Run CI on the same PostgreSQL major version (a service container) — see [Docker · Compose](../docker/topic.html?p=18-compose).

**`Database access not allowed` in pytest.** The test is missing `@pytest.mark.django_db` (or `pytestmark`). For tests using threads or async consumers, use `django_db(transaction=True)`.

**Migrations untested.** Data migrations break on real data shapes. Use `django-test-migrations` (or a `TransactionTestCase` that migrates to a previous state with `MigrationExecutor`, inserts rows, migrates forward and asserts), and run `migrate` against a production snapshot in staging.

**Debugging tools**

- `manage.py test --debug-sql` prints SQL for failing tests; `--pdb` drops into the debugger on failure.
- `CaptureQueriesContext(connection)` to print queries in an ad-hoc test.
- `pytest -x --lf` re-runs only last failures; `-k pattern` selects tests.
- `coverage run -m pytest && coverage html` to find untested branches.

**Scaling the suite.** Parallelise by process (`--parallel`, `pytest-xdist`); Django clones the test DB per worker. Split slow browser tests into a separate CI job. Tag tests (`@tag("slow")`, `--exclude-tag slow`) for fast local runs.

## 9. Interview Questions

**Q: What is the difference between `TestCase` and `TransactionTestCase`?**
A: `TestCase` wraps the whole class in a transaction and each test in a savepoint, rolling back after every test, so isolation is cheap and tests are fast. `TransactionTestCase` does not wrap tests; code commits for real and Django truncates all tables after each test, which is slower. You need `TransactionTestCase` when the behaviour depends on a real commit: `on_commit` with actual commits, other connections or threads seeing the data, `select_for_update` contention, or code managing its own transactions. Everything else should use `TestCase`.

**Q: Why don't `transaction.on_commit` callbacks run in a `TestCase`, and how do you test them?**
A: Because the test's outer transaction is always rolled back, so the commit that would trigger the callbacks never happens. Since Django 3.2, `TestCase.captureOnCommitCallbacks(execute=True)` captures callbacks registered inside the `with` block and executes them on exit; it also returns the list so you can assert how many were registered. pytest-django offers `django_capture_on_commit_callbacks`. Alternatively use `TransactionTestCase`, where commits are real, at the cost of speed.

**Q: What is `setUpTestData` and how is it different from `setUp`?**
A: `setUpTestData` is a classmethod that runs once per test class inside the class-level transaction, so data is created once and shared by all tests in the class. `setUp` runs before every test. Since Django 3.2, model instances assigned to `cls` in `setUpTestData` are deep-copied for each test, so a test mutating `self.author` in memory does not affect other tests; database changes are rolled back by the per-test savepoint anyway. Using `setUpTestData` for shared data is one of the biggest speed wins in a Django suite.

**Q: How do you catch N+1 queries in tests?**
A: Wrap the request in `self.assertNumQueries(n)` (or pytest-django's `django_assert_num_queries`) with enough rows that a per-row query would change the count — at least a handful, ideally more than the page size you care about. The assertion records queries via `CaptureQueriesContext` and on failure prints every SQL statement, which shows the repeated query. A good pattern asserts the same count for 2 rows and 20 rows. This turns "we optimised with `select_related`" into a regression test that fails CI when someone adds a nested serializer field.

**Q: What is the difference between the test `Client` and `RequestFactory`?**
A: The `Client` sends a simulated request through the full Django stack — middleware, URL resolution, the view, templates — and returns the response with extras like `response.context` and `templates`. `RequestFactory` only builds an `HttpRequest`; you call the view function directly, and no middleware runs, so you must attach `request.user`, sessions or messages yourself. Use the `Client` for integration tests of endpoints and `RequestFactory` for fast unit tests of view logic or middleware.

**Q: Fixtures or factory_boy — which do you prefer and why?**
A: Factories, for almost everything. JSON fixtures are static dumps loaded via `loaddata`: they bypass `save()` and signals, break when a field is added, load more data than each test needs, and hide which data a test depends on. Factories define data in Python, so they refactor with your models, each test creates exactly what it needs with explicit overrides, and traits express states like `shipped=True`. Fixtures remain fine for small, stable reference data such as countries.

**Q: How do you mock an external API call in a Django test, and what is the classic mistake?**
A: Use `unittest.mock.patch` on the name as it is looked up by the code under test, e.g. `@mock.patch("orders.services.stripe_client.charge")`, or HTTP-level mocking with `responses`/`respx`. The classic mistake is patching where the object is defined instead of where it is imported: if `services.py` did `from payments.client import charge`, patching `payments.client.charge` has no effect on the already-bound name. Also avoid mocking the ORM — use the test database so the SQL is real.

**Q: How do you test DRF APIs with authentication?**
A: Use `rest_framework.test.APIClient` (or `APITestCase`) and call `client.force_authenticate(user=user)` to bypass the authentication classes, or `client.credentials(HTTP_AUTHORIZATION="Bearer ...")` when you want to test the auth path itself. Send JSON with `format="json"`. Assert status codes for anonymous, unauthorised and authorised users, response shape, DB state and query count. For unit-testing a view, `APIRequestFactory` plus `force_authenticate(request, user=user)` works without the URLconf.

**Q: How do you test Celery tasks?**
A: Test the task body directly as a function call (or `task.apply()` to run it locally with retry semantics) with external services mocked, and assert idempotency by calling it twice. Test dispatch separately: mock `task.delay` at the import path the code uses and assert it was called inside `captureOnCommitCallbacks(execute=True)`, plus a negative test that a failing transaction does not dispatch. `CELERY_TASK_ALWAYS_EAGER` is convenient but hides serialization errors (passing a model instance works eagerly) and on_commit ordering, so it should not be your only coverage.

**Q: Your test suite takes 30 minutes. How do you bring it under 5? (Senior)**
A: Measure first with `pytest --durations=50` to find the slowest tests and fixtures. Common wins: reuse the test database (`--keepdb`/`--reuse-db`) so migrations do not run each time, move shared data from `setUp` to `setUpTestData`, use the MD5 password hasher in tests, replace real network calls with mocks, and convert unnecessary `TransactionTestCase` classes to `TestCase` with `captureOnCommitCallbacks`. Then parallelise with `--parallel` or `pytest -n auto`, ensuring workers do not share caches or files. Finally split browser and slow integration tests into a separate CI job, and keep the fast suite runnable locally.

**Q: How would you test that your stock-reservation code cannot oversell under concurrency? (Senior)**
A: A `TestCase` cannot do it, because all code shares one uncommitted connection and other threads cannot see the data. Use `TransactionTestCase`: create a product with stock 1, start several threads that each call the reservation service (which uses `select_for_update()` or a conditional `UPDATE ... WHERE stock >= qty`), close each thread's connection at the end, join, and assert exactly one success and stock zero. Run it against PostgreSQL, not SQLite, because locking semantics differ. Add a deterministic unit test for the conditional update as well, since thread tests can be timing-sensitive.

**Q: How do you test a data migration safely? (Senior)**
A: Test it against migration state rather than current models: use a `TransactionTestCase` (or `django-test-migrations`) that migrates to the migration before yours with `MigrationExecutor`, gets historical models from the resulting state via `apps.get_model`, inserts representative rows, migrates forward to your migration, and asserts the transformed data. Also test the reverse if you wrote one. In CI run `makemigrations --check` to catch missing migrations, and in staging run the full migration against a production-sized snapshot to measure lock duration and runtime — correctness on ten rows says nothing about a 50-million-row table.

**Q: What does `override_settings` do and why not just assign to `settings`?**
A: `override_settings` (decorator or context manager) temporarily replaces settings for the test and restores them afterwards, and it sends the `setting_changed` signal so Django clears caches that depend on settings (template engines, static storage, password hashers and others). Assigning `settings.FOO = ...` directly leaks the change into later tests and skips those cache resets, causing order-dependent failures. pytest-django's `settings` fixture does the same thing with automatic restore.

## 10. Quick Revision & Cheat Sheet

| Need | Use |
|---|---|
| No DB | `SimpleTestCase` |
| Normal DB test | `TestCase` + `setUpTestData` |
| Real commits / threads / locks | `TransactionTestCase` |
| Browser | `StaticLiveServerTestCase` + Playwright |
| on_commit in TestCase | `self.captureOnCommitCallbacks(execute=True)` |
| N+1 regression | `assertNumQueries(n)` / `django_assert_num_queries` |
| Full-stack request | `self.client`, `APIClient` |
| View in isolation | `RequestFactory` / `APIRequestFactory` |
| Auth shortcut | `client.force_login(u)`, `api.force_authenticate(u)` |
| Settings | `@override_settings`, pytest `settings` fixture |
| Email | `django.core.mail.outbox` |
| Test data | factory_boy `DjangoModelFactory`, `SubFactory`, traits |
| Speed | `--keepdb`, `--parallel`, MD5 hasher |

- `TestCase` never commits: on_commit callbacks need capturing.
- Other threads/connections cannot see `TestCase` data.
- `TransactionTestCase` truncates tables — and migration-created data with them.
- Patch where the name is used, not where it is defined.
- Do not mock the ORM; do mock the network.
- Assert query counts with more rows than you think you need.
- Run tests on the same database engine as production.
- `makemigrations --check` in CI.

## 11. Hands-On Exercises

Setup: `python -m venv .venv && pip install "django~=5.2" pytest pytest-django factory-boy djangorestframework`.

1. **Isolation.** Write two `TestCase` tests that each create a `User` with the same username and show both pass. Then write a test that creates a row and reads it from a new thread — watch it fail — and convert the class to `TransactionTestCase`.
2. **N+1 guard.** Build a `Book` list view that loops `book.author.name`. Write an `assertNumQueries` test with 10 books, read the failure output, fix with `select_related`, and watch it pass.
3. **on_commit.** Write a service that creates an order and dispatches a mocked task on commit. Show a plain `TestCase` never sees the call; fix with `captureOnCommitCallbacks(execute=True)`.
4. **Factories.** Replace a JSON fixture with factory_boy factories including a `SubFactory` and a `Trait`; measure the suite time difference.
5. **Mock path.** Deliberately patch the wrong import path for an external client and observe the real function being called; fix the path.
6. **Speed.** Time the suite, then add `--keepdb`, the MD5 hasher and `setUpTestData`; record the improvement.

**Mini project:** a fully tested order API — factories for all models, permission matrix tests (anonymous/owner/other/staff) with `pytest.mark.parametrize`, query-count tests for list and detail endpoints, an on_commit dispatch test, an idempotent Celery task test, a `TransactionTestCase` oversell test, and a GitHub Actions workflow with a PostgreSQL service container and `makemigrations --check`.

## 12. Related Topics & Free Learning Resources

- [Ch 13 · QuerySet Optimization & the N+1 Problem](topic.html?p=13-queryset-optimization) — what `assertNumQueries` protects.
- [Ch 14 · Transactions, Locking & Race Conditions](topic.html?p=14-transactions-concurrency) — why TestCase isolation works and where it lies.
- [Ch 31 · Background Tasks with Celery](topic.html?p=31-celery-background-tasks) — idempotent tasks and on_commit dispatch.
- [Ch 32 · Django Channels & Real-Time](topic.html?p=32-channels-websockets) — `WebsocketCommunicator`.
- [Ch 11 · Migrations](topic.html?p=11-migrations) — testing data migrations.
- [Ch 35 · Deployment & Production Operations](topic.html?p=35-deployment-production) — CI/CD pipeline.
- [REST API · Testing REST APIs](../rest-api/topic.html?p=36-testing-rest-apis), [REST API · Mocking, Stubs & Sandboxes](../rest-api/topic.html?p=37-mocking-stubs-sandboxes), [Docker · CI/CD](../docker/topic.html?p=26-ci-cd).

- **Testing in Django** — Django docs · *Beginner* · overview, test runner, test database and the test class hierarchy. <https://docs.djangoproject.com/en/5.2/topics/testing/>
- **Testing tools** — Django docs · *Intermediate* · Client, RequestFactory, TestCase features, `captureOnCommitCallbacks`, `assertNumQueries`. <https://docs.djangoproject.com/en/5.2/topics/testing/tools/>
- **DRF Testing** — Django REST framework · *Intermediate* · APIClient, APIRequestFactory, force_authenticate. <https://www.django-rest-framework.org/api-guide/testing/>
- **pytest-django documentation** — pytest-django · *Intermediate* · `django_db` marker, fixtures, `--reuse-db`. <https://pytest-django.readthedocs.io/>
- **factory_boy documentation** — factory_boy · *Intermediate* · DjangoModelFactory, SubFactory, traits, post-generation hooks. <https://factoryboy.readthedocs.io/>
- **unittest.mock — where to patch** — Python docs · *Intermediate* · the official explanation of patching the lookup location. <https://docs.python.org/3/library/unittest.mock.html#where-to-patch>
- **Coverage.py** — coverage.py docs · *Beginner* · measuring line and branch coverage. <https://coverage.readthedocs.io/>

---

*Django Handbook — chapter 33.*
