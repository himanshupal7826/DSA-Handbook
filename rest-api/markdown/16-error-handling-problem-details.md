# 16 · Error Handling & Problem Details

> **In one line:** An error response is a first-class part of your API contract — give it a correct status code, a stable machine-readable code, and a human-actionable message, in the standard `application/problem+json` shape from RFC 9457.

---

## 1. Overview

Most API designers spend their energy on the happy path and treat errors as an afterthought — a string, a stack trace, or worse, `200 OK` with `{"success": false}`. That asymmetry is backwards. Clients spend the majority of their defensive code deciding *what went wrong and what to do next*, and the quality of your error contract determines whether that decision is a two-line switch or a fragile substring match on an English sentence that changes when someone fixes a typo.

The problem an error contract solves is **machine actionability**. Given a failure, a client needs to answer four questions mechanically: *Is this my fault or yours? Should I retry? Which field do I fix? What do I show the user?* HTTP status codes answer the first two coarsely (`4xx` = client, `5xx` = server, `429`/`503` = retry after a delay). They cannot answer the last two, because `422` covers a thousand different validation failures. That gap is what a structured error body fills.

[RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457) (July 2023, obsoleting RFC 7807) standardizes that body. It defines the media type `application/problem+json` and five members: `type` (a URI identifying the problem kind), `title` (a short human-readable summary), `status` (the HTTP status code), `detail` (a human explanation of *this* occurrence), and `instance` (a URI for this specific occurrence). Everything else you need — field errors, a trace id, a retry hint — goes in **extension members** alongside those five. The point of the standard is not that it is clever; it is that it is *the* answer, so tooling, SDKs, and API gateways can rely on one shape.

**Concrete example.** Stripe returns `{"error": {"type": "card_error", "code": "card_declined", "decline_code": "insufficient_funds", "param": "amount", "message": "..."}}` — predating RFC 7807 but embodying every principle: a stable machine code, a parameter pointer, a human message, and a documented taxonomy. GitHub returns `{"message": "...", "errors": [{"resource": "Issue", "field": "title", "code": "missing_field"}], "documentation_url": "..."}`. Zalando's guidelines and the Dutch and UK government API standards all mandate `application/problem+json` outright. The convergence is on the same three ideas: **stable code, structured field errors, and a link to docs.**

The durable mental model: **status code = category, `type` = the specific problem class, `detail` = this occurrence, extensions = what the client needs to act.** Never make a client parse `detail`.

## 2. Core Concepts

- **Problem Details (RFC 9457)** — the standard JSON error shape served as `application/problem+json`, with members `type`, `title`, `status`, `detail`, `instance` plus arbitrary extensions.
- **`type`** — a URI (usually a documentation URL) that *identifies the problem class*. It is the primary machine-readable key. Default `"about:blank"` means "this is just the status code."
- **`title`** — a short, human-readable summary that stays the same for a given `type`. Do not vary it per occurrence.
- **`detail`** — a human explanation of *this specific* occurrence. Safe to vary; never meant to be parsed.
- **`instance`** — a URI identifying this occurrence (e.g. `/orders/o_91/errors/req_01J9`). Useful for support workflows.
- **Extension members** — additional top-level fields such as `errors[]`, `trace_id`, `retry_after`, `balance`. Fully legal and how you carry field-level detail.
- **Error code** — a short, stable, opaque string (`insufficient_funds`, `email_taken`) that clients branch on. Either the last path segment of `type` or an explicit `code` extension.
- **JSON Pointer (RFC 6901)** — the standard way to point at the offending part of the request body: `"pointer": "/items/3/email"`. Better than a bare field name for nested payloads.
- **Client vs server error** — `4xx` means the request was wrong and repeating it unchanged will fail again; `5xx` means the server failed and a retry may succeed. Getting this boundary wrong corrupts every SLO and retry policy you build.
- **Retryability** — a property the client must be able to infer: `429`/`503` with `Retry-After` are retryable, `400`/`422` are not, `409` sometimes is. Make it explicit rather than implied.

## 3. Theory & Principles

### 3.1 Choosing the status code

RFC 9110 defines the semantics precisely, and most API bugs here come from guessing:

| Code | Means | Typical trigger |
|---|---|---|
| `400 Bad Request` | The request is malformed at the **syntax/protocol** level | Invalid JSON, bad query-parameter type, malformed header |
| `401 Unauthorized` | **Unauthenticated** — no or invalid credentials. MUST include `WWW-Authenticate` | Missing/expired token |
| `403 Forbidden` | Authenticated but **not permitted**. Re-authenticating will not help | Wrong scope, other tenant's resource |
| `404 Not Found` | No resource at this URI (or deliberately hiding existence from an unauthorized caller) | Bad id |
| `405 Method Not Allowed` | URI exists, method does not. MUST include `Allow` | `DELETE` on a read-only collection |
| `409 Conflict` | The request conflicts with current state | Duplicate unique key, concurrent edit, illegal state transition |
| `410 Gone` | Existed, permanently removed | Deleted account, retired endpoint |
| `412 Precondition Failed` | `If-Match`/`If-Unmodified-Since` did not hold | Stale ETag |
| `415 Unsupported Media Type` | The server does not accept this `Content-Type` | XML sent to a JSON-only endpoint |
| `422 Unprocessable Content` | Syntax is fine; **semantics** are not | `end_date` before `start_date`, unknown currency |
| `428 Precondition Required` | The server demands a conditional request | `If-Match` missing on a protected PATCH |
| `429 Too Many Requests` | Rate limit exceeded. SHOULD include `Retry-After` | Quota exhausted |
| `500 Internal Server Error` | An unhandled server fault | A bug — never a validation failure |
| `503 Service Unavailable` | Temporarily down/overloaded. SHOULD include `Retry-After` | Dependency outage, shedding load |

The `400` vs `422` line is the most argued and the most useful: **`400` if you could not understand the request; `422` if you understood it perfectly and it is still unacceptable.** `{"age": "abc"}` where an integer is required is a `400` (type/parse failure); `{"age": -5}` is a `422` (parsed fine, violates a rule). Both are defensible if applied consistently — inconsistency is the real sin.

### 3.2 Why `200 OK` with an error body is a bug

Returning `200` with `{"success": false}` breaks every layer that reads status codes and never reads bodies: HTTP client libraries (`res.ok` is true), retry middleware, circuit breakers, API gateways, CDN error pages, load-balancer health checks, your `5xx`-rate SLO dashboards, and every alert built on them. Your error rate appears to be zero while customers are failing. The status code is the only part of the response that the entire HTTP ecosystem agrees on — use it.

### 3.3 Stable codes over prose

Three properties make an error contract durable:

