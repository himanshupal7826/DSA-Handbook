# 35 · API Documentation That Developers Love

> **In one line:** Documentation is the API's user interface — a developer judges your product by how fast they get a `201`, not by how complete your reference tables are.

---

## 1. Overview

Nobody adopts an API they cannot understand. For a public API, documentation is not a support artifact bolted on after launch — it *is* the product surface. Every integration decision, every evaluation, every "should we build on this?" conversation happens inside your docs. The reference table nobody can find and the quickstart that fails on step three cost you customers as directly as an outage.

The problem documentation solves is **transfer of a mental model under time pressure**. A developer arrives with a job to be done, a deadline, and zero context. They need four things in order: proof that this API can do their job, a working request in under five minutes, a complete reference when they hit an edge, and a reliable way to learn what changed. Documentation that optimises for completeness over that sequence is thorough and useless.

The industry's centre of gravity moved twice. First, in the 2010s, from PDF-style manuals to **generated reference docs** driven by OpenAPI — solving completeness and drift. Then, from roughly 2018, the realisation that generated reference alone is insufficient: developers need **task-shaped guides**, runnable examples, and an interactive console. The modern bar, set by Stripe and Twilio, is a *docs system*: generated reference plus hand-written conceptual guides plus executable examples plus a changelog, all versioned together with the API.

**Concrete example.** Stripe's docs are widely cited as the reason developers pick Stripe. Concretely: a quickstart that works with a copy-pasteable test key, a three-pane reference where code samples sit beside every field in your chosen language, examples pre-filled with *your* real test-mode objects, an API changelog tied to their dated versions, and error messages in the API itself that link back to the relevant docs page. The docs are generated from the same OpenAPI document that generates their SDKs, so drift is structurally impossible.

The durable mental model: **documentation has four distinct audiences-in-time** — the evaluator (2 minutes), the implementer (2 hours), the debugger (2 a.m.), and the upgrader (2 years). One document cannot serve all four. Design a system with a surface for each.

## 2. Core Concepts

- **Reference documentation** — the exhaustive, generated description of every endpoint, parameter, field and error. Optimised for lookup, not for reading.
- **Quickstart** — the shortest possible path from zero to a successful authenticated call. Measured in minutes and in copy-paste steps, not in words.
- **Conceptual guide** — hand-written prose explaining a domain model or cross-cutting mechanism (idempotency, pagination, webhooks, auth) that no single endpoint owns.
- **How-to / recipe** — a task-shaped walkthrough ("refund a partially shipped order") that composes several endpoints in the order a real integration needs them.
- **Runnable example** — a code sample that works when pasted, with real (test-mode) credentials, correct imports, and no elided `...`.
- **API console / Try-it** — an in-page client that fires a real request against sandbox using the reader's own key and shows the actual response.
- **Changelog** — a dated, append-only record of every API change, classified as breaking, additive or fixed, with migration instructions where relevant.
- **Developer portal** — the container: docs, key management, usage dashboards, status page, SDK downloads and support entry points in one place.
- **Diátaxis** — the documentation framework distinguishing tutorials, how-to guides, reference and explanation; the clearest available answer to "what page am I writing?"
- **Docs-as-code** — documentation lives in version control, is reviewed in pull requests, and is built and deployed by CI alongside the service.
- **Time to first call (TTFC)** — the headline developer-experience metric: minutes from landing on the docs to a successful `2xx`.

## 3. Theory & Principles

### 3.1 The four audiences-in-time

| Reader | Arrives with | Needs | Fails if |
| --- | --- | --- | --- |
| Evaluator (2 min) | "Can this do X?" | Landing page, capability list, one honest example | They must read a reference table to find out |
| Implementer (2 h) | A task and a deadline | Quickstart, how-to recipes, runnable code, SDK | Examples are pseudocode or omit auth |
| Debugger (2 a.m.) | An error code | Searchable error catalogue, status page, logs | The error string appears nowhere in the docs |
| Upgrader (2 y) | A deprecation email | Changelog, migration guide, version policy | Changes are announced only in a blog post |

The most common structural failure is optimising the whole site for the implementer and leaving the debugger with nothing. Every error `type` URI your API emits should resolve to a real page — that is the cheapest, highest-leverage documentation you can write, because it arrives exactly when the developer needs it.

### 3.2 Diátaxis: four modes, never mixed

