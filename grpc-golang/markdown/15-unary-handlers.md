# 15 · Unary Handlers: Context, Validation & Status Errors

> **In one line:** A unary handler is `func(ctx, *Req) (*Resp, error)` — and everything that makes it production-grade lives in three places: respecting the context, validating before doing work, and returning a deliberate `status` rather than whatever `err` happens to be in scope.

---

## 1. Overview

Unary RPCs are 90% of most services, so the quality of your unary handlers is the quality of your service. The signature is deceptively simple:

```go
func (s *Service) GetItem(ctx context.Context, req *pb.GetItemRequest) (*pb.GetItemResponse, error)
```

Three things arrive with it, and each is routinely mishandled.

**The context** carries the client's deadline (decoded from the `grpc-timeout` header), cancellation when the client goes away, incoming metadata including auth tokens and trace context, and peer information. Ignoring it means your handler keeps burning database connections for a caller that hung up thirty seconds ago.

**The request** is a protobuf message that has been type-checked and nothing more. Protobuf validates types and UTF-8; it does not validate that `sku` is non-empty, that `quantity` is positive, or that `page_size` is under a thousand. Every field is attacker-controlled until you check it.

**The error return** is where most services leak. `return nil, err` sends `codes.Unknown` and puts your internal error string — potentially including a SQL fragment or a file path — on the wire. Mapping domain failures to deliberate status codes is what makes a client's retry logic, alerting and error handling possible at all.

This chapter is the anatomy of a handler that gets all three right, plus the structural question of where validation, authorization and business logic belong relative to interceptors.

## 2. Core Concepts

- **Handler signature** — `func(context.Context, *Req) (*Resp, error)`; the generated interface method you implement.
- **`ctx.Done()` / `ctx.Err()`** — cancellation signal and reason (`context.Canceled` or `context.DeadlineExceeded`).
- **Deadline propagation** — passing the *incoming* `ctx` to downstream calls so the whole call tree shares one budget.
- **`status.Error(code, msg)` / `status.Errorf`** — construct a gRPC error with a deliberate code.
- **`status.FromContextError(err)`** — converts `context.Canceled` → `codes.Canceled` and `context.DeadlineExceeded` → `codes.DeadlineExceeded`.
- **Sentinel errors** — package-level `errors.New` values in the domain layer, mapped to codes at the transport boundary.
- **`metadata.FromIncomingContext(ctx)`** — read request headers (auth, request id, trace context).
- **`grpc.SetHeader` / `grpc.SendHeader` / `grpc.SetTrailer`** — send response metadata.
- **`peer.FromContext(ctx)`** — the client's network address and TLS state.
- **Validation layers** — schema (`protovalidate`), interceptor, handler, domain. Each catches a different class.
- **Idempotency** — recognising a retried mutation via a client-supplied key.

## 3. Theory & Principles

### The four responsibilities of a handler, in order

A good handler reads top to bottom in a fixed order, and the order is not arbitrary — each step is cheaper than the next, so failing early saves work:

1. **Validate the request.** Pure CPU, no I/O. Reject malformed input before it touches anything.
2. **Authorize.** Usually needs identity from metadata (cheap, done in an interceptor) plus sometimes the resource itself (expensive — see below).
3. **Do the work**, passing `ctx` to everything so cancellation propagates.
4. **Map the outcome** to a response or a deliberate status error.

The awkward case is **object-level authorization** — "may this user read *this* item?" — which needs the item, so it cannot happen before the read. The pattern is: read, then authorize, then return. And critically, an unauthorized read of an existing resource and a read of a non-existent resource should usually return the **same** code, or you have built an existence oracle (see §7).

### Context: what it carries and what you owe it

```go
// Everything available from the incoming context:
deadline, ok := ctx.Deadline()          // the client's grpc-timeout
md, _ := metadata.FromIncomingContext(ctx)  // request headers
p, _ := peer.FromContext(ctx)               // client address + TLS info
<-ctx.Done()                                // fires on cancel or deadline
err := ctx.Err()                            // Canceled or DeadlineExceeded
```

The obligations are:

- **Pass `ctx` to every downstream call** — database queries, HTTP requests, other RPCs. This is what makes deadline propagation work: a client's 2-second budget becomes the database query's 2-second budget automatically.
- **Never use `context.Background()` inside a handler** for work the client is waiting on. If you need work to outlive the request (fire-and-forget logging, async publish), use `context.WithoutCancel(ctx)` (Go 1.21+) so you keep values but drop cancellation — and bound it with its own timeout.
- **Check `ctx.Err()` before expensive non-cancellable work.** Most I/O is `ctx`-aware and will return promptly, but a long pure-CPU loop needs explicit checks.
- **Translate context errors faithfully.** `status.FromContextError(ctx.Err()).Err()` yields `Canceled` or `DeadlineExceeded`, which matters because they mean different things operationally: `Canceled` is usually the client giving up, `DeadlineExceeded` is usually you being too slow.

### Error mapping: the discipline that separates services

The rule is that **the domain layer returns domain errors and the transport layer maps them to codes**. Your store should not import `google.golang.org/grpc/codes`.

```go
// internal/inventory/errors.go — domain vocabulary, no gRPC dependency
var (
    ErrNotFound         = errors.New("item not found")
    ErrInsufficientStock = errors.New("insufficient stock")
    ErrVersionConflict  = errors.New("version conflict")
    ErrImmutableField   = errors.New("field is immutable")
)
```

```go
// The handler maps them, once, deliberately.
switch {
case errors.Is(err, ErrNotFound):          return nil, status.Error(codes.NotFound, "item not found")
case errors.Is(err, ErrInsufficientStock): return nil, status.Error(codes.FailedPrecondition, "insufficient stock")
case errors.Is(err, ErrVersionConflict):   return nil, status.Error(codes.Aborted, "item was modified; re-read and retry")
default:
    // Log the real error WITH context; return a generic message.
    s.log.ErrorContext(ctx, "GetItem failed", "err", err, "sku", req.GetSku())
    return nil, status.Error(codes.Internal, "internal error")
}
```

