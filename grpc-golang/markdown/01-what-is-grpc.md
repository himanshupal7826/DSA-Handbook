# 01 · What Is gRPC? RPC, IDL & Contract-First Services

> **In one line:** gRPC is a contract-first RPC framework in which a `.proto` file is compiled into type-safe client and server code, calls travel as Protocol Buffers over HTTP/2, and the network is made to look — deliberately and imperfectly — like a local function call.

---

## 1. Overview

**gRPC** ("gRPC Remote Procedure Calls" — the recursive acronym is official) is a high-performance, open-source RPC framework released by Google in 2015 and now a graduated CNCF project. It is the public descendant of **Stubby**, the internal RPC system Google had already been running for over a decade at a scale of tens of billions of calls per second. When Google generalised Stubby for the outside world, three of its properties came with it: a strict interface definition language, a binary wire format, and a transport that could multiplex many concurrent calls over one connection.

The problem gRPC solves is the *cost of the boundary between services*. In a monolith, calling another module is a function call: the compiler checks the arguments, the IDE autocompletes them, a rename breaks the build, and the call costs nanoseconds. Split that monolith into services and every one of those guarantees evaporates. Arguments become untyped JSON, the compiler goes blind, a renamed field becomes a runtime `nil`, and each call now costs a TCP round trip plus text parsing. Teams paper over this with hand-written HTTP clients, hand-written retry logic, hand-maintained documentation and integration tests that catch the mismatches too late.

gRPC's answer is to **make the contract the source of truth and generate everything else from it**. You describe your service once in a `.proto` file — the methods, their input and output messages, every field and its type. A compiler (`protoc`, or `buf`) turns that description into real Go types, a client stub whose methods you call like any other Go method, and a server interface you implement. If the contract changes incompatibly, the code stops compiling — on both sides, in every language, before anything ships.

That is the conceptual half. The performance half comes from two other choices. Messages are serialised as **Protocol Buffers** — a compact, tagged binary format with no field names on the wire, typically 3–10× smaller than the equivalent JSON and far cheaper to parse. And the transport is **HTTP/2**, which multiplexes many independent calls over a single long-lived TCP connection, compresses headers, and supports streaming in both directions natively.

The result is a framework that is unusually good in one specific place — **east–west traffic between your own services**, especially polyglot services under latency pressure — and unremarkable or actively awkward elsewhere, notably in browsers and public partner APIs. This handbook is about using it well in Go, which is not incidental: the Go implementation (`google.golang.org/grpc`) is a pure-Go, first-class implementation maintained alongside the spec, and Go's goroutine model maps almost perfectly onto gRPC's concurrency requirements.

## 2. Core Concepts

- **RPC (Remote Procedure Call)** — an architectural style where the client invokes a named *procedure* on a remote server with typed arguments, and the framework hides the marshalling and transport. Contrast with REST, where the client manipulates *resources* through a uniform set of verbs.
- **IDL (Interface Definition Language)** — a language-neutral description of the service interface. In gRPC this is **Protocol Buffers** (`.proto`), and it is the single artefact both sides agree on.
- **Service** — a named collection of methods in the `.proto`, e.g. `service InventoryService { ... }`. It becomes a Go interface on the server and a struct with methods on the client.
- **Method (RPC)** — one callable operation: a name, one request message type, one response message type, and optional `stream` keywords on either side.
- **Message** — a structured record: named, numbered, typed fields. It compiles to a Go struct with getters and protobuf reflection metadata.
- **Stub (client)** — generated code that turns `client.GetItem(ctx, req)` into a serialised request on an HTTP/2 stream and a deserialised response or error.
- **Channel / `ClientConn`** — the client-side abstraction over one or more physical connections to a service, including name resolution, load balancing and reconnection. It is expensive to create and safe to share.
- **Metadata** — key/value pairs sent alongside a call, analogous to HTTP headers. This is where auth tokens, trace context and request ids live.
- **Deadline** — an absolute point in time by which the call must complete, propagated across process boundaries. gRPC has deadlines, not timeouts, and this distinction matters (chapter 21).
- **Status** — every RPC ends with a `codes.Code`, a message, and optional structured details. There is no "HTTP 200 with an error body" in idiomatic gRPC.
- **Interceptor** — middleware that wraps a call on either side, used for auth, logging, metrics, retries and panic recovery (chapter 23).

