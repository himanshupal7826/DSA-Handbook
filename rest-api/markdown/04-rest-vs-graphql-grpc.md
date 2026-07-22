# 04 · REST vs GraphQL, gRPC & SOAP

> **In one line:** REST, GraphQL, gRPC and SOAP are four different answers to "who decides the shape of the response, and what does the network pay for it" — and choosing well is about client diversity, latency budget, caching needs and organisational boundaries, not about which one is newest.

---

## 1. Overview

Every API style is a bargain between three parties: the server that owns the data, the client that needs a specific shape of it, and the network in between. **REST** gives the server control of the response shape and buys the participation of every HTTP intermediary. **GraphQL** hands shape control to the client and buys the elimination of over- and under-fetching. **gRPC** optimises the wire and the type system for machine-to-machine calls inside one system. **SOAP** buys formal, tool-generated contracts and enterprise-grade message-level guarantees at the cost of enormous ceremony. None is a strict upgrade over another, and mature systems commonly run three of them simultaneously for different jobs.

The history explains the shape of each. **SOAP** (1998, W3C) grew out of XML-RPC to give the enterprise a transport-neutral, formally described, WS-\*-extensible messaging protocol; WSDL made compile-time contracts and code generation possible a decade before anyone said "OpenAPI". **REST** (Fielding, 2000) rejected the envelope and leaned on HTTP's own semantics; by 2010 JSON-over-HTTP had won the public-API market outright. **gRPC** (Google, 2015, open-sourced from internal Stubby) brought Protocol Buffers, HTTP/2 and generated stubs to microservice-to-microservice traffic where JSON parsing and per-call handshakes were measurably expensive. **GraphQL** (Facebook, 2012 internally, public 2015) came from a specific pain: mobile clients on bad networks needed dozens of REST calls to render one feed screen, and every UI change required a backend release.

The decision is rarely "which is best" and almost always "which boundary is this". A useful default: **REST for public and partner APIs**, because ubiquity, caching, and the ability for any developer to `curl` it dominate; **gRPC for internal service-to-service**, because you control both ends, want generated types and streaming, and care about p99 latency; **GraphQL for aggregation layers serving diverse, fast-moving UI clients**, because the client-shaped query is exactly what a product team needs; **SOAP only when a counterparty requires it** — banking (ISO 20022), insurance, healthcare, telecom OSS/BSS, and government systems where WS-Security and formal contracts are contractual obligations.

A concrete illustration of the same fetch across styles. Rendering a "user profile with their last 5 orders and each order's items" costs, over REST, either three round trips (`/users/9`, `/users/9/orders?limit=5`, then item expansion) or one call to a purpose-built endpoint. In GraphQL it is one query naming exactly those fields. In gRPC it is one unary call returning a strongly typed message over a warm HTTP/2 connection in single-digit milliseconds. In SOAP it is one `POST` with a 4 KB envelope wrapping a 300-byte payload. Each is the "right" answer under different constraints — and this chapter's job is to make those constraints explicit enough to decide in a design review.

## 2. Core Concepts

- **Resource-oriented (REST)** — the API surface is a set of named resources manipulated with a fixed, uniform set of methods; the server decides the representation.
- **Query language (GraphQL)** — a single endpoint accepting a client-authored query against a typed schema; the response mirrors the query's shape exactly.
- **RPC (gRPC, SOAP)** — the API surface is a set of named *procedures* with typed inputs and outputs; the transport is an implementation detail.
- **Schema / IDL** — the machine-readable contract: OpenAPI for REST, SDL for GraphQL, `.proto` for gRPC, WSDL + XSD for SOAP. Determines what can be generated and validated.
- **Serialization format** — JSON (REST, GraphQL), Protocol Buffers binary (gRPC), XML (SOAP). Drives payload size, parse cost and human readability.
- **Over-fetching / under-fetching** — receiving fields you did not need, or needing N extra calls to assemble a view. The core pain GraphQL targets.
- **N+1 problem** — one query for a list plus one per item; a client-side latency disaster in REST and a server-side database disaster in GraphQL (solved with DataLoader-style batching).
- **Streaming** — gRPC natively supports server-, client- and bidirectional streaming over HTTP/2; REST needs SSE, chunked responses or WebSockets; GraphQL uses subscriptions.
- **BFF (Backend for Frontend)** — a per-client aggregation layer that shapes several downstream APIs into one screen-shaped API; often the cheaper alternative to adopting GraphQL wholesale.
- **Persisted query** — a pre-registered GraphQL query referenced by hash, restoring cacheability and blocking arbitrary client queries in production.

## 3. Theory & Principles

### Who controls the response shape?

This single axis explains most of the differences. In REST the server publishes fixed representations; the client takes what it is given (possibly narrowed by `?fields=` or `?expand=`). In GraphQL the client authors the shape and the server must be able to resolve any valid combination. In gRPC and SOAP the shape is fixed at compile time by the IDL and shared by both sides.

