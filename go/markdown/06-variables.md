# 6 · Variables

> **In one line:** Go variables bind a name to a typed, zero-initialized memory location, declared with `var` or `:=`, governed by lexical scope and the subtle trap of shadowing.

---

## 1. Overview

A variable in Go is a named, typed storage location. The name is a compile-time handle; the storage is a region of memory (on the stack, the heap, or a register) that holds a value of exactly one type for the variable's lifetime.

Go gives you two ways to introduce a variable: the explicit `var` declaration and the short declaration `:=`. Both produce identically behaving variables — the difference is ergonomic and contextual, not semantic. Every Go variable is *always* initialized: if you do not supply a value, Go writes the type's **zero value**. There is no concept of "uninitialized garbage memory" as in C.

Two properties define how a variable behaves in a program: its **type** (fixed at declaration, enforced by the compiler) and its **scope** (the lexical region where the name is visible). Most real-world bugs around variables are not about types — the compiler catches those — but about scope and its evil twin, **shadowing**, where an inner declaration silently hides an outer one.

This chapter treats variables as a production concern, not a syntax footnote: where they live in memory, why escape analysis matters, how shadowing causes outages, and how senior and staff engineers reason about them in reviews and architecture.

## 2. Why It Exists

Every language needs a way to name and reuse computed state; that is table stakes. The interesting design questions are *what guarantees* the language attaches to that name. Go's variable model exists to deliver three guarantees that directly serve its goals of simplicity and safety at scale:

- **No uninitialized memory.** C's `int x;` leaves `x` holding whatever was on the stack — a notorious source of nondeterministic bugs. Go's zero-value rule means `var x int` is *always* `0`. This eliminates an entire bug class and lets types ship "ready to use" defaults (a `bytes.Buffer` zero value is an empty, usable buffer).
- **Fast iteration without losing type safety.** The `:=` short declaration plus type inference means you rarely write types in function bodies, yet everything stays statically typed. You get scripting-language brevity with compiled-language guarantees.
- **Predictable lifetime and cost.** Go decides automatically whether a variable lives on the stack (cheap, freed at return) or the heap (GC-managed) via escape analysis. The programmer expresses *intent*; the compiler handles *placement*.

The combination — mandatory initialization, inference, automatic placement — is a deliberate trade: slightly less control than C, vastly fewer footguns, which is the right call for the large concurrent services Go was built for.

## 3. Internal Working

A variable is, to the compiler, an entry in a symbol table that maps a name to a *type* and a *storage location*. The name disappears entirely after compilation; what remains is an address or a register.

**Where does it live?** The Go compiler runs **escape analysis** during compilation. If it can prove a variable's lifetime is bounded by its function's stack frame, the variable is allocated on the goroutine's stack — a single pointer bump, freed for free on return. If a reference *escapes* (returned, stored in a heap object, captured by a closure that outlives the frame, or passed somewhere the compiler can't bound), it is allocated on the heap and becomes the garbage collector's responsibility.

```text
  Goroutine stack frame (function foo)        Heap (GC-managed)
  +--------------------------------+          +-------------------+
  | a int      = 42                |          | escaped struct    |
  | b float64  = 0.0 (zero value)  |          |  field x = ...    |
  | p *T  -----------------------------------> |  field y = ...    |
  | (locals freed on return)       |          +-------------------+
  +--------------------------------+           (freed by GC later)

  var a int          -> stays on stack (never escapes)
  p := &T{...}        -> &T escapes via return -> heap
```

