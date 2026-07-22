# 39 · API Gateways & the BFF Pattern

> **In one line:** An API gateway is the single, policy-enforcing front door that handles the concerns every service would otherwise reimplement — TLS, auth, rate limiting, routing, observability — and a Backend-for-Frontend is a *client-specific* gateway that also shapes and aggregates responses for exactly one consumer.

---

## 1. Overview

Once you have more than one service behind an API, a set of concerns appears that belongs to *none* of them and to *all* of them: terminating TLS, validating a JWT, enforcing a rate limit per API key, stamping a request ID, routing `/v1/orders` to one deployment and `/v1/search` to another, blocking a 40 MB body, adding CORS headers, and emitting one consistent access log. Implement these in every service and you get eight subtly different implementations, eight places to patch when a CVE lands, and a security posture defined by the weakest one. An **API gateway** hoists them into a single, uniform layer at the edge.

The problem the **BFF** solves is different and often confused with it. A gateway is *client-agnostic*: it applies policy but does not know or care whether the caller is an iPhone or a batch job. But real clients have wildly different needs. A mobile home screen needs a user, three recent orders, a loyalty balance, and two banners — five backend calls, over a high-latency mobile network, where each round trip costs 100–300 ms and battery. A web SPA on a fast connection wants richer payloads and different fields. A partner integration wants stable, verbose, versioned resources. Serving all three from one "general purpose" API produces the classic failure: the API grows a swamp of `?include=`, `?fields=`, and `?expand=` parameters, every client is coupled to every other client's requirements, and no change is safe.

The **Backend-for-Frontend** pattern — named at SoundCloud around 2015 and popularised by Phil Calçado and Sam Newman — resolves this by giving each client type its own thin server-side API, owned by the team that owns that client. The mobile BFF exposes `GET /home` returning exactly the composite the mobile home screen renders; the web BFF exposes what the web app needs. Each BFF fans out to downstream services, aggregates, trims, and reshapes. The downstream services stay clean, general, and decoupled from presentation.

Historically the gateway descends from three lineages that converged: hardware load balancers and reverse proxies (nginx, HAProxy), enterprise service buses and API management products (Apigee, Mulesoft, later Kong, Tyk, AWS API Gateway), and the service-mesh sidecar (Envoy, from Lyft in 2016, which now underpins most modern gateways including Istio, Contour, Gloo, and Emissary). Envoy's xDS control-plane model — a dumb, fast data plane configured dynamically by a control plane — is the architecture nearly every current gateway has adopted, and Kubernetes' Gateway API is standardising the configuration surface.

A concrete example worth studying: Netflix. They ran a single monolithic edge API, found that one-size-fits-all responses were killing device teams (a TV, a phone, and a browser have utterly different constraints), and moved to client-specific server-side adapters — effectively BFFs — before generalising further with GraphQL federation. The lesson is not "always build BFFs"; it is that **the shape of your API should be owned by whoever owns the screen**, and that this is a different job from enforcing edge policy.

> **Note for interviews:** this chapter is a design-round staple. If asked to "design an API for a mobile app backed by microservices", the expected answer names the gateway's cross-cutting responsibilities, introduces a BFF for the mobile client, and then immediately discusses failure isolation — timeouts, partial responses, and what happens when one of five aggregated calls fails.

---

## 2. Core Concepts

- **API gateway** — a reverse proxy at the network edge that terminates client connections and applies cross-cutting policy (auth, rate limiting, routing, transformation, observability) before forwarding to upstreams.
- **Backend-for-Frontend (BFF)** — a client-specific API layer owned by the client team, which aggregates and reshapes downstream responses for exactly one consumer type.
- **North-south vs east-west traffic** — north-south is client↔system traffic (the gateway's domain); east-west is service↔service traffic (the service mesh's domain).
- **Data plane / control plane** — the data plane proxies bytes on the hot path (Envoy); the control plane computes and pushes configuration to it (Istio, Kong CP, xDS).
- **Route** — a match rule (host, path, method, header) plus an upstream target, a policy chain, and a timeout.
- **Upstream / cluster** — the pool of backend endpoints a route forwards to, with a load-balancing policy, health checks, and connection limits.
- **Edge authentication** — validating the caller's identity at the gateway (JWT signature and claims, mTLS, API key) and passing a trusted, internal-format assertion downstream.
- **Token exchange / phantom token** — swapping an opaque public token for a short-lived internal JWT at the edge, so upstreams never see the client's credential.
- **Aggregation / composition** — issuing several downstream calls and merging results into one response; the BFF's defining behaviour.
- **Fan-out amplification** — one client request becoming *N* backend requests, multiplying both load and tail-latency exposure.
- **Rate limiting** — token-bucket or sliding-window admission control, usually keyed by API key, user, or IP, with `429` and `RateLimit-*` headers.
- **Circuit breaker / bulkhead** — failing fast on a sick upstream, and isolating each upstream's connection pool so one cannot starve the others.

---

## 3. Theory & Principles

**Why the edge is the right place for cross-cutting policy.** The argument is DRY plus consistency plus blast radius. A rate limiter implemented per service cannot enforce a global per-customer quota, because no single service sees all the traffic. An auth check implemented per service will eventually be forgotten in one service, and that service becomes the breach. TLS termination, header normalisation, request-size limits, and access logging are pure infrastructure with no business logic — putting them in application code guarantees drift.

**Why the edge is the wrong place for business logic.** The counter-force is equally strong: a gateway is a shared, high-blast-radius singleton. Every rule you add there is a rule that can break every API at once, and gateway configuration is typically written in a DSL or a plugin runtime that is harder to test, review, and version than application code. The discipline that keeps this sane is a hard rule: **the gateway may make decisions about the caller, never about the resource.** Authenticating a token is edge work. Deciding whether *this* user may read *that* order is object-level authorization and belongs in the service that owns the order — OWASP API Security's #1 risk (BOLA) exists precisely because teams put this in the wrong place.

**Coarse vs fine authorization.** The clean split:

| Decision | Where | Why |
|---|---|---|
| Is the token valid, unexpired, correctly signed? | Gateway | Uniform, cheap, no domain knowledge |
| Does the token have scope `orders:read`? | Gateway | Coarse, declarative, in the token |
| May user `usr_7f2` read order `ord_9f2`? | Orders service | Requires the data; gateway cannot know |

