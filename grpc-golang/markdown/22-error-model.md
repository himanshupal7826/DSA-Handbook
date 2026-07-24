# 22 · The Error Model: codes.Code, status.New & Rich Error Details

> **In one line:** gRPC gives you seventeen status codes plus an `Any`-typed details list, and the discipline that separates a usable API from a frustrating one is choosing the code for what the *client should do* and putting everything a client must act on into structured details rather than into prose.

---

## 1. Overview

Every gRPC call ends with a `google.rpc.Status`: a code, a human-readable message, and a repeated `Any` of structured details. It travels in HTTP/2 trailers — `grpc-status`, `grpc-message`, and `grpc-status-details-bin` for the details — which is why a streaming call can fail after delivering data (chapter 2).

Three properties make this model better than HTTP status codes, and worth using deliberately:

1. **The code set is closed and small.** Seventeen values, each with defined semantics. There is no debate about whether a validation failure is `400` or `422`, and no room for a service to invent `599`.
2. **The details are typed.** `google.rpc.BadRequest`, `ErrorInfo`, `RetryInfo`, `QuotaFailure` and friends are protobuf messages, so a client parses them rather than regex-matching a string.
3. **Retryability is expressible.** `RetryInfo` lets the server tell the client exactly how long to wait, and the code itself tells the client whether retrying could ever help.

The failure mode this chapter exists to prevent is the two-line handler: `if err != nil { return nil, err }`. That sends `codes.Unknown` with your internal error string — a SQL fragment, a file path, a hostname — to the caller, and gives them nothing actionable. Every error a client can encounter should be a deliberate choice.

The second failure mode is prose-as-API. `status.Errorf(codes.InvalidArgument, "sku %q is malformed", sku)` is fine for a human but useless to a client that needs to highlight a form field. That is what `BadRequest.FieldViolation` is for.

## 2. Core Concepts

- **`codes.Code`** — the closed set of 17 status codes, `OK` through `Unauthenticated`.
- **`status.Status`** — the gRPC representation: code, message, details. From `google.golang.org/grpc/status`.
- **`google.rpc.Status`** — the wire form, defined in `googleapis`. `status.Status` wraps it.
- **`status.Error(code, msg)` / `status.Errorf`** — construct an error with a code.
- **`status.New(code, msg)`** — construct a `*Status` you can attach details to before calling `.Err()`.
- **`status.FromError(err)`** — extract a `*Status` from an error; the second return says whether it really was one.
- **`status.Code(err)`** — shorthand for the code; returns `Unknown` for non-status errors and `OK` for `nil`.
- **`WithDetails(...)`** — attach `proto.Message` details; returns a new `*Status` and can fail if a detail cannot be marshalled.
- **`errdetails`** — `google.golang.org/genproto/googleapis/rpc/errdetails`, the standard detail types.
- **`grpc-status-details-bin`** — the trailer carrying the serialised `google.rpc.Status` with details.
- **Sentinel errors** — domain-layer `errors.New` values, mapped to codes at the transport boundary.

## 3. Theory & Principles

### The seventeen codes, chosen by what the client should do

| Code | # | Meaning | Client should |
|---|---|---|---|
| `OK` | 0 | Success | — |
| `Canceled` | 1 | The client cancelled | Nothing; it was you |
| `Unknown` | 2 | Unmapped error | Treat as a server bug — **never emit deliberately** |
| `InvalidArgument` | 3 | Malformed request | Fix the request; **never retry** |
| `DeadlineExceeded` | 4 | Budget expired | Retry with a larger budget, or shed |
| `NotFound` | 5 | Resource absent | Do not retry the same key |
| `AlreadyExists` | 6 | Creation conflict | Treat as success, or use the existing resource |
| `PermissionDenied` | 7 | Authenticated, not allowed | Do not retry; escalate |
| `ResourceExhausted` | 8 | Quota, rate limit, size | Back off (honour `RetryInfo`) |
| `FailedPrecondition` | 9 | State forbids it *now* | Fix the state, then retry |
| `Aborted` | 10 | Concurrency conflict | Retry the whole read-modify-write |
| `OutOfRange` | 11 | Past a valid range | Stop iterating |
| `Unimplemented` | 12 | Method not supported | Do not retry; upgrade |
| `Internal` | 13 | Server bug / invariant broken | Retry cautiously; page someone |
| `Unavailable` | 14 | Transport / service down | **Retry with backoff** |
| `DataLoss` | 15 | Unrecoverable corruption | Escalate immediately |
| `Unauthenticated` | 16 | No or bad credentials | Refresh the token and retry once |

The four distinctions that get made wrong most often:

- **`InvalidArgument` vs `FailedPrecondition`.** The request is malformed vs the request is fine but the state forbids it. Retrying the first can never help; retrying the second might.
- **`FailedPrecondition` vs `Aborted`.** `FailedPrecondition` means "fix something, then retry the same call"; `Aborted` means "re-read and redo the whole sequence" — the classic optimistic-concurrency conflict.
- **`Unavailable` vs `Internal`.** `Unavailable` is infrastructure and is safely retryable; `Internal` is a bug in your code and retrying usually reproduces it. Alert on them separately, because they have different owners.
- **`Unauthenticated` vs `PermissionDenied`.** No valid identity vs a valid identity without rights. The first is fixed by refreshing a token; the second never is.

### Rich details: the part most services skip

`status.WithDetails` attaches typed protobuf messages. The standard set from `errdetails`:

