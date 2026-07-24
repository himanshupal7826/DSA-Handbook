# 04 · gRPC vs REST, GraphQL & Message Queues

> **In one line:** gRPC wins east–west traffic between your own services, REST wins public and browser-facing APIs, GraphQL wins client-driven aggregation over many entities, and a message queue wins whenever the caller should not be waiting at all — most real systems use three of the four.

---

## 1. Overview

The question "should we use gRPC?" is almost never answered by benchmarks, because the benchmarks mostly agree: gRPC is faster than JSON/HTTP for the same workload. The question is answered by **who the consumer is, what the call shape is, and what the operational ecosystem already supports**. A protocol that is 5× faster and 10× harder for your partners to integrate against is a bad trade at the edge and a good trade in the mesh.

This chapter gives you the comparison in the form you actually need it: a decision procedure, honest numbers with their caveats, and the specific objections you will hear in a design review — plus what to say to each. It deliberately includes the cases where gRPC is the wrong answer, because an architect who only advocates loses credibility fast.

The four contenders are not really peers. **REST over HTTP/JSON** is a resource-oriented architectural style with the entire web's tooling behind it. **gRPC** is a contract-first, procedure-oriented RPC framework optimised for machine-to-machine traffic. **GraphQL** is a query language that lets the *client* specify the shape of the response, solving over-fetching for rich UIs. **Message queues** (Kafka, NATS, RabbitMQ, SQS) are not request/response at all — they decouple producer from consumer in time. Choosing well means recognising which problem you actually have.

## 2. Core Concepts

- **North–south traffic** — calls crossing your system's boundary: browsers, mobile apps, partners. Optimised for compatibility, debuggability and long-lived stability.
- **East–west traffic** — calls between your own services inside a trust boundary. Optimised for latency, throughput and contract safety.
- **Over-fetching / under-fetching** — a client receiving more data than it needs, or needing several round trips to assemble a view. GraphQL's founding motivation.
- **Chatty vs chunky** — many small calls versus few large ones. Network protocols reward chunky; domain modelling often produces chatty.
- **Schema-first vs schema-less** — whether the interface is a compiled artefact (protobuf, GraphQL SDL, OpenAPI) or a convention.
- **Uniform interface** — REST's constraint that all resources are manipulated with the same small verb set, which is what makes generic caches and proxies possible.
- **Backpressure** — the consumer's ability to slow the producer. Native in gRPC streams (HTTP/2 flow control) and in queues (consumer lag); absent in plain request/response.
- **Temporal coupling** — whether both parties must be available simultaneously. Request/response requires it; queues remove it.
- **gRPC-Web / Connect** — protocols that make gRPC-shaped APIs reachable from browsers, at the cost of full bidirectional streaming.

## 3. Theory & Principles

### The performance gap, honestly

Published benchmarks typically show gRPC at **2–10× the throughput** of JSON/REST for small messages and **20–50% lower p99 latency** at high concurrency. Those numbers are real but they decompose into three separate effects, and knowing which applies to you matters more than the headline:

1. **Serialisation cost** (usually the largest). Protobuf marshal/unmarshal in Go is commonly 5–20× cheaper than `encoding/json`, and allocates far less, which also reduces GC pressure. This dominates when messages are small and QPS is high.
2. **Payload size.** 3–10× smaller means less bandwidth, fewer packets and lower TLS encryption cost. This dominates on constrained or metered links, and on very large messages.
3. **Connection behaviour.** One multiplexed HTTP/2 connection versus a pool avoids handshakes and keeps a single congestion window warm. This dominates at high concurrency and on high-latency links.

Where the gap **narrows or vanishes**: when the payload is dominated by one large opaque blob (both formats just move bytes); when the server spends 50 ms in a database (serialisation is noise); when the client is a browser (you are paying for a proxy anyway); and when your JSON stack is already HTTP/2 with a fast library. Anyone quoting "gRPC is 7× faster" without saying *at what message size and concurrency* is quoting folklore.

### The decision procedure

Ask these in order and stop at the first decisive answer:

