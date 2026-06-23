# 5 · Packages

> **In one line:** A Go package is the unit of compilation, naming, and encapsulation — it controls what code is reusable, what is hidden, and the deterministic order in which everything initializes.

---

## 1. Overview

A **package** is Go's fundamental building block for organizing code. Every `.go` file declares exactly one package via a `package` clause on its first non-comment line. The Go toolchain treats a package — not a file — as the **compilation unit**: all files in the same directory that share a package name are compiled together, see each other's identifiers freely, and produce a single archive (`.a`) object.

Three ideas anchor everything in this chapter:

1. **Exported identifiers**: capitalization is access control. An identifier starting with an uppercase letter is *exported* (public to importers); lowercase is *unexported* (package-private).
2. **Initialization order**: package-level variables and `init` functions run in a strict, deterministic order *before* `main` — across dependency boundaries.
3. **Import cycles are illegal**: Go's package dependency graph must be a DAG. If package `a` imports `b` and `b` imports `a`, the build fails. This is a language rule, not a lint warning.

Mastering packages is what separates code that *compiles* from code that *scales* across a team and an organization.

---

## 2. Why It Exists

Older languages handle modularity with headers (`C`), classpaths (`Java`), or namespaces resolved at link time (`C++`). These approaches lead to slow builds, fragile include orders, and diamond-dependency hell. Go's package system was designed by people who had felt that pain at Google scale, where a single binary can pull in tens of thousands of source files.

The package design solves concrete problems:

- **Fast compilation.** Because a package compiles to a self-describing archive containing export metadata, the compiler never needs to re-parse a dependency's source. Importing `net/http` reads one object, not hundreds of `.go` files.
- **Enforced encapsulation without keywords.** No `public`/`private`/`protected` ceremony — capitalization is the entire access model. This keeps the language small and the intent visible at the call site.
- **Acyclic dependencies by construction.** Forbidding import cycles forces clean layering. You physically *cannot* create the spaghetti where module A and B mutually depend in ways nobody can untangle.
- **Deterministic startup.** The defined `init` ordering removes the "static initialization order fiasco" that plagues C++.

> [!NOTE]
> A package's *import path* (e.g. `github.com/you/proj/internal/auth`) is distinct from its *package name* (e.g. `auth`). The path locates it; the name is the identifier used in code.

---

## 3. Internal Working

### Compilation units and export data

When you run `go build`, the compiler (`cmd/compile`) processes one package at a time, in dependency order computed from the import graph. For each package it emits an **export data** section embedded in the archive. This is a compact, binary serialization of every *exported* declaration's type information — function signatures, struct layouts, constants, and (with mid-stack inlining) bodies of inlinable functions.

```text
  source files (same dir)            compiler                    archive
  ┌──────────────┐
  │ auth.go      │  package auth ─┐
  │ token.go     │  package auth ─┼──► [parse+typecheck] ──► auth.a
  │ auth_test.go │  package auth ─┘        │                  ├─ machine code (.text)
  └──────────────┘                         │                  └─ export data (types of
                                           │                       EXPORTED identifiers)
  importer reads ONLY export data ◄────────┘
```

When package `main` imports `auth`, the compiler loads `auth.a`'s export data — it never re-reads `auth.go`. This is why builds are fast and why **unexported identifiers are invisible to importers at the type-system level**, not merely by convention.

### Initialization order (the precise algorithm)

The runtime guarantees this order:

1. **Imported packages first.** A package is initialized *after* all packages it imports, in a topologically-sorted, depth-first order. Each package initializes exactly once even if imported many times.
2. **Package-level variables**, in *dependency order* — not source order. The compiler builds a dependency graph among initializers; if `var a = b + 1` and `var b = 2`, then `b` initializes before `a` regardless of where they appear.
3. **`init()` functions**, in the order they appear within a file, and files are processed in the order presented to the compiler (`go` sorts filenames lexically).
4. Finally, **`main.main()`** runs.

```text
        deps initialized first (DAG, depth-first)
   ┌───────────┐     ┌───────────┐     ┌───────────┐
   │  package  │ ──► │  package  │ ──► │   main    │
   │   util    │     │   store   │     │           │
   └─────┬─────┘     └─────┬─────┘     └─────┬─────┘
   vars (dep order)  vars (dep order)   vars
   init() funcs      init() funcs       init()
                                        main.main()  ◄── runs last
```

A hidden runtime structure, `initTask`, tracks each package's init state (`uninitialized → in-progress → done`) so the runtime can sequence them and detect that work is complete.

### Import cycle detection

The dependency graph is computed *before* code generation. The loader performs a topological sort; if it finds a back-edge (a cycle), it reports `import cycle not allowed` and lists the cycle path. There is no runtime cost — it is a build-time graph property.

---

## 4. Syntax