## 3. Theory & Principles

### The RPC illusion, and where it leaks

The 1984 paper *A Note on Distributed Computing* (Waldo et al., later published at Sun) is the standard warning: local and remote calls differ in **latency**, **memory access**, **partial failure** and **concurrency**, and any framework that hides those differences completely will eventually hurt you. gRPC's design is notable for how much of the illusion it deliberately *refuses* to maintain:

- Every generated method takes a **`context.Context` as its first argument**. You cannot call an RPC without being handed the vocabulary of cancellation and deadlines.
- Every generated method returns an **`error`** that is really a `status.Status` with a machine-readable code. Partial failure is in the type signature.
- Streaming methods return an explicit **stream object**, not a slice — you cannot pretend a million-row response is a local list.

So the correct mental model is not "gRPC makes the network invisible" but "gRPC makes the network *typed*". The remoteness is still your problem; the marshalling, framing, connection management and code generation are not.

### Contract-first, and why it changes team behaviour

There are two ways to arrive at an API. **Code-first**: write handlers, generate a spec from annotations, publish it. **Contract-first**: write the spec, generate the code, implement against it. gRPC only supports the second, and that constraint has second-order effects:

1. **The contract is reviewable in isolation.** A `.proto` diff is short, readable by non-owners, and can be reviewed before implementation exists — which is when design feedback is cheap.
2. **The contract is enforceable in CI.** `buf breaking` can fail a pull request that removes a field or changes a type (chapter 8/13). There is no equivalent discipline in most JSON APIs.
3. **The contract is the documentation.** Comments in the `.proto` flow into generated code in every language, so the doc cannot drift from the wire format.
4. **Cross-team changes become explicit.** Adding a field is a one-line diff both teams can see; you cannot quietly start emitting a new JSON key and hope nobody notices.

The cost is real: a `.proto` change requires regeneration and a rebuild on both sides, and there is no "just curl it and see" for a new endpoint. That friction is exactly the trade — you buy compile-time safety with build-time ceremony.

```svg
<svg viewBox="0 0 860 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="a1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="430" y="24" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Contract-first: one .proto generates both sides</text>

  <rect x="330" y="46" width="200" height="58" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="430" y="70" text-anchor="middle" fill="#3730a3" font-size="13" font-weight="bold">inventory.proto</text>
  <text x="430" y="90" text-anchor="middle" fill="#4338ca" font-size="11">the single source of truth</text>

  <path d="M400,106 L250,150" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a1)"/>
  <path d="M460,106 L610,150" stroke="#4f46e5" stroke-width="2" fill="none" marker-end="url(#a1)"/>
  <text x="300" y="132" text-anchor="middle" fill="#4338ca" font-size="11">protoc</text>
  <text x="565" y="132" text-anchor="middle" fill="#4338ca" font-size="11">protoc</text>

  <rect x="70" y="156" width="300" height="88" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="220" y="178" text-anchor="middle" fill="#15803d" font-size="13" font-weight="bold">Client (Go)</text>
  <text x="88" y="200" fill="#166534" font-size="11">inventory_grpc.pb.go: InventoryClient</text>
  <text x="88" y="218" fill="#166534" font-size="11">c.GetItem(ctx, &amp;GetItemRequest{Id: "sku_1"})</text>
  <text x="88" y="236" fill="#166534" font-size="11">returns (*Item, error) — typed, checked</text>

  <rect x="490" y="156" width="300" height="88" rx="10" fill="#fff7ed" stroke="#ea580c" stroke-width="2"/>
  <text x="640" y="178" text-anchor="middle" fill="#c2410c" font-size="13" font-weight="bold">Server (Go, or Java, Python…)</text>
  <text x="508" y="200" fill="#9a3412" font-size="11">InventoryServiceServer interface</text>
  <text x="508" y="218" fill="#9a3412" font-size="11">func (s *srv) GetItem(ctx, req) (*Item, error)</text>
  <text x="508" y="236" fill="#9a3412" font-size="11">compiler enforces the signature</text>

  <rect x="200" y="276" width="460" height="76" rx="10" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="430" y="298" text-anchor="middle" fill="#334155" font-size="13" font-weight="bold">Wire: Protocol Buffers over HTTP/2</text>
  <text x="430" y="318" text-anchor="middle" fill="#475569" font-size="11">one stream per call &#183; binary frames &#183; HPACK headers &#183; trailers carry status</text>
  <text x="430" y="338" text-anchor="middle" fill="#475569" font-size="11">a rename in the .proto breaks the build, not production</text>
</svg>
```

