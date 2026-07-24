# 05 · The Four RPC Patterns: Unary, Server, Client & Bidi Streaming

> **In one line:** The `stream` keyword on either side of a method signature produces four call shapes — one request/one response, one request/many responses, many requests/one response, and many/many — and choosing wrongly costs you either round trips or a pinned connection that breaks your load balancer.

---

## 1. Overview

Every gRPC method is one of exactly four shapes, determined by where you put the `stream` keyword in the `.proto`:

```protobuf
rpc GetItem(GetItemRequest) returns (GetItemResponse);                    // unary
rpc WatchStock(WatchStockRequest) returns (stream StockEvent);            // server streaming
rpc BulkAdjust(stream AdjustRequest) returns (BulkAdjustSummary);         // client streaming
rpc Sync(stream SyncRequest) returns (stream SyncResponse);               // bidirectional
```

That single keyword changes the generated Go signature, the concurrency model, the error-reporting semantics and the operational profile of the method. Understanding all four is not academic: interviewers ask for all four, and production incidents come disproportionately from streaming methods used where unary would have been correct.

The unifying mechanism is the one from chapter 2 — **every RPC is one HTTP/2 stream**, and a "unary" call is just a stream where each side sends exactly one message before half-closing. Streaming does not use a different protocol; it removes the restriction to one message. This is why the transport, interceptor and status machinery is shared, and why streaming inherits HTTP/2 flow control as genuine backpressure.

What differs materially is **when the status is known**. A unary call has a single outcome. A streaming call may deliver forty messages and then fail, because `grpc-status` lives in trailers sent after the body. Any client that treats "I received data" as "the call succeeded" is wrong, and this is the single most common streaming bug in code review.

## 2. Core Concepts

- **Unary RPC** — one request message, one response message. The default and, in most systems, 90%+ of methods.
- **Server-streaming RPC** — one request, then the server sends a sequence of responses until it returns. The client reads until `io.EOF`.
- **Client-streaming RPC** — the client sends a sequence of requests, then closes; the server responds once. Used for uploads and batch ingestion.
- **Bidirectional (bidi) streaming** — both sides send sequences independently. The two directions are fully decoupled: message *k* in does not imply message *k* out.
- **Half-close** — a peer signalling "I will send no more messages" without ending the call. `CloseSend()` on the client, returning from the handler on the server.
- **`io.EOF`** — the sentinel meaning "the peer half-closed cleanly". It is **not** an error; a real failure returns a `status` error instead.
- **Backpressure** — HTTP/2 flow control: if a receiver stops reading, the sender's `Send()` eventually blocks. This is the designed behaviour, not a bug.
- **Stream lifetime** — a stream lives on one connection to one backend for its entire duration. It cannot migrate, which is why streams complicate load balancing and rolling deploys.
- **Message ordering** — messages within one direction of one stream are strictly ordered. There is no ordering guarantee *between* streams.
- **`SendAndClose` / `CloseAndRecv`** — the paired terminal operations of a client-streaming call, on the server and client respectively.

## 3. Theory & Principles

### The four shapes, precisely

| Pattern | `.proto` | Client sends | Server sends | Go client type | Go server type |
|---|---|---|---|---|---|
| Unary | `rpc M(Req) returns (Resp)` | 1 | 1 | `(*Resp, error)` | `func(ctx, *Req) (*Resp, error)` |
| Server streaming | `returns (stream Resp)` | 1 | N | `M_Client` with `Recv()` | `func(*Req, M_Server) error` |
| Client streaming | `M(stream Req)` | N | 1 | `M_Client` with `Send()`, `CloseAndRecv()` | `func(M_Server) error` + `SendAndClose` |
| Bidirectional | `M(stream Req) returns (stream Resp)` | N | M | `M_Client` with `Send()`/`Recv()` | `func(M_Server) error` |

Note the asymmetry that surprises people: for **server streaming** the handler receives the request *and* the stream; for **client and bidi streaming** it receives only the stream, because there is no single request to hand over.

### Half-close and `io.EOF`

The half-close is the protocol's way of saying "I am done sending, but I am still listening". It maps to the HTTP/2 `END_STREAM` flag on the last DATA frame in one direction.

- **Client → server.** The client calls `stream.CloseSend()`. The server's next `stream.Recv()` returns `io.EOF`. Forgetting `CloseSend()` in a client-streaming call is the classic hang: the server waits forever for a message that never comes, until the deadline fires.
- **Server → client.** The server handler simply **returns**. Returning `nil` closes the stream with `OK`; returning an error closes it with that status. The client's next `Recv()` returns `io.EOF` for success, or the status error for failure.

Therefore the canonical client read loop is:

```go
for {
    msg, err := stream.Recv()
    if errors.Is(err, io.EOF) {
        break // clean end of stream — this is success
    }
    if err != nil {
        return err // a real failure, carrying a status code
    }
    handle(msg)
}
```

Treating `io.EOF` as an error, or treating any non-`io.EOF` error as the end of the stream, are the two symmetric bugs.

### When each pattern is correct

**Unary** is the default and should be justified *away from*, not toward. It load-balances per call, retries trivially, caches conceptually, and produces one clean trace span. Use it unless you have a specific reason not to.

**Server streaming** earns its place when the response is genuinely unbounded or open-ended in time: tailing logs, watching a resource for changes, exporting a large dataset, or reporting progress on a long job. It avoids materialising a huge response in memory on either side and lets the client start processing the first record immediately. It is *not* a replacement for pagination when the client wants a page — pagination is resumable and stateless, a stream is neither.

**Client streaming** fits uploads and high-volume ingestion where a single summary suffices: chunked file upload, metric batches, bulk imports. The win is amortising per-call overhead across many messages and letting the server process incrementally rather than buffering one enormous request. Note that it gives you **no per-message acknowledgement** — if you need that, you want bidi.

**Bidirectional streaming** is for genuinely interactive, long-lived sessions: chat, collaborative editing, telemetry with server-side control messages, or any protocol where the server must react mid-stream. It is the most powerful and most operationally expensive shape: it pins a connection, complicates deploys and requires careful concurrency in Go.

