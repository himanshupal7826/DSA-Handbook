# 08 · Buf: Modern Proto Builds, Linting & Breaking-Change Detection

> **In one line:** `buf` replaces a 15-line `protoc` invocation with two YAML files, adds the two things `protoc` never had — a style linter and a breaking-change detector — and turns "don't break your consumers" from a code-review convention into a CI gate.

---

## 1. Overview

`protoc` is a compiler. It compiles. Everything else a real schema workflow needs — dependency management for imported `.proto` files, consistent style enforcement, detection of changes that would break existing clients, reproducible plugin versions — has to be built around it by each team, badly and differently.

**Buf** is a single Go binary that replaces `protoc` and supplies those missing pieces:

- **`buf build` / `buf generate`** — compile and generate, configured declaratively in `buf.yaml` and `buf.gen.yaml` rather than on the command line.
- **`buf lint`** — enforces a style guide (naming, package structure, file layout) that makes a large schema estate consistent and, not incidentally, makes generated code across languages predictable.
- **`buf breaking`** — compares your schema against a baseline (a git branch, tag, or registry version) and fails if a change would break existing clients at the wire or source level. This is the feature that justifies adopting buf on its own.
- **Buf modules and the BSR** — `.proto` files as versioned dependencies, so importing `googleapis` or another team's schema is a `deps` entry rather than a vendored copy.
- **Remote plugins** — run `protoc-gen-go` and friends on Buf's infrastructure, so nothing is installed locally and versions cannot drift.

The trade is that you adopt a tool and a config format. For a new project that is obviously worth it. For an existing one, buf is designed for incremental adoption: it reads existing `.proto` trees, and `buf generate` produces byte-identical output to the equivalent `protoc` command, so you can switch the build without changing a single generated file.

## 2. Core Concepts

- **Module** — a directory tree of `.proto` files with a `buf.yaml` at its root. The unit of dependency, linting and breaking-change detection.
- **Workspace** — a `buf.yaml` (v2) listing several module directories, so a repo with multiple proto roots builds as one unit.
- **`buf.yaml`** — module identity, dependencies (`deps`), lint configuration and breaking-change configuration.
- **`buf.gen.yaml`** — the code-generation plan: which plugins, which options, which output directories. Replaces the `protoc` command line.
- **`buf.lock`** — the resolved, pinned versions of `deps`. Committed, like `go.sum`.
- **Image** — buf's serialised, self-contained compilation output (a `FileDescriptorSet` plus metadata). What `buf breaking` compares.
- **BSR (Buf Schema Registry)** — a hosted registry for proto modules, providing versioned dependencies, generated SDKs and documentation.
- **Managed mode** — buf sets `go_package` and other file options for you, based on rules in `buf.gen.yaml`, so `.proto` files stay free of language-specific boilerplate.
- **Remote plugin** — a plugin referenced as `buf.build/protocolbuffers/go:v1.36.5` and executed remotely; no local install, no version drift.
- **Lint category** — a named bundle of rules: `STANDARD` (the default), `DEFAULT`, `BASIC`, `MINIMAL`, or individual rules like `PACKAGE_VERSION_SUFFIX`.
- **Breaking category** — `FILE` (strictest: source-level per generated file), `PACKAGE`, `WIRE_JSON`, `WIRE` (loosest: wire compatibility only).

## 3. Theory & Principles

### What breaking-change detection actually checks

This is the feature worth the adoption cost, so it deserves precision. Buf compares two compiled images and reports changes that would break consumers. The categories are nested, from strictest to loosest:

| Category | Catches | Use when |
|---|---|---|
| `FILE` | Everything below, plus changes that break generated *code* per file — moving a message between files, renaming a file, changing `go_package` | Consumers compile against your generated code (the normal case) |
| `PACKAGE` | Same, but tolerant of moving definitions between files within a package | You publish per-package, not per-file |
| `WIRE_JSON` | Changes breaking either binary wire format or the canonical JSON mapping — includes field *renames* | You have JSON consumers (grpc-gateway, `protojson`) |
| `WIRE` | Only changes breaking the binary wire format — field number reuse, type changes, removing a field without reserving | Purely binary consumers; the loosest useful setting |

Concretely, `FILE` will fail your build for: deleting a field or message, changing a field's type or number, renaming a field (source and JSON break, though the wire does not), changing a method's request or response type, deleting an RPC, changing `go_package`, or moving a message to a different file. It will *not* fail for: adding a field with a new number, adding a message, adding an RPC, adding an enum value, or deprecating anything.

**Default to `FILE`.** Loosening it is a decision to be made deliberately and documented, not a default.

### What the linter enforces, and why it matters

`buf lint` with the `STANDARD` category enforces the Buf Style Guide, whose rules exist for concrete reasons:

- **`PACKAGE_VERSION_SUFFIX`** — every package must end in `v1`, `v2beta1`, etc. Without a version segment you can never run two incompatible versions side by side, which is the only workable migration path (chapter 13).
- **`PACKAGE_DIRECTORY_MATCH`** — `package acme.inventory.v1` must live in `acme/inventory/v1/`. This makes imports predictable and prevents the registry collisions from chapter 7.
- **`ENUM_ZERO_VALUE_SUFFIX`** — the first enum value must be `<ENUM_NAME>_UNSPECIFIED = 0`, because proto3 enums default to zero and an unlabelled zero silently becomes a real value.
- **`RPC_REQUEST_RESPONSE_UNIQUE`** / **`RPC_REQUEST_STANDARD_NAME`** — every RPC gets its own `FooRequest`/`FooResponse`, never a shared or reused message. Sharing means you cannot add a field for one method without affecting others — the single most common cause of schemas that become impossible to evolve.
- **`FIELD_LOWER_SNAKE_CASE`**, **`SERVICE_SUFFIX`**, **`ENUM_VALUE_PREFIX`** — consistency rules that make generated code across languages predictable.

The `RPC_REQUEST_RESPONSE_UNIQUE` rule in particular is worth internalising even if you never adopt buf: it is the difference between a schema you can evolve for a decade and one you cannot.

```svg
<svg viewBox="0 0 880 440" width="100%" height="440" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="bf1" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#4f46e5"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">buf breaking: nested categories, strictest first</text>

  <rect x="60" y="42" width="760" height="290" rx="12" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="440" y="64" text-anchor="middle" fill="#b91c1c" font-size="13" font-weight="bold">FILE &#8212; the default; also breaks generated code layout</text>
  <text x="80" y="84" fill="#991b1b" font-size="10">+ moving a message to another file &#183; renaming a file &#183; changing go_package</text>

  <rect x="110" y="94" width="660" height="228" rx="10" fill="#fff7ed" stroke="#ea580c" stroke-width="2"/>
  <text x="440" y="116" text-anchor="middle" fill="#c2410c" font-size="13" font-weight="bold">PACKAGE &#8212; tolerant of moves within a package</text>
  <text x="130" y="136" fill="#9a3412" font-size="10">+ deleting a file that still has its definitions elsewhere in the package</text>

  <rect x="160" y="146" width="560" height="166" rx="10" fill="#fefce8" stroke="#ca8a04" stroke-width="2"/>
  <text x="440" y="168" text-anchor="middle" fill="#854d0e" font-size="13" font-weight="bold">WIRE_JSON &#8212; adds the canonical JSON mapping</text>
  <text x="180" y="188" fill="#713f12" font-size="10">+ RENAMING a field (wire is fine; protojson and generated getters are not)</text>
  <text x="180" y="204" fill="#713f12" font-size="10">+ renaming an enum value &#183; changing a json_name</text>

  <rect x="210" y="214" width="460" height="88" rx="10" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="236" text-anchor="middle" fill="#15803d" font-size="13" font-weight="bold">WIRE &#8212; binary compatibility only</text>
  <text x="230" y="256" fill="#166534" font-size="10">&#8226; deleting a field without reserving its number</text>
  <text x="230" y="272" fill="#166534" font-size="10">&#8226; reusing a field number &#183; changing a field's type</text>
  <text x="230" y="288" fill="#166534" font-size="10">&#8226; changing an RPC's request or response type &#183; deleting an RPC</text>

  <rect x="60" y="348" width="760" height="82" rx="10" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="440" y="370" text-anchor="middle" fill="#15803d" font-size="12" font-weight="bold">Always safe &#8212; never reported by any category</text>
  <text x="80" y="392" fill="#166534">adding a field with a NEW number &#183; adding a message &#183; adding an rpc &#183; adding an enum value</text>
  <text x="80" y="410" fill="#166534">marking anything [deprecated = true] &#183; adding a comment &#183; reserving a deleted field's number and name</text>
</svg>
```

### Managed mode: keeping language boilerplate out of `.proto`

A `.proto` file describing a domain should not contain `option go_package`, `option java_package`, `option csharp_namespace` and six more. Managed mode moves those into `buf.gen.yaml`, where buf sets them per-file from a rule:

```yaml
managed:
  enabled: true
  override:
    - file_option: go_package_prefix
      value: github.com/acme/apis/gen/go
```

Now `acme/inventory/v1/inventory.proto` gets `go_package = "github.com/acme/apis/gen/go/acme/inventory/v1"` automatically, and the `.proto` file stays language-neutral. The trade-off is that the file no longer self-describes its Go import path, so anyone reading it must also read `buf.gen.yaml` — which is why some teams keep `go_package` explicit even under buf. Either is defensible; pick one and be consistent.

