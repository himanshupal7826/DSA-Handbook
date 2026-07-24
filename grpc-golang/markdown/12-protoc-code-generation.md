# 12 · Running protoc: source_relative Paths, Options & Stubs

> **In one line:** The generation command is where `go_package`, `--proto_path`, `--go_out` and `paths=source_relative` must all agree — and the single most useful thing you can do is put that command in a `Makefile` or `buf.gen.yaml` on day one so nobody ever types it from memory again.

---

## 1. Overview

Chapter 6 installed the toolchain and chapter 7 explained where output lands. This chapter is the invocation itself: every flag that matters, what each plugin option does, how to script it reproducibly, and how to read the errors when it goes wrong.

The command looks simple and is not, because four things must be consistent simultaneously:

- **`--proto_path` (`-I`)** — the import roots. Every input file must live under one, and every `import` statement resolves against them.
- **`option go_package`** — the Go import path the generated package will declare.
- **`--go_out`** — the directory the output is written under.
- **`paths=source_relative`** — whether the path *within* that directory mirrors the input layout or is derived from `go_package`.

Get any pair out of alignment and you get output in an unexpected directory, or a package whose declared import path does not match where it sits, or `File does not reside within any path specified using --proto_path`. Every one of these is a five-minute fix and a forty-minute debug if you do not know the rules.

The chapter also covers the generated artefacts in more operational depth than chapter 7: descriptor sets (what you need for reflection-less tooling and for `buf breaking`-style comparison), the plugin option surface, and the several ways to make generation reproducible — a `Makefile`, a Go generator, a Docker image, or `buf`.

## 2. Core Concepts

- **`--proto_path` / `-I`** — an import root. Repeatable. Inputs must be under one; imports resolve against all of them in order.
- **`--<plugin>_out=DIR`** — invokes `protoc-gen-<plugin>` and writes its output under `DIR`.
- **`--<plugin>_opt=KEY=VALUE`** — passes an option to that plugin. Repeatable; also expressible as `--<plugin>_out=KEY=VALUE:DIR`.
- **`paths=source_relative`** — output path mirrors the input path under the out-directory.
- **`paths=import`** (default) — output path is the `go_package` import path, treated as a directory tree.
- **`module=PREFIX`** — strips `PREFIX` from the import path before using it as a directory. Alternative to `source_relative`.
- **`M<file>=<import path>`** — overrides `go_package` for one file from the command line, for third-party `.proto` you cannot edit.
- **`require_unimplemented_servers`** — `protoc-gen-go-grpc` option controlling whether the `mustEmbed` marker is generated. Default `true`; turning it off is almost always a mistake.
- **Descriptor set** — `--descriptor_set_out=FILE`, the serialised `FileDescriptorSet`. With `--include_imports` and `--include_source_info` it is fully self-contained.
- **`--decode` / `--encode`** — `protoc` can decode a binary payload to text and back, given the schema. Invaluable for debugging.
- **`//go:generate`** — a Go source directive letting `go generate ./...` drive codegen.

## 3. Theory & Principles

### The four things that must agree

Take a concrete project:

```
myservice/                         # module github.com/acme/myservice
├── proto/
│   └── acme/inventory/v1/inventory.proto
└── gen/
```

with `option go_package = "github.com/acme/myservice/gen/acme/inventory/v1;inventoryv1";`

| Flag | Value | Consequence |
|---|---|---|
| `--proto_path=proto` | Import root is `proto/` | The file's *canonical name* is `acme/inventory/v1/inventory.proto` |
| `--go_out=gen` | Output root is `gen/` | Everything is written under `gen/` |
| `--go_opt=paths=source_relative` | Mirror input layout | Output is `gen/acme/inventory/v1/inventory.pb.go` |
| `go_package` | `.../gen/acme/inventory/v1` | Package declares that import path — and it **matches** where the file landed ✓ |

Change `--proto_path` to `.` and the canonical name becomes `proto/acme/inventory/v1/inventory.proto`, so with `source_relative` the output moves to `gen/proto/acme/inventory/v1/` and no longer matches `go_package`. That is the most common misalignment.

The **canonical file name** is the key concept: it is the input path *relative to its `--proto_path` root*, and it is what appears in `import` statements, in the descriptor set, in the global registry (chapter 7), and in `source_relative` output paths. Two files with the same canonical name from different roots is an error; the same file reachable via two roots is also an error.

### `paths=source_relative` vs the alternatives

```
input:       proto/acme/inventory/v1/inventory.proto   (-I proto)
go_package:  github.com/acme/myservice/gen/acme/inventory/v1
--go_out:    gen
```

