# 07 · Go Module Layout, go_package & Generated Code Anatomy

> **In one line:** Where your `.proto` files live, what `option go_package` says, and what `protoc` emits into which directory are one coupled decision — get it right once and every import in the repository is obvious; get it wrong and you fight import cycles and duplicate registrations for years.

---

## 1. Overview

Two questions dominate the first day of any Go gRPC project: *where do the `.proto` files go*, and *where does the generated code go*. They look like taste. They are not: they determine whether your API can be versioned, whether other repositories can consume it, whether generated packages collide in the protobuf global registry, and whether the generated import path in one file contradicts the directory it was written to.

The coupling runs through `option go_package`. That option tells `protoc-gen-go` the **Go import path** of the package it is generating, and — with `paths=import` — also where to write the file. Meanwhile `--go_out` says which directory to write under, and `paths=source_relative` says "mirror the input layout instead of deriving it from `go_package`". Get any two of these out of alignment and you get files in surprising directories, or a package whose declared import path does not match where it sits.

The second half of this chapter is a guided tour of what `protoc` actually emits. Most Go developers use generated code for years without reading it, then hit a question — why does `UnimplementedFooServer` exist, what is `mustEmbedUnimplemented`, why is there a `_ServiceDesc` variable, what happens if two packages register the same proto file name — that is only answerable by looking. Reading the output once removes a whole category of confusion.

## 2. Core Concepts

- **`option go_package`** — file-level `.proto` option: `"import/path;packagename"`. The part before `;` is the Go import path; the optional part after is the package name (defaults to the last path element).
- **Proto package** — the `package inventory.v1;` line. Namespaces messages and services *on the wire* (it forms the `:path`), and must be globally unique across everything a binary links.
- **`--go_out` / `--go-grpc_out`** — the output root directory for each plugin.
- **`paths=source_relative`** — write `foo/bar.pb.go` for input `foo/bar.proto`, relative to the out root. The default, `paths=import`, instead derives the directory from `go_package`.
- **`M` flags** — `--go_opt=Mproto/foo.proto=example.com/gen/foo`, an override of `go_package` per file from the command line, used when you cannot edit a third-party `.proto`.
- **Global registry** — `protoregistry.GlobalFiles`/`GlobalTypes`, populated at `init()` by every generated file. Two files claiming the same proto path or the same fully-qualified message name **panic at startup**.
- **API version suffix** — the `v1` in `inventory.v1`, and the matching `v1/` directory. Major-version-in-the-package is the standard way to run two incompatible versions side by side.
- **`.pb.go` vs `_grpc.pb.go`** — messages and serialisation vs service stubs. Two plugins, two files, same Go package.
- **`ServiceDesc`** — the runtime table mapping method names to handler functions, consumed by `RegisterFooServer`.
- **Forward-compatibility embed** — `UnimplementedFooServer`, plus the unexported `mustEmbedUnimplementedFooServer()` method that makes embedding mandatory.

## 3. Theory & Principles

### The three layout choices, and when each is right

**A. Proto in the service repo, generated code beside it.** The default for a single team owning both service and schema.

```
myservice/
├── go.mod                       // module github.com/acme/myservice
├── proto/
│   └── inventory/v1/
│       └── inventory.proto      // package inventory.v1
├── gen/
│   └── inventory/v1/
│       ├── inventory.pb.go      // package inventoryv1
│       └── inventory_grpc.pb.go
├── internal/
│   ├── server/                  // implements the generated interface
│   └── store/
└── cmd/
    ├── server/main.go
    └── client/main.go
```

`option go_package = "github.com/acme/myservice/gen/inventory/v1;inventoryv1";`

Simple, one build, no cross-repo coordination. The weakness: other repositories consuming this API must import `github.com/acme/myservice`, pulling in the whole service including its `internal/` neighbours and dependency graph.

**B. A dedicated API module.** The schema and generated code live in their own module, versioned independently.

```
acme-apis/                       // module github.com/acme/apis
├── go.mod                       // depends only on grpc + protobuf
├── buf.yaml
├── inventory/v1/inventory.proto
├── orders/v1/orders.proto
└── gen/go/
    ├── inventory/v1/*.pb.go
    └── orders/v1/*.pb.go
```

Consumers `go get github.com/acme/apis@v1.4.0` and get nothing but generated code and its two dependencies. This is the right answer once more than one repository consumes the API, and it makes the schema's release cadence explicit.

**C. Monorepo with a single proto tree.** One `proto/` root, one codegen step, all services importing from `gen/`. Best when the organisation already has a monorepo; the `.proto` review process becomes an ordinary code review.

### `go_package` and the `paths` option, precisely

This is the part that confuses everyone, so here it is exhaustively. Given input `proto/inventory/v1/inventory.proto` with `option go_package = "github.com/acme/myservice/gen/inventory/v1;inventoryv1"` and `--proto_path=proto`:

| Invocation | Output file | Package clause |
|---|---|---|
| `--go_out=gen --go_opt=paths=source_relative` | `gen/inventory/v1/inventory.pb.go` | `package inventoryv1` |
| `--go_out=gen` (i.e. `paths=import`) | `gen/github.com/acme/myservice/gen/inventory/v1/inventory.pb.go` | `package inventoryv1` |
| `--go_out=gen --go_opt=module=github.com/acme/myservice` | `gen/gen/inventory/v1/inventory.pb.go` | `package inventoryv1` |

The second row is why so many people end up with a bizarre `github.com/` directory inside their repository: `paths=import` writes the *full import path* as a directory tree. **Use `paths=source_relative` unless you have a specific reason not to** — then the directory layout mirrors your `.proto` layout and is predictable at a glance.

The `module=` option is the middle ground: it strips the given prefix from the import path before using it as a directory, which is useful when `--go_out` points at the module root.

### The global registry: why proto package names must be unique

Every generated file registers itself at `init()` into `protoregistry.GlobalFiles` keyed by its **proto file path** (e.g. `inventory/v1/inventory.proto`), and every message and service into `GlobalTypes` keyed by its **fully-qualified proto name** (e.g. `inventory.v1.Item`). If two linked packages claim the same key, the process **panics at startup**:

```
panic: proto: file "inventory/v1/inventory.proto" is already registered
	previously from: "github.com/acme/apis/gen/inventory/v1"
	currently from:  "github.com/acme/myservice/gen/inventory/v1"
```

This is the classic failure when the same `.proto` is generated twice into two Go packages — for example, a vendored copy plus a module dependency. The rules that prevent it:
- **One `.proto` file path, generated exactly once**, into exactly one Go package, in the whole binary.
- **Proto package names must be globally unique**, so include the organisation and API name: `acme.inventory.v1`, not `inventory` or `api`.
- **Never fork a `.proto` by copying it** into another repository. Depend on the module, or use `buf` modules.

```svg
<svg viewBox="0 0 880 470" width="100%" height="470" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="l1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">go_package, --go_out and paths= : how the output path is decided</text>

  <rect x="30" y="44" width="360" height="120" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="210" y="66" text-anchor="middle" fill="#3730a3" font-size="12" font-weight="bold">Inputs</text>
  <text x="46" y="90" fill="#4338ca" font-family="ui-monospace,monospace" font-size="10">input: proto/inventory/v1/inventory.proto</text>
  <text x="46" y="108" fill="#4338ca" font-family="ui-monospace,monospace" font-size="10">--proto_path=proto</text>
  <text x="46" y="126" fill="#4338ca" font-family="ui-monospace,monospace" font-size="10">--go_out=gen</text>
  <text x="46" y="148" fill="#4338ca" font-family="ui-monospace,monospace" font-size="10">go_package = ".../gen/inventory/v1;inventoryv1"</text>

  <path d="M392,104 L452,104" stroke="#4f46e5" stroke-width="2" marker-end="url(#l1)"/>

  <rect x="456" y="44" width="400" height="120" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="656" y="66" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">paths=source_relative  &#8592; use this</text>
  <text x="472" y="92" fill="#166534" font-family="ui-monospace,monospace" font-size="10">gen/inventory/v1/inventory.pb.go</text>
  <text x="472" y="112" fill="#166534" font-size="10">mirrors the .proto layout under --go_out</text>
  <text x="472" y="130" fill="#166534" font-size="10">predictable at a glance &#183; no surprise directories</text>
  <text x="472" y="150" fill="#166534" font-size="10">go_package still supplies the package NAME + import path</text>

  <rect x="456" y="178" width="400" height="110" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="656" y="200" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">paths=import (the default) &#8594; usually a mistake</text>
  <text x="472" y="226" fill="#991b1b" font-family="ui-monospace,monospace" font-size="10">gen/github.com/acme/myservice/gen/</text>
  <text x="472" y="242" fill="#991b1b" font-family="ui-monospace,monospace" font-size="10">     inventory/v1/inventory.pb.go</text>
  <text x="472" y="264" fill="#991b1b" font-size="10">the full import path becomes a directory tree</text>
  <text x="472" y="280" fill="#991b1b" font-size="10">this is why repos sprout a stray github.com/ folder</text>

  <rect x="30" y="304" width="826" height="150" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="443" y="326" text-anchor="middle" fill="#854d0e" font-size="12" font-weight="bold">The global registry: one .proto file path per binary, forever</text>
  <rect x="60" y="340" width="230" height="60" rx="8" fill="#fff" stroke="#ca8a04"/>
  <text x="175" y="362" text-anchor="middle" fill="#713f12" font-size="10">github.com/acme/apis/gen/</text>
  <text x="175" y="378" text-anchor="middle" fill="#713f12" font-size="10">inventory/v1</text>
  <text x="175" y="394" text-anchor="middle" fill="#713f12" font-size="10">registers "inventory/v1/inventory.proto"</text>

  <rect x="590" y="340" width="230" height="60" rx="8" fill="#fff" stroke="#ca8a04"/>
  <text x="705" y="362" text-anchor="middle" fill="#713f12" font-size="10">github.com/acme/myservice/gen/</text>
  <text x="705" y="378" text-anchor="middle" fill="#713f12" font-size="10">inventory/v1  (a vendored copy)</text>
  <text x="705" y="394" text-anchor="middle" fill="#713f12" font-size="10">registers the SAME path</text>

  <rect x="320" y="346" width="240" height="48" rx="8" fill="#fee2e2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="366" text-anchor="middle" fill="#b91c1c" font-weight="bold">PANIC at init()</text>
  <text x="440" y="384" text-anchor="middle" fill="#7f1d1d" font-size="10">"file ... is already registered"</text>

  <text x="60" y="424" fill="#713f12">Prevention: never copy a .proto between repos &#183; depend on the API module &#183; make proto packages org-unique</text>
  <text x="60" y="442" fill="#713f12">Good: acme.inventory.v1 &#183; Bad: inventory, api, common, service &#8212; these WILL collide eventually</text>
</svg>
```

