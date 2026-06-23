# 25 · Type Switches

> **In one line:** A type switch dispatches control flow on the *dynamic* type sitting inside an interface value, giving you safe, readable multi-way branching for error inspection, decoding, and polymorphic plumbing.

---

## 1. Overview

A **type switch** is a control structure that branches on the *concrete type* held by an interface value rather than on a value's equality. Where a regular `switch` compares values, a type switch compares *types*. It is the structured, multi-arm sibling of the single type assertion `v, ok := x.(T)`.

The canonical form binds a new variable per case so each arm sees the value already converted to the matched type:

```go
switch v := x.(type) {
case int:
    // v is an int here
case string:
    // v is a string here
default:
    // v has x's original interface type
}
```

Type switches matter because Go's static type system intentionally erases concrete types behind interfaces (`error`, `io.Reader`, `any`). When you need to *recover* that lost information at runtime — to inspect an error, decode a JSON tree, or route a message — the type switch is the idiomatic, compiler-blessed tool. This chapter treats it as a production instrument: how the runtime implements it, where it shines, where it quietly costs you, and how senior and staff engineers reason about it.

## 2. Why It Exists

Go has no generics-by-default polymorphism for *behaviorless* data and no sum types (tagged unions). Interfaces are the substitute: an interface value carries a `(type, value)` pair. But once data is "boxed" into an interface, the static type checker can no longer prove what's inside. You need a runtime mechanism to ask "what *are* you, really?" and act accordingly.

Three forces drove the design:

- **Decoding untyped data.** `encoding/json` unmarshals into `any`, producing a tree of `map[string]any`, `[]any`, `float64`, `string`, `bool`, and `nil`. Walking that tree *requires* dynamic dispatch on type.
- **Error inspection.** Before `errors.Is`/`errors.As` existed, the only way to distinguish a `*net.OpError` from an `*os.PathError` was a type switch. It is still close to the mechanism `errors.As` uses under the hood, and still the clearest way to handle a *closed set* of error types in one place.
- **Avoiding the assertion ladder.** Without a type switch you'd write a chain of `if v, ok := x.(A); ok { ... } else if v, ok := x.(B); ok { ... }`. The type switch collapses that into one readable, mutually-exclusive block with a single bound variable per arm.

> [!NOTE]
> A type switch is fundamentally about **dispatch on dynamic type**. If you find yourself switching on a `Kind` field or a string tag you control, you probably want a regular `switch` or an interface method instead — see §7 and §13.

## 3. Internal Working

To understand the type switch you must understand the **interface value**. Every non-empty interface (one with methods, like `error`) is a two-word structure: a pointer to an `itab` and a pointer to the data. Every empty interface (`any`) is also two words: a pointer to the type descriptor `_type` and a pointer to the data.

```text
  any (eface)                      error (iface)
 +-------------+                  +-------------+
 |  *_type     | --> type info    |  *itab      | --> itab{ inter, _type, fun[] }
 +-------------+                  +-------------+               |
 |  data ptr   | --> heap/stack   |  data ptr   |              v
 +-------------+                  +-------------+        the concrete *_type
```

The `_type` descriptor holds size, kind, a type hash, and equality/hash function pointers. The `itab` ("interface table") caches the concrete type plus a method dispatch vector for a *specific* (interface, concrete-type) pair.

When the compiler sees a type switch, it does **not** emit a linear chain of `runtime.assert*` calls for every case. Instead:

1. It loads the interface's type word (the `*_type`, or for `iface` the `*_type` reachable via the `itab`).
2. For **concrete-type cases**, it compares the type pointer (and a precomputed type hash) directly — pointer-equality of `_type` is the fast path. Distinct concrete types have distinct `_type` singletons, so this is a cheap word compare.
3. For **interface-type cases** (e.g. `case io.Reader:`), it cannot use pointer equality; it must ask the runtime whether the concrete type *implements* that interface. This calls into `runtime.assertE2I`/`assertI2I`, which computes or fetches the `itab` for that pair. The first lookup populates a global `itabTable` (a hash map keyed by `(inter, _type)`); subsequent lookups hit the cache.

