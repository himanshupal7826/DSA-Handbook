# 07 · REST vs GraphQL vs gRPC

> **In one line:** Three API styles trading off simplicity, client flexibility, and raw performance — pick by who calls you and how they use the data.

---

## 1. Overview

An **API style** is the contract shape between a client and a server: how you name things, how you fetch and mutate, and what travels on the wire. The three dominant styles solve different pains.

**REST** models the world as **resources** addressed by URLs and manipulated with HTTP verbs. It won because it is stateless, cacheable by any HTTP intermediary, and trivially debuggable with `curl`. Its weakness shows when one screen needs data from five resources.

**GraphQL** (Meta, 2015) flips control to the client: one endpoint, a typed **schema**, and a query language that lets the caller ask for *exactly* the fields it needs — killing the over/under-fetching that plagues REST on rich mobile screens.

**gRPC** (Google, 2016) optimizes for machine-to-machine speed: **Protobuf** binary encoding over **HTTP/2**, with generated client/server stubs and first-class streaming. It is the default for internal microservice fabric where every millisecond and byte matters.

A concrete example: a mobile app's home feed pulls user, posts, comments, and avatars. REST needs 4+ round trips or a custom endpoint; GraphQL does it in one query; an internal recommendation service feeding that feed talks gRPC to the ranking service.

## 2. Core Concepts

- **Resource & representation (REST)** — a noun (`/users/42`) with a JSON representation; verbs (`GET/POST/PUT/PATCH/DELETE`) express intent. The URL *is* the identity.
- **HATEOAS** — *Hypermedia As The Engine Of Application State*: responses embed links to next actions so clients discover navigation at runtime. Purist REST; rarely fully implemented in practice.
- **Over-fetching** — REST endpoint returns 40 fields; the screen uses 3. Wasted bandwidth, bigger payloads on mobile.
- **Under-fetching (N+1 round trips)** — one endpoint can't satisfy the view, so the client fires N follow-up calls (list, then a call per item).
- **Schema & type system (GraphQL)** — a strongly-typed SDL contract (`type User { id: ID! posts: [Post!]! }`) that powers introspection, tooling, and validation before execution.
- **Resolver** — a function per field that fetches its slice of data. The query is a tree; the engine walks it, invoking resolvers. Naive resolvers cause the **N+1 problem**.
- **Protobuf (gRPC)** — an IDL + compact binary wire format. Fields carry integer tags, not names, so payloads are 3–10× smaller than JSON and parse faster.
- **HTTP/2 multiplexing & streaming** — many concurrent RPCs over one TCP connection; gRPC exposes **unary**, **server-stream**, **client-stream**, and **bidirectional** streaming.
- **Code generation** — both GraphQL and gRPC generate typed client/server code from a schema/`.proto`, shifting errors from runtime to compile time.
- **Idempotency & safety** — `GET/PUT/DELETE` are idempotent, `GET` is safe/cacheable; GraphQL sends everything as `POST` (opaque to HTTP caches); gRPC caching is app-level.

## 3. Architecture

REST leans on the existing HTTP ecosystem (CDNs, caches, proxies). GraphQL inserts a single gateway that fans out to backends. gRPC is a tight binary pipe between services, usually behind an L7 proxy (Envoy) that understands HTTP/2.