### Why HTTP/2 and Protocol Buffers together

Either choice alone gives you something; together they give you the property gRPC is actually sold on. Protocol Buffers make each message small and cheap to parse. HTTP/2 makes many concurrent messages share one connection with independent flow control. A JSON-over-HTTP/1.1 client that wants 100 concurrent requests needs a pool of ~100 TCP connections, each with its own handshake, congestion window and file descriptor. A gRPC client issues 100 concurrent RPCs on one warm connection, each as an independent HTTP/2 stream. That is why the gap widens under load rather than closing.

## 4. Architecture & Workflow

The end-to-end lifecycle of a single unary gRPC call in Go:

1. **Design.** You write `inventory.proto` describing `service InventoryService` with a `GetItem` method taking `GetItemRequest` and returning `Item`.
2. **Generate.** `protoc` (with `protoc-gen-go` and `protoc-gen-go-grpc`) emits `inventory.pb.go` — the message structs and their serialisation — and `inventory_grpc.pb.go` — the `InventoryServiceClient` interface, an unexported implementation, and the `InventoryServiceServer` interface plus registration helper.
3. **Implement.** The server embeds `UnimplementedInventoryServiceServer` and writes `GetItem(ctx context.Context, req *pb.GetItemRequest) (*pb.Item, error)`.
4. **Register and serve.** `grpc.NewServer()` builds a server; `pb.RegisterInventoryServiceServer(s, impl)` populates its method table; `s.Serve(lis)` accepts connections.
5. **Connect.** The client calls `grpc.NewClient(target, opts...)`, which resolves the target, sets up credentials and prepares a load-balancing policy — but does *not* eagerly connect (chapter 19).
6. **Invoke.** `client.GetItem(ctx, req)` marshals the request, opens an HTTP/2 stream with `:path = /inventory.v1.InventoryService/GetItem`, sends headers (including `grpc-timeout` derived from the context deadline), sends one length-prefixed message, and half-closes.
7. **Dispatch.** The server reads the `:path`, looks up the handler, spawns a goroutine, runs the interceptor chain, unmarshals the request and calls your method.
8. **Respond.** Your return value is marshalled into one DATA frame; the status code travels in **HTTP/2 trailers** (`grpc-status`, `grpc-message`) after the body. This trailer-based status is precisely what lets a streaming call report failure after it has already sent data.
9. **Complete.** The client unmarshals the response, converts a non-`OK` trailer into a Go `error` carrying a `status.Status`, and returns.

```svg
<svg viewBox="0 0 860 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">
  <defs>
    <marker id="b1" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#0ea5e9"/></marker>
    <marker id="b2" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L8,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="430" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Lifecycle of one unary RPC</text>

  <rect x="40" y="46" width="150" height="40" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="115" y="71" text-anchor="middle" fill="#3730a3" font-weight="bold">Client stub</text>
  <rect x="670" y="46" width="150" height="40" rx="8" fill="#fff7ed" stroke="#ea580c" stroke-width="2"/>
  <text x="745" y="71" text-anchor="middle" fill="#c2410c" font-weight="bold">Server handler</text>

  <line x1="115" y1="86" x2="115" y2="372" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 4"/>
  <line x1="745" y1="86" x2="745" y2="372" stroke="#94a3b8" stroke-width="2" stroke-dasharray="4 4"/>

  <path d="M115,116 L740,116" stroke="#0ea5e9" stroke-width="2" marker-end="url(#b1)"/>
  <text x="428" y="110" text-anchor="middle" fill="#0369a1" font-size="11">HEADERS  :path=/inventory.v1.InventoryService/GetItem</text>
  <text x="428" y="132" text-anchor="middle" fill="#64748b" font-size="10">grpc-timeout: 2000m &#183; authorization: Bearer &#8230; &#183; content-type: application/grpc</text>

  <path d="M115,166 L740,166" stroke="#0ea5e9" stroke-width="2" marker-end="url(#b1)"/>
  <text x="428" y="160" text-anchor="middle" fill="#0369a1" font-size="11">DATA  [0][len=17][protobuf bytes]  then END_STREAM (half-close)</text>

  <rect x="620" y="192" width="230" height="52" rx="8" fill="#fef9c3" stroke="#ca8a04" stroke-width="2"/>
  <text x="735" y="212" text-anchor="middle" fill="#854d0e" font-size="11">goroutine spawned &#183; interceptors run</text>
  <text x="735" y="232" text-anchor="middle" fill="#854d0e" font-size="11">Unmarshal &#8594; GetItem(ctx, req)</text>

  <path d="M740,282 L120,282" stroke="#16a34a" stroke-width="2" marker-end="url(#b2)"/>
  <text x="428" y="276" text-anchor="middle" fill="#15803d" font-size="11">HEADERS (response) + DATA [protobuf bytes]</text>

  <path d="M740,326 L120,326" stroke="#16a34a" stroke-width="2" marker-end="url(#b2)"/>
  <text x="428" y="320" text-anchor="middle" fill="#15803d" font-size="11">TRAILERS  grpc-status: 0  grpc-message: ""</text>
  <text x="428" y="356" text-anchor="middle" fill="#475569" font-size="11">status arrives AFTER the body &#8594; a stream can fail mid-flight</text>
</svg>
```

