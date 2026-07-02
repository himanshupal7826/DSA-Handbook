# 29 · Microservices vs Monolith

> **In one line:** Microservices buy independent deploy/scale per business capability by paying a permanent tax in distributed-systems complexity — take the deal only when the org and the domain are ready.

---

## 1. Overview

A **monolith** is a single deployable unit: one codebase, one process, one database. All modules call each other in-process (nanoseconds, transactional, refactor-with-a-compiler). It is the correct default for almost every new system — it is simple to build, test, deploy, and reason about.

**Microservices** decompose that single unit into many independently deployable services, each owning a business capability and its own data. You adopt them not for elegance but to solve *organizational* and *scaling* problems: dozens of teams stepping on one deploy pipeline, one hot module that needs 50× the hardware of the rest, or a codebase so entangled no one dares change it.

The critical insight: **microservices are primarily a solution to a people-and-org problem, secondarily a scaling problem, and almost never a "clean code" problem.** Amazon and Netflix moved to services because hundreds of teams could not coordinate on a shared release train — not because HTTP is prettier than a function call. A five-engineer startup adopting microservices on day one has bought all the cost and none of the benefit: the dreaded **distributed monolith**.

Real-world example: Amazon's shift from a monolithic Obidos web app (early 2000s) to service-oriented architecture let each two-pizza team own, deploy, and scale its service on its own cadence — enabling thousands of independent daily deploys. The trade was that a page render now fans out to 100+ internal service calls, demanding heavy investment in tracing, timeouts, and graceful degradation.

## 2. Core Concepts

- **Monolith** — one deployable, one shared database, in-process calls. Strong consistency and refactoring for free; coupled deploys and scaling as the cost.
- **Microservice** — an independently deployable unit scoped to one business capability, owning its own data and exposing a network API. Autonomy is the whole point.
- **Bounded context** — the DDD boundary within which a domain model and its ubiquitous language are consistent; the *single best predictor* of a good service boundary.
- **Service granularity** — how finely you slice. Too coarse → a mini-monolith; too fine → chatty nano-services with more network hops than logic.
- **Data ownership (DB-per-service)** — each service is the sole writer of its data; others reach it only via its API. No shared tables. This is the non-negotiable rule that makes services independent.
- **Sync vs async communication** — request/response (REST, gRPC) for queries needing an immediate answer; events/messages (Kafka, SQS) for decoupling and resilience.
- **Distributed complexity tax** — the permanent overhead: partial failure, network latency, eventual consistency, distributed tracing, no cross-service transactions, harder testing.
- **Service discovery** — how a service finds a healthy instance of another (client-side via a registry like Consul/Eureka, or server-side via DNS/load balancer).
- **Service mesh** — a sidecar-proxy (Envoy) layer that moves retries, mTLS, timeouts, and traffic-shifting out of app code into infrastructure.
- **Strangler fig** — the incremental migration pattern: route slices of traffic to new services carved off the monolith until the old system withers.

## 3. Architecture

A monolith is one box. A microservice architecture is a *system* of boxes: clients hit an **API gateway** (auth, routing, rate limiting, TLS termination), which fans requests to services discovered via a **registry**. Services own their databases and communicate synchronously (gRPC/REST) or asynchronously via an **event bus**. Cross-cutting network concerns (mTLS, retries, tracing) are handled by **sidecar proxies** forming a service mesh.