```svg
<svg viewBox="0 0 720 300" width="100%" height="300" font-family="ui-sans-serif,system-ui,sans-serif" font-size="13">
  <defs>
    <marker id="ar" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
      <path d="M0,0 L7,3 L0,6 Z" fill="#475569"/>
    </marker>
  </defs>
  <!-- REST column -->
  <text x="120" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">REST</text>
  <rect x="55" y="40" width="130" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="120" y="62" text-anchor="middle" fill="#1e293b">Client</text>
  <line x1="120" y1="74" x2="120" y2="104" stroke="#475569" marker-end="url(#ar)"/>
  <text x="120" y="94" text-anchor="middle" fill="#64748b" font-size="11">GET /users/42</text>
  <rect x="45" y="106" width="150" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="120" y="128" text-anchor="middle" fill="#1e293b">CDN / HTTP cache</text>
  <line x1="120" y1="140" x2="120" y2="170" stroke="#475569" marker-end="url(#ar)"/>
  <rect x="55" y="172" width="130" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="120" y="194" text-anchor="middle" fill="#1e293b">Resource API</text>
  <text x="120" y="232" text-anchor="middle" fill="#64748b" font-size="11">many URLs,</text>
  <text x="120" y="248" text-anchor="middle" fill="#64748b" font-size="11">cacheable, N round-trips</text>

  <!-- GraphQL column -->
  <text x="360" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">GraphQL</text>
  <rect x="295" y="40" width="130" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="62" text-anchor="middle" fill="#1e293b">Client</text>
  <line x1="360" y1="74" x2="360" y2="104" stroke="#475569" marker-end="url(#ar)"/>
  <text x="360" y="94" text-anchor="middle" fill="#64748b" font-size="11">POST /graphql</text>
  <rect x="285" y="106" width="150" height="34" rx="8" fill="#fff7ed" stroke="#d97706"/>
  <text x="360" y="128" text-anchor="middle" fill="#1e293b">Gateway + resolvers</text>
  <line x1="325" y1="140" x2="300" y2="172" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="360" y1="140" x2="360" y2="172" stroke="#475569" marker-end="url(#ar)"/>
  <line x1="395" y1="140" x2="420" y2="172" stroke="#475569" marker-end="url(#ar)"/>
  <rect x="270" y="174" width="60" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="300" y="194" text-anchor="middle" fill="#1e293b" font-size="11">svc A</text>
  <rect x="335" y="174" width="50" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="360" y="194" text-anchor="middle" fill="#1e293b" font-size="11">svc B</text>
  <rect x="392" y="174" width="55" height="30" rx="6" fill="#eff6ff" stroke="#2563eb"/>
  <text x="419" y="194" text-anchor="middle" fill="#1e293b" font-size="11">DB</text>
  <text x="360" y="232" text-anchor="middle" fill="#64748b" font-size="11">one endpoint, exact fields,</text>
  <text x="360" y="248" text-anchor="middle" fill="#64748b" font-size="11">one round-trip</text>

  <!-- gRPC column -->
  <text x="600" y="24" text-anchor="middle" fill="#1e293b" font-weight="700">gRPC</text>
  <rect x="535" y="40" width="130" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="600" y="62" text-anchor="middle" fill="#1e293b">Service A stub</text>
  <line x1="600" y1="74" x2="600" y2="104" stroke="#475569" marker-end="url(#ar)"/>
  <text x="600" y="94" text-anchor="middle" fill="#64748b" font-size="11">HTTP/2 + Protobuf</text>
  <rect x="535" y="106" width="130" height="34" rx="8" fill="#ecfdf5" stroke="#059669"/>
  <text x="600" y="128" text-anchor="middle" fill="#1e293b">Envoy (L7)</text>
  <line x1="600" y1="140" x2="600" y2="170" stroke="#475569" marker-end="url(#ar)"/>
  <rect x="535" y="172" width="130" height="34" rx="8" fill="#eff6ff" stroke="#2563eb"/>
  <text x="600" y="194" text-anchor="middle" fill="#1e293b">Service B stub</text>
  <text x="600" y="232" text-anchor="middle" fill="#64748b" font-size="11">binary, streaming,</text>
  <text x="600" y="248" text-anchor="middle" fill="#64748b" font-size="11">low latency, codegen</text>
</svg>
```

## 4. How It Works

A GraphQL query lifecycle (the most involved of the three):

