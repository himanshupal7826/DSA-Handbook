# 37 · Mocking, Stubs & Sandbox Environments

> **In one line:** Test doubles let you exercise code that depends on an HTTP API without calling the real thing — and a public sandbox is the same idea turned outward, so *your* consumers can integrate before they ever touch production money.

---

## 1. Overview

Every non-trivial API is both a **provider** and a **consumer**. Your checkout service calls Stripe; your notification service calls Twilio; your search service calls an internal catalog API. The moment your tests depend on those upstreams being reachable, correct, fast, and in a known state, your test suite stops being a test suite and becomes a weather report. **Test doubles** — mocks, stubs, fakes, and recorded fixtures — replace the real dependency with something you control, so a failing test means *your* code is broken rather than someone else's staging environment being down.

The problem this solves is threefold. First, **determinism**: a real upstream returns different data every run, rate-limits you, and occasionally 503s. Second, **coverage of the unhappy path**: you cannot ask Stripe to please return `429 Too Many Requests` on demand, nor to time out mid-response, but those are exactly the paths where your retry and circuit-breaker logic lives and where production incidents come from. Third, **speed and cost**: a suite that makes 400 network calls takes minutes and may cost real money; the same suite against an in-process mock takes seconds.

The vocabulary comes from Gerard Meszaros's *xUnit Test Patterns* (2007) and was sharpened by Martin Fowler's 2007 essay *Mocks Aren't Stubs*, which drew the line that still matters: a **stub** provides canned answers and you assert on your code's *state* afterwards; a **mock** has expectations about *how it is called* and fails the test if the interaction is wrong. HTTP-level tooling arrived later — WireMock (2011, JVM), `nock` (Node), `responses`/`respx` (Python), VCR (2010, Ruby) and its ports — and the OpenAPI era added a new trick: generate the mock *from the contract* so the double can never drift from the spec. Prism, Microcks, and `openapi-mock` all do this.

The outward-facing sibling is the **sandbox**: a permanently hosted, credential-isolated copy of your API that returns realistic but fake data and never moves real money or sends real messages. Stripe's test mode (`sk_test_…` keys plus magic card numbers like `4000 0000 0000 0002` for a declined charge), Twilio's `[test credentials]` with magic phone numbers, PayPal's developer sandbox, and GitHub's per-repo test tokens are all the same product decision: *make it possible to build a complete, correct integration without a single production side effect.* A good sandbox is a growth feature, not a testing feature — it is the difference between a partner shipping in three days and abandoning at week two.

A concrete example: a payments team ships an "Orders" API that calls a payment processor. In unit tests, the processor client is a **fake** that returns a `Charge` object in memory. In component tests, a **WireMock** container serves canned JSON with injected 500ms latency and a scripted `429` on the third call, proving retries and backoff work. In contract tests, **Prism** serves the processor's published OpenAPI file, so if the team mis-reads a field name the test fails immediately. And for their *own* customers, they run `sandbox.api.example.com` where any card ending in `0002` declines. Four different doubles, four different jobs.

---

## 2. Core Concepts

- **Test double** — the umbrella term for any stand-in object or server used in place of a real dependency during testing.
- **Stub** — returns pre-programmed responses; makes no assertions about how it was called. You verify *state*.
- **Mock** — a double with pre-set expectations about calls (method, URL, body, count); the test fails if the interaction differs. You verify *behaviour*.
- **Fake** — a working but simplified implementation (an in-memory repository, a fake payment gateway) that is fast and non-production-grade.
- **Spy** — a real or stubbed object that records the calls made to it so the test can inspect them afterwards.
- **Fixture** — a stored request/response pair (often JSON on disk) replayed by the double; the recording-and-replay style is called **VCR** after the original Ruby gem, with cassettes as the storage unit.
- **Mock server** — an out-of-process HTTP server (WireMock, Prism, MockServer, Microcks) that your code reaches over a real socket, exercising the actual HTTP client, serializers, and timeouts.
- **Contract test** — a test that verifies a consumer and provider agree on a shared schema; Pact does this consumer-driven, Prism/Schemathesis do it spec-driven.
- **Sandbox** — a hosted, isolated deployment of the real API with fake data and fake side effects, exposed to external developers under separate credentials.
- **Magic value** — a documented input that triggers a specific sandbox outcome (card `4000000000000002` → decline; phone `+15005550009` → invalid number).
- **Record/replay drift** — the failure mode where recorded fixtures still pass while the live API has changed underneath them.

---

## 3. Theory & Principles

The governing idea is the **test pyramid applied to network boundaries**. Every double trades *fidelity* for *control*. An in-process function stub gives you total control and near-zero fidelity — it does not exercise your HTTP client, your JSON deserializer, your connection pool, your TLS config, or your timeout settings. A real staging upstream gives you maximum fidelity and almost no control. A local mock **server** sits in the sweet spot: your code makes a genuine `POST` over TCP, so headers, encoding, retries, and timeouts are all real, while the response is whatever you scripted.

This produces a practical rule: **mock at the HTTP boundary, not at the client-library boundary.** If you stub `stripe_client.create_charge()`, a bug in how you build the idempotency header is invisible. If you point the client at `http://localhost:4010` and let it speak HTTP, that bug shows up.