Two details in that sequence are worth remembering because they explain a lot of behaviour later. First, **status lives in trailers**, which is why gRPC needs HTTP/2 and cannot be expressed faithfully over HTTP/1.1 — that is the whole reason gRPC-Web needs a proxy. Second, **the deadline is on the wire** as `grpc-timeout`, so the server knows how long the client is willing to wait and can propagate that budget to its own downstream calls.

## 5. Implementation

A complete, minimal but real gRPC service in Go — the smallest thing that demonstrates the whole loop. Later chapters expand each piece.

**`proto/inventory/v1/inventory.proto`**

```protobuf
syntax = "proto3";

package inventory.v1;

option go_package = "github.com/example/inventory/gen/inventory/v1;inventoryv1";

// InventoryService is the canonical read/write API for stock keeping units.
service InventoryService {
  // GetItem returns a single item by its opaque SKU identifier.
  rpc GetItem(GetItemRequest) returns (GetItemResponse);
}

message GetItemRequest {
  // Opaque SKU, e.g. "sku_01HQ8ZK3". Never parsed by the client.
  string sku = 1;
}

message GetItemResponse {
  Item item = 1;
}

message Item {
  string sku = 1;
  string name = 2;
  int32 quantity_on_hand = 3;
  int64 unit_price_cents = 4;
}
```

**Generate**

```bash
protoc \
  --go_out=. --go_opt=paths=source_relative \
  --go-grpc_out=. --go-grpc_opt=paths=source_relative \
  proto/inventory/v1/inventory.proto
```

**`cmd/server/main.go`**

```go
package main

import (
	"context"
	"log"
	"net"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	inventoryv1 "github.com/example/inventory/gen/inventory/v1"
)

// server implements inventoryv1.InventoryServiceServer.
//
// Embedding UnimplementedInventoryServiceServer is mandatory in practice: it
// provides default "unimplemented" methods so that adding a new RPC to the
// .proto does not break compilation of every existing implementation.
type server struct {
	inventoryv1.UnimplementedInventoryServiceServer

	items map[string]*inventoryv1.Item
}

func (s *server) GetItem(
	ctx context.Context,
	req *inventoryv1.GetItemRequest,
) (*inventoryv1.GetItemResponse, error) {
	// Validate first: a bad request must never reach business logic.
	if req.GetSku() == "" {
		return nil, status.Error(codes.InvalidArgument, "sku is required")
	}

	// Respect cancellation before doing expensive work. In a real handler this
	// check is implicit in every ctx-aware call (database, HTTP, downstream RPC).
	if err := ctx.Err(); err != nil {
		return nil, status.FromContextError(err).Err()
	}

	item, ok := s.items[req.GetSku()]
	if !ok {
		return nil, status.Errorf(codes.NotFound, "item %q not found", req.GetSku())
	}

	return &inventoryv1.GetItemResponse{Item: item}, nil
}

func main() {
	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		log.Fatalf("listen: %v", err)
	}

	s := grpc.NewServer()
	inventoryv1.RegisterInventoryServiceServer(s, &server{
		items: map[string]*inventoryv1.Item{
			"sku_1": {Sku: "sku_1", Name: "Blue Widget", QuantityOnHand: 42, UnitPriceCents: 1299},
		},
	})

	log.Printf("gRPC server listening on %s", lis.Addr())
	if err := s.Serve(lis); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
```