Diátaxis separates docs along two axes — practical vs theoretical, study vs work:

- **Tutorial** (learning-oriented): a guided lesson with a guaranteed outcome. "Build your first integration." No choices, no alternatives.
- **How-to guide** (task-oriented): steps to accomplish a specific goal for someone who already knows the basics. "Handle a disputed charge."
- **Reference** (information-oriented): the exhaustive, austere, generated description. No narrative.
- **Explanation** (understanding-oriented): why the system is designed this way. "Why idempotency keys are required on writes."

Mixing modes is the most common documentation defect. A reference page with a tutorial embedded is unnavigable for lookup; a tutorial with reference tables in the middle loses the learner. Each page should answer one question type.

```svg
<svg viewBox="0 0 760 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="10" y="10" width="740" height="320" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="380" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Diátaxis: four modes, two axes</text>
  <line x1="380" y1="66" x2="380" y2="290" stroke="#4f46e5" stroke-width="1.5"/>
  <line x1="60" y1="178" x2="700" y2="178" stroke="#4f46e5" stroke-width="1.5"/>
  <rect x="70" y="76" width="290" height="88" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="215" y="102" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Tutorial</text>
  <text x="215" y="122" text-anchor="middle" fill="#1e293b" font-size="10">learning &#183; practical &#183; guided</text>
  <text x="215" y="140" text-anchor="middle" fill="#1e293b" font-size="10">"Build your first integration"</text>
  <text x="215" y="156" text-anchor="middle" fill="#1e293b" font-size="10">guaranteed outcome, no choices</text>
  <rect x="400" y="76" width="290" height="88" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="545" y="102" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">How-to guide</text>
  <text x="545" y="122" text-anchor="middle" fill="#1e293b" font-size="10">task &#183; practical &#183; goal-directed</text>
  <text x="545" y="140" text-anchor="middle" fill="#1e293b" font-size="10">"Handle a disputed charge"</text>
  <text x="545" y="156" text-anchor="middle" fill="#1e293b" font-size="10">assumes basics, composes endpoints</text>
  <rect x="70" y="192" width="290" height="88" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="215" y="218" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Explanation</text>
  <text x="215" y="238" text-anchor="middle" fill="#1e293b" font-size="10">understanding &#183; theoretical</text>
  <text x="215" y="256" text-anchor="middle" fill="#1e293b" font-size="10">"Why idempotency keys exist"</text>
  <text x="215" y="272" text-anchor="middle" fill="#1e293b" font-size="10">design rationale, trade-offs</text>
  <rect x="400" y="192" width="290" height="88" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="545" y="218" text-anchor="middle" fill="#1e293b" font-size="13" font-weight="700">Reference</text>
  <text x="545" y="238" text-anchor="middle" fill="#1e293b" font-size="10">information &#183; theoretical &#183; generated</text>
  <text x="545" y="256" text-anchor="middle" fill="#1e293b" font-size="10">every field, every error, every header</text>
  <text x="545" y="272" text-anchor="middle" fill="#1e293b" font-size="10">austere, complete, from OpenAPI</text>
  <text x="380" y="308" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Mixing two modes on one page is the most common documentation defect.</text>
  <text x="380" y="326" text-anchor="middle" fill="#1e293b" font-size="10">study &#8594; work reads left to right; practical &#8594; theoretical reads top to bottom.</text>
</svg>
```

### 3.3 Why generation is non-negotiable for reference

Hand-written reference documentation drifts within one sprint, and the drift is invisible: nothing fails when a doc page describes a field that no longer exists. Generating reference from the OpenAPI document makes drift structurally impossible for the parts that are generated, and it makes coverage measurable — you can *count* the operations lacking descriptions or examples and gate merges on it.

But generation has a hard ceiling. A spec cannot express *why* idempotency keys are required, *when* to poll versus subscribe to a webhook, or *how* to sequence four calls into a refund flow. Those are the pages developers actually thank you for, and they must be written by a human who has used the API. The correct split: **generate the reference, write the narrative, and test both**.

### 3.4 Examples are contracts too

A code sample is executable documentation. If it is not executed by CI, it is wrong — imports rot, field names change, auth schemes move. Treat every sample as a test: extract it, run it against sandbox, assert the response. Providers who do this ship samples that always work; providers who do not ship samples that are subtly wrong in ways that destroy trust faster than having no sample at all.