1. **Does the caller need a response to continue?** No → use a queue or event stream. This is the single most commonly skipped question, and it is the one that eliminates the most latency.
2. **Is the consumer a browser, a partner, or the general public?** Yes → REST/JSON (or GraphQL for rich UIs), possibly with gRPC behind a gateway. Codegen dependencies and opaque payloads are a tax on people you cannot train.
3. **Is the consumer one of your own services, in your own network, in a language you control?** Yes → gRPC is the default. Contract safety and latency both favour it.
4. **Does one client need to assemble a view from many entities with client-specific shapes?** Yes → GraphQL at the edge, usually with gRPC or REST behind it.
5. **Is the data continuous, or is one side pushing to the other?** Yes → gRPC streaming, or a queue if durability and replay matter.
6. **Do you need HTTP caching, CDNs, browser devtools or curl to work out of the box?** Yes → REST.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="d1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#64748b"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Which protocol? A decision procedure</text>

  <rect x="300" y="40" width="280" height="42" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="66" text-anchor="middle" fill="#334155" font-weight="bold">Does the caller need a response now?</text>

  <path d="M300,61 L180,61 L180,96" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#d1)"/>
  <text x="232" y="55" fill="#64748b">no</text>
  <rect x="40" y="100" width="280" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="180" y="120" text-anchor="middle" fill="#92400e" font-weight="bold">Message queue / event stream</text>
  <text x="180" y="138" text-anchor="middle" fill="#b45309" font-size="10">Kafka, NATS, SQS &#183; decoupled in time, replayable</text>

  <path d="M440,82 L440,116" stroke="#64748b" stroke-width="2" marker-end="url(#d1)"/>
  <text x="452" y="104" fill="#64748b">yes</text>
  <rect x="300" y="120" width="280" height="42" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="146" text-anchor="middle" fill="#334155" font-weight="bold">Is the consumer a browser or partner?</text>

  <path d="M580,141 L700,141 L700,176" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#d1)"/>
  <text x="636" y="135" fill="#64748b">yes</text>
  <rect x="560" y="180" width="300" height="76" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="710" y="200" text-anchor="middle" fill="#1e40af" font-weight="bold">REST / JSON &#183; or GraphQL for rich UIs</text>
  <text x="710" y="218" text-anchor="middle" fill="#1d4ed8" font-size="10">curl-able &#183; cacheable &#183; no codegen for consumers</text>
  <text x="710" y="236" text-anchor="middle" fill="#1d4ed8" font-size="10">put gRPC behind it via grpc-gateway or Connect</text>

  <path d="M440,162 L440,196" stroke="#64748b" stroke-width="2" marker-end="url(#d1)"/>
  <text x="452" y="184" fill="#64748b">no</text>
  <rect x="300" y="200" width="280" height="42" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="226" text-anchor="middle" fill="#334155" font-weight="bold">Continuous data or server push?</text>

  <path d="M300,221 L180,221 L180,256" stroke="#64748b" stroke-width="2" fill="none" marker-end="url(#d1)"/>
  <text x="232" y="215" fill="#64748b">yes</text>
  <rect x="40" y="260" width="280" height="60" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="180" y="282" text-anchor="middle" fill="#5b21b6" font-weight="bold">gRPC streaming</text>
  <text x="180" y="302" text-anchor="middle" fill="#6d28d9" font-size="10">server / client / bidi &#183; flow-controlled backpressure</text>

  <path d="M440,242 L440,276" stroke="#64748b" stroke-width="2" marker-end="url(#d1)"/>
  <text x="452" y="264" fill="#64748b">no</text>
  <rect x="300" y="280" width="280" height="76" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="302" text-anchor="middle" fill="#15803d" font-weight="bold">gRPC unary</text>
  <text x="440" y="320" text-anchor="middle" fill="#166534" font-size="10">internal east&#8211;west &#183; contract enforced at compile time</text>
  <text x="440" y="338" text-anchor="middle" fill="#166534" font-size="10">deadline propagation &#183; standard status codes</text>

  <rect x="40" y="374" width="820" height="80" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="450" y="396" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Override the flow when&#8230;</text>
  <text x="58" y="418" fill="#475569">&#8226; you need HTTP caching, CDNs or browser devtools &#8594; REST, regardless of who calls it</text>
  <text x="58" y="436" fill="#475569">&#8226; one client assembles many entities with client-specific shapes &#8594; GraphQL at the edge, gRPC behind it</text>
