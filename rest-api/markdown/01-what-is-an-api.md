# 01 · What Is an API? Web APIs & Clients

> **In one line:** An API is a published contract that lets one piece of software use another's capabilities without knowing how it works inside — and the *web* API turned that contract into a network-addressable, language-neutral product that anyone with an HTTP client can consume.

---

## 1. Overview

An **API** — Application Programming Interface — is a boundary with a promise attached. On one side sits a provider that owns some capability: a payments ledger, a map tile renderer, an SMS gateway, a user directory. On the other side sits a consumer that wants that capability but has no interest in owning it. The API is the agreed vocabulary between them: *these are the operations you may invoke, these are the inputs they accept, these are the outputs and errors you will get back, and these are the guarantees I will not break without warning you*. Everything else — the language, the database, the deployment topology, the team that maintains it — is deliberately hidden. That hiding is not incidental; it is the entire point. The contract is what stays stable while the implementation churns underneath.

The problem APIs solve is **coupling at scale**. In a single program, one function calling another is trivially coupled: same process, same memory, same release. The moment you have two teams, two release cadences, or two companies, that coupling becomes a coordination tax that grows quadratically. Before web APIs, integrating two systems meant nightly CSV drops over SFTP, a shared database that both sides wrote to (and both sides broke), or a vendor-specific binary protocol with a client library available for exactly one language. Each of these makes the *implementation* part of the contract. A web API replaces all of it with a uniform, text-inspectable, firewall-friendly interface: send an HTTP request to a URL, get a structured response back.

The lineage is worth knowing because it explains the shape of what we build today. Remote procedure calls date to the 1980s (Sun RPC, CORBA, DCOM) and all tried to make the network invisible — a fiction that Peter Deutsch's *Eight Fallacies of Distributed Computing* demolished. **SOAP** (1998) moved RPC onto HTTP and XML but kept the heavyweight envelope, WSDL contracts, and WS-\* stack. In 2000, Roy Fielding's doctoral dissertation described **REST** as the architectural style the Web itself already embodied, and argued that the Web's own primitives — URIs, HTTP methods, media types, caching, statelessness — were a better foundation than tunnelling RPC through port 80. The industry agreed slowly and then all at once: Salesforce and eBay shipped web APIs in 2000, Amazon in 2002, Flickr and del.icio.us popularised JSON-over-HTTP in 2004–2006, and by 2010 "API" in common usage meant "web API" almost exclusively. The modern normative reference for the underlying protocol is **RFC 9110 (HTTP Semantics, 2022)**, which replaced the older 7230–7235 series.

Make it concrete with **Stripe**. A merchant wants to charge a card. They do not want to become PCI-compliant, negotiate with card networks, implement 3-D Secure, or handle chargebacks. They `POST /v1/payment_intents` with an amount, a currency and a payment method, and get back a JSON object with an `id`, a `status`, and a `client_secret`. Stripe has rewritten its internals many times; the merchant's integration keeps working because the contract — the resource shape, the field names, the status codes, the versioning policy — is treated as the product. Stripe's API *is* Stripe's business. The same is true of **Twilio** (`POST /2010-04-01/Accounts/{sid}/Messages.json` sends an SMS anywhere on Earth), **GitHub** (`GET /repos/{owner}/{repo}/issues` powers every third-party dev tool), and **Google Maps**. So the mental model to carry forward is: **an API is a product with users, not a side effect of your codebase.** Its users are developers; its UX is documentation, error messages, consistency and predictability; its breaking changes are outages for someone else. Every chapter that follows is really about one question — how do you design and operate that contract so it survives contact with real clients, real load, and real time?

## 2. Core Concepts

- **API (Application Programming Interface)** — a defined set of operations, inputs, outputs and guarantees that lets one program use another without knowledge of its internals.
- **Contract** — the stable, documented surface: URLs, methods, schemas, status codes, error formats, auth requirements and compatibility promises. Everything not in the contract is free to change.
- **Client (consumer)** — the party that initiates a request: a browser SPA, a mobile app, a backend service, a CLI, a webhook receiver, an LLM agent. **Server (provider)** — the party that owns the resource, applies authorization and business rules, and returns a response.
- **Endpoint** — a specific `(method, URI)` pair that the server will act on, e.g. `GET /v1/customers/{id}`. Not the same as a *resource*: one resource typically has several endpoints.
- **Payload / Representation** — the bytes carrying the state of a resource in some **media type** (`application/json`, `image/png`). A resource is abstract; a representation is one concrete rendering of it.
- **Interface vs implementation** — the interface is what callers depend on; the implementation is what you are free to replace. Leaking implementation (DB column names, internal enum values, stack traces) turns private detail into public contract.
- **Public / Partner / Private API** — audience tiers. Public APIs are open to any developer (Stripe, GitHub); partner APIs are contractually gated; private APIs live inside one organisation. The tier determines how expensive a breaking change is.
- **SDK (client library)** — a generated or hand-written wrapper over the wire API in a specific language. A convenience layer, never a substitute for a well-designed HTTP contract.
- **Idempotency** — the property that repeating a request produces the same server state as sending it once. Central to safe retries over an unreliable network (Chapter 06).
- **Statelessness** — each request carries everything the server needs; the server keeps no client session between calls. This is what makes horizontal scaling and load balancing trivial.