```svg
<svg viewBox="0 0 880 560" width="100%" height="560" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="s1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="s2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The four RPC patterns on one HTTP/2 stream each</text>

  <g>
    <rect x="24" y="40" width="410" height="240" rx="10" fill="#eff6ff" stroke="#3b82f6" stroke-width="2"/>
    <text x="229" y="62" text-anchor="middle" fill="#1e40af" font-size="13" font-weight="bold">1. Unary &#183; rpc M(Req) returns (Resp)</text>
    <text x="70" y="86" fill="#334155" font-weight="bold">client</text>
    <text x="380" y="86" fill="#334155" font-weight="bold">server</text>
    <line x1="80" y1="94" x2="80" y2="266" stroke="#94a3b8" stroke-dasharray="4 4"/>
    <line x1="380" y1="94" x2="380" y2="266" stroke="#94a3b8" stroke-dasharray="4 4"/>
    <path d="M80,114 L374,114" stroke="#2563eb" stroke-width="2" marker-end="url(#s1)"/>
    <text x="227" y="108" text-anchor="middle" fill="#1e40af">Req (1 message) + END_STREAM</text>
    <path d="M380,152 L86,152" stroke="#16a34a" stroke-width="2" marker-end="url(#s2)"/>
    <text x="233" y="146" text-anchor="middle" fill="#15803d">Resp (1 message)</text>
    <path d="M380,184 L86,184" stroke="#16a34a" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#s2)"/>
    <text x="233" y="178" text-anchor="middle" fill="#15803d">TRAILERS grpc-status</text>
    <text x="44" y="216" fill="#475569">Go: resp, err := c.M(ctx, req)</text>
    <text x="44" y="234" fill="#475569">Use for: 90% of methods. Load-balances per call,</text>
    <text x="44" y="252" fill="#475569">retries trivially, one clean trace span.</text>
  </g>

  <g>
    <rect x="446" y="40" width="410" height="240" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
    <text x="651" y="62" text-anchor="middle" fill="#15803d" font-size="13" font-weight="bold">2. Server streaming &#183; returns (stream Resp)</text>
    <text x="492" y="86" fill="#334155" font-weight="bold">client</text>
    <text x="802" y="86" fill="#334155" font-weight="bold">server</text>
    <line x1="502" y1="94" x2="502" y2="266" stroke="#94a3b8" stroke-dasharray="4 4"/>
    <line x1="802" y1="94" x2="802" y2="266" stroke="#94a3b8" stroke-dasharray="4 4"/>
    <path d="M502,112 L796,112" stroke="#2563eb" stroke-width="2" marker-end="url(#s1)"/>
    <text x="649" y="106" text-anchor="middle" fill="#1e40af">Req + END_STREAM</text>
    <path d="M802,138 L508,138" stroke="#16a34a" stroke-width="2" marker-end="url(#s2)"/>
    <path d="M802,158 L508,158" stroke="#16a34a" stroke-width="2" marker-end="url(#s2)"/>
    <path d="M802,178 L508,178" stroke="#16a34a" stroke-width="2" marker-end="url(#s2)"/>
    <text x="655" y="132" text-anchor="middle" fill="#15803d">Resp &#215; N (stream.Send)</text>
    <path d="M802,200 L508,200" stroke="#16a34a" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#s2)"/>
    <text x="655" y="194" text-anchor="middle" fill="#15803d">handler returns &#8594; TRAILERS &#8594; client sees io.EOF</text>
    <text x="466" y="228" fill="#475569">Go: s, _ := c.M(ctx, req); for { m, err := s.Recv() }</text>
    <text x="466" y="246" fill="#475569">Use for: watch/tail, progress, large exports.</text>
    <text x="466" y="264" fill="#475569">NOT a substitute for resumable pagination.</text>
  </g>

  <g>
    <rect x="24" y="292" width="410" height="252" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
    <text x="229" y="314" text-anchor="middle" fill="#92400e" font-size="13" font-weight="bold">3. Client streaming &#183; M(stream Req)</text>
    <text x="70" y="338" fill="#334155" font-weight="bold">client</text>
    <text x="380" y="338" fill="#334155" font-weight="bold">server</text>
    <line x1="80" y1="346" x2="80" y2="500" stroke="#94a3b8" stroke-dasharray="4 4"/>
    <line x1="380" y1="346" x2="380" y2="500" stroke="#94a3b8" stroke-dasharray="4 4"/>
    <path d="M80,364 L374,364" stroke="#2563eb" stroke-width="2" marker-end="url(#s1)"/>
    <path d="M80,384 L374,384" stroke="#2563eb" stroke-width="2" marker-end="url(#s1)"/>
    <path d="M80,404 L374,404" stroke="#2563eb" stroke-width="2" marker-end="url(#s1)"/>
    <text x="227" y="358" text-anchor="middle" fill="#1e40af">Req &#215; N (stream.Send)</text>
    <path d="M80,426 L374,426" stroke="#2563eb" stroke-width="2" stroke-dasharray="5 3" marker-end="url(#s1)"/>
    <text x="227" y="420" text-anchor="middle" fill="#1e40af">CloseSend() &#8594; server Recv() == io.EOF</text>
    <path d="M380,454 L86,454" stroke="#16a34a" stroke-width="2" marker-end="url(#s2)"/>
    <text x="233" y="448" text-anchor="middle" fill="#15803d">one summary Resp + TRAILERS</text>
    <text x="44" y="484" fill="#475569">Go: s.Send(...) &#215; N; resp, err := s.CloseAndRecv()</text>
    <text x="44" y="502" fill="#475569">Use for: chunked upload, batch ingest.</text>
    <text x="44" y="520" fill="#475569">Trap: forget CloseSend() and the call hangs to deadline.</text>
    <text x="44" y="538" fill="#475569">No per-message acks &#8212; if you need them, use bidi.</text>
  </g>

  <g>
    <rect x="446" y="292" width="410" height="252" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
    <text x="651" y="314" text-anchor="middle" fill="#5b21b6" font-size="13" font-weight="bold">4. Bidirectional &#183; M(stream Req) returns (stream Resp)</text>
    <text x="492" y="338" fill="#334155" font-weight="bold">client</text>
    <text x="802" y="338" fill="#334155" font-weight="bold">server</text>
    <line x1="502" y1="346" x2="502" y2="500" stroke="#94a3b8" stroke-dasharray="4 4"/>
    <line x1="802" y1="346" x2="802" y2="500" stroke="#94a3b8" stroke-dasharray="4 4"/>
    <path d="M502,362 L796,362" stroke="#2563eb" stroke-width="2" marker-end="url(#s1)"/>
    <path d="M802,382 L508,382" stroke="#16a34a" stroke-width="2" marker-end="url(#s2)"/>
    <path d="M502,402 L796,402" stroke="#2563eb" stroke-width="2" marker-end="url(#s1)"/>
    <path d="M502,422 L796,422" stroke="#2563eb" stroke-width="2" marker-end="url(#s1)"/>
    <path d="M802,442 L508,442" stroke="#16a34a" stroke-width="2" marker-end="url(#s2)"/>
    <path d="M802,462 L508,462" stroke="#16a34a" stroke-width="2" marker-end="url(#s2)"/>
    <text x="651" y="484" text-anchor="middle" fill="#5b21b6" font-size="10">directions are fully independent &#8212; not request/response pairs</text>
    <text x="466" y="506" fill="#475569">Go: one goroutine sending, one receiving.</text>
    <text x="466" y="524" fill="#475569">Use for: chat, sync, telemetry with control messages.</text>
    <text x="466" y="542" fill="#475569">Most expensive: pins a connection, complicates deploys.</text>
  </g>
</svg>
```