</svg>
```

### What each protocol is actually optimising for

- **REST** optimises for **evolvability and ubiquity**. Its uniform interface is what lets a CDN, a proxy, a browser and a curl command all understand your traffic without knowing your domain. That generality is the whole product; performance was never the point.
- **gRPC** optimises for **contract safety and machine efficiency**. It assumes both ends are programs you control and can regenerate.
- **GraphQL** optimises for **client autonomy**. One endpoint, a typed schema, and the client declares its needs — which is transformative for a mobile team shipping faster than the backend team, and a liability when it lets clients issue arbitrarily expensive queries.
- **Queues** optimise for **decoupling and durability**. They remove temporal coupling entirely and buy you replay, buffering and fan-out — at the cost of eventual consistency and much harder debugging.

## 4. Architecture & Workflow

Most mature systems are not "a gRPC shop" or "a REST shop". The standard layered shape:

1. **Edge (north–south).** REST/JSON or GraphQL, behind an API gateway that terminates TLS, authenticates, rate-limits and emits metrics. Consumers are browsers, mobile apps and partners; the contract is OpenAPI or GraphQL SDL, versioned conservatively.
2. **Translation layer.** Either a `grpc-gateway` generated from the same `.proto` (so the JSON facade cannot drift from the gRPC service), or `connect-go` which serves gRPC, gRPC-Web and a JSON/HTTP variant from one handler.
3. **Service mesh (east–west).** gRPC everywhere, with mTLS, deadline propagation, standardised status codes and client-side load balancing.
4. **Asynchronous spine.** A queue or log for anything that does not need a synchronous answer: notifications, analytics, search indexing, downstream projections, long-running work.

The most valuable single decision in this layout is **step 2**: generating the JSON edge from the same `.proto` that defines the gRPC service. It removes the largest failure mode of "gRPC internally, REST externally" — two hand-maintained contracts that drift.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="e1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="e2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
    <marker id="e3" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#d97706"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The layered reality: all four, each where it fits</text>

  <rect x="30" y="46" width="180" height="90" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="120" y="70" text-anchor="middle" fill="#1e40af" font-weight="bold">Browser SPA</text>
  <text x="120" y="90" text-anchor="middle" fill="#1d4ed8" font-size="10">Mobile app</text>
  <text x="120" y="110" text-anchor="middle" fill="#1d4ed8" font-size="10">Partner integration</text>
  <text x="120" y="128" text-anchor="middle" fill="#64748b" font-size="10">north&#8211;south</text>

  <path d="M212,91 L296,91" stroke="#2563eb" stroke-width="2" marker-end="url(#e1)"/>
  <text x="254" y="84" text-anchor="middle" fill="#1e40af" font-size="10">REST/JSON</text>

  <rect x="300" y="46" width="200" height="90" rx="10" fill="#eff6ff" stroke="#3b82f6" stroke-width="2"/>
  <text x="400" y="70" text-anchor="middle" fill="#1e40af" font-weight="bold">Gateway / BFF</text>
  <text x="400" y="90" text-anchor="middle" fill="#1d4ed8" font-size="10">grpc-gateway or connect-go</text>
  <text x="400" y="108" text-anchor="middle" fill="#1d4ed8" font-size="10">generated from the SAME .proto</text>
  <text x="400" y="126" text-anchor="middle" fill="#64748b" font-size="10">TLS &#183; authn &#183; rate limit</text>

  <path d="M502,91 L586,91" stroke="#16a34a" stroke-width="2" marker-end="url(#e2)"/>
  <text x="544" y="84" text-anchor="middle" fill="#15803d" font-size="10">gRPC</text>

  <rect x="590" y="46" width="260" height="90" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="720" y="70" text-anchor="middle" fill="#15803d" font-weight="bold">Service mesh (east&#8211;west)</text>
  <text x="720" y="90" text-anchor="middle" fill="#166534" font-size="10">orders &#8594; inventory &#8594; pricing &#8594; ledger</text>
  <text x="720" y="108" text-anchor="middle" fill="#166534" font-size="10">mTLS &#183; deadline propagation &#183; codes.Code</text>
  <text x="720" y="126" text-anchor="middle" fill="#166534" font-size="10">client-side round_robin load balancing</text>

  <path d="M720,138 L720,196" stroke="#d97706" stroke-width="2" marker-end="url(#e3)"/>
  <text x="790" y="170" fill="#92400e" font-size="10">publish events</text>

  <rect x="470" y="200" width="380" height="80" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="660" y="224" text-anchor="middle" fill="#92400e" font-weight="bold">Asynchronous spine (Kafka / NATS / SQS)</text>
  <text x="660" y="244" text-anchor="middle" fill="#b45309" font-size="10">OrderPlaced &#183; StockReserved &#183; InvoiceIssued</text>
  <text x="660" y="262" text-anchor="middle" fill="#b45309" font-size="10">no temporal coupling &#183; replayable &#183; fan-out</text>

  <path d="M470,240 L340,240" stroke="#d97706" stroke-width="2" marker-end="url(#e3)"/>
  <rect x="80" y="200" width="256" height="80" rx="10" fill="#fffbeb" stroke="#f59e0b" stroke-width="2"/>
  <text x="208" y="224" text-anchor="middle" fill="#92400e" font-weight="bold">Consumers</text>
  <text x="208" y="244" text-anchor="middle" fill="#b45309" font-size="10">search indexer &#183; analytics &#183; notifications</text>
  <text x="208" y="262" text-anchor="middle" fill="#b45309" font-size="10">the caller never waited for any of this</text>

  <rect x="30" y="300" width="820" height="64" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="322" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The one decision that matters most</text>
  <text x="440" y="344" text-anchor="middle" fill="#475569">Generate the JSON edge from the same .proto as the gRPC service &#8212; two hand-written contracts always drift.</text>
</svg>
```