1. **Client composes a query** naming the exact fields it wants across a nested tree (`user { name posts { title } }`).
2. **Transport** — sent as an HTTP `POST` to the single `/graphql` endpoint with the query string (and variables) in the body.
3. **Parse & validate** — the server parses the query to an AST and validates it against the **schema**; unknown fields fail *before* any data is touched.
4. **Plan & execute** — the engine walks the query tree, calling a **resolver** per field. Parent resolvers produce the objects children resolve against.
5. **Batch data access** — a **DataLoader** coalesces the many per-item fetches from step 4 into batched `IN (...)` queries, defeating the N+1 problem.
6. **Assemble response** — results are shaped to mirror the query exactly; per-field errors are collected into an `errors[]` array alongside `data`.
7. **Return** — always HTTP `200` (even on partial failure); the client reads `data` + `errors`.

REST is steps 1–2 and 7 with the server doing a fixed query. gRPC replaces 3–6 with: deserialize Protobuf → invoke the generated service method → serialize the Protobuf response, optionally as a stream of messages.

## 5. Key Components / Deep Dive

### REST — resources, verbs, HATEOAS
Design nouns not verbs (`POST /orders`, not `/createOrder`). Use status codes as the protocol (201 created, 404, 409 conflict). **HATEOAS** embeds `_links` so a client follows `next`/`cancel` without hardcoding URLs — powerful in theory, but most clients bind to URLs directly, so it is the least-adopted REST constraint.

### GraphQL — schema, resolvers, and the N+1 trap
The schema is the API. A query for 100 posts each with an author naively fires 1 + 100 DB calls (**N+1**). Fixes: **DataLoader** batching per request, `@defer` for slow fields, and **persisted queries** (client sends a hash, not the query text) to shrink payloads and lock down the allowed query set. Guard cost with **query depth/complexity limits** — an unbounded nested query is a DoS vector unique to GraphQL.

### gRPC — Protobuf, HTTP/2, streaming, codegen
You write a `.proto` once; `protoc` generates typed stubs in 10+ languages. Protobuf's **tag-based binary** format means adding a new field (new tag number) is backward compatible — old readers skip unknown tags. HTTP/2 gives multiplexed streams so a **bidirectional stream** (e.g., live chat, telemetry) runs over one connection. Cost: not human-readable, needs HTTP/2-aware infra, and **gRPC-Web** is required for browsers because they can't speak raw HTTP/2 frames.

## 6. Trade-offs

| Style | Pros | Cons |
|---|---|---|
| **REST** | Ubiquitous, HTTP-cacheable, simple, great tooling, stateless | Over/under-fetching, endpoint sprawl, weak typing, many round trips |
| **GraphQL** | Exact-shape fetching, one endpoint, strong types + introspection, evolves without versioning | N+1 & query-cost risk, no HTTP caching, server complexity, harder rate-limiting |
| **gRPC** | Fastest + smallest wire, streaming, codegen, strict contracts | Binary (hard to debug), browser needs gRPC-Web, needs HTTP/2 infra, steeper learning curve |

The axis is **who consumes you**. Public/third-party → REST's ubiquity wins. Rich clients you own → GraphQL's flexibility wins. Internal service-to-service → gRPC's throughput wins. Many large systems run all three: gRPC internally, a GraphQL gateway for apps, REST for public partners.

## 7. When to Use / When to Avoid

**Reach for it when:**
- **REST** — public/partner APIs, CRUD resources, anything that benefits from CDN/HTTP caching or must be trivially debuggable.
- **GraphQL** — mobile/web clients with varied, deeply-nested data needs; a **BFF** aggregating many microservices; rapidly evolving front-ends.
- **gRPC** — internal microservice mesh, low-latency/high-throughput RPC, streaming (telemetry, chat, pub/sub), polyglot backends needing shared contracts.

**Avoid it when:**
- **REST** — a single screen needs 6 resources (round-trip tax) or clients are painfully bandwidth-constrained.
- **GraphQL** — simple CRUD (overkill), you rely on HTTP caching, or an untrusted public client could send abusive nested queries.
- **gRPC** — browser is a first-class client without a proxy, you need human-readable payloads, or the team lacks HTTP/2-capable infra.

