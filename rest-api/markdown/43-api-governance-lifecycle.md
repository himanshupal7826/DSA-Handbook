# 43 · API Governance, Lifecycle & Developer Portals

> **In one line:** Governance is the machinery — style guides, linters, review boards, catalogs and portals — that keeps hundreds of independently-built APIs feeling like one coherent, long-lived product.

---

## 1. Overview

A single API designed by one thoughtful engineer is usually fine. **Fifty APIs designed by forty engineers across twelve teams over six years** is a different animal: one service returns `{"error": "..."}`, another returns RFC 9457 `application/problem+json`; one paginates with `?page=2`, another with `?cursor=...`, a third with `?offset=`; one uses `snake_case`, another `camelCase`; three of them expose the same customer object under three different shapes. Consumers pay the tax, integration takes weeks instead of hours, and nobody can answer the question "how many APIs do we have and who owns them?"

**API governance** is the discipline that prevents that entropy. It is *not* an architecture-review committee that blocks shipping. Modern governance is mostly **automation plus a small amount of human judgment**: a written style guide, a linter (Spectral) that enforces the mechanical parts of it in CI, a design-review step for the parts a machine cannot judge, a **catalog** that knows every API and its owner, and a **developer portal** where consumers discover, try and get keys for those APIs.

Governance exists because APIs have unusually long half-lives. A UI can be redesigned over a weekend; a public API endpoint with 4,000 integrations is effectively permanent. Hyrum's Law applies with force: *with a sufficient number of users, every observable behaviour of your API will be depended upon by somebody.* So the cost of a bad design decision is not "we fix it next sprint" — it's "we carry it for a decade." Governance front-loads the cheap fixes (naming, error shape, pagination style) to the design stage where they cost minutes.

The lineage: enterprises started with heavyweight SOA governance boards in the 2000s (WS-* registries, UDDI, mandatory sign-off) which became notorious bottlenecks. The industry corrected toward **"governance as code"** around 2018–2020 — Zalando published its RESTful API Guidelines as a public living document, Stoplight open-sourced **Spectral** for linting OpenAPI, Google and Microsoft published their API design guides, and platform teams began treating the style guide as a lint ruleset rather than a PDF.

**Concrete example.** Stripe runs one of the most disciplined API lifecycles in the industry: every change is reviewed against an internal design standard, versions are dated (`2024-06-20`), *every account is pinned to the version it first integrated against*, and Stripe maintains compatibility shims so old versions keep working for years. Their public changelog, upgrade guides, deprecation notices and generated SDKs are the visible surface of a governance process most companies never build. The result is that a 2016 Stripe integration still runs — and that is a governance achievement, not a coding one.

## 2. Core Concepts

- **API style guide** — the normative document defining naming, URI structure, error format, pagination, versioning and auth conventions that every API in the org must follow.
- **Linting (Spectral)** — automated rule evaluation over an OpenAPI/AsyncAPI document; each rule has a severity (`error`, `warn`, `info`, `hint`) and fails CI at the configured threshold.
- **Design review** — a short human review of a *proposed* OpenAPI spec before implementation, covering resource modelling, semantics and consumer impact — the things a linter cannot judge.
- **API catalog (registry)** — the authoritative inventory of every API: spec, owner, tier, lifecycle stage, environments, dependencies and SLOs. Answers "what exists and who owns it?"
- **Developer portal** — the consumer-facing surface: docs, interactive try-it console, SDKs, changelogs, key/credential self-service, and support channels.
- **Lifecycle stage** — the declared maturity of an API: `experimental` → `beta` → `stable` (GA) → `deprecated` → `sunset` → `retired`. Each stage carries different compatibility guarantees.
- **Deprecation vs sunset** — *deprecation* (`Deprecation` header, RFC 8594-adjacent) means "still works, stop using it"; *sunset* (`Sunset` header, RFC 8594) is the timestamp after which it stops working.
- **API product** — an API treated with product management: a defined audience, a value proposition, adoption metrics, a roadmap, pricing/quota tiers and a support model.
- **Spec-first (design-first)** — the OpenAPI document is authored and reviewed *before* code; the server and clients are generated or validated against it. The opposite is code-first, where the spec is a by-product of annotations.
- **Governance-as-code** — expressing the style guide as executable rules (Spectral rulesets, CI gates, scaffold templates) rather than prose that humans must remember.
- **Federated governance** — a small central platform team owns the rules and tooling; domain teams own their APIs and are accountable to those rules. The alternative — a central team designing everything — does not scale.

## 3. Theory & Principles

### The three levers of consistency

Any governance system pulls three levers, in increasing order of cost and decreasing order of scale:

1. **Defaults** (cheapest, most effective) — scaffolds and templates that already do the right thing. If `create-service` generates a project with RFC 9457 error handlers, cursor pagination helpers and a conformant OpenAPI skeleton, most teams never deviate. *Governance you never have to enforce is the only kind that scales.*
2. **Automation** — a linter in CI. Catches ~70–80% of style-guide violations mechanically: missing `operationId`, undocumented `4xx` responses, `snake_case` violations, verbs in paths, unbounded array responses, missing `security` on an operation.
3. **Human review** — reserved for what machines cannot evaluate: is this actually a resource? Is this the right granularity? Will this break a consumer? Is this endpoint duplicating one another team already ships?

The failure mode of most governance programs is inverting this pyramid: heavy human review, no automation, no good defaults.