1. **Stability.** `type` and `code` values are part of your public API. Changing `insufficient_funds` to `funds_insufficient` is a breaking change; changing `detail` from "Card was declined" to "Your card was declined" is not.
2. **Granularity.** One `type` per *distinct client action*. If two failures require the same client response, they can share a code; if one means "top up your balance" and the other means "use a different card," they must not.
3. **Actionability.** Every error should answer "what now?" — a `pointer` for validation, a `Retry-After` for throttling, an `allowed` list for enum violations, a `documentation_url` for everything.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
<rect x="10" y="10" width="760" height="320" rx="14" fill="#f8fafc" stroke="#4f46e5"/>
<text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Anatomy of an RFC 9457 problem document</text>
<rect x="26" y="56" width="330" height="252" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
<text x="42" y="80" fill="#1e293b" font-size="12" font-weight="700">HTTP/1.1 422 Unprocessable Content</text>
<text x="42" y="100" fill="#1e293b" font-size="12">Content-Type: application/problem+json</text>
<text x="42" y="124" fill="#1e293b" font-size="12">{</text>
<text x="42" y="142" fill="#1e293b" font-size="12">  "type": "https://api.ex.com/problems/validation",</text>
<text x="42" y="160" fill="#1e293b" font-size="12">  "title": "Validation failed",</text>
<text x="42" y="178" fill="#1e293b" font-size="12">  "status": 422,</text>
<text x="42" y="196" fill="#1e293b" font-size="12">  "detail": "2 fields are invalid.",</text>
<text x="42" y="214" fill="#1e293b" font-size="12">  "instance": "/v1/orders/req_01J9K",</text>
<text x="42" y="232" fill="#1e293b" font-size="12">  "trace_id": "9c1f…",</text>
<text x="42" y="250" fill="#1e293b" font-size="12">  "errors": [</text>
<text x="42" y="268" fill="#1e293b" font-size="12">    { "pointer": "/items/0/qty",</text>
<text x="42" y="284" fill="#1e293b" font-size="12">      "code": "min_value", "detail": "…" } ]</text>
<text x="42" y="300" fill="#1e293b" font-size="12">}</text>
<rect x="378" y="56" width="376" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="394" y="78" fill="#1e293b" font-size="12" font-weight="700">status &#8594; category</text>
<text x="394" y="96" fill="#1e293b" font-size="11">Retry or not. Read by gateways, SLOs, SDKs.</text>
<text x="394" y="110" fill="#1e293b" font-size="11">4xx = your request. 5xx = our fault.</text>
<rect x="378" y="126" width="376" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="394" y="148" fill="#1e293b" font-size="12" font-weight="700">type &#8594; the problem class (STABLE)</text>
<text x="394" y="166" fill="#1e293b" font-size="11">The key clients switch on. A documentation URL.</text>
<text x="394" y="180" fill="#1e293b" font-size="11">Renaming it is a breaking change.</text>
<rect x="378" y="196" width="376" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
<text x="394" y="218" fill="#1e293b" font-size="12" font-weight="700">title / detail &#8594; humans only</text>
<text x="394" y="236" fill="#1e293b" font-size="11">Never parsed. detail may vary per occurrence.</text>
<rect x="378" y="258" width="376" height="50" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="394" y="280" fill="#1e293b" font-size="12" font-weight="700">extensions &#8594; what the client acts on</text>
<text x="394" y="298" fill="#1e293b" font-size="11">errors[] pointers, trace_id, retry_after, balance.</text>
</svg>
```

## 4. Architecture & Workflow

How an error travels from a failing line of code to an actionable client response:

1. **Domain code raises a typed exception** — `InsufficientFunds(available=430, required=1200)`, not `Exception("no money")`. The exception carries structured data, not a formatted sentence.
2. **A single mapping layer** (FastAPI exception handler, Express error middleware, Spring `@ControllerAdvice`) translates domain exceptions to problem types. This is the only place status codes are chosen, which is what makes the API consistent.
3. **Framework validation errors are intercepted and reshaped.** Pydantic/Zod/Joi produce their own structures; if you let them leak, half your errors have one shape and half another. Map them into `errors[]` with JSON Pointers.
4. **Unhandled exceptions are caught by a last-resort handler** that logs the full stack trace server-side and returns a generic `500` problem document containing *only* a `trace_id`. Never a stack trace, SQL fragment, or internal hostname.
5. **Enrichment** — attach `instance`, `trace_id` (the W3C `traceparent` trace id), and the `Retry-After` header where applicable. Set `Content-Type: application/problem+json`.
6. **Header contract enforcement** — `401` must carry `WWW-Authenticate`; `405` must carry `Allow`; `429`/`503` should carry `Retry-After`; `413` may carry a documented limit. These are protocol obligations, not decoration.
7. **Redaction pass** — strip PII and secrets from `detail` and from echoed input. Errors are logged, forwarded to third-party monitoring, and pasted into support tickets.
8. **The gateway must not rewrite it.** Many API gateways replace upstream error bodies with their own HTML or JSON. Configure pass-through for `application/problem+json`, and make the gateway's *own* errors (auth failures, timeouts) use the same shape.
9. **Client branches on `type`/`code`**, renders `title`/`detail` (or its own localized string keyed by the code), highlights fields using the `pointer` values, and decides retry from the status plus `Retry-After`.
10. **Observability** — increment a counter labelled by `type` and status, and correlate to the server-side log via `trace_id`. Error *types* are the metric, not error counts.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
<rect x="10" y="10" width="760" height="340" rx="14" fill="#f8fafc" stroke="#4f46e5"/>
<text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">From domain exception to actionable client response</text>
<rect x="28" y="58" width="140" height="56" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="98" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Domain layer</text>
<text x="98" y="98" text-anchor="middle" fill="#1e293b" font-size="10">raise InsufficientFunds</text>
<rect x="192" y="58" width="150" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="267" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Mapping layer</text>
<text x="267" y="98" text-anchor="middle" fill="#1e293b" font-size="10">exception &#8594; type + status</text>
<rect x="366" y="58" width="150" height="56" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="441" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Enrich + redact</text>
<text x="441" y="98" text-anchor="middle" fill="#1e293b" font-size="10">trace_id, headers, PII strip</text>
<rect x="540" y="58" width="212" height="56" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
<text x="646" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Gateway (pass through)</text>
<text x="646" y="98" text-anchor="middle" fill="#1e293b" font-size="10">must not rewrite problem+json</text>
<path d="M168 86 h20 m-8 -4 l8 4 l-8 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
<path d="M342 86 h20 m-8 -4 l8 4 l-8 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
<path d="M516 86 h20 m-8 -4 l8 4 l-8 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
<rect x="28" y="138" width="352" height="96" rx="8" fill="#fee2e2" stroke="#dc2626"/>
<text x="44" y="160" fill="#1e293b" font-size="12" font-weight="700">Anti-pattern</text>
<text x="44" y="180" fill="#1e293b" font-size="12">200 OK</text>
<text x="44" y="198" fill="#1e293b" font-size="12">{ "success": false, "msg": "no money" }</text>
<text x="44" y="220" fill="#1e293b" font-size="11">SDKs, retries, SLOs and alerts all see success.</text>
<rect x="400" y="138" width="352" height="96" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
<text x="416" y="160" fill="#1e293b" font-size="12" font-weight="700">402 Payment Required</text>
<text x="416" y="180" fill="#1e293b" font-size="12">Content-Type: application/problem+json</text>
<text x="416" y="198" fill="#1e293b" font-size="12">{ "type": "…/insufficient-funds",</text>
<text x="416" y="216" fill="#1e293b" font-size="12">  "available": 430, "required": 1200 }</text>
<rect x="28" y="252" width="724" height="84" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="44" y="274" fill="#1e293b" font-size="12" font-weight="700">Client decision table driven entirely by machine fields</text>
<text x="44" y="294" fill="#1e293b" font-size="12">status 429 / 503 + Retry-After &#8594; sleep and retry     |     status 401 &#8594; refresh token, retry once</text>
<text x="44" y="312" fill="#1e293b" font-size="12">status 422 + errors[].pointer &#8594; highlight fields     |     status 4xx otherwise &#8594; surface title/detail</text>
<text x="44" y="330" fill="#1e293b" font-size="12">status 5xx &#8594; show trace_id, back off, alert                |     never branch on detail text</text>
</svg>
```