## 5. Implementation

Serving gRPC and JSON from one contract is the practical resolution of this whole chapter. Two production options.

**Option A — `grpc-gateway`:** annotate the `.proto` with HTTP mappings and generate a reverse proxy.

```protobuf
syntax = "proto3";
package inventory.v1;

import "google/api/annotations.proto";

option go_package = "github.com/example/inventory/gen/inventory/v1;inventoryv1";

service InventoryService {
  rpc GetItem(GetItemRequest) returns (GetItemResponse) {
    // Generates GET /v1/items/{sku} on the JSON facade.
    option (google.api.http) = {get: "/v1/items/{sku}"};
  }

  rpc UpdateItem(UpdateItemRequest) returns (Item) {
    option (google.api.http) = {
      patch: "/v1/items/{item.sku}"
      body: "item"
    };
  }
}

message GetItemRequest { string sku = 1; }
message GetItemResponse { Item item = 1; }
message UpdateItemRequest { Item item = 1; }
message Item {
  string sku = 1;
  string name = 2;
  int32 quantity_on_hand = 3;
}
```

```go
package main

import (
	"context"
	"log"
	"net"
	"net/http"

	"github.com/grpc-ecosystem/grpc-gateway/v2/runtime"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"

	inventoryv1 "github.com/example/inventory/gen/inventory/v1"
)

func main() {
	// --- 1. The real gRPC server, for east-west traffic -------------------
	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		log.Fatal(err)
	}
	grpcSrv := grpc.NewServer()
	inventoryv1.RegisterInventoryServiceServer(grpcSrv, newInventoryServer())
	go func() {
		if err := grpcSrv.Serve(lis); err != nil {
			log.Fatalf("grpc serve: %v", err)
		}
	}()

	// --- 2. The JSON facade, generated from the SAME .proto ---------------
	// The gateway is a normal http.Handler that translates JSON+REST into
	// gRPC calls against the server above. Because both come from one
	// contract, they cannot drift.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	mux := runtime.NewServeMux(
		// Emit fields with default values so JSON consumers see a stable shape;
		// protobuf would otherwise omit zero values entirely.
		runtime.WithMarshalerOption(runtime.MIMEWildcard, &runtime.JSONPb{
			MarshalOptions: protojson.MarshalOptions{
				EmitUnpopulated: true,
				UseProtoNames:   true, // snake_case, matching the .proto
			},
		}),
	)

	if err := inventoryv1.RegisterInventoryServiceHandlerFromEndpoint(
		ctx, mux, "localhost:50051",
		[]grpc.DialOption{grpc.WithTransportCredentials(insecure.NewCredentials())},
	); err != nil {
		log.Fatalf("register gateway: %v", err)
	}

	log.Println("gRPC on :50051, JSON/REST on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
```

Now `curl localhost:8080/v1/items/sku_1` and a Go gRPC client hit the same handler with the same validation, authorization and business logic.

