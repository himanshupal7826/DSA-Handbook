# 32 · Backward Compatibility & Deprecation

> **In one line:** Backward compatibility is the discipline of changing an API without changing what already-shipped clients observe; deprecation is the humane, instrumented process for removing what you can no longer keep.

---

## 1. Overview

Every published API accumulates two kinds of debt: **things you got wrong** and **things that stopped being true**. A field named `phone` that turned out to need a country code; a `status` enum that never anticipated partial refunds; an endpoint modelled around a business process that no longer exists. Backward compatibility is the set of rules that lets you fix these without a version cut, and deprecation is the escape hatch for the cases where you cannot.

The problem is asymmetric power. You control your deploy; you do not control your clients'. A mobile app pinned to your API sits on devices for years. A partner's nightly batch job was written by a contractor who left in 2021. When you break them, they do not file a ticket — they page their own on-call at 3 a.m. and then churn. So the operative question is never "is this change correct?" but **"what does a client that has never read my changelog observe?"**

The distinction that makes this tractable came out of database schema migration practice — Martin Fowler and Pramod Sadalage's **expand/contract** (or parallel change) pattern. Instead of one atomic breaking change, you split it into three deploys: **expand** (add the new thing alongside the old), **migrate** (move readers and writers over), **contract** (remove the old thing). Each deploy is individually non-breaking. Applied to HTTP, expand/contract is what makes it possible to reshape an API over years without ever cutting v2. The HTTP layer contributes two standard signalling headers: `Deprecation` (RFC 9745) and `Sunset` (RFC 8594).

**Concrete example.** GitHub wanted to remove the `repository.master_branch` field. They did not ship v4. They added `default_branch` alongside it (expand), documented both, populated both for years, tracked which OAuth apps still read the old one, emailed those developers, and finally removed it (contract) — a multi-year additive path. Contrast with the classic failure mode: an internal team renames `customerId` to `customer_id` in a "cleanup" PR, the mobile app's JSON decoder throws on a missing required key, and 40% of sessions crash before anyone connects the deploy to the outage.

The durable mental model: **compatibility is about the observer, not the code.** If no conforming client can tell the difference, the change is compatible — even if you rewrote the service. If one conforming client can tell, the change is breaking — even if you only added a validation rule.

## 2. Core Concepts

- **Backward compatible change** — a new server version that continues to satisfy every client written against the previous contract. This is the property you owe your users.
- **Tolerant reader** — a client that ignores unknown fields, does not depend on key ordering, tolerates unknown enum values via a documented default, and does not assume a closed set of status codes. Robustness principle applied to HTTP.
- **Expand / contract (parallel change)** — the three-phase migration: add the new form, dual-write and dual-read while clients move, then remove the old form. Every individual phase is non-breaking.
- **Additive evolution** — growing the contract only by addition (new optional request fields, new response fields, new endpoints, new status codes within an existing class).
- **Deprecation** — a public declaration that a field, endpoint, or version still works but should not be adopted, and will eventually be removed. Signalled with the `Deprecation` header (RFC 9745).
- **Sunset** — the date after which a deprecated thing stops working, advertised via the `Sunset` header (RFC 8594) plus a `Link: rel="sunset"` to the policy.
- **Brownout** — a scheduled short outage of a deprecated surface (return `410` for 5 minutes each Tuesday) used to smoke out clients whose owners ignore email.
- **Support window** — the published minimum lifetime of a contract after deprecation is announced (commonly 6, 12 or 24 months). Publishing it before anyone integrates is what makes removal politically possible later.
- **Field-level usage telemetry** — logging which response fields a client actually parsed, or which request fields it sent, so removal decisions rest on data rather than belief.
- **Wire compatibility vs semantic compatibility** — the shape may be unchanged while the *meaning* changes (`amount` switching from major to minor units). Semantic breaks are worse because no schema validator catches them.

## 3. Theory & Principles

### 3.1 The observability test

A change is breaking if and only if there exists a **conforming client** — one that obeys your documented contract, including the tolerant-reader rules — whose observable behaviour changes. This gives a decision procedure rather than a taste judgement, and it explains why "we only added validation" is usually a break: a client that previously got `201` now gets `422`.

**Safe (additive)**
- New optional request field or query parameter with a default preserving old behaviour.
- New response field (given a documented tolerant-reader contract).
- New endpoint, new resource, new optional header.
- Relaxing a validation rule (accepting strings you previously rejected).
- New value in an enum you documented as open, *with* a documented fallback.

**Breaking**
- Removing or renaming any request or response field.
- Making an optional request field required, or adding any required field.
- Narrowing a type (`string` → `integer`), or making a nullable field non-nullable, or vice versa.
- Tightening validation (a new max length, a stricter regex, a smaller page-size cap).
- Changing a status code's meaning, or moving a response from `200` to `202`.
- Changing default values, default sort order, or default page size.
- Changing units, timezones, precision, or ID format — the semantic breaks no validator catches.
- Changing an error `type` URI or error code string that clients branch on.