### Rule severity is a budget, not a taxonomy

A Spectral ruleset with 200 `error`-severity rules produces 4,000 findings on a legacy spec and gets disabled within a week. The workable model:

- `error` — breaks the org's contract with consumers (wrong error format, missing auth, breaking change on a stable API). Blocks merge.
- `warn` — style deviation with real cost (missing `description`, no `example`). Reported, tracked, does not block.
- `info` / `hint` — nudges.

Then apply a **ratchet**: new APIs must be error-clean *and* warn-clean; existing APIs must not increase their warning count. This lets you introduce governance to a brownfield estate without a big-bang cleanup.

### Compatibility as a formal property

The core theoretical rule of API lifecycle is the **compatibility contract**, and it's asymmetric:

| Change | Backward compatible? | Why |
|---|---|---|
| Add an optional request field | ✅ | Old clients omit it; server has a default |
| Add a response field | ✅ *if* clients tolerate unknown fields | Must be stated in the style guide ("must-ignore" rule) |
| Add a new enum value in a **response** | ❌ (usually) | Client `switch` statements break |
| Add a new enum value in a **request** | ✅ | Old clients simply never send it |
| Make an optional request field required | ❌ | Old requests now 400 |
| Remove/rename a response field | ❌ | Client field access breaks |
| Loosen a validation constraint | ✅ for requests, ❌ for responses | Requests: more input accepted. Responses: clients may have tighter parsing |
| Change a status code `200` → `201` | ❌ | Clients branch on status |

The **must-ignore rule** ("consumers MUST ignore unknown fields, producers MUST NOT rely on that") is what makes response-field addition safe at all. It must be written into the style guide *and* into the generated SDKs, or you don't actually have it.

### The economics: why governance pays

Let *N* be the number of APIs and *C* the number of consuming teams. Without conventions, each consumer must learn each API's idiosyncrasies: integration cost scales as **O(N × C)**. With a shared style guide, a consumer learns the *conventions once* and each new API costs only its domain semantics: cost approaches **O(N + C)**. At N=50, C=12 that is the difference between 600 learning events and 62. This single argument is what you use to justify a platform team.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="740" height="320" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">The governance pyramid: cost per unit of consistency</text>

  <polygon points="380,60 620,300 140,300" fill="#ffffff" stroke="#4f46e5" stroke-width="1.5"/>

  <line x1="220" y1="220" x2="540" y2="220" stroke="#4f46e5" stroke-dasharray="4 3"/>
  <line x1="300" y1="140" x2="460" y2="140" stroke="#4f46e5" stroke-dasharray="4 3"/>

  <rect x="300" y="72" width="160" height="62" fill="#fef3c7" stroke="#d97706"/>
  <text x="380" y="94" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Human review</text>
  <text x="380" y="110" text-anchor="middle" fill="#1e293b" font-size="10">resource modelling,</text>
  <text x="380" y="124" text-anchor="middle" fill="#1e293b" font-size="10">consumer impact</text>

  <rect x="228" y="152" width="304" height="60" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="380" y="176" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Automated linting (Spectral in CI)</text>
  <text x="380" y="196" text-anchor="middle" fill="#1e293b" font-size="10">naming, error shape, required responses, security</text>

  <rect x="150" y="230" width="460" height="62" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="380" y="254" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Defaults: scaffolds, templates, shared libraries</text>
  <text x="380" y="274" text-anchor="middle" fill="#1e293b" font-size="10">the right thing is already generated &#8212; nothing to enforce</text>

  <text x="648" y="96" fill="#1e293b" font-size="11" font-weight="700">high cost</text>
  <text x="648" y="112" fill="#1e293b" font-size="11">low scale</text>
  <text x="640" y="266" fill="#1e293b" font-size="11" font-weight="700">low cost</text>
  <text x="640" y="282" fill="#1e293b" font-size="11">high scale</text>
  <path d="M700 130 L700 250" stroke="#4f46e5" stroke-width="2" marker-end="url(#gpArrow)"/>
  <defs>
    <marker id="gpArrow" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#4f46e5"/>
    </marker>
  </defs>