## 4. Architecture & Workflow

The buf workflow, and what each step replaces:

1. **`buf.yaml`** (module identity, deps, lint, breaking) — replaces nothing in `protoc`; this configuration simply did not exist before.
2. **`buf.gen.yaml`** (plugins and outputs) — replaces the `protoc` command line and the `Makefile` that wrapped it.
3. **`buf dep update`** — resolves `deps` into `buf.lock`. Replaces vendoring `.proto` files and juggling `-I` flags.
4. **`buf lint`** — no `protoc` equivalent.
5. **`buf breaking --against '.git#branch=main'`** — no `protoc` equivalent; this is the one that changes team behaviour.
6. **`buf generate`** — replaces `protoc --go_out=... --go-grpc_out=...`.
7. **`buf format -w`** — replaces `clang-format` hacks; canonical `.proto` formatting.

```svg
<svg viewBox="0 0 880 400" width="100%" height="400" font-family="ui-sans-serif,system-ui,sans-serif" font-size="11">
  <defs>
    <marker id="bw" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto"><path d="M0,0 L7,3 L0,6 Z" fill="#0ea5e9"/></marker>
  </defs>
  <text x="440" y="22" text-anchor="middle" fill="#1e293b" font-size="15" font-weight="bold">The pull-request pipeline buf makes possible</text>

  <rect x="30" y="44" width="150" height="60" rx="8" fill="#eef2ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="105" y="68" text-anchor="middle" fill="#3730a3" font-weight="bold">PR edits a</text>
  <text x="105" y="88" text-anchor="middle" fill="#3730a3" font-weight="bold">.proto file</text>

  <path d="M182,74 L228,74" stroke="#0ea5e9" stroke-width="2" marker-end="url(#bw)"/>

  <rect x="232" y="44" width="150" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="307" y="66" text-anchor="middle" fill="#15803d" font-family="ui-monospace,monospace" font-size="11">buf format -w</text>
  <text x="307" y="86" text-anchor="middle" fill="#166534" font-size="10">canonical formatting</text>

  <path d="M384,74 L430,74" stroke="#0ea5e9" stroke-width="2" marker-end="url(#bw)"/>

  <rect x="434" y="44" width="150" height="60" rx="8" fill="#f0fdf4" stroke="#16a34a" stroke-width="2"/>
  <text x="509" y="66" text-anchor="middle" fill="#15803d" font-family="ui-monospace,monospace" font-size="11">buf lint</text>
  <text x="509" y="86" text-anchor="middle" fill="#166534" font-size="10">style guide enforced</text>

  <path d="M586,74 L632,74" stroke="#0ea5e9" stroke-width="2" marker-end="url(#bw)"/>

  <rect x="636" y="44" width="214" height="60" rx="8" fill="#fef2f2" stroke="#dc2626" stroke-width="2"/>
  <text x="743" y="64" text-anchor="middle" fill="#b91c1c" font-family="ui-monospace,monospace" font-size="10">buf breaking --against</text>
  <text x="743" y="80" text-anchor="middle" fill="#b91c1c" font-family="ui-monospace,monospace" font-size="10">'.git#branch=main'</text>
  <text x="743" y="96" text-anchor="middle" fill="#991b1b" font-size="10">THE gate that changes behaviour</text>

  <path d="M743,106 L743,146" stroke="#0ea5e9" stroke-width="2" marker-end="url(#bw)"/>

  <rect x="636" y="150" width="214" height="60" rx="8" fill="#dcfce7" stroke="#16a34a" stroke-width="2"/>
  <text x="743" y="172" text-anchor="middle" fill="#15803d" font-family="ui-monospace,monospace" font-size="11">buf generate</text>
  <text x="743" y="190" text-anchor="middle" fill="#166534" font-size="10">remote plugins &#8594; no local install</text>

  <path d="M636,180 L590,180" stroke="#0ea5e9" stroke-width="2" marker-end="url(#bw)"/>

  <rect x="380" y="150" width="204" height="60" rx="8" fill="#fef3c7" stroke="#d97706" stroke-width="2"/>
  <text x="482" y="172" text-anchor="middle" fill="#92400e" font-family="ui-monospace,monospace" font-size="10">git diff --exit-code</text>
  <text x="482" y="190" text-anchor="middle" fill="#b45309" font-size="10">generated code is current</text>

  <path d="M380,180 L334,180" stroke="#0ea5e9" stroke-width="2" marker-end="url(#bw)"/>

  <rect x="130" y="150" width="200" height="60" rx="8" fill="#e0e7ff" stroke="#4f46e5" stroke-width="2"/>
  <text x="230" y="172" text-anchor="middle" fill="#3730a3" font-family="ui-monospace,monospace" font-size="11">go build ./... &amp;&amp; go test</text>
  <text x="230" y="190" text-anchor="middle" fill="#4338ca" font-size="10">the code actually compiles</text>

  <rect x="30" y="238" width="820" height="146" rx="10" fill="#f8fafc" stroke="#64748b" stroke-width="2"/>
  <text x="440" y="260" text-anchor="middle" fill="#334155" font-size="13" font-weight="bold">What each step replaces in a protoc workflow</text>
  <g font-size="10">
    <text x="52" y="284" fill="#334155" font-weight="bold">buf format</text><text x="200" y="284" fill="#475569">&#8592; ad-hoc clang-format rules nobody agreed on</text>
    <text x="52" y="304" fill="#334155" font-weight="bold">buf lint</text><text x="200" y="304" fill="#475569">&#8592; nothing. protoc has no linter. Style drifted per team.</text>
    <text x="52" y="324" fill="#334155" font-weight="bold">buf breaking</text><text x="200" y="324" fill="#475569">&#8592; nothing. "Don't break consumers" was a code-review convention.</text>
    <text x="52" y="344" fill="#334155" font-weight="bold">buf generate</text><text x="200" y="344" fill="#475569">&#8592; a 15-line protoc invocation wrapped in a Makefile</text>
    <text x="52" y="364" fill="#334155" font-weight="bold">buf dep update</text><text x="200" y="364" fill="#475569">&#8592; vendoring googleapis by hand and juggling -I paths</text>
  </g>
</svg>
```

