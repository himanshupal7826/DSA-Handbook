# 11 · Build: The Complete Service .proto with All Four Method Kinds

> **In one line:** This is the reference `.proto` — a realistic inventory service with one method of each RPC kind, well-known types, enums with `UNSPECIFIED` zeros, pagination, partial updates and reserved numbers — written the way a schema that must survive five years of change is written.

---

## 1. Overview

Everything so far has been components: the wire format, the language, the well-known types, the toolchain. This chapter assembles them into the artefact you actually review in a design round — a complete, defensible service definition.

The design brief is deliberately realistic. An **inventory service** for a warehouse-backed commerce system has enough surface to exercise every construct honestly: individual lookups (unary), a live stock feed (server streaming), bulk adjustments from a scanner gun (client streaming), and an interactive reconciliation session between a warehouse terminal and the server (bidirectional). It also has the constraints that make schema design hard: money, timestamps, partial updates, pagination, and fields that will be deprecated.

The value of a worked example is in the *decisions*, not the syntax. Why is `ListItems` paginated with a cursor rather than an offset? Why does `ReserveStock` take an idempotency key? Why is `WatchStock` a stream and `ListItems` not? Why does every RPC have its own request and response message even when two of them look identical? Each of those has an answer that generalises, and §3 works through them.

A note on scope: this `.proto` is the contract only. Chapters 14–18 implement the server against it, chapters 19–21 the client. It is written so those chapters can use it verbatim.

## 2. Core Concepts

