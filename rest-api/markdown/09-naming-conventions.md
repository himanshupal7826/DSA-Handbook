# 09 · Naming Conventions & API Consistency

> **In one line:** Naming is the part of API design that carries no technical risk and all of the cognitive cost — consistency is worth more than any individual convention you might choose.

---

## 1. Overview

An API's **naming conventions** are the rules governing how you spell paths, resources, fields, query parameters, headers, enum values and error codes. None of these decisions affect correctness. All of them affect whether a developer can guess your next endpoint after learning three of them — which is, in practice, the entire measure of API usability. A consistent API is one where knowledge transfers; an inconsistent one forces the reader back to the documentation for every single call.

The problem naming solves is **cognitive load at scale**. A small API with twenty endpoints can survive being ad hoc. An API with four hundred endpoints, built by nine teams over six years, cannot: without enforced conventions you end up with `/getUserProfile`, `/users/{id}/profile`, `/user-profiles?userId=`, and `/v2/profiles/user/{id}` all coexisting, all returning slightly different shapes, all documented separately. Every one of them works. Together they are unusable. This is why every large API organisation — Google, Microsoft, Zalando, Adidas, PayPal — publishes a numbered, enforceable style guide rather than trusting taste.

There is no RFC for naming. Roy Fielding's 2000 dissertation gave us the *resource* abstraction and the uniform-interface constraint, from which the "nouns not verbs" rule follows — the verb is the HTTP method, so putting it in the path duplicates it. RFC 3986 defines URI syntax (and notes that paths are case-sensitive while the host is not). Everything beyond that is convention, hardened by two decades of practice into a set of choices that are now effectively industry-standard even though nothing enforces them.

**Concrete example.** GitHub's API is the canonical demonstration of guessability: `/repos/{owner}/{repo}`, `/repos/{owner}/{repo}/issues`, `/repos/{owner}/{repo}/issues/{number}/comments`, `/repos/{owner}/{repo}/pulls`, `/orgs/{org}/members`. Plural collections, `snake_case` fields, `per_page`/`page` for pagination, `sort`/`direction` for ordering — learn five endpoints and you can predict the sixth. Stripe is equally disciplined: `/v1/customers`, `/v1/charges`, `/v1/payment_intents`, every object carrying an `object` field naming its own type, every list returning `{"object": "list", "data": [...], "has_more": …}`. Contrast this with APIs that grew organically, where `/api/getOrders` sits next to `/api/v2/orders/list` and `/orders/search` — each one requiring a documentation lookup.

The durable mental model: **an API is a language, and naming conventions are its grammar.** A reader who has internalised the grammar can parse sentences they have never seen. That is the payoff, and it is why the meta-rule — *be consistent* — outranks every specific rule in this chapter.

## 2. Core Concepts

- **Resource** — a named thing your API exposes, addressed by a URI. Resources are **nouns**; the verb lives in the HTTP method.
- **Collection** — a resource representing a set of members, named with a **plural** noun: `/invoices`. Its members are `/invoices/{id}`.
- **Singleton resource** — a resource of which exactly one exists in its context, named with a singular noun: `/users/{id}/settings`, `/me`.
- **Sub-resource (nested resource)** — a resource whose identity depends on a parent: `/orders/{order_id}/line_items`.
- **Path parameter** — a variable path segment identifying a resource (`{invoice_id}`), part of the resource's identity.
- **Query parameter** — a name/value pair modifying how a collection is projected (filter, sort, page, fields). Never used to identify a single resource.
- **Casing conventions** — `kebab-case` (hyphenated, conventional in paths), `snake_case` (underscored, conventional in JSON fields and query params), `camelCase` (JavaScript-native, common in JSON), `SCREAMING_SNAKE_CASE` (enum values and error codes).
- **Controller / action resource** — the pragmatic escape hatch for operations that are genuinely not CRUD, expressed as a verb sub-resource: `POST /orders/{id}/cancel`.
- **Style guide** — the written, numbered document that fixes all of the above; without it, "consistency" is a hope rather than a property.
- **Linting** — mechanical enforcement of the style guide (Spectral, Vacuum, Zally) against the OpenAPI document in CI, which is the only enforcement that survives team growth.

## 3. Theory & Principles

**Why nouns, not verbs.** REST's uniform-interface constraint says that the *method* carries the action semantics and the *URI* carries identity. `GET /getUsers` states "get" twice; `DELETE /deleteUser/5` states "delete" twice and additionally breaks the moment someone sends `GET /deleteUser/5`. Worse, verb-in-path defeats HTTP's own machinery: intermediaries know that `GET` is safe and cacheable and that `DELETE` is idempotent, but they cannot know that about `/doThing`. The rule: **the path answers "what", the method answers "what to do with it".**

**Plural or singular collections.** Both work; plural wins by consensus. The argument for plural (`/invoices`, `/invoices/inv_1`) is that `/invoices` genuinely denotes a set and `/invoices/inv_1` reads as "the invoice with this id, from the invoices". The argument for singular (`/invoice/inv_1`) is grammatical purity for the member. The decisive practical point: **mixing them is the real cost** — `/person/{id}` next to `/companies/{id}` means every developer must remember which is which. Choose plural, apply it everywhere, and use singular only for true singletons (`/me`, `/settings`, `/status`), where a plural would be a lie. Irregular plurals (`people`, `children`, `taxonomies`) are fine and preferable to inventing `persons`.