**The fan-out latency model.** A BFF's response time for parallel calls is `max(t_i)` plus overhead, not `sum(t_i)` — which is exactly why aggregation belongs server-side, where the calls are on a fast internal network, rather than in a mobile client on a 150 ms RTT link. The BFF turns *N* mobile round trips into one. But the tail-latency arithmetic is unforgiving: if each of five backends has p99 = 100 ms and they are independent, the probability that at least one is slow is `1 - 0.99^5 ≈ 4.9%`, so the composite's p99 is materially worse than any single backend's. This is Dean & Barroso's tail-at-scale problem in miniature, and it dictates three design rules for every BFF:

1. **Parallelise** independent calls; never `await` them in sequence.
2. **Budget** the total. Give the whole request, say, 800 ms and allocate sub-budgets (`deadline propagation`) so a slow call is cancelled rather than allowed to consume the budget of the ones after it.
3. **Degrade partially.** Decide, per field, whether it is *essential* (fail the request) or *optional* (return `null` plus a warning). A home screen without a banner is fine; without the user's name it is not.

**Rate limiting arithmetic.** A token bucket with capacity `B` and refill rate `r` tokens/second allows a sustained rate of `r` and a burst of `B`. Time to refill from empty is `B/r`. Distributed enforcement across `k` gateway pods with local buckets each sized `B/k` under-permits bursts on uneven hashing; a shared Redis counter is exact but adds a hop on every request. The usual production compromise is local buckets with periodic global reconciliation, accepting a few percent of overshoot. Always return the standardised headers and a `Retry-After`:

```
RateLimit-Limit: 1000
RateLimit-Remaining: 4
RateLimit-Reset: 37
Retry-After: 37
```

```svg
<svg viewBox="0 0 760 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="760" height="380" fill="#f8fafc"/>
  <text x="380" y="26" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">Gateway policy chain: what belongs at the edge and what does not</text>
  <rect x="20" y="60" width="90" height="180" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="65" y="146" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">client</text>
  <text x="65" y="166" text-anchor="middle" font-size="10" fill="#1e293b">public token</text>
  <rect x="140" y="60" width="440" height="180" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="360" y="84" text-anchor="middle" font-size="13" font-weight="bold" fill="#1e293b">API gateway (client-agnostic policy)</text>
  <rect x="155" y="98" width="96" height="44" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="203" y="118" text-anchor="middle" font-size="10" fill="#1e293b">1 TLS + WAF</text>
  <text x="203" y="133" text-anchor="middle" font-size="10" fill="#1e293b">body size cap</text>
  <rect x="259" y="98" width="96" height="44" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="307" y="118" text-anchor="middle" font-size="10" fill="#1e293b">2 authn: JWT</text>
  <text x="307" y="133" text-anchor="middle" font-size="10" fill="#1e293b">sig + exp + aud</text>
  <rect x="363" y="98" width="96" height="44" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="411" y="118" text-anchor="middle" font-size="10" fill="#1e293b">3 scope check</text>
  <text x="411" y="133" text-anchor="middle" font-size="10" fill="#1e293b">orders:read</text>
  <rect x="467" y="98" width="98" height="44" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="516" y="118" text-anchor="middle" font-size="10" fill="#1e293b">4 rate limit</text>
  <text x="516" y="133" text-anchor="middle" font-size="10" fill="#1e293b">429 + Retry-After</text>
  <rect x="155" y="152" width="150" height="44" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="230" y="172" text-anchor="middle" font-size="10" fill="#1e293b">5 request-id + traceparent</text>
  <text x="230" y="187" text-anchor="middle" font-size="10" fill="#1e293b">access log, RED metrics</text>
  <rect x="313" y="152" width="122" height="44" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="374" y="172" text-anchor="middle" font-size="10" fill="#1e293b">6 route match</text>
  <text x="374" y="187" text-anchor="middle" font-size="10" fill="#1e293b">host/path/header</text>
  <rect x="443" y="152" width="122" height="44" rx="6" fill="#ffffff" stroke="#0ea5e9"/>
  <text x="504" y="172" text-anchor="middle" font-size="10" fill="#1e293b">7 token exchange</text>
  <text x="504" y="187" text-anchor="middle" font-size="10" fill="#1e293b">phantom internal JWT</text>
  <text x="360" y="222" text-anchor="middle" font-size="11" fill="#0ea5e9">decisions about the CALLER only</text>
  <rect x="610" y="60" width="130" height="180" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="675" y="86" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">orders service</text>
  <text x="675" y="112" text-anchor="middle" font-size="10" fill="#1e293b">may usr_7f2 read</text>
  <text x="675" y="128" text-anchor="middle" font-size="10" fill="#1e293b">ord_9f2?  (BOLA)</text>
  <text x="675" y="152" text-anchor="middle" font-size="10" fill="#1e293b">business rules</text>
  <text x="675" y="172" text-anchor="middle" font-size="10" fill="#1e293b">data validation</text>
  <text x="675" y="196" text-anchor="middle" font-size="11" fill="#16a34a">decisions about</text>
  <text x="675" y="212" text-anchor="middle" font-size="11" fill="#16a34a">the RESOURCE</text>
  <line x1="110" y1="150" x2="138" y2="150" stroke="#4f46e5" stroke-width="2"/>
  <polygon points="138,150 130,146 130,154" fill="#4f46e5"/>
  <line x1="580" y1="150" x2="608" y2="150" stroke="#16a34a" stroke-width="2"/>
  <polygon points="608,150 600,146 600,154" fill="#16a34a"/>
  <rect x="20" y="266" width="720" height="94" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="34" y="290" font-size="12" font-weight="bold" fill="#1e293b">Anti-patterns at the edge</text>
  <text x="34" y="312" font-size="11" fill="#1e293b">Object-level authorization in a gateway plugin  (the gateway cannot see who owns the row)</text>
  <text x="34" y="331" font-size="11" fill="#1e293b">Business rules and response rewriting for one client  (that is a BFF&#8217;s job, not the shared edge&#8217;s)</text>
  <text x="34" y="350" font-size="11" fill="#1e293b">Aggregating five upstreams in a gateway plugin with no per-call timeout or partial-failure policy</text>
</svg>
```

---

## 4. Architecture & Workflow

A realistic production topology: CDN → shared gateway → per-client BFFs → domain services → data stores, with a mesh handling east-west traffic. Walk one mobile home-screen request end to end.

