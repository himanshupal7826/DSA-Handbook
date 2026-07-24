# 13 · Schema Evolution: Field Numbers, Compatibility & Deprecation

> **In one line:** Protobuf's compatibility rules make additive change free and everything else dangerous — and the single most destructive mistake is reusing a field number, because it produces silent misinterpretation of old data rather than a loud failure.

---

## 1. Overview

A schema in production is not a design artefact; it is a running contract between binaries you do not control the deployment order of. During any rolling upgrade, old and new versions of both client and server are live simultaneously, and messages flow in every combination: new→old, old→new, and — through a queue or a database — new→old→new. Protobuf is unusually good at surviving this, but only if you obey its rules.

The rules divide changes into three tiers:

- **Always safe.** Adding a field with a new number, adding a message, adding an RPC, adding an enum value, adding a comment, marking something deprecated, and reserving a number you removed. These work in both directions because of unknown-field preservation (chapter 3).
- **Safe on the wire, breaking in source.** Renaming a field (bytes are identical, but generated getters change and `protojson` output changes), moving a message between files, changing `go_package`. These break consumers' compilation, not their bytes.
- **Never safe.** Reusing a field number for a different meaning, changing a field's type across wire-type boundaries, changing a field number, changing an RPC's request or response type, removing an RPC still in use.

The one that deserves its own paragraph is **field-number reuse**. If you delete `int32 quantity_on_hand = 3` and later add `string warehouse_id = 3`, then an old message on the wire — in a queue, in a database blob, in a replayed log — will be parsed as a `warehouse_id` containing garbage, or will fail to parse, depending on wire types. No error is raised at schema-compile time. The data is silently wrong. `reserved` exists specifically to make this impossible, and using it is not optional.

The second half of this chapter is the **process**: how you actually remove a field from a system with fifteen consumers you do not control, which is a communication and measurement problem more than a technical one.

## 2. Core Concepts

- **Wire compatibility** — old and new binaries can exchange messages without data loss or misinterpretation.
- **Source compatibility** — existing consumer code still compiles against the regenerated stubs.
- **Unknown-field preservation** — a parser retains fields it does not recognise and re-emits them on marshal. The mechanism that makes additive change safe in both directions.
- **Field number** — the permanent wire identity of a field. Names are irrelevant to the binary format.
- **`reserved`** — a declaration retiring field numbers and/or names so the compiler rejects any reuse.
- **`[deprecated = true]`** — a field or method option that generates a deprecation annotation in most languages. Non-breaking; a signal, not an enforcement.
- **Compatible type changes** — a small set of type substitutions that share a wire type: `int32`/`int64`/`uint32`/`uint64`/`bool`, `sint32`/`sint64`, `fixed32`/`sfixed32`, `fixed64`/`sfixed64`, `string`/`bytes` (when the bytes are valid UTF-8).
- **`optional` retrofit** — adding `optional` to an existing proto3 scalar is wire-compatible; removing it is too, but both change generated Go types.
- **Major version package** — `acme.inventory.v2` alongside `v1`, the only clean way to make a genuinely breaking change.
- **Sunset process** — deprecate → measure → notify → wait → delete with `reserved`.

## 3. Theory & Principles

### The compatibility matrix

| Change | Wire compatible? | Source compatible? | Verdict |
|---|---|---|---|
| Add a field with a **new** number | ✅ | ✅ | Always safe |
| Add a message / enum / RPC | ✅ | ✅ | Always safe |
| Add an enum value | ✅ | ✅ (needs a `default` branch) | Safe |
| Add a `oneof` member | ✅ | ✅ (needs a `default` branch) | Safe |
| Mark `[deprecated = true]` | ✅ | ✅ (may warn) | Safe |
| Add a comment | ✅ | ✅ | Safe |
| **Rename** a field | ✅ | ❌ | Source break; also breaks `protojson` |
| Rename a message / enum / RPC | ❌ (RPC path changes) | ❌ | Breaking |
| Move a message to another file | ✅ | ❌ (with `FILE` checks) | Source break |
| Change `go_package` | ✅ | ❌ | Source break for Go consumers |
| `int32` → `int64` | ✅ (same wire type) | ❌ | Source break + truncation risk |
| `int32` → `sint32` | ❌ | ❌ | Different encoding — data corruption |
| `string` → `bytes` | ✅ | ❌ | Source break |
| `bytes` → `string` | ⚠️ only if valid UTF-8 | ❌ | Risky |
| Scalar → `repeated` scalar | ⚠️ packed cases only | ❌ | Avoid |
| Add `optional` to a scalar | ✅ | ❌ (type becomes a pointer) | Source break |
| Move a field into/out of a `oneof` | ⚠️ | ❌ | Avoid |
| **Delete** a field without `reserved` | ✅ *now*, ❌ later | ✅ | **Dangerous** — sets a trap |
| Delete a field **with** `reserved` | ✅ | ❌ for readers of that field | Correct removal |
| **Reuse** a field number | ❌ | ✅ (compiles!) | **Never.** Silent corruption |
| Change a field number | ❌ | ✅ | Never |
| Change an RPC's request/response type | ❌ | ❌ | Never |
| Delete an RPC in use | ❌ (`Unimplemented`) | ❌ | Needs a sunset process |

Two rows deserve emphasis. **"Delete a field without `reserved`" compiles and works today**, which is exactly why it is dangerous: the trap is armed for whoever adds the next field. And **"reuse a field number" compiles cleanly** — the compiler has no way to know the number meant something else last year.

### Why number reuse corrupts silently

Suppose v1 had `int32 quantity_on_hand = 3` (wire type 0, varint) and v2 replaces it with `string warehouse_id = 3` (wire type 2, length-delimited).