Server-controlled shape makes responses **cacheable by URI**, because the same URI plus the same `Vary` headers always yields the same representation. Client-controlled shape breaks that: a `POST /graphql` with an arbitrary body is opaque to every HTTP cache, which is why GraphQL deployments end up rebuilding caching inside the application (normalised client caches like Apollo, `@cacheControl` hints, persisted queries served over `GET`).

### The efficiency trilemma

| | Bytes on the wire | Round trips per screen | Intermediary support |
|---|---|---|---|
| REST | JSON, verbose; compression helps | Several, unless you build aggregate endpoints | Excellent: CDN, proxy, WAF, browser cache all participate |
| GraphQL | Exactly the requested fields | One | Poor by default: single opaque `POST`, no HTTP caching |
| gRPC | Protobuf binary, smallest | One, plus streaming | Poor over the public internet; needs a proxy for browsers (gRPC-Web) |
| SOAP | XML envelope, largest | One | Weak: `POST`-only, uncacheable, but strong WS-\* middleware |

You cannot maximise all three. REST trades bytes and round trips for universal intermediary support. GraphQL trades intermediary support for round trips and precision. gRPC trades human readability and browser reach for raw efficiency and type safety.

### Type systems and coupling

gRPC and SOAP have **compile-time** contracts: change the `.proto` or the WSDL and both sides regenerate. That eliminates a whole class of integration bug and is wonderful when you control both ends — and painful across organisational boundaries, where you cannot force a partner to regenerate. REST's contract is enforced at runtime (schema validation, contract tests), which is looser but survives independent deployment. GraphQL sits in between: a strongly typed schema with runtime validation, plus first-class deprecation (`@deprecated`) and field-level usage analytics that make removals data-driven.

### Error and failure semantics

REST uses HTTP status codes, so generic clients, load balancers and dashboards understand failures for free. gRPC has its own 17-code status space (`OK`, `INVALID_ARGUMENT`, `NOT_FOUND`, `DEADLINE_EXCEEDED`, `UNAVAILABLE`…) carried in trailers, plus first-class **deadlines** propagated across hops — a genuine advantage REST lacks. GraphQL returns `200 OK` with an `errors` array even for total failures, which is its most operationally annoying property: your HTTP-level error dashboards go blind, and you must instrument at the resolver level instead. SOAP wraps failures in a `<soap:Fault>` inside a `200` or `500`.

```svg
<svg viewBox="0 0 820 350" width="100%" height="350" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="e1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="e2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">One screen, four styles: round trips and who shapes the response</text>
  <g stroke-width="2">
    <rect x="20" y="46" width="380" height="140" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
    <rect x="420" y="46" width="380" height="140" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
    <rect x="20" y="200" width="380" height="140" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="420" y="200" width="380" height="140" rx="8" fill="#fef3c7" stroke="#d97706"/>
  </g>
  <g fill="#1e293b" font-weight="bold" font-size="13">
    <text x="36" y="68">REST &#8212; server shapes, 3 trips</text><text x="436" y="68">GraphQL &#8212; client shapes, 1 trip</text>
    <text x="36" y="222">gRPC &#8212; IDL shapes, 1 trip, binary</text><text x="436" y="222">SOAP &#8212; WSDL shapes, 1 trip, XML</text>
  </g>
  <g fill="#1e293b" font-size="11">
    <text x="36" y="90">GET /users/9</text>
    <text x="36" y="110">GET /users/9/orders?limit=5</text>
    <text x="36" y="130">GET /orders/{id}/items  (xN)</text>
    <text x="36" y="156" fill="#0369a1">cacheable at CDN &#183; ETag &#183; 304</text>
    <text x="36" y="174" fill="#b45309">over-fetch + N+1 unless expanded</text>

    <text x="436" y="90">POST /graphql</text>
    <text x="436" y="110">{ user(id:9){ name orders(last:5){</text>
    <text x="436" y="130">    total items{ sku qty } } } }</text>
    <text x="436" y="156" fill="#0369a1">exact fields &#183; one round trip</text>
    <text x="436" y="174" fill="#b45309">opaque to HTTP caches &#183; 200 + errors[]</text>

    <text x="36" y="244">rpc GetUserFeed(FeedReq) returns (Feed)</text>
    <text x="36" y="264">protobuf binary over HTTP/2</text>
    <text x="36" y="284">deadlines &#183; streaming &#183; generated stubs</text>
    <text x="36" y="310" fill="#0369a1">smallest payload, lowest p99</text>
    <text x="36" y="328" fill="#b45309">no browser without gRPC-Web proxy</text>

    <text x="436" y="244">POST /UserService  SOAPAction: GetFeed</text>
    <text x="436" y="264">&lt;soap:Envelope&gt;&lt;soap:Body&gt; ... </text>
    <text x="436" y="284">&lt;/soap:Body&gt;&lt;/soap:Envelope&gt;</text>
    <text x="436" y="310" fill="#0369a1">WSDL contract &#183; WS-Security &#183; tooling</text>
    <text x="436" y="328" fill="#b45309">verbose &#183; uncacheable &#183; heavy ceremony</text>
  </g>
</svg>
```

