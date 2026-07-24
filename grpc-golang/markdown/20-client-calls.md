# 20 · Invoking All Four Method Kinds from Go

> **In one line:** Unary is a function call; the three streaming kinds are loops with two sentinel rules — `io.EOF` from `Recv` means success, `io.EOF` from `Send` means "stop and go fetch the real error" — and forgetting `CloseSend` is the single most common client hang.

---

## 1. Overview

Chapter 19 built the `ClientConn`. This chapter uses it: creating stubs and invoking every method shape correctly, including the failure paths that tutorials omit.

The generated client interface mirrors the service, with one difference per kind:

```go
type InventoryServiceClient interface {
    // Unary: looks like an ordinary function call.
    GetItem(ctx, *GetItemRequest, ...grpc.CallOption) (*GetItemResponse, error)

    // Server streaming: returns a stream to read from.
    WatchStock(ctx, *WatchStockRequest, ...grpc.CallOption) (grpc.ServerStreamingClient[StockEvent], error)

    // Client streaming: returns a stream to write to. No request parameter.
    BulkAdjustStock(ctx, ...grpc.CallOption) (grpc.ClientStreamingClient[AdjustStockRequest, BulkAdjustSummary], error)

    // Bidirectional: returns a stream for both directions.
    SyncInventory(ctx, ...grpc.CallOption) (grpc.BidiStreamingClient[SyncRequest, SyncResponse], error)
}
```

Three things are true of every call and are the source of most client bugs.

**Every call needs a deadline.** `context.Background()` on an RPC is an unbounded wait, and one slow dependency then becomes a cascading outage. The deadline is not a suggestion — it travels on the wire as `grpc-timeout`, so the server knows the budget and can propagate it downstream.

**Every error is a `status`.** `err != nil` is not enough; you need the code to decide whether to retry, fail over, surface to a user or page someone. `status.FromError` gets it.

**Streams have sentinel semantics.** `io.EOF` from `Recv` is the clean end of the stream — success. `io.EOF` from `Send` means the server closed early and the real status must be retrieved elsewhere. Getting these backwards produces either swallowed errors or false failures.

## 2. Core Concepts

- **Stub** — `pb.NewInventoryServiceClient(conn)`. Cheap, stateless, safe to share; create once alongside the connection.
- **`grpc.CallOption`** — per-call configuration: `grpc.WaitForReady`, `grpc.Header`, `grpc.Trailer`, `grpc.MaxCallRecvMsgSize`, `grpc.CallContentSubtype`.
- **`context.WithTimeout`** — the deadline, encoded as the `grpc-timeout` header.
- **`status.FromError(err)`** — extracts the `*status.Status` with its code, message and details.
- **`stream.Recv()`** — reads the next message; `io.EOF` means the peer half-closed cleanly.
- **`stream.Send(m)`** — writes a message; `io.EOF` means the server closed early.
- **`stream.CloseSend()`** — half-close on the client side; the server's next `Recv` returns `io.EOF`.
- **`stream.CloseAndRecv()`** — client streaming only: half-close *and* wait for the single response.
- **`stream.Header()` / `stream.Trailer()`** — response metadata; `Header()` blocks until headers arrive.
- **`metadata.AppendToOutgoingContext`** — attach request metadata (auth, request id, trace context).
- **Deadline propagation** — passing the *incoming* server context to a downstream call so the budget is shared.

## 3. Theory & Principles

### The deadline is the contract

```go
ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
defer cancel()   // ALWAYS. Not deferring leaks the timer and the context.
```

Two rules that matter more than they look:

**Derive from the caller's context, do not create a fresh one.** In a server handler making a downstream call, `context.WithTimeout(ctx, 2*time.Second)` where `ctx` is the incoming request context gives you the *minimum* of the caller's remaining budget and two seconds — which is what you want. Writing `context.WithTimeout(context.Background(), 2*time.Second)` discards the caller's budget, so you keep working for two seconds after the caller has already given up.

**Budget across a call chain.** If your handler has 1 second and makes three sequential downstream calls, each cannot have 1 second. Divide explicitly, leave headroom for your own work, and expect `DeadlineExceeded` to be your most informative error code when you get it wrong.

### `io.EOF`: two meanings, opposite implications

| Source | Meaning | What to do |
|---|---|---|
| `Recv()` → `io.EOF` | Peer half-closed cleanly | **Success.** Break the loop; the call succeeded. |
| `Recv()` → other error | Real failure | Extract the status; the call failed. |
| `Send()` → `io.EOF` | Server closed early | Stop sending; get the real status from `CloseAndRecv`/`Recv`. |
| `Send()` → other error | Real failure | Return it; it carries a status. |

The `Send` case is the counter-intuitive one. When a server returns early — enforcing a message budget, hitting a validation failure — the client's next `Send` returns `io.EOF` carrying *no status information*. The actual error is retrieved by calling `CloseAndRecv` (client streaming) or continuing to `Recv` (bidi). A client that treats `Send`'s `io.EOF` as success silently discards the remainder of its data and reports success.

### Streaming does not mean the call succeeded

Because `grpc-status` travels in trailers after the body (chapter 2), a server-streaming call can deliver forty messages and then fail. The correct client loop therefore always distinguishes three outcomes:

```go
for {
    msg, err := stream.Recv()
    if errors.Is(err, io.EOF) { return nil }   // success
    if err != nil { return err }               // failure — possibly AFTER data
    handle(msg)
}
```

Code that breaks out of the loop on *any* error, or that ignores the error after processing messages, reports success for a failed call. This is the most common streaming client bug in review.

```svg
<svg viewBox="0 0 880 490" width="100%" height="490" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="cl1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#2563eb"/></marker>
    <marker id="cl2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The four call shapes, client side</text>

  <rect x="24" y="40" width="410" height="200" rx="10" fill="#eff6ff" stroke="#2563eb" stroke-width="2"/>
  <text x="229" y="62" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">1. Unary &#8212; an ordinary function call</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#1d4ed8">
    <text x="42" y="88">ctx, cancel := context.WithTimeout(ctx, 2*time.Second)</text>
    <text x="42" y="106">defer cancel()</text>
    <text x="42" y="128">resp, err := c.GetItem(ctx, req)</text>
    <text x="42" y="146">if err != nil {</text>
    <text x="42" y="164">    st, _ := status.FromError(err)   // ALWAYS get the code</text>
    <text x="42" y="182">}</text>
  </g>
  <text x="42" y="208" fill="#1e40af" font-size="10" font-weight="bold">Derive ctx from the CALLER's context, not Background():</text>
  <text x="42" y="226" fill="#1d4ed8" font-size="10">that gives min(caller's remaining budget, 2s) &#8212; what you want.</text>

  <rect x="446" y="40" width="410" height="200" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="62" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">2. Server streaming &#8212; read until io.EOF</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#166534">
    <text x="464" y="88">stream, err := c.WatchStock(ctx, req)</text>
    <text x="464" y="110">for {</text>
    <text x="464" y="128">    ev, err := stream.Recv()</text>
    <text x="464" y="146">    if errors.Is(err, io.EOF) { return nil }  // SUCCESS</text>
    <text x="464" y="164">    if err != nil { return err }              // failure</text>
    <text x="464" y="182">    handle(ev)</text>
    <text x="464" y="200">}</text>
  </g>
  <text x="464" y="226" fill="#b91c1c" font-size="10" font-weight="bold">A stream can deliver 40 messages and THEN fail &#8212; status is in trailers.</text>

  <rect x="24" y="256" width="410" height="222" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="229" y="278" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">3. Client streaming &#8212; CloseAndRecv or hang</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#b45309">
    <text x="42" y="304">stream, err := c.BulkAdjustStock(ctx)   // no request param</text>
    <text x="42" y="326">for _, a := range adjustments {</text>
    <text x="42" y="344">    if err := stream.Send(a); err != nil {</text>
    <text x="42" y="362">        if errors.Is(err, io.EOF) { break }  // server closed EARLY</text>
    <text x="42" y="380">        return err</text>
    <text x="42" y="398">    }</text>
    <text x="42" y="416">}</text>
    <text x="42" y="434">summary, err := stream.CloseAndRecv()   // half-close + wait</text>
  </g>
  <text x="42" y="460" fill="#b91c1c" font-size="10" font-weight="bold">Forgetting CloseAndRecv/CloseSend = the classic hang.</text>

  <rect x="446" y="256" width="410" height="222" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="651" y="278" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">4. Bidirectional &#8212; two goroutines</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#6d28d9">
    <text x="464" y="304">stream, err := c.SyncInventory(ctx)</text>
    <text x="464" y="326">go func() {              // the ONLY Recv caller</text>
    <text x="464" y="344">    for { resp, err := stream.Recv(); &#8230; }</text>
    <text x="464" y="362">}()</text>
    <text x="464" y="384">for _, r := range reports {    // the ONLY Send caller</text>
    <text x="464" y="402">    stream.Send(r)</text>
    <text x="464" y="420">}</text>
    <text x="464" y="438">stream.CloseSend()       // then WAIT for the recv side</text>
  </g>
  <text x="464" y="464" fill="#b91c1c" font-size="10" font-weight="bold">One Send goroutine, one Recv goroutine. Never two of either.</text>
</svg>
```

### Metadata and call options

Request metadata is attached to the context; response metadata comes back through call options or stream methods:

```go
// Outgoing: append to the context before the call.
ctx = metadata.AppendToOutgoingContext(ctx,
    "x-request-id", reqID,
    "authorization", "Bearer "+token)

// Incoming (unary): capture with call options.
var header, trailer metadata.MD
resp, err := c.GetItem(ctx, req, grpc.Header(&header), grpc.Trailer(&trailer))

// Incoming (streaming): methods on the stream.
hdr, err := stream.Header()    // BLOCKS until headers arrive
trl := stream.Trailer()        // valid only AFTER Recv returns io.EOF or an error
```

Note the ordering constraint on streams: `Trailer()` returns meaningful data only once the stream has ended, because trailers arrive last. Reading it early gives you an empty map, silently.

## 4. Architecture & Workflow

The shape of a well-written client call, in order:

