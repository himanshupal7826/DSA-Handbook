# 34 · Design-First & Contract Testing

> **In one line:** Agree the contract before anyone writes code, then keep it honest with automated tests that prove provider and consumer still agree — without deploying them together.

---

## 1. Overview

Two teams, one API. The provider ships a service; the consumer ships something that calls it. Everything works until the provider renames a field, tightens a validation rule, or starts returning `202` where it used to return `200`. Integration tests in the provider's repo pass, because they test the provider against itself. The consumer's tests pass, because they run against a hand-written stub that still describes last quarter's API. The break surfaces in production.

**Design-first** attacks the problem at the front: write and review the contract — an OpenAPI document — *before* implementation, so both sides build against an agreed artifact and the consumer can start immediately against a generated mock. **Contract testing** attacks it at the back: automated checks that prove a given provider version satisfies a given consumer's real expectations, run independently in each side's pipeline, with no shared environment and no orchestrated deploy.

The intellectual lineage is worth knowing. Design-first grew out of the API-as-a-product movement around 2014–2016 (Swagger/Apiary tooling, Stoplight, "the API is the UI for developers"). Consumer-driven contracts were named by Ian Robinson at ThoughtWorks in 2006, and turned into practice by **Pact** — the insight being that the *consumer* is the authority on what it actually needs, so the contract should be generated from the consumer's tests rather than dictated by the provider's docs.

**Concrete example.** A payments platform has one `payments-api` and 40 internal consumers. End-to-end integration in a shared staging environment took 45 minutes, was flaky, and still missed breakages because not every consumer was deployed there. They moved to Pact: each consumer's unit tests run against a local mock and publish a *pact* — a file listing only the interactions that consumer genuinely relies on. The provider's CI replays every published pact against a real instance in 90 seconds, and `can-i-deploy` refuses a release that would break any consumer. Shared staging is now for exploratory testing, not for catching contract breaks.

The durable mental model: **schema tells you what is legal; contracts tell you what is relied upon.** A field can be legal and unused (safe to change) or undocumented and depended upon (dangerous to change). You need both artifacts, and they answer different questions.

## 2. Core Concepts

- **Design-first** — the contract (OpenAPI) is authored and reviewed before implementation; server stubs, mocks and clients are generated from it.
- **Code-first** — the contract is generated from annotated implementation code. Cannot drift, but cannot lead either.
- **Contract test** — a test that verifies the *interface* between two services, not the behaviour behind it. Fast, deterministic, no shared environment.
- **Consumer-driven contract (CDC)** — a contract generated from the consumer's own tests, describing only the interactions and fields that consumer actually uses.
- **Pact / pact file** — the JSON artifact a Pact consumer test produces: a list of `(request, minimal expected response)` pairs with matching rules.
- **Provider verification** — replaying every consumer's pact against a running provider and asserting each response satisfies it.
- **Pact Broker** — the service that stores pacts, records which versions were verified against which, and answers `can-i-deploy`.
- **Matcher** — a rule expressing "a string like this" rather than a literal value, so contracts constrain type and shape without pinning to fixture data.
- **Provider state** — a named precondition (`"an order ord_8812 exists"`) the provider sets up before replaying an interaction, so verification does not depend on ambient data.
- **Bi-directional contract testing** — comparing a provider's OpenAPI document against consumer pacts instead of replaying against a live provider; cheaper, weaker, and useful when the provider is a third party.
- **Schema (compliance) testing** — asserting responses conform to the published spec; catches "the server lied," not "the consumer needed something else."

## 3. Theory & Principles

### 3.1 Why integration tests do not scale

With `N` services, pairwise integration surfaces grow as `O(N²)`, and any test that requires two real services deployed together requires an environment, a deploy order, and shared data. The environment becomes a global lock: one team's broken deploy blocks everyone. Worse, the test is *not decisive* — passing means "these two versions worked in this environment at this moment," which does not generalise.

Contract testing changes the shape of the problem. Each contract is a *bilateral* artifact verifiable in isolation: the consumer verifies against a mock, the provider verifies against a file. Nothing needs to be deployed together, ever. The number of artifacts still grows with the number of relationships, but the *coordination cost* drops to zero because verification is asynchronous and local.

### 3.2 What a contract is, formally

A consumer's contract is a set of interactions `{(reqᵢ, respᵢ)}` where `reqᵢ` is a concrete request and `respᵢ` is a **partial** specification of the acceptable response: the fields the consumer reads, with type/shape constraints, and nothing else. Partiality is the whole point. If the consumer asserted the full response body, every additive provider change would fail verification, and contract testing would punish exactly the evolution you want to encourage.