## 4. Architecture & Workflow

A realistic topology in a company that has outgrown one style, and how a single mobile screen request flows through it:

1. **Client issues one request** to the aggregation layer — a GraphQL query or a BFF REST endpoint — carrying a bearer token and a `traceparent`.
2. **Edge and gateway.** TLS termination, WAF, coarse rate limiting. For REST `GET`s the CDN may answer directly from cache; for `POST /graphql` it cannot, unless the deployment uses **persisted queries over `GET`** with a query hash in the URL, which restores cacheability.
3. **Aggregation layer plans the work.** A GraphQL server parses and validates the query against the schema, rejects it if it exceeds depth/complexity limits, and builds a resolver plan. A BFF simply calls the endpoints its screen needs.
4. **Fan-out to domain services over gRPC.** Each resolver calls a domain service — `UserService.Get`, `OrderService.ListByUser`, `CatalogService.BatchGetSkus` — over warm HTTP/2 connections with protobuf payloads and an explicit **deadline** derived from the client's remaining budget.
5. **Batching prevents the server-side N+1.** A DataLoader coalesces the per-order item lookups from step 4 into one `BatchGetSkus` call per tick. Without this, a five-order query becomes dozens of downstream calls — GraphQL moves the N+1 problem from the client to your own infrastructure.
6. **Legacy SOAP hop.** One field resolves against a partner bank's SOAP endpoint through an adapter that signs the envelope (WS-Security), maps `<soap:Fault>` onto a domain error, and enforces a tight timeout because the partner has no deadline propagation.
7. **Assembly and response.** The aggregation layer merges results into the client-requested shape. Partial failure is real: GraphQL can return `data` with nulls plus an `errors` array — decide deliberately whether your clients treat that as success.
8. **Observability.** One trace spans all hops. Metrics are recorded per GraphQL *operation name* and per gRPC *method*, never per raw query text, and the REST tier is measured per route template.
9. **Response caching.** REST responses carry `ETag`/`Cache-Control`. GraphQL responses are cached in the client's normalised store (Apollo/Relay) and, if `@cacheControl` hints are set, at a GraphQL-aware CDN.

```svg
<svg viewBox="0 0 820 370" width="100%" height="370" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="f1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="f2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="410" y="22" text-anchor="middle" fill="#1e293b" font-size="14" font-weight="bold">Mixed-style topology: REST at the edge, gRPC inside, SOAP at the partner</text>
  <g stroke-width="2">
    <rect x="20" y="50" width="120" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
    <rect x="20" y="130" width="120" height="60" rx="8" fill="#e0f2fe" stroke="#0ea5e9"/>
    <rect x="190" y="90" width="130" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
    <rect x="370" y="90" width="140" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5"/>
    <rect x="560" y="30" width="140" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="560" y="100" width="140" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="560" y="170" width="140" height="52" rx="8" fill="#f0fdf4" stroke="#16a34a"/>
    <rect x="560" y="248" width="140" height="60" rx="8" fill="#fef3c7" stroke="#d97706"/>
  </g>
  <g text-anchor="middle" fill="#1e293b" font-weight="bold">
    <text x="80" y="76">Mobile app</text><text x="80" y="156">Web SPA</text>
    <text x="255" y="116">Edge + CDN</text><text x="440" y="112">GraphQL / BFF</text>
    <text x="630" y="52">UserService</text><text x="630" y="122">OrderService</text>
    <text x="630" y="192">CatalogService</text><text x="630" y="272">Partner bank</text>
  </g>
  <g text-anchor="middle" fill="#475569" font-size="11">
    <text x="80" y="94">one query</text><text x="80" y="174">one query</text>
    <text x="255" y="134">REST GETs cached</text><text x="440" y="132">depth limits, DataLoader</text>
    <text x="630" y="70">gRPC</text><text x="630" y="140">gRPC</text><text x="630" y="210">gRPC batch</text>
    <text x="630" y="292">SOAP + WS-Security</text>
  </g>
  <g stroke="#4f46e5" stroke-width="2" marker-end="url(#f1)">
    <line x1="142" y1="80" x2="186" y2="106"/><line x1="142" y1="160" x2="186" y2="134"/>
    <line x1="322" y1="120" x2="366" y2="120"/>
    <line x1="512" y1="112" x2="556" y2="62"/><line x1="512" y1="120" x2="556" y2="126"/>
    <line x1="512" y1="130" x2="556" y2="192"/>
  </g>
  <line x1="512" y1="142" x2="556" y2="270" stroke="#d97706" stroke-width="2" stroke-dasharray="5 4" marker-end="url(#f2)"/>
  <rect x="20" y="322" width="780" height="38" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="34" y="346" fill="#1e293b" font-size="12">One traceparent spans every hop &#183; deadlines propagate on gRPC &#183; the SOAP leg gets a hard timeout and a circuit breaker</text>
</svg>
```

