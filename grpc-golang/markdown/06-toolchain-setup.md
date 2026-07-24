# 06 · Installing protoc, protoc-gen-go & protoc-gen-go-grpc

> **In one line:** gRPC in Go needs three independently versioned binaries — the `protoc` compiler plus two Go plugins — all of which must be on your `PATH` and pinned in your repository, because "works on my machine" in codegen means a diff nobody can reproduce.

---

## 1. Overview

The gRPC Go toolchain has an unusual shape that trips up newcomers: **the compiler and the code generators are separate programs**. `protoc` parses `.proto` files into a descriptor set and then shells out to plugins named `protoc-gen-<name>` found on your `PATH`. When you pass `--go_out`, `protoc` looks for an executable called `protoc-gen-go`; when you pass `--go-grpc_out`, it looks for `protoc-gen-go-grpc`. Neither ships with `protoc`.

That means a working setup needs three things installed and three versions pinned:

1. **`protoc`** — the Protocol Buffers compiler, written in C++, distributed as a prebuilt binary by the protobuf project.
2. **`protoc-gen-go`** — generates message structs and serialisation code. Lives in `google.golang.org/protobuf/cmd/protoc-gen-go`.
3. **`protoc-gen-go-grpc`** — generates the service client and server stubs. Lives in `google.golang.org/grpc/cmd/protoc-gen-go-grpc`.

Plus two Go module dependencies at runtime: `google.golang.org/protobuf` (the runtime the generated code calls into) and `google.golang.org/grpc` (the framework itself).

There is a fourth option that eliminates most of this: **`buf`**, a single binary that replaces `protoc` entirely, manages plugin versions declaratively, and can even run plugins remotely so nothing is installed locally. Chapter 8 covers it. This chapter covers the classic toolchain because you will encounter it in every existing repository, and because understanding what `buf` replaces makes `buf` easier to reason about.

The recurring failure mode in real teams is **version skew**: developer A regenerates with `protoc-gen-go` v1.28, developer B with v1.36, and the diff is 4,000 lines of noise in generated files nobody reviews. The whole of §5 is about preventing that.

## 2. Core Concepts

- **`protoc`** — the compiler. Parses `.proto`, resolves imports, builds a `FileDescriptorSet`, and invokes plugins via a well-defined stdin/stdout protocol.
- **Plugin** — any executable named `protoc-gen-<name>` on the `PATH`. `--<name>_out` triggers it; `--<name>_opt` passes it options.
- **`--proto_path` / `-I`** — the import search path. Every `.proto` you compile must be *under* a `-I` root, and imports resolve relative to these roots.
- **Well-known types** — `google/protobuf/timestamp.proto` and friends, bundled with `protoc` in its `include/` directory. This is why `protoc` must be installed as a directory, not just a bare binary.
- **`go_package`** — a file-level option in the `.proto` giving the Go import path (and optionally package name) for generated code. Required by `protoc-gen-go`.
- **`paths=source_relative`** — the plugin option that writes output next to the input file, rather than into a directory tree derived from `go_package`. Almost always what you want (chapter 12).
- **`tools.go`** — the conventional Go file that imports plugin packages with a build tag, so `go.mod` records their versions and `go install` reproduces them exactly.
- **Go tool directives** (Go 1.24+) — `go get -tool` and the `tool` directive in `go.mod`, the modern replacement for the `tools.go` pattern.
- **`buf`** — an alternative build system that replaces `protoc`, with declarative configuration, linting, breaking-change detection and remote plugins.

## 3. Theory & Principles

### How `protoc` and plugins actually communicate

Understanding this makes every error message legible:

1. You run `protoc -I proto --go_out=. proto/foo.proto`.
2. `protoc` parses `foo.proto` and all its imports into a `FileDescriptorSet` — a fully-resolved, self-contained description of every message, field and service.
3. `protoc` sees `--go_out` and searches `PATH` for an executable named exactly `protoc-gen-go`.
4. It runs that executable, writing a serialised `CodeGeneratorRequest` (containing the descriptor set plus any `--go_opt` parameters) to the plugin's **stdin**.
5. The plugin writes a serialised `CodeGeneratorResponse` — a list of filenames and contents — to its **stdout**.
6. `protoc` writes those files relative to the `--go_out` directory.

So the two classic errors decode as:
- **`protoc-gen-go: program not found or is not executable`** → the plugin is not on `PATH`. Almost always because `$(go env GOPATH)/bin` is missing from `PATH`.
- **`--go_out: protoc-gen-go: Plugin failed with status code 1`** → the plugin ran but errored; the real message is usually on the next line (commonly a missing `go_package` option).

### Version compatibility

The three components version independently, and the rules are:

- **`protoc` and the plugins** are loosely coupled. Any reasonably recent `protoc` (≥ 3.15, which re-enabled `optional` in proto3) works with any recent plugin. Prefer the latest.
- **`protoc-gen-go` and the `google.golang.org/protobuf` runtime** are tightly coupled. Generated code declares a minimum runtime version and panics at init if the runtime is older. Keep the plugin version and the module version in step.
- **`protoc-gen-go-grpc` and `google.golang.org/grpc`** are loosely coupled but the generator has had meaningful changes (notably v1.3's `require_unimplemented_servers` default, and v1.5's move of the generated constants). Pin it.

The versioning schemes differ, which confuses people: `protoc` uses `v3.x`/`v2x.x` (the 2023 renumbering made `3.21` become `21.x`, then `v2x.x`), `protoc-gen-go` follows `google.golang.org/protobuf` at `v1.3x.x`, and `protoc-gen-go-grpc` is at `v1.x.x` independently of `grpc-go` itself.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="t1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
    <marker id="t2" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#16a34a"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">protoc invokes plugins over stdin/stdout</text>

  <rect x="30" y="46" width="160" height="70" rx="10" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="110" y="70" text-anchor="middle" fill="#3730a3" font-weight="bold">foo.proto</text>
  <text x="110" y="90" text-anchor="middle" fill="#4338ca" font-size="10">+ imported files</text>
  <text x="110" y="106" text-anchor="middle" fill="#4338ca" font-size="10">resolved via -I paths</text>

  <path d="M192,81 L266,81" stroke="#4f46e5" stroke-width="2" marker-end="url(#t1)"/>

  <rect x="270" y="46" width="180" height="70" rx="10" fill="#e0e7ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="360" y="70" text-anchor="middle" fill="#3730a3" font-weight="bold">protoc</text>
  <text x="360" y="90" text-anchor="middle" fill="#4338ca" font-size="10">parse + resolve imports</text>
  <text x="360" y="106" text-anchor="middle" fill="#4338ca" font-size="10">&#8594; FileDescriptorSet</text>

  <path d="M452,66 L560,66" stroke="#4f46e5" stroke-width="2" marker-end="url(#t1)"/>
  <text x="506" y="58" text-anchor="middle" fill="#4338ca" font-size="10">stdin</text>
  <path d="M452,100 L560,100" stroke="#4f46e5" stroke-width="2" marker-end="url(#t1)"/>
  <text x="506" y="118" text-anchor="middle" fill="#4338ca" font-size="10">stdin</text>

  <rect x="564" y="42" width="290" height="46" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="709" y="60" text-anchor="middle" fill="#15803d" font-weight="bold">protoc-gen-go</text>
  <text x="709" y="78" text-anchor="middle" fill="#166534" font-size="10">found on PATH because --go_out was passed</text>

  <rect x="564" y="94" width="290" height="46" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="709" y="112" text-anchor="middle" fill="#15803d" font-weight="bold">protoc-gen-go-grpc</text>
  <text x="709" y="130" text-anchor="middle" fill="#166534" font-size="10">found on PATH because --go-grpc_out was passed</text>

  <path d="M709,142 L709,180" stroke="#16a34a" stroke-width="2" marker-end="url(#t2)"/>
  <text x="770" y="166" fill="#166534" font-size="10">stdout</text>

  <rect x="500" y="184" width="354" height="70" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="677" y="206" text-anchor="middle" fill="#15803d" font-weight="bold">CodeGeneratorResponse</text>
  <text x="677" y="226" text-anchor="middle" fill="#166534" font-size="10">foo.pb.go &#8212; message structs, getters, descriptors</text>
  <text x="677" y="244" text-anchor="middle" fill="#166534" font-size="10">foo_grpc.pb.go &#8212; client stub, server interface, Register</text>

  <rect x="30" y="278" width="824" height="106" rx="10" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="442" y="300" text-anchor="middle" fill="#b91c1c" font-size="12" font-weight="bold">Decoding the two classic errors</text>
  <text x="50" y="324" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">protoc-gen-go: program not found or is not executable</text>
  <text x="50" y="340" fill="#991b1b">&#8594; step 3 failed: the plugin is not on PATH. Add $(go env GOPATH)/bin.</text>
  <text x="50" y="360" fill="#7f1d1d" font-family="ui-monospace,monospace" font-size="10">--go_out: protoc-gen-go: Plugin failed with status code 1</text>
  <text x="50" y="376" fill="#991b1b">&#8594; step 5 failed: the plugin ran and errored. The real message is the NEXT line &#8212; usually a missing go_package.</text>
