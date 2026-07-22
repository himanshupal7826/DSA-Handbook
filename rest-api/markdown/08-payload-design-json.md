# 08 · Request & Response Payload Design

> **In one line:** A JSON payload is a schema contract you will be living with for years — the decisions about envelopes, money, dates, IDs and nullability are cheap on day one and nearly irreversible on day four hundred.

---

## 1. Overview

The **payload** is the message body of an HTTP request or response — for the overwhelming majority of REST APIs, a JSON document. It is where your domain model meets the wire. Unlike URLs and status codes, which HTTP standardises for you, the payload is entirely yours to design, which means it is also entirely yours to get wrong. And payload mistakes are the most expensive kind of API mistake, because every field you ship is a promise: renaming `amount` to `amount_minor`, or discovering that your `price: 19.99` has been silently rounding in a client's IEEE-754 float for eight months, are not fixes you can deploy on a Tuesday.

The problem payload design solves is **interoperability across time and across languages**. Your API will be consumed by a Java service with a strict deserializer that throws on unknown fields, a JavaScript front-end where `JSON.parse` turns a 19-digit ID into `9007199254740993`, a Python data pipeline that treats a naive datetime as UTC, and a Go client whose zero value for a missing boolean is `false` — indistinguishable from an explicit `false`. Good payload design anticipates all four.

JSON itself is standardised by **RFC 8259** (and ECMA-404). It is deliberately minimal: objects, arrays, strings, numbers, `true`/`false`/`null`. Notably it has **no date type, no decimal type, no integer type, and no comment syntax** — RFC 8259 §6 explicitly warns that numbers with greater magnitude or precision than an IEEE-754 double "may cause interoperability problems". Every convention in this chapter exists to fill one of those gaps. The date convention is **ISO 8601 / RFC 3339**; the money convention is minor units or decimal strings; the ID convention is opaque strings.

**Concrete example.** Stripe represents every monetary amount as an integer in the currency's minor unit — `{"amount": 2000, "currency": "usd"}` is $20.00 — and every timestamp as a Unix epoch integer. GitHub uses RFC 3339 strings (`"created_at": "2026-07-22T09:14:03Z"`) and `snake_case` keys. Twilio uses `PascalCase` in request form bodies and `snake_case` in JSON responses, a historical inconsistency it can never undo. Google's APIs use `camelCase` in JSON and represent 64-bit integers as *strings* (`"userId": "1234567890123456789"`) precisely because JavaScript cannot hold them safely. Each of these is a considered answer to the same set of gaps — and each one is now permanent.

The durable mental model: **treat the payload as a public schema with a versioning policy, not as "whatever my ORM serializes."** Every field has a type, a nullability rule, a stability guarantee and an eventual deprecation path. Design the wire format first; map your internal model onto it second.

## 2. Core Concepts

