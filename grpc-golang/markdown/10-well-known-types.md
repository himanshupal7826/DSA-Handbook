# 10 · Well-Known Types: Timestamp, Duration, FieldMask, Any & Struct

> **In one line:** The `google.protobuf.*` types are the standard library of protobuf — use `Timestamp` instead of an `int64` whose units nobody documented, `FieldMask` instead of guessing what a partial update meant, and `Any` almost never.

---

## 1. Overview

Every schema eventually needs to express a point in time, an elapsed interval, "update only these fields", "no meaningful response", or "an arbitrary nested structure". You can invent a representation for each — `int64 created_at_millis`, `int32 timeout_seconds`, a `repeated string fields_to_update` — and every team that has done so has produced a schema where the units are ambiguous, the epoch is undocumented, and two services disagree about whether a timestamp is seconds or milliseconds.

The **well-known types** (WKTs) are protobuf's answer: a small set of standard messages shipped with `protoc` in its `include/` directory, with defined semantics, canonical JSON representations, and first-class helpers in every language runtime. Using them is not merely stylistic. `google.protobuf.Timestamp` marshals to an RFC 3339 string in `protojson`, so your JSON gateway produces `"2026-07-24T10:30:00Z"` rather than `1784889000000`. `google.protobuf.Duration` marshals to `"3.5s"`. `google.protobuf.FieldMask` has runtime support for applying a partial update. None of that is available for a hand-rolled `int64`.

There is a second group worth knowing but treating with suspicion: `Any`, `Struct` and `Value`. These reintroduce dynamic typing into a statically-typed system. They have legitimate uses — genuinely heterogeneous payloads, pass-through JSON — and a much larger set of illegitimate ones where they are used to avoid the work of modelling the domain.

The most operationally important WKT is **`FieldMask`**, because it is the only correct answer to the partial-update problem that proto3's implicit presence creates (chapter 9). Getting `Update` RPCs right is a recurring interview topic and a recurring production bug.

## 2. Core Concepts

- **`google.protobuf.Timestamp`** — a point in time as `int64 seconds` since the Unix epoch plus `int32 nanos` (0–999,999,999). UTC, no timezone. JSON: RFC 3339.
- **`google.protobuf.Duration`** — a signed elapsed time as `int64 seconds` + `int32 nanos` (sign must match). JSON: `"3.5s"`.
- **`google.protobuf.FieldMask`** — `repeated string paths`, naming fields in a message using dotted paths. The contract for partial updates and sparse reads.
- **`google.protobuf.Empty`** — a message with no fields, for RPCs with no meaningful request or response.
- **Wrapper types** — `Int32Value`, `StringValue`, `BoolValue`, etc. Message-wrapped scalars, giving presence. Largely superseded by `optional`.
- **`google.protobuf.Any`** — a type URL plus serialised bytes; a dynamically-typed embedded message.
- **`google.protobuf.Struct` / `Value` / `ListValue`** — a protobuf encoding of arbitrary JSON.
- **`google.protobuf.BytesValue`, `DoubleValue`…** — the rest of the wrapper family.
- **`google.type.*`** — a *different* package (from `googleapis`, not bundled with `protoc`) with domain types: `Money`, `Date`, `LatLng`, `Interval`, `DayOfWeek`.
- **Canonical JSON mapping** — each WKT has a special-cased JSON form defined by the protobuf JSON spec, which is what makes `protojson` output readable.

## 3. Theory & Principles

### `Timestamp` vs a raw integer

The case for `Timestamp` is not aesthetic:

| Concern | `int64 created_at` | `google.protobuf.Timestamp` |
|---|---|---|
| Units | Undocumented — seconds? millis? micros? | Defined: seconds + nanos |
| Epoch | Undocumented | Unix epoch, UTC |
| Precision | Whatever you chose | Nanosecond |
| JSON output | `1784889000` | `"2026-07-24T10:30:00Z"` |
| Presence | 0 is a real time (1970) and also "unset" | Message: `nil` means unset |
| Go conversion | Hand-written | `timestamppb.New(t)` / `ts.AsTime()` |
| Cross-language | Every team re-derives it | Standard everywhere |

The presence row is the one people miss. `int64 created_at = 0` is simultaneously "1 January 1970" and "not set". A `Timestamp` field is a message pointer, so `nil` is unambiguous.

**Range and validity.** `Timestamp` is defined for years 0001 through 9999. `nanos` must be in `[0, 999999999]` — always non-negative, even for times before the epoch, where `seconds` is negative and `nanos` counts *forward* from it. `timestamppb.New` handles this; hand-rolled arithmetic does not.

### `Duration` and its sign rule

`Duration` is signed, and the rule is that **`seconds` and `nanos` must have the same sign** (or one must be zero). `-1.5s` is `seconds: -1, nanos: -500000000`, not `seconds: -2, nanos: 500000000`. `durationpb.New(d)` gets this right; manual construction routinely does not. Range is roughly ±10,000 years.

Use `Duration` for *elapsed* or *relative* time — timeouts, TTLs, retry backoff, video length. Use `Timestamp` for *absolute* points. A common schema smell is `int32 timeout_seconds` next to a `Timestamp`; make both WKTs and the units question disappears.

### `FieldMask`: solving partial updates properly

The problem: proto3 scalars have implicit presence, so an `UpdateItem` request cannot distinguish "set quantity to 0" from "leave quantity alone" (chapter 9). Three approaches exist, and only one scales:

1. **Full replacement (PUT semantics).** The client sends the complete resource and the server overwrites everything. Simple and correct, but the client must first read the resource, and two concurrent updates lose each other's changes.
2. **`optional` on every field.** Works, but produces pointers everywhere, and still cannot express "clear this field" versus "leave it" for message-typed fields cleanly.
3. **`FieldMask`.** The request carries the resource *and* a mask naming exactly which paths the server should apply. Everything not in the mask is untouched. This is the pattern Google's own APIs use (AIP-134), and it is the correct default.

```protobuf
message UpdateItemRequest {
  // The item with the NEW values for the fields named in update_mask.
  // item.sku identifies which item to update.
  Item item = 1;

  // Which fields of `item` to apply. Paths are field names in `item`,
  // dot-separated for nested fields: "name", "dimensions.weight_g".
  // An empty mask means "replace everything" — a deliberate choice you must
  // document; the alternative is to reject an empty mask as InvalidArgument.
  google.protobuf.FieldMask update_mask = 2;
}
```

Key semantics to pin down explicitly in your API's documentation, because the spec leaves them to you:
- **Empty mask** — either "full replacement" (AIP-134's recommendation) or an error. Pick one and document it; silently doing nothing is the worst option.
- **`"*"`** — conventionally means all fields. Support it or reject it, consistently.
- **Unknown path** — must be `InvalidArgument`. Silently ignoring typos means a client thinks it updated a field it did not.
- **Immutable fields in the mask** — the identifier, `created_at` — must be `InvalidArgument`, not silently dropped.
- **Nested paths** — `"dimensions.weight_g"` updates one sub-field; `"dimensions"` replaces the whole sub-message. Both are valid and mean different things.

The runtime helper is `google.golang.org/protobuf/types/known/fieldmaskpb` plus `fmutils` (a common community helper) or a hand-written applier; §5 shows both a validation path and an application path.

```svg
<svg viewBox="0 0 880 460" width="100%" height="460" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">FieldMask: expressing "change only these fields"</text>

  <rect x="24" y="42" width="270" height="180" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="159" y="64" text-anchor="middle" fill="#3730a3" font-size="12" font-weight="bold">Stored item</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#4338ca">
    <text x="40" y="88">sku:               "sku_1"</text>
    <text x="40" y="106">name:              "Blue Widget"</text>
    <text x="40" y="124">quantity_on_hand:  42</text>
    <text x="40" y="142">unit_price_minor:  1299</text>
    <text x="40" y="160">status:            ACTIVE</text>
    <text x="40" y="178">dimensions.weight_g: 250</text>
    <text x="40" y="196">created_at:        2026-01-04T&#8230;</text>
  </g>

  <rect x="306" y="42" width="270" height="180" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="441" y="64" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">UpdateItemRequest</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#b45309">
    <text x="322" y="88">item {</text>
    <text x="322" y="106">  sku: "sku_1"      &#8592; identifies</text>
    <text x="322" y="124">  quantity_on_hand: 0</text>
    <text x="322" y="142">  name: ""          &#8592; NOT in mask</text>
    <text x="322" y="160">}</text>
    <text x="322" y="182">update_mask {</text>
    <text x="322" y="200">  paths: ["quantity_on_hand"]</text>
    <text x="322" y="216">}</text>
  </g>

  <rect x="588" y="42" width="268" height="180" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="722" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Result</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#166534">
    <text x="604" y="88">sku:               "sku_1"</text>
    <text x="604" y="106">name:              "Blue Widget"  &#8592; kept</text>
    <text x="604" y="124">quantity_on_hand:  0             &#8592; applied</text>
    <text x="604" y="142">unit_price_minor:  1299          &#8592; kept</text>
    <text x="604" y="160">status:            ACTIVE        &#8592; kept</text>
    <text x="604" y="178">dimensions.weight_g: 250         &#8592; kept</text>
    <text x="604" y="196">created_at:        2026-01-04T&#8230;</text>
  </g>
  <text x="722" y="216" text-anchor="middle" fill="#15803d" font-size="10" font-weight="bold">"set to 0" expressed unambiguously</text>

  <rect x="24" y="240" width="832" height="204" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="440" y="262" text-anchor="middle" fill="#854d0e" font-size="13" font-weight="bold">Semantics YOU must decide and document &#8212; the spec does not</text>
  <g font-size="11">
    <text x="48" y="288" fill="#713f12" font-weight="bold">Empty mask</text>
    <text x="230" y="288" fill="#713f12">&#8594; "replace everything" (AIP-134) OR InvalidArgument. Never silently do nothing.</text>
    <text x="48" y="310" fill="#713f12" font-weight="bold">paths: ["*"]</text>
    <text x="230" y="310" fill="#713f12">&#8594; all fields, by convention. Support it or reject it &#8212; consistently.</text>
    <text x="48" y="332" fill="#713f12" font-weight="bold">Unknown path</text>
    <text x="230" y="332" fill="#713f12">&#8594; MUST be InvalidArgument. Silently ignoring a typo is a lost update.</text>
    <text x="48" y="354" fill="#713f12" font-weight="bold">Immutable field</text>
    <text x="230" y="354" fill="#713f12">&#8594; "sku", "created_at" in the mask &#8594; InvalidArgument, not a silent drop.</text>
    <text x="48" y="376" fill="#713f12" font-weight="bold">"dimensions"</text>
    <text x="230" y="376" fill="#713f12">&#8594; replaces the WHOLE sub-message (including fields you did not set).</text>
    <text x="48" y="398" fill="#713f12" font-weight="bold">"dimensions.weight_g"</text>
    <text x="230" y="398" fill="#713f12">&#8594; updates ONLY that leaf. Both are legal and mean different things.</text>
    <text x="48" y="420" fill="#713f12" font-weight="bold">repeated / map field</text>
    <text x="230" y="420" fill="#713f12">&#8594; always replaced wholesale; there is no per-element mask path.</text>
  </g>
</svg>
```

### `Any` and `Struct`: powerful, usually wrong

**`Any`** packs an arbitrary message plus a type URL (`type.googleapis.com/acme.inventory.v1.Item`). Unpacking requires the target type to be linked into the binary and registered — which is the catch: a service that receives an `Any` it was not compiled with can do nothing useful with it. Legitimate uses are narrow: `google.rpc.Status.details` (chapter 22), long-running-operation results, and genuinely plugin-style extension points. Illegitimate use is "we did not want to model this properly", which converts every consumer's compile-time error into a runtime one.

**`Struct`/`Value`/`ListValue`** encode arbitrary JSON in protobuf. Legitimate when you are genuinely passing through opaque user-supplied JSON (a webhook payload, a config blob). Illegitimate as a general escape hatch — it throws away every benefit protobuf provides. A `Struct` field in a schema is usually a sign that a modelling conversation was skipped.

Before reaching for either, consider the alternatives: a `oneof` over a closed set of known types (type-safe, evolvable), or `bytes` plus an explicit content-type field (honest about opacity, no registry requirement).

## 4. Architecture & Workflow

**Choosing a well-known type.**

| You need | Use | Not |
|---|---|---|
| A point in time | `google.protobuf.Timestamp` | `int64 …_millis`, `string` |
| An elapsed interval, timeout, TTL | `google.protobuf.Duration` | `int32 …_seconds` |
| A calendar date with no time | `google.type.Date` | `Timestamp` at midnight |
| Money | `google.type.Money` or `int64` minor units | `double` |
| Partial update | `google.protobuf.FieldMask` | `optional` on 30 fields |
| Sparse read (select fields) | `google.protobuf.FieldMask` (as `read_mask`) | Fifteen near-duplicate RPCs |
| No request or response | `google.protobuf.Empty` | An empty custom message |
| Nullable scalar | `optional` (proto3 ≥ 3.15) | Wrapper types (legacy) |
| Heterogeneous known set | `oneof` | `Any` |
| Truly opaque bytes | `bytes` + a content-type field | `Any`, `Struct` |
| Pass-through JSON | `google.protobuf.Struct` | Hand-rolled key/value lists |
| Rich error details | `google.rpc.ErrorInfo` etc. in `Any` | A `string details` field |

**A note on imports.** `google/protobuf/*.proto` ships with `protoc` in `include/` — no dependency needed. `google/type/*.proto` and `google/rpc/*.proto` come from **googleapis**, which you must vendor or, better, add as a buf dependency:

```yaml
# buf.yaml
deps:
  - buf.build/googleapis/googleapis
```

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Why WKTs beat hand-rolled fields: the JSON edge</text>

  <rect x="24" y="42" width="410" height="176" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Hand-rolled</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#7f1d1d">
    <text x="40" y="88">int64 created_at   = 11;   // millis? seconds?</text>
    <text x="40" y="106">int32 ttl_seconds  = 12;   // signed? max?</text>
    <text x="40" y="124">repeated string fields = 13; // free-form</text>
  </g>
  <text x="40" y="150" fill="#991b1b" font-size="10">protojson output through a gateway:</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#7f1d1d">
    <text x="40" y="170">{"createdAt":"1784889000000",</text>
    <text x="40" y="186"> "ttlSeconds":3600}</text>
  </g>
  <text x="40" y="208" fill="#991b1b" font-size="10">Consumers must know the units. Two services WILL disagree.</text>

  <rect x="446" y="42" width="410" height="176" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Well-known types</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#14532d">
    <text x="462" y="88">google.protobuf.Timestamp created_at = 11;</text>
    <text x="462" y="106">google.protobuf.Duration  ttl        = 12;</text>
    <text x="462" y="124">google.protobuf.FieldMask update_mask = 13;</text>
  </g>
  <text x="462" y="150" fill="#166534" font-size="10">protojson output through a gateway:</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#14532d">
    <text x="462" y="170">{"createdAt":"2026-07-24T10:30:00Z",</text>
    <text x="462" y="186"> "ttl":"3600s","updateMask":"name,status"}</text>
  </g>
  <text x="462" y="208" fill="#166534" font-size="10">Self-describing. Same in every language. nil == unset.</text>

  <rect x="24" y="236" width="832" height="152" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="258" text-anchor="middle" fill="#334155" font-size="13" font-weight="bold">Where each type comes from</text>
  <rect x="48" y="272" width="380" height="46" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="238" y="292" text-anchor="middle" fill="#15803d" font-size="11" font-weight="bold">google/protobuf/*.proto</text>
  <text x="238" y="308" text-anchor="middle" fill="#166534" font-size="10">ships with protoc in include/ &#8212; no dependency needed</text>
  <text x="60" y="336" fill="#166534" font-size="10">Timestamp &#183; Duration &#183; FieldMask &#183; Empty &#183; Any &#183; Struct &#183; wrappers</text>

  <rect x="452" y="272" width="380" height="46" rx="8" fill="#fef3c7" stroke="#d97706"/>
  <text x="642" y="292" text-anchor="middle" fill="#92400e" font-size="11" font-weight="bold">google/type/*.proto &#183; google/rpc/*.proto</text>
  <text x="642" y="308" text-anchor="middle" fill="#b45309" font-size="10">from googleapis &#8212; add buf.build/googleapis/googleapis to deps</text>
  <text x="464" y="336" fill="#b45309" font-size="10">Money &#183; Date &#183; LatLng &#183; Interval &#183; ErrorInfo &#183; BadRequest &#183; RetryInfo</text>

  <text x="440" y="368" text-anchor="middle" fill="#475569" font-size="10">Forgetting this distinction is the "google/type/money.proto: File not found" error.</text>
</svg>
```

## 5. Implementation

### The schema

```protobuf
syntax = "proto3";

package acme.inventory.v1;

import "google/protobuf/duration.proto";
import "google/protobuf/empty.proto";
import "google/protobuf/field_mask.proto";
import "google/protobuf/timestamp.proto";
import "google/type/money.proto";        // requires the googleapis dependency

option go_package = "github.com/acme/apis/gen/go/acme/inventory/v1;inventoryv1";

service InventoryService {
  rpc GetItem(GetItemRequest) returns (Item);

  // Partial update via FieldMask — the standard pattern (AIP-134).
  rpc UpdateItem(UpdateItemRequest) returns (Item);

  // Empty response: the RPC has no meaningful result beyond success.
  rpc DeleteItem(DeleteItemRequest) returns (google.protobuf.Empty);

  // Empty request: no parameters at all.
  rpc GetInventorySummary(google.protobuf.Empty) returns (InventorySummary);
}

message Item {
  string sku  = 1;
  string name = 2;
  int32  quantity_on_hand = 3;

  // Money as a structured type: units + nanos + currency, never a float.
  google.type.Money unit_price = 4;

  ItemStatus status = 5;

  // Absolute points in time. nil means "not set" — unambiguous, unlike int64 0.
  google.protobuf.Timestamp created_at = 6;
  google.protobuf.Timestamp updated_at = 7;

  // A relative interval: how long a reservation on this item is held.
  google.protobuf.Duration reservation_ttl = 8;

  Dimensions dimensions = 9;

  message Dimensions {
    int32 length_mm = 1;
    int32 width_mm  = 2;
    int32 height_mm = 3;
    int32 weight_g  = 4;
  }
}

enum ItemStatus {
  ITEM_STATUS_UNSPECIFIED  = 0;
  ITEM_STATUS_DRAFT        = 1;
  ITEM_STATUS_ACTIVE       = 2;
  ITEM_STATUS_DISCONTINUED = 3;
}

message GetItemRequest {
  string sku = 1;

  // Sparse read: return only these fields. Empty means "everything".
  google.protobuf.FieldMask read_mask = 2;
}

message UpdateItemRequest {
  // The item carrying NEW values. item.sku identifies the target.
  Item item = 1;

  // Which fields of `item` to apply. See the service documentation for the
  // exact semantics of an empty mask, "*", and nested paths.
  google.protobuf.FieldMask update_mask = 2;
}

message DeleteItemRequest { string sku = 1; }

message InventorySummary {
  int32 total_skus = 1;
  int64 total_units = 2;
  google.protobuf.Timestamp computed_at = 3;
}
```

### Go: converting between WKTs and native types

```go
package inventory

import (
	"time"

	"google.golang.org/protobuf/types/known/durationpb"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func conversions() {
	// --- Timestamp -----------------------------------------------------
	now := time.Now()

	ts := timestamppb.New(now)            // time.Time -> *timestamppb.Timestamp
	back := ts.AsTime()                   // -> time.Time, ALWAYS in UTC
	_ = back

	// AsTime() on a nil *Timestamp returns the zero time (year 1, UTC) rather
	// than panicking, so the nil-safe idiom is a check, not a rescue:
	var missing *timestamppb.Timestamp
	if missing == nil {
		// "not set" — distinct from any real instant. This is the whole point
		// of using a message rather than an int64.
	}

	// CheckValid rejects out-of-range values (year <1 or >9999, bad nanos).
	// Worth calling on anything that came off the wire from an untrusted peer.
	if err := ts.CheckValid(); err != nil {
		// handle: the peer sent a malformed Timestamp
		_ = err
	}

	// --- Duration ------------------------------------------------------
	d := durationpb.New(90 * time.Second)  // time.Duration -> *durationpb.Duration
	goDur := d.AsDuration()                // -> time.Duration
	_ = goDur

	// Negative durations: seconds and nanos must share a sign. durationpb.New
	// handles this; hand-construction routinely gets it wrong.
	neg := durationpb.New(-1500 * time.Millisecond)
	_ = neg // seconds: -1, nanos: -500000000  (NOT seconds:-2, nanos:+5e8)
}
```

### Go: implementing `UpdateItem` with a `FieldMask`

This is the pattern worth memorising, because it is both a common production requirement and a common interview question.

```go
package inventory

import (
	"context"
	"fmt"
	"slices"
	"strings"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/fieldmaskpb"
	"google.golang.org/protobuf/types/known/timestamppb"

	inventoryv1 "github.com/acme/apis/gen/go/acme/inventory/v1"
)

// updatableItemPaths is the allow-list of paths a client may name in an
// update_mask. Anything outside it — identifiers, server-managed timestamps —
// is rejected rather than silently ignored, because a silent drop means the
// client believes it changed something it did not.
var updatableItemPaths = []string{
	"name",
	"quantity_on_hand",
	"unit_price",
	"status",
	"reservation_ttl",
	"dimensions",              // replaces the whole sub-message
	"dimensions.length_mm",    // or address individual leaves
	"dimensions.width_mm",
	"dimensions.height_mm",
	"dimensions.weight_g",
}

func (s *Service) UpdateItem(
	ctx context.Context,
	req *inventoryv1.UpdateItemRequest,
) (*inventoryv1.Item, error) {
	newItem := req.GetItem()
	if newItem.GetSku() == "" {
		return nil, status.Error(codes.InvalidArgument, "item.sku is required")
	}

	mask := req.GetUpdateMask()

	// --- Decide and DOCUMENT the empty-mask semantics -------------------
	// We follow AIP-134: an empty mask means full replacement. The
	// alternative (reject as InvalidArgument) is equally defensible; what is
	// not defensible is silently doing nothing.
	paths := mask.GetPaths()
	if len(paths) == 0 || slices.Contains(paths, "*") {
		paths = slices.Clone(updatableItemPaths)
	}

	// --- Validate every path BEFORE touching storage --------------------
	// IsValid checks the paths actually exist on the message type; the
	// allow-list additionally enforces which of them a client may change.
	if mask != nil && !mask.IsValid(&inventoryv1.Item{}) {
		return nil, status.Error(codes.InvalidArgument,
			"update_mask contains a path that does not exist on Item")
	}
	for _, p := range paths {
		if !slices.Contains(updatableItemPaths, p) {
			// Naming an immutable field is an error, not something to ignore.
			return nil, status.Errorf(codes.InvalidArgument,
				"field %q is not updatable (updatable fields: %s)",
				p, strings.Join(updatableItemPaths, ", "))
		}
	}

	// --- Read, apply, write ---------------------------------------------
	current, err := s.store.Get(ctx, newItem.GetSku())
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "item %q not found", newItem.GetSku())
	}

	updated := proto.Clone(current).(*inventoryv1.Item)
	if err := applyFieldMask(updated, newItem, paths); err != nil {
		return nil, status.Errorf(codes.InvalidArgument, "apply update_mask: %v", err)
	}

	// Server-managed fields are set by the server, never by the client.
	updated.UpdatedAt = timestamppb.Now()

	if err := s.store.Put(ctx, updated); err != nil {
		return nil, status.Error(codes.Internal, "failed to persist item")
	}
	return updated, nil
}

// applyFieldMask copies exactly the named paths from src into dst.
//
// It walks the protobuf reflection API rather than using reflect on the Go
// struct, so it works for any message and respects protobuf semantics (a
// message-typed path replaces the whole sub-message; repeated and map fields
// are always replaced wholesale — there is no per-element mask path).
func applyFieldMask(dst, src proto.Message, paths []string) error {
	for _, path := range paths {
		if err := copyPath(dst.ProtoReflect(), src.ProtoReflect(), strings.Split(path, ".")); err != nil {
			return fmt.Errorf("path %q: %w", path, err)
		}
	}
	return nil
}

func copyPath(dst, src protoreflect.Message, segments []string) error {
	name := protoreflect.Name(segments[0])
	fd := src.Descriptor().Fields().ByName(name)
	if fd == nil {
		return fmt.Errorf("no such field %q on %s", name, src.Descriptor().FullName())
	}

	// Leaf segment: copy the field wholesale.
	if len(segments) == 1 {
		if !src.Has(fd) && fd.HasPresence() {
			// The path names a field the client left unset: that means "clear it".
			dst.Clear(fd)
			return nil
		}
		dst.Set(fd, src.Get(fd))
		return nil
	}

	// Interior segment: must be a singular message; recurse into it.
	if fd.Kind() != protoreflect.MessageKind || fd.IsList() || fd.IsMap() {
		return fmt.Errorf("field %q is not a message and cannot have sub-paths", name)
	}
	if !dst.Has(fd) {
		dst.Set(fd, dst.NewField(fd))
	}
	return copyPath(dst.Mutable(fd).Message(), src.Get(fd).Message(), segments[1:])
}
```

### Go: `Any`, when you genuinely need it

```go
import (
	"google.golang.org/protobuf/types/known/anypb"
	"google.golang.org/protobuf/proto"
)

// Packing: the type URL is derived from the message's full proto name.
item := &inventoryv1.Item{Sku: "sku_1"}
packed, err := anypb.New(item)     // type_url = "type.googleapis.com/acme.inventory.v1.Item"
if err != nil { /* ... */ }