1. **DNS and TLS.** `api.example.com` resolves to an anycast CDN edge. The CDN terminates TLS 1.3, absorbs volumetric DDoS, serves cacheable `GET`s from its own cache, and forwards the rest over a warm connection to the origin gateway. Static and public content never reaches your origin at all.
2. **Gateway admission.** The gateway enforces a request-size cap (say 1 MB), applies WAF rules, and rejects unsupported methods. Cheap rejections happen before any auth work — the ordering matters under attack.
3. **Authentication.** The gateway validates the `Authorization: Bearer` JWT: signature against JWKS (cached with a background refresh, never fetched per request), `exp`, `nbf`, `iss`, `aud`. Failure → `401` with `WWW-Authenticate: Bearer error="invalid_token"`. It does **not** decide whether the user may see any particular order.
4. **Coarse authorization + rate limiting.** Scope `home:read` must be present, else `403`. A token bucket keyed on `sub` + plan tier admits or returns `429` with `RateLimit-*` and `Retry-After`.
5. **Identity propagation.** The gateway strips any client-supplied internal headers (critical — never trust `X-User-Id` from the internet), performs token exchange, and injects a short-lived internal assertion plus `X-Request-Id` and `traceparent`.
6. **Route to the BFF.** `Host: api.example.com` + `User-Agent`/path prefix routes to the **mobile BFF** (`/mobile/v1/*`), while `/web/v1/*` goes to the web BFF and `/v1/*` (partner API) goes straight to the domain services.
7. **BFF composition.** `GET /mobile/v1/home` fans out **in parallel** to five upstreams with individual deadlines carved out of an 800 ms total budget: profile (100 ms), orders (250 ms), loyalty (150 ms), recommendations (200 ms, optional), banners (100 ms, optional).
8. **Partial failure handling.** Recommendations time out. Because it is declared optional, the BFF returns the response with `recommendations: []` and a `degraded: ["recommendations"]` marker, emits a metric, and still returns `200`. Had *profile* failed, the BFF would return `503` — the screen is meaningless without it.
9. **Shaping.** The BFF trims each upstream payload to exactly the fields the current mobile release renders, renames nothing gratuitously, and returns one compact JSON document — often a 70–90% payload reduction versus proxying the raw responses.
10. **Caching.** The BFF sets `Cache-Control: private, max-age=30` and a strong `ETag` on the composite; the CDN caches nothing (it is `private`), but the client revalidates with `If-None-Match` and gets `304 Not Modified` most of the time.
11. **Response path.** The gateway adds CORS headers where relevant, records RED metrics per route, writes one structured access log with `request_id`, `trace_id`, upstream latency, and status, and returns to the client.
12. **East-west.** Calls *between* domain services (orders → inventory) do not traverse the gateway; they go service-to-service through the mesh with mTLS, retries, and circuit breaking. Routing internal traffic back out through the edge is a classic and expensive mistake.

```svg
<svg viewBox="0 0 780 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif">
  <rect x="0" y="0" width="780" height="420" fill="#ffffff"/>
  <text x="390" y="24" text-anchor="middle" font-size="16" font-weight="bold" fill="#1e293b">Gateway plus per-client BFFs, with parallel fan-out and partial degradation</text>
  <rect x="16" y="60" width="86" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="59" y="80" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">mobile</text>
  <text x="59" y="96" text-anchor="middle" font-size="10" fill="#1e293b">150ms RTT</text>
  <rect x="16" y="126" width="86" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="59" y="146" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">web SPA</text>
  <rect x="16" y="192" width="86" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="59" y="212" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">partner</text>
  <text x="59" y="228" text-anchor="middle" font-size="10" fill="#1e293b">server-side</text>
  <rect x="126" y="60" width="90" height="178" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="171" y="140" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">CDN</text>
  <text x="171" y="158" text-anchor="middle" font-size="10" fill="#1e293b">TLS, DDoS</text>
  <rect x="240" y="60" width="110" height="178" rx="10" fill="#e0f2fe" stroke="#0ea5e9" stroke-width="2"/>
  <text x="295" y="86" text-anchor="middle" font-size="12" font-weight="bold" fill="#1e293b">gateway</text>
  <text x="295" y="110" text-anchor="middle" font-size="10" fill="#1e293b">authn (JWT)</text>
  <text x="295" y="128" text-anchor="middle" font-size="10" fill="#1e293b">scopes</text>
  <text x="295" y="146" text-anchor="middle" font-size="10" fill="#1e293b">rate limit</text>
  <text x="295" y="164" text-anchor="middle" font-size="10" fill="#1e293b">request-id</text>
  <text x="295" y="182" text-anchor="middle" font-size="10" fill="#1e293b">strip x-user-*</text>
  <text x="295" y="200" text-anchor="middle" font-size="10" fill="#1e293b">token exchange</text>
  <text x="295" y="222" text-anchor="middle" font-size="10" fill="#1e293b">route</text>
  <rect x="380" y="52" width="130" height="58" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="445" y="74" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">mobile BFF</text>
  <text x="445" y="93" text-anchor="middle" font-size="10" fill="#1e293b">GET /mobile/v1/home</text>
  <rect x="380" y="122" width="130" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="445" y="144" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">web BFF</text>
  <text x="445" y="162" text-anchor="middle" font-size="10" fill="#1e293b">richer payloads</text>
  <rect x="380" y="186" width="130" height="52" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="445" y="208" text-anchor="middle" font-size="11" font-weight="bold" fill="#1e293b">no BFF</text>
  <text x="445" y="226" text-anchor="middle" font-size="10" fill="#1e293b">stable public /v1</text>
  <rect x="560" y="46" width="200" height="30" rx="6" fill="#ffffff" stroke="#16a34a" stroke-width="2"/>
  <text x="570" y="66" font-size="10" fill="#1e293b">profile   budget 100ms   REQUIRED</text>
  <rect x="560" y="82" width="200" height="30" rx="6" fill="#ffffff" stroke="#16a34a" stroke-width="2"/>
  <text x="570" y="102" font-size="10" fill="#1e293b">orders    budget 250ms   REQUIRED</text>
  <rect x="560" y="118" width="200" height="30" rx="6" fill="#ffffff" stroke="#16a34a" stroke-width="2"/>
  <text x="570" y="138" font-size="10" fill="#1e293b">loyalty   budget 150ms   REQUIRED</text>
  <rect x="560" y="154" width="200" height="30" rx="6" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="570" y="174" font-size="10" fill="#1e293b">recos     budget 200ms   OPTIONAL</text>
  <rect x="560" y="190" width="200" height="30" rx="6" fill="#ffffff" stroke="#16a34a" stroke-width="2"/>
  <text x="570" y="210" font-size="10" fill="#1e293b">banners   budget 100ms   OPTIONAL</text>
  <line x1="102" y1="83" x2="124" y2="100" stroke="#4f46e5" stroke-width="2"/>
  <line x1="102" y1="149" x2="124" y2="149" stroke="#4f46e5" stroke-width="2"/>
  <line x1="102" y1="215" x2="124" y2="198" stroke="#4f46e5" stroke-width="2"/>
  <line x1="216" y1="149" x2="238" y2="149" stroke="#94a3b8" stroke-width="2"/>
  <line x1="350" y1="120" x2="378" y2="82" stroke="#0ea5e9" stroke-width="2"/>
  <line x1="350" y1="149" x2="378" y2="148" stroke="#0ea5e9" stroke-width="2"/>
  <line x1="350" y1="178" x2="378" y2="212" stroke="#0ea5e9" stroke-width="2"/>
  <line x1="510" y1="72" x2="558" y2="61" stroke="#16a34a" stroke-width="1.5"/>
  <line x1="510" y1="76" x2="558" y2="97" stroke="#16a34a" stroke-width="1.5"/>
  <line x1="510" y1="80" x2="558" y2="133" stroke="#16a34a" stroke-width="1.5"/>
  <line x1="510" y1="84" x2="558" y2="169" stroke="#dc2626" stroke-width="1.5" stroke-dasharray="4"/>
  <line x1="510" y1="88" x2="558" y2="205" stroke="#16a34a" stroke-width="1.5"/>
  <text x="640" y="240" text-anchor="middle" font-size="10" fill="#dc2626">recos times out &#8594; 200 OK with degraded: [&quot;recommendations&quot;]</text>
  <rect x="16" y="262" width="744" height="146" rx="8" fill="#f8fafc" stroke="#94a3b8" stroke-width="2"/>
  <text x="30" y="286" font-size="12" font-weight="bold" fill="#1e293b">Budget arithmetic for the composite response</text>
  <text x="30" y="310" font-size="11" fill="#1e293b">Serial fan-out: 100 + 250 + 150 + 200 + 100 = 800 ms   (never do this)</text>
  <text x="30" y="330" font-size="11" fill="#1e293b">Parallel fan-out: max(100, 250, 150, 200, 100) + overhead &#8776; 270 ms</text>
  <text x="30" y="350" font-size="11" fill="#1e293b">Mobile without a BFF: 5 round trips &#215; 150 ms RTT + server time &#8776; 1.5 s and 5&#215; battery cost</text>
  <text x="30" y="370" font-size="11" fill="#1e293b">Tail exposure: 5 independent calls at p99 = 100 ms &#8594; P(at least one slow) = 1 &#8722; 0.99^5 &#8776; 4.9%</text>
  <text x="30" y="392" font-size="11" fill="#1e293b">Mitigation: per-call deadlines carved from one total budget, optional fields, circuit breakers, cached fallbacks</text>
</svg>
```

