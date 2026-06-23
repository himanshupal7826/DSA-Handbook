# 7 · Constants

> **In one line:** Go constants are compile-time values — typed or untyped — that the compiler folds directly into your binary, with `iota` providing a clean way to build enums.

---

## 1. Overview

A *constant* in Go is a value that is fixed and known at **compile time**. You declare one with the `const` keyword. Unlike a variable, a constant has no address, never changes, and never exists at runtime as a mutable cell of memory — the compiler substitutes the literal value wherever the constant is used.

Two ideas make Go constants unusually rich compared to C, Java, or Python:

1. **Untyped constants.** A constant can have *no type at all* until it is used in a context that needs one. `const x = 3` is an *untyped integer constant*. This gives constants the flexibility of literals — `3` can be an `int`, an `int64`, a `float64`, or a `complex128` depending on context — while still being type-safe.
2. **Arbitrary precision.** Untyped numeric constants are computed with **at least 256 bits** of precision, so `const big = 1 << 200` is perfectly legal as long as you do not assign it to a type too small to hold it.

The companion to `const` is `iota` — a compiler-managed counter that resets to 0 in each `const` block and increments once per `ConstSpec` line. It is the idiomatic engine for building **enums** in a language that has no `enum` keyword.

> [!NOTE]
> Constants are not "read-only variables." A read-only variable still occupies memory and is read at runtime. A constant is erased — it becomes part of the instruction stream or a literal operand.

---

## 2. Why It Exists

Constants solve three distinct problems:

- **Compile-time guarantees.** If a value can never legally change, the compiler should enforce that and the runtime should never pay to store or re-read it. `const MaxRetries = 5` cannot be reassigned, shadowed by accident in a way that mutates it, or `&`-referenced.
- **Literal flexibility without `#define` hazards.** C's `#define PI 3.14159` is a textual macro with no type checking and notorious precedence bugs. Go's untyped constants give you the *adaptability* of a macro (one declaration usable as `float32` or `float64`) but with full type checking and scoping.
- **Enumerations.** Go deliberately omits a dedicated `enum` type. Instead, `const` + `iota` + a named type gives you enums that are just integers — fast, comparable, switchable, and printable (with a little help from `stringer`).

The arbitrary-precision rule exists so that intermediate constant arithmetic never silently overflows. `const KB = 1 << 10; const GB = KB * KB * 1024` is computed exactly; truncation only happens (and is checked) at the moment of assignment to a sized type.

---

## 3. Internal Working

The crucial thing to internalize: **constants live entirely inside the compiler.** There is no runtime "constant pool" the way the JVM has. By the time you have a binary, most constants have vanished into immediate operands or into precomputed data.

### Untyped constant representation in the compiler

While compiling, the Go compiler (`cmd/compile`) represents an untyped constant with a `constant.Value` (from `go/constant`), backed by a `math/big` value for integers and rationals. This is the "at least 256 bits" precision in practice — it's arbitrary precision via `big.Int` / `big.Rat`.

```text
 SOURCE                COMPILER (constant.Value)            BINARY
 ------                -------------------------            ------
 const x = 1<<40   ->  big.Int{ 1099511627776 }        ->  (folded; only the
 const y = x + 7   ->  big.Int{ 1099511627783 }            used value emitted)
 var z int64 = y   ->  check fits in int64 -> OK        ->  MOVQ $..., z
                       assign default/typed value

 const f = 0.1     ->  big.Rat{ 1/10 } (exact)
 var d float64 = f ->  rounded to nearest float64       ->  IEEE-754 bits in
                       at the assignment point              .rodata / immediate
```

### Default types and "kind"

An untyped constant has a **default type** used when context does not force one:

| Constant kind | Default type |
|---|---|
| integer | `int` |
| floating | `float64` |
| rune | `rune` (`int32`) |
| complex | `complex128` |
| string | `string` |
| boolean | `bool` |

So `i := 3` makes `i` an `int`; `f := 3.0` makes `f` a `float64`. The default type is applied at the point the constant is *converted to a value* — e.g., assignment, passing to a function, or use in a non-constant expression.

### Where the value ends up

Once typed and assigned, a constant is just data:

- Small integer constants become **immediate operands** in the instruction (`ADDQ $5, AX`).
- Large or floating constants go into the **read-only data section** (`.rodata`) and are loaded.
- A `const` string places its bytes in `.rodata`; multiple identical string constants are typically **deduplicated** by the linker.

