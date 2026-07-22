# 23 · OWASP API Security Top 10

> **In one line:** The 2023 list is dominated by *authorization* failures — BOLA, broken authentication, object property level authorization, function level authorization — because APIs expose object identifiers and business operations directly, and no framework can guess your ownership rules.

---

## 1. Overview

The OWASP API Security Top 10 exists because the classic web Top 10 stopped describing how applications actually break. When rendering moved to the client, the server stopped being a page factory and became a set of fine-grained object endpoints. Injection and XSS dropped in relative importance; *authorization* rose to dominate, because every `GET /orders/{id}` is now an invitation to change the ID and see what happens. OWASP published the first API-specific list in **2019** and refreshed it in **2023**, drawing on bug bounty data, published breaches and practitioner surveys.

The 2023 edition is worth memorising because the changes encode real lessons. **API1 (BOLA)** stayed at #1 — it is still, by a wide margin, the most exploited API flaw. **API3** was renamed from "Excessive Data Exposure" to **Broken Object Property Level Authorization**, merging it with mass assignment, because reading a property you shouldn't and writing a property you shouldn't are the same missing check in opposite directions. **API4** became "Unrestricted Resource Consumption", broadening rate limiting to cover money — an unmetered SMS or LLM endpoint burns budget, not just CPU. Two entries are new: **API6 Unrestricted Access to Sensitive Business Flows** (the API works exactly as designed, but automation abuses it — scalping, mass account creation, inventory hoarding) and **API10 Unsafe Consumption of APIs** (you validate user input rigorously and then blindly trust a third-party API's response).

The problem this list solves is *prioritisation*. Security work is unbounded; the Top 10 tells you the ten things that actually get exploited, ranked. It is not a compliance checklist — OWASP is explicit that it is an awareness document — but as a threat model for API design reviews it is the best free artifact available.

A concrete example that touches five entries at once: in 2021 researchers found a fitness-equipment vendor's API returning full user profiles — age, weight, gender, workout history — for any user ID, to any authenticated caller, and initially to *unauthenticated* callers. That is API1 (no object-level check), API3 (fields far beyond what the UI needed), API4 (no rate limit, so enumeration was trivial), API8 (endpoint shipped without an auth requirement) and API9 (nobody had an inventory saying the endpoint existed). One missing `WHERE user_id = ?` cascaded through the whole list.

The mental model to carry into an interview: **the 2023 list is 60% authorization, 20% resource limits, 20% operational hygiene.** If you fix object-level authorization, property-level authorization, function-level authorization and consumption limits, you have addressed the majority of real-world API compromise.

---

## 2. Core Concepts

- **BOLA (API1)** — Broken Object Level Authorization: an authenticated user accesses another user's object by changing an identifier. Also called IDOR.
- **Broken Authentication (API2)** — weak or missing credential verification: no rate limit on login, weak JWT validation, tokens in URLs, no account lockout, guessable password reset flows.
- **BOPLA (API3)** — Broken Object *Property* Level Authorization: excessive data exposure (returning fields the caller may not read) plus mass assignment (accepting fields the caller may not write).
- **Unrestricted Resource Consumption (API4)** — no limits on requests, page size, payload size, upload size, execution time, or paid downstream operations (SMS, email, LLM tokens).
- **BFLA (API5)** — Broken Function Level Authorization: a regular user invokes an administrative operation because the route was never guarded.
- **Sensitive Business Flows (API6)** — the API behaves correctly, but unrestricted automation of a valuable flow (ticket purchase, promo redemption, signup) causes business harm.
- **SSRF (API7)** — Server-Side Request Forgery: the API fetches a user-supplied URL, letting an attacker reach internal services, cloud metadata endpoints, or the loopback interface.
- **Security Misconfiguration (API8)** — permissive CORS, missing security headers, verbose stack traces, debug endpoints, default credentials, unpatched components.
- **Improper Inventory Management (API9)** — forgotten `v1` hosts, undocumented endpoints, staging environments with production data; you cannot defend what you do not know exists.
- **Unsafe Consumption of APIs (API10)** — trusting third-party responses: no schema validation, following their redirects blindly, passing their data into your database or template engine.

---

## 3. Theory & Principles

**Why authorization dominates.** A monolithic server-rendered app performed authorization implicitly: the page you were shown was assembled server-side from queries already scoped to you. An API inverts this. The client asks for `/orders/8812` directly, so the authorization decision must be made *explicitly, per object, per endpoint*. There is no framework default for "is this order yours?" because that predicate is your domain model. Every endpoint is a new opportunity to forget.

**The enumeration economics.** BOLA is cheap to exploit because identifiers are usually sequential or short. If IDs are 32-bit sequential integers and you have 10 million records, an attacker needs ~10 million requests to enumerate everything — at 100 rps that is 28 hours, at 1,000 rps under 3 hours. Switching to UUIDv4 raises the search space to 2^122, making blind enumeration impossible — but this is **defence in depth only**. Unguessable IDs leak through referrals, logs, shared links and exports; the object check is the control, and the ID format merely raises the cost of finding gaps.