## 3. Theory & Principles

### The API as an information-hiding boundary

David Parnas's 1972 paper *On the Criteria To Be Used in Decomposing Systems into Modules* is the intellectual ancestor of every API design guideline you will read. Parnas's rule: **decompose around what is likely to change, and hide those decisions behind an interface.** A module's interface should reveal *what* it does and conceal *how*. Applied to web APIs: expose `GET /orders/{id}` returning `{"id": "...", "status": "shipped"}`; do not expose `GET /order_table_v3?fk_status_id=4`. The first survives a database migration; the second is the database migration.

### Why the network changes everything

An in-process function call is fast, reliable, and returns exactly one of "value" or "exception". A network call is none of those. Deutsch and Gosling's **Eight Fallacies of Distributed Computing** enumerate the wrong assumptions: the network is reliable, latency is zero, bandwidth is infinite, the network is secure, topology doesn't change, there is one administrator, transport cost is zero, the network is homogeneous. Every one of them is false, and API design is largely the discipline of designing for their falseness:

| Fallacy | What it forces into your API design |
|---|---|
| The network is reliable | Idempotency keys, retries with backoff, `409`/`412` conflict semantics |
| Latency is zero | Batch endpoints, pagination, caching, avoiding chatty N+1 patterns |
| Bandwidth is infinite | Sparse fieldsets, compression, `304 Not Modified` |
| The network is secure | TLS everywhere, `Authorization` headers, object-level authz on every call |
| Topology doesn't change | Statelessness, no server affinity, DNS-based discovery |

The single most important consequence is the **partial-failure problem**: a client that gets no response cannot distinguish "the request never arrived" from "it was processed but the response was lost". That ambiguity is why HTTP method semantics (safe, idempotent) are not academic trivia — they are the only thing that tells a client whether retrying is safe.

### The uniform interface

What makes a *web* API different from an arbitrary RPC endpoint is that HTTP supplies a **uniform interface** understood by every intermediary on the path. A proxy, CDN, browser cache, or load balancer knows that `GET` is safe and cacheable, that `4xx` is the client's fault and `5xx` is the server's, that `Cache-Control: max-age=300` means something specific. None of them needs to know what your resources mean. That shared vocabulary is why a single `Cache-Control` header can offload 90% of your read traffic to a CDN you did not write.

```svg
<svg viewBox="0 0 800 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="a2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="400" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">The API contract as an information-hiding boundary</text>

  <rect x="20" y="60" width="180" height="230" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <rect x="300" y="60" width="200" height="230" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="3"/>
  <rect x="600" y="60" width="180" height="230" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <g text-anchor="middle" fill="#1e293b" font-size="13" font-weight="bold">
    <text x="110" y="84">Clients</text><text x="400" y="84">The Contract</text><text x="690" y="84">Implementation</text>
  </g>
  <g text-anchor="middle" fill="#1e293b">
    <text x="110" y="118">Browser SPA</text><text x="110" y="148">iOS / Android app</text>
    <text x="110" y="178">Partner backend</text><text x="110" y="208">CLI / cron job</text>
    <text x="110" y="238">Agent / LLM tool</text>
  </g>
  <g fill="#1e293b">
    <text x="316" y="110">GET /v1/orders/{id}</text><text x="316" y="132">JSON schema of Order</text>
    <text x="316" y="154">200 / 201 / 404 / 409</text><text x="316" y="176">Authorization: Bearer</text>
    <text x="316" y="198">Cache-Control, ETag</text><text x="316" y="220">Versioning &amp; deprecation</text>
    <text x="316" y="242">Rate-limit headers</text>
    <text x="616" y="118">Go / Java / Python</text><text x="616" y="148">Postgres + Redis</text>
    <text x="616" y="178">Kafka event bus</text><text x="616" y="208">12 microservices, k8s</text>
    <text x="616" y="238">Team org chart</text>
  </g>
  <text x="316" y="274" fill="#b45309" font-size="11" font-weight="bold">public &#8212; may not break</text>
  <text x="616" y="272" fill="#15803d" font-size="11" font-weight="bold">private &#8212; free to change</text>

  <line x1="204" y1="175" x2="294" y2="175" stroke="#4f46e5" stroke-width="2" marker-end="url(#a1)"/>
  <text x="249" y="166" text-anchor="middle" fill="#4f46e5" font-size="11">HTTP</text>
  <line x1="504" y1="175" x2="594" y2="175" stroke="#16a34a" stroke-width="2" marker-end="url(#a2)"/>
  <text x="549" y="166" text-anchor="middle" fill="#16a34a" font-size="11">bind</text>
  <text x="400" y="318" text-anchor="middle" fill="#1e293b" font-size="12">Clients depend only on the middle box. Anything they can observe becomes contract.</text>
</svg>
```