## 4. Architecture & Workflow

**A guided tour of the generated code.** Given this input:

```protobuf
syntax = "proto3";
package acme.inventory.v1;
option go_package = "github.com/acme/myservice/gen/inventory/v1;inventoryv1";

service InventoryService {
  rpc GetItem(GetItemRequest) returns (GetItemResponse);
  rpc WatchStock(WatchStockRequest) returns (stream StockEvent);
}

message GetItemRequest { string sku = 1; }
message GetItemResponse { Item item = 1; }
message Item { string sku = 1; int32 quantity_on_hand = 2; }
message WatchStockRequest { repeated string skus = 1; }
message StockEvent { string sku = 1; int32 quantity_on_hand = 2; }
```

**`inventory.pb.go`** (from `protoc-gen-go`) contains, in order:

1. **A version guard.** `const _ = protoimpl.EnforceVersion(...)` — two constants that fail to compile if the runtime is too old or too new.
2. **One struct per message**, with unexported bookkeeping fields:
   ```go
   type Item struct {
       state         protoimpl.MessageState  // caches reflection info; makes the struct non-copyable
       sizeCache     protoimpl.SizeCache     // memoises proto.Size between Size and Marshal
       unknownFields protoimpl.UnknownFields // preserves fields this binary does not know (ch. 03)

       Sku            string `protobuf:"bytes,1,opt,name=sku,proto3" json:"sku,omitempty"`
       QuantityOnHand int32  `protobuf:"varint,2,opt,name=quantity_on_hand,json=quantityOnHand,proto3" json:"quantity_on_hand,omitempty"`
   }
   ```
   The struct tag carries the wire type, field number and JSON name — this is what the reflection-based codec reads.
3. **Getters for every field.** `func (x *Item) GetSku() string` returns the zero value on a nil receiver, which is why `resp.GetItem().GetSku()` is nil-safe and direct field access is not. **Always use the getters.**
4. **`Reset`, `String`, `ProtoReflect`, `Descriptor`** — the `proto.Message` interface plus legacy helpers.
5. **`file_..._rawDesc`** — the serialised `FileDescriptorProto`, and an `init()` that registers it into `protoregistry.GlobalFiles`.

**`inventory_grpc.pb.go`** (from `protoc-gen-go-grpc`) contains:

1. **Method-name constants**, since plugin v1.5:
   ```go
   const (
       InventoryService_GetItem_FullMethodName    = "/acme.inventory.v1.InventoryService/GetItem"
       InventoryService_WatchStock_FullMethodName = "/acme.inventory.v1.InventoryService/WatchStock"
   )
   ```
   These are the `:path` values from chapter 2, and they are what you match on in interceptors.
2. **The client interface and its implementation.**
   ```go
   type InventoryServiceClient interface {
       GetItem(ctx context.Context, in *GetItemRequest, opts ...grpc.CallOption) (*GetItemResponse, error)
       WatchStock(ctx context.Context, in *WatchStockRequest, opts ...grpc.CallOption) (grpc.ServerStreamingClient[StockEvent], error)
   }
   func NewInventoryServiceClient(cc grpc.ClientConnInterface) InventoryServiceClient
   ```
   `NewX` takes a `ClientConnInterface`, not a concrete `*grpc.ClientConn` — which is exactly what makes bufconn testing and fakes possible (chapter 27).
3. **The server interface, with a mandatory embed.**
   ```go
   type InventoryServiceServer interface {
       GetItem(context.Context, *GetItemRequest) (*GetItemResponse, error)
       WatchStock(*WatchStockRequest, grpc.ServerStreamingServer[StockEvent]) error
       mustEmbedUnimplementedInventoryServiceServer()   // unexported -> only satisfiable by embedding
   }
   ```
   The unexported method is the enforcement mechanism: no type outside the generated package can implement it except by embedding `UnimplementedInventoryServiceServer`. That is what makes *adding* an RPC a non-breaking change for every existing implementation.