### `iota`

`iota` is *not* a runtime counter. It is a compiler symbol whose value equals the **index of the current `ConstSpec` (line) within the `const` block**, starting at 0. It increments per line, not per identifier, and resets to 0 at each new `const (` block.

```text
const (              iota
    A = iota   //     0   -> A = 0
    B          //     1   -> B = 1 (expression "iota" repeated implicitly)
    C          //     2   -> C = 2
    _          //     3   (skipped)
    E          //     4   -> E = 4
)
```

When you omit the expression on a line, Go **repeats the previous line's expression**, with `iota` now larger. That single rule explains nearly every clever `iota` trick.

---

## 4. Syntax

```go
// Single constant
const Pi = 3.14159

// Typed constant (forces the type now)
const MaxConns int = 100

// Grouped block
const (
	StatusOK       = 200
	StatusNotFound = 404
)

// Untyped vs typed
const untypedK = 1024        // untyped int constant
const typedK   int32 = 1024  // typed: only assignable where int32 fits

// iota enum with a named type
type Weekday int

const (
	Sunday Weekday = iota // 0
	Monday                // 1
	Tuesday               // 2
	Wednesday             // 3
)

// iota with expressions (byte-size units)
const (
	_  = iota             // skip 0
	KB = 1 << (10 * iota) // 1 << 10
	MB                    // 1 << 20
	GB                    // 1 << 30
)
```

> [!TIP]
> Inside a `const` block, a line with **no `= expression`** inherits the previous line's expression. That is the mechanism behind `iota` shift patterns — you write the formula once.

---

## 5. Common Interview Questions

**Q1. What is the difference between a typed and an untyped constant?**
*Answer:* An untyped constant (e.g. `const x = 5`) has no fixed type and adapts to its usage context, carrying its default type only when forced (e.g. `int` here). A typed constant (`const x int32 = 5`) is locked to that type and can only be used where that exact type is allowed without conversion.
*Follow-up: Why does `const x = 5; var y float64 = x` compile but `const x int = 5; var y float64 = x` not?* Because untyped `5` converts to `float64` freely; the typed `int` version requires an explicit `float64(x)` conversion — Go has no implicit numeric conversion.

**Q2. What value does `iota` start at and when does it increment?**
*Answer:* It is 0 at the first `ConstSpec` line of a `const` block and increments by one per line (not per identifier), resetting to 0 in each new block.
*Follow-up: What does `const ( a, b = iota, iota; c, d )` produce?* `a=0, b=0, c=1, d=1` — `iota` is constant within a line; multiple names on one line share it.

**Q3. Can a constant be a slice, map, or struct?**
*Answer:* No. Constants must be of a *constant kind*: boolean, rune, integer, floating-point, complex, or string. Composite types and anything requiring runtime allocation cannot be constant.
*Follow-up: How do you express a "constant" lookup table?* Use a package-level `var` (often initialized once), or a function returning literals — and document the intent; the language can't enforce immutability there.

**Q4. What precision do untyped numeric constants use?**
*Answer:* At least 256 bits; in practice the gc compiler uses arbitrary precision (`math/big`). Overflow/truncation is only checked at conversion to a sized type.
*Follow-up: Does `const c = 1 << 100` compile?* Yes, as an untyped constant. It only errors if you assign it to a type too small to hold it.

**Q5. Why use `iota` instead of hardcoding 0, 1, 2?**
*Answer:* It keeps enum values consecutive and self-maintaining — inserting a member renumbers automatically, reduces copy-paste errors, and pairs with a named type for type safety.
*Follow-up: What's a danger of `iota`-based enums for serialized data?* The numeric values are positional. Inserting/reordering members silently changes wire/DB values — pin them explicitly or never reorder.

**Q6. Is `const c = 0.1` exact?**
*Answer:* As an untyped constant it is represented exactly (rational 1/10). Rounding to IEEE-754 happens only when assigned to `float32`/`float64`.
*Follow-up: So is `const x float64 = 0.1; x == 0.1` true at runtime?* Yes, both round to the same `float64` bits; equality holds for that literal.

**Q7. Can you take the address of a constant?**
*Answer:* No. `&MaxRetries` is a compile error — constants have no addressable storage. You must copy into a variable first.