## 5. Implementation

### Install

```bash
# macOS
brew install bufbuild/buf/buf

# Linux / CI — pinned release binary
BUF_VERSION=1.50.0
curl -sSL "https://github.com/bufbuild/buf/releases/download/v${BUF_VERSION}/buf-$(uname -s)-$(uname -m)" \
  -o /usr/local/bin/buf && chmod +x /usr/local/bin/buf

# Windows
winget install bufbuild.buf

# Or as a Go tool, pinned in go.mod (Go 1.24+)
go get -tool github.com/bufbuild/buf/cmd/buf@latest && go install tool

buf --version
```

### `buf.yaml` — module configuration (v2)

```yaml
# buf.yaml — module identity, dependencies, lint and breaking-change config.
version: v2

modules:
  - path: proto            # the root of this module's .proto tree

# .proto dependencies, resolved into buf.lock (commit that file, like go.sum).
# This replaces vendoring googleapis and juggling -I flags.
deps:
  - buf.build/googleapis/googleapis          # google.api.http, google.rpc.*
  - buf.build/bufbuild/protovalidate         # schema-embedded validation rules

lint:
  use:
    - STANDARD             # the Buf Style Guide; see §3 for what it enforces
  except:
    # Opt out deliberately, with a reason, never silently.
    # - PACKAGE_VERSION_SUFFIX   # (do NOT do this — see ch. 13)
  ignore:
    - proto/legacy         # a pre-existing tree we are not reformatting yet

breaking:
  use:
    - FILE                 # strictest: protects generated code, not just the wire
  ignore:
    - proto/internal       # internal-only schemas with no external consumers
```

### `buf.gen.yaml` — the generation plan

```yaml
# buf.gen.yaml — replaces the protoc command line entirely.
version: v2

# Managed mode sets file options (go_package, java_package, ...) so the .proto
# files stay free of language-specific boilerplate.
managed:
  enabled: true
  override:
    - file_option: go_package_prefix
      value: github.com/acme/apis/gen/go
  disable:
    # Never rewrite options on vendored third-party schemas.
    - module: buf.build/googleapis/googleapis

plugins:
  # Remote plugins run on Buf's infrastructure: nothing installed locally,
  # versions pinned here, so output cannot drift between machines.
  - remote: buf.build/protocolbuffers/go:v1.36.5
    out: gen/go
    opt: paths=source_relative

  - remote: buf.build/grpc/go:v1.5.1
    out: gen/go
    opt:
      - paths=source_relative
      - require_unimplemented_servers=true

  # A locally-installed plugin, for anything not available remotely.
  # - local: protoc-gen-my-custom-thing
  #   out: gen/go
  #   opt: paths=source_relative

inputs:
  - directory: proto
```

### Daily commands