**Option B — `connect-go`:** one handler serving three protocols, no proxy.

```go
package main

import (
	"log"
	"net/http"

	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	inventoryv1connect "github.com/example/inventory/gen/inventory/v1/inventoryv1connect"
)

func main() {
	mux := http.NewServeMux()

	// One registration serves all three wire protocols on the same port:
	//   - gRPC          (HTTP/2, binary protobuf, trailers)  -> internal services
	//   - gRPC-Web      (browser-compatible framing)         -> SPAs, no proxy
	//   - Connect       (plain HTTP/1.1 + JSON or protobuf)  -> curl, partners
	path, handler := inventoryv1connect.NewInventoryServiceHandler(newInventoryServer())
	mux.Handle(path, handler)

	// h2c allows cleartext HTTP/2 so gRPC works without TLS in local dev and
	// behind a mesh sidecar that already terminates TLS.
	srv := &http.Server{
		Addr:    ":8080",
		Handler: h2c.NewHandler(mux, &http2.Server{}),
	}

	log.Println("gRPC + gRPC-Web + Connect/JSON all on :8080")
	log.Fatal(srv.ListenAndServe())
}
```

```bash
# The same method, three ways:
grpcurl -plaintext -d '{"sku":"sku_1"}' localhost:8080 inventory.v1.InventoryService/GetItem
curl -X POST localhost:8080/inventory.v1.InventoryService/GetItem \
     -H 'Content-Type: application/json' -d '{"sku":"sku_1"}'
```

## 6. Advantages, Disadvantages & Trade-offs

| Dimension | gRPC | REST/JSON | GraphQL | Queue |
|---|---|---|---|---|
| Payload size | Smallest (binary) | Largest (text) | Large (JSON) | Depends on codec |
| CPU per message | Lowest | Highest | High (+ planning) | Codec-dependent |
| Browser support | Needs gRPC-Web/Connect + proxy | Native | Native | No |
| Human debuggability | Poor (needs tooling) | Excellent | Good (introspection) | Poor |
| Contract enforcement | Compile-time, strong | Optional (OpenAPI) | Compile-time, strong | Usually schema registry |
| Streaming | Native, 4 shapes | SSE / WebSocket bolt-on | Subscriptions | Native (it is the model) |
| HTTP caching / CDN | None | Excellent | Poor (POST by default) | N/A |
| Load balancing | Needs L7 or client-side | Trivial (L4 works) | Same as REST | Broker's problem |
| Backpressure | HTTP/2 flow control | None | None | Consumer lag |
| Temporal coupling | Required | Required | Required | None |
| Learning curve | Medium (codegen, tooling) | Low | Medium-high | High (ops) |
| Best fit | Internal service-to-service | Public / browser APIs | Rich client aggregation | Async, fan-out, durable work |

**Trade-offs worth stating explicitly**
- *gRPC's contract safety costs build ceremony.* Every consumer needs a toolchain. That is cheap inside one org and expensive across org boundaries.
- *REST's ubiquity costs performance and type safety.* You will hand-write clients and discover mismatches in production.
- *GraphQL's client autonomy costs server predictability.* Without query depth limits, complexity budgets and persisted queries, a client can trivially DoS you.
- *Queues' decoupling costs consistency and debuggability.* You trade a stack trace for a distributed trace and eventual consistency.

## 7. Common Mistakes & Best Practices