## 4. Architecture & Workflow

How a documentation system is actually built and kept honest:

1. **Source of truth split.** The OpenAPI document lives beside the service; narrative Markdown lives in a docs repo (or the same monorepo). Both are version-controlled and reviewed in pull requests.
2. **Enrich the spec for humans.** `summary`, `description`, `examples` on every operation and public field. Spectral rules fail the build if an operation lacks a description or a `4xx` response.
3. **Generate reference.** CI renders the bundled spec with Redoc, Scalar or a custom renderer into static reference pages, with per-language code samples derived from the generated SDKs.
4. **Author narrative.** Quickstart, conceptual guides, how-to recipes and the error catalogue are written by hand in Markdown, in Diátaxis modes, cross-linked to generated reference anchors.
5. **Extract and test examples.** A CI job pulls every fenced code block tagged as runnable, executes it against a sandbox with a test key, and fails the docs build on any non-2xx or assertion error.
6. **Generate the changelog.** Entries come from a structured source — the deprecation registry from chapter 32 plus the `oasdiff` output — so no API change can ship without a changelog line.
7. **Build the portal.** Static site plus dynamic pieces: key management, usage dashboards, an interactive console pre-authenticated with the reader's test key.
8. **Publish atomically with the API.** The docs deploy is part of the API release pipeline, so a rollback rolls back the docs. Versioned docs are archived per API version so an integrator on v1 still sees v1's reference.
9. **Instrument.** Track time to first call, search queries with zero results, per-page bounce, "was this helpful" votes, and support tickets tagged by the page the user was on. Zero-result searches are the single best backlog for what to write next.
10. **Close the loop from the API itself.** Every error response carries a `type` URI that resolves to a real docs page — documentation delivered at the exact moment of confusion.

```svg
<svg viewBox="0 0 780 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif">
  <defs><marker id="b35" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#16a34a"/></marker></defs>
  <rect x="10" y="10" width="760" height="330" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Docs-as-code pipeline</text>
  <rect x="30" y="66" width="150" height="72" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="105" y="90" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">openapi.yaml</text>
  <text x="105" y="108" text-anchor="middle" fill="#1e293b" font-size="10">enriched with</text>
  <text x="105" y="124" text-anchor="middle" fill="#1e293b" font-size="10">descriptions + examples</text>
  <rect x="30" y="156" width="150" height="72" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="105" y="180" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">narrative .md</text>
  <text x="105" y="198" text-anchor="middle" fill="#1e293b" font-size="10">quickstart, guides,</text>
  <text x="105" y="214" text-anchor="middle" fill="#1e293b" font-size="10">error catalogue</text>
  <rect x="230" y="100" width="150" height="94" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="305" y="126" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">CI docs build</text>
  <text x="305" y="146" text-anchor="middle" fill="#1e293b" font-size="10">render reference</text>
  <text x="305" y="162" text-anchor="middle" fill="#1e293b" font-size="10">run every sample</text>
  <text x="305" y="178" text-anchor="middle" fill="#1e293b" font-size="10">check every link</text>
  <rect x="430" y="66" width="150" height="62" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="505" y="90" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">reference site</text>
  <text x="505" y="110" text-anchor="middle" fill="#1e293b" font-size="10">per-language samples</text>
  <rect x="430" y="140" width="150" height="62" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="505" y="164" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">try-it console</text>
  <text x="505" y="184" text-anchor="middle" fill="#1e293b" font-size="10">reader's test key</text>
  <rect x="430" y="214" width="150" height="62" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="505" y="238" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">changelog</text>
  <text x="505" y="258" text-anchor="middle" fill="#1e293b" font-size="10">from oasdiff + registry</text>
  <path d="M180 110 L226 128" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b35)"/>
  <path d="M180 190 L226 168" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b35)"/>
  <path d="M380 130 L426 106" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b35)"/>
  <path d="M380 150 L426 165" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b35)"/>
  <path d="M380 176 L426 232" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b35)"/>
  <rect x="620" y="100" width="130" height="94" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="685" y="124" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">telemetry</text>
  <text x="685" y="144" text-anchor="middle" fill="#1e293b" font-size="10">time to first call</text>
  <text x="685" y="160" text-anchor="middle" fill="#1e293b" font-size="10">zero-result search</text>
  <text x="685" y="176" text-anchor="middle" fill="#1e293b" font-size="10">tickets per page</text>
  <path d="M580 140 L616 143" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#b35)"/>
  <rect x="30" y="292" width="720" height="38" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="316" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">Docs deploy with the API release &#8212; a rollback rolls back the docs, and error type URIs always resolve.</text>
</svg>
```