**BOPLA is one bug with two directions.** Consider a `User` model with `email`, `role`, `stripe_customer_id`, `internal_risk_score`. Serialising the whole model on read is *excessive data exposure*; binding the whole request body on write is *mass assignment*. Both come from the same root cause — the transport schema being coupled to the persistence schema. The structural fix is an explicit DTO per direction per role: a read schema that lists what may be returned and a write schema that lists what may be accepted, both allow-lists, never denylists (a denylist misses every field added later).

**Resource consumption is an availability *and* a cost problem.** Model it: if an endpoint calls a paid downstream at $0.002 per call and an attacker sustains 500 rps for an hour, that is 1.8 M calls and $3,600 — no outage, just an invoice. The 2023 rename to "Unrestricted Resource Consumption" exists precisely because "rate limiting" undersold this. Limits must be multi-dimensional: requests per principal, page size, payload bytes, upload bytes, query complexity (for GraphQL, depth and cost), execution timeout, and per-tenant spend quotas on paid operations.

**SSRF is a trust-boundary failure.** The server has network privileges the user does not: it sits inside the VPC, can reach `169.254.169.254` (cloud metadata), `127.0.0.1`, and internal admin panels. Any feature that fetches a user-supplied URL — webhooks, image imports, PDF rendering, "check my site" tools — hands the attacker those privileges. Blocklists fail: `http://[::ffff:169.254.169.254]`, decimal IPs (`http://2852039166`), DNS rebinding (a hostname that resolves to a public IP at validation time and to `127.0.0.1` at fetch time) all bypass naive filters. The only robust defences are an **allow-list of destination hosts**, resolving DNS once and connecting to the resolved IP, blocking redirects, and egressing through a dedicated proxy in a network segment with no route to internal services. IMDSv2 (session-token-required metadata) closes the cloud-credential path specifically.

```svg
<svg viewBox="0 0 780 370" width="100%" height="370" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="370" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">OWASP API Security Top 10 (2023) grouped by root cause</text>
  <rect x="18" y="42" width="240" height="160" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="34" y="64" font-size="13" font-weight="700" fill="#1e293b">AUTHORIZATION (the majority)</text>
  <text x="34" y="86" font-size="11" fill="#1e293b">API1 BOLA &#8212; wrong object</text>
  <text x="34" y="104" font-size="11" fill="#1e293b">API3 BOPLA &#8212; wrong property</text>
  <text x="34" y="122" font-size="11" fill="#1e293b">API5 BFLA &#8212; wrong function</text>
  <text x="34" y="140" font-size="11" fill="#1e293b">API2 Broken authentication</text>
  <text x="34" y="164" font-size="10" fill="#1e293b">Root cause: the check is domain</text>
  <text x="34" y="180" font-size="10" fill="#1e293b">specific, so no framework default</text>
  <text x="34" y="196" font-size="10" font-weight="700" fill="#d97706">Fix: deny by default, per object</text>
  <rect x="272" y="42" width="240" height="160" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="288" y="64" font-size="13" font-weight="700" fill="#1e293b">CONSUMPTION</text>
  <text x="288" y="86" font-size="11" fill="#1e293b">API4 Unrestricted resource use</text>
  <text x="288" y="104" font-size="11" fill="#1e293b">API6 Sensitive business flows</text>
  <text x="288" y="128" font-size="10" fill="#1e293b">Not just CPU: paid downstream</text>
  <text x="288" y="144" font-size="10" fill="#1e293b">calls, SMS, LLM tokens, seats</text>
  <text x="288" y="160" font-size="10" fill="#1e293b">Automation of a correct flow</text>
  <text x="288" y="176" font-size="10" fill="#1e293b">is still an attack</text>
  <text x="288" y="196" font-size="10" font-weight="700" fill="#0ea5e9">Fix: multi-dimensional quotas</text>
  <rect x="526" y="42" width="236" height="160" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="542" y="64" font-size="13" font-weight="700" fill="#1e293b">BOUNDARY + HYGIENE</text>
  <text x="542" y="86" font-size="11" fill="#1e293b">API7 SSRF</text>
  <text x="542" y="104" font-size="11" fill="#1e293b">API8 Security misconfiguration</text>
  <text x="542" y="122" font-size="11" fill="#1e293b">API9 Improper inventory</text>
  <text x="542" y="140" font-size="11" fill="#1e293b">API10 Unsafe consumption</text>
  <text x="542" y="164" font-size="10" fill="#1e293b">Root cause: trusting a party or</text>
  <text x="542" y="180" font-size="10" fill="#1e293b">a default you did not verify</text>
  <text x="542" y="196" font-size="10" font-weight="700" fill="#16a34a">Fix: allow-lists + inventory</text>
  <rect x="18" y="216" width="744" height="66" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="34" y="238" font-size="13" font-weight="700" fill="#1e293b">Enumeration economics (why BOLA is cheap)</text>
  <text x="34" y="258" font-size="11" fill="#1e293b">sequential 32-bit ids, 10M rows, 1000 rps  &#8594;  full enumeration in under 3 hours</text>
  <text x="34" y="276" font-size="11" fill="#1e293b">UUIDv4 (2^122 space) makes blind scanning infeasible &#8212; but it is defence in depth, NOT the control.</text>
  <rect x="18" y="296" width="744" height="60" rx="10" fill="#ffffff" stroke="#d97706" stroke-width="2" stroke-dasharray="5 3"/>
  <text x="34" y="318" font-size="12" font-weight="700" fill="#1e293b">Changes from 2019 &#8594; 2023</text>
  <text x="34" y="338" font-size="11" fill="#1e293b">Excessive data exposure + mass assignment merged into API3 BOPLA. Rate limiting broadened to API4.</text>
  <text x="34" y="352" font-size="11" fill="#1e293b">New: API6 sensitive business flows, API10 unsafe consumption of third-party APIs.</text>
</svg>
```

