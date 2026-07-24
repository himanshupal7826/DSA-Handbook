# 17 · Client-Side & Bidirectional Streaming Handlers

> **In one line:** Both shapes give the handler only a stream and a `Recv` loop that ends on `io.EOF` — client streaming replies once with `SendAndClose`, bidi replies whenever it likes, and the entire difficulty is the concurrency rule that exactly one goroutine may `Send` and exactly one may `Recv`.

---

## 1. Overview

Client streaming and bidirectional streaming share a signature shape that differs from the previous two chapters:

```go
// Client streaming: N requests in, ONE response out.
func (s *Service) BulkAdjustStock(stream pb.InventoryService_BulkAdjustStockServer) error

// Bidirectional: N in, M out, independently.
func (s *Service) SyncInventory(stream pb.InventoryService_SyncInventoryServer) error
```

There is **no request parameter** — there is no single request to hand over — and no response return value. Everything happens through the stream, and the handler communicates completion by returning.

The pivotal detail in both is `io.EOF` from `Recv`. It means *the client half-closed cleanly*, which is a **success signal, not an error**. Treating it as an error is one of the two symmetric bugs; treating any error as end-of-stream is the other. Both appear in code review constantly.

The pivotal difference between the two shapes is **coupling**. Client streaming is a funnel: consume everything, reply once. One goroutine suffices, and the handler is essentially a loop. Bidirectional streaming has two *independent* directions — the server may push a message that answers no request, and response *k* has no defined relationship to request *k* — which means real concurrency, and therefore the concurrency rules become load-bearing rather than academic.

This chapter covers both, in the order of difficulty, and spends most of its weight on the bidi concurrency patterns because that is where production bugs actually live.

## 2. Core Concepts

- **Client-streaming handler** — `func(Stream) error`; loop `Recv` until `io.EOF`, then `SendAndClose(resp)`.
- **Bidi handler** — `func(Stream) error`; `Send` and `Recv` may interleave freely and independently.
- **`io.EOF` from `Recv`** — the client half-closed. Success. Not an error.
- **`SendAndClose(resp)`** — client-streaming only: sends the single response and ends the stream.
- **Half-close** — the client's `CloseSend()`; maps to `END_STREAM` on its last DATA frame.
- **Concurrency rule** — one goroutine may `Send` while another `Recv`s; **never** two `Send`s or two `Recv`s.
- **`stream.Context()`** — cancelled when the RPC ends. The only context to use.
- **Correlation id** — an application-level field pairing bidi responses with requests, since ordering does not.
- **Per-message idempotency** — a client-supplied id per message so a resumed upload does not double-apply.
- **Message budget** — a hard cap on messages per call; otherwise one client can occupy a handler indefinitely.
- **`errgroup`** — the idiomatic way to run the two directions and propagate the first error.

## 3. Theory & Principles

### Client streaming: the funnel

The handler shape is fixed and simple:

```go
for {
    req, err := stream.Recv()
    if errors.Is(err, io.EOF) {
        return stream.SendAndClose(summary)   // the ONLY success path
    }
    if err != nil {
        return err                            // real failure; already a status
    }
    process(req)
}
```

Three properties fall out:

- **`SendAndClose` is called exactly once**, on the `io.EOF` branch. Calling it inside the loop, or twice, is a protocol violation.
- **The server can end early.** Returning an error before the client has finished sending is legal; the client's next `Send` returns `io.EOF` and the real status comes from `CloseAndRecv`. This is how you enforce a message budget.
- **There are no per-message acknowledgements.** If the client needs to know that message 400 was accepted, client streaming is the wrong shape — that requirement is what bidi exists for.

The design question client streaming always raises is **atomicity**. Applying incrementally means a mid-stream failure leaves partial work; buffering everything to apply atomically reintroduces the unbounded memory problem the stream was meant to solve, holds a transaction open for the duration of a slow upload, and still cannot survive a server restart. The honest resolutions are: apply incrementally with per-message idempotency and report precisely what succeeded (right for a scanner uploading a shift), or do not use client streaming at all and take a bounded batch in a unary call inside one transaction (right for a financial ledger).

### Bidirectional streaming: two independent directions

The mental model people arrive with is request/response pairs. It is wrong. The two directions are separate byte streams on one HTTP/2 stream, and:

- The server may send **before** receiving anything.
- The server may send **several** messages for one request, or none.
- The server may send **unsolicited** messages — heartbeats, corrections, cancellations.
- The client may half-close and keep receiving.

Therefore **pairing must be explicit**, via a correlation id in the messages (chapter 11). Any code that assumes the *n*th response answers the *n*th request works in a demo and breaks the first time the server sends a heartbeat.

There are two implementation shapes, and choosing correctly avoids most of the difficulty:

**Shape A — single goroutine (request/response bidi).** If the server only ever sends in response to a received message, one loop suffices:

```go
for {
    req, err := stream.Recv()
    if errors.Is(err, io.EOF) { return nil }
    if err != nil { return err }
    if err := stream.Send(respond(req)); err != nil { return err }
}
```

This is safe by construction — one goroutine, so the concurrency rules cannot be violated — and it is the right choice far more often than people assume. Reach for it first.

**Shape B — two goroutines (truly full duplex).** Needed only when the server sends unsolicited messages: heartbeats, server-initiated commands, or responses produced by an asynchronous worker. Now one goroutine `Recv`s and one `Send`s, and four rules become mandatory:

