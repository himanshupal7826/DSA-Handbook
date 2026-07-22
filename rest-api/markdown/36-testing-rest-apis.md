# 36 · Testing REST APIs

> **In one line:** An API test suite is a pyramid — fast unit tests for logic, integration tests that drive real HTTP against a real database, contract tests that pin the boundary with consumers, and a thin layer of end-to-end smoke — and the whole thing is only as valuable as what you actually assert.

---

## 1. Overview

An API is a *contract expressed over HTTP*. That contract has far more surface than the JSON body everyone thinks about: the status code, the response headers (`Location`, `ETag`, `Cache-Control`, `Retry-After`, `Content-Type`), the error format, the pagination shape, the idempotency behaviour under retry, and the side effects on your database and message bus. A test suite that only checks `response.json()["id"] == 1` verifies perhaps a fifth of what you promised. When the outage comes, it will come from the four-fifths you did not assert.

The problem testing solves is *change with confidence*. APIs are the most change-averse code you own — you cannot recall a client, and every consumer is a stranger with an old SDK. Without tests, "add a field" becomes a two-week regression hunt and "rename a field" becomes an incident. With a good suite, you can refactor the persistence layer at 4 p.m. on a Thursday. The lineage here is Mike Cohn's **test pyramid** (*Succeeding with Agile*, 2009) and Martin Fowler's later refinements — many fast isolated tests at the base, fewer slower integrated tests above, a handful of end-to-end tests at the tip — plus the **consumer-driven contract** idea popularised by Pact, which fixes the specific problem the pyramid leaves open: how do you know the *other* service still agrees with you, without booting both?

The classic failure mode is the **ice-cream cone**: a huge pile of slow, flaky, browser-or-full-stack end-to-end tests and almost no unit or integration coverage. It feels thorough and behaves terribly — a 40-minute CI run, a 6% flake rate, and developers who re-run the build rather than read the failure. The opposite failure is the **hourglass**: lots of unit tests, lots of E2E, nothing in the middle, so every wiring bug (a missing route, a wrong serializer, a broken transaction boundary) escapes to production. The middle layer — integration tests that make real HTTP calls to your app with a real database — is where the value density is highest for a REST API, and it is exactly the layer most teams under-invest in.

A concrete example. **Stripe** publishes idempotency semantics: re-sending `POST /v1/charges` with the same `Idempotency-Key` returns the original response and does not double-charge. That is a promise you can only verify with an integration test that issues the request twice against a real store and asserts both the identical response body *and* that exactly one row exists. A unit test on the handler cannot see the database; an E2E test through three services is too slow to run per-commit. Likewise **GitHub's** conditional requests: `GET /repos/x/y` with `If-None-Match: "abc"` must return `304` with no body and not consume rate-limit budget. Assert the status, the absent body, the `ETag`, and the `X-RateLimit-Remaining` header — one test, four assertions, a whole class of bugs closed.

This chapter is the practical build-out: what each layer tests, how to make integration tests fast and deterministic with transactional fixtures, exactly what to assert on a response, how to validate against your OpenAPI document instead of hand-writing schema checks, how to test auth and error paths that nobody remembers, and how to wire the whole thing into CI without it becoming the slowest part of your day.

---

## 2. Core Concepts

- **Test pyramid** — a shape heuristic: many fast, isolated tests; fewer integrated ones; very few end-to-end. Optimises total feedback time and failure-localisation, not raw coverage.
- **Unit test** — exercises one function or class with collaborators replaced by fakes. Milliseconds, no I/O, no HTTP. Tests *logic*: pricing rules, validators, cursor encoding.
- **Integration test** — drives the real application over HTTP (in-process test client or a live port) against real infrastructure (a real database, often containerised). Tests *wiring and behaviour*.
- **Contract test** — verifies that the API's shape matches what consumers expect, without running both sides together. Either consumer-driven (Pact) or schema-driven (validate responses against the OpenAPI document).
- **End-to-end (E2E) test** — exercises a full deployed environment across service boundaries. Slowest, flakiest, highest fidelity. Keep it to critical user journeys.
- **Test double** — a stand-in: a *stub* returns canned data, a *mock* asserts on interactions, a *fake* is a working lightweight implementation (in-memory repo), a *spy* records calls.
- **Fixture** — reusable setup/teardown for a test. In pytest, a function decorated `@pytest.fixture` with a scope (`function`, `module`, `session`) and cleanup after `yield`.
- **Transactional test** — each test runs inside a database transaction rolled back at the end, giving perfect isolation without truncating tables.
- **Test data builder** — a factory with sane defaults and per-test overrides (`make_invoice(status="void")`) so tests state only what they care about.
- **Flaky test** — a test that passes and fails on identical code. Almost always caused by time, ordering, shared state, network, or concurrency.
- **Snapshot / approval test** — asserts a response matches a stored golden file, with an explicit review step when it changes. Cheap for large payloads, worthless when the diff is rubber-stamped.

---

## 3. Theory & Principles

**Why the pyramid shape, precisely.** Two costs drive it. First, **runtime**: a unit test is ~1 ms, an in-process integration test with a database is ~5–50 ms, a networked E2E test is ~1–10 s. A suite's cost is the product of count and duration, and CI feedback time governs how often developers run it — past ~10 minutes, people stop. Second, **failure localisation**: when a unit test fails you know the function; when an E2E test fails you know *something in the system* broke, and diagnosis costs an hour. Third, and less discussed, **flake probability compounds**. If each of `n` sequential steps has independent success probability `p`, the test passes with probability `p^n`. At `p = 0.999` and `n = 30` steps, that is 97% — a 3% flake rate, which on a 200-test suite means roughly six red builds a day for no reason. E2E tests have large `n`; that is the whole story.