> **Note:** Adding GraphQL does not remove the need for well-designed downstream APIs — it relocates the aggregation problem into a layer you now have to operate, secure and rate-limit. If exactly one screen is chatty, a BFF endpoint is far cheaper than a GraphQL platform.

## 5. Implementation

### The same fetch, four ways

```http
GET /v1/users/9?expand=orders.items&orders_limit=5 HTTP/1.1
Accept: application/json
Authorization: Bearer ...

HTTP/1.1 200 OK
Content-Type: application/json
ETag: W/"u9-o5-3fa1"
Cache-Control: private, max-age=30

{"id":"usr_9","name":"Asha","orders":[{"id":"ord_9F2","total":159800,
  "items":[{"sku":"TSHIRT-BLK-M","quantity":2}]}]}
```

```graphql
# POST /graphql — client picks the exact fields; one round trip, zero over-fetch
query ProfileScreen($id: ID!) {
  user(id: $id) {
    name
    orders(last: 5) { total items { sku quantity } }
  }
}
```

```protobuf
// user.proto — compile-time contract shared by both ends
syntax = "proto3";
package shop.v1;

message GetUserFeedRequest { string user_id = 1; int32 order_limit = 2; }
message Item  { string sku = 1; int32 quantity = 2; }
message Order { string id = 1; int64 total_minor = 2; repeated Item items = 3; }
message UserFeed { string name = 1; repeated Order orders = 2; }

service UserService {
  rpc GetUserFeed(GetUserFeedRequest) returns (UserFeed);
  rpc WatchOrders(GetUserFeedRequest) returns (stream Order);   // server streaming
}
```

```xml
<!-- SOAP: the envelope is the protocol; note the ~4KB of ceremony for 300B of data -->
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope">
  <soap:Header><wsse:Security><wsse:UsernameToken>...</wsse:UsernameToken></wsse:Security></soap:Header>
  <soap:Body>
    <GetUserFeed xmlns="urn:shop:v1"><UserId>9</UserId><OrderLimit>5</OrderLimit></GetUserFeed>
  </soap:Body>
</soap:Envelope>
```

### Serving GraphQL responsibly (Python, Strawberry)

```python
import strawberry
from strawberry.extensions import QueryDepthLimiter, MaxTokensLimiter
from aiodataloader import DataLoader

async def load_items(order_ids: list[str]) -> list[list["Item"]]:
    rows = await db.fetch_items_for(order_ids)          # ONE query, not N
    return [rows.get(oid, []) for oid in order_ids]

item_loader = DataLoader(load_fn=load_items)

@strawberry.type
class Order:
    id: str
    total: int
    @strawberry.field
    async def items(self) -> list["Item"]:
        return await item_loader.load(self.id)          # batched per tick

@strawberry.type
class Query:
    @strawberry.field
    async def user(self, id: strawberry.ID) -> "User":
        return await db.get_user(id)

schema = strawberry.Schema(
    query=Query,
    extensions=[QueryDepthLimiter(max_depth=8),         # stop nested-query DoS
                MaxTokensLimiter(max_token_count=1500)],
)
```

Two non-negotiables in production GraphQL: **complexity/depth limits** (a recursive query can otherwise cost you the database) and **persisted queries** — the client sends a hash, the server executes only pre-registered operations, which blocks arbitrary queries and lets you serve them over `GET` so CDNs can cache them.

### Calling gRPC with a deadline

```python
import grpc, shop_pb2, shop_pb2_grpc

with grpc.insecure_channel("orders:50051") as channel:      # use TLS in production
    stub = shop_pb2_grpc.UserServiceStub(channel)
    try:
        feed = stub.GetUserFeed(
            shop_pb2.GetUserFeedRequest(user_id="9", order_limit=5),
            timeout=0.250,                                  # deadline propagates downstream
        )
    except grpc.RpcError as e:
        if e.code() == grpc.StatusCode.DEADLINE_EXCEEDED:
            ...                                             # shed load, serve degraded UI
        elif e.code() == grpc.StatusCode.UNAVAILABLE:
            ...                                             # retryable: backoff + jitter
```

> **Optimization note.** Measure before you migrate. Typical orders of magnitude on a warm connection inside one datacenter: a gRPC unary call is ~0.1–1 ms of serialization overhead with payloads 3–10× smaller than the equivalent JSON; a REST/JSON call over HTTP/2 with keep-alive adds a few hundred microseconds of parse cost; the dominant term in both is almost always the database. Over the public internet, connection setup and TLS handshakes dwarf serialization entirely — which is why "we switched to gRPC for speed" often yields nothing at the edge while delivering real wins between internal services. For REST, the cheapest wins remain conditional requests (`ETag` → `304`), compression, and one aggregate endpoint for the chattiest screen.