1. **Exactly one goroutine ever calls `Send`.** Not "usually one".
2. **Exactly one goroutine ever calls `Recv`.**
3. **The handler must not return until both goroutines have stopped.** Returning terminates the stream, and a `Send` in flight afterwards is a use-after-free.
4. **The stream's context governs both.** Derive a cancellable child so either side's failure stops the other.

The idiomatic Go implementation is `golang.org/x/sync/errgroup`: `g.Go` for the receive loop, the send loop in the handler's own goroutine (so it cannot return early), and `g.Wait()` to join and surface the first error.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="cb1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="cb2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Two bidi shapes: pick the simple one first</text>

  <rect x="24" y="42" width="410" height="212" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Shape A &#8212; single goroutine</text>
  <text x="229" y="82" text-anchor="middle" fill="#166534" font-size="10">server sends ONLY in response to a received message</text>

  <line x1="80" y1="96" x2="80" y2="212" stroke="#94a3b8" stroke-dasharray="4 4"/>
  <line x1="380" y1="96" x2="380" y2="212" stroke="#94a3b8" stroke-dasharray="4 4"/>
  <text x="80" y="94" text-anchor="middle" fill="#334155" font-size="9">client</text>
  <text x="380" y="94" text-anchor="middle" fill="#334155" font-size="9">server</text>
  <path d="M80,112 L374,112" stroke="#2563eb" stroke-width="1.8" marker-end="url(#cb1)"/>
  <path d="M380,132 L86,132" stroke="#16a34a" stroke-width="1.8" marker-end="url(#cb2)"/>
  <path d="M80,152 L374,152" stroke="#2563eb" stroke-width="1.8" marker-end="url(#cb1)"/>
  <path d="M380,172 L86,172" stroke="#16a34a" stroke-width="1.8" marker-end="url(#cb2)"/>
  <text x="229" y="196" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">SAFE BY CONSTRUCTION</text>
  <text x="229" y="212" text-anchor="middle" fill="#166534" font-size="10">one goroutine &#8594; concurrency rules cannot be broken</text>
  <text x="44" y="236" fill="#166534" font-size="10">for { req := Recv(); Send(respond(req)) }</text>
  <text x="44" y="250" fill="#15803d" font-size="10" font-weight="bold">Reach for this first &#8212; it fits more often than people assume.</text>

  <rect x="446" y="42" width="410" height="212" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Shape B &#8212; two goroutines</text>
  <text x="651" y="82" text-anchor="middle" fill="#6d28d9" font-size="10">server pushes heartbeats / corrections / async results</text>

  <line x1="502" y1="96" x2="502" y2="212" stroke="#94a3b8" stroke-dasharray="4 4"/>
  <line x1="802" y1="96" x2="802" y2="212" stroke="#94a3b8" stroke-dasharray="4 4"/>
  <text x="502" y="94" text-anchor="middle" fill="#334155" font-size="9">client</text>
  <text x="802" y="94" text-anchor="middle" fill="#334155" font-size="9">server</text>
  <path d="M802,110 L508,110" stroke="#16a34a" stroke-width="1.8" marker-end="url(#cb2)"/>
  <text x="656" y="106" text-anchor="middle" fill="#5b21b6" font-size="8">unsolicited heartbeat</text>
  <path d="M502,130 L796,130" stroke="#2563eb" stroke-width="1.8" marker-end="url(#cb1)"/>
  <path d="M502,146 L796,146" stroke="#2563eb" stroke-width="1.8" marker-end="url(#cb1)"/>
  <path d="M802,166 L508,166" stroke="#16a34a" stroke-width="1.8" marker-end="url(#cb2)"/>
  <path d="M802,182 L508,182" stroke="#16a34a" stroke-width="1.8" marker-end="url(#cb2)"/>
  <text x="651" y="204" text-anchor="middle" fill="#5b21b6" font-size="10" font-weight="bold">responses do NOT pair with requests by order</text>
  <text x="466" y="228" fill="#6d28d9" font-size="10">Use a correlation_id field. Ordering pairs nothing.</text>
  <text x="466" y="244" fill="#5b21b6" font-size="10" font-weight="bold">errgroup: Recv loop in g.Go, Send loop in the handler.</text>

  <rect x="24" y="272" width="832" height="216" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="294" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">The four concurrency rules &#8212; violations are data races, not style issues</text>
  <g font-size="10">
    <text x="48" y="320" fill="#7f1d1d" font-weight="bold">1.</text>
    <text x="72" y="320" fill="#991b1b">EXACTLY one goroutine ever calls Send. Not "usually one". Two concurrent Sends corrupt the stream.</text>
    <text x="48" y="342" fill="#7f1d1d" font-weight="bold">2.</text>
    <text x="72" y="342" fill="#991b1b">EXACTLY one goroutine ever calls Recv. Same reason.</text>
    <text x="48" y="364" fill="#7f1d1d" font-weight="bold">3.</text>
    <text x="72" y="364" fill="#991b1b">The handler must NOT return until both goroutines have stopped &#8212; returning terminates the stream,</text>
    <text x="72" y="380" fill="#991b1b">and a Send still in flight afterwards is a use-after-free.</text>
    <text x="48" y="402" fill="#7f1d1d" font-weight="bold">4.</text>
    <text x="72" y="402" fill="#991b1b">Derive a cancellable child of stream.Context() so either direction's failure stops the other.</text>
  </g>
  <text x="48" y="432" fill="#15803d" font-size="10" font-weight="bold">Safe pairing that satisfies all four:</text>
  <text x="48" y="450" fill="#166534" font-family="ui-monospace,monospace" font-size="10">g, ctx := errgroup.WithContext(stream.Context())</text>
  <text x="48" y="466" fill="#166534" font-family="ui-monospace,monospace" font-size="10">g.Go(recvLoop)          // ONE Recv caller</text>
  <text x="48" y="482" fill="#166534" font-family="ui-monospace,monospace" font-size="10">sendLoop()              // ONE Send caller, in the handler's own goroutine</text>