### Concurrency rules you must obey

grpc-go's stream objects have specific safety guarantees, and violating them causes data races or panics:

1. **It is safe to have one goroutine calling `Send()` and another calling `Recv()` on the same stream.** This is the intended bidi pattern.
2. **It is NOT safe to call `Send()` from two goroutines concurrently**, nor `Recv()` from two goroutines. Serialise each direction.
3. **On the server, the handler returning terminates the stream.** You must not call `stream.Send()` after returning, and any goroutine you spawned must be joined before you return.
4. **The stream's context is cancelled when the RPC ends.** Use `stream.Context()` for all downstream work so cancellation propagates.

## 4. Architecture & Workflow

**Choosing a pattern — the procedure.**

1. **Is the response bounded and small enough to build in memory?** Yes and the request is too → unary. Stop here for most methods.
2. **Is the response unbounded, or open-ended in time?** → server streaming. But first ask whether the client actually wants *pagination* (resumable, stateless, load-balanceable) instead.
3. **Is the request unbounded, with a single summary result?** → client streaming. Ask whether a series of unary batch calls with a batch id would be simpler — it usually is, and it retries.
4. **Do both sides need to send independently over a session?** → bidi. Ask whether a message queue or WebSocket-style long poll fits better operationally.
5. **Whichever you pick, write down the deadline and the resumption story.** Streams need both, and unary methods get them for free.

```svg
<svg viewBox="0 0 880 340" width="100%" height="340" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The operational cost of a stream: it pins a backend</text>

  <rect x="24" y="42" width="410" height="230" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#15803d" font-size="13" font-weight="bold">Unary: every call is re-balanced</text>
  <rect x="48" y="80" width="90" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="93" y="102" text-anchor="middle" fill="#14532d">client</text>
  <g stroke="#16a34a" stroke-width="1.6">
    <path d="M140,90 L300,84"/><path d="M140,96 L300,124"/><path d="M140,102 L300,164"/><path d="M140,108 L300,204"/>
  </g>
  <rect x="302" y="70" width="110" height="30" rx="6" fill="#fff" stroke="#16a34a"/><text x="357" y="90" text-anchor="middle" fill="#14532d">pod A</text>
  <rect x="302" y="110" width="110" height="30" rx="6" fill="#fff" stroke="#16a34a"/><text x="357" y="130" text-anchor="middle" fill="#14532d">pod B</text>
  <rect x="302" y="150" width="110" height="30" rx="6" fill="#fff" stroke="#16a34a"/><text x="357" y="170" text-anchor="middle" fill="#14532d">pod C</text>
  <rect x="302" y="190" width="110" height="30" rx="6" fill="#fff" stroke="#16a34a"/><text x="357" y="210" text-anchor="middle" fill="#14532d">pod D (new)</text>
  <text x="44" y="242" fill="#166534">&#8226; round_robin picks a backend per RPC</text>
  <text x="44" y="260" fill="#166534">&#8226; scale-up takes effect immediately &#183; GracefulStop drains in ms</text>

  <rect x="446" y="42" width="410" height="230" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#b91c1c" font-size="13" font-weight="bold">Streams: pinned for their whole lifetime</text>
  <rect x="470" y="80" width="90" height="34" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="515" y="102" text-anchor="middle" fill="#7f1d1d">client</text>
  <g stroke="#dc2626" stroke-width="3">
    <path d="M562,92 L722,86"/><path d="M562,96 L722,90"/><path d="M562,100 L722,94"/>
  </g>
  <rect x="724" y="70" width="110" height="30" rx="6" fill="#fecaca" stroke="#dc2626"/><text x="779" y="90" text-anchor="middle" fill="#7f1d1d" font-weight="bold">pod A (3 streams)</text>
  <rect x="724" y="110" width="110" height="30" rx="6" fill="#fff" stroke="#fca5a5"/><text x="779" y="130" text-anchor="middle" fill="#991b1b">pod B (idle)</text>
  <rect x="724" y="150" width="110" height="30" rx="6" fill="#fff" stroke="#fca5a5"/><text x="779" y="170" text-anchor="middle" fill="#991b1b">pod C (idle)</text>
  <rect x="724" y="190" width="110" height="30" rx="6" fill="#fff" stroke="#fca5a5"/><text x="779" y="210" text-anchor="middle" fill="#991b1b">pod D (new, idle)</text>
  <text x="466" y="242" fill="#991b1b">&#8226; a stream cannot migrate &#183; scale-up does nothing until reconnect</text>
  <text x="466" y="260" fill="#991b1b">&#8226; GracefulStop waits for every stream &#8594; deploys stall</text>

  <rect x="24" y="286" width="832" height="46" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="440" y="306" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">Mitigation: cap stream lifetime server-side</text>
  <text x="440" y="324" text-anchor="middle" fill="#713f12">close with Unavailable + "please reconnect" &#183; set MaxConnectionAge &#183; client resumes from a cursor</text>
</svg>
```