4. **`UnimplementedInventoryServiceServer`** — default methods returning `codes.Unimplemented`, plus the marker method.
5. **`RegisterInventoryServiceServer(s grpc.ServiceRegistrar, srv InventoryServiceServer)`** and the **`ServiceDesc`**:
   ```go
   var InventoryService_ServiceDesc = grpc.ServiceDesc{
       ServiceName: "acme.inventory.v1.InventoryService",
       HandlerType: (*InventoryServiceServer)(nil),
       Methods:  []grpc.MethodDesc{{MethodName: "GetItem", Handler: _InventoryService_GetItem_Handler}},
       Streams:  []grpc.StreamDesc{{StreamName: "WatchStock", Handler: _InventoryService_WatchStock_Handler, ServerStreams: true}},
       Metadata: "inventory/v1/inventory.proto",
   }
   ```
   This is the dispatch table the server consults on every incoming `:path`. Note `ServiceRegistrar` rather than `*grpc.Server` — again, so tests and wrappers can substitute.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">What each plugin emits, and who consumes it</text>

  <rect x="30" y="42" width="180" height="46" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="120" y="62" text-anchor="middle" fill="#3730a3" font-weight="bold">inventory.proto</text>
  <text x="120" y="80" text-anchor="middle" fill="#4338ca" font-size="10">package acme.inventory.v1</text>

  <rect x="256" y="42" width="270" height="150" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="391" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">inventory.pb.go  (protoc-gen-go)</text>
  <text x="272" y="88" fill="#166534" font-size="10">&#8226; type Item struct { state, sizeCache,</text>
  <text x="272" y="104" fill="#166534" font-size="10">    unknownFields, Sku, QuantityOnHand }</text>
  <text x="272" y="122" fill="#166534" font-size="10">&#8226; GetSku() / GetQuantityOnHand()  &#8212; nil-safe</text>
  <text x="272" y="140" fill="#166534" font-size="10">&#8226; ProtoReflect(), Reset(), String()</text>
  <text x="272" y="158" fill="#166534" font-size="10">&#8226; file_..._rawDesc + init() registration</text>
  <text x="272" y="180" fill="#15803d" font-size="10" font-weight="bold">consumed by: proto.Marshal, your code</text>

  <rect x="556" y="42" width="300" height="150" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="706" y="64" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">inventory_grpc.pb.go (protoc-gen-go-grpc)</text>
  <text x="572" y="88" fill="#b45309" font-size="10">&#8226; ..._FullMethodName constants  &#8594; the :path</text>
  <text x="572" y="106" fill="#b45309" font-size="10">&#8226; InventoryServiceClient + NewInventoryServiceClient</text>
  <text x="572" y="124" fill="#b45309" font-size="10">&#8226; InventoryServiceServer (with mustEmbed...)</text>
  <text x="572" y="142" fill="#b45309" font-size="10">&#8226; UnimplementedInventoryServiceServer</text>
  <text x="572" y="160" fill="#b45309" font-size="10">&#8226; RegisterInventoryServiceServer + ServiceDesc</text>
  <text x="572" y="182" fill="#92400e" font-size="10" font-weight="bold">consumed by: grpc.Server dispatch, your stubs</text>

  <rect x="30" y="216" width="400" height="80" rx="10" fill="#e0e7ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="230" y="238" text-anchor="middle" fill="#3730a3" font-size="12" font-weight="bold">Why UnimplementedFooServer must be embedded</text>
  <text x="46" y="260" fill="#4338ca" font-size="10">The server interface contains an UNEXPORTED method</text>
  <text x="46" y="276" fill="#4338ca" font-family="ui-monospace,monospace" font-size="10">mustEmbedUnimplementedInventoryServiceServer()</text>
  <text x="46" y="292" fill="#4338ca" font-size="10">so only the generated package can supply it &#8594; you must embed.</text>

  <rect x="452" y="216" width="404" height="80" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="654" y="238" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">The payoff</text>
  <text x="468" y="260" fill="#166534" font-size="10">Adding a new rpc to the .proto does NOT break any existing</text>
  <text x="468" y="276" fill="#166534" font-size="10">implementation &#8212; the embed supplies a default that returns</text>
  <text x="468" y="292" fill="#166534" font-family="ui-monospace,monospace" font-size="10">codes.Unimplemented</text>

  <rect x="30" y="316" width="826" height="70" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="443" y="338" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Two rules that prevent 90% of layout pain</text>
  <text x="50" y="360" fill="#991b1b">1. Always use the generated getters (GetItem().GetSku()) &#8212; they are nil-safe; direct field access panics.</text>
  <text x="50" y="378" fill="#991b1b">2. Never edit generated files, and never copy a .proto between repositories &#8212; both end in a registry panic.</text>