**Zero values** are not memset at runtime per-variable in the naive sense. For stack locals the compiler emits initialization to zero; for heap allocations the runtime hands back pre-zeroed memory (Go's allocator zeroes spans). Zero values per type: numeric `0`, `bool` `false`, `string` `""` (a header of `{ptr=nil, len=0}`), and `nil` for pointers, slices, maps, channels, functions, and interfaces.

**Scope** is resolved entirely at compile time. Go uses *lexical (block) scope*: identifiers are visible from declaration to the end of the enclosing `{ }` block. The compiler walks nested blocks; when it sees `x := ...` inside an inner block while an outer `x` exists, it creates a brand-new variable — a distinct storage location — that shadows the outer one for the rest of that block. No runtime cost; it's purely how the name resolver binds identifiers.

The `:=` operator has one special runtime-irrelevant but semantically critical rule: in `a, b := f()`, at least one variable on the left must be *new*; existing ones are assigned, not redeclared — **but only if they are in the same scope**. Cross-scope, `:=` always creates new variables, which is exactly the shadowing trap.

## 4. Syntax

```go
// Explicit var, type + value
var count int = 10

// var with inference (type omitted)
var name = "ada"

// var with zero value (no initializer)
var ready bool       // false
var buf bytes.Buffer // usable empty buffer

// Short declaration (function bodies only)
total := 0
user, err := fetchUser(id)

// Grouped var block (common at package level)
var (
    host     = "localhost"
    port     = 8080
    timeout  time.Duration // zero value: 0
)

// Multiple assignment / swap
a, b := 1, 2
a, b = b, a

// Blank identifier discards a value
_, err = io.Copy(dst, src)

// Typed constants vs variables (consts are not variables)
const Pi = 3.14159
```

> [!NOTE]
> `:=` is illegal at package scope. Package-level declarations must use `var` (or `const`/`func`). `:=` lives only inside function bodies.

## 5. Common Interview Questions

**Q1. What is the difference between `var x = 0` and `x := 0`?**
*Answer:* Semantically identical results — both create an `int` named `x` initialized to `0`. `var` works at package and function scope; `:=` only inside functions. `:=` requires an initializer and at least one new variable on the left.
*Follow-up: When must you use `var` instead of `:=`?* Package scope; when you want the zero value with no initializer (`var n int`); when you need an explicit type that differs from the inferred one (`var x int64 = 5`); and to declare a variable in an outer scope so an inner `if`/`for` can assign rather than shadow it.

**Q2. What are zero values and why do they matter?**
*Answer:* The default value Go assigns when no initializer is given: `0`, `false`, `""`, `nil`. They guarantee no uninitialized memory and let types be useful without construction (e.g., `var mu sync.Mutex` is ready to lock).
*Follow-up: Is a nil map usable?* You can *read* from a nil map (returns zero values) and `range` it, but *writing* to a nil map panics. A nil slice, by contrast, is fully appendable.

**Q3. Explain variable shadowing with an example bug.**
*Answer:* Shadowing is when an inner-scope declaration reuses an outer name, creating a new variable that hides the outer. Classic bug:
```go
err := doA()
if cond {
    err := doB() // NEW err, shadows outer
    _ = err
}
return err // still the result of doA()!
```
*Follow-up: How do you catch it?* `go vet -vettool=$(which shadow)` or the `shadow` analyzer; in reviews, watch for `:=` inside `if`/`for` blocks that reuse outer names.

**Q4. Does Go allocate variables on the stack or heap, and who decides?**
*Answer:* The compiler decides via escape analysis at compile time. Stack if the lifetime is provably bounded by the frame; heap if a reference escapes. The `&` operator does not force the heap — `p := &x; use(p)` may keep `x` on the stack if `p` doesn't escape.
*Follow-up: How do you inspect it?* `go build -gcflags='-m'` prints escape decisions ("moved to heap", "does not escape").

**Q5. What does `a, b := f()` require, and what happens if both `a` and `b` already exist?**
*Answer:* At least one variable on the left must be new (same scope). If both already exist in the same scope, `:=` is a compile error ("no new variables on left side"); use `=`.
*Follow-up: What if they exist in an outer scope?* Then `:=` in the inner block creates fresh shadowing copies for *both* — no error, but a likely bug.

**Q6. Are loop variables shared across iterations?**
*Answer:* In Go 1.22+, `for` loop variables are per-iteration (a new copy each loop), fixing the long-standing goroutine/closure capture bug. Pre-1.22, they were shared, so capturing the loop var in a goroutine saw the final value.
*Follow-up: How do you write code that's safe on both?* Pre-1.22 idiom: `v := v` inside the loop to rebind per iteration.

**Q7. What is the blank identifier `_` and when is it required?**
*Answer:* A write-only discard. Required to ignore unused return values you must receive (e.g. `_, err := ...`), to import for side effects (`import _ "pkg"`), and to assert type implementation (`var _ Stringer = (*T)(nil)`).
*Follow-up: Does `_ = x` keep an unused variable alive?* No — it's an assignment; the unused-variable rule applies to declared locals, and `_ = x` is the idiom to silence "declared but not used" temporarily.

## 6. Production Use Cases

- **Compile-time interface assertions** (`var _ http.Handler = (*MyHandler)(nil)`) appear across the standard library, Kubernetes, and Docker to catch "type no longer satisfies interface" at build time rather than at runtime.
- **Zero-value-ready types** are a core API design pattern: `sync.Mutex`, `sync.WaitGroup`, `bytes.Buffer`, and `strings.Builder` are all usable without a constructor. Kubernetes' `sync.Once` guards and the standard library's `time.Timer` rely on this.
- **Package-level configuration `var` blocks** hold flags and defaults — e.g., the way `flag.Int` returns a `*int` bound to a package var, or how Prometheus client libraries declare metric collectors as package-scope vars registered in `init()`.
- **Error-handling scope discipline:** large services (the Go source itself, HashiCorp's Terraform, etcd) deliberately declare `err` once and reuse it with `=` across a function to avoid shadowing-induced silent error drops.
- **Escape-analysis-driven hot paths:** high-throughput systems (CockroachDB, the Go GC itself) structure code so hot variables stay on the stack, slashing GC pressure — verified with `-gcflags=-m` in CI benchmarks.

## 7. Common Mistakes

> [!WARNING]
> The single most expensive variable bug in production Go is **shadowing `err`** inside a conditional or loop, causing a real error to be silently discarded and a corrupt result returned.

- **Shadowing in `if`/`for`:** `if x, err := f(); err != nil {...}` creates `x` and `err` scoped to the `if`; if you meant to assign an outer `err`, it's lost.
- **Writing to a nil map:** `var m map[string]int; m["a"] = 1` panics. Initialize with `make` or a literal.
- **Assuming `&` forces heap or that stack means "fast forever":** placement is the compiler's call; reasoning about it without `-m` is guesswork.
- **`:=` redeclaration confusion:** expecting `:=` to reuse an outer variable when it actually shadows it.
- **Unused variables as errors:** Go *refuses to compile* unused locals and unused imports — a feature, but a surprise to newcomers.
- **Pre-1.22 loop capture:** capturing the loop variable in a goroutine/closure and seeing only the last value.

## 8. Performance Considerations

The performance story for variables is almost entirely about **allocation placement**, not declaration syntax (`var` vs `:=` compile to identical code).

| Concern | Stack variable | Heap variable (escaped) |
|---|---|---|
| Allocation cost | ~free (pointer bump) | malloc-like, span management |
| Reclamation | Instant at return | Garbage collector |
| GC pressure | None | Adds to GC scan/mark work |
| Cache locality | Excellent | Worse (scattered) |

Practical guidance:
- Returning a pointer to a local (`return &x`) forces a heap allocation. Sometimes unavoidable; just know the cost.
- Large value types copied by assignment cost CPU; pass pointers for big structs in hot loops — but measure, since the pointer may then escape.
- Closures capturing variables move those captures to the heap. A tight loop creating closures can quietly allocate per iteration.
- Zero-value initialization is essentially free for primitives; for large arrays/structs it is a memclr the compiler often vectorizes.

> [!TIP]
> Run `go build -gcflags='-m -m'` on a hot package and grep for `escapes to heap`. Eliminating a per-request heap variable in a service handling 100k req/s can shave measurable GC CPU and p99 latency.

## 9. Best Practices

- Prefer `:=` inside functions for brevity; use `var` for zero-value declarations, package scope, and explicit non-inferred types.
- Declare variables in the **narrowest scope** that works — ideally inside the `if`/`for` that uses them. This both prevents leaks and *enables* intentional shadowing safely.
- Declare `err` once per function and reuse with `=` when you need the result to survive nested blocks; otherwise embrace scoped `if err := ...; err != nil`.
- Enable the `shadow` vet analyzer in CI.
- Use grouped `var ( ... )` blocks for related package-level config.
- Rely on zero values: design types so the zero value is a valid, useful state (the "make the zero value useful" maxim).
- Avoid naming variables to mirror imported packages or builtins (`len`, `error`, `string`) — it shadows them.

## 10. Code Examples

Primary: idiomatic declaration styles and safe scoping.

```go
package main

import (
	"fmt"
	"strconv"
)

func parseAll(inputs []string) (sum int, err error) {
	// err is the named return; reuse with = to avoid shadowing.
	for _, s := range inputs {
		n, convErr := strconv.Atoi(s) // convErr scoped to loop body
		if convErr != nil {
			err = fmt.Errorf("parse %q: %w", s, convErr)
			return 0, err
		}
		sum += n
	}
	return sum, nil
}

func main() {
	total, err := parseAll([]string{"1", "2", "3"})
	if err != nil {
		fmt.Println("error:", err)
		return
	}
	fmt.Println("sum:", total) // sum: 6
}
```

The buggy alternative below *looks* equivalent but silently drops the error via shadowing — useful to contrast in review.

```go
func parseAllBuggy(inputs []string) (int, error) {
	var sum int
	var err error
	for _, s := range inputs {
		n, err := strconv.Atoi(s) // BUG: := shadows outer err
		if err != nil {
			fmt.Println("logged but lost")
		}
		sum += n // n may be 0 from a failed parse
	}
	return sum, err // always nil — outer err never written
}
```

Demonstrating zero values and escape analysis:

```go
package main

import "fmt"

type Counter struct{ n int } // zero value: {n:0}, ready to use

func newOnStack() int {
	var c Counter // stays on stack — never escapes
	c.n++
	return c.n
}

func newOnHeap() *Counter {
	c := Counter{} // &c escapes via return -> heap
	c.n++
	return &c
}

func main() {
	var s string // ""
	var sl []int // nil but appendable
	sl = append(sl, 1)
	fmt.Printf("%q %v %d %d\n", s, sl, newOnStack(), newOnHeap().n)
}
```

## 11. Advanced Concepts

**Escape analysis nuances.** `&x` does not imply heap allocation. The compiler tracks *reachability*: if every reference dies within the frame, `x` stays on the stack even when its address is taken. Conversely, storing a pointer into an interface, a slice that escapes, or a `sync.Pool` forces escape. Inlining interacts here — an inlined callee may let a variable that *would* escape across a call boundary stay on the stack.

**The named-return-value subtlety.** Named returns (`func f() (err error)`) are pre-declared variables in the function's scope with zero values. They interact with `defer` closures, which can *modify* them after the `return` statement evaluates — a powerful pattern for error wrapping:

```go
func work() (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("recovered: %v", r)
		}
	}()
	panic("boom")
}
```

**Loop variable semantics (Go 1.22 change).** Pre-1.22, the loop variable was one shared cell mutated each iteration; closures captured that cell. Go 1.22 made each iteration get a fresh variable, retroactively fixing thousands of latent bugs. This is gated by the module's `go` directive in `go.mod`, so the behavior depends on the declared language version — a genuine cross-version gotcha when upgrading.

**Package-variable initialization order.** Package-level vars are initialized in *dependency order* (not source order), before `init()` functions run, before `main`. A var that references another is sequenced after it; cycles are a compile error.

## 12. Debugging Tips

- **Find shadowing:** `go vet` with the shadow analyzer: `go install golang.org/x/tools/go/analysis/passes/shadow/cmd/shadow@latest && go vet -vettool=$(which shadow) ./...`.
- **Inspect escape decisions:** `go build -gcflags='-m'` (add a second `-m` for verbosity). Look for `moved to heap`, `escapes to heap`, `does not escape`.
- **See allocations at runtime:** `go test -bench=. -benchmem` reports `allocs/op`; a sudden jump often means a variable started escaping.
- **Delve:** `dlv debug`, then `print x`, `locals`, and `whatis x` to inspect a variable's value, type, and scope at a breakpoint. Shadowed variables show under their respective lexical scopes.
- **Catch nil-map writes early:** the panic message is `assignment to entry in nil map` — search for the variable, ensure a `make`/literal before first write.
- **Unused-variable errors** point exactly at the declaration; if it's a real intent issue, `_ = x` is the temporary silencer (remove before merge).

## 13. Senior Engineer Notes

As a senior, your value with variables is *judgement in code and reviews*, not knowing syntax.

- **Treat scope as the design surface.** When you review a function, mentally map each variable's live range. A variable declared at the top and used only in one branch is a code smell — push it down. This isn't pedantry; narrow scope is what makes shadowing bugs impossible by construction.
- **Hunt `:=` inside `if`/`for`/`switch` that reuses outer names.** This is the highest-yield review heuristic for catching silent error drops. Make the `shadow` analyzer a required CI gate so humans don't have to be the linter.
- **Design zero values deliberately.** When mentoring, push for types whose zero value is valid and useful — it's the difference between an API that needs a fragile `New()` and one that just works. Audit your structs: does `var t T` do something sensible?
- **Know escape analysis well enough to read `-m` output**, but don't prematurely optimize. The mentoring message is: write clear code first, then profile, then chase the *specific* escaping variable the profiler implicates.
- **Calibrate `var` vs `:=` consistency** in the codebase and enforce it via review, not religion. Consistency reduces cognitive load more than any individual choice.

## 14. Staff Engineer Notes

At staff level, variables become a lever for *org-wide reliability and cost*, expressed through standards and architecture.

- **Make shadowing structurally impossible across the org.** Mandate the shadow analyzer in the shared CI template and lint config that every team inherits. One config change prevents a recurring class of incidents across hundreds of services — far higher leverage than reviewing individual PRs.
- **Own the Go-version upgrade story for the loop-variable change.** The 1.22 per-iteration semantics is gated by `go.mod`. When you drive a fleet-wide Go upgrade, you must reason about which services *depended on* the old shared-variable behavior (rare, but real) and stage the `go` directive bump with canaries. This is a cross-team migration, not a flip of a flag.
- **Tie escape analysis to cost.** At fleet scale, per-request heap variables in hot handlers translate into GC CPU that shows up on the cloud bill. Staff engineers set up allocation-regression benchmarks (`benchmem` + `benchstat` in CI) so a PR that makes a hot variable escape is caught before it costs six figures annually.
- **Build-vs-buy framing for safety tooling.** Decide whether to adopt off-the-shelf linters (`golangci-lint` bundling shadow, ineffassign, etc.) versus maintaining custom analyzers. Almost always *buy/adopt* — but you own the decision, the config, and the upgrade cadence.
- **Set the "zero-value-useful" standard in the platform's API guidelines** so library teams design constructible-free types, reducing onboarding friction for every consuming team.

## 15. Revision Summary

- A variable = name + fixed type + storage; always initialized to a **zero value** if no initializer.
- `var` works everywhere (incl. package scope); `:=` is function-body-only and needs ≥1 new variable on the left.
- Zero values: `0`, `false`, `""`, `nil`. Nil maps panic on write; nil slices append fine.
- **Scope** is lexical/block-based, resolved at compile time. **Shadowing** = inner `:=` creating a new var that hides an outer one — the top source of silent `err` bugs.
- **Escape analysis** (compile-time) decides stack vs heap; `&` does not force heap. Inspect with `go build -gcflags=-m`.
- Go 1.22+ gives per-iteration loop variables (gated by `go.mod` version), fixing closure-capture bugs.
- Named returns are pre-declared zero-valued vars; `defer` can mutate them post-`return`.
- Tooling: `shadow` analyzer, `-gcflags=-m`, `-benchmem`, Delve.
- Senior lever: narrow scope + review heuristics. Staff lever: org-wide lint gates, version-upgrade strategy, allocation-cost benchmarks.

**References:** A Tour of Go (Variables, Zero values, Short variable declarations); Go spec — Declarations and scope; `go.dev/blog` loop variable change (Go 1.22).

---
*Go Engineering Handbook — topic 6.*
