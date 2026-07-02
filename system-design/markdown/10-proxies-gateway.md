# 10 · Proxies, Reverse Proxies & API Gateways

> **In one line:** A forward proxy speaks for the *client*, a reverse proxy speaks for the *server*, and an API gateway is a reverse proxy that also owns the cross-cutting concerns — auth, rate limiting, routing, aggregation — for a fleet of services.

---

## 1. Overview

A **proxy** is an intermediary that sits in the request path and relays traffic on behalf of one side. The direction it faces defines its job. A **forward proxy** sits in front of *clients* and represents them to the wider internet — a corporate egress proxy, a web filter, a VPN gateway. A **reverse proxy** sits in front of *servers* and represents them to clients — the single public front door for a backend fleet.

The problem a reverse proxy solves: you don't want clients talking directly to `120` backend pods with rotating IPs, each terminating its own TLS, each implementing its own compression and caching. You want **one stable entry point** that terminates TLS once, load-balances, caches, compresses, and hides the topology behind it. NGINX, HAProxy, and Envoy are the canonical implementations.

An **API gateway** is the reverse proxy grown up for a microservices world. Beyond proxying, it centralizes the concerns *every* service would otherwise reimplement: authentication and authorization, rate limiting and quotas, request routing and versioning, response aggregation, and protocol translation (REST↔gRPC). Kong, Envoy-based gateways, AWS API Gateway, and Apigee live here. The gateway is where "everything a request needs before it reaches business logic" is enforced once.

## 2. Core Concepts

- **Forward proxy** — faces clients; the *server* doesn't know the real client. Used for egress control, filtering, caching, anonymity (the client's ISP/CDN sees the proxy).
- **Reverse proxy** — faces servers; the *client* doesn't know which backend served it. Used for TLS termination, load balancing, caching, compression, and hiding topology.
- **TLS termination** — decrypt HTTPS once at the proxy so backends handle cheap plaintext HTTP; optionally re-encrypt (TLS re-origination) for zero-trust internal links.
- **Edge caching** — the reverse proxy stores cacheable responses and serves repeats without hitting origin (see **CDN**, **Caching**).
- **API gateway** — a reverse proxy plus **auth, rate limiting, routing, aggregation, protocol translation, and observability** as first-class features.
- **Request aggregation (API composition)** — one client call fans out to several services and the gateway stitches the responses into one payload.
- **Protocol translation** — bridge external REST/JSON/HTTP1.1 to internal gRPC/HTTP2/Protobuf, or expose GraphQL over REST backends.
- **Service mesh sidecar** — a per-pod proxy (Envoy) handling *east-west* service-to-service concerns; the gateway handles *north-south* client-to-fleet traffic.
- **Data plane vs control plane** — the proxies that move bytes (data plane) vs the system that configures them (control plane, e.g. Istio/Consul).

## 3. Architecture

North-south traffic enters through the gateway; east-west traffic between services flows through mesh sidecars. The gateway owns edge policy (auth, quotas, routing); sidecars own inter-service policy (mTLS, retries, circuit breaking).