| Type | Use for |
|---|---|
| `ErrorInfo` | **The canonical one.** A stable `reason` string, a `domain`, and a `metadata` map. Machine-readable identity of the error. |
| `BadRequest` | Per-field validation failures (`field`, `description`). |
| `PreconditionFailure` | Which precondition failed (`type`, `subject`, `description`). |
| `QuotaFailure` | Which quota was exceeded and by whom. |
| `RetryInfo` | How long to wait before retrying. |
| `ResourceInfo` | Which resource, of what type, and the owner. |
| `Help` | A URL to documentation. |
| `LocalizedMessage` | A user-presentable message with a locale. |
| `DebugInfo` | Stack traces. **Internal environments only.** |

**`ErrorInfo` is the one to standardise on.** `reason` should be a stable `UPPER_SNAKE_CASE` string that never changes — it is the programmatic identity of the error, the thing clients switch on. `domain` scopes it to your service. `metadata` carries the specifics. Together they let a client write `if info.Reason == "INSUFFICIENT_STOCK" { ... }` without parsing English.

The message string is for humans reading logs. The details are the API.

```svg
<svg viewBox="0 0 880 500" width="100%" height="500" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="er1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Choose the code by what the client should DO</text>

  <rect x="24" y="42" width="410" height="212" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Never retryable</text>
  <g font-size="10">
    <text x="42" y="88" fill="#7f1d1d" font-weight="bold">InvalidArgument</text>
    <text x="200" y="88" fill="#991b1b">the request is malformed &#8212; fix it</text>
    <text x="42" y="110" fill="#7f1d1d" font-weight="bold">NotFound</text>
    <text x="200" y="110" fill="#991b1b">do not retry the same key</text>
    <text x="42" y="132" fill="#7f1d1d" font-weight="bold">PermissionDenied</text>
    <text x="200" y="132" fill="#991b1b">valid identity, no rights &#8212; escalate</text>
    <text x="42" y="154" fill="#7f1d1d" font-weight="bold">Unimplemented</text>
    <text x="200" y="154" fill="#991b1b">upgrade the server</text>
    <text x="42" y="176" fill="#7f1d1d" font-weight="bold">OutOfRange</text>
    <text x="200" y="176" fill="#991b1b">stop iterating</text>
    <text x="42" y="198" fill="#7f1d1d" font-weight="bold">Unknown</text>
    <text x="200" y="198" fill="#991b1b">NEVER emit deliberately &#8212; it means</text>
    <text x="200" y="212" fill="#991b1b">"someone returned a raw Go error"</text>
  </g>
  <text x="42" y="240" fill="#b91c1c" font-size="10" font-weight="bold">Unauthenticated is the exception: refresh the token, retry ONCE.</text>

  <rect x="446" y="42" width="410" height="212" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Retryable &#8212; but differently</text>
  <g font-size="10">
    <text x="464" y="88" fill="#14532d" font-weight="bold">Unavailable</text>
    <text x="620" y="88" fill="#166534">retry with backoff (infrastructure)</text>
    <text x="464" y="110" fill="#14532d" font-weight="bold">ResourceExhausted</text>
    <text x="620" y="110" fill="#166534">back off; honour RetryInfo</text>
    <text x="464" y="132" fill="#14532d" font-weight="bold">Aborted</text>
    <text x="620" y="132" fill="#166534">re-read and redo the WHOLE RMW</text>
    <text x="464" y="154" fill="#14532d" font-weight="bold">FailedPrecondition</text>
    <text x="620" y="154" fill="#166534">fix the state, then retry the same call</text>
    <text x="464" y="176" fill="#14532d" font-weight="bold">DeadlineExceeded</text>
    <text x="620" y="176" fill="#166534">bigger budget, or shed &#8212; NOT in retryPolicy</text>
    <text x="464" y="198" fill="#14532d" font-weight="bold">Internal</text>
    <text x="620" y="198" fill="#166534">retry cautiously; it is OUR bug</text>
  </g>
  <text x="464" y="228" fill="#15803d" font-size="10" font-weight="bold">Alert on Unavailable and Internal SEPARATELY:</text>
  <text x="464" y="244" fill="#166534" font-size="10">infrastructure and application have different owners.</text>

  <rect x="24" y="272" width="832" height="216" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="294" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">The message is for humans. The details are the API.</text>

  <rect x="48" y="310" width="380" height="160" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="238" y="330" text-anchor="middle" fill="#b91c1c" font-weight="bold">Prose as API</text>
  <text x="62" y="354" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="9">status.Errorf(codes.FailedPrecondition,</text>
  <text x="62" y="370" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="9">  "only 3 of sku_1 left, wanted 10")</text>
  <text x="62" y="396" fill="#991b1b" font-size="10">The client must regex-match English to learn</text>
  <text x="62" y="412" fill="#991b1b" font-size="10">the sku and the shortfall.</text>
  <text x="62" y="436" fill="#991b1b" font-size="10">Reword the message &#8594; every client breaks.</text>
  <text x="62" y="456" fill="#7f1d1d" font-size="10" font-weight="bold">You made prose part of your contract.</text>

  <path d="M432,390 L466,390" stroke="#0ea5e9" stroke-width="2" marker-end="url(#er1)"/>

  <rect x="472" y="310" width="360" height="160" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="652" y="330" text-anchor="middle" fill="#15803d" font-weight="bold">Structured details</text>
  <text x="486" y="354" fill="#14532d" font-family="ui-monospace,monospace" font-size="9">ErrorInfo{</text>
  <text x="486" y="370" fill="#14532d" font-family="ui-monospace,monospace" font-size="9">  Reason: "INSUFFICIENT_STOCK",   &#8592; STABLE</text>
  <text x="486" y="386" fill="#14532d" font-family="ui-monospace,monospace" font-size="9">  Domain: "inventory.acme.com",</text>
  <text x="486" y="402" fill="#14532d" font-family="ui-monospace,monospace" font-size="9">  Metadata: {"sku":"sku_1","available":"3",</text>
  <text x="486" y="418" fill="#14532d" font-family="ui-monospace,monospace" font-size="9">             "requested":"10"}}</text>
  <text x="486" y="442" fill="#166534" font-size="10">Client: if info.Reason == "INSUFFICIENT_STOCK"</text>
  <text x="486" y="460" fill="#15803d" font-size="10" font-weight="bold">Reword the message freely &#8212; nothing breaks.</text>
</svg>
```