</svg>
```

### Why version pinning is not optional

Generated code is checked into most repositories, or built in CI. Either way, if two machines produce different output from the same input, you get:
- Spurious diffs of thousands of lines in `*.pb.go` that hide real changes in review.
- Merge conflicts in generated files, which are miserable to resolve.
- Runtime panics when generated code requires a newer `google.golang.org/protobuf` than `go.mod` provides.

The fix is to make plugin versions a **module dependency**, so `go.sum` pins them and `go install` reproduces them byte-identically. That is what `tools.go` (pre-Go 1.24) and the `tool` directive (Go 1.24+) accomplish.

## 4. Architecture & Workflow

The setup you are aiming for, in order:

1. **Install `protoc`** system-wide (Homebrew, apt, or the release zip). It brings its `include/` directory of well-known types with it.
2. **Pin the plugins in `go.mod`** via the `tool` directive or `tools.go`, so their versions live in version control.
3. **Install the plugins** into `$(go env GOPATH)/bin` with `go install`, and ensure that directory is on `PATH`.
4. **Add the runtime dependencies** — `google.golang.org/grpc` and `google.golang.org/protobuf` — to `go.mod`.
5. **Write a `Makefile` target** (or `buf generate`) so nobody types a raw `protoc` command from memory.
6. **Verify in CI** that regenerating produces no diff — this is the check that actually enforces everything above.

```svg
<svg viewBox="0 0 880 320" width="100%" height="320" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="u1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">What lives where, and what pins what</text>

  <rect x="30" y="42" width="250" height="130" rx="10" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="155" y="64" text-anchor="middle" fill="#92400e" font-size="12" font-weight="bold">System-wide</text>
  <text x="46" y="88" fill="#b45309" font-family="ui-monospace,monospace" font-size="10">/opt/homebrew/bin/protoc</text>
  <text x="46" y="106" fill="#b45309" font-family="ui-monospace,monospace" font-size="10">/opt/homebrew/include/google/</text>
  <text x="46" y="122" fill="#b45309" font-family="ui-monospace,monospace" font-size="10">    protobuf/timestamp.proto &#8230;</text>
  <text x="46" y="146" fill="#92400e" font-size="10">pinned by: your package manager</text>
  <text x="46" y="162" fill="#92400e" font-size="10">(or a pinned release zip in CI)</text>

  <rect x="308" y="42" width="250" height="130" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="433" y="64" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">$(go env GOPATH)/bin</text>
  <text x="324" y="88" fill="#166534" font-family="ui-monospace,monospace" font-size="10">protoc-gen-go</text>
  <text x="324" y="106" fill="#166534" font-family="ui-monospace,monospace" font-size="10">protoc-gen-go-grpc</text>
  <text x="324" y="124" fill="#166534" font-family="ui-monospace,monospace" font-size="10">protoc-gen-grpc-gateway (opt.)</text>
  <text x="324" y="148" fill="#15803d" font-size="10">pinned by: go.mod tool directive</text>
  <text x="324" y="164" fill="#15803d" font-size="10">MUST be on PATH</text>

  <rect x="586" y="42" width="268" height="130" rx="10" fill="#e0e7ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="720" y="64" text-anchor="middle" fill="#3730a3" font-size="12" font-weight="bold">go.mod (runtime)</text>
  <text x="602" y="88" fill="#4338ca" font-family="ui-monospace,monospace" font-size="10">google.golang.org/grpc</text>
  <text x="602" y="106" fill="#4338ca" font-family="ui-monospace,monospace" font-size="10">google.golang.org/protobuf</text>
  <text x="602" y="130" fill="#3730a3" font-size="10">generated code calls into these</text>
  <text x="602" y="148" fill="#3730a3" font-size="10">protobuf runtime version MUST be</text>
  <text x="602" y="164" fill="#3730a3" font-size="10">&#8805; the version protoc-gen-go emitted for</text>

  <path d="M433,176 L433,206" stroke="#0ea5e9" stroke-width="2" marker-end="url(#u1)"/>
  <rect x="200" y="210" width="480" height="44" rx="8" fill="#eff6ff" stroke="#0ea5e9" stroke-width="2"/>
  <text x="440" y="228" text-anchor="middle" fill="#0369a1" font-family="ui-monospace,monospace" font-size="11">make generate  &#8594;  protoc &#8230; --go_out &#8230; --go-grpc_out &#8230;</text>
  <text x="440" y="246" text-anchor="middle" fill="#0c4a6e" font-size="10">nobody types a raw protoc command from memory</text>

  <rect x="200" y="266" width="480" height="44" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="284" text-anchor="middle" fill="#15803d" font-family="ui-monospace,monospace" font-size="11">CI: make generate &amp;&amp; git diff --exit-code</text>
  <text x="440" y="302" text-anchor="middle" fill="#166534" font-size="10">the check that actually enforces every pin above</text>