- **Old data, new parser.** The old bytes carry key `0x18` = field 3, wire type 0. The new parser expects wire type 2 for field 3. Protobuf's rule is that a *wire-type mismatch* makes the field unknown, so it is skipped and retained as unknown data — you silently lose the value, and `warehouse_id` is empty.
- **Worse case: same wire type.** If v1 had `int32 code = 3` and v2 has `int32 warehouse_number = 3`, the wire types match and the old value is decoded straight into the new field. Now a quantity of 42 is a warehouse number of 42. Nothing errors. Everything downstream is wrong.

The second case is the one that reaches production, because it is invisible in every test that does not replay genuinely old data. `reserved` prevents it at compile time:

```protobuf
message Item {
  string sku = 1;
  string name = 2;
  // 3 was quantity_on_hand, removed in v1.7 (ADR-114).
  reserved 3;
  reserved "quantity_on_hand";

  string warehouse_id = 4;   // a NEW number — the only correct choice
}
```

Reserve **both** the number and the name: the number protects the wire, the name protects `protojson` and text-format consumers and prevents a confusing re-introduction.

```svg
<svg viewBox="0 0 880 490" width="100%" height="490" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="ev1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#dc2626"/></marker>
    <marker id="ev2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Field-number reuse: the failure that never raises an error</text>

  <rect x="24" y="42" width="832" height="196" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#b91c1c" font-size="13" font-weight="bold">The dangerous case: same wire type</text>

  <rect x="48" y="78" width="230" height="86" rx="8" fill="#fff" stroke="#fca5a5"/>
  <text x="163" y="98" text-anchor="middle" fill="#7f1d1d" font-weight="bold">v1 schema (2024)</text>
  <text x="60" y="120" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">int32 quantity = 3;</text>
  <text x="60" y="142" fill="#991b1b" font-size="10">wire: key 0x18, varint 42</text>
  <text x="60" y="158" fill="#991b1b" font-size="10">stored in a queue / DB blob</text>

  <path d="M282,120 L338,120" stroke="#dc2626" stroke-width="2" marker-end="url(#ev1)"/>
  <text x="310" y="112" text-anchor="middle" fill="#b91c1c" font-size="9">old bytes</text>

  <rect x="342" y="78" width="230" height="86" rx="8" fill="#fff" stroke="#fca5a5"/>
  <text x="457" y="98" text-anchor="middle" fill="#7f1d1d" font-weight="bold">v2 schema (2026)</text>
  <text x="354" y="120" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">int32 warehouse_no = 3;</text>
  <text x="354" y="142" fill="#991b1b" font-size="10">same wire type &#8594; decodes cleanly</text>
  <text x="354" y="158" fill="#991b1b" font-size="10">no error, no warning, no log line</text>

  <path d="M576,120 L632,120" stroke="#dc2626" stroke-width="2" marker-end="url(#ev1)"/>

  <rect x="636" y="78" width="196" height="86" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="734" y="102" text-anchor="middle" fill="#b91c1c" font-weight="bold">SILENT CORRUPTION</text>
  <text x="734" y="124" text-anchor="middle" fill="#7f1d1d" font-size="10">quantity 42</text>
  <text x="734" y="140" text-anchor="middle" fill="#7f1d1d" font-size="10">&#8594; warehouse number 42</text>
  <text x="734" y="158" text-anchor="middle" fill="#7f1d1d" font-size="10">every test passes</text>

  <text x="48" y="188" fill="#991b1b">The schema compiler cannot help: it has no memory of what number 3 meant two years ago.</text>
  <text x="48" y="208" fill="#991b1b">Every unit test passes, because tests use freshly-encoded data. Only replayed OLD data exposes it.</text>
  <text x="48" y="228" fill="#7f1d1d" font-weight="bold">If the wire types differ, you "only" lose the value silently &#8212; still a bug, just a quieter one.</text>

  <rect x="24" y="256" width="832" height="222" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="278" text-anchor="middle" fill="#15803d" font-size="13" font-weight="bold">The fix: reserved, applied at deletion time &#8212; not later</text>

  <rect x="48" y="294" width="380" height="160" rx="8" fill="#fff" stroke="#86efac"/>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#14532d">
    <text x="62" y="316">message Item {</text>
    <text x="62" y="334">  string sku  = 1;</text>
    <text x="62" y="352">  string name = 2;</text>
    <text x="62" y="374">  // 3 was quantity, removed v1.7 (ADR-114)</text>
    <text x="62" y="392">  reserved 3;</text>
    <text x="62" y="410">  reserved "quantity_on_hand";</text>
    <text x="62" y="432">  string warehouse_id = 4;   // NEW number</text>
    <text x="62" y="450">}</text>
  </g>

  <path d="M434,374 L488,374" stroke="#16a34a" stroke-width="2" marker-end="url(#ev2)"/>

  <rect x="492" y="294" width="340" height="160" rx="8" fill="#dcfce7" stroke="#16a34a"/>
  <text x="662" y="316" text-anchor="middle" fill="#15803d" font-weight="bold">What each line buys</text>
  <text x="506" y="340" fill="#166534" font-size="10">reserved 3;  &#8594; protects the WIRE. The compiler</text>
  <text x="506" y="356" fill="#166534" font-size="10">rejects any future field numbered 3.</text>
  <text x="506" y="380" fill="#166534" font-size="10">reserved "quantity_on_hand";  &#8594; protects</text>
  <text x="506" y="396" fill="#166534" font-size="10">protojson and text-format consumers, and stops</text>
  <text x="506" y="412" fill="#166534" font-size="10">a confusing re-introduction under the same name.</text>
  <text x="506" y="436" fill="#15803d" font-size="10" font-weight="bold">Reserve BOTH. Always. At the moment of deletion.</text>
</svg>
```