### Hyrum's Law and the observable-behaviour trap

> **Note:** *With a sufficient number of users of an API, it does not matter what you promise in the contract: all observable behaviours of your system will be depended on by somebody.* — Hyrum Wright

Clients will depend on your JSON key ordering, on the fact that IDs happen to be sequential integers, on an error message string, on the ordering of an unsorted list, on the exact latency of an endpoint. The defence is not to be clever — it is to make undocumented behaviour *visibly* unstable (randomise unordered results, use opaque IDs, never expose stack traces) and to publish what *is* guaranteed.

## 4. Architecture & Workflow

A single API call from a mobile app to a payments provider, end to end:

1. **Client constructs the request.** The SDK builds `POST https://api.example.com/v1/orders`, attaches `Authorization: Bearer <token>`, `Content-Type: application/json`, `Idempotency-Key: 5f2c…`, and serialises the body.
2. **DNS + TLS + edge.** `api.example.com` resolves (often to an anycast edge IP) and a TLS 1.3 handshake completes in one round trip, or zero with session resumption. The PoP terminates TLS, applies WAF rules and coarse DDoS protection; for a `GET` with a cache hit it could answer here and never touch your infrastructure, but `POST` is neither safe nor cacheable so it passes through.
4. **API gateway.** Authenticates the bearer token (JWT signature check or introspection), enforces the caller's rate limit, injects a `traceparent` / `X-Request-Id`, strips hop-by-hop headers, and routes by path prefix. Cost: one extra hop and one more failure domain — an honest trade-off, not a free win.
5. **Service.** Validates the payload against a schema, performs **object-level authorization** (does *this* token's subject own *this* customer?), checks the idempotency key against a store, executes business logic.
6. **Data layer.** Writes to the primary database inside a transaction; publishes an `order.created` event to the bus for downstream consumers (email, analytics, fulfilment).
7. **Response.** The service returns `201 Created` with a `Location: /v1/orders/ord_9F2` header and the created representation. The gateway adds `RateLimit-Remaining`, the CDN adds timing headers.
8. **Client handles the outcome.** On `2xx` it proceeds. On `429` or `5xx` it retries with exponential backoff **and the same idempotency key**, so a duplicate delivery cannot create a second order. On any other `4xx` it does not retry — the request itself is wrong. Minutes later the provider `POST`s a signed **webhook** announcing `payment.succeeded`; the merchant verifies the HMAC, returns `200` fast, and processes asynchronously.

```svg
<svg viewBox="0 0 820 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="b1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="b2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="b3" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Life of one API request (and its webhook)</text>

  <g stroke-width="2">
    <rect x="15" y="70" width="118" height="66" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
    <rect x="178" y="70" width="118" height="66" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
    <rect x="341" y="70" width="118" height="66" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
    <rect x="504" y="70" width="118" height="66" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="667" y="70" width="118" height="66" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  </g>
  <g text-anchor="middle" fill="#1e293b" font-weight="bold">
    <text x="74" y="96">Client</text><text x="237" y="96">Edge / CDN</text>
    <text x="400" y="96">Gateway</text><text x="563" y="96">Service</text>
    <text x="726" y="96">Store</text>
  </g>
  <g text-anchor="middle" fill="#1e293b" font-size="11">
    <text x="74" y="114">mobile app</text><text x="237" y="114">TLS, WAF, cache</text>
    <text x="400" y="114">authn, quota, trace</text><text x="563" y="114">authz, logic</text>
    <text x="726" y="114">db + event bus</text>
  </g>

  <g stroke="#4f46e5" stroke-width="2" marker-end="url(#b1)">
    <line x1="135" y1="94" x2="174" y2="94"/><line x1="298" y1="94" x2="337" y2="94"/>
    <line x1="461" y1="94" x2="500" y2="94"/><line x1="624" y1="94" x2="663" y2="94"/>
  </g>
  <g stroke="#16a34a" stroke-width="2" marker-end="url(#b2)">
    <line x1="663" y1="126" x2="624" y2="126"/><line x1="500" y1="126" x2="461" y2="126"/>
    <line x1="337" y1="126" x2="298" y2="126"/><line x1="174" y1="126" x2="135" y2="126"/>
  </g>

  <rect x="40" y="170" width="740" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <rect x="40" y="246" width="740" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <g fill="#1e293b" font-size="12">
    <text x="56" y="192" font-weight="bold">Request line + headers travelling right</text>
    <text x="56" y="214">POST /v1/orders HTTP/2 | Authorization: Bearer eyJ... | Idempotency-Key: 5f2c | Content-Type: application/json</text>
    <text x="56" y="268" font-weight="bold">Response travelling left</text>
    <text x="56" y="290">201 Created | Location: /v1/orders/ord_9F2 | RateLimit-Remaining: 4998 | ETag: "v1-8ac3"</text>
  </g>
  <rect x="504" y="330" width="118" height="52" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="563" y="360" text-anchor="middle" fill="#1e293b" font-size="11">webhook sender (HMAC)</text>
  <line x1="500" y1="356" x2="140" y2="356" stroke="#d97706" stroke-width="2" marker-end="url(#b3)"/>
  <text x="320" y="348" text-anchor="middle" fill="#b45309" font-size="11">POST /hooks &#8212; payment.succeeded (async, at-least-once)</text>
</svg>
```

> **Note:** Steps 3 and 4 are optional in a small system. Do not add a gateway until you have a reason — it buys centralised authn, quotas and observability at the price of a hop, a deploy dependency, and a new place for outages to originate.

## 5. Implementation

### The raw exchange

Everything else is sugar over this. A create-order call:

```http
POST /v1/orders HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjIwMjYtMDEifQ...
Content-Type: application/json
Idempotency-Key: 5f2c9a11-7b0e-4c2f-9a51-0d3f1b2e77aa
Accept: application/json

{ "customer_id": "cus_4Kd82", "currency": "inr",
  "items": [{ "sku": "TSHIRT-BLK-M", "quantity": 2, "unit_amount": 79900 }] }

HTTP/1.1 201 Created
Content-Type: application/json
Location: /v1/orders/ord_9F2xQ
ETag: "v1-8ac3f0"
RateLimit-Limit: 5000
RateLimit-Remaining: 4998
RateLimit-Reset: 41
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01

{
  "id": "ord_9F2xQ", "object": "order", "status": "pending_payment",
  "currency": "inr", "amount_total": 159800, "customer_id": "cus_4Kd82",
  "created_at": "2026-07-22T09:14:03Z"
}
```

And the failure case, using **RFC 9457 Problem Details** rather than an ad-hoc error blob:

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{
  "type": "https://api.example.com/problems/insufficient-stock",
  "title": "Insufficient stock",
  "status": 422,
  "detail": "SKU TSHIRT-BLK-M has 1 unit available; 2 requested.",
  "instance": "/v1/orders", "sku": "TSHIRT-BLK-M", "available": 1
}
```

The same call with `curl` — note `-D -`, which prints the response headers you need as much as the body:

```bash
curl -sS -X POST https://api.example.com/v1/orders -D - \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"customer_id":"cus_4Kd82","currency":"inr",
       "items":[{"sku":"TSHIRT-BLK-M","quantity":2,"unit_amount":79900}]}'