```svg
<svg viewBox="0 0 760 360" width="100%" height="360" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ah2" markerWidth="9" markerHeight="9" refX="7" refY="4" orient="auto">
      <path d="M0,0 L8,4 L0,8 z" fill="#475569"/>
    </marker>
  </defs>
  <text x="380" y="20" text-anchor="middle" fill="#64748b">North-south gateway vs east-west mesh</text>

  <rect x="30" y="120" width="110" height="46" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="85" y="141" text-anchor="middle" fill="#1e293b">Clients</text>
  <text x="85" y="157" text-anchor="middle" fill="#64748b" font-size="11">web / mobile</text>

  <rect x="185" y="105" width="150" height="76" rx="10" fill="#ecfdf5" stroke="#059669"/>
  <text x="260" y="126" text-anchor="middle" fill="#1e293b">API Gateway</text>
  <text x="260" y="143" text-anchor="middle" fill="#64748b" font-size="11">TLS · authN/Z</text>
  <text x="260" y="158" text-anchor="middle" fill="#64748b" font-size="11">rate limit · route</text>
  <text x="260" y="173" text-anchor="middle" fill="#64748b" font-size="11">aggregate</text>
  <line x1="140" y1="143" x2="183" y2="143" stroke="#475569" stroke-width="1.5" marker-end="url(#ah2)"/>

  <!-- Mesh boundary -->
  <rect x="380" y="45" width="350" height="290" rx="12" fill="none" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="555" y="63" text-anchor="middle" fill="#64748b" font-size="11">Service mesh (east-west, mTLS)</text>

  <!-- Svc A -->
  <rect x="405" y="80" width="130" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="470" y="102" text-anchor="middle" fill="#1e293b" font-size="12">Orders svc</text>
  <rect x="415" y="112" width="50" height="20" rx="5" fill="#fff7ed" stroke="#d97706"/>
  <text x="440" y="126" text-anchor="middle" fill="#1e293b" font-size="10">sidecar</text>
  <line x1="335" y1="140" x2="403" y2="112" stroke="#475569" stroke-width="1.5" marker-end="url(#ah2)"/>

  <!-- Svc B -->
  <rect x="405" y="170" width="130" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="470" y="192" text-anchor="middle" fill="#1e293b" font-size="12">Payments svc</text>
  <rect x="415" y="202" width="50" height="20" rx="5" fill="#fff7ed" stroke="#d97706"/>
  <text x="440" y="216" text-anchor="middle" fill="#1e293b" font-size="10">sidecar</text>
  <line x1="335" y1="150" x2="403" y2="200" stroke="#475569" stroke-width="1.5" marker-end="url(#ah2)"/>

  <!-- Svc C -->
  <rect x="580" y="125" width="130" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="645" y="147" text-anchor="middle" fill="#1e293b" font-size="12">Inventory svc</text>
  <rect x="590" y="157" width="50" height="20" rx="5" fill="#fff7ed" stroke="#d97706"/>
  <text x="615" y="171" text-anchor="middle" fill="#1e293b" font-size="10">sidecar</text>
  <line x1="535" y1="120" x2="578" y2="150" stroke="#475569" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#ah2)"/>
  <line x1="535" y1="200" x2="578" y2="165" stroke="#475569" stroke-width="1.2" stroke-dasharray="4 3" marker-end="url(#ah2)"/>

  <rect x="405" y="270" width="305" height="40" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="557" y="294" text-anchor="middle" fill="#1e293b">Datastores · caches · queues</text>
  <line x1="470" y1="230" x2="470" y2="268" stroke="#475569" stroke-width="1.2" marker-end="url(#ah2)"/>
  <line x1="645" y1="185" x2="600" y2="268" stroke="#475569" stroke-width="1.2" marker-end="url(#ah2)"/>
</svg>
```

## 4. How It Works

A request through an API gateway, step by step:

1. **TLS termination.** The gateway completes the HTTPS handshake, decrypts, and works with plaintext HTTP (optionally re-encrypting to backends).
2. **Authenticate.** Validate the credential — verify a JWT signature/expiry, introspect an OAuth token, or check an API key — and reject unauthenticated requests early (`401`).
3. **Authorize & policy.** Check scopes/roles and per-route policy (`403` on failure); apply WAF rules.
4. **Rate limit / quota.** Consume from the caller's token bucket; return `429` with `Retry-After` if exhausted (see **Rate Limiting**).
5. **Route.** Match host/path/version/header to an upstream service; apply canary or weighted splits.
6. **Transform.** Rewrite headers/paths, translate protocol (REST→gRPC), strip internal headers, inject a trace ID and the authenticated user context.
7. **Proxy / aggregate.** Forward to the upstream — or, for a composite endpoint, fan out to several services in parallel and merge responses.
8. **Response pipeline.** Cache if cacheable, compress (`gzip`/`brotli`), add security headers, and stream back to the client while emitting metrics/traces/logs.

## 5. Key Components / Deep Dive

### What a reverse proxy actually does

- **TLS termination & offload** — one place to manage certs, ciphers, and HTTP/2/3; frees backends from crypto CPU.
- **Load balancing** — distribute across backends with health checks (see **Load Balancing**).
- **Caching** — serve cacheable responses from memory/disk without hitting origin.
- **Compression** — `gzip`/`brotli` responses at the edge to cut bandwidth.
- **Buffering & connection management** — absorb slow clients, multiplex/keep-alive to backends, protect origins from slowloris-style attacks.
- **Topology hiding & security** — clients never learn backend IPs; a natural WAF/DDoS chokepoint.

### API gateway responsibilities