## 5. Implementation

### 5.1 The canonical validation error

```http
POST /v1/orders HTTP/1.1
Content-Type: application/json

{ "currency": "XYZ", "items": [ { "sku": "AB-1", "qty": 0 } ] }
```

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json
X-Request-Id: req_01J9K2M3

{ "type": "https://api.example.com/problems/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "The request body has 2 invalid fields.",
  "instance": "/v1/orders",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736",
  "errors": [
    { "pointer": "/currency", "code": "unsupported_currency",
      "detail": "XYZ is not supported.", "allowed": ["USD", "EUR", "INR"] },
    { "pointer": "/items/0/qty", "code": "min_value",
      "detail": "qty must be at least 1.", "min": 1 } ] }
```

Every field a client needs is machine readable: `code` to branch on, `pointer` to highlight the input, `allowed`/`min` to build the message or a picker.

### 5.2 The other shapes that matter

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="api", error="invalid_token", error_description="expired"
Content-Type: application/problem+json

{ "type": "https://api.example.com/problems/invalid-token", "title": "Invalid access token",
  "status": 401, "detail": "The access token expired at 2026-07-22T08:59:00Z." }
```

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 12
RateLimit-Limit: 100
RateLimit-Remaining: 0
RateLimit-Reset: 12
Content-Type: application/problem+json

{ "type": "https://api.example.com/problems/rate-limit-exceeded", "title": "Rate limit exceeded",
  "status": 429, "detail": "100 requests per minute allowed. Retry in 12 seconds.",
  "retry_after": 12 }
```

```http
HTTP/1.1 500 Internal Server Error
Content-Type: application/problem+json

{ "type": "about:blank", "title": "Internal Server Error", "status": 500,
  "detail": "An unexpected error occurred. Quote this trace id to support.",
  "trace_id": "4bf92f3577b34da6a3ce929d0e0e4736" }
```

The `500` body is deliberately empty of detail. Anything more — an exception class, a SQL fragment, a hostname — is reconnaissance for an attacker and useless to a legitimate client.

### 5.3 FastAPI: one consistent handler for everything

```python
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
import logging, uuid

app = FastAPI()
BASE = "https://api.example.com/problems"
log = logging.getLogger("api")


def problem(status: int, kind: str, title: str, detail: str,
            request: Request, **ext) -> JSONResponse:
    body = {"type": f"{BASE}/{kind}", "title": title, "status": status,
            "detail": detail, "instance": str(request.url.path),
            "trace_id": request.state.trace_id, **ext}
    return JSONResponse(body, status_code=status,
                        media_type="application/problem+json")


class DomainError(Exception):
    status, kind, title = 400, "domain-error", "Domain error"
    def __init__(self, detail: str, **ext):
        self.detail, self.ext = detail, ext


class InsufficientFunds(DomainError):
    status, kind, title = 402, "insufficient-funds", "Insufficient funds"


@app.exception_handler(DomainError)
async def domain_handler(request: Request, exc: DomainError):
    return problem(exc.status, exc.kind, exc.title, exc.detail, request, **exc.ext)


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    errors = [{"pointer": "/" + "/".join(str(p) for p in e["loc"][1:]),
               "code": e["type"], "detail": e["msg"]} for e in exc.errors()]
    return problem(422, "validation-failed", "Validation failed",
                   f"The request body has {len(errors)} invalid field(s).",
                   request, errors=errors)


@app.exception_handler(StarletteHTTPException)
async def http_handler(request: Request, exc: StarletteHTTPException):
    return problem(exc.status_code, "http-error", "HTTP error", str(exc.detail), request)


@app.exception_handler(Exception)
async def unhandled_handler(request: Request, exc: Exception):
    log.exception("unhandled", extra={"trace_id": request.state.trace_id})
    return problem(500, "internal-error", "Internal Server Error",
                   "An unexpected error occurred. Quote this trace id to support.",
                   request)          # deliberately no exception detail