- **Service surface** — the set of methods a service exposes. Designed around use cases, not around database tables.
- **Method granularity** — how much work one RPC does. Too fine rebuilds the N+1 problem across the network; too coarse makes methods unauthorizable and unevolvable.
- **Request/response uniqueness** — every RPC gets its own `XRequest`/`XResponse`, never shared (`buf lint`'s `RPC_REQUEST_RESPONSE_UNIQUE`).
- **Cursor pagination** — `page_size` + opaque `page_token` in, `next_page_token` out. The standard for gRPC list methods (AIP-158).
- **Idempotency key** — a client-supplied token making a mutating call safe to retry exactly once.
- **Standard method names** — `Get`, `List`, `Create`, `Update`, `Delete`, `Batch…`, plus custom methods for domain verbs (AIP-130s).
- **Resource-oriented naming** — methods named `<Verb><Resource>`, resources as nouns.
- **Version segment** — `package acme.inventory.v1`, matching the directory, enabling `v2` to exist alongside.
- **Reserved ranges** — `reserved 20;` / `reserved "old_name";` retiring numbers and names permanently.
- **Comment as documentation** — `.proto` comments flow into generated code in every language and are usually the only docs a consumer reads.

## 3. Theory & Principles

### Designing the method surface

Start from use cases and write them as sentences: *"A warehouse operator looks up one item by SKU. An ops dashboard lists items filtered by status. A pricing service updates an item's price. A checkout flow reserves stock and later confirms or releases it. A monitoring dashboard watches stock levels live. A scanner gun uploads a few thousand adjustments at end of shift. A warehouse terminal reconciles its local counts against the server interactively."*

Each sentence becomes a method, and the shape falls out of the sentence:

| Use case | Method | Kind | Why |
|---|---|---|---|
| Look up one item | `GetItem` | Unary | Bounded request, bounded response |
| List with filters | `ListItems` | Unary + pagination | Client wants a *page*, resumably — not a stream |
| Change some fields | `UpdateItem` | Unary + `FieldMask` | Partial update; zero must be expressible |
| Reserve stock | `ReserveStock` | Unary + idempotency | A mutating command with its own failure vocabulary |
| Watch levels live | `WatchStock` | Server streaming | Unbounded in time; push, not poll |
| Upload adjustments | `BulkAdjustStock` | Client streaming | Unbounded input, one summary out |
| Reconcile interactively | `SyncInventory` | Bidirectional | Both sides send independently over a session |

Two decisions in that table deserve defending because they are the ones interviewers probe.

**Why is `ListItems` unary with pagination rather than server streaming?** Because a stream is not resumable and does not load-balance. If the client's connection drops at row 4,000 of 10,000, a stream restarts from zero, whereas a page token resumes exactly where it stopped. Pagination is also stateless — any backend can serve the next page — while a stream pins one connection to one backend for its lifetime (chapter 5). Use streaming when the data is unbounded *in time* (a live feed), not merely large.

**Why does `ReserveStock` carry an idempotency key?** Because it mutates, and because gRPC clients retry. Without a key, a retry after a timeout may reserve stock twice — the classic double-charge bug in a different costume. The key lets the server recognise the retry and return the original result. Note that this is a *schema* decision: retry safety cannot be bolted on later without a breaking change.

### Naming and structure rules that pay off later

- **`package acme.inventory.v1` in `acme/inventory/v1/`.** The version segment is what makes a future `v2` possible; without it, a breaking change has nowhere to go (chapter 13).
- **One request and one response message per RPC**, always, even when two look identical today. The moment you share `GetItemRequest` between two methods, you can no longer add a field for one without affecting the other.
- **`XRequest`/`XResponse` naming**, so the mapping from method to message is mechanical.
- **Service name ends in `Service`**, resources are singular nouns, fields are `lower_snake_case`.
- **Enums: `<ENUM>_UNSPECIFIED = 0`** and every value prefixed with the enum name, because enum values share the enclosing namespace (chapter 9).
- **Numbers 1–15 for fields present on every message**, especially inside `repeated` elements, and leave one or two free for future hot fields.
- **Comment every message and every non-obvious field.** These comments are the generated documentation in every language.

### Where the failure modes are hidden

A schema review should check four things that are cheap now and expensive later:

1. **Unbounded collections.** Every `repeated` field and every list response needs a documented maximum. `ListItems` without a server-enforced page cap is a latency and memory incident waiting to happen.
2. **Missing presence where zero is meaningful.** `reorder_threshold = 0` is a real rule; a plain `int32` cannot express it (chapter 9).
3. **Unversioned identifiers.** Exposing a database auto-increment id couples the wire contract to storage and enables enumeration.
4. **Mutating methods without idempotency.** Retries are automatic; safety is not.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">From use-case sentences to method shapes</text>

  <rect x="24" y="40" width="832" height="86" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="440" y="62" text-anchor="middle" fill="#3730a3" font-size="12" font-weight="bold">Step 1 &#8212; write the domain in sentences, underline the verbs</text>
  <text x="44" y="84" fill="#4338ca" font-size="10">"An operator LOOKS UP one item. A dashboard LISTS items by status. Pricing UPDATES a price. Checkout RESERVES stock,</text>
  <text x="44" y="102" fill="#4338ca" font-size="10">then CONFIRMS or RELEASES it. Monitoring WATCHES levels live. A scanner UPLOADS adjustments. A terminal RECONCILES counts."</text>
  <text x="44" y="120" fill="#6366f1" font-size="10">Each verb is a candidate method. The shape of the data decides the RPC kind.</text>

  <rect x="24" y="140" width="204" height="150" rx="10" fill="#dbeafe" stroke="#2563eb" stroke-width="2"/>
  <text x="126" y="162" text-anchor="middle" fill="#1e40af" font-size="12" font-weight="bold">Unary</text>
  <text x="40" y="184" fill="#1d4ed8" font-size="10">GetItem</text>
  <text x="40" y="202" fill="#1d4ed8" font-size="10">ListItems  (+ page_token)</text>
  <text x="40" y="220" fill="#1d4ed8" font-size="10">UpdateItem (+ FieldMask)</text>
  <text x="40" y="238" fill="#1d4ed8" font-size="10">ReserveStock (+ idem. key)</text>
  <text x="40" y="262" fill="#1e40af" font-size="10" font-weight="bold">bounded in &#8594; bounded out</text>
  <text x="40" y="278" fill="#1e40af" font-size="10">retries &#183; per-call balancing</text>

  <rect x="236" y="140" width="204" height="150" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="338" y="162" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Server streaming</text>
  <text x="252" y="184" fill="#166534" font-size="10">WatchStock</text>
  <text x="252" y="208" fill="#15803d" font-size="10" font-weight="bold">unbounded IN TIME</text>
  <text x="252" y="226" fill="#166534" font-size="10">a live feed, not a big list</text>
  <text x="252" y="250" fill="#166534" font-size="10">NOT ListItems &#8212; a page token</text>
  <text x="252" y="266" fill="#166534" font-size="10">is resumable, a stream is not</text>

  <rect x="448" y="140" width="204" height="150" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="550" y="162" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">Client streaming</text>
  <text x="464" y="184" fill="#b45309" font-size="10">BulkAdjustStock</text>
  <text x="464" y="208" fill="#92400e" font-size="10" font-weight="bold">unbounded input, 1 summary</text>
  <text x="464" y="226" fill="#b45309" font-size="10">scanner gun at end of shift</text>
  <text x="464" y="250" fill="#b45309" font-size="10">no per-message acks &#8212; if you</text>
  <text x="464" y="266" fill="#b45309" font-size="10">need them, this is bidi</text>

  <rect x="660" y="140" width="196" height="150" rx="10" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="758" y="162" text-anchor="middle" fill="#5b21b6" font-size="12" font-weight="bold">Bidirectional</text>
  <text x="676" y="184" fill="#6d28d9" font-size="10">SyncInventory</text>
  <text x="676" y="208" fill="#5b21b6" font-size="10" font-weight="bold">interactive session</text>
  <text x="676" y="226" fill="#6d28d9" font-size="10">both sides send freely</text>
  <text x="676" y="250" fill="#6d28d9" font-size="10">most expensive: pins a</text>
  <text x="676" y="266" fill="#6d28d9" font-size="10">connection, stalls deploys</text>

  <rect x="24" y="306" width="832" height="148" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="328" text-anchor="middle" fill="#b91c1c" font-size="13" font-weight="bold">Four things a schema review must catch &#8212; cheap now, expensive later</text>
  <text x="48" y="352" fill="#991b1b">1. Unbounded collections &#8212; every repeated field and list response needs a server-enforced maximum.</text>
  <text x="48" y="374" fill="#991b1b">2. Missing presence where zero is meaningful &#8212; reorder_threshold = 0 is a real rule a plain int32 cannot express.</text>
  <text x="48" y="396" fill="#991b1b">3. Storage identifiers on the wire &#8212; auto-increment ids leak volume, enable enumeration, and pin you to the database.</text>
  <text x="48" y="418" fill="#991b1b">4. Mutating methods with no idempotency key &#8212; gRPC retries automatically; safety is not automatic.</text>
  <text x="48" y="442" fill="#7f1d1d" font-weight="bold">All four are schema decisions. None can be added later without a breaking change.</text>
</svg>
```

## 4. Architecture & Workflow

**The review checklist**, applied to this schema before any code exists:

1. **Package** — `acme.inventory.v1`, matching directory `acme/inventory/v1/`. ✓ versionable.
2. **Every RPC has unique request/response messages.** ✓ no sharing.
3. **Every enum starts at `_UNSPECIFIED = 0`** with prefixed values. ✓ absence detectable.
4. **Timestamps are `Timestamp`, intervals are `Duration`, money is `google.type.Money`.** ✓ units unambiguous.
5. **Partial update uses a `FieldMask`.** ✓ zero expressible.
6. **List method is paginated with a cursor and a capped page size.** ✓ bounded.
7. **Mutating methods take an idempotency key.** ✓ retry-safe.
8. **Identifiers are opaque strings.** ✓ storage-independent.
9. **Fields present on every message use numbers 1–15**, with a gap left. ✓ byte-efficient.
10. **Deleted fields are `reserved` by number and name.** ✓ no silent reuse.
11. **Every streaming method's lifetime and resumption story is documented.** ✓ deployable.
12. **`buf lint` at `STANDARD` passes.** ✓ mechanically enforced.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="sv1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The InventoryService surface at a glance</text>

  <rect x="30" y="40" width="180" height="330" rx="10" fill="#f1f5f9" stroke="#64748b" stroke-width="2"/>
  <text x="120" y="62" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">Consumers</text>
  <rect x="46" y="76" width="148" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="120" y="97" text-anchor="middle" fill="#1e40af" font-size="10">checkout service</text>
  <rect x="46" y="118" width="148" height="34" rx="6" fill="#dbeafe" stroke="#2563eb"/>
  <text x="120" y="139" text-anchor="middle" fill="#1e40af" font-size="10">pricing service</text>
  <rect x="46" y="160" width="148" height="34" rx="6" fill="#dcfce7" stroke="#16a34a"/>
  <text x="120" y="181" text-anchor="middle" fill="#15803d" font-size="10">ops dashboard</text>
  <rect x="46" y="202" width="148" height="34" rx="6" fill="#fef3c7" stroke="#d97706"/>
  <text x="120" y="223" text-anchor="middle" fill="#92400e" font-size="10">scanner gun (mobile)</text>
  <rect x="46" y="244" width="148" height="34" rx="6" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="120" y="265" text-anchor="middle" fill="#5b21b6" font-size="10">warehouse terminal</text>
  <text x="120" y="302" text-anchor="middle" fill="#64748b" font-size="10">each consumer's needs</text>
  <text x="120" y="318" text-anchor="middle" fill="#64748b" font-size="10">decide the RPC kind &#8212;</text>
  <text x="120" y="334" text-anchor="middle" fill="#64748b" font-size="10">not the data model</text>

  <path d="M214,120 L266,120" stroke="#0ea5e9" stroke-width="2" marker-end="url(#sv1)"/>
  <path d="M214,178 L266,178" stroke="#0ea5e9" stroke-width="2" marker-end="url(#sv1)"/>
  <path d="M214,220 L266,220" stroke="#0ea5e9" stroke-width="2" marker-end="url(#sv1)"/>
  <path d="M214,262 L266,262" stroke="#0ea5e9" stroke-width="2" marker-end="url(#sv1)"/>

  <rect x="270" y="40" width="586" height="330" rx="10" fill="#fff" stroke="#4f46e5" stroke-width="2"/>
  <text x="563" y="62" text-anchor="middle" fill="#3730a3" font-size="12" font-weight="bold">service InventoryService</text>

  <rect x="288" y="76" width="550" height="26" rx="5" fill="#dbeafe" stroke="#2563eb"/>
  <text x="300" y="94" fill="#1e40af" font-family="ui-monospace,monospace" font-size="10">rpc GetItem(GetItemRequest) returns (GetItemResponse)</text>
  <rect x="288" y="106" width="550" height="26" rx="5" fill="#dbeafe" stroke="#2563eb"/>
  <text x="300" y="124" fill="#1e40af" font-family="ui-monospace,monospace" font-size="10">rpc ListItems(ListItemsRequest) returns (ListItemsResponse)   &#8592; cursor paged</text>
  <rect x="288" y="136" width="550" height="26" rx="5" fill="#dbeafe" stroke="#2563eb"/>
  <text x="300" y="154" fill="#1e40af" font-family="ui-monospace,monospace" font-size="10">rpc UpdateItem(UpdateItemRequest) returns (UpdateItemResponse) &#8592; FieldMask</text>
  <rect x="288" y="166" width="550" height="26" rx="5" fill="#dbeafe" stroke="#2563eb"/>
  <text x="300" y="184" fill="#1e40af" font-family="ui-monospace,monospace" font-size="10">rpc ReserveStock(ReserveStockRequest) returns (ReserveStockResponse) &#8592; idem key</text>

  <rect x="288" y="204" width="550" height="26" rx="5" fill="#dcfce7" stroke="#16a34a"/>
  <text x="300" y="222" fill="#15803d" font-family="ui-monospace,monospace" font-size="10">rpc WatchStock(WatchStockRequest) returns (stream StockEvent)</text>

  <rect x="288" y="240" width="550" height="26" rx="5" fill="#fef3c7" stroke="#d97706"/>
  <text x="300" y="258" fill="#92400e" font-family="ui-monospace,monospace" font-size="10">rpc BulkAdjustStock(stream AdjustStockRequest) returns (BulkAdjustSummary)</text>

  <rect x="288" y="276" width="550" height="26" rx="5" fill="#ede9fe" stroke="#7c3aed"/>
  <text x="300" y="294" fill="#5b21b6" font-family="ui-monospace,monospace" font-size="10">rpc SyncInventory(stream SyncRequest) returns (stream SyncResponse)</text>

  <text x="300" y="326" fill="#475569" font-size="10">Every RPC has its OWN request and response message &#8212; never shared, even when identical today.</text>
  <text x="300" y="344" fill="#475569" font-size="10">That is what lets you add a field for one method without touching any other.</text>
  <text x="300" y="362" fill="#475569" font-size="10">buf lint rule: RPC_REQUEST_RESPONSE_UNIQUE.</text>
</svg>
```

## 5. Implementation

The complete reference `.proto`. This is the file chapters 14–21 implement.

```protobuf
// Copyright 2026 Acme Corp.
//
// The Acme Inventory API, version 1.
//
// This service is the system of record for stock-keeping units (SKUs) and
// their quantities across warehouses and stores. It is an internal,
// east-west API consumed by the checkout, pricing and fulfilment services
// and by warehouse terminals; it is not exposed to browsers or partners
// directly (a grpc-gateway facade handles that — see the deployment chapter).

syntax = "proto3";

package acme.inventory.v1;

import "google/protobuf/duration.proto";
import "google/protobuf/field_mask.proto";
import "google/protobuf/timestamp.proto";
import "google/type/money.proto";   // requires buf.build/googleapis/googleapis

option go_package = "github.com/acme/apis/gen/go/acme/inventory/v1;inventoryv1";

// -----------------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------------

// InventoryService manages stock-keeping units and their quantities.
//
// Deadlines: every method has a documented server-side maximum. Callers MUST
// set a deadline; calls without one are rejected with INVALID_ARGUMENT by the
// deadline-enforcement interceptor.
service InventoryService {
  // ---------------------------------------------------------------- UNARY

  // GetItem returns a single item by SKU.
  //
  // Errors: NOT_FOUND if the SKU does not exist; INVALID_ARGUMENT if the SKU
  // is empty or malformed; PERMISSION_DENIED if the caller lacks
  // inventory.items.read on the item's warehouse.
  //
  // Recommended deadline: 1s. Server maximum: 5s.
  rpc GetItem(GetItemRequest) returns (GetItemResponse);

  // ListItems returns a page of items, newest first.
  //
  // Pagination is cursor-based: pass the previous response's next_page_token
  // to continue. Tokens are opaque and expire after 1 hour. page_size is
  // clamped server-side to [1, 200] with a default of 50.
  //
  // Errors: INVALID_ARGUMENT for a malformed or expired page_token.
  //
  // Recommended deadline: 3s. Server maximum: 10s.
  rpc ListItems(ListItemsRequest) returns (ListItemsResponse);

  // UpdateItem applies a partial update.
  //
  // Only the fields named in update_mask are changed. An empty mask means
  // "replace all updatable fields" (AIP-134). Naming an unknown or immutable
  // path (sku, created_at, updated_at) is INVALID_ARGUMENT — paths are never
  // silently ignored.
  //
  // Concurrency: if etag is set it must match the stored value, otherwise
  // ABORTED is returned and the caller should re-read and retry.
  //
  // Recommended deadline: 2s. Server maximum: 5s.
  rpc UpdateItem(UpdateItemRequest) returns (UpdateItemResponse);

  // ReserveStock holds units against an order so they cannot be sold twice.
  //
  // IDEMPOTENT: repeating a call with the same idempotency_key returns the
  // original reservation rather than creating a second one. Keys are retained
  // for 24 hours. Callers MUST supply a key; this is what makes the automatic
  // retry policy safe.
  //
  // Errors: FAILED_PRECONDITION when available stock is insufficient (with a
  // PreconditionFailure detail naming the SKU and the shortfall); NOT_FOUND
  // for an unknown SKU; ALREADY_EXISTS if the key was used with a different
  // request body.
  //
  // Recommended deadline: 2s. Server maximum: 5s.
  rpc ReserveStock(ReserveStockRequest) returns (ReserveStockResponse);

  // ------------------------------------------------------ SERVER STREAMING

  // WatchStock streams quantity changes for the requested SKUs as they happen.
  //
  // The server sends an initial snapshot event per SKU, then deltas. Streams
  // are capped at 30 minutes; on expiry the server closes with UNAVAILABLE and
  // the message "stream lifetime exceeded, reconnect with resume_token". The
  // client SHOULD reconnect using the last received resume_token, which
  // guarantees no missed events for up to 5 minutes.
  //
  // Recommended deadline: 30m (matching the server cap).
  rpc WatchStock(WatchStockRequest) returns (stream StockEvent);

  // ------------------------------------------------------ CLIENT STREAMING

  // BulkAdjustStock applies a sequence of quantity adjustments and returns one
  // summary. Designed for warehouse scanner devices uploading a shift's work.
  //
  // Adjustments are applied incrementally as they arrive, NOT atomically: a
  // failure part-way leaves earlier adjustments applied. The summary reports
  // exactly which SKUs were rejected and why. Callers needing atomicity should
  // use a single ReserveStock/CommitAdjustment pair instead.
  //
  // The server rejects the call with RESOURCE_EXHAUSTED after 10,000 messages.
  //
  // Recommended deadline: 5m.
  rpc BulkAdjustStock(stream AdjustStockRequest) returns (BulkAdjustSummary);

  // -------------------------------------------------------- BIDIRECTIONAL

  // SyncInventory reconciles a terminal's local counts against the server.
  //
  // The two directions are INDEPENDENT: the server may push a correction or a
  // heartbeat at any time, not only in response to a client message. Match
  // responses to requests using correlation_id, never by ordering.
  //
  // Streams are capped at 15 minutes. Heartbeats are sent every 30s; a client
  // seeing no message for 90s should reconnect.
  //
  // Recommended deadline: 15m.
  rpc SyncInventory(stream SyncRequest) returns (stream SyncResponse);
}

// -----------------------------------------------------------------------------
// Resource
// -----------------------------------------------------------------------------

// Item is a stock-keeping unit.
//
// Field numbers 1-15 are reserved for fields present on every Item, because
// their wire keys fit in a single byte. Number 15 is deliberately left free
// for a future hot field.
message Item {
  // Opaque, immutable identifier, e.g. "sku_01HQ8ZK3M4". Clients MUST NOT
  // parse or construct these. Never a database primary key.
  string sku = 1;

  // Display name. May be empty while status is DRAFT.
  string name = 2;

  // Units physically present. Never negative.
  int32 quantity_on_hand = 3;

  // Units promised to open reservations. Never negative, never greater than
  // quantity_on_hand. Available stock is quantity_on_hand - quantity_reserved.
  int32 quantity_reserved = 4;

  // Unit price. Structured money — never a float, and never an amount without
  // a currency.
  google.type.Money unit_price = 5;

  ItemStatus status = 6;

  // Where the stock physically is. Absent means "not yet allocated".
  Location location = 7;

  // Filterable labels. Keys are lowercase; at most 32 entries, each key
  // <= 64 bytes and each value <= 256 bytes (enforced by validation).
  map<string, string> labels = 8;

  // Server-managed. Set on creation and on every mutation respectively;
  // both are immutable from the client's perspective.
  google.protobuf.Timestamp created_at = 9;
  google.protobuf.Timestamp updated_at = 10;

  // How long a reservation on this item is held before auto-release.
  google.protobuf.Duration reservation_ttl = 11;

  // Reorder threshold. EXPLICIT presence: a threshold of 0 ("reorder only
  // when completely empty") is a real rule, distinct from "no reorder rule
  // configured". A plain int32 could not express that difference.
  optional int32 reorder_threshold = 12;

  // Opaque concurrency token. Pass the value you read back in UpdateItem to
  // get optimistic-concurrency semantics.
  string etag = 13;

  Dimensions dimensions = 14;

  // 15 intentionally free — one more single-byte key for a future hot field.

  message Dimensions {
    int32 length_mm = 1;
    int32 width_mm  = 2;
    int32 height_mm = 3;
    int32 weight_g  = 4;
  }

  // Removed in v1.7 (see ADR-114). The number and the name are retired
  // permanently so neither can ever be reused — reuse causes silent
  // misinterpretation of old data rather than a loud failure.
  reserved 20;
  reserved "legacy_bin_code";
}

// ItemStatus is an Item's lifecycle state.
//
// The zero value is UNSPECIFIED so that "the client did not set this" is
// detectable and rejectable. Values carry the enum-name prefix because enum
// values share the enclosing namespace, not the enum's.
enum ItemStatus {
  ITEM_STATUS_UNSPECIFIED  = 0;
  ITEM_STATUS_DRAFT        = 1;
  ITEM_STATUS_ACTIVE       = 2;
  ITEM_STATUS_DISCONTINUED = 3;
  ITEM_STATUS_ARCHIVED     = 4;
}

// Location expresses mutually exclusive placements. A oneof makes the
// exclusivity a property of the type rather than of a comment.
message Location {
  oneof place {
    Warehouse warehouse = 1;
    Store     store     = 2;
    InTransit transit   = 3;
  }
}

message Warehouse {
  string warehouse_id = 1;
  string aisle = 2;
  string bin = 3;
}

message Store {
  string store_id = 1;
  string shelf = 2;
}

message InTransit {
  string carrier = 1;
  string tracking_number = 2;
  google.protobuf.Timestamp expected_arrival = 3;
}

// -----------------------------------------------------------------------------
// Unary: GetItem
// -----------------------------------------------------------------------------

message GetItemRequest {
  // Required.
  string sku = 1;

  // Optional sparse read: return only these fields of the item. Empty means
  // all fields. Unknown paths are INVALID_ARGUMENT.
  google.protobuf.FieldMask read_mask = 2;
}

message GetItemResponse {
  Item item = 1;
}

// -----------------------------------------------------------------------------
// Unary: ListItems (cursor pagination — AIP-158)
// -----------------------------------------------------------------------------

message ListItemsRequest {
  // Maximum items to return. Clamped to [1, 200]; 0 means the default of 50.
  // A hard server-side cap is what stops one caller from requesting the whole
  // catalogue in a single response.
  int32 page_size = 1;

  // Opaque continuation token from a previous response. Encodes the sort
  // position, the filter and an expiry; clients MUST NOT construct or parse it.
  string page_token = 2;

  // Optional filters. Unset fields do not filter.
  ItemStatus status_filter = 3;
  string warehouse_id_filter = 4;

  // Optional sparse read applied to each returned item.
  google.protobuf.FieldMask read_mask = 5;
}

message ListItemsResponse {
  repeated Item items = 1;

  // Empty when there are no further pages. Present tokens are valid for 1 hour.
  string next_page_token = 2;

  // Best-effort total matching the filter. May be approximate for large
  // result sets; do not use it for pagination arithmetic.
  int32 total_size = 3;
}

// -----------------------------------------------------------------------------
// Unary: UpdateItem (partial update — AIP-134)
// -----------------------------------------------------------------------------

message UpdateItemRequest {
  // The item carrying NEW values. item.sku identifies the target.
  Item item = 1;

  // Which paths of `item` to apply. Empty means "all updatable fields".
  // Immutable paths (sku, created_at, updated_at, etag) are INVALID_ARGUMENT.
  google.protobuf.FieldMask update_mask = 2;

  // Optional optimistic concurrency. When set, must equal the stored etag or
  // the call fails with ABORTED.
  string etag = 3;
}

message UpdateItemResponse {
  Item item = 1;
}

// -----------------------------------------------------------------------------
// Unary: ReserveStock (idempotent mutation)
// -----------------------------------------------------------------------------

message ReserveStockRequest {
  // Required. Client-generated UUID making this call safe to retry. The same
  // key with the same body returns the original reservation; the same key with
  // a DIFFERENT body is ALREADY_EXISTS. Retained for 24 hours.
  string idempotency_key = 1;

  // Required. The order this reservation belongs to.
  string order_id = 2;

  // Required, 1..100 entries.
  repeated ReserveStockLine lines = 3;

  // Optional override of the item's default reservation TTL. Capped at 24h.
  google.protobuf.Duration hold_for = 4;
}

message ReserveStockLine {
  string sku = 1;
  int32  quantity = 2;   // must be > 0
}

message ReserveStockResponse {
  string reservation_id = 1;
  google.protobuf.Timestamp expires_at = 2;
  repeated ReservedLine lines = 3;

  // True when this response replays an earlier call with the same
  // idempotency_key, so callers can distinguish a fresh reservation from a
  // deduplicated retry in their metrics.
  bool idempotent_replay = 4;
}

message ReservedLine {
  string sku = 1;
  int32  quantity_reserved = 2;
  int32  quantity_available_after = 3;
}

// -----------------------------------------------------------------------------
// Server streaming: WatchStock
// -----------------------------------------------------------------------------

message WatchStockRequest {
  // SKUs to watch. 1..1000 entries. Empty is INVALID_ARGUMENT — a watch on
  // "everything" is not offered, because it cannot be load-balanced or bounded.
  repeated string skus = 1;

  // Resume from a previous stream. When set, the server replays events since
  // that point (up to 5 minutes of history) instead of sending a snapshot.
  string resume_token = 2;

  // When true (the default), the first event per SKU is a full snapshot.
  bool include_initial_snapshot = 3;
}

message StockEvent {
  string sku = 1;
  int32  quantity_on_hand = 2;
  int32  quantity_reserved = 3;
  google.protobuf.Timestamp occurred_at = 4;
  StockEventKind kind = 5;

  // Opaque cursor. Pass the most recent one as resume_token to continue
  // without gaps after a disconnect. This is what makes the stream resumable.
  string resume_token = 6;
}

enum StockEventKind {
  STOCK_EVENT_KIND_UNSPECIFIED = 0;
  STOCK_EVENT_KIND_SNAPSHOT    = 1;
  STOCK_EVENT_KIND_RECEIVED    = 2;
  STOCK_EVENT_KIND_RESERVED    = 3;
  STOCK_EVENT_KIND_RELEASED    = 4;
  STOCK_EVENT_KIND_SHIPPED     = 5;
  STOCK_EVENT_KIND_ADJUSTED    = 6;
}

// -----------------------------------------------------------------------------
// Client streaming: BulkAdjustStock
// -----------------------------------------------------------------------------

message AdjustStockRequest {
  string sku = 1;

  // Signed change. Often negative, so sint32 (ZigZag) rather than int32 —
  // a negative int32 costs ten bytes on the wire, a negative sint32 costs one.
  sint32 delta = 2;

  AdjustmentReason reason = 3;

  // Client-side timestamp of when the adjustment happened, which may be much
  // earlier than when it is uploaded (a scanner works offline).
  google.protobuf.Timestamp observed_at = 4;

  // Per-message idempotency so a resumed upload does not double-apply.
  string adjustment_id = 5;
}

enum AdjustmentReason {
  ADJUSTMENT_REASON_UNSPECIFIED  = 0;
  ADJUSTMENT_REASON_CYCLE_COUNT  = 1;
  ADJUSTMENT_REASON_DAMAGE       = 2;
  ADJUSTMENT_REASON_THEFT        = 3;
  ADJUSTMENT_REASON_RETURN       = 4;
  ADJUSTMENT_REASON_RECEIPT      = 5;
}

message BulkAdjustSummary {
  int32 applied  = 1;
  int32 rejected = 2;
  int32 duplicate_ignored = 3;
  repeated RejectedAdjustment rejections = 4;   // capped at 100 entries
  google.protobuf.Duration processing_time = 5;
}

message RejectedAdjustment {
  string sku = 1;
  string adjustment_id = 2;
  string reason = 3;
}

// -----------------------------------------------------------------------------
// Bidirectional: SyncInventory
// -----------------------------------------------------------------------------

message SyncRequest {
  // Echoed in the matching SyncResponse. Match by this, NEVER by ordering —
  // the two directions of a bidi stream are independent.
  string correlation_id = 1;

  oneof payload {
    CountReport   count_report = 2;
    Acknowledgement ack        = 3;
    ClientHeartbeat heartbeat  = 4;
  }
}

message CountReport {
  string sku = 1;
  int32  counted_quantity = 2;
  google.protobuf.Timestamp counted_at = 3;
  string counted_by = 4;
}

message Acknowledgement { string correction_id = 1; bool applied = 2; }
message ClientHeartbeat { google.protobuf.Timestamp sent_at = 1; }

message SyncResponse {
  // Matches the triggering request's correlation_id, or is empty for
  // server-initiated messages (corrections and heartbeats).
  string correlation_id = 1;

  oneof payload {
    CountResult    count_result = 2;
    Correction     correction   = 3;
    ServerHeartbeat heartbeat   = 4;
  }
}

message CountResult {
  string sku = 1;
  int32  server_quantity = 2;
  int32  counted_quantity = 3;
  bool   discrepancy = 4;
  int32  variance = 5;
}

message Correction {
  string correction_id = 1;
  string sku = 2;
  int32  corrected_quantity = 3;
  string rationale = 4;
}

message ServerHeartbeat {
  google.protobuf.Timestamp sent_at = 1;
  google.protobuf.Duration  stream_remaining = 2;   // time until the lifetime cap
}
```

**Generate:**

```bash
buf lint && buf breaking --against '.git#branch=main' && buf generate
```

## 6. Advantages, Disadvantages & Trade-offs

**What this design buys**
- **Every RPC is independently evolvable**, because no request or response message is shared.
- **Retries are safe** on the mutating method, because idempotency is in the schema rather than in a wiki page.
- **Streams are deployable**, because both have a documented lifetime cap and a resumption token.
- **Partial updates are unambiguous**, because `FieldMask` plus an `etag` covers both "which fields" and "based on what version".
- **Lists are bounded**, because `page_size` is clamped server-side and tokens expire.

**What it costs**
- **Verbosity.** Fourteen messages for seven methods. Shared messages would be shorter and unevolvable.
- **Server complexity.** Cursor tokens, idempotency-key storage, mask validation and etag checks are all real implementation work that a naive schema defers (and then never does).
- **Two streaming methods** that pin connections, complicate rolling deploys and need resumption logic on both sides.

**Trade-offs stated explicitly**
- *`BulkAdjustStock` is not atomic.* Incremental application means a mid-stream failure leaves partial work, which is documented and is the right trade for a scanner uploading a shift — but it would be wrong for a financial ledger, where a batched unary call inside a transaction is correct.
- *`total_size` is approximate.* An exact count on a large filtered set costs a second query and is stale by the time it arrives; the schema says so rather than implying precision.
- *`WatchStock` refuses to watch everything.* A firehose cannot be bounded or balanced; refusing it in the schema is better than discovering it in production.

## 7. Common Mistakes & Best Practices

- **Sharing request/response messages between RPCs.** The single most common cause of a schema that cannot be evolved.
- **Offset pagination (`page`/`offset`).** Breaks under concurrent writes (items shift between pages) and gets slower the deeper you go. Use an opaque cursor.
- **No server-side cap on `page_size`.** A client asking for 1,000,000 is not hypothetical.
- **Mutating methods without an idempotency key.** Retries are automatic and will double-apply.
- **`int32` for a frequently-negative field** like `delta`. Use `sint32` — a negative `int32` costs ten bytes.
- **Streams with no lifetime cap or resume token.** They stall `GracefulStop` and lose data on every disconnect.
- **Matching bidi responses to requests by order.** The directions are independent; use a correlation id.
- **Exposing database identifiers.** Use opaque, prefixed strings.
- **A `oneof` with no `default` handling planned** on the consumer side. A newer peer will send a member you do not know.
- **Deleting a field without `reserved`.** Silent data corruption when the number is reused.
- **Undocumented method deadlines.** Callers guess, and the guesses are wrong in both directions.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** Reflection plus `grpcurl -plaintext localhost:50051 describe acme.inventory.v1.InventoryService` gives any engineer the full surface, including comments if built with `--include_source_info`. `buf curl` does the same using the local `.proto`, with no server-side reflection needed.
- **Monitoring.** Per-method rate, error-by-code and latency, plus schema-specific signals: page-token expiry rate, idempotent-replay rate on `ReserveStock` (a spike means clients are timing out and retrying), active `WatchStock` streams, and `BulkAdjustStock` rejection ratio.
- **Security.** The schema is where field-level authorization becomes possible: `UpdateItem`'s mask lets you allow `status` but deny `unit_price` per role. Bound every `repeated` field (`skus` ≤ 1000, `lines` ≤ 100) in validation, not only via `MaxRecvMsgSize`, and treat `page_token` as untrusted input — sign it, or store it server-side.
- **Scaling.** `ListItems` with a cursor scales because each page is an indexed range scan; `total_size` deliberately does not promise precision because an exact count does not scale. `WatchStock`'s SKU cap and lifetime cap are what keep fan-out bounded when a dashboard tries to watch the whole catalogue.

## 9. Interview Questions

**Q: Why does every RPC get its own request and response message?**
A: Because a shared message cannot be evolved for one method without affecting every other method that uses it. The moment `GetItemRequest` is reused by a second RPC, adding a field for that RPC's needs changes the contract of the first, and you end up with fields that are meaningful for one caller and ignored by another. `buf lint`'s `RPC_REQUEST_RESPONSE_UNIQUE` enforces it. The cost is a little boilerplate; the benefit is a schema you can still change in five years.

**Q: Why is `ListItems` unary with pagination rather than server streaming?**
A: Because the client wants a page, not a feed. A page token is resumable — a dropped connection at row 4,000 continues from row 4,000 — and stateless, so any backend can serve the next page. A stream is neither: it restarts from zero and pins one connection to one backend for its lifetime, which breaks load balancing and stalls rolling deploys. Streaming is for data unbounded *in time*, like `WatchStock`, not merely for data that is large.

**Q: Why cursor pagination instead of offset?**
A: Offsets break under concurrent writes — insert a row and every subsequent page shifts, so clients see duplicates and gaps — and they get slower the deeper you go, because the database must count past all skipped rows. An opaque cursor encodes the sort position, so the next page is an indexed range scan of constant cost and is stable under concurrent inserts. It also lets you embed the filter and an expiry in the token, so a client cannot change filters mid-pagination and get incoherent results.

**Q: Why does `ReserveStock` need an idempotency key?**
A: Because it mutates and because gRPC clients retry. If a call times out after the server committed but before the response arrived, the retry would reserve stock twice — the double-charge bug in another costume. The key lets the server recognise the retry and return the original reservation, and the `idempotent_replay` flag lets the client distinguish that in its metrics. Crucially this is a *schema* decision: you cannot add a required idempotency key later without a breaking change.

**Q: Why `sint32` for `delta` but `int32` for `quantity_on_hand`?**
A: `quantity_on_hand` is never negative, so a plain varint is optimal — one byte for typical values. `delta` is frequently negative, and a negative `int32` is sign-extended to 64 bits before varint encoding, so `-1` costs ten bytes. `sint32` applies ZigZag first, which maps small magnitudes of either sign to small unsigned values, so `-1` costs one byte. On a stream of thousands of adjustments that is a real difference.

**Q: How do you make streaming methods deployable?**
A: Give every stream a server-enforced maximum lifetime and a resumption token. `WatchStock` closes at 30 minutes with `UNAVAILABLE` and a "reconnect with resume_token" message; the client reconnects and continues without gaps. Without a cap, `GracefulStop` waits indefinitely and a rolling deploy stalls, load stays pinned to old backends as you scale up, and any disconnect loses data. The cap and the token are both schema decisions, which is why they belong in this chapter rather than in the server chapter.

**Q: Why does `SyncInventory` carry a `correlation_id`?**
A: Because the two directions of a bidirectional stream are completely independent — response *k* has no defined relationship to request *k*, and the server may push corrections or heartbeats that answer no request at all. Matching by ordering works in a demo and fails the first time the server sends an unsolicited message. The correlation id makes the pairing explicit, and leaving it empty is how the schema marks a server-initiated message.

**Q: What does `total_size` promise, and why is it deliberately weak?**
A: It promises a best-effort, possibly approximate count of items matching the filter, explicitly not usable for pagination arithmetic. It is weak because an exact count over a large filtered set is a second full scan, is stale by the time the response is serialised, and would dominate the latency of a method whose whole point is to return one cheap page. Documenting the weakness is better than implying a precision the implementation cannot maintain — clients that need exactness need a different, explicitly expensive method.

**Q: (Senior) Walk me through designing this service from scratch in a design round.**
A: I would start by writing the domain in sentences and underlining the verbs, because each verb is a candidate method and the shape of its data decides the RPC kind — bounded in and out is unary, unbounded in time is server streaming, unbounded input with one summary is client streaming, independent two-way traffic is bidi. Then I would ask about consumers and traffic, because that decides granularity and deadlines. Next the resource: opaque string ids, `google.type.Money` for price, `Timestamp` for times, an enum with an `UNSPECIFIED` zero, and `optional` only where a zero value is genuinely meaningful. Then the cross-cutting decisions that cannot be retrofitted: cursor pagination with a server-clamped page size, `FieldMask` plus an `etag` for updates, an idempotency key on every mutation, lifetime caps and resume tokens on every stream, and explicit bounds on every repeated field. Finally I would write the error vocabulary per method — which code, with which details — and the deadline per method, and check the whole thing against `buf lint` at `STANDARD`. The thing I would emphasise is that roughly half of those decisions are impossible to add later without a breaking change, which is why the schema review is the highest-leverage half hour in the project.

**Q: (Senior) A reviewer says `BulkAdjustStock` should be atomic. How do you respond?**
A: I would agree that atomicity is desirable and disagree that client streaming can provide it, then explain the trade. Applying incrementally means a mid-stream failure leaves earlier adjustments applied, which the documentation states explicitly and the summary reports precisely. Making it atomic would mean buffering the entire stream server-side before applying anything — which reintroduces the unbounded memory problem the stream was meant to solve, holds a transaction open for the duration of a slow mobile upload, and still cannot survive the server restarting mid-upload. For this consumer, a scanner uploading a shift's cycle counts, incremental application with per-message `adjustment_id` idempotency is the right design: a resumed upload does not double-apply, and partial success is recoverable. If the caller genuinely needed all-or-nothing — a financial ledger posting, say — I would not use client streaming at all; I would use a unary method taking a bounded batch inside one transaction, and let the client chunk it.

**Q: (Senior) How would you evolve this schema to support multiple warehouses per item?**
A: Additively, in stages. Today `Item.location` is a singular `oneof`, which assumes one placement. I would add `repeated ItemPlacement placements = 15;` — using the deliberately-reserved single-byte number — where `ItemPlacement` carries a `Location`, a quantity and a warehouse id, and populate both `location` and `placements` during a transition, with `location` reflecting the primary placement. That keeps every existing consumer working unchanged. Then I would instrument which callers still read `location`, mark it `[deprecated = true]`, migrate them by name using that traffic data, and only after the notice period delete it with `reserved 7; reserved "location";`. The quantity fields need the same treatment — `quantity_on_hand` becomes a sum across placements, so it stays meaningful for old clients while new ones read per-placement figures. What I would avoid is changing `location`'s type in place, which is a wire and source break, or introducing `v2` for a change that is expressible additively — `v2` is for changes that genuinely cannot be, and it doubles the implementation surface until every consumer migrates.

## 10. Quick Revision & Cheat Sheet

| Design decision | Choice here | Why |
|---|---|---|
| Package | `acme.inventory.v1` + matching dir | Versionable; globally unique |
| Request/response | One pair per RPC | Independent evolution |
| Identifiers | Opaque prefixed strings | Storage-independent, no enumeration |
| Money | `google.type.Money` | Exact; currency never implicit |
| Times | `Timestamp` / `Duration` | Units and epoch unambiguous |
| Partial update | `FieldMask` + `etag` | Zero expressible; no lost updates |
| List | `page_size` (clamped) + opaque `page_token` | Stable, bounded, indexable |
| Mutation | `idempotency_key` | Retry-safe by construction |
| Enums | `_UNSPECIFIED = 0`, prefixed values | Absence detectable |
| Meaningful zero | `optional int32` | Presence explicit |
| Negative-heavy field | `sint32` | ZigZag: 1 byte, not 10 |
| Streams | Lifetime cap + `resume_token` | Deployable and resumable |
| Bidi pairing | `correlation_id` | Directions are independent |
| Deleted field | `reserved` number **and** name | No silent reuse |

**Flash cards**
- **Large list?** → Unary + cursor pagination. **Live feed?** → Server streaming.
- **Every mutating RPC needs?** → An idempotency key. It cannot be added later.
- **Every stream needs?** → A lifetime cap and a resume token.
- **Bidi responses matched by?** → `correlation_id`, never by order.
- **Frequently negative integer?** → `sint32`/`sint64`.
- **Which fields get numbers 1–15?** → Those present on every message; leave one free.

## 11. Hands-On Exercises & Mini Project

- [ ] Run `buf lint` at `STANDARD` on the §5 schema. It should pass; deliberately break three rules and read each message.
- [ ] Change `ListItems` to server streaming, then write down every consequence: retries, load balancing, deploys, resumption. Revert.
- [ ] Remove `idempotency_key` from `ReserveStockRequest` and run `buf breaking`. Then add it back as required and observe that the reverse change is also breaking — which is the point.
- [ ] Marshal 10,000 `AdjustStockRequest` messages with `delta = -1` using `sint32`, then again using `int32`, and compare total bytes.
- [ ] Add a field to `Item` at number 15 and at number 200, marshal a 1,000-element list of each, and measure the size difference.
- [ ] Write out, for every method, the exact set of status codes it can return and under what condition. Compare with the comments — any gap is a bug in the schema documentation.

### Mini Project — "Design: Your Own Service Contract"

**Goal.** Produce a complete, reviewable `.proto` for a domain you know, exercising all four RPC kinds, and defend every decision — exactly the artefact a design round asks for.

**Requirements.**
1. Pick a domain with genuine tension (ride-hailing, ticketing, payments, chat). Write the use cases as sentences and derive the method list from the verbs.
2. Include at least one method of each RPC kind, with a written justification for each streaming choice — including why the unary alternative was rejected.
3. Every RPC has unique request/response messages, a documented deadline, and a documented error vocabulary mapping conditions to status codes.
4. The resource uses opaque ids, `Timestamp`/`Duration`/`Money`, an enum with `UNSPECIFIED`, at least one `oneof`, and `optional` exactly where a zero value is meaningful.
5. The list method is cursor-paginated with a clamped page size; the update method uses `FieldMask` plus an `etag`; every mutation takes an idempotency key; every stream has a lifetime cap and a resume token; every repeated field has a documented bound.
6. `buf lint` at `STANDARD` passes, and `buf breaking` runs in CI against a baseline.

**Extensions.**
- Write a v2 of one message that could not be expressed additively, run `buf breaking` to prove it, and design the side-by-side migration.
- Add `protovalidate` constraints for every documented bound and prove each fires with a test.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *proto3 in Depth* (the constructs used here), *Well-Known Types* (Timestamp, Duration, FieldMask, Money), *The Four RPC Patterns* (why each method has its shape), *Schema Evolution* (which of these decisions you can change later), *Build: The gRPC Server* (implementing this contract).

- **Google API Design Guide** — Google · *Intermediate* · resource-oriented design, standard methods, naming, errors and long-running operations; the source of most conventions in this chapter. <https://cloud.google.com/apis/design>
- **Google AIP-158 — Pagination** — Google · *Intermediate* · the canonical specification of `page_size`, `page_token` and `next_page_token`, including token opacity and expiry. <https://google.aip.dev/158>
- **Google AIP-134 — Standard methods: Update** — Google · *Intermediate* · `FieldMask` update semantics, immutable fields and etag concurrency. <https://google.aip.dev/134>
- **Google AIP-155 — Request identification (idempotency)** — Google · *Intermediate* · how to design and document idempotency keys for mutating RPCs. <https://google.aip.dev/155>
- **Buf Style Guide** — Buf (open source) · *Beginner* · naming, prefixing, file layout and the `RPC_REQUEST_RESPONSE_UNIQUE` rule, all enforced by `buf lint`. <https://buf.build/docs/best-practices/style-guide>
- **Protocol Buffers — Best Practices** — Google · *Intermediate* · field numbering, message reuse, enum design and the changes never to make. <https://protobuf.dev/best-practices/dos-donts/>
- **grpc-go examples — route_guide** — gRPC Authors · *Beginner* · the canonical `.proto` exercising all four RPC kinds, useful as a smaller counterpart to this chapter's schema. <https://github.com/grpc/grpc-go/tree/master/examples/route_guide>
- **googleapis — google/type common types** — Google · *Intermediate* · `Money`, `Date`, `Interval` and friends, used here for `unit_price`. <https://github.com/googleapis/googleapis/tree/master/google/type>

---

*gRPC with Go Handbook — chapter 11.*