// Unpacking, when you know the expected type:
var out inventoryv1.Item
if err := packed.UnmarshalTo(&out); err != nil {
	// Wrong type, or the type is not linked into this binary. THIS is the
	// cost of Any: a compile-time guarantee became a runtime error.
}

// Unpacking without knowing the type requires the type to be registered in
// protoregistry.GlobalTypes, i.e. linked into the binary anyway:
msg, err := packed.UnmarshalNew()
if err != nil { /* unknown type — nothing useful you can do */ }
_ = msg

// Checking before unpacking:
if packed.MessageIs(&inventoryv1.Item{}) { /* ... */ }
```

### Go: `Struct` for genuine pass-through JSON

```go
import "google.golang.org/protobuf/types/known/structpb"

// From arbitrary Go data (only JSON-compatible types are accepted):
s, err := structpb.NewStruct(map[string]any{
	"source":  "webhook",
	"attempt": 3,
	"tags":    []any{"a", "b"},
})
if err != nil { /* a non-JSON-compatible value was supplied */ }

// Back to Go:
m := s.AsMap()   // map[string]any
_ = m
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Unambiguous semantics.** Units, epoch, precision and range are defined once, everywhere.
- **Canonical JSON.** `Timestamp` → RFC 3339, `Duration` → `"3.5s"`, `FieldMask` → a comma-joined string. Your gateway output is readable without custom marshallers.
- **Presence for free.** A `Timestamp` field is a message, so `nil` unambiguously means "not set".
- **Runtime helpers** in every language: `timestamppb.New`, `AsTime`, `CheckValid`, `fieldmaskpb.New`, `IsValid`.
- **`FieldMask` solves partial updates** properly, which nothing else in proto3 does.