</svg>
```

## 5. Implementation

A complete, opinionated layout you can copy, with the generation command and the consuming code.

```
myservice/
├── go.mod                              # module github.com/acme/myservice
├── Makefile
├── buf.yaml                            # optional but recommended (ch. 08)
├── proto/
│   └── acme/
│       ├── inventory/v1/inventory.proto
│       └── orders/v1/orders.proto
├── gen/
│   └── acme/
│       ├── inventory/v1/{inventory.pb.go, inventory_grpc.pb.go}
│       └── orders/v1/{orders.pb.go, orders_grpc.pb.go}
├── internal/
│   ├── inventory/
│   │   ├── service.go                  # implements inventoryv1.InventoryServiceServer
│   │   ├── service_test.go
│   │   └── store.go
│   └── platform/
│       ├── interceptors/               # logging, auth, metrics (ch. 23)
│       └── observability/
├── cmd/
│   ├── inventoryd/main.go              # wiring only
│   └── inventoryctl/main.go
└── deploy/
```

**The `.proto` header that makes it work:**

```protobuf
syntax = "proto3";

// The proto package is a GLOBAL namespace and forms the wire :path.
// Prefix it with your organisation so it can never collide with another
// team's "inventory" or "common".
package acme.inventory.v1;

// Import path ; package name.
// Import path must match where paths=source_relative will write the file,
// relative to the module root — otherwise the package compiles but every
// import statement in the repo is a lie.
option go_package = "github.com/acme/myservice/gen/acme/inventory/v1;inventoryv1";
```

**Generation:**

```bash
protoc \
  --proto_path=proto \
  --go_out=gen      --go_opt=paths=source_relative \
  --go-grpc_out=gen --go-grpc_opt=paths=source_relative \
  $(find proto -name '*.proto')

# input : proto/acme/inventory/v1/inventory.proto
# output: gen/acme/inventory/v1/inventory.pb.go       (package inventoryv1)
#         gen/acme/inventory/v1/inventory_grpc.pb.go
# import: github.com/acme/myservice/gen/acme/inventory/v1  ✓ matches go_package
```

**The service implementation — note where the embed goes:**

```go
package inventory

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	inventoryv1 "github.com/acme/myservice/gen/acme/inventory/v1"
)

// Service implements inventoryv1.InventoryServiceServer.
//
// The embedded UnimplementedInventoryServiceServer is REQUIRED: the generated
// interface contains an unexported mustEmbed... method that only the generated
// package can satisfy. Embedding it means adding a new rpc to the .proto is a
// non-breaking change here — the new method returns codes.Unimplemented until
// we implement it, instead of failing to compile.
//
// Embed by VALUE, not by pointer: a nil pointer embed panics on any
// unimplemented method instead of returning Unimplemented.
type Service struct {
	inventoryv1.UnimplementedInventoryServiceServer

	store Store
}

// Compile-time assertion that we still satisfy the interface. Cheap, and it
// fails at build time rather than at RegisterXxxServer.
var _ inventoryv1.InventoryServiceServer = (*Service)(nil)

func New(store Store) *Service { return &Service{store: store} }

func (s *Service) GetItem(
	ctx context.Context,
	req *inventoryv1.GetItemRequest,
) (*inventoryv1.GetItemResponse, error) {
	// Always the generated getters, never req.Sku: the getters are nil-safe,
	// which matters because a malformed call can deliver a nil message.
	sku := req.GetSku()
	if sku == "" {
		return nil, status.Error(codes.InvalidArgument, "sku is required")
	}

	item, err := s.store.Get(ctx, sku)
	if err != nil {
		return nil, status.Errorf(codes.NotFound, "item %q not found", sku)
	}

	return &inventoryv1.GetItemResponse{Item: item}, nil
}
```

**`cmd/inventoryd/main.go` — wiring only, no business logic:**

```go
package main

import (
	"log"
	"net"

	"google.golang.org/grpc"

	inventoryv1 "github.com/acme/myservice/gen/acme/inventory/v1"
	"github.com/acme/myservice/internal/inventory"
)

func main() {
	lis, err := net.Listen("tcp", ":50051")
	if err != nil {
		log.Fatalf("listen: %v", err)
	}

	srv := grpc.NewServer()

	// RegisterXxxServer populates the server's dispatch table from the
	// generated ServiceDesc, mapping "/acme.inventory.v1.InventoryService/GetItem"
	// to the handler wrapper that unmarshals, runs interceptors, and calls us.
	inventoryv1.RegisterInventoryServiceServer(srv, inventory.New(inventory.NewMemStore()))

	log.Printf("listening on %s", lis.Addr())
	log.Fatal(srv.Serve(lis))
}
```

**Handling third-party `.proto` files you cannot edit** — use `M` flags to supply `go_package` externally:

```bash
protoc \
  --proto_path=proto \
  --proto_path=third_party \
  --go_out=gen --go_opt=paths=source_relative \
  --go_opt=Mthird_party/vendorapi/v1/vendor.proto=github.com/acme/myservice/gen/vendorapi/v1 \
  proto/acme/inventory/v1/inventory.proto third_party/vendorapi/v1/vendor.proto