**Operational consequences to plan for.** A stream pins a client to one backend for its lifetime, so:
- **Rolling deploys** must drain streams. `GracefulStop` waits for them, which means a stream with no deadline blocks your deploy indefinitely — always set a maximum stream lifetime.
- **Load balancing** skews: a backend that acquired many long streams keeps them even as new backends come up. `MaxConnectionAge` and application-level "please reconnect" messages are the mitigations.
- **Retries do not apply.** gRPC's built-in retry policy only retries calls that have not yet received a response; a stream that failed mid-flight must be resumed by application logic with a cursor.
- **Tracing** produces one long span rather than many, so per-message visibility needs explicit events or metrics.

## 5. Implementation

One `.proto` exercising all four patterns, then both sides in Go.

```protobuf
syntax = "proto3";
package inventory.v1;

import "google/protobuf/timestamp.proto";

option go_package = "github.com/example/inventory/gen/inventory/v1;inventoryv1";

service InventoryService {
  // 1. Unary — the default shape.
  rpc GetItem(GetItemRequest) returns (GetItemResponse);

  // 2. Server streaming — an open-ended watch on stock changes.
  rpc WatchStock(WatchStockRequest) returns (stream StockEvent);

  // 3. Client streaming — bulk adjustments, one summary in return.
  rpc BulkAdjust(stream AdjustRequest) returns (BulkAdjustSummary);

  // 4. Bidirectional — an interactive reconciliation session.
  rpc Sync(stream SyncRequest) returns (stream SyncResponse);
}

message GetItemRequest  { string sku = 1; }
message GetItemResponse { Item item = 1; }

message Item {
  string sku = 1;
  string name = 2;
  int32  quantity_on_hand = 3;
  google.protobuf.Timestamp updated_at = 4;
}

message WatchStockRequest { repeated string skus = 1; }
message StockEvent {
  string sku = 1;
  int32  quantity_on_hand = 2;
  google.protobuf.Timestamp occurred_at = 3;
}

message AdjustRequest { string sku = 1; int32 delta = 2; }
message BulkAdjustSummary {
  int32 applied = 1;
  int32 rejected = 2;
  repeated string rejected_skus = 3;
}

message SyncRequest  { string sku = 1; int32 client_quantity = 2; }
message SyncResponse { string sku = 1; int32 server_quantity = 2; bool conflict = 3; }
```

**Server — all four handlers.**

```go
package server

import (
	"context"
	"errors"
	"io"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	inventoryv1 "github.com/example/inventory/gen/inventory/v1"
)

type Server struct {
	inventoryv1.UnimplementedInventoryServiceServer
	store Store
}

// ---------------------------------------------------------------- 1. Unary
func (s *Server) GetItem(
	ctx context.Context,
	req *inventoryv1.GetItemRequest,
) (*inventoryv1.GetItemResponse, error) {
	if req.GetSku() == "" {
		return nil, status.Error(codes.InvalidArgument, "sku is required")
	}
	item, err := s.store.Get(ctx, req.GetSku())
	if errors.Is(err, ErrNotFound) {
		return nil, status.Errorf(codes.NotFound, "item %q not found", req.GetSku())
	}
	if err != nil {
		return nil, status.Error(codes.Internal, "lookup failed")
	}
	return &inventoryv1.GetItemResponse{Item: item}, nil
}

// ------------------------------------------------------ 2. Server streaming
// The handler receives BOTH the single request and the stream. Returning from
// the handler closes the stream: nil -> OK, error -> that status in trailers.
func (s *Server) WatchStock(
	req *inventoryv1.WatchStockRequest,
	stream inventoryv1.InventoryService_WatchStockServer,
) error {
	if len(req.GetSkus()) == 0 {
		return status.Error(codes.InvalidArgument, "at least one sku is required")
	}

	// Always use the stream's context: it is cancelled when the client goes
	// away, the deadline fires, or the server shuts down.
	ctx := stream.Context()

	events, unsubscribe := s.store.Subscribe(req.GetSkus())
	defer unsubscribe()

	// A hard cap on stream lifetime. Without this, GracefulStop can block
	// forever and a client can hold a backend hostage across deploys.
	deadline := time.NewTimer(30 * time.Minute)
	defer deadline.Stop()

	for {
		select {
		case <-ctx.Done():
			// Client cancelled or deadline exceeded. Translate faithfully so
			// metrics distinguish Canceled from DeadlineExceeded.
			return status.FromContextError(ctx.Err()).Err()

		case <-deadline.C:
			// Ask the client to reconnect; this also rebalances load.
			return status.Error(codes.Unavailable, "stream lifetime exceeded, please reconnect")

		case ev, ok := <-events:
			if !ok {
				return nil // source closed cleanly -> OK -> client sees io.EOF
			}
			// Send blocks when the HTTP/2 flow-control window is full. That is
			// backpressure working: a slow client slows the producer rather
			// than growing an unbounded buffer here.
			if err := stream.Send(&inventoryv1.StockEvent{
				Sku:             ev.SKU,
				QuantityOnHand:  ev.Quantity,
				OccurredAt:      timestamppb.New(ev.At),
			}); err != nil {
				// Send failing means the stream is broken; do not wrap it in a
				// new status — it already carries one.
				return err
			}
		}
	}
}

// ------------------------------------------------------ 3. Client streaming
// The handler receives ONLY the stream. It loops on Recv until io.EOF, then
// replies exactly once with SendAndClose.
func (s *Server) BulkAdjust(
	stream inventoryv1.InventoryService_BulkAdjustServer,
) error {
	ctx := stream.Context()

	var (
		applied  int32
		rejected int32
		bad      []string
	)

	const maxMessages = 10_000 // bound the work a single call can request

	for i := 0; ; i++ {
		if i >= maxMessages {
			return status.Errorf(codes.ResourceExhausted,
				"too many messages in one call (max %d)", maxMessages)
		}

		req, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			// Client half-closed: this is the normal end, NOT an error.
			return stream.SendAndClose(&inventoryv1.BulkAdjustSummary{
				Applied:      applied,
				Rejected:     rejected,
				RejectedSkus: bad,
			})
		}
		if err != nil {
			return err // real transport/status failure
		}

		if req.GetSku() == "" {
			rejected++
			bad = append(bad, "(empty sku)")
			continue
		}

		if err := s.store.Adjust(ctx, req.GetSku(), req.GetDelta()); err != nil {
			rejected++
			bad = append(bad, req.GetSku())
			continue
		}
		applied++
	}
}

// ------------------------------------------------------- 4. Bidirectional
// The simple shape: one Recv loop that Sends in response. Because this handler
// never sends unsolicited messages, a single goroutine suffices — which is the
// safest bidi implementation and the one to reach for first.
func (s *Server) Sync(stream inventoryv1.InventoryService_SyncServer) error {
	ctx := stream.Context()

	for {
		req, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return nil // client half-closed; finish cleanly
		}
		if err != nil {
			return err
		}

		serverQty, err := s.store.Quantity(ctx, req.GetSku())
		if err != nil {
			return status.Errorf(codes.Internal, "read %q: %v", req.GetSku(), err)
		}

		if err := stream.Send(&inventoryv1.SyncResponse{
			Sku:            req.GetSku(),
			ServerQuantity: serverQty,
			Conflict:       serverQty != req.GetClientQuantity(),
		}); err != nil {
			return err
		}
	}
}
```