---

## 4. Architecture & Workflow

Defences layer from edge to data. A request for `GET /v1/users/8812/orders?limit=100000` traverses:

1. **Edge / WAF.** TLS termination, IP reputation, and generic signature filtering. Useful for volumetric noise; useless against BOLA, because a BOLA request is syntactically indistinguishable from a legitimate one. Never let a WAF be your authorization story.
2. **Gateway.** Authenticates the token (signature, `iss`, `aud`, `exp`), enforces coarse scope, applies per-principal rate limits, caps request body size, and **rejects unknown routes** — anything not in the published OpenAPI spec is a 404 at the edge, which is your API9 control.
3. **Schema validation.** Validate the request against the OpenAPI schema *before* business logic: `additionalProperties: false` (mass-assignment defence), `maximum` on `limit`, `maxLength` on strings, `format` on URLs and emails. Reject with `400` for malformed syntax, `422` for well-formed-but-semantically-invalid.
4. **Function gate.** The route declares a required permission; an undeclared route fails startup. This is the API5/BFLA control and it must be structural, not a code-review convention.
5. **Object gate.** Load with the ownership predicate: `WHERE id = :id AND tenant_id = :tid`. Never `WHERE id = :id`. This is the API1/BOLA control — the single highest-value line of code in the system.
6. **Property gate on write.** Bind to an explicit input DTO listing only the fields *this role* may set. `role`, `tenant_id`, `is_verified`, `balance_cents` are never client-writable.
7. **Business-flow controls.** For flows with real-world value (checkout, signup, promo redemption), add per-identity velocity limits, device fingerprinting, proof-of-work or CAPTCHA on anomalies, and queue-based fairness. This is API6, and it is a product decision as much as a security one.
8. **Egress control for outbound fetches.** Any user-supplied URL goes through a dedicated egress proxy: host allow-list, DNS resolved once and pinned, private/link-local IP ranges refused, redirects disabled, response size and timeout capped. This is API7.
9. **Property gate on read.** Serialize through an explicit output DTO per role. Field-level filtering is authorization; the ORM object is not a response.
10. **Third-party response validation.** Treat every upstream response as untrusted input: validate against a schema, cap size, set timeouts, do not follow redirects to new hosts, and never interpolate it into SQL, shell or templates. This is API10.
11. **Observability.** Emit a structured decision record for every deny, with principal, action, object and reason — the substrate for detecting enumeration.

```svg
<svg viewBox="0 0 780 380" width="100%" height="380" xmlns="http://www.w3.org/2000/svg" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="380" fill="#ffffff"/>
  <text x="18" y="24" font-size="15" font-weight="700" fill="#1e293b">Defence layers and which OWASP entry each stops</text>
  <rect x="18" y="40" width="152" height="58" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="40" y="62" font-size="12" font-weight="700" fill="#1e293b">Edge / WAF</text>
  <text x="28" y="80" font-size="10" fill="#1e293b">volumetric, TLS, IP rep</text>
  <text x="28" y="93" font-size="10" font-weight="700" fill="#d97706">cannot stop BOLA</text>
  <rect x="196" y="40" width="152" height="58" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="218" y="62" font-size="12" font-weight="700" fill="#1e293b">Gateway</text>
  <text x="206" y="80" font-size="10" fill="#1e293b">authn, scope, quota, size</text>
  <text x="206" y="93" font-size="10" font-weight="700" fill="#4f46e5">API2 API4 API9</text>
  <rect x="374" y="40" width="152" height="58" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="396" y="62" font-size="12" font-weight="700" fill="#1e293b">Schema</text>
  <text x="384" y="80" font-size="10" fill="#1e293b">additionalProperties false</text>
  <text x="384" y="93" font-size="10" font-weight="700" fill="#16a34a">API3 write side</text>
  <rect x="552" y="40" width="210" height="58" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="574" y="62" font-size="12" font-weight="700" fill="#1e293b">Service</text>
  <text x="562" y="80" font-size="10" fill="#1e293b">function gate then object gate</text>
  <text x="562" y="93" font-size="10" font-weight="700" fill="#d97706">API5 then API1</text>
  <line x1="170" y1="69" x2="192" y2="69" stroke="#1e293b" stroke-width="2"/>
  <line x1="348" y1="69" x2="370" y2="69" stroke="#1e293b" stroke-width="2"/>
  <line x1="526" y1="69" x2="548" y2="69" stroke="#1e293b" stroke-width="2"/>
  <rect x="18" y="114" width="744" height="96" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="34" y="136" font-size="13" font-weight="700" fill="#1e293b">Data access: the two lines that matter most</text>
  <text x="34" y="158" font-size="11" fill="#1e293b">SELECT ... FROM orders WHERE id = :id AND tenant_id = :tid      &#8592; API1 BOLA</text>
  <text x="34" y="178" font-size="11" fill="#1e293b">OrderWriteDTO(status, note) only &#8212; never bind role, tenant_id, balance   &#8592; API3 mass assignment</text>
  <text x="34" y="198" font-size="11" font-weight="700" fill="#4f46e5">Both are allow-lists. Denylists miss every field and every table added next quarter.</text>
  <rect x="18" y="226" width="366" height="140" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="34" y="248" font-size="13" font-weight="700" fill="#1e293b">Egress proxy (API7 SSRF)</text>
  <text x="34" y="270" font-size="11" fill="#1e293b">1. parse URL, require https scheme</text>
  <text x="34" y="288" font-size="11" fill="#1e293b">2. host must be in the allow-list</text>
  <text x="34" y="306" font-size="11" fill="#1e293b">3. resolve DNS once, pin the IP</text>
  <text x="34" y="324" font-size="11" fill="#1e293b">4. refuse private / link-local ranges</text>
  <text x="34" y="342" font-size="11" fill="#1e293b">5. no redirects, cap size and timeout</text>
  <text x="34" y="360" font-size="10" font-weight="700" fill="#16a34a">blocks 169.254.169.254, 127.0.0.1, rebinding</text>
  <rect x="396" y="226" width="366" height="140" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="412" y="248" font-size="13" font-weight="700" fill="#1e293b">Response path</text>
  <text x="412" y="270" font-size="11" fill="#1e293b">output DTO per role (API3 read side)</text>
  <text x="412" y="288" font-size="11" fill="#1e293b">404 not 403 when existence is sensitive</text>
  <text x="412" y="306" font-size="11" fill="#1e293b">problem+json, no stack traces (API8)</text>
  <text x="412" y="324" font-size="11" fill="#1e293b">validate upstream payloads too (API10)</text>
  <text x="412" y="342" font-size="11" fill="#1e293b">emit deny records for detection</text>
  <text x="412" y="360" font-size="10" font-weight="700" fill="#d97706">many 404s across many ids = enumeration</text>
</svg>
```