**`cmd/client/main.go`**

```go
package main

import (
	"context"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"

	inventoryv1 "github.com/example/inventory/gen/inventory/v1"
)

func main() {
	// grpc.NewClient is lazy: it prepares the resolver and balancer but does not
	// block on a connection. Create it once at process start and share it.
	conn, err := grpc.NewClient(
		"localhost:50051",
		grpc.WithTransportCredentials(insecure.NewCredentials()), // dev only
	)
	if err != nil {
		log.Fatalf("new client: %v", err)
	}
	defer conn.Close()

	client := inventoryv1.NewInventoryServiceClient(conn)

	// Every RPC gets a deadline. There is no sane default; unbounded calls are
	// how a single slow dependency turns into a cascading outage.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	resp, err := client.GetItem(ctx, &inventoryv1.GetItemRequest{Sku: "sku_1"})
	if err != nil {
		st, _ := status.FromError(err)
		log.Fatalf("GetItem failed: code=%s msg=%s", st.Code(), st.Message())
	}

	log.Printf("item: %s (%d in stock)", resp.GetItem().GetName(), resp.GetItem().GetQuantityOnHand())
}
```

Run the server, run the client, and you have exercised code generation, registration, transport, marshalling, status codes and deadlines — the entire skeleton the rest of this handbook fleshes out.

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Compile-time safety across process and language boundaries.** A field rename is a build failure, not a 3 a.m. page.
- **Performance.** Binary payloads, header compression, and one multiplexed connection instead of a pool.
- **Streaming is first class**, in all four shapes, without WebSockets or SSE bolted on.
- **Generated code in a dozen languages** from one contract — the polyglot story is the strongest reason large orgs adopt it.
- **A batteries-included runtime**: deadlines, cancellation, retries, load balancing, health checks and reflection are specified, not per-team inventions.

**Disadvantages**
- **Not browser-native.** Browsers cannot control HTTP/2 trailers, so you need gRPC-Web plus a proxy (chapter 29).
- **Opaque on the wire.** You cannot read a tcpdump or a log body without the schema; debugging needs `grpcurl`, reflection or a protoscope-style decoder.
- **Build ceremony.** Codegen must be installed, pinned, run and its output committed or built — real friction for small teams and for external consumers.
- **Weaker ad-hoc tooling.** No curl, no browser address bar, and a much thinner ecosystem of proxies, caches and API gateways than HTTP/JSON.
- **HTTP caching is unavailable.** There is no `ETag`/`Cache-Control` layer to lean on; caching is your own problem.

**Trade-offs to state out loud in a review**
- *Internal vs external:* gRPC is close to strictly better for east–west internal traffic and usually worse for a public partner API where consumers expect JSON and curl.
- *Streaming vs unary:* a stream pins a connection and complicates load balancing and rolling deploys; use it when the data is genuinely continuous, not to avoid pagination.
- *Codegen commitment:* generated code must live somewhere. Committing it is convenient but noisy; generating it in CI is clean but adds a toolchain dependency to every build.

## 7. Common Mistakes & Best Practices

- **Creating a `ClientConn` per request.** It is expensive, defeats multiplexing and leaks file descriptors. Create one per target for the lifetime of the process and share it — it is goroutine-safe.
- **Calling without a deadline.** `context.Background()` on an RPC is an unbounded wait. Every call gets a deadline, chosen from the caller's budget.
- **Returning raw Go errors.** `return nil, err` sends `codes.Unknown` and leaks internal messages to clients. Map deliberately (chapter 22).
- **Not embedding `UnimplementedXxxServer`.** Without it, adding an RPC breaks every implementation's compilation; with it, unimplemented methods return `codes.Unimplemented` cleanly.
- **Treating gRPC as "REST but faster".** Methods are procedures. Design them around use cases (`ReserveStock`), not CRUD-on-everything.
- **Using `insecure.NewCredentials()` outside local development.** It is spelled that way on purpose.
- **Forgetting that the generated package is a build artefact.** Decide once — committed or CI-generated — and enforce it, or you will spend a week on a mysterious version skew.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Enable reflection (chapter 25) so `grpcurl -plaintext localhost:50051 list` works. `GRPC_GO_LOG_SEVERITY_LEVEL=info GRPC_GO_LOG_VERBOSITY_LEVEL=99` turns on the runtime's own logs, which is the fastest way to diagnose name resolution and connectivity problems.
- **Monitoring.** Per-method rate, error-rate-by-code and latency histograms are the minimum. Alert on `Unavailable` and `DeadlineExceeded` separately: the first is usually infrastructure, the second is usually you.
- **Security.** TLS everywhere, mTLS between services in a zero-trust network, tokens in metadata validated by an interceptor, and reflection disabled or authenticated on public-facing servers.
- **Scaling.** gRPC's long-lived connections break naive L4 load balancing — a new pod gets no traffic because nobody reconnects. Use client-side load balancing over a headless service, or an L7 proxy such as Envoy (chapter 29).