For switches with many concrete cases, the compiler can emit a **hash-based jump** rather than a linear scan: it uses the type's hash to index a generated table, turning an O(n) chain into roughly O(1) dispatch. This is analogous to how it compiles dense integer switches into jump tables.

> [!NOTE]
> Key takeaway for performance reasoning (§8): a case on a **concrete type** is a cheap pointer/hash compare; a case on an **interface type** may trigger an `itab` computation and is meaningfully more expensive on the cold path.

The bound variable `v := x.(type)` is purely a compile-time convenience: in a concrete-type arm, `v` is the *unboxed* value (the data word reinterpreted as `T`); in the `default` and multi-type arms, `v` keeps `x`'s static interface type.

## 4. Syntax

```go
// Long form: bind v, inspect type.
switch v := x.(type) {
case nil:
    fmt.Println("x holds no value (nil interface)")
case int, int64:
    // multi-type case: v keeps x's interface type (e.g. any), NOT int
    fmt.Println("an integer", v)
case string:
    fmt.Println("string of length", len(v)) // v is string here
case io.Reader:
    // interface case: matches any concrete type implementing io.Reader
    _, _ = io.ReadAll(v)
default:
    fmt.Printf("unhandled %T\n", v)
}

// Short form without binding when you only need the branch:
switch x.(type) {
case error:
    // ...
}

// With an init statement, like a normal switch:
switch y := getValue(); v := y.(type) {
case bool:
    _ = v
}
```

Rules worth memorizing as *behavior*, not trivia:

- `case nil` matches when the interface itself is nil.
- A case listing **multiple types** does **not** convert `v` to a single type; `v` retains the switch operand's type.
- Cases must be **distinct**; duplicate concrete types are a compile error.
- A concrete type and an interface it satisfies can both appear — the first matching case in source order wins, so order interface cases *after* the concrete ones you want to special-case.

## 5. Common Interview Questions

**Q1. What is the difference between a type switch and a type assertion?**
A type assertion `v, ok := x.(T)` tests one type and returns a comma-ok result; a type switch tests many types in one mutually-exclusive block and binds the converted value per arm. *Follow-up: which is faster?* For a single check the assertion is marginally cheaper (no dispatch table), but for N alternatives the switch is both faster (possible hash jump) and clearer.

**Q2. In `case int, string:` what is the type of `v`?**
It is the static type of the switch operand (e.g. `any` / `error`), **not** `int` or `string`. The compiler can't pick one type for a multi-type arm. *Follow-up: how do you get the concrete value?* Split into single-type cases, or re-assert inside the arm.

**Q3. How does `errors.As` relate to type switches?**
`errors.As` unwraps the error chain and, at each level, checks assignability to the target's type — effectively a programmatic type assertion across the chain. A type switch only inspects the *top* error, so prefer `errors.As`/`errors.Is` for *wrapped* errors. *Follow-up: when is a raw type switch still correct?* When you handle a closed set of sentinel/struct error types you produce and do not wrap, or inside `As`-incompatible legacy code.

**Q4. What happens if no case matches and there's no default?**
Nothing — control falls through past the switch with no panic (unlike a single assertion without comma-ok, which *panics* on mismatch). *Follow-up: how do you make missing cases loud?* Add a `default` that logs/panics, or return an `unsupported type %T` error.

**Q5. Can a type switch match interface types, and what's the cost?**
Yes — `case io.Reader:` matches any concrete type implementing it via an `itab` lookup, which is more expensive than a concrete pointer compare on the cold path but cached afterward. *Follow-up: ordering?* Put concrete cases before interface cases since first match wins.

**Q6. Why does `var err error = (*MyErr)(nil); switch err.(type) { case *MyErr: }` match even though the value is nil?**
Because the interface holds a non-nil *type* (`*MyErr`) with a nil *data* pointer — the type word drives the switch. This is the classic "typed nil" trap. *Follow-up: how to guard?* Check `v == nil` inside the `*MyErr` arm or avoid returning typed nils.

**Q7. Is `switch x.(type)` legal without binding a variable?**
Yes; use it when you only need the branch, not the value. *Follow-up: any lint concern?* `go vet` won't complain, but if you bind `v` and never use it in *any* arm the compiler reports it; using it in at least one arm is fine.

