# 33 · OpenAPI: The Machine-Readable Contract

> **In one line:** OpenAPI turns your API's contract from prose that drifts into a machine-readable document that generates docs, clients, servers, mocks and validation — and fails your build when the contract changes.

---

## 1. Overview

An API has a contract whether you write it down or not. The question is where it lives: in a wiki page someone updated in 2022, in the heads of three engineers, or in a document that machines can read. **OpenAPI** is the third option — a JSON or YAML description of every path, operation, parameter, request body, response, status code, header, and security scheme your API exposes, expressed in a standard vocabulary that hundreds of tools understand.

The problem it solves is **drift and duplication**. Without a spec, the same contract is restated in the server code, the docs site, each client SDK, the Postman collection, the mock server, and the integration tests — six places that diverge the moment anyone ships. With a spec, all six are *derived* from one artifact. A field renamed in the spec propagates to the docs, the generated clients, the request validator, and the CI breaking-change check in a single commit.

The lineage matters for reading old material. It began as **Swagger** (2011, Reverb/SmartBear); the specification was donated to the Linux Foundation in 2015 and renamed **OpenAPI**. Version 3.0 (2017) fixed the worst of 2.0's modelling limits. Version **3.1 (2021)** is the one to write today: it is fully aligned with **JSON Schema 2020-12** (3.0 used a divergent subset), adds `webhooks` as a top-level entity, allows `type` to be an array so `["string","null"]` replaces the awkward `nullable: true`, and permits path items to be `$ref`'d. "Swagger" now refers to SmartBear's tooling, not the spec.

**Concrete example.** Stripe publishes its OpenAPI document publicly, generated from internal service definitions, and drives its API reference site, its official SDKs in eight languages, and its own request validation from it. GitHub does the same and additionally ships a Postman collection generated from the spec. Twilio generates SDKs for six languages nightly. In every case, the humans write the spec (or the annotations that produce it) exactly once.

The durable mental model: **the spec is the source of truth; everything else is a build artifact.** If your docs, clients, or validators are hand-maintained beside the spec rather than generated from it, you have a spec-shaped document, not a contract.

## 2. Core Concepts

- **OpenAPI Document** — a single JSON/YAML object with `openapi`, `info`, and at least one of `paths`, `components`, or `webhooks`. May be split across files with `$ref`.
- **Path Item** — everything under one URL template (`/orders/{orderId}`): the operations available on it and any parameters shared by all of them.
- **Operation** — one HTTP method on a path item, carrying `operationId`, `summary`, `parameters`, `requestBody`, `responses`, `security` and `tags`.
- **`operationId`** — a unique, stable identifier for an operation. Code generators turn it into the SDK method name, so changing it is a breaking change to every generated client.
- **Components** — the reuse pool: `schemas`, `parameters`, `responses`, `requestBodies`, `headers`, `securitySchemes`, `examples`. Referenced with `$ref: "#/components/schemas/Order"`.
- **Schema Object** — in 3.1, a genuine **JSON Schema 2020-12** schema. `oneOf`/`anyOf`/`allOf`, `discriminator`, `const`, `pattern`, `format`, and `examples` (plural, an array) all work as JSON Schema defines them.
- **Media Type Object** — the pairing of a content type with a schema, examples and encoding, inside `requestBody.content` or a response's `content`.
- **Security Scheme** — a named authentication mechanism (`http` bearer, `apiKey`, `oauth2`, `openIdConnect`) declared in components and applied globally or per operation.
- **Webhooks** — a 3.1 top-level map describing requests *your API sends to the consumer*, keyed by event name; described exactly like an inbound operation but inverted.
- **`servers`** — the base URLs the document's paths are relative to, with optional templated variables (region, tenant, environment).
- **Bundling vs dereferencing** — bundling merges external files into one document while keeping internal `$ref`s; dereferencing inlines everything. Most tools want a bundled single file.

## 3. Theory & Principles

### 3.1 What the document actually is

An OpenAPI document is a **typed graph** with three layers. *Addressing* — `servers` + `paths` + method — answers "where do I send bytes." *Shape* — parameters, bodies, responses, headers — answers "what bytes." *Constraint* — JSON Schema — answers "which bytes are legal." The value comes from that bottom layer being a standard: because a 3.1 Schema Object *is* JSON Schema 2020-12, any conforming validator (Ajv, `jsonschema`, everit) can enforce your contract without knowing anything about OpenAPI, which is what makes runtime request/response validation cheap.

### 3.2 The 3.0 → 3.1 differences that bite

| Concern | 3.0 | 3.1 |
| --- | --- | --- |
| Schema dialect | JSON Schema Draft-04-ish subset | full JSON Schema 2020-12 |
| Nullability | `nullable: true` | `type: ["string", "null"]` |
| Examples | `example` (singular, one value) | `examples` (array) in schemas; `example`/`examples` still on media types |
| Webhooks | not modelled | top-level `webhooks` |
| `paths` | required | optional if `components` or `webhooks` present |
| `$ref` siblings | ignored | `summary`/`description` allowed alongside `$ref` |
| `exclusiveMinimum` | boolean modifier | a number, per JSON Schema |

Do not mix dialects. A document declaring `openapi: 3.1.0` while using `nullable: true` is invalid, and the failure mode is a generator silently producing a non-nullable type.