1. **Derive the context** from the caller's, with an explicit timeout, and `defer cancel()`.
2. **Attach metadata** — request id, auth token, trace context (usually done by a client interceptor, chapter 23).
3. **Invoke**, passing any per-call options.
4. **Check the error with `status.FromError`** and branch on the code, not the string.
5. **For streams**, run the correct loop with both sentinel rules, and close the send direction exactly once.
6. **Extract details** from the status where the server attached structured `google.rpc` payloads (chapter 22).

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">io.EOF: two sources, opposite implications</text>

  <rect x="24" y="42" width="410" height="176" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Recv() &#8594; io.EOF  =  SUCCESS</text>
  <text x="42" y="90" fill="#166534">The peer half-closed cleanly. The call completed with OK.</text>
  <text x="42" y="112" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">if errors.Is(err, io.EOF) { return nil }</text>
  <rect x="42" y="128" width="374" height="76" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="229" y="148" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">The bug this prevents</text>
  <text x="56" y="168" fill="#991b1b" font-size="10">if err != nil { return err }   // treats clean EOF as a failure</text>
  <text x="56" y="186" fill="#991b1b" font-size="10">Every successful stream is reported as an error.</text>

  <rect x="446" y="42" width="410" height="176" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Send() &#8594; io.EOF  =  server closed EARLY</text>
  <text x="464" y="90" fill="#b45309">Carries NO status. Stop sending and fetch the real error.</text>
  <text x="464" y="112" fill="#7c2d12" font-family="ui-monospace,monospace" font-size="10">if errors.Is(err, io.EOF) { break }  // then CloseAndRecv</text>
  <rect x="464" y="128" width="374" height="76" rx="6" fill="#fee2e2" stroke="#dc2626"/>
  <text x="651" y="148" text-anchor="middle" fill="#b91c1c" font-size="10" font-weight="bold">The bug this prevents</text>
  <text x="478" y="168" fill="#991b1b" font-size="10">Treating it as success: the client silently discards the</text>
  <text x="478" y="186" fill="#991b1b" font-size="10">rest of its data and reports the upload as complete.</text>

  <rect x="24" y="236" width="832" height="156" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="258" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Budgeting a deadline across a call chain</text>

  <rect x="48" y="274" width="180" height="48" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="138" y="294" text-anchor="middle" fill="#1e40af" font-size="10" font-weight="bold">incoming: 1000 ms</text>
  <text x="138" y="312" text-anchor="middle" fill="#1d4ed8" font-size="9">the caller's grpc-timeout</text>

  <rect x="248" y="274" width="170" height="48" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="333" y="294" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">pricing: 300 ms</text>
  <text x="333" y="312" text-anchor="middle" fill="#166534" font-size="9">WithTimeout(ctx, 300ms)</text>

  <rect x="438" y="274" width="170" height="48" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="523" y="294" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">inventory: 300 ms</text>
  <text x="523" y="312" text-anchor="middle" fill="#166534" font-size="9">WithTimeout(ctx, 300ms)</text>

  <rect x="628" y="274" width="204" height="48" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="730" y="294" text-anchor="middle" fill="#92400e" font-size="10" font-weight="bold">own work + headroom: 400 ms</text>
  <text x="730" y="312" text-anchor="middle" fill="#b45309" font-size="9">never spend the whole budget</text>

  <text x="48" y="348" fill="#7f1d1d" font-weight="bold">context.WithTimeout(ctx, d) yields min(caller's remaining, d) &#8212; which is exactly right.</text>
  <text x="48" y="368" fill="#991b1b">context.WithTimeout(context.Background(), d) DISCARDS the caller's budget: you keep working after they gave up.</text>
  <text x="48" y="386" fill="#475569">Getting the arithmetic wrong shows up as DeadlineExceeded &#8212; your most informative error code.</text>
</svg>
```

## 5. Implementation

### Unary

```go
package client

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"time"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"

	inventoryv1 "github.com/acme/apis/gen/go/acme/inventory/v1"
)

// GetItem demonstrates the full unary pattern: derived deadline, metadata,
// call options for response metadata, and status-based error handling.
func (c *Client) GetItem(ctx context.Context, sku string) (*inventoryv1.Item, error) {
	// Derive from the CALLER's context, so this becomes
	// min(caller's remaining budget, 2s). Using context.Background() here
	// would discard the caller's budget and keep working after they gave up.
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel() // always — otherwise the timer and context leak

	// Request metadata. In practice a client interceptor does this uniformly
	// (chapter 23) so no call site can forget the trace context.
	ctx = metadata.AppendToOutgoingContext(ctx,
		"x-request-id", requestIDFrom(ctx),
	)

	// Capture response metadata with call options.
	var header, trailer metadata.MD

	resp, err := c.inventory.GetItem(ctx,
		&inventoryv1.GetItemRequest{Sku: sku},
		grpc.Header(&header),
		grpc.Trailer(&trailer),
	)
	if err != nil {
		return nil, c.classify(err, "GetItem", sku)
	}

	if v := header.Get("x-cache"); len(v) > 0 {
		c.metrics.CacheHit.WithLabelValues(v[0]).Inc()
	}
	return resp.GetItem(), nil
}