## 6. Advantages, Disadvantages & Trade-offs

| Aspect | Strength | Cost / Trade-off |
|---|---|---|
| **REST** | Universal reach, HTTP caching and intermediaries for free, trivially debuggable, huge talent pool | Over/under-fetching, chatty screens, many endpoints to version and document |
| **GraphQL** | One round trip, exact fields, strong schema with field-level deprecation and usage analytics, great DX for UI teams | No HTTP caching by default; `200`-with-`errors` hides failures; server-side N+1 and query-cost DoS need real engineering; harder rate limiting |
| **gRPC** | Smallest payloads, lowest latency, generated typed stubs, streaming, deadlines, rich status codes | Binary and not human-readable; no native browser support (needs gRPC-Web/Connect); poor fit for public third-party APIs; proxies need HTTP/2 end to end |
| **SOAP** | Formal WSDL contracts, mature enterprise tooling, WS-Security/WS-ReliableMessaging, transport-neutral | Extremely verbose, uncacheable, slow to develop against, shrinking ecosystem and talent pool |
| **Caching** | REST wins outright — URI + `ETag` + `Cache-Control` | GraphQL and gRPC must rebuild caching in the application or client |
| **Type safety** | gRPC and SOAP are compile-time; GraphQL is schema-validated at runtime | REST needs OpenAPI plus contract tests to approach the same guarantee |
| **Evolvability** | GraphQL deprecates per field with usage data; REST versions per endpoint | gRPC/SOAP regeneration is coordinated — fine internally, painful across organisations |
| **Operational cost** | REST is the cheapest to run and observe with standard tooling | GraphQL adds a schema registry, cost analysis and resolver-level tracing; gRPC adds proxy and TLS/HTTP2 plumbing |

## 7. Common Mistakes & Best Practices

1. ⚠️ **Choosing a style because it is fashionable.** "We should be on GraphQL" without naming the pain it solves buys you a new platform to operate. ✅ Write down the constraint first: client diversity, latency budget, caching need, who controls both ends.
2. ⚠️ **Exposing gRPC directly to browsers or third parties.** Browsers cannot speak raw gRPC and partners will not adopt protobuf. ✅ gRPC internally; REST (or gRPC-Web/Connect behind a gateway) externally.
3. ⚠️ **Shipping GraphQL without depth, complexity or rate limits.** A single deeply nested query can execute thousands of database calls. ✅ Depth limits, complexity scoring, per-operation rate limits, timeouts, and persisted queries in production.
4. ⚠️ **Letting GraphQL's `200 OK` blind your monitoring.** HTTP-level dashboards show a healthy API while every request returns errors. ✅ Instrument per operation name and per resolver; alert on `errors[]` rate, not status codes.
5. ⚠️ **Forgetting that GraphQL relocates the N+1 problem.** ✅ DataLoader batching from day one, plus query-plan tests that assert downstream call counts.
6. ⚠️ **Assuming GraphQL removes the need for authorization design.** Field-level access control is *harder*, not easier, because any traversal is possible. ✅ Authorize in resolvers on the object being returned, never only at the query root.
7. ⚠️ **Building a "REST" API that is Level 0 RPC** — `POST /api` with an operation field. You get none of REST's benefits and none of gRPC's. ✅ Either commit to resources and methods, or pick an honest RPC stack.
8. ⚠️ **Migrating wholesale.** Big-bang rewrites from REST to GraphQL/gRPC stall halfway and leave two half-maintained surfaces. ✅ Strangler pattern: put the new style in front of or beside the old one, migrate the highest-pain screen or service first, and measure.
9. ⚠️ **Ignoring deadlines and timeouts in gRPC.** Without an explicit deadline the default is effectively infinite and one slow dependency exhausts your goroutines/threads. ✅ Set deadlines at the edge and propagate them; treat `DEADLINE_EXCEEDED` as a first-class outcome.
10. ⚠️ **Breaking a `.proto` by reusing or renumbering field tags.** ✅ Never reuse a tag number; mark removed ones `reserved`; only ever add optional fields.
11. ⚠️ **Wrapping SOAP in REST and calling it modernised.** A JSON facade over an unchanged synchronous SOAP call inherits its latency and failure modes. ✅ Add timeouts, circuit breakers, an anti-corruption layer, and where possible make the interaction asynchronous.
12. ⚠️ **Running three styles with three different auth, error and observability models.** ✅ Standardise cross-cutting concerns — one identity model, one trace format, one error taxonomy mapped per style (`4xx/5xx` ↔ gRPC codes ↔ `errors[]`).

## 8. Production: Debugging, Monitoring, Security & Scaling