**Server — bidi with independent directions.** When the server must push unsolicited messages (heartbeats, server-initiated commands), you need two goroutines. This is the pattern to copy:

```go
// SyncFullDuplex demonstrates truly independent directions: the receive loop
// and the send loop run concurrently. Rules obeyed here:
//   - exactly one goroutine ever calls Send
//   - exactly one goroutine ever calls Recv
//   - the handler does not return until both have stopped
func (s *Server) SyncFullDuplex(stream inventoryv1.InventoryService_SyncServer) error {
	ctx, cancel := context.WithCancel(stream.Context())
	defer cancel()

	// Receive loop -> feeds work into a channel.
	work := make(chan *inventoryv1.SyncRequest, 16)
	recvErr := make(chan error, 1)

	go func() {
		defer close(work)
		for {
			req, err := stream.Recv()
			if errors.Is(err, io.EOF) {
				recvErr <- nil
				return
			}
			if err != nil {
				recvErr <- err
				cancel() // stop the send loop too
				return
			}
			select {
			case work <- req:
			case <-ctx.Done():
				recvErr <- ctx.Err()
				return
			}
		}
	}()

	// Send loop runs in THIS goroutine, so the handler cannot return while a
	// Send is in flight.
	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-ctx.Done():
			<-recvErr // let the receive goroutine finish before returning
			return status.FromContextError(ctx.Err()).Err()

		case req, ok := <-work:
			if !ok {
				return <-recvErr // receive loop finished; propagate its outcome
			}
			qty, err := s.store.Quantity(ctx, req.GetSku())
			if err != nil {
				return status.Errorf(codes.Internal, "read %q: %v", req.GetSku(), err)
			}
			if err := stream.Send(&inventoryv1.SyncResponse{
				Sku: req.GetSku(), ServerQuantity: qty,
				Conflict: qty != req.GetClientQuantity(),
			}); err != nil {
				return err
			}

		case <-heartbeat.C:
			// Unsolicited server -> client message: impossible in the
			// single-goroutine shape above, and the reason bidi exists.
			if err := stream.Send(&inventoryv1.SyncResponse{Sku: "", ServerQuantity: -1}); err != nil {
				return err
			}
		}
	}
}
```

**Client — all four patterns.**