---

## 5. Implementation

**API1 — BOLA. The wrong version and the right one:**

```python
# VULNERABLE: authenticated, but any user can read any order
@app.get("/v1/orders/{order_id}")
async def get_order_bad(order_id: str, p: Principal = Depends(current_principal)):
    return await db.fetch_one("SELECT * FROM orders WHERE id = :id", {"id": order_id})

# CORRECT: ownership is part of the query, and a miss is indistinguishable from not-found
@app.get("/v1/orders/{order_id}", response_model=OrderRead)
async def get_order(order_id: str, p: Principal = Depends(requires("order.read"))):
    row = await db.fetch_one(
        "SELECT id, status, total_cents, created_at FROM orders "
        "WHERE id = :id AND tenant_id = :tid", {"id": order_id, "tid": p.tenant_id})
    if row is None:
        raise HTTPException(404, "order not found")
    return OrderRead.model_validate(row)
```

**API3 — BOPLA in both directions, with Pydantic:**

```python
from pydantic import BaseModel, ConfigDict, Field

class OrderRead(BaseModel):                    # read allow-list
    model_config = ConfigDict(from_attributes=True)
    id: str; status: str; total_cents: int; created_at: datetime
    # NOT exposed: internal_margin_cents, fraud_score, customer_email, gateway_ref

class OrderUpdate(BaseModel):                  # write allow-list
    model_config = ConfigDict(extra="forbid")  # unknown field -> 422, not silently ignored
    note: str | None = Field(default=None, max_length=500)
    status: Literal["pending", "cancelled"] | None = None
    # NOT accepted: tenant_id, total_cents, fraud_score, is_paid
```

```http
PATCH /v1/orders/ord_88 HTTP/1.1
Content-Type: application/merge-patch+json

{"note": "customer called", "total_cents": 1, "tenant_id": "ten_other"}
```

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{ "type": "https://api.acme.io/problems/validation-error",
  "title": "Unknown fields in request body", "status": 422,
  "errors": [ {"pointer": "/total_cents", "detail": "field is not writable"},
              {"pointer": "/tenant_id",  "detail": "field is not writable"} ] }
```

> **Note:** Reject unknown fields with `422` rather than silently dropping them. Silent drops hide integration bugs *and* hide attack attempts from your logs.

**API4 — multi-dimensional consumption limits:**

```yaml
paths:
  /v1/orders:
    get:
      parameters:
        - { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 25 } }
        - { name: cursor, in: query, schema: { type: string, maxLength: 128 } }
      responses:
        '200': { description: OK }
        '429': { description: Rate limit exceeded, see Retry-After }
```

```python
@app.post("/v1/notifications/sms")
@limiter.limit("10/minute")                        # per principal
async def send_sms(body: SmsRequest, p: Principal = Depends(requires("sms.send"))):
    spent = await quota.get(p.tenant_id, "sms_month")
    if spent >= p.tenant_sms_quota:                # money, not just CPU
        raise HTTPException(429, "monthly SMS quota exhausted",
                            headers={"Retry-After": str(seconds_to_month_end())})
    await quota.incr(p.tenant_id, "sms_month")
    ...
