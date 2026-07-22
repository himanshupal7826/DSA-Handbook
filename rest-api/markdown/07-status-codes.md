# 07 · HTTP Status Codes Done Right

> **In one line:** The status code is the part of your response that machines actually parse — pick it from HTTP's semantics, not from habit, because caches, proxies, retry logic and SDKs all branch on those three digits.

---

## 1. Overview

Every HTTP response carries a three-digit **status code** and a reason phrase on its start line: `HTTP/1.1 201 Created`. That number is the single most load-bearing byte-triplet in your API. Clients branch on it, HTTP caches store or discard on it, proxies and service meshes retry on it, SDK generators map it to exception classes, and your dashboards bucket it into `2xx / 4xx / 5xx` error-rate panels. The response body is for humans and application code; **the status code is the protocol-level contract**.

The problem status codes solve is *uniform, out-of-band error signalling*. Before HTTP standardised them, every protocol invented its own success/failure vocabulary, and every client had to learn a new one. HTTP's five classes give any intermediary — one that knows nothing about your business domain — enough information to act correctly: a `304` means "use your copy", a `503` means "back off and retry", a `401` means "go get credentials". This is REST's **uniform interface** constraint expressed at the wire level.

The lineage runs from RFC 1945 (HTTP/1.0, 1996) through RFC 2616 (1999), the 723x series (2014), and today lands on **RFC 9110 — HTTP Semantics (June 2022)**, which is the single normative source for status-code meaning. RFC 9110 is deliberate about a crucial point: the classes are *extensible*, and a client that receives an unrecognised code **must treat it as the `x00` of its class** — `418` is handled like `400`, `599` like `500`. That rule is why inventing a code is safe-ish but rarely useful.

**Concrete example.** Stripe returns `402 Payment Required` when a card is declined — a code almost nobody else uses — precisely because a declined card is not a malformed request (`400`), not an auth failure (`401`), and not a server bug (`500`). GitHub returns `422 Unprocessable Content` when you POST a syntactically valid JSON issue whose `labels` reference a label that doesn't exist, and `404` (not `403`) for private repositories you cannot see, to avoid leaking their existence. Twilio returns `429` with a `Retry-After` header so its SDKs can sleep exactly the right amount. Each of those choices is a deliberate reading of RFC 9110 and each one changes client behaviour.

The durable mental model: **the class tells the client *who* has to change, and *whether retrying can ever help*.** `2xx` — nobody, done. `3xx` — the client must go somewhere else or use its cache. `4xx` — the client must change the request; retrying the identical bytes will fail identically. `5xx` — the server must change; the identical request may succeed later. Every hard status-code decision resolves once you answer those two questions.

## 2. Core Concepts

- **Status class** — the first digit: `1xx` informational, `2xx` success, `3xx` redirection, `4xx` client error, `5xx` server error. Intermediaries reason on the class alone.
- **Reason phrase** — the trailing text (`Not Found`). Purely advisory; HTTP/2 and HTTP/3 drop it entirely, so never parse it.
- **Retryable vs terminal** — `408`, `429`, `500`, `502`, `503`, `504` invite a retry; every other `4xx` is terminal until the request itself changes.
- **Safe method** — `GET`, `HEAD`, `OPTIONS`, `TRACE`: no intended state change, so intermediaries may retry or prefetch them freely (RFC 9110 §9.2.1).
- **Idempotent method** — `GET`, `HEAD`, `PUT`, `DELETE`, `OPTIONS`, `TRACE`: N identical requests have the same effect as one. `POST` and `PATCH` are not idempotent by default.
- **`Location` header** — the URI of a newly created resource (`201`) or the target of a redirect (`3xx`). Required for a well-formed `201`.
- **Conditional request** — a request carrying `If-None-Match` / `If-Match` / `If-Modified-Since`, whose outcome is `200`, `304`, or `412` depending on validator comparison.
- **Problem Details** — the standard JSON error body defined by **RFC 9457** (`application/problem+json`), which *accompanies* a `4xx`/`5xx` — it never replaces the code.
- **Semantic vs syntactic validity** — `400` means "I could not parse or the request is malformed"; `422` means "I parsed you fine, but the content breaks a business rule".
- **Redirect method preservation** — `301`/`302` historically let clients rewrite `POST` to `GET`; `307`/`308` forbid that rewrite. Use the latter for anything non-`GET`.

## 3. Theory & Principles

RFC 9110 defines status codes as an **enumerated, extensible, class-partitioned** namespace, and the partitioning carries normative force. §15 states that a client "MUST understand the class of any status code" and treat an unrecognised member as the generic `x00`. Practically this means: your gateway does not need a table of every code to decide whether to retry — it needs the first digit plus a small allow-list.

**The two orthogonal axes.** Any correct status choice falls out of a 2×2:

| | Retry can succeed | Retry cannot succeed |
|---|---|---|
| **Client at fault** | `408`, `429` | `400`, `401`, `403`, `404`, `409`, `422` |
| **Server at fault** | `500`, `502`, `503`, `504` | `501` (never implemented), `505` |

Getting the axis wrong is the most expensive class of bug in this chapter. Returning `500` for a validation failure makes your error-budget dashboards lie and triggers automatic retries that can never succeed — a self-inflicted retry storm. Returning `400` for a transient database timeout tells the client to give up on work that would have completed a second later.