```

### A minimal provider (FastAPI)

```python
from fastapi import FastAPI, Header, HTTPException, Response, status
from pydantic import BaseModel, Field
from typing import Annotated
import uuid

app = FastAPI(title="Orders API", version="1.0.0")

class Item(BaseModel):
    sku: str
    quantity: int = Field(gt=0, le=100)
    unit_amount: int = Field(ge=0)          # minor units, integer — never float money

class OrderCreate(BaseModel):
    customer_id: str
    currency: str = Field(pattern="^[a-z]{3}$")
    items: list[Item] = Field(min_length=1, max_length=50)   # bound every collection

ORDERS, IDEMPOTENCY = {}, {}                # idem key -> order id; use Redis for real

@app.post("/v1/orders", status_code=status.HTTP_201_CREATED)
def create_order(body: OrderCreate, response: Response,
                 idem: Annotated[str | None, Header(alias="Idempotency-Key")] = None):
    if idem and idem in IDEMPOTENCY:                   # replay, not a new creation
        response.status_code = status.HTTP_200_OK
        return ORDERS[IDEMPOTENCY[idem]]
    oid = f"ord_{uuid.uuid4().hex[:10]}"               # opaque id, not a DB sequence
    ORDERS[oid] = {"id": oid, "object": "order", "status": "pending_payment",
                   "currency": body.currency, "customer_id": body.customer_id,
                   "amount_total": sum(i.quantity * i.unit_amount for i in body.items)}
    if idem:
        IDEMPOTENCY[idem] = oid
    response.headers["Location"] = f"/v1/orders/{oid}"  # 201 MUST carry Location
    return ORDERS[oid]

@app.get("/v1/orders/{order_id}")
def get_order(order_id: str):
    if order_id not in ORDERS:
        raise HTTPException(status_code=404, detail="No such order")
    return ORDERS[order_id]