// classify turns a gRPC error into a domain decision. Branching on the CODE,
// never on the message string, is what makes retry and alerting policy work.
func (c *Client) classify(err error, method, arg string) error {
	st, ok := status.FromError(err)
	if !ok {
		// Not a gRPC status: a context error, or a bug in an interceptor.
		return fmt.Errorf("%s: %w", method, err)
	}

	// Structured details, when the server attached them (chapter 22).
	for _, d := range st.Details() {
		switch info := d.(type) {
		case *errdetails.ErrorInfo:
			c.log.Warn("server error detail",
				"method", method, "reason", info.GetReason(),
				"domain", info.GetDomain(), "metadata", info.GetMetadata())
		case *errdetails.RetryInfo:
			// The server told us how long to wait. Honour it rather than
			// guessing with our own backoff.
			c.log.Info("server requested retry delay",
				"after", info.GetRetryDelay().AsDuration())
		}
	}

	switch st.Code() {
	case codes.NotFound:
		return fmt.Errorf("%s %q: %w", method, arg, ErrNotFound)

	case codes.InvalidArgument:
		// Never retryable: the request itself is wrong.
		return fmt.Errorf("%s %q: %w: %s", method, arg, ErrBadRequest, st.Message())

	case codes.PermissionDenied, codes.Unauthenticated:
		return fmt.Errorf("%s: %w", method, ErrForbidden)

	case codes.DeadlineExceeded:
		// We were too slow, OR our budget was too small for the work.
		c.metrics.Timeouts.WithLabelValues(method).Inc()
		return fmt.Errorf("%s: %w", method, ErrTimeout)

	case codes.Unavailable:
		// Infrastructure. Retryable — the service config's retry policy has
		// usually already tried (chapter 21).
		c.metrics.Unavailable.WithLabelValues(method).Inc()
		return fmt.Errorf("%s: %w", method, ErrUnavailable)

	case codes.ResourceExhausted:
		// Rate limited or over quota. Back off; do not hammer.
		return fmt.Errorf("%s: %w", method, ErrThrottled)

	default:
		c.log.Error("unexpected gRPC error",
			"method", method, "code", st.Code(), "msg", st.Message())
		return fmt.Errorf("%s: %w: %s", method, ErrInternal, st.Code())
	}
}
```

### Server streaming

```go
// WatchStock consumes a server stream, with reconnection and resumption.
func (c *Client) WatchStock(
	ctx context.Context,
	skus []string,
	onEvent func(*inventoryv1.StockEvent) error,
) error {
	var resumeToken string

	for {
		err := c.watchOnce(ctx, skus, &resumeToken, onEvent)

		switch {
		case err == nil:
			return nil // the server ended the stream cleanly

		case ctx.Err() != nil:
			return ctx.Err() // WE are shutting down; stop reconnecting

		case status.Code(err) == codes.Unavailable:
			// Expected: the server's lifetime cap, a rolling deploy, or a
			// transient failure. Reconnect from the last token — no gap.
			c.log.Info("watch stream ended; reconnecting",
				"reason", err, "resume_token", resumeToken)
			select {
			case <-time.After(500 * time.Millisecond):
			case <-ctx.Done():
				return ctx.Err()
			}

		case status.Code(err) == codes.OutOfRange:
			// The token is too old. Fall back to a full snapshot rather than
			// silently receiving an incomplete stream.
			c.log.Warn("resume token expired; restarting from snapshot")
			resumeToken = ""

		default:
			return err // genuine failure
		}
	}
}

