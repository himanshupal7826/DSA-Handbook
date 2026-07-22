# 45 · REST API System Design (Interview)

> **In one line:** An API design round is 45 minutes of controlled scoping — clarify, model resources, write the endpoint table, defend the hard mechanics (idempotency, pagination, auth, failure), and only then talk about scale.

---

## 1. Overview

The "design an API" interview is not the same round as "design Twitter." A distributed-systems round rewards you for talking about sharding, replication and consensus. An **API design round** rewards you for producing a *contract* — a table of endpoints with methods, status codes, request and response shapes — and then defending the semantics of that contract against realistic failure. Interviewers who run this round consistently report the same failure mode: candidates jump to Kafka and Redis in minute four and never write down a single endpoint.

The structure that works is fixed and you should run it deliberately every time. **Minutes 0–5: clarify.** Who calls this — first-party mobile, third-party partners, both? What are the top three operations by volume? Is any of it money or PII? What's the read:write ratio? **Minutes 5–10: resources and nouns.** Name the entities and their relationships out loud; this is where you demonstrate modelling ability. **Minutes 10–25: the endpoint table.** Method, path, purpose, success status, key error statuses. This is the artifact the interviewer is grading. **Minutes 25–35: the hard mechanics** — idempotency, pagination, concurrency control, auth and authorization, and what happens when a dependency is down. **Minutes 35–45: scale and operations** — back-of-envelope capacity, caching, rate limits, and the one bottleneck you'd fix first.

This chapter works three canonical designs end to end, chosen because between them they cover almost every mechanic an interviewer can probe: a **payments API** (idempotency, state machines, money correctness, webhooks), a **social feed API** (cursor pagination, fan-out, caching, personalisation) and a **file-upload API** (presigned URLs, multipart, resumability, moving bytes off your servers). If you can run these three cleanly you can run almost any variation — booking, messaging, notifications, orders — because they're recombinations of the same parts.

One framing to carry throughout: **an API is a contract, and the interviewer is testing whether you understand what you are promising.** Every design decision below is defensible in one sentence about what the client can rely on. "`PUT` is a full replacement and is idempotent, so a retried timeout is safe" is a better answer than any amount of architecture diagramming.

**Concrete example of the difference.** Asked to design a payments API, a weak answer proposes `POST /pay` and moves on to database replication. A strong answer says: "`POST /v1/payments` with a required `Idempotency-Key`; `201` with `Location`; the resource carries a `status` that walks a defined state machine; refunds are a sub-resource, not a mutation; and money is an integer minor-unit amount plus an ISO 4217 currency, never a float." That is thirty seconds and it demonstrates more than twenty minutes of boxes and arrows.

## 2. Core Concepts

- **Endpoint table** — the deliverable of an API design round: method, path, purpose, auth scope, success code, error codes. Write it on the board early and refine it.
- **Resource modelling** — choosing the nouns and their nesting. `/orders/{id}/refunds` expresses ownership; `/refunds?order_id=` expresses a query. Prefer nesting one level deep, then flatten.
- **Idempotency key** — a client-supplied unique token on a mutating request so retries return the original result instead of duplicating the side effect.
- **Cursor (keyset) pagination** — paging by an opaque encoding of the last item's sort key rather than an offset; stable under concurrent inserts and O(1) rather than O(offset).
- **Optimistic concurrency** — `ETag` + `If-Match` on writes, returning `412 Precondition Failed` on a stale write and `428 Precondition Required` when the client omits the guard entirely.
- **Presigned URL** — a time-limited, signature-bearing URL that lets a client `PUT` bytes directly to object storage without those bytes passing through your API.
- **Fan-out on write vs read** — precomputing each user's feed at post time (fast reads, expensive for celebrity accounts) versus merging followee timelines at request time (cheap writes, slow reads).
- **State machine resource** — a resource whose `status` field walks a documented, one-directional set of transitions; clients branch on `status`, never on inferred fields.
- **Capacity estimate** — QPS, payload size, storage growth and connection count derived from user counts and behaviour, used to justify a design choice rather than to show off arithmetic.
- **Back-pressure** — the API's ability to say "slow down" honestly: `429` with `Retry-After`, bounded page sizes, and quota headers, instead of degrading silently.

## 3. Theory & Principles

### The scoping questions that change the design

Three answers reshape everything; ask them in the first five minutes.

1. **Who is the client?** A first-party mobile app lets you ship breaking changes with a forced-upgrade prompt, use compact payloads, and rely on a BFF. Third-party partners mean permanent versioning, generous deprecation windows, sandbox credentials, and an error taxonomy stable enough to be regexed by someone you'll never meet.
2. **What is the read:write ratio?** 1000:1 (a feed) pushes you to caching, denormalisation and cursor pagination. 1:1 (payments) pushes you to correctness mechanics: idempotency, concurrency control, audit trails.
3. **Is anything irreversible?** Money moved, an SMS sent, a file deleted. Irreversible operations need idempotency keys, explicit confirmation states, and asynchronous status modelling. Reversible ones can be simple.

### Method semantics are the load-bearing decision

From **RFC 9110**: `GET`, `HEAD`, `OPTIONS`, `TRACE` are **safe** (no intended side effect). `GET`, `HEAD`, `PUT`, `DELETE` plus the safe methods are **idempotent** (N identical requests have the same effect as one). `POST` and `PATCH` are neither. This is not trivia — it dictates what infrastructure may retry on your behalf:

| Method | Safe | Idempotent | Retryable by a proxy? |
|---|---|---|---|
| `GET` / `HEAD` | ✅ | ✅ | Yes |
| `PUT` | ❌ | ✅ | Yes |
| `DELETE` | ❌ | ✅ | Yes (second call returns `404`/`204`) |
| `POST` | ❌ | ❌ | **Only with an idempotency key** |
| `PATCH` | ❌ | ❌ (JSON Merge Patch usually is; JSON Patch with `add` to an array is not) | Only with a key or `If-Match` |

So: any `POST` that moves money, sends a message or charges a card **must** accept `Idempotency-Key`. Say this sentence in the interview; it is the single highest-signal line in the payments design.

### Pagination: why offset dies and cursors cost

Offset pagination executes `ORDER BY created_at DESC LIMIT 20 OFFSET 100000` — the database must produce and discard 100,000 rows. Cost is **O(offset)**. Worse, it is *incorrect* under concurrent writes: insert one row at the head while a client is between page 3 and page 4, and every subsequent row shifts by one — the client sees one item twice and never sees another.

Keyset (cursor) pagination instead asks for "the next 20 rows strictly after this sort key":