**Disadvantages**
- **Message overhead.** A `Timestamp` costs a length-delimited embedded message (a few extra bytes and a pointer) versus a bare varint. Irrelevant except in extreme hot paths.
- **`FieldMask` puts real work on the server** — validation, allow-listing, application logic — and the semantics it leaves undefined are exactly the ones people get wrong.
- **`Any` defers type errors to runtime** and requires the target type to be linked in.
- **`Struct` discards every benefit of a schema** and is slower and larger than the equivalent JSON string.
- **`google.type.*` is a separate dependency**, and forgetting that produces a confusing "File not found".

**Trade-offs**
- *`Timestamp` vs `int64` nanos:* the WKT is self-describing and JSON-friendly; a raw `fixed64` of nanos is a few bytes smaller and marginally faster. Choose the WKT unless you have a measured reason.
- *`FieldMask` vs full replacement:* masks avoid lost updates and read-before-write, at the cost of server complexity. For small resources with a single writer, full replacement plus an ETag-style version field is simpler.
- *`Any` vs `oneof`:* `oneof` is type-safe and evolvable but requires a closed set known at schema-design time. `Any` is open but pushes every error to runtime. Prefer `oneof` until you can name a concrete extension point that genuinely cannot be enumerated.

## 7. Common Mistakes & Best Practices

