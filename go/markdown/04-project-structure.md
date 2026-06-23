# 4 · Project Structure

> **In one line:** Idiomatic Go project layout uses `cmd/` for entrypoints, `internal/` for compiler-enforced privacy, `pkg/` for shareable libraries, and Go modules to anchor import paths.

---

## 1. Overview

A Go project's structure is not decoration — it is *enforced semantics*. Unlike Java packages or Python modules where layout is convention only, Go bakes two layout rules directly into the compiler: the **`internal/` directory** restricts import visibility, and the **module path** (declared in `go.mod`) becomes the literal prefix of every import path in your codebase.

The widely-cited reference is the community repo **golang-standards/project-layout**. It is *not* an official Go team standard (the Go team has explicitly distanced itself from treating it as canonical), but its `cmd/`, `internal/`, and `pkg/` conventions are near-universal in production Go.

A typical mid-sized service:

```text
myservice/
├── go.mod                  # module github.com/acme/myservice
├── go.sum
├── cmd/
│   ├── server/main.go      # binary: myservice-server
│   └── worker/main.go      # binary: myservice-worker
├── internal/               # importable ONLY within this module
│   ├── auth/
│   ├── store/
│   └── config/
├── pkg/                    # safe for external import (use sparingly)
│   └── ratelimit/
├── api/                    # protobuf / OpenAPI specs
├── migrations/
└── Makefile
```

The mental model: **`cmd/` is the thin wiring layer, `internal/` is your private domain, `pkg/` is your published surface.**

## 2. Why It Exists

Three pressures created these conventions:

1. **Encapsulation without classes.** Go has no `private`/`public` keywords at the package boundary across directories — only capitalization controls symbol export *within* a package's importers. There was no way to say "this whole package is private to my project" until `internal/` was added in Go 1.4 (2014). It solved real pain: companies were leaking implementation packages into their public API and couldn't refactor without breaking external users.

2. **Multiple binaries from one repo.** A service usually ships more than one executable (server, worker, migration tool, CLI). `cmd/<name>/main.go` gives each binary an unambiguous home, and `go build ./cmd/...` builds them all.

3. **Import paths must be globally addressable.** Go modules tie your code to a URL-like path. `import "github.com/acme/myservice/internal/auth"` is resolvable, cacheable, and versionable. This is *why* the directory layout and the import string are the same thing — there is no separate "classpath."

> [!NOTE]
> `pkg/` is the most debated convention. Many senior Go engineers (including Go core members) argue it adds a pointless directory level. Use it only when you genuinely publish reusable libraries; otherwise put packages at the repo root.

## 3. Internal Working

The "implementation" here lives in the **Go toolchain's loader and type-checker**, not the runtime. Understanding it means understanding how `go build` resolves and validates imports.

**Module resolution.** When you run a `go` command, the toolchain walks up from the current directory to find `go.mod`. The `module` line establishes the *module path*. Every package's import path = module path + relative directory path. This mapping is purely lexical — there is no registry lookup for first-party code.

**The `internal/` rule.** During package loading, the toolchain (`go/build` and the module loader) applies a structural check: a package whose path contains an element named `internal` may be imported **only** by code rooted at the parent of that `internal` directory. Formally, `.../a/internal/b` is importable by any package under `.../a/`, and nothing else.

```text
github.com/acme/svc/
│
├── internal/auth         <-- importable by ANY package under github.com/acme/svc/
│   │
│   └── (parent = github.com/acme/svc)
│
├── foo/internal/bar      <-- importable ONLY under github.com/acme/svc/foo/
│
└── cmd/server  ─────import──► internal/auth   OK (shares parent svc)

github.com/other/lib ─────import──► acme/svc/internal/auth   ERROR
```

The check happens at **compile/load time**, producing: `use of internal package ... not allowed`. There is zero runtime cost — no reflection, no symbol tables consulted at execution. It is a graph-reachability test over import paths.

**Build graph & caching.** The toolchain builds a DAG of packages. Each package compiles to an archive (`.a`) keyed by a content hash of its source + dependencies + build flags, stored in `$GOCACHE`. Layout affects *which* packages exist and their dependency edges, which affects cache granularity and incremental rebuild speed — but the compiled artifact memory layout (structs, methods, vtables for interfaces) is unaffected by directory structure. Directories are a *source organization* concern resolved entirely before code generation.

**`main` package special-casing.** A directory whose package is named `main` and contains `func main()` compiles to an executable rather than an archive. That's why each `cmd/<x>/` is its own directory: one `main` package per binary.

## 4. Syntax

The `go.mod` anchors everything:

```go
// go.mod
module github.com/acme/myservice

go 1.22

require (
	github.com/jackc/pgx/v5 v5.5.0
	go.uber.org/zap v1.27.0
)
```

Imports mirror the directory tree under the module path:

```go
package main

import (
	"context"
	"log"

	"github.com/acme/myservice/internal/config"
	"github.com/acme/myservice/internal/store"
)

func main() {
	cfg := config.Load()
	db, err := store.Open(context.Background(), cfg.DSN)
	if err != nil {
		log.Fatalf("store.Open: %v", err)
	}
	defer db.Close()
	// ... wire and run
}
```

Common build commands:

```text
go build ./...            # build every package
go build ./cmd/server     # build one binary
go test ./internal/...    # test all internal packages
go vet ./...
go mod tidy               # sync go.mod/go.sum to actual imports
```

## 5. Common Interview Questions

**Q1. What does the `internal/` directory actually do?**
It is a compiler-enforced visibility boundary: packages under `internal/` can only be imported by code sharing the parent directory of that `internal/`. It lets you expose a stable public API while keeping implementation packages unimportable by outsiders.
*Follow-up: Can two sibling modules share an `internal/` package?* No — the rule is scoped to the directory tree, and module boundaries don't widen it. They'd need to extract it into a separate published module or a `pkg/`.

**Q2. Why put binaries under `cmd/`?**
Each binary is a `main` package, and you can have only one per directory. `cmd/<name>/` gives each executable a clear home and keeps `main.go` thin — just wiring. `go build ./cmd/...` builds them all.
*Follow-up: Where should business logic go?* In `internal/`, not in `cmd/`. `main` should be dependency-injection glue, ~50 lines.

**Q3. Is golang-standards/project-layout official?**
No. It's a popular community repo. The Go team has stated it is not an official standard. `cmd/` and `internal/` are real conventions; `pkg/` is contested.
*Follow-up: When would you NOT use `pkg/`?* For an application/service that publishes nothing — just put packages at the root or under `internal/`.