```

**API7 — an SSRF-resistant fetcher:**

```python
import ipaddress, socket
from urllib.parse import urlparse
import httpx

ALLOWED_HOSTS = {"images.partner.com", "cdn.partner.com"}
BLOCKED_NETS = [ipaddress.ip_network(n) for n in (
    "0.0.0.0/8", "10.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16",
    "172.16.0.0/12", "192.168.0.0/16", "::1/128", "fc00::/7", "fe80::/10")]

async def safe_fetch(url: str, max_bytes: int = 5_000_000) -> bytes:
    u = urlparse(url)
    if u.scheme != "https" or u.hostname not in ALLOWED_HOSTS:
        raise ValueError("destination not allowed")
    infos = socket.getaddrinfo(u.hostname, 443, proto=socket.IPPROTO_TCP)
    ip = ipaddress.ip_address(infos[0][4][0])              # resolve ONCE
    if any(ip in net for net in BLOCKED_NETS) or ip.is_private:
        raise ValueError("resolved to a private address")
    async with httpx.AsyncClient(follow_redirects=False, timeout=5.0) as c:
        r = await c.get(f"https://{ip}/{u.path.lstrip('/')}",
                        headers={"Host": u.hostname})       # pin the IP, keep SNI/Host
        r.raise_for_status()
        if len(r.content) > max_bytes:
            raise ValueError("response too large")
        return r.content
```

**API10 — never trust an upstream response:**

```javascript
const res = await fetch(partnerUrl, {
  signal: AbortSignal.timeout(5000),
  redirect: 'error',                       // do not follow to an unknown host
  headers: { accept: 'application/json' },
});
if (!res.ok) throw new UpstreamError(res.status);
const len = Number(res.headers.get('content-length') ?? 0);
if (len > 1_000_000) throw new UpstreamError('payload too large');
const body = PartnerSchema.parse(await res.json());   // zod: validate, do not assume
// body.name goes into the DB as a parameter, never into a template or SQL string
```

**Automated cross-tenant probe — the highest-ROI test you can write:**

```bash
# For every object endpoint, replay tenant B's ids with tenant A's token.
for id in $(jq -r '.data[].id' tenantB_orders.json); do
  code=$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN_A" "https://api.acme.io/v1/orders/$id")
  [ "$code" = "404" ] || [ "$code" = "403" ] || echo "BOLA on $id -> $code"