Provider verification is then: for each interaction, set up the named provider state, replay `reqᵢ` against a real provider, and check `actual ⊨ respᵢ` — the actual response *satisfies* the partial spec. Unknown extra fields pass. Missing required fields fail. A type mismatch fails.

This gives a clean division of labour with schema validation:

| Question | Answered by |
| --- | --- |
| Is this response legal per the published contract? | Schema/spec compliance test |
| Does any real consumer depend on this field? | Consumer-driven contract test |
| Is the business logic correct? | Provider's own unit and integration tests |
| Does the whole flow work end to end? | A small number of E2E tests |

Contract tests do **not** replace functional tests. They assert nothing about correctness of values — only about shape, presence and type.

```svg
<svg viewBox="0 0 780 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif">
  <defs><marker id="a34" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#4f46e5"/></marker></defs>
  <rect x="10" y="10" width="760" height="320" rx="14" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="390" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Consumer-driven contract flow (nothing deployed together)</text>
  <rect x="30" y="66" width="180" height="96" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="120" y="90" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Consumer CI</text>
  <text x="120" y="110" text-anchor="middle" fill="#1e293b" font-size="10">unit tests run against</text>
  <text x="120" y="126" text-anchor="middle" fill="#1e293b" font-size="10">a local Pact mock</text>
  <text x="120" y="146" text-anchor="middle" fill="#1e293b" font-size="10">emits pact.json</text>
  <rect x="290" y="66" width="200" height="96" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="390" y="90" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Pact Broker</text>
  <text x="390" y="110" text-anchor="middle" fill="#1e293b" font-size="10">stores pacts + versions</text>
  <text x="390" y="126" text-anchor="middle" fill="#1e293b" font-size="10">records verifications</text>
  <text x="390" y="146" text-anchor="middle" fill="#1e293b" font-size="10">answers can-i-deploy</text>
  <rect x="570" y="66" width="180" height="96" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="660" y="90" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Provider CI</text>
  <text x="660" y="110" text-anchor="middle" fill="#1e293b" font-size="10">replays every pact</text>
  <text x="660" y="126" text-anchor="middle" fill="#1e293b" font-size="10">against a real instance</text>
  <text x="660" y="146" text-anchor="middle" fill="#1e293b" font-size="10">publishes results</text>
  <path d="M210 100 L286 100" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a34)"/>
  <text x="248" y="92" text-anchor="middle" fill="#1e293b" font-size="9">publish</text>
  <path d="M490 100 L566 100" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a34)"/>
  <text x="528" y="92" text-anchor="middle" fill="#1e293b" font-size="9">fetch</text>
  <path d="M566 140 L494 140" stroke="#16a34a" stroke-width="2" fill="none" marker-end="url(#a34)"/>
  <text x="530" y="156" text-anchor="middle" fill="#1e293b" font-size="9">verified</text>
  <rect x="30" y="196" width="720" height="60" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="220" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Deploy gate: can-i-deploy --pacticipant payments-api --version $SHA --to-environment production</text>
  <text x="390" y="242" text-anchor="middle" fill="#1e293b" font-size="11">Green only if EVERY consumer version currently in production has verified against this provider version.</text>
  <text x="390" y="286" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">The contract is partial: it lists only what the consumer reads.</text>
  <text x="390" y="308" text-anchor="middle" fill="#1e293b" font-size="10">Extra response fields pass verification &#8212; additive provider evolution stays free.</text>
</svg>
```

### 3.3 Design-first as a review protocol

Design-first is not really about YAML; it is about **moving the argument earlier**. A contract review asks the questions that are expensive to change later: is this a resource or an RPC verb? Is the pagination cursor-based? Which errors can this operation produce? Is `amount` minor units? Is this field nullable, and what does null mean? Those debates cost an hour in a pull request and a quarter after launch.

The mechanism that makes design-first honest is the **mock**. If the consumer can build against a Prism mock generated from the spec on day one, they will find the contract's ergonomic problems while they are still cheap to fix. A design-first process without a mock is just documentation written early.

The failure mode is drift: the spec says one thing, the implementation does another. Design-first therefore *requires* a conformance gate — runtime response validation, spec-based fuzzing, or bi-directional contract testing — or it degrades into fiction within two sprints.

## 4. Architecture & Workflow

The full loop, from proposal to production deploy:

1. **Propose.** An engineer opens a PR against the spec repository adding the new operations, schemas and error responses. No implementation exists yet.
2. **Review.** Reviewers argue resource modelling, naming, nullability, pagination, idempotency and the error catalogue. `spectral lint` enforces house rules automatically so humans discuss design, not style.
3. **Merge and publish a preview.** CI bundles the spec, deploys a **Prism mock** at a stable preview URL, and generates draft SDKs.
4. **Consumer builds against the mock.** Consumer engineers write real code and real tests immediately. Their feedback triggers spec revisions while nothing is expensive.
5. **Consumer writes Pact tests.** Each consumer test declares an interaction — request, provider state, and the *minimal* expected response — and runs against Pact's in-process mock. Passing tests emit a pact file.
6. **Consumer publishes the pact** to the broker, tagged with its git SHA and its branch/environment.
7. **Provider implements** against the spec, with runtime request/response validation enabled in test and staging.
8. **Provider verification runs in provider CI.** It fetches all relevant pacts, spins up a real instance with stubbed downstreams, executes each provider-state setup hook, replays each request, and asserts satisfaction. Results are published back to the broker.
9. **Deploy gate.** Both sides run `pact-broker can-i-deploy --to-environment production`. The provider may only deploy if every consumer version currently in production has verified against it; the consumer may only deploy if the provider version in production satisfies its pact.
10. **Record deployment.** On success, `record-deployment` tells the broker which version is now live, keeping the matrix accurate for the next gate.
11. **Spec conformance in parallel.** Schemathesis fuzzes every operation from the OpenAPI document, catching responses that are legal-per-consumer but illegal-per-spec — undocumented `500`s, error bodies that are not Problem Details.

```svg
<svg viewBox="0 0 780 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif">
  <defs><marker id="b34" markerWidth="9" markerHeight="9" refX="8" refY="4.5" orient="auto"><path d="M0 0 L9 4.5 L0 9 z" fill="#0ea5e9"/></marker></defs>
  <rect x="10" y="10" width="760" height="340" rx="14" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="390" y="38" text-anchor="middle" fill="#1e293b" font-size="16" font-weight="700">Design-first pipeline, then the contract-test gate</text>
  <rect x="30" y="62" width="120" height="64" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="90" y="86" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">spec PR</text>
  <text x="90" y="104" text-anchor="middle" fill="#1e293b" font-size="10">no code yet</text>
  <rect x="175" y="62" width="120" height="64" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="235" y="86" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">review + lint</text>
  <text x="235" y="104" text-anchor="middle" fill="#1e293b" font-size="10">spectral rules</text>
  <rect x="320" y="62" width="120" height="64" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="380" y="86" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">mock deploy</text>
  <text x="380" y="104" text-anchor="middle" fill="#1e293b" font-size="10">Prism preview</text>
  <rect x="465" y="62" width="130" height="64" rx="10" fill="#fef3c7" stroke="#d97706"/>
  <text x="530" y="86" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">both build</text>
  <text x="530" y="104" text-anchor="middle" fill="#1e293b" font-size="10">in parallel</text>
  <rect x="620" y="62" width="130" height="64" rx="10" fill="#f0fdf4" stroke="#16a34a"/>
  <text x="685" y="86" text-anchor="middle" fill="#1e293b" font-size="11" font-weight="700">verify</text>
  <text x="685" y="104" text-anchor="middle" fill="#1e293b" font-size="10">pacts replayed</text>
  <path d="M150 94 L171 94" stroke="#0ea5e9" stroke-width="2" fill="none" marker-end="url(#b34)"/>
  <path d="M295 94 L316 94" stroke="#0ea5e9" stroke-width="2" fill="none" marker-end="url(#b34)"/>
  <path d="M440 94 L461 94" stroke="#0ea5e9" stroke-width="2" fill="none" marker-end="url(#b34)"/>
  <path d="M595 94 L616 94" stroke="#0ea5e9" stroke-width="2" fill="none" marker-end="url(#b34)"/>
  <rect x="30" y="160" width="345" height="76" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="202" y="184" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Test pyramid position</text>
  <text x="202" y="204" text-anchor="middle" fill="#1e293b" font-size="10">unit (many) &#8594; contract (many, fast, isolated)</text>
  <text x="202" y="222" text-anchor="middle" fill="#1e293b" font-size="10">&#8594; integration (some) &#8594; E2E (very few)</text>
  <rect x="405" y="160" width="345" height="76" rx="10" fill="#eef2ff" stroke="#4f46e5"/>
  <text x="577" y="184" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">What each layer catches</text>
  <text x="577" y="204" text-anchor="middle" fill="#1e293b" font-size="10">contract: shape drift between two services</text>
  <text x="577" y="222" text-anchor="middle" fill="#1e293b" font-size="10">spec fuzz: undocumented responses</text>
  <rect x="30" y="262" width="720" height="72" rx="10" fill="#e0f2fe" stroke="#0ea5e9"/>
  <text x="390" y="286" text-anchor="middle" fill="#1e293b" font-size="12" font-weight="700">Deployment matrix held by the broker</text>
  <text x="390" y="306" text-anchor="middle" fill="#1e293b" font-size="10">provider v42 &#215; consumer-web v9 = verified &#183; provider v42 &#215; consumer-batch v3 = FAILED</text>
  <text x="390" y="324" text-anchor="middle" fill="#1e293b" font-size="10">can-i-deploy blocks the release until every production consumer version is green</text>
</svg>
```