- **`int64 created_at_millis` instead of `Timestamp`.** Units drift, epochs are assumed, and `0` means both 1970 and unset.
- **Constructing `Duration` by hand with mismatched signs.** Use `durationpb.New`.
- **Assuming `AsTime()` on a nil `Timestamp` panics.** It returns the zero time — so `nil` checks must be explicit, or you will silently write year 1 into a database.
- **Ignoring unknown `FieldMask` paths.** A typo then means a lost update the client believes succeeded. Reject with `InvalidArgument`.
- **Not allow-listing updatable paths.** A client can otherwise name `created_at` or the identifier.
- **Leaving empty-mask semantics undefined.** Pick "replace everything" or "reject", and document it in the `.proto` comment.
- **Expecting per-element mask paths on `repeated`/`map` fields.** There are none; those fields are always replaced wholesale.
- **Using `Any` to avoid modelling.** Every consumer's compile error becomes a runtime error.
- **Using `Struct` as a general escape hatch.** If you need JSON pass-through, say so; if you need a schema, write one.
- **Importing `google/type/money.proto` without the googleapis dependency.** Add `buf.build/googleapis/googleapis` to `deps` or vendor the files.
- **Using `Timestamp` for a calendar date.** A birthday is not an instant; use `google.type.Date`.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `protojson` renders WKTs in their canonical form, which makes logs and tickets readable: `"createdAt":"2026-07-24T10:30:00Z"` rather than an integer nobody can decode by eye. Set `EmitUnpopulated: true` when investigating "the field is missing" reports.
- **Validation.** Always call `CheckValid()` on `Timestamp` and `Duration` values that arrived from an untrusted peer — out-of-range values are representable on the wire and will produce nonsense times downstream. Always validate `FieldMask` paths against both `IsValid` and your allow-list before any storage access.
- **Security.** `Any` unpacking is a dynamic type lookup driven by attacker-controlled input; only unpack into types you expect, using `MessageIs`/`UnmarshalTo` rather than `UnmarshalNew`. `Struct` accepts arbitrarily deep nesting — bound it explicitly, since it is a memory-amplification vector.
- **Scaling.** `FieldMask`-driven updates let you write only the changed columns, which materially reduces write amplification and lock contention on wide rows. Pair the mask with an optimistic-concurrency field (an `etag` or version) so two concurrent partial updates cannot silently clobber each other.