func (c *Client) watchOnce(
	ctx context.Context,
	skus []string,
	resumeToken *string,
	onEvent func(*inventoryv1.StockEvent) error,
) error {
	// A long deadline, but a deadline. "Forever" is not a valid stream lifetime.
	ctx, cancel := context.WithTimeout(ctx, 35*time.Minute)
	defer cancel()

	stream, err := c.inventory.WatchStock(ctx, &inventoryv1.WatchStockRequest{
		Skus:                   skus,
		ResumeToken:            *resumeToken,
		IncludeInitialSnapshot: *resumeToken == "",
	})
	if err != nil {
		// Failed to ESTABLISH the stream — distinct from failing mid-stream.
		return fmt.Errorf("open watch stream: %w", err)
	}

	// Headers arrive before the first message; this call blocks until they do.
	if hdr, err := stream.Header(); err == nil {
		if v := hdr.Get("x-stream-id"); len(v) > 0 {
			c.log.Info("watch stream established", "stream_id", v[0])
		}
	}

	for {
		ev, err := stream.Recv()

		// io.EOF = the server ended the stream cleanly = SUCCESS.
		if errors.Is(err, io.EOF) {
			return nil
		}

		// Any other error is a real failure — and note it can arrive AFTER
		// many successful messages, because the status is in trailers. A
		// client that breaks out of the loop on any error, or ignores the
		// error once it has data, reports success for a failed call.
		if err != nil {
			return err
		}

		if err := onEvent(ev); err != nil {
			// Our own processing failed. Cancel the stream so the server stops
			// producing rather than blocking on flow control.
			cancel()
			return fmt.Errorf("handle event %q: %w", ev.GetSku(), err)
		}

		// Record the cursor for resumption BEFORE the next Recv.
		if t := ev.GetResumeToken(); t != "" {
			*resumeToken = t
		}
	}
}
```

### Client streaming

```go
// BulkAdjust uploads a batch of adjustments and returns the server's summary.
func (c *Client) BulkAdjust(
	ctx context.Context,
	adjustments []*inventoryv1.AdjustStockRequest,
) (*inventoryv1.BulkAdjustSummary, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	defer cancel()

	// No request parameter: there is no single request to pass.
	stream, err := c.inventory.BulkAdjustStock(ctx)
	if err != nil {
		return nil, fmt.Errorf("open bulk stream: %w", err)
	}

	var sent int
	for _, a := range adjustments {
		if err := stream.Send(a); err != nil {
			// io.EOF here means the SERVER closed early — a message budget, a
			// validation failure, a shutdown. It carries NO status: the real
			// error comes from CloseAndRecv below, so we break rather than
			// return, and we do NOT treat it as success.
			if errors.Is(err, io.EOF) {
				c.log.Warn("server closed the stream early",
					"sent", sent, "total", len(adjustments))
				break
			}
			return nil, fmt.Errorf("send adjustment %d: %w", sent, err)
		}
		sent++
	}

	// CloseAndRecv half-closes the send direction AND waits for the single
	// response. Omitting it is the classic client-streaming hang: the server
	// blocks in Recv until the deadline fires.
	summary, err := stream.CloseAndRecv()
	if err != nil {
		return nil, c.classify(err, "BulkAdjustStock", "")
	}

	// Reconcile: if the server processed fewer than we sent, messages were
	// discarded after it stopped reading. Detect it rather than assuming.
	processed := summary.GetApplied() + summary.GetRejected() + summary.GetDuplicateIgnored()
	if int(processed) != sent {
		c.log.Warn("count mismatch after upload",
			"sent", sent, "processed", processed)
	}
	return summary, nil
}
```

### Bidirectional streaming

```go
// Sync runs an interactive reconciliation session.
//
// The two directions are INDEPENDENT: the server sends heartbeats and
// corrections that answer no request. So responses are matched to requests by
// correlation_id, never by ordering, and receiving runs concurrently with
// sending.
//
// Concurrency rules obeyed:
//   - exactly ONE goroutine calls Send (this one)
//   - exactly ONE goroutine calls Recv (the one below)
//   - we do not return until the receive goroutine has finished
func (c *Client) Sync(
	ctx context.Context,
	reports []*inventoryv1.CountReport,
	onDiscrepancy func(*inventoryv1.CountResult),
) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Minute)
	defer cancel()

	stream, err := c.inventory.SyncInventory(ctx)
	if err != nil {
		return fmt.Errorf("open sync stream: %w", err)
	}

	// ---- Receive goroutine: the ONLY Recv caller -------------------------
	recvDone := make(chan error, 1)
	go func() {
		for {
			resp, err := stream.Recv()
			if errors.Is(err, io.EOF) {
				recvDone <- nil // server finished cleanly
				return
			}
			if err != nil {
				recvDone <- err
				return
			}

			switch p := resp.GetPayload().(type) {
			case *inventoryv1.SyncResponse_CountResult:
				if p.CountResult.GetDiscrepancy() {
					onDiscrepancy(p.CountResult)
				}

			case *inventoryv1.SyncResponse_Correction:
				// UNSOLICITED: correlation_id is empty. Acknowledge it by
				// queueing an ack — but note we cannot Send from here, because
				// that would be a second Send caller. Hand it to the sender.
				c.queueAck(p.Correction.GetCorrectionId())

			case *inventoryv1.SyncResponse_Heartbeat:
				c.metrics.SyncHeartbeats.Inc()

			case nil:
				c.log.Warn("empty sync response payload")

			default:
				// A newer server sent a member we were not compiled with.
				c.log.Warn("unknown sync payload", "type", fmt.Sprintf("%T", p))
			}
		}
	}()

	// ---- Send loop: the ONLY Send caller, in THIS goroutine ---------------
	for _, r := range reports {
		req := &inventoryv1.SyncRequest{
			CorrelationId: newCorrelationID(), // pairing is EXPLICIT, not positional
			Payload:       &inventoryv1.SyncRequest_CountReport{CountReport: r},
		}
		if err := stream.Send(req); err != nil {
			if errors.Is(err, io.EOF) {
				break // server closed early; the real error arrives on recv
			}
			cancel()
			<-recvDone // never return with the receive goroutine still running
			return fmt.Errorf("send count report: %w", err)
		}
	}

	// Half-close our send direction. The server's Recv now returns io.EOF, so
	// it knows no more reports are coming. Omitting this hangs until the
	// deadline.
	if err := stream.CloseSend(); err != nil {
		cancel()
		<-recvDone
		return fmt.Errorf("close send: %w", err)
	}

	// Wait for the receive side to drain and report the final status. The
	// server may still send several messages after our half-close.
	if err := <-recvDone; err != nil {
		return c.classify(err, "SyncInventory", "")
	}
	return nil
}
```

### Per-call options worth knowing

```go
resp, err := c.inventory.GetItem(ctx, req,
	// Queue through TRANSIENT_FAILURE instead of failing fast. Background
	// work only, and ALWAYS with a deadline (chapter 19).
	grpc.WaitForReady(true),

	// Raise the limit for one method known to return large responses,
	// without loosening it globally.
	grpc.MaxCallRecvMsgSize(32<<20),

	// Request gzip for this call. Costs CPU; only worth it for large,
	// compressible payloads over constrained links (chapter 28).
	grpc.UseCompressor(gzip.Name),

	// Capture response metadata.
	grpc.Header(&header),
	grpc.Trailer(&trailer),
)
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Unary calls look like function calls**, so the common case has almost no ceremony.
- **The context parameter is unavoidable**, so deadlines and cancellation are in the vocabulary at every call site.
- **Errors carry machine-readable codes** plus optional structured details, making retry and alerting policy uniform.
- **Streams are explicit objects**, so a million-row response cannot masquerade as a slice.