# In domain code: raise InsufficientFunds("Balance is 430; the charge requires 1200.",
#                                         available=430, required=1200, currency="INR")
```

### 5.4 A client that branches correctly

```javascript
export async function call(path, init) {
  const res = await fetch(path, init);
  if (res.ok) return res.json();

  const isProblem = (res.headers.get("Content-Type") ?? "").includes("application/problem+json");
  const p = isProblem ? await res.json() : { title: res.statusText, status: res.status };
  const code = p.type?.split("/").pop() ?? "unknown";

  if (res.status === 429 || res.status === 503)
    throw new RetryableError(code, Number(res.headers.get("Retry-After") ?? 1));
  if (res.status === 401) throw new AuthError(code);        // refresh token, retry once
  if (res.status === 422) throw new FieldErrors(p.errors ?? []);  // highlight by pointer
  throw new ApiError(code, p.title, p.detail, p.trace_id);
}
```

### 5.5 OpenAPI 3.1 fragment

```yaml
components:
  schemas:
    Problem:
      type: object
      required: [type, title, status]
      properties:
        type:     { type: string, format: uri, default: "about:blank" }
        title:    { type: string }
        status:   { type: integer, minimum: 100, maximum: 599 }
        detail:   { type: string }
        instance: { type: string, format: uri-reference }
        trace_id: { type: string }
        errors:
          type: array
          items:
            type: object
            required: [pointer, code]
            properties:
              pointer: { type: string, description: "RFC 6901 pointer into the body" }
              code:    { type: string }
              detail:  { type: string }
  responses:
    Problem422:
      description: Validation failed
      content:
        application/problem+json:
          schema: { $ref: "#/components/schemas/Problem" }