**`400` vs `422`.** RFC 9110 §15.5.1 defines `400 Bad Request` as "the server cannot or will not process the request due to something perceived to be a client error (e.g., malformed request syntax, invalid request message framing, or deceptive request routing)". `422 Unprocessable Content` (§15.5.21, imported from WebDAV) covers "the content type and syntax are understood, but the server was unable to process the contained instructions". The clean line: **JSON that doesn't parse, a wrong `Content-Type`, a missing required field, or a type mismatch → `400`; a well-formed document that violates a domain invariant (`end_date` before `start_date`, insufficient balance, unknown enum value in context) → `422`.** Many excellent APIs (Stripe, Google) use `400` for both and put the detail in the body; that is defensible, but pick one rule and hold it API-wide.

**`401` vs `403`.** `401 Unauthorized` means *unauthenticated* — the misnomer is a 1990s accident. It **MUST** be accompanied by a `WWW-Authenticate` header naming the scheme (`Bearer realm="api", error="invalid_token"`); a `401` without that header is technically non-conformant. `403 Forbidden` means *authenticated and understood, but the credential does not grant this*. Re-presenting the same credentials to a `401` is pointless; re-presenting them to a `403` is equally pointless — the difference is that `401` tells the client "go re-authenticate", and `403` tells it "you're the wrong principal".

**`403` vs `404`.** When existence itself is confidential, returning `403` leaks it: an attacker enumerating `/repos/acme/secret-project` learns the repo exists. GitHub's documented policy is to return `404` for resources the caller cannot see. The trade-off is debuggability — a legitimate user with a permissions gap sees a confusing `404`. The usual compromise: `404` across tenant boundaries, `403` within your own tenant.

**Idempotency and status.** A `DELETE` on an already-deleted resource is the classic argument. Both `204` and `404` are defensible. RFC 9110 makes `DELETE` idempotent in *effect* (the resource is gone either way), not in *response code*. Returning `204` on repeat deletes is friendlier to retrying clients and to at-least-once delivery pipelines; returning `404` is more honest. Choose `204` if your clients retry automatically.

**Caching interactions (RFC 9111).** Only some codes are *heuristically cacheable* by default: `200`, `203`, `204`, `206`, `300`, `301`, `308`, `404`, `405`, `410`, `414`, `501`. A surprising consequence: **`404` and `301` are cacheable without any explicit headers**, so a transient `404` during a deploy can be pinned in a CDN for hours. Always send explicit `Cache-Control` on error responses — `Cache-Control: no-store` on a `404` you expect to become a `200`.

```svg
<svg viewBox="0 0 760 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="740" height="340" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Status-code decision tree</text>
  <rect x="290" y="56" width="180" height="38" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="380" y="80" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Did it work?</text>
  <path d="M380 94 L380 116 L160 116 L160 138" fill="none" stroke="#4f46e5" stroke-width="1.6"/>
  <path d="M380 94 L380 116 L600 116 L600 138" fill="none" stroke="#4f46e5" stroke-width="1.6"/>
  <text x="250" y="112" fill="#16a34a" font-size="12" font-weight="700">yes</text>
  <text x="500" y="112" fill="#d97706" font-size="12" font-weight="700">no</text>
  <rect x="60" y="138" width="200" height="38" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="160" y="162" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Is there a body?</text>
  <path d="M160 176 L160 196 L80 196 L80 216" fill="none" stroke="#16a34a" stroke-width="1.6"/>
  <path d="M160 176 L160 196 L245 196 L245 216" fill="none" stroke="#16a34a" stroke-width="1.6"/>
  <rect x="20" y="216" width="120" height="34" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="80" y="238" text-anchor="middle" fill="#1e293b" font-size="12">204 No Content</text>
  <rect x="185" y="216" width="120" height="34" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="245" y="238" text-anchor="middle" fill="#1e293b" font-size="12">200 / 201 / 202</text>
  <text x="160" y="272" text-anchor="middle" fill="#1e293b" font-size="11">201 needs Location</text>
  <text x="160" y="290" text-anchor="middle" fill="#1e293b" font-size="11">202 = queued, not done</text>
  <rect x="500" y="138" width="200" height="38" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="600" y="162" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Who must change?</text>
  <path d="M600 176 L600 196 L520 196 L520 216" fill="none" stroke="#d97706" stroke-width="1.6"/>
  <path d="M600 176 L600 196 L680 196 L680 216" fill="none" stroke="#d97706" stroke-width="1.6"/>
  <rect x="440" y="216" width="160" height="34" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="520" y="238" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">client &#8594; 4xx</text>
  <rect x="620" y="216" width="120" height="34" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="680" y="238" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">server &#8594; 5xx</text>
  <text x="520" y="268" text-anchor="middle" fill="#1e293b" font-size="11">no creds 401 &#183; wrong principal 403</text>
  <text x="520" y="285" text-anchor="middle" fill="#1e293b" font-size="11">unparseable 400 &#183; invalid rule 422</text>
  <text x="520" y="302" text-anchor="middle" fill="#1e293b" font-size="11">state clash 409 &#183; too fast 429</text>
  <text x="680" y="268" text-anchor="middle" fill="#1e293b" font-size="11">bug 500</text>
  <text x="680" y="285" text-anchor="middle" fill="#1e293b" font-size="11">upstream 502</text>
  <text x="680" y="302" text-anchor="middle" fill="#1e293b" font-size="11">overload 503</text>
  <text x="380" y="336" text-anchor="middle" fill="#1e293b" font-size="12" font-style="italic">Rule: 4xx = resending identical bytes fails identically.</text>
</svg>
```