**Q8. What does the blank identifier `_` do in a `const` block with `iota`?**
*Answer:* It consumes an `iota` slot without naming a constant — commonly used to skip the 0 value so a zero-valued variable is distinguishable from a valid enum member.

---

## 6. Production Use Cases

- **Enums for status/state machines.** HTTP status codes in `net/http` (`StatusOK = 200`), connection states, order states (`Pending`, `Shipped`, `Delivered`). Kubernetes uses typed string constants extensively for phases (`PodRunning`, `PodPending`).
- **Bit flags.** `iota` with shifts builds flag sets: Go's own `os.O_RDONLY`/`O_WRONLY`/`O_CREATE`, `regexp/syntax` flags, file-mode bits in `io/fs.FileMode`.
- **Size/limit configuration.** `KB/MB/GB` constants in storage systems; gRPC's `MaxRecvMsgSize` defaults, buffer sizes in `bufio`.
- **Protocol/version tags.** Database drivers and RPC frameworks define wire-type constants. The standard library's `time` package defines duration constants (`time.Second`, `time.Hour` are typed `Duration` constants).
- **Feature/error codes.** gRPC status codes (`codes.OK`, `codes.NotFound`) are `iota`-generated typed constants; their numeric stability is contractually guaranteed across the ecosystem — a perfect example of *why* you pin enum values.
- **Build-time toggles via untyped constants.** Libraries expose `const debug = false`; the compiler dead-code-eliminates `if debug { ... }` blocks entirely, leaving zero runtime cost.

---

## 7. Common Mistakes

> [!WARNING]
> The single most damaging mistake is **reordering or inserting members into an `iota` enum that is persisted** (DB column, protobuf, JSON). The numeric values shift and old data is silently misinterpreted.

- **Assuming `iota` increments per identifier.** It increments per line. `const ( a, b = iota, iota )` gives both 0.
- **Forgetting the implicit-repeat rule.** `const ( A = iota*2; B; C )` yields `A=0, B=2, C=4` — `B` and `C` reuse `iota*2`, surprising people who expect them to be 0.
- **Overflow on assignment.** `const c = 1 << 40; var b byte = c` fails at compile time, but the message can confuse beginners who think the constant declaration itself is the problem.
- **Treating typed constants like untyped.** `const ms time.Duration = 5` then `time.Sleep(ms)` sleeps 5 *nanoseconds*, not 5 ms — the constant is already typed `Duration`, units matter.
- **Trying to make composite values constant.** `const m = map[string]int{}` does not compile.
- **Float equality surprises.** `const a = 0.1 + 0.2` is exact (`0.3`), but `var x = 0.1 + 0.2` at `float64` is `0.30000000000000004`. Mixing constant and runtime float math gives different results.

---

## 8. Performance Considerations

Constants are the cheapest "feature" in Go because they cost **nothing at runtime** when used well.

- **Constant folding.** `const area = 1920 * 1080` is computed once at compile time — no multiply instruction is emitted.
- **Dead-code elimination.** `const enableTrace = false; if enableTrace { expensive() }` removes the entire branch; `expensive()` may not even be linked in. This is the canonical zero-cost feature flag.
- **Immediate operands vs loads.** Small integer constants become instruction immediates (no memory load). Large/float constants live in `.rodata` and cost a load, but never an allocation.
- **No GC pressure, no escape.** Constants are never heap-allocated and cannot escape — there is nothing to escape.
- **String constants deduplicate.** Identical `const` strings share storage after linking, shrinking the binary.

> [!TIP]
> If you find yourself benchmarking a "magic number" hot path, make sure it is a `const`, not a `var`. A package-level `var` can defeat folding and force a memory load on every access.

There is essentially no downside performance-wise; the trade-offs are about API design and maintainability, not speed.

---

## 9. Best Practices

- **Prefer untyped constants** unless you specifically need to constrain the type. Untyped gives callers maximum flexibility.
- **Give enums a named type** (`type State int`) so the type system catches misuse, and so you get method sets (e.g. a `String()` method).
- **Generate `String()` with `stringer`.** Add `//go:generate stringer -type=State` so logs and errors are human-readable.
- **Start enums at 1 (or skip 0)** when the zero value should mean "unset/invalid," using `_ = iota`. Keep 0 as the default when "the first member is a sane default."
- **Pin persisted enum values explicitly** (`Pending State = 1`) or treat the ordering as an immutable contract — never reorder.
- **Group related constants** in one `const (...)` block for readability and shared `iota`.
- **Use `MixedCaps`, not `ALL_CAPS`.** Idiomatic Go writes `StatusOK`, not `STATUS_OK`. Export with a capital first letter.
- **Use constants for units and limits** (`time.Hour`, `KB`) rather than scattering literals.