## 9. Interview Questions

**Q: Why use `google.protobuf.Timestamp` instead of an `int64`?**
A: Because the WKT defines what the integer does not: the epoch, the units, the precision and the range. It also gives you presence — a `Timestamp` field is a message, so `nil` unambiguously means "not set", whereas `int64 0` means both "1 January 1970" and "unset". Practically, `protojson` renders it as RFC 3339, so a JSON gateway emits `"2026-07-24T10:30:00Z"` instead of an integer consumers must decode, and every language runtime ships conversion helpers so nobody re-derives the arithmetic.

**Q: What is a `FieldMask` and what problem does it solve?**
A: It is a list of dotted field paths naming exactly which fields of a message the server should act on. It solves partial updates, which proto3's implicit presence makes otherwise impossible: without a mask, an `UpdateItem` request cannot distinguish "set quantity to 0" from "leave quantity alone", because both serialise to the same bytes. With a mask the client states its intent explicitly, the server applies only the named paths, and everything else is untouched. It is also used as a `read_mask` for sparse reads.

**Q: What semantics must you define yourself when using `FieldMask`?**
A: Several the spec deliberately leaves open. What an empty mask means — AIP-134 says full replacement, but rejecting it is equally defensible; silently doing nothing is not. Whether `"*"` is supported. What happens on an unknown path — it must be `InvalidArgument`, because silently ignoring a typo means the client believes it updated something it did not. What happens when the mask names an immutable field such as the identifier or `created_at` — also `InvalidArgument`. And the distinction between `"dimensions"`, which replaces the whole sub-message, and `"dimensions.weight_g"`, which updates one leaf.