```

### A resilient consumer (Node)

```javascript
async function createOrder(payload, { retries = 4 } = {}) {
  const key = crypto.randomUUID();            // generated ONCE, reused on every retry
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch("https://api.example.com/v1/orders", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.TOKEN}`,
                 "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),    // always bound the wait
    });
    if (res.ok) return res.json();

    if (!(res.status === 429 || res.status >= 500)) {   // 4xx: the request is wrong
      const problem = await res.json().catch(() => ({}));
      throw new Error(`${res.status} ${problem.title ?? res.statusText}`);
    }
    const after = Number(res.headers.get("Retry-After"));
    const backoff = Number.isFinite(after) ? after * 1000
                  : (2 ** attempt) * 250 + Math.random() * 250;  // backoff + jitter
    await new Promise(r => setTimeout(r, backoff));
  }
  throw new Error("exhausted retries");
}
```

### Describing the contract (OpenAPI 3.1)

The contract should exist as a machine-readable document, not only as prose — it drives docs, mock servers, SDK generation and CI compatibility checks:

```yaml
openapi: 3.1.0
info: { title: Orders API, version: "1.0.0" }
paths:
  /v1/orders:
    post:
      operationId: createOrder
      parameters:
        - { name: Idempotency-Key, in: header, schema: { type: string, format: uuid } }
      requestBody:
        required: true
        content: { application/json: { schema: { $ref: '#/components/schemas/OrderCreate' } } }
      responses:
        "201":
          description: Order created
          headers: { Location: { schema: { type: string } } }
          content: { application/json: { schema: { $ref: '#/components/schemas/Order' } } }
        "422":
          content: { application/problem+json: { schema: { $ref: '#/components/schemas/Problem' } } }
          description: Business rule violated
```

> **Optimization note.** The cheapest API call is the one that never leaves the client. Emit `Cache-Control` and `ETag` on every `GET`, so repeat reads become conditional requests that return an empty `304 Not Modified` (a few hundred bytes instead of a few kilobytes, and no database query). For a read-heavy public API, correct caching headers routinely remove 70–95% of origin traffic — a larger win than any code optimisation you will make this quarter. Second-cheapest: HTTP/2 or HTTP/3 connection reuse, which eliminates per-call TLS handshakes; a client that opens a fresh connection per request pays 1–2 extra RTTs every time.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| **Decoupling** | Provider and consumer ship independently; internals can be rewritten freely | The contract itself becomes rigid — breaking it is someone else's outage |
| **Language neutrality** | Any language with an HTTP client can integrate; no shared runtime | You lose compile-time type safety across the boundary; schemas + contract tests must replace it |
| **Reuse & network effects** | One capability serves many consumers; ecosystems form around good APIs (Stripe, Twilio) | Every consumer is a constraint on future change; usage you did not design for becomes usage you must support |
| **Observability** | Text-based HTTP is inspectable with curl, devtools and proxies; a natural instrumentation point | Verbose on the wire versus binary protocols; more bytes, more parsing |
| **Statelessness + uniform semantics** | Trivial horizontal scaling; CDNs, proxies and browsers cache and route for free | Each request re-sends auth and context; some operations map awkwardly onto CRUD verbs |
| **Security boundary** | One place to enforce authn, authz, quotas, audit | One more attack surface; OWASP API Top 10 risks (BOLA, BFLA, mass assignment) are all boundary bugs |
| **Latency** | Work runs on capable server hardware near the data | Every call pays network RTT; chatty designs multiply it — an API that needs 12 calls to render a screen is a design bug |
| **Versioning** | Explicit versions let old and new clients coexist | Every live version is code you maintain, test and secure |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Returning `200 OK` with `{"success": false}` in the body.** Intermediaries, dashboards and generated clients all read the status line, not your body — the error becomes invisible. ✅ Use the real status: `400` malformed, `401` unauthenticated, `403` unauthorized, `404` missing, `409` conflict, `422` valid-but-rejected, `5xx` your fault.
2. ⚠️ **Putting verbs in URIs** (`/getUser`, `/createOrder`, `/deleteAccountNow`). You end up re-implementing HTTP badly and lose caching and idempotency semantics. ✅ Nouns for resources, HTTP methods for operations: `GET /users/{id}`, `POST /orders`.
3. ⚠️ **Exposing internal identifiers and internals.** Sequential integer IDs leak volume and enable enumeration; stack traces leak framework versions and file paths; auto-generating endpoints from your ORM makes the database schema your permanent public contract. ✅ Opaque prefixed IDs (`cus_4Kd82`), generic 5xx bodies with details only in correlated logs, and an explicit mapping between storage model and wire representation.
4. ⚠️ **Skipping object-level authorization.** Authenticating the token but not checking that *this* subject may access *this* object is **BOLA** — the #1 item in the OWASP API Security Top 10. ✅ Every handler that takes an id must verify ownership/tenancy server-side, never trust a client-supplied tenant id.
5. ⚠️ **Unbounded list endpoints, and chatty designs that force N+1 client calls.** `GET /orders` returning everything works in dev and takes the database down in production; fetching a list then one call per row multiplies latency by page size. ✅ Enforce a default and maximum page size server-side, return pagination metadata from day one, and offer expansion (`?expand=customer`) or batch endpoints.
6. ⚠️ **Trusting the client for anything that matters.** Prices, roles, tenant ids and status transitions sent from the client are advisory at best. ✅ Recompute server-side; use explicit allow-lists for writable fields to prevent **mass assignment**.
7. ⚠️ **Breaking changes without a version or notice** — renaming a field, tightening validation, changing a default. ✅ Additive-only within a version; new required fields, removed fields and changed types need a new version plus a `Deprecation`/`Sunset` (RFC 8594) header and a migration window.
8. ⚠️ **No timeouts and infinite retries on the client.** One slow dependency turns into a thread-pool exhaustion cascade and a self-inflicted DDoS. ✅ Bound every call with a timeout, retry only safe/idempotent operations, use exponential backoff with jitter and a circuit breaker.
9. ⚠️ **Ad-hoc error shapes per endpoint.** Consumers cannot write one error handler. ✅ One machine-readable envelope everywhere — `application/problem+json` (RFC 9457) with a stable `type` URI and a machine-usable code.
10. ⚠️ **Documentation drift** — hand-written docs that no longer match the code. ✅ Generate the OpenAPI document from the implementation (or the implementation from it), publish it, and assert it in CI so a spec change is a reviewable diff.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

Reproduce with `curl -v` (or `-D -`) before you read any code — the raw exchange tells you whether the problem is auth, routing, negotiation or logic. Propagate **W3C Trace Context** (`traceparent`) end to end and return a `X-Request-Id` on every response, including errors, so a user can paste one string into a support ticket and you can pull the full trace. Log the *structured* fields (route template, not the interpolated path; status; latency; caller id; tenant) — never log full request bodies containing PII or tokens. For "works in Postman, fails in the browser" cases, look at CORS preflight (`OPTIONS`) before anything else.

### Monitoring

Track the four golden signals per **route template** (`/v1/orders/{id}`, never `/v1/orders/ord_9F2`, which would explode label cardinality):

- **Traffic** — requests/sec by route, method, status class, API version and client id.
- **Errors** — `5xx` rate (your fault) and `4xx` rate (often *your* fault too: a spike in `400` after a deploy is a contract regression; a spike in `401` is a broken token refresh).
- **Latency** — p50/p95/p99 histograms, never averages. Alert on p99 and on error-budget burn, not on raw CPU. **Saturation** — connection pool usage, queue depth, upstream dependency latency.
- **API-specific** — `RateLimit-Remaining` distribution, CDN cache hit ratio, per-version traffic share (can you retire `v1` yet?), deprecated-endpoint usage by client.

### Security

TLS 1.2+ everywhere with HSTS; no plaintext fallback. Authenticate with short-lived bearer tokens — **OAuth 2.1 authorization code + PKCE** for public clients (never implicit, never password grant), client credentials for machine-to-machine. Authorize on every request at the object level. Validate and bound every input (max body size, max array length, max page size, strict types) and reject unknown fields rather than silently ignoring them. Set `Content-Type: application/json` and never reflect user input into HTML. Rate-limit per credential *and* per IP, with `429` + `Retry-After`. Sign webhooks with an HMAC over the raw body plus a timestamp, and reject stale timestamps to stop replay. Walk the **OWASP API Security Top 10** as a checklist before any public launch.

### Performance & scaling

Because the service is stateless, scaling out is a matter of adding replicas behind a load balancer — so keep it stateless (no in-memory sessions, no sticky routing). Push read traffic to the edge with `Cache-Control` + `ETag`. Use connection pooling to your database and HTTP keep-alive to upstreams. Prefer cursor pagination over `OFFSET` for large collections (offset scanning degrades linearly). Compress responses (`gzip`/`br`). Move slow work out of the request path: return `202 Accepted` with a status URL, and notify via webhook when it finishes. Apply bulkheads and circuit breakers so one degraded dependency cannot consume all your request threads.

## 9. Interview Questions

**Q: What is an API, in one sentence, and what does it hide?**
A: An API is a documented contract that lets one program invoke another's capabilities through a defined set of operations, inputs and outputs. It hides the implementation — language, data model, deployment, algorithms — so the provider can change all of that without breaking consumers. The corollary is that anything a consumer can observe tends to become contract whether you intended it or not.

**Q: How is a web API different from a library API?**
A: A library API is a same-process function call: fast, reliable, versioned by dependency resolution, and language-bound. A web API crosses a network, so it must handle partial failure, latency, authentication, authorization, rate limiting and versioning at runtime, but in exchange it is language-neutral and independently deployable. The network is the whole difference, and it is the reason for idempotency keys, timeouts and retries.

**Q: What does "the client" mean in a web API context?**
A: Anything that initiates an HTTP request — a browser SPA, a mobile app, a server-side backend, a CLI, a partner's system, a webhook receiver, or an LLM agent calling a tool. It matters because client type determines the auth flow (PKCE for public clients that cannot hold a secret, client credentials for confidential backends) and the shape of the API (a mobile client wants fewer, richer calls; a batch job wants pagination and bulk).

**Q: Why is statelessness such a big deal?**
A: If the server keeps no per-client session between requests, any replica can serve any request, so load balancing is trivial, deploys can roll without draining sessions, and horizontal scale is nearly linear. The cost is that every request re-sends its credentials and context, which is more bytes and more per-request verification work. That is almost always the right trade.

**Q: What's the difference between a resource and an endpoint?**
A: A resource is the conceptual thing your API exposes — an order, a customer, a shipment. An endpoint is a concrete `(method, URI)` pair that operates on it. One resource typically has several endpoints (`GET /orders`, `POST /orders`, `GET /orders/{id}`, `PATCH /orders/{id}`), and one endpoint may return a representation of a resource in several media types.

**Q: Give an example of leaking implementation through an API and why it hurts.**
A: Exposing auto-increment database IDs leaks your row counts, enables enumeration attacks and pins you to that storage engine; exposing DB column names (`usr_stat_cd`) means a schema refactor becomes a breaking API change. Use opaque prefixed identifiers and map explicitly between the storage model and the wire representation.

**Q: A client calls `POST /orders`, the connection drops, and it never sees a response. What should it do?**
A: It cannot know whether the order was created, so it must retry with the *same* `Idempotency-Key` it used originally. The server records the key with the result of the first successful execution and replays that result instead of creating a second order. Without an idempotency mechanism the only safe options are "never retry" (lose orders) or "retry and reconcile later" (duplicate charges).

**Q: Why do we still use HTTP and JSON rather than a binary RPC protocol for public APIs?**
A: Ubiquity and inspectability: every language, every firewall, every proxy and every developer already understands HTTP + JSON, and the uniform interface lets CDNs and caches participate for free. Binary protocols like gRPC are faster and strongly typed, which makes them excellent *inside* a system, but they are far harder to expose to arbitrary third parties over the public internet.

**Q: (Senior) How do you decide what belongs in the contract versus what stays private?**
A: Apply Parnas's criterion — hide the decisions most likely to change (storage, algorithms, service decomposition, team boundaries) and expose the stable domain concepts consumers actually reason about. Then apply Hyrum's Law defensively: anything observable will be depended on, so make undocumented behaviour visibly non-deterministic (randomise unordered collections, use opaque ids, rotate error message wording), publish an explicit compatibility policy, and enforce it with contract tests in CI.

**Q: (Senior) You inherit an internal API with 40 consumers and no versioning. How do you introduce breaking changes?**
A: First get visibility: log caller identity and per-field usage so you know who depends on what, then freeze the current behaviour with contract tests. Introduce the new shape additively and side by side (new fields, a new representation, or `/v2`), dual-write and dual-read behind a flag, and publish `Deprecation` and `Sunset` (RFC 8594) headers plus documentation. Migrate consumers by name with a dated plan, watch per-version traffic drop to zero, and only then delete — the sequence is *measure, add, migrate, deprecate, remove*, never *rename*.

**Q: (Senior) When is a web API the wrong abstraction?**
A: When the interaction is chatty and latency-critical inside one trust boundary (prefer in-process calls or gRPC), when the data flow is high-volume streaming or event-driven (prefer Kafka or a message bus), when the natural interaction is bidirectional and long-lived (prefer WebSockets or SSE), or when you are exposing a bulk analytical dataset (prefer a file export or a data-share). Wrapping any of these in request/response HTTP produces a technically working, operationally miserable system.

**Q: (Senior) What does "the API is the product" change about how you run the team?**
A: It makes the contract a release artefact with its own review, testing, documentation, deprecation policy and SLO — not a byproduct of a service deploy. Practically: design reviews before implementation, an OpenAPI document asserted in CI, generated docs and SDKs, per-consumer usage analytics, published rate limits and error taxonomy, and an on-call rotation that treats a contract regression as a Sev-2 even when every dashboard is green.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** An API is a contract that hides implementation behind a stable interface. A *web* API expresses that contract over HTTP: a client sends a request (method + URI + headers + optional body) to a server, which returns a status code, headers and a representation. The contract covers URLs, schemas, status codes, error format, auth and compatibility; everything else stays private. HTTP's uniform interface is what lets CDNs, proxies and browsers participate without understanding your domain. Because the network is unreliable, design assumes partial failure: bound every call with a timeout, retry only what is safe or idempotent, and use idempotency keys for creates. Statelessness makes scaling out trivial. The main hazards are contract leakage (Hyrum's Law), missing object-level authorization (BOLA), unbounded lists, and breaking changes without a version. Treat the API as a product: documented, versioned, measured, and deprecated on a schedule.