```bash
buf dep update            # resolve deps -> buf.lock (commit it)
buf format -w             # canonical formatting, in place
buf lint                  # style guide
buf build                 # compile; fails on any proto error
buf generate              # write generated code per buf.gen.yaml

# Breaking-change detection against several possible baselines:
buf breaking --against '.git#branch=main'          # vs the main branch
buf breaking --against '.git#tag=v1.4.0'           # vs a release tag
buf breaking --against 'buf.build/acme/apis'       # vs what's published in the BSR
buf breaking --against 'https://github.com/acme/apis.git#branch=main,subdir=proto'

# Useful inspection:
buf build -o image.binpb                            # a portable compiled image
buf build -o -#format=json | jq '.file[].package'   # readable descriptor set
buf curl --schema . --data '{"sku":"sku_1"}' \
  http://localhost:50051/acme.inventory.v1.InventoryService/GetItem
```

### CI: the gate that makes it worthwhile

```yaml
# .github/workflows/proto.yml
name: proto
on: [pull_request]

jobs:
  buf:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # buf breaking needs history to read the baseline

      - uses: bufbuild/buf-action@v1
        with:
          version: 1.50.0
          # The action runs format, lint, breaking and (optionally) push.
          breaking_against: '.git#branch=main,ref=HEAD~1'

      # Belt and braces: prove the committed generated code is current.
      - uses: actions/setup-go@v5
        with: { go-version: '1.24' }
      - run: buf generate
      - run: git diff --exit-code -- gen/ || (echo "generated code is stale; run 'buf generate'"; exit 1)
      - run: go build ./... && go test ./...
```

### Overriding a breaking change deliberately

Sometimes you genuinely must break, and the process should be explicit rather than a `--force`:

```yaml
# buf.yaml — a documented, reviewable exception with an expiry
breaking:
  use:
    - FILE
  ignore_only:
    FIELD_NO_DELETE:
      # Removing inventory.v1.Item.legacy_code, unused since 2026-05 (see ADR-114).
      # Verified zero traffic for 90 days. Number 7 is reserved in the .proto.
      # Remove this exception after v1.9.0 ships. Owner: platform-team.
      - proto/acme/inventory/v1/inventory.proto
```

### Migrating from `protoc` incrementally

```bash
# 1. Let buf read your existing tree and write starter config.
buf config init

# 2. Prove parity: buf generate must produce byte-identical output.
make generate && cp -r gen gen.protoc
buf generate && diff -r gen gen.protoc && echo "identical — safe to switch"

# 3. Turn on lint in warn-only mode first, fix violations, then enforce.
buf lint || true          # inventory the violations
# ... fix or add targeted `except` entries with reasons ...

# 4. Add breaking-change detection last, once the schema is clean.
buf breaking --against '.git#branch=main'
```

## 6. Advantages, Disadvantages & Trade-offs

**Advantages**
- **Breaking-change detection in CI** — the single highest-value feature; turns a review convention into an enforced gate.
- **A real linter** with a well-reasoned style guide, which matters enormously once more than one team writes `.proto`.
- **Declarative configuration** — `buf.gen.yaml` is reviewable and diffable; a 15-line `protoc` command in a `Makefile` is not.
- **Proper dependency management** — `deps` + `buf.lock` instead of vendored copies and `-I` archaeology.
- **Remote plugins** — no local installs, no version drift, works identically in CI and on every laptop.
- **`buf curl`** — call a gRPC method using the local `.proto` as the schema, with no reflection required on the server.
- **Byte-identical output to `protoc`**, which makes migration a no-op for generated code.

**Disadvantages**
- **Another tool and config format** to learn, install and keep updated.
- **The BSR is a hosted service.** The core CLI is Apache-2.0 and fully usable offline, but the registry (and remote plugins) are Buf-operated, which is a dependency some organisations will not accept.
- **Remote plugins require network access** at generation time, which breaks air-gapped builds unless you fall back to local plugins.
- **Lint on a legacy schema is noisy.** A large existing estate will produce hundreds of violations that must be triaged.

**Trade-offs**
- *Managed mode vs explicit `go_package`:* managed mode keeps `.proto` language-neutral but means the file no longer tells you its Go import path. Pick one convention per repository.
- *Remote vs local plugins:* remote removes drift and install friction; local works offline and supports custom plugins. Many teams use remote for standard plugins and local for their own.
- *`FILE` vs `WIRE` breaking category:* `FILE` protects consumers' compilation, `WIRE` only their bytes. Loosening is a real decision — document it.

## 7. Common Mistakes & Best Practices