- **Choosing gRPC for a public partner API.** Partners want curl, Postman and a JSON body they can paste into a ticket. Put a generated JSON facade in front.
- **Choosing REST for a hot internal fan-out path.** If service A calls B, C and D on every request at 50k QPS, serialisation and connection overhead are a real budget line.
- **Using GraphQL as the internal transport.** It solves a client-shape problem you do not have between services, and adds query planning cost to every hop.
- **Using synchronous RPC where a queue belongs.** "Send the confirmation email" should never be in the caller's latency budget or failure domain.
- **Maintaining two hand-written contracts** for the gRPC service and its JSON facade. Generate one from the other, always.
- **Benchmarking without matching conditions.** Comparing gRPC on HTTP/2 against JSON on HTTP/1.1 with a cold connection pool proves nothing.
- **Assuming gRPC removes the need for API design.** Bad method granularity, missing pagination and leaky error models hurt just as much in protobuf as in JSON.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Standardise on `grpcurl` plus reflection for gRPC, and keep a JSON facade available in non-production environments so anyone can curl a service without a toolchain. Log the canonical `protojson` form of failing requests, with redaction.
- **Monitoring.** Use one vocabulary across protocols: emit a `code` label that is a gRPC status name for gRPC and a mapped equivalent for HTTP, so dashboards and alerts are protocol-agnostic. Mixed-protocol systems where REST reports `5xx` and gRPC reports `Internal` produce two half-blind dashboards.
- **Security.** REST inherits the web's security tooling — WAFs, CORS, browser policies. gRPC inherits almost none of it, so you own authentication, rate limiting and payload limits in interceptors. mTLS between services is significantly easier with gRPC than with a mixed HTTP estate.
- **Scaling.** The operational difference that bites hardest is load balancing: REST/HTTP1.1 balances beautifully at L4, gRPC does not (chapter 29). Budget for an L7 proxy, a mesh, or client-side load balancing *before* you migrate, not after.

## 9. Interview Questions

**Q: When would you choose gRPC over REST?**
A: For east–west traffic between services I control, especially when the call graph is hot, the payloads are structured, the teams are polyglot, or I need streaming. The decisive benefits are compile-time contract enforcement across languages, cheap serialisation, deadline propagation and a standard status-code vocabulary. I would not choose it at the edge, for browsers without a proxy layer, or where HTTP caching and generic web tooling are load-bearing.

**Q: How much faster is gRPC than REST, really?**
A: Typically 2–10× throughput and materially lower p99 at high concurrency, but the number is meaningless without conditions. The gain decomposes into serialisation cost (usually dominant for small messages), payload size, and connection reuse. It shrinks toward zero when the server is I/O-bound, when payloads are single large blobs, or when the REST stack is already HTTP/2 with a fast JSON library. I would always ask "at what message size and concurrency?" before accepting a benchmark.

**Q: Why can't a browser call gRPC directly?**
A: Browsers expose fetch and XHR, neither of which gives JavaScript access to HTTP/2 trailers or control over framing — and gRPC puts its terminal status in trailers. The workarounds are gRPC-Web, which encodes trailers into the response body and needs a translating proxy such as Envoy's gRPC-Web filter; Connect, which defines a gRPC-compatible protocol that also works over HTTP/1.1 and JSON; or a generated JSON gateway. gRPC-Web also cannot do client-side or bidirectional streaming.

**Q: What problem does GraphQL solve that gRPC does not?**
A: Client-driven response shaping. A mobile screen needing fields from six entities can express that as one query and receive exactly those fields, without the backend shipping a bespoke endpoint. gRPC's answer to over-fetching is `FieldMask` or purpose-built methods, both of which require a server change. The cost is that clients can issue arbitrarily expensive queries, so you need depth limits, complexity budgets and persisted queries — and GraphQL adds planning cost per request, which is why it belongs at the edge rather than between services.

**Q: When is a message queue the right answer instead of any RPC?**
A: Whenever the caller does not need the result to proceed, whenever the work must survive the consumer being down, whenever several independent consumers need the same event, and whenever you need replay. "Send an email", "update the search index", "emit analytics" and "start a long-running job" all belong on a queue. Putting them in the request path couples your latency and availability to systems that have no business affecting them.

**Q: Can you run gRPC and REST from one codebase without maintaining two contracts?**
A: Yes, and you should. Either annotate the `.proto` with `google.api.http` options and generate a `grpc-gateway` reverse proxy that translates JSON/REST into gRPC calls against the same handlers, or use `connect-go`, where a single handler registration serves gRPC, gRPC-Web and a plain HTTP/JSON protocol on one port. Both eliminate the real failure mode, which is two hand-written contracts drifting apart.

**Q: What do you lose by adopting gRPC that teams underestimate?**
A: HTTP caching and the entire ecosystem built on it; the ability to debug by reading traffic; L4 load balancing, because one long-lived HTTP/2 connection pins to a backend; and low-friction onboarding for consumers who now need a codegen toolchain. Teams also underestimate the operational work of running a schema registry or monorepo discipline so that `.proto` changes are reviewed and breaking changes are caught in CI.