### Compatible type changes, precisely

A handful of type substitutions are wire-compatible because they share a wire type:

- **`int32` ↔ `int64` ↔ `uint32` ↔ `uint64` ↔ `bool`** — all varint. Values out of the narrower type's range are truncated on read, which is a real hazard: widening `int32` to `int64` is safe until a value exceeds 2^31 and an un-upgraded consumer truncates it.
- **`sint32` ↔ `sint64`** — both ZigZag. **Not** interchangeable with `int32`/`int64`: the encodings differ, so switching corrupts values.
- **`fixed32` ↔ `sfixed32`**, **`fixed64` ↔ `sfixed64`** — same fixed widths.
- **`string` ↔ `bytes`** — both length-delimited. `string` → `bytes` is safe; `bytes` → `string` only if every existing value is valid UTF-8.
- **A message ↔ `bytes`** containing that message's encoding — technically compatible, practically a trap.
- **Singular ↔ `repeated`** of the same scalar — works for packed encodings in proto3, but is confusing and `buf breaking` flags it. Avoid.

All of these are **source-breaking** even when wire-compatible, because the generated Go type changes. Treat "wire-compatible" as "the data survives", not "you can do this freely".

### Enum evolution

Adding an enum value is safe on the wire — unknown values are preserved and re-emitted — but it is a *behavioural* change for every consumer, because a `switch` without a `default` branch will silently fall through. So:

- **Always write a `default` branch** on enum switches, returning an explicit error or a safe fallback.
- **Never renumber** an enum value; the number is the wire identity.
- **Never remove** an enum value in use; deprecate it and reserve the number.
- **Reserve removed enum numbers and names**, exactly as for fields.

## 4. Architecture & Workflow

### The removal process

Removing anything from a live schema is a communication problem with a technical epilogue. The process, in order:

1. **Prove it is unused.** Instrument the server to count requests where the field is populated (or the method is called), labelled by caller identity from the auth token or peer address. Assumption is not evidence — the consumer you forgot is always the one that breaks.
2. **Deprecate.** `[deprecated = true]` on the field or method, plus a comment saying what to use instead and when it will be removed. This is non-breaking and generates warnings in most languages.
3. **Notify by name.** Using the traffic data, contact the specific teams still calling it. A broadcast announcement reaches nobody.
4. **Wait a defined notice period.** Long enough to cover the slowest consumer's release cycle — 30 days internally, 90+ for external consumers is a common baseline.
5. **Verify zero traffic** for the full period, not just at the end.
6. **Delete, with `reserved` for both number and name**, in the same commit. Never in two commits.
7. **Handle stored data.** If old messages persist in a queue, a database or an event log, they are still out there — decide explicitly whether to migrate them, keep a reader for the old shape, or accept the loss.

Step 7 is the one people forget. Wire compatibility is not only about live RPCs: a protobuf blob written in 2024 and read in 2026 is exactly the same problem.

### When to cut a new major version

Reach for `acme.inventory.v2` only when a change genuinely cannot be expressed additively — a fundamental restructuring of a resource, a semantics change in an existing field, or an accumulation of deprecations you want to sweep. It is expensive: both versions must be implemented, tested, monitored and supported until every consumer migrates, which is usually longer than planned.

The mechanics: a new package `acme.inventory.v2` in `acme/inventory/v2/`, new generated Go package, both services registered on the same server (they are different `:path` prefixes, so they coexist trivially), and typically a shared internal implementation with thin per-version adapters so business logic is not duplicated.