```sql
SELECT * FROM posts
WHERE (created_at, id) < ($last_created_at, $last_id)   -- tuple comparison breaks ties
ORDER BY created_at DESC, id DESC
LIMIT 21;                                                -- fetch n+1 to know has_more
```

With an index on `(created_at DESC, id DESC)` this is **O(log n + page_size)** regardless of depth, and it is stable: newly inserted rows appear ahead of the cursor and simply are not seen in this pass, which is the correct behaviour for a feed. The cost you accept is **no random access** — you cannot jump to "page 500" — and the cursor must encode the full sort tuple, so changing the sort order invalidates every outstanding cursor. Encode it opaquely (base64 of a signed JSON blob) so clients cannot construct one and you can change the internals.

```svg
<svg viewBox="0 0 780 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="334" rx="14" fill="#ffffff" stroke="#4f46e5"/>
  <text x="390" y="32" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Offset drifts under concurrent inserts; keyset does not</text>

  <text x="200" y="60" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">OFFSET 3 LIMIT 3</text>
  <rect x="60" y="72" width="280" height="30" fill="#fef3c7" stroke="#d97706"/>
  <text x="200" y="92" text-anchor="middle" fill="#1e293b" font-size="11">t0 rows: A B C | D E F | G H I</text>
  <rect x="60" y="112" width="280" height="30" fill="#fef3c7" stroke="#d97706"/>
  <text x="200" y="132" text-anchor="middle" fill="#1e293b" font-size="11">page 1 read: A B C</text>
  <rect x="60" y="152" width="280" height="30" fill="#fef3c7" stroke="#d97706"/>
  <text x="200" y="172" text-anchor="middle" fill="#1e293b" font-size="11">NEW row Z inserted at head</text>
  <rect x="60" y="192" width="280" height="46" fill="#fef3c7" stroke="#d97706"/>
  <text x="200" y="211" text-anchor="middle" fill="#1e293b" font-size="11">rows now: Z A B | C D E | F G H</text>
  <text x="200" y="229" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">page 2 read: C D E &#8212; C is a duplicate</text>
  <rect x="60" y="248" width="280" height="30" fill="#fef3c7" stroke="#d97706"/>
  <text x="200" y="268" text-anchor="middle" fill="#1e293b" font-size="11">cost: DB discards OFFSET rows &#8594; O(offset)</text>

  <text x="580" y="60" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">WHERE (ts,id) &lt; cursor LIMIT 3</text>
  <rect x="440" y="72" width="280" height="30" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="580" y="92" text-anchor="middle" fill="#1e293b" font-size="11">t0 rows: A B C | D E F | G H I</text>
  <rect x="440" y="112" width="280" height="30" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="580" y="132" text-anchor="middle" fill="#1e293b" font-size="11">page 1 read: A B C, cursor = key(C)</text>
  <rect x="440" y="152" width="280" height="30" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="580" y="172" text-anchor="middle" fill="#1e293b" font-size="11">NEW row Z inserted at head</text>
  <rect x="440" y="192" width="280" height="46" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="580" y="211" text-anchor="middle" fill="#1e293b" font-size="11">seek to key(C), continue</text>
  <text x="580" y="229" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">page 2 read: D E F &#8212; no dup, no gap</text>
  <rect x="440" y="248" width="280" height="30" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="580" y="268" text-anchor="middle" fill="#1e293b" font-size="11">cost: index seek &#8594; O(log n + page)</text>

  <rect x="60" y="292" width="660" height="38" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="310" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Trade-off: keyset gives up random access (no "jump to page 500") and ties cursors to one sort order.</text>
  <text x="390" y="325" text-anchor="middle" fill="#1e293b" font-size="10">Encode cursors opaquely (signed base64) so clients cannot forge them and you can change the internals.</text>
</svg>
```

### Capacity arithmetic you should do out loud

Interviewers want to see that numbers drive decisions, not that you memorised them. The three that matter:

```
QPS       = DAU × actions_per_user_per_day / 86,400
peak QPS  ≈ 3× average (diurnal) — size for peak, not average
storage/y = writes_per_day × bytes_per_row × 365 × replication_factor
```

Worked once so the pattern is clear: 10M DAU, each opening the feed 12×/day → 120M reads/day → **~1,390 QPS average, ~4,200 peak**. At 20 posts × 400 bytes per response that's ~8 KB/response → **~34 MB/s egress at peak**, which is nothing for a CDN and a lot for a single database. That single calculation is the justification for a feed cache; state it that way.

## 4. Architecture & Workflow

A design-round answer needs one system walkthrough. Use this generic path and specialise it per design:

1. **Client → edge.** TLS terminates at the CDN/edge. Static and cacheable `GET`s (public profiles, media) are served here; nothing else is.
2. **Edge → API gateway.** The gateway authenticates the bearer token (JWT signature + `exp` + audience, or an opaque token introspected against a cache), applies the per-key rate limit, attaches `X-Request-Id` if absent, and routes by path prefix.
3. **Gateway → service.** The service validates the request body against the schema and returns `400` for malformed syntax, `422` for syntactically valid but semantically invalid content.
4. **Authorization inside the service.** Authentication happened at the gateway; **object-level authorization must happen here**, next to the data — "does this caller own this order?" A gateway cannot answer that, and pretending otherwise is how you get OWASP API1 (BOLA).
5. **Idempotency / concurrency guard.** For mutating requests: check the idempotency key, or evaluate `If-Match` against the current `ETag` and return `412` if stale.
6. **Service → datastore.** Write in a transaction that includes both the domain change and the idempotency record, so a crash cannot leave them inconsistent.
7. **Emit an event.** Publish a domain event (`payment.succeeded`, `post.created`) transactionally via an outbox table, so the event cannot be lost or emitted for a rolled-back write.
8. **Response.** `201` + `Location` for creation, `200` + body for reads and updates, `202` + `Location` to a status resource for accepted-async work, `204` for successful deletes with nothing to say.
9. **Asynchronous workers.** Consume the outbox: deliver webhooks with HMAC signatures and backoff, fan out feed entries, run virus scans on uploads, settle payments with the processor.
10. **Client reconciliation.** For anything async, the client either polls the status resource (with `Retry-After` guiding the interval) or receives a webhook — and treats webhooks as at-least-once hints on top of the polling truth.

