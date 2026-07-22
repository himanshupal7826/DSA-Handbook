# 31 · API Versioning Strategies

> **In one line:** Versioning is how you buy the freedom to change an API without breaking the clients you already shipped — and the cheapest version is the one you never had to cut.

---

## 1. Overview

An API is a **published promise**. The moment a third party writes `GET /v1/invoices` into their production code, you have a contract you cannot unilaterally rewrite. Versioning is the set of techniques that lets you evolve that promise: introduce new shapes, retire bad decisions, and fix modelling mistakes, while every already-deployed client keeps working exactly as it did the day it was written.

The problem it solves is **temporal coupling between deploy cycles**. In a monolith you change a function signature and the compiler tells every caller. Across an HTTP boundary there is no compiler, no build, and often no way to contact the caller — a mobile app pinned to your API may sit on a user's phone for three years. Versioning replaces "everyone upgrades at once" with "old and new coexist," and it converts an impossible coordination problem into an operational one: run N contracts concurrently, then sunset them on a published schedule.

Historically, versioning grew out of two competing instincts. The REST purists — Fielding, and the HTTP working group behind what is now **RFC 9110** — argued that a URI identifies a *resource*, not a representation format, so version information belongs in **content negotiation**. The pragmatists observed that URI versions are visible, trivially cacheable, greppable in logs, and require zero client sophistication. The pragmatists won the market: `/v1/` is what virtually every public API ships, even ones whose authors know better.

**Concrete example.** Stripe versions by **date**: every account is pinned to a version like `2024-06-20`, overridable per call with `Stripe-Version:`. Internally Stripe keeps a chain of small *request/response transformers* — each named after the version that introduced it — and replays a modern response backwards through every transformer between your pinned version and today. Stripe has therefore never cut a "v2" of its core API, runs hundreds of live versions, and has almost never broken a customer. GitHub took the opposite route: `/v3` in the URI plus a media type (`application/vnd.github+json`) for finer opt-ins. Twilio versions by date in the path (`/2010-04-01/Accounts/...`) — a version so stable it became a brand.

The durable mental model: **a version is a bundle of breaking changes released together.** Everything else — where you put the version string, how you route it, how long you keep it — is mechanism. If you can make a change *additively*, you should, because that change costs you nothing; a version is what you pay when you cannot.

## 2. Core Concepts

- **Breaking change** — any change that could cause a correct, previously-working client to fail: removing a field, renaming it, narrowing a type, adding a required request parameter, tightening validation, or changing a status code's meaning.
- **Additive change** — adding an optional request field, a new response field, a new endpoint, or a new enum value in a place clients are told to tolerate. Safe *if* clients follow the tolerant-reader rule.
- **URI versioning** — the version lives in the path (`/v1/orders`) or occasionally the query string (`?api-version=2024-06-20`). Most visible, most cacheable, least RESTful.
- **Header versioning** — a custom header (`API-Version: 2`) or a vendor media type (`Accept: application/vnd.acme.v2+json`) carries the version; the URI stays stable across versions.
- **Media-type versioning** — a flavour of header versioning that uses HTTP **content negotiation** properly: the client `Accept`s a versioned representation and the server echoes it in `Content-Type`.
- **Date-based versioning** — versions are calendar dates (`2024-06-20`) rather than integers; each date is a snapshot of all breaking changes shipped up to that point. Pairs naturally with account pinning.
- **Version pinning** — the server remembers a default version per API key or account, so a client that sends no version header does not silently drift onto new behaviour.
- **Semantic versioning (SemVer)** — `MAJOR.MINOR.PATCH`; only MAJOR is breaking. Excellent for SDKs and libraries, a poor fit for HTTP surfaces where clients cannot express ranges.
- **Tolerant reader** — a client that ignores unknown fields, does not assume field ordering, and treats unknown enum values as a documented fallback. The single most important prerequisite for additive evolution.
- **Sunset** — the published date after which a version stops working, advertised via the `Sunset` header (RFC 8594) and `Deprecation` header.

## 3. Theory & Principles

### 3.1 What HTTP actually says

RFC 9110 defines a URI as an identifier for a *resource*, and a representation as one rendering of that resource's state selected through **proactive content negotiation** (`Accept`, `Accept-Language`, `Accept-Encoding`). By that reading `/v1/orders/42` and `/v2/orders/42` are two *different resources*, which is semantically wrong — they are the same order. The theoretically correct move is one URI plus `Accept: application/vnd.acme.order.v2+json`.

The theory is right and practice mostly ignores it, for three concrete reasons. **Cache keys**: shared caches key on the URI plus whatever `Vary` names, so header versioning forces `Vary: Accept` — which many CDNs handle badly and which fragments the cache across every header spelling a client sends. **Observability**: `/v1/` appears in access logs and route metrics for free; a header does not unless you promote it to a label. **Discoverability**: a URI works when pasted into a browser; header versioning requires reading the docs before the first successful request.