---

## 10. Code Examples

A complete enum with type safety, a skipped zero value, a `String()` method, and bit-flag siblings — the idiomatic primary pattern:

```go
package main

import "fmt"

// OrderState is a typed enum. The named type lets the compiler reject
// passing arbitrary ints, and lets us attach a String() method.
type OrderState int

const (
	StateUnknown   OrderState = iota // 0 -> sentinel "not set"
	StatePending                     // 1
	StatePaid                        // 2
	StateShipped                     // 3
	StateDelivered                   // 4
)

func (s OrderState) String() string {
	switch s {
	case StatePending:
		return "pending"
	case StatePaid:
		return "paid"
	case StateShipped:
		return "shipped"
	case StateDelivered:
		return "delivered"
	default:
		return "unknown"
	}
}

// Bit flags: each shift is one iota slot.
type Perm uint8

const (
	PermRead  Perm = 1 << iota // 1
	PermWrite                  // 2
	PermExec                   // 4
)

func main() {
	s := StatePaid
	fmt.Printf("state=%d (%s)\n", s, s) // state=2 (paid)

	p := PermRead | PermWrite
	fmt.Printf("canWrite=%v\n", p&PermWrite != 0) // true
}
```

The same idea expressed with explicit values when the numbers are a wire/DB contract that must never drift:

```go
package main

// Pinned values: safe to reorder source lines, safe to delete a middle
// member, because the number is decoupled from position.
type Code int

const (
	CodeOK        Code = 0
	CodeNotFound  Code = 1
	CodeConflict  Code = 2
	CodeRateLimit Code = 9 // deliberately non-contiguous; gaps reserved
)
```

Untyped constants adapting to context — showing the flexibility you lose by typing too early:

```go
package main

import "fmt"

const ratio = 16.0 / 9.0 // untyped float, exact rational at compile time

func scale(f float32) float32 { return f * 2 }

func main() {
	var w64 float64 = 1920 * ratio
	var w32 float32 = scale(ratio) // untyped ratio becomes float32 here, no conversion
	fmt.Println(w64, w32)
}
```

---

## 11. Advanced Concepts

**`iota` arithmetic patterns.** Because the omitted-expression rule repeats the formula, you can build sophisticated tables:

```go
const (
	_  = iota             // ignore first value (0) by assigning to blank
	KB = 1 << (10 * iota) // 1 << 10 = 1024
	MB                    // 1 << 20
	GB                    // 1 << 30
	TB                    // 1 << 40
)
```

**Multiple constants per line.** `iota` is constant across a single `ConstSpec`, enabling paired declarations:

```go
const (
	mutexLocked, mutexWoken = 1 << iota, 1 << iota // 1, 1 — same iota
)
```

**Typed-constant method sets.** A named constant type can have methods (`String()`, `IsValid()`, `MarshalJSON()`). This is how enums get JSON-friendly textual marshalling while staying integers on the wire.

**Constant overflow as a compile-time guard.** You can intentionally use a constant expression to assert invariants at build time — a "static assert" idiom:

```go
const _ = uint8(256 - someValue) // fails to compile if someValue > 256
```

A cleaner static-assert form uses an array with a negative size when a condition is false:

```go
const cacheLine = 64
type _ [cacheLine - unsafe.Sizeof(myStruct{})]byte // compile error if struct exceeds line
```

**`go/constant` package.** Tooling (linters, code generators) inspects constant values through `go/constant` and `go/types`, the same machinery the compiler uses — useful when writing analysis tools.

> [!NOTE]
> Untyped constants are the reason `1 << 63` behaves intuitively in expressions: arithmetic happens in arbitrary precision and only the final assignment is range-checked.

---

## 12. Debugging Tips