| Option | Output path |
|---|---|
| `paths=source_relative` | `gen/acme/inventory/v1/inventory.pb.go` ✓ |
| (default) `paths=import` | `gen/github.com/acme/myservice/gen/acme/inventory/v1/inventory.pb.go` |
| `module=github.com/acme/myservice` | `gen/gen/acme/inventory/v1/inventory.pb.go` |
| `module=github.com/acme/myservice/gen` + `--go_out=gen` | `gen/acme/inventory/v1/inventory.pb.go` ✓ |

`source_relative` and `module=` both reach the sane answer; `source_relative` is simpler because it needs no knowledge of the module path. Use it.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="pg1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">Canonical file name: the concept everything hinges on</text>

  <rect x="30" y="42" width="380" height="110" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="220" y="64" text-anchor="middle" fill="#3730a3" font-size="12" font-weight="bold">Disk path</text>
  <text x="46" y="90" fill="#4338ca" font-family="ui-monospace,monospace" font-size="11">proto/acme/inventory/v1/inventory.proto</text>
  <rect x="46" y="98" width="66" height="20" rx="4" fill="#c7d2fe" stroke="#4f46e5"/>
  <text x="79" y="113" text-anchor="middle" fill="#3730a3" font-size="9">-I root</text>
  <text x="130" y="113" fill="#4338ca" font-size="10">&#8592; stripped to form the canonical name</text>
  <text x="46" y="140" fill="#6366f1" font-size="10">--proto_path=proto</text>

  <path d="M412,96 L466,96" stroke="#0ea5e9" stroke-width="2" marker-end="url(#pg1)"/>

  <rect x="470" y="42" width="386" height="110" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="663" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Canonical name</text>
  <text x="486" y="90" fill="#14532d" font-family="ui-monospace,monospace" font-size="11">acme/inventory/v1/inventory.proto</text>
  <text x="486" y="112" fill="#166534" font-size="10">&#8226; what other files write in `import "&#8230;"`</text>
  <text x="486" y="128" fill="#166534" font-size="10">&#8226; the key in protoregistry.GlobalFiles</text>
  <text x="486" y="144" fill="#166534" font-size="10">&#8226; the path source_relative mirrors under --go_out</text>

  <rect x="30" y="172" width="826" height="112" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="443" y="194" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Aligned: all four agree &#10003;</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#14532d">
    <text x="50" y="218">--proto_path=proto        &#8594; canonical = acme/inventory/v1/inventory.proto</text>
    <text x="50" y="236">--go_out=gen              &#8594; output root = gen/</text>
    <text x="50" y="254">--go_opt=paths=source_relative &#8594; gen/acme/inventory/v1/inventory.pb.go</text>
    <text x="50" y="272">go_package = ".../gen/acme/inventory/v1"  &#8594; MATCHES where the file landed</text>
  </g>

  <rect x="30" y="300" width="826" height="128" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="443" y="322" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Misaligned: --proto_path=. instead of proto &#10007;</text>
  <g font-family="ui-monospace,monospace" font-size="10" fill="#7f1d1d">
    <text x="50" y="346">--proto_path=.            &#8594; canonical = proto/acme/inventory/v1/inventory.proto</text>
    <text x="50" y="364">--go_opt=paths=source_relative &#8594; gen/proto/acme/inventory/v1/inventory.pb.go</text>
    <text x="50" y="382">go_package still says ".../gen/acme/inventory/v1"  &#8594; DOES NOT MATCH</text>
  </g>
  <text x="50" y="406" fill="#991b1b">Result: the package compiles, but every import statement in the repo points at a directory that does not exist.</text>
  <text x="50" y="422" fill="#991b1b">Rule of thumb: --proto_path should point at the directory whose CHILDREN are your proto package roots.</text>
</svg>
```

### Plugin option reference

**`protoc-gen-go`**

| Option | Effect |
|---|---|
| `paths=source_relative` | Output mirrors the canonical name. **Use this.** |
| `paths=import` | Output path derived from `go_package` (default). |
| `module=PREFIX` | Strip `PREFIX` from the import path before using it as a directory. |
| `M<file>=<path>` | Override `go_package` for one file. |
| `default_api_level=API_OPAQUE` | Opt into the opaque API (protobuf-go v1.36+): accessors only, no exported fields. |

**`protoc-gen-go-grpc`**

| Option | Effect |
|---|---|
| `paths=source_relative` | As above. |
| `require_unimplemented_servers=true` | Generate the `mustEmbed` marker (default). Keep it. |
| `require_unimplemented_servers=false` | Omit it — allows implementing the interface without embedding, at the cost of forward compatibility. |
| `use_generic_streams_experimental=true` | Generic stream types (`grpc.ServerStreamingServer[T]`) instead of per-method interfaces. Default since v1.5. |

The one to think about is `require_unimplemented_servers`. Setting it to `false` is occasionally advocated because "the embed is boilerplate". It is not boilerplate: it is what makes adding an RPC to the `.proto` a non-breaking change for every existing implementation (chapter 7). Leave it on.

### Descriptor sets, and why you want one

`--descriptor_set_out` writes the compiled schema as a binary `FileDescriptorSet`. It is the input to:

- **Reflection-less tooling.** `grpcurl -protoset` calls a service without server-side reflection — useful when reflection is disabled in production.
- **Schema comparison.** Diffing two descriptor sets is how breaking-change detection works.
- **Dynamic decoding.** A log processor can decode arbitrary payloads given the descriptor set.
- **`grpc-gateway` and other downstream generators.**

```bash
protoc --proto_path=proto \
  --descriptor_set_out=build/inventory.protoset \
  --include_imports \        # embed google/protobuf/*.proto etc. -> self-contained
  --include_source_info \    # keep comments -> `grpcurl describe` shows docs
  $(find proto -name '*.proto')