The second principle is **the two-sided contract problem**. A double is an *assertion about someone else's behaviour*, and assertions rot. If the provider adds a required field, renames `amount_cents` to `amount`, or changes `201` to `202`, your green test suite is now lying to you. There are exactly three defences, and mature teams use all three:

1. **Generate the double from the provider's published schema** (OpenAPI → Prism/Microcks). Drift in the spec becomes drift in the mock automatically.
2. **Consumer-driven contract testing** (Pact): the consumer publishes the interactions it depends on to a broker; the provider's CI replays them against the real implementation and fails the *provider* build if it breaks a consumer.
3. **A small, scheduled suite of real integration tests** against the provider's sandbox — slow, flaky-tolerant, run nightly rather than per-commit, purely to detect drift.

The third principle is **what a mock must simulate beyond the happy body**. Production failures are rarely "wrong JSON"; they are latency, partial writes, and status codes you never coded for. A serious double can inject: fixed and jittered delay, connection reset mid-body, chunked responses that stall, `429` with `Retry-After: 2`, `503` with no body, `500` on the Nth call only, and clock-skewed `Date` headers. If your double cannot express those, you are only testing the sunny day.

Finally, **statefulness**. Most mocks are stateless functions of the request. But real API flows are stateful: `POST /orders` → `201` → `GET /orders/{id}` must return the thing you just created. WireMock models this with **scenarios** (a named state machine advanced by matching requests); Microcks and MockServer have equivalents. Without state, you cannot test a create-then-read flow, and you certainly cannot test idempotency keys, where the *second* identical `POST` must return the *first* response.

```svg
<svg viewBox="0 0 720 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="720" height="340" fill="#f8fafc"/>
  <text x="360" y="26" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">Fidelity vs. control: where each test double sits</text>
  <line x1="70" y1="290" x2="670" y2="290" stroke="#1e293b" stroke-width="2"/>
  <line x1="70" y1="290" x2="70" y2="60" stroke="#1e293b" stroke-width="2"/>
  <text x="370" y="318" text-anchor="middle" font-size="12" fill="#1e293b">fidelity to production &#8594;</text>
  <text x="24" y="180" font-size="12" fill="#1e293b" transform="rotate(-90 24 180)">control &#8594;</text>
  <rect x="95" y="80" width="150" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="170" y="103" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">in-process stub</text>
  <text x="170" y="122" text-anchor="middle" font-size="11" fill="#1e293b">no socket, no client</text>
  <rect x="245" y="130" width="160" height="56" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="325" y="153" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">recorded fixtures</text>
  <text x="325" y="172" text-anchor="middle" font-size="11" fill="#1e293b">VCR cassettes, can rot</text>
  <rect x="360" y="180" width="170" height="56" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="445" y="203" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">local mock server</text>
  <text x="445" y="222" text-anchor="middle" font-size="11" fill="#1e293b">real HTTP, scripted faults</text>
  <rect x="480" y="232" width="170" height="50" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="565" y="253" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">vendor sandbox</text>
  <text x="565" y="271" text-anchor="middle" font-size="11" fill="#1e293b">real server, fake money</text>
  <line x1="170" y1="136" x2="325" y2="130" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4"/>
  <line x1="325" y1="186" x2="445" y2="180" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4"/>
  <line x1="445" y1="236" x2="565" y2="232" stroke="#94a3b8" stroke-width="1.5" stroke-dasharray="4"/>
  <text x="600" y="80" font-size="11" fill="#1e293b">run per-commit:</text>
  <text x="600" y="98" font-size="11" fill="#4f46e5">stub, mock server</text>
  <text x="600" y="118" font-size="11" fill="#1e293b">run nightly:</text>
  <text x="600" y="136" font-size="11" fill="#d97706">sandbox</text>
</svg>
```

---

## 4. Architecture & Workflow

A mature setup runs **three tiers of doubles** plus one hosted sandbox. Here is the end-to-end flow for a service `orders-api` that consumes a third-party `payments` API and is itself consumed by a mobile app.

1. **Contract acquisition.** CI downloads the provider's `openapi.yaml` (pinned by digest, stored in the repo under `contracts/payments-v3.yaml`). A scheduled job re-downloads it daily and opens a PR if the digest changed — this is the drift alarm.
2. **Boot the mock.** The test harness starts Prism (`prism mock contracts/payments-v3.yaml --port 4010`) or a WireMock container. Because the mock is generated from the spec, every response it emits is schema-valid by construction.
3. **Point the client at it.** `PAYMENTS_BASE_URL=http://localhost:4010` is injected as configuration, never hard-coded. The production client class is used unchanged — same retry policy, same timeouts, same auth header builder.
4. **Exercise the happy path.** The test calls `POST /orders`; `orders-api` calls `POST /charges` on the mock; the mock replies `201 Created` with a `Location` header and a schema-valid body; `orders-api` persists the order and returns `201` to the test.
5. **Exercise the fault paths.** The test reconfigures the mock through its admin API to return `429` with `Retry-After: 1` for the next two calls, then `201`. The assertion is that `orders-api` retried exactly twice, honoured `Retry-After`, and reused the same `Idempotency-Key`.
6. **Verify the interaction.** The test queries the mock's request journal (`GET /__admin/requests` in WireMock) and asserts the outbound body, the `Idempotency-Key`, and that no more than three requests were made.
7. **Publish the consumer contract.** The mobile team's Pact tests generate a pact file describing what *they* need from `orders-api`; it lands in a Pact Broker.
8. **Provider verification.** `orders-api`'s CI replays every consumer pact against a real, locally-running instance with a seeded database. If a field the mobile app depends on was removed, this build fails — before merge.
9. **Nightly reality check.** A small suite runs against the payment provider's real sandbox with test credentials. It is allowed to be slow; it is *not* allowed to be ignored — a failure here means the mocks are lying.
10. **Ship the sandbox.** `orders-api` itself deploys to `sandbox.api.example.com` from the same image as production, with a `SANDBOX=true` flag that swaps every side-effecting adapter (payments, email, SMS, webhooks-to-real-endpoints) for a fake and seeds a demo tenant.