</svg>
```

## 5. Implementation

### Step 1 — install `protoc`

**macOS (Homebrew)**

```bash
brew install protobuf
protoc --version            # libprotoc 29.x
which protoc                # /opt/homebrew/bin/protoc
ls $(brew --prefix)/include/google/protobuf/timestamp.proto   # well-known types present
```

**Linux (Debian/Ubuntu) — prefer the official release over `apt`**

The distro package is often years old. Install the release zip:

```bash
PROTOC_VERSION=29.3
curl -LO "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-x86_64.zip"
sudo unzip -o "protoc-${PROTOC_VERSION}-linux-x86_64.zip" -d /usr/local bin/protoc
sudo unzip -o "protoc-${PROTOC_VERSION}-linux-x86_64.zip" -d /usr/local 'include/*'
sudo chmod +x /usr/local/bin/protoc
rm "protoc-${PROTOC_VERSION}-linux-x86_64.zip"
protoc --version
```

For ARM, substitute `linux-aarch_64`. The `include/*` extraction is not optional — that is where the well-known types live, and omitting it produces `google/protobuf/timestamp.proto: File not found`.

**Linux (Fedora/RHEL)**

```bash
sudo dnf install -y protobuf-compiler protobuf-devel
protoc --version
```

**Windows (PowerShell)**

Using `winget` or Chocolatey:

```powershell
winget install protobuf
# or
choco install protoc
protoc --version
```

Manual install, which gives you version control:

```powershell
$ver = "29.3"
Invoke-WebRequest -Uri "https://github.com/protocolbuffers/protobuf/releases/download/v$ver/protoc-$ver-win64.zip" -OutFile protoc.zip
Expand-Archive protoc.zip -DestinationPath "$env:USERPROFILE\protoc" -Force
# Add to PATH for the current user (restart the shell afterwards):
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path", "User") + ";$env:USERPROFILE\protoc\bin",
  "User")
protoc --version
```

### Step 2 — pin and install the Go plugins

**Go 1.24 and later — the `tool` directive (preferred).** No `tools.go` file needed:

```bash
go get -tool google.golang.org/protobuf/cmd/protoc-gen-go@latest
go get -tool google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
```

This adds a `tool` block to `go.mod`:

```
tool (
	google.golang.org/grpc/cmd/protoc-gen-go-grpc
	google.golang.org/protobuf/cmd/protoc-gen-go
)
```

Then install them into `GOPATH/bin`:

```bash
go install tool     # installs every tool listed in go.mod
```

**Go 1.23 and earlier — the `tools.go` pattern.** Create `tools/tools.go`:

```go
//go:build tools

// Package tools pins the versions of code-generation binaries used by this
// module. The build tag means this file is never compiled into any binary; it
// exists so `go mod tidy` records these dependencies in go.mod/go.sum, making
// `go install` reproducible on every machine and in CI.
package tools

import (
	_ "google.golang.org/grpc/cmd/protoc-gen-go-grpc"
	_ "google.golang.org/protobuf/cmd/protoc-gen-go"
)
```

```bash
go mod tidy
go install google.golang.org/protobuf/cmd/protoc-gen-go
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc
```

**Ad-hoc install (fine for a scratch project, wrong for a team):**

```bash
go install google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.5
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.5.1
```

### Step 3 — put `GOPATH/bin` on `PATH`

This is the step people skip, and it produces `program not found or is not executable`.

```bash
# bash/zsh — add to ~/.zshrc or ~/.bashrc, then restart the shell
export PATH="$PATH:$(go env GOPATH)/bin"

# verify
which protoc-gen-go protoc-gen-go-grpc
protoc-gen-go --version        # protoc-gen-go v1.36.5
protoc-gen-go-grpc --version   # protoc-gen-go-grpc 1.5.1
```

```powershell
# Windows
[Environment]::SetEnvironmentVariable(
  "Path",
  [Environment]::GetEnvironmentVariable("Path","User") + ";$(go env GOPATH)\bin",
  "User")
```

### Step 4 — the runtime dependencies

```bash
go get google.golang.org/grpc@latest
go get google.golang.org/protobuf@latest

# Frequently also wanted:
go get google.golang.org/genproto/googleapis/rpc/errdetails   # rich error details (ch. 22)
go get github.com/grpc-ecosystem/go-grpc-middleware/v2@latest # interceptor helpers (ch. 23)
```

### Step 5 — a `Makefile` so nobody memorises `protoc` flags

```makefile
# Makefile — the only supported way to regenerate protobuf code in this repo.

SHELL := /bin/bash
PROTO_DIR := proto
GEN_DIR   := gen
PROTO_FILES := $(shell find $(PROTO_DIR) -name '*.proto')

# Pinned plugin versions. Bumping these is a reviewable, single-line diff.
PROTOC_GEN_GO_VERSION      := v1.36.5
PROTOC_GEN_GO_GRPC_VERSION := v1.5.1

.PHONY: tools
tools: ## Install pinned codegen plugins into $(go env GOPATH)/bin
	go install google.golang.org/protobuf/cmd/protoc-gen-go@$(PROTOC_GEN_GO_VERSION)
	go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@$(PROTOC_GEN_GO_GRPC_VERSION)

.PHONY: check-tools
check-tools: ## Fail early with a useful message instead of protoc's cryptic one
	@command -v protoc >/dev/null || { echo "protoc not found — see README §setup"; exit 1; }
	@command -v protoc-gen-go >/dev/null || { echo "protoc-gen-go not on PATH — run 'make tools' and add \$$(go env GOPATH)/bin to PATH"; exit 1; }
	@command -v protoc-gen-go-grpc >/dev/null || { echo "protoc-gen-go-grpc not on PATH — run 'make tools'"; exit 1; }

.PHONY: generate
generate: check-tools ## Regenerate all Go code from .proto files
	@mkdir -p $(GEN_DIR)
	protoc \
	  --proto_path=$(PROTO_DIR) \
	  --go_out=$(GEN_DIR)      --go_opt=paths=source_relative \
	  --go-grpc_out=$(GEN_DIR) --go-grpc_opt=paths=source_relative \
	  --go-grpc_opt=require_unimplemented_servers=true \
	  $(PROTO_FILES)
	@echo "generated $(words $(PROTO_FILES)) proto file(s) into $(GEN_DIR)/"

.PHONY: verify-generate
verify-generate: generate ## CI gate: regenerating must produce no diff
	@git diff --exit-code -- $(GEN_DIR) || { \
	  echo "ERROR: generated code is out of date. Run 'make generate' and commit."; exit 1; }

.PHONY: clean
clean:
	rm -rf $(GEN_DIR)
```

### Step 6 — verify the whole chain

```bash
make tools
make generate
go build ./...
```

A one-file smoke test that proves every piece works:

```bash
mkdir -p proto/ping/v1 && cat > proto/ping/v1/ping.proto <<'EOF'
syntax = "proto3";
package ping.v1;
option go_package = "github.com/example/app/gen/ping/v1;pingv1";

import "google/protobuf/timestamp.proto";   // proves protoc's include/ is present

service PingService {
  rpc Ping(PingRequest) returns (PingResponse);
}
message PingRequest  { string message = 1; }
message PingResponse {
  string message = 1;
  google.protobuf.Timestamp served_at = 2;
}
EOF

make generate && ls gen/ping/v1/
# ping.pb.go  ping_grpc.pb.go
```

If `ping.pb.go` exists, `protoc` and `protoc-gen-go` work. If `ping_grpc.pb.go` exists, `protoc-gen-go-grpc` works. If the `Timestamp` import resolved, the well-known types are installed correctly.

### Docker: a hermetic toolchain

The most reliable way to eliminate machine differences entirely:

```dockerfile
# Dockerfile.protoc — hermetic codegen, identical on every machine and in CI.
FROM golang:1.24-bookworm

ARG PROTOC_VERSION=29.3
ARG PROTOC_GEN_GO_VERSION=v1.36.5
ARG PROTOC_GEN_GO_GRPC_VERSION=v1.5.1

RUN apt-get update && apt-get install -y --no-install-recommends unzip \
 && rm -rf /var/lib/apt/lists/*

RUN curl -sSLO "https://github.com/protocolbuffers/protobuf/releases/download/v${PROTOC_VERSION}/protoc-${PROTOC_VERSION}-linux-x86_64.zip" \
 && unzip -o "protoc-${PROTOC_VERSION}-linux-x86_64.zip" -d /usr/local bin/protoc 'include/*' \
 && chmod +x /usr/local/bin/protoc \
 && rm "protoc-${PROTOC_VERSION}-linux-x86_64.zip"

RUN go install google.golang.org/protobuf/cmd/protoc-gen-go@${PROTOC_GEN_GO_VERSION} \
 && go install google.golang.org/grpc/cmd/protoc-gen-go-grpc@${PROTOC_GEN_GO_GRPC_VERSION}

ENV PATH="/go/bin:${PATH}"
WORKDIR /work
ENTRYPOINT ["make", "generate"]
```

```bash
docker build -f Dockerfile.protoc -t app-protoc .
docker run --rm -v "$PWD":/work app-protoc
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages of the classic `protoc` toolchain**
- **Universal.** Every gRPC tutorial, every existing repository and every plugin in the ecosystem assumes it.
- **Transparent.** One command line, no hidden configuration; what you passed is exactly what ran.
- **Plugin-agnostic.** Any `protoc-gen-*` binary works, including ones you write yourself.

**Disadvantages**
- **Three-part installation** with three version schemes and a `PATH` requirement.
- **Verbose, error-prone invocations.** Real projects end up with 15-line `protoc` commands nobody understands.
- **No dependency management for imported `.proto` files.** Depending on `googleapis` means vendoring files or juggling `-I` paths by hand.
- **No linting or breaking-change detection.** Both are essential and both must be bolted on.

**Trade-offs**
- *`protoc` vs `buf`:* `buf` removes almost all of this friction (chapter 8), but adds a tool your team must learn and a config format to maintain. For a new project, start with `buf`. For an existing one, understand `protoc` first.
- *Committing generated code vs generating in CI:* committing means consumers need no toolchain and builds are fast, but produces large diffs and merge conflicts. Generating in CI keeps the tree clean but makes the toolchain a hard build dependency for everyone. Committing plus a `verify-generate` CI gate is the most common compromise.
- *System `protoc` vs Docker:* system install is faster to iterate with; Docker guarantees reproducibility. Many teams use both — local for speed, Docker in CI for the authoritative result.

## 7. Common Mistakes & Best Practices

- **`$(go env GOPATH)/bin` not on `PATH`.** The single most common setup failure. `go install` succeeded; `protoc` just cannot find the result.
- **Installing only the `protoc` binary and not `include/`.** Then `import "google/protobuf/timestamp.proto"` fails with `File not found`. Extract `include/*` too.
- **Using the distro's `protobuf-compiler` package.** Often several major versions behind, sometimes predating proto3 `optional`. Use the official release.
- **Not pinning plugin versions.** Two developers produce different generated output and the diff is unreviewable. Pin in `go.mod`.
- **Missing `option go_package`.** Produces the confusing `Plugin failed with status code 1`; the actual explanation is on the following line.
- **Compiling a `.proto` that is not under a `-I` root.** `protoc` insists that every input file be reachable from a `--proto_path`; the error mentions "not found or has errors" or complains about a duplicate file.
- **Typing `protoc` commands by hand.** Put them in a `Makefile` or `buf.gen.yaml` on day one, before the flags multiply.
- **No CI check that generated code is current.** Without `verify-generate`, someone will eventually edit a `.proto` and forget to regenerate.
- **Editing generated files.** They are overwritten. Add behaviour in a separate file in the same package, or via a wrapper type.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `protoc --version`, `protoc-gen-go --version` and `which -a protoc-gen-go` answer 90% of setup questions. When a generated file surprises you, run `protoc --descriptor_set_out=/dev/stdout ... | protoc --decode=google.protobuf.FileDescriptorSet ...` to see exactly what `protoc` handed the plugin.
- **CI.** Run `make verify-generate` on every pull request. Also run `go build ./...` after generation — a stale `google.golang.org/protobuf` produces an init-time panic that only surfaces at runtime otherwise.
- **Security.** `protoc` releases and plugins are build-time dependencies with full filesystem access during codegen. Pin exact versions, verify release checksums (the protobuf project publishes `sha256`), and prefer a hermetic Docker image or `buf`'s remote plugins over `curl | sh`.
- **Scaling to many repositories.** Once more than one repository consumes your `.proto` files, hand-managed `-I` paths stop working. Move to `buf` with a module registry, or publish generated code as a versioned Go module that consumers import.

## 9. Interview Questions

**Q: What three binaries does a Go gRPC project need, and what does each do?**
A: `protoc`, the Protocol Buffers compiler, which parses `.proto` files and resolves imports into a descriptor set; `protoc-gen-go`, which generates the message structs and serialisation code; and `protoc-gen-go-grpc`, which generates the client stub and server interface. The two plugins are separate executables that `protoc` finds on `PATH` by name — neither ships with `protoc`. On top of those you need the `google.golang.org/protobuf` and `google.golang.org/grpc` modules at runtime.

**Q: How does `protoc` invoke a plugin?**
A: When you pass `--go_out`, `protoc` searches `PATH` for an executable named exactly `protoc-gen-go`, runs it, and writes a serialised `CodeGeneratorRequest` — containing the fully-resolved descriptor set and any `--go_opt` parameters — to the plugin's stdin. The plugin writes a serialised `CodeGeneratorResponse` listing filenames and contents to stdout, and `protoc` writes those files relative to the `--go_out` directory. That protocol is why you can write your own generator in any language.

**Q: You get `protoc-gen-go: program not found or is not executable`. What is wrong?**
A: The plugin is not on `PATH`. Almost always `go install` put it in `$(go env GOPATH)/bin` and that directory is not exported. The fix is `export PATH="$PATH:$(go env GOPATH)/bin"` in the shell profile, then verify with `which protoc-gen-go`. It is distinct from `Plugin failed with status code 1`, which means the plugin *was* found, ran, and errored — usually because a `.proto` file is missing `option go_package`.

**Q: Why must you extract `include/` when installing `protoc` from a release zip?**
A: Because the well-known types — `google/protobuf/timestamp.proto`, `duration.proto`, `any.proto`, `empty.proto`, `field_mask.proto` and the rest — live there, and `protoc` adds that directory to its default import path. If you extract only `bin/protoc`, any `.proto` importing a well-known type fails with `File not found`. This is why installing `protoc` means installing a directory tree, not a single binary.

**Q: How do you pin codegen tool versions in a Go project?**
A: On Go 1.24 and later, `go get -tool google.golang.org/protobuf/cmd/protoc-gen-go@latest` adds a `tool` directive to `go.mod`, and `go install tool` installs everything listed. Before Go 1.24, the equivalent is a `tools.go` file with a `//go:build tools` tag that blank-imports the plugin packages, so `go mod tidy` records them in `go.mod` and `go.sum`. Either way the versions are in version control, which is what makes generated output reproducible across machines.

**Q: Should generated `.pb.go` files be committed?**
A: Both choices are defensible. Committing means consumers need no toolchain and builds are fast, at the cost of large diffs and painful merge conflicts. Generating in CI keeps the tree clean but makes `protoc` a hard build dependency for everyone including downstream consumers. The common compromise is to commit *and* add a CI job that regenerates and runs `git diff --exit-code`, which catches the case where someone edits a `.proto` and forgets to regenerate.

**Q: What is the compatibility relationship between `protoc-gen-go` and the protobuf runtime?**
A: They are tightly coupled. Generated code embeds a minimum required runtime version and the `protoimpl` package panics at init if `google.golang.org/protobuf` in `go.mod` is older than what the generator emitted for. So bumping `protoc-gen-go` without bumping the module produces a runtime panic rather than a compile error. `protoc` itself is only loosely coupled to both, and `protoc-gen-go-grpc` versions independently again.

**Q: (Senior) Two developers regenerate the same `.proto` and get different output. Walk through the diagnosis and the permanent fix.**
A: First establish which component differs by having both run `protoc --version`, `protoc-gen-go --version`, `protoc-gen-go-grpc --version` and `which -a` for each — in my experience it is usually the plugin, because `protoc` is installed by a package manager and the plugin by an ad-hoc `go install ...@latest` months apart. Second, check the flags: a difference in `paths=source_relative` or `require_unimplemented_servers` changes output materially, which is why the command must live in a `Makefile` rather than in shell history. The permanent fix has three parts: pin plugin versions in `go.mod` via the `tool` directive so `go install tool` is reproducible; put the exact `protoc` invocation in a `Makefile` or `buf.gen.yaml`; and add a CI gate that regenerates and fails on any diff. For teams that keep hitting it, I would go further and run codegen inside a pinned Docker image or move to `buf` with remote plugins, so no local install exists to drift.

**Q: (Senior) How would you manage `.proto` files shared across ten repositories?**
A: Hand-managed `-I` paths stop scaling at about two consumers, because every repo needs the others' files vendored at some version nobody tracks. The options, roughly in order of preference: a monorepo with one `proto/` tree and generated code produced by a single build, which is simplest when the org allows it; `buf` modules with a registry (the BSR or a self-hosted equivalent), where each repo declares `.proto` dependencies with versions and `buf` resolves them like any package manager; or publishing generated code as a versioned Go module per API, so consumers `go get` it and never run codegen at all. The last is attractive for external consumers but multiplies release overhead. Whichever I chose, the non-negotiables are the same: `buf lint` and `buf breaking` in CI on the schema repository, and a documented deprecation process, because at ten consumers a breaking change is an incident.

**Q: (Senior) What is the argument for a hermetic, containerised codegen step, and what does it cost?**
A: The argument is that codegen output is an input to your build, so it must be a pure function of the repository. A local `protoc` is not — it depends on a package manager, an OS, an architecture and whatever the developer installed last year. Running codegen in a pinned image with pinned plugin versions makes the output identical on every laptop and in CI, which eliminates spurious diffs, merge conflicts in generated files and the class of bug where CI and local disagree. The cost is real: slower iteration because every regeneration pays container startup and volume-mount overhead, a Docker dependency for contributors, and an image to maintain and update. The pragmatic compromise most teams land on is local tooling for fast iteration plus a containerised (or `buf`-based) CI job that is authoritative — if they disagree, CI wins.

## 10. Quick Revision & Cheat Sheet

```bash
# --- install protoc ---
brew install protobuf                       # macOS
sudo dnf install protobuf-compiler          # Fedora/RHEL
# Debian/Ubuntu/CI: use the release zip, extract BOTH bin/protoc and include/*
winget install protobuf                     # Windows

# --- pin + install plugins (Go 1.24+) ---
go get -tool google.golang.org/protobuf/cmd/protoc-gen-go@latest
go get -tool google.golang.org/grpc/cmd/protoc-gen-go-grpc@latest
go install tool

# --- pin + install plugins (Go <1.24) ---
# tools/tools.go with //go:build tools and blank imports, then:
go install google.golang.org/protobuf/cmd/protoc-gen-go
go install google.golang.org/grpc/cmd/protoc-gen-go-grpc

# --- PATH (the step everyone forgets) ---
export PATH="$PATH:$(go env GOPATH)/bin"

# --- runtime deps ---
go get google.golang.org/grpc google.golang.org/protobuf

# --- generate ---
protoc --proto_path=proto \
  --go_out=gen      --go_opt=paths=source_relative \
  --go-grpc_out=gen --go-grpc_opt=paths=source_relative \
  proto/**/*.proto