### The layering rule

Domain code should not import `google.golang.org/grpc/codes`. The reason is not purity — it is that a domain error mapped in two handlers will eventually be mapped inconsistently, and a client cannot write one retry policy against a service where "not found" is sometimes `NotFound` and sometimes `Internal`.

```
domain/store layer  →  sentinel errors (ErrNotFound, ErrInsufficientStock)
                       no gRPC import
        ↓
transport layer     →  ONE mapping function: errors.Is/As → code + details
                       logs the real error, returns a safe message
```

That one mapping function is also where you enforce the rule that internal error strings never reach a client.

## 4. Architecture & Workflow

**Designing an error vocabulary**, before implementation:

1. **List every failure condition per method** — as part of the schema review (chapter 11), not after.
2. **Assign a code** by asking what the client should do.
3. **Assign a stable `ErrorInfo.reason`** in `UPPER_SNAKE_CASE`. This is a permanent contract; treat renaming it as a breaking change.
4. **Decide what metadata the client needs** to act — which SKU, which field, which quota.
5. **Decide retryability** and whether the server should dictate a delay with `RetryInfo`.
6. **Write it into the `.proto` comments**, because that is the documentation consumers read.
7. **Implement one mapping function** at the transport boundary.

```svg
<svg viewBox="0 0 880 420" width="100%" height="420" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="em1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The layering rule, and what it buys</text>

  <rect x="30" y="42" width="250" height="120" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="155" y="64" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">domain / store layer</text>
  <text x="46" y="88" fill="#6d28d9" font-family="ui-monospace,monospace" font-size="9">var ErrNotFound = errors.New(&#8230;)</text>
  <text x="46" y="104" fill="#6d28d9" font-family="ui-monospace,monospace" font-size="9">var ErrInsufficientStock = &#8230;</text>
  <text x="46" y="120" fill="#6d28d9" font-family="ui-monospace,monospace" font-size="9">type InsufficientStockError struct{&#8230;}</text>
  <text x="46" y="144" fill="#5b21b6" font-size="10" font-weight="bold">does NOT import grpc/codes</text>

  <path d="M282,102 L326,102" stroke="#4f46e5" stroke-width="2" marker-end="url(#em1)"/>

  <rect x="330" y="42" width="250" height="120" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="455" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">transport layer</text>
  <text x="346" y="88" fill="#166534" font-size="10">ONE mapping function</text>
  <text x="346" y="106" fill="#166534" font-family="ui-monospace,monospace" font-size="9">errors.Is / errors.As &#8594; code</text>
  <text x="346" y="122" fill="#166534" font-family="ui-monospace,monospace" font-size="9">+ WithDetails(ErrorInfo, &#8230;)</text>
  <text x="346" y="146" fill="#15803d" font-size="10" font-weight="bold">logs the REAL error, returns a safe one</text>

  <path d="M582,102 L626,102" stroke="#4f46e5" stroke-width="2" marker-end="url(#em1)"/>

  <rect x="630" y="42" width="226" height="120" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="743" y="64" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">client</text>
  <text x="646" y="88" fill="#1d4ed8" font-family="ui-monospace,monospace" font-size="9">st, _ := status.FromError(err)</text>
  <text x="646" y="104" fill="#1d4ed8" font-family="ui-monospace,monospace" font-size="9">switch st.Code() { &#8230; }</text>
  <text x="646" y="120" fill="#1d4ed8" font-family="ui-monospace,monospace" font-size="9">for _, d := range st.Details()</text>
  <text x="646" y="144" fill="#1e40af" font-size="10" font-weight="bold">ONE retry policy works everywhere</text>

  <rect x="30" y="182" width="826" height="106" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="443" y="204" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Why the rule is not about purity</text>
  <text x="50" y="228" fill="#991b1b">A domain error mapped in two different handlers WILL eventually be mapped inconsistently &#8212; "not found" becomes</text>
  <text x="50" y="246" fill="#991b1b">NotFound in one place and Internal in another. A client then cannot write one retry policy against your service.</text>
  <text x="50" y="268" fill="#7f1d1d" font-weight="bold">The single mapping function is also the one place that enforces "internal error strings never reach a client".</text>

  <rect x="30" y="304" width="826" height="106" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="443" y="326" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">ErrorInfo.reason is a permanent contract</text>
  <text x="50" y="350" fill="#713f12">Stable UPPER_SNAKE_CASE, scoped by domain. Clients switch on it, alerts group by it, runbooks reference it.</text>
  <text x="50" y="370" fill="#713f12">Renaming a reason is a BREAKING CHANGE, exactly like renaming a proto field &#8212; treat it that way in review.</text>
  <text x="50" y="392" fill="#854d0e" font-weight="bold">Meanwhile the message string stays free: reword it for clarity whenever you like, because nothing depends on it.</text>
</svg>
```