```svg
<svg viewBox="0 0 880 430" width="100%" height="430" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="dp1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Removing a field from a live schema: the seven steps</text>

  <rect x="30" y="40" width="200" height="66" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="130" y="62" text-anchor="middle" fill="#3730a3" font-weight="bold">1. Prove it is unused</text>
  <text x="130" y="80" text-anchor="middle" fill="#4338ca" font-size="10">count populated-field requests</text>
  <text x="130" y="96" text-anchor="middle" fill="#4338ca" font-size="10">LABELLED BY CALLER identity</text>

  <path d="M232,73 L286,73" stroke="#0ea5e9" stroke-width="2" marker-end="url(#dp1)"/>

  <rect x="290" y="40" width="200" height="66" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="390" y="62" text-anchor="middle" fill="#92400e" font-weight="bold">2. Deprecate</text>
  <text x="390" y="80" text-anchor="middle" fill="#b45309" font-size="10">[deprecated = true] + a comment</text>
  <text x="390" y="96" text-anchor="middle" fill="#b45309" font-size="10">saying what replaces it, and when</text>

  <path d="M492,73 L546,73" stroke="#0ea5e9" stroke-width="2" marker-end="url(#dp1)"/>

  <rect x="550" y="40" width="200" height="66" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="650" y="62" text-anchor="middle" fill="#92400e" font-weight="bold">3. Notify BY NAME</text>
  <text x="650" y="80" text-anchor="middle" fill="#b45309" font-size="10">use the traffic data &#8212; a broadcast</text>
  <text x="650" y="96" text-anchor="middle" fill="#b45309" font-size="10">announcement reaches nobody</text>

  <path d="M650,108 L650,134" stroke="#0ea5e9" stroke-width="2" marker-end="url(#dp1)"/>

  <rect x="550" y="138" width="200" height="66" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="650" y="160" text-anchor="middle" fill="#334155" font-weight="bold">4. Wait the notice period</text>
  <text x="650" y="178" text-anchor="middle" fill="#475569" font-size="10">30d internal &#183; 90d+ external</text>
  <text x="650" y="194" text-anchor="middle" fill="#475569" font-size="10">cover the slowest release cycle</text>

  <path d="M548,171 L494,171" stroke="#0ea5e9" stroke-width="2" marker-end="url(#dp1)"/>

  <rect x="290" y="138" width="200" height="66" rx="8" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="390" y="160" text-anchor="middle" fill="#334155" font-weight="bold">5. Verify zero traffic</text>
  <text x="390" y="178" text-anchor="middle" fill="#475569" font-size="10">for the WHOLE period,</text>
  <text x="390" y="194" text-anchor="middle" fill="#475569" font-size="10">not just on the last day</text>

  <path d="M288,171 L234,171" stroke="#0ea5e9" stroke-width="2" marker-end="url(#dp1)"/>

  <rect x="30" y="138" width="200" height="66" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="130" y="160" text-anchor="middle" fill="#15803d" font-weight="bold">6. Delete + reserved</text>
  <text x="130" y="178" text-anchor="middle" fill="#166534" font-size="10">number AND name, in the</text>
  <text x="130" y="194" text-anchor="middle" fill="#166534" font-size="10">SAME commit. Never two.</text>

  <path d="M130,206 L130,232" stroke="#0ea5e9" stroke-width="2" marker-end="url(#dp1)"/>

  <rect x="30" y="236" width="820" height="80" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="258" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">7. The step everyone forgets: STORED data</text>
  <text x="50" y="280" fill="#991b1b">Wire compatibility is not only about live RPCs. A protobuf blob written in 2024 and read in 2026 is the same problem.</text>
  <text x="50" y="300" fill="#991b1b">Queues, event logs, database blobs, caches, backups. Decide explicitly: migrate, keep a legacy reader, or accept the loss.</text>

  <rect x="30" y="330" width="820" height="90" rx="8" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="352" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">When to cut v2 instead</text>
  <text x="50" y="374" fill="#475569">Only when a change genuinely cannot be additive: a resource restructure, a semantics change to an existing field,</text>
  <text x="50" y="392" fill="#475569">or a sweep of accumulated deprecations. New package acme.inventory.v2 in acme/inventory/v2/ &#8212; different :path prefix,</text>
  <text x="50" y="410" fill="#475569">so both register on the same server. Share one internal implementation behind thin per-version adapters.</text>
</svg>
```

## 5. Implementation

### A schema mid-evolution

```protobuf
syntax = "proto3";

package acme.inventory.v1;

import "google/protobuf/timestamp.proto";

option go_package = "github.com/acme/apis/gen/go/acme/inventory/v1;inventoryv1";

message Item {
  string sku  = 1;
  string name = 2;

  int32 quantity_on_hand  = 3;
  int32 quantity_reserved = 4;

  // ---- deprecated, awaiting removal ---------------------------------------
  // Deprecated: use `unit_price` (field 9) instead, which carries a currency.
  // Scheduled for removal in v1.9 (target 2026-10-01). Contact #inventory-api.
  // As of 2026-07-24, remaining callers: billing-legacy (12 rpc/day).
  int64 unit_price_cents = 5 [deprecated = true];

  // ---- already removed ----------------------------------------------------
  // 6 was `warehouse_code` (string), removed in v1.7 — superseded by
  // `location` (field 10). See ADR-114. Both the number and the name are
  // retired forever: reusing either causes silent misinterpretation of data
  // still sitting in the event log.
  reserved 6;
  reserved "warehouse_code";

  // 7, 8 were an experimental pair never shipped to production; retired to
  // avoid confusion with any archived staging data.
  reserved 7, 8;

  // ---- current ------------------------------------------------------------
  google.type.Money unit_price = 9;    // replaces field 5
  Location location = 10;              // replaces field 6

  google.protobuf.Timestamp created_at = 11;
  google.protobuf.Timestamp updated_at = 12;

  // Added in v1.8. Explicit presence because 0 is a meaningful threshold.
  optional int32 reorder_threshold = 13;

  // A range reserved for a planned redesign, so nobody claims these numbers
  // in the meantime.
  reserved 30 to 39;
}

enum ItemStatus {
  ITEM_STATUS_UNSPECIFIED  = 0;
  ITEM_STATUS_DRAFT        = 1;
  ITEM_STATUS_ACTIVE       = 2;
  ITEM_STATUS_DISCONTINUED = 3;

  // Deprecated: merged into DISCONTINUED in v1.6. Still emitted by servers
  // older than v1.6, so consumers must continue to handle it until 2026-10.
  ITEM_STATUS_SUNSET = 4 [deprecated = true];

  // 5 was ITEM_STATUS_PENDING_REVIEW, removed in v1.7. Enum numbers get the
  // same treatment as field numbers.
  reserved 5;
  reserved "ITEM_STATUS_PENDING_REVIEW";
}

service InventoryService {
  rpc GetItem(GetItemRequest) returns (GetItemResponse);

  // Deprecated: use ListItems, which is paginated. GetAllItems returns an
  // unbounded response and will be removed in v2. Remaining callers as of
  // 2026-07-24: reporting-batch (3 rpc/day).
  rpc GetAllItems(GetAllItemsRequest) returns (GetAllItemsResponse) {
    option deprecated = true;
  }

  rpc ListItems(ListItemsRequest) returns (ListItemsResponse);
}
```

### Measuring field usage before removing it

You cannot deprecate responsibly without data. This interceptor counts, per caller, how often a deprecated field is populated:

```go
package interceptors

import (
	"context"

	"github.com/prometheus/client_golang/prometheus"
	"google.golang.org/grpc"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/reflect/protoreflect"
)

var deprecatedFieldUse = prometheus.NewCounterVec(
	prometheus.CounterOpts{
		Name: "grpc_deprecated_field_use_total",
		Help: "Requests in which a field marked [deprecated = true] was populated.",
	},
	// `caller` is what turns this from a number into an action: you cannot
	// email "12 requests/day", you can email the team that sends them.
	[]string{"method", "message", "field", "caller"},
)

// DeprecatedFieldUsageInterceptor walks each request message and records any
// populated field carrying the `deprecated` option.
//
// Cost note: Range visits only fields that are SET, so the walk is proportional
// to populated fields rather than to schema size. Even so, sample it (or gate
// it behind a flag) on very hot methods.
func DeprecatedFieldUsageInterceptor(callerFromCtx func(context.Context) string) grpc.UnaryServerInterceptor {
	return func(
		ctx context.Context,
		req any,
		info *grpc.UnaryServerInfo,
		handler grpc.UnaryHandler,
	) (any, error) {
		if m, ok := req.(proto.Message); ok {
			caller := callerFromCtx(ctx)
			recordDeprecated(m.ProtoReflect(), info.FullMethod, caller)
		}
		return handler(ctx, req)
	}
}

func recordDeprecated(m protoreflect.Message, method, caller string) {
	m.Range(func(fd protoreflect.FieldDescriptor, v protoreflect.Value) bool {
		// The `deprecated` option lives on the field's options message.
		if opts, ok := fd.Options().(interface{ GetDeprecated() bool }); ok && opts.GetDeprecated() {
			deprecatedFieldUse.WithLabelValues(
				method,
				string(m.Descriptor().FullName()),
				string(fd.Name()),
				caller,
			).Inc()
		}

		// Recurse into singular and repeated message fields so nested
		// deprecated fields are counted too.
		switch {
		case fd.IsMap():
			// Map values may be messages.
			if fd.MapValue().Kind() == protoreflect.MessageKind {
				v.Map().Range(func(_ protoreflect.MapKey, mv protoreflect.Value) bool {
					recordDeprecated(mv.Message(), method, caller)
					return true
				})
			}
		case fd.IsList():
			if fd.Kind() == protoreflect.MessageKind {
				l := v.List()
				for i := 0; i < l.Len(); i++ {
					recordDeprecated(l.Get(i).Message(), method, caller)
				}
			}
		case fd.Kind() == protoreflect.MessageKind:
			recordDeprecated(v.Message(), method, caller)
		}
		return true
	})
}
```

With that in place the deprecation notice writes itself: *"billing-legacy sends `unit_price_cents` 12 times per day; here is the migration."*

### Running v1 and v2 side by side

```go
package main

import (
	"log"
	"net"

	"google.golang.org/grpc"

	inventoryv1 "github.com/acme/apis/gen/go/acme/inventory/v1"
	inventoryv2 "github.com/acme/apis/gen/go/acme/inventory/v2"
	"github.com/acme/inventory/internal/core"
	"github.com/acme/inventory/internal/adapters"
)

func main() {
	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		log.Fatal(err)
	}
	s := grpc.NewServer()

	// ONE implementation of the business logic, in terms of internal domain
	// types that belong to neither wire version.
	svc := core.NewInventoryService(core.NewStore())

	// Two thin adapters translating between wire types and domain types.
	// They share behaviour, so a bug fix lands in both, and neither version's
	// schema constrains the other.
	//
	// The two services have different :path prefixes
	// (/acme.inventory.v1/... and /acme.inventory.v2/...), so they coexist on
	// one port with no routing configuration at all.
	inventoryv1.RegisterInventoryServiceServer(s, adapters.NewV1(svc))
	inventoryv2.RegisterInventoryServiceServer(s, adapters.NewV2(svc))

	log.Printf("serving inventory v1 and v2 on %s", lis.Addr())
	log.Fatal(s.Serve(lis))
}
```

### Testing compatibility with real old data

The test that actually catches evolution bugs is one that replays bytes captured from an older schema:

```go
package inventory_test

import (
	"encoding/hex"
	"testing"

	"google.golang.org/protobuf/proto"

	inventoryv1 "github.com/acme/apis/gen/go/acme/inventory/v1"
)

// goldenV16Item is a real Item encoded by the v1.6 schema, captured from a
// production event log and committed as a fixture. Unit tests that encode with
// TODAY's schema cannot catch number reuse; only genuinely old bytes can.
const goldenV16Item = "0a0a736b755f30314851385a4b1a0b426c756557696467657418" +
	"2a20002a0e0a0c77685f6c6f6e5f30313a413132"

func TestOldBytesStillParse(t *testing.T) {
	raw, err := hex.DecodeString(goldenV16Item)
	if err != nil {
		t.Fatal(err)
	}

	var item inventoryv1.Item
	if err := proto.Unmarshal(raw, &item); err != nil {
		t.Fatalf("v1.6 bytes no longer parse: %v", err)
	}

	// Assert on the fields that still exist and must be unchanged.
	if got, want := item.GetSku(), "sku_01HQ8ZK"; got != want {
		t.Errorf("sku = %q, want %q", got, want)
	}
	if got, want := item.GetQuantityOnHand(), int32(42); got != want {
		t.Errorf("quantity_on_hand = %d, want %d — a field number may have been reused", got, want)
	}

	// Re-marshalling must preserve the bytes of fields this build does not
	// know about, which is what makes a pass-through service safe.
	out, err := proto.Marshal(&item)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != len(raw) {
		t.Errorf("round trip changed size %d -> %d; unknown fields were dropped", len(raw), len(out))
	}
}
```

### CI enforcement