# --- verify everything ---
protoc --version && protoc-gen-go --version && protoc-gen-go-grpc --version
```

| Symptom | Cause | Fix |
|---|---|---|
| `program not found or is not executable` | Plugin not on `PATH` | Export `$(go env GOPATH)/bin` |
| `Plugin failed with status code 1` | Plugin errored — read the next line | Usually a missing `go_package` |
| `google/protobuf/timestamp.proto: File not found` | `include/` not installed | Extract `include/*` from the release zip |
| `File does not reside within any path specified using --proto_path` | Input outside `-I` roots | Add the correct `--proto_path` |
| Init panic about protobuf runtime version | `protoc-gen-go` newer than the module | `go get google.golang.org/protobuf@latest` |
| Huge unexplained diff in `*.pb.go` | Plugin version skew | Pin in `go.mod`, add `verify-generate` to CI |

**Flash cards**
- **Are the plugins bundled with `protoc`?** → No. Three separate installs, three version schemes.
- **How does `protoc` find `protoc-gen-go`?** → By name, on `PATH`, because you passed `--go_out`.
- **Why extract `include/`?** → It holds the well-known types (`Timestamp`, `Duration`, `FieldMask`…).
- **Modern way to pin tool versions?** → `go get -tool` + the `tool` directive in `go.mod` (Go 1.24+).
- **The CI gate that enforces everything?** → Regenerate, then `git diff --exit-code`.

## 11. Hands-On Exercises & Mini Project

- [ ] Install the full toolchain from scratch on your machine and run the §5 smoke test. Time it, and note every step where you had to search for an answer.
- [ ] Deliberately remove `$(go env GOPATH)/bin` from `PATH` and reproduce `program not found`. Then remove `option go_package` and reproduce `Plugin failed with status code 1`. Learn to tell them apart instantly.
- [ ] Install two versions of `protoc-gen-go`, regenerate with each, and diff the output. Measure how many lines change for a no-op.
- [ ] Convert a raw `protoc` command into the `Makefile` from §5, then add `verify-generate` to a CI workflow and prove it fails when you edit a `.proto` without regenerating.
- [ ] Build the `Dockerfile.protoc` image and confirm it produces byte-identical output to your local toolchain. If it does not, find out why — that difference is a bug waiting to happen.

### Mini Project — "Reproducible Codegen Setup"

**Goal.** Take a repository from "it works on my machine" to "codegen output is a pure function of the repository", and prove it.

**Requirements.**
1. A `proto/` tree with at least three `.proto` files, one importing another and one importing a well-known type.
2. Plugin versions pinned in `go.mod` via the `tool` directive (or `tools.go`), with no `@latest` anywhere in the repo.
3. A `Makefile` with `tools`, `check-tools`, `generate`, `verify-generate` and `clean` targets, where `check-tools` fails with an actionable message rather than `protoc`'s cryptic one.
4. A CI workflow that runs `make verify-generate` and `go build ./...` and fails the build on any generated-code drift.
5. A `Dockerfile.protoc` producing byte-identical output to the local toolchain, verified by a script that generates both ways and diffs.
6. A `README` setup section a new engineer can follow in under five minutes on macOS, Linux and Windows.

**Extensions.**
- Add `protoc-gen-grpc-gateway` and `protoc-gen-openapiv2` to the pipeline and confirm they pin and reproduce the same way.
- Migrate the whole thing to `buf` (chapter 8) and compare the resulting configuration against the `Makefile` — count the lines removed.

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Go Module Layout, go_package & Generated Code Anatomy* (where the output goes and what it contains), *Buf: Modern Proto Builds, Linting & Breaking-Change Detection* (replacing all of this with one binary), *Running protoc: source_relative Paths, Options & Stubs* (the flags in depth), *What Is gRPC?* (why codegen exists at all).

- **gRPC — Go Quick Start** — grpc.io · *Beginner* · the official install-and-run path, kept current with plugin releases; the canonical reference for the commands in §5. <https://grpc.io/docs/languages/go/quickstart/>
- **Protocol Buffers — Downloads & release notes** — Google · *Beginner* · the official `protoc` release archives for every platform, with checksums; always prefer these to distro packages. <https://github.com/protocolbuffers/protobuf/releases>
- **Protocol Buffers — Go Generated Code Guide** — Google · *Intermediate* · what `protoc-gen-go` emits, the `go_package` rules, and the runtime version relationship. <https://protobuf.dev/reference/go/go-generated/>
- **protoc-gen-go-grpc — README and options** — gRPC Authors · *Intermediate* · the gRPC plugin's flags, including `require_unimplemented_servers`, and its release history. <https://github.com/grpc/grpc-go/tree/master/cmd/protoc-gen-go-grpc>
- **Go 1.24 release notes — tool directive** — The Go Authors · *Intermediate* · the modern replacement for `tools.go`, with `go get -tool` and `go install tool`. <https://go.dev/doc/go1.24>
- **Buf — Installation and "Migrate from protoc"** — Buf (open source) · *Intermediate* · what replacing this whole chapter looks like, and how to do it incrementally. <https://buf.build/docs/migration-guides/migrate-from-protoc>
- **Protocol Buffers — Third-Party Add-ons (plugin list)** — Google · *Beginner* · the ecosystem of `protoc-gen-*` plugins, all of which install exactly the same way. <https://github.com/protocolbuffers/protobuf/blob/main/docs/third_party.md>
- **grpc-go — examples/helloworld** — gRPC Authors · *Beginner* · the smallest complete project to verify a fresh toolchain against. <https://github.com/grpc/grpc-go/tree/master/examples/helloworld>

---

*gRPC with Go Handbook — chapter 06.*
