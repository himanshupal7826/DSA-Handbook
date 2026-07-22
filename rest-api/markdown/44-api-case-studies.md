# 44 · Case Studies: Stripe, GitHub & Twilio

> **In one line:** The best public APIs win not by inventing new HTTP but by being relentlessly consistent about a handful of hard things — versioning, errors, pagination, idempotency and the first five minutes of developer experience.

---

## 1. Overview

There is a small set of APIs that engineers cite as "the good ones": **Stripe**, **GitHub**, **Twilio**, and a second tier including Slack, Shopify and Cloudflare. When you actually read their docs side by side, the striking thing is how *unexciting* their choices are. None of them is a HATEOAS showcase. None uses exotic status codes. What they share is discipline: every endpoint errors the same way, every collection paginates the same way, every mutation is safe to retry, and every breaking change has a migration path measured in years.

This chapter dissects those three APIs as engineering artifacts. It matters for two reasons. First, **imitation is cheap and correct** — you do not need to re-derive pagination semantics when Stripe has already run the experiment across a decade and a million integrations. Second, this is the single most common source of API design interview questions: "How would you version an API?" has a much stronger answer when you can say *"Stripe pins each account to the version it first called, and maintains request/response transformation shims between versions — here's the trade-off that buys and here's what it costs them."*

The three are usefully different in shape. **Stripe** is a money API: correctness under retry is existential, so idempotency keys and version pinning are its defining features. **GitHub** is a huge, deeply-nested resource graph with enormous read volume: conditional requests, rate-limit transparency and the eventual pivot to GraphQL define it. **Twilio** is a telecom API where the interesting traffic goes *outbound* — webhooks, signed callbacks and asynchronous status transitions are its core. Together they cover most of the design space a real API lives in.

A little history. Stripe launched in 2011 with the then-radical idea that payments should be a `curl` command; its dated-version scheme (`2024-06-20`) appeared early and has never been abandoned. GitHub's v3 REST API (2012) became the informal reference implementation of "good REST," then GitHub shipped GraphQL v4 in 2016 explicitly because REST could not serve their over-fetching problem — and, importantly, **kept both**. Twilio's API shipped in 2008 with a design that still shows its age (form-encoded requests, `PascalCase` parameters, `.json` extensions) and is a useful lesson in what you carry forever once you promise not to break clients.

**Concrete example of what discipline buys.** A Stripe integration written in 2015 against version `2015-04-07` still works today, unmodified, because Stripe stores the version each account first used and runs the response through transformation code that reshapes modern objects back into the 2015 shape. That is an enormous ongoing engineering cost, deliberately paid, in exchange for the thing that actually sells a payments API: *your integration will not break.*

## 2. Core Concepts

- **Date-based (pinned) versioning** — each API account is bound to the version current when it integrated; upgrades are opt-in and per-request overridable via a header (`Stripe-Version: 2024-06-20`).
- **Idempotency key** — a client-generated unique key sent on a mutating request so that retries of the *same* logical operation return the *original* result instead of duplicating it.
- **Cursor pagination** — opaque `starting_after` / `ending_before` (Stripe) or `Link`-header cursors (GitHub) that page by position in an index rather than by offset.
- **Conditional request** — `If-None-Match` with an `ETag` returning `304 Not Modified`; on GitHub a `304` historically did not count against your rate limit, making it the core scaling technique.
- **Expandable object** — a field returned as an ID by default that the client can inflate inline via `?expand[]=customer`, trading a round trip for payload size without a bespoke endpoint.
- **Webhook signature** — an HMAC over a timestamp plus the raw body (`Stripe-Signature`, `X-Twilio-Signature`, `X-Hub-Signature-256`) that proves the callback came from the provider and was not replayed.
- **Sub-resource / nested route** — `/repos/{owner}/{repo}/issues/{number}/comments`: GitHub's convention of expressing ownership through path nesting rather than query filters.
- **Rate-limit headers** — the standard triple (`X-RateLimit-Limit`, `-Remaining`, `-Reset`) plus `Retry-After` on `429`, which turns throttling from a mystery into a client-side scheduling problem.
- **Error taxonomy** — a stable machine-readable error `type` plus a `code`, distinct from the human `message`; Stripe's `card_error` vs `invalid_request_error` vs `api_error` split is the canonical example.
- **Test/live key separation** — visibly distinct credential prefixes (`sk_test_` / `sk_live_`) so a mis-copied key fails loudly rather than charging a real card.

## 3. Theory & Principles

### Stripe's version pinning: the trade-off, precisely

Most APIs version in the URI (`/v1`, `/v2`) and force a migration. Stripe instead makes the version a *property of the account*:

- Every account has a **default version** — the version current on the day of its first API call.
- Any request may override it: `Stripe-Version: 2024-06-20`.
- The server implements exactly **one** current object model. Older versions are produced by chaining **response transformers** and **request transformers**, each a small pure function that converts between version N and N−1.

The theory here is that a version chain of pure transforms is *composable*: to serve version `2015-04-07` from a 2026 object model you apply the transformers between them in order. This is the same idea as database migrations, run at read time.

```
current_object --T_2024_06_20--> ... --T_2015_10_16--> --T_2015_04_07--> response
```

**What it buys:** integrations never break; the team ships object-model changes weekly without coordinating with any customer.
**What it costs:** every breaking change requires writing and permanently maintaining a transformer, plus test fixtures for every supported version. Stripe has hundreds. It also means the *internal* model can never fully forget an old shape. Most organisations should not do this — it is justified when the cost of a broken integration is a failed payment.