---

## 5. Implementation

### Gateway routing and policy (Kubernetes Gateway API + a Kong-style plugin)

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: mobile-bff
spec:
  parentRefs: [{ name: public-gateway, sectionName: https }]
  hostnames: ["api.example.com"]
  rules:
    - matches:
        - path: { type: PathPrefix, value: /mobile/v1 }
      filters:
        - type: RequestHeaderModifier
          requestHeaderModifier:
            remove: ["X-User-Id", "X-Internal-Auth", "X-Tenant-Id"]   # never trust these from the internet
            set:
              - { name: X-Forwarded-Client, value: mobile }
      backendRefs:
        - { name: mobile-bff, port: 8080, weight: 100 }
      timeouts: { request: 1s, backendRequest: 900ms }
    - matches:
        - path: { type: PathPrefix, value: /v1 }        # public partner API, no BFF
      backendRefs:
        - { name: orders-api, port: 8080 }
      timeouts: { request: 5s }
```

```yaml
apiVersion: configuration.konghq.com/v1
kind: KongPlugin
metadata: { name: rate-limit-by-key }
plugin: rate-limiting-advanced
config:
  limit: [1000]
  window_size: [60]
  identifier: consumer          # per API key, not per IP
  sync_rate: 1                  # reconcile local counters to Redis every 1s
  strategy: redis
  hide_client_headers: false    # emit RateLimit-* headers
```

### What the wire looks like

Client → gateway (public token, no internal headers trusted):

```http
GET /mobile/v1/home HTTP/1.1
Host: api.example.com
Authorization: Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjJ...
Accept: application/json
If-None-Match: "w/home-usr_7f2-91c4"
X-User-Id: usr_admin
```

Gateway → BFF (client header stripped, internal assertion injected):

```http
GET /home HTTP/1.1
Host: mobile-bff.svc.cluster.local
X-Internal-Auth: eyJhbGciOiJFZERTQSJ9...
X-Request-Id: 01J8Z2K7QF3MB4X9VN7A0S2C6D
traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01
X-Forwarded-Client: mobile
X-Forwarded-For: 203.0.113.24
```

BFF → client, degraded but successful:

```http
HTTP/1.1 200 OK
Content-Type: application/json
Cache-Control: private, max-age=30
ETag: "w/home-usr_7f2-91c5"
X-Request-Id: 01J8Z2K7QF3MB4X9VN7A0S2C6D
Server-Timing: profile;dur=61, orders;dur=203, loyalty;dur=88, recos;dur=200, total;dur=271
RateLimit-Limit: 1000
RateLimit-Remaining: 987
RateLimit-Reset: 34

{
  "user": { "id": "usr_7f2", "first_name": "Amara", "tier": "gold" },
  "recent_orders": [
    { "id": "ord_9f2", "status": "shipped", "total": "49.99", "eta": "2026-03-16" }
  ],
  "loyalty": { "points": 4820, "next_reward_at": 5000 },
  "recommendations": [],
  "banners": [ { "id": "bnr_7", "text": "Free delivery this weekend" } ],
  "degraded": ["recommendations"]
}
```

And a rate-limited response:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/problem+json
RateLimit-Limit: 1000
RateLimit-Remaining: 0
RateLimit-Reset: 21
Retry-After: 21

{
  "type": "https://errors.example.com/rate-limit-exceeded",
  "title": "Too Many Requests",
  "status": 429,
  "detail": "1000 requests per minute exceeded for key ak_live_8f2. Retry in 21 seconds.",
  "instance": "/mobile/v1/home"
}
```