</svg>
```

### Lifecycle guarantees per stage

| Stage | Breaking changes | SLO | Discoverable | Header signal |
|---|---|---|---|---|
| `experimental` | Any time, no notice | none | internal only | `X-API-Lifecycle: experimental` |
| `beta` | With 30 days notice | best effort | portal, flagged | `X-API-Lifecycle: beta` |
| `stable` | Never (new version only) | contractual | portal, default | — |
| `deprecated` | Never | unchanged | portal, warned | `Deprecation: @1735689600` |
| `sunset` | Endpoint returns `410` after date | — | archived | `Sunset: Wed, 01 Jan 2026 00:00:00 GMT` |

## 4. Architecture & Workflow

The end-to-end path from "team wants a new API" to "consumers are calling it in production," with governance touchpoints:

1. **Proposal.** The owning team files an *API proposal*: purpose, audience (internal / partner / public), expected consumers, and a first-draft OpenAPI 3.1 document with paths, schemas and error responses. No implementation yet.
2. **Catalog registration.** The proposal creates a catalog entry with an owner (a team, not a person), a tier (T0 revenue-critical … T3 internal tooling), and a lifecycle stage of `experimental`.
3. **Automated lint.** CI runs `spectral lint openapi.yaml --ruleset .spectral.yaml`. Errors block the PR. This is the first and cheapest gate.
4. **Design review.** For public/partner APIs and any T0/T1 internal API, a 30-minute review with two reviewers from the API guild. Reviewers check: correct resource nouns, correct HTTP semantics, sensible granularity, no duplication with an existing API, sane pagination and filtering, and PII/authorization posture.
5. **Contract publication.** The approved spec is published to the **spec registry** at a versioned, immutable URL. Everything downstream — mocks, SDKs, docs, gateway config, contract tests — is generated from that artifact.
6. **Parallel build.** The server team implements against the spec; consumer teams develop against a **Prism mock** served from the same spec. Neither blocks the other.
7. **Conformance gate.** Before deploy, CI runs (a) schema validation of live responses against the spec, and (b) **breaking-change detection** — diff the new spec against the currently deployed one (`oasdiff`) and fail on any breaking delta unless a version bump is declared.
8. **Gateway rollout.** The gateway loads routes, rate-limit tiers and auth scopes from the spec's extensions. The API becomes reachable.
9. **Portal publication.** The portal renders docs, a try-it console, changelog entry and generated SDKs from the same spec artifact. Consumers self-serve credentials.
10. **Operate & measure.** Per-consumer usage, error rate, p95 latency and adoption are attributed back to the catalog entry. The owning team sees "who calls me, how much, how badly."
11. **Evolve.** Additive changes ship freely. Breaking changes require a new version *and* a migration plan; the old version enters `deprecated` with `Deprecation` and `Sunset` headers plus portal banners and targeted emails to top consumers.
12. **Sunset.** After the announced date (typically 6–12 months for public APIs), traffic is progressively "brownout"-ed — short scheduled outages that surface remaining integrations — then the endpoint returns `410 Gone` and the catalog entry moves to `retired`.

```svg
<svg viewBox="0 0 780 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="8" y="8" width="764" height="384" rx="14" fill="#ffffff" stroke="#4f46e5"/>
  <text x="390" y="34" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Spec-first lifecycle: one artifact, many consumers</text>

  <rect x="30" y="58" width="140" height="52" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="100" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Proposal</text>
  <text x="100" y="97" text-anchor="middle" fill="#1e293b" font-size="10">draft openapi.yaml</text>

  <rect x="200" y="58" width="140" height="52" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="270" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Spectral lint</text>
  <text x="270" y="97" text-anchor="middle" fill="#1e293b" font-size="10">CI gate, error = block</text>

  <rect x="370" y="58" width="140" height="52" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="440" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Design review</text>
  <text x="440" y="97" text-anchor="middle" fill="#1e293b" font-size="10">2 guild reviewers</text>

  <rect x="540" y="58" width="200" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="640" y="80" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Spec registry</text>
  <text x="640" y="97" text-anchor="middle" fill="#1e293b" font-size="10">immutable versioned artifact</text>

  <line x1="170" y1="84" x2="198" y2="84" stroke="#4f46e5" stroke-width="2" marker-end="url(#lcA)"/>
  <line x1="340" y1="84" x2="368" y2="84" stroke="#4f46e5" stroke-width="2" marker-end="url(#lcA)"/>
  <line x1="510" y1="84" x2="538" y2="84" stroke="#4f46e5" stroke-width="2" marker-end="url(#lcA)"/>

  <line x1="640" y1="110" x2="640" y2="140" stroke="#16a34a" stroke-width="2"/>
  <line x1="120" y1="140" x2="700" y2="140" stroke="#16a34a" stroke-width="2"/>

  <rect x="40" y="160" width="150" height="66" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="115" y="184" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Mock server</text>
  <text x="115" y="201" text-anchor="middle" fill="#1e293b" font-size="10">Prism &#8212; consumers</text>
  <text x="115" y="215" text-anchor="middle" fill="#1e293b" font-size="10">build in parallel</text>

  <rect x="210" y="160" width="150" height="66" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="285" y="184" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">SDK generation</text>
  <text x="285" y="201" text-anchor="middle" fill="#1e293b" font-size="10">python / ts / go</text>
  <text x="285" y="215" text-anchor="middle" fill="#1e293b" font-size="10">must-ignore built in</text>

  <rect x="380" y="160" width="150" height="66" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="455" y="184" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Gateway config</text>
  <text x="455" y="201" text-anchor="middle" fill="#1e293b" font-size="10">routes, scopes,</text>
  <text x="455" y="215" text-anchor="middle" fill="#1e293b" font-size="10">rate-limit tiers</text>

  <rect x="550" y="160" width="150" height="66" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="625" y="184" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Developer portal</text>
  <text x="625" y="201" text-anchor="middle" fill="#1e293b" font-size="10">docs, try-it,</text>
  <text x="625" y="215" text-anchor="middle" fill="#1e293b" font-size="10">keys, changelog</text>

  <line x1="115" y1="140" x2="115" y2="158" stroke="#0ea5e9" stroke-width="2" marker-end="url(#lcA)"/>
  <line x1="285" y1="140" x2="285" y2="158" stroke="#0ea5e9" stroke-width="2" marker-end="url(#lcA)"/>
  <line x1="455" y1="140" x2="455" y2="158" stroke="#0ea5e9" stroke-width="2" marker-end="url(#lcA)"/>
  <line x1="625" y1="140" x2="625" y2="158" stroke="#0ea5e9" stroke-width="2" marker-end="url(#lcA)"/>

  <rect x="40" y="256" width="660" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="370" y="278" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Conformance gate: live responses validated vs spec + oasdiff breaking-change check</text>
  <text x="370" y="296" text-anchor="middle" fill="#1e293b" font-size="10">breaking delta without a version bump &#8594; deploy blocked</text>

  <rect x="40" y="326" width="660" height="48" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="370" y="346" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Operate &#8594; Deprecate (Deprecation hdr) &#8594; Sunset (Sunset hdr, brownouts) &#8594; 410 Gone</text>
  <text x="370" y="364" text-anchor="middle" fill="#1e293b" font-size="10">usage attributed per consumer in the catalog; top consumers emailed directly</text>

  <defs>
    <marker id="lcA" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#4f46e5"/>
    </marker>
  </defs>