### Idempotency: the correctness argument

For any mutating request over an unreliable network, the client cannot distinguish "the request never arrived" from "the response was lost." Retrying is therefore mandatory *and* dangerous. An idempotency key resolves it:

1. Client generates a UUID and sends `Idempotency-Key: <uuid>` with `POST /v1/charges`.
2. Server atomically inserts `(key, account_id, request_fingerprint)` into a store with a unique constraint.
   - **Insert succeeds** → this is the first attempt. Execute, then persist the full response (status + body) against the key.
   - **Insert conflicts, request in flight** → return `409 Conflict` ("a request with this key is currently in progress").
   - **Insert conflicts, request complete, fingerprint matches** → replay the stored response verbatim.
   - **Insert conflicts, fingerprint differs** → `400`/`422` — the same key was reused with a different body, which is a client bug.
3. Keys expire (Stripe: 24 hours). Retries beyond that window are treated as new requests.

The **request fingerprint** (a hash of the body) is what stops the subtle failure where a client reuses a key for a genuinely different operation. Without it, idempotency silently returns the wrong object.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="344" rx="14" fill="#ffffff" stroke="#4f46e5"/>
  <text x="390" y="34" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Idempotency key: the four outcomes of a retried POST</text>

  <rect x="30" y="58" width="120" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="90" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
  <text x="90" y="96" text-anchor="middle" fill="#1e293b" font-size="10">retry with same key</text>

  <rect x="210" y="58" width="180" height="46" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="300" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Atomic INSERT</text>
  <text x="300" y="96" text-anchor="middle" fill="#1e293b" font-size="10">(key, account, fingerprint)</text>

  <line x1="150" y1="81" x2="208" y2="81" stroke="#4f46e5" stroke-width="2" marker-end="url(#idA)"/>

  <rect x="450" y="46" width="300" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="600" y="66" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">1. Insert OK &#8594; first attempt</text>
  <text x="600" y="83" text-anchor="middle" fill="#1e293b" font-size="10">execute, store status+body, return 201</text>

  <rect x="450" y="104" width="300" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="600" y="124" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">2. Conflict, still in flight</text>
  <text x="600" y="141" text-anchor="middle" fill="#1e293b" font-size="10">409 Conflict &#8212; client backs off and retries</text>

  <rect x="450" y="162" width="300" height="46" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="600" y="182" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">3. Conflict, done, fingerprint matches</text>
  <text x="600" y="199" text-anchor="middle" fill="#1e293b" font-size="10">replay stored response verbatim (no side effect)</text>

  <rect x="450" y="220" width="300" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="600" y="240" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">4. Conflict, fingerprint differs</text>
  <text x="600" y="257" text-anchor="middle" fill="#1e293b" font-size="10">400 &#8212; key reused for a different request body</text>

  <line x1="390" y1="81" x2="446" y2="69" stroke="#16a34a" stroke-width="2" marker-end="url(#idA)"/>
  <line x1="390" y1="84" x2="446" y2="127" stroke="#d97706" stroke-width="2" marker-end="url(#idA)"/>
  <line x1="390" y1="88" x2="446" y2="185" stroke="#16a34a" stroke-width="2" marker-end="url(#idA)"/>
  <line x1="390" y1="92" x2="446" y2="243" stroke="#d97706" stroke-width="2" marker-end="url(#idA)"/>

  <rect x="30" y="288" width="720" height="48" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="308" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Key expiry: 24h (Stripe). Scope keys per account. Store the response, not just a flag.</text>
  <text x="390" y="326" text-anchor="middle" fill="#1e293b" font-size="10">The fingerprint is what prevents a reused key from silently returning the wrong object.</text>

  <defs>
    <marker id="idA" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#4f46e5"/>
    </marker>
  </defs>