## 9. Interview Questions

**Q: What is gRPC, in one paragraph, to someone who only knows REST?**
A: It is an RPC framework where you define your service's methods and message types in a `.proto` file, and a compiler generates a type-safe client and server in your language. Calls are serialised as binary Protocol Buffers and travel over HTTP/2, so many concurrent calls share one connection and streaming works in both directions. Compared with REST you gain compile-time contract enforcement, smaller and faster payloads, and native streaming; you lose human-readable traffic, browser-native support and the HTTP caching ecosystem.

**Q: Why does gRPC require HTTP/2 rather than HTTP/1.1?**
A: Three reasons. Multiplexing — HTTP/2 carries many independent streams on one connection, so N concurrent RPCs do not need N TCP connections. Trailers — gRPC delivers the final status in trailing headers after the body, which HTTP/1.1 cannot express portably, and this is what allows a streaming call to fail after data has been sent. And full-duplex framing — bidirectional streaming needs both peers sending at once, which HTTP/1.1's request/response model forbids.

**Q: What does "contract-first" mean, and why does gRPC enforce it?**
A: The `.proto` is written and reviewed before the implementation, and all code is generated from it, so no implementation can silently diverge from the published interface. gRPC enforces it because the generated stubs *are* the only way to call the service — there is no hand-written client that could drift. The practical payoff is that breaking changes are caught by the compiler and by CI tooling like `buf breaking`, rather than by a consumer in production.

**Q: What exactly does `protoc` generate for Go, and what do you do with each file?**
A: Two files. `x.pb.go` contains the message structs, their getters and the protobuf reflection/serialisation metadata — you use these as your request and response types. `x_grpc.pb.go` contains the client interface plus a concrete stub constructed by `NewXxxClient(conn)`, the server interface `XxxServer`, an `UnimplementedXxxServer` struct to embed, and `RegisterXxxServer(s, impl)`. You implement the server interface and call the client interface.

**Q: Why must you embed `UnimplementedXxxServer` in your server struct?**
A: It provides default implementations returning `codes.Unimplemented` for every method, which makes adding a new RPC to the `.proto` a non-breaking change for existing server code — otherwise every implementation fails to compile until it is updated. It is also what `grpc.NewServer`'s registration check looks for when enforcing forward compatibility.

**Q: Where does a gRPC status code actually travel on the wire?**
A: In HTTP/2 trailers, as `grpc-status` and `grpc-message`, sent after any response body. That is why a server-streaming call can send fifty messages and then fail with `Internal` — the status was never committed up front the way an HTTP/1.1 status line is. It is also why gRPC-Web needs a proxy: browsers do not expose trailers to JavaScript.

**Q: When would you *not* choose gRPC?**
A: For a public API consumed by unknown third parties who expect curl and JSON; for anything called directly from a browser without a proxy layer; when you need HTTP caching, CDNs or ordinary web infrastructure to understand your traffic; and when the team is small and the codegen toolchain would cost more than the type safety is worth. Also for very low-frequency calls, where connection and schema overhead outweigh any serialisation win.

**Q: Is gRPC's `ClientConn` safe to share across goroutines, and should you pool them?**
A: It is fully goroutine-safe and is designed to be shared — a single `ClientConn` multiplexes concurrent RPCs over HTTP/2 streams. You generally should not pool them; one per target for the process lifetime is the correct default. The exception is a very high-throughput client hitting the `MaxConcurrentStreams` limit (often 100 by default on the server), where a small pool of connections, or raising the limit, can help.