```bash
# The gate. Compare against the last RELEASE, not the previous commit, so a
# breaking change cannot be smuggled in across two individually-safe PRs.
buf breaking --against 'https://github.com/acme/apis.git#tag=v1.8.0,subdir=proto'
```

```yaml
# buf.yaml — a deliberate, reviewable, expiring exception
breaking:
  use:
    - FILE
  ignore_only:
    FIELD_NO_DELETE:
      # Removing Item.unit_price_cents (field 5), superseded by unit_price.
      # Traffic: zero for 94 consecutive days (dashboard: inventory-deprecations).
      # Notified: billing-legacy (migrated 2026-06-02), reporting-batch (n/a).
      # Number 5 and the name are reserved in the same commit.
      # REMOVE THIS EXCEPTION after v1.9.0 ships. Owner: @platform-team.
      - proto/acme/inventory/v1/inventory.proto
```

## 6. Advantages, Disadvantages & Trade-offs

**What protobuf's model gives you**
- **Additive change is free and bidirectional**, thanks to unknown-field preservation — old binaries carry new fields through untouched.
- **Number-based identity** means renaming a field costs nothing on the wire.
- **`reserved` is compiler-enforced**, so the most dangerous mistake becomes impossible once you use it.
- **Mechanical verification** — `buf breaking` turns the compatibility matrix into a CI gate.

**Where it is weak**
- **No runtime version negotiation.** There is no "which schema version are you on?" handshake; you infer it from traffic.
- **Deletion is always a process**, never a commit, once anything else consumes the schema.
- **`deprecated` is advisory.** It generates warnings; it stops nothing.
- **Stored data ages differently from live traffic.** A queue or event log can contain messages far older than any running binary.
- **Source compatibility is separate from wire compatibility**, and the wire-compatible-but-source-breaking changes are the ones that surprise people.

**Trade-offs**
- *Additive-only forever vs periodic v2:* never breaking means the schema accumulates deprecated cruft; cutting v2 cleans it up but doubles the surface until every consumer migrates. Most teams should stay additive far longer than instinct suggests.
- *Strict `FILE` breaking checks vs `WIRE`:* `FILE` protects consumers' compilation and catches renames; `WIRE` only protects bytes. Loosening is defensible only when you genuinely control every consumer's build.
- *Long notice periods vs velocity:* 90 days is safe and slow. Shorten it only in proportion to how well you actually measure usage.

## 7. Common Mistakes & Best Practices

- **Reusing a field number.** The one unrecoverable mistake. Silent corruption, no error, invisible to tests that use fresh data.
- **Deleting a field without `reserved`.** It works today and arms a trap for the next person.
- **Reserving the number but not the name.** `protojson` and text-format consumers still break, and someone will reintroduce the name with a different meaning.
- **Changing `int32` to `sint32`** because "it's more efficient". Different encodings; existing data is corrupted.
- **Assuming `int32` → `int64` is free.** Wire-compatible, but source-breaking and a truncation hazard for un-upgraded readers once values exceed 2^31.
- **Switching on an enum without a `default` branch.** Adding a value is legal and will happen.
- **Removing a field based on "nobody uses it".** Measure, with caller identity, before you believe it.
- **Announcing a deprecation by broadcast.** Contact the specific teams the metrics name.
- **Forgetting stored data.** Queues, event logs, database blobs and backups outlive every running binary.
- **Cutting v2 for a change that could be additive.** You have doubled the surface for no compatibility benefit.
- **Running `buf breaking` against the previous commit** rather than the last release, so a break can be split across two PRs.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** When a field mysteriously arrives empty, check the schema history for that number before anything else — `git log -S 'reserved' -- path/to.proto` and a blame on the field number are faster than any amount of packet capture. `protoscope` (chapter 3) decodes raw bytes without a schema, which is how you find out what number 3 *actually* contained.
- **Monitoring.** Emit a per-caller counter for every deprecated field and method (see §5). Alert when a scheduled removal date approaches with non-zero traffic. Track the age distribution of messages in any durable store, because that is your real compatibility window.
- **Security.** Schema changes are a supply-chain surface: a renamed or repurposed field can silently change authorization semantics. Require review from the API owner on every `.proto` change, and treat a `reserved` removal (i.e. un-reserving a number) as a security-relevant change.
- **Scaling the process.** Beyond a handful of consumers, this stops being a technical problem: you need a published deprecation policy with a fixed notice period, per-consumer usage dashboards, `buf breaking` against the last release in CI, and an exception mechanism (`ignore_only` with an owner and an expiry) that makes deliberate breaks visible in review rather than accidental.

## 9. Interview Questions

**Q: Which schema changes are always safe?**
A: Adding a field with a previously unused number, adding a message, an RPC or an enum value, marking anything `[deprecated = true]`, adding comments, and reserving the number and name of something you removed. These are safe in both directions because unknown fields are preserved: an old binary receiving a new field retains the raw bytes and re-emits them on marshal, so a read-modify-write through an un-upgraded service does not destroy data.

**Q: Why is reusing a field number so dangerous?**
A: Because it produces silent misinterpretation rather than an error. If field 3 was `int32 quantity` and becomes `int32 warehouse_number`, the wire types match, so old bytes decode cleanly into the new field — a quantity of 42 becomes warehouse number 42, with no error anywhere. If the wire types differ you "only" lose the value silently. The compiler cannot help, because it has no memory of what number 3 meant two years ago, and unit tests cannot catch it because they encode with today's schema. `reserved` makes it a compile error, which is why reserving at the moment of deletion is not optional.

**Q: Should you reserve the number, the name, or both?**
A: Both, always. The number protects the binary wire format, which is the corruption path. The name protects `protojson` and text-format consumers, and prevents someone reintroducing a field with the same name and a different meaning, which is confusing even when technically safe. They are separate declarations — `reserved 6;` and `reserved "warehouse_code";` — and omitting either leaves a gap.