</svg>
```

### `io.EOF` on `Send`, and why it is not what you expect

On the **client** side, `stream.Send` returning `io.EOF` means *the server closed the stream early*, and the real status must be retrieved from `CloseAndRecv` (client streaming) or `Recv` (bidi). This asymmetry catches people: `io.EOF` from `Recv` is success, `io.EOF` from `Send` means "stop sending and go get the actual error".

On the **server** side, `stream.Send` returning an error means the stream is broken; return it unchanged, because it already carries a status.

## 4. Architecture & Workflow

**Choosing between the shapes:**

1. Does the caller need a per-message acknowledgement? → **bidi**, not client streaming.
2. Does the server need to push unsolicited messages? → **bidi, shape B**.
3. Otherwise, if the server only responds to received messages → **bidi, shape A**.
4. If a single summary at the end suffices → **client streaming**.
5. If the input is bounded and atomicity is required → **not a stream at all**; a unary call with a bounded batch inside one transaction.

**Bounding a streaming handler.** Every stream handler needs three explicit limits, because none is provided by default:

- **Message count** — return `ResourceExhausted` past a budget.
- **Stream lifetime** — return `Unavailable` with a reconnect hint (chapter 16).
- **Per-message size** — `MaxRecvMsgSize` covers bytes; add semantic bounds on repeated fields.

Without them one client can occupy a handler goroutine, a database connection and a slot in `MaxConcurrentStreams` for as long as it likes.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="cf1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">io.EOF means different things on Recv and Send</text>

  <rect x="24" y="42" width="410" height="164" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Recv() &#8594; io.EOF</text>
  <text x="229" y="86" text-anchor="middle" fill="#166534" font-size="11" font-weight="bold">the peer half-closed cleanly = SUCCESS</text>
  <text x="44" y="112" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">req, err := stream.Recv()</text>
  <text x="44" y="130" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">if errors.Is(err, io.EOF) {</text>
  <text x="44" y="148" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">    return stream.SendAndClose(summary)</text>
  <text x="44" y="166" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">}</text>
  <text x="44" y="190" fill="#166534" font-size="10">Treating this as an error is bug #1. Treating any error</text>
  <text x="44" y="204" fill="#166534" font-size="10">as end-of-stream is bug #2. Both are common.</text>

  <rect x="446" y="42" width="410" height="164" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Send() &#8594; io.EOF  (client side)</text>
  <text x="651" y="86" text-anchor="middle" fill="#b45309" font-size="11" font-weight="bold">the SERVER closed early &#8212; go get the real status</text>
  <text x="466" y="112" fill="#7c2d12" font-family="ui-monospace,monospace" font-size="10">if err := stream.Send(m); err != nil {</text>
  <text x="466" y="130" fill="#7c2d12" font-family="ui-monospace,monospace" font-size="10">    if errors.Is(err, io.EOF) { break }</text>
  <text x="466" y="148" fill="#7c2d12" font-family="ui-monospace,monospace" font-size="10">    return err</text>
  <text x="466" y="166" fill="#7c2d12" font-family="ui-monospace,monospace" font-size="10">}</text>
  <text x="466" y="190" fill="#b45309" font-size="10">The actual error arrives from CloseAndRecv (client stream)</text>
  <text x="466" y="204" fill="#b45309" font-size="10">or Recv (bidi). Send's io.EOF carries no status itself.</text>

  <rect x="24" y="224" width="832" height="184" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="246" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Choosing a shape</text>

  <rect x="48" y="262" width="380" height="30" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="60" y="282" fill="#5b21b6" font-size="10">Per-message acknowledgement needed?</text>
  <text x="410" y="282" text-anchor="end" fill="#5b21b6" font-size="10" font-weight="bold">&#8594; bidi</text>

  <rect x="48" y="298" width="380" height="30" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="60" y="318" fill="#5b21b6" font-size="10">Server pushes unsolicited messages?</text>
  <text x="410" y="318" text-anchor="end" fill="#5b21b6" font-size="10" font-weight="bold">&#8594; bidi, shape B</text>

  <rect x="48" y="334" width="380" height="30" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="60" y="354" fill="#15803d" font-size="10">Server replies only to received messages?</text>
  <text x="410" y="354" text-anchor="end" fill="#15803d" font-size="10" font-weight="bold">&#8594; bidi, shape A</text>

  <rect x="452" y="262" width="380" height="30" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="464" y="282" fill="#92400e" font-size="10">One summary at the end suffices?</text>
  <text x="814" y="282" text-anchor="end" fill="#92400e" font-size="10" font-weight="bold">&#8594; client streaming</text>

  <rect x="452" y="298" width="380" height="30" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="464" y="318" fill="#b91c1c" font-size="10">Bounded input AND atomicity required?</text>
  <text x="814" y="318" text-anchor="end" fill="#b91c1c" font-size="10" font-weight="bold">&#8594; NOT a stream</text>

  <text x="464" y="352" fill="#991b1b" font-size="10">A unary call with a bounded batch inside one transaction.</text>
  <text x="464" y="368" fill="#991b1b" font-size="10">Buffering a whole stream to fake atomicity reintroduces</text>
  <text x="464" y="384" fill="#991b1b" font-size="10">the unbounded memory problem streaming was meant to solve.</text>
</svg>
```