> **Note:** The purity argument is real but low-stakes. Choose on cache topology and client sophistication, not doctrine. What matters is that *some* version is always explicit and never implicit.

### 3.2 The compatibility lattice

**Backward compatible** means a *new server* correctly serves an *old client* — the direction you owe your users. **Forward compatible** means an *old client* survives contact with a *new server's* output — the direction your clients owe you, and entirely a function of tolerant reading. A change is safe only if it preserves both. That yields a mechanical test: for every field, ask "can a client that has never heard of this field still produce a valid request and parse a valid response?" If yes, ship it without a version.

### 3.3 The cost function

Let `V` be the number of live versions and `E` the number of endpoints. Naïve branching costs `O(V × E)` code paths, which is why teams that fork controllers per version drown at V=3. Stripe's transformer approach collapses this: **one** modern implementation plus an ordered chain of `V-1` small transformers, so cost grows as `O(V + E)` and each transformer is independently testable.

```
response_for(client_version) =
    let r = current_handler(request)
    in  fold(transformers where t.version > client_version, descending)
          applied to r
```

The same chain runs forward on the request path (upgrade an old request into modern shape) and backward on the response path (downgrade a modern response into old shape).

```svg
<svg viewBox="0 0 760 330" width="100%" height="330" font-family="ui-sans-serif,system-ui,sans-serif">
  <defs>
    <marker id="a31" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#4f46e5"/></marker>
    <marker id="b31" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#16a34a"/></marker>
  </defs>
  <rect x="10" y="10" width="740" height="310" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="40" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Version transformer chain (one core, many contracts)</text>
  <rect x="30" y="70" width="130" height="56" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="95" y="94" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client pinned</text>
  <text x="95" y="112" text-anchor="middle" fill="#1e293b" font-size="12">2023-01-10</text>
  <rect x="200" y="70" width="120" height="56" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="260" y="94" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">upgrade T1</text>
  <text x="260" y="112" text-anchor="middle" fill="#1e293b" font-size="10">2023-06-01</text>
  <rect x="360" y="70" width="120" height="56" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="420" y="94" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">upgrade T2</text>
  <text x="420" y="112" text-anchor="middle" fill="#1e293b" font-size="10">2024-06-20</text>
  <rect x="530" y="60" width="190" height="76" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="625" y="88" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Core handler</text>
  <text x="625" y="108" text-anchor="middle" fill="#1e293b" font-size="11">latest shape only</text>
  <text x="625" y="126" text-anchor="middle" fill="#1e293b" font-size="10">no version branches</text>
  <path d="M160 98 L196 98" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a31)"/>
  <path d="M320 98 L356 98" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a31)"/>
  <path d="M480 98 L526 98" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a31)"/>
  <text x="380" y="160" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">request path: old shape upgraded forward</text>
  <path d="M526 210 L482 210" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b31)"/>
  <path d="M356 210 L322 210" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b31)"/>
  <path d="M196 210 L162 210" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b31)"/>
  <rect x="530" y="182" width="190" height="56" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="625" y="216" text-anchor="middle" fill="#1e293b" font-size="12">modern response</text>
  <rect x="360" y="182" width="120" height="56" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="420" y="216" text-anchor="middle" fill="#1e293b" font-size="11">downgrade T2</text>
  <rect x="200" y="182" width="120" height="56" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="260" y="216" text-anchor="middle" fill="#1e293b" font-size="11">downgrade T1</text>
  <rect x="30" y="182" width="130" height="56" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="95" y="216" text-anchor="middle" fill="#1e293b" font-size="11">2023-01-10 shape</text>
  <text x="380" y="266" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">response path: modern shape downgraded backward</text>
  <text x="380" y="296" text-anchor="middle" fill="#1e293b" font-size="11">cost grows as O(versions + endpoints), not O(versions &#215; endpoints)</text>
</svg>
```

### 3.4 Why SemVer does not transfer to HTTP

SemVer works for libraries because the consumer declares a *range* (`^2.1.0`) and a resolver picks a compatible build at install time. HTTP has no resolver: a client sends one concrete request, with no step where the server could say "you asked for 2.1, I have 2.4, here is what I'll do." Only the MAJOR component is expressible over the wire; MINOR/PATCH collapse into "the server changed underneath you." Ship SemVer for your **SDKs**; ship a single integer or a date for your **HTTP surface**.

## 4. Architecture & Workflow

The end-to-end path of a versioned request, from client to store and back:

1. **Client sends a request.** Either the version is in the path (`POST /v1/charges`) or in a header (`Stripe-Version: 2024-06-20`, `API-Version: 2`, or `Accept: application/vnd.acme.v2+json`).
2. **Edge/gateway resolves the effective version.** Precedence is normally: explicit per-request header → account/API-key pinned default → global default (usually the *oldest supported*, never "latest", so a silent client never drifts). The resolved value is written into the request context and emitted as a metric label.
3. **Gateway validates the version.** Unknown or retired versions fail fast with `400 Bad Request` (malformed) or `410 Gone` (retired), with a Problem Details body pointing at the migration guide.
4. **Routing.** URI versioning routes to a version-scoped router. Header versioning routes to one router and attaches the version to context. A hybrid — major in URI, minor in header — is common: `/v2/orders` plus `API-Version: 2024-06-20`.
5. **Request upgrade chain.** Transformers whose version is newer than the client's are applied in ascending order, rewriting the old request shape into the current internal shape (e.g. splitting a legacy `name` into `first_name`/`last_name`).
6. **Single core handler executes.** It knows only the current model. It reads and writes the datastore with today's schema. No `if version == ...` branches live here — that is the whole point.
7. **Response downgrade chain.** The modern response is passed backwards through the same transformers in descending order until it matches the client's pinned shape.
8. **Response annotation.** The server echoes the effective version (`API-Version: 2024-06-20`), and if that version is deprecated adds `Deprecation: @1718841600` and `Sunset: Wed, 31 Dec 2025 23:59:59 GMT` plus a `Link: <...>; rel="deprecation"`.
9. **Telemetry.** Every response increments `api_requests_total{version, route, status}`, which is the dataset that later tells you whether a sunset is safe.
10. **Caches key correctly.** URI versioning gets this for free. Header versioning must send `Vary: API-Version` (or `Vary: Accept`) or shared caches will serve one version's body to another version's client — a genuinely dangerous bug.

```svg
<svg viewBox="0 0 780 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif">
  <defs>
    <marker id="c31" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#4f46e5"/></marker>
    <marker id="d31" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#0ea5e9"/></marker>
  </defs>
  <rect x="10" y="10" width="760" height="360" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Versioned request lifecycle</text>
  <rect x="30" y="70" width="120" height="70" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="90" y="98" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
  <text x="90" y="116" text-anchor="middle" fill="#1e293b" font-size="10">API-Version: 2</text>
  <text x="90" y="132" text-anchor="middle" fill="#1e293b" font-size="10">or /v2/ in path</text>
  <rect x="200" y="60" width="150" height="90" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="275" y="86" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Gateway</text>
  <text x="275" y="104" text-anchor="middle" fill="#1e293b" font-size="10">resolve: header &#8594;</text>
  <text x="275" y="119" text-anchor="middle" fill="#1e293b" font-size="10">key pin &#8594; default</text>
  <text x="275" y="136" text-anchor="middle" fill="#1e293b" font-size="10">410 if retired</text>
  <rect x="400" y="60" width="150" height="90" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="475" y="86" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Transformers</text>
  <text x="475" y="106" text-anchor="middle" fill="#1e293b" font-size="10">upgrade request</text>
  <text x="475" y="123" text-anchor="middle" fill="#1e293b" font-size="10">downgrade response</text>
  <rect x="600" y="60" width="150" height="90" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="675" y="86" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Core service</text>
  <text x="675" y="106" text-anchor="middle" fill="#1e293b" font-size="10">latest model only</text>
  <text x="675" y="123" text-anchor="middle" fill="#1e293b" font-size="10">no version if-blocks</text>
  <path d="M150 105 L196 105" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#c31)"/>
  <path d="M350 105 L396 105" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#c31)"/>
  <path d="M550 105 L596 105" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#c31)"/>
  <rect x="600" y="190" width="150" height="56" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="675" y="214" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Datastore</text>
  <text x="675" y="232" text-anchor="middle" fill="#1e293b" font-size="10">current schema</text>
  <path d="M675 150 L675 186" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#c31)"/>
  <rect x="30" y="270" width="720" height="80" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="390" y="294" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Response headers on the way out</text>
  <text x="390" y="314" text-anchor="middle" fill="#1e293b" font-size="11">API-Version: 2 &#183; Vary: API-Version &#183; Deprecation: @1718841600</text>
  <text x="390" y="334" text-anchor="middle" fill="#1e293b" font-size="11">Sunset: Wed, 31 Dec 2025 23:59:59 GMT &#183; Link: &lt;/docs/migrate&gt;; rel="deprecation"</text>
  <path d="M90 145 L90 265" stroke="#0ea5e9" stroke-width="2" fill="none" marker-end="url(#d31)"/>
</svg>
```

## 5. Implementation

### 5.1 The three wire formats, side by side

URI versioning — everything in the path, nothing to negotiate:

```http
GET /v2/orders/ord_8812 HTTP/1.1
Host: api.acme.dev
Authorization: Bearer sk_live_9f2c...
Accept: application/json

HTTP/1.1 200 OK
Content-Type: application/json
API-Version: 2
Cache-Control: private, max-age=30
ETag: W/"ord-8812-r7"

{ "id": "ord_8812",
  "customer": { "id": "cus_301", "first_name": "Dana", "last_name": "Rao" },
  "total": { "amount": 4599, "currency": "INR" }, "status": "shipped" }
```