### Debugging

REST is `curl`. GraphQL: capture the **operation name** and variables (never log full query text with PII), and use Apollo/Relay devtools plus resolver-level tracing to find which field is slow. gRPC: `grpcurl` for ad-hoc calls, server reflection enabled in non-production, and `GRPC_VERBOSITY=debug GRPC_TRACE=http` for connection issues; remember an HTTP/1.1-only proxy in the path will silently break it. SOAP: capture the envelope, validate against the XSD, and check WS-Security timestamps — clock skew is a classic cause of intermittent auth failures.

### Monitoring

Normalise across styles so one dashboard works: request rate, error rate, and latency histograms keyed by **operation** (REST route template, GraphQL operation name, gRPC full method, SOAP action). GraphQL additionally needs `errors[]` rate, per-field resolver latency, query complexity distribution and per-field usage (the input to safe deprecation). gRPC needs status-code distribution, `DEADLINE_EXCEEDED` rate, connection and `GOAWAY` counts, and per-channel load balancing health. Propagate `traceparent` across every hop including the SOAP adapter.

### Security

REST inherits HTTP's security ecosystem — WAFs, standard auth, `Authorization` headers, TLS everywhere — and the OWASP API Top 10 applies directly. GraphQL adds a distinct attack surface: **introspection should be disabled in production**, queries must be depth- and complexity-limited, batched queries can amplify attacks, and field-level authorization must be enforced in resolvers because clients can traverse the graph in ways you did not anticipate. gRPC should use mTLS between services and per-method authorization; do not rely on network position. SOAP's WS-Security with XML signatures brings the XML attack surface with it — disable external entity resolution (XXE) and validate against a schema.

### Performance & scaling

Scale REST with CDN caching and stateless replicas. Scale GraphQL by caching at the client (normalised store), enabling persisted queries over `GET` so a CDN can help, adding per-field caching hints, and batching downstream calls; the aggregation layer becomes a capacity-planning subject of its own. Scale gRPC with connection pooling, client-side load balancing (or a service mesh), and streaming instead of polling; watch that a single HTTP/2 connection is one failure domain, so configure `MAX_CONNECTION_AGE` to force periodic rebalancing. Isolate the SOAP leg behind a bulkhead and a circuit breaker so a slow partner cannot consume your whole thread pool.

## 9. Interview Questions

**Q: What is the fundamental difference between REST and GraphQL?**
A: REST exposes many resource URIs whose response shape the server controls; GraphQL exposes one endpoint where the client authors the shape against a typed schema. The consequence is that REST responses are cacheable by URI and visible to every HTTP intermediary, while GraphQL eliminates over- and under-fetching but must rebuild caching, rate limiting and error visibility inside the application.

**Q: When would you choose gRPC over REST?**
A: For internal service-to-service traffic where you control both ends and want generated typed stubs, small binary payloads, streaming, and deadline propagation — typically high-volume, latency-sensitive paths. I would not choose it for public APIs, because browsers cannot speak it natively and third-party developers expect something they can `curl`.

**Q: Why is caching hard in GraphQL?**
A: Because requests are `POST`s with an arbitrary body, so the URI no longer identifies the response and HTTP caches cannot key on it. The mitigations are persisted queries sent as `GET` with a hash (restoring URI-based caching), `@cacheControl` hints with a GraphQL-aware CDN, and normalised client-side caches like Apollo or Relay that cache by entity rather than by request.

**Q: What is the N+1 problem in each style?**
A: In REST it is client-side: fetch a list, then one request per item, multiplying network latency. In GraphQL it moves server-side: a nested field resolves once per parent, generating one database or downstream call each, which is why DataLoader-style per-tick batching is mandatory. gRPC does not solve it either — you design batch methods like `BatchGetSkus` explicitly.

**Q: Why does GraphQL return `200 OK` on errors, and what does that cost you?**
A: The spec treats the HTTP layer as transport and reports execution errors in an `errors` array so partial results can be returned alongside them. The cost is operational: load balancers, CDNs, generic retry logic and HTTP-level dashboards all see success, so you must instrument at the operation and resolver level and alert on error-array rate rather than status codes.

**Q: Is SOAP ever the right choice today?**
A: When a counterparty mandates it — banking and payments (ISO 20022), insurance, healthcare, telecom OSS/BSS, and government systems — or when you genuinely need WS-Security message-level signing/encryption that survives multiple intermediaries rather than point-to-point TLS. For a greenfield public API it is the wrong choice on verbosity, cacheability and developer experience.

**Q: How do error semantics compare across the four?**
A: REST uses HTTP status codes, understood by every intermediary. gRPC has its own 17-code status space carried in trailers plus rich error details and first-class deadlines. GraphQL uses `200` with an `errors` array and an `extensions.code` convention. SOAP wraps failures in `<soap:Fault>` with fault codes. Only REST and gRPC give generic infrastructure enough information to retry or route correctly without application knowledge.