| Item | Value |
|---|---|
| Core specs | HTTP semantics **RFC 9110** (obsoletes 7230–7235); caching **RFC 9111** |
| Error format | **RFC 9457** `application/problem+json` |
| Deprecation signalling | `Deprecation` header + **RFC 8594** `Sunset` |
| Success codes | `201` + `Location` on create · `202` async · `204` empty |
| Unauthenticated vs unauthorized | `401` vs `403` |
| Malformed vs semantically invalid | `400` vs `422` |
| Throttled | `429` + `Retry-After` |
| Safe methods | `GET`, `HEAD`, `OPTIONS`, `TRACE` |
| Retry rule | Retry `429` and `5xx`; never retry non-idempotent writes without an idempotency key |
| Trace header | `traceparent` (W3C Trace Context) |

**Flash cards**
- **What is an API in one line?** → A published contract that lets one program use another's capabilities without knowing its internals.
- **Resource vs endpoint** → A resource is the concept (an order); an endpoint is a concrete `(method, URI)` that acts on it.
- **Hyrum's Law** → With enough users, every observable behaviour becomes contract, documented or not.
- **Why statelessness?** → No per-client server state ⇒ any replica serves any request ⇒ linear horizontal scale and painless deploys.
- **Client got no response to a POST — now what?** → Retry with the same `Idempotency-Key`; the server replays the original result instead of creating a duplicate.

