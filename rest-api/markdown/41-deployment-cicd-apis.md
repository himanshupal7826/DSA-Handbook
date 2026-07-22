# 41 · Deploying APIs: CI/CD, Blue-Green & Canary

> **In one line:** Shipping an API safely means a pipeline that mechanically blocks breaking schema changes, a rollout strategy that exposes the new version to a small slice of real traffic first, a feature flag that separates deploy from release, and a rollback you can execute in under a minute without thinking.

---

## 1. Overview

Deploying an API is not deploying a website. A website's old version stops existing the moment you ship; an API's old version lives on in every mobile app that has not been updated, every partner's cron job, and every SDK pinned in someone's `requirements.txt`. That asymmetry drives everything in this chapter: you cannot "just roll forward", you must assume **two versions run simultaneously**, and you must assume **the client will not update**. A deployment strategy for APIs is really a strategy for controlled coexistence.

The problem this solves is the historical default of big-bang releases — a maintenance window, a full cutover, and a rollback plan that consists of a database backup and hope. That model produced long, risky, infrequent releases, which made each release bigger, which made it riskier. The DevOps/continuous-delivery response (Humble & Farley's *Continuous Delivery*, 2010; later quantified by the DORA research programme) inverted it: deploy small changes very often, automate every gate, and measure four metrics — deployment frequency, lead time for changes, change failure rate, and time to restore service. Elite teams deploy multiple times a day with a change failure rate under 15% and restore in under an hour, not because they are braver but because each change is small and each rollout is reversible.

Three techniques do most of the work. **Blue-green** keeps two complete production environments and flips traffic between them, giving an instant, whole-fleet rollback at the cost of double the infrastructure. **Canary** routes a small percentage of real traffic to the new version, watches its error rate and latency against the old version, and promotes or aborts automatically — trading rollout time for a much smaller blast radius. **Feature flags** decouple *deploy* (code is in production, dark) from *release* (behaviour is on for some users), which means the riskiest part of a change can be turned off in seconds without a redeploy, and means a rollback is a config change rather than a rebuild.

Underneath all of it sits the constraint that makes API deployment genuinely hard: **the database**. Code can be rolled back in seconds; a migration that dropped a column cannot. This forces the **expand–migrate–contract** discipline — every schema change is split into a backward-compatible expansion, a data migration, and a contraction that only happens after the old code is definitively gone. Get this wrong and your instant rollback is not a rollback at all.

A concrete example worth internalising: Stripe never breaks an API. They ship changes constantly, but every backward-incompatible change is gated behind a dated version (`Stripe-Version: 2024-06-20`), old versions are maintained essentially indefinitely, and requests are transformed between versions by a chain of small, tested compatibility shims. GitHub takes a similar posture with previews and dated media types, plus `Sunset` headers when something genuinely must go. The lesson for a pipeline: the gate that matters most is not "do the tests pass" but "does this change break an existing consumer" — and that question can and should be answered mechanically.

---

## 2. Core Concepts

- **Continuous integration (CI)** — every commit is built and tested automatically against the mainline, so integration problems surface in minutes rather than at release.
- **Continuous delivery / deployment** — delivery means every green build is *releasable*; deployment means every green build actually *goes* to production automatically.
- **Artifact immutability** — build once, produce a digest-addressed image, and promote that exact artifact through environments; never rebuild per environment.
- **Blue-green deployment** — two identical production environments; traffic is switched wholesale from blue to green, and back instantly if needed.
- **Canary release** — the new version receives a small, growing share of production traffic while automated analysis compares it against the baseline.
- **Rolling update** — instances are replaced gradually in batches; the default in Kubernetes, cheap but with a mixed-version window and slow rollback.
- **Feature flag / toggle** — a runtime switch that enables behaviour for a subset of users, separating deploy from release and enabling instant kill-switches.
- **Schema-diff gate** — a CI step that diffs the OpenAPI spec against the deployed one and fails the build on a backward-incompatible change.
- **Expand–migrate–contract** — the three-phase database change pattern that keeps old and new code simultaneously runnable.
- **Progressive delivery** — the umbrella term for canary, blue-green, and flag-based rollouts driven by automated metric analysis.
- **Smoke test / post-deploy verification** — a small suite run against the freshly deployed environment to confirm it is genuinely serving.
- **Rollback vs roll-forward** — reverting to the previous artifact versus shipping a fix; rollback must be the default because it is bounded in time.
- **Connection draining** — letting in-flight requests finish before terminating an instance, so a deploy never turns into a burst of `502`s.

---

## 3. Theory & Principles

**The compatibility contract.** The entire pipeline exists to enforce one invariant: *at any instant, every deployed version of the service must be able to serve every client version that exists.* This decomposes into two directions that are easy to confuse.

- **Backward compatibility** — new server code correctly serves old clients. This is what a schema-diff gate protects.
- **Forward compatibility** — old client code tolerates new server responses. This is what "clients must ignore unknown fields" buys you, and it must be documented as a client obligation because you cannot enforce it.

Concretely, these changes are **safe** (additive): adding an optional request field, adding a response field, adding a new endpoint, adding an enum value *if clients were told to tolerate unknowns*, relaxing a validation rule. These are **breaking**: removing or renaming any field, making an optional request field required, tightening validation, changing a type, changing a status code for an existing condition, changing the default of a parameter, changing pagination semantics, and removing an enum value. The asymmetry to remember: **adding to a response is usually safe; adding to a request is safe only if optional; removing anything is never safe.**

**Why deployment must be separated from release.** If deploying code is the same act as changing behaviour, then every behavioural risk is coupled to a build-and-deploy cycle measured in minutes, and every rollback is too. Feature flags break that coupling: the code ships dark, is enabled for 1% of users, and can be disabled in the time it takes a config value to propagate — seconds. The cost is real (flag combinations are a state space; stale flags are technical debt with a security surface), so the discipline is a short flag lifecycle: every flag gets an owner and an expiry date, and removing it is part of the feature's definition of done.

**Blue-green versus canary, quantitatively.** Suppose a bad release breaks 5% of requests and you serve 10,000 rps.

- **Blue-green:** 100% of traffic hits the bad version. If detection plus flip takes 90 seconds, roughly `10,000 × 90 × 0.05 = 45,000` failed requests.
- **Canary at 5% for 10 minutes:** only 500 rps hit the bad version, and automated analysis aborts within, say, 120 seconds — roughly `500 × 120 × 0.05 = 3,000` failed requests, a 15× reduction in blast radius.

Canary wins on blast radius; blue-green wins on rollback *speed* and simplicity, and is the only clean option when the two versions cannot coexist (an incompatible protocol or cache format). Most mature setups use both: blue-green for the environment-level flip, canary weights within the green environment.

**The statistics of canary analysis.** The naive check — "is the canary's error rate higher?" — produces false alarms at low traffic. With a baseline error rate of 0.5% and a canary receiving 500 requests, the expected error count is 2.5 with a standard deviation of about 1.6, so seeing 6 errors is unremarkable noise. Two rules follow: **compare canary against a concurrent baseline** (not against yesterday, which confounds time-of-day and other deploys), and **require a minimum sample size** before judging — typically thousands of requests per step. Practical canary analysis (Kayenta, Argo Rollouts' AnalysisTemplate, Flagger) uses one-sided tests or simple thresholds on error rate, p99 latency, and saturation, evaluated over fixed intervals, with an explicit "insufficient data" state that neither promotes nor aborts.

**Expand–migrate–contract.** Renaming `email` to `email_address` in a table under a live service is three deploys, not one:

1. **Expand.** Add the new nullable column. Deploy code that **writes both** and **reads the old**. Fully backward compatible; rollback is free.
2. **Migrate.** Backfill in batches. Deploy code that writes both and **reads the new**. Still rollback-safe, because the old column is still being written.
3. **Contract.** Only once no rollback target reads the old column: stop writing it, then drop it in a later deploy.

Skipping to a single "rename column" migration means the previous artifact can no longer run, so your rollback button is a lie. The same three-phase logic applies to API fields, enum values, and message schemas.

```svg
<svg viewBox="0 0 760 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="400" fill="#f8fafc"/>
  <text x="380" y="26" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">Blast radius: blue-green flip vs. progressive canary</text>
  <text x="30" y="56" font-size="12" font-weight="bold" fill="#1e293b">Blue-green: 100% of traffic on the new version immediately</text>
  <rect x="30" y="66" width="700" height="34" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="120" y="88" font-size="11" fill="#1e293b">blue (old) serving 100%</text>
  <rect x="330" y="66" width="400" height="34" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="430" y="88" font-size="11" fill="#1e293b">green (bad) serving 100%  &#8594;  45,000 failed requests before rollback</text>
  <line x1="330" y1="60" x2="330" y2="106" stroke="#1e293b" stroke-width="2" stroke-dasharray="4"/>
  <text x="330" y="120" text-anchor="middle" font-size="10" fill="#1e293b">flip</text>
  <text x="30" y="152" font-size="12" font-weight="bold" fill="#1e293b">Canary: weights step up only while automated analysis passes</text>
  <rect x="30" y="164" width="140" height="30" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="100" y="184" text-anchor="middle" font-size="11" fill="#1e293b">5%  /  2 min</text>
  <rect x="176" y="164" width="140" height="30" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="246" y="184" text-anchor="middle" font-size="11" fill="#1e293b">25%  /  5 min</text>
  <rect x="322" y="164" width="140" height="30" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="392" y="184" text-anchor="middle" font-size="11" fill="#1e293b">50%  /  5 min</text>
  <rect x="468" y="164" width="140" height="30" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="538" y="184" text-anchor="middle" font-size="11" fill="#1e293b">100% promote</text>
  <rect x="176" y="206" width="286" height="30" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="319" y="226" text-anchor="middle" font-size="11" fill="#1e293b">analysis fails &#8594; abort, weight back to 0%</text>
  <line x1="246" y1="194" x2="246" y2="204" stroke="#dc2626" stroke-width="2"/>
  <text x="620" y="184" font-size="11" fill="#1e293b">~3,000 failed reqs</text>
  <text x="620" y="200" font-size="11" fill="#1e293b">15&#215; smaller blast</text>
  <line x1="30" y1="256" x2="730" y2="256" stroke="#94a3b8" stroke-width="1"/>
  <text x="30" y="282" font-size="12" font-weight="bold" fill="#1e293b">Expand &#8594; migrate &#8594; contract keeps rollback honest</text>
  <rect x="30" y="294" width="216" height="86" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="138" y="316" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">1 EXPAND</text>
  <text x="42" y="338" font-size="10" fill="#1e293b">add nullable email_address</text>
  <text x="42" y="356" font-size="10" fill="#1e293b">write BOTH, read OLD</text>
  <text x="42" y="374" font-size="10" fill="#16a34a">rollback: free</text>
  <rect x="272" y="294" width="216" height="86" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="380" y="316" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">2 MIGRATE</text>
  <text x="284" y="338" font-size="10" fill="#1e293b">backfill in batches</text>
  <text x="284" y="356" font-size="10" fill="#1e293b">write BOTH, read NEW</text>
  <text x="284" y="374" font-size="10" fill="#16a34a">rollback: still safe</text>
  <rect x="514" y="294" width="216" height="86" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="622" y="316" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">3 CONTRACT</text>
  <text x="526" y="338" font-size="10" fill="#1e293b">stop writing old, then DROP</text>
  <text x="526" y="356" font-size="10" fill="#1e293b">only after old code is gone</text>
  <text x="526" y="374" font-size="10" fill="#dc2626">rollback window closes here</text>
</svg>
```

---

## 4. Architecture & Workflow

A complete pipeline from commit to promoted canary, with every gate named.

1. **Commit and pre-merge CI.** Lint, unit tests, and type checks run on the pull request. A **spectral** lint pass enforces the API style guide (naming, required error schema, pagination conventions). Total budget: under 5 minutes, because a slow pipeline is a pipeline people route around.
2. **Schema-diff gate.** `oasdiff` (or `openapi-diff`) compares the PR's `openapi.yaml` against the spec currently deployed in production. Additive changes pass; breaking changes **fail the build** unless the PR also bumps the version and carries a `breaking-change-approved` label with a migration note. This is the single highest-value gate in an API pipeline.
3. **Contract verification.** Consumer pacts from the Pact Broker are replayed against the built service. If the change removes a field a known consumer reads, the *provider's* build fails before merge.
4. **Build once.** A single container image is built and pushed, addressed by digest (`registry/orders-api@sha256:9c4f…`), signed (cosign), and accompanied by an SBOM. Every later environment uses this exact digest — never a rebuild, never a mutable `:latest`.
5. **Ephemeral environment tests.** The image is deployed to a throwaway namespace with a seeded database. Integration tests run against it, plus a Schemathesis fuzz run that generates requests from the OpenAPI spec and asserts responses match it.
6. **Deploy to staging + migration dry-run.** Migrations run with `--dry-run` and are checked for lock-taking DDL (`ALTER TABLE … ADD COLUMN NOT NULL DEFAULT` on a big table in older Postgres, index creation without `CONCURRENTLY`) by an automated linter such as `squawk`.
7. **Database migration, expand phase only.** Migrations deploy **separately from and before** the application, and only ever additive at this stage. The rule enforced in CI: a migration PR may not contain `DROP`, `RENAME`, or a `NOT NULL` addition without an accompanying approved exception.
8. **Blue-green environment provision.** The green deployment comes up alongside blue with zero traffic. Readiness probes must pass; a smoke suite runs against green directly using a header-based route (`X-Canary: always`) so it is testable without any public traffic.
9. **Canary step 1 — 5% for 5 minutes.** The gateway or mesh shifts 5% of traffic to green. Automated analysis compares canary versus baseline on: `5xx` rate, p99 latency, and saturation, evaluated at 60-second intervals, requiring a minimum request count before judging.
10. **Progressive steps.** 5% → 25% → 50% → 100%, each with its own dwell time and analysis. Any failed interval triggers an automatic abort: weight to 0, green scaled down, and a notification with the failing metric and a link to the trace exemplars.
11. **Bake and promote.** After 100% for a bake period (often an hour, sometimes a day for high-risk changes), green becomes the new blue. Old blue is kept warm for the rollback window, then reclaimed.
12. **Release, separately.** The new behaviour is behind a flag, still off. It is enabled for internal users, then 1%, then a ring of beta customers, then everyone — each step reversible in seconds without a deploy.
13. **Contract phase.** Days or weeks later, once no rollback target reads the old column and no client uses the old field, a separate PR removes the compatibility code and drops the column. For public API fields, this is preceded by `Deprecation` and `Sunset` headers and a documented notice period.
14. **Rollback path, always ready.** One command (`argo rollouts undo`, `kubectl rollout undo`, or repointing the blue-green selector) restores the previous digest. Because migrations were expand-only, the previous artifact still runs correctly against the current schema.

```svg
<svg viewBox="0 0 800 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="800" height="400" fill="#ffffff"/>
  <text x="400" y="24" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">Pipeline gates, then progressive rollout with automatic abort</text>
  <rect x="16" y="46" width="112" height="56" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="72" y="68" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">commit / PR</text>
  <text x="72" y="86" text-anchor="middle" font-size="10" fill="#1e293b">lint, unit, types</text>
  <rect x="144" y="46" width="120" height="56" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="204" y="68" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">schema diff</text>
  <text x="204" y="86" text-anchor="middle" font-size="10" fill="#1e293b">breaking &#8594; FAIL</text>
  <rect x="280" y="46" width="120" height="56" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="340" y="68" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">pact verify</text>
  <text x="340" y="86" text-anchor="middle" font-size="10" fill="#1e293b">consumers still ok</text>
  <rect x="416" y="46" width="130" height="56" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="481" y="68" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">build once</text>
  <text x="481" y="86" text-anchor="middle" font-size="10" fill="#1e293b">image@sha256, signed</text>
  <rect x="562" y="46" width="130" height="56" rx="8" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="627" y="68" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">ephemeral env</text>
  <text x="627" y="86" text-anchor="middle" font-size="10" fill="#1e293b">integration + fuzz</text>
  <line x1="128" y1="74" x2="142" y2="74" stroke="#94a3b8" stroke-width="2"/>
  <line x1="264" y1="74" x2="278" y2="74" stroke="#94a3b8" stroke-width="2"/>
  <line x1="400" y1="74" x2="414" y2="74" stroke="#94a3b8" stroke-width="2"/>
  <line x1="546" y1="74" x2="560" y2="74" stroke="#94a3b8" stroke-width="2"/>
  <rect x="16" y="126" width="200" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="116" y="148" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">migration: EXPAND only</text>
  <text x="116" y="166" text-anchor="middle" font-size="10" fill="#1e293b">additive DDL, deployed BEFORE code</text>
  <text x="116" y="180" text-anchor="middle" font-size="10" fill="#1e293b">no DROP / RENAME / NOT NULL</text>
  <rect x="240" y="126" width="200" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="340" y="148" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">green up, 0% traffic</text>
  <text x="340" y="166" text-anchor="middle" font-size="10" fill="#1e293b">readiness probes pass</text>
  <text x="340" y="180" text-anchor="middle" font-size="10" fill="#1e293b">smoke via X-Canary: always</text>
  <rect x="464" y="126" width="228" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="578" y="148" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">feature flag OFF</text>
  <text x="578" y="166" text-anchor="middle" font-size="10" fill="#1e293b">deploy &#8800; release</text>
  <text x="578" y="180" text-anchor="middle" font-size="10" fill="#1e293b">enable later: internal &#8594; 1% &#8594; all</text>
  <rect x="16" y="212" width="676" height="106" rx="10" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="30" y="234" font-size="12" font-weight="bold" fill="#1e293b">Canary analysis loop (repeats per weight step)</text>
  <rect x="34" y="246" width="120" height="56" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="94" y="268" text-anchor="middle" font-size="10" fill="#1e293b">shift weight</text>
  <text x="94" y="286" text-anchor="middle" font-size="10" fill="#1e293b">5 / 25 / 50 / 100</text>
  <rect x="176" y="246" width="130" height="56" rx="6" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="241" y="264" text-anchor="middle" font-size="10" fill="#1e293b">dwell + collect</text>
  <text x="241" y="280" text-anchor="middle" font-size="10" fill="#1e293b">min sample size</text>
  <text x="241" y="295" text-anchor="middle" font-size="10" fill="#1e293b">else: no verdict</text>
  <rect x="328" y="246" width="160" height="56" rx="6" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="408" y="264" text-anchor="middle" font-size="10" fill="#1e293b">compare vs CONCURRENT</text>
  <text x="408" y="280" text-anchor="middle" font-size="10" fill="#1e293b">baseline: 5xx, p99, sat</text>
  <text x="408" y="295" text-anchor="middle" font-size="10" fill="#1e293b">not vs yesterday</text>
  <rect x="510" y="246" width="80" height="56" rx="6" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="550" y="272" text-anchor="middle" font-size="10" fill="#1e293b">pass &#8594;</text>
  <text x="550" y="288" text-anchor="middle" font-size="10" fill="#1e293b">next step</text>
  <rect x="600" y="246" width="80" height="56" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="640" y="272" text-anchor="middle" font-size="10" fill="#1e293b">fail &#8594;</text>
  <text x="640" y="288" text-anchor="middle" font-size="10" fill="#1e293b">abort to 0%</text>
  <line x1="154" y1="274" x2="174" y2="274" stroke="#0ea5e9" stroke-width="2"/>
  <line x1="306" y1="274" x2="326" y2="274" stroke="#0ea5e9" stroke-width="2"/>
  <line x1="488" y1="266" x2="508" y2="266" stroke="#16a34a" stroke-width="2"/>
  <line x1="488" y1="286" x2="598" y2="286" stroke="#dc2626" stroke-width="2" stroke-dasharray="4"/>
  <rect x="16" y="332" width="676" height="52" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="30" y="354" font-size="12" font-weight="bold" fill="#1e293b">Rollback stays valid ONLY while the previous artifact still runs against the current schema</text>
  <text x="30" y="374" font-size="11" fill="#1e293b">CONTRACT (drop the old column, delete the shim) closes that window &#8212; do it days later, in its own deploy, after Sunset.</text>
</svg>
```

---

## 5. Implementation

### The schema-diff gate

```yaml
name: api-ci
on: [pull_request]
jobs:
  contract:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Lint the spec against the house style guide
        run: npx @stoplight/spectral-cli lint openapi.yaml --ruleset .spectral.yaml --fail-severity error

      - name: Fetch the spec currently serving production
        run: curl -fsSL https://api.example.com/openapi.yaml -o /tmp/prod.yaml

      - name: Fail on breaking changes
        run: |
          npx oasdiff breaking /tmp/prod.yaml openapi.yaml \
            --fail-on ERR --format githubactions

      - name: Report additive changes for the changelog
        run: npx oasdiff changelog /tmp/prod.yaml openapi.yaml --format markdown >> $GITHUB_STEP_SUMMARY

      - name: Verify consumer contracts
        run: |
          pact-provider-verifier --provider orders-api \
            --broker-base-url "$PACT_BROKER_URL" \
            --provider-app-version "${GITHUB_SHA}" \
            --publish-verification-results
```

A representative failure — precise enough to act on, which is what makes the gate trusted rather than bypassed:

```text
1 breaking change detected between /tmp/prod.yaml and openapi.yaml

ERR  response-property-removed
     in API GET /v1/orders/{id}
     removed the response property 'customer_email' from the 200 response
     -> use expand/contract: keep the field, mark it deprecated, add Sunset,
        and remove it in a later release.

ERR  request-parameter-became-required
     in API GET /v1/orders
     the 'tenant_id' query parameter became required
     -> a newly required parameter breaks every existing caller.
```

### Argo Rollouts: canary with automated analysis

```yaml
apiVersion: argoproj.io/v1alpha1
kind: Rollout
metadata: { name: orders-api }
spec:
  replicas: 20
  strategy:
    canary:
      canaryService: orders-api-canary
      stableService: orders-api-stable
      trafficRouting:
        istio:
          virtualService: { name: orders-api, routes: [primary] }
      analysis:
        templates: [{ templateName: api-health }]
        startingStep: 1                 # start analysing from the 5% step
        args:
          - { name: canary-svc, value: orders-api-canary }
      steps:
        - setWeight: 5
        - pause: { duration: 5m }
        - setWeight: 25
        - pause: { duration: 5m }
        - setWeight: 50
        - pause: { duration: 10m }
        - setWeight: 100
  template:
    spec:
      containers:
        - name: api
          image: registry.example.com/orders-api@sha256:9c4f1a7e5b2d8c3f0a91e6b4d7c2f8a15e3b9d0c6a4f2e8b1d7c3a9f5e2b8d40
          readinessProbe:
            httpGet: { path: /readyz, port: 8080 }
            periodSeconds: 5
          lifecycle:
            preStop: { exec: { command: ["sleep", "10"] } }   # connection draining
          terminationGracePeriodSeconds: 45
```

```yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata: { name: api-health }
spec:
  args: [{ name: canary-svc }]
  metrics:
    - name: error-rate
      interval: 60s
      count: 5
      successCondition: result[0] < 0.01          # under 1% 5xx
      failureLimit: 1                              # one bad interval aborts
      provider:
        prometheus:
          address: http://prometheus:9090
          query: |
            sum(rate(http_server_requests_total{service="{{args.canary-svc}}",status=~"5.."}[2m]))
              /
            clamp_min(sum(rate(http_server_requests_total{service="{{args.canary-svc}}"}[2m])), 1)
    - name: p99-latency
      interval: 60s
      count: 5
      successCondition: result[0] < 0.8            # 800 ms
      provider:
        prometheus:
          address: http://prometheus:9090
          query: |
            histogram_quantile(0.99,
              sum(rate(http_server_request_duration_seconds_bucket{service="{{args.canary-svc}}"}[2m])) by (le))
    - name: minimum-traffic
      interval: 60s
      count: 5
      successCondition: result[0] > 50             # do not judge on tiny samples
      provider:
        prometheus:
          address: http://prometheus:9090
          query: sum(rate(http_server_requests_total{service="{{args.canary-svc}}"}[2m]))
```

> **Note:** The `minimum-traffic` metric matters more than it looks. Without it, a canary at 5% of low overnight traffic can be promoted on a sample of twelve requests, or aborted on two unlucky errors. Always require a sample size before a verdict.

### Expand–migrate–contract in migrations

```sql
-- 001_expand.sql  (deploy BEFORE the new application version; fully reversible)
ALTER TABLE customers ADD COLUMN email_address TEXT;
CREATE INDEX CONCURRENTLY idx_customers_email_address ON customers (email_address);

-- 002_backfill.sql  (batched; never one giant UPDATE that locks the table)
UPDATE customers SET email_address = email
WHERE email_address IS NULL AND id IN (
  SELECT id FROM customers WHERE email_address IS NULL ORDER BY id LIMIT 5000
);

-- 003_contract.sql  (a SEPARATE release, days later, after old code is gone)
ALTER TABLE customers DROP COLUMN email;
```

```python
# Application code during the expand phase: dual-write, read old.
async def save_customer(conn, c):
    await conn.execute(
        "UPDATE customers SET email = $1, email_address = $1 WHERE id = $2", c.email, c.id)

async def load_customer(conn, cid):
    row = await conn.fetchrow("SELECT id, email, email_address FROM customers WHERE id = $1", cid)
    return Customer(id=row["id"], email=row["email"])          # migrate phase flips this to email_address
```

### Deprecating a field the right way

```http
GET /v1/orders/ord_9f2 HTTP/1.1
Host: api.example.com
Accept: application/json
```
```http
HTTP/1.1 200 OK
Content-Type: application/json
Deprecation: @1773532800
Sunset: Sat, 15 Aug 2026 00:00:00 GMT
Link: <https://docs.example.com/changelog/2026-03-orders-customer-email>; rel="deprecation"; type="text/html"

{
  "id": "ord_9f2",
  "status": "confirmed",
  "customer_email": "amara@example.com",
  "customer": { "id": "cus_44a", "email": "amara@example.com" }
}
```

The old field stays, the new nested shape appears alongside it, `Deprecation` and `Sunset` (RFC 8594) announce the timeline, and only after the sunset date and a check of access logs is the old field removed.

### Health endpoints that make rollouts safe

```python
@app.get("/livez")                 # "the process is not wedged" — never checks dependencies
async def livez():
    return {"status": "ok"}

@app.get("/readyz")                # "route traffic to me" — checks what a request actually needs
async def readyz(response: Response):
    checks = {"db": await db_ping(), "cache": await cache_ping(), "migrations": schema_is_current()}
    healthy = all(checks.values())
    response.status_code = 200 if healthy else 503
    return {"status": "ok" if healthy else "degraded", "checks": checks,
            "version": os.environ["APP_VERSION"], "commit": os.environ["GIT_SHA"]}
```

Conflating these is a classic outage: if `/livez` checks the database, a brief database blip makes Kubernetes **kill every pod** simultaneously, turning a degradation into a total outage. Liveness answers "restart me"; readiness answers "send me traffic".

**Optimization note.** Pipeline latency is a first-class engineering concern, because lead time drives batch size and batch size drives risk. Four levers: (1) **cache aggressively and correctly** — dependency caches keyed on lockfile hash, Docker layer caching with a stable layer order, and test-result caching so unchanged modules are not re-run; (2) **parallelise and shard** the test suite across runners, ordering by historical duration so the long pole starts first; (3) **fail fast** by running the cheapest, highest-signal gates first — lint and schema-diff before the 8-minute integration suite; (4) **build the image once** and promote by digest, which typically removes 40–60% of total pipeline time versus rebuilding per environment and eliminates an entire class of "it worked in staging" bugs. Target: under 10 minutes from commit to a deployable artifact, and under 60 seconds from "abort" decision to traffic restored.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Rolling update | Cheap (no extra capacity), simple, Kubernetes default | Mixed-version window; slow rollback (another rolling update); no traffic-level control |
| Blue-green | Instant, whole-fleet rollback; the new version is fully warmed before traffic | Double the infrastructure; database must serve both versions; the flip is all-or-nothing |
| Canary | Smallest blast radius; real production traffic and data; automatable promotion | Slower rollouts; needs traffic routing and good metrics; low-traffic services cannot get significance |
| Feature flags | Decouples deploy from release; kill-switch in seconds; enables ring rollouts | Flag debt and combinatorial state; a flag service becomes a critical dependency; untested off-paths |
| Schema-diff gate | Mechanically prevents the most damaging class of API bug | Needs a well-maintained spec; false positives push teams toward bypassing it |
| Build-once artifacts | Eliminates environment-drift bugs; fast promotion; auditable and signable | Config must be fully externalised; no per-environment compile-time switches |
| Expand–migrate–contract | Keeps rollback genuinely available across schema change | Three deploys instead of one; dual-write code that must be cleaned up later |
| Automated canary analysis | Removes human judgement from the abort decision; faster than a human | Tuning thresholds is empirical; noisy metrics cause false aborts and erode trust |
| GitOps (declarative deploys) | Full audit trail, reviewable changes, trivial revert | Another control loop to understand; drift and sync failures need their own monitoring |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Rebuilding the artifact per environment.** "It worked in staging" becomes unfalsifiable because staging ran different bytes. → ✅ Build once, address by digest, promote the same image; externalise all configuration.
2. ⚠️ **Shipping a breaking API change because the tests passed.** Tests verify *your* expectations, not your consumers'. → ✅ A schema-diff gate on every PR plus consumer contract verification, both blocking.
3. ⚠️ **Coupling migrations to the application deploy.** The new code and the `DROP COLUMN` land together, so rolling back the code leaves it pointing at a schema that no longer exists. → ✅ Migrations deploy separately and are additive only; contraction is its own later release.
4. ⚠️ **Locking DDL on a large table during a deploy.** `CREATE INDEX` without `CONCURRENTLY` or a table rewrite freezes writes and cascades into timeouts everywhere. → ✅ Lint migrations (`squawk`), use `CONCURRENTLY`, batch backfills, and set `lock_timeout` so a migration fails fast rather than blocking the world.
5. ⚠️ **No connection draining.** Pods are killed with in-flight requests, and every deploy produces a burst of `502`s. → ✅ `preStop` sleep longer than the load balancer's deregistration delay, graceful shutdown that stops accepting but finishes in-flight work, and a `terminationGracePeriodSeconds` above your longest request.
6. ⚠️ **Liveness probes that check dependencies.** A brief database blip restarts the entire fleet at once. → ✅ Liveness checks only the process; readiness checks dependencies. Different questions, different endpoints.
7. ⚠️ **Canary judged against yesterday's baseline.** Time-of-day, traffic mix, and other deploys confound the comparison. → ✅ Compare against a concurrent baseline running the old version, and require a minimum sample size before any verdict.
8. ⚠️ **Canary on error rate alone.** The new version returns `200` with wrong data, or is 4× slower, and sails through. → ✅ Analyse latency percentiles, saturation, and at least one business metric (orders per minute, conversion) alongside errors.
9. ⚠️ **Flags that never get removed.** After two years there are 300 flags, an untestable state space, and a stale flag re-enables a removed code path. → ✅ Every flag gets an owner and an expiry; removing it is part of done; alert on flags older than 90 days.
10. ⚠️ **Sticky routing forgotten in canary.** A user's session bounces between versions mid-flow and hits an incompatible response shape. → ✅ Session-affinity or consistent hashing on user id during canary, and design responses so version skew is tolerable.
11. ⚠️ **No post-deploy verification.** The deploy "succeeded" because the pods are running, while every request returns `500`. → ✅ A smoke suite against the deployed environment hitting real endpoints, gated before any traffic weight increases.
12. ⚠️ **Rollback that has never been rehearsed.** Under pressure nobody knows the command, and it turns out it needs a credential nobody has. → ✅ Practise rollback in game days, make it one command, and measure the time — it belongs in your DORA metrics as time-to-restore.
13. ⚠️ **Deploying on Friday afternoon with nobody watching — or, worse, a blanket deploy freeze.** Freezes make batch size grow and the next release riskier. → ✅ Deploy small and often, but require an owner watching the canary window and a documented abort path.
14. ⚠️ **Secrets baked into images or passed as build args.** They end up in layers, in the registry, and in anyone's `docker history`. → ✅ Inject secrets at runtime from a secret manager, scan images in CI, and rotate on a schedule.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The first question in any post-deploy incident is "which version served this request?", so make that answerable without guessing: stamp `service.version` and the git SHA as resource attributes on every span and log line, expose them at `/readyz`, and consider a response header (`X-Api-Version: 2026.3.14+9c4f1a7`) on internal environments. Then every dashboard can be sliced **by version**, which turns "is the canary bad?" from an argument into a query. Keep a deployment marker stream (Grafana annotations, or an `deploys_total` counter with version labels) overlaid on every latency and error chart — the single most common root cause of a graph changing shape is a deploy, and having the marker there saves ten minutes every incident. When a canary aborts, capture the evidence automatically: the failing metric, the time window, and exemplar trace IDs from the canary pods, attached to the rollout object so the engineer does not have to reconstruct it.

**Monitoring.** Instrument the pipeline itself with the four DORA metrics — deployment frequency, lead time for changes (commit to production), change failure rate (deploys requiring rollback or hotfix), and time to restore. Add pipeline health signals: build duration p50/p95, flaky-test rate, and queue wait time, because a slow or flaky pipeline is a leading indicator of larger, riskier batches. During rollouts, the metrics that matter are per-version RED plus saturation, and it is essential that your metrics carry a version label so canary and stable can be compared at all. Alert on rollout state itself: a rollout stuck in `Paused` for hours, a repeated abort of the same version, and migration jobs that fail or run long. Post-deploy, watch the error budget burn rate for the first hour at a shorter window than usual — a change that consumes a week of budget in an hour should page even if absolute error rates look modest.

**Security.** The pipeline is a supply chain and an attack path — it holds production credentials and can push arbitrary code. Harden it: sign artifacts (cosign) and verify signatures at admission so only images your pipeline built can run; generate an SBOM and scan for vulnerable dependencies as a blocking gate on critical severity; pin GitHub Actions to commit SHAs rather than mutable tags, because a compromised third-party action is a full production compromise; and use short-lived OIDC federation for cloud credentials rather than long-lived static keys in CI secrets. Enforce least privilege on the deploy identity (it should not be able to read customer data), require review on changes to pipeline definitions themselves, and keep an immutable audit log of who deployed what and when. On the API side, remember that a deploy is also a *change to your public surface*: schema-diff output belongs in the changelog, and any new endpoint should be checked for authentication and object-level authorization before it goes live, since new endpoints are a common source of OWASP API Top 10 findings.

**Performance & scaling.** Blue-green needs double capacity during the flip window, so either provision for it or use canary, which needs only a marginal overshoot. Watch for **cold-start effects** — a freshly started JIT-compiled or connection-pool-cold instance can look 3–5× slower for the first minute, which naive canary analysis reads as a regression; solve it with a warm-up period excluded from analysis, pre-warmed connection pools, and readiness gates that wait for warm-up rather than merely for the port to open. Consider deployment velocity at scale: with hundreds of services, a shared cluster's control plane and image registry become bottlenecks; stagger rollouts, cache images on nodes, and limit concurrent rollouts. Finally, capacity-plan the *rollback*: scaling the old version back up from zero takes time, so keep the previous version warm at low replica count for the rollback window rather than tearing it down at promotion.

---

## 9. Interview Questions

**Q: What is the difference between blue-green and canary deployment?**
A: Blue-green runs two complete environments and switches all traffic at once, giving an instant rollback by flipping back, at the cost of double infrastructure and a full-blast-radius exposure if the new version is bad. Canary sends a small, growing percentage of real traffic to the new version while comparing its metrics against the stable version, which dramatically reduces blast radius but takes longer and needs traffic routing plus good metrics. Many teams combine them: blue-green at the environment level, canary weights within.

**Q: Why must database migrations be decoupled from application deploys?**
A: Because code rolls back in seconds and schema changes do not. If a deploy both adds new code and drops a column, rolling the code back leaves the previous version running against a schema it cannot use — so your rollback button does not work. Expand–migrate–contract keeps every intermediate state compatible with both the old and new code, which is what makes rollback genuinely available.

**Q: What is a schema-diff gate and why is it the highest-value gate in an API pipeline?**
A: It compares the PR's OpenAPI spec against the spec currently in production and fails the build on backward-incompatible changes — removed fields, newly required parameters, tightened validation, changed types. It is highest-value because tests verify your own expectations while this verifies your *contract with people you cannot see*, and breaking that contract is the most damaging and least reversible category of API bug.

**Q: How do feature flags change your deployment risk?**
A: They separate deploying code from releasing behaviour. The code ships dark, so a deploy carries only the risk of the code path existing, not of the behaviour changing; the behaviour is then enabled progressively and can be turned off in seconds without a build. The costs are flag debt, a combinatorial state space that is hard to test, and a flag service that becomes a critical runtime dependency — so flags need owners, expiry dates, and safe defaults when the flag service is unreachable.

**Q: Which API changes are backward compatible and which are not?**
A: Safe: adding an endpoint, adding an optional request field, adding a response field, relaxing validation. Breaking: removing or renaming a field, making an optional parameter required, tightening validation, changing a type or a status code for an existing condition, changing pagination or default behaviour. Adding an enum value is a grey area — safe only if you documented that clients must tolerate unknown values, which is why that obligation belongs in your API guidelines from day one.

**Q: What is the difference between liveness and readiness probes, and why does it matter during deploys?**
A: Liveness answers "is this process wedged, should it be restarted?" and must check only the process itself. Readiness answers "should traffic be routed here?" and may check dependencies. If liveness checks the database, a brief database problem causes Kubernetes to restart every pod simultaneously, converting a degradation into a total outage — and during a rollout, restarts on top of a rollout make the failure very hard to reason about.

**Q: How do you avoid `502`s during a rolling deploy?**
A: Graceful shutdown plus draining: on `SIGTERM`, stop accepting new connections but finish in-flight requests; add a `preStop` delay longer than the load balancer's deregistration lag so the pod keeps serving until it is genuinely out of rotation; set `terminationGracePeriodSeconds` above your longest legitimate request; and make sure readiness starts failing before the process begins shutting down so traffic is steered away first.

**Q: (Senior) Design a deployment pipeline for a public API with a mobile client that cannot be forced to update.**
A: Assume the old client lives forever, so make backward compatibility a mechanical gate, not a review comment: spec lint, schema-diff blocking breaking changes, and consumer contract verification pre-merge. Build once, sign, promote by digest. Migrations are expand-only and deploy separately; contraction is a distinct later release gated on access-log evidence that no client uses the old shape. Roll out with canary at 5/25/50/100 driven by automated analysis on error rate, latency, saturation, and a business metric, with a minimum sample size and a concurrent baseline. Put behavioural change behind flags so release is decoupled from deploy. For genuinely unavoidable breaks, use versioning plus `Deprecation`/`Sunset` headers with a long notice window and direct outreach to the top consumers by traffic — and keep the old version serving until access logs show the tail has migrated.

**Q: (Senior) A canary shows a 20% p99 latency increase but a flat error rate. Promote, abort, or investigate?**
A: Investigate before deciding, because the most common cause is an artefact of the canary itself: cold caches, cold connection pools, JIT warm-up, and a small pod count that gets a worse share of expensive requests. Check whether the increase decays over the dwell window (warm-up) or is stable (real regression); compare like-for-like by route and by request mix rather than aggregate p99; look at CPU, GC, and pool-wait metrics on the canary pods; and pull exemplar traces for the slow requests to see if a specific span grew. If it is a real, stable 20% at p99 and your latency SLO has headroom, it may still be acceptable — but it should be a conscious decision with a follow-up, not an accident, and the analysis template should be tightened so next time it is caught automatically.

**Q: (Senior) How would you roll back a change that has already written data in a new format?**
A: You generally cannot roll back the data, so the design must never require it: writes go through a dual-write or backward-compatible format during the transition, and the old code must be able to read anything the new code wrote. If that was not done, the options are a forward fix (ship code that reads both formats, which is usually fastest), a compensating migration that rewrites the affected rows identified by a timestamp or version column, or restoring from a point-in-time backup, which is a last resort because it loses everything after the restore point. The durable lesson is that a version or format marker on every written record turns an impossible rollback into a readable-both-ways problem.

**Q: What are the four DORA metrics and what do they tell you?**
A: Deployment frequency and lead time for changes measure throughput; change failure rate and time to restore service measure stability. The research finding that makes them worth tracking is that throughput and stability are *positively* correlated, not a trade-off — teams that deploy more often have lower failure rates, because smaller changes are easier to verify and to reverse. If someone proposes deploying less often to be safer, these metrics are the counter-argument.

**Q: What does GitOps give you for API deployments?**
A: The desired state of every environment lives in version control, and a controller continuously reconciles the cluster to it. That gives a complete audit trail (who changed what and when, with review), trivial rollback (revert the commit), and drift detection when someone changes production by hand. The costs are another control loop to understand and monitor, and a need for discipline about what is in git versus what is generated — plus sync failures become their own alerting concern.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Assume old clients live forever and two versions always run at once. **Build once**, address by digest, promote the same signed artifact. Gate every PR on **spec lint**, a **schema-diff** that fails on breaking changes, and **consumer contract verification** — that is the highest-value gate in an API pipeline. Deploy migrations **separately and additively** using **expand → migrate → contract**, because a contraction is what invalidates your rollback. Roll out progressively: **blue-green** for instant whole-fleet reversal, **canary** (5 → 25 → 50 → 100) with automated analysis on error rate, p99 latency, saturation, and a business metric, judged against a **concurrent baseline** with a **minimum sample size**. Separate **deploy from release** with feature flags that have owners and expiry dates. Get `/livez` (process only) and `/readyz` (dependencies) right, drain connections on `SIGTERM`, and make rollback one rehearsed command measured in your DORA metrics.

| Change | Compatible? | Handling |
|---|---|---|
| Add endpoint / optional field | ✅ Safe | Ship freely |
| Add response field | ✅ Safe | Requires documented "ignore unknown fields" |
| Make optional param required | ❌ Breaking | New version, or default it |
| Remove / rename field | ❌ Breaking | `Deprecation` + `Sunset`, remove after notice |
| Tighten validation | ❌ Breaking | New version or opt-in flag |
| Change status code for a case | ❌ Breaking | New version |
| Add enum value | ⚠️ Depends | Safe only if clients tolerate unknowns |
| `DROP COLUMN` | ❌ Rollback-breaking | Contract phase only, in its own release |

| Signal | Where | Target |
|---|---|---|
| Deployment frequency | Pipeline | Daily or better |
| Lead time (commit → prod) | Pipeline | Under a day; artifact in under 10 min |
| Change failure rate | Rollbacks / hotfixes | Under 15% |
| Time to restore | Rollback rehearsal | Under an hour; abort-to-restored under 60 s |
| Canary abort | Rollout controller | One bad 60 s interval |

Flash cards:
- **Blue-green vs canary in one line?** → Blue-green swaps everything instantly (fast rollback, full blast radius); canary exposes a slice first (small blast radius, slower).
- **Why can't you roll back a `DROP COLUMN`?** → Because the previous artifact can no longer run against the schema — use expand → migrate → contract.
- **What must a canary comparison always have?** → A concurrent baseline and a minimum sample size, or the verdict is noise.
- **Liveness vs readiness?** → Liveness = "restart me" (process only); readiness = "send me traffic" (may check dependencies).
- **What does a feature flag decouple?** → Deploy (code in production, dark) from release (behaviour on), making rollback a config change measured in seconds.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Add `oasdiff breaking` to a CI workflow, then open a PR that removes a response field and confirm the build fails with an actionable message.
- [ ] Perform a full expand–migrate–contract rename against a live service with continuous traffic, and prove at each phase that the previous artifact still serves correctly.
- [ ] Configure an Argo Rollouts or Flagger canary with an analysis template on error rate, p99, and minimum traffic; deploy a deliberately broken version and verify the automatic abort.
- [ ] Add graceful shutdown and a `preStop` drain, then run a rolling deploy under continuous load and show the `502` count going from non-zero to zero.
- [ ] Implement a feature flag with a safe default when the flag service is unreachable, and demonstrate a kill-switch taking effect without a redeploy.

**Mini Project — Zero-downtime pipeline for "Halcyon Orders".**
*Goal:* Take a FastAPI service from commit to a canary-promoted production release with no client-visible errors, including a breaking-looking schema change delivered compatibly.
*Requirements:* A GitHub Actions pipeline with spectral lint, `oasdiff` breaking-change gate against the deployed spec, Pact provider verification, a single signed image build with an SBOM, and ephemeral-environment integration tests; Kubernetes manifests with correct `/livez` and `/readyz`, connection draining, and a `Rollout` doing 5/25/50/100 with a Prometheus analysis template including a minimum-traffic guard; migrations run as a separate job with `squawk` linting and an expand-only policy enforced in CI; a feature-flagged behavioural change enabled progressively; a documented one-command rollback with a measured time-to-restore.
*Extension ideas:* Rename a response field end to end using dual-shape output plus `Deprecation`/`Sunset` headers and remove it only after access logs show zero usage; add a synthetic bad build and measure blast radius under blue-green versus canary; add a business metric (orders per minute) to the canary analysis and show it catching a `200`-but-wrong-data regression that error rate missed; implement GitOps with Argo CD and demonstrate rollback by reverting a commit.

---

## 12. Related Topics & Free Learning Resources

Sibling chapters: **API Versioning & Evolution** (what to do when a break is genuinely unavoidable), **Contract Testing & OpenAPI** (the specs these gates diff), **Monitoring, SLOs & Incident Response** (error budgets that decide whether you may ship), **API Gateways & the BFF Pattern** (where canary traffic weights are applied), **APIs in Microservices Architectures** (deploying many services independently), and **Mocking, Stubs & Sandbox Environments** (keeping the sandbox on the same pipeline as production).

**Free Learning Resources**
- **DORA — DevOps Research and Assessment** — Google Cloud · *Intermediate* · the four key metrics, the capability model behind them, and the evidence that speed and stability go together. <https://dora.dev/>
- **Google SRE Book — Release Engineering & Reliable Product Launches** — Google · *Intermediate* · hermetic builds, artifact promotion, and launch checklists from a team that does this at extreme scale. <https://sre.google/sre-book/release-engineering/>
- **BlueGreenDeployment / CanaryRelease / FeatureToggle** — Martin Fowler and colleagues · *Beginner→Intermediate* · short, precise definitions of each pattern and the conditions where each applies. <https://martinfowler.com/bliki/BlueGreenDeployment.html>
- **Argo Rollouts Documentation** — CNCF · *Advanced* · canary and blue-green with traffic routing and automated metric analysis, with runnable manifests. <https://argo-rollouts.readthedocs.io/>
- **oasdiff — OpenAPI diff and breaking-change detection** — Tufin · *Intermediate* · the tool behind the schema-diff gate, including its full breaking-change rule catalogue. <https://www.oasdiff.com/>
- **RFC 8594 — The Sunset HTTP Header Field** — IETF · *Beginner* · the standard way to announce that a resource or field will stop working, and when. <https://www.rfc-editor.org/rfc/rfc8594.html>
- **Zalando RESTful API Guidelines — Compatibility** — Zalando · *Intermediate* · an explicit, battle-tested list of what counts as a compatible versus breaking API change. <https://opensource.zalando.com/restful-api-guidelines/#compatibility>
- **Kubernetes — Pod Lifecycle & Probes** — Kubernetes · *Intermediate* · the exact semantics of liveness, readiness, startup probes, and termination that determine whether your deploys are clean. <https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/>

---

*REST API Handbook — chapter 41.*