> **Note:** Adding an enum value is the most-argued case. It is safe *only* if you documented from day one that the set is open and told clients what to do with unknowns. Retrofitting that rule onto a shipped API does not make old clients tolerant — they are already deployed.

### 3.2 Why expand/contract works

Let `S` be the server contract and `C` a client. A breaking change is a transition `S₁ → S₂` where some `C` satisfying `S₁` fails against `S₂`. Expand/contract inserts an intermediate `S_both` that satisfies the union of both contracts:

```
S₁  ──expand──▶  S_both  ──migrate──▶  S_both  ──contract──▶  S₂
    (add new,      (clients move       (usage of old         (remove old)
     keep old)      at their pace)      drops to ~0)
```

Because `S_both ⊇ S₁` and `S_both ⊇ S₂`, no single deploy breaks anyone. The migrate phase is not a deploy at all — it is a **campaign**, measured in months and driven by telemetry. The only irreversible moment is contract, and by then you have data proving nobody is watching.

The cost is real: during the middle phase you carry two representations, two write paths, and two sets of tests. Teams that skip the telemetry never learn when the middle phase can end, so `S_both` becomes permanent and the schema accretes forever.

```svg
<svg viewBox="0 0 760 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif">
  <defs><marker id="a32" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#4f46e5"/></marker></defs>
  <rect x="10" y="10" width="740" height="280" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="40" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Expand / contract: no single deploy is breaking</text>
  <rect x="30" y="70" width="150" height="90" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="105" y="94" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">1. Expand</text>
  <text x="105" y="114" text-anchor="middle" fill="#1e293b" font-size="10">add customer_id</text>
  <text x="105" y="130" text-anchor="middle" fill="#1e293b" font-size="10">keep customerId</text>
  <text x="105" y="148" text-anchor="middle" fill="#1e293b" font-size="10">dual-write both</text>
  <rect x="215" y="70" width="150" height="90" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="290" y="94" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">2. Deprecate</text>
  <text x="290" y="114" text-anchor="middle" fill="#1e293b" font-size="10">Deprecation header</text>
  <text x="290" y="130" text-anchor="middle" fill="#1e293b" font-size="10">Sunset + changelog</text>
  <text x="290" y="148" text-anchor="middle" fill="#1e293b" font-size="10">docs mark old field</text>
  <rect x="400" y="70" width="150" height="90" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="475" y="94" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">3. Migrate</text>
  <text x="475" y="114" text-anchor="middle" fill="#1e293b" font-size="10">telemetry per key</text>
  <text x="475" y="130" text-anchor="middle" fill="#1e293b" font-size="10">email top callers</text>
  <text x="475" y="148" text-anchor="middle" fill="#1e293b" font-size="10">brownouts</text>
  <rect x="585" y="70" width="150" height="90" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="660" y="94" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">4. Contract</text>
  <text x="660" y="114" text-anchor="middle" fill="#1e293b" font-size="10">remove customerId</text>
  <text x="660" y="130" text-anchor="middle" fill="#1e293b" font-size="10">usage near zero</text>
  <text x="660" y="148" text-anchor="middle" fill="#1e293b" font-size="10">only risky deploy</text>
  <path d="M180 115 L211 115" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a32)"/>
  <path d="M365 115 L396 115" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a32)"/>
  <path d="M550 115 L581 115" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a32)"/>
  <rect x="30" y="190" width="705" height="46" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="382" y="210" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">S1 &#8838; S_both &#8839; S2 &#8212; every client conforming to S1 or S2 is satisfied by the middle state</text>
  <text x="382" y="228" text-anchor="middle" fill="#1e293b" font-size="11">weeks 0&#8211;2 expand &#183; weeks 2&#8211;4 announce &#183; months 1&#8211;12 migrate &#183; month 12+ contract</text>
  <text x="382" y="266" text-anchor="middle" fill="#1e293b" font-size="11">Skip the telemetry and the middle phase never ends: the schema accretes forever.</text>
</svg>
```

### 3.3 What the RFCs give you

`Sunset` (**RFC 8594**) is a single HTTP-date response header naming the moment a resource stops being available: `Sunset: Wed, 31 Dec 2025 23:59:59 GMT`. It is accompanied by `Link: <...>; rel="sunset"` pointing at a human-readable policy.

`Deprecation` (**RFC 9745**) is orthogonal: it says the resource *is* deprecated now, as an IMF-fixdate in structured-field date syntax — `Deprecation: @1735603200` — where a past timestamp means "already deprecated" and a future one means "will be." A resource can be deprecated without a sunset date (we discourage it, no removal scheduled) and, unusually, sunset without deprecation (an intentionally temporary resource). Pair them with `Link: <...>; rel="deprecation"` for the migration guide.

Neither header is machine-enforcing — nothing stops a client ignoring them. Their value is that SDKs, linters, and gateways can surface them automatically, turning a policy document into a warning in someone's build log.