grpcurl -protoset build/inventory.protoset -plaintext \
  -d '{"sku":"sku_1"}' localhost:50051 acme.inventory.v1.InventoryService/GetItem
```

## 4. Architecture & Workflow

**The generation pipeline**, and where each artefact goes:

1. **Discover inputs.** `find proto -name '*.proto'`, or let `buf` walk the module.
2. **Compile.** `protoc` resolves imports against `-I` roots into a descriptor set.
3. **Fan out to plugins.** Each `--x_out` runs `protoc-gen-x` with the descriptor set on stdin.
4. **Write output.** Files land under each plugin's out-directory per its `paths` option.
5. **Verify.** `go build ./...` catches a runtime-version mismatch that codegen itself will not.
6. **Gate in CI.** Regenerate and `git diff --exit-code`.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="cg1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">One compile, many plugins: the fan-out</text>

  <rect x="30" y="46" width="170" height="110" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="115" y="70" text-anchor="middle" fill="#3730a3" font-weight="bold">proto/**/*.proto</text>
  <text x="115" y="92" text-anchor="middle" fill="#4338ca" font-size="10">+ imports resolved</text>
  <text x="115" y="110" text-anchor="middle" fill="#4338ca" font-size="10">against -I roots</text>
  <text x="115" y="134" text-anchor="middle" fill="#6366f1" font-size="10">ONE parse, reused</text>
  <text x="115" y="150" text-anchor="middle" fill="#6366f1" font-size="10">by every plugin</text>

  <path d="M202,101 L252,101" stroke="#4f46e5" stroke-width="2" marker-end="url(#cg1)"/>

  <rect x="256" y="66" width="170" height="70" rx="10" fill="#e0e7ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="341" y="90" text-anchor="middle" fill="#3730a3" font-weight="bold">FileDescriptorSet</text>
  <text x="341" y="110" text-anchor="middle" fill="#4338ca" font-size="10">fully resolved schema</text>
  <text x="341" y="126" text-anchor="middle" fill="#4338ca" font-size="10">(the "image" buf compares)</text>

  <path d="M428,86 L490,68" stroke="#4f46e5" stroke-width="2" marker-end="url(#cg1)"/>
  <path d="M428,101 L490,118" stroke="#4f46e5" stroke-width="2" marker-end="url(#cg1)"/>
  <path d="M428,116 L490,168" stroke="#4f46e5" stroke-width="2" marker-end="url(#cg1)"/>
  <path d="M428,126 L490,218" stroke="#4f46e5" stroke-width="2" marker-end="url(#cg1)"/>

  <rect x="494" y="46" width="362" height="42" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="510" y="63" fill="#15803d" font-family="ui-monospace,monospace" font-size="10">--go_out=gen --go_opt=paths=source_relative</text>
  <text x="510" y="79" fill="#166534" font-size="10">&#8594; *.pb.go &#8212; message structs, getters, descriptors</text>

  <rect x="494" y="96" width="362" height="42" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="510" y="113" fill="#15803d" font-family="ui-monospace,monospace" font-size="10">--go-grpc_out=gen --go-grpc_opt=paths=source_relative</text>
  <text x="510" y="129" fill="#166534" font-size="10">&#8594; *_grpc.pb.go &#8212; client stub, server iface, ServiceDesc</text>

  <rect x="494" y="146" width="362" height="42" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="510" y="163" fill="#92400e" font-family="ui-monospace,monospace" font-size="10">--grpc-gateway_out=gen  (optional)</text>
  <text x="510" y="179" fill="#b45309" font-size="10">&#8594; *.pb.gw.go &#8212; the JSON/REST facade</text>

  <rect x="494" y="196" width="362" height="42" rx="8" fill="#ede9fe" stroke="#7c3aed" stroke-width="2"/>
  <text x="510" y="213" fill="#5b21b6" font-family="ui-monospace,monospace" font-size="10">--descriptor_set_out=build/x.protoset</text>
  <text x="510" y="229" fill="#6d28d9" font-size="10">&#8594; --include_imports --include_source_info &#8594; self-contained</text>

  <rect x="30" y="260" width="826" height="128" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="443" y="282" text-anchor="middle" fill="#334155" font-size="12" font-weight="bold">What a descriptor set unlocks</text>
  <text x="50" y="306" fill="#475569">&#8226; grpcurl -protoset x.protoset &#8594; call a service with reflection DISABLED in production</text>
  <text x="50" y="324" fill="#475569">&#8226; diff two sets &#8594; this is exactly how breaking-change detection works</text>
  <text x="50" y="342" fill="#475569">&#8226; dynamic decoding &#8594; a log processor can render arbitrary payloads without linking the types</text>
  <text x="50" y="360" fill="#475569">&#8226; --include_source_info keeps COMMENTS, so `grpcurl describe` shows your documentation</text>
  <text x="50" y="378" fill="#334155" font-weight="bold">Build one in CI and publish it as a release artefact alongside the generated code.</text>
</svg>
```