- **AuthN/AuthZ** — verify identity and permissions once, at the edge, so services trust an injected user context.
- **Rate limiting & quotas** — protect backends and enforce plan tiers.
- **Routing & versioning** — path/host/header routing, `/v1`↔`/v2`, canary and blue-green splits.
- **Aggregation (API composition)** — collapse chatty multi-service calls into one round trip; ideal for mobile clients on high-latency links.
- **Protocol translation** — REST/JSON externally, gRPC/Protobuf internally; or GraphQL over REST.
- **Observability** — centralized structured logs, metrics, and distributed-trace propagation.

### Gateway vs service-mesh sidecar

| Dimension | API Gateway | Service Mesh Sidecar |
|---|---|---|
| Traffic axis | **North-south** (client ↔ fleet) | **East-west** (service ↔ service) |
| Deployment | Centralized edge tier | One proxy per pod (Envoy) |
| Primary concerns | AuthN/Z, quotas, aggregation, public API shape | mTLS, retries, circuit breaking, load balancing |
| Who it trusts | Untrusted external callers | Peer services inside the trust boundary |
| Config source | Gateway config / API product | Mesh control plane (Istio/Consul/Linkerd) |

They are complementary, not competing: the gateway is the **front door** enforcing edge policy; the mesh is the **internal nervous system** securing and observing service-to-service calls. Many stacks run an Envoy-based gateway *and* Envoy sidecars, sharing a control plane.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Forward proxy** | Egress control, client-side caching/filtering, anonymity | Client must be configured to use it; not for serving your app |
| **Reverse proxy** | One entry point, TLS/cache/compress/LB, hides topology | Extra hop; a bottleneck/SPOF if not made HA |
| **API gateway** | Centralized auth/rate-limit/routing/aggregation; thin services | Can become a fat SPOF and deploy bottleneck; latency + complexity |
| **Gateway does aggregation** | Fewer client round trips; simpler clients | Business logic leaks into the edge; harder to test/own |
| **Service mesh (sidecars)** | Uniform mTLS/retries/observability, no app code | Per-pod resource overhead; operational + control-plane complexity |
| **No gateway (direct)** | Lowest latency, no central chokepoint | Every service reimplements auth/rate-limit/TLS |

The central tension: a gateway *removes* duplication but *adds* a shared component that every request depends on and every team must coordinate around. Keep it thin — cross-cutting concerns only. Push business logic and heavy aggregation into a dedicated **backend-for-frontend (BFF)** service rather than bloating the gateway itself.

## 7. When to Use / When to Avoid

**Use a reverse proxy / gateway when:**
- You have multiple backend services behind one public API and want a single TLS/entry point.
- You need centralized auth, rate limiting, or per-plan quotas across many services.
- Clients (especially mobile) suffer from chatty multi-service calls that aggregation would collapse.
- You must translate protocols (REST↔gRPC) or bridge API versions.

**Avoid / reconsider when:**
- A single service with its own TLS and auth — a gateway is pure overhead.
- Ultra-latency-sensitive internal calls where the extra hop matters — use a mesh/client-side LB.
- You'd be tempted to put business logic in the gateway — that belongs in a BFF or the services.
- Your team can't operate the gateway in HA — an unmanaged gateway is a fragile SPOF.

## 8. Scaling & Production Best Practices

- **Run the gateway stateless and horizontally scaled** behind a load balancer; keep quota/rate state in a shared store (Redis) so any node enforces consistently.
- **Keep it thin:** edge cross-cutting concerns only. Heavy composition → a BFF service you can own, test, and deploy independently.
- **Terminate TLS once**, pool keep-alive connections to backends, enable HTTP/2 (and HTTP/3 at the edge) to cut round trips.
- **Cache aggressively** for cacheable responses with correct `Cache-Control`/`ETag`; measure hit ratio.
- **Set timeouts, retries (with budgets), and circuit breakers** per upstream so one slow service can't stall the gateway's worker pool.
- **Fail fast on auth** — validate JWTs locally with cached JWKS rather than a network call per request.
- **Version the API contract** and route by version; never break `/v1` while shipping `/v2`.
- **Propagate a trace/correlation ID** injected at the edge through every downstream hop for end-to-end tracing.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Gateway becomes SPOF | Total API outage | Run N stateless replicas behind an HA LB / Anycast |
| Auth service down | Every request fails auth → `401`/`503` | Local JWT validation + cached JWKS; short-circuit / fail-open policy where safe |
| One slow upstream stalls workers | Thread/connection pool exhaustion, cascading | Per-upstream timeouts, bulkheads, circuit breakers |
| Rate-limit store (Redis) down | Limits unenforced or all requests blocked | Local fallback counters; fail-open on limiter errors |
| Gateway = deploy bottleneck | Every team blocked on one config repo | Declarative per-route config, self-service, staged rollout |
| Cert expiry at edge | Global TLS handshake failures | Automated rotation + expiry alerts |
| Fat gateway logic bug | Blast radius = entire API | Keep gateway thin; move logic to BFF/services |