**Q: What is a BFF and when is it better than GraphQL?**
A: A Backend for Frontend is a thin per-client aggregation service exposing screen-shaped endpoints over the underlying domain APIs. It is better when only a handful of screens are chatty, when you have one or two client types, or when the team cannot absorb the operational cost of a GraphQL platform — you get the round-trip reduction without giving up HTTP caching or status-code semantics.

**Q: (Senior) Your mobile team wants GraphQL because "REST is too chatty". How do you evaluate that?**
A: I would first quantify it: how many calls per screen, what fraction of transferred bytes are unused, and what the p95 latency contribution actually is. Often the true fix is cheaper — expansion parameters, one aggregate endpoint, or fixing missing caching. I would adopt GraphQL when the chattiness is systemic across many screens with fast-moving UI requirements and multiple client types, and only with a plan for complexity limits, persisted queries, resolver-level observability and field-level authorization — because those are the real costs.

**Q: (Senior) How would you migrate a large REST API to gRPC internally without a big-bang rewrite?**
A: Strangler pattern, service by service. Define `.proto` contracts for the highest-traffic internal call paths, run gRPC alongside the existing REST endpoints (gRPC-Gateway can serve both from one implementation), migrate callers behind a feature flag with dual-path metrics, and only remove the REST path when traffic reaches zero. Keep external and browser-facing surfaces on REST throughout, and standardise deadline propagation and status-code mapping early so the mixed period is observable.

**Q: (Senior) What are the security implications of enabling GraphQL introspection in production?**
A: Introspection publishes your entire schema — every type, field, deprecated remnant and internal-sounding mutation — which is a map for an attacker and often leaks internal domain structure and unreleased features. Combined with unlimited query depth and batching it also enables cheap resource-exhaustion attacks. In production, disable introspection, require persisted queries, enforce depth and complexity limits, and treat every resolver as an authorization boundary rather than relying on the entry point.

**Q: (Senior) How do you keep four API styles from becoming four operational silos?**
A: Standardise the cross-cutting concerns and let the styles differ only in shape. One identity and token model, one trace context propagated everywhere, one error taxonomy with explicit mappings (`4xx/5xx` ↔ gRPC codes ↔ `errors[].extensions.code` ↔ `soap:Fault`), one metrics naming convention keyed on operation, and one schema registry/CI gate that fails a build on a breaking contract change regardless of IDL. Then publish a written decision rule for which style a new service uses, so the choice is made once rather than in every design review.

## 10. Quick Revision & Cheat Sheet

**One-Minute Revision.** Four styles, one axis: who shapes the response. **REST** — server-shaped resources over HTTP; wins on ubiquity, caching and intermediary support; loses on over/under-fetching. **GraphQL** — client-shaped queries against a typed schema through one endpoint; wins on round trips and precision; loses HTTP caching and status-code visibility, and needs depth limits, DataLoader batching and persisted queries to be safe. **gRPC** — protobuf over HTTP/2 with generated stubs, streaming, deadlines and rich status codes; ideal internally, unsuitable for browsers and third parties without a proxy. **SOAP** — XML envelopes with WSDL contracts and WS-Security; choose it only when a counterparty requires it. Default architecture: REST at the public edge, gRPC between internal services, GraphQL or a BFF for client aggregation, SOAP adapters isolated behind bulkheads.

| Question | Answer |
|---|---|
| Public/partner API | **REST** (ubiquity, caching, `curl`-ability) |
| Internal service-to-service, latency-sensitive | **gRPC** (binary, HTTP/2, deadlines, streaming) |
| Many diverse UI clients, chatty screens | **GraphQL** or a **BFF** |
| Counterparty mandates it / WS-Security | **SOAP** |
| Best HTTP caching | REST (URI + `ETag` + `Cache-Control`) |
| Smallest payloads | gRPC (protobuf) |
| Compile-time contract | gRPC (`.proto`), SOAP (WSDL) |
| Runtime-validated schema | GraphQL (SDL), REST (OpenAPI + contract tests) |
| Errors | REST: status codes · gRPC: 17 status codes in trailers · GraphQL: `200` + `errors[]` · SOAP: `soap:Fault` |
| Streaming | gRPC native · REST via SSE/chunked · GraphQL subscriptions |
| Mandatory GraphQL hardening | depth + complexity limits, persisted queries, introspection off, resolver-level authz |
| Mandatory gRPC hygiene | deadlines everywhere, never reuse field tags, mTLS between services |