Custom-header versioning — one stable URI, and `Vary` is mandatory:

```http
GET /orders/ord_8812 HTTP/1.1
Host: api.acme.dev
API-Version: 2024-06-20

HTTP/1.1 200 OK
Content-Type: application/json
API-Version: 2024-06-20
Vary: API-Version
Deprecation: true
Sunset: Wed, 31 Dec 2025 23:59:59 GMT
Link: <https://docs.acme.dev/migrate/v1-to-v2>; rel="deprecation"
```

Media-type versioning — real content negotiation with a quality-value fallback; if the client demands a version you cannot produce, answer `406 Not Acceptable`:

```http
GET /orders/ord_8812 HTTP/1.1
Accept: application/vnd.acme.order.v2+json, application/vnd.acme.order.v1+json;q=0.5

HTTP/1.1 200 OK
Content-Type: application/vnd.acme.order.v2+json
Vary: Accept
```

A version you deliberately turned off is `410 Gone` — never `404`, because the distinction is what makes the error actionable:

```http
HTTP/1.1 410 Gone
Content-Type: application/problem+json
Link: <https://docs.acme.dev/migrate/v1-to-v2>; rel="deprecation"

{ "type": "https://api.acme.dev/problems/version-retired",
  "title": "API version retired", "status": 410,
  "detail": "v1 was sunset on 2025-12-31. Migrate to v2.",
  "instance": "/v1/orders/ord_8812", "supported_versions": ["v2", "v3"] }
```

### 5.2 curl probes

```bash
# Ask for a specific date-based version; inspect headers only
curl -sS https://api.acme.dev/orders/ord_8812 -H "Authorization: Bearer $TOKEN" \
  -H "API-Version: 2024-06-20" -D - -o /dev/null

# Discover the server's default for your key (send no version at all)
curl -sS https://api.acme.dev/orders/ord_8812 -H "Authorization: Bearer $TOKEN" \
  -D - -o /dev/null | grep -i '^api-version'
```

### 5.3 FastAPI: header versioning with a transformer chain

```python
from datetime import date
from fastapi import FastAPI, Header, HTTPException, Request, Response

SUPPORTED = [date(2023, 1, 10), date(2023, 6, 1), date(2024, 6, 20)]
LATEST, RETIRED = SUPPORTED[-1], {date(2022, 5, 1)}

def resolve_version(raw: str | None, account_pin: date) -> date:
    if raw is None:
        return account_pin                       # never silently jump to LATEST
    try:
        v = date.fromisoformat(raw)
    except ValueError:
        raise HTTPException(400, "API-Version must be YYYY-MM-DD")
    if v in RETIRED:    raise HTTPException(410, f"Version {v} was retired")
    if v not in SUPPORTED: raise HTTPException(406, f"Unsupported version {v}")
    return v

# Each transformer is named after the version that INTRODUCED the change.
# up(): old shape -> modern.  down(): modern -> the shape used before this version.
class SplitCustomerName:
    version = date(2023, 6, 1)
    def up(self, b):
        if "name" in b:
            first, _, last = b.pop("name").partition(" ")
            b["first_name"], b["last_name"] = first, last
        return b
    def down(self, b):
        if "first_name" in b:
            b["name"] = f"{b.pop('first_name')} {b.pop('last_name', '')}".strip()
        return b

class MoneyAsObject:                          # scalar total -> {amount, currency}
    version = date(2024, 6, 20)
    def up(self, b):
        if isinstance(b.get("total"), int):
            b["total"] = {"amount": b["total"], "currency": b.pop("currency", "INR")}
        return b
    def down(self, b):
        if isinstance(t := b.get("total"), dict):
            b["total"], b["currency"] = t["amount"], t["currency"]
        return b

CHAIN = sorted([SplitCustomerName(), MoneyAsObject()], key=lambda t: t.version)
upgrade   = lambda body, cv: _fold(CHAIN, body, cv, "up")
downgrade = lambda body, cv: _fold(reversed(CHAIN), body, cv, "down")

def _fold(chain, body, cv, op):
    for t in chain:
        if t.version > cv: body = getattr(t, op)(body)
    return body

app = FastAPI()

@app.get("/orders/{order_id}")
async def get_order(order_id: str, response: Response, request: Request,
                    api_version: str | None = Header(None, alias="API-Version")):
    v = resolve_version(api_version, request.state.account_pinned_version)
    order = await store.fetch_order(order_id)    # always the modern shape
    if order is None:
        raise HTTPException(404, "Order not found")
    response.headers["API-Version"] = v.isoformat()
    response.headers["Vary"] = "API-Version"
    if v < LATEST:
        response.headers["Deprecation"] = "true"
        response.headers["Link"] = '<https://docs.acme.dev/migrate>; rel="deprecation"'
    return downgrade(order, v)
```