## 5. Implementation

### Client streaming: bulk upload with idempotency and a budget

```go
package inventory

import (
	"errors"
	"io"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"

	inventoryv1 "github.com/acme/apis/gen/go/acme/inventory/v1"
)

const (
	maxBulkMessages = 10_000
	maxRejections   = 100 // cap the response too — it is a repeated field
)

// BulkAdjustStock consumes a stream of adjustments and returns one summary.
//
// The handler receives ONLY the stream: there is no single request to pass.
// Adjustments are applied incrementally, NOT atomically — documented in the
// .proto, and the reason each message carries its own idempotency id.
func (s *Service) BulkAdjustStock(
	stream inventoryv1.InventoryService_BulkAdjustStockServer,
) error {
	ctx := stream.Context()
	started := time.Now()

	principal, ok := PrincipalFromContext(ctx)
	if !ok {
		return status.Error(codes.Internal, "internal error")
	}

	var (
		applied    int32
		rejected   int32
		duplicates int32
		rejections []*inventoryv1.RejectedAdjustment
	)

	for count := 0; ; count++ {
		// A message budget. Without it one client occupies a handler goroutine,
		// a DB connection and a MaxConcurrentStreams slot indefinitely.
		// Returning early is legal: the client's next Send gets io.EOF and the
		// real status arrives from CloseAndRecv.
		if count >= maxBulkMessages {
			return status.Errorf(codes.ResourceExhausted,
				"too many messages in one call (max %d); split the upload", maxBulkMessages)
		}

		req, err := stream.Recv()

		// io.EOF = the client half-closed = SUCCESS. This is the ONLY path
		// that calls SendAndClose, and it is called exactly once.
		if errors.Is(err, io.EOF) {
			return stream.SendAndClose(&inventoryv1.BulkAdjustSummary{
				Applied:          applied,
				Rejected:         rejected,
				DuplicateIgnored: duplicates,
				Rejections:       rejections,
				ProcessingTime:   durationpb.New(time.Since(started)),
			})
		}
		if err != nil {
			// A real transport or status failure. It already carries a status;
			// returning it unchanged preserves the code.
			return err
		}

		// Per-message validation. A bad message rejects that message, not the
		// whole upload — which is the point of reporting a summary.
		if req.GetSku() == "" || req.GetAdjustmentId() == "" {
			rejected++
			appendRejection(&rejections, req, "sku and adjustment_id are required")
			continue
		}
		if !principal.MayAdjust(req.GetSku()) {
			rejected++
			appendRejection(&rejections, req, "not permitted")
			continue
		}

		// Per-message idempotency: a resumed upload must not double-apply.
		// This is why the id is in the schema rather than bolted on later.
		switch err := s.store.ApplyAdjustment(ctx, AdjustmentParams{
			ID:         req.GetAdjustmentId(),
			SKU:        req.GetSku(),
			Delta:      req.GetDelta(),
			Reason:     req.GetReason().String(),
			ObservedAt: req.GetObservedAt().AsTime(),
			Principal:  principal.ID,
		}); {
		case err == nil:
			applied++

		case errors.Is(err, ErrDuplicateAdjustment):
			duplicates++ // already applied; not an error

		case errors.Is(err, ErrNotFound):
			rejected++
			appendRejection(&rejections, req, "sku does not exist")

		case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
			// Abandon the whole call: the caller is gone or out of budget.
			return status.FromContextError(err).Err()

		default:
			// An unexpected failure aborts the call rather than silently
			// degrading into a stream of rejections.
			s.log.ErrorContext(ctx, "apply adjustment failed",
				"err", err, "sku", req.GetSku(), "adjustment_id", req.GetAdjustmentId())
			return status.Error(codes.Internal, "internal error")
		}
	}
}

func appendRejection(dst *[]*inventoryv1.RejectedAdjustment, req *inventoryv1.AdjustStockRequest, reason string) {
	// Bound the response too: a client sending 10,000 bad rows must not get a
	// 10,000-element response. The counts still tell the whole story.
	if len(*dst) >= maxRejections {
		return
	}
	*dst = append(*dst, &inventoryv1.RejectedAdjustment{
		Sku: req.GetSku(), AdjustmentId: req.GetAdjustmentId(), Reason: reason,
	})
}
```

### Bidi shape A: single goroutine (request/response)

```go
// SyncInventory in its simple form: the server responds to each received
// message and never pushes anything unsolicited.
//
// One goroutine means the concurrency rules cannot be violated. Prefer this
// shape whenever it fits.
func (s *Service) SyncInventory(
	stream inventoryv1.InventoryService_SyncInventoryServer,
) error {
	ctx := stream.Context()

	for count := 0; ; count++ {
		if count >= maxSyncMessages {
			return status.Errorf(codes.ResourceExhausted,
				"message budget exceeded (max %d)", maxSyncMessages)
		}

		req, err := stream.Recv()
		if errors.Is(err, io.EOF) {
			return nil // client half-closed; finish cleanly with OK
		}
		if err != nil {
			return err
		}

		resp, err := s.handleSyncMessage(ctx, req)
		if err != nil {
			return err
		}
		if resp == nil {
			continue // some messages (acks) warrant no reply
		}

		if err := stream.Send(resp); err != nil {
			return err
		}
	}
}
```