## 8. Scaling & Production Best Practices

- **REST caching** — set `Cache-Control`/`ETag`; a well-cached read API offloads 80–95% of traffic to the CDN before it reaches origin.
- **GraphQL persisted queries** — replace multi-KB query strings with a 32-byte hash; enables an allow-list and CDN caching of `GET` GraphQL.
- **DataLoader everywhere** — batch + per-request cache to keep resolver DB calls O(1) per entity type, not O(N).
- **gRPC connection reuse** — one HTTP/2 channel handles thousands of concurrent RPCs; pool channels, tune `MAX_CONCURRENT_STREAMS`, enable keepalive to survive idle NAT timeouts.
- **Payload budgets** — Protobuf typically cuts payload 3–10× vs JSON; measure p99 serialization, not just size.
- **Deadlines/timeouts** — gRPC deadlines propagate across the call chain; always set them to prevent cascading hangs.
- **Compression** — gzip/brotli for REST/GraphQL JSON; gRPC has per-message compression.

## 9. Failure Modes & Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| GraphQL N+1 explosion | DB overload, high p99 latency | DataLoader batching; query cost limits |
| Malicious deep GraphQL query | CPU/DB DoS | Max depth + complexity budget; persisted queries allow-list |
| REST under-fetch (N calls) | Slow mobile screens, battery drain | Aggregation endpoint / BFF / GraphQL |
| gRPC missing deadline | Cascading hangs, thread exhaustion | Enforce deadlines; propagate context; circuit breakers |
| Protobuf field number reuse | Silent data corruption across versions | Never reuse/renumber tags; mark removed as `reserved` |
| GraphQL error hidden in 200 | Clients treat failure as success | Always inspect `errors[]`, not just HTTP status |
| gRPC in browser without proxy | Requests fail | gRPC-Web + Envoy translation, or expose REST/GraphQL edge |

## 10. Monitoring & Metrics

- **Per-endpoint / per-query latency** (p50/p95/p99) — for GraphQL, tag by *operation name*, not the single `/graphql` route.
- **GraphQL resolver-level timing** and DataLoader batch sizes (batch size ≈ 1 signals a broken loader).
- **Query complexity/depth distribution** — alert on outliers approaching the limit.
- **gRPC status code rates** (`OK`, `DEADLINE_EXCEEDED`, `UNAVAILABLE`) and per-method latency.
- **Payload sizes** and compression ratios; error-rate by status class (4xx vs 5xx for REST).
- **Cache hit ratio** (REST CDN, persisted-query cache).
- **HTTP/2 stream counts** and connection churn for gRPC.

## 11. Common Mistakes

1. ⚠️ Verbs in REST URLs (`/getUser`) instead of resources + HTTP methods.
2. ⚠️ Returning HTTP 200 with an error body in REST — breaks clients and caches.
3. ⚠️ Shipping GraphQL without DataLoader, then blaming the DB for N+1 load.
4. ⚠️ No query depth/complexity limit on a public GraphQL endpoint (DoS open door).
5. ⚠️ Reusing or renumbering Protobuf field tags — silent cross-version corruption.
6. ⚠️ Not setting gRPC deadlines, letting one slow dependency hang the whole chain.
7. ⚠️ Exposing gRPC directly to browsers without gRPC-Web/Envoy.
8. ⚠️ Over-versioning REST (`/v2`, `/v3`) instead of additive, backward-compatible changes.

## 12. Interview Questions

**Q: What makes an API "RESTful" beyond returning JSON?**
A: Statelessness, resource-oriented URLs, uniform interface via HTTP verbs, cacheability, and ideally HATEOAS. JSON over HTTP alone is not REST — it's often "HTTP RPC."