done
```

**Optimization note.** Security controls sit on the hot path, so make them cheap. Schema validation with a compiled validator (Pydantic v2's Rust core, `ajv` with precompilation) costs microseconds, not milliseconds — never hand-roll per-field checks in Python or JavaScript. Push the ownership predicate into the SQL `WHERE` clause with a composite index on `(tenant_id, id)` so the object check is free rather than a second query. Rate-limit counters belong in Redis with a Lua script performing check-and-increment atomically in one round trip. And prefer *structural* controls that cost nothing at runtime — a startup assertion that every route declares a permission, an OpenAPI spec with `additionalProperties: false` generating both the validator and the docs — over runtime checks a tired engineer can forget.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Using the Top 10 as a threat model | Free, evidence-based prioritisation; a shared vocabulary for design reviews | Awareness document, not a standard; passing it is not "secure" |
| Deny-by-default authorization | Structurally eliminates API1 and API5 for forgotten routes | Every new route needs a deliberate permission decision; slows greenfield velocity slightly |
| Explicit read/write DTOs | Kills API3 in both directions; schema doubles as documentation | Boilerplate per resource per role; drift risk if not generated from one spec |
| UUID/ULID identifiers | Makes blind enumeration infeasible; safe in logs and URLs | Larger indexes, worse locality than sequential ints; not a substitute for the check |
| WAF / API security gateway | Catches volumetric abuse and known signatures; fast to deploy | Blind to BOLA and business-logic abuse; creates false confidence |
| Egress allow-list proxy | The only reliable SSRF defence; centralised and auditable | Operational friction — every new integration needs an allow-list change |
| API inventory + spec-driven routing | Closes API9; unknown routes 404 at the edge | Requires discipline: the spec must be the source of truth, not an afterthought |
| Business-flow controls (API6) | Protects revenue from automation that is technically "valid" traffic | Friction for real users; CAPTCHAs and device checks have accessibility and privacy costs |
| Verbose error detail | Excellent developer experience | Leaks stack traces, versions and internal structure (API8); use problem+json with stable codes |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Fetching an object by ID without an ownership predicate.** → ✅ `WHERE id = :id AND tenant_id = :tid`, always, in the repository layer so no handler can bypass it. This is API1 and it is #1 for a reason.
2. ⚠️ **Relying on unguessable IDs as the access control.** → ✅ UUIDs raise the cost of enumeration but leak through logs, referrers and exports. Keep them, but the authorization check is the control.
3. ⚠️ **Returning the ORM model directly.** → ✅ Serialize through an explicit read DTO. `internal_notes`, `fraud_score` and `cost_basis` reach the client the moment someone adds a column.
4. ⚠️ **Binding the whole request body to the model.** → ✅ `extra="forbid"` / `additionalProperties: false` plus a per-role write allow-list. Otherwise `{"role":"admin"}` is a privilege escalation.
5. ⚠️ **Rate limiting only login.** → ✅ Limit every endpoint per principal, and add page-size caps, body-size caps, timeouts, and *spend* quotas on paid downstreams. API4 covers money, not just CPU.
6. ⚠️ **Guarding admin routes by URL prefix.** → ✅ Deny by default with a declared permission per route; a missing declaration fails startup. Prefix conventions miss `/v1/orders/{id}/force-refund`.
7. ⚠️ **Fetching user-supplied URLs with the default HTTP client.** → ✅ Host allow-list, resolve-once-and-pin, private-range rejection, redirects disabled, size and timeout caps, egress through a segmented proxy. Blocklists lose to decimal IPs and DNS rebinding.
8. ⚠️ **Leaving old versions and hosts running.** → ✅ Maintain a live inventory; `api-v1.acme.io` still serving after the v2 migration is the classic API9 breach path, usually unpatched and unmonitored.
9. ⚠️ **Verbose errors in production.** → ✅ RFC 9457 problem details with stable `type` URIs and a `request_id`. Stack traces, SQL fragments and framework versions belong in logs, not responses.
10. ⚠️ **Trusting third-party API responses.** → ✅ Validate against a schema, cap size, set timeouts, refuse cross-host redirects, and treat the payload as untrusted input everywhere downstream (API10).
11. ⚠️ **Treating "no bug found in pentest" as done.** → ✅ Pentests sample; automated cross-tenant probes over every endpoint in your spec run on every commit and catch the endpoint added last Tuesday.
12. ⚠️ **Ignoring business-flow abuse because "it is valid traffic".** → ✅ API6 is real damage: bulk signups, scalping, promo farming. Add velocity limits per identity, anomaly scoring and fairness queues on high-value flows.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Give every response a `X-Request-Id` (or `traceparent`) and echo it in problem details so a user report maps to exactly one trace. When investigating a suspected BOLA, reconstruct the sequence: which principal, which object IDs, in what order, with what outcomes. Structured deny records (`{principal, action, object_id, decision, reason, request_id}`) make this a query rather than a log grep. Keep an internal endpoint that explains an authorization decision for a given `(subject, action, resource)` — the single biggest time saver during incident response.

**Monitoring.** The signals that actually detect the Top 10: distinct object IDs requested per principal per hour (enumeration), ratio of `404`/`403` to `200` per principal (probing), `422` rate with unknown-field errors (mass-assignment attempts), requests to routes absent from the OpenAPI spec (shadow API discovery, API9), egress destinations from your fetch service that are not on the allow-list (SSRF attempts), and per-tenant spend on paid downstreams versus quota (API4). Track signup, checkout and promo-redemption rates per identity and per device for API6. Alert on: any principal exceeding N distinct denied object IDs in 10 minutes; any 5xx carrying a stack trace; any new route appearing in traffic that is not in the spec.

**Security.** Run the controls as *gates*, not advice: OpenAPI-driven request validation in CI and at runtime, a startup assertion that every route declares a permission, an automated cross-tenant probe in the pipeline, and a dependency/CVE scan on every build (API8). Rotate credentials and keep secrets out of source with a scanner on every push. Maintain the API inventory automatically — generate it from routing tables and reconcile against the published spec, so shadow endpoints surface as a diff. Adopt IMDSv2 and give the egress proxy an IAM role with no permissions. Segment networks so that even a successful SSRF reaches nothing interesting.

**Performance & scaling.** Authorization checks scale linearly if they are indexed lookups; they become a problem only when someone fetch-then-filters. Composite indexes on `(tenant_id, id)` and `(tenant_id, created_at)` keep both point reads and list queries fast. Rate-limit state should live in a Redis cluster keyed by principal with a Lua check-and-increment; for extreme scale, use approximate local counters with periodic reconciliation and accept small overshoot. Schema validation is CPU-bound — use compiled validators and validate once at the edge rather than repeatedly in every service. Finally, budget for the fact that security logging is high-volume: sample permits, keep 100% of denies, and set retention by compliance requirement rather than by disk anxiety.

---

## 9. Interview Questions

**Q: What is BOLA and why has it been #1 in both the 2019 and 2023 lists?**
A: Broken Object Level Authorization is when an endpoint authenticates the caller but never verifies the requested object belongs to them, so changing an ID in the URL returns someone else's data. It stays at #1 because the check is per-object and domain-specific — no framework provides a default — and because single-tenant test suites never exercise it.

**Q: What changed between the 2019 and 2023 editions?**
A: Excessive Data Exposure and Mass Assignment merged into API3 Broken Object Property Level Authorization; rate limiting broadened into API4 Unrestricted Resource Consumption to cover cost as well as availability; and two new entries appeared — API6 Unrestricted Access to Sensitive Business Flows and API10 Unsafe Consumption of APIs.

**Q: Why is BOPLA one category and not two?**
A: Reading a property you shouldn't and writing a property you shouldn't are the same missing check in opposite directions, both caused by coupling the transport schema to the persistence schema. The single fix — explicit read and write DTOs that are allow-lists — resolves both.

**Q: Will a WAF protect you from BOLA?**
A: No. A BOLA request is syntactically identical to a legitimate one; only your domain model knows the object does not belong to the caller. WAFs handle volumetric abuse and known signatures, so treat them as noise reduction, never as the authorization layer.

**Q: How do you defend against SSRF properly?**
A: Allow-list destination hosts, resolve DNS once and connect to the pinned IP (which defeats rebinding), reject private and link-local ranges, disable redirects, cap response size and timeout, and route all outbound user-driven fetches through a segmented egress proxy. Enable IMDSv2 so the cloud metadata path is closed even if something slips through.

**Q: What is API6 and why is it security rather than product?**
A: Unrestricted Access to Sensitive Business Flows: the API works exactly as designed, but automating it at scale causes business harm — ticket scalping, promo farming, bulk fake signups, inventory hoarding. It is security because the attacker's goal is damage and the defences (velocity limits, device signals, fairness queues) are security controls, even though no technical flaw exists.

**Q: What is API9 and why does it lead to breaches so often?**
A: Improper Inventory Management: forgotten hosts, undocumented endpoints and staging environments holding production data. Old versions keep serving after a migration, stop getting patched, and are excluded from monitoring — so they are simultaneously the weakest and the least-watched surface.

**Q: (Senior) You have three months and one engineer. Prioritise work against the 2023 list for a mid-size SaaS.**
A: Month one goes to authorization: an automated cross-tenant probe over every endpoint in the OpenAPI spec, a repository layer that cannot fetch without a tenant predicate, and a startup assertion that every route declares a permission — that addresses API1, API3 and API5, which are the majority of real compromise. Month two is consumption and inventory: per-principal rate limits with page-size and body-size caps, spend quotas on paid downstreams, and a generated route inventory reconciled against the spec so shadow endpoints surface. Month three is boundary hygiene: an egress allow-list proxy for SSRF, problem-details error handling with no stack traces, and schema validation of third-party responses. I would sequence it that way because the first month covers the highest-frequency, highest-impact classes with permanent structural controls rather than one-off fixes.

**Q: (Senior) How do you detect BOLA exploitation in production rather than preventing it?**
A: Instrument per-principal behavioural metrics: distinct object IDs touched per hour, the ratio of 404/403 to 200, sequential-ID access patterns, and cross-resource breadth. A legitimate user touches a handful of their own objects; an enumerating attacker touches hundreds of unfamiliar ones and collects a distinctive tail of denials. Feed that to an anomaly detector with per-principal baselines, alert on outliers, and make the response automatic — throttle then challenge then suspend — because manual review will always lag the exfiltration.

**Q: (Senior) A partner integration requires fetching arbitrary customer-supplied webhook URLs. Design it safely.**
A: Isolate the fetcher into its own service in a network segment with no route to internal systems or cloud metadata, running under an IAM role with no permissions. Validate the URL (https only, public IP after a single DNS resolution, no private ranges), pin the resolved IP for the connection, disable redirects, cap size and timeout, and require customers to verify domain ownership before registering a destination. Add per-destination rate limits and circuit breakers, sign outbound requests so the receiver can authenticate them, and log every destination for anomaly review — the goal is that a successful SSRF reaches an empty network segment.

**Q: What is the difference between API1 and API5?**
A: API1 (BOLA) is accessing the *wrong object* through a legitimate function — reading another tenant's order via `GET /orders/{id}`. API5 (BFLA) is accessing the *wrong function* — a normal user calling `DELETE /admin/users/{id}` because the route was never guarded. One is a row check, the other a route check, and you need both.

**Q: Why prefer `404` over `403` for objects in another tenant?**
A: Because `403` confirms the object exists, which is itself a disclosure and a free oracle for enumeration. Returning `404` makes "you may not see it" indistinguishable from "it does not exist", and you keep the real reason in the audit log where support and incident response can find it.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** The 2023 list is mostly authorization: **API1 BOLA** (wrong object — the fix is `WHERE id = :id AND tenant_id = :tid`), **API3 BOPLA** (wrong property, both excessive exposure on read and mass assignment on write — the fix is explicit read/write DTO allow-lists), **API5 BFLA** (wrong function — the fix is deny-by-default with a mandatory permission declaration per route), and **API2** broken authentication. Then consumption: **API4** unrestricted resource use, now including money spent on paid downstreams, and **API6** automation abuse of legitimate business flows. Then boundaries and hygiene: **API7 SSRF** (host allow-list, resolve-once-and-pin, no redirects, segmented egress), **API8** misconfiguration, **API9** forgotten hosts and undocumented endpoints, **API10** trusting third-party responses. A WAF stops none of the authorization classes. Unguessable IDs are defence in depth, never the control. The highest-ROI single artifact is an automated cross-tenant probe that replays one tenant's object IDs with another tenant's token across every endpoint in your spec.

| ID | Name (2023) | One-line fix |
|---|---|---|
| API1 | Broken Object Level Authorization | Ownership predicate in every query |
| API2 | Broken Authentication | Strict token validation, rate-limited login, no tokens in URLs |
| API3 | Broken Object Property Level Authorization | Explicit read and write DTO allow-lists |
| API4 | Unrestricted Resource Consumption | Per-principal limits on rate, size, time and spend |
| API5 | Broken Function Level Authorization | Deny by default; every route declares a permission |
| API6 | Unrestricted Access to Sensitive Business Flows | Velocity limits, device signals, fairness queues |
| API7 | Server Side Request Forgery | Host allow-list, pin resolved IP, no redirects, segmented egress |
| API8 | Security Misconfiguration | Hardened defaults, no stack traces, CI config scanning |
| API9 | Improper Inventory Management | Generated inventory reconciled against the spec; retire old hosts |
| API10 | Unsafe Consumption of APIs | Validate, size-cap and time-cap every upstream response |

**Flash cards**

- **Why is BOLA #1?** → The check is per-object and domain-specific, so no framework defaults it and single-account tests never catch it.
- **Excessive data exposure and mass assignment are…** → The same bug (API3/BOPLA) in opposite directions; fixed by explicit read and write allow-lists.
- **Does a WAF stop BOLA?** → No — a BOLA request looks exactly like a legitimate one on the wire.
- **The only reliable SSRF defence?** → Destination allow-list plus resolve-once-and-pin, redirects disabled, and a segmented egress path.
- **Highest-ROI security test for an API?** → An automated cross-tenant probe replaying tenant B's object IDs with tenant A's token, on every endpoint, every commit.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Build a two-tenant fixture and script a cross-tenant probe over every path in your OpenAPI spec; assert `403`/`404` on all of them and wire it into CI as a merge gate.
- [ ] Add `extra="forbid"` to a write model, send `{"role":"admin","balance_cents":0}`, and confirm a `422` naming the rejected fields instead of a silent drop.
- [ ] Write a deliberately naive URL fetcher, exploit it against `http://169.254.169.254/latest/meta-data/` and a DNS-rebinding host, then harden it with resolve-once-and-pin and re-run both attacks.
- [ ] Instrument distinct-object-IDs-per-principal, run an enumeration script against your own staging API, and tune an alert threshold that fires on the attack but not on your busiest legitimate user.
- [ ] Generate a route inventory from your framework's routing table, diff it against the published OpenAPI spec, and fail the build on any undocumented route.