## 5. Implementation

### Domain errors, with no gRPC dependency

```go
// Package inventory — domain layer. Deliberately imports no gRPC packages.
package inventory

import (
	"errors"
	"fmt"
)

var (
	ErrNotFound        = errors.New("item not found")
	ErrAlreadyExists   = errors.New("item already exists")
	ErrVersionConflict = errors.New("version conflict")
	ErrImmutableField  = errors.New("field is immutable")
)

// InsufficientStockError carries the data a client needs to act: which sku,
// how much was wanted, how much exists. A sentinel alone could not.
type InsufficientStockError struct {
	SKU       string
	Requested int32
	Available int32
}

func (e *InsufficientStockError) Error() string {
	return fmt.Sprintf("insufficient stock for %s: requested %d, available %d",
		e.SKU, e.Requested, e.Available)
}

// ValidationError accumulates per-field failures so the transport layer can
// emit one BadRequest with every violation, rather than failing on the first.
type ValidationError struct {
	Violations []FieldViolation
}

type FieldViolation struct {
	Field       string // a path: "lines[2].quantity"
	Description string
}

func (e *ValidationError) Error() string {
	return fmt.Sprintf("%d validation error(s)", len(e.Violations))
}

// QuotaError is raised by rate limiting; RetryAfter lets the server tell the
// client exactly how long to wait instead of leaving it to guess.
type QuotaError struct {
	Subject    string
	Limit      int64
	RetryAfter time.Duration
}

func (e *QuotaError) Error() string {
	return fmt.Sprintf("quota exceeded for %s (limit %d)", e.Subject, e.Limit)
}
```

### The single mapping function

```go
// Package transport — the ONLY place domain errors become gRPC statuses.
package transport

import (
	"context"
	"errors"
	"log/slog"

	"google.golang.org/genproto/googleapis/rpc/errdetails"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/durationpb"

	"github.com/acme/inventory/internal/inventory"
)

// errorDomain scopes every ErrorInfo we emit. Conventionally a DNS name you
// own, so reasons from different services cannot collide.
const errorDomain = "inventory.acme.com"

// ToStatus maps a domain error to a gRPC status with structured details.
//
// Two invariants:
//  1. Internal error strings NEVER reach the client. The real error is logged
//     with enough context to find it; the client gets a safe message.
//  2. Every error a client can act on carries an ErrorInfo with a STABLE
//     reason, so clients switch on a constant rather than parsing prose.
func ToStatus(ctx context.Context, log *slog.Logger, method string, err error) error {
	if err == nil {
		return nil
	}

	// Context errors first: Canceled and DeadlineExceeded mean different
	// things operationally and must not be flattened into Internal.
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return status.FromContextError(err).Err()
	}

	// Already a status (e.g. from a downstream call we chose to pass through).
	if st, ok := status.FromError(err); ok && st.Code() != codes.Unknown {
		return err
	}

	switch {
	// ---------------------------------------------------------- NOT FOUND
	case errors.Is(err, inventory.ErrNotFound):
		return newStatus(codes.NotFound, "item not found", &errdetails.ErrorInfo{
			Reason: "ITEM_NOT_FOUND",
			Domain: errorDomain,
		})

	// ------------------------------------------------------ ALREADY EXISTS
	case errors.Is(err, inventory.ErrAlreadyExists):
		return newStatus(codes.AlreadyExists, "item already exists", &errdetails.ErrorInfo{
			Reason: "ITEM_ALREADY_EXISTS",
			Domain: errorDomain,
		})

	// ------------------------------------------------------------- ABORTED
	case errors.Is(err, inventory.ErrVersionConflict):
		// Aborted, not FailedPrecondition: the client should re-read and redo
		// the whole read-modify-write, not fix something and retry as-is.
		return newStatus(codes.Aborted,
			"the item was modified concurrently; re-read and retry",
			&errdetails.ErrorInfo{Reason: "VERSION_CONFLICT", Domain: errorDomain},
		)

	// -------------------------------------------- FAILED PRECONDITION (rich)
	case isInsufficientStock(err):
		var e *inventory.InsufficientStockError
		errors.As(err, &e)

		// FailedPrecondition, not InvalidArgument: the request is well formed,
		// the SYSTEM STATE forbids it. That distinction drives client retry.
		return newStatus(codes.FailedPrecondition,
			"insufficient stock to fulfil the request",

			// The machine-readable identity plus the specifics.
			&errdetails.ErrorInfo{
				Reason: "INSUFFICIENT_STOCK",
				Domain: errorDomain,
				Metadata: map[string]string{
					"sku":       e.SKU,
					"requested": strconv.Itoa(int(e.Requested)),
					"available": strconv.Itoa(int(e.Available)),
				},
			},

			// Which precondition failed, in the standard shape.
			&errdetails.PreconditionFailure{
				Violations: []*errdetails.PreconditionFailure_Violation{{
					Type:        "STOCK_AVAILABILITY",
					Subject:     "sku/" + e.SKU,
					Description: fmt.Sprintf("requested %d, available %d", e.Requested, e.Available),
				}},
			},

			// A documentation link costs nothing and saves support tickets.
			&errdetails.Help{Links: []*errdetails.Help_Link{{
				Description: "Handling insufficient stock",
				Url:         "https://docs.acme.com/inventory/errors#insufficient-stock",
			}}},
		)

	// -------------------------------------------------- INVALID ARGUMENT (rich)
	case isValidation(err):
		var e *inventory.ValidationError
		errors.As(err, &e)

		br := &errdetails.BadRequest{}
		for _, v := range e.Violations {
			br.FieldViolations = append(br.FieldViolations,
				&errdetails.BadRequest_FieldViolation{
					Field:       v.Field, // a path: "lines[2].quantity"
					Description: v.Description,
				})
		}

		return newStatus(codes.InvalidArgument, "the request is invalid",
			&errdetails.ErrorInfo{Reason: "VALIDATION_FAILED", Domain: errorDomain},
			br,
		)

	// ------------------------------------------------- RESOURCE EXHAUSTED (rich)
	case isQuota(err):
		var e *inventory.QuotaError
		errors.As(err, &e)

		return newStatus(codes.ResourceExhausted, "quota exceeded",
			&errdetails.ErrorInfo{
				Reason: "QUOTA_EXCEEDED", Domain: errorDomain,
				Metadata: map[string]string{"subject": e.Subject},
			},
			&errdetails.QuotaFailure{
				Violations: []*errdetails.QuotaFailure_Violation{{
					Subject:     e.Subject,
					Description: fmt.Sprintf("limit of %d exceeded", e.Limit),
				}},
			},
			// Tell the client exactly how long to wait. Far better than
			// leaving it to guess with its own backoff.
			&errdetails.RetryInfo{RetryDelay: durationpb.New(e.RetryAfter)},
		)

	// -------------------------------------------------------------- INTERNAL
	default:
		// The unmapped case. Log everything; return nothing.
		log.ErrorContext(ctx, "unmapped error",
			"method", method, "err", err, "type", fmt.Sprintf("%T", err))

		return newStatus(codes.Internal, "internal error", &errdetails.ErrorInfo{
			Reason: "INTERNAL", Domain: errorDomain,
			// A request id lets support correlate the client's report with our
			// logs, without disclosing anything about the failure itself.
			Metadata: map[string]string{"request_id": requestIDFrom(ctx)},
		})
	}
}

// newStatus builds a status with details, degrading gracefully if a detail
// cannot be marshalled — a detail-marshalling failure must never replace the
// real error with a confusing one.
func newStatus(c codes.Code, msg string, details ...proto.Message) error {
	st := status.New(c, msg)

	withDetails, err := st.WithDetails(details...)
	if err != nil {
		// Return the status WITHOUT details rather than failing the mapping.
		return st.Err()
	}
	return withDetails.Err()
}
```