</svg>
```

### GitHub's conditional-request economics

GitHub's REST API historically granted 5,000 authenticated requests/hour, and — critically — **a `304 Not Modified` did not consume quota**. That single rule reshapes client design. If your poller stores the `ETag` from each response and replays it as `If-None-Match`, a repository that changes once an hour costs you one quota unit per hour instead of sixty. The math:

```
naive poll   : 60 req/hr × 20 repos = 1200 quota/hr   (24% of budget, mostly wasted)
conditional  : 20 changed responses/hr ≈ 20 quota/hr  (0.4% of budget)
```

This is why "use ETags" is not a micro-optimization on GitHub — it's the difference between an integration that scales to hundreds of repos and one that gets throttled at twenty. The general principle: **make the cheap outcome free**, and clients will optimise themselves.

### Twilio's asynchronous truth

A `POST /Messages` to Twilio returns `201` with `"status": "queued"`. The message has *not* been sent. The real lifecycle — `queued → sending → sent → delivered` or `→ failed`/`undelivered` — plays out over seconds to minutes and is reported through **webhooks** to a `StatusCallback` URL you supply. The theory: for operations whose completion depends on third parties (carriers, banks, PSTN), a synchronous response can only ever acknowledge *acceptance*. Trying to model it synchronously produces long-held connections and timeouts that lie.

The correct shape is: `202`/`201` + a resource with a `status` field + a callback + a polling fallback. The client must treat webhooks as **at-least-once and out-of-order**, so it needs idempotent handlers keyed on `(resource_id, status)` and a monotonic ordering rule (Twilio's status enum has a defined progression; never regress a `delivered` message back to `sent` because a delayed callback arrived).

## 4. Architecture & Workflow

Walking one real request through Stripe's shape, end to end — this is the flow to narrate in an interview:

1. **Client builds the request.** `POST /v1/payment_intents`, `Authorization: Bearer sk_live_...`, body `application/x-www-form-urlencoded`, plus a fresh `Idempotency-Key: <uuid4>` generated *before* the first attempt and reused for every retry of that logical operation.
2. **Edge / TLS termination.** The request hits the edge, which enforces TLS 1.2+, checks the key prefix (`sk_live_` vs `sk_test_`) and routes to the live or test data plane. These are separate stores; a test key can never touch real money.
3. **Authentication & account resolution.** The secret key resolves to an account. From the account row the server reads the **pinned API version**, unless the request carries a `Stripe-Version` override.
4. **Request transformation.** If the effective version is older than current, the request body is passed up the transformer chain to the current internal shape.
5. **Idempotency check.** Atomic insert of `(idempotency_key, account_id, fingerprint)`. On conflict, take one of the three conflict branches from §3 and return without touching the payment machinery.
6. **Validation.** Structural validation first (unknown parameters are rejected — Stripe returns `400 invalid_request_error` for a typo'd field, which catches integration bugs immediately rather than silently ignoring them).
7. **Business execution.** Create the PaymentIntent, run fraud scoring, reserve funds. State machine: `requires_payment_method → requires_confirmation → requires_action → processing → succeeded`.
8. **Persist the response against the key.** Status code, headers and full body are stored so a retry can replay them byte-for-byte.
9. **Response transformation.** The current object is passed *down* the transformer chain to the caller's pinned version.
10. **Emit events.** `payment_intent.succeeded` is written to an event log and queued for webhook delivery to every registered endpoint.
11. **Webhook delivery.** Each endpoint gets a `POST` with `Stripe-Signature: t=<unix>,v1=<hmac_sha256>`. Non-`2xx` responses are retried with exponential backoff for up to ~3 days. The receiver must verify the signature over the **raw body** and reject timestamps outside a tolerance window (replay defence).
12. **Client reconciliation.** Because webhooks are at-least-once and can be lost entirely, a correct integration also polls or re-fetches on a schedule. The webhook is an optimisation; the API is the source of truth.

```svg
<svg viewBox="0 0 800 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="784" height="384" rx="14" fill="#ffffff" stroke="#4f46e5"/>
  <text x="400" y="32" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">A payments request end to end: pinning, idempotency, webhooks</text>

  <rect x="24" y="56" width="110" height="72" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="79" y="86" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
  <text x="79" y="103" text-anchor="middle" fill="#1e293b" font-size="10">Idempotency-Key</text>
  <text x="79" y="117" text-anchor="middle" fill="#1e293b" font-size="10">sk_live_ bearer</text>

  <rect x="158" y="56" width="110" height="72" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="213" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Edge</text>
  <text x="213" y="97" text-anchor="middle" fill="#1e293b" font-size="10">TLS, key prefix</text>
  <text x="213" y="111" text-anchor="middle" fill="#1e293b" font-size="10">live vs test</text>
  <text x="213" y="125" text-anchor="middle" fill="#1e293b" font-size="10">data plane split</text>

  <rect x="292" y="56" width="120" height="72" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="352" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Version resolve</text>
  <text x="352" y="97" text-anchor="middle" fill="#1e293b" font-size="10">account pin or</text>
  <text x="352" y="111" text-anchor="middle" fill="#1e293b" font-size="10">Stripe-Version hdr</text>
  <text x="352" y="125" text-anchor="middle" fill="#1e293b" font-size="10">request transform</text>

  <rect x="436" y="56" width="120" height="72" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="496" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Idempotency</text>
  <text x="496" y="97" text-anchor="middle" fill="#1e293b" font-size="10">atomic insert</text>
  <text x="496" y="111" text-anchor="middle" fill="#1e293b" font-size="10">replay or execute</text>
  <text x="496" y="125" text-anchor="middle" fill="#1e293b" font-size="10">24h TTL</text>

  <rect x="580" y="56" width="120" height="72" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="640" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Core ledger</text>
  <text x="640" y="97" text-anchor="middle" fill="#1e293b" font-size="10">fraud score</text>
  <text x="640" y="111" text-anchor="middle" fill="#1e293b" font-size="10">state machine</text>
  <text x="640" y="125" text-anchor="middle" fill="#1e293b" font-size="10">funds reserve</text>

  <line x1="134" y1="92" x2="156" y2="92" stroke="#4f46e5" stroke-width="2" marker-end="url(#csA)"/>
  <line x1="268" y1="92" x2="290" y2="92" stroke="#4f46e5" stroke-width="2" marker-end="url(#csA)"/>
  <line x1="412" y1="92" x2="434" y2="92" stroke="#4f46e5" stroke-width="2" marker-end="url(#csA)"/>
  <line x1="556" y1="92" x2="578" y2="92" stroke="#4f46e5" stroke-width="2" marker-end="url(#csA)"/>

  <rect x="292" y="164" width="264" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="424" y="186" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Persist response against key, then</text>
  <text x="424" y="204" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">response transform down to pinned version</text>

  <line x1="640" y1="128" x2="640" y2="150" stroke="#16a34a" stroke-width="2"/>
  <line x1="640" y1="150" x2="556" y2="150" stroke="#16a34a" stroke-width="2"/>
  <line x1="556" y1="150" x2="556" y2="162" stroke="#16a34a" stroke-width="2" marker-end="url(#csA)"/>
  <line x1="292" y1="190" x2="140" y2="190" stroke="#16a34a" stroke-width="2"/>
  <line x1="140" y1="190" x2="140" y2="130" stroke="#16a34a" stroke-width="2" marker-end="url(#csA)"/>
  <text x="200" y="184" fill="#1e293b" font-size="10">201 Created + PaymentIntent</text>

  <rect x="24" y="248" width="200" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="124" y="272" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Event log</text>
  <text x="124" y="290" text-anchor="middle" fill="#1e293b" font-size="10">payment_intent.succeeded</text>

  <rect x="264" y="248" width="220" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="374" y="272" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Webhook dispatcher</text>
  <text x="374" y="290" text-anchor="middle" fill="#1e293b" font-size="10">HMAC sign, backoff up to ~3 days</text>

  <rect x="524" y="248" width="240" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="644" y="268" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Your endpoint</text>
  <text x="644" y="285" text-anchor="middle" fill="#1e293b" font-size="10">verify sig over raw body, check ts,</text>
  <text x="644" y="299" text-anchor="middle" fill="#1e293b" font-size="10">dedupe on event id, return 2xx fast</text>

  <line x1="224" y1="278" x2="262" y2="278" stroke="#d97706" stroke-width="2" marker-end="url(#csA)"/>
  <line x1="484" y1="278" x2="522" y2="278" stroke="#0ea5e9" stroke-width="2" marker-end="url(#csA)"/>
  <line x1="640" y1="128" x2="700" y2="128" stroke="#d97706" stroke-width="2"/>
  <line x1="700" y1="128" x2="700" y2="228" stroke="#d97706" stroke-width="2"/>
  <line x1="700" y1="228" x2="124" y2="228" stroke="#d97706" stroke-width="2"/>
  <line x1="124" y1="228" x2="124" y2="246" stroke="#d97706" stroke-width="2" marker-end="url(#csA)"/>

  <text x="400" y="336" text-anchor="middle" fill="#1e293b" font-size="11">Webhooks are at-least-once and out-of-order: always reconcile by re-fetching the resource.</text>
  <text x="400" y="356" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">The API is the source of truth; the webhook is only a latency optimisation.</text>

  <defs>
    <marker id="csA" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#4f46e5"/>
    </marker>
  </defs>