**Mini Project — an API security gauntlet**

*Goal:* build a deliberately vulnerable API, then harden it entry by entry with a test proving each fix.

*Requirements:*
1. A multi-tenant orders API with users, orders, admin operations, an avatar-import endpoint that fetches a user-supplied URL, and an SMS notification endpoint.
2. Seed it with all ten flaws: no ownership predicate, ORM models returned directly, unbounded body binding, no rate limits, unguarded admin routes, unrestricted signup, naive URL fetcher, stack traces on 500, a live `/v1beta` host, and an unvalidated partner API call.
3. Write an exploit script for each flaw, with output showing exactly what data or capability it obtains.
4. Fix each one with a structural control (repository-level tenancy, DTOs, permission declarations, quotas, egress proxy, problem details, inventory diff, schema validation) and add a regression test.
5. Produce a before/after report mapping each fix to its OWASP entry, the exploit that proves it, and the test that keeps it fixed.

*Extensions:* add behavioural detection for enumeration with tuned thresholds; add API6 controls to signup and checkout, then measure the false-positive rate against real traffic; run an automated DAST scan and reconcile its findings against your own; add row-level security in PostgreSQL as a second layer under the application check.

---

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Authorization: RBAC, ABAC & Scopes* (chapter 21) is the deep dive on API1, API3 and API5; *OAuth 2.0 & OpenID Connect* (chapter 19) and *JWT: Structure, Validation & Pitfalls* (chapter 20) cover API2; *TLS, CORS & Security Headers* (chapter 22) covers API8; *Rate Limiting, Quotas & Throttling* (chapter 24) covers API4 and API6.