```svg
<svg viewBox="0 0 800 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="784" height="384" rx="14" fill="#ffffff" stroke="#4f46e5"/>
  <text x="400" y="32" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Reference topology for an API design round</text>

  <rect x="24" y="56" width="96" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="72" y="82" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Clients</text>
  <text x="72" y="99" text-anchor="middle" fill="#1e293b" font-size="10">app / partner</text>

  <rect x="144" y="56" width="96" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="192" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">CDN / edge</text>
  <text x="192" y="95" text-anchor="middle" fill="#1e293b" font-size="10">TLS, cache</text>
  <text x="192" y="109" text-anchor="middle" fill="#1e293b" font-size="10">public GETs</text>

  <rect x="264" y="56" width="116" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="322" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">API gateway</text>
  <text x="322" y="92" text-anchor="middle" fill="#1e293b" font-size="10">authn, rate limit</text>
  <text x="322" y="106" text-anchor="middle" fill="#1e293b" font-size="10">X-Request-Id, route</text>

  <rect x="404" y="56" width="140" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="474" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Service</text>
  <text x="474" y="92" text-anchor="middle" fill="#1e293b" font-size="10">validate, authorize obj</text>
  <text x="474" y="106" text-anchor="middle" fill="#1e293b" font-size="10">idempotency / If-Match</text>

  <rect x="568" y="56" width="112" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="624" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Primary DB</text>
  <text x="624" y="95" text-anchor="middle" fill="#1e293b" font-size="10">domain write +</text>
  <text x="624" y="109" text-anchor="middle" fill="#1e293b" font-size="10">outbox, one txn</text>

  <line x1="120" y1="86" x2="142" y2="86" stroke="#4f46e5" stroke-width="2" marker-end="url(#sdA)"/>
  <line x1="240" y1="86" x2="262" y2="86" stroke="#4f46e5" stroke-width="2" marker-end="url(#sdA)"/>
  <line x1="380" y1="86" x2="402" y2="86" stroke="#4f46e5" stroke-width="2" marker-end="url(#sdA)"/>
  <line x1="544" y1="86" x2="566" y2="86" stroke="#4f46e5" stroke-width="2" marker-end="url(#sdA)"/>

  <rect x="404" y="146" width="140" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="474" y="168" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Cache (Redis)</text>
  <text x="474" y="186" text-anchor="middle" fill="#1e293b" font-size="10">feeds, tokens, quotas</text>

  <rect x="568" y="146" width="112" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="624" y="168" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Read replicas</text>
  <text x="624" y="186" text-anchor="middle" fill="#1e293b" font-size="10">list endpoints</text>

  <line x1="474" y1="116" x2="474" y2="144" stroke="#0ea5e9" stroke-width="2" marker-end="url(#sdA)"/>
  <line x1="624" y1="116" x2="624" y2="144" stroke="#0ea5e9" stroke-width="2" marker-end="url(#sdA)"/>

  <rect x="24" y="228" width="200" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="124" y="252" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Object storage</text>
  <text x="124" y="270" text-anchor="middle" fill="#1e293b" font-size="10">presigned PUT, bytes bypass API</text>

  <rect x="252" y="228" width="200" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="352" y="252" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Outbox relay</text>
  <text x="352" y="270" text-anchor="middle" fill="#1e293b" font-size="10">exactly-once publish to queue</text>

  <rect x="480" y="228" width="200" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="580" y="248" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Workers</text>
  <text x="580" y="265" text-anchor="middle" fill="#1e293b" font-size="10">fan-out, webhooks, scans,</text>
  <text x="580" y="279" text-anchor="middle" fill="#1e293b" font-size="10">settlement, transcode</text>

  <line x1="72" y1="116" x2="72" y2="256" stroke="#d97706" stroke-width="2" marker-end="url(#sdA)"/>
  <line x1="624" y1="198" x2="624" y2="212" stroke="#16a34a" stroke-width="2"/>
  <line x1="352" y1="212" x2="624" y2="212" stroke="#16a34a" stroke-width="2"/>
  <line x1="352" y1="212" x2="352" y2="226" stroke="#16a34a" stroke-width="2" marker-end="url(#sdA)"/>
  <line x1="452" y1="258" x2="478" y2="258" stroke="#16a34a" stroke-width="2" marker-end="url(#sdA)"/>

  <rect x="24" y="308" width="656" height="66" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="352" y="330" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Status codes to say out loud: 201+Location on create &#183; 202+Location for async &#183; 204 on delete</text>
  <text x="352" y="348" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">400 syntax &#183; 422 semantics &#183; 401 unauthenticated &#183; 403 unauthorized &#183; 409 conflict</text>
  <text x="352" y="366" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">412 stale If-Match &#183; 428 guard required &#183; 429 + Retry-After</text>

  <defs>
    <marker id="sdA" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#4f46e5"/>
    </marker>
  </defs>
</svg>
```

## 5. Implementation

### Design 1 — Payments API

**Scope stated back to the interviewer:** merchants charge a customer's saved payment method; charges are asynchronous at the processor; refunds are partial or full; every mutation must survive network retries; merchants receive webhooks.

**Resources:** `PaymentMethod`, `Payment` (a state machine), `Refund` (sub-resource of Payment), `Event` (webhook log).

| Method | Path | Purpose | Auth scope | Success | Errors |
|---|---|---|---|---|---|
| `POST` | `/v1/payment_methods` | Tokenize/attach a card | `pm:write` | `201` + `Location` | `400`, `422`, `429` |
| `GET` | `/v1/payment_methods?customer_id=&limit=&cursor=` | List a customer's methods | `pm:read` | `200` | `401`, `403`, `404` |
| `DELETE` | `/v1/payment_methods/{id}` | Detach | `pm:write` | `204` | `404`, `409` (in use) |
| `POST` | `/v1/payments` | Create & attempt a charge | `pay:write` | `201` + `Location` | `400`, `402`, `409`, `422`, `429` |
| `GET` | `/v1/payments/{id}` | Read one payment | `pay:read` | `200` + `ETag` | `401`, `403`, `404` |
| `GET` | `/v1/payments?status=&created_after=&limit=&cursor=` | List payments | `pay:read` | `200` | `400`, `403` |
| `POST` | `/v1/payments/{id}/capture` | Capture an authorized payment | `pay:write` | `200` | `409` (wrong state), `422` |
| `POST` | `/v1/payments/{id}/cancel` | Void before capture | `pay:write` | `200` | `409` |
| `POST` | `/v1/payments/{id}/refunds` | Full or partial refund | `refund:write` | `201` + `Location` | `409`, `422` |
| `GET` | `/v1/payments/{id}/refunds` | List refunds | `refund:read` | `200` | `404` |
| `POST` | `/v1/webhook_endpoints` | Register a callback URL | `hook:write` | `201` | `422` |
| `GET` | `/v1/events?type=&limit=&cursor=` | Replay past events | `event:read` | `200` | `403` |