</svg>
```

## 5. Implementation

### The style guide as an executable Spectral ruleset

```yaml
# .spectral.yaml  — extends the community OpenAPI ruleset, adds house rules
extends: ["spectral:oas"]

functionsDir: "./lint-functions"

rules:
  # --- Naming -------------------------------------------------------------
  path-segments-kebab-case:
    description: Path segments must be lowercase kebab-case plural nouns.
    severity: error
    given: $.paths[*]~
    then:
      function: pattern
      functionOptions:
        match: "^(/([a-z0-9]+(-[a-z0-9]+)*|\\{[a-zA-Z0-9_]+\\}))+$"

  no-verbs-in-paths:
    description: "Use HTTP methods, not verbs in the URI (e.g. /orders/{id}:cancel is allowed, /cancelOrder is not)."
    severity: error
    given: $.paths[*]~
    then:
      function: pattern
      functionOptions:
        notMatch: "(?i)/(get|create|update|delete|list|fetch|make|do)[A-Za-z]*"

  properties-snake-case:
    description: Response/request property names must be snake_case.
    severity: error
    given: $..[?(@property === 'properties')].*~
    then:
      function: casing
      functionOptions: { type: snake }

  # --- Errors -------------------------------------------------------------
  errors-use-problem-json:
    description: All 4xx/5xx responses must use application/problem+json (RFC 9457).
    severity: error
    given: $.paths[*][*].responses[?(@property.match(/^(4|5)\d\d$/))].content
    then:
      field: "application/problem+json"
      function: truthy

  must-document-401-and-429:
    description: Every secured operation documents 401 and 429.
    severity: error
    given: $.paths[*][get,post,put,patch,delete].responses
    then:
      - field: "401"
        function: truthy
      - field: "429"
        function: truthy

  # --- Collections --------------------------------------------------------
  collections-must-paginate:
    description: GET on a collection must declare a `limit` and `cursor` parameter.
    severity: error
    given: $.paths[?(@property.match(/[^}]$/))].get.parameters
    then:
      function: hasPaginationParams   # custom function in ./lint-functions

  # --- Security -----------------------------------------------------------
  operation-security-defined:
    description: Every operation declares `security` (use `security: []` to opt out explicitly).
    severity: error
    given: $.paths[*][get,post,put,patch,delete]
    then:
      field: security
      function: defined

  # --- Documentation quality (non-blocking) -------------------------------
  operation-has-summary-and-description:
    severity: warn
    given: $.paths[*][get,post,put,patch,delete]
    then:
      - field: summary
        function: truthy
      - field: description
        function: truthy

  schema-properties-have-examples:
    severity: warn
    given: $.components.schemas[*].properties[*]
    then:
      field: example
      function: defined
```

Run it in CI with the ratchet:

```bash
# Block on errors; record the warning count and compare against the baseline.
spectral lint openapi.yaml --ruleset .spectral.yaml --fail-severity=error --format=json > lint.json

WARNS=$(jq '[.[] | select(.severity == 1)] | length' lint.json)
BASE=$(cat .lint-baseline)
if [ "$WARNS" -gt "$BASE" ]; then
  echo "Warning count increased: $BASE -> $WARNS. Fix or update the baseline with justification."
  exit 1
fi

# Breaking-change detection against the currently deployed spec.
oasdiff breaking https://specs.internal/payments/v1/latest.yaml openapi.yaml --fail-on ERR
```

### Deprecation signalling on the wire

Deprecation must be visible **in the response**, not only in a blog post. Consumers read logs, not blogs.

```http
GET /v1/customers/cus_9Kd2 HTTP/1.1
Host: api.zariya.in
Authorization: Bearer sk_live_9d2...
Accept: application/json
```

```http
HTTP/1.1 200 OK
Content-Type: application/json
Deprecation: @1767225600
Sunset: Wed, 01 Jul 2026 00:00:00 GMT
Link: <https://developers.zariya.in/guides/migrate-v1-to-v2>; rel="deprecation"; type="text/html",
      <https://api.zariya.in/v2/customers/cus_9Kd2>; rel="successor-version"
Warning: 299 - "Endpoint deprecated; migrate to /v2/customers before 2026-07-01"
Cache-Control: private, max-age=0

{
  "id": "cus_9Kd2",
  "email": "asha@example.com",
  "created_at": "2024-03-11T09:41:22Z"
}
```

> **Note:** `Deprecation` takes an IMF-fixdate or an `@`-prefixed Unix timestamp per the deprecation-header draft; `Sunset` is defined by **RFC 8594** and is always an HTTP-date. After the sunset date the endpoint should return `410 Gone` — not `404`, which implies "maybe it never existed."

### The catalog entry as code

Store the catalog next to the service, not in a wiki that rots.

```yaml
# api.yaml — read by the platform's catalog ingester on every merge to main
apiVersion: catalog.zariya.in/v1
kind: API
metadata:
  name: payments-api
  slug: payments