## 4. Architecture & Workflow

Follow a single request through a realistic stack and watch where each status code is *manufactured*. Understanding this is what lets you debug "who returned this 503?".

1. **Client builds the request.** `POST /v1/payments` with `Authorization: Bearer …`, `Content-Type: application/json`, and `Idempotency-Key: 9f2c…`. The SDK has a retry policy keyed on status class.
2. **CDN / edge.** If the URL is cacheable and fresh, the edge answers `200` from cache or `304` after validating an `ETag`. If the edge itself is unhealthy it emits `502`/`504` — these never touched your code, which is why your app logs show nothing.
3. **API gateway — transport checks.** Malformed framing, an oversized body, or a bad TLS SNI produce `400`, `413`, `421`. A gateway-level rate limiter emits `429` with `Retry-After` and `RateLimit-*` headers before your service is invoked.
4. **AuthN filter.** No/expired token → `401` + `WWW-Authenticate: Bearer error="invalid_token"`. Valid token, wrong scope → `403` + `WWW-Authenticate: Bearer error="insufficient_scope", scope="payments:write"`.
5. **Deserialization & schema validation.** JSON that won't parse or a type mismatch → `400` with a Problem Details body listing the pointer (`/amount`). Unsupported `Content-Type` → `415`. Unacceptable `Accept` → `406`.
6. **Business-rule validation.** Amount below the minimum, currency not enabled for the merchant → `422`, with per-field errors.
7. **Concurrency & preconditions.** `If-Match` present and stale → `412 Precondition Failed`. `If-Match` absent on an endpoint that requires it → `428 Precondition Required`.
8. **Domain execution.** Duplicate `Idempotency-Key` replays the stored response verbatim. A unique-constraint clash or an invalid state transition ("already refunded") → `409 Conflict`.
9. **Persistence & downstream calls.** A dependency timeout surfaces as `504` if you are proxying, or `503` + `Retry-After` if you are shedding load. An unexpected exception becomes `500` — with a `traceparent` echoed so the caller can quote it in a support ticket.
10. **Success shaping.** Created synchronously → `201` + `Location: /v1/payments/pay_123` + the representation. Queued for async settlement → `202` + `Location: /v1/jobs/job_77` for polling. Deleted or PUT-with-no-body-worth-returning → `204`.
11. **Response travels back out.** The gateway attaches `RateLimit-Remaining`, the CDN attaches `Age`, and observability middleware records `http.response.status_code` as a metric dimension.

```svg
<svg viewBox="0 0 780 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="760" height="310" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Where each status code is born</text>
  <rect x="30" y="60" width="110" height="60" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="85" y="86" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
  <text x="85" y="104" text-anchor="middle" fill="#1e293b" font-size="10">SDK retry policy</text>
  <rect x="170" y="60" width="110" height="60" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="225" y="86" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">CDN / edge</text>
  <text x="225" y="104" text-anchor="middle" fill="#1e293b" font-size="10">304 502 504</text>
  <rect x="310" y="60" width="110" height="60" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="365" y="86" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Gateway</text>
  <text x="365" y="104" text-anchor="middle" fill="#1e293b" font-size="10">401 403 413 429</text>
  <rect x="450" y="60" width="120" height="60" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="510" y="86" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Service</text>
  <text x="510" y="104" text-anchor="middle" fill="#1e293b" font-size="10">400 409 412 422 500</text>
  <rect x="600" y="60" width="140" height="60" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="670" y="86" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Store / upstream</text>
  <text x="670" y="104" text-anchor="middle" fill="#1e293b" font-size="10">timeout &#8594; 503 504</text>
  <path d="M140 90 L168 90" stroke="#4f46e5" stroke-width="2"/>
  <path d="M280 90 L308 90" stroke="#4f46e5" stroke-width="2"/>
  <path d="M420 90 L448 90" stroke="#4f46e5" stroke-width="2"/>
  <path d="M570 90 L598 90" stroke="#4f46e5" stroke-width="2"/>
  <rect x="30" y="150" width="710" height="60" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="50" y="174" fill="#1e293b" font-size="12" font-weight="700">Success shaping</text>
  <text x="50" y="196" fill="#1e293b" font-size="11">201 + Location (created now) &#183; 202 + Location (queued, poll the job) &#183; 204 (done, nothing to say) &#183; 200 (here is the state)</text>
  <rect x="30" y="228" width="350" height="76" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="50" y="252" fill="#1e293b" font-size="12" font-weight="700">Retry ladder (client side)</text>
  <text x="50" y="272" fill="#1e293b" font-size="11">429 / 503 &#8594; honour Retry-After exactly</text>
  <text x="50" y="290" fill="#1e293b" font-size="11">500 / 502 / 504 &#8594; jittered exponential backoff</text>
  <rect x="400" y="228" width="340" height="76" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="420" y="252" fill="#1e293b" font-size="12" font-weight="700">Never retry blindly</text>
  <text x="420" y="272" fill="#1e293b" font-size="11">non-idempotent POST needs Idempotency-Key</text>
  <text x="420" y="290" fill="#1e293b" font-size="11">4xx other than 408/429 &#8594; terminal, surface it</text>
</svg>
```

