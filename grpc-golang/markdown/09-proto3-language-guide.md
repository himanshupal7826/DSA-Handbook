# 09 · proto3 in Depth: Messages, Scalars, Enums & Oneof

> **In one line:** proto3 is a small language with a handful of sharp edges — implicit defaults that erase zero values, enums that must start at zero, `oneof` that is not a union type in the way you expect, and `map` that is repeated key/value pairs in disguise — and knowing each edge is what separates a schema you can evolve from one you cannot.

---

## 1. Overview

proto3 is deliberately smaller than proto2. It dropped `required` (which turned out to be unfixable — a required field can never be removed), dropped custom default values, dropped groups, and made field presence implicit. What remains is about a dozen constructs, all of which you will use, several of which behave unlike their equivalents in Go or JSON.

This chapter is the language reference organised around the decisions you actually make: which scalar type, when to use `optional`, how to design an enum that can grow, when `oneof` is the right modelling tool and when it is a trap, and how `map` and nested types behave on the wire and in generated Go.

The recurring theme is **presence**. In Go, `0`, `""` and `false` are ordinary values you can distinguish from "not set" only with a pointer. proto3 made the same trade for the same reason — smaller messages — and then, in protobuf 3.15, reintroduced `optional` to give you the escape hatch back. Most schema bugs in proto3 trace to someone assuming a zero value means "absent" when it does not, or assuming a field is absent when it is actually zero.

The second theme is **permanence**. Field numbers, enum numbers and the shape of a `oneof` are effectively immutable once anything has serialised data using them. Every design choice in this chapter is a choice you live with, which is why the "what would I regret" question runs through it.

## 2. Core Concepts

- **`syntax = "proto3";`** — must be the first non-comment line. Without it, `protoc` assumes proto2 and everything changes.
- **`package`** — the proto namespace, forming part of every fully-qualified name and the gRPC `:path`. Must be globally unique (chapter 7).
- **Message** — a record of numbered, typed fields. Compiles to a Go struct.
- **Scalar types** — `double`, `float`, `int32/64`, `uint32/64`, `sint32/64`, `fixed32/64`, `sfixed32/64`, `bool`, `string`, `bytes`.
- **Implicit presence** — a proto3 scalar equal to its default is not serialised, so absent and default are the same. The core gotcha.
- **`optional`** — explicit presence for a scalar field; generates a Go pointer plus a `Has…` accessor.
- **`repeated`** — a list. Order is preserved. Empty and absent are indistinguishable.
- **`map<K,V>`** — sugar for `repeated MapEntry { K key = 1; V value = 2; }`. Unordered; no presence.
- **`enum`** — a named integer set. The first value **must** be `0` and is the default.
- **`oneof`** — at most one of a group of fields is set. Generates a Go interface with per-field wrapper types.
- **`reserved`** — permanently retires field numbers and names so they can never be reused (chapter 13).
- **Nested types** — messages and enums declared inside a message; namespaced as `Parent.Child`.
- **`json_name`** — overrides the canonical JSON key. Rarely needed; changing it is a `WIRE_JSON` break.

## 3. Theory & Principles

### Choosing a scalar type

The choice is a wire-cost decision (chapter 3) plus a range decision:

| Use case | Type | Why |
|---|---|---|
| Counts, quantities, ages — small, non-negative | `int32` | Varint; 1 byte for small values |
| IDs that must never be negative | `uint32` / `uint64` | Varint; no wasted sign bit |
| Deltas, balances, offsets — often negative | `sint32` / `sint64` | ZigZag; `-1` is 1 byte, not 10 |
| Hashes, random 64-bit ids, timestamps in nanos | `fixed64` | Always 8 bytes; beats a 9–10 byte varint |
| Money | `int64` cents, or a `Money` message | **Never `double`** — binary floats cannot represent `0.10` |
| Text | `string` | Must be valid UTF-8; the runtime enforces it |
| Opaque bytes, encrypted blobs, hashes | `bytes` | No UTF-8 validation, no encoding cost |
| Flags | `bool` | 1 byte, omitted when false |
| Timestamps | `google.protobuf.Timestamp` | Not `int64` — see chapter 10 |

Two rules worth stating as rules. **Money is never a float** — use integer minor units (`int64 amount_cents`) or a message with `int64 units` plus `int32 nanos` plus a currency code. **IDs are `string`, not integers**, unless you have a specific reason: opaque string ids let you change storage, prefix for readability (`ord_01HQ…`), and avoid enumeration attacks.

### Field presence: the single biggest gotcha

In proto3, a scalar field equal to its type's default (`0`, `""`, `false`, empty `bytes`) is **not written to the wire at all**. The receiver leaves the Go field at its zero value. So:

```go
// The server cannot tell these apart:
&UpdateRequest{QuantityOnHand: 0}   // "set quantity to zero"
&UpdateRequest{}                    // "don't change quantity"
```

Message-typed fields *do* have presence — they are pointers in Go, and `nil` means absent. `repeated` and `map` fields have no presence: empty and absent are the same.

The three fixes, in order of preference:

1. **`optional`** (protobuf ≥ 3.15). `optional int32 quantity_on_hand = 3;` generates `*int32` plus `HasQuantityOnHand()`. Wire-compatible with the non-optional form of the same number and type, so adding it later is safe.
2. **`FieldMask`** for update RPCs — the caller names exactly which fields it intends to change (chapter 10). This is the correct answer for `Update…` methods regardless of presence, because it expresses intent across many fields at once.
3. **Wrapper types** (`google.protobuf.Int32Value`). Legacy; `optional` supersedes them. Still seen in older schemas and some Google APIs.

### Enums: the zero value rule

Every proto3 enum's first value must be `0`, and that value is the default for any unset field of that type. This is not a style preference — it is enforced by the compiler, and it has a consequence: **if your zero value is a real state, every unset field silently becomes that state.**

```protobuf
// WRONG — an unset status is silently PENDING, and you cannot detect it.
enum OrderStatus {
  ORDER_STATUS_PENDING = 0;
  ORDER_STATUS_SHIPPED = 1;
}

// RIGHT — unset is distinguishable and invalid, so validation can reject it.
enum OrderStatus {
  ORDER_STATUS_UNSPECIFIED = 0;   // never a real state
  ORDER_STATUS_PENDING     = 1;
  ORDER_STATUS_SHIPPED     = 2;
  ORDER_STATUS_CANCELLED   = 3;
}
```

Two more enum rules that bite later:
- **Enum values share the enclosing namespace**, not the enum's. Two enums in the same `.proto` cannot both have a `PENDING` value — hence the `ENUM_NAME_VALUE` prefix convention that `buf lint` enforces.
- **Unknown enum values are preserved**, not rejected. A binary receiving value `7` for an enum it knows only up to `3` stores `7` and re-emits it. So a `switch` on an enum **must** have a default branch, and adding an enum value is safe on the wire but requires every consumer to handle the unknown case gracefully.

### `oneof`: what it is and is not

A `oneof` declares that at most one of a group of fields is set; setting one clears the others. On the wire it is nothing special — just the fields, with the runtime tracking which was last written.

```protobuf
message Notification {
  string recipient_id = 1;

  oneof channel {
    EmailChannel email = 2;
    SmsChannel   sms   = 3;
    PushChannel  push  = 4;
  }
}
```

In Go this generates an **interface** plus one wrapper struct per member:

```go
type Notification struct {
    RecipientId string
    Channel     isNotification_Channel   // interface
}
type Notification_Email struct{ Email *EmailChannel }
type Notification_Sms   struct{ Sms   *SmsChannel }
```

Which means `switch n.Channel.(type)` is how you read it — a genuine tagged union in Go, and one of proto3's better features.

What `oneof` is **not**: it is not a cheap way to save space (the fields cost the same), and it is not free to evolve. You can **add** a field to a `oneof`, but you cannot move a field into or out of one without breaking wire compatibility in subtle ways, and you cannot make a `oneof` field `repeated`. Also note that a `oneof` field has explicit presence even for scalars — which is occasionally used as a poor man's `optional`, though `optional` is clearer.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Field presence in proto3: what you can and cannot detect</text>

  <rect x="24" y="42" width="410" height="200" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="229" y="64" text-anchor="middle" fill="#b91c1c" font-size="13" font-weight="bold">Implicit presence (plain scalars)</text>
  <text x="40" y="88" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">int32 quantity_on_hand = 3;</text>
  <text x="40" y="112" fill="#991b1b">value 0 &#8594; NOT serialised &#8594; zero bytes on the wire</text>
  <text x="40" y="130" fill="#991b1b">receiver sees Go int32(0)</text>
  <rect x="40" y="142" width="180" height="34" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="130" y="163" text-anchor="middle" fill="#7f1d1d" font-size="10">"set quantity to 0"</text>
  <rect x="238" y="142" width="180" height="34" rx="6" fill="#fff" stroke="#fca5a5"/>
  <text x="328" y="163" text-anchor="middle" fill="#7f1d1d" font-size="10">"don't touch quantity"</text>
  <text x="229" y="196" text-anchor="middle" fill="#b91c1c" font-weight="bold">INDISTINGUISHABLE</text>
  <text x="40" y="220" fill="#991b1b" font-size="10">Also true for "" , false, and empty bytes.</text>
  <text x="40" y="236" fill="#991b1b" font-size="10">repeated / map: empty == absent, always.</text>

  <rect x="446" y="42" width="410" height="200" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="651" y="64" text-anchor="middle" fill="#15803d" font-size="13" font-weight="bold">Explicit presence</text>
  <text x="462" y="88" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">optional int32 quantity_on_hand = 3;</text>
  <text x="462" y="112" fill="#166534">generates *int32 + HasQuantityOnHand()</text>
  <rect x="462" y="128" width="180" height="34" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="552" y="149" text-anchor="middle" fill="#14532d" font-size="10">ptr to 0 &#8594; "set to 0"</text>
  <rect x="660" y="128" width="180" height="34" rx="6" fill="#fff" stroke="#86efac"/>
  <text x="750" y="149" text-anchor="middle" fill="#14532d" font-size="10">nil &#8594; "not set"</text>
  <text x="651" y="182" text-anchor="middle" fill="#15803d" font-weight="bold">DISTINGUISHABLE</text>
  <text x="462" y="206" fill="#166534" font-size="10">Message fields ALWAYS have presence (nil pointer).</text>
  <text x="462" y="222" fill="#166534" font-size="10">oneof members have presence too, even scalars.</text>
  <text x="462" y="238" fill="#166534" font-size="10">Wire-compatible with the non-optional form &#8212; safe to add later.</text>

  <rect x="24" y="258" width="832" height="196" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="440" y="280" text-anchor="middle" fill="#854d0e" font-size="13" font-weight="bold">The enum zero-value rule</text>

  <rect x="48" y="294" width="380" height="146" rx="8" fill="#fee2e2" stroke="#dc2626"/>
  <text x="238" y="314" text-anchor="middle" fill="#b91c1c" font-weight="bold">WRONG</text>
  <text x="64" y="336" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">enum OrderStatus {</text>
  <text x="64" y="352" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">  ORDER_STATUS_PENDING = 0;</text>
  <text x="64" y="368" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">  ORDER_STATUS_SHIPPED = 1;</text>
  <text x="64" y="384" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">}</text>
  <text x="64" y="408" fill="#991b1b" font-size="10">An unset status is silently PENDING.</text>
  <text x="64" y="424" fill="#991b1b" font-size="10">Validation can never reject "missing".</text>

  <rect x="452" y="294" width="380" height="146" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="642" y="314" text-anchor="middle" fill="#15803d" font-weight="bold">RIGHT</text>
  <text x="468" y="336" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">enum OrderStatus {</text>
  <text x="468" y="352" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">  ORDER_STATUS_UNSPECIFIED = 0;</text>
  <text x="468" y="368" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">  ORDER_STATUS_PENDING     = 1;</text>
  <text x="468" y="384" fill="#14532d" font-family="ui-monospace,monospace" font-size="10">  ORDER_STATUS_SHIPPED     = 2;</text>
  <text x="468" y="408" fill="#166534" font-size="10">Unset is detectable and rejectable.</text>
  <text x="468" y="424" fill="#166534" font-size="10">Prefix required: enum values share the OUTER namespace.</text>