```go
package client

import (
	"context"
	"errors"
	"io"
	"log"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/status"

	inventoryv1 "github.com/example/inventory/gen/inventory/v1"
)

// ---------------------------------------------------------------- 1. Unary
func getItem(ctx context.Context, c inventoryv1.InventoryServiceClient, sku string) error {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	resp, err := c.GetItem(ctx, &inventoryv1.GetItemRequest{Sku: sku})
	if err != nil {
		st, _ := status.FromError(err)
		return fmt.Errorf("GetItem: %s: %s", st.Code(), st.Message())
	}
	log.Printf("item %s: %d on hand", resp.GetItem().GetSku(), resp.GetItem().GetQuantityOnHand())
	return nil
}

// ------------------------------------------------------ 2. Server streaming
func watchStock(ctx context.Context, c inventoryv1.InventoryServiceClient, skus []string) error {
	// A long deadline, but a deadline. "Forever" is not a valid stream lifetime.
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()

	stream, err := c.WatchStock(ctx, &inventoryv1.WatchStockRequest{Skus: skus})
	if err != nil {
		return err // failed to establish the stream at all
	}

	for {
		ev, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			// Clean end of stream. SUCCESS — not an error.
			return nil
		}
		if err != nil {
			// A real failure, possibly after many successful messages.
			st, _ := status.FromError(err)
			return fmt.Errorf("watch stream failed after data: %s: %s", st.Code(), st.Message())
		}
		log.Printf("event: %s -> %d", ev.GetSku(), ev.GetQuantityOnHand())
	}
}

// ------------------------------------------------------ 3. Client streaming
func bulkAdjust(ctx context.Context, c inventoryv1.InventoryServiceClient, adj map[string]int32) error {
	ctx, cancel := context.WithTimeout(ctx, 1*time.Minute)
	defer cancel()

	stream, err := c.BulkAdjust(ctx)
	if err != nil {
		return err
	}

	for sku, delta := range adj {
		if err := stream.Send(&inventoryv1.AdjustRequest{Sku: sku, Delta: delta}); err != nil {
			// Send returning io.EOF means the SERVER closed early — the real
			// status is retrieved by calling CloseAndRecv.
			if errors.Is(err, io.EOF) {
				break
			}
			return err
		}
	}

	// CloseAndRecv half-closes the send direction AND waits for the single
	// response. Forgetting this is the classic client-streaming hang.
	summary, err := stream.CloseAndRecv()
	if err != nil {
		st, _ := status.FromError(err)
		return fmt.Errorf("BulkAdjust: %s: %s", st.Code(), st.Message())
	}
	log.Printf("applied=%d rejected=%d", summary.GetApplied(), summary.GetRejected())
	return nil
}

// ------------------------------------------------------- 4. Bidirectional
func sync(ctx context.Context, c inventoryv1.InventoryServiceClient, local map[string]int32) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	stream, err := c.Sync(ctx)
	if err != nil {
		return err
	}

	// Receiving runs concurrently with sending: the server may reply out of
	// step with our sends, which is the entire point of bidi.
	done := make(chan error, 1)
	go func() {
		for {
			resp, err := stream.Recv()
			if errors.Is(err, io.EOF) {
				done <- nil
				return
			}
			if err != nil {
				done <- err
				return
			}
			if resp.GetConflict() {
				log.Printf("conflict on %s: server has %d", resp.GetSku(), resp.GetServerQuantity())
			}
		}
	}()

	for sku, qty := range local {
		if err := stream.Send(&inventoryv1.SyncRequest{Sku: sku, ClientQuantity: qty}); err != nil {
			if errors.Is(err, io.EOF) {
				break // server closed; the real error arrives on the recv side
			}
			return err
		}
	}

	// Half-close our send direction; the server's Recv now returns io.EOF.
	if err := stream.CloseSend(); err != nil {
		return err
	}

	// Wait for the receive goroutine to drain and report the final status.
	return <-done
}
```

## 6. Advantages, Disadvantages & Trade-offs

| | Unary | Server streaming | Client streaming | Bidi |
|---|---|---|---|---|
| Per-call overhead | One stream per call | Amortised over N responses | Amortised over N requests | Amortised both ways |
| Memory | Whole message in RAM both sides | Incremental on both sides | Incremental on server | Incremental |
| Latency to first byte | One round trip | One round trip, then push | N/A | One round trip |
| Backpressure | None needed | HTTP/2 flow control | HTTP/2 flow control | Both directions |
| Retry (built-in) | Yes | Only before first response | Only before first response | Effectively no |
| Load balancing | Per call — ideal | Pinned for stream lifetime | Pinned | Pinned |
| Deploy friction | None | Drains on `GracefulStop` | Drains | Drains |
| Tracing | One span per call | One long span | One long span | One long span |
| Complexity | Lowest | Low | Medium | Highest |

**Trade-offs**
- *Streaming amortises overhead but sacrifices per-call load balancing and retry.* At low QPS the overhead you saved was never the bottleneck.
- *Client streaming vs repeated unary batches:* batches retry cleanly and load-balance; streams handle unbounded input and give incremental processing. Prefer batches unless the input is truly unbounded.
- *Bidi vs a queue:* bidi is lower latency and has real backpressure; a queue gives durability, replay and fan-out. Bidi loses everything in flight when the connection drops.

## 7. Common Mistakes & Best Practices

- **Treating `io.EOF` as an error** on `Recv()`, or treating a status error as end-of-stream. They are distinct and both must be handled explicitly.
- **Forgetting `CloseSend()`** in a client-streaming or bidi call. The server blocks in `Recv()` until the deadline. This is the single most common streaming hang.
- **Calling `Send()` from multiple goroutines.** It is not safe. Serialise the send direction, always.
- **Sending after the handler returns**, or leaking a goroutine that outlives the handler. Join everything before returning.
- **Using `context.Background()` inside a streaming handler** instead of `stream.Context()`. Cancellation then does not propagate and work continues after the client is gone.
- **Streams without a maximum lifetime.** They block `GracefulStop`, skew load balancing and hide leaks. Always cap and tell the client to reconnect.
- **Using server streaming as pagination.** Pagination is resumable and stateless; a stream is neither. If the client wants "the next 50", give it a cursor.
- **Assuming bidi is request/response.** The directions are independent; response *k* has no defined relationship to request *k* unless you put a correlation id in the messages.
- **Unbounded server-side buffering to avoid blocking on `Send`.** Blocking *is* the backpressure mechanism; buffering converts it into an OOM.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `grpcurl -d @` streams newline-delimited JSON into client-streaming and bidi methods from stdin — the fastest way to exercise a stream by hand. For hangs, check in order: did the client `CloseSend()`, is there a deadline, and is `stream.Context()` being used.
- **Monitoring.** Unary metrics (rate, errors, duration) are insufficient for streams. Add: active streams per method, messages sent/received per stream, stream duration histogram, and time-since-last-message. A rising active-stream count with a flat message rate means stuck streams.
- **Security.** Streams are long-lived, so a token validated at stream open may expire mid-stream — decide explicitly whether to re-validate periodically or cap stream lifetime below token lifetime. Bound both message count and message size per stream, or one client can consume a backend indefinitely.
- **Scaling.** Streams pin connections, so plan for connection-age rotation and application-level reconnect prompts. During a rolling deploy, `GracefulStop` waits for streams — cap lifetimes or the deploy stalls. Measure stream distribution across backends, not just request distribution.

## 9. Interview Questions

**Q: Name the four gRPC communication patterns and give a realistic use case for each.**
A: Unary — one request, one response — for ordinary lookups and commands like `GetItem`, and it should be about 90% of methods. Server streaming — one request, many responses — for watching a resource, tailing logs, exporting a large dataset, or reporting progress. Client streaming — many requests, one response — for chunked uploads and bulk ingestion where a single summary suffices. Bidirectional — many both ways, independently — for interactive sessions such as chat, collaborative editing or telemetry with server-side control messages.