### 5.4 Express: URI versioning with one shared core

```javascript
import express from 'express';
const app = express(), v1 = express.Router(), v2 = express.Router();

const present = {                          // one loader, per-version presenters
  1: (o) => ({ id: o.id, name: `${o.firstName} ${o.lastName}`, total: o.amountMinor }),
  2: (o) => ({ id: o.id, customer: { id: o.customerId, first_name: o.firstName },
               total: { amount: o.amountMinor, currency: o.currency } }),
};
for (const [version, router] of [[1, v1], [2, v2]]) {
  router.get('/orders/:id', async (req, res, next) => {
    try {
      const order = await loadOrder(req.params.id);   // modern shape, always
      res.set('API-Version', String(version));
      if (version < 2) { res.set('Deprecation', 'true');
                         res.set('Sunset', 'Wed, 31 Dec 2025 23:59:59 GMT'); }
      res.json(present[version](order));
    } catch (e) { next(e); }
  });
}
app.use('/v1', v1);
app.use('/v2', v2);
app.use('/v0', (_req, res) => res.status(410).type('application/problem+json').json({
  type: 'https://api.acme.dev/problems/version-retired',
  title: 'API version retired', status: 410, detail: 'v0 retired 2024-03-01.' }));
```

### 5.5 Declaring the version in OpenAPI 3.1

Document the version header as a real parameter so generated clients send it and generated docs mention it:

```yaml
openapi: 3.1.0
info: { title: Acme Orders API, version: "2024-06-20" }
servers: [{ url: https://api.acme.dev/v2 }]
components:
  parameters:
    ApiVersion:
      name: API-Version
      in: header
      description: Date-based version; defaults to the account's pinned version.
      schema: { type: string, format: date, examples: ["2024-06-20"] }
```

> **Optimization note:** URI versioning is cache-friendly by construction — a CDN can shard `/v1/*` and `/v2/*` independently, and you can route the low-traffic legacy version to a smaller pool. Header versioning must set `Vary`, which multiplies cache entries by the number of distinct header spellings clients send; **normalize the header at the edge** (map every accepted spelling to a canonical date, strip unknown ones) before the cache key is computed, or your hit rate collapses. If many versions are live, cache the *modern* response once and run the downgrade chain on read — one cache entry then serves every version.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| **URI versioning (`/v1/`)** | Trivially visible, cacheable, greppable, zero client sophistication; per-version routing and rollout | Violates URI-identifies-a-resource; duplicates the whole surface per version; links between versions get awkward |
| **Header versioning** | One stable URI per resource; fine-grained; easy to add per-account pinning | Invisible in logs unless promoted; requires correct `Vary`; hostile to browser exploration and naive `curl` |
| **Media-type versioning** | The RFC-correct answer; `406` semantics come for free; supports quality-value fallback | Almost no client library makes this ergonomic; CDN `Vary: Accept` fragmentation; steep learning curve |
| **Integer versions (v1, v2)** | Human-memorable, small set, clear "big bang" migrations | Encourages hoarding breaking changes into a giant risky release; no signal about *what* changed |
| **Date versions (2024-06-20)** | Encourages many tiny breaking changes; natural ordering; pairs perfectly with pinning | Hundreds of live versions to test; needs a transformer framework or it becomes unmanageable |
| **No versioning (additive only)** | Zero operational cost, one contract, one test suite | You can never remove or rename anything; the schema accretes cruft indefinitely |
| **Account pinning** | Silent clients never break; upgrades become an explicit act | Long tail of ancient versions that nobody will ever migrate off without a forced sunset |
| **Version in query (`?api-version=`)** | Easy to add to an existing surface; visible | Query strings are frequently dropped from cache keys and logs; feels bolted-on |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Defaulting an unversioned request to "latest."** The day you ship v3, every naive client silently changes behaviour. → ✅ Default to the **oldest supported version**, or to the account's pinned version, and require an explicit opt-in to move forward.
2. ⚠️ **Cutting a new major version for an additive change.** Adding `order.tracking_url` does not need a v3; you have just doubled your maintenance surface for nothing. → ✅ Apply the compatibility test first: if a v2-era client still parses it, ship it into v2.
3. ⚠️ **Forking controllers per version.** Copy-pasting `OrdersV1Controller` into `OrdersV2Controller` means every bug fix must be applied N times, and one of them will be missed. → ✅ One core handler plus thin per-version presenters or transformers.
4. ⚠️ **Header versioning without `Vary`.** A shared cache stores the v2 body under the bare URI and then serves it to a v1 client. → ✅ Always `Vary: API-Version` (or `Vary: Accept`) and normalize the header at the edge.
5. ⚠️ **Retired versions returning `404`.** The client's engineer thinks they typo'd the path and burns a day. → ✅ `410 Gone` with a Problem Details body and a `Link: rel="deprecation"` to the migration guide.
6. ⚠️ **Versioning the whole API when one endpoint changed.** Everyone pays the migration tax for a change they don't use. → ✅ Prefer resource- or representation-scoped versioning (media types, or per-endpoint opt-in flags) for surgical changes.
7. ⚠️ **Putting the version in the URI *and* the header with no defined precedence.** Two sources of truth produce nondeterministic routing. → ✅ Document a strict precedence — explicit header beats path beats account pin beats default — and assert it in tests.
8. ⚠️ **Shipping a breaking change without any version bump because "nobody uses that field."** You do not actually know that; logs rarely capture response-field usage. → ✅ Instrument field-level usage before removal, or treat every removal as breaking regardless of belief.
9. ⚠️ **No sunset policy at all.** v1 lives forever, and eight years later it blocks a database migration. → ✅ Publish a support window (e.g. "each version supported ≥ 24 months after its successor ships") on day one, before anyone depends on you.
10. ⚠️ **Treating enum additions as safe by default.** A client with an exhaustive `switch` crashes on `status: "partially_refunded"`. → ✅ Document the tolerant-reader contract *and* the fallback value in v1's docs; if you didn't, adding an enum value is breaking.
11. ⚠️ **Version numbers that don't appear in metrics.** Also avoid leaking internal build identifiers like `X-Service-Build: orders-svc-4.7.1-rc2`, which invite clients to couple to your deploy cadence. You cannot sunset what you cannot measure. → ✅ Label every request metric with the resolved version and the API key, and build the "who is still on v1" dashboard before you announce the deprecation.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