- **Adopting `buf generate` but not `buf breaking`.** You installed the tool and skipped the reason to install it.
- **Running `buf breaking` without `fetch-depth: 0`** in CI. The baseline ref is not in the shallow clone, and the check silently degrades or errors.
- **Using `--force` or blanket `ignore` to get a breaking change through.** Use `ignore_only` with a rule name, a file, a written justification and an owner.
- **Turning off `PACKAGE_VERSION_SUFFIX`** because "we'll never need v2". You will, and without the suffix the migration has no shape.
- **Sharing request/response messages between RPCs.** `RPC_REQUEST_RESPONSE_UNIQUE` exists because this is the change that makes a schema unevolvable.
- **Not committing `buf.lock`.** Dependency versions then float, and builds stop being reproducible.
- **Mixing `buf generate` and `protoc` in one repo.** Two sources of truth for plugin versions and options. Migrate fully, verifying parity first.
- **Enabling managed mode on vendored third-party modules.** It rewrites their file options and breaks their generated import paths. Use `managed.disable`.
- **Leaving lint at `MINIMAL` forever.** Start there on a legacy tree if you must, but schedule the move to `STANDARD`.

## 8. Production: Debugging, Monitoring, Security & Scaling

- **Debugging.** `buf build -o -#format=json | jq` renders the full descriptor set, which answers most "what did the compiler actually see?" questions. `buf breaking --against ... --error-format=json` gives machine-readable output for a bot that comments on pull requests.
- **CI design.** Run `buf lint` and `buf format --diff --exit-code` on every PR; run `buf breaking` against the *release baseline* rather than the previous commit, so a breaking change cannot be smuggled in across two PRs that each look safe.
- **Security.** Remote plugins execute Buf-hosted code against your schemas at build time, and `deps` pull third-party `.proto` files — pin exact versions, commit `buf.lock`, and review dependency updates as you would any other. For regulated environments, use local plugins and a self-hosted or mirrored dependency source.
- **Scaling.** Buf's real payoff arrives at organisational scale: a schema module per domain, a registry so consumers resolve versions rather than copying files, and breaking-change CI so a change that would page another team fails in the author's PR instead. At that point the question is no longer "buf or protoc" but "which schema-governance process", and buf is the only mature off-the-shelf answer.

## 9. Interview Questions

**Q: What does buf give you that `protoc` does not?**
A: Four things. A linter enforcing a style guide, which `protoc` has no concept of. Breaking-change detection against a baseline branch, tag or registry version — the feature that turns "don't break consumers" from a review convention into a CI gate. Dependency management for imported `.proto` files, so `googleapis` is a `deps` entry rather than a vendored copy and `-I` archaeology. And declarative configuration in `buf.gen.yaml`, replacing a long, unreviewable `protoc` command line. It also formats, and its output is byte-identical to `protoc`, so migration does not change generated code.

**Q: What are buf's breaking-change categories and which should you use?**
A: They nest from loosest to strictest: `WIRE` catches only binary-incompatible changes such as reusing a field number, changing a type, or deleting a field without reserving it; `WIRE_JSON` adds changes that break the canonical JSON mapping, notably field renames; `PACKAGE` adds source-level breakage within a package; and `FILE` additionally catches moving a definition to a different file or changing `go_package`. Default to `FILE`, because consumers compile against generated code, not just bytes — loosening it is a deliberate decision that should be documented.

**Q: Which changes does buf consider always safe?**
A: Adding a field with a previously unused number, adding a message, adding an RPC, adding an enum value, marking anything deprecated, adding comments, and reserving the number and name of a field you deleted. These are exactly the changes protobuf's wire format tolerates in both directions, which is why the schema-evolution rule of thumb is "additive only" (chapter 13).

**Q: What is `RPC_REQUEST_RESPONSE_UNIQUE` and why does it matter so much?**
A: It requires every RPC to have its own dedicated request and response messages rather than sharing them across methods. It matters because a shared message cannot be evolved for one method without affecting every other method that uses it — you end up with fields that are meaningful for one caller and ignored by another, and eventually with a message nobody can change safely. Following the rule costs a little boilerplate and buys a schema you can still evolve in five years.

**Q: What is managed mode, and what is the trade-off?**
A: Managed mode has buf set file options such as `go_package`, `java_package` and `csharp_namespace` from rules in `buf.gen.yaml`, so `.proto` files contain no language-specific boilerplate. The benefit is language-neutral schemas and one place to change import path conventions. The cost is that a `.proto` no longer self-describes its Go import path, so a reader must also consult `buf.gen.yaml`. Either convention works; the important part is being consistent, and disabling managed mode for vendored third-party modules so their options are not rewritten.

**Q: How do you run `buf breaking` in CI correctly?**
A: Check out with full history (`fetch-depth: 0`), because the baseline ref must be present. Compare against the release baseline — a tag or the `main` branch — rather than the previous commit, so a breaking change cannot be split across two individually-safe PRs. Use `--error-format=json` if a bot will annotate the PR. And when a break is genuinely intended, express it as an `ignore_only` entry in `buf.yaml` naming the specific rule, file, justification and owner, rather than passing a force flag.