```go
// Package doc comment: one paragraph, starts with "Package <name>".
//
// Package auth verifies bearer tokens and issues sessions.
package auth

import (
	"errors" // standard library
	"fmt"

	"github.com/go-redis/redis/v9" // third-party

	"github.com/you/proj/internal/hash" // your module
)

// Exported: uppercase first letter.
var ErrExpired = errors.New("auth: token expired")

// Unexported: package-private.
var defaultTTL = 15 // minutes

// Exported function, unexported helper.
func Verify(tok string) error { return check(tok) }
func check(tok string) error  { return nil }

// init runs automatically before main; a file may have many.
func init() {
	fmt.Println("auth package ready")
}
```

Import forms:

```go
import "math/rand"            // use as rand.Intn
import m "math/rand"          // aliased
import _ "github.com/lib/pq"  // blank: run init() only, no direct use
import . "fmt"                // dot: dump names into scope (AVOID outside tests)
```

---

## 5. Common Interview Questions

**Q1. How does Go decide if an identifier is exported?**
By the first character of the identifier name: uppercase Unicode letter → exported; anything else → unexported and visible only within the declaring package.
*Follow-up: Does this apply to struct fields?* Yes. A struct can be exported while individual fields stay unexported, which is exactly how you make a type usable but immutable from outside (note: `json.Marshal` then can't see those fields — only exported fields are marshaled).

**Q2. What is the exact initialization order within a single package?**
Imported packages first, then package-level variables in dependency order, then `init()` functions in declaration/file order, then `main`.
*Follow-up: If `var x = f()` and `func f()` references `var y`, when does `y` init?* Before `x` — the compiler topologically sorts variable initializers by reference, so `y` is initialized before `f()` is called.

**Q3. Why does Go forbid import cycles, and how do you break one?**
To keep the dependency graph a DAG, guaranteeing fast, deterministic builds and clean layering. Break a cycle by: extracting shared types into a third leaf package, inverting the dependency with an interface defined in the consumer, or merging the two packages if they're genuinely one concept.
*Follow-up: Do test files relax this?* An external test package (`foo_test`) may import the package under test *and* its consumers, which can legitimately reference both sides without forming a build cycle.

**Q4. What does a blank import (`import _ "..."`) do?**
It imports the package solely for its side effects — running its `init()` functions — without binding a name. Classic use: database drivers registering themselves with `database/sql`.
*Follow-up: Name a risk.* Hidden coupling; a reader sees no usage yet behavior changes at startup. Document why the blank import exists.

**Q5. What's the difference between import path and package name?**
The import path is the unique location string used to fetch/identify the package; the package name is the identifier used in source. They often match but need not (path `gopkg.in/yaml.v3`, name `yaml`).
*Follow-up: How does the compiler know the name?* From the `package` clause of the imported files, not the path — which is why `goimports` sometimes adds an alias.

**Q6. What is the `internal/` directory rule?**
Code under an `internal/` directory is importable only by packages rooted at the parent of `internal/`. It's compiler-enforced visibility scoping beyond the simple exported/unexported axis.
*Follow-up: Could two teams share `internal` code?* Only if they live under the same parent path; otherwise they get `use of internal package not allowed`.

**Q7. Can `init()` take arguments or be called manually?**
No to both — `init` has no parameters, no return, cannot be referenced, and may be declared multiple times per file. The runtime is the only caller.
*Follow-up: How do you order two init functions in different files?* By filename: `go` feeds files to the compiler in lexical order, so `a_init.go`'s init runs before `z_init.go`'s.

---

## 6. Production Use Cases

- **Driver registration via blank imports.** `database/sql` defines a registry; `import _ "github.com/lib/pq"` runs an `init()` that calls `sql.Register("postgres", ...)`. The same pattern powers image decoders (`image/png`) and `pprof`'s HTTP handlers (`net/http/pprof`).
- **`internal/` for monorepo boundaries.** Kubernetes, Docker, and most large Go services wall off implementation packages in `internal/` so external consumers can depend only on a curated public API surface — letting teams refactor internals without breaking the world.
- **Plugin-style codec/format selection.** Prometheus and gRPC use init-time registration so that adding a new encoder is "import the package," with no central switch statement to edit.
- **Layered architecture (Uber/Google style).** Domain → service → transport packages with a strict acyclic graph; the no-cycles rule is *the* mechanism that keeps a 500-package service from collapsing into mud.
- **Feature flags & metrics auto-registration.** Many companies register Prometheus collectors in `init()` so importing a subsystem automatically exposes its metrics.

---

## 7. Common Mistakes

> [!WARNING]
> **Relying on `init()` for ordering across packages you don't control.** Init order across sibling dependencies is determined by the import DAG, not your intuition. If two unrelated packages both have init side-effects, you cannot assume which runs first.

- **God packages** named `util`, `common`, or `helpers` that everything imports — they become cycle magnets and have no cohesion.
- **Exporting by default.** Beginners uppercase everything. Start unexported; export only what callers provably need. Every exported symbol is a maintenance contract.
- **Hidden work in `init()`.** Network calls, file reads, or panics in `init()` make programs fail at import time with stack traces that don't mention your bug clearly. Prefer explicit `New()` constructors.
- **Misreading cycle errors.** `import cycle not allowed` lists the *full* path; people fix the wrong edge. Read the whole chain.
- **Dot imports in production.** `import . "fmt"` pollutes the namespace and breaks tooling/readability. Acceptable only in some test DSLs.
- **Confusing module path with package name** when aliasing is actually required.

---

## 8. Performance Considerations

Packages are mostly a *build-time* concern; at runtime the boundaries largely disappear after linking. Key points:

- **Build speed scales with the import graph, not total LOC.** Because importers read export data only, a well-layered graph with small leaf packages parallelizes and caches beautifully. A giant package, by contrast, must be recompiled wholesale on any change — hurting incremental builds.
- **Inlining respects package boundaries but isn't blocked by them.** The compiler stores inlinable function bodies in export data, so a tiny exported getter in package `a` can be inlined into package `b`. Splitting code into packages does *not* inherently cost a function-call indirection.
- **`init()` is startup latency.** Heavy init work (parsing large embedded files, building maps) directly adds to process start time — measurable in serverless/Lambda cold starts. Move expensive work to lazy `sync.Once`.
- **Dead-code elimination is per-symbol, not per-package.** Importing a big package doesn't bloat your binary if you use little of it — the linker drops unreferenced functions. (Init functions are the exception: they always run, so they always link.)

---

## 9. Best Practices

- **Name packages for what they provide, as a single lowercase word**: `auth`, `cache`, `tokenstore` — never `authPackage`, `utils`, or plurals like `models`.
- **Keep the exported surface minimal.** Default to unexported. Promote to exported only with intent.
- **One package = one concept.** Cohesion over file count.
- **Avoid stutter.** `chunk.New` not `chunk.NewChunk`; `bytes.Buffer` not `bytes.BytesBuffer`.
- **Use `internal/`** to express "public within my module, private to the world."
- **Prefer explicit constructors** (`New…`) over `init()` for anything that can fail or be configured.
- **Write a package doc comment** in a `doc.go` for substantial packages.
- **Group imports** into stdlib / third-party / local blocks; let `goimports`/`gofmt` order them.

> [!TIP]
> If you find yourself wanting an import cycle, you've usually discovered a missing third package or a misplaced interface. Define the interface where it's *consumed*, not where it's implemented.

---

## 10. Code Examples

Primary: breaking an import cycle by inverting the dependency with a consumer-side interface. Below, `report` needs to read users but must not import `user` (which already imports `report` for audit logging). The consumer declares the interface it needs.

```go
// package report
package report

// Consumer-defined interface: report does NOT import user.
type UserSource interface {
	Name(id int) (string, error)
}

func Build(src UserSource, id int) (string, error) {
	name, err := src.Name(id)
	if err != nil {
		return "", err
	}
	return "Report for " + name, nil
}
```
```go
// package user — satisfies report.UserSource implicitly; no cycle.
package user

import "github.com/you/proj/report"

type Store struct{ /* db handle */ }

func (s *Store) Name(id int) (string, error) { return "Ada", nil }

func Audit(id int) (string, error) {
	return report.Build(&Store{}, id) // user -> report only; one direction.
}
```

Because Go interfaces are satisfied *structurally*, `user.Store` fulfills `report.UserSource` without `report` ever importing `user`. The dependency now points one way.

Next, a self-contained demonstration of init order and registry-style wiring:

```go
package main

import (
	"fmt"
)

var registry = map[string]func() string{}

func register(name string, fn func() string) { registry[name] = fn }

// Package-level var initialized via call — runs before init().
var loaded = func() bool {
	register("json", func() string { return "{}" })
	return true
}()

func init() { fmt.Println("init: registry has", len(registry), "codecs") }

func main() {
	fmt.Println("main:", registry["json"]())
}
// Output:
// init: registry has 1 codecs
// main: {}
```

---

## 11. Advanced Concepts

- **External test packages (`foo_test`).** Placing a test file in package `foo_test` (same dir) compiles it as a *separate* package that imports `foo`. This tests only the exported API and, crucially, can import packages that themselves import `foo` — a sanctioned way around what would otherwise be a cycle.
- **Export data & cross-package inlining.** Since the compiler serializes inlinable bodies, fine-grained packages don't impose call overhead. This is why idiomatic Go favors many small packages.
- **The `internal` visibility algorithm.** An import path `.../x/internal/y/z` is importable only by paths sharing the prefix `.../x`. It's a separate axis from exported/unexported.
- **Linkname & assembly stubs.** `//go:linkname` lets one package reference another's *unexported* symbol by mangled name — a deliberate escape hatch the runtime/stdlib uses, and that you should treat as forbidden in app code.
- **Build constraints split packages by platform.** `//go:build linux` and `_windows.go` suffixes let one package present a uniform API backed by per-OS files — same package, different compilation set.
- **Cyclic *initialization* (not import) is still possible** within a single package and is a compile error: `var a = b; var b = a`.

---

## 12. Debugging Tips

- **Visualize the import graph:** `go list -deps ./...` and `go mod graph` show dependencies; `go list -f '{{ .ImportPath }}: {{ .Imports }}' ./...` reveals per-package edges.
- **Find a cycle's exact path:** the build error prints `import cycle not allowed` followed by each hop — read top to bottom.
- **Trace init order:** temporarily add `fmt.Println` (or `runtime.Caller`) to suspicious `init()`s; or use `GODEBUG=inittrace=1` which prints per-package init timing and allocation — invaluable for cold-start tuning.

```text
GODEBUG=inittrace=1 ./app
init internal/bytealg @0.008 ms, 0 ms clock, 0 bytes, ...
init runtime          @0.04  ms, ...
init mypkg            @1.20  ms, 1 ms clock, 98304 bytes, 12 allocs  ◄── heavy!
```

- **"undefined" across files in the same package?** Check the `package` clause matches — a stray rename silently makes a file its own package.
- **`go vet` and `golangci-lint`** catch unused imports, shadowing, and (with `depguard`) forbidden cross-layer imports.

---

## 13. Senior Engineer Notes

A senior engineer treats package boundaries as **API design**, because that's what they are. When reviewing a PR, scrutinize every newly *exported* identifier: each one is a promise that's expensive to revoke. Push back on `util`/`common` dumping grounds — ask "what concept owns this?" and route the code there.

In code review, the highest-leverage catch is the **init() with side effects** that should have been a constructor: it turns a testable, configurable dependency into invisible global state. Mentor juniors on the unexported-first habit; show them that shrinking the public surface makes refactoring fearless.

Know the cycle-breaking toolkit cold and teach it: (1) extract shared types to a leaf, (2) define the interface at the consumer (dependency inversion), (3) merge if they're truly one concept. Recognize that wanting a cycle is a *design smell*, and use the moment to discuss layering. Finally, own the convention that tests target the exported API via `pkg_test` packages so the team doesn't accidentally lock in implementation details.

---

## 14. Staff Engineer Notes

At staff level the package graph becomes an **org chart and a build-economics problem**. The shape of `internal/` and the dependency DAG decide which teams can move independently. A staff engineer establishes and enforces (via `depguard` or Bazel visibility rules in CI) the *allowed* edges between domains, so that a payments team can't accidentally couple to a notifications internal — turning architectural intent into a build-time invariant rather than a wiki page.

Cross-team trade-offs surface in **build latency at scale**: a single foundational "kitchen-sink" package recompiled on every change can add minutes to thousands of CI runs daily. Staff engineers split such packages, push expensive `init()` work behind lazy initialization to protect serverless cold starts, and quantify the savings (e.g., "splitting `pkg/core` cut median CI build from 6m to 90s").

On build-vs-buy: the registration-via-init pattern (codecs, drivers, metrics) is the idiomatic Go alternative to a heavyweight plugin framework — staff engineers should reach for it before adopting external DI containers, which fight Go's grain. They also set the policy on `internal/` versus separately-versioned modules: extract a stable contract into its own module only when an external consumer genuinely needs independent versioning, accepting the coordination cost that creates. Every such boundary is a long-lived org commitment, so the decision belongs at the staff/architecture level.

---

## 15. Revision Summary

- A **package** is the compilation, naming, and encapsulation unit; all same-named files in a directory compile together into one archive with **export data**.
- **Capitalization = visibility:** uppercase exported, lowercase package-private. Default to unexported.
- **Init order:** imported packages (DAG, depth-first) → package vars in dependency order → `init()` funcs in file/declaration order → `main`. Each package inits once.
- **Import cycles are a build error**, enforced by topological sort. Break them via a shared leaf package, consumer-side interfaces (dependency inversion), or merging.
- `import _` = side-effect-only (driver registration); `import x "p"` = alias; `import . "p"` = avoid.
- `internal/` = importable only within the parent subtree; a distinct visibility axis.
- Prefer **constructors over heavy `init()`**; `GODEBUG=inittrace=1` measures startup cost.
- Build speed tracks the import graph; small cohesive packages + cross-package inlining give clean layering with no runtime penalty.

**References:** Effective Go: Packages; Go spec (Package initialization, Declarations and scope); `go doc`, `go list`, `GODEBUG=inittrace`.

---

*Go Engineering Handbook — topic 5.*