**Path casing.** URI paths are case-sensitive by RFC 3986 (only scheme and host are not), so `/lineItems` and `/lineitems` are different resources and someone will eventually hit the wrong one. Use **lowercase**, and separate words with **hyphens** (`/payment-methods`, `/shipping-addresses`) — hyphens are the web-wide convention, are not word-boundary characters for double-click selection, and avoid the underscore's habit of hiding under a link underline. Never use `camelCase` in paths.

**JSON field casing.** `snake_case` or `camelCase`; both are defensible and both are widely used. `camelCase` is native to JavaScript and is what Google's API Design Guide and Microsoft's guidelines mandate; `snake_case` is what GitHub, Stripe, Twilio and Zalando use and is friendlier to Python/Ruby/Rust consumers. Choose one, encode it in your linter, and never mix. If you must interoperate with a system using the other convention, do the translation at one boundary rather than letting both leak into the same document.

**Query-parameter style.** Query parameters should match your JSON field convention so that `?created_at_after=…` filters the field named `created_at`. Standardise the *reserved* set across the entire API — this is the single highest-leverage consistency rule, because these appear on every collection endpoint:

| Purpose | Recommended name | Common alternatives |
|---|---|---|
| Page size | `limit` | `per_page`, `page_size`, `top` |
| Offset paging | `offset` | `page`, `skip` |
| Cursor paging | `cursor` | `starting_after`, `page_token`, `after` |
| Sorting | `sort=-created_at,name` | `sort_by` + `order`, `orderby` |
| Sparse fields | `fields=id,name` | `select`, `_fields` |
| Embedding | `expand=customer` | `include`, `embed` |
| Search | `q` | `query`, `search`, `filter[q]` |

The `-` prefix for descending sort (`sort=-created_at`) is the JSON:API convention and is strictly better than a parallel `order=desc` parameter, because it composes: `sort=-priority,created_at` expresses a two-key sort that a separate `order` parameter cannot.

**Header naming.** RFC 9110 §16.3 explicitly deprecates the `X-` prefix for new headers (that guidance dates to RFC 6648): `X-Request-Id` should have been `Request-Id`. In practice `X-Request-Id` is so entrenched that following the RFC costs interoperability, so the pragmatic rule is: use standard headers wherever one exists (`Authorization`, `Retry-After`, `ETag`, `Link`, `Idempotency-Key`), and for genuinely custom ones prefer an unprefixed, hyphenated, namespaced name (`Zariya-Trace-Id`). Header names are case-insensitive but HTTP/2 and HTTP/3 require them **lowercase on the wire** — never write code that depends on case.

**Abbreviations, IDs, and booleans.** Spell things out (`organization`, not `org`; `identifier` fields as `id` because that abbreviation is universal). Foreign keys read as `<entity>_id` (`customer_id`), never bare `customer` for a scalar id. Booleans read as predicates (`is_active`, `has_children`, `can_edit`) — but remember from the payload chapter that a lifecycle almost always wants a `status` enum rather than a boolean. Timestamps read as `<verb>_at` for instants (`created_at`, `deleted_at`) and `<verb>_on` for calendar dates (`due_on`). Counts read as `<noun>_count`. These micro-conventions cost nothing and eliminate an entire class of "what does this field mean" questions.

```svg
<svg viewBox="0 0 770 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="750" height="330" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="385" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Anatomy of a well-named request</text>
  <rect x="40" y="58" width="690" height="50" rx="10" fill="#ffffff" stroke="#4f46e5"/>
  <text x="60" y="90" fill="#16a34a" font-size="15" font-weight="700">GET</text>
  <text x="110" y="90" fill="#0ea5e9" font-size="15" font-weight="700">/v1</text>
  <text x="145" y="90" fill="#4f46e5" font-size="15" font-weight="700">/customers</text>
  <text x="255" y="90" fill="#1e293b" font-size="15" font-weight="700">/cus_8Kq</text>
  <text x="345" y="90" fill="#4f46e5" font-size="15" font-weight="700">/payment-methods</text>
  <text x="520" y="90" fill="#d97706" font-size="15" font-weight="700">?limit=25&amp;sort=-created_at</text>
  <path d="M70 112 L70 140" stroke="#16a34a" stroke-width="1.5"/>
  <text x="70" y="158" text-anchor="middle" fill="#1e293b" font-size="11">verb lives</text>
  <text x="70" y="173" text-anchor="middle" fill="#1e293b" font-size="11">in the method</text>
  <path d="M125 112 L125 190" stroke="#0ea5e9" stroke-width="1.5"/>
  <text x="125" y="208" text-anchor="middle" fill="#1e293b" font-size="11">major version</text>
  <path d="M195 112 L195 236" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="200" y="254" text-anchor="middle" fill="#1e293b" font-size="11">plural collection, lowercase</text>
  <path d="M295 112 L295 282" stroke="#1e293b" stroke-width="1.5"/>
  <text x="300" y="300" text-anchor="middle" fill="#1e293b" font-size="11">opaque prefixed id</text>
  <path d="M420 112 L420 140" stroke="#4f46e5" stroke-width="1.5"/>
  <text x="430" y="158" text-anchor="middle" fill="#1e293b" font-size="11">sub-resource, kebab-case</text>
  <text x="430" y="173" text-anchor="middle" fill="#1e293b" font-size="11">plural, no verbs</text>
  <path d="M600 112 L600 190" stroke="#d97706" stroke-width="1.5"/>
  <text x="600" y="208" text-anchor="middle" fill="#1e293b" font-size="11">reserved query params: limit, cursor,</text>
  <text x="600" y="223" text-anchor="middle" fill="#1e293b" font-size="11">sort, fields, expand, q</text>
  <text x="600" y="245" text-anchor="middle" fill="#1e293b" font-size="11">leading &#8722; means descending</text>
  <rect x="380" y="262" width="350" height="62" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="400" y="284" fill="#1e293b" font-size="12" font-weight="700">Never in a path</text>
  <text x="400" y="304" fill="#1e293b" font-size="11">verbs, camelCase, trailing slashes,</text>
  <text x="400" y="318" fill="#1e293b" font-size="11">file extensions, internal db ids</text>
</svg>
```