```

### 5.6 Optimization notes

- **Build problem documents lazily.** Rendering a rich error for every one of 50,000 rejected requests per second costs real CPU; keep the object small and avoid expensive lookups (like reverse-DNS or extra DB reads) inside the error path.
- **Fail fast on the cheapest check first** — content type, then size, then auth, then schema, then business rules. Never run an expensive authorization query for a request that will fail JSON parsing.
- **Cache nothing** — `Cache-Control: no-store` on error responses, except deliberately cacheable ones like `404`/`410` on public resources. And do not log `4xx` at ERROR level: client errors are normal traffic, and logging them as incidents buries real ones and can itself cause a log-volume outage.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| RFC 9457 `problem+json` | One shape across the whole industry; SDKs, gateways and linters understand it; extensible | Slightly verbose; `type` URIs must actually resolve to docs or they become decoration |
| Stable `type`/`code` values | Clients branch mechanically; messages can be reworded or localized freely | They are public API — renaming is a breaking change; needs a governed registry |
| Correct HTTP status codes | The whole ecosystem (retries, SLOs, gateways, CDNs) works for free | Requires discipline on `400` vs `422`, `401` vs `403`, `409` vs `422` |
| Field-level `errors[]` with pointers | Forms highlight the right input; clients need zero string parsing | More server work; must not leak internal field names or schema internals |
| `trace_id` in the body | Support and debugging become one lookup instead of a log hunt | Correlation ids can leak infrastructure detail; keep them opaque |
| Verbose `detail` messages | Great developer experience during integration | Risk of leaking PII, SQL, internal hostnames; must be redacted and reviewed |
| Returning all validation errors at once | One round trip to fix everything | Extra compute per bad request; a DoS amplifier if input is unbounded |
| Generic `500` bodies | No information disclosure | Developers complain; mitigate with the `trace_id` plus good server-side logs |

## 7. Common Mistakes & Best Practices

1. ⚠️ **`200 OK` with `{"success": false}`** — invisible to SDKs, retry middleware, gateways and your error-rate SLO. → ✅ Use the status code as the primary signal; the body only elaborates.
2. ⚠️ **Leaking stack traces, SQL, or internal hostnames** in `500` responses. → ✅ Log details server-side, return a generic problem document with a `trace_id`.
3. ⚠️ **`401` vs `403` confusion.** → ✅ `401` = not authenticated (and it *must* carry `WWW-Authenticate`); `403` = authenticated but not permitted, and re-authenticating will not help.
4. ⚠️ **Clients forced to parse English.** → ✅ Ship a stable `type`/`code` for every distinct failure and document the full list; treat `detail` as unparseable prose.
5. ⚠️ **A different error shape per endpoint** (framework validation errors leaking alongside hand-written ones). → ✅ One mapping layer that intercepts framework validation errors and normalizes them.
6. ⚠️ **Stopping at the first validation error**, forcing a fix-one-resubmit loop. → ✅ Validate everything and return all failures in `errors[]` with JSON Pointers.
7. ⚠️ **Missing protocol headers** — `401` without `WWW-Authenticate`, `405` without `Allow`, `429` without `Retry-After`. → ✅ Enforce these in the mapping layer and assert them in contract tests.
8. ⚠️ **`500` used for client mistakes** (an unhandled `KeyError` on a missing field), which poisons your availability SLO and triggers pointless pages. → ✅ Validate inputs so bad requests are `4xx`; alert only on genuine `5xx`.
9. ⚠️ **Enumeration via error messages** — "no user with that email" vs "wrong password" lets attackers harvest accounts. → ✅ Use one generic `401` for authentication failure; prefer `404` over `403` when even the existence of a resource is sensitive.
10. ⚠️ **Wrong media type** — `application/json` on a problem document, so clients and gateways cannot detect it. → ✅ Always `Content-Type: application/problem+json`.
11. ⚠️ **A gateway rewriting upstream error bodies** into HTML or its own JSON, destroying the contract. → ✅ Configure pass-through and make gateway-generated errors use the same shape.
12. ⚠️ **`type` URIs that 404.** → ✅ Point them at real documentation pages that explain the cause and the fix; they are the most-clicked link in your API docs.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Correlate everything through one id. Generate or accept a W3C `traceparent`, expose its trace id as `X-Request-Id` on *every* response (success and failure), and echo it as `trace_id` in problem documents. A support ticket then becomes a single log query. Log the full exception, request id, principal, route, and a redacted body sample server-side at ERROR for `5xx` and at INFO/WARN for `4xx`. When integrating, a `?debug=true`-style verbose mode is tempting — if you build one, gate it behind an internal-only scope, never a query parameter, and never enable it in production for external callers.

**Monitoring.** The essential metrics are `http_requests_total{status, route, problem_type}` and latency histograms split by status class. Alert on **`5xx` rate** (an availability SLO) and on **`5xx`/total ratio per route**, not raw counts. Watch `4xx` composition as a product signal: a spike in one `problem_type` after a client release means an SDK bug; a slow rise in `422 validation-failed` means your docs or schema drifted. Track `429` rate per API key to spot clients in a retry storm, and `401`/`403` rates for credential problems and permission misconfiguration. Every `problem_type` should be a low-cardinality label — if you templated ids into it, you have a metrics cardinality bomb.

**Security.** Error responses are an information-disclosure channel. Concretely: no stack traces, ORM/SQL fragments, file paths, library versions, or internal hostnames; no distinguishing "user not found" from "wrong password"; no confirming existence of resources the caller cannot access (return `404` where `403` would leak); no echoing raw input back unescaped (a reflected-XSS sink when errors render in a browser); and no PII in `detail` (errors end up in logs, third-party APM, and support tickets). Rate-limit error-generating endpoints too — login and validation endpoints are where credential-stuffing and enumeration happen, and `429` must apply to failures as much as successes. Finally, keep timing uniform on authentication failures so response time does not leak which check failed.

**Performance & scaling.** Under load shedding, return `503` with a `Retry-After` and — importantly — a *jittered* value, or every client retries in the same second and you get a thundering herd. Publish `Retry-After` on `429` for the same reason. Keep the error path allocation-light: pre-render static parts of common problem documents, avoid database lookups inside handlers, and make sure your logging is asynchronous and sampled, because an incident that generates a million errors per minute will otherwise take down the logging pipeline and then the service. Test this explicitly: a chaos drill where a dependency fails should show clean `503`s with backoff hints, not `500`s and a saturated log shipper.

## 9. Interview Questions

**Q: What is RFC 9457 and what problem does it solve?**
A: It standardizes an error response body — media type `application/problem+json` with members `type`, `title`, `status`, `detail`, `instance` plus arbitrary extensions. It obsoletes RFC 7807. The value is convergence: clients, SDKs, and gateways can rely on one shape instead of a bespoke error format per API.

**Q: What is the difference between `400` and `422`?**
A: `400` means the request was malformed and could not be understood — invalid JSON, a bad parameter type, a malformed header. `422 Unprocessable Content` means the syntax was fine but the content violates semantic rules, like an end date before a start date. `{"age": "abc"}` is a `400`; `{"age": -5}` is a `422`.

**Q: `401` or `403`?**
A: `401 Unauthorized` means unauthenticated — credentials are missing, malformed, or expired — and the response must include a `WWW-Authenticate` header. `403 Forbidden` means the caller is authenticated but not permitted; retrying with fresh credentials will not help. If even the resource's existence is sensitive, return `404` instead of `403`.

**Q: Why is returning `200 OK` with an error body harmful?**
A: The status code is the only part of a response every layer of the HTTP ecosystem understands. Client libraries treat `200` as success, retry middleware and circuit breakers never fire, gateways and CDNs cache it, and your error-rate dashboards read zero while customers fail. It also forces every client to write custom body-sniffing code.

**Q: Why should clients branch on `type`/`code` rather than the message?**
A: Messages are prose meant for humans — they get reworded, localized, and have punctuation fixed, all of which are non-breaking changes. A stable `type` URI or `code` string is part of your public contract, so clients can switch on it safely and render their own localized copy.

**Q: How do you report multiple validation failures?**
A: Return `422` with an `errors[]` extension member, each entry carrying an RFC 6901 JSON Pointer into the request body (`/items/0/qty`), a stable `code`, and a human `detail` — plus constraint metadata like `min` or `allowed`. Validate everything before responding so the client fixes all the problems in one pass.

**Q: What must a `500` response body contain, and what must it not?**
A: It should contain a generic title, the status, a neutral detail, and a `trace_id` the caller can quote to support. It must not contain stack traces, exception class names, SQL, file paths, library versions, or internal hostnames — that is reconnaissance data and it helps no legitimate client.

**Q: Which headers are mandatory or expected on specific errors?**
A: `401` must carry `WWW-Authenticate`; `405` must carry `Allow`; `429` and `503` should carry `Retry-After`; conditional-request failures use `412`, and `428` tells the client a precondition is required. Enforce these in one mapping layer and assert them in contract tests.

**Q: (Senior) How would you introduce a standard error contract into a large existing API without breaking clients?**
A: Add the new shape *additively*: keep existing top-level fields and add `type`, `title`, `status`, `detail` alongside them, then switch the `Content-Type` to `application/problem+json` only for new endpoints or behind a version/`Accept` negotiation. Build a shared error library so new code cannot produce a legacy shape, add contract tests asserting the schema and required headers per status, and instrument by `problem_type` to see which legacy shapes are still in use. Deprecate the old fields with `Deprecation`/`Sunset` headers once telemetry shows the remaining consumers, and remove them in the next major version.

**Q: (Senior) How do you decide whether a failure is `4xx` or `5xx`, and why does the distinction matter operationally?**
A: The test is: would repeating the identical request succeed without the client changing anything? If not — bad input, missing auth, violated business rule — it is `4xx`. If the request was valid and your system failed (bug, timeout, dependency down), it is `5xx`. This matters because `5xx` rate is your availability SLO and your paging signal, `5xx` triggers client retries and circuit breakers, and misclassifying a validation bug as `500` both pages your on-call at 3 a.m. and causes clients to retry something that will never succeed. Timeouts to a downstream service are a genuine grey area: `504`/`503` is honest, but if the downstream rejected the request on its merits, translate it to the right `4xx`.

**Q: (Senior) Your error rate dashboard is clean but customers report failures. What are the likely causes?**
A: The classic is `200 OK` with an error body somewhere in the stack — often a legacy endpoint or a gateway that swallows upstream failures. Others: errors returned as `4xx` that are actually server bugs (so they never hit the `5xx` SLO); an API gateway or CDN serving cached error pages that never reach your instrumentation; client-side failures (timeouts, TLS, DNS) that never produce a server-side request at all; and metric cardinality drops where a high-cardinality `problem_type` label got sampled away. Diagnose by comparing client-observed success rate (RUM/SDK telemetry) with server-side rates, and by asserting in contract tests that no endpoint can return `2xx` with an error-shaped body.

**Q: (Senior) What information-disclosure risks live in error handling, and how do you mitigate them systematically?**
A: Four categories: **implementation leakage** (stack traces, SQL, versions, paths) — fixed by a catch-all handler that never serializes exception internals; **existence leakage** (distinguishing `403` from `404`, or "unknown user" from "wrong password") — fixed by uniform responses and uniform timing on the auth path; **data leakage** (PII echoed in `detail`, or another tenant's identifiers in a batch error array) — fixed by a redaction pass and by never echoing raw input; and **behavioural leakage** (differing response times or rate-limit behaviour revealing whether a resource exists). Systematically, centralize error rendering in one library, add tests that fuzz endpoints and assert no forbidden substrings appear in any response, and review error copy in the same way you review API docs.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Errors are part of the contract. Use the **status code** as the category — `4xx` means the client must change something, `5xx` means the server failed and a retry may work — and never return `200 OK` with an error body, because every SDK, retry policy, gateway and SLO reads the status and not the body. Put the details in an **RFC 9457 problem document** served as `application/problem+json`: `type` (a stable, documented URI that clients switch on), `title` (fixed human summary), `status`, `detail` (this occurrence, never parsed), `instance`, plus extensions like `errors[]` with RFC 6901 JSON Pointers, `trace_id`, and `retry_after`. Emit *all* validation failures at once. Honour the protocol headers: `WWW-Authenticate` on `401`, `Allow` on `405`, `Retry-After` on `429`/`503`. Keep `500` bodies generic with only a trace id, log the real detail server-side, and centralize the exception-to-problem mapping in exactly one layer so every endpoint answers the same way.

| Code | Use when | Required/expected header |
|---|---|---|
| `400` | Malformed syntax, unparseable body/param | — |
| `401` | Missing or invalid credentials | `WWW-Authenticate` |
| `403` | Authenticated but not permitted | — |
| `404` / `410` | Not found / permanently gone | — |
| `405` | Method not allowed on this URI | `Allow` |
| `409` | Conflicts with current state | — |
| `412` / `428` | Precondition failed / required | — |
| `415` | Unsupported `Content-Type` | `Accept-Post` (optional) |
| `422` | Understood but semantically invalid | — |
| `429` | Rate limit exceeded | `Retry-After`, `RateLimit-*` |
| `500` | Unhandled server fault | — |
| `503` | Overloaded / dependency down | `Retry-After` (jittered) |

- **The media type** → `application/problem+json` (RFC 9457, obsoletes 7807).
- **Five members** → `type`, `title`, `status`, `detail`, `instance` — plus any extensions.
- **`400` vs `422`** → couldn't parse it vs parsed it and it's still wrong.
- **`401` vs `403`** → who are you? vs you may not do that.
- **Client branches on** → status + `type`/`code`, never on `detail` text.

## 11. Hands-On Exercises & Mini Project

- [ ] Convert an existing endpoint's ad-hoc error body to RFC 9457 and write a contract test asserting the media type, the five members, and the status/`type` pair.
- [ ] Add a FastAPI (or Express) handler that reshapes framework validation errors into `errors[]` with JSON Pointers, then verify a nested body like `/items/2/price` produces the right pointer.
- [ ] Build a catch-all `500` handler that logs the stack trace and returns only a `trace_id`; add a test that greps the response for "Traceback", "SELECT", and your hostname and fails if any appear.
- [ ] Write a client wrapper that maps `429`/`503` + `Retry-After` to a retry with jitter, `401` to a token refresh, and `422` to per-field highlighting driven by pointers.
- [ ] Add Prometheus counters labelled by `problem_type` and prove the label cardinality stays bounded when you fuzz the API with random ids.

**Mini Project — an error contract library.**
*Goal:* Build a reusable module that guarantees every response from a service is either a valid success payload or a valid problem document.
*Requirements:* A `problem()` factory; a registry mapping domain exception classes to `(status, type, title)`; handlers for domain errors, framework validation errors, HTTP exceptions, and unhandled exceptions; automatic `trace_id` and `instance` injection; enforcement of `WWW-Authenticate`/`Allow`/`Retry-After` per status; a redaction pass over `detail`; a published `problems/` docs page for every `type`; and a JSON Schema plus test suite validating every emitted document.
*Extensions:* Generate the OpenAPI `Problem` schema and per-endpoint error responses automatically from the registry; add localization by mapping `code` to message catalogues; add a middleware that fails CI if any handler returns `2xx` with an error-shaped body; emit metrics by `problem_type` and build a dashboard that separates the `4xx` product signal from the `5xx` availability signal.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *HTTP Status Codes* for the full catalogue behind §3.1; *Validation & Input Handling* (chapter 17) for producing the `errors[]` array; *Bulk & Batch Operations* (chapter 15) for per-item errors inside a `207`; *Rate Limiting & Throttling* for `429` and `Retry-After`; *Idempotency & Retries* for how clients act on retryable errors; *Observability & Logging* for the `trace_id` correlation story.

**Free Learning Resources**
- **RFC 9457 — Problem Details for HTTP APIs** — IETF · *Intermediate* · the standard itself; short, readable, and full of concrete examples. <https://www.rfc-editor.org/rfc/rfc9457>
- **RFC 9110 §15 — HTTP Status Codes** — IETF · *Intermediate* · the normative meaning of every status code, including the `400`/`422` and `401`/`403` boundaries. <https://www.rfc-editor.org/rfc/rfc9110#name-status-codes>
- **MDN — HTTP response status codes** — Mozilla · *Beginner* · the fastest reliable lookup for what a code means and which headers accompany it. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Status>
- **Stripe API — Errors** — Stripe · *Beginner* · the reference example of a stable, well-documented error-code taxonomy with parameter pointers. <https://docs.stripe.com/api/errors>
- **Zalando RESTful API Guidelines — Error handling** — Zalando · *Intermediate* · prescriptive corporate rules mandating problem+json and consistent status usage. <https://opensource.zalando.com/restful-api-guidelines/#176>
- **Microsoft REST API Guidelines — Errors** — Microsoft · *Intermediate* · an alternative, widely-copied error envelope with strong rules on codes and nesting. <https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md#errors>
- **OWASP Cheat Sheet — Error Handling** — OWASP · *Intermediate* · the security view: what must never appear in an error response and how to log safely. <https://cheatsheetseries.owasp.org/cheatsheets/Error_Handling_Cheat_Sheet.html>

---

*REST API Handbook — chapter 16.*