Always echo the **resolved** version back (`API-Version:`). Half of all versioning bugs are "the client thought it was on v2 and the gateway resolved v1," and echoing turns a two-day investigation into one `curl -D -`. Log the resolved version, the *source* of the resolution (header/path/pin/default), and the API key on every request, and ship a `GET /v2/whoami` returning `{"api_version": "2024-06-20", "resolved_from": "account_pin", "deprecated": false}` so support can settle the argument in one call.

### Monitoring

Track, at minimum:

- `api_requests_total{version, route, status}` — the sunset-readiness dataset.
- `api_unique_clients{version}` (distinct API keys per day) — a single high-volume client on v1 is a phone call; two hundred low-volume clients is a campaign.
- `api_version_resolution_total{source}` — a spike in `source="default"` means clients stopped sending the header.
- `deprecated_version_requests_total` with a burn-down target, reviewed weekly during a sunset.
- 4xx rate **broken out by version** — a v3 rollout regression hides completely in an aggregate error rate.

### Security

Old versions are a **security liability**: they skip newer authorization checks, expose fields later classified as sensitive, or accept weaker validation. Treat every live version as in-scope for security review, apply authorization in the shared core (never in a version-specific presenter), and make sure a v1 response cannot leak a field v3 deliberately redacts. Rate limits, quota accounting and audit logging must be version-independent — attackers probe the oldest surface first precisely because it is the least maintained.

### Performance & Scaling

Route legacy versions to a smaller pool so their long tail does not eat capacity planned for the current version. Behind a CDN, normalize the version header to a canonical value at the edge before the cache key is computed. Cache the modern representation once and apply downgrade transformers on read — one cache entry then serves every live version. Keep a **conformance suite per live version** in CI: the cost of N versions is dominated by test time, and a version whose tests you cannot afford to run is a version you cannot safely keep.

## 9. Interview Questions

**Q: What exactly makes a change "breaking" in a REST API?**
A: A change is breaking if a correct client written against the previous contract can now fail. That includes removing or renaming a response field, changing a field's type or nullability, adding a required request parameter, tightening validation, changing a status code's meaning, or altering pagination semantics. Adding optional request fields and new response fields is not breaking — provided you have told clients to be tolerant readers.

**Q: URI versioning versus header versioning — which do you pick and why?**
A: URI versioning for public APIs with a broad, unsophisticated client base, because it is visible, cacheable, and works in a browser. Header or media-type versioning for internal or partner APIs where you control the clients and want URIs that identify resources stably. The decisive practical factor is usually your cache topology: header versioning demands correct `Vary` handling that many CDNs get wrong.

**Q: Why is date-based versioning popular with payment APIs?**
A: Dates impose a natural total ordering and encourage shipping many small breaking changes rather than hoarding them into a risky "v2." Combined with per-account pinning, a customer's behaviour never changes until they explicitly opt in. Stripe and Twilio both use this, and Stripe has never needed a v2 of its core API as a result.

**Q: Where should the version be resolved — gateway or service?**
A: Resolve it once, at the edge, and put the result in the request context so every downstream hop sees the same answer. Resolving independently in multiple services guarantees they will eventually disagree. The gateway is also the right place to reject retired versions with `410` before any business logic runs.