**Q: Can you adopt buf incrementally in an existing `protoc` project?**
A: Yes, and that is the recommended path. Run `buf config init` to generate starter config against the existing tree, then verify parity by generating both ways and diffing — buf's output is byte-identical to the equivalent `protoc` invocation, so the switch changes no generated code. Enable `buf lint` next in warn-only mode to inventory violations, fix or explicitly except them, and add `buf breaking` last, once the schema is clean enough that the signal is not drowned in noise.

**Q: (Senior) How would you use buf to govern schemas across 30 services and multiple teams?**
A: One module per domain, each with `package acme.<domain>.v1` in a matching directory, published to a registry — the BSR or a self-hosted equivalent — so consumers resolve versions in `deps` and `buf.lock` rather than copying files. CI on every schema PR runs `buf format --diff --exit-code`, `buf lint` at `STANDARD`, and `buf breaking` at `FILE` against the last released tag. Breaking changes require an `ignore_only` entry with a named owner and a written justification, which makes them visible in review rather than accidental. Codegen uses remote plugins pinned in `buf.gen.yaml`, so no machine has a local toolchain to drift. The organisational point matters more than the tooling: this setup makes the cost of a breaking change land on the author, at PR time, instead of on a downstream team at 3 a.m.

**Q: (Senior) A team needs to remove a field that is genuinely unused. Walk through the process under buf.**
A: First prove it is unused rather than assuming: instrument the server to log or count requests where the field is populated, and let it run for a period long enough to cover the slowest consumer's release cycle — 90 days is a reasonable default for external consumers, less internally. In parallel, mark the field `[deprecated = true]`, which is a non-breaking change, and notify consumers by name from the traffic data rather than by broadcast. When the count is zero and the notice period has elapsed, delete the field *and* add `reserved 7; reserved "legacy_code";` so the number and name can never be reused — reuse is the change that causes silent data corruption rather than a loud failure. The deletion itself will fail `buf breaking` at `FIELD_NO_DELETE`, which is correct, so I would add a scoped `ignore_only` entry naming the rule, the file, the justification, the traffic evidence and an owner, land it, then remove the exception in the following release so the gate is not permanently weakened.

**Q: (Senior) What are the risks of depending on the Buf Schema Registry, and how do you mitigate them?**
A: There are two distinct concerns. The first is availability: remote plugins and `deps` resolution require network access to a Buf-operated service at build time, so an outage or an air-gapped environment breaks the build. The mitigation is to pin everything in `buf.lock`, cache resolved dependencies in CI, and keep a local-plugin fallback path in `buf.gen.yaml` that can be switched on. The second is supply chain: remote plugins execute code you do not control against your schemas, and `deps` pull third-party `.proto` files. The mitigation is exact version pins, committed lock files, treating dependency bumps as reviewable changes, and for regulated environments running local plugins and a mirrored dependency source instead. Worth noting that the buf CLI itself is Apache-2.0 and works entirely offline against local files — the registry is optional, and a team can take the linter and breaking-change detector without taking the hosted service at all.

## 10. Quick Revision & Cheat Sheet

```bash
buf config init                                  # scaffold buf.yaml / buf.gen.yaml
buf dep update                                   # resolve deps -> buf.lock (commit it)
buf format -w                                    # canonical formatting
buf lint                                         # style guide
buf build                                        # compile
buf generate                                     # codegen per buf.gen.yaml
buf breaking --against '.git#branch=main'        # the gate that matters
buf curl --schema . --data '{...}' http://host/pkg.Service/Method
```

| File | Holds |
|---|---|
| `buf.yaml` | module paths, `deps`, `lint`, `breaking` config |
| `buf.gen.yaml` | plugins, options, output dirs, managed mode |
| `buf.lock` | resolved dep versions — commit it |

| Lint rule | Enforces |
|---|---|
| `PACKAGE_VERSION_SUFFIX` | `package x.y.v1` — makes v2 possible |
| `PACKAGE_DIRECTORY_MATCH` | package path == directory path |
| `ENUM_ZERO_VALUE_SUFFIX` | `FOO_UNSPECIFIED = 0` |
| `RPC_REQUEST_RESPONSE_UNIQUE` | one request/response message per RPC |
| `FIELD_LOWER_SNAKE_CASE` | `quantity_on_hand`, not `quantityOnHand` |

**Flash cards**
- **The reason to adopt buf?** → `buf breaking` in CI. Everything else is convenience.
- **Which breaking category?** → `FILE`, unless you have a documented reason to loosen.
- **Always-safe changes?** → Add a field with a new number, add a message/RPC/enum value, deprecate, reserve.
- **CI gotcha?** → `fetch-depth: 0`, or the baseline ref is missing.
- **How to break deliberately?** → `ignore_only` with rule, file, justification and owner. Never `--force`.
- **Migration risk from protoc?** → None for generated code; buf's output is byte-identical.