**State machine** (say it out loud; clients branch on `status`, nothing else):

```
requires_payment_method → requires_confirmation → processing → succeeded
                                              ↘ requires_action → processing
processing → failed
succeeded → partially_refunded → refunded
any pre-capture state → canceled
```

```http
POST /v1/payments HTTP/1.1
Host: api.zariya.in
Authorization: Bearer sk_live_9d2f...
Idempotency-Key: 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0
Content-Type: application/json

{
  "amount": 249900,
  "currency": "INR",
  "customer_id": "cus_7Kd2Qa",
  "payment_method_id": "pm_1Nq8Zx",
  "capture_method": "automatic",
  "description": "Order ord_88213",
  "metadata": { "order_id": "ord_88213" }
}
```

```http
HTTP/1.1 201 Created
Location: /v1/payments/pay_3PqR2sE8vK
Content-Type: application/json
ETag: "v1-9a3f2c"
X-Request-Id: req_7Zk1QpLmN4

{
  "id": "pay_3PqR2sE8vK",
  "object": "payment",
  "amount": 249900,
  "amount_refunded": 0,
  "currency": "INR",
  "status": "processing",
  "customer_id": "cus_7Kd2Qa",
  "payment_method_id": "pm_1Nq8Zx",
  "failure_code": null,
  "created_at": "2026-07-22T06:11:04Z",
  "metadata": { "order_id": "ord_88213" }
}
```

> **Note:** `amount` is an **integer in the currency's minor unit** (249900 = ₹2,499.00) with an explicit ISO 4217 `currency`. Never a float — `0.1 + 0.2 != 0.3` in IEEE-754 and you will lose money. Also note there is no `PUT /v1/payments/{id}`: a payment is not editable, only advanced through its state machine via sub-actions.

A declined card is **not** a `4xx` about your request — the request was perfect. Use `402 Payment Required` with RFC 9457 problem details:

```http
HTTP/1.1 402 Payment Required
Content-Type: application/problem+json

{
  "type": "https://errors.zariya.in/card-declined",
  "title": "Card declined",
  "status": 402,
  "detail": "The issuing bank declined this charge.",
  "instance": "/v1/payments/pay_3PqR2sE8vK",
  "code": "card_declined",
  "decline_code": "insufficient_funds",
  "payment_id": "pay_3PqR2sE8vK",
  "retryable": false
}
```

The idempotency layer, written as the interviewer will want to see it:

```python
import hashlib, json
from fastapi import APIRouter, Header, HTTPException, Response
from sqlalchemy.exc import IntegrityError

router = APIRouter()

@router.post("/v1/payments", status_code=201)
async def create_payment(body: PaymentCreate, response: Response,
                         idempotency_key: str = Header(..., alias="Idempotency-Key"),
                         account=Depends(current_account), db=Depends(session)):
    fingerprint = hashlib.sha256(
        json.dumps(body.model_dump(), sort_keys=True).encode()).hexdigest()

    try:
        # Atomic claim. UNIQUE (account_id, key) is what makes this correct.
        await db.execute(insert(IdempotencyRecord).values(
            account_id=account.id, key=idempotency_key,
            fingerprint=fingerprint, state="in_flight"))
        await db.commit()
    except IntegrityError:
        await db.rollback()
        rec = await db.get_idempotency(account.id, idempotency_key)
        if rec.fingerprint != fingerprint:
            raise HTTPException(400, "Idempotency-Key reused with a different body")
        if rec.state == "in_flight":
            raise HTTPException(409, "A request with this key is in progress")
        response.status_code = rec.status_code          # replay verbatim
        return json.loads(rec.response_body)

    # Domain write and outbox event in ONE transaction — no lost events.
    payment = await payments.create(db, account, body)
    await db.execute(insert(Outbox).values(
        topic="payment.created", payload=payment.to_event()))
    await db.execute(update(IdempotencyRecord)
        .where(...).values(state="complete", status_code=201,
                           response_body=payment.model_dump_json()))
    await db.commit()

    response.headers["Location"] = f"/v1/payments/{payment.id}"
    return payment
```

**Capacity.** 50k merchants, 2M payments/day → **23 QPS average, ~70 peak** — trivially small, which is the point: payments APIs are correctness-bound, not throughput-bound. Storage: 2M rows/day × ~1.5 KB (payment + audit + idempotency) × 365 ≈ **1.1 TB/year** before replication; partition by month and archive cold months to object storage. Idempotency records at 24-hour TTL peak at ~2M rows — keep them in the primary database, not Redis, because they must be in the same transaction as the write.

### Design 2 — Social Feed API

**Scope:** users follow users; a home feed is a reverse-chronological (then ranked) merge of followees' posts; 10M DAU; read:write ≈ 500:1; feeds must be paginated stably and infinitely.

| Method | Path | Purpose | Success | Errors |
|---|---|---|---|---|
| `POST` | `/v1/posts` | Create a post | `201` + `Location` | `400`, `422`, `429` |
| `GET` | `/v1/posts/{id}` | Read one post | `200` + `ETag` | `404`, `410` (deleted) |
| `DELETE` | `/v1/posts/{id}` | Delete own post | `204` | `403`, `404` |
| `GET` | `/v1/feed?limit=20&cursor=` | Home timeline (personalised) | `200` | `401`, `429` |
| `GET` | `/v1/users/{id}/posts?limit=&cursor=` | Author timeline (cacheable) | `200` | `404` |
| `PUT` | `/v1/users/{id}/following/{target_id}` | Follow (idempotent by design) | `204` | `403`, `404`, `409` (self) |
| `DELETE` | `/v1/users/{id}/following/{target_id}` | Unfollow | `204` | `404` |
| `GET` | `/v1/users/{id}/followers?limit=&cursor=` | Follower list | `200` | `404` |
| `PUT` | `/v1/posts/{id}/like` | Like (idempotent) | `204` | `404`, `429` |
| `DELETE` | `/v1/posts/{id}/like` | Unlike | `204` | `404` |
| `GET` | `/v1/posts/{id}/comments?limit=&cursor=` | Comments | `200` | `404` |

Note `PUT`/`DELETE` for follow and like rather than `POST /follow` and `POST /unfollow`. A like is a **set membership**, and set membership is naturally idempotent — a double-tap from a flaky mobile connection must not produce two likes or an error. This one choice usually earns more credit than the entire architecture discussion.