</svg>
```

## 5. Implementation

### Stripe: create a charge with idempotency and version pinning

```http
POST /v1/payment_intents HTTP/1.1
Host: api.stripe.com
Authorization: Bearer sk_live_51J2xR...
Idempotency-Key: 9f1c0a2e-6b4d-4d3a-8f11-2a7e5c9b0d64
Stripe-Version: 2024-06-20
Content-Type: application/x-www-form-urlencoded

amount=4999&currency=inr&customer=cus_9Kd2&automatic_payment_methods[enabled]=true&metadata[order_id]=ord_88213
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Request-Id: req_7Zk1QpLmN4
Stripe-Version: 2024-06-20
Idempotency-Key: 9f1c0a2e-6b4d-4d3a-8f11-2a7e5c9b0d64

{
  "id": "pi_3PqR2sE8vK",
  "object": "payment_intent",
  "amount": 4999,
  "currency": "inr",
  "customer": "cus_9Kd2",
  "status": "requires_payment_method",
  "client_secret": "pi_3PqR2sE8vK_secret_9dK2",
  "metadata": { "order_id": "ord_88213" },
  "created": 1751500800
}
```

Two details worth noticing. Stripe returns `200`, not `201`, on create — a deviation from strict REST that they have kept for consistency across a decade; do not copy it, but do notice that consistency beat correctness in their calculus. And `Request-Id` is echoed on every response: support tickets quote it and Stripe can find the exact request. That header costs nothing and is the highest-ROI thing in this chapter.

Stripe's error shape:

```json
{
  "error": {
    "type": "card_error",
    "code": "card_declined",
    "decline_code": "insufficient_funds",
    "message": "Your card has insufficient funds.",
    "param": "payment_method",
    "doc_url": "https://stripe.com/docs/error-codes/card-declined",
    "request_log_url": "https://dashboard.stripe.com/logs/req_7Zk1QpLmN4"
  }
}
```

The taxonomy is the lesson: `type` says *who is at fault* (`card_error` = the customer's bank, `invalid_request_error` = your code, `api_error` = Stripe's fault, `rate_limit_error` = slow down). That single field lets a client decide whether to retry, surface to the user, or page an engineer — without string-matching a message.

### GitHub: conditional requests and `Link` pagination

```http
GET /repos/octocat/hello-world/issues?per_page=100&state=open HTTP/1.1
Host: api.github.com
Authorization: Bearer ghp_...
Accept: application/vnd.github+json
X-GitHub-Api-Version: 2022-11-28
If-None-Match: W/"a4f2c9e17b3d8e0c5a1f"
```

```http
HTTP/1.1 304 Not Modified
ETag: W/"a4f2c9e17b3d8e0c5a1f"
X-RateLimit-Limit: 5000
X-RateLimit-Remaining: 4998
X-RateLimit-Reset: 1751504400
X-RateLimit-Used: 2
```

On a change you get `200` plus `Link` pagination:

```http
HTTP/1.1 200 OK
ETag: W/"b7e1d40c92aa16f8"
Link: <https://api.github.com/repositories/1296269/issues?per_page=100&page=2>; rel="next",
      <https://api.github.com/repositories/1296269/issues?per_page=100&page=5>; rel="last"
X-RateLimit-Remaining: 4997
```

The `Link` header (RFC 8288) keeps pagination cursors *out of the body*, so the response body is a pure array of resources. It also means clients follow URLs rather than constructing them — a rare, genuinely useful piece of HATEOAS in the wild.

```python
import httpx