### The BFF itself — parallel fan-out with per-call deadlines and partial degradation

```python
import asyncio, httpx
from dataclasses import dataclass
from fastapi import FastAPI, Header, Response

app = FastAPI(title="Mobile BFF")
client = httpx.AsyncClient(
    timeout=httpx.Timeout(connect=0.2, read=1.0, write=0.2, pool=0.1),
    limits=httpx.Limits(max_connections=200, max_keepalive_connections=100),  # bulkhead per upstream
)

@dataclass(frozen=True)
class Call:
    name: str
    url: str
    budget_s: float
    required: bool
    fallback: object = None

CALLS = [
    Call("user",            "http://profile/v1/me",              0.10, True),
    Call("recent_orders",   "http://orders/v1/orders?limit=3",   0.25, True),
    Call("loyalty",         "http://loyalty/v1/balance",         0.15, True),
    Call("recommendations", "http://recos/v1/for-you?n=6",       0.20, False, fallback=[]),
    Call("banners",         "http://cms/v1/banners?slot=home",   0.10, False, fallback=[]),
]

async def fetch(call: Call, auth: str, request_id: str):
    headers = {"X-Internal-Auth": auth, "X-Request-Id": request_id,
               "X-Deadline-Ms": str(int(call.budget_s * 1000))}   # deadline propagation
    try:
        async with asyncio.timeout(call.budget_s):
            r = await client.get(call.url, headers=headers)
            r.raise_for_status()
            return call.name, r.json(), None
    except (asyncio.TimeoutError, httpx.HTTPError) as exc:
        if call.required:
            raise UpstreamRequired(call.name) from exc
        return call.name, call.fallback, call.name       # degrade, do not fail

@app.get("/home")
async def home(response: Response,
               x_internal_auth: str = Header(...),
               x_request_id: str = Header(...)):
    results = await asyncio.gather(
        *(fetch(c, x_internal_auth, x_request_id) for c in CALLS),
        return_exceptions=True,
    )
    body, degraded = {}, []
    for item in results:
        if isinstance(item, UpstreamRequired):
            raise HTTPException(503, detail=f"upstream {item.name} unavailable")
        name, value, failed = item
        body[name] = trim(name, value)          # shape to exactly what this app version renders
        if failed:
            degraded.append(failed)
    body["degraded"] = degraded
    response.headers["Cache-Control"] = "private, max-age=30"
    return body
```

Two details that matter more than they look. **`asyncio.gather` with `return_exceptions=True`** means one failing call never cancels the others; without it a single timeout takes down the whole screen. **Deadline propagation** (`X-Deadline-Ms`, or gRPC deadlines, or a `Deadline` header your services honour) lets the *upstream* abandon work it can no longer deliver in time, which is how you stop wasting capacity on doomed requests during an incident.

### Envoy-style outlier detection and circuit breaking (per upstream)

```yaml
clusters:
  - name: recommendations
    connect_timeout: 0.2s
    circuit_breakers:
      thresholds:
        - priority: DEFAULT
          max_connections: 100
          max_pending_requests: 50      # queue depth before shedding
          max_requests: 200
          max_retries: 3                # retry budget, not per-request retries
    outlier_detection:
      consecutive_5xx: 5
      base_ejection_time: 30s
      max_ejection_percent: 50          # never eject the whole pool
      interval: 10s
```

**Optimization note.** A gateway adds a hop, and the hop's cost is dominated by connection handling, not routing. Four things reliably cut BFF and gateway latency: (1) **keep-alive and HTTP/2 to upstreams** with a warm, sized connection pool — cold TCP + TLS to a backend can cost more than the backend's own work; (2) **cache JWKS and token introspection** in memory with background refresh (a per-request introspection call turns a 2 ms auth check into a 30 ms one and creates a hard dependency on the auth service); (3) **respond `304` aggressively** — a strong `ETag` on the composite plus `If-None-Match` turns most mobile home-screen polls into ~200-byte responses; (4) **enable compression at the edge only** (`br` then `gzip`), not on every internal hop, since internal networks are fast and CPU is not free. Measure the gateway's own added latency as a first-class SLI — the healthy number is single-digit milliseconds at p99; if it is not, you have put too much logic there.

---

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| Centralised edge policy | One place for TLS, authn, rate limits, WAF, logging; consistent and auditable | A shared singleton: one bad config change breaks every API at once |
| Uniform observability | Every request gets a request ID, trace context, and access log for free | Gateway logs alone are shallow — they see status and latency, not causes |
| Client decoupling (gateway) | Backends can be split, renamed, or moved without changing client URLs | Routing config becomes a second source of truth that drifts from reality |
| BFF aggregation | Turns *N* mobile round trips into one; huge latency and battery win on slow networks | Fan-out amplification: one client request is now five backend requests |
| BFF ownership | The client team owns its own API shape and ships without cross-team negotiation | *M* clients × *N* domains risks duplicated logic across BFFs |
| Payload shaping | 70–90% smaller responses tailored to the screen | The BFF is coupled to UI needs and must be versioned alongside app releases |
| Partial degradation | A slow optional upstream degrades a section, not the page | Requires explicit per-field required/optional policy and client code that handles nulls |
| Extra hop | Enables everything above | Adds latency (target single-digit ms p99) and a new failure domain that needs its own HA |
| Vendor gateways (managed) | No operations, autoscaling, integrated WAF and auth | Lock-in, per-request pricing at scale, limited extensibility, cold-start behaviour |
| Service mesh for east-west | mTLS, retries, and circuit breaking without app code | Two proxies to operate; overlapping features with the gateway cause confusion about ownership |

---

## 7. Common Mistakes & Best Practices