**Q: Explain over-fetching vs under-fetching and how GraphQL addresses both.**
A: Over-fetching = endpoint returns more fields than the client needs; under-fetching = client must make extra calls to complete a view. GraphQL lets the client specify the exact field tree in one request, eliminating both.

**Q: What is the N+1 problem in GraphQL and how do you fix it?**
A: A list resolver returns N items, and a child field resolver fires one DB call per item (1 + N). DataLoader batches those into a single keyed query per tick and caches within the request.

**Q: Why is gRPC faster than REST/JSON?**
A: Protobuf binary encoding (smaller, no field-name overhead, fast parse) plus HTTP/2 multiplexing (no head-of-line blocking at the request level, one connection) and no repeated TCP/TLS setup.

**Q: gRPC supports four call types — name them and a use case each.**
A: Unary (normal RPC), server-streaming (push results / feed), client-streaming (upload chunks / metrics), bidirectional (chat, live sync).

**Q: How does each style handle versioning?**
A: REST → URI or header versions and additive changes; GraphQL → evolve the schema, deprecate fields, no version bump; gRPC → add new Protobuf fields with new tags (backward compatible), never reuse tags.

**Q (Senior): You run gRPC internally but need a public browser API. What's the architecture?**
A: Keep gRPC service-to-service; put a gateway (GraphQL BFF or REST via gRPC-Web/Envoy transcoding) at the edge. Browsers hit the edge; the edge speaks gRPC inward. This isolates the public contract from internal churn.

**Q (Senior): GraphQL breaks HTTP caching. What do you lose and how do you compensate?**
A: You lose CDN/proxy caching since everything is `POST`. Compensate with persisted queries served over `GET` (cacheable by hash), server-side response caching keyed on query+variables, `@cacheControl` hints, and per-resolver caches (DataLoader/Redis).

**Q (Senior): How would you prevent a malicious client from DoS-ing your public GraphQL API?**
A: Enforce max query depth and a complexity/cost budget computed before execution, use persisted-query allow-lists so only vetted queries run, apply per-client rate limits weighted by query cost, and set resolver timeouts.

**Q (Senior): A REST endpoint's payload grew to 40 fields and mobile clients are slow. Options?**
A: Add sparse fieldsets (`?fields=`), introduce a BFF/aggregation layer, adopt GraphQL for that client, or split into resource sub-representations. Measure whether the cost is bytes (compress) or round trips (aggregate) first.

**Q (Senior): When would you NOT choose gRPC despite its performance?**
A: Public/partner APIs (ecosystem/ubiquity matter more than µs), browser-first clients without a proxy, teams lacking HTTP/2 infra, or when human-readable debuggability and HTTP caching outweigh raw throughput.

## 13. Alternatives & Related

- **Message Queues** — async/event-driven alternative to synchronous request/response APIs.
- **Rate Limiting** — essential guard for public REST/GraphQL endpoints.
- **Microservices** — the setting where gRPC internal + GraphQL/REST edge is the common topology.
- **Load Balancing** — L7 proxies (Envoy) that terminate/route HTTP/2 for gRPC.
- **Webhooks / SSE / WebSockets** — for server-push where request/response APIs fall short.

## 14. Cheat Sheet

> [!TIP]
> **REST** = resources + HTTP verbs, cacheable, ubiquitous → public APIs & CRUD.
> **GraphQL** = one endpoint, typed schema, client picks fields → rich apps/BFF; beware N+1 (DataLoader) and query-cost DoS (depth limits), no HTTP cache (persisted queries).
> **gRPC** = Protobuf + HTTP/2 + streaming + codegen → internal microservices & low latency; browsers need gRPC-Web; never reuse Protobuf tags; always set deadlines.
> Decision axis = **who calls you**: partners→REST, your apps→GraphQL, your services→gRPC. Big systems run all three.

**References:** gRPC docs, GraphQL docs (graphql.org), Google API Design Guide, Apollo GraphQL best practices

---
*System Design Handbook — topic 07.*