## 4. Architecture & Workflow

Consistency is not achieved by writing it down; it is achieved by making the inconsistent version fail a build. Here is the workflow that actually holds across teams.

1. **Write the style guide as numbered rules.** Not prose — numbered, individually citable rules (`R-014: collection paths MUST be plural, lowercase, kebab-case`). Numbering makes review comments cheap ("this violates R-014") and makes exceptions auditable.
2. **Encode the mechanically checkable subset as lint rules.** Roughly 70 % of a naming guide is machine-checkable: path casing, plurality, field casing, reserved parameter names, enum casing, required response codes, operation-id format. Write these as Spectral rules against the OpenAPI document.
3. **Design-first authoring.** New endpoints are proposed as an OpenAPI fragment in a pull request, before implementation. The naming argument happens against a diff, not against shipped code.
4. **Lint in CI on every PR.** `spectral lint openapi.yaml --fail-severity=warn`. A naming violation blocks the merge exactly like a failing test. This is the step that converts a guide into a property.
5. **Runtime conformance check.** Lint the spec, but also assert the running service matches: a CI job that hits the service, captures real responses, and validates them against the schema catches the case where the spec says `snake_case` and the serializer emits `camelCase`.
6. **Central review for the un-checkable 30 %.** Whether a concept should be `/subscriptions` or `/plans`, whether an operation is a sub-resource or a filter — these need a human API-design review with a small standing group, not a per-team decision.
7. **A shared component library.** Publish reusable OpenAPI `components` for `Money`, `Error`, `PageInfo`, `Timestamp`, plus the reserved query parameters. Teams that `$ref` the shared components cannot diverge on them.
8. **Deprecation path for legacy names.** Existing inconsistencies are not fixed by renaming; they are fixed by adding the compliant name, emitting both, marking the old one deprecated with `Sunset`, and removing it at the next major version.
9. **Publish the guide externally.** Zalando, Google and Microsoft all publish theirs. External publication forces clarity and gives your own consumers a mental model.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="760" height="320" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="36" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">How consistency is actually enforced</text>
  <rect x="30" y="58" width="140" height="66" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="100" y="82" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Style guide</text>
  <text x="100" y="100" text-anchor="middle" fill="#1e293b" font-size="10">numbered rules</text>
  <text x="100" y="114" text-anchor="middle" fill="#1e293b" font-size="10">R-001 &#8230; R-120</text>
  <rect x="200" y="58" width="140" height="66" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="270" y="82" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Spectral rules</text>
  <text x="270" y="100" text-anchor="middle" fill="#1e293b" font-size="10">the checkable 70%</text>
  <text x="270" y="114" text-anchor="middle" fill="#1e293b" font-size="10">casing, plurality</text>
  <rect x="370" y="58" width="140" height="66" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="440" y="82" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">PR: spec diff</text>
  <text x="440" y="100" text-anchor="middle" fill="#1e293b" font-size="10">design-first</text>
  <text x="440" y="114" text-anchor="middle" fill="#1e293b" font-size="10">before code</text>
  <rect x="540" y="58" width="120" height="66" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="600" y="82" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">CI gate</text>
  <text x="600" y="100" text-anchor="middle" fill="#1e293b" font-size="10">lint fails</text>
  <text x="600" y="114" text-anchor="middle" fill="#1e293b" font-size="10">the build</text>
  <rect x="680" y="58" width="70" height="66" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="715" y="88" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Merge</text>
  <text x="715" y="106" text-anchor="middle" fill="#1e293b" font-size="10">+ publish</text>
  <path d="M170 91 L198 91" stroke="#4f46e5" stroke-width="2"/>
  <path d="M340 91 L368 91" stroke="#4f46e5" stroke-width="2"/>
  <path d="M510 91 L538 91" stroke="#4f46e5" stroke-width="2"/>
  <path d="M660 91 L678 91" stroke="#4f46e5" stroke-width="2"/>
  <rect x="370" y="150" width="290" height="46" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="515" y="170" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Human API review</text>
  <text x="515" y="188" text-anchor="middle" fill="#1e293b" font-size="10">the un-checkable 30%: is this a resource?</text>
  <path d="M440 124 L440 148" stroke="#d97706" stroke-width="2"/>
  <rect x="30" y="220" width="355" height="96" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="50" y="244" fill="#1e293b" font-size="12" font-weight="700">Shared OpenAPI components ($ref)</text>
  <text x="50" y="266" fill="#1e293b" font-size="11">Money &#183; Error &#183; PageInfo &#183; Timestamp</text>
  <text x="50" y="284" fill="#1e293b" font-size="11">reserved params: limit, cursor, sort, fields, q</text>
  <text x="50" y="302" fill="#1e293b" font-size="11">teams that $ref cannot diverge</text>
  <rect x="405" y="220" width="345" height="96" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="425" y="244" fill="#1e293b" font-size="12" font-weight="700">Fixing an existing bad name</text>
  <text x="425" y="266" fill="#1e293b" font-size="11">1. add the compliant name alongside</text>
  <text x="425" y="284" fill="#1e293b" font-size="11">2. emit both, mark old deprecated + Sunset</text>
  <text x="425" y="302" fill="#1e293b" font-size="11">3. remove only at the next major version</text>