```

## 6. Advantages, Disadvantages & Trade-offs

| Layout | Advantages | Disadvantages | Choose when |
|---|---|---|---|
| **A. Proto in service repo** | One repo, one build, zero coordination; fastest iteration | Consumers import the whole service module; no independent API versioning | One team owns schema and service; few or no external consumers |
| **B. Dedicated API module** | Consumers get only generated code + 2 deps; API versioned independently; clear ownership | Two repos to release in step; a schema change is now a cross-repo PR | More than one repository consumes the API |
| **C. Monorepo proto tree** | One codegen step; atomic cross-service changes; `.proto` review is ordinary code review | Requires monorepo tooling and discipline; large build graph | The organisation already has a monorepo |

**Trade-offs**
- *`paths=source_relative` vs `paths=import`:* source-relative gives a predictable directory layout at the cost of requiring `go_package` and `--go_out` to be kept consistent by you. `paths=import` derives everything from `go_package` but produces deep, ugly trees.
- *Generated code inside vs outside the module:* keeping `gen/` in-module is simplest; publishing it as its own module decouples release cadence but multiplies release overhead.
- *One Go package per proto package vs flattening:* one-to-one is predictable and matches every tool's assumption; flattening several proto packages into one Go package causes name collisions and confuses `buf`.

## 7. Common Mistakes & Best Practices

- **Omitting `option go_package`.** `protoc-gen-go` fails with `Plugin failed with status code 1`; the real message is on the following line.
- **`go_package` that does not match the actual location.** The package compiles, but every import in the repo points somewhere that does not exist. Keep `go_package` + `--go_out` + `paths=source_relative` consistent.
- **Copying a `.proto` into a second repository.** Both generate, both register the same file path, and the binary panics at `init()`. Depend on the API module instead.
- **Generic proto package names** — `package api;`, `package common;`, `package models;`. These collide eventually. Always `org.domain.vN`.
- **Editing generated files.** They are overwritten on the next `make generate`. Add methods in a separate file in the same package.
- **Direct field access instead of getters.** `req.Sku` panics on a nil message; `req.GetSku()` returns `""`. Use getters everywhere, without exception.
- **Embedding `UnimplementedFooServer` by pointer.** A nil pointer embed panics rather than returning `Unimplemented`. Embed by value.
- **Putting business logic in `cmd/`.** Keep `main.go` to wiring; the service belongs in `internal/` where it is testable.
- **No `v1` in the proto package.** Without a version segment you cannot ever run two incompatible versions side by side, which is the only sane migration path (chapter 13).

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `protoc --descriptor_set_out=fds.bin --include_imports ...` produces the exact descriptor set; `buf build -o -#format=json` renders it readable. When a registry panic occurs, the message names both packages — the fix is always to delete one.
- **CI.** In addition to `verify-generate` (chapter 6), run `go vet ./...` and a check that `gen/` contains no hand-edits (compare against a fresh generation into a temp directory).
- **Security.** Generated code is executable content produced by a plugin. Pin plugin versions, review `go_package` changes in code review (a changed import path can silently repoint consumers), and never generate from `.proto` files fetched at build time from an unpinned source.
- **Scaling.** The moment a second repository needs your `.proto`, move to layout B or C. Vendoring copies is the failure mode that produces registry panics and silent schema drift; `buf` modules or a published API module are the two supported answers.

## 9. Interview Questions

**Q: What does `option go_package` do, and what happens without it?**
A: It gives `protoc-gen-go` the Go import path for the generated package, optionally with an explicit package name after a semicolon: `"github.com/acme/svc/gen/inventory/v1;inventoryv1"`. Without it the plugin fails — you see `Plugin failed with status code 1` with the real explanation on the next line. With `paths=import` it also determines the output directory; with `paths=source_relative` it only supplies the import path and package name while the directory mirrors the input layout.

**Q: What does `paths=source_relative` change?**
A: It makes the plugin write output relative to the input file's path under `--go_out`, so `proto/inventory/v1/x.proto` becomes `gen/inventory/v1/x.pb.go`. The default, `paths=import`, instead treats the full `go_package` import path as a directory tree, which produces `gen/github.com/acme/svc/gen/inventory/v1/x.pb.go`. Source-relative is what almost everyone wants, because the output layout is predictable from the input layout.

**Q: Why must you embed `UnimplementedFooServer`?**
A: Because the generated server interface contains an unexported method, `mustEmbedUnimplementedFooServer()`, that only the generated package can supply — so the only way to satisfy the interface is to embed the provided struct. The purpose is forward compatibility: when a new RPC is added to the `.proto`, existing implementations still compile, and the new method returns `codes.Unimplemented` until someone implements it. Embed by value, not pointer, or a nil embed panics instead of returning that status.

**Q: What is `ServiceDesc` and who reads it?**
A: It is the generated dispatch table: service name, handler type, a list of unary `MethodDesc` entries and streaming `StreamDesc` entries each pointing at a generated handler wrapper, plus the source file name. `RegisterFooServer` passes it to `grpc.Server`, which uses it to map an incoming `:path` such as `/acme.inventory.v1.InventoryService/GetItem` to the right handler. It also records whether each method streams in either direction, which is how the transport knows the call shape.