1. ⚠️ **Object-level authorization in the gateway.** A plugin checks a scope and the service assumes the caller is authorized, so `GET /v1/orders/ord_other` returns someone else's order — OWASP API #1 (BOLA). → ✅ The gateway authenticates and checks *coarse* scopes; the owning service always re-checks ownership against its own data.
2. ⚠️ **Trusting client-supplied internal headers.** `X-User-Id` arrives from the internet and something downstream believes it. → ✅ Strip and re-inject every internal header at the edge; treat any `X-Internal-*` from an external listener as an attack.
3. ⚠️ **Business logic creeping into gateway plugins.** Discount rules in Lua, untested, unversioned, deployed by a config push. → ✅ The gateway does infrastructure only; anything a product manager can change belongs in a service or a BFF.
4. ⚠️ **A "BFF" that is really a shared monolith.** One BFF serving mobile, web, and partners re-creates the coupling it was meant to remove. → ✅ One BFF per client experience, owned by that client's team; if two BFFs need the same logic, extract a shared *library* or a domain service, not a shared BFF.
5. ⚠️ **Serial fan-out.** `await` in a loop turns five 100 ms calls into 500 ms. → ✅ `asyncio.gather` / `Promise.all` / structured concurrency, always, with `return_exceptions=True` so one failure does not cancel the rest.
6. ⚠️ **No per-call deadline.** One slow upstream consumes the entire request budget and the whole screen times out. → ✅ Set a total budget, carve per-call sub-budgets, propagate deadlines downstream, and cancel on expiry.
7. ⚠️ **All-or-nothing responses.** A banner service blip returns `500` for the home screen. → ✅ Classify every composed field as required or optional; return `200` with an explicit `degraded` list and emit a metric per degraded field.
8. ⚠️ **Retrying non-idempotent requests at the edge.** The gateway retries a `POST /payments` on timeout and the customer is charged twice. → ✅ Retry only safe methods by default; for unsafe methods require an `Idempotency-Key` and let the *service* deduplicate.
9. ⚠️ **Unbounded retry storms.** Every layer retries three times, so one backend blip becomes 27× amplification and a metastable failure. → ✅ Retry at exactly one layer, use a retry *budget* (cap retries at ~10% of traffic), add jittered exponential backoff, and pair with circuit breakers.
10. ⚠️ **Routing east-west traffic through the public gateway.** Service-to-service calls hairpin out and back, doubling latency and coupling internal traffic to edge availability. → ✅ Gateway for north-south only; mesh or direct calls for east-west.
11. ⚠️ **Shared connection pools across upstreams.** A slow recommendations service exhausts the pool and starves the orders calls. → ✅ Bulkhead: a separate, sized pool per upstream, plus `max_pending_requests` so you shed rather than queue.
12. ⚠️ **Rate limiting by IP only.** NAT and mobile carriers put thousands of users behind one address; a shared office gets throttled while a distributed abuser sails through. → ✅ Limit by API key or authenticated subject first, IP only as a coarse anti-abuse backstop, and always return `RateLimit-*` plus `Retry-After`.
13. ⚠️ **No gateway HA or rollback story.** A single config push takes down every API and there is no way back. → ✅ Version gateway config in git, canary it like application code, keep declarative rollback one command away, and run at least two independent gateway replicas across zones.
14. ⚠️ **Leaking internal errors through the edge.** A stack trace or an upstream hostname reaches the client. → ✅ Normalise upstream failures to RFC 9457 problem documents at the boundary, keeping the `request_id` so support can still trace it.

---

## 8. Production: Debugging, Monitoring, Security & Scaling

**Debugging.** The gateway's access log is the highest-value artefact in the stack, and it must record, per request: `request_id`, `trace_id`, route name, upstream cluster, upstream host, response status, *and the split between gateway time and upstream time*. That split is what settles the recurring argument "is the gateway slow or is the backend slow" in seconds. Envoy's `response_flags` field is worth learning by heart — `UT` upstream timeout, `UF` upstream connection failure, `URX` retry limit exceeded, `NR` no route configured, `UO` overflow (circuit breaker tripped), `DC` downstream disconnect — because each maps to a different fix. For BFF debugging, emit `Server-Timing` with a segment per upstream so the client and your own dashboards can see which composed call dominated. And in a design interview, saying "I would put the gateway/upstream latency split in the access log" signals real operational experience.

**Monitoring.** Track RED metrics twice — at the edge (what the user experienced) and per upstream cluster (who caused it) — and alert on the divergence. Key gateway signals: `gateway_added_latency_p99` (should be single-digit ms), 5xx rate split by *whose* fault it was, upstream connection pool utilisation and pending-request queue depth, circuit-breaker open events and outlier ejections, active connections, TLS handshake rate and errors, and JWKS refresh failures (a silent killer — the gateway keeps working until keys rotate, then rejects everything). For the BFF specifically, monitor the **degradation rate per composed field** and the **fan-out ratio** (backend requests per client request); a creeping fan-out ratio is how a BFF quietly becomes an N+1 query generator.

**Security.** The gateway is your enforcement point, so make it strict and make it uniform: TLS 1.2+ only with modern ciphers, HSTS, request-size and header-count caps, method allowlists, and a WAF for the obvious injection classes. Validate JWTs fully — signature *and* `iss`, `aud`, `exp`, `nbf`, and algorithm pinning (reject `alg: none` and reject an unexpected algorithm; algorithm-confusion attacks are still live). Cache JWKS but honour rotation. Prefer the **phantom token** pattern: the public client holds an opaque token, the gateway exchanges it for a short-lived internal JWT, so a leaked internal token expires in 60 seconds and the public token can be revoked centrally. Use mTLS between gateway and upstreams so a compromised pod cannot impersonate the edge. Never let the gateway be the only authorization: services must independently verify the internal assertion and enforce object-level access. Scope CORS narrowly by origin and method; a permissive `Access-Control-Allow-Origin: *` alongside credentials is a common and serious misconfiguration. Finally, keep an egress policy — a BFF that can reach arbitrary internal hosts is an SSRF pivot waiting to happen.

**Performance & scaling.** Scale the gateway horizontally behind an L4 load balancer or anycast, and size it for **connections**, not just requests — mobile fleets hold enormous numbers of mostly-idle keep-alive connections. Terminate TLS at the CDN where possible and reuse warm HTTP/2 connections to origin. Push cacheable `GET`s to the CDN and let the gateway see only what needs policy. For BFFs, scale each independently — the mobile BFF's traffic shape (bursty, morning-peak, home-screen heavy) is nothing like the web BFF's — and give each its own autoscaling policy, connection pools, and error budget. Watch out for the **thundering herd** on cache expiry and app-launch storms after a push notification: add jitter to client-side refresh, use `stale-while-revalidate`, and consider request coalescing (single-flight) in the BFF so 10,000 simultaneous identical requests become one upstream call.

---

## 9. Interview Questions