**Q: What status code do you return for an unsupported version, and for a retired one?**
A: `406 Not Acceptable` when the client used content negotiation and you cannot produce the requested representation; `400 Bad Request` if the version string is malformed; `410 Gone` for a version that existed and has been deliberately retired. `404` is wrong for a retired version because it implies the path never existed.

**Q: How do you know it is safe to shut off v1?**
A: You measure. Instrument requests per version per API key, publish a burn-down, contact the remaining callers directly, and run scheduled "brownouts" — short windows where v1 returns `410` — to smoke out clients whose owners never read email. Only sunset when traffic is near zero and every remaining caller has been individually contacted.

**Q: Can you version individual endpoints instead of the whole API?**
A: Yes, and it is often kinder: media-type versioning naturally scopes to a representation, so `application/vnd.acme.order.v2+json` changes only orders. The cost is cognitive — clients now track a matrix of per-resource versions rather than one number — so it works best with generated SDKs that hide the matrix.

**Q: (Senior) Design a versioning scheme for an API with 400 endpoints and 30,000 integrators.**
A: Date-based versions with per-API-key pinning, resolved at the gateway, plus a transformer chain so the core service only ever implements the latest model. Publish a fixed support window (24 months), automate deprecation headers from a version registry, and build the per-key usage dashboard before the first deprecation. Ship SDKs that default to a pinned version so most integrators never think about it, and reserve URI-major versions for genuine architectural pivots — ideally never.

**Q: (Senior) How does versioning interact with your database schema and your event streams?**
A: The HTTP contract and the storage schema must be decoupled by a mapping layer, otherwise a storage migration becomes a client-visible breaking change. Use expand/contract on the database (add the new column, dual-write, backfill, switch reads, drop the old column) so no single deploy is breaking. Event streams need their own versioning discipline — usually schema-registry-enforced backward compatibility — because consumers there cannot negotiate the way HTTP clients can.

**Q: (Senior) When is it right to *not* version at all?**
A: When your clients are all internal, deployed continuously, and discoverable — then a coordinated change plus a contract test suite is cheaper than a version. Also when the API is genuinely additive-only by design (append-only event feeds, read-only reference data). Versioning is insurance; if you can prove every client upgrades within a deploy cycle, you are paying a premium against a risk you do not carry.

**Q: How do you handle a security fix that is inherently breaking — say, you must stop returning a field that leaks PII?**
A: Security overrides compatibility. Remove or redact it in every live version immediately, notify affected integrators, and document it in the changelog as an out-of-band breaking change. The alternative — leaving PII exposed on v1 for two more years to honour a support window — is not a defensible trade.

**Q: What is a "tolerant reader" and whose responsibility is it?**
A: A client that ignores unknown fields, does not depend on JSON key ordering, and handles unknown enum values via a documented default. It is the *client's* responsibility to implement, but the *provider's* responsibility to demand explicitly in the documentation, in the SDK defaults, and ideally in a published conformance test. Without it, you cannot make even additive changes safely.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A version is a bundle of breaking changes shipped together, so the first move is to avoid needing one: additive changes plus tolerant readers cost nothing. When you must break, choose where the version lives — path (visible, cacheable), header (stable URIs, needs `Vary`), or media type (RFC-correct, ergonomically painful) — and choose an axis: integers for rare big-bang migrations, dates for frequent small ones. Resolve once at the gateway with a documented precedence (explicit header → path → account pin → oldest-supported default; never "latest"), echo it back in `API-Version`, and implement one core handler with a transformer chain rather than forked controllers. Retired versions answer `410`, unsupported `406`, malformed `400`. Publish a support window on day one, label every metric with the version, and never sunset a version you have not measured.

| Concern | Correct answer |
| --- | --- |
| Version in path | `GET /v2/orders/42` — cacheable, visible |
| Version in header | `API-Version: 2024-06-20` + `Vary: API-Version` |
| Version in media type | `Accept: application/vnd.acme.order.v2+json` |
| Echo on response | `API-Version: 2024-06-20` (always) |
| Deprecated version | `Deprecation: true` or `@<unix-ts>` + `Sunset: <HTTP-date>` |
| Migration pointer | `Link: <https://docs/migrate>; rel="deprecation"` |
| Retired version | `410 Gone` + `application/problem+json` |
| Unsupported negotiation | `406 Not Acceptable` |
| Malformed version string | `400 Bad Request` |
| Default when absent | account pin, else **oldest supported** |
| Breaking? | removal, rename, type narrowing, new required field, stricter validation |
| Not breaking? | new optional request field, new response field, new endpoint |

**Flash cards**