### 3.3 Generated from code, or hand-written?

- **Code-first** — annotate handlers (FastAPI, Spring, NestJS) and emit the spec. The spec cannot drift from the implementation because it *is* the implementation. But it also cannot lead: you cannot review a contract before it exists, the spec inherits your framework's modelling quirks, and descriptions tend to be thin.
- **Design-first** — write the spec by hand, review it, then generate server stubs and validate the implementation against it. The contract can be agreed before a line of code, and consumers can build against a mock on day one. The cost is a real risk of drift unless you enforce conformance in CI.

The mature answer is usually **design-first for the public surface, code-first for internal services, with a conformance test in both directions**. Chapter 34 covers this in depth.

```svg
<svg viewBox="0 0 780 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif">
  <defs><marker id="a33" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#4f46e5"/></marker></defs>
  <rect x="10" y="10" width="760" height="300" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">One document, many derived artifacts</text>
  <rect x="300" y="60" width="180" height="80" rx="12" fill="#fef3c7" stroke="#d97706"/>
  <text x="390" y="88" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">openapi.yaml</text>
  <text x="390" y="108" text-anchor="middle" fill="#1e293b" font-size="10">3.1 &#183; JSON Schema 2020-12</text>
  <text x="390" y="126" text-anchor="middle" fill="#1e293b" font-size="10">single source of truth</text>
  <rect x="30" y="180" width="130" height="66" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="95" y="206" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Reference docs</text>
  <text x="95" y="224" text-anchor="middle" fill="#1e293b" font-size="10">Redoc, Scalar</text>
  <rect x="180" y="180" width="130" height="66" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="245" y="206" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Client SDKs</text>
  <text x="245" y="224" text-anchor="middle" fill="#1e293b" font-size="10">8 languages</text>
  <rect x="330" y="180" width="130" height="66" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="395" y="206" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Server stubs</text>
  <text x="395" y="224" text-anchor="middle" fill="#1e293b" font-size="10">routes + models</text>
  <rect x="480" y="180" width="130" height="66" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="545" y="206" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Mock server</text>
  <text x="545" y="224" text-anchor="middle" fill="#1e293b" font-size="10">Prism, examples</text>
  <rect x="630" y="180" width="120" height="66" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="690" y="200" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">CI gates</text>
  <text x="690" y="218" text-anchor="middle" fill="#1e293b" font-size="10">lint + breaking</text>
  <text x="690" y="234" text-anchor="middle" fill="#1e293b" font-size="10">change diff</text>
  <path d="M340 140 L110 176" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a33)"/>
  <path d="M360 140 L255 176" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a33)"/>
  <path d="M390 140 L395 174" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a33)"/>
  <path d="M425 140 L535 176" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a33)"/>
  <path d="M450 140 L676 176" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a33)"/>
  <text x="390" y="278" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Hand-maintaining any box below the spec means you do not have a contract.</text>
  <text x="390" y="298" text-anchor="middle" fill="#1e293b" font-size="10">Runtime request/response validation reuses the same schemas &#8212; no second model.</text>
</svg>
```

## 4. Architecture & Workflow

The lifecycle of a spec in a healthy repository:

1. **Author or generate.** Either hand-write `openapi.yaml` (design-first) or emit it from annotated handlers (`GET /openapi.json` in FastAPI). Either way, one file is the input to everything downstream.
2. **Bundle.** Multi-file specs (`paths/orders.yaml`, `schemas/order.yaml`) merge into one document with `redocly bundle`, because most consumers reject external `$ref`s.
3. **Validate structurally.** `redocly lint` or `spectral lint` checks the document against the OpenAPI meta-schema *and* your own style ruleset — `operationId`s present and unique, every 4xx documented, no unnamed inline schemas, descriptions on public fields.
4. **Diff against the last release.** `oasdiff breaking --fail-on ERR` compares the candidate to the previously published document and fails the build on any breaking delta — this is where compatibility policy becomes mechanical.
5. **Generate artifacts.** Docs (Redoc/Scalar), SDKs (openapi-generator, Fern, Speakeasy), server stubs, Postman collections and a Prism mock — all in CI, all from the bundled file.
6. **Validate at runtime.** Middleware validates incoming requests and outgoing responses against the same schemas; a response violating the spec is a test failure in staging and an alert in production.
7. **Test conformance.** Integration tests replay the spec's examples against a live instance, and Schemathesis fuzzes every operation from its schema.
8. **Publish and archive.** The bundled document is served at a stable URL (`https://api.acme.dev/openapi.json`) and archived immutably per release so diffs are always possible.
9. **Feed the portal.** Docs site, changelog and SDK release notes all regenerate from the published document, so nothing downstream can describe an API that does not exist.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
  <defs><marker id="b33" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#16a34a"/></marker></defs>
  <rect x="10" y="10" width="760" height="340" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Spec pipeline in CI</text>
  <rect x="30" y="66" width="120" height="60" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="90" y="90" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">author</text>
  <text x="90" y="108" text-anchor="middle" fill="#1e293b" font-size="10">yaml or codegen</text>
  <rect x="175" y="66" width="120" height="60" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="235" y="90" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">bundle</text>
  <text x="235" y="108" text-anchor="middle" fill="#1e293b" font-size="10">redocly bundle</text>
  <rect x="320" y="66" width="120" height="60" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="90" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">lint</text>
  <text x="380" y="108" text-anchor="middle" fill="#1e293b" font-size="10">spectral rules</text>
  <rect x="465" y="66" width="130" height="60" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="530" y="90" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">breaking diff</text>
  <text x="530" y="108" text-anchor="middle" fill="#1e293b" font-size="10">oasdiff, fail ERR</text>
  <rect x="620" y="66" width="130" height="60" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="685" y="90" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">publish</text>
  <text x="685" y="108" text-anchor="middle" fill="#1e293b" font-size="10">stable URL</text>
  <path d="M150 96 L171 96" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b33)"/>
  <path d="M295 96 L316 96" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b33)"/>
  <path d="M440 96 L461 96" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b33)"/>
  <path d="M595 96 L616 96" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b33)"/>
  <rect x="60" y="180" width="150" height="66" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="135" y="206" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">SDK generation</text>
  <text x="135" y="224" text-anchor="middle" fill="#1e293b" font-size="10">per language, tagged</text>
  <rect x="240" y="180" width="150" height="66" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="315" y="206" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">mock server</text>
  <text x="315" y="224" text-anchor="middle" fill="#1e293b" font-size="10">consumers unblock</text>
  <rect x="420" y="180" width="150" height="66" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="495" y="206" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">runtime validation</text>
  <text x="495" y="224" text-anchor="middle" fill="#1e293b" font-size="10">req + resp middleware</text>
  <rect x="600" y="180" width="150" height="66" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="675" y="206" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">schema fuzzing</text>
  <text x="675" y="224" text-anchor="middle" fill="#1e293b" font-size="10">Schemathesis</text>
  <path d="M660 126 L140 176" stroke="#16a34a" stroke-width="1.5" fill="none" marker-end="url(#b33)"/>
  <path d="M665 126 L318 176" stroke="#16a34a" stroke-width="1.5" fill="none" marker-end="url(#b33)"/>
  <path d="M675 126 L496 176" stroke="#16a34a" stroke-width="1.5" fill="none" marker-end="url(#b33)"/>
  <path d="M685 130 L676 174" stroke="#16a34a" stroke-width="1.5" fill="none" marker-end="url(#b33)"/>
  <rect x="60" y="284" width="690" height="46" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="405" y="304" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Archive every published document per release &#8212; diffing needs a baseline.</text>
  <text x="405" y="322" text-anchor="middle" fill="#1e293b" font-size="10">A response that violates the spec is a bug in the server, not in the spec.</text>
</svg>
```

## 5. Implementation

### 5.1 A real OpenAPI 3.1 document

This is a complete, valid 3.1 document for a small orders API — bearer auth, pagination, idempotency, conditional requests, Problem Details errors and a webhook. It is the shape a design review should expect to see.

```yaml
openapi: 3.1.0
info:
  title: Acme Orders API
  version: "2024-06-20"
  summary: Create, read and cancel customer orders.
  description: |
    All money is expressed in minor units (paise for INR). Timestamps are RFC 3339 UTC.
    Clients MUST tolerate unknown response fields and unknown enum values.
  contact: { name: Acme API Team, url: https://docs.acme.dev, email: api@acme.dev }
  license: { name: Apache-2.0, identifier: Apache-2.0 }
servers:
  - { url: https://api.acme.dev/v2, description: Production }
  - { url: https://sandbox.acme.dev/v2, description: Sandbox (test keys only) }
tags:
  - { name: Orders, description: Order lifecycle operations. }
security: [{ bearerAuth: [] }]

paths:
  /orders:
    get:
      operationId: listOrders
      summary: List orders
      tags: [Orders]
      parameters:
        - $ref: "#/components/parameters/PageSize"
        - $ref: "#/components/parameters/PageCursor"
        - name: status
          in: query
          description: Filter by lifecycle status. Repeatable.
          style: form
          explode: true
          schema: { type: array, items: { $ref: "#/components/schemas/OrderStatus" } }
      responses:
        "200":
          description: A page of orders, newest first.
          headers:
            X-RateLimit-Remaining:
              schema: { type: integer, minimum: 0 }
              description: Requests left in the current window.
          content:
            application/json: { schema: { $ref: "#/components/schemas/OrderPage" } }
        "400": { $ref: "#/components/responses/BadRequest" }
        "401": { $ref: "#/components/responses/Unauthorized" }
        "429": { $ref: "#/components/responses/TooManyRequests" }
    post:
      operationId: createOrder
      summary: Create an order
      tags: [Orders]
      parameters:
        - $ref: "#/components/parameters/IdempotencyKey"
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/OrderCreate" }
            examples:
              minimal:
                summary: One line item
                value:
                  customer_id: cus_301
                  currency: INR
                  items: [{ sku: SKU-7781, quantity: 2, unit_amount: 129900 }]
      responses:
        "201":
          description: Order created.
          headers:
            Location:
              schema: { type: string, format: uri-reference }
              description: Canonical URI of the new order.
            ETag: { schema: { type: string } }
          content:
            application/json: { schema: { $ref: "#/components/schemas/Order" } }
        "409":
          description: Idempotency key reused with a different payload.
          content:
            application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } }
        "422": { $ref: "#/components/responses/UnprocessableContent" }

  /orders/{orderId}:
    parameters:
      - name: orderId
        in: path
        required: true
        schema: { type: string, pattern: "^ord_[A-Za-z0-9]{6,}$" }
    get:
      operationId: getOrder
      summary: Retrieve an order
      tags: [Orders]
      parameters:
        - name: If-None-Match
          in: header
          description: Conditional GET; returns 304 when the ETag still matches.
          schema: { type: string }
      responses:
        "200":
          description: The order.
          headers:
            ETag: { schema: { type: string } }
            Cache-Control: { schema: { type: string } }
          content:
            application/json: { schema: { $ref: "#/components/schemas/Order" } }
        "304": { description: Not modified. }
        "404": { $ref: "#/components/responses/NotFound" }
    delete:
      operationId: cancelOrder
      summary: Cancel an order
      description: Cancellation is asynchronous; poll the order until status is `cancelled`.
      tags: [Orders]
      parameters:
        - name: If-Match
          in: header
          required: true
          description: Optimistic concurrency. Required to prevent lost updates.
          schema: { type: string }
      responses:
        "202":
          description: Cancellation accepted.
          headers:
            Location:
              schema: { type: string, format: uri-reference }
              description: Operation resource to poll.
        "412": { $ref: "#/components/responses/PreconditionFailed" }
        "428":
          description: If-Match is required and was not supplied.
          content:
            application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } }

webhooks:
  orderShipped:
    post:
      operationId: onOrderShipped
      summary: Sent when an order ships.
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [id, type, created_at, data]
              properties:
                id: { type: string, examples: ["evt_9931"] }
                type: { const: order.shipped }
                created_at: { type: string, format: date-time }
                data: { $ref: "#/components/schemas/Order" }
      responses:
        "2XX": { description: Acknowledged. Non-2xx is retried with backoff. }

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: Secret API key or OAuth 2.0 access token.
  parameters:
    PageSize:
      name: page_size
      in: query
      description: Items per page. Server caps at 100.
      schema: { type: integer, minimum: 1, maximum: 100, default: 25 }
    PageCursor:
      name: cursor
      in: query
      description: Opaque cursor from the previous page. Do not construct by hand.
      schema: { type: string }
    IdempotencyKey:
      name: Idempotency-Key
      in: header
      required: true
      description: Client-generated UUID. Replays return the original response.
      schema: { type: string, format: uuid }
  schemas:
    OrderStatus:
      type: string
      description: Open enum — treat unknown values as `unknown`.
      enum: [pending, paid, shipped, cancelled, refunded]
    Money:
      type: object
      required: [amount, currency]
      properties:
        amount: { type: integer, description: Minor units (paise for INR)., examples: [259800] }
        currency: { type: string, pattern: "^[A-Z]{3}$" }
    LineItem:
      type: object
      required: [sku, quantity, unit_amount]
      properties:
        sku: { type: string, maxLength: 64 }
        quantity: { type: integer, minimum: 1, maximum: 999 }
        unit_amount: { type: integer, minimum: 0 }
    OrderCreate:
      type: object
      required: [customer_id, currency, items]
      properties:
        customer_id: { type: string, pattern: "^cus_[A-Za-z0-9]{3,}$" }
        currency: { type: string, pattern: "^[A-Z]{3}$" }
        items: { type: array, minItems: 1, maxItems: 100,
                 items: { $ref: "#/components/schemas/LineItem" } }
        note: { type: ["string", "null"], maxLength: 500 }
      additionalProperties: false
    Order:
      type: object
      required: [id, customer_id, status, total, items, created_at]
      properties:
        id: { type: string, examples: ["ord_8812AB"] }
        customer_id: { type: string }
        status: { $ref: "#/components/schemas/OrderStatus" }
        total: { $ref: "#/components/schemas/Money" }
        items: { type: array, items: { $ref: "#/components/schemas/LineItem" } }
        created_at: { type: string, format: date-time }
        cancelled_at: { type: ["string", "null"], format: date-time }
    OrderPage:
      type: object
      required: [data, has_more]
      properties:
        data: { type: array, items: { $ref: "#/components/schemas/Order" } }
        has_more: { type: boolean }
        next_cursor: { type: ["string", "null"] }
    Problem:
      type: object
      description: RFC 9457 problem details.
      required: [type, title, status]
      properties:
        type: { type: string, format: uri }
        title: { type: string }
        status: { type: integer, minimum: 100, maximum: 599 }
        detail: { type: string }
        instance: { type: string, format: uri-reference }
        errors:
          type: array
          items:
            type: object
            properties:
              pointer: { type: string, description: JSON Pointer to the bad field. }
              code: { type: string }
  responses:
    BadRequest:
      description: Malformed syntax or invalid parameter.
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
    Unauthorized:
      description: Missing or invalid credentials.
      headers: { WWW-Authenticate: { schema: { type: string } } }
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
    NotFound:
      description: No such resource, or not visible to this caller.
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
    UnprocessableContent:
      description: Syntactically valid but semantically rejected.
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
    PreconditionFailed:
      description: If-Match did not match the current ETag.
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
    TooManyRequests:
      description: Rate limit exceeded.
      headers: { Retry-After: { schema: { type: integer }, description: Seconds to wait. } }
      content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } }
```

### 5.2 What the spec above describes, on the wire

```http
POST /v2/orders HTTP/1.1
Host: api.acme.dev
Authorization: Bearer sk_live_9f2c...
Idempotency-Key: 6b1f0f5e-0a5e-4d5a-9b6e-2f0c2b7c0a11
Content-Type: application/json

{ "customer_id": "cus_301", "currency": "INR",
  "items": [{ "sku": "SKU-7781", "quantity": 2, "unit_amount": 129900 }] }

HTTP/1.1 201 Created
Location: /v2/orders/ord_8812AB
ETag: "r1"

{ "id": "ord_8812AB", "customer_id": "cus_301", "status": "pending",
  "total": { "amount": 259800, "currency": "INR" },
  "created_at": "2024-06-20T11:04:19Z", "cancelled_at": null }
```

### 5.3 Toolchain

```bash
# Bundle a multi-file spec into one document, then lint it against a style ruleset
npx @redocly/cli bundle openapi/root.yaml -o build/openapi.yaml
npx @redocly/cli lint build/openapi.yaml

# Fail CI on any breaking change versus the last published document
oasdiff breaking --fail-on ERR https://api.acme.dev/openapi.json build/openapi.yaml

# Run a mock server so consumers can build before the service exists
npx @stoplight/prism-cli mock build/openapi.yaml --port 4010

# Property-based conformance fuzzing against a live instance
schemathesis run build/openapi.yaml --url https://sandbox.acme.dev/v2 --checks all

# Generate a typed client
npx @openapitools/openapi-generator-cli generate \
  -i build/openapi.yaml -g typescript-fetch -o clients/ts
```

### 5.4 Code-first with FastAPI, and runtime validation

FastAPI derives the document from your Pydantic models and signatures; you enrich it with metadata rather than writing YAML:

```python
from fastapi import FastAPI, Header, Response, status
from pydantic import BaseModel, Field

app = FastAPI(title="Acme Orders API", version="2024-06-20",
              openapi_url="/openapi.json")

class LineItem(BaseModel):
    sku: str = Field(max_length=64)
    quantity: int = Field(ge=1, le=999)
    unit_amount: int = Field(ge=0)

class OrderCreate(BaseModel):
    model_config = {"extra": "forbid"}          # -> additionalProperties: false
    customer_id: str = Field(pattern=r"^cus_[A-Za-z0-9]{3,}$")
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    items: list[LineItem] = Field(min_length=1, max_length=100)
    note: str | None = Field(default=None, max_length=500)   # -> ["string","null"]

@app.post("/orders", status_code=status.HTTP_201_CREATED,
          operation_id="createOrder", tags=["Orders"],
          responses={409: {"description": "Idempotency key reused"}})
async def create_order(body: OrderCreate, response: Response,
                       idempotency_key: str = Header(alias="Idempotency-Key")):
    order = await store.create_order(body, idempotency_key)
    response.headers["Location"] = f"/v2/orders/{order.id}"
    response.headers["ETag"] = f'"{order.revision}"'
    return order
```

Note FastAPI emits OpenAPI 3.1 with JSON Schema 2020-12, so `note: str | None` becomes `type: ["string","null"]` — the 3.1 idiom, not `nullable: true`.

```javascript
// Express: validate every request AND response against the spec at runtime.
import * as OpenApiValidator from 'express-openapi-validator';