## 5. Implementation

### The canonical invocation

```bash
protoc \
  --proto_path=proto \
  --go_out=gen      --go_opt=paths=source_relative \
  --go-grpc_out=gen --go-grpc_opt=paths=source_relative \
  --go-grpc_opt=require_unimplemented_servers=true \
  $(find proto -name '*.proto')
```

Read it as: *"import root is `proto/`; write Go messages and gRPC stubs under `gen/`, mirroring the input layout; keep the forward-compatibility embed; compile every `.proto` under `proto/`."*

### A production `Makefile`

```makefile
# Makefile — the only supported way to regenerate code in this repository.

SHELL      := /bin/bash
PROTO_DIR  := proto
GEN_DIR    := gen
BUILD_DIR  := build
PROTO_FILES = $(shell find $(PROTO_DIR) -name '*.proto')

# Pinned versions. Bumping these is a reviewable one-line diff.
PROTOC_GEN_GO_VERSION      := v1.36.5
PROTOC_GEN_GO_GRPC_VERSION := v1.5.1
GRPC_GATEWAY_VERSION       := v2.24.0

# Third-party protos we import (google/api/annotations.proto, google/type/*).
# Vendored under third_party/ and added as a second import root.
THIRD_PARTY := third_party

.PHONY: tools
tools:
	go install google.golang.org/protobuf/cmd/protoc-gen-go@$(PROTOC_GEN_GO_VERSION)
	go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@$(PROTOC_GEN_GO_GRPC_VERSION)
	go install github.com/grpc-ecosystem/grpc-gateway/v2/protoc-gen-grpc-gateway@$(GRPC_GATEWAY_VERSION)

.PHONY: check-tools
check-tools:
	@command -v protoc >/dev/null || { echo "protoc not found — see README §setup"; exit 1; }
	@command -v protoc-gen-go >/dev/null || { \
	  echo "protoc-gen-go not on PATH — run 'make tools' and add \$$(go env GOPATH)/bin to PATH"; exit 1; }
	@command -v protoc-gen-go-grpc >/dev/null || { echo "protoc-gen-go-grpc missing — run 'make tools'"; exit 1; }

.PHONY: generate
generate: check-tools
	@mkdir -p $(GEN_DIR) $(BUILD_DIR)
	protoc \
	  --proto_path=$(PROTO_DIR) \
	  --proto_path=$(THIRD_PARTY) \
	  --go_out=$(GEN_DIR)      --go_opt=paths=source_relative \
	  --go-grpc_out=$(GEN_DIR) --go-grpc_opt=paths=source_relative \
	  --go-grpc_opt=require_unimplemented_servers=true \
	  --descriptor_set_out=$(BUILD_DIR)/schema.protoset \
	  --include_imports --include_source_info \
	  $(PROTO_FILES)
	@echo "generated $(words $(PROTO_FILES)) file(s) → $(GEN_DIR)/, descriptor set → $(BUILD_DIR)/schema.protoset"

.PHONY: verify-generate
verify-generate: generate
	@git diff --exit-code -- $(GEN_DIR) || { \
	  echo "ERROR: generated code is stale. Run 'make generate' and commit the result."; exit 1; }
	go build ./...

.PHONY: describe
describe: generate
	grpcurl -protoset $(BUILD_DIR)/schema.protoset describe acme.inventory.v1.InventoryService

.PHONY: clean
clean:
	rm -rf $(GEN_DIR) $(BUILD_DIR)
```

### Driving generation from Go

If you prefer `go generate ./...` to `make`:

```go
// gen.go — codegen entry point. Run with: go generate ./...
//
// Keeping the directive in Go source means contributors do not need make,
// and `go generate` is discoverable from the toolchain they already have.
package main

//go:generate protoc --proto_path=proto --proto_path=third_party
//go:generate   --go_out=gen --go_opt=paths=source_relative
//go:generate   --go-grpc_out=gen --go-grpc_opt=paths=source_relative
//go:generate   proto/acme/inventory/v1/inventory.proto
```

Note that each `//go:generate` line is a *separate command*; the multi-line form above is illustrative only. In practice, point the directive at a script:

```go
package main

//go:generate ./scripts/generate.sh
```

### The `buf` equivalent

Everything above collapses to two files (chapter 8):

```yaml
# buf.gen.yaml
version: v2
managed:
  enabled: true
  override:
    - file_option: go_package_prefix
      value: github.com/acme/myservice/gen
plugins:
  - remote: buf.build/protocolbuffers/go:v1.36.5
    out: gen
    opt: paths=source_relative
  - remote: buf.build/grpc/go:v1.5.1
    out: gen
    opt:
      - paths=source_relative
      - require_unimplemented_servers=true
inputs:
  - directory: proto
```

```bash
buf generate                                    # replaces the whole protoc command
buf build -o build/schema.protoset              # replaces --descriptor_set_out
```

### Debugging with `protoc` itself

```bash
# Decode a captured payload using the schema — no code required.
protoc --proto_path=proto --decode=acme.inventory.v1.Item \
  proto/acme/inventory/v1/inventory.proto < payload.bin

# Encode text format to binary, for crafting a test payload.
protoc --proto_path=proto --encode=acme.inventory.v1.Item \
  proto/acme/inventory/v1/inventory.proto <<'EOF' > payload.bin
sku: "sku_1"
quantity_on_hand: 42
EOF

# Render the descriptor set as readable JSON — what did the compiler actually see?
protoc --proto_path=proto --descriptor_set_out=/dev/stdout --include_imports \
  $(find proto -name '*.proto') \
  | protoc --decode=google.protobuf.FileDescriptorSet \
      $(brew --prefix)/include/google/protobuf/descriptor.proto

# Just check it compiles, producing nothing.
protoc --proto_path=proto -o /dev/null $(find proto -name '*.proto')
```

### Reading the errors

| Error | Cause | Fix |
|---|---|---|
| `protoc-gen-go: program not found or is not executable` | Plugin not on `PATH` | `export PATH="$PATH:$(go env GOPATH)/bin"` |
| `--go_out: protoc-gen-go: Plugin failed with status code 1` | Plugin ran and errored — **read the next line** | Usually a missing `option go_package` |
| `File does not reside within any path specified using --proto_path` | Input is outside every `-I` root | Add the correct `--proto_path` |
| `google/protobuf/timestamp.proto: File not found` | `protoc`'s `include/` missing | Reinstall `protoc` with `include/*` (chapter 6) |
| `google/api/annotations.proto: File not found` | googleapis not vendored | Vendor it, add a `-I`, or use a buf dependency |
| `Import "x.proto" was not found or had errors` | Import path wrong relative to `-I` roots | Check the canonical name, not the disk path |
| `x.proto: This file is already defined` | Same file reachable via two `-I` roots | Remove the duplicate root |
| Init panic about protobuf runtime version | `protoc-gen-go` newer than `google.golang.org/protobuf` | `go get google.golang.org/protobuf@latest` |

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of the raw `protoc` invocation**
- **Explicit.** Everything that ran is visible on one command line.
- **Universal.** Every plugin in the ecosystem works this way; nothing is special-cased.
- **No extra tooling.** `protoc` plus plugins is the whole dependency.

**Disadvantages**
- **Verbose and easy to get subtly wrong.** Four interacting settings, no validation that they agree.
- **No dependency resolution.** Third-party imports must be vendored and their roots added by hand.
- **Not reviewable.** A long shell line inside a `Makefile` gets a rubber-stamp in code review.
- **No linting or breaking-change detection.**

**Trade-offs**
- *`Makefile` vs `go:generate` vs `buf`:* `make` is conventional and handles multiple plugins cleanly; `go:generate` needs no extra tool but is awkward for multi-line commands; `buf` is declarative and adds lint and breaking checks. Prefer `buf` for new work, `make` for existing `protoc` projects.
- *Committing generated code vs generating in CI:* committing means consumers need no toolchain; generating keeps the tree clean. Committing plus a `verify-generate` gate is the usual compromise (chapter 6).
- *Descriptor set as a build artefact:* it costs a few hundred kilobytes and unlocks reflection-less tooling and schema diffing. Worth producing in CI regardless.

## 7. Common Mistakes & Best Practices