**Q: How do you compare error handling across these protocols?**
A: gRPC has a closed set of 17 status codes plus optional structured details, which makes cross-service retry and alerting policy uniform and machine-decidable. REST has HTTP status codes, which are coarser and frequently misused, though RFC 9457 problem details give you a good structured body. GraphQL notoriously returns `200 OK` with an `errors` array, so transport-level monitoring is blind to failures unless you instrument the resolver layer. Queues have no synchronous error path at all — failures become dead-letter queues and retry policies.

**Q: (Senior) A 40-service REST estate wants to migrate to gRPC. Design the migration.**
A: I would not migrate everything. First, measure: rank call graphs by QPS, p99 latency and payload size, and identify the top few paths where serialisation and connection overhead are a real budget line. Second, establish prerequisites before any migration — a `.proto` repository or monorepo with `buf lint` and `buf breaking` in CI, and a load-balancing story, because L4 balancing stops working the day you switch. Third, migrate the hottest internal path only, keeping the REST endpoint alive and dual-serving, and measure the actual delta. Fourth, keep the edge on JSON permanently, generated from the same `.proto` via grpc-gateway or Connect. Fifth, standardise observability so both protocols report a common `code` label. I would expect to end with a hybrid estate, not a pure one, and I would say so up front so nobody treats the remaining REST as unfinished work.

**Q: (Senior) A team proposes gRPC between services *and* GraphQL between services. Evaluate.**
A: gRPC between services is the right default. GraphQL between services is usually a mistake: it solves client-shape variability, which does not exist when the caller is a service you control and can regenerate, and it adds query parsing, validation and planning cost to every internal hop plus a resolver layer that obscures the actual call graph. The legitimate exception is a genuine aggregation tier — a BFF assembling data for a specific client — but that is an edge component, and it should call gRPC downstream. I would ask what problem they observed; if the answer is "different callers need different fields", the cheaper fix is `FieldMask` or a small number of purpose-built methods.

**Q: (Senior) How do you decide between gRPC streaming and a message queue for continuous data?**
A: The question is whether the consumer must be alive when the data is produced. gRPC streaming is a live, connection-bound transport with excellent backpressure and low latency, but no durability — if the consumer dies mid-stream, everything not yet delivered is gone, and reconnection means resuming from a client-tracked cursor you had to design. A queue or log gives you durability, replay, fan-out to multiple independent consumers and buffering across restarts, at the cost of higher end-to-end latency and much harder debugging. I use streaming for live telemetry, progress updates and interactive sessions where staleness is worse than loss, and a log for anything that must be processed exactly once, replayed, or consumed by more than one team.

**Q: (Senior) What single architectural decision most often goes wrong in gRPC adoption?**
A: Load balancing. Teams migrate a service, deploy behind a standard Kubernetes `Service`, and discover that traffic pins to whichever pods existed when clients connected — scaling up does nothing, and rolling deploys produce uneven load. The reason is structural: `kube-proxy` balances connections at L4, and gRPC opens exactly one long-lived HTTP/2 connection per target. The fixes are a headless service with client-side `round_robin`, an L7 proxy or mesh, or `MaxConnectionAge` to force periodic re-resolution — and all of them need to be in place before the migration, not diagnosed after the first traffic spike.

## 10. Quick Revision & Cheat Sheet

| If you need… | Choose |
|---|---|
| Internal service-to-service, hot path | gRPC unary |
| Live telemetry, progress, chat | gRPC streaming |
| Public / partner API | REST + OpenAPI (generated from `.proto`) |
| Browser client, no proxy | Connect, or gRPC-Web + proxy |
| Client-specific response shapes | GraphQL at the edge only |
| Fire-and-forget, fan-out, replay | Message queue / log |
| HTTP caching or CDN | REST — nothing else offers it |
| Strong cross-language contracts | gRPC or GraphQL |
| Zero codegen for consumers | REST |