**Q8. How would the compiler optimize a 50-case type switch?**
By generating a hash table keyed on the type hash for an O(1) jump rather than 50 sequential compares, similar to dense integer switch compilation.

## 6. Production Use Cases

- **JSON / config tree walking.** Every system using `json.Unmarshal` into `any` (feature-flag payloads, generic webhook bodies, `map[string]any` configs) walks the result with a type switch over `float64/string/bool/map[string]any/[]any/nil`. Kubernetes' `unstructured` objects and Helm value merging do exactly this.
- **Error classification at boundaries.** Database drivers (`lib/pq`, `pgx`) expose `*pgconn.PgError`; HTTP middleware switches on error type to map to status codes (e.g. `*json.SyntaxError` → 400, `context.DeadlineExceeded` → 504). gRPC's `status.FromError` performs equivalent dispatch.
- **AST and IR processing.** `go/ast` is walked almost entirely with type switches over `*ast.Ident`, `*ast.CallExpr`, etc. Every Go linter (`staticcheck`, `golangci-lint`) is a giant type switch over node types. Compilers and template engines (`text/template`'s reflection-driven `printableValue`) follow the same shape.
- **Event/message routing.** Event-sourced systems and CQRS handlers dispatch on event type: `switch e := evt.(type) { case OrderPlaced: ... case OrderShipped: ... }`. Temporal and NATS-based pipelines use this for in-process demultiplexing.
- **Reflection-lite fast paths.** Libraries like `zap` and `logrus` type-switch over common concrete types (`string`, `int`, `error`) before falling back to slow `reflect`-based formatting, a real latency win in hot logging paths.

## 7. Common Mistakes

> [!WARNING]
> **Typed-nil interface.** A `(*T)(nil)` stored in an interface is **not** `== nil` and *will* match `case *T:`. Returning a typed nil from a function with an `error` return is the #1 production bug this pattern surfaces.

- **Expecting `v` to be the concrete type in multi-type cases.** As in Q2, `case int, int64:` leaves `v` as the interface type.
- **Using a type switch where `errors.Is/As` is correct.** A raw switch ignores wrapped errors (`fmt.Errorf("...: %w", err)`), so it silently fails to match the cause.
- **Forgetting `default`.** Silent fall-through hides unhandled types until production. Always add a `default` that errors or logs `%T`.
- **Ordering interface cases before concrete ones.** First match wins; an early `case error:` will shadow a later `case *MyError:`.
- **Switching on type to simulate a sum type you control.** If you own all the implementations, an interface method (virtual dispatch) is usually cleaner and avoids the "forgot to add a case" class of bugs (§13).
- **Asserting on pointer vs value mismatch.** `case MyError:` will not match a `*MyError` value, and vice versa.

## 8. Performance Considerations

| Operation | Relative cost | Notes |
|---|---|---|
| `case ConcreteType` | cheapest | pointer/hash compare of `_type` |
| Multi-case concrete (`A, B, C`) | cheap → O(1) | compiler may hash-jump for many cases |
| `case InterfaceType` (cold) | moderate | `itab` computation, global table insert |
| `case InterfaceType` (warm) | low | cached `itab` lookup |
| `default` only fall-through | free | no runtime call |

Concrete figures: a concrete-type arm is on the order of a few nanoseconds — comparable to a map lookup miss avoided. The first `itab` resolution for an interface case can be tens to low-hundreds of nanoseconds and may take a runtime lock on the `itabTable` under contention, though Go caches aggressively so steady-state cost is small.

Practical guidance:

- Put the **most frequent** concrete cases first if the switch isn't dense enough to be hash-jumped.
- In hot paths (logging, serialization), a type switch over common concretes is far cheaper than `reflect.ValueOf(x).Kind()` — prefer it as a fast path and fall back to reflection only in `default`.
- Avoid type switches *inside tight loops* over heterogeneous slices if you can hoist the dispatch out (group by type once, process in batches).

## 9. Best Practices

- Always bind: `switch v := x.(type)` unless you genuinely don't need the value.
- Add a `default` arm that surfaces unhandled types loudly (`return fmt.Errorf("unsupported type %T", v)`).
- Order **concrete before interface** cases; order **frequent before rare** when not hash-jumped.
- Prefer `errors.As`/`errors.Is` for error chains; reserve raw type switches for top-level, unwrapped, closed sets.
- Keep the *closed set* small. A growing type switch is a smell that you want an interface method or a generic.
- Guard typed nils explicitly inside pointer-type arms.
- Co-locate the switch with the type definitions so reviewers notice when a new type needs a new arm; consider an exhaustiveness linter for sealed interface sets.

## 10. Code Examples

Primary: walking an arbitrary JSON value decoded into `any`, with an alternative error-classification approach shown as a switchable tab.

```go
package main

import (
	"encoding/json"
	"fmt"
	"strings"
)

// describe returns a human-readable summary of a decoded JSON value.
func describe(v any) string {
	switch t := v.(type) {
	case nil:
		return "null"
	case bool:
		return fmt.Sprintf("bool(%v)", t)
	case float64: // JSON numbers decode to float64
		return fmt.Sprintf("number(%g)", t)
	case string:
		return fmt.Sprintf("string(%q)", t)
	case []any:
		parts := make([]string, len(t))
		for i, e := range t {
			parts[i] = describe(e)
		}
		return "[" + strings.Join(parts, ", ") + "]"
	case map[string]any:
		parts := make([]string, 0, len(t))
		for k, e := range t {
			parts = append(parts, fmt.Sprintf("%q:%s", k, describe(e)))
		}
		return "{" + strings.Join(parts, ", ") + "}"
	default:
		return fmt.Sprintf("unknown(%T)", t)
	}
}

func main() {
	var data any
	_ = json.Unmarshal([]byte(`{"id":1,"tags":["a","b"],"ok":true}`), &data)
	fmt.Println(describe(data))
}
```

```go
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
)

// classify maps an error to an HTTP-ish status using idiomatic inspection.
// errors.As handles WRAPPED errors; the type switch handles the closed set
// of concrete/interface types we recognize at the top level.
func classify(err error) int {
	if err == nil {
		return 200
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) {
		return 404
	}
	switch e := err.(type) {
	case net.Error:
		if e.Timeout() {
			return 504
		}
		return 502
	case *json.SyntaxError:
		return 400
	default:
		return 500
	}
}

func main() {
	fmt.Println(classify(&net.DNSError{IsTimeout: true})) // 504
}
```

The first example shows the *decoding* role; the second shows the *error-classification* role combined with `errors.As` for wrapped chains — the two dominant production uses.

## 11. Advanced Concepts

- **Sealed interfaces (poor-man's sum types).** Give an interface an unexported marker method (`isExpr()`); only types in your package can implement it. A type switch over that interface then has a *known, closed* set of cases. Pair with an exhaustiveness linter to fail CI when someone adds a variant without updating switches. This is how `go/ast`-style and many parser packages encode ADTs.

- **Generics interplay.** Type switches and type parameters solve different problems: generics give you *compile-time* monomorphic specialization over a type set; type switches give you *runtime* dispatch over an interface. Inside generic code you sometimes need a type switch to special-case a concrete type — but note you cannot switch on a *type parameter* directly; you switch on a value, e.g. `switch v := any(value).(type)`.

- **`reflect` vs type switch.** A type switch handles a fixed, known set cheaply; `reflect` handles *unbounded* types at higher cost. Idiom: type-switch the common concretes, then `reflect` in `default`.

- **itab internals & `assertI2I2`.** The two-result interface assertion (`v, ok := x.(SomeInterface)`) compiles to a runtime helper that probes the `itabTable`; understanding this explains why interface cases cost more than concrete ones (§3, §8).

> [!TIP]
> For a sealed set, route *all* logic through a single `func switchExpr(e Expr) ...`. Centralizing the switch means adding a variant fails to compile or lint in exactly one place if you also use a constructor pattern.

## 12. Debugging Tips

- **Print `%T`.** `fmt.Printf("%T\n", x)` reveals the exact dynamic type — the fastest way to see why a case didn't match (pointer vs value, wrong package path, typed nil shows the type not `<nil>`).
- **Typed-nil checks.** If `case *T:` matches unexpectedly, log `x == nil` and `reflect.ValueOf(x).IsNil()` to confirm a typed nil.
- **Wrapped-error misses.** If an error case never fires, the error is probably wrapped — switch to `errors.As` or print `%+v` and walk the chain via `errors.Unwrap` in a loop.
- **`go vet`** flags impossible type assertions (a type that can't implement an interface). Run it; it catches dead cases.
- **Exhaustiveness.** Use a linter for sealed interfaces to catch the "added a variant, forgot a case" bug that no compiler error reveals.
- **Disassembly.** `go tool objdump` / `go build -gcflags=-S` shows whether your switch became a hash jump or a linear chain — useful when profiling a hot dispatch.

## 13. Senior Engineer Notes

A senior engineer's judgement on type switches is mostly about *when not to use one*. The default question in review: "Could this be a method on the interface instead?" If every arm calls a behaviorally-equivalent operation (`Render()`, `Validate()`, `Cost()`), virtual dispatch via an interface method is more maintainable — adding a new type can't silently skip logic. Reserve the type switch for cases where the *caller* owns behavior the types shouldn't know about (e.g. a UI layer rendering domain objects it must not depend on).

In reviews, flag: missing `default`, interface cases ordered before concrete ones, raw switches that should be `errors.As`, and switches that have grown past ~6 arms (a refactor signal). When mentoring, the highest-leverage lesson is the **typed-nil trap** and the **multi-case `v` type** rule — both surface in real outages and are non-obvious.

Senior-level design heuristic: a type switch is acceptable when the set of types is *closed and stable*; it is a liability when the set is *open and growing*, because each new type is a hidden edit across every switch. Encode closed sets with sealed interfaces so the compiler and linters become your safety net.

## 14. Staff Engineer Notes

At staff scope the concern shifts from one switch to **how type-based dispatch shapes a codebase's coupling**. Type switches centralize knowledge of a type set in the *consumer*; interface methods distribute it to the *producers*. That choice has org-level consequences: a plugin architecture where third parties add types must use interface methods (you can't ship code into their packages), whereas a tightly-owned domain core may prefer centralized switches for auditability and a single place to enforce policy.

Cross-team trade-off: shared "any-typed" boundaries (event buses, generic config, gateways that pass `any`) push type switches to every consumer, multiplying the maintenance surface. The staff move is to define a **typed schema or sealed interface at the boundary** so each consumer dispatches against a contract the platform team owns, with exhaustiveness checks in CI. This is build-vs-buy in miniature: a code-generated, schema-driven dispatcher (protobuf oneof, a generated visitor) often beats hand-rolled type switches once more than two or three teams depend on the same set.

Staff engineers also weigh performance at fleet scale: in a gateway doing millions of dispatches per second, the difference between concrete-case hash jumps and interface-case `itab` lookups is real CPU and dollars. Standardize on concrete-type fast paths in shared libraries (logging, serialization) and document the pattern so teams don't each rediscover the reflection cliff. Finally, treat the sealed-interface-plus-exhaustiveness-linter combination as a paved road: it converts a whole class of "forgot a case" incidents into compile/CI failures across the org.

## 15. Revision Summary

- A type switch dispatches on an interface's **dynamic type**: `switch v := x.(type) { case T: ... }`.
- Interface value = two words: type descriptor (`_type`/`itab`) + data pointer. The switch reads the type word.
- **Concrete-type cases** = cheap pointer/hash compare; **interface-type cases** = `itab` lookup, costlier on the cold path. Many cases may compile to a hash jump.
- In `case A, B:`, `v` keeps the **operand's interface type**, not `A` or `B`.
- `case nil` matches a nil interface; **typed nil** `(*T)(nil)` matches `case *T:`, not `case nil`.
- No match + no `default` = silent fall-through (no panic, unlike a single assertion).
- Prefer **`errors.As`/`errors.Is`** for wrapped errors; use raw switches for closed, top-level type sets.
- Order **concrete before interface**, **frequent before rare**; always add a loud `default`.
- Prefer **interface methods** over switches for open/growing type sets; encode closed sets as **sealed interfaces** with exhaustiveness linting.
- Debug with `%T`, `go vet`, and disassembly to confirm hash-jump compilation.

**References:** The Go Programming Language Specification — "Type switches" and "Interface types"; `go/ast`, `encoding/json`, and the `errors` package documentation; Go runtime `iface.go` (itab/itabTable).

---

*Go Engineering Handbook — topic 25.*