### Bidi shape B: two goroutines, full duplex

```go
import "golang.org/x/sync/errgroup"

// SyncInventoryFullDuplex is the shape needed when the server pushes
// unsolicited messages: heartbeats, corrections from another operator, or
// results produced asynchronously.
//
// The four rules, satisfied structurally:
//   1. exactly ONE goroutine calls Send  (the loop in this function)
//   2. exactly ONE goroutine calls Recv  (the errgroup goroutine)
//   3. the handler cannot return with a Send in flight, because the Send loop
//      IS this function; g.Wait() then joins the receive loop
//   4. errgroup.WithContext cancels both directions on the first failure
func (s *Service) SyncInventoryFullDuplex(
	stream inventoryv1.InventoryService_SyncInventoryServer,
) error {
	g, ctx := errgroup.WithContext(stream.Context())

	// Work flows from the receive loop to the send loop through a bounded
	// channel. Bounded, so a fast client cannot make us buffer without limit —
	// when it fills, Recv stops, the flow-control window closes, and the
	// client's Send blocks. Backpressure end to end.
	work := make(chan *inventoryv1.SyncRequest, 32)

	// ---- Receive loop: the ONLY caller of Recv ----------------------------
	g.Go(func() error {
		defer close(work) // signals the send loop that input is finished

		for count := 0; ; count++ {
			if count >= maxSyncMessages {
				return status.Errorf(codes.ResourceExhausted,
					"message budget exceeded (max %d)", maxSyncMessages)
			}

			req, err := stream.Recv()
			if errors.Is(err, io.EOF) {
				return nil // client half-closed; it may still be receiving
			}
			if err != nil {
				return err
			}

			select {
			case work <- req:
			case <-ctx.Done():
				return status.FromContextError(ctx.Err()).Err()
			}
		}
	})

	// ---- Send loop: the ONLY caller of Send, in THIS goroutine -------------
	// Running it here rather than in another g.Go is deliberate: the handler
	// physically cannot return while a Send is in progress.
	sendErr := func() error {
		heartbeat := time.NewTicker(syncHeartbeatEvery)
		defer heartbeat.Stop()

		lifetime := time.NewTimer(maxSyncStreamAge)
		defer lifetime.Stop()

		for {
			select {
			case <-ctx.Done():
				return status.FromContextError(ctx.Err()).Err()

			case <-lifetime.C:
				return status.Errorf(codes.Unavailable,
					"stream lifetime of %s exceeded; reconnect", maxSyncStreamAge)

			case <-heartbeat.C:
				// UNSOLICITED: answers no request. Impossible in shape A, and
				// precisely why this shape exists.
				if err := stream.Send(&inventoryv1.SyncResponse{
					Payload: &inventoryv1.SyncResponse_Heartbeat{
						Heartbeat: &inventoryv1.ServerHeartbeat{
							SentAt:          timestamppb.Now(),
							StreamRemaining: durationpb.New(remaining(lifetime)),
						},
					},
				}); err != nil {
					return err
				}

			case req, open := <-work:
				if !open {
					// Input finished and drained. Return nil so g.Wait()
					// reports the receive loop's outcome.
					return nil
				}

				resp, err := s.handleSyncMessage(ctx, req)
				if err != nil {
					return err
				}
				if resp == nil {
					continue
				}
				// Echo the correlation id: bidi responses do NOT pair with
				// requests by ordering, and the heartbeats above prove it.
				resp.CorrelationId = req.GetCorrelationId()

				if err := stream.Send(resp); err != nil {
					return err
				}
			}
		}
	}()

	// Join the receive goroutine BEFORE returning. g.Wait returns the first
	// non-nil error from any goroutine.
	if err := g.Wait(); err != nil {
		return err
	}
	return sendErr
}

// handleSyncMessage dispatches on the oneof. The nil and default cases are
// mandatory: nil means nothing was set, default means a NEWER client sent a
// member this binary was not compiled with.
func (s *Service) handleSyncMessage(
	ctx context.Context,
	req *inventoryv1.SyncRequest,
) (*inventoryv1.SyncResponse, error) {
	switch p := req.GetPayload().(type) {
	case *inventoryv1.SyncRequest_CountReport:
		serverQty, err := s.store.Quantity(ctx, p.CountReport.GetSku())
		if err != nil {
			return nil, status.Errorf(codes.Internal, "read %q failed", p.CountReport.GetSku())
		}
		counted := p.CountReport.GetCountedQuantity()
		return &inventoryv1.SyncResponse{
			Payload: &inventoryv1.SyncResponse_CountResult{
				CountResult: &inventoryv1.CountResult{
					Sku: p.CountReport.GetSku(), ServerQuantity: serverQty,
					CountedQuantity: counted, Discrepancy: serverQty != counted,
					Variance: counted - serverQty,
				},
			},
		}, nil

	case *inventoryv1.SyncRequest_Ack:
		s.store.MarkCorrectionAcked(ctx, p.Ack.GetCorrectionId(), p.Ack.GetApplied())
		return nil, nil // no reply warranted

	case *inventoryv1.SyncRequest_Heartbeat:
		return nil, nil

	case nil:
		return nil, status.Error(codes.InvalidArgument, "payload is required")

	default:
		return nil, status.Errorf(codes.Unimplemented,
			"unsupported payload %T; upgrade this service", p)
	}
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Client streaming**
- *Advantages:* amortises per-call overhead across many messages; server processes incrementally so neither side materialises the whole upload; natural fit for devices uploading accumulated work.
- *Disadvantages:* no per-message acknowledgement; not atomic without buffering everything; not resumable without per-message ids; built-in retry does not apply once the first message is sent.

**Bidirectional streaming**
- *Advantages:* lowest-latency interactive protocol available; independent directions allow server push; flow control in both directions; one authentication and one connection setup for a whole session.
- *Disadvantages:* genuinely concurrent code with rules that are easy to violate; pins a connection; no durability — a dropped connection loses everything in flight; hardest shape to test and to trace.

**Trade-offs**
- *Shape A vs B:* A is safe by construction and sufficient more often than expected; B is required only for unsolicited server messages and costs real concurrency complexity.
- *Incremental vs atomic application:* incremental keeps memory bounded and is resumable with per-message ids; atomic needs buffering, a long transaction, and still fails on restart. If atomicity is mandatory, do not use a stream.
- *Bidi vs a message queue:* bidi gives latency and backpressure; a queue gives durability, replay and fan-out. The deciding question is what happens when the consumer dies.

## 7. Common Mistakes & Best Practices

- **Treating `io.EOF` from `Recv` as an error.** It is the clean half-close — success.
- **Treating any error from `Recv` as end-of-stream.** The symmetric bug; you swallow real failures.
- **Calling `Send` from two goroutines.** A data race and stream corruption, not a style issue.
- **Returning from the handler with a `Send` in flight.** Use-after-free; join every goroutine first.
- **Calling `SendAndClose` inside the loop or more than once.** It belongs on the `io.EOF` branch only.
- **Pairing bidi responses to requests by order.** They are independent; use a correlation id.
- **No message budget.** One client occupies a goroutine, a connection and a stream slot indefinitely.
- **No lifetime cap.** Stalls `GracefulStop`, pins load, outlives tokens.
- **Unbounded internal channels** between the two loops. Bounded channels are what make backpressure reach the client.
- **`context.Background()` instead of `stream.Context()`.** Cancellation never arrives.
- **Missing `nil` and `default` cases on a `oneof` switch.** Both occur in practice during rolling upgrades.
- **Unbounded repeated fields in the response.** A client sending 10,000 bad rows should not receive 10,000 rejections.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `grpcurl -d @` reads newline-delimited JSON from stdin into a client-streaming or bidi method, which is the fastest manual test. For a hang, check in order: did the client call `CloseSend`, is there a deadline, is `stream.Context()` used, and are both loops running (a goroutine dump answers all four).
- **Monitoring.** Per method: active streams, messages received and sent per stream, stream duration, time-since-last-message, message-budget rejections and lifetime expiries. For client streaming also track applied/rejected/duplicate ratios — a rising duplicate rate means clients are retrying, which is the system working, but a rising rejected rate means a client deployed something broken.
- **Security.** Authentication happens once at stream open, so cap lifetime below token validity. Enforce message budgets and per-message authorization — a stream that authorised "adjust warehouse A" must not accept a message for warehouse B. Bound every repeated field in both requests and responses.
- **Scaling.** Each stream holds a goroutine (two in shape B), a `MaxConcurrentStreams` slot and often a database connection, so concurrency limits are capacity planning. Bounded internal channels propagate backpressure to the client rather than accumulating in memory. During deploys, `GracefulStop` waits for every stream — the lifetime cap is what bounds the drain.

## 9. Interview Questions

**Q: What does a client-streaming handler look like, and where does the response go?**
A: The handler receives only the stream — there is no single request to pass — and loops on `Recv` until `io.EOF`, which signals the client half-closed cleanly. On that branch, and only there, it calls `SendAndClose(summary)` exactly once, which sends the single response and terminates the stream. Any other non-nil error from `Recv` is a real failure and is returned unchanged, since it already carries a status.

**Q: What does `io.EOF` mean from `Recv`, and from `Send`?**
A: From `Recv` it means the peer half-closed cleanly — a success signal, and the normal end of a client-streaming or bidi input. From `Send` on the client side it means the *server* closed the stream early, and it carries no status itself: you stop sending and retrieve the real error from `CloseAndRecv` or `Recv`. That asymmetry catches people, and the two symmetric bugs — treating `Recv`'s `io.EOF` as an error, and treating any error as end-of-stream — are both common in review.

**Q: What are the concurrency rules for a bidi stream?**
A: One goroutine may call `Send` while another calls `Recv` — that is the intended full-duplex pattern. But `Send` must never be called concurrently from two goroutines, and neither must `Recv`; each direction must be serialised. The handler must not return until both goroutines have stopped, because returning terminates the stream and a `Send` still in flight is a use-after-free. And both should derive from `stream.Context()` so either direction's failure stops the other.

**Q: When do you need two goroutines for a bidi handler, and when is one enough?**
A: One is enough — and safe by construction — whenever the server only ever sends in response to a received message: a single `Recv`-then-`Send` loop. Two are needed only when the server sends unsolicited messages: heartbeats, corrections initiated elsewhere, or results produced by an asynchronous worker. I reach for the single-goroutine shape first, because it fits more often than people assume and it removes an entire class of bug.

**Q: Why do bidi responses need a correlation id?**
A: Because the two directions are independent byte streams, not request/response pairs. The server may send before receiving anything, send several messages for one request, send none, or send something unsolicited such as a heartbeat. Any code assuming the *n*th response answers the *n*th request works in a demo and breaks the first time a heartbeat arrives. An explicit correlation id in the message makes the pairing real, and an empty one is a natural marker for server-initiated messages.

**Q: Is client streaming atomic?**
A: Not unless you make it so, and making it so is usually the wrong trade. Applying incrementally means a mid-stream failure leaves earlier messages applied, which is why each message should carry its own idempotency id so a resumed upload does not double-apply. Buffering the whole stream to apply atomically reintroduces the unbounded memory problem streaming was meant to solve, holds a transaction open for the duration of a slow upload, and still cannot survive the server restarting. If atomicity is genuinely required, use a unary call taking a bounded batch inside one transaction and let the client chunk.

**Q: How do you stop one client monopolising a streaming handler?**
A: Three explicit limits, none of which exists by default. A message budget, returning `ResourceExhausted` past a cap — and returning early is legal, the client's next `Send` gets `io.EOF` and the real status comes from `CloseAndRecv`. A stream lifetime cap, returning `Unavailable` with a reconnect hint, which also bounds `GracefulStop` and rebalances load. And semantic bounds on repeated fields in both requests and responses, since `MaxRecvMsgSize` counts bytes and 100,000 tiny elements fit comfortably inside it.

**Q: (Senior) Implement a full-duplex bidi handler and justify each structural choice.**
A: I would use `errgroup.WithContext(stream.Context())`, run the receive loop in `g.Go` as the single `Recv` caller, and run the send loop in the handler's own goroutine as the single `Send` caller — the last part is deliberate, because it makes it physically impossible for the handler to return while a `Send` is in flight. The two loops communicate through a *bounded* channel, so a fast client cannot make us buffer without limit: when it fills, `Recv` stops, the flow-control window closes, and the client's `Send` blocks, which is backpressure reaching all the way to the peer. `errgroup.WithContext` cancels both directions on the first failure. The send loop selects over the work channel, a heartbeat ticker and a lifetime timer, so unsolicited messages have a natural home. Closing the work channel when input ends is what tells the send loop to finish, and `g.Wait()` before returning joins the receive goroutine and surfaces the first error. Every `oneof` switch has `nil` and `default` cases, because both occur during rolling upgrades.

**Q: (Senior) A bulk-upload handler occasionally reports fewer applied rows than the client sent, with no errors. Diagnose.**
A: The first thing I would check is whether the summary is being sent at all on every path — if `SendAndClose` is reached only on `io.EOF` but some branch returns early, the client sees a status rather than a summary and may be logging a stale count. Assuming the summary is genuine, the likely causes are: a `continue` in a validation branch that increments `rejected` but the client is only reading `applied`; per-message idempotency counting retries as `duplicate_ignored` rather than `applied`, which is correct behaviour that looks like loss; or a rejections slice capped at 100 so the *detail* is truncated while the counts are right — which is intentional but must be documented or it reads as a bug. The genuinely worrying case is the client sending messages after the server has returned early: the client's `Send` returns `io.EOF`, and if the client ignores that error it silently discards the remainder while believing it uploaded everything. I would confirm by comparing the client's sent count against `applied + rejected + duplicate_ignored` in the summary — if they disagree, messages were sent after the server stopped reading, and the fix is on the client: break on `Send`'s `io.EOF` and always read `CloseAndRecv` for the real status.

**Q: (Senior) When would you choose bidi streaming over a message queue, and what do you give up?**
A: Bidi when latency and backpressure matter more than durability: an interactive session, live collaboration, telemetry with server-side control feedback. It gives sub-millisecond turnaround, per-stream flow control that naturally throttles a fast producer, and a session identity that makes stateful interaction natural. What I give up is everything a log provides — durability, replay, fan-out to independent consumers, and survival across restarts. A dropped connection loses everything in flight, so any at-least-once requirement has to be rebuilt in the application with sequence numbers and acknowledgements, at which point I have written a worse queue. The deciding question is what happens when the consumer dies: if the data is only meaningful live, bidi is right; if every message must eventually be processed, use a log. In practice many systems want both — a bidi stream for the live session and a queue for the durable record.

## 10. Quick Revision & Cheat Sheet

```go
// CLIENT STREAMING
func (s *Svc) Upload(stream pb.Svc_UploadServer) error {
    for count := 0; ; count++ {
        if count >= maxMessages { return status.Error(codes.ResourceExhausted, "…") }
        req, err := stream.Recv()
        if errors.Is(err, io.EOF) { return stream.SendAndClose(summary) }  // ONLY here
        if err != nil { return err }
        process(req)
    }
}