- **`--proto_path` pointing at the repository root** instead of the proto root, so canonical names gain a `proto/` prefix and `source_relative` output no longer matches `go_package`.
- **Omitting `paths=source_relative`** and getting a `github.com/` directory tree inside `gen/`.
- **Typing the command by hand.** Put it in a `Makefile` or `buf.gen.yaml` before it grows past three flags.
- **Setting `require_unimplemented_servers=false`.** You trade forward compatibility for removing one embedded field.
- **Forgetting `--include_imports` on a descriptor set.** The result is not self-contained and `grpcurl -protoset` fails on well-known types.
- **Forgetting `--include_source_info`.** Comments are dropped, so `describe` shows no documentation.
- **Adding a `-I` root that overlaps another**, making one file reachable twice → `This file is already defined`.
- **Not running `go build ./...` after generation.** A protobuf runtime mismatch is an init-time panic, not a codegen error.
- **No CI gate on generated-code freshness.** Someone will edit a `.proto` and forget to regenerate.
- **Mixing `protoc` and `buf generate`** in one repository — two sources of truth for options and plugin versions.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `protoc --decode` and `--encode` let you inspect and craft payloads with nothing but the schema — the fastest way to answer "is the client sending what I think?". `--descriptor_set_out=/dev/stdout | protoc --decode=google.protobuf.FileDescriptorSet` shows exactly what the compiler saw, including options you did not know were applied.
- **CI.** Produce and publish the descriptor set as a release artefact alongside the generated code. It lets operators call the service with `grpcurl -protoset` even when reflection is disabled, and it is the input to schema-diff tooling.
- **Security.** Plugins execute arbitrary code at build time with full filesystem access. Pin versions, verify `protoc` release checksums, and prefer a hermetic container or buf remote plugins over installing whatever `@latest` resolves to today. Never generate from `.proto` files fetched unpinned at build time.
- **Scaling.** With more than a handful of `.proto` files, per-file `protoc` invocations become the slow part of the build; compile them in one invocation (as the `Makefile` above does) so imports are parsed once. Beyond a few hundred files, `buf`'s parallel compiler is materially faster, and its dependency resolution removes the vendoring burden entirely.

## 9. Interview Questions

**Q: What does `paths=source_relative` do, and why is it the default choice?**
A: It makes the plugin write each output file at the input file's *canonical name* — its path relative to the `--proto_path` root — under the `--go_out` directory. So `proto/acme/inventory/v1/x.proto` with `-I proto` and `--go_out=gen` produces `gen/acme/inventory/v1/x.pb.go`. Without it, the default `paths=import` treats the full `go_package` import path as a directory tree and produces `gen/github.com/acme/…/x.pb.go`, which is why repositories sprout a stray `github.com/` folder. Source-relative is predictable and needs no knowledge of the module path.

**Q: What is a canonical file name and why does it matter?**
A: It is the input file's path relative to its `--proto_path` root — `acme/inventory/v1/inventory.proto`, not the disk path. It is what other files write in their `import` statements, what appears in the descriptor set, what keys the entry in `protoregistry.GlobalFiles`, and what `source_relative` mirrors under the output directory. Getting `--proto_path` wrong changes the canonical name, which silently changes the output location and breaks the alignment with `go_package`.

**Q: What must agree in a `protoc` invocation, and what happens when they do not?**
A: Four things: the `--proto_path` roots, the `option go_package` in each file, the `--go_out` directory, and the `paths` option. If `--proto_path` is wrong the canonical name gains or loses a prefix and output lands somewhere unexpected. If `go_package` does not match where the file lands, the package compiles but every import statement in the repository points at a non-existent directory. The rule of thumb is that `--proto_path` should point at the directory whose immediate children are your proto package roots.

**Q: What does `require_unimplemented_servers` control and should you turn it off?**
A: It controls whether `protoc-gen-go-grpc` generates the unexported `mustEmbedUnimplementedXxxServer()` method on the server interface, which forces implementations to embed `UnimplementedXxxServer`. It defaults to true and should stay that way: the embed is what makes adding a new RPC to the `.proto` a non-breaking change for every existing implementation, since the new method gets a default returning `codes.Unimplemented` rather than failing to compile. Turning it off buys you removing one embedded field and costs forward compatibility.

**Q: What is a descriptor set and what would you use it for?**
A: It is the serialised `FileDescriptorSet` — the fully-resolved compiled schema — written with `--descriptor_set_out`. With `--include_imports` it is self-contained and with `--include_source_info` it retains comments. Uses: calling a service with `grpcurl -protoset` when server reflection is disabled in production; diffing two versions, which is how breaking-change detection works; dynamically decoding payloads in a log processor without linking the types; and feeding downstream generators. It is worth producing in CI as a release artefact.

**Q: How do you handle a third-party `.proto` with a wrong or missing `go_package`?**
A: Use an `M` flag on the command line: `--go_opt=Mthird_party/vendor/v1/vendor.proto=github.com/acme/svc/gen/vendorapi/v1` overrides that file's `go_package` externally, so the vendored file is never modified and can be re-pulled cleanly. In `buf` the declarative equivalent is a managed-mode `override`, which is nicer because it can apply to whole directories. Editing the vendored file is worse, because the next update silently reverts it.