**Disadvantages**
- **Streaming clients are verbose** — a correct loop is a dozen lines with two sentinel rules.
- **`io.EOF` overloading** is genuinely confusing and produces two symmetric, silent bugs.
- **Nothing enforces a deadline**, so `context.Background()` compiles and hangs.
- **Bidi requires real concurrency**, with rules that are easy to violate.

**Trade-offs**
- *Fail fast vs `WaitForReady`:* per method, never global; user-facing paths want fast errors.
- *Retry in the service config vs in code:* the config handles transport-level failures uniformly (chapter 21); application-level retry is for business conditions and must respect idempotency.
- *Handling streams inline vs a callback:* callbacks (as in `WatchStock` above) keep reconnection logic in one place; inline loops are easier to read but duplicate that logic at every call site.

## 7. Common Mistakes & Best Practices

- **`context.Background()` on an RPC.** An unbounded wait; one slow dependency becomes a cascading outage.
- **Creating a fresh context instead of deriving from the caller's.** Discards the caller's budget, so you work on after they gave up.
- **Forgetting `defer cancel()`.** Leaks the timer and the context.
- **Treating `Recv`'s `io.EOF` as an error.** Every successful stream is then reported as a failure.
- **Treating `Send`'s `io.EOF` as success.** The client silently discards data and reports a complete upload.
- **Forgetting `CloseSend` / `CloseAndRecv`.** The classic hang: the server blocks in `Recv` until the deadline.
- **Ignoring the error after processing stream messages.** A call that failed after delivering data is reported as successful.
- **Calling `Send` or `Recv` from two goroutines.** A data race and stream corruption.
- **Returning from a bidi client while the receive goroutine is still running.** Join it first.
- **Branching on `err.Error()` strings.** Use `status.FromError` and the code.
- **Matching bidi responses by order.** They are independent; use a correlation id.
- **Reading `stream.Trailer()` before the stream ends.** Silently returns an empty map.
- **Creating a stub per call.** Harmless but pointless — stubs are stateless; create them with the connection.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** A hanging client-streaming call is almost always a missing `CloseSend`; a goroutine dump showing the server blocked in `Recv` confirms it in seconds. `GRPC_GO_LOG_VERBOSITY_LEVEL=99` shows the frames, including whether `END_STREAM` was ever sent.
- **Monitoring.** Per method and per code: rate, errors, latency — from a client interceptor so no call site can forget. For streams add messages received, stream duration and reconnection count. A rising reconnection rate with stable errors usually means server-side lifetime caps working as designed; a rising `DeadlineExceeded` rate means your budgets are wrong somewhere.
- **Security.** Tokens belong in metadata attached by an interceptor with `RequireTransportSecurity`, never hand-appended per call where one site will forget. Never log the `authorization` header. Treat resume tokens and page tokens as opaque and do not construct them.
- **Scaling.** Deadlines are load-shedding: a client that gives up promptly releases server goroutines and connections. Budget deliberately across a call chain — total minus your own work, divided among sequential downstreams — and expect `DeadlineExceeded` to be the signal when the arithmetic is wrong.

## 9. Interview Questions

**Q: What does a unary client call look like, and what must you not forget?**
A: `resp, err := client.GetItem(ctx, req, opts...)`. The three things to get right are: derive `ctx` from the caller's context with an explicit timeout and `defer cancel()`; never use `context.Background()`, which is an unbounded wait; and handle the error via `status.FromError` so you branch on the code rather than a message string. Deriving rather than creating matters because `context.WithTimeout(callerCtx, 2*time.Second)` yields the minimum of the caller's remaining budget and two seconds, whereas basing it on `Background` discards the caller's budget entirely.

**Q: What does `io.EOF` mean from `Recv`, and from `Send`?**
A: From `Recv` it means the peer half-closed cleanly — the call succeeded, and you break the loop and return `nil`. From `Send` it means the server closed the stream early, and it carries no status of its own; you stop sending and retrieve the real error from `CloseAndRecv` for client streaming or from the receive side for bidi. The two symmetric bugs are treating `Recv`'s `io.EOF` as an error, which reports every successful stream as a failure, and treating `Send`'s `io.EOF` as success, which silently discards the remaining data and reports a complete upload.

**Q: Why can a server-streaming call fail after delivering messages?**
A: Because the gRPC status travels in HTTP/2 trailers, sent after the body. So a server can emit forty messages and then close with `Internal`. The consequence for clients is that "I received data" never implies "the call succeeded" — the loop must distinguish `io.EOF` (success) from any other error (failure), and code that breaks out on any error, or ignores the error once it has data, reports success for a failed call. It is the most common streaming client bug.

**Q: What is the classic client-streaming hang?**
A: Forgetting `CloseSend` or `CloseAndRecv`. The server sits in `Recv` waiting for a message that never comes, because the client never sent `END_STREAM`, and both sides block until the deadline fires. `CloseAndRecv` does both jobs — half-closes the send direction and waits for the single response — so in client streaming it is the only correct way to finish. A goroutine dump showing the server blocked in `Recv` identifies it immediately.