Two rules inside that block. **Never return the raw error string to the client** — it can contain SQL, file paths, hostnames and internal identifiers. **Always log the real error server-side with enough context to find it**, because you have just thrown away the only copy the client would have had.

The full code taxonomy and rich error details are chapter 22; this chapter uses the subset every handler needs.

```svg
<svg viewBox="0 0 880 480" width="100%" height="480" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="uh1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Anatomy of a unary handler: cheapest checks first</text>

  <rect x="30" y="42" width="380" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="220" y="62" text-anchor="middle" fill="#3730a3" font-weight="bold">1. Validate &#8212; pure CPU, no I/O</text>
  <text x="220" y="80" text-anchor="middle" fill="#4338ca" font-size="10">reject malformed input before it touches anything</text>
  <path d="M220,90 L220,110" stroke="#0ea5e9" stroke-width="2" marker-end="url(#uh1)"/>

  <rect x="30" y="114" width="380" height="46" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="220" y="134" text-anchor="middle" fill="#1e40af" font-weight="bold">2. Authorize (identity-level)</text>
  <text x="220" y="152" text-anchor="middle" fill="#1d4ed8" font-size="10">from metadata &#8212; cheap, usually in an interceptor</text>
  <path d="M220,162 L220,182" stroke="#0ea5e9" stroke-width="2" marker-end="url(#uh1)"/>

  <rect x="30" y="186" width="380" height="46" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="220" y="206" text-anchor="middle" fill="#15803d" font-weight="bold">3. Do the work &#8212; pass ctx to EVERYTHING</text>
  <text x="220" y="224" text-anchor="middle" fill="#166534" font-size="10">DB, HTTP, downstream RPC all share the caller's budget</text>
  <path d="M220,234 L220,254" stroke="#0ea5e9" stroke-width="2" marker-end="url(#uh1)"/>

  <rect x="30" y="258" width="380" height="46" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="220" y="278" text-anchor="middle" fill="#92400e" font-weight="bold">3b. Authorize (object-level)</text>
  <text x="220" y="296" text-anchor="middle" fill="#b45309" font-size="10">needs the resource, so it CANNOT come earlier</text>
  <path d="M220,306 L220,326" stroke="#0ea5e9" stroke-width="2" marker-end="url(#uh1)"/>

  <rect x="30" y="330" width="380" height="46" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="220" y="350" text-anchor="middle" fill="#5b21b6" font-weight="bold">4. Map the outcome to a status</text>
  <text x="220" y="368" text-anchor="middle" fill="#6d28d9" font-size="10">deliberate code &#183; generic message &#183; log the real error</text>

  <rect x="436" y="42" width="420" height="196" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="646" y="64" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">What the context carries &#8212; and what you owe it</text>
  <g font-size="10">
    <text x="452" y="88" fill="#334155" font-family="ui-monospace,monospace">ctx.Deadline()</text><text x="620" y="88" fill="#475569">the client's grpc-timeout</text>
    <text x="452" y="106" fill="#334155" font-family="ui-monospace,monospace">metadata.FromIncomingContext</text><text x="620" y="106" fill="#475569">auth, request id, trace</text>
    <text x="452" y="124" fill="#334155" font-family="ui-monospace,monospace">peer.FromContext</text><text x="620" y="124" fill="#475569">client addr + TLS state</text>
    <text x="452" y="142" fill="#334155" font-family="ui-monospace,monospace">ctx.Done() / ctx.Err()</text><text x="620" y="142" fill="#475569">Canceled vs DeadlineExceeded</text>
  </g>
  <text x="452" y="170" fill="#334155" font-weight="bold" font-size="10">You owe it:</text>
  <text x="452" y="188" fill="#475569" font-size="10">&#8226; pass ctx to every downstream call &#8212; that IS deadline propagation</text>
  <text x="452" y="206" fill="#475569" font-size="10">&#8226; never context.Background() for work the client waits on</text>
  <text x="452" y="224" fill="#475569" font-size="10">&#8226; context.WithoutCancel(ctx) for fire-and-forget, with its own timeout</text>

  <rect x="436" y="252" width="420" height="216" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="646" y="274" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Error mapping: the boundary rule</text>
  <rect x="452" y="288" width="180" height="70" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="542" y="308" text-anchor="middle" fill="#7f1d1d" font-size="10" font-weight="bold">domain layer</text>
  <text x="542" y="326" text-anchor="middle" fill="#991b1b" font-size="9">ErrNotFound, ErrVersionConflict</text>
  <text x="542" y="342" text-anchor="middle" fill="#991b1b" font-size="9">does NOT import grpc/codes</text>

  <path d="M636,322 L666,322" stroke="#dc2626" stroke-width="2" marker-end="url(#uh1)"/>

  <rect x="670" y="288" width="170" height="70" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="755" y="308" text-anchor="middle" fill="#7f1d1d" font-size="10" font-weight="bold">transport layer</text>
  <text x="755" y="326" text-anchor="middle" fill="#991b1b" font-size="9">errors.Is &#8594; codes.NotFound</text>
  <text x="755" y="342" text-anchor="middle" fill="#991b1b" font-size="9">one deliberate mapping</text>

  <text x="452" y="382" fill="#991b1b" font-size="10">&#10007; return nil, err        &#8594; codes.Unknown + your SQL string on the wire</text>
  <text x="452" y="402" fill="#166534" font-size="10">&#10003; log the real error server-side WITH context (sku, caller, trace id)</text>
  <text x="452" y="422" fill="#166534" font-size="10">&#10003; return a generic message with a deliberate code</text>
  <text x="452" y="446" fill="#7f1d1d" font-size="10" font-weight="bold">You just threw away the client's only copy &#8212; make sure yours is findable.</text>
</svg>
```