```http
GET /v1/feed?limit=20 HTTP/1.1
Host: api.zariya.in
Authorization: Bearer eyJhbGciOiJFUzI1NiIs...
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, max-age=15
X-RateLimit-Remaining: 4871

{
  "data": [
    {
      "id": "post_01J8Z3",
      "author": { "id": "usr_29", "handle": "asha", "avatar_url": "https://cdn.zariya.in/a/29.webp" },
      "text": "Shipped cursor pagination today.",
      "media": [],
      "like_count": 42,
      "liked_by_me": true,
      "comment_count": 7,
      "created_at": "2026-07-22T05:58:11Z"
    }
  ],
  "pagination": {
    "next_cursor": "eyJ0IjoiMjAyNi0wNy0yMlQwNTo1ODoxMVoiLCJpIjoicG9zdF8wMUo4WjMifQ",
    "has_more": true
  }
}
```

```python
import base64, json
from datetime import datetime

def encode_cursor(created_at: datetime, post_id: str) -> str:
    raw = json.dumps({"t": created_at.isoformat(), "i": post_id}, separators=(",", ":"))
    return base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")

@router.get("/v1/feed")
async def feed(limit: int = Query(20, ge=1, le=100),      # ALWAYS bound the page size
               cursor: str | None = None,
               user=Depends(current_user), db=Depends(session)):
    after = decode_cursor(cursor) if cursor else None
    rows = await db.fetch(
        """
        SELECT p.* FROM feed_entries f JOIN posts p ON p.id = f.post_id
        WHERE f.user_id = $1
          AND ($2::timestamptz IS NULL OR (p.created_at, p.id) < ($2, $3))
        ORDER BY p.created_at DESC, p.id DESC
        LIMIT $4
        """,
        user.id, after and after["t"], after and after["i"], limit + 1,  # n+1 trick
    )
    has_more = len(rows) > limit
    rows = rows[:limit]
    return {
        "data": [serialize(r) for r in rows],
        "pagination": {
            "next_cursor": encode_cursor(rows[-1].created_at, rows[-1].id) if has_more else None,
            "has_more": has_more,
        },
    }
```