## 4. Architecture & Workflow

A field rename — `customerId` → `customer_id` — run properly, end to end:

1. **Classify.** Run the change through the observability test. A rename is a removal plus an addition, so it is breaking. Record the decision in the change proposal.
2. **Expand (deploy 1).** The response includes both keys with identical values. The request accepts either; if both are present, define and document precedence (new wins) and log the collision. Storage keeps one canonical column — only the presentation layer is dual.
3. **Instrument.** Emit `deprecated_field_reads_total{field, api_key}` whenever a response containing the old field is served to a client, and `deprecated_field_writes_total` when a request sends it. Response-side reads are an over-count (you cannot see what the client parsed), so treat them as an upper bound and refine with SDK telemetry where you can.
4. **Announce (deploy 2).** Docs mark the field deprecated with the replacement and the sunset date. The changelog entry ships. Responses touching the field carry `Deprecation`, `Sunset`, and `Link: rel="deprecation"`. The OpenAPI document sets `deprecated: true` on the schema property.
5. **Notify.** Email the owners of every API key observed using the old field, with their own usage numbers and a code diff. Generic blog posts do not work; per-account numbers do.
6. **Migrate.** Ship SDK releases that read the new field, so upgrading the SDK is the whole migration for most integrators. Track burn-down weekly.
7. **Brownout.** Starting ~8 weeks before sunset, make the old field disappear from responses (or the endpoint return `410`) for a scheduled window that grows from 5 minutes to a full hour. Announce each window in advance.
8. **Contract (deploy 3).** After the sunset date, and only when usage is near zero, remove the field. Keep the `Deprecation`/`Sunset` metadata pointing at a docs page explaining the removal for at least another quarter.
9. **Verify.** Watch 4xx/5xx by API key for 48 hours. Keep the rollback path — re-adding a field is a one-line change; keep it in a feature flag so it is a config toggle, not a deploy.

```svg
<svg viewBox="0 0 780 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <defs><marker id="b32" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#0ea5e9"/></marker></defs>
  <rect x="10" y="10" width="760" height="330" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Deprecation program: signals, telemetry, burn-down</text>
  <rect x="30" y="62" width="140" height="76" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="100" y="86" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client</text>
  <text x="100" y="106" text-anchor="middle" fill="#1e293b" font-size="10">reads customerId</text>
  <text x="100" y="124" text-anchor="middle" fill="#1e293b" font-size="10">key ak_7731</text>
  <rect x="205" y="52" width="170" height="96" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="290" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">API + presenter</text>
  <text x="290" y="96" text-anchor="middle" fill="#1e293b" font-size="10">emits BOTH keys</text>
  <text x="290" y="113" text-anchor="middle" fill="#1e293b" font-size="10">Deprecation: @1735603200</text>
  <text x="290" y="130" text-anchor="middle" fill="#1e293b" font-size="10">Sunset: 31 Dec 2025</text>
  <rect x="410" y="52" width="160" height="96" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="490" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Usage counter</text>
  <text x="490" y="96" text-anchor="middle" fill="#1e293b" font-size="10">deprecated_field</text>
  <text x="490" y="112" text-anchor="middle" fill="#1e293b" font-size="10">_reads_total</text>
  <text x="490" y="130" text-anchor="middle" fill="#1e293b" font-size="10">{field, api_key}</text>
  <rect x="605" y="52" width="145" height="96" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="677" y="76" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Burn-down</text>
  <text x="677" y="96" text-anchor="middle" fill="#1e293b" font-size="10">weekly review</text>
  <text x="677" y="112" text-anchor="middle" fill="#1e293b" font-size="10">targeted emails</text>
  <text x="677" y="130" text-anchor="middle" fill="#1e293b" font-size="10">gate on removal</text>
  <path d="M170 100 L201 100" stroke="#0ea5e9" stroke-width="2" fill="none" marker-end="url(#b32)"/>
  <path d="M375 100 L406 100" stroke="#0ea5e9" stroke-width="2" fill="none" marker-end="url(#b32)"/>
  <path d="M570 100 L601 100" stroke="#0ea5e9" stroke-width="2" fill="none" marker-end="url(#b32)"/>
  <rect x="30" y="180" width="720" height="140" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="390" y="204" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Timeline to removal</text>
  <line x1="70" y1="240" x2="710" y2="240" stroke="#4f46e5" stroke-width="2"/>
  <circle cx="90" cy="240" r="6" fill="#4f46e5"/><text x="90" y="266" text-anchor="middle" fill="#1e293b" font-size="10">expand</text>
  <circle cx="230" cy="240" r="6" fill="#4f46e5"/><text x="230" y="266" text-anchor="middle" fill="#1e293b" font-size="10">announce</text>
  <circle cx="380" cy="240" r="6" fill="#d97706"/><text x="380" y="266" text-anchor="middle" fill="#1e293b" font-size="10">SDK ships</text>
  <circle cx="540" cy="240" r="6" fill="#d97706"/><text x="540" y="266" text-anchor="middle" fill="#1e293b" font-size="10">brownouts</text>
  <circle cx="700" cy="240" r="6" fill="#16a34a"/><text x="700" y="266" text-anchor="middle" fill="#1e293b" font-size="10">contract</text>
  <text x="90" y="226" text-anchor="middle" fill="#1e293b" font-size="9">day 0</text>
  <text x="230" y="226" text-anchor="middle" fill="#1e293b" font-size="9">week 2</text>
  <text x="380" y="226" text-anchor="middle" fill="#1e293b" font-size="9">month 1</text>
  <text x="540" y="226" text-anchor="middle" fill="#1e293b" font-size="9">month 10</text>
  <text x="700" y="226" text-anchor="middle" fill="#1e293b" font-size="9">month 12</text>
  <text x="390" y="296" text-anchor="middle" fill="#1e293b" font-size="11">Removal is gated on measured usage, not on the calendar alone.</text>
</svg>
```