</svg>
```

## 5. Implementation

A consistent slice of an API, showing the conventions applied together:

```http
GET /v1/customers/cus_8Kq/payment-methods?limit=25&sort=-created_at&fields=id,brand,last4 HTTP/1.1
Host: api.zariya.in
Accept: application/json
```

```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
Link: </v1/customers/cus_8Kq/payment-methods?cursor=cGF5bV8x&limit=25>; rel="next"

{
  "data": [
    {"id": "paym_01JQ", "object": "payment_method", "brand": "visa", "last4": "4242",
     "is_default": true, "created_at": "2026-07-22T09:14:03Z"}
  ],
  "has_more": true,
  "next_cursor": "cGF5bV8x"
}
```

Every convention is visible: plural kebab-case path segment, opaque prefixed id, `snake_case` fields, `_at` timestamp suffix, `is_` boolean prefix, reserved `limit`/`sort`/`fields` parameters, `-` for descending.

The **before and after** of an inconsistent API — this is the review you will actually be doing:

```
❌  POST   /api/createNewOrder
❌  GET    /api/Order/{orderID}
❌  GET    /api/orders/list?pageNum=2&itemsPerPage=50&sortField=date&sortDir=DESC
❌  POST   /api/orders/{id}/doCancel
❌  GET    /api/order-items?orderId=123
❌  DELETE /api/removeOrder?id=123

✅  POST   /v1/orders
✅  GET    /v1/orders/{order_id}
✅  GET    /v1/orders?limit=50&cursor=…&sort=-created_at
✅  POST   /v1/orders/{order_id}/cancel
✅  GET    /v1/orders/{order_id}/line-items
✅  DELETE /v1/orders/{order_id}
```

Note `POST /v1/orders/{order_id}/cancel` survives the review. Cancellation is a state transition with side effects (refunds, notifications) that is neither a full replacement nor a field update; modelling it as `PATCH {"status": "cancelled"}` pretends it is a simple write. The **controller-resource** escape hatch is legitimate — the discipline is that it must be rare, must use `POST`, and must be a verb *only* in the final segment.

An **OpenAPI 3.1** fragment with shared components, so naming cannot drift:

```yaml
openapi: 3.1.0
info: { title: Zariya API, version: "1.0.0" }
components:
  parameters:
    Limit:
      { name: limit, in: query, schema: { type: integer, minimum: 1, maximum: 100, default: 25 } }
    Cursor:
      { name: cursor, in: query, schema: { type: string } }
    Sort:
      name: sort
      in: query
      description: Comma-separated fields; prefix with '-' for descending.
      schema: { type: string, pattern: '^-?[a-z_]+(,-?[a-z_]+)*$' }
      example: "-created_at,name"
paths:
  /v1/customers/{customer_id}/payment-methods:
    get:
      operationId: listCustomerPaymentMethods
      parameters:
        - { name: customer_id, in: path, required: true, schema: { type: string } }
        - $ref: '#/components/parameters/Limit'
        - $ref: '#/components/parameters/Cursor'
        - $ref: '#/components/parameters/Sort'
      responses:
        "200": { description: A page of payment methods }
```

**Spectral** rules that turn the guide into a build gate:

```yaml
extends: ["spectral:oas"]
rules:
  path-segments-kebab-lowercase:
    description: Path segments must be lowercase kebab-case; no camelCase, no underscores.
    given: $.paths[*]~
    severity: error
    then:
      function: pattern
      functionOptions:
        match: "^(\\/(v[0-9]+|[a-z0-9]+(-[a-z0-9]+)*|\\{[a-z0-9_]+\\}))+$"

  no-verbs-in-paths:
    description: Paths must not contain verbs (the HTTP method is the verb).
    given: $.paths[*]~
    severity: error
    then:
      function: pattern
      functionOptions:
        notMatch: "(?i)(get|create|update|delete|remove|fetch|list|do)[A-Z_-]?"

  schema-properties-snake-case:
    description: JSON property names must be snake_case.
    given: $.components.schemas[*].properties[*]~
    severity: error
    then:
      function: casing
      functionOptions: { type: snake }

  no-trailing-slash:
    given: $.paths[*]~
    severity: error
    then:
      function: pattern
      functionOptions: { notMatch: ".+\\/$" }
```

Enforcing the field convention in code, so the serializer cannot disagree with the spec:

```python
from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_snake

class ApiModel(BaseModel):
    """Every wire model inherits this. The serializer, not each developer,
    guarantees snake_case on the wire."""
    model_config = ConfigDict(alias_generator=to_snake, populate_by_name=True, extra="forbid")