## 10. Monitoring & Metrics

- **Latency added by the gateway** — p50/p95/p99 of gateway processing time isolated from upstream time.
- **Status split** — `2xx/4xx/5xx`, with `401/403` (auth), `429` (rate limit), and `503` (upstream) tracked separately.
- **Per-upstream health** — request rate, error rate, latency, circuit-breaker state (open/half-open/closed).
- **Auth metrics** — token validation failures, JWKS refresh errors, auth latency.
- **Rate-limit metrics** — `429` rate per client/plan, limiter store latency/errors.
- **Cache hit ratio** at the proxy and bytes saved.
- **Connection pool utilization** to upstreams and worker/thread saturation.
- **Alerts:** gateway p99 spike, upstream circuit open, `5xx` `>1%`, JWKS/cert refresh failure, single gateway replica remaining.

## 11. Common Mistakes

1. ⚠️ **Confusing forward and reverse proxy** — forward faces clients (egress), reverse faces servers (your app front door).
2. ⚠️ **Stuffing business logic into the gateway** — turns the edge into an untestable, high-blast-radius monolith; use a BFF.
3. ⚠️ **Per-request network call to an auth service** — validate JWTs locally with cached JWKS instead.
4. ⚠️ **No per-upstream timeouts/circuit breakers** — one slow service exhausts the gateway's worker pool and takes everything down.
5. ⚠️ **Running a single gateway instance** — a self-inflicted SPOF; scale it stateless and HA.
6. ⚠️ **Storing rate-limit/session state in-process** — breaks under horizontal scale; use shared Redis.
7. ⚠️ **Treating the gateway and the mesh as alternatives** — they solve north-south vs east-west; you often need both.
8. ⚠️ **Breaking API versions at the edge** — never mutate `/v1` semantics while shipping `/v2`.

## 12. Interview Questions

**Q: What's the difference between a forward proxy and a reverse proxy?**
A: A forward proxy sits in front of *clients* and represents them to the internet — the server sees the proxy, not the real client (egress filtering, corporate caching, anonymity). A reverse proxy sits in front of *servers* and represents them to clients — the client sees one entry point, not the backend fleet (TLS termination, load balancing, caching, topology hiding). Same mechanism, opposite direction of facing.

**Q: What does a reverse proxy actually do for you?**
A: TLS termination (one cert/crypto point), load balancing across backends, caching cacheable responses, compression (`gzip`/`brotli`), connection buffering/keep-alive to protect origins, and hiding backend topology behind a stable public address — plus being a natural WAF/DDoS chokepoint.

**Q: What extra responsibilities does an API gateway take on beyond a plain reverse proxy?**
A: Authentication and authorization, rate limiting and quotas, request routing and API versioning, response aggregation (API composition), protocol translation (REST↔gRPC), and centralized observability. It's the place cross-cutting concerns are enforced once so individual services stay thin.

**Q: What is request aggregation and when is it worth it?**
A: The gateway (or a BFF) takes one client request, fans out to several backend services in parallel, and merges the responses into one payload. It's worth it for high-latency clients — mobile especially — where collapsing five round trips into one dramatically cuts perceived latency. The cost is coupling: aggregation logic drifts toward business logic, so prefer a dedicated BFF over fattening the gateway.

**Q: How does an API gateway differ from a service mesh sidecar?**
A: The gateway handles north-south traffic (external clients → fleet) and owns edge policy: auth, quotas, aggregation, public API shape. A mesh sidecar handles east-west traffic (service → service) and owns inter-service concerns: mTLS, retries, circuit breaking, load balancing — transparently, without app code. They're complementary; large systems run both, often sharing an Envoy control plane.