**Q: What does an API gateway do that a plain load balancer does not?**
A: A load balancer distributes L4/L7 traffic across healthy backends. A gateway adds protocol- and policy-aware behaviour: authentication and coarse authorization, per-consumer rate limiting, request/response transformation, route matching on host/path/header/method, retries and circuit breaking, request-ID and trace-context injection, and uniform access logging and metrics. It is the policy enforcement point for north-south traffic.

**Q: What is a BFF and how is it different from a gateway?**
A: A gateway is client-agnostic infrastructure applying uniform policy. A BFF is a client-*specific* API layer, owned by the team that owns that client, which aggregates several downstream calls and reshapes the result into exactly what one screen or one app needs. You usually have one gateway and several BFFs behind it; the gateway does policy, the BFF does composition and shaping.

**Q: When should you *not* build a BFF?**
A: When you have a single client type, when the client is a server-side integration that can happily make several calls on a fast network, or when your team is too small to own another deployable. A BFF is a real service with its own on-call, deploys, and failure modes; if the only benefit is saving one round trip on a fast connection, it is not worth it. Start with a gateway and add a BFF when a specific client's needs start distorting the shared API.

**Q: Which authorization decisions belong at the gateway and which do not?**
A: The gateway validates identity (signature, expiry, issuer, audience) and coarse, declarative permissions carried in the token, such as the scope `orders:read`. It must not decide whether a specific user may access a specific object, because it does not have the data to know who owns that object. Object-level authorization lives in the owning service; skipping this is OWASP API Security's number-one risk, BOLA.

**Q: A BFF composes five calls and one is slow. What should happen?**
A: Classify each composed field as required or optional up front. All five calls run in parallel with individual deadlines carved from a total request budget. If an optional upstream misses its deadline, return `200` with a fallback value (empty list, cached copy) and an explicit `degraded` marker plus a metric. If a required upstream fails, return `503` with a problem document and `Retry-After`. Never let one slow optional call hold the whole response.

**Q: How do you propagate identity from the gateway to internal services safely?**
A: Strip all client-supplied internal headers at the edge, then inject a signed internal assertion — commonly a short-lived JWT minted by the gateway via token exchange (the phantom-token pattern). Services verify that assertion's signature rather than trusting a plain header, and mTLS between gateway and upstreams prevents a compromised pod from forging edge traffic. The public token never reaches internal services.

**Q: How should rate limiting be implemented across many gateway replicas?**
A: Key on the authenticated subject or API key, not IP. For enforcement, either a shared counter in Redis (exact but adds a hop and a dependency) or local token buckets with periodic reconciliation (fast, slightly over-permissive during bursts, which is usually acceptable). Return `429` with `Retry-After` and the `RateLimit-Limit`/`Remaining`/`Reset` headers so well-behaved clients can self-throttle rather than hammer you.

**Q: (Senior) Design the edge for a product with a mobile app, a web SPA, and a public partner API. Walk through the topology and the failure modes.**
A: CDN for TLS, DDoS absorption, and cacheable `GET`s; one shared gateway for authn, coarse scopes, rate limiting, header hygiene, and request/trace ID injection; then three paths — a mobile BFF for aggregated, trimmed screens; a web BFF for richer payloads; and the versioned public `/v1` API routed straight to domain services, because partners want stability, not our screen shapes. East-west traffic bypasses the gateway and uses the mesh with mTLS. Failure modes to name: gateway as a shared singleton (mitigate with canaried config, multi-zone replicas, instant rollback), fan-out amplification in the BFF (per-call deadlines, bulkheaded pools, circuit breakers, partial degradation), retry storms across layers (retry at one layer with a budget and jitter), and BFF-versus-app-version skew (version the BFF alongside app releases and keep old shapes alive for the tail of un-upgraded installs).

**Q: (Senior) The gateway's p99 jumped from 4 ms to 300 ms with no deploy. How do you diagnose it?**
A: First separate gateway time from upstream time using the access log split — if upstream time is flat, the problem is at the edge. Then work the edge candidates: JWKS or token-introspection calls now going over the network (cache expiry or auth-service slowness), TLS handshake rate spiking because clients lost keep-alive, connection-pool or file-descriptor exhaustion, a config push that added a synchronous plugin, DNS resolution latency for upstream clusters, or CPU saturation from compression. Check `response_flags` distribution and connection metrics, and compare per-route so you can tell "everything" from "one route". If upstream time did rise, the gateway is the messenger and the investigation moves downstream.

**Q: (Senior) How do you avoid the "M clients × N services" BFF explosion and duplicated logic?**
A: Keep BFFs genuinely thin — composition, shaping, and client-specific caching only — and push anything reusable into either shared client libraries or a domain service that owns the logic properly. Establish that a BFF may never own persistent business state. If several BFFs converge on the same composite needs, that is evidence a domain service is missing or too fine-grained; fix the decomposition rather than copying code. GraphQL federation or a shared composition layer is a legitimate alternative when the number of client shapes grows faster than the team, but it trades the BFF's simplicity for a new and significant operational surface.

**Q: What are the risks of a managed gateway (AWS API Gateway, Apigee) versus self-hosted Envoy/Kong?**
A: Managed gateways remove operational burden and integrate auth, WAF, and autoscaling, but they bring per-request pricing that gets expensive at high volume, hard limits (payload size, timeout ceilings, header counts), constrained extensibility, and meaningful lock-in through proprietary config. Self-hosted Envoy or Kong gives full control, portability, and predictable cost at scale, at the price of running a critical piece of infrastructure yourself, including its control plane, certificates, and upgrades.

**Q: Where do gateways and service meshes overlap, and how do you divide responsibility?**
A: Both are proxies with retries, timeouts, circuit breaking, mTLS, and telemetry — Envoy often literally sits in both. The clean division is by traffic direction: the gateway owns north-south (untrusted clients, public auth, quotas, public routing, WAF), and the mesh owns east-west (workload identity, mTLS, internal retries, traffic splitting for canaries). Ambiguity here causes double retries and duplicated policy, so write the division down and enforce it in review.