def iter_issues(repo: str, token: str):
    """Follow Link rel=next; never build page URLs yourself."""
    url = f"https://api.github.com/repos/{repo}/issues?per_page=100&state=open"
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    with httpx.Client(timeout=30) as client:
        while url:
            r = client.get(url, headers=headers)
            if r.status_code == 403 and r.headers.get("X-RateLimit-Remaining") == "0":
                raise RuntimeError(f"rate limited until {r.headers['X-RateLimit-Reset']}")
            r.raise_for_status()
            yield from r.json()
            url = r.links.get("next", {}).get("url")   # httpx parses RFC 8288 for you
```

### Twilio: async send, then a signed status webhook

```bash
curl -X POST "https://api.twilio.com/2010-04-01/Accounts/$AC/Messages.json" \
  -u "$AC:$AUTH_TOKEN" \
  --data-urlencode "To=+919876543210" \
  --data-urlencode "From=+14155552671" \
  --data-urlencode "Body=Your OTP is 481920" \
  --data-urlencode "StatusCallback=https://api.zariya.in/hooks/twilio/status"
```

```json
{
  "sid": "SM9f2c1a4b7e6d",
  "status": "queued",
  "to": "+919876543210",
  "from": "+14155552671",
  "date_created": "Tue, 22 Jul 2026 06:11:04 +0000",
  "error_code": null,
  "uri": "/2010-04-01/Accounts/ACxx/Messages/SM9f2c1a4b7e6d.json"
}
```

Note the API's age showing through: `PascalCase` form parameters, a `.json` suffix instead of content negotiation, RFC 2822 dates instead of ISO 8601, and the account SID in the path. None of these are good choices today — but Twilio cannot change them, which is precisely the lesson. **Your first ten design decisions are the ones you keep forever.**

Verifying the callback signature (Twilio signs a concatenation of the URL and the sorted POST parameters, unlike Stripe/GitHub which sign the raw body):

```python
import hmac, hashlib, base64
from fastapi import APIRouter, Request, HTTPException

router = APIRouter()

def twilio_signature(auth_token: str, url: str, params: dict[str, str]) -> str:
    payload = url + "".join(k + params[k] for k in sorted(params))
    digest = hmac.new(auth_token.encode(), payload.encode("utf-8"), hashlib.sha1).digest()
    return base64.b64encode(digest).decode()

@router.post("/hooks/twilio/status")
async def twilio_status(request: Request):
    form = dict(await request.form())
    expected = twilio_signature(AUTH_TOKEN, str(request.url), form)
    if not hmac.compare_digest(expected, request.headers.get("X-Twilio-Signature", "")):
        raise HTTPException(status_code=403, detail="bad signature")

    sid, status = form["MessageSid"], form["MessageStatus"]
    # At-least-once + out-of-order: only move forward through the lifecycle.
    RANK = {"queued": 0, "sending": 1, "sent": 2, "delivered": 3,
            "undelivered": 3, "failed": 3}
    await messages.advance_status_if_newer(sid, status, RANK[status])
    return Response(status_code=204)      # ack fast; do real work off the request path