**Q: Can a `FieldMask` address individual elements of a repeated field?**
A: No. Repeated and map fields are always replaced wholesale; there is no path syntax for "element 3" or "the entry with key X". If clients need element-level mutation, that is a different API shape — a dedicated `AddTag`/`RemoveTag` RPC, or an explicit repeated message with its own identifiers and its own update method.

**Q: When would you use `google.protobuf.Any`, and what does it cost?**
A: Rarely and reluctantly. It is right when the set of possible messages genuinely cannot be enumerated at schema-design time — `google.rpc.Status.details`, long-running-operation results, plugin-style extension points. The cost is that a compile-time guarantee becomes a runtime error: unpacking requires the target type to be linked into the binary and registered, so a service receiving an `Any` it was not built with can do nothing useful. For a closed set, a `oneof` is strictly better; for genuinely opaque data, `bytes` plus a content-type field is more honest.

**Q: What is the difference between `Duration` and `Timestamp`?**
A: `Timestamp` is an absolute point in time — seconds since the Unix epoch plus nanos, always UTC, valid for years 1 through 9999. `Duration` is a signed elapsed interval of roughly ±10,000 years, where `seconds` and `nanos` must share a sign. Use `Timestamp` for `created_at` and `expires_at`, and `Duration` for timeouts, TTLs, retry backoff and media length. Mixing them up — an `int32 timeout_seconds` sitting next to a `Timestamp` — is a common schema smell.

**Q: Why is `optional` usually better than the wrapper types now?**
A: Both give a scalar explicit presence, but `optional` does it in the language rather than by wrapping the value in a message. That means no extra embedded message on the wire, no extra allocation, and a simpler generated API — a pointer plus a `Has…` accessor instead of a `*wrapperspb.Int32Value` you must construct and dereference. Wrapper types predate proto3's reintroduction of `optional` in 3.15 and survive mostly in older schemas and some Google APIs. New schemas should use `optional`.

**Q: (Senior) Design an `UpdateItem` RPC and walk through the server implementation.**
A: The request carries the `Item` with new values, using its identifier field to name the target, plus a `google.protobuf.FieldMask update_mask`. In the handler I validate before touching storage: check the identifier is present, call `mask.IsValid` against the message type to reject paths that do not exist, then check every path against an explicit allow-list of updatable fields so a client cannot name `created_at` or the identifier — an unknown or immutable path is `InvalidArgument`, never a silent drop. Empty mask means full replacement, documented in the `.proto` comment. Then I read the current item, clone it, apply exactly the named paths via protobuf reflection (so a message-typed path replaces the whole sub-message and repeated fields replace wholesale), set server-managed fields like `updated_at` myself, and persist. For concurrency I would add an `etag` or version field and make the write conditional, returning `Aborted` or `FailedPrecondition` on a mismatch, because otherwise two concurrent partial updates to different fields can still lose each other depending on the storage layer.

**Q: (Senior) A team wants a `google.protobuf.Struct` field for "flexible metadata". How do you respond?**
A: I would ask what is actually in it, because the answer usually reveals a modelling conversation that was skipped. If the values are genuinely opaque and originate outside our system — a webhook body, a customer-supplied config blob we only store and return — then `Struct` is defensible, or even `bytes` plus a content-type, which is more honest about opacity and avoids the conversion cost. If the values have any structure we depend on, `Struct` is the wrong choice: it discards type checking, breaks `buf breaking` detection entirely because the schema no longer describes the data, is larger and slower than the equivalent protobuf, and pushes every field-name typo to runtime. The middle ground I usually propose is a `map<string,string>` for labels when the values really are strings, or a `oneof` over the two or three shapes that actually occur. If we do ship `Struct`, I would bound its depth and size in validation, since arbitrary nesting is a memory-amplification vector.

**Q: (Senior) How do `FieldMask`s interact with authorization and auditing?**
A: They make both easier and both more important. Easier, because the mask states exactly which fields a request intends to change, so authorization can be field-level rather than method-level — a support agent may update `status` but not `unit_price`, and that check is a set intersection against the mask rather than a diff of the whole resource. More important, because the allow-list is now a security boundary: any path you fail to reject is a path a client can write. So the allow-list belongs next to the authorization logic, checked before storage access, and I would make the failure mode explicit `InvalidArgument` or `PermissionDenied` rather than a silent drop, since a silent drop means the client believes a change landed. For auditing, the mask plus the before/after values of exactly those paths is a far better audit record than a full-resource snapshot, and it is much cheaper to store.

## 10. Quick Revision & Cheat Sheet

| Type | Import | Go helper | JSON form |
|---|---|---|---|
| `Timestamp` | `google/protobuf/timestamp.proto` | `timestamppb.New(t)`, `.AsTime()` | `"2026-07-24T10:30:00Z"` |
| `Duration` | `google/protobuf/duration.proto` | `durationpb.New(d)`, `.AsDuration()` | `"3.5s"` |
| `FieldMask` | `google/protobuf/field_mask.proto` | `fieldmaskpb.New`, `.IsValid(m)` | `"name,status"` |
| `Empty` | `google/protobuf/empty.proto` | `&emptypb.Empty{}` | `{}` |
| `Any` | `google/protobuf/any.proto` | `anypb.New`, `.UnmarshalTo` | `{"@type":"…", …}` |
| `Struct` | `google/protobuf/struct.proto` | `structpb.NewStruct`, `.AsMap()` | plain JSON object |
| `Int32Value`… | `google/protobuf/wrappers.proto` | `wrapperspb.Int32(v)` | `42` or `null` |
| `Money` | `google/type/money.proto` *(googleapis)* | — | `{"currencyCode":"USD",…}` |
| `Date` | `google/type/date.proto` *(googleapis)* | — | `{"year":2026,…}` |