```svg
<svg viewBox="0 0 760 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="380" fill="#ffffff"/>
  <text x="380" y="26" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">Three tiers of doubles around one service</text>
  <rect x="30" y="60" width="140" height="70" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="100" y="88" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">mobile app</text>
  <text x="100" y="108" text-anchor="middle" font-size="11" fill="#1e293b">(consumer)</text>
  <rect x="290" y="55" width="180" height="120" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="380" y="82" text-anchor="middle" font-size="13" font-weight="bold" fill="#1e293b">orders-api</text>
  <text x="380" y="104" text-anchor="middle" font-size="11" fill="#1e293b">real code under test</text>
  <text x="380" y="124" text-anchor="middle" font-size="11" fill="#1e293b">real HTTP client</text>
  <text x="380" y="144" text-anchor="middle" font-size="11" fill="#1e293b">real retry policy</text>
  <text x="380" y="163" text-anchor="middle" font-size="11" fill="#1e293b">BASE_URL from env</text>
  <rect x="580" y="55" width="150" height="70" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="655" y="82" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">Prism mock</text>
  <text x="655" y="102" text-anchor="middle" font-size="11" fill="#1e293b">from openapi.yaml</text>
  <rect x="580" y="145" width="150" height="70" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="655" y="172" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">WireMock</text>
  <text x="655" y="192" text-anchor="middle" font-size="11" fill="#1e293b">fault injection</text>
  <rect x="580" y="235" width="150" height="70" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="655" y="262" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">vendor sandbox</text>
  <text x="655" y="282" text-anchor="middle" font-size="11" fill="#1e293b">nightly only</text>
  <line x1="170" y1="95" x2="288" y2="95" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="288,95 280,91 280,99" fill="#4f46e5"/>
  <text x="228" y="86" text-anchor="middle" font-size="10" fill="#1e293b">pact</text>
  <line x1="470" y1="90" x2="578" y2="90" stroke="#0ea5e9" stroke-width="2"/>
  <polygon points="578,90 570,86 570,94" fill="#0ea5e9"/>
  <line x1="470" y1="120" x2="578" y2="178" stroke="#d97706" stroke-width="2"/>
  <polygon points="578,178 569,175 572,168" fill="#d97706"/>
  <line x1="470" y1="150" x2="578" y2="266" stroke="#dc2626" stroke-width="2" stroke-dasharray="5"/>
  <polygon points="578,266 569,262 571,255" fill="#dc2626"/>
  <rect x="30" y="230" width="410" height="120" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="235" y="256" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">sandbox.api.example.com</text>
  <text x="235" y="280" text-anchor="middle" font-size="11" fill="#1e293b">same image, SANDBOX=true</text>
  <text x="235" y="300" text-anchor="middle" font-size="11" fill="#1e293b">fake payment + email adapters, seeded tenant</text>
  <text x="235" y="320" text-anchor="middle" font-size="11" fill="#1e293b">magic values: card ...0002 declines</text>
  <text x="235" y="340" text-anchor="middle" font-size="11" fill="#1e293b">nightly reset, separate keys (sk_test_)</text>
</svg>
```

---

## 5. Implementation

### Prism: a mock server straight from OpenAPI 3.1

```yaml
openapi: 3.1.0
info: { title: Payments API, version: "3.0.0" }
paths:
  /charges:
    post:
      operationId: createCharge
      parameters:
        - name: Idempotency-Key
          in: header
          required: true
          schema: { type: string, format: uuid }
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [amount, currency, source]
              properties:
                amount:   { type: integer, minimum: 1, examples: [4999] }
                currency: { type: string, pattern: "^[A-Z]{3}$", examples: ["USD"] }
                source:   { type: string, examples: ["tok_visa"] }
      responses:
        "201":
          description: Charge created
          headers:
            Location: { schema: { type: string }, required: true }
          content:
            application/json:
              schema:
                type: object
                required: [id, status, amount]
                properties:
                  id:     { type: string, examples: ["ch_3PqL2x"] }
                  status: { type: string, enum: [succeeded, pending, failed] }
                  amount: { type: integer }
        "402":
          description: Card declined
          content:
            application/problem+json:
              schema: { $ref: "#/components/schemas/Problem" }
        "429":
          description: Too many requests
          headers:
            Retry-After: { schema: { type: integer } }
components:
  schemas:
    Problem:
      type: object
      properties:
        type:   { type: string, examples: ["https://errors.example.com/card-declined"] }
        title:  { type: string, examples: ["Card declined"] }
        status: { type: integer, examples: [402] }
        detail: { type: string }
```