**Q: (Senior) How does gRPC's design acknowledge the fallacies of distributed computing rather than hiding them?**
A: By putting the failure modes into the type signature. Every method takes a `context.Context`, so cancellation and deadlines are unavoidable vocabulary; every method returns an `error` carrying a machine-readable `codes.Code`, so partial failure cannot be ignored; streaming methods return an explicit stream object rather than a materialised slice, so unbounded data cannot masquerade as a local list; and deadlines are propagated on the wire as `grpc-timeout`, so the budget is a distributed concept rather than a per-hop guess. What gRPC hides is marshalling, framing and connection management — mechanism, not semantics.

**Q: (Senior) Your organisation has 40 services on JSON/HTTP. Make the case for and against migrating to gRPC.**
A: For: contract enforcement in CI eliminates a whole class of integration bugs; payload and CPU savings are real at fan-out-heavy call graphs; deadline propagation and standardised status codes give you consistent timeout and retry semantics instead of forty bespoke ones; and polyglot teams get generated clients for free. Against: you need a schema registry or monorepo discipline, a codegen step in every build, new load-balancing infrastructure because long-lived HTTP/2 connections break L4 balancers, retraining on debugging opaque traffic, and a gateway for any consumer that cannot speak gRPC. I would migrate the hot internal paths first — the top few call graphs by QPS and latency sensitivity — keep the edge on JSON behind a gateway, and measure before going further.