```

> **Optimization note:** All three APIs reward the same client behaviour: **reuse connections, page with the maximum `per_page`, and make the no-change case free**. On GitHub, ETag-conditional polling of 200 repositories drops from 12,000 to ~200 quota units per hour. On Stripe, `?expand[]=customer&expand[]=latest_charge` collapses three round trips into one — but expanding is server-side work, so expand only what you render; do not build a generic client that expands everything. And always set an explicit client timeout (Stripe's own SDKs default to ~80 s with 2 automatic retries on connection errors, safe *only* because of idempotency keys).

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Stripe date-pinned versions | Integrations never break; the team ships weekly without customer coordination | A permanent transformer per breaking change; hundreds of version fixtures to test |
| Stripe `200`-on-create | Perfect consistency across every endpoint | Deviates from RFC 9110 `201`+`Location`; loses free semantics for caches and tooling |
| Stripe expandable fields | One round trip instead of three, no bespoke endpoints | Server-side fan-out cost; unbounded expansion is a self-inflicted N+1 |
| GitHub `Link` pagination | Cursors stay out of the body; clients follow URLs, not string-building | Clients that ignore `Link` and construct pages break on any change |
| GitHub free `304`s | Turns polling from expensive to nearly free; scales integrations 10× | Only works if clients store ETags — most naive clients do not |
| GitHub REST + GraphQL both | Simple things stay simple; complex graph reads stop over-fetching | Two APIs to maintain, two auth surfaces, two sets of docs, permanent divergence |
| Twilio async + webhooks | Honest about carrier latency; no long-held connections | Every consumer must build a public HTTPS endpoint, signature verification and reconciliation |
| Twilio's 2008 conventions | Never broke a customer in 17 years | `PascalCase`, `.json` suffixes, RFC 2822 dates forever; new hires trip on all of them |
| Test/live key prefixes | Catastrophic mistakes fail loudly and instantly | Doubles the data plane: two stores, two dashboards, two sets of webhooks |

## 7. Common Mistakes & Best Practices

1. ⚠️ Copying Stripe's `200` on resource creation because "Stripe does it." → ✅ Return `201` with a `Location` header. Stripe's choice is legacy consistency, not a design recommendation; they would not choose it today.
2. ⚠️ Generating a new idempotency key on each retry. → ✅ Generate the key **once per logical operation**, before the first attempt, and persist it with the operation so a process restart reuses it.
3. ⚠️ Storing only a "seen" flag for an idempotency key. → ✅ Store the full status code and response body, and a fingerprint of the request. Replay must be byte-identical, and a mismatched fingerprint must be a `400`.
4. ⚠️ Trusting webhooks as the source of truth. → ✅ Treat them as at-least-once, out-of-order latency hints; always reconcile by re-fetching the resource, and run a sweeper for missed events.
5. ⚠️ Verifying a webhook signature over a re-serialised JSON body. → ✅ Sign and verify the **raw bytes**. Any framework that parses and re-encodes JSON before you hash it will produce a different digest and silently fail in production.
6. ⚠️ Ignoring the webhook timestamp. → ✅ Reject signatures whose timestamp is outside a tolerance (Stripe suggests 5 minutes); otherwise a captured payload can be replayed forever.
7. ⚠️ Doing real work inside the webhook handler. → ✅ Verify, enqueue, return `2xx` in milliseconds. Slow handlers cause provider timeouts, which cause retries, which cause duplicate work.
8. ⚠️ Constructing GitHub pagination URLs by incrementing `?page=`. → ✅ Follow `Link; rel="next"` until it is absent. Offset pages also drift under concurrent inserts, silently skipping and duplicating rows.
9. ⚠️ Polling GitHub without `If-None-Match`. → ✅ Cache the `ETag` per URL and send it; `304` responses were free against the rate limit and remain dramatically cheaper.
10. ⚠️ Treating `403` from GitHub as an authorization failure. → ✅ Check `X-RateLimit-Remaining: 0` and `Retry-After` first — GitHub historically returned `403`, not `429`, for primary rate limits, and secondary limits still surface unpredictably.
11. ⚠️ Returning a human message as your only error signal. → ✅ Ship a stable machine-readable `type`/`code` pair like Stripe's. Clients must never regex your prose; messages get reworded, codes must not.
12. ⚠️ Silently ignoring unknown request parameters. → ✅ Reject them with `400`, as Stripe does. A typo'd parameter that is silently dropped becomes a production incident weeks later; rejecting it becomes a five-second fix.
13. ⚠️ Assuming a `201` from Twilio means the SMS was delivered. → ✅ `queued` means accepted. Model the full lifecycle and only mark success on `delivered`.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Every one of these APIs gives you a correlation handle, and every one of your integrations should log it: Stripe's `Request-Id: req_...`, GitHub's `X-GitHub-Request-Id`, Twilio's resource `Sid`. Log the triple `(our_request_id, provider_request_id, idempotency_key)` on every outbound call — it turns "the charge failed sometime last Tuesday" into a single indexed lookup, and it is the first thing provider support will ask for. Stripe additionally exposes a **request log** in the dashboard with the exact body it received, which resolves most "but I sent that field" arguments in seconds; build the same thing for your own API.

**Monitoring.** For each upstream provider track: request rate and error rate split *by error `type`* (a spike in `card_error` is a business event, a spike in `api_error` is an incident, a spike in `invalid_request_error` means you just deployed a bug); p95/p99 latency; `X-RateLimit-Remaining` as a gauge, alerting at 20% of budget rather than at exhaustion; idempotent-replay rate (a rising replay rate means your network or timeouts are degrading); and webhook health — `webhook_received_total`, `webhook_signature_failures_total` (should be zero; non-zero means either an attack or a rotated secret), and delivery-to-processing lag. Alert on **event-to-reconcile gap**: any resource whose webhook never arrived within N minutes should be swept and re-fetched.

**Security.** Secret keys are bearer credentials — anyone holding one is you. Never place them in query strings (they land in access logs, proxies and `Referer` headers), never in a browser or mobile app, and rotate them on a schedule with an overlap window. Use restricted keys where offered so a reporting job cannot create charges. Verify every webhook's HMAC with a **constant-time comparison** over raw bytes plus a timestamp window, and keep the endpoint's URL unguessable but never treat obscurity as the control. Keep test and live credentials visually distinct and enforce in CI that no `sk_live_` string ever appears in a repository. Finally, the OWASP API Security Top 10 item that bites integrators hardest here is BOLA: when you proxy provider objects to your own users, re-check ownership on *your* side — a `payment_intent` ID from your database is not authorization to show it to whoever asked.

**Performance & Scaling.** Use one pooled, keep-alive HTTPS client per provider; TLS handshakes dominate latency at low volume. Retry only idempotent operations, or non-idempotent ones that carry an idempotency key, and use exponential backoff **with jitter** — synchronized retries after a provider blip are how a partial outage becomes a total one. Respect `Retry-After` exactly rather than applying your own schedule. For high-volume reads, cache aggressively behind ETags and prefer bulk/expanded fetches over N+1 loops. And design your own API with the same properties you rely on in theirs: a stable request ID, an idempotency contract, transparent rate-limit headers, and a machine-readable error taxonomy.

## 9. Interview Questions

**Q: How does Stripe's versioning scheme work and why is it unusual?**
A: Each account is pinned to the API version current at its first request, and can override per-request with a `Stripe-Version` header. The server implements one current object model and produces older shapes by chaining pure request/response transformers. It is unusual because most APIs version in the URI and force migrations; Stripe instead absorbs the compatibility cost permanently so integrations never break.

**Q: What exactly does an idempotency key guarantee?**
A: That retrying the same logical mutation with the same key produces the original outcome exactly once, and returns the original response rather than creating a duplicate. The server records the key with a fingerprint of the request; a matching retry replays the stored response, an in-flight duplicate gets `409`, and a key reused with a different body is a `400`.

**Q: Why does GitHub use the `Link` header for pagination instead of putting cursors in the body?**
A: `Link` (RFC 8288) keeps the response body a clean array of resources and lets clients follow provider-constructed URLs rather than assembling query strings. It means GitHub can change the underlying pagination mechanism without breaking any client that follows `rel="next"`.

**Q: Why did a `304 Not Modified` not count against GitHub's rate limit, and what behaviour does that incentivise?**
A: Because a `304` costs GitHub almost nothing — no serialisation, no payload — so charging for it would only push clients toward wasteful unconditional polling. It incentivises clients to store `ETag`s and send `If-None-Match`, which can cut a polling integration's quota consumption by an order of magnitude.

**Q: What does Twilio's `"status": "queued"` on a `201` actually mean?**
A: It means the request was accepted, not that the message was sent. Delivery depends on carriers and completes asynchronously through `sending → sent → delivered` (or `failed`/`undelivered`), reported via a `StatusCallback` webhook. A correct integration only treats `delivered` as success.

**Q: How should a client verify a webhook signature, and what are the two classic mistakes?**
A: Compute an HMAC over the exact raw request bytes (plus the provider's timestamp) using the shared secret and compare in constant time. The two classic mistakes are hashing a re-serialised JSON body instead of the raw bytes, and ignoring the timestamp so old captured payloads can be replayed indefinitely.

**Q: What makes Stripe's error format better than a plain message string?**
A: It separates a stable machine-readable `type` and `code` from the human `message`, adds `param` to point at the offending field, and includes `doc_url` and a request-log link. `type` tells the client who is at fault — customer, integrator, or Stripe — which is enough to decide between showing an error, fixing code, or retrying.

**Q: Why do these APIs use prefixed IDs like `cus_`, `pi_`, `SM`?**
A: Type-prefixed opaque IDs make it impossible to pass a customer ID where a payment ID is expected without an immediate, obvious error; they are self-describing in logs and support tickets; and being opaque they hide sequence information and let the provider change the underlying key format freely.

**Q: (Senior) What would you copy from Stripe and what would you deliberately not copy?**
A: Copy: idempotency keys with stored responses, the error taxonomy, `Request-Id` on every response, expandable fields, test/live key separation, and rejecting unknown parameters. Do not copy: `200` on create instead of `201`+`Location`, form-encoded request bodies, and — for most companies — full date-pinned versioning, whose permanent transformer maintenance is only justified when a broken integration means lost money.

**Q: (Senior) GitHub shipped GraphQL in 2016 but kept REST. What does that tell you about the choice?**
A: That the two solve different problems and the right answer at scale is often "both." REST wins for simple, cacheable, well-known resources and for the long tail of casual integrators using `curl`. GraphQL wins when clients need deeply nested, client-shaped reads that REST answers only with over-fetching or dozens of round trips. The cost is real — two auth surfaces, two rate-limit models (GitHub's GraphQL limit is point-based, not request-based), two doc sets — so it's a decision to make once you have evidence of over-fetching, not upfront.

**Q: (Senior) Design the idempotency layer for a payments API. What are the failure modes?**
A: Key the store on `(account_id, idempotency_key)` with a unique constraint, store request fingerprint, status, headers and body, and a state of `in_flight`/`complete` with a TTL of about 24 hours. Failure modes: the classic crash *after* side effect but *before* persisting the response — solve by writing the key row in the same transaction as the side effect, or by making the downstream call itself idempotent; lock contention on hot keys — bound with a short in-flight timeout that returns `409`; key collisions across tenants — solved by scoping to the account; and unbounded growth — solved by TTL eviction with a partitioned table.

**Q: (Senior) A client reports duplicate charges. Walk through the diagnosis.**
A: First check whether the two charges share an idempotency key: if they do, the server's dedupe is broken — likely a non-atomic check-then-insert or a key store partitioned inconsistently. If they have different keys, the client is generating a new key per retry, which is the far more common bug; confirm by correlating client request IDs and timestamps. Then check the window: if the retries were more than 24 hours apart the key had expired, which is correct behaviour and means the client's retry policy is wrong. Finally check whether an upstream timeout caused the client to retry a request that actually succeeded — the signature is a first charge with a `200` the client never received.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Stripe = **correctness under retry**: idempotency keys with stored responses, date-pinned per-account versions served through transformer chains, a `type`/`code` error taxonomy that says who is at fault, `Request-Id` on everything, expandable fields, and `sk_test_`/`sk_live_` separation. GitHub = **read scale**: `Link`-header cursor pagination you follow rather than construct, `ETag`/`If-None-Match` conditional requests where `304` was free against the quota, transparent `X-RateLimit-*` headers, deep path nesting, and REST plus GraphQL side by side. Twilio = **asynchronous truth**: `201` means *accepted*, real state arrives by signed `StatusCallback` webhook, and seventeen years of `PascalCase` parameters prove you keep your first design decisions forever. Across all three the transferable rules are: one error shape, one pagination style, retry-safe mutations, a correlation ID on every response, and honest rate-limit headers.

| Provider | Versioning | Pagination | Errors | Retry safety | Async |
|---|---|---|---|---|---|
| Stripe | Date, pinned per account | `starting_after` cursor | `type`+`code`+`doc_url` | `Idempotency-Key`, 24h | Webhooks, HMAC over raw body |
| GitHub | `X-GitHub-Api-Version` date header | `Link` rel=next/last | `message`+`errors[]`+`documentation_url` | ETag conditional writes | Webhooks, `X-Hub-Signature-256` |
| Twilio | URI date `2010-04-01` (frozen) | `PageSize` + `next_page_uri` | `code`+`message`+`more_info` | `Idempotency-Key` on some APIs | `StatusCallback`, `X-Twilio-Signature` |

| Header | Meaning |
|---|---|
| `Idempotency-Key` | Client-generated UUID; retries replay the original response |
| `Stripe-Version` / `X-GitHub-Api-Version` | Per-request version override |
| `Request-Id` / `X-GitHub-Request-Id` | Correlation handle — log it on every call |
| `X-RateLimit-Remaining` / `-Reset` | Budget gauge; alert at 20%, not at zero |
| `Link: <...>; rel="next"` | Follow it; never build the next page URL |
| `Stripe-Signature: t=...,v1=...` | HMAC over `timestamp.raw_body`; check the window |

- **Stripe's defining idea** → the version is a property of the *account*, not the URL.
- **Idempotency needs three things** → a key, a request fingerprint, and the stored response.
- **GitHub's scaling lever** → free `304`s make conditional polling ~10× cheaper than naive polling.
- **Twilio's lesson** → `201 queued` is acceptance, not delivery; webhooks carry the real state.
- **Universal rule** → `type`/`code` for machines, `message` for humans; never regex the prose.

## 11. Hands-On Exercises & Mini Project

- [ ] Fetch a Stripe test charge with a deliberately invalid parameter and a valid one; diff the two error bodies and map each field of the error object to a client decision (retry / show user / page oncall).
- [ ] Write a GitHub poller that stores `ETag`s per URL and reports quota used with and without `If-None-Match` over 30 minutes across ten repositories. Chart the difference.
- [ ] Implement Stripe, GitHub and Twilio webhook signature verification in one file and write a test for each that (a) passes on a genuine payload, (b) fails when one byte of the body changes, and (c) fails when the timestamp is an hour old.
- [ ] Send the *same* `Idempotency-Key` to Stripe's test mode twice with identical bodies, then once with a changed `amount`. Record all three status codes and bodies.
- [ ] Read Twilio's `Messages` resource docs and write down every design choice you would make differently today, with the reason it cannot now be changed.

**Mini Project — "API Autopsy: a comparative teardown."**
*Goal:* Produce a rigorous, evidence-backed comparison of three public APIs and turn the findings into a style guide you would actually adopt.
*Requirements:*
1. Pick Stripe, GitHub and one of Twilio/Slack/Shopify. For each, capture *real* request/response pairs (test credentials) covering: create a resource, list with pagination, trigger a validation error, trigger a `404`, and hit a rate limit.
2. Build a comparison matrix across nine dimensions: base URL and versioning, auth, ID format, request encoding, error shape, pagination, idempotency, rate limiting, and async/webhook model.
3. Write a small client library against one of them that correctly implements ETag caching (or idempotency keys, if the API has no conditional requests), retry with jittered exponential backoff honouring `Retry-After`, and a typed error hierarchy derived from their error `type`.
4. Produce a 2-page style guide for a hypothetical new API that states, for each of the nine dimensions, what you would adopt, what you would reject, and why — citing the specific evidence you captured.

*Extensions:* implement the Stripe transformer-chain idea in miniature — one object model, two version transformers, a `X-Api-Version` header that picks the output shape; add a webhook receiver with signature verification, at-least-once dedupe on event ID, and a reconciliation sweeper that re-fetches any resource whose event never arrived.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *API Versioning Strategies* for the family of schemes Stripe's date-pinning belongs to; *Idempotency & Retries* for the mechanism in depth; *Pagination Patterns* for cursor-vs-offset reasoning behind GitHub's `Link` header; *Webhooks & Event-Driven APIs* for delivery guarantees and signature verification; *Rate Limiting & Throttling* for the algorithms behind those headers; *REST API System Design (Interview)* (chapter 45) where these patterns get assembled into whole designs.

**Free Learning Resources**
- **Stripe API Reference** — Stripe · *Intermediate* · the canonical example of an API reference; read the idempotency, versioning and error-codes sections in full. <https://docs.stripe.com/api>
- **Stripe: Idempotent Requests** — Stripe · *Intermediate* · the clearest public specification of idempotency-key semantics, including conflict and expiry behaviour. <https://docs.stripe.com/api/idempotent_requests>
- **GitHub REST API Documentation** — GitHub · *Intermediate* · study "Best practices for using the REST API," conditional requests and rate limits. <https://docs.github.com/en/rest/using-the-rest-api>
- **Twilio Messaging API Docs** — Twilio · *Beginner* · the message lifecycle and `StatusCallback` model, plus signature validation. <https://www.twilio.com/docs/messaging/api/message-resource>
- **RFC 8288 — Web Linking** — IETF · *Intermediate* · the normative definition of the `Link` header GitHub paginates with. <https://www.rfc-editor.org/rfc/rfc8288>
- **RFC 9110 — HTTP Semantics** — IETF · *Advanced* · the reference for safety, idempotency, conditional requests and status-code meaning. <https://www.rfc-editor.org/rfc/rfc9110>
- **Zalando RESTful API Guidelines** — Zalando SE · *Intermediate* · a public style guide that codifies most of what these three APIs do well, as enforceable rules. <https://opensource.zalando.com/restful-api-guidelines/>
- **OWASP API Security Top 10** — OWASP · *Intermediate* · the risk checklist to apply both to APIs you consume and to the one you are copying these patterns into. <https://owasp.org/API-Security/editions/2023/en/0x11-t10/>

---

*REST API Handbook — chapter 44.*