### Where validation belongs

Four layers, each catching a different class of problem:

| Layer | Catches | Cost | Example |
|---|---|---|---|
| **Schema** (`protovalidate`) | Structural: required, ranges, formats, sizes | Free (declared once, enforced in every language) | `sku` matches `^sku_[A-Z0-9]{11}$` |
| **Interceptor** | Everything schema-declared, uniformly | One reflection pass per request | Runs `protovalidate` before any handler |
| **Handler** | Cross-field and request-shape rules | Cheap | "either `sku` or `barcode`, not both" |
| **Domain** | Business invariants needing state | Expensive (I/O) | "cannot reserve more than available" |

The mistake is doing all of it in the handler. Structural rules belong in the schema so every consumer and every language gets them; business invariants belong in the domain so they cannot be bypassed by a second entry point.

## 4. Architecture & Workflow

The full request path, with the layer that owns each concern:

1. **Transport** decodes headers, builds `ctx` with deadline and metadata, spawns a goroutine.
2. **Recovery interceptor** — a panic below this point becomes `Internal`, not a dead process.
3. **Tracing / logging / metrics interceptors** — one span, one log line, one histogram observation per call.
4. **Auth interceptor** — parses the token, puts a principal in `ctx`. Rejects `Unauthenticated` here.
5. **Validation interceptor** — runs `protovalidate` against the request. Rejects `InvalidArgument` here.
6. **Handler** — request-shape checks, then domain calls, then object-level authorization, then response construction.
7. **Domain / store** — business invariants, returning sentinel errors.
8. **Handler** maps the outcome to a status and returns.

The two decisions worth articulating: **auth and validation are interceptors, not handler code**, because they must never be forgotten on a new method; and **object-level authorization is handler code**, because it needs the resource.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Where each concern belongs</text>

  <rect x="30" y="42" width="826" height="150" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="443" y="64" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Four validation layers, cheapest first</text>

  <rect x="48" y="78" width="192" height="98" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="144" y="98" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">1. Schema</text>
  <text x="144" y="116" text-anchor="middle" fill="#166534" font-size="9">protovalidate in the .proto</text>
  <text x="144" y="132" text-anchor="middle" fill="#166534" font-size="9">required &#183; ranges &#183; regex &#183; sizes</text>
  <text x="144" y="152" text-anchor="middle" fill="#15803d" font-size="9" font-weight="bold">enforced in EVERY language</text>
  <text x="144" y="168" text-anchor="middle" fill="#166534" font-size="9">declared once, free thereafter</text>

  <rect x="252" y="78" width="192" height="98" rx="8" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="348" y="98" text-anchor="middle" fill="#1e40af" font-size="11" font-weight="bold">2. Interceptor</text>
  <text x="348" y="116" text-anchor="middle" fill="#1d4ed8" font-size="9">runs the schema rules</text>
  <text x="348" y="132" text-anchor="middle" fill="#1d4ed8" font-size="9">before ANY handler</text>
  <text x="348" y="152" text-anchor="middle" fill="#1e40af" font-size="9" font-weight="bold">impossible to forget</text>
  <text x="348" y="168" text-anchor="middle" fill="#1d4ed8" font-size="9">on a newly added method</text>

  <rect x="456" y="78" width="192" height="98" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="552" y="98" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">3. Handler</text>
  <text x="552" y="116" text-anchor="middle" fill="#b45309" font-size="9">cross-field rules</text>
  <text x="552" y="132" text-anchor="middle" fill="#b45309" font-size="9">"sku OR barcode, not both"</text>
  <text x="552" y="152" text-anchor="middle" fill="#92400e" font-size="9" font-weight="bold">request-shape only</text>
  <text x="552" y="168" text-anchor="middle" fill="#b45309" font-size="9">no I/O, no business rules</text>

  <rect x="660" y="78" width="180" height="98" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="750" y="98" text-anchor="middle" fill="#5b21b6" font-size="11" font-weight="bold">4. Domain</text>
  <text x="750" y="116" text-anchor="middle" fill="#6d28d9" font-size="9">invariants needing state</text>
  <text x="750" y="132" text-anchor="middle" fill="#6d28d9" font-size="9">"cannot reserve &gt; available"</text>
  <text x="750" y="152" text-anchor="middle" fill="#5b21b6" font-size="9" font-weight="bold">cannot be bypassed</text>
  <text x="750" y="168" text-anchor="middle" fill="#6d28d9" font-size="9">by a second entry point</text>

  <rect x="30" y="208" width="826" height="180" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="443" y="230" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">The existence-oracle trap</text>

  <rect x="52" y="244" width="380" height="126" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="242" y="264" text-anchor="middle" fill="#b91c1c" font-weight="bold">Leaks existence</text>
  <text x="66" y="288" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">item, err := store.Get(sku)</text>
  <text x="66" y="304" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">if err != nil { return NotFound }</text>
  <text x="66" y="320" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">if !mayRead(p, item) {</text>
  <text x="66" y="336" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">    return PermissionDenied }</text>
  <text x="66" y="358" fill="#991b1b" font-size="10">An attacker enumerates SKUs by diffing the two codes.</text>

  <rect x="452" y="244" width="382" height="126" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="643" y="264" text-anchor="middle" fill="#15803d" font-weight="bold">Same code for both</text>
  <text x="466" y="288" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">item, err := store.Get(sku)</text>
  <text x="466" y="304" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">if err != nil || !mayRead(p, item) {</text>
  <text x="466" y="320" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">    log the distinction SERVER-SIDE</text>
  <text x="466" y="336" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">    return NotFound }</text>
  <text x="466" y="358" fill="#166534" font-size="10">Client cannot distinguish. Your logs still can.</text>