## 5. Implementation

### 5.1 Consumer side (JavaScript, Pact v3)

The consumer describes only what it reads. Matchers constrain type, not value:

```javascript
import { PactV3, MatchersV3 as M } from '@pact-foundation/pact';

const provider = new PactV3({
  consumer: 'checkout-web', provider: 'payments-api', dir: './pacts',
});

describe('getOrder', () => {
  it('returns the fields checkout renders', async () => {
    provider
      .given('an order ord_8812AB exists for customer cus_301')   // provider state
      .uponReceiving('a request for an existing order')
      .withRequest({
        method: 'GET', path: '/v2/orders/ord_8812AB',
        headers: { Accept: 'application/json' },
      })
      .willRespondWith({
        status: 200,
        headers: { 'Content-Type': M.regex(/application\/json.*/, 'application/json') },
        body: {
          id: M.string('ord_8812AB'),
          status: M.regex(/^(pending|paid|shipped|cancelled|refunded)$/, 'paid'),
          total: { amount: M.integer(259800), currency: M.string('INR') },
          // NOTE: created_at, items and customer_id are deliberately absent.
          // Checkout does not read them, so the provider stays free to change them.
        },
      });

    await provider.executeTest(async (mock) => {
      const order = await new OrdersClient(mock.url).get('ord_8812AB');
      expect(order.total.amount).toBe(259800);
    });
  });
});
```

Publish the resulting pact with the consumer's git SHA and branch:

```bash
pact-broker publish ./pacts \
  --consumer-app-version "$GIT_SHA" --branch "$GIT_BRANCH" \
  --broker-base-url "$PACT_BROKER_URL" --broker-token "$PACT_BROKER_TOKEN"
```

### 5.2 Provider side (Python, pact-python)

Verification runs against a real service instance. Provider states are set up by a hook endpoint that exists only in the test build:

```python
import pytest
from pact import Verifier
from fastapi.testclient import TestClient
from app.main import app

@app.post("/_pact/provider-states", include_in_schema=False)  # test build only
async def provider_states(body: dict):
    state = body["state"]
    if state == "an order ord_8812AB exists for customer cus_301":
        await store.reset()
        await store.seed_order(id="ord_8812AB", customer_id="cus_301",
                               status="paid", amount=259800, currency="INR")
    elif state == "no order ord_0000 exists":
        await store.reset()
    else:
        raise ValueError(f"unknown provider state: {state}")
    return {"result": "ok"}

def test_verify_all_consumer_pacts(live_server):
    verifier = Verifier(provider="payments-api", provider_base_url=live_server.url)
    exit_code, _ = verifier.verify_with_broker(
        broker_url=os.environ["PACT_BROKER_URL"],
        broker_token=os.environ["PACT_BROKER_TOKEN"],
        provider_version=os.environ["GIT_SHA"],
        provider_branch=os.environ["GIT_BRANCH"],
        provider_states_setup_url=f"{live_server.url}/_pact/provider-states",
        publish_verification_results=True,
        enable_pending=True,          # new consumer pacts do not break the provider build
        consumer_version_selectors=[
            {"deployedOrReleased": True},   # everything currently live
            {"mainBranch": True},           # plus the tip of main
        ],
    )
    assert exit_code == 0
```

### 5.3 The deploy gate

`can-i-deploy` is the piece that turns contract tests from a report into a control:

```bash
# Provider pipeline: may this build go to production?
pact-broker can-i-deploy \
  --pacticipant payments-api --version "$GIT_SHA" \
  --to-environment production --retry-while-unknown 12 --retry-interval 10

# On success, tell the broker what is now live so the next gate is accurate
pact-broker record-deployment \
  --pacticipant payments-api --version "$GIT_SHA" --environment production
```

A failure reads like this, and names both sides precisely:

```
Computer says no ¯\_(ツ)_/¯

CONSUMER       | C.VERSION | PROVIDER     | P.VERSION | SUCCESS?
---------------|-----------|--------------|-----------|---------
checkout-web   | 9f2c1a    | payments-api | 4b77e0    | true
billing-batch  | 3ac118    | payments-api | 4b77e0    | false

The verification for billing-batch failed:
  $.body.total.currency: Expected 'currency' but it was missing
```

### 5.4 Bi-directional contract testing

When the provider is a third party or a team that will not run Pact, you can compare the consumer's pact against the provider's **published OpenAPI document** instead of a live instance. It is strictly weaker — it proves the provider *claims* to support the interaction, not that it does — but it is far better than nothing:

```bash
pactflow publish-provider-contract ./build/openapi.yaml \
  --provider payments-api --provider-app-version "$GIT_SHA" \
  --content-type application/yaml --verification-exit-code 0 \
  --verification-results ./schemathesis-report.json \
  --verifier schemathesis
```

Pair it with spec-conformance fuzzing so the OpenAPI document is itself verified against the running service:

```bash
schemathesis run build/openapi.yaml --url https://sandbox.acme.dev/v2 \
  --checks all --report ./schemathesis-report.json
```

### 5.5 Design-first scaffolding

```bash
redocly bundle openapi/root.yaml -o build/openapi.yaml   # one document
redocly lint build/openapi.yaml                          # house rules
prism mock build/openapi.yaml --port 4010 --dynamic      # consumers unblock here
openapi-generator-cli generate -i build/openapi.yaml \
  -g python-fastapi -o server/generated                  # stubs, not business logic
```

> **Optimization note:** Provider verification cost is dominated by process startup and provider-state setup, not by the HTTP calls. Boot the provider **once** per verification run rather than per interaction, make state handlers idempotent and cheap (truncate-and-seed a single table, not a full migration), and stub downstream dependencies at the network boundary so no interaction touches a real database cluster. Use `consumer_version_selectors` with `deployedOrReleased` plus `mainBranch` instead of verifying every historical pact — otherwise the run grows without bound as branches accumulate. A well-tuned provider verification for 40 consumers finishes in under two minutes; a naive one takes 40.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
| --- | --- | --- |
| **Design-first** | Contract debated when it is cheap; consumers unblocked by a mock on day one | Slower to first commit; drifts into fiction without an automated conformance gate |
| **Code-first** | Spec cannot drift from implementation; zero authoring overhead | Cannot review a contract before it exists; spec inherits framework quirks |
| **Consumer-driven contracts** | Precise: tells you exactly which consumer breaks and on which field | Requires consumer teams to write and maintain pacts; useless for unknown public consumers |
| **Partial (matcher-based) contracts** | Additive provider changes stay free; contracts do not pin fixture data | Under-specified matchers hide real breaks (`M.string()` accepts any string) |
| **Pact Broker + can-i-deploy** | Turns testing into an enforceable deploy gate; no shared environment needed | Another service to run and secure; a broker outage blocks every deploy unless you plan for it |
| **Bi-directional contract testing** | Works with third-party or uncooperative providers; cheap | Only proves the spec claims support, not that the implementation delivers it |
| **Spec-conformance fuzzing** | Finds undocumented responses no consumer thought to ask about | Noisy at first; needs auth/state configuration to reach interesting code paths |
| **Contract tests replacing E2E** | Fast, deterministic, parallel, no environment lock | Assert nothing about behaviour or data correctness — you still need functional tests |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Asserting the entire response body in a pact.** Every additive provider change now fails verification, so the provider stops evolving or stops running the tests. → ✅ Assert only the fields the consumer reads, with matchers on type and shape.
2. ⚠️ **Using exact-value matching on generated data.** Pinning `id: "ord_8812AB"` in the response expectation makes verification depend on fixture identity. → ✅ Use `like`/`regex`/`integer` matchers; pin values only when the value itself is semantically load-bearing.
3. ⚠️ **Provider states that depend on ambient database contents.** Verification passes locally and fails in CI. → ✅ Every state handler resets and seeds exactly what it needs, idempotently.
4. ⚠️ **Writing pacts from the provider's docs rather than the consumer's code.** You get a restatement of the spec, not evidence of dependence. → ✅ Generate pacts from tests that exercise the consumer's real client code path.
5. ⚠️ **No deploy gate.** Verification results are published and nobody reads them. → ✅ Wire `can-i-deploy` into both pipelines as a required step, and `record-deployment` on success.
6. ⚠️ **Treating contract tests as functional tests.** Teams start asserting business rules in pacts and the contract becomes a slow, brittle E2E suite. → ✅ Contracts assert shape and presence only; behaviour belongs in the provider's own tests.
7. ⚠️ **Design-first with no conformance gate.** The spec says `422`, the service returns `400`, and nobody notices for a quarter. → ✅ Runtime response validation in staging plus spec fuzzing in CI.
8. ⚠️ **Not using `enable_pending`.** A new consumer pact instantly breaks the provider's main build, and the provider team disables verification. → ✅ New pacts start pending; they block only once verified successfully at least once.
9. ⚠️ **Verifying every historical pact.** The run grows without bound as branches accumulate. → ✅ Use consumer version selectors — `deployedOrReleased` plus `mainBranch` — so you verify what is live and what is next.
10. ⚠️ **Contract testing a public API with unknown consumers.** CDC needs a known, cooperating consumer. → ✅ For public APIs use spec compliance, schema fuzzing and usage telemetry; reserve CDC for internal or partner integrations.
11. ⚠️ **Committing pact files to the provider's repo.** They rot immediately and nobody knows which consumer version they represent. → ✅ Publish to a broker keyed by consumer version and branch; the provider fetches, never stores.
12. ⚠️ **Skipping the mock in design-first.** Without a mock, "design-first" is just documentation written early and the ergonomic problems are found after implementation. → ✅ Deploy a Prism mock from the spec PR and make consumers build against it before the provider writes code.

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