- **"constant overflows T".** You assigned a constant to a type too small. Either widen the target type or check your shift math.
- **"cannot use x (untyped int constant) as float64 value" rarely appears** — untyped converts freely. If you *do* see a conversion error, the constant is **typed**; loosen it by dropping the explicit type.
- **"const initializer is not a constant".** You used something runtime-evaluated (a function call like `time.Now()`, a map literal). Move it to a `var`.
- **Enum prints as a number?** Add a `String()` method or run `stringer`; otherwise `%v`/`%s` shows the integer.
- **Off-by-one in `iota` enums.** Print `int(member)` to see the real value; remember `_ = iota` shifts everything.
- **Wrong duration/units.** When sleeping/timing, check whether your constant is already typed `time.Duration`. `5` and `5 * time.Second` are wildly different.
- **Inspect the binary.** `go build -gcflags=-m` won't show folded constants (they're gone) — which itself confirms folding happened. Use `go vet` and `staticcheck` to catch suspicious enum usage.

---

## 13. Senior Engineer Notes

A senior engineer treats constants as a **design tool**, not just syntax.

- **API surface decisions.** Choose untyped for maximally reusable values (`const DefaultTimeout = 30 * time.Second` is typed because units matter; `const MaxItems = 1000` stays untyped so callers slot it into `int`, `int32`, etc.). In code review, push back on prematurely typed constants that force callers into conversions.
- **Enum hygiene in reviews.** Demand a named type, a sentinel zero or documented zero meaning, an `IsValid()`/`String()` where the enum crosses a boundary (logs, JSON, DB), and a comment if values are pinned. Flag any PR that *reorders* an `iota` enum touching persistence — that is a silent data-corruption bug.
- **Mentoring framing.** Teach juniors the "constants disappear at runtime" mental model; it explains why you can't take their address, why feature flags compile away, and why float constant math differs from runtime math.
- **Guard rails.** Encourage compile-time static asserts for size/layout invariants in performance-sensitive structs rather than runtime checks that ship to production.
- **Avoid the `var`-instead-of-`const` smell** for values that never change — it loses folding and signals mutable intent.

---

## 14. Staff Engineer Notes

A staff engineer cares about constants at the level of **contracts, evolution, and cross-team blast radius**.

- **Enums as inter-service contracts.** When an enum value is serialized into Kafka, protobuf, or a shared DB, its numbers become a **wire contract** spanning many teams and deploy cycles. Standardize on *explicitly pinned* values org-wide, reserve gaps, and forbid renumbering — exactly the discipline gRPC `codes` and protobuf enums enforce. This prevents the classic incident where Team A inserts an enum member and Team B's consumers misread historical events.
- **Build-vs-buy / generate-vs-handwrite.** For large enum sets, mandate code generation (`stringer`, protobuf-generated Go, or `enumer`) over hand-maintained `String()` switches — handwritten ones drift. Decide org tooling so every service prints enums consistently in logs and traces.
- **Cross-language alignment.** Go `iota` enums must agree with the same enum defined in TypeScript, Java, or SQL. Single-source-of-truth (proto/IDL) generation beats parallel hand-maintained tables; make this a platform decision, not a per-team one.
- **Migration strategy.** Define the org policy for evolving persisted enums: append-only members, never reuse retired numbers, ship a deprecation window. This is governance, not code.
- **Cost framing.** Constants are free at runtime, so the staff-level trade-off is **maintainability and compatibility**, not performance. The architecture question is "how do these fixed values flow across system and language boundaries safely," not "are they fast."

---

## 15. Revision Summary

- **Constant = compile-time, immutable, addressless** value declared with `const`; erased into immediates or `.rodata` at build time.
- **Untyped constants** adapt to context, carry a **default type** (`int`, `float64`, `rune`, `complex128`, `string`, `bool`) only when forced, and use **≥256-bit / arbitrary precision** until assigned.
- **Typed constants** are locked to a type; Go never converts numeric types implicitly.
- **`iota`** = 0 at each `const` block start, increments **per line**, repeats the previous line's expression when omitted; the engine for **enums** and **bit flags** (`1 << iota`).
- Only constant kinds allowed: bool, rune, int, float, complex, string — **no slices/maps/structs**.
- Performance: **constant folding**, **dead-code elimination** (zero-cost feature flags), no allocation, no GC.
- Biggest hazard: **reordering persisted `iota` enums** corrupts data — pin values that cross a wire/DB boundary.
- Best practice: named enum type + `String()` (via `stringer`) + sentinel zero + explicit values for contracts.

**References:** The Go Blog — "Constants" (go.dev/blog/constants); The Go Programming Language Specification — Constants & `iota`; `go/constant`, `go/types`, and `golang.org/x/tools/cmd/stringer`.

---

*Go Engineering Handbook — topic 7.*