```bash
# Serve the contract as a live mock on :4010, validating every incoming request
npx @stoplight/prism-cli mock contracts/payments-v3.yaml --port 4010 --errors

# Happy path: Prism returns the `examples` values, schema-valid by construction
curl -i -X POST http://localhost:4010/charges \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f9d9f34-2a8f-4c3b-9c9b-2b9d1f7a1f01' \
  -d '{"amount":4999,"currency":"USD","source":"tok_visa"}'

# Force a specific response with the Prefer header (RFC 7240 style)
curl -i -X POST http://localhost:4010/charges \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: 6f9d9f34-2a8f-4c3b-9c9b-2b9d1f7a1f01' \
  -H 'Prefer: code=402' \
  -d '{"amount":4999,"currency":"USD","source":"tok_chargeDeclined"}'
```

With `--errors`, a request that violates the spec is rejected by the mock itself:

```http
POST /charges HTTP/1.1
Host: localhost:4010
Content-Type: application/json
Idempotency-Key: 6f9d9f34-2a8f-4c3b-9c9b-2b9d1f7a1f01

{"amount":0,"currency":"usd"}
```
```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{
  "type": "https://stoplight.io/prism/errors#UNPROCESSABLE_ENTITY",
  "title": "Invalid request body payload",
  "status": 422,
  "detail": "Your request body did not match the schema",
  "validation": [
    { "location": ["body","amount"],   "code": "minimum", "message": "must be >= 1" },
    { "location": ["body","currency"], "code": "pattern", "message": "must match ^[A-Z]{3}$" },
    { "location": ["body"],            "code": "required", "message": "must have required property 'source'" }
  ]
}
```

> **Note:** `422 Unprocessable Content` is the right code here — the syntax was valid JSON, the *semantics* failed validation. Reserve `400 Bad Request` for malformed syntax the parser rejected.

### WireMock: stateful scenarios and fault injection

```json
[
  {
    "scenarioName": "charge-with-rate-limit",
    "requiredScenarioState": "Started",
    "newScenarioState": "one-429-served",
    "request": { "method": "POST", "url": "/charges" },
    "response": {
      "status": 429,
      "headers": { "Retry-After": "1", "Content-Type": "application/problem+json" },
      "jsonBody": { "type": "about:blank", "title": "Too Many Requests", "status": 429 }
    }
  },
  {
    "scenarioName": "charge-with-rate-limit",
    "requiredScenarioState": "one-429-served",
    "newScenarioState": "succeeded",
    "request": { "method": "POST", "url": "/charges" },
    "response": {
      "status": 201,
      "fixedDelayMilliseconds": 350,
      "headers": { "Location": "/charges/ch_3PqL2x", "Content-Type": "application/json" },
      "jsonBody": { "id": "ch_3PqL2x", "status": "succeeded", "amount": 4999 }
    }
  },
  {
    "request": { "method": "POST", "url": "/charges", "bodyPatterns": [{ "matchesJsonPath": "$[?(@.source == 'tok_networkError')]" }] },
    "response": { "fault": "CONNECTION_RESET_BY_PEER" }
  }
]
```

### Python: pytest + respx against a real `httpx` client

```python
import httpx, pytest, respx
from app.payments import PaymentsClient, RateLimited

@pytest.mark.asyncio
@respx.mock(base_url="https://api.payments.test")
async def test_retries_once_on_429_and_reuses_idempotency_key(respx_mock):
    route = respx_mock.post("/charges").mock(
        side_effect=[
            httpx.Response(429, headers={"Retry-After": "0"},
                           json={"title": "Too Many Requests", "status": 429}),
            httpx.Response(201, headers={"Location": "/charges/ch_1"},
                           json={"id": "ch_1", "status": "succeeded", "amount": 4999}),
        ]
    )
    client = PaymentsClient(base_url="https://api.payments.test", max_retries=3)
    charge = await client.create_charge(amount=4999, currency="USD", source="tok_visa")

    assert charge.id == "ch_1"
    assert route.call_count == 2
    first, second = route.calls[0].request, route.calls[1].request
    # The retry MUST carry the same idempotency key, or we risk a double charge.
    assert first.headers["idempotency-key"] == second.headers["idempotency-key"]


@respx.mock(base_url="https://api.payments.test")
async def test_gives_up_and_surfaces_rate_limit(respx_mock):
    respx_mock.post("/charges").mock(return_value=httpx.Response(429, headers={"Retry-After": "30"}))
    client = PaymentsClient(base_url="https://api.payments.test", max_retries=2)
    with pytest.raises(RateLimited) as err:
        await client.create_charge(amount=100, currency="USD", source="tok_visa")
    assert err.value.retry_after == 30
```