A verification failure should name four things: the consumer, the interaction description, the JSON path, and the expectation versus what arrived. Pact's default output does; keep it and do not swallow it in a test wrapper. When a verification fails only in CI, the cause is almost always provider state — dump the seeded rows on failure. When a consumer's pact passes but production breaks, the contract was under-specified: the consumer read a field it never declared, which is why generating pacts from the real client code path (not hand-written fixtures) matters.

### Monitoring

- Broker **verification matrix age** — pacts unverified for more than a week mean the provider pipeline is silently skipping them.
- `can_i_deploy_failures_total{pacticipant}` — a rising trend means contracts and reality are diverging faster than teams are reconciling them.
- Provider verification duration and pending-pact count, tracked per run.
- Spec-conformance failures from Schemathesis, labelled by operation.
- In production, keep the runtime response-validation counter from chapter 33 (`openapi_response_validation_failures_total`) — it is the last line of defence when both contract layers agree and both are wrong.

### Security

The broker holds a complete map of your internal service topology and every request/response shape — treat it as sensitive infrastructure with SSO and per-team tokens, not a public wiki. Pact files must never contain real credentials, real customer PII, or production tokens; scrub fixtures and use matchers so contracts describe shape rather than data. The provider-state endpoint (`/_pact/provider-states`) resets and seeds data — it must exist only in test builds, be excluded from the published spec, and be impossible to reach in any environment holding real data.

### Performance & Scaling

Boot the provider once per verification run and stub downstream dependencies at the network boundary. Use consumer version selectors to bound the pact set. Run consumer pact tests as part of the ordinary unit-test suite — they are in-process and take milliseconds, so there is no reason to isolate them. As the organisation grows, publish a broker dashboard of unverified and pending contracts per team; the failure mode at scale is not slow tests but stale contracts nobody owns.

## 9. Interview Questions

**Q: What is a contract test, and how is it different from an integration test?**
A: A contract test verifies the interface between two services — shapes, status codes, presence of fields — without deploying both together. An integration test exercises real collaborating systems and requires an environment. Contract tests are fast, deterministic and independently runnable; integration tests are slower, flakier, but prove behaviour rather than shape.

**Q: Why "consumer-driven"? Why not let the provider define the contract?**
A: Because the provider's spec describes everything that is *legal*, while the consumer knows what is actually *relied upon*. A provider-defined contract cannot tell you whether removing a field is safe. Generating the contract from the consumer's own tests produces exactly that information, per consumer.

**Q: Why must a pact specify only part of the response?**
A: If a consumer asserted the full body, every additive provider change would fail verification, and contract testing would penalise the safest kind of evolution. Partial expectations plus type matchers mean unknown extra fields pass, so the provider stays free to add.

**Q: What is a provider state and why does it exist?**
A: A named precondition the provider sets up before replaying an interaction — "an order ord_8812AB exists." Without it, verification depends on whatever data happens to be in the test database, which makes results non-reproducible. State handlers should reset and seed exactly what the interaction needs.

**Q: What does `can-i-deploy` actually check?**
A: It asks the broker whether the version you want to deploy has a successful verification against every counterparty version currently in the target environment. For a provider, that means every consumer version live in production has verified against this build. It converts contract testing from a report into a deploy gate.