**Q4. How does the module path relate to import paths?**
Import path = module path (`go.mod`'s `module` line) + the package's directory path relative to module root. It's lexical; no lookup for in-repo code.
*Follow-up: What breaks if you rename the module?* Every internal import string changes. You must update all imports (`gofmt -r` or an IDE refactor) and any consumers.

**Q5. How do you structure a monorepo with multiple Go services?**
Two main strategies: (a) single module at repo root with services under `cmd/` or `services/<svc>/`; (b) multi-module — each service has its own `go.mod`. Single-module is simpler for atomic refactors; multi-module gives independent versioning and smaller dependency graphs.
*Follow-up: Downside of single huge module?* `go mod tidy` and CI touch everything; one bad dependency can affect all services; slower large-scale builds without build tooling like Bazel.

**Q6. What's the difference between exported identifiers and `internal/`?**
Capitalization (`Foo` vs `foo`) controls symbol visibility *to importers of a package*. `internal/` controls *which packages may import the package at all*. They're orthogonal layers.
*Follow-up: Can you have an exported function in an internal package?* Yes — it's exported to anyone *allowed* to import that package (i.e., within the module subtree).

**Q7. Where do generated files (protobuf, mocks) go?**
Typically `api/` or `gen/` for specs, with generated `.go` placed next to or under the owning package. Keep generated code committed and clearly marked (`//go:generate`, header comments) for reproducibility.
*Follow-up: Should generated code be in `internal/`?* Usually yes if it's implementation detail; expose only what consumers need.

## 6. Production Use Cases

- **Kubernetes** uses `cmd/` heavily (`cmd/kube-apiserver`, `cmd/kubelet`, etc.) and `staging/` + `vendor/` for its module sprawl; `pkg/` holds shared libraries consumed across components.
- **Docker / Moby** and **containerd** use `cmd/` per binary plus extensive `internal/` and `pkg/` separation.
- **HashiCorp** (Terraform, Vault, Consul) leans on `internal/` to lock down implementation while exposing plugin SDKs as separate published packages.
- **Cockroach Labs (CockroachDB)** and **InfluxDB** use a single large module with `pkg/`-style organization and code generation pipelines.
- **Microservice template repos** at most companies standardize on `cmd/server/main.go` + `internal/{handler,service,repository}` — a thin clean-architecture layering. This is the dominant pattern in fintech and SaaS backends.
- **Monorepos at Uber and Google-scale shops** use multi-module or Bazel-driven builds where layout maps directly to build targets.

## 7. Common Mistakes

> [!WARNING]
> Putting business logic in `main.go`. `main` should be wiring only. Logic in `cmd/` is untestable in isolation and unreusable across binaries.

- **Overusing `pkg/`** for code nothing external consumes — adds a noise directory.
- **Deep, premature package trees** (`internal/domain/service/impl/v2/...`) before you have the code to justify them. Start flat; split when a file exceeds ~500 lines or a clear seam appears.
- **Import cycles.** Go forbids them at compile time. Caused by bidirectional package dependencies; fix by extracting shared types into a leaf package (e.g., `internal/model`).
- **A `utils` / `common` god-package** that everything imports — it becomes a dependency magnet and an import-cycle factory.
- **Mismatched module path and repo URL**, e.g. `module myservice` instead of `module github.com/acme/myservice`. Breaks `go get` for consumers.
- **Forgetting `go mod tidy`**, leaving stale or missing entries in `go.sum`.

## 8. Performance Considerations

Project structure has **no runtime performance impact** — it's resolved at build time. But it materially affects *build performance and developer velocity*:

- **Compilation unit = package.** Go compiles per-package and caches by content hash. Smaller, well-separated packages improve **incremental build** parallelism and cache hit rates. A single 10,000-line package recompiles fully on any change; ten 1,000-line packages recompile only what changed.
- **Dependency fan-in.** A widely-imported package (the `common` anti-pattern) invalidates many downstream packages' caches on every edit. Keep hot leaf packages small and stable.
- **Module size & `go mod` ops.** In a giant single module, `go mod tidy`, `go list ./...`, and CI graph computation scale with total package count. Multi-module or Bazel partitions this.
- **Binary size.** Go's linker performs dead-code elimination per binary. Splitting binaries via `cmd/` means each only links what it actually imports — `cmd/migrate` won't pull in the HTTP server's dependencies.

> [!TIP]
> If CI build times balloon, profile with `go build -debug-actiongraph` or check `GOCACHE` hit rates before reaching for Bazel. Often the fix is breaking up one monster package.

## 9. Best Practices

- **Start flat.** A new service can be `main.go` + a few packages. Introduce `cmd/`/`internal/` only when you have a second binary or want to lock down APIs.
- **`internal/` by default** for application code. You almost never want others importing a service's guts; `internal/` makes that the compiler's job.
- **Thin `main`.** Parse flags/config, build dependencies, call `run()`. Return errors from a `run() error` so `main` is testable-ish and exit codes are clean.
- **Name packages for what they provide, not their layer.** `auth`, `billing`, `store` — not `helpers`, `managers`, `base`.
- **One module per repo** unless you need independent versioning. Reach for multi-module deliberately.
- **Group `api/` specs separately** from generated code; commit generated code and gate it with `//go:generate`.
- **Avoid `util`/`common`.** If shared, name it concretely (`internal/clock`, `internal/idgen`).

## 10. Code Examples

A clean, idiomatic single-module service skeleton. First, the thin `main`:

```go
// cmd/server/main.go
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"

	"github.com/acme/myservice/internal/config"
	"github.com/acme/myservice/internal/httpapi"
	"github.com/acme/myservice/internal/store"
)

func main() {
	if err := run(); err != nil {
		os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(1)
	}
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	cfg := config.Load()
	db, err := store.Open(ctx, cfg.DSN)
	if err != nil {
		return err
	}
	defer db.Close()

	srv := &http.Server{Addr: cfg.Addr, Handler: httpapi.New(db)}
	go func() { <-ctx.Done(); srv.Shutdown(context.Background()) }()

	if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
```

And the internal package it wires — note this is unimportable outside the module:

```go
// internal/httpapi/api.go
package httpapi

import (
	"net/http"

	"github.com/acme/myservice/internal/store"
)

// New is exported, but only to importers WITHIN github.com/acme/myservice
// because the package lives under internal/.
func New(db *store.DB) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	return mux
}
```

For a **multi-module monorepo**, each service owns its `go.mod` and a workspace stitches them locally:

```text
repo/
├── services/
│   ├── billing/
│   │   ├── go.mod        # module github.com/acme/billing
│   │   └── cmd/server/main.go
│   └── notify/
│       ├── go.mod        # module github.com/acme/notify
│       └── cmd/server/main.go
└── go.work               # go 1.18+ workspace: stitches modules locally
```

```go
// go.work
go 1.22

use (
	./services/billing
	./services/notify
)
```

`go.work` (Go 1.18+) lets the toolchain resolve cross-module imports locally without committing `replace` directives — a big ergonomic win for monorepos.

## 11. Advanced Concepts

- **`go.work` workspaces.** The modern answer to multi-module local development. Keep it *out* of CI publish builds (or commit deliberately); it overrides module resolution.
- **Build constraints & layout.** Files like `store_linux.go`, `store_test.go`, or `//go:build integration` partition compilation orthogonally to directories. Layout + build tags together control what compiles.
- **`internal/` at any depth.** The rule applies to *every* `internal` path element, so you can scope visibility tightly: `internal/billing/internal/ledger` is private even to the rest of `internal/`. Powerful for enforcing intra-module boundaries.
- **Vendoring (`vendor/`).** `go mod vendor` materializes dependencies into the repo for hermetic/offline builds; the toolchain auto-detects `vendor/` and uses it. Common in regulated environments and Bazel setups.
- **Major version paths.** A v2+ module *must* encode the version in its path: `module github.com/acme/lib/v2`. This is the "semantic import versioning" rule — v1 and v2 are different import paths and can coexist.
- **Plugin boundaries.** Public SDKs (HashiCorp-style) are deliberately *not* in `internal/` and often live in a sub-module so consumers get a minimal dependency surface.

## 12. Debugging Tips

- **`use of internal package not allowed`** → you're importing across the `internal/` boundary. Either move the importer under the right parent, or promote the package out of `internal/`.
- **`import cycle not allowed`** → run `go build ./...`; the error lists the cycle. Break it by extracting shared types into a leaf package with no project imports.
- **`go: cannot find module providing package ...`** → import path doesn't match any module path; check the `module` line in `go.mod` and run `go mod tidy`.
- **`go list -deps ./cmd/server`** prints the full transitive dependency set of a binary — invaluable for spotting accidental heavy imports.
- **`go mod graph` / `go mod why <pkg>`** explains *why* a dependency is pulled in.
- **Stale builds?** `go clean -cache` then rebuild to rule out cache corruption (rare, but real).

## 13. Senior Engineer Notes

As a senior, your job is **judgement at the package boundary**. In code review, push back on logic creeping into `cmd/`, on new `util` packages, and on speculative deep trees. Ask "what's the import direction?" — dependencies should flow toward stable abstractions, and a new package shouldn't make a leaf package import an application package.

Mentor juniors on the difference between *exported* (capitalization) and *importable* (`internal/`) — it's a frequent confusion. Teach the `run() error` pattern so error handling and signal shutdown are testable.

When a package's test file needs to reach into unexported internals, prefer a `package foo` (white-box) test in the same dir over exporting symbols just for testing — layout should serve the code, not leak for convenience. Recognize the moment a 600-line package has two distinct responsibilities and split it *then*, with the commit history to show why.

## 14. Staff Engineer Notes

At staff level the question shifts from "where does this package go?" to **"single module or many, and what build system?"** This is an org-level, build-vs-buy decision:

| Concern | Single module | Multi-module + `go.work` | Bazel/Pants |
|---|---|---|---|
| Atomic refactor | Easy | Hard (version skew) | Easy |
| Independent release | No | Yes | Yes |
| CI graph cost | Grows with repo | Partitioned | Best (fine-grained) |
| Onboarding cost | Lowest | Medium | Highest |

Most companies should stay single-module far longer than they think; Bazel is a serious investment justified only at large scale (hundreds of engineers, polyglot repos). Standardize layout via a **service template / generator** so 50 services don't each invent `internal/handlers` vs `internal/http` vs `internal/transport`. That consistency is worth more than any individual layout's elegance.

Drive a cross-team policy on `internal/` for shared platform code: platform libraries that *must* be consumed go in a published module with a deliberate, reviewed API; everything else stays `internal/`. Own the `api/` contract directory and code-gen pipeline as a shared standard. The strategic risk you're managing is **coupling**: layout is the cheapest enforcement mechanism Go gives you for keeping a large org's dependency graph acyclic and intentional.

## 15. Revision Summary

- **`cmd/<name>/main.go`** — one `main` package per binary; keep it thin (wiring only).
- **`internal/`** — compiler-enforced privacy; importable only within the subtree rooted at `internal/`'s parent. Applies at any depth.
- **`pkg/`** — for genuinely published libraries; contested, often unnecessary for services.
- **Module path** (`go.mod`) + relative dir = **import path**; purely lexical for in-repo code.
- **Exported (capitalization)** != **importable (`internal/`)** — orthogonal visibility layers.
- **Start flat**, split on real seams; avoid `util`/`common` god-packages; break import cycles with leaf packages.
- **Monorepos:** single module (simple, atomic) vs multi-module + `go.work` (independent versioning) vs Bazel (scale).
- **v2+** modules encode `/v2` in the path (semantic import versioning).
- Layout affects **build/cache performance and coupling**, never runtime speed.

**References:** golang-standards/project-layout; Go Modules Reference (go.dev); Go command docs (`go help internal`, `go help mod`); Go 1.18 workspaces (`go.work`) docs.

---

*Go Engineering Handbook — topic 4.*