## 5. Implementation

A creation flow that gets every code right. First the happy path:

```http
POST /v1/invoices HTTP/1.1
Host: api.zariya.in
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json
Idempotency-Key: 4c9f1e3a-6b2d-4f8e-9a1c-77d0e2b5c001

{"customer_id":"cus_8Kq","currency":"INR","amount_minor":249900,"due_on":"2026-08-15"}
```

```http
HTTP/1.1 201 Created
Location: /v1/invoices/inv_01JQ8Z
ETag: "v1"
Content-Type: application/json
Cache-Control: no-store

{"id":"inv_01JQ8Z","status":"open","currency":"INR","amount_minor":249900,"due_on":"2026-08-15"}
```

Now the failure modes, each with an RFC 9457 Problem Details body:

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{
  "type": "https://api.zariya.in/problems/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "due_on must be in the future",
  "instance": "/v1/invoices",
  "errors": [
    {"pointer": "/due_on", "code": "date_in_past", "message": "must be after 2026-07-22"}
  ]
}
```

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="api.zariya.in", error="invalid_token", error_description="expired"
Content-Type: application/problem+json

{"type":"https://api.zariya.in/problems/unauthenticated","title":"Unauthenticated","status":401}
```

```http
HTTP/1.1 409 Conflict
Content-Type: application/problem+json

{"type":"https://api.zariya.in/problems/invalid-state","title":"Invoice already paid",
 "status":409,"detail":"Invoice inv_01JQ8Z is in state 'paid' and cannot be voided",
 "current_state":"paid","allowed_transitions":["refund"]}
```

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 12
RateLimit-Limit: 1000
RateLimit-Remaining: 0
RateLimit-Reset: 12
Content-Type: application/problem+json

{"type":"https://api.zariya.in/problems/rate-limited","title":"Too Many Requests","status":429}
```

**FastAPI** — a service that returns the right code deliberately rather than by accident:

```python
from fastapi import FastAPI, Header, HTTPException, Request, Response, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from datetime import date

app = FastAPI()
PROBLEM = "application/problem+json"

class InvoiceIn(BaseModel):
    customer_id: str
    currency: str = Field(pattern="^[A-Z]{3}$")
    amount_minor: int = Field(gt=0)
    due_on: date

def problem(status_code: int, type_: str, title: str, **extra):
    body = {"type": f"https://api.zariya.in/problems/{type_}",
            "title": title, "status": status_code, **extra}
    return JSONResponse(body, status_code=status_code, media_type=PROBLEM)

@app.exception_handler(HTTPException)
async def http_exc(_: Request, exc: HTTPException):
    return problem(exc.status_code, "error", exc.detail or "Error")

@app.post("/v1/invoices", status_code=status.HTTP_201_CREATED)
def create_invoice(body: InvoiceIn, response: Response,
                   idempotency_key: str | None = Header(default=None)):
    if idempotency_key is None:
        # 428: we require a precondition the client did not supply
        return problem(428, "idempotency-key-required",
                       "Idempotency-Key header is required")
    if (cached := replay(idempotency_key)) is not None:
        return JSONResponse(cached, status_code=200)
    if body.due_on <= date.today():
        # semantically valid JSON, business rule violated -> 422 (not 400)
        return problem(422, "validation-failed", "Validation failed",
                       errors=[{"pointer": "/due_on", "code": "date_in_past"}])
    if not currency_enabled(body.customer_id, body.currency):
        return problem(422, "currency-not-enabled",
                       f"{body.currency} not enabled for this merchant")
    try:
        inv = repo.insert(body)
    except DuplicateInvoice:
        return problem(409, "duplicate", "An open invoice already exists")
    except UpstreamTimeout:
        # transient: tell the client retrying is worthwhile
        r = problem(503, "upstream-unavailable", "Ledger unavailable")
        r.headers["Retry-After"] = "5"
        return r
    response.headers["Location"] = f"/v1/invoices/{inv.id}"
    response.headers["ETag"] = f'"{inv.version}"'
    response.headers["Cache-Control"] = "no-store"
    return inv.as_dict()
```

Conditional update — the `412` / `428` pair that prevents lost updates:

```python
@app.put("/v1/invoices/{invoice_id}")
def replace(invoice_id: str, body: InvoiceIn, if_match: str | None = Header(default=None)):
    inv = repo.get(invoice_id)
    if inv is None:
        raise HTTPException(404, "Invoice not found")
    if if_match is None:
        return problem(428, "precondition-required", "If-Match header is required")
    if if_match.strip('"') != str(inv.version):
        return problem(412, "precondition-failed", "Resource was modified by someone else")
    repo.replace(invoice_id, body)
    return Response(status_code=204)
```

Client-side retry that respects the semantics — the mirror image of the server contract:

```javascript
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