### FastAPI: one image, sandbox mode by flag

```python
from fastapi import Depends, FastAPI, HTTPException, Header
from pydantic_settings import BaseSettings

class Settings(BaseSettings):
    sandbox: bool = False
    payments_base_url: str = "https://api.payments.example.com"

settings = Settings()
app = FastAPI(title="Orders API")

class FakePayments:
    """Deterministic sandbox gateway driven by documented magic values."""
    DECLINE = "4000000000000002"
    INSUFFICIENT = "4000000000009995"

    async def charge(self, amount: int, card: str) -> dict:
        if card.endswith(self.DECLINE[-4:]):
            raise HTTPException(402, detail="card_declined")
        if card.endswith(self.INSUFFICIENT[-4:]):
            raise HTTPException(402, detail="insufficient_funds")
        return {"id": f"ch_sbx_{abs(hash(card)) % 10**8}", "status": "succeeded", "amount": amount}

def gateway():
    return FakePayments() if settings.sandbox else RealPayments(settings.payments_base_url)

@app.post("/v1/orders", status_code=201)
async def create_order(body: dict,
                       idempotency_key: str = Header(alias="Idempotency-Key"),
                       gw = Depends(gateway)):
    charge = await gw.charge(body["amount_cents"], body["card_number"])
    return {"id": "ord_9f2", "charge_id": charge["id"], "status": "paid",
            "livemode": not settings.sandbox}
```

Every sandbox response carries `"livemode": false` — Stripe's convention, and the single most useful field for catching a client that accidentally shipped test keys to production.