## 5. Implementation

### 5.1 A quickstart that actually works

The whole quickstart, on one page, with nothing elided. The test key is real and public; the response is the real response.

```bash
# 1. Create an order (test mode — this key is safe to publish)
curl -sS https://sandbox.acme.dev/v2/orders \
  -H "Authorization: Bearer sk_test_51H8xPublicSandboxKey" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
        "customer_id": "cus_301",
        "currency": "INR",
        "items": [{ "sku": "SKU-7781", "quantity": 2, "unit_amount": 129900 }]
      }'
```

```json
{
  "id": "ord_8812AB",
  "status": "pending",
  "total": { "amount": 259800, "currency": "INR" },
  "created_at": "2024-06-20T11:04:19Z"
}
```

```bash
# 2. Read it back. Expect 200 and the same id.
curl -sS https://sandbox.acme.dev/v2/orders/ord_8812AB \
  -H "Authorization: Bearer sk_test_51H8xPublicSandboxKey"
```

> **Next:** [Handle webhooks](/guides/webhooks) · [Idempotency explained](/guides/idempotency) · [Full reference](/reference/orders)

Three rules make this work: the key is embedded so there is no signup wall before the first success; the request is complete (no `...`); and the page ends by naming the next three things, so the reader is never stranded.

### 5.2 Enriching the spec so generated reference reads well

Generated reference is only as good as the `description` and `examples` you put in the spec:

```yaml
paths:
  /orders:
    post:
      operationId: createOrder
      summary: Create an order
      description: |
        Creates an order in `pending` status and reserves inventory for 15 minutes.
        Requires an `Idempotency-Key`; replaying the same key within 24 hours returns
        the original response rather than creating a second order. See
        [Idempotency](/guides/idempotency).
      requestBody:
        content:
          application/json:
            schema: { $ref: "#/components/schemas/OrderCreate" }
            examples:
              single_item:
                summary: One line item
                value: { customer_id: cus_301, currency: INR,
                         items: [{ sku: SKU-7781, quantity: 2, unit_amount: 129900 }] }
              with_note:
                summary: With a gift note
                value: { customer_id: cus_301, currency: INR, note: "Happy birthday!",
                         items: [{ sku: SKU-7781, quantity: 1, unit_amount: 129900 }] }
```

### 5.3 Errors that document themselves

Every error carries a `type` URI that resolves to a real page. This is documentation delivered at the moment of failure:

```http
HTTP/1.1 422 Unprocessable Content
Content-Type: application/problem+json

{ "type": "https://docs.acme.dev/errors/inventory-unavailable",
  "title": "Requested quantity is not available",
  "status": 422,
  "detail": "SKU-7781 has 1 unit available; 2 were requested.",
  "instance": "/v2/orders",
  "errors": [{ "pointer": "/items/0/quantity", "code": "insufficient_inventory" }] }
```

The page at that URI answers four questions in order: what happened, why it happens, how to fix it, and how to avoid it. Add a link-checker to CI that asserts every `type` URI your service can emit resolves with `200` — a dead error link is a broken feature.

### 5.4 Testing every example in CI

Samples that are not executed are wrong. Extract and run them:

```python
# tests/test_docs_examples.py — every ```bash block tagged `runnable` must succeed.
import re, subprocess, pathlib, pytest

BLOCKS = [
    (p, m.group(1))
    for p in pathlib.Path("docs").rglob("*.md")
    for m in re.finditer(r"```bash runnable\n(.*?)```", p.read_text(), re.S)
]

@pytest.mark.parametrize("path,script", BLOCKS, ids=lambda v: str(v)[:40])
def test_example_runs(path, script):
    r = subprocess.run(["bash", "-euo", "pipefail", "-c", script],
                       capture_output=True, text=True, timeout=30,
                       env={**os.environ, "ACME_KEY": os.environ["SANDBOX_KEY"]})
    assert r.returncode == 0, f"{path} failed:\n{r.stderr}"
    assert '"error"' not in r.stdout, f"{path} returned an error body:\n{r.stdout}"