app.use(OpenApiValidator.middleware({
  apiSpec: './build/openapi.yaml',
  validateRequests: true,
  validateResponses: { onError: (err, body, req) => {
    metrics.responseSchemaViolations.inc({ route: req.path });
    logger.error({ err, route: req.path }, 'response violated the published spec');
  }},
}));
```

> **Optimization note:** Runtime response validation is expensive — Ajv compilation is fine, but validating every response body on a hot path costs real CPU. Compile schemas once at boot (never per request), validate 100% of requests but **sample** responses (1–5% in production, 100% in staging and CI), and skip validation entirely for large collection payloads where the per-item cost dominates. Serve the spec itself as a static, gzipped, `ETag`-ed asset behind a CDN: a 400 KB document requested by every docs page load is otherwise a surprising amount of egress.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| **Single source of truth** | Docs, SDKs, mocks, validators and tests all derive from one file; no drift | The file becomes critical infrastructure; a bad merge breaks every downstream artifact |
| **Code generation** | Free typed clients in many languages; consumers integrate in minutes | Generated code is often unidiomatic; `operationId` becomes a public API you cannot rename |
| **Runtime validation** | Catches contract violations before they reach a client; sharp staging signal | CPU cost on hot paths; over-strict schemas cause false failures on legitimate traffic |
| **Design-first authoring** | Contract reviewable before implementation; consumers unblocked by a mock on day one | Drift risk unless conformance is enforced in CI; YAML is a hostile authoring surface |
| **Code-first generation** | Spec cannot drift from the implementation | Spec inherits framework quirks; you cannot review a contract that does not exist yet |
| **3.1 / JSON Schema 2020-12** | Real JSON Schema, reusable by any validator; `webhooks` modelled | Some older tools still only speak 3.0; mixing dialects silently produces wrong output |
| **Automated breaking-change diff** | Compatibility policy becomes mechanical instead of cultural | Needs an archived baseline per release; intentional breaks require an explicit override |
| **Very large specs** | Complete coverage of a big surface | Multi-megabyte documents slow editors, docs renderers and generators; needs splitting and bundling |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Declaring `openapi: 3.1.0` but writing 3.0 idioms** like `nullable: true` or boolean `exclusiveMinimum`. → ✅ Use `type: ["string","null"]` and numeric `exclusiveMinimum`; lint the document against the 3.1 meta-schema in CI.
2. ⚠️ **Missing or unstable `operationId`s.** Generators fall back to ugly names derived from the path, and renaming one silently breaks every generated SDK method. → ✅ Require unique, stable `operationId` on every operation via a lint rule; treat renames as breaking.
3. ⚠️ **Documenting only the happy path.** A spec listing just `200` produces SDKs that cannot model failure. → ✅ Document `400`, `401`, `403`, `404`, `409`, `422`, `429` and the shared `Problem` schema; enforce with a lint rule.
4. ⚠️ **Inline schemas everywhere.** Every response gets an anonymous object, and the generated SDK is full of `InlineResponse200`. → ✅ Name every reusable shape in `components/schemas` and `$ref` it.
5. ⚠️ **Hand-maintaining docs beside the spec.** They diverge within a sprint. → ✅ Generate the docs site from the published document; the only prose that lives elsewhere is narrative guides.
6. ⚠️ **Leaving `additionalProperties` unset on request bodies.** Typo'd fields are silently ignored and the client thinks it configured something. → ✅ `additionalProperties: false` on request bodies; leave responses open so *you* can evolve additively.
7. ⚠️ **Documenting security globally but forgetting per-operation overrides.** Public endpoints appear to require auth, or worse, an authenticated one appears public. → ✅ Set a global `security` default and override explicitly with `security: []` where genuinely public.
8. ⚠️ **No examples.** A schema tells a developer what is legal, never what is typical. → ✅ Add `examples` to schemas and named `examples` to request bodies and responses; mock servers use them directly.
9. ⚠️ **Treating a validation failure as a spec bug.** Someone relaxes the schema to make the test pass, and the contract now describes the bug. → ✅ A response violating the spec is a server bug until a reviewer explicitly decides otherwise.
10. ⚠️ **Publishing internal-only endpoints.** Admin routes leak into the public document and become an attack surface map. → ✅ Tag internal operations and filter them out during bundling; publish only the public document.
11. ⚠️ **Version drift between the spec and the deployed service.** Docs describe a field that shipped last week and rolled back yesterday. → ✅ Publish the spec from the same artifact as the service, and serve it from the service itself.
12. ⚠️ **No archived baseline.** Without the previous document you cannot diff, so breaking-change detection silently does nothing. → ✅ Archive every published document per release, immutably, and point the CI differ at it.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

Serve the live document from the service itself (`GET /openapi.json`) so what you inspect is what is running, and include the build SHA in `info.version` or an `x-build` extension. When an integrator reports "your docs are wrong," the first step is to diff the published document against the live one — if they differ, the pipeline is broken, and that is a bigger problem than the ticket. Keep response-validation failures in staging as loud test failures with the offending JSON Pointer in the log line.

### Monitoring

- `openapi_response_validation_failures_total{route, pointer}` — the single highest-signal metric here; any non-zero value means the server is lying about its contract.
- `openapi_request_validation_failures_total{route, pointer}` — a spike after an SDK release means the generated client is wrong or the schema is over-strict.
- Spec size and lint-rule violation counts tracked over time, so degradation is visible before it is painful.
- CI metrics: breaking-change diff outcomes per PR, and the count of override entries (a growing override list means the policy is decorative).

### Security

The published document is a **complete map of your attack surface** — every parameter, every regex, every auth scheme. That is fine and intentional for a public API, but it means the filtering step matters: never publish internal or admin operations, and never put credentials, internal hostnames, or real customer identifiers in `examples`. Declare `securitySchemes` accurately, because generated SDKs and gateway policies derive authentication behaviour from them. Runtime request validation is genuine defence in depth: rejecting an over-long string at the edge, from the same schema the docs publish, stops a class of injection and resource-exhaustion attacks before any handler runs.

### Performance & Scaling

Large specs (hundreds of operations, megabytes of YAML) slow editors, docs renderers and generators. Split by resource into multiple files, `$ref` between them, and bundle in CI. Serve the bundled document gzipped with a long `Cache-Control` and an `ETag` so docs page loads hit a CDN. In the validator, compile schemas once at process start and cache compiled functions per route; sample response validation in production rather than running it on every request.

## 9. Interview Questions

**Q: What is OpenAPI and what problem does it solve?**
A: It is a standard, machine-readable description of an HTTP API — paths, operations, parameters, schemas, responses, security. It solves drift and duplication: instead of restating the contract in docs, SDKs, mocks, validators and tests, all of those become build artifacts derived from one document. Its value is proportional to how much you generate from it.

**Q: What changed between OpenAPI 3.0 and 3.1?**
A: 3.1 aligns the Schema Object with full JSON Schema 2020-12 rather than a divergent subset, which means `nullable: true` is replaced by `type: ["string","null"]`, `examples` becomes an array, and `exclusiveMinimum` is a number. It also adds top-level `webhooks`, makes `paths` optional, and allows `summary`/`description` beside a `$ref`. The practical consequence is that any JSON Schema validator can now enforce your contract.

**Q: Design-first or code-first — which is better?**
A: Design-first when the API is public or has multiple consumer teams, because the contract can be reviewed and mocked before implementation exists. Code-first for internal services where speed matters and the consumer is one team you can talk to. Either way you need a conformance check in CI, because design-first drifts from the code and code-first drifts from what you meant.

**Q: Why does `operationId` matter so much?**
A: Code generators turn it into the SDK method name, so it is a public identifier even though it never appears on the wire. Renaming `createOrder` to `orderCreate` breaks every generated client's call site. Require it, require uniqueness, and treat changes as breaking.

**Q: How do you stop the spec and the implementation from drifting apart?**
A: Generate the spec from the running service, or validate the running service against the spec — ideally both. Concretely: runtime request/response validation middleware, property-based conformance fuzzing (Schemathesis) in CI, and consumer-driven contract tests. Reviews alone do not work.

**Q: What is `additionalProperties: false` and where should you use it?**
A: It rejects any property not named in the schema. Use it on request bodies, so a typo'd field is a `422` rather than a silently ignored setting. Do *not* use it on responses, because it prevents you from adding fields additively and it encourages clients to be intolerant readers.

**Q: How do you document errors properly in a spec?**
A: Define one `Problem` schema per RFC 9457 in `components/schemas`, define reusable response objects (`BadRequest`, `Unauthorized`, `TooManyRequests`) in `components/responses` with `application/problem+json` content and relevant headers such as `WWW-Authenticate` and `Retry-After`, then `$ref` them from every operation. Enforce coverage with a lint rule.

**Q: (Senior) You own a 400-operation spec across eight teams. How do you structure and govern it?**
A: Split by bounded context into per-resource files owned by the team that owns the service, with shared `components` in a common package pinned by version. Bundle in CI, lint with a shared Spectral ruleset encoding your guidelines as executable rules, and gate merges on `oasdiff breaking` against the archived previous release with an explicit, reviewed override file. Publish a single bundled public document filtered of internal operations, and archive every release immutably so any two dates can be diffed.

**Q: (Senior) What are the real limits of generating clients from a spec?**
A: Generated clients are only as good as the spec's fidelity, and most specs under-describe behaviour: retries, idempotency semantics, pagination cursors, long-polling, partial failure and rate-limit backoff are all invisible to a generator. You also inherit the generator's idioms, which rarely match a language's community conventions, and every regeneration risks churn in public method names. Mature providers hand-write a thin ergonomic layer over generated transport code.

**Q: (Senior) How would you use the spec to enforce API governance across an organisation?**
A: Encode the guidelines as Spectral rules — naming conventions, required error responses, mandatory pagination parameters on collections, forbidden verbs in paths, required descriptions and examples — and run them as a required check on every API repo. Add breaking-change detection with a signed override path, publish a scorecard per API, and make the ruleset itself versioned and reviewable so governance is a pull request rather than a committee.

**Q: What are `webhooks` in 3.1 and how do they differ from callbacks?**
A: `webhooks` is a top-level map describing requests your API sends to a consumer's endpoint, independent of any particular operation — the right model for event delivery. `callbacks` are attached to a specific operation and describe requests triggered by *that* call, such as an async job completion notification. Use `webhooks` for an event catalogue and `callbacks` for per-operation flows.

**Q: How do you validate that examples in the spec are actually correct?**
A: Lint them against their own schemas (Redocly and Spectral both do this), then go further and replay them as real requests against a live instance in CI, asserting the response conforms to the documented schema. Examples that are never executed rot exactly as fast as prose documentation.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** An OpenAPI document describes addressing (`servers` + `paths` + method), shape (parameters, bodies, responses, headers) and constraint (JSON Schema). Write **3.1**, which is real JSON Schema 2020-12: `type: ["string","null"]` not `nullable`, `examples` as an array, numeric `exclusiveMinimum`, plus top-level `webhooks`. Name every reusable shape in `components` and `$ref` it; give every operation a stable, unique `operationId`, because generators turn it into SDK method names. Document all the error responses, not just `200`, with a shared RFC 9457 `Problem` schema. In CI: bundle, lint with a house Spectral ruleset, diff against the archived previous release with `oasdiff breaking --fail-on ERR`, then generate docs, SDKs and a Prism mock. At runtime, validate 100% of requests and a sample of responses from the same schemas. The spec is the source of truth; docs, clients, mocks and validators are build artifacts.

| Element | Purpose |
| --- | --- |
| `openapi: 3.1.0` | Declares the version and the JSON Schema 2020-12 dialect |
| `info.version` | The API's version, not the document's revision |
| `servers[].url` | Base URL; supports templated variables |
| `paths./x.{method}` | An operation |
| `operationId` | Stable ID → generated SDK method name |
| `components.schemas` | Named, reusable schemas referenced by `$ref` |
| `components.responses` | Reusable responses — `Problem` bodies live here |
| `securitySchemes` | `http`/`apiKey`/`oauth2`/`openIdConnect` definitions |
| `webhooks` (3.1) | Requests your API sends outbound |
| Nullable field | `type: ["string", "null"]` |
| Strict request body | `additionalProperties: false` |
| CI gates | `redocly lint` + `oasdiff breaking --fail-on ERR` |

**Flash cards**

- **The one-line reason to keep a spec?** → Docs, SDKs, mocks, validators and tests all become generated artifacts instead of hand-maintained duplicates.
- **How do you express a nullable string in 3.1?** → `type: ["string", "null"]` — `nullable: true` is 3.0 and invalid in 3.1.
- **Why is `operationId` a breaking-change surface?** → Generators use it as the SDK method name, so renaming it breaks every generated client's call sites.
- **Where does `additionalProperties: false` belong?** → Request bodies (catch typos); never responses (it blocks additive evolution).
- **The two CI gates every spec needs?** → A style lint (Spectral/Redocly) and a breaking-change diff against the archived previous release.

## 11. Hands-On Exercises & Mini Project

- [ ] Write a 3.1 document by hand for a three-endpoint API, then validate it with `redocly lint`. Deliberately use `nullable: true` and confirm the linter rejects it.
- [ ] Run `prism mock` against your spec and build a small client against the mock before writing any server code. Note which parts of the contract the mock cannot express.
- [ ] Generate a TypeScript client with `openapi-generator`, then rename an `operationId` and observe exactly which call sites break.
- [ ] Add `express-openapi-validator` (or FastAPI's built-in validation) and deliberately return a response that violates the schema. Confirm you get a loud failure with a JSON Pointer, not a silent success.
- [ ] Run `schemathesis run --checks all` against a live sandbox and fix every conformance failure it finds; most APIs fail on undocumented `500`s and on `4XX` bodies that are not the documented `Problem` shape.

### Mini Project — spec-driven orders service

**Goal.** Build a small API where every artifact except the business logic is generated from one document.

**Requirements.**
1. A multi-file 3.1 spec (`paths/`, `schemas/`, `responses/`) bundled by `redocly bundle` into `build/openapi.yaml`, covering pagination, idempotency, conditional requests and RFC 9457 errors.
2. A CI pipeline that bundles, lints with a custom Spectral ruleset (require `operationId`, require `429` on every collection GET, forbid verbs in paths), and runs `oasdiff breaking` against the archived previous release.
3. A FastAPI or Express implementation with runtime request validation and sampled response validation from the same document.
4. Generated artifacts published per release: a Redoc docs site, a TypeScript client, and a Prism mock deployed for consumers.
5. A Schemathesis job in CI that fuzzes every operation and fails on any non-conforming response.

**Extensions.**
- Add a `webhooks` section describing `order.shipped` and generate a consumer-side handler stub plus signature-verification docs from it.
- Add an `x-internal: true` extension and a bundling filter that strips those operations from the public document.
- Publish a scorecard: operations missing examples, missing descriptions, or missing error responses, tracked as a trend over releases.

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *API Versioning Strategies* (chapter 31) shows how versions appear in a spec; *Backward Compatibility & Deprecation* (chapter 32) supplies the `deprecated: true` markers and the diffing policy; *Design-First & Contract Testing* (chapter 34) turns this document into an enforceable agreement; *API Documentation That Developers Love* (chapter 35) is what you build on top of it; *Testing REST APIs* (chapter 36) covers conformance fuzzing and generated test suites.

- **OpenAPI Specification 3.1.1** — OpenAPI Initiative · *Intermediate* · the normative document; dense but the only authority on what is legal. Read the Schema Object and Components sections first. <https://spec.openapis.org/oas/latest.html>
- **Learn OpenAPI (OAI documentation site)** — OpenAPI Initiative · *Beginner* · the official tutorial track, including a clear migration guide from 3.0 to 3.1. <https://learn.openapis.org/>
- **JSON Schema 2020-12 — Understanding JSON Schema** — JSON Schema Org · *Beginner* · the best explanation of the dialect that *is* the 3.1 Schema Object; covers `oneOf`, `$ref`, conditionals and formats. <https://json-schema.org/understanding-json-schema>
- **Spectral — API style guide linter** — Stoplight · *Intermediate* · lets you encode your organisation's API guidelines as executable rules; the governance mechanism referenced throughout §8. <https://docs.stoplight.io/docs/spectral>
- **Redocly CLI documentation** — Redocly · *Beginner* · bundling, linting, and docs generation; the fastest path from a multi-file spec to a published reference site. <https://redocly.com/docs/cli/>
- **Schemathesis** — Schemathesis · *Advanced* · property-based testing that derives thousands of cases from your schemas and finds the responses your spec does not describe. <https://schemathesis.readthedocs.io/>
- **Stripe OpenAPI specifications** — Stripe · *Advanced* · a real, enormous, production 3.x document; invaluable for seeing how a mature provider models expansion, polymorphism and errors. <https://github.com/stripe/openapi>
- **Zalando RESTful API Guidelines** — Zalando · *Intermediate* · the guideline set most often encoded as Spectral rules; explains *why* each rule exists, which matters when you adapt them. <https://opensource.zalando.com/restful-api-guidelines/>

---

*REST API Handbook — chapter 33.*