**Optimization note.** Mock servers are frequently the slowest thing in a "fast" test suite because each test boots a fresh container. Start **one** mock server per test *session* (a session-scoped fixture or a Testcontainers singleton) and reset only its stub mappings between tests (`POST /__admin/reset` in WireMock, ~2 ms) instead of restarting the process (~1.5 s). On a 400-test suite that is the difference between 11 minutes and 40 seconds. Second win: run mocks over loopback with keep-alive enabled so you are not paying TCP handshake per call; third: never add real `sleep()` to simulate latency in unit tests — use the mock's `fixedDelayMilliseconds` only in the handful of tests that actually assert on timeout behaviour.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| In-process stub (`nock`, `respx`) | Microsecond-fast, zero infrastructure, trivial in CI | Bypasses the socket; connection pooling, DNS, TLS, and proxy config go untested |
| Mock server (WireMock, MockServer) | Real HTTP through the real client; rich fault and latency injection; stateful scenarios | Extra process to boot and manage; stub JSON becomes a second codebase to maintain |
| Spec-generated mock (Prism, Microcks) | Cannot drift from the contract; validates your *requests* too; free the moment a spec exists | Only as good as the spec — thin `examples` produce useless bodies; weak at multi-step state |
| Recorded fixtures (VCR-style) | Realistic bodies captured from the real API with almost no authoring effort | Cassettes rot silently; secrets leak into committed files; re-recording needs live credentials |
| Consumer-driven contracts (Pact) | Catches provider-side breakage *before* merge; documents real consumer needs | Requires a broker and cross-team buy-in; poor fit for public APIs with unknown consumers |
| Vendor sandbox | Highest fidelity short of production; exercises real auth, real rate limits | Slow, shared, rate-limited, occasionally down — unusable as a per-commit gate |
| Running your own public sandbox | Massive adoption win; partners integrate without risk; support load drops | A second environment to deploy, seed, monitor, secure, and keep at feature parity |
| Fakes (in-memory implementations) | Fast and expressive; great for repositories and clocks | You now maintain a second implementation whose behaviour can diverge from the real one |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Mocking the client library instead of the wire.** Stubbing `client.create_charge()` hides bugs in header construction, serialization, and timeout handling. → ✅ Point the real client at `http://localhost:4010`. Mock HTTP, not your own abstraction.
2. ⚠️ **Only stubbing `200`/`201`.** Retry, backoff, and circuit-breaker code then has zero coverage and first executes during an incident. → ✅ Every external call needs at least a `429`, a `5xx`, a timeout, and a connection-reset test.
3. ⚠️ **Hand-written mock bodies that no longer match the provider.** The suite stays green for months while integration is broken. → ✅ Generate mocks from the provider's OpenAPI file and run a nightly job that diffs the spec and fails loudly on change.
4. ⚠️ **Committing cassettes with live secrets.** Recorded fixtures routinely contain `Authorization: Bearer …`, customer emails, and card metadata. → ✅ Configure `filter_headers` / `before_record` scrubbers, add a `gitleaks` pre-commit hook, and treat the fixtures directory as production data.
5. ⚠️ **Stateless mocks used to test stateful flows.** `POST` then `GET` returns something unrelated, and idempotency-key behaviour is untestable. → ✅ Use WireMock scenarios or a small in-memory fake that actually stores what you created.
6. ⚠️ **Asserting on the double instead of on behaviour.** `assert mock.called_once()` passes forever even after the feature is deleted. → ✅ Assert on outcomes — the order row exists, the response is `201` with a `Location` — and use interaction assertions only where the interaction *is* the requirement (e.g. "exactly one charge").
7. ⚠️ **A sandbox that drifts from production.** Partners build against last quarter's API and break at go-live. → ✅ Deploy the sandbox from the *same artefact* on the same pipeline, one stage earlier, with only adapters swapped by flag.
8. ⚠️ **A sandbox with real side effects.** A test run emails 40,000 real customers, or a "test" webhook hits a partner's production endpoint. → ✅ Hard-fail at boot if `SANDBOX=true` and any real SMTP/SMS/payment credential is present; route all egress through a null adapter.
9. ⚠️ **No documented magic values.** Developers cannot reach the decline path, so they never implement it, and every real decline becomes a support ticket. → ✅ Publish a table of magic inputs → outcomes, exactly as Stripe and Twilio do, and test them in your own suite.
10. ⚠️ **Sandbox data that never resets, or resets under people's feet.** Either it fills with junk or it deletes a partner's demo mid-call. → ✅ Reset on a published schedule *per tenant*, offer a `POST /v1/sandbox/reset` endpoint, and never share tenant state between developer accounts.
11. ⚠️ **Sandbox keys that work in production (or vice versa).** → ✅ Prefix keys unmistakably (`sk_test_` vs `sk_live_`), reject the wrong prefix with `401`, and echo `"livemode": false` in every sandbox response body.
12. ⚠️ **Treating the nightly sandbox suite as optional.** It goes red, gets muted, and the drift alarm is gone. → ✅ Route its failures to the same on-call channel as production alerts, with a named owner.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When a test passes locally but fails in CI, the mock is the first suspect: check port collisions (bind to `:0` and read back the assigned port), container start-up races (wait on the mock's `/__admin/health` before the first test, never `sleep 2`), and stub leakage between tests (an unreset scenario from test 12 breaks test 47). WireMock's request journal (`GET /__admin/requests`) and `--verbose` mode print every *near-miss* — the request that almost matched a stub and why it did not, which is usually a `Content-Type` mismatch or a stray trailing slash. For sandbox debugging, give every sandbox response a `X-Request-Id` and expose a per-developer request log in the dashboard; Stripe's request log is the gold standard and cuts integration support tickets dramatically.

**Monitoring.** For the mock layer, track **mock start-up time**, **stub-miss rate** (requests that matched no stub — should be zero), and **contract-drift age** (days since the provider's spec digest was last verified). For the sandbox, monitor it like production but with its own SLO: `sandbox_request_duration_seconds` histogram, `sandbox_errors_total` by status, active sandbox tenants, seed-job success, and reset-job success. A useful leading indicator of a bad developer experience is the **sandbox 4xx ratio by developer account** — a partner stuck at 80% `400`s is about to churn and nobody has told you.

**Security.** A sandbox is internet-exposed and authenticated with keys developers paste into gists, so treat it as hostile ground. Enforce separate credential namespaces and separate signing keys for webhooks (`whsec_test_…`); never let a sandbox token read production data or share a database with production; seed with generated fake PII only (Faker), never with a scrubbed production dump — scrubbing always misses a column. Rate-limit the sandbox harder than production and per API key, because it *will* be used for load testing by someone. Egress-block the sandbox's outbound network except to explicitly allowlisted fake providers, so a mis-wired adapter physically cannot reach a real payment processor. For recorded fixtures, scrub `Authorization`, `Cookie`, `Set-Cookie`, and any `*-Token` header at record time and scan the repo in CI.

**Performance & scaling.** Session-scoped mock servers with per-test stub resets keep suites fast; in-process interceptors are ~1000× cheaper than a container round trip, so use them for the bulk of unit tests and reserve real mock servers for the boundary tests that need HTTP realism. For the hosted sandbox, expect traffic that looks nothing like production — bursty, script-driven, heavily weighted to a handful of endpoints — so size it independently and give it its own autoscaling policy. A cheap and very effective pattern is to run the sandbox on smaller instances with aggressive per-key rate limits (say 25 rps burst 50) and a shorter data-retention window (30 days), which keeps the cost at a small fraction of production while remaining more than fast enough for integration work.

---

## 9. Interview Questions

**Q: What is the difference between a mock and a stub?**
A: A stub supplies canned responses and makes no claims about how it is used — you assert on the resulting state of your system. A mock carries expectations about the interaction itself (which endpoint, which body, how many times) and fails the test if those expectations are not met, so you assert on behaviour. Fowler's rule of thumb: stubs verify state, mocks verify interactions; over-using mocks couples tests to implementation details.

**Q: Why is mocking at the HTTP layer generally better than mocking your own client class?**
A: Because the HTTP layer is where most real bugs live — header construction, serialization, content negotiation, timeouts, connection reuse, retry logic. If you stub the client method, all of that is bypassed and untested. Pointing the real client at a local mock server keeps every one of those code paths in the test while still giving you full control of the response.

**Q: How do you keep mocks from drifting away from the real API?**
A: Generate them from the provider's published OpenAPI spec so schema changes propagate automatically, pin and diff that spec on a schedule so a change opens a PR, and run a small nightly suite against the provider's real sandbox purely as a drift alarm. Consumer-driven contract testing with Pact closes the loop in the other direction for internal services.

**Q: What should a mock be able to simulate besides a successful response body?**
A: Latency (fixed and jittered), `429` with `Retry-After`, `5xx` with and without a body, connection reset mid-response, a stalled chunked response, malformed JSON, and an Nth-call-only failure. Those are the conditions that exercise retry, backoff, timeout, and circuit-breaker logic — the code that decides whether an upstream blip becomes an outage.

**Q: What makes a public sandbox good rather than merely present?**
A: Feature parity with production (same artefact, flag-swapped adapters), documented magic values that let a developer reach every branch including declines and disputes, unmistakable credential separation with `livemode: false` in responses, a per-developer request log, deterministic data seeding, and a self-service reset. Anything less and developers integrate against production "just to see if it works".

**Q: How do you test webhook delivery without a public IP?**
A: Run a local receiver and point the sandbox at it through a tunnel (`ngrok`, Cloudflare Tunnel), or better, provide a first-class replay tool — a CLI that streams sandbox events to `localhost` (as `stripe listen --forward-to` does) plus a "resend this event" button in the dashboard. In automated tests, assert on the signature header rather than the transport, and keep a fixture of a correctly signed payload to test verification logic offline.

**Q: (Senior) When would you deliberately choose *not* to mock a dependency?**
A: When the dependency's behaviour is the thing under test and a double would only assert your own assumptions — database queries (use a real Postgres in a container, not an in-memory fake with different SQL semantics), serialization against a real broker, or anything with subtle protocol behaviour like a rate limiter or an auth server. The heuristic: mock what you cannot control and do not own; use the real thing when it is cheap to run and its semantics are the point.

**Q: (Senior) A team's suite is 100% green but a release broke a partner integration. Walk through what failed and how you would fix the system.**
A: The failure is structural: doubles encoded a belief about the provider (or about what consumers depend on) and nothing verified that belief. Fix it in layers — generate mocks from the contract so provider drift is mechanical, add consumer-driven contract tests so removing a field a consumer reads fails the provider's build pre-merge, add a nightly live-sandbox smoke suite as an independent alarm, and add a schema-diff gate in CI that classifies changes as breaking or additive. Then add the organizational piece: a deprecation policy with `Sunset` headers so even a genuine break is announced rather than discovered.

**Q: (Senior) How do you build a sandbox for an API whose core behaviour is asynchronous and takes days in real life — settlements, KYC review, shipping?**
A: Compress and expose time. Model the state machine explicitly, drive it in the sandbox with documented triggers (a magic amount that settles in 10 seconds, a `POST /v1/sandbox/advance` endpoint that forces the next transition, a test clock that a developer can move forward), and emit the same webhook sequence with the same ordering and retry semantics as production. Never make a developer wait 48 hours to see event two of five — but never let the sandbox skip states either, or clients ship code that has never seen the intermediate status.

**Q: (Senior) What are the risks of record/replay fixtures at scale, and what would you replace them with?**
A: Three risks: silent rot (cassettes keep passing after the API changes), secret leakage (recordings capture live tokens and PII), and non-determinism laundering (a recording of a flaky response is now a permanent "truth"). At scale I would keep record/replay only for capturing *realistic bodies* to seed spec examples, and move enforcement to spec-generated mocks plus contract tests, with cassettes carrying a TTL that fails the build once they are older than, say, 90 days and unverified.

**Q: How do you prevent sandbox credentials from being used against production?**
A: Distinct key prefixes (`sk_test_` / `sk_live_`), distinct signing secrets, distinct issuers in JWTs, and separate datastores — then reject a test key at the production edge with `401` and a `type` in the problem document that says exactly what went wrong. Echo `"livemode": false` in sandbox responses so client code can assert on it, and add a production start-up check that refuses to boot with a test-prefixed secret in the environment.

**Q: Where do mocks fit relative to contract tests and end-to-end tests?**
A: Mocks make unit and component tests fast and deterministic but prove nothing about the outside world. Contract tests prove the two sides agree on a schema without needing both deployed. End-to-end tests prove the wired system works but are slow and flaky, so keep only a handful of critical-journey ones. The healthy shape is many mocked component tests, a full layer of contract tests, and a thin cap of e2e plus a nightly live-sandbox smoke run.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Test doubles replace an HTTP dependency you do not control. Prefer mocking at the **wire** (a local mock server on a real socket) over mocking your own client class, because that keeps serialization, headers, timeouts, and retries under test. Stubs give canned answers and you assert on state; mocks assert on the interaction; fakes are simplified working implementations. The chronic risk is **drift** — beat it by generating mocks from the provider's OpenAPI file (Prism, Microcks), adding consumer-driven contract tests (Pact), and running a nightly suite against the real sandbox as an alarm. Always stub the unhappy paths: `429` with `Retry-After`, `5xx`, timeouts, and connection resets, since that is where retry and circuit-breaker bugs hide. A **sandbox** is the outward-facing version of the same idea: same artefact as production with side-effecting adapters swapped by a flag, documented magic values for every branch, unmistakable `sk_test_` credentials, `"livemode": false` in every body, a per-developer request log, and a self-service reset.

| Tool / concept | Use it for | Watch out for |
|---|---|---|
| `respx` / `nock` / `responses` | Fast in-process unit tests | Socket, TLS, proxy paths untested |
| WireMock / MockServer | Real HTTP, faults, latency, stateful scenarios | Stub JSON is a second codebase |
| Prism / Microcks | Spec-derived mock + request validation | Needs rich `examples` in the spec |
| Pact | Consumer-driven contracts between internal services | Needs a broker and org buy-in |
| VCR cassettes | Realistic captured bodies | Rot and secret leakage |
| Sandbox | External developer onboarding | Parity, isolation, and reset discipline |
| `Prefer: code=402` | Ask a mock for a specific response | Not honoured by all mock servers |
| `POST /__admin/reset` | Per-test isolation without restarting | Forgetting it leaks state across tests |

Flash cards:
- **Stub vs mock?** → Stub returns canned data (assert state); mock asserts on the interaction itself.
- **Best layer to mock an upstream?** → The HTTP wire, so the real client, timeouts, and retries stay under test.
- **Biggest risk of any double?** → Drift — it encodes a belief about someone else's API that nothing re-verifies.
- **Four responses every external call needs a test for?** → `429` + `Retry-After`, `5xx`, timeout, connection reset.
- **One field that saves sandbox users from disaster?** → `"livemode": false` in every response body.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Take any public OpenAPI file, run `prism mock … --errors`, and write one test that passes and one that the mock rejects with `422` because the request violates the schema.
- [ ] Configure a WireMock scenario that returns `429` twice with `Retry-After: 1` then `201`, and assert your client retried exactly twice and reused the same `Idempotency-Key` on all three requests.
- [ ] Replace an in-process stub in an existing test with a real mock server on loopback; find and fix at least one bug the stub was hiding (a missing header, a wrong content type, an unset timeout).
- [ ] Record a live interaction with a VCR-style library, then deliberately leak a token into the cassette and add a scrubber plus a CI secret-scan that catches it.
- [ ] Measure your suite with a per-test mock container versus one session-scoped container with `__admin/reset` between tests; report the wall-clock difference.

**Mini Project — "Nimbus Payments" sandbox.**
*Goal:* Ship a FastAPI service with a production mode and a sandbox mode built from the same image, plus a test suite that proves the client handles every failure branch.
*Requirements:* An OpenAPI 3.1 spec with rich `examples`; a `SANDBOX` flag that swaps the payment, email, and webhook adapters for deterministic fakes; a documented magic-value table (`…0002` decline, `…9995` insufficient funds, amount `13` → delayed settlement); `"livemode": false` on every sandbox response; `POST /v1/sandbox/reset` per tenant; a per-developer request log endpoint; a pytest suite using respx for unit tests and a session-scoped WireMock container for boundary tests covering `429`, `503`, timeout, and connection reset; a boot-time assertion that refuses to start in sandbox mode if any live credential is present.
*Extension ideas:* Add a test clock (`POST /v1/sandbox/clock/advance`) that fires the settlement webhook sequence with correct ordering and signatures; publish consumer pacts from a small CLI client and verify them in the service's CI; add a nightly GitHub Action that diffs the upstream spec digest and opens a PR when it changes.

---

## 12. Related Topics & Free Learning Resources

Sibling chapters: **API Testing Strategy** (where doubles sit in the pyramid), **Contract Testing & OpenAPI** (spec-driven verification), **API Observability** (correlation IDs that survive a mocked boundary), **Idempotency & Retries** (the behaviour these mocks exist to test), and **Deploying APIs: CI/CD, Blue-Green & Canary** (running mocks and sandboxes in a pipeline).

**Free Learning Resources**
- **Mocks Aren't Stubs** — Martin Fowler · *Intermediate* · the essay that defined the vocabulary; still the clearest statement of state vs. interaction verification. <https://martinfowler.com/articles/mocksArentStubs.html>
- **WireMock Documentation** — WireMock · *Intermediate* · stubbing, stateful scenarios, fault injection, and the request journal, all with runnable examples. <https://wiremock.org/docs/>
- **Prism — OpenAPI mock & validation proxy** — Stoplight · *Beginner→Intermediate* · turn any OpenAPI file into a validating mock server in one command. <https://docs.stoplight.io/docs/prism/>
- **Pact Documentation** — Pact Foundation · *Advanced* · consumer-driven contract testing end to end, including the broker and provider verification. <https://docs.pact.io/>
- **Stripe API — Testing** — Stripe · *Beginner→Intermediate* · the reference design for a public sandbox: test keys, magic card numbers, test clocks, request logs. <https://docs.stripe.com/testing>
- **Twilio — Test Credentials & Magic Numbers** — Twilio · *Beginner* · a compact, well-documented magic-value table worth copying wholesale. <https://www.twilio.com/docs/iam/test-credentials>
- **Microcks** — CNCF Sandbox project · *Intermediate* · mocking and contract testing driven by OpenAPI, AsyncAPI, and Postman collections. <https://microcks.io/documentation/>
- **Testcontainers** — AtomicJar/Docker · *Intermediate* · run WireMock and real databases as disposable containers from your test code. <https://testcontainers.com/>

---

*REST API Handbook — chapter 37.*