**Q: How do you write a bidi client correctly?**
A: One goroutine calling `Recv` and one calling `Send`, never two of either. The receive goroutine loops until `io.EOF` or an error and reports its outcome on a channel; the send loop runs in the calling goroutine, then calls `CloseSend` to half-close, then waits on that channel before returning — because returning while the receive goroutine is still running leaks it and loses the final status. Responses are matched to requests by an explicit correlation id, never by ordering, since the server may send heartbeats and other unsolicited messages.

**Q: How do you handle a gRPC error properly on the client?**
A: `status.FromError(err)` to get the `*status.Status`, then switch on `st.Code()`. Branch on the code and never on the message string, because the code is the machine-readable contract that drives retry, fallback and alerting. Where the server attached structured details, iterate `st.Details()` and type-switch on `errdetails.ErrorInfo`, `BadRequest`, `RetryInfo` and so on — `RetryInfo` in particular tells you how long to wait, which is better than guessing with your own backoff.

**Q: How should deadlines be budgeted across a call chain?**
A: Start from the incoming budget, subtract headroom for your own work, and divide the remainder among sequential downstream calls — always by deriving from the incoming context, so each downstream deadline is the minimum of your allocation and whatever the caller has left. If a handler with one second makes three sequential calls, giving each one second is wrong; a common split is a few hundred milliseconds each plus reserve. Getting it wrong surfaces as `DeadlineExceeded`, which is why that code is one of the more informative ones to alert on separately.

**Q: (Senior) Design a resilient streaming client for a live feed.**
A: The core structure is an outer reconnection loop around an inner stream loop. The inner loop opens the stream with a resume token, reads until `io.EOF` or an error, invokes a callback per message, and records the cursor from each message before the next `Recv`. The outer loop inspects the failure: `Unavailable` is expected — a server lifetime cap or a rolling deploy — so it backs off briefly and reconnects from the last token, giving gap-free resumption; `OutOfRange` means the token expired, so it clears the token and falls back to a full snapshot rather than silently receiving an incomplete stream; a cancelled parent context means *we* are shutting down and it stops reconnecting; anything else is a genuine failure and propagates. Every stream gets a deadline slightly longer than the server's cap, so the server's close wins and we see its message. If the callback itself fails I cancel the stream rather than letting the server block on flow control. And I track reconnection count as a metric, because a rising rate with stable error counts is the server's lifetime cap working, while a rising rate with rising errors is a real problem.

**Q: (Senior) A bulk upload reports success but rows are missing. Diagnose.**
A: The most likely cause is that the client treated `Send`'s `io.EOF` as success. When the server returns early — a message budget, a validation failure, a shutdown — the client's next `Send` returns `io.EOF` carrying no status, and code that breaks out and returns `nil` silently discards the remaining messages while reporting a complete upload. The tell is a mismatch between the number the client sent and the totals in the server's summary, which is why I always reconcile `applied + rejected + duplicate_ignored` against the sent count and log a warning on any discrepancy. Two other candidates: the client never called `CloseAndRecv`, so it never received the summary at all and is reporting a stale or zero-valued one; or per-message idempotency is classifying retries as duplicates, which looks like loss but is correct behaviour. I would confirm with a test that makes the server stop at message 100 out of 1,000 and assert the client surfaces an error rather than success — and then keep that test, because this is a bug that reappears.

**Q: (Senior) When do you use `grpc.WaitForReady(true)`, and how do you keep it safe?**
A: For background and best-effort work where a brief blip should not surface as an error: a batch job, an async publisher, a reconciler that will retry anyway. It queues the RPC through `TRANSIENT_FAILURE` rather than failing immediately, which is cheaper than propagating a failure and retrying at a higher layer. It is wrong on user-facing paths, where a fast `Unavailable` lets the caller shed load or serve a fallback, and a slow success is worse than a fast failure. Keeping it safe means always pairing it with a deadline — without one it queues indefinitely, holding a goroutine and memory per call, so a dependency outage becomes a client outage — setting it per method rather than globally in the service config, and monitoring queued-call duration so the behaviour is visible rather than inferred.

## 10. Quick Revision & Cheat Sheet

```go
// UNARY
ctx, cancel := context.WithTimeout(ctx, 2*time.Second); defer cancel()
resp, err := c.GetItem(ctx, req, grpc.Header(&hdr))
if err != nil { st, _ := status.FromError(err); switch st.Code() { … } }

// SERVER STREAMING
s, err := c.WatchStock(ctx, req)
for {
    ev, err := s.Recv()
    if errors.Is(err, io.EOF) { return nil }   // SUCCESS
    if err != nil { return err }               // failure, possibly AFTER data
    handle(ev)
}

// CLIENT STREAMING
s, err := c.BulkAdjustStock(ctx)               // no request param
for _, a := range items {
    if err := s.Send(a); err != nil {
        if errors.Is(err, io.EOF) { break }    // server closed EARLY
        return err
    }
}
summary, err := s.CloseAndRecv()               // half-close + wait. REQUIRED.

// BIDI
s, err := c.SyncInventory(ctx)
go func() { for { r, err := s.Recv(); … } }()  // the ONLY Recv caller
for _, r := range reports { s.Send(r) }        // the ONLY Send caller
s.CloseSend()
<-recvDone                                     // join before returning
```