## 11. Hands-On Exercises & Mini Project

- [ ] Run `buf config init` on an existing `protoc` project, then generate both ways and `diff -r`. Confirm byte-identical output.
- [ ] Run `buf lint` at `STANDARD` on a real schema and triage every violation into fix / except-with-reason. Count how many are `RPC_REQUEST_RESPONSE_UNIQUE`.
- [ ] Rename a field and run `buf breaking` at `WIRE`, then at `WIRE_JSON`, then at `FILE`. Explain why only two of the three fail.
- [ ] Delete a field, watch `FIELD_NO_DELETE` fail, then add `reserved` and a scoped `ignore_only` entry with a justification. Confirm the gate passes and the exception is visible in review.
- [ ] Replace local plugins with remote ones in `buf.gen.yaml` and verify identical output. Then disconnect the network and observe the failure mode.
- [ ] Add `buf.build/googleapis/googleapis` to `deps`, import `google/api/annotations.proto`, and confirm you never had to vendor a file.

### Mini Project — "Schema Governance Pipeline"

**Goal.** Build the CI pipeline that makes breaking a consumer impossible by accident — the artefact that justifies buf's existence.

**Requirements.**
1. A repository with at least two proto modules (`acme.inventory.v1`, `acme.orders.v1`) under a v2 workspace, each with a matching directory structure.
2. `buf.yaml` with `deps` on `googleapis`, `lint: STANDARD`, `breaking: FILE`, and `buf.lock` committed.
3. `buf.gen.yaml` using remote plugins for `protoc-gen-go` and `protoc-gen-go-grpc`, with managed mode setting `go_package_prefix` and disabled for vendored modules.
4. A CI workflow running format-check, lint, breaking against the last release tag, generate, `git diff --exit-code`, and `go build ./... && go test ./...`.
5. Three demonstration pull requests, each with its CI result recorded: one additive change that passes; one field rename that fails at `FILE` and `WIRE_JSON` but passes at `WIRE`; one field deletion that fails and is then landed correctly with `reserved` plus a scoped `ignore_only` entry.
6. A short `CONTRIBUTING.md` section documenting the deprecation process: mark deprecated, measure traffic, notify named consumers, wait the notice period, delete with `reserved`, remove the exception.

**Extensions.**
- Publish the modules to a registry and switch `buf breaking --against` to compare with the published version rather than a git ref.
- Add `protovalidate` to `deps` and enforce field constraints in the schema, then wire the runtime validator into a server interceptor (chapters 15 and 23).

## 12. Related Topics & Free Learning Resources

**Sibling chapters:** *Installing protoc, protoc-gen-go & protoc-gen-go-grpc* (what buf replaces), *Go Module Layout & go_package* (the layout rules buf lints for), *Schema Evolution* (the compatibility rules `buf breaking` encodes), *Build: The Complete Service .proto* (writing schemas that pass `STANDARD` first time).

- **Buf Documentation — Overview and Tutorials** — Buf (open source) · *Beginner* · installation, `buf.yaml`/`buf.gen.yaml` reference, and a guided tour of lint, breaking and generate. <https://buf.build/docs/introduction>
- **Buf — Breaking change detection** — Buf · *Intermediate* · the full rule catalogue per category, with an explanation of exactly what each rule protects. Read this before choosing a category. <https://buf.build/docs/breaking/overview>
- **Buf — Lint rules and Style Guide** — Buf · *Intermediate* · every lint rule with rationale; the style guide itself is worth following even without buf. <https://buf.build/docs/lint/rules>
- **Buf — Migrate from protoc** — Buf · *Intermediate* · the incremental adoption path, including verifying byte-identical output before switching. <https://buf.build/docs/migration-guides/migrate-from-protoc>
- **buf-action (GitHub Action)** — Buf · *Beginner* · the maintained CI action for format, lint, breaking and push, with the `fetch-depth` caveat documented. <https://github.com/bufbuild/buf-action>
- **Buf Schema Registry documentation** — Buf · *Intermediate* · modules, versioning, generated SDKs and remote plugins; read the offline/self-hosting notes before committing. <https://buf.build/docs/bsr/introduction>
- **Protocol Buffers — Updating a message type** — Google · *Intermediate* · the upstream compatibility rules that `buf breaking` mechanises; useful for understanding *why* each rule exists. <https://protobuf.dev/programming-guides/proto3/#updating>
- **protovalidate** — Buf · *Intermediate* · schema-embedded validation using CEL, distributed as a buf module; the natural companion to a governed schema pipeline. <https://github.com/bufbuild/protovalidate>

---

*gRPC with Go Handbook — chapter 08.*