**Q: Design-first or code-first?**
A: Design-first for public APIs and any surface with multiple consumer teams, because the contract can be reviewed and mocked before implementation. Code-first for internal services where the consumer is one team you can talk to. Both need an automated conformance gate — design-first drifts from the code, code-first drifts from what you intended.

**Q: When is contract testing the wrong tool?**
A: When you do not know or control your consumers — a public API with thousands of anonymous integrators cannot produce pacts. Then you rely on spec compliance testing, schema fuzzing, field-level usage telemetry and a deprecation program. Contract testing is also wrong for asserting business behaviour; it says nothing about whether values are correct.

**Q: (Senior) Roll out contract testing across 40 services with no shared staging. What is your sequence?**
A: Start with the two or three highest-traffic provider/consumer pairs to prove value, run a broker with SSO and per-team tokens, and enable `enable_pending` from day one so new pacts never break existing builds. Add verification to provider pipelines as non-blocking first, then flip to blocking once green for two weeks, then add `can-i-deploy` and `record-deployment` to both sides. Only then expand horizontally, and track unverified/pending contracts per team on a visible dashboard so staleness has an owner.

**Q: (Senior) How do contract tests and OpenAPI validation divide responsibility?**
A: The spec answers "is this response legal?" and is the right gate for public APIs and for catching undocumented responses via fuzzing. Contracts answer "does any real consumer depend on this?" and are the right gate for internal removal decisions. Run both: spec-conformance fuzzing in the provider pipeline, CDC verification for known consumers, and a breaking-change differ on the spec itself. They fail in different situations, which is the point.

**Q: (Senior) A provider must ship an urgent breaking change but one consumer's pact still fails. What do you do?**
A: First establish whether the failing consumer version is actually deployed — `can-i-deploy` distinguishes live versions from stale branches, and a failing branch pact is not a production risk. If it is live, the options are: ship the change behind a version or feature flag so both shapes coexist, coordinate a same-day consumer release, or, for security fixes, ship and notify. What you must not do is delete the pact to make the pipeline green, because that destroys the only record of the dependency.

**Q: What are matchers and why do they matter?**
A: Matchers express "a string like this" or "an integer" rather than a literal value, so contracts constrain type and structure without pinning to fixture data. Without them, verification depends on the provider's test data matching the consumer's, which is brittle. Over-loose matchers are the opposite failure: `M.string()` on a field whose format matters will not catch a real break.

**Q: What is bi-directional contract testing and when would you choose it?**
A: Instead of replaying pacts against a live provider, the broker compares the consumer's pact against the provider's published OpenAPI document plus that provider's own self-verification results. It is weaker — it proves the provider claims to support the interaction — but it works when the provider is a third party or refuses to run verification, and it costs nothing to add.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Design-first means the OpenAPI contract is authored, linted and reviewed before implementation, with a Prism mock deployed from the spec PR so consumers build immediately; it degrades into fiction without a conformance gate. Contract testing means each consumer generates a **partial** contract from its own tests — only the fields it reads, constrained by matchers — publishes it to a broker keyed by version and branch, and the provider replays every relevant pact against a real instance with named provider states. Extra response fields pass, so additive evolution stays free. `can-i-deploy` converts the results into a deploy gate: a provider ships only if every consumer version live in production has verified against it. Use `enable_pending` so new pacts never break existing builds, and consumer version selectors (`deployedOrReleased`, `mainBranch`) so the run stays bounded. Contracts assert shape, never behaviour; you still need unit, integration and a few E2E tests, plus spec-conformance fuzzing for the responses no consumer thought to ask about.

| Concern | Tool / command |
| --- | --- |
| Author + lint the contract | `redocly bundle`, `redocly lint`, `spectral lint` |
| Unblock consumers | `prism mock build/openapi.yaml --dynamic` |
| Consumer contract | Pact test → `./pacts/*.json` |
| Publish contract | `pact-broker publish --consumer-app-version $SHA --branch $BRANCH` |
| Provider verification | `Verifier.verify_with_broker(..., enable_pending=True)` |
| Which pacts to verify | selectors: `deployedOrReleased`, `mainBranch` |
| Deploy gate | `pact-broker can-i-deploy --to-environment production` |
| After deploy | `pact-broker record-deployment` |
| Spec conformance | `schemathesis run --checks all` |
| Breaking-change gate | `oasdiff breaking --fail-on ERR` |

**Flash cards**

