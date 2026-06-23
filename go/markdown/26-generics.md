# 26 · Generics

> **In one line:** Go generics let you write type-safe, reusable code with type parameters and constraints, compiled via a hybrid of monomorphization and GC-shape stenciling.

---

## 1. Overview

Generics, introduced in **Go 1.18 (March 2022)**, allow functions and types to be parameterized over types. Instead of writing one `MaxInt`, one `MaxFloat64`, and reaching for `interface{}` plus runtime type assertions for everything else, you write `Max[T constraints.Ordered]` once and the compiler specializes it.

The four pillars you must internalize:

- **Type parameters** — the `[T any]` clause that introduces a type variable.
- **Constraints** — interfaces that restrict what a type parameter can be (`comparable`, `any`, union sets like `~int | ~string`).
- **Type inference** — the compiler deducing type arguments from function arguments so you rarely write `Max[int](a, b)`.
- **The GC shape stencil** — the runtime/compiler mechanism that decides how many machine-code copies of a generic function actually get emitted.

Generics do **not** make Go a different language. They are deliberately conservative: no specialization on values, no variance, no metaprogramming. They target the 80% case — containers, algorithms, and removing `interface{}` boilerplate — while keeping compile times and binary sizes sane.

## 2. Why It Exists

Before 1.18, Go had three bad options for "code that works on many types":

1. **Copy-paste** per type — fast, type-safe, unmaintainable.
2. **`interface{}` (now `any`)** — flexible but loses static typing, forces type assertions, and **boxes** values (heap allocation + indirection).
3. **Code generation** (`go:generate`, `genny`, text/template) — works, but adds a build step and unreadable diffs.

The canonical pain point: a `Sum` function. With `interface{}` you cannot even write `a + b` because the compiler doesn't know `+` is defined. You'd reflect or assert. Generics let the compiler *prove* at compile time that `+` is valid via a constraint.

