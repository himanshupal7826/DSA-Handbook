# 17 · Validation & Input Handling

> **In one line:** Parse untrusted input into typed, constrained domain objects at the edge of your service — reject everything that does not fit with a precise `400`/`422` problem document — and never let unvalidated data reach business logic, a database, or a template.

---

## 1. Overview

Every security incident and half of every outage in an API traces back to the same sentence: *the server believed something the client said.* It believed the `Content-Length`, the JSON nesting depth, the `role` field it never intended to expose, the string that was actually 4 MB, the number that was actually a string, the timestamp with no timezone. Validation is the discipline of deciding — once, explicitly, at a single boundary — exactly what shape of input your service accepts, and rejecting everything else before a single line of domain logic runs.

The problem it solves is **trust placement**. Inside your service you want to reason about `Order(customer_id: CustomerId, items: list[Item], currency: Currency)` — a value you can rely on. Outside, you have a byte stream from an anonymous caller. Validation is the transformation between those two worlds, and it works only if it is *total*: if any path exists into your domain that skips it, the guarantees everywhere else evaporate. This is why "validate at the boundary" is a structural rule and not a style preference. The functional-programming framing is sharper still — **parse, don't validate**: do not check a `dict` and pass the same `dict` along; convert it into a type that *cannot* hold invalid data, so the compiler or the type checker enforces the invariant from then on.