class PaymentMethod(ApiModel):
    id: str
    brand: str
    last4: str
    is_default: bool
    created_at: datetime
```

A CI test that asserts the *running* service matches the convention, catching serializer drift:

```python
import re, requests
SNAKE = re.compile(r"^[a-z][a-z0-9_]*$")

def walk_keys(node):
    if isinstance(node, dict):
        for k, v in node.items():
            yield k
            yield from walk_keys(v)
    elif isinstance(node, list):
        for v in node:
            yield from walk_keys(v)

def test_response_keys_are_snake_case(base_url, token):
    for path in ["/v1/customers", "/v1/orders", "/v1/invoices"]:
        body = requests.get(base_url + path, headers={"Authorization": token}).json()
        bad = [k for k in walk_keys(body) if not SNAKE.match(k)]
        assert not bad, f"{path} returned non-snake_case keys: {sorted(set(bad))}"
```

**Optimization note.** Naming has two measurable performance consequences, both easy to miss. First, **path templates are your metric cardinality**: instrument routes as `/v1/orders/{order_id}`, never as the concrete path, or your time-series database ingests one label value per order id and falls over. Consistent, template-shaped naming is what makes that automatic. Second, **stable, guessable URLs are cacheable URLs**: an endpoint reachable as both `/v1/orders?status=open` and `/v1/orders/open` splits the CDN cache in two, halving hit rate for the same traffic. Canonicalise — pick one form, `301` the other, and emit `Content-Location` so caches and clients agree on the resource's identity. Also normalise query-parameter order and casing at the edge, since `?limit=25&sort=-created_at` and `?sort=-created_at&limit=25` are distinct cache keys to most CDNs.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Plural collection nouns | Guessable, reads correctly for both set and member | Irregular plurals (`people`, `taxonomies`) need judgement calls |
| Nouns not verbs | Lets HTTP semantics (safe, idempotent, cacheable) do real work | Genuine non-CRUD actions need a documented escape hatch |
| `kebab-case` paths | Web-wide convention, case-safe, readable | Differs from the `snake_case` used in the body — two conventions in one API |
| `snake_case` JSON fields | Matches GitHub/Stripe; natural in Python/Ruby/Rust | JavaScript clients often re-map to `camelCase`, adding a layer |
| `camelCase` JSON fields | Zero friction in JS/TS; mandated by Google and Microsoft guides | Awkward in `snake_case` languages; acronym handling (`ID` vs `Id`) is a fresh argument |
| Reserved query-parameter set | One mental model across hundreds of endpoints | Legacy endpoints must be migrated or permanently excepted |
| Controller resources (`/cancel`) | Honest about operations that aren't CRUD | Slippery slope: without a rule, everything becomes a controller |
| Written numbered style guide | Makes review objective and citable | Someone must own and version it, or it rots within a year |
| Lint enforcement in CI | Consistency becomes a property, not a hope | Rules can be over-tight and slow teams down; needs an exception process |
| Renaming to fix legacy names | Long-term coherence | Breaking change; requires dual-emit, deprecation, sunset, and months of waiting |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Verbs in URIs** — `/getUsers`, `/createOrder`, `/deleteAccount`. The method already says it, and intermediaries lose the safety/idempotency signal. → ✅ Nouns in the path, verbs in the method: `GET /users`, `POST /orders`, `DELETE /accounts/{id}`.
2. ⚠️ **Mixing singular and plural** — `/user/{id}` alongside `/orders/{id}`. Every call becomes a memory test. → ✅ Plural everywhere; singular only for true singletons like `/me` or `/settings`.
3. ⚠️ **Mixed casing in one document** — `customerId` next to `created_at` next to `Total`. → ✅ One casing per layer (`kebab-case` paths, one of `snake_case`/`camelCase` for fields), enforced by a linter.
4. ⚠️ **`camelCase` or uppercase in paths** — `/lineItems` and `/LineItems` are different resources under RFC 3986, and both will get hit. → ✅ Lowercase kebab-case path segments, always.
5. ⚠️ **Inconsistent pagination parameter names** — `page`/`per_page` on one endpoint, `offset`/`limit` on another, `page_token` on a third. → ✅ One reserved set defined as shared OpenAPI `components.parameters` and `$ref`ed everywhere.
6. ⚠️ **Exposing internal database identifiers** — `/orders/40213` leaks row counts, enables enumeration, and welds your URL space to your primary-key scheme. → ✅ Opaque, prefixed, non-sequential ids (`ord_01JQ8Z…`) generated from ULIDs or UUIDs.
7. ⚠️ **Deep nesting** — `/orgs/{o}/teams/{t}/projects/{p}/tasks/{k}/comments/{c}` is unusable and welds four hierarchies together forever. → ✅ Nest at most one level below the parent; address deeper resources directly (`/comments/{c}`) and filter (`/comments?task_id=…`).
8. ⚠️ **Trailing slashes treated as significant** — `/orders` and `/orders/` becoming different routes splits caches and confuses SDKs. → ✅ Pick the no-trailing-slash form and `301` the other; lint for it.
9. ⚠️ **File extensions in paths** — `/orders.json`, `/orders.xml` duplicate what `Accept` already does. → ✅ Content negotiation via headers; keep one URI per resource.
10. ⚠️ **Abbreviations that only your team knows** — `/cust/{id}/pmts`, fields like `crtd`, `amt`, `usr_nm`. → ✅ Spell words out. Bytes are free after compression; comprehension is not.
11. ⚠️ **Unnamespaced, colliding custom headers** — three teams inventing `X-Trace-Id` with three formats. → ✅ Use standard headers where they exist; namespace genuinely custom ones (`Zariya-Trace-Id`) and register them centrally.
12. ⚠️ **Treating the style guide as documentation instead of a gate** — a beautiful markdown file nobody's build depends on. → ✅ Lint the OpenAPI document in CI at `--fail-severity=warn`; a naming violation must break the build like a failing test.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** Consistent naming is a debugging feature. When every service names its correlation header identically and every route is instrumented by template, a single trace query spans the whole estate. Standardise on W3C `traceparent` plus one request-id header, and enforce that all services emit the same `http.route` label format. When investigating a client complaint, the first question is usually "which endpoint?" — an API with guessable names lets the customer tell you accurately, while one with `/api/v2/data/process` gets you a support ticket that says "the data one".

**Monitoring.** Label every HTTP metric with the **route template**, never the raw path — `/v1/orders/{order_id}`, not `/v1/orders/ord_01JQ8Z`. Unbounded label cardinality is the classic way to take down a Prometheus instance, and it is a naming discipline as much as an instrumentation one. Add a **lint-debt metric**: count style-guide violations across all published specs and track it weekly; if it is not visibly trending down, your guide has become decorative. Track `404` rates on near-miss paths (`/user/…` when you serve `/users/…`) — a persistent stream of those means real clients are guessing the wrong convention, which is direct evidence of an inconsistency worth fixing.

**Security.** Naming leaks information. Sequential integer ids in paths (`/invoices/40213`) advertise your volume and invite enumeration — the classic **OWASP API1: Broken Object Level Authorization** exploit is simply incrementing an id and seeing what comes back, and predictable ids make it trivial. Use opaque, non-sequential identifiers, and note that this is defence in depth, not authorization: **every** object access must still be authorized server-side, because an opaque id that leaks once is still a valid id forever. Beware verb-in-path endpoints that bypass your method-based policy engine — a WAF rule permitting `GET` on `/admin/*` is useless against `GET /admin/deleteUser?id=5`. And do not name endpoints or fields after internal systems (`/ldap-sync`, `internal_risk_score`), which hands an attacker a map of your architecture.

**Performance & scaling.** Canonical URLs are the foundation of cache efficiency: one resource, one URI, one cache key. Duplicate spellings, optional trailing slashes, and free-form query-parameter ordering all fragment CDN caches — normalise at the edge and measure hit rate before and after. On the organisational scale axis, the shared-components approach (`$ref` to a central `Money`, `Error`, `PageInfo`) is what lets an API grow from five to five hundred endpoints without divergence, because the common pieces are physically shared rather than copied. Finally, budget for the migration cost of legacy names explicitly: a rename is a dual-emit period, a deprecation window, per-client usage instrumentation, and a removal release — typically six to twelve months. Knowing that number is what keeps the "let's just fix it" conversation honest.

## 9. Interview Questions

**Q: Why shouldn't URIs contain verbs?**
A: The HTTP method is already the verb, so `POST /createOrder` states the action twice and creates an endpoint whose semantics intermediaries cannot infer. Keeping the path a pure noun lets caches, proxies and clients rely on HTTP's guarantees — `GET` is safe and cacheable, `PUT` and `DELETE` are idempotent — which they cannot do for `/doThing`. The path answers "what", the method answers "what to do with it".

**Q: Plural or singular collection names?**
A: Plural, by overwhelming convention: `/invoices` for the collection and `/invoices/{id}` for a member reads correctly in both cases. Singular is reserved for genuine singletons where a plural would be a lie — `/me`, `/settings`, `/health`. The actual cost is not which you pick but mixing the two, because then every endpoint is a memory test.

**Q: `snake_case` or `camelCase` for JSON fields?**
A: Both are defensible and both are widely deployed — GitHub, Stripe and Zalando use `snake_case`; Google and Microsoft mandate `camelCase`. The right answer is to pick one, write it into the style guide, and enforce it with a linter, because mixed casing in a single document is the only genuinely wrong outcome. If you're weighing them, match your primary consumer's language.

**Q: How do you model an operation that isn't CRUD, like cancelling an order?**
A: Use a controller resource: `POST /orders/{id}/cancel`. It is honest about the fact that cancellation is a state transition with side effects rather than a field write, it is not idempotent-by-accident the way `PATCH {"status":"cancelled"}` would be, and it gives you a place to accept operation-specific parameters like a cancellation reason. The discipline is that it must be rare, must use `POST`, and the verb must appear only in the final segment.

**Q: Why use opaque IDs instead of database primary keys in URLs?**
A: Sequential integers leak business volume, are trivially enumerable, and permanently couple your public URL space to your storage layer, so you can never change primary-key strategy or shard without breaking clients. Opaque prefixed identifiers like `ord_01JQ8Z…` cost nothing, make the object type self-evident in logs, and remove the enumeration oracle. They are defence in depth, not a substitute for per-object authorization.

**Q: How deep should resource nesting go?**
A: One level below the parent, as a rule. `/orders/{id}/line-items` is fine; `/orgs/{o}/teams/{t}/projects/{p}/tasks/{k}/comments/{c}` is not, because it hardcodes a four-level hierarchy that will eventually change and forces clients to know the whole chain to fetch one comment. Give deep resources their own top-level address and let query parameters express the relationship: `/comments?task_id=…`.

**Q: What's wrong with `X-` prefixed custom headers?**
A: RFC 6648 deprecated the convention in 2012 and RFC 9110 carries that guidance forward: the prefix was meant to mark experimental headers, but the "experiments" always became permanent, leaving a fossilised `X-` on standard-in-practice headers. The recommendation is unprefixed, namespaced names. In reality `X-Request-Id` and friends are so entrenched that following the RFC exactly can cost interoperability, so use standard headers where they exist and namespace only genuinely new ones.

**Q: How would you enforce naming conventions across a dozen teams?**
A: Write the guide as numbered rules, encode the mechanically checkable ones as Spectral rules against the OpenAPI document, and run them in CI at a failing severity so a violation blocks the merge exactly like a broken test. Publish shared `components` for `Money`, `Error`, and the reserved pagination parameters so common pieces are `$ref`ed rather than reinvented. Keep a small human review group for the judgement calls a linter cannot make.

**Q: (Senior) You inherit an API with `/getUser`, `/users`, and `/user-list` all live. What's your plan?**
A: Do not rename anything immediately — all three have callers. First, instrument per-endpoint usage by client id so you know the actual blast radius, which is almost always smaller and more concentrated than feared. Then declare the canonical form (`GET /v1/users`), implement it, and make the legacy paths thin aliases that internally serve the canonical handler so behaviour cannot drift. Mark the aliases deprecated in the spec, emit `Deprecation` and `Sunset` headers (RFC 8594) with a real date, contact the top consumers directly, and only remove once usage is zero or the sunset has passed. In parallel, add the lint gate so no *new* violations can be introduced — stopping the bleeding matters more than the cleanup.

**Q: (Senior) Is a naming inconsistency worth a breaking change?**
A: Almost never on its own. The cost of a rename is a dual-emit period, a deprecation window measured in months, per-client instrumentation, direct outreach, and a removal release — and the benefit is developer comfort, not capability. The right time to fix naming is when you are already making a major version for substantive reasons, so the inconsistency rides along at near-zero marginal cost. The corollary is that the linter must be in place from day one, because prevention is roughly two orders of magnitude cheaper than correction.

**Q: (Senior) How do naming choices affect observability and cost?**
A: Route templates are metric labels, so instrumenting by concrete path (`/v1/orders/ord_01JQ8Z`) rather than template (`/v1/orders/{order_id}`) creates one time series per order and will exhaust your metrics backend — an outage caused entirely by a naming discipline failure. On the caching side, every alternative spelling of the same resource is a separate cache key, so trailing-slash variants, mixed casing, and unordered query parameters silently fragment CDN hit rate. Canonicalising URLs and normalising query strings at the edge is often the cheapest available performance win, and consistent naming is what makes it possible to do automatically rather than endpoint by endpoint.

**Q: (Senior) When does a query parameter belong in the path instead?**
A: If the value is part of the resource's *identity* — it determines which thing you are addressing and would be part of a permalink you'd bookmark or send to someone — it belongs in the path: `/orders/{order_id}`, `/customers/{customer_id}/invoices`. If it is a *projection* of a collection — a filter, sort, page, or field selection that yields a different view of the same underlying set — it belongs in the query string. The practical tests are whether the resource still makes sense without it (if not, it's identity) and whether it is cacheable and shareable as a stable URL. Encoding filters as path segments (`/orders/status/open/priority/high`) creates a combinatorial URL space with no natural canonical form and defeats both caching and documentation.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Paths are lowercase kebab-case plural nouns; the verb is the HTTP method. Members are `/collection/{id}` with opaque prefixed ids, never database keys. Nest one level, then flatten and filter. Non-CRUD operations get a `POST /resource/{id}/verb` controller, used sparingly. JSON fields are consistently `snake_case` or `camelCase` — pick one — with `_at` for instants, `_on` for dates, `_id` for foreign keys, `is_`/`has_` for booleans, `_count` for counts, and an explicit unit suffix for every quantity. Query parameters use one reserved set API-wide: `limit`, `cursor`/`offset`, `sort` (with `-` for descending), `fields`, `expand`, `q`. Enum values are `SCREAMING_SNAKE_CASE` or lowercase — again, pick one. Prefer standard headers; namespace custom ones. And the meta-rule that outranks all of the above: **write it down as numbered rules and lint it in CI**, because a convention nobody's build depends on is a preference, not a convention.

| Element | Convention | Example |
|---|---|---|
| Collection path | lowercase, plural, kebab-case | `/v1/payment-methods` |
| Member path | collection + opaque id | `/v1/orders/ord_01JQ8Z` |
| Sub-resource | one level of nesting | `/v1/orders/{id}/line-items` |
| Action / controller | `POST` + verb in last segment | `POST /v1/orders/{id}/cancel` |
| JSON field | one casing, API-wide | `created_at` or `createdAt` |
| Timestamp / date | `_at` instant, `_on` calendar date | `paid_at`, `due_on` |
| Foreign key | `<entity>_id` | `customer_id` |
| Boolean | predicate prefix | `is_default`, `has_children` |
| Quantity | explicit unit suffix | `timeout_ms`, `amount_minor` |
| Enum value | one casing, documented as extensible | `PAYMENT_FAILED` or `payment_failed` |
| Pagination | `limit` + `cursor` (or `offset`) | `?limit=25&cursor=cGF5` |
| Sorting | `sort`, `-` prefix = descending | `?sort=-created_at,name` |
| Sparse fields | `fields` | `?fields=id,status` |
| Search | `q` | `?q=refund+failed` |
| Custom header | namespaced, no `X-` | `Zariya-Trace-Id` |

**Flash cards**

- **Where does the verb live?** → In the HTTP method, never in the path. `POST /orders`, not `POST /createOrder`.
- **Plural or singular?** → Plural for collections; singular only for true singletons (`/me`, `/settings`). Never mix.
- **What does `sort=-created_at` mean?** → Descending by `created_at`; the leading `-` composes across multiple keys.
- **Why not expose database IDs?** → They leak volume, invite enumeration, and weld your URLs to your storage layer.
- **What makes a convention real?** → A lint rule in CI that fails the build — not a document.

## 11. Hands-On Exercises & Mini Project

- [ ] Take twenty endpoints from an API you work on and score each against this chapter's rules; produce a table of violations ranked by how many clients would break if fixed.
- [ ] Write five Spectral rules (path casing, no verbs, no trailing slash, `snake_case` properties, required `operationId`) and run them against a real OpenAPI document.
- [ ] Design the URL space for a multi-tenant project-management API (organisations, projects, tasks, comments, attachments, members) using at most one level of nesting, and justify each flattening decision.
- [ ] Write a runtime conformance test that crawls your service's list endpoints and asserts every JSON key matches the house casing.
- [ ] Pick one legacy misnamed field in a real API and write the complete migration plan: dual-emit, `Deprecation`/`Sunset` headers, per-client usage metric, and removal criteria.

### Mini Project — The API Style Guide and Its Gate

**Goal.** Produce a publishable style guide plus the machinery that makes it unavoidable, then prove it by migrating a deliberately inconsistent service into compliance.

**Requirements.**
1. A `STYLE_GUIDE.md` with at least 30 numbered rules covering paths, methods, status codes, field naming, query parameters, enums, headers and errors. Each rule has a ✅ and ❌ example.
2. A Spectral ruleset implementing every mechanically checkable rule, with rule IDs matching the guide's numbers so violations cite the guide.
3. A shared `components.yaml` defining `Money`, `Error` (RFC 9457), `PageInfo`, and the reserved query parameters, `$ref`ed by all paths.
4. A deliberately inconsistent seed API (at least 12 endpoints with verbs in paths, mixed casing, mixed pagination) plus a migration that makes it fully compliant while keeping legacy paths working as aliases.
5. CI: `spectral lint` at `--fail-severity=warn`, plus a runtime test asserting response keys match the house casing.
6. A `DEPRECATIONS.md` listing each legacy alias with its `Sunset` date and current usage count.

**Extensions.**
- Add a schema-diff gate that blocks any field rename or removal against the last released spec.
- Generate a TypeScript SDK from the spec and show that consistent naming produces a coherent, guessable client surface.
- Add a metric exporting per-legacy-alias request counts by client id and a dashboard that visualises the drain toward zero.
- Publish the guide as a static site and add a "propose a rule change" process with a written exception register.

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *Resources & URI Design* establishes the resource model these names describe; *Request & Response Payload Design* covers field types and nullability once the names are settled; *HTTP Methods* explains why verbs belong there and not in the path; *Filtering, Sorting & Searching* specifies the reserved query parameters in detail; *Pagination* owns `limit`/`cursor`; *Versioning & Deprecation* is how you fix a bad name without breaking clients; *OpenAPI & Documentation* is where the linter runs.

- **Google API Design Guide — Naming Conventions** — Google · *Intermediate* · the most rigorous public treatment of resource naming, collection identifiers and standard field names. <https://cloud.google.com/apis/design/naming_convention>
- **Zalando RESTful API Guidelines** — Zalando · *Intermediate* · ~180 numbered MUST/SHOULD rules; the best template for writing your own guide. <https://opensource.zalando.com/restful-api-guidelines/>
- **Microsoft REST API Guidelines** — Microsoft · *Intermediate* · opinionated conventions for casing, pagination and filtering, battle-tested across Azure. <https://github.com/microsoft/api-guidelines/blob/vNext/azure/Guidelines.md>
- **RFC 3986 — Uniform Resource Identifier (URI): Generic Syntax** — IETF · *Advanced* · the normative source on what is legal in a path, and why paths are case-sensitive. <https://www.rfc-editor.org/rfc/rfc3986.html>
- **Spectral — OpenAPI/AsyncAPI linter documentation** — Stoplight · *Intermediate* · how to write custom rules; the practical tool for enforcing a style guide in CI. <https://docs.stoplight.io/docs/spectral/674b27b261c3c-overview>
- **GitHub REST API documentation** — GitHub · *Beginner* · the best public example of a large, consistently named API; read five endpoints and predict the sixth. <https://docs.github.com/en/rest>
- **API Design Patterns and the Richardson Maturity Model** — Martin Fowler · *Intermediate* · the essay that framed resources, verbs and hypermedia as levels of maturity. <https://martinfowler.com/articles/richardsonMaturityModel.html>
- **MDN — HTTP headers reference** — Mozilla · *Beginner* · check here before inventing a custom header; a standard one usually already exists. <https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers>

---

*REST API Handbook — chapter 09.*