</svg>
```

## 4. Architecture & Workflow

**Designing a message — the procedure.**

1. **Name the concept from the domain**, not the table. `Item`, not `InventoryRow`.
2. **List the fields a consumer needs**, and only those. Internal columns do not belong in a public schema.
3. **Assign numbers 1–15 to fields that appear in every message** or in elements of large `repeated` fields (chapter 3), leaving a small gap for future hot fields.
4. **Pick each scalar type** using the table in §3. Ask "can this be negative?" and "how large can this get?" for every numeric field.
5. **Decide presence per field.** Is a zero value meaningful and distinct from absent? If yes, `optional`.
6. **Model closed sets as enums** with an `_UNSPECIFIED = 0` first value and a value prefix.
7. **Model mutually exclusive alternatives as `oneof`**, not as several nullable fields with a comment saying "only one of these".
8. **Use well-known types** for time, duration and partial updates rather than inventing `int64 created_at_millis` (chapter 10).
9. **Write the comment before the field.** Comments flow into generated code in every language and are the only documentation consumers get.
10. **Ask "what would I regret?"** — the number, the type and the presence decision are effectively permanent.

```svg
<svg viewBox="0 0 880 380" width="100%" height="380" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">oneof in Go: a real tagged union</text>

  <rect x="30" y="42" width="360" height="180" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="210" y="64" text-anchor="middle" fill="#3730a3" font-size="12" font-weight="bold">.proto</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#4338ca">
    <text x="46" y="88">message Notification {</text>
    <text x="46" y="106">  string recipient_id = 1;</text>
    <text x="46" y="124">  oneof channel {</text>
    <text x="46" y="142">    EmailChannel email = 2;</text>
    <text x="46" y="160">    SmsChannel   sms   = 3;</text>
    <text x="46" y="178">    PushChannel  push  = 4;</text>
    <text x="46" y="196">  }</text>
    <text x="46" y="214">}</text>
  </g>

  <rect x="410" y="42" width="440" height="180" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="630" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">generated Go</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#166534">
    <text x="426" y="88">type Notification struct {</text>
    <text x="426" y="106">    RecipientId string</text>
    <text x="426" y="124">    Channel     isNotification_Channel   // interface</text>
    <text x="426" y="142">}</text>
    <text x="426" y="166">type Notification_Email struct{ Email *EmailChannel }</text>
    <text x="426" y="184">type Notification_Sms   struct{ Sms   *SmsChannel }</text>
    <text x="426" y="202">type Notification_Push  struct{ Push  *PushChannel }</text>
  </g>

  <rect x="30" y="240" width="820" height="126" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="440" y="262" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">Reading it &#8212; and the default branch you must not omit</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#713f12">
    <text x="52" y="286">switch ch := n.GetChannel().(type) {</text>
    <text x="52" y="302">case *pb.Notification_Email: sendEmail(ch.Email)</text>
    <text x="52" y="318">case *pb.Notification_Sms:   sendSMS(ch.Sms)</text>
    <text x="52" y="334">case *pb.Notification_Push:  sendPush(ch.Push)</text>
    <text x="52" y="350">default: return status.Error(codes.InvalidArgument, "channel is required or unknown")</text>
  </g>
  <text x="600" y="302" fill="#92400e" font-size="10" font-weight="bold">nil &#8594; nothing set</text>
  <text x="600" y="320" fill="#92400e" font-size="10" font-weight="bold">unknown type &#8594; a NEWER peer</text>
  <text x="600" y="338" fill="#92400e" font-size="10" font-weight="bold">added a member you don't know</text>
</svg>
```

## 5. Implementation

A schema exercising every construct, with the Go it produces and how to use it correctly.

```protobuf
syntax = "proto3";

package acme.inventory.v1;

import "google/protobuf/timestamp.proto";

option go_package = "github.com/acme/apis/gen/go/acme/inventory/v1;inventoryv1";

// Item is a stock-keeping unit as exposed to API consumers.
//
// Field numbers 1-15 are reserved for fields present on every Item, because
// their keys fit in a single byte (see the wire-format chapter).
message Item {
  // Opaque identifier, e.g. "sku_01HQ8ZK3". Clients MUST NOT parse this.
  string sku = 1;

  // Human-readable name. Always present; may be empty for draft items.
  string name = 2;

  // Units physically in the warehouse. Never negative.
  int32 quantity_on_hand = 3;

  // Units promised to orders but not yet shipped. Never negative.
  int32 quantity_reserved = 4;

  // Price in minor currency units (cents). NEVER a float — binary floating
  // point cannot represent 0.10 exactly, and money must be exact.
  int64 unit_price_minor = 5;

  // ISO 4217 currency code, e.g. "USD". Always uppercase.
  string currency_code = 6;

  // Lifecycle state. See ItemStatus for the legal transitions.
  ItemStatus status = 7;

  // Free-form labels for filtering. Keys are lowercase; values are opaque.
  // Note: maps are UNORDERED and have no presence — empty == absent.
  map<string, string> labels = 8;

  // Categorisation tags. Order is preserved and meaningful (most specific first).
  repeated string tags = 9;

  // Where the item physically lives. Absent means "not yet allocated".
  // Message fields always have presence: nil means absent.
  Location location = 10;

  google.protobuf.Timestamp created_at = 11;
  google.protobuf.Timestamp updated_at = 12;

  // Reorder threshold. EXPLICIT presence: a threshold of 0 ("reorder only when
  // empty") is a meaningful, distinct value from "no threshold configured".
  // This is exactly the case that plain int32 cannot express.
  optional int32 reorder_threshold = 13;

  // Nested types are namespaced as Item.Dimensions and generate
  // Item_Dimensions in Go.
  message Dimensions {
    int32 length_mm = 1;
    int32 width_mm  = 2;
    int32 height_mm = 3;
    int32 weight_g  = 4;
  }
  Dimensions dimensions = 14;

  // Field 15 intentionally left free for a future hot field (1-byte key).

  // Removed in v1.7 — see the schema-evolution chapter. Both the number and
  // the name are retired forever so neither can be reused.
  reserved 20;
  reserved "legacy_bin_code";
}

// ItemStatus is the lifecycle state of an Item.
//
// The zero value MUST be UNSPECIFIED so that "not set" is detectable and
// rejectable by validation. Enum values share the ENCLOSING namespace, which
// is why every value carries the ITEM_STATUS_ prefix.
enum ItemStatus {
  ITEM_STATUS_UNSPECIFIED  = 0;
  ITEM_STATUS_DRAFT        = 1;
  ITEM_STATUS_ACTIVE       = 2;
  ITEM_STATUS_DISCONTINUED = 3;
  ITEM_STATUS_ARCHIVED     = 4;
}

// Location expresses where stock sits, as mutually exclusive alternatives.
// This is exactly what oneof is for: three nullable fields plus a comment
// saying "only set one" is the anti-pattern it replaces.
message Location {
  oneof place {
    Warehouse warehouse = 1;
    Store     store     = 2;
    InTransit transit   = 3;
  }
}

message Warehouse { string warehouse_id = 1; string aisle = 2; string bin = 3; }
message Store     { string store_id = 1; string shelf = 2; }
message InTransit {
  string carrier = 1;
  string tracking_number = 2;
  google.protobuf.Timestamp expected_arrival = 3;
}
```

**Using it correctly in Go:**

```go
package inventory

import (
	"fmt"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	inventoryv1 "github.com/acme/apis/gen/go/acme/inventory/v1"
)

// describeLocation shows the idiomatic way to read a oneof: a type switch with
// a mandatory default branch. The default is not defensive padding — it fires
// when the field is unset AND when a newer peer sent a member this binary does
// not know about, which is a real situation during a rolling upgrade.
func describeLocation(loc *inventoryv1.Location) (string, error) {
	// Nil-safe: GetPlace() on a nil *Location returns nil, no panic.
	switch p := loc.GetPlace().(type) {
	case *inventoryv1.Location_Warehouse:
		w := p.Warehouse
		return fmt.Sprintf("warehouse %s aisle %s bin %s",
			w.GetWarehouseId(), w.GetAisle(), w.GetBin()), nil

	case *inventoryv1.Location_Store:
		return fmt.Sprintf("store %s shelf %s", p.Store.GetStoreId(), p.Store.GetShelf()), nil

	case *inventoryv1.Location_Transit:
		return fmt.Sprintf("in transit with %s (%s)",
			p.Transit.GetCarrier(), p.Transit.GetTrackingNumber()), nil

	case nil:
		return "", status.Error(codes.InvalidArgument, "location.place is required")

	default:
		// A newer client sent a member we were not compiled with.
		return "", status.Errorf(codes.Unimplemented,
			"unsupported location kind %T; upgrade this service", p)
	}
}

// validateStatus shows why the UNSPECIFIED zero value matters: without it,
// "the client forgot to set status" and "the client meant DRAFT" would be the
// same bytes and the same Go value.
func validateStatus(s inventoryv1.ItemStatus) error {
	switch s {
	case inventoryv1.ItemStatus_ITEM_STATUS_UNSPECIFIED:
		return status.Error(codes.InvalidArgument, "status is required")

	case inventoryv1.ItemStatus_ITEM_STATUS_DRAFT,
		inventoryv1.ItemStatus_ITEM_STATUS_ACTIVE,
		inventoryv1.ItemStatus_ITEM_STATUS_DISCONTINUED,
		inventoryv1.ItemStatus_ITEM_STATUS_ARCHIVED:
		return nil

	default:
		// Unknown enum numbers are PRESERVED, not rejected, by the runtime.
		// A newer peer can legitimately send value 7. Always have this branch.
		return status.Errorf(codes.InvalidArgument, "unknown status %d", int32(s))
	}
}

// applyReorderThreshold shows explicit presence in action.
func applyReorderThreshold(item *inventoryv1.Item) string {
	// The generated accessor for an optional field. Compare with GetReorderThreshold(),
	// which returns 0 for both "set to 0" and "not set".
	if item.ReorderThreshold == nil {
		return "no reorder rule configured"
	}
	if *item.ReorderThreshold == 0 {
		return "reorder only when completely empty"   // a real, distinct rule
	}
	return fmt.Sprintf("reorder below %d units", *item.ReorderThreshold)
}

// buildItem shows constructing a message with a oneof and a map.
func buildItem() *inventoryv1.Item {
	threshold := int32(0) // meaningful zero — needs a pointer to express

	return &inventoryv1.Item{
		Sku:              "sku_01HQ8ZK3",
		Name:             "Blue Widget",
		QuantityOnHand:   42,
		UnitPriceMinor:   1299,
		CurrencyCode:     "USD",
		Status:           inventoryv1.ItemStatus_ITEM_STATUS_ACTIVE,
		Labels:           map[string]string{"category": "widgets", "hazmat": "false"},
		Tags:             []string{"blue", "widget", "small"},
		ReorderThreshold: &threshold,

		Location: &inventoryv1.Location{
			// A oneof member is set by assigning the wrapper struct.
			Place: &inventoryv1.Location_Warehouse{
				Warehouse: &inventoryv1.Warehouse{
					WarehouseId: "wh_lon_01", Aisle: "A12", Bin: "B3",
				},
			},
		},

		Dimensions: &inventoryv1.Item_Dimensions{ // nested type: Parent_Child
			LengthMm: 120, WidthMm: 80, HeightMm: 40, WeightG: 250,
		},
	}
}
```

**Comparing messages** — never `==` or `reflect.DeepEqual`, because generated structs carry internal state:

```go
import (
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/testing/protocmp"
	"github.com/google/go-cmp/cmp"
)

proto.Equal(a, b)                             // runtime comparison
cmp.Diff(want, got, protocmp.Transform())     // readable diffs in tests
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of proto3's design**
- **Small and learnable.** A dozen constructs, no `required`, no custom defaults, no groups.
- **Implicit defaults keep messages small** — the common case of "field is zero" costs nothing.
- **`oneof` generates a real tagged union in Go**, which is better type safety than most languages' native options.
- **Unknown enum values and unknown fields are preserved**, making rolling upgrades safe by default.
- **Nested types keep namespaces tidy** without extra files.

**Disadvantages**
- **Implicit presence is a footgun.** Every team rediscovers the zero-vs-unset problem the hard way.
- **Enums leak into the enclosing namespace**, forcing verbose prefixes.
- **No validation whatsoever** — no ranges, no formats, no required fields, no cross-field rules.
- **`map` has no presence, no ordering and no nesting** (`map<string, map<...>>` is illegal — wrap in a message).
- **`oneof` cannot be `repeated`**, so "a list of alternatives" needs a wrapper message.

**Trade-offs**
- *`optional` everywhere vs only where needed:* explicit presence is safer but produces pointer fields, more allocations and more `nil` checks. Use it where a zero value is genuinely meaningful, not reflexively.
- *`map` vs `repeated` key/value message:* `map` is ergonomic; an explicit repeated message lets you add per-entry fields later and control ordering. For anything that might grow attributes, prefer the explicit form.
- *Nested vs top-level messages:* nesting communicates ownership and avoids namespace pollution, but a nested message cannot be reused elsewhere without an awkward `Parent.Child` reference.

## 7. Common Mistakes & Best Practices

- **Enum zero value that is a real state.** Always `<ENUM>_UNSPECIFIED = 0`. Without it you cannot detect "not set".
- **Assuming `0` means unset.** It does not. Use `optional`, or a `FieldMask` on updates.
- **`double` for money.** Binary floats cannot represent `0.10`. Use `int64` minor units.
- **`int64` for timestamps.** Use `google.protobuf.Timestamp` — self-documenting, unambiguous about units and epoch, with `protojson` support (chapter 10).
- **Switching on an enum or `oneof` without a default branch.** Unknown values are preserved and will arrive during rolling upgrades.
- **Direct field access instead of getters.** `item.Location.Place` panics on nil; `item.GetLocation().GetPlace()` does not.
- **Reusing field numbers after deletion.** Silent data corruption, not an error. Always `reserved`.
- **Enum values without a prefix.** They share the enclosing namespace and will collide.
- **Sharing one message across many RPCs.** You can then never add a field for one method without affecting all of them (chapter 8).
- **`reflect.DeepEqual` on messages.** Use `proto.Equal` or `protocmp.Transform()`.
- **Hot fields numbered above 15.** Two key bytes instead of one, on every message.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `prototext.Format(m)` for logs, `protojson.Marshal` for tickets — but write a redacting formatter before logging any message with user data. `protojson` with `EmitUnpopulated: true` shows fields the implicit-presence rules would otherwise hide, which is often exactly what you need when debugging a "field is missing" report.
- **Validation.** protobuf gives you types and UTF-8 and nothing else. Adopt `protovalidate` so constraints live in the schema and generate checks in every language, and run them in an interceptor before any handler (chapters 15 and 23).
- **Security.** Unbounded `repeated` and `map` fields are a memory-exhaustion vector; bound them explicitly in validation, not just via `MaxRecvMsgSize`. `string` fields are UTF-8-validated but not length-checked. Deeply nested messages hit Go's recursion limit (100) — do not rely on that as your only defence.
- **Scaling.** Watch `proto.Size` percentiles per method (chapter 3). The fields that grow unboundedly in practice are `repeated` lists and `map` labels; put explicit caps in the schema comment and enforce them in validation before they become an incident.

## 9. Interview Questions

**Q: In proto3, how do you tell "field set to zero" from "field not set"?**
A: With plain scalars you cannot — a field equal to its default is not serialised, so the receiver sees the Go zero value in both cases. The fix is the `optional` keyword, re-enabled for proto3 in protobuf 3.15, which gives explicit presence: a pointer field plus a `Has…` accessor, wire-compatible with the non-optional form so it is safe to add later. For update RPCs specifically the better answer is a `FieldMask`, because the caller needs to express intent across many fields at once. Message-typed fields always have presence; `repeated` and `map` never do.

**Q: Why must a proto3 enum's first value be zero, and why must it be `UNSPECIFIED`?**
A: The compiler requires the first value to be `0`, and that value is the default for any unset field of that type. So if zero is a real state — `PENDING = 0` — then an unset field silently becomes `PENDING` and validation can never reject "the client forgot to set this". Making the zero value `<ENUM>_UNSPECIFIED` keeps it out of the domain and makes absence detectable. It also matters that enum values share the *enclosing* namespace, not the enum's, which is why every value needs the enum-name prefix.

**Q: What happens when a binary receives an enum value it does not know?**
A: It is preserved, not rejected — the runtime stores the raw number and re-emits it on marshal, exactly as with unknown fields. That is what makes adding an enum value a safe, additive change. The consequence for your code is that a `switch` on an enum must always have a `default` branch, because during a rolling upgrade a newer peer will legitimately send a value this binary was not compiled with.

**Q: What does `oneof` generate in Go, and how do you read it?**
A: An interface field on the parent struct plus one wrapper struct per member — `Notification_Email`, `Notification_Sms` — so you read it with a type switch on `n.GetChannel().(type)`. That is a genuine tagged union, which is stronger typing than several nullable fields with a comment saying "only set one". The switch needs a `nil` case for "nothing set" and a `default` case for a member added by a newer peer.

**Q: What is a `map` on the wire?**
A: Syntactic sugar for `repeated MapEntry { key = 1; value = 2; }`. That has three consequences: iteration order is undefined, there is no presence (empty and absent are identical), and you cannot nest a map directly inside a map — you must wrap the inner one in a message. If you might later need per-entry metadata, or need ordering, declare the repeated key/value message explicitly rather than using `map`.

**Q: Which scalar type would you use for money, and why not `double`?**
A: `int64` holding minor units — cents — or a message with `int64 units`, `int32 nanos` and a currency code, following `google.type.Money`. `double` is wrong because binary floating point cannot represent decimal fractions such as `0.10` exactly, so sums drift and equality comparisons fail; that is a correctness bug in a financial system, not a rounding nicety. I would also always carry the currency code alongside the amount, because a bare number is meaningless.

**Q: Why should hot fields get numbers 1–15?**
A: Each field is preceded by a varint key encoding `(field_number << 3) | wire_type`, so three bits are consumed by the wire type and field numbers up to 15 leave the key inside one byte; 16 and above need two. For a field present in every message — or worse, in every element of a large `repeated` field — that extra byte multiplies quickly. I usually reserve 1–15 for always-present fields and leave one or two free for future hot additions.

**Q: (Senior) Design an `Item` message for an inventory API and defend three decisions.**
A: I would use `string sku` as an opaque prefixed identifier rather than an integer, so storage can change and enumeration is impractical; `int64 unit_price_minor` plus a `string currency_code` rather than a float, because money must be exact and a bare amount is ambiguous; and an `ItemStatus` enum with `ITEM_STATUS_UNSPECIFIED = 0` so "not set" is rejectable by validation. Beyond those, I would use `google.protobuf.Timestamp` for `created_at`/`updated_at` rather than an `int64` of unclear units, `optional int32 reorder_threshold` because a threshold of zero is a real rule distinct from "no rule configured", and a `oneof` for location because warehouse, store and in-transit are genuinely mutually exclusive. Numbers 1–15 go to fields present on every item, with one left free.

**Q: (Senior) A field must change from `int32` to `int64`. What are the options?**
A: On the wire, `int32` and `int64` are both varint and are actually compatible in the narrow sense — an `int32` value decodes as `int64` and vice versa within range — so the bytes survive. But the change is a source-level break: the generated Go type changes, every consumer's code stops compiling, and `buf breaking` correctly flags it at `FILE`. It is also a real truncation hazard for values above 2^31 read by an un-upgraded consumer. So the safe path is additive: add a new `int64` field with a new number, populate both during a transition window, migrate consumers by name using traffic data, then deprecate and eventually delete the old field with `reserved`. Changing the type in place is only defensible when you can prove there is exactly one consumer and you control its deployment.

**Q: (Senior) When would you choose `oneof` over separate optional fields, and when is it a mistake?**
A: `oneof` is right when the alternatives are genuinely mutually exclusive and the set is closed-ish — a payment method, a location kind, an event payload — because it makes the exclusivity a compile-time property rather than a comment, and Go gets a real tagged union with an exhaustive-ish type switch. It is a mistake when the alternatives are not actually exclusive (you will discover you need two of them and have to restructure), when you need a *list* of alternatives (a `oneof` cannot be `repeated`, so you need a wrapper message anyway), or when you are reaching for it merely to get presence on a scalar — `optional` is clearer for that. The evolution constraint matters too: adding a member to a `oneof` is safe, but moving an existing field into or out of one is not, so I would rather start with a `oneof` containing one member than retrofit one later.

**Q: (Senior) How do you keep a large schema evolvable across many teams?**
A: Four disciplines, all enforced rather than documented. One request and response message per RPC, never shared, so a field added for one method cannot affect another. Every enum gets an `UNSPECIFIED` zero and a value prefix, and every `switch` on an enum or `oneof` has a default branch, so adding values is genuinely safe. Every deleted field number and name goes into `reserved` immediately, because reuse causes silent corruption rather than a loud error. And all of it runs through `buf lint` and `buf breaking` at `FILE` in CI against the last release, so the cost of a breaking change lands on the author at PR time. On top of that I would put validation constraints in the schema with `protovalidate`, because a rule that lives only in one service's handler is a rule the other five implementations will get wrong.

## 10. Quick Revision & Cheat Sheet

```protobuf
syntax = "proto3";
package acme.domain.v1;
option go_package = "github.com/acme/apis/gen/go/acme/domain/v1;domainv1";

message Thing {
  string  id        = 1;              // opaque id, not an int
  int32   count     = 2;              // small non-negative
  sint64  delta     = 3;              // often negative -> ZigZag
  int64   price_minor = 4;            // money: NEVER double
  bool    active    = 5;
  Status  status    = 6;              // enum with UNSPECIFIED = 0
  repeated string tags = 7;           // no presence: empty == absent
  map<string,string> labels = 8;      // unordered, no presence, cannot nest
  Nested  nested    = 9;              // message: HAS presence (nil = absent)
  optional int32 threshold = 10;      // explicit presence: *int32 + Has()
  oneof target { A a = 11; B b = 12; } // tagged union in Go
  reserved 13, 14; reserved "old_name";
}

enum Status {
  STATUS_UNSPECIFIED = 0;             // MUST be first, MUST not be a real state
  STATUS_ACTIVE      = 1;
}
```

| Construct | Presence? | Go type | Gotcha |
|---|---|---|---|
| scalar | No | value | `0`/`""`/`false` == unset |
| `optional` scalar | Yes | pointer + `Has…` | Extra allocation |
| message | Yes | pointer | Use getters; `nil` is normal |
| `repeated` | No | slice | Empty == absent; bound the size |
| `map` | No | map | Unordered; cannot nest maps |
| `enum` | No | int32 type | Zero must be `UNSPECIFIED`; needs a `default` branch |
| `oneof` | Yes (per member) | interface + wrappers | Cannot be `repeated`; needs `nil` + `default` cases |

**Flash cards**
- **Zero vs unset?** → Indistinguishable for plain scalars. Use `optional` or a `FieldMask`.
- **First enum value?** → `<ENUM>_UNSPECIFIED = 0`, always, with a value prefix.
- **Unknown enum value arrives?** → Preserved and re-emitted. Always write a `default` branch.
- **Money type?** → `int64` minor units + currency code. Never `double`.
- **What is a `map` really?** → `repeated MapEntry{key,value}` — unordered, no presence, not nestable.
- **Comparing messages?** → `proto.Equal`, or `protocmp.Transform()` with `go-cmp`.
- **Deleted a field?** → `reserved` the number *and* the name, immediately.

## 11. Hands-On Exercises & Mini Project

- [ ] Write a message with a plain `int32` and an `optional int32`. Marshal both with value `0` and compare `proto.Size` and the raw bytes. Explain the difference.
- [ ] Define an enum with a real state at zero, send an unset field, and observe the silent default. Fix it with `UNSPECIFIED` and add validation that rejects it.
- [ ] Add a new enum value in a "newer" copy of the schema, send it to a binary built against the older copy, and confirm the value is preserved through a round trip.
- [ ] Model a payment method three ways — separate nullable fields, a `oneof`, and a string discriminator plus a `google.protobuf.Any`. Write the Go that reads each and rank them for safety.
- [ ] Build a message with a `map<string,string>` of 10,000 entries, marshal it twice, and compare the byte output. Explain why they differ and what `Deterministic: true` changes.
- [ ] Take a real `.proto` from your work and run the §4 procedure over it. List every field where you would now choose a different type, number or presence.

### Mini Project — "Schema Design Review"

**Goal.** Design a complete, review-quality schema for a non-trivial domain and defend every construct choice — the exercise a design round actually tests.

**Requirements.**
1. Pick a domain with real modelling tension (order management, ride-hailing, ticketing) and write the messages for at least six entities.
2. For every field record: the chosen type, why not the alternatives, the field number and why, and whether it needs explicit presence.
3. Use at least one enum (with `UNSPECIFIED`), one `oneof`, one `map`, one `repeated`, one nested message, and one `optional` scalar where the zero value is meaningful — and justify each.
4. Write the Go that reads every `oneof` and enum with correct `nil` and `default` handling, and a test that feeds it an unknown enum value and an unknown `oneof` member.
5. Run `buf lint` at `STANDARD` and fix every violation, or document the exception with a reason.
6. Write a one-page "what I would regret" note: for each entity, the decision most likely to be wrong in three years and what the migration would cost.

**Extensions.**
- Add `protovalidate` constraints to every field and generate the validation, then write tests proving each constraint fires.
- Produce a v2 of one message that renames a field and moves another into a `oneof`, and run `buf breaking` at each category to see exactly which fail and why.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Protocol Buffers: Binary Wire Format* (what each type costs), *Well-Known Types* (Timestamp, Duration, FieldMask), *Build: The Complete Service .proto* (assembling these into a service), *Schema Evolution* (which of these choices you can change later), *Buf* (linting these rules automatically).

- **Protocol Buffers — Language Guide (proto3)** — Google · *Beginner* · the complete syntax reference: scalars, defaults, enums, `oneof`, `map`, nesting, `reserved` and `optional`. The primary source for this chapter. <https://protobuf.dev/programming-guides/proto3/>
- **Protocol Buffers — Field Presence** — Google · *Intermediate* · the definitive treatment of implicit versus explicit presence, exactly what `optional` changes, and the wire-compatibility rules. <https://protobuf.dev/programming-guides/field_presence/>
- **Protocol Buffers — Best Practices & Do's and Don'ts** — Google · *Intermediate* · hard-won guidance on field numbering, enum design, message reuse and what never to change. <https://protobuf.dev/best-practices/dos-donts/>
- **Buf Style Guide** — Buf (open source) · *Beginner* · the naming, prefixing and structure conventions used throughout this chapter, enforced by `buf lint`. <https://buf.build/docs/best-practices/style-guide>
- **Protocol Buffers — Go Generated Code Guide** — Google · *Intermediate* · exactly what Go each construct produces, including `oneof` wrappers, `optional` pointers and nested type naming. <https://protobuf.dev/reference/go/go-generated/>
- **Google API Improvement Proposals — AIP-126 (Enumerations) and AIP-140 (Field names)** — Google · *Intermediate* · why `UNSPECIFIED`, why prefixes, and the naming rules a large API estate converges on. <https://google.aip.dev/126>
- **protovalidate** — Buf · *Intermediate* · CEL-based constraints expressed in the schema, filling proto3's complete absence of validation. <https://github.com/bufbuild/protovalidate>
- **google.golang.org/protobuf/testing/protocmp** — Go Protobuf Authors · *Intermediate* · the correct way to compare messages in tests, and why `reflect.DeepEqual` is wrong. <https://pkg.go.dev/google.golang.org/protobuf/testing/protocmp>

---

*gRPC with Go Handbook — chapter 09.*