spec:
  owner: team-payments            # a team handle, never a person
  tier: T0                        # T0 revenue-critical … T3 internal tooling
  lifecycle: stable
  audience: public
  spec_url: https://specs.internal/payments/v1/openapi.yaml
  repository: https://github.com/zariya/payments-api
  runbook: https://runbooks.internal/payments
  slack: "#payments-oncall"
  environments:
    prod: https://api.zariya.in/v1
    sandbox: https://api.sandbox.zariya.in/v1
  slo:
    availability: "99.95%"
    latency_p99_ms: 300
    error_budget_window: 30d
  dependencies: [ledger-api, fraud-scoring-api, kyc-api]
  data_classification: [pii, financial]
  deprecation: null
```

### Serving lifecycle metadata from the API itself (FastAPI)

```python
from datetime import datetime, timezone
from email.utils import format_datetime
from fastapi import APIRouter, FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(title="Payments API", version="1.14.0")

SUNSET = {  # path prefix -> (sunset datetime, migration guide)
    "/v1/": (
        datetime(2026, 7, 1, tzinfo=timezone.utc),
        "https://developers.zariya.in/guides/migrate-v1-to-v2",
    ),
}


@app.middleware("http")
async def lifecycle_headers(request: Request, call_next):
    response = await call_next(request)
    for prefix, (sunset_at, guide) in SUNSET.items():
        if request.url.path.startswith(prefix):
            now = datetime.now(timezone.utc)
            if now >= sunset_at:
                return JSONResponse(
                    status_code=410,
                    content={
                        "type": "https://errors.zariya.in/api-sunset",
                        "title": "API version retired",
                        "status": 410,
                        "detail": f"v1 was retired on {sunset_at.date()}. Use v2.",
                        "instance": request.url.path,
                    },
                    media_type="application/problem+json",
                    headers={"Link": f'<{guide}>; rel="deprecation"'},
                )
            response.headers["Deprecation"] = f"@{int(sunset_at.timestamp())}"
            response.headers["Sunset"] = format_datetime(sunset_at, usegmt=True)
            response.headers["Link"] = f'<{guide}>; rel="deprecation"; type="text/html"'
            # Emit a metric so we can see *who* is still on the deprecated version.
            DEPRECATED_CALLS.labels(
                version="v1",
                consumer=request.headers.get("X-Client-Id", "unknown"),
            ).inc()
    return response
```

### Portal: generating the consumer surface from one artifact

```javascript
// build-portal.mjs — everything the portal shows derives from the spec registry.
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const catalog = JSON.parse(await readFile("catalog.json", "utf8"));