</svg>
```

## 5. Implementation

### A complete, production-grade unary handler

```go
package inventory

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/peer"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"

	inventoryv1 "github.com/acme/apis/gen/go/acme/inventory/v1"
)

// GetItem returns a single item by SKU.
//
// Errors: INVALID_ARGUMENT for a malformed sku; NOT_FOUND when the item does
// not exist OR the caller may not see it (deliberately indistinguishable);
// INTERNAL for anything else, with the real cause logged server-side.
func (s *Service) GetItem(
	ctx context.Context,
	req *inventoryv1.GetItemRequest,
) (*inventoryv1.GetItemResponse, error) {
	// --- 1. Validate ------------------------------------------------------
	// Cheapest first: pure CPU, no I/O. Structural rules (non-empty, format)
	// ideally come from protovalidate in an interceptor; this is the
	// hand-written fallback and the place for cross-field rules.
	//
	// Always the generated getters: req may be a nil message on a malformed
	// call, and GetSku() is nil-safe where req.Sku panics.
	sku := strings.TrimSpace(req.GetSku())
	if sku == "" {
		return nil, status.Error(codes.InvalidArgument, "sku is required")
	}
	if !validSKU(sku) {
		// Echo the offending value only because it is caller-supplied and
		// non-sensitive. Never echo secrets back in an error.
		return nil, status.Errorf(codes.InvalidArgument,
			"sku %q is malformed; expected the form sku_XXXXXXXXXXX", sku)
	}

	// --- 2. Identity ------------------------------------------------------
	// The auth interceptor already rejected unauthenticated calls and put the
	// principal in the context; here we only read it.
	principal, ok := PrincipalFromContext(ctx)
	if !ok {
		// Defensive: reaching here means the interceptor chain is misconfigured.
		s.log.ErrorContext(ctx, "no principal in context; auth interceptor missing?")
		return nil, status.Error(codes.Internal, "internal error")
	}

	// --- 3. Cheap cancellation check --------------------------------------
	// Most I/O below is ctx-aware and returns promptly on cancellation, so
	// this is belt-and-braces before we take a connection from the pool.
	if err := ctx.Err(); err != nil {
		// Faithful translation: Canceled (client gave up) and DeadlineExceeded
		// (we were too slow) mean very different things on a dashboard.
		return nil, status.FromContextError(err).Err()
	}

	// --- 4. Do the work, propagating ctx ----------------------------------
	// Passing ctx here IS deadline propagation: the caller's 1-second budget
	// becomes this query's 1-second budget, automatically.
	item, err := s.store.Get(ctx, sku)

	// --- 5. Object-level authorization ------------------------------------
	// This needs the item, so it cannot happen before the read. Note that
	// "not found" and "not permitted" collapse into ONE client-visible code,
	// so the API is not an existence oracle. The distinction is preserved in
	// the log, where it belongs.
	switch {
	case errors.Is(err, ErrNotFound):
		s.log.InfoContext(ctx, "item not found", "sku", sku, "principal", principal.ID)
		return nil, status.Error(codes.NotFound, "item not found")

	case err != nil:
		// The real error is logged with everything needed to find it; the
		// client gets a generic message with no SQL, path or hostname in it.
		s.log.ErrorContext(ctx, "store.Get failed",
			"err", err, "sku", sku, "principal", principal.ID)
		return nil, status.Error(codes.Internal, "internal error")

	case !principal.MayRead(item):
		// Same code as NOT_FOUND, deliberately. Logged distinctly.
		s.log.WarnContext(ctx, "read denied", "sku", sku, "principal", principal.ID)
		return nil, status.Error(codes.NotFound, "item not found")
	}

	// --- 6. Optional sparse read ------------------------------------------
	if mask := req.GetReadMask(); mask != nil && len(mask.GetPaths()) > 0 {
		if !mask.IsValid(item) {
			return nil, status.Error(codes.InvalidArgument,
				"read_mask contains a path that does not exist on Item")
		}
		item = applyReadMask(item, mask.GetPaths())
	}

	// --- 7. Response metadata (optional) ----------------------------------
	// Headers must be set BEFORE the response is returned. SetHeader queues
	// them; SendHeader flushes immediately (and can only be called once).
	_ = grpc.SetHeader(ctx, metadata.Pairs(
		"x-cache", "miss",
		"x-item-version", item.GetEtag(),
	))

	return &inventoryv1.GetItemResponse{Item: item}, nil
}
```

### A mutating handler: validation, idempotency, concurrency

```go
// ReserveStock holds units against an order.
//
// IDEMPOTENT via idempotency_key: a repeat with the same key returns the
// original reservation rather than creating a second one. This is what makes
// the client's automatic retry policy safe.
func (s *Service) ReserveStock(
	ctx context.Context,
	req *inventoryv1.ReserveStockRequest,
) (*inventoryv1.ReserveStockResponse, error) {
	// --- Validate ---------------------------------------------------------
	key := req.GetIdempotencyKey()
	if key == "" {
		return nil, status.Error(codes.InvalidArgument, "idempotency_key is required")
	}
	if req.GetOrderId() == "" {
		return nil, status.Error(codes.InvalidArgument, "order_id is required")
	}

	lines := req.GetLines()
	switch {
	case len(lines) == 0:
		return nil, status.Error(codes.InvalidArgument, "at least one line is required")
	case len(lines) > maxReserveLines:
		// Bound every repeated field explicitly. MaxRecvMsgSize is a byte
		// limit, not a semantic one — 100k tiny lines fit inside 4 MiB.
		return nil, status.Errorf(codes.InvalidArgument,
			"too many lines: %d (max %d)", len(lines), maxReserveLines)
	}

	seen := make(map[string]struct{}, len(lines))
	for i, l := range lines {
		if l.GetSku() == "" {
			return nil, status.Errorf(codes.InvalidArgument, "lines[%d].sku is required", i)
		}
		if l.GetQuantity() <= 0 {
			return nil, status.Errorf(codes.InvalidArgument,
				"lines[%d].quantity must be positive, got %d", i, l.GetQuantity())
		}
		// A cross-field rule: exactly the kind of check that belongs in the
		// handler rather than in the schema.
		if _, dup := seen[l.GetSku()]; dup {
			return nil, status.Errorf(codes.InvalidArgument,
				"lines[%d]: duplicate sku %q", i, l.GetSku())
		}
		seen[l.GetSku()] = struct{}{}
	}

	principal, _ := PrincipalFromContext(ctx)

	// --- Idempotency: has this exact call already succeeded? ---------------
	if prior, err := s.store.FindReservationByKey(ctx, key); err == nil {
		if !prior.MatchesRequest(req) {
			// Same key, different body: the client has a bug, and silently
			// returning the old result would hide it.
			return nil, status.Errorf(codes.AlreadyExists,
				"idempotency_key %q was used with a different request", key)
		}
		return reservationToResponse(prior, true /* replay */), nil
	} else if !errors.Is(err, ErrNotFound) {
		s.log.ErrorContext(ctx, "idempotency lookup failed", "err", err, "key", key)
		return nil, status.Error(codes.Internal, "internal error")
	}

	// --- Do the work ------------------------------------------------------
	res, err := s.store.Reserve(ctx, ReserveParams{
		IdempotencyKey: key,
		OrderID:        req.GetOrderId(),
		Lines:          toDomainLines(lines),
		HoldFor:        req.GetHoldFor().AsDuration(),
		Principal:      principal.ID,
	})

	// --- Map the outcome --------------------------------------------------
	switch {
	case err == nil:
		return reservationToResponse(res, false), nil

	case errors.Is(err, ErrNotFound):
		return nil, status.Error(codes.NotFound, "one or more skus do not exist")

	case errors.Is(err, ErrInsufficientStock):
		// FailedPrecondition, not InvalidArgument: the request is well-formed,
		// the SYSTEM STATE forbids it. That distinction drives client retry
		// behaviour — retrying a FailedPrecondition may succeed later, retrying
		// an InvalidArgument never will.
		var short *InsufficientStockError
		if errors.As(err, &short) {
			return nil, insufficientStockStatus(short) // rich details: ch. 22
		}
		return nil, status.Error(codes.FailedPrecondition, "insufficient stock")

	case errors.Is(err, ErrVersionConflict):
		// Aborted signals "retry the whole read-modify-write", which is
		// exactly what a concurrency conflict means.
		return nil, status.Error(codes.Aborted, "concurrent modification; retry")

	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return nil, status.FromContextError(err).Err()

	default:
		s.log.ErrorContext(ctx, "reserve failed",
			"err", err, "key", key, "order_id", req.GetOrderId())
		return nil, status.Error(codes.Internal, "internal error")
	}
}
```

### Reading metadata and peer information

```go
// requestContext extracts the ambient facts a handler may need. In practice
// most of this lives in interceptors; this shows what is available.
func requestContext(ctx context.Context) (requestInfo, error) {
	var info requestInfo

	md, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return info, status.Error(codes.Internal, "no metadata on incoming context")
	}

	// Metadata keys are lowercased by the transport; Get is case-insensitive
	// and returns a slice because a header may legitimately repeat.
	if v := md.Get("x-request-id"); len(v) > 0 {
		info.RequestID = v[0]
	}
	if v := md.Get("authorization"); len(v) > 0 {
		info.AuthHeader = v[0] // never log this
	}

	// Binary metadata: keys ending in "-bin" carry raw bytes and are
	// base64-encoded on the wire, transparently.
	if v := md.Get("x-trace-context-bin"); len(v) > 0 {
		info.TraceContext = []byte(v[0])
	}

	if p, ok := peer.FromContext(ctx); ok {
		info.PeerAddr = p.Addr.String()
		// With mTLS, the verified client certificate is here — the strongest
		// available identity, and better than any header.
		if tlsInfo, ok := p.AuthInfo.(credentials.TLSInfo); ok {
			if len(tlsInfo.State.VerifiedChains) > 0 &&
				len(tlsInfo.State.VerifiedChains[0]) > 0 {
				info.ClientCN = tlsInfo.State.VerifiedChains[0][0].Subject.CommonName
			}
		}
	}

	if dl, ok := ctx.Deadline(); ok {
		info.Budget = time.Until(dl)
	}

	return info, nil
}
```

### Work that must outlive the request

```go
// publishAudit sends an audit event that must not be cancelled just because
// the client hung up — but must also not run forever.
func (s *Service) publishAudit(ctx context.Context, ev AuditEvent) {
	// WithoutCancel (Go 1.21+) keeps the context VALUES — trace ids, request
	// ids, the logger — while dropping cancellation. Using
	// context.Background() here would lose all of that.
	bg := context.WithoutCancel(ctx)

	// Always bound detached work with its own timeout, or a hung publisher
	// leaks a goroutine per request.
	bg, cancel := context.WithTimeout(bg, 5*time.Second)

	go func() {
		defer cancel()
		if err := s.audit.Publish(bg, ev); err != nil {
			s.log.ErrorContext(bg, "audit publish failed", "err", err)
		}
	}()
}
```

### Schema-declared validation with `protovalidate`

```protobuf
import "buf/validate/validate.proto";