- **OWASP API Security Top 10 — 2023** — OWASP · *Intermediate* · the primary source: each entry with threat agents, attack scenarios and prevention checklists. <https://owasp.org/API-Security/editions/2023/en/0x11-t10/>
- **OWASP API Security Project** — OWASP · *Beginner* · project home with the 2019 edition, translations, and the methodology behind the ranking. <https://owasp.org/www-project-api-security/>
- **OWASP Server Side Request Forgery Prevention Cheat Sheet** — OWASP · *Advanced* · the definitive SSRF defence guide, including why blocklists and redirect-following fail. <https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html>
- **OWASP Mass Assignment Cheat Sheet** — OWASP · *Intermediate* · framework-by-framework guidance on allow-listing writable fields. <https://cheatsheetseries.owasp.org/cheatsheets/Mass_Assignment_Cheat_Sheet.html>
- **PortSwigger Web Security Academy — API testing & access control** — PortSwigger · *Intermediate* · free labs for IDOR, mass assignment, SSRF and server-side parameter pollution. <https://portswigger.net/web-security/api-testing>
- **crAPI — Completely Ridiculous API** — OWASP · *Intermediate* · an intentionally vulnerable API built around the Top 10; the best hands-on environment for practising exploits and fixes. <https://github.com/OWASP/crAPI>
- **OWASP Application Security Verification Standard (ASVS)** — OWASP · *Advanced* · when the Top 10 is not enough: a leveled, testable requirements standard you can hold a build to. <https://owasp.org/www-project-application-security-verification-standard/>
- **AWS IMDSv2 documentation** — AWS · *Intermediate* · how session-oriented metadata closes the most damaging SSRF payoff in cloud environments. <https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/configuring-instance-metadata-service.html>

---

*REST API Handbook — chapter 23.*