- **Representation** — the concrete serialized form of a resource's state at a point in time; a resource may have several (JSON, CSV, protobuf) selected by content negotiation.
- **Envelope** — a wrapper object around the payload (`{"data": …, "meta": …}`) versus a **bare** body where the resource is the top-level object.
- **Sparse fieldset** — a client-requested subset of fields (`?fields=id,name,total`) that reduces payload size without changing the schema.
- **Minor units** — integer representation of money in the smallest indivisible unit (paise, cents), avoiding binary floating-point entirely.
- **RFC 3339 timestamp** — the interoperable ISO 8601 profile: `2026-07-22T09:14:03.120Z`, always with an explicit offset or `Z`.
- **Opaque identifier** — a client-meaningless string ID (`inv_01JQ8Z…`) whose internal structure the API reserves the right to change.
- **Nullability tri-state** — the difference between a field that is *absent*, *present and `null`*, and *present with a value* — critical for `PATCH` semantics.
- **Tolerant reader** — a client that ignores unknown fields and does not break when the server adds one; the single most important compatibility rule (Postel's principle, applied narrowly).
- **Additive-only evolution** — the compatibility policy that new fields may be added and optional fields relaxed, but nothing may be removed, renamed, or narrowed within a major version.
- **Discriminated union** — a polymorphic object carrying an explicit `type` (or `object`) field so clients can dispatch without guessing from the shape.

## 3. Theory & Principles

**The four gaps in JSON.** Every payload convention worth arguing about traces to something JSON does not have.

1. **No decimal type.** JSON numbers are parsed as IEEE-754 doubles by nearly every runtime. `0.1 + 0.2 !== 0.3`, and money arithmetic on doubles produces off-by-a-cent errors that surface in reconciliation, not in tests. Two safe encodings exist: **integer minor units** (`{"amount_minor": 249900, "currency": "INR"}` = ₹2,499.00) or **decimal strings** (`{"amount": "2499.00"}`). Minor units are unambiguous and arithmetic-safe but require a currency-exponent table (JPY has 0 decimals, KWD has 3, per ISO 4217). Decimal strings preserve human readability and arbitrary precision but every client must parse them into a decimal type, and nothing stops a lazy client calling `parseFloat`. Pick one, **always pair the amount with a currency code**, and never emit a bare float.

2. **No integer type / no big integers.** JavaScript's `Number.MAX_SAFE_INTEGER` is 2⁵³−1 = 9,007,199,254,740,991. A Snowflake ID or a 64-bit database key exceeds it, and `JSON.parse` silently rounds. This is why Twitter's API returns both `id` and `id_str`, and why Google returns int64 as strings. **Rule: any identifier or counter that can exceed 2⁵³ must be a string on the wire.**

3. **No date type.** Always **RFC 3339** with an explicit offset: `2026-07-22T09:14:03Z`. Never a naive `"2026-07-22 09:14:03"` (ambiguous zone), never a locale format, never epoch-in-milliseconds-sometimes-seconds. Distinguish three kinds of temporal value: an **instant** (`2026-07-22T09:14:03Z`), a **calendar date** with no time (`"due_on": "2026-08-15"` — a full-date, no zone, because a due date is not an instant), and a **future civil time** which needs an IANA zone id (`{"at": "2026-11-04T09:00:00", "tz": "Asia/Kolkata"}`) because offsets change with DST law. Durations use ISO 8601 (`PT30M`) or an explicit `_seconds`/`_ms` suffix.

4. **No comments and no schema.** The document carries no self-description, so field *names* are your documentation. Use suffixed units (`timeout_ms`, `size_bytes`, `amount_minor`) — a bare `timeout: 30` has caused more outages than any single bug class deserves.

**Nullability is a tri-state.** In a `PATCH` body, `{"nickname": null}` means "clear it", `{}` means "leave it alone", and `{"nickname": "Sam"}` means "set it". Any framework that deserializes into a plain struct collapses the first two, which is why **JSON Merge Patch (RFC 7396)** defines `null` as *delete* and **JSON Patch (RFC 6902)** avoids the ambiguity entirely with explicit `add`/`remove`/`replace` ops. In *responses*, prefer omitting-vs-null consistency: pick "always emit every field, using `null` for absent" (predictable shape, larger payload, better for typed clients) or "omit null fields" (smaller, but forces every client into optional-chaining). Never mix. And **never use `null` for empty collections** — an empty array is `[]`, so clients can iterate unconditionally.

**Envelope or not.** A bare body (`{"id": "inv_1", "total": 100}`) is simpler, works directly with `Content-Location`, and lets HTTP headers carry metadata (`ETag`, `Link`, `RateLimit-*`) where intermediaries can see them. An envelope (`{"data": …, "meta": …, "links": …}`) gives you one stable place for pagination cursors and warnings, and makes collection and single-item responses structurally uniform — which is why JSON:API mandates it. The honest trade-off: **envelopes buy uniformity at the cost of one extra unwrap in every client and a tendency to smuggle metadata into the body that belongs in headers.** For a public API consumed by generated SDKs, a light envelope on collections only (`{"data": [...], "next_cursor": "..."}`) with bare single resources is the pragmatic middle.

**Compatibility as a formal property.** Within a major version, changes must be **backward compatible for clients**: you may add an optional field, add an enum value *only if clients were told to tolerate unknowns*, relax a constraint, or make a required request field optional. You may not remove or rename a field, change its type, narrow a range, or change a default. Note the asymmetry — adding an enum value is a *breaking* change for a client with a strict `switch`, which is why every good style guide tells clients to have a default branch and tells servers to document that new values may appear.

```svg
<svg viewBox="0 0 760 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="740" height="330" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">The four gaps in JSON and their safe encodings</text>
  <rect x="30" y="58" width="340" height="128" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="50" y="82" fill="#1e293b" font-size="13" font-weight="700">Gap 1 &#183; no decimal type</text>
  <text x="50" y="104" fill="#b91c1c" font-size="12">unsafe: "price": 19.99</text>
  <text x="50" y="124" fill="#166534" font-size="12">safe A: "amount_minor": 1999, "currency": "INR"</text>
  <text x="50" y="144" fill="#166534" font-size="12">safe B: "amount": "19.99", "currency": "INR"</text>
  <text x="50" y="168" fill="#1e293b" font-size="11">ISO 4217 exponent varies: JPY 0, INR 2, KWD 3</text>
  <rect x="390" y="58" width="340" height="128" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="410" y="82" fill="#1e293b" font-size="13" font-weight="700">Gap 2 &#183; no big integers</text>
  <text x="410" y="104" fill="#b91c1c" font-size="12">unsafe: "id": 9007199254740993</text>
  <text x="410" y="124" fill="#166534" font-size="12">safe: "id": "9007199254740993"</text>
  <text x="410" y="148" fill="#1e293b" font-size="11">JS Number.MAX_SAFE_INTEGER = 2^53 &#8722; 1</text>
  <text x="410" y="168" fill="#1e293b" font-size="11">anything above it rounds in JSON.parse</text>
  <rect x="30" y="200" width="340" height="128" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="50" y="224" fill="#1e293b" font-size="13" font-weight="700">Gap 3 &#183; no date type</text>
  <text x="50" y="246" fill="#b91c1c" font-size="12">unsafe: "2026-07-22 09:14:03"</text>
  <text x="50" y="266" fill="#166534" font-size="12">instant: "2026-07-22T09:14:03Z"</text>
  <text x="50" y="286" fill="#166534" font-size="12">calendar date: "2026-08-15"</text>
  <text x="50" y="308" fill="#166534" font-size="12">future civil: value + IANA tz id</text>
  <rect x="390" y="200" width="340" height="128" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="410" y="224" fill="#1e293b" font-size="13" font-weight="700">Gap 4 &#183; no units, no schema</text>
  <text x="410" y="246" fill="#b91c1c" font-size="12">unsafe: "timeout": 30</text>
  <text x="410" y="266" fill="#166534" font-size="12">safe: "timeout_ms": 30000</text>
  <text x="410" y="290" fill="#1e293b" font-size="11">suffix every quantity: _ms _bytes _minor _pct</text>
  <text x="410" y="310" fill="#1e293b" font-size="11">publish JSON Schema / OpenAPI alongside</text>
</svg>
```

## 4. Architecture & Workflow

The lifecycle of one payload, from a client object to a persisted row and back. Each step is a place where a payload decision either pays off or bites.

1. **Client constructs a DTO.** A typed model generated from your OpenAPI document, or hand-written. If your IDs are int64 numbers, the damage happens here, before a byte is sent.
2. **Serialize.** The client emits JSON with `Content-Type: application/json; charset=utf-8`. For `PATCH` it must choose a patch media type — `application/merge-patch+json` or `application/json-patch+json` — which determines whether `null` means "delete" or is a literal value.
3. **Transport.** `Content-Encoding: gzip` (or `br`) applies. JSON compresses extremely well because keys repeat; a 400 KB list response is typically 20–40 KB on the wire, which is why "JSON is verbose" is mostly a non-argument for compressed transports.
4. **Gateway validation.** Body size limit → `413`. Wrong media type → `415`. Malformed JSON → `400`. This happens before your handler so a hostile 500 MB body never allocates in your service.
5. **Schema validation.** JSON Schema / Pydantic validates types, ranges, enums, and required fields. Failures produce a `422` (or `400`) with a **JSON Pointer per error** (`/items/0/quantity`) so the client can attach messages to form fields.
6. **Coercion into domain types.** Strings become `Decimal`, `UUID`, `datetime`. This is the boundary where the wire format stops and the domain begins — never let an ORM entity leak straight back out.
7. **Domain execution & persistence.** The internal model may differ wildly from the representation: a `Money` value object, a `tsrange`, an enum table. Good.
8. **Serialize the response.** An explicit response schema — not `model_dump()` on the ORM object — decides exactly which fields are public. This is the single most effective defence against accidentally leaking `password_hash`, `internal_risk_score`, or another tenant's foreign key.
9. **Attach HTTP metadata.** `ETag` for concurrency, `Link` for pagination, `Cache-Control`, `Content-Location`. Metadata that intermediaries can act on belongs in headers, not in the envelope.
10. **Client deserializes tolerantly.** Unknown fields ignored, unknown enum values routed to a default branch, absent optional fields defaulted. A strict client is a client that breaks on your next additive release.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="760" height="320" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Payload lifecycle: wire model vs domain model</text>
  <rect x="30" y="58" width="150" height="72" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="105" y="82" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Client DTO</text>
  <text x="105" y="100" text-anchor="middle" fill="#1e293b" font-size="10">generated from</text>
  <text x="105" y="116" text-anchor="middle" fill="#1e293b" font-size="10">OpenAPI 3.1</text>
  <rect x="215" y="58" width="150" height="72" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="290" y="82" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">JSON on the wire</text>
  <text x="290" y="100" text-anchor="middle" fill="#1e293b" font-size="10">gzip / br encoded</text>
  <text x="290" y="116" text-anchor="middle" fill="#1e293b" font-size="10">charset=utf-8</text>
  <rect x="400" y="58" width="150" height="72" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="475" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Validation</text>
  <text x="475" y="96" text-anchor="middle" fill="#1e293b" font-size="10">413 415 400 422</text>
  <text x="475" y="112" text-anchor="middle" fill="#1e293b" font-size="10">JSON Pointer errors</text>
  <rect x="585" y="58" width="160" height="72" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="665" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Domain model</text>
  <text x="665" y="96" text-anchor="middle" fill="#1e293b" font-size="10">Money, UUID, datetime</text>
  <text x="665" y="112" text-anchor="middle" fill="#1e293b" font-size="10">never serialized directly</text>
  <path d="M180 94 L213 94" stroke="#4f46e5" stroke-width="2"/>
  <path d="M365 94 L398 94" stroke="#4f46e5" stroke-width="2"/>
  <path d="M550 94 L583 94" stroke="#4f46e5" stroke-width="2"/>
  <rect x="30" y="152" width="715" height="66" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="50" y="176" fill="#1e293b" font-size="12" font-weight="700">Response path: explicit response schema decides what is public</text>
  <text x="50" y="198" fill="#1e293b" font-size="11">domain object &#8594; response model (allow-list of fields) &#8594; JSON &#8594; headers: ETag, Link, Cache-Control, Content-Location</text>
  <rect x="30" y="236" width="350" height="80" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="50" y="260" fill="#1e293b" font-size="12" font-weight="700">Belongs in the body</text>
  <text x="50" y="280" fill="#1e293b" font-size="11">resource state, field-level errors,</text>
  <text x="50" y="298" fill="#1e293b" font-size="11">cursors clients must echo, warnings</text>
  <rect x="400" y="236" width="345" height="80" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="420" y="260" fill="#1e293b" font-size="12" font-weight="700">Belongs in headers</text>
  <text x="420" y="280" fill="#1e293b" font-size="11">ETag, Last-Modified, Cache-Control,</text>
  <text x="420" y="298" fill="#1e293b" font-size="11">Link rel=next, RateLimit-*, Retry-After</text>
</svg>
```

## 5. Implementation

A single-resource response, bare body, every convention applied:

```http
GET /v1/invoices/inv_01JQ8Z HTTP/1.1
Host: api.zariya.in
Accept: application/json
```

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
ETag: "7"
Cache-Control: private, max-age=0, must-revalidate

{
  "id": "inv_01JQ8Z",
  "object": "invoice",
  "status": "open",
  "customer": { "id": "cus_8Kq", "name": "Aarav Sharma" },
  "amount_minor": 249900,
  "currency": "INR",
  "tax_minor": 44982,
  "line_items": [
    { "id": "li_1", "description": "Annual plan", "quantity": 1, "unit_amount_minor": 249900 }
  ],
  "due_on": "2026-08-15",
  "issued_at": "2026-07-22T09:14:03.120Z",
  "paid_at": null,
  "notes": null,
  "metadata": { "campaign": "jul-26" },
  "version": 7
}
```

Note the deliberate choices: opaque string `id`; an `object` discriminator; money as integer minor units *always paired with* `currency`; `due_on` as a calendar date but `issued_at` as an instant; `paid_at: null` rather than omitted (fixed shape); `line_items: []` would be an empty array, never `null`; `metadata` as a free-form string map that is explicitly not schema-controlled; and a `version` mirroring the `ETag` for optimistic concurrency.

A collection response with a light envelope, because pagination metadata needs somewhere to live:

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Link: </v1/invoices?cursor=eyJpZCI6Imludl8wMUpROFoifQ&limit=25>; rel="next"

{
  "data": [ { "id": "inv_01JQ8Z", "object": "invoice", "amount_minor": 249900, "currency": "INR" } ],
  "has_more": true,
  "next_cursor": "eyJpZCI6Imludl8wMUpROFoifQ"
}
```

**Pydantic v2 / FastAPI** — separating the wire model from the domain model, which is the whole discipline in one file:

```python
from datetime import date, datetime
from decimal import Decimal
from enum import Enum
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, field_serializer

class Currency(str, Enum):
    INR = "INR"; USD = "USD"; JPY = "JPY"

EXPONENT = {Currency.INR: 2, Currency.USD: 2, Currency.JPY: 0}

class LineItem(BaseModel):
    id: str
    description: str
    quantity: Annotated[int, Field(ge=1, le=10_000)]
    unit_amount_minor: Annotated[int, Field(ge=0)]

class InvoiceOut(BaseModel):
    # forbid extras on INPUT models; response models are an explicit allow-list
    model_config = ConfigDict(extra="forbid")

    id: str
    object: Literal["invoice"] = "invoice"
    status: Literal["draft", "open", "paid", "void"]
    amount_minor: int
    currency: Currency
    line_items: list[LineItem] = []
    due_on: date | None = None            # calendar date, no zone
    issued_at: datetime                    # instant, always UTC
    paid_at: datetime | None = None
    metadata: dict[str, str] = {}
    version: int

    @field_serializer("issued_at", "paid_at")
    def iso_utc(self, v: datetime | None) -> str | None:
        # RFC 3339, always Z, millisecond precision
        return None if v is None else v.astimezone(tz=None).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

def to_major(amount_minor: int, ccy: Currency) -> Decimal:
    return Decimal(amount_minor).scaleb(-EXPONENT[ccy])
```

Distinguishing *absent* from *explicitly null* in a `PATCH` — the tri-state problem, solved:

```python
from pydantic import BaseModel

class InvoicePatch(BaseModel):
    notes: str | None = None
    due_on: date | None = None

@app.patch("/v1/invoices/{invoice_id}")
def patch_invoice(invoice_id: str, patch: InvoicePatch):
    # exclude_unset is the key: only fields the client actually sent
    changes = patch.model_dump(exclude_unset=True)
    # now `"notes" in changes and changes["notes"] is None` == "clear it"
    # and `"notes" not in changes`                          == "leave it alone"
    return repo.apply(invoice_id, changes)
```

The equivalent exchange, using RFC 7396 merge-patch semantics explicitly:

```http
PATCH /v1/invoices/inv_01JQ8Z HTTP/1.1
Content-Type: application/merge-patch+json
If-Match: "7"

{"notes": null, "due_on": "2026-09-01"}
```

```http
HTTP/1.1 200 OK
ETag: "8"
Content-Type: application/json

{"id":"inv_01JQ8Z","object":"invoice","notes":null,"due_on":"2026-09-01","version":8}
```

An **OpenAPI 3.1** fragment pinning the money and date conventions so generated SDKs get them right:

```yaml
components:
  schemas:
    Money:
      type: object
      required: [amount_minor, currency]
      properties:
        amount_minor:
          type: integer
          format: int64
          description: Amount in the currency's smallest unit (ISO 4217 exponent).
          examples: [249900]
        currency:
          type: string
          pattern: '^[A-Z]{3}$'
          examples: ["INR"]
    Invoice:
      type: object
      required: [id, object, status, amount_minor, currency, issued_at, version]
      properties:
        id: { type: string, examples: ["inv_01JQ8Z"] }
        object: { type: string, const: invoice }
        status:
          type: string
          enum: [draft, open, paid, void]
          description: New values may be added; clients MUST tolerate unknown values.
        issued_at: { type: string, format: date-time }
        due_on:   { type: string, format: date, nullable: true }
        version:  { type: integer, minimum: 1 }
```

Validation errors carrying JSON Pointers, so a form can highlight exact fields:

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{
  "type": "https://api.zariya.in/problems/validation-failed",
  "title": "Validation failed", "status": 422,
  "errors": [
    {"pointer": "/line_items/0/quantity", "code": "out_of_range", "message": "must be between 1 and 10000"},
    {"pointer": "/currency", "code": "unsupported", "message": "KWD is not enabled"}
  ]
}
```

**Optimization note.** Three levers, in order of impact. **(1) Compression:** JSON's repeated keys make it highly compressible — always negotiate `Content-Encoding: br` or `gzip`; expect 8–15× on list payloads. Do not "optimize" by shortening key names; compression already eliminates that cost and short keys destroy readability. **(2) Payload shape:** the real win is not emitting data at all. Support sparse fieldsets (`?fields=id,status,amount_minor`) and *never* eagerly embed a full sub-collection — an invoice with 5,000 line items inlined is an unbounded response. Cap embedded arrays and expose them as their own paginated sub-resource. **(3) Serialization cost:** at high throughput, `json.dumps` on deeply nested Pydantic models becomes measurable; use `model_dump_json()` (Rust-backed) or `orjson`, and precompute `ETag`s from a stable serialization so you can answer `If-None-Match` with a `304` without serializing at all.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Bare body (no envelope) | Simplest client code; metadata sits in headers where proxies can use it | Collection metadata (cursors, totals) has nowhere natural to go |
| Envelope (`{"data": …}`) | Uniform shape for items and collections; one place for `meta`/`links` | Extra unwrap in every client; tempts you to duplicate header data in the body |
| Money as integer minor units | Exact arithmetic; no float rounding ever | Needs an ISO 4217 exponent table; unreadable in raw logs (`249900`) |
| Money as decimal strings | Human-readable; arbitrary precision preserved | Clients may `parseFloat` it anyway, reintroducing the bug you avoided |
| IDs as opaque strings | Free to change the internal scheme; safe above 2⁵³ | No client-side ordering or range queries; slightly larger payloads |
| Always-emit-null fields | Fixed shape; typed clients and columnar consumers love it | Larger payloads; `null` and "not applicable" become indistinguishable |
| Omit-null fields | Smaller responses | Every client field access needs optional handling; shape varies per row |
| Strict input validation (`extra: forbid`) | Catches client typos immediately; prevents mass-assignment | A client sending a harmless future field gets a hard `422` |
| Embedding related objects | Fewer round trips; better for mobile | Response size grows unboundedly; cache invalidation now spans entities |
| Publishing JSON Schema / OpenAPI | Generated SDKs, contract tests, docs for free | The spec is now a second artifact that can drift from the implementation |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Money as a JSON float.** `{"price": 19.99}` becomes `19.989999999999998` in some runtimes and accumulates cents across a batch. → ✅ Integer minor units or a decimal string, **always with an explicit `currency`**, and never a bare number.
2. ⚠️ **64-bit IDs as JSON numbers.** `JSON.parse` silently rounds anything above 2⁵³−1, corrupting Snowflake and bigserial IDs in every browser client. → ✅ Emit IDs as opaque strings; if you must keep a numeric field for compatibility, ship `id_str` alongside and deprecate the numeric one.
3. ⚠️ **Naive or locale-formatted timestamps.** `"2026-07-22 09:14:03"` has no zone; `"22/07/2026"` is ambiguous between locales. → ✅ RFC 3339 with `Z` or an explicit offset for instants, bare `YYYY-MM-DD` for calendar dates, IANA zone id for future civil times.
4. ⚠️ **Serializing the ORM entity directly.** One `password_hash`, `internal_notes`, or `owner_tenant_id` leaks the first time someone adds a column. → ✅ An explicit response model that is an allow-list of public fields; add a contract test that fails on unexpected keys.
5. ⚠️ **Unbounded embedded collections.** `invoice.line_items` with 5,000 entries produces a 4 MB response and a p99 cliff. → ✅ Cap embedded arrays (e.g. first 10 + `has_more`) and expose `/invoices/{id}/line_items` as its own paginated sub-resource.
6. ⚠️ **`null` for an empty list.** Every client then needs a null check before iterating, and half of them forget. → ✅ Empty collections are `[]`; empty objects are `{}`. Reserve `null` for scalar "no value".
7. ⚠️ **Treating `PATCH` as "the fields you sent"** without distinguishing absent from `null`. Clients cannot clear a field, or accidentally clear everything. → ✅ Use `exclude_unset` semantics, declare `application/merge-patch+json` (RFC 7396), or use JSON Patch (RFC 6902) for unambiguous ops.
8. ⚠️ **Booleans where an enum belongs.** `is_active: true` cannot later express `suspended` or `pending_review`, and you end up with `is_active` plus `is_suspended` plus an impossible combination. → ✅ Model lifecycle as a `status` enum from day one and document that new values may appear.
9. ⚠️ **Quantities without units.** `timeout: 30`, `size: 1024`, `distance: 5`. Every consumer guesses, and one guesses wrong. → ✅ Suffix everything: `timeout_ms`, `size_bytes`, `distance_m`, `amount_minor`, `discount_pct`.
10. ⚠️ **Renaming a field "because the old name was wrong".** It is a breaking change no matter how obviously better the new name is. → ✅ Add the new field, emit both, mark the old one deprecated in OpenAPI with a `Sunset` date (RFC 8594), and remove it only at the next major version.
11. ⚠️ **Mixing casing conventions.** `customerId` next to `created_at` next to `TotalAmount` in one document. → ✅ Pick `snake_case` **or** `camelCase` and enforce it with a linter in CI — consistency beats whichever one you prefer.
12. ⚠️ **Free-text errors with no machine-readable code.** `{"error": "Something went wrong with the card"}` forces clients to string-match. → ✅ Stable `code` per error plus a JSON Pointer to the offending field; the human message is the *last* field, not the contract.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Log payloads with a redaction allow-list, not a deny-list — a deny-list misses the field someone added yesterday. Truncate bodies at a fixed size and record `content_length` separately so a truncated log still tells you the response was 8 MB. Keep a **golden-file test suite**: checked-in JSON fixtures for every response type, asserted byte-for-byte (modulo volatile fields), so any accidental schema change shows up as a diff in review rather than as a client incident. When a client reports "the field disappeared", first check whether your serializer omits nulls — the field did not disappear, its value became null.

**Monitoring.** Track `http.response.body.size` as a histogram per route; a p99 that grows week over week is an embedded collection quietly becoming unbounded. Track `422` rate per route *and per field pointer* — a single field dominating validation failures is usually a documentation bug, not a client bug. Emit a counter for **unknown-field rejections** on input if you use `extra: forbid`; a spike means a client is ahead of your deploy. If you publish an OpenAPI document, run a contract test in CI that validates real recorded responses against the schema, and alert on drift.

**Security.** Payloads are the primary vector for two of the OWASP API Security Top 10. **API3 — Broken Object Property Level Authorization** covers both directions: *excessive data exposure* (returning fields the caller shouldn't see, which an explicit response allow-list fixes) and **mass assignment** (accepting `role`, `is_admin`, `balance`, or `tenant_id` from the request body, which `extra: forbid` plus a separate input model fixes — never bind a request body directly onto a persistence entity). **API4 — Unrestricted Resource Consumption** is the payload-size dimension: enforce a hard body-size limit at the gateway (`413`), cap array lengths and nesting depth in the schema, and reject deeply nested documents that can blow up your parser. Also guard against **JSON parser quirks**: duplicate keys are undefined behaviour across parsers and have been used for request smuggling between a validating proxy and an origin that picks the other duplicate — reject documents with duplicate keys. Never echo raw user input back inside an HTML-rendered error, and always send `Content-Type: application/json` with `X-Content-Type-Options: nosniff` so a JSON body containing markup is never sniffed as HTML.

**Performance & scaling.** Compression is table stakes; Brotli at level 4–5 beats gzip on JSON with comparable CPU. Beyond that, the scaling lever is *not sending fields*: sparse fieldsets and cursor-paginated sub-resources both cut payload size by an order of magnitude on real workloads. For very high-throughput internal traffic, JSON's parse cost becomes the bottleneck before its size does — that is the point at which a binary content type (protobuf, CBOR) offered through content negotiation earns its complexity, while JSON stays the default for public consumers. Finally, make `ETag`s cheap: derive them from a monotonic `version` column rather than hashing the serialized body, so you can answer `If-None-Match` with a `304` after a single indexed read.

## 9. Interview Questions

**Q: Why should monetary amounts never be JSON floats?**
A: JSON numbers are parsed as IEEE-754 doubles almost everywhere, and decimal fractions like `0.1` have no exact binary representation, so arithmetic accumulates error — `0.1 + 0.2` is `0.30000000000000004`. Over a batch of line items that becomes a real off-by-a-cent reconciliation failure. Use an integer in the currency's minor unit (`249900` paise) or a decimal string, and always pair it with an ISO 4217 currency code because the exponent varies by currency.

**Q: How should timestamps be represented?**
A: RFC 3339 strings with an explicit offset or `Z` — `2026-07-22T09:14:03.120Z` — for instants. A calendar date with no time component (a due date, a birthday) should be a bare `YYYY-MM-DD` with no zone, because it is not an instant. A future civil time needs the value plus an IANA time-zone id, since UTC offsets change with daylight-saving legislation.

**Q: When would you use an envelope versus a bare response body?**
A: A bare body is simpler and lets HTTP headers carry metadata where caches and proxies can act on it. An envelope earns its keep for collections, where pagination cursors and `has_more` need somewhere to live, and for APIs that want single items and collections to have an identical shape. A common pragmatic split is bare single resources plus a light `{"data": [...], "next_cursor": …}` envelope for lists.

**Q: What's the difference between a field being absent and being `null` in a `PATCH`?**
A: Absent means "leave this field alone"; present-and-`null` means "clear this field". Collapsing the two — which most naive deserializers do — makes it impossible for a client to null out a value. Use your framework's "only fields explicitly set" mode (`exclude_unset` in Pydantic), or adopt `application/merge-patch+json` (RFC 7396), where `null` is defined as delete.

**Q: Why do Google and Twitter return 64-bit IDs as strings?**
A: JavaScript numbers are doubles, so integers above `Number.MAX_SAFE_INTEGER` (2⁵³−1) lose precision the moment `JSON.parse` touches them — the ID you get back is not the ID that was sent. Emitting them as strings preserves them exactly in every language. Twitter's `id`/`id_str` pair is the compatibility scar from learning this after launch.

**Q: What is a "tolerant reader" and why does it matter?**
A: A tolerant reader ignores fields it doesn't recognise and handles unknown enum values via a default branch instead of throwing. It matters because it is what makes additive server changes non-breaking: if clients are tolerant, you can ship new fields continuously; if they are strict, every addition is a coordinated release. Document the expectation explicitly — it's a contract on the client, not just a nicety.

**Q: Is adding a new value to an existing enum a breaking change?**
A: For the server's schema it's additive, but for a client with an exhaustive `switch` or a strict deserializer it is absolutely breaking. Treat it as breaking unless you documented from day one that new values may appear and clients must have a fallback. In practice, ship the documentation rule first, then add values.

**Q: How do you prevent mass assignment through the request payload?**
A: Never bind the request body directly onto a persistence entity. Define a separate input model containing only client-settable fields, reject unknown fields (`extra: forbid` / `additionalProperties: false`), and set privileged fields like `role`, `tenant_id`, or `balance` from the authenticated context on the server side. This is OWASP API3, and it is one of the most commonly exploited API flaws.

**Q: (Senior) How do you evolve a payload schema over years without breaking clients?**
A: Establish an explicit compatibility contract: within a major version you may add optional fields, relax constraints, and make required request fields optional; you may not remove, rename, retype, or narrow anything. Enforce it mechanically with a schema-diff check in CI against the previously released OpenAPI document, not by review discipline. For genuine renames, run both fields simultaneously, mark the old one deprecated in the spec with a `Sunset` header (RFC 8594) and a `Deprecation` date, monitor per-field usage by client id so you know who is still reading it, and remove it only after usage reaches zero or the sunset passes. Anything that cannot fit that process is what major versions are for.

**Q: (Senior) You must return an entity with a 5,000-item child collection. How do you design the payload?**
A: Do not inline it. Return a capped preview plus a link: `"line_items": {"data": [...first 10...], "has_more": true, "url": "/v1/invoices/inv_1/line_items"}`, with the sub-resource cursor-paginated. This keeps every response bounded, makes latency predictable, and lets the sub-collection be cached and authorized independently. If a client genuinely needs all 5,000 rows, that is a different use case — serve it via an async export job returning `202` plus a job resource that produces a file, rather than trying to make a synchronous JSON response scale.

**Q: (Senior) Your API returns `{"balance": 1000}` and a client reports wrong values in a different currency. What went wrong and how do you fix it without breaking anyone?**
A: The amount was shipped without a currency and, likely, without a stated unit — so `1000` is being interpreted as 1000 major units by some clients and 1000 minor units by others, and there is no way to tell from the document which is correct. The fix is additive: introduce a new, unambiguous field (`balance_minor` plus `currency`, or a nested `Money` object), emit it alongside the old field, document `balance` as deprecated with a sunset date, and instrument which client ids still read the legacy field. You cannot retroactively change the meaning of `balance`, because you cannot tell which clients compensated for the ambiguity and which didn't — silently "fixing" it would break the ones that were already correct.

**Q: (Senior) Where do you draw the line between what goes in the body and what goes in HTTP headers?**
A: Anything an intermediary should be able to act on without parsing the body goes in headers: `ETag` and `Last-Modified` for validation, `Cache-Control` for freshness, `Link rel=next` for pagination, `RateLimit-*` and `Retry-After` for back-pressure, `Location` for creation and redirects, `Content-Type`/`Content-Encoding` for representation. Anything that is part of the resource's *state*, or that a client must echo back on a later request, belongs in the body. Duplicating pagination into both places is common and defensible for developer ergonomics, but the header is the authoritative one because a proxy or a `HEAD` request can see it.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** JSON gives you objects, arrays, strings, doubles, booleans and null — and nothing else, so every convention here patches a gap. Money: integer minor units (or a decimal string) plus an ISO 4217 currency, never a float. IDs: opaque strings, because anything above 2⁵³ rounds in JavaScript. Times: RFC 3339 with `Z` for instants, bare `YYYY-MM-DD` for calendar dates, value + IANA zone for future civil times. Quantities: suffix the unit (`_ms`, `_bytes`, `_minor`). Nullability: `[]` for empty lists, and in `PATCH` distinguish absent (leave alone) from `null` (clear). Shape: explicit response models, never the ORM entity; cap embedded collections; keep intermediary-relevant metadata in headers. Evolution: additive only — add, deprecate, sunset, never rename in place. And clients must be tolerant readers or none of this works.

| Concern | Do this | Not this |
|---|---|---|
| Money | `{"amount_minor": 249900, "currency": "INR"}` | `{"price": 2499.00}` |
| Large IDs | `"id": "9007199254740993"` | `"id": 9007199254740993` |
| Instant | `"issued_at": "2026-07-22T09:14:03Z"` | `"issued_at": "2026-07-22 09:14:03"` |
| Calendar date | `"due_on": "2026-08-15"` | `"due_on": "2026-08-15T00:00:00Z"` |
| Duration | `"timeout_ms": 30000` or `"PT30S"` | `"timeout": 30` |
| Empty list | `"tags": []` | `"tags": null` |
| Lifecycle | `"status": "suspended"` | `is_active` + `is_suspended` |
| Polymorphism | `"object": "invoice"` discriminator | infer the type from field presence |
| Errors | `{"pointer": "/currency", "code": "unsupported"}` | `{"error": "bad currency"}` |
| Input model | separate DTO, `additionalProperties: false` | bind body onto the ORM entity |
| Rename | add new + deprecate + `Sunset` | rename in place |

**Flash cards**

- **Why is `{"price": 19.99}` unsafe?** → JSON numbers are IEEE-754 doubles; decimal fractions are inexact and accumulate cent errors. Use minor units + currency.
- **What breaks above 2⁵³−1?** → `JSON.parse` rounds it; any int64 ID must travel as a string.
- **Absent vs `null` in `PATCH`** → absent = leave alone, `null` = clear. Use `exclude_unset` or merge-patch semantics.
- **What belongs in headers, not the body?** → `ETag`, `Cache-Control`, `Link`, `RateLimit-*`, `Retry-After`, `Location` — anything a proxy should act on.
- **How do you rename a field safely?** → You don't. Add the new one, emit both, deprecate with a `Sunset` date, remove at the next major version.

## 11. Hands-On Exercises & Mini Project

- [ ] Take a response from an API you use and audit it against this chapter: find every float-money, numeric big ID, zone-less timestamp, unit-less quantity, and `null`-for-empty-list. Write the corrected document.
- [ ] Implement a `PATCH` endpoint that correctly distinguishes absent from `null` for three fields, and write tests proving all three tri-state cases behave differently.
- [ ] Add `additionalProperties: false` to an input schema and a separate output allow-list model; then add a database column and prove via test that it does **not** leak into the response.
- [ ] Write a schema-diff CI check that compares the current OpenAPI document against the last released one and fails the build on any field removal, rename, or type change.
- [ ] Measure the payload of a list endpoint uncompressed, gzipped, and Brotli-compressed, then again with a sparse fieldset. Report the four numbers and decide where to invest.

### Mini Project — The Contract-First Invoice API

**Goal.** Build an invoicing API where the OpenAPI 3.1 document is the source of truth and every payload convention in this chapter is enforced by tests, not by review.

**Requirements.**
1. Resources: `Invoice`, `LineItem`, `Customer`. Money always as `{amount_minor, currency}` with an ISO 4217 exponent table covering INR (2), USD (2), JPY (0), KWD (3).
2. Every timestamp RFC 3339 UTC; `due_on` a calendar date; every duration suffixed `_ms` or `_seconds`.
3. IDs are prefixed opaque strings (`inv_`, `li_`, `cus_`) generated from ULIDs and never exposed as integers.
4. `PATCH` supports `application/merge-patch+json` with correct `null`-means-delete semantics, guarded by `If-Match`.
5. `line_items` embedded in `Invoice` is capped at 10 items with `has_more` and a link to the paginated sub-resource.
6. Input models reject unknown fields with a `422` carrying JSON Pointers; output models are explicit allow-lists.
7. A CI job validates 20 recorded golden-file responses against the published JSON Schema and fails on drift.

**Extensions.**
- Add sparse fieldsets (`?fields=`) and prove the response shrinks without changing the schema contract.
- Add a schema-compatibility gate: a script that diffs the OpenAPI document against `main` and blocks removals/renames.
- Add a second representation (`application/vnd.zariya.invoice+json; version=2`) that renames a field, served through content negotiation, so both contracts run simultaneously.
- Emit a `Deprecation` and `Sunset` header on any response containing a deprecated field, and add a metric counting reads of it per client id.

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Naming Conventions & API Consistency* fixes the casing and pluralisation rules these payloads assume; *HTTP Status Codes Done Right* covers the `400`/`422` split these validation errors use; *Content Negotiation & Media Types* explains the vendor media types that let two payload versions coexist; *Filtering, Sorting & Searching* covers sparse fieldsets in depth; *Versioning & Deprecation* owns the `Sunset` process; *Error Handling & Problem Details* defines the RFC 9457 body used throughout.

- **RFC 8259 — The JavaScript Object Notation (JSON) Data Interchange Format** — IETF · *Beginner* · short and normative; §6 on numbers is the source of the float and big-integer warnings. <https://www.rfc-editor.org/rfc/rfc8259.html>
- **RFC 3339 — Date and Time on the Internet: Timestamps** — IETF · *Beginner* · the interoperable ISO 8601 profile every API should use. <https://www.rfc-editor.org/rfc/rfc3339.html>
- **RFC 7396 — JSON Merge Patch** — IETF · *Intermediate* · three pages that settle the "does `null` mean delete" argument permanently. <https://www.rfc-editor.org/rfc/rfc7396.html>
- **RFC 6902 — JavaScript Object Notation (JSON) Patch** — IETF · *Intermediate* · explicit op-based patching for when merge-patch's ambiguity is unacceptable. <https://www.rfc-editor.org/rfc/rfc6902.html>
- **JSON Schema — Understanding JSON Schema** — JSON Schema Org · *Intermediate* · the best free tutorial for the validation vocabulary OpenAPI 3.1 embeds wholesale. <https://json-schema.org/understanding-json-schema>
- **Google API Design Guide — Standard Fields & Naming** — Google · *Intermediate* · why int64 becomes a string, and a battle-tested catalogue of standard field names and types. <https://cloud.google.com/apis/design/standard_fields>
- **Zalando RESTful API Guidelines — JSON Guidelines** — Zalando · *Intermediate* · numbered, enforceable rules on nulls, enums, money, dates and extensibility. <https://opensource.zalando.com/restful-api-guidelines/#json-guidelines>
- **OWASP API Security Top 10 — API3 Broken Object Property Level Authorization** — OWASP · *Intermediate* · the definitive treatment of excessive data exposure and mass assignment. <https://owasp.org/API-Security/editions/2023/en/0xa3-broken-object-property-level-authorization/>

---

*REST API Handbook — chapter 08.*