**Q: Why does the same `.proto` generated into two Go packages crash the process?**
A: Every generated file registers its descriptor at `init()` into `protoregistry.GlobalFiles`, keyed by proto file path, and its messages into `GlobalTypes`, keyed by fully-qualified name. Two packages claiming the same key panic at startup with "file … is already registered", naming both packages. It happens when a `.proto` is copied into a second repository and generated there as well as consumed from the API module. The fix is to have exactly one generated copy per binary.

**Q: Why should you always use the generated getters?**
A: They are nil-safe: `GetSku()` on a nil `*Item` returns `""` rather than panicking, which makes chains like `resp.GetItem().GetSku()` safe even when an optional message is absent. Direct field access panics on a nil message, and nil messages arrive routinely — an unset embedded message, a partially populated response, a `nil` returned from a fake in a test. The rule is unconditional: getters everywhere.

**Q: Where should generated code live relative to the service?**
A: If one team owns both and there are no external consumers, a `gen/` directory in the service repository is simplest. Once a second repository consumes the API, move the `.proto` and generated code into a dedicated API module so consumers depend on generated code plus grpc and protobuf, rather than on your entire service and its dependency graph. In a monorepo, a single `proto/` tree with one codegen step is best, because cross-service schema changes become atomic.

**Q: (Senior) Design the proto and module layout for an organisation with 30 services and multiple repositories.**
A: I would create a dedicated schema module — `github.com/acme/apis` — with a `buf.yaml`, one directory per API at `acme/<domain>/v1/`, and generated Go published from the same repository so consumers `go get` a version rather than running codegen. Proto packages are always `acme.<domain>.v<major>`, so they are globally unique and versionable, and the directory mirrors the package exactly. CI on that repository runs `buf lint` and `buf breaking` against the previous release, so a breaking change cannot merge without an explicit override and a major-version bump. Services depend on tagged releases, which makes "who is on which schema version" answerable from `go.mod` files. The main alternative is a monorepo, which I would prefer if the organisation already had one, because it makes cross-service changes atomic; the dedicated module is the right answer when repositories are already separate and you cannot change that.

**Q: (Senior) A binary panics at startup with "file inventory/v1/inventory.proto is already registered". Diagnose and fix.**
A: The panic message names both registering packages, so the diagnosis is immediate: two Go packages generated from the same `.proto` file path are linked into one binary. In practice the cause is nearly always a vendored or copied `.proto` — someone needed the schema in a second repo, copied the file rather than depending on the API module, and generated it there too. I would confirm with `go mod graph` and by grepping the module cache for the file name, then delete the duplicate generation and repoint all imports at the single canonical package. The permanent prevention is organisational rather than technical: publish the schema as a module or `buf` module, make copying `.proto` files a lint failure, and prefix proto packages with the organisation so the collision surface is small. If the two copies had genuinely diverged, the fix is more painful — reconcile them first, because you cannot have two versions of the same file path in one binary regardless of what they contain.

**Q: (Senior) How do you handle a `.proto` from a third party that has no `go_package` or a wrong one?**
A: Use `M` flags on the `protoc` invocation: `--go_opt=Mthird_party/vendor/v1/vendor.proto=github.com/acme/svc/gen/vendorapi/v1` overrides the file's `go_package` externally, so you never modify the vendored file and can re-pull it cleanly. In `buf` the equivalent is the `override` entry under `managed_mode` in `buf.gen.yaml`, which is nicer because it is declarative and applies to whole directories. What I would avoid is editing the third-party file, because the next update silently reverts it, and forking it into your own tree, because that risks the duplicate-registration panic if the vendor later publishes generated code of their own.

## 10. Quick Revision & Cheat Sheet

```protobuf
// The two lines that decide everything:
package acme.inventory.v1;                                    // global wire namespace
option go_package = "github.com/acme/svc/gen/acme/inventory/v1;inventoryv1";
//                   ^ import path (must match where the file lands) ^ pkg name
```

```bash
protoc --proto_path=proto \
  --go_out=gen      --go_opt=paths=source_relative \
  --go-grpc_out=gen --go-grpc_opt=paths=source_relative \
  $(find proto -name '*.proto')
```

| Generated symbol | File | Purpose |
|---|---|---|
| `type Item struct` | `.pb.go` | Message; has `state`/`sizeCache`/`unknownFields` |
| `func (x *Item) GetSku()` | `.pb.go` | Nil-safe getter — always use these |
| `File_..._rawDesc` + `init()` | `.pb.go` | Registers into `protoregistry.GlobalFiles` |
| `Foo_Bar_FullMethodName` | `_grpc.pb.go` | The `:path` string, for interceptors |
| `FooClient` / `NewFooClient` | `_grpc.pb.go` | Client stub; takes `ClientConnInterface` |
| `FooServer` (+ `mustEmbed…`) | `_grpc.pb.go` | Server interface you implement |
| `UnimplementedFooServer` | `_grpc.pb.go` | Embed by value for forward compatibility |
| `RegisterFooServer` / `Foo_ServiceDesc` | `_grpc.pb.go` | Dispatch table wiring |