**Flash cards**
- **One-line difference REST vs GraphQL** → REST: server shapes the response, cacheable by URI. GraphQL: client shapes it, one endpoint, no HTTP caching.
- **Why not gRPC for public APIs?** → Browsers cannot speak it natively, payloads are binary and undebuggable by third parties, and proxies must support HTTP/2 end to end.
- **GraphQL's biggest operational trap** → `200 OK` with an `errors` array, so HTTP dashboards and generic retry logic go blind.
- **What fixes GraphQL's server-side N+1?** → DataLoader-style per-tick batching plus batch methods on downstream services.
- **When is SOAP correct?** → When a regulated counterparty mandates WSDL/WS-Security; essentially never for a new public API.

## 11. Hands-On Exercises & Mini Project

- [ ] Take one screen of an app you know and count the REST calls and unused bytes needed to render it. Then write the equivalent GraphQL query and compare payload sizes and round trips honestly.
- [ ] Stand up a GraphQL server with no depth limit and write a recursive query (`user { orders { user { orders { ... } } } }`) that takes it down. Then add depth and complexity limits and re-run.
- [ ] Define a `.proto`, generate stubs in two languages, and call the service from both. Then add a field with a new tag number and prove old clients still work; then reuse a tag number and observe the corruption.
- [ ] Instrument a GraphQL endpoint so an `errors[]`-only response is visible on a dashboard, and demonstrate that a status-code-only dashboard shows 100% success during a total resolver failure.
- [ ] Benchmark REST/JSON versus gRPC for the same 2 KB payload at 1,000 rps within a datacenter, then across the public internet, and explain the difference in the results.

### Mini Project — "One Domain, Three Surfaces"

**Goal.** Implement a single `catalog` domain behind three API surfaces and produce a written decision record backed by measurements.

**Requirements.**
1. Core service with products, categories and inventory, exposed as: a REST API (Level 2, `ETag` + `Cache-Control`), a gRPC service (unary plus one server-streaming method), and a GraphQL schema with DataLoader batching.
2. A single client scenario — "category page with 20 products and stock levels" — implemented against all three.
3. Measure for each: total bytes, round trips, cold and warm p50/p95/p99 latency, and origin requests with a CDN in front.
4. Break each one deliberately: remove a REST field, renumber a proto tag, delete a GraphQL field — and document what each client experiences.
5. Produce a one-page ADR recommending which surface serves which consumer, with the numbers as evidence.

**Extensions.**
- Add persisted queries to the GraphQL surface, serve them over `GET`, and measure the CDN hit rate you recover.
- Put gRPC behind gRPC-Web/Connect and call it from a browser; record what the proxy costs you.
- Add a mock SOAP partner endpoint with WS-Security and wrap it in an anti-corruption layer with a circuit breaker; simulate a 10-second partner stall and show your API still responds.
- Wire all three surfaces to one OpenTelemetry pipeline and build a single dashboard keyed on operation name.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is an API? Web APIs & Clients* (the contract mindset all four styles share), *HTTP Fundamentals for API Builders* (the transport underneath REST, GraphQL and gRPC), *What Is REST? Constraints & Maturity* (what REST actually promises), *Resource Modeling & URI Design* (doing REST well enough that GraphQL is not needed), *HTTP Methods, Safety & Idempotency* (the retry semantics GraphQL and SOAP give up).

- **GraphQL — Official Learn Guide** — GraphQL Foundation · *Beginner* · schema design, resolvers, pagination and the reasoning behind the query language, from the source. <https://graphql.org/learn/>
- **gRPC Documentation — Core Concepts & Guides** — CNCF/gRPC · *Intermediate* · streaming modes, deadlines, status codes, load balancing and interceptors, with runnable examples in ten languages. <https://grpc.io/docs/what-is-grpc/core-concepts/>
- **Protocol Buffers — Language Guide (proto3)** — Google · *Intermediate* · field numbering rules, reserved tags, and the exact schema-evolution guarantees that make or break a gRPC migration. <https://protobuf.dev/programming-guides/proto3/>
- **Google API Design Guide** — Google · *Intermediate* · written by a company running REST and gRPC from one resource model; the sections on standard methods and custom methods apply to both. <https://cloud.google.com/apis/design>
- **OWASP GraphQL Cheat Sheet** — OWASP · *Intermediate* · introspection, query depth/complexity, batching attacks and authorization patterns; the checklist before any GraphQL production launch. <https://cheatsheetseries.owasp.org/cheatsheets/GraphQL_Cheat_Sheet.html>
- **Principled GraphQL** — Apollo · *Intermediate* · ten operating principles covering schema ownership, incremental delivery, persisted queries and field-level deprecation with usage data. <https://principledgraphql.com/>
- **Microservices — Backends For Frontends** — Sam Newman · *Intermediate* · the pattern that solves most "REST is too chatty" complaints without adopting a new query language. <https://samnewman.io/patterns/architectural/bff/>
- **SOAP Version 1.2 Primer** — W3C · *Intermediate* · the authoritative introduction to envelopes, faults and the WS-\* model; read it when you must integrate with an enterprise counterparty. <https://www.w3.org/TR/soap12-part0/>

---

*REST API Handbook — chapter 04.*