**Q: (Senior) A team wants to expose gRPC directly to a browser SPA. What do you tell them?**
A: That the browser cannot do it directly, because the fetch and XHR APIs give JavaScript no access to HTTP/2 trailers and no control over framing. The options are gRPC-Web, which uses a different framing that encodes trailers in the body and requires a proxy (Envoy's gRPC-Web filter, or the Go `grpcweb` wrapper) to translate; `connect-go`, which speaks a gRPC-compatible protocol that also works over HTTP/1.1 and is browser-friendly; or a `grpc-gateway` that exposes a JSON/REST facade generated from the same `.proto`. I would pick Connect for a new system and grpc-gateway when an existing gRPC service needs a JSON edge without touching the service.

**Q: (Senior) How do you decide method granularity in a gRPC API?**
A: Model use cases, not tables. A method should correspond to something a caller actually wants to accomplish — `ReserveStock`, `ConfirmOrder` — so that one round trip does one meaningful unit of work and can carry its own idempotency and authorization semantics. The failure modes are symmetric: too fine-grained and you rebuild the N+1 problem across the network, adding latency and losing atomicity; too coarse and every caller pays for data it does not need and the method becomes impossible to evolve or authorize precisely. Where clients genuinely need different projections of the same data, the answer is a `FieldMask` (chapter 10), not fifteen near-duplicate methods.

## 10. Quick Revision & Cheat Sheet

| Concept | What it is | Where it lives in Go |
|---|---|---|
| Service | Named group of methods | `service Foo {}` → `FooServer` / `FooClient` |
| Message | Typed record | `message Bar {}` → `*pb.Bar` struct |
| Stub | Generated client | `pb.NewFooClient(conn)` |
| Channel | Connection abstraction | `*grpc.ClientConn` from `grpc.NewClient` |
| Metadata | Per-call key/values | `metadata.MD`, `metadata.FromIncomingContext` |
| Deadline | Absolute completion time | `context.WithTimeout` → `grpc-timeout` header |
| Status | Terminal outcome | `status.Error(codes.NotFound, "…")`, in trailers |
| Interceptor | Middleware | `grpc.UnaryInterceptor(...)`, `grpc.StreamInterceptor(...)` |
| Forward compat | Safe RPC addition | embed `UnimplementedFooServer` |

**Flash cards**
- **Why HTTP/2?** → Multiplexing, trailers for status, and full-duplex framing for bidi streaming.
- **Why Protocol Buffers?** → Tagged binary encoding: no field names on the wire, 3–10× smaller than JSON, far cheaper to parse.
- **How many `ClientConn`s?** → One per target, for the process lifetime. It is goroutine-safe.
- **Where does the status code go?** → HTTP/2 trailers (`grpc-status`), after the body.
- **What makes it contract-first?** → The only client is generated from the `.proto`; drift is impossible by construction.
- **Biggest gRPC weakness?** → No native browser support and opaque traffic; both cost you tooling.

## 11. Hands-On Exercises & Mini Project

- [ ] Type out the three files in §5 verbatim, generate, and run them. Then rename `sku` to `id` in the `.proto`, regenerate, and observe exactly which lines fail to compile.
- [ ] Run the server and capture traffic with `tcpdump -i lo0 -A port 50051`. Confirm you cannot read the payload, then run `grpcurl -plaintext localhost:50051 describe` after enabling reflection and confirm you can.
- [ ] Delete the `UnimplementedInventoryServiceServer` embed, add a second RPC to the `.proto`, regenerate, and watch the build break. Restore the embed and watch it compile.
- [ ] Call `GetItem` with `context.Background()` while the server sleeps for 30 seconds. Then add a 2-second deadline and observe the client-side `DeadlineExceeded` *and* the server-side `ctx.Err()`.

### Mini Project — "Two-Service Skeleton"

**Goal.** Build the smallest realistic gRPC system: an `inventory` service and an `orders` service that calls it, so you experience deadline propagation and cross-service errors from day one.

**Requirements.**
1. Define `inventory.v1.InventoryService` with `GetItem` and `ReserveStock`, and `orders.v1.OrderService` with `PlaceOrder`.
2. `PlaceOrder` calls `ReserveStock` on the inventory service using the *incoming* context, so the caller's deadline propagates automatically.
3. Return `codes.FailedPrecondition` from `ReserveStock` when stock is insufficient, and have `PlaceOrder` map that into its own meaningful status rather than passing it through opaquely.
4. Give the client a 500 ms deadline and add a 2-second artificial delay in inventory. Verify that *both* services observe cancellation.
5. Log the method name, the status code and the duration of every call on both sides — by hand for now; chapter 23 replaces this with an interceptor.

**Extensions.**
- Add a second implementation of the inventory server in Python or Java from the same `.proto`, and point the Go orders service at it unchanged.
- Measure the payload size of `GetItemResponse` on the wire versus the equivalent JSON, using `proto.Marshal` and `encoding/json` on the same data.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *HTTP/2 Under gRPC* (the transport that makes this work), *Protocol Buffers: Binary Wire Format* (why messages are small), *The Four RPC Patterns* (the shapes a method can take), *gRPC vs REST, GraphQL & Message Queues* (when to choose something else), *Build: The gRPC Server* (turning this skeleton into production code).

- **gRPC — Introduction to gRPC** — grpc.io · *Beginner* · the canonical eight-minute overview of services, stubs and the four RPC kinds; read this before anything else. <https://grpc.io/docs/what-is-grpc/introduction/>
- **gRPC — Core concepts, architecture and lifecycle** — grpc.io · *Beginner* · the precise semantics of each RPC kind, deadlines, cancellation and metadata, written by the maintainers. <https://grpc.io/docs/what-is-grpc/core-concepts/>
- **gRPC Go — Quick start & Basics tutorial** — grpc.io · *Beginner* · the fastest path from zero to a running Go client and server, including the route-guide example that exercises all four patterns. <https://grpc.io/docs/languages/go/quickstart/>
- **grpc-go repository & examples** — gRPC Authors (open source) · *Intermediate* · dozens of runnable examples covering auth, interceptors, retries, load balancing and health checking; the single best Go reference. <https://github.com/grpc/grpc-go/tree/master/examples>
- **gRPC over HTTP/2 — protocol specification** — gRPC Authors · *Advanced* · exactly which headers, frames and trailers constitute a gRPC call; indispensable when debugging proxies or writing tooling. <https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md>
- **A Note on Distributed Computing** — Waldo, Wyant, Wollrath & Kendall · *Advanced* · the classic paper on why remote calls are not local calls; explains what gRPC deliberately refuses to hide. <https://scholar.harvard.edu/waldo/publications/note-distributed-computing>
- **Google API Design Guide** — Google · *Intermediate* · how Google itself names services and methods, structures resources, and handles errors and long-running operations in gRPC. <https://cloud.google.com/apis/design>
- **CNCF gRPC project page** — CNCF · *Beginner* · governance, adopters and the ecosystem map; useful ammunition when making an adoption case. <https://www.cncf.io/projects/grpc/>

---

*gRPC with Go Handbook — chapter 01.*