**Q: You get `Plugin failed with status code 1`. How do you diagnose it?**
A: That message means the plugin was found and executed and then returned an error, so the useful information is on the *next* line of output — people frequently paste only the first line and get stuck. The most common cause by far is a missing `option go_package`. It is a different failure from `program not found or is not executable`, which means `protoc` could not locate the plugin binary at all, almost always because `$(go env GOPATH)/bin` is not on `PATH`.

**Q: (Senior) Design a reproducible codegen pipeline for a repository with several plugins.**
A: One compile, many plugins, in a single `protoc` invocation so imports are parsed once — Go messages, gRPC stubs, grpc-gateway, and a descriptor set with `--include_imports --include_source_info`. All plugin versions pinned in a `Makefile` variable or `buf.gen.yaml` and installed by a `tools` target, with a `check-tools` target that fails with an actionable message rather than `protoc`'s cryptic one. The command lives in exactly one place; nobody types it. CI runs `make verify-generate`, which regenerates and fails on any diff, then `go build ./...` to catch a protobuf runtime mismatch that codegen alone will not surface. For a team that keeps hitting version skew I would go further and run generation inside a pinned container, or move to `buf` with remote plugins so no local toolchain exists to drift, and publish the descriptor set as a release artefact so operators can use `grpcurl -protoset` against production where reflection is disabled.

**Q: (Senior) Generation output differs between a developer's machine and CI. Walk through the diagnosis.**
A: I would first establish which component differs, by printing `protoc --version`, both plugin versions and `which -a` for each in both environments — in practice it is usually the plugin, because `protoc` comes from a package manager and the plugin from an ad-hoc `go install ...@latest` at some forgotten point in time. Second, compare the actual invocations, since a difference in `paths`, `require_unimplemented_servers` or the `-I` roots changes output materially and shell history is not a specification. Third, check the protobuf runtime version in `go.mod`, because a newer generator emits code requiring a newer runtime and the symptom there is an init panic rather than a codegen difference. The permanent fixes are pinning plugin versions as module dependencies so `go install tool` is reproducible, keeping the invocation in one committed file, and adding a CI gate that regenerates and diffs — and if it keeps recurring, moving generation into a container or to buf remote plugins, which removes the local install as a variable entirely.

**Q: (Senior) When would you produce a descriptor set in production, and what does it enable?**
A: I produce one in every CI build and publish it with the release, because it decouples tooling from the running service. Server reflection is convenient but is also a schema-disclosure surface, so many teams disable it on internet-facing or regulated services; with a published descriptor set, operators still get full `grpcurl` capability via `-protoset`, including method documentation if it was built with `--include_source_info`. It also makes schema diffing possible outside the repository — you can compare the deployed version's descriptor set against a candidate release, which is the mechanism underlying breaking-change detection. And it enables dynamic decoding in log and trace processors that must render payloads for many services without linking every generated package. The cost is a few hundred kilobytes per release and remembering `--include_imports`, without which the set is not self-contained and fails on well-known types.

## 10. Quick Revision & Cheat Sheet

```bash
# The canonical invocation
protoc \
  --proto_path=proto \
  --go_out=gen      --go_opt=paths=source_relative \
  --go-grpc_out=gen --go-grpc_opt=paths=source_relative \
  --go-grpc_opt=require_unimplemented_servers=true \
  $(find proto -name '*.proto')

# Self-contained descriptor set (for grpcurl -protoset, schema diffing)
protoc --proto_path=proto --descriptor_set_out=build/schema.protoset \
  --include_imports --include_source_info $(find proto -name '*.proto')

# Debug: decode / encode a payload with only the schema
protoc --proto_path=proto --decode=acme.inventory.v1.Item x.proto < payload.bin
protoc --proto_path=proto --encode=acme.inventory.v1.Item x.proto < payload.txt
```

| Flag | Meaning |
|---|---|
| `-I` / `--proto_path` | Import root; strips to form the canonical name |
| `--go_out=DIR` | Run `protoc-gen-go`, write under `DIR` |
| `--go_opt=paths=source_relative` | Output mirrors canonical name — **use this** |
| `--go_opt=module=PREFIX` | Strip `PREFIX` from the import path instead |
| `--go_opt=Mfile=path` | Override `go_package` for one file |
| `--go-grpc_opt=require_unimplemented_servers=true` | Keep the forward-compat embed (default) |
| `--descriptor_set_out=F` | Write the compiled schema |
| `--include_imports` | Make the descriptor set self-contained |
| `--include_source_info` | Keep comments in the descriptor set |
| `--decode=TYPE` / `--encode=TYPE` | Binary ↔ text using the schema |