**Fan-out decision — the hybrid answer.** Fan-out on write (push a `feed_entries` row to every follower at post time) gives O(1) reads but a celebrity with 30M followers generates 30M writes for one post. Fan-out on read (merge followees' timelines per request) gives cheap writes but a 5,000-way merge per feed load. The production answer is **hybrid**: fan out on write for accounts below a follower threshold (say 100k), and for accounts above it, don't fan out — merge their recent posts into the feed at read time from a small, hot, per-celebrity cache. A user follows at most a handful of celebrities, so the read-time merge is a 2–5-way merge, not a 5,000-way one.

**Capacity.** 10M DAU × 12 feed opens = 120M reads/day → **1,390 QPS avg, ~4,200 peak**. Writes: 10M × 0.5 posts = 5M posts/day → 58 QPS, but with an average 500 followers that is **~29k fan-out writes/sec at peak** — which is exactly why the celebrity threshold exists. Feed cache: 10M users × 500 entries × 32 bytes ≈ **160 GB** in Redis; cap materialised feeds at 500–1,000 entries and fall back to a database query for deep scrolls, which almost nobody does.

### Design 3 — File Upload API

**Scope:** users upload files from 1 KB to 5 GB; uploads must resume across network failures; the API server must never proxy the bytes; files are virus-scanned and thumbnailed before becoming available.

The central insight to state immediately: **do not stream gigabytes through your API servers.** Issue a presigned URL and let the client `PUT` directly to object storage. Your API handles metadata and authorization only.

| Method | Path | Purpose | Success | Errors |
|---|---|---|---|---|
| `POST` | `/v1/uploads` | Create an upload session; returns presigned URL(s) | `201` + `Location` | `400`, `413` (too large), `422`, `429` |
| `GET` | `/v1/uploads/{id}` | Session status, parts received | `200` | `404`, `410` (expired) |
| `POST` | `/v1/uploads/{id}/parts` | Get more presigned part URLs | `200` | `404`, `409` (completed) |
| `POST` | `/v1/uploads/{id}/complete` | Finalize multipart, supply part ETags | `202` + `Location` to file | `409`, `422` (checksum mismatch) |
| `DELETE` | `/v1/uploads/{id}` | Abort, release parts | `204` | `404` |
| `GET` | `/v1/files/{id}` | File metadata + processing status | `200` + `ETag` | `404`, `403` |
| `GET` | `/v1/files/{id}/content` | Redirect to a short-lived download URL | `302` + `Location` | `403`, `404`, `409` (still scanning) |
| `DELETE` | `/v1/files/{id}` | Delete file | `204` | `403`, `404` |
| `GET` | `/v1/files?folder_id=&limit=&cursor=` | List files | `200` | `403` |

```http
POST /v1/uploads HTTP/1.1
Host: api.zariya.in
Authorization: Bearer eyJhbGciOiJFUzI1NiIs...
Idempotency-Key: 6c3b2a19-8f7e-4d5c-b1a0-9e8d7c6b5a40
Content-Type: application/json

{
  "filename": "quarterly-review.mp4",
  "content_type": "video/mp4",
  "size_bytes": 2147483648,
  "checksum_sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "folder_id": "fld_9Kd2"
}
```

```http
HTTP/1.1 201 Created
Location: /v1/uploads/upl_7Zk1Qp
Content-Type: application/json

{
  "id": "upl_7Zk1Qp",
  "file_id": "fil_3PqR2s",
  "strategy": "multipart",
  "part_size_bytes": 16777216,
  "part_count": 128,
  "expires_at": "2026-07-22T12:11:04Z",
  "parts": [
    { "part_number": 1, "url": "https://s3.ap-south-1.amazonaws.com/bkt/fil_3PqR2s?partNumber=1&uploadId=2~x9&X-Amz-Signature=...", "expires_at": "2026-07-22T12:11:04Z" },
    { "part_number": 2, "url": "https://s3.ap-south-1.amazonaws.com/bkt/fil_3PqR2s?partNumber=2&uploadId=2~x9&X-Amz-Signature=..." }
  ]
}
```

The client `PUT`s each part directly to storage, collects the returned `ETag` per part, and finalizes:

```http
POST /v1/uploads/upl_7Zk1Qp/complete HTTP/1.1
Content-Type: application/json

{ "parts": [ { "part_number": 1, "etag": "\"a54357aff0632cce\"" }, { "part_number": 2, "etag": "\"7c6b1e2f0d9a4413\"" } ] }
```

```http
HTTP/1.1 202 Accepted
Location: /v1/files/fil_3PqR2s
Retry-After: 5

{ "id": "fil_3PqR2s", "status": "processing", "steps": ["checksum", "virus_scan", "thumbnail"] }
```

`202` is the correct code: the bytes are durable but the file is not yet usable. `GET /v1/files/{id}` returns `status: processing → available | quarantined | failed`, and `GET /v1/files/{id}/content` returns `409 Conflict` until the scan clears — never `404`, which would imply the file does not exist.

```python
@router.post("/v1/uploads", status_code=201)
async def create_upload(body: UploadCreate, user=Depends(current_user)):
    if body.size_bytes > MAX_BYTES:
        raise HTTPException(413, "File exceeds the 5 GB limit")
    if body.content_type not in ALLOWED_TYPES:      # allow-list, never a deny-list
        raise HTTPException(422, f"content_type {body.content_type} not permitted")

    key = f"u/{user.id}/{uuid4()}"
    if body.size_bytes <= SINGLE_PUT_MAX:           # 16 MB — one presigned PUT
        url = s3.generate_presigned_url(
            "put_object",
            Params={"Bucket": BUCKET, "Key": key,
                    "ContentType": body.content_type,
                    "ContentLength": body.size_bytes,          # pin the size
                    "ChecksumSHA256": body.checksum_sha256},   # storage verifies for you
            ExpiresIn=3600)
        return {"strategy": "single", "url": url, ...}

    mpu = s3.create_multipart_upload(Bucket=BUCKET, Key=key,
                                     ContentType=body.content_type)
    part_size = max(16 * 1024 * 1024, ceil(body.size_bytes / 10_000))  # S3 caps at 10k parts
    ...
```

> **Optimization note across all three designs.** (1) Bound every list endpoint: `limit` with a hard maximum, or one client will request a million rows and take the database with it. (2) Fetch `limit + 1` rows to compute `has_more` without a second `COUNT(*)` — exact total counts on large tables are the most common hidden full-scan in API code. (3) Never let the API process proxy large payloads; presigned URLs move gigabytes off your compute entirely and turn a bandwidth problem into a signature problem. (4) Cache the *authorization decision*, not just the data — a feed request that re-checks 500 follow relationships per load is the real bottleneck, not the post fetch.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Idempotency keys on every mutation | Retries are safe; duplicate charges become impossible | A key store, a fingerprint check, TTL eviction, and a `409` state clients must handle |
| Cursor pagination | O(log n) at any depth; stable under concurrent inserts | No random access or total count; cursors break if the sort order changes |
| Fan-out on write | O(1) feed reads; trivially cacheable | Celebrity posts cost millions of writes; storage grows with followers × posts |
| Fan-out on read | Cheap writes, no duplication | Feed latency scales with followee count; hard to cache |
| Hybrid fan-out | Bounded on both sides; what production systems actually do | Two code paths, a threshold to tune, and a merge step to test |
| Presigned upload URLs | Bytes bypass your servers entirely; near-zero API cost per GB | Client complexity, signature/expiry handling, and you cannot inspect content in-flight |
| `PUT`/`DELETE` for likes & follows | Naturally idempotent; double-taps are free | Slightly unusual to readers who expect `POST /like` |
| `202` + status resource | Honest about async work; no long-held connections | Clients must poll or receive webhooks; more states to document and test |
| Optimistic concurrency (`If-Match`) | Prevents lost updates without locks | Clients must store and send ETags; `412` handling is extra client work |

## 7. Common Mistakes & Best Practices

1. ⚠️ Drawing architecture before writing a single endpoint. → ✅ Get the endpoint table on the board by minute 15. It is the artifact being graded; everything else is supporting argument.
2. ⚠️ `POST /createPayment`, `POST /cancelOrder`, `GET /getUser`. → ✅ Resources are nouns; the method is the verb. Where an action genuinely isn't a resource, use a sub-resource (`POST /payments/{id}/refunds`) or a controller suffix (`POST /payments/{id}/capture`).
3. ⚠️ Returning `200` with `{"success": false, "error": "..."}`. → ✅ Use the status code as the primary signal and RFC 9457 `application/problem+json` as the body. Proxies, SDKs, dashboards and retry logic all read status codes.
4. ⚠️ Offset pagination on a feed. → ✅ Keyset cursors. When the interviewer asks "what if they want page 500," the correct answer is that infinite scroll never needs it and search/export is a different endpoint with a different mechanism.
5. ⚠️ Unbounded list endpoints (`limit` with no maximum, or no `limit` at all). → ✅ Default 20, hard cap 100, and validate — a `?limit=1000000` is a denial of service you shipped yourself.
6. ⚠️ Using `PUT` to change one field. → ✅ `PUT` is full replacement; a partial `PUT` silently nulls every field the client omitted. Use `PATCH` with JSON Merge Patch (RFC 7396) or JSON Patch (RFC 6902), and document which.
7. ⚠️ Exposing database auto-increment IDs. → ✅ Prefixed opaque IDs (`pay_3PqR2sE8vK`). Sequential integers leak volume, enable enumeration attacks, and lock you to one key format forever.
8. ⚠️ Checking authentication at the gateway and calling it done. → ✅ Object-level authorization happens in the service, next to the data. "Is this caller allowed to read *this* order?" is OWASP API1 (BOLA) and is the most exploited API vulnerability in the wild.
9. ⚠️ Treating a card decline as a `400`. → ✅ The request was valid; the *payment* failed. Use `402` with a machine-readable `decline_code`, and mark whether it is retryable.
10. ⚠️ Storing money as a float or a bare integer with no currency. → ✅ Integer minor units plus an ISO 4217 code, always transported together.
11. ⚠️ Proxying file bytes through the API to "validate them." → ✅ Presigned direct-to-storage upload, then validate asynchronously and gate access on a `status` field. `409` while scanning, not `404`.
12. ⚠️ Skipping capacity numbers, or reciting them without drawing a conclusion. → ✅ Do one calculation and immediately state what it decides: "4,200 peak QPS against a single Postgres is fine for reads with replicas; 29k fan-out writes/sec is not, which is why celebrities are excluded."
13. ⚠️ Designing the happy path only. → ✅ The interviewer's next question is always "what happens when the payment processor times out?" Have the answer ready: idempotency key, `processing` state, reconciliation job, webhook on resolution.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Generate `X-Request-Id` at the gateway if absent, propagate it through every hop and log it on every line; return it on every response including errors. For the payments design, the audit table is the debugging tool: an append-only row per state transition with actor, previous state, new state, processor reference and timestamp — "why is this payment stuck in `processing`" is then a single query rather than a log-grep. For feeds, log the cursor: a bug report of "I see duplicates" is unanswerable without the exact cursor the client sent. For uploads, log the storage key and multipart `uploadId`; the two together resolve almost every "my upload failed at 80%."

**Monitoring.** Golden signals per endpoint, not per service: request rate, error rate split by class (`4xx` is a client/contract problem, `5xx` is yours), duration p50/p95/p99, and saturation. Then design-specific metrics: `idempotent_replay_ratio` (rising means client-side timeouts are degrading), `payment_state_duration_seconds{from,to}` with an alert on anything stuck in `processing` beyond an SLO, `feed_cache_hit_ratio` (below ~90% and your database is about to feel it), `fanout_lag_seconds` (how stale the slowest follower's feed is), `upload_part_failure_rate`, and `presigned_url_expired_total` (non-zero means your expiry window is shorter than real-world upload times on bad networks). Alert on **symptoms users feel** — feed p99 latency, payment success rate — not on CPU.

**Security.** Authenticate at the edge, authorize at the data. Every endpoint taking an object ID needs an explicit ownership check, and the test suite needs a case per endpoint that asserts a `404` (not `403`, which confirms existence) when another tenant's ID is supplied. Rate-limit per API key *and* per user *and* per IP, with the tightest bucket on expensive endpoints — feed reads and upload-session creation deserve different budgets. Presigned URLs must be short-lived (≤1 hour), scoped to a single key, and pin `Content-Length` and `Content-Type` so a client cannot upload a 50 GB file against a session that declared 2 GB. For webhooks, sign with HMAC over the raw body including a timestamp, and give merchants a way to rotate the secret with an overlap window. Never put tokens or PII in query strings; they land in access logs and `Referer` headers.

**Performance & Scaling.** Scale reads with replicas plus a cache, and be explicit that you have chosen read-your-writes as a problem to solve — after `POST /v1/posts`, read the author's own timeline from the primary or serve it from a write-through cache, or the user posts and doesn't see it. Scale writes by partitioning on the natural tenant key (`account_id` for payments, `user_id` for feeds) so a transaction never spans shards. Put a queue between the API and anything slow — fan-out, webhooks, transcoding — and let the API return `202` immediately. When one endpoint becomes the bottleneck, split it out rather than scaling the whole service; the feed read path and the payment write path have almost nothing in common in their resource profile. Finally, shed load deliberately: a `429` with an honest `Retry-After` is a much better failure than a 30-second timeout, and it is the only failure mode a client can actually handle.

## 9. Interview Questions

**Q: How do you structure the first ten minutes of an API design round?**
A: Spend five minutes clarifying who the clients are, the top operations by volume, the read:write ratio, and whether anything is irreversible or involves money or PII. Then spend five minutes naming the resources and their relationships aloud. Only after that start the endpoint table — it should be on the board by minute fifteen because it is the artifact being graded.

**Q: Why must `POST /payments` accept an idempotency key when `PUT /users/{id}` does not?**
A: Because `PUT` is idempotent by definition — repeating it produces the same final state — while `POST` creates a new resource each time. Over an unreliable network the client cannot tell a lost request from a lost response, so it must retry; without a key that retry is a duplicate charge.

**Q: What status code do you return for a declined card, and why?**
A: `402 Payment Required` with an RFC 9457 problem body containing a machine-readable `decline_code` and a `retryable` flag. It's not `400` because the request was syntactically and semantically valid; it's not `500` because nothing broke. The payment itself failed, which is a distinct outcome.

**Q: Design the follow endpoint. Which method?**
A: `PUT /v1/users/{id}/following/{target_id}` returning `204`, with `DELETE` on the same path to unfollow. Following is set membership, which is naturally idempotent — a double-tap on a flaky connection must not create two follows or an error. `POST /follow` forces you to invent conflict handling that `PUT` gives you for free.

**Q: Why is cursor pagination correct for a feed and offset pagination is not?**
A: Offset must produce and discard N rows, so cost grows linearly with depth, and it drifts under concurrent inserts — a new row at the head shifts everything, so the client sees duplicates and misses items. Keyset pagination seeks directly into the index by the last item's sort tuple: constant cost at any depth and stable under inserts.

**Q: How do you handle a file upload of 5 GB?**
A: Never through the API. Create an upload session that returns presigned multipart URLs; the client `PUT`s parts directly to object storage and reports the part ETags to a `complete` endpoint. Respond `202` with a `Location` to the file resource, whose `status` moves `processing → available` once checksum, virus scan and thumbnailing finish.

**Q: What's the difference between `400` and `422`?**
A: `400 Bad Request` is malformed syntax — unparseable JSON, a missing required parameter, a wrong type. `422 Unprocessable Content` is well-formed and understood but semantically invalid — a refund larger than the payment, an end date before a start date. The split lets clients distinguish "my serialiser is broken" from "my business input is wrong."

**Q: When would you return `409` versus `412`?**
A: `409 Conflict` means the request conflicts with the resource's current state — capturing an already-captured payment, refunding a canceled one. `412 Precondition Failed` means the client sent `If-Match` with an ETag that no longer matches, i.e. someone else wrote first. Use `428 Precondition Required` to reject an unconditional write on a resource where you demand a guard.

**Q: (Senior) Walk me through fan-out for a user with 30 million followers.**
A: Don't fan out. Use a hybrid: fan out on write for accounts below a follower threshold (~100k) so ordinary feed reads are a single indexed range scan, and exclude accounts above it. For those, keep a small hot cache of their recent posts and merge it into the feed at read time. Since a user follows only a handful of celebrities, the read-time merge is 2–5 way. The cost is two code paths and a threshold to tune, and you must handle the transition when an account crosses it.

**Q: (Senior) The payment processor times out after we've sent the charge. What does the client see and how does the system converge?**
A: The client sees a timeout and retries with the same idempotency key. The key record is `in_flight`, so the retry gets `409` and backs off. Meanwhile the payment sits in `processing`; a reconciliation worker polls the processor by our idempotency reference on a schedule and resolves it to `succeeded` or `failed`, then emits the event. The invariants are: never re-send without the same key, never expose an unresolved payment as failed, and always converge through reconciliation rather than by guessing at timeout.

**Q: (Senior) How do you evolve the feed response without breaking mobile clients you cannot force to upgrade?**
A: Only additive changes to the response, with a documented must-ignore rule enforced by contract tests that inject unknown fields. Never add a value to a response enum — design status-like fields as open strings with a documented fallback from day one. If a genuinely breaking change is needed, ship it as a new representation negotiated by media type or a version header, run both from one implementation via a response transformer, and drive migration with per-client-version usage metrics rather than a date.

**Q: (Senior) Your feed p99 doubles at peak but p50 is flat. Where do you look?**
A: A flat p50 with a bad p99 says the problem is a tail, not general saturation — so look for per-request variance: cache misses hitting the database, users with unusually large followee sets on the read-merge path, or a hot shard. Break the latency histogram down by cache hit/miss and by followee-count bucket, and check queue depth on any downstream. The common causes are a cache-eviction cliff after a deploy, the celebrity merge path being slower than assumed, and connection-pool saturation causing queueing that only shows in the tail.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Run the clock deliberately: clarify (clients, volumes, irreversibility) → name resources → **endpoint table by minute 15** → hard mechanics → scale. Mutations that are not naturally idempotent take an `Idempotency-Key` with a stored response and a request fingerprint. Lists use **keyset cursors** with a bounded `limit` and `has_more` computed by fetching `limit + 1`. Money is integer minor units plus ISO 4217. Set-membership operations (`like`, `follow`) are `PUT`/`DELETE`, not `POST`. Anything slow or third-party-dependent returns `202` plus a status resource and converges via reconciliation, not guesswork. Large payloads never touch your API — presign and let storage take the bytes. Authenticate at the edge, **authorize next to the data**. Status codes are the contract: `201`+`Location`, `202`, `204`, `400` vs `422`, `401` vs `403`, `409`, `412`, `428`, `429`+`Retry-After`, `402` for a decline.

| Situation | Response |
|---|---|
| Resource created | `201` + `Location` |
| Accepted, work continues | `202` + `Location` to a status resource + `Retry-After` |
| Deleted / no body | `204` |
| Malformed syntax | `400` |
| Valid syntax, invalid semantics | `422` |
| No/invalid credentials | `401` + `WWW-Authenticate` |
| Authenticated but not permitted | `403` (use `404` to avoid leaking existence) |
| Card declined | `402` + `decline_code` |
| State conflict (already captured) | `409` |
| Stale `If-Match` | `412` |
| Unconditional write where a guard is required | `428` |
| Over quota | `429` + `Retry-After` |
| Sunset / permanently gone | `410` |

- **Endpoint table first** → it is the artifact being graded; architecture is supporting argument.
- **`POST` needs a key** → `PUT`/`DELETE` are idempotent for free; `POST` and `PATCH` are not.
- **`limit + 1`** → gives you `has_more` without a `COUNT(*)` full scan.
- **Hybrid fan-out** → push for the many, pull for the celebrities, merge at read time.
- **Presign, don't proxy** → gigabytes go client→storage; your API only signs and records metadata.

## 11. Hands-On Exercises & Mini Project

- [ ] Write the endpoint table for a hotel-booking API (search, hold, confirm, cancel, refund) in under 15 minutes, including success and error status codes for every row. Then justify each idempotency decision in one sentence.
- [ ] Implement keyset pagination over a table of 5 million rows and benchmark it against `OFFSET` at offsets 0, 10,000 and 1,000,000. Record the three query plans.
- [ ] Build the idempotency layer from §5 with a real unique constraint, then write tests for all four outcomes: first call, in-flight duplicate, completed replay, and fingerprint mismatch.
- [ ] Generate a presigned S3/MinIO multipart upload, upload a 200 MB file in 16 MB parts with one part deliberately failed and retried, then complete it and verify the checksum.
- [ ] Take the feed design and compute, for 50M DAU instead of 10M, the peak read QPS, peak fan-out write rate, and Redis feed-cache size. State which component breaks first and what you change.

**Mini Project — "The 45-minute design, three times."**
*Goal:* Build the muscle memory to produce a defensible API contract under time pressure.
*Requirements:*
1. Pick three prompts you have not seen worked: a ride-hailing API, a multi-tenant notifications API, and a document-collaboration API. For each, set a 45-minute timer and produce: scoping questions with assumed answers, a resource model, a full endpoint table with status codes, and three worked `http` request/response exchanges including one error.
2. For each design, write one paragraph each on idempotency, pagination, authorization, and the async/failure path.
3. Do one capacity calculation per design that *changes a decision*, and state the decision it changes.
4. Implement the highest-risk endpoint of one design in FastAPI with real validation, real status codes, RFC 9457 errors, and tests covering the failure branches.

*Extensions:* have someone else read only your endpoint table and try to integrate against a mock generated from it — every question they have to ask is a gap in the contract. Then write the OpenAPI 3.1 document for one design and lint it with Spectral. Finally, take the payments design and add a reconciliation worker that resolves `processing` payments stuck beyond an SLO, with a test that simulates a processor timeout.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *HTTP Methods & Idempotency* for the RFC 9110 rules the payments design leans on; *Pagination Patterns* for cursor encoding in depth; *Idempotency & Retries* for the key store's failure modes; *Rate Limiting & Throttling* for the algorithms behind `429`; *Error Handling & RFC 9457* for problem-details shape; *Case Studies: Stripe, GitHub & Twilio* (chapter 44) for these patterns in production; *Building a Production API End-to-End* (chapter 46) to implement one of these designs fully.

**Free Learning Resources**
- **RFC 9110 — HTTP Semantics** — IETF · *Advanced* · the normative source for safe/idempotent methods, status-code meaning and conditional requests; the single most useful document for this round. <https://www.rfc-editor.org/rfc/rfc9110>
- **RFC 9457 — Problem Details for HTTP APIs** — IETF · *Intermediate* · the error format to use in every design you present. <https://www.rfc-editor.org/rfc/rfc9457>
- **Google API Design Guide** — Google · *Intermediate* · resource-oriented design, standard methods, and custom-method conventions — the vocabulary interviewers expect. <https://cloud.google.com/apis/design>
- **Microsoft REST API Guidelines** — Microsoft · *Intermediate* · concrete rules on pagination, long-running operations (`202` + status resource) and versioning. <https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md>
- **Stripe API Reference — Idempotent Requests** — Stripe · *Intermediate* · the reference specification for the payments design's core mechanic. <https://docs.stripe.com/api/idempotent_requests>
- **AWS S3 Multipart Upload & Presigned URLs** — AWS · *Intermediate* · the exact mechanics behind the upload design, including part-size limits and the 10,000-part cap. <https://docs.aws.amazon.com/AmazonS3/latest/userguide/mpuoverview.html>
- **Use The Index, Luke! — Paging Through Results** — Markus Winand · *Intermediate* · the definitive explanation of why keyset beats offset, with query plans. <https://use-the-index-luke.com/no-offset>
- **OWASP API Security Top 10** — OWASP · *Intermediate* · BOLA, broken function-level authorization and unrestricted resource consumption are the three the interviewer will probe. <https://owasp.org/API-Security/editions/2023/en/0x11-t10/>

---

*REST API Handbook — chapter 45.*