**Q: Why terminate TLS at the proxy, and what do you lose?**
A: One place to manage certs, ciphers, and HTTP/2/3; backends skip crypto CPU and speak cheap HTTP. You lose end-to-end encryption on the internal hop — in a zero-trust network you re-encrypt (TLS re-origination) or run mTLS via the mesh so the plaintext segment never leaves a trusted boundary.

**Q: (Senior) Your API gateway is becoming a bottleneck — both a latency tax and an organizational chokepoint. How do you address both?**
A: Latency: keep it thin (edge concerns only), validate JWTs locally with cached JWKS, pool keep-alive connections, enable HTTP/2, cache cacheable responses, and set tight per-upstream timeouts so slow backends don't back up workers. Organizational: make routing/policy declarative and self-service per team with staged rollout and CI validation, and push composition/business logic into per-team BFFs so teams deploy independently instead of queueing on one gateway config.

**Q: (Senior) The auth service the gateway depends on goes down. How do you keep the API alive?**
A: Don't call the auth service per request — validate JWT signatures locally against a cached JWKS (refreshed periodically), so a transient auth-service outage doesn't block traffic. For token introspection paths, cache introspection results with a short TTL. Decide a fail-open vs fail-closed policy per route: read-only low-risk endpoints may fail-open briefly, while payment/write paths fail-closed. Add circuit breakers so the gateway stops hammering a dead auth service and degrades predictably.

**Q: (Senior) How would you do protocol translation between an external REST/HTTP1.1 API and internal gRPC services, and what breaks?**
A: The gateway maps REST paths/verbs to gRPC methods and JSON↔Protobuf (e.g. via gRPC-JSON transcoding in Envoy). What breaks: streaming semantics (server/bidi streams don't map cleanly to request/response REST), error-code mapping (gRPC status ↔ HTTP status), deadline/timeout propagation, and large-message/backpressure handling. You keep the Protobuf schema as the contract and generate the REST facade, watching for field-mask and default-value mismatches between JSON and Protobuf.

**Q: Where do you enforce rate limiting — gateway, service, or both?**
A: Primarily at the gateway/edge so abusive traffic is rejected before consuming backend resources, using a shared store (Redis) so all gateway replicas enforce one consistent limit. Services can add local defensive limits for internal fairness. Return `429` with `Retry-After`. See **Rate Limiting**.

**Q: Is a reverse proxy a single point of failure, and how do you avoid it?**
A: Yes if run as one instance. Make it stateless, run multiple replicas behind an HA load balancer or Anycast VIP, keep shared state (rate limits, sessions) in Redis, and health-check replicas. Then any single proxy node can die without an outage.

## 13. Alternatives & Related

- **Load Balancing** — the LB is one function a reverse proxy performs; often the same box (NGINX/Envoy/HAProxy); see topic 09.
- **CDN** — a globally distributed reverse-proxy cache at the edge; see topic 11.
- **Rate Limiting** — the quota enforcement the gateway centralizes.
- **Caching** — the edge caching a reverse proxy provides.
- **Backend-for-Frontend (BFF)** — where heavy aggregation/composition belongs instead of the gateway.
- **Service mesh (Istio/Linkerd/Consul + Envoy)** — the east-west counterpart to the north-south gateway.

## 14. Cheat Sheet

> [!TIP]
> **Proxies & Gateways in 60 seconds**
> - **Forward proxy** faces clients (egress, filter, anonymity). **Reverse proxy** faces servers (TLS, LB, cache, compress, hide topology).
> - **API gateway** = reverse proxy + **auth, rate limiting, routing/versioning, aggregation, protocol translation, observability**.
> - **Gateway = north-south** (client↔fleet); **mesh sidecar = east-west** (service↔service, mTLS/retries). Use both.
> - **Keep the gateway thin** — cross-cutting concerns only; push business logic/composition to a **BFF**.
> - Validate **JWTs locally** (cached JWKS), keep rate-limit state in **Redis**, set **per-upstream timeouts + circuit breakers**.
> - Run it **stateless + HA** — never a single instance. Watch gateway-added latency, `401/403/429/503`, and upstream circuit state.

**References:** Envoy Proxy documentation (architecture overview, HTTP filters, gRPC-JSON transcoding), NGINX reverse proxy docs, Kong / AWS API Gateway docs, "Building Microservices" (Newman) — API gateway & BFF chapters

---
*System Design Handbook — topic 10.*