```

```bash
# Also validate the spec's own examples against their schemas, and check every link
redocly lint build/openapi.yaml            # fails on examples that violate schemas
lychee --no-progress --accept 200,206 docs/ build/reference/
```

### 5.5 A changelog entry that does its job

Generate the skeleton from `oasdiff`, then have a human add the migration paragraph:

```markdown
## 2024-06-20

**Breaking**
- `Order.total` is now an object `{ amount, currency }` instead of an integer.
  Accounts pinned to `2024-05-01` or earlier are unaffected.
  *Migration:* replace `order.total` with `order.total.amount`; the currency was
  previously only available on the parent invoice. See [Money](/guides/money).

**Added**
- `Order.tracking_url` (nullable string) on shipped orders.
- `GET /orders` accepts a repeatable `status` query parameter.

**Fixed**
- `POST /orders` returned `500` instead of `422` when `items` was empty.
```

Ship the same content as a machine-readable feed (`/changelog.json` plus RSS) so SDKs, integrators' bots and your own docs site can consume it.

> **Optimization note:** Docs sites are read far more than they are written, so build them as static HTML with a prerendered search index (Pagefind, Algolia DocSearch) rather than client-side filtering over a multi-megabyte JSON blob — a 5 MB reference page with runtime search costs seconds on mobile. Split very large generated reference by tag into separate pages instead of one enormous document, lazy-load the try-it console (it drags in a full HTTP client), and serve everything from a CDN with long `Cache-Control` and content-hashed asset names. Measure with real-user metrics: Largest Contentful Paint on your reference page is a developer-experience metric, not a marketing one.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| **Generated reference** | Cannot drift; complete coverage; measurable gaps | Reads like a schema dump; cannot explain sequencing, rationale or trade-offs |
| **Hand-written guides** | The pages developers actually thank you for | Rot silently; need owners, review dates and link checking |
| **Runnable, CI-tested examples** | Trust: samples always work; catches API regressions the tests missed | Needs a sandbox, seeded data, and public test credentials; adds CI time |
| **Interactive try-it console** | Collapses time to first call; no local setup at all | Real security surface (keys in a browser); heavy page weight; needs CORS and rate limits |
| **Docs-as-code** | Reviewed with the change; deploys and rolls back with the API | Writers must use git; PR review latency slows urgent doc fixes |
| **Versioned docs** | Integrators on old versions still see accurate reference | Multiplies pages, search results and maintenance; stale versions confuse search |
| **Changelog + machine-readable feed** | Upgraders self-serve; SDKs and bots can consume it | Only useful if it is complete — a changelog with gaps is worse than none |
| **Multi-language samples** | Meets developers where they are; strong adoption signal | N languages to keep correct; usually only viable when generated from SDKs |

## 7. Common Mistakes & Best Practices

1. ⚠️ **A quickstart that requires signup, a dashboard visit and three config steps before the first call.** Most evaluators leave. → ✅ Publish a working sandbox key directly in the quickstart; signup comes after the first `201`.
2. ⚠️ **Code samples with `...` or pseudo-code.** The reader cannot paste them, and cannot tell what was elided. → ✅ Complete, runnable samples, executed by CI against a sandbox on every build.
3. ⚠️ **Reference-only documentation.** Every field is documented and nobody knows how to do anything. → ✅ Add task-shaped how-to guides for the top five integration jobs.
4. ⚠️ **Error codes that appear nowhere in the docs.** The 2 a.m. debugger searches your site and gets zero results. → ✅ An error catalogue page per `type` URI, with a CI link-check proving every emitted URI resolves.
5. ⚠️ **No changelog, or a changelog that only lists features.** Upgraders cannot tell what will break. → ✅ Dated entries classified breaking/added/fixed, generated from `oasdiff` plus the deprecation registry, with migration prose.
6. ⚠️ **Hand-maintaining reference beside the spec.** Divergence within a sprint, invisible because nothing fails. → ✅ Generate reference from the published OpenAPI document; hand-write only narrative.
7. ⚠️ **Documenting the happy path only.** Nothing about rate limits, retries, idempotency, pagination limits or partial failure. → ✅ Give each cross-cutting mechanism its own conceptual guide, linked from every operation it affects.
8. ⚠️ **Mixing Diátaxis modes on one page.** A tutorial with reference tables loses the learner; a reference page with narrative is unusable for lookup. → ✅ One question type per page, with explicit links between modes.
9. ⚠️ **No search, or search that returns nothing useful.** Developers navigate docs by search, not by your carefully designed sidebar. → ✅ Prerendered full-text search including field names and error codes; review zero-result queries weekly.
10. ⚠️ **Docs deployed separately from the API.** A rollback leaves docs describing a version that no longer exists. → ✅ Publish docs from the same pipeline as the service, versioned identically.
11. ⚠️ **Screenshots of JSON.** Not searchable, not copyable, and stale within a release. → ✅ Real fenced code blocks with syntax highlighting and a copy button.
12. ⚠️ **No feedback loop.** You have no idea which pages fail. → ✅ Per-page "was this helpful," zero-result search logs, and support tickets tagged with the referring docs page — then fix the top three every sprint.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

When an integrator is stuck, the fastest diagnostic is a request ID. Return `X-Request-Id` on every response, document it prominently, and ask for it in every support template — it turns "your API is broken" into a log lookup. Document how to read your errors: the `type` URI, the `detail` field, the `errors[].pointer` JSON Pointer. Keep a "common integration mistakes" page written from actual support tickets; it deflects more volume than any feature documentation.

### Monitoring

- **Time to first call** — median minutes from first docs page view to first successful authenticated `2xx` for a new key. The headline DX metric.
- **Zero-result search queries** — the highest-value content backlog you will ever get, free.
- **Per-page helpful/not-helpful votes and bounce rate**, especially on the quickstart.
- **Support tickets tagged by referring docs page** — a page generating tickets is a page that is wrong or incomplete.
- **Docs build health**: broken links, failing runnable examples, operations lacking descriptions or examples — all as CI-tracked counts with a downward target.
- **Reference page LCP** on real user devices; slow docs are bad docs.

### Security

Public sandbox keys must be **test-mode only**, rate-limited, and incapable of touching real money or real customer data; rotate them and document that they are public. Never put real customer identifiers, internal hostnames, production keys or stack traces in examples — docs are indexed by search engines and archived forever. An interactive console handling a reader's live key is a genuine credential surface: keep keys in memory only, proxy through a documented sandbox origin, never log request bodies, and default the console to test mode. Finally, do not document internal or admin endpoints publicly: your docs are the most convenient attack-surface map anyone could ask for.

### Performance & Scaling

Prerender everything possible and serve from a CDN with content-hashed assets. Split large generated reference by tag rather than shipping one huge page. Build the search index at build time. As the API grows past a few hundred operations, invest in navigation — grouped by resource, with a persistent sidebar and deep-linkable anchors for every field — because search plus anchors is how developers actually move. Version the docs alongside the API and archive old versions statically so they cost nothing to keep online.

## 9. Interview Questions

**Q: What makes API documentation good, concretely?**
A: A developer reaches a successful authenticated call in under five minutes from a copy-pasteable quickstart, then finds task-shaped guides for their actual job, complete generated reference for lookup, and a searchable error catalogue when something fails. Concretely measurable: time to first call, zero-result search rate, and support tickets per docs page.

**Q: What is Diátaxis and why does it matter?**
A: A framework splitting docs into tutorials (learning), how-to guides (task), reference (information) and explanation (understanding). It matters because mixing modes on one page is the most common documentation defect — a reference page with narrative is unusable for lookup, and a tutorial with reference tables loses the learner.

**Q: Which parts of documentation should be generated and which hand-written?**
A: Generate reference from OpenAPI — every field, parameter, status code and error shape — because hand-maintained reference drifts invisibly. Hand-write the quickstart, conceptual guides, how-to recipes and the error catalogue, because a spec cannot express sequencing, rationale or trade-offs. Test both in CI.

**Q: How do you keep code samples from going stale?**
A: Execute them. Extract every runnable block in CI, run it against a sandbox with a public test key, and fail the docs build on any non-2xx or assertion failure. Samples that are not executed are wrong within a release, and a wrong sample costs more trust than a missing one.

**Q: What is "time to first call" and why is it the headline metric?**
A: The median time from a developer's first docs page view to their first successful authenticated `2xx`. It is the headline because it is the only metric that captures the entire funnel — findability, signup friction, auth clarity, and sample correctness — in one number that correlates directly with adoption.

**Q: How should errors and docs be connected?**
A: Every error response should carry a `type` URI (RFC 9457) that resolves to a real page explaining what happened, why, how to fix it and how to avoid it. Add a CI link-check asserting every URI your service can emit returns `200`. This delivers documentation at the exact moment of confusion, which is when it is worth the most.

**Q: What belongs in an API changelog?**
A: Dated entries classified as breaking, added, deprecated or fixed; the affected operations and fields; and, for anything breaking, a concrete migration paragraph. Generate the skeleton from `oasdiff` and the deprecation registry so nothing can ship undocumented, and publish a machine-readable feed alongside the human page.

**Q: (Senior) You own docs for a 400-operation API across eight teams. How do you keep quality up?**
A: Make quality mechanical: Spectral rules requiring descriptions, examples and documented error responses on every operation, failing the build; a per-team docs scorecard published as a trend; and generated reference so no team can hand-maintain a divergent page. Own the narrative layer centrally (quickstart, cross-cutting guides, error catalogue) with a small docs team, and let product teams own operation-level `description` fields inside their spec files. Route zero-result searches and ticket-tagged pages into the owning team's backlog automatically.

**Q: (Senior) How do you decide what documentation to write next?**
A: From evidence, not intuition. Rank by zero-result search queries, support tickets tagged by referring page, drop-off points in the quickstart funnel, and the operations with the highest traffic but lowest docs engagement. Each of those is a measured gap between what developers need and what exists. Feature-driven documentation backlogs consistently write pages nobody reads.

**Q: (Senior) What are the real risks of an interactive "try-it" console?**
A: It handles live credentials in a browser, so it is a genuine credential surface: keys must stay in memory, never be logged, never be sent to a third-party proxy, and default to test mode. It also creates a real traffic source against your sandbox that needs its own rate limits and abuse controls, and it adds significant page weight, so it should be lazy-loaded. The payoff — collapsing time to first call to near zero — usually justifies all of that, but not accidentally.

**Q: Should you version your documentation?**
A: Yes, for any API with live older versions — an integrator pinned to v1 needs v1's reference, not v2's. Archive old versions as static builds, label them prominently, and exclude them from default search ranking so they do not crowd out current content. The cost is search noise and maintenance, which is why it argues for fewer live versions.

**Q: How do you document asynchronous behaviour like webhooks?**
A: Give it a dedicated conceptual guide covering the event catalogue, delivery semantics (at-least-once), retry schedule and backoff, signature verification with a complete code sample, replay protection, and how to test locally. Model the events in OpenAPI 3.1 `webhooks` so the payload schemas are generated and cannot drift, and provide a sandbox trigger so developers can fire a real event on demand.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Documentation serves four audiences-in-time: the evaluator (2 min), the implementer (2 h), the debugger (2 a.m.) and the upgrader (2 y) — design a surface for each. Use Diátaxis to keep one question type per page: tutorial, how-to, reference, explanation. Generate reference from OpenAPI so it cannot drift; hand-write the quickstart, conceptual guides and error catalogue because a spec cannot express sequencing or rationale. Make the quickstart work with a public sandbox key, complete requests and no elision, and execute every sample in CI against sandbox so it can never be wrong. Wire every error's `type` URI to a real page and link-check them. Generate the changelog from `oasdiff` plus your deprecation registry, publish it as HTML and a feed, and deploy docs from the same pipeline as the API. Measure time to first call, zero-result searches and tickets-per-page, and fix the top three every sprint.

| Surface | Purpose | Source |
| --- | --- | --- |
| Quickstart | Zero → `201` in under 5 minutes | Hand-written, CI-executed |
| Reference | Exhaustive lookup | Generated from OpenAPI |
| Conceptual guides | Idempotency, pagination, auth, webhooks | Hand-written |
| How-to recipes | Task-shaped multi-endpoint flows | Hand-written, CI-executed |
| Error catalogue | One page per `type` URI | Hand-written, link-checked |
| Changelog | Breaking / added / deprecated / fixed | `oasdiff` + deprecation registry |
| Try-it console | Collapse time to first call | Generated from spec, lazy-loaded |
| Support entry | Request ID + ticket template | Portal |
| Key DX metric | Time to first call (median minutes) | Analytics funnel |
| Best backlog signal | Zero-result search queries | Search logs |

**Flash cards**

- **The four audiences-in-time?** → Evaluator (2 min), implementer (2 h), debugger (2 a.m.), upgrader (2 y).
- **The four Diátaxis modes?** → Tutorial, how-to, reference, explanation — never two on one page.
- **How do you stop samples going stale?** → Execute every one in CI against a sandbox and fail the docs build on error.
- **What connects an error to its documentation?** → The RFC 9457 `type` URI, resolving to a real page, link-checked in CI.
- **The single headline DX metric?** → Time to first call: median minutes from first page view to first successful `2xx`.

## 11. Hands-On Exercises & Mini Project

- [ ] Time yourself integrating an API you have never used (Stripe, Twilio, GitHub). Record every point of friction and the exact minute you got your first `2xx`; then audit your own docs against that list.
- [ ] Rewrite one of your reference pages as three Diátaxis-pure pages — a how-to, an explanation and the generated reference — and compare which questions each answers.
- [ ] Add a CI job that extracts every runnable code block and executes it against a sandbox. Fix everything it breaks; count how many samples were already wrong.
- [ ] Build an error catalogue: one page per `type` URI your service emits, plus a link-checker asserting every one resolves with `200`.
- [ ] Instrument time to first call end to end — first page view, key creation, first `2xx` — and identify the single largest drop-off step.

### Mini Project — a developer portal for the orders API

**Goal.** Ship a docs system where nothing can be wrong for long.

**Requirements.**
1. Generated reference from the chapter 33 OpenAPI document (Redoc or Scalar), split by tag, with per-language samples derived from generated SDKs.
2. A hand-written quickstart using a public sandbox key that gets a reader to `201` in under five minutes, plus three conceptual guides (idempotency, pagination, webhooks) and three how-to recipes.
3. An error catalogue generated from the spec's `Problem` `type` values, with a CI link-checker over every emitted URI.
4. A CI docs pipeline: `redocly lint`, runnable-example execution against sandbox, link checking, prerendered search index, and deploy alongside the API release.
5. A changelog page and `/changelog.json` feed generated from `oasdiff` output plus the deprecation registry from chapter 32.

**Extensions.**
- Add a try-it console that uses the reader's own test key, kept in memory only, with the request shown as copy-pasteable `curl`.
- Instrument the time-to-first-call funnel and publish it on an internal dashboard with a weekly target.
- Route zero-result searches into a docs backlog automatically, and publish a per-team scorecard of operations missing descriptions or examples.

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *OpenAPI: The Machine-Readable Contract* (chapter 33) produces the reference; *Backward Compatibility & Deprecation* (chapter 32) supplies the changelog and migration guides; *API Versioning Strategies* (chapter 31) determines how many docs versions you must maintain; *Design-First & Contract Testing* (chapter 34) is where the contract gets agreed; *Testing REST APIs* (chapter 36) covers the CI machinery that keeps examples honest.

- **Diátaxis** — Daniele Procida · *Beginner* · the framework for deciding what kind of page you are writing; short, opinionated, and immediately applicable. <https://diataxis.fr/>
- **Google Technical Writing Courses** — Google · *Beginner* · free, exercise-driven courses on clear technical prose; the fastest way to improve engineer-written docs. <https://developers.google.com/tech-writing>
- **Write the Docs — Documentation Guide** — Write the Docs community · *Beginner* · practical guidance on docs-as-code, style, information architecture and review workflows. <https://www.writethedocs.org/guide/>
- **Stripe API Reference** — Stripe · *Intermediate* · the benchmark: three-pane layout, per-language samples, examples pre-filled with your own test objects. Read it as a specification for your own docs. <https://docs.stripe.com/api>
- **Twilio Docs** — Twilio · *Intermediate* · exemplary quickstarts and task-shaped guides; note how quickly each one reaches a working call. <https://www.twilio.com/docs>
- **RFC 9457 — Problem Details for HTTP APIs** — IETF · *Beginner* · defines the `type` URI that makes self-documenting errors possible. <https://www.rfc-editor.org/rfc/rfc9457.html>
- **Redocly CLI documentation** — Redocly · *Beginner* · linting, bundling and generating a reference site from OpenAPI; the toolchain behind §4. <https://redocly.com/docs/cli/>
- **MDN Web Docs — HTTP** — Mozilla · *Beginner* · the reference developers already trust for headers and status codes; link to it rather than restating it badly. <https://developer.mozilla.org/en-US/docs/Web/HTTP>

---

*REST API Handbook — chapter 35.*