**Q: Is renaming a field a breaking change?**
A: On the wire, no — identity is the number, so the bytes are unchanged. In source, yes: the generated getters change name, so every consumer stops compiling, and the canonical JSON key changes, so `protojson` and any grpc-gateway consumers break at runtime. `buf breaking` reflects this precisely: a rename passes at `WIRE` and fails at `WIRE_JSON` and `FILE`. So it is safe only if you control and can rebuild every consumer simultaneously, which is rarely true.

**Q: Which type changes are wire-compatible?**
A: Those that share a wire type. `int32`, `int64`, `uint32`, `uint64` and `bool` are all varint and interchange, though narrowing truncates. `sint32` and `sint64` interchange with each other but **not** with `int32`/`int64`, because ZigZag is a different encoding — switching corrupts data. `fixed32`/`sfixed32` and `fixed64`/`sfixed64` interchange. `string` → `bytes` is safe; `bytes` → `string` only if every value is valid UTF-8. All of these are still source-breaking, because the generated Go type changes.

**Q: How do you remove a field from a schema with fifteen consumers?**
A: As a process, not a commit. First measure: instrument the server to count requests where the field is populated, labelled by caller identity, because assumption is not evidence. Then mark it `[deprecated = true]` with a comment naming the replacement and the removal date. Then notify the specific teams the metrics identified — a broadcast announcement reaches nobody. Wait a defined notice period covering the slowest consumer's release cycle, verify zero traffic across the whole period rather than just at the end, and finally delete with `reserved` for both number and name in the same commit. And decide explicitly what happens to messages already sitting in queues, event logs and database blobs.

**Q: When do you cut a new major version?**
A: Only when a change genuinely cannot be expressed additively — restructuring a resource, changing the semantics of an existing field, or sweeping away accumulated deprecations. It is expensive, because both versions must be implemented, tested, monitored and supported until every consumer migrates, which always takes longer than planned. Mechanically it is straightforward: a new `acme.inventory.v2` package in a `v2/` directory, registered on the same server, since the different `:path` prefixes mean they coexist with no routing configuration. I would share one internal implementation behind thin per-version adapters so business logic is not duplicated.

**Q: What is the relationship between wire compatibility and source compatibility?**
A: Wire compatibility means the bytes survive: old and new binaries exchange messages without loss or misinterpretation. Source compatibility means existing consumer code still compiles against regenerated stubs. They are independent, and the interesting cases are the ones where they diverge — renaming a field, widening `int32` to `int64`, adding `optional` to a scalar, or moving a message between files are all wire-compatible and source-breaking. That divergence is exactly why `buf breaking` has separate categories, and why defaulting to `FILE` rather than `WIRE` is the right choice for consumers who compile against your generated code.

**Q: (Senior) Design a deprecation policy for a schema with many consumers.**
A: Four components. Measurement first: every deprecated field and method emits a per-caller counter, so "who still uses this" is a dashboard query rather than a guess — without that, everything else is theatre. A published policy with a fixed notice period, differentiated by consumer class: 30 days internal, 90 or more external, always long enough to cover the slowest release cycle. Mechanical enforcement: `buf lint` and `buf breaking` at `FILE` in CI against the last *release* tag rather than the previous commit, so a break cannot be split across two individually-safe PRs. And a visible exception mechanism — `ignore_only` naming the rule, the file, the traffic evidence, a named owner and an expiry — so a deliberate break is a reviewable decision rather than a `--force`. I would also require API-owner review on every `.proto` change, because a repurposed field can silently change authorization semantics in a way no automated check catches.

**Q: (Senior) A field must change from a singular message to `repeated`. Walk through it.**
A: That is not wire-compatible in any useful sense for message fields, so the change happens additively. I would add a new `repeated` field with a fresh number, keep the singular field populated with the primary or first element during a transition window, and document that the singular field is a projection of the repeated one. New clients read the repeated field; old clients keep working unchanged. Then I instrument which callers still read the singular field, mark it `[deprecated = true]` with the replacement named, migrate them individually using that data, wait out the notice period, and finally delete it with `reserved` for both number and name. The subtlety is write paths: while both exist, a client that writes only the singular field must have its value merged sensibly into the repeated one, and that reconciliation logic has to be written deliberately rather than falling out — it is where the bugs live. Throughout, I would not cut a v2 for this, because it is expressible additively and v2 would double the surface for no compatibility benefit.

**Q: (Senior) How do you handle schema evolution for protobuf stored in a database or event log?**
A: By recognising that stored data has a much longer compatibility horizon than live RPC traffic — a blob written in 2024 and read in 2026 is exactly the same problem as an old client, except the old client can be upgraded and the blob cannot. Practically: never reuse a field number, treat the schema history as permanent, and keep golden fixtures of real old bytes in the test suite, because tests that encode with today's schema structurally cannot catch number reuse. I would also record a schema version alongside each stored message so a reader can tell what it is looking at, monitor the age distribution of unread messages so the real compatibility window is measurable rather than assumed, and decide explicitly at each removal whether to migrate the stored data, keep a legacy reader for the old shape, or accept the loss. The failure mode I have seen most is a team applying live-traffic reasoning — "nobody has called that in months" — to an event log containing two years of history.

## 10. Quick Revision & Cheat Sheet