### Handler usage

```go
func (s *Service) ReserveStock(
	ctx context.Context,
	req *inventoryv1.ReserveStockRequest,
) (*inventoryv1.ReserveStockResponse, error) {
	res, err := s.core.Reserve(ctx, toDomain(req))
	if err != nil {
		// ONE call. No per-handler mapping, so no inconsistency.
		return nil, transport.ToStatus(ctx, s.log, "ReserveStock", err)
	}
	return toProto(res), nil
}
```

### Client-side consumption

```go
// handleReserveError shows a client acting on structured details rather than
// on the message string.
func handleReserveError(err error) error {
	st, ok := status.FromError(err)
	if !ok {
		return err
	}

	var (
		info  *errdetails.ErrorInfo
		retry *errdetails.RetryInfo
		bad   *errdetails.BadRequest
	)

	for _, d := range st.Details() {
		switch t := d.(type) {
		case *errdetails.ErrorInfo:
			info = t
		case *errdetails.RetryInfo:
			retry = t
		case *errdetails.BadRequest:
			bad = t
		}
	}

	// Switch on the STABLE reason, never on st.Message().
	if info != nil {
		switch info.GetReason() {
		case "INSUFFICIENT_STOCK":
			// The metadata carries exactly what we need to offer a partial
			// order, with no string parsing.
			available, _ := strconv.Atoi(info.GetMetadata()["available"])
			return &PartialStockError{
				SKU:       info.GetMetadata()["sku"],
				Available: int32(available),
			}

		case "QUOTA_EXCEEDED":
			// The server told us how long to wait; honour it rather than
			// applying our own guess.
			delay := 5 * time.Second
			if retry != nil {
				delay = retry.GetRetryDelay().AsDuration()
			}
			return &ThrottledError{RetryAfter: delay}

		case "VALIDATION_FAILED":
			// Per-field messages, ready to attach to form fields.
			fields := make(map[string]string, len(bad.GetFieldViolations()))
			for _, v := range bad.GetFieldViolations() {
				fields[v.GetField()] = v.GetDescription()
			}
			return &FormError{Fields: fields}
		}
	}

	// Fall back to the code when no ErrorInfo is present.
	switch st.Code() {
	case codes.Unavailable:
		return ErrServiceDown
	case codes.DeadlineExceeded:
		return ErrTimeout
	default:
		return fmt.Errorf("reserve failed: %s: %s", st.Code(), st.Message())
	}
}
```

### Turning `protovalidate` violations into `BadRequest`