// BIDI shape A — one goroutine, safe by construction
for {
    req, err := stream.Recv()
    if errors.Is(err, io.EOF) { return nil }
    if err != nil { return err }
    if err := stream.Send(respond(req)); err != nil { return err }
}

// BIDI shape B — two goroutines
g, ctx := errgroup.WithContext(stream.Context())
work := make(chan *pb.Req, 32)              // BOUNDED = backpressure
g.Go(func() error { defer close(work); /* the ONLY Recv caller */ })
/* the ONLY Send caller runs HERE, so the handler cannot return mid-Send */
return g.Wait()
```

| Question | Answer |
|---|---|
| `Recv` → `io.EOF` | Peer half-closed. **Success.** |
| `Send` → `io.EOF` (client) | Server closed early; get the status from `CloseAndRecv`/`Recv` |
| `SendAndClose` | Client streaming only, once, on the `io.EOF` branch |
| Two `Send` goroutines | Data race. Never. |
| Handler returns early | Legal — client's `Send` gets `io.EOF` |
| Pair bidi messages | `correlation_id`, never ordering |
| Bounds needed | Message budget · lifetime cap · repeated-field sizes |
| Internal channel | Bounded, always |

**Flash cards**
- **The `io.EOF` rule?** → Success on `Recv`; "go get the real error" on `Send`.
- **How many `Send` goroutines?** → Exactly one. Same for `Recv`.
- **When is one goroutine enough for bidi?** → When the server never sends unsolicited messages.
- **`SendAndClose` where?** → Client streaming, once, on the `io.EOF` branch.
- **Bidi pairing?** → Correlation id. Ordering pairs nothing.
- **Client streaming atomic?** → No. Per-message idempotency instead, or don't use a stream.

## 11. Hands-On Exercises & Mini Project

- [ ] Implement `BulkAdjustStock` and drive it with `grpcurl -d @` feeding newline-delimited JSON from a file.
- [ ] Write a client that forgets `CloseSend()`. Observe the hang, capture goroutine dumps on both sides, then fix it.
- [ ] Return `ResourceExhausted` from the server at message 100 while the client sends 1,000. Verify the client's `Send` starts returning `io.EOF` and that the real status arrives from `CloseAndRecv`.
- [ ] Call `Send` from two goroutines in a bidi handler and run with `-race`. Read the report, then fix it with a single sender.
- [ ] Implement bidi shape A, then extend it to shape B by adding heartbeats. Note exactly what forced the change.
- [ ] Replace the bounded work channel with an unbounded one and drive it with a fast client and a slow processor. Watch memory grow, then restore the bound and watch the client's `Send` block instead.
- [ ] Send a `oneof` member the server was not compiled with and confirm the `default` branch fires with `Unimplemented`.

### Mini Project — "Interactive Reconciliation Service"

**Goal.** Build a bidi service that survives disconnects, slow consumers and rolling deploys, and prove each property with a test rather than a claim.

**Requirements.**
1. A bidi `Sync` method where the client reports counts and the server replies with discrepancies, plus server-initiated corrections and heartbeats — forcing shape B.
2. Correlation ids on every paired message, empty on server-initiated ones, with a test asserting responses arrive out of order relative to requests and are still matched correctly.
3. `errgroup` with exactly one `Send` caller and one `Recv` caller, a bounded work channel, and a `-race` test under concurrent load.
4. A message budget, a stream lifetime cap with an `Unavailable` reconnect hint, and bounds on every repeated field.
5. A client-streaming `BulkUpload` companion with per-message idempotency, and a test that replays the same upload twice and asserts no double-application.
6. Metrics for active streams, messages in/out, stream duration, time-since-last-message, budget rejections and lifetime expiries.
7. A chaos test: kill the server mid-stream during a rolling restart and assert the client reconnects and the final reconciled state matches the source of truth.

**Extensions.**
- Add per-message authorization so a stream authorised for one warehouse cannot accept a message for another, with a test.
- Compare the bounded-channel design against an unbounded one under a synthetic slow processor, charting memory and delivered messages for each.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *The Four RPC Patterns* (where these shapes fit), *Server-Side Streaming Handlers* (lifetime caps and backpressure), *HTTP/2 Under gRPC* (flow control and half-close), *Invoking All Four Method Kinds from Go* (the client side of these streams), *Graceful Shutdown* (why every stream needs a cap).

- **gRPC — Core concepts: client streaming and bidirectional streaming** — grpc.io · *Beginner* · the normative semantics of half-close, independence of directions, and where the status is delivered. <https://grpc.io/docs/what-is-grpc/core-concepts/>
- **gRPC Go — Basics tutorial (route guide)** — grpc.io · *Beginner* · the canonical `RecordRoute` (client streaming) and `RouteChat` (bidi) handlers in Go. <https://grpc.io/docs/languages/go/basics/>
- **grpc-go — ServerStream / ClientStream API docs** — gRPC Authors · *Intermediate* · the precise concurrency guarantees for `Send`/`Recv` and what `SendAndClose` does. <https://pkg.go.dev/google.golang.org/grpc#ServerStream>
- **golang.org/x/sync/errgroup** — The Go Authors · *Intermediate* · the group-with-context pattern used for the two-goroutine bidi shape. <https://pkg.go.dev/golang.org/x/sync/errgroup>
- **gRPC over HTTP/2 — protocol specification** — gRPC Authors · *Advanced* · exactly how half-close and trailers are encoded; settles any dispute about `io.EOF` semantics. <https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md>
- **grpc-go examples — route_guide** — gRPC Authors · *Intermediate* · runnable client-streaming and bidi code with correct `io.EOF` handling on both sides. <https://github.com/grpc/grpc-go/tree/master/examples/route_guide>
- **Go Blog — Go Concurrency Patterns: Pipelines and cancellation** — The Go Authors · *Intermediate* · bounded channels, fan-in and the cancellation discipline the bidi shape depends on. <https://go.dev/blog/pipelines>
- **Google AIP-155 — Request identification** — Google · *Intermediate* · designing the per-message idempotency ids that make a resumed upload safe. <https://google.aip.dev/155>

---

*gRPC with Go Handbook — chapter 17.*