## 11. Hands-On Exercises & Mini Project

- [ ] Call three real public APIs with `curl -D -` (GitHub `GET /repos/torvalds/linux`, `https://httpbin.org/anything`, and a public status API). Record for each: status code, `Content-Type`, whether `ETag`/`Cache-Control` are present, and any rate-limit headers.
- [ ] Re-issue the GitHub request with `If-None-Match: "<etag from step 1>"` and confirm you get `304 Not Modified` with an empty body. Measure the byte difference.
- [ ] Take an existing internal service you know and write down its contract on one page: resources, endpoints, request/response schemas, error codes, auth. Circle every item that leaks an implementation detail.
- [ ] Build the FastAPI `Orders` service from §5, hit it with the Node client while randomly failing 30% of requests with `503`, and verify no duplicate orders are created. Then break the contract deliberately — rename `amount_total` to `total` — watch the client fail, and implement the additive fix instead.

### Mini Project — "Bookshelf API v1"

**Goal.** Design and ship a small but genuinely well-behaved web API, then prove it behaves under failure.

**Requirements.**
1. Resources: `books`, `authors`, and `authors/{id}/books`. Endpoints: list, create, read, partial update, delete. Opaque prefixed IDs (`bk_`, `au_`).
2. Correct status codes throughout: `201` + `Location` on create, `204` on delete, `404` for missing, `422` for business-rule violations, `409` for duplicate ISBN.
3. All errors as `application/problem+json` with a stable `type` URI. `ETag` on every single-resource `GET`; support `If-None-Match` (`304`) and `If-Match` on update (`412` on mismatch, `428` if absent).
4. Bearer-token auth with per-token rate limiting: `429` + `Retry-After` + `RateLimit-*` headers.
5. Publish an OpenAPI 3.1 document and assert in CI that it matches the running server.