```go
// ValidationInterceptor runs schema-declared constraints and converts the
// resulting violations into a standard BadRequest, so validation errors look
// identical whether they came from the schema or from a handler.
func ValidationInterceptor(v protovalidate.Validator) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, _ *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler) (any, error) {

		msg, ok := req.(proto.Message)
		if !ok {
			return handler(ctx, req)
		}

		err := v.Validate(msg)
		if err == nil {
			return handler(ctx, req)
		}

		var vErr *protovalidate.ValidationError
		if !errors.As(err, &vErr) {
			return nil, status.Error(codes.InvalidArgument, "the request is invalid")
		}

		br := &errdetails.BadRequest{}
		for _, viol := range vErr.Violations {
			br.FieldViolations = append(br.FieldViolations,
				&errdetails.BadRequest_FieldViolation{
					Field:       viol.FieldValue.String(),
					Description: viol.Proto.GetMessage(),
				})
		}

		st := status.New(codes.InvalidArgument, "the request is invalid")
		if withDetails, dErr := st.WithDetails(
			&errdetails.ErrorInfo{Reason: "VALIDATION_FAILED", Domain: errorDomain},
			br,
		); dErr == nil {
			st = withDetails
		}
		return nil, st.Err()
	}
}
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **A closed code set** removes the "is it 400 or 422?" debate and makes cross-service policy uniform.
- **Typed details** mean clients parse messages, not English, and rewording is free.
- **`RetryInfo`** lets the server dictate backoff, which is far better than every client guessing.
- **Codes are machine-decidable**, so retry, alerting and circuit-breaking can all key off one signal.
- **`ErrorInfo.reason`** gives errors a stable identity for dashboards, runbooks and client switches.

**Disadvantages**
- **Details are `Any`-typed**, so the client must type-switch and handle the unknown case.
- **Seventeen codes is coarse** — several distinct conditions collapse into `FailedPrecondition`, which is why `ErrorInfo` matters.
- **`WithDetails` can fail**, so every construction path needs a fallback.
- **Details add wire bytes** to every error, which matters on very high error rates.
- **Nothing enforces consistency**; two services in one org can use the same code for opposite meanings unless you standardise.

**Trade-offs**
- *Detail richness vs disclosure:* metadata that helps a legitimate client also helps an attacker enumerate. Include what the client needs to act, nothing more, and never `DebugInfo` in production.
- *Passing downstream errors through vs remapping:* passing through preserves detail but leaks your topology and can confuse a caller with codes from a service they do not know exists. Remap at each boundary, preserving the reason in metadata if useful.
- *One mapping function vs per-handler mapping:* centralising guarantees consistency; per-handler allows precision. Centralise, with typed domain errors carrying the specifics.

## 7. Common Mistakes & Best Practices

- **`return nil, err`.** Sends `Unknown` with your internal string. The single most common gRPC error-handling bug.
- **Leaking internals in the message.** SQL fragments, file paths, hostnames, stack traces. Log them; do not send them.
- **`InvalidArgument` for state-dependent failures.** "Insufficient stock" is `FailedPrecondition`; the difference drives retry.
- **`Internal` for everything unexpected without logging it.** You have discarded the only copy of the diagnosis.
- **Emitting `Unknown` deliberately.** It exclusively means "someone returned a raw Go error".
- **Prose as API.** Clients end up regex-matching messages, and rewording becomes a breaking change.
- **Unstable `ErrorInfo.reason`.** Renaming it breaks clients exactly like renaming a proto field.
- **Ignoring `WithDetails`' error.** A marshalling failure then replaces your real error with a confusing one.
- **Different codes for "missing" and "forbidden"** where enumeration matters (chapter 15).
- **Passing downstream errors through unchanged.** Leaks topology and confuses callers.
- **`DebugInfo` in production.** Stack traces are for internal environments only.
- **Not documenting the vocabulary in the `.proto`.** Consumers read comments, not your wiki.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `grpcurl` prints details as JSON, so a failing call is self-describing. On the client, always log `code`, `reason` and the request id — those three make the server-side log line findable, which matters because you deliberately withheld the cause.
- **Monitoring.** Label error metrics by **code and `ErrorInfo.reason`**. The code tells you the class; the reason tells you which specific condition, and that is what makes an alert actionable — `FailedPrecondition` rising is ambiguous, `INSUFFICIENT_STOCK` rising is a business event. Alert on `Internal` (your bug), `Unavailable` (infrastructure) and `DeadlineExceeded` (too slow) separately.
- **Security.** Error messages are an information-disclosure channel. Never include internal identifiers, query text, or infrastructure details; be careful that metadata does not enable enumeration; and gate `DebugInfo` behind an environment check. Consider whether the *existence* of a resource is itself sensitive (chapter 15).
- **Scaling.** Details add bytes to every error response, which is negligible normally and measurable during an incident when the error rate is high — keep them small, and never attach unbounded lists. `RetryInfo` is a load-shedding tool: telling clients precisely when to return converts a retry storm into a scheduled recovery.

## 9. Interview Questions

**Q: What is the gRPC error model?**
A: Every call ends with a `google.rpc.Status`: a `codes.Code` from a closed set of seventeen, a human-readable message, and a repeated `Any` of structured details. It travels in HTTP/2 trailers — `grpc-status`, `grpc-message` and `grpc-status-details-bin` — which is why a streaming call can fail after delivering data. The advantages over HTTP status codes are that the code set is small and unambiguous, the details are typed protobuf messages rather than a prose body, and retryability is expressible both through the code and through an explicit `RetryInfo`.

**Q: What happens if you return a plain Go error from a handler?**
A: gRPC wraps it as `codes.Unknown` with `err.Error()` as the message, so whatever your database driver said — table names, SQL fragments, file paths — travels to the client. It is simultaneously an information-disclosure problem and an operational one, because the client's retry logic and your alerting both key off the code, and `Unknown` conveys nothing. `Unknown` should therefore never be emitted deliberately; seeing it in a dashboard exclusively means someone returned a raw error somewhere.

**Q: `InvalidArgument` or `FailedPrecondition`?**
A: `InvalidArgument` means the request itself is malformed, so retrying it unchanged can never succeed — a negative quantity, a missing required field. `FailedPrecondition` means the request is well-formed but the current system state forbids it, so retrying later might succeed — insufficient stock, an illegal state transition. The distinction is not pedantry: it is exactly what a client's retry policy keys off, and conflating them either causes pointless retries or suppresses useful ones.

**Q: When do you use `Aborted` rather than `FailedPrecondition`?**
A: `Aborted` signals a concurrency conflict where the client should re-read and redo the entire read-modify-write sequence — the classic optimistic-concurrency case where an etag or version did not match. `FailedPrecondition` says "fix something, then retry the same call". The difference matters because the recovery actions differ: one requires re-fetching state and recomputing, the other does not.

**Q: What are rich error details and which types matter?**
A: Typed protobuf messages attached to the status via `WithDetails`, from `google.golang.org/genproto/googleapis/rpc/errdetails`. The one to standardise on is `ErrorInfo`, carrying a stable `reason`, a `domain` and a `metadata` map — that gives the error a machine-readable identity clients can switch on. Beyond it: `BadRequest` for per-field validation failures, `PreconditionFailure` for which precondition failed, `QuotaFailure` for limits, `RetryInfo` for a server-dictated backoff, and `Help` for a documentation link. `DebugInfo` exists but is for internal environments only.

**Q: Why is `ErrorInfo.reason` special?**
A: Because it is the programmatic identity of the error and therefore a permanent contract. Clients switch on it, alerts group by it and runbooks reference it, so renaming a reason is a breaking change exactly like renaming a proto field. In exchange, the message string is freed: because nothing depends on it, you can reword it for clarity whenever you like. Services that skip `ErrorInfo` end up with clients regex-matching English, at which point the prose has silently become part of the API.

**Q: Where should error mapping live?**
A: In one function at the transport boundary. The domain layer defines sentinel errors and typed error structs and imports no gRPC packages; the transport layer maps them to codes and details with `errors.Is`/`errors.As`. Centralising is not about purity — it is that a domain error mapped in two handlers will eventually be mapped inconsistently, and a client cannot write one retry policy against a service where "not found" is sometimes `NotFound` and sometimes `Internal`. It is also the single place that enforces "internal error strings never reach a client".

**Q: (Senior) Design the error vocabulary for a service.**
A: I write it during the schema review, before implementation: for every method, every failure condition, its code, a stable `UPPER_SNAKE_CASE` reason, the metadata a client needs to act, and whether it is retryable. Codes are chosen by what the client should do — never retry, retry with backoff, retry the whole read-modify-write, escalate — because that is what makes one retry policy work across the estate. Every actionable error gets an `ErrorInfo` with a reason scoped by a domain I own, plus the standard detail type that fits: `BadRequest` for validation, `PreconditionFailure` for state, `QuotaFailure` plus `RetryInfo` for limits. The vocabulary goes into the `.proto` comments, because that is the documentation consumers actually read. Implementation is one mapping function using typed domain errors, with the real error logged against a request id and a safe message returned. And I label error metrics by both code and reason, because `FailedPrecondition` rising is ambiguous while `INSUFFICIENT_STOCK` rising is an actionable business signal.

**Q: (Senior) A client complains your errors are unactionable. What do you change?**
A: The complaint almost always means the information is in the message rather than in the details, so the client is either parsing English or guessing. I would start by listing the errors they actually encounter and asking, for each, what they want to *do* — retry, show a field error, offer a partial order, escalate — because that determines both the code and the payload. Then: make sure the code is right, since a validation failure sent as `Internal` gives them nothing; attach an `ErrorInfo` with a stable reason so they can switch on a constant; and put the specifics in metadata or a standard detail type — the SKU and shortfall for insufficient stock, per-field descriptions for validation, a `RetryInfo` delay for throttling. I would also check we are not passing downstream errors through unchanged, which produces codes from services the caller does not know exist. Finally I would document the vocabulary in the `.proto` and give them a small client helper that does the type-switching, because an error model nobody knows how to consume is not much better than no error model.

**Q: (Senior) How much detail is too much in an error?**
A: The test I apply is whether a legitimate client needs it to act. Which SKU was short and by how much — yes, they may offer a partial order. Which field failed validation and why — yes, they will show it in a form. How long to wait — yes, better than guessing. The internal query that failed, the hostname, the primary key, a stack trace — no; those help an attacker map the system and help a legitimate client not at all, and they belong in a log line correlated by request id. There are two subtler cases. Metadata can enable enumeration: returning "sku_9 does not exist" versus "you may not see sku_9" is an existence oracle, so where enumeration matters both collapse to one code with the distinction preserved only in logs. And detail size matters during an incident, when the error rate is high and every response carries the payload — so keep details small and never attach an unbounded list, such as one violation per element of a 10,000-item request.

## 10. Quick Revision & Cheat Sheet

```go
// Simple
return nil, status.Error(codes.NotFound, "item not found")