**The corollary for APIs.** The generic pyramid says "integration tests are expensive, minimise them". For a REST API that advice is wrong, because your product *is* the HTTP boundary. Most defects live in serialization, routing, validation, transaction boundaries, auth middleware and status-code selection — none of which unit tests can see. The API-shaped pyramid is squatter: a solid base of unit tests for pure logic, a **very wide integration layer** driving real HTTP against a real database (fast, because it is in-process), a contract layer that is nearly free once you have an OpenAPI document, and a genuinely thin E2E tip.

**Test doubles and the cost of fidelity.** Every double you insert buys speed and determinism and sells fidelity. Mocking your own database is almost always wrong — you end up asserting that your code calls the ORM the way you wrote it, which is a tautology, and you miss constraint violations, transaction semantics and SQL errors. Use a real Postgres (Testcontainers, or a service container in CI). Conversely, mocking *third-party* HTTP is almost always right: you cannot afford Stripe's latency, flakiness or rate limits in CI. Mock at the HTTP layer (`respx`, `responses`, `nock`, WireMock) rather than by stubbing your own client class, so you still test your serialization and error handling — and pair it with a nightly contract test against the real sandbox so your mock cannot silently drift.

**Determinism as a design property.** Flakiness is not bad luck, it is coupling to something you did not control. The four sources, and their fixes: **time** (inject a clock; freeze it with `freezegun`; never assert on `datetime.now()`), **randomness** (seed it, or inject the id generator), **ordering** (never let test A's rows be visible to test B; run with `-p no:randomly` disabled so ordering bugs surface rather than hide), and **concurrency/async** (await everything; do not sleep, poll with a bounded deadline). A test that needs `sleep(2)` to pass is a test that will fail on a loaded CI runner.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="340" fill="#ffffff"/>
  <text x="18" y="26" font-size="15" font-weight="700" fill="#1e293b">The API test pyramid: cost, count and what each layer catches</text>

  <polygon points="300,48 372,48 452,110 220,110" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="308" y="72" font-size="12" font-weight="700" fill="#1e293b">E2E</text>
  <text x="256" y="94" font-size="10" fill="#1e293b">5&#8211;20 tests &#183; seconds each</text>

  <polygon points="220,116 452,116 500,172 172,172" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="228" y="140" font-size="12" font-weight="700" fill="#1e293b">Contract</text>
  <text x="228" y="160" font-size="10" fill="#1e293b">every endpoint validated against the OpenAPI document</text>

  <polygon points="172,178 500,178 556,240 116,240" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="180" y="202" font-size="12" font-weight="700" fill="#1e293b">Integration (widest layer for an API)</text>
  <text x="180" y="222" font-size="10" fill="#1e293b">real HTTP + real Postgres, in&#8209;process, 5&#8211;50 ms &#183; routing, auth, tx, status codes</text>

  <polygon points="116,246 556,246 612,314 60,314" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="124" y="270" font-size="12" font-weight="700" fill="#1e293b">Unit</text>
  <text x="124" y="290" font-size="10" fill="#1e293b">pure logic: pricing, validators, cursor encode/decode, retry policy</text>
  <text x="124" y="306" font-size="10" fill="#1e293b">~1 ms each, no I/O, hundreds of them</text>

  <text x="628" y="72" font-size="11" font-weight="700" fill="#1e293b">fidelity</text>
  <text x="628" y="300" font-size="11" font-weight="700" fill="#1e293b">speed</text>
  <line x1="660" y1="290" x2="660" y2="80" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="660,72 655,82 665,82" fill="#4f46e5"/>
  <text x="672" y="190" font-size="10" fill="#1e293b">flake risk</text>
  <text x="672" y="206" font-size="10" fill="#1e293b">rises with n</text>
</svg>
```

**What "coverage" does and does not mean.** Line coverage tells you which lines executed, not whether you asserted anything about them. A suite can hit 90% coverage and assert only status codes. Better signals: **branch coverage on error paths**, an explicit checklist that every documented status code has a test, and mutation testing (`mutmut`, `Stryker`) on the modules where correctness matters — it answers "would my tests notice if this code were wrong?", which is the actual question.

---

## 4. Architecture & Workflow

How a single integration test executes, and how the layers compose in CI:

1. **Session start.** A session-scoped fixture starts Postgres — via Testcontainers, `docker compose`, or a CI service container — and waits for readiness with a bounded poll (never a fixed `sleep`).
2. **Schema creation.** Run your real migrations (`alembic upgrade head`) once per session against the test database. Running migrations rather than `metadata.create_all()` means you also test that migrations work.
3. **Engine and app.** Build a SQLAlchemy engine, then instantiate the FastAPI app with `app.dependency_overrides[get_db]` pointed at the test session factory. The app object is otherwise the production one — no test-only branches inside application code.
4. **Per-test transaction.** A function-scoped fixture opens a connection, begins a transaction, binds a session to it, and yields. Everything the test and the application do lands inside that transaction.
5. **Arrange.** The test seeds state through builders (`make_tenant()`, `make_invoice(status="open")`) rather than raw SQL, so schema changes break one factory instead of forty tests.
6. **Act.** The test issues a real HTTP request through `TestClient` (Starlette/`httpx`) — the full ASGI stack runs: middleware, auth dependency, routing, validation, serialization. No network socket, so it is fast.
7. **Assert — four dimensions.** Status code; headers (`Location`, `ETag`, `Content-Type`, `Cache-Control`); body (specific fields plus schema validation); and **side effects** (rows written, events published, outbound calls recorded by the HTTP mock).
8. **Rollback.** The fixture rolls the transaction back on teardown. The next test starts from an identical, empty state — no truncation, no ordering dependence, and tests can run in parallel against separate connections.
9. **Contract layer.** A parametrised test walks every path/method/status in the OpenAPI document, exercises it, and validates the response against the declared schema. A response with an undocumented field or a missing required one fails the build.
10. **CI orchestration.** Stage 1 runs lint + unit tests (seconds) and fails fast. Stage 2 runs integration + contract tests in parallel shards with a Postgres service. Stage 3, post-deploy to staging, runs the thin E2E smoke suite plus a schema-diff check against the previously published OpenAPI document to catch breaking changes (chapter 32).
11. **Reporting.** Publish JUnit XML, coverage and a flaky-test report. Quarantine — do not delete — a test that flakes twice, and treat the quarantine list as a bug backlog with an owner.

```svg
<svg viewBox="0 0 800 400" width="100%" height="400" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="800" height="400" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">Integration test lifecycle: transactional isolation around a real HTTP call</text>

  <rect x="18" y="42" width="200" height="58" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="32" y="64" font-size="12" font-weight="700" fill="#1e293b">session fixture</text>
  <text x="32" y="82" font-size="10" fill="#1e293b">start Postgres container</text>
  <text x="32" y="96" font-size="10" fill="#1e293b">alembic upgrade head</text>

  <rect x="246" y="42" width="200" height="58" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="260" y="64" font-size="12" font-weight="700" fill="#1e293b">app fixture</text>
  <text x="260" y="82" font-size="10" fill="#1e293b">dependency_overrides[get_db]</text>
  <text x="260" y="96" font-size="10" fill="#1e293b">TestClient(app)</text>

  <rect x="474" y="42" width="200" height="58" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="488" y="64" font-size="12" font-weight="700" fill="#1e293b">per&#8209;test fixture</text>
  <text x="488" y="82" font-size="10" fill="#1e293b">BEGIN transaction</text>
  <text x="488" y="96" font-size="10" fill="#1e293b">bind session, yield</text>

  <line x1="218" y1="71" x2="242" y2="71" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="246,71 238,67 238,75" fill="#4f46e5"/>
  <line x1="446" y1="71" x2="470" y2="71" stroke="#0ea5e9" stroke-width="2"/>
  <polygon points="474,71 466,67 466,75" fill="#0ea5e9"/>

  <rect x="18" y="122" width="656" height="150" rx="10" fill="#ffffff" stroke="#4f46e5" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="34" y="144" font-size="12" font-weight="700" fill="#1e293b">inside the transaction</text>

  <rect x="36" y="156" width="180" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="48" y="176" font-size="11" font-weight="700" fill="#1e293b">ARRANGE</text>
  <text x="48" y="192" font-size="10" fill="#1e293b">make_tenant(), make_invoice()</text>

  <rect x="240" y="156" width="200" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="252" y="176" font-size="11" font-weight="700" fill="#1e293b">ACT</text>
  <text x="252" y="192" font-size="10" fill="#1e293b">client.post(&quot;/v1/invoices&quot;, json=...)</text>

  <rect x="464" y="156" width="192" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="1.5"/>
  <text x="476" y="176" font-size="11" font-weight="700" fill="#1e293b">ASSERT</text>
  <text x="476" y="192" font-size="10" fill="#1e293b">status &#183; headers &#183; body &#183; effects</text>

  <line x1="216" y1="179" x2="236" y2="179" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="240,179 232,175 232,183" fill="#4f46e5"/>
  <line x1="440" y1="179" x2="460" y2="179" stroke="#0ea5e9" stroke-width="2"/>
  <polygon points="464,179 456,175 456,183" fill="#0ea5e9"/>

  <rect x="36" y="214" width="620" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="1.5"/>
  <text x="48" y="234" font-size="11" font-weight="700" fill="#1e293b">the four assertion dimensions</text>
  <text x="48" y="250" font-size="10" fill="#1e293b">201 &#183; Location: /v1/invoices/inv_1 &#183; body matches OpenAPI schema &#183; exactly 1 row + 1 event</text>

  <rect x="694" y="122" width="88" height="150" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="706" y="186" font-size="11" font-weight="700" fill="#1e293b">ROLLBACK</text>
  <text x="706" y="204" font-size="10" fill="#1e293b">clean DB</text>
  <text x="706" y="220" font-size="10" fill="#1e293b">next test</text>

  <rect x="18" y="292" width="764" height="90" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="34" y="314" font-size="12" font-weight="700" fill="#1e293b">CI pipeline</text>
  <text x="34" y="334" font-size="11" fill="#1e293b">stage 1: lint + unit (&#60; 60s, fail fast)  &#8594;  stage 2: integration + contract, sharded, Postgres service</text>
  <text x="34" y="354" font-size="11" fill="#1e293b">stage 3: deploy to staging &#8594; E2E smoke + OpenAPI breaking&#8209;change diff vs published spec</text>
  <text x="34" y="374" font-size="11" fill="#1e293b">artifacts: JUnit XML, coverage, flaky&#8209;test quarantine list with owners</text>
</svg>
```

---

## 5. Implementation

**Fixtures: transactional isolation with FastAPI + pytest.**

```python
# conftest.py
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from fastapi.testclient import TestClient
from testcontainers.postgres import PostgresContainer
from alembic import command
from alembic.config import Config
from app.main import app
from app.deps import get_db

@pytest.fixture(scope="session")
def engine():
    with PostgresContainer("postgres:16-alpine") as pg:
        cfg = Config("alembic.ini")
        cfg.set_main_option("sqlalchemy.url", pg.get_connection_url())
        command.upgrade(cfg, "head")          # test the real migrations, once
        yield create_engine(pg.get_connection_url(), pool_pre_ping=True)

@pytest.fixture()
def db(engine):
    """One transaction per test, rolled back at teardown."""
    conn = engine.connect()
    trans = conn.begin()
    session = sessionmaker(bind=conn, expire_on_commit=False)()
    try:
        yield session
    finally:
        session.close()
        trans.rollback()                       # nothing survives the test
        conn.close()

@pytest.fixture()
def client(db):
    app.dependency_overrides[get_db] = lambda: db
    with TestClient(app, raise_server_exceptions=False) as c:
        yield c
    app.dependency_overrides.clear()

@pytest.fixture()
def auth():
    """auth() -> headers with a scoped key; auth(scopes=..., tenant=...) to narrow."""
    def _as(scopes="invoices:read invoices:write", tenant="acct_test"):
        return {"Authorization": f"Bearer {mint_test_key(scopes, tenant)}"}
    return _as
```

> **Note:** `raise_server_exceptions=False` makes `TestClient` return the real `500` response instead of re-raising, which is the only way to test your error handler and problem-details body.

**Test data builders** — defaults everywhere, overrides for the one thing under test:

```python
_seq = itertools.count(1)

def make_invoice(db, *, tenant_id="acct_test", status="open", amount=1000, **kw):
    inv = Invoice(id=f"inv_{next(_seq):06d}", tenant_id=tenant_id,
                  status=status, amount_cents=amount, currency="usd", **kw)
    db.add(inv); db.flush()
    return inv
```

**A creation test that asserts all four dimensions:**

```python
def test_create_invoice_returns_201_with_location_and_persists(client, db, auth):
    r = client.post("/v1/invoices",
                    json={"customer_id": "cus_9", "amount_cents": 2500, "currency": "usd"},
                    headers=auth())

    assert r.status_code == 201                                   # 1. status
    assert r.headers["location"] == f"/v1/invoices/{r.json()['id']}"   # 2. headers
    assert r.headers["content-type"].startswith("application/json")
    body = r.json()
    assert body["status"] == "open" and body["amount_cents"] == 2500   # 3. body
    assert "internal_ledger_ref" not in body                      # no leaked internals
    rows = db.query(Invoice).filter_by(id=body["id"]).all()       # 4. side effect
    assert len(rows) == 1 and rows[0].tenant_id == "acct_test"
```

**Error and auth paths — the tests nobody writes:**

```python
@pytest.mark.parametrize("headers", [
    {},                                          # no credential
    {"Authorization": "Bearer ak_live_bogus"},   # bad credential
    {"Authorization": "Basic dXNlcjpwdw=="},     # wrong scheme
])
def test_unauthenticated_requests_are_401_with_challenge(client, headers):
    r = client.get("/v1/invoices", headers=headers)
    assert r.status_code == 401
    assert "www-authenticate" in r.headers          # RFC 9110 requires it
    assert r.headers["content-type"] == "application/problem+json"

def test_cross_tenant_read_is_404_not_403(client, db, auth):
    other = make_invoice(db, tenant_id="acct_other")
    r = client.get(f"/v1/invoices/{other.id}", headers=auth(tenant="acct_test"))
    assert r.status_code == 404          # do not leak existence

def test_validation_error_is_422_with_field_pointers(client, auth):
    r = client.post("/v1/invoices", json={"amount_cents": -5}, headers=auth())
    assert r.status_code == 422
    assert {e["loc"][-1] for e in r.json()["errors"]} >= {"customer_id", "amount_cents"}
```

**Idempotency and concurrency:**

```python
def test_same_idempotency_key_does_not_double_create(client, db, auth):
    hdrs = {**auth(), "Idempotency-Key": "0f8a-4c11-9d20"}
    body = {"customer_id": "cus_9", "amount_cents": 2500, "currency": "usd"}
    a = client.post("/v1/invoices", json=body, headers=hdrs)
    b = client.post("/v1/invoices", json=body, headers=hdrs)
    assert a.status_code == 201 and b.status_code == 201
    assert a.json() == b.json()                                # replayed response
    assert db.query(Invoice).count() == 1                      # one side effect

def test_stale_etag_write_is_412(client, db, auth):
    inv = make_invoice(db)
    etag = client.get(f"/v1/invoices/{inv.id}", headers=auth()).headers["etag"]
    client.patch(f"/v1/invoices/{inv.id}", json={"amount_cents": 3000},
                 headers={**auth(), "If-Match": etag})
    r = client.patch(f"/v1/invoices/{inv.id}", json={"amount_cents": 4000},
                     headers={**auth(), "If-Match": etag})     # now stale
    assert r.status_code == 412

def test_cursor_pagination_is_stable_under_insertion(client, db, auth):
    for _ in range(30):
        make_invoice(db)
    p1 = client.get("/v1/invoices?limit=10", headers=auth()).json()
    make_invoice(db)                                           # concurrent insert
    p2 = client.get(f"/v1/invoices?limit=10&cursor={p1['next_cursor']}",
                    headers=auth()).json()
    assert not ({i["id"] for i in p1["data"]} & {i["id"] for i in p2["data"]})
    assert len(p2["data"]) == 10                               # no skips either
```

**Contract testing against the OpenAPI document** — one test that covers the whole surface. With `openapi-core` you parse `openapi.yaml` once at module scope and call `validate_response(request, response, spec=SPEC)` inside a parametrised test over every documented path/method/status. `schemathesis` automates it further — it reads your OpenAPI document, generates property-based requests, and reports any response that violates the schema, returns an undocumented status, or `500`s:

```bash
schemathesis run --checks all --hypothesis-max-examples=200 \
  --header 'Authorization: Bearer ak_test_...' http://localhost:8000/openapi.json
```

**Node/Express with supertest** is the same shape — `supertest` mounts the Express app in-process, so `request(app).post('/v1/invoices').set('Authorization', ...).send(payload).expect(201).expect('Content-Type', /json/)` runs the whole middleware stack without a socket, and you still assert `res.headers.location` and the row count afterwards:

```javascript
const res = await request(app).post('/v1/invoices')
  .set('Authorization', `Bearer ${testKey}`)
  .send({ customer_id: 'cus_9', amount_cents: 2500, currency: 'usd' })
  .expect(201).expect('Content-Type', /application\/json/);
expect(res.headers.location).toBe(`/v1/invoices/${res.body.id}`);
expect(await countInvoices()).toBe(1);
```

**CI (GitHub Actions):**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_PASSWORD: pw, POSTGRES_DB: test }
        options: --health-cmd pg_isready --health-interval 5s --health-retries 10
        ports: ['5432:5432']
    strategy:
      matrix: { shard: [1, 2, 3, 4] }
    steps:
      - uses: actions/checkout@v4
      - run: pip install -r requirements-dev.txt
      - run: ruff check . && mypy app
      - run: pytest -q --splits 4 --group ${{ matrix.shard }} --junitxml=junit-${{ matrix.shard }}.xml --cov=app --cov-branch
        env: { DATABASE_URL: postgresql://postgres:pw@localhost:5432/test }
      - uses: actions/upload-artifact@v4
        with: { name: junit-${{ matrix.shard }}, path: junit-*.xml }
```

**Optimization note.** The three things that actually make an API suite fast: (1) **in-process HTTP** — `TestClient`/`supertest` skip the socket and the server process, turning a 5 ms request into ~1 ms; (2) **transaction rollback instead of truncation** — truncating 40 tables costs 20–100 ms per test and serialises everything, while a rollback is microseconds and permits parallelism; (3) **one container per session, sharded across workers** — `pytest -n auto` with a per-worker database, or `--splits/--group` across CI shards. Also hoist expensive constants: parse the OpenAPI spec once at module scope, hash test passwords once, and never call bcrypt inside a fixture that runs per test. A well-tuned suite of 800 integration tests runs in under two minutes; the same suite naively written runs in twenty.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Unit tests | Millisecond feedback, pinpoint failure localisation, safe to have thousands | Prove nothing about wiring, serialization or status codes; over-mocked ones assert your implementation back at you |
| Integration tests (real DB) | Highest value density for an API — catches routing, auth, transactions, constraints, status codes | Need real infrastructure; slower; sloppy isolation makes them order-dependent and flaky |
| Contract / schema tests | Whole-surface coverage nearly free once an OpenAPI document exists; catches undocumented drift | Only as good as the spec; won't catch semantic bugs where a wrong value is still schema-valid |
| Consumer-driven contracts (Pact) | Lets provider and consumer evolve independently without a shared environment | A broker to run, pacts to maintain, real organisational buy-in from both teams |
| E2E tests | Only layer that proves the deployed system actually works end to end | Slow, flaky, expensive to diagnose; flake probability compounds with step count |
| Transactional fixtures | Perfect isolation, microsecond teardown, parallel-safe | Cannot test code that manages its own transactions or spans multiple connections |
| Mocking third-party HTTP | Deterministic, fast, no rate limits or costs in CI | Mocks drift from reality; needs a periodic contract test against the real sandbox |
| Snapshot/approval tests | Very cheap coverage of large payloads; diffs are readable | Rubber-stamped updates destroy their value; brittle against timestamps and ids unless normalised |
| High line coverage | Easy to measure, useful floor, good CI gate | Measures execution, not assertion; gameable. Branch coverage on error paths and mutation testing say more |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Asserting only the status code.** → ✅ Assert all four dimensions: status, headers (`Location`, `ETag`, `Content-Type`, `Cache-Control`), body fields, and side effects (rows written, events emitted). A `201` with no `Location` header still fails the contract in RFC 9110 §15.3.2.
2. ⚠️ **Mocking your own database or repository layer in "integration" tests.** → ✅ Use a real Postgres via Testcontainers or a CI service container. Mocked persistence hides constraint violations, transaction boundaries, migration errors and SQL typos — the exact bugs the layer exists to catch.
3. ⚠️ **Sharing mutable state between tests** — a module-scoped seeded database, or tests that depend on running in file order. → ✅ Function-scoped transactional fixtures rolled back at teardown, plus builders that create their own data. Prove it by shuffling the run order (`pytest-randomly`).
4. ⚠️ **`sleep(2)` to wait for async work.** → ✅ Poll a condition with a bounded deadline, or make the test drive the worker synchronously. Fixed sleeps are simultaneously too slow on your laptop and too short on a loaded CI runner.
5. ⚠️ **No tests for error paths.** → ✅ Every documented status code needs a test: `400` vs `422`, `401` with `WWW-Authenticate`, `403` insufficient scope, `404` for cross-tenant, `409` conflict, `412` stale `If-Match`, `429` with `Retry-After`. Error responses are the part of your API clients handle worst, so verify their shape (RFC 9457 problem details) too.
6. ⚠️ **Ignoring authorization in tests** — every test runs as an admin. → ✅ Include a cross-tenant test on every resource: create a row under tenant B, read it as tenant A, assert `404`. This is OWASP API1:2023 (BOLA), the most-exploited API flaw, and it is trivially testable.
7. ⚠️ **Snapshot-testing whole responses with volatile fields.** → ✅ Normalise ids, timestamps and cursors before snapshotting, or assert on specific fields plus a schema validation. An unreadable 400-line snapshot diff always gets approved without reading.
8. ⚠️ **Letting the OpenAPI document and the implementation drift.** → ✅ Validate every response against the spec in CI (`schemathesis`, `openapi-core`, `dredd`), and run a breaking-change diff (`oasdiff`) against the published version on every PR (chapters 33–34).
9. ⚠️ **Testing idempotency and pagination "by inspection".** → ✅ Send the same `Idempotency-Key` twice and assert both an identical body *and* a single row. Page through a list while inserting concurrently and assert no duplicates or skips across pages — offset pagination will fail this test, which is the point (chapters 13, 27).
10. ⚠️ **Tolerating flaky tests** — re-run until green, or `@pytest.mark.skip` forever. → ✅ Quarantine on the second flake, file a bug with an owner, and treat the quarantine list as a burn-down. A retried flake is a real bug you have agreed not to look at.
11. ⚠️ **Fixtures that build a whole object graph for every test.** → ✅ Builders with sane defaults and explicit overrides, so a test states only the field it cares about. Giant shared fixtures make failures unreadable and couple every test to every schema change.
12. ⚠️ **Treating an E2E suite as the safety net.** → ✅ Keep E2E to a handful of critical journeys (signup → create → pay → webhook) and push everything else down to integration. A 40-minute E2E suite with a 5% flake rate provides negative value: people stop reading its failures.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When an integration test fails, the first question is always "what did the server actually return?" — so print the full response on failure: status, headers, and body, with a `traceparent`/request id you can grep in the app log. `pytest --tb=short -x -k name` plus `-s` for stdout, and `caplog` to assert on log records, resolves most cases in a minute. For "passes alone, fails in the suite", run `pytest -p no:randomly` versus shuffled order to confirm ordering coupling, then look for module-scoped fixtures, class attributes, or a real clock. For "passes locally, fails in CI", the culprit is nearly always timezone (`TZ=UTC` in CI, local elsewhere), locale, a missing environment variable, or parallelism exposing a shared resource.

**Monitoring the suite itself.** Treat CI as a production system with SLOs. Track: **p50/p95 suite duration** (alert when p95 crosses 10 minutes); **flake rate** per test over the last 100 runs (any test above 1% goes to quarantine); **first-failure time** (how fast does a broken build tell you?); **coverage by module** with branch coverage on error handlers; **quarantine size and age** — a growing quarantine is technical debt with a compounding interest rate. Store JUnit XML from every run so you can compute these; tools like `pytest-split`, Buildkite Test Analytics and Datadog CI Visibility do it off the shelf.

**Security in the test suite.** Never point tests at production, and make that structurally impossible: refuse to start if `DATABASE_URL` matches a production pattern. Use synthetic data only — a fixture seeded from a production dump is a data-protection incident waiting for a laptop to be stolen. Keep real credentials out of the repo; use CI secrets and short-lived test keys, and add a CI grep for `sk_live_`/`ak_live_` prefixes in the diff. Include *security regression tests* in the suite itself: cross-tenant access returns `404`; SQL-injection payloads in filter parameters are parameterised, not interpolated; oversized bodies are rejected with `413`; `alg=none` JWTs are rejected (chapter 20); rate limits actually return `429` with `Retry-After`. These are cheap and they never regress silently.

**Scaling the suite.** Parallelism first: `pytest -n auto` with per-worker databases, or CI shards with `--splits`/`--group`. Keep one container per session, not per test. Cache dependency installs and Docker layers. Split the suite by speed so developers can run `pytest -m "not slow"` in seconds locally while CI runs everything. As the API grows, the contract layer scales better than hand-written tests — one parametrised spec-validation test covers new endpoints for free, whereas hand-written integration tests grow linearly with endpoints. Finally, budget: if the suite takes longer than a coffee, people will stop running it, and an unrun test is worth exactly zero.

---

## 9. Interview Questions

**Q: What is the test pyramid, and how does it change for a REST API?**
A: It says have many fast isolated tests, fewer integrated ones, and very few end-to-end, because runtime and diagnosis cost rise sharply with integration. For a REST API the shape is squatter: the HTTP boundary *is* the product, so the integration layer — real HTTP against a real database, in-process — is unusually wide, since most defects live in routing, serialization, auth and transaction boundaries that unit tests cannot see.

**Q: What should you assert on an API response beyond the status code?**
A: Four dimensions: the status code, the headers (`Location` on `201`, `ETag`, `Content-Type`, `Cache-Control`, `Retry-After`), the body (specific fields plus schema validation, and the *absence* of internal fields), and the side effects — rows written, events published, outbound calls made. Status-only assertions miss most contract breaks.

**Q: How do you keep integration tests isolated and fast?**
A: Run each test inside a database transaction that is rolled back at teardown. That gives perfect isolation in microseconds, avoids truncating tables, permits parallel execution against separate connections, and removes ordering dependence. Start the database container once per session and run real migrations against it.

**Q: When should you mock, and when should you not?**
A: Mock things you do not own and cannot afford in CI — third-party HTTP APIs, payment providers, email — and mock them at the HTTP layer so your own serialization and error handling still execute. Do not mock your own database or repository; those tests only prove your code calls your code as written, and they miss constraints, transactions and SQL errors.

**Q: What is a contract test and what problem does it solve that integration tests do not?**
A: It verifies that the API's observable shape matches what consumers expect, without deploying both sides together. Schema-driven contract tests validate every response against the OpenAPI document; consumer-driven ones (Pact) record consumer expectations and replay them against the provider. They catch drift between spec and implementation, and breaking changes before consumers see them.

**Q: How do you test idempotency?**
A: Send the same request twice with the same `Idempotency-Key` and assert three things: both return success, both return the *identical* body, and exactly one side effect exists in the store. Then test the conflict case — the same key with a different payload should return `409` (or `422`), not silently apply either version.

**Q: How would you test pagination?**
A: Page through a collection while inserting and deleting concurrently, and assert no item appears twice and none is skipped. Assert the cursor is opaque and that a tampered cursor returns `400`. Offset pagination will fail the stability test under concurrent insertion, which is exactly the evidence you need to justify cursors.

**Q: (Senior) A test passes locally and fails in CI roughly one run in twenty. Walk through your diagnosis.**
A: Reproduce with the CI's seed and ordering, then isolate the source: time (a real clock, timezone, or a TTL boundary), shared state (module-scoped fixtures, a class attribute, a shared database row), ordering (run shuffled and reversed), concurrency (an unawaited task, a `sleep` standing in for a condition), or resources (port collisions, container startup races, disk). Instrument by logging the request id and dumping full response bodies on failure. Quarantine the test immediately with an owner and a bug so the build stays trustworthy while it is fixed — never paper over it with an automatic retry.

**Q: (Senior) Your API suite takes 45 minutes and developers have stopped running it. What do you do?**
A: First measure: JUnit timings per test to find the tail, since usually 5% of tests consume half the wall clock. Then attack in order — move E2E tests down the pyramid, replace per-test truncation with transaction rollback, start one database container per session, run in-process rather than over a socket, hoist expensive setup to session scope, and shard across CI workers with `pytest-split`. Split by marker so `pytest -m "not slow"` gives a sub-minute local loop. Set an explicit budget (10 minutes p95) and treat a breach as a build failure, not a suggestion.

**Q: (Senior) How do you prevent an API change from breaking consumers you cannot see?**
A: Make the OpenAPI document the source of truth, validate every response against it in CI, and run an automated breaking-change diff (`oasdiff`) against the last published version on every PR — removing a field, narrowing an enum, adding a required request field or changing a status code fails the build. Layer consumer-driven contract tests for known internal consumers, publish a deprecation policy with `Sunset` headers (RFC 8594), and instrument field-level usage in production so you can prove a field is unused before removing it.

**Q: (Senior) Coverage is at 92% and you still shipped a bug. What does that tell you and what would you add?**
A: That coverage measures execution, not assertion — code ran, but nothing checked its result, or the assertions were on the wrong dimension. I would add branch coverage requirements on error handlers, an explicit checklist that every documented status code has a test, mutation testing on the modules where correctness matters most, and schema validation of every response so undocumented drift fails automatically. Then I would write a regression test for the escaped bug and look for its siblings.

**Q: How do you test authentication and authorization without making every test an auth test?**
A: Provide a fixture that mints a scoped credential for a fresh tenant so the happy path is one keyword argument, then write a small dedicated set of auth tests: missing credential is `401` with `WWW-Authenticate`, valid credential lacking a scope is `403`, and a cross-tenant read is `404`. The cross-tenant test should exist for every resource type — that is BOLA coverage, and it is the single highest-value security test in an API suite.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Build a pyramid, but a squat one: many unit tests for pure logic, a *wide* integration layer that drives real HTTP through your real app against a real database, a contract layer that validates every response against the OpenAPI document, and a thin E2E smoke suite for critical journeys. Isolate integration tests with a per-test transaction rolled back at teardown; start the container and run migrations once per session; build data with factories that default everything and override one thing. Assert on four dimensions — status, headers, body, side effects — never status alone. Test the paths nobody writes: `401` with `WWW-Authenticate`, `403` insufficient scope, `404` for cross-tenant, `409`, `412` on a stale `If-Match`, `429` with `Retry-After`, and RFC 9457 problem bodies. Test idempotency by double-posting the same key and asserting one row, and pagination by paging while inserting. Mock third-party HTTP, never your own database. Kill flakes at the source — time, shared state, ordering, sleeps — and quarantine with an owner rather than retrying. Keep CI under ten minutes or nobody runs it.

| Layer / Item | Rule |
|---|---|
| Unit | ~1 ms, no I/O, pure logic; hundreds of them |
| Integration | Real HTTP + real Postgres, in-process, transaction-rolled-back; the widest layer |
| Contract | Validate every response against OpenAPI; `schemathesis` / `openapi-core` / Pact |
| E2E | 5–20 critical journeys against a deployed environment; nothing more |
| Isolation | `BEGIN` per test, `ROLLBACK` at teardown — not `TRUNCATE` |
| Assert on `201` | Status **and** `Location` header **and** persisted row |
| Assert on `401` / `429` | `WWW-Authenticate` present / `Retry-After` present; problem+json body |
| Idempotency test | Same key twice → identical body + exactly one side effect |
| Pagination test | Page while inserting → no duplicates, no skips |
| Third-party calls | Mock at the HTTP layer (`respx`, `nock`, WireMock); nightly test vs sandbox |
| Flake policy | Quarantine on second flake, assign an owner, never auto-retry silently |
| CI budget | p95 < 10 min; shard with `pytest -n auto` / `--splits` |

**Flash cards**

- **Why transaction rollback instead of truncate?** → Microsecond teardown, perfect isolation, and it allows parallel workers; truncation costs 20–100 ms per test and serialises the suite.
- **What four things should every API assertion cover?** → Status code, headers, body (including absent internal fields), and side effects in the store or on the bus.
- **Mock the database or the payment provider?** → The payment provider, at the HTTP layer. Mocking your own database tests your code against itself.
- **What does a contract test catch that an integration test misses?** → Drift between the published OpenAPI document and the implementation — undocumented fields, missing required ones, undeclared status codes.
- **Most valuable security test in an API suite?** → Cross-tenant read returns `404`: one test per resource type, and it covers OWASP API1:2023 BOLA.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Convert a suite that truncates tables between tests to per-test transaction rollback, then measure the wall-clock difference over 200 tests and enable `pytest -n auto`.
- [ ] Take one existing endpoint test that asserts only the status code and expand it to all four dimensions — status, every documented header, body fields plus the absence of internal fields, and the database side effect.
- [ ] Write the full error-path matrix for one resource: `400`, `401` (with `WWW-Authenticate`), `403` (insufficient scope), `404` (cross-tenant), `409`, `412` (stale `If-Match`), `422` (field pointers) and `429` (with `Retry-After`), asserting the RFC 9457 problem body shape each time.
- [ ] Run `schemathesis run --checks all` against your local `/openapi.json`, fix every violation it reports, then deliberately add an undocumented response field and confirm the check now fails.
- [ ] Introduce a deliberate flake — a test that reads `datetime.now()` across a midnight boundary — then fix it by injecting a frozen clock, and add `pytest-randomly` to prove order independence.

**Mini Project — a complete test harness for an invoices API**

*Goal:* build the suite you would want to inherit for a real payments-adjacent API.

*Requirements:*
1. `conftest.py` with a session-scoped Testcontainers Postgres, Alembic migrations run once, a per-test transactional `db` fixture, a `client` fixture with `dependency_overrides`, and an `auth(scopes, tenant)` helper.
2. Factories for `tenant`, `customer` and `invoice` with defaults and overrides, plus a frozen-clock fixture.
3. Integration tests covering the full CRUD lifecycle asserting status, headers, body and persisted rows — including `201` + `Location`, `204` on delete, and `404` on re-read.
4. The complete error matrix above, plus an idempotency test (double `POST`, one row) and a cursor-pagination stability test under concurrent insertion.
5. A contract layer: parametrised validation of every documented response against `openapi.yaml`, plus `schemathesis` in CI.
6. Third-party payment calls mocked with `respx`, including timeout and `500` paths that assert your retry and `502`/`504` mapping.
7. A GitHub Actions workflow with lint + unit as stage 1, sharded integration + contract as stage 2, JUnit and coverage artifacts, and a `oasdiff` breaking-change gate.

*Extensions:* add mutation testing with `mutmut` on the pricing module; add a Pact consumer contract from a sample client and verify it in the provider build; add a flaky-test detector that re-runs the suite ten times nightly and opens an issue for anything non-deterministic; add load-shaped tests asserting `429` behaviour under burst; publish a test-timing dashboard and enforce a 10-minute p95 budget as a build gate.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *OpenAPI Specification* (chapter 33) is the document your contract tests validate against; *Design-First & Contract Testing* (chapter 34) covers the workflow and Pact in depth; *Mocking, Stubs & Sandboxes* (chapter 37) covers faking third parties and offering a sandbox to your own consumers; *Backward Compatibility & Deprecation* (chapter 32) covers the breaking-change diffs your CI should gate on; *Idempotency Keys & Retries* (chapter 27) and *Pagination* (chapter 13) define the behaviours tested above; *Error Handling & Problem Details* (chapter 16) defines the RFC 9457 bodies you assert on; *Deployment & CI/CD for APIs* (chapter 41) covers the pipeline this suite runs in.

- **The Practical Test Pyramid** — Ham Vocke, martinfowler.com · *Intermediate* · the best free explanation of the layers, what belongs in each, and why the ice-cream cone fails. <https://martinfowler.com/articles/practical-test-pyramid.html>
- **Contract Test / Consumer-Driven Contracts** — Martin Fowler · *Intermediate* · the conceptual grounding for why contract tests exist and where they beat integration tests. <https://martinfowler.com/bliki/ContractTest.html>
- **FastAPI — Testing** — Sebastián Ramírez / FastAPI docs · *Beginner* · the canonical `TestClient` patterns, dependency overrides and async test setup. <https://fastapi.tiangolo.com/tutorial/testing/>
- **pytest documentation — Fixtures** — pytest-dev · *Intermediate* · scopes, `yield` teardown, parametrisation and factory fixtures; the reference for everything in section 5. <https://docs.pytest.org/en/stable/how-to/fixtures.html>
- **Schemathesis documentation** — Schemathesis · *Advanced* · property-based testing driven directly from your OpenAPI document; finds undocumented statuses and schema violations automatically. <https://schemathesis.readthedocs.io/>
- **Pact — Documentation** — Pact Foundation · *Advanced* · consumer-driven contract testing, the broker, and can-i-deploy gating for independent service releases. <https://docs.pact.io/>
- **Testcontainers** — Testcontainers / AtomicJar · *Intermediate* · throwaway real databases and brokers per test session, the practical answer to "don't mock your database". <https://testcontainers.com/>
- **Google Testing Blog — Test Sizes** — Google · *Intermediate* · the small/medium/large framing that pairs well with the pyramid and explains hermeticity and flake control at scale. <https://testing.googleblog.com/2010/12/test-sizes.html>

---

*REST API Handbook — chapter 36.*