**Flash cards**
- **First question in protocol choice?** → Does the caller need a response now? If no, use a queue.
- **gRPC's biggest edge?** → Compile-time contracts across languages, plus cheap serialisation and connection reuse.
- **gRPC's biggest cost?** → No browser support, no HTTP caching, and L4 load balancing stops working.
- **GraphQL's real problem solved?** → Client-driven shaping, not performance.
- **How to serve both gRPC and JSON?** → Generate the facade — `grpc-gateway` or `connect-go` — never hand-write two contracts.
- **Where does GraphQL belong?** → At the edge, calling gRPC downstream. Not between services.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement one endpoint three ways — REST/JSON, gRPC unary and Connect — and benchmark all three with 1 KiB and 512 KiB payloads at concurrency 1, 50 and 500. Chart where the curves cross.
- [ ] Take the same service and add a `grpc-gateway` facade. Verify that `curl` and `grpcurl` produce identical results, then break the `.proto` and confirm both break together.
- [ ] Write down your system's five hottest call paths and classify each with the §3 decision procedure. Note any where the current choice disagrees with the procedure and why.
- [ ] Deploy a gRPC service behind a standard Kubernetes `Service`, scale to five replicas, and observe request distribution. Then switch to a headless service with `round_robin` and observe again.
- [ ] Take one synchronous call in your system that does not affect the response and move it to a queue. Measure the p99 improvement.

### Mini Project — "Design: Protocol Selection Review"

**Goal.** Produce the artefact an architecture review actually wants: a defensible, measured protocol decision for a real system rather than a preference.

**Requirements.**
1. Pick a system with at least four services, one browser client and one partner integration. Draw the full call graph with QPS and p99 for each edge.
2. Classify every edge as north–south or east–west, and run each through the §3 decision procedure. Record the answer *and* the question that decided it.
3. For the two hottest east–west edges, prototype both REST and gRPC and measure throughput, p99 and CPU at realistic payload sizes and concurrency. Publish the numbers, not adjectives.
4. Design the edge: a single `.proto` generating both the gRPC service and the JSON facade, with the mapping annotations written out.
5. Identify every synchronous call that does not need to be synchronous and move it to a queue in the design. Quantify the latency removed from the critical path.
6. Write the load-balancing plan for the gRPC edges *before* declaring the design done, including what happens during a rolling deploy.

**Extensions.**
- Add a GraphQL BFF for the mobile client and show which downstream calls it fans out to, with an N+1 analysis and a complexity budget.
- Write the migration sequencing: which edge moves first, what the rollback is, and what metric would make you stop.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *What Is gRPC?* (the model being compared), *Protocol Buffers: Binary Wire Format* (where the size and speed come from), *The Four RPC Patterns* (what streaming buys you), *Build: Deployment — Kubernetes, Proxies, grpc-gateway & gRPC-Web* (making the hybrid architecture real), *Performance Tuning* (measuring rather than assuming).

- **gRPC — FAQ and "Why gRPC?"** — grpc.io · *Beginner* · the maintainers' own framing of where gRPC fits and where it does not; short and unusually honest. <https://grpc.io/docs/what-is-grpc/faq/>
- **grpc-gateway documentation** — grpc-ecosystem (open source) · *Intermediate* · generating a JSON/REST facade and OpenAPI spec from the same `.proto`; the standard answer to "gRPC internally, REST externally". <https://grpc-ecosystem.github.io/grpc-gateway/>
- **Connect — a better gRPC** — Buf (open source) · *Intermediate* · a gRPC-compatible protocol that works over HTTP/1.1, supports browsers without a proxy, and is curl-able; the strongest current alternative to gateway proxies. <https://connectrpc.com/docs/introduction>
- **gRPC-Web specification and Envoy filter** — gRPC Authors / Envoy · *Advanced* · exactly what changes for browsers and why bidirectional streaming is unavailable. <https://github.com/grpc/grpc-web>
- **Google API Design Guide** — Google · *Intermediate* · how to design gRPC methods and resources so that a REST mapping remains natural; the source of the `google.api.http` annotations. <https://cloud.google.com/apis/design>
- **GraphQL — Best Practices & "Thinking in Graphs"** — GraphQL Foundation · *Intermediate* · when GraphQL's client-driven model earns its cost, and the complexity controls you must add. <https://graphql.org/learn/best-practices/>
- **Designing Data-Intensive Applications, ch. 4 (Encoding and Evolution)** — Martin Kleppmann · *Advanced* · the clearest comparative treatment of protobuf, Avro, Thrift and JSON, and of synchronous RPC versus message-passing. Chapter preview available free. <https://dataintensive.net/>
- **gRPC Load Balancing** — gRPC Authors · *Intermediate* · the operational consequence of choosing gRPC that most adoption plans miss. <https://grpc.io/blog/grpc-load-balancing/>

---

*gRPC with Go Handbook — chapter 04.*