- **Where does the version go for a public API with 30k integrators?** → Path or header, resolved at the gateway; dates if you break often, integers if you break rarely.
- **Default version for a request with no version header?** → The account's pinned version, or the oldest supported — never "latest."
- **Status code for a version you deliberately turned off?** → `410 Gone`, with a `Link: rel="deprecation"` to the migration guide.
- **Why must header versioning send `Vary`?** → Shared caches key on URI plus `Vary`ed headers; without it one version's body is served to another version's client.
- **The trick that makes N live versions affordable?** → One modern core handler plus an ordered chain of small up/down transformers, cost `O(V + E)` not `O(V × E)`.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement all three wire formats (path, custom header, vendor media type) for one `GET /users/{id}` handler. Verify with `curl -D -` that each echoes `API-Version` and that the media-type variant sends `Vary: Accept`.
- [ ] Write the resolution function with the full precedence chain and unit-test every combination, including malformed input → `400` and retired input → `410`.
- [ ] Build a two-link transformer chain (split `name`; scalar `total` → `{amount, currency}`) and assert round-tripping `down(up(old)) == old` over a fixture corpus.
- [ ] Put nginx `proxy_cache` in front of a header-versioned endpoint, reproduce the cache-poisoning bug by omitting `Vary`, then prove the fix with two differently-versioned clients.
- [ ] Build a `deprecated_version_requests_total` burn-down from access logs grouped by API key, and name the top three callers you would email first.

### Mini Project — `versionctl`: a version lifecycle service

**Goal.** Build a small service that owns the version registry for an API and enforces its lifecycle, so no individual endpoint has to.

**Requirements.**
1. A registry file (`versions.yaml`) listing every version with `released_at`, `deprecated_at`, `sunset_at`, and a human changelog entry per breaking change.
2. Middleware (FastAPI or Express) that resolves the effective version using the documented precedence, rejects retired versions with `410` + Problem Details, unsupported ones with `406`, and malformed ones with `400`.
3. Automatic response decoration: `API-Version`, `Vary`, and — when the resolved version is past `deprecated_at` — `Deprecation`, `Sunset`, and a `Link: rel="deprecation"` header generated from the registry.
4. A transformer registry keyed by version, applied as an up-chain on requests and a down-chain on responses, with a test harness that asserts round-trip fidelity for every fixture.
5. A `GET /_versions` endpoint returning the full lifecycle table as JSON, and a Prometheus counter labelled `{version, source, route}`.

**Extensions.**
- Add **brownout** support: for a configured window each day a deprecated version returns `410` instead of serving, ramped from 1 minute to 60 minutes over four weeks.
- Generate the public deprecation calendar page directly from `versions.yaml` so docs can never drift from behaviour, and emit a weekly "keys still on a deprecated version" report sorted by request volume.
- Add a conformance-test runner that replays a golden corpus against every live version and diffs responses against checked-in snapshots.

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Backward Compatibility & Deprecation* (chapter 32) covers the change-classification and sunset program in depth; *OpenAPI: The Machine-Readable Contract* (chapter 33) shows how to encode versions in a spec; *Design-First & Contract Testing* (chapter 34) gives you the enforcement mechanism that makes additive evolution provable; *API Documentation That Developers Love* (chapter 35) covers changelogs and migration guides; *Testing REST APIs* (chapter 36) shows how to run per-version conformance suites.

- **RFC 9110 — HTTP Semantics** — IETF · *Intermediate* · the normative source for content negotiation, `Vary`, and status-code semantics; read §12 (content negotiation) and §15 (status codes) before choosing a versioning axis. <https://www.rfc-editor.org/rfc/rfc9110.html>
- **RFC 8594 — The Sunset HTTP Header Field** — IETF · *Beginner* · three pages that define exactly how to announce a resource's end of life; the deprecation program in §8 is built on it. <https://www.rfc-editor.org/rfc/rfc8594.html>
- **RFC 9457 — Problem Details for HTTP APIs** — IETF · *Beginner* · the standard error body used for the `406`/`410` responses in this chapter; obsoletes RFC 7807. <https://www.rfc-editor.org/rfc/rfc9457.html>
- **Microsoft REST API Guidelines** — Microsoft · *Intermediate* · the versioning chapter is unusually specific about what counts as breaking and mandates `api-version` as a query parameter with a rationale worth arguing with. <https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md>
- **Zalando RESTful API Guidelines** — Zalando · *Intermediate* · rules 111–116 cover versioning, deprecation, and the tolerant-reader contract with the clearest MUST/SHOULD language of any public guideline. <https://opensource.zalando.com/restful-api-guidelines/>
- **Google API Improvement Proposals — AIP-180 (Backwards Compatibility)** — Google · *Advanced* · an exhaustive, categorised list of what breaks and what does not, derived from versioning APIs at planetary scale. <https://google.aip.dev/180>
- **Stripe API Versioning documentation** — Stripe · *Intermediate* · the canonical worked example of date-based versioning with account pinning; the upgrade log is a masterclass in shipping small breaking changes. <https://docs.stripe.com/api/versioning>
- **GitHub REST API versioning** — GitHub · *Beginner* · shows date-based versions layered on top of a URI major, plus how they document breaking changes per version. <https://docs.github.com/en/rest/about-the-rest-api/api-versions>

---

*REST API Handbook — chapter 31.*