---

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** A **gateway** is the client-agnostic front door: TLS, WAF, body-size caps, JWT validation, coarse scopes, per-key rate limiting, header hygiene (strip client-supplied `X-Internal-*`), request-ID and `traceparent` injection, routing, and uniform access logs. It decides things about the **caller**, never about the **resource** — object-level authorization stays in the owning service (BOLA is OWASP API #1). A **BFF** is a client-specific layer, owned by the client team, that fans out to services in **parallel**, applies **per-call deadlines carved from one total budget**, degrades **optional** fields to fallbacks with a `degraded` marker while failing on **required** ones, and trims payloads to exactly what the screen renders. Bulkhead connection pools per upstream, circuit-break sick ones, retry at exactly one layer with a budget and jitter, and never retry unsafe methods without an `Idempotency-Key`. Gateway handles north-south; the mesh handles east-west; never hairpin internal traffic through the edge.

| Concern | Belongs at | Signal / header |
|---|---|---|
| TLS, DDoS, cacheable GETs | CDN | `Cache-Control`, `ETag` |
| Body size, WAF, method allowlist | Gateway | `413`, `405` |
| Token validity, `iss`/`aud`/`exp` | Gateway | `401` + `WWW-Authenticate` |
| Scope check (`orders:read`) | Gateway | `403` |
| "May usr_7f2 read ord_9f2?" | Owning service | `403` / `404` |
| Rate limiting per key | Gateway | `429`, `Retry-After`, `RateLimit-*` |
| Correlation | Gateway | `X-Request-Id`, `traceparent` |
| Aggregation + shaping | BFF | `Server-Timing`, `degraded[]` |
| Partial failure | BFF | `200` + fallback, or `503` if required |
| Retries, circuit breaking, mTLS (east-west) | Mesh | Envoy `response_flags` |

Envoy `response_flags` worth memorising: `UT` upstream timeout · `UF` upstream connection failure · `UO` circuit breaker overflow · `URX` retry limit exceeded · `NR` no route · `DC` downstream disconnect.

Flash cards:
- **Gateway vs BFF in one line?** → Gateway = client-agnostic policy; BFF = client-specific composition and shaping.
- **What must the gateway never decide?** → Whether *this* caller may access *that* object — that is BOLA territory, and it lives in the owning service.
- **Serial or parallel fan-out in a BFF?** → Parallel, with per-call deadlines carved from one total budget.
- **Optional upstream times out — what status?** → `200` with a fallback value and an explicit `degraded` list; `503` only if a required upstream fails.
- **Where does east-west traffic go?** → Through the mesh, directly service-to-service — never back out through the public gateway.

---

## 11. Hands-On Exercises & Mini Project

- [ ] Put an Envoy or Kong gateway in front of two services; configure routing, a per-key rate limit returning correct `RateLimit-*` headers, and `X-Request-Id` injection, then verify with `curl -i`.
- [ ] Add a header-strip filter and prove with a request containing `X-User-Id: admin` that the header never reaches the upstream.
- [ ] Build a BFF endpoint that composes three upstreams serially, measure p99, then convert it to parallel fan-out with per-call deadlines and measure again.
- [ ] Make one upstream sleep for 5 seconds and implement optional-field degradation so the endpoint still returns `200` with a `degraded` list, plus a metric per degraded field.
- [ ] Configure circuit breaking and outlier detection; drive one upstream to a 100% error rate and observe ejection, then recovery, in the gateway's metrics.

**Mini Project — Edge for "Zenith Retail".**
*Goal:* Build the full north-south path for a retail product with three client types.
*Requirements:* Docker-compose with an Envoy or Kong gateway, a mobile BFF, a web BFF, and three domain services (profile, orders, catalog); JWT validation with JWKS caching at the gateway plus scope checks; per-API-key token-bucket rate limiting with correct `429` semantics; header stripping and injection of an internal short-lived assertion; `X-Request-Id` and W3C `traceparent` propagated everywhere; the mobile BFF exposing `GET /home` with parallel fan-out, per-call deadlines from an 800 ms budget, required/optional field policy, `degraded[]`, `ETag` + `304` support, and `Server-Timing`; object-level authorization enforced in the orders service and a test proving the gateway alone does not stop cross-tenant access.
*Extension ideas:* Add outlier detection and a retry budget, then run a fault-injection experiment showing the difference in blast radius with and without them; add single-flight request coalescing in the BFF and measure the upstream load reduction under an app-launch storm; canary a gateway config change with traffic splitting and demonstrate a one-command rollback; add a second BFF version to handle app-version skew and route on a client-version header.

---

## 12. Related Topics & Free Learning Resources

Sibling chapters: **APIs in Microservices Architectures** (east-west communication, sagas, and circuit breakers), **API Observability: Logs, Metrics & Tracing** (the request ID and trace context the gateway injects), **Rate Limiting & Throttling** (the algorithms behind the edge quota), **Authentication & OAuth 2.0 / OIDC** (the tokens the gateway validates), **Monitoring, SLOs & Incident Response** (edge SLIs and error budgets), and **Deploying APIs: CI/CD, Blue-Green & Canary** (traffic-splitting at the gateway).

**Free Learning Resources**
- **Pattern: Backends For Frontends** — Sam Newman · *Intermediate* · the clearest statement of the pattern, its origin at SoundCloud, and when it turns into an anti-pattern. <https://samnewman.io/patterns/architectural/bff/>
- **Envoy Proxy Documentation** — CNCF · *Advanced* · circuit breakers, outlier detection, retry budgets, and the `response_flags` you will debug with. <https://www.envoyproxy.io/docs/envoy/latest/>
- **Kubernetes Gateway API** — Kubernetes SIG-Network · *Intermediate* · the emerging standard for expressing routes, filters, and timeouts declaratively. <https://gateway-api.sigs.k8s.io/>
- **OWASP API Security Top 10** — OWASP · *Intermediate* · BOLA, broken authentication, and unrestricted resource consumption — exactly the risks the edge does and does not mitigate. <https://owasp.org/API-Security/editions/2023/en/0x11-t10/>
- **Google SRE Book — Handling Overload & Addressing Cascading Failures** — Google · *Advanced* · load shedding, retry budgets, and why naive retries turn a blip into an outage. <https://sre.google/sre-book/handling-overload/>
- **RFC 9110 — HTTP Semantics** — IETF · *Intermediate* · the normative meaning of the status codes, methods, and headers a gateway manipulates. <https://www.rfc-editor.org/rfc/rfc9110.html>
- **RateLimit header fields for HTTP** — IETF HTTP WG draft · *Intermediate* · the standardising work behind `RateLimit-Limit`/`Remaining`/`Reset`. <https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/>
- **NGINX Reverse Proxy & Load Balancing Guides** — F5/NGINX · *Beginner→Intermediate* · practical, well-written configuration for the simplest gateway you can run. <https://docs.nginx.com/nginx/admin-guide/load-balancer/http-load-balancer/>

---

*REST API Handbook — chapter 39.*