## 5. Implementation

### 5.1 Deprecation signalling on the wire

A live-but-deprecated endpoint. `Deprecation` carries an IMF-fixdate as a structured-field date; `Sunset` is an HTTP-date:

```http
GET /v1/customers/cus_301 HTTP/1.1
Host: api.acme.dev
Authorization: Bearer sk_live_9f2c...

HTTP/1.1 200 OK
Content-Type: application/json
Deprecation: @1735603200
Sunset: Wed, 31 Dec 2025 23:59:59 GMT
Link: <https://docs.acme.dev/changelog/customer-id-rename>; rel="deprecation"
Link: <https://docs.acme.dev/policy/sunset>; rel="sunset"
Warning: 299 - "customerId is deprecated; use customer_id. Removal 2025-12-31."

{ "customerId": "cus_301", "customer_id": "cus_301",
  "email": "dana@example.com", "created_at": "2024-03-11T09:12:44Z" }
```

After the sunset date the endpoint is `410 Gone` with a Problem Details body (RFC 9457) — never `404`, and never a silent `200` with a null field:

```http
HTTP/1.1 410 Gone
Content-Type: application/problem+json
Link: <https://docs.acme.dev/changelog/customer-id-rename>; rel="deprecation"

{ "type": "https://api.acme.dev/problems/endpoint-removed",
  "title": "Endpoint removed",
  "status": 410,
  "detail": "GET /v1/customers was removed on 2025-12-31. Use GET /v2/customers.",
  "instance": "/v1/customers/cus_301" }
```

### 5.2 Accepting both shapes on the write path

The request side of expand: accept the old key, prefer the new, and never silently drop data.

```http
PATCH /v1/orders/ord_8812 HTTP/1.1
Content-Type: application/merge-patch+json

{ "customerId": "cus_301" }

HTTP/1.1 200 OK
Deprecation: @1735603200
Warning: 299 - "Request field customerId is deprecated; send customer_id."
```

If both keys arrive with *conflicting* values, that is a genuine client bug — fail loudly rather than guess:

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{ "type": "https://api.acme.dev/problems/conflicting-aliases",
  "title": "Conflicting field aliases", "status": 422,
  "detail": "customerId and customer_id were both supplied with different values.",
  "errors": [{ "pointer": "/customerId", "code": "alias_conflict" }] }
```

### 5.3 FastAPI: aliasing, dual-emit, and usage counters

```python
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, model_validator
from prometheus_client import Counter