- **Why are contract expectations partial?** → So additive provider changes pass; asserting the full body would punish safe evolution.
- **What does `can-i-deploy` guarantee?** → Every counterparty version live in the target environment has a successful verification against the version you are about to ship.
- **What is a provider state?** → A named precondition the provider seeds before replaying an interaction, making verification reproducible.
- **Spec test vs contract test?** → Spec: "is this legal?" Contract: "does a real consumer depend on it?" Run both.
- **When does CDC not apply?** → Public APIs with unknown consumers; use spec compliance, fuzzing and usage telemetry instead.

## 11. Hands-On Exercises & Mini Project

- [ ] Write an OpenAPI document for a three-endpoint service, run `prism mock --dynamic`, and build a small consumer against the mock before writing any server code. Note every contract problem you find at this stage.
- [ ] Write a Pact consumer test that asserts only two fields of a five-field response. Add a third field on the provider and confirm verification still passes; rename one of your two and confirm it fails.
- [ ] Implement a provider-state endpoint with reset-and-seed handlers for three states, and prove verification is reproducible by running it twice against a dirty database.
- [ ] Wire `can-i-deploy` into a pipeline with two consumers. Break one consumer's expectation and confirm the provider's deploy is blocked with a readable matrix.
- [ ] Run `schemathesis run --checks all` against your service and fix every conformance failure; count how many were undocumented `500`s.

### Mini Project — contract-tested orders platform

**Goal.** One provider, two consumers, no shared environment, and a deploy gate that actually blocks.

**Requirements.**
1. A design-first OpenAPI 3.1 spec repo with `redocly lint` and a Spectral ruleset, publishing a Prism mock on every PR.
2. `payments-api` (FastAPI) implementing the spec, with runtime request validation and sampled response validation.
3. Two consumers — a web checkout and a nightly batch job — each with Pact tests generating partial contracts from their real client code.
4. A Pact Broker (self-hosted `pact-foundation/pact-broker`) with pacts published per SHA and branch, and provider verification using `deployedOrReleased` + `mainBranch` selectors and `enable_pending`.
5. `can-i-deploy` + `record-deployment` in all three pipelines, plus a Schemathesis conformance job in the provider pipeline.

**Extensions.**
- Add a webhook contract: the provider is now a consumer of the subscriber's endpoint, so write the pact in the other direction.
- Add bi-directional contract testing for one genuinely third-party dependency and compare what it catches versus full verification.
- Instrument how long the provider verification takes as consumers grow, then optimise it: boot once, stub downstreams, bound the selector set. Chart the before and after.

## 12. Related Topics & Free Learning Resources

**Sibling chapters.** *OpenAPI: The Machine-Readable Contract* (chapter 33) is the artifact design-first produces; *Backward Compatibility & Deprecation* (chapter 32) explains what the contracts are protecting; *API Versioning Strategies* (chapter 31) is the escape hatch when a contract cannot be preserved; *Testing REST APIs* (chapter 36) places contract tests in the wider pyramid; *API Documentation That Developers Love* (chapter 35) covers the human half of the same contract.

- **Pact documentation** — Pact Foundation · *Intermediate* · the canonical reference for consumer-driven contract testing: matchers, provider states, pending pacts, selectors, and `can-i-deploy`. <https://docs.pact.io/>
- **Consumer-Driven Contracts: A Service Evolution Pattern** — Ian Robinson, martinfowler.com · *Intermediate* · the original 2006 articulation of the idea; still the clearest explanation of *why* consumers should define contracts. <https://martinfowler.com/articles/consumerDrivenContracts.html>
- **ContractTest** — Martin Fowler · *Beginner* · a short, precise definition of the pattern and where it sits relative to integration testing. <https://martinfowler.com/bliki/ContractTest.html>
- **Testing Microservices, the sane way** — Cindy Sridharan · *Advanced* · an honest, opinionated survey of what contract tests do and do not buy you at scale, and where E2E remains necessary. <https://copyconstruct.medium.com/testing-microservices-the-sane-way-9bb31d158c16>
- **Schemathesis documentation** — Schemathesis · *Advanced* · property-based conformance testing driven by your OpenAPI schemas; the complement to CDC for undocumented responses. <https://schemathesis.readthedocs.io/>
- **Prism — API mock server** — Stoplight · *Beginner* · the mock that makes design-first real; static and dynamic response modes plus request validation. <https://docs.stoplight.io/docs/prism>
- **OpenAPI Specification 3.1.1** — OpenAPI Initiative · *Intermediate* · the contract format everything above assumes. <https://spec.openapis.org/oas/latest.html>
- **Google API Improvement Proposals** — Google · *Advanced* · a large body of design decisions worth having settled *before* implementation; excellent input for design-first review checklists. <https://google.aip.dev/>

---

*REST API Handbook — chapter 34.*