```svg
<svg viewBox="0 0 760 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="a29" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
    <marker id="a29g" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#059669"/>
    </marker>
  </defs>

  <rect x="20" y="24" width="110" height="44" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="75" y="51" text-anchor="middle" fill="#1e293b">Clients</text>

  <rect x="175" y="16" width="130" height="60" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="240" y="40" text-anchor="middle" fill="#1e293b">API Gateway</text>
  <text x="240" y="58" text-anchor="middle" fill="#64748b" font-size="11">auth · route · rate-limit</text>

  <line x1="130" y1="46" x2="173" y2="46" stroke="#475569" stroke-width="1.5" marker-end="url(#a29)"/>

  <rect x="350" y="8" width="240" height="130" rx="10" fill="none" stroke="#94a3b8" stroke-dasharray="4 3"/>
  <text x="470" y="24" text-anchor="middle" fill="#64748b" font-size="11">service mesh (sidecars)</text>

  <rect x="365" y="34" width="90" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="410" y="59" text-anchor="middle" fill="#1e293b">Orders</text>
  <rect x="485" y="34" width="90" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="530" y="59" text-anchor="middle" fill="#1e293b">Payments</text>
  <rect x="365" y="86" width="90" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="410" y="111" text-anchor="middle" fill="#1e293b">Inventory</text>
  <rect x="485" y="86" width="90" height="42" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="530" y="111" text-anchor="middle" fill="#1e293b">Shipping</text>

  <line x1="305" y1="46" x2="363" y2="55" stroke="#475569" stroke-width="1.5" marker-end="url(#a29)"/>

  <!-- own DBs -->
  <rect x="365" y="200" width="90" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="410" y="222" text-anchor="middle" fill="#1e293b" font-size="11">Orders DB</text>
  <rect x="485" y="200" width="90" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="530" y="222" text-anchor="middle" fill="#1e293b" font-size="11">Payments DB</text>
  <line x1="410" y1="76" x2="410" y2="198" stroke="#059669" stroke-width="1.3" marker-end="url(#a29g)"/>
  <line x1="530" y1="76" x2="530" y2="198" stroke="#059669" stroke-width="1.3" marker-end="url(#a29g)"/>
  <text x="470" y="252" text-anchor="middle" fill="#64748b" font-size="11">DB-per-service: sole writer</text>

  <!-- registry -->
  <rect x="620" y="34" width="120" height="42" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="680" y="52" text-anchor="middle" fill="#1e293b" font-size="12">Service</text>
  <text x="680" y="68" text-anchor="middle" fill="#1e293b" font-size="12">Registry</text>

  <!-- event bus -->
  <rect x="175" y="300" width="415" height="44" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="382" y="327" text-anchor="middle" fill="#1e293b">Event Bus (Kafka) — async, decoupled</text>
  <line x1="410" y1="128" x2="300" y2="298" stroke="#d97706" stroke-width="1.3" stroke-dasharray="5 3" marker-end="url(#a29)"/>
  <line x1="530" y1="128" x2="470" y2="298" stroke="#d97706" stroke-width="1.3" stroke-dasharray="5 3" marker-end="url(#a29)"/>
</svg>
```

## 4. How It Works

Trace a "place order" request through a mixed sync/async service topology:

1. **Client → Gateway.** The client sends `POST /orders`. The gateway terminates TLS, validates the access token, applies rate limits, and routes to the Orders service.
2. **Discovery.** The gateway (or the caller's sidecar) resolves a healthy Orders instance via the service registry / mesh, not a hardcoded host.
3. **Synchronous call — reserve inventory.** Orders makes a **gRPC** call to Inventory with a strict timeout (e.g. 200 ms) and a retry budget. Inventory checks and reserves stock in *its own* DB, returns success.
4. **Synchronous call — charge payment.** Orders calls Payments (idempotency key attached). Payments writes to *its own* DB and returns an authorization.
5. **Commit local state.** Orders persists the order in the Orders DB — the only DB it may write.
6. **Emit an event.** Orders publishes `OrderPlaced` to the event bus and returns `201` to the client. It does **not** synchronously wait on shipping or email.
7. **Async consumers react.** Shipping and Notifications consume `OrderPlaced` independently, at their own pace, surviving brief downtime by replaying from the log.
8. **Compensation on failure.** If payment later fails, a **saga** emits `PaymentFailed`; Inventory consumes it and releases the reservation. There is no global rollback — only compensating actions.

The takeaway: what was one ACID transaction in the monolith is now a choreography of local transactions plus compensations, connected by timeouts, retries, and events.

## 5. Key Components / Deep Dive

### Bounded Contexts & DDD — where to draw the line

Service boundaries should follow **bounded contexts**, not database tables or technical layers. A "Customer" means different things in Billing (a payment account), Support (a ticket subject), and Shipping (an address) — three contexts, potentially three services, each with its own model. Boundaries drawn along **business capabilities** cut *across* the natural axis of change, so a feature usually lands in one service. Boundaries drawn along technical layers (a "database service", a "validation service") mean every feature touches every service — the distributed monolith.

### Service Granularity

Right-size by the *change and scale axes*, not by lines of code. A service is too big when two teams contend for its deploys or one part needs radically different scaling. It is too small when a single user action fans out across many services in a synchronous chain — each hop adds latency and a failure point (10 hops at 99.9% each ≈ 99% success). Prefer coarser services early; split only under demonstrated pressure. "Nano-services" are an anti-pattern.

### Inter-Service Communication: Sync vs Async

**Synchronous (REST/gRPC)** is simple and gives an immediate answer, but couples caller availability to callee availability and stacks latency. **Asynchronous (events/messages)** decouples services in time — the producer doesn't care if the consumer is down — enabling resilience and independent scaling, at the cost of eventual consistency and harder debugging. Rule of thumb: **sync for queries that need an answer now; async for state changes others merely need to know about.** Overuse of long synchronous chains is the #1 cause of cascading failures.

### Data Ownership (DB-per-service)

Each service exclusively owns and writes its data; peers access it only through its API or its emitted events — **never** by reaching into its tables. Shared databases silently recouple services (a schema change breaks three teams) and reintroduce the coordination the split was meant to remove. The price: no cross-service JOINs (compose in the app, or maintain read-optimized projections) and no cross-service ACID transactions (use **sagas**).

### The Distributed Complexity Tax

Things that were free in the monolith now cost real engineering:
- **Distributed tracing** — a single request spans many services; without a propagated trace ID (W3C traceparent) and a tool like Jaeger/Zipkin, failures are undebuggable.
- **Distributed transactions** — replaced by sagas with compensating actions and idempotent handlers. 2PC across services is fragile and slow; avoid it.
- **Testing** — unit tests are fine, but integration now requires contract tests (Pact) and end-to-end environments; you test the *seams*, not just the units.
- **Partial failure** — every network call can time out, so timeouts, retries with jitter, circuit breakers, and bulkheads are mandatory, not optional.

### Service Discovery & Service Mesh

**Discovery** answers "where is a healthy Payments instance?" — via a **client-side** registry (Consul/Eureka: client picks an instance) or **server-side** LB/DNS (client hits a stable VIP). A **service mesh** (Istio/Linkerd with Envoy sidecars) pushes retries, mTLS, timeouts, circuit breaking, and traffic-splitting (canaries) *out of every app* and into a uniform infra layer — at the cost of extra latency per hop and real operational complexity. Adopt a mesh when you have enough services that reimplementing these concerns per-language becomes the bottleneck.

## 6. Trade-offs

| Option | Pros | Cons |
|---|---|---|
| **Monolith** | Simple deploy/test/debug; in-process calls (ns); ACID transactions & refactoring for free; one place to look | Coupled deploys (one release train); can't scale modules independently; large codebase intimidates; single tech stack |
| **Microservices** | Independent deploy & scale per capability; team autonomy; fault isolation; polyglot | Distributed complexity tax; eventual consistency; network latency/failure; heavy ops & observability investment; hard testing |
| **Modular monolith** | Clear internal boundaries + monolith simplicity; easy later extraction; in-process speed | Still one deploy unit; discipline required or modules leak; can't independently scale |
| **Service mesh** | Uniform mTLS/retries/tracing off app code; canary & traffic control | Sidecar latency + resource cost; steep operational learning curve; another thing to run |

The honest default is **start with a well-structured modular monolith** and extract services only where a specific, measured pain (deploy contention, independent scaling, team boundaries) justifies the tax. "Monolith-first" is the mainstream senior position (Fowler). Splitting a domain you don't yet understand bakes your worst boundary guesses into expensive network calls.

## 7. When to Use / When to Avoid

**Use microservices when:**
- Many teams (dozens+) contend on a single deploy pipeline and need autonomy.
- Distinct components have wildly different scaling or availability profiles.
- The domain has clear, stable bounded contexts you actually understand.
- You already have the ops maturity: CI/CD, containers/orchestration, centralized logging, tracing, on-call.

**Avoid (prefer a monolith) when:**
- Early-stage / small team — the domain and boundaries are still shifting.
- You lack observability and deployment automation (services will be undebuggable).
- The domain is small or highly interconnected (everything is one transaction).
- You're chasing "clean architecture" — get that from a modular monolith, not the network.

## 8. Scaling & Production Best Practices

- **Extract, don't greenfield.** Carve services off a working monolith via the strangler fig; you migrate with the domain knowledge already encoded.
- **One DB per service, always.** The moment two services share a table, you have a distributed monolith with worse latency than the original.
- **Set timeouts and retry budgets on every call.** A missing timeout turns one slow dependency into a fleet-wide thread-pool exhaustion. Add circuit breakers and bulkheads.
- **Make write operations idempotent** (idempotency keys) so retries and at-least-once messaging are safe.
- **Prefer async events for cross-service state propagation** — it caps cascading-failure blast radius and lets consumers scale independently.
- **Propagate a trace ID through everything.** Budget for tracing (Jaeger), centralized logs, and RED metrics from day one — retrofitting is painful.
- **Version APIs and use consumer-driven contract tests** so a producer change can't silently break consumers.
- **Automate deploys per service** with canary/blue-green; independent deployability is the entire benefit — don't gate all services on one release.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| Synchronous call chain, one hop slow | Latency stacks; thread pools exhaust; cascading outage | Aggressive timeouts, circuit breakers, bulkheads; convert to async where possible |
| Shared database across services | Silent recoupling; a schema change breaks multiple teams | DB-per-service; access only via API/events |
| Distributed transaction attempted (2PC) | Locks held across network; slow, fragile, blocks on coordinator failure | Sagas with compensating actions; idempotent handlers |
| No distributed tracing | Failures undebuggable; MTTR explodes | Propagate W3C traceparent; Jaeger/Zipkin; correlation IDs in logs |
| Service registry stale / unavailable | Callers route to dead instances | Health checks + TTLs; mesh with active health probing; sane retries |
| Message consumer down (async) | Backlog grows; processing delayed | Durable log (Kafka retention), replay, DLQs, autoscaling consumers |
| Chatty over-decomposition | N network hops per request; poor latency & reliability | Coarsen boundaries; collapse nano-services; batch calls |

## 10. Monitoring & Metrics

- **RED per service** — Rate (RPS), Errors (%), Duration (p50/p95/p99 latency) on every endpoint.
- **Dependency health** — per-downstream call latency, error rate, timeout rate, circuit-breaker state (open/closed/half-open).
- **Distributed traces** — end-to-end request latency and the span breakdown; watch fan-out width and critical-path hops.
- **Saga / async health** — event lag/consumer lag (Kafka), DLQ depth, compensation-action rate, end-to-end processing time.
- **Deploy metrics** — deployment frequency, change-failure rate, MTTR (the DORA four) — the actual scoreboard for whether the split paid off.
- **Resource isolation** — per-service CPU/mem/connection-pool saturation; alert before bulkhead limits are hit.
- **SLOs + error budgets** per service, with alerts on burn rate rather than raw thresholds.

## 11. Common Mistakes

1. ⚠️ **Microservices on day one.** No domain understanding yet → boundaries wrong → a distributed monolith that's harder than what you started with.
2. ⚠️ **Sharing a database** between services — the single fastest way to recouple everything you tried to separate.
3. ⚠️ **Long synchronous call chains** treated like local calls — no timeouts, no breakers → one slow service takes down the fleet.
4. ⚠️ **Distributed transactions via 2PC** across services instead of sagas — fragile, slow, and blocks on coordinator failure.
5. ⚠️ **No distributed tracing or correlation IDs** — the first production incident becomes an archaeology dig.
6. ⚠️ **Splitting by technical layer** (UI/service/DAO services) instead of business capability — every feature now touches every service.
7. ⚠️ **Nano-services** — decomposing so far that network overhead dwarfs the logic; latency and failure surface explode.
8. ⚠️ **Ignoring the org.** Copying Netflix's architecture without Netflix's platform, tooling, and on-call maturity buys all the cost and none of the benefit (Conway's Law works both ways).

## 12. Interview Questions

**Q: When would you split a monolith into microservices — and when would you refuse?**
A: Split when concrete, measured pain justifies the tax: many teams contending on one deploy pipeline, components with divergent scaling/availability needs, and clear stable bounded contexts — *and* you have the ops maturity (CI/CD, orchestration, tracing). Refuse when the team is small, the domain is still shifting, or the motivation is "cleaner code" (use a modular monolith). Default: monolith-first.

**Q: How do you decide service boundaries?**
A: Along **bounded contexts / business capabilities** (DDD), not technical layers or tables. The test: a typical feature should land in one service. If features routinely fan across many services, the boundaries follow the wrong axis of change.

**Q: Why is DB-per-service non-negotiable?**
A: A shared DB recouples services — a schema change breaks multiple teams and independent deployability is lost. Ownership means one writer per dataset; others read via API or events. The costs (no cross-service JOINs or ACID) are handled with app-side composition, read projections, and sagas.

**Q: Sync vs async communication — how do you choose?**
A: Sync (gRPC/REST) for queries needing an immediate answer; async (events) for propagating state changes others just need to know about. Async decouples availability and caps cascade blast radius; sync stacks latency and couples uptime. Minimize synchronous chains.

**Q: How do you handle a transaction spanning multiple services?**
A: A **saga**: a sequence of local transactions, each emitting an event; on failure, run compensating actions in reverse. Orchestration (a coordinator drives it) vs choreography (services react to events). Handlers must be idempotent. Avoid 2PC across services.

**Q: What is a distributed monolith and how do you spot one?**
A: Services that must be deployed together, share a database, or communicate in tightly-coupled synchronous chains. Symptoms: you can't deploy one without others, one schema change ripples across teams, and a single failure cascades. You've paid the distributed tax with none of the autonomy.

**Q: Explain the strangler fig migration pattern.**
A: Put a routing facade in front of the monolith; carve out one capability into a new service; route just that slice of traffic to it; repeat until the monolith is "strangled." It's incremental and reversible — no risky big-bang rewrite — and you migrate with real domain knowledge.

**Q (senior): A synchronous call to a downstream service starts timing out under load and your whole API goes down. Diagnose and fix.**
A: Classic cascading failure via resource exhaustion — callers block on the slow dependency until thread pools/connection pools are drained, so even unrelated endpoints fail. Fixes: strict timeouts, **circuit breakers** to fail fast, **bulkheads** to isolate the pool per dependency, load shedding, and ideally converting that interaction to async. Long-term: reduce synchronous fan-out on the critical path.

**Q (senior): How do you keep data consistent across services without distributed transactions, and what consistency do users actually see?**
A: Local transaction per service + events + sagas gives **eventual consistency**. Use the transactional outbox pattern (write state and the outgoing event in one local ACID transaction, then relay) to avoid dual-write inconsistency, plus idempotent consumers for at-least-once delivery. Users may briefly see stale cross-service state; design UX and read models to tolerate it, and reconcile with compensations.

**Q (senior): When is a service mesh worth its cost, and what does it *not* solve?**
A: Worth it once you have enough services (and languages) that reimplementing mTLS, retries, timeouts, and tracing per app becomes the bottleneck — the mesh standardizes those in sidecars. It does **not** fix bad boundaries, chatty designs, or data-consistency problems; it adds per-hop latency and significant operational surface. It's plumbing, not architecture.

**Q (senior): How does Conway's Law shape your microservice design?**
A: Systems mirror the communication structure of the org that builds them. If you want service boundaries to hold, align them with team boundaries (one team owns a service end-to-end). Conversely, a microservice architecture imposed on a monolithic org just moves the coupling from code to costly cross-team coordination — the "inverse Conway maneuver" reshapes teams *first*.

## 13. Alternatives & Related

- **Modular monolith** — the strongly recommended middle ground: monolith simplicity with enforced internal module boundaries and clean seams for later extraction.
- **Service-oriented architecture (SOA)** — the ancestor; heavier (ESB, WS-*). Microservices are "SOA done right" with smart endpoints and dumb pipes.
- **Serverless / FaaS** — an even finer-grained deployment model; shares the distributed-tax problems plus cold starts.
- **Sagas & the outbox pattern** — the consistency mechanisms that replace distributed transactions (see async messaging / **Message Queues**).
- **API Gateway & Service Mesh** — the routing and traffic-management layers that make a service fleet operable.
- **CAP & Consistency** — why cross-service state is eventual, not strong.

## 14. Cheat Sheet

> [!TIP]
> - **Default to a monolith** (well-modularized). Split only under measured pain: deploy contention, divergent scaling, clear bounded contexts, ops maturity.
> - **Boundaries = bounded contexts / business capabilities.** Not layers, not tables. A feature should land in one service.
> - **DB-per-service, always.** One writer; peers use API/events. No shared tables, no cross-service JOINs or ACID.
> - **Sync (gRPC/REST) for "answer now"; async (events) for "need to know."** Minimize synchronous chains — they cascade.
> - **No 2PC across services → sagas** with compensations + idempotency + transactional outbox.
> - **Pay the tax up front:** timeouts, circuit breakers, bulkheads, distributed tracing, contract tests, per-service CI/CD.
> - **Distributed monolith** = must deploy together / shared DB / sync-chained. The failure mode to avoid.
> - **Migrate via strangler fig**, not a big-bang rewrite. Conway's Law: align services with teams.

**References:** Martin Fowler — "Microservices" and "MonolithFirst"; Sam Newman — *Building Microservices*; Chris Richardson — microservices.io (Saga, Outbox, API Gateway patterns); DDIA ch.

---
*System Design Handbook — topic 29.*