**Flash cards**
- **`go_package` format?** → `"import/path;packagename"`; the name part is optional.
- **Which `paths` option?** → `source_relative`, so output mirrors input.
- **Why embed `UnimplementedFooServer`?** → An unexported interface method forces it; it makes adding RPCs non-breaking. Embed by value.
- **Getter or field?** → Getter, always. Nil-safe.
- **Two packages, one `.proto` path?** → Panic at `init()`. Never copy `.proto` files between repos.
- **When to split into an API module?** → As soon as a second repository consumes the schema.

## 11. Hands-On Exercises & Mini Project

- [ ] Generate the same `.proto` with `paths=source_relative` and then with the default `paths=import`. Compare the resulting directory trees and explain the difference in one sentence.
- [ ] Open a generated `_grpc.pb.go` and find: the `FullMethodName` constants, the `mustEmbed` method, and the `ServiceDesc`. Trace how `RegisterFooServer` connects a `:path` to your handler.
- [ ] Remove the `UnimplementedFooServer` embed, add an RPC to the `.proto`, regenerate, and read the compile error. Restore the embed and confirm it now builds and returns `Unimplemented`.
- [ ] Deliberately reproduce the duplicate-registration panic by generating one `.proto` into two packages and importing both. Read the panic message carefully — you will see it again in production.
- [ ] Change `go_package` to a path that does not match the output directory. Confirm it compiles, then try to import it and watch the failure.
- [ ] Call a getter on an explicitly nil `*Item`, then access the field directly. Note which one panics.

### Mini Project — "API Module Extraction"

**Goal.** Take a service that owns its own `.proto` and extract the schema into a standalone, versioned API module that other repositories can consume — the migration nearly every growing system eventually needs.

**Requirements.**
1. Start from layout A: a service repo with `proto/` and `gen/` inside it, and at least two services' worth of `.proto` files.
2. Create a new module `github.com/acme/apis` containing only the `.proto` files, a `buf.yaml`, generation config, and generated Go. Its `go.mod` must depend on nothing but `grpc` and `protobuf`.
3. Update proto packages to `acme.<domain>.v1` and `go_package` to the new module, and verify the generated import paths match the physical layout.
4. Point the original service at the new module via `go get`, delete its local `gen/`, and prove the binary still runs and does not panic at `init()`.
5. Tag `v1.0.0` on the API module and add CI running `buf lint` plus `buf breaking` against the previous tag.
6. Add a second consumer repository that imports the API module, and confirm it pulls in only the two expected dependencies (`go mod graph | grep acme/apis`).

**Extensions.**
- Introduce `acme.inventory.v2` alongside `v1` in the same module and run both servers in one binary, proving that version-suffixed packages coexist.
- Publish the generated code for a second language from the same module and confirm the wire compatibility with a cross-language integration test.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Installing protoc, protoc-gen-go & protoc-gen-go-grpc* (getting the toolchain working), *Running protoc: source_relative Paths, Options & Stubs* (the flags in depth), *Buf: Modern Proto Builds* (declarative configuration and module dependencies), *Schema Evolution* (why the `v1` segment matters), *Build: The gRPC Server* (consuming `RegisterFooServer`).

- **Protocol Buffers — Go Generated Code Guide** — Google · *Intermediate* · the definitive description of every symbol `protoc-gen-go` emits, the `go_package` rules and the struct tag format. <https://protobuf.dev/reference/go/go-generated/>
- **protoc-gen-go-grpc — generated code reference** — gRPC Authors · *Intermediate* · what the gRPC plugin emits, including `ServiceDesc`, the `mustEmbed` mechanism and streaming interface types. <https://github.com/grpc/grpc-go/blob/master/cmd/protoc-gen-go-grpc/README.md>
- **Buf Style Guide** — Buf (open source) · *Intermediate* · the de-facto standard for proto package naming, directory layout and file organisation; `buf lint` enforces it. <https://buf.build/docs/best-practices/style-guide>
- **Google API Improvement Proposals (AIPs) — 191 File and directory structure** — Google · *Intermediate* · Google's own rules for proto packages, versioning segments and file placement across a very large API estate. <https://google.aip.dev/191>
- **protoregistry package documentation** — Go Protobuf Authors · *Advanced* · the global registry, what registers into it and why duplicate registration panics. <https://pkg.go.dev/google.golang.org/protobuf/reflect/protoregistry>
- **Standard Go Project Layout** — golang-standards (community) · *Beginner* · the `cmd/`, `internal/`, `pkg/` conventions this chapter's layout builds on, with the caveats about not over-applying it. <https://github.com/golang-standards/project-layout>
- **Go Modules Reference** — The Go Authors · *Intermediate* · module paths, versioning and the `replace`/`require` semantics that matter when extracting an API module. <https://go.dev/ref/mod>
- **grpc-go examples — directory structure** — gRPC Authors · *Beginner* · dozens of small projects showing the conventional placement of `.proto`, generated code and `main.go`. <https://github.com/grpc/grpc-go/tree/master/examples>

---

*gRPC with Go Handbook — chapter 07.*