Historically this was a pile of hand-written `if` statements, which failed for the reason all hand-written checks fail — they drift, they miss cases, and they never match the documentation. [JSON Schema](https://json-schema.org/) (draft 2020-12, the dialect OpenAPI 3.1 aligns with) made the constraint set declarative and shareable between server, client, docs and tests. Library ecosystems then made it ergonomic: Pydantic v2 in Python (a Rust core, fast enough to validate in the hot path), Zod in TypeScript, `jsonschema`/AJV everywhere. FastAPI's whole design thesis is that the Pydantic model *is* the validation layer, the OpenAPI schema, and the domain type simultaneously.

**Concrete example.** Stripe rejects unknown parameters outright: send `POST /v1/charges` with `amountt=500` and you get `400` with `{"error": {"type": "invalid_request_error", "code": "parameter_unknown", "param": "amountt", "message": "Received unknown parameter: amountt"}}`. That single behaviour prevents two whole classes of bug: the silent typo that makes an integration appear to work when it does not, and mass assignment, where an attacker adds `"role": "admin"` or `"balance": 999999` to a legitimate request and a permissive deserializer happily binds it. GitHub does the same on its REST API, returning `422` with `errors[].code = "invalid"` or `"missing_field"` per field. Both are saying: *the accepted input set is closed, and it is documented.*

The durable mental model: **validation is a gate that converts bytes into types.** Everything before the gate is hostile and untyped; everything after is trusted and typed. Sanitization is not part of this gate — it belongs at the *output* boundary, where you know the destination context.

## 2. Core Concepts

- **Validate at the boundary** — all untrusted input (body, query, path, headers, webhooks, message-queue payloads) is checked once at the service edge; domain code assumes valid, typed values.
- **Parse, don't validate** — produce a *new*, well-typed value rather than approving a raw dict, so the type system carries the guarantee forward.
- **Schema** — a declarative description of accepted input: types, formats, ranges, lengths, enums, required fields, and whether extra properties are allowed. JSON Schema 2020-12 is the interoperable form; OpenAPI 3.1 uses it directly.
- **`additionalProperties: false` / `extra="forbid"`** — the switch that closes the input set. Without it, unknown fields are silently accepted and mass assignment becomes possible.
- **Mass assignment (over-posting)** — an attacker supplies fields the API never meant to expose (`role`, `is_verified`, `owner_id`, `price`) and a permissive binder writes them straight to the model. OWASP API3:2023 (Broken Object Property Level Authorization).
- **Type coercion** — automatically converting `"5"` to `5` or `"yes"` to `true`. Convenient, and a source of real bugs (`"0"`, `""`, `1e999`, `NaN`, `18446744073709551616`). Prefer strict modes at API boundaries.
- **`400` vs `422`** — `400` when the request could not be understood (malformed JSON, wrong content type, bad parameter type); `422 Unprocessable Content` when it parsed fine but violates semantic rules.
- **Resource limits** — hard caps on body size, JSON nesting depth, array length, string length, number of fields and total keys, enforced *before* full parsing where possible.
- **Unicode normalization** — converting text to a canonical form (NFC for storage/display, plus NFKC for identifiers) so visually identical strings compare equal and homoglyph/spoofing tricks are constrained.
- **Output encoding** — escaping data for its destination (HTML, SQL, shell, LDAP, JSON). This is the correct place to neutralize dangerous characters; input "sanitization" is not a substitute.

## 3. Theory & Principles

### 3.1 The gate must be total, and it must be one gate

If validation lives in controllers, a background worker consuming the same message shape bypasses it. If it lives in the ORM, a bulk import bypasses it. The rule is that **every entry point deserializes through the same schema module**: HTTP handlers, queue consumers, webhook receivers, CSV importers, admin tooling. In practice this means the schemas are a shared package, and the domain layer's constructors accept only the parsed types.

A useful corollary: validation is *not* authorization. A schema decides whether `{"status": "published"}` is well-formed; only your authorization layer decides whether *this caller* may set it. Both must run, in that order, and neither substitutes for the other.

### 3.2 `400` versus `422`, precisely

[RFC 9110 §15.5.1](https://www.rfc-editor.org/rfc/rfc9110#name-400-bad-request) defines `400 Bad Request` as "the server cannot or will not process the request due to something that is perceived to be a client error (e.g., malformed request syntax…)". [RFC 9110 §15.5.21](https://www.rfc-editor.org/rfc/rfc9110#name-422-unprocessable-content) defines `422 Unprocessable Content` as the request being "well-formed" but containing content the server "was unable to process" — semantically invalid.

The working rule:

| Situation | Status | Why |
|---|---|---|
| Body is not valid JSON | `400` | Cannot parse |
| `Content-Type: text/xml` on a JSON-only endpoint | `415` | Media type unsupported |
| `Accept: application/xml` and you only produce JSON | `406` | Cannot represent |
| `?limit=abc` where an integer is required | `400` | Parameter type failure |
| Required field missing | `400` or `422` — pick one and be consistent | Both defensible; most teams use `422` alongside other field errors |
| `"quantity": -3` where `minimum: 1` | `422` | Parsed fine, violates a rule |
| `end_date` before `start_date` | `422` | Cross-field semantic rule |
| Unknown field with `extra="forbid"` | `400` | The request shape itself is wrong |
| Body larger than the limit | `413 Content Too Large` | Resource limit, not schema |
| Duplicate resource on create | `409` | State conflict, not input shape |

The most common real-world convention — and the one used throughout this handbook — is: **`400` for anything structural (unparseable, unknown fields, wrong parameter types), `422` for anything that parsed and then failed a constraint**, with all constraint failures returned together in one `errors[]` array. Consistency matters more than the exact line; document it once.

### 3.3 Type coercion is a security surface

Lenient coercion is where "obviously correct" validation goes wrong:

- `int("0x10")` conventions, `float("1e999")` → `inf`, `float("nan")` → a value that fails every comparison including `x == x`. `NaN` in a price silently defeats `if price > 0`.
- JSON numbers have no integer/float distinction and IEEE-754 doubles lose precision above 2^53. An `id` of `9007199254740993` round-trips through JavaScript as `9007199254740992`. Represent large ids and money as **strings** or integer minor units.
- `"true"`, `"1"`, `"yes"`, `"on"` all coerce to `True` under permissive parsers, and `"false"` is a non-empty string that is truthy in most languages.
- Duplicate JSON keys: `{"role":"user","role":"admin"}` is legal JSON and different parsers keep *different* ones — a classic proxy-versus-origin desync.
- Unicode digits: `"٥"` (Arabic-Indic five) passes `str.isdigit()` in Python and `int()` accepts it.

The defence is **strict mode at the boundary** (Pydantic's `strict=True` or per-field `Strict` types, Zod without `.coerce`), explicit coercion only where the transport forces it (query parameters and form fields are always strings), and rejecting `NaN`/`Infinity` — which are not even legal JSON per RFC 8259, though many parsers accept them.

### 3.4 Cost-bounding before parsing

A validator that is invoked *after* full deserialization cannot protect you from the deserialization itself. Three classic attacks:

1. **Body size** — a 2 GB body will OOM your worker before any schema runs. Cap at the server, the reverse proxy, *and* the framework; return `413`.
2. **Depth** — `[[[[[[…]]]]]]` 100,000 levels deep blows the parser's stack. Cap nesting depth (10–20 is generous for real APIs).
3. **Key/element count and "billion laughs" style expansion** — 200,000 keys in one object, or a 1 M-element array where you expected 50. Cap `maxItems`, `maxProperties`, and per-string `maxLength` — an unbounded `maxLength` on a field that gets regex-validated is also a ReDoS vector.

Also cap **regex complexity**: user input matched against a catastrophic pattern like `^(a+)+$` is CPU-exponential. Prefer simple anchored patterns, set timeouts, or use a linear-time engine (RE2).

```svg
<svg viewBox="0 0 780 370" width="100%" height="370" font-family="ui-sans-serif,system-ui,sans-serif">
<rect x="10" y="10" width="760" height="350" rx="14" fill="#f8fafc" stroke="#4f46e5"/>
<text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">The validation gate: bytes on the left, typed domain objects on the right</text>
<rect x="26" y="56" width="180" height="286" rx="10" fill="#fef3c7" stroke="#d97706"/>
<text x="116" y="80" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">UNTRUSTED</text>
<text x="40" y="104" fill="#1e293b" font-size="11">raw bytes, any size</text>
<text x="40" y="124" fill="#1e293b" font-size="11">any nesting depth</text>
<text x="40" y="144" fill="#1e293b" font-size="11">unknown fields</text>
<text x="40" y="164" fill="#1e293b" font-size="11">duplicate JSON keys</text>
<text x="40" y="184" fill="#1e293b" font-size="11">NaN, 1e999, &#34;0x10&#34;</text>
<text x="40" y="204" fill="#1e293b" font-size="11">unnormalized Unicode</text>
<text x="40" y="224" fill="#1e293b" font-size="11">&#34;role&#34;: &#34;admin&#34;</text>
<text x="40" y="244" fill="#1e293b" font-size="11">4 MB strings</text>
<text x="40" y="264" fill="#1e293b" font-size="11">naive timestamps</text>
<text x="40" y="292" fill="#d97706" font-size="11" font-weight="700">Assume every value</text>
<text x="40" y="308" fill="#d97706" font-size="11" font-weight="700">is chosen by an</text>
<text x="40" y="324" fill="#d97706" font-size="11" font-weight="700">attacker.</text>
<rect x="230" y="56" width="234" height="286" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
<text x="347" y="80" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">THE GATE (ordered)</text>
<text x="244" y="106" fill="#1e293b" font-size="11">1. Content-Type check &#8594; 415</text>
<text x="244" y="128" fill="#1e293b" font-size="11">2. Body size cap &#8594; 413</text>
<text x="244" y="150" fill="#1e293b" font-size="11">3. Parse JSON &#8594; 400</text>
<text x="244" y="172" fill="#1e293b" font-size="11">4. Depth / count caps &#8594; 400</text>
<text x="244" y="194" fill="#1e293b" font-size="11">5. Unknown fields &#8594; 400</text>
<text x="244" y="216" fill="#1e293b" font-size="11">6. Types, strict mode &#8594; 400</text>
<text x="244" y="238" fill="#1e293b" font-size="11">7. Constraints &#8594; 422</text>
<text x="244" y="260" fill="#1e293b" font-size="11">8. Cross-field rules &#8594; 422</text>
<text x="244" y="282" fill="#1e293b" font-size="11">9. Unicode NFC normalize</text>
<text x="244" y="304" fill="#1e293b" font-size="11">10. Authorization on fields</text>
<text x="244" y="328" fill="#4f46e5" font-size="11" font-weight="700">Cheapest check first.</text>
<rect x="488" y="56" width="266" height="286" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
<text x="621" y="80" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">TRUSTED DOMAIN TYPES</text>
<text x="502" y="108" fill="#1e293b" font-size="11">CreateOrder(</text>
<text x="502" y="128" fill="#1e293b" font-size="11">  customer_id: CustomerId,</text>
<text x="502" y="148" fill="#1e293b" font-size="11">  currency: Currency,</text>
<text x="502" y="168" fill="#1e293b" font-size="11">  items: list[Item]  1..50,</text>
<text x="502" y="188" fill="#1e293b" font-size="11">  ship_by: aware datetime)</text>
<text x="502" y="216" fill="#1e293b" font-size="11">Invariants hold by construction.</text>
<text x="502" y="236" fill="#1e293b" font-size="11">No defensive checks downstream.</text>
<text x="502" y="264" fill="#16a34a" font-size="11" font-weight="700">Sanitization does NOT</text>
<text x="502" y="282" fill="#16a34a" font-size="11" font-weight="700">happen here. It happens at</text>
<text x="502" y="300" fill="#16a34a" font-size="11" font-weight="700">output: HTML escaping,</text>
<text x="502" y="318" fill="#16a34a" font-size="11" font-weight="700">bound SQL parameters,</text>
<text x="502" y="336" fill="#16a34a" font-size="11" font-weight="700">argv arrays &#8212; per context.</text>
<path d="M206 199 h20 m-8 -5 l8 5 l-8 5" fill="none" stroke="#4f46e5" stroke-width="2"/>
<path d="M464 199 h20 m-8 -5 l8 5 l-8 5" fill="none" stroke="#16a34a" stroke-width="2"/>
</svg>
```

### 3.5 Why sanitization is output-encoding's job

"Sanitizing input" — stripping `<script>`, escaping quotes, removing semicolons on arrival — is one of the most persistent bad ideas in web security, for four reasons:

1. **You do not know the destination.** The same string may be rendered into HTML, an HTML attribute, a JS string, a URL, a CSV cell (`=cmd|…` formula injection), an SQL query, an LDAP filter, or a shell command. Each needs a *different* escaping. Escaping on input picks one and gets the others wrong.
2. **It corrupts legitimate data.** `O'Brien`, `Müller`, `5 < 6`, and a security researcher legitimately named with a `<` in their bio are all mangled. Stripping is lossy and irreversible.
3. **It creates double-encoding bugs.** Escape on input, escape again on output, and users see `&amp;amp;` — or worse, developers disable output escaping "because input is already clean," removing the only defence that actually works.
4. **Filters are bypassable; contextual encoding is not.** Blocklists lose to `<scr<script>ipt>`, nested encodings, and new syntax. Parameterized SQL and context-aware templating are structural defences, not pattern matching.

The correct split: **validate on input** (is this a valid email? is this length ≤ 200? is this one of these enum values?) and **encode on output** (HTML-escape when rendering, bind parameters for SQL, pass argv arrays not shell strings, `JSON.stringify` for JSON). The single exception where real *sanitization* is right is when you must accept rich HTML from users — then run a well-maintained allow-list sanitizer (DOMPurify, Bleach) at the point you accept-and-store *and* re-sanitize on render, because the HTML itself is the data.

## 4. Architecture & Workflow

The lifecycle of a `POST /v1/orders` request through the validation layer:

1. **Edge limits.** The reverse proxy or gateway enforces max body size (`client_max_body_size` in nginx), max header size, and a request timeout. Oversized requests are terminated before your process allocates anything; the client sees `413 Content Too Large`.
2. **Content negotiation.** The handler checks `Content-Type` is `application/json` (or the documented `+json` suffix) and rejects otherwise with `415 Unsupported Media Type`; it checks `Accept` and returns `406` if it cannot satisfy it. This is cheap and eliminates a class of parser confusion.
3. **Framework body cap.** A second, in-process limit (e.g. 1 MB for JSON endpoints, higher only on explicit upload routes) catches anything the proxy let through and protects you from a misconfigured proxy.
4. **Structural parse with caps.** Deserialize with depth, element-count and duplicate-key protections. A parse failure returns `400` with the byte offset if the parser reports one — never the raw exception text.
5. **Schema validation.** The Pydantic/Zod model with `extra="forbid"` runs: unknown fields, type mismatches, ranges, lengths, patterns, enums, and formats. Collect **all** errors, do not stop at the first.
6. **Normalization.** Unicode NFC on all text; trim and case-fold where documented (emails lowercased on the domain part, tags case-folded); coerce query/form strings to their declared types explicitly; convert naive timestamps to UTC-aware or reject them.
7. **Cross-field and business validation.** `start < end`, `sum(items.qty) ≤ 500`, `currency` supported for `country`. These produce `422` with pointers. Validation that needs a database read (does this SKU exist?) belongs here too, but bound how many lookups a single request can trigger.
8. **Field-level authorization.** Strip or reject fields the caller may not set — `status`, `discount_override`, `owner_id`. Prefer *reject with `403`/`422`* over silently dropping, so a client bug is visible; silently dropping is acceptable for genuinely optional server-managed fields.
9. **Construct the domain object.** From here on, the value is typed and trusted; downstream code performs no re-validation.
10. **On failure, one problem document.** Every error path renders a single RFC 9457 `application/problem+json` body with `errors[]` entries carrying an RFC 6901 JSON Pointer, a stable `code`, and constraint metadata.

```svg
<svg viewBox="0 0 780 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif">
<rect x="10" y="10" width="760" height="380" rx="14" fill="#f8fafc" stroke="#4f46e5"/>
<text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Request pipeline: fail on the cheapest check first</text>
<rect x="28" y="56" width="148" height="52" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="102" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Proxy / gateway</text>
<text x="102" y="96" text-anchor="middle" fill="#1e293b" font-size="10">size + timeout &#8594; 413</text>
<rect x="200" y="56" width="148" height="52" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="274" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Media type</text>
<text x="274" y="96" text-anchor="middle" fill="#1e293b" font-size="10">not JSON &#8594; 415</text>
<rect x="372" y="56" width="148" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="446" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Parse + caps</text>
<text x="446" y="96" text-anchor="middle" fill="#1e293b" font-size="10">bad JSON / depth &#8594; 400</text>
<rect x="544" y="56" width="208" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
<text x="648" y="78" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Schema (extra=forbid)</text>
<text x="648" y="96" text-anchor="middle" fill="#1e293b" font-size="10">unknown field &#8594; 400</text>
<path d="M176 82 h20 m-8 -4 l8 4 l-8 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
<path d="M348 82 h20 m-8 -4 l8 4 l-8 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
<path d="M520 82 h20 m-8 -4 l8 4 l-8 4" fill="none" stroke="#4f46e5" stroke-width="2"/>
<rect x="28" y="130" width="148" height="52" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="102" y="152" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Constraints</text>
<text x="102" y="170" text-anchor="middle" fill="#1e293b" font-size="10">min/max/enum &#8594; 422</text>
<rect x="200" y="130" width="148" height="52" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
<text x="274" y="152" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Normalize</text>
<text x="274" y="170" text-anchor="middle" fill="#1e293b" font-size="10">NFC, UTC, casefold</text>
<rect x="372" y="130" width="148" height="52" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="446" y="152" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Cross-field</text>
<text x="446" y="170" text-anchor="middle" fill="#1e293b" font-size="10">start &#60; end &#8594; 422</text>
<rect x="544" y="130" width="208" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
<text x="648" y="152" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Field authorization</text>
<text x="648" y="170" text-anchor="middle" fill="#1e293b" font-size="10">may you set &#34;status&#34;? &#8594; 403</text>
<rect x="28" y="204" width="724" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
<text x="44" y="226" fill="#1e293b" font-size="12" font-weight="700">Typed domain object &#8594; business logic &#8594; repository (bound parameters only)</text>
<text x="44" y="248" fill="#1e293b" font-size="11">CreateOrder(customer_id=CustomerId(&#39;cus_9&#39;), currency=Currency.INR, items=[&#8230;], ship_by=datetime(tz=UTC))</text>
<rect x="28" y="284" width="352" height="94" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
<text x="44" y="306" fill="#1e293b" font-size="12" font-weight="700">Output boundary: encode per destination</text>
<text x="44" y="326" fill="#1e293b" font-size="11">HTML render &#8594; contextual escaping</text>
<text x="44" y="344" fill="#1e293b" font-size="11">SQL &#8594; bound parameters, never string concat</text>
<text x="44" y="364" fill="#1e293b" font-size="11">shell &#8594; argv array; CSV &#8594; prefix-guard formulas</text>
<rect x="400" y="284" width="352" height="94" rx="8" fill="#fef3c7" stroke="#d97706"/>
<text x="416" y="306" fill="#1e293b" font-size="12" font-weight="700">Anti-pattern: strip tags on input</text>
<text x="416" y="326" fill="#1e293b" font-size="11">Corrupts O&#39;Brien, 5 &#60; 6, M&#252;ller.</text>
<text x="416" y="344" fill="#1e293b" font-size="11">Wrong escape for every other sink.</text>
<text x="416" y="364" fill="#1e293b" font-size="11">Bypassable; hides the real defence.</text>
</svg>
```

## 5. Implementation

### 5.1 The wire contract

```http
POST /v1/orders HTTP/1.1
Host: api.example.com
Content-Type: application/json
Content-Length: 173
Idempotency-Key: 7d3f1c5a-2b0e-4a91-9f6d-1c2e3a4b5c6d

{ "customer_id": "cus_9812", "currency": "xyz", "role": "admin",
  "ship_by": "2026-07-01",
  "items": [ { "sku": "AB-1", "qty": 0 }, { "sku": "", "qty": 4 } ] }
```

```http
HTTP/1.1 400 Bad Request
Content-Type: application/problem+json
X-Request-Id: req_01J9K2M3

{ "type": "https://api.example.com/problems/unknown-field",
  "title": "Unknown field in request body",
  "status": 400,
  "detail": "The body contains 1 field that this endpoint does not accept.",
  "errors": [ { "pointer": "/role", "code": "unknown_field",
                "detail": "'role' is not an accepted property." } ] }
```

Remove `role`, and the *semantic* failures surface together:

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{ "type": "https://api.example.com/problems/validation-failed",
  "title": "Validation failed",
  "status": 422,
  "detail": "The request body has 4 invalid fields.",
  "errors": [
    { "pointer": "/currency", "code": "enum", "detail": "Unsupported currency.",
      "allowed": ["USD", "EUR", "INR"] },
    { "pointer": "/ship_by", "code": "datetime_naive",
      "detail": "Must be RFC 3339 with an explicit UTC offset, e.g. 2026-07-01T00:00:00Z." },
    { "pointer": "/items/0/qty", "code": "greater_than_equal", "detail": "qty must be >= 1.", "min": 1 },
    { "pointer": "/items/1/sku", "code": "string_too_short", "detail": "sku must not be empty.", "min_length": 1 } ] }
```

Note that all four errors come back at once — a single round trip fixes the whole payload — and every one carries a JSON Pointer (RFC 6901), a stable `code`, and the constraint value the client needs to build its own message.

### 5.2 Pydantic v2 models that close the input set

```python
from datetime import datetime, timezone
from decimal import Decimal
from enum import StrEnum
from typing import Annotated
import unicodedata

from pydantic import (BaseModel, ConfigDict, Field, StringConstraints,
                      field_validator, model_validator)

STRICT = ConfigDict(
    extra="forbid",          # unknown fields are an error, not silently dropped
    strict=True,             # no "5" -> 5 coercion; the wire type must be right
    str_strip_whitespace=True,
    frozen=True,             # the parsed object is immutable downstream
)

Sku = Annotated[str, StringConstraints(min_length=1, max_length=32,
                                       pattern=r"^[A-Z0-9-]+$")]
Text = Annotated[str, StringConstraints(max_length=280)]

class Currency(StrEnum):
    USD = "USD"; EUR = "EUR"; INR = "INR"

class Item(BaseModel):
    model_config = STRICT
    sku: Sku
    qty: int = Field(ge=1, le=1000)
    unit_price: Decimal = Field(ge=0, max_digits=12, decimal_places=2)

class CreateOrder(BaseModel):
    model_config = STRICT

    customer_id: Annotated[str, StringConstraints(pattern=r"^cus_[A-Za-z0-9]{4,32}$")]
    currency: Currency
    items: list[Item] = Field(min_length=1, max_length=50)
    ship_by: datetime | None = None
    note: Text | None = None

    @field_validator("note", "customer_id", mode="after")
    @classmethod
    def nfc(cls, v: str | None) -> str | None:
        # Canonical composition so "e" + combining accent == the precomposed char.
        return unicodedata.normalize("NFC", v) if v is not None else None

    @field_validator("ship_by")
    @classmethod
    def aware_utc(cls, v: datetime | None) -> datetime | None:
        if v is None:
            return None
        if v.tzinfo is None:
            raise ValueError("must include an explicit UTC offset (RFC 3339)")
        return v.astimezone(timezone.utc)

    @model_validator(mode="after")
    def total_units(self):
        if sum(i.qty for i in self.items) > 500:
            raise ValueError("total quantity across items must not exceed 500")
        return self
```

Four things earn their keep here: `extra="forbid"` (closes the set and kills mass assignment), `strict=True` (no silent coercion), explicit length/range bounds on *every* string and list (cost bounding), and a timezone-aware datetime rule (naive timestamps are the single most common cross-timezone bug in APIs).

### 5.3 Wiring it into FastAPI with limits and one error shape

```python
from fastapi import FastAPI, Request, Response, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
import json

app = FastAPI()
MAX_BODY = 1 * 1024 * 1024      # 1 MiB for JSON endpoints
MAX_DEPTH = 16
BASE = "https://api.example.com/problems"

@app.middleware("http")
async def body_limits(request: Request, call_next):
    declared = request.headers.get("content-length")
    if declared and int(declared) > MAX_BODY:
        return problem(413, "payload-too-large", "Request body too large",
                       f"The body must not exceed {MAX_BODY} bytes.")
    body = await request.body()                    # Starlette already streams; cap the read
    if len(body) > MAX_BODY:                       # catches chunked bodies with no length
        return problem(413, "payload-too-large", "Request body too large",
                       f"The body must not exceed {MAX_BODY} bytes.")
    if body and depth(body) > MAX_DEPTH:
        return problem(400, "body-too-deep", "Request body nesting too deep",
                       f"JSON nesting must not exceed {MAX_DEPTH} levels.")
    return await call_next(request)

def depth(raw: bytes) -> int:
    """Bracket depth outside string literals — cheap, and it runs before json.loads."""
    d = best = 0
    in_str = esc = False
    for c in raw.decode("utf-8", "replace"):
        if esc:                      esc = False
        elif in_str:                 esc, in_str = c == "\\", c != '"'
        elif c == '"':               in_str = True
        elif c in "[{":              d += 1; best = max(best, d)
        elif c in "]}":              d -= 1
    return best

def reject_duplicate_keys(pairs):
    seen = set()
    for k, _ in pairs:
        if k in seen:
            raise ValueError(f"duplicate key: {k}")
        seen.add(k)
    return dict(pairs)   # use as json.loads(raw, object_pairs_hook=reject_duplicate_keys)

@app.exception_handler(RequestValidationError)
async def on_invalid(request: Request, exc: RequestValidationError):
    errors, unknown = [], False
    for e in exc.errors():
        loc = [str(p) for p in e["loc"] if p != "body"]
        if e["type"] == "extra_forbidden":
            unknown = True
        errors.append({"pointer": "/" + "/".join(loc), "code": e["type"],
                       "detail": e["msg"], **{k: v for k, v in (e.get("ctx") or {}).items()
                                              if isinstance(v, (int, float, str, list))}})
    # Structural problems (unknown fields, wrong wire types) are 400; constraint failures are 422.
    structural = unknown or any(e["code"].endswith("_type") for e in errors)
    code = status.HTTP_400_BAD_REQUEST if structural else status.HTTP_422_UNPROCESSABLE_ENTITY
    return problem(code, "unknown-field" if unknown else "validation-failed",
                   "Unknown field in request body" if unknown else "Validation failed",
                   f"The request body has {len(errors)} invalid field(s).", errors=errors)

def problem(status_code: int, kind: str, title: str, detail: str, **ext) -> JSONResponse:
    return JSONResponse({"type": f"{BASE}/{kind}", "title": title,
                         "status": status_code, "detail": detail, **ext},
                        status_code=status_code,
                        media_type="application/problem+json")

@app.post("/v1/orders", status_code=201)
async def create_order(payload: CreateOrder, response: Response, request: Request):
    order = orders.create(request.state.auth.tenant_id, payload)   # payload is trusted
    response.headers["Location"] = f"/v1/orders/{order.id}"
    return order.public_dict()
```

### 5.4 Query and path parameters need the same treatment

```python
from typing import Annotated, Literal
from fastapi import Path, Query

@app.get("/v1/orders")
async def list_orders(
    status_: Literal["open", "paid", "cancelled"] | None = Query(None, alias="status"),
    limit: int = Query(50, ge=1, le=100),
    q: str | None = Query(None, min_length=2, max_length=100)): ...

@app.get("/v1/orders/{order_id}")
async def get_order(order_id: Annotated[str, Path(pattern=r"^ord_[A-Za-z0-9]{4,32}$")]): ...
```

Query strings are always text on the wire, so coercion here is unavoidable — but keep it *explicit and bounded*. `Literal[...]` produces an enum in OpenAPI and rejects everything else with `400`; `ge`/`le` stop `limit=100000`; a `pattern` on path ids stops path traversal and id-format probing at the door.

### 5.5 The same schema as JSON Schema / OpenAPI 3.1

```yaml
components:
  schemas:
    CreateOrder:
      type: object
      additionalProperties: false        # the switch that closes the input set
      required: [customer_id, currency, items]
      properties:
        customer_id: { type: string, pattern: '^cus_[A-Za-z0-9]{4,32}$' }
        currency:    { type: string, enum: [USD, EUR, INR] }
        ship_by:     { type: string, format: date-time }
        note:        { type: string, maxLength: 280 }
        items:
          type: array
          minItems: 1
          maxItems: 50
          items:
            type: object
            additionalProperties: false
            required: [sku, qty, unit_price]
            properties:
              sku:        { type: string, pattern: '^[A-Z0-9-]+$', maxLength: 32 }
              qty:        { type: integer, minimum: 1, maximum: 1000 }
              unit_price: { type: string, pattern: '^\d+\.\d{2}$' }
```

OpenAPI 3.1 *is* JSON Schema 2020-12, so this exact object can drive request validation at the gateway, generate typed client SDKs, and power contract tests — one source of truth rather than three that drift. Note `unit_price` as a **string**: JSON numbers are IEEE-754 doubles and money must never round-trip through one.

### 5.6 Optimization notes

- **Order checks by cost.** Content type, then declared size, then read, then depth, then schema, then database-backed rules. Rejecting a 5 MB body at the proxy costs microseconds; rejecting it after parsing costs a CPU second and a GC pause.
- **Compile schemas once.** Pydantic v2 builds a Rust core validator per model at class-creation time; AJV compiles a JS function per schema. Never construct a model class or compile a schema per request.
- **Cap `errors[]`.** Return at most ~50 field errors — a 1 M-element array with an invalid item each would otherwise produce a response bigger than the request, which is a free amplification attack.
- **Avoid regex on unbounded strings.** Apply `maxLength` *before* the pattern, and prefer anchored, non-backtracking patterns; a catastrophic regex on a 100 KB string pins a core.
- **Skip re-validation downstream.** The point of parsing into types is that the repository and domain layers do zero defensive checks; duplicating validation costs latency and, worse, lets the two copies disagree.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Declarative schemas (Pydantic/JSON Schema) | One artifact drives validation, OpenAPI docs, SDKs and tests; no drift | Complex conditional rules get awkward in pure schema and spill into code anyway |
| `extra="forbid"` / `additionalProperties: false` | Kills mass assignment; typos fail loudly; the contract is closed | Adding a field becomes a breaking change for *senders* that already send it; complicates forward-compatible clients |
| Strict typing (no coercion) | Eliminates a whole class of `"0"`/`NaN`/precision bugs | Rejects sloppy-but-well-meaning clients; needs explicit handling for query/form strings |
| Returning all errors at once | One round trip to fix a payload; excellent DX | Extra CPU per bad request; a DoS amplifier unless the error array is capped |
| Validating at a single boundary | Domain code is simple and trustworthy; one place to audit | Every alternate entry point (workers, imports, admin) must be routed through it or the guarantee is void |
| Hard resource limits (size/depth/count) | Cheap, structural protection against parser and memory attacks | Legitimate large payloads need explicit, separately-limited endpoints (bulk, upload) |
| Field-level authorization in the gate | Prevents privilege escalation via extra properties | Couples the schema layer to the permission model; needs per-role schema variants or explicit checks |
| Output encoding rather than input sanitizing | Correct for every sink; preserves user data exactly | Requires discipline at *every* output site; one unescaped template is still an XSS |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Binding the request body straight onto an ORM model or entity**, so `{"role": "admin", "balance": 999999}` is written verbatim — classic mass assignment (OWASP API3:2023). → ✅ Validate into a dedicated input DTO with `extra="forbid"`, then copy only the fields you intend, explicitly.
2. ⚠️ **Silently dropping unknown fields.** The client's typo `amountt` looks like it works; the integration ships broken. → ✅ Reject unknown properties with `400` and name the offending pointer, as Stripe and GitHub do.
3. ⚠️ **Stopping at the first validation error**, forcing a fix-one-resubmit loop. → ✅ Collect every failure into `errors[]` with JSON Pointers, capped at a sane maximum.
4. ⚠️ **Sanitizing on input** — stripping tags or escaping quotes as data arrives. It corrupts `O'Brien`, gets the escaping wrong for every non-HTML sink, and produces double-encoding. → ✅ Validate on input; encode at output per destination (HTML escaping, bound SQL parameters, argv arrays).
5. ⚠️ **No body size or nesting limit**, so a single request OOMs a worker or overflows the parser's stack. → ✅ Cap size at the proxy *and* the framework (`413`), cap depth and element counts (`400`), and cap string lengths on every field.
6. ⚠️ **Trusting lenient coercion** — `"1e999"` becoming `inf`, `"NaN"` defeating every comparison, `"true"` from a truthy non-empty string, or a 19-digit id losing precision as a double. → ✅ Use strict mode, reject `NaN`/`Infinity`, and represent large ids and money as strings or integer minor units.
7. ⚠️ **Accepting naive timestamps** (`"2026-07-01T10:00:00"`) and assuming server-local time. → ✅ Require RFC 3339 with an explicit offset, normalize to UTC, and reject naive values with a `422` that shows the expected format.
8. ⚠️ **Validating only in the HTTP layer** while queue consumers, CSV importers and admin tools write straight to the database. → ✅ Put schemas in a shared module and make every entry point deserialize through it; make domain constructors accept only parsed types.
9. ⚠️ **Echoing raw invalid input back in the error message**, creating a reflected-XSS sink when errors are rendered in a browser and leaking PII into logs. → ✅ Report the pointer and the *rule* that failed, not the offending value; truncate and redact if you must include anything.
10. ⚠️ **Regex validation on unbounded input** with a catastrophic pattern (`^(a+)+$`), pinning a CPU core per request. → ✅ Enforce `maxLength` before the pattern, keep patterns anchored and simple, and prefer a linear-time engine or a timeout.
11. ⚠️ **Confusing validation with authorization** — assuming a well-formed `"status": "published"` means the caller may publish. → ✅ Run schema validation first, then object- and field-level authorization; neither substitutes for the other.
12. ⚠️ **Ignoring duplicate JSON keys and content-type mismatches**, letting a proxy and the origin disagree on which value is real. → ✅ Reject duplicate keys with `400`, enforce `Content-Type` with `415`, and never parse a body whose declared type you did not accept.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Log the *shape* of validation failures, never the payload: `validation_failed{route="POST /v1/orders", pointer="/items/0/qty", code="greater_than_equal"}` plus the request id. Raw bodies in logs are a PII and secret-leak incident waiting to happen (tokens, card numbers, addresses) — if you must capture samples for debugging, hash or redact and keep them in a short-retention, access-controlled store. When integrating partners report "your API rejects my request," the fastest path is a documented `type` URI per validation problem, an `allowed`/`expected` field in each error entry, and a public schema they can validate against locally. Keep a golden-file test suite of real rejected payloads (redacted) so a schema change that suddenly rejects previously-valid input shows up in CI, not in a partner's pager.

**Monitoring.** The metrics that matter: `http_requests_total{route, status, problem_type}` split so `400` and `422` are distinguishable; `validation_errors_total{route, pointer, code}` with a **bounded** pointer label (template array indices to `*`, or you get a cardinality bomb); `request_body_bytes` and `json_depth` histograms; and `413`/`415` counts, which are almost always a client or gateway misconfiguration rather than an attack. Alert on step changes per client key: a spike in `422` for one integration right after their release is a broken client, while a broad spike across all clients right after *your* release means you tightened a schema and shipped a breaking change. Track the p99 of validation time itself — if it climbs, someone added a regex or a database lookup to the hot path.

**Security.** Validation is where four OWASP API Security Top 10 (2023) risks are contained. **API3 (Broken Object Property Level Authorization)**: `extra="forbid"` plus explicit field-level permission checks stops both over-posting on the way in and over-exposure on the way out. **API4 (Unrestricted Resource Consumption)**: size, depth, array-length, string-length and regex bounds are the enforcement points. **API8 (Security Misconfiguration)**: permissive parsers, disabled schema checks in "dev mode" that reach production, and duplicate-key tolerance live here. **API10 (Unsafe Consumption of APIs)**: data from *upstream* services and webhooks is untrusted too — validate a partner's webhook body against a schema and verify its signature before parsing anything meaningful. Beyond that: never build SQL, shell commands, file paths or URLs from validated-but-unencoded input — validation says a string is *plausible*, not that it is *safe in a given syntax*; SSRF in particular needs an allow-list of destination hosts plus post-DNS-resolution IP checks, not a URL regex. And apply rate limits to endpoints that reject: credential stuffing and schema probing are made of `4xx`s.

**Performance & scaling.** Validation should be a small, flat cost — Pydantic v2's Rust core validates a typical 2 KB order model in tens of microseconds, which is noise next to a database round trip. It becomes a problem in three ways: per-request schema compilation (fix by compiling at import time), database lookups inside validators (fix by moving existence checks into the domain transaction where they belong, or batching them), and unbounded inputs that make validation cost proportional to attacker-chosen size (fix with caps). At the gateway tier, request-schema validation at the edge (Kong, Envoy, APIGee, AWS API Gateway request models) is worth it for coarse structural checks — content type, size, required fields — because it sheds junk before it consumes an application worker; keep the authoritative, detailed validation in the service, since the gateway's copy will drift.

## 9. Interview Questions

**Q: What does "validate at the boundary" mean in practice?**
A: All untrusted input is converted into typed, constrained domain objects at the single edge of the service, and everything inside assumes valid data. In practice that means one shared schema module used by HTTP handlers, queue consumers, webhook receivers and importers alike, and domain constructors that accept only parsed types — so there is no path into the core that skips the gate.

**Q: What is the difference between `400` and `422` for invalid input?**
A: `400 Bad Request` means the request could not be understood — malformed JSON, an unknown field when the schema is closed, `limit=abc`. `422 Unprocessable Content` means it parsed cleanly and then violated a semantic rule — `qty: 0` against `minimum: 1`, or `end_date` before `start_date`. Both are defensible in edge cases; the requirement is that you pick a line, document it, and apply it everywhere.

**Q: What is mass assignment and how do you prevent it?**
A: A permissive deserializer binds every field in the body onto a model, so an attacker adds `"role": "admin"` or `"balance": 999999` to an otherwise legitimate request and it is written. Prevention is a dedicated input DTO with `extra="forbid"` / `additionalProperties: false`, an explicit copy of only the intended fields onto the entity, and field-level authorization for anything privileged. It is OWASP API3:2023.

**Q: Why reject unknown fields instead of ignoring them?**
A: Ignoring them means a client typo (`amountt` instead of `amount`) silently produces the wrong behaviour and the integration ships broken; it also leaves mass assignment possible if any binder is less strict than you assume. Stripe returns `400 parameter_unknown` for exactly this reason. The cost is that adding a field is now a change senders can notice, so version and communicate it.

**Q: Why is input sanitization the wrong place to prevent XSS or SQL injection?**
A: Because the correct escaping depends on the destination — HTML body, HTML attribute, JS string, URL, SQL, shell, CSV — and you do not know it at input time. Escaping early corrupts legitimate data like `O'Brien`, causes double-encoding, and encourages disabling output escaping. The structural defences are contextual output encoding and parameterized queries; validation's job is to check that input is *plausible*, not to make it *safe*.

**Q: What limits should you enforce on a request body, and with what status codes?**
A: Maximum body size at the proxy and in the framework (`413 Content Too Large`), maximum JSON nesting depth, maximum array lengths and object key counts, and a maximum length on every string (`400`). Also enforce `Content-Type` with `415` and cap the number of returned field errors so a huge invalid array cannot amplify your response.

**Q: How should validation errors be shaped on the wire?**
A: As an RFC 9457 problem document with `Content-Type: application/problem+json`, containing `type`, `title`, `status`, `detail` and an `errors[]` extension. Each entry carries an RFC 6901 JSON Pointer (`/items/0/qty`), a stable machine `code`, a human `detail`, and the constraint metadata (`min`, `allowed`, `max_length`) the client needs to build its own message.

**Q: What is dangerous about automatic type coercion?**
A: It turns nonsense into plausible values: `"1e999"` becomes `Infinity`, `"NaN"` produces a value that fails every comparison including `>` `0` checks, `"true"`/`"1"`/`"on"` all become `True`, Unicode digits pass `isdigit()`, and JSON numbers larger than 2^53 lose precision as IEEE-754 doubles. Use strict mode at the boundary, coerce explicitly only where the transport forces strings (query and form parameters), and carry ids and money as strings or integer minor units.

**Q: (Senior) How do you tighten validation on a live API without breaking existing clients?**
A: Treat it as a breaking change and roll it out with telemetry first: add the stricter rule in *shadow mode*, where the request still succeeds but you emit a metric and a log entry labelled by client key and rule, so you learn exactly who would break. Publish the schema and a changelog, add `Deprecation`/`Sunset` headers or a warning field on affected responses, and reach out to the top offenders directly. Then enforce for new API versions or new clients first, with a per-client enforcement flag so you can flip individual integrations as they fix things, and a documented cutover date after which the flag defaults on. The same shadow-mode pattern is how you safely introduce `extra="forbid"` on an endpoint that has silently ignored unknown fields for years.

**Q: (Senior) Where does validation end and business-rule enforcement begin, and why does the boundary matter?**
A: Schema validation covers everything you can decide from the request alone — types, ranges, formats, enums, cross-field arithmetic. Business rules need state — does this SKU exist, is this customer's credit sufficient, is this state transition legal — and they must run *inside* the same transaction as the write, because anything checked before the transaction is a TOCTOU race: the SKU can be deleted between your check and your insert. So put stateless checks in the schema (fast, cacheable, no I/O, drives OpenAPI), put stateful checks in the domain service under the transaction with the appropriate isolation level or a unique constraint as the real arbiter, and map their failures to `409`/`422` problem documents. The practical smell is a validator that opens a database session — that check is in the wrong layer.

**Q: (Senior) Why does Unicode normalization matter for an API, and what are the traps?**
A: Because the same visible text has multiple byte encodings: `é` is either U+00E9 or `e` + U+0301, and without normalization they are different strings — so uniqueness constraints, lookups, and equality checks all fail unpredictably. Normalize text to **NFC** on the way in for storage and comparison. The trap is NFKC, the *compatibility* form: it is right for identifiers and search keys because it folds `ﬁ` to `fi` and full-width to ASCII, but it is lossy and destroys legitimate content, so never apply it to free text like a display name or a note. Additional traps: case-folding is locale-sensitive (Turkish dotless `ı`), normalization can change string length so it must happen *before* you enforce `maxLength`, zero-width and bidi control characters should be stripped from identifiers, and homoglyph attacks (Cyrillic `а` in `admin`) need a confusable check or a script-mixing restriction on anything security-relevant like usernames and domain labels.

**Q: (Senior) A partner reports intermittent `400`s that you cannot reproduce. How do you investigate a validation problem you cannot see?**
A: Start by making the errors self-describing: every rejection carries a request id, a stable `type` URI, and per-field `pointer`/`code`, and you log the failure *shape* (not the body) with the client key. Then look for the classic invisible causes: an intermediary rewriting or truncating the body, a `Content-Length` mismatch or chunked-encoding handling difference, a proxy that strips or mangles bracketed parameters, duplicate JSON keys where the proxy and origin disagree, character-encoding drift (a client sending latin-1 while declaring UTF-8), and clock or timezone issues producing naive or out-of-range timestamps. Compare the byte length and hash of what the client claims to send with what you received, add a temporary sampled capture of redacted rejected bodies for that client key only, and reproduce with their exact raw bytes rather than a re-serialized copy — re-serializing is what usually hides the bug.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Validation converts untrusted bytes into trusted types at **one** boundary that every entry point — HTTP, queues, webhooks, importers — goes through. Use declarative schemas (Pydantic v2, JSON Schema 2020-12, which is what OpenAPI 3.1 uses) so one artifact drives validation, docs, SDKs and tests. Turn on **`extra="forbid"` / `additionalProperties: false`** to close the input set: this stops mass assignment (OWASP API3:2023) and makes client typos fail loudly instead of silently. Use **strict typing** — no `"5"` → `5`, no `NaN`/`Infinity`, money and big ids as strings. Bound everything: body size (`413`), nesting depth, array and string lengths, and the number of errors you return. Order checks cheapest-first: content type (`415`), size (`413`), parse (`400`), unknown fields (`400`), types (`400`), constraints (`422`), cross-field rules (`422`), then field-level authorization. Return **all** failures at once in one RFC 9457 problem document with JSON Pointers and stable codes. Normalize Unicode to NFC before length checks. And remember the split: **validate on input, encode on output** — sanitizing on arrival corrupts data and defends nothing.

| Situation | Status | Notes |
|---|---|---|
| Unparseable JSON | `400` | Never echo the parser exception |
| Unknown property (closed schema) | `400` | `code: unknown_field`, name the pointer |
| Wrong wire type (`"qty": "two"`) | `400` | Strict mode; no silent coercion |
| Constraint violation (`qty: 0`) | `422` | With `min`, `allowed`, `max_length` metadata |
| Cross-field rule (`end < start`) | `422` | Pointer to the field the client should change |
| Body too large | `413` | Enforce at proxy *and* framework |
| Wrong `Content-Type` | `415` | Check before reading the body |
| Cannot produce requested `Accept` | `406` | Content negotiation, not validation |
| Duplicate resource / state conflict | `409` | State, not shape |
| Caller may not set this field | `403` or `422` | Authorization, run after schema validation |

- **Parse, don't validate** → return a typed object that cannot hold invalid data, not an approved dict.
- **`extra="forbid"`** → closes the input set; the one-line fix for mass assignment and silent typos.
- **`400` vs `422`** → couldn't understand it vs understood it and it breaks a rule.
- **Sanitization** → belongs at the output boundary, per destination context; never on input.
- **Bound everything** → size, depth, array length, string length, regex cost, error count.

## 11. Hands-On Exercises & Mini Project

- [ ] Take an existing endpoint that binds the request body onto an ORM model, introduce a strict input DTO with `extra="forbid"`, and write a test proving that `{"role": "admin"}` now returns `400` instead of escalating privileges.
- [ ] Add middleware enforcing max body size and max JSON nesting depth. Write tests for a 2 MB body (`413`), a 10,000-level nested array (`400`), and a body with duplicate keys (`400`).
- [ ] Convert your validation errors to RFC 9457 with `errors[]` carrying RFC 6901 pointers, then verify a nested failure at `/items/2/price` produces exactly that pointer and that all failures return in one response.
- [ ] Write property-based tests (Hypothesis or fast-check) that fuzz your endpoint with random JSON and assert no input ever produces a `500` — only `400`, `413`, `415` or `422`.
- [ ] Prove the Unicode trap: store `"café"` written both precomposed and decomposed, show they are unequal without normalization, then add NFC normalization *before* the `maxLength` check and show both the equality and the length behaviour change.

**Mini Project — a validation gate library.**
*Goal:* Build a reusable input layer guaranteeing that no unvalidated data can reach domain code, from any entry point.
*Requirements:* A shared schema package of strict Pydantic v2 (or Zod) models with `extra="forbid"`, explicit bounds on every string and collection, timezone-aware datetime rules, and NFC normalization. Middleware enforcing `Content-Type`, body size, nesting depth, and duplicate-key rejection with the correct status codes. A single error mapper producing RFC 9457 problem documents with pointers, stable codes and constraint metadata, capped at 50 entries. A decorator that adapts the same schemas for a queue consumer and a CSV importer. Export of the schemas as OpenAPI 3.1 / JSON Schema 2020-12, plus contract tests that validate real recorded payloads against them.
*Extensions:* Add a shadow-mode flag that logs what a stricter rule *would* reject, labelled by client key, so you can tighten schemas safely; add field-level authorization driven by scopes so privileged fields are rejected rather than silently dropped; add a Hypothesis fuzz suite asserting no `500` for any input; add a CI check that fails if any handler accepts a raw `dict`; and publish a hosted `/schemas/` directory so partners can validate locally before they send.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *Error Handling & Problem Details* (chapter 16) for the `errors[]` payload shape used throughout; *Filtering, Sorting & Searching* (chapter 12) for validating query parameters and bounding query cost; *Payload Design* (chapter 08) for representation design and why money is a string; *PUT, PATCH & JSON Patch* (chapter 14) for validating partial updates and patch documents; *OpenAPI Specification* (chapter 33) and *Design-First & Contract Testing* (chapter 34) for driving validation from the spec; *OWASP API Security* (chapter 23) for API3 and API4; *Authorization* (chapter 21) for the field-level checks that run after the schema.

**Free Learning Resources**
- **RFC 9110 §15.5 — Client Error 4xx** — IETF · *Intermediate* · the normative definitions of `400`, `413`, `415` and `422` that settle most status-code arguments. <https://www.rfc-editor.org/rfc/rfc9110#name-client-error-4xx>
- **RFC 9457 — Problem Details for HTTP APIs** — IETF · *Intermediate* · the standard error body your validation failures should use, with extension members for field errors. <https://www.rfc-editor.org/rfc/rfc9457>
- **JSON Schema — Getting Started & Reference (2020-12)** — JSON Schema org · *Beginner* · the declarative vocabulary (`additionalProperties`, `minItems`, `pattern`, `format`) that OpenAPI 3.1 adopts wholesale. <https://json-schema.org/learn/getting-started-step-by-step>
- **Pydantic v2 Documentation — Models, Strict Mode and Validators** — Pydantic · *Intermediate* · `extra`, `strict`, `Annotated` constraints and model validators, with the performance notes that matter in a hot path. <https://docs.pydantic.dev/latest/concepts/models/>
- **OWASP Cheat Sheet — Input Validation** — OWASP · *Intermediate* · the canonical statement that validation is not sanitization and why allow-lists beat blocklists. <https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html>
- **OWASP Cheat Sheet — Cross Site Scripting Prevention** — OWASP · *Intermediate* · the contextual output-encoding rules that are the real XSS defence, sink by sink. <https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html>
- **OWASP API Security Top 10 (2023)** — OWASP · *Intermediate* · API3 (Broken Object Property Level Authorization) and API4 (Unrestricted Resource Consumption) are the two risks this chapter defends against. <https://owasp.org/API-Security/editions/2023/en/0x11-t10/>
- **Parse, don't validate** — Alexis King · *Advanced* · the essay behind the mental model: encode invariants in types so invalid states are unrepresentable. <https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/>

---

*REST API Handbook — chapter 17.*