message ReserveStockRequest {
  string idempotency_key = 1 [(buf.validate.field).string = {
    min_len: 1, max_len: 64, pattern: "^[A-Za-z0-9_-]+$"
  }];

  string order_id = 2 [(buf.validate.field).string.min_len = 1];

  repeated ReserveStockLine lines = 3 [(buf.validate.field).repeated = {
    min_items: 1, max_items: 100
  }];
}

message ReserveStockLine {
  string sku = 1 [(buf.validate.field).string.pattern = "^sku_[A-Z0-9]{11}$"];
  int32 quantity = 2 [(buf.validate.field).int32.gt = 0];
}
```

```go
// A single interceptor enforces every schema-declared rule before ANY handler
// runs, so a newly added method cannot forget to validate.
func ValidationInterceptor(v protovalidate.Validator) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, _ *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler) (any, error) {

		if m, ok := req.(proto.Message); ok {
			if err := v.Validate(m); err != nil {
				// protovalidate returns a structured violation list, which
				// chapter 22 turns into google.rpc.BadRequest details.
				return nil, status.Errorf(codes.InvalidArgument, "%v", err)
			}
		}
		return handler(ctx, req)
	}
}
```

## 6. Advantages, Disadvantages & Trade-offs

**What the unary handler model gives you**
- **Ordinary blocking Go code.** No callbacks, no futures; one goroutine per RPC and you write straight-line logic.
- **Context is unavoidable**, so cancellation and deadlines are in the vocabulary from line one.
- **`error` in the signature** makes failure a first-class outcome rather than an afterthought.
- **Deadline propagation is free** if you simply pass `ctx` down.

**Where it is easy to go wrong**
- **`return nil, err` compiles**, and silently sends `Unknown` with your internal message attached.
- **Protobuf validates nothing meaningful**, so every field is untrusted until checked.
- **Nothing forces you to use `ctx`**, so ignoring cancellation is a silent resource leak.
- **Object-level authorization has no natural home**, so it is frequently missing entirely.

**Trade-offs**
- *Validation in the schema vs the handler:* schema rules are declared once and enforced everywhere including other languages, but cannot express cross-field or stateful rules. Use both, deliberately, at the right layer.
- *Detailed error messages vs information disclosure:* precise messages make clients' lives easier and can leak internals. Echo caller-supplied values; never echo system internals.
- *`NotFound` for unauthorized reads:* collapsing the codes prevents an existence oracle but makes legitimate debugging harder. Preserve the distinction in logs, not on the wire.

## 7. Common Mistakes & Best Practices

- **`return nil, err`.** Sends `Unknown` plus your internal message. Map every error deliberately.
- **Ignoring the context.** A cancelled client should stop your database query, not just your response write.
- **`context.Background()` inside a handler.** Breaks deadline propagation and leaks work. Use `context.WithoutCancel` plus a timeout for detached work.
- **Direct field access instead of getters.** `req.Sku` panics on a nil message; `req.GetSku()` does not.
- **Trusting protobuf as validation.** It checks types and UTF-8. Nothing else.
- **Unbounded `repeated` fields.** `MaxRecvMsgSize` is a byte limit; 100,000 tiny elements fit comfortably inside it.
- **`InvalidArgument` for state-dependent failures.** "Insufficient stock" is `FailedPrecondition` — the request is fine, the state is not — and that difference drives client retry behaviour.
- **Different codes for "missing" and "forbidden".** An existence oracle. Return the same code; log the difference.
- **Logging the whole request.** It contains tokens and PII. Log identifiers and a redacted subset.
- **Business logic in the handler.** Keep handlers to translation: validate, call the domain, map the result.
- **Mutations without idempotency.** Clients retry automatically; without a key you double-apply.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Log the method, the status code, the duration, the caller and a request id on every call — from an interceptor, so it is uniform. When a client reports an error, the code plus the request id should locate the server-side log line containing the real cause you deliberately withheld.
- **Monitoring.** Rate, error-rate **by code**, and latency per method. Alert on `Internal` (your bug), `Unavailable` (infrastructure) and `DeadlineExceeded` (too slow) separately — they have different owners. A rising `InvalidArgument` rate usually means a client deployed a change, and is worth a lower-severity alert.
- **Security.** Every field is attacker-controlled. Bound every collection, validate every format, and never echo system internals in a message. Prefer mTLS client-certificate identity over a header when you have it. Collapse `NotFound`/`PermissionDenied` where enumeration matters, and keep the audit distinction server-side.
- **Scaling.** Handlers are goroutines, so slow downstream calls consume goroutines proportional to concurrency — which is why deadlines and `MaxConcurrentStreams` are load-shedding controls. Pass `ctx` everywhere so an overloaded system sheds work automatically as clients time out, rather than accumulating doomed requests.

## 9. Interview Questions

**Q: What does a unary handler receive, and what is it obliged to do with each part?**
A: It receives a `context.Context` and the request message, and returns a response and an error. The context carries the client's deadline, cancellation, incoming metadata and peer information — the obligation is to pass it to every downstream call, which is what makes deadline propagation work, and never to substitute `context.Background()` for work the client is waiting on. The request is type-checked and nothing more, so every field is untrusted until validated. The error must be a deliberate `status`, because returning a raw Go error sends `codes.Unknown` with your internal message attached.

**Q: What happens if you `return nil, err` with a plain Go error?**
A: gRPC wraps it as `codes.Unknown` and puts `err.Error()` in the status message, so whatever your database driver said — table names, SQL fragments, file paths, hostnames — travels to the client. It is both an information-disclosure problem and an operational one, because the client's retry logic and your alerting both key off the code, and `Unknown` tells them nothing. The correct pattern is sentinel errors in the domain layer, mapped once at the transport boundary with `errors.Is`, logging the real error server-side and returning a generic message.

**Q: Where does validation belong?**
A: In four layers, each catching a different class. Structural rules — required, ranges, formats, sizes — belong in the schema via `protovalidate`, because they are then declared once and enforced in every language and every consumer. An interceptor runs those rules before any handler, so a newly added method cannot forget. Cross-field and request-shape rules ("either sku or barcode, not both") belong in the handler. Business invariants that need state ("cannot reserve more than available") belong in the domain, where they cannot be bypassed by a second entry point. The mistake is doing all of it in the handler.

**Q: What is the difference between `InvalidArgument` and `FailedPrecondition`?**
A: `InvalidArgument` means the request itself is malformed — retrying it unchanged will never succeed. `FailedPrecondition` means the request is well-formed but the system state forbids it right now — retrying later may succeed. "Quantity must be positive" is `InvalidArgument`; "insufficient stock" is `FailedPrecondition`. The distinction is not pedantry: it is exactly what a client's retry policy keys off, and conflating them either causes pointless retries or suppresses useful ones.

**Q: How do you handle cancellation in a handler?**
A: Mostly by doing nothing special — pass `ctx` to every downstream call and they return promptly when it fires. Beyond that, check `ctx.Err()` before expensive non-cancellable work, and translate context errors faithfully with `status.FromContextError`, which maps `context.Canceled` to `codes.Canceled` and `context.DeadlineExceeded` to `codes.DeadlineExceeded`. That mapping matters operationally: `Canceled` usually means the client gave up, `DeadlineExceeded` usually means you were too slow, and they have different owners on a dashboard.

**Q: How do you run work that must outlive the request?**
A: `context.WithoutCancel(ctx)` from Go 1.21, which keeps the context's values — trace id, request id, logger — while dropping cancellation, then wrap that in its own `WithTimeout` so a hung publisher cannot leak a goroutine per request. Using `context.Background()` instead is the common mistake: it works, but discards the trace and request identifiers, so the detached work becomes unattributable in your logs.

**Q: Why might you return `NotFound` when a caller lacks permission?**
A: To avoid building an existence oracle. If a missing resource returns `NotFound` and a forbidden one returns `PermissionDenied`, an attacker can enumerate valid identifiers by diffing the two responses — which matters for anything with guessable or sequential identifiers. Returning the same code for both removes the signal, while the distinction is preserved in the server-side log where auditing needs it. It is a trade: legitimate clients get a less helpful error, so it is worth doing where enumeration is a real risk and not reflexively everywhere.

**Q: (Senior) Walk me through a production-grade unary handler.**
A: Top to bottom, cheapest first. Validate the request with nil-safe getters — structural rules ideally already enforced by a `protovalidate` interceptor, so the handler holds only cross-field checks and explicit bounds on every repeated field, since `MaxRecvMsgSize` is a byte limit rather than a semantic one. Read the principal the auth interceptor placed in the context. Check `ctx.Err()` before taking a connection from the pool. Call the domain layer passing `ctx`, so the caller's budget propagates automatically. Perform object-level authorization *after* the read, because it needs the resource, and collapse "not found" and "not permitted" into one client-visible code while logging them distinctly. Map the domain's sentinel errors to deliberate status codes with `errors.Is`, logging the real error with the identifiers needed to find it and returning a generic message. Set any response metadata before returning. For a mutation, add an idempotency-key lookup before the work and an optimistic-concurrency check inside it, returning `Aborted` on conflict. The shape I am aiming for is a handler that is pure translation — validate, delegate, map — with no business logic in it at all.

**Q: (Senior) A handler occasionally leaves database connections held after clients time out. Diagnose.**
A: The signature of that is a connection pool saturating while request rate is flat, and it almost always means `ctx` is not reaching the query. The usual causes, in order of likelihood: someone passed `context.Background()` or `context.TODO()` to the store call, so cancellation never propagates; a helper in the call chain takes no context and creates its own; or the driver call being used is the non-context variant — `db.Query` rather than `db.QueryContext`. A subtler variant is work handed to a goroutine that outlives the handler without its own bound, which keeps the connection until the goroutine finishes. I would confirm with a goroutine dump under load, looking for goroutines blocked in the driver long after their deadlines should have fired, and grep for `context.Background()` and non-`Context` driver methods outside `main.go`. Permanent fixes: a lint rule banning `context.Background()` outside `main` and tests, `contextcheck` in CI, a pool-wait-duration metric with an alert, and a test that cancels mid-call and asserts the connection is returned.

**Q: (Senior) How do you design the error vocabulary for a service?**
A: I write it down per method before implementing, as part of the schema review — every condition, its code, and whether it is retryable — because a vocabulary invented per handler ends up inconsistent, and clients then cannot write one retry policy. The structural rule is that the domain layer owns sentinel errors with no gRPC dependency, and the transport layer maps them once, so the same domain error cannot become `NotFound` in one handler and `Internal` in another. Codes are chosen for what the client should *do*: `InvalidArgument` never retry, `FailedPrecondition` maybe later, `Aborted` retry the whole read-modify-write, `Unavailable` retry with backoff, `Internal` page someone. Messages are generic where they would leak internals and specific where the value is caller-supplied, with the real cause always logged server-side against a request id. Where a client needs to act programmatically on the detail — which SKU was short, which field failed — that goes in structured `google.rpc` details rather than in prose, which is chapter 22. Finally I document it in the `.proto` comments, because that is the only documentation consumers reliably read.

## 10. Quick Revision & Cheat Sheet

```go
func (s *Service) GetItem(ctx context.Context, req *pb.GetItemRequest) (*pb.GetItemResponse, error) {
    // 1. validate — getters, never fields; bound every collection
    if req.GetSku() == "" {
        return nil, status.Error(codes.InvalidArgument, "sku is required")
    }
    // 2. identity from the auth interceptor
    principal, _ := PrincipalFromContext(ctx)
    // 3. cheap cancellation check
    if err := ctx.Err(); err != nil {
        return nil, status.FromContextError(err).Err()
    }
    // 4. work — ctx propagates the deadline
    item, err := s.store.Get(ctx, req.GetSku())
    // 5. object-level authz + deliberate mapping
    switch {
    case errors.Is(err, ErrNotFound), err == nil && !principal.MayRead(item):
        return nil, status.Error(codes.NotFound, "item not found")   // same code
    case err != nil:
        s.log.ErrorContext(ctx, "store.Get", "err", err, "sku", req.GetSku())
        return nil, status.Error(codes.Internal, "internal error")
    }
    return &pb.GetItemResponse{Item: item}, nil
}
```

| Situation | Code |
|---|---|
| Malformed request | `InvalidArgument` |
| Missing (or forbidden, deliberately) | `NotFound` |
| Duplicate creation | `AlreadyExists` |
| State forbids it now | `FailedPrecondition` |
| Concurrency conflict — retry the RMW | `Aborted` |
| Quota / size limit | `ResourceExhausted` |
| Not authenticated | `Unauthenticated` |
| Authenticated, not allowed | `PermissionDenied` |
| Client gave up | `Canceled` |
| We were too slow | `DeadlineExceeded` |
| Our bug | `Internal` |

**Flash cards**
- **`return nil, err`?** → `Unknown` + your internal string on the wire. Never.
- **Where does `ctx` go?** → Into every downstream call. That *is* deadline propagation.
- **Detached work?** → `context.WithoutCancel(ctx)` + its own timeout.
- **`InvalidArgument` vs `FailedPrecondition`?** → Bad request vs bad state; never-retryable vs maybe-later.
- **Object-level authz?** → After the read, because it needs the resource.
- **Missing vs forbidden?** → Same code on the wire; distinct in the log.
- **Repeated field bounds?** → Explicit. `MaxRecvMsgSize` counts bytes, not elements.

## 11. Hands-On Exercises & Mini Project

- [ ] Write a handler that returns `nil, err` from a failing database call. Observe the client-side code and message, then fix the mapping and compare.
- [ ] Call a handler with a 100 ms deadline against a 2-second query. Verify the query is actually cancelled server-side, then replace `ctx` with `context.Background()` and watch it keep running.
- [ ] Send a request with a nil message field and access it with a getter, then with direct field access. Note which panics.
- [ ] Send 100,000 tiny elements in a `repeated` field inside a 1 MiB message. Confirm `MaxRecvMsgSize` does not save you, then add an explicit bound.
- [ ] Implement object-level authorization returning `PermissionDenied`, then write a small script that enumerates valid identifiers by diffing codes. Collapse to `NotFound` and confirm the script stops working.
- [ ] Add `protovalidate` constraints plus a validation interceptor, then delete the equivalent handler checks and prove the behaviour is unchanged.
- [ ] Implement idempotency on a mutation, then hammer it with a client whose deadline is shorter than the handler's duration, and prove no duplicates are created.

### Mini Project — "Handler Hardening"

**Goal.** Take a naive service and harden every handler, measuring the difference at each step.

**Requirements.**
1. Start from a service whose handlers `return nil, err`, use `context.Background()` internally, and validate nothing.
2. Introduce a domain error vocabulary with sentinel errors and no gRPC dependency, and a single mapping function at the transport boundary. Prove with a test that no `Unknown` code can escape.
3. Add `protovalidate` constraints for every structural rule plus a validation interceptor; keep only cross-field checks in handlers.
4. Add explicit bounds on every repeated field and a test that a 100,000-element request is rejected.
5. Add object-level authorization after the read, collapsing "missing" and "forbidden", with an audit log preserving the distinction, and a test asserting a caller cannot distinguish them.
6. Add idempotency to every mutating method, with a concurrency test proving no duplicates under retry storms.
7. Add a structured log line per call carrying method, code, duration, caller and request id, and verify the real error is always findable from the client-visible code plus request id.

**Extensions.**
- Add `google.rpc.BadRequest` details to validation failures (chapter 22) and show a client rendering per-field messages.
- Load-test with clients whose deadlines are shorter than handler duration, and demonstrate that goroutine and connection counts stay flat.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Build: The gRPC Server* (where handlers are registered), *The Error Model* (the full code taxonomy and rich details), *Interceptors* (where auth and validation actually live), *Server-Side Streaming Handlers* (the same discipline for streams), *Testing gRPC in Go* (testing these handlers with bufconn).

- **gRPC — Error handling guide** — grpc.io · *Intermediate* · the status model, when to use each code, and how errors travel in trailers. <https://grpc.io/docs/guides/error/>
- **grpc-go — status and codes packages** — gRPC Authors · *Intermediate* · `status.Error`, `status.FromError`, `FromContextError` and the full `codes.Code` list with intended semantics. <https://pkg.go.dev/google.golang.org/grpc/status>
- **Go Blog — Go Concurrency Patterns: Context** — The Go Authors · *Beginner* · the canonical explanation of cancellation, deadlines and context values. <https://go.dev/blog/context>
- **Go 1.21 release notes — context.WithoutCancel** — The Go Authors · *Intermediate* · the correct way to detach work while keeping context values. <https://pkg.go.dev/context#WithoutCancel>
- **protovalidate** — Buf (open source) · *Intermediate* · schema-declared validation with CEL, generating enforcement in every language from one definition. <https://github.com/bufbuild/protovalidate>
- **Google AIP-193 — Errors** — Google · *Intermediate* · Google's own guidance on choosing codes, writing messages and attaching structured details. <https://google.aip.dev/193>
- **grpc-go — metadata and peer packages** — gRPC Authors · *Intermediate* · reading request headers, binary metadata conventions and extracting mTLS client identity. <https://pkg.go.dev/google.golang.org/grpc/metadata>
- **grpc-go examples — errors, metadata, authentication** — gRPC Authors · *Beginner* · small runnable programs for each concept in this chapter. <https://github.com/grpc/grpc-go/tree/master/examples/features>

---

*gRPC with Go Handbook — chapter 15.*