| Change | Safe? |
|---|---|
| Add a field (new number) | ✅ always |
| Add message / RPC / enum value | ✅ always |
| `[deprecated = true]` | ✅ always |
| `reserved` a removed number+name | ✅ always |
| Rename a field | ⚠️ wire ✅ / source ❌ / JSON ❌ |
| `int32` ↔ `int64` | ⚠️ wire ✅ / source ❌ / truncation risk |
| `int32` ↔ `sint32` | ❌ different encoding — corruption |
| `string` → `bytes` | ⚠️ wire ✅ / source ❌ |
| Add `optional` to a scalar | ⚠️ wire ✅ / source ❌ |
| Delete a field without `reserved` | ❌ arms a trap |
| **Reuse a field number** | ❌❌ silent corruption |
| Change a field number | ❌ |
| Change an RPC's request/response type | ❌ |

```protobuf
// The correct removal, in one commit:
message Item {
  string sku = 1;
  // 3 was quantity_on_hand, removed v1.7 (ADR-114). Zero traffic for 94 days.
  reserved 3;
  reserved "quantity_on_hand";
  reserved 30 to 39;              // a range held for a planned redesign
}
```

**Flash cards**
- **The one unrecoverable mistake?** → Reusing a field number. Silent, not loud.
- **Reserve what?** → The number *and* the name, at the moment of deletion.
- **Is renaming safe?** → On the wire yes; in source and JSON no.
- **`sint32` ↔ `int32`?** → Never. Different encodings.
- **How do you know a field is unused?** → A per-caller metric, not an assumption.
- **`buf breaking --against` what?** → The last **release**, not the previous commit.
- **What outlives every binary?** → Stored messages in queues, logs and database blobs.

## 11. Hands-On Exercises & Mini Project

- [ ] Encode an `Item` with `int32 quantity = 3`. Change the schema so field 3 is `int32 warehouse_no`, decode the old bytes, and observe the silent corruption. Then add `reserved 3;` and watch the compiler stop you.
- [ ] Do the same with mismatched wire types (`int32` → `string`) and note the different, quieter failure.
- [ ] Rename a field, run `buf breaking` at `WIRE`, `WIRE_JSON` and `FILE`, and explain why exactly two of the three fail.
- [ ] Change `int32` to `sint32`, round-trip a negative value through old and new schemas, and quantify the corruption.
- [ ] Add the deprecated-field usage interceptor from §5, populate a deprecated field from two fake callers, and produce the metric you would base a deprecation email on.
- [ ] Capture a real encoded message as a hex fixture, then evolve the schema three times, keeping the golden test green. Try to make it fail without touching the test.

### Mini Project — "Schema Evolution Simulator"

**Goal.** Build a harness that proves your schema changes are safe against genuinely old data, rather than against data encoded by today's schema.

**Requirements.**
1. Version-controlled snapshots of a schema at v1.0, v1.5 and v2.0, each generating into its own Go package.
2. A fixture set of messages encoded by each historical version, committed as hex or binary golden files.
3. A cross-compatibility test matrix: every historical encoder against every current decoder, asserting both field values and byte-length preservation on re-marshal (which proves unknown fields survive).
4. A deliberate field-number reuse introduced on a branch, with a test that fails loudly because of the golden fixtures — demonstrating what unit tests alone cannot catch.
5. The deprecated-field usage interceptor wired up, with a dashboard showing usage per caller and an alert on a scheduled removal date with non-zero traffic.
6. CI running `buf breaking` against the last release tag, plus one PR that legitimately breaks and lands via a documented `ignore_only` exception with an owner and expiry.

**Extensions.**
- Add a `v2` package alongside `v1`, register both on one server, and write an adapter test proving both wire versions share a single business implementation.
- Simulate a durable event log: write messages at v1.0, upgrade the reader through v1.5 and v2.0, and measure exactly which fields survive each hop.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Protocol Buffers: Binary Wire Format* (why numbers are identity and unknown fields survive), *proto3 in Depth* (the constructs being evolved), *Buf* (mechanising these rules in CI), *Build: The Complete Service .proto* (a schema written to be evolvable), *Go Module Layout* (why the `v1` package segment matters).

- **Protocol Buffers — Updating a message type** — Google · *Intermediate* · the normative list of safe and unsafe changes, including the compatible-type-change table. The primary source for this chapter. <https://protobuf.dev/programming-guides/proto3/#updating>
- **Protocol Buffers — Best Practices (Do's and Don'ts)** — Google · *Intermediate* · hard-won rules on reserving numbers, never reusing them, and designing for change from the start. <https://protobuf.dev/best-practices/dos-donts/>
- **Buf — Breaking change detection rules** — Buf (open source) · *Intermediate* · every rule per category with an explanation of what it protects; effectively the compatibility matrix, mechanised. <https://buf.build/docs/breaking/rules>
- **Google AIP-180 — Backwards compatibility** — Google · *Intermediate* · Google's own definition of what constitutes a breaking change to an API, including behavioural changes the wire format cannot detect. <https://google.aip.dev/180>
- **Google AIP-185 — Versioning** — Google · *Intermediate* · when to cut a major version, how to run versions side by side, and how long to support each. <https://google.aip.dev/185>
- **Protocol Buffers — Field Presence** — Google · *Intermediate* · exactly what adding or removing `optional` does to the wire and to generated code. <https://protobuf.dev/programming-guides/field_presence/>
- **Designing Data-Intensive Applications, ch. 4 (Encoding and Evolution)** — Martin Kleppmann · *Advanced* · the clearest general treatment of forward and backward compatibility, and why stored data ages differently from live traffic. <https://dataintensive.net/>
- **protoscope** — Protocol Buffers Authors · *Intermediate* · decode raw bytes with no schema, the fastest way to find out what a field number *actually* contained. <https://github.com/protocolbuffers/protoscope>

---

*gRPC with Go Handbook — chapter 13.*