**Q: How does a client know a server stream has ended successfully?**
A: `Recv()` returns `io.EOF`, which is a sentinel meaning "the peer half-closed cleanly", not an error. Any other non-nil error is a real failure carrying a gRPC status. The distinction matters because a stream can deliver many messages and then fail — the status lives in HTTP/2 trailers sent after the body — so "I received data" never implies "the call succeeded".

**Q: What is half-close, and how does each side perform it?**
A: Half-close means "I will send no more messages, but I am still listening", implemented as the HTTP/2 `END_STREAM` flag on the last DATA frame in one direction. The client half-closes by calling `CloseSend()` (or `CloseAndRecv()`, which does both close and wait). The server half-closes by returning from the handler — returning `nil` closes with `OK`, returning an error closes with that status. Forgetting the client-side close is the classic hang.

**Q: What are the concurrency rules for a gRPC stream in Go?**
A: One goroutine may call `Send` while another calls `Recv` — that is the intended bidi pattern. But `Send` must never be called concurrently from two goroutines, and neither must `Recv`; each direction must be serialised. On the server, the handler returning terminates the stream, so any goroutine you spawned must be joined before you return, and nothing may call `Send` afterwards.

**Q: When is streaming the wrong choice?**
A: When the data is bounded and the client wants a page — pagination is resumable, stateless and load-balances per call, while a stream is none of those. When you need the built-in retry policy, which only applies before the first response is received. When per-call load balancing matters, because a stream pins to one backend for its lifetime. And when durability or replay matter, in which case a message log is the right tool.

**Q: How does backpressure work in gRPC streaming?**
A: Through HTTP/2 flow control. Each stream has a credit window — 64 KiB by default — and the sender may have at most that many unacknowledged bytes outstanding; the receiver issues `WINDOW_UPDATE` as the application consumes data. Concretely, if a handler stops calling `Recv()`, the client's `Send()` blocks. That blocking is the designed mechanism, so the correct response to a slow consumer is to let `Send` block, never to buffer unboundedly on the producer side.

**Q: Why do long-lived streams complicate deployments?**
A: Because `GracefulStop` waits for in-flight RPCs, and a stream is an in-flight RPC that may last hours. A stream with no deadline will block a rolling deploy indefinitely. They also skew load: a backend that accumulated streams keeps them while new pods sit idle. The mitigations are a hard maximum stream lifetime enforced server-side, returning `Unavailable` with a "please reconnect" message, `MaxConnectionAge` to rotate connections, and a client that reconnects with a resumption cursor.

**Q: What does `SendAndClose` do, and where is it used?**
A: It is the server side of a client-streaming call: after the `Recv` loop sees `io.EOF`, `SendAndClose` sends the single response message and terminates the stream. Its client counterpart is `CloseAndRecv`, which half-closes the client's send direction and blocks for that one response. Server-streaming and bidi handlers do not have it — they just return.

**Q: (Senior) A client-streaming upload occasionally hangs until the deadline. Diagnose it.**
A: The most likely cause is a missing `CloseSend()` or `CloseAndRecv()` on some code path — an early `return` inside the send loop, or an error branch that skips the close — so the server sits in `Recv()` waiting for a message that never arrives. The second candidate is flow control: if the server stops calling `Recv()` (blocked on a slow database, or accumulating into an unbounded buffer that triggered GC pressure), the window closes and the client's `Send()` blocks. I would distinguish them by checking whether the server logged any received messages, then look at goroutine dumps on both sides — a client blocked in `Send` points to flow control, a server blocked in `Recv` points to a missing close. The permanent fixes are a `defer`-based close, a bounded message count per call, and metrics for time-since-last-message on both sides.

**Q: (Senior) Design a resumable server-streaming export of 500 million rows.**
A: A raw stream is the wrong primitive alone, because a failure at row 400 million must not restart from zero. I would make each `ExportResponse` carry a monotonic, stable cursor — an opaque token encoding the sort key of the last row emitted — and have `ExportRequest` accept a `resume_from` cursor. The server caps stream lifetime (say 10 minutes) and closes with `Unavailable` and a "reconnect from cursor X" message rather than trying to hold one stream for hours. The client reconnects with the cursor and continues, so failures cost seconds, not the whole export. I would also bound message size, batch rows into chunks of a few hundred to amortise framing, apply a stable total ordering so the cursor is meaningful, and add a checksum or row count so the client can verify completeness. If durability and multi-consumer replay were also required, I would export to object storage and stream the object references instead.

**Q: (Senior) When would you choose bidirectional streaming over a message queue?**
A: When latency and backpressure matter more than durability. Bidi gives sub-millisecond turnaround, per-stream flow control that naturally throttles a fast producer, and a natural session identity for stateful interaction — which is why it fits chat, live collaboration and telemetry with control feedback. A queue gives durability, replay, fan-out to independent consumers and survival across restarts, at the cost of higher latency and a much harder debugging story. The deciding question is what happens when the consumer dies: if losing in-flight data is acceptable because the data is only meaningful live, bidi is right; if every message must eventually be processed, use a log.

**Q: (Senior) How do you handle authentication for a stream that outlives its access token?**
A: Decide the policy explicitly rather than inheriting one accidentally. The simplest and usually correct approach is to cap stream lifetime below the token's remaining validity, closing with `Unavailable` and prompting reconnection with a fresh token — this also rebalances load and bounds deploy drain time. If streams must be longer-lived, the alternative is periodic re-validation inside the handler: check an expiry stored at stream open, and either terminate with `Unauthenticated` or require the client to send a refreshed credential as a message on the stream. What I would not do is validate once at open and never again, because that turns a one-hour token into an indefinite grant.

## 10. Quick Revision & Cheat Sheet