// With details
st := status.New(codes.FailedPrecondition, "insufficient stock")
st, err := st.WithDetails(
    &errdetails.ErrorInfo{Reason: "INSUFFICIENT_STOCK", Domain: "inventory.acme.com",
        Metadata: map[string]string{"sku": sku, "available": "3"}},
    &errdetails.RetryInfo{RetryDelay: durationpb.New(2 * time.Second)},
)
if err != nil { return nil, status.Error(codes.FailedPrecondition, "insufficient stock") }
return nil, st.Err()

// Client
st, _ := status.FromError(err)
switch st.Code() { … }
for _, d := range st.Details() {
    if info, ok := d.(*errdetails.ErrorInfo); ok && info.GetReason() == "INSUFFICIENT_STOCK" { … }
}
```

| Condition | Code | Retryable |
|---|---|---|
| Malformed request | `InvalidArgument` | No |
| Missing (or hidden) | `NotFound` | No |
| Duplicate create | `AlreadyExists` | No |
| State forbids it now | `FailedPrecondition` | After fixing state |
| Concurrency conflict | `Aborted` | Retry the whole RMW |
| Quota / rate limit | `ResourceExhausted` | Yes, honour `RetryInfo` |
| No credentials | `Unauthenticated` | Refresh, retry once |
| Not allowed | `PermissionDenied` | No |
| Server bug | `Internal` | Cautiously |
| Service down | `Unavailable` | **Yes, with backoff** |
| Budget gone | `DeadlineExceeded` | Bigger budget only |

**Flash cards**
- **`return nil, err`?** → `Unknown` + your internal string. Never.
- **Message vs details?** → Message for humans; details are the API.
- **The detail type to standardise on?** → `ErrorInfo` with a stable `reason`.
- **`InvalidArgument` vs `FailedPrecondition`?** → Bad request vs bad state.
- **`FailedPrecondition` vs `Aborted`?** → Fix and retry vs re-read and redo.
- **Who maps domain errors?** → One function at the transport boundary.
- **Label metrics by?** → Code **and** reason.

## 11. Hands-On Exercises & Mini Project

- [ ] Return `nil, err` from a failing database call and inspect the client-side code and message with `grpcurl`. Then map it properly and compare.
- [ ] Attach `ErrorInfo`, `BadRequest` and `RetryInfo` to one error and print the whole status with `grpcurl -v`.
- [ ] Write a client that switches on `ErrorInfo.reason`, then reword every server message and confirm nothing breaks. Then rename a reason and watch it break.
- [ ] Implement the single mapping function and add a test asserting no handler can produce `codes.Unknown`.
- [ ] Convert `protovalidate` violations into `BadRequest` and render them as per-field form errors in a small client.
- [ ] Emit `RetryInfo` from a rate limiter and write a client that honours the delay rather than using its own backoff. Compare recovery under load.
- [ ] Add a metric labelled by code *and* reason, then trigger three different `FailedPrecondition` conditions and confirm the dashboard distinguishes them.

### Mini Project — "Error Vocabulary"

**Goal.** Design and implement a complete, documented error vocabulary, and prove clients can act on every error without parsing prose.

**Requirements.**
1. A service with at least eight distinct failure conditions across validation, state, concurrency, quota, authorization and infrastructure.
2. A domain layer with sentinel errors and typed error structs carrying the data clients need, importing no gRPC packages.
3. One transport-layer mapping function producing codes plus `ErrorInfo` with stable reasons, and the appropriate standard detail type for each condition.
4. The vocabulary documented per method in the `.proto` comments: condition, code, reason, retryability.
5. A client SDK that switches on reasons, honours `RetryInfo`, renders `BadRequest` as field errors, and never reads `st.Message()` for logic.
6. Tests asserting: no handler emits `Unknown`; no client-visible message contains an internal identifier; every documented reason is produced by exactly one condition.
7. Metrics labelled by code and reason, with a dashboard distinguishing the three `FailedPrecondition` conditions.

**Extensions.**
- Add a "reason registry" test that fails when a reason is renamed or removed, treating it as the breaking change it is.
- Add localisation via `LocalizedMessage` and demonstrate a client rendering an error in two languages from one status.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Unary Handlers* (where mapping is called), *Invoking All Four Method Kinds from Go* (client-side consumption), *Deadlines, Retries, Service Config & Load Balancing* (how codes drive retry policy), *Interceptors* (validation errors and uniform mapping), *Build: The Complete Service .proto* (documenting the vocabulary).

- **gRPC — Error handling guide** — grpc.io · *Intermediate* · the status model, the full code list with intended semantics, and how errors travel in trailers. <https://grpc.io/docs/guides/error/>
- **Google AIP-193 — Errors** — Google · *Intermediate* · Google's own rules for choosing codes, writing messages, and attaching `ErrorInfo`; the source of the reason/domain/metadata convention. <https://google.aip.dev/193>
- **googleapis — google/rpc/error_details.proto** — Google · *Intermediate* · every standard detail type with its intended use, including `RetryInfo`, `QuotaFailure` and `PreconditionFailure`. <https://github.com/googleapis/googleapis/blob/master/google/rpc/error_details.proto>
- **grpc-go — status and codes packages** — gRPC Authors · *Intermediate* · `status.New`, `WithDetails`, `FromError`, `FromContextError`, and the full `codes.Code` set. <https://pkg.go.dev/google.golang.org/grpc/status>
- **gRPC — Status codes and their use in gRPC** — gRPC Authors · *Intermediate* · the normative per-code guidance, including which layer generates each. <https://github.com/grpc/grpc/blob/master/doc/statuscodes.md>
- **google.golang.org/genproto/googleapis/rpc/errdetails** — Google · *Intermediate* · the Go types for every detail message, ready to attach and type-switch on. <https://pkg.go.dev/google.golang.org/genproto/googleapis/rpc/errdetails>
- **protovalidate** — Buf (open source) · *Intermediate* · schema-declared constraints whose violations map naturally onto `BadRequest`. <https://github.com/bufbuild/protovalidate>
- **Google SRE Book — Addressing Cascading Failures** — Google · *Advanced* · why server-dictated retry delays and correct retryability signalling matter at fleet scale. <https://sre.google/sre-book/addressing-cascading-failures/>

---

*gRPC with Go Handbook — chapter 22.*