> [!NOTE]
> Generics were debated for **over a decade**. The accepted design ("Type Parameters Proposal") deliberately rejected templates-style metaprogramming (C++) and reified generics (Java/C#) to preserve Go's fast compilation and predictable runtime.

The keywords to anchor on: **generics** give you **type parameters** restricted by **constraints** (including the built-in **comparable**), resolved via **inference**.

## 3. Internal Working

This is the part most engineers get wrong in interviews. Go does **not** do pure monomorphization (one copy per concrete type, like C++/Rust) nor pure boxing (one copy, everything behind an interface, like early Java). It does **GC shape stenciling with dictionaries** — a hybrid.

**The key idea:** the compiler groups types by their **GC shape**. Two types share a GC shape if they have identical memory layout *from the garbage collector's perspective* — same size, same alignment, and the same pattern of pointer vs non-pointer words.

- `int`, `int64`, `float64` → all "8-byte, no pointers" → **same shape**.
- `*Foo`, `*Bar`, `chan int`, `map[k]v` → all "single pointer word" → **same shape**.
- A `struct{ a, b int }` is a distinct shape from `int`.

The compiler emits **one stenciled copy of the generic function per GC shape**, not per concrete type. To recover the per-type information lost by this grouping (e.g. *which* type's method to call, the type's actual size for `unsafe`, conversions), it passes a hidden first argument: a **dictionary**.

```text
   Caller: Sum[int64](xs)        Caller: Sum[float64](ys)
            |                              |
            v                              v
   +--------------------------------------------------+
   | stencil  Sum<shape: 8byte-no-ptr>(dict, args...) |   <-- ONE copy of machine code
   +--------------------------------------------------+
            ^                              ^
            |                              |
   +-----------------+          +-------------------+
   | dict for int64  |          | dict for float64  |
   |  - type descr   |          |  - type descr     |
   |  - method ptrs  |          |  - method ptrs    |
   |  - sub-dicts    |          |  - sub-dicts      |
   +-----------------+          +-------------------+
```

The **dictionary** is a static, read-only data structure built at compile time containing: the `runtime._type` for each type argument, itab/method pointers needed for any method calls or interface conversions, and pointers to sub-dictionaries for generic functions this one calls.

Consequences you must understand:

- **Pointer-shaped type arguments share a single stencil.** `List[*User]`, `List[*Order]`, `List[chan int]` all run the *same* machine code, parameterized by dictionary. This keeps binary size down but means method calls go through a dictionary lookup (an indirect call) — not always inlined.
- **Value types of distinct shapes get distinct stencils.** `List[int]` and `List[struct{x,y int}]` are different code.
- This is why generic method calls can be **slower than monomorphized C++** but **faster and safer than `interface{}`** boxing in many cases.

> [!WARNING]
> The dictionary + stenciling design means the compiler sometimes **cannot inline** through a type parameter the way it inlines a concrete call. This is the root cause of the "generics are slower than I expected" surprise (see §8).

## 4. Syntax

```go
// Type parameter list in square brackets after the name.
func Map[T, U any](s []T, f func(T) U) []U {
	r := make([]U, len(s))
	for i, v := range s {
		r[i] = f(v)
	}
	return r
}

// Constraint as an interface with a union of underlying types.
type Number interface {
	~int | ~int64 | ~float64 // ~ means "any type whose underlying type is this"
}

func Sum[T Number](xs []T) T {
	var total T // zero value of T
	for _, x := range xs {
		total += x
	}
	return total
}

// Generic type. Method receivers reuse the type parameters; they cannot add new ones.
type Stack[T any] struct{ items []T }

func (s *Stack[T]) Push(v T) { s.items = append(s.items, v) }
func (s *Stack[T]) Pop() (T, bool) {
	var zero T
	if len(s.items) == 0 {
		return zero, false
	}
	v := s.items[len(s.items)-1]
	s.items = s.items[:len(s.items)-1]
	return v, true
}

// comparable: built-in constraint for == and != (map keys, sets).
func Contains[T comparable](s []T, target T) bool {
	for _, v := range s {
		if v == target {
			return true
		}
	}
	return false
}
```

Type inference in action:

```go
Sum([]int{1, 2, 3})            // T inferred as int — no [int] needed
Map([]int{1, 2}, strconv.Itoa) // T=int, U=string both inferred
Sum[int64]([]int64{1, 2})      // explicit only when inference can't help
```

## 5. Common Interview Questions

**Q1. Does Go monomorphize generics like C++?**
*Answer:* No. Go uses GC-shape stenciling with runtime dictionaries. One machine-code copy is emitted per distinct GC shape (memory layout), and a hidden dictionary argument supplies per-type info. All pointer-shaped type args share one stencil.
*Follow-up: Why not full monomorphization?* To bound binary size and keep compilation fast — full monomorphization can explode code size with many type args.

**Q2. What is `comparable` and why isn't it just `any`?**
*Answer:* `comparable` permits `==`/`!=` and allows the type to be a map key or set element. `any` does not guarantee comparability (slices, maps, funcs aren't comparable). Using `comparable` is how you write `Set[T comparable]`.
*Follow-up: Are interface types comparable?* Yes statically, but comparing interfaces holding incomparable dynamic types **panics at runtime** — a known sharp edge (Go 1.20 loosened `comparable` to permit such types, accepting the panic risk).

**Q3. Can methods have their own type parameters?**
*Answer:* No. Methods may use the type's parameters but cannot introduce new ones. If you need a method generic over an unrelated type, make it a free function.
*Follow-up: Why the restriction?* Allowing it would break Go's method-set/interface model and complicate the dictionary scheme.

**Q4. What does `~int` mean in a constraint?**
*Answer:* The `~` (tilde / underlying-type) operator matches any type whose **underlying type** is `int`, so a named type `type Celsius int` satisfies `~int`. Without `~`, only `int` itself matches.
*Follow-up: When would you omit `~`?* When you intentionally want to exclude named/derived types.

**Q5. How does type inference decide type arguments?**
*Answer:* In stages: function-argument inference (match arg types to parameter types), then constraint type inference (use the constraint's core type), then defaulting of untyped constants. If anything is ambiguous you must annotate explicitly.
*Follow-up: Why can't return-type-only inference work?* Go infers from arguments, not from the expected result type at the call site, so `x := New[...]()` with no args needs explicit type arguments.

**Q6. Are generics always faster than `interface{}`?**
*Answer:* No. They're type-safe and avoid boxing of value types, but dictionary-based indirect calls can prevent inlining, sometimes making a generic method call *slower* than a well-optimized concrete or even interface path. Always benchmark.
*Follow-up: When is the win largest?* Containers of value types (`[]int`, big structs) where boxing would allocate; and removing `interface{}` + assertion code.

**Q7. Can you constrain a type parameter to have a specific method?**
*Answer:* Yes — a constraint is just an interface, so it can list methods: `type Stringer interface{ String() string }`. You can even combine method requirements and type unions in the same constraint.
*Follow-up: Can a constraint mix methods and a type union?* Yes, but the union types must implement those methods, which restricts unions effectively to types you control.

## 6. Production Use Cases

- **Standard library `slices` and `maps` packages** (Go 1.21): `slices.Sort`, `slices.Contains`, `slices.Index`, `maps.Keys`. These replaced thousands of hand-rolled loops across the ecosystem and are the canonical "use generics here" example.
- **`golang.org/x/exp/constraints`** — `Ordered`, `Integer`, `Float` constraints used widely before some moved to `cmp` (Go 1.21 `cmp.Ordered`).
- **Concurrency primitives** — typed pools, and libraries like `sourcegraph/conc` providing typed `WaitGroup`, `pool.ResultPool[T]`, eliminating `interface{}` in fan-out/fan-in code.
- **Functional helpers** — `samber/lo` (Lodash for Go): `lo.Map`, `lo.Filter`, `lo.GroupBy`, all generic. Heavily used in microservice glue code.
- **Result/Option types** — many teams define `Result[T]` / `Option[T]` for error handling pipelines (used at fintech and infra shops to avoid `(T, error)` tuple juggling).
- **Type-safe caches and stores** — `Cache[K comparable, V any]` over LRU implementations (e.g. `hashicorp/golang-lru/v2`, which is itself generic).
- **ORM / query builders** — `ent` and `gorm` adjacent helpers use generics for typed query results, replacing `interface{}` scan targets.

## 7. Common Mistakes

> [!WARNING]
> **Reaching for generics when an interface is clearer.** If you only ever call *methods* on the value and never need the concrete type or `==`, a plain interface parameter is simpler and inlines fine. Generics shine when you need the *operator set* (`+`, `<`) or *value identity* without boxing.

- **Adding type parameters methods can't use.** Trying `func (s Stack[T]) MapTo[U any]...` — illegal; methods can't add type params.
- **Forgetting `comparable` for map keys.** `map[T]bool` requires `T comparable`; using `any` won't compile.
- **Over-constraining with concrete unions** when a method constraint would be more extensible.
- **Assuming zero-cost like C++ templates.** Indirect dictionary calls can defeat inlining (see §8).
- **Incomparable-interface panics.** `comparable` (post-1.20) lets interface types through, so `==` may panic at runtime if the dynamic type is a slice/map/func.
- **`var zero T` confusion.** This is the idiomatic way to get a zero value; people incorrectly try `nil` or `T{}` (the latter only works for struct-like types).

## 8. Performance Considerations

| Aspect | `interface{}` (boxing) | Generics (stencil + dict) | Monomorphized (C++/Rust) |
|---|---|---|---|
| Value-type storage | Heap-boxed, allocates | Stored inline, no alloc | Inline |
| Method dispatch | itab indirect call | dictionary indirect call | direct, inlinable |
| Inlining | rarely | sometimes blocked | aggressive |
| Binary size | smallest | moderate | can be large |
| Type safety | runtime | compile time | compile time |

Concrete realities:

- For `Sum[int]` over a slice, generics avoid the boxing/allocation that `[]interface{}` would cause — often a **clear win** and zero extra allocations.
- For generic functions that call a *method* on `T`, the call routes through the dictionary as an **indirect call** that the inliner frequently cannot flatten. Benchmarks have shown generic method-heavy code matching or *trailing* an equivalent interface version.
- **All pointer-shaped instantiations share one stencil**, so a `Cache[string, *T]` for 50 different `*T` produces one copy — good for cache locality and binary size, but every per-type op goes through the dict.

> [!TIP]
> Rule of thumb: benchmark with `go test -bench . -benchmem` and inspect `-gcflags=-m` for inlining decisions before claiming a generic rewrite is "faster." Optimize for clarity first; reach for generics-for-speed only with numbers.

## 9. Best Practices

- **Write the concrete version first.** Only generalize when you have *two or more* real call sites that differ solely by type. Premature generics are as bad as premature abstraction.
- **Constrain to the smallest interface** that admits the operations you use. Prefer method constraints over big type unions for extensibility.
- **Prefer the standard library** (`slices`, `maps`, `cmp`) before writing your own generic helpers.
- **Use `any`, not `interface{}`** in new code (alias added in 1.18).
- **Keep type-parameter names short and conventional**: `T`, `K`, `V`, `E`, `U`.
- **Return `var zero T`** for the zero value; don't invent alternatives.
- **Don't export a generic type just because you can** — APIs with many type parameters are hard to read; consider whether an interface boundary is cleaner for callers.

## 10. Code Examples

Primary idiomatic example — a type-safe `Set` and an ordered `Min`:

```go
package collections

import "cmp" // Go 1.21+: cmp.Ordered

// Set is a generic set requiring comparable elements (map-key constraint).
type Set[T comparable] map[T]struct{}

func NewSet[T comparable](items ...T) Set[T] {
	s := make(Set[T], len(items))
	for _, it := range items {
		s[it] = struct{}{}
	}
	return s
}

func (s Set[T]) Add(v T)      { s[v] = struct{}{} }
func (s Set[T]) Has(v T) bool { _, ok := s[v]; return ok }

// Min uses cmp.Ordered so it works for any orderable type.
func Min[T cmp.Ordered](xs ...T) (T, bool) {
	if len(xs) == 0 {
		var zero T
		return zero, false
	}
	m := xs[0]
	for _, x := range xs[1:] {
		if x < m {
			m = x
		}
	}
	return m, true
}
```

```go
package collections

// Alternative: constrain on a METHOD instead of a type union, which is more
// extensible because callers can implement the interface on their own types.
type Lesser[T any] interface {
	Less(other T) bool
}

func MinBy[T Lesser[T]](xs ...T) (T, bool) {
	if len(xs) == 0 {
		var zero T
		return zero, false
	}
	m := xs[0]
	for _, x := range xs[1:] {
		if x.Less(m) {
			m = x
		}
	}
	return m, true
}

// A domain type implements Less and gets MinBy for free.
type Money struct{ Cents int64 }

func (m Money) Less(o Money) bool { return m.Cents < o.Cents }
```

A standalone real-world helper using the standard library `slices` package:

```go
package main

import (
	"fmt"
	"slices"
)

func main() {
	users := []string{"carol", "alice", "bob"}
	slices.Sort(users)                         // generic sort, no less func
	fmt.Println(slices.Contains(users, "bob")) // true
	fmt.Println(slices.Index(users, "carol"))  // 2
}
```

## 11. Advanced Concepts

- **Core types & constraint type inference.** A constraint has a *core type* when all its union elements share one underlying type; the compiler uses it both for inference and to allow operations (e.g. indexing, `range`). A union with no common core type restricts what you can do with `T`.
- **Type sets, not type lists.** A constraint defines a *set* of types (the intersection of its embedded interfaces and unions). Reasoning about constraints = reasoning about set membership.
- **Recursive / self-referential constraints.** `Lesser[T]` above references `T` in its own method signature — the F-bounded polymorphism pattern, common for comparable domain types.
- **Generic type aliases (Go 1.24, 2025).** Aliases can now take type parameters: `type Vec[T any] = []T`, enabling lighter API surfaces.
- **Inference improvements in 1.21+.** Reverse type inference and better handling of generic function values passed as arguments reduced the need for explicit `[T]` annotations.
- **Dictionaries and the GC.** Dictionaries are static read-only globals; they participate in linking, which is why heavy generic instantiation can grow binaries even though code is shared by shape.

```text
Constraint Number = ~int | ~int64 | ~float64
                    \__________  __________/
                               \/
                 type set = { all types whose underlying
                              type is int, int64, or float64 }
   core type = a numeric kind -> +,-,*,/,< allowed,
               but NOT string concat or indexing.
```

## 12. Debugging Tips

- **`cannot infer T`** — supply explicit type arguments `Fn[Type](...)`. Usually means inference had nothing to anchor on (often a return-only generic constructor).
- **`T does not satisfy constraint`** — check whether you need `~` in the constraint (named type slipping through), or whether the type genuinely lacks a required method.
- **`invalid operation: ... (type T ...)`** — you used an operator (`+`, `<`, indexing) the constraint doesn't permit; widen the constraint or use a method.
- Inspect emitted instantiations and inlining with `go build -gcflags="-m -m"`; look for `inlining call to` vs dictionary calls.
- Use `go tool compile -S` to confirm whether two instantiations share a stencil (same symbol) — useful when reasoning about binary bloat.
- Runtime `comparing uncomparable type` panic → you compared `comparable`-constrained interface values holding slices/maps/funcs; guard with reflection or redesign.

## 13. Senior Engineer Notes

As a senior engineer, your job is **judgment at the code/design level**:

- In code review, push back on generics that wrap a single concrete type — that's obfuscation. Ask "where's the second instantiation?" If there's only one, it's a concrete function.
- Coach the team on the **interface-vs-generic** decision: methods-only → interface; operators/value-identity/no-boxing → generic. Make this a documented team heuristic.
- Watch for **constraint creep** — a `Number` union that keeps growing is a smell that you actually want a method constraint or a different abstraction.
- Insist on **benchmarks** when a PR claims generics improved performance; you've seen "obvious" generic rewrites regress due to lost inlining.
- Mentor juniors on `var zero T`, the `~` operator, and why methods can't add type parameters — these are the top three confusions.
- Keep public APIs **readable**: a function with four type parameters is a design failure; prefer a small interface boundary that callers find approachable.

## 14. Staff Engineer Notes

At staff level the lens widens to **architecture, cross-team standards, and build-vs-buy**:

- **Set org-wide conventions**: standardize on stdlib `slices`/`maps`/`cmp` and a single sanctioned helper library (e.g. `samber/lo` or an internal one) rather than letting every team grow its own generic utility grab-bag. Fragmentation here costs more than any micro-optimization.
- **Binary-size and build-time budgets**: in large monorepos, unbounded generic instantiation contributes to binary growth and link time. Track it; the shape-stencil model bounds the worst case but pointer-heavy plus many value-type instantiations still add up. Make it a measured budget, not a guess.
- **Build-vs-buy on abstractions**: deciding whether to expose a generic `Repository[T]` framework across services is an org bet. Generic frameworks can ossify into a hard-to-evolve internal platform; sometimes plain interfaces plus code review scale better socially than a clever generic core.
- **API evolution risk**: type parameters are part of your public contract. Adding/removing a constraint or type parameter is a **breaking change**. For platform libraries, treat generic signatures with the same SemVer rigor as any exported API.
- **Performance at the fleet level**: a generic indirect-call regression that's 5ns in a microbenchmark can be material when it sits in a hot path called billions of times daily. Staff engineers connect microbenchmark insight to fleet-wide CPU cost and capacity planning.
- **Migration strategy**: when standardizing the codebase on generics (e.g. replacing `interface{}` containers), drive it as a staged, tooling-assisted migration with benchmarks gating the rollout, not a big-bang refactor.

## 15. Revision Summary

- Generics (Go 1.18) = **type parameters** + **constraints** + **inference**.
- Implementation = **GC-shape stenciling + dictionaries**, *not* full monomorphization and *not* boxing. One code copy per memory shape; all pointer types share one stencil.
- **`comparable`** enables `==`/map keys; **`~T`** matches underlying type; **`var zero T`** gives the zero value.
- Methods **cannot** add their own type parameters.
- Performance: avoids value boxing (win) but dictionary indirect calls can block inlining (sometimes a loss) — **benchmark**.
- Prefer stdlib `slices`/`maps`/`cmp`; generalize only with 2+ real instantiations; smallest constraint wins.
- Constraints define **type sets**; a common **core type** unlocks operators like `+`, `<`, indexing.
- Senior: code/design judgment, interface-vs-generic heuristic, mentoring. Staff: org conventions, binary/build budgets, breaking-change/SemVer discipline, build-vs-buy.

**References:** Go generics tutorial (go.dev/doc/tutorial/generics); Type Parameters Proposal; `go.dev/blog/intro-generics` and `go.dev/blog/deconstructing-type-parameters`; stdlib `slices`, `maps`, `cmp` packages.

---

*Go Engineering Handbook — topic 26.*