DEPRECATED_READS = Counter("deprecated_field_reads_total", "", ["field", "api_key"])
DEPRECATED_WRITES = Counter("deprecated_field_writes_total", "", ["field", "api_key"])
SUNSET = datetime(2025, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
DEPRECATED_AT = datetime(2024, 12, 31, tzinfo=timezone.utc)

class OrderPatch(BaseModel):
    customer_id: str | None = None
    customerId_legacy: str | None = Field(default=None, alias="customerId")

    @model_validator(mode="after")
    def reconcile(self):
        legacy = self.customerId_legacy
        if legacy is not None and self.customer_id is not None and legacy != self.customer_id:
            raise ValueError("customerId and customer_id conflict")
        self.customer_id = self.customer_id or legacy      # new wins, old accepted
        return self

def mark_deprecated(response: Response, guide: str) -> None:
    response.headers["Deprecation"] = f"@{int(DEPRECATED_AT.timestamp())}"
    response.headers["Sunset"] = SUNSET.strftime("%a, %d %b %Y %H:%M:%S GMT")
    response.headers["Link"] = f'<{guide}>; rel="deprecation"'

router = APIRouter()

@router.patch("/orders/{order_id}")
async def patch_order(order_id: str, body: OrderPatch, request: Request, response: Response):
    key = request.state.api_key_id
    if body.customerId_legacy is not None:
        DEPRECATED_WRITES.labels("customerId", key).inc()
        mark_deprecated(response, "https://docs.acme.dev/changelog/customer-id-rename")
    order = await store.patch_order(order_id, customer_id=body.customer_id)
    if order is None:
        raise HTTPException(404, "Order not found")
    DEPRECATED_READS.labels("customerId", key).inc()        # upper bound on real reads
    return {**order, "customerId": order["customer_id"]}    # dual-emit during expand
```

### 5.4 Express middleware that hard-fails on breaking drift

The only reliable guard is a machine check in CI, not a review checklist. Diff the live OpenAPI document against the previous release and fail the build on any breaking delta:

```bash
# oasdiff exits non-zero when a breaking change is detected
oasdiff breaking --fail-on ERR \
  https://api.acme.dev/openapi.json ./build/openapi.json
```

```javascript
// Express: attach deprecation metadata declaratively per route.
const DEPRECATIONS = {
  'GET /v1/customers/:id': {
    since: '@1735603200',
    sunset: 'Wed, 31 Dec 2025 23:59:59 GMT',
    guide: 'https://docs.acme.dev/changelog/customer-id-rename',
  },
};

app.use((req, res, next) => {
  const meta = DEPRECATIONS[`${req.method} ${req.route?.path ?? req.path}`];
  if (!meta) return next();
  res.set('Deprecation', meta.since);
  res.set('Sunset', meta.sunset);
  res.append('Link', `<${meta.guide}>; rel="deprecation"`);
  metrics.deprecatedRequests.inc({ route: req.path, key: req.apiKeyId });
  if (isBrownoutWindow(new Date())) {          // scheduled 410 to smoke out clients
    return res.status(410).type('application/problem+json').json({
      type: 'https://api.acme.dev/problems/brownout',
      title: 'Scheduled deprecation brownout', status: 410, detail: meta.guide,
    });
  }
  next();
});
```

### 5.5 Marking deprecation in OpenAPI 3.1

```yaml
paths:
  /customers/{id}:
    get:
      deprecated: true
      summary: Get a customer (deprecated — use /v2/customers/{id})
      responses:
        "200":
          description: Customer.
          headers:
            Sunset: { schema: { type: string }, description: RFC 8594 sunset date }
          content:
            application/json: { schema: { $ref: "#/components/schemas/Customer" } }
components:
  schemas:
    Customer:
      type: object
      required: [customer_id, email]
      properties:
        customer_id: { type: string }
        customerId:
          type: string
          deprecated: true
          description: Removed 2025-12-31. Use customer_id.
```

> **Optimization note:** Dual-emitting doubles neither storage nor compute, but it does inflate payloads — for a hot list endpoint returning 200 items with six aliased fields, that is real bandwidth. Emit aliases only for the shapes that are actually consumed: gate dual-emit on a per-API-key flag set from your usage telemetry, so keys that have already migrated receive the lean payload. This also converts your burn-down into a live experiment — flip a key to lean, watch its error rate, flip back if it breaks.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| **Additive-only evolution** | Zero client breakage; no version cut; no migration campaign | Schema accretes forever; naming mistakes become permanent; payloads grow |
| **Expand/contract** | Every deploy independently safe and rollback-able | Three deploys instead of one; a long, expensive middle phase; needs telemetry to end |
| **`Deprecation`/`Sunset` headers** | Machine-readable; SDKs and gateways can warn automatically; standard | Purely advisory — nothing forces a client to read them; needs a docs program alongside |
| **Brownouts** | Finds silent integrators that ignore email; converts a cliff into a series of small, announced failures | Deliberately causes errors; needs exec buy-in and careful comms or it reads as an outage |
| **Long support windows (24 mo)** | Trust-building; enterprise procurement often requires it | Two years of dual maintenance, dual tests, and dual security review per change |
| **Field-level usage telemetry** | Turns removal from a gamble into a decision | Response-side counting over-counts; real read telemetry requires SDK cooperation |
| **Automated breaking-change detection in CI** | Catches drift before it ships; no reliance on reviewer diligence | Needs a trustworthy spec; false positives on intentional additions require an override path |
| **Aliasing both shapes on writes** | Old and new clients coexist with no coordination | Ambiguity when both are sent; every downstream consumer must handle the alias |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Renaming a field in a "cleanup" PR.** A rename is a removal plus an addition — the most common accidental break in existence. → ✅ Run every schema diff through automated breaking-change detection in CI; make the build fail, not the reviewer.
2. ⚠️ **Adding a required request field.** Every existing client instantly gets `422`. → ✅ Add it optional with a default that preserves the old behaviour, migrate callers, then tighten only behind a version.
3. ⚠️ **Tightening validation "to fix bad data."** A new 40-character cap on `description` breaks every client that ever sent 60. → ✅ Log violations first, quantify who would break, then either grandfather existing callers or treat it as breaking.
4. ⚠️ **Changing units or timezones silently.** `amount` going from rupees to paise passes every schema validator and corrupts real money. → ✅ Never change semantics in place; introduce a new field (`amount_minor`) and deprecate the old one.
5. ⚠️ **Deprecating without a sunset date.** "Deprecated" with no deadline is ignored forever. → ✅ Publish `Sunset` from day one; a date can slip, but its absence guarantees nobody moves.
6. ⚠️ **Removing on the sunset date regardless of usage.** The calendar is a communication device, not a safety check. → ✅ Gate removal on measured usage plus individual outreach to every remaining caller.
7. ⚠️ **Assuming nobody uses a field because you cannot see it.** Response-side telemetry does not observe parsing. → ✅ Instrument what you can, then brownout to convert invisible usage into visible errors on *your* schedule.
8. ⚠️ **Returning `404` for a removed endpoint.** The integrator concludes they typo'd the path. → ✅ `410 Gone` plus Problem Details naming the replacement and the removal date.
9. ⚠️ **Announcing only via blog post.** Nobody reads your blog. → ✅ Per-account email with that account's own usage numbers, plus in-band headers, plus SDK deprecation warnings at runtime.
10. ⚠️ **Letting the middle phase run forever.** Ten "temporary" aliases become the permanent schema. → ✅ Give every expand a named owner and a review date; if it is not contracted on schedule, it becomes an incident-review item.
11. ⚠️ **Breaking changes in error bodies.** Clients branch on `type` URIs and `code` strings; changing them is as breaking as changing a field. → ✅ Treat the error catalogue as part of the contract, versioned and diffed like everything else.
12. ⚠️ **Silently changing default page size or sort order.** A client paginating by offset with an assumed page size silently skips records. → ✅ Defaults are contract; changing one is breaking.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

When a client reports a break, the first question is "which contract element changed and when." Keep an immutable, timestamped archive of every published OpenAPI document, tagged to the deploy that shipped it, so you can `oasdiff` any two dates in seconds. Log a per-request digest of which deprecated fields were read or written along with the API key and SDK user-agent — that single log line resolves most "you broke us" tickets, because it shows exactly what the caller sent.

### Monitoring

- `deprecated_field_reads_total{field, api_key}` and `..._writes_total` — the burn-down dataset, reviewed weekly.
- `api_errors_total{status, api_key, route}` — watch for a step change immediately after any contract deploy; alert on per-key 4xx rate, not just the global rate, because a single broken integrator disappears in the aggregate.
- `schema_validation_failures_total{field}` — sudden spikes here mean a semantic drift you did not classify as breaking.
- Brownout dashboards: requests served vs `410`ed during each window, by key, so you know exactly who noticed.
- Alert on **new** API keys adopting a deprecated field — that means your docs still recommend it somewhere.

### Security

Some breaking changes are non-negotiable. If a field leaks PII, or an authorization check was wrong, you remove or redact it immediately in every live shape and treat the support window as void. Document the exception publicly. The inverse also matters: during the expand phase, a legacy alias is a second code path that can bypass newer authorization or redaction logic, so apply access control in the shared core and let presenters do nothing but rename.

### Performance & Scaling

The dominant scaling cost of compatibility is **test matrix growth**: every live alias multiplies contract-test permutations. Keep the matrix bounded by expiring aliases on schedule and by generating conformance tests from the spec rather than hand-writing them. On the data plane, gate dual-emit per key so migrated clients get lean payloads. Finally, decouple storage from the wire: an expand/contract on the database (add column, dual-write, backfill, switch reads, drop column) should be invisible at the HTTP layer, and it is only invisible if a mapping layer stands between them.

## 9. Interview Questions

**Q: Give three changes people think are safe but are actually breaking.**
A: Tightening validation (a new max length), changing a default (page size, sort order), and adding a value to an enum clients treat as closed. All three pass a naive schema diff yet change what a conforming client observes. Changing units or precision in place is a fourth and the most dangerous, because no validator catches it.

**Q: What is expand/contract and why does it make migrations safe?**
A: You split one breaking change into three non-breaking deploys — add the new form alongside the old, migrate readers and writers, then remove the old. The middle state satisfies both the old and new contracts, so no single deploy can break a client. The only risky moment is contract, and by then telemetry proves nobody depends on the old form.

**Q: What do the `Deprecation` and `Sunset` headers do, and are they the same thing?**
A: No. `Sunset` (RFC 8594) is an HTTP-date naming when the resource stops working. `Deprecation` (RFC 9745) states that it is deprecated *now* and should not be adopted. A resource can be deprecated without a scheduled sunset, or sunset without deprecation. Both should be paired with `Link` relations to the migration guide and the policy.

**Q: How do you decide it is safe to remove a deprecated field?**
A: Measured usage plus outreach. Instrument reads and writes per API key, publish a weekly burn-down, email every remaining caller with their own numbers, and run escalating brownouts to surface clients that ignore email. Remove when usage is effectively zero and every remaining caller has been contacted individually — not simply because the date arrived.

**Q: A client says your change broke them, but you only added a field. What happened?**
A: Almost certainly a non-tolerant reader — a strict schema validator with `additionalProperties: false`, a code-generated model that throws on unknown keys, or a fixed-size buffer. Confirm from your request logs and the SDK user-agent. The fix is theirs, but the lesson is yours: publish the tolerant-reader contract prominently and ship SDKs that enforce it by default.

**Q: What is a brownout and when would you run one?**
A: A scheduled, announced window during which a deprecated surface returns `410` instead of serving. You run it in the final weeks before sunset, ramping from a few minutes to an hour, to convert invisible usage into visible errors while you are watching and can roll back. It is the only reliable way to find integrators who never read your email.

**Q: How do you enforce compatibility rules so they do not depend on reviewer attention?**
A: Generate an OpenAPI document from the running service, archive it per release, and run a breaking-change differ (oasdiff, openapi-diff) in CI with a hard fail. Pair it with consumer-driven contract tests so real consumer expectations are checked, not just the schema shape. Reviewers catch intent; machines catch drift.

**Q: (Senior) Design a deprecation program for an API with 5,000 integrators and a 24-month support window.**
A: Build a deprecation registry as data — each entry naming the element, replacement, deprecation date, sunset date, owner, and migration guide — and generate everything from it: response headers, OpenAPI `deprecated` flags, docs banners, the public calendar, and per-key usage dashboards. Automate per-account emails from that registry joined against usage. Schedule brownouts in the final quarter, gate removal on a usage threshold approved by a named owner, and treat any unremoved entry past its date as an incident-review item so the middle phase cannot become permanent.

**Q: (Senior) How does API compatibility interact with database schema migration?**
A: Both use expand/contract, but they must be decoupled by a mapping layer or a storage change becomes a wire-visible break. The storage sequence is add column → dual-write → backfill → switch reads → drop column; the wire sequence is add field → dual-emit → migrate clients → remove field. They run on completely different clocks — storage in days, wire in months — and coupling them means your database migration is hostage to your slowest integrator.

**Q: (Senior) When would you deliberately ship a breaking change with no migration period?**
A: Security and legal compulsion. If a response leaks PII, or an authorization bug lets one tenant read another's data, or a regulator orders a data element removed, you fix it immediately in every live shape, notify affected integrators, and document the exception. The support window is a promise about *your* convenience, not a licence to keep exposing user data.

**Q: How do you communicate a deprecation so it actually lands?**
A: Multi-channel, personalised, and repeated: in-band response headers, runtime warnings in the SDK, a per-account email containing that account's own call volume and a concrete code diff, dashboard banners in the developer portal, and a changelog entry with a machine-readable feed. Generic announcements are ignored; a message that says "your key ak_7731 made 41,208 calls to this endpoint last week" is not.

**Q: Is adding a new value to an existing enum a breaking change?**
A: It depends entirely on what you documented. If you published from day one that the set is open and specified fallback behaviour for unknown values, it is additive. If you did not, existing clients may have exhaustive switches or strict validators, and adding a value is breaking regardless of your intent. Retrofitting the tolerance rule does not retrofit it onto already-deployed clients.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A change is breaking if any conforming client's observable behaviour changes — including validation tightening, default changes, unit changes and error-code changes, none of which a naive diff catches. Prefer additive evolution; when you must break, use expand/contract: add the new form, dual-emit and dual-accept, migrate clients with telemetry and personalised outreach, then remove. Signal with `Deprecation` (RFC 9745) and `Sunset` (RFC 8594) plus `Link` relations, mark `deprecated: true` in OpenAPI, and return `410 Gone` with Problem Details after removal. Instrument `deprecated_field_reads_total{field, api_key}`, publish a weekly burn-down, run escalating brownouts in the final weeks, and gate removal on measured usage rather than the calendar. Enforce all of it with an automated breaking-change differ in CI, because reviewer diligence does not scale.

| Signal | Value |
| --- | --- |
| Deprecated now | `Deprecation: @1735603200` (RFC 9745) |
| Stops working on | `Sunset: Wed, 31 Dec 2025 23:59:59 GMT` (RFC 8594) |
| Migration guide | `Link: <https://docs/...>; rel="deprecation"` |
| Policy page | `Link: <https://docs/...>; rel="sunset"` |
| In-band human warning | `Warning: 299 - "..."` |
| Removed endpoint | `410 Gone` + `application/problem+json` |
| Conflicting aliases sent | `422 Unprocessable Content` |
| OpenAPI marker | `deprecated: true` on operation or property |
| Safe | new optional request field, new response field, new endpoint, relaxed validation |
| Breaking | rename, removal, new required field, tightened validation, changed default/unit/error code |

**Flash cards**

- **The one-sentence test for a breaking change?** → Can any conforming client observe a difference? If yes, it is breaking.
- **The three phases of parallel change?** → Expand (add new, keep old), migrate (telemetry + outreach), contract (remove old).
- **`Deprecation` vs `Sunset`?** → `Deprecation` = it is discouraged now; `Sunset` = the date it stops working. Independent headers.
- **Status code for a removed endpoint?** → `410 Gone` with Problem Details naming the replacement — never `404`.
- **What gates removal?** → Measured per-key usage near zero plus individual outreach, not the calendar date alone.

## 11. Hands-On Exercises & Mini Project

- [ ] Take a real API response you own and write down ten changes you might want to make. Classify each as safe or breaking using the observability test, then check your answers against Google AIP-180.
- [ ] Implement a full expand for one field rename: dual-emit on read, alias on write, `422` on conflicting aliases, and a `deprecated_field_writes_total` counter labelled by API key.
- [ ] Wire `oasdiff breaking --fail-on ERR` into CI against the previously released spec. Deliberately rename a field and confirm the build fails; add a new optional field and confirm it passes.
- [ ] Build brownout middleware driven by a cron expression, verify it returns `410` with Problem Details inside the window, and emit a metric distinguishing served from brownout-ed requests.
- [ ] Write a tolerant-reader test suite for one of your own clients: unknown fields, unknown enum values, reordered keys, an unexpected `202`. Fix whatever breaks.

### Mini Project — a deprecation registry service

**Goal.** Make deprecation a data-driven program rather than a series of heroic one-offs.

**Requirements.**
1. `deprecations.yaml` as the single source of truth: element (endpoint, field, version), replacement, `deprecated_at`, `sunset_at`, owner, migration-guide URL.
2. Middleware that reads the registry and automatically attaches `Deprecation`, `Sunset`, and `Link: rel="deprecation"` to any response touching a listed element, plus a `Warning: 299` for humans.
3. Usage telemetry: Prometheus counters labelled `{element, api_key}` for both reads and writes, with a `/metrics` endpoint.
4. A generated public deprecation calendar page and an `openapi.json` post-processor that stamps `deprecated: true` on every listed operation and property.
5. A CI job running `oasdiff breaking` against the last released spec, with an explicit allowlist file so intentional breaks require a signed-off entry.

**Extensions.**
- Add brownout scheduling per element with an escalating ramp, and a kill switch that disables all brownouts in one config change.
- Generate per-account migration emails from the registry joined against 30 days of usage, including that account's call volume and a language-specific code diff.
- Emit a weekly Slack digest naming every element past its sunset date and its owner, so the middle phase cannot quietly become permanent.

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *API Versioning Strategies* (chapter 31) covers what to do when compatibility is impossible; *OpenAPI: The Machine-Readable Contract* (chapter 33) gives you the artifact that automated diffing depends on; *Design-First & Contract Testing* (chapter 34) turns consumer expectations into executable guards; *API Documentation That Developers Love* (chapter 35) covers changelogs and migration guides; *Testing REST APIs* (chapter 36) covers the conformance suites that keep the matrix honest.

- **RFC 8594 — The Sunset HTTP Header Field** — IETF · *Beginner* · defines the `Sunset` header and the `sunset` link relation used throughout this chapter; short enough to read in one sitting. <https://www.rfc-editor.org/rfc/rfc8594.html>
- **RFC 9745 — The Deprecation HTTP Response Header Field** — IETF · *Beginner* · the modern, standards-track definition of `Deprecation`, including its structured-field date syntax and its relationship to `Sunset`. <https://www.rfc-editor.org/rfc/rfc9745.html>
- **RFC 9457 — Problem Details for HTTP APIs** — IETF · *Beginner* · the error format for `410` and `422` responses shown above; obsoletes RFC 7807. <https://www.rfc-editor.org/rfc/rfc9457.html>
- **AIP-180: Backwards Compatibility** — Google · *Advanced* · the most exhaustive public catalogue of what breaks and what does not, with the reasoning behind each ruling. <https://google.aip.dev/180>
- **ParallelChange** — Martin Fowler · *Intermediate* · the original articulation of expand/migrate/contract, the pattern this entire chapter is built on. <https://martinfowler.com/bliki/ParallelChange.html>
- **Zalando RESTful API Guidelines — Deprecation** — Zalando · *Intermediate* · concrete MUST/SHOULD rules for announcing, monitoring, and removing deprecated API elements, including obligations on both provider and consumer. <https://opensource.zalando.com/restful-api-guidelines/#deprecation>
- **oasdiff — OpenAPI diff and breaking-change detector** — Tufin · *Intermediate* · open-source CLI that classifies every spec delta as breaking or not; the tool behind the CI gate in §5.4. <https://github.com/oasdiff/oasdiff>
- **Stripe API Upgrades log** — Stripe · *Intermediate* · a decade of real, small, well-communicated breaking changes; read it as a worked example of how granular a change should be. <https://docs.stripe.com/upgrades>

---

*REST API Handbook — chapter 32.*