| Operation | Unary | Server stream | Client stream | Bidi |
|---|---|---|---|---|
| Client call | `c.M(ctx, req)` | `c.M(ctx, req)` → stream | `c.M(ctx)` → stream | `c.M(ctx)` → stream |
| Client send | — | — | `s.Send(m)` | `s.Send(m)` |
| Client finish send | — | — | `s.CloseAndRecv()` | `s.CloseSend()` |
| Client receive | return value | `s.Recv()` until `io.EOF` | return of `CloseAndRecv` | `s.Recv()` until `io.EOF` |
| Server signature | `(ctx, *Req) (*Resp, error)` | `(*Req, M_Server) error` | `(M_Server) error` | `(M_Server) error` |
| Server send | `return resp, nil` | `s.Send(m)` | `s.SendAndClose(resp)` | `s.Send(m)` |
| Server receive | argument | — | `s.Recv()` until `io.EOF` | `s.Recv()` until `io.EOF` |
| End the call | return | return | return after `SendAndClose` | return |

**Flash cards**
- **What does `stream` on the request side mean?** → Client streaming; the handler gets only the stream, and loops `Recv` until `io.EOF`.
- **What does `io.EOF` from `Recv` mean?** → Clean half-close by the peer. Success, not failure.
- **The classic streaming hang?** → Client forgot `CloseSend()`; server blocks in `Recv` until the deadline.
- **Safe concurrency on a stream?** → One sender goroutine, one receiver goroutine. Never two of either.
- **Which context in a streaming handler?** → `stream.Context()`, always.
- **Why cap stream lifetime?** → Otherwise `GracefulStop` stalls, load skews, and tokens outlive their validity.
- **Retries and streams?** → Built-in retry only applies before the first response; resumption is your job, via a cursor.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement all four methods from §5 and drive each with `grpcurl`, including `-d @` with newline-delimited JSON on stdin for the streaming ones.
- [ ] Deliberately omit `CloseSend()` in the client-streaming client. Observe the hang, capture goroutine dumps on both sides, then fix it and confirm.
- [ ] Make `WatchStock` emit 100,000 events as fast as it can while the client sleeps 10 ms per `Recv`. Log how long `Send` blocks and explain the number using the 64 KiB window.
- [ ] Have `WatchStock` send 50 events and then return `status.Error(codes.Internal, "boom")`. Verify the client received all 50 *and* the error, and that a naive client would have reported success.
- [ ] Call `Send` from two goroutines on one stream and run with `-race`. Read the race report, then fix it with a single sender.
- [ ] Add a 30-second maximum lifetime to `Sync`, then trigger `GracefulStop` mid-stream and time the shutdown with and without the cap.

### Mini Project — "Pattern Playground"

**Goal.** Build one service that implements all four patterns over the same domain, plus a load driver, so the operational differences become measurable rather than theoretical.

**Requirements.**
1. Implement `GetItem` (unary), `WatchStock` (server), `BulkAdjust` (client) and `Sync` (bidi) against a shared in-memory store with a pub/sub subscription mechanism.
2. Add per-method metrics: active streams, messages in/out, stream duration, and time-since-last-message.
3. Write a driver that runs each pattern at configurable concurrency and message rate, and reports throughput and p99.
4. Run the same total work — 100,000 adjustments — three ways: 100,000 unary calls, 100 client-streaming calls of 1,000 messages, and one client-streaming call of 100,000. Chart throughput, CPU and memory for each and explain the shape of the curve.
5. Deploy three replicas behind a headless service with `round_robin` and show, with metrics, that unary calls distribute evenly while streams pin.
6. Trigger a rolling restart mid-stream and measure drain time with and without a maximum stream lifetime.

**Extensions.**
- Add resumption to `WatchStock`: emit a cursor with every event, accept `resume_from`, and prove that killing the server mid-stream loses nothing.
- Add a correlation id to `SyncRequest`/`SyncResponse` and implement the full-duplex server variant so responses can arrive out of order, then verify with an out-of-order test.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *HTTP/2 Under gRPC* (flow control and trailers, which explain streaming behaviour), *Server-Side Streaming Handlers* (the pattern in production depth), *Client-Side & Bidirectional Streaming Handlers* (concurrency in depth), *Invoking All Four Method Kinds from Go* (the client side in depth), *Graceful Shutdown* (why stream lifetimes matter for deploys).

- **gRPC — Core concepts, architecture and lifecycle** — grpc.io · *Beginner* · the authoritative description of all four RPC kinds, half-close semantics, deadlines and cancellation. <https://grpc.io/docs/what-is-grpc/core-concepts/>
- **gRPC Go — Basics tutorial (route guide)** — grpc.io · *Beginner* · the canonical worked example implementing all four patterns in Go, end to end. <https://grpc.io/docs/languages/go/basics/>
- **grpc-go examples — route_guide and streaming samples** — gRPC Authors · *Intermediate* · runnable code for every pattern, including correct `io.EOF` handling and concurrent bidi clients. <https://github.com/grpc/grpc-go/tree/master/examples/route_guide>
- **grpc-go — ServerStream and ClientStream API docs** — gRPC Authors · *Intermediate* · the precise concurrency guarantees for `Send`/`Recv`, and what each method does to the underlying stream. <https://pkg.go.dev/google.golang.org/grpc#ServerStream>
- **gRPC over HTTP/2 — protocol specification** — gRPC Authors · *Advanced* · exactly how half-close, trailers and cancellation are encoded; settles any dispute about streaming semantics. <https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md>
- **grpcurl** — FullStory (open source) · *Beginner* · the command-line client that can drive streaming methods with `-d @`; indispensable for manual testing. <https://github.com/fullstorydev/grpcurl>
- **gRPC Blog — Deadlines** — gRPC Authors · *Intermediate* · why every call, including every stream, needs a deadline, and how they propagate. <https://grpc.io/blog/deadlines/>
- **Google API Design Guide — Streaming and long-running operations** — Google · *Intermediate* · when Google's own guidance says to stream versus paginate versus use an operation resource. <https://cloud.google.com/apis/design/design_patterns>

---

*gRPC with Go Handbook — chapter 05.*