**Extensions.**
- Add `Idempotency-Key` support to `POST /books` backed by Redis with a 24-hour TTL, and a test that fires 50 concurrent identical requests and asserts exactly one book exists.
- Add cursor pagination to `GET /books` and compare p99 latency against an offset implementation at 1,000,000 rows.
- Emit a signed webhook on `book.created` (HMAC-SHA256 over the raw body plus a timestamp) and write a receiver that rejects replays older than five minutes. Instrument everything with OpenTelemetry and dashboard RPS, error rate and p99 by route template.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *HTTP Fundamentals for API Builders* (the protocol this chapter assumes), *What Is REST? Constraints & Maturity* (the architectural style that gives web APIs their shape), *REST vs GraphQL, gRPC & SOAP* (when a different style is the right answer), *Resource Modeling & URI Design* (turning a domain into resources), *HTTP Methods, Safety & Idempotency* (why retries are safe or not).

- **MDN Web Docs — HTTP** — Mozilla · *Beginner* · the clearest practical reference on the web anywhere: methods, headers, status codes, CORS, caching, all with runnable examples. <https://developer.mozilla.org/en-US/docs/Web/HTTP>
- **RFC 9110 — HTTP Semantics** — IETF, 2022 · *Intermediate* · the normative definition of methods, status codes, headers and conditional requests; read §9 (methods) and §15 (status codes) even if you skim the rest. <https://www.rfc-editor.org/rfc/rfc9110.html>
- **Architectural Styles and the Design of Network-based Software Architectures** — Roy T. Fielding, 2000 · *Advanced* · the dissertation that named REST; Chapter 5 is the source of every constraint you will argue about. <https://ics.uci.edu/~fielding/pubs/dissertation/top.htm>
- **Google API Design Guide** — Google · *Intermediate* · a battle-tested, opinionated style guide from a company running thousands of APIs; excellent on resource naming and standard methods. <https://cloud.google.com/apis/design>
- **Microsoft REST API Guidelines** — Microsoft · *Intermediate* · complements Google's guide with strong material on versioning, errors, long-running operations and pagination. <https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md>
- **OWASP API Security Top 10** — OWASP · *Intermediate* · the ten ways real APIs get breached, starting with broken object-level authorization; treat it as a pre-launch checklist. <https://owasp.org/API-Security/editions/2023/en/0x11-t10/>
- **Stripe API Reference** — Stripe · *Beginner* · the canonical example of an API-as-product: consistent resources, opaque ids, idempotency keys, versioning and error taxonomy done right. <https://docs.stripe.com/api>
- **GitHub REST API Documentation** — GitHub · *Beginner* · a large, public, well-versioned API you can call today with `curl`; great for studying pagination, conditional requests and rate limiting in the wild. <https://docs.github.com/en/rest>

---

*REST API Handbook — chapter 01.*