**Flash cards**
- **Point in time?** → `Timestamp`. Elapsed interval? → `Duration`. Calendar date? → `google.type.Date`.
- **Partial update?** → `FieldMask`, with an allow-list and `InvalidArgument` on unknown paths.
- **Empty mask means?** → Whatever you documented. AIP-134 says full replacement. Never "silently nothing".
- **Mask on a repeated field?** → Whole-field replacement only; no per-element paths.
- **Nullable scalar?** → `optional`, not wrapper types (which are legacy).
- **`Any`?** → Only when the type set genuinely cannot be enumerated. Prefer `oneof`.
- **`google.type.*` not found?** → It is from googleapis, not bundled with `protoc`. Add the dependency.

## 11. Hands-On Exercises & Mini Project

- [ ] Convert a schema that uses `int64 created_at_millis` to `Timestamp`, and compare the `protojson` output before and after.
- [ ] Call `AsTime()` on a nil `*Timestamp` and observe the zero time. Then write the nil check you should have had.
- [ ] Construct a negative `Duration` by hand with mismatched signs, marshal it, and see what `AsDuration()` returns. Fix it with `durationpb.New`.
- [ ] Implement `UpdateItem` with a `FieldMask`, then write tests for: unknown path, immutable path, empty mask, `"*"`, a nested leaf path, and a whole-sub-message path.
- [ ] Send an update with `paths: ["quantity_on_hand"]` and `quantity_on_hand: 0`, and prove the value actually changed to zero — the case a plain scalar cannot express.
- [ ] Pack an `Item` into an `Any`, then try to unpack it in a binary that does not import that package. Read the error and explain what it costs you.

### Mini Project — "Partial Update Service"

**Goal.** Implement a resource API with correct, well-documented `FieldMask` semantics and concurrency control — the pattern that appears in nearly every production gRPC API and in most design rounds.

**Requirements.**
1. A resource with at least ten fields including a nested message, a repeated field, a map, a `Timestamp`, a `Duration` and a `google.type.Money`.
2. `Get`, `Update` and `Delete` RPCs, with `Get` supporting a `read_mask` and `Delete` returning `google.protobuf.Empty`.
3. An explicit allow-list of updatable paths, with `InvalidArgument` for unknown paths, immutable paths, and (documented) empty-mask behaviour.
4. A generic mask applier built on protobuf reflection that handles nested paths, whole-sub-message replacement, and correct clearing when a masked field is unset.
5. Optimistic concurrency: an `etag` field on the resource, checked on update, returning `Aborted` on mismatch. Prove with a test that two concurrent partial updates to different fields both succeed and neither is lost.
6. A `protojson` round-trip test asserting the exact canonical form of every WKT field.

**Extensions.**
- Add field-level authorization: a role that may update `status` but not `unit_price`, enforced as a set intersection against the mask.
- Emit an audit record containing the mask plus the before/after values of only the masked paths, and compare its size against a full-resource snapshot.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *proto3 in Depth* (the presence problem `FieldMask` solves), *Build: The Complete Service .proto* (using these types in a real service), *Unary Handlers* (where mask validation belongs), *The Error Model* (where `Any` is legitimately used, for error details), *Schema Evolution* (why WKTs age better than hand-rolled fields).

- **Protocol Buffers — Well-Known Types reference** — Google · *Beginner* · every WKT with its exact definition, range and semantics; the primary source. <https://protobuf.dev/reference/protobuf/google.protobuf/>
- **Google AIP-134 — Standard methods: Update** — Google · *Intermediate* · the canonical specification of `FieldMask` update semantics, including empty-mask behaviour and immutable fields. Read this before designing any `Update` RPC. <https://google.aip.dev/134>
- **Google AIP-161 — Field masks** — Google · *Intermediate* · path syntax, wildcards, nested and repeated-field semantics, and read-mask usage. <https://google.aip.dev/161>
- **Protocol Buffers — JSON mapping** — Google · *Intermediate* · exactly how each WKT is rendered by `protojson`, which is what your gateway emits. <https://protobuf.dev/programming-guides/json/>
- **types/known packages — Go documentation** — Go Protobuf Authors · *Intermediate* · `timestamppb`, `durationpb`, `fieldmaskpb`, `anypb`, `structpb`, `wrapperspb` with all helpers and their edge cases. <https://pkg.go.dev/google.golang.org/protobuf/types/known>
- **googleapis — google/type common types** — Google · *Intermediate* · `Money`, `Date`, `LatLng`, `Interval` and friends; the layer above the base WKTs. <https://github.com/googleapis/googleapis/tree/master/google/type>
- **Google API Design Guide — Standard fields and methods** — Google · *Intermediate* · the naming and semantic conventions (`create_time`, `update_time`, `etag`) that pair with these types. <https://cloud.google.com/apis/design/standard_fields>
- **fmutils — FieldMask utilities for Go** — mennanov (open source) · *Intermediate* · a ready-made mask applier (`Filter`, `Prune`, `Overwrite`) if you would rather not write the reflection walk yourself. <https://github.com/mennanov/fmutils>

---

*gRPC with Go Handbook — chapter 10.*