for (const api of catalog.apis) {
  // 1. Static reference docs (no external CDN — bundle the renderer).
  await run("npx", ["@redocly/cli", "build-docs", api.spec_url,
                    "-o", `dist/${api.slug}/index.html`]);

  // 2. Typed SDKs, versioned with the spec.
  for (const lang of ["python", "typescript", "go"]) {
    await run("npx", ["@openapitools/openapi-generator-cli", "generate",
                      "-i", api.spec_url, "-g", lang,
                      "-o", `dist/sdk/${api.slug}/${lang}`]);
  }

  // 3. A mock server URL for the sandbox "try it" console.
  await writeFile(`dist/${api.slug}/mock.json`,
    JSON.stringify({ mock: `https://mock.zariya.in/${api.slug}` }));
}
```

> **Optimization note:** Linting a 12,000-line OpenAPI document takes 20–40 s and dominates PR feedback time. Two fixes: (1) lint **only the changed spec files** (`git diff --name-only origin/main -- '*openapi*.yaml'`), and (2) cache Spectral's resolved `$ref` graph. For the portal, pre-render docs at build time and serve static HTML — client-side spec rendering of a large document costs seconds of main-thread parse time and destroys the first-visit experience for the exact audience you're trying to win.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Written style guide | One source of truth; onboarding drops from weeks to days | Rots unless it is executable and owned; prose alone is ignored |
| Automated linting | Catches 70–80% of violations with zero human time; objective, unarguable | False positives erode trust; over-strict rulesets get disabled wholesale |
| Design review board | Catches modelling errors machines cannot see; spreads expertise | Becomes a bottleneck if mandatory for everything; needs an SLA (e.g. 2 business days) |
| Spec-first workflow | Consumers build in parallel against mocks; SDKs and docs are free | Slower to first commit; teams that iterate in code find it bureaucratic |
| Central catalog | Answers ownership, blast radius and audit questions instantly | Only as good as its freshness; must be generated from repos, never hand-maintained |
| Developer portal | Self-service adoption; support load drops sharply | Real engineering investment; a stale portal is worse than none |
| Strict versioning + long sunsets | Consumer trust; integrations survive for years | You maintain N versions simultaneously; compatibility shims accrete complexity |
| Federated ownership | Scales to hundreds of APIs; domain teams stay autonomous | Consistency depends on tooling adoption; needs sustained platform investment |

## 7. Common Mistakes & Best Practices

1. ⚠️ Publishing a 60-page style-guide PDF and expecting compliance. → ✅ Ship the guide as a **Spectral ruleset plus a scaffold**; the prose document links to the rule that enforces each statement.
2. ⚠️ Turning on 200 `error`-severity rules against a brownfield estate and drowning every team in findings. → ✅ Start with 10–15 high-value `error` rules, put the rest at `warn`, and apply a **ratchet** so warnings can only go down.
3. ⚠️ Making design review mandatory for every endpoint, including internal CRUD. → ✅ Tier it: review public/partner and T0/T1 APIs; let T2/T3 pass on lint alone. Publish a review SLA so it never blocks a sprint.
4. ⚠️ Maintaining the API catalog as a spreadsheet or Confluence page. → ✅ Keep `api.yaml` in each repo and ingest it on merge; a catalog nobody updates is actively misleading during an incident.
5. ⚠️ Announcing deprecation only in a changelog. → ✅ Signal on the wire with `Deprecation`, `Sunset` and `Link` headers, *and* attribute usage per consumer so you can email the ten integrations that actually matter.
6. ⚠️ Deleting an endpoint on the sunset date with no runway. → ✅ Announce 6–12 months out, run **brownouts** (planned 1-hour `410`s at increasing frequency) so silent integrations surface while someone is still watching.
7. ⚠️ Treating "add a field to the response" as always safe. → ✅ It's safe only if the must-ignore rule is documented *and* your SDKs actually tolerate unknown fields. Verify with a contract test that injects an unknown field.
8. ⚠️ Adding a new enum value to a response and calling it non-breaking. → ✅ Response enums are a client `switch`; either version the change or design the field as an open string with a documented `unknown` fallback from day one.
9. ⚠️ Letting each team pick its own error format because "it's just internal." → ✅ Error shape is the single highest-leverage rule to standardise: it's what every client's shared HTTP wrapper depends on. Mandate RFC 9457 everywhere.
10. ⚠️ Building the portal as a separate hand-written site. → ✅ Generate docs, SDKs and the try-it console from the same immutable spec artifact that the gateway and contract tests use. Divergence between docs and reality is the #1 developer-experience complaint.
11. ⚠️ Governing design but not operations. → ✅ Tier every API and attach SLOs, runbooks and an on-call rotation to the catalog entry; an API with no owner in production is a governance failure, not an ops failure.
12. ⚠️ Assigning API ownership to an individual. → ✅ Own by **team handle**; individuals leave and the catalog silently becomes wrong.

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** When a consumer says "the API changed and broke us," the first question is *which spec version were they compiled against?* Have every response carry `X-API-Version` (the deployed spec version) and every SDK send `User-Agent: zariya-python/2.4.1 spec/1.14.0`. Joining those two fields in your logs turns a vague complaint into an exact diff — run `oasdiff` between the two spec versions and you have the answer in a minute. Keep every published spec immutable and permanently retrievable; a spec you overwrote is a debugging dead end.

**Monitoring.** Governance has its own metrics, and they belong on a platform dashboard:
- `api_spec_lint_errors` / `api_spec_lint_warnings` per API — the compliance ratchet.
- `api_catalog_coverage` — the share of deployed services with a valid `api.yaml`. Below 100% you do not know your own estate.
- `deprecated_endpoint_calls_total{version,consumer}` — the only number that tells you whether a sunset is safe.
- `api_requests_total{api,consumer,status}` — per-consumer error rates, so the owning team sees which integration is failing before that integration files a ticket.
- Portal funnel: signups → first sandbox call → first production call → **time to first successful call (TTFSC)**, the single best DX metric there is.
- `breaking_changes_blocked_total` — proof the conformance gate is doing work.

**Security.** Governance is where security controls become universal rather than per-team heroics. Enforce in the linter: every operation declares `security`; no API key in a query parameter; no PII in path segments (they land in access logs and `Referer` headers); every collection endpoint has a bounded `limit`. Enforce in the catalog: `data_classification` drives which APIs get mandatory pen-testing and audit-log retention. Enforce in the portal: sandbox keys are prefixed and visibly distinct (`sk_test_` vs `sk_live_`), key rotation is self-service, and keys are shown exactly once. Map your ruleset explicitly to the **OWASP API Security Top 10** — BOLA (API1) in particular cannot be linted, so it becomes a mandatory design-review checklist item: *for every endpoint taking an object ID, which authorization check proves the caller owns it?*

**Performance & Scaling.** Governance tooling must not become the bottleneck. Lint only changed files; cache resolved specs; pre-render portal docs statically. As the estate grows past ~50 APIs, shift from review-everything to **sampling plus exception review**: audit a random 10% of merged specs monthly, review 100% of public-facing changes, and let the linter carry the rest. Publish a scorecard per API (lint compliance, doc coverage, SLO attainment, deprecation hygiene) — visible, comparable scorecards move teams far more reliably than mandates do.

## 9. Interview Questions

**Q: What is API governance and why does it matter more as an organisation grows?**
A: Governance is the set of standards, tooling and processes that keep independently-built APIs consistent, discoverable and safely evolvable. Without it, integration cost scales as O(APIs × consumers) because every consumer must learn every API's idiosyncrasies; with shared conventions it approaches O(APIs + consumers). It matters most at scale because APIs have long half-lives — a public endpoint with thousands of integrations is effectively permanent.

**Q: What does a Spectral ruleset actually enforce, and what can it never enforce?**
A: It enforces mechanical, structural properties of the OpenAPI document: naming conventions, required response codes, RFC 9457 error content types, presence of `security`, pagination parameters, documentation completeness. It cannot judge whether something is genuinely a resource, whether the granularity is right, whether an endpoint duplicates another team's, or whether object-level authorization exists — those need a human reviewer.

**Q: What is the difference between the `Deprecation` and `Sunset` headers?**
A: `Deprecation` announces that the resource is deprecated — it still works, but you should stop using it — and carries the date deprecation took (or takes) effect. `Sunset`, defined in RFC 8594, gives the HTTP-date after which the resource will become unresponsive. Pair both with a `Link; rel="deprecation"` pointing at the migration guide, and return `410 Gone` after the sunset date.

**Q: Which API changes are backward compatible?**
A: Safe: adding optional request fields, adding response fields (given a documented must-ignore rule), adding new endpoints, adding new request enum values, loosening request validation. Breaking: removing or renaming response fields, making a request field required, adding response enum values, changing status codes or error shapes, tightening validation.

**Q: How do you introduce governance to an existing estate of 40 inconsistent APIs?**
A: Never big-bang. Start with a small set of high-value `error` rules and put everything else at `warn`, then apply a ratchet so each API's warning count can only decrease. Hold new APIs to the full standard from day one, and use scaffolds so the default path is compliant. Publish scorecards rather than issuing mandates.

**Q: What belongs in an API catalog entry?**
A: Owning team (never an individual), tier/criticality, lifecycle stage, audience, spec URL, repository, runbook, on-call channel, environment base URLs, SLOs, upstream dependencies, and data classification. It must be generated from a file in the repo so it stays accurate.

**Q: What is spec-first development and what does it cost?**
A: The OpenAPI document is authored and reviewed before implementation; server, mocks, SDKs, docs, gateway config and contract tests all derive from it. Benefits are parallel client/server development and free generated artifacts. The cost is slower time-to-first-commit and friction for teams who prefer to discover the design while coding.

**Q: What is the single best metric for a developer portal?**
A: Time to first successful call (TTFSC) — how long from landing on the portal to a `200` from a real endpoint. It rolls up docs quality, credential self-service, sandbox availability and SDK ergonomics into one number, and it correlates directly with adoption.

**Q: (Senior) A team must ship a breaking change to a public API used by 3,000 integrations. Walk me through your plan.**
A: First try to avoid it — model the change additively behind a new field, a new representation, or a new endpoint. If genuinely unavoidable: ship a new version (URI or date-pinned header), run both versions in parallel behind a translation layer so there's one implementation, then announce with 6–12 months of runway using `Deprecation`/`Sunset` headers, portal banners, changelog and direct email to the top consumers by traffic. Track `deprecated_endpoint_calls_total{consumer}` weekly, run escalating brownouts in the final quarter, and only then return `410`. Never remove on the announced date without evidence that traffic has actually gone to zero.

**Q: (Senior) How do you keep a design-review board from becoming a bottleneck?**
A: Tier what requires review (public, partner and T0/T1 only), publish a hard SLA of two business days with an auto-approve fallback, and require the linter to be green *before* a human looks — reviewers should never spend time on things a machine catches. Rotate reviewers from domain teams into an API guild so the expertise federates outward, and convert every recurring review comment into either a lint rule or a scaffold default so the same finding is never raised twice.

**Q: (Senior) How do you decide the right governance strictness for internal versus public APIs?**
A: By reversibility and blast radius. An internal API with three known consumers can be changed with a Slack message and a coordinated deploy, so it needs lint-only governance. A public API's changes are irreversible because you cannot force clients to upgrade, so it needs design review, contract tests, strict compatibility gates and long deprecation windows. Applying public-grade governance to internal CRUD is the classic way to make governance hated and then abandoned.

**Q: (Senior) Your organisation has 60 APIs and no catalog. During an incident nobody can tell which services call the failing API. How do you fix this structurally?**
A: Make the catalog a build artifact rather than documentation. Require an `api.yaml` in every repo, fail CI without it, and ingest it on merge so it can never drift. Derive the dependency graph from two sources so it self-corrects: declared `dependencies` in the manifest, and observed traffic from gateway logs or service-mesh telemetry keyed by client ID. Publish catalog coverage as a platform SLO and surface it on the incident dashboard so the graph is trusted at 3 a.m.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Governance keeps many APIs feeling like one. Pull three levers in order of leverage: **defaults** (scaffolds that are already compliant), **automation** (Spectral in CI, with a ratchet so brownfield warnings only shrink), and **human review** (only for public/partner and T0/T1 APIs, with a published SLA). Everything downstream — mocks, SDKs, docs, gateway config, contract tests — must derive from **one immutable spec artifact** in a registry. Track the estate in a **catalog generated from `api.yaml` in each repo**, keyed by owning *team*, tier, lifecycle, SLOs and data classification. Evolve additively; when you must break, ship a new version, announce with `Deprecation` and `Sunset` headers plus direct outreach to top consumers, watch per-consumer deprecated-call metrics, brownout, then `410 Gone`. Measure governance itself: lint compliance, catalog coverage, breaking changes blocked, and time to first successful call.

| Signal | Value / Meaning |
|---|---|
| `Deprecation: @1767225600` | Deprecated as of that Unix timestamp; still works |
| `Sunset: Wed, 01 Jul 2026 00:00:00 GMT` | RFC 8594 — unresponsive after this date |
| `Link: <...>; rel="deprecation"` | Points to the migration guide |
| `Link: <...>; rel="successor-version"` | The replacement resource |
| `410 Gone` | Correct status after sunset (not `404`) |
| `X-API-Version` | Deployed spec version — essential for debugging |
| Spectral `error` | Blocks merge — contract-level violation |
| Spectral `warn` | Ratcheted — count may not increase |
| Lifecycle `experimental` | No compatibility guarantee, internal only |
| Lifecycle `stable` | No breaking changes, ever — new version instead |

- **Governance pyramid** → defaults > automation > human review, in that order of leverage.
- **The ratchet** → new APIs must be clean; existing APIs may never increase their warning count.
- **Must-ignore rule** → consumers ignore unknown fields; this is what makes adding response fields safe.
- **Deprecation vs sunset** → "stop using it" vs "it stops working"; both go on the wire, not just in a changelog.
- **Catalog ownership** → always a team handle, always generated from a repo file, never a spreadsheet.

## 11. Hands-On Exercises & Mini Project

- [ ] Write a `.spectral.yaml` with five house rules (kebab-case paths, snake_case properties, problem+json errors, mandatory `security`, documented `429`) and run it against a real public OpenAPI document such as the GitHub or Stripe spec. Count the findings.
- [ ] Take an existing OpenAPI file, make three changes (add an optional request field, add a response enum value, rename a response field) and run `oasdiff breaking` to confirm which two it flags.
- [ ] Add lifecycle middleware to a FastAPI service that emits `Deprecation`, `Sunset` and `Link` headers on a `/v1/` prefix and returns RFC 9457 `410` after the sunset date.
- [ ] Write an `api.yaml` catalog manifest for a service you know, then a 30-line script that walks a directory of repos and produces a JSON catalog with coverage percentage.
- [ ] Draft a one-page deprecation plan for a hypothetical `/v1/orders` used by 500 integrations: timeline, comms channels, metrics to watch, brownout schedule, rollback trigger.

**Mini Project — "API Governance Platform in a box."**
*Goal:* Build a working, minimal governance pipeline over a folder of three deliberately inconsistent OpenAPI specs.
*Requirements:*
1. A `.spectral.yaml` ruleset with at least 10 rules split across `error` and `warn`, including one custom function that validates cursor-pagination parameters on collection endpoints.
2. A CI script that lints all three specs, enforces the warning ratchet against a committed baseline, and runs `oasdiff` breaking-change detection against the previous committed version of each spec.
3. A catalog ingester that reads `api.yaml` from each service directory and emits `catalog.json` with owner, tier, lifecycle and dependencies, plus a coverage metric.
4. A static portal generator that renders a landing page listing every API from `catalog.json` with lifecycle badges, links to generated reference docs, and a deprecation banner for anything with a `Sunset` date.

*Extensions:* add a scorecard page ranking APIs by compliance; generate a dependency graph as an SVG from the catalog; add a GitHub Action that comments the lint diff on every PR; simulate a sunset by adding brownout middleware that returns `410` for five minutes every hour and log which consumers notice.

## 12. Related Topics & Free Learning Resources

**Related chapters:** *API Versioning Strategies* for how to structure the version boundary governance enforces; *OpenAPI & Documentation* for authoring the spec artifact everything derives from; *Error Handling & RFC 9457* for the single most valuable rule in any style guide; *API Gateways & BFF* for where governance decisions are enforced at runtime; *Case Studies: Stripe, GitHub & Twilio* (chapter 44) for what mature governance looks like from the outside.

**Free Learning Resources**
- **Zalando RESTful API Guidelines** — Zalando SE · *Intermediate* · the most complete public API style guide, with MUST/SHOULD/MAY rules you can lift directly into a Spectral ruleset. <https://opensource.zalando.com/restful-api-guidelines/>
- **Google API Improvement Proposals (AIPs)** — Google · *Intermediate* · the reasoning behind each design rule, not just the rule; the standard-methods and long-running-operations AIPs are essential. <https://google.aip.dev/>
- **Microsoft REST API Guidelines** — Microsoft · *Intermediate* · pragmatic, widely-copied guidance on versioning, pagination, errors and deprecation at enterprise scale. <https://github.com/microsoft/api-guidelines>
- **Spectral Documentation** — Stoplight · *Beginner* · how to write, extend and run OpenAPI linting rules, including custom functions. <https://docs.stoplight.io/docs/spectral>
- **RFC 8594 — The Sunset HTTP Header Field** — IETF · *Intermediate* · the normative definition of sunset signalling; short and worth reading in full. <https://www.rfc-editor.org/rfc/rfc8594>
- **RFC 9457 — Problem Details for HTTP APIs** — IETF · *Intermediate* · the error format to mandate org-wide; obsoletes RFC 7807. <https://www.rfc-editor.org/rfc/rfc9457>
- **OWASP API Security Top 10** — OWASP · *Intermediate* · map each item to a lint rule or a design-review checklist item; BOLA is the one only humans can catch. <https://owasp.org/API-Security/editions/2023/en/0x11-t10/>
- **Backstage Software Catalog Documentation** — Spotify / CNCF · *Intermediate* · the reference implementation of a repo-generated service and API catalog. <https://backstage.io/docs/features/software-catalog/>

---

*REST API Handbook — chapter 43.*