**Flash cards**
- **Canonical name?** → Input path relative to its `-I` root. Everything keys off it.
- **`source_relative` vs `import`?** → Mirror the input layout vs build a tree from `go_package`.
- **`Plugin failed with status code 1`?** → Read the *next* line; usually a missing `go_package`.
- **`program not found`?** → `$(go env GOPATH)/bin` is not on `PATH`.
- **Descriptor set flags you always want?** → `--include_imports --include_source_info`.
- **The CI gate?** → Regenerate, `git diff --exit-code`, then `go build ./...`.

## 11. Hands-On Exercises & Mini Project

- [ ] Run the canonical invocation, then change `--proto_path` from `proto` to `.` and observe where output lands. Explain the difference using the canonical name.
- [ ] Generate once with `paths=source_relative` and once without. Compare the directory trees.
- [ ] Delete `option go_package` and read the full error output, including the second line. Then remove `$(go env GOPATH)/bin` from `PATH` and read that error. Learn to distinguish them instantly.
- [ ] Build a descriptor set with and without `--include_imports`, then try `grpcurl -protoset` with each against a service using `google.protobuf.Timestamp`.
- [ ] Use `protoc --encode` to craft a payload from text, then `--decode` it back and compare with `xxd`.
- [ ] Set `require_unimplemented_servers=false`, regenerate, add an RPC, and observe what breaks. Restore the default.

### Mini Project — "One-Command Codegen"

**Goal.** Make code generation a single, reproducible command that produces identical output everywhere, and prove it.

**Requirements.**
1. A repo with at least three `.proto` files across two packages, one importing a well-known type and one importing a vendored third-party file.
2. A `Makefile` with `tools`, `check-tools`, `generate`, `verify-generate`, `describe` and `clean` targets, where `check-tools` produces actionable messages.
3. A single `protoc` invocation running `protoc-gen-go`, `protoc-gen-go-grpc` and a descriptor set with `--include_imports --include_source_info`.
4. An `M` flag correctly overriding `go_package` for the vendored file, with the vendored file left unmodified.
5. A CI workflow running `make verify-generate` plus `go build ./... && go test ./...`, proven to fail when a `.proto` is edited without regenerating.
6. A parallel `buf.gen.yaml` producing byte-identical output, with a script that generates both ways and diffs.

**Extensions.**
- Add `protoc-gen-grpc-gateway` and `protoc-gen-openapiv2` and confirm they participate in the same single invocation.
- Publish the descriptor set as a CI artefact and use `grpcurl -protoset` against a running server with reflection disabled.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Installing protoc, protoc-gen-go & protoc-gen-go-grpc* (getting the binaries), *Go Module Layout & go_package* (where output should land and why), *Buf* (the declarative replacement for this command), *Build: The Complete Service .proto* (the schema being generated), *Reflection, grpcurl & Health Checks* (using descriptor sets in production).

- **Protocol Buffers — Go Generated Code Guide** — Google · *Intermediate* · the `go_package` rules, `paths` options, `M` flags and every symbol the plugin emits. <https://protobuf.dev/reference/go/go-generated/>
- **protoc-gen-go-grpc — README** — gRPC Authors · *Intermediate* · the gRPC plugin's option surface, including `require_unimplemented_servers` and generic streams. <https://github.com/grpc/grpc-go/blob/master/cmd/protoc-gen-go-grpc/README.md>
- **Protocol Buffers — protoc command-line reference** — Google · *Intermediate* · every `protoc` flag, including `--decode`, `--encode`, `--descriptor_set_out` and the include options. <https://protobuf.dev/reference/cpp/api-docs/google.protobuf.compiler.command_line_interface/>
- **gRPC — Go Quick Start** — grpc.io · *Beginner* · the canonical invocation, kept current with plugin releases. <https://grpc.io/docs/languages/go/quickstart/>
- **Buf — buf.gen.yaml reference** — Buf (open source) · *Intermediate* · the declarative equivalent of everything in this chapter, with managed mode and remote plugins. <https://buf.build/docs/configuration/v2/buf-gen-yaml>
- **grpcurl — README** — FullStory (open source) · *Beginner* · using `-protoset` and `-proto` to call services without server reflection. <https://github.com/fullstorydev/grpcurl>
- **Go Command Documentation — go generate** — The Go Authors · *Beginner* · the `//go:generate` directive and its limitations for multi-line commands. <https://go.dev/blog/generate>
- **grpc-gateway — generation setup** — grpc-ecosystem · *Intermediate* · adding a third plugin to the same invocation, and the extra import roots it needs. <https://grpc-ecosystem.github.io/grpc-gateway/docs/tutorials/generating_stubs/>

---

*gRPC with Go Handbook — chapter 12.*