async function call(url, init, attempt = 0) {
  const res = await fetch(url, init);
  if (res.ok || !RETRYABLE.has(res.status) || attempt >= 4) return res;

  const ra = res.headers.get("Retry-After");
  // Retry-After wins; otherwise exponential backoff with full jitter
  const waitMs = ra
    ? (/^\d+$/.test(ra) ? Number(ra) * 1000 : Date.parse(ra) - Date.now())
    : Math.random() * 250 * 2 ** attempt;
  await new Promise(r => setTimeout(r, Math.max(0, waitMs)));
  return call(url, init, attempt + 1);
}
```

**Optimization note.** Status codes are a performance lever, not just a correctness one. Returning `304 Not Modified` on validated `GET`s removes the body from the wire entirely — for a feed endpoint with a 4 KB payload and 40 % validator hits, that is a ~40 % egress reduction for zero application change. Conversely, returning `200` where `204` is correct forces every client to allocate a parser for an empty object; and returning `202` instead of blocking on a 3-second downstream call moves p99 latency from seconds to single-digit milliseconds while making the work observable through a job resource. Also set `Cache-Control: no-store` on `404`s from dynamic routes — a heuristically cached `404` at the CDN is one of the most common "the fix deployed but users still see errors" incidents.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Standard code vocabulary | Any proxy, CDN, SDK or dashboard understands it with zero domain knowledge | The vocabulary is coarse — one `409` covers a dozen distinct business conflicts |
| Class-based handling (`x00` fallback) | Forward-compatible: new codes degrade gracefully | Encourages sloppy clients that only check `res.ok` and lose all nuance |
| `400` vs `422` split | Cleanly separates parse errors from rule violations; great DX | Two teams will disagree on the boundary; needs a written house rule |
| `404` instead of `403` for hidden resources | Prevents resource-existence enumeration | Legitimate users get a confusing "not found" for a permissions problem |
| `202 Accepted` for async work | Keeps p99 latency flat and makes long work observable | Client must poll or consume webhooks; you now own a job resource lifecycle |
| `204 No Content` | Zero-byte response; cheapest possible success | Client loses the post-mutation state and may issue an extra `GET` |
| `429` + `Retry-After` | Turns overload into cooperative back-pressure | Reveals your limits to attackers; requires accurate, low-latency counters |
| Retryable `5xx` semantics | Enables automatic recovery from transient faults | Mis-classifying a permanent failure as `5xx` produces retry storms and load amplification |
| Problem Details (RFC 9457) bodies | Machine-readable errors with stable `type` URIs | Another schema to version; a `type` URI is a contract you cannot casually rename |

## 7. Common Mistakes & Best Practices

1. ⚠️ **`200 OK` with `{"success": false, "error": …}` in the body.** Caches store it, dashboards count it as healthy, retries never fire, and every client must parse the body to learn the truth. → ✅ Put the failure in the status line. `4xx`/`5xx` + `application/problem+json`.
2. ⚠️ **`500` for validation failures.** Pages the on-call, burns the error budget, and triggers retries that can never succeed. → ✅ `5xx` is reserved for *your* bug or a genuinely transient fault. User input never produces `5xx`.
3. ⚠️ **`201` without a `Location` header.** The client just created something and has no idea where it lives. → ✅ Always `Location: /v1/<collection>/<id>`, and return the created representation in the body too.
4. ⚠️ **`401` without `WWW-Authenticate`.** Non-conformant per RFC 9110 §15.5.2, and the client cannot tell whether the token was missing, expired, or lacked scope. → ✅ `WWW-Authenticate: Bearer realm="api", error="invalid_token"` — and use `403` + `error="insufficient_scope"` for scope failures.
5. ⚠️ **Using `403` where existence is secret.** `403` on `/orgs/acme/private-repo` confirms it exists — a free enumeration oracle. → ✅ `404` across tenant/visibility boundaries; document the policy so support knows.
6. ⚠️ **`302` on a `POST` endpoint.** Historic clients rewrite the method to `GET` and silently drop the body. → ✅ `307 Temporary Redirect` / `308 Permanent Redirect`, which preserve method and body.
7. ⚠️ **`400` for everything client-ish.** Collapsing auth, rate limiting, conflicts and validation into one code makes client error handling impossible. → ✅ Use the specific code; reserve `400` for genuinely malformed requests.
8. ⚠️ **Returning `429` with no `Retry-After`.** Clients guess, and they guess badly — usually by hammering. → ✅ Always send `Retry-After` (and the `RateLimit-*` headers) so back-off is deterministic.
9. ⚠️ **Cacheable `404`s from dynamic routes.** RFC 9111 makes `404` heuristically cacheable; a CDN can pin it long after the resource appears. → ✅ `Cache-Control: no-store` (or a tiny `max-age`) on error responses.
10. ⚠️ **`204` with a body.** Some frameworks happily serialize one; HTTP/2 will reject or clients will ignore it, producing baffling bugs. → ✅ `204` means *zero* bytes. If you have something to say, use `200`.
11. ⚠️ **`202 Accepted` with no way to check progress.** The client is told "maybe later" with no follow-up. → ✅ `202` + `Location: /v1/jobs/{id}` and a job resource exposing `status`, `result_url`, and terminal errors.
12. ⚠️ **Inventing codes like `450 Business Rule Failed`.** Intermediaries treat it as `400` anyway. → ✅ Use a registered code; distinguish sub-cases with the Problem Details `type` URI.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The first question in any status-code incident is *who emitted this?* Have every layer stamp its identity: `Server: zariya-gateway/3.1`, `X-Request-Id`, and W3C `traceparent` echoed on responses. A `502`/`504` with no matching application-side span means the gateway or CDN produced it. Log the code alongside `route template` (`/v1/invoices/{id}`, never the concrete path) so cardinality stays bounded. When users report "random 401s", check clock skew on JWT `exp` before anything else — a 60-second skew across a fleet produces exactly that symptom.

**Monitoring.** The metrics that matter, all dimensioned by `http.route` and `http.response.status_code` (the OpenTelemetry semantic-convention names):
- **Error rate split by class** — `5xx` rate is your availability SLI; `4xx` rate is a *client-health* signal, not an availability breach. Never combine them in one SLO.
- **Per-code panels** for the diagnostic codes: a `409` spike means concurrent writers or a broken idempotency key; a `412` spike means clients are racing on `If-Match`; a `429` spike means either an abusive tenant or a limit set too low; a `404` spike right after a deploy usually means a routing regression.
- **`Retry-After` compliance** — measure the gap between your `429` and the client's next request. Clients that ignore it are your next outage.
- **Alerting**: page on `5xx` ratio and on `503` volume; ticket (don't page) on sustained `4xx` growth from a single `api_key_id`.

**Security.** Status codes leak. `403` vs `404` reveals existence; different codes for "unknown user" vs "wrong password" on a login endpoint (`404` vs `401`) hand an attacker a user-enumeration oracle — return an identical `401` for both. Timing differs too: a `401` that takes 5 ms (user not found) and 180 ms (bcrypt comparison) is the same oracle in the time domain. Never put stack traces, SQL, or internal hostnames in `5xx` bodies — return a stable `type` URI plus a correlation ID. Rate-limit `401`/`403` responses themselves, otherwise credential-stuffing is free reconnaissance.

**Performance & scaling.** Under load, *shed early and honestly*: a gateway-level `503` + `Retry-After` costs microseconds, while letting the request reach a saturated database costs seconds and a connection slot. Implement load shedding with a concurrency limiter that returns `503` above a threshold, and make sure your health checks fail fast so the load balancer stops sending traffic rather than accumulating `504`s. Watch for **retry amplification**: three layers each retrying three times turns one client request into 27 origin requests. Use a retry *budget* (e.g. retries capped at 10 % of requests), retry only at the outermost layer, and always pair `POST` retries with `Idempotency-Key`. Finally, `304` responses are essentially free bandwidth — instrument the ratio of `304` to `200` on cacheable `GET`s and treat a low ratio as a missed optimization.

## 9. Interview Questions

**Q: What is the difference between `401` and `403`?**
A: `401 Unauthorized` actually means *unauthenticated* — no credentials were supplied, or they were invalid or expired — and RFC 9110 requires the response to carry a `WWW-Authenticate` header telling the client how to authenticate. `403 Forbidden` means the server understood and accepted the identity but that principal is not permitted to perform the action. The practical test: re-authenticating can fix a `401`; only a permission change can fix a `403`.

**Q: When would you return `422` instead of `400`?**
A: `400` is for requests the server cannot process at the syntactic level — unparseable JSON, wrong content type, a missing required field, or a type mismatch. `422 Unprocessable Content` is for a well-formed document that violates a domain rule, like an end date before a start date or a currency the merchant hasn't enabled. Both are terminal client errors; the split exists so clients can distinguish "my serializer is broken" from "the user's input is wrong". Some large APIs use `400` for both, which is acceptable as long as it's consistent.

**Q: Why must a `201` include a `Location` header?**
A: `201 Created` asserts that one or more resources came into existence, and `Location` names the primary one so the client can address it without guessing the URI scheme. Without it the client must parse an ID out of the body and reconstruct the path, which couples it to your URL layout. Returning the created representation in the body as well saves the client an immediate `GET`.

**Q: What does `202 Accepted` mean, and what must accompany it?**
A: `202` means the request was valid and has been queued, but processing is not complete and may still fail. It should include a `Location` (or a `job` object in the body) pointing at a resource the client can poll for status, plus the eventual result URL. Without that follow-up handle, `202` is indistinguishable from "we lost your request".

**Q: Is `DELETE` on an already-deleted resource `204` or `404`?**
A: Both are defensible. `DELETE` is idempotent in *effect* — the resource is gone either way — but RFC 9110 doesn't mandate the same status on repeats. Returning `204` is friendlier to retrying clients and at-least-once delivery pipelines; `404` is more literally honest. Pick one and document it; if your clients auto-retry, prefer `204`.

**Q: Which status codes are safe to retry automatically?**
A: `408 Request Timeout`, `429 Too Many Requests`, and the transient server errors `500`, `502`, `503`, `504`. `429` and `503` should be retried at the interval given by `Retry-After`; the rest with jittered exponential backoff. Every other `4xx` is terminal — the identical bytes will fail identically — and non-idempotent methods must carry an `Idempotency-Key` before any retry is safe.

**Q: What's wrong with returning `200 OK` and `{"error": "..."}` in the body?**
A: It breaks every consumer that reasons about the status class: HTTP caches may store the failure, load balancers and dashboards count it as a success so your error rate looks perfect during an outage, SDKs don't throw, and retry middleware never fires. It also forces every client to parse the body before knowing whether the call worked. Put the failure in the status line and the detail in an RFC 9457 body.

**Q: Why prefer `307`/`308` over `302`/`301` for redirects?**
A: For historical reasons many clients rewrite a `POST` to a `GET` when following `301`/`302`, silently dropping the request body. `307 Temporary Redirect` and `308 Permanent Redirect` are defined to preserve both method and body. Use `301`/`302` only when the target is a `GET` anyway, or when you deliberately want the POST-to-GET rewrite.

**Q: (Senior) How do you decide between `403` and `404` for a resource the caller isn't allowed to see, and what are the consequences?**
A: If the mere existence of the resource is confidential — a private repository, another tenant's order — return `404`, because a `403` is a free enumeration oracle that lets an attacker map your namespace by probing IDs. Inside a trust boundary where existence is not secret, `403` is better because it's diagnosable. The cost of the `404` policy is support load: legitimate users with a permissions gap see "not found", so you need a stable `type` URI and a correlation ID that lets support distinguish the two internally. You must also match timing and response size between the two paths, otherwise you've only moved the oracle from the status code into the side channel.

**Q: (Senior) Explain the `412` / `428` pair and how they prevent lost updates.**
A: A client fetches a resource, gets `ETag: "v7"`, and sends its update with `If-Match: "v7"`. If another writer has moved the resource to `v8`, the server returns `412 Precondition Failed` and the client must re-read and merge — this is optimistic concurrency control, and it turns a silent last-write-wins overwrite into an explicit, recoverable error. `428 Precondition Required` is the server's way of refusing unconditional writes at all: if the request arrives with no `If-Match`, you return `428` rather than accepting a blind overwrite. The trade-off is client complexity — every writer now needs a read-modify-retry loop — so it's usually reserved for high-contention or high-value resources.

**Q: (Senior) Your `5xx` rate is 0.01 % but customers report constant failures. What's your hypothesis?**
A: The failures are almost certainly being reported as `2xx` or as `4xx`. First check for `200`-with-error-body patterns and for cases where a downstream failure is being mapped to `400`/`422` by an over-eager exception handler — misclassified server faults hide inside the client-error bucket, which no SLO watches. Second, check the edge: CDN or gateway `502`/`504`s never reach application metrics, so compare edge-emitted status distributions against origin ones. Third, look at partial success — a `200` batch response where individual items failed, or a `202` whose jobs are all erroring, which no HTTP-level metric captures. The fix is a per-item outcome metric plus reconciling edge and origin status histograms.

**Q: (Senior) How do status codes interact with caching, and where does that bite in production?**
A: RFC 9111 defines a set of codes that are *heuristically cacheable* without explicit freshness headers — including `200`, `301`, `308`, `404`, `405`, `410`, and `414`. The classic incident is a transient `404` during a deploy or a cold cache getting stored at the CDN and served for hours after the resource exists, so the fix "already deployed" appears not to work. `301` is worse: browsers cache permanent redirects aggressively and near-permanently, so a mistaken `301` can be effectively unrecallable for that user. The discipline is to send explicit `Cache-Control: no-store` on all error responses, to prefer `302`/`307` until a redirect is genuinely permanent, and to make sure `Vary` is correct on any `200` that depends on `Authorization` or `Accept`.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** The status class answers two questions: *who must change* and *can a retry ever help*. `2xx` nobody, done — `200` here's the state, `201` created (send `Location`), `202` queued (send a job handle), `204` done with nothing to say. `3xx` go elsewhere — `304` use your cache, `307`/`308` preserve the method. `4xx` the client must change the request — `400` unparseable, `401` unauthenticated (send `WWW-Authenticate`), `403` wrong principal, `404` absent or hidden, `409` state clash, `412` stale precondition, `422` valid syntax but broken rule, `428` precondition required, `429` slow down (send `Retry-After`). `5xx` the server must change — `500` bug, `502` bad upstream, `503` overloaded (send `Retry-After`), `504` upstream timeout. Never `200` with an error body; never `5xx` for user input; always `no-store` on errors.

| Code | Meaning | Required companion | Retry? |
|---|---|---|---|
| `200 OK` | Success with a representation | — | n/a |
| `201 Created` | Resource created now | `Location` | n/a |
| `202 Accepted` | Queued, not done | `Location` to a job | n/a |
| `204 No Content` | Success, zero bytes | no body at all | n/a |
| `304 Not Modified` | Cached copy is fresh | `ETag` | n/a |
| `307` / `308` | Redirect preserving method + body | `Location` | n/a |
| `400 Bad Request` | Malformed / unparseable | problem+json | ❌ |
| `401 Unauthorized` | Unauthenticated | `WWW-Authenticate` | after re-auth |
| `403 Forbidden` | Authenticated, not permitted | — | ❌ |
| `404 Not Found` | Absent or deliberately hidden | `Cache-Control: no-store` | ❌ |
| `405 Method Not Allowed` | Wrong verb for this URI | `Allow` | ❌ |
| `409 Conflict` | State clash / duplicate | current state in body | ❌ |
| `412 Precondition Failed` | `If-Match` validator stale | fresh `ETag` | after re-read |
| `415 Unsupported Media Type` | Bad `Content-Type` | `Accept-Post` | ❌ |
| `422 Unprocessable Content` | Valid syntax, broken rule | field errors | ❌ |
| `428 Precondition Required` | Unconditional write refused | — | with `If-Match` |
| `429 Too Many Requests` | Rate limited | `Retry-After`, `RateLimit-*` | ✅ |
| `500 Internal Server Error` | Unhandled server fault | correlation id | ✅ |
| `502` / `504` | Bad / timed-out upstream | — | ✅ |
| `503 Service Unavailable` | Overloaded or draining | `Retry-After` | ✅ |

**Flash cards**

- **`400` vs `422`** → `400` = I couldn't parse it; `422` = I parsed it fine and it breaks a business rule.
- **`401` vs `403`** → `401` = who are you (send `WWW-Authenticate`); `403` = I know who you are and no.
- **What must a `201` carry?** → A `Location` header pointing at the new resource, ideally plus the representation.
- **Which `4xx` codes are worth retrying?** → Only `408` and `429`; everything else needs the request itself to change.
- **Why is a `404` dangerous at a CDN?** → RFC 9111 makes it heuristically cacheable, so send `Cache-Control: no-store` on errors.

## 11. Hands-On Exercises & Mini Project

- [ ] Take an existing endpoint that returns `200` with `{"ok": false}` and convert it to proper status codes plus RFC 9457 bodies. Write a client test proving the old client still works and the new one gets richer errors.
- [ ] Implement `If-Match`-based optimistic concurrency on a `PUT`: return `428` when the header is absent and `412` when the `ETag` is stale. Prove with two concurrent `curl` calls that the second one fails instead of silently overwriting.
- [ ] Build a `429` path with a token-bucket limiter that emits accurate `Retry-After`, `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`, then write a client that honours it exactly and measure that it never receives a second `429`.
- [ ] Audit a public API you use (GitHub, Stripe, or your own) and produce a table of every status code it returns, whether the response is retryable, and whether the code matches RFC 9110's definition.

### Mini Project — The Status Code Conformance Suite

**Goal.** Build a small FastAPI "orders" service plus an automated conformance suite that proves every status code it emits is correct.

**Requirements.**
1. Endpoints: `POST /orders`, `GET /orders/{id}`, `PUT /orders/{id}`, `PATCH /orders/{id}`, `DELETE /orders/{id}`, `GET /orders`.
2. Emit at minimum: `200`, `201` (+`Location`), `202` (+job handle for orders over a value threshold), `204`, `304`, `400`, `401` (+`WWW-Authenticate`), `403`, `404`, `405` (+`Allow`), `409`, `412`, `415`, `422`, `428`, `429` (+`Retry-After`), `500`, `503`.
3. Every non-`2xx` response uses `application/problem+json` with a stable `type` URI documented in a `PROBLEMS.md`.
4. A pytest suite asserting: no `2xx` ever carries an `error` field; every `201` has `Location`; every `401` has `WWW-Authenticate`; every `429`/`503` has `Retry-After`; every `204` has a zero-length body; every error has `Cache-Control: no-store`.
5. A middleware exporting a Prometheus counter `http_responses_total{route,status,class}` and a Grafana-style JSON dashboard definition separating `4xx` from `5xx`.

**Extensions.**
- Add a chaos switch that randomly injects `503`s and prove your client's `Retry-After`-aware backoff converges without amplification.
- Add `Idempotency-Key` support to `POST /orders` and assert that a replayed key returns the stored response rather than creating a duplicate `409`.
- Generate an OpenAPI 3.1 document where every operation enumerates its possible responses, and add a CI check that fails if the service can emit a code not declared in the spec.

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *HTTP Methods & Safety/Idempotency* explains which verbs make `204` vs `200` the right success code; *Error Handling & Problem Details* covers the RFC 9457 body that accompanies every `4xx`/`5xx` here; *Caching, ETags & Conditional Requests* is the other half of `304`/`412`; *Rate Limiting & Throttling* owns `429` and `Retry-After`; *Authentication & Authorization* owns the `401`/`403` split; *Idempotency & Retries* explains why status class drives retry policy; *Versioning & Deprecation* covers `410 Gone` and `Sunset`.

- **RFC 9110 — HTTP Semantics, §15 Status Codes** — IETF · *Intermediate* · the single normative definition of every code; §15.5 alone settles most team arguments. <https://www.rfc-editor.org/rfc/rfc9110.html#name-status-codes>
- **RFC 9111 — HTTP Caching** — IETF · *Intermediate* · defines which status codes are heuristically cacheable and how `304` validation works. <https://www.rfc-editor.org/rfc/rfc9111.html>
- **RFC 9457 — Problem Details for HTTP APIs** — IETF · *Beginner* · the standard error body that belongs with every non-`2xx`. <https://www.rfc-editor.org/rfc/rfc9457.html>
- **MDN — HTTP response status codes** — Mozilla · *Beginner* · the best browsable reference, with browser-compat notes the RFCs omit. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Status>
- **Microsoft REST API Guidelines** — Microsoft · *Intermediate* · a real, opinionated corporate style guide with explicit status-code rules per operation. <https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md>
- **Zalando RESTful API Guidelines — HTTP Status Codes** — Zalando · *Intermediate* · rule-numbered guidance including the `400`/`422` boundary and mandatory codes per method. <https://opensource.zalando.com/restful-api-guidelines/#http-status-codes-and-errors>
- **Google API Design Guide — Errors** — Google · *Intermediate* · maps a canonical error-code enum onto HTTP statuses; useful when you also expose gRPC. <https://cloud.google.com/apis/design/errors>
- **Stripe API Reference — Errors** — Stripe · *Beginner* · the industry benchmark for a documented, stable status-code and error-type contract. <https://docs.stripe.com/api/errors>

---

*REST API Handbook — chapter 07.*