| Call option | Effect |
|---|---|
| `grpc.WaitForReady(true)` | Queue through `TRANSIENT_FAILURE` (background work + deadline only) |
| `grpc.Header(&md)` / `grpc.Trailer(&md)` | Capture response metadata |
| `grpc.MaxCallRecvMsgSize(n)` | Per-method size override |
| `grpc.UseCompressor(gzip.Name)` | Compress this call |

**Flash cards**
- **`Recv` → `io.EOF`?** → Success. Break and return `nil`.
- **`Send` → `io.EOF`?** → Server closed early. Stop; get the status from `CloseAndRecv`/`Recv`.
- **Client-streaming hang?** → Missing `CloseAndRecv` / `CloseSend`.
- **Deadline from where?** → Derived from the caller's context. Never `Background()`.
- **Error handling?** → `status.FromError` + switch on the code. Never on strings.
- **Bidi pairing?** → `correlation_id`. Never ordering.
- **Bidi concurrency?** → One `Send` goroutine, one `Recv` goroutine, join before returning.

## 11. Hands-On Exercises & Mini Project

- [ ] Call a unary method with `context.Background()` against a server that sleeps 30 seconds. Add a 2-second deadline and observe `DeadlineExceeded` on both sides.
- [ ] Write a streaming client that treats any `Recv` error as end-of-stream. Make the server fail after 50 messages and confirm the client reports success. Fix it.
- [ ] Write a client-streaming client without `CloseAndRecv`. Observe the hang, capture goroutine dumps on both sides, then fix it.
- [ ] Make the server return `ResourceExhausted` at message 100 while the client sends 1,000. Verify `Send` starts returning `io.EOF` and the real status comes from `CloseAndRecv`. Add the sent-vs-processed reconciliation.
- [ ] Build the bidi client from §5, then deliberately call `Send` from two goroutines and run with `-race`.
- [ ] Implement reconnection with resume tokens, kill the server mid-stream, and assert zero lost events.
- [ ] Read `stream.Trailer()` before the stream ends and after, and compare.

### Mini Project — "Complete Client SDK"

**Goal.** Build the client library a consuming team would actually want: every method kind, correct sentinel handling, uniform error classification and observable behaviour.

**Requirements.**
1. A typed SDK wrapping all four method kinds, hiding gRPC types behind domain types and domain errors.
2. Deadlines derived from the caller's context on every call, with per-method defaults and documented budgets.
3. One `classify` function mapping every status code to a domain error, extracting `ErrorInfo`, `BadRequest` and `RetryInfo` details.
4. A streaming consumer with an outer reconnection loop, resume tokens, `OutOfRange` fallback to snapshot, and a test asserting zero gaps across a server restart.
5. A bulk uploader with correct `Send`/`io.EOF` handling and sent-versus-processed reconciliation, plus a test where the server stops early and the client surfaces an error rather than success.
6. A bidi session with correlation ids, one sender, one receiver, and a `-race` test under concurrent load.
7. A client interceptor emitting per-method rate, error-by-code and latency metrics, plus stream reconnection counts.

**Extensions.**
- Add a circuit breaker that opens on sustained `Unavailable` and short-circuits calls, with a test proving load is shed.
- Compare fail-fast against `WaitForReady(true)` for the same workload during a 10-second outage, reporting error counts, p99 and queued-call duration.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *grpc.NewClient, Transport Credentials & Connection Lifecycle* (building the connection these stubs use), *Deadlines, Retries, Service Config & Load Balancing* (retry policy and budgets), *The Error Model* (the codes and details classified here), *Client-Side & Bidirectional Streaming Handlers* (the server side of these streams), *Interceptors* (moving metadata and metrics out of call sites).

- **gRPC Go — Basics tutorial** — grpc.io · *Beginner* · the canonical client code for all four method kinds, including correct `io.EOF` handling. <https://grpc.io/docs/languages/go/basics/>
- **grpc-go — ClientConn, CallOption and ClientStream docs** — gRPC Authors · *Intermediate* · every call option, and the precise semantics of `Send`, `Recv`, `CloseSend` and `CloseAndRecv`. <https://pkg.go.dev/google.golang.org/grpc#CallOption>
- **gRPC — Error handling guide** — grpc.io · *Intermediate* · the status model, `status.FromError`, and how to read structured details on the client. <https://grpc.io/docs/guides/error/>
- **gRPC Blog — Deadlines** — gRPC Authors · *Intermediate* · why every call needs one, how they propagate, and how to budget across a chain. <https://grpc.io/blog/deadlines/>
- **grpc-go examples — route_guide** — gRPC Authors · *Beginner* · runnable clients for all four shapes, with the concurrency structure used in this chapter. <https://github.com/grpc/grpc-go/tree/master/examples/route_guide>
- **grpc-go examples — features/wait_for_ready, cancellation, metadata** — gRPC Authors · *Intermediate* · small programs isolating each call option and its behaviour. <https://github.com/grpc/grpc-go/tree/master/examples/features>
- **google.golang.org/genproto/googleapis/rpc/errdetails** — Google · *Intermediate* · the structured detail types a client should recognise, including `RetryInfo`. <https://pkg.go.dev/google.golang.org/genproto/googleapis/rpc/errdetails>
- **Go Blog — Go Concurrency Patterns: Context** — The Go Authors · *Beginner* · deriving contexts, cancellation propagation and the `defer cancel()` discipline. <https://go.dev/blog/context>

---

*gRPC with Go Handbook — chapter 20.*
